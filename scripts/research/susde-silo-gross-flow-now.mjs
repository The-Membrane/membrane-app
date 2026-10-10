// Read-only, bounded USDe Transfer flow at the exact sUSDe cooldown silo.
// Address-level receipts and sends are neither holder claims nor a forecast.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { encodeFunctionData, parseAbi, parseAbiItem, toEventSelector } from 'viem'

import { readEnv } from '../lib/venue-reads.mjs'
import { configuredPublicRpcUrls } from './carry-public-direct-exit-issue.mjs'
import {
  TRANSFER_DIGEST_INTERPRETATION,
  digestTransferUnion,
} from './susde-silo-transfer-digest.mjs'

export const ROUTE = Object.freeze({
  vault: '0x9d39a5de30e57443bff2a8307a4256c8797a3497',
  usde: '0x4c9edd5852cd905f086c759e8383e09bff1e68b3',
  silo: '0x7fc7c91d556b400afa565013e3f32055a0713425',
  decimals: 18,
})
export const MAX_RANGE_BLOCKS = 256
export const DEFAULT_RANGE_BLOCKS = 64
// The configured Alchemy free-tier origin returned a 10-block eth_getLogs limit.
export const LOG_CHUNK_BLOCKS = 10
const MAX_RPC_CALLS = 144
const MAX_RESPONSE_BYTES = 256 * 1024
const MAX_TOTAL_RESPONSE_BYTES = 4 * 1024 * 1024
const MAX_LOGS_PER_RESPONSE = 256
const MAX_RUN_MS = 120_000
const MAX_CURRENT_FINALIZED_AGE_MS = 45 * 60_000
const MAX_FUTURE_CLOCK_SKEW_MS = 2 * 60_000
const HASH = /^0x[0-9a-fA-F]{64}$/
const WORD = /^0x[0-9a-fA-F]{64}$/
const QUANTITY = /^0x[0-9a-fA-F]+$/
const ZERO_PREFIX = /^0{24}$/
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
  balance: encodeFunctionData({
    abi: ABI,
    functionName: 'balanceOf',
    args: [ROUTE.silo],
  }),
})
const TRANSFER_TOPIC = toEventSelector(
  parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 value)'),
)
const SILO_TOPIC = `0x${'0'.repeat(24)}${ROUTE.silo.slice(2)}`
const hex = (n) => `0x${n.toString(16)}`
const fail = (reason) => {
  throw Error(`susde_silo_${reason}`)
}
const insist = (condition, reason) => {
  if (!condition) fail(reason)
}

function number(value, reason) {
  insist(typeof value === 'string' && QUANTITY.test(value), reason)
  const parsed = Number(BigInt(value))
  insist(Number.isSafeInteger(parsed) && parsed >= 0, reason)
  return parsed
}

function word(value) {
  insist(typeof value === 'string' && WORD.test(value), 'call_word_invalid')
  return value.toLowerCase()
}

function address(value) {
  const encoded = word(value).slice(2)
  insist(ZERO_PREFIX.test(encoded.slice(0, 24)), 'call_address_invalid')
  return `0x${encoded.slice(24)}`
}

function addressTopic(value) {
  insist(typeof value === 'string' && HASH.test(value), 'log_topic_invalid')
  const encoded = value.toLowerCase().slice(2)
  insist(ZERO_PREFIX.test(encoded.slice(0, 24)), 'log_topic_invalid')
  return `0x${encoded.slice(24)}`
}

function header(value) {
  insist(value && typeof value === 'object', 'header_invalid')
  const result = {
    number: number(value.number, 'header_invalid'),
    hash: String(value.hash ?? '').toLowerCase(),
    parentHash: String(value.parentHash ?? '').toLowerCase(),
    timestamp: number(value.timestamp, 'header_invalid'),
  }
  insist(
    HASH.test(result.hash) && HASH.test(result.parentHash) && result.timestamp > 0,
    'header_invalid',
  )
  return result
}

function normalizedHost(url) {
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
  const host = parsed.hostname
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^www\./, '')
  return /^(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/.test(host) ? 'loopback' : host
}

