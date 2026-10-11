// Append-only, offline-verifiable archive for daily historical venue quotes.
// It is intentionally separate from local-depth-curves: historical rows never
// enter the live chronological recorder or inherit a historical receipt clock.
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { deflateRawSync, inflateRawSync } from 'node:zlib'

export const HISTORICAL_DEPTH_QUOTE_ROOT = resolve(
  'data/research/venue-signals/historical-depth-quotes',
)
export const MAX_HISTORICAL_QUOTE_RECORD_BYTES = 512 * 1024
export const MAX_HISTORICAL_QUOTE_CAPTURE_BYTES = 400 * 1024
export const MAX_HISTORICAL_QUOTE_ROSTER_BYTES = 256 * 1024
export const MAX_HISTORICAL_QUOTE_RECORDS = 2_880
export const MAX_HISTORICAL_QUOTE_FILES = 10_000
export const MAX_HISTORICAL_QUOTE_ATTEMPTS_PER_SLOT = 8
export const MAX_HISTORICAL_QUOTE_ARCHIVE_BYTES = 128 * 1024 * 1024
export const MIN_HISTORICAL_QUOTE_FREE_BYTES = 1_342_177_280
const SHA = /^[0-9a-f]{64}$/
const VENUE = /^[A-Za-z][A-Za-z0-9-]{0,63}$/
const DAY = /^\d{4}-\d\d-\d\d$/
const TEMP = /^.+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i
const LEVELS = [0.1, 0.25, 0.5, 1, 2, 5, 10]
const sha = (value) => createHash('sha256').update(value).digest('hex')
const canonicalHostname = (value) => value.toLowerCase().replace(/\.$/, '')
const fail = (reason) => {
  throw new Error(`historical_depth_quote_${reason}`)
}

// This is a projection of four bounded header fields, not a replay of the full
// block response. The wire hash/size commit to the discarded transaction body.
export function isValidHistoricalQuoteHeaderProjection(entry) {
  const result = entry?.response?.result
  return entry?.evidenceType === 'block_header_projection_v1' &&
    JSON.stringify(Object.keys(entry).sort()) ===
      JSON.stringify(['evidenceType', 'fullResponseBytes', 'fullResponseSha256', 'request', 'response']) &&
    typeof entry.fullResponseSha256 === 'string' &&
    SHA.test(entry.fullResponseSha256 ?? '') &&
    Number.isSafeInteger(entry.fullResponseBytes) && entry.fullResponseBytes > 0 &&
    entry.fullResponseBytes <= 1024 * 1024 &&
    result && JSON.stringify(Object.keys(result).sort()) ===
      JSON.stringify(['hash', 'number', 'parentHash', 'timestamp']) &&
    isValidHistoricalQuoteBlockHeader(entry)
}

// Shared header identity validation also applies to newly captured full blocks.
// Full block bodies may contain additional result fields.
export function isValidHistoricalQuoteBlockHeader(entry) {
  const result = entry?.response?.result
  const request = entry?.request
  return request?.method === 'eth_getBlockByNumber' && request.jsonrpc === '2.0' &&
    Number.isSafeInteger(request.id) && request.id > 0 &&
    JSON.stringify(Object.keys(request).sort()) === JSON.stringify(['id', 'jsonrpc', 'method', 'params']) &&
    Array.isArray(request.params) && request.params.length === 2 && request.params[1] === false &&
    typeof request.params[0] === 'string' &&
    /^(finalized|0x(?:0|[1-9a-f][0-9a-f]{0,15}))$/.test(request.params[0]) &&
    entry.response?.jsonrpc === '2.0' && entry.response.id === request.id &&
    JSON.stringify(Object.keys(entry.response).sort()) === JSON.stringify(['id', 'jsonrpc', 'result']) &&
    result && typeof result === 'object' && !Array.isArray(result) &&
    ['hash', 'parentHash'].every((key) => typeof result[key] === 'string' && /^0x[0-9a-fA-F]{64}$/.test(result[key])) &&
    ['number', 'timestamp'].every((key) => typeof result[key] === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]{0,15})$/.test(result[key])) &&
    (request.params[0] === 'finalized' || BigInt(result.number) === BigInt(request.params[0]))
}

function validAnchorEvidence(body) {
  if (!Array.isArray(body.headerEvidence) || body.headerEvidence.length > 32) return false
  if (body.headerEvidenceType === 'block_header_projection_v1')
    return body.headerEvidence.length > 0 && body.headerEvidence.every(isValidHistoricalQuoteHeaderProjection)
  return body.headerEvidenceType === undefined && body.headerEvidence.every((entry) =>
    entry.evidenceType === undefined && entry.fullResponseSha256 === undefined && entry.fullResponseBytes === undefined)
}

function canonicalUtc(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    fail('invalid_clock')
  return value
}

function safeJsonFile(path, cap) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > cap) fail('file_invalid')
  const bytes = readFileSync(path, 'utf8')
  if (Buffer.byteLength(bytes) > cap) fail('file_size')
  return JSON.parse(bytes)
}

function isUnpublishedTemp(name) {
  return TEMP.test(name)
}

