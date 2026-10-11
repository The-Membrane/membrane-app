/** Pure, unsigned retrospective research. Never issues private forecasts or proves execution. */
import {
  buildUsd3JointHistoricalProcess,
  usd3HistoricalRuntimeFingerprint,
  type Usd3JointHistoricalPoint,
} from '../carry/usd3JointHistoricalProcess'
import {
  buildFluidBridgeUsdcJointHistoricalProcess,
  FLUID_BRIDGE_USDC_PRONGS,
  type FluidBridgeUsdcFrame,
} from '../carry/fluidBridgeUsdcJointHistoricalProcess'
import {
  projectApyUsdNet,
  validApyUsdFeeCurve,
  type ApyUsdFeeCurve,
} from '../carry/apyUsdFeeOutlook'
import type { ApyUsdJointNativeHistoryReplay } from '../carry/apyUsdJointNativeEvidence'
import type { UmbrellaGhoJointNativeHistoryPoint } from '../carry/umbrellaGhoJointNativeHistory'
import { ORIGINAL_GHO } from '../carry/umbrellaGhoExit'

const MAX = (1n << 256n) - 1n
const MAX208 = (1n << 208n) - 1n
const WAD = 10n ** 18n
export const RESEARCH_ONLY = Object.freeze({
  originalPrivateIssuanceAuthority: false,
  authenticationAuthority: false,
  historicalOwnership: false,
  calibratedProbability: false,
  prospectiveValidation: false,
  executionAuthority: false,
  sourceImplementationEquivalence: false,
  minedDeliveryProvenByGetter: false,
  independentSamples: false,
  MRaw: null,
})
function check(value: unknown, reason: string): asserts value {
  if (!value) throw Error('native_holder_holdout_' + reason)
}
export function nativeRaw(value: unknown): bigint {
  check(typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value), 'raw')
  const n = BigInt(value)
  check(n <= MAX, 'raw_overflow')
  return n
}
export function researchClock(value: unknown): number {
  check(typeof value === 'string' && value.length <= 32, 'clock')
  const n = Date.parse(value)
  check(Number.isSafeInteger(n) && n >= 0 && new Date(n).toISOString() === value, 'clock')
  return n
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const min = (...values: bigint[]) => values.reduce((a, b) => (a < b ? a : b))
const abs = (n: bigint) => (n < 0n ? -n : n)
const floor = (a: bigint, b: bigint) => a / b - (a < 0n && a % b ? 1n : 0n)
const quantile = (xs: bigint[], p: number) => xs[Math.floor(((xs.length - 1) * p) / 100)]
/** Exact native endpoint alignment. This is a hypothetical research origin, not historical live availability. */
export function nativeProjectionElapsedMs(
  sourceAtUtc: string,
  issueAtUtc: string,
  horizonHours: number,
  targetAtUtc: string,
): number | null {
  const source = researchClock(sourceAtUtc),
    issue = researchClock(issueAtUtc),
    target = researchClock(targetAtUtc)
  check(
    issue >= source &&
      Number.isFinite(horizonHours) &&
      horizonHours > 0 &&
      horizonHours <= 720 &&
      Number.isSafeInteger(horizonHours * 3600000),
    'projection_clock',
  )
  return target === issue + horizonHours * 3600000 ? target - source : null
}
export function projectNativeNetStock(input: {
  sourceAtUtc: string
  issueAtUtc: string
  horizonHours: number
  targetAtUtc: string
  sourceRaw: string
  donorStartAtUtc: string
  donorEndAtUtc: string
  donorStartRaw: string
  donorEndRaw: string
}): bigint | null {
  const elapsed = nativeProjectionElapsedMs(
      input.sourceAtUtc,
      input.issueAtUtc,
      input.horizonHours,
      input.targetAtUtc,
    ),
    start = researchClock(input.donorStartAtUtc),
    end = researchClock(input.donorEndAtUtc)
  check(start < end && end < researchClock(input.sourceAtUtc), 'donor_after_source_cutoff')
  if (elapsed === null) return null
  return (
    nativeRaw(input.sourceRaw) +
    floor(
      (nativeRaw(input.donorEndRaw) - nativeRaw(input.donorStartRaw)) * BigInt(elapsed),
      BigInt(end - start),
    )
  )
}
export type CapacityScenario = {
  status: 'usable' | 'censored' | 'excluded'
  availableRaw: string | null
  reason: string | null
}
/** One amount comparison per fold. Q cases share this fold and never multiply amount-error denominators. */
export function scoreCapacityPrediction(input: {
  sourceAtUtc: string
  targetAtUtc: string
  requestedRaw: readonly string[]
  baselineRaw: string | null
  actualRaw: string | null
  scenarios: readonly CapacityScenario[]
  targetCensorReason?: string | null
  issueAtUtc?: string
  horizonHours?: number
}) {
  const source = researchClock(input.sourceAtUtc),
    target = researchClock(input.targetAtUtc),
    issue = researchClock(input.issueAtUtc ?? input.sourceAtUtc),
    horizon = input.horizonHours ?? (target - issue) / 3600000,
    aligned =
      nativeProjectionElapsedMs(
        input.sourceAtUtc,
        input.issueAtUtc ?? input.sourceAtUtc,
        horizon,
        input.targetAtUtc,
      ) !== null,
    targetReason =
      input.targetCensorReason ??
      (aligned ? null : 'missing_exact_issue_plus_horizon_native_endpoint')
  check(target > source && (target - source) % 1000 === 0, 'target_clock')
  check(
    input.requestedRaw.length <= 8 &&
      new Set(input.requestedRaw).size === input.requestedRaw.length,
    'Q_cases',
  )
  input.requestedRaw.forEach((q) => check(nativeRaw(q) > 0n, 'Q_zero'))
  check(input.scenarios.length > 0 && input.scenarios.length <= 128, 'scenario_count')
  const baseline = input.baselineRaw === null ? null : nativeRaw(input.baselineRaw)
  const actual = input.actualRaw === null || !aligned ? null : nativeRaw(input.actualRaw)
  input.scenarios.forEach((s) => {
    check(['usable', 'censored', 'excluded'].includes(s.status), 'scenario_status')
    check((s.status === 'usable') === (s.availableRaw !== null), 'scenario_measurement')
    if (s.availableRaw !== null) nativeRaw(s.availableRaw)
    check(
      s.status === 'usable'
        ? s.reason === null
        : typeof s.reason === 'string' && s.reason.length > 0,
      'scenario_reason',
    )
  })
  const xs = input.scenarios
    .flatMap((s) => (s.availableRaw === null ? [] : [nativeRaw(s.availableRaw)]))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const complete =
    !targetReason && actual !== null && baseline !== null && xs.length === input.scenarios.length
  const total = xs.reduce((a, b) => a + b, 0n)
  const mean = complete ? total / BigInt(xs.length) : null
  const band = complete
    ? {
        minRaw: String(xs[0]),
        p10Raw: String(quantile(xs, 10)),
        medianRaw: String(quantile(xs, 50)),
        p90Raw: String(quantile(xs, 90)),
        maxRaw: String(xs.at(-1)!),
      }
    : null
  const amountScore =
    mean !== null && actual !== null
      ? {
          predictedMeanRaw: String(mean),
          predictedMeanExact: { numeratorRaw: String(total), denominator: xs.length },
          signedErrorRaw: String(mean - actual),
          absoluteErrorRaw: String(abs(mean - actual)),
          persistenceSignedErrorRaw: String(baseline! - actual),
          persistenceAbsoluteErrorRaw: String(abs(baseline! - actual)),
          empiricalBandContainsActual:
            actual >= BigInt(band!.p10Raw) && actual <= BigInt(band!.p90Raw),
        }
      : null
  return {
    ...RESEARCH_ONLY,
    sourceAtUtc: input.sourceAtUtc,
    targetAtUtc: input.targetAtUtc,
    elapsedSeconds: (target - source) / 1000,
    sourceAgeSeconds: (issue - source) / 1000,
    hypotheticalIssueAtUtc: new Date(issue).toISOString(),
    horizonHours: horizon,
    hypotheticalZeroLagOrigin: issue === source,
    historicallyFinalizedIssueAvailable: false,
    clockMode: 'historical_source_time_reconstruction_not_live_issue' as const,
    actualRaw: actual === null ? null : String(actual),
    baselineRaw: baseline === null ? null : String(baseline),
    complete,
    targetCensorReason: targetReason,
    attemptedScenarios: input.scenarios.length,
    usableScenarios: xs.length,
    censoredScenarios: input.scenarios.filter((s) => s.status === 'censored').length,
    excludedScenarios: input.scenarios.filter((s) => s.status === 'excluded').length,
    scenarios: input.scenarios,
    band,
    amountScore,
    amountErrorDenominator: complete ? 1 : 0,
    QCasesAreCorrelated: true,
    QCases: input.requestedRaw.map((q) => {
      const Q = nativeRaw(q),
        beforeShort = baseline === null ? null : baseline < Q,
        afterShort = actual === null ? null : actual < Q,
        predictedCovers = mean === null ? null : mean >= Q
      return {
        requestedRaw: q,
        actualHeadroomRaw: actual === null ? null : String(actual - Q),
        persistenceHeadroomRaw: baseline === null ? null : String(baseline - Q),
        predictedMeanHeadroomRaw: mean === null ? null : String(mean - Q),
        headroomBand:
          band === null
            ? null
            : Object.fromEntries(Object.entries(band).map(([k, v]) => [k, String(BigInt(v) - Q)])),
        actualCovers: afterShort === null ? null : !afterShort,
        predictedCovers,
        falseSafe:
          predictedCovers === null || afterShort === null ? null : predictedCovers && afterShort,
        persistenceFalseSafe:
          beforeShort === null || afterShort === null ? null : !beforeShort && afterShort,
        sampledShrinking: actual === null || baseline === null ? null : actual < baseline,
        endpointLossBracket:
          beforeShort === false && afterShort === true
            ? { after: input.sourceAtUtc, by: input.targetAtUtc }
            : null,
        endpointRecoveryBracket:
          beforeShort === true && afterShort === false
            ? { after: input.sourceAtUtc, by: input.targetAtUtc }
            : null,
        leftCensored: beforeShort,
        rightCensored: afterShort,
        continuousAvailabilityKnown: false,
      }
    }),
  }
}
function chronology(
  points: readonly {
    source: { blockTime: string; blockNumber: string | number }
    acquiredAtUtc: string
  }[],
  analysisAtUtc: string,
) {
  const analysis = researchClock(analysisAtUtc)
  check(points.length >= 4 && points.length <= 64, 'frame_count')
  points.forEach((p, n) => {
    const at = researchClock(p.source.blockTime),
      acquired = researchClock(p.acquiredAtUtc)
    check(at <= acquired && acquired <= analysis, 'actual_acquisition_clock')
    check(BigInt(p.source.blockNumber) > 0n, 'block')
    if (n)
      check(
        at > researchClock(points[n - 1].source.blockTime) &&
          BigInt(p.source.blockNumber) > BigInt(points[n - 1].source.blockNumber),
        'frame_chronology',
      )
  })
}
function Qs(reference: bigint): string[] {
  return [
    ...new Set(
      [reference / 4n || 1n, reference / 2n || 1n, reference || 1n, reference + 1n]
        .filter((q) => q <= MAX)
        .map(String),
    ),
  ]
}
export function usd3NativeCapacity(p: Usd3JointHistoricalPoint): string | null {
  return p.shutdown ||
    p.nativeQuoteStatus !== 'conditional_reference_address_quote' ||
    p.availableWithdrawLimitRaw === null
    ? null
    : String(min(nativeRaw(p.nativeEaRaw), nativeRaw(p.availableWithdrawLimitRaw)))
}
export function scoreUsd3SizedHistory(
  points: readonly Usd3JointHistoricalPoint[],
  analysisAtUtc: string,
  frozenQs?: readonly (readonly string[])[],
) {
  chronology(points, analysisAtUtc)
  check(!frozenQs || frozenQs.length === points.length - 3, 'frozen_Q_fold_count')
  return points.slice(2, -1).map((baseline, n) => {
    const outcome = points[n + 3],
      training = points.slice(0, n + 2),
      requests =
        frozenQs?.[n] ?? Qs(nativeRaw(usd3NativeCapacity(baseline) ?? baseline.nativeEaRaw)),
      fingerprint = usd3HistoricalRuntimeFingerprint(baseline)
    const input = {
      mode: 'retrospective_replay' as const,
      routeKey: 'USDC → USD3 [USDC]' as const,
      destination: '0x056b269eb1f75477a8666ae8c7fe01b64dd55ecc' as const,
      owner: null,
      withdrawalLimitSubject: baseline.withdrawalLimitSubject,
      issueAtUtc: analysisAtUtc,
      knowledgeCutoffUtc: baseline.source.blockTime,
      horizonHours:
        (researchClock(outcome.source.blockTime) - researchClock(baseline.source.blockTime)) /
        3600000,
      requestedRaw: requests[0],
      history: structuredClone(training),
      baseline: structuredClone(baseline),
      maxHistoricalGapSeconds: 7 * 86400,
    }
    check(
      requests.length > 0 &&
        training.every(
          (p) =>
            p.hypotheticalSharesRaw === baseline.hypotheticalSharesRaw &&
            usd3HistoricalRuntimeFingerprint(p) === fingerprint,
        ),
      'USD3_training_S_or_regime',
    )
    const model = buildUsd3JointHistoricalProcess(input, (candidate) => equal(candidate, input))
    check(model && model.targetAtUtc === outcome.source.blockTime, 'USD3_model')
    const outcomeInput = {
      ...input,
      baseline: structuredClone(outcome),
      knowledgeCutoffUtc: outcome.source.blockTime,
    }
    const outcomeModel = buildUsd3JointHistoricalProcess(outcomeInput, (candidate) =>
      equal(candidate, outcomeInput),
    )
    const targetSame =
      !!outcomeModel &&
      outcome.hypotheticalSharesRaw === baseline.hypotheticalSharesRaw &&
      usd3HistoricalRuntimeFingerprint(outcome) === fingerprint
    const scenarios: CapacityScenario[] = [
      ...model.scenarios.map((s) => ({
        status: s.status === 'conditional_path' ? ('usable' as const) : ('censored' as const),
        availableRaw: s.status === 'conditional_path' ? s.points.at(-1)!.capacityRaw : null,
        reason: s.status === 'conditional_path' ? null : (s.reason ?? 'native_path_censored'),
      })),
      ...model.excludedIntervals.map((s) => ({
        status: 'excluded' as const,
        availableRaw: null,
        reason: s.reason,
      })),
    ]
    return {
      subjectKind: 'hypothetical_fixed_S_reference_getter_not_owner' as const,
      targetKind: 'later_native_after_fee_withdrawal_getter_capacity' as const,
      fullSharesRaw: baseline.hypotheticalSharesRaw,
      assetDecimals: 6,
      shareDecimals: 6,
      baselineSource: baseline.source,
      outcomeSource: outcome.source,
      trainingSources: training.map((p) => ({ source: p.source, acquiredAtUtc: p.acquiredAtUtc })),
      knowledgeCutoffUtc: baseline.source.blockTime,
      actualOutcomeAcquiredAtUtc: outcome.acquiredAtUtc,
      nativeFundingDiagnostic: scoreCapacityPrediction({
        sourceAtUtc: baseline.source.blockTime,
        targetAtUtc: outcome.source.blockTime,
        requestedRaw: [],
        baselineRaw: baseline.availableWithdrawLimitRaw,
        actualRaw: targetSame ? outcome.availableWithdrawLimitRaw : null,
        scenarios: [
          ...model.scenarios.map((s) => ({
            status: s.status === 'conditional_path' ? ('usable' as const) : ('censored' as const),
            availableRaw: s.status === 'conditional_path' ? s.points.at(-1)!.availableRaw : null,
            reason: s.status === 'conditional_path' ? null : (s.reason ?? 'native_path_censored'),
          })),
          ...model.excludedIntervals.map((s) => ({
            status: 'excluded' as const,
            availableRaw: null,
            reason: s.reason,
          })),
        ],
        targetCensorReason: targetSame ? null : 'target_S_units_runtime_or_policy_changed',
      }),
      ...scoreCapacityPrediction({
        sourceAtUtc: baseline.source.blockTime,
        targetAtUtc: outcome.source.blockTime,
        requestedRaw: requests,
        baselineRaw: usd3NativeCapacity(baseline),
        actualRaw: targetSame ? usd3NativeCapacity(outcome) : null,
        scenarios,
        targetCensorReason: targetSame ? null : 'target_S_units_runtime_or_policy_changed',
      }),
    }
  })
}
export function fluidNativeCapacity(p: FluidBridgeUsdcFrame) {
  check(
    Number.isInteger(p.withdrawalFeeBps) && p.withdrawalFeeBps >= 0 && p.withdrawalFeeBps < 10000,
    'fluid_fee',
  )
  const gross = min(...FLUID_BRIDGE_USDC_PRONGS.map((key) => nativeRaw(p.nativeProngs[key])))
  const product = gross * BigInt(10000 - p.withdrawalFeeBps)
  check(product <= MAX, 'fluid_native_intermediate_overflow')
  const net = product / 10000n
  return {
    fundingNetRaw: String(net),
    availableRaw: String(min(net, nativeRaw(p.fullHolderNetUsdcRaw))),
  }
}
function fluidProngBindings(p: FluidBridgeUsdcFrame) {
  const gross = min(...FLUID_BRIDGE_USDC_PRONGS.map((key) => nativeRaw(p.nativeProngs[key])))
  const funding = nativeRaw(fluidNativeCapacity(p).fundingNetRaw),
    E = nativeRaw(p.fullHolderNetUsdcRaw)
  return {
    fullEntitlementRaw: String(E),
    fundingCapacityAfterFeeRaw: String(funding),
    quoteEntitlementBinding: E <= funding,
    nativeFundingBinding: funding <= E,
    nativeGrossProngMinimumRaw: String(gross),
    nativeProngs: { ...p.nativeProngs },
    weakestNativeProngs: FLUID_BRIDGE_USDC_PRONGS.filter(
      (key) => nativeRaw(p.nativeProngs[key]) === gross,
    ),
    availableRaw: fluidNativeCapacity(p).availableRaw,
  }
}
const fluidBinding = (p: FluidBridgeUsdcFrame) =>
  JSON.stringify({
    S: p.holderSharesRaw,
    sd: p.shareDecimals,
    asset: p.asset,
    ad: p.assetDecimals,
    regime: p.regime,
    code: p.runtimeCodeHashes,
    fee: p.withdrawalFeeBps,
    units: [p.fundingUnit, p.entitlementUnit],
    owner: p.owner,
    kind: p.provenanceKind,
    past: p.historicalOwnership,
    paused: p.paused,
  })
export function scoreFluidSizedHistory(
  points: readonly FluidBridgeUsdcFrame[],
  analysisAtUtc: string,
  frozenQs?: readonly (readonly string[])[],
) {
  chronology(points, analysisAtUtc)
  check(!frozenQs || frozenQs.length === points.length - 3, 'frozen_Q_fold_count')
  return points.slice(2, -1).map((baseline, n) => {
    const training = points.slice(0, n + 2),
      outcome = points[n + 3],
      binding = fluidBinding(baseline)
    check(
      baseline.owner === null &&
        !baseline.historicalOwnership &&
        baseline.provenanceKind === 'native_hypothetical_shares',
      'fluid_owner',
    )
    check(
      training.every((p) => fluidBinding(p) === binding),
      'fluid_training_S_or_regime',
    )
    const requests = frozenQs?.[n] ?? Qs(nativeRaw(baseline.fullHolderNetUsdcRaw)),
      input = {
        mode: 'retrospective_replay' as const,
        retrospectiveAvailabilityAssumption: 'historical_chain_state_reconstructed_later' as const,
        routeKey: 'USDC → FluidBridgeAggregatorProxy [USDC]' as const,
        destination: '0x273da948aca9261043fbdb2a857bc255ecc29012' as const,
        owner: null,
        issueAtUtc: analysisAtUtc,
        knowledgeCutoffUtc: baseline.source.blockTime,
        horizonHours:
          (researchClock(outcome.source.blockTime) - researchClock(baseline.source.blockTime)) /
          3600000,
        requestedRaw: requests[0],
        history: structuredClone(training),
        baseline: structuredClone(baseline),
        maxHistoricalGapSeconds: 26 * 3600,
      }
    check(requests.length > 0, 'fluid_Q')
    const model = buildFluidBridgeUsdcJointHistoricalProcess(input, (_kind, candidate) =>
      equal(candidate, input),
    )
    check(model && model.targetAtUtc === outcome.source.blockTime, 'fluid_model')
    const outcomeInput = {
      ...input,
      baseline: structuredClone(outcome),
      knowledgeCutoffUtc: outcome.source.blockTime,
    }
    const outcomeModel = buildFluidBridgeUsdcJointHistoricalProcess(
      outcomeInput,
      (_kind, candidate) => equal(candidate, outcomeInput),
    )
    const targetSame = !!outcomeModel && fluidBinding(outcome) === binding
    const scenarios: CapacityScenario[] = [
      ...model.scenarios.map((s) => ({
        status: s.status === 'usable' ? ('usable' as const) : ('censored' as const),
        availableRaw: s.status === 'usable' ? s.targetMeasurement!.availableRaw : null,
        reason: s.status === 'usable' ? null : (s.reason ?? 'native_path_censored'),
      })),
      ...model.excludedIntervals.map((s) => ({
        status: 'excluded' as const,
        availableRaw: null,
        reason: s.reason,
      })),
    ]
    return {
      subjectKind: 'hypothetical_fixed_S_not_owner' as const,
      targetKind: 'later_native_after_fee_prong_capacity' as const,
      nativeProngBindings: {
        baseline: fluidProngBindings(baseline),
        outcome: targetSame ? fluidProngBindings(outcome) : null,
      },
      fullSharesRaw: baseline.holderSharesRaw,
      assetDecimals: 6,
      shareDecimals: baseline.shareDecimals,
      baselineSource: baseline.source,
      outcomeSource: outcome.source,
      trainingSources: training.map((p) => ({ source: p.source, acquiredAtUtc: p.acquiredAtUtc })),
      knowledgeCutoffUtc: baseline.source.blockTime,
      actualOutcomeAcquiredAtUtc: outcome.acquiredAtUtc,
      nativeFundingDiagnostic: scoreCapacityPrediction({
        sourceAtUtc: baseline.source.blockTime,
        targetAtUtc: outcome.source.blockTime,
        requestedRaw: [],
        baselineRaw: fluidNativeCapacity(baseline).fundingNetRaw,
        actualRaw: targetSame ? fluidNativeCapacity(outcome).fundingNetRaw : null,
        scenarios: [
          ...model.scenarios.map((s) => ({
            status: s.status === 'usable' ? ('usable' as const) : ('censored' as const),
            availableRaw: s.status === 'usable' ? s.targetMeasurement!.fundingNetRaw : null,
            reason: s.status === 'usable' ? null : (s.reason ?? 'native_path_censored'),
          })),
          ...model.excludedIntervals.map((s) => ({
            status: 'excluded' as const,
            availableRaw: null,
            reason: s.reason,
          })),
        ],
        targetCensorReason: targetSame ? null : 'target_S_units_runtime_or_policy_changed',
      }),
      ...scoreCapacityPrediction({
        sourceAtUtc: baseline.source.blockTime,
        targetAtUtc: outcome.source.blockTime,
        requestedRaw: requests,
        baselineRaw: fluidNativeCapacity(baseline).availableRaw,
        actualRaw: targetSame ? fluidNativeCapacity(outcome).availableRaw : null,
        scenarios,
        targetCensorReason: targetSame ? null : 'target_S_units_runtime_or_policy_changed',
      }),
    }
  })
}
export type ApySizedFrame = ApyUsdJointNativeHistoryReplay & {
  vaultPaused: boolean
  receiptPaused: boolean
}
export function apyInitiationCapacity(input: {
  netEaRaw: string
  vaultCashRaw: string
  feeWad: string
  paused: boolean
}) {
  const E = nativeRaw(input.netEaRaw),
    C = nativeRaw(input.vaultCashRaw),
    f = nativeRaw(input.feeWad)
  check(f <= WAD && typeof input.paused === 'boolean', 'apy_fee_or_pause')
  const escrow = input.paused ? 0n : min(E, (C * WAD) / (WAD + f), MAX208)
  const needed = escrow + (escrow * f + WAD - 1n) / WAD
  check(needed <= C && escrow <= MAX208, 'apy_fee_cash_budget')
  return {
    availableRaw: String(escrow),
    grossNeededRaw: String(needed),
    receiptUint208CapRaw: String(MAX208),
  }
}
function apyProngBindings(p: ApySizedFrame) {
  const E = nativeRaw(p.fullEscrowEaRaw!),
    C = nativeRaw(p.vaultCashRaw!),
    f = nativeRaw(p.vaultUnlockingFeeWad),
    budget = (C * WAD) / (WAD + f),
    paused = p.vaultPaused || p.receiptPaused
  return {
    fullEntitlementRaw: String(E),
    vaultCashRaw: String(C),
    nativeGrossQuoteRaw: p.fullGrossAssetsRaw,
    fundingCapacityAfterFeeRaw: String(budget),
    receiptUint208CapRaw: String(MAX208),
    paused,
    quoteEntitlementBinding: !paused && E <= budget && E <= MAX208,
    nativeFundingBinding: !paused && budget <= E && budget <= MAX208,
    receiptUint208Binding: !paused && MAX208 <= E && MAX208 <= budget,
    availableRaw: apyInitiationCapacity({
      netEaRaw: String(E),
      vaultCashRaw: String(C),
      feeWad: String(f),
      paused,
    }).availableRaw,
  }
}
const apyBinding = (p: ApySizedFrame) =>
  JSON.stringify({
    S: p.fullSharesRaw,
    sd: p.shareDecimals,
    ad: p.assetDecimals,
    profile: p.profileId,
    runtime: p.runtimeRegime,
    fee: p.vaultUnlockingFeeWad,
    curve: p.feeCurve,
    vesting: p.vestingAddress,
  })
export function scoreApySizedHistory(points: readonly ApySizedFrame[], analysisAtUtc: string) {
  chronology(points, analysisAtUtc)
  points.forEach((p) => {
    check(
      p.owner === null &&
        p.historicalOwnership === false &&
        p.assetDecimals === 18 &&
        p.shareDecimals === 18,
      'apy_units_or_owner',
    )
    check(validApyUsdFeeCurve(p.feeCurve), 'apy_curve')
    check(typeof p.vaultPaused === 'boolean' && typeof p.receiptPaused === 'boolean', 'apy_pause')
    check(
      p.fullGrossAssetsRaw !== null && p.fullEscrowEaRaw !== null && p.vaultCashRaw !== null,
      'apy_native_quote_missing',
    )
    const gross = nativeRaw(p.fullGrossAssetsRaw),
      f = nativeRaw(p.vaultUnlockingFeeWad)
    check(
      f <= WAD && gross - (gross * f + WAD + f - 1n) / (WAD + f) === nativeRaw(p.fullEscrowEaRaw),
      'apy_native_quote_fee',
    )
  })
  return points.slice(2, -1).map((baseline, n) => {
    const training = points.slice(0, n + 2),
      outcome = points[n + 3],
      binding = apyBinding(baseline)
    check(
      training.every((p) => apyBinding(p) === binding),
      'apy_training_S_or_regime',
    )
    const targetSame = apyBinding(outcome) === binding,
      elapsed = researchClock(outcome.source.blockTime) - researchClock(baseline.source.blockTime),
      capacity = (p: ApySizedFrame) =>
        apyInitiationCapacity({
          netEaRaw: p.fullEscrowEaRaw!,
          vaultCashRaw: p.vaultCashRaw!,
          feeWad: p.vaultUnlockingFeeWad,
          paused: p.vaultPaused || p.receiptPaused,
        }).availableRaw
    const cashScenarios: CapacityScenario[] = []
    const scenarios: CapacityScenario[] = training.slice(1).map((b, j) => {
      const a = training[j],
        duration = researchClock(b.source.blockTime) - researchClock(a.source.blockTime)
      if (
        duration > 26 * 3600000 ||
        b.vaultPaused ||
        b.receiptPaused ||
        a.vaultPaused ||
        a.receiptPaused
      ) {
        const excluded: CapacityScenario = {
          status: 'excluded',
          availableRaw: null,
          reason: 'donor_gap_or_pause',
        }
        cashScenarios.push(excluded)
        return excluded
      }
      // NET is translated once in the gross native quote and cash channels. Post-vault-fee Ea is then derived exactly.
      const clockInput = {
          sourceAtUtc: baseline.source.blockTime,
          issueAtUtc: baseline.source.blockTime,
          horizonHours: elapsed / 3600000,
          targetAtUtc: outcome.source.blockTime,
          donorStartAtUtc: a.source.blockTime,
          donorEndAtUtc: b.source.blockTime,
        },
        gross = projectNativeNetStock({
          ...clockInput,
          sourceRaw: baseline.fullGrossAssetsRaw!,
          donorStartRaw: a.fullGrossAssetsRaw!,
          donorEndRaw: b.fullGrossAssetsRaw!,
        })!,
        cash = projectNativeNetStock({
          ...clockInput,
          sourceRaw: baseline.vaultCashRaw!,
          donorStartRaw: a.vaultCashRaw!,
          donorEndRaw: b.vaultCashRaw!,
        })!
      cashScenarios.push(
        cash < 0n || cash > MAX
          ? {
              status: 'censored',
              availableRaw: null,
              reason: 'projected_native_cash_out_of_bounds',
            }
          : { status: 'usable', availableRaw: String(cash), reason: null },
      )
      if (gross < 0n || cash < 0n || gross > MAX || cash > MAX)
        return {
          status: 'censored',
          availableRaw: null,
          reason: 'projected_native_stock_out_of_bounds',
        }
      const f = nativeRaw(baseline.vaultUnlockingFeeWad),
        E = gross - (gross * f + WAD + f - 1n) / (WAD + f)
      return {
        status: 'usable',
        availableRaw: apyInitiationCapacity({
          netEaRaw: String(E),
          vaultCashRaw: String(cash),
          feeWad: baseline.vaultUnlockingFeeWad,
          paused: baseline.vaultPaused || baseline.receiptPaused,
        }).availableRaw,
        reason: null,
      }
    })
    const result = scoreCapacityPrediction({
      sourceAtUtc: baseline.source.blockTime,
      targetAtUtc: outcome.source.blockTime,
      requestedRaw: [...new Set([...Qs(nativeRaw(capacity(baseline))), String(WAD)])],
      baselineRaw: capacity(baseline),
      actualRaw: targetSame ? capacity(outcome) : null,
      scenarios,
      targetCensorReason: targetSame ? null : 'target_S_units_runtime_or_policy_changed',
    })
    const freezeEscrow = capacity(baseline),
      seconds = elapsed / 1000,
      conditionalNet =
        seconds < baseline.feeCurve.minDurationSeconds
          ? '0'
          : (projectApyUsdNet(freezeEscrow, seconds, baseline.feeCurve)?.netRaw ?? null)
    return {
      subjectKind: 'hypothetical_fixed_S_not_owner' as const,
      targetKind: 'later_native_escrow_quote_and_cash_upper_bound_not_initiation_call' as const,
      nativeProngBindings: {
        baseline: apyProngBindings(baseline),
        outcome: targetSame ? apyProngBindings(outcome) : null,
      },
      nativeVaultCashDiagnostic: {
        scope: 'raw_native_apxUSD_vault_cash_not_holder_execution' as const,
        assetDecimals: 18,
        feeApplied: false,
        holderQApplied: false,
        ...scoreCapacityPrediction({
          sourceAtUtc: baseline.source.blockTime,
          targetAtUtc: outcome.source.blockTime,
          requestedRaw: [],
          baselineRaw: baseline.vaultCashRaw,
          actualRaw: targetSame ? outcome.vaultCashRaw : null,
          scenarios: cashScenarios,
          targetCensorReason: targetSame ? null : 'target_S_units_runtime_or_policy_changed',
        }),
      },
      fullSharesRaw: baseline.fullSharesRaw,
      assetDecimals: 18,
      shareDecimals: 18,
      baselineSource: baseline.source,
      outcomeSource: outcome.source,
      trainingSources: training.map((p) => ({ source: p.source, acquiredAtUtc: p.acquiredAtUtc })),
      existingNFTsUsed: 0,
      knowledgeCutoffUtc: baseline.source.blockTime,
      actualOutcomeAcquiredAtUtc: outcome.acquiredAtUtc,
      ...result,
      hypotheticalSourceInitiation: {
        action: 'asset_denominated_withdrawForReceipt',
        escrowRaw: freezeEscrow,
        openingAtUtc: new Date(
          researchClock(baseline.source.blockTime) + baseline.feeCurve.minDurationSeconds * 1000,
        ).toISOString(),
        conditionalUnobservedNetAtTargetRaw: conditionalNet,
        curve: baseline.feeCurve,
        actualNativeInitiationSimulation: false,
        partialNativePreviewWithdrawUnavailable: true,
        residualSharesOutsideAction: true,
        actualMintedReceipt: false,
        actualDeliveryTarget: false,
      },
    }
  })
}
/** Genuine fixed-S/CS native quote/cash diagnostics. Historical holder eligibility is absent. */
export type UmbrellaFundingQuoteFrame = UmbrellaGhoJointNativeHistoryPoint & {
  asset: string
  assetDecimals: 18
  shareDecimals: 18
}
const umbrellaRuntime = (p: UmbrellaFundingQuoteFrame) =>
  Object.entries(p.runtimeCodeHashes).sort(([a], [b]) => a.localeCompare(b))
const umbrellaCashBinding = (p: UmbrellaFundingQuoteFrame) =>
  JSON.stringify({
    asset: p.asset,
    assetDecimals: p.assetDecimals,
    shareDecimals: p.shareDecimals,
    runtime: umbrellaRuntime(p),
  })
const umbrellaQuoteBinding = (p: UmbrellaFundingQuoteFrame) =>
  JSON.stringify({
    cash: umbrellaCashBinding(p),
    S: p.sharesRaw,
    CS: p.cooldownCoveredSharesRaw,
    cooldownSeconds: p.cooldownSeconds,
    unstakeWindowSeconds: p.unstakeWindowSeconds,
  })
export function umbrellaQuoteCashUpperBound(p: UmbrellaFundingQuoteFrame): string | null {
  if (p.cashRaw === null || p.fullEaRaw === null || p.coveredEaRaw === null) return null
  return String(
    p.paused ? 0n : min(nativeRaw(p.cashRaw), nativeRaw(p.fullEaRaw), nativeRaw(p.coveredEaRaw)),
  )
}
function umbrellaProngBindings(p: UmbrellaFundingQuoteFrame) {
  const bound = umbrellaQuoteCashUpperBound(p)
  return {
    fullSharesRaw: p.sharesRaw,
    cooldownCoveredSharesRaw: p.cooldownCoveredSharesRaw,
    fullEaRaw: p.fullEaRaw,
    coveredEaRaw: p.coveredEaRaw,
    cashRaw: p.cashRaw,
    paused: p.paused,
    upperBoundRaw: bound,
    quoteEntitlementBinding:
      bound !== null && !p.paused && (bound === p.fullEaRaw || bound === p.coveredEaRaw),
    nativeFundingBinding: bound !== null && !p.paused && bound === p.cashRaw,
    maxSlashableAssetsDiagnosticRaw: p.maxSlashableAssetsRaw ?? null,
    maxSlashableAppliedAsFeeReserveOrLoss: false,
  }
}
export function scoreUmbrellaFundingQuoteHistory(
  points: readonly UmbrellaFundingQuoteFrame[],
  analysisAtUtc: string,
  options: { sourceAgeMs?: number; horizonHours?: number } = {},
) {
  chronology(points, analysisAtUtc)
  const sourceAgeMs = options.sourceAgeMs ?? 0,
    horizonHours = options.horizonHours ?? 24
  check(
    Number.isSafeInteger(sourceAgeMs) &&
      sourceAgeMs >= 0 &&
      sourceAgeMs <= 1800000 &&
      Number.isFinite(horizonHours) &&
      horizonHours > 0 &&
      horizonHours <= 720 &&
      Number.isSafeInteger(horizonHours * 3600000),
    'umbrella_research_clock',
  )
  points.forEach((p) => {
    check(
      p.owner === null &&
        p.historicalOwnership === false &&
        p.MRaw === null &&
        p.asset === ORIGINAL_GHO &&
        p.assetDecimals === 18 &&
        p.shareDecimals === 18 &&
        p.source.chainId === 1 &&
        p.source.finalized === true &&
        Number.isSafeInteger(p.source.blockNumber) &&
        /^0x[0-9a-f]{64}$/.test(p.source.blockHash) &&
        p.sourceClass === 'captured_identical_runtimes_only',
      'umbrella_native_identity_or_owner',
    )
    const S = nativeRaw(p.sharesRaw),
      CS = nativeRaw(p.cooldownCoveredSharesRaw)
    check(S > 0n && CS <= S && CS < 1n << 192n, 'umbrella_S_CS')
    check(
      typeof p.paused === 'boolean' &&
        nativeRaw(p.cooldownSeconds) <= 0xffffffffn &&
        nativeRaw(p.unstakeWindowSeconds) <= 0xffffffffn,
      'umbrella_policy',
    )
    check(
      p.runtimeCodeHashes &&
        Object.keys(p.runtimeCodeHashes).length === 3 &&
        Object.entries(p.runtimeCodeHashes).every(
          ([a, h]) => /^0x[0-9a-f]{40}$/.test(a) && /^0x[0-9a-f]{64}$/.test(h),
        ),
      'umbrella_runtime',
    )
    for (const value of [p.cashRaw, p.fullEaRaw, p.coveredEaRaw])
      if (value !== null) nativeRaw(value)
    if (p.maxSlashableAssetsRaw !== undefined) nativeRaw(p.maxSlashableAssetsRaw)
    if (p.authority)
      check(
        Object.values(p.authority).every((v) => v === false),
        'umbrella_authority',
      )
  })
  return points.slice(2, -1).map((baseline, n) => {
    const training = points.slice(0, n + 2),
      outcome = points[n + 3],
      binding = umbrellaQuoteBinding(baseline),
      cashBinding = umbrellaCashBinding(baseline),
      targetSame = umbrellaQuoteBinding(outcome) === binding,
      cashTargetSame = umbrellaCashBinding(outcome) === cashBinding,
      issueAtUtc = new Date(researchClock(baseline.source.blockTime) + sourceAgeMs).toISOString()
    check(
      training.every((p) => umbrellaQuoteBinding(p) === binding),
      'umbrella_training_S_CS_units_runtime_or_policy',
    )
    const clock = {
      sourceAtUtc: baseline.source.blockTime,
      issueAtUtc,
      horizonHours,
      targetAtUtc: outcome.source.blockTime,
    }
    const aligned =
      nativeProjectionElapsedMs(clock.sourceAtUtc, issueAtUtc, horizonHours, clock.targetAtUtc) !==
      null
    const scenarios: CapacityScenario[] = [],
      cashScenarios: CapacityScenario[] = []
    training.slice(1).forEach((z, j) => {
      const a = training[j],
        period = researchClock(z.source.blockTime) - researchClock(a.source.blockTime)
      const projectChannel = (key: 'cashRaw' | 'fullEaRaw' | 'coveredEaRaw') =>
        baseline[key] === null || a[key] === null || z[key] === null
          ? null
          : projectNativeNetStock({
              ...clock,
              sourceRaw: baseline[key]!,
              donorStartAtUtc: a.source.blockTime,
              donorEndAtUtc: z.source.blockTime,
              donorStartRaw: a[key]!,
              donorEndRaw: z[key]!,
            })
      if (period > 26 * 3600000) {
        const excluded: CapacityScenario = {
          status: 'excluded',
          availableRaw: null,
          reason: 'donor_gap',
        }
        scenarios.push(excluded)
        cashScenarios.push(excluded)
        return
      }
      const cash = projectChannel('cashRaw')
      cashScenarios.push(
        cash === null || cash < 0n || cash > MAX
          ? {
              status: 'censored',
              availableRaw: null,
              reason:
                cash === null
                  ? 'missing_exact_endpoint_or_native_cash'
                  : 'projected_native_cash_out_of_bounds',
            }
          : { status: 'usable', availableRaw: String(cash), reason: null },
      )
      const full = projectChannel('fullEaRaw'),
        covered = projectChannel('coveredEaRaw')
      if (baseline.paused || a.paused || z.paused) {
        scenarios.push({
          status: 'censored',
          availableRaw: null,
          reason: 'source_or_donor_pause_future_gate_unknown',
        })
      } else if ([cash, full, covered].some((v) => v === null || v < 0n || v > MAX)) {
        scenarios.push({
          status: 'censored',
          availableRaw: null,
          reason: 'missing_endpoint_or_native_quote_or_stock_out_of_bounds',
        })
      } else
        scenarios.push({
          status: 'usable',
          availableRaw: String(min(cash!, full!, covered!)),
          reason: null,
        })
    })
    const baselineBound = umbrellaQuoteCashUpperBound(baseline),
      outcomeBound = umbrellaQuoteCashUpperBound(outcome),
      targetReason = !aligned
        ? 'missing_exact_issue_plus_horizon_native_endpoint'
        : !targetSame
          ? 'target_S_CS_units_runtime_or_policy_changed'
          : outcomeBound === null
            ? 'target_native_quote_or_cash_missing'
            : null,
      result = scoreCapacityPrediction({
        ...clock,
        requestedRaw: Qs(baselineBound === null ? 0n : nativeRaw(baselineBound)),
        baselineRaw: baselineBound,
        actualRaw: targetReason ? null : outcomeBound,
        scenarios,
        targetCensorReason: targetReason,
      })
    return {
      ...result,
      diagnosticOnly: true as const,
      subjectKind: 'hypothetical_fixed_S_CS_not_owner' as const,
      targetKind: 'later_native_previewRedeem_and_cash_upper_bound_not_holder_exit' as const,
      actualHolderEligibility: null,
      actualHolderExitAbilityRaw: null,
      holderAbilityCensorReason:
        'missing_historical_owner_balance_cooldown_snapshot_and_maxRedeem' as const,
      holderAmountErrorDenominator: 0,
      upperBoundAmountErrorDenominator: result.amountErrorDenominator,
      fullSharesRaw: baseline.sharesRaw,
      cooldownCoveredSharesRaw: baseline.cooldownCoveredSharesRaw,
      assetDecimals: 18,
      shareDecimals: 18,
      baselineSource: baseline.source,
      outcomeSource: outcome.source,
      baselineActualAcquiredAtUtc: baseline.acquiredAtUtc,
      actualOutcomeAcquiredAtUtc: outcome.acquiredAtUtc,
      trainingSources: training.map((p) => ({ source: p.source, acquiredAtUtc: p.acquiredAtUtc })),
      knowledgeCutoffUtc: baseline.source.blockTime,
      historicalHolderPolicyTransplanted: false,
      nativeProngBindings: {
        baseline: umbrellaProngBindings(baseline),
        outcome: targetSame ? umbrellaProngBindings(outcome) : null,
      },
      nativeGhoCashDiagnostic: {
        scope: 'raw_native_GHO_cash_not_holder_exit' as const,
        feeApplied: false,
        holderQApplied: false,
        maxSlashableApplied: false,
        ...scoreCapacityPrediction({
          ...clock,
          requestedRaw: [],
          baselineRaw: baseline.cashRaw,
          actualRaw: cashTargetSame ? outcome.cashRaw : null,
          scenarios: cashScenarios,
          targetCensorReason: !aligned
            ? 'missing_exact_issue_plus_horizon_native_endpoint'
            : !cashTargetSame
              ? 'target_native_cash_units_or_runtime_changed'
              : outcome.cashRaw === null
                ? 'target_native_cash_missing'
                : null,
        }),
      },
    }
  })
}

export type ReceiptPaymentRow = {
  tokenId: string
  holder: string
  issuedAt: number
  claimableAt: number
  escrowRaw: string
  paidAt: number | null
  paidRaw: string | null
  payoutHolder: string | null
}
/** Separate mined-payment endpoint. Completed-case fit is descriptive and does not estimate ability to claim. */
export function scoreApyReceiptPayments(
  rows: readonly ReceiptPaymentRow[],
  horizonsDays: readonly number[] = [3, 7, 14, 21, 28],
) {
  check(rows.length >= 4 && rows.length <= 256 && rows.length % 2 === 0, 'receipt_cohort')
  check(new Set(rows.map((r) => r.tokenId)).size === rows.length, 'receipt_duplicate')
  const ordered = [...structuredClone(rows)].sort(
    (a, b) => a.issuedAt - b.issuedAt || (BigInt(a.tokenId) < BigInt(b.tokenId) ? -1 : 1),
  )
  ordered.forEach((r) => {
    nativeRaw(r.tokenId)
    check(/^0x[0-9a-f]{40}$/.test(r.holder), 'receipt_holder')
    check(
      Number.isSafeInteger(r.issuedAt) &&
        r.issuedAt > 0 &&
        Number.isSafeInteger(r.claimableAt) &&
        r.claimableAt >= r.issuedAt,
      'receipt_clock',
    )
    const escrow = nativeRaw(r.escrowRaw)
    check(escrow > 0n, 'receipt_escrow')
    check(
      (r.paidAt === null) === (r.paidRaw === null) &&
        (r.paidAt === null) === (r.payoutHolder === null),
      'payment_shape',
    )
    if (r.paidAt !== null) {
      check(
        Number.isSafeInteger(r.paidAt) && r.paidAt >= r.claimableAt && r.paidAt > r.issuedAt,
        'payment_clock',
      )
      check(
        r.payoutHolder === r.holder && nativeRaw(r.paidRaw) <= escrow,
        'payment_holder_or_net_amount',
      )
    }
  })
  const split = ordered.length / 2,
    train = ordered.slice(0, split),
    holdout = ordered.slice(split),
    splitAt = holdout[0].issuedAt,
    trainingAsOf = splitAt - 1
  check(train.at(-1)!.issuedAt < splitAt, 'receipt_split_tie')
  const visible = train.filter((r) => r.paidAt !== null && r.paidAt <= trainingAsOf),
    observationCutoff = Math.max(...ordered.map((r) => r.paidAt ?? 0))
  check(
    observationCutoff >= ordered.at(-1)!.issuedAt && visible.length > 0,
    'receipt_observation_support',
  )
  const ratios = visible
      .map((r) => (nativeRaw(r.paidRaw) * WAD) / nativeRaw(r.escrowRaw))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    delays = visible.map((r) => r.paidAt! - r.issuedAt).sort((a, b) => a - b),
    ratio = quantile(ratios, 50),
    delay = delays[Math.floor((delays.length - 1) / 2)]
  horizonsDays.forEach((h) => check(Number.isSafeInteger(h) && h > 0 && h <= 90, 'payment_horizon'))
  return {
    ...RESEARCH_ONLY,
    targetKind: 'actual_same_receipt_mined_holder_payment_after_fees' as const,
    requestCount: ordered.length,
    actualPaymentCount: ordered.filter((r) => r.paidAt !== null).length,
    openCount: ordered.filter((r) => r.paidAt === null).length,
    trainRequests: train.length,
    holdoutRequests: holdout.length,
    splitAtUtc: new Date(splitAt * 1000).toISOString(),
    trainingAsOfUtc: new Date(trainingAsOf * 1000).toISOString(),
    observedThroughUtc: new Date(observationCutoff * 1000).toISOString(),
    trainingVisiblePayments: visible.length,
    trainingLatePaymentsExcluded: train.filter((r) => r.paidAt !== null && r.paidAt > trainingAsOf)
      .length,
    trainingPaymentTokenIds: visible.map((r) => r.tokenId),
    holderCounts: {
      train: new Set(train.map((r) => r.holder)).size,
      holdout: new Set(holdout.map((r) => r.holder)).size,
      repeatedAcrossSplit: new Set(
        holdout.filter((r) => train.some((t) => t.holder === r.holder)).map((r) => r.holder),
      ).size,
    },
    descriptiveCompletedCaseFit: {
      netPaidPerEscrowWad: String(ratio),
      requestToPaymentMedianSeconds: delay,
      informativeCensoringPossible: true,
      claimabilityAssessed: false,
    },
    holdout: horizonsDays.map((days) => {
      const H = days * 86400
      const cases = holdout.map((r) => {
        const paidByH =
            r.paidAt !== null && r.paidAt - r.issuedAt <= H && r.paidAt <= observationCutoff,
          mature = paidByH || observationCutoff - r.issuedAt >= H,
          actual = !mature ? null : paidByH ? nativeRaw(r.paidRaw) : 0n,
          predicted = H >= delay ? (nativeRaw(r.escrowRaw) * ratio) / WAD : 0n,
          openingBenchmark = H >= r.claimableAt - r.issuedAt ? nativeRaw(r.escrowRaw) : 0n
        return {
          tokenId: r.tokenId,
          escrowRaw: r.escrowRaw,
          status: mature ? 'scored' : 'right_censored',
          paidByH: mature ? paidByH : null,
          predictedNetPaidByHRaw: String(predicted),
          openingTimeEscrowBenchmarkRaw: String(openingBenchmark),
          actualNetPaidByHRaw: actual === null ? null : String(actual),
          signedErrorRaw: actual === null ? null : String(predicted - actual),
          absoluteErrorRaw: actual === null ? null : String(abs(predicted - actual)),
          benchmarkAbsoluteErrorRaw:
            actual === null ? null : String(abs(openingBenchmark - actual)),
          falseSafe: mature ? predicted > 0n && !paidByH : null,
          deliveryDurationSeconds: r.paidAt === null ? null : r.paidAt - r.issuedAt,
          rightCensored: r.paidAt === null,
          observedUnpaidThroughSeconds: r.paidAt === null ? observationCutoff - r.issuedAt : null,
        }
      })
      const scored = cases.filter((r) => r.status === 'scored')
      return {
        days,
        scored: scored.length,
        censored: cases.length - scored.length,
        paid: scored.filter((r) => r.paidByH).length,
        amountAbsoluteErrorSumRaw: String(
          scored.reduce((s, r) => s + BigInt(r.absoluteErrorRaw!), 0n),
        ),
        benchmarkAbsoluteErrorSumRaw: String(
          scored.reduce((s, r) => s + BigInt(r.benchmarkAbsoluteErrorRaw!), 0n),
        ),
        falseSafeCount: scored.filter((r) => r.falseSafe).length,
        casesAreCorrelatedAcrossHorizons: true,
        cases,
      }
    }),
    limits: [
      'only split-visible completed payments fit amount and timing',
      'payment delay includes voluntary holder claim timing',
      'unpaid receipts are right-censored for ultimate delivery',
      'opening-time escrow benchmark is an assumption, not observed ability or guaranteed delivery',
    ],
  }
}
