// Local post-publication receipt for a newly sealed direct supplier flow segment.
// This proves only the operator's local clock and file state, not independent
// prospective availability or any holder exit outcome.
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  openSync,
  readSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

const STUDIES_V2 = new Set([
  'carry-direct-supplier-flow-receipts-v2',
  'carry-direct-supplier-supply-flow-receipts-v2',
])
const STUDIES_V1 = new Set([
  'carry-direct-supplier-flow-receipts-v1',
  'carry-direct-supplier-supply-flow-receipts-v1',
])
const WITNESS_STUDY = 'carry-direct-supplier-flow-publication-witness-v1'
const SHA = /^[0-9a-f]{64}$/
const MAX_SEGMENT_BYTES = 64 * 1024 ** 2
const MAX_WITNESS_BYTES = 2 * 1024
const fail = (condition, code) => {
  if (!condition) throw new Error(code)
}
const sha256 = (input) => createHash('sha256').update(input).digest('hex')

function isoTime(value) {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isSafeInteger(ms) && new Date(ms).toISOString() === value ? ms : NaN
}

function segmentIdentity(document) {
  fail(
    document && typeof document === 'object' && !Array.isArray(document),
    'invalid_direct_segment',
  )
  if (STUDIES_V1.has(document.study)) return null
  fail(STUDIES_V2.has(document.study), 'invalid_direct_segment_study')
  const { sha256: segmentSha256, ...body } = document
  fail(
    SHA.test(segmentSha256) && sha256(JSON.stringify(body)) === segmentSha256,
    'direct_segment_digest_mismatch',
  )
  const startedMs = isoTime(body.captureStartedAt)
  const completedMs = isoTime(body.captureCompletedAt)
  fail(
    Number.isSafeInteger(startedMs) &&
      Number.isSafeInteger(completedMs) &&
      completedMs >= startedMs,
    'direct_capture_clock_invalid',
  )
  const fromBlock = body.range?.fromBlock
  const toBlock = body.range?.toBlock
  fail(
    typeof body.marketKey === 'string' &&
      /^[A-Za-z][A-Za-z0-9_]*$/.test(body.marketKey) &&
      Number.isSafeInteger(fromBlock) &&
      Number.isSafeInteger(toBlock) &&
      fromBlock >= 0 &&
      toBlock >= fromBlock,
    'invalid_direct_segment_range',
  )
  const prefix = body.study === 'carry-direct-supplier-supply-flow-receipts-v2' ? 'supply-' : ''
  return {
    segmentSha256,
    captureCompletedAt: body.captureCompletedAt,
    completedMs,
    expectedFileName: `${prefix}${body.marketKey}-${fromBlock}-${toBlock}.json`,
  }
}

function assertNativeSegmentPath(segmentPath, identity) {
  fail(basename(segmentPath) === identity.expectedFileName, 'direct_segment_filename_mismatch')
}

export function directSupplierFlowPublicationWitnessPath(segmentPath) {
  const name = basename(segmentPath)
  fail(/^[A-Za-z0-9_-]+\.json$/.test(name), 'invalid_direct_segment_filename')
  // The leading dot keeps this sidecar out of both withdrawal and supply
  // segment readers, which reject unexpected files under their market prefix.
  return join(dirname(segmentPath), `.direct-flow-publication-${name}`)
}

function fileSha256(path, maxBytes, code) {
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const file = fstatSync(fd)
    fail(file.isFile() && file.size > 0 && file.size <= maxBytes, code)
    const hash = createHash('sha256')
    const chunk = Buffer.allocUnsafe(64 * 1024)
    let total = 0
    for (;;) {
      const count = readSync(fd, chunk, 0, chunk.length, null)
      if (count === 0) break
      total += count
      fail(total <= maxBytes, code)
      hash.update(chunk.subarray(0, count))
    }
    fail(total === file.size, code)
    return hash.digest('hex')
  } catch (error) {
    if (error?.message === code) throw error
    throw new Error(code)
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function segmentFileSha256(segmentPath, document) {
  const canonical = `${JSON.stringify(document)}\n`
  fail(Buffer.byteLength(canonical) <= MAX_SEGMENT_BYTES, 'invalid_direct_segment_file')
  const expected = sha256(canonical)
  fail(
    fileSha256(segmentPath, MAX_SEGMENT_BYTES, 'invalid_direct_segment_file') === expected,
    'direct_segment_file_mismatch',
  )
  return expected
}

function readWitness(path) {
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw new Error('invalid_direct_publication_witness_file')
  }
  try {
    const file = fstatSync(fd)
    fail(
      file.isFile() && file.size > 0 && file.size <= MAX_WITNESS_BYTES,
      'invalid_direct_publication_witness_file',
    )
    const bytes = Buffer.alloc(file.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null)
      fail(count > 0, 'invalid_direct_publication_witness_file')
      offset += count
    }
    fail(readSync(fd, Buffer.alloc(1), 0, 1, null) === 0, 'invalid_direct_publication_witness_file')
    const raw = bytes.toString('utf8')
    let witness
    try {
      witness = JSON.parse(raw)
    } catch {
      throw new Error('invalid_direct_publication_witness_json')
    }
    fail(raw === `${JSON.stringify(witness)}\n`, 'invalid_direct_publication_witness_file')
    return witness
  } finally {
    closeSync(fd)
  }
}

