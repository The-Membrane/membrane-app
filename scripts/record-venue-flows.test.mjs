import assert from 'node:assert/strict'
import test from 'node:test'
import { toEventHash } from 'viem'
import {
  databaseStore,
  makeReceipt,
  recordVenue,
  requiredStreamIdentities,
  scanFlowRange,
  streamsFor,
  validateReceiptChain,
  verifyReceiptEventSet,
} from './record-venue-flows.mjs'

const venue = {
  name: 'test-vault',
  kind: 'erc4626-cooldown',
  address: '0x0000000000000000000000000000000000000001',
}
const streams = streamsFor(venue)
const identities = requiredStreamIdentities(streams)
test('sGHO vault cash uses its own ERC-4626 Deposit and Withdraw asset streams', () => {
  const sgho = {
    name: 'sGHO',
    kind: 'erc4626-vault-cash',
    address: '0xe1753f2e00940cc31213dd92013cf019dfe4ca1d',
  }
  const sghoStreams = streamsFor(sgho)
  expectStreamNames(sghoStreams, ['Deposit', 'Withdraw'])
  assert.equal(sghoStreams[0].address.toLowerCase(), sgho.address)
  assert.equal(sghoStreams[1].address.toLowerCase(), sgho.address)
  assert.equal(sghoStreams[0].amount({ args: { assets: 7n, shares: 5n } }), 7n)
  assert.equal(sghoStreams[1].amount({ args: { assets: 9n, shares: 8n } }), 9n)
  assert.equal(requiredStreamIdentities(sghoStreams).length, 2)
})
function expectStreamNames(found, names) {
  assert.deepEqual(
    found.map((stream) => stream.event.name),
    names,
  )
}
const blockHash = (number) => `0x${Number(number).toString(16).padStart(64, '0')}`
const txHash = (number) => `0x${(Number(number) + 10_000).toString(16).padStart(64, '0')}`
const finalized = { number: 20n, hash: blockHash(20n), timestamp: 1_700_000_000n }
function log(stream, blockNumber, logIndex = 0) {
  return {
    address: stream.address,
    blockNumber,
    blockHash: blockHash(blockNumber),
    transactionHash: txHash(blockNumber * 10n + BigInt(logIndex)),
    logIndex,
    topics: [toEventHash(stream.event)],
    args: { assets: 100n },
  }
}
function reader(logs = { in: [], out: [] }, options = {}) {
  return {
    async getChainId() {
      return 1
    },
    async getBlock({ blockTag, blockNumber }) {
      if (blockTag === 'finalized')
        return { number: finalized.number, hash: finalized.hash, timestamp: finalized.timestamp }
      const number = blockNumber
      return {
        number,
        hash: options.hashAt?.(number) ?? blockHash(number),
        timestamp: 1_700_000_000n + number,
      }
    },
    async getLogs({ event, fromBlock, toBlock }) {
      options.calls?.push([event.name, fromBlock, toBlock])
      const direction = event.name === 'Deposit' ? 'in' : 'out'
      if (options.failStream === direction) throw new Error('rpc_down')
      return logs[direction].filter(
        (item) => item.blockNumber >= fromBlock && item.blockNumber <= toBlock,
      )
    },
  }
}
function store(options = {}) {
  const rows = new Map()
  const receipts = []
  let attempts = 0
  return {
    rows,
    receipts,
    async readReceipts() {
      return receipts
    },
    async insertFlow(_venue, row) {
      attempts++
      if (options.failOnAttempt === attempts) throw new Error('partial_insert')
      rows.set(`${row.txHash}:${row.logIndex}`, row)
    },
    async readFlowsInRange(_venue, from, to) {
      return [...rows.values()].filter((row) => row.block >= from && row.block <= to)
    },
    async insertReceipt(receipt) {
      if (receipts.some((entry) => entry.from_block === receipt.from_block))
        throw new Error('duplicate_range')
      if (receipts.length && BigInt(receipt.from_block) !== BigInt(receipts.at(-1).to_block) + 1n) {
        throw new Error('gap')
      }
      receipts.push(receipt)
    },
  }
}

test('partial same-block row failure leaves no receipt and replays every log', async () => {
  const logs = { in: [log(streams[0], 10n, 0), log(streams[0], 10n, 1)], out: [] }
  const first = store({ failOnAttempt: 2 })
  await assert.rejects(
    scanFlowRange({
      reader: reader(logs),
      store: first,
      venue,
      streams,
      from: 10n,
      to: 10n,
      finalized,
    }),
    /partial_insert/,
  )
  assert.equal(first.rows.size, 1)
  assert.equal(first.receipts.length, 0)
  const replay = store()
  replay.rows.set([...first.rows.keys()][0], [...first.rows.values()][0])
  await scanFlowRange({
    reader: reader(logs),
    store: replay,
    venue,
    streams,
    from: 10n,
    to: 10n,
    finalized,
  })
  assert.equal(replay.rows.size, 2)
  assert.deepEqual(
    replay.receipts[0].streams.map((entry) => entry.log_count),
    [2, 0],
  )
})

