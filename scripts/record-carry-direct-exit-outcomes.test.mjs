import assert from 'node:assert/strict'
import test from 'node:test'
import { encodeEventTopics, parseAbiItem, toHex } from 'viem'

import { apply } from './apply-carry-direct-exit-ddl.mjs'
import {
  audit,
  candidateFor,
  issue,
  recentRecipients,
  score,
  scoreDecision,
} from './record-carry-direct-exit-outcomes.mjs'
import constantsModule from '../lib/carry/directSupplyMarketConstants.ts'

const { DIRECT_SUPPLY_MARKETS } = constantsModule

const ADDRESS = (digit) => `0x${digit.repeat(40)}`
const HASH = `0x${'a'.repeat(64)}`

test('direct H1 score waits for the physical finalized target and expires honestly', () => {
  const target = Date.parse('2026-09-29T12:00:00.000Z')
  const issue = { target_at: new Date(target).toISOString() }
  assert.equal(scoreDecision(issue, target, target - 15 * 60_000 - 1), 'wait')
  assert.equal(scoreDecision(issue, target - 15 * 60_000 - 1, target), 'wait')
  assert.equal(scoreDecision(issue, target, target), 'probe')
  assert.equal(
    scoreDecision(issue, target + 15 * 60_000 + 1, target),
    'target_block_outside_window',
  )
  assert.equal(
    scoreDecision(issue, Number.NEGATIVE_INFINITY, target + 15 * 60_000 + 1),
    'target_window_missed',
  )
})

test('only positive receipt-verified transfer recipients are sampled for aTokens', async () => {
  const token = ADDRESS('1')
  const from = ADDRESS('2')
  const recipient = ADDRESS('3')
  const txHash = `0x${'b'.repeat(64)}`
  const event = parseAbiItem(
    'event Transfer(address indexed from,address indexed to,uint256 value)',
  )
  const log = {
    address: token,
    topics: encodeEventTopics({
      abi: [event],
      eventName: 'Transfer',
      args: { from: ADDRESS('0'), to: recipient },
    }),
    data: toHex(7n, { size: 32 }),
    blockHash: HASH,
    transactionHash: txHash,
    logIndex: 1,
    args: { from: ADDRESS('0'), to: recipient, value: 7n },
    blockNumber: 99n,
  }
  const transfer = {
    ...log,
    logIndex: 2,
    topics: encodeEventTopics({
      abi: [event],
      eventName: 'Transfer',
      args: { from, to: ADDRESS('4') },
    }),
    args: { from, to: ADDRESS('4'), value: 7n },
  }
  const calls = []
  const client = {
    getLogs: async (request) => {
      calls.push(request)
      return calls.length === 1
        ? [
            log,
            transfer,
            {
              ...log,
              args: { from: ADDRESS('0'), to: ADDRESS('5'), value: 0n },
              blockNumber: 97n,
              logIndex: 3,
            },
          ]
        : []
    },
    getTransactionReceipt: async () => ({
      status: 'success',
      blockNumber: 99n,
      blockHash: HASH,
      logs: [log, transfer],
    }),
  }
  const result = await recentRecipients(client, { kind: 'aaveV3Usdc', destination: token }, 100n)
  assert.deepEqual(result, [
    { holder: ADDRESS('4'), event: 'atoken_transfer_recipient', eventBlock: 99n },
    { holder: recipient, event: 'atoken_transfer_recipient', eventBlock: 99n },
  ])
  assert.equal(calls[0].address, token)
  assert.equal(calls.length, 1)
})

