/** Conditional quote-rate intervals. This module does not authenticate native evidence. */
import {
  buildMorphoV2IdleConditionalEntitlementBand,
  MORPHO_V2_IDLE_CONDITIONAL_ENTITLEMENT_ASSUMPTION,
} from './morphoV2IdleConditionalEntitlementBand'
import {
  MORPHO_V2_IDLE_JOINT_STOCK_POLICY, MORPHO_V2_IDLE_JOINT_STOCK_CLAIMS,
  type MorphoV2IdleIdentity, type MorphoV2IdleNativeSource, type MorphoV2IdleRegime,
  type MorphoV2IdleMeasurement, type MorphoV2IdleSampledTimeline,
} from './morphoV2IdleJointStockProjection'

export type MorphoV2IdleConditionalHistoricalPoint = {
  identity: MorphoV2IdleIdentity; source: MorphoV2IdleNativeSource; regime: MorphoV2IdleRegime
  idleCashRaw: string; recordedProbeSharesRaw: string; recordedQuoteAssetsRaw: string
  totalSupplySharesRaw: string; historicalOwnerSharesRaw: string | null
}
export type MorphoV2IdleJointIntervalProjectionInput = {
  identity: MorphoV2IdleIdentity; owner: string; currentSource: MorphoV2IdleNativeSource
  currentRegime: MorphoV2IdleRegime; currentSharesRaw: string; recordedProbeSharesRaw: string
  currentIdleCashRaw: string; currentFullEaRaw: string; requestedRaw: string
  competingMRaw: string | null; asOfMs: number; horizonMs: number
  donors: readonly { id: string; start: MorphoV2IdleConditionalHistoricalPoint; end: MorphoV2IdleConditionalHistoricalPoint }[]
}
export type MorphoV2IdleConditionalMeasurementInterval = {
  lower: MorphoV2IdleMeasurement; upper: MorphoV2IdleMeasurement
  entitlementLowerRaw: string; entitlementUpperRaw: string
  availableLowerRaw: string; availableUpperRaw: string
  possibleInsufficiency: boolean; definiteInsufficiency: boolean
}
type Band = { sampleCount: number; minimumRaw: string; maximumRaw: string; empiricalMeanFloorRaw: string; confidenceInterval: false }
type Bands = { available: Band; headroom: Band; shortfall: Band; signedMargin: Band }
type IntervalTimeline = {
  checkpoints: { elapsedMs: number; atUtc: string; availableLowerRaw: string; availableUpperRaw: string; possibleInsufficiency: boolean; definiteInsufficiency: boolean }[]
  firstSampledPossibleInsufficiencyMs: number | null; firstSampledDefiniteInsufficiencyMs: number | null
  lowerShrinkingAtHorizon: boolean; upperShrinkingAtHorizon: boolean
  unknownBetweenCheckpoints: true; continuousProof: false; guaranteedDurationMs: null
}
type Scenario = {
  id: string; periodMs: number; startSource: MorphoV2IdleNativeSource; endSource: MorphoV2IdleNativeSource
  idleCashDeltaRaw: string
  historicalOwnerSharesRaw: { start: string | null; end: string | null }
  historicalOwnedEntitlementAssetRaw: null; extrapolatesBeyondHistoricalSupply: boolean
} & ({
  status: 'usable'; issueMeasurement: MorphoV2IdleMeasurement; measurement: MorphoV2IdleMeasurement
  fixedShareEaDeltaRaw: string; entitlementDeltaInterval: { lowerRaw: string; upperRaw: string }
  issueInterval: MorphoV2IdleConditionalMeasurementInterval; measurementInterval: MorphoV2IdleConditionalMeasurementInterval
  sampledTimeline: MorphoV2IdleSampledTimeline; sampledIntervalTimeline: IntervalTimeline
} | { status: 'censored'; reason: 'conditional_arithmetic_domain_censored'; arithmeticCensorStage: 'historical_endpoint_bounds'; fixedShareEaDeltaRaw: null; entitlementDeltaInterval: null }
  | { status: 'censored'; reason: 'conditional_arithmetic_domain_censored'; arithmeticCensorStage: 'future_projection'; fixedShareEaDeltaRaw: string; entitlementDeltaInterval: { lowerRaw: string; upperRaw: string } })
