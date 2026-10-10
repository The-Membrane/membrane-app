import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { horizonClass, scrvusdPanel, scrvusdPanelFromIssues } from './exit-evidence-panel.mjs'

const venue = { chainId: 1, vault: '0xvault', asset: '0xasset', route: 'direct_erc4626_withdraw' }
const ref = {
  filename: 'sealed.json',
  logicalSha256: 'a'.repeat(64),
  physicalSha256: 'b'.repeat(64),
}
const anchor = { number: 100, hash: `0x${'1'.repeat(64)}`, timestamp: 1790553600 }
const asOfUtc = '2026-09-28T01:00:00.000Z'
const member = (observed, sampledSuccessSeconds = [0, 300]) => ({
  holder: '0xholder',
  rawCrvUsd: '1000',
  cleanSuccessAtAnchor: true,
  observed,
  sampledSuccessSeconds,
})
const issue = (observed) => ({
  anchor,
  anchorIssuedAtUtc: '2026-09-28T00:01:00.000Z',
  flowContextRecordedAtUtc: '2026-09-28T00:02:00.000Z',
  durationIssue: ref,
  flowContextIssue: ref,
  latestScore: {
    ...ref,
    scoredAtUtc: '2026-09-28T00:05:00.000Z',
    through: { ...anchor, number: 101, timestamp: anchor.timestamp + 300 },
  },
  sameBlockFlow: { status: 'unavailable', reason: 'late_feature' },
  historicalSuffix: {
    evidenceCutoffUtc: '2026-09-28T00:01:00.000Z',
    coverage: { fromBlock: 1, throughBlock: 2 },
    completeToFirstLive: false,
    maximumObservedCompleteWindow: {
      '24h': {
        status: 'observed',
        startUtc: '2026-09-01T00:00:00.000Z',
        endExclusiveUtc: '2026-09-02T00:00:00.000Z',
      },
    },
    maximumObservedCompleteWindowNetDepletion: {
      '24h': {
        status: 'observed',
        startUtc: '2026-09-03T00:00:00.000Z',
        endExclusiveUtc: '2026-09-04T00:00:00.000Z',
      },
    },
  },
  members: [member(observed)],
})

test('future score or issue/context time cannot enter an earlier panel', () => {
  const first = issue({ status: 'right_censored', observedSeconds: 300 })
  for (const key of ['anchorIssuedAtUtc', 'flowContextRecordedAtUtc']) {
    const late = { ...first, [key]: '2026-09-28T02:00:00.000Z' }
    assert.throws(
      () => scrvusdPanelFromIssues({ issues: [late], asOfUtc, venue }),
      /unavailable at as-of/,
    )
  }
  const lateScore = {
    ...first,
    latestScore: { ...first.latestScore, scoredAtUtc: '2026-09-28T02:00:00.000Z' },
  }
  assert.throws(
    () => scrvusdPanelFromIssues({ issues: [lateScore], asOfUtc, venue }),
    /unavailable at as-of/,
  )
  const beyondScore = structuredClone(first)
  beyondScore.members[0].sampledSuccessSeconds.push(600)
  assert.throws(
    () => scrvusdPanelFromIssues({ issues: [beyondScore], asOfUtc, venue }),
    /unavailable at as-of/,
  )
})

test('scrvUSD join cannot smuggle nested future outcome or flow evidence', () => {
  const original = issue(null)
  original.latestScore = { status: 'pending_followup' }
  original.members[0].sampledSuccessSeconds = [0]
  const input = (value) => scrvusdPanelFromIssues({ issues: [value], asOfUtc, venue })
  assert.equal(input(original).rows[0].future.observation.status, 'pending_followup')
  const futureOutcome = structuredClone(original)
  futureOutcome.members[0].observed = { status: 'right_censored', observedSeconds: 300 }
  assert.throws(() => input(futureOutcome), /unavailable at as-of/)
  const futureSamples = structuredClone(original)
  futureSamples.members[0].sampledSuccessSeconds.push(300)
  assert.throws(() => input(futureSamples), /unavailable at as-of/)
  const futureHistoricalFlow = structuredClone(original)
  futureHistoricalFlow.historicalSuffix.evidenceCutoffUtc = '2026-09-28T02:00:00.000Z'
  assert.throws(() => input(futureHistoricalFlow), /unavailable at as-of/)
  const futureSameBlockFlow = structuredClone(original)
  futureSameBlockFlow.sameBlockFlow = {
    status: 'available',
    issuedAtUtc: '2026-09-28T02:00:00.000Z',
  }
  assert.throws(() => input(futureSameBlockFlow), /unavailable at as-of/)
})

