// Finalized venue flow recorder. Only contiguous sealed ranges attest getLogs
// coverage. Pre-existing venue_flows rows have no coverage status. Any future
// maximum-flow consumer must re-read rows within each range and compare their
// canonical event-set hash to the receipt before using those rows.
//
// Rollout: apply-venue-recorder-ddl.mjs, then bootstrap each venue explicitly:
//   node scripts/record-venue-flows.mjs --venue NAME --from-block N
// Existing venue_flows rows do not set N or certify earlier history. Choose N
// deliberately and record the coverage start; the scheduled command has no
// --from-block and reports bootstrap_required until a receipt exists.
// Later runs: node scripts/record-venue-flows.mjs [--venue NAME]
// Local Mac ledger: add --local. It starts a separate immutable range chain
// and therefore also requires an explicit --from-block on its first run.
// Optional: --to-block N --chunk N. A requested head must be finalized.
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { neon } from '@neondatabase/serverless'
import { getAddress, parseAbiItem, toEventHash } from 'viem'
import { localVenueFlowStore } from './lib/localVenueFlowStore.mjs'
import { loadConfig, makeClient, readEnv } from './lib/venue-reads.mjs'

const BLOCK_HASH = /^0x[0-9a-fA-F]{64}$/
const TX_HASH = BLOCK_HASH
const DEFAULT_CHUNK = 2000n
const AAVE_V3_POOL = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2'
const ERC4626_DEPOSIT = parseAbiItem(
  'event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)',
)
const ERC4626_WITHDRAW = parseAbiItem(
  'event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)',
)
const AAVE_SUPPLY = parseAbiItem(
  'event Supply(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode)',
)
const AAVE_WITHDRAW = parseAbiItem(
  'event Withdraw(address indexed reserve, address indexed user, address indexed to, uint256 amount)',
)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function retry(fn, label, tries = 3) {
  let failure
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      failure = error
      if (attempt + 1 < tries) await sleep(400 * 2 ** attempt)
    }
  }
  throw new Error(`${label}_failed`, { cause: failure })
}

function requireBlock(block, requestedNumber) {
  if (
    typeof block?.number !== 'bigint' ||
    block.number !== requestedNumber ||
    !BLOCK_HASH.test(block.hash ?? '') ||
    typeof block.timestamp !== 'bigint'
  ) {
    throw new Error('flow_invalid_block_response')
  }
  return { number: block.number, hash: block.hash.toLowerCase(), timestamp: block.timestamp }
}

