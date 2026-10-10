import assert from 'node:assert/strict'
import test from 'node:test'

import { CONTINUATION_STUDY, STUDY as V1_JOIN_STUDY } from './aave-usdc-cash-direct-flow-join.mjs'
import { scoreAaveV23PreissueFlow } from './aave-usdc-v23-holder-flow-offline-score.mjs'

const hash = (n) => `0x${n.toString(16).padStart(64, '0')}`
const holder = '0x1111111111111111111111111111111111111111'
const at = (seconds) => new Date(seconds * 1000).toISOString()

function joined(count = 100, sliceBlocks = 256) {
  let cash = 1000n
  const slices = Array.from({ length: count }, (_, index) => {
    const from = 1000 + index * sliceBlocks
    const row = {
      fromExclusive: from,
      toInclusive: from + sliceBlocks,
      fromHash: hash(from),
      toHash: hash(from + sliceBlocks),
      cashBeforeRaw: cash.toString(),
      cashAfterRaw: (cash + 10n).toString(),
      grossReserveInRaw: '20',
      grossReserveOutRaw: '10',
      grossSupplierSupplyRaw: '15',
      grossSupplierWithdrawalRaw: '8',
      blockFlows: [
        {
          blockNumber: from + sliceBlocks,
          reserveInRaw: '20',
          reserveOutRaw: '10',
          supplierInRaw: '15',
          supplierOutRaw: '8',
          cashAfterRaw: (cash + 10n).toString(),
        },
      ],
    }
    cash += 10n
    return row
  })
  return {
    study: CONTINUATION_STUDY,
    forecast: false,
    fromBlock: 1000,
    toBlock: 1000 + count * sliceBlocks,
    slices,
  }
}

function fixture({ baseline = 1000 + 80 * 256, horizon = 1, targetOffset = 3600 } = {}) {
  const parent = {
    sequence: 1,
    sha256: 'a'.repeat(64),
    baseline: { targetBlock: String(baseline), targetBlockAt: at(1_700_000_000) },
  }
  const common = {
    sequence: 1,
    sha256: 'b'.repeat(64),
    v1IssueSequence: 1,
    v1IssueSha256: parent.sha256,
    marketKey: 'aaveV3Usdc',
    holder,
    routeKey: 'aave',
    destination: 'pool',
    originalAsset: 'usdc',
  }
  const v2Issue = {
    ...common,
    cases: [
      { label: 'small', assetsRaw: '100', baselineStatus: 'success' },
      { label: 'large', assetsRaw: '1000', baselineStatus: 'covered_revert' },
    ],
  }
  const v3Issue = {
    ...common,
    sha256: 'c'.repeat(64),
    cases: [
      {
        label: 'fixed_1_usdc',
        assetsRaw: '1000000',
        status: 'measured',
        measurement: { baselineStatus: 'success' },
      },
    ],
  }
  const score = (issue, cases) => ({
    sequence: 1,
    issueSequence: 1,
    issueSha256: issue.sha256,
    holder,
    routeKey: issue.routeKey,
    destination: issue.destination,
    originalAsset: issue.originalAsset,
    horizonHours: horizon,
    status: 'measured',
    target: {
      targetBlock: String(baseline + horizon * 300),
      targetBlockAt: at(1_700_000_000 + targetOffset),
    },
    cases,
  })
  const v2Score = score(v2Issue, [
    {
      label: 'small',
      assetsRaw: '100',
      status: 'measured',
      outcome: 'simulated_withdraw_success',
      transition: 'remained_exitable',
    },
    {
      label: 'large',
      assetsRaw: '1000',
      status: 'measured',
      outcome: 'covered_withdraw_revert',
      transition: 'still_reverting',
    },
  ])
  const v3Score = score(v3Issue, [
    {
      label: 'fixed_1_usdc',
      assetsRaw: '1000000',
      status: 'measured',
      outcome: 'simulated_withdraw_success',
      transition: 'remained_exitable',
    },
  ])
  return {
    joined: joined(),
    parents: [parent],
    v2Issues: [v2Issue],
    v2Scores: [v2Score],
    v3Issues: [v3Issue],
    v3Scores: [v3Score],
  }
}

