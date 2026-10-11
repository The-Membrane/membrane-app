import {
  selectedConditionalSampledCashPathProjection,
  registeredConditionalSampledCashIdentity,
  type ConditionalSampledCashCurrentSource,
  type ConditionalSampledCashDistribution,
  type ConditionalSampledCashScenario,
} from './conditionalSampledCashPathProjection'
import { selectedHolderExitCapacity, type HolderExitCapacityBinding } from './holderExitCapacity'
import { DIRECT_SUPPLY_MARKETS } from './directSupplyMarketConstants'

export type CometHolderCapacityInput = {
  cashProjection: unknown
  capacityAgreement: unknown
  cometFactsAgreement: unknown
  binding: HolderExitCapacityBinding
  currentSource: ConditionalSampledCashCurrentSource
  horizonHours: number
  asOfMs: number
}
type Bracket = { earliestAt: string; latestAt: string }
export type CometHolderCapacityProjection = {
  status: 'conditional_comet_holder_capacity_projection'
  input: CometHolderCapacityInput
  owner: string
  request: { requestedRaw: string; horizonHours: number; asOf: string }
  fullPositionEntitlementRaw: string
  withdrawalsPaused: boolean | null
  pauseEvidence: 'two_origin_getter_agreement' | 'unknown'
  supplyInterestMode: 'unmodeled_held_constant'
  sourceImplementationEquivalence: false
  withdrawalEligibility: 'conditional_unchanged_pause_self_authority_and_token_transfer_rules'
  continuousPathKnown: false
  scope: 'entitlement_clipped_conditional_scenario'
  method: 'translated_physical_cash_then_unchanged_pause_then_full_entitlement_then_q_once'
  assumption: 'repeat_joint_net_cash_paths_with_unchanged_supplied_entitlement_pause_and_withdrawal_rules'
  scenarios: (ConditionalSampledCashScenario & { physicalCashRaw: string[]; targets: Bracket[] })[]
  horizons: {
    observation: number
    target: Bracket & { lowerSeconds: number; upperSeconds: number }
    capacity: ConditionalSampledCashDistribution
    userHeadroom: ConditionalSampledCashDistribution
    historicalScenariosCoveringQ: number
  }[]
  troughCapacity: ConditionalSampledCashDistribution
  troughHeadroom: ConditionalSampledCashDistribution
  holderExecutableExit: false
  executableMaximum: false
  forwardProbability: false
  forecastValidated: false
  prospectiveValidated: false
  minedPayoutObserved: false
  grossFlowAdded: false
}
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const exact = (a: unknown, b: unknown): boolean => {
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => exact(v, b[i]))
    )
  if (record(a) || record(b))
    return (
      record(a) &&
      record(b) &&
      Object.keys(a).length === Object.keys(b).length &&
      Object.keys(a).every((k) => Object.hasOwn(b, k) && exact(a[k], b[k]))
    )
  return Object.is(a, b)
}
const MARKET = DIRECT_SUPPLY_MARKETS.compoundV3Usdc
const sameCometIdentity = (
  v: unknown,
): v is { routeKey: string; destination: string; asset: string; assetDecimals: number } =>
  record(v) &&
  v.routeKey === MARKET.routeKey &&
  v.destination === MARKET.destination.toLowerCase() &&
  v.asset === MARKET.underlying.toLowerCase() &&
  v.assetDecimals === MARKET.decimals
export type CometWithdrawFacts = {
  status: 'comet_withdraw_getter_observed'
  routeKey: string
  destination: string
  asset: string
  assetDecimals: number
  source: HolderExitCapacityBinding['currentSource']
  withdrawalsPaused: boolean | null
}
export type CometWithdrawFactsAgreement = {
  status: 'two_origin_comet_withdraw_facts'
  facts: CometWithdrawFacts
  origins: [
    { host: string; facts: CometWithdrawFacts },
    { host: string; facts: CometWithdrawFacts },
  ]
}
const utc = (v: unknown): v is string =>
  typeof v === 'string' &&
  Number.isSafeInteger(Date.parse(v)) &&
  new Date(Date.parse(v)).toISOString() === v
