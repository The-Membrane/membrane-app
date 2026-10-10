import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildIssue,
  issueFresh,
  issueLatest,
  scoreIssue,
  scoreMatured,
  verifyIssues,
} from './curve-prospective-duration.mjs'

const HOUR = 3600
const BASE = 1_790_000_000
const sha = (value) => createHash('sha256').update(value).digest('hex')
const reseal = ({ sha256: _old, ...payload }) => ({
  ...payload,
  sha256: sha(JSON.stringify(payload)),
})
const stat = () => ({ bavail: 2_000_000_000, bsize: 1 })
const history = () =>
  Array.from({ length: 12 }, (_, i) => ({
    at: BASE + i * 3 * HOUR,
    block: 1_000 + i,
    quote: 1,
  }))
function checkpoint(at, number, quote = 1) {
  const hash = `0x${number.toString(16).padStart(64, '0')}`
  return {
    filename: `${String(number).padStart(12, '0')}-${hash.slice(2)}.json`,
    physicalSha256: 'b'.repeat(64),
    checkpoint: {
      study: 'fixture',
      sha256: 'a'.repeat(64),
      source: { identitySha256: 'c'.repeat(64) },
      block: { number, hash, timestamp: at },
      captureEndUtc: new Date((at + 60) * 1000).toISOString(),
      routes: { 1000000: { bestQuote: quote } },
    },
  }
}

test('issue is frozen as of checkpoint, including past-only baseline and sparse abstention', () => {
  const prior = history()
  const item = checkpoint(prior.at(-1).at + 3 * HOUR, 2000)
  const issuedAtUtc = new Date((item.checkpoint.block.timestamp + 120) * 1000).toISOString()
  const issue = buildIssue({ history: prior, checkpoints: [item], horizonHours: 24, issuedAtUtc })
  assert.equal(issue.status, 'research_only')
  assert.equal(issue.threshold, 0.999)
  assert.equal(issue.analog.status, 'abstain_insufficient_risk_or_events')
  assert.equal(issue.unconditional.status, 'abstain_insufficient_risk_or_events')
  const later = checkpoint(item.checkpoint.block.timestamp + HOUR, 2001, 0)
  assert.deepEqual(
    buildIssue({ history: prior, checkpoints: [item], horizonHours: 24, issuedAtUtc }),
    issue,
  )
  assert.notEqual(
    buildIssue({
      history: prior,
      checkpoints: [item, later],
      horizonHours: 24,
      issuedAtUtc: new Date((later.checkpoint.block.timestamp + 120) * 1000).toISOString(),
    }).sha256,
    issue.sha256,
  )
})

test('gap and already breached anchor are explicit unavailable states', () => {
  const prior = history()
  const gap = checkpoint(prior.at(-1).at + 30 * HOUR, 2000)
  const at = new Date((gap.checkpoint.block.timestamp + 120) * 1000).toISOString()
  assert.equal(
    buildIssue({ history: prior, checkpoints: [gap], horizonHours: 72, issuedAtUtc: at }).status,
    'incomplete_24h_history',
  )
  const zero = checkpoint(gap.checkpoint.block.timestamp, 2000, 0)
  assert.equal(
    buildIssue({ history: prior, checkpoints: [zero], horizonHours: 24, issuedAtUtc: at }).status,
    'ineligible_anchor',
  )
})

test('late issue is refused and partial receipt cannot be backfilled after freshness expires', () => {
  const prior = history()
  const item = checkpoint(prior.at(-1).at + 3 * HOUR, 2000)
  const at = item.checkpoint.block.timestamp
  assert.throws(
    () =>
      buildIssue({
        history: prior,
        checkpoints: [item],
        horizonHours: 24,
        issuedAtUtc: new Date((at + 3 * HOUR) * 1000).toISOString(),
      }),
    /issuance window/,
  )
  const out = mkdtempSync(join(tmpdir(), 'duration-issue-'))
  const first = issueLatest({
    history: prior,
    checkpoints: [item],
    out,
    now: () => new Date((at + 120) * 1000),
    stat,
  })
  assert.equal(first.length, 3)
  assert.deepEqual(verifyIssues({ history: prior, checkpoints: [item], out }), {
    issues: 3,
    scores: 0,
    partialGroups: [],
  })
  const again = issueLatest({
    history: prior,
    checkpoints: [item],
    out,
    now: () => new Date((at + 6 * HOUR) * 1000),
    stat,
  })
  assert.ok(again.every((x) => x.existing))
  unlinkSync(first[2].path) // Simulate interruption after only two linked receipts.
  assert.throws(
    () =>
      issueLatest({
        history: prior,
        checkpoints: [item],
        out,
        now: () => new Date((at + 6 * HOUR) * 1000),
        stat,
      }),
    /issuance window/,
  )
})

