import type { HolderExitAssessment } from './holderExitAssessment'
import { keccak256 } from 'viem'
import {
  USD3_VAULT,
  USD3_IMPLEMENTATION,
  USD3_TOKENIZED_STRATEGY,
  USDC_ASSET,
  type Usd3NativeCapacityFact,
} from './usd3ExitQuote'
import {
  assessHolderExitConditionalProjection,
  resolveIssuedHolderExitSubject,
  type HolderExitConditionalProjectionEvidence,
} from './holderExitMechanisms'
import { resolveHolderExitSubject } from './holderExitSubjectRegistry'
import {
  replayFluidUsdcBridgeNativeCapacityFact,
  FLUID_USDC_BRIDGE_NATIVE_ROUTE,
  FLUID_USDC_BRIDGE_NATIVE_VAULT,
  FLUID_USDC_BRIDGE_NATIVE_ASSET,
  type FluidUsdcBridgeNativeCapacityFact,
} from './fluidUsdcBridgeNativeCapacity'

export const HOLDER_CAPACITY_SOURCE_MAX_AGE_MS = 30 * 60 * 1000
export type HolderExitCapacityFacts = {
  entitlementRaw: string | null
  quotedMaxWithdrawRaw: string | null
  quotedMaxWithdrawStatus: 'quoted' | 'not_read' | 'unsupported' | 'unavailable'
  effectiveLimitRaw: string | null
  withdrawalsPaused: boolean | null
  fullPositionEntitlementRaw?: string | null
  usd3NativeCapacity?: Usd3NativeCapacityFact
  fluidUsdcBridgeNativeCapacity?: FluidUsdcBridgeNativeCapacityFact
  /** Native source-block holder balance; independent of the withdrawal request. */
  sourceHolderPosition?: {
    sharesRaw: string
    shareDecimals: number
    method: 'balance_of_owner_at_source'
  }
}
export type HolderExitCapacityQuote = HolderExitCapacityFacts & {
  status: 'holder_capacity_quote'
  scope: 'existing_holder_position'
  routeKey: string
  destination: string
  owner: string
  requestedRaw: string
  asset: string
  assetDecimals: number
  source: { chainId: 1; blockNumber: number; blockHash: string; blockTime: string; finalized: true }
  entitlementMethod:
    | 'supplied_balance'
    | 'preview_redeem_full_position'
    | 'preview_redeem_currently_redeemable'
    | 'unavailable'
  quotedLimitMethod: 'max_withdraw_owner' | 'unavailable'
  effectiveLimitMethod: 'paused_then_min_max_withdraw_and_redeemable_entitlement' | 'unavailable'
  fullPositionEntitlementMethod?: 'preview_redeem_full_position' | 'unavailable'
  successfulRequestedRawLowerBound: string | null
  aggregateAccessibleLiquidityRaw: null
  hypotheticalDepositCapacityRaw: null
  holderExecutableExit: false
  futureCapacityValidated: false
  forecastValidated: false
  prospectiveValidated: false
  minedPayoutObserved: false
}
export type HolderExitCapacityAgreement = {
  status: 'two_origin_holder_capacity_quote'
  quote: HolderExitCapacityQuote
  origins: [
    { host: string; quote: HolderExitCapacityQuote },
    { host: string; quote: HolderExitCapacityQuote },
  ]
}
export type HolderExitCapacityBinding = {
  routeKey: string
  destination: string
  owner: string
  requestedRaw: string
  asset: string
  assetDecimals: number
  currentSource: HolderExitCapacityQuote['source']
  asOfMs: number
  /** Independent execution evidence; capacity quote metadata is never its authority. */
  executionAgreement?: unknown
}
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const raw = (v: unknown): v is string =>
  typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) < 1n << 256n
const address = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-f]{40}$/.test(v)
const utc = (v: unknown): v is string =>
  typeof v === 'string' &&
  Number.isSafeInteger(Date.parse(v)) &&
  new Date(Date.parse(v)).toISOString() === v