function safeDirectory(path) {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('directory_invalid')
  const names = readdirSync(path)
  if (names.length > MAX_HISTORICAL_QUOTE_FILES) fail('file_count_limit')
  return names.filter((name) => !isUnpublishedTemp(name))
}

function cleanupUnpublishedTemps(path, state = { entries: 0, bytes: 0 }) {
  if (!existsSync(path)) return state
  state.entries += 1
  if (state.entries > MAX_HISTORICAL_QUOTE_FILES) fail('file_count_limit')
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) fail('symlink')
  if (stat.isDirectory()) {
    for (const name of readdirSync(path)) {
      const child = join(path, name)
      const childStat = lstatSync(child)
      if (isUnpublishedTemp(name)) {
        if (
          !childStat.isFile() ||
          childStat.isSymbolicLink() ||
          childStat.size > MAX_HISTORICAL_QUOTE_RECORD_BYTES
        )
          fail('temp_file_invalid')
        state.bytes += childStat.size
        if (state.bytes > MAX_HISTORICAL_QUOTE_ARCHIVE_BYTES) fail('temp_recovery_limit')
        unlinkSync(child)
      } else if (childStat.isDirectory()) cleanupUnpublishedTemps(child, state)
      else if (!childStat.isFile()) fail('file_type')
    }
    return state
  }
  if (!stat.isFile()) fail('file_type')
  return state
}

const PYTHON_FLOCK = [
  'import fcntl, os, stat',
  'fd = 3',
  'if not stat.S_ISREG(os.fstat(fd).st_mode): sys.exit(74)',
  'try: fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)',
  'except BlockingIOError: print("BUSY", flush=True); sys.exit(73)',
  'print("LOCKED", flush=True)',
].join('\n')

