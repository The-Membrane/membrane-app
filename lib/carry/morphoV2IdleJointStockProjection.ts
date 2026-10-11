/**
 * Deterministic idle-vault mathematics. This module authenticates no native facts
 * and issues no receipt, profile approval, wallet control or execution authority.
 */
import { buildModeledShortageWindows, type ModeledShortageWindows } from './modeledShortageWindows'

export const MORPHO_V2_IDLE_JOINT_STOCK_POLICY = Object.freeze({
  maximumDonors: 128,
  maximumCheckpoints: 65,
  maximumHorizonMs: 7 * 86400000,
  maximumCurrentSourceAgeMs: 30 * 60000,
  maximumSerializedBytes: 4 * 1024 * 1024,
})
export const MORPHO_V2_IDLE_JOINT_STOCK_CLAIMS = Object.freeze({
  researchOnly: true,
  authenticated: false,
  nativeAuthority: false,
  originalAuthority: false,
  profileApproval: false,
  historicalOwnershipProven: false,
  historicalOwnership: false,
  currentWalletControl: false,
  sourceImplementationEquivalence: false,
  holderExecutableExit: false,
  executionValidated: false,
  guaranteedExecution: false,
  executionAuthority: false,
  forecastAuthority: false,
  forecastEligibility: false,
  stationarityProven: false,
  prospectiveValidation: false,
  forecastValidated: false,
  calibrated: false,
  calibratedProbability: false,
  coveragePromotion: false,
})

export type MorphoV2IdleIdentity = {
  profileId: string
  routeKey: string
  destination: string
  asset: string
  assetDecimals: number
  shareDecimals: number
}
export type MorphoV2IdleNativeSource = {
  chainId: 1
  blockNumber: string
  blockHash: string
  blockTime: string
  finalized: true
}
export type MorphoV2IdleRegime = {
  kind: 'zero_adapter_idle'
  liquidityAdapter: string
  liquidityData: '0x'
  vaultRuntimeCodeHash: string
  assetRuntimeCodeHash: string
}
export type MorphoV2IdleHistoricalPoint = {
  identity: MorphoV2IdleIdentity
  owner: string
  source: MorphoV2IdleNativeSource
  regime: MorphoV2IdleRegime
  idleCashRaw: string
  /** Diagnostic actual past owner stock; never the historical conversion input. */
  historicalOwnerSharesRaw: string | null
  fixedCurrentStockConversion: {
    method: 'native_preview_redeem_fixed_current_shares'
    source: MorphoV2IdleNativeSource
    probeSharesRaw: string
    asset: string
    assetDecimals: number
    shareDecimals: number
    assetsRaw: string
  }
}
export type MorphoV2IdleJointStockProjectionInput = {
  identity: MorphoV2IdleIdentity
  owner: string
  currentSource: MorphoV2IdleNativeSource
  currentRegime: MorphoV2IdleRegime
  currentSharesRaw: string
  currentIdleCashRaw: string
  currentFullEaRaw: string
  asOfMs: number
  horizonMs: number
  requestedRaw: string
  /** Additional future cash reserve only. Later binding must validate its authority. */
  competingMRaw: string | null
  donors: readonly { id: string; start: MorphoV2IdleHistoricalPoint; end: MorphoV2IdleHistoricalPoint }[]
}
export type MorphoV2IdleMeasurement = {
  projectedIdleCashRaw: string
  projectedFullEaRaw: string
  availableRaw: string
  headroomRaw: string
  shortfallRaw: string
  signedMarginRaw: string
  bindingProng: 'idle_cash' | 'full_entitlement' | 'equal'
}
type Checkpoint = {
  elapsedMs: number
  atUtc: string
  availableRaw: string
  headroomRaw: string
  shortfallRaw: string
  signedMarginRaw: string
}
type Crossing = { earliestElapsedMs: number; latestElapsedMs: number }
export type MorphoV2IdleSampledTimeline = {
  checkpoints: Checkpoint[]
  maxCheckpointGapMs: number
  firstSampledInsufficiencyMs: number | null
  firstSampledCrossing: Crossing | null
  insufficientAtIssue: boolean
  firstObservedDecreaseMs: number | null
  shrinkingAtHorizon: boolean
  horizonTrendBasis: 'last_sampled_interval'
  issueToHorizonAvailableChangeRaw: string
  minimumSampledAvailableRaw: string
  unknownBetweenCheckpoints: true
  trueFirstLossClaim: false
  continuousProof: false
  guaranteedDurationMs: null
}
type DonorMetadata = {
  id: string
  periodMs: number
  startSource: MorphoV2IdleNativeSource
  endSource: MorphoV2IdleNativeSource
  idleCashDeltaRaw: string
  fixedShareEaDeltaRaw: string
  historicalOwnerSharesRaw: { start: string | null; end: string | null }
  historicalOwnedEntitlementAssetRaw: null
}
export type MorphoV2IdleDonorScenario = DonorMetadata &
  (
    | {
        status: 'usable'
        issueMeasurement: MorphoV2IdleMeasurement
        measurement: MorphoV2IdleMeasurement
        sampledTimeline: MorphoV2IdleSampledTimeline
        modeledShortageWindows: ModeledShortageWindows | null
      }
    | { status: 'censored'; reason: 'projected_stock_uint256_overflow' }
  )
