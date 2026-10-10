// Read-only, preissue cash proxy for the prospective exact-holder V2/V3 arms.
// Correlated Q labels and simulated calls do not validate an exit forecast.
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

import {
  CONTINUATION_STUDY,
  STUDY as V1_JOIN_STUDY,
  createVerifiedJoinSession,
} from './aave-usdc-cash-direct-flow-join.mjs'
import { verifyPublicDirectIssues } from './carry-public-direct-exit-issue.mjs'
import { verifyAaveFrozenQIssues } from './carry-public-aave-usdc-fixed-q-v2-issue.mjs'
import { verifyAaveFrozenQScores } from './carry-public-aave-usdc-fixed-q-v2-score.mjs'
import { verifyAaveCommonIssues } from './carry-public-aave-usdc-common-q-v3-issue.mjs'
import { verifyAaveCommonQScores } from './carry-public-aave-usdc-common-q-v3-score.mjs'

const MAX_SLICES = 127
const MAX_ROWS = 5000
const MAX_PINNED_CACHE = 8
// Eight 168h windows at the V2 archive's 64-block slice size need ~50 joins.
const MAX_FEATURE_REPLAYS = 64
const MAX_FEATURE_WINDOWS = 8
const MAX_PIN_ENDPOINTS = 65536
const HORIZON_BLOCKS = Object.freeze({ 1: 300, 4: 1200, 24: 7200, 48: 14400, 168: 50400 })
const RAW = /^(0|[1-9][0-9]*)$/
const fail = (condition, reason) => {
  if (!condition) throw Error(`aave_v23_flow_score_${reason}`)
}
const amount = (value) => {
  fail(typeof value === 'string' && RAW.test(value), 'raw_amount')
  return BigInt(value)
}
const block = (value) => {
  const n = Number(value)
  fail(Number.isSafeInteger(n) && n >= 0 && String(n) === String(value), 'block')
  return n
}
const time = (value) => {
  const ms = Date.parse(value)
  fail(Number.isFinite(ms) && new Date(ms).toISOString() === value, 'time')
  return ms
}

function featureSlices(joined) {
  fail(
    (joined?.study === CONTINUATION_STUDY || joined?.study === V1_JOIN_STUDY) &&
      joined.forecast === false &&
      Array.isArray(joined.slices) &&
      joined.slices.length > 0 &&
      joined.slices.length <= MAX_SLICES,
    'join_invalid',
  )
  let next = block(joined.fromBlock)
  let cash = null
  let hash = null
  const slices = joined.slices.map((slice) => {
    const from = block(slice.fromExclusive)
    const to = block(slice.toInclusive)
    const before = amount(slice.cashBeforeRaw)
    const after = amount(slice.cashAfterRaw)
    fail(/^0x[0-9a-f]{64}$/.test(slice.fromHash) && /^0x[0-9a-f]{64}$/.test(slice.toHash), 'hash')
    fail(from === next && to > from && to - from <= 256, 'join_gap')
    fail(cash === null || cash === before, 'cash_gap')
    fail(hash === null || hash === slice.fromHash, 'hash_gap')
    fail(
      before + amount(slice.grossReserveInRaw) - amount(slice.grossReserveOutRaw) === after &&
        amount(slice.grossSupplierSupplyRaw) <= amount(slice.grossReserveInRaw) &&
        amount(slice.grossSupplierWithdrawalRaw) <= amount(slice.grossReserveOutRaw),
      'cash_identity',
    )
    fail(Array.isArray(slice.blockFlows) && slice.blockFlows.length <= to - from, 'flow_bound')
    let running = before
    let prior = from
    const totals = { reserveIn: 0n, reserveOut: 0n, supplierIn: 0n, supplierOut: 0n }
    const blockFlows = slice.blockFlows.map((row) => {
      const at = block(row.blockNumber)
      fail(at > prior && at <= to, 'flow_order')
      const event = {
        blockNumber: at,
        reserveIn: amount(row.reserveInRaw),
        reserveOut: amount(row.reserveOutRaw),
        supplierIn: amount(row.supplierInRaw),
        supplierOut: amount(row.supplierOutRaw),
      }
      fail(
        event.supplierIn <= event.reserveIn && event.supplierOut <= event.reserveOut,
        'supplier_flow',
      )
      for (const field of Object.keys(totals)) totals[field] += event[field]
      running += event.reserveIn - event.reserveOut
      fail(running >= 0n && running === amount(row.cashAfterRaw), 'flow_cash')
      prior = at
      return event
    })
    fail(
      running === after &&
        totals.reserveIn === amount(slice.grossReserveInRaw) &&
        totals.reserveOut === amount(slice.grossReserveOutRaw) &&
        totals.supplierIn === amount(slice.grossSupplierSupplyRaw) &&
        totals.supplierOut === amount(slice.grossSupplierWithdrawalRaw),
      'flow_totals',
    )
    next = to
    cash = after
    hash = slice.toHash
    return {
      from,
      to,
      fromHash: slice.fromHash,
      toHash: hash,
      cashBefore: before,
      cashAfter: after,
      blockFlows,
    }
  })
  fail(next === block(joined.toBlock), 'join_endpoint')
  return slices
}

