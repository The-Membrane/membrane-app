// Offline reconstruction only. Importing neither reads files nor starts providers/jobs.
import { createHash } from 'node:crypto'
import {
  constants,
  openSync,
  closeSync,
  writeFileSync,
  fsyncSync,
  fstatSync,
  statfsSync,
} from 'node:fs'
import { resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import * as captureModule from './fluid-bridge-usdc-hypothetical-history-capture.mjs'
import * as oldModule from './fluid-usdt-bridge-capacity-history-capture.mjs'
import * as capacityModule from './carry-fluid-capacity-prongs.mjs'
import { readBoundedReceiptFile } from '../lib/boundedLocalReceiptFile.mjs'
import * as modelModule from '../../lib/carry/fluidBridgeUsdcJointHistoricalProcess.ts'
import type {
  FluidBridgeUsdcFrame,
  FluidBridgeUsdcJointInput,
} from '../../lib/carry/fluidBridgeUsdcJointHistoricalProcess.ts'

const pick = (m: unknown, k: string): any => {
  const v = m as Record<string, any>
  return v[k] ?? v.default?.[k]
}
const build = pick(
  modelModule,
  'buildFluidBridgeUsdcJointHistoricalProcess',
) as typeof modelModule.buildFluidBridgeUsdcJointHistoricalProcess
const prongs = pick(
  modelModule,
  'FLUID_BRIDGE_USDC_PRONGS',
) as typeof modelModule.FLUID_BRIDGE_USDC_PRONGS
const USDC = pick(modelModule, 'FLUID_BRIDGE_USDC') as typeof modelModule.FLUID_BRIDGE_USDC
const reports = new WeakSet<object>()
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex')
function check(v: unknown, code: string): asserts v {
  if (!v) throw Error('fluid_usdc_backtest_' + code)
}
const utc = (v: string) =>
  Number.isSafeInteger(Date.parse(v)) && new Date(Date.parse(v)).toISOString() === v
const freeze = <T,>(v: T): T => {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze)
    Object.freeze(v)
  }
  return v
}
const seal = <T extends object>(body: T) => ({ ...body, sha256: sha(JSON.stringify(body)) })
const MAX = (1n << 256n) - 1n
export const FLUID_USDC_BACKTEST_FOLDS = freeze([
  { id: 'sep30_to_oct1', training: [0, 1], baseline: 2, outcome: 3 },
  { id: 'oct1_to_oct2_031535', training: [0, 1, 2], baseline: 3, outcome: 4 },
  { id: 'oct2_031535_to_040647', training: [0, 1, 2, 3], baseline: 4, outcome: 5 },
])
const raw = (v: string) => /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) <= MAX
const record = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const dense = (v: unknown, n: number) =>
  Array.isArray(v) &&
  v.length === n &&
  Object.keys(v).length === n &&
  Array.from({ length: n }, (_, j) => Object.hasOwn(v, j)).every(Boolean)