test('Comet samples Supply dst, not from, and never assumes supplied balance', async () => {
  const event = parseAbiItem(
    'event Supply(address indexed from,address indexed dst,uint256 amount)',
  )
  const log = {
    address: ADDRESS('1'),
    topics: encodeEventTopics({
      abi: [event],
      eventName: 'Supply',
      args: { from: ADDRESS('2'), dst: ADDRESS('3') },
    }),
    data: toHex(100n, { size: 32 }),
    blockHash: HASH,
    transactionHash: `0x${'b'.repeat(64)}`,
    logIndex: 0,
    args: { from: ADDRESS('2'), dst: ADDRESS('3'), amount: 100n },
    blockNumber: 100n,
  }
  const client = {
    getLogs: async () => [log],
    getTransactionReceipt: async () => ({
      status: 'success',
      blockNumber: 100n,
      blockHash: HASH,
      logs: [log],
    }),
  }
  const result = await recentRecipients(
    client,
    { kind: 'compoundV3Usdc', destination: ADDRESS('1') },
    100n,
  )
  assert.equal(result[0].holder, ADDRESS('3'))
  assert.equal(result[0].event, 'comet_supply')
})

test('a log with decoded recipient inconsistent with receipt topics is rejected', async () => {
  const event = parseAbiItem(
    'event Transfer(address indexed from,address indexed to,uint256 value)',
  )
  const log = {
    address: ADDRESS('1'),
    topics: encodeEventTopics({
      abi: [event],
      eventName: 'Transfer',
      args: { from: ADDRESS('2'), to: ADDRESS('3') },
    }),
    data: toHex(100n, { size: 32 }),
    blockHash: HASH,
    transactionHash: `0x${'b'.repeat(64)}`,
    logIndex: 0,
    blockNumber: 100n,
    args: { from: ADDRESS('2'), to: ADDRESS('4'), value: 100n },
  }
  const client = {
    getLogs: async () => [log],
    getTransactionReceipt: async () => ({
      status: 'success',
      blockNumber: 100n,
      blockHash: HASH,
      logs: [log],
    }),
  }
  assert.deepEqual(
    await recentRecipients(client, { kind: 'aaveV3Usdc', destination: ADDRESS('1') }, 100n),
    [],
  )
})

test('a log outside its requested historical window is not a candidate', async () => {
  const event = parseAbiItem(
    'event Transfer(address indexed from,address indexed to,uint256 value)',
  )
  const log = {
    address: ADDRESS('1'),
    topics: encodeEventTopics({
      abi: [event],
      eventName: 'Transfer',
      args: { from: ADDRESS('0'), to: ADDRESS('3') },
    }),
    data: toHex(1n, { size: 32 }),
    blockHash: HASH,
    transactionHash: `0x${'b'.repeat(64)}`,
    logIndex: 0,
    args: { from: ADDRESS('0'), to: ADDRESS('3'), value: 1n },
    blockNumber: 9_999n,
  }
  let receiptCalls = 0
  const client = {
    getLogs: async () => [log],
    getTransactionReceipt: async () => {
      receiptCalls++
      return { status: 'success', blockNumber: log.blockNumber, blockHash: HASH, logs: [log] }
    },
  }
  const result = await recentRecipients(
    client,
    { kind: 'sparkLendUsdt', destination: ADDRESS('1') },
    20_000n,
    4096n,
  )
  assert.deepEqual(result, [])
  assert.equal(receiptCalls, 0)
})

test('non-Spark markets cap receipt checks when many candidate logs are invalid', async () => {
  const event = parseAbiItem(
    'event Transfer(address indexed from,address indexed to,uint256 value)',
  )
  const token = ADDRESS('1')
  const blockNumber = 20_000n
  const logs = Array.from({ length: 17 }, (_, index) => ({
    address: token,
    topics: encodeEventTopics({
      abi: [event],
      eventName: 'Transfer',
      args: { from: ADDRESS('0'), to: `0x${String(index + 1).padStart(40, '0')}` },
    }),
    data: toHex(1n, { size: 32 }),
    blockHash: HASH,
    transactionHash: `0x${String(index + 1).padStart(64, '0')}`,
    logIndex: index,
    args: { from: ADDRESS('0'), to: `0x${String(index + 1).padStart(40, '0')}`, value: 1n },
    blockNumber,
  }))
  let receipts = 0
  const client = {
    getLogs: async (request) =>
      request.fromBlock <= blockNumber && blockNumber <= request.toBlock ? logs : [],
    getTransactionReceipt: async () => {
      receipts++
      return { status: 'reverted', blockNumber, blockHash: HASH, logs: [] }
    },
  }
  const result = await recentRecipients(
    client,
    { kind: 'aaveV3Usdc', destination: token },
    blockNumber,
  )
  assert.deepEqual(result, [])
  assert.equal(receipts, 16)
})

