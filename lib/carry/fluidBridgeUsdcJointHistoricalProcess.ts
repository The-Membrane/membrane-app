/** Pure conditional math. The approval callback is an integration gate, never source authentication. */
export const FLUID_BRIDGE_USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
export const FLUID_BRIDGE_USDC_PRONGS = [
  'bridgeFunding',
  'bankCash',
  'bankSupply',
  'bankWithdrawableUntilLimit',
  'bankResolverWithdrawable',
] as const
type Prong = (typeof FLUID_BRIDGE_USDC_PRONGS)[number]
export type FluidBridgeUsdcOriginalIssue = {
  issueId: string
  routeKey: 'USDC → FluidBridgeAggregatorProxy [USDC]' | 'USDT → FluidBridgeAggregatorProxy [USDC]'
  issueAtUtc: string
  targetAtUtc: string
  horizonHours: number
  requestedRaw: string
  assetUnit: 'USDC' | 'USDC_first_leg_assets'
  finalUsdtRequestedRaw: string | null
}
type FluidBridgeUsdcFrameFacts = {
  source: { chainId: 1; blockNumber: string; blockHash: string; blockTime: string }
  availableAtUtc: string
  /** Actual evidence acquisition clock; never backdate this to the replay header. */
  acquiredAtUtc: string
  provenanceRef: string
  holderSharesRaw: string
  shareDecimals: number
  asset: typeof FLUID_BRIDGE_USDC
  assetDecimals: 6
  fundingUnit: 'gross_native_USDC'
  entitlementUnit: 'net_native_USDC'
  runtimeCodeHashes: Record<string, string>
  regime: string
  paused: false
  withdrawalFeeBps: number
  fullHolderNetUsdcRaw: string
  nativeProngs: Record<Prong, string>
}
/** Original transport identity stays intact; hypothetical S never asserts historical ownership. */
export type FluidBridgeUsdcFrame = FluidBridgeUsdcFrameFacts &
  (
    | {
        provenanceKind: 'original_issue_bound'
        originalIssue: FluidBridgeUsdcOriginalIssue
        owner: string
        historicalOwnership: true
      }
    | {
        provenanceKind: 'native_hypothetical_shares'
        originalIssue?: never
        owner: null
        historicalOwnership: false
      }
  )
type FluidBridgeUsdcJointFacts = {
  routeKey: 'USDC → FluidBridgeAggregatorProxy [USDC]'
  destination: '0x273da948aca9261043fbdb2a857bc255ecc29012'
  issueAtUtc: string
  knowledgeCutoffUtc: string
  horizonHours: number
  requestedRaw: string
  history: FluidBridgeUsdcFrame[]
  baseline: FluidBridgeUsdcFrame
  maxHistoricalGapSeconds: number
}
export type FluidBridgeUsdcJointInput = FluidBridgeUsdcJointFacts &
  (
    | {
        mode: 'dated_captured_projection' | 'current_conditional'
        owner: string
        retrospectiveAvailabilityAssumption?: never
      }
    | {
        mode: 'retrospective_replay'
        owner: string | null
        retrospectiveAvailabilityAssumption: 'historical_chain_state_reconstructed_later'
      }
  )
export type FluidBridgeUsdcEvidenceApprover = (
  kind: 'history' | 'current',
  input: FluidBridgeUsdcJointInput,
) => boolean
const MAX = (1n << 256n) - 1n
const route = 'USDC → FluidBridgeAggregatorProxy [USDC]'
const raw = (v: unknown): v is string =>
  typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) <= MAX
const utc = (v: unknown): v is string =>
  typeof v === 'string' &&
  Number.isSafeInteger(Date.parse(v)) &&
  new Date(Date.parse(v)).toISOString() === v
const address = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-f]{40}$/.test(v)
const holder = (v: unknown): v is string => address(v) && v !== '0x' + '0'.repeat(40)
const hash = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v)
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const dense = (v: unknown, max: number): v is unknown[] =>
  Array.isArray(v) &&
  v.length <= max &&
  Object.keys(v).length === v.length &&
  Array.from({ length: v.length }, (_, n) => Object.hasOwn(v, n)).every(Boolean)