export function streamsFor(venue) {
  if (venue.kind === 'erc4626-cooldown' || venue.kind === 'erc4626-vault-cash') {
    const address = getAddress(venue.address)
    return [
      { direction: 'in', address, event: ERC4626_DEPOSIT, amount: (log) => log.args.assets },
      { direction: 'out', address, event: ERC4626_WITHDRAW, amount: (log) => log.args.assets },
    ]
  }
  if (venue.kind === 'atoken-liquidity') {
    const address = getAddress(AAVE_V3_POOL)
    const reserve = getAddress(venue.underlying)
    return [
      {
        direction: 'in',
        address,
        event: AAVE_SUPPLY,
        args: { reserve },
        amount: (log) => log.args.amount,
      },
      {
        direction: 'out',
        address,
        event: AAVE_WITHDRAW,
        args: { reserve },
        amount: (log) => log.args.amount,
      },
    ]
  }
  return null
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    )
  return value
}
function hash(value) {
  return createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex')
}
export function canonicalFlowRows(rows) {
  const normalized = rows.map((row) => {
    const block = BigInt(row.block)
    const assetsRaw = BigInt(row.assetsRaw ?? row.assets_raw)
    const sourceBlockTime = row.blockTime ?? row.block_time
    // DB adapter returns full microsecond precision. Reject sub-millisecond
    // mutations that JavaScript Date would silently truncate before hashing.
    if (
      typeof sourceBlockTime === 'string' &&
      /\.\d{6}Z$/.test(sourceBlockTime) &&
      !sourceBlockTime.endsWith('000Z')
    ) {
      throw new Error('flow_invalid_stored_row')
    }
    const blockTime = new Date(sourceBlockTime)
    const logIndex = Number(row.logIndex ?? row.log_index)
    const txHash = String(row.txHash ?? row.tx_hash).toLowerCase()
    if (
      block < 0n ||
      assetsRaw < 0n ||
      Number.isNaN(blockTime.getTime()) ||
      !Number.isSafeInteger(logIndex) ||
      logIndex < 0 ||
      !TX_HASH.test(txHash) ||
      !['in', 'out'].includes(row.direction)
    ) {
      throw new Error('flow_invalid_stored_row')
    }
    return {
      block: block.toString(),
      block_time: blockTime.toISOString(),
      direction: row.direction,
      assets_raw: assetsRaw.toString(),
      tx_hash: txHash,
      log_index: logIndex,
    }
  })
  normalized.sort((a, b) => {
    const keyOrder = a.tx_hash.localeCompare(b.tx_hash) || a.log_index - b.log_index
    if (keyOrder) return keyOrder
    return BigInt(a.block) < BigInt(b.block) ? -1 : BigInt(a.block) > BigInt(b.block) ? 1 : 0
  })
  return normalized
}
export function assertMatchingFlowRows(fetched, stored) {
  const expected = canonicalFlowRows(fetched)
  const actual = canonicalFlowRows(stored)
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error('flow_range_rows_mismatch_manual_repair_required')
  }
  return hash(expected)
}
export function verifyReceiptEventSet(receipt, storedRows) {
  if (hash(canonicalFlowRows(storedRows)) !== receipt.event_set_hash) {
    throw new Error('flow_receipt_event_set_mismatch')
  }
}
export function streamIdentity(stream) {
  return {
    direction: stream.direction,
    address: getAddress(stream.address).toLowerCase(),
    topic0: toEventHash(stream.event).toLowerCase(),
    reserve: stream.args?.reserve ? getAddress(stream.args.reserve).toLowerCase() : null,
  }
}
export function requiredStreamIdentities(streams) {
  if (
    !Array.isArray(streams) ||
    streams.length !== 2 ||
    streams[0]?.direction !== 'in' ||
    streams[1]?.direction !== 'out'
  ) {
    throw new Error('flow_required_stream_missing')
  }
  return streams.map(streamIdentity)
}

function receiptPayload(receipt) {
  return {
    venue: receipt.venue,
    from_block: String(receipt.from_block),
    to_block: String(receipt.to_block),
    from_hash: receipt.from_hash,
    to_hash: receipt.to_hash,
    finalized_head_block: String(receipt.finalized_head_block),
    finalized_head_hash: receipt.finalized_head_hash,
    streamset_hash: receipt.streamset_hash,
    streams: receipt.streams,
    event_set_hash: receipt.event_set_hash,
  }
}
export function makeReceipt({
  venue,
  from,
  to,
  fromHash,
  toHash,
  finalized,
  identities,
  counts,
  rows = [],
}) {
  if (identities.length !== 2 || counts.length !== 2)
    throw new Error('flow_required_stream_missing')
  if (
    counts.some((count) => !Number.isSafeInteger(count) || count < 0) ||
    counts[0] + counts[1] !== rows.length
  ) {
    throw new Error('flow_receipt_count_mismatch')
  }
  const streams = identities.map((identity, index) => ({
    ...identity,
    status: 'fetched_complete',
    log_count: counts[index],
  }))
  const receipt = {
    venue,
    from_block: from.toString(),
    to_block: to.toString(),
    from_hash: fromHash,
    to_hash: toHash,
    finalized_head_block: finalized.number.toString(),
    finalized_head_hash: finalized.hash,
    streamset_hash: hash(identities),
    streams,
    event_set_hash: hash(canonicalFlowRows(rows)),
  }
  return { ...receipt, receipt_hash: hash(receiptPayload(receipt)) }
}
export function validateReceiptChain(receipts, identities) {
  const expectedStreamset = hash(identities)
  let last = null
  for (const receipt of receipts) {
    const from = BigInt(receipt.from_block)
    const to = BigInt(receipt.to_block)
    if (
      from < 0n ||
      to < from ||
      BigInt(receipt.finalized_head_block) < to ||
      !BLOCK_HASH.test(receipt.from_hash ?? '') ||
      !BLOCK_HASH.test(receipt.to_hash ?? '') ||
      !BLOCK_HASH.test(receipt.finalized_head_hash ?? '') ||
      receipt.streamset_hash !== expectedStreamset ||
      !/^[0-9a-f]{64}$/.test(receipt.event_set_hash ?? '') ||
      receipt.receipt_hash !== hash(receiptPayload(receipt)) ||
      !Array.isArray(receipt.streams) ||
      receipt.streams.length !== 2 ||
      receipt.streams.some(
        (stream, index) =>
          stream.status !== 'fetched_complete' ||
          !Number.isSafeInteger(stream.log_count) ||
          stream.log_count < 0 ||
          hash(streamIdentityFromReceipt(stream)) !== hash(identities[index]),
      ) ||
      (last && from !== BigInt(last.to_block) + 1n)
    ) {
      throw new Error('flow_receipt_chain_invalid')
    }
    last = receipt
  }
  return last
}
function streamIdentityFromReceipt(stream) {
  return {
    direction: stream.direction,
    address: stream.address,
    topic0: stream.topic0,
    reserve: stream.reserve,
  }
}

