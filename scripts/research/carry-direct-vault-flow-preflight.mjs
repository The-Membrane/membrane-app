// Read-only, bounded ERC-4626 Deposit/Withdraw topic viability check.
// One quiet range does not prove that a vault never emits these events.
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

import { decodeEventLog, encodeFunctionData, parseAbi, parseAbiItem, toEventSelector } from 'viem'

import { readEnv } from '../lib/venue-reads.mjs'
import { configuredPublicRpcUrls } from './carry-public-direct-exit-issue.mjs'

export const FROZEN_ROUTES = Object.freeze([
  // components/Carry/fixtures.ts + lib/carry/trackedDirectVaultExit.ts
  {
    routeKey: 'USDS → StUsds [USDS]',
    vault: '0x99cd4ec3f88a45940936f469e4bb72a2a701eeb9',
    asset: '0xdc035d45d973e3ec169d2276ddab16f1e407384f',
  },
  // components/Carry/fixtures.ts + lib/carry/sghoExit.ts + exact-leg-spread.mjs
  {
    routeKey: 'GHO → sGho [GHO]',
    vault: '0xe1753f2e00940cc31213dd92013cf019dfe4ca1d',
    asset: '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f',
  },
  // components/Carry/fixtures.ts + lib/carry/usd3ExitQuote.ts
  {
    routeKey: 'USDC → USD3 [USDC]',
    vault: '0x056b269eb1f75477a8666ae8c7fe01b64dd55ecc',
    asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    implementation: '0xd1f1c3f485063712873285bf4ef25ab068f13893',
  },
])
const DEPOSIT_EVENT = parseAbiItem(
  'event Deposit(address indexed sender,address indexed owner,uint256 assets,uint256 shares)',
)
const WITHDRAW_EVENT = parseAbiItem(
  'event Withdraw(address indexed sender,address indexed receiver,address indexed owner,uint256 assets,uint256 shares)',
)
export const TOPICS = Object.freeze({
  deposit: toEventSelector(DEPOSIT_EVENT),
  withdraw: toEventSelector(WITHDRAW_EVENT),
})
export const MAX_RANGE_BLOCKS = 8
export const MAX_CANDIDATE_BLOCKS = 1800
export const MAX_RPC_CALLS = 44
export const MAX_RESPONSE_BYTES = 256 * 1024
export const MAX_TOTAL_RESPONSE_BYTES = 2 * 1024 * 1024
export const MAX_RUN_MS = 90_000
const HASH = /^0x[0-9a-fA-F]{64}$/
const HEX = /^0x(?:[0-9a-fA-F]{2})*$/
const QUANTITY = /^0x[0-9a-fA-F]+$/
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const ASSET_DATA = encodeFunctionData({
  abi: parseAbi(['function asset() view returns (address)']),
  functionName: 'asset',
})
const sha = (value) => createHash('sha256').update(value).digest('hex')
const hexNumber = (n) => `0x${n.toString(16)}`

export function selectOrigins(urls) {
  const hosts = new Set()
  const selected = []
  for (const url of urls) {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') throw Error('direct_flow_origin_invalid')
    if (hosts.has(parsed.hostname)) continue
    hosts.add(parsed.hostname)
    selected.push({ url, host: parsed.hostname })
    if (selected.length === 2) break
  }
  if (selected.length !== 2) throw Error('direct_flow_two_origins_required')
  return selected
}

export function selectCandidateOrigins(urls) {
  if (!Array.isArray(urls) || urls.length < 1 || urls.length > 2)
    throw Error('direct_flow_candidate_origins_invalid')
  const seen = new Set()
  return urls.map((url) => {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || seen.has(parsed.hostname))
      throw Error('direct_flow_candidate_origins_invalid')
    seen.add(parsed.hostname)
    return { url, host: parsed.hostname }
  })
}

