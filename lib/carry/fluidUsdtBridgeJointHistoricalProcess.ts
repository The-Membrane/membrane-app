import { buildConditionalTimeProcess } from '../venueForecast/conditionalTimeProcess'

/** Pure conditional math. The caller must independently approve joined receipt evidence;
 * shape checks and a callback that always returns true are not source authentication. */
export const FLUID_JOINT_USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
export const FLUID_JOINT_USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7'
export const FLUID_JOINT_PRONGS = [
  'bridgeFunding',
  'bankCash',
  'bankSupply',
  'bankWithdrawableUntilLimit',
  'bankResolverWithdrawable',
] as const
type Prong = (typeof FLUID_JOINT_PRONGS)[number]
export type FluidJointAnchor = {
  source: { chainId: 1; blockNumber: string; blockHash: string; blockTime: string }
  originalIssue: { issueId: string; issueAtUtc: string; targetAtUtc: string; horizonHours: number }
  availableAtUtc: string
  provenanceRef: string
  runtimeCodeHashes: Record<string, string>
  owner: string
  holderSharesRaw: string
  regime: string
  paused: false
  withdrawalFeeBps: number
  fullHolderNetUsdcRaw: string
  nativeProngs: Record<Prong, string>
  conversion: {
    inputAsset: typeof FLUID_JOINT_USDC
    outputAsset: typeof FLUID_JOINT_USDT
    inputDecimals: 6
    outputDecimals: 6
    fixedFinalUsdtOutputRaw: string
    requiredNetUsdcRaw: string
    method: 'quoteExactOutputSingle'
  }
}
export type FluidJointHistoricalInput = {
  mode: 'dated_captured_projection' | 'current_conditional'
  routeKey: 'USDT → FluidBridgeAggregatorProxy [USDC]'
  destination: '0x273da948aca9261043fbdb2a857bc255ecc29012'
  owner: string
  issueAtUtc: string
  horizonHours: number
  requestedFinalUsdtRaw: string
  originalQuestion: {
    firstLegUsdcRequestedRaw: string
    finalUsdtRequestedRaw: null
    questionBinding: 'unassessed'
    targetSelection: 'research_selected_numeric_reuse_not_conversion'
  }
  history: FluidJointAnchor[]
  baseline: FluidJointAnchor
  maxHistoricalGapSeconds: number
}
export type FluidJointEvidenceApprover = (
  kind: 'history' | 'current',
  input: FluidJointHistoricalInput,
) => boolean
const MAX = (1n << 256n) - 1n
const raw = (v: unknown): v is string =>
  typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) <= MAX
const utc = (v: unknown): v is string =>
  typeof v === 'string' &&
  Number.isSafeInteger(Date.parse(v)) &&
  new Date(Date.parse(v)).toISOString() === v