/** OS advisory lock is released by the kernel if the owner process dies. */
export async function acquireHistoricalQuoteWriterLock(
  root = HISTORICAL_DEPTH_QUOTE_ROOT,
  { python = process.env.PYTHON ?? 'python3' } = {},
) {
  mkdirSync(root, { recursive: true })
  const rootStat = lstatSync(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('directory_invalid')
  const lockPath = join(root, '.writer.lock')
  let lockFd
  try {
    lockFd = openSync(
      lockPath,
      fsConstants.O_CREAT | fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    )
    if (!lstatSync(lockPath).isFile()) fail('lock_file_invalid')
  } catch {
    fail('writer_lock_unavailable')
  }
  const child = spawn(python, ['-c', PYTHON_FLOCK], {
    stdio: ['ignore', 'pipe', 'ignore', lockFd],
  })
  const lines = createInterface({ input: child.stdout })
  let firstLine
  try {
    firstLine = await new Promise((resolve, reject) => {
      lines.once('line', (line) => {
        firstLine = line
        resolve(line)
      })
      child.once('error', reject)
      child.once('exit', (code, signal) => {
        if (firstLine === undefined) reject(new Error(`lock_exit_${code ?? signal}`))
      })
    })
  } catch {
    lines.close()
    closeSync(lockFd)
    fail('writer_lock_unavailable')
  }
  if (firstLine !== 'LOCKED') {
    lines.close()
    closeSync(lockFd)
    fail(firstLine === 'BUSY' ? 'writer_busy' : 'writer_lock_unavailable')
  }
  try {
    cleanupUnpublishedTemps(root)
  } catch (error) {
    lines.close()
    closeSync(lockFd)
    fail(error?.message?.replace(/^historical_depth_quote_/, '') ?? 'temp_recovery_failed')
  }
  let released = false
  const release = async () => {
    if (released) return
    released = true
    closeSync(lockFd)
    lines.close()
  }
  release.assertHeld = () => {
    if (released) fail('writer_lock_lost')
  }
  return release
}

// A complete capture inside a failed attempt is eligible only after this
// structural validation AND the collector's header/code/exact replay validator.
export function validateHistoricalQuoteCapture(capture, attempt, roster, anchor, venue) {
  if (attempt.rosterId !== roster.rosterId || attempt.venue !== venue.name ||
      attempt.anchorDay !== anchor.day || attempt.source?.block !== anchor.block ||
      attempt.source?.hash !== anchor.blockHash || attempt.source?.time !== anchor.blockTimeUtc ||
      attempt.configIdentity !== venue.configIdentity ||
      JSON.stringify(attempt.marketIdentities) !== JSON.stringify(venue.marketIdentities) ||
      JSON.stringify(attempt.levels) !== JSON.stringify(LEVELS) ||
      attempt.rosterSha256 !== roster.sha256 || attempt.anchorSha256 !== anchor.sha256)
    fail('capture_identity_mismatch')
  const providerIds = new Set(roster.providers.map((provider) => provider.host))
  if (
    !providerIds.has(capture.host) ||
    !roster.providers.some(
      (provider) => provider.host === capture.host && provider.uriSha256 === capture.uriSha256,
    ) ||
    capture.reason !== null ||
    !Array.isArray(capture.rawRpcTrace) ||
    !capture.rawRpcTrace.some((entry) => entry.request?.method === 'eth_call') ||
    !capture.rawRpcTrace.some((entry) => entry.request?.method === 'eth_getCode') ||
    !capture.rawRpcTrace.some((entry) => entry.request?.method === 'eth_getStorageAt') ||
    !capture.output?.nav ||
    !Array.isArray(capture.output.markets)
  )
    fail('verified_evidence_incomplete')
  if (!isValidSuccessfulHistoricalQuoteTrace(capture.rawRpcTrace))
    fail('verified_rpc_envelope_invalid')
  const startedAt = Date.parse(canonicalUtc(capture.startedAtUtc))
  const completedAt = Date.parse(canonicalUtc(capture.completedAtUtc))
  if (
    completedAt < startedAt ||
    completedAt > Date.parse(canonicalUtc(attempt.firstLocalReceiptAtUtc)) ||
    startedAt < Date.parse(anchor.blockTimeUtc)
  )
    fail('verified_clock_order')
  const expectedMarkets = Object.keys(venue.marketIdentities).sort()
  const actualMarkets = capture.output.markets.map((market) => market.market).sort()
  if (
    capture.output.markets.length !== venue.markets.length ||
    new Set(actualMarkets).size !== actualMarkets.length ||
    JSON.stringify(actualMarkets) !== JSON.stringify(expectedMarkets) ||
    capture.output.markets.some(
      (market) =>
        venue.marketIdentities[market.market] !== market.configIdentity ||
        !Array.isArray(market.points) ||
        market.points.length !== LEVELS.length ||
        market.points.some(
          (point, index) =>
            point.costPct !== LEVELS[index] ||
            typeof point.capacityUsd !== 'number' ||
            !Number.isFinite(point.capacityUsd) ||
            point.capacityUsd < 0 ||
            (index > 0 && point.capacityUsd < market.points[index - 1].capacityUsd),
        ),
    )
  )
    fail('verified_market_output_invalid')
}

function validateVerifiedAttempt(attempt, roster, anchor, venue, captures = attempt.captures) {
  if (!Array.isArray(captures) || captures.length !== 2) fail('verified_evidence_incomplete')
  for (const capture of captures) validateHistoricalQuoteCapture(capture, attempt, roster, anchor, venue)
  if (captures[0].host === captures[1].host || captures[0].uriSha256 === captures[1].uriSha256 ||
      JSON.stringify(captures[0].code) !== JSON.stringify(captures[1].code) ||
      JSON.stringify(captures[0].output) !== JSON.stringify(captures[1].output))
    fail('verified_provider_disagreement')
}

export const historicalQuoteCaptureSha256 = (capture) => sha(JSON.stringify(capture))
const isCaptureReference = (capture) => capture?.evidenceType === 'capture_reference_v1'
const CAPTURE_CODEC = 'complete_capture_deflate_raw_v1'
const isCompressedCapture = (capture) => capture?.evidenceType === CAPTURE_CODEC

// The caller validates complete evidence before encoding. Stored bytes preserve
// the entire existing capture JSON, rather than projecting any RPC evidence.
export function encodeHistoricalQuoteCapture(capture) {
  if (!capture || typeof capture !== 'object' || Array.isArray(capture) ||
      capture.evidenceType !== undefined || capture.reason !== null ||
      !Array.isArray(capture.rawRpcTrace)) fail('capture_codec_source_invalid')
  const raw = Buffer.from(JSON.stringify(capture))
  if (raw.length > MAX_HISTORICAL_QUOTE_CAPTURE_BYTES) fail('evidence_over_limit_individual_capture')
  const compressed = deflateRawSync(raw, { level: 6 })
  const encoded = {
    evidenceType: CAPTURE_CODEC,
    contentSha256: sha(raw),
    uncompressedBytes: raw.length,
    compressedSha256: sha(compressed),
    payload: compressed.toString('base64'),
  }
  return Buffer.byteLength(JSON.stringify(encoded)) < raw.length ? encoded : capture
}

export function decodeHistoricalQuoteCapture(entry) {
  if (!isCompressedCapture(entry)) {
    if (entry?.evidenceType !== undefined) fail('capture_codec_invalid')
    return entry
  }
  if (Array.isArray(entry) || JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify([
    'compressedSha256', 'contentSha256', 'evidenceType', 'payload', 'uncompressedBytes',
  ]) || typeof entry.contentSha256 !== 'string' || !SHA.test(entry.contentSha256) ||
      typeof entry.compressedSha256 !== 'string' || !SHA.test(entry.compressedSha256) ||
      !Number.isSafeInteger(entry.uncompressedBytes) || entry.uncompressedBytes < 1 ||
      entry.uncompressedBytes > MAX_HISTORICAL_QUOTE_CAPTURE_BYTES ||
      typeof entry.payload !== 'string' || entry.payload.length < 4 ||
      entry.payload.length > Math.ceil(MAX_HISTORICAL_QUOTE_CAPTURE_BYTES / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(entry.payload))
    fail('capture_codec_invalid')
  const compressed = Buffer.from(entry.payload, 'base64')
  if (compressed.length > MAX_HISTORICAL_QUOTE_CAPTURE_BYTES ||
      compressed.toString('base64') !== entry.payload || sha(compressed) !== entry.compressedSha256)
    fail('capture_codec_invalid')
  let raw, capture
  try {
    const decoded = inflateRawSync(compressed, { maxOutputLength: MAX_HISTORICAL_QUOTE_CAPTURE_BYTES, info: true })
    raw = decoded.buffer
    if (decoded.engine.bytesWritten !== compressed.length || raw.length !== entry.uncompressedBytes ||
        sha(raw) !== entry.contentSha256) fail('capture_codec_invalid')
    capture = JSON.parse(raw.toString('utf8'))
    if (!capture || typeof capture !== 'object' || Array.isArray(capture) ||
        capture.evidenceType !== undefined || capture.reason !== null ||
        !Array.isArray(capture.rawRpcTrace) || !Buffer.from(JSON.stringify(capture)).equals(raw))
      fail('capture_codec_invalid')
  } catch {
    fail('capture_codec_invalid')
  }
  return capture
}

// References derive their path from this slot and never follow another reference.
function materializeCaptures(record, earlier, roster, anchor, venue) {
  if (!Array.isArray(record.captures)) fail('capture_reference_invalid')
  const v3 = record.study === 'historical-depth-quote-attempt-v3'
  const referencesAllowed = v3 || record.study === 'historical-depth-quote-attempt-v2'
  return record.captures.map((entry) => {
    if (!isCaptureReference(entry)) {
      if (isCompressedCapture(entry)) {
        if (!v3) fail('capture_codec_version_invalid')
        const decoded = decodeHistoricalQuoteCapture(entry)
        validateHistoricalQuoteCapture(decoded, record, roster, anchor, venue)
        return decoded
      }
      if (entry?.evidenceType !== undefined) fail('capture_reference_invalid')
      return entry
    }
    if (!referencesAllowed || JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify([
      'captureIndex', 'captureSha256', 'evidenceType', 'sourceAttemptSequence', 'sourceAttemptSha256',
    ]) || !Number.isSafeInteger(entry.sourceAttemptSequence) || entry.sourceAttemptSequence < 1 ||
      entry.sourceAttemptSequence >= record.sequence || !Number.isSafeInteger(entry.captureIndex) ||
      entry.captureIndex < 0 || entry.captureIndex > 1 ||
      typeof entry.sourceAttemptSha256 !== 'string' || !SHA.test(entry.sourceAttemptSha256) ||
      typeof entry.captureSha256 !== 'string' || !SHA.test(entry.captureSha256))
      fail('capture_reference_invalid')
    if (record.rosterSha256 !== roster.sha256 || record.anchorSha256 !== anchor.sha256 ||
        record.configIdentity !== venue.configIdentity ||
        JSON.stringify(record.marketIdentities) !== JSON.stringify(venue.marketIdentities) ||
        JSON.stringify(record.levels) !== JSON.stringify(LEVELS) ||
        record.source?.block !== anchor.block || record.source?.hash !== anchor.blockHash ||
        record.source?.time !== anchor.blockTimeUtc) fail('capture_identity_mismatch')
    const source = earlier.find((row) => row.sequence === entry.sourceAttemptSequence)
    if (!source || source.sha256 !== entry.sourceAttemptSha256 || source.rosterId !== record.rosterId ||
      source.venue !== record.venue || source.anchorDay !== record.anchorDay ||
      Date.parse(source.firstLocalReceiptAtUtc) > Date.parse(record.firstLocalReceiptAtUtc))
      fail('capture_reference_source_mismatch')
    const storedCapture = source.captures?.[entry.captureIndex]
    if (!storedCapture || isCaptureReference(storedCapture)) fail('capture_reference_proof_mismatch')
    if (isCompressedCapture(storedCapture) && source.study !== 'historical-depth-quote-attempt-v3')
      fail('capture_codec_version_invalid')
    const capture = decodeHistoricalQuoteCapture(storedCapture)
    if (historicalQuoteCaptureSha256(capture) !== entry.captureSha256)
      fail('capture_reference_proof_mismatch')
    validateHistoricalQuoteCapture(capture, source, roster, anchor, venue)
    return capture
  })
}

export function resolveHistoricalQuoteCaptures(record, { root = HISTORICAL_DEPTH_QUOTE_ROOT } = {}) {
  const rows = readHistoricalQuoteAttempts(record.rosterId, record.venue, record.anchorDay, { root })
  const sealed = rows.find((row) => row.sequence === record.sequence && row.sha256 === record.sha256)
  if (!sealed) fail('capture_reference_source_mismatch')
  const roster = readHistoricalQuoteRoster(record.rosterId, { root })
  const anchor = readHistoricalQuoteAnchor(record.rosterId, record.anchorDay, { root })
  return materializeCaptures(sealed, rows.filter((row) => row.sequence < record.sequence), roster, anchor,
    roster.venues.find((venue) => venue.name === record.venue))
}

export function isValidSuccessfulHistoricalQuoteTrace(trace) {
  if (!Array.isArray(trace) || trace.length === 0) return false
  const ids = new Set()
  return trace.every((entry) => {
    const request = entry?.request
    const response = entry?.response
    if (
      request?.jsonrpc !== '2.0' ||
      JSON.stringify(Object.keys(request).sort()) !==
        JSON.stringify(['id', 'jsonrpc', 'method', 'params']) ||
      !Number.isSafeInteger(request.id) ||
      request.id < 1 ||
      ids.has(request.id) ||
      typeof request.method !== 'string' ||
      !Array.isArray(request.params) ||
      response?.jsonrpc !== '2.0' ||
      response.id !== request.id
    )
      return false
    ids.add(request.id)
    const hasResult = Object.hasOwn(response, 'result')
    const hasError = Object.hasOwn(response, 'error')
    const expectedResponseKeys = hasResult
      ? ['id', 'jsonrpc', 'result']
      : ['error', 'id', 'jsonrpc']
    return (
      hasResult !== hasError &&
      hasResult &&
      JSON.stringify(Object.keys(response).sort()) === JSON.stringify(expectedResponseKeys)
    )
  })
}

function seal(body) {
  return { ...body, sha256: sha(JSON.stringify(body)) }
}

function verifySealed(value, expectedStudy) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('json_invalid')
  const { sha256, ...body } = value
  if (sha256 !== sha(JSON.stringify(body))) fail('sha_mismatch')
  if (body.study !== expectedStudy) fail('study_mismatch')
  return body
}

function rosterPath(root, rosterId) {
  if (!SHA.test(rosterId)) fail('roster_id_invalid')
  return join(root, `roster-${rosterId}.json`)
}

function anchorPath(root, rosterId, day) {
  if (!DAY.test(day)) fail('anchor_day_invalid')
  return join(root, `roster-${rosterId}`, 'anchors', `${day}.json`)
}

function anchorFailureDir(root, rosterId, day) {
  if (!DAY.test(day)) fail('anchor_day_invalid')
  return join(root, `roster-${rosterId}`, 'anchor-failures', day)
}

function slotPath(root, rosterId, venue, day) {
  if (!VENUE.test(venue) || !DAY.test(day)) fail('slot_invalid')
  return join(root, `roster-${rosterId}`, 'records', venue, day)
}

function walkBytes(path, state = { entries: 0 }) {
  state.entries += 1
  if (state.entries > MAX_HISTORICAL_QUOTE_FILES) fail('file_count_limit')
  if (!existsSync(path)) return 0
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) fail('symlink')
  if (stat.isFile()) return stat.size
  if (!stat.isDirectory()) fail('file_type')
  return readdirSync(path).reduce((total, name) => total + walkBytes(join(path, name), state), 0)
}

