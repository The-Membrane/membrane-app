import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { keccak256, stringToHex } from 'viem'

import { RECEIPT } from './carry-public-apyusd-exit-common.mjs'
import {
  buildPostcutoffRow,
  capturePostcutoff,
  fetchPostcutoffWindow,
  FROM,
  validatePostcutoffRows,
} from './apyusd-open-receipt-postcutoff-transfers.mjs'
import { TO } from './apyusd-receipt-cohort-transfers.mjs'

const source = {
  sha256: '9d17e9eb90fabe22eb95270784e5d879908698aa93df9167251396f605426488',
  toBlock: TO,
  cohort: { openIds: ['881', '891', '897', '906', '935', '941', '947'] },
}
const hash = (n) => `0x${n.toString(16).padStart(64, '0')}`
const HOLDER = `0x${'0'.repeat(39)}1`
const OTHER_HOLDER = `0x${'0'.repeat(39)}2`
const TIME = Date.parse('2026-10-03T12:00:00.000Z')
const first = FROM
const chainHeader = (number, timestamp) => ({
  number,
  hash: hash(number),
  parentHash: hash(number - 1),
  timestamp,
})
const rawHeader = (header) => ({
  number: `0x${header.number.toString(16)}`,
  hash: header.hash,
  parentHash: header.parentHash,
  timestamp: `0x${header.timestamp.toString(16)}`,
})
const transfer = (blockNumber, tokenId = '881') => ({
  address: RECEIPT,
  blockNumber: `0x${blockNumber.toString(16)}`,
  blockHash: hash(blockNumber),
  transactionHash: hash(800),
  logIndex: '0x0',
  topics: [
    keccak256(stringToHex('Transfer(address,address,uint256)')),
    hash(1),
    hash(0),
    hash(Number(tokenId)),
  ],
  data: '0x',
})
source.transfers = source.cohort.openIds.map((tokenId, index) => ({
  blockNumber: TO - 100,
  blockHash: hash(TO - 100),
  transactionHash: hash(900 + index),
  logIndex: index,
  topics: [
    keccak256(stringToHex('Transfer(address,address,uint256)')),
    hash(0),
    hash(1),
    hash(Number(tokenId)),
  ],
  data: '0x',
}))
const window = (number, transfers = []) => {
  const timestamp = Math.floor(TIME / 1000) - 60 + (number - first) * 12
  const ownersAtEnd = source.cohort.openIds.map((id) =>
    transfers.some(
      (event) => BigInt(event.topics[3]).toString() === id && event.topics[2] === hash(0),
    )
      ? null
      : HOLDER,
  )
  return {
    anchorHash: hash(TO),
    fromBlock: number,
    toBlock: number,
    fromHeader: chainHeader(number, timestamp),
    toHeader: chainHeader(number, timestamp),
    finalizedHead: chainHeader(number, timestamp),
    observedAtUtc: new Date(TIME + (number - first) * 12_000).toISOString(),
    transfers,
    eventBlockHeaders: [...new Set(transfers.map((event) => event.blockNumber))].map((block) =>
      chainHeader(block, timestamp),
    ),
    ownersAtEnd,
  }
}

test('sealed windows cover every block, including empty windows, without promoting payout', () => {
  const a = buildPostcutoffRow(window(first), null, source)
  const event = transfer(first + 1)
  const { address: _address, ...normalized } = event
  normalized.blockNumber = first + 1
  normalized.logIndex = 0
  const b = buildPostcutoffRow(window(first + 1, [normalized]), a, source)
  assert.equal(b.previousSha256, a.sha256)
  assert.equal(b.transfers.length, 1)
  assert.equal(b.terminalPayoutVerified, false)
  assert.equal(validatePostcutoffRows([a, b], source).length, 2)
  assert.throws(() => validatePostcutoffRows([b], source), /apyusd_postcutoff_row_invalid/)
  assert.throws(
    () => buildPostcutoffRow(window(first + 2), a, source),
    /apyusd_postcutoff_row_invalid/,
  )
  assert.throws(
    () => validatePostcutoffRows([{ ...a, terminalPayoutVerified: true }], source),
    /apyusd_postcutoff_row_invalid/,
  )
  assert.throws(
    () =>
      buildPostcutoffRow(
        { ...window(first), ownersAtEnd: [null, ...Array(6).fill(HOLDER)] },
        null,
        source,
      ),
    /apyusd_postcutoff_row_invalid/,
  )
  assert.throws(
    () =>
      buildPostcutoffRow(
        {
          ...window(first + 1, [normalized]),
          eventBlockHeaders: [
            { ...chainHeader(first + 1, Math.floor(TIME / 1000) - 48), hash: hash(999) },
          ],
        },
        a,
        source,
      ),
    /apyusd_postcutoff_row_invalid/,
  )
})

