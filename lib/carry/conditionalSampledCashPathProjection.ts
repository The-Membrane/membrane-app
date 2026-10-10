import { CONDITIONAL_FLOW_SOURCE_MAX_AGE_SECONDS } from './conditionalGrossFlowHeadroom'
import type {
  LocalHistoricalSampledCashTimeline,
  SampledCashHistoryCoverage,
} from './localHistoricalSampledCashTimeline'

export type ConditionalSampledCashIdentity = {
  routeKey: string
  destination: string
  asset: string
  assetDecimals: number
}
export type ConditionalSampledCashCurrentSource = ConditionalSampledCashIdentity & {
  chainId: 1
  cashRaw: string
  block: string
  blockHash: string
  blockTime: string
  readAt: string
  sourceKind: 'manifest_bound_ledger' | 'live_read_only_two_origin_finalized'
  manifestSha256?: string
  receiptSha256?: string
}
export type ConditionalSampledCashProjectionRequest = { requestedRaw: string; asOf: string }
// One tuple per observed anchor: index, block, hash, source time, native cash.
export type ConditionalSampledCashHistory = {
  identity: ConditionalSampledCashIdentity
  coverage: SampledCashHistoryCoverage
  witness: { manifestSha256: string; lastDailyReceiptSha256: string; availableAt: string }
  points: [number, string, string, string, string][]
}
type Hash = (serialized: string) => string
export type ConditionalSampledCashDistribution = {
  mean: { numeratorRaw: string; denominator: number; floorRaw: string }
  p10Raw: string
  p90Raw: string
  minimumRaw: string
  maximumRaw: string
}
type Bracket = { earliestAt: string; latestAt: string }
export type ConditionalSampledCashScenario = {
  episodeIndex: number
  originAnchorIndex: number
  elapsedSeconds: number[]
  capacityRaw: string[]
  userHeadroomRaw: string[]
  troughObservation: number
  sampledShortfalls: {
    firstBelowObservation: number
    lastBelowObservation: number
    onset: Bracket | null
    recovery: Bracket | null
    leftCensored: boolean
    rightCensored: boolean
    sampledSpanSeconds: number
  }[]
}
export type ConditionalSampledCashProjection = {
  status: 'estimated'
  claim: 'conditional_sampled_endpoint_cash_projection'
  cashMeasure: 'aggregate_underlying_balance_endpoint_proxy_not_max_withdraw'
  holderFailureForecast: false
  assumption: 'repeat_historical_joint_net_cash_paths_and_unchanged_mechanical_conditions'
  method: 'cumulative_native_cash_translation_floor_then_subtract_q_once'
  partition: 'oldest_sample_8_observations_advance_7'
  forecastValidated: false
  prospectiveValidated: false
  holderExecutableExit: false
  forwardProbability: false
  identity: ConditionalSampledCashIdentity
  currentSource: ConditionalSampledCashCurrentSource
  request: ConditionalSampledCashProjectionRequest
  history: ConditionalSampledCashHistory
  evidence: { compactHistorySha256: string } & ConditionalSampledCashHistory['witness']
  counts: {
    samples: number
    candidateEpisodes: number
    eligibleEpisodes: number
    gapRejectedEpisodes: number
    trailingSamples: number
  }
  horizons: {
    observation: number
    target: Bracket & { lowerSeconds: number; upperSeconds: number }
    capacity: ConditionalSampledCashDistribution
    userHeadroom: ConditionalSampledCashDistribution
    historicalScenariosCoveringQ: number
  }[]
  scenarios: ConditionalSampledCashScenario[]
  troughCapacity: ConditionalSampledCashDistribution
  troughHeadroom: ConditionalSampledCashDistribution
  historicalMaximumSampledNetDepletionRaw: string
}
export type ConditionalSampledCashPathProjection =
  | ConditionalSampledCashProjection
  | {
      status: 'unavailable'
      reason:
        | 'insufficient_eligible_history'
        | 'history_unverified'
        | 'subject_mismatch'
        | 'invalid_requested_raw'
        | 'invalid_current_source'
        | 'current_source_conflict'
        | 'source_stale'
        | 'time_invalid'
        | 'historical_training_after_source'
        | 'future_window_unavailable'
    }
const LIMIT = 1n << 256n
const raw = (v: unknown): v is string =>
  typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) < LIMIT
const stamp = (v: unknown): v is string =>
  typeof v === 'string' &&
  Number.isSafeInteger(Date.parse(v)) &&
  new Date(Date.parse(v)).toISOString() === v
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const blockHash = (v: unknown): v is string => typeof v === 'string' && /^0x[a-f0-9]{64}$/.test(v)
const unavailable = (
  reason: Extract<ConditionalSampledCashPathProjection, { status: 'unavailable' }>['reason'],
): ConditionalSampledCashPathProjection => ({ status: 'unavailable', reason })
const key = (id: ConditionalSampledCashIdentity) => `${id.routeKey}\0${id.destination}\0${id.asset}`
const sameIdentity = (a: ConditionalSampledCashIdentity, b: ConditionalSampledCashIdentity) =>
  a.routeKey === b.routeKey &&
  a.destination === b.destination &&
  a.asset === b.asset &&
  a.assetDecimals === b.assetDecimals
