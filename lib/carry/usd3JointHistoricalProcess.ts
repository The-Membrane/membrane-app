import { keccak256, stringToHex } from 'viem'

import { buildConditionalTimeProcess } from '../venueForecast/conditionalTimeProcess'

export const USD3_HISTORICAL_ROUTE = 'USDC → USD3 [USDC]'
export const USD3_HISTORICAL_VAULT = '0x056b269eb1f75477a8666ae8c7fe01b64dd55ecc'
export const USD3_HISTORICAL_USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
export const USD3_REFERENCE_SUBJECT = '0x0000000000000000000000000000000000000000'
/** Facts supplied by the independent raw-capture replay, never a model-created proof. */
export type Usd3JointHistoricalPoint = {
  source: {
    chainId: 1
    blockNumber: string | number
    blockHash: string
    blockTime: string
    finalized: true
  }
  acquiredAtUtc: string
  hypotheticalSharesRaw: string
  shareDecimals: 6
  asset: string
  assetDecimals: 6
  nativeEaRaw: string
  availableWithdrawLimitRaw: string | null
  nativeQuoteStatus:
    | 'conditional_reference_address_quote'
    | 'censored_native_withdrawal_limit_unavailable'
  withdrawalLimitSubject: string
  conditionalReferenceAddressQuote: true
  ownerCommitmentQualification: false
  shutdown: boolean
  navRaw: string
  totalAssetsRaw: string
  idleUsdcDiagnosticRaw: string
  idleUsdcIsTotalFundingUpperBound: false
  sourceClass: 'captured_identical_runtimes_only'
  runtimeIdentities: { address: string; runtimeKeccak256: string }[]
  sourceImplementationEquivalence: false
}
export type Usd3JointHistoricalInput = {
  mode: 'retrospective_replay'
  routeKey: typeof USD3_HISTORICAL_ROUTE
  destination: typeof USD3_HISTORICAL_VAULT
  owner: null
  /** Getter reference only; this never establishes past ownership or authority. */
  withdrawalLimitSubject?: string
  /** Actual reconstruction/analysis time; the engine clock is the historical baseline. */
  issueAtUtc: string
  knowledgeCutoffUtc: string
  horizonHours: number
  requestedRaw: string
  history: Usd3JointHistoricalPoint[]
  baseline: Usd3JointHistoricalPoint
  maxHistoricalGapSeconds: number
}
export type Usd3JointHistoricalApprover = (input: Usd3JointHistoricalInput) => boolean
const MAX = (1n << 256n) - 1n
const raw = (v: unknown): v is string =>
  typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) <= MAX
const utc = (v: unknown): v is string =>
  typeof v === 'string' &&
  Number.isSafeInteger(Date.parse(v)) &&
  new Date(Date.parse(v)).toISOString() === v
const address = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-f]{40}$/.test(v)
const hash = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v)
const block = (v: unknown): v is string | number =>
  typeof v === 'number' ? Number.isSafeInteger(v) && v > 0 : raw(v) && v !== '0'
const dense = (v: unknown, max: number): v is unknown[] =>
  Array.isArray(v) &&
  v.length <= max &&
  Object.keys(v).length === v.length &&
  Array.from({ length: v.length }, (_, n) => Object.hasOwn(v, n)).every(Boolean)
