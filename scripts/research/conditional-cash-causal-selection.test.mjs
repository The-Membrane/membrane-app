import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  candidateForecasts,
  chooseCandidate,
  scoreCausalHistory,
  buildCausalReport,
} from './conditional-cash-causal-selection.mjs'
import { MAX_UINT, loadPinnedAudit, writeReport } from './conditional-cash-time-holdout.mjs'
const at = (n) => new Date(Date.parse('2026-06-01T00:00:00.000Z') + n * 86400000).toISOString()
function history(cash, indices = cash.map((_, i) => i)) {
  return {
    identity: {
      routeKey: 'fixture',
      destination: '0x' + 'a'.repeat(40),
      asset: '0x' + 'b'.repeat(40),
      assetDecimals: 6,
    },
    witness: { availableAt: '2026-10-05T10:57:37.472Z' },
    points: cash.map((c, i) => [
      indices[i],
      String(100 + indices[i]),
      '0x' + String(indices[i]).padStart(64, '0'),
      at(indices[i]),
      String(c),
    ]),
  }
}
const choice = (r, anchor) => r.choices.find((c) => c[0] === anchor)
test('trend expands only after seven strictly earlier completed targets; equality is excluded', () => {
  const r = scoreCausalHistory(history(Array.from({ length: 18 }, (_, i) => 100 + 10 * i)), 24)
  assert.equal(choice(r, 9)[2], 0)
  assert.equal(choice(r, 9)[3], 6)
  assert.equal(choice(r, 10)[2], 1)
  assert.equal(choice(r, 10)[3], 7)
  assert.equal(choice(r, 10)[4], at(9))
  assert.ok(r.choices.every((c) => c[4] === null || Date.parse(c[4]) < Date.parse(at(c[0]))))
  assert.ok(
    BigInt(r.selected.absoluteErrorSumRaw) < BigInt(r.fixedCandidates[0].absoluteErrorSumRaw),
  )
})
test('withheld current/future target values cannot select the current candidate', () => {
  const h = history(Array.from({ length: 20 }, (_, i) => 100 + 10 * i)),
    base = scoreCausalHistory(h, 24)
  h.points[11][4] = '99999999'
  h.points[12][4] = '1'
  h.points[19][4] = '0'
  const changed = scoreCausalHistory(h, 24)
  assert.deepEqual(
    base.choices.filter((c) => c[0] <= 11),
    changed.choices.filter((c) => c[0] <= 11),
  )
  assert.deepEqual(
    candidateForecasts(h, 10, 24),
    candidateForecasts(history(Array.from({ length: 20 }, (_, i) => 100 + 10 * i)), 10, 24),
  )
})
test('regime-switch future outcomes are not whole-data ranking or leaked training', () => {
  const h = history(Array.from({ length: 30 }, (_, i) => (i < 15 ? 100 + 10 * i : 240))),
    base = scoreCausalHistory(h, 24)
  const future = structuredClone(h)
  for (let i = 15; i < 30; i++) future.points[i][4] = String(1000000 + i * 10000)
  const changed = scoreCausalHistory(future, 24)
  assert.deepEqual(
    base.choices.filter((c) => c[0] <= 15),
    changed.choices.filter((c) => c[0] <= 15),
  )
  assert.equal(choice(base, 14)[2], 1)
})
test('deterministic MAE ties prefer persistence then smallest older window', () => {
  const states = [0, 0, 0, 0, 0, 0, 0].map(() => ({ scored: 7, censored: 0, absolute: 7n }))
  assert.equal(chooseCandidate(states, 7), 0)
  states[0].absolute = 14n
  assert.equal(chooseCandidate(states, 7), 1)
  states[1].censored = 1
  assert.equal(chooseCandidate(states, 7), 2)
  assert.equal(chooseCandidate(states, 6), 0)
})
test('missing exact labels and gaps stay visible, including chosen candidate censor after good training', () => {
  const indices = [...Array.from({ length: 11 }, (_, i) => i), 12, 13, 14, 15, 16],
    h = history(
      indices.map((i) => 100 + 10 * i),
      indices,
    ),
    r = scoreCausalHistory(h, 24)
  assert.ok(r.missingExactLabels > 1)
  assert.ok(r.selected.censoredFolds > 0)
  assert.ok(r.fixedCandidates.some((c) => c.censorReasons.donor_gap > 0))
  assert.equal(r.selected.scoredFolds + r.selected.censoredFolds, r.exactLabels)
  for (const t of r.thresholdDiagnostics)
    assert.equal(t.scoredFolds + t.censoredFolds, t.labelledFolds)
})
test('native millisecond overflow is not divided/clamped away or hidden by window truncation', () => {
  const h = history([0, MAX_UINT, MAX_UINT, MAX_UINT]),
    fs = candidateForecasts(h, 2, 168)
  assert.equal(fs[0].status, 'estimated')
  assert.ok(
    fs
      .slice(1)
      .every((f) => f.status === 'censored' && f.censorReasons.native_intermediate_overflow === 1),
  )
  const r = scoreCausalHistory(h, 24)
  assert.equal(r.fixedCandidates[1].censoredFolds, 1)
  assert.equal(r.selected.scoredFolds, 1)
})
test('stable/zero histories choose persistence; zero Q is separate and not false covered', () => {
  const r = scoreCausalHistory(history(Array(20).fill(0)), 24)
  assert.ok(r.choices.every((c) => c[2] === 0))
  assert.equal(r.selected.absoluteErrorSumRaw, '0')
  assert.ok(
    r.thresholdDiagnostics.every(
      (t) => t.zeroQFolds === r.exactLabels && t.falseCoverage === 0 && t.positiveQFolds === 0,
    ),
  )
})
test('H1 unsupported; exact H48/H168 validation timestamps retain actual source horizons', () => {
  const h = history(Array.from({ length: 24 }, (_, i) => i + 1))
  assert.equal(scoreCausalHistory(h, 1).exactLabels, 0)
  for (const H of [48, 168]) {
    const r = scoreCausalHistory(h, H)
    assert.ok(
      r.choices.every(
        (c) => c[1] - c[0] === H / 24 && (c[4] === null || Date.parse(c[4]) < Date.parse(at(c[0]))),
      ),
    )
  }
})
test('actual pinned report has all21/63+supp, genuine availability, deterministic bytes, development-only/wx bounds', () => {
  const audit = loadPinnedAudit(),
    clock = '2026-10-07T17:00:00.000Z'
  assert.throws(() => buildCausalReport(audit, '2026-10-04T00:00:00.000Z'), /knowledge/)
  assert.throws(() => buildCausalReport(structuredClone(audit), clock), /unapproved/)
  const a = buildCausalReport(audit, clock),
    b = buildCausalReport(audit, clock)
  assert.equal(JSON.stringify(a), JSON.stringify(b))
  assert.equal(a.untouchedHoldout, false)
  assert.equal(a.totals.core.groups, 21)
  assert.equal(a.totals.core.destinations, 63)
  assert.deepEqual(
    [24, 48, 168].map((H) => a.totals.core.horizons[H].exactLabels),
    [7360, 7297, 6982],
  )
  assert.deepEqual(
    [24, 48, 168].map((H) => a.totals.supplemental.horizons[H].exactLabels),
    [117, 116, 111],
  )
  assert.ok(
    a.destinations.every(
      (d) =>
        d.witness.availableAt.startsWith('2026-10-05') &&
        d.horizons.every((h) => h.worstFalseCoverage.length <= 3),
    ),
  )
  const dir = mkdtempSync(join(tmpdir(), 'cash-causal-selection-')),
    out = join(dir, 'report.json'),
    bytes = Buffer.byteLength(JSON.stringify(a) + '\n')
  try {
    assert.ok(bytes < 2 * 1024 * 1024)
    assert.throws(() => writeReport(a, out, 1024 ** 3 + bytes - 1), /reserve/)
    writeReport(a, out, 1024 ** 3 + bytes)
    assert.throws(() => writeReport(a, out, 1024 ** 3 + bytes), /EEXIST/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