type Band = {
  sampleCount: number
  minimumRaw: string
  maximumRaw: string
  empiricalMeanFloorRaw: string
  confidenceInterval: false
}
type Bands = {
  available: Band
  headroom: Band
  shortfall: Band
  signedMargin: Band
  minimumSampledAvailable: Band
}
export type MorphoV2IdleJointStockProjection = {
  status: 'conditional_morpho_v2_idle_joint_stock_projection'
  identity: MorphoV2IdleIdentity
  owner: string
  currentSource: MorphoV2IdleNativeSource
  regime: MorphoV2IdleRegime
  currentSharesRaw: string
  requestedRaw: string
  competingMRaw: string | null
  competingFlowHandling: 'unknown_M_no_additional_reserve_assumed' | 'independent_additional_future_cash_reserve'
  historicalCashDeltaIncludesNetCompetingFlow: true
  reserveTiming: 'full_additional_reserve_applied_once_at_each_measurement'
  assumption: 'repeat_observed_joint_idle_cash_and_fixed_current_stock_conversion_changes'
  historicalConversionSemantics: 'hypothetical_fixed_current_stock_not_past_owned_entitlement'
  issuedAtUtc: string
  targetAtUtc: string
  sourceAgeMs: number
  horizonMs: number
  projectionElapsedMs: number
  currentObservedMeasurement: MorphoV2IdleMeasurement
  persistenceBaseline: {
    assumption: 'unchanged_idle_cash_and_full_entitlement'
    measurement: MorphoV2IdleMeasurement
    sampledTimeline: MorphoV2IdleSampledTimeline
  }
  scenarios: MorphoV2IdleDonorScenario[]
  historyStatus: 'paired_interval_scenarios' | 'no_usable_paired_intervals'
  donorCount: number
  usableDonorCount: number
  censoredDonorCount: number
  descriptive: {
    scope: 'descriptive_paired_donor_outcomes_not_probability'
    headline: Bands | null
    usableOnlyDiagnostic: Bands | null
  }
  claims: typeof MORPHO_V2_IDLE_JOINT_STOCK_CLAIMS
}

