import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  asOfRiskSet,
  buildIssue,
  completedEpisodes,
  riskSetBoundsAtHorizon,
  scoreIssue,
  STUDY,
  STUDY_V2,
} from './scrvusd-holder-duration.mjs'

const BASE = 1_790_000_000
const holder = `0x${'1'.repeat(40)}`
const plan = { holder, rawCrvUsd: '1000', sha256: 'a'.repeat(64) }
const selectionSha256 = 'b'.repeat(64)
const iso = (seconds) => new Date(seconds * 1000).toISOString()
const hash = (n) => `0x${n.toString(16).padStart(64, '0')}`
function data(states, { gap = 600, shares = [], previews = [] } = {}) {
  const checkpoints = []
  const holderRows = []
  states.forEach((state, index) => {
    const number = 100 + index
    const block = { number, hash: hash(number), timestamp: BASE + index * gap }
    const filename = `${String(number).padStart(12, '0')}-${block.hash.slice(2)}.json`
    const checkpoint = {
      filename,
      physicalSha256: `c${String(index).padStart(63, '0')}`,
      checkpoint: {
        block,
        sha256: `d${String(index).padStart(63, '0')}`,
        captureEndUtc: iso(block.timestamp + 2),
      },
    }
    checkpoints.push(checkpoint)
    if (state === 'missing') return
    const issue = {
      checkpoint: { block },
      captureEndUtc: iso(block.timestamp + 4),
      planSha256: plan.sha256,
      holder,
      rawCrvUsd: plan.rawCrvUsd,
      sha256: `e${String(index).padStart(63, '0')}`,
      result: {
        status: state,
        balanceSharesRaw: shares[index] ?? '2000',
        previewSharesRaw: previews[index] ?? '100',
        maxWithdrawAssetsRaw: '5000',
      },
    }
    holderRows.push({ filename, physicalSha256: `f${String(index).padStart(63, '0')}`, issue })
  })
  return { checkpoints, holderRows }
}
function make(dataSet, index = 0) {
  const row = dataSet.holderRows.find((item) => item.issue.checkpoint.block.number === 100 + index)
  return buildIssue({
    plan,
    selectionSha256,
    ...dataSet,
    atBlock: 100 + index,
    issuedAtUtc: iso(Date.parse(row.issue.captureEndUtc) / 1000 + 1),
  })
}
function score(issue, dataSet, index, scoredAtOffset = index * 600 + 5) {
  return scoreIssue({
    issue,
    ...dataSet,
    throughBlock: 100 + index,
    scoredAtUtc: iso(BASE + scoredAtOffset),
  })
}

test('new success issues an uncalibrated as-of risk set with ongoing exposure', () => {
  const observed = data(['success', 'success'])
  const first = make(observed)
  assert.equal(first.study, STUDY_V2)
  assert.equal(first.baseline.status, 'uncalibrated')
  assert.equal(first.baseline.episodeCount, 1)
  assert.equal(first.baseline.counts.ongoingRightCensors, 1)
  assert.equal(first.baseline.episodes[0].observedLowerSeconds, 0)
  assert.equal(first.priorSource.quotes.length, 0)
  const second = make(observed, 1)
  assert.equal(second.priorSource.quotes.length, 1)
  assert.equal(second.priorSource.holderIssues.length, 1)
  assert.equal(second.baseline.episodes[0].observedLowerSeconds, 600)
  assert.notEqual(first.sha256, second.sha256)
})

test('first clean success to revert is interval censored and later clean success is recovery', () => {
  const observed = data(['success', 'success', 'revert', 'success'])
  const issue = make(observed)
  const loss = score(issue, observed, 2)
  assert.equal(loss.observed.status, 'first_loss_observed')
  assert.equal(loss.observed.firstLoss.lowerSeconds, 600)
  assert.equal(loss.observed.firstLoss.upperSeconds, 1200)
  const recovery = score(issue, observed, 3)
  assert.equal(recovery.observed.status, 'first_loss_with_later_recovery')
  assert.equal(recovery.observed.recovery.block, 103)
  assert.equal(recovery.futureSource.quotes.length, 3)
  assert.equal(completedEpisodes(observed).length, 1)
})

