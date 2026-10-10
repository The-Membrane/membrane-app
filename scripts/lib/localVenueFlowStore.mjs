// Append-only local coverage ledger. Each file publishes the receipt and its
// exact event set together; staged rows have no coverage status until then.
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
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
import { dirname, join, resolve } from 'node:path'
import {
  canonicalFlowRows,
  validateReceiptChain,
  verifyReceiptEventSet,
} from '../record-venue-flows.mjs'

export const LOCAL_VENUE_FLOW_ROOT = resolve('data/research/venue-signals/local-flow-ranges')
export const LOCAL_VENUE_FLOW_STUDY = 'venue-finalized-flow-ranges-v1'
export const MIN_LOCAL_FLOW_FREE_BYTES = 1024 * 1024 * 1024
const MAX_RANGES = 100_000
const MAX_RANGE_BYTES = 16 * 1024 * 1024
const VENUE_NAME = /^[A-Za-z][A-Za-z0-9-]{0,63}$/
const FILE_NAME = /^(\d{12})\.json$/
const sha = (value) => createHash('sha256').update(value).digest('hex')
const filename = (sequence) => `${String(sequence).padStart(12, '0')}.json`

function safeDirectory(path) {
  if (existsSync(path) && !lstatSync(path).isDirectory())
    throw new Error('local_flow_unsafe_directory')
}

function safeFile(path) {
  if (existsSync(path) && !lstatSync(path).isFile()) throw new Error('local_flow_unsafe_file')
}

function namesFor(dir) {
  safeDirectory(dir)
  if (!existsSync(dir)) return []
  const names = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
  if (names.length > MAX_RANGES) throw new Error('local_flow_range_limit')
  for (const [index, name] of names.entries()) {
    if (!FILE_NAME.test(name) || name !== filename(index + 1))
      throw new Error('local_flow_sequence_gap')
  }
  return names
}

function identitiesFromReceipt(receipt) {
  return receipt.streams.map(({ direction, address, topic0, reserve }) => ({
    direction,
    address,
    topic0,
    reserve,
  }))
}

function readRecord(path) {
  safeFile(path)
  const bytes = readFileSync(path, 'utf8')
  if (Buffer.byteLength(bytes) > MAX_RANGE_BYTES) throw new Error('local_flow_range_size_limit')
  let record
  try {
    record = JSON.parse(bytes)
  } catch {
    throw new Error('local_flow_invalid_json')
  }
  if (bytes !== `${JSON.stringify(record)}\n`) throw new Error('local_flow_physical_bytes_mismatch')
  const { sha256, ...body } = record
  if (sha256 !== sha(JSON.stringify(body))) throw new Error('local_flow_sha_mismatch')
  if (record.study !== LOCAL_VENUE_FLOW_STUDY || !Array.isArray(record.rows))
    throw new Error('local_flow_invalid_record')
  return record
}

function replay(dir, venue) {
  const records = []
  let previous = null
  const seenEvents = new Set()
  for (const [index, name] of namesFor(dir).entries()) {
    const record = readRecord(join(dir, name))
    if (
      record.sequence !== index + 1 ||
      record.venue !== venue ||
      record.previous_sha256 !== (previous?.sha256 ?? null) ||
      record.receipt?.venue !== venue
    )
      throw new Error('local_flow_chain_mismatch')
    const rows = canonicalFlowRows(record.rows)
    if (JSON.stringify(rows) !== JSON.stringify(record.rows))
      throw new Error('local_flow_rows_not_canonical')
    for (const row of rows) {
      if (
        BigInt(row.block) < BigInt(record.receipt.from_block) ||
        BigInt(row.block) > BigInt(record.receipt.to_block)
      )
        throw new Error('local_flow_row_outside_range')
      const event = `${row.tx_hash}:${row.log_index}`
      if (seenEvents.has(event)) throw new Error('local_flow_duplicate_event')
      seenEvents.add(event)
    }
    validateReceiptChain(
      [...(previous ? [previous.receipt] : []), record.receipt],
      identitiesFromReceipt(record.receipt),
    )
    verifyReceiptEventSet(record.receipt, rows)
    if (
      record.receipt.streams.some(
        (stream) =>
          rows.filter((row) => row.direction === stream.direction).length !== stream.log_count,
      )
    )
      throw new Error('local_flow_count_mismatch')
    records.push(record)
    previous = record
  }
  // The per-record chain check above catches adjacent gaps; this also catches
  // an identity change anywhere in a multi-range local ledger.
  if (records.length)
    validateReceiptChain(
      records.map((record) => record.receipt),
      identitiesFromReceipt(records[0].receipt),
    )
  return records
}