export function makeRpc(fetchImpl, nowMs = Date.now) {
  const start = nowMs()
  let calls = 0
  let totalBytes = 0
  const rpc = async (origin, method, params) => {
    if (++calls > MAX_RPC_CALLS || nowMs() - start > MAX_RUN_MS)
      throw Error('direct_flow_budget_exhausted')
    const request = { jsonrpc: '2.0', id: calls, method, params }
    const response = await fetchImpl(origin.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(12_000),
    })
    if (!response.ok) throw Error(`direct_flow_http_${response.status}_${origin.host}_${method}`)
    const declared = Number(response.headers?.get?.('content-length') ?? 0)
    if (declared > MAX_RESPONSE_BYTES) throw Error('direct_flow_response_oversize')
    let raw
    if (response.body?.getReader) {
      const reader = response.body.getReader()
      const chunks = []
      let size = 0
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > MAX_RESPONSE_BYTES || totalBytes + size > MAX_TOTAL_RESPONSE_BYTES)
            throw Error('direct_flow_response_oversize')
          chunks.push(value)
        }
      } finally {
        reader.releaseLock()
      }
      raw = Buffer.concat(chunks, size).toString('utf8')
    } else raw = await response.text()
    const bytes = Buffer.byteLength(raw)
    totalBytes += bytes
    if (bytes > MAX_RESPONSE_BYTES || totalBytes > MAX_TOTAL_RESPONSE_BYTES)
      throw Error('direct_flow_response_oversize')
    let body
    try {
      body = JSON.parse(raw)
    } catch {
      throw Error('direct_flow_json_invalid')
    }
    if (
      body?.jsonrpc !== '2.0' ||
      body?.id !== calls ||
      (body.result === undefined && body.error === undefined)
    )
      throw Error('direct_flow_envelope_invalid')
    return { origin: origin.host, request, response: body, responseBytes: bytes }
  }
  return { rpc, budget: () => ({ calls, responseBytes: totalBytes, elapsedMs: nowMs() - start }) }
}

export function requireResult(receipt) {
  if (receipt.response.error) throw Error('direct_flow_rpc_error')
  return receipt.response.result
}

export function header(receipt) {
  const value = requireResult(receipt)
  if (
    !value ||
    !QUANTITY.test(value.number ?? '') ||
    !HASH.test(value.hash ?? '') ||
    !HASH.test(value.parentHash ?? '') ||
    !QUANTITY.test(value.timestamp ?? '')
  )
    throw Error('direct_flow_header_invalid')
  const number = Number(BigInt(value.number))
  const timestamp = Number(BigInt(value.timestamp))
  if (!Number.isSafeInteger(number) || !Number.isSafeInteger(timestamp))
    throw Error('direct_flow_header_invalid')
  return {
    number,
    hash: value.hash.toLowerCase(),
    parentHash: value.parentHash.toLowerCase(),
    timestamp,
  }
}

function addressResult(receipt) {
  const value = requireResult(receipt)
  if (
    typeof value !== 'string' ||
    !/^0x[0-9a-fA-F]{64}$/.test(value) ||
    !/^0{24}$/i.test(value.slice(2, 26))
  )
    throw Error('direct_flow_asset_result_invalid')
  return `0x${value.slice(-40).toLowerCase()}`
}

function runtime(receipt) {
  const value = requireResult(receipt)
  if (typeof value !== 'string' || !HEX.test(value) || value === '0x')
    throw Error('direct_flow_runtime_missing')
  return { bytes: (value.length - 2) / 2, sha256: sha(Buffer.from(value.slice(2), 'hex')) }
}

