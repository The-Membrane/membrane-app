// One-shot Alchemy indexed USDe silo transfer scan. The index is one origin;
// independent RPCs attest endpoints, not completeness of its gross rows.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { encodeFunctionData, parseAbi } from 'viem'

import { readEnv } from '../lib/venue-reads.mjs'
import { configuredPublicRpcUrls } from './carry-public-direct-exit-issue.mjs'
import { ROUTE } from './susde-silo-gross-flow-now.mjs'
import {
  TRANSFER_DIGEST_INTERPRETATION,
  digestTransferUnion,
} from './susde-silo-transfer-digest.mjs'

export { ROUTE }
export const MAX_WINDOW_BLOCKS = 256
export const MAX_PAGES_PER_LEG = 4
export const MAX_TRANSFER_ROWS = 400
const PAGE_SIZE = 100
const MAX_RPC_CALLS = 48
const MAX_RESPONSE_BYTES = 128 * 1024
const MAX_TOTAL_RESPONSE_BYTES = 1024 * 1024
const MAX_RUN_MS = 90_000
const HASH = /^0x[0-9a-fA-F]{64}$/
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const WORD = /^0x[0-9a-fA-F]{64}$/
const QUANTITY = /^0x[0-9a-fA-F]+$/
const UNIQUE_ID = /^(0x[0-9a-fA-F]{64}):log:(0|[1-9]\d*)$/
const ABI = parseAbi([
  'function asset() view returns (address)',
  'function silo() view returns (address)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
])
const CALL = Object.freeze({
  asset: encodeFunctionData({ abi: ABI, functionName: 'asset' }),
  silo: encodeFunctionData({ abi: ABI, functionName: 'silo' }),
  decimals: encodeFunctionData({ abi: ABI, functionName: 'decimals' }),
  balance: encodeFunctionData({ abi: ABI, functionName: 'balanceOf', args: [ROUTE.silo] }),
})
const hex = (n) => `0x${n.toString(16)}`
const fail = (reason) => {
  throw Error(`susde_silo_indexed_${reason}`)
}
const insist = (condition, reason) => {
  if (!condition) fail(reason)
}

function quantity(value, reason) {
  insist(typeof value === 'string' && QUANTITY.test(value), reason)
  const parsed = Number(BigInt(value))
  insist(Number.isSafeInteger(parsed) && parsed >= 0, reason)
  return parsed
}

function word(value) {
  insist(typeof value === 'string' && WORD.test(value), 'call_word_invalid')
  return value.toLowerCase()
}

function addressWord(value) {
  const encoded = word(value).slice(2)
  insist(/^0{24}$/.test(encoded.slice(0, 24)), 'call_address_invalid')
  return `0x${encoded.slice(24)}`
}

function header(value) {
  insist(value && typeof value === 'object', 'header_invalid')
  insist(
    typeof value.hash === 'string' &&
      HASH.test(value.hash) &&
      typeof value.parentHash === 'string' &&
      HASH.test(value.parentHash),
    'header_invalid',
  )
  const result = {
    number: quantity(value.number, 'header_invalid'),
    hash: value.hash.toLowerCase(),
    parentHash: value.parentHash.toLowerCase(),
    timestamp: quantity(value.timestamp, 'header_invalid'),
  }
  insist(result.timestamp > 0, 'header_invalid')
  return result
}

function hostname(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    fail('origin_invalid')
  }
  insist(
    parsed.protocol === 'https:' && parsed.hostname && !parsed.username && !parsed.password,
    'origin_invalid',
  )
  return parsed.hostname
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^www\./, '')
}

export function selectIndexedOrigins(urls, rpcIndexes) {
  insist(Array.isArray(urls) && urls.length >= 2 && urls.length <= 8, 'origins_invalid')
  insist(
    Array.isArray(rpcIndexes) &&
      rpcIndexes.length === 2 &&
      rpcIndexes.every(
        (index) => Number.isSafeInteger(index) && index >= 0 && index < urls.length,
      ) &&
      rpcIndexes[0] !== rpcIndexes[1],
    'rpc_indexes_invalid',
  )
  const selected = rpcIndexes.map((index) => urls[index])
  const hosts = selected.map(hostname)
  insist(hosts[0] !== hosts[1], 'same_rpc_host')
  insist(/(^|\.)alchemy\.com$/.test(hosts[0]), 'alchemy_origin_required')
  return selected
}

