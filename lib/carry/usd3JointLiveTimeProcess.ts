import { keccak256, stringToHex } from 'viem'

import { buildConditionalTimeProcess } from '../venueForecast/conditionalTimeProcess'
import {
  USD3_HISTORICAL_ROUTE,
  USD3_HISTORICAL_USDC,
  USD3_HISTORICAL_VAULT,
  type Usd3JointHistoricalPoint,
} from './usd3JointHistoricalProcess'

type Source = Usd3JointHistoricalPoint['source']
type Runtime = Usd3JointHistoricalPoint['runtimeIdentities']
export type Usd3JointLiveTimeInput = {
  routeKey: typeof USD3_HISTORICAL_ROUTE
  destination: typeof USD3_HISTORICAL_VAULT
  asset: typeof USD3_HISTORICAL_USDC
  assetDecimals: 6
  owner: string
  issueAtUtc: string
  knowledgeCutoffUtc: string
  requestedRaw: string
  horizonHours: 1 | 24 | 48 | 168
  maxHistoricalGapSeconds: 91800
  history: Usd3JointHistoricalPoint[]
  current: {
    source: Source
    readAtUtc: string
    sharesRaw: string
    shareDecimals: 6
    nativeEaRaw: string
    availableWithdrawLimitRaw: string | null
    shutdown: boolean | null
    runtimeIdentities: Runtime
    ownerMaxWithdrawRaw?: string | null
  }
}
export type Usd3JointLiveTimeApprover = (input: Usd3JointLiveTimeInput) => boolean
const MAX = (1n << 256n) - 1n,
  ZERO = '0x' + '0'.repeat(40)
const raw = (v: unknown): v is string =>
  typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) <= MAX
const utc = (v: unknown): v is string =>
  typeof v === 'string' &&
  Number.isSafeInteger(Date.parse(v)) &&
  new Date(Date.parse(v)).toISOString() === v
const address = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-f]{40}$/.test(v)
const hash = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v)
const block = (v: unknown): v is number | string =>
  typeof v === 'number' ? Number.isSafeInteger(v) && v > 0 : raw(v) && v !== '0'
const dense = (v: unknown, max: number): v is unknown[] =>
  Array.isArray(v) &&
  v.length <= max &&
  Object.keys(v).length === v.length &&
  Array.from({ length: v.length }, (_, n) => Object.hasOwn(v, n)).every(Boolean)
