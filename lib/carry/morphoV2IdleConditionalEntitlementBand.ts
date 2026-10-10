/**
 * Conditional math, not native repricing or authenticated native evidence.
 *
 * Retained upstream source at commit 72583ec91bfb745b7ae96a29d863d155c1a5515f:
 * data/research/venue-signals/morpho-v2-primary-entry-source-833313c7-c002-428e-8fa2-e516045c797b/VaultV2.sol:677-680
 * previewRedeem(S) = floor(S * (newTotalAssets + 1) /
 *   (totalSupply + performanceFeeShares + managementFeeShares + virtualShares)).
 * accrueInterestView at lines 625-652 fixes those terms independently of S.
 * The retained manifest explicitly does not establish deployed-source equivalence.
 *
 * ASSUMPTION: at one fixed source/call context, conversion follows that upstream
 * linear floor rule. A recorded quote E0 for S0 > 0 then constrains its rate r to
 * E0 / S0 <= r < (E0 + 1) / S0. For S > 0 the tight integer outcome interval is
 * [floor(S * E0 / S0), floor((S * (E0 + 1) - 1) / S0)]. Zero S returns [0, 0].
 *
 * This function only checks scalar shape and performs conditional integer math.
 * It does not authenticate the recorded quote, establish the deployed rule or
 * MathLib's intermediate arithmetic domain, or issue an existing native receipt.
 * Historical S > totalSupply is an extrapolation flag, not a contract rejection:
 * the retained previewRedeem view has no S <= totalSupply check.
 */

export const MORPHO_V2_IDLE_CONDITIONAL_ENTITLEMENT_ASSUMPTION =
  'upstream_linear_floor_preview_redeem_at_fixed_source' as const

export const MORPHO_V2_IDLE_CONDITIONAL_ENTITLEMENT_CLAIMS = Object.freeze({
  exactNativeRepricing: false,
  deployedSourceEquivalence: false,
  nativeArithmeticDomainEstablished: false,
  historicalOwnership: false,
  currentWalletControl: false,
  authorizationVerified: false,
  executionVerified: false,
  calibratedConfidence: false,
  nativeReceiptIssued: false,
} as const)

export type MorphoV2IdleConditionalEntitlementBandInput = {
  recordedProbeSharesRaw: string
  recordedQuoteAssetsRaw: string
  requestedSharesRaw: string
  historicalTotalSupplySharesRaw?: string | null
}

type ConditionalBandContext = Readonly<{
  kind: 'conditional_recorded_quote_rate_interval'
  assumption: typeof MORPHO_V2_IDLE_CONDITIONAL_ENTITLEMENT_ASSUMPTION
  recordedProbeSharesRaw: string
  recordedQuoteAssetsRaw: string
  requestedSharesRaw: string
  historicalTotalSupplySharesRaw: string | null
  extrapolatesBeyondHistoricalSupply: boolean | null
  claims: typeof MORPHO_V2_IDLE_CONDITIONAL_ENTITLEMENT_CLAIMS
}>

export type MorphoV2IdleConditionalEntitlementBand = ConditionalBandContext & (
  | Readonly<{
    status: 'bounded'
    lowerAssetsRaw: string
    upperAssetsRaw: string
    arithmeticDomainCensor: null
    lowerExceedsUint256: false
    upperExceedsUint256: false
  }>
  | Readonly<{
    status: 'arithmetic_domain_censored'
    lowerAssetsRaw: null
    upperAssetsRaw: null
    arithmeticDomainCensor: 'conditional_bound_exceeds_uint256'
    lowerExceedsUint256: boolean
    upperExceedsUint256: boolean
  }>
)

const MAX_UINT256 = (1n << 256n) - 1n
const INPUT_KEYS = new Set([
  'recordedProbeSharesRaw',
  'recordedQuoteAssetsRaw',
  'requestedSharesRaw',
  'historicalTotalSupplySharesRaw',
])

function uint256(value: unknown): bigint | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 78 || /[^0-9]/.test(value)
    || (value.length > 1 && value[0] === '0')) return null
  const parsed = BigInt(value)
  return parsed <= MAX_UINT256 ? parsed : null
}

/** Invalid scalar inputs return null; valid out-of-domain bounds retain a censor. */
export function buildMorphoV2IdleConditionalEntitlementBand(
  input: unknown,
): MorphoV2IdleConditionalEntitlementBand | null {
  try {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return null
    const prototype = Object.getPrototypeOf(input)
    if (prototype !== Object.prototype && prototype !== null) return null
    const keys = Reflect.ownKeys(input)
    if (keys.some(key => typeof key !== 'string' || !INPUT_KEYS.has(key))) return null
    if (!['recordedProbeSharesRaw', 'recordedQuoteAssetsRaw', 'requestedSharesRaw'].every(key => keys.includes(key))) return null
    const descriptors = Object.getOwnPropertyDescriptors(input)
    // Read data descriptors only. Getters and arbitrary coercions are not run.
    if (keys.some(key => {
      const descriptor = descriptors[key as string]
      return !descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || !descriptor.enumerable
    })) return null
    const probe = uint256(descriptors.recordedProbeSharesRaw?.value)
    const quote = uint256(descriptors.recordedQuoteAssetsRaw?.value)
    const requested = uint256(descriptors.requestedSharesRaw?.value)
    if (probe === null || probe === 0n || quote === null || requested === null) return null
    const supplyDescriptor = descriptors.historicalTotalSupplySharesRaw
    const supply = !supplyDescriptor || supplyDescriptor.value === null
      ? null : uint256(supplyDescriptor.value)
    if (supplyDescriptor && supplyDescriptor.value !== null && supply === null) return null

    const context: ConditionalBandContext = {
      kind: 'conditional_recorded_quote_rate_interval',
      assumption: MORPHO_V2_IDLE_CONDITIONAL_ENTITLEMENT_ASSUMPTION,
      recordedProbeSharesRaw: probe.toString(),
      recordedQuoteAssetsRaw: quote.toString(),
      requestedSharesRaw: requested.toString(),
      historicalTotalSupplySharesRaw: supply === null ? null : supply.toString(),
      extrapolatesBeyondHistoricalSupply: supply === null ? null : requested > supply,
      claims: MORPHO_V2_IDLE_CONDITIONAL_ENTITLEMENT_CLAIMS,
    }
    // BigInt preserves up to 512-bit intermediates here; no floating point or scaling.
    const lower = requested === 0n ? 0n : requested * quote / probe
    const upper = requested === 0n ? 0n : (requested * (quote + 1n) - 1n) / probe
    const lowerExceedsUint256 = lower > MAX_UINT256
    const upperExceedsUint256 = upper > MAX_UINT256
    if (lowerExceedsUint256 || upperExceedsUint256) {
      const censored: MorphoV2IdleConditionalEntitlementBand = {
        ...context,
        status: 'arithmetic_domain_censored',
        lowerAssetsRaw: null,
        upperAssetsRaw: null,
        arithmeticDomainCensor: 'conditional_bound_exceeds_uint256',
        lowerExceedsUint256,
        upperExceedsUint256,
      }
      return Object.freeze(censored)
    }
    const bounded: MorphoV2IdleConditionalEntitlementBand = {
      ...context,
      status: 'bounded',
      lowerAssetsRaw: lower.toString(),
      upperAssetsRaw: upper.toString(),
      arithmeticDomainCensor: null,
      lowerExceedsUint256: false,
      upperExceedsUint256: false,
    }
    return Object.freeze(bounded)
  } catch {
    return null
  }
}
