import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  buildIssue,
  issueLatest,
  scoreIssue,
  scoreMatured,
  verifyIssues,
} from './curve-prospective-level-forecast.mjs'

const HOUR = 3600
const start = 1_790_000_000
const digest = (value) => createHash('sha256').update(String(value)).digest('hex')
const history = Array.from({ length: 500 }, (_, i) => ({
  at: start + i * HOUR,
  block: 1000 + i,
  quote: 0.999 + (i % 17) * 0.00001,
}))
const end = history.at(-1).at
function checkpoint(i, at = end + (i + 1) * HOUR, quote = 0.9995) {
  const hash = `0x${digest(`block-${i}`)}`
  return {
    filename: `${String(2000 + i).padStart(12, '0')}-${hash.slice(2)}.json`,
    physicalSha256: digest(`physical-${i}`),
    checkpoint: {
      sha256: digest(`logical-${i}`),
      source: { identitySha256: digest('source') },
      block: { number: 2000 + i, hash, timestamp: at },
      captureEndUtc: new Date((at + 30) * 1000).toISOString(),
      routes: { 1000000: { bestQuote: quote } },
    },
  }
}
const first = checkpoint(0)
const at = (seconds) => new Date(seconds * 1000).toISOString()
const issueTime = at(first.checkpoint.block.timestamp + 60)
const reseal = ({ sha256: _old, ...value }) => ({ ...value, sha256: digest(JSON.stringify(value)) })

test('level-only 24h and 168h issues forecast without a live 24h lookback', () => {
  const issues = [24, 168].map((horizonHours) =>
    buildIssue({ history, checkpoints: [first], horizonHours, issuedAtUtc: issueTime }),
  )
  for (const issue of issues) {
    assert.equal(issue.status, 'research_forecast')
    assert.equal(issue.method.feature, 'current_quote_level_only')
    assert.equal(issue.selectedAnalogs, 40)
    assert.equal(issue.persistenceQuote, issue.currentQuote)
    assert.ok(issue.projectedQuote > 0)
    assert.equal(issue.empiricalAnalogInterval.length, 2)
  }
})

test('only outcomes observed by issue time may enter the fixed historical analog pool', () => {
  const issue = buildIssue({
    history,
    checkpoints: [first],
    horizonHours: 24,
    issuedAtUtc: issueTime,
  })
  const suffix = Array.from({ length: 28 }, (_, i) =>
    checkpoint(i + 1, first.checkpoint.block.timestamp + (i + 1) * HOUR, 0.8),
  )
  const later = buildIssue({
    history,
    checkpoints: [first, ...suffix],
    horizonHours: 24,
    issuedAtUtc: at(suffix.at(-1).checkpoint.block.timestamp + 60),
  })
  assert.equal(issue.source.checkpointFilename, first.filename)
  assert.notEqual(later.source.checkpointFilename, issue.source.checkpointFilename)
  assert.throws(
    () =>
      buildIssue({
        history,
        checkpoints: [first, ...suffix],
        horizonHours: 24,
        issuedAtUtc: issueTime,
      }),
    /Issue clock outside fresh prospective window/,
  )
})

test('stale or clock-reversed issue is rejected and cannot be issued retroactively', () => {
  assert.throws(
    () =>
      buildIssue({
        history,
        checkpoints: [first],
        horizonHours: 24,
        issuedAtUtc: at(first.checkpoint.block.timestamp - 1),
      }),
    /Issue clock/,
  )
  assert.throws(
    () =>
      buildIssue({
        history,
        checkpoints: [first],
        horizonHours: 24,
        issuedAtUtc: at(first.checkpoint.block.timestamp + 2 * HOUR + 31),
      }),
    /Issue clock/,
  )
  const out = mkdtempSync(join(tmpdir(), 'level-stale-'))
  assert.equal(
    issueLatest({
      history,
      checkpoints: [first],
      out,
      now: () => new Date(at(first.checkpoint.block.timestamp + 3 * HOUR)),
    }).status,
    'stale_missing',
  )
  assert.equal(verifyIssues({ history, checkpoints: [first], out }).issues, 0)
})

test('immutable issue pair replays exactly and a missing partial is never backfilled', () => {
  const out = mkdtempSync(join(tmpdir(), 'level-pair-'))
  const saved = issueLatest({ history, checkpoints: [first], out, now: () => new Date(issueTime) })
  assert.equal(saved.status, 'issued')
  assert.equal(verifyIssues({ history, checkpoints: [first], out }).issues, 2)
  const bytes = readFileSync(saved.paths[0])
  assert.equal(
    issueLatest({
      history,
      checkpoints: [first],
      out,
      now: () => new Date(at(first.checkpoint.block.timestamp + 9 * HOUR)),
    }).status,
    'existing',
  )
  assert.deepEqual(readFileSync(saved.paths[0]), bytes)
  unlinkSync(saved.paths[1])
  assert.equal(
    issueLatest({ history, checkpoints: [first], out, now: () => new Date(issueTime) }).status,
    'partial_missing',
  )
  assert.equal(
    issueLatest({
      history,
      checkpoints: [first],
      out,
      now: () => new Date(at(first.checkpoint.block.timestamp + 9 * HOUR)),
    }).status,
    'partial_missing',
  )
  assert.equal(verifyIssues({ history, checkpoints: [first], out }).issues, 1)
})