function rejectMalformedCaptureBeforeReads(value: unknown) {
  try {
    const wanted = [
      'schema',
      'plan',
      'planSha256',
      'startedAtUtc',
      'availableAtUtc',
      'elapsedMs',
      'physicalStarts',
      'pendingSettlements',
      'failure',
      'ledger',
      'protocolCaptures',
      'wrapperOrigins',
      'positionKind',
      'owner',
      'historicalOwnership',
      'execution',
      'minedPayout',
      'sha256',
    ]
    check(
      record(value) &&
        Object.keys(value).length === wanted.length &&
        wanted.every((k) => Object.hasOwn(value, k)),
      'capture_shape',
    )
    check(
      value.schema === 'fluid_bridge_usdc_hypothetical_history_capture_v1' &&
        record(value.plan) &&
        value.plan.schema === 'fluid_bridge_usdc_hypothetical_history_plan_v1' &&
        value.positionKind === 'hypothetical_fixed_shares_not_owner' &&
        value.owner === null &&
        value.historicalOwnership === false &&
        value.execution === 'unassessed' &&
        value.minedPayout === false &&
        value.physicalStarts === 208 &&
        value.pendingSettlements === 0 &&
        value.failure === null &&
        Number.isFinite(value.elapsedMs) &&
        value.elapsedMs >= 0 &&
        value.elapsedMs <= 120000 &&
        utc(value.startedAtUtc) &&
        utc(value.availableAtUtc) &&
        Date.parse(value.availableAtUtc) >= Date.parse(value.startedAtUtc) &&
        dense(value.ledger, 208) &&
        dense(value.protocolCaptures, 4) &&
        dense(value.wrapperOrigins, 2) &&
        /^[a-f0-9]{64}$/.test(value.sha256) &&
        /^[a-f0-9]{64}$/.test(value.planSha256),
      'capture_facts',
    )
    const { sha256, ...body } = value
    const serialized = JSON.stringify(body)
    check(
      Buffer.byteLength(serialized) <= 8 * 1024 * 1024 &&
        sha(serialized) === sha256 &&
        sha(JSON.stringify(value.plan)) === value.planSha256,
      'capture_seal',
    )
  } catch {
    throw Error('fluid_usdc_backtest_capture_transport_invalid')
  }
}
function requireNativeFrame(f: FluidBridgeUsdcFrame) {
  check(
    record(f) &&
      record(f.source) &&
      f.source.chainId === 1 &&
      typeof f.source.blockNumber === 'string' &&
      raw(f.source.blockNumber) &&
      BigInt(f.source.blockNumber) > 0n &&
      BigInt(f.source.blockNumber) <= BigInt(Number.MAX_SAFE_INTEGER) &&
      /^0x[a-f0-9]{64}$/.test(f.source.blockHash) &&
      utc(f.source.blockTime) &&
      Date.parse(f.source.blockTime) % 1000 === 0 &&
      typeof f.holderSharesRaw === 'string' &&
      raw(f.holderSharesRaw) &&
      BigInt(f.holderSharesRaw) > 0n &&
      Number.isInteger(f.shareDecimals) &&
      f.shareDecimals >= 0 &&
      f.shareDecimals <= 36 &&
      record(f.nativeProngs) &&
      Object.keys(f.nativeProngs).length === 5 &&
      prongs.every(
        (k) =>
          Object.hasOwn(f.nativeProngs, k) &&
          typeof f.nativeProngs[k] === 'string' &&
          raw(f.nativeProngs[k]),
      ) &&
      typeof f.fullHolderNetUsdcRaw === 'string' &&
      raw(f.fullHolderNetUsdcRaw) &&
      record(f.runtimeCodeHashes) &&
      Object.keys(f.runtimeCodeHashes).length > 0 &&
      Object.keys(f.runtimeCodeHashes).length <= 16 &&
      Object.entries(f.runtimeCodeHashes).every(
        ([k, v]) =>
          /^0x[a-f0-9]{40}$/.test(k) && typeof v === 'string' && /^0x[a-f0-9]{64}$/.test(v),
      ) &&
      Number.isInteger(f.withdrawalFeeBps) &&
      f.withdrawalFeeBps >= 0 &&
      f.withdrawalFeeBps < 10000 &&
      typeof f.paused === 'boolean' &&
      utc(f.acquiredAtUtc) &&
      utc(f.availableAtUtc) &&
      Date.parse(f.acquiredAtUtc) >= Date.parse(f.source.blockTime) &&
      f.provenanceKind === 'native_hypothetical_shares' &&
      f.owner === null &&
      f.historicalOwnership === false &&
      !Object.hasOwn(f, 'originalIssue'),
    'native_frame_facts',
  )
}
function measurement(f: FluidBridgeUsdcFrame, Q: string) {
  check(
    raw(Q) && raw(f.fullHolderNetUsdcRaw) && prongs.every((k) => raw(f.nativeProngs[k])),
    'measurement_raw',
  )
  const gross = prongs.reduce(
    (v, k) => (BigInt(f.nativeProngs[k]) < v ? BigInt(f.nativeProngs[k]) : v),
    MAX,
  )
  check(
    Number.isInteger(f.withdrawalFeeBps) && f.withdrawalFeeBps >= 0 && f.withdrawalFeeBps < 10000,
    'measurement_fee',
  )
  const product = gross * BigInt(10000 - f.withdrawalFeeBps)
  check(product <= MAX, 'measurement_overflow')
  const net = product / 10000n,
    Ea = BigInt(f.fullHolderNetUsdcRaw),
    available = net < Ea ? net : Ea
  return {
    fundingNetRaw: String(net),
    fullEaRaw: String(Ea),
    availableRaw: String(available),
    headroomRaw: String(available - BigInt(Q)),
  }
}
function sameBinding(a: FluidBridgeUsdcFrame, b: FluidBridgeUsdcFrame) {
  return (
    a.owner === null &&
    b.owner === null &&
    a.provenanceKind === 'native_hypothetical_shares' &&
    b.provenanceKind === 'native_hypothetical_shares' &&
    a.historicalOwnership === false &&
    b.historicalOwnership === false &&
    a.holderSharesRaw === b.holderSharesRaw &&
    a.shareDecimals === b.shareDecimals &&
    a.asset === b.asset &&
    a.assetDecimals === b.assetDecimals &&
    a.fundingUnit === b.fundingUnit &&
    a.entitlementUnit === b.entitlementUnit &&
    a.withdrawalFeeBps === b.withdrawalFeeBps &&
    a.regime === b.regime &&
    a.paused === false &&
    b.paused === false &&
    isDeepStrictEqual(a.runtimeCodeHashes, b.runtimeCodeHashes)
  )
}
/** Pure scoring controls are not capture authentication; the report builder authenticates both inputs. */
export function scoreFluidBridgeUsdcHistoricalFold({
  id,
  training,
  baseline,
  outcome,
  reconstructedAtUtc,
}: {
  id: string
  training: FluidBridgeUsdcFrame[]
  baseline: FluidBridgeUsdcFrame
  outcome: FluidBridgeUsdcFrame
  reconstructedAtUtc: string
}) {
  check(
    utc(reconstructedAtUtc) &&
      training.length >= 2 &&
      training.length <= 129 &&
      Object.keys(training).length === training.length &&
      Array.from({ length: training.length }, (_, n) => Object.hasOwn(training, n)).every(Boolean),
    'fold_shape',
  )
  for (const f of [baseline, outcome, ...training]) requireNativeFrame(f)
  const sourceMs = Date.parse(baseline.source.blockTime),
    targetMs = Date.parse(outcome.source.blockTime)
  check(
    utc(baseline.source.blockTime) &&
      utc(outcome.source.blockTime) &&
      targetMs > sourceMs &&
      training.every(
        (f) =>
          Date.parse(f.source.blockTime) < sourceMs &&
          BigInt(f.source.blockNumber) < BigInt(baseline.source.blockNumber),
      ),
    'chronological_training',
  )
  check(
    [baseline, outcome, ...training].every(
      (f) =>
        utc(f.acquiredAtUtc) &&
        utc(f.availableAtUtc) &&
        Date.parse(f.acquiredAtUtc) <= Date.parse(reconstructedAtUtc) &&
        f.availableAtUtc === f.acquiredAtUtc,
    ),
    'reconstruction_clock',
  )
  const elapsedMs = targetMs - sourceMs
  check(Number.isSafeInteger(elapsedMs) && elapsedMs % 1000 === 0, 'elapsed')
  const baselineEa = BigInt(baseline.fullHolderNetUsdcRaw)
  const sizes = [
    { label: '90pct_baseline_Ea', Q: (baselineEa * 90n) / 100n },
    { label: '99pct_baseline_Ea', Q: (baselineEa * 99n) / 100n },
    { label: '100pct_baseline_Ea', Q: baselineEa },
    { label: 'baseline_Ea_plus_one_raw', Q: baselineEa + 1n },
  ]
  const outcomeExclusion = sameBinding(baseline, outcome)
    ? null
    : 'outcome_fixed_S_units_runtime_fee_or_regime_changed'
  const cases = sizes.map((size) => {
    const Q = String(size.Q)
    const input: FluidBridgeUsdcJointInput = {
      mode: 'retrospective_replay',
      retrospectiveAvailabilityAssumption: 'historical_chain_state_reconstructed_later',
      routeKey: 'USDC → FluidBridgeAggregatorProxy [USDC]',
      destination: '0x273da948aca9261043fbdb2a857bc255ecc29012',
      owner: null,
      issueAtUtc: reconstructedAtUtc,
      knowledgeCutoffUtc: baseline.source.blockTime,
      horizonHours: elapsedMs / 3600000,
      requestedRaw: Q,
      history: structuredClone(training),
      baseline: structuredClone(baseline),
      maxHistoricalGapSeconds: 26 * 3600,
    }
    // Exact callback agreement gates already authenticated canonical frame selection, not source authority.
    const approved = structuredClone(input),
      model = build(input, (_kind, candidate) => isDeepStrictEqual(candidate, approved))
    check(model && model.targetAtUtc === outcome.source.blockTime, 'model_reconstruction')
    const actual = outcomeExclusion ? null : measurement(outcome, Q),
      persistence = measurement(baseline, Q)
    const headroomMean = model.descriptiveExpectedFlow?.floorRaw ?? null
    const fundingComplete = headroomMean !== null && actual !== null
    const fundingTargets = fundingComplete
      ? model.scenarios.map((s) => BigInt(s.targetMeasurement!.fundingNetRaw))
      : []
    const fundingTotal = fundingTargets.reduce((sum, v) => sum + v, 0n)
    const fundingExact = fundingComplete
      ? {
          numeratorRaw: String(fundingTotal),
          denominator: String(fundingTargets.length),
          floorRaw: String(fundingTotal / BigInt(fundingTargets.length)),
        }
      : null
    const binders = new Set<'full_entitlement' | 'native_funding'>()
    for (const m of [
      persistence,
      ...(actual ? [actual] : []),
      ...model.scenarios.flatMap((s) => s.points.map((p) => p.measurement)),
    ]) {
      if (BigInt(m.fullEaRaw) <= BigInt(m.fundingNetRaw)) binders.add('full_entitlement')
      if (BigInt(m.fundingNetRaw) <= BigInt(m.fullEaRaw)) binders.add('native_funding')
    }
    const bindingScope = binders.size === 1 ? [...binders][0] : 'mixed'
    const predicted =
      headroomMean === null
        ? null
        : {
            availableMeanRaw: String(BigInt(headroomMean) + size.Q),
            headroomMeanRaw: headroomMean,
            headroomMeanExact: model.descriptiveExpectedFlow,
            availableRange: {
              minRaw: String(BigInt(model.descriptiveStressedRange!.minRaw) + size.Q),
              maxRaw: String(BigInt(model.descriptiveStressedRange!.maxRaw) + size.Q),
            },
            headroomRange: model.descriptiveStressedRange,
            fundingNetMeanRaw: fundingExact?.floorRaw ?? null,
            fundingNetMeanExact: fundingExact,
            fundingNetRange: fundingComplete
              ? {
                  minRaw: String(fundingTargets.reduce((a, b) => (a < b ? a : b))),
                  maxRaw: String(fundingTargets.reduce((a, b) => (a > b ? a : b))),
                }
              : null,
          }
    const sourceShort = BigInt(persistence.headroomRaw) < 0n,
      targetShort = actual ? BigInt(actual.headroomRaw) < 0n : null
    return {
      label: size.label,
      requestedRaw: Q,
      questionKind: 'hypothetical_research_size_not_original_user_Q',
      counts: model.counts,
      predicted,
      actual,
      outcomeExclusion,
      persistence,
      bindingScope,
      fundingForecastMinusObservedRaw:
        fundingExact && actual
          ? String(BigInt(fundingExact.floorRaw) - BigInt(actual.fundingNetRaw))
          : null,
      fundingPersistenceMinusObservedRaw:
        fundingComplete && actual
          ? String(BigInt(persistence.fundingNetRaw) - BigInt(actual.fundingNetRaw))
          : null,
      forecastMinusObservedRaw:
        predicted && actual
          ? String(BigInt(predicted.availableMeanRaw) - BigInt(actual.availableRaw))
          : null,
      headroomForecastMinusObservedRaw:
        predicted && actual
          ? String(BigInt(predicted.headroomMeanRaw) - BigInt(actual.headroomRaw))
          : null,
      persistenceMinusObservedRaw: actual
        ? String(BigInt(persistence.availableRaw) - BigInt(actual.availableRaw))
        : null,
      excludedIntervals: model.excludedIntervals,
      sampledPathKind: 'conditional_NET_projection_not_observed_intervening_path',
      sampledScenarios: model.scenarios.map((s) => ({
        fromIndex: s.fromIndex,
        status: s.status,
        reason: s.reason,
        donorSources: s.donorSources,
        jointNetDeltaRaw: s.jointNetDeltaRaw,
        maximumCheckpointGapMs: s.maximumCheckpointGapMs,
        sampledLossRuns: s.sampledLossRuns,
        points: s.points,
      })),
      observedEndpointBrackets: {
        loss:
          targetShort === true && !sourceShort
            ? { after: baseline.source.blockTime, by: outcome.source.blockTime }
            : null,
        recovery:
          targetShort === false && sourceShort
            ? { after: baseline.source.blockTime, by: outcome.source.blockTime }
            : null,
        leftCensored: sourceShort,
        rightCensored: targetShort,
        interveningAvailabilityKnown: false,
      },
      complete: predicted !== null && actual !== null,
      MRaw: null,
    }
  })
  return {
    id,
    reconstructionMode: 'retrospective_replay',
    reconstructedAtUtc,
    headerCutoffUtc: baseline.source.blockTime,
    baselineSource: baseline.source,
    outcomeSource: outcome.source,
    elapsedSeconds: elapsedMs / 1000,
    donorIntervalCount: training.length - 1,
    trainingSources: training.map((f) => f.source),
    trainingGapsSeconds: training
      .slice(1)
      .map(
        (f, n) =>
          (Date.parse(f.source.blockTime) - Date.parse(training[n].source.blockTime)) / 1000,
      ),
    maximumAllowedTrainingGapSeconds: 26 * 3600,
    correlatedQScenarioCount: cases.length,
    cases,
    complete: cases.every((c) => c.complete),
    betweenNativeOutcomeEndpointsKnown: false,
    MRaw: null,
  }
}