const validIdentity = (v: unknown): v is ConditionalSampledCashIdentity =>
  record(v) &&
  typeof v.routeKey === 'string' &&
  v.routeKey.length > 0 &&
  typeof v.destination === 'string' &&
  /^0x[0-9a-f]{40}$/.test(v.destination) &&
  typeof v.asset === 'string' &&
  /^0x[0-9a-f]{40}$/.test(v.asset) &&
  Number.isInteger(v.assetDecimals) &&
  Number(v.assetDecimals) >= 0 &&
  Number(v.assetDecimals) <= 36
function distribution(values: bigint[]): ConditionalSampledCashDistribution {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const sum = values.reduce((a, b) => a + b, 0n),
    n = BigInt(values.length)
  return {
    mean: {
      numeratorRaw: sum.toString(),
      denominator: values.length,
      floorRaw: (sum / n - (sum < 0n && sum % n !== 0n ? 1n : 0n)).toString(),
    },
    p10Raw: sorted[Math.floor((values.length - 1) * 0.1)].toString(),
    p90Raw: sorted[Math.floor((values.length - 1) * 0.9)].toString(),
    minimumRaw: sorted[0].toString(),
    maximumRaw: sorted.at(-1)!.toString(),
  }
}
// Type tags prevent object/array, undefined/null and primitive coercion collisions.
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `array[${v.map(canonical).join(',')}]`
  if (record(v))
    return `object{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(',')}}`
  return `${typeof v}:${JSON.stringify(v)}`
}

/** Called only with the existing receipt verifier's observation adapter, never HTTP evidence. */
export function conditionalSampledCashHistoryFromVerifiedTimeline(
  observations: readonly unknown[],
  timeline: Extract<LocalHistoricalSampledCashTimeline, { status: 'sampled_timeline' }>,
): ConditionalSampledCashHistory | null {
  try {
    const daily = (
      observations as {
        collectionMode: string
        anchorAt: string
        receiptSha256: string
        manifestSha256: string
        firstLocalReceiptAt: string
        source: { block: string; blockHash: string; blockAt: string }
      }[]
    )
      .filter((e) => e.collectionMode === 'retrospective' && e.anchorAt.endsWith('T00:00:00.000Z'))
      .sort((a, b) => a.anchorAt.localeCompare(b.anchorAt))
      .slice(-120)
    if (daily.length !== 120) return null
    return {
      identity: { ...timeline.identity },
      coverage: { ...timeline.coverage },
      witness: {
        manifestSha256: daily[0].manifestSha256,
        lastDailyReceiptSha256: daily[119].receiptSha256,
        availableAt: daily
          .map((e) => e.firstLocalReceiptAt)
          .sort()
          .at(-1)!,
      },
      points: timeline.timeline.map((p) => {
        const i = daily.findIndex((e) => e.source.blockAt === p.at)
        if (i < 0) throw Error('missing_source')
        const e = daily[i]
        return [i, e.source.block, e.source.blockHash, p.at, p.cashRaw]
      }),
    }
  } catch {
    return null
  }
}