test('Spark receipt-page rotation reaches an older valid log behind eight bad newer logs', async () => {
  const event = parseAbiItem(
    'event Transfer(address indexed from,address indexed to,uint256 value)',
  )
  const token = ADDRESS('1')
  const blockNumber = 20_000n
  const logs = Array.from({ length: 9 }, (_, index) => ({
    address: token,
    topics: encodeEventTopics({
      abi: [event],
      eventName: 'Transfer',
      args: { from: ADDRESS('0'), to: `0x${String(index + 1).padStart(40, '0')}` },
    }),
    data: toHex(1n, { size: 32 }),
    blockHash: HASH,
    transactionHash: `0x${String(index + 1).padStart(64, '0')}`,
    logIndex: index,
    args: { from: ADDRESS('0'), to: `0x${String(index + 1).padStart(40, '0')}`, value: 1n },
    blockNumber,
  }))
  let receipts = 0
  const client = {
    getLogs: async (request) =>
      request.fromBlock <= blockNumber && blockNumber <= request.toBlock ? logs : [],
    getTransactionReceipt: async ({ hash }) => {
      receipts++
      const log = logs.find((entry) => entry.transactionHash === hash)
      return {
        status: log.logIndex === 0 ? 'success' : 'reverted',
        blockNumber,
        blockHash: HASH,
        logs: [log],
      }
    },
  }
  const market = { kind: 'sparkLendUsdt', destination: token }
  assert.deepEqual(await recentRecipients(client, market, blockNumber, 0n, 8, Infinity, 0), [])
  assert.equal(receipts, 8)
  const rotated = await recentRecipients(client, market, blockNumber, 0n, 8, Infinity, 1)
  assert.equal(rotated.length, 1)
  assert.equal(rotated[0].holder, logs[0].args.to)
  assert.equal(receipts, 16)
})

test('Spark calls a truncated unsuccessful receipt page sampled exhaustion', async () => {
  const pinned = DIRECT_SUPPLY_MARKETS.sparkLendUsdt
  const market = { ...pinned, kind: 'sparkLendUsdt', destination: pinned.destination.toLowerCase() }
  const event = parseAbiItem(
    'event Transfer(address indexed from,address indexed to,uint256 value)',
  )
  const blockNumber = 100_000n
  const logs = Array.from({ length: 9 }, (_, index) => ({
    address: market.destination,
    topics: encodeEventTopics({
      abi: [event],
      eventName: 'Transfer',
      args: { from: ADDRESS('0'), to: `0x${String(index + 1).padStart(40, '0')}` },
    }),
    data: toHex(1n, { size: 32 }),
    blockHash: HASH,
    transactionHash: `0x${String(index + 1).padStart(64, '0')}`,
    logIndex: index,
    args: { from: ADDRESS('0'), to: `0x${String(index + 1).padStart(40, '0')}`, value: 1n },
    blockNumber,
  }))
  const checkedIndexes = []
  const client = {
    getBlock: async () => ({ number: blockNumber, hash: HASH }),
    getLogs: async (request) =>
      request.fromBlock <= blockNumber && blockNumber <= request.toBlock ? logs : [],
    getTransactionReceipt: async ({ hash }) => {
      const log = logs.find((entry) => entry.transactionHash === hash)
      checkedIndexes.push(log.logIndex)
      return {
        status: log.logIndex === 0 ? 'success' : 'reverted',
        blockNumber,
        blockHash: HASH,
        logs: [log],
      }
    },
    getCode: async () => {
      throw new Error('valid ninth receipt is not in this bounded page')
    },
  }
  const currentSlot = Math.floor(Date.now() / 900_000)
  const firstPageSlot = currentSlot - (currentSlot % 9)
  const result = await candidateFor(
    client,
    market,
    async () => {
      throw new Error('no verified recipient should be quoted')
    },
    firstPageSlot * 900_000,
  )
  assert.equal(result.unavailableReason, 'sampled_candidate_exhausted')
  assert.equal(checkedIndexes.length, 8)
  assert.ok(!checkedIndexes.includes(0))
})