function makeRpc(fetchImpl, nowMs) {
  const started = nowMs()
  let calls = 0
  let bytes = 0
  const request = async (url, method, params) => {
    insist(++calls <= MAX_RPC_CALLS && nowMs() - started <= MAX_RUN_MS, 'budget_exhausted')
    const id = calls
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: AbortSignal.timeout(12_000),
    })
    insist(response?.ok === true, 'rpc_unavailable')
    const declared = Number(response.headers?.get?.('content-length') ?? 0)
    insist(Number.isFinite(declared) && declared <= MAX_RESPONSE_BYTES, 'response_oversize')
    let raw
    if (response.body?.getReader) {
      const reader = response.body.getReader()
      const chunks = []
      let length = 0
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          length += value.byteLength
          insist(
            length <= MAX_RESPONSE_BYTES && bytes + length <= MAX_TOTAL_RESPONSE_BYTES,
            'response_oversize',
          )
          chunks.push(value)
        }
      } finally {
        reader.releaseLock()
      }
      raw = Buffer.concat(chunks, length).toString('utf8')
    } else raw = await response.text() // Injected fake transports can omit a body stream.
    const length = Buffer.byteLength(raw)
    bytes += length
    insist(length <= MAX_RESPONSE_BYTES && bytes <= MAX_TOTAL_RESPONSE_BYTES, 'response_oversize')
    let envelope
    try {
      envelope = JSON.parse(raw)
    } catch {
      fail('rpc_json_invalid')
    }
    insist(
      envelope?.jsonrpc === '2.0' &&
        envelope.id === id &&
        Object.hasOwn(envelope, 'result') &&
        !Object.hasOwn(envelope, 'error'),
      'rpc_envelope_invalid',
    )
    return envelope.result
  }
  return { request, budget: () => ({ calls, responseBytes: bytes }) }
}

function normalizeTransfer(row, leg, startBlock, endBlock) {
  insist(
    row?.category === 'erc20' &&
      typeof row.hash === 'string' &&
      HASH.test(row.hash) &&
      typeof row.from === 'string' &&
      ADDRESS.test(row.from) &&
      typeof row.to === 'string' &&
      ADDRESS.test(row.to) &&
      typeof row.rawContract?.address === 'string' &&
      row.rawContract.address.toLowerCase() === ROUTE.usde &&
      typeof row.rawContract.value === 'string' &&
      QUANTITY.test(row.rawContract.value),
    'transfer_invalid',
  )
  const blockNumber = quantity(row.blockNum, 'transfer_invalid')
  const match = typeof row.uniqueId === 'string' ? UNIQUE_ID.exec(row.uniqueId) : null
  insist(
    blockNumber > startBlock &&
      blockNumber <= endBlock &&
      match &&
      match[1].toLowerCase() === row.hash.toLowerCase(),
    'transfer_identity_invalid',
  )
  const logIndex = Number(match[2])
  insist(Number.isSafeInteger(logIndex) && logIndex >= 0, 'transfer_identity_invalid')
  const from = row.from.toLowerCase()
  const to = row.to.toLowerCase()
  insist((leg === 'receipt' ? to : from) === ROUTE.silo, 'transfer_filter_mismatch')
  return {
    blockNumber,
    transactionHash: row.hash.toLowerCase(),
    logIndex,
    from,
    to,
    valueRaw: BigInt(row.rawContract.value).toString(),
  }
}

function transferKey(row) {
  return `${row.transactionHash}:${row.logIndex}`
}

async function scanLeg(request, alchemyUrl, leg, startBlock, endBlock) {
  const rows = []
  const seenKeys = new Set()
  const seenRows = new Set()
  let pageKey
  for (let page = 1; page <= MAX_PAGES_PER_LEG; page++) {
    const params = {
      fromBlock: hex(startBlock + 1),
      toBlock: hex(endBlock),
      contractAddresses: [ROUTE.usde],
      category: ['erc20'],
      excludeZeroValue: false,
      maxCount: hex(PAGE_SIZE),
      order: 'asc',
      withMetadata: false,
      ...(leg === 'receipt' ? { toAddress: ROUTE.silo } : { fromAddress: ROUTE.silo }),
      ...(pageKey ? { pageKey } : {}),
    }
    const response = await request(alchemyUrl, 'alchemy_getAssetTransfers', [params])
    insist(
      response &&
        typeof response === 'object' &&
        Array.isArray(response.transfers) &&
        response.transfers.length <= PAGE_SIZE,
      'page_invalid',
    )
    for (const item of response.transfers) {
      const row = normalizeTransfer(item, leg, startBlock, endBlock)
      const key = transferKey(row)
      insist(!seenRows.has(key), 'duplicate_transfer')
      seenRows.add(key)
      rows.push(row)
      insist(rows.length <= MAX_TRANSFER_ROWS, 'rows_oversize')
    }
    const next = response.pageKey
    if (next === undefined || next === null || next === '') return { rows, pages: page }
    insist(
      typeof next === 'string' &&
        next.length <= 1024 &&
        !seenKeys.has(next) &&
        response.transfers.length > 0,
      'page_key_invalid',
    )
    seenKeys.add(next)
    pageKey = next
  }
  fail('pagination_incomplete')
}