test('unknown, missing observation and share attrition right censor before an apparent revert', () => {
  for (const states of [
    ['success', 'provider_error', 'revert'],
    ['success', 'missing', 'revert'],
    ['success', 'revert'],
  ]) {
    const observed = data(states, { shares: states[1] === 'revert' ? [null, '1999'] : [] })
    const issue = make(observed)
    const result = score(
      issue,
      observed,
      states.length - 1,
      states[1] === 'missing' ? 600 + 3601 : states.length * 600 + 5,
    )
    assert.equal(result.observed.status, 'right_censored')
    assert.equal(result.observed.firstLoss, undefined)
  }
})

test('a missing holder checkpoint cannot be sealed as censor while a valid sample may still arrive', () => {
  const observed = data(['success', 'missing'])
  assert.throws(() => score(make(observed), observed, 1), /not yet closed/)
  assert.equal(
    score(make(observed), observed, 1, 4201).observed.censor.reason,
    'missing_holder_observation',
  )
})

test('ongoing success is right censored at observation, not a predicted survival duration', () => {
  const observed = data(['success', 'success'])
  const outcome = score(make(observed), observed, 1)
  assert.equal(outcome.observed.status, 'right_censored')
  assert.equal(outcome.observed.observedSeconds, 600)
})

test('issue rejects late creation, unsuccessful anchor and wrong selection seal', () => {
  const observed = data(['success', 'revert'])
  assert.throws(() => make(observed, 1), /Ineligible/)
  assert.throws(
    () =>
      buildIssue({
        plan,
        selectionSha256: 'wrong',
        ...observed,
        atBlock: 100,
        issuedAtUtc: iso(BASE + 5),
      }),
    /Ineligible/,
  )
  assert.throws(
    () =>
      buildIssue({
        plan,
        selectionSha256,
        ...observed,
        atBlock: 100,
        issuedAtUtc: iso(BASE + 3605),
      }),
    /late/,
  )
})

test('issue replay excludes earlier-block sources first captured after issuance', () => {
  const observed = data(['success', 'revert', 'success'])
  const issuedAtUtc = iso(BASE + 1205)
  for (const row of observed.checkpoints.slice(0, 2)) {
    row.checkpoint.captureEndUtc = iso(BASE + 1300)
  }
  for (const row of observed.holderRows.slice(0, 2)) {
    row.issue.captureEndUtc = iso(BASE + 1301)
  }
  const asOf = buildIssue({
    plan,
    selectionSha256,
    checkpoints: observed.checkpoints.slice(2),
    holderRows: observed.holderRows.slice(2),
    atBlock: 102,
    issuedAtUtc,
  })
  const replay = buildIssue({ plan, selectionSha256, ...observed, atBlock: 102, issuedAtUtc })
  assert.deepEqual(replay, asOf)
  assert.equal(replay.baseline.episodeCount, 1)
  assert.equal(replay.priorSource.quotes.length, 0)
  assert.equal(replay.priorSource.holderIssues.length, 0)
})

test('v1 issue and score retain original sealed shape for historical replay', () => {
  const observed = data(['success', 'revert'])
  const v1 = buildIssue({
    plan,
    selectionSha256,
    ...observed,
    atBlock: 100,
    issuedAtUtc: iso(BASE + 5),
    version: 1,
  })
  assert.equal(v1.study, STUDY)
  assert.deepEqual(v1.baseline, {
    status: 'unavailable',
    reason: 'insufficient_clean_prior_episodes',
    completeEpisodes: 0,
    requiredEpisodes: 10,
  })
  assert.equal(score(v1, observed, 1).study, `${STUDY}-score-v1`)
})

