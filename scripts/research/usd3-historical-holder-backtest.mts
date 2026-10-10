// Manual, offline reconstruction. Importing starts no provider, capture, scheduler, or filesystem read.
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
import * as collector from './usd3-hypothetical-history-capture.mjs'
import { readBoundedReceiptFile } from '../lib/boundedLocalReceiptFile.mjs'
import * as modelModule from '../../lib/carry/usd3JointHistoricalProcess.ts'
import type {
  Usd3JointHistoricalPoint,
  Usd3JointHistoricalInput,
} from '../../lib/carry/usd3JointHistoricalProcess.ts'

const reports = new WeakSet<object>(),
  MAX = (1n << 256n) - 1n
const sha = (v: string) => createHash('sha256').update(v).digest('hex')
function check(v: unknown, code: string): asserts v {
  if (!v) throw Error('usd3_backtest_' + code)
}
const record = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const dense = (v: unknown, max: number): v is any[] =>
  Array.isArray(v) &&
  v.length <= max &&
  Object.keys(v).length === v.length &&
  Array.from({ length: v.length }, (_, n) => Object.hasOwn(v, n)).every(Boolean)
const utc = (v: unknown): v is string =>
  typeof v === 'string' &&
  Number.isSafeInteger(Date.parse(v)) &&
  new Date(Date.parse(v)).toISOString() === v
const freeze = <T,>(v: T): T => {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze)
    Object.freeze(v)
  }
  return v
}
const pick = (m: unknown, k: string): any => {
  const v = m as Record<string, any>
  return v[k] ?? v.default?.[k]
}
const buildUsd3JointHistoricalProcess = pick(
  modelModule,
  'buildUsd3JointHistoricalProcess',
) as typeof modelModule.buildUsd3JointHistoricalProcess
const usd3HistoricalRuntimeFingerprint = pick(
  modelModule,
  'usd3HistoricalRuntimeFingerprint',
) as typeof modelModule.usd3HistoricalRuntimeFingerprint
const USD3_HISTORICAL_ROUTE = pick(
  modelModule,
  'USD3_HISTORICAL_ROUTE',
) as typeof modelModule.USD3_HISTORICAL_ROUTE
const USD3_HISTORICAL_VAULT = pick(
  modelModule,
  'USD3_HISTORICAL_VAULT',
) as typeof modelModule.USD3_HISTORICAL_VAULT
const USD3_REFERENCE_SUBJECT = pick(
  modelModule,
  'USD3_REFERENCE_SUBJECT',
) as typeof modelModule.USD3_REFERENCE_SUBJECT
const nativeLimit = (p: Usd3JointHistoricalPoint) =>
  p.shutdown || p.nativeQuoteStatus !== 'conditional_reference_address_quote'
    ? null
    : p.availableWithdrawLimitRaw
const cap = (p: Usd3JointHistoricalPoint): string | null => {
  const limit = nativeLimit(p)
  if (limit === null) return null
  const C = BigInt(limit),
    E = BigInt(p.nativeEaRaw)
  return String(C < E ? C : E)
}
const error = (predicted: string | null, observed: string | null) =>
  predicted === null || observed === null ? null : String(BigInt(predicted) - BigInt(observed))
