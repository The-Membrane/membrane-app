// Foreground-only, resumable sUSDe cooldown-entry owner census. A Withdraw
// entry identifies a candidate owner, not an outstanding cooldown or payout.
import { createHash, randomUUID } from 'node:crypto'
import { statfsSync } from 'node:fs'
import { link, mkdir, open, readFile, rm, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { readEnv } from '../lib/venue-reads.mjs'
import { configuredPublicRpcUrls } from './carry-public-direct-exit-issue.mjs'

export const STUDY = 'susde_cooldown_owner_census_v1'
export const FIRST_CODE_BLOCK = 18_571_359
export const WINDOW_BLOCKS = 10_000
export const MAX_SEGMENT_BLOCKS = 100_000
const MAX_WINDOWS_PER_SEGMENT = 12
// Frozen from the separate two-host first-code attestation; a segment rechecks
// the creation header when it starts at this block, not the historical bytecode.
export const ROUTE = Object.freeze({
  vault: '0x9d39a5de30e57443bff2a8307a4256c8797a3497',
  silo: '0x7fc7c91d556b400afa565013e3f32055a0713425',
  firstCodeBlock: FIRST_CODE_BLOCK,
  firstCodeHash: '0x3a39f67ff2398918f6aebbdc2141ea5c00908eace10c8fcd06129d730e74f7c9',
  vaultCodeSha256: '4ef7631314ff56c84fc45b5bbff1d2ee56a6ce1746d9f494bad8939822ecb0e7',
})
export const WITHDRAW_TOPIC = '0xfbde797d201c681b91056529119e0b02407c7bb96a4a2c75c01fc9667232c8db'

const MAX_RPC_CALLS = 90
const MAX_RUN_MS = 8 * 60_000
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_TOTAL_RESPONSE_BYTES = 24 * 1024 * 1024
const MAX_LOGS_PER_RESPONSE = 4_096
const MAX_ARTIFACT_BYTES = 24 * 1024 * 1024
const MIN_DISK_FREE_BYTES = 1024 * 1024 * 1024
const HASH = /^0x[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const DECIMAL = /^(0|[1-9][0-9]*)$/
const QUANTITY = /^0x[0-9a-fA-F]+$/
const WORD = /^0x[0-9a-fA-F]{64}$/
const DATA = /^0x[0-9a-fA-F]{128}$/
const ROW_KEYS = [
  'blockNumber',
  'blockHash',
  'transactionHash',
  'transactionIndex',
  'logIndex',
  'sender',
  'receiver',
  'owner',
  'assetsRaw',
  'sharesRaw',
]
const HEADER_KEYS = ['number', 'hash', 'parentHash', 'timestamp']
const WINDOW_KEYS = ['fromBlock', 'toBlock', 'start', 'end', 'logCount', 'logSetSha256']
const BODY_KEYS = [
  'study',
  'version',
  'chainId',
  'route',
  'fromBlock',
  'toBlock',
  'windowBlocks',
  'originHosts',
  'originAgreement',
  'windows',
  'logs',
  'logSetSha256',
  'capturedAtUtc',
  'interpretation',
]

const fail = (reason) => {
  throw Error(`susde_owner_census_${reason}`)
}
const insist = (condition, reason) => {
  if (!condition) fail(reason)
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const sha = (value) => createHash('sha256').update(value).digest('hex')
const hex = (value) => `0x${value.toString(16)}`
const topic = (address) => `0x${address.slice(2).padStart(64, '0')}`
const FILTER_TOPICS = [WITHDRAW_TOPIC, null, topic(ROUTE.silo)]

function exactKeys(value, keys) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    same(Object.keys(value).sort(), [...keys].sort())
  )
}

function quantity(value, reason) {
  insist(typeof value === 'string' && QUANTITY.test(value), reason)
  const number = Number(BigInt(value))
  insist(Number.isSafeInteger(number) && number >= 0, reason)
  return number
}

function integer(value, reason) {
  insist(Number.isSafeInteger(value) && value >= 0, reason)
  return value
}

function header(value, expectedNumber) {
  insist(value && typeof value === 'object', 'header_invalid')
  const result = {
    number: quantity(value.number, 'header_invalid'),
    hash: String(value.hash ?? '').toLowerCase(),
    parentHash: String(value.parentHash ?? '').toLowerCase(),
    timestamp: quantity(value.timestamp, 'header_invalid'),
  }
  insist(
    result.number === expectedNumber &&
      HASH.test(result.hash) &&
      HASH.test(result.parentHash) &&
      result.timestamp > 0,
    'header_invalid',
  )
  return result
}

function validSavedHeader(value, expectedNumber) {
  insist(exactKeys(value, HEADER_KEYS), 'artifact_header_invalid')
  insist(
    integer(value.number, 'artifact_header_invalid') === expectedNumber &&
      HASH.test(value.hash) &&
      HASH.test(value.parentHash) &&
      integer(value.timestamp, 'artifact_header_invalid') > 0,
    'artifact_header_invalid',
  )
}

function addressTopic(value) {
  insist(typeof value === 'string' && WORD.test(value), 'log_topic_invalid')
  const lower = value.toLowerCase()
  insist(lower.slice(2, 26) === '0'.repeat(24), 'log_topic_invalid')
  return `0x${lower.slice(26)}`
}

function sortedRows(rows) {
  return [...rows].sort(
    (a, b) =>
      a.blockNumber - b.blockNumber ||
      a.transactionIndex - b.transactionIndex ||
      a.logIndex - b.logIndex ||
      a.transactionHash.localeCompare(b.transactionHash),
  )
}

function uniqueRows(rows) {
  insist(
    new Set(rows.map((row) => `${row.blockNumber}:${row.logIndex}`)).size === rows.length,
    'log_duplicate',
  )
}

export function logSetDigest(rows) {
  return sha(JSON.stringify({ schema: 'susde_cooldown_owner_log_set_v1', logs: rows }))
}

export function normalizeWithdrawLogs(raw, fromBlock, toBlock, start, end) {
  insist(Array.isArray(raw) && raw.length <= MAX_LOGS_PER_RESPONSE, 'logs_invalid')
  const rows = raw.map((log) => {
    insist(
      log &&
        log.address?.toLowerCase() === ROUTE.vault &&
        log.removed === false &&
        Array.isArray(log.topics) &&
        log.topics.length === 4 &&
        log.topics.every((entry) => typeof entry === 'string' && WORD.test(entry)) &&
        log.topics[0].toLowerCase() === WITHDRAW_TOPIC &&
        DATA.test(log.data ?? '') &&
        typeof log.blockHash === 'string' &&
        HASH.test(log.blockHash.toLowerCase()) &&
        typeof log.transactionHash === 'string' &&
        HASH.test(log.transactionHash.toLowerCase()),
      'log_invalid',
    )
    const blockNumber = quantity(log.blockNumber, 'log_invalid')
    const transactionIndex = quantity(log.transactionIndex, 'log_invalid')
    const logIndex = quantity(log.logIndex, 'log_invalid')
    const sender = addressTopic(log.topics[1])
    const receiver = addressTopic(log.topics[2])
    const owner = addressTopic(log.topics[3])
    insist(receiver === ROUTE.silo, 'receiver_filter_mismatch')
    insist(blockNumber >= fromBlock && blockNumber <= toBlock, 'log_outside_window')
    if (blockNumber === fromBlock)
      insist(log.blockHash.toLowerCase() === start.hash, 'log_boundary_hash_mismatch')
    if (blockNumber === toBlock)
      insist(log.blockHash.toLowerCase() === end.hash, 'log_boundary_hash_mismatch')
    return {
      blockNumber,
      blockHash: log.blockHash.toLowerCase(),
      transactionHash: log.transactionHash.toLowerCase(),
      transactionIndex,
      logIndex,
      sender,
      receiver,
      owner,
      assetsRaw: BigInt(`0x${log.data.slice(2, 66)}`).toString(),
      sharesRaw: BigInt(`0x${log.data.slice(66, 130)}`).toString(),
    }
  })
  uniqueRows(rows)
  return sortedRows(rows)
}

function host(url) {
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

export function selectCensusOrigins(urls) {
  insist(Array.isArray(urls) && urls.length >= 2 && urls.length <= 8, 'origins_invalid')
  const infura = urls.find((url) => /(^|\.)infura\.io$/.test(host(url)))
  const ankr = urls.find((url) => /(^|\.)ankr\.com$/.test(host(url)))
  insist(infura && ankr && host(infura) !== host(ankr), 'infura_ankr_required')
  return [infura, ankr]
}

function makeRpc(fetchImpl, nowMs) {
  const started = nowMs()
  let calls = 0
  let responseBytes = 0
  const request = async (url, method, params) => {
    insist(++calls <= MAX_RPC_CALLS && nowMs() - started < MAX_RUN_MS, 'budget_exhausted')
    const id = calls
    let response
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: AbortSignal.timeout(20_000),
      })
    } catch {
      fail('rpc_unavailable')
    }
    const cancelBody = async () => {
      try {
        await response?.body?.cancel?.()
      } catch {
        // The response has already failed; cancellation is best effort.
      }
    }
    if (response?.status === 429) {
      await cancelBody()
      fail('rpc_rate_limited')
    }
    if (response?.ok !== true) {
      await cancelBody()
      fail('rpc_unavailable')
    }
    const declared = Number(response.headers?.get?.('content-length') ?? 0)
    if (!Number.isFinite(declared) || declared < 0 || declared > MAX_RESPONSE_BYTES) {
      await cancelBody()
      fail('response_oversize')
    }
    if (typeof response.body?.getReader !== 'function') {
      await cancelBody()
      fail('response_stream_missing')
    }
    const reader = response.body.getReader()
    const chunks = []
    let length = 0
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        length += value.byteLength
        // Two origins are read concurrently. Reserve each chunk immediately so
        // both streams cannot spend the same remaining aggregate byte budget.
        responseBytes += value.byteLength
        insist(
          length <= MAX_RESPONSE_BYTES && responseBytes <= MAX_TOTAL_RESPONSE_BYTES,
          'response_oversize',
        )
        chunks.push(value)
      }
    } catch (error) {
      try {
        await reader.cancel()
      } catch {
        // Preserve the original fail-closed reason.
      }
      throw error
    } finally {
      reader.releaseLock()
    }
    let envelope
    try {
      envelope = JSON.parse(Buffer.concat(chunks, length).toString('utf8'))
    } catch {
      fail('rpc_json_invalid')
    }
    insist(
      envelope?.jsonrpc === '2.0' &&
        envelope.id === id &&
        Object.hasOwn(envelope, 'result') &&
        !Object.hasOwn(envelope, 'error'),
      'rpc_error',
    )
    return envelope.result
  }
  return { request, budget: () => ({ calls, responseBytes }) }
}