const MAX = (1n << 256n) - 1n
const ZERO = '0x' + '0'.repeat(40)
const POLICY = MORPHO_V2_IDLE_JOINT_STOCK_POLICY
type RecordValue = Record<string, unknown>
function check(ok: unknown, reason: string): asserts ok {
  if (!ok) throw Error(reason)
}
/** Validate own data properties before reading values; getters never supply facts. */
function record(value: unknown, keys: readonly string[]): RecordValue {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), 'record')
  const prototype = Object.getPrototypeOf(value)
  check(prototype === Object.prototype || prototype === null, 'record_prototype')
  const own = Reflect.ownKeys(value)
  check(own.length === keys.length && own.every((key) => typeof key === 'string' && keys.includes(key)), 'record_keys')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  check(keys.every((key) => Object.hasOwn(descriptors, key) && Object.hasOwn(descriptors[key], 'value')), 'record_accessors')
  return value as RecordValue
}
function boundedDonors(value: unknown): unknown[] {
  check(Array.isArray(value) && value.length <= POLICY.maximumDonors, 'donor_count')
  const keys = Reflect.ownKeys(value)
  check(keys.length === value.length + 1 && keys.every((key) =>
    key === 'length' || (typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length)), 'donor_array')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  check(keys.every((key) => Object.hasOwn(descriptors[key as string], 'value')), 'donor_accessors')
  return value
}
function text(value: unknown, maximum: number): string {
  check(typeof value === 'string' && value.length > 0 && value.length <= maximum &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value), 'text')
  return value
}
function hex(value: unknown, digits: number): string {
  check(typeof value === 'string' && new RegExp('^0x[0-9a-fA-F]{' + digits + '}$').test(value), 'hex')
  return value.toLowerCase()
}
function uint(value: unknown): bigint {
  check(typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value), 'uint')
  const result = BigInt(value)
  check(result <= MAX, 'uint_overflow')
  return result
}
function decimals(value: unknown): number {
  check(typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 36, 'decimals')
  return value
}
function timestamp(value: unknown): number {
  check(typeof value === 'string' && value.length <= 28, 'timestamp')
  const result = Date.parse(value)
  check(Number.isSafeInteger(result) && result > 0 && result % 1000 === 0 &&
    new Date(result).toISOString() === value, 'canonical_timestamp')
  return result
}
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
function identity(value: unknown): MorphoV2IdleIdentity {
  const x = record(value, ['profileId', 'routeKey', 'destination', 'asset', 'assetDecimals', 'shareDecimals'])
  return {
    profileId: text(x.profileId, 128), routeKey: text(x.routeKey, 512),
    destination: hex(x.destination, 40), asset: hex(x.asset, 40),
    assetDecimals: decimals(x.assetDecimals), shareDecimals: decimals(x.shareDecimals),
  }
}
function source(value: unknown): MorphoV2IdleNativeSource {
  const x = record(value, ['chainId', 'blockNumber', 'blockHash', 'blockTime', 'finalized'])
  check(x.chainId === 1 && x.finalized === true, 'chain_or_finality')
  const block = uint(x.blockNumber)
  check(block > 0n && block <= BigInt(Number.MAX_SAFE_INTEGER), 'block_number')
  timestamp(x.blockTime)
  return { chainId: 1, blockNumber: String(block), blockHash: hex(x.blockHash, 64),
    blockTime: x.blockTime as string, finalized: true }
}
function regime(value: unknown): MorphoV2IdleRegime {
  const x = record(value, ['kind', 'liquidityAdapter', 'liquidityData', 'vaultRuntimeCodeHash', 'assetRuntimeCodeHash'])
  check(x.kind === 'zero_adapter_idle' && hex(x.liquidityAdapter, 40) === ZERO &&
    x.liquidityData === '0x', 'idle_regime')
  const vault = hex(x.vaultRuntimeCodeHash, 64), asset = hex(x.assetRuntimeCodeHash, 64)
  check(vault !== '0x' + '0'.repeat(64) && asset !== '0x' + '0'.repeat(64), 'runtime_identity')
  return { kind: 'zero_adapter_idle', liquidityAdapter: ZERO, liquidityData: '0x',
    vaultRuntimeCodeHash: vault, assetRuntimeCodeHash: asset }
}
function floorDiv(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator
  return numerator < 0n && numerator % denominator !== 0n ? quotient - 1n : quotient
}
const positive = (n: bigint) => n > 0n ? n : 0n
function measurement(cash: bigint, ea: bigint, reserve: bigint, q: bigint): MorphoV2IdleMeasurement {
  check(cash <= MAX && ea <= MAX, 'projected_stock_uint256_overflow')
  cash = positive(cash); ea = positive(ea)
  const afterReserve = positive(cash - reserve)
  const available = afterReserve < ea ? afterReserve : ea
  const margin = available - q
  return { projectedIdleCashRaw: String(cash), projectedFullEaRaw: String(ea),
    availableRaw: String(available), headroomRaw: String(positive(margin)),
    shortfallRaw: String(positive(-margin)), signedMarginRaw: String(margin),
    bindingProng: afterReserve < ea ? 'idle_cash' : ea < afterReserve ? 'full_entitlement' : 'equal' }
}
function sampleTimeline(
  at: (elapsedMs: number) => MorphoV2IdleMeasurement, asOfMs: number, horizonMs: number,
): MorphoV2IdleSampledTimeline {
  const seconds = horizonMs / 1000, intervals = Math.min(POLICY.maximumCheckpoints - 1, seconds)
  const checkpoints: Checkpoint[] = []
  let firstSampledInsufficiencyMs: number | null = null, firstSampledCrossing: Crossing | null = null
  let firstObservedDecreaseMs: number | null = null, maxCheckpointGapMs = 0
  let minimum: bigint | null = null
  for (let i = 0; i <= intervals; i++) {
    const elapsedMs = Math.floor(i * seconds / intervals) * 1000
    const x = at(elapsedMs), available = BigInt(x.availableRaw)
    const previous = checkpoints.at(-1)
    if (previous) {
      maxCheckpointGapMs = Math.max(maxCheckpointGapMs, elapsedMs - previous.elapsedMs)
      if (available < BigInt(previous.availableRaw) && firstObservedDecreaseMs === null)
        firstObservedDecreaseMs = elapsedMs
      if (BigInt(previous.shortfallRaw) === 0n && BigInt(x.shortfallRaw) > 0n && firstSampledCrossing === null)
        firstSampledCrossing = { earliestElapsedMs: previous.elapsedMs, latestElapsedMs: elapsedMs }
    }
    if (BigInt(x.shortfallRaw) > 0n && firstSampledInsufficiencyMs === null) firstSampledInsufficiencyMs = elapsedMs
    minimum = minimum === null || available < minimum ? available : minimum
    checkpoints.push({ elapsedMs, atUtc: new Date(asOfMs + elapsedMs).toISOString(),
      availableRaw: x.availableRaw, headroomRaw: x.headroomRaw, shortfallRaw: x.shortfallRaw,
      signedMarginRaw: x.signedMarginRaw })
  }
  const change = BigInt(checkpoints.at(-1)!.availableRaw) - BigInt(checkpoints[0].availableRaw)
  const lastIntervalChange = BigInt(checkpoints.at(-1)!.availableRaw) - BigInt(checkpoints.at(-2)!.availableRaw)
  return { checkpoints, maxCheckpointGapMs, firstSampledInsufficiencyMs, firstSampledCrossing,
    insufficientAtIssue: BigInt(checkpoints[0].shortfallRaw) > 0n, firstObservedDecreaseMs,
    shrinkingAtHorizon: lastIntervalChange < 0n, horizonTrendBasis: 'last_sampled_interval',
    issueToHorizonAvailableChangeRaw: String(change),
    minimumSampledAvailableRaw: String(minimum), unknownBetweenCheckpoints: true,
    trueFirstLossClaim: false, continuousProof: false, guaranteedDurationMs: null }
}
function band(values: bigint[]): Band {
  return { sampleCount: values.length,
    minimumRaw: String(values.reduce((a, b) => a < b ? a : b)),
    maximumRaw: String(values.reduce((a, b) => a > b ? a : b)),
    empiricalMeanFloorRaw: String(floorDiv(values.reduce((a, b) => a + b, 0n), BigInt(values.length))),
    confidenceInterval: false }
}
function bands(scenarios: Extract<MorphoV2IdleDonorScenario, { status: 'usable' }>[]): Bands | null {
  if (scenarios.length === 0) return null
  return { available: band(scenarios.map((x) => BigInt(x.measurement.availableRaw))),
    headroom: band(scenarios.map((x) => BigInt(x.measurement.headroomRaw))),
    shortfall: band(scenarios.map((x) => BigInt(x.measurement.shortfallRaw))),
    signedMargin: band(scenarios.map((x) => BigInt(x.measurement.signedMarginRaw))),
    minimumSampledAvailable: band(scenarios.map((x) => BigInt(x.sampledTimeline.minimumSampledAvailableRaw))) }
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}