export function normalizeLogs(receipt, vault, from, to, headers) {
  const rows = requireResult(receipt)
  if (
    !Array.isArray(rows) ||
    rows.length > 1024 ||
    !Array.isArray(headers) ||
    headers.length !== to - from + 1
  )
    throw Error('direct_flow_logs_invalid')
  const normalized = rows.map((log) => {
    if (
      log?.address?.toLowerCase() !== vault ||
      !QUANTITY.test(log.blockNumber ?? '') ||
      !HASH.test(log.blockHash ?? '') ||
      !HASH.test(log.transactionHash ?? '') ||
      !QUANTITY.test(log.logIndex ?? '') ||
      !/^0x[0-9a-fA-F]{128}$/.test(log.data ?? '') ||
      !Array.isArray(log.topics) ||
      ![TOPICS.deposit, TOPICS.withdraw].includes(log.topics[0]?.toLowerCase()) ||
      log.topics.length !== (log.topics[0]?.toLowerCase() === TOPICS.deposit ? 3 : 4) ||
      log.topics.some((topic) => !HASH.test(topic)) ||
      log.topics.slice(1).some((topic) => !/^0x0{24}[0-9a-fA-F]{40}$/.test(topic)) ||
      log.removed === true
    )
      throw Error('direct_flow_logs_invalid')
    const block = Number(BigInt(log.blockNumber))
    const logIndex = Number(BigInt(log.logIndex))
    if (
      !Number.isSafeInteger(block) ||
      !Number.isSafeInteger(logIndex) ||
      block < from ||
      block > to
    )
      throw Error('direct_flow_log_outside_range')
    if (log.blockHash.toLowerCase() !== headers[block - from]?.hash)
      throw Error('direct_flow_log_block_mismatch')
    let decoded
    try {
      decoded = decodeEventLog({
        abi: [DEPOSIT_EVENT, WITHDRAW_EVENT],
        data: log.data,
        topics: log.topics,
        strict: true,
      })
    } catch {
      throw Error('direct_flow_event_decode_invalid')
    }
    const addresses =
      decoded.eventName === 'Deposit'
        ? [decoded.args.sender, decoded.args.owner]
        : decoded.eventName === 'Withdraw'
          ? [decoded.args.sender, decoded.args.receiver, decoded.args.owner]
          : null
    if (
      !addresses ||
      addresses.some((address) => !/^0x[0-9a-fA-F]{40}$/.test(address)) ||
      typeof decoded.args.assets !== 'bigint' ||
      decoded.args.assets < 0n ||
      typeof decoded.args.shares !== 'bigint' ||
      decoded.args.shares < 0n
    )
      throw Error('direct_flow_event_decode_invalid')
    return {
      blockNumber: block,
      blockHash: log.blockHash.toLowerCase(),
      transactionHash: log.transactionHash.toLowerCase(),
      logIndex,
      address: log.address.toLowerCase(),
      topics: log.topics.map((topic) => topic.toLowerCase()),
      data: log.data.toLowerCase(),
      eventName: decoded.eventName,
      sender: decoded.args.sender.toLowerCase(),
      owner: decoded.args.owner.toLowerCase(),
      receiver: decoded.eventName === 'Withdraw' ? decoded.args.receiver.toLowerCase() : null,
      assetsRaw: decoded.args.assets.toString(),
      sharesRaw: decoded.args.shares.toString(),
    }
  })
  normalized.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)
  if (
    new Set(normalized.map((row) => `${row.blockHash}:${row.transactionHash}:${row.logIndex}`))
      .size !== normalized.length
  )
    throw Error('direct_flow_duplicate_log')
  return normalized
}

export function compareOrigins(first, second) {
  if (JSON.stringify(first) !== JSON.stringify(second))
    throw Error('direct_flow_origin_disagreement')
  return first
}

function normalizeCandidateLogs(receipt, fromBlock, toBlock) {
  const rows = requireResult(receipt)
  if (!Array.isArray(rows) || rows.length > 1024) throw Error('direct_flow_candidates_invalid')
  const addresses = new Set(FROZEN_ROUTES.map((route) => route.vault))
  const normalized = rows.map((log) => {
    if (
      !addresses.has(log?.address?.toLowerCase()) ||
      !QUANTITY.test(log.blockNumber ?? '') ||
      !HASH.test(log.blockHash ?? '') ||
      !HASH.test(log.transactionHash ?? '') ||
      !QUANTITY.test(log.logIndex ?? '') ||
      !Array.isArray(log.topics) ||
      ![TOPICS.deposit, TOPICS.withdraw].includes(log.topics[0]?.toLowerCase()) ||
      log.topics.some((topic) => !HASH.test(topic)) ||
      !HEX.test(log.data ?? '') ||
      log.removed === true
    )
      throw Error('direct_flow_candidates_invalid')
    const blockNumber = Number(BigInt(log.blockNumber))
    const logIndex = Number(BigInt(log.logIndex))
    if (
      !Number.isSafeInteger(blockNumber) ||
      !Number.isSafeInteger(logIndex) ||
      blockNumber < fromBlock ||
      blockNumber > toBlock
    )
      throw Error('direct_flow_candidate_outside_range')
    return {
      address: log.address.toLowerCase(),
      blockNumber,
      blockHash: log.blockHash.toLowerCase(),
      transactionHash: log.transactionHash.toLowerCase(),
      logIndex,
      topics: log.topics.map((topic) => topic.toLowerCase()),
      data: log.data.toLowerCase(),
    }
  })
  normalized.sort(
    (a, b) =>
      a.blockNumber - b.blockNumber ||
      a.logIndex - b.logIndex ||
      a.transactionHash.localeCompare(b.transactionHash),
  )
  if (
    new Set(normalized.map((row) => `${row.blockHash}:${row.transactionHash}:${row.logIndex}`))
      .size !== normalized.length
  )
    throw Error('direct_flow_candidate_duplicate')
  return normalized
}

