// Offline, preissue-only Aave USDC flow proxy against exact-holder V1 scores.
// This is not an executable-exit, duration, or probability forecast.
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

import {
  replayJoin,
  STUDY as JOIN_V1,
  CONTINUATION_STUDY as JOIN_V2,
} from './aave-usdc-cash-direct-flow-join.mjs'
import { verifyPublicDirectIssues } from './carry-public-direct-exit-issue.mjs'
import { verifyPublicDirectScores } from './carry-public-direct-exit-score.mjs'

export const HORIZON_BLOCKS = Object.freeze({ 1: 300, 4: 1200, 24: 7200 })
export const MAX_FEATURE_AGE_BLOCKS = 256
export const MAX_SLICES = 127
export const MAX_ISSUES = 1000
export const MAX_SCORES = 5000
export const FROZEN_JOIN_THROUGH_BLOCK = 26099129
export const FROZEN_JOIN_THROUGH_HASH =
  '0x7690311d1ee62fdb65d6bbf1908020f86cb191107807d01246d0a860f2445d24'
const RAW = /^(0|[1-9][0-9]*)$/
const HASH = /^0x[0-9a-f]{64}$/
const fail = (okay, code) => {
  if (!okay) throw Error(`aave_v1_flow_score_${code}`)
}
const raw = (value) => {
  fail(typeof value === 'string' && RAW.test(value), 'amount_invalid')
  return BigInt(value)
}
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const utcMs = (value) => {
  const ms = Date.parse(value)
  fail(Number.isFinite(ms) && new Date(ms).toISOString() === value, 'header_time_invalid')
  return ms
}
const average = (values) => values.reduce((sum, value) => sum + value, 0n) / BigInt(values.length)
const maximum = (values) => values.reduce((max, value) => (value > max ? value : max), 0n)

function checkedSlices(joined) {
  fail(
    [JOIN_V1, JOIN_V2].includes(joined?.study) &&
      joined.forecast === false &&
      Array.isArray(joined.slices) &&
      joined.slices.length > 0 &&
      joined.slices.length <= MAX_SLICES,
    'join_invalid',
  )
  let expected = joined.fromBlock
  let previousHash = null
  let previousCash = null
  const slices = joined.slices.map((slice) => {
    fail(
      Number.isSafeInteger(slice.fromExclusive) &&
        Number.isSafeInteger(slice.toInclusive) &&
        slice.fromExclusive === expected &&
        slice.toInclusive > expected &&
        slice.toInclusive - expected <= 256 &&
        HASH.test(slice.fromHash) &&
        HASH.test(slice.toHash) &&
        (previousHash === null || slice.fromHash === previousHash),
      'join_gap',
    )
    const opening = raw(slice.cashBeforeRaw)
    const closing = raw(slice.cashAfterRaw)
    const reserveIn = raw(slice.grossReserveInRaw)
    const reserveOut = raw(slice.grossReserveOutRaw)
    const supplierIn = raw(slice.grossSupplierSupplyRaw)
    const supplierOut = raw(slice.grossSupplierWithdrawalRaw)
    fail(opening + reserveIn - reserveOut === closing, 'join_cash_identity')
    fail(previousCash === null || opening === previousCash, 'join_cash_continuity')
    fail(supplierIn <= reserveIn && supplierOut <= reserveOut, 'join_flow_identity')
    fail(
      Array.isArray(slice.blockFlows) &&
        slice.blockFlows.length <= slice.toInclusive - slice.fromExclusive,
      'exact_block_flows_missing',
    )
    let priorEventBlock = slice.fromExclusive
    let blockCash = opening
    let sumIn = 0n
    let sumOut = 0n
    let sumSupplierIn = 0n
    let sumSupplierOut = 0n
    const blockFlows = slice.blockFlows.map((event) => {
      const blockNumber = event.blockNumber
      fail(
        Number.isSafeInteger(blockNumber) &&
          blockNumber > priorEventBlock &&
          blockNumber <= slice.toInclusive &&
          HASH.test(event.blockHash) &&
          (blockNumber !== slice.toInclusive || event.blockHash === slice.toHash),
        'exact_block_flow_identity',
      )
      const eventIn = raw(event.reserveInRaw)
      const eventOut = raw(event.reserveOutRaw)
      const eventSupplierIn = raw(event.supplierInRaw)
      const eventSupplierOut = raw(event.supplierOutRaw)
      fail(eventSupplierIn <= eventIn && eventSupplierOut <= eventOut, 'exact_supplier_flow')
      blockCash += eventIn - eventOut
      fail(blockCash >= 0n && blockCash === raw(event.cashAfterRaw), 'exact_block_cash')
      sumIn += eventIn
      sumOut += eventOut
      sumSupplierIn += eventSupplierIn
      sumSupplierOut += eventSupplierOut
      priorEventBlock = blockNumber
      return {
        blockNumber,
        blockHash: event.blockHash,
        reserveIn: eventIn,
        reserveOut: eventOut,
        supplierIn: eventSupplierIn,
        supplierOut: eventSupplierOut,
      }
    })
    fail(
      blockCash === closing &&
        sumIn === reserveIn &&
        sumOut === reserveOut &&
        sumSupplierIn === supplierIn &&
        sumSupplierOut === supplierOut,
      'exact_block_flow_totals',
    )
    expected = slice.toInclusive
    previousHash = slice.toHash
    previousCash = closing
    return {
      from: slice.fromExclusive,
      to: slice.toInclusive,
      toHash: slice.toHash,
      cashAfter: closing,
      reserveIn,
      reserveOut,
      supplierIn,
      supplierOut,
      cashBefore: opening,
      blockFlows,
    }
  })
  fail(expected === joined.toBlock, 'join_endpoint')
  return slices
}

