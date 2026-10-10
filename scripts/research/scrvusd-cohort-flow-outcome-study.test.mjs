import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { joinIssue, study, summarize } from './scrvusd-cohort-flow-outcome-study.mjs'

const root = resolve('data/research/venue-signals')
const realFirst =
  '000026072271-602810b969ba8d9d51f448584f6dfb56d23bf940b25c931be31abea62db3ce63.json'
const realSecond =
  '000026072303-8c9f3cbea198abf6cdd4e0d0acb4310eeb001de56a18e6cbac007a930745fbeb.json'
const hasLocalCorpus =
  process.env.MEMBRANE_TEST_NO_LOCAL_CORPUS !== '1' &&
  [realFirst, realSecond].every(
    (filename) =>
      existsSync(join(root, 'scrvusd-cohort-duration', 'issues', filename)) &&
      existsSync(join(root, 'scrvusd-cohort-flow-context', filename)),
  ) &&
  existsSync(
    join(root, 'scrvusd-cohort-duration', 'scores', `${realFirst}.through-000026072303.json`),
  )

const digest = (letter) => letter.repeat(64)
const block = (number, timestamp) => ({
  number,
  hash: `0x${number.toString(16).padStart(64, '0')}`,
  timestamp,
})
const first = block(100, 1_790_554_199)
const second = block(101, first.timestamp + 384)
const filenameFor = (value) =>
  `${String(value.number).padStart(12, '0')}-${value.hash.slice(2)}.json`
const holders = Array.from({ length: 5 }, (_, index) => `0x${(index + 1).toString(16).repeat(40)}`)
const roster = Array.from({ length: 16 }, (_, index) => ({
  holder: holders[index % holders.length],
  rawCrvUsd: String(1000 * (index % 4 || 1)),
  cleanSuccessAtAnchor: true,
}))

function fixture(index, withScore = false) {
  const anchor = index === 0 ? first : second
  const issueTime = new Date((anchor.timestamp + 10) * 1000).toISOString()
  const recordedTime = new Date((anchor.timestamp + 100) * 1000).toISOString()
  const duration = {
    study: 'scrvusd-cohort-executable-duration-v1',
    sha256: digest(index === 0 ? 'a' : 'b'),
    block: anchor,
    issuedAtUtc: issueTime,
    riskSet: { forecast: { status: 'unavailable' }, pairCount: 16, members: roster },
  }
  const durationRef = {
    filename: filenameFor(anchor),
    logicalSha256: duration.sha256,
    physicalSha256: digest(index === 0 ? 'c' : 'd'),
  }
  const sameBlockFlowFeatureIssue =
    index === 0
      ? {
          status: 'available',
          issuedAtUtc: new Date((anchor.timestamp + 5) * 1000).toISOString(),
          flowFeatures: {
            checkpoint: {
              blockNumber: anchor.number,
              blockHash: anchor.hash,
              timestamp: anchor.timestamp,
            },
          },
        }
      : { status: 'unavailable', reason: 'same_B_flow_not_available_before_duration_issue' }
  const context = {
    study: 'scrvusd-cohort-duration-flow-context-v1',
    sha256: digest(index === 0 ? 'e' : 'f'),
    block: anchor,
    issuedAtUtc: recordedTime,
    cohortDurationIssue: durationRef,
    cohort: { pairCount: 16, distinctHolderCount: 5, vaultCount: 1 },
    sameBlockFlowFeatureIssue,
    historicalSuffix: {
      evidenceCutoffUtc: issueTime,
      coverage: { consecutiveBlocks: 85_000 },
      completeToFirstLive: false,
      maximumObservedCompleteWindow: { '24h': { status: 'observed' } },
      maximumObservedCompleteWindowNetDepletion: { '7d': { status: 'observed' } },
    },
  }
  const contextRef = {
    filename: filenameFor(anchor),
    logicalSha256: context.sha256,
    physicalSha256: digest(index === 0 ? '1' : '2'),
  }
  const scores = withScore
    ? [
        {
          score: {
            study: 'scrvusd-cohort-executable-duration-v1-score-v1',
            sha256: digest('3'),
            issueSha256: duration.sha256,
            scoredAtUtc: new Date((second.timestamp + 30) * 1000).toISOString(),
            through: { block: second },
            futureSource: { quotes: [{ block: second }] },
            members: roster.map(({ holder, rawCrvUsd }) => ({
              holder,
              rawCrvUsd,
              observed: {
                status: 'right_censored',
                reason: 'still_successful_at_sampled_blocks',
                observedSeconds: 384,
              },
            })),
          },
          scoreRef: { logicalSha256: digest('3'), physicalSha256: digest('4') },
        },
      ]
    : []
  return { duration, durationRef, context, contextRef, scores }
}