test('risk set preserves loss intervals, ongoing and ambiguous censors with source schedule', () => {
  const observed = data([
    'success',
    'success',
    'revert',
    'success',
    'provider_error',
    'success',
    'missing',
    'success',
    'revert',
    'success',
  ])
  observed.holderRows.find(
    (row) => row.issue.checkpoint.block.number === 108,
  ).issue.result.balanceSharesRaw = '1999'
  const issue = make(observed, 9)
  const risk = issue.baseline
  assert.deepEqual(risk.counts, {
    firstLossIntervals: 1,
    ongoingRightCensors: 1,
    ambiguousCensors: 3,
  })
  assert.deepEqual(
    risk.episodes.map((row) => row.outcome),
    ['first_loss_interval', 'censored', 'censored', 'censored', 'ongoing_right_censor'],
  )
  assert.deepEqual(
    risk.episodes.filter((row) => row.outcome === 'censored').map((row) => row.censorReason),
    ['provider_ambiguity', 'pending_holder_observation', 'share_attrition_or_insufficient_shares'],
  )
  assert.equal(risk.episodes[0].lowerSeconds, 600)
  assert.equal(risk.episodes[0].upperSeconds, 1200)
  assert.equal(risk.observationSchedule.length, 10)
  assert.equal(risk.observationSchedule[6].holderIssue, null)
  assert.equal(risk.observationSchedule[4].holderCaptureEndUtc, iso(BASE + 2404))
  assert.equal(
    risk.observationSchedule[9].quote.logicalSha256,
    observed.checkpoints[9].checkpoint.sha256,
  )
  assert.equal(risk.episodes.at(-1).startBlock, 109)
})

test('as-of chronology excludes later captured samples and labels closed missing observation', () => {
  const observed = data(['success', 'missing', 'success'])
  const pending = make(observed, 2)
  assert.equal(pending.baseline.episodes[0].censorReason, 'pending_holder_observation')
  const later = asOfRiskSet({
    ...observed,
    throughBlock: 102,
    issuedAtUtc: iso(BASE + 4201),
  })
  assert.equal(later.episodes[0].censorReason, 'missing_holder_observation')
  observed.holderRows[0].issue.captureEndUtc = iso(BASE + 1301)
  const asOf = buildIssue({
    plan,
    selectionSha256,
    ...observed,
    atBlock: 102,
    issuedAtUtc: iso(BASE + 1205),
  })
  assert.equal(asOf.baseline.episodeCount, 1)
  assert.equal(asOf.baseline.episodes[0].startBlock, 102)
  assert.deepEqual(
    asOf.baseline.observationSchedule.map((row) => row.block),
    [100, 101, 102],
  )
  assert.equal(asOf.baseline.observationSchedule[0].holderIssue, null)
})

test('caller-chosen horizons produce interval/censor bounds without a point forecast', () => {
  const observed = data(['success', 'success', 'revert', 'success'])
  const risk = make(observed, 3).baseline
  const early = riskSetBoundsAtHorizon(risk, 600)
  assert.equal(early.horizonOrigin, 'episode_start')
  assert.equal(early.episodeCount, 2)
  assert.equal(early.definitelyAlive, 1)
  assert.equal(early.ambiguous, 1)
  assert.equal(early.empiricalPersistenceLowerBound, 0.5)
  assert.equal(early.empiricalPersistenceUpperBound, 1)
  const late = riskSetBoundsAtHorizon(risk, 1200)
  assert.equal(late.definitelyFailed, 1)
  assert.equal(late.ambiguous, 1)
  assert.equal(late.empiricalPersistenceLowerBound, 0)
  assert.equal(late.empiricalPersistenceUpperBound, 0.5)
  assert.throws(() => riskSetBoundsAtHorizon(risk, -1), /horizon/)
})

test('score refuses a future-captured through quote or unresolved holder sample', () => {
  const observed = data(['success', 'revert'])
  const issue = make(observed)
  observed.checkpoints[1].checkpoint.captureEndUtc = iso(BASE + 700)
  assert.throws(() => score(issue, observed, 1), /Score boundary/)
  observed.checkpoints[1].checkpoint.captureEndUtc = iso(BASE + 602)
  observed.holderRows[1].issue.captureEndUtc = iso(BASE + 700)
  assert.throws(() => score(issue, observed, 1), /not yet closed/)
})

test('inconsistent earlier success cannot enter or restart the completed-episode risk set', () => {
  const observed = data(['success', 'revert', 'success', 'revert'])
  observed.holderRows[0].issue.result.maxWithdrawAssetsRaw = '999'
  observed.holderRows[2].issue.result.balanceSharesRaw = '10'
  assert.equal(completedEpisodes(observed).length, 0)
})