test('Spark rotates to a receipt-verified older holder and checks live exit', async () => {
  const pinned = DIRECT_SUPPLY_MARKETS.sparkLendUsdt
  const market = { ...pinned, kind: 'sparkLendUsdt', destination: pinned.destination.toLowerCase() }
  const holder = ADDRESS('3')
  const event = parseAbiItem(
    'event Transfer(address indexed from,address indexed to,uint256 value)',
  )
  const finalizedBlock = 100_000n
  const eventBlock = finalizedBlock - 11n * 4096n
  const log = {
    address: market.destination,
    topics: encodeEventTopics({
      abi: [event],
      eventName: 'Transfer',
      args: { from: ADDRESS('0'), to: holder },
    }),
    data: toHex(100n, { size: 32 }),
    blockHash: HASH,
    transactionHash: `0x${'b'.repeat(64)}`,
    logIndex: 0,
    args: { from: ADDRESS('0'), to: holder, value: 100n },
    blockNumber: eventBlock,
  }
  const ranges = []
  let codeReads = 0
  let quotes = 0
  const client = {
    getBlock: async () => ({ number: finalizedBlock, hash: HASH }),
    getLogs: async (request) => {
      ranges.push([request.fromBlock, request.toBlock])
      return request.fromBlock <= eventBlock && request.toBlock >= eventBlock ? [log] : []
    },
    getTransactionReceipt: async () => ({
      status: 'success',
      blockNumber: eventBlock,
      blockHash: HASH,
      logs: [log],
    }),
    getCode: async () => {
      codeReads++
      return '0x'
    },
    readContract: async () => 100n,
  }
  const quoteReader = async (_client, request) => {
    quotes++
    assert.equal(request.owner, holder)
    assert.equal(request.assetsRaw, '10')
    return {
      status: 'checked_at_finalized_block',
      routeKey: market.routeKey,
      market: {
        kind: market.kind,
        identity: 'pinned_market_and_live_underlying',
        address: market.destination,
        assetAddress: market.underlying,
        assetDecimals: market.decimals,
      },
      request: { assetsRaw: request.assetsRaw },
      position: { suppliedBalanceRaw: '100' },
      simulation: { status: 'success' },
      source: {
        chainId: 1,
        blockNumber: Number(finalizedBlock),
        blockHash: HASH,
        blockTime: new Date().toISOString(),
      },
    }
  }
  const currentSlot = Math.floor(Date.now() / 900_000)
  const rotatedSlot = Math.floor(currentSlot / 16) * 16 + 10
  const result = await candidateFor(client, market, quoteReader, rotatedSlot * 900_000)
  assert.equal(result.holder, holder)
  assert.equal(result.eventBlock, eventBlock)
  assert.equal(codeReads, 1)
  assert.equal(quotes, 1)
  assert.equal(ranges.length, 8)
  assert.ok(ranges.some(([from, to]) => from <= eventBlock && to >= eventBlock))
})