test('an interior transfer is joined to its own canonical block header', () => {
  const base = window(first)
  const raw = transfer(first + 1)
  const { address: _address, ...event } = raw
  event.blockNumber = first + 1
  event.logIndex = 0
  const startTime = Math.floor(TIME / 1000) - 60
  const covered = {
    ...base,
    toBlock: first + 2,
    toHeader: chainHeader(first + 2, startTime + 24),
    finalizedHead: chainHeader(first + 2, startTime + 24),
    observedAtUtc: new Date(TIME + 24_000).toISOString(),
    transfers: [event],
    eventBlockHeaders: [chainHeader(first + 1, startTime + 12)],
    ownersAtEnd: [null, ...Array(6).fill(HOLDER)],
  }
  const row = buildPostcutoffRow(covered, null, source)
  assert.equal(row.transfers[0].blockHash, row.eventBlockHeaders[0].hash)
  assert.throws(
    () =>
      buildPostcutoffRow(
        { ...covered, eventBlockHeaders: [{ ...covered.eventBlockHeaders[0], hash: hash(999) }] },
        null,
        source,
      ),
    /apyusd_postcutoff_row_invalid/,
  )
})

test('two origins must agree on headers and exact selected-ID logs, even for empty sets', async () => {
  const base = chainHeader(first, Math.floor(TIME / 1000) - 60)
  const origin = (logs, headerOverride = base, owner = HOLDER) => ({
    request: async (method, params) => {
      if (method === 'eth_getBlockByNumber') {
        assert.deepEqual(params, [`0x${first.toString(16)}`, false])
        return rawHeader(headerOverride)
      }
      assert.equal(method, 'eth_getLogs')
      assert.deepEqual(params[0].topics[3].length, 7)
      return logs
    },
    send: async ({ method, params }) => {
      assert.equal(method, 'eth_call')
      assert.deepEqual(params[1], { blockHash: hash(first), requireCanonical: true })
      return { result: `0x${owner.slice(2).padStart(64, '0')}` }
    },
  })
  const empty = await fetchPostcutoffWindow([origin([]), origin([])], first, first)
  assert.deepEqual(empty.transfers, [])
  assert.equal(empty.toHeader.hash, hash(first))
  assert.deepEqual(empty.ownersAtEnd, Array(7).fill(HOLDER))
  await assert.rejects(
    fetchPostcutoffWindow([origin([]), origin([], base, OTHER_HOLDER)], first, first),
    /apyusd_postcutoff_owners_disagree/,
  )
  await assert.rejects(
    fetchPostcutoffWindow([origin([transfer(first)]), origin([])], first, first),
    /apyusd_postcutoff_logs_disagree/,
  )
  await assert.rejects(
    fetchPostcutoffWindow([origin([]), origin([], { ...base, hash: hash(999) })], first, first),
    /apyusd_postcutoff_headers_disagree/,
  )
  await assert.rejects(
    fetchPostcutoffWindow(
      [origin([transfer(first, '999')]), origin([transfer(first, '999')])],
      first,
      first,
    ),
    /apyusd_postcutoff_event_invalid/,
  )
})

test('low disk refuses the tick before source reads, RPC setup, or writes', async () => {
  let calls = 0
  await assert.rejects(
    capturePostcutoff({
      freeBytes: () => 0,
      sourceLoader: async () => {
        calls++
        return source
      },
      clientsForUrls: () => {
        calls++
        return []
      },
      writer: async () => {
        calls++
      },
    }),
    /apyusd_postcutoff_disk_reserve/,
  )
  assert.equal(calls, 0)
})

test('a bounded tick advances two consecutive windows with an in-memory writer', async () => {
  const finalized = first + 1_000
  const initialTime = Math.floor(TIME / 1000) - 60
  const clientsForUrls = () =>
    ['rpc.ankr.com', 'mainnet.infura.io'].map((host) => ({
      url: `https://${host}/test`,
      provider: host,
      request: async (method, params) => {
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_getLogs') return []
        assert.equal(method, 'eth_getBlockByNumber')
        const number = params[0] === 'finalized' ? finalized : Number(BigInt(params[0]))
        return rawHeader(chainHeader(number, initialTime + (number - first) * 12))
      },
      send: async ({ method }) => {
        assert.equal(method, 'eth_call')
        return { result: `0x${HOLDER.slice(2).padStart(64, '0')}` }
      },
    }))
  const written = []
  const result = await capturePostcutoff({
    out: join(tmpdir(), `apyusd-postcutoff-test-${randomUUID()}`),
    sourceLoader: async () => source,
    clientsForUrls,
    urls: ['https://rpc.ankr.com/test', 'https://mainnet.infura.io/test'],
    writer: async (row) => written.push(row),
    freeBytes: () => 2_000_000_000,
    now: () => (initialTime + 1_000 * 12 + 60) * 1000,
    maxWindows: 2,
  })
  assert.equal(result.windows, 2)
  assert.equal(result.coveredThrough, finalized)
  assert.equal(written[0].toBlock + 1, written[1].fromBlock)
  assert.equal(written[1].fromHeader.parentHash, written[0].toHeader.hash)
  assert.equal(validatePostcutoffRows(written, source).length, 2)
})