const syntheticIssues = () => [joinIssue(fixture(0, true)), joinIssue(fixture(1))]

test('synthetic fixed cohort keeps sampled times and later anchor pending', () => {
  const issues = syntheticIssues()
  assert.equal(issues[0].sameBlockFlow.status, 'available')
  assert.equal(issues[1].sameBlockFlow.status, 'unavailable')
  assert.equal(issues[0].latestScore.through.number, second.number)
  assert.equal(issues[1].latestScore.status, 'pending_followup')
  assert.equal(issues[0].historicalSuffix.maximumObservedCompleteWindow['24h'].status, 'observed')
  assert.equal(
    issues[1].historicalSuffix.maximumObservedCompleteWindowNetDepletion['7d'].status,
    'observed',
  )
  assert.deepEqual(issues[0].members[0].sampledSuccessSeconds, [0, 384])
  assert.deepEqual(issues[1].members[0].sampledSuccessSeconds, [0])
  const horizons = [0, 60, 384, 385, 7200, 86400].map((seconds) => summarize(issues, seconds))
  assert.equal(horizons[0].counts.sampled_success_at_horizon, 32)
  assert.equal(horizons[1].counts.unobserved_between_samples, 16)
  assert.equal(horizons[1].counts.pending_followup, 16)
  assert.equal(horizons[2].counts.sampled_success_at_horizon, 16)
  assert.equal(horizons[2].counts.pending_followup, 16)
  assert.equal(horizons[3].counts.observed_success_right_censor, 16)
  assert.equal(horizons[3].counts.pending_followup, 16)
  assert.equal(horizons[4].forecast.status, 'unavailable')
  assert.equal(horizons[5].forecast.status, 'unavailable')
})

test('wrong block, physical issue seal, or evidence cutoff refuses context join', () => {
  const input = fixture(0)
  const mutations = [
    { ...input, context: { ...input.context, block: { ...input.context.block, timestamp: 1 } } },
    { ...input, durationRef: { ...input.durationRef, physicalSha256: digest('9') } },
    {
      ...input,
      context: {
        ...input.context,
        historicalSuffix: {
          ...input.context.historicalSuffix,
          evidenceCutoffUtc: '2026-09-29T00:00:00Z',
        },
      },
    },
  ]
  for (const row of mutations) assert.throws(() => joinIssue(row), /does not bind/)
})

test('late same-block feature is never promoted to as-of evidence', () => {
  const input = fixture(0)
  const changed = structuredClone(input.context)
  changed.sameBlockFlowFeatureIssue.issuedAtUtc = '2026-09-29T00:00:00Z'
  assert.throws(() => joinIssue({ ...input, context: changed }), /unavailable as of/)
  assert.equal(joinIssue(fixture(1)).sameBlockFlow.status, 'unavailable')
})

test('first loss intervals, ambiguity, and absent follow-up differ at arbitrary horizons', () => {
  const issues = syntheticIssues()
  const loss = structuredClone(issues[0])
  loss.members[0].observed = {
    status: 'first_loss_observed',
    firstLoss: { lowerSeconds: 384, upperSeconds: 960 },
  }
  const censor = structuredClone(issues[0])
  censor.members[1].observed = {
    status: 'right_censored',
    censor: { observedLowerSeconds: 384, reason: 'provider_ambiguity' },
  }
  const counts = summarize([loss, censor, issues[1]], 600).counts
  assert.equal(counts.first_loss_interval_straddles_horizon, 1)
  assert.equal(counts.ambiguous_right_censor, 1)
  assert.equal(counts.pending_followup, 16)
  assert.equal(summarize([loss], 960).counts.first_revert_observed_by_horizon, 1)
  assert.throws(() => summarize(issues, -1), /Invalid horizon/)
  assert.throws(() => summarize(issues, 1.5), /Invalid horizon/)
})

test('sealed local artifact integration', { skip: !hasLocalCorpus }, () => {
  const result = study({ horizons: [0, 60, 384, 385] })
  assert.ok(result.issues.length >= 2)
  assert.equal(result.issues[0].sameBlockFlow.status, 'available')
  assert.equal(result.issues[1].sameBlockFlow.status, 'unavailable')
  if (result.issues.length > 2) assert.equal(result.issues[2].sameBlockFlow.status, 'available')
  assert.ok(result.horizons[1].counts.unobserved_between_samples >= 16)
  assert.equal(result.horizons[2].counts.sampled_success_at_horizon, 16)
  assert.equal(result.horizons[3].forecast.status, 'unavailable')
})