function checkRows(rows, name) {
  fail(Array.isArray(rows) && rows.length <= MAX_ROWS, `${name}_bound`)
  return rows
}

function featureAccumulator(endpoint, baselineBlock, horizonHours) {
  const width = HORIZON_BLOCKS[horizonHours]
  fail(width && Number.isSafeInteger(baselineBlock), 'feature_question')
  if (!endpoint || baselineBlock - endpoint.to > 256)
    return {
      unavailable: { status: 'preissue_cash_unavailable', reason: 'missing_or_stale_boundary' },
    }
  const windows = Array.from({ length: MAX_FEATURE_WINDOWS }, (_, index) => ({
    fromExclusive: endpoint.to - (index + 1) * width,
    toInclusive: endpoint.to - index * width,
    endBlockHash: null,
    reserveIn: 0n,
    reserveOut: 0n,
    supplierIn: 0n,
    supplierOut: 0n,
    cashAtEnd: null,
  }))
  let oldestFrom = endpoint.to
  let nextTo = endpoint.to
  let nextHash = endpoint.toHash
  let nextCash = endpoint.cashAfter
  return {
    endpoint,
    windows,
    get oldestFrom() {
      return oldestFrom
    },
    get complete() {
      return oldestFrom <= windows.at(-1).fromExclusive
    },
    addChunk(chunk) {
      for (let index = chunk.length - 1; index >= 0; index--) {
        const slice = chunk[index]
        fail(
          slice.to === nextTo && slice.toHash === nextHash && slice.cashAfter === nextCash,
          'chunk_seam',
        )
        for (const window of windows) {
          if (
            window.cashAtEnd !== null ||
            !(slice.from < window.toInclusive && window.toInclusive <= slice.to)
          )
            continue
          let cash = slice.cashBefore
          for (const event of slice.blockFlows)
            if (event.blockNumber <= window.toInclusive) cash += event.reserveIn - event.reserveOut
          window.cashAtEnd = cash
          window.endBlockHash = slice.to === window.toInclusive ? slice.toHash : null
        }
        for (const event of slice.blockFlows) {
          const distance = endpoint.to - event.blockNumber
          const window = windows[Math.floor(distance / width)]
          if (!window || distance < 0) continue
          for (const field of ['reserveIn', 'reserveOut', 'supplierIn', 'supplierOut'])
            window[field] += event[field]
        }
        nextTo = slice.from
        nextHash = slice.fromHash
        nextCash = slice.cashBefore
        oldestFrom = slice.from
      }
    },
  }
}

function finishFeatures(acc, baselineBlock, horizonHours) {
  if (acc.unavailable) return acc.unavailable
  const width = HORIZON_BLOCKS[horizonHours]
  const endpoint = acc.endpoint
  const windows = acc.windows
    .filter((window) => window.fromExclusive >= acc.oldestFrom)
    .map((window) => {
      fail(window.cashAtEnd !== null, 'window_boundary')
      return {
        fromExclusive: window.fromExclusive,
        toInclusive: window.toInclusive,
        endBlockHash: window.endBlockHash,
        reserveInRaw: window.reserveIn.toString(),
        reserveOutRaw: window.reserveOut.toString(),
        supplierInRaw: window.supplierIn.toString(),
        supplierOutRaw: window.supplierOut.toString(),
        cashAtEndRaw: window.cashAtEnd.toString(),
      }
    })
  if (!windows.length)
    return { status: 'historical_windows_unavailable', reason: 'no_complete_preissue_window' }
  const field = (name) => {
    const values = windows.map((window) => amount(window[`${name}Raw`]))
    return {
      expectedRaw: (values.reduce((a, b) => a + b, 0n) / BigInt(values.length)).toString(),
      observedMaxRaw: values.reduce((a, b) => (a > b ? a : b), 0n).toString(),
    }
  }
  return {
    status: 'preissue_proxy_available',
    baselineBlock,
    latestFeatureBlock: endpoint.to,
    latestFeatureHash: endpoint.toHash,
    featureAgeBlocks: baselineBlock - endpoint.to,
    cashRaw: endpoint.cashAfter.toString(),
    nominalHorizonBlocks: width,
    historicalWindows: windows.length,
    referenceAdequacy: windows.length >= 4 ? 'four_or_more_disjoint' : 'sparse_less_than_four',
    rawWindows: windows,
    reserveIn: field('reserveIn'),
    reserveOut: field('reserveOut'),
    supplierIn: field('supplierIn'),
    supplierOut: field('supplierOut'),
    sourceWindowDigest: createHash('sha256').update(JSON.stringify(windows)).digest('hex'),
  }
}

