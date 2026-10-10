// Prospective, exact-vault Morpho V2 flow receipts. A quiet range is a
// provider-returned observation, not independent proof of complete logs.
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { decodeEventLog, parseAbiItem, toEventHash } from 'viem'

import { compareCombinedLogs, normalizeFlowLogs } from '../record-carry-morpho-v2-flows.mjs'

export const LOCAL_MORPHO_ROOT = resolve('data/research/venue-signals/local-morpho-v2-flow-v1')
const STUDY = 'carry-morpho-v2-exact-vault-gross-flow-v1'
const SHA = /^[0-9a-f]{64}$/
const HASH = /^0x[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const FILE = /^\d{12}\.json$/
const MAX_BYTES = 16 * 1024 * 1024
const RESERVE = 2n * 1024n * 1024n * 1024n
const ABI = {
  deposit: parseAbiItem(
    'event Deposit(address indexed sender,address indexed onBehalf,uint256 assets,uint256 shares)',
  ),
  withdraw: parseAbiItem(
    'event Withdraw(address indexed sender,address indexed receiver,address indexed onBehalf,uint256 assets,uint256 shares)',
  ),
  force: parseAbiItem(
    'event ForceDeallocate(address indexed sender,address adapter,uint256 assets,address indexed onBehalf,bytes32[] ids,uint256 penaltyAssets)',
  ),
}
const TOPIC_KIND = new Map(
  Object.entries(ABI).map(([kind, item]) => [toEventHash(item).toLowerCase(), kind]),
)
const sha = (value) => createHash('sha256').update(value).digest('hex')
const name = (sequence) => `${String(sequence).padStart(12, '0')}.json`
const fail = (reason) => {
  throw new Error(`local_morpho_${reason}`)
}
const assert = (condition, reason) => {
  if (!condition) fail(reason)
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

function fileRecord(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  let bytes
  try {
    const file = fstatSync(fd)
    assert(file.isFile(), 'unsafe_file')
    assert(file.size <= MAX_BYTES, 'record_oversize')
    bytes = readFileSync(fd, 'utf8')
    assert(Buffer.byteLength(bytes) <= MAX_BYTES, 'record_oversize')
  } finally {
    closeSync(fd)
  }
  const record = JSON.parse(bytes)
  assert(bytes === `${JSON.stringify(record)}\n`, 'noncanonical_bytes')
  const { sha256, ...body } = record
  assert(SHA.test(sha256 ?? '') && sha(JSON.stringify(body)) === sha256, 'hash_mismatch')
  return record
}

function headersValid(record, prior) {
  const from = BigInt(record.fromBlock)
  const to = BigInt(record.toBlock)
  assert(from > 0n && to >= from && to - from < 512n, 'range_invalid')
  assert(
    HASH.test(record.priorHash ?? '') && HASH.test(record.toHash ?? ''),
    'boundary_hash_invalid',
  )
  assert(
    BigInt(record.finalizedHeadBlock) >= to && HASH.test(record.finalizedHeadHash ?? ''),
    'finalized_invalid',
  )
  assert(from === BigInt(prior.toBlock ?? prior.block) + 1n, 'cursor_gap')
  assert(record.priorHash === (prior.toHash ?? prior.blockHash), 'cursor_hash_gap')
  assert(!Number.isNaN(Date.parse(record.toObservedAt)), 'timestamp_invalid')
}

function replayRaw(record) {
  assert(Array.isArray(record.rawLogs) && record.rawLogs.length <= 10_000, 'raw_count_invalid')
  const sets = { deposit: [], withdraw: [], force: [] }
  const seen = new Set()
  for (const row of record.rawLogs) {
    const kind = TOPIC_KIND.get(row.topics?.[0])
    assert(kind && kind === row.kind, 'raw_topic_invalid')
    assert(
      row.address === record.vault &&
        HASH.test(row.blockHash ?? '') &&
        HASH.test(row.transactionHash ?? '') &&
        /^0x[0-9a-f]*$/.test(row.data ?? '') &&
        Array.isArray(row.topics) &&
        row.topics.every((topic) => HASH.test(topic)) &&
        Number.isSafeInteger(row.logIndex) &&
        row.logIndex >= 0 &&
        Number.isSafeInteger(row.transactionIndex) &&
        row.transactionIndex >= 0 &&
        BigInt(row.blockNumber) >= BigInt(record.fromBlock) &&
        BigInt(row.blockNumber) <= BigInt(record.toBlock),
      'raw_identity_invalid',
    )
    const key = `${row.transactionHash}:${row.logIndex}`
    assert(!seen.has(key), 'raw_duplicate')
    seen.add(key)
    const decoded = decodeEventLog({
      abi: [ABI[kind]],
      topics: row.topics,
      data: row.data,
      strict: true,
    })
    sets[kind].push({ ...row, blockNumber: BigInt(row.blockNumber), args: decoded.args })
  }
  assert(
    compareCombinedLogs(sets.deposit, sets.withdraw, sets.force, Object.values(sets).flat()) ===
      record.combinedSetSha256,
    'raw_set_hash_invalid',
  )
  const normalized = normalizeFlowLogs(
    record.vault,
    sets.deposit,
    sets.withdraw,
    sets.force,
    BigInt(record.fromBlock),
    BigInt(record.toBlock),
  )
  assert(same(normalized, record.events), 'decoded_event_mismatch')
  const eventBlocks = new Map(record.eventBlocks.map((row) => [row.block, row.hash]))
  assert(record.eventBlocks.length === eventBlocks.size, 'event_header_duplicate')
  for (const row of record.rawLogs)
    assert(eventBlocks.get(row.blockNumber) === row.blockHash, 'event_header_mismatch')
  assert(
    eventBlocks.size === new Set(record.rawLogs.map((row) => row.blockNumber)).size,
    'event_header_missing',
  )
  for (const row of record.eventBlocks)
    assert(
      HASH.test(row.hash ?? '') &&
        row.block >= record.fromBlock &&
        BigInt(row.block) <= BigInt(record.toBlock),
      'event_header_invalid',
    )
}

export function verifyLocalMorphoEnrollment(subjects, root = LOCAL_MORPHO_ROOT) {
  const path = join(root, 'enrollment.json')
  if (!existsSync(path)) return null
  const record = fileRecord(path)
  assert(
    record.study === STUDY && record.kind === 'enrollment' && record.chainId === 1,
    'enrollment_invalid',
  )
  assert(
    HASH.test(record.blockHash ?? '') && /^\d+$/.test(record.block ?? ''),
    'enrollment_block_invalid',
  )
  assert(
    Array.isArray(record.subjects) && record.subjects.length === 49,
    'enrollment_count_invalid',
  )
  assert(same(record.subjects, subjects), 'enrollment_manifest_changed')
  return record
}

export function verifyLocalMorphoVault(subject, enrollment, root = LOCAL_MORPHO_ROOT) {
  assert(ADDRESS.test(subject.vault), 'subject_address_invalid')
  const directory = join(root, subject.vault)
  if (!existsSync(directory)) return []
  assert(lstatSync(directory).isDirectory(), 'unsafe_directory')
  const files = readdirSync(directory)
    .filter((entry) => entry.endsWith('.json'))
    .sort()
  assert(files.length <= 100_000, 'record_limit')
  const records = []
  for (const [index, file] of files.entries()) {
    assert(FILE.test(file) && file === name(index + 1), 'sequence_gap')
    const record = fileRecord(join(directory, file))
    const prior = records.at(-1) ?? enrollment
    assert(
      record.study === STUDY &&
        record.kind === 'range' &&
        record.chainId === 1 &&
        record.sequence === index + 1 &&
        record.previousSha256 === prior.sha256 &&
        record.enrollmentSha256 === enrollment.sha256 &&
        record.vault === subject.vault &&
        record.asset === subject.asset &&
        record.manifestSha256 === subject.manifestSha256 &&
        record.seedSha256 === subject.seedSha256 &&
        record.boardSha256 === subject.boardSha256 &&
        record.displayedRoutesSha256 === subject.displayedRoutesSha256 &&
        record.cohortId === subject.cohortId &&
        record.providerCompleteness === 'not_independently_proven' &&
        record.holderPayout === 'not_measured',
      'range_identity_invalid',
    )
    headersValid(record, prior)
    replayRaw(record)
    records.push(record)
  }
  return records
}

function reserve(root, bytes) {
  let ancestor = root
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor)
    assert(parent !== ancestor, 'no_disk_ancestor')
    ancestor = parent
  }
  const disk = statfsSync(ancestor, { bigint: true })
  assert(disk.bavail * disk.bsize - BigInt(bytes) >= RESERVE, 'disk_reserve_reached')
}

