import {
  selectedConditionalSampledCashPathProjection,
  registeredConditionalSampledCashIdentity,
  type ConditionalSampledCashCurrentSource,
  type ConditionalSampledCashDistribution,
  type ConditionalSampledCashScenario,
} from './conditionalSampledCashPathProjection'
import { selectedHolderExitCapacity, type HolderExitCapacityBinding } from './holderExitCapacity'
import { resolveHolderExitSubject } from './holderExitSubjectRegistry'

export type MorphoVaultCapacityInput = {
  cashProjection: unknown
  capacityAgreement: unknown
  binding: HolderExitCapacityBinding
  currentSource: ConditionalSampledCashCurrentSource
  horizonHours: number
  asOfMs: number
}
type Bracket = { earliestAt: string; latestAt: string }
export type MorphoVaultCapacityProjection = {
  status: 'conditional_morpho_vault_capacity_projection'
  input: MorphoVaultCapacityInput
  owner: string
  request: { requestedRaw: string; horizonHours: number; asOf: string }
  fullPositionEntitlementRaw: string
  configuredAdapterLiquidity: null
  adapterLiquidityMode: 'unmodeled_not_zero'
  holderFailureForecast: false
  totalExitCapacity: false
  withdrawalEligibility: 'conditional_unmodeled_adapter_and_restriction_rules'
  scope: 'conditional_idle_cash_entitlement_headroom'
  method: 'translated_idle_cash_then_full_entitlement_then_q_once'
  assumption: 'repeat_joint_idle_cash_paths_with_unchanged_entitlement_and_conditional_withdrawal_eligibility'
  scenarios: (ConditionalSampledCashScenario & { idleCashRaw: string[]; targets: Bracket[] })[]
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
export function buildMorphoVaultCapacityProjection(
  input: MorphoVaultCapacityInput,
  hash: (s: string) => string,
): MorphoVaultCapacityProjection | null {
  try {
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
      resolveHolderExitSubject(identity.routeKey, identity.destination as `0x${string}`).kind !==
        'morpho' ||
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
      capacity.quote.entitlementMethod !== 'preview_redeem_full_position' ||
      typeof capacity.quote.entitlementRaw !== 'string'
    )
      return null
    const fullE = BigInt(capacity.quote.entitlementRaw),
      q = BigInt(b.requestedRaw),
      sourceAt = Date.parse(s.blockTime)
    const scenarios = cash.scenarios.map((path) => {
      const caps = path.capacityRaw.map((raw) => (BigInt(raw) < fullE ? BigInt(raw) : fullE)),
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
        idleCashRaw: [...path.capacityRaw],
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
      status: 'conditional_morpho_vault_capacity_projection',
      input: structuredClone(input),
      owner: capacity.quote.owner,
      request: {
        requestedRaw: b.requestedRaw,
        horizonHours: input.horizonHours,
        asOf: new Date(input.asOfMs).toISOString(),
      },
      fullPositionEntitlementRaw: fullE.toString(),
      configuredAdapterLiquidity: null,
      adapterLiquidityMode: 'unmodeled_not_zero',
      holderFailureForecast: false,
      totalExitCapacity: false,
      withdrawalEligibility: 'conditional_unmodeled_adapter_and_restriction_rules',
      scope: 'conditional_idle_cash_entitlement_headroom',
      method: 'translated_idle_cash_then_full_entitlement_then_q_once',
      assumption:
        'repeat_joint_idle_cash_paths_with_unchanged_entitlement_and_conditional_withdrawal_eligibility',
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
export function selectedMorphoVaultCapacityProjection(
  value: unknown,
  expected: MorphoVaultCapacityInput,
  hash: (s: string) => string,
): MorphoVaultCapacityProjection | null {
  try {
    if (
      !record(value) ||
      !record(value.input) ||
      !Number.isSafeInteger(value.input.asOfMs) ||
      !Number.isSafeInteger(expected.asOfMs) ||
      (value.input.asOfMs as number) > expected.asOfMs ||
      !buildMorphoVaultCapacityProjection(expected, hash)
    )
      return null
    const issuedAt = value.input.asOfMs as number
    const issued = buildMorphoVaultCapacityProjection(
      { ...expected, asOfMs: issuedAt, binding: { ...expected.binding, asOfMs: issuedAt } },
      hash,
    )
    return issued && exact(value, issued) ? issued : null
  } catch {
    return null
  }
}