function diskGuard(out, size, stat) {
  let ancestor = out
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor)
    if (parent === ancestor) throw new Error('local_flow_no_output_ancestor')
    ancestor = parent
  }
  const disk = stat(ancestor, { bigint: true })
  if (disk.bavail * disk.bsize - BigInt(size) < BigInt(MIN_LOCAL_FLOW_FREE_BYTES))
    throw new Error('local_flow_disk_reserve_reached')
}

export function localVenueFlowStore({
  out = LOCAL_VENUE_FLOW_ROOT,
  stat = statfsSync,
  publish = linkSync,
} = {}) {
  const staged = new Map()
  const venueDir = (venue) => {
    if (!VENUE_NAME.test(venue)) throw new Error('local_flow_invalid_venue')
    safeDirectory(out)
    return join(out, venue)
  }
  const load = (venue) => replay(venueDir(venue), venue)
  return {
    async readReceipts(venue) {
      return load(venue).map((record) => record.receipt)
    },
    async insertFlow(venue, row) {
      const canonical = canonicalFlowRows([row])[0]
      const key = `${canonical.tx_hash}:${canonical.log_index}`
      const venueStaged = staged.get(venue) ?? new Map()
      const prior = venueStaged.get(key)
      if (prior && JSON.stringify(prior) !== JSON.stringify(canonical))
        throw new Error('local_flow_staged_row_mismatch')
      venueStaged.set(key, canonical)
      staged.set(venue, venueStaged)
    },
    async readFlowsInRange(venue, from, to) {
      const records = load(venue)
      const sealed = records.flatMap((record) => record.rows)
      const pending = [...(staged.get(venue)?.values() ?? [])]
      return [...sealed, ...pending].filter(
        (row) => BigInt(row.block) >= from && BigInt(row.block) <= to,
      )
    },
    async insertReceipt(receipt, rows) {
      const dir = venueDir(receipt.venue)
      const records = load(receipt.venue)
      const previous = records.at(-1)
      if (records.length >= MAX_RANGES) throw new Error('local_flow_range_limit')
      if (previous && BigInt(receipt.from_block) !== BigInt(previous.receipt.to_block) + 1n)
        throw new Error('local_flow_boundary_conflict')
      const identities = identitiesFromReceipt(receipt)
      validateReceiptChain([...records.map((record) => record.receipt), receipt], identities)
      const canonical = canonicalFlowRows(rows)
      verifyReceiptEventSet(receipt, canonical)
      const pending = staged.get(receipt.venue) ?? new Map()
      if (JSON.stringify(canonicalFlowRows([...pending.values()])) !== JSON.stringify(canonical))
        throw new Error('local_flow_staged_rows_mismatch')
      if (
        canonical.some(
          (row) =>
            BigInt(row.block) < BigInt(receipt.from_block) ||
            BigInt(row.block) > BigInt(receipt.to_block),
        )
      )
        throw new Error('local_flow_row_outside_range')
      const body = {
        study: LOCAL_VENUE_FLOW_STUDY,
        sequence: records.length + 1,
        venue: receipt.venue,
        previous_sha256: previous?.sha256 ?? null,
        receipt,
        rows: canonical,
      }
      const record = { ...body, sha256: sha(JSON.stringify(body)) }
      const bytes = `${JSON.stringify(record)}\n`
      const size = Buffer.byteLength(bytes)
      if (size > MAX_RANGE_BYTES) throw new Error('local_flow_range_size_limit')
      diskGuard(out, size, stat)
      mkdirSync(dir, { recursive: true })
      safeDirectory(dir)
      const target = join(dir, filename(record.sequence))
      const temp = `${target}.${randomUUID()}.tmp`
      let fd
      try {
        fd = openSync(temp, 'wx', 0o600)
        writeFileSync(fd, bytes)
        fsyncSync(fd)
        closeSync(fd)
        fd = undefined
        publish(temp, target)
      } finally {
        if (fd !== undefined) closeSync(fd)
        if (existsSync(temp)) unlinkSync(temp)
      }
      staged.delete(receipt.venue)
      return record
    },
  }
}