async function getLogsSplit(reader, stream, from, to) {
  const request = {
    address: stream.address,
    event: stream.event,
    fromBlock: from,
    toBlock: to,
    ...(stream.args ? { args: stream.args } : {}),
  }
  try {
    const logs = await retry(() => reader.getLogs(request), 'flow_get_logs')
    if (!Array.isArray(logs)) throw new Error('flow_invalid_logs_response')
    return logs
  } catch (error) {
    if (from === to) throw error
    const middle = from + (to - from) / 2n
    return [
      ...(await getLogsSplit(reader, stream, from, middle)),
      ...(await getLogsSplit(reader, stream, middle + 1n, to)),
    ]
  }
}

// A zero-log stream cannot be signature-verified by this RPC. Fail closed;
// a quiet range is receipted only after both signatures were established.
async function verifyStream(reader, stream, finalizedBlock) {
  const probeAt = async (width) => {
    const from = finalizedBlock > width ? finalizedBlock - width : 0n
    return getLogsSplit(reader, stream, from, finalizedBlock)
  }
  let probe = await probeAt(5_000n)
  if (probe.length === 0) probe = await probeAt(50_000n)
  if (probe.length === 0) throw new Error(`flow_unverified_${stream.direction}_stream`)
  for (const log of probe) {
    if (
      log.address?.toLowerCase() !== stream.address.toLowerCase() ||
      log.topics?.[0]?.toLowerCase() !== toEventHash(stream.event).toLowerCase() ||
      (stream.args?.reserve &&
        log.args?.reserve?.toLowerCase() !== stream.args.reserve.toLowerCase())
    ) {
      throw new Error(`flow_invalid_${stream.direction}_stream_probe`)
    }
  }
}

async function readBlock(reader, number, finalizedNumber) {
  if (number > finalizedNumber) throw new Error('flow_nonfinalized_block')
  return requireBlock(
    await retry(() => reader.getBlock({ blockNumber: number }), 'flow_get_block'),
    number,
  )
}

function decodeLog(log, stream, block) {
  const raw = stream.amount(log)
  if (
    typeof log.blockNumber !== 'bigint' ||
    log.blockNumber !== block.number ||
    log.blockHash?.toLowerCase() !== block.hash ||
    !TX_HASH.test(log.transactionHash ?? '') ||
    !Number.isSafeInteger(log.logIndex) ||
    log.logIndex < 0 ||
    typeof raw !== 'bigint' ||
    raw < 0n ||
    log.address?.toLowerCase() !== stream.address.toLowerCase() ||
    log.topics?.[0]?.toLowerCase() !== toEventHash(stream.event).toLowerCase()
  ) {
    throw new Error('flow_invalid_log')
  }
  if (
    stream.args?.reserve &&
    log.args?.reserve?.toLowerCase() !== stream.args.reserve.toLowerCase()
  ) {
    throw new Error('flow_wrong_reserve_log')
  }
  return {
    block: block.number,
    blockTime: new Date(Number(block.timestamp) * 1000).toISOString(),
    direction: stream.direction,
    assetsRaw: raw,
    txHash: log.transactionHash.toLowerCase(),
    logIndex: log.logIndex,
  }
}

