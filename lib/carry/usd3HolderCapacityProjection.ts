import type { buildConditionalTimeProcess } from '../venueForecast/conditionalTimeProcess'
import {
  selectedConditionalSampledCashPathProjection,
  registeredConditionalSampledCashIdentity,
  type ConditionalSampledCashCurrentSource,
  type ConditionalSampledCashDistribution,
} from './conditionalSampledCashPathProjection'
import { selectedHolderExitCapacity, type HolderExitCapacityBinding } from './holderExitCapacity'
import { resolveHolderExitSubject } from './holderExitSubjectRegistry'

export type Usd3HolderCapacityInput = {
  cashProjection: unknown
  capacityAgreement: unknown
  binding: HolderExitCapacityBinding
  currentSource: ConditionalSampledCashCurrentSource
  horizonHours: number
  asOfMs: number
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
/** Legacy wire shape retained while callers move to the separately qualified native process. */
export type Usd3HolderCapacityProjection = {
  status: 'conditional_usd3_holder_capacity_projection'
  input: Usd3HolderCapacityInput
  owner: string
  assetSymbol: 'USDC'
  request: { requestedRaw: string; horizonHours: number; asOf: string }
  fullPositionEntitlementRaw: string
  sourceOwnerMaximumRaw: string
  futureWithdrawalRestrictions: string
  completeHolderAbility: boolean
  scope: string
  method: 'constant_historical_net_flow_rate_then_independent_full_entitlement_then_q_once'
  assumption: 'constant_historical_net_flow_rate_with_unchanged_share_value_funding_and_restriction_regime'
  process: NonNullable<ReturnType<typeof buildConditionalTimeProcess>>
  horizons: {
    target: { earliestAt: string; latestAt: string; lowerSeconds: number; upperSeconds: number }
    capacity: ConditionalSampledCashDistribution
    userHeadroom: ConditionalSampledCashDistribution
    historicalScenariosCoveringQ: number
  }[]
  holderExecutableExit: boolean
  executableMaximum: boolean
  forwardProbability: boolean
  forecastValidated: boolean
  prospectiveValidated: boolean
  minedPayoutObserved: boolean
  grossFlowAdded: boolean
}
/** Idle USDC is diagnostic only. Native donor funding history must qualify a future bound. */
export function buildUsd3HolderCapacityProjection(
  input: Usd3HolderCapacityInput,
  hash: (s: string) => string,
): Usd3HolderCapacityProjection | null {
  try {
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
      resolveHolderExitSubject(identity.routeKey, identity.destination as `0x${string}`).kind !==
        'usd3' ||
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
      typeof capacity.quote.entitlementRaw !== 'string' ||
      capacity.quote.quotedLimitMethod !== 'max_withdraw_owner' ||
      capacity.quote.quotedMaxWithdrawStatus !== 'quoted' ||
      typeof capacity.quote.quotedMaxWithdrawRaw !== 'string'
    )
      return null
    // The admitted source class is aggregate idle vault USDC. Strategy assets can
    // fund withdrawals with zero idle USDC, so these donors cannot bound funding.
    // A source-block native quote cannot authenticate historical idle donor deltas.
    // Preserve the caller's cash diagnostic; null is unavailable, never C=0.
    return null
  } catch {
    return null
  }
}
export function selectedUsd3HolderCapacityProjection(
  value: unknown,
  expected: Usd3HolderCapacityInput,
  hash: (s: string) => string,
) {
  try {
    if (
      !record(value) ||
      !record(value.input) ||
      !Number.isSafeInteger(value.input.asOfMs) ||
      !Number.isSafeInteger(expected.asOfMs) ||
      (value.input.asOfMs as number) > expected.asOfMs ||
      !buildUsd3HolderCapacityProjection(expected, hash)
    )
      return null
    const issuedAt = value.input.asOfMs as number
    const issued = buildUsd3HolderCapacityProjection(
      { ...expected, asOfMs: issuedAt, binding: { ...expected.binding, asOfMs: issuedAt } },
      hash,
    )
    return issued && exact(value, issued) ? issued : null
  } catch {
    return null
  }
}
