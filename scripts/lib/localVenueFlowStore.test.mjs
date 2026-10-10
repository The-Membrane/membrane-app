import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { toEventHash } from 'viem'
import {
  makeReceipt,
  recordVenue,
  requiredStreamIdentities,
  streamsFor,
} from '../record-venue-flows.mjs'
import { localVenueFlowStore } from './localVenueFlowStore.mjs'

const venue = {
  name: 'test-vault',
  kind: 'erc4626-vault-cash',
  address: '0x0000000000000000000000000000000000000001',
}
const streams = streamsFor(venue)
const blockHash = (block) => `0x${block.toString(16).padStart(64, '0')}`
const txHash = (block, index) =>
  `0x${(block * 10n + BigInt(index) + 10_000n).toString(16).padStart(64, '0')}`
function log(stream, block, index = 0) {
  return {
    address: stream.address,
    blockNumber: block,
    blockHash: blockHash(block),
    transactionHash: txHash(block, index),
    logIndex: index,
    topics: [toEventHash(stream.event)],
    args: { assets: 100n },
  }
}
function reader(logs) {
  return {
    async getChainId() {
      return 1
    },
    async getBlock({ blockTag, blockNumber }) {
      const number = blockTag === 'finalized' ? 20n : blockNumber
      return { number, hash: blockHash(number), timestamp: 1_700_000_000n + number }
    },
    async getLogs({ event, fromBlock, toBlock }) {
      const direction = event.name === 'Deposit' ? 'in' : 'out'
      return logs[direction].filter(
        (entry) => entry.blockNumber >= fromBlock && entry.blockNumber <= toBlock,
      )
    },
  }
}
const historical = { in: [log(streams[0], 1n)], out: [log(streams[1], 2n)] }
function fixture(t, options = {}) {
  const out = mkdtempSync(join(tmpdir(), 'venue-flow-local-'))
  t.after(() => rmSync(out, { recursive: true, force: true }))
  return { out, store: localVenueFlowStore({ out, ...options }) }
}
const run = (store, logs = historical, options = {}) =>
  recordVenue({
    reader: reader(logs),
    store,
    venue,
    chunk: 2n,
    toBlock: 11n,
    ...options,
  })
const names = (out) => readdirSync(join(out, venue.name))

test('local CLI entry resolves its store without an unsettled top-level await', () => {
  const script = fileURLToPath(new URL('../record-venue-flows.mjs', import.meta.url))
  const result = spawnSync(
    process.execPath,
    [script, '--local', '--venue', 'nonexistent-flow-venue'],
    {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      env: { ...process.env, RECORDER_RPC_URL: 'http://127.0.0.1:1' },
      encoding: 'utf8',
      timeout: 10_000,
    },
  )
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /"status":"invalid_venue"/)
  assert.doesNotMatch(result.stderr, /unsettled top-level await/i)
})

test('first local run requires explicit start even with prior DB data elsewhere', async (t) => {
  const { out, store } = fixture(t)
  await assert.rejects(run(store), /flow_first_run_requires_from_block/)
  assert.deepEqual(readdirSync(out), [])
})

test('quiet finalized range seals both streams and replays as zero events', async (t) => {
  const { out, store } = fixture(t)
  const result = await run(store, historical, { fromBlock: 10n })
  assert.equal(result.sealed, 1)
  assert.equal(result.rows, 0)
  assert.deepEqual(names(out), ['000000000001.json'])
  const receipt = (await store.readReceipts(venue.name))[0]
  assert.equal(receipt.from_block, '10')
  assert.equal(receipt.to_block, '11')
  assert.deepEqual(
    receipt.streams.map((stream) => stream.log_count),
    [0, 0],
  )
  assert.deepEqual(await store.readFlowsInRange(venue.name, 10n, 11n), [])
})

test('tampered physical bytes and resealed event rows fail replay', async (t) => {
  const logs = { in: [...historical.in, log(streams[0], 10n)], out: historical.out }
  const { out, store } = fixture(t)
  await run(store, logs, { fromBlock: 10n })
  const path = join(out, venue.name, '000000000001.json')
  const original = readFileSync(path, 'utf8')
  writeFileSync(path, ` ${original}`)
  await assert.rejects(store.readReceipts(venue.name), /physical_bytes_mismatch/)
  writeFileSync(path, original)
  const edited = JSON.parse(original)
  edited.rows[0].assets_raw = '101'
  const { sha256: _old, ...body } = edited
  edited.sha256 = createHash('sha256').update(JSON.stringify(body)).digest('hex')
  writeFileSync(path, `${JSON.stringify(edited)}\n`)
  await assert.rejects(
    store.readFlowsInRange(venue.name, 10n, 11n),
    /flow_receipt_event_set_mismatch/,
  )
})

test('failed atomic publication leaves no receipt and same store retries staged rows', async (t) => {
  let attempts = 0
  const { out, store } = fixture(t, {
    publish(source, target) {
      attempts++
      if (attempts === 1) throw new Error('test_publish_failure')
      linkSync(source, target)
    },
  })
  const logs = { in: [...historical.in, log(streams[0], 10n)], out: historical.out }
  await assert.rejects(run(store, logs, { fromBlock: 10n }), /test_publish_failure/)
  assert.deepEqual(names(out), [])
  await run(store, logs, { fromBlock: 10n })
  assert.deepEqual(names(out), ['000000000001.json'])
  assert.equal((await store.readFlowsInRange(venue.name, 10n, 11n)).length, 1)
})

test('continuation follows sealed boundary; explicit overlap stops', async (t) => {
  const { out, store } = fixture(t)
  await run(store, historical, { fromBlock: 10n })
  await run(store, historical, { toBlock: 13n })
  assert.deepEqual(names(out), ['000000000001.json', '000000000002.json'])
  const receipts = await store.readReceipts(venue.name)
  assert.equal(receipts[1].from_block, '12')
  assert.equal(receipts[1].to_block, '13')
  await assert.rejects(
    run(store, historical, { fromBlock: 11n, toBlock: 14n }),
    /flow_from_block_conflicts_receipt/,
  )
  assert.deepEqual(names(out), ['000000000001.json', '000000000002.json'])
})

test('resealed overlapping range still fails receipt replay', async (t) => {
  const { out, store } = fixture(t)
  await run(store, historical, { fromBlock: 10n })
  await run(store, historical, { toBlock: 13n })
  const path = join(out, venue.name, '000000000002.json')
  const record = JSON.parse(readFileSync(path, 'utf8'))
  record.receipt = makeReceipt({
    venue: venue.name,
    from: 11n,
    to: 13n,
    fromHash: blockHash(11n),
    toHash: blockHash(13n),
    finalized: { number: 20n, hash: blockHash(20n) },
    identities: requiredStreamIdentities(streams),
    counts: [0, 0],
  })
  const { sha256: _old, ...body } = record
  record.sha256 = createHash('sha256').update(JSON.stringify(body)).digest('hex')
  writeFileSync(path, `${JSON.stringify(record)}\n`)
  await assert.rejects(store.readReceipts(venue.name), /flow_receipt_chain_invalid/)
})

test('disk reserve stops before publishing a receipt', async (t) => {
  const { out, store } = fixture(t, {
    stat: () => ({ bavail: 1024n, bsize: 1024n }),
  })
  await assert.rejects(
    run(store, historical, { fromBlock: 10n }),
    /local_flow_disk_reserve_reached/,
  )
  assert.deepEqual(readdirSync(out), [])
  assert.deepEqual(await store.readReceipts(venue.name), [])
})
