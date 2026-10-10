import {
  buildConditionalSampledCashPathProjection,
  type ConditionalSampledCashCurrentSource,
  type ConditionalSampledCashHistory,
  type ConditionalSampledCashIdentity,
} from './conditionalSampledCashPathProjection'
import {
  buildConditionalTimeProcess,
  type ConditionalTimeProcessInput,
} from '../venueForecast/conditionalTimeProcess'

/** Reviewed externally: these labels never infer a mechanism from an address. */
export type AnalogCashProfile = {
  identity: ConditionalSampledCashIdentity
  mechanismFamily: 'reserve_lending' | 'shared_bank_lending' | 'allocated_vault'
  cashMeaning: 'underlying_reserve' | 'shared_bank_cash' | 'unallocated_vault_cash'
  assetRiskClass: 'stable' | 'volatile'
  mechanismVersion: string
  reviewedProfileRef: string
}
export type AnalogCashDonor = {
  profile: AnalogCashProfile
  history: ConditionalSampledCashHistory
  /** Actual independent donor check, with its original clocks. */
  verificationSource: ConditionalSampledCashCurrentSource
  verificationAtUtc: string
  /** Explicit native identities; this map contains no exchange rate or dollar unit. */
  nativeUnitMap: {
    donorAsset: string
    donorDecimals: number
    currentAsset: string
    currentDecimals: number
    normalization: 'dimensionless_net_delta_over_donor_cash_before'
  }
}
export type VenueForecastAnalogPriorInput = {
  currentProfile: AnalogCashProfile
  currentSource: ConditionalSampledCashCurrentSource
  requestedRaw: string
  issueAtUtc: string
  horizonHours: number
  maxHistoricalGapSeconds: number
  donors: AnalogCashDonor[]
}
/** Server-qualified envelope; browser checks bind display but grant no provenance. */
export type AnalogCashScenario =
  | {
      status: 'analog_cash_scenario'
      claim: 'conditional_analog_native_cash_only'
      Ea: null
      prior: NonNullable<ReturnType<typeof buildVenueForecastAnalogPrior>>
      issuedInput: VenueForecastAnalogPriorInput
      currentSource: ConditionalSampledCashCurrentSource
      donorSelection: {
        eligibleDonors: number
        selectedDonors: number
        limit: 16
        method: 'exact_asset_then_subject_key'
      }
      historicalExtremesAreConfidenceBands: false
      holderExecutableExit: false
      forecastValidated: false
    }
  | { status: 'unqualified'; reason: string; Ea: null }
/** Must independently bind profiles/current source and paired donor source agreement.
 * Equality against the input or a self-asserted history seal is not qualification. */
export type AnalogPriorQualifiers = {
  current: (privateInput: VenueForecastAnalogPriorInput) => boolean
  donor: (privateDonor: AnalogCashDonor) => boolean
}
const MAX = (1n << 256n) - 1n
const raw = (x: unknown): x is string =>
  typeof x === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(x) && BigInt(x) <= MAX
const utc = (x: unknown): x is string =>
  typeof x === 'string' &&
  Number.isSafeInteger(Date.parse(x)) &&
  new Date(Date.parse(x)).toISOString() === x
const text = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 256
const hex = (x: unknown, digits: number) =>
  typeof x === 'string' && new RegExp(`^0x[0-9a-f]{${digits}}$`).test(x)