// Exposed for offline tests with mocked RPC/storage. No receipt is written
// before every stream fetch, row insert, and boundary re-read succeeds.
export async function scanFlowRange({ reader, store, venue, streams, from, to, finalized }) {
  const identities = requiredStreamIdentities(streams)
  if (from < 0n || to < from || to > finalized.number) throw new Error('flow_nonfinalized_range')
  const first = await readBlock(reader, from, finalized.number)
  const last = from === to ? first : await readBlock(reader, to, finalized.number)
  const blocks = new Map([
    [from, first],
    [to, last],
  ])
  const rows = []
  const counts = []
  const seenLogs = new Set()
  for (const stream of streams) {
    const logs = await getLogsSplit(reader, stream, from, to)
    counts.push(logs.length)
    for (const log of logs) {
      if (log.blockNumber < from || log.blockNumber > to) throw new Error('flow_log_outside_range')
      let block = blocks.get(log.blockNumber)
      if (!block) {
        block = await readBlock(reader, log.blockNumber, finalized.number)
        blocks.set(log.blockNumber, block)
      }
      const row = decodeLog(log, stream, block)
      const logKey = `${row.txHash}:${row.logIndex}`
      if (seenLogs.has(logKey)) throw new Error('flow_duplicate_log_in_range')
      seenLogs.add(logKey)
      rows.push(row)
    }
  }
  for (const row of rows) await store.insertFlow(venue.name, row)
  const storedRows = await store.readFlowsInRange(venue.name, from, to)
  assertMatchingFlowRows(rows, storedRows)
  const firstAgain = await readBlock(reader, from, finalized.number)
  const lastAgain = from === to ? firstAgain : await readBlock(reader, to, finalized.number)
  if (firstAgain.hash !== first.hash || lastAgain.hash !== last.hash) {
    throw new Error('flow_boundary_hash_changed')
  }
  const finalizedAgain = await readBlock(reader, finalized.number, finalized.number)
  if (finalizedAgain.hash !== finalized.hash) throw new Error('flow_finalized_head_hash_changed')
  const receipt = makeReceipt({
    venue: venue.name,
    from,
    to,
    fromHash: first.hash,
    toHash: last.hash,
    finalized,
    identities,
    counts,
    rows,
  })
  await store.insertReceipt(receipt, rows)
  return { rows: rows.length, receipt }
}

export async function recordVenue({ reader, store, venue, fromBlock, toBlock, chunk }) {
  const streams = streamsFor(venue)
  const identities = requiredStreamIdentities(streams)
  if ((await reader.getChainId()) !== 1) throw new Error('flow_wrong_chain')
  const head = await reader.getBlock({ blockTag: 'finalized' })
  if (
    typeof head?.number !== 'bigint' ||
    !BLOCK_HASH.test(head.hash ?? '') ||
    typeof head.timestamp !== 'bigint'
  ) {
    throw new Error('flow_invalid_finalized_head')
  }
  const finalized = requireBlock(head, head.number)
  const end = toBlock ?? finalized.number
  if (end > finalized.number) throw new Error('flow_nonfinalized_head')
  if (chunk <= 0n) throw new Error('flow_invalid_chunk')
  const receipts = await store.readReceipts(venue.name)
  const previous = validateReceiptChain(receipts, identities)
  let from
  if (previous) {
    from = BigInt(previous.to_block) + 1n
    if (fromBlock !== undefined && fromBlock !== from)
      throw new Error('flow_from_block_conflicts_receipt')
    const boundary = await readBlock(reader, BigInt(previous.to_block), finalized.number)
    if (boundary.hash !== previous.to_hash) throw new Error('flow_boundary_hash_mismatch')
  } else {
    if (fromBlock === undefined) throw new Error('flow_first_run_requires_from_block')
    from = fromBlock
  }
  if (from < 0n) throw new Error('flow_invalid_from_block')
  if (from > end) return { sealed: 0, rows: 0 }
  // On continuation, the sealed chain already pins both stream identities.
  // Repeat a live signature probe only at an explicit first bootstrap.
  if (!previous) for (const stream of streams) await verifyStream(reader, stream, finalized.number)
  let sealed = 0
  let rows = 0
  for (let rangeFrom = from; rangeFrom <= end; rangeFrom += chunk) {
    const rangeTo = rangeFrom + chunk - 1n > end ? end : rangeFrom + chunk - 1n
    const result = await scanFlowRange({
      reader,
      store,
      venue,
      streams,
      from: rangeFrom,
      to: rangeTo,
      finalized,
    })
    sealed++
    rows += result.rows
    console.log(`[${venue.name}] sealed ${rangeFrom}-${rangeTo}: ${result.rows} logs`)
  }
  return { sealed, rows }
}