function diskReserve(root, additional, stat = statfsSync) {
  let ancestor = root
  while (!existsSync(ancestor)) {
    const parent = resolve(ancestor, '..')
    if (parent === ancestor) fail('disk_ancestor_missing')
    ancestor = parent
  }
  const volume = stat(ancestor)
  if (Number(volume.bavail) * Number(volume.bsize) - additional < MIN_HISTORICAL_QUOTE_FREE_BYTES)
    fail('disk_reserve')
}

function atomicImmutableWrite(path, bytes, { cap, root, stat = statfsSync }) {
  if (Buffer.byteLength(bytes) > cap) fail('record_size')
  const used = walkBytes(root)
  if (used + Buffer.byteLength(bytes) > MAX_HISTORICAL_QUOTE_ARCHIVE_BYTES) fail('archive_byte_cap')
  diskReserve(root, Buffer.byteLength(bytes), stat)
  mkdirSync(resolve(path, '..'), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  let fd
  try {
    fd = openSync(temp, 'wx', 0o600)
    writeFileSync(fd, bytes)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    // link gives immutable create-if-absent semantics across concurrent writers.
    try {
      linkSync(temp, path)
      const directoryFd = openSync(resolve(path, '..'), 'r')
      try {
        fsyncSync(directoryFd)
      } finally {
        closeSync(directoryFd)
      }
    } catch (error) {
      if (error?.code === 'EEXIST') fail('immutable_exists')
      throw error
    }
  } finally {
    if (fd !== undefined) closeSync(fd)
    if (existsSync(temp)) unlinkSync(temp)
  }
}

// Reserve the whole bounded multi-record operation before acquisition begins.
export function assertHistoricalQuoteWriteCapacity(additionalBytes, { root = HISTORICAL_DEPTH_QUOTE_ROOT, stat = statfsSync } = {}) {
  if (!Number.isSafeInteger(additionalBytes) || additionalBytes <= 0 || additionalBytes > MAX_HISTORICAL_QUOTE_ARCHIVE_BYTES)
    fail('storage_reservation_invalid')
  if (walkBytes(root) + additionalBytes > MAX_HISTORICAL_QUOTE_ARCHIVE_BYTES) fail('archive_byte_cap')
  diskReserve(root, additionalBytes, stat)
}

export function sealHistoricalQuoteRoster(input) {
  const createdAtUtc = canonicalUtc(input.createdAtUtc)
  if (
    !Array.isArray(input.anchors) ||
    input.anchors.length !== 120 ||
    input.anchors.some(
      (day, index) => !DAY.test(day) || (index && day <= input.anchors[index - 1]),
    ) ||
    !Array.isArray(input.venues) ||
    input.venues.length !== 3 ||
    !Array.isArray(input.providers) ||
    input.providers.length !== 2 ||
    input.providers[0].host === input.providers[1].host ||
    input.providers.some(
      (provider) =>
        typeof provider.host !== 'string' ||
        !/^[a-z0-9.-]{1,253}$/.test(provider.host) ||
        provider.host !== canonicalHostname(provider.host) ||
        !SHA.test(provider.uriSha256 ?? ''),
    ) ||
    new Set(input.venues.map((venue) => venue?.name)).size !== 3 ||
    input.venues.some(
      (venue) =>
        !VENUE.test(venue?.name ?? '') ||
        !SHA.test(venue?.configIdentity ?? '') ||
        !venue?.marketIdentities ||
        !Object.keys(venue.marketIdentities).length ||
        Object.values(venue.marketIdentities).some((identity) => !SHA.test(identity)),
    )
  )
    fail('roster_invalid')
  const core = {
    study: 'historical-depth-quote-roster-v1',
    createdAtUtc,
    chainId: 1,
    anchors: input.anchors,
    venues: input.venues,
    providers: input.providers,
  }
  const rosterId = sha(JSON.stringify(core))
  return { rosterId, record: seal({ ...core, rosterId }) }
}

export function writeHistoricalQuoteRoster(
  input,
  { root = HISTORICAL_DEPTH_QUOTE_ROOT, stat } = {},
) {
  const sealed = sealHistoricalQuoteRoster(input)
  const path = rosterPath(root, sealed.rosterId)
  if (existsSync(path)) return readHistoricalQuoteRoster(sealed.rosterId, { root })
  atomicImmutableWrite(path, `${JSON.stringify(sealed.record)}\n`, {
    cap: MAX_HISTORICAL_QUOTE_ROSTER_BYTES,
    root,
    ...(stat ? { stat } : {}),
  })
  return sealed.record
}

export function readHistoricalQuoteRoster(rosterId, { root = HISTORICAL_DEPTH_QUOTE_ROOT } = {}) {
  const record = safeJsonFile(rosterPath(root, rosterId), MAX_HISTORICAL_QUOTE_ROSTER_BYTES)
  const body = verifySealed(record, 'historical-depth-quote-roster-v1')
  const { rosterId: storedId, ...core } = body
  if (
    storedId !== rosterId ||
    sha(JSON.stringify(core)) !== rosterId ||
    sealHistoricalQuoteRoster({
      createdAtUtc: body.createdAtUtc,
      anchors: body.anchors,
      venues: body.venues,
      providers: body.providers,
    }).rosterId !== rosterId
  )
    fail('roster_id_mismatch')
  return record
}

export function writeHistoricalQuoteAnchor(
  rosterId,
  input,
  { root = HISTORICAL_DEPTH_QUOTE_ROOT, stat, now = () => new Date() } = {},
) {
  const roster = readHistoricalQuoteRoster(rosterId, { root })
  const body = {
    study: 'historical-depth-quote-anchor-v1',
    rosterId,
    day: input.day,
    targetAtUtc: canonicalUtc(input.targetAtUtc),
    selectedProviderId: input.selectedProviderId,
    chainId: 1,
    block: String(input.block),
    blockHash: input.blockHash,
    blockTimeUtc: canonicalUtc(input.blockTimeUtc),
    offsetSeconds: input.offsetSeconds,
    headerEvidence: input.headerEvidence,
    ...(input.headerEvidenceType !== undefined ? { headerEvidenceType: input.headerEvidenceType } : {}),
    firstLocalReceiptAtUtc: canonicalUtc(now().toISOString()),
  }
  const expectedTarget = `${body.day}T00:00:00.000Z`
  const expectedOffset =
    Math.floor(Date.parse(expectedTarget) / 1000) - Math.floor(Date.parse(body.blockTimeUtc) / 1000)
  if (
    !roster.anchors.includes(body.day) ||
    body.targetAtUtc !== expectedTarget ||
    !/^0x[0-9a-f]{64}$/.test(body.blockHash) ||
    !/^\d{1,20}$/.test(body.block) ||
    !Number.isSafeInteger(body.offsetSeconds) ||
    body.offsetSeconds < 0 ||
    body.offsetSeconds > 86_400 ||
    body.offsetSeconds !== expectedOffset ||
    Date.parse(body.firstLocalReceiptAtUtc) < Date.parse(body.blockTimeUtc)
  )
    fail('anchor_invalid')
  const record = seal(body)
  if (!validAnchorEvidence(body)) fail('anchor_header_evidence_invalid')
  const path = anchorPath(root, rosterId, body.day)
  if (existsSync(path)) {
    const existing = safeJsonFile(path, 64 * 1024)
    if (
      existing.rosterId !== record.rosterId ||
      existing.day !== record.day ||
      existing.block !== record.block ||
      existing.blockHash !== record.blockHash
    )
      fail('anchor_conflict')
    return existing
  }
  atomicImmutableWrite(path, `${JSON.stringify(record)}\n`, {
    cap: 64 * 1024,
    root,
    ...(stat ? { stat } : {}),
  })
  return record
}

export function readHistoricalQuoteAnchor(
  rosterId,
  day,
  { root = HISTORICAL_DEPTH_QUOTE_ROOT } = {},
) {
  const roster = readHistoricalQuoteRoster(rosterId, { root })
  const record = safeJsonFile(anchorPath(root, rosterId, day), 64 * 1024)
  const body = verifySealed(record, 'historical-depth-quote-anchor-v1')
  if (body.rosterId !== rosterId || body.day !== day || !roster.anchors.includes(day))
    fail('anchor_identity_mismatch')
  if (!validAnchorEvidence(body)) fail('anchor_header_evidence_invalid')
  return record
}

export function appendHistoricalQuoteAnchorFailure(
  rosterId,
  day,
  failure,
  { root = HISTORICAL_DEPTH_QUOTE_ROOT, stat, now = () => new Date() } = {},
) {
  const roster = readHistoricalQuoteRoster(rosterId, { root })
  if (!roster.anchors.includes(day) || typeof failure.reason !== 'string')
    fail('anchor_failure_invalid')
  const directory = anchorFailureDir(root, rosterId, day)
  const previous = existsSync(directory) ? safeDirectory(directory).sort() : []
  if (previous.length >= MAX_HISTORICAL_QUOTE_ATTEMPTS_PER_SLOT) fail('anchor_attempt_limit')
  const sequence = previous.length + 1
  const record = seal({
    study: 'historical-depth-quote-anchor-failure-v1',
    rosterId,
    rosterSha256: roster.sha256,
    day,
    sequence,
    reason: failure.reason,
    firstLocalReceiptAtUtc: canonicalUtc(now().toISOString()),
    evidence: failure.evidence ?? null,
  })
  atomicImmutableWrite(
    join(directory, `attempt-${String(sequence).padStart(2, '0')}.json`),
    `${JSON.stringify(record)}\n`,
    { cap: MAX_HISTORICAL_QUOTE_RECORD_BYTES, root, ...(stat ? { stat } : {}) },
  )
  return record
}

export function readHistoricalQuoteAnchorFailures(
  rosterId,
  day,
  { root = HISTORICAL_DEPTH_QUOTE_ROOT } = {},
) {
  const directory = anchorFailureDir(root, rosterId, day)
  if (!existsSync(directory)) return []
  const names = safeDirectory(directory).sort()
  if (names.length > MAX_HISTORICAL_QUOTE_ATTEMPTS_PER_SLOT) fail('anchor_attempt_limit')
  return names.map((name, index) => {
    if (name !== `attempt-${String(index + 1).padStart(2, '0')}.json`)
      fail('anchor_attempt_sequence')
    const record = safeJsonFile(join(directory, name), MAX_HISTORICAL_QUOTE_RECORD_BYTES)
    verifySealed(record, 'historical-depth-quote-anchor-failure-v1')
    if (record.rosterId !== rosterId || record.day !== day || record.sequence !== index + 1)
      fail('anchor_attempt_identity_mismatch')
    return record
  })
}

export function appendHistoricalQuoteAttempt(
  rosterId,
  venue,
  day,
  attempt,
  { root = HISTORICAL_DEPTH_QUOTE_ROOT, stat, now = () => new Date() } = {},
) {
  const roster = readHistoricalQuoteRoster(rosterId, { root })
  const anchor = readHistoricalQuoteAnchor(rosterId, day, { root })
  if (!roster.venues.some((entry) => entry.name === venue)) fail('venue_not_in_roster')
  if (attempt.rosterId !== rosterId || attempt.anchorDay !== day || attempt.venue !== venue)
    fail('attempt_identity_mismatch')
  if (!['verified', 'failed'].includes(attempt.status)) fail('attempt_status_invalid')
  if (attempt.status === 'failed' && typeof attempt.reason !== 'string')
    fail('failure_reason_missing')
  const rows = readHistoricalQuoteAttempts(rosterId, venue, day, { root })
  const firstLocalReceiptAtUtc = canonicalUtc(now().toISOString())
  if (rows.length >= MAX_HISTORICAL_QUOTE_ATTEMPTS_PER_SLOT) fail('attempt_limit')
  if (attempt.status === 'verified' && rows.some((row) => row.status === 'verified'))
    fail('verified_slot_immutable')
  const body = {
    ...attempt,
    study: attempt.captures?.some(isCompressedCapture) ? 'historical-depth-quote-attempt-v3' :
      attempt.captures?.some(isCaptureReference) ? 'historical-depth-quote-attempt-v2' : 'historical-depth-quote-attempt-v1',
    sequence: rows.length + 1,
    rosterId,
    rosterSha256: roster.sha256,
    anchorSha256: anchor.sha256,
    venue,
    anchorDay: day,
    firstLocalReceiptAtUtc,
  }
  const venueRecord = roster.venues.find((entry) => entry.name === venue)
  const captures = materializeCaptures(body, rows, roster, anchor, venueRecord)
  if (attempt.status === 'verified') validateVerifiedAttempt(body, roster, anchor, venueRecord, captures)
  const record = seal(body)
  const path = join(
    slotPath(root, rosterId, venue, day),
    `attempt-${String(record.sequence).padStart(2, '0')}.json`,
  )
  atomicImmutableWrite(path, `${JSON.stringify(record)}\n`, {
    cap: MAX_HISTORICAL_QUOTE_RECORD_BYTES,
    root,
    ...(stat ? { stat } : {}),
  })
  return record
}

export function readHistoricalQuoteAttempts(
  rosterId,
  venue,
  day,
  { root = HISTORICAL_DEPTH_QUOTE_ROOT } = {},
) {
  const dir = slotPath(root, rosterId, venue, day)
  if (!existsSync(dir)) return []
  const names = safeDirectory(dir).sort()
  if (names.length > MAX_HISTORICAL_QUOTE_ATTEMPTS_PER_SLOT) fail('attempt_limit')
  const rows = []
  return names.map((name, index) => {
    if (name !== `attempt-${String(index + 1).padStart(2, '0')}.json`) fail('attempt_sequence')
    const record = safeJsonFile(join(dir, name), MAX_HISTORICAL_QUOTE_RECORD_BYTES)
    if (!['historical-depth-quote-attempt-v1', 'historical-depth-quote-attempt-v2', 'historical-depth-quote-attempt-v3'].includes(record.study))
      fail('version_invalid')
    verifySealed(record, record.study)
    if (
      record.sequence !== index + 1 ||
      record.rosterId !== rosterId ||
      record.venue !== venue ||
      record.anchorDay !== day
    )
      fail('attempt_identity_mismatch')
    if (!['verified', 'failed'].includes(record.status)) fail('attempt_status_invalid')
    if (record.status === 'failed' && typeof record.reason !== 'string')
      fail('failure_reason_missing')
    canonicalUtc(record.firstLocalReceiptAtUtc)
    const roster = readHistoricalQuoteRoster(rosterId, { root })
    const anchor = readHistoricalQuoteAnchor(rosterId, day, { root })
    const venueRecord = roster.venues.find((entry) => entry.name === venue)
    if (!venueRecord) fail('venue_not_in_roster')
    const captures = materializeCaptures(record, rows, roster, anchor, venueRecord)
    if (record.status === 'verified') validateVerifiedAttempt(record, roster, anchor, venueRecord, captures)
    rows.push(record)
    return record
  })
}

export function listHistoricalQuoteAttempts(rosterId, { root = HISTORICAL_DEPTH_QUOTE_ROOT } = {}) {
  const roster = readHistoricalQuoteRoster(rosterId, { root })
  const base = join(root, `roster-${rosterId}`, 'records')
  if (!existsSync(base)) return []
  const results = []
  for (const venue of roster.venues) {
    const venueDir = join(base, venue.name)
    if (!existsSync(venueDir)) continue
    for (const day of safeDirectory(venueDir).sort()) {
      if (!roster.anchors.includes(day)) fail('unexpected_anchor_directory')
      results.push(...readHistoricalQuoteAttempts(rosterId, venue.name, day, { root }))
      if (results.length > MAX_HISTORICAL_QUOTE_RECORDS) fail('record_count_limit')
    }
  }
  return results
}

export function listHistoricalQuoteRosters({ root = HISTORICAL_DEPTH_QUOTE_ROOT } = {}) {
  if (!existsSync(root)) return []
  return safeDirectory(root)
    .filter((name) => /^roster-[0-9a-f]{64}\.json$/.test(name))
    .map((name) => name.slice(7, -5))
}

export function appendHistoricalQuoteSetupFailure(
  reason,
  { root = HISTORICAL_DEPTH_QUOTE_ROOT, stat, now = () => new Date() } = {},
) {
  if (typeof reason !== 'string' || !/^[a-z0-9_]{1,64}$/.test(reason)) fail('setup_failure_invalid')
  const directory = join(root, 'setup-failures')
  const names = existsSync(directory) ? safeDirectory(directory).sort() : []
  if (names.length >= 128) fail('setup_failure_limit')
  const record = seal({
    study: 'historical-depth-quote-setup-failure-v1',
    sequence: names.length + 1,
    reason,
    firstLocalReceiptAtUtc: canonicalUtc(now().toISOString()),
  })
  atomicImmutableWrite(
    join(directory, `attempt-${String(record.sequence).padStart(3, '0')}.json`),
    `${JSON.stringify(record)}\n`,
    { cap: 4096, root, ...(stat ? { stat } : {}) },
  )
  return record
}

export function readHistoricalQuoteSetupFailures({ root = HISTORICAL_DEPTH_QUOTE_ROOT } = {}) {
  const directory = join(root, 'setup-failures')
  if (!existsSync(directory)) return []
  return safeDirectory(directory)
    .sort()
    .map((name, index) => {
      if (name !== `attempt-${String(index + 1).padStart(3, '0')}.json`)
        fail('setup_failure_sequence')
      const record = safeJsonFile(join(directory, name), 4096)
      const body = verifySealed(record, 'historical-depth-quote-setup-failure-v1')
      if (
        body.sequence !== index + 1 ||
        typeof body.reason !== 'string' ||
        !/^[a-z0-9_]{1,64}$/.test(body.reason)
      )
        fail('setup_failure_invalid')
      canonicalUtc(body.firstLocalReceiptAtUtc)
      return record
    })
}