function exact(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => exact(v, b[i]))
    )
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const aa = a as Record<string, unknown>,
      bb = b as Record<string, unknown>
    return (
      Object.keys(aa).length === Object.keys(bb).length &&
      Object.keys(aa).every((k) => Object.hasOwn(bb, k) && exact(aa[k], bb[k]))
    )
  }
  return Object.is(a, b)
}
function identity(i: ConditionalSampledCashIdentity) {
  return (
    i &&
    text(i.routeKey) &&
    hex(i.destination, 40) &&
    hex(i.asset, 40) &&
    Number.isInteger(i.assetDecimals) &&
    i.assetDecimals >= 0 &&
    i.assetDecimals <= 36
  )
}
function profile(p: AnalogCashProfile) {
  const meanings = {
    reserve_lending: 'underlying_reserve',
    shared_bank_lending: 'shared_bank_cash',
    allocated_vault: 'unallocated_vault_cash',
  }
  return (
    p &&
    identity(p.identity) &&
    Object.hasOwn(meanings, p.mechanismFamily) &&
    meanings[p.mechanismFamily] === p.cashMeaning &&
    ['stable', 'volatile'].includes(p.assetRiskClass) &&
    text(p.mechanismVersion) &&
    text(p.reviewedProfileRef)
  )
}
function checked(v: bigint) {
  if (v < -MAX || v > MAX) throw Error('native_overflow')
  return v
}
function floor(n: bigint, d: bigint) {
  const q = n / d
  return n < 0n && n % d !== 0n ? q - 1n : q
}
type Interval = { donor: number; from: number; delta: bigint; before: bigint; ms: number }
function rateCompare(a: Interval, b: Interval) {
  // Comparison cross-products are rationals, never native payout amounts.
  const lhs = a.delta * b.before * BigInt(b.ms),
    rhs = b.delta * a.before * BigInt(a.ms)
  return lhs < rhs ? -1 : lhs > rhs ? 1 : a.donor - b.donor || a.from - b.from
}
/** Fallback analogous liquidity prong; cannot approve a route or establish holder exit/admission. */
export function buildVenueForecastAnalogPrior(
  supplied: VenueForecastAnalogPriorInput,
  hash: (serialized: string) => string,
  qualifiers: AnalogPriorQualifiers,
) {
  try {
    const input = structuredClone(supplied),
      s = input.currentSource,
      p = input.currentProfile
    if (
      !profile(p) ||
      !s ||
      !exact(p.identity, {
        routeKey: s.routeKey,
        destination: s.destination,
        asset: s.asset,
        assetDecimals: s.assetDecimals,
      }) ||
      s.chainId !== 1 ||
      !raw(s.cashRaw) ||
      s.cashRaw === '0' ||
      !raw(s.block) ||
      !hex(s.blockHash, 64) ||
      !['manifest_bound_ledger', 'live_read_only_two_origin_finalized'].includes(s.sourceKind) ||
      !utc(s.blockTime) ||
      !utc(s.readAt) ||
      !utc(input.issueAtUtc) ||
      !raw(input.requestedRaw) ||
      input.requestedRaw === '0'
    )
      return null
    // Zero current cash cannot supply a meaningful flow-pressure scale or recovery prior.
    const issue = Date.parse(input.issueAtUtc),
      source = Date.parse(s.blockTime)
    if (
      source > Date.parse(s.readAt) ||
      Date.parse(s.readAt) > issue ||
      issue - source > 1800000 ||
      !Number.isSafeInteger(input.maxHistoricalGapSeconds) ||
      input.maxHistoricalGapSeconds <= 0 ||
      !Number.isSafeInteger(input.maxHistoricalGapSeconds * 1000) ||
      !Number.isFinite(input.horizonHours) ||
      input.horizonHours <= 0 ||
      input.horizonHours > 8760 ||
      !Number.isSafeInteger(input.horizonHours * 3600000) ||
      !Array.isArray(input.donors) ||
      !input.donors.length ||
      input.donors.length > 16
    )
      return null
    if (
      s.sourceKind === 'manifest_bound_ledger' &&
      ![s.manifestSha256, s.receiptSha256].every(
        (x) => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x),
      )
    )
      return null
    if (qualifiers.current(structuredClone(input)) !== true) return null
    const intervals: Interval[] = [],
      proofs: {
        compactHistorySha256: string
        witness: ConditionalSampledCashHistory['witness']
      }[] = []
    for (let d = 0; d < input.donors.length; d++) {
      const donor = input.donors[d],
        dp = donor.profile,
        map = donor.nativeUnitMap
      if (
        !profile(dp) ||
        dp.mechanismFamily !== p.mechanismFamily ||
        dp.cashMeaning !== p.cashMeaning ||
        dp.assetRiskClass !== p.assetRiskClass ||
        !exact(dp.identity, donor.history.identity) ||
        !utc(donor.verificationAtUtc) ||
        Date.parse(donor.verificationAtUtc) > issue ||
        !exact(map, {
          donorAsset: dp.identity.asset,
          donorDecimals: dp.identity.assetDecimals,
          currentAsset: p.identity.asset,
          currentDecimals: p.identity.assetDecimals,
          normalization: 'dimensionless_net_delta_over_donor_cash_before',
        }) ||
        qualifiers.donor(structuredClone(donor)) !== true
      )
        return null
      const verified = buildConditionalSampledCashPathProjection(
        {
          history: donor.history,
          currentSource: donor.verificationSource,
          request: { requestedRaw: '1', asOf: donor.verificationAtUtc },
        },
        hash,
      )
      if (verified.status !== 'estimated') return null
      proofs.push({
        compactHistorySha256: verified.evidence.compactHistorySha256,
        witness: structuredClone(donor.history.witness),
      })
      const points = donor.history.points
      for (let i = 0; i < points.length - 1; i++) {
        const a = points[i],
          b = points[i + 1],
          ms = Date.parse(b[3]) - Date.parse(a[3])
        if (Date.parse(b[3]) >= source || BigInt(b[1]) >= BigInt(s.block)) return null
        if (b[0] !== a[0] + 1 || ms > input.maxHistoricalGapSeconds * 1000 || a[4] === '0') continue
        intervals.push({
          donor: d,
          from: i,
          delta: BigInt(b[4]) - BigInt(a[4]),
          before: BigInt(a[4]),
          ms,
        })
      }
    }
    if (!intervals.length) return null
    const ordered = [...intervals].sort(rateCompare)
    // Deterministic rate-rank sampling retains both extremes and bounds all output work.
    const selected =
      ordered.length <= 64
        ? ordered
        : Array.from({ length: 64 }, (_, j) => ordered[Math.floor((j * (ordered.length - 1)) / 63)])
    const cash = BigInt(s.cashRaw)
    const scenarios = selected.map((interval) => {
      const donor = input.donors[interval.donor],
        a = donor.history.points[interval.from],
        b = donor.history.points[interval.from + 1]
      const channels: ConditionalTimeProcessInput['channels'] = [
        {
          key: 'donor_reference_cash',
          assetAddress: donor.profile.identity.asset,
          decimals: donor.profile.identity.assetDecimals,
          unit: 'native_donor_reference_not_current_holdings',
          negativeHandling: 'clamp_zero',
        },
      ]
      const regime = donor.profile.reviewedProfileRef
      const processInput: ConditionalTimeProcessInput = {
        channels,
        observations: [a, b].map((point) => ({
          sourceAtUtc: point[3],
          availableAtUtc: donor.history.witness.availableAt,
          regime,
          channels: structuredClone(channels),
          valuesByChannel: { donor_reference_cash: point[4] },
          provenanceRef: point[1] + ':' + point[2],
        })),
        outputAsset: { assetAddress: s.asset, decimals: s.assetDecimals },
        measurementRule: 'dimensionless_donor_net_pressure_scaled_to_current_native_cash',
        current: {
          sourceAtUtc: s.blockTime,
          readAtUtc: s.readAt,
          regime,
          valuesByChannel: { donor_reference_cash: a[4] },
          provenanceRef: s.block + ':' + s.blockHash,
        },
        issueAtUtc: input.issueAtUtc,
        requestedRaw: input.requestedRaw,
        horizonHours: input.horizonHours,
        maxHistoricalGapSeconds: input.maxHistoricalGapSeconds,
      }
      const process = buildConditionalTimeProcess(
        processInput,
        (x) => exact(x, processInput),
        (_state, elapsedMs) => {
          const shift = floor(
            checked(checked(interval.delta * cash) * BigInt(elapsedMs)),
            interval.before * BigInt(interval.ms),
          )
          const translated = checked(cash + shift)
          return { availableRaw: String(translated < 0n ? 0n : translated), entitlementRaw: null }
        },
      )
      if (!process || process.scenarios.some((x) => x.status !== 'conditional_path'))
        throw Error('native_overflow_or_invalid_process')
      return {
        donorIndex: interval.donor,
        donorFromObservation: interval.from,
        originalEndpoints: structuredClone([a, b]),
        originalIdentity: structuredClone(donor.profile.identity),
        normalizedNetRate: {
          numeratorNativeDelta: String(interval.delta),
          denominatorCashBeforeRaw: String(interval.before),
          denominatorElapsedSeconds: interval.ms / 1000,
        },
        process,
      }
    })
    const targetHeads = scenarios.map((x) => BigInt(x.process.scenarios[0].targetHeadroomRaw!))
    const inputSha256 = hash(JSON.stringify(input))
    if (!/^[0-9a-f]{64}$/.test(inputSha256)) return null
    return {
      status: 'analogous_cash_liquidity_prior' as const,
      input,
      inputSha256,
      proofs,
      sourceAgeSecondsAtIssue: (issue - source) / 1000,
      issueAtUtc: input.issueAtUtc,
      targetAtUtc: scenarios[0].process.targetAtUtc,
      sourceProofValidUntil: scenarios[0].process.sourceProofValidUntil,
      cashOnlyClaim:
        'conditional_analog_native_endpoint_cash_pressure_not_holder_capacity' as const,
      unknownOtherProngs: [
        'holder_entitlement',
        'holder_authority',
        'allocated_pullability',
        'queue_order_and_service',
        'admission',
        'initial_deposit_effect',
        'final_conversion_and_delivery',
        'future_regime_and_news',
      ] as const,
      forecastValidated: false as const,
      prospectiveValidated: false as const,
      holderExecutableExit: false as const,
      calibratedProbability: false as const,
      selection: {
        eligibleIntervals: intervals.length,
        retainedIntervals: selected.length,
        limit: 64,
        method: 'deterministic_rate_rank_including_both_extremes' as const,
      },
      historicalNormalizedNetRateRange: {
        minimum: scenarios[0].normalizedNetRate,
        maximum: scenarios.at(-1)!.normalizedNetRate,
        protocolMaximumGrossOutflow: null,
      },
      targetCashHeadroomRange: {
        minimumRaw: String(targetHeads.reduce((a, b) => (a < b ? a : b))),
        maximumRaw: String(targetHeads.reduce((a, b) => (a > b ? a : b))),
      },
      scenarios,
      assumptions: {
        fallbackAnalogyOnly: true,
        netFlowAlreadyIncludesCompetition: true,
        grossFlowSubtractedAgain: false,
        denominatorIsActualDonorCashBefore: true,
        noDollarOrTokenPriceConversion: true,
        donorReferenceStateIsNotCurrentHoldings: true,
        currentCashHeldAsNormalizationBase: true,
        interpolatedAndExtrapolatedConstantRate: true,
        sourceAgeIncluded: true,
        dailyDonorsDoNotEstablishHourlyObservations: true,
        sampledRestrictionBracketsNotContinuousDuration: true,
        unknownNewsAndRegimeChange: true,
      },
    }
  } catch {
    return null
  }
}
/** Reconstruct using the external plan; never move original issue or target clocks. */
export function selectedVenueForecastAnalogPrior(
  value: unknown,
  expected: { input: VenueForecastAnalogPriorInput; asOfMs: number },
  hash: (serialized: string) => string,
  qualifiers: AnalogPriorQualifiers,
) {
  try {
    const e = structuredClone(expected),
      v = structuredClone(value)
    const rebuilt = buildVenueForecastAnalogPrior(e.input, hash, qualifiers)
    if (
      !rebuilt ||
      !exact(v, rebuilt) ||
      !Number.isSafeInteger(e.asOfMs) ||
      e.asOfMs < Date.parse(rebuilt.issueAtUtc) ||
      e.asOfMs > Date.parse(rebuilt.sourceProofValidUntil) ||
      e.asOfMs >= Date.parse(rebuilt.targetAtUtc)
    )
      return null
    return rebuilt
  } catch {
    return null
  }
}
