import assert from 'node:assert/strict'
import test from 'node:test'

import { CONTINUATION_STUDY } from './aave-usdc-cash-direct-flow-join.mjs'
import {
  preissueFeatures,
  scoreAaveV1PreissueFlow,
} from './aave-usdc-v1-holder-flow-offline-score.mjs'

const hash = (n) => `0x${n.toString(16).padStart(64, '0')}`
const holder = '0x1111111111111111111111111111111111111111'
const destination = '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c'
const asset = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const routeKey = 'USDC → supply on Aave V3'

function joined(count = 100, width = 100) {
  let cash = 1000n
  const slices = []
  for (let i = 0; i < count; i++) {
    const from = 1000 + i * width
    slices.push({
      fromExclusive: from,
      toInclusive: from + width,
      fromHash: hash(from),
      toHash: hash(from + width),
      cashBeforeRaw: cash.toString(),
      cashAfterRaw: (cash + 10n).toString(),
      grossReserveInRaw: '20',
      grossReserveOutRaw: '10',
      grossSupplierSupplyRaw: '15',
      grossSupplierWithdrawalRaw: '8',
      blockFlows: [
        {
          blockNumber: from + width,
          blockHash: hash(from + width),
          reserveInRaw: '20',
          reserveOutRaw: '10',
          supplierInRaw: '15',
          supplierOutRaw: '8',
          cashAfterRaw: (cash + 10n).toString(),
        },
      ],
    })
    cash += 10n
  }
  return {
    study: CONTINUATION_STUDY,
    forecast: false,
    fromBlock: 1000,
    toBlock: 1000 + count * width,
    slices,
  }
}

function issue(sequence, block) {
  return {
    sequence,
    sha256: 'a'.repeat(64),
    marketKey: 'aaveV3Usdc',
    routeKey,
    destination,
    originalAsset: asset,
    candidate: { holder },
    baseline: { targetBlock: String(block), targetBlockAt: new Date(block * 12000).toISOString() },
    cases: [
      { label: 'small', status: 'measured', assetsRaw: '1', measurement: { status: 'success' } },
      {
        label: 'large',
        status: 'measured',
        assetsRaw: '999999',
        measurement: { status: 'success' },
      },
    ],
  }
}

function score(issueRow, sequence, horizonHours, target, largeOutcome = 'exit_success') {
  return {
    sequence,
    issueSequence: issueRow.sequence,
    issueSha256: issueRow.sha256,
    marketKey: issueRow.marketKey,
    routeKey,
    destination,
    originalAsset: asset,
    holder,
    horizonHours,
    target: { targetBlock: String(target), targetBlockAt: new Date(target * 12000).toISOString() },
    cases: [
      { label: 'small', status: 'measured', assetsRaw: '1', outcome: 'exit_success' },
      { label: 'large', status: 'measured', assetsRaw: '999999', outcome: largeOutcome },
    ],
  }
}

test('preissue features use disjoint historical windows and exclude postissue cash', () => {
  const source = joined()
  const first = preissueFeatures(
    source.slices.map((row) => ({
      from: row.fromExclusive,
      to: row.toInclusive,
      toHash: row.toHash,
      cashAfter: BigInt(row.cashAfterRaw),
      cashBefore: BigInt(row.cashBeforeRaw),
      reserveIn: BigInt(row.grossReserveInRaw),
      reserveOut: BigInt(row.grossReserveOutRaw),
      supplierIn: BigInt(row.grossSupplierSupplyRaw),
      supplierOut: BigInt(row.grossSupplierWithdrawalRaw),
      blockFlows: row.blockFlows.map((event) => ({
        blockNumber: event.blockNumber,
        blockHash: event.blockHash,
        reserveIn: BigInt(event.reserveInRaw),
        reserveOut: BigInt(event.reserveOutRaw),
        supplierIn: BigInt(event.supplierInRaw),
        supplierOut: BigInt(event.supplierOutRaw),
      })),
    })),
    9001,
    1,
  )
  assert.equal(first.status, 'preissue_proxy_available')
  assert.equal(first.latestFeatureBlock, 9000)
  assert.equal(first.reserveOut.expectedRaw, '30')
  assert.equal(first.supplierOut.observedMaxRaw, '24')
  assert.ok(first.historicalWindows > 1)
})

