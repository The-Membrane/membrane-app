import {
  AAVE_COMPETING_FLOW_IDENTITY,
  selectedHistoricalCompetingFlowEstimate,
  type HistoricalCompetingFlowEstimate,
} from './historicalCompetingFlowEstimate'

// Finalized headers may lag the request clock. At this limit the shortest
// observed next window still starts 732 seconds ahead, on the source clock.
export const CONDITIONAL_FLOW_SOURCE_MAX_AGE_SECONDS = 1800
const NEXT_WINDOW_SECONDS = { lowerSeconds: 2532, upperSeconds: 3588 } as const
const UINT256_LIMIT = 1n << 256n
const raw = (value: unknown): value is string =>
  typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) < UINT256_LIMIT
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const stamp = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isSafeInteger(Date.parse(value)) &&
  new Date(Date.parse(value)).toISOString() === value
const address = (value: unknown): value is string =>
  typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)
type Hash = (serialized: string) => string

export type ConditionalGrossFlowCurrentSource = {
  chainId: 1
  routeKey: string
  destination: string
  asset: string
  assetDecimals: number
  cashRaw: string
  blockNumber: number
  blockHash: string
  blockTime: string
  readAt: string
  finalized: true
}
export type ConditionalGrossFlowRequest = { requestedRaw: string; asOf: string }
export type ConditionalGrossFlowProjectionInput = {
  currentSource: ConditionalGrossFlowCurrentSource | null
  request: ConditionalGrossFlowRequest
  historicalFlow: unknown
}
type Mean = { numeratorRaw: string; denominator: 78; floorRaw: string }
type JointDistribution = {
  mean: Mean
  p10Raw: string
  p90Raw: string
  minimumRaw: string
  maximumRaw: string
}
export type ConditionalGrossFlowProjection = {
  status: 'estimated'
  claim: 'conditional_capacity_projection'
  assumption: 'repeat_historical_joint_flows_and_unchanged_mechanical_conditions'
  forecastValidated: false
  prospectiveValidated: false
  holderExecutableExit: false
  currentSource: ConditionalGrossFlowCurrentSource
  request: ConditionalGrossFlowRequest
  target: {
    kind: 'next_observed_historical_window'
    horizonBlocks: 256
    durationSeconds: typeof NEXT_WINDOW_SECONDS
    earliestAt: string
    latestAt: string
  }
  method: 'per_joint_window_capacity_floor_then_subtract_q_once'
  quantiles: 'joint_empirical_order_statistic_floor_n_minus_one_p'
  capacity: JointDistribution
  userHeadroom: JointDistribution
  historicalScenarioFraction: {
    claim: 'historical_scenario_fraction_not_calibrated_probability'
    coveringQ: number
    sampleCount: 78
  }
  scenarios: {
    originBlock: number
    targetBlock: number
    netFlowRaw: string
    capacityRaw: string
    userHeadroomRaw: string
  }[]
  evidence: HistoricalCompetingFlowEstimate['source'] & { windowCount: 78 }
  historicalFlow: HistoricalCompetingFlowEstimate
}
export type ConditionalGrossFlowHeadroom =
  | ConditionalGrossFlowProjection
  | {
      status: 'unavailable'
      reason:
        | 'missing_fresh_source'
        | 'current_source_invalid'
        | 'identity_mismatch'
        | 'requested_q_invalid'
        | 'time_invalid'
        | 'verified_flow_unavailable'
        | 'historical_training_after_source'
        | 'future_window_unavailable'
        | 'source_stale'
    }
const unavailable = (
  reason: Extract<ConditionalGrossFlowHeadroom, { status: 'unavailable' }>['reason'],
): ConditionalGrossFlowHeadroom => ({ status: 'unavailable', reason })
// BigInt division truncates toward zero; negative mean headroom needs mathematical floor.
const floorDivide = (value: bigint, divisor: bigint) =>
  value / divisor - (value < 0n && value % divisor !== 0n ? 1n : 0n)
function distribution(values: bigint[]): JointDistribution {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const total = values.reduce((sum, value) => sum + value, 0n)
  return {
    mean: {
      numeratorRaw: total.toString(),
      denominator: 78,
      floorRaw: floorDivide(total, 78n).toString(),
    },
    p10Raw: sorted[7].toString(),
    p90Raw: sorted[69].toString(),
    minimumRaw: sorted[0].toString(),
    maximumRaw: sorted[77].toString(),
  }
}