/** Malformed or mismatched evidence returns null; numerical overflow remains censored. */
export function buildMorphoV2IdleJointStockProjection(
  supplied: MorphoV2IdleJointStockProjectionInput,
): MorphoV2IdleJointStockProjection | null {
  try {
    const input = record(supplied, ['identity', 'owner', 'currentSource', 'currentRegime',
      'currentSharesRaw', 'currentIdleCashRaw', 'currentFullEaRaw', 'asOfMs', 'horizonMs',
      'requestedRaw', 'competingMRaw', 'donors'])
    const id = identity(input.identity), owner = hex(input.owner, 40)
    const currentSource = source(input.currentSource), currentRegime = regime(input.currentRegime)
    const shares = uint(input.currentSharesRaw), cash = uint(input.currentIdleCashRaw)
    const ea = uint(input.currentFullEaRaw), q = uint(input.requestedRaw)
    check(shares > 0n, 'empty_current_stock')
    check(input.competingMRaw === null || typeof input.competingMRaw === 'string', 'competing_M')
    const reserve = input.competingMRaw === null ? 0n : uint(input.competingMRaw)
    const sourceMs = timestamp(currentSource.blockTime), asOfMs = input.asOfMs, horizonMs = input.horizonMs
    check(typeof asOfMs === 'number' && Number.isSafeInteger(asOfMs) &&
      asOfMs >= sourceMs && asOfMs - sourceMs <= POLICY.maximumCurrentSourceAgeMs, 'source_freshness')
    check(typeof horizonMs === 'number' && Number.isSafeInteger(horizonMs) && horizonMs > 0 &&
      horizonMs <= POLICY.maximumHorizonMs && horizonMs % 1000 === 0, 'horizon')
    const sourceAgeMs = asOfMs - sourceMs, projectionElapsedMs = sourceAgeMs + horizonMs
    check(Number.isSafeInteger(asOfMs + horizonMs) && Number.isFinite(new Date(asOfMs + horizonMs).getTime()), 'target_time')
    const rawDonors = boundedDonors(input.donors)
    const byHeight = new Map<string, MorphoV2IdleNativeSource>()
    const byHash = new Map<string, MorphoV2IdleNativeSource>()
    const facts = new Map<string, { cash: string; ea: string; ownerShares: string | null }>()
    const remember = (s: MorphoV2IdleNativeSource, c: string, e: string, ownerShares: string | null) => {
      const height = byHeight.get(s.blockNumber), hash = byHash.get(s.blockHash)
      check((!height || same(height, s)) && (!hash || same(hash, s)), 'source_collision')
      byHeight.set(s.blockNumber, s); byHash.set(s.blockHash, s)
      const prior = facts.get(s.blockHash)
      check(!prior || (prior.cash === c && prior.ea === e &&
        (prior.ownerShares === null || ownerShares === null || prior.ownerShares === ownerShares)), 'point_scalar_collision')
      facts.set(s.blockHash, { cash: c, ea: e, ownerShares: ownerShares ?? prior?.ownerShares ?? null })
    }
    remember(currentSource, String(cash), String(ea), String(shares))
    const point = (value: unknown) => {
      const x = record(value, ['identity', 'owner', 'source', 'regime', 'idleCashRaw',
        'historicalOwnerSharesRaw', 'fixedCurrentStockConversion'])
      check(same(identity(x.identity), id) && hex(x.owner, 40) === owner &&
        same(regime(x.regime), currentRegime), 'point_identity_or_regime')
      const s = source(x.source), c = uint(x.idleCashRaw)
      const conversion = record(x.fixedCurrentStockConversion, ['method', 'source',
        'probeSharesRaw', 'asset', 'assetDecimals', 'shareDecimals', 'assetsRaw'])
      check(conversion.method === 'native_preview_redeem_fixed_current_shares' &&
        same(source(conversion.source), s) && uint(conversion.probeSharesRaw) === shares &&
        hex(conversion.asset, 40) === id.asset && decimals(conversion.assetDecimals) === id.assetDecimals &&
        decimals(conversion.shareDecimals) === id.shareDecimals, 'fixed_current_stock_conversion')
      const e = uint(conversion.assetsRaw)
      const ownerShares = x.historicalOwnerSharesRaw === null ? null : String(uint(x.historicalOwnerSharesRaw))
      check(timestamp(s.blockTime) <= sourceMs && timestamp(s.blockTime) <= asOfMs &&
        BigInt(s.blockNumber) <= BigInt(currentSource.blockNumber), 'future_donor')
      remember(s, String(c), String(e), ownerShares)
      return { source: s, cash: c, ea: e, ownerShares }
    }
    const ids = new Set<string>(), intervals = new Set<string>()
    const donors = rawDonors.map((value) => {
      const x = record(value, ['id', 'start', 'end']), donorId = text(x.id, 128)
      check(!ids.has(donorId), 'duplicate_donor_id'); ids.add(donorId)
      const start = point(x.start), end = point(x.end)
      const periodMs = timestamp(end.source.blockTime) - timestamp(start.source.blockTime)
      check(periodMs > 0 && Number.isSafeInteger(periodMs) &&
        BigInt(end.source.blockNumber) > BigInt(start.source.blockNumber), 'donor_chronology')
      const interval = start.source.blockHash + '/' + end.source.blockHash
      check(!intervals.has(interval), 'duplicate_interval'); intervals.add(interval)
      return { id: donorId, start, end, periodMs }
    })
    const persistence = measurement(cash, ea, reserve, q)
    const scenarios: MorphoV2IdleDonorScenario[] = donors.map((donor): MorphoV2IdleDonorScenario => {
      const cashDelta = donor.end.cash - donor.start.cash, eaDelta = donor.end.ea - donor.start.ea
      const metadata: DonorMetadata = { id: donor.id, periodMs: donor.periodMs,
        startSource: donor.start.source, endSource: donor.end.source,
        idleCashDeltaRaw: String(cashDelta), fixedShareEaDeltaRaw: String(eaDelta),
        historicalOwnerSharesRaw: { start: donor.start.ownerShares, end: donor.end.ownerShares },
        historicalOwnedEntitlementAssetRaw: null }
      const at = (elapsedMs: number) => measurement(
        cash + floorDiv(cashDelta * BigInt(sourceAgeMs + elapsedMs), BigInt(donor.periodMs)),
        ea + floorDiv(eaDelta * BigInt(sourceAgeMs + elapsedMs), BigInt(donor.periodMs)),
        reserve, q,
      )
      try {
        // Raw source stocks enter the solver: its age + elapsed term is applied once.
        // Zero Q remains supported by this math-only builder; the holder binder requires Q > 0.
        const modeledShortageWindows = q === 0n ? null : buildModeledShortageWindows({
          currentIdleCashRaw: String(cash), currentFullEaRaw: String(ea),
          idleCashDeltaRaw: String(cashDelta), entitlementDeltaRaw: String(eaDelta),
          sourceAgeMs, periodMs: donor.periodMs, horizonMs, requestedRaw: String(q),
          competingMRaw: input.competingMRaw as string | null,
        })
        if (modeledShortageWindows?.status === 'censored') throw Error('projected_stock_uint256_overflow')
        check(q === 0n || modeledShortageWindows?.status === 'modeled', 'analytical_windows_invalid')
        return { ...metadata, status: 'usable', issueMeasurement: at(0),
          measurement: at(horizonMs), sampledTimeline: sampleTimeline(at, asOfMs, horizonMs),
          modeledShortageWindows }
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'projected_stock_uint256_overflow') throw error
        return { ...metadata, status: 'censored', reason: 'projected_stock_uint256_overflow' }
      }
    })
    const usable = scenarios.filter((x): x is Extract<MorphoV2IdleDonorScenario, { status: 'usable' }> => x.status === 'usable')
    const diagnostic = bands(usable)
    const result: MorphoV2IdleJointStockProjection = {
      status: 'conditional_morpho_v2_idle_joint_stock_projection', identity: id, owner,
      currentSource, regime: currentRegime, currentSharesRaw: String(shares), requestedRaw: String(q),
      competingMRaw: input.competingMRaw as string | null,
      competingFlowHandling: input.competingMRaw === null ? 'unknown_M_no_additional_reserve_assumed' : 'independent_additional_future_cash_reserve',
      historicalCashDeltaIncludesNetCompetingFlow: true,
      reserveTiming: 'full_additional_reserve_applied_once_at_each_measurement',
      assumption: 'repeat_observed_joint_idle_cash_and_fixed_current_stock_conversion_changes',
      historicalConversionSemantics: 'hypothetical_fixed_current_stock_not_past_owned_entitlement',
      issuedAtUtc: new Date(asOfMs).toISOString(), targetAtUtc: new Date(asOfMs + horizonMs).toISOString(),
      sourceAgeMs, horizonMs, projectionElapsedMs,
      currentObservedMeasurement: measurement(cash, ea, 0n, q),
      persistenceBaseline: { assumption: 'unchanged_idle_cash_and_full_entitlement', measurement: persistence,
        sampledTimeline: sampleTimeline(() => persistence, asOfMs, horizonMs) },
      scenarios, historyStatus: usable.length > 0 ? 'paired_interval_scenarios' : 'no_usable_paired_intervals',
      donorCount: donors.length, usableDonorCount: usable.length, censoredDonorCount: donors.length - usable.length,
      descriptive: { scope: 'descriptive_paired_donor_outcomes_not_probability',
        headline: usable.length > 0 && usable.length === scenarios.length ? diagnostic : null,
        usableOnlyDiagnostic: diagnostic },
      claims: MORPHO_V2_IDLE_JOINT_STOCK_CLAIMS,
    }
    check(new TextEncoder().encode(JSON.stringify(result)).byteLength <= POLICY.maximumSerializedBytes, 'output_storage_bound')
    return freeze(result)
  } catch {
    return null
  }
}