test('joins exact holder/Q cases to strictly prebaseline cash and keeps Q correlated', () => {
  const input = fixture()
  const result = scoreAaveV23PreissueFlow(input)
  const v2 = result.arms[0].horizons[0]
  const v3 = result.arms[1].horizons[0]
  assert.equal(v2.denominator.selectedEpisodes, 1)
  assert.equal(v2.denominator.selectedCorrelatedQCases, 2)
  assert.equal(v3.denominator.selectedCorrelatedQCases, 1)
  assert.equal(v2.selected[0].holder, holder)
  assert.equal(
    v2.selected[0].feature.latestFeatureBlock < input.parents[0].baseline.targetBlock,
    true,
  )
  assert.equal(v2.selected[0].cases[1].baselineStatus, 'covered_revert')
  assert.equal(v3.selected[0].cases[0].baselineStatus, 'success')
  assert.equal(result.forecastValidated, false)
  const before = JSON.stringify(result.arms.map((arm) => arm.horizons[0].selected[0].feature))
  const future = input.joined.slices.at(-1)
  future.grossReserveInRaw = '25'
  future.blockFlows[0].reserveInRaw = '25'
  future.cashAfterRaw = (BigInt(future.cashAfterRaw) + 5n).toString()
  future.blockFlows[0].cashAfterRaw = future.cashAfterRaw
  const after = scoreAaveV23PreissueFlow(input)
  assert.equal(JSON.stringify(after.arms.map((arm) => arm.horizons[0].selected[0].feature)), before)
})

test('abstains when verified cash frontier is short of baseline', () => {
  const input = fixture({ baseline: 1000 + 101 * 256 })
  const result = scoreAaveV23PreissueFlow(input)
  assert.equal(result.arms[0].horizons[0].denominator.unavailableCashFrontier, 1)
  assert.equal(result.arms[0].horizons[0].selected.length, 0)
  assert.equal(
    result.arms[0].horizons[0].abstentions[0].reason,
    'verified_cash_frontier_before_baseline',
  )
  input.v3Scores = []
  const dormant = scoreAaveV23PreissueFlow(input).arms[1]
  assert.equal(dormant.issueCoverage.baselineAheadOfVerifiedCash, 1)
  assert.equal(dormant.horizons.length, 0)
})

test('scores a sealed target beyond cash frontier when preissue history is complete', () => {
  const input = fixture()
  input.joined = joined(81)
  const horizon = scoreAaveV23PreissueFlow(input).arms[0].horizons[0]
  assert.equal(input.joined.toBlock < Number(input.v2Scores[0].target.targetBlock), true)
  assert.equal(horizon.selected.length, 1)
  assert.equal(horizon.denominator.unavailableCashFrontier, 0)
})

test('retains an older episode after newer slices evict it from the latest join', () => {
  const input = fixture()
  const endpoint = 1000 + 79 * 256
  const latest = joined(300)
  latest.slices = latest.slices.slice(-127)
  latest.fromBlock = latest.slices[0].fromExclusive
  input.joined = latest
  input.pinEndpoints = [endpoint]
  let replays = 0
  input.replayPinnedJoin = (throughBlock) => {
    assert.equal(throughBlock, endpoint)
    replays++
    return joined(79)
  }
  const scored = scoreAaveV23PreissueFlow(input)
  assert.equal(scored.arms[0].horizons[0].selected.length, 1)
  assert.equal(scored.arms[1].horizons[0].selected.length, 1)
  assert.equal(scored.arms[0].horizons[0].selected[0].featureJoin.toBlock, endpoint)
  assert.equal(scored.arms[0].horizons[0].selected[0].featureJoin.pinned, true)
  assert.equal(scored.source.pinnedReplayCount, 1)
  assert.equal(replays, 1)
})

