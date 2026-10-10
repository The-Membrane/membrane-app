import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  buildIssue,
  issueFreshCheckpoints,
  issueLatest,
  scoreIssue,
  verifyIssues,
} from './curve-prospective-forecast.mjs'

const start = 1_790_000_000
const hash = (value) => createHash('sha256').update(String(value)).digest('hex')
const reseal = ({ sha256: _old, ...payload }) => ({
  ...payload,
  sha256: hash(JSON.stringify(payload)),
})
const historical = Array.from({ length: 120 }, (_, i) => ({
  at: start + i * 3600,
  block: 1000 + i,
  quote: 0.999 + (i % 9) * 0.00001,
}))
function captured(i, at = historical.at(-1).at + (i + 1) * 3600, quote = 0.9995) {
  const filename = `${String(2000 + i).padStart(12, '0')}-${hash(i)}.json`
  return {
    filename,
    physicalSha256: hash(`physical-${i}`),
    checkpoint: {
      study: 'curve-crvusd-secondary-prospective-quote-v1',
      sha256: hash(`checkpoint-${i}`),
      source: { identitySha256: hash('identity') },
      block: { number: 2000 + i, hash: `0x${hash(i)}`, timestamp: at },
      captureEndUtc: new Date((at + 30) * 1000).toISOString(),
      routes: { 1000000: { bestQuote: quote } },
    },
  }
}
const issuedAtUtc = new Date((historical.at(-1).at + 3600 + 30) * 1000).toISOString()

test('issue freezes the as-of forecast despite later checkpoints', () => {
  const first = captured(0)
  const later = captured(1, first.checkpoint.block.timestamp + 24 * 3600, 0.97)
  const original = buildIssue({
    history: historical,
    checkpoints: [first],
    horizonHours: 24,
    issuedAtUtc,
  })
  const repeated = buildIssue({
    history: historical,
    checkpoints: [first],
    horizonHours: 24,
    issuedAtUtc,
  })
  assert.deepEqual(original, repeated)
  assert.notEqual(
    buildIssue({
      history: historical,
      checkpoints: [first, later],
      horizonHours: 24,
      issuedAtUtc: new Date((later.checkpoint.block.timestamp + 30) * 1000).toISOString(),
    }).block.number,
    original.block.number,
  )
  assert.equal(original.source.checkpointPhysicalSha256, first.physicalSha256)
})

test('missing trailing 24h continuity records unavailable', () => {
  const far = captured(0, historical.at(-1).at + 48 * 3600)
  const result = buildIssue({
    history: historical,
    checkpoints: [far],
    horizonHours: 24,
    issuedAtUtc: new Date((far.checkpoint.block.timestamp + 30) * 1000).toISOString(),
  })
  assert.equal(result.status, 'unavailable')
  assert.equal(result.reason, 'incomplete_24h_history')
  assert.equal(result.projectedQuote, null)
})

test('issued artifacts cannot be overwritten and tampering fails verification', () => {
  const out = mkdtempSync(join(tmpdir(), 'prospective-forecast-'))
  const checkpoints = [captured(0)]
  const now = () => new Date(issuedAtUtc)
  const paths = issueLatest({ history: historical, checkpoints, out, now })
  assert.equal(paths.length, 2)
  const repeated = issueLatest({ history: historical, checkpoints, out, now })
  assert.ok(repeated.every((entry) => entry.existing))
  assert.deepEqual(
    repeated.map((entry) => entry.path),
    paths.map((entry) => entry.path),
  )
  const path = paths[0].path
  const saved = JSON.parse(readFileSync(path, 'utf8'))
  saved.currentQuote = 0.5
  writeFileSync(path, JSON.stringify(saved))
  assert.throws(() => verifyIssues({ history: historical, checkpoints, out }), /SHA mismatch/)
})

test('new issue binds both logical and physical checkpoint seals', () => {
  const out = mkdtempSync(join(tmpdir(), 'prospective-seals-'))
  const checkpoints = [captured(0)]
  const path = issueLatest({
    history: historical,
    checkpoints,
    out,
    now: () => new Date(issuedAtUtc),
  })[0].path
  const original = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(original.source.checkpointSha256, checkpoints[0].checkpoint.sha256)
  const write = (source) =>
    writeFileSync(path, JSON.stringify(reseal({ ...original, source })) + '\n')
  write({ ...original.source, checkpointSha256: hash('wrong-logical') })
  assert.throws(
    () => verifyIssues({ history: historical, checkpoints, out }),
    /provenance mismatch/,
  )
  write({ ...original.source, checkpointPhysicalSha256: hash('wrong-physical') })
  assert.throws(
    () => verifyIssues({ history: historical, checkpoints, out }),
    /provenance mismatch/,
  )
  const { checkpointSha256: _missing, ...legacyShape } = original.source
  write(legacyShape)
  assert.throws(
    () => verifyIssues({ history: historical, checkpoints, out }),
    /Unrecognized legacy issue physical seal/,
  )
})