function validPoint(p: Usd3JointHistoricalPoint, analysisAt: string, referenceSubject: string) {
  return (
    !!p &&
    !!p.source &&
    p.source.chainId === 1 &&
    p.source.finalized === true &&
    block(p.source.blockNumber) &&
    hash(p.source.blockHash) &&
    utc(p.source.blockTime) &&
    Date.parse(p.source.blockTime) % 1000 === 0 &&
    utc(p.acquiredAtUtc) &&
    Date.parse(p.acquiredAtUtc) >= Date.parse(p.source.blockTime) &&
    Date.parse(p.acquiredAtUtc) <= Date.parse(analysisAt) &&
    raw(p.hypotheticalSharesRaw) &&
    p.hypotheticalSharesRaw !== '0' &&
    p.shareDecimals === 6 &&
    p.asset === USD3_HISTORICAL_USDC &&
    p.assetDecimals === 6 &&
    raw(p.nativeEaRaw) &&
    (p.availableWithdrawLimitRaw === null || raw(p.availableWithdrawLimitRaw)) &&
    [
      'conditional_reference_address_quote',
      'censored_native_withdrawal_limit_unavailable',
    ].includes(p.nativeQuoteStatus) &&
    p.withdrawalLimitSubject === referenceSubject &&
    p.conditionalReferenceAddressQuote === true &&
    p.ownerCommitmentQualification === false &&
    typeof p.shutdown === 'boolean' &&
    raw(p.navRaw) &&
    raw(p.totalAssetsRaw) &&
    raw(p.idleUsdcDiagnosticRaw) &&
    p.idleUsdcIsTotalFundingUpperBound === false &&
    p.sourceImplementationEquivalence === false &&
    dense(p.runtimeIdentities, 4) &&
    p.runtimeIdentities.length === 4 &&
    p.runtimeIdentities.every((r) => !!r && address(r.address) && hash(r.runtimeKeccak256)) &&
    new Set(p.runtimeIdentities.map((r) => r.address)).size === p.runtimeIdentities.length &&
    p.runtimeIdentities[0].address === USD3_HISTORICAL_VAULT &&
    p.runtimeIdentities[3].address === USD3_HISTORICAL_USDC &&
    p.runtimeIdentities.every((r) => r.address !== USD3_REFERENCE_SUBJECT)
  )
}
/** Includes proxy/implementation/delegate/asset identities supplied by authenticated replay.
 * sourceClass and any caller-added regime labels carry no class authority. */
export function usd3HistoricalRuntimeFingerprint(p: Usd3JointHistoricalPoint) {
  return keccak256(
    stringToHex(
      JSON.stringify({
        route: USD3_HISTORICAL_ROUTE,
        destination: USD3_HISTORICAL_VAULT,
        asset: p.asset,
        assetDecimals: p.assetDecimals,
        shareDecimals: p.shareDecimals,
        getter: 'availableWithdrawLimit(address)',
        subject: p.withdrawalLimitSubject,
        fundingUnit: 'native_USDC',
        entitlement: 'previewRedeem_full_S_native_USDC',
        shutdown: p.shutdown,
        runtimes: p.runtimeIdentities,
      }),
    ),
  )
}
function unavailable(p: Usd3JointHistoricalPoint) {
  return p.availableWithdrawLimitRaw === null ||
    p.nativeQuoteStatus !== 'conditional_reference_address_quote'
    ? 'native_withdrawal_limit_unavailable'
    : p.shutdown
      ? 'shutdown_native_quote_unassessed'
      : null
}
const values = (p: Usd3JointHistoricalPoint) => ({
  fullEa: p.nativeEaRaw,
  nativeWithdrawLimit: p.availableWithdrawLimitRaw!,
})
const channels = ['fullEa', 'nativeWithdrawLimit'].map((key) => ({
  key,
  assetAddress: USD3_HISTORICAL_USDC,
  decimals: 6,
  unit: 'native_USDC',
  negativeHandling: 'reject_scenario' as const,
}))
type Engine = NonNullable<ReturnType<typeof buildConditionalTimeProcess>>
function distribution(heads: bigint[]) {
  const sorted = [...heads].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const sum = heads.reduce((a, b) => a + b, 0n),
    n = BigInt(heads.length)
  return {
    mean: {
      numeratorRaw: String(sum),
      denominator: heads.length,
      floorRaw: String(sum / n - (sum < 0n && sum % n !== 0n ? 1n : 0n)),
    },
    empiricalP10HeadroomRaw: String(sorted[Math.floor((sorted.length - 1) * 0.1)]),
    empiricalP90HeadroomRaw: String(sorted[Math.floor((sorted.length - 1) * 0.9)]),
    minimumHeadroomRaw: String(sorted[0]),
    maximumHeadroomRaw: String(sorted.at(-1)!),
    scenarioCount: heads.length,
  }
}
/** Offline retrospective joint NET-flow process. Approval is an integration gate, not authentication.
 * Acquisition clocks are preserved; internal historical availability is an explicit reconstruction assumption. */