test('duration issue requires both checkpoint seals and rejects forged legacy shape', () => {
  const prior = history()
  const item = checkpoint(prior.at(-1).at + 3 * HOUR, 2000)
  const out = mkdtempSync(join(tmpdir(), 'duration-seals-'))
  const path = issueLatest({
    history: prior,
    checkpoints: [item],
    out,
    now: () => new Date((item.checkpoint.block.timestamp + 120) * 1000),
    stat,
  })[0].path
  const original = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(original.source.checkpointSha256, item.checkpoint.sha256)
  const write = (source) =>
    writeFileSync(path, JSON.stringify(reseal({ ...original, source })) + '\n')
  write({ ...original.source, checkpointSha256: sha('wrong-logical') })
  assert.throws(
    () => verifyIssues({ history: prior, checkpoints: [item], out }),
    /provenance mismatch/,
  )
  write({ ...original.source, checkpointPhysicalSha256: sha('wrong-physical') })
  assert.throws(
    () => verifyIssues({ history: prior, checkpoints: [item], out }),
    /provenance mismatch/,
  )
  const { checkpointSha256: _missing, ...legacyShape } = original.source
  write(legacyShape)
  assert.throws(
    () => verifyIssues({ history: prior, checkpoints: [item], out }),
    /Unrecognized legacy duration issue physical seal/,
  )
})

test('fresh sweep issues multiple waiting checkpoints in chronological as-of order', () => {
  const prior = history()
  const first = checkpoint(prior.at(-1).at + 3 * HOUR, 2000)
  const second = checkpoint(first.checkpoint.block.timestamp + HOUR, 2001)
  const out = mkdtempSync(join(tmpdir(), 'duration-sweep-'))
  const result = issueFresh({
    history: prior,
    checkpoints: [first, second],
    out,
    now: () => new Date((second.checkpoint.block.timestamp + 120) * 1000),
    stat,
  })
  assert.equal(result.issued, 2)
  assert.equal(result.missingStale.length, 0)
  assert.deepEqual(verifyIssues({ history: prior, checkpoints: [first, second], out }), {
    issues: 6,
    scores: 0,
    partialGroups: [],
  })
  const firstIssue = JSON.parse(readFileSync(result.results[0].receipts[0].path, 'utf8'))
  const secondIssue = JSON.parse(readFileSync(result.results[1].receipts[0].path, 'utf8'))
  assert.equal(firstIssue.source.checkpointFilename, first.filename)
  assert.equal(secondIssue.source.checkpointFilename, second.filename)
  assert.equal(firstIssue.block.timestamp, first.checkpoint.block.timestamp)
})

test('older partial receipts remain verifiable and do not halt newer issuance', () => {
  const prior = history()
  const first = checkpoint(prior.at(-1).at + 3 * HOUR, 2000)
  const second = checkpoint(first.checkpoint.block.timestamp + 3 * HOUR, 2001)
  const out = mkdtempSync(join(tmpdir(), 'duration-partial-'))
  const firstPaths = issueLatest({
    history: prior,
    checkpoints: [first],
    out,
    now: () => new Date((first.checkpoint.block.timestamp + 120) * 1000),
    stat,
  })
  unlinkSync(firstPaths[2].path)
  const result = issueFresh({
    history: prior,
    checkpoints: [first, second],
    out,
    now: () => new Date((second.checkpoint.block.timestamp + 120) * 1000),
    stat,
  })
  assert.equal(result.issued, 1)
  assert.equal(result.missingStale.length, 1)
  assert.deepEqual(result.missingStale[0].missingHorizons, [168])
  assert.deepEqual(verifyIssues({ history: prior, checkpoints: [first, second], out }), {
    issues: 5,
    scores: 0,
    partialGroups: [{ checkpointFilename: first.filename, missingHorizons: [168] }],
  })
})

test('score waits until full endpoint window, preserves breach interval and zero quote', () => {
  const prior = history()
  const anchor = checkpoint(prior.at(-1).at + 3 * HOUR, 2000)
  const at = anchor.checkpoint.block.timestamp
  const issuedAtUtc = new Date((at + 120) * 1000).toISOString()
  const issue = buildIssue({ history: prior, checkpoints: [anchor], horizonHours: 24, issuedAtUtc })
  const observed = [
    anchor,
    checkpoint(at + 3 * HOUR, 2001),
    checkpoint(at + 6 * HOUR, 2002, 0),
    checkpoint(at + 24 * HOUR, 2003),
    checkpoint(at + 26 * HOUR, 2004),
  ]
  assert.equal(scoreIssue(issue, observed.slice(0, -1)), null)
  const score = scoreIssue(issue, observed)
  assert.equal(score.status, 'breach')
  assert.equal(score.stateAtHorizon, 'first_breach_observed')
  assert.deepEqual(score.breachInterval, [at + 3 * HOUR, at + 6 * HOUR])
  assert.equal(score.breachObservation.quote, 0)
})