test('loss interval, right censor, ambiguity and sampled success remain distinct', () => {
  const loss = member({
    status: 'first_loss_observed',
    firstLoss: { lowerSeconds: 300, upperSeconds: 600 },
  })
  assert.equal(horizonClass(loss, 300), 'sampled_success_at_horizon')
  assert.equal(horizonClass(loss, 450), 'first_loss_interval_straddles_horizon')
  assert.equal(horizonClass(loss, 600), 'first_revert_observed_by_horizon')
  assert.equal(
    horizonClass(member({ status: 'right_censored', observedSeconds: 300 }), 301),
    'right_censored_before_horizon',
  )
  assert.equal(
    horizonClass(member({ status: 'right_censored', observedSeconds: 300 }), 300),
    'sampled_success_at_horizon',
  )
  assert.equal(
    horizonClass(
      member({ status: 'right_censored', censor: { reason: 'provider_ambiguity' } }),
      301,
    ),
    'ambiguous_right_censor',
  )
  assert.equal(horizonClass(member(null, [0]), 600), 'pending_followup')
})

test('flow windows and dependent counts are exposed without a probability', () => {
  const first = issue({ status: 'right_censored', observedSeconds: 300 })
  const second = structuredClone(first)
  second.anchor = { ...first.anchor, number: 102, timestamp: first.anchor.timestamp + 120 }
  second.anchorIssuedAtUtc = '2026-09-28T00:03:00.000Z'
  second.flowContextRecordedAtUtc = '2026-09-28T00:04:00.000Z'
  second.latestScore.through.timestamp = second.anchor.timestamp + 300
  second.members[0].rawCrvUsd = '2000'
  const panel = scrvusdPanelFromIssues({
    issues: [first, second],
    asOfUtc,
    horizons: [0, 450, 86400],
    venue,
  })
  assert.equal(panel.dependence.dependentPairCount, 2)
  assert.equal(panel.schema, 'scrvusd-exit-evidence-panel-v1')
  assert.equal(panel.dependence.distinctHolderCount, 1)
  assert.equal(panel.dependence.vaultCount, 1)
  assert.equal(panel.dependence.overlappingAnchorWindowClusterCount, 1)
  assert.equal(panel.dependence.independentEpisodeCount, null)
  assert.equal(panel.forecast.status, 'unavailable')
  assert.equal(panel.rows[0].future.horizons[1].class, 'right_censored_before_horizon')
  assert.notEqual(
    panel.rows[0].historicalFlowContext.grossWithdrawalMaxima['24h'].startUtc,
    panel.rows[0].historicalFlowContext.signedNetDepletionMaxima['24h'].startUtc,
  )
  assert.equal(panel.rows[0].historicalFlowContext.completeToFirstLive, false)
  assert.equal(panel.rows[0].historicalFlowContext.sameBlockTrailingGrossNet.status, 'unavailable')
})

test(
  'local sealed three-anchor replay excludes later score receipts at earlier cutoffs',
  {
    skip:
      process.env.MEMBRANE_TEST_NO_LOCAL_CORPUS === '1' ||
      !existsSync(resolve('data/research/venue-signals/scrvusd-cohort-duration/issues')),
  },
  () => {
    const beforeContext = scrvusdPanel({ asOfUtc: '2026-09-28T00:35:00.000Z', horizons: [384] })
    assert.equal(beforeContext.rows.length, 0)
    const early = scrvusdPanel({ asOfUtc: '2026-09-28T01:00:00.000Z', horizons: [384, 86400] })
    const late = scrvusdPanel({ asOfUtc: '2026-09-28T02:00:00.000Z', horizons: [384, 86400] })
    assert.equal(early.dependence.anchorCount, 2)
    assert.equal(early.dependence.dependentPairCount, 32)
    assert.equal(late.dependence.anchorCount, 3)
    assert.equal(late.dependence.dependentPairCount, 48)
    assert.equal(late.dependence.distinctHolderCount, 5)
    assert.equal(late.dependence.vaultCount, 1)
    assert.equal(late.dependence.overlappingAnchorWindowClusterCount, 1)
    assert.equal(early.rows[0].historicalFlowContext.completeToFirstLive, false)
    assert.equal(
      early.rows[16].historicalFlowContext.sameBlockTrailingGrossNet.status,
      'unavailable',
    )
    assert.equal(late.rows[0].future.lastSampledSuccessBlock.number, 26072398)
    assert.equal(late.rows[32].future.lastSampledSuccessBlock.number, 26072398)
    assert.ok(
      Date.parse(early.rows[0].future.outcomeSourceCutoffUtc) <
        Date.parse(late.rows[0].future.outcomeSourceCutoffUtc),
    )
    assert.equal(late.rows[32].future.observation.status, 'pending_followup')
  },
)