test('two matching empty log responses cannot hide a changed receipt owner', async () => {
  let writes = 0
  const clientsForUrls = () =>
    ['rpc.ankr.com', 'mainnet.infura.io'].map((host) => ({
      url: `https://${host}/test`,
      provider: host,
      request: async (method, params) => {
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_getLogs') return []
        const number = params[0] === 'finalized' ? first : Number(BigInt(params[0]))
        return rawHeader(chainHeader(number, Math.floor(TIME / 1000) - 60 + (number - first) * 12))
      },
      send: async ({ params }) =>
        BigInt(`0x${params[0].data.slice(-64)}`) === 881n
          ? { error: { message: 'execution reverted' } }
          : { result: `0x${HOLDER.slice(2).padStart(64, '0')}` },
    }))
  await assert.rejects(
    capturePostcutoff({
      out: join(tmpdir(), `apyusd-postcutoff-test-${randomUUID()}`),
      sourceLoader: async () => source,
      clientsForUrls,
      urls: ['https://rpc.ankr.com/test', 'https://mainnet.infura.io/test'],
      writer: async () => {
        writes++
      },
      freeBytes: () => 2_000_000_000,
      now: () => TIME,
      maxWindows: 1,
    }),
    /apyusd_postcutoff_row_invalid/,
  )
  assert.equal(writes, 0)
})

test('dense event ranges halve once, seal the partial cursor, and resume without a gap', async () => {
  const end = first + 999
  const initialTime = Math.floor(TIME / 1000) - 60
  const burns = source.cohort.openIds.slice(0, 6).map((id, index) => ({
    ...transfer(first + 10 + index * 100, id),
    transactionHash: hash(800 + index),
  }))
  const burnedAt = new Map(
    burns.map((event) => [BigInt(event.topics[3]).toString(), Number(BigInt(event.blockNumber))]),
  )
  const clientsForUrls = () =>
    ['rpc.ankr.com', 'mainnet.infura.io'].map((host) => ({
      url: `https://${host}/test`,
      provider: host,
      request: async (method, params) => {
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_getLogs') {
          const low = Number(BigInt(params[0].fromBlock))
          const high = Number(BigInt(params[0].toBlock))
          return burns.filter((event) => {
            const block = Number(BigInt(event.blockNumber))
            return block >= low && block <= high
          })
        }
        const number = params[0] === 'finalized' ? end : Number(BigInt(params[0]))
        return rawHeader(chainHeader(number, initialTime + (number - first) * 12))
      },
      send: async ({ params }) => {
        const id = BigInt(`0x${params[0].data.slice(-64)}`).toString()
        const block = Number(BigInt(params[1].blockHash))
        return (burnedAt.get(id) ?? Infinity) <= block
          ? { error: { message: 'execution reverted' } }
          : { result: `0x${HOLDER.slice(2).padStart(64, '0')}` }
      },
    }))
  const out = mkdtempSync(join(tmpdir(), 'apyusd-postcutoff-dense-'))
  const writer = async (row) => {
    const path = join(out, `${String(row.sequence).padStart(8, '0')}.json`)
    writeFileSync(path, `${JSON.stringify(row)}\n`)
  }
  const options = {
    out,
    sourceLoader: async () => source,
    clientsForUrls,
    urls: ['https://rpc.ankr.com/test', 'https://mainnet.infura.io/test'],
    writer,
    freeBytes: () => 2_000_000_000,
    now: () => (initialTime + 999 * 12 + 60) * 1000,
    maxWindows: 2,
  }
  try {
    const partial = await capturePostcutoff(options)
    assert.equal(partial.windows, 1)
    assert.equal(partial.coveredThrough, first + 499)
    const resumed = await capturePostcutoff(options)
    assert.equal(resumed.coveredThrough, end)
    const rows = [1, 2].map((index) =>
      JSON.parse(readFileSync(join(out, `${String(index).padStart(8, '0')}.json`), 'utf8')),
    )
    assert.equal(rows[0].toBlock + 1, rows[1].fromBlock)
    assert.equal(validatePostcutoffRows(rows, source).length, 2)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('the local wall budget halts RPC work before any row is sealed', async () => {
  let ticks = 0
  let writes = 0
  const clientsForUrls = () =>
    ['rpc.ankr.com', 'mainnet.infura.io'].map((host) => ({
      url: `https://${host}/test`,
      provider: host,
      request: async (method, params) => {
        if (method === 'eth_chainId') return '0x1'
        const number = params[0] === 'finalized' ? first : Number(BigInt(params[0]))
        return rawHeader(chainHeader(number, Math.floor(TIME / 1000) - 60))
      },
      send: async () => ({ result: `0x${HOLDER.slice(2).padStart(64, '0')}` }),
    }))
  await assert.rejects(
    capturePostcutoff({
      out: join(tmpdir(), `apyusd-postcutoff-test-${randomUUID()}`),
      sourceLoader: async () => source,
      clientsForUrls,
      urls: ['https://rpc.ankr.com/test', 'https://mainnet.infura.io/test'],
      writer: async () => {
        writes++
      },
      freeBytes: () => 2_000_000_000,
      rpcClock: () => ticks++ * 30_000,
    }),
    /apyusd_postcutoff_rpc_budget/,
  )
  assert.equal(writes, 0)
})