/** Discovery only. Exact block/header/runtime/event proof belongs to preflight({toBlock}). */
export async function findHistoricalCandidates({
  urls,
  fromBlock,
  toBlock,
  fetchImpl = fetch,
  nowMs = Date.now,
} = {}) {
  if (
    !Number.isSafeInteger(fromBlock) ||
    !Number.isSafeInteger(toBlock) ||
    fromBlock < 0 ||
    toBlock < fromBlock ||
    toBlock - fromBlock + 1 > MAX_CANDIDATE_BLOCKS
  )
    throw Error('direct_flow_candidate_range_invalid')
  const origins = selectCandidateOrigins(urls ?? configuredPublicRpcUrls(readEnv()).slice(0, 2))
  const { rpc, budget } = makeRpc(fetchImpl, nowMs)
  const filter = {
    address: FROZEN_ROUTES.map((route) => route.vault),
    fromBlock: hexNumber(fromBlock),
    toBlock: hexNumber(toBlock),
    topics: [[TOPICS.deposit, TOPICS.withdraw]],
  }
  const receipts = []
  const normalized = []
  for (const origin of origins) {
    const receipt = await rpc(origin, 'eth_getLogs', [filter])
    receipts.push(receipt)
    normalized.push(normalizeCandidateLogs(receipt, fromBlock, toBlock))
  }
  if (normalized.length === 2) compareOrigins(normalized[0], normalized[1])
  const routes = FROZEN_ROUTES.map((route) => {
    const rows = normalized[0].filter((row) => row.address === route.vault)
    return {
      routeKey: route.routeKey,
      vault: route.vault,
      status: rows.length ? 'unverified_candidate' : 'no_candidate_in_sampled_range',
      candidateBlocks: [...new Set(rows.map((row) => row.blockNumber))],
      logCount: rows.length,
    }
  })
  return {
    schema: 'carry_direct_vault_historical_candidate_v1',
    range: { fromBlock, toBlock },
    topics: TOPICS,
    routes,
    receipts,
    sourceAgreement:
      normalized.length === 2 ? 'two_hostname_agreed_unverified' : 'single_hostname_unverified',
    normalizedLogSha256: sha(JSON.stringify(normalized[0])),
    limits: {
      maxBlocks: MAX_CANDIDATE_BLOCKS,
      maxRpcCalls: origins.length,
      maxResponseBytes: MAX_RESPONSE_BYTES,
      maxTotalResponseBytes: MAX_TOTAL_RESPONSE_BYTES,
      maxRunMs: MAX_RUN_MS,
      actual: budget(),
    },
    limitation:
      'Hostname-distinct RPC log candidates are not canonical block proof, strict event proof, complete history, or holder payouts.',
  }
}

export function verifyHeaderChain(headers, from, to) {
  if (!Array.isArray(headers) || headers.length !== to - from + 1)
    throw Error('direct_flow_header_chain_invalid')
  for (let i = 0; i < headers.length; i++) {
    if (headers[i]?.number !== from + i || (i > 0 && headers[i].parentHash !== headers[i - 1].hash))
      throw Error('direct_flow_header_chain_invalid')
  }
  return headers
}