test('Spark caps receipts and reserves live holder checks across windows', async () => {
  const pinned = DIRECT_SUPPLY_MARKETS.sparkLendUsdt
  const market = { ...pinned, kind: 'sparkLendUsdt', destination: pinned.destination.toLowerCase() }
  const event = parseAbiItem(
    'event Transfer(address indexed from,address indexed to,uint256 value)',
  )
  const blockNumber = 100_000n
  const logs = Array.from({ length: 9 }, (_, index) => ({
    address: market.destination,
    topics: encodeEventTopics({
      abi: [event],
      eventName: 'Transfer',
      args: { from: ADDRESS('0'), to: `0x${String(index + 1).padStart(40, '0')}` },
    }),
    data: toHex(1n, { size: 32 }),
    blockHash: HASH,
    transactionHash: `0x${String(index + 1).padStart(64, '0')}`,
    logIndex: index,
    args: { from: ADDRESS('0'), to: `0x${String(index + 1).padStart(40, '0')}`, value: 1n },
    blockNumber,
  }))
  let getLogsCalls = 0
  let receiptCalls = 0
  let holderChecks = 0
  const client = {
    getBlock: async () => ({ number: blockNumber, hash: HASH }),
    getLogs: async (request) => {
      getLogsCalls++
      return request.toBlock === blockNumber ? logs : []
    },
    getTransactionReceipt: async ({ hash }) => {
      receiptCalls++
      const log = logs.find((entry) => entry.transactionHash === hash)
      return { status: 'success', blockNumber, blockHash: HASH, logs: [log] }
    },
    getCode: async () => {
      holderChecks++
      return '0x'
    },
    readContract: async () => 0n,
  }
  const result = await candidateFor(client, market, async () => {
    throw new Error('zero balance must not quote')
  })
  assert.equal(result.unavailableReason, 'sampled_candidate_exhausted')
  assert.equal(getLogsCalls, 12)
  assert.equal(receiptCalls, 8)
  assert.equal(holderChecks, 2)
})

test('Spark reserves live holder checks for older windows after stale recent holders', async () => {
  const pinned = DIRECT_SUPPLY_MARKETS.sparkLendUsdt
  const market = { ...pinned, kind: 'sparkLendUsdt', destination: pinned.destination.toLowerCase() }
  const event = parseAbiItem(
    'event Transfer(address indexed from,address indexed to,uint256 value)',
  )
  const head = 100_000n
  const now = Date.now()
  const olderBlock = head - BigInt(1 + (Math.floor(now / 900_000) % 16)) * 4096n
  const olderHolder = ADDRESS('f')
  const makeLog = (holder, blockNumber, index) => ({
    address: market.destination,
    topics: encodeEventTopics({
      abi: [event],
      eventName: 'Transfer',
      args: { from: ADDRESS('0'), to: holder },
    }),
    data: toHex(1n, { size: 32 }),
    blockHash: HASH,
    transactionHash: `0x${String(index + 1).padStart(64, '0')}`,
    logIndex: index,
    args: { from: ADDRESS('0'), to: holder, value: 1n },
    blockNumber,
  })
  const logs = [
    ...Array.from({ length: 8 }, (_, index) =>
      makeLog(`0x${String(index + 1).padStart(40, '0')}`, head, index),
    ),
    makeLog(olderHolder, olderBlock, 8),
  ]
  let holderChecks = 0
  const client = {
    getBlock: async () => ({ number: head, hash: HASH }),
    getLogs: async (request) =>
      logs.filter(
        (entry) => request.fromBlock <= entry.blockNumber && entry.blockNumber <= request.toBlock,
      ),
    getTransactionReceipt: async ({ hash }) => {
      const log = logs.find((entry) => entry.transactionHash === hash)
      return {
        status: 'success',
        blockNumber: log.blockNumber,
        blockHash: HASH,
        logs: [log],
      }
    },
    getCode: async () => {
      holderChecks++
      return '0x'
    },
    readContract: async ({ args }) => (args[0] === olderHolder ? 100n : 0n),
  }
  const quoteReader = async (_client, request) => ({
    status: 'checked_at_finalized_block',
    routeKey: market.routeKey,
    market: {
      kind: market.kind,
      identity: 'pinned_market_and_live_underlying',
      address: market.destination,
      assetAddress: market.underlying,
      assetDecimals: market.decimals,
    },
    request: { assetsRaw: request.assetsRaw },
    position: { suppliedBalanceRaw: '100' },
    simulation: { status: 'success' },
    source: {
      chainId: 1,
      blockNumber: Number(head),
      blockHash: HASH,
      blockTime: new Date().toISOString(),
    },
  })
  const candidate = await candidateFor(client, market, quoteReader, now)
  assert.equal(candidate.holder, olderHolder)
  assert.equal(holderChecks, 3)
})