export function selectOriginPair(urls) {
  insist(Array.isArray(urls) && urls.length >= 2 && urls.length <= 8, 'two_origins_required')
  const selected = []
  const hosts = new Set()
  for (const url of urls) {
    const host = normalizedHost(url)
    if (hosts.has(host)) continue
    hosts.add(host)
    selected.push(url)
    if (selected.length === 2) break
  }
  insist(selected.length === 2, 'two_origins_required')
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
    } else {
      // Only used by injected fake transports; native fetch provides a stream.
      raw = await response.text()
    }
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

function normalizeLogs(raw, leg, first, last, endHeader) {
  insist(Array.isArray(raw) && raw.length <= MAX_LOGS_PER_RESPONSE, 'logs_invalid')
  const rows = raw.map((log) => {
    insist(
      log &&
        typeof log.address === 'string' &&
        log.address.toLowerCase() === ROUTE.usde &&
        log.removed === false &&
        Array.isArray(log.topics) &&
        log.topics.length === 3 &&
        log.topics.every((topic) => typeof topic === 'string' && HASH.test(topic)) &&
        log.topics[0].toLowerCase() === TRANSFER_TOPIC &&
        typeof log.data === 'string' &&
        WORD.test(log.data) &&
        typeof log.blockHash === 'string' &&
        HASH.test(log.blockHash) &&
        typeof log.transactionHash === 'string' &&
        HASH.test(log.transactionHash),
      'log_invalid',
    )
    const blockNumber = number(log.blockNumber, 'log_invalid')
    const transactionIndex = number(log.transactionIndex, 'log_invalid')
    const logIndex = number(log.logIndex, 'log_invalid')
    insist(
      blockNumber >= first &&
        blockNumber <= last &&
        (blockNumber !== endHeader.number || log.blockHash.toLowerCase() === endHeader.hash),
      'log_inconsistent',
    )
    const from = addressTopic(log.topics[1])
    const to = addressTopic(log.topics[2])
    insist((leg === 'receipt' ? to : from) === ROUTE.silo, 'log_filter_mismatch')
    return {
      blockNumber,
      blockHash: log.blockHash.toLowerCase(),
      transactionHash: log.transactionHash.toLowerCase(),
      transactionIndex,
      logIndex,
      from,
      to,
      valueRaw: BigInt(log.data).toString(),
    }
  })
  rows.sort(
    (a, b) =>
      a.blockNumber - b.blockNumber ||
      a.logIndex - b.logIndex ||
      a.transactionHash.localeCompare(b.transactionHash),
  )
  insist(
    new Set(rows.map((row) => `${row.blockNumber}:${row.logIndex}`)).size === rows.length,
    'log_duplicate',
  )
  return rows
}

