import {
  backtestAggregateCashQ,
  type AggregateCashQHoldoutResult,
} from '@/lib/carry/aggregateCashQHoldout'
import {
  historicalCarryCashContext,
  withReadOnlyCurrentCash,
  type CarryLiveCurrentCash,
} from '@/lib/carry/historicalCashContext'
import {
  projectHistoricalCash,
  type HistoricalCashHoldout,
  type HistoricalCashPair,
} from '@/lib/carry/historicalCashProjection'
import type { HistoricalCashTimelineObservation } from '@/lib/forecast/exitImpactForecast'

type Subject = { route_key: string; destination: string; asset: string }
type Observation = Parameters<typeof historicalCarryCashContext>[0][number]
type HistoricalContext = Extract<
  ReturnType<typeof historicalCarryCashContext>,
  { status: 'historical_context' }
>

export type LocalHistoricalCashPairs =
  | {
      status: 'unavailable'
      reason:
        | 'insufficient_long_history'
        | 'identity_mismatch'
        | 'subject_unassessed'
        | 'subject_no_code'
    }
  | {
      status: 'historical_pairs'
      claim: 'aggregate_underlying_cash_proxy_only'
      sourceKind: 'local_sha_replayed_finalized_rpc'
      routeKey: string
      destination: string
      asset: string
      assetDecimals: number
      horizonHours: 24
      subjectKey: string
      pairs: HistoricalCashPair[]
      dailyTimeline: HistoricalCashTimelineObservation[]
    }

export type LocalHistoricalCashQHoldout =
  | {
      status: 'unavailable'
      reason:
        | 'insufficient_long_history'
        | 'no_fresh_current_cash'
        | 'identity_mismatch'
        | Extract<AggregateCashQHoldoutResult, { status: 'unavailable' }>['reason']
      backtest: AggregateCashQHoldoutResult | null
    }
  | {
      status: 'historical_backtest'
      claim: 'aggregate_cash_proxy_only'
      sourceKind: 'local_sha_replayed_finalized_rpc'
      currentSourceKind?: 'live_read_only_two_origin_finalized'
      prospectiveValidated: false
      holderExecutableExit: false
      assetDecimals: number
      currentBlockAt: string
      backtest: Extract<AggregateCashQHoldoutResult, { status: 'historical_backtest' }>
    }

export type LocalHistoricalCashScenario =
  | {
      status: 'unavailable'
      reason:
        | 'insufficient_long_history'
        | 'no_fresh_current_cash'
        | 'model_selection_failed'
        | 'untouched_holdout_failed'
        | 'identity_mismatch'
    }
  | {
      status: 'historical_conditional_cash_scenario'
      claim: 'aggregate_underlying_cash_proxy_only'
      method: 'learned_delta' | 'persistence_band'
      prospectiveValidated: false
      holderExecutableExit: false
      sourceKind: 'local_sha_replayed_finalized_rpc'
      currentSourceKind?: 'live_read_only_two_origin_finalized'
      currentBlockAt: string
      currentBlock: string
      currentBlockHash: string
      targetAt: string
      currentCashRaw: string
      pointRaw: string
      bandLowRaw: string
      bandHighRaw: string
      assetDecimals: number
      pairs: number
      fit: number
      calibration: number
      selection: number
      selectionCovered: number
      holdout: number
      holdoutCovered: number
      holdoutPointBeatsPersistence: boolean | null
      holdoutModelMae: HistoricalCashHoldout['modelMae'] | null
      holdoutPersistenceMae: HistoricalCashHoldout['persistenceMae'] | null
    }

/**
 * The context validates the 120-anchor grid and all subject observations. This
 * single extraction keeps both historical models on identical exact pairs.
 */
