import { selectedHolderExitCapacity, type HolderExitCapacityBinding } from './holderExitCapacity'
import {
  stusdsPinnedProtocolHistory,
  type StusdsProtocolPoint,
} from './stusdsProtocolCapacityHistoryPins'

const MAX = (1n << 256n) - 1n,
  RAY = 10n ** 27n
const ROUTE = 'USDS → StUsds [USDS]',
  VAULT = '0x99cd4ec3f88a45940936f469e4bb72a2a701eeb9',
  ASSET = '0xdc035d45d973e3ec169d2276ddab16f1e407384f'
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
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
  if (record(a) || record(b))
    return (
      record(a) &&
      record(b) &&
      Object.keys(a).length === Object.keys(b).length &&
      Object.keys(a).every((k) => Object.hasOwn(b, k) && exact(a[k], b[k]))
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
// Official StUsds._rpow169–190/Jug._rpow56–77 round half up internally.
// Subsequent StUsds index multiplication and Jug._rmul floor, not round-half.
export function stusdsRayPow(xRaw: string, seconds: number): string | null {
  try {
    if (
      !raw(xRaw) ||
      !Number.isSafeInteger(seconds) ||
      seconds < 0 ||
      seconds > Number.MAX_SAFE_INTEGER
    )
      return null
    let x = BigInt(xRaw),
      n = BigInt(seconds),
      z = n % 2n ? x : RAY
    if (x === 0n) return String(n === 0n ? RAY : 0n)
    for (n /= 2n; n; n /= 2n) {
      x = checked(mul(x, x) + RAY / 2n) / RAY
      if (n % 2n) z = checked(mul(z, x) + RAY / 2n) / RAY
    }
    return String(z)
  } catch {
    return null
  }
}
function accrued(base: bigint, index: bigint, seconds: number) {
  const power = stusdsRayPow(String(base), seconds)
  if (power === null) throw Error('growth_invalid')
  return mul(BigInt(power), index) / RAY
}
export type StusdsCurrentCapacityEvidence = {
  point: StusdsProtocolPoint
  readAtUtc: string
  captureReceiptSha256: string
}
export type StusdsHistoricalHolderCapacityInput = {
  history: unknown
  current: StusdsCurrentCapacityEvidence
  capacityAgreement: unknown
  binding: HolderExitCapacityBinding
  horizonHours: number
  asOfMs: number
}
/** Must independently replay/pin the complete two-origin current receipt, not payload self hashes. */
export type AcceptStusdsCurrentEvidence = (current: StusdsCurrentCapacityEvidence) => boolean
function mechanical(point: StusdsProtocolPoint, atSeconds: number) {
  const p = point.globalProngs
  for (const key of [
    'totalSupplyRaw',
    'chiRaw',
    'strRaw',
    'rhoUnix',
    'chiNowRaw',
    'vatArtRaw',
    'vatStoredRateRaw',
    'jugDutyRaw',
    'jugRhoUnix',
    'jugBaseRaw',
    'burnRateNowRaw',
    'clipDueRaw',
  ] as const)
    if (!raw(p[key])) throw Error('prong_invalid')
  const rho = Number(p.rhoUnix),
    jugRho = Number(p.jugRhoUnix)
  if (
    !Number.isSafeInteger(rho) ||
    !Number.isSafeInteger(jugRho) ||
    rho > atSeconds ||
    jugRho > atSeconds
  )
    throw Error('clock_invalid')
  const chi = accrued(BigInt(p.strRaw), BigInt(p.chiRaw), atSeconds - rho)
  const rate = accrued(
    checked(BigInt(p.jugDutyRaw) + BigInt(p.jugBaseRaw)),
    BigInt(p.vatStoredRateRaw),
    atSeconds - jugRho,
  )
  if (chi === 0n) throw Error('zero_index')
  return { chi, rate }
}
function unused(S: bigint, chi: bigint, Art: bigint, rate: bigint, Due: bigint) {
  const assets = mul(S, chi),
    liabilities = checked(mul(Art, rate) + Due)
  return assets > liabilities ? (assets - liabilities) / RAY : 0n
}
function runs(values: bigint[], sourceAt: number, elapsed: number) {
  const below = values.map((v) => v < 0n)
  if (!below.some(Boolean)) return []
  return [
    {
      firstBelowObservation: below[0] ? 0 : 1,
      lastBelowObservation: below[1] ? 1 : 0,
      onset: below[0]
        ? null
        : {
            after: new Date(sourceAt).toISOString(),
            by: new Date(sourceAt + elapsed * 1000).toISOString(),
          },
      recovery:
        below[0] && !below[1]
          ? {
              after: new Date(sourceAt).toISOString(),
              by: new Date(sourceAt + elapsed * 1000).toISOString(),
            }
          : null,
      leftCensored: below[0],
      rightCensored: below[1],
      sampledSpanSeconds: below[0] && below[1] ? elapsed : 0,
    },
  ]
}
export function buildStusdsHistoricalHolderCapacityProjection(
  input: StusdsHistoricalHolderCapacityInput,
  acceptCurrentEvidence: AcceptStusdsCurrentEvidence,
) {
  try {
    // External replay callbacks must never gain authority over subsequently used caller state.
    input = structuredClone(input)
    const pin = stusdsPinnedProtocolHistory(),
      b = input.binding,
      c = input.current,
      p = c.point,
      sourceAt = Date.parse(p.source.blockTime)
    if (
      !exact(input.history, pin) ||
      !Number.isSafeInteger(input.asOfMs) ||
      b.asOfMs !== input.asOfMs ||
      b.routeKey !== ROUTE ||
      b.destination !== VAULT ||
      b.asset !== ASSET ||
      b.assetDecimals !== 18 ||
      !raw(b.requestedRaw) ||
      BigInt(b.requestedRaw) === 0n ||
      !Number.isSafeInteger(input.horizonHours) ||
      input.horizonHours < 1 ||
      input.horizonHours > 720 ||
      p.source.chainId !== 1 ||
      !utc(p.source.blockTime) ||
      !utc(c.readAtUtc) ||
      !utc(pin.knowledgeCutoff) ||
      input.asOfMs < Date.parse(pin.knowledgeCutoff) ||
      sourceAt > Date.parse(c.readAtUtc) ||
      Date.parse(c.readAtUtc) > input.asOfMs ||
      input.asOfMs - sourceAt > 1800000 ||
      input.asOfMs < sourceAt ||
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
      }) ||
      typeof acceptCurrentEvidence !== 'function' ||
      acceptCurrentEvidence(structuredClone(c)) !== true
    )
      return null
    const capacity = selectedHolderExitCapacity(input.capacityAgreement, b)
    if (
      !capacity ||
      capacity.quote.entitlementMethod !== 'preview_redeem_full_position' ||
      !raw(capacity.quote.entitlementRaw)
    )
      return null
    const [base, target] = pin.history.points,
      elapsed = pin.history.elapsedSeconds[1]
    if (
      pin.history.points.length !== 2 ||
      pin.history.elapsedSeconds[0] !== 0 ||
      elapsed !== 1152 ||
      Date.parse(target.source.blockTime) - Date.parse(base.source.blockTime) !== elapsed * 1000 ||
      BigInt(target.source.blockNumber) <= BigInt(base.source.blockNumber) ||
      Date.parse(target.source.blockTime) >= sourceAt ||
      !exact(base.runtimeIdentities, target.runtimeIdentities) ||
      !exact(p.runtimeIdentities, base.runtimeIdentities) ||
      !exact(base.addresses, target.addresses) ||
      !exact(p.addresses, base.addresses) ||
      p.ilk !== base.ilk ||
      target.ilk !== base.ilk ||
      p.status !== 'conditional_contract_reported_prongs' ||
      p.globalProngs.derivationEligibility !== 'conditional_retained_runtime_class' ||
      p.globalProngs.retainedImplementationMatches !== true ||
      !exact(p.globalProngs.units, base.globalProngs.units)
    )
      return null
    // Independently reproduce all recorded current index/debt accrual before projecting.
    const nowSeconds = sourceAt / 1000
    if (!Number.isSafeInteger(nowSeconds)) return null
    const now = mechanical(p, nowSeconds)
    if (
      String(now.chi) !== p.globalProngs.chiNowRaw ||
      String(now.rate) !== p.globalProngs.burnRateNowRaw
    )
      return null
    const future = mechanical(p, nowSeconds + elapsed),
      E = BigInt(capacity.quote.entitlementRaw),
      Q = BigInt(b.requestedRaw)
    const S = BigInt(p.globalProngs.totalSupplyRaw),
      Art = BigInt(p.globalProngs.vatArtRaw),
      Due = BigInt(p.globalProngs.clipDueRaw)
    const delta = (key: 'totalSupplyRaw' | 'vatArtRaw' | 'clipDueRaw') =>
      BigInt(target.globalProngs[key]) - BigInt(base.globalProngs[key])
    const Sf = S + delta('totalSupplyRaw'),
      Af = Art + delta('vatArtRaw'),
      Df = Due + delta('clipDueRaw')
    if (Sf < 0n || Af < 0n || Df < 0n) return null
    checked(Sf)
    checked(Af)
    checked(Df)
    const U0 = unused(S, now.chi, Art, now.rate, Due),
      U1 = unused(Sf, future.chi, Af, future.rate, Df)
    const lo = mul(E, future.chi) / now.chi,
      upperProduct = mul(checked(E + 1n), future.chi)
    const hi = upperProduct === 0n ? 0n : checked((upperProduct - 1n) / now.chi + 1n) - 1n
    const min = (a: bigint, z: bigint) => (a < z ? a : z),
      currentCapacity = min(E, U0)
    const capacityLower = [currentCapacity, min(U1, lo)],
      capacityUpper = [currentCapacity, min(U1, hi)]
    const lower = capacityLower.map((x) => x - Q),
      upper = capacityUpper.map((x) => x - Q),
      targetAt = new Date(sourceAt + elapsed * 1000).toISOString()
    const trough = (values: bigint[]) => ({
      observation: values[1] < values[0] ? 1 : 0,
      headroomRaw: String(values[1] < values[0] ? values[1] : values[0]),
    })
    return {
      status: 'conditional_stusds_historical_holder_capacity_projection' as const,
      input: structuredClone(input),
      owner: b.owner,
      request: {
        requestedRaw: b.requestedRaw,
        horizonHours: input.horizonHours,
        asOf: new Date(input.asOfMs).toISOString(),
      },
      currentEntitlementRaw: String(E),
      currentQuotedMaxWithdrawRaw: capacity.quote.quotedMaxWithdrawRaw,
      currentSource: structuredClone(b.currentSource),
      currentReadAtUtc: c.readAtUtc,
      sourceProofValidUntil: new Date(sourceAt + 1800000).toISOString(),
      evidence: {
        rawFileSha256: pin.rawFileSha256,
        exportFileSha256: pin.exportFileSha256,
        captureReceiptSha256: pin.captureReceiptSha256,
        knowledgeCutoff: pin.knowledgeCutoff,
        pairedEpisodeCount: 1,
        historicalHolderMatches: false,
      },
      method:
        'joint_supply_art_due_delta_then_mechanical_ray_growth_then_holder_entitlement_clip_q_once' as const,
      scope: 'conditional_global_unused_funds_and_full_position_entitlement' as const,
      assumption:
        'repeat_joint_supply_debt_auction_changes_with_unchanged_rates_holdings_authority_and_redemption_rules' as const,
      futureProngs: {
        totalSupplyRaw: String(Sf),
        vatArtRaw: String(Af),
        clipDueRaw: String(Df),
        chiRaw: String(future.chi),
        burnRateRaw: String(future.rate),
      },
      scenario: {
        elapsedSeconds: elapsed,
        targetAt,
        targetState: Date.parse(targetAt) > input.asOfMs ? 'future' : 'target_already_elapsed',
        globalUnusedFundsRaw: [String(U0), String(U1)],
        entitlementLowerRaw: [String(E), String(lo)],
        entitlementUpperRaw: [String(E), String(hi)],
        capacityLowerRaw: capacityLower.map(String),
        capacityUpperRaw: capacityUpper.map(String),
        headroomLowerRaw: lower.map(String),
        headroomUpperRaw: upper.map(String),
        lowerTrough: trough(lower),
        upperTrough: trough(upper),
        possibleSampledShortfalls: runs(lower, sourceAt, elapsed),
        definiteSampledShortfalls: runs(upper, sourceAt, elapsed),
      },
      continuousPathKnown: false,
      independentScenarioTrials: false,
      sourceImplementationEquivalence: false,
      withdrawalEligibility: 'conditional_unchanged_unused_funds_and_authority_rules',
      holderExecutableExit: false,
      executableMaximum: false,
      minedPayoutObserved: false,
      forwardProbability: false,
      forecastValidated: false,
      prospectiveValidated: false,
    }
  } catch {
    return null
  }
}
export function selectedStusdsHistoricalHolderCapacityProjection(
  value: unknown,
  expected: StusdsHistoricalHolderCapacityInput,
  acceptCurrentEvidence: AcceptStusdsCurrentEvidence,
) {
  try {
    value = structuredClone(value)
    expected = structuredClone(expected)
    if (
      !record(value) ||
      !record(value.input) ||
      !Number.isSafeInteger(value.input.asOfMs) ||
      (value.input.asOfMs as number) > expected.asOfMs ||
      !buildStusdsHistoricalHolderCapacityProjection(expected, acceptCurrentEvidence)
    )
      return null
    const issued = value.input.asOfMs as number,
      projection = buildStusdsHistoricalHolderCapacityProjection(
        { ...expected, asOfMs: issued, binding: { ...expected.binding, asOfMs: issued } },
        acceptCurrentEvidence,
      )
    if (!projection || !exact(value, projection)) return null
    return {
      projection,
      view: {
        selectedAtUtc: new Date(expected.asOfMs).toISOString(),
        futureScenario:
          Date.parse(projection.scenario.targetAt) > expected.asOfMs
            ? structuredClone(projection.scenario)
            : null,
      },
    }
  } catch {
    return null
  }
}
