import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statfsSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

/** Local provenance only. These files cannot register or approve native evidence. */
export type HolderNativeHistoryOriginalKind =
  | 'fluid_usdc_bridge'
  | 'fluid_usdt_bridge_current'
  | 'fluid_usdt_bridge_history'
  | 'usd3'
  | 'umbrella_gho_current'
  | 'umbrella_gho_history'
  | 'apy_usd_current'
  | 'apy_usd_history'
export type HolderNativeHistoryOriginalReason =
  | 'pending_replay'
  | 'qualified'
  | 'provider_unavailable'
  | 'plan_rejected'
  | 'capture_unavailable'
  | 'replay_rejected'
  | 'codec_rejected'
  | 'invalid_input'
  | 'not_local_repository'
  | 'filesystem_unavailable'
  | 'disk_reserve'
  | 'artifact_bound'
  | 'source_changed'
  | 'artifact_changed'
  | 'no_capture_recorded'
export type HolderNativeHistoryOriginalRetentionStatus = Readonly<{
  status: 'retained' | 'partial' | 'unavailable'
  reason: HolderNativeHistoryOriginalReason
  kind: HolderNativeHistoryOriginalKind | null
  producerReplayQualification: boolean
  producerReportedQualification?: boolean
  accountedSeriesBytes?: number
  recordedBatches: number
  artifactDirectory?: string
  manifestFileSha256?: string
  manifestBodySha256?: string
  /** Unkeyed provenance of actual captured executable/config bytes; grants no native authority. */
  sourceClosureSha256?: string
  originalAuthority: false
  authenticated: false
  executionQualified: false
  historicalOwnership: false
}>
export type HolderNativeHistoryOriginalSeries = Readonly<{
  schema: 'holder_native_history_original_series_handle_v1'
}>
const FILE_CAP = 8 * 1024 * 1024,
  SERIES_CAP = 32 * 1024 * 1024
const SOURCE_CAP = 6 * 1024 * 1024,
  RESERVE = 256 * 1024 * 1024