/** Joint empirical future scenarios; cash capacity is not holder execution evidence. */
export function buildConditionalSampledCashPathProjection(
  input: {
    history: ConditionalSampledCashHistory | null
    currentSource: ConditionalSampledCashCurrentSource | null
    request: ConditionalSampledCashProjectionRequest
  },
  hash: Hash,
): ConditionalSampledCashPathProjection {
  try {
    if (
      !record(input) ||
      !record(input.request) ||
      !raw(input.request.requestedRaw) ||
      BigInt(input.request.requestedRaw) === 0n
    )
      return unavailable('invalid_requested_raw')
    const { history, currentSource: source, request } = input
    if (
      !history ||
      !validIdentity(history.identity) ||
      !Array.isArray(history.points) ||
      history.points.length < 8 ||
      history.points.length > 120
    )
      return unavailable('insufficient_eligible_history')
    const pin = HISTORY_PINS[key(history.identity)]
    if (
      !pin ||
      !record(history.witness) ||
      canonical(history.witness) !==
        canonical({
          manifestSha256: pin.manifestSha256,
          lastDailyReceiptSha256: pin.lastDailyReceiptSha256,
          availableAt: pin.availableAt,
        }) ||
      hash(JSON.stringify(history)) !== pin.compactSha256
    )
      return unavailable('history_unverified')
    if (
      !source ||
      !validIdentity(source) ||
      !raw(source.cashRaw) ||
      !raw(source.block) ||
      !blockHash(source.blockHash) ||
      source.chainId !== 1 ||
      !['manifest_bound_ledger', 'live_read_only_two_origin_finalized'].includes(source.sourceKind)
    )
      return unavailable('invalid_current_source')
    if (!sameIdentity(history.identity, source)) return unavailable('subject_mismatch')
    if (
      source.sourceKind === 'manifest_bound_ledger' &&
      (source.manifestSha256 !== pin.manifestSha256 || !sha(source.receiptSha256))
    )
      return unavailable('invalid_current_source')
    if (
      !stamp(source.blockTime) ||
      !stamp(source.readAt) ||
      !stamp(request.asOf) ||
      !stamp(history.witness.availableAt)
    )
      return unavailable('time_invalid')
    const sourceAt = Date.parse(source.blockTime),
      asOf = Date.parse(request.asOf)
    if (
      sourceAt > Date.parse(source.readAt) ||
      Date.parse(source.readAt) > asOf ||
      Date.parse(history.witness.availableAt) > asOf
    )
      return unavailable('time_invalid')
    if (asOf - sourceAt > CONDITIONAL_FLOW_SOURCE_MAX_AGE_SECONDS * 1000)
      return unavailable('source_stale')
    const points = history.points
    for (let i = 0; i < points.length; i++) {
      const p = points[i]
      if (
        !Array.isArray(p) ||
        p.length !== 5 ||
        !Number.isInteger(p[0]) ||
        p[0] < 0 ||
        p[0] > 119 ||
        !raw(p[1]) ||
        !blockHash(p[2]) ||
        !stamp(p[3]) ||
        !raw(p[4])
      )
        return unavailable('history_unverified')
      if (
        i &&
        (p[0] <= points[i - 1][0] ||
          BigInt(p[1]) <= BigInt(points[i - 1][1]) ||
          Date.parse(p[3]) <= Date.parse(points[i - 1][3]))
      )
        return unavailable('history_unverified')
      if (
        BigInt(p[1]) > BigInt(source.block) ||
        Date.parse(p[3]) > sourceAt ||
        (p[1] === source.block &&
          (p[2] !== source.blockHash || p[3] !== source.blockTime || p[4] !== source.cashRaw))
      )
        return unavailable('historical_training_after_source')
    }
    const cash = BigInt(source.cashRaw),
      q = BigInt(request.requestedRaw)
    const scenarios: ConditionalSampledCashScenario[] = []
    let candidates = 0,
      rejected = 0,
      maxDepletion = 0n
    for (let start = 0; start + 7 < points.length; start += 7) {
      const episodeIndex = candidates++,
        path = points.slice(start, start + 8)
      if (
        path.some(
          (p, j) =>
            j > 0 &&
            (p[0] !== path[j - 1][0] + 1 ||
              Math.abs(Date.parse(p[3]) - Date.parse(path[j - 1][3]) - 86400000) > 5400000),
        )
      ) {
        rejected++
        continue
      }
      const origin = BigInt(path[0][4]),
        times = path.map((p) => (Date.parse(p[3]) - Date.parse(path[0][3])) / 1000)
      const capacities = path.map((p) => {
        const c = cash + BigInt(p[4]) - origin
        return c < 0n ? 0n : c
      })
      const margins = capacities.map((c) => c - q)
      let trough = 0
      capacities.forEach((c, j) => {
        if (c < capacities[trough]) trough = j
      })
      path.forEach((p) => {
        const depletion = origin - BigInt(p[4])
        if (depletion > maxDepletion) maxDepletion = depletion
      })
      const target = (j: number) => new Date(sourceAt + times[j] * 1000).toISOString()
      const runs: ConditionalSampledCashScenario['sampledShortfalls'] = []
      for (let j = 0; j < path.length; j++) {
        if (margins[j] >= 0n) continue
        const first = j
        while (j + 1 < path.length && margins[j + 1] < 0n) j++
        runs.push({
          firstBelowObservation: first,
          lastBelowObservation: j,
          onset: first === 0 ? null : { earliestAt: target(first - 1), latestAt: target(first) },
          recovery: j === 7 ? null : { earliestAt: target(j), latestAt: target(j + 1) },
          leftCensored: first === 0,
          rightCensored: j === 7,
          sampledSpanSeconds: times[j] - times[first],
        })
      }
      scenarios.push({
        episodeIndex,
        originAnchorIndex: path[0][0],
        elapsedSeconds: times,
        capacityRaw: capacities.map(String),
        userHeadroomRaw: margins.map(String),
        troughObservation: trough,
        sampledShortfalls: runs,
      })
    }
    if (!scenarios.length) return unavailable('insufficient_eligible_history')
    const horizons = Array.from({ length: 7 }, (_, i) => {
      const observation = i + 1,
        elapsed = scenarios.map((s) => s.elapsedSeconds[observation]),
        lowerSeconds = Math.min(...elapsed),
        upperSeconds = Math.max(...elapsed)
      const capacity = scenarios.map((s) => BigInt(s.capacityRaw[observation])),
        headroom = scenarios.map((s) => BigInt(s.userHeadroomRaw[observation]))
      return {
        observation,
        target: {
          lowerSeconds,
          upperSeconds,
          earliestAt: new Date(sourceAt + lowerSeconds * 1000).toISOString(),
          latestAt: new Date(sourceAt + upperSeconds * 1000).toISOString(),
        },
        capacity: distribution(capacity),
        userHeadroom: distribution(headroom),
        historicalScenariosCoveringQ: headroom.filter((v) => v >= 0n).length,
      }
    })
    if (horizons.some((h) => Date.parse(h.target.earliestAt) <= asOf))
      return unavailable('future_window_unavailable')
    return {
      status: 'estimated',
      claim: 'conditional_sampled_endpoint_cash_projection',
      cashMeasure: 'aggregate_underlying_balance_endpoint_proxy_not_max_withdraw',
      holderFailureForecast: false,
      assumption: 'repeat_historical_joint_net_cash_paths_and_unchanged_mechanical_conditions',
      method: 'cumulative_native_cash_translation_floor_then_subtract_q_once',
      partition: 'oldest_sample_8_observations_advance_7',
      forecastValidated: false,
      prospectiveValidated: false,
      holderExecutableExit: false,
      forwardProbability: false,
      identity: { ...history.identity },
      currentSource: { ...source },
      request: { ...request },
      history: JSON.parse(JSON.stringify(history)),
      evidence: { compactHistorySha256: pin.compactSha256, ...history.witness },
      counts: {
        samples: points.length,
        candidateEpisodes: candidates,
        eligibleEpisodes: scenarios.length,
        gapRejectedEpisodes: rejected,
        trailingSamples: Math.max(0, points.length - (candidates * 7 + 1)),
      },
      horizons,
      scenarios,
      troughCapacity: distribution(
        scenarios.map((s) => BigInt(s.capacityRaw[s.troughObservation])),
      ),
      troughHeadroom: distribution(
        scenarios.map((s) => BigInt(s.userHeadroomRaw[s.troughObservation])),
      ),
      historicalMaximumSampledNetDepletionRaw: maxDepletion.toString(),
    }
  } catch {
    return unavailable('history_unverified')
  }
}

