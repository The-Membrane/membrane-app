import assert from 'node:assert/strict'
import test from 'node:test'

import { encodeFunctionData, parseAbi, parseAbiItem, toEventSelector } from 'viem'

import { probeSiloGrossFlow } from './susde-silo-gross-flow-now.mjs'
import {
  ROUTE,
  scanIndexedSiloTransfers,
  selectIndexedOrigins,
} from './susde-silo-indexed-transfers.mjs'

const URLS = [
  'https://eth-mainnet.g.alchemy.com/v2/private-key',
  'https://www.eth-mainnet.g.alchemy.com/v2/other-key',
  'https://rpc.ankr.example/private-key',
]
const RPC_INDEXES = [0, 2]
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
const TRANSFER = toEventSelector(
  parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 value)'),
)
const hash = (n) => `0x${n.toString(16).padStart(64, '0')}`
const quantity = (n) => `0x${n.toString(16)}`
const word = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`
const addressWord = (value) => `0x${value.slice(2).padStart(64, '0')}`
const SOURCE = '0x0000000000000000000000000000000000000001'
const HOLDER = '0x0000000000000000000000000000000000000002'

function fixture({
  duplicate = false,
  mismatchNet = false,
  wrongIdentity = false,
  incompletePages = false,
  missingSelfMirror = false,
  malformed = false,
  offsettingIndexedOmission = false,
} = {}) {
  const calls = []
  const events = [
    { block: 104, index: 0, from: SOURCE, to: ROUTE.silo, value: 50n },
    { block: 111, index: 1, from: ROUTE.silo, to: ROUTE.silo, value: 3n },
    { block: 117, index: 2, from: ROUTE.silo, to: HOLDER, value: 20n },
    ...(offsettingIndexedOmission
      ? [
          { block: 108, index: 3, from: SOURCE, to: ROUTE.silo, value: 7n, omitIndexed: true },
          { block: 115, index: 4, from: ROUTE.silo, to: HOLDER, value: 7n, omitIndexed: true },
        ]
      : []),
  ]
  const raw = (event) => {
    const tx = hash(1_000 + event.block)
    return {
      category: 'erc20',
      blockNum: quantity(event.block),
      hash: tx,
      uniqueId: `${tx}:log:${event.index}`,
      from: event.from,
      to: event.to,
      rawContract: { address: ROUTE.usde, value: quantity(event.value) },
    }
  }
  const balanceAt = (n) =>
    1_000n +
    events
      .filter((event) => event.block <= n)
      .reduce(
        (sum, event) =>
          sum +
          (event.to === ROUTE.silo ? event.value : 0n) -
          (event.from === ROUTE.silo ? event.value : 0n),
        0n,
      ) +
    (mismatchNet && n >= 117 ? 1n : 0n)
  const fetchImpl = async (url, options) => {
    const request = JSON.parse(options.body)
    const [arg] = request.params
    const host = new URL(url).hostname
    calls.push({ host, method: request.method, params: request.params })
    let result
    if (request.method === 'eth_chainId') result = '0x1'
    else if (request.method === 'eth_getBlockByNumber') {
      const n = arg === 'finalized' ? 120 : Number(BigInt(arg))
      result = {
        number: quantity(n),
        hash: hash(n),
        parentHash: hash(n - 1),
        timestamp: quantity(1_700_000_000 + n * 12),
      }
    } else if (request.method === 'eth_call') {
      const pin = request.params[1]
      const block = Number(BigInt(pin.blockHash))
      assert.equal(pin.requireCanonical, true)
      if (arg.to === ROUTE.vault && arg.data === SELECTORS.asset)
        result = addressWord(wrongIdentity && block === 100 ? ROUTE.silo : ROUTE.usde)
      else if (arg.to === ROUTE.vault && arg.data === SELECTORS.silo)
        result = addressWord(ROUTE.silo)
      else if (arg.data === SELECTORS.decimals) result = word(18)
      else if (arg.to === ROUTE.usde && arg.data.startsWith('0x70a08231'))
        result = word(balanceAt(block))
      else throw Error('unexpected_call')
    } else if (request.method === 'alchemy_getAssetTransfers') {
      assert.equal(host, 'eth-mainnet.g.alchemy.com')
      assert.deepEqual(arg.contractAddresses, [ROUTE.usde])
      assert.deepEqual(arg.category, ['erc20'])
      assert.equal(arg.fromBlock, '0x65')
      assert.equal(arg.toBlock, '0x78')
      assert.equal(arg.excludeZeroValue, false)
      const leg = arg.toAddress ? 'receipt' : 'send'
      assert.equal(arg[leg === 'receipt' ? 'toAddress' : 'fromAddress'], ROUTE.silo)
      const page = arg.pageKey ? Number(arg.pageKey.split('-')[1]) : 1
      if (incompletePages) {
        const event = { block: 104, index: page, from: SOURCE, to: ROUTE.silo, value: 1n }
        result = { transfers: [raw(event)], pageKey: `${leg}-${page + 1}` }
      } else {
        const ordered = events.filter(
          (event) =>
            !event.omitIndexed &&
            (leg === 'receipt' ? event.to === ROUTE.silo : event.from === ROUTE.silo),
        )
        const transfer = ordered[page - 1]
        result = {
          transfers: transfer ? [raw(transfer)] : [],
          ...(page === 1 ? { pageKey: `${leg}-2` } : {}),
        }
        if (missingSelfMirror && leg === 'send')
          result.transfers = page === 1 ? [raw(ordered[1])] : []
        if (duplicate && leg === 'receipt' && page === 2) result.transfers = [raw(ordered[0])]
        if (malformed && leg === 'receipt' && page === 1)
          result.transfers[0].uniqueId = 'not-a-log-id'
      }
    } else if (request.method === 'eth_getLogs') {
      const first = Number(BigInt(arg.fromBlock))
      const last = Number(BigInt(arg.toBlock))
      const leg = arg.topics[1] === null ? 'receipt' : 'send'
      result = events
        .filter(
          (event) =>
            event.block >= first &&
            event.block <= last &&
            (leg === 'receipt' ? event.to === ROUTE.silo : event.from === ROUTE.silo),
        )
        .map((event) => ({
          address: ROUTE.usde,
          blockNumber: quantity(event.block),
          blockHash: hash(event.block),
          transactionHash: hash(1_000 + event.block),
          transactionIndex: '0x9',
          logIndex: quantity(event.index),
          removed: false,
          topics: [TRANSFER, addressWord(event.from), addressWord(event.to)],
          data: word(event.value),
        }))
    } else throw Error('unexpected_method')
    return {
      ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: request.id, result }),
    }
  }
  return { fetchImpl, calls }
}

function run(source, extra = {}) {
  return scanIndexedSiloTransfers({
    urls: URLS,
    rpcIndexes: RPC_INDEXES,
    startBlock: 100,
    endBlock: 120,
    fetchImpl: source.fetchImpl,
    ...extra,
  })
}

test('paginates both filters and reconciles indexed net while excluding mirrored self transfer', async () => {
  const source = fixture()
  const result = await run(source)
  assert.equal(result.status, 'endpoint_net_reconciled_indexed_only')
  assert.deepEqual(result.rpcHosts, ['eth-mainnet.g.alchemy.com', 'rpc.ankr.example'])
  assert.equal(result.providerIndependence.includes('operator_independence_unproven'), true)
  assert.equal(result.grossCompleteness, 'unproven_indexed_only')
  assert.equal(result.transferUnionDigest.rowCount, 3)
  assert.equal(result.transferDigestInterpretation.includes('not gross completeness'), true)
  assert.equal(result.provenance, 'alchemy_index_with_two_rpc_endpoint_match')
  assert.deepEqual(result.indexedPages, { receipts: 2, sends: 2 })
  assert.deepEqual(result.balances, { startRaw: '1000', endRaw: '1030' })
  assert.deepEqual(result.gross, {
    receiptsRaw: '50',
    sendsRaw: '20',
    receiptCount: 1,
    sendCount: 1,
    excludedSelfTransferCount: 1,
  })
  assert.equal(result.transfers.length, 3)
  assert.deepEqual(Object.keys(result.transfers[0]), [
    'blockNumber',
    'transactionHash',
    'logIndex',
    'from',
    'to',
    'valueRaw',
  ])
  assert.equal(result.residualRaw, '0')
  assert.equal(result.holderClaims, 'not_measured')
  assert.equal(result.futureForecast, 'not_measured')
  assert.equal(source.calls.filter((call) => call.method === 'alchemy_getAssetTransfers').length, 4)
  assert.equal(JSON.stringify(result).includes('private-key'), false)
})

test('raw and indexed outputs hash the same union, while an omitted offsetting pair changes only the digest', async () => {
  const matching = fixture()
  const indexed = await run(matching)
  const raw = await probeSiloGrossFlow({
    urls: [URLS[0], URLS[2]],
    rangeBlocks: 20,
    endBlock: 120,
    fetchImpl: matching.fetchImpl,
  })
  assert.deepEqual(raw.transferUnionDigest, indexed.transferUnionDigest)
  assert.deepEqual(raw.balances, indexed.balances)
  assert.equal(raw.transferUnionDigest.rowCount, 3)

  const omitted = fixture({ offsettingIndexedOmission: true })
  const indexedOmitted = await run(omitted)
  const rawComplete = await probeSiloGrossFlow({
    urls: [URLS[0], URLS[2]],
    rangeBlocks: 20,
    endBlock: 120,
    fetchImpl: omitted.fetchImpl,
  })
  assert.deepEqual(rawComplete.balances, indexedOmitted.balances)
  assert.equal(rawComplete.residualRaw, '0')
  assert.equal(indexedOmitted.residualRaw, '0')
  assert.equal(rawComplete.transferUnionDigest.rowCount, 5)
  assert.equal(indexedOmitted.transferUnionDigest.rowCount, 3)
  assert.notEqual(rawComplete.transferUnionDigest.sha256, indexedOmitted.transferUnionDigest.sha256)
  assert.equal(rawComplete.gross.receiptsRaw, '57')
  assert.equal(rawComplete.gross.sendsRaw, '27')
  assert.equal(indexedOmitted.gross.receiptsRaw, '50')
  assert.equal(indexedOmitted.gross.sendsRaw, '20')
})

test('duplicate indexed row across pages fails closed', async () => {
  await assert.rejects(run(fixture({ duplicate: true })), /duplicate_transfer/)
})

test('self transfer must appear in both indexed directional filters', async () => {
  await assert.rejects(run(fixture({ missingSelfMirror: true })), /self_transfer_filter_divergence/)
})

test('indexed net must equal two-host pinned balance delta', async () => {
  await assert.rejects(run(fixture({ mismatchNet: true })), /net_reconciliation_failed/)
})

test('both endpoint route identities are checked', async () => {
  await assert.rejects(run(fixture({ wrongIdentity: true })), /route_identity_mismatch/)
})

test('incomplete pagination and malformed uniqueId fail closed', async () => {
  await assert.rejects(run(fixture({ incompletePages: true })), /pagination_incomplete/)
  await assert.rejects(run(fixture({ malformed: true })), /transfer_identity_invalid/)
})

test('window and Alchemy index selection are explicit and bounded', async () => {
  assert.deepEqual(selectIndexedOrigins(URLS, RPC_INDEXES), [URLS[0], URLS[2]])
  assert.throws(() => selectIndexedOrigins(URLS, [0, 1]), /same_rpc_host/)
  assert.throws(() => selectIndexedOrigins(URLS, [2, 0]), /alchemy_origin_required/)
  await assert.rejects(run(fixture(), { endBlock: 357 }), /window_invalid/)
})