function validateRange(fromBlock, toBlock, windowBlocks = WINDOW_BLOCKS) {
  insist(Number.isSafeInteger(fromBlock) && fromBlock >= FIRST_CODE_BLOCK, 'range_invalid')
  insist(
    Number.isSafeInteger(toBlock) &&
      toBlock >= fromBlock &&
      toBlock - fromBlock + 1 <= MAX_SEGMENT_BLOCKS,
    'range_invalid',
  )
  insist(
    Number.isSafeInteger(windowBlocks) &&
      windowBlocks >= 1 &&
      windowBlocks <= WINDOW_BLOCKS &&
      Math.ceil((toBlock - fromBlock + 1) / windowBlocks) <= MAX_WINDOWS_PER_SEGMENT,
    'window_range_invalid',
  )
}

function validSavedRow(row, fromBlock, toBlock, start, end) {
  insist(exactKeys(row, ROW_KEYS), 'artifact_log_invalid')
  for (const field of ['blockNumber', 'transactionIndex', 'logIndex'])
    integer(row[field], 'artifact_log_invalid')
  insist(
    row.blockNumber >= fromBlock &&
      row.blockNumber <= toBlock &&
      HASH.test(row.blockHash) &&
      HASH.test(row.transactionHash) &&
      ADDRESS.test(row.sender) &&
      row.receiver === ROUTE.silo &&
      ADDRESS.test(row.owner) &&
      DECIMAL.test(row.assetsRaw) &&
      DECIMAL.test(row.sharesRaw),
    'artifact_log_invalid',
  )
  if (row.blockNumber === fromBlock)
    insist(row.blockHash === start.hash, 'artifact_log_boundary_hash_mismatch')
  if (row.blockNumber === toBlock)
    insist(row.blockHash === end.hash, 'artifact_log_boundary_hash_mismatch')
}