export function buildUsd3JointHistoricalProcess(
  supplied: Usd3JointHistoricalInput,
  approve: Usd3JointHistoricalApprover,
) {
  try {
    if (!supplied || !dense(supplied.history, 129) || supplied.history.length < 2) return null
    const i = structuredClone(supplied)
    const referenceSubject = Object.hasOwn(i, 'withdrawalLimitSubject')
      ? i.withdrawalLimitSubject
      : USD3_REFERENCE_SUBJECT
    if (!address(referenceSubject)) return null
    if (
      i.mode !== 'retrospective_replay' ||
      i.routeKey !== USD3_HISTORICAL_ROUTE ||
      i.destination !== USD3_HISTORICAL_VAULT ||
      i.owner !== null ||
      !utc(i.issueAtUtc) ||
      !utc(i.knowledgeCutoffUtc) ||
      !raw(i.requestedRaw) ||
      i.requestedRaw === '0' ||
      !Number.isFinite(i.horizonHours) ||
      i.horizonHours <= 0 ||
      i.horizonHours > 8760 ||
      !Number.isSafeInteger(i.horizonHours * 3600000) ||
      !Number.isSafeInteger(i.maxHistoricalGapSeconds) ||
      i.maxHistoricalGapSeconds <= 0 ||
      !Number.isSafeInteger(i.maxHistoricalGapSeconds * 1000) ||
      !validPoint(i.baseline, i.issueAtUtc, referenceSubject) ||
      i.knowledgeCutoffUtc !== i.baseline.source.blockTime ||
      i.history.some(
        (p, n) =>
          !validPoint(p, i.issueAtUtc, referenceSubject) ||
          (n > 0 &&
            (Date.parse(p.source.blockTime) <= Date.parse(i.history[n - 1].source.blockTime) ||
              BigInt(p.source.blockNumber) <= BigInt(i.history[n - 1].source.blockNumber) ||
              p.source.blockHash === i.history[n - 1].source.blockHash)) ||
          (p.source.blockHash === i.baseline.source.blockHash &&
            (BigInt(p.source.blockNumber) !== BigInt(i.baseline.source.blockNumber) ||
              p.source.blockTime !== i.baseline.source.blockTime)),
      )
    )
      return null
    const source = Date.parse(i.baseline.source.blockTime),
      target = source + i.horizonHours * 3600000
    if (
      !Number.isSafeInteger(target) ||
      target > 8640000000000000 ||
      approve(structuredClone(i)) !== true
    )
      return null
    const regime = usd3HistoricalRuntimeFingerprint(i.baseline)
    const excludedIntervals: {
      fromIndex: number
      reason: string
      donorSources: Usd3JointHistoricalPoint['source'][]
    }[] = []
    const scenarios: (Engine['scenarios'][number] & {
      fromIndex: number
      donorSources: Usd3JointHistoricalPoint['source'][]
    })[] = []
    const baselineUnavailable = unavailable(i.baseline)
    for (let n = 0; n < i.history.length - 1; n++) {
      const a = i.history[n],
        b = i.history[n + 1],
        donorSources = [a.source, b.source]
      const dt = Date.parse(b.source.blockTime) - Date.parse(a.source.blockTime)
      const reason =
        baselineUnavailable ||
        unavailable(a) ||
        unavailable(b) ||
        (a.hypotheticalSharesRaw !== i.baseline.hypotheticalSharesRaw ||
        b.hypotheticalSharesRaw !== i.baseline.hypotheticalSharesRaw
          ? 'same_share_position_mismatch'
          : null) ||
        (usd3HistoricalRuntimeFingerprint(a) !== regime ||
        usd3HistoricalRuntimeFingerprint(b) !== regime
          ? 'native_runtime_class_mismatch'
          : null) ||
        (Date.parse(b.source.blockTime) >= source ||
        BigInt(b.source.blockNumber) >= BigInt(i.baseline.source.blockNumber)
          ? 'not_strictly_before_baseline'
          : null) ||
        (dt > i.maxHistoricalGapSeconds * 1000 ? 'historical_gap' : null)
      if (reason) {
        excludedIntervals.push({ fromIndex: n, reason, donorSources })
        continue
      }
      const provenance = (p: Usd3JointHistoricalPoint) =>
        `usd3_replay:${p.source.blockHash}:${p.acquiredAtUtc}`
      const process = buildConditionalTimeProcess(
        {
          channels,
          outputAsset: { assetAddress: USD3_HISTORICAL_USDC, decimals: 6 },
          measurementRule: 'joint_native_limit_and_full_same_S_entitlement_min_then_Q_once',
          observations: [a, b].map((p) => ({
            sourceAtUtc: p.source.blockTime,
            availableAtUtc: p.source.blockTime,
            regime,
            channels,
            valuesByChannel: values(p),
            provenanceRef: provenance(p),
          })),
          current: {
            sourceAtUtc: i.baseline.source.blockTime,
            readAtUtc: i.baseline.source.blockTime,
            regime,
            valuesByChannel: values(i.baseline),
            provenanceRef: provenance(i.baseline),
          },
          issueAtUtc: i.baseline.source.blockTime,
          requestedRaw: i.requestedRaw,
          horizonHours: i.horizonHours,
          maxHistoricalGapSeconds: i.maxHistoricalGapSeconds,
        },
        () => true,
        (state) => ({ availableRaw: state.nativeWithdrawLimit, entitlementRaw: state.fullEa }),
      )
      if (!process || process.scenarios.length !== 1) {
        excludedIntervals.push({ fromIndex: n, reason: 'joint_process_unavailable', donorSources })
        continue
      }
      scenarios.push({ ...process.scenarios[0], fromIndex: n, donorSources })
    }
    const usable = scenarios.filter((s) => s.status === 'conditional_path'),
      censored = scenarios.length - usable.length
    const complete = excludedIntervals.length === 0 && censored === 0 && usable.length > 0
    const targetSummary = complete
      ? distribution(usable.map((s) => BigInt(s.targetHeadroomRaw!)))
      : null
    const E = BigInt(i.baseline.nativeEaRaw),
      C = baselineUnavailable ? null : BigInt(i.baseline.availableWithdrawLimitRaw!)
    return {
      status: 'retrospective_conditional_reference_quote_joint_native_process' as const,
      input: i,
      ...(referenceSubject !== USD3_REFERENCE_SUBJECT
        ? {
            referenceSubject,
            referenceSubjectQualification: 'getter_reference_only' as const,
          }
        : {}),
      sourceAtUtc: i.baseline.source.blockTime,
      issueAtUtc: i.issueAtUtc,
      historicalIssueAtUtc: i.baseline.source.blockTime,
      knowledgeCutoffUtc: i.knowledgeCutoffUtc,
      targetAtUtc: new Date(target).toISOString(),
      acquiredAtUtc: i.baseline.acquiredAtUtc,
      retrospectiveAvailabilityAssumption: 'historical_chain_state_reconstructed_later' as const,
      reconstructedHistoricalAvailabilityIsLiveEvidence: false as const,
      regimeFingerprint: regime,
      channels,
      sharesRaw: i.baseline.hypotheticalSharesRaw,
      requestedRaw: i.requestedRaw,
      horizonHours: i.horizonHours,
      baselineMeasurement: {
        fullEaRaw: String(E),
        nativeWithdrawLimitRaw: C === null ? null : String(C),
        capacityRaw: C === null ? null : String(C < E ? C : E),
        headroomRaw: C === null ? null : String((C < E ? C : E) - BigInt(i.requestedRaw)),
        holderEntitlementShortfall: E < BigInt(i.requestedRaw),
        fundingShortfall: C === null ? null : C < BigInt(i.requestedRaw),
        reason: baselineUnavailable,
      },
      scenarios,
      excludedIntervals,
      counts: {
        attempted: i.history.length - 1,
        usable: usable.length,
        censored,
        excluded: excludedIntervals.length,
      },
      completeAttemptedIntervalCoverage: complete,
      targetSummary,
      descriptiveExpectedFlow: targetSummary?.mean ?? null,
      descriptiveStressedRange: targetSummary
        ? { minRaw: targetSummary.minimumHeadroomRaw, maxRaw: targetSummary.maximumHeadroomRaw }
        : null,
      owner: null,
      historicalOwnership: false,
      ownerCommitmentQualified: false,
      executionProven: false,
      calibrationProven: false,
      MRaw: null,
      sourceProofValidUntil: null,
      prospectiveValidated: false,
      originalProspectiveForecast: false,
      sourceImplementationEquivalence: false,
      holderExecutableExit: false,
      minedPayout: false,
      continuousPathKnown: false,
      calibratedProbability: false,
      confidenceInterval: false,
      assumptions: {
        jointConstantHistoricalNetFlowRate: true,
        feeAppliedAgain: false,
        sameSharesIndependentOfRequest: true,
        idleCashUsedAsFundingLimit: false,
        referenceSubjectMayDifferFromActualOwnerLimit: true,
      },
    }
  } catch {
    return null
  }
}