test('quiet range writes a two-stream zero-log receipt', async () => {
  const saved = store()
  const result = await scanFlowRange({
    reader: reader(),
    store: saved,
    venue,
    streams,
    from: 5n,
    to: 9n,
    finalized,
  })
  assert.equal(result.rows, 0)
  assert.equal(saved.receipts.length, 1)
  assert.deepEqual(
    saved.receipts[0].streams.map((entry) => entry.log_count),
    [0, 0],
  )
  assert.equal(validateReceiptChain(saved.receipts, identities)?.to_block, '9')
  verifyReceiptEventSet(saved.receipts[0], [])
})

test('extra legacy row in the range blocks a receipt without deleting it', async () => {
  const saved = store()
  const extra = {
    block: 7n,
    blockTime: new Date((1_700_000_000 + 7) * 1000).toISOString(),
    direction: 'out',
    assetsRaw: 999n,
    txHash: txHash(777),
    logIndex: 4,
  }
  saved.rows.set('legacy', extra)
  await assert.rejects(
    scanFlowRange({
      reader: reader(),
      store: saved,
      venue,
      streams,
      from: 5n,
      to: 9n,
      finalized,
    }),
    /flow_range_rows_mismatch_manual_repair_required/,
  )
  assert.equal(saved.rows.get('legacy'), extra)
  assert.equal(saved.receipts.length, 0)
})

test('missing stored row and sub-millisecond row mutation block a receipt', async () => {
  const logs = { in: [log(streams[0], 10n)], out: [] }
  const missing = store()
  missing.readFlowsInRange = async () => []
  await assert.rejects(
    scanFlowRange({
      reader: reader(logs),
      store: missing,
      venue,
      streams,
      from: 10n,
      to: 10n,
      finalized,
    }),
    /flow_range_rows_mismatch_manual_repair_required/,
  )
  assert.equal(missing.receipts.length, 0)
  const precise = store()
  precise.readFlowsInRange = async () => [
    {
      block: 10n,
      block_time: '2023-11-14T22:13:30.000001Z',
      direction: 'in',
      assets_raw: '100',
      tx_hash: logs.in[0].transactionHash,
      log_index: 0,
    },
  ]
  await assert.rejects(
    scanFlowRange({
      reader: reader(logs),
      store: precise,
      venue,
      streams,
      from: 10n,
      to: 10n,
      finalized,
    }),
    /flow_invalid_stored_row/,
  )
  assert.equal(precise.receipts.length, 0)
})

test('receipt event-set hash detects later stored-row tampering', async () => {
  const saved = store()
  await scanFlowRange({
    reader: reader({ in: [log(streams[0], 10n)], out: [] }),
    store: saved,
    venue,
    streams,
    from: 10n,
    to: 10n,
    finalized,
  })
  const receipt = saved.receipts[0]
  validateReceiptChain([receipt], identities)
  verifyReceiptEventSet(receipt, [...saved.rows.values()])
  saved.rows.values().next().value.assetsRaw = 101n
  assert.throws(
    () => verifyReceiptEventSet(receipt, [...saved.rows.values()]),
    /flow_receipt_event_set_mismatch/,
  )
})

test('DB adapter reads the event-set seal required by next-tick validation', async () => {
  const receipt = makeReceipt({
    venue: venue.name,
    from: 5n,
    to: 9n,
    fromHash: blockHash(5n),
    toHash: blockHash(9n),
    finalized,
    identities,
    counts: [0, 0],
  })
  const fakeSql = (parts) => {
    const query = parts.join('?')
    assert.match(query, /SELECT venue, from_block/)
    const selected = query.includes('event_set_hash')
      ? receipt
      : Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'event_set_hash'))
    return Promise.resolve([selected])
  }
  const read = await databaseStore(fakeSql).readReceipts(venue.name)
  assert.equal(validateReceiptChain(read, identities)?.event_set_hash, receipt.event_set_hash)
})

test('duplicate RPC log cannot be sealed as two events', async () => {
  const duplicate = log(streams[0], 10n)
  const saved = store()
  await assert.rejects(
    scanFlowRange({
      reader: reader({ in: [duplicate, duplicate], out: [] }),
      store: saved,
      venue,
      streams,
      from: 10n,
      to: 10n,
      finalized,
    }),
    /flow_duplicate_log_in_range/,
  )
  assert.equal(saved.receipts.length, 0)
})

test('missing stream and incomplete RPC leave range unsealed', async () => {
  const saved = store()
  await assert.rejects(
    scanFlowRange({
      reader: reader({ in: [], out: [] }, { failStream: 'out' }),
      store: saved,
      venue,
      streams,
      from: 10n,
      to: 10n,
      finalized,
    }),
    /flow_get_logs_failed/,
  )
  assert.equal(saved.receipts.length, 0)
  await assert.rejects(
    scanFlowRange({
      reader: reader(),
      store: saved,
      venue,
      streams: [streams[0]],
      from: 10n,
      to: 10n,
      finalized,
    }),
    /flow_required_stream_missing/,
  )
})