export function verifySusdeCooldownOwnerArtifact(artifact) {
  insist(exactKeys(artifact, [...BODY_KEYS, 'sha256']), 'artifact_shape_invalid')
  const { sha256, ...body } = artifact
  insist(
    /^[0-9a-f]{64}$/.test(sha256) && sha(JSON.stringify(body)) === sha256,
    'artifact_seal_invalid',
  )
  insist(
    body.study === STUDY &&
      body.version === 1 &&
      body.chainId === 1 &&
      same(body.route, ROUTE) &&
      Number.isSafeInteger(body.windowBlocks) &&
      body.windowBlocks >= 1 &&
      body.windowBlocks <= WINDOW_BLOCKS &&
      Array.isArray(body.originHosts) &&
      body.originHosts.length === 2 &&
      body.originHosts.every(
        (entry) =>
          typeof entry === 'string' && /^(?:[a-z0-9-]+\.)*(?:infura\.io|ankr\.com)$/.test(entry),
      ) &&
      /(^|\.)infura\.io$/.test(body.originHosts[0]) &&
      /(^|\.)ankr\.com$/.test(body.originHosts[1]) &&
      body.originAgreement === 'exact_normalized_log_rows_and_boundary_headers' &&
      body.interpretation ===
        'candidate_owners_only_not_outstanding_cooldowns_or_provider_independence',
    'artifact_identity_invalid',
  )
  validateRange(body.fromBlock, body.toBlock, body.windowBlocks)
  insist(
    Array.isArray(body.windows) &&
      Array.isArray(body.logs) &&
      body.logs.length <= MAX_LOGS_PER_RESPONSE * MAX_WINDOWS_PER_SEGMENT,
    'artifact_rows_invalid',
  )
  insist(
    typeof body.capturedAtUtc === 'string' &&
      new Date(body.capturedAtUtc).toISOString() === body.capturedAtUtc,
    'artifact_clock_invalid',
  )
  const expectedWindows = Math.ceil((body.toBlock - body.fromBlock + 1) / body.windowBlocks)
  insist(body.windows.length === expectedWindows, 'artifact_window_gap')
  let cursor = body.fromBlock
  let prior
  let rowOffset = 0
  for (const window of body.windows) {
    insist(exactKeys(window, WINDOW_KEYS), 'artifact_window_invalid')
    const end = Math.min(body.toBlock, cursor + body.windowBlocks - 1)
    insist(window.fromBlock === cursor && window.toBlock === end, 'artifact_window_gap')
    validSavedHeader(window.start, cursor)
    validSavedHeader(window.end, end)
    insist(window.start.timestamp <= window.end.timestamp, 'artifact_window_time_invalid')
    if (prior)
      insist(
        window.start.parentHash === prior.end.hash && window.start.timestamp >= prior.end.timestamp,
        'artifact_window_boundary_invalid',
      )
    let rowEnd = rowOffset
    while (rowEnd < body.logs.length && body.logs[rowEnd].blockNumber <= end) rowEnd++
    const rows = body.logs.slice(rowOffset, rowEnd)
    insist(
      rows.length <= MAX_LOGS_PER_RESPONSE &&
        window.logCount === rows.length &&
        window.logSetSha256 === logSetDigest(rows),
      'artifact_window_digest_invalid',
    )
    rows.forEach((row) => validSavedRow(row, cursor, end, window.start, window.end))
    rowOffset = rowEnd
    cursor = end + 1
    prior = window
  }
  insist(cursor === body.toBlock + 1 && rowOffset === body.logs.length, 'artifact_window_gap')
  uniqueRows(body.logs)
  insist(same(sortedRows(body.logs), body.logs), 'artifact_log_order_invalid')
  insist(body.logSetSha256 === logSetDigest(body.logs), 'artifact_digest_invalid')
  return artifact
}