const source = (v: unknown, now: number): v is HolderExitCapacityQuote['source'] =>
  record(v) &&
  v.chainId === 1 &&
  v.finalized === true &&
  Number.isSafeInteger(v.blockNumber) &&
  (v.blockNumber as number) > 0 &&
  typeof v.blockHash === 'string' &&
  /^0x[0-9a-f]{64}$/.test(v.blockHash) &&
  utc(v.blockTime) &&
  Number.isSafeInteger(now) &&
  now >= Date.parse(v.blockTime) &&
  now - Date.parse(v.blockTime) <= HOLDER_CAPACITY_SOURCE_MAX_AGE_MS
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
const host = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length <= 253 &&
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(v)
/** Capacity units only: this never registers the staged bridge as atomic execution. */
export function resolveHolderExitCapacitySubject(routeKey: string, destination: string) {
  const atomic = resolveIssuedHolderExitSubject(routeKey, destination)
  if (atomic) return atomic
  if (
    routeKey !== FLUID_USDC_BRIDGE_NATIVE_ROUTE ||
    typeof destination !== 'string' ||
    destination.toLowerCase() !== FLUID_USDC_BRIDGE_NATIVE_VAULT
  )
    return null
  return {
    canonicalFinalAsset: {
      chainId: 1 as const,
      address: FLUID_USDC_BRIDGE_NATIVE_ASSET,
      decimals: 6,
    },
  }
}
function methods(routeKey: string, destination: string) {
  const kind = resolveHolderExitSubject(routeKey, destination as `0x${string}`).kind
  return {
    kind,
    entitlement:
      kind === 'direct'
        ? 'supplied_balance'
        : ['morpho', 'tracked', 'susds', 'usd3'].includes(kind)
          ? 'preview_redeem_full_position'
          : kind === 'sgho'
            ? 'preview_redeem_currently_redeemable'
            : 'unavailable',
    limit: ['morpho', 'tracked', 'sgho', 'susds', 'usd3'].includes(kind)
      ? 'max_withdraw_owner'
      : 'unavailable',
    effective:
      kind === 'sgho' ? 'paused_then_min_max_withdraw_and_redeemable_entitlement' : 'unavailable',
  } as const
}
/** Reconstruct the native observation from bound identities and raw runtime bytes. */
function validUsd3NativeCapacity(
  value: unknown,
  kind: string,
  owner: string,
  asset: string,
  assetDecimals: number,
  boundSource: HolderExitCapacityQuote['source'],
  asOfMs: number,
): value is Usd3NativeCapacityFact {
  if (
    kind !== 'usd3' ||
    !record(value) ||
    value.owner !== owner ||
    asset !== USDC_ASSET ||
    assetDecimals !== 6 ||
    value.asset !== asset ||
    value.assetDecimals !== 6 ||
    value.unit !== 'raw_usdc_6' ||
    value.method !== 'availableWithdrawLimit(address)' ||
    !['quoted', 'unsupported', 'unavailable'].includes(value.resultStatus as string) ||
    (value.capacityRaw !== null && !raw(value.capacityRaw)) ||
    (value.resultStatus === 'quoted') !== (value.capacityRaw !== null) ||
    (Object.hasOwn(value, 'shutdown') &&
      value.shutdown !== null &&
      typeof value.shutdown !== 'boolean') ||
    (Object.hasOwn(value, 'readAtUtc') &&
      value.readAtUtc !== null &&
      (!utc(value.readAtUtc) ||
        Date.parse(value.readAtUtc) < Date.parse(boundSource.blockTime) ||
        Date.parse(value.readAtUtc) > asOfMs)) ||
    !exact(value.source, boundSource)
  )
    return false
  let runtimeProfile: Usd3NativeCapacityFact['runtimeProfile'] = null
  if (value.runtimeProfile !== null) {
    const profile = value.runtimeProfile
    if (!record(profile) || !Array.isArray(profile.contracts) || profile.contracts.length !== 4)
      return false
    const pins = [USD3_VAULT, USD3_IMPLEMENTATION, USD3_TOKENIZED_STRATEGY, USDC_ASSET]
    const contracts = [] as unknown as NonNullable<
      Usd3NativeCapacityFact['runtimeProfile']
    >['contracts']
    for (let i = 0; i < pins.length; i++) {
      const item = profile.contracts[i]
      if (
        !record(item) ||
        item.address !== pins[i] ||
        typeof item.code !== 'string' ||
        item.code.length > 65536 ||
        !/^0x(?:[0-9a-f]{2})+$/.test(item.code)
      )
        return false
      const code = item.code as `0x${string}`
      const expected = { address: pins[i], code, keccak256: keccak256(code) }
      if (!exact(item, expected)) return false
      contracts.push(expected)
    }
    runtimeProfile = { sourceClass: 'pinned_usd3_native_runtime', shareDecimals: 6, contracts }
    if (!exact(profile, runtimeProfile)) return false
  }
  return exact(value, {
    owner,
    method: 'availableWithdrawLimit(address)',
    asset,
    assetDecimals: 6,
    unit: 'raw_usdc_6',
    capacityRaw: value.capacityRaw,
    resultStatus: value.resultStatus,
    ...(Object.hasOwn(value, 'shutdown') ? { shutdown: value.shutdown } : {}),
    ...(Object.hasOwn(value, 'readAtUtc') ? { readAtUtc: value.readAtUtc } : {}),
    source: boundSource,
    runtimeProfile,
  })
}
function fullPositionFields(f: Pick<HolderExitCapacityFacts, 'fullPositionEntitlementRaw'>) {
  return Object.hasOwn(f, 'fullPositionEntitlementRaw')
    ? {
        fullPositionEntitlementRaw: f.fullPositionEntitlementRaw,
        fullPositionEntitlementMethod:
          f.fullPositionEntitlementRaw === null
            ? ('unavailable' as const)
            : ('preview_redeem_full_position' as const),
      }
    : {}
}
function validFluidBridgeNative(
  f: HolderExitCapacityFacts,
  routeKey: string,
  owner: string,
  currentSource: HolderExitCapacityQuote['source'],
  asOfMs: number,
) {
  if (!Object.hasOwn(f, 'fluidUsdcBridgeNativeCapacity')) return true
  if (routeKey !== FLUID_USDC_BRIDGE_NATIVE_ROUTE || !f.sourceHolderPosition) return false
  const replay = replayFluidUsdcBridgeNativeCapacityFact(
    f.fluidUsdcBridgeNativeCapacity,
    owner,
    currentSource,
    asOfMs,
  )
  return (
    !!replay &&
    replay.fullNetEaRaw === f.entitlementRaw &&
    replay.sharesRaw === f.sourceHolderPosition.sharesRaw &&
    f.sourceHolderPosition.shareDecimals === 18
  )
}
function validFacts(f: HolderExitCapacityFacts, m: ReturnType<typeof methods>) {
  if (
    Object.hasOwn(f, 'usd3NativeCapacity') &&
    f.sourceHolderPosition &&
    f.sourceHolderPosition.shareDecimals !== 6
  )
    return false
  if (Object.hasOwn(f, 'sourceHolderPosition')) {
    const position = f.sourceHolderPosition
    if (
      !record(position) ||
      Object.keys(position).length !== 3 ||
      !['sharesRaw', 'shareDecimals', 'method'].every((key) => Object.hasOwn(position, key)) ||
      !raw(position.sharesRaw) ||
      !Number.isInteger(position.shareDecimals) ||
      position.shareDecimals < 0 ||
      position.shareDecimals > 36 ||
      position.method !== 'balance_of_owner_at_source'
    )
      return false
  }
  if (Object.hasOwn(f, 'fullPositionEntitlementRaw')) {
    if (m.kind === 'usd3' && m.entitlement === 'preview_redeem_full_position') {
      // Both USD3 fields describe the same native previewRedeem(full S). This
      // includes the unavailable pair; neither field may invent an entitlement.
      if (
        f.fullPositionEntitlementRaw !== f.entitlementRaw ||
        (f.fullPositionEntitlementRaw !== null && !raw(f.fullPositionEntitlementRaw))
      )
        return false
    } else if (m.kind === 'sgho' && m.entitlement === 'preview_redeem_currently_redeemable') {
      if (
        f.fullPositionEntitlementRaw !== null &&
        (!raw(f.fullPositionEntitlementRaw) ||
          f.entitlementRaw === null ||
          !raw(f.entitlementRaw) ||
          BigInt(f.fullPositionEntitlementRaw) < BigInt(f.entitlementRaw))
      )
        return false
    } else return false
  }
  if (
    ![f.entitlementRaw, f.quotedMaxWithdrawRaw, f.effectiveLimitRaw].every(
      (v) => v === null || raw(v),
    )
  )
    return false
  if (m.entitlement === 'unavailable' && f.entitlementRaw !== null) return false
  if (
    !['quoted', 'not_read', 'unsupported', 'unavailable'].includes(f.quotedMaxWithdrawStatus) ||
    (f.quotedMaxWithdrawStatus === 'quoted') !== (f.quotedMaxWithdrawRaw !== null)
  )
    return false
  if (
    m.limit === 'unavailable' &&
    (f.quotedMaxWithdrawRaw !== null || f.quotedMaxWithdrawStatus !== 'not_read')
  )
    return false
  if (m.effective === 'unavailable')
    return f.effectiveLimitRaw === null && f.withdrawalsPaused === null
  if (
    typeof f.withdrawalsPaused !== 'boolean' ||
    f.entitlementRaw === null ||
    f.quotedMaxWithdrawRaw === null ||
    f.effectiveLimitRaw === null
  )
    return false
  const limit = f.withdrawalsPaused
    ? 0n
    : BigInt(f.entitlementRaw) < BigInt(f.quotedMaxWithdrawRaw)
      ? BigInt(f.entitlementRaw)
      : BigInt(f.quotedMaxWithdrawRaw)
  return f.effectiveLimitRaw === limit.toString()
}
/** Preserve reader facts even when the separately requested withdrawal reverts. No new reads. */
export function buildHolderExitCapacityQuote(
  a: HolderExitAssessment,
  facts: HolderExitCapacityFacts,
  asOfMs: number,
): HolderExitCapacityQuote | null {
  try {
    if (
      !record(a) ||
      typeof a.status !== 'string' ||
      !['assessed', 'partial', 'unsupported'].includes(a.status) ||
      !record(a.request) ||
      !record(a.source) ||
      !record(facts) ||
      typeof a.routeKey !== 'string' ||
      typeof a.destinationAddress !== 'string' ||
      typeof a.owner !== 'string'
    )
      return null
    const destination = a.destinationAddress.toLowerCase(),
      owner = a.owner.toLowerCase(),
      spec = resolveHolderExitCapacitySubject(a.routeKey, destination)
    if (
      !spec?.canonicalFinalAsset ||
      !address(destination) ||
      !address(owner) ||
      !raw(a.request.assetsRaw) ||
      BigInt(a.request.assetsRaw) === 0n ||
      typeof a.request.assetAddress !== 'string' ||
      a.request.assetAddress.toLowerCase() !== spec.canonicalFinalAsset.address
    )
      return null
    const s = {
      chainId: a.source.chainId,
      blockNumber: a.source.blockNumber,
      blockHash:
        typeof a.source.blockHash === 'string'
          ? a.source.blockHash.toLowerCase()
          : a.source.blockHash,
      blockTime: a.source.blockTime,
      finalized: true as const,
    }
    const m = methods(a.routeKey, destination)
    if (!source(s, asOfMs) || !validFacts(facts, m)) return null
    const asset = spec.canonicalFinalAsset.address,
      q = a.request.assetsRaw
    if (
      Object.hasOwn(facts, 'usd3NativeCapacity') &&
      !validUsd3NativeCapacity(
        facts.usd3NativeCapacity,
        m.kind,
        owner,
        asset,
        spec.canonicalFinalAsset.decimals,
        s,
        asOfMs,
      )
    )
      return null
    if (!validFluidBridgeNative(facts, a.routeKey, owner, s, asOfMs)) return null
    const successful =
      resolveIssuedHolderExitSubject(a.routeKey, destination) !== null &&
      a.status === 'assessed' &&
      record(a.finalPayout) &&
      a.finalPayout.status === 'simulated' &&
      a.finalPayout.amountRaw === q &&
      typeof a.finalPayout.assetAddress === 'string' &&
      a.finalPayout.assetAddress.toLowerCase() === asset &&
      Array.isArray(a.stages) &&
      a.stages.length === 1 &&
      a.stages[0].name === 'withdrawal' &&
      a.stages[0].status === 'simulated' &&
      a.stages[0].relatedToRequest === true &&
      a.stages[0].amountRaw === q &&
      typeof a.stages[0].assetAddress === 'string' &&
      a.stages[0].assetAddress.toLowerCase() === asset
    return {
      status: 'holder_capacity_quote',
      scope: 'existing_holder_position',
      routeKey: a.routeKey,
      destination,
      owner,
      requestedRaw: q,
      asset,
      assetDecimals: spec.canonicalFinalAsset.decimals,
      source: s,
      entitlementRaw: facts.entitlementRaw,
      quotedMaxWithdrawRaw: facts.quotedMaxWithdrawRaw,
      quotedMaxWithdrawStatus: facts.quotedMaxWithdrawStatus,
      effectiveLimitRaw: facts.effectiveLimitRaw,
      withdrawalsPaused: facts.withdrawalsPaused,
      ...fullPositionFields(facts),
      ...(Object.hasOwn(facts, 'usd3NativeCapacity')
        ? { usd3NativeCapacity: structuredClone(facts.usd3NativeCapacity!) }
        : {}),
      ...(Object.hasOwn(facts, 'fluidUsdcBridgeNativeCapacity')
        ? { fluidUsdcBridgeNativeCapacity: structuredClone(facts.fluidUsdcBridgeNativeCapacity!) }
        : {}),
      ...(Object.hasOwn(facts, 'sourceHolderPosition')
        ? { sourceHolderPosition: { ...facts.sourceHolderPosition! } }
        : {}),
      entitlementMethod: facts.entitlementRaw === null ? 'unavailable' : m.entitlement,
      quotedLimitMethod: facts.quotedMaxWithdrawStatus === 'quoted' ? m.limit : 'unavailable',
      effectiveLimitMethod: m.effective,
      successfulRequestedRawLowerBound: successful ? q : null,
      aggregateAccessibleLiquidityRaw: null,
      hypotheticalDepositCapacityRaw: null,
      holderExecutableExit: false,
      futureCapacityValidated: false,
      forecastValidated: false,
      prospectiveValidated: false,
      minedPayoutObserved: false,
    }
  } catch {
    return null
  }
}
function validQuote(v: unknown, asOfMs: number): v is HolderExitCapacityQuote {
  if (
    !record(v) ||
    typeof v.routeKey !== 'string' ||
    !address(v.destination) ||
    !address(v.owner) ||
    !raw(v.requestedRaw) ||
    BigInt(v.requestedRaw) === 0n ||
    !source(v.source, asOfMs)
  )
    return false
  const spec = resolveHolderExitCapacitySubject(v.routeKey, v.destination)
  if (
    !spec?.canonicalFinalAsset ||
    v.asset !== spec.canonicalFinalAsset.address ||
    v.assetDecimals !== spec.canonicalFinalAsset.decimals
  )
    return false
  const m = methods(v.routeKey, v.destination),
    facts = {
      entitlementRaw: v.entitlementRaw,
      quotedMaxWithdrawRaw: v.quotedMaxWithdrawRaw,
      quotedMaxWithdrawStatus: v.quotedMaxWithdrawStatus,
      effectiveLimitRaw: v.effectiveLimitRaw,
      withdrawalsPaused: v.withdrawalsPaused,
      ...(Object.hasOwn(v, 'usd3NativeCapacity')
        ? { usd3NativeCapacity: v.usd3NativeCapacity }
        : {}),
      ...(Object.hasOwn(v, 'fluidUsdcBridgeNativeCapacity')
        ? { fluidUsdcBridgeNativeCapacity: v.fluidUsdcBridgeNativeCapacity }
        : {}),
      ...(Object.hasOwn(v, 'sourceHolderPosition')
        ? { sourceHolderPosition: v.sourceHolderPosition }
        : {}),
      ...(Object.hasOwn(v, 'fullPositionEntitlementRaw')
        ? {
            fullPositionEntitlementRaw: v.fullPositionEntitlementRaw,
          }
        : {}),
    } as HolderExitCapacityFacts
  if (
    !validFacts(facts, m) ||
    !validFluidBridgeNative(
      facts,
      v.routeKey as string,
      v.owner as string,
      v.source as HolderExitCapacityQuote['source'],
      asOfMs,
    ) ||
    (Object.hasOwn(v, 'usd3NativeCapacity') &&
      !validUsd3NativeCapacity(
        v.usd3NativeCapacity,
        m.kind,
        v.owner,
        v.asset as string,
        v.assetDecimals as number,
        v.source,
        asOfMs,
      )) ||
    (v.successfulRequestedRawLowerBound !== null &&
      v.successfulRequestedRawLowerBound !== v.requestedRaw)
  )
    return false
  const expected = {
    status: 'holder_capacity_quote',
    scope: 'existing_holder_position',
    routeKey: v.routeKey,
    destination: v.destination,
    owner: v.owner,
    requestedRaw: v.requestedRaw,
    asset: v.asset,
    assetDecimals: v.assetDecimals,
    source: {
      chainId: 1,
      blockNumber: v.source.blockNumber,
      blockHash: v.source.blockHash,
      blockTime: v.source.blockTime,
      finalized: true,
    },
    ...facts,
    ...fullPositionFields(facts),
    entitlementMethod: facts.entitlementRaw === null ? 'unavailable' : m.entitlement,
    quotedLimitMethod: facts.quotedMaxWithdrawStatus === 'quoted' ? m.limit : 'unavailable',
    effectiveLimitMethod: m.effective,
    successfulRequestedRawLowerBound: v.successfulRequestedRawLowerBound,
    aggregateAccessibleLiquidityRaw: null,
    hypotheticalDepositCapacityRaw: null,
    holderExecutableExit: false,
    futureCapacityValidated: false,
    forecastValidated: false,
    prospectiveValidated: false,
    minedPayoutObserved: false,
  }
  return exact(v, expected)
}
/** Agreement of quotes is independent of whether either current-Q execution succeeds. */
export function agreeHolderExitCapacityQuotes(
  first: { host: string; quote: unknown },
  second: { host: string; quote: unknown },
  asOfMs: number,
): HolderExitCapacityAgreement | null {
  try {
    if (
      !record(first) ||
      !record(second) ||
      !host(first.host) ||
      !host(second.host) ||
      first.host === second.host ||
      !validQuote(first.quote, asOfMs) ||
      !validQuote(second.quote, asOfMs)
    )
      return null
    if (
      methods(first.quote.routeKey, first.quote.destination).kind === 'usd3' &&
      Object.hasOwn(first.quote, 'fullPositionEntitlementRaw') !==
        Object.hasOwn(second.quote, 'fullPositionEntitlementRaw')
    )
      return null
    const {
        successfulRequestedRawLowerBound: firstBound,
        fullPositionEntitlementRaw: firstFull,
        fullPositionEntitlementMethod: _firstMethod,
        usd3NativeCapacity: firstNative,
        fluidUsdcBridgeNativeCapacity: firstFluidNative,
        ...a
      } = first.quote,
      {
        successfulRequestedRawLowerBound: secondBound,
        fullPositionEntitlementRaw: secondFull,
        fullPositionEntitlementMethod: _secondMethod,
        usd3NativeCapacity: secondNative,
        fluidUsdcBridgeNativeCapacity: secondFluidNative,
        ...b
      } = second.quote
    if (!exact(a, b)) return null
    if (firstFluidNative || secondFluidNative) {
      if (!firstFluidNative || !secondFluidNative) return null
      const { traces: _firstTraces, readAtUtc: _firstRead, ...firstFluidFacts } = firstFluidNative
      const {
        traces: _secondTraces,
        readAtUtc: _secondRead,
        ...secondFluidFacts
      } = secondFluidNative
      if (!exact(firstFluidFacts, secondFluidFacts)) return null
    }
    const native = firstNative ?? secondNative
    const firstClockOwn = Object.hasOwn(firstNative ?? {}, 'readAtUtc')
    const secondClockOwn = Object.hasOwn(secondNative ?? {}, 'readAtUtc')
    const clockPresent = firstClockOwn || secondClockOwn
    const clocksComparable =
      !clockPresent ||
      (firstClockOwn &&
        secondClockOwn &&
        typeof firstNative?.readAtUtc === 'string' &&
        typeof secondNative?.readAtUtc === 'string')
    const { readAtUtc: _firstReadAt, ...firstNativePayload } = firstNative ?? {}
    const { readAtUtc: _secondReadAt, ...secondNativePayload } = secondNative ?? {}
    const agreedNative = native
      ? firstNative &&
        secondNative &&
        clocksComparable &&
        exact(firstNativePayload, secondNativePayload)
        ? {
            ...structuredClone(firstNative),
            ...(clockPresent
              ? {
                  readAtUtc: new Date(
                    Math.max(
                      Date.parse(firstNative.readAtUtc as string),
                      Date.parse(secondNative.readAtUtc as string),
                    ),
                  ).toISOString(),
                }
              : {}),
          }
        : {
            ...structuredClone(native),
            capacityRaw: null,
            resultStatus: 'unavailable' as const,
            runtimeProfile: null,
            ...(Object.hasOwn(firstNative ?? {}, 'shutdown') ||
            Object.hasOwn(secondNative ?? {}, 'shutdown')
              ? { shutdown: null }
              : {}),
            ...(clockPresent ? { readAtUtc: null } : {}),
          }
      : undefined
    return {
      status: 'two_origin_holder_capacity_quote',
      quote: {
        ...structuredClone(first.quote),
        ...(firstFluidNative && secondFluidNative
          ? {
              fluidUsdcBridgeNativeCapacity: {
                ...structuredClone(firstFluidNative),
                readAtUtc: new Date(
                  Math.max(
                    Date.parse(firstFluidNative.readAtUtc),
                    Date.parse(secondFluidNative.readAtUtc),
                  ),
                ).toISOString(),
              },
            }
          : {}),
        ...(agreedNative ? { usd3NativeCapacity: agreedNative } : {}),
        ...(Object.hasOwn(first.quote, 'fullPositionEntitlementRaw') ||
        Object.hasOwn(second.quote, 'fullPositionEntitlementRaw')
          ? fullPositionFields({
              fullPositionEntitlementRaw:
                firstFull != null && firstFull === secondFull ? firstFull : null,
            })
          : {}),
        successfulRequestedRawLowerBound:
          firstBound !== null && firstBound === secondBound ? firstBound : null,
      },
      origins: [
        { host: first.host, quote: structuredClone(first.quote) },
        { host: second.host, quote: structuredClone(second.quote) },
      ],
    }
  } catch {
    return null
  }
}
export function selectedHolderExitCapacity(
  value: unknown,
  expected: HolderExitCapacityBinding,
): HolderExitCapacityAgreement | null {
  try {
    if (
      !record(value) ||
      !record(expected) ||
      !Array.isArray(value.origins) ||
      value.origins.length !== 2 ||
      !record(value.origins[0]) ||
      !record(value.origins[1]) ||
      !Number.isSafeInteger(expected.asOfMs)
    )
      return null
    const rebuilt = agreeHolderExitCapacityQuotes(
      value.origins[0] as { host: string; quote: unknown },
      value.origins[1] as { host: string; quote: unknown },
      expected.asOfMs,
    )
    if (!rebuilt || !exact(rebuilt, value)) return null
    const q = rebuilt.quote
    if (
      q.routeKey !== expected.routeKey ||
      typeof expected.destination !== 'string' ||
      q.destination !== expected.destination.toLowerCase() ||
      typeof expected.owner !== 'string' ||
      q.owner !== expected.owner.toLowerCase() ||
      q.requestedRaw !== expected.requestedRaw ||
      typeof expected.asset !== 'string' ||
      q.asset !== expected.asset.toLowerCase() ||
      q.assetDecimals !== expected.assetDecimals ||
      !exact(q.source, expected.currentSource)
    )
      return null
    if (q.successfulRequestedRawLowerBound !== null) {
      const evidence = expected.executionAgreement
      const subject = resolveIssuedHolderExitSubject(q.routeKey, q.destination)
      if (
        !subject ||
        !record(evidence) ||
        !record(evidence.question) ||
        !Array.isArray(evidence.simulations) ||
        evidence.simulations.length !== 2
      )
        return null
      const question = evidence.question
      if (
        question.routeKey !== q.routeKey ||
        typeof question.destinationAddress !== 'string' ||
        question.destinationAddress.toLowerCase() !== q.destination ||
        typeof question.owner !== 'string' ||
        question.owner.toLowerCase() !== q.owner ||
        typeof question.finalAssetAddress !== 'string' ||
        question.finalAssetAddress.toLowerCase() !== q.asset ||
        question.finalAssetDecimals !== q.assetDecimals ||
        question.assetsRaw !== q.requestedRaw ||
        !evidence.simulations.every(
          (proof) =>
            record(proof) &&
            host(proof.originHost) &&
            rebuilt.origins.some((origin) => origin.host === proof.originHost) &&
            exact(proof.source, q.source) &&
            proof.finalAssetAmountRaw === q.requestedRaw,
        ) ||
        assessHolderExitConditionalProjection(
          subject,
          evidence as HolderExitConditionalProjectionEvidence,
        ).tier !== 'conditional_projection'
      )
        return null
    }
    const selected = structuredClone(rebuilt)
    if (selected.quote.successfulRequestedRawLowerBound === null)
      for (const origin of selected.origins) origin.quote.successfulRequestedRawLowerBound = null
    return selected
  } catch {
    return null
  }
}
