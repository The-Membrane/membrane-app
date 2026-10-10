import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  authenticateArtifacts,
  loadPinnedAudit,
  buildReport,
  scoreHistory,
  scoreFold,
  floorSigned,
  translateCash,
  MAX_UINT,
  writeReport,
} from './conditional-cash-time-holdout.mjs'
const at = (n) => new Date(Date.parse('2026-09-01T00:00:00.000Z') + n * 86400000).toISOString()
const history = (cash, indices = cash.map((_, i) => i)) => ({
  identity: {
    routeKey: 'fixture',
    destination: '0x' + 'a'.repeat(40),
    asset: '0x' + 'b'.repeat(40),
    assetDecimals: 6,
  },
  witness: {
    manifestSha256: 'fixture',
    lastDailyReceiptSha256: 'fixture',
    availableAt: '2026-10-05T10:57:37.472Z',
  },
  points: cash.map((c, i) => [
    indices[i],
    String(100 + indices[i]),
    '0x' + String(indices[i]).padStart(64, '0'),
    at(indices[i]),
    String(c),
  ]),
})
test('strictly prior donors exclude endpoint equal to origin and future outcome', () => {
  const h = history([100, 110, 120, 999999]),
    f = scoreFold(h, 2, 3)
  assert.equal(f.donorCandidates, 1)
  assert.equal(f.latestDonorEndAt, at(1))
  assert.equal(f.distribution.p50Raw, '130')
  h.points[2][4] = '120'
  h.points[3][4] = '1'
  assert.equal(scoreFold(h, 2, 3).distribution.p50Raw, '130')
})
test('signed floor precedes zero floor, without floating point or wrong negative truncation', () => {
  assert.equal(floorSigned(-5n, 2n), -3n)
  assert.equal(floorSigned(5n, 2n), 2n)
  assert.deepEqual(translateCash('2', -5n, 1, 2), { status: 'estimated', cashRaw: '0' })
  assert.deepEqual(translateCash('10', -5n, 1, 2), { status: 'estimated', cashRaw: '7' })
  assert.throws(() => floorSigned(1n, 0n))
})
test('overflow donor stays censored and prevents a selectively narrowed band', () => {
  const h = history([0, MAX_UINT, MAX_UINT, MAX_UINT]),
    f = scoreFold(h, 2, 3)
  assert.equal(f.status, 'censored')
  assert.equal(f.donorCandidates, 1)
  assert.equal(f.donorCensored, 1)
  assert.equal(f.censorReasons.native_intermediate_overflow, 1)
  assert.equal(f.distribution, null)
  const r = scoreHistory(h, 24)
  assert.equal(r.exactLabels, 1)
  assert.equal(r.censoredFolds, 1)
  assert.equal(r.scoredFolds, 0)
  assert.equal(r.donorCensored, 1)
  assert.equal(r.censorReasons.native_intermediate_overflow, 1)
  assert.equal(r.censoredExamples.length, 1)
  assert.equal(r.meanMedianAbsoluteError, null)
})
test('live-kernel signed millisecond product overflow censors before division or zero clamp', () => {
  for (const [origin, delta, target, donor] of [
    ['0', -MAX_UINT, 604800, 86400],
    ['0', MAX_UINT, 2, 2],
    ['0', MAX_UINT / 1000n + 1n, 1, 1],
    ['0', -(MAX_UINT / 1000n + 1n), 1, 1],
  ])
    assert.deepEqual(translateCash(origin, delta, target, donor), {
      status: 'censored',
      reason: 'native_intermediate_overflow',
    })
  const safe = MAX_UINT / 1000n
  assert.deepEqual(translateCash('0', safe, 1, 1), {
    status: 'estimated',
    cashRaw: safe.toString(),
  })
  assert.deepEqual(translateCash('0', -safe, 1, 1), { status: 'estimated', cashRaw: '0' })
  assert.equal(translateCash('0', 1n, Number.MAX_SAFE_INTEGER, 1).reason, 'invalid_native_input')
  for (const bad of ['1', [1], null])
    assert.equal(translateCash('0', 1n, bad, 1).reason, 'invalid_native_input')
})
test('interior unknown anchor is not compressed into a valid donor interval', () => {
  const h = history([100, 100, 100, 100], [0, 2, 3, 4]),
    f = scoreFold(h, 2, 3)
  assert.equal(f.status, 'censored')
  assert.equal(f.censorReasons.donor_gap, 1)
  assert.equal(scoreHistory(h, 24).censoredFolds, 1)
})
test('exact labels only, no H1 or near-target tolerance/interpolation', () => {
  const h = history([100, 110, 120, 130, 140])
  assert.equal(scoreHistory(h, 1).exactLabels, 0)
  assert.equal(scoreHistory(h, 1).meanMedianAbsoluteError, null)
  assert.equal(scoreHistory(h, 24).exactLabels, 2)
  h.points[3][3] = new Date(Date.parse(at(3)) + 1000).toISOString()
  assert.equal(scoreHistory(h, 24).exactLabels, 0)
})
test('zero and positive fraction-floored Q diagnostics use native raw units', () => {
  const f = scoreFold(history([101, 101, 101, 40]), 2, 3)
  assert.deepEqual(
    f.thresholds.map((t) => t.requestedRaw),
    ['10', '50', '90'],
  )
  assert.deepEqual(
    f.thresholds.map((t) => t.actualCashCoversQ),
    [true, false, false],
  )
  assert.equal(f.signedMedianErrorRaw, '61')
  assert.equal(f.absoluteMedianErrorRaw, '61')
  const z = scoreHistory(history([0, 0, 0, 0]), 24)
  assert.ok(z.thresholdDiagnostics.every((t) => t.zeroQFolds === 1 && t.positiveQFolds === 0))
})
test('malformed native values, units, ordering and future availability reject', () => {
  for (const modify of [
    (h) => (h.identity.assetDecimals = '6'),
    (h) => (h.points[1][4] = '-1'),
    (h) => (h.points[1][4] = (MAX_UINT + 1n).toString()),
    (h) => (h.points[1][1] = h.points[0][1]),
    (h) => (h.witness.availableAt = at(0)),
  ]) {
    const h = history([1, 2, 3, 4])
    modify(h)
    assert.throws(() => scoreHistory(h, 24))
  }
})
test('actual externally pinned audit rejects tampered bytes and mutable approval aliases', () => {
  const a = readFileSync(
      'data/research/venue-signals/conditional-sampled-cash-history-v1.audit.json',
      'utf8',
    ),
    p = readFileSync(
      'data/research/venue-signals/conditional-sampled-cash-history-v1.pins.json',
      'utf8',
    )
  assert.throws(() => authenticateArtifacts(a.replace('25254619', '25254620'), p), /pin_mismatch/)
  assert.throws(() => authenticateArtifacts(a, p + ' '), /pin_mismatch/)
  const approved = authenticateArtifacts(a, p)
  assert.ok(
    Object.isFrozen(approved) && Object.isFrozen(Object.values(approved.histories)[0].points[0]),
  )
  assert.throws(
    () => buildReport(structuredClone(approved), '2026-10-07T16:00:00.000Z'),
    /unapproved/,
  )
  assert.throws(() => buildReport(approved, '2026-10-04T00:00:00.000Z'), /knowledge/)
})
test('actual 64-native roster includes 109 observations and all exact horizon labels', () => {
  const audit = loadPinnedAudit(),
    counts = { core: {}, supplemental: {} }
  assert.equal(Object.keys(audit.histories).length, 64)
  assert.equal(Object.values(audit.histories).filter((h) => h.points.length === 109).length, 1)
  for (const h of Object.values(audit.histories)) {
    const lane =
      h.identity.routeKey === 'USDe → Aave V3 [USDe]'
        ? 'supplemental'
        : h.witness.manifestSha256 === audit.profile.lanes[1].manifestSha256
          ? 'supplemental'
          : 'core'
    for (const H of [1, 24, 48, 168])
      counts[lane][H] = (counts[lane][H] ?? 0) + scoreHistory(h, H).exactLabels
  }
  assert.deepEqual(counts, {
    core: { 1: 0, 24: 7360, 48: 7297, 168: 6982 },
    supplemental: { 1: 0, 24: 117, 48: 116, 168: 111 },
  })
})
test('report deterministic per destination errors, genuine cutoffs and bounded worst cases; wx only', () => {
  const audit = loadPinnedAudit(),
    time = '2026-10-07T16:00:00.000Z',
    a = buildReport(audit, time),
    b = buildReport(audit, time)
  assert.equal(JSON.stringify(a), JSON.stringify(b))
  assert.equal(a.historicalIssueClockUnestablished, true)
  assert.equal(a.totals.core.groups, 21)
  assert.equal(a.totals.core.destinations, 63)
  assert.ok(
    a.destinations.every(
      (d) =>
        d.witness.availableAt.startsWith('2026-10-05') &&
        d.horizons.every((h) => h.worstFolds.length <= 3),
    ),
  )
  const dir = mkdtempSync(join(tmpdir(), 'cash-time-holdout-')),
    out = join(dir, 'report.json')
  try {
    const bytes = Buffer.byteLength(JSON.stringify(a) + '\n')
    assert.throws(() => writeReport(a, out, 1024 ** 3 + bytes - 1), /reserve/)
    assert.equal(existsSync(out), false)
    const saved = writeReport(a, out, 1024 ** 3 + bytes)
    assert.ok(saved.bytes < 2 * 1024 * 1024)
    assert.throws(() => writeReport(a, out, 1024 ** 3 + bytes), /EEXIST/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