const MAX = (1n << 256n) - 1n
// Static first-party execution closure of each default native producer.
// No environment files or caller-selected paths are recorded.
function apySourceFiles() {
  return [
    'lib/carry/aggregateCashQHoldout.ts',
    'lib/carry/apyUsdFeeOutlook.ts',
    'lib/carry/apyUsdJointNativeEvidence.server.ts',
    'lib/carry/apyUsdJointNativeEvidence.ts',
    'lib/carry/apyUsdJointStockProjection.ts',
    'lib/carry/conditionalGrossFlowHeadroom.ts',
    'lib/carry/conditionalSampledCashPathProjection.ts',
    'lib/carry/historicalCashContext.ts',
    'lib/carry/historicalCashProjection.ts',
    'lib/carry/historicalCompetingFlowEstimate.ts',
    'lib/carry/historicalFlowDuration.ts',
    'lib/carry/historicalGrossFlowStress.ts',
    'lib/carry/historicalSampledCashPaths.ts',
    'lib/carry/holderNativeHistoryOriginals.server.ts',
    'lib/carry/holderOriginCode.ts',
    'lib/carry/localHistoricalCashScenario.ts',
    'lib/carry/localHistoricalSampledCashTimeline.ts',
    'lib/carry/usd3JointNativeEvidenceCodec.ts',
    'lib/carry/usd3JointTrustedProfile.ts',
    'lib/forecast/exitImpactForecast.ts',
    'scripts/lib/boundedLocalReceiptFile.mjs',
    'scripts/lib/depth-identity.mjs',
    'scripts/lib/depthCurve.mjs',
    'scripts/lib/historicalDepthQuoteStore.mjs',
    'scripts/lib/venue-reads.mjs',
    'scripts/research/apyusd-joint-native-history-capture.mjs',
    'scripts/research/carry-depth-quote-archive.mjs',
    'scripts/research/carry-depth-quote-provider-policy.json',
    'scripts/research/conditional-cash-time-holdout.mjs',
    'scripts/research/usd3-hypothetical-history-capture.mjs',
    'scripts/route-cohort/aug-2026-ab-vault-seed.json',
    'tools/venue-recorder.config.json',
  ]
}
const sourceFiles = {
  // Unknown current S is native-derived after this fixed source closure is snapshotted.
  fluid_usdt_bridge_history: [
    'lib/carry/conditionalGrossFlowHeadroom.ts',
    'lib/carry/conditionalSampledCashPathProjection.ts',
    'lib/carry/fluidBridgeUsdcJointHistoricalProcess.ts',
    'lib/carry/fluidUsdcBridgeJointNativeEvidenceCodec.ts',
    'lib/carry/fluidUsdcBridgeJointTrustedProfile.ts',
    'lib/carry/fluidUsdcBridgeNativeAbi.ts',
    'lib/carry/fluidUsdcBridgeNativeCapacity.ts',
    'lib/carry/fluidUsdtBridgeJointComposedHistoricalEvidenceCodec.ts',
    'lib/carry/fluidUsdtBridgeJointHistoricalEvidence.server.ts',
    'lib/carry/fluidUsdtBridgeNativeCapacity.server.ts',
    'lib/carry/fluidUsdtBridgeNativeQuoteEvidenceCodec.ts',
    'lib/carry/historicalCashContext.ts',
    'lib/carry/historicalCompetingFlowEstimate.ts',
    'lib/carry/historicalFlowDuration.ts',
    'lib/carry/historicalGrossFlowStress.ts',
    'lib/carry/historicalSampledCashPaths.ts',
    'lib/carry/holderNativeHistoryOriginals.server.ts',
    'lib/carry/localHistoricalSampledCashTimeline.ts',
    'scripts/lib/boundedLocalReceiptFile.mjs',
    'scripts/lib/depth-identity.mjs',
    'scripts/lib/depthCurve.mjs',
    'scripts/lib/historicalDepthQuoteStore.mjs',
    'scripts/lib/venue-reads.mjs',
    'scripts/research/carry-depth-quote-archive.mjs',
    'scripts/research/carry-depth-quote-provider-policy.json',
    'scripts/research/conditional-cash-time-holdout.mjs',
    'scripts/research/usd3-hypothetical-history-capture.mjs',
    'tools/venue-recorder.config.json',
  ],
  fluid_usdt_bridge_current: [
    'lib/carry/conditionalGrossFlowHeadroom.ts',
    'lib/carry/conditionalSampledCashPathProjection.ts',
    'lib/carry/fluidBridgeUsdcJointHistoricalProcess.ts',
    'lib/carry/fluidUsdcBridgeJointTrustedProfile.ts',
    'lib/carry/fluidUsdcBridgeNativeAbi.ts',
    'lib/carry/fluidUsdcBridgeNativeCapacity.ts',
    'lib/carry/fluidUsdtBridgeNativeCapacity.server.ts',
    'lib/carry/fluidUsdtBridgeNativeQuoteEvidenceCodec.ts',
    'lib/carry/historicalCashContext.ts',
    'lib/carry/historicalCompetingFlowEstimate.ts',
    'lib/carry/historicalFlowDuration.ts',
    'lib/carry/historicalGrossFlowStress.ts',
    'lib/carry/historicalSampledCashPaths.ts',
    'lib/carry/holderNativeHistoryOriginals.server.ts',
    'lib/carry/localHistoricalSampledCashTimeline.ts',
    'scripts/lib/boundedLocalReceiptFile.mjs',
    'scripts/lib/depth-identity.mjs',
    'scripts/lib/depthCurve.mjs',
    'scripts/lib/historicalDepthQuoteStore.mjs',
    'scripts/lib/venue-reads.mjs',
    'scripts/research/carry-depth-quote-archive.mjs',
    'scripts/research/carry-depth-quote-provider-policy.json',
    'scripts/research/conditional-cash-time-holdout.mjs',
    'scripts/research/usd3-hypothetical-history-capture.mjs',
    'tools/venue-recorder.config.json',
  ],
  // Same on-demand native closure for current and historical phases; no environment files.
  apy_usd_current: apySourceFiles(),
  apy_usd_history: apySourceFiles(),
  // Native history uses positive full S; CS is independently bound in the prepared plan.
  // This fixed first-party closure adds the protected collector/producer and pure history/stock modules.
  umbrella_gho_history: [
    'lib/carry/aggregateCashQHoldout.ts',
    'lib/carry/conditionalGrossFlowHeadroom.ts',
    'lib/carry/conditionalSampledCashPathProjection.ts',
    'lib/carry/historicalCashContext.ts',
    'lib/carry/historicalCashProjection.ts',
    'lib/carry/historicalCompetingFlowEstimate.ts',
    'lib/carry/historicalFlowDuration.ts',
    'lib/carry/historicalGrossFlowStress.ts',
    'lib/carry/historicalSampledCashPaths.ts',
    'lib/carry/holderNativeHistoryOriginals.server.ts',
    'lib/carry/holderOriginCode.ts',
    'lib/carry/localHistoricalCashScenario.ts',
    'lib/carry/localHistoricalSampledCashTimeline.ts',
    'lib/carry/umbrellaGhoExit.ts',
    'lib/carry/umbrellaGhoJointHistoricalEvidence.server.ts',
    'lib/carry/umbrellaGhoJointNativeHistory.ts',
    'lib/carry/umbrellaGhoJointStockProjection.ts',
    'lib/carry/umbrellaGhoNativeCapacity.server.ts',
    'lib/carry/umbrellaGhoNativeCapacity.ts',
    'lib/forecast/exitImpactForecast.ts',
    'scripts/lib/boundedLocalReceiptFile.mjs',
    'scripts/lib/depth-identity.mjs',
    'scripts/lib/depthCurve.mjs',
    'scripts/lib/historicalDepthQuoteStore.mjs',
    'scripts/lib/venue-reads.mjs',
    'scripts/research/carry-depth-quote-archive.mjs',
    'scripts/research/carry-depth-quote-provider-policy.json',
    'scripts/research/conditional-cash-time-holdout.mjs',
    'scripts/research/umbrella-gho-joint-history-capture.mjs',
    'scripts/research/usd3-hypothetical-history-capture.mjs',
    'scripts/route-cohort/aug-2026-ab-vault-seed.json',
    'tools/venue-recorder.config.json',
  ],
  // Current S is unknown until native balanceOf; this closure is snapshotted before any await.
  // First-party static imports (including type-only witnesses), dynamic configured factory and safe policy/config.
  umbrella_gho_current: [
    'lib/carry/aggregateCashQHoldout.ts',
    'lib/carry/conditionalGrossFlowHeadroom.ts',
    'lib/carry/conditionalSampledCashPathProjection.ts',
    'lib/carry/historicalCashContext.ts',
    'lib/carry/historicalCashProjection.ts',
    'lib/carry/historicalCompetingFlowEstimate.ts',
    'lib/carry/historicalFlowDuration.ts',
    'lib/carry/historicalGrossFlowStress.ts',
    'lib/carry/historicalSampledCashPaths.ts',
    'lib/carry/holderNativeHistoryOriginals.server.ts',
    'lib/carry/holderOriginCode.ts',
    'lib/carry/localHistoricalCashScenario.ts',
    'lib/carry/localHistoricalSampledCashTimeline.ts',
    'lib/carry/umbrellaGhoExit.ts',
    'lib/carry/umbrellaGhoNativeCapacity.server.ts',
    'lib/carry/umbrellaGhoNativeCapacity.ts',
    'lib/forecast/exitImpactForecast.ts',
    'scripts/lib/boundedLocalReceiptFile.mjs',
    'scripts/lib/depth-identity.mjs',
    'scripts/lib/depthCurve.mjs',
    'scripts/lib/historicalDepthQuoteStore.mjs',
    'scripts/lib/venue-reads.mjs',
    'scripts/research/carry-depth-quote-archive.mjs',
    'scripts/research/carry-depth-quote-provider-policy.json',
    'scripts/research/conditional-cash-time-holdout.mjs',
    'scripts/research/usd3-hypothetical-history-capture.mjs',
    'scripts/route-cohort/aug-2026-ab-vault-seed.json',
    'tools/venue-recorder.config.json',
  ],
  fluid_usdc_bridge: [
    'scripts/research/carry-depth-quote-provider-policy.json',
    'components/Carry/fixtures.ts',
    'components/Carry/types.ts',
    'lib/carry/conditionalGrossFlowHeadroom.ts',
    'lib/carry/conditionalSampledCashPathProjection.ts',
    'lib/carry/directSupplyMarketConstants.ts',
    'lib/carry/fluidBridgeUsdcJointHistoricalProcess.ts',
    'lib/carry/fluidExitCapacity.ts',
    'lib/carry/fluidUsdcBridgeJointHistoricalEvidence.server.ts',
    'lib/carry/fluidUsdcBridgeJointNativeEvidenceCodec.ts',
    'lib/carry/fluidUsdcBridgeJointTrustedProfile.ts',
    'lib/carry/fluidUsdcBridgeNativeAbi.ts',
    'lib/carry/fluidUsdcBridgeNativeCapacity.ts',
    'lib/carry/forecastRegistry.ts',
    'lib/carry/forecastRegistryMarkets.ts',
    'lib/carry/historicalCompetingFlowEstimate.ts',
    'lib/carry/historicalFlowDuration.ts',
    'lib/carry/holderExitCapacity.ts',
    'lib/carry/holderExitMechanisms.ts',
    'lib/carry/holderExitSubjectRegistry.ts',
    'lib/carry/holderNativeHistoryOriginals.server.ts',
    'lib/carry/holderOriginCode.ts',
    'lib/carry/morpho-v2-asset-identities.json',
    'lib/carry/other-vault-asset-identities.json',
    'lib/carry/usd3ExitQuote.ts',
    'scripts/lib/boundedLocalReceiptFile.mjs',
    'scripts/lib/depth-identity.mjs',
    'scripts/lib/depthCurve.mjs',
    'scripts/lib/historicalDepthQuoteStore.mjs',
    'scripts/lib/venue-reads.mjs',
    'scripts/research/carry-depth-quote-archive.mjs',
    'scripts/research/carry-fluid-capacity-prongs.mjs',
    'scripts/research/conditional-cash-time-holdout.mjs',
    'scripts/research/fluid-bridge-usdc-hypothetical-history-capture.mjs',
    'scripts/research/fluid-usdt-bridge-capacity-history-capture.mjs',
    'scripts/research/fluid-usdt-full-position-history-capture.mjs',
    'scripts/research/fluid-usdt-historical-conversion-capture.mjs',
    'scripts/research/fluid-usdt-whole-position-path-capture.mjs',
    'scripts/route-cohort/aug-2026-ab-vault-seed.json',
    'tools/venue-recorder.config.json',
  ],
  usd3: [
    'scripts/research/carry-depth-quote-provider-policy.json',
    'components/Carry/fixtures.ts',
    'components/Carry/types.ts',
    'lib/carry/conditionalGrossFlowHeadroom.ts',
    'lib/carry/conditionalSampledCashPathProjection.ts',
    'lib/carry/directSupplyMarketConstants.ts',
    'lib/carry/fluidBridgeUsdcJointHistoricalProcess.ts',
    'lib/carry/fluidUsdcBridgeNativeAbi.ts',
    'lib/carry/fluidUsdcBridgeNativeCapacity.ts',
    'lib/carry/forecastRegistry.ts',
    'lib/carry/forecastRegistryMarkets.ts',
    'lib/carry/historicalCompetingFlowEstimate.ts',
    'lib/carry/historicalFlowDuration.ts',
    'lib/carry/holderExitCapacity.ts',
    'lib/carry/holderExitMechanisms.ts',
    'lib/carry/holderExitSubjectRegistry.ts',
    'lib/carry/holderNativeHistoryOriginals.server.ts',
    'lib/carry/holderOriginCode.ts',
    'lib/carry/morpho-v2-asset-identities.json',
    'lib/carry/other-vault-asset-identities.json',
    'lib/carry/usd3ExitQuote.ts',
    'lib/carry/usd3JointHistoricalEvidence.server.ts',
    'lib/carry/usd3JointNativeEvidenceCodec.ts',
    'lib/carry/usd3JointTrustedProfile.ts',
    'scripts/lib/boundedLocalReceiptFile.mjs',
    'scripts/lib/depth-identity.mjs',
    'scripts/lib/depthCurve.mjs',
    'scripts/lib/historicalDepthQuoteStore.mjs',
    'scripts/lib/venue-reads.mjs',
    'scripts/research/carry-depth-quote-archive.mjs',
    'scripts/research/conditional-cash-time-holdout.mjs',
    'scripts/research/usd3-hypothetical-history-capture.mjs',
    'scripts/route-cohort/aug-2026-ab-vault-seed.json',
    'tools/venue-recorder.config.json',
  ],
} as const
type FileRecord = { file: string; bytes: number; fileSha256: string }
type SourceRecord = { source: string; bytes: Buffer; sha256: string }
type Batch = {
  batchIndex: number
  plan: FileRecord
  receipt: FileRecord
  planBodySha256: string
  receiptDeclaredBodySha256: string | null
  receiptComputedBodySha256: string
  capturedAccepted: boolean | null
  startedAtUtc: string | null
  availableAtUtc: string | null
  physicalStarts: number | null
}
type State = {
  kind: HolderNativeHistoryOriginalKind | null
  sharesRaw: string | null
  root?: string
  directory?: string
  sourceSnapshots: SourceRecord[]
  files: FileRecord[]
  incompleteFiles: string[]
  incompleteFileReservations: { file: string; reservedBytes: number }[]
  batches: Batch[]
  bytes: number
  startedAtUtc: string
  failure?: HolderNativeHistoryOriginalReason
  finished?: HolderNativeHistoryOriginalRetentionStatus
}
const states = new WeakMap<HolderNativeHistoryOriginalSeries, State>()
let lastStatus: HolderNativeHistoryOriginalRetentionStatus | null = null
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const fail = (reason: HolderNativeHistoryOriginalReason): never => {
  throw new Error(reason)
}
const enumReasons = new Set<HolderNativeHistoryOriginalReason>([
  'pending_replay',
  'qualified',
  'provider_unavailable',
  'plan_rejected',
  'capture_unavailable',
  'replay_rejected',
  'codec_rejected',
  'invalid_input',
  'not_local_repository',
  'filesystem_unavailable',
  'disk_reserve',
  'artifact_bound',
  'source_changed',
  'artifact_changed',
  'no_capture_recorded',
])
function reason(error: unknown): HolderNativeHistoryOriginalReason {
  return error instanceof Error &&
    enumReasons.has(error.message as HolderNativeHistoryOriginalReason)
    ? (error.message as HolderNativeHistoryOriginalReason)
    : 'filesystem_unavailable'
}
function snapshot(value: unknown, maxBytes = FILE_CAP): any {
  const seen = new WeakSet<object>()
  let bytes = 0,
    nodes = 0
  const copy = (v: any, depth: number): any => {
    if (++nodes > 120000 || depth > 48) fail('artifact_bound')
    if (v === null || typeof v === 'boolean') return v
    if (typeof v === 'string') {
      bytes += Buffer.byteLength(v)
      if (bytes > maxBytes) fail('artifact_bound')
      return v
    }
    if (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER)
      return v
    if (
      !v ||
      typeof v !== 'object' ||
      seen.has(v) ||
      Object.getOwnPropertySymbols(v).length ||
      Object.getPrototypeOf(v) !== (Array.isArray(v) ? Array.prototype : Object.prototype)
    )
      fail('invalid_input')
    seen.add(v)
    const descriptors = Object.getOwnPropertyDescriptors(v)
    if (Object.values(descriptors).some((d) => !Object.hasOwn(d, 'value'))) fail('invalid_input')
    let out: any
    if (Array.isArray(v)) {
      if (v.length > 4096 || Object.getOwnPropertyNames(v).length !== v.length + 1)
        fail('invalid_input')
      out = Array.from({ length: v.length }, (_, n) => {
        if (!descriptors[n]?.enumerable) fail('invalid_input')
        return copy(descriptors[n].value, depth + 1)
      })
    } else {
      out = {}
      for (const [k, d] of Object.entries(descriptors)) {
        if (!d.enumerable || ['__proto__', 'constructor', 'prototype'].includes(k))
          fail('invalid_input')
        bytes += Buffer.byteLength(k)
        if (bytes > maxBytes) fail('artifact_bound')
        out[k] = copy(d.value, depth + 1)
      }
    }
    seen.delete(v)
    return out
  }
  return copy(value, 0)
}
function exactKeys(v: any, keys: string[]) {
  if (
    !v ||
    Array.isArray(v) ||
    Object.keys(v).length !== keys.length ||
    !keys.every((k) => Object.hasOwn(v, k))
  )
    fail('invalid_input')
}
function safePath(root: string, relative: string, directory: boolean) {
  let p = root
  for (const part of relative.split('/')) {
    p = join(p, part)
    if (lstatSync(p).isSymbolicLink() || realpathSync(p) !== p) fail('not_local_repository')
  }
  const stat = lstatSync(p)
  if (directory ? !stat.isDirectory() : !stat.isFile()) fail('not_local_repository')
  return p
}
function readSource(root: string, source: string): Buffer {
  const path = safePath(root, source, false)
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = fstatSync(fd)
    if (!before.isFile() || before.size > FILE_CAP) fail('artifact_bound')
    const bytes = readFileSync(fd)
    const after = fstatSync(fd)
    if (
      bytes.length !== before.size ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    )
      fail('source_changed')
    return bytes
  } finally {
    closeSync(fd)
  }
}
function reserve(path: string, bytes: number) {
  const s = statfsSync(path)
  if (Number(s.bavail) * Number(s.bsize) < RESERVE + bytes) fail('disk_reserve')
}
function syncDirectory(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if (!fstatSync(fd).isDirectory()) fail('filesystem_unavailable')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
function write(state: State, name: string, bytes: Buffer): FileRecord {
  if (!state.directory || bytes.length > FILE_CAP || state.bytes + bytes.length > SERIES_CAP)
    fail('artifact_bound')
  if (
    !state.root ||
    safePath(state.root, state.directory.slice(state.root.length + 1), true) !== state.directory
  )
    fail('filesystem_unavailable')
  reserve(state.directory, bytes.length)
  const fd = openSync(
    join(state.directory, name),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  )
  // Charge conservatively before write/fsync can fail with bytes already on disk.
  state.bytes += bytes.length
  state.incompleteFiles.push(name)
  state.incompleteFileReservations.push({ file: name, reservedBytes: bytes.length })
  try {
    const s = fstatSync(fd)
    if (!s.isFile() || s.nlink !== 1 || (s.mode & 0o777) !== 0o600) fail('filesystem_unavailable')
    writeFileSync(fd, bytes)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  syncDirectory(state.directory)
  const file = { file: name, bytes: bytes.length, fileSha256: sha(bytes) }
  state.files.push(file)
  state.incompleteFiles = state.incompleteFiles.filter((f) => f !== name)
  state.incompleteFileReservations = state.incompleteFileReservations.filter((f) => f.file !== name)
  return file
}
function verifyFiles(state: State) {
  if (!state.directory || !state.root) return
  safePath(state.root, state.directory.slice(state.root.length + 1), true)
  for (const file of state.files) {
    const fd = openSync(join(state.directory, file.file), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const s = fstatSync(fd)
      if (
        !s.isFile() ||
        s.nlink !== 1 ||
        (s.mode & 0o777) !== 0o600 ||
        s.size !== file.bytes ||
        s.size > FILE_CAP ||
        sha(readFileSync(fd)) !== file.fileSha256
      )
        fail('artifact_changed')
    } finally {
      closeSync(fd)
    }
  }
}
const json = (v: unknown) => Buffer.from(JSON.stringify(v) + '\n')
function sourceClosureSha256(state: State) {
  if (!state.kind || state.sourceSnapshots.length !== sourceFiles[state.kind].length)
    return undefined
  return sha(
    JSON.stringify(
      state.sourceSnapshots.map((s) => ({
        source: s.source,
        bytes: s.bytes.length,
        sha256: s.sha256,
      })),
    ),
  )
}
function metadata(
  state: State,
  status: HolderNativeHistoryOriginalRetentionStatus['status'],
  why: HolderNativeHistoryOriginalReason,
  qualification = false,
  seals?: { file: string; body: string },
  producerReportedQualification?: boolean,
) {
  const result = Object.freeze({
    status,
    reason: why,
    kind: state.kind,
    producerReplayQualification: qualification,
    recordedBatches: state.batches.length,
    accountedSeriesBytes: state.bytes,
    ...(producerReportedQualification === undefined ? {} : { producerReportedQualification }),
    ...(state.directory ? { artifactDirectory: state.directory } : {}),
    ...(seals ? { manifestFileSha256: seals.file, manifestBodySha256: seals.body } : {}),
    ...(sourceClosureSha256(state) ? { sourceClosureSha256: sourceClosureSha256(state) } : {}),
    originalAuthority: false as const,
    authenticated: false as const,
    executionQualified: false as const,
    historicalOwnership: false as const,
  })
  lastStatus = result
  return result
}
/** Snapshot app-owned sources synchronously before the producer's first await. */
export function beginHolderNativeHistoryOriginalSeries(input: {
  kind: HolderNativeHistoryOriginalKind
  sharesRaw: string | null
}): HolderNativeHistoryOriginalSeries {
  const handle = Object.freeze({
    schema: 'holder_native_history_original_series_handle_v1' as const,
  })
  const state: State = {
    kind: null,
    sharesRaw: null,
    sourceSnapshots: [],
    files: [],
    incompleteFiles: [],
    incompleteFileReservations: [],
    batches: [],
    bytes: 0,
    startedAtUtc: new Date().toISOString(),
  }
  states.set(handle, state)
  try {
    const own = snapshot(input, 1024)
    exactKeys(own, ['kind', 'sharesRaw'])
    if (
      !Object.hasOwn(sourceFiles, own.kind) ||
      (!(
        (own.kind === 'umbrella_gho_current' ||
          own.kind === 'apy_usd_current' ||
          own.kind === 'fluid_usdt_bridge_current') &&
        own.sharesRaw === null
      ) &&
        (typeof own.sharesRaw !== 'string' ||
          !(own.kind === 'apy_usd_history' ? /^(0|[1-9][0-9]{0,77})$/ : /^[1-9][0-9]{0,77}$/).test(
            own.sharesRaw,
          ) ||
          BigInt(own.sharesRaw) > MAX))
    )
      fail('invalid_input')
    state.kind = own.kind
    state.sharesRaw = own.sharesRaw
    const root = process.cwd()
    if (realpathSync(root) !== root) fail('not_local_repository')
    try {
      const git = lstatSync(join(root, '.git'))
      if (git.isSymbolicLink() || (!git.isDirectory() && !git.isFile()))
        fail('not_local_repository')
    } catch {
      fail('not_local_repository')
    }
    safePath(root, 'data/research/venue-signals', true)
    state.root = root
    reserve(root, SERIES_CAP)
    let sourceBytes = 0
    state.sourceSnapshots = sourceFiles[state.kind!].map((source) => {
      const bytes = readSource(root, source)
      sourceBytes += bytes.length
      if (sourceBytes > SOURCE_CAP) fail('artifact_bound')
      return { source, bytes, sha256: sha(bytes) }
    })
    const base = join(root, 'data/research/venue-signals/holder-native-history-originals')
    try {
      mkdirSync(base, { mode: 0o700 })
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error
    }
    safePath(root, 'data/research/venue-signals/holder-native-history-originals', true)
    if ((lstatSync(base).mode & 0o777) !== 0o700) fail('filesystem_unavailable')
    state.directory = join(base, state.kind + '-' + randomUUID())
    mkdirSync(state.directory, { mode: 0o700 })
    syncDirectory(base)
    state.sourceSnapshots.forEach((s, n) =>
      write(
        state,
        'source-' + String(n).padStart(2, '0') + '-' + s.source.split('/').at(-1),
        s.bytes,
      ),
    )
    metadata(state, 'partial', 'pending_replay')
  } catch (error) {
    state.failure = reason(error)
    metadata(state, 'unavailable', state.failure)
  }
  return handle
}
/** Preserve raw bytes before replay, including captures later rejected by replay. */
export function recordHolderNativeHistoryOriginalBatch(
  handle: HolderNativeHistoryOriginalSeries,
  input: { batchIndex: number; plan: unknown; receipt: unknown; capturedAccepted: boolean },
): HolderNativeHistoryOriginalRetentionStatus {
  const state = states.get(handle)
  if (!state)
    return Object.freeze({
      status: 'unavailable',
      reason: 'invalid_input',
      kind: null,
      producerReplayQualification: false,
      recordedBatches: 0,
      originalAuthority: false,
      authenticated: false,
      executionQualified: false,
      historicalOwnership: false,
    })
  if (state.finished) return state.finished
  if (state.failure) return metadata(state, 'unavailable', state.failure)
  try {
    const own = snapshot(input, 2 * FILE_CAP)
    exactKeys(own, ['batchIndex', 'plan', 'receipt', 'capturedAccepted'])
    if (
      !Number.isSafeInteger(own.batchIndex) ||
      own.batchIndex !== state.batches.length ||
      own.batchIndex > 2 ||
      typeof own.capturedAccepted !== 'boolean'
    )
      fail('invalid_input')
    const planBytes = json(own.plan),
      receiptBytes = json(own.receipt)
    if (
      planBytes.length > FILE_CAP ||
      receiptBytes.length > FILE_CAP ||
      state.bytes + planBytes.length + receiptBytes.length > SERIES_CAP
    )
      fail('artifact_bound')
    const plan = write(state, 'batch-' + own.batchIndex + '-prepared-plan.json', planBytes)
    const receipt = write(state, 'batch-' + own.batchIndex + '-original-receipt.json', receiptBytes)
    const body =
      own.receipt && typeof own.receipt === 'object' && !Array.isArray(own.receipt)
        ? { ...own.receipt }
        : own.receipt
    if (body && typeof body === 'object' && !Array.isArray(body)) delete body.sha256
    state.batches.push({
      batchIndex: own.batchIndex,
      plan,
      receipt,
      planBodySha256: sha(Buffer.from(JSON.stringify(own.plan))),
      receiptDeclaredBodySha256:
        typeof own.receipt?.sha256 === 'string' ? own.receipt.sha256 : null,
      receiptComputedBodySha256: sha(Buffer.from(JSON.stringify(body))),
      capturedAccepted: own.capturedAccepted,
      startedAtUtc: typeof own.receipt?.startedAtUtc === 'string' ? own.receipt.startedAtUtc : null,
      availableAtUtc:
        typeof own.receipt?.availableAtUtc === 'string' ? own.receipt.availableAtUtc : null,
      physicalStarts: Number.isSafeInteger(own.receipt?.physicalStarts)
        ? own.receipt.physicalStarts
        : null,
    })
    return metadata(state, 'partial', 'pending_replay')
  } catch (error) {
    state.failure = reason(error)
    return metadata(state, 'partial', state.failure)
  }
}
export function finishHolderNativeHistoryOriginalSeries(
  handle: HolderNativeHistoryOriginalSeries,
  input: {
    qualification: boolean
    reason: HolderNativeHistoryOriginalReason
    batchQualifications: boolean[]
  },
): HolderNativeHistoryOriginalRetentionStatus {
  const state = states.get(handle)
  if (!state)
    return recordHolderNativeHistoryOriginalBatch(handle, {
      batchIndex: 0,
      plan: null,
      receipt: null,
      capturedAccepted: false,
    })
  if (state.finished) return state.finished
  try {
    let own = {
      qualification: false,
      reason: 'invalid_input' as HolderNativeHistoryOriginalReason,
      batchQualifications: [] as boolean[],
    }
    try {
      const copied = snapshot(input, 1024)
      exactKeys(copied, ['qualification', 'reason', 'batchQualifications'])
      if (
        typeof copied.qualification !== 'boolean' ||
        !enumReasons.has(copied.reason) ||
        !Array.isArray(copied.batchQualifications) ||
        copied.batchQualifications.length > 3 ||
        copied.batchQualifications.some((x: unknown) => typeof x !== 'boolean')
      )
        fail('invalid_input')
      own = copied
      // Native replay attempts remain separate from successfully retained batches.
      if (
        !state.failure &&
        (own.batchQualifications.length > state.batches.length ||
          (own.qualification &&
            (own.reason !== 'qualified' ||
              state.batches.length === 0 ||
              own.batchQualifications.length !== state.batches.length ||
              !own.batchQualifications.every(Boolean) ||
              state.batches.some((b) => b.capturedAccepted !== true))) ||
          (!own.qualification && own.reason === 'qualified'))
      )
        fail('invalid_input')
    } catch (error) {
      state.failure ??= reason(error)
    }
    if (
      state.root &&
      state.sourceSnapshots.some((s) => sha(readSource(state.root!, s.source)) !== s.sha256)
    )
      state.failure = 'source_changed'
    verifyFiles(state)
    const why = state.failure ?? (state.batches.length ? own.reason : 'no_capture_recorded')
    const qualification = !state.failure && own.qualification && state.batches.length > 0
    if (!state.directory) {
      state.finished = metadata(state, 'unavailable', why)
      return state.finished
    }
    const body = {
      schema: 'holder_native_history_originals_manifest_v1',
      kind: state.kind,
      sharesRaw: state.sharesRaw,
      startedAtUtc: state.startedAtUtc,
      completedAtUtc: new Date().toISOString(),
      producerReplayQualification: qualification,
      reason: why,
      producerReportedQualification: own.qualification,
      producerReportedBatchQualifications: own.batchQualifications,
      batchQualifications: state.batches.map((_b, n) => own.batchQualifications[n] ?? false),
      sourceSnapshots: state.sourceSnapshots.map((s) => ({
        source: s.source,
        bytes: s.bytes.length,
        sha256: s.sha256,
      })),
      ...(sourceClosureSha256(state) ? { sourceClosureSha256: sourceClosureSha256(state) } : {}),
      batches: state.batches,
      files: [...state.files],
      incompleteFiles: [...state.incompleteFiles],
      incompleteFileReservations: [...state.incompleteFileReservations],
      accountedSeriesBytesBeforeManifest: state.bytes,
      limits: { fileBytes: FILE_CAP, seriesBytes: SERIES_CAP, reserveBytes: RESERVE },
      originalAuthority: false,
      authenticated: false,
      executionQualified: false,
      historicalOwnership: false,
    }
    const bodySha256 = sha(Buffer.from(JSON.stringify(body)))
    const file = write(state, 'manifest.json', json({ ...body, sha256: bodySha256 }))
    state.finished = metadata(
      state,
      qualification ? 'retained' : 'partial',
      why,
      qualification,
      { file: file.fileSha256, body: bodySha256 },
      own.qualification,
    )
  } catch (error) {
    const detected = reason(error)
    // Detected integrity drift must not be masked by an earlier best-effort write failure.
    if (detected === 'source_changed' || detected === 'artifact_changed') state.failure = detected
    state.finished = metadata(state, 'unavailable', state.failure ?? detected)
  }
  state.sourceSnapshots = []
  return state.finished
}
/** Server diagnostics only; API/UI must never serialize this filesystem metadata. */
export function getLastHolderNativeHistoryOriginalRetentionStatus(): HolderNativeHistoryOriginalRetentionStatus | null {
  return lastStatus
}