test('score waits for full endpoint window and compares analog with persistence', () => {
  const issue = buildIssue({
    history,
    checkpoints: [first],
    horizonHours: 24,
    issuedAtUtc: issueTime,
  })
  const followups = Array.from({ length: 26 }, (_, i) =>
    checkpoint(i + 1, first.checkpoint.block.timestamp + (i + 1) * HOUR, 0.9996),
  )
  assert.equal(
    scoreIssue(
      issue,
      [first, ...followups.slice(0, 24)],
      at(first.checkpoint.block.timestamp + 24 * HOUR + 60),
    ),
    null,
  )
  const score = scoreIssue(
    issue,
    [first, ...followups],
    at(first.checkpoint.block.timestamp + 26 * HOUR + 60),
  )
  assert.equal(score.status, 'observed')
  assert.equal(score.actualQuote, 0.9996)
  assert.equal(score.persistenceError, issue.currentQuote - score.actualQuote)
  assert.equal(score.forecastError, issue.projectedQuote - score.actualQuote)
  assert.equal(score.endpointPhysicalSha256, followups[23].physicalSha256)
})

test('missing endpoint and a gap are censored, never counted as observed', () => {
  const issue = buildIssue({
    history,
    checkpoints: [first],
    horizonHours: 24,
    issuedAtUtc: issueTime,
  })
  const gapEnd = checkpoint(1, first.checkpoint.block.timestamp + 24 * HOUR, 0.7)
  const frontier = checkpoint(2, first.checkpoint.block.timestamp + 26 * HOUR, 0.7)
  const gap = scoreIssue(
    issue,
    [first, gapEnd, frontier],
    at(frontier.checkpoint.block.timestamp + 60),
  )
  assert.equal(gap.status, 'censored_gap')
  assert.equal(gap.actualQuote, null)
  const missing = scoreIssue(issue, [first, frontier], at(frontier.checkpoint.block.timestamp + 60))
  assert.equal(missing.status, 'missing_target')
  assert.equal(missing.forecastError, null)
})

test('physical and logical source tampering or sealed issue tampering fails replay', () => {
  const out = mkdtempSync(join(tmpdir(), 'level-tamper-'))
  const path = issueLatest({ history, checkpoints: [first], out, now: () => new Date(issueTime) })
    .paths[0]
  const saved = JSON.parse(readFileSync(path, 'utf8'))
  writeFileSync(path, JSON.stringify({ ...saved, currentQuote: 0.1 }))
  assert.throws(() => verifyIssues({ history, checkpoints: [first], out }), /seal mismatch/)
  writeFileSync(
    path,
    JSON.stringify(
      reseal({
        ...saved,
        source: { ...saved.source, checkpointPhysicalSha256: digest('forgery') },
      }),
    ),
  )
  assert.throws(() => verifyIssues({ history, checkpoints: [first], out }), /as-of replay mismatch/)
  writeFileSync(path, JSON.stringify(saved))
  assert.throws(
    () =>
      verifyIssues({
        history,
        checkpoints: [{ ...first, physicalSha256: digest('changed') }],
        out,
      }),
    /as-of replay mismatch/,
  )
})

test('score sidecar is immutable and as-of score tampering fails verification', () => {
  const out = mkdtempSync(join(tmpdir(), 'level-score-'))
  const path = issueLatest({ history, checkpoints: [first], out, now: () => new Date(issueTime) })
    .paths[0]
  const followups = Array.from({ length: 26 }, (_, i) =>
    checkpoint(i + 1, first.checkpoint.block.timestamp + (i + 1) * HOUR, 0.9996),
  )
  const checkpoints = [first, ...followups]
  const now = () => new Date(at(followups.at(-1).checkpoint.block.timestamp + 60))
  assert.equal(scoreMatured({ history, checkpoints, out, now }).written, 1)
  assert.equal(verifyIssues({ history, checkpoints, out }).scores, 1)
  const scorePath = `${path}.score.json`
  const bytes = readFileSync(scorePath)
  assert.equal(scoreMatured({ history, checkpoints, out, now }).written, 0)
  assert.deepEqual(readFileSync(scorePath), bytes)
  const saved = JSON.parse(bytes)
  writeFileSync(scorePath, JSON.stringify(reseal({ ...saved, actualQuote: 0.1 })))
  assert.throws(() => verifyIssues({ history, checkpoints, out }), /Score as-of replay mismatch/)
})

test('local sealed corpus remains readable without issuing or scoring', async (t) => {
  try {
    const [{ readHistorical }, { readValidatedCheckpoints }] = await Promise.all([
      import('./curve-prospective-level-forecast.mjs'),
      import('./curve-prospective-quote.mjs'),
    ])
    const rows = readHistorical()
    const checkpoints = readValidatedCheckpoints()
    assert.equal(rows.length, 3184)
    assert.ok(checkpoints.length > 0)
    const before = verifyIssues({ history: rows, checkpoints })
    assert.ok(before.issues >= 0 && before.scores <= before.issues)
    assert.deepEqual(verifyIssues({ history: rows, checkpoints }), before)
  } catch (error) {
    if (/Unknown artifact|ENOENT/.test(String(error))) t.skip('Local archive absent')
    else throw error
  }
})