function exactLongPairs(
  observations: Observation[],
  subject: Subject,
  context: HistoricalContext,
): {
  subjectKey: string
  pairs: HistoricalCashPair[]
  dailyTimeline: HistoricalCashTimelineObservation[]
} | null {
  const daily = observations
    .filter(
      (entry) =>
        entry.collectionMode === 'retrospective' && entry.anchorAt.endsWith('T00:00:00.000Z'),
    )
    .sort((a, b) => a.anchorAt.localeCompare(b.anchorAt))
    .slice(-120)
  if (daily.length !== 120) return null
  const subjectKey = `${subject.route_key}\0${subject.destination}\0${subject.asset}`
  const pairs: HistoricalCashPair[] = []
  const dailyTimeline: HistoricalCashTimelineObservation[] = []
  if (
    context.gridLabel !== '00:00 UTC daily / 120 days' ||
    context.coverageFrom !== daily[0].anchorAt ||
    context.coverageTo !== daily[daily.length - 1].anchorAt
  )
    return null
  for (let i = 0; i < 120; i += 2) {
    const source = daily[i]
    const target = daily[i + 1]
    const sourceRows = source.subjects.filter(
      (row) => row.routeKey === subject.route_key && row.destination === subject.destination,
    )
    const targetRows = target.subjects.filter(
      (row) => row.routeKey === subject.route_key && row.destination === subject.destination,
    )
    if (
      sourceRows.length !== 1 ||
      targetRows.length !== 1 ||
      sourceRows[0].state !== 'observed' ||
      targetRows[0].state !== 'observed' ||
      sourceRows[0].asset !== subject.asset ||
      targetRows[0].asset !== subject.asset ||
      sourceRows[0].assetDecimals !== context.assetDecimals ||
      targetRows[0].assetDecimals !== context.assetDecimals ||
      sourceRows[0].cashRaw === null ||
      targetRows[0].cashRaw === null
    )
      return null
    dailyTimeline.push(
      { subjectKey, at: source.source.blockAt, cashRaw: sourceRows[0].cashRaw },
      { subjectKey, at: target.source.blockAt, cashRaw: targetRows[0].cashRaw },
    )
    pairs.push({
      subjectKey,
      sourceAt: source.source.blockAt,
      targetAt: target.source.blockAt,
      sourceCashRaw: sourceRows[0].cashRaw,
      targetCashRaw: targetRows[0].cashRaw,
    })
  }
  return { subjectKey, pairs, dailyTimeline }
}

/**
 * Extract the verified 60 disjoint retrospective pairs without requiring a
 * current cash observation. Current freshness is relevant to a live scenario,
 * but cannot erase already sealed endpoint history.
 */
export function localHistoricalCashPairs(
  observations: Observation[],
  subject: Subject,
  now = Date.now(),
): LocalHistoricalCashPairs {
  const context = historicalCarryCashContext(observations, subject, now)
  if (context.status !== 'historical_context' || context.sampleCount !== 60)
    return {
      status: 'unavailable',
      reason:
        context.status === 'unavailable' && context.reason !== 'insufficient_daily_anchors'
          ? context.reason
          : 'insufficient_long_history',
    }
  const extracted = exactLongPairs(observations, subject, context)
  if (!extracted) return { status: 'unavailable', reason: 'identity_mismatch' }
  return {
    status: 'historical_pairs',
    claim: 'aggregate_underlying_cash_proxy_only',
    sourceKind: 'local_sha_replayed_finalized_rpc',
    routeKey: context.routeKey,
    destination: context.destination,
    asset: context.asset,
    assetDecimals: context.assetDecimals,
    horizonHours: 24,
    subjectKey: extracted.subjectKey,
    pairs: extracted.pairs,
    dailyTimeline: extracted.dailyTimeline,
  }
}