test('gap censors and cannot be recast as a below-threshold observation', () => {
  const prior = history()
  const anchor = checkpoint(prior.at(-1).at + 3 * HOUR, 2000)
  const at = anchor.checkpoint.block.timestamp
  const issue = buildIssue({
    history: prior,
    checkpoints: [anchor],
    horizonHours: 24,
    issuedAtUtc: new Date((at + 120) * 1000).toISOString(),
  })
  const score = scoreIssue(issue, [
    anchor,
    checkpoint(at + 6 * HOUR, 2001, 0),
    checkpoint(at + 26 * HOUR, 2002),
  ])
  assert.equal(score.status, 'censored_gap')
  assert.equal(score.stateAtHorizon, 'unresolved')
  assert.equal(score.breachObservation, null)
  assert.equal(score.lastNotBelowAt, at)
  assert.equal(score.gapNextObservation.block.timestamp, at + 6 * HOUR)
})

test('exact threshold is no below-threshold breach; an ineligible anchor stays distinct', () => {
  const prior = history()
  const anchor = checkpoint(prior.at(-1).at + 3 * HOUR, 2000)
  const at = anchor.checkpoint.block.timestamp
  const issue = buildIssue({
    history: prior,
    checkpoints: [anchor],
    horizonHours: 24,
    issuedAtUtc: new Date((at + 120) * 1000).toISOString(),
  })
  const observed = [
    anchor,
    ...Array.from({ length: 26 }, (_, i) => checkpoint(at + (i + 1) * HOUR, 2001 + i, 0.999)),
  ]
  const score = scoreIssue(issue, observed)
  assert.equal(score.status, 'censored_end')
  assert.equal(score.stateAtHorizon, 'no_below_threshold_breach_observed')
  const atThresholdAnchor = checkpoint(at, 2000, 0.999)
  const ineligible = buildIssue({
    history: prior,
    checkpoints: [atThresholdAnchor],
    horizonHours: 24,
    issuedAtUtc: new Date((at + 120) * 1000).toISOString(),
  })
  assert.equal(ineligible.status, 'ineligible_anchor')
  const ineligibleScore = scoreIssue(ineligible, [atThresholdAnchor, ...observed.slice(1)])
  assert.equal(ineligibleScore.status, 'ineligible_anchor')
  assert.equal(ineligibleScore.stateAtHorizon, 'already_at_or_below_anchor_threshold')
})

test('score is immutable and verifier rejects seal or as-of provenance changes', () => {
  const prior = history()
  const anchor = checkpoint(prior.at(-1).at + 3 * HOUR, 2000)
  const at = anchor.checkpoint.block.timestamp
  const out = mkdtempSync(join(tmpdir(), 'duration-score-'))
  issueLatest({
    history: prior,
    checkpoints: [anchor],
    out,
    now: () => new Date((at + 120) * 1000),
    stat,
  })
  const future = [
    anchor,
    checkpoint(at + 3 * HOUR, 2001),
    checkpoint(at + 6 * HOUR, 2002, 0),
    checkpoint(at + 26 * HOUR, 2003),
  ]
  const done = scoreMatured({ history: prior, checkpoints: future, out, stat })
  assert.equal(done.written, 1)
  assert.equal(done.pending, 2)
  assert.deepEqual(verifyIssues({ history: prior, checkpoints: future, out }), {
    issues: 3,
    scores: 1,
    partialGroups: [],
  })
  const issuePath = join(
    out,
    `${String(anchor.checkpoint.block.number).padStart(12, '0')}-${anchor.checkpoint.block.hash.slice(2)}-24h.json`,
  )
  const saved = JSON.parse(readFileSync(issuePath, 'utf8'))
  saved.currentQuote = 0.5
  writeFileSync(issuePath, JSON.stringify(saved))
  assert.throws(() => verifyIssues({ history: prior, checkpoints: future, out }), /SHA mismatch/)
  const { sha256: _old, ...payload } = saved
  saved.sha256 = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
  writeFileSync(issuePath, JSON.stringify(saved))
  assert.throws(
    () => verifyIssues({ history: prior, checkpoints: future, out }),
    /provenance mismatch/,
  )
})