export function ownersFromSusdeCooldownArtifact(artifact) {
  return [
    ...new Set(verifySusdeCooldownOwnerArtifact(artifact).logs.map((row) => row.owner)),
  ].sort()
}

export async function readSusdeCooldownOwnerArtifact(path) {
  const details = await stat(path)
  insist(details.isFile() && details.size <= MAX_ARTIFACT_BYTES, 'artifact_oversize')
  const bytes = await readFile(path)
  insist(bytes.length <= MAX_ARTIFACT_BYTES, 'artifact_oversize')
  let parsed
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch {
    fail('artifact_json_invalid')
  }
  return verifySusdeCooldownOwnerArtifact(parsed)
}

export async function collectSusdeCooldownOwnerSegment({
  fromBlock,
  toBlock,
  windowBlocks = WINDOW_BLOCKS,
  urls,
  fetchImpl = fetch,
  nowMs = Date.now,
  sleepImpl = (ms) => new Promise((done) => setTimeout(done, ms)),
} = {}) {
  validateRange(fromBlock, toBlock, windowBlocks)
  const origins = selectCensusOrigins(urls ?? configuredPublicRpcUrls(readEnv()))
  const { request, budget } = makeRpc(fetchImpl, nowMs)
  const both = async (method, params) => {
    const values = await Promise.all(origins.map((url) => request(url, method, params)))
    await sleepImpl(160)
    return values
  }
  const agreed = (left, right, reason) => {
    insist(same(left, right), reason)
    return left
  }
  const commonHeader = async (blockNumber) => {
    const [left, right] = await both('eth_getBlockByNumber', [hex(blockNumber), false])
    return agreed(header(left, blockNumber), header(right, blockNumber), 'header_divergence')
  }
  const chains = await both('eth_chainId', [])
  insist(
    chains.every((value) => quantity(value, 'chain_invalid') === 1),
    'wrong_chain',
  )
  const finalized = (await both('eth_getBlockByNumber', ['finalized', false])).map((value) =>
    header(value, quantity(value?.number, 'finalized_invalid')),
  )
  insist(
    finalized.every((value) => value.number >= toBlock),
    'range_not_finalized',
  )
  if (finalized[0].number === finalized[1].number)
    insist(finalized[0].hash === finalized[1].hash, 'finalized_head_divergence')

  const windows = []
  const logs = []
  let prior
  for (let first = fromBlock; first <= toBlock; first += windowBlocks) {
    const last = Math.min(toBlock, first + windowBlocks - 1)
    const start = await commonHeader(first)
    const end = await commonHeader(last)
    insist(start.timestamp <= end.timestamp, 'window_time_invalid')
    if (prior)
      insist(
        start.parentHash === prior.end.hash && start.timestamp >= prior.end.timestamp,
        'window_boundary_invalid',
      )
    if (first === FIRST_CODE_BLOCK)
      insist(start.hash === ROUTE.firstCodeHash, 'creation_header_changed')
    const filter = {
      address: ROUTE.vault,
      fromBlock: hex(first),
      toBlock: hex(last),
      topics: FILTER_TOPICS,
    }
    const [rawLeft, rawRight] = await both('eth_getLogs', [filter])
    const left = normalizeWithdrawLogs(rawLeft, first, last, start, end)
    const right = normalizeWithdrawLogs(rawRight, first, last, start, end)
    const rows = agreed(left, right, 'provider_log_divergence')
    logs.push(...rows)
    windows.push({
      fromBlock: first,
      toBlock: last,
      start,
      end,
      logCount: rows.length,
      logSetSha256: logSetDigest(rows),
    })
    prior = windows.at(-1)
  }
  uniqueRows(logs)
  const firstAgain = await commonHeader(fromBlock)
  const lastAgain = await commonHeader(toBlock)
  insist(
    same(firstAgain, windows[0].start) && same(lastAgain, windows.at(-1).end),
    'boundary_changed',
  )
  for (const head of finalized)
    if (head.number === toBlock)
      insist(head.hash === lastAgain.hash, 'finalized_boundary_divergence')
  const finalizedAgain = (await both('eth_getBlockByNumber', ['finalized', false])).map((value) =>
    header(value, quantity(value?.number, 'finalized_invalid')),
  )
  insist(
    finalizedAgain.every(
      (value) =>
        value.number >= toBlock && (value.number !== toBlock || value.hash === lastAgain.hash),
    ),
    'finality_changed',
  )
  for (let index = 0; index < finalizedAgain.length; index++)
    insist(
      finalizedAgain[index].number >= finalized[index].number &&
        (finalizedAgain[index].number !== finalized[index].number ||
          finalizedAgain[index].hash === finalized[index].hash),
      'finality_changed',
    )
  if (finalizedAgain[0].number === finalizedAgain[1].number)
    insist(finalizedAgain[0].hash === finalizedAgain[1].hash, 'finalized_head_divergence')
  const body = {
    study: STUDY,
    version: 1,
    chainId: 1,
    route: ROUTE,
    fromBlock,
    toBlock,
    windowBlocks,
    originHosts: origins.map(host),
    originAgreement: 'exact_normalized_log_rows_and_boundary_headers',
    windows,
    logs: sortedRows(logs),
    logSetSha256: logSetDigest(sortedRows(logs)),
    capturedAtUtc: new Date(nowMs()).toISOString(),
    interpretation: 'candidate_owners_only_not_outstanding_cooldowns_or_provider_independence',
  }
  const artifact = { ...body, sha256: sha(JSON.stringify(body)) }
  insist(Buffer.byteLength(JSON.stringify(artifact)) <= MAX_ARTIFACT_BYTES, 'artifact_oversize')
  verifySusdeCooldownOwnerArtifact(artifact)
  return { artifact, rpcBudget: budget() }
}