export async function scanIndexedSiloTransfers({
  urls,
  rpcIndexes,
  startBlock,
  endBlock,
  fetchImpl = fetch,
  nowMs = Date.now,
} = {}) {
  insist(
    Number.isSafeInteger(startBlock) &&
      startBlock >= 0 &&
      Number.isSafeInteger(endBlock) &&
      endBlock > startBlock &&
      endBlock - startBlock <= MAX_WINDOW_BLOCKS,
    'window_invalid',
  )
  const [alchemyUrl, witnessUrl] = selectIndexedOrigins(
    urls ?? configuredPublicRpcUrls(readEnv()),
    rpcIndexes,
  )
  const { request, budget } = makeRpc(fetchImpl, nowMs)
  const both = async (method, params) =>
    Promise.all([request(alchemyUrl, method, params), request(witnessUrl, method, params)])
  const agree = (left, right, reason) => {
    insist(JSON.stringify(left) === JSON.stringify(right), reason)
    return left
  }
  const commonHeader = async (blockNumber) => {
    const [left, right] = await both('eth_getBlockByNumber', [hex(blockNumber), false])
    const result = agree(header(left), header(right), 'header_divergence')
    insist(result.number === blockNumber, 'header_number_mismatch')
    return result
  }
  const pinned = async (to, data, blockHash) => {
    const [left, right] = await both('eth_call', [
      { to, data },
      { blockHash, requireCanonical: true },
    ])
    return agree(word(left), word(right), 'pinned_call_divergence')
  }

  const chains = await both('eth_chainId', [])
  insist(
    chains.every((chain) => quantity(chain, 'chain_invalid') === 1),
    'wrong_chain',
  )
  const finalized = (await both('eth_getBlockByNumber', ['finalized', false])).map(header)
  insist(
    finalized.every((head) => head.number >= endBlock),
    'end_not_finalized',
  )
  const start = await commonHeader(startBlock)
  const end = await commonHeader(endBlock)
  insist(start.timestamp < end.timestamp, 'header_time_invalid')
  for (const head of finalized)
    if (head.number === endBlock)
      insist(JSON.stringify(head) === JSON.stringify(end), 'finality_divergence')

  const balances = []
  for (const endpoint of [start, end]) {
    const asset = addressWord(await pinned(ROUTE.vault, CALL.asset, endpoint.hash))
    const silo = addressWord(await pinned(ROUTE.vault, CALL.silo, endpoint.hash))
    const vaultDecimals = BigInt(await pinned(ROUTE.vault, CALL.decimals, endpoint.hash))
    const usdeDecimals = BigInt(await pinned(ROUTE.usde, CALL.decimals, endpoint.hash))
    insist(
      asset === ROUTE.usde &&
        silo === ROUTE.silo &&
        vaultDecimals === BigInt(ROUTE.decimals) &&
        usdeDecimals === BigInt(ROUTE.decimals),
      'route_identity_mismatch',
    )
    balances.push(BigInt(await pinned(ROUTE.usde, CALL.balance, endpoint.hash)))
  }

  const receipts = await scanLeg(request, alchemyUrl, 'receipt', startBlock, endBlock)
  const sends = await scanLeg(request, alchemyUrl, 'send', startBlock, endBlock)
  insist(receipts.rows.length + sends.rows.length <= MAX_TRANSFER_ROWS, 'rows_oversize')
  const merged = new Map()
  for (const [leg, rows] of [
    ['receipt', receipts.rows],
    ['send', sends.rows],
  ]) {
    for (const row of rows) {
      const key = transferKey(row)
      const existing = merged.get(key)
      if (existing) {
        insist(
          existing.leg !== leg &&
            row.from === ROUTE.silo &&
            row.to === ROUTE.silo &&
            JSON.stringify(existing.row) === JSON.stringify(row),
          'transfer_duplicate_or_inconsistent',
        )
        existing.mirrored = true
      } else merged.set(key, { leg, row, mirrored: false })
    }
  }
  for (const { row, mirrored } of merged.values())
    if (row.from === ROUTE.silo && row.to === ROUTE.silo)
      insist(mirrored, 'self_transfer_filter_divergence')
  const inbound = receipts.rows.filter((row) => row.from !== ROUTE.silo)
  const outbound = sends.rows.filter((row) => row.to !== ROUTE.silo)
  const sum = (rows) => rows.reduce((total, row) => total + BigInt(row.valueRaw), 0n)
  const grossReceipts = sum(inbound)
  const grossSends = sum(outbound)
  const residual = balances[1] - balances[0] - (grossReceipts - grossSends)
  insist(residual === 0n, 'net_reconciliation_failed')

  agree(await commonHeader(startBlock), start, 'header_changed')
  agree(await commonHeader(endBlock), end, 'header_changed')
  const finalityRecheck = (await both('eth_getBlockByNumber', ['finalized', false])).map(header)
  insist(
    finalityRecheck.every(
      (head) =>
        head.number >= endBlock &&
        (head.number !== endBlock || JSON.stringify(head) === JSON.stringify(end)),
    ),
    'finality_changed',
  )
  const transfers = [...merged.values()]
    .map(({ row }) => row)
    .sort(
      (a, b) =>
        a.blockNumber - b.blockNumber ||
        a.logIndex - b.logIndex ||
        a.transactionHash.localeCompare(b.transactionHash),
    )
  return {
    study: 'susde_silo_alchemy_indexed_transfers_v1',
    status: 'endpoint_net_reconciled_indexed_only',
    observationMode: 'retrospective',
    provenance: 'alchemy_index_with_two_rpc_endpoint_match',
    rpcHosts: [hostname(alchemyUrl), hostname(witnessUrl)],
    providerIndependence: 'distinct_normalized_hostnames_only_operator_independence_unproven',
    grossCompleteness: 'unproven_indexed_only',
    chainId: 1,
    route: ROUTE,
    windowBlocks: endBlock - startBlock,
    start,
    end,
    balances: { startRaw: balances[0].toString(), endRaw: balances[1].toString() },
    gross: {
      receiptsRaw: grossReceipts.toString(),
      sendsRaw: grossSends.toString(),
      receiptCount: inbound.length,
      sendCount: outbound.length,
      excludedSelfTransferCount: [...merged.values()].filter(
        ({ row }) => row.from === ROUTE.silo && row.to === ROUTE.silo,
      ).length,
    },
    indexedPages: { receipts: receipts.pages, sends: sends.pages },
    transfers,
    transferUnionDigest: digestTransferUnion(transfers),
    transferDigestInterpretation: TRANSFER_DIGEST_INTERPRETATION,
    residualRaw: residual.toString(),
    holderClaims: 'not_measured',
    executableQ: 'not_measured',
    futureForecast: 'not_measured',
    rpcBudget: budget(),
  }
}

function cliOptions(argv) {
  insist(argv.includes('--run') && argv.length === 4, 'usage_invalid')
  const options = new Map()
  for (const arg of argv) {
    if (arg === '--run') continue
    const match = /^--(start-block|end-block|rpc-indexes)=(.+)$/.exec(arg)
    insist(match && !options.has(match[1]), 'usage_invalid')
    options.set(match[1], match[2])
  }
  const start = options.get('start-block')
  const end = options.get('end-block')
  const indexes = options.get('rpc-indexes')
  insist(
    /^\d+$/.test(start ?? '') && /^\d+$/.test(end ?? '') && /^\d+,\d+$/.test(indexes ?? ''),
    'usage_invalid',
  )
  return {
    startBlock: Number(start),
    endBlock: Number(end),
    rpcIndexes: indexes.split(',').map(Number),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  scanIndexedSiloTransfers(cliOptions(process.argv.slice(2)))
    .then((result) => console.log(JSON.stringify(result)))
    .catch(() => {
      // RPC errors can contain credential-bearing endpoint paths.
      console.error(JSON.stringify({ status: 'error', reason: 'susde_silo_indexed_failed_closed' }))
      process.exitCode = 1
    })