export async function preflight({ fetchImpl = fetch, nowMs = Date.now, urls, toBlock } = {}) {
  if (toBlock !== undefined && (!Number.isSafeInteger(toBlock) || toBlock < MAX_RANGE_BLOCKS - 1))
    throw Error('direct_flow_target_invalid')
  const origins = selectOrigins(urls ?? configuredPublicRpcUrls(readEnv()))
  const { rpc, budget } = makeRpc(fetchImpl, nowMs)
  const receipts = []
  const get = async (origin, method, params) => {
    const receipt = await rpc(origin, method, params)
    receipts.push(receipt)
    return receipt
  }
  for (const origin of origins) {
    const chain = requireResult(await get(origin, 'eth_chainId', []))
    if (!QUANTITY.test(chain ?? '') || BigInt(chain) !== 1n) throw Error('direct_flow_wrong_chain')
  }
  const heads = []
  for (const origin of origins)
    heads.push(header(await get(origin, 'eth_getBlockByNumber', ['finalized', false])))
  const finalizedLimit = Math.min(...heads.map((head) => head.number))
  if (toBlock !== undefined && toBlock > finalizedLimit)
    throw Error('direct_flow_target_not_finalized')
  const to = toBlock ?? finalizedLimit
  if (!Number.isSafeInteger(to) || to < MAX_RANGE_BLOCKS) throw Error('direct_flow_head_invalid')
  const from = to - MAX_RANGE_BLOCKS + 1
  const headerChains = []
  for (const origin of origins) {
    const chain = []
    for (let number = from; number <= to; number++)
      chain.push(header(await get(origin, 'eth_getBlockByNumber', [hexNumber(number), false])))
    verifyHeaderChain(chain, from, to)
    if (chain.at(-1).number > heads[origins.indexOf(origin)].number)
      throw Error('direct_flow_endpoint_invalid')
    headerChains.push(chain)
  }
  compareOrigins(headerChains[0], headerChains[1])
  const commonHeaders = headerChains[0]
  const pin = { blockHash: commonHeaders.at(-1).hash, requireCanonical: true }
  const routes = []
  for (const route of FROZEN_ROUTES) {
    const witnesses = []
    for (const origin of origins) {
      const code = runtime(await get(origin, 'eth_getCode', [route.vault, pin]))
      const observedAsset = addressResult(
        await get(origin, 'eth_call', [{ to: route.vault, data: ASSET_DATA }, pin]),
      )
      if (observedAsset !== route.asset) throw Error('direct_flow_asset_identity_mismatch')
      let implementation = null
      if (route.implementation) {
        implementation = addressResult(
          await get(origin, 'eth_getStorageAt', [route.vault, IMPL_SLOT, pin]),
        )
        if (implementation !== route.implementation)
          throw Error('direct_flow_implementation_mismatch')
      }
      const logRows = normalizeLogs(
        await get(origin, 'eth_getLogs', [
          {
            address: route.vault,
            fromBlock: hexNumber(from),
            toBlock: hexNumber(to),
            topics: [[TOPICS.deposit, TOPICS.withdraw]],
          },
        ]),
        route.vault,
        from,
        to,
        commonHeaders,
      )
      witnesses.push({
        origin: origin.host,
        runtime: code,
        asset: observedAsset,
        implementation,
        logs: logRows.map((log) => ({
          ...log,
          identityAtPinnedBlock: log.blockNumber === to ? 'verified' : 'unverified_earlier_block',
        })),
      })
    }
    compareOrigins({ ...witnesses[0], origin: null }, { ...witnesses[1], origin: null })
    const pinnedLogs = witnesses[0].logs.filter((log) => log.blockNumber === to)
    const earlierLogs = witnesses[0].logs.length - pinnedLogs.length
    routes.push({
      routeKey: route.routeKey,
      vault: route.vault,
      asset: route.asset,
      status: pinnedLogs.length
        ? 'standard_events_observed'
        : earlierLogs
          ? 'earlier_events_unverified_identity'
          : 'no_events_in_sampled_range',
      depositCount: pinnedLogs.filter((log) => log.topics[0] === TOPICS.deposit).length,
      withdrawCount: pinnedLogs.filter((log) => log.topics[0] === TOPICS.withdraw).length,
      earlierUnverifiedEventCount: earlierLogs,
      witnesses,
    })
  }
  return {
    schema: 'carry_direct_vault_flow_preflight_v1',
    observedAtUtc: new Date(nowMs()).toISOString(),
    scope: 'three_frozen_direct_vault_routes',
    range: { from, to, fromHash: commonHeaders[0].hash, toHash: commonHeaders.at(-1).hash },
    topics: TOPICS,
    finalizedHeads: heads.map((head, i) => ({ origin: origins[i].host, ...head })),
    headerChains: headerChains.map((chain, i) => ({ origin: origins[i].host, headers: chain })),
    routes,
    limits: {
      maxRangeBlocks: MAX_RANGE_BLOCKS,
      maxRpcCalls: MAX_RPC_CALLS,
      maxResponseBytes: MAX_RESPONSE_BYTES,
      maxTotalResponseBytes: MAX_TOTAL_RESPONSE_BYTES,
      maxRunMs: MAX_RUN_MS,
      actual: budget(),
    },
    receipts,
    limitation:
      'Event identity is verified only at the pinned runtime/asset block; earlier decoded logs are context. Two hostname-distinct RPC responses do not prove provider-organization independence, complete history, holder control, or mined exit payout.',
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) throw Error('usage: node carry-direct-vault-flow-preflight.mjs')
  preflight()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${String(error?.message ?? error)}\n`)
      process.exitCode = 1
    })
}