test('empty verified event windows produce three explicit unavailable attempts', async () => {
  const now = Date.now()
  const saved = new Map()
  const sql = async (strings, ...values) => {
    const query = strings.join('?')
    if (query.includes('SELECT id FROM carry_direct_exit_attempts')) return []
    if (query.includes('INSERT INTO carry_direct_exit_attempts')) {
      const kind = values[1]
      saved.set(kind, values.at(-1))
      return []
    }
    if (query.includes('SELECT caller_checksum_sha256')) {
      return [{ caller_checksum_sha256: saved.get(values[1]) }]
    }
    throw new Error(`unexpected SQL: ${query}`)
  }
  const client = {
    getBlock: async () => ({ number: 100n, hash: HASH }),
    getLogs: async () => [],
    getCode: async () => {
      throw new Error('no candidate should be checked')
    },
  }
  const result = await issue(sql, client, now)
  assert.deepEqual(result, { issued: 0, unavailable: 3, replayed: 0 })
  assert.equal(saved.size, 3)
})

test('Spark runs last and cannot insert an attempt after its issue slot expires', async () => {
  const now = Date.now()
  const inserted = []
  const checksums = new Map()
  const sql = async (strings, ...values) => {
    const query = strings.join('?')
    if (query.includes('SELECT id FROM carry_direct_exit_attempts')) return []
    if (query.includes('INSERT INTO carry_direct_exit_attempts')) {
      inserted.push(values[1])
      checksums.set(values[1], values.at(-1))
      return []
    }
    if (query.includes('SELECT caller_checksum_sha256'))
      return [{ caller_checksum_sha256: checksums.get(values[1]) }]
    throw new Error(`unexpected SQL: ${query}`)
  }
  const client = {
    getBlock: async () => ({ number: 100_000n, hash: HASH }),
    getLogs: async () => [],
  }
  let clockReads = 0
  const clock = () => (++clockReads < 3 ? now : now + 900_000)
  await assert.rejects(
    issue(
      sql,
      client,
      now,
      async () => {
        throw new Error('no candidate should be quoted')
      },
      clock,
    ),
    /direct_exit_issue_slot_elapsed/,
  )
  assert.deepEqual(inserted, ['aaveV3Usdc', 'compoundV3Usdc'])
})

test('audit reports private-safe reason and status totals for every exact direct route', async () => {
  const sql = async (strings) => {
    const query = strings.join('?')
    if (query.includes('FROM carry_direct_exit_attempts GROUP BY'))
      return [
        {
          market_kind: 'sparkLendUsdt',
          status: 'unavailable',
          unavailable_reason: 'no_recent_event_candidate',
          n: 6,
        },
        {
          market_kind: 'sparkLendUsdt',
          status: 'unavailable',
          unavailable_reason: 'quote_unavailable',
          n: 2,
        },
        { market_kind: 'aaveV3Usdc', status: 'issued', unavailable_reason: null, n: 4 },
      ]
    if (query.includes('FROM carry_direct_exit_outcomes GROUP BY'))
      return [
        { market_kind: 'aaveV3Usdc', status: 'success', missing_reason: null, n: 2 },
        {
          market_kind: 'aaveV3Usdc',
          status: 'missing',
          missing_reason: 'target_window_missed',
          n: 1,
        },
        { market_kind: 'aaveV3Usdc', status: 'missing', missing_reason: 'quote_unavailable', n: 1 },
      ]
    if (query.includes('count(*)::integer AS n FROM carry_direct_exit_outcomes o'))
      return [{ n: 0 }]
    if (query.includes('WITH bounds AS'))
      return [
        {
          first_slot: '100',
          last_slot: '100',
          expected: '3',
          missing: '0',
          first_missing_slot: null,
        },
      ]
    throw new Error(`unexpected SQL: ${query}`)
  }
  const result = await audit(sql)
  assert.deepEqual(result.diagnostics.overall, {
    attempts: { issued: 4, unavailable: 8 },
    unavailableReasons: { no_recent_event_candidate: 6, quote_unavailable: 2 },
    outcomes: { success: 2, evm_revert: 0, position_insufficient: 0, missing: 2 },
    missingReasons: { target_window_missed: 1, quote_unavailable: 1 },
  })
  assert.equal(result.diagnostics.byRoute.length, 3)
  const spark = result.diagnostics.byRoute.find((row) => row.market === 'sparkLendUsdt')
  assert.equal(spark.routeKey, 'USDT → supply on Spark')
  assert.deepEqual(spark.unavailableReasons, { no_recent_event_candidate: 6, quote_unavailable: 2 })
  assert.equal(
    result.diagnostics.byRoute.find((row) => row.market === 'compoundV3Usdc').attempts.issued,
    0,
  )
  assert.ok(!JSON.stringify(result).includes('holder'))
  assert.ok(!JSON.stringify(result).includes('assets_raw'))
})