/** A future cash scenario, never proof that a holder can execute any exit. */
export function buildConditionalGrossFlowHeadroom(
  input: ConditionalGrossFlowProjectionInput,
  hash: Hash,
): ConditionalGrossFlowHeadroom {
  try {
    if (!record(input) || input.currentSource === null || input.currentSource === undefined)
      return unavailable('missing_fresh_source')
    const source = input.currentSource
    if (
      !record(source) ||
      !raw(source.cashRaw) ||
      source.finalized !== true ||
      !Number.isSafeInteger(source.blockNumber) ||
      source.blockNumber < 0 ||
      typeof source.blockHash !== 'string' ||
      !/^0x[0-9a-fA-F]{64}$/.test(source.blockHash)
    )
      return unavailable('current_source_invalid')
    if (
      source.chainId !== 1 ||
      source.routeKey !== AAVE_COMPETING_FLOW_IDENTITY.routeKey ||
      !address(source.destination) ||
      source.destination.toLowerCase() !== AAVE_COMPETING_FLOW_IDENTITY.destination ||
      !address(source.asset) ||
      source.asset.toLowerCase() !== AAVE_COMPETING_FLOW_IDENTITY.asset ||
      source.assetDecimals !== 6
    )
      return unavailable('identity_mismatch')
    const request = input.request
    if (!record(request) || !raw(request.requestedRaw) || BigInt(request.requestedRaw) === 0n)
      return unavailable('requested_q_invalid')
    if (!stamp(source.blockTime) || !stamp(source.readAt) || !stamp(request.asOf))
      return unavailable('time_invalid')
    const at = Date.parse(source.blockTime),
      readAt = Date.parse(source.readAt),
      asOf = Date.parse(request.asOf)
    if (at > readAt || readAt > asOf || at > asOf) return unavailable('time_invalid')
    const flow = selectedHistoricalCompetingFlowEstimate(
      input.historicalFlow,
      AAVE_COMPETING_FLOW_IDENTITY,
      hash,
    )
    if (
      !flow ||
      flow.timeCoverage.boundedWindows !== 78 ||
      flow.timeCoverage.durationSeconds?.lowerSeconds !== NEXT_WINDOW_SECONDS.lowerSeconds ||
      flow.timeCoverage.durationSeconds.upperSeconds !== NEXT_WINDOW_SECONDS.upperSeconds
    )
      return unavailable('verified_flow_unavailable')
    if (flow.windows.some((window) => window.targetBlock > source.blockNumber))
      return unavailable('historical_training_after_source')
    const earliest = at + NEXT_WINDOW_SECONDS.lowerSeconds * 1000,
      latest = at + NEXT_WINDOW_SECONDS.upperSeconds * 1000
    const earliestAt = new Date(earliest).toISOString(),
      latestAt = new Date(latest).toISOString()
    if (!stamp(earliestAt) || !stamp(latestAt)) return unavailable('time_invalid')
    if (earliest <= asOf) return unavailable('future_window_unavailable')
    if (asOf - at > CONDITIONAL_FLOW_SOURCE_MAX_AGE_SECONDS * 1000)
      return unavailable('source_stale')
    const cash = BigInt(source.cashRaw),
      q = BigInt(request.requestedRaw)
    const capacities: bigint[] = [],
      headrooms: bigint[] = []
    const scenarios = flow.windows.map((window) => {
      const delta = BigInt(window.grossReserveInRaw) - BigInt(window.grossReserveOutRaw)
      const translated = cash + delta,
        capacity = translated < 0n ? 0n : translated
      const userHeadroom = capacity - q
      capacities.push(capacity)
      headrooms.push(userHeadroom)
      return {
        originBlock: window.originBlock,
        targetBlock: window.targetBlock,
        netFlowRaw: delta.toString(),
        capacityRaw: capacity.toString(),
        userHeadroomRaw: userHeadroom.toString(),
      }
    })
    return {
      status: 'estimated',
      claim: 'conditional_capacity_projection',
      assumption: 'repeat_historical_joint_flows_and_unchanged_mechanical_conditions',
      forecastValidated: false,
      prospectiveValidated: false,
      holderExecutableExit: false,
      currentSource: {
        chainId: 1,
        routeKey: source.routeKey,
        destination: source.destination.toLowerCase(),
        asset: source.asset.toLowerCase(),
        assetDecimals: 6,
        cashRaw: source.cashRaw,
        blockNumber: source.blockNumber,
        blockHash: source.blockHash.toLowerCase(),
        blockTime: source.blockTime,
        readAt: source.readAt,
        finalized: true,
      },
      request: { requestedRaw: request.requestedRaw, asOf: request.asOf },
      target: {
        kind: 'next_observed_historical_window',
        horizonBlocks: 256,
        durationSeconds: { ...NEXT_WINDOW_SECONDS },
        earliestAt,
        latestAt,
      },
      method: 'per_joint_window_capacity_floor_then_subtract_q_once',
      quantiles: 'joint_empirical_order_statistic_floor_n_minus_one_p',
      capacity: distribution(capacities),
      userHeadroom: distribution(headrooms),
      historicalScenarioFraction: {
        claim: 'historical_scenario_fraction_not_calibrated_probability',
        coveringQ: headrooms.filter((value) => value >= 0n).length,
        sampleCount: 78,
      },
      scenarios,
      evidence: { ...flow.source, windowCount: 78 },
      historicalFlow: flow,
    }
  } catch {
    return unavailable('verified_flow_unavailable')
  }
}

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? ['array', value.map(canonical)]
    : record(value)
      ? [
          'object',
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, canonical(item)]),
        ]
      : [value === null ? 'null' : typeof value, value]

/** Externally bind fresh source/Q/time, then rederive every mathematical and evidence fact. */
export function selectedConditionalGrossFlowHeadroom(
  value: unknown,
  binding: {
    currentSource: ConditionalGrossFlowCurrentSource | null
    request: ConditionalGrossFlowRequest
  },
  hash: Hash,
): ConditionalGrossFlowProjection | null {
  try {
    if (!record(value) || value.status !== 'estimated' || !record(binding)) return null
    const expected = buildConditionalGrossFlowHeadroom(
      { ...binding, historicalFlow: value.historicalFlow },
      hash,
    )
    return expected.status === 'estimated' &&
      JSON.stringify(canonical(value)) === JSON.stringify(canonical(expected))
      ? expected
      : null
  } catch {
    return null
  }
}