/** Exact nonoverlapping (start,end] block windows from verified eventful blocks. */
export function preissueFeatures(slices, baselineBlock, horizonHours) {
  const nominalBlocks = HORIZON_BLOCKS[horizonHours]
  fail(nominalBlocks !== undefined && Number.isSafeInteger(baselineBlock), 'feature_question')
  const prior = slices.filter((slice) => slice.to < baselineBlock)
  const endpoint = prior.at(-1)
  if (!endpoint || baselineBlock - endpoint.to > MAX_FEATURE_AGE_BLOCKS)
    return { status: 'preissue_cash_unavailable', reason: 'missing_or_stale_boundary' }
  fail(
    prior.every((slice) => Array.isArray(slice.blockFlows)),
    'exact_block_flows_missing',
  )
  const blocks = prior.flatMap((slice) => slice.blockFlows)
  const cashAt = (endBlock) => {
    const slice = prior.find((row) => row.from < endBlock && endBlock <= row.to)
    fail(slice, 'exact_cash_boundary_missing')
    return slice.blockFlows.reduce(
      (cash, event) =>
        event.blockNumber <= endBlock ? cash + event.reserveIn - event.reserveOut : cash,
      slice.cashBefore,
    )
  }
  const windows = []
  for (let end = endpoint.to; end - nominalBlocks >= prior[0].from; end -= nominalBlocks) {
    const start = end - nominalBlocks
    const included = blocks.filter((event) => event.blockNumber > start && event.blockNumber <= end)
    windows.push({
      from: start,
      to: end,
      spanBlocks: nominalBlocks,
      reserveIn: included.reduce((sum, row) => sum + row.reserveIn, 0n),
      reserveOut: included.reduce((sum, row) => sum + row.reserveOut, 0n),
      supplierIn: included.reduce((sum, row) => sum + row.supplierIn, 0n),
      supplierOut: included.reduce((sum, row) => sum + row.supplierOut, 0n),
      cashAtEnd: cashAt(end),
      // Interior quiet-block hashes are intentionally not inferred.
      endBlockHash: prior.find((slice) => slice.to === end)?.toHash ?? null,
    })
  }
  if (windows.length === 0)
    return { status: 'historical_windows_unavailable', reason: 'no_complete_preissue_window' }
  const field = (name) => {
    const values = windows.map((window) => window[name])
    return { expectedRaw: average(values).toString(), observedMaxRaw: maximum(values).toString() }
  }
  return {
    status: 'preissue_proxy_available',
    baselineBlock,
    latestFeatureBlock: endpoint.to,
    latestFeatureHash: endpoint.toHash,
    featureAgeBlocks: baselineBlock - endpoint.to,
    cashRaw: endpoint.cashAfter.toString(),
    nominalHorizonBlocks: nominalBlocks,
    historicalWindows: windows.length,
    referenceAdequacy: windows.length >= 4 ? 'four_or_more_disjoint' : 'sparse_less_than_four',
    observedWindowSpanBlocks: { minimum: nominalBlocks, maximum: nominalBlocks },
    rawWindows: windows.map((window) => ({
      fromExclusive: window.from,
      toInclusive: window.to,
      endBlockHash: window.endBlockHash,
      reserveInRaw: window.reserveIn.toString(),
      reserveOutRaw: window.reserveOut.toString(),
      supplierInRaw: window.supplierIn.toString(),
      supplierOutRaw: window.supplierOut.toString(),
      cashAtEndRaw: window.cashAtEnd.toString(),
    })),
    reserveIn: field('reserveIn'),
    reserveOut: field('reserveOut'),
    supplierIn: field('supplierIn'),
    supplierOut: field('supplierOut'),
    sourceWindowDigest: sha(
      windows.map((window) => [
        window.from,
        window.to,
        window.endBlockHash,
        ...[
          window.reserveIn,
          window.reserveOut,
          window.supplierIn,
          window.supplierOut,
          window.cashAtEnd,
        ].map(String),
      ]),
    ),
  }
}