/** Recompute every fact and bind the result to external Q/current/native identity/render clock. */
export function selectedConditionalSampledCashPathProjection(
  value: unknown,
  expected: {
    identity: ConditionalSampledCashIdentity
    requestedRaw: string
    currentSource: ConditionalSampledCashCurrentSource
    asOfMs: number
  },
  hash: Hash,
): ConditionalSampledCashProjection | null {
  try {
    if (
      !record(value) ||
      value.status !== 'estimated' ||
      !record(value.request) ||
      !record(value.currentSource) ||
      !validIdentity(expected.identity) ||
      !Number.isSafeInteger(expected.asOfMs) ||
      !sameIdentity(
        expected.identity,
        value.currentSource as ConditionalSampledCashCurrentSource,
      ) ||
      value.request.requestedRaw !== expected.requestedRaw ||
      canonical(value.currentSource) !== canonical(expected.currentSource) ||
      !stamp(value.request.asOf) ||
      Date.parse(value.request.asOf) > expected.asOfMs ||
      expected.asOfMs - Date.parse(expected.currentSource.blockTime) >
        CONDITIONAL_FLOW_SOURCE_MAX_AGE_SECONDS * 1000
    )
      return null
    const rebuilt = buildConditionalSampledCashPathProjection(
      {
        history: value.history as ConditionalSampledCashHistory,
        currentSource: expected.currentSource,
        request: { requestedRaw: expected.requestedRaw, asOf: value.request.asOf },
      },
      hash,
    )
    if (
      rebuilt.status !== 'estimated' ||
      canonical(value) !== canonical(rebuilt) ||
      rebuilt.horizons.some((h) => Date.parse(h.target.earliestAt) <= expected.asOfMs)
    )
      return null
    return rebuilt
  } catch {
    return null
  }
}

// Generated once from full SHA/manifest/two-origin receipt replay, 2026-10-07.
// Pins cover native-payout identity, full daily grid/holes, block/hash/cash tuples,
// genuine history availability clock and the sealed final daily receipt witness.
const HISTORY_PINS: Record<
  string,
  {
    assetDecimals: number
    compactSha256: string
    manifestSha256: string
    lastDailyReceiptSha256: string
    availableAt: string
  }