function sourceValid(s: Source) {
  return (
    !!s &&
    s.chainId === 1 &&
    s.finalized === true &&
    block(s.blockNumber) &&
    hash(s.blockHash) &&
    utc(s.blockTime) &&
    Date.parse(s.blockTime) % 1000 === 0
  )
}
function runtimeValid(r: Runtime) {
  return (
    dense(r, 4) &&
    r.length === 4 &&
    r.every((v) => !!v && address(v.address) && v.address !== ZERO && hash(v.runtimeKeccak256)) &&
    new Set(r.map((v) => v.address)).size === 4 &&
    r[0].address === USD3_HISTORICAL_VAULT &&
    r[3].address === USD3_HISTORICAL_USDC
  )
}
function fingerprint(runtimes: Runtime, owner: string, shutdown: boolean) {
  return keccak256(
    stringToHex(
      JSON.stringify({
        route: USD3_HISTORICAL_ROUTE,
        destination: USD3_HISTORICAL_VAULT,
        asset: USD3_HISTORICAL_USDC,
        assetDecimals: 6,
        shareDecimals: 6,
        owner,
        nativeLimitGetter: 'availableWithdrawLimit(address)',
        fullEaGetter: 'previewRedeem(full_S)',
        shutdown,
        fundingUnit: 'native_USDC',
        entitlementUnit: 'native_USDC',
        runtimes,
      }),
    ),
  )
}
function historyValid(p: Usd3JointHistoricalPoint, i: Usd3JointLiveTimeInput) {
  return (
    !!p &&
    sourceValid(p.source) &&
    utc(p.acquiredAtUtc) &&
    Date.parse(p.acquiredAtUtc) >= Date.parse(p.source.blockTime) &&
    Date.parse(p.acquiredAtUtc) <= Date.parse(i.knowledgeCutoffUtc) &&
    raw(p.hypotheticalSharesRaw) &&
    p.hypotheticalSharesRaw !== '0' &&
    p.shareDecimals === 6 &&
    p.asset === i.asset &&
    p.assetDecimals === 6 &&
    raw(p.nativeEaRaw) &&
    (p.availableWithdrawLimitRaw === null || raw(p.availableWithdrawLimitRaw)) &&
    [
      'conditional_reference_address_quote',
      'censored_native_withdrawal_limit_unavailable',
    ].includes(p.nativeQuoteStatus) &&
    address(p.withdrawalLimitSubject) &&
    p.withdrawalLimitSubject !== ZERO &&
    p.conditionalReferenceAddressQuote === true &&
    p.ownerCommitmentQualification === false &&
    typeof p.shutdown === 'boolean' &&
    runtimeValid(p.runtimeIdentities) &&
    p.sourceImplementationEquivalence === false &&
    p.idleUsdcIsTotalFundingUpperBound === false &&
    raw(p.idleUsdcDiagnosticRaw) &&
    raw(p.navRaw) &&
    raw(p.totalAssetsRaw)
  )
}
const channels = ['native_limit', 'full_entitlement'].map((key) => ({
  key,
  assetAddress: USD3_HISTORICAL_USDC,
  decimals: 6,
  unit: 'native_USDC',
  negativeHandling: 'reject_scenario' as const,
}))
type Engine = NonNullable<ReturnType<typeof buildConditionalTimeProcess>>
function summary(values: bigint[]) {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return {
    empiricalP10HeadroomRaw: String(sorted[Math.floor((sorted.length - 1) * 0.1)]),
    empiricalP90HeadroomRaw: String(sorted[Math.floor((sorted.length - 1) * 0.9)]),
    minimumHeadroomRaw: String(sorted[0]),
    maximumHeadroomRaw: String(sorted.at(-1)!),
    scenarioCount: values.length,
  }
}
/** Pure conditional math, never source authentication or a public issuer. The caller approves its exact private snapshot. */
export function buildUsd3JointLiveTimeProcess(
  supplied: Usd3JointLiveTimeInput,
  approve: Usd3JointLiveTimeApprover,
) {
  try {
    if (!supplied || !dense(supplied.history, 129) || supplied.history.length < 2) return null
    const i = structuredClone(supplied),
      c = i.current
    if (
      i.routeKey !== USD3_HISTORICAL_ROUTE ||
      i.destination !== USD3_HISTORICAL_VAULT ||
      i.asset !== USD3_HISTORICAL_USDC ||
      i.assetDecimals !== 6 ||
      !address(i.owner) ||
      i.owner === ZERO ||
      !utc(i.issueAtUtc) ||
      !utc(i.knowledgeCutoffUtc) ||
      !raw(i.requestedRaw) ||
      i.requestedRaw === '0' ||
      ![1, 24, 48, 168].includes(i.horizonHours) ||
      i.maxHistoricalGapSeconds !== 91800 ||
      !c ||
      !sourceValid(c.source) ||
      !utc(c.readAtUtc) ||
      !raw(c.sharesRaw) ||
      c.sharesRaw === '0' ||
      c.shareDecimals !== 6 ||
      !raw(c.nativeEaRaw) ||
      (c.availableWithdrawLimitRaw !== null && !raw(c.availableWithdrawLimitRaw)) ||
      (c.shutdown !== null && typeof c.shutdown !== 'boolean') ||
      !runtimeValid(c.runtimeIdentities) ||
      (c.ownerMaxWithdrawRaw !== undefined &&
        c.ownerMaxWithdrawRaw !== null &&
        !raw(c.ownerMaxWithdrawRaw)) ||
      i.history.some(
        (p, n) =>
          !historyValid(p, i) ||
          (n > 0 &&
            (Date.parse(p.source.blockTime) <= Date.parse(i.history[n - 1].source.blockTime) ||
              BigInt(p.source.blockNumber) <= BigInt(i.history[n - 1].source.blockNumber) ||
              p.source.blockHash === i.history[n - 1].source.blockHash)),
      )
    )
      return null
    const source = Date.parse(c.source.blockTime),
      read = Date.parse(c.readAtUtc),
      issue = Date.parse(i.issueAtUtc)
    const cutoff = Math.max(read, ...i.history.map((p) => Date.parse(p.acquiredAtUtc)))
    if (
      source > read ||
      read > issue ||
      issue - source > 1800000 ||
      Date.parse(i.knowledgeCutoffUtc) !== cutoff ||
      cutoff > issue ||
      i.history.some(
        (p) =>
          p.source.blockHash === c.source.blockHash &&
          (BigInt(p.source.blockNumber) !== BigInt(c.source.blockNumber) ||
            p.source.blockTime !== c.source.blockTime),
      ) ||
      approve(structuredClone(i)) !== true
    )
      return null
    if (c.availableWithdrawLimitRaw === null || c.shutdown !== false) return null
    const regime = fingerprint(c.runtimeIdentities, i.owner, c.shutdown)
    const excludedIntervals: { fromIndex: number; reason: string; donorSources: Source[] }[] = []
    const scenarios: (Engine['scenarios'][number] & {
      fromIndex: number
      donorSources: Source[]
    })[] = []
    const intervalInputs: { fromIndex: number; input: Engine['input'] }[] = []
    let first: Engine | null = null
    for (let n = 0; n < i.history.length - 1; n++) {
      const a = i.history[n],
        b = i.history[n + 1],
        donorSources = [a.source, b.source]
      const dt = Date.parse(b.source.blockTime) - Date.parse(a.source.blockTime)
      const reason =
        a.withdrawalLimitSubject !== i.owner || b.withdrawalLimitSubject !== i.owner
          ? 'native_limit_subject_mismatch'
          : a.hypotheticalSharesRaw !== c.sharesRaw || b.hypotheticalSharesRaw !== c.sharesRaw
            ? 'same_share_position_mismatch'
            : a.availableWithdrawLimitRaw === null ||
                b.availableWithdrawLimitRaw === null ||
                a.nativeQuoteStatus !== 'conditional_reference_address_quote' ||
                b.nativeQuoteStatus !== 'conditional_reference_address_quote'
              ? 'native_withdrawal_limit_unavailable'
              : fingerprint(a.runtimeIdentities, a.withdrawalLimitSubject, a.shutdown) !== regime ||
                  fingerprint(b.runtimeIdentities, b.withdrawalLimitSubject, b.shutdown) !== regime
                ? 'native_runtime_or_shutdown_regime_mismatch'
                : Date.parse(b.source.blockTime) >= source ||
                    BigInt(b.source.blockNumber) >= BigInt(c.source.blockNumber)
                  ? 'not_strictly_before_current_source'
                  : dt > i.maxHistoricalGapSeconds * 1000
                    ? 'historical_gap'
                    : null
      if (reason) {
        excludedIntervals.push({ fromIndex: n, reason, donorSources })
        continue
      }
      const engine = buildConditionalTimeProcess(
        {
          channels,
          observations: [a, b].map((p) => ({
            sourceAtUtc: p.source.blockTime,
            availableAtUtc: p.acquiredAtUtc,
            regime,
            channels,
            valuesByChannel: {
              native_limit: p.availableWithdrawLimitRaw!,
              full_entitlement: p.nativeEaRaw,
            },
            provenanceRef: `usd3_native_history:${p.source.blockHash}:${p.acquiredAtUtc}`,
          })),
          outputAsset: { assetAddress: i.asset, decimals: i.assetDecimals },
          measurementRule: 'joint_native_owner_limit_and_full_same_S_entitlement_min_then_Q_once',
          current: {
            sourceAtUtc: c.source.blockTime,
            readAtUtc: c.readAtUtc,
            regime,
            valuesByChannel: {
              native_limit: c.availableWithdrawLimitRaw,
              full_entitlement: c.nativeEaRaw,
            },
            provenanceRef: `usd3_native_current:${c.source.blockHash}:${c.readAtUtc}`,
          },
          issueAtUtc: i.issueAtUtc,
          requestedRaw: i.requestedRaw,
          horizonHours: i.horizonHours,
          maxHistoricalGapSeconds: i.maxHistoricalGapSeconds,
        },
        () => true,
        (state) => ({ availableRaw: state.native_limit, entitlementRaw: state.full_entitlement }),
      )
      if (!engine || engine.scenarios.length !== 1) {
        excludedIntervals.push({ fromIndex: n, reason: 'joint_process_unavailable', donorSources })
        continue
      }
      first ??= engine
      intervalInputs.push({ fromIndex: n, input: engine.input })
      scenarios.push({ ...engine.scenarios[0], fromIndex: n, donorSources })
    }
    const usable = scenarios.filter((s) => s.status === 'conditional_path'),
      censored = scenarios.length - usable.length
    const complete = usable.length > 0 && censored === 0 && excludedIntervals.length === 0
    const process = first
      ? {
          ...first,
          input: i,
          intervalInputs,
          scenarios,
          excludedIntervals,
          minimumHistoricalResolutionSeconds: Math.min(
            ...scenarios.map((s) => s.donor.durationSeconds),
          ),
          horizonFinerThanHistory:
            i.horizonHours * 3600 < Math.min(...scenarios.map((s) => s.donor.durationSeconds)),
          targetSummary: complete ? summary(usable.map((s) => BigInt(s.targetHeadroomRaw!))) : null,
        }
      : null
    const E = BigInt(c.nativeEaRaw),
      C = BigInt(c.availableWithdrawLimitRaw),
      capacity = C < E ? C : E
    return {
      status: 'conditional_usd3_native_joint_time_process' as const,
      input: i,
      process,
      issueAtUtc: i.issueAtUtc,
      sourceAtUtc: c.source.blockTime,
      readAtUtc: c.readAtUtc,
      knowledgeCutoffUtc: i.knowledgeCutoffUtc,
      targetAtUtc: new Date(issue + i.horizonHours * 3600000).toISOString(),
      sourceProofValidUntil: new Date(source + 1800000).toISOString(),
      regimeFingerprint: regime,
      requestedRaw: i.requestedRaw,
      sharesRaw: c.sharesRaw,
      owner: i.owner,
      horizonHours: i.horizonHours,
      currentMeasurement: {
        nativeLimitRaw: String(C),
        fullEntitlementRaw: String(E),
        capacityRaw: String(capacity),
        headroomRaw: String(capacity - BigInt(i.requestedRaw)),
      },
      ownerMaxWithdrawRaw: c.ownerMaxWithdrawRaw ?? null,
      ownerMaxWithdrawIsFutureFunding: false,
      counts: {
        attempted: i.history.length - 1,
        usable: usable.length,
        censored,
        excluded: excludedIntervals.length,
      },
      completeAttemptedIntervalCoverage: complete,
      excludedIntervals,
      MRaw: null,
      historicalOwnership: false,
      ownerCommitmentQualified: false,
      executionProven: false,
      calibrationProven: false,
      prospectiveValidated: false,
      forecastValidated: false,
      sourceImplementationEquivalence: false,
      holderExecutableExit: false,
      minedPayout: false,
      calibratedProbability: false,
      confidenceInterval: false,
      continuousPathKnown: false,
      assumptions: {
        jointConstantHistoricalNetFlowRate: true,
        sameSharesIndependentOfRequest: true,
        feeAppliedAgain: false,
        nativeLimitBoundToCurrentOwner: true,
        historicalAcquisitionClockPreserved: true,
      },
    }
  } catch {
    return null
  }
}