function proxyForQ(feature, q) {
  const sourceCash = raw(feature.cashRaw)
  const expectedIn = raw(feature.reserveIn.expectedRaw)
  const maximumOut = raw(feature.reserveOut.observedMaxRaw)
  const margin = sourceCash + expectedIn - maximumOut - raw(q)
  return {
    qRaw: q,
    stressedAggregateCashAfterQRaw: margin.toString(),
    stressScenarioMarginNegative: margin < 0n,
    interpretation: 'aggregate_cash_proxy_not_holder_executable',
  }
}

function eligibleCases(issue, score) {
  return score.cases.filter((row) => {
    const original = issue.cases.find((candidate) => candidate.label === row.label)
    return (
      original?.status === 'measured' &&
      original.measurement?.status === 'success' &&
      original.assetsRaw === row.assetsRaw &&
      row.status === 'measured' &&
      ['exit_success', 'exit_revert_cause_unknown', 'holder_attrition'].includes(row.outcome)
    )
  })
}

export function scoreAaveV1PreissueFlow({ joined, issues, scores }) {
  const slices = checkedSlices(joined)
  fail(Array.isArray(issues) && issues.length <= MAX_ISSUES, 'issue_bound')
  fail(Array.isArray(scores) && scores.length <= MAX_SCORES, 'score_bound')
  const issueBySequence = new Map(issues.map((issue) => [issue.sequence, issue]))
  const aaveIssues = issues.filter((issue) => issue.marketKey === 'aaveV3Usdc')
  const aaveScores = scores.filter((score) => score.marketKey === 'aaveV3Usdc')
  const horizons = [1, 4, 24].map((horizonHours) => {
    const scored = aaveScores.filter((score) => score.horizonHours === horizonHours)
    const candidates = []
    const abstentions = []
    const denominators = {
      scoredEpisodes: scored.length,
      measuredSameHolderEpisodes: 0,
      measuredQCases: 0,
      preissueFeatureAvailableEpisodes: 0,
      preissueFeatureMissingEpisodes: 0,
      targetTimingMismatchAbstentions: 0,
      overlapExcludedEpisodes: 0,
      selectedDisjointEpisodes: 0,
      selectedCorrelatedQCases: 0,
      selectedExitSuccessCases: 0,
      selectedRevertCases: 0,
      selectedAttritionCases: 0,
      selectedNegativeStressMarginCases: 0,
      selectedNegativeStressWithExitSuccessCases: 0,
      selectedEpisodesWithNegativeStressAndExitSuccess: 0,
      selectedEpisodesWithAnyRevert: 0,
      selectedEpisodesWithAnyAttrition: 0,
      selectedTargetsWithinJoinedFlow: 0,
      selectedTargetsAfterJoinedFlow: 0,
    }
    for (const score of scored) {
      const issue = issueBySequence.get(score.issueSequence)
      fail(
        issue?.marketKey === 'aaveV3Usdc' &&
          score.issueSha256 === issue.sha256 &&
          score.holder === issue.candidate?.holder &&
          score.routeKey === issue.routeKey &&
          score.destination === issue.destination &&
          score.originalAsset === issue.originalAsset,
        'score_binding',
      )
      const baselineBlock = Number(issue.baseline?.targetBlock)
      const targetBlock = Number(score.target?.targetBlock)
      const baselineAt = issue.baseline?.targetBlockAt
      const targetAt = score.target?.targetBlockAt
      const cases = eligibleCases(issue, score)
      if (!cases.length) continue
      fail(
        Number.isSafeInteger(baselineBlock) &&
          Number.isSafeInteger(targetBlock) &&
          targetBlock > baselineBlock,
        'episode_blocks',
      )
      const elapsedMs = utcMs(targetAt) - utcMs(baselineAt)
      fail(elapsedMs > 0 && elapsedMs % 1000 === 0, 'episode_time')
      denominators.measuredSameHolderEpisodes++
      denominators.measuredQCases += cases.length
      const feature = preissueFeatures(slices, baselineBlock, horizonHours)
      if (feature.status !== 'preissue_proxy_available') {
        denominators.preissueFeatureMissingEpisodes++
        continue
      }
      fail(feature.latestFeatureBlock < baselineBlock, 'feature_leakage')
      denominators.preissueFeatureAvailableEpisodes++
      const nominalSeconds = horizonHours * 3600
      if (Math.abs(elapsedMs / 1000 - nominalSeconds) > nominalSeconds * 0.05) {
        denominators.targetTimingMismatchAbstentions++
        abstentions.push({
          reason: 'observed_target_more_than_five_percent_from_nominal_horizon',
          issueSequence: issue.sequence,
          scoreSequence: score.sequence,
          baselineBlock,
          targetBlock,
          baselineBlockAt: baselineAt,
          targetBlockAt: targetAt,
          elapsedSeconds: elapsedMs / 1000,
          targetLagVsNominalSeconds: elapsedMs / 1000 - nominalSeconds,
          feature,
        })
        continue
      }
      candidates.push({
        issue,
        score,
        baselineBlock,
        targetBlock,
        baselineAt,
        targetAt,
        elapsedMs,
        cases,
        feature,
      })
    }
    candidates.sort(
      (a, b) => a.baselineBlock - b.baselineBlock || a.issue.sequence - b.issue.sequence,
    )
    const selected = []
    let priorTarget = -1
    for (const episode of candidates) {
      if (episode.baselineBlock <= priorTarget) {
        denominators.overlapExcludedEpisodes++
        continue
      }
      const outcomes = episode.cases.map((row) => ({
        label: row.label,
        outcome: row.outcome,
        ...proxyForQ(episode.feature, row.assetsRaw),
      }))
      denominators.selectedDisjointEpisodes++
      if (episode.targetBlock <= joined.toBlock) denominators.selectedTargetsWithinJoinedFlow++
      else denominators.selectedTargetsAfterJoinedFlow++
      denominators.selectedCorrelatedQCases += outcomes.length
      denominators.selectedExitSuccessCases += outcomes.filter(
        (row) => row.outcome === 'exit_success',
      ).length
      denominators.selectedRevertCases += outcomes.filter(
        (row) => row.outcome === 'exit_revert_cause_unknown',
      ).length
      denominators.selectedAttritionCases += outcomes.filter(
        (row) => row.outcome === 'holder_attrition',
      ).length
      denominators.selectedNegativeStressMarginCases += outcomes.filter(
        (row) => row.stressScenarioMarginNegative,
      ).length
      const negativeStressSuccesses = outcomes.filter(
        (row) => row.stressScenarioMarginNegative && row.outcome === 'exit_success',
      ).length
      denominators.selectedNegativeStressWithExitSuccessCases += negativeStressSuccesses
      if (negativeStressSuccesses > 0)
        denominators.selectedEpisodesWithNegativeStressAndExitSuccess++
      if (outcomes.some((row) => row.outcome === 'exit_revert_cause_unknown'))
        denominators.selectedEpisodesWithAnyRevert++
      if (outcomes.some((row) => row.outcome === 'holder_attrition'))
        denominators.selectedEpisodesWithAnyAttrition++
      selected.push({
        issueSequence: episode.issue.sequence,
        issueSha256: episode.issue.sha256,
        scoreSequence: episode.score.sequence,
        scoreSha256: episode.score.sha256,
        baselineBlock: episode.baselineBlock,
        targetBlock: episode.targetBlock,
        baselineBlockAt: episode.baselineAt,
        targetBlockAt: episode.targetAt,
        elapsedSeconds: episode.elapsedMs / 1000,
        targetLagVsNominalSeconds: episode.elapsedMs / 1000 - horizonHours * 3600,
        feature: episode.feature,
        outcomes,
      })
      priorTarget = episode.targetBlock
    }
    return {
      horizonHours,
      denominators,
      selected,
      abstentions,
      disjointTimeEpisodes: selected.length,
      statisticalIndependenceValidated: false,
      warning:
        'Q cases within one holder episode and repeat-holder episodes can be correlated; outcomes use observed target times, not exact nominal calendar horizons.',
    }
  })
  const labels = horizons.reduce(
    (totals, horizon) => {
      totals.success += horizon.denominators.selectedExitSuccessCases
      totals.revert += horizon.denominators.selectedRevertCases
      totals.attrition += horizon.denominators.selectedAttritionCases
      return totals
    },
    { success: 0, revert: 0, attrition: 0 },
  )
  return {
    study: 'aave_usdc_v1_holder_flow_offline_score_v1',
    source: {
      joinedStudy: joined.study,
      joinedFromBlock: joined.fromBlock,
      joinedToBlock: joined.toBlock,
      joinedToHash: slices.at(-1).toHash,
      joinedSliceCount: slices.length,
    },
    issueDenominator: { allVerified: issues.length, aaveUsdc: aaveIssues.length },
    scoreDenominator: { allVerified: scores.length, aaveUsdc: aaveScores.length },
    leakageGuard:
      'every feature window and source cash boundary end strictly before its frozen issue baseline block',
    flowCoverage:
      'joined cash and gross flow are used only before each issue baseline; later exact-Q labels come from the verified score ledger, including targets after the frozen flow endpoint',
    horizonTiming:
      'historical flow windows use exact 300/1200/7200-block spans with partial archive slices; target elapsed time differing from nominal calendar H by over 5% abstains; outcomes remain at the sealed later target block',
    selection:
      'greedy chronological nonoverlap within each horizon; all Q cases in an issue remain one correlated episode',
    crossHorizonIndependenceValidated: false,
    labels,
    forecastValidated: false,
    validationReason:
      labels.revert + labels.attrition === 0
        ? 'success_only_no_failure_calibration'
        : 'research_only_unvalidated',
    holderExecutableExit: false,
    horizons,
  }
}

export async function readVerifiedAaveV1PreissueFlowScore() {
  const [issues, scores] = await Promise.all([
    verifyPublicDirectIssues(),
    verifyPublicDirectScores(),
  ])
  const joined = replayJoin({ throughBlock: FROZEN_JOIN_THROUGH_BLOCK })
  fail(
    joined.toBlock === FROZEN_JOIN_THROUGH_BLOCK &&
      joined.slices.at(-1)?.toHash === FROZEN_JOIN_THROUGH_HASH,
    'frozen_join_endpoint_changed',
  )
  return scoreAaveV1PreissueFlow({ joined, issues, scores })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  readVerifiedAaveV1PreissueFlowScore()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${String(error?.message ?? error)}\n`)
      process.exitCode = 1
    })
}