test('position below frozen Q is censored even if Comet simulation could borrow', async () => {
  const now = Date.now()
  const market = {
    kind: 'compoundV3Usdc',
    routeKey: 'USDC → supply on Compound v3',
    destination: '0xc3d688b66703497daa19211eedff47f25384cdc3',
    underlying: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  }
  const row = {
    id: '7',
    market_kind: market.kind,
    route_key: market.routeKey,
    destination: market.destination,
    holder: ADDRESS('3'),
    amount: '100',
    assets_raw: '100',
    source_block: '10',
    target_at: new Date(now).toISOString(),
  }
  let inserted = []
  const sql = async (strings, ...values) => {
    const query = strings.join('?')
    if (query.includes('WITH actionable')) return [row]
    if (query.includes('INSERT INTO carry_direct_exit_outcomes')) {
      inserted = values
      return []
    }
    if (query.includes('SELECT caller_checksum_sha256'))
      return [{ caller_checksum_sha256: inserted.at(-1) }]
    throw new Error(`unexpected SQL: ${query}`)
  }
  const client = { getBlock: async () => ({ timestamp: BigInt(Math.floor(now / 1000)) }) }
  const quoteReader = async () => ({
    status: 'checked_at_finalized_block',
    routeKey: market.routeKey,
    market: {
      kind: market.kind,
      identity: 'pinned_market_and_live_underlying',
      address: market.destination,
      assetAddress: market.underlying,
      assetDecimals: 6,
    },
    request: { assetsRaw: '100' },
    position: { suppliedBalanceRaw: '50' },
    simulation: { status: 'not_holder_exit' },
    source: {
      chainId: 1,
      blockNumber: 11,
      blockHash: HASH,
      blockTime: new Date(now).toISOString(),
      observedAt: new Date(now).toISOString(),
    },
  })
  const result = await score(sql, client, now, quoteReader)
  assert.equal(result.position_insufficient, 1)
  assert.equal(result.success, 0)
  assert.equal(inserted[7], 'position_insufficient')
})

test('schema enforces append-only exact identity, source-time target, and late missing', async () => {
  const statements = []
  const sql = Object.assign(
    async (strings) => {
      statements.push(strings.join('?'))
      return []
    },
    {
      query: async (statement) => {
        statements.push(statement)
        return []
      },
    },
  )
  await apply(sql)
  const ddl = statements.join('\n')
  assert.match(ddl, /UNIQUE \(tick_slot, market_kind\)/)
  assert.match(ddl, /NEW\.target_at <> NEW\.source_block_at \+ interval '1 hour'/)
  assert.match(ddl, /NEW\.source_block <= issue\.source_block/)
  assert.match(ddl, /NEW\.holder IS DISTINCT FROM issue\.holder/)
  assert.match(ddl, /NEW\.assets_raw IS DISTINCT FROM issue\.assets_raw/)
  assert.match(ddl, /direct_exit_missing_early/)
  assert.match(ddl, /carry_direct_exit_outcomes WHERE tick_slot=slot\) >= 6/)
  assert.match(ddl, /BEFORE UPDATE OR DELETE/)
  assert.match(ddl, /BEFORE TRUNCATE/)
})