function publish(path, record) {
  const bytes = `${JSON.stringify(record)}\n`
  assert(Buffer.byteLength(bytes) <= MAX_BYTES, 'record_oversize')
  reserve(dirname(path), Buffer.byteLength(bytes))
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  let fd
  try {
    fd = openSync(temp, 'wx', 0o600)
    writeFileSync(fd, bytes)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    linkSync(temp, path)
    const dirFd = openSync(dirname(path), 'r')
    try {
      fsyncSync(dirFd)
    } finally {
      closeSync(dirFd)
    }
  } finally {
    if (fd !== undefined) closeSync(fd)
    if (existsSync(temp)) unlinkSync(temp)
  }
}

export function enrollLocalMorpho(subjects, block, root = LOCAL_MORPHO_ROOT) {
  assert(subjects.length === 49 && HASH.test(block.hash ?? ''), 'enrollment_input_invalid')
  const existing = verifyLocalMorphoEnrollment(subjects, root)
  if (existing) return existing
  const body = {
    study: STUDY,
    kind: 'enrollment',
    chainId: 1,
    block: String(block.number),
    blockHash: block.hash,
    observedAt: new Date(Number(block.timestamp) * 1000).toISOString(),
    firstLocalReceiptAt: new Date().toISOString(),
    subjects,
  }
  const record = { ...body, sha256: sha(JSON.stringify(body)) }
  publish(join(root, 'enrollment.json'), record)
  return verifyLocalMorphoEnrollment(subjects, root)
}

export function appendLocalMorphoRange(
  subject,
  enrollment,
  payload,
  rawLogs,
  eventBlocks,
  root = LOCAL_MORPHO_ROOT,
) {
  const lock = join(root, `${subject.vault}.lock`)
  mkdirSync(root, { recursive: true })
  mkdirSync(lock)
  try {
    const prior = verifyLocalMorphoVault(subject, enrollment, root).at(-1) ?? enrollment
    const body = {
      study: STUDY,
      kind: 'range',
      chainId: 1,
      sequence: prior.sequence ? prior.sequence + 1 : 1,
      previousSha256: prior.sha256,
      enrollmentSha256: enrollment.sha256,
      ...payload,
      rawLogs,
      eventBlocks,
      providerCompleteness: 'not_independently_proven',
      holderPayout: 'not_measured',
      firstLocalReceiptAt: new Date().toISOString(),
    }
    const { payloadSha256, ...withoutPayloadHash } = body
    const record = { ...withoutPayloadHash, sha256: sha(JSON.stringify(withoutPayloadHash)) }
    headersValid(record, prior)
    replayRaw(record)
    publish(join(root, subject.vault, name(record.sequence)), record)
    return record
  } finally {
    if (existsSync(lock)) rmdirSync(lock)
  }
}