function same(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b))
    return (
      dense(a, 129) && dense(b, 129) && a.length === b.length && a.every((v, n) => same(v, b[n]))
    )
  if (object(a) || object(b))
    return (
      object(a) &&
      object(b) &&
      Object.keys(a).length === Object.keys(b).length &&
      Object.keys(a).every((k) => Object.hasOwn(b, k) && same(a[k], b[k]))
    )
  return Object.is(a, b)
}
function validOriginalIssue(
  o: FluidBridgeUsdcOriginalIssue | undefined,
  f: FluidBridgeUsdcFrame,
  cutoff: string,
) {
  return (
    !!o &&
    text(o.issueId) &&
    [route, 'USDT → FluidBridgeAggregatorProxy [USDC]'].includes(o.routeKey) &&
    utc(o.issueAtUtc) &&
    Date.parse(o.issueAtUtc) <= Date.parse(cutoff) &&
    utc(o.targetAtUtc) &&
    Date.parse(f.source.blockTime) <= Date.parse(o.issueAtUtc) &&
    Number.isFinite(o.horizonHours) &&
    o.horizonHours > 0 &&
    Number.isSafeInteger(o.horizonHours * 3600000) &&
    Date.parse(o.issueAtUtc) + o.horizonHours * 3600000 === Date.parse(o.targetAtUtc) &&
    raw(o.requestedRaw) &&
    o.requestedRaw !== '0' &&
    (o.routeKey === route
      ? o.assetUnit === 'USDC' && o.finalUsdtRequestedRaw === null
      : o.assetUnit === 'USDC_first_leg_assets' &&
        (o.finalUsdtRequestedRaw === null || raw(o.finalUsdtRequestedRaw)))
  )
}
function validFrame(f: FluidBridgeUsdcFrame, i: FluidBridgeUsdcJointInput) {
  if (
    !f ||
    !f.source ||
    !utc(f.source.blockTime) ||
    !utc(f.availableAtUtc) ||
    !utc(f.acquiredAtUtc)
  )
    return false
  const retrospective = i.mode === 'retrospective_replay'
  const acquired = Date.parse(f.acquiredAtUtc),
    available = Date.parse(f.availableAtUtc)
  if (
    available < Date.parse(f.source.blockTime) ||
    acquired < available ||
    acquired > Date.parse(i.issueAtUtc) ||
    (!retrospective &&
      (acquired > Date.parse(i.knowledgeCutoffUtc) || available > Date.parse(i.knowledgeCutoffUtc)))
  )
    return false
  const provenance =
    f.provenanceKind === 'original_issue_bound'
      ? holder(f.owner) &&
        f.historicalOwnership === true &&
        validOriginalIssue(f.originalIssue, f, retrospective ? i.issueAtUtc : i.knowledgeCutoffUtc)
      : f.provenanceKind === 'native_hypothetical_shares' &&
        retrospective &&
        f.owner === null &&
        f.historicalOwnership === false &&
        !Object.hasOwn(f, 'originalIssue') &&
        available === acquired
  return (
    provenance &&
    f.source.chainId === 1 &&
    raw(f.source.blockNumber) &&
    f.source.blockNumber !== '0' &&
    hash(f.source.blockHash) &&
    Date.parse(f.source.blockTime) % 1000 === 0 &&
    text(f.provenanceRef) &&
    raw(f.holderSharesRaw) &&
    f.holderSharesRaw !== '0' &&
    Number.isInteger(f.shareDecimals) &&
    f.shareDecimals >= 0 &&
    f.shareDecimals <= 36 &&
    f.asset === FLUID_BRIDGE_USDC &&
    f.assetDecimals === 6 &&
    f.fundingUnit === 'gross_native_USDC' &&
    f.entitlementUnit === 'net_native_USDC' &&
    text(f.regime) &&
    f.paused === false &&
    Number.isInteger(f.withdrawalFeeBps) &&
    f.withdrawalFeeBps >= 0 &&
    f.withdrawalFeeBps < 10000 &&
    raw(f.fullHolderNetUsdcRaw) &&
    object(f.nativeProngs) &&
    Object.keys(f.nativeProngs).length === 5 &&
    FLUID_BRIDGE_USDC_PRONGS.every(
      (k) => Object.hasOwn(f.nativeProngs, k) && raw(f.nativeProngs[k]),
    ) &&
    object(f.runtimeCodeHashes) &&
    Object.keys(f.runtimeCodeHashes).length > 0 &&
    Object.keys(f.runtimeCodeHashes).length <= 16 &&
    Object.entries(f.runtimeCodeHashes).every(([k, v]) => address(k) && hash(v))
  )
}
function compatible(a: FluidBridgeUsdcFrame, b: FluidBridgeUsdcFrame, hypotheticalReplay: boolean) {
  return (
    (hypotheticalReplay || a.owner === b.owner) &&
    a.holderSharesRaw === b.holderSharesRaw &&
    a.shareDecimals === b.shareDecimals &&
    a.asset === b.asset &&
    a.assetDecimals === b.assetDecimals &&
    a.regime === b.regime &&
    a.withdrawalFeeBps === b.withdrawalFeeBps &&
    same(a.runtimeCodeHashes, b.runtimeCodeHashes)
  )
}
function measure(funding: Record<Prong, string>, ea: string, fee: number, q: string) {
  const gross = FLUID_BRIDGE_USDC_PRONGS.reduce(
    (m, k) => (BigInt(funding[k]) < m ? BigInt(funding[k]) : m),
    MAX,
  )
  const product = gross * BigInt(10000 - fee)
  if (product > MAX) throw Error('native_intermediate_overflow')
  const net = product / 10000n
  const available = net < BigInt(ea) ? net : BigInt(ea)
  return {
    grossMinimumRaw: String(gross),
    fundingNetRaw: String(net),
    fullEaRaw: ea,
    availableRaw: String(available),
    headroomRaw: String(available - BigInt(q)),
    bindingProngs: FLUID_BRIDGE_USDC_PRONGS.filter((k) => BigInt(funding[k]) === gross),
  }
}
type Point = { atUtc: string; measurement: ReturnType<typeof measure> }
function lossRuns(points: Point[]) {
  const runs: {
    after: string | null
    by: string
    recoveredAfter: string | null
    recoveredBy: string | null
    leftCensored: boolean
    rightCensored: boolean
  }[] = []
  let active: (typeof runs)[number] | null = null
  points.forEach((p, n) => {
    if (BigInt(p.measurement.headroomRaw) < 0n && !active)
      active = {
        after: n ? points[n - 1].atUtc : null,
        by: p.atUtc,
        recoveredAfter: null,
        recoveredBy: null,
        leftCensored: n === 0,
        rightCensored: true,
      }
    else if (BigInt(p.measurement.headroomRaw) >= 0n && active) {
      active.recoveredAfter = points[n - 1].atUtc
      active.recoveredBy = p.atUtc
      active.rightCensored = false
      runs.push(active)
      active = null
    }
  })
  if (active) runs.push(active)
  return runs
}
/** Canonical frames must be independently replayed and approved by the caller. */
export function buildFluidBridgeUsdcJointHistoricalProcess(
  supplied: FluidBridgeUsdcJointInput,
  approve: FluidBridgeUsdcEvidenceApprover,
) {
  try {
    if (!dense(supplied?.history, 129) || supplied.history.length < 2) return null
    const i = structuredClone(supplied)
    const retrospective = i.mode === 'retrospective_replay'
    const hypotheticalReplay =
      retrospective &&
      [...i.history, i.baseline].some((f) => f?.provenanceKind === 'native_hypothetical_shares')
    if (
      !['dated_captured_projection', 'current_conditional', 'retrospective_replay'].includes(
        i.mode,
      ) ||
      i.routeKey !== route ||
      i.destination !== '0x273da948aca9261043fbdb2a857bc255ecc29012' ||
      !(retrospective ? i.owner === null || holder(i.owner) : holder(i.owner)) ||
      (retrospective
        ? i.retrospectiveAvailabilityAssumption !== 'historical_chain_state_reconstructed_later'
        : Object.hasOwn(i, 'retrospectiveAvailabilityAssumption')) ||
      !utc(i.issueAtUtc) ||
      !utc(i.knowledgeCutoffUtc) ||
      Date.parse(i.knowledgeCutoffUtc) > Date.parse(i.issueAtUtc) ||
      !raw(i.requestedRaw) ||
      i.requestedRaw === '0' ||
      !Number.isFinite(i.horizonHours) ||
      i.horizonHours <= 0 ||
      i.horizonHours > 8760 ||
      !Number.isSafeInteger(i.horizonHours * 3600000) ||
      !Number.isSafeInteger(i.maxHistoricalGapSeconds) ||
      i.maxHistoricalGapSeconds <= 0 ||
      !Number.isSafeInteger(i.maxHistoricalGapSeconds * 1000) ||
      !validFrame(i.baseline, i) ||
      i.baseline.owner !== i.owner ||
      i.history.some(
        (f, n) =>
          !validFrame(f, i) ||
          (n > 0 &&
            (Date.parse(f.source.blockTime) <= Date.parse(i.history[n - 1].source.blockTime) ||
              BigInt(f.source.blockNumber) <= BigInt(i.history[n - 1].source.blockNumber))),
      )
    )
      return null
    const source = Date.parse(i.baseline.source.blockTime),
      issue = Date.parse(i.issueAtUtc),
      target = source + i.horizonHours * 3600000
    if (
      source > issue ||
      (!retrospective && target <= issue) ||
      (retrospective && i.knowledgeCutoffUtc !== i.baseline.source.blockTime) ||
      !Number.isSafeInteger(target) ||
      target > 8640000000000000 ||
      (i.mode === 'current_conditional' && issue - source > 1800000) ||
      approve('history', structuredClone(i)) !== true ||
      (i.mode === 'current_conditional' && approve('current', structuredClone(i)) !== true)
    )
      return null
    const excludedIntervals: { fromIndex: number; reason: string }[] = []
    const scenarios: {
      fromIndex: number
      status: 'usable' | 'censored'
      donorSources: FluidBridgeUsdcFrame['source'][]
      jointNetDeltaRaw: Record<string, string>
      points: Point[]
      targetMeasurement: ReturnType<typeof measure> | null
      maximumCheckpointGapMs: number
      sampledLossRuns: ReturnType<typeof lossRuns>
      reason: string | null
    }[] = []
    for (let n = 0; n < i.history.length - 1; n++) {
      const a = i.history[n],
        b = i.history[n + 1],
        dt = Date.parse(b.source.blockTime) - Date.parse(a.source.blockTime)
      const reason =
        !compatible(a, b, hypotheticalReplay) || !compatible(a, i.baseline, hypotheticalReplay)
          ? 'holder_or_regime_mismatch'
          : dt > i.maxHistoricalGapSeconds * 1000
            ? 'historical_gap'
            : Date.parse(b.source.blockTime) > source ||
                (i.mode !== 'dated_captured_projection' &&
                  Date.parse(b.source.blockTime) === source)
              ? 'not_strictly_before_source'
              : null
      if (reason) {
        excludedIntervals.push({ fromIndex: n, reason })
        continue
      }
      const keys = [...FLUID_BRIDGE_USDC_PRONGS, 'fullEa']
      const values = (f: FluidBridgeUsdcFrame): Record<string, string> => ({
        ...f.nativeProngs,
        fullEa: f.fullHolderNetUsdcRaw,
      })
      const av = values(a),
        bv = values(b),
        cv = values(i.baseline)
      const deltas = Object.fromEntries(keys.map((k) => [k, BigInt(bv[k]) - BigInt(av[k])]))
      const points: Point[] = []
      let censored: string | null = null
      const span = target - source,
        count = Math.min(64, Math.max(1, Math.ceil(span / dt)))
      for (let p = 0; p <= count; p++) {
        const elapsed = Math.floor((span * p) / count)
        try {
          const state = Object.fromEntries(
            keys.map((k) => {
              const product = deltas[k] * BigInt(elapsed)
              if (product < -MAX || product > MAX) throw Error('native_intermediate_overflow')
              const divisor = BigInt(dt),
                delta = product / divisor - (product < 0n && product % divisor !== 0n ? 1n : 0n)
              const v = BigInt(cv[k]) + delta
              if (v > MAX) throw Error('native_stock_overflow')
              return [k, String(v < 0n ? 0n : v)]
            }),
          )
          points.push({
            atUtc: new Date(source + elapsed).toISOString(),
            measurement: measure(
              state as Record<Prong, string>,
              state.fullEa,
              i.baseline.withdrawalFeeBps,
              i.requestedRaw,
            ),
          })
        } catch {
          censored = 'native_arithmetic_domain'
          break
        }
      }
      scenarios.push({
        fromIndex: n,
        status: censored ? 'censored' : 'usable',
        donorSources: [a.source, b.source],
        jointNetDeltaRaw: Object.fromEntries(keys.map((k) => [k, String(deltas[k])])),
        points,
        targetMeasurement: censored ? null : points[points.length - 1].measurement,
        maximumCheckpointGapMs: points.reduce(
          (m, p, j) => (j ? Math.max(m, Date.parse(p.atUtc) - Date.parse(points[j - 1].atUtc)) : m),
          0,
        ),
        sampledLossRuns: lossRuns(points),
        reason: censored,
      })
    }
    const usable = scenarios.filter((s) => s.status === 'usable'),
      censored = scenarios.length - usable.length
    const complete = usable.length > 0 && censored === 0 && excludedIntervals.length === 0
    const headrooms = usable.map((s) => BigInt(s.targetMeasurement!.headroomRaw))
    const total = headrooms.reduce((a, b) => a + b, 0n),
      denominator = BigInt(headrooms.length || 1)
    const expected = complete
      ? {
          numeratorRaw: String(total),
          denominator: String(denominator),
          floorRaw: String(
            total / denominator - (total < 0n && total % denominator !== 0n ? 1n : 0n),
          ),
        }
      : null
    return {
      status: 'conditional_usdc_bridge_joint_native_process' as const,
      input: i,
      sourceAtUtc: i.baseline.source.blockTime,
      issueAtUtc: i.issueAtUtc,
      targetAtUtc: new Date(target).toISOString(),
      sourceProofValidUntil:
        i.mode === 'current_conditional' ? new Date(source + 1800000).toISOString() : null,
      sharesRaw: i.baseline.holderSharesRaw,
      fullEaRaw: i.baseline.fullHolderNetUsdcRaw,
      requestedRaw: i.requestedRaw,
      MRaw: null,
      scenarios,
      excludedIntervals,
      counts: {
        attempted: i.history.length - 1,
        usable: usable.length,
        censored,
        excluded: excludedIntervals.length,
      },
      descriptiveExpectedFlow: expected,
      descriptiveStressedRange: complete
        ? {
            minRaw: String(headrooms.reduce((a, b) => (a < b ? a : b))),
            maxRaw: String(headrooms.reduce((a, b) => (a > b ? a : b))),
          }
        : null,
      thinHistoricalEvidence: usable.length === 1,
      betweenSamplesKnown: false,
      empiricalRecoveryDurationDistribution: null,
      holderExecutableExit: false,
      minedPayout: false,
      calibratedProbability: false,
      forecastValidated: false,
      originalProspectiveForecast: false,
      retrospectiveReconstruction: retrospective,
      ownershipProvenance: hypotheticalReplay
        ? ('hypothetical_shares' as const)
        : ('declared_original_issue_bound' as const),
      ownershipKnown: false,
      historicalOwnership: false,
      assumptions: {
        historicalChainStateReconstructedLater: retrospective,
        simultaneousSignedNetFlows: true,
        fullEaProjectedAsOwnChannel: true,
        feeAppliedOnceToGrossFundingOnly: true,
        entitlementAlreadyNet: true,
        requestedQSubtractedOnce: true,
        reserveFractionInferred: false,
      },
    }
  } catch {
    return null
  }
}
