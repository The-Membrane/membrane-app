import type {
  ExitImpactIdentity,
  HistoricalCashTimelineObservation,
} from '@/lib/forecast/exitImpactForecast'

export type HistoricalSampledCashPathsInput = {
  identity: ExitImpactIdentity
  requestedRaw: string
  current: {
    cashRaw: string
    blockAt: string
    block: string
    blockHash: string
    subjectKey: string
    asset: string
    assetDecimals: number
  }
  timelineIdentity: { subjectKey: string; asset: string; assetDecimals: number }
  asOfMs: number
  /** Exact native units must already have been verified by the historical context adapter. */
  timeline: readonly HistoricalCashTimelineObservation[]
}

export type SampledCashPathExample = {
  episodeIndex: number
  rank: number
  originAt: string
  endpointAt: string
  troughAt: string
  elapsedSeconds: number
  originCashRaw: string
  historicalEndpointCashRaw: string
  historicalTroughCashRaw: string
  endpointCashDeltaRaw: string
  troughCashDeltaRaw: string
  endpointCashRaw: string
  troughCashRaw: string
  endpointMarginAfterQRaw: string
  troughMarginAfterQRaw: string
  endpointDeficitAfterQRaw: string
  troughDeficitAfterQRaw: string
  selectedTarget: 'trough' | 'endpoint'
  /** Zero-based sampled run index; null when the selected target covers Q. */
  selectedRunIndex: number | null
  runCount: number
  sampledBelowQ: {
    firstBelowAt: string | null
    lastBelowAt: string | null
    nextAboveQObservationAt: string | null
    onsetBracket: { afterAt: string; byAt: string } | null
    recoveryBracket: { afterAt: string; byAt: string } | null
    sampledBelowQSpanSeconds: number | null
    leftCensored: boolean
    rightCensored: boolean
    gapCensored: boolean
  }
}

export type HistoricalSampledCashPathsReason =
  | 'invalid_identity'
  | 'invalid_requested_raw'
  | 'invalid_current_source'
  | 'current_cash_stale_or_future'
  | 'subject_mismatch'
  | 'malformed_timeline'
  | 'future_history'
  | 'insufficient_eligible_history'

type Common = {
  claim: 'aggregate_endpoint_cash_proxy_only'
  prospectiveValidated: false
  holderExecutableExit: false
  forwardProbability: false
}

export type HistoricalSampledCashPathsResult = Common &
  (
    | { status: 'unavailable'; reason: HistoricalSampledCashPathsReason }
    | {
        status: 'conditional_historical_sampled_cash_paths'
        method: 'sampled_historical_net_cash_change_replay'
        partition: 'oldest_sample_8_observations_advance_7'
        selection: 'retrospective_empirical_examples_not_forecast_probability'
        horizonHours: 168
        identity: ExitImpactIdentity
        requestedRaw: string
        current: HistoricalSampledCashPathsInput['current']
        asOfAt: string
        counts: {
          samples: number
          candidateEpisodes: number
          eligibleEpisodes: number
          gapRejectedEpisodes: number
          gaps: number
          trailingSamples: number
        }
        history: { fromAt: string; toAt: string }
        examples: {
          worstTrough: SampledCashPathExample
          p10Trough: SampledCashPathExample
          worstEndpoint: SampledCashPathExample
        }
      }
  )

const DAY_MS = 86_400_000
// Same cadence tolerance as exitImpactForecast's verified daily timeline.
const DAILY_TOLERANCE_MS = 90 * 60_000
const MAX_RAW = (1n << 256n) - 1n
const FLAGS: Common = {
  claim: 'aggregate_endpoint_cash_proxy_only',
  prospectiveValidated: false,
  holderExecutableExit: false,
  forwardProbability: false,
}

function raw(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 78)
    return null
  const parsed = BigInt(value)
  return parsed <= MAX_RAW ? parsed : null
}

function timestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
    return null
  const parsed = Date.parse(value)
  return Number.isSafeInteger(parsed) && new Date(parsed).toISOString() === value ? parsed : null
}

const clamp = (value: bigint) => (value < 0n ? 0n : value)
const compare = (left: bigint, right: bigint) => (left < right ? -1 : left > right ? 1 : 0)

/**
 * Replays disjoint elapsed historical spans against C2, then subtracts Q once.
 * Samples do not establish continuous below-Q time, intraday crossings, or
 * holder-executable exits. No fitting, probability, or prospective-score gate.
 */
