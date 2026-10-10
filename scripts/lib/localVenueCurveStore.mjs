// Small local mirror of complete finalized quote passes. Tail verification is
// bounded and does not claim an independent timestamp or whole-history proof.
import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  statfsSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export const LOCAL_VENUE_CURVE_ROOT = resolve('data/research/venue-signals/local-depth-curves')
export const MAX_LOCAL_CURVE_RECORD_BYTES = 32 * 1024
export const MAX_LOCAL_CURVE_FILE_BYTES = 16 * 1024 * 1024
export const MAX_LOCAL_CURVE_READ_PASSES = 20
export const MIN_LOCAL_CURVE_FREE_BYTES = 1024 * 1024 * 1024
const COST_LEVELS = [0.1, 0.25, 0.5, 1, 2, 5, 10]
const HASH = /^[0-9a-f]{64}$/
const BLOCK_HASH = /^0x[0-9a-f]{64}$/
const VENUE = /^[A-Za-z][A-Za-z0-9-]{0,63}$/
const sha = (value) => createHash('sha256').update(value).digest('hex')
const fail = (reason) => {
  throw Error(`local_curve_${reason}`)
}

function utc(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    fail('invalid_time')
  return value
}

export function validateLocalVenueCurvePass(input) {
  if (
    !VENUE.test(input?.venue ?? '') ||
    input.chainId !== 1 ||
    !/^[1-9][0-9]{0,19}$/.test(String(input.block ?? '')) ||
    !Number.isSafeInteger(Number(input.block)) ||
    !BLOCK_HASH.test(input.sourceBlockHash ?? '') ||
    input.finalized !== true ||
    input.pinned !== true
  )
    fail('invalid_source')
  const sourceBlockTime = utc(input.sourceBlockTime)
  const observedAtUtc = utc(input.observedAtUtc)
  if (sourceBlockTime > observedAtUtc) fail('source_clock_order')
  const identities = input.expectedIdentities
  if (
    !identities ||
    typeof identities !== 'object' ||
    Array.isArray(identities) ||
    !Array.isArray(input.markets) ||
    !input.markets.length ||
    input.markets.length > 8 ||
    Object.keys(identities).length !== input.markets.length
  )
    fail('incomplete_pass')
  const seen = new Set()
  const markets = input.markets
    .map((market) => {
      if (
        typeof market.market !== 'string' ||
        !market.market ||
        market.market.length > 128 ||
        seen.has(market.market) ||
        typeof market.configIdentity !== 'string' ||
        !HASH.test(market.configIdentity) ||
        identities[market.market] !== market.configIdentity ||
        !Array.isArray(market.points) ||
        market.points.length !== COST_LEVELS.length
      )
        fail('incomplete_pass')
      seen.add(market.market)
      let previous = -1
      const points = market.points.map((point, index) => {
        if (
          !point ||
          point.costPct !== COST_LEVELS[index] ||
          typeof point.capacityUsd !== 'number' ||
          !Number.isFinite(point.capacityUsd) ||
          point.capacityUsd < previous ||
          point.capacityUsd < 0
        )
          fail('incomplete_pass')
        previous = point.capacityUsd
        return { costPct: point.costPct, capacityUsd: point.capacityUsd }
      })
      return { market: market.market, configIdentity: market.configIdentity, points }
    })
    .sort((a, b) => a.market.localeCompare(b.market))
  return {
    venue: input.venue,
    chainId: 1,
    block: String(input.block),
    sourceBlockHash: input.sourceBlockHash,
    sourceBlockTime,
    observedAtUtc,
    finalized: true,
    pinned: true,
    expectedIdentities: Object.fromEntries(
      markets.map((market) => [market.market, market.configIdentity]),
    ),
    markets,
  }
}

function safeFile(fd) {
  const stat = fstatSync(fd)
  if (!stat.isFile() || stat.uid !== process.getuid() || stat.size > MAX_LOCAL_CURVE_FILE_BYTES)
    fail('file_invalid')
  return stat
}

function parseRecord(line) {
  if (Buffer.byteLength(`${line}\n`) > MAX_LOCAL_CURVE_RECORD_BYTES) fail('record_size')
  const record = JSON.parse(line)
  const { sha256, ...body } = record
  if (
    line !== JSON.stringify(record) ||
    sha256 !== sha(JSON.stringify(body)) ||
    record.schema !== 'local_venue_curve_pass_v1' ||
    !Number.isSafeInteger(record.sequence) ||
    record.sequence < 1 ||
    (record.prevSha256 !== null && !HASH.test(record.prevSha256))
  )
    fail('record_digest')
  if (
    JSON.stringify(validateLocalVenueCurvePass(record.pass)) !== JSON.stringify(record.pass) ||
    utc(record.firstLocalReceiptAtUtc) < record.pass.observedAtUtc
  )
    fail('record_body')
  return record
}