test('prior boundary mismatch prevents extending a sealed chain', async () => {
  const prior = makeReceipt({
    venue: venue.name,
    from: 5n,
    to: 9n,
    fromHash: blockHash(5n),
    toHash: blockHash(9n),
    finalized,
    identities,
    counts: [0, 0],
  })
  const saved = store()
  saved.receipts.push(prior)
  await assert.rejects(
    recordVenue({
      reader: reader(
        {},
        { hashAt: (number) => (number === 9n ? blockHash(99n) : blockHash(number)) },
      ),
      store: saved,
      venue,
      chunk: 5n,
      toBlock: 10n,
    }),
    /flow_boundary_hash_mismatch/,
  )
  assert.equal(saved.receipts.length, 1)
})

test('gap, duplicate range, and changed stream identity fail closed', async () => {
  const receipt = (from, to) =>
    makeReceipt({
      venue: venue.name,
      from,
      to,
      fromHash: blockHash(from),
      toHash: blockHash(to),
      finalized,
      identities,
      counts: [0, 0],
    })
  assert.throws(
    () => validateReceiptChain([receipt(5n, 9n), receipt(11n, 12n)], identities),
    /invalid/,
  )
  assert.throws(
    () => validateReceiptChain([receipt(5n, 9n), receipt(5n, 9n)], identities),
    /invalid/,
  )
  const changed = structuredClone(receipt(5n, 9n))
  changed.streams[1].address = '0x0000000000000000000000000000000000000002'
  assert.throws(() => validateReceiptChain([changed], identities), /invalid/)
  const saved = store()
  await scanFlowRange({
    reader: reader(),
    store: saved,
    venue,
    streams,
    from: 5n,
    to: 9n,
    finalized,
  })
  await assert.rejects(
    scanFlowRange({
      reader: reader(),
      store: saved,
      venue,
      streams,
      from: 5n,
      to: 9n,
      finalized,
    }),
    /duplicate_range/,
  )
  assert.equal(saved.receipts.length, 1)
})

test('resume starts after last sealed range, ignoring event row max block', async () => {
  const saved = store()
  saved.receipts.push(
    makeReceipt({
      venue: venue.name,
      from: 5n,
      to: 9n,
      fromHash: blockHash(5n),
      toHash: blockHash(9n),
      finalized,
      identities,
      counts: [0, 0],
    }),
  )
  // A partial previous attempt may have inserted block 11 before its receipt.
  const logs = { in: [log(streams[0], 10n)], out: [log(streams[1], 11n)] }
  const partial = logs.out[0]
  saved.rows.set(`${partial.transactionHash.toLowerCase()}:${partial.logIndex}`, {
    block: partial.blockNumber,
    blockTime: new Date((1_700_000_000 + 11) * 1000).toISOString(),
    direction: 'out',
    assetsRaw: 100n,
    txHash: partial.transactionHash.toLowerCase(),
    logIndex: partial.logIndex,
  })
  const calls = []
  const result = await recordVenue({
    reader: reader(logs, { calls }),
    store: saved,
    venue,
    toBlock: 11n,
    chunk: 2n,
  })
  assert.equal(result.sealed, 1)
  assert.equal(saved.receipts[1].from_block, '10')
  assert.equal(saved.receipts[1].to_block, '11')
  assert.deepEqual(calls, [
    ['Deposit', 10n, 11n],
    ['Withdraw', 10n, 11n],
  ])
})

test('first bootstrap probes both streams in the bounded 5k window', async () => {
  const saved = store()
  const calls = []
  const logs = { in: [log(streams[0], 10n)], out: [log(streams[1], 11n)] }
  const result = await recordVenue({
    reader: reader(logs, { calls }),
    store: saved,
    venue,
    fromBlock: 10n,
    toBlock: 11n,
    chunk: 2n,
  })
  assert.equal(result.sealed, 1)
  assert.deepEqual(calls, [
    ['Deposit', 0n, 20n],
    ['Withdraw', 0n, 20n],
    ['Deposit', 10n, 11n],
    ['Withdraw', 10n, 11n],
  ])
})

test('first bootstrap needs explicit start and requested head must be finalized', async () => {
  const saved = store()
  await assert.rejects(
    recordVenue({ reader: reader(), store: saved, venue, chunk: 5n, toBlock: 10n }),
    /flow_first_run_requires_from_block/,
  )
  await assert.rejects(
    recordVenue({ reader: reader(), store: saved, venue, chunk: 5n, fromBlock: 5n, toBlock: 21n }),
    /flow_nonfinalized_head/,
  )
})