test('scores disjoint episodes, keeps correlated Q cases together, and remains unvalidated', () => {
  const issues = [issue(1, 9001), issue(2, 9201), issue(3, 9601)]
  const scores = [
    score(issues[0], 1, 1, 9300),
    score(issues[1], 2, 1, 9500),
    score(issues[2], 3, 1, 9900),
    score(issues[0], 4, 24, 16201),
  ]
  const result = scoreAaveV1PreissueFlow({ joined: joined(), issues, scores })
  const h1 = result.horizons[0]
  assert.equal(h1.denominators.measuredSameHolderEpisodes, 3)
  assert.equal(h1.denominators.overlapExcludedEpisodes, 1)
  assert.equal(h1.denominators.selectedDisjointEpisodes, 2)
  assert.equal(h1.disjointTimeEpisodes, 2)
  assert.equal(h1.statisticalIndependenceValidated, false)
  assert.equal(issues[0].candidate.holder, issues[2].candidate.holder)
  assert.equal(h1.denominators.selectedCorrelatedQCases, 4)
  assert.equal(h1.selected[0].feature.latestFeatureBlock, 9000)
  assert.equal(h1.selected[0].elapsedSeconds, (9300 - 9001) * 12)
  assert.equal(h1.selected[0].targetLagVsNominalSeconds, (9300 - 9001) * 12 - 3600)
  assert.equal(h1.selected[0].outcomes[1].stressScenarioMarginNegative, true)
  assert.ok(h1.denominators.selectedNegativeStressWithExitSuccessCases > 0)
  assert.ok(h1.denominators.selectedEpisodesWithNegativeStressAndExitSuccess > 0)
  assert.equal(result.horizons[2].denominators.selectedDisjointEpisodes, 1)
  assert.equal(result.horizons[2].denominators.selectedTargetsAfterJoinedFlow, 1)
  assert.equal(result.horizons[2].denominators.selectedTargetsWithinJoinedFlow, 0)
  assert.equal(result.horizons[2].selected[0].feature.referenceAdequacy, 'sparse_less_than_four')
  assert.equal(result.labels.revert, 0)
  assert.equal(result.validationReason, 'success_only_no_failure_calibration')
  assert.equal(result.forecastValidated, false)
  assert.equal(result.holderExecutableExit, false)
})

test('future slice mutation cannot alter frozen preissue features; stale boundary is censored', () => {
  const source = joined()
  const original = scoreAaveV1PreissueFlow({
    joined: source,
    issues: [issue(1, 9001)],
    scores: [score(issue(1, 9001), 1, 1, 9300)],
  })
  let changedCash = BigInt(source.slices.find((row) => row.fromExclusive === 9000).cashBeforeRaw)
  for (const slice of source.slices.filter((row) => row.fromExclusive >= 9000)) {
    slice.cashBeforeRaw = changedCash.toString()
    slice.grossReserveInRaw = '1020'
    changedCash += 1010n
    slice.cashAfterRaw = changedCash.toString()
    slice.blockFlows[0].reserveInRaw = '1020'
    slice.blockFlows[0].cashAfterRaw = changedCash.toString()
  }
  const changed = scoreAaveV1PreissueFlow({
    joined: source,
    issues: [issue(1, 9001)],
    scores: [score(issue(1, 9001), 1, 1, 9300)],
  })
  assert.deepEqual(
    changed.horizons[0].selected[0].feature,
    original.horizons[0].selected[0].feature,
  )
  const stale = scoreAaveV1PreissueFlow({
    joined: joined(20),
    issues: [issue(1, 9001)],
    scores: [score(issue(1, 9001), 1, 1, 9300)],
  })
  assert.equal(stale.horizons[0].denominators.preissueFeatureMissingEpisodes, 1)
  assert.equal(stale.horizons[0].denominators.selectedDisjointEpisodes, 0)
})

test('exact H1 windows use partial 256-block slices and exact end-block cash', () => {
  const sourceIssue = issue(1, 9001)
  const result = scoreAaveV1PreissueFlow({
    joined: joined(100, 256),
    issues: [sourceIssue],
    scores: [score(sourceIssue, 1, 1, 9301)],
  })
  const h1 = result.horizons[0]
  assert.equal(h1.disjointTimeEpisodes, 1)
  assert.equal(h1.selected[0].feature.rawWindows[0].toInclusive, 8936)
  assert.equal(h1.selected[0].feature.rawWindows[0].fromExclusive, 8636)
  assert.equal(h1.selected[0].feature.rawWindows[0].reserveOutRaw, '20')
  assert.equal(h1.selected[0].feature.rawWindows[0].cashAtEndRaw, '1310')
  assert.equal(h1.selected[0].feature.rawWindows[1].endBlockHash, null)
})

test('matched block windows abstain when the observed target is late', () => {
  const sourceIssue = issue(1, 9001)
  const result = scoreAaveV1PreissueFlow({
    joined: joined(),
    issues: [sourceIssue],
    scores: [score(sourceIssue, 1, 1, 9393)],
  })
  const h1 = result.horizons[0]
  assert.equal(h1.denominators.targetTimingMismatchAbstentions, 1)
  assert.equal(h1.disjointTimeEpisodes, 0)
  assert.equal(h1.abstentions[0].elapsedSeconds, 392 * 12)
})

test('a later exact-Q revert is counted without promoting forecast validation', () => {
  const sourceIssue = issue(1, 9001)
  const result = scoreAaveV1PreissueFlow({
    joined: joined(),
    issues: [sourceIssue],
    scores: [score(sourceIssue, 1, 1, 9300, 'exit_revert_cause_unknown')],
  })
  assert.equal(result.horizons[0].denominators.selectedExitSuccessCases, 1)
  assert.equal(result.horizons[0].denominators.selectedRevertCases, 1)
  assert.equal(result.horizons[0].denominators.selectedEpisodesWithAnyRevert, 1)
  assert.equal(result.labels.revert, 1)
  assert.equal(result.forecastValidated, false)
})