test('partial issue pair recovers only during original freshness window', () => {
  const out = mkdtempSync(join(tmpdir(), 'prospective-partial-'))
  const checkpoints = [captured(0)]
  const paths = issueLatest({
    history: historical,
    checkpoints,
    out,
    now: () => new Date(issuedAtUtc),
  })
  const first = readFileSync(paths[0].path, 'utf8')
  unlinkSync(paths[1].path)
  const recovered = issueLatest({
    history: historical,
    checkpoints,
    out,
    now: () => new Date(issuedAtUtc),
  })
  assert.equal(recovered[0].existing, true)
  assert.equal(recovered[1].existing, undefined)
  assert.equal(readFileSync(paths[0].path, 'utf8'), first)
  unlinkSync(paths[1].path)
  const late = new Date((checkpoints[0].checkpoint.block.timestamp + 3 * 3600) * 1000)
  assert.throws(
    () => issueLatest({ history: historical, checkpoints, out, now: () => late }),
    /cannot be recovered/,
  )
})

test('sweep issues two fresh waiting checkpoints chronologically without future leakage', () => {
  const out = mkdtempSync(join(tmpdir(), 'prospective-sweep-'))
  const first = captured(0)
  const second = captured(1, first.checkpoint.block.timestamp + 3600, 0.8)
  const checkpoints = [first, second]
  const now = new Date((second.checkpoint.block.timestamp + 30) * 1000)
  const issued = issueFreshCheckpoints({ history: historical, checkpoints, out, now: () => now })
  assert.deepEqual(
    issued.map((entry) => entry.status),
    ['issued', 'issued'],
  )
  assert.equal(verifyIssues({ history: historical, checkpoints, out }).issues, 4)
  const firstReceipt = JSON.parse(readFileSync(issued[0].issues[0].path, 'utf8'))
  const expected = buildIssue({
    history: historical,
    checkpoints: [first],
    horizonHours: 24,
    issuedAtUtc: now.toISOString(),
  })
  assert.deepEqual(firstReceipt, expected)
  assert.equal(firstReceipt.currentQuote, first.checkpoint.routes[1000000].bestQuote)
  const repeated = issueFreshCheckpoints({ history: historical, checkpoints, out, now: () => now })
  assert.deepEqual(
    repeated.map((entry) => entry.status),
    ['existing', 'existing'],
  )
})

test('stale missing partial is reported while a newer checkpoint still issues', () => {
  const out = mkdtempSync(join(tmpdir(), 'prospective-stale-'))
  const first = captured(0)
  const second = captured(1, first.checkpoint.block.timestamp + 5 * 3600)
  const initial = issueLatest({
    history: historical,
    checkpoints: [first],
    out,
    now: () => new Date(issuedAtUtc),
  })
  unlinkSync(initial[1].path)
  const now = new Date((second.checkpoint.block.timestamp + 30) * 1000)
  const swept = issueFreshCheckpoints({
    history: historical,
    checkpoints: [first, second],
    out,
    now: () => now,
  })
  assert.equal(swept[0].status, 'stale_missing')
  assert.deepEqual(swept[0].missingHorizons, [168])
  assert.equal(swept[1].status, 'issued')
  assert.equal(verifyIssues({ history: historical, checkpoints: [first, second], out }).issues, 3)
})

test('zero checkpoint quote issues unavailable and scores a later zero outcome', () => {
  const anchor = captured(0, historical.at(-1).at + 48 * 3600, 0)
  const issue = buildIssue({
    history: historical,
    checkpoints: [anchor],
    horizonHours: 24,
    issuedAtUtc: new Date((anchor.checkpoint.block.timestamp + 30) * 1000).toISOString(),
  })
  assert.equal(issue.currentQuote, 0)
  assert.equal(issue.status, 'unavailable')
  assert.equal(issue.reason, 'zero_quote')
  // Add observations at <=4h cadence so the endpoint is genuinely observed.
  const path = Array.from({ length: 6 }, (_, i) =>
    captured(i + 1, anchor.checkpoint.block.timestamp + (i + 1) * 4 * 3600, 0),
  )
  path.push(captured(7, anchor.checkpoint.block.timestamp + 26 * 3600, 0))
  const score = scoreIssue(issue, [anchor, ...path])
  assert.equal(score.status, 'observed')
  assert.equal(score.actualQuote, 0)
  assert.equal(score.forecastError, null)
})

test('late issuance is rejected before any forecast artifact is written', () => {
  const anchor = captured(0)
  assert.throws(
    () =>
      buildIssue({
        history: historical,
        checkpoints: [anchor],
        horizonHours: 24,
        issuedAtUtc: new Date((anchor.checkpoint.block.timestamp + 3 * 3600) * 1000).toISOString(),
      }),
    /issuance window/,
  )
  const out = mkdtempSync(join(tmpdir(), 'prospective-late-'))
  assert.throws(
    () =>
      issueLatest({
        history: historical,
        checkpoints: [anchor],
        out,
        now: () => new Date((anchor.checkpoint.block.timestamp + 3 * 3600) * 1000),
      }),
    /issuance window/,
  )
})

test('score waits for full endpoint window and censors coverage gaps', () => {
  const anchor = captured(0)
  const issue = buildIssue({
    history: historical,
    checkpoints: [anchor],
    horizonHours: 24,
    issuedAtUtc,
  })
  assert.equal(scoreIssue(issue, [anchor]), null)
  const endpoint = captured(1, anchor.checkpoint.block.timestamp + 24 * 3600, 0.98)
  const windowEnd = captured(2, anchor.checkpoint.block.timestamp + 26 * 3600, 0.98)
  assert.equal(scoreIssue(issue, [anchor, endpoint, windowEnd]).status, 'censored_gap')
  assert.equal(scoreIssue(issue, [anchor, endpoint, windowEnd]).actualQuote, null)
})