test('abstains on target time mismatch and handles 48h and 168h windows', () => {
  const late = fixture({ targetOffset: 4000 })
  assert.equal(
    scoreAaveV23PreissueFlow(late).arms[0].horizons[0].denominator.targetTimingMismatch,
    1,
  )
  const twoDays = fixture({ horizon: 48, targetOffset: 48 * 3600 })
  assert.equal(scoreAaveV23PreissueFlow(twoDays).arms[0].horizons[0].selected.length, 1)
  const week = fixture({ horizon: 168, targetOffset: 168 * 3600 })
  const weekResult = scoreAaveV23PreissueFlow(week).arms[0].horizons[0]
  assert.equal(weekResult.denominator.unavailableFeature, 1)
  assert.equal(weekResult.abstentions[0].reason, 'no_complete_preissue_window')
})

test('rejects broken parent binding and cash accounting', () => {
  const input = fixture()
  input.v2Issues[0].v1IssueSha256 = '0'.repeat(64)
  assert.throws(() => scoreAaveV23PreissueFlow(input), /parent_binding/)
  const cash = fixture()
  cash.joined.slices[0].blockFlows[0].reserveOutRaw = '9'
  assert.throws(() => scoreAaveV23PreissueFlow(cash), /flow_cash|flow_totals/)
})

function rollingJoin(count, v1Boundary = 150, sliceBlocks = 256) {
  const result = joined(count, sliceBlocks)
  result.study = count <= v1Boundary ? V1_JOIN_STUDY : CONTINUATION_STUDY
  result.slices = result.slices.slice(-127)
  result.fromBlock = result.slices[0].fromExclusive
  return result
}

function archivePins(count, sliceBlocks = 256) {
  return Array.from({ length: count }, (_, index) => 1000 + (index + 1) * sliceBlocks)
}

test('168h crosses verified V2/V1 replay chunks and excludes postbaseline cash', () => {
  const baseline = 1000 + 278 * 256
  const input = fixture({ baseline, horizon: 168, targetOffset: 168 * 3600 })
  input.joined = rollingJoin(400)
  input.pinEndpoints = archivePins(400)
  const replayed = []
  input.replayPinnedJoin = (endpoint) => {
    replayed.push(endpoint)
    return rollingJoin((endpoint - 1000) / 256)
  }
  const first = scoreAaveV23PreissueFlow(input)
  const h168 = first.arms[0].horizons[0]
  assert.equal(h168.selected.length, 1)
  assert.equal(h168.selected[0].feature.historicalWindows >= 1, true)
  assert.equal(h168.selected[0].featureJoin.chunks > 1, true)
  assert.equal(
    replayed.some((endpoint) => endpoint <= 1000 + 150 * 256),
    true,
  )
  assert.equal(h168.selected[0].feature.latestFeatureBlock < baseline, true)
  assert.equal(first.forecastValidated, false)
  const feature = JSON.stringify(h168.selected[0].feature)
  const future = input.joined.slices.at(-1)
  future.grossReserveInRaw = '25'
  future.blockFlows[0].reserveInRaw = '25'
  future.cashAfterRaw = (BigInt(future.cashAfterRaw) + 5n).toString()
  future.blockFlows[0].cashAfterRaw = future.cashAfterRaw
  assert.equal(
    JSON.stringify(scoreAaveV23PreissueFlow(input).arms[0].horizons[0].selected[0].feature),
    feature,
  )
})