export function preissueV23Features(slices, baselineBlock, horizonHours) {
  const prior = slices.filter((slice) => slice.to < baselineBlock)
  const acc = featureAccumulator(prior.at(-1), baselineBlock, horizonHours)
  if (!acc.unavailable) acc.addChunk(prior)
  return finishFeatures(acc, baselineBlock, horizonHours)
}

/** Inputs to this pure function must come from the verified local ledgers. */
export function scoreAaveV23PreissueFlow({
  joined,
  parents,
  v2Issues,
  v2Scores,
  v3Issues,
  v3Scores,
  pinEndpoints = [],
  replayPinnedJoin = null,
}) {
  const slices = featureSlices(joined)
  fail(
    Array.isArray(pinEndpoints) && pinEndpoints.length <= MAX_PIN_ENDPOINTS,
    'pin_endpoint_bound',
  )
  for (let index = 0; index < pinEndpoints.length; index++)
    fail(
      Number.isSafeInteger(pinEndpoints[index]) &&
        pinEndpoints[index] <= joined.toBlock &&
        (index === 0 || pinEndpoints[index] > pinEndpoints[index - 1]),
      'pin_endpoint_order',
    )
  const pinned = new Map()
  const pinnedReplayCount = { count: 0 }
  const pinBefore = (baselineBlock) => {
    let low = 0
    let high = pinEndpoints.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (pinEndpoints[middle] < baselineBlock) low = middle + 1
      else high = middle
    }
    return pinEndpoints[low - 1] ?? null
  }
  const getHistorical = (endpoint) => {
    if (pinned.has(endpoint)) {
      const value = pinned.get(endpoint)
      pinned.delete(endpoint)
      pinned.set(endpoint, value)
      return value
    }
    if (typeof replayPinnedJoin !== 'function') return null
    const historical = replayPinnedJoin(endpoint)
    if (historical === null || historical === undefined) return null
    fail(historical.toBlock === endpoint, 'pinned_join_endpoint')
    const checked = { fromBlock: historical.fromBlock, slices: featureSlices(historical) }
    pinned.set(endpoint, checked)
    if (pinned.size > MAX_PINNED_CACHE) pinned.delete(pinned.keys().next().value)
    pinnedReplayCount.count++
    return checked
  }
  const featureAt = (baselineBlock, horizonHours) => {
    const latestPrebaseline = [...slices].reverse().find((slice) => slice.to < baselineBlock)
    const endpoint = pinBefore(baselineBlock) ?? latestPrebaseline?.to ?? null
    if (endpoint === null)
      return {
        feature: { status: 'historical_windows_unavailable', reason: 'pinned_window_unavailable' },
        source: null,
      }
    const useLatest = slices[0].from < endpoint && endpoint <= slices.at(-1).to
    let chunk = useLatest
      ? slices.filter((slice) => slice.to <= endpoint)
      : getHistorical(endpoint)?.slices
    if (!chunk?.length || chunk.at(-1).to !== endpoint)
      return {
        feature: {
          status: 'historical_windows_unavailable',
          reason: 'historical_chunk_unavailable',
        },
        source: null,
      }
    const acc = featureAccumulator(chunk.at(-1), baselineBlock, horizonHours)
    if (acc.unavailable) return { feature: acc.unavailable, source: null }
    let chunks = 0
    let fromBlock = endpoint
    while (chunk) {
      // Inconsistent verified chunks are an integrity failure, not missing
      // coverage that may silently remove a hard episode from the denominator.
      acc.addChunk(chunk)
      fromBlock = acc.oldestFrom
      chunks++
      if (acc.complete) break
      const earlier = pinBefore(fromBlock + 1)
      if (earlier !== fromBlock || typeof replayPinnedJoin !== 'function') break
      if (chunks >= MAX_FEATURE_REPLAYS)
        return {
          feature: { status: 'historical_windows_unavailable', reason: 'feature_replay_bound' },
          source: null,
        }
      chunk = getHistorical(fromBlock)?.slices
      if (!chunk?.length)
        return {
          feature: {
            status: 'historical_windows_unavailable',
            reason: 'historical_chunk_unavailable',
          },
          source: null,
        }
      fail(chunk.at(-1).to === fromBlock && chunk[0].from < fromBlock, 'historical_chunk_range')
    }
    return {
      feature: finishFeatures(acc, baselineBlock, horizonHours),
      source: { fromBlock, toBlock: endpoint, pinned: !useLatest || chunks > 1, chunks },
    }
  }
  for (const [name, rows] of Object.entries({ parents, v2Issues, v2Scores, v3Issues, v3Scores }))
    checkRows(rows, name)
  const arms = [
    { version: 'frozen_q_v2', issues: v2Issues, scores: v2Scores },
    { version: 'common_q_v3', issues: v3Issues, scores: v3Scores },
  ]
  const results = arms.map(({ version, issues, scores }) => {
    const issueCoverage = {
      issueCount: issues.length,
      baselineReached: 0,
      baselineAheadOfVerifiedCash: 0,
    }
    for (const issue of issues) {
      const parent = parents[issue.v1IssueSequence - 1]
      fail(parent && issue.v1IssueSha256 === parent.sha256, 'parent_binding')
      if (joined.toBlock < block(parent.baseline.targetBlock))
        issueCoverage.baselineAheadOfVerifiedCash++
      else issueCoverage.baselineReached++
    }
    const horizons = [...new Set(scores.map((row) => row.horizonHours))].sort((a, b) => a - b)
    const byHorizon = horizons.map((horizonHours) => {
      fail(HORIZON_BLOCKS[horizonHours], 'horizon')
      const candidates = []
      const abstentions = []
      const denominator = {
        scores: 0,
        measuredEpisodes: 0,
        correlatedQCases: 0,
        unavailableCashFrontier: 0,
        unavailableFeature: 0,
        censored: 0,
        targetTimingMismatch: 0,
        overlapExcluded: 0,
        selectedEpisodes: 0,
        selectedCorrelatedQCases: 0,
      }
      for (const score of scores.filter((row) => row.horizonHours === horizonHours)) {
        denominator.scores++
        const issue = issues[score.issueSequence - 1]
        const parent = parents[issue?.v1IssueSequence - 1]
        fail(
          issue &&
            parent &&
            issue.v1IssueSha256 === parent.sha256 &&
            score.issueSha256 === issue.sha256 &&
            score.holder === issue.holder &&
            score.routeKey === issue.routeKey &&
            score.destination === issue.destination &&
            score.originalAsset === issue.originalAsset &&
            issue.marketKey === 'aaveV3Usdc',
          'parent_binding',
        )
        if (score.status === 'censored') {
          denominator.censored++
          abstentions.push({
            issueSequence: issue.sequence,
            scoreSequence: score.sequence,
            reason: 'censored',
          })
          continue
        }
        fail(score.status === 'measured', 'score_status')
        const cases = score.cases
          .filter((row) => row.status === 'measured')
          .map((row) => {
            const original = issue.cases.find((entry) => entry.label === row.label)
            fail(
              original &&
                (version === 'frozen_q_v2' || original.status === 'measured') &&
                original.assetsRaw === row.assetsRaw,
              'case_binding',
            )
            return {
              label: row.label,
              qRaw: row.assetsRaw,
              baselineStatus:
                version === 'frozen_q_v2'
                  ? original.baselineStatus
                  : original.measurement?.baselineStatus,
              outcome: row.outcome,
              transition: row.transition,
            }
          })
        if (!cases.length) continue
        denominator.measuredEpisodes++
        denominator.correlatedQCases += cases.length
        const baselineBlock = block(parent.baseline.targetBlock)
        const targetBlock = block(score.target?.targetBlock)
        fail(targetBlock > baselineBlock, 'episode_order')
        if (joined.toBlock < baselineBlock) {
          denominator.unavailableCashFrontier++
          abstentions.push({
            issueSequence: issue.sequence,
            scoreSequence: score.sequence,
            baselineBlock,
            reason: 'verified_cash_frontier_before_baseline',
          })
          continue
        }
        const { feature, source: featureJoin } = featureAt(baselineBlock, horizonHours)
        if (feature.status !== 'preissue_proxy_available') {
          denominator.unavailableFeature++
          abstentions.push({
            issueSequence: issue.sequence,
            scoreSequence: score.sequence,
            baselineBlock,
            reason: feature.reason ?? feature.status,
          })
          continue
        }
        fail(feature.latestFeatureBlock < baselineBlock, 'feature_leakage')
        const elapsedSeconds =
          (time(score.target.targetBlockAt) - time(parent.baseline.targetBlockAt)) / 1000
        const nominalSeconds = horizonHours * 3600
        if (
          !Number.isInteger(elapsedSeconds) ||
          Math.abs(elapsedSeconds - nominalSeconds) > nominalSeconds * 0.05
        ) {
          denominator.targetTimingMismatch++
          abstentions.push({
            issueSequence: issue.sequence,
            scoreSequence: score.sequence,
            reason: 'target_more_than_five_percent_from_nominal_horizon',
            elapsedSeconds,
          })
          continue
        }
        const cash = amount(feature.cashRaw)
        const expectedIn = amount(feature.reserveIn.expectedRaw)
        const maximumOut = amount(feature.reserveOut.observedMaxRaw)
        candidates.push({
          issueSequence: issue.sequence,
          scoreSequence: score.sequence,
          issueSha256: issue.sha256,
          scoreSha256: score.sha256,
          v1IssueSequence: parent.sequence,
          holder: issue.holder,
          baselineBlock,
          targetBlock,
          elapsedSeconds,
          feature,
          featureJoin,
          cases: cases.map((row) => {
            const margin = cash + expectedIn - maximumOut - amount(row.qRaw)
            return {
              ...row,
              stressedAggregateCashAfterQRaw: margin.toString(),
              stressScenarioMarginNegative: margin < 0n,
            }
          }),
        })
      }
      candidates.sort(
        (a, b) => a.baselineBlock - b.baselineBlock || a.issueSequence - b.issueSequence,
      )
      const selected = []
      let priorTarget = -1
      for (const episode of candidates) {
        if (episode.baselineBlock <= priorTarget) {
          denominator.overlapExcluded++
          continue
        }
        selected.push(episode)
        priorTarget = episode.targetBlock
        denominator.selectedEpisodes++
        denominator.selectedCorrelatedQCases += episode.cases.length
      }
      return {
        horizonHours,
        denominator,
        selected,
        abstentions,
        statisticalIndependenceValidated: false,
      }
    })
    return { version, issueCoverage, scoreCount: scores.length, horizons: byHorizon }
  })
  return {
    study: 'aave_usdc_v23_holder_flow_offline_score_v1',
    source: {
      joinedStudy: joined.study,
      fromBlock: joined.fromBlock,
      toBlock: joined.toBlock,
      toHash: slices.at(-1).toHash,
      sliceCount: slices.length,
      pinnedReplayCount: pinnedReplayCount.count,
      pinnedCacheLimit: MAX_PINNED_CACHE,
      featureReplayLimit: MAX_FEATURE_REPLAYS,
    },
    arms: results,
    leakageGuard:
      'each selected feature uses verified market event blocks and a cash boundary strictly before the V1 baseline; the surrounding joined archive may extend later, and original issue-time availability of retrospective history is not established',
    interpretation: 'aggregate_cash_proxy_not_holder_executable',
    selection:
      'chronological disjoint episodes within each arm and horizon; Q cases remain correlated',
    crossArmAndHorizonIndependenceValidated: false,
    forecastValidated: false,
    holderExecutableExit: false,
  }
}

export async function readVerifiedAaveV23PreissueFlowScore() {
  // Each ledger verifier checks numbered SHA links, parent binding and replay evidence.
  const [parents, v2Issues, v2Scores, v3Issues, v3Scores] = await Promise.all([
    verifyPublicDirectIssues(),
    verifyAaveFrozenQIssues(),
    verifyAaveFrozenQScores(),
    verifyAaveCommonIssues(),
    verifyAaveCommonQScores(),
  ])
  const session = createVerifiedJoinSession()
  const joined = session.latest()
  return scoreAaveV23PreissueFlow({
    joined,
    parents,
    v2Issues,
    v2Scores,
    v3Issues,
    v3Scores,
    pinEndpoints: session.pinEndpoints(),
    replayPinnedJoin: (throughBlock) => session.at(throughBlock),
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  readVerifiedAaveV23PreissueFlowScore()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${String(error?.message ?? error)}\n`)
      process.exitCode = 1
    })