function diskFreeBytes(path) {
  let directory = dirname(path)
  while (true) {
    try {
      const disk = statfsSync(directory, { bigint: true })
      return Number(disk.bavail * disk.bsize)
    } catch (error) {
      insist(error?.code === 'ENOENT' && directory !== dirname(directory), 'disk_check_failed')
      directory = dirname(directory)
    }
  }
}

async function writeNewAtomic(path, artifact) {
  const output = resolve(path)
  const parent = dirname(output)
  const bytes = `${JSON.stringify(artifact, null, 2)}\n`
  insist(Buffer.byteLength(bytes) <= MAX_ARTIFACT_BYTES, 'artifact_oversize')
  await mkdir(parent, { recursive: true })
  const temporary = `${output}.${randomUUID()}.tmp`
  let handle
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = undefined
    await link(temporary, output) // no-clobber: a prior segment can never be overwritten
  } finally {
    await handle?.close()
    await rm(temporary, { force: true })
  }
  return output
}

export async function captureSusdeCooldownOwnerSegment({
  outPath,
  freeBytesImpl = diskFreeBytes,
  ...options
} = {}) {
  insist(typeof outPath === 'string' && outPath.endsWith('.json'), 'out_required')
  const output = resolve(outPath)
  const exists = await stat(output).then(
    () => true,
    (error) => {
      if (error?.code === 'ENOENT') return false
      throw error
    },
  )
  insist(!exists, 'out_exists')
  insist(freeBytesImpl(output) >= MIN_DISK_FREE_BYTES, 'disk_floor')
  const result = await collectSusdeCooldownOwnerSegment(options)
  insist(freeBytesImpl(output) >= MIN_DISK_FREE_BYTES, 'disk_floor')
  await writeNewAtomic(output, result.artifact)
  return { ...result, outPath: output, nextFromBlock: result.artifact.toBlock + 1 }
}