export async function probeSiloGrossFlow({
  urls,
  rangeBlocks = DEFAULT_RANGE_BLOCKS,
  endBlock,
  fetchImpl = fetch,
  nowMs = Date.now,
} = {}) {
  insist(
    Number.isSafeInteger(rangeBlocks) && rangeBlocks >= 1 && rangeBlocks <= MAX_RANGE_BLOCKS,
    'range_invalid',
  )
  insist(
    endBlock === undefined || (Number.isSafeInteger(endBlock) && endBlock >= rangeBlocks),
    'end_block_invalid',
  )
  const pair = selectOriginPair(urls ?? configuredPublicRpcUrls(readEnv()))
  const { request, budget } = makeRpc(fetchImpl, nowMs)
  const both = async (method, params) =>
    Promise.all(pair.map((url) => request(url, method, params)))
  const agreed = (left, right, reason) => {
    insist(JSON.stringify(left) === JSON.stringify(right), reason)
    return left
  }
  const commonHeader = async (blockNumber) => {
    const [left, right] = await both('eth_getBlockByNumber', [hex(blockNumber), false])
    const result = agreed(header(left), header(right), 'provider_header_divergence')
    insist(result.number === blockNumber, 'header_number_mismatch')
    return result
  }
  const pinned = async (to, data, blockHash) => {
    const [left, right] = await both('eth_call', [
      { to, data },
      { blockHash, requireCanonical: true },
    ])
    return agreed(word(left), word(right), 'provider_call_divergence')
  }

  const chains = await both('eth_chainId', [])
  insist(
    chains.every((value) => number(value, 'chain_invalid') === 1),
    'wrong_chain',
  )
  const finalized = (await both('eth_getBlockByNumber', ['finalized', false])).map(header)
  const latestCommon = Math.min(...finalized.map((head) => head.number))
  const B = endBlock ?? latestCommon
  insist(B >= rangeBlocks && finalized.every((head) => head.number >= B), 'end_not_finalized')
  const A = B - rangeBlocks
  const start = await commonHeader(A)
  const end = await commonHeader(B)
  insist(start.timestamp < end.timestamp, 'header_time_invalid')
  const finalizedAgeMs = nowMs() - end.timestamp * 1000
  if (endBlock === undefined)
    insist(
      finalizedAgeMs >= -MAX_FUTURE_CLOCK_SKEW_MS && finalizedAgeMs <= MAX_CURRENT_FINALIZED_AGE_MS,
      'current_head_stale',
    )
  for (const head of finalized) {
    if (head.number === B) insist(head.hash === end.hash, 'finalized_header_divergence')
  }

  const startAsset = await pinned(ROUTE.vault, CALL.asset, start.hash)
  const startSilo = await pinned(ROUTE.vault, CALL.silo, start.hash)
  const asset = await pinned(ROUTE.vault, CALL.asset, end.hash)
  const silo = await pinned(ROUTE.vault, CALL.silo, end.hash)
  const vaultDecimals = await pinned(ROUTE.vault, CALL.decimals, end.hash)
  const usdeDecimals = await pinned(ROUTE.usde, CALL.decimals, end.hash)
  insist(
    address(startAsset) === ROUTE.usde &&
      address(startSilo) === ROUTE.silo &&
      address(asset) === ROUTE.usde &&
      address(silo) === ROUTE.silo &&
      BigInt(vaultDecimals) === BigInt(ROUTE.decimals) &&
      BigInt(usdeDecimals) === BigInt(ROUTE.decimals),
    'route_identity_mismatch',
  )
  const startBalance = BigInt(await pinned(ROUTE.usde, CALL.balance, start.hash))
  const endBalance = BigInt(await pinned(ROUTE.usde, CALL.balance, end.hash))

  const receiptLogs = []
  const sendLogs = []
  for (let first = A + 1; first <= B; first += LOG_CHUNK_BLOCKS) {
    const last = Math.min(B, first + LOG_CHUNK_BLOCKS - 1)
    for (const [leg, topics, target] of [
      ['receipt', [TRANSFER_TOPIC, null, SILO_TOPIC], receiptLogs],
      ['send', [TRANSFER_TOPIC, SILO_TOPIC], sendLogs],
    ]) {
      const raw = await both('eth_getLogs', [
        { address: ROUTE.usde, fromBlock: hex(first), toBlock: hex(last), topics },
      ])
      const left = normalizeLogs(raw[0], leg, first, last, end)
      const right = normalizeLogs(raw[1], leg, first, last, end)
      target.push(...agreed(left, right, 'provider_log_divergence'))
    }
  }

  const seen = new Map()
  for (const [leg, rows] of [
    ['receipt', receiptLogs],
    ['send', sendLogs],
  ]) {
    for (const row of rows) {
      const key = `${row.blockNumber}:${row.logIndex}`
      const prior = seen.get(key)
      if (prior) {
        insist(
          prior.leg !== leg &&
            row.from === ROUTE.silo &&
            row.to === ROUTE.silo &&
            JSON.stringify(prior.row) === JSON.stringify(row),
          'log_duplicate_or_inconsistent',
        )
        prior.mirrored = true
      } else seen.set(key, { leg, row, mirrored: false })
    }
  }
  for (const { row, mirrored } of seen.values())
    if (row.from === ROUTE.silo && row.to === ROUTE.silo)
      insist(mirrored, 'self_transfer_filter_divergence')

  const receipts = receiptLogs.filter((row) => row.from !== ROUTE.silo)
  const sends = sendLogs.filter((row) => row.to !== ROUTE.silo)
  const sum = (rows) => rows.reduce((total, row) => total + BigInt(row.valueRaw), 0n)
  const grossReceipts = sum(receipts)
  const grossSends = sum(sends)
  const residual = endBalance - startBalance - (grossReceipts - grossSends)
  insist(residual === 0n, 'balance_reconciliation_failed')

  agreed(await commonHeader(A), start, 'header_changed')
  agreed(await commonHeader(B), end, 'header_changed')
  const finalityRecheck = (await both('eth_getBlockByNumber', ['finalized', false])).map(header)
  insist(
    finalityRecheck.every(
      (head) => head.number >= B && (head.number !== B || head.hash === end.hash),
    ),
    'finality_changed',
  )
  return {
    study: 'susde_direct_usde_silo_gross_flow_now_v1',
    status: 'reconciled',
    observationMode: endBlock === undefined ? 'current_finalized' : 'retrospective',
    provenance: 'two_rpc_host_match',
    rpcHosts: pair.map(normalizedHost),
    providerIndependence: 'distinct_normalized_hostnames_only_operator_independence_unproven',
    chainId: 1,
    route: ROUTE,
    rangeBlocks,
    currentFinalizedAgeSeconds: endBlock === undefined ? Math.round(finalizedAgeMs / 1000) : null,
    start,
    end,
    balances: { startRaw: startBalance.toString(), endRaw: endBalance.toString() },
    gross: {
      receiptsRaw: grossReceipts.toString(),
      sendsRaw: grossSends.toString(),
      receiptCount: receipts.length,
      sendCount: sends.length,
      excludedSelfTransferCount: [...seen.values()].filter(
        ({ row }) => row.from === ROUTE.silo && row.to === ROUTE.silo,
      ).length,
    },
    residualRaw: residual.toString(),
    transferUnionDigest: digestTransferUnion([...seen.values()].map(({ row }) => row)),
    transferDigestInterpretation: TRANSFER_DIGEST_INTERPRETATION,
    grossCompleteness: 'two_rpc_log_sets_agree_net_reconciled_not_independently_complete',
    routeIdentity: 'start_and_end_only',
    holderClaims: 'not_measured',
    executableQ: 'not_measured',
    futureForecast: 'not_measured',
    rpcBudget: budget(),
  }
}