export function databaseStore(sql) {
  return {
    async readReceipts(venue) {
      return sql`SELECT venue, from_block, to_block, from_hash, to_hash,
                        finalized_head_block, finalized_head_hash, streamset_hash,
                        streams, event_set_hash, receipt_hash
                 FROM venue_flow_range_receipts WHERE venue = ${venue}
                 ORDER BY from_block ASC`
    },
    async insertFlow(venue, row) {
      const inserted = await sql`
        INSERT INTO venue_flows (venue, block, block_time, direction, assets_raw, tx_hash, log_index)
        VALUES (${venue}, ${row.block.toString()}, ${row.blockTime}, ${row.direction},
                ${row.assetsRaw.toString()}, ${row.txHash}, ${row.logIndex})
        ON CONFLICT (venue, tx_hash, log_index) DO NOTHING RETURNING id`
      if (inserted.length) return
      const existing = await sql`
        SELECT block, block_time, direction, assets_raw
        FROM venue_flows
        WHERE venue = ${venue} AND tx_hash = ${row.txHash} AND log_index = ${row.logIndex}`
      if (
        existing.length !== 1 ||
        BigInt(existing[0].block) !== row.block ||
        new Date(existing[0].block_time).toISOString() !== row.blockTime ||
        existing[0].direction !== row.direction ||
        BigInt(existing[0].assets_raw) !== row.assetsRaw
      ) {
        throw new Error('flow_existing_row_mismatch')
      }
    },
    async readFlowsInRange(venue, from, to) {
      return sql`
        SELECT block,
               to_char(block_time AT TIME ZONE 'UTC',
                       'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS block_time,
               direction, assets_raw, tx_hash, log_index
        FROM venue_flows
        WHERE venue = ${venue} AND block BETWEEN ${from.toString()} AND ${to.toString()}
        ORDER BY tx_hash, log_index`
    },
    async insertReceipt(receipt, rows) {
      const expectedRowsJson = JSON.stringify(canonicalFlowRows(rows))
      const prior = await sql`
        SELECT to_block, to_hash, streamset_hash
        FROM venue_flow_range_receipts WHERE venue = ${receipt.venue}
        ORDER BY from_block DESC LIMIT 1`
      const isFirst = prior.length === 0
      if (
        !isFirst &&
        (BigInt(prior[0].to_block) + 1n !== BigInt(receipt.from_block) ||
          prior[0].streamset_hash !== receipt.streamset_hash)
      ) {
        throw new Error('flow_receipt_boundary_conflict')
      }
      // The latest receipt is checked again inside the insert. Unique keys
      // reject duplicate/overlapping seals from concurrent processes.
      const [inserted] = await sql.transaction(
        [
          sql`
        INSERT INTO venue_flow_range_receipts
          (venue, from_block, to_block, from_hash, to_hash,
           finalized_head_block, finalized_head_hash, streamset_hash, streams,
           event_set_hash, receipt_hash)
        SELECT ${receipt.venue}, ${receipt.from_block}, ${receipt.to_block},
               ${receipt.from_hash}, ${receipt.to_hash}, ${receipt.finalized_head_block},
               ${receipt.finalized_head_hash}, ${receipt.streamset_hash},
               ${JSON.stringify(receipt.streams)}::jsonb, ${receipt.event_set_hash},
               ${receipt.receipt_hash}
        WHERE ((${isFirst}
          AND NOT EXISTS (
            SELECT 1 FROM venue_flow_range_receipts WHERE venue = ${receipt.venue}
          ))
        OR (${!isFirst}
          AND EXISTS (
            SELECT 1 FROM venue_flow_range_receipts
            WHERE venue = ${receipt.venue}
              AND to_block = ${(BigInt(receipt.from_block) - 1n).toString()}
              AND to_hash = ${prior[0]?.to_hash ?? ''}
              AND streamset_hash = ${receipt.streamset_hash}
          )
          AND NOT EXISTS (
            SELECT 1 FROM venue_flow_range_receipts
            WHERE venue = ${receipt.venue} AND from_block >= ${receipt.from_block}
          )))
          AND (
            SELECT count(*) FROM venue_flows
            WHERE venue = ${receipt.venue}
              AND block BETWEEN ${receipt.from_block} AND ${receipt.to_block}
          ) = ${rows.length}
          AND NOT EXISTS (
            SELECT 1 FROM venue_flows AS actual
            WHERE actual.venue = ${receipt.venue}
              AND actual.block BETWEEN ${receipt.from_block} AND ${receipt.to_block}
              AND NOT EXISTS (
                SELECT 1
                FROM jsonb_to_recordset(${expectedRowsJson}::jsonb) AS expected(
                  block text, block_time text, direction text, assets_raw text,
                  tx_hash text, log_index integer
                )
                WHERE actual.block::text = expected.block
                  AND actual.block_time = expected.block_time::timestamptz
                  AND actual.direction = expected.direction
                  AND actual.assets_raw = expected.assets_raw::numeric
                  AND lower(actual.tx_hash) = expected.tx_hash
                  AND actual.log_index = expected.log_index
              )
          )
        ON CONFLICT DO NOTHING RETURNING venue`,
        ],
        { isolationLevel: 'Serializable' },
      )
      if (inserted.length !== 1) throw new Error('flow_receipt_insert_conflict')
    },
  }
}