/** Pure chronology controls only; callers cannot use this helper to issue authenticated reports. */
export function fluidBridgeUsdcHistoricalFoldDefinitions(
  frames: FluidBridgeUsdcFrame[],
  reconstructedAtUtc: string,
) {
  check(
    Array.isArray(frames) &&
      Object.getPrototypeOf(frames) === Array.prototype &&
      Object.getOwnPropertySymbols(frames).length === 0 &&
      Object.getOwnPropertyNames(frames).length === frames.length + 1 &&
      dense(frames, frames.length) &&
      (frames.length === 6 || frames.length === 10) &&
      utc(reconstructedAtUtc),
    'joined_frame_shape',
  )
  frames.forEach((f, n) => {
    requireNativeFrame(f)
    check(
      f.asset === USDC &&
        f.assetDecimals === 6 &&
        f.shareDecimals === 18 &&
        f.fundingUnit === 'gross_native_USDC' &&
        f.entitlementUnit === 'net_native_USDC' &&
        sameBinding(frames[0], f) &&
        Date.parse(f.availableAtUtc) >= Date.parse(f.acquiredAtUtc) &&
        Date.parse(f.availableAtUtc) <= Date.parse(reconstructedAtUtc),
      'joined_frame_binding',
    )
    check(
      !frames.slice(0, n).some((p) => p.source.blockHash === f.source.blockHash) &&
        (n === 0 ||
          (BigInt(f.source.blockNumber) > BigInt(frames[n - 1].source.blockNumber) &&
            Date.parse(f.source.blockTime) > Date.parse(frames[n - 1].source.blockTime))),
      'joined_header_chronology',
    )
  })
  return freeze(
    Array.from({ length: frames.length - 3 }, (_, n) => {
      const baseline = n + 2
      return {
        id:
          'native_' +
          frames[baseline].source.blockTime +
          '_to_' +
          frames[baseline + 1].source.blockTime,
        training: Array.from({ length: baseline }, (_, j) => j),
        baseline,
        outcome: baseline + 1,
      }
    }),
  )
}
function replaySelectedCapture(receipt: unknown, captureText: string | null, root: string) {
  rejectMalformedCaptureBeforeReads(receipt)
  const value = receipt as any
  check(dense(value.plan.anchors, 4), 'capture_anchor_shape')
  // Only authenticated cash indices are caller-selected. Every native pin/header is rederived.
  const cashIndices = value.plan.anchors.map((a: any) => a.cashIndex)
  if (captureText !== null)
    check(
      typeof captureText === 'string' &&
        Buffer.byteLength(captureText) <= 8 * 1024 * 1024 &&
        isDeepStrictEqual(JSON.parse(captureText), receipt),
      'new_raw_text_join',
    )
  const plan = pick(
    captureModule,
    'prepareFluidBridgeUsdcHypotheticalHistoryPlan',
  )({ root, cashIndices })
  const replay = pick(captureModule, 'replayFluidBridgeUsdcHypotheticalHistory')(receipt, plan)
  return { plan, replay, receipt, captureText }
}
/** Each native receipt authenticates independently using its private prepared plan in this realm. */
export function buildFluidBridgeUsdcHistoricalHolderBacktest(
  captureReceipt: unknown,
  reconstructedAtUtc: string,
  options: {
    root?: string
    captureText?: string | null
    additionalCapture?: { receipt: unknown; captureText: string }
  } = {},
) {
  check(
    record(options) &&
      Object.getPrototypeOf(options) === Object.prototype &&
      Object.getOwnPropertySymbols(options).length === 0 &&
      Object.getOwnPropertyNames(options).every((k) =>
        ['root', 'captureText', 'additionalCapture'].includes(k),
      ) &&
      Object.values(Object.getOwnPropertyDescriptors(options)).every((d) =>
        Object.hasOwn(d, 'value'),
      ),
    'options_shape',
  )
  const { root = process.cwd(), captureText = null, additionalCapture } = options
  check(typeof root === 'string' && root.length > 0, 'root_shape')
  if (Object.hasOwn(options, 'additionalCapture')) {
    check(
      record(additionalCapture) &&
        Object.getPrototypeOf(additionalCapture) === Object.prototype &&
        Object.getOwnPropertySymbols(additionalCapture).length === 0 &&
        Object.getOwnPropertyNames(additionalCapture).length === 2 &&
        Object.hasOwn(additionalCapture, 'receipt') &&
        Object.hasOwn(additionalCapture, 'captureText') &&
        Object.values(Object.getOwnPropertyDescriptors(additionalCapture)).every((d) =>
          Object.hasOwn(d, 'value'),
        ) &&
        typeof additionalCapture.captureText === 'string' &&
        Buffer.byteLength(additionalCapture.captureText) <= 8 * 1024 * 1024,
      'additional_capture_shape',
    )
    rejectMalformedCaptureBeforeReads(additionalCapture.receipt)
  }
  const primary = replaySelectedCapture(captureReceipt, captureText, root)
  const captures = [
    primary,
    ...(additionalCapture
      ? [replaySelectedCapture(additionalCapture.receipt, additionalCapture.captureText, root)]
      : []),
  ]
  const { plan, replay: current } = primary
  check(
    captures.every(
      (c) =>
        isDeepStrictEqual(c.plan.runtimePins, plan.runtimePins) &&
        isDeepStrictEqual(c.plan.subject, plan.subject) &&
        isDeepStrictEqual(c.plan.retainedNativeProvenance, plan.retainedNativeProvenance),
    ),
    'capture_runtime_subject_join',
  )
  const pin = plan.retainedNativeProvenance.input
  const text = readBoundedReceiptFile(resolve(root, pin.path), {
    maxFileBytes: pin.bytes,
    maxTotalBytes: pin.bytes,
    totalBytes: 0,
  })
  check(Buffer.byteLength(text) === pin.bytes && sha(text) === pin.sha256, 'old_raw_file_pin')
  const oldRaw = JSON.parse(text),
    { sha256, ...oldBody } = oldRaw
  check(sha256 === pin.bodySha256 && sha(JSON.stringify(oldBody)) === sha256, 'old_raw_body_pin')
  const oldPlan = pick(oldModule, 'prepareFluidBridgeCapacityHistoryPlan')({ root })
  const retained = pick(oldModule, 'replayFluidBridgeCapacityHistory')(oldRaw, oldPlan)
  check(
    current.points.length === 4 &&
      retained.points.length === 2 &&
      utc(reconstructedAtUtc) &&
      captures.every(
        (c) =>
          c.replay.points.length === 4 &&
          Date.parse(reconstructedAtUtc) >= Date.parse(c.replay.availableAtUtc),
      ) &&
      Date.parse(reconstructedAtUtc) >= Date.parse(retained.availableAtUtc),
    'acquired_before_reconstruction',
  )
  const runtimeCodeHashes = Object.fromEntries([
    ...plan.runtimePins.underlyingIdentities.map((v: any) => [v.address, v.codeHash]),
    [plan.subject.destination, plan.runtimePins.proxyKeccak256],
    [plan.runtimePins.implementation, plan.runtimePins.implementationKeccak256],
  ]) as Record<string, string>
  const base = {
    holderSharesRaw: plan.subject.sharesRaw,
    shareDecimals: 18,
    asset: USDC,
    assetDecimals: 6 as const,
    fundingUnit: 'gross_native_USDC' as const,
    entitlementUnit: 'net_native_USDC' as const,
    runtimeCodeHashes,
    regime: 'lite_runtime_' + sha(JSON.stringify(runtimeCodeHashes)) + '_fee5_unpaused',
    paused: false as const,
    withdrawalFeeBps: 5,
    owner: null,
    historicalOwnership: false as const,
    provenanceKind: 'native_hypothetical_shares' as const,
  }
  const frames: FluidBridgeUsdcFrame[] = captures.flatMap((capture) =>
    capture.replay.points.map((p: any, n: number) => {
      check(
        p.hypotheticalSharesRaw === base.holderSharesRaw &&
          p.shareDecimals === 18 &&
          p.asset === USDC &&
          p.assetDecimals === 6 &&
          p.feeBps === 5 &&
          p.paused === false &&
          isDeepStrictEqual(p.runtimeIdentities, capture.plan.runtimePins.underlyingIdentities),
        'current_native_bindings',
      )
      return {
        ...base,
        source: {
          chainId: 1,
          blockNumber: String(p.source.blockNumber),
          blockHash: p.source.blockHash,
          blockTime: p.source.blockTime,
        },
        acquiredAtUtc: capture.replay.availableAtUtc,
        availableAtUtc: capture.replay.availableAtUtc,
        provenanceRef: 'native_hypothetical_capture:' + capture.replay.rawCaptureSha256 + ':' + n,
        fullHolderNetUsdcRaw: p.fullNetEaRaw,
        nativeProngs: p.nativeProngs,
      }
    }),
  )
  retained.points.forEach((p: any, n: number) => {
    check(
      p.holderSharesRaw === base.holderSharesRaw &&
        p.feeBpsRaw === '5' &&
        p.withdrawalsPaused === false &&
        p.proxyCodeKeccak256 === plan.runtimePins.proxyKeccak256 &&
        p.implementationCodeKeccak256 === plan.runtimePins.implementationKeccak256 &&
        p.fusdcCodeKeccak256 === runtimeCodeHashes[plan.protocolSubject.destination] &&
        p.underlyingProtocolProngs,
      'retained_native_bindings',
    )
    const underlying = pick(capacityModule, 'replayFluidCapacityProngs')(
      oldRaw.protocolCaptures[n],
      plan.protocolSubject,
      oldRaw.protocolCaptures[n].source,
    )
    check(
      underlying.origins.every((o: any) =>
        isDeepStrictEqual(o.identities, plan.runtimePins.underlyingIdentities),
      ),
      'retained_underlying_runtime',
    )
    const q = p.underlyingProtocolProngs
    frames.push({
      ...base,
      source: p.source,
      acquiredAtUtc: retained.availableAtUtc,
      availableAtUtc: retained.availableAtUtc,
      provenanceRef: 'retained_original_usdt_native:' + oldRaw.sha256 + ':' + n,
      fullHolderNetUsdcRaw: p.fullPreviewRedeemNetFeeRaw,
      nativeProngs: {
        bridgeFunding: p.fusdcMaxWithdrawBridgeRaw,
        bankCash: q.sharedLiquidityCashRaw,
        bankSupply: q.fTokenReportedSupplyRaw,
        bankWithdrawableUntilLimit: q.withdrawableUntilLimitRaw,
        bankResolverWithdrawable: q.resolverReportedWithdrawableRaw,
      },
    })
  })
  const issueBudget = { maxFileBytes: 16384, maxTotalBytes: 32768, totalBytes: 0 }
  const originalIssues = oldPlan.originalIssueAnchors.map((a: any) => {
    const issueText = readBoundedReceiptFile(
        resolve(
          root,
          'data/research/venue-signals/carry-fluid-bridge-usdt-holder-v1/issues',
          a.issueFile,
        ),
        issueBudget,
      ),
      issue = JSON.parse(issueText)
    check(sha(issueText) === a.fileSha256 && issue.sha256 === a.bodySha256, 'original_issue_pin')
    return {
      anchor: a,
      routeKey: issue.routeKey,
      destination: issue.destination,
      holder: issue.holder,
      asset: issue.asset,
      finalAsset: issue.finalAsset,
      issuedAtUtc: issue.issuedAtUtc,
      qRaw: issue.qRaw,
      baselineQScenariosRaw: issue.baseline.cases.map((c: any) => c.qRaw),
      targets: issue.targets,
      neverReinterpretedAsUsdcOriginalIssue: true,
    }
  })
  const nativeFoldDefinitions = fluidBridgeUsdcHistoricalFoldDefinitions(frames, reconstructedAtUtc)
  const isLegacyDefault =
    additionalCapture === undefined &&
    isDeepStrictEqual(
      plan.anchors.map((a: any) => a.cashIndex),
      [115, 116, 117, 118],
    )
  const foldDefinitions = isLegacyDefault ? FLUID_USDC_BACKTEST_FOLDS : nativeFoldDefinitions
  const folds = foldDefinitions.map((f) =>
    scoreFluidBridgeUsdcHistoricalFold({
      id: f.id,
      training: f.training.map((n) => frames[n]),
      baseline: frames[f.baseline],
      outcome: frames[f.outcome],
      reconstructedAtUtc,
    }),
  )
  const report = freeze(
    seal({
      schema: 'fluid_bridge_usdc_historical_hypothetical_same_S_backtest_v1',
      status: 'retrospective_conditional_native_getter_backtest',
      reconstructedAtUtc,
      scope: {
        trainingFoldCount: folds.length,
        correlatedQScenariosPerFold: 4,
        correlatedQScenarioCount: folds.reduce((n, f) => n + f.cases.length, 0),
        independentSampleCountNotInferred: true,
        holderSharesRaw: base.holderSharesRaw,
        historicalOwnership: false,
        owner: null,
        originalProspectiveForecast: false,
        calibratedProbability: false,
        holderExecutableExit: false,
        minedPayout: false,
        forecastValidated: false,
        MRaw: null,
      },
      lineage: {
        newCaptureSha256: current.rawCaptureSha256,
        newCaptureCanonicalSha256: sha(JSON.stringify(captureReceipt)),
        newRawFileSha256: captureText === null ? null : sha(captureText),
        newRawFileBytes: captureText === null ? null : Buffer.byteLength(captureText),
        hypotheticalCaptures: captures.map((c) => ({
          captureBodySha256: c.replay.rawCaptureSha256,
          canonicalSha256: sha(JSON.stringify(c.receipt)),
          fileSha256: c.captureText === null ? null : sha(c.captureText),
          fileBytes: c.captureText === null ? null : Buffer.byteLength(c.captureText),
          acquiredAtUtc: c.replay.availableAtUtc,
          cashIndices: c.plan.anchors.map((a: any) => a.cashIndex),
          frameProvenance: c.replay.points.map((_: any, n: number) => ({
            pointIndex: n,
            cashIndex: c.plan.anchors[n].cashIndex,
            source: c.replay.points[n].source,
            provenanceRef: 'native_hypothetical_capture:' + c.replay.rawCaptureSha256 + ':' + n,
          })),
        })),
        retainedNativePin: pin,
        retainedOriginalSubject: oldRaw.plan.subject,
        originalIssues,
        originalTransportRetagged: false,
        newAcquiredAtUtc: current.availableAtUtc,
        retainedAcquiredAtUtc: retained.availableAtUtc,
        bothNativeReceiptsIndependentlyReplayed: true,
      },
      frames,
      folds,
      aggregate: folds.every((f) => f.complete)
        ? {
            completedTrainingFolds: folds.length,
            correlatedQScenarios: folds.reduce((n, f) => n + f.cases.length, 0),
            calibratedProbability: false,
          }
        : null,
      betweenNativeOutcomeEndpointsKnown: false,
      empiricalRecoveryDurationDistribution: null,
    }),
  )
  reports.add(report)
  return report
}

