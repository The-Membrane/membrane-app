import {
  buildConditionalTimeProcess,
  type ConditionalTimeProcessInput,
} from '../venueForecast/conditionalTimeProcess'
import { selectedHolderExitCapacity } from './holderExitCapacity'
import {
  stusdsPinnedProtocolHistory,
  type StusdsProtocolPoint,
} from './stusdsProtocolCapacityHistoryPins'
import {
  stusdsRayPow,
  type StusdsHistoricalHolderCapacityInput,
  type AcceptStusdsCurrentEvidence,
} from './stusdsHistoricalHolderCapacityProjection'

export type StusdsHolderTimeProcessInput = StusdsHistoricalHolderCapacityInput
const MAX = (1n << 256n) - 1n,
  RAY = 10n ** 27n
const ASSET = '0xdc035d45d973e3ec169d2276ddab16f1e407384f'
const raw = (v: unknown): v is string =>
  typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) <= MAX
const utc = (v: unknown): v is string =>
  typeof v === 'string' &&
  Number.isSafeInteger(Date.parse(v)) &&
  new Date(Date.parse(v)).toISOString() === v
function exact(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => exact(v, b[i]))
    )
  if ((a !== null && typeof a === 'object') || (b !== null && typeof b === 'object'))
    return (
      a !== null &&
      b !== null &&
      typeof a === 'object' &&
      typeof b === 'object' &&
      Object.keys(a).length === Object.keys(b).length &&
      Object.keys(a).every((k) => Object.hasOwn(b, k) && exact((a as any)[k], (b as any)[k]))
    )
  return Object.is(a, b)
}
function checked(n: bigint) {
  if (n < 0n || n > MAX) throw Error('native_overflow')
  return n
}
function mul(a: bigint, b: bigint) {
  return checked(a * b)
}
function indexes(p: StusdsProtocolPoint, seconds: number) {
  const g = p.globalProngs
  for (const key of [
    'chiRaw',
    'strRaw',
    'rhoUnix',
    'vatStoredRateRaw',
    'jugDutyRaw',
    'jugBaseRaw',
    'jugRhoUnix',
    'chiNowRaw',
    'burnRateNowRaw',
  ] as const)
    if (!raw(g[key])) throw Error('mechanical_prong_invalid')
  const rho = Number(g.rhoUnix),
    jr = Number(g.jugRhoUnix)
  if (
    !Number.isSafeInteger(seconds) ||
    !Number.isSafeInteger(rho) ||
    !Number.isSafeInteger(jr) ||
    rho > seconds ||
    jr > seconds
  )
    throw Error('mechanical_clock_invalid')
  const cp = stusdsRayPow(g.strRaw, seconds - rho),
    rp = stusdsRayPow(String(checked(BigInt(g.jugDutyRaw) + BigInt(g.jugBaseRaw))), seconds - jr)
  if (cp === null || rp === null) throw Error('mechanical_growth_unavailable')
  const chi = mul(BigInt(cp), BigInt(g.chiRaw)) / RAY,
    rate = mul(BigInt(rp), BigInt(g.vatStoredRateRaw)) / RAY
  if (chi === 0n) throw Error('zero_index')
  return { chi, rate }
}
const flowKeys = ['totalSupplyRaw', 'vatArtRaw', 'clipDueRaw'] as const
/** Declared joint constant-NET-flow-rate paths with current-parameter mechanical accrual.
 * The external callback must approve the complete current native receipt; neither this math nor self hashes do so. */