export function cliOptions(argv) {
  const mode = argv[0]
  insist(mode === '--capture' || mode === '--verify', 'usage_invalid')
  const args = new Map()
  for (const value of argv.slice(1)) {
    const parsed = /^--([a-z-]+)=(.+)$/.exec(value)
    insist(parsed && !args.has(parsed[1]), 'usage_invalid')
    args.set(parsed[1], parsed[2])
  }
  if (mode === '--verify') {
    insist(args.size === 1 && args.has('source'), 'usage_invalid')
    return { mode, source: args.get('source') }
  }
  insist(
    args.has('from') &&
      args.has('out') &&
      [...args.keys()].every((key) =>
        ['from', 'to', 'blocks', 'window-blocks', 'out'].includes(key),
      ) &&
      !(args.has('to') && args.has('blocks')),
    'usage_invalid',
  )
  const fromBlock = Number(args.get('from'))
  const blocks = args.has('blocks') ? Number(args.get('blocks')) : MAX_SEGMENT_BLOCKS
  const toBlock = args.has('to') ? Number(args.get('to')) : fromBlock + blocks - 1
  const windowBlocks = args.has('window-blocks') ? Number(args.get('window-blocks')) : WINDOW_BLOCKS
  validateRange(fromBlock, toBlock, windowBlocks)
  return { mode, fromBlock, toBlock, windowBlocks, outPath: args.get('out') }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = cliOptions(process.argv.slice(2))
    if (options.mode === '--verify') {
      const artifact = await readSusdeCooldownOwnerArtifact(options.source)
      console.log(
        JSON.stringify({
          status: 'verified_offline',
          study: STUDY,
          fromBlock: artifact.fromBlock,
          toBlock: artifact.toBlock,
          ownerCount: ownersFromSusdeCooldownArtifact(artifact).length,
          logCount: artifact.logs.length,
          sha256: artifact.sha256,
        }),
      )
    } else {
      const result = await captureSusdeCooldownOwnerSegment(options)
      console.log(
        JSON.stringify({
          status: 'captured',
          outPath: result.outPath,
          fromBlock: result.artifact.fromBlock,
          toBlock: result.artifact.toBlock,
          nextFromBlock: result.nextFromBlock,
          ownerCount: ownersFromSusdeCooldownArtifact(result.artifact).length,
          logCount: result.artifact.logs.length,
          sha256: result.artifact.sha256,
          rpcBudget: result.rpcBudget,
        }),
      )
    }
  } catch {
    // Never print arbitrary provider errors: messages may contain credential-bearing URLs.
    console.error(JSON.stringify({ status: 'error', reason: 'susde_owner_census_failed_closed' }))
    process.exitCode = 1
  }
}