export function writeFluidBridgeUsdcHistoricalHolderBacktest(
  outputPath: string,
  report: ReturnType<typeof buildFluidBridgeUsdcHistoricalHolderBacktest>,
) {
  check(reports.has(report), 'private_report_required')
  const { sha256, ...body } = report
  check(sha(JSON.stringify(body)) === sha256, 'report_seal')
  const text = JSON.stringify(report, null, 2) + '\n',
    bytes = Buffer.byteLength(text)
  check(bytes <= 8 * 1024 * 1024 && !/https?:\/\//i.test(text), 'report_cap_or_url')
  const disk = statfsSync(dirname(resolve(outputPath)), { bigint: true })
  check(disk.bavail * disk.bsize >= 256n * 1024n * 1024n + BigInt(bytes), 'reserve')
  const fd = openSync(
    outputPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    const stat = fstatSync(fd)
    check(stat.isFile() && stat.nlink === 1, 'exclusive_regular')
    writeFileSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  const directoryFd = openSync(
    dirname(resolve(outputPath)),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  )
  try {
    check(fstatSync(directoryFd).isDirectory(), 'output_directory')
    fsyncSync(directoryFd)
  } finally {
    closeSync(directoryFd)
  }
  return { path: outputPath, bytes, fileSha256: sha(text), bodySha256: sha256 }
}
export function main(args = process.argv.slice(2)) {
  check(
    dense(args, args.length) &&
      Object.getPrototypeOf(args) === Array.prototype &&
      Object.getOwnPropertySymbols(args).length === 0 &&
      Object.getOwnPropertyNames(args).length === args.length + 1 &&
      args.every((v) => typeof v === 'string' && v.length > 0) &&
      args[0] === '--capture' &&
      ((args.length === 4 && args[2] === '--output') ||
        (args.length === 6 && args[2] === '--additional-capture' && args[4] === '--output')),
    'cli_arguments',
  )
  const text = readBoundedReceiptFile(resolve(args[1]), {
    maxFileBytes: 8 * 1024 * 1024,
    maxTotalBytes: 8 * 1024 * 1024,
    totalBytes: 0,
  })
  const report = buildFluidBridgeUsdcHistoricalHolderBacktest(
    JSON.parse(text),
    new Date().toISOString(),
    {
      captureText: text,
      ...(args.length === 6
        ? {
            additionalCapture: (() => {
              const captureText = readBoundedReceiptFile(resolve(args[3]), {
                maxFileBytes: 8 * 1024 * 1024,
                maxTotalBytes: 8 * 1024 * 1024,
                totalBytes: 0,
              })
              return { receipt: JSON.parse(captureText), captureText }
            })(),
          }
        : {}),
    },
  )
  return writeFluidBridgeUsdcHistoricalHolderBacktest(resolve(args[args.length - 1]), report)
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(JSON.stringify(main()) + '\n')
  } catch {
    process.stderr.write('fluid_usdc_backtest_unavailable\n')
    process.exitCode = 1
  }
}