test('64-block archive slices supply four disjoint 168h windows beyond 16 replay chunks', () => {
  const sliceBlocks = 64
  const baseline = 1000 + 3160 * sliceBlocks
  const input = fixture({ baseline, horizon: 168, targetOffset: 168 * 3600 })
  input.joined = rollingJoin(3300, 1000, sliceBlocks)
  input.pinEndpoints = archivePins(3300, sliceBlocks)
  input.replayPinnedJoin = (endpoint) =>
    rollingJoin((endpoint - 1000) / sliceBlocks, 1000, sliceBlocks)
  const result = scoreAaveV23PreissueFlow(input)
  const h168 = result.arms[0].horizons[0]
  assert.equal(h168.selected.length, 1)
  assert.equal(h168.selected[0].feature.historicalWindows, 4)
  assert.equal(h168.selected[0].feature.referenceAdequacy, 'four_or_more_disjoint')
  assert.equal(h168.selected[0].featureJoin.chunks > 16, true)
  assert.equal(h168.selected[0].targetBlock - baseline, 50400)
  assert.equal(result.forecastValidated, false)
})

test('more than 64 distinct historical endpoints remain scoreable within bounded cache', () => {
  const input = fixture()
  input.joined = rollingJoin(300)
  input.pinEndpoints = archivePins(300)
  input.v3Issues = []
  input.v3Scores = []
  input.parents = []
  input.v2Issues = []
  input.v2Scores = []
  for (let index = 0; index < 70; index++) {
    const part = fixture({ baseline: 1000 + (30 + index * 2) * 256 })
    const parent = part.parents[0]
    const issue = part.v2Issues[0]
    const score = part.v2Scores[0]
    parent.sequence = index + 1
    parent.sha256 = index.toString(16).padStart(64, '0')
    issue.sequence = index + 1
    issue.v1IssueSequence = parent.sequence
    issue.v1IssueSha256 = parent.sha256
    issue.sha256 = (index + 100).toString(16).padStart(64, '0')
    score.sequence = index + 1
    score.issueSequence = issue.sequence
    score.issueSha256 = issue.sha256
    input.parents.push(parent)
    input.v2Issues.push(issue)
    input.v2Scores.push(score)
  }
  input.replayPinnedJoin = (endpoint) => rollingJoin((endpoint - 1000) / 256)
  const result = scoreAaveV23PreissueFlow(input)
  const h1 = result.arms[0].horizons[0]
  assert.equal(h1.denominator.selectedEpisodes, 70)
  assert.equal(result.source.pinnedReplayCount >= 70, true)
  assert.equal(result.source.pinnedCacheLimit, 8)
  assert.equal(result.forecastValidated, false)
})

test('missing older chunks abstain, while inconsistent verified chunks abort scoring', () => {
  const baseline = 1000 + 278 * 256
  const source = fixture({ baseline, horizon: 168, targetOffset: 168 * 3600 })
  source.joined = rollingJoin(400)
  source.pinEndpoints = archivePins(400)
  source.replayPinnedJoin = (endpoint) =>
    endpoint <= 1000 + 150 * 256 ? null : rollingJoin((endpoint - 1000) / 256)
  const missing = scoreAaveV23PreissueFlow(source).arms[0].horizons[0]
  assert.equal(missing.selected.length, 0)
  assert.equal(missing.abstentions[0].reason, 'historical_chunk_unavailable')
  source.replayPinnedJoin = (endpoint) => {
    const result = rollingJoin((endpoint - 1000) / 256)
    if (endpoint === 1000 + 273 * 256) result.slices.at(-1).toHash = hash(999999)
    return result
  }
  assert.throws(() => scoreAaveV23PreissueFlow(source), /aave_v23_flow_score_chunk_seam/)
})

test('a failed historical receipt verification aborts scoring instead of shrinking the denominator', () => {
  const input = fixture()
  input.joined = rollingJoin(300)
  input.pinEndpoints = archivePins(300)
  input.replayPinnedJoin = () => {
    throw Error('join_session_right_source_changed')
  }
  assert.throws(() => scoreAaveV23PreissueFlow(input), /join_session_right_source_changed/)
})