/** At most limit+1 records and (limit+2)*32KiB read; older bytes stay untouched. */
export function readLocalVenueCurvePasses(
  venue,
  { root = LOCAL_VENUE_CURVE_ROOT, limit = MAX_LOCAL_CURVE_READ_PASSES } = {},
) {
  if (
    !VENUE.test(venue ?? '') ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_LOCAL_CURVE_READ_PASSES
  )
    fail('read_options')
  const path = join(root, `${venue}.jsonl`)
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (error.code === 'ENOENT') return { records: [], truncated: false, bytesRead: 0 }
    throw error
  }
  try {
    const { size } = safeFile(fd)
    if (!size) return { records: [], truncated: false, bytesRead: 0 }
    const start = Math.max(0, size - (limit + 2) * MAX_LOCAL_CURVE_RECORD_BYTES)
    const bytes = Buffer.alloc(size - start)
    if (readSync(fd, bytes, 0, bytes.length, start) !== bytes.length || bytes.at(-1) !== 10)
      fail('partial_tail')
    let text = bytes.toString('utf8')
    if (start) text = text.slice(text.indexOf('\n') + 1)
    const lines = text.slice(0, -1).split('\n')
    const recent = lines.slice(-(limit + 1)).map(parseRecord)
    for (const [index, record] of recent.entries()) {
      if (record.pass.venue !== venue) fail('venue_mismatch')
      const previous = recent[index - 1]
      if (
        previous &&
        (record.sequence !== previous.sequence + 1 ||
          record.prevSha256 !== previous.sha256 ||
          BigInt(record.pass.block) <= BigInt(previous.pass.block) ||
          record.pass.sourceBlockTime <= previous.pass.sourceBlockTime ||
          record.firstLocalReceiptAtUtc < previous.firstLocalReceiptAtUtc)
      )
        fail('chain_mismatch')
    }
    if (
      !start &&
      lines.length <= limit + 1 &&
      (recent[0].sequence !== 1 || recent[0].prevSha256 !== null)
    )
      fail('chain_start')
    return {
      records: recent.slice(-limit).reverse(),
      truncated: start > 0 || lines.length > limit,
      bytesRead: bytes.length,
      verification: !start && lines.length <= limit + 1 ? 'from_local_start' : 'bounded_tail_links',
    }
  } finally {
    closeSync(fd)
  }
}

function writerLock(path) {
  // Existing leases fail closed, including dead PIDs. Automatic stale unlink
  // races another reclaimer's newly acquired lease; recovery must be explicit.
  let fd
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    writeSync(fd, `${process.pid}\n`)
    return fd
  } catch {
    if (fd !== undefined) {
      closeSync(fd)
      unlinkSync(path)
    }
    fail('writer_locked')
  }
}

function diskGuard(root, bytes, reserve, stat) {
  let ancestor = root
  while (!existsSync(ancestor)) ancestor = dirname(ancestor)
  const disk = stat(ancestor)
  if (Number(disk.bavail) * Number(disk.bsize) - bytes < reserve) fail('disk_reserve')
}

export function appendLocalVenueCurvePass(
  input,
  {
    root = LOCAL_VENUE_CURVE_ROOT,
    now = () => new Date(),
    minFreeBytes = MIN_LOCAL_CURVE_FREE_BYTES,
    stat = statfsSync,
    maxFileBytes = MAX_LOCAL_CURVE_FILE_BYTES,
  } = {},
) {
  if (
    !Number.isSafeInteger(maxFileBytes) ||
    maxFileBytes < 1 ||
    maxFileBytes > MAX_LOCAL_CURVE_FILE_BYTES
  )
    fail('file_limit_options')
  const pass = validateLocalVenueCurvePass(input)
  const firstLocalReceiptAtUtc = utc(now().toISOString())
  if (firstLocalReceiptAtUtc < pass.observedAtUtc) fail('receipt_clock_order')
  diskGuard(root, MAX_LOCAL_CURVE_RECORD_BYTES, minFreeBytes, stat)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const lock = join(root, `${pass.venue}.lock`)
  const lockFd = writerLock(lock)
  let fd
  try {
    const previous = readLocalVenueCurvePasses(pass.venue, { root, limit: 1 }).records[0]
    if (previous && BigInt(pass.block) <= BigInt(previous.pass.block)) {
      if (
        pass.block === previous.pass.block &&
        JSON.stringify(pass.markets) === JSON.stringify(previous.pass.markets) &&
        pass.sourceBlockHash === previous.pass.sourceBlockHash &&
        pass.sourceBlockTime === previous.pass.sourceBlockTime
      )
        return { status: 'already_recorded', record: previous }
      fail('source_not_advancing')
    }
    if (
      previous &&
      (pass.sourceBlockTime <= previous.pass.sourceBlockTime ||
        firstLocalReceiptAtUtc < previous.firstLocalReceiptAtUtc)
    )
      fail('source_clock_order')
    const body = {
      schema: 'local_venue_curve_pass_v1',
      sequence: (previous?.sequence ?? 0) + 1,
      prevSha256: previous?.sha256 ?? null,
      firstLocalReceiptAtUtc,
      pass,
    }
    const record = { ...body, sha256: sha(JSON.stringify(body)) }
    const encoded = Buffer.from(`${JSON.stringify(record)}\n`)
    if (encoded.length > MAX_LOCAL_CURVE_RECORD_BYTES) fail('record_size')
    diskGuard(root, encoded.length, minFreeBytes, stat)
    fd = openSync(
      join(root, `${pass.venue}.jsonl`),
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    )
    if (safeFile(fd).size + encoded.length > maxFileBytes)
      return { status: 'unavailable', reason: 'local_curve_file_limit', record: null }
    if (writeSync(fd, encoded) !== encoded.length) fail('partial_write')
    fsyncSync(fd)
    return { status: 'appended', record }
  } finally {
    if (fd !== undefined) closeSync(fd)
    closeSync(lockFd)
    unlinkSync(lock)
  }
}
