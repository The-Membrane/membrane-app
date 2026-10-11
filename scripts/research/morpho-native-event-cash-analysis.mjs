// Explicit offline research CLI. Importing this module starts no job or acquisition.
import { createHash, randomUUID } from 'node:crypto'
import {
  constants,
  openSync,
  writeSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  closeSync,
  mkdirSync,
  statfsSync,
} from 'node:fs'
import { resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { gzipSync, gunzipSync } from 'node:zlib'
import { readBoundedReceiptFile } from '../lib/boundedLocalReceiptFile.mjs'
import * as adapterModule from '../../lib/carry/morphoNativeEventCashAdapter.server.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const OUT_PARENT = resolve(ROOT, 'data/research/venue-signals')
const MB = 1024 * 1024
const LIMITS = Object.freeze({
  file: 8 * MB,
  cohort: 32 * MB,
  report: 2 * MB,
  terminal: 64 * 1024,
  preFree: 288 * MB,
  reserve: 256 * MB,
  deadlineMs: 120000,
})
const hash = (x) => createHash('sha256').update(x).digest('hex')
const pick = (name) => {
  const value = adapterModule[name] ?? adapterModule.default?.[name]
  if (typeof value !== 'function') throw Error('event_cash_standalone_export_missing:' + name)
  return value
}
const readDataset = pick('readPinnedMorphoNativeEventCashDataset')
const analyze = pick('analyzeMorphoNativeEventCashDataset')
const manifestPath =
  adapterModule.MORPHO_EVENT_CASH_MANIFEST_PATH ??
  adapterModule.default?.MORPHO_EVENT_CASH_MANIFEST_PATH
const manifestSHA =
  adapterModule.MORPHO_EVENT_CASH_MANIFEST_SHA ??
  adapterModule.default?.MORPHO_EVENT_CASH_MANIFEST_SHA
if (typeof manifestPath !== 'string' || !/^[0-9a-f]{64}$/.test(manifestSHA ?? ''))
  throw Error('event_cash_standalone_manifest_export_missing')
const jsonBytes = (body) => {
  const record = { ...body, sha256: hash(JSON.stringify(body)) }
  return Buffer.from(JSON.stringify(record) + '\n')
}
const SUBJECT_STORAGE_SCHEMA = 'morpho_native_event_cash_subject_gzip_base64_v1'
function sealedObject(bytes, failure) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > LIMITS.file)
    throw Error(failure)
  const text = bytes.toString('utf8')
  if (!Buffer.from(text).equals(bytes)) throw Error(failure)
  let record
  try {
    record = JSON.parse(text)
  } catch {
    throw Error(failure)
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw Error(failure)
  const { sha256, ...body } = record
  if (
    typeof sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(sha256) ||
    hash(JSON.stringify(body)) !== sha256 ||
    !jsonBytes(body).equals(bytes)
  )
    throw Error(failure)
  return record
}
/** Lossless private storage only; decoded bytes retain the original subject body seal. */
export function encodeSubjectSnapshot(decoded) {
  const original = sealedObject(decoded, 'event_cash_subject_snapshot_decoded')
  if (original.schema !== 'morpho_native_event_cash_subject_snapshot_v1')
    throw Error('event_cash_subject_snapshot_decoded')
  const compressed = gzipSync(decoded, { level: 9 })
  const wrapper = jsonBytes({
    schema: SUBJECT_STORAGE_SCHEMA,
    encoding: 'gzip-base64',
    decodedBytes: decoded.length,
    decodedSha256: hash(decoded),
    compressedBytes: compressed.length,
    compressedSha256: hash(compressed),
    base64: compressed.toString('base64'),
  })
  // Prove exact original-byte equality before the unchanged protected text writer sees the wrapper.
  if (!decodeSubjectSnapshot(wrapper).equals(decoded))
    throw Error('event_cash_subject_snapshot_roundtrip')
  return wrapper
}
export function decodeSubjectSnapshot(bytes) {
  const record = sealedObject(bytes, 'event_cash_subject_snapshot_wrapper')
  const keys = [
    'schema',
    'encoding',
    'decodedBytes',
    'decodedSha256',
    'compressedBytes',
    'compressedSha256',
    'base64',
    'sha256',
  ].sort()
  if (
    JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(keys) ||
    record.schema !== SUBJECT_STORAGE_SCHEMA ||
    record.encoding !== 'gzip-base64' ||
    !Number.isSafeInteger(record.decodedBytes) ||
    record.decodedBytes < 1 ||
    record.decodedBytes > LIMITS.file ||
    !Number.isSafeInteger(record.compressedBytes) ||
    record.compressedBytes < 18 ||
    record.compressedBytes > LIMITS.file ||
    typeof record.decodedSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(record.decodedSha256) ||
    typeof record.compressedSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(record.compressedSha256)
  )
    throw Error('event_cash_subject_snapshot_metadata')
  if (
    typeof record.base64 !== 'string' ||
    record.base64.length !== 4 * Math.ceil(record.compressedBytes / 3) ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(record.base64)
  )
    throw Error('event_cash_subject_snapshot_base64')
  const compressed = Buffer.from(record.base64, 'base64')
  if (compressed.toString('base64') !== record.base64)
    throw Error('event_cash_subject_snapshot_base64')
  if (compressed.length !== record.compressedBytes || hash(compressed) !== record.compressedSha256)
    throw Error('event_cash_subject_snapshot_compressed_pin')
  if (
    compressed[0] !== 0x1f ||
    compressed[1] !== 0x8b ||
    compressed[2] !== 8 ||
    compressed[3] !== 0 ||
    compressed.readUInt32LE(4) !== 0
  )
    throw Error('event_cash_subject_snapshot_gzip_header')
  let decoded
  try {
    decoded = gunzipSync(compressed, { maxOutputLength: record.decodedBytes })
  } catch {
    throw Error('event_cash_subject_snapshot_gzip')
  }
  if (decoded.length !== record.decodedBytes || hash(decoded) !== record.decodedSha256)
    throw Error('event_cash_subject_snapshot_decoded_pin')
  const original = sealedObject(decoded, 'event_cash_subject_snapshot_decoded')
  if (original.schema !== 'morpho_native_event_cash_subject_snapshot_v1')
    throw Error('event_cash_subject_snapshot_decoded')
  if (!gzipSync(decoded, { level: 9 }).equals(compressed))
    throw Error('event_cash_subject_snapshot_gzip_canonical')
  return decoded
}
function freeAt(path) {
  const s = statfsSync(path, { bigint: true })
  return s.bavail * s.bsize
}
function guard(bytes) {
  const free = freeAt(ROOT)
  if (free < BigInt(LIMITS.preFree) || free - BigInt(bytes) < BigInt(LIMITS.reserve))
    throw Error('event_cash_disk_guard')
}
function readExactSource(path, budget) {
  const stat = lstatSync(resolve(ROOT, path))
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMITS.file)
    throw Error('event_cash_source_file')
  budget.maxFileBytes = stat.size
  const text = readBoundedReceiptFile(resolve(ROOT, path), budget)
  return { path, bytes: Buffer.byteLength(text), sha256: hash(text), text }
}
function sourceSnapshot() {
  const paths = [
    'lib/carry/morphoNativeEventCashAdapter.server.ts',
    'scripts/research/morpho-native-event-cash-analysis.mjs',
    'tests/unit/morphoNativeEventCashAdapter.test.ts',
    'lib/carry/eventConditionedNetScenarios.ts',
    'lib/carry/conditionalSampledCashPathProjection.ts',
    'scripts/lib/boundedLocalReceiptFile.mjs',
    'node_modules/tsx/dist/loader.mjs',
  ]
  const budget = { maxFileBytes: LIMITS.file, maxTotalBytes: LIMITS.cohort, totalBytes: 0 }
  return paths.map((path) => readExactSource(path, budget))
}
function sourceDrift(before) {
  const budget = { maxFileBytes: LIMITS.file, maxTotalBytes: LIMITS.cohort, totalBytes: 0 }
  for (const b of before) {
    const now = readExactSource(b.path, budget)
    if (now.bytes !== b.bytes || now.sha256 !== b.sha256)
      throw Error('event_cash_executing_source_drift')
  }
}
export function parseArgs(argv) {
  if (argv.length === 0)
    return resolve(
      OUT_PARENT,
      'morpho-native-event-cash-analysis-' +
        new Date().toISOString().replaceAll(':', '-') +
        '-' +
        randomUUID(),
    )
  if (argv.length !== 2 || argv[0] !== '--out') throw Error('event_cash_cli_arguments')
  const out = resolve(ROOT, argv[1])
  if (
    dirname(out) !== OUT_PARENT ||
    !/^morpho-native-event-cash-analysis-[A-Za-z0-9.-]+$/.test(basename(out))
  )
    throw Error('event_cash_cli_fixed_output_parent')
  return out
}
export function createProtectedResearchWriter(out, startedAt) {
  if (dirname(out) !== OUT_PARENT) throw Error('event_cash_output_parent')
  guard(0)
  const parent = lstatSync(OUT_PARENT)
  if (!parent.isDirectory() || parent.isSymbolicLink())
    throw Error('event_cash_output_parent_identity')
  mkdirSync(out, { mode: 0o700 })
  const parentFd = openSync(OUT_PARENT, constants.O_RDONLY | constants.O_DIRECTORY)
  try {
    fsyncSync(parentFd)
  } finally {
    closeSync(parentFd)
  }
  const dir = lstatSync(out)
  if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o777) !== 0o700)
    throw Error('event_cash_output_directory')
  let attemptedBytes = 0
  const references = []
  function deadline() {
    if (performance.now() - startedAt > LIMITS.deadlineMs)
      throw Error('event_cash_offline_deadline')
  }
  function write(name, bytes, terminal = false) {
    deadline()
    if (
      !/^[A-Za-z0-9.-]+$/.test(name) ||
      !Buffer.isBuffer(bytes) ||
      bytes.length > (terminal ? LIMITS.terminal : LIMITS.file) ||
      attemptedBytes + bytes.length > (terminal ? LIMITS.cohort : LIMITS.cohort - LIMITS.terminal)
    )
      throw Error('event_cash_output_bytes_limit')
    guard(bytes.length)
    const path = resolve(out, name)
    const fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    // A failed fsync still leaves an attempted file charged against this cohort.
    attemptedBytes += bytes.length
    try {
      let offset = 0
      while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset)
      fsyncSync(fd)
      const dfd = openSync(out, constants.O_RDONLY | constants.O_DIRECTORY)
      try {
        fsyncSync(dfd)
      } finally {
        closeSync(dfd)
      }
      const st = fstatSync(fd),
        named = lstatSync(path)
      if (
        !st.isFile() ||
        named.isSymbolicLink() ||
        st.dev !== named.dev ||
        st.ino !== named.ino ||
        st.size !== bytes.length ||
        named.size !== bytes.length ||
        st.nlink !== 1 ||
        named.nlink !== 1 ||
        (st.mode & 0o777) !== 0o600 ||
        (named.mode & 0o777) !== 0o600
      )
        throw Error('event_cash_output_postfsync_identity')
      const budget = { maxFileBytes: bytes.length, maxTotalBytes: bytes.length, totalBytes: 0 }
      const readback = readBoundedReceiptFile(path, budget)
      if (hash(readback) !== hash(bytes) || Buffer.byteLength(readback) !== bytes.length)
        throw Error('event_cash_output_readback')
      deadline()
      const ref = {
        file: name,
        bytes: bytes.length,
        sha256: hash(bytes),
        availableAtUtc: new Date().toISOString(),
      }
      references.push(ref)
      return ref
    } finally {
      closeSync(fd)
    }
  }
  return { write, deadline, references, attemptedBytes: () => attemptedBytes }
}
export function run(argv = process.argv.slice(2)) {
  const start = performance.now(),
    startedAtUtc = new Date().toISOString(),
    out = parseArgs(argv)
  guard(0)
  const sources = sourceSnapshot(),
    dataset = readDataset(),
    analysis = analyze(dataset)
  const budget = { maxFileBytes: 128 * 1024, maxTotalBytes: 128 * 1024, totalBytes: 0 }
  const manifestText = readBoundedReceiptFile(resolve(ROOT, manifestPath), budget)
  if (hash(manifestText) !== manifestSHA) throw Error('event_cash_runtime_manifest_drift')
  const records = analysis.subjects.map((s, index) => {
    const name = 'subject-' + String(index).padStart(3, '0') + '.json'
    const decoded = jsonBytes({
      schema: 'morpho_native_event_cash_subject_snapshot_v1',
      identity: s.identity,
      input: s.input,
      output: {
        selection: s.selection,
        chronologicalFolds: s.chronologicalFolds,
        summary: s.summary,
      },
      originalAuthority: false,
      authenticated: false,
      forecastValidated: false,
      holderExecutableExit: false,
    })
    const bytes = encodeSubjectSnapshot(decoded),
      wrapper = JSON.parse(bytes.toString('utf8'))
    return {
      name,
      bytes,
      storage: {
        wrapperSchema: wrapper.schema,
        encoding: wrapper.encoding,
        fileBytes: bytes.length,
        fileSha256: hash(bytes),
        decodedBytes: wrapper.decodedBytes,
        decodedSha256: wrapper.decodedSha256,
        compressedBytes: wrapper.compressedBytes,
        compressedSha256: wrapper.compressedSha256,
      },
    }
  })
  const studySourcePins = sources.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))
  const body = {
    schema: 'morpho_native_event_cash_actual_analysis_v1',
    startedAtUtc,
    knowledgeCutoffUtc: dataset.knowledgeCutoffUtc,
    informationMode: analysis.informationMode,
    counts: analysis.counts,
    subjectSummaries: analysis.subjects.map((s, index) => ({
      identity: s.identity,
      metricRegime: s.metricRegime,
      snapshotFile: records[index].name,
      snapshotStorage: records[index].storage,
      ...s.summary,
    })),
    subjectSnapshotStorage: {
      encoding: 'gzip-base64',
      wrapperSchema: SUBJECT_STORAGE_SCHEMA,
      decodedByteTotal: records.reduce((n, r) => n + r.storage.decodedBytes, 0),
      compressedByteTotal: records.reduce((n, r) => n + r.storage.compressedBytes, 0),
      persistedWrapperByteTotal: records.reduce((n, r) => n + r.bytes.length, 0),
      decodedPerSubjectByteLimit: LIMITS.file,
      persistedCohortByteLimit: LIMITS.cohort,
      cohortBudgetBasis: 'persisted_encoded_wrapper_file_bytes',
      lossless: true,
      preservesOriginalSealedJSONBytes: true,
    },
    originalInputs: dataset.inputPins,
    manifest: dataset.manifest,
    studyImplementationSourcePins: studySourcePins,
    runtime: {
      nodeVersion: process.version,
      zlibVersion: process.versions.zlib,
      arch: process.arch,
      platform: process.platform,
      loader: studySourcePins.at(-1),
      compiledModuleEquivalence: false,
      workerConcurrency: 1,
    },
    scope: 'retrospective_associated_native_cash_NET_not_holder_or_news_causal_forecast',
    currentTargetSourceBasis: 'retained_last_native_cash_point_not_live_quote',
    originalEventEnvelopeClockRange: dataset.originalEventEnvelopeClockRange,
    availabilityBasis: 'max_original_retention_clock_and_measured_completed_verification',
    zeroLagChronologicalOriginsAreCounterfactual: true,
    chronologicalHoldoutUsesFutureObservedNativeCashLabels: true,
    trainingEndpointsStrictlyBeforeOrigin: true,
    futureNativeEventsExcludedFromFeatures: true,
    historicallyIssuedForecast: false,
    receiptClocksBackdated: false,
    minimumBaselineDonors: 3,
    minimumEventClusters: 2,
    bandsAreHistoricalScenarioExtremaNotCalibratedCoverage: true,
    baselineScoringBasis: 'signed_native_NET_all_eligible_not_only_finite_stock_bands',
    physicalStockBandCensorExcludesNETError: false,
    negativePhysicalStockClamped: false,
    repeatedStoriesAndIntervalsNotIndependent: true,
    independentSampleCount: null,
    metricRegimeOnly: true,
    policyRegimeVerified: false,
    protocolConfigurationStable: false,
    cashPointsWithoutEventRetainBaseline: true,
    excludedForeignFinalPayoutSubjects: dataset.excludedCashSubjects,
    netAppliedOnce: true,
    competingMRaw: null,
    QApplied: false,
    sourceAgeAppliedToCurrentForecast: false,
    causal: false,
    calibrated: false,
    forecastValidated: false,
    originalAuthority: false,
    authenticated: false,
    holderExecutableExit: false,
    minedPayout: false,
    eventCatalogueComplete: false,
    newRPC: 0,
    newProviderAcquisition: 0,
    UIConnected: false,
  }
  const report = jsonBytes(body)
  if (report.length > LIMITS.report) throw Error('event_cash_report_2MiB_limit')
  const planned =
    report.length +
    Buffer.byteLength(manifestText) +
    records.reduce((n, r) => n + r.bytes.length, 0) +
    sources.reduce((n, s) => n + s.bytes, 0)
  if (
    records.some((r) => r.bytes.length > LIMITS.file) ||
    planned > LIMITS.cohort - LIMITS.terminal
  )
    throw Error('event_cash_planned_cohort_32MiB_limit')
  guard(planned)
  sourceDrift(sources)
  const writer = createProtectedResearchWriter(out, start)
  try {
    writer.write('input-manifest.json', Buffer.from(manifestText))
    for (let index = 0; index < sources.length; index++)
      writer.write(
        'source-' + String(index).padStart(2, '0') + '.txt',
        Buffer.from(sources[index].text),
      )
    for (const r of records) writer.write(r.name, r.bytes)
    writer.write('analysis.json', report)
    sourceDrift(sources)
    writer.deadline()
    const terminal = writer.write(
      'terminal.json',
      jsonBytes({
        schema: 'morpho_native_event_cash_analysis_terminal_v1',
        status: 'complete',
        qualificationAtUtc: new Date().toISOString(),
        qualificationClockBoundary: 'before_terminal_file_and_directory_fsync',
        references: writer.references,
        attemptedWriteBytesBeforeTerminal: writer.attemptedBytes(),
        manifestSHA,
        originalInputsCopied: false,
        sourcePins: studySourcePins,
        newRPC: 0,
        authenticated: false,
        originalAuthority: false,
        calibrated: false,
        holderExecutableExit: false,
      }),
      true,
    )
    writer.deadline()
    return {
      complete: true,
      out,
      terminal,
      completedAtUtc: new Date().toISOString(),
      completionClockBoundary: 'after_terminal_fsync_readback_identity_and_deadline',
      elapsedMs: performance.now() - start,
      subjects: analysis.counts.selectorSubjects,
      nativeDepositEvents: analysis.counts.nativeDepositEvents,
      newRPC: 0,
    }
  } catch (error) {
    // Immutable partial outputs remain. Never delete or rewrite them.
    return {
      complete: false,
      out,
      reason:
        error instanceof Error && /^event_cash_[a-z0-9_]+$/.test(error.message)
          ? error.message
          : 'event_cash_unknown_failure',
      attemptedWriteBytes: writer.attemptedBytes(),
      retainedFiles: writer.references.length,
      completedAtUtc: new Date().toISOString(),
      newRPC: 0,
    }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = run()
    process.stdout.write(JSON.stringify(result) + '\n')
    if (!result.complete) process.exitCode = 2
  } catch (error) {
    process.stderr.write(
      (error instanceof Error ? error.message : 'event_cash_analysis_failed') + '\n',
    )
    process.exitCode = 1
  }
}