/** Does not create or repair receipts, including for a legacy or resumed segment. */
export function readDirectSupplierFlowPublicationWitness(segmentPath, document) {
  const identity = segmentIdentity(document)
  if (!identity)
    return {
      status: 'unknown',
      reason: 'legacy_segment_without_capture_clock',
      firstLocalReceiptAt: null,
      clockBasis: 'local_operator_clock_unwitnessed',
      prospectiveValidation: false,
    }
  assertNativeSegmentPath(segmentPath, identity)
  const path = directSupplierFlowPublicationWitnessPath(segmentPath)
  const witness = readWitness(path)
  if (!witness)
    return {
      status: 'unavailable',
      reason: 'post_publication_witness_missing',
      firstLocalReceiptAt: null,
      clockBasis: 'local_operator_clock_unwitnessed',
      prospectiveValidation: false,
    }
  fail(
    witness && typeof witness === 'object' && !Array.isArray(witness),
    'invalid_direct_publication_witness',
  )
  const { sha256: witnessSha256, ...body } = witness
  fail(
    SHA.test(witnessSha256) && sha256(JSON.stringify(body)) === witnessSha256,
    'direct_publication_witness_digest_mismatch',
  )
  fail(
    body.study === WITNESS_STUDY &&
      body.segmentFileName === basename(segmentPath) &&
      body.segmentSha256 === identity.segmentSha256 &&
      SHA.test(body.segmentFileSha256) &&
      body.captureCompletedAt === identity.captureCompletedAt &&
      Number.isSafeInteger(isoTime(body.firstLocalReceiptAt)) &&
      isoTime(body.firstLocalReceiptAt) >= identity.completedMs,
    'direct_publication_witness_mismatch',
  )
  fail(
    segmentFileSha256(segmentPath, document) === body.segmentFileSha256,
    'direct_publication_segment_mismatch',
  )
  return {
    status: 'local_publication_witness',
    firstLocalReceiptAt: body.firstLocalReceiptAt,
    clockBasis: 'local_operator_clock_unwitnessed',
    prospectiveValidation: false,
    segmentSha256: identity.segmentSha256,
    witnessSha256,
  }
}

/** Call only after the segment hard link and its parent directory are fsynced. */
export function writeDirectSupplierFlowPublicationWitness(
  segmentPath,
  document,
  { now = Date.now } = {},
) {
  const identity = segmentIdentity(document)
  if (!identity) return { status: 'unknown', reason: 'legacy_segment_without_capture_clock' }
  assertNativeSegmentPath(segmentPath, identity)
  const segmentFileHash = segmentFileSha256(segmentPath, document)
  const atMs = now()
  fail(
    Number.isSafeInteger(atMs) && atMs >= identity.completedMs,
    'direct_publication_clock_invalid',
  )
  const body = {
    study: WITNESS_STUDY,
    segmentFileName: basename(segmentPath),
    segmentSha256: identity.segmentSha256,
    segmentFileSha256: segmentFileHash,
    captureCompletedAt: identity.captureCompletedAt,
    firstLocalReceiptAt: new Date(atMs).toISOString(),
  }
  const witness = { ...body, sha256: sha256(JSON.stringify(body)) }
  const serialized = `${JSON.stringify(witness)}\n`
  fail(
    Buffer.byteLength(serialized) <= MAX_WITNESS_BYTES,
    'invalid_direct_publication_witness_file',
  )
  const path = directSupplierFlowPublicationWitnessPath(segmentPath)
  const staged = join(dirname(path), `.direct-flow-publication-stage-${randomUUID()}.tmp`)
  let fd
  try {
    fd = openSync(
      staged,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    writeFileSync(fd, serialized)
    fchmodSync(fd, 0o444)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    linkSync(staged, path)
    const directory = openSync(dirname(path), constants.O_RDONLY)
    try {
      fsyncSync(directory)
    } finally {
      closeSync(directory)
    }
  } finally {
    if (fd !== undefined) closeSync(fd)
    try {
      unlinkSync(staged)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error('direct_publication_stage_cleanup_failed')
    }
  }
  return readDirectSupplierFlowPublicationWitness(segmentPath, document)
}