export function cliOptions(argv, configuredUrls) {
  insist(argv.includes('--run') && argv.length <= 4, 'usage_invalid')
  let rangeBlocks = DEFAULT_RANGE_BLOCKS
  let endBlock
  let urls
  const seen = new Set()
  for (const arg of argv) {
    if (arg === '--run') continue
    const indexes = /^--rpc-indexes=(\d+),(\d+)$/.exec(arg)
    if (indexes) {
      insist(!seen.has('rpc-indexes'), 'usage_invalid')
      seen.add('rpc-indexes')
      const all = configuredUrls ?? configuredPublicRpcUrls(readEnv())
      const left = Number(indexes[1])
      const right = Number(indexes[2])
      insist(
        Number.isSafeInteger(left) &&
          Number.isSafeInteger(right) &&
          left !== right &&
          left < all.length &&
          right < all.length,
        'rpc_index_invalid',
      )
      urls = selectOriginPair([all[left], all[right]])
      continue
    }
    const match = /^--(blocks|end-block)=(\d+)$/.exec(arg)
    insist(match && !seen.has(match[1]), 'usage_invalid')
    seen.add(match[1])
    const value = Number(match[2])
    insist(Number.isSafeInteger(value), 'usage_invalid')
    if (match[1] === 'blocks') rangeBlocks = value
    else endBlock = value
  }
  return { rangeBlocks, endBlock, urls }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  probeSiloGrossFlow(cliOptions(process.argv.slice(2)))
    .then((result) => console.log(JSON.stringify(result)))
    .catch(() => {
      // Never echo provider errors: vendors may include credential-bearing URLs.
      console.error(JSON.stringify({ status: 'error', reason: 'susde_silo_probe_failed_closed' }))
      process.exitCode = 1
    })
