import { DIRECT_SUPPLY_MARKETS } from './directSupplyMarketConstants'
import {
  selectedConditionalSampledCashPathProjection,
  type ConditionalSampledCashCurrentSource,
} from './conditionalSampledCashPathProjection'
import {
  buildConditionalTimeProcess,
  type ConditionalTimeProcessInput,
} from '../venueForecast/conditionalTimeProcess'

const MAX = (1n << 256n) - 1n
const RAY = 10n ** 27n
const raw = (v: unknown): v is string =>
  typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) <= MAX
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const utc = (v: unknown): v is string =>
  typeof v === 'string' &&
  Number.isSafeInteger(Date.parse(v)) &&
  new Date(Date.parse(v)).toISOString() === v
const equal = (a: unknown, b: unknown): boolean => {
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => equal(v, b[i]))
    )
  if (record(a) || record(b))
    return (
      record(a) &&
      record(b) &&
      Object.keys(a).length === Object.keys(b).length &&
      Object.keys(a).every((k) => Object.hasOwn(b, k) && equal(a[k], b[k]))
    )
  return Object.is(a, b)
}

export const INITIAL_DEPOSIT_MARKETS = [
  { ...DIRECT_SUPPLY_MARKETS.aaveV3Usdc, pool: '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2' },
  { ...DIRECT_SUPPLY_MARKETS.sparkLendUsdt, pool: '0xc13e21b648a5ee794902342038ff3adab66be987' },
] as const
export const initialDepositMarket = (routeKey: string, destination: string) =>
  INITIAL_DEPOSIT_MARKETS.find(
    (m) => m.routeKey === routeKey && m.destination.toLowerCase() === destination,
  )

export type InitialDepositNativeFacts = {
  pool: string
  aToken: string
  asset: string
  assetDecimals: 6
  configurationRaw: string
  normalizedIncomeRaw: string
  scaledTotalSupplyRaw: string
  accruedToTreasuryScaledRaw: string
}
export type InitialDepositNativeAgreement = {
  status: 'agreed_initial_deposit_native_facts'
  currentSource: ConditionalSampledCashCurrentSource
  readAt: string
  origins: [
    { originHostSha256: string; facts: InitialDepositNativeFacts },
    { originHostSha256: string; facts: InitialDepositNativeFacts },
  ]
}
export type InitialDepositProjectionInput = {
  currentSource: ConditionalSampledCashCurrentSource | null
  dailyProjection: unknown
  depositAssetsRaw: string
  plannedExitAssetsRaw: string
  horizonHours: number
  asOfMs: number
  nativeAgreement?: unknown
  nativeUnavailableReason?: string
}

/** Native WadRayMath half-up arithmetic, with the same uint256 intermediate guards. */
export function sourceIndexedInitialReceipt(depositRaw: string, indexRaw: string) {
  if (!raw(depositRaw) || !raw(indexRaw)) return null
  const D = BigInt(depositRaw),
    I = BigInt(indexRaw)
  if (D === 0n || I === 0n || D > (MAX - I / 2n) / RAY) return null
  const scaled = (D * RAY + I / 2n) / I
  if (scaled === 0n || scaled > (MAX - RAY / 2n) / I) return null
  return { scaledMintRaw: String(scaled), entitlementRaw: String((scaled * I + RAY / 2n) / RAY) }
}

export function selectedInitialDepositNativeAgreement(
  value: unknown,
  source: ConditionalSampledCashCurrentSource,
  asOfMs: number,
): InitialDepositNativeAgreement | null {
  try {
    const m = initialDepositMarket(source.routeKey, source.destination)
    const nativeSource = record(value) && record(value.currentSource) ? value.currentSource : null
    const { readAt: _cashReadAt, ...sourceIdentity } = source
    const { readAt: nativeCashReadAt, ...nativeIdentity } = nativeSource ?? {}
    if (
      !m ||
      source.asset !== m.underlying.toLowerCase() ||
      source.assetDecimals !== 6 ||
      !record(value) ||
      value.status !== 'agreed_initial_deposit_native_facts' ||
      !equal(nativeIdentity, sourceIdentity) ||
      !utc(value.readAt) ||
      !utc(source.readAt) ||
      !utc(nativeCashReadAt) ||
      !Number.isSafeInteger(asOfMs) ||
      Date.parse(source.readAt) > asOfMs ||
      Date.parse(source.blockTime) > Date.parse(nativeCashReadAt) ||
      Date.parse(value.readAt) < Date.parse(nativeCashReadAt) ||
      Date.parse(value.readAt) > asOfMs ||
      !Array.isArray(value.origins) ||
      value.origins.length !== 2
    )
      return null
    const hosts = new Set<string>()
    for (const o of value.origins) {
      if (
        !record(o) ||
        typeof o.originHostSha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(o.originHostSha256) ||
        hosts.has(o.originHostSha256)
      )
        return null
      hosts.add(o.originHostSha256)
      const f = o.facts
      if (
        !record(f) ||
        f.pool !== m.pool ||
        f.aToken !== source.destination ||
        f.asset !== source.asset ||
        f.assetDecimals !== 6 ||
        !raw(f.configurationRaw) ||
        !raw(f.normalizedIncomeRaw) ||
        BigInt(f.normalizedIncomeRaw) === 0n ||
        !raw(f.scaledTotalSupplyRaw) ||
        !raw(f.accruedToTreasuryScaledRaw) ||
        BigInt(f.accruedToTreasuryScaledRaw) >= 1n << 128n ||
        Number((BigInt(f.configurationRaw) >> 48n) & 255n) !== 6
      )
        return null
    }
    return equal(value.origins[0].facts, value.origins[1].facts)
      ? (structuredClone(value) as InitialDepositNativeAgreement)
      : null
  } catch {
    return null
  }
}