const hash = (v: unknown) => typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v)
const address = (v: unknown) => typeof v === 'string' && /^0x[0-9a-f]{40}$/.test(v)
const text = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 256
const min = (v: bigint[]) => v.reduce((a, b) => (a < b ? a : b))
function anchor(a: FluidJointAnchor, i: FluidJointHistoricalInput) {
  const c = a?.conversion
  return (
    !!a &&
    a.source?.chainId === 1 &&
    raw(a.source.blockNumber) &&
    a.source.blockNumber !== '0' &&
    hash(a.source.blockHash) &&
    utc(a.source.blockTime) &&
    Date.parse(a.source.blockTime) % 1000 === 0 &&
    utc(a.availableAtUtc) &&
    Date.parse(a.availableAtUtc) >= Date.parse(a.source.blockTime) &&
    Date.parse(a.availableAtUtc) <= Date.parse(i.issueAtUtc) &&
    text(a.provenanceRef) &&
    text(a.originalIssue?.issueId) &&
    utc(a.originalIssue.issueAtUtc) &&
    utc(a.originalIssue.targetAtUtc) &&
    Number.isFinite(a.originalIssue.horizonHours) &&
    a.originalIssue.horizonHours > 0 &&
    Number.isSafeInteger(a.originalIssue.horizonHours * 3600000) &&
    Date.parse(a.originalIssue.issueAtUtc) + a.originalIssue.horizonHours * 3600000 ===
      Date.parse(a.originalIssue.targetAtUtc) &&
    Date.parse(a.source.blockTime) <= Date.parse(a.originalIssue.issueAtUtc) &&
    a.owner === i.owner &&
    raw(a.holderSharesRaw) &&
    a.holderSharesRaw !== '0' &&
    text(a.regime) &&
    a.paused === false &&
    Number.isSafeInteger(a.withdrawalFeeBps) &&
    a.withdrawalFeeBps >= 0 &&
    a.withdrawalFeeBps < 10000 &&
    raw(a.fullHolderNetUsdcRaw) &&
    a.nativeProngs &&
    Object.keys(a.nativeProngs).length === FLUID_JOINT_PRONGS.length &&
    FLUID_JOINT_PRONGS.every((k) => raw(a.nativeProngs[k])) &&
    min(FLUID_JOINT_PRONGS.map((k) => BigInt(a.nativeProngs[k]))) *
      BigInt(10000 - a.withdrawalFeeBps) <=
      MAX &&
    a.runtimeCodeHashes &&
    Object.keys(a.runtimeCodeHashes).length > 0 &&
    Object.keys(a.runtimeCodeHashes).length <= 16 &&
    Object.entries(a.runtimeCodeHashes).every(([k, v]) => address(k) && hash(v)) &&
    c?.inputAsset === FLUID_JOINT_USDC &&
    c.outputAsset === FLUID_JOINT_USDT &&
    c.inputDecimals === 6 &&
    c.outputDecimals === 6 &&
    c.method === 'quoteExactOutputSingle' &&
    c.fixedFinalUsdtOutputRaw === i.requestedFinalUsdtRaw &&
    raw(c.requiredNetUsdcRaw) &&
    c.requiredNetUsdcRaw !== '0'
  )
}
function compatible(a: FluidJointAnchor, b: FluidJointAnchor) {
  return (
    a.owner === b.owner &&
    a.holderSharesRaw === b.holderSharesRaw &&
    a.regime === b.regime &&
    a.withdrawalFeeBps === b.withdrawalFeeBps &&
    Object.keys(a.runtimeCodeHashes).length === Object.keys(b.runtimeCodeHashes).length &&
    Object.entries(a.runtimeCodeHashes).every(([k, v]) => b.runtimeCodeHashes[k] === v)
  )
}
function shortfalls(points: { atUtc: string; headroomNetUsdcRaw: string }[]) {
  const runs: {
    onset: { after: string | null; by: string }
    recovery: { after: string; by: string } | null
    leftCensored: boolean
    rightCensored: boolean
  }[] = []
  let active: (typeof runs)[number] | null = null
  points.forEach((p, index) => {
    if (BigInt(p.headroomNetUsdcRaw) < 0n && !active)
      active = {
        onset: { after: index ? points[index - 1].atUtc : null, by: p.atUtc },
        recovery: null,
        leftCensored: index === 0,
        rightCensored: true,
      }
    if (BigInt(p.headroomNetUsdcRaw) >= 0n && active) {
      active.recovery = { after: points[index - 1].atUtc, by: p.atUtc }
      active.rightCensored = false
      runs.push(active)
      active = null
    }
  })
  if (active) runs.push(active)
  return runs
}
export function buildFluidUsdtBridgeJointHistoricalProcess(
  supplied: FluidJointHistoricalInput,
  approve: FluidJointEvidenceApprover,
) {
  try {
    const i = structuredClone(supplied)
    if (
      !i ||
      !['dated_captured_projection', 'current_conditional'].includes(i.mode) ||
      i.routeKey !== 'USDT → FluidBridgeAggregatorProxy [USDC]' ||
      i.destination !== '0x273da948aca9261043fbdb2a857bc255ecc29012' ||
      !address(i.owner) ||
      !utc(i.issueAtUtc) ||
      !raw(i.requestedFinalUsdtRaw) ||
      i.requestedFinalUsdtRaw === '0' ||
      !Number.isFinite(i.horizonHours) ||
      i.horizonHours <= 0 ||
      i.horizonHours > 8760 ||
      !Number.isSafeInteger(i.horizonHours * 3600000) ||
      !Number.isSafeInteger(i.maxHistoricalGapSeconds) ||
      i.maxHistoricalGapSeconds <= 0 ||
      !Number.isSafeInteger(i.maxHistoricalGapSeconds * 1000) ||
      !raw(i.originalQuestion?.firstLegUsdcRequestedRaw) ||
      i.requestedFinalUsdtRaw !== i.originalQuestion.firstLegUsdcRequestedRaw ||
      i.originalQuestion.finalUsdtRequestedRaw !== null ||
      i.originalQuestion.questionBinding !== 'unassessed' ||
      i.originalQuestion.targetSelection !== 'research_selected_numeric_reuse_not_conversion' ||
      !Array.isArray(i.history) ||
      i.history.length < 2 ||
      i.history.length > 129 ||
      !anchor(i.baseline, i) ||
      i.history.some(
        (a, n) =>
          !anchor(a, i) ||
          !compatible(a, i.baseline) ||
          (n > 0 &&
            Date.parse(a.source.blockTime) <= Date.parse(i.history[n - 1].source.blockTime)),
      )
    )
      return null
    const issue = Date.parse(i.issueAtUtc),
      source = Date.parse(i.baseline.source.blockTime),
      target = issue + i.horizonHours * 3600000
    if (
      source > issue ||
      !Number.isSafeInteger(target) ||
      target > 8640000000000000 ||
      (i.mode === 'current_conditional' && issue - source > 1800000) ||
      approve('history', structuredClone(i)) !== true ||
      (i.mode === 'current_conditional' && approve('current', structuredClone(i)) !== true)
    )
      return null
    const measure = (state: Record<Prong, string>, baseline = i.baseline) => {
      const gross = min(FLUID_JOINT_PRONGS.map((k) => BigInt(state[k])))
      // Pinned LiteVault maxWithdraw / previewRedeem use ceil fee, hence floor net.
      // Reject the pinned unchecked uint256 multiplication's overflow domain.
      const feeAdjustedProduct = gross * BigInt(10000 - baseline.withdrawalFeeBps)
      if (feeAdjustedProduct > MAX) throw Error('native_intermediate_overflow')
      const net = feeAdjustedProduct / 10000n
      const E = BigInt(baseline.fullHolderNetUsdcRaw),
        capacity = min([net, E])
      return {
        availableNetUsdcRaw: String(net),
        holderClippedNetUsdcRaw: String(capacity),
        headroomNetUsdcRaw: String(capacity - BigInt(baseline.conversion.requiredNetUsdcRaw)),
        bindingProngs: FLUID_JOINT_PRONGS.filter((k) => BigInt(state[k]) === gross),
        holderBinding: E <= net,
      }
    }
    const excludedIntervals: { fromIndex: number; reason: string }[] = []
    const intervals = i.history.slice(0, -1).flatMap((a, n) => {
      const b = i.history[n + 1],
        dt = Date.parse(b.source.blockTime) - Date.parse(a.source.blockTime)
      if (
        dt > i.maxHistoricalGapSeconds * 1000 ||
        Date.parse(b.source.blockTime) > source ||
        (i.mode === 'current_conditional' && Date.parse(b.source.blockTime) === source)
      ) {
        excludedIntervals.push({
          fromIndex: n,
          reason: dt > i.maxHistoricalGapSeconds * 1000 ? 'historical_gap' : 'not_before_baseline',
        })
        return []
      }
      const jointNetDeltaRaw = Object.fromEntries(
        FLUID_JOINT_PRONGS.map((k) => [
          k,
          String(BigInt(b.nativeProngs[k]) - BigInt(a.nativeProngs[k])),
        ]),
      )
      return [
        {
          donor: {
            sources: [a.source, b.source],
            provenanceRefs: [a.provenanceRef, b.provenanceRef],
            durationSeconds: dt / 1000,
            jointNetDeltaRaw,
          },
          ratesByProng: Object.fromEntries(
            FLUID_JOINT_PRONGS.map((k) => [
              k,
              { numeratorRaw: jointNetDeltaRaw[k], denominatorMs: String(dt) },
            ]),
          ),
        },
      ]
    })
    if (!intervals.length) return null
    const channels = FLUID_JOINT_PRONGS.map((key) => ({
      key,
      assetAddress: FLUID_JOINT_USDC,
      decimals: 6,
      unit: 'gross_native_USDC',
      negativeHandling: 'clamp_zero' as const,
    }))
    const prospectiveProcess =
      i.mode === 'current_conditional'
        ? buildConditionalTimeProcess(
            {
              channels,
              observations: i.history.map((a) => ({
                sourceAtUtc: a.source.blockTime,
                availableAtUtc: a.availableAtUtc,
                regime: a.regime,
                channels,
                valuesByChannel: a.nativeProngs,
                provenanceRef: a.provenanceRef,
              })),
              outputAsset: { assetAddress: FLUID_JOINT_USDC, decimals: 6 },
              measurementRule: 'joint_gross_min_ceil_fee_then_net_full_holder_clip',
              current: {
                sourceAtUtc: i.baseline.source.blockTime,
                readAtUtc: i.baseline.availableAtUtc,
                regime: i.baseline.regime,
                valuesByChannel: i.baseline.nativeProngs,
                provenanceRef: i.baseline.provenanceRef,
              },
              issueAtUtc: i.issueAtUtc,
              requestedRaw: i.baseline.conversion.requiredNetUsdcRaw,
              horizonHours: i.horizonHours,
              maxHistoricalGapSeconds: i.maxHistoricalGapSeconds,
            },
            () => true,
            (state) => ({
              availableRaw: measure(state as Record<Prong, string>).availableNetUsdcRaw,
              entitlementRaw: i.baseline.fullHolderNetUsdcRaw,
            }),
          )
        : null
    if (i.mode === 'current_conditional' && !prospectiveProcess) return null
    const historicalAnchors = i.history.map((a) => ({
      source: a.source,
      originalIssue: a.originalIssue,
      availableAtUtc: a.availableAtUtc,
      provenanceRef: a.provenanceRef,
      ...measure(a.nativeProngs, a),
      requiredNetUsdcRaw: a.conversion.requiredNetUsdcRaw,
    }))
    return {
      status: 'conditional_fixed_final_usdt_joint_native_process' as const,
      input: i,
      sourceAtUtc: i.baseline.source.blockTime,
      issueAtUtc: i.issueAtUtc,
      targetAtUtc: new Date(target).toISOString(),
      sourceProofValidUntil:
        i.mode === 'current_conditional' ? new Date(source + 1800000).toISOString() : null,
      originalQuestion: i.originalQuestion,
      fixedFinalUsdtOutputRaw: i.requestedFinalUsdtRaw,
      requiredNetUsdcRaw: i.baseline.conversion.requiredNetUsdcRaw,
      nativeAsset: FLUID_JOINT_USDC,
      nativeDecimals: 6 as const,
      historicalAnchors,
      intervals,
      prospectiveProcess,
      conditionalRequestedBucketCoverage: prospectiveProcess
        ? prospectiveProcess.scenarios.map((s) => ({
            fixedFinalUsdtOutputRaw: i.requestedFinalUsdtRaw,
            targetCovered: s.targetHeadroomRaw === null ? null : BigInt(s.targetHeadroomRaw) >= 0n,
            sampled: s.points.map((p) => ({
              atUtc: p.atUtc,
              covered: BigInt(p.headroomRaw) >= 0n,
            })),
          }))
        : null,
      unrestrictedFinalUsdtCapacityRaw: null,
      fullHolderEntitlementUsdtRaw: null,
      descriptiveHistoricalOnly: i.mode === 'dated_captured_projection',
      originalProspectiveForecast: false as const,
      sampledHistoricalShortfalls: shortfalls(
        historicalAnchors.map((a) => ({
          atUtc: a.source.blockTime,
          headroomNetUsdcRaw: a.headroomNetUsdcRaw,
        })),
      ),
      excludedIntervals,
      thinHistoricalEvidence: intervals.length === 1,
      assumptions: {
        historicalNetFlowsHeldConstant: true,
        sourceAgeIncluded: true,
        conversionHeldAtBaselineForExactQOnly: true,
        futureConversionRangeKnown: false,
        holderEntitlementHeldConstant: true,
        feeAppliedOnceToGrossNativeProngs: true,
        holderEntitlementAlreadyNet: true,
        holderSharesRegimeRuntimeAndEligibilityHeldConstant: true,
        prongChangesAreNetNotGrossCompetition: true,
      },
      holderExecutableExit: false as const,
      minedPayout: false as const,
      calibratedProbability: false as const,
      continuousPathKnown: false as const,
      forecastValidated: false as const,
      sourceImplementationEquivalence: false as const,
    }
  } catch {
    return null
  }
}

/** Current displays rebuild against externally approved evidence and expire on both clocks. */
export function selectedFluidUsdtBridgeJointHistoricalProcess(
  value: unknown,
  expected: { input: FluidJointHistoricalInput; asOfMs: number },
  approve: FluidJointEvidenceApprover,
) {
  try {
    const e = structuredClone(expected)
    if (
      e.input.mode !== 'current_conditional' ||
      !Number.isSafeInteger(e.asOfMs) ||
      !utc(e.input.issueAtUtc) ||
      !utc(e.input.baseline.source.blockTime) ||
      e.asOfMs < Date.parse(e.input.issueAtUtc) ||
      e.asOfMs - Date.parse(e.input.baseline.source.blockTime) > 1800000 ||
      e.asOfMs >= Date.parse(e.input.issueAtUtc) + e.input.horizonHours * 3600000
    )
      return null
    const rebuilt = buildFluidUsdtBridgeJointHistoricalProcess(e.input, approve)
    return rebuilt && JSON.stringify(value) === JSON.stringify(rebuilt) ? rebuilt : null
  } catch {
    return null
  }
}