function flag(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index < 0 ? undefined : process.argv[index + 1]
}
function blockFlag(name) {
  const raw = flag(name)
  if (raw === undefined) return undefined
  if (!/^\d+$/.test(raw)) throw new Error(`invalid_--${name}`)
  return BigInt(raw)
}
async function main() {
  const { get } = readEnv()
  const rpcUrl = get('RECORDER_RPC_URL') || process.env.RECORDER_RPC_URL
  const dbUrl = get('DATABASE_URL_UNPOOLED') || get('DATABASE_URL')
  const local = process.argv.includes('--local')
  if (!rpcUrl || (!local && !dbUrl))
    throw new Error(
      local ? 'flow_recorder_requires_rpc' : 'flow_recorder_requires_rpc_and_database',
    )
  const reader = makeClient(rpcUrl)
  const store = local ? localVenueFlowStore() : databaseStore(neon(dbUrl))
  const onlyVenue = flag('venue')
  const fromBlock = blockFlag('from-block')
  const toBlock = blockFlag('to-block')
  const chunk = blockFlag('chunk') ?? DEFAULT_CHUNK
  let failed = false
  const venues = loadConfig().filter(
    (entry) => entry.enabled && (!onlyVenue || entry.name === onlyVenue),
  )
  if (onlyVenue && venues.length === 0) {
    console.error(JSON.stringify({ status: 'invalid_venue', venue: onlyVenue }))
    process.exitCode = 1
    return
  }
  for (const venue of venues) {
    if (!streamsFor(venue)) continue
    try {
      const result = await recordVenue({ reader, store, venue, fromBlock, toBlock, chunk })
      console.log(`[${venue.name}] ${result.sealed} sealed ranges, ${result.rows} logs`)
    } catch (error) {
      failed = true
      if (error.message === 'flow_first_run_requires_from_block') {
        console.error(
          JSON.stringify({
            status: 'bootstrap_required',
            venue: venue.name,
            instruction: local
              ? 'run --local --venue NAME --from-block N; DB rows and prior empty intervals remain uncertified'
              : 'run --venue NAME --from-block N after DDL; legacy rows remain uncertified',
          }),
        )
      } else {
        console.error(`[${venue.name}] ${error.message}; range remains unsealed for replay`)
      }
    }
  }
  if (failed) process.exitCode = 1
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