export function replaySampledHistoricalCashPaths(
  input: HistoricalSampledCashPathsInput,
): HistoricalSampledCashPathsResult {
  const unavailable = (
    reason: HistoricalSampledCashPathsReason,
  ): HistoricalSampledCashPathsResult => ({ ...FLAGS, status: 'unavailable', reason })
  const identity = input.identity
  if (
    !identity ||
    [identity.routeKey, identity.destination, identity.asset].some(
      (value) =>
        typeof value !== 'string' || !value.trim() || value.length > 512 || value.includes('\0'),
    ) ||
    !Number.isSafeInteger(identity.assetDecimals) ||
    identity.assetDecimals < 0 ||
    identity.assetDecimals > 36
  )
    return unavailable('invalid_identity')
  const subjectKey = `${identity.routeKey}\0${identity.destination}\0${identity.asset}`
  if (
    input.timelineIdentity?.subjectKey !== subjectKey ||
    input.timelineIdentity.asset !== identity.asset ||
    input.timelineIdentity.assetDecimals !== identity.assetDecimals ||
    input.current?.subjectKey !== subjectKey ||
    input.current.asset !== identity.asset ||
    input.current.assetDecimals !== identity.assetDecimals
  )
    return unavailable('subject_mismatch')
  const q = raw(input.requestedRaw)
  if (q === null || q === 0n) return unavailable('invalid_requested_raw')
  const current = input.current
  const currentCash = raw(current?.cashRaw)
  const currentAt = timestamp(current?.blockAt)
  if (
    currentCash === null ||
    currentAt === null ||
    raw(current?.block) === null ||
    typeof current?.blockHash !== 'string' ||
    !/^0x[0-9a-f]{64}$/.test(current.blockHash) ||
    !Number.isSafeInteger(input.asOfMs) ||
    Math.abs(input.asOfMs) > 8_640_000_000_000_000
  )
    return unavailable('invalid_current_source')
  const age = input.asOfMs - currentAt
  if (age < -120_000 || age > 2 * 60 * 60_000) return unavailable('current_cash_stale_or_future')
  if (!Array.isArray(input.timeline)) return unavailable('malformed_timeline')
  const points: { at: string; ms: number; cash: bigint }[] = []
  const gaps = new Set<number>()
  for (const observation of input.timeline) {
    if (observation?.subjectKey !== subjectKey) return unavailable('subject_mismatch')
    const ms = timestamp(observation.at)
    const cash = raw(observation.cashRaw)
    if (ms === null || cash === null) return unavailable('malformed_timeline')
    if (ms > input.asOfMs || ms > currentAt) return unavailable('future_history')
    const previous = points.at(-1)
    if (previous) {
      const elapsed = ms - previous.ms
      if (elapsed < DAY_MS - DAILY_TOLERANCE_MS) return unavailable('malformed_timeline')
      if (elapsed > DAY_MS + DAILY_TOLERANCE_MS) gaps.add(points.length)
    }
    points.push({ at: observation.at, ms, cash })
  }
  type Episode = Omit<
    SampledCashPathExample,
    'sampledBelowQ' | 'selectedTarget' | 'selectedRunIndex' | 'runCount'
  > & {
    path: typeof points
    start: number
    troughIndex: number
    runs: { firstBelow: number; lastBelow: number; recovery: number }[]
  }
  const episodes: Episode[] = []
  let candidateEpisodes = 0
  let gapRejectedEpisodes = 0
  for (let start = 0; start + 7 < points.length; start += 7) {
    const episodeIndex = candidateEpisodes++
    if (
      Array.from({ length: 7 }, (_, index) => start + index + 1).some((index) => gaps.has(index))
    ) {
      gapRejectedEpisodes++
      continue
    }
    const path = points.slice(start, start + 8)
    const origin = path[0]
    const endpoint = path[7]
    const trough = path.reduce((lowest, point) => (point.cash < lowest.cash ? point : lowest))
    const replay = path.map((point) => clamp(currentCash + point.cash - origin.cash))
    const endpointCash = replay[7]
    const troughCash = clamp(currentCash + trough.cash - origin.cash)
    const runs: Episode['runs'] = []
    for (let index = 0; index < path.length; index++) {
      if (replay[index] >= q) continue
      const firstBelow = index
      while (index + 1 < path.length && replay[index + 1] < q) index++
      runs.push({
        firstBelow,
        lastBelow: index,
        recovery: index + 1 < path.length ? index + 1 : -1,
      })
    }
    episodes.push({
      episodeIndex,
      rank: 0,
      originAt: origin.at,
      endpointAt: endpoint.at,
      troughAt: trough.at,
      elapsedSeconds: (endpoint.ms - origin.ms) / 1000,
      originCashRaw: origin.cash.toString(),
      historicalEndpointCashRaw: endpoint.cash.toString(),
      historicalTroughCashRaw: trough.cash.toString(),
      endpointCashDeltaRaw: (endpoint.cash - origin.cash).toString(),
      troughCashDeltaRaw: (trough.cash - origin.cash).toString(),
      endpointCashRaw: endpointCash.toString(),
      troughCashRaw: troughCash.toString(),
      endpointMarginAfterQRaw: (endpointCash - q).toString(),
      troughMarginAfterQRaw: (troughCash - q).toString(),
      endpointDeficitAfterQRaw: clamp(q - endpointCash).toString(),
      troughDeficitAfterQRaw: clamp(q - troughCash).toString(),
      path,
      start,
      troughIndex: path.indexOf(trough),
      runs,
    })
  }
  if (!episodes.length) return unavailable('insufficient_eligible_history')
  const ranked = [...episodes]
    .sort(
      (a, b) =>
        compare(BigInt(a.troughCashDeltaRaw), BigInt(b.troughCashDeltaRaw)) ||
        a.episodeIndex - b.episodeIndex,
    )
    .map((episode, index) => ({ ...episode, rank: index + 1 }))
  const endpointRanked = [...ranked].sort(
    (a, b) =>
      compare(BigInt(a.endpointCashDeltaRaw), BigInt(b.endpointCashDeltaRaw)) ||
      a.episodeIndex - b.episodeIndex,
  )
  function selectedExample(
    episode: Episode,
    selectedTarget: 'trough' | 'endpoint',
  ): SampledCashPathExample {
    const { path, start, troughIndex, runs, ...cashExample } = episode
    const targetIndex = selectedTarget === 'trough' ? troughIndex : 7
    const selectedRunIndex = runs.findIndex(
      (run) => targetIndex >= run.firstBelow && targetIndex <= run.lastBelow,
    )
    const run = selectedRunIndex < 0 ? null : runs[selectedRunIndex]
    const firstBelow = run?.firstBelow ?? -1
    const lastBelow = run?.lastBelow ?? -1
    const recovery = run?.recovery ?? -1
    return {
      ...cashExample,
      selectedTarget,
      selectedRunIndex: selectedRunIndex < 0 ? null : selectedRunIndex,
      runCount: runs.length,
      sampledBelowQ: {
        firstBelowAt: firstBelow < 0 ? null : path[firstBelow].at,
        lastBelowAt: lastBelow < 0 ? null : path[lastBelow].at,
        nextAboveQObservationAt: recovery < 0 ? null : path[recovery].at,
        onsetBracket:
          firstBelow <= 0 ? null : { afterAt: path[firstBelow - 1].at, byAt: path[firstBelow].at },
        recoveryBracket:
          recovery < 0 ? null : { afterAt: path[lastBelow].at, byAt: path[recovery].at },
        sampledBelowQSpanSeconds:
          firstBelow < 0 ? null : (path[lastBelow].ms - path[firstBelow].ms) / 1000,
        leftCensored: firstBelow === 0,
        rightCensored: firstBelow >= 0 && recovery < 0,
        // Internal gaps reject the episode. Adjacent external gaps can censor
        // the selected run at its episode boundary; no gap is stitched.
        gapCensored:
          (firstBelow === 0 && gaps.has(start)) ||
          (firstBelow >= 0 && recovery < 0 && gaps.has(start + 8)),
      },
    }
  }
  return {
    ...FLAGS,
    status: 'conditional_historical_sampled_cash_paths',
    method: 'sampled_historical_net_cash_change_replay',
    partition: 'oldest_sample_8_observations_advance_7',
    selection: 'retrospective_empirical_examples_not_forecast_probability',
    horizonHours: 168,
    identity: { ...identity },
    requestedRaw: input.requestedRaw,
    current: { ...current },
    asOfAt: new Date(input.asOfMs).toISOString(),
    counts: {
      samples: points.length,
      candidateEpisodes,
      eligibleEpisodes: episodes.length,
      gapRejectedEpisodes,
      gaps: gaps.size,
      trailingSamples: Math.max(0, points.length - (candidateEpisodes * 7 + 1)),
    },
    history: { fromAt: points[0].at, toAt: points[points.length - 1].at },
    examples: {
      worstTrough: selectedExample(ranked[0], 'trough'),
      p10Trough: selectedExample(ranked[Math.floor((ranked.length - 1) * 0.1)], 'trough'),
      worstEndpoint: selectedExample(endpointRanked[0], 'endpoint'),
    },
  }
}