> = {
  'apxUSD → ApyUSD [apxUSD]\u00000x38eeb52f0771140d10c4e9a9a72349a329fe8a6a\u00000x98a878b1cd98131b271883b390f68d2c90674665':
    {
      assetDecimals: 18,
      compactSha256: 'b530b2ad053670a0e7848217a6ebd4cd320e18ad2c0a923d2c333ffd1be93768',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'AUSD → VaultV2 [AUSD]\u00000x32401b9fb79065bc15949de0bd43927492f02f0c\u00000x00000000efe302beaa2b3e6e1b18d08d69a9012a':
    {
      assetDecimals: 6,
      compactSha256: '86ff99b3a6bb09bbbe082d73a855201f8b22a1486c7636f0cc054a03040c91cc',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'AUSD → VaultV2 [AUSD]\u00000xbeeff0d672ab7f5018dfb614c93981045d4aa98a\u00000x00000000efe302beaa2b3e6e1b18d08d69a9012a':
    {
      assetDecimals: 6,
      compactSha256: 'ccf8978341205c2f5f1a446834b7e1cb8ae210f304d386bcea6bf98034acdc10',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'AUSD → VaultV2 [AUSD]\u00000xbeeff0deac1aba71ef0d88c4291354eb92ef4589\u00000x00000000efe302beaa2b3e6e1b18d08d69a9012a':
    {
      assetDecimals: 6,
      compactSha256: '7efda19afa81c56e43738955c96c02ac624941d5759b24af68d8c912f8b31c73',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'EURCV → VaultV2 [EURCV]\u00000xbeef0c075da5d01112ae5cf34d257074fb5ddb2f\u00000x5f7827fdeb7c20b443265fc2f40845b715385ff2':
    {
      assetDecimals: 18,
      compactSha256: 'f6164b6a4739a01461f8006320c1bc9cd55ce0f601764e8bc044af4ef9ab9818',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'GHO → fToken [GHO]\u00000x6a29a46e21c730dca1d8b23d637c101cec605c5b\u00000x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f':
    {
      assetDecimals: 18,
      compactSha256: 'b7e97737493e086a40d8bdbe61e1f6f3560d81e66531cae849bfdabdfaff2bcf',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'GHO → sGho [GHO]\u00000xe1753f2e00940cc31213dd92013cf019dfe4ca1d\u00000x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f':
    {
      assetDecimals: 18,
      compactSha256: '67d76858613aeedf949746b29861c99d84c2a12c49bdaee2b518ccccd50e4e66',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'GHO → UmbrellaStakeToken [GHO]\u00000x4f827a63755855cdf3e8f3bcd20265c833f15033\u00000x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f':
    {
      assetDecimals: 18,
      compactSha256: '8336381bdc02a4b1746349e1dc1c56dd4c29406b41bc26118de77ba7fdd0b622',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'LINK → VaultV2 [LINK]\u00000x610f5b68bd1eed68af649a3fd3dc2caa1ee4ae7e\u00000x514910771af9ca656af840dff83e8264ecf986ca':
    {
      assetDecimals: 18,
      compactSha256: 'b508bfdc1c776acef83f00f0b15b4e749344f7016ee621552d858f760013d025',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'PYUSD → VaultV2 [PYUSD]\u00000xb576765fb15505433af24fee2c0325895c559fb2\u00000x6c3ea9036406852006290770bedfcaba0e23a0e8':
    {
      assetDecimals: 6,
      compactSha256: 'ff3c189bbeda381dc87aea6e8b3cb1a083cd5b66a5cdf8ebf848048ecff42f53',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'PYUSD → VaultV2 [PYUSD]\u00000xbeef00b5d83c1188f07a5184230a805639c39f04\u00000x6c3ea9036406852006290770bedfcaba0e23a0e8':
    {
      assetDecimals: 6,
      compactSha256: '76da801a2d4ecac9254c53d1d65c5e95f85363b7e9931f3af7b5736efbb16a4b',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'PYUSD → VaultV2 [PYUSD]\u00000xc21b08c16458202593d4d9b26b9984ee67b38bbd\u00000x6c3ea9036406852006290770bedfcaba0e23a0e8':
    {
      assetDecimals: 6,
      compactSha256: '3654ad89e5c9e0bc0bc2d7a2843b5ad66b2d8fd04b2a78edb28f95fd7ef15d16',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'RLUSD → VaultV2 [RLUSD]\u00000x6dc58a0fdfc8d694e571dc59b9a52eeea780e6bf\u00000x8292bb45bf1ee4d140127049757c2e0ff06317ed':
    {
      assetDecimals: 18,
      compactSha256: 'fb49370f843baa0d54ab4dc3ca7313671d816e34fbce287660a99b4494f46321',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'USDC → Fluid USD Coin [USDC]\u00000x9fb7b4477576fe5b32be4c1843afb1e55f251b33\u00000xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48':
    {
      assetDecimals: 6,
      compactSha256: '3e8da123df84e30d34a6993c3abf8584c6913407d12668dc14c7f56b4425f47b',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'USDC → FluidBridgeAggregatorProxy [USDC]\u00000x273da948aca9261043fbdb2a857bc255ecc29012\u00000xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48':
    {
      assetDecimals: 6,
      compactSha256: '7db52006c9e9c9829fc08a93fab78b4a4485e8cf58d34cacdc844e79024fb4d5',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'USDC → supply on Aave V3\u00000x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c\u00000xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48':
    {
      assetDecimals: 6,
      compactSha256: '3634e68658aae1578d3e6282d113294e9cb82afcf998c8234c5354bcebee494c',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'USDC → supply on Compound v3\u00000xc3d688b66703497daa19211eedff47f25384cdc3\u00000xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48':
    {
      assetDecimals: 6,
      compactSha256: '66b63e91426c4c54b73ee54eb45af203317975acfd6a26b7c387057b94000d43',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'USDC → USD3 [USDC]\u00000x056b269eb1f75477a8666ae8c7fe01b64dd55ecc\u00000xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48':
    {
      assetDecimals: 6,
      compactSha256: '2942d212217408f7bbe401abef40d9adbeed0ae5fe35d088f8a1f22f7b5ea89d',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'USDC → VaultV2 [USDC]\u00000x0026038a7fefef439d94bd99b4a10017e839d3a7\u00000xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48':
    {
      assetDecimals: 6,
      compactSha256: '50ec7d70ef5b586702dba9bae36ef0fa2453852a791c54b069859a0292869bd7',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'USDC → VaultV2 [USDC]\u00000x069662d2588fcac24b5c209456db965d151556f0\u00000xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48':
    {
      assetDecimals: 6,
      compactSha256: '369c19576ce461041c483611a67bc6908b406c3087a8804c032acaabd0a66e30',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'USDC → VaultV2 [USDC]\u00000x093272c07700d3ca5301c3bf9b3a392624179e2f\u00000xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48':
    {
      assetDecimals: 6,
      compactSha256: '4e0e89db831ef74a2c4160480314352e65afc079e0cca5c81b16b3d6971ed7e4',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'USDC → VaultV2 [USDC]\u00000x0bf0164d17469241b6e086da4016dcc54feaa334\u00000xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48':
    {
      assetDecimals: 6,
      compactSha256: '49fbbf647025bfaabe726ecc5b3c59fa546807327c6f978f2f9b8d8e2677aa6c',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'USDC → VaultV2 [USDC]\u00000x153bd1abe60104bd46aa05a27fa12d1346d64a57\u00000xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48':
    {
      assetDecimals: 6,
      compactSha256: '8fe5c8d13407b136d34d9a2e67986bb0bf2b01b2b142ae905748ed07935ff23b',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'USDC → VaultV2 [USDC]\u00000x35cbe8542e70fa2f7f9cdf129f19e593f4b4f560\u00000xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48':
    {
      assetDecimals: 6,
      compactSha256: '5fff8835aeb301cbd0af84c2dd84acb7e1d2b70d5daeccac3de9e4df8105596d',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'USDC → VaultV2 [USDC]\u00000x36cfe1568461e499391ef0a555300f1ae2da2439\u00000xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48':
    {
      assetDecimals: 6,
      compactSha256: '26976214080bb28abfe380d8a1e17a06481abd78e67b37c7b16ce2d222d25663',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'USDC → VaultV2 [USDC]\u00000x4ef53d2caa51c447fdfeeedee8f07fd1962c9ee6\u00000xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48':
    {
      assetDecimals: 6,
      compactSha256: '868b707376b9d9d2f10f14effd4357913f6757a811daefba60356fb7ca2e38b6',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'USDC → VaultV2 [USDC]\u00000x56bfa6f53669b836d1e0dfa5e99706b12c373ecf\u00000xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48':
    {
      assetDecimals: 6,
      compactSha256: 'cb6e72a6c5fff5cdfb851cf9454d3acafcbad97f7c4eb96c094445da07222fda',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'USDC → VaultV2 [USDC]\u00000x5dc53a23adc9f2bed98de6f59f7f309a7c71ff2b\u00000xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48':
    {
      assetDecimals: 6,
      compactSha256: 'd2952912df4c77a6d83202c72316cfc40a4df520aa5c271daad0d5a091449332',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'USDC → VaultV2 [USDC]\u00000x69a238ae7ebeb3c53ff3b544e48b96a2142fc284\u00000xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48':
    {
      assetDecimals: 6,
      compactSha256: '7b5d3f98591af796f59bdf1152b8d4d8e334eee3288142d8e0a989bdb3f81a9c',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'USDC → VaultV2 [USDC]\u00000x7ceb0f01cb7187a2ebed5661ecc4d5701d8f2350\u00000xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48':
    {
      assetDecimals: 6,
      compactSha256: 'b60bb5fa9edf4869098629854cd59cd99f32efc62591a341d9ac3831673c4639',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'USDC → VaultV2 [USDC]\u00000x8c106eedad96553e64287a5a6839c3cc78afa3d0\u00000xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48':
    {
      assetDecimals: 6,
      compactSha256: 'aaeed954ed938fe6d6856e6ac60378356d773272e9ccbc4ef5ee99a3b6246224',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'USDC → VaultV2 [USDC]\u00000x8edcc305e633d29bfb383872e79401c506ce9e6f\u00000xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48':
    {
      assetDecimals: 6,
      compactSha256: '71f4427c9fa4114e111d3fa1726ede2c1f26f564cac825010a1d6936588a117f',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'USDC → VaultV2 [USDC]\u00000x9480034d908989b006d78bdbbd7bd509c92e8bbc\u00000xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48':
    {
      assetDecimals: 6,
      compactSha256: '4554fa01738145418bcd18ebfbb2d63995638b089d2ea2eb0c5736da8f6f3238',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'USDC → VaultV2 [USDC]\u00000x951a9f4a2ce19b9dea6b37e691d076a345b6c0f8\u00000xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48':
    {
      assetDecimals: 6,
      compactSha256: '6fba79b3e63f98e18494171a940778fcee0447e319dfb968fd24d64fc74bd738',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'USDC → VaultV2 [USDC]\u00000x9a1d6bd5b8642c41f25e0958129b85f8e1176f3e\u00000xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48':
    {
      assetDecimals: 6,
      compactSha256: '206cdfe0bf72c1105faf55bb9a4c091580082499356bc468cc47aed08de42e07',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'USDC → VaultV2 [USDC]\u00000x9f39b13bb472126d6937bf25a39338e664eefa82\u00000xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48':
    {
      assetDecimals: 6,
      compactSha256: '54f28c278a80bd692d22c5ba2bbb66bdd950640bc13dc0ad347c7dcfc2b7688c',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'USDC → VaultV2 [USDC]\u00000xa1b096268d200d0ecfd57015700f6a0da9c494e2\u00000xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48':
    {
      assetDecimals: 6,
      compactSha256: '79bcfb751e17c31dee1bb39eddcbd38998ab1d26692072ab6ac648e4e1de50c3',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'USDC → VaultV2 [USDC]\u00000xabe418cc8c06d265e4eb009c02ea4b265eca7240\u00000xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48':
    {
      assetDecimals: 6,
      compactSha256: '435c46e7d8054cce7ce25ac6d57e26cf3a331fd9ad20a0cba50afd2ff273f148',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'USDC → VaultV2 [USDC]\u00000xb885f6d448da7e2c642ec31190b629e40e87b069\u00000xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48':
    {
      assetDecimals: 6,
      compactSha256: 'ebd7c79cdf6ca04063151716ecda7a01e969df5c599413f8c63c2e9ce132d904',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'USDC → VaultV2 [USDC]\u00000xbeef088055857739c12cd3765f20b7679def0f51\u00000xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48':
    {
      assetDecimals: 6,
      compactSha256: '2e74a46ac04da9a2a7f9a7d604bc79771c62e69ec2caf850d37f57f5ef9b006e',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'USDC → VaultV2 [USDC]\u00000xbeeff047c03714965a54b671a37c18bef6b96210\u00000xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48':
    {
      assetDecimals: 6,
      compactSha256: 'eef2eff39b57f0c6f3ac5d61be05eb3c4d3a5181621d63172744c192b9e6e278',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'USDC → VaultV2 [USDC]\u00000xbeeff2c5bf38f90e3482a8b19f12e5a6d2fca757\u00000xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48':
    {
      assetDecimals: 6,
      compactSha256: 'a3c0688117b2d233cbc6ef3953b297fd9ed85d0d9a1756be80fb5c50b71b51cf',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'USDC → VaultV2 [USDC]\u00000xbeeff75262b2ec16a3c62a807f02ee7627654931\u00000xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48':
    {
      assetDecimals: 6,
      compactSha256: '496debaccaaa48bb1d72aa5168730d8c081ed1978033b018f3dade0f2653f02f',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'USDC → VaultV2 [USDC]\u00000xbeefff4716a49418d69c251cab8759bb107e57c8\u00000xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48':
    {
      assetDecimals: 6,
      compactSha256: '9778a5f4104c1e31127efad57812cd81c5620d5a4dd601d452e328917f1ca14f',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'USDC → VaultV2 [USDC]\u00000xd1e9242e075db4bdd3f3c721d7d5fd4180a94a7e\u00000xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48':
    {
      assetDecimals: 6,
      compactSha256: 'ef8f6d1dfbd203e8bf81ef1f48c1c2e1d210e2a3b0fe535bad452e5be7e5f653',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'USDC → VaultV2 [USDC]\u00000xd5cce260e7a755ddf0fb9cdf06443d593aaeaa13\u00000xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48':
    {
      assetDecimals: 6,
      compactSha256: '4cd054244db079c1b3d18f8f33f1d2bc738436e2e3a3b4f84e22ed0db7b7479d',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'USDC → VaultV2 [USDC]\u00000xd95fe7adf5075fad9d6bf853e0f9fe53369e8d96\u00000xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48':
    {
      assetDecimals: 6,
      compactSha256: '8f7491901e9f82fc44033acf2641835ed76e65b0d98864243814048b81310bfa',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'USDC → VaultV2 [USDC]\u00000xe0181090c22579b6a217f1522cbf8c9f1f0c1965\u00000xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48':
    {
      assetDecimals: 6,
      compactSha256: 'b6499e28a3dac94c99a9e6d4ef1d6b8285f32ec94e731d02f51eabe324c4df00',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'USDC → VaultV2 [USDC]\u00000xe05fadf242331808f504661bea65972594869826\u00000xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48':
    {
      assetDecimals: 6,
      compactSha256: '111b3c441d9a6e394ac8a64e4f73d4c0323b41bd1002ad3c7051a4582540f878',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'USDC → VaultV2 [USDC]\u00000xebbae8cfabb0092d5b32f00ebee0c8139d24ddcd\u00000xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48':
    {
      assetDecimals: 6,
      compactSha256: '09b578434288d1f2039cb308b167939ac480346f93440cd11314fbc013767529',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'USDC → VaultV2 [USDC]\u00000xf1ca44eea3a4effcb195a970a2f1d8553f76f9a1\u00000xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48':
    {
      assetDecimals: 6,
      compactSha256: '5c7b98d1db49987ecb05804fcfef8abd8b1ac3efddae4d65fe099e9c6758667c',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'USDe → Staked USDe [USDe]\u00000x9d39a5de30e57443bff2a8307a4256c8797a3497\u00000x4c9edd5852cd905f086c759e8383e09bff1e68b3':
    {
      assetDecimals: 18,
      compactSha256: '5169e0bf89df4dd6ed86237a806709fa02ed6e8a735c1e8160fec8bfdeb19698',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'USDS → StUsds [USDS]\u00000x99cd4ec3f88a45940936f469e4bb72a2a701eeb9\u00000xdc035d45d973e3ec169d2276ddab16f1e407384f':
    {
      assetDecimals: 18,
      compactSha256: '43aacb910625fe922637a68994ab6cd0615115aee54bea7bb3c0ae96bbd78a6d',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'USDS → SUsds [USDS]\u00000xa3931d71877c0e7a3148cb7eb4463524fec27fbd\u00000xdc035d45d973e3ec169d2276ddab16f1e407384f':
    {
      assetDecimals: 18,
      compactSha256: '82660b27613e115e6fcf4eb5b53e503ff1e775460a8752f2e9d1e2a20087c2f4',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'USDT → fToken [USDT]\u00000x5c20b550819128074fd538edf79791733ccedd18\u00000xdac17f958d2ee523a2206206994597c13d831ec7':
    {
      assetDecimals: 6,
      compactSha256: '1d415b4c3ee6705a228a8774bb754ffb5d4cb46e9a55edbd33f33e8d8b5e7983',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'USDT → supply on Spark\u00000xe7df13b8e3d6740fe17cbe928c7334243d86c92f\u00000xdac17f958d2ee523a2206206994597c13d831ec7':
    {
      assetDecimals: 6,
      compactSha256: '12d8fe31d88bb1206fb2ba41d518f679801c3d5f64bcb053445d0c253513d666',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'USDT → VaultV2 [USDT]\u00000x23f5e9c35820f4bab695ac1f19c203cc3f8e1e11\u00000xdac17f958d2ee523a2206206994597c13d831ec7':
    {
      assetDecimals: 6,
      compactSha256: '4a1f1838e215b56c375a9ffe8697a0476bf9eb5c06a7d74bb263c083275e596d',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'USDT → VaultV2 [USDT]\u00000x2bd3a43863c07b6a01581fada0e1614ca5df0e3d\u00000xdac17f958d2ee523a2206206994597c13d831ec7':
    {
      assetDecimals: 6,
      compactSha256: '2945c926f00551322e65e1e9e83490b8e03c0082fbc8a72ec2a6be54ce3d3dc9',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'USDT → VaultV2 [USDT]\u00000x85f3d81a39df458e45d5ea20f9eb937faafd282f\u00000xdac17f958d2ee523a2206206994597c13d831ec7':
    {
      assetDecimals: 6,
      compactSha256: '0d9ec897f0963dbf51afd961467aa4e3d52324f01c778b09f6486d380457035e',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'USDT → VaultV2 [USDT]\u00000xbeef003c68896c7d2c3c60d363e8d71a49ab2bf9\u00000xdac17f958d2ee523a2206206994597c13d831ec7':
    {
      assetDecimals: 6,
      compactSha256: '72ec784a733767ee0cbe8738691994a22f8ad60082ddd6a4fa88e4f6f538282f',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'USDT → VaultV2 [USDT]\u00000xbeeff07d991c04cd640de9f15c08ba59c4fedeb7\u00000xdac17f958d2ee523a2206206994597c13d831ec7':
    {
      assetDecimals: 6,
      compactSha256: '5127eacb38555ec411cd5bb83439532a492849c57447f4c863b60c11d58bf3e7',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'USDT → VaultV2 [USDT]\u00000xe571b648569619566cf6ce1060c97b621cb635d3\u00000xdac17f958d2ee523a2206206994597c13d831ec7':
    {
      assetDecimals: 6,
      compactSha256: '9c71180c14428f8dbabd16b0fdb85a023272479e7d7eba6f8b509bc055b30d90',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'USDT → VaultV2 [USDT]\u00000xf3557ad5e984211ac8a0874a670344f2c3376471\u00000xdac17f958d2ee523a2206206994597c13d831ec7':
    {
      assetDecimals: 6,
      compactSha256: '9754f61666f6c8fc634796ffcbc74a490a3e4768c579f428688089db2e76b1a0',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      lastDailyReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      availableAt: '2026-10-05T10:57:37.472Z',
    },
  'USDe → supply on Aave V3\u00000x4f5923fc5fd4a93352581b38b7cd26943012decf\u00000x4c9edd5852cd905f086c759e8383e09bff1e68b3':
    {
      assetDecimals: 18,
      compactSha256: '8877662b638b874b6b4afd90ed407ad80444056b227d3796563b2a83417ee44b',
      manifestSha256: '11647d6e15a5f6d18d96d016e5522b1dcbf452b45022992dd139c2fa9a0d6ede',
      lastDailyReceiptSha256: '368163df8a8b7b518caee9fe049f7664f4ef09d0e860c1333ec354e4f219cf2e',
      availableAt: '2026-10-05T10:30:33.081Z',
    },
}

/** Trusted native identity for a frozen history cohort, independent of response availability. */
export function registeredConditionalSampledCashIdentity(
  routeKey: unknown,
  destination: unknown,
): ConditionalSampledCashIdentity | null {
  if (
    typeof routeKey !== 'string' ||
    typeof destination !== 'string' ||
    !/^0x[0-9a-f]{40}$/i.test(destination)
  )
    return null
  const prefix = `${routeKey}\0${destination.toLowerCase()}\0`
  const entries = Object.entries(HISTORY_PINS).filter(([id]) => id.startsWith(prefix))
  if (entries.length !== 1) return null
  const [id, pin] = entries[0]
  return {
    routeKey,
    destination: destination.toLowerCase(),
    asset: id.slice(prefix.length),
    assetDecimals: pin.assetDecimals,
  }
}