export function buildStusdsHolderTimeProcess(
  supplied: StusdsHolderTimeProcessInput,
  acceptCurrentEvidence: AcceptStusdsCurrentEvidence,
) {
  try {
    const input = structuredClone(supplied),
      pin = stusdsPinnedProtocolHistory(),
      b = input.binding,
      c = input.current,
      p = c.point,
      g = p.globalProngs,
      sourceAt = Date.parse(p.source.blockTime)
    if (
      !exact(input.history, pin) ||
      typeof acceptCurrentEvidence !== 'function' ||
      !Number.isSafeInteger(input.asOfMs) ||
      b.asOfMs !== input.asOfMs ||
      !Number.isFinite(input.horizonHours) ||
      input.horizonHours <= 0 ||
      input.horizonHours > 8760 ||
      p.source.chainId !== 1 ||
      !utc(p.source.blockTime) ||
      !utc(c.readAtUtc) ||
      sourceAt % 1000 !== 0 ||
      sourceAt > Date.parse(c.readAtUtc) ||
      Date.parse(c.readAtUtc) > input.asOfMs ||
      input.asOfMs < sourceAt ||
      input.asOfMs - sourceAt > 1800000 ||
      typeof c.captureReceiptSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(c.captureReceiptSha256) ||
      typeof p.source.blockNumber !== 'string' ||
      !/^[1-9][0-9]*$/.test(p.source.blockNumber) ||
      BigInt(p.source.blockNumber) > BigInt(Number.MAX_SAFE_INTEGER) ||
      !exact(b.currentSource, {
        chainId: 1,
        blockNumber: Number(p.source.blockNumber),
        blockHash: p.source.blockHash,
        blockTime: p.source.blockTime,
        finalized: true,
      })
    )
      return null
    const [base, target] = pin.history.points
    if (
      pin.history.points.length !== 2 ||
      pin.history.elapsedSeconds[1] !== 1152 ||
      Date.parse(target.source.blockTime) >= sourceAt ||
      !exact(p.runtimeIdentities, base.runtimeIdentities) ||
      !exact(base.runtimeIdentities, target.runtimeIdentities) ||
      !exact(p.addresses, base.addresses) ||
      !exact(base.addresses, target.addresses) ||
      p.ilk !== base.ilk ||
      target.ilk !== base.ilk ||
      p.status !== 'conditional_contract_reported_prongs' ||
      g.derivationEligibility !== 'conditional_retained_runtime_class' ||
      g.retainedImplementationMatches !== true ||
      !exact(g.units, base.globalProngs.units) ||
      !exact(g.units, target.globalProngs.units) ||
      !utc(pin.knowledgeCutoff) ||
      Date.parse(pin.knowledgeCutoff) > input.asOfMs
    )
      return null
    if (acceptCurrentEvidence(structuredClone(c)) !== true) return null
    const cap = selectedHolderExitCapacity(input.capacityAgreement, b)
    if (
      !cap ||
      b.routeKey !== 'USDS → StUsds [USDS]' ||
      b.destination !== '0x99cd4ec3f88a45940936f469e4bb72a2a701eeb9' ||
      b.asset !== ASSET ||
      b.assetDecimals !== 18 ||
      cap.quote.entitlementMethod !== 'preview_redeem_full_position' ||
      !raw(cap.quote.entitlementRaw)
    )
      return null
    const E = BigInt(cap.quote.entitlementRaw),
      now = indexes(p, sourceAt / 1000)
    if (String(now.chi) !== g.chiNowRaw || String(now.rate) !== g.burnRateNowRaw) return null
    const channels = flowKeys.map((key, i) => ({
      key,
      assetAddress: ASSET,
      decimals: i === 2 ? 45 : 18,
      unit: i === 2 ? 'usds_rad' : 'usds_wad',
      negativeHandling: 'reject_scenario' as const,
    }))
    const values = (point: StusdsProtocolPoint) =>
      Object.fromEntries(flowKeys.map((k) => [k, point.globalProngs[k]]))
    const regime = 'stusds_retained_runtime_class_v1'
    const kernelInput: ConditionalTimeProcessInput = {
      channels,
      observations: pin.history.points.map((point, i) => ({
        sourceAtUtc: point.source.blockTime,
        availableAtUtc: pin.knowledgeCutoff,
        regime,
        channels: structuredClone(channels),
        valuesByChannel: values(point),
        provenanceRef: pin.captureReceiptSha256 + ':' + i,
      })),
      outputAsset: { assetAddress: ASSET, decimals: 18 },
      measurementRule: 'stusds_unused_burn_rate_and_full_entitlement_interval',
      current: {
        sourceAtUtc: p.source.blockTime,
        readAtUtc: c.readAtUtc,
        regime,
        valuesByChannel: values(p),
        provenanceRef: c.captureReceiptSha256,
      },
      issueAtUtc: new Date(input.asOfMs).toISOString(),
      requestedRaw: b.requestedRaw,
      horizonHours: input.horizonHours,
      maxHistoricalGapSeconds: 1152,
    }
    const measure = (upper: boolean) => (state: Record<string, string>, elapsedMs: number) => {
      const future = indexes(p, sourceAt / 1000 + Math.floor(elapsedMs / 1000)),
        assets = mul(BigInt(state.totalSupplyRaw), future.chi),
        debt = checked(mul(BigInt(state.vatArtRaw), future.rate) + BigInt(state.clipDueRaw)),
        U = assets > debt ? (assets - debt) / RAY : 0n
      const product = mul(upper ? checked(E + 1n) : E, future.chi)
      const entitlement = upper
        ? product === 0n
          ? 0n
          : checked((product - 1n) / now.chi + 1n) - 1n
        : product / now.chi
      return { availableRaw: String(U), entitlementRaw: String(entitlement) }
    }
    // Qualification is already bound to private canonical history/current above; kernel receives private clones only.
    const qualify = (v: ConditionalTimeProcessInput) => exact(v, kernelInput)
    const lower = buildConditionalTimeProcess(kernelInput, qualify, measure(false)),
      upper = buildConditionalTimeProcess(kernelInput, qualify, measure(true))
    if (!lower || !upper) return null
    return {
      status: 'conditional_stusds_holder_time_process' as const,
      input,
      owner: b.owner,
      requestedRaw: b.requestedRaw,
      issueAtUtc: lower.issueAtUtc,
      targetAtUtc: lower.targetAtUtc,
      sourceProofValidUntil: lower.sourceProofValidUntil,
      lower,
      upper,
      targetInterval:
        lower.targetSummary && upper.targetSummary
          ? {
              headroomLowerRaw: lower.targetSummary.minimumHeadroomRaw,
              headroomUpperRaw: upper.targetSummary.maximumHeadroomRaw,
              scenarioCount: lower.targetSummary.scenarioCount,
            }
          : null,
      assumptions: {
        constantJointNetFlowRate: true,
        currentMechanicalParametersUnchanged: true,
        futureProtocolClock: 'floor_elapsed_milliseconds_to_whole_seconds' as const,
        wallClockTargetExact: true,
        fullEntitlementInterval: true,
        implementationEquivalenceVerified: false,
        withdrawalEligibilityUnverified: true,
        burnRateNotGetterRate: true,
      },
      holderExecutableExit: false as const,
      forecastValidated: false as const,
      prospectiveValidated: false as const,
      minedPayout: false as const,
      calibratedProbability: false as const,
    }
  } catch {
    return null
  }
}
export function selectedStusdsHolderTimeProcess(
  value: unknown,
  expected: StusdsHolderTimeProcessInput,
  asOfMs: number,
  acceptCurrentEvidence: AcceptStusdsCurrentEvidence,
) {
  try {
    const v = structuredClone(value),
      e = structuredClone(expected)
    if (
      !Number.isSafeInteger(asOfMs) ||
      asOfMs < e.asOfMs ||
      asOfMs - Date.parse(e.current.point.source.blockTime) > 1800000
    )
      return null
    const rebuilt = buildStusdsHolderTimeProcess(e, acceptCurrentEvidence)
    if (!rebuilt || !exact(v, rebuilt) || asOfMs >= Date.parse(rebuilt.targetAtUtc)) return null
    return rebuilt
  } catch {
    return null
  }
}