function validCometFacts(v: unknown, now: number): v is CometWithdrawFacts {
  if (
    !sameCometIdentity(v) ||
    !record(v) ||
    v.status !== 'comet_withdraw_getter_observed' ||
    !record(v.source)
  )
    return false
  const source = v.source
  return (
    (v.withdrawalsPaused === null || typeof v.withdrawalsPaused === 'boolean') &&
    Object.keys(v).length === 7 &&
    Object.keys(source).length === 5 &&
    source.chainId === 1 &&
    source.finalized === true &&
    Number.isSafeInteger(source.blockNumber) &&
    (source.blockNumber as number) > 0 &&
    typeof source.blockHash === 'string' &&
    /^0x[a-f0-9]{64}$/.test(source.blockHash) &&
    utc(source.blockTime) &&
    Number.isSafeInteger(now) &&
    now >= Date.parse(source.blockTime) &&
    now - Date.parse(source.blockTime) <= 1800000
  )
}
function host(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    v.length <= 253 &&
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(v)
  )
}
/** Optional pause disagreement remains unknown and never changes execution/entitlement agreement. */
export function agreeCometWithdrawFacts(
  first: { host: string; facts: unknown },
  second: { host: string; facts: unknown },
  asOfMs: number,
): CometWithdrawFactsAgreement | null {
  try {
    if (
      !record(first) ||
      !record(second) ||
      !host(first.host) ||
      !host(second.host) ||
      first.host === second.host ||
      !validCometFacts(first.facts, asOfMs) ||
      !validCometFacts(second.facts, asOfMs)
    )
      return null
    const a = first.facts,
      b = second.facts
    if (!exact({ ...a, withdrawalsPaused: null }, { ...b, withdrawalsPaused: null })) return null
    return {
      status: 'two_origin_comet_withdraw_facts',
      facts: {
        ...structuredClone(a),
        withdrawalsPaused: a.withdrawalsPaused === b.withdrawalsPaused ? a.withdrawalsPaused : null,
      },
      origins: [
        structuredClone(first) as { host: string; facts: CometWithdrawFacts },
        structuredClone(second) as { host: string; facts: CometWithdrawFacts },
      ],
    }
  } catch {
    return null
  }
}
export function selectedCometWithdrawFacts(
  value: unknown,
  expected: {
    routeKey: string
    destination: string
    asset: string
    assetDecimals: number
    source: HolderExitCapacityBinding['currentSource']
    asOfMs: number
  },
): CometWithdrawFactsAgreement | null {
  try {
    if (
      !record(value) ||
      !Array.isArray(value.origins) ||
      value.origins.length !== 2 ||
      !sameCometIdentity(expected)
    )
      return null
    const rebuilt = agreeCometWithdrawFacts(value.origins[0], value.origins[1], expected.asOfMs)
    return rebuilt && exact(value, rebuilt) && exact(rebuilt.facts.source, expected.source)
      ? rebuilt
      : null
  } catch {
    return null
  }
}
function distribution(values: bigint[]): ConditionalSampledCashDistribution {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    sum = values.reduce((a, b) => a + b, 0n),
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
export function buildCometHolderCapacityProjection(
  input: CometHolderCapacityInput,
  hash: (s: string) => string,
): CometHolderCapacityProjection | null {
  try {
    // A replay/hash callback cannot change the approved caller state used later.
    input = structuredClone(input)
    if (
      !record(input) ||
      !record(input.binding) ||
      !record(input.currentSource) ||
      !Number.isSafeInteger(input.asOfMs) ||
      !Number.isSafeInteger(input.horizonHours) ||
      input.horizonHours < 1 ||
      input.horizonHours > 8760
    )
      return null
    const s = input.currentSource,
      b = input.binding
    const identity = registeredConditionalSampledCashIdentity(s.routeKey, s.destination)
    if (
      !identity ||
      !sameCometIdentity(identity) ||
      !exact(identity, {
        routeKey: s.routeKey,
        destination: s.destination,
        asset: s.asset,
        assetDecimals: s.assetDecimals,
      }) ||
      typeof s.block !== 'string' ||
      !/^[1-9][0-9]*$/.test(s.block) ||
      !Number.isSafeInteger(Number(s.block)) ||
      b.routeKey !== s.routeKey ||
      b.destination !== s.destination ||
      b.asset !== s.asset ||
      b.assetDecimals !== s.assetDecimals ||
      b.asOfMs !== input.asOfMs ||
      !exact(b.currentSource, {
        chainId: 1,
        blockNumber: Number(s.block),
        blockHash: s.blockHash,
        blockTime: s.blockTime,
        finalized: true,
      })
    )
      return null
    const cash = selectedConditionalSampledCashPathProjection(
      input.cashProjection,
      { identity, requestedRaw: b.requestedRaw, currentSource: s, asOfMs: input.asOfMs },
      hash,
    )
    const capacity = selectedHolderExitCapacity(input.capacityAgreement, b)
    if (
      !cash ||
      cash.scenarios.some((path) =>
        path.capacityRaw.some(
          (raw) =>
            typeof raw !== 'string' ||
            !/^(0|[1-9][0-9]*)$/.test(raw) ||
            raw.length > 78 ||
            BigInt(raw) >= 1n << 256n,
        ),
      ) ||
      !capacity ||
      capacity.quote.entitlementMethod !== 'supplied_balance' ||
      typeof capacity.quote.entitlementRaw !== 'string'
    )
      return null
    const fullE = BigInt(capacity.quote.entitlementRaw),
      q = BigInt(b.requestedRaw),
      pauseFacts = selectedCometWithdrawFacts(input.cometFactsAgreement, {
        ...identity,
        source: b.currentSource,
        asOfMs: input.asOfMs,
      }),
      paused = pauseFacts?.facts.withdrawalsPaused ?? null,
      sourceAt = Date.parse(s.blockTime)
    const scenarios = cash.scenarios.map((path) => {
      const caps = path.capacityRaw.map((raw) =>
          paused ? 0n : BigInt(raw) < fullE ? BigInt(raw) : fullE,
        ),
        margins = caps.map((c) => c - q)
      let trough = 0
      caps.forEach((c, i) => {
        if (c < caps[trough]) trough = i
      })
      const target = (i: number) => new Date(sourceAt + path.elapsedSeconds[i] * 1000).toISOString()
      const runs: ConditionalSampledCashScenario['sampledShortfalls'] = []
      for (let i = 0; i < margins.length; i++) {
        if (margins[i] >= 0n) continue
        const first = i
        while (i + 1 < margins.length && margins[i + 1] < 0n) i++
        runs.push({
          firstBelowObservation: first,
          lastBelowObservation: i,
          onset: first === 0 ? null : { earliestAt: target(first - 1), latestAt: target(first) },
          recovery:
            i === margins.length - 1 ? null : { earliestAt: target(i), latestAt: target(i + 1) },
          leftCensored: first === 0,
          rightCensored: i === margins.length - 1,
          sampledSpanSeconds: path.elapsedSeconds[i] - path.elapsedSeconds[first],
        })
      }
      return {
        episodeIndex: path.episodeIndex,
        originAnchorIndex: path.originAnchorIndex,
        elapsedSeconds: [...path.elapsedSeconds],
        physicalCashRaw: [...path.capacityRaw],
        capacityRaw: caps.map(String),
        userHeadroomRaw: margins.map(String),
        targets: path.elapsedSeconds.map((_, i) => ({
          earliestAt: target(i),
          latestAt: target(i),
        })),
        troughObservation: trough,
        sampledShortfalls: runs,
      }
    })
    const horizons = cash.horizons.map((h) => ({
      observation: h.observation,
      target: { ...h.target },
      capacity: distribution(scenarios.map((p) => BigInt(p.capacityRaw[h.observation]))),
      userHeadroom: distribution(scenarios.map((p) => BigInt(p.userHeadroomRaw[h.observation]))),
      historicalScenariosCoveringQ: scenarios.filter(
        (p) => BigInt(p.userHeadroomRaw[h.observation]) >= 0n,
      ).length,
    }))
    return {
      status: 'conditional_comet_holder_capacity_projection',
      input: structuredClone(input),
      owner: capacity.quote.owner,
      request: {
        requestedRaw: b.requestedRaw,
        horizonHours: input.horizonHours,
        asOf: new Date(input.asOfMs).toISOString(),
      },
      fullPositionEntitlementRaw: fullE.toString(),
      withdrawalsPaused: paused,
      pauseEvidence: typeof paused === 'boolean' ? 'two_origin_getter_agreement' : 'unknown',
      supplyInterestMode: 'unmodeled_held_constant',
      sourceImplementationEquivalence: false,
      withdrawalEligibility: 'conditional_unchanged_pause_self_authority_and_token_transfer_rules',
      continuousPathKnown: false,
      scope: 'entitlement_clipped_conditional_scenario',
      method: 'translated_physical_cash_then_unchanged_pause_then_full_entitlement_then_q_once',
      assumption:
        'repeat_joint_net_cash_paths_with_unchanged_supplied_entitlement_pause_and_withdrawal_rules',
      scenarios,
      horizons,
      troughCapacity: distribution(
        scenarios.map((p) => BigInt(p.capacityRaw[p.troughObservation])),
      ),
      troughHeadroom: distribution(
        scenarios.map((p) => BigInt(p.userHeadroomRaw[p.troughObservation])),
      ),
      holderExecutableExit: false,
      executableMaximum: false,
      forwardProbability: false,
      forecastValidated: false,
      prospectiveValidated: false,
      minedPayoutObserved: false,
      grossFlowAdded: false,
    }
  } catch {
    return null
  }
}
export function selectedCometHolderCapacityProjection(
  value: unknown,
  expected: CometHolderCapacityInput,
  hash: (s: string) => string,
): CometHolderCapacityProjection | null {
  try {
    value = structuredClone(value)
    expected = structuredClone(expected)
    if (
      !record(value) ||
      !record(value.input) ||
      !Number.isSafeInteger(value.input.asOfMs) ||
      !Number.isSafeInteger(expected.asOfMs) ||
      (value.input.asOfMs as number) > expected.asOfMs ||
      !buildCometHolderCapacityProjection(expected, hash)
    )
      return null
    const issuedAt = value.input.asOfMs as number
    const issued = buildCometHolderCapacityProjection(
      { ...expected, asOfMs: issuedAt, binding: { ...expected.binding, asOfMs: issuedAt } },
      hash,
    )
    return issued && exact(value, issued) ? issued : null
  } catch {
    return null
  }
}