const unavailable = (reason: string) => ({ status: 'unavailable' as const, reason })
/** A new conditional deposit issue. Never accepts an owner or present-holder witness. */
export function buildInitialDepositCapacityProjection(
  supplied: InitialDepositProjectionInput,
  hash: (s: string) => string,
) {
  try {
    const input = structuredClone(supplied),
      source = input.currentSource
    if (!source || !initialDepositMarket(source.routeKey, source.destination))
      return unavailable(source ? 'unsupported_subject' : 'missing_current_source')
    if (
      !raw(input.depositAssetsRaw) ||
      input.depositAssetsRaw === '0' ||
      !raw(input.plannedExitAssetsRaw) ||
      input.plannedExitAssetsRaw === '0' ||
      !Number.isSafeInteger(input.horizonHours) ||
      input.horizonHours < 1 ||
      input.horizonHours > 720 ||
      !Number.isSafeInteger(input.asOfMs)
    )
      return unavailable('invalid_initial_deposit_question')
    const cash = selectedConditionalSampledCashPathProjection(
      input.dailyProjection,
      {
        identity: {
          routeKey: source.routeKey,
          destination: source.destination,
          asset: source.asset,
          assetDecimals: source.assetDecimals,
        },
        requestedRaw: input.plannedExitAssetsRaw,
        currentSource: source,
        asOfMs: input.asOfMs,
      },
      hash,
    )
    if (!cash) return unavailable('verified_cash_paths_unavailable')
    const postDepositCash = BigInt(source.cashRaw) + BigInt(input.depositAssetsRaw)
    if (postDepositCash > MAX) return unavailable('native_cash_addition_overflow')
    const native = selectedInitialDepositNativeAgreement(
      input.nativeAgreement,
      source,
      input.asOfMs,
    )
    const receipt = native
      ? sourceIndexedInitialReceipt(
          input.depositAssetsRaw,
          native.origins[0].facts.normalizedIncomeRaw,
        )
      : null
    const flags = native ? BigInt(native.origins[0].facts.configurationRaw) : null
    const active = flags === null ? null : Boolean((flags >> 56n) & 1n)
    const frozen = flags === null ? null : Boolean((flags >> 57n) & 1n)
    const paused = flags === null ? null : Boolean((flags >> 60n) & 1n)
    const channels: ConditionalTimeProcessInput['channels'] = [
      {
        key: 'cash',
        assetAddress: source.asset,
        decimals: 6,
        unit: 'native_underlying_cash',
        negativeHandling: 'clamp_zero',
      },
    ]
    const regime = source.routeKey + ':' + source.destination
    const processInput: ConditionalTimeProcessInput = {
      channels,
      observations: cash.history.points.map((p) => ({
        sourceAtUtc: p[3],
        availableAtUtc: cash.history.witness.availableAt,
        regime,
        channels: structuredClone(channels),
        valuesByChannel: { cash: p[4] },
        provenanceRef: p[1] + ':' + p[2],
      })),
      outputAsset: { assetAddress: source.asset, decimals: 6 },
      measurementRule: 'conditional_admitted_deposit_cash_before_floor_then_source_receipt_clip',
      current: {
        sourceAtUtc: source.blockTime,
        readAtUtc: source.readAt,
        regime,
        valuesByChannel: { cash: String(postDepositCash) },
        provenanceRef: 'hypothetical_deposit_at_source:' + source.block + ':' + source.blockHash,
      },
      issueAtUtc: new Date(input.asOfMs).toISOString(),
      requestedRaw: input.plannedExitAssetsRaw,
      horizonHours: input.horizonHours,
      maxHistoricalGapSeconds: 91800,
    }
    const approved = structuredClone(processInput)
    const qualify = (v: ConditionalTimeProcessInput) => equal(v, approved)
    const cashOnlyProcess = buildConditionalTimeProcess(processInput, qualify, (state) => ({
      availableRaw: state.cash,
      entitlementRaw: null,
    }))
    if (!cashOnlyProcess) return unavailable('conditional_time_process_unavailable')
    const process = receipt
      ? buildConditionalTimeProcess(processInput, qualify, (state) => ({
          availableRaw: state.cash,
          entitlementRaw: receipt.entitlementRaw,
        }))
      : null
    return {
      status: 'conditional_initial_deposit_projection' as const,
      identity: structuredClone(cash.identity),
      currentSource: structuredClone(source),
      request: {
        mode: 'initial_deposit' as const,
        depositAssetsRaw: input.depositAssetsRaw,
        plannedExitAssetsRaw: input.plannedExitAssetsRaw,
        horizonHours: input.horizonHours,
        asOf: new Date(input.asOfMs).toISOString(),
      },
      target: {
        sourceAt: source.blockTime,
        issueAt: new Date(input.asOfMs).toISOString(),
        at: cashOnlyProcess.targetAtUtc,
        horizonHours: input.horizonHours,
      },
      hypotheticalPostDepositCashRaw: String(postDepositCash),
      hypotheticalDepositAtUtc: source.blockTime,
      cashOnlyClaim:
        'conditional_post_deposit_aggregate_liquidity_headroom_not_holder_exit_capacity' as const,
      hypotheticalState: {
        observedCashRaw: source.cashRaw,
        depositedPrincipalRaw: input.depositAssetsRaw,
        cashRaw: String(postDepositCash),
        depositAtUtc: source.blockTime,
        observed: false as const,
      },
      hypotheticalReceipt:
        receipt && native
          ? {
              status: 'conditional_source_indexed_receipt' as const,
              ...receipt,
              normalizedIncomeRaw: native.origins[0].facts.normalizedIncomeRaw,
              indexAt: source.blockTime,
              nativeFactsReadAt: native.readAt,
              indexPath: 'held_constant_at_source_index' as const,
            }
          : unavailable(
              native
                ? 'zero_scaled_mint_or_native_ray_overflow'
                : input.nativeAgreement
                  ? 'native_facts_invalid_or_disagreeing'
                  : (input.nativeUnavailableReason ?? 'native_facts_unavailable'),
            ),
      admission: {
        status:
          active === false || frozen === true || paused === true || (native && !receipt)
            ? ('blocked_under_reference_rules' as const)
            : ('unknown' as const),
        active,
        frozen,
        paused,
        supplyCapAssetsRaw:
          flags === null ? null : String(((flags >> 116n) & ((1n << 36n) - 1n)) * 1000000n),
        scaledTotalSupplyRaw: native?.origins[0].facts.scaledTotalSupplyRaw ?? null,
        accruedToTreasuryScaledRaw: native?.origins[0].facts.accruedToTreasuryScaledRaw ?? null,
        capAssessment: 'display_only_treasury_update_before_validation_unassessed' as const,
        deployedVersionEquivalence: 'conditional_unverified' as const,
      },
      nativeAgreement: native,
      cashOnlyProcess,
      process,
      evidence: structuredClone(cash.evidence),
      historyCoverage: structuredClone(cash.history.coverage),
      method:
        'cash_plus_d_plus_joint_net_change_floor_then_hypothetical_receipt_clip_then_q_once' as const,
      assumptions: {
        successfulAdmittedDepositAtSource: true,
        unchangedReferenceSupplyMechanics: true,
        referenceSourceEquivalenceUnverified: true,
        historicalCompetitionIncludedInNetPaths: true,
        grossFlowAdded: false,
        sourceReceiptIndexAndFutureIncomeHeldConstant: true,
        tokenTransferAndWithdrawEligibilityUnchanged: true,
      },
      sourceReferences: [
        'https://raw.githubusercontent.com/aave/aave-v3-origin/main/src/contracts/protocol/libraries/logic/SupplyLogic.sol',
        'https://raw.githubusercontent.com/sparkdotfi/sparklend-v1-core/master/contracts/protocol/libraries/logic/SupplyLogic.sol',
      ],
      depositAdmitted: false as const,
      depositExecuted: false as const,
      actualHolderWitnessUsed: false as const,
      holderExecutableExit: false as const,
      forecastValidated: false as const,
      prospectiveValidated: false as const,
      calibratedProbability: false as const,
    }
  } catch {
    return unavailable('initial_deposit_projection_invalid')
  }
}
export type InitialDepositCapacityProjection = ReturnType<
  typeof buildInitialDepositCapacityProjection
>

/** Rebuild against independent D/Q/source and keep the original issue clock on refresh. */
export function selectedInitialDepositCapacityProjection(
  value: unknown,
  expected: InitialDepositProjectionInput,
  asOfMs: number,
  hash: (s: string) => string,
): InitialDepositCapacityProjection | null {
  try {
    if (
      !record(value) ||
      value.status !== 'conditional_initial_deposit_projection' ||
      !record(value.request) ||
      !utc(value.request.asOf) ||
      !Number.isSafeInteger(asOfMs) ||
      Date.parse(value.request.asOf) > asOfMs ||
      !expected.currentSource ||
      asOfMs - Date.parse(expected.currentSource.blockTime) > 1800000
    )
      return null
    const rebuilt = buildInitialDepositCapacityProjection(
      { ...expected, asOfMs: Date.parse(value.request.asOf) },
      hash,
    )
    return rebuilt.status === 'conditional_initial_deposit_projection' && equal(value, rebuilt)
      ? rebuilt
      : null
  } catch {
    return null
  }
}