export type MorphoV2IdleJointIntervalProjection = {
  status: 'conditional_morpho_v2_idle_joint_entitlement_interval_projection'
  identity: MorphoV2IdleIdentity; owner: string; currentSource: MorphoV2IdleNativeSource; regime: MorphoV2IdleRegime
  currentSharesRaw: string; recordedProbeSharesRaw: string; requestedRaw: string; competingMRaw: string | null
  competingFlowHandling: 'unknown_M_no_additional_reserve_assumed' | 'independent_additional_future_cash_reserve'
  historicalCashDeltaIncludesNetCompetingFlow: true
  reserveTiming: 'full_additional_reserve_applied_once_at_each_measurement'
  assumption: typeof MORPHO_V2_IDLE_CONDITIONAL_ENTITLEMENT_ASSUMPTION
  historicalConversionSemantics: 'conditional_quote_rate_bounds_not_native_repricing_or_past_entitlement'
  issuedAtUtc: string; targetAtUtc: string; sourceAgeMs: number; horizonMs: number; projectionElapsedMs: number
  currentObservedMeasurement: MorphoV2IdleMeasurement
  persistenceBaseline: { assumption: 'unchanged_idle_cash_and_full_entitlement'; measurement: MorphoV2IdleMeasurement; sampledTimeline: MorphoV2IdleSampledTimeline }
  scenarios: Scenario[]; historyStatus: 'paired_interval_scenarios' | 'no_usable_paired_intervals'
  donorCount: number; usableDonorCount: number; censoredDonorCount: number
  descriptive: { scope: 'descriptive_paired_donor_outcomes_not_probability'; headline: Bands | null; usableOnlyDiagnostic: Bands | null }
  entitlementIntervals: { headline: { lower: Bands; upper: Bands } | null; basis: 'conditional_integer_bounds_not_confidence' }
  claims: typeof MORPHO_V2_IDLE_JOINT_STOCK_CLAIMS & { exactNativeRepricing: false; nativeArithmeticDomainEstablished: false }
}
const MAX = (1n << 256n) - 1n
const POLICY = MORPHO_V2_IDLE_JOINT_STOCK_POLICY
const ADDRESS = /^0x[0-9a-f]{40}$/, HASH = /^0x[0-9a-f]{64}$/
function check(ok: unknown): asserts ok { if (!ok) throw Error('idle_conditional_interval_invalid') }
function uint(x: unknown, positive = false): bigint {
  check(typeof x === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(x))
  const n = BigInt(x); check(n <= MAX && (!positive || n > 0n)); return n
}
function plain(x: unknown, depth = 0, n = { value: 0 }): boolean {
  if (++n.value > 20000 || depth > 24) return false
  if (x === null || typeof x === 'boolean') return true
  if (typeof x === 'string') return x.length <= 512
  if (typeof x === 'number') return Number.isFinite(x)
  if (!x || typeof x !== 'object') return false
  const a = Array.isArray(x), p = Object.getPrototypeOf(x), ds = Object.getOwnPropertyDescriptors(x)
  if ((a ? p !== Array.prototype : p !== Object.prototype && p !== null) || Object.getOwnPropertySymbols(x).length || Object.values(ds).some(d => !Object.hasOwn(d, 'value'))) return false
  if (a && Object.keys(ds).length !== x.length + 1) return false
  return Object.entries(ds).every(([k, d]) => a && k === 'length' || d.enumerable && plain(d.value, depth + 1, n))
}
function own(x: unknown, keys: string[]): asserts x is Record<string, unknown> {
  check(x !== null && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k)))
}
function identity(x: unknown): asserts x is MorphoV2IdleIdentity {
  own(x, ['profileId', 'routeKey', 'destination', 'asset', 'assetDecimals', 'shareDecimals'])
  check(typeof x.profileId === 'string' && x.profileId.length > 0 && typeof x.routeKey === 'string' && x.routeKey.length > 0 && typeof x.destination === 'string' && ADDRESS.test(x.destination) && typeof x.asset === 'string' && ADDRESS.test(x.asset))
  check(Number.isSafeInteger(x.assetDecimals) && Number(x.assetDecimals) >= 0 && Number(x.assetDecimals) <= 36 && Number.isSafeInteger(x.shareDecimals) && Number(x.shareDecimals) >= 0 && Number(x.shareDecimals) <= 36)
}
function source(x: unknown): number {
  own(x, ['chainId', 'blockNumber', 'blockHash', 'blockTime', 'finalized']); uint(x.blockNumber, true)
  check(x.chainId === 1 && x.finalized === true && typeof x.blockHash === 'string' && HASH.test(x.blockHash) && typeof x.blockTime === 'string')
  const t = Date.parse(x.blockTime); check(Number.isSafeInteger(t) && new Date(t).toISOString() === x.blockTime && x.blockTime.endsWith('.000Z')); return t
}
function regime(x: unknown): asserts x is MorphoV2IdleRegime {
  own(x, ['kind', 'liquidityAdapter', 'liquidityData', 'vaultRuntimeCodeHash', 'assetRuntimeCodeHash'])
  check(x.kind === 'zero_adapter_idle' && x.liquidityAdapter === '0x' + '0'.repeat(40) && x.liquidityData === '0x' && typeof x.vaultRuntimeCodeHash === 'string' && HASH.test(x.vaultRuntimeCodeHash) && typeof x.assetRuntimeCodeHash === 'string' && HASH.test(x.assetRuntimeCodeHash))
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const floor = (n: bigint, d: bigint) => n >= 0n ? n / d : -((-n + d - 1n) / d)
const zero = (n: bigint) => n < 0n ? 0n : n
function measure(cash: bigint, ea: bigint, reserve: bigint, q: bigint): MorphoV2IdleMeasurement {
  cash = zero(cash); ea = zero(ea); check(cash <= MAX && ea <= MAX)
  const c = zero(cash - reserve), a = c < ea ? c : ea, margin = a - q
  return { projectedIdleCashRaw: cash.toString(), projectedFullEaRaw: ea.toString(), availableRaw: a.toString(), headroomRaw: zero(margin).toString(), shortfallRaw: zero(-margin).toString(), signedMarginRaw: margin.toString(), bindingProng: c < ea ? 'idle_cash' : c > ea ? 'full_entitlement' : 'equal' }
}
function interval(c: bigint, lo: bigint, hi: bigint, r: bigint, q: bigint): MorphoV2IdleConditionalMeasurementInterval {
  const lower = measure(c, lo, r, q), upper = measure(c, hi, r, q)
  return { lower, upper, entitlementLowerRaw: lower.projectedFullEaRaw, entitlementUpperRaw: upper.projectedFullEaRaw, availableLowerRaw: lower.availableRaw, availableUpperRaw: upper.availableRaw, possibleInsufficiency: BigInt(lower.availableRaw) < q, definiteInsufficiency: BigInt(upper.availableRaw) < q }
}
function sampled(at: (elapsed: number) => MorphoV2IdleConditionalMeasurementInterval, asOf: number, horizon: number) {
  const checkpoints: MorphoV2IdleSampledTimeline['checkpoints'] = [], ranges: IntervalTimeline['checkpoints'] = []
  const steps = Math.min(64, horizon)
  let firstLoss: number | null = null, firstCertain: number | null = null, firstDecrease: number | null = null
  let crossing: MorphoV2IdleSampledTimeline['firstSampledCrossing'] = null, gap = 0
  for (let i = 0; i <= steps; i++) {
    const elapsedMs = Math.floor(horizon * i / steps), x = at(elapsedMs), previous = checkpoints.at(-1)
    if (previous) {
      gap = Math.max(gap, elapsedMs - previous.elapsedMs)
      if (firstDecrease === null && BigInt(x.availableLowerRaw) < BigInt(previous.availableRaw)) firstDecrease = elapsedMs
    }
    if (firstLoss === null && x.possibleInsufficiency) { firstLoss = elapsedMs; if (previous) crossing = { earliestElapsedMs: previous.elapsedMs, latestElapsedMs: elapsedMs } }
    if (firstCertain === null && x.definiteInsufficiency) firstCertain = elapsedMs
    const atUtc = new Date(asOf + elapsedMs).toISOString()
    checkpoints.push({ elapsedMs, atUtc, availableRaw: x.lower.availableRaw, headroomRaw: x.lower.headroomRaw, shortfallRaw: x.lower.shortfallRaw, signedMarginRaw: x.lower.signedMarginRaw })
    ranges.push({ elapsedMs, atUtc, availableLowerRaw: x.availableLowerRaw, availableUpperRaw: x.availableUpperRaw, possibleInsufficiency: x.possibleInsufficiency, definiteInsufficiency: x.definiteInsufficiency })
  }
  const last = checkpoints.at(-1)!, before = checkpoints.at(-2)!, finalRange = ranges.at(-1)!, previousRange = ranges.at(-2)!
  const lowerShrinking = BigInt(last.availableRaw) < BigInt(before.availableRaw), upperShrinking = BigInt(finalRange.availableUpperRaw) < BigInt(previousRange.availableUpperRaw)
  const lower: MorphoV2IdleSampledTimeline = { checkpoints, maxCheckpointGapMs: gap, firstSampledInsufficiencyMs: firstLoss, firstSampledCrossing: crossing, insufficientAtIssue: BigInt(checkpoints[0].shortfallRaw) > 0n, firstObservedDecreaseMs: firstDecrease, shrinkingAtHorizon: lowerShrinking, horizonTrendBasis: 'last_sampled_interval', issueToHorizonAvailableChangeRaw: (BigInt(last.availableRaw) - BigInt(checkpoints[0].availableRaw)).toString(), minimumSampledAvailableRaw: checkpoints.reduce((m, c) => BigInt(c.availableRaw) < BigInt(m) ? c.availableRaw : m, checkpoints[0].availableRaw), unknownBetweenCheckpoints: true, trueFirstLossClaim: false, continuousProof: false, guaranteedDurationMs: null }
  const bounds: IntervalTimeline = { checkpoints: ranges, firstSampledPossibleInsufficiencyMs: firstLoss, firstSampledDefiniteInsufficiencyMs: firstCertain, lowerShrinkingAtHorizon: lowerShrinking, upperShrinkingAtHorizon: upperShrinking, unknownBetweenCheckpoints: true, continuousProof: false, guaranteedDurationMs: null }
  return { lower, bounds }
}
function bands(xs: MorphoV2IdleMeasurement[]): Bands | null {
  if (!xs.length) return null
  const band = (key: 'availableRaw' | 'headroomRaw' | 'shortfallRaw' | 'signedMarginRaw'): Band => {
    const ns = xs.map(x => BigInt(x[key])); return { sampleCount: xs.length, minimumRaw: ns.reduce((a, b) => a < b ? a : b).toString(), maximumRaw: ns.reduce((a, b) => a > b ? a : b).toString(), empiricalMeanFloorRaw: floor(ns.reduce((a, b) => a + b, 0n), BigInt(ns.length)).toString(), confidenceInterval: false }
  }
  return { available: band('availableRaw'), headroom: band('headroomRaw'), shortfall: band('shortfallRaw'), signedMargin: band('signedMarginRaw') }
}
/** Same-source quote constraints propagate through signed-floor donor changes from fresh actual Ea. */
export function buildMorphoV2IdleJointIntervalProjection(value: unknown): MorphoV2IdleJointIntervalProjection | null {
  try {
    check(plain(value)); own(value, ['identity', 'owner', 'currentSource', 'currentRegime', 'currentSharesRaw', 'recordedProbeSharesRaw', 'currentIdleCashRaw', 'currentFullEaRaw', 'requestedRaw', 'competingMRaw', 'asOfMs', 'horizonMs', 'donors'])
    const x = value as unknown as MorphoV2IdleJointIntervalProjectionInput
    identity(x.identity); regime(x.currentRegime); const sourceAt = source(x.currentSource)
    check(ADDRESS.test(x.owner) && Number.isSafeInteger(x.asOfMs) && x.asOfMs >= sourceAt && x.asOfMs - sourceAt <= POLICY.maximumCurrentSourceAgeMs && Number.isSafeInteger(x.horizonMs) && x.horizonMs > 0 && x.horizonMs <= POLICY.maximumHorizonMs && Number.isSafeInteger(x.asOfMs + x.horizonMs))
    const stock = uint(x.currentSharesRaw, true), probe = uint(x.recordedProbeSharesRaw, true), cash = uint(x.currentIdleCashRaw), ea = uint(x.currentFullEaRaw), q = uint(x.requestedRaw, true), reserve = x.competingMRaw === null ? 0n : uint(x.competingMRaw)
    check(Array.isArray(x.donors) && x.donors.length <= POLICY.maximumDonors)
    const ids = new Set<string>(), seen = new Map<string, string>(), blockHashes = new Map<string, string>([[x.currentSource.blockNumber, x.currentSource.blockHash]]), age = x.asOfMs - sourceAt
    const point = (value: unknown) => {
      own(value, ['identity', 'source', 'regime', 'idleCashRaw', 'recordedProbeSharesRaw', 'recordedQuoteAssetsRaw', 'totalSupplySharesRaw', 'historicalOwnerSharesRaw'])
      const p = value as unknown as MorphoV2IdleConditionalHistoricalPoint
      identity(p.identity); regime(p.regime); const t = source(p.source)
      check(same(p.identity, x.identity) && same(p.regime, x.currentRegime) && t <= sourceAt && t <= x.asOfMs && uint(p.source.blockNumber, true) <= uint(x.currentSource.blockNumber, true) && uint(p.recordedProbeSharesRaw, true) === probe)
      uint(p.idleCashRaw); uint(p.recordedQuoteAssetsRaw); check(uint(p.totalSupplySharesRaw, true) >= probe)
      if (p.historicalOwnerSharesRaw !== null) uint(p.historicalOwnerSharesRaw)
      const prior = seen.get(p.source.blockHash), scalars = JSON.stringify([p.source, p.idleCashRaw, p.recordedProbeSharesRaw, p.recordedQuoteAssetsRaw, p.totalSupplySharesRaw])
      check(prior === undefined || prior === scalars); seen.set(p.source.blockHash, scalars)
      const blockHash = blockHashes.get(p.source.blockNumber); check(blockHash === undefined || blockHash === p.source.blockHash); blockHashes.set(p.source.blockNumber, p.source.blockHash)
      const b = buildMorphoV2IdleConditionalEntitlementBand({ recordedProbeSharesRaw: p.recordedProbeSharesRaw, recordedQuoteAssetsRaw: p.recordedQuoteAssetsRaw, requestedSharesRaw: stock.toString(), historicalTotalSupplySharesRaw: p.totalSupplySharesRaw })
      check(b); return { p, t, b }
    }
    const scenarios: Scenario[] = x.donors.map(d => {
      own(d, ['id', 'start', 'end']); check(typeof d.id === 'string' && d.id.length > 0 && d.id.length <= 128 && !ids.has(d.id)); ids.add(d.id)
      const a = point(d.start), b = point(d.end), periodMs = b.t - a.t
      check(periodMs > 0 && uint(a.p.source.blockNumber, true) < uint(b.p.source.blockNumber, true) && b.t < sourceAt)
      const deltaC = uint(b.p.idleCashRaw) - uint(a.p.idleCashRaw)
      const base = { id: d.id, periodMs, startSource: structuredClone(a.p.source), endSource: structuredClone(b.p.source), idleCashDeltaRaw: deltaC.toString(), historicalOwnerSharesRaw: { start: a.p.historicalOwnerSharesRaw, end: b.p.historicalOwnerSharesRaw }, historicalOwnedEntitlementAssetRaw: null, extrapolatesBeyondHistoricalSupply: a.b.extrapolatesBeyondHistoricalSupply === true || b.b.extrapolatesBeyondHistoricalSupply === true }
      if (a.b.status !== 'bounded' || b.b.status !== 'bounded') return { ...base, status: 'censored', reason: 'conditional_arithmetic_domain_censored', arithmeticCensorStage: 'historical_endpoint_bounds', fixedShareEaDeltaRaw: null, entitlementDeltaInterval: null }
      const lo = BigInt(b.b.lowerAssetsRaw) - BigInt(a.b.upperAssetsRaw), hi = BigInt(b.b.upperAssetsRaw) - BigInt(a.b.lowerAssetsRaw)
      const metadata = { ...base, fixedShareEaDeltaRaw: lo.toString(), entitlementDeltaInterval: { lowerRaw: lo.toString(), upperRaw: hi.toString() } }
      try {
        const at = (elapsed: number) => { const t = BigInt(age + elapsed), dt = BigInt(periodMs); return interval(cash + floor(deltaC * t, dt), ea + floor(lo * t, dt), ea + floor(hi * t, dt), reserve, q) }
        const sampledResult = sampled(at, x.asOfMs, x.horizonMs), issueInterval = at(0), measurementInterval = at(x.horizonMs)
        return { ...metadata, status: 'usable', issueMeasurement: issueInterval.lower, measurement: measurementInterval.lower, issueInterval, measurementInterval, sampledTimeline: sampledResult.lower, sampledIntervalTimeline: sampledResult.bounds }
      } catch { return { ...metadata, status: 'censored', reason: 'conditional_arithmetic_domain_censored', arithmeticCensorStage: 'future_projection' } }
    })
    const usable = scenarios.filter((s): s is Extract<Scenario, { status: 'usable' }> => s.status === 'usable')
    const lower = bands(usable.map(s => s.measurementInterval.lower)), upper = bands(usable.map(s => s.measurementInterval.upper)), complete = usable.length > 0 && usable.length === scenarios.length
    const persistence = measure(cash, ea, reserve, q), persistenceTimeline = sampled(() => interval(cash, ea, ea, reserve, q), x.asOfMs, x.horizonMs).lower
    const result: MorphoV2IdleJointIntervalProjection = { status: 'conditional_morpho_v2_idle_joint_entitlement_interval_projection', identity: structuredClone(x.identity), owner: x.owner, currentSource: structuredClone(x.currentSource), regime: structuredClone(x.currentRegime), currentSharesRaw: x.currentSharesRaw, recordedProbeSharesRaw: x.recordedProbeSharesRaw, requestedRaw: x.requestedRaw, competingMRaw: x.competingMRaw, competingFlowHandling: x.competingMRaw === null ? 'unknown_M_no_additional_reserve_assumed' : 'independent_additional_future_cash_reserve', historicalCashDeltaIncludesNetCompetingFlow: true, reserveTiming: 'full_additional_reserve_applied_once_at_each_measurement', assumption: MORPHO_V2_IDLE_CONDITIONAL_ENTITLEMENT_ASSUMPTION, historicalConversionSemantics: 'conditional_quote_rate_bounds_not_native_repricing_or_past_entitlement', issuedAtUtc: new Date(x.asOfMs).toISOString(), targetAtUtc: new Date(x.asOfMs + x.horizonMs).toISOString(), sourceAgeMs: age, horizonMs: x.horizonMs, projectionElapsedMs: age + x.horizonMs, currentObservedMeasurement: persistence, persistenceBaseline: { assumption: 'unchanged_idle_cash_and_full_entitlement', measurement: persistence, sampledTimeline: persistenceTimeline }, scenarios, historyStatus: usable.length ? 'paired_interval_scenarios' : 'no_usable_paired_intervals', donorCount: scenarios.length, usableDonorCount: usable.length, censoredDonorCount: scenarios.length - usable.length, descriptive: { scope: 'descriptive_paired_donor_outcomes_not_probability', headline: complete ? lower : null, usableOnlyDiagnostic: lower }, entitlementIntervals: { headline: complete && lower && upper ? { lower, upper } : null, basis: 'conditional_integer_bounds_not_confidence' }, claims: { ...MORPHO_V2_IDLE_JOINT_STOCK_CLAIMS, exactNativeRepricing: false, nativeArithmeticDomainEstablished: false } }
    check(new TextEncoder().encode(JSON.stringify(result)).length <= POLICY.maximumSerializedBytes)
    return result
  } catch { return null }
}
