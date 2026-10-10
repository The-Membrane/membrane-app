import { morphoV2AdapterCapacityMath } from './morphoV2AdapterCapacityMath'

/** Mechanical model only. An external issuer must authenticate native frames. */
export type MorphoV2JointStockRegime = {
  profile: string
  runtimeCodeIdentity: string
  configurationIdentity: string
  feePolicyIdentity: string
  enrolled: boolean
  asset: string
  assetDecimals: number
  shareDecimals: number
}
export type MorphoV2JointStockFrame = {
  source: { chainId: number; blockNumber: string; blockHash: string; blockTime: string }
  regime: MorphoV2JointStockRegime
  prongs: {
    market: readonly string[]
    borrowRateRaw: string
    internalSharesRaw: string
    actualSharesRaw: string
    allocationsRaw: readonly string[]
    idleCashRaw: string
    blueCashRaw: string
    allowanceRaw: string
  }
  /** Historical quotes concern the same hypothetical S, never past ownership. */
  fixedShareEntitlement: {
    method: 'native_preview_redeem_fixed_shares'
    sharesRaw: string
    assetsRaw: string
  }
}
export type MorphoV2JointStockProjectionInput = {
  current: MorphoV2JointStockFrame
  donors: readonly { id: string; start: MorphoV2JointStockFrame; end: MorphoV2JointStockFrame }[]
  fixedSharesRaw: string
  requestedRaw: string
  horizonMs: number
  /** Actual issue time minus the native source timestamp, counted once. */
  sourceAgeMs?: number
  /** Capacity diagnostic metadata; this is not queued or competing demand M. */
  marketMaximumRaw: string | null
  /** Queued/competing demand M, if independently known. Unknown remains null. */
  queuedCompetingMRaw?: string | null
  includeSampledDuration?: boolean
}
const CHANNELS = [
  'supplyAssets',
  'borrowAssets',
  'supplyShares',
  'borrowShares',
  'internalShares',
  'actualShares',
  'allocation0',
  'allocation1',
  'allocation2',
  'idleCash',
  'globalBlueCash',
  'fullEa',
] as const
type Channel = (typeof CHANNELS)[number]
type Stocks = Record<Channel, bigint>
type RawStocks = Record<Channel, string>
type Measurement = {
  protocolCapacityRaw: string
  fullEaRaw: string
  availableRaw: string
  headroomRaw: string
}
type SampledDuration = {
  checkpoints: { elapsedMs: number; availableRaw: string; headroomRaw: string }[]
  firstSampledInsufficiencyMs: number | null
  maxCheckpointGapMs: number
  unknownBetweenCheckpoints: true
  trueFirstLossClaim: false
  continuousProof: false
}
type Scenario = {
  id: string
  donorPeriodMs: number
  signedDeltaByChannel: RawStocks
} & (
  | {
      status: 'usable'
      projectedStocks: RawStocks
      measurement: Measurement
      sampledDuration: SampledDuration | null
    }
  | {
      status: 'censored'
      censorReason: string
    }
)
const MAX = (1n << 256n) - 1n
const check = (ok: boolean, reason: string): void => {
  if (!ok) throw Error(reason)
}
function uint(value: unknown): bigint {
  check(typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value), 'invalid_native_uint')
  const n = BigInt(value as string)
  check(n <= MAX, 'native_uint_overflow')
  return n
}
function timestamp(value: string): number {
  const ms = Date.parse(value)
  check(
    Number.isSafeInteger(ms) && ms > 0 && ms % 1000 === 0 && new Date(ms).toISOString() === value,
    'invalid_canonical_time',
  )
  return ms
}
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  const ak = Object.keys(a),
    bk = Object.keys(b)
  return (
    ak.length === bk.length &&
    ak.every(
      (k) =>
        Object.hasOwn(b, k) &&
        same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    )
  )
}
function rawStocks(s: Stocks): RawStocks {
  return Object.fromEntries(CHANNELS.map((k) => [k, String(s[k])])) as RawStocks
}
function nativeMath(frame: MorphoV2JointStockFrame, stocks?: Stocks, elapsedMs = 0) {
  const g = frame.prongs,
    at = BigInt(Math.floor((timestamp(frame.source.blockTime) + elapsedMs) / 1000))
  return morphoV2AdapterCapacityMath({
    // Normalized synthetic market lastUpdate equals measurement time. No second accrual.
    market: stocks
      ? [
          stocks.supplyAssets,
          stocks.supplyShares,
          stocks.borrowAssets,
          stocks.borrowShares,
          at,
          uint(g.market[5]),
        ]
      : g.market.map(uint),
    at,
    borrowRate: uint(g.borrowRateRaw),
    internalShares: stocks?.internalShares ?? uint(g.internalSharesRaw),
    actualShares: stocks?.actualShares ?? uint(g.actualSharesRaw),
    allocations: stocks
      ? [stocks.allocation0, stocks.allocation1, stocks.allocation2]
      : g.allocationsRaw.map(uint),
    idleCash: stocks?.idleCash ?? uint(g.idleCashRaw),
    blueCash: stocks?.globalBlueCash ?? uint(g.blueCashRaw),
    allowance: uint(g.allowanceRaw),
    enrolled: frame.regime.enrolled,
  })
}
function normalize(frame: MorphoV2JointStockFrame, fixedS: string): Stocks {
  const r = frame.regime,
    g = frame.prongs,
    q = frame.fixedShareEntitlement,
    s = frame.source
  check(
    Number.isSafeInteger(s.chainId) &&
      s.chainId > 0 &&
      typeof s.blockNumber === 'string' &&
      uint(s.blockNumber) > 0n &&
      typeof s.blockHash === 'string' &&
      /^0x[0-9a-f]{64}$/.test(s.blockHash),
    'invalid_source_header',
  )
  check(
    ['profile', 'runtimeCodeIdentity', 'configurationIdentity', 'feePolicyIdentity'].every(
      (k) =>
        typeof r[k as keyof typeof r] === 'string' && (r[k as keyof typeof r] as string).length > 0,
    ) &&
      typeof r.enrolled === 'boolean' &&
      /^0x[0-9a-f]{40}$/.test(r.asset) &&
      [r.assetDecimals, r.shareDecimals].every((n) => Number.isSafeInteger(n) && n >= 0 && n <= 36),
    'invalid_regime',
  )
  check(
    q.method === 'native_preview_redeem_fixed_shares' && q.sharesRaw === fixedS,
    'fixed_share_quote_mismatch',
  )
  check(g.market.length === 6 && g.allocationsRaw.length === 3, 'invalid_prong_shape')
  const m = nativeMath(frame)
  return {
    supplyAssets: BigInt(m.accruedSupplyAssetsRaw),
    borrowAssets: BigInt(m.accruedBorrowAssetsRaw),
    supplyShares: BigInt(m.accruedSupplySharesRaw),
    borrowShares: uint(g.market[3]),
    internalShares: uint(g.internalSharesRaw),
    actualShares: uint(g.actualSharesRaw),
    allocation0: uint(g.allocationsRaw[0]),
    allocation1: uint(g.allocationsRaw[1]),
    allocation2: uint(g.allocationsRaw[2]),
    idleCash: uint(g.idleCashRaw),
    globalBlueCash: uint(g.blueCashRaw),
    fullEa: uint(q.assetsRaw),
  }
}
function measure(
  frame: MorphoV2JointStockFrame,
  stocks: Stocks,
  Q: bigint,
  elapsedMs: number,
): Measurement {
  CHANNELS.forEach((k) =>
    check(stocks[k] >= 0n && stocks[k] <= MAX, 'projected_stock_out_of_range:' + k),
  )
  const C = BigInt(nativeMath(frame, stocks, elapsedMs).conditionalProtocolCapacityRaw)
  const available = stocks.fullEa < C ? stocks.fullEa : C
  return {
    protocolCapacityRaw: String(C),
    fullEaRaw: String(stocks.fullEa),
    availableRaw: String(available),
    headroomRaw: String(available > Q ? available - Q : 0n),
  }
}
function signedFloor(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator
  return numerator < 0n && numerator % denominator !== 0n ? quotient - 1n : quotient
}
function project(source: Stocks, delta: Stocks, elapsedMs: number, periodMs: number): Stocks {
  // Mathematical floor also rounds negative, nonintegral NET shifts downward.
  return Object.fromEntries(
    CHANNELS.map((k) => [
      k,
      source[k] + signedFloor(delta[k] * BigInt(elapsedMs), BigInt(periodMs)),
    ]),
  ) as Stocks
}
function rational(n: bigint, d: bigint) {
  return { numeratorRaw: String(n), denominatorRaw: String(d), floorRaw: String(n / d) }
}
function summary(values: bigint[]) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    count = sorted.length
  const middle = Math.floor(count / 2)
  return {
    empiricalMean: rational(
      values.reduce((a, b) => a + b, 0n),
      BigInt(count),
    ),
    band: {
      minRaw: String(sorted[0]),
      median:
        count % 2
          ? rational(sorted[middle], 1n)
          : rational(sorted[middle - 1] + sorted[middle], 2n),
      maxRaw: String(sorted[count - 1]),
    },
  }
}
/** Joint historical NET stock changes are descriptive conditional scenarios, not probabilities. */
export function buildMorphoV2JointStockProjection(supplied: MorphoV2JointStockProjectionInput) {
  try {
    const input = structuredClone(supplied),
      Q = uint(input.requestedRaw)
    check(
      uint(input.fixedSharesRaw) > 0n &&
        Number.isSafeInteger(input.horizonMs) &&
        input.horizonMs > 0 &&
        input.horizonMs <= 7 * 86400000 &&
        input.horizonMs % 1000 === 0,
      'invalid_horizon_or_fixed_shares',
    )
    const sourceAgeMs = input.sourceAgeMs === undefined ? 0 : input.sourceAgeMs
    check(
      Number.isSafeInteger(sourceAgeMs) && sourceAgeMs >= 0 && sourceAgeMs <= 30 * 60000,
      'invalid_source_age',
    )
    const projectionElapsedMs = sourceAgeMs + input.horizonMs
    check(
      input.marketMaximumRaw === null || uint(input.marketMaximumRaw) >= 0n,
      'invalid_market_maximum',
    )
    const queuedCompetingMRaw = input.queuedCompetingMRaw ?? null
    check(
      queuedCompetingMRaw === null || uint(queuedCompetingMRaw) >= 0n,
      'invalid_queued_competing_M',
    )
    check(
      input.includeSampledDuration === undefined ||
        typeof input.includeSampledDuration === 'boolean',
      'invalid_duration_option',
    )
    check(Array.isArray(input.donors) && input.donors.length <= 128, 'invalid_donor_count')
    const sourceMs = timestamp(input.current.source.blockTime)
    check(Number.isSafeInteger(sourceMs + projectionElapsedMs), 'projected_clock_overflow')
    const source = normalize(input.current, input.fixedSharesRaw)
    const baseline = measure(input.current, source, Q, 0)
    const scenarios: Scenario[] = [],
      excludedDonors: { id: string; reason: string }[] = []
    const ids = new Set<string>()
    let maxDepletion: { amountRaw: string; donorPeriodMs: number; donorId: string } | null = null
    let maxProtocolDepletion: { amountRaw: string; donorPeriodMs: number; donorId: string } | null =
      null
    let acceptedDonorCount = 0
    for (const donor of input.donors) {
      let periodMs: number, delta: Stocks
      try {
        check(
          typeof donor.id === 'string' && donor.id.length > 0 && !ids.has(donor.id),
          'invalid_or_duplicate_donor_id',
        )
        ids.add(donor.id)
        const a = donor.start,
          z = donor.end,
          startMs = timestamp(a.source.blockTime),
          endMs = timestamp(z.source.blockTime)
        check(
          startMs < endMs &&
            endMs < sourceMs &&
            a.source.chainId === z.source.chainId &&
            z.source.chainId === input.current.source.chainId &&
            BigInt(a.source.blockNumber) < BigInt(z.source.blockNumber) &&
            BigInt(z.source.blockNumber) < BigInt(input.current.source.blockNumber),
          'donor_time_or_block_leakage',
        )
        check(
          same(a.regime, z.regime) &&
            same(z.regime, input.current.regime) &&
            a.prongs.market[5] === z.prongs.market[5] &&
            z.prongs.market[5] === input.current.prongs.market[5],
          'code_configuration_fee_enrollment_or_units_regime_changed',
        )
        const from = normalize(a, input.fixedSharesRaw),
          to = normalize(z, input.fixedSharesRaw)
        periodMs = endMs - startMs
        delta = Object.fromEntries(CHANNELS.map((k) => [k, to[k] - from[k]])) as Stocks
        const fromMeasurement = measure(a, from, Q, 0),
          toMeasurement = measure(z, to, Q, 0)
        const fromActive = BigInt(fromMeasurement.availableRaw),
          toActive = BigInt(toMeasurement.availableRaw)
        const depletion = fromActive > toActive ? fromActive - toActive : 0n
        if (
          maxDepletion === null ||
          depletion * BigInt(maxDepletion.donorPeriodMs) >
            BigInt(maxDepletion.amountRaw) * BigInt(periodMs)
        )
          maxDepletion = {
            amountRaw: String(depletion),
            donorPeriodMs: periodMs,
            donorId: donor.id,
          }
        const fromC = BigInt(fromMeasurement.protocolCapacityRaw),
          toC = BigInt(toMeasurement.protocolCapacityRaw)
        const protocolDepletion = fromC > toC ? fromC - toC : 0n
        if (
          maxProtocolDepletion === null ||
          protocolDepletion * BigInt(maxProtocolDepletion.donorPeriodMs) >
            BigInt(maxProtocolDepletion.amountRaw) * BigInt(periodMs)
        )
          maxProtocolDepletion = {
            amountRaw: String(protocolDepletion),
            donorPeriodMs: periodMs,
            donorId: donor.id,
          }
        acceptedDonorCount++
      } catch (e) {
        excludedDonors.push({
          id: typeof donor?.id === 'string' ? donor.id : '',
          reason: e instanceof Error ? e.message : 'invalid_donor',
        })
        continue
      }
      const common = {
        id: donor.id,
        donorPeriodMs: periodMs,
        signedDeltaByChannel: rawStocks(delta),
      }
      try {
        const projected = project(source, delta, projectionElapsedMs, periodMs)
        const measurement = measure(input.current, projected, Q, projectionElapsedMs)
        let sampledDuration: SampledDuration | null = null
        if (input.includeSampledDuration) {
          const horizonSeconds = input.horizonMs / 1000,
            intervals = Math.min(64, horizonSeconds)
          const checkpoints: SampledDuration['checkpoints'] = []
          let maxCheckpointGapMs = 0,
            firstSampledInsufficiencyMs: number | null = null
          // Native stock/capacity paths need not be monotone. Samples never prove a first crossing.
          for (let i = 0; i <= intervals; i++) {
            const elapsedMs = Math.floor((i * horizonSeconds) / intervals) * 1000
            let sampled: Measurement
            try {
              sampled = measure(
                input.current,
                project(source, delta, sourceAgeMs + elapsedMs, periodMs),
                Q,
                sourceAgeMs + elapsedMs,
              )
            } catch (e) {
              throw Error(
                'sampled_interval_invalid:' + (e instanceof Error ? e.message : 'invalid'),
              )
            }
            if (i > 0)
              maxCheckpointGapMs = Math.max(
                maxCheckpointGapMs,
                elapsedMs - checkpoints[i - 1].elapsedMs,
              )
            if (firstSampledInsufficiencyMs === null && BigInt(sampled.availableRaw) < Q)
              firstSampledInsufficiencyMs = elapsedMs
            checkpoints.push({
              elapsedMs,
              availableRaw: sampled.availableRaw,
              headroomRaw: sampled.headroomRaw,
            })
          }
          sampledDuration = {
            checkpoints,
            firstSampledInsufficiencyMs,
            maxCheckpointGapMs,
            unknownBetweenCheckpoints: true,
            trueFirstLossClaim: false,
            continuousProof: false,
          }
        }
        scenarios.push({
          ...common,
          status: 'usable',
          projectedStocks: rawStocks(projected),
          measurement,
          sampledDuration,
        })
      } catch (e) {
        scenarios.push({
          ...common,
          status: 'censored',
          censorReason: e instanceof Error ? e.message : 'invalid_joint_projection',
        })
      }
    }
    const usable = scenarios.filter(
      (s): s is Extract<Scenario, { status: 'usable' }> => s.status === 'usable',
    )
    const descriptive = {
      available: summary(usable.map((s) => BigInt(s.measurement.availableRaw))),
      headroom: summary(usable.map((s) => BigInt(s.measurement.headroomRaw))),
    }
    return {
      status: 'conditional_morpho_v2_joint_stock_projection' as const,
      sourceSnapshot: input.current,
      sourceNormalizedStocks: rawStocks(source),
      fixedSharesRaw: input.fixedSharesRaw,
      requestedRaw: input.requestedRaw,
      horizonMs: input.horizonMs,
      ...(sourceAgeMs > 0 ? { sourceAgeMs, projectionElapsedMs } : {}),
      marketMaximumRaw: input.marketMaximumRaw,
      queuedCompetingMRaw,
      persistenceBaseline: baseline,
      scenarios,
      excludedDonors,
      usableScenarioCount: usable.length,
      descriptiveExpectedFlow: {
        qualifiedDonorCount: scenarios.length,
        usableScenarioCount: usable.length,
        censoredScenarioCount: scenarios.length - usable.length,
        scope: 'descriptive_empirical_usable_scenarios_only' as const,
        // An invalid tail cannot disappear into an apparently complete headline band.
        headline: usable.length > 0 && usable.length === scenarios.length ? descriptive : null,
        usableOnlyDiagnostic: descriptive,
      },
      maxObservedInclusiveNetDepletionRate:
        maxDepletion === null
          ? null
          : {
              ...maxDepletion,
              nativeUnit: `native_asset_raw${input.current.regime.assetDecimals}`,
              asset: input.current.regime.asset,
              acceptedDonorCount,
              definition: 'positive_net_decline_of_min_fixed_share_fullEa_and_protocol_C' as const,
            },
      maxObservedProtocolCapacityNetDepletionRate:
        maxProtocolDepletion === null
          ? null
          : {
              ...maxProtocolDepletion,
              nativeUnit: `native_asset_raw${input.current.regime.assetDecimals}`,
              asset: input.current.regime.asset,
              acceptedDonorCount,
              definition: 'positive_net_decline_of_protocol_C_independent_of_fullEa_and_Q' as const,
            },
      assumptions: {
        jointHistoricalNetStockChangesScaleLinearly: true,
        signedNativeUnitRounding: 'mathematical_floor' as const,
        queuedCompetingMIsMetadataNotAdditionalNetOutflow: true,
        sourceAllowanceAndFeePolicyHeldFixed: true,
        endpointInterestAndFeeNormalizedOnceAtOwnCanonicalTime: true,
        syntheticLastUpdateEqualsMeasurementTime: true,
        sourceBorrowRateHasZeroAdditionalElapsed: true,
        sameFixedShareNativePreviewRedeemAtEveryEndpoint: true,
        durationUsesBoundedWholeSecondCheckpoints: true,
      },
      claims: {
        authenticatedEvidence: false,
        sourceImplementationEquivalence: false,
        pastOwnership: false,
        fullEaDerivedFromRequestedQ: false,
        marketMaximumCountedAsEntitlement: false,
        calibratedProbability: false,
        queuedCompetingMCountedAsEntitlement: false,
        queuedCompetingMAddedAsDepletion: false,
        continuousPathProof: false,
        futureGuarantee: false,
        executionProof: false,
      },
    }
  } catch {
    return null
  }
}
