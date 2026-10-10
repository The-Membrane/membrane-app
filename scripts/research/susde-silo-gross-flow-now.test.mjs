import assert from 'node:assert/strict'
import test from 'node:test'

import { encodeFunctionData, parseAbi, parseAbiItem, toEventSelector } from 'viem'

import {
  ROUTE,
  cliOptions,
  probeSiloGrossFlow,
  selectOriginPair,
} from './susde-silo-gross-flow-now.mjs'

const URLS = ['https://one.example/private', 'https://two.example/private']
const NOW_MS = Date.UTC(2026, 9, 3, 12)
const runProbe = (options) => probeSiloGrossFlow({ nowMs: () => NOW_MS, ...options })
const TRANSFER = toEventSelector(
  parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 value)'),
)
const ABI = parseAbi([
  'function asset() view returns (address)',
  'function silo() view returns (address)',
  'function decimals() view returns (uint8)',
])
const SELECTORS = Object.fromEntries(
  ['asset', 'silo', 'decimals'].map((functionName) => [
    functionName,
    encodeFunctionData({ abi: ABI, functionName }),
  ]),
)
const hash = (n) => `0x${n.toString(16).padStart(64, '0')}`
const quantity = (n) => `0x${n.toString(16)}`
const word = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`
const addressWord = (value) => `0x${value.slice(2).padStart(64, '0')}`

function fixture({
  finalizedBlock = 120,
  balanceOffset = 0n,
  balanceDivergence = false,
  divergentLogs = false,
  wrongAsset = false,
  duplicateLog = false,
  malformedLog = false,
  changedHeader = false,
  oversizedResponse = false,
  staleSeconds = 900,
} = {}) {
  const calls = []
  const events = [
    {
      block: 104,
      index: 0,
      from: '0x0000000000000000000000000000000000000001',
      to: ROUTE.silo,
      value: 50n,
    },
    { block: 111, index: 0, from: ROUTE.silo, to: ROUTE.silo, value: 3n },
    {
      block: 117,
      index: 0,
      from: ROUTE.silo,
      to: '0x0000000000000000000000000000000000000002',
      value: 20n,
    },
  ]
  const endReads = new Map()
  const balanceAt = (n) =>
    1_000n +
    events
      .filter((event) => event.block <= n)
      .reduce(
        (total, event) =>
          total +
          (event.to === ROUTE.silo ? event.value : 0n) -
          (event.from === ROUTE.silo ? event.value : 0n),
        0n,
      ) +
    (n >= 117 ? balanceOffset : 0n)
  const log = (event) => ({
    address: ROUTE.usde,
    blockNumber: quantity(event.block),
    blockHash: hash(event.block),
    transactionHash: hash(1000 + event.block),
    // A valid block can have earlier transactions that emitted no logs.
    transactionIndex: '0x9',
    logIndex: quantity(event.index),
    removed: false,
    topics: [TRANSFER, addressWord(event.from), addressWord(event.to)],
    data: word(event.value),
  })
  const fetchImpl = async (url, options) => {
    const request = JSON.parse(options.body)
    const host = new URL(url).hostname
    calls.push({ host, method: request.method, params: request.params })
    const [arg] = request.params
    let result
    if (request.method === 'eth_chainId') result = '0x1'
    else if (request.method === 'eth_getBlockByNumber') {
      const n = arg === 'finalized' ? finalizedBlock : Number(BigInt(arg))
      const key = `${host}:${n}`
      const prior = endReads.get(key) ?? 0
      endReads.set(key, prior + 1)
      result = {
        number: quantity(n),
        hash:
          changedHeader && host === 'two.example' && n === finalizedBlock && prior > 0
            ? hash(9999)
            : hash(n),
        parentHash: hash(n - 1),
        timestamp: quantity(NOW_MS / 1000 - staleSeconds + (n - finalizedBlock) * 12),
      }
    } else if (request.method === 'eth_call') {
      const { to, data } = arg
      const pin = request.params[1]
      assert.equal(pin.requireCanonical, true)
      const n = Number(BigInt(pin.blockHash))
      if (to === ROUTE.vault && data === SELECTORS.asset)
        result = addressWord(wrongAsset ? ROUTE.silo : ROUTE.usde)
      else if (to === ROUTE.vault && data === SELECTORS.silo) result = addressWord(ROUTE.silo)
      else if (data === SELECTORS.decimals) result = word(18)
      else if (to === ROUTE.usde && data.startsWith('0x70a08231'))
        result = word(balanceAt(n) + (balanceDivergence && host === 'two.example' ? 1n : 0n))
      else throw Error('unexpected_eth_call')
    } else if (request.method === 'eth_getLogs') {
      const first = Number(BigInt(arg.fromBlock))
      const last = Number(BigInt(arg.toBlock))
      const leg = arg.topics[1] === null ? 'receipt' : 'send'
      assert.equal(arg.address, ROUTE.usde)
      result = events
        .filter(
          (event) =>
            event.block >= first &&
            event.block <= last &&
            (leg === 'receipt' ? event.to === ROUTE.silo : event.from === ROUTE.silo),
        )
        .map(log)
      if (divergentLogs && host === 'two.example' && leg === 'send') result = []
      if (duplicateLog && result.length && leg === 'receipt') result.push({ ...result[0] })
      if (malformedLog && result.length && leg === 'receipt') result[0].topics = [TRANSFER]
    } else throw Error('unexpected_method')
    return {
      ok: true,
      headers: {
        get: () => (oversizedResponse && request.method === 'eth_getLogs' ? '262145' : null),
      },
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: request.id, result }),
    }
  }
  return { fetchImpl, calls }
}

test('two hosts reconcile gross USDe legs and exclude a mirrored self-transfer', async () => {
  const source = fixture()
  const result = await runProbe({
    urls: URLS,
    rangeBlocks: 20,
    fetchImpl: source.fetchImpl,
  })
  assert.equal(result.status, 'reconciled')
  assert.equal(result.provenance, 'two_rpc_host_match')
  assert.deepEqual(result.rpcHosts, ['one.example', 'two.example'])
  assert.equal(result.providerIndependence.includes('operator_independence_unproven'), true)
  assert.equal(result.observationMode, 'current_finalized')
  assert.deepEqual(result.balances, { startRaw: '1000', endRaw: '1030' })
  assert.deepEqual(result.gross, {
    receiptsRaw: '50',
    sendsRaw: '20',
    receiptCount: 1,
    sendCount: 1,
    excludedSelfTransferCount: 1,
  })
  assert.equal(result.residualRaw, '0')
  assert.equal(result.transferUnionDigest.rowCount, 3)
  assert.match(result.transferUnionDigest.sha256, /^[0-9a-f]{64}$/)
  assert.equal(result.transferDigestInterpretation.includes('not gross completeness'), true)
  assert.equal(result.holderClaims, 'not_measured')
  assert.equal(result.executableQ, 'not_measured')
  assert.equal(result.futureForecast, 'not_measured')
  assert.equal(result.currentFinalizedAgeSeconds, 900)
  assert.equal(
    result.grossCompleteness,
    'two_rpc_log_sets_agree_net_reconciled_not_independently_complete',
  )
  assert.equal(result.routeIdentity, 'start_and_end_only')
  assert.equal(source.calls.filter((call) => call.method === 'eth_getLogs').length, 8)
  assert.equal(
    source.calls
      .filter((call) => call.method === 'eth_getLogs')
      .every(
        (call) => Number(BigInt(call.params[0].toBlock) - BigInt(call.params[0].fromBlock)) < 10,
      ),
    true,
  )
  assert.equal(JSON.stringify(result).includes('/private'), false)
})

test('historical end remains finalized and is labeled retrospective', async () => {
  const source = fixture()
  const result = await runProbe({
    urls: URLS,
    rangeBlocks: 20,
    endBlock: 118,
    fetchImpl: source.fetchImpl,
  })
  assert.equal(result.observationMode, 'retrospective')
  assert.equal(result.start.number, 98)
  assert.equal(result.end.number, 118)
  assert.equal(result.residualRaw, '0')
})

test('the 256-block ceiling stays within the RPC call budget', async () => {
  const source = fixture({ finalizedBlock: 300 })
  const result = await runProbe({
    urls: URLS,
    rangeBlocks: 256,
    fetchImpl: source.fetchImpl,
  })
  assert.equal(result.start.number, 44)
  assert.equal(result.end.number, 300)
  assert.equal(result.rpcBudget.calls, 134)
  assert.equal(result.residualRaw, '0')
})

test('two agreeing but stale finalized heads cannot be labeled current', async () => {
  const source = fixture({ staleSeconds: 3600 })
  await assert.rejects(
    runProbe({ urls: URLS, rangeBlocks: 20, fetchImpl: source.fetchImpl }),
    /current_head_stale/,
  )
  const retrospective = await runProbe({
    urls: URLS,
    rangeBlocks: 20,
    endBlock: 120,
    fetchImpl: source.fetchImpl,
  })
  assert.equal(retrospective.observationMode, 'retrospective')
  assert.equal(retrospective.currentFinalizedAgeSeconds, null)
})

test('endpoint balance must equal receipts minus sends exactly', async () => {
  const source = fixture({ balanceOffset: 1n })
  await assert.rejects(
    runProbe({ urls: URLS, rangeBlocks: 20, fetchImpl: source.fetchImpl }),
    /balance_reconciliation_failed/,
  )
})

test('different provider log sets, including an empty response, fail closed', async () => {
  const source = fixture({ divergentLogs: true })
  await assert.rejects(
    runProbe({ urls: URLS, rangeBlocks: 20, fetchImpl: source.fetchImpl }),
    /provider_log_divergence/,
  )
})

test('providers must also agree on pinned balances', async () => {
  const source = fixture({ balanceDivergence: true })
  await assert.rejects(
    runProbe({ urls: URLS, rangeBlocks: 20, fetchImpl: source.fetchImpl }),
    /provider_call_divergence/,
  )
})

test('invalid range, historical finality, host pair, and route identity fail closed', async () => {
  const source = fixture()
  await assert.rejects(
    runProbe({ urls: URLS, rangeBlocks: 257, fetchImpl: source.fetchImpl }),
    /range_invalid/,
  )
  await assert.rejects(
    runProbe({ urls: URLS, rangeBlocks: 20, endBlock: 121, fetchImpl: source.fetchImpl }),
    /end_not_finalized/,
  )
  assert.throws(
    () => selectOriginPair(['https://rpc.example/one', 'https://www.rpc.example/two']),
    /two_origins_required/,
  )
  await assert.rejects(
    runProbe({
      urls: URLS,
      rangeBlocks: 20,
      fetchImpl: fixture({ wrongAsset: true }).fetchImpl,
    }),
    /route_identity_mismatch/,
  )
})

test('CLI can choose two configured host indexes without exposing their URLs', () => {
  const all = [URLS[0], 'https://middle.example/private', URLS[1]]
  const options = cliOptions(['--run', '--blocks=16', '--rpc-indexes=0,2'], all)
  assert.deepEqual(options.urls, URLS)
  assert.equal(options.rangeBlocks, 16)
  assert.throws(() => cliOptions(['--run', '--rpc-indexes=0,0'], all), /rpc_index_invalid/)
})

test('duplicate or malformed Transfer logs and changed headers fail closed', async () => {
  for (const [option, reason] of [
    ['duplicateLog', /log_duplicate/],
    ['malformedLog', /log_invalid/],
    ['changedHeader', /provider_header_divergence/],
    ['oversizedResponse', /response_oversize/],
  ]) {
    const source = fixture({ [option]: true })
    await assert.rejects(
      runProbe({ urls: URLS, rangeBlocks: 20, fetchImpl: source.fetchImpl }),
      reason,
    )
  }
})