/** Applies a qualified retrospective change distribution to a separate fresh current read. */
export function localHistoricalCashScenario(
  observations: Observation[],
  subject: Subject,
  now = Date.now(),
  liveCurrent?: CarryLiveCurrentCash,
): LocalHistoricalCashScenario {
  const archived = historicalCarryCashContext(observations, subject, now)
  const context = liveCurrent
    ? withReadOnlyCurrentCash(archived, subject, liveCurrent, now)
    : archived
  if (context.status !== 'historical_context' || context.sampleCount !== 60)
    return { status: 'unavailable', reason: 'insufficient_long_history' }
  if (!context.current || context.current.freshness !== 'fresh')
    return { status: 'unavailable', reason: 'no_fresh_current_cash' }

  const extracted = exactLongPairs(observations, subject, context)
  if (!extracted) return { status: 'unavailable', reason: 'identity_mismatch' }
  const result = projectHistoricalCash({
    subjectKey: extracted.subjectKey,
    horizonHours: 24,
    currentAt: context.current.blockAt,
    currentCashRaw: context.current.cashRaw,
    pairs: extracted.pairs,
  })
  const learnedSelected = result.status === 'historical_projection'
  if (
    learnedSelected &&
    (result.holdout?.coveragePassed !== true || result.holdout.pointBeatsPersistence !== true)
  )
    return { status: 'unavailable', reason: 'untouched_holdout_failed' }
  if (
    !learnedSelected &&
    result.baselineBand?.selectionCoveragePassed === true &&
    result.baselineBand.coveragePassed !== true
  )
    return { status: 'unavailable', reason: 'untouched_holdout_failed' }

  const learned = learnedSelected ? result.projection : null
  const baseline =
    !learnedSelected &&
    result.baselineBand?.selectionCoveragePassed === true &&
    result.baselineBand.coveragePassed === true
      ? result.baselineBand
      : null
  if (!learned && !baseline)
    return {
      status: 'unavailable',
      reason:
        result.reason === 'no_skill_over_persistence'
          ? 'model_selection_failed'
          : result.reason === 'insufficient_history'
            ? 'insufficient_long_history'
            : 'identity_mismatch',
    }
  const band = learned ?? baseline!
  return {
    status: 'historical_conditional_cash_scenario',
    claim: 'aggregate_underlying_cash_proxy_only',
    method: learned ? 'learned_delta' : 'persistence_band',
    prospectiveValidated: false,
    holderExecutableExit: false,
    sourceKind: 'local_sha_replayed_finalized_rpc',
    ...(context.current.sourceKind ? { currentSourceKind: context.current.sourceKind } : {}),
    currentBlockAt: context.current.blockAt,
    currentBlock: context.current.block,
    currentBlockHash: context.current.blockHash,
    targetAt:
      learned?.targetAt ?? new Date(Date.parse(context.current.blockAt) + 86_400_000).toISOString(),
    currentCashRaw: context.current.cashRaw,
    pointRaw: band.pointRaw,
    bandLowRaw: band.bandLowRaw,
    bandHighRaw: band.bandHighRaw,
    assetDecimals: context.assetDecimals,
    pairs: result.counts.total,
    fit: result.counts.fit,
    calibration: result.counts.calibration,
    selection: result.counts.selection,
    selectionCovered: learned ? result.selection!.covered : baseline!.selectionCovered,
    holdout: result.counts.holdout,
    holdoutCovered: learned ? result.holdout!.covered : baseline!.holdoutCovered,
    holdoutPointBeatsPersistence: learned ? result.holdout!.pointBeatsPersistence : null,
    holdoutModelMae: learned ? result.holdout!.modelMae : null,
    holdoutPersistenceMae: learned ? result.holdout!.persistenceMae : null,
  }
}

/**
 * Historical Q-threshold diagnostic; never a prospective exit forecast.
 * Provenance assumes the caller loaded SHA-verified local receipts first.
 */
export function localHistoricalCashQHoldout(
  observations: Observation[],
  subject: Subject,
  requestedAssetsRaw: string,
  now = Date.now(),
  liveCurrent?: CarryLiveCurrentCash,
): LocalHistoricalCashQHoldout {
  const archived = historicalCarryCashContext(observations, subject, now)
  const context = liveCurrent
    ? withReadOnlyCurrentCash(archived, subject, liveCurrent, now)
    : archived
  if (context.status !== 'historical_context' || context.sampleCount !== 60)
    return { status: 'unavailable', reason: 'insufficient_long_history', backtest: null }
  if (!context.current || context.current.freshness !== 'fresh')
    return { status: 'unavailable', reason: 'no_fresh_current_cash', backtest: null }
  const extracted = exactLongPairs(observations, subject, context)
  if (!extracted) return { status: 'unavailable', reason: 'identity_mismatch', backtest: null }
  const result = backtestAggregateCashQ({
    subjectKey: extracted.subjectKey,
    currentAt: context.current.blockAt,
    asOfAt: new Date(now).toISOString(),
    currentCashRaw: context.current.cashRaw,
    requestedAssetsRaw,
    pairs: extracted.pairs,
  })
  if (result.status === 'unavailable')
    return { status: 'unavailable', reason: result.reason, backtest: result }
  return {
    status: 'historical_backtest',
    claim: 'aggregate_cash_proxy_only',
    sourceKind: 'local_sha_replayed_finalized_rpc',
    ...(context.current.sourceKind ? { currentSourceKind: context.current.sourceKind } : {}),
    prospectiveValidated: false,
    holderExecutableExit: false,
    assetDecimals: context.assetDecimals,
    currentBlockAt: context.current.blockAt,
    backtest: result,
  }
}