export function usd3HistoricalFoldDefinitions(points: Usd3JointHistoricalPoint[]) {
  check(dense(points, 64) && points.length >= 4, 'point_count')
  return Array.from({ length: points.length - 3 }, (_, n) => {
    const baseline = n + 2
    return {
      training: Array.from({ length: baseline }, (_, j) => j),
      baseline,
      outcome: baseline + 1,
    }
  })
}
/** Descriptive scoring helper; synthetic arguments confer no receipt authentication or write authority. */
export function scoreUsd3HistoricalFold(
  input: Usd3JointHistoricalInput,
  outcome: Usd3JointHistoricalPoint,
) {
  const approved = structuredClone(input)
  const model = buildUsd3JointHistoricalProcess(input, (candidate) =>
    isDeepStrictEqual(candidate, approved),
  )
  check(
    model &&
      outcome.source.blockTime === model.targetAtUtc &&
      BigInt(outcome.source.blockNumber) > BigInt(input.baseline.source.blockNumber),
    'fold_clock_or_model',
  )
  const outcomeCheck = { ...input, baseline: outcome, knowledgeCutoffUtc: outcome.source.blockTime }
  check(
    buildUsd3JointHistoricalProcess(outcomeCheck, () => true),
    'outcome_shape',
  )
  const targetCompatible =
    outcome.hypotheticalSharesRaw === input.baseline.hypotheticalSharesRaw &&
    usd3HistoricalRuntimeFingerprint(outcome) === model.regimeFingerprint
  const actual = {
    fullEaRaw: outcome.nativeEaRaw,
    nativeWithdrawLimitRaw: nativeLimit(outcome),
    holderAvailableRaw: cap(outcome),
  }
  const persistence = {
    fullEaRaw: input.baseline.nativeEaRaw,
    nativeWithdrawLimitRaw: nativeLimit(input.baseline),
    holderAvailableRaw: cap(input.baseline),
  }
  const eligible = targetCompatible && cap(outcome) !== null
  return {
    requestedRaw: input.requestedRaw,
    ...(input.withdrawalLimitSubject && input.withdrawalLimitSubject !== USD3_REFERENCE_SUBJECT
      ? {
          referenceSubject: input.withdrawalLimitSubject,
          referenceSubjectQualification: 'getter_reference_only' as const,
        }
      : {}),
    sharesRaw: model.sharesRaw,
    sourceAtUtc: model.sourceAtUtc,
    targetAtUtc: model.targetAtUtc,
    horizonHours: model.horizonHours,
    knowledgeCutoffUtc: model.knowledgeCutoffUtc,
    actualAcquiredAtUtc: outcome.acquiredAtUtc,
    status: !targetCompatible
      ? 'censored_target_native_class_or_S_changed'
      : cap(outcome) === null
        ? 'censored_target_native_limit_unavailable'
        : 'retrospective_descriptive_comparison',
    actual,
    persistence,
    persistenceErrors: {
      fullEaRaw: targetCompatible ? error(persistence.fullEaRaw, actual.fullEaRaw) : null,
      nativeWithdrawLimitRaw: targetCompatible
        ? error(persistence.nativeWithdrawLimitRaw, actual.nativeWithdrawLimitRaw)
        : null,
      holderAvailableRaw: targetCompatible
        ? error(persistence.holderAvailableRaw, actual.holderAvailableRaw)
        : null,
    },
    actualHeadroomRaw: eligible
      ? String(BigInt(actual.holderAvailableRaw!) - BigInt(input.requestedRaw))
      : null,
    counts: model.counts,
    excludedIntervals: model.excludedIntervals,
    completeAttemptedIntervalCoverage: model.completeAttemptedIntervalCoverage && eligible,
    targetSummary: eligible ? model.targetSummary : null,
    scenarios: model.scenarios.map((s) => {
      const p = s.status === 'conditional_path' ? s.points.at(-1)! : null
      return {
        fromIndex: s.fromIndex,
        donor: s.donor,
        status: s.status,
        reason: s.reason,
        censoredAtUtc: s.censoredAtUtc,
        predicted: p
          ? {
              fullEaRaw: p.entitlementRaw,
              nativeWithdrawLimitRaw: p.availableRaw,
              holderAvailableRaw: p.capacityRaw,
              headroomRaw: p.headroomRaw,
            }
          : null,
        errors:
          p && targetCompatible
            ? {
                fullEaRaw: error(p.entitlementRaw, actual.fullEaRaw),
                nativeWithdrawLimitRaw: error(p.availableRaw, actual.nativeWithdrawLimitRaw),
                holderAvailableRaw: error(p.capacityRaw, actual.holderAvailableRaw),
              }
            : null,
        sampledShortfalls: s.sampledShortfalls,
        continuousPathKnown: false,
      }
    }),
  }
}
function replayCapture(receipt: unknown, root: string) {
  // Transport seal is checked before preparing a plan (which reads local authenticated pins).
  check(
    record(receipt) &&
      receipt.schema === 'usd3_hypothetical_history_capture_v1' &&
      record(receipt.plan) &&
      dense(receipt.plan.anchors, 4) &&
      receipt.plan.anchors.length === 4 &&
      record(receipt.plan.subject) &&
      typeof receipt.sha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(receipt.sha256),
    'capture_transport',
  )
  const { sha256, ...body } = receipt
  check(
    sha(JSON.stringify(body)) === sha256 &&
      sha(JSON.stringify(receipt.plan)) === receipt.planSha256,
    'capture_seal',
  )
  const plan = pick(
    collector,
    'prepareUsd3HypotheticalHistoryPlan',
  )({
    root,
    cashIndices: receipt.plan.anchors.map((a: any) => a.cashIndex),
    sharesRaw: receipt.plan.subject.sharesRaw,
    ...(receipt.plan.withdrawalLimitSubject !== USD3_REFERENCE_SUBJECT
      ? { withdrawalLimitSubject: receipt.plan.withdrawalLimitSubject }
      : {}),
  })
  const replay = pick(collector, 'replayUsd3HypotheticalHistory')(receipt, plan)
  return { receipt, plan, replay }
}
/** Each raw receipt independently authenticates under its exact private prepared selection and S. */
export function buildUsd3HistoricalHolderBacktest(
  captureReceipt: unknown,
  reconstructedAtUtc: string,
  options: { root?: string; additionalCaptures?: unknown[] } = {},
) {
  check(
    record(options) &&
      Object.keys(options).every((k) => ['root', 'additionalCaptures'].includes(k)),
    'options',
  )
  check(utc(reconstructedAtUtc), 'reconstruction_clock')
  const root = options.root ?? process.cwd(),
    extra = options.additionalCaptures ?? []
  check(typeof root === 'string' && root.length > 0 && dense(extra, 15), 'capture_count_or_root')
  // Parse with the collector's strict accessor/prototype/duplicate-key transport defense.
  const normalized = [captureReceipt, ...extra].map((r) => {
    const text = JSON.stringify(r)
    check(typeof text === 'string' && Buffer.byteLength(text) <= 8 * 1024 * 1024, 'capture_size')
    return pick(collector, 'parseUsd3HypotheticalJson')(text)
  })
  const captures = normalized.map((r) => replayCapture(r, root))
  check(
    captures.every(
      (c) =>
        utc(c.replay.availableAtUtc) &&
        Date.parse(c.replay.availableAtUtc) <= Date.parse(reconstructedAtUtc),
    ),
    'acquisition_after_analysis',
  )
  const shares = captures[0].plan.subject.sharesRaw
  const referenceSubject = captures[0].plan.withdrawalLimitSubject
  check(
    captures.every(
      (c) =>
        c.plan.subject.sharesRaw === shares &&
        c.plan.withdrawalLimitSubject === referenceSubject &&
        isDeepStrictEqual(c.plan.subject, captures[0].plan.subject),
    ),
    'same_S_and_route',
  )
  const joined = new Map<
    string,
    {
      point: Usd3JointHistoricalPoint
      captureEvidence: { captureSha256: string; acquiredAtUtc: string }[]
    }
  >()
  for (const c of captures)
    for (const point of c.replay.points as Usd3JointHistoricalPoint[]) {
      const key = String(point.source.blockNumber),
        old = joined.get(key)
      const provenance = {
        captureSha256: c.replay.rawCaptureSha256,
        acquiredAtUtc: point.acquiredAtUtc,
      }
      if (old) {
        const { acquiredAtUtc: _a, ...a } = old.point,
          { acquiredAtUtc: _b, ...b } = point
        check(isDeepStrictEqual(a, b), 'conflicting_same_header_native_evidence')
        old.captureEvidence.push(provenance)
      } else joined.set(key, { point, captureEvidence: [provenance] })
    }
  const joinedPoints = [...joined.values()].sort((a, b) =>
    BigInt(a.point.source.blockNumber) < BigInt(b.point.source.blockNumber) ? -1 : 1,
  )
  const points = joinedPoints.map((p) => p.point)
  check(
    points.length <= 64 &&
      points.every(
        (p, n) =>
          n === 0 ||
          (BigInt(p.source.blockNumber) > BigInt(points[n - 1].source.blockNumber) &&
            Date.parse(p.source.blockTime) > Date.parse(points[n - 1].source.blockTime) &&
            p.source.blockHash !== points[n - 1].source.blockHash),
      ),
    'joined_chronology',
  )
  const definitions = usd3HistoricalFoldDefinitions(points)
  const folds = definitions.map((definition) => {
    const baseline = points[definition.baseline],
      outcome = points[definition.outcome]
    const horizonMs = Date.parse(outcome.source.blockTime) - Date.parse(baseline.source.blockTime)
    const reference = BigInt(cap(baseline) ?? baseline.nativeEaRaw)
    const requested = [
      ...new Set(
        [reference / 4n || 1n, reference / 2n || 1n, reference, reference + 1n]
          .filter((q) => q > 0n && q <= MAX)
          .map(String),
      ),
    ]
    return {
      ...definition,
      baselineSource: baseline.source,
      outcomeSource: outcome.source,
      priorOnlyDonorEndpoints: true,
      correlatedRequestedAmountsRaw: requested,
      requestScenariosAreIndependentSamples: false,
      comparisons: requested.map((requestedRaw) =>
        scoreUsd3HistoricalFold(
          {
            mode: 'retrospective_replay',
            routeKey: USD3_HISTORICAL_ROUTE,
            destination: USD3_HISTORICAL_VAULT,
            owner: null,
            ...(referenceSubject !== USD3_REFERENCE_SUBJECT
              ? { withdrawalLimitSubject: referenceSubject }
              : {}),
            issueAtUtc: reconstructedAtUtc,
            knowledgeCutoffUtc: baseline.source.blockTime,
            horizonHours: horizonMs / 3600000,
            requestedRaw,
            history: points.slice(0, definition.baseline),
            baseline,
            maxHistoricalGapSeconds: 7 * 86400,
          },
          outcome,
        ),
      ),
    }
  })
  const body = {
    schema: 'usd3_historical_holder_backtest_v1',
    reconstructedAtUtc,
    positionKind: 'hypothetical_fixed_shares_not_owner',
    owner: null,
    ...(referenceSubject !== USD3_REFERENCE_SUBJECT
      ? {
          referenceSubject,
          referenceSubjectQualification: 'getter_reference_only' as const,
        }
      : {}),
    historicalOwnership: false,
    ownerCommitmentQualified: false,
    conditionalReferenceAddressQuote: true,
    retrospectiveReconstructions: true,
    prospectiveValidation: false,
    execution: false,
    calibration: false,
    sourceImplementationEquivalence: false,
    minedPayout: false,
    requestScenariosAreIndependentSamples: false,
    errorSign: 'predicted_minus_observed_native_USDC_raw',
    donorIntervalsReusedAcrossFolds: folds.length > 1,
    evidence: captures.map((c) => ({
      rawCaptureSha256: c.replay.rawCaptureSha256,
      availableAtUtc: c.replay.availableAtUtc,
      selectedCashIndices: c.plan.anchors.map((a: any) => a.cashIndex),
      sharesRaw: c.plan.subject.sharesRaw,
      ...(referenceSubject !== USD3_REFERENCE_SUBJECT
        ? {
            referenceSubject,
            referenceSubjectQualification: 'getter_reference_only' as const,
          }
        : {}),
      runtimePins: c.plan.runtimePins,
    })),
    joinedPoints,
    folds,
    counts: {
      captures: captures.length,
      uniqueNativePoints: points.length,
      retrospectiveFolds: folds.length,
      correlatedRequestScenarios: folds.reduce((n, f) => n + f.comparisons.length, 0),
      independentRequestSamples: 0,
      uniqueAttemptedSupportIntervals: points.length - 3,
      attemptedSupportIntervals: folds.reduce((n, f) => n + f.comparisons[0].counts.attempted, 0),
      excludedSupportIntervals: folds.reduce((n, f) => n + f.comparisons[0].counts.excluded, 0),
      censoredSupportIntervals: folds.reduce((n, f) => n + f.comparisons[0].counts.censored, 0),
    },
    MRaw: null,
    calibratedProbability: false,
    confidenceInterval: false,
    interpretation:
      'Offline retrospective reconstruction; reference-address native quotes do not establish owner execution or prospective forecast accuracy.',
  }
  const report = freeze({ ...body, sha256: sha(JSON.stringify(body)) })
  reports.add(report)
  return report
}
export function writeUsd3HistoricalHolderBacktest(
  outputPath: string,
  report: ReturnType<typeof buildUsd3HistoricalHolderBacktest>,
) {
  check(reports.has(report), 'private_report_required')
  const { sha256, ...body } = report
  check(sha(JSON.stringify(body)) === sha256, 'report_seal')
  const text = JSON.stringify(report, null, 2) + '\n',
    bytes = Buffer.byteLength(text)
  check(bytes <= 8 * 1024 * 1024 && !/https?:\/\//i.test(text), 'report_cap_or_url')
  const path = resolve(outputPath),
    directory = dirname(path),
    disk = statfsSync(directory, { bigint: true })
  check(disk.bavail * disk.bsize >= 256n * 1024n * 1024n + BigInt(bytes), 'reserve')
  const fd = openSync(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    check(fstatSync(fd).isFile() && fstatSync(fd).nlink === 1, 'exclusive_regular')
    writeFileSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  const directoryFd = openSync(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  )
  try {
    fsyncSync(directoryFd)
  } finally {
    closeSync(directoryFd)
  }
  return { path, bytes, fileSha256: sha(text), bodySha256: sha256 }
}
export function main(args = process.argv.slice(2)) {
  check(
    dense(args, 34) &&
      args.length >= 4 &&
      args.length % 2 === 0 &&
      args.every((v) => typeof v === 'string' && v.length > 0) &&
      args[0] === '--capture' &&
      args.at(-2) === '--output' &&
      args.slice(2, -2).every((v, n) => n % 2 === 1 || v === '--additional-capture'),
    'cli_arguments',
  )
  const budget = { maxFileBytes: 8 * 1024 * 1024, maxTotalBytes: 128 * 1024 * 1024, totalBytes: 0 }
  const paths = [args[1], ...args.slice(2, -2).filter((_v, n) => n % 2 === 1)]
  check(new Set(paths.map((p) => resolve(p))).size === paths.length, 'duplicate_capture_path')
  const receipts = paths.map((p) =>
    pick(collector, 'parseUsd3HypotheticalJson')(readBoundedReceiptFile(resolve(p), budget)),
  )
  return writeUsd3HistoricalHolderBacktest(
    args.at(-1)!,
    buildUsd3HistoricalHolderBacktest(receipts[0], new Date().toISOString(), {
      additionalCaptures: receipts.slice(1),
    }),
  )
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(JSON.stringify(main()) + '\n')
  } catch {
    process.stderr.write('usd3_historical_backtest_unavailable\n')
    process.exitCode = 1
  }
}
