// Retrospective USDe variable-debt mint-like event index from its exact initialization.
// Zero-origin Transfer recipients are historical candidates, not new borrows,
// current borrowers, route-attributed TVL, or advance-warning observations.
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statfsSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeEventLog, encodeEventTopics, parseAbiItem } from 'viem'

import { ROOT, makeClient, readEnv } from '../lib/venue-reads.mjs'

export const TOKEN = '0x015396e1f286289ae23a762088e863b3ec465145'
export const USDE = '0x4c9edd5852cd905f086c759e8383e09bff1e68b3'
export const CONFIGURATOR = '0x64b761d848206f447fe2dd461b0c635ec39ebb27'
export const INITIALIZATION_TX =
  '0x28c87433042e89d839832a84f2bf62bd1fef1328d26070706e7966b62ec269f5'
export const START_BLOCK = 20_033_499
export const START_HASH = '0x2645d8377cffdfef7774fa5fd8127bbbe837cd0f163dbaf2865ad026749c17df'
export const CHUNK_BLOCKS = 5_000
// A single catch-up invocation remains bounded. Dense log ranges may hit the
// RPC cap first; already-sealed segments are still a deterministic frontier.
export const MAX_CHUNKS = 32
export const MAX_PACE_MS = 5_000
export const MAX_RPC_CALLS = 2_048
export const MAX_PREFLIGHT_CALLS = 128
export const MAX_LOGS_PER_RESPONSE = 250
export const MAX_RESPONSE_BYTES = 2_000_000
export const MAX_SEGMENT_BYTES = 4_000_000
export const MIN_FREE_BYTES = 1_073_741_824
export const DEFAULT_OUT = join(ROOT, 'data/research/venue-signals/usde-debt-mint-baseline')

const HEX32 = /^0x[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const ZERO_TOPIC = `0x${'0'.repeat(64)}`
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`
const TRANSFER = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
)
// Aave V3 ConfiguratorLogic.executeInitReserve emits this from PoolConfigurator.
const RESERVE_INITIALIZED = parseAbiItem(
  'event ReserveInitialized(address indexed asset, address indexed aToken, address stableDebtToken, address variableDebtToken, address interestRateStrategyAddress)',
)
const TRANSFER_TOPIC = encodeEventTopics({
  abi: [TRANSFER],
  eventName: 'Transfer',
})[0].toLowerCase()
const INITIALIZATION_TOPICS = encodeEventTopics({
  abi: [RESERVE_INITIALIZED],
  eventName: 'ReserveInitialized',
  args: { asset: USDE },
})
  .slice(0, 2)
  .map((topic) => topic.toLowerCase())
const hex = (value) => `0x${BigInt(value).toString(16)}`
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const fail = (code) => {
  throw new Error(`usde_debt_mint_${code}`)
}

function uint(value) {
  try {
    const number = Number(BigInt(value))
    if (Number.isSafeInteger(number) && number >= 0) return number
  } catch {
    /* Invalid RPC integer. */
  }
  fail('integer_invalid')
}

export function config() {
  return {
    schemaVersion: 4,
    chainId: 1,
    token: TOKEN,
    underlying: USDE,
    startBlock: START_BLOCK,
    startHash: START_HASH,
    configurator: CONFIGURATOR,
    initializationTx: INITIALIZATION_TX,
    initializationTopics: INITIALIZATION_TOPICS,
    topic0: TRANSFER_TOPIC,
    topic1: ZERO_TOPIC,
    chunkBlocks: CHUNK_BLOCKS,
    claim: 'retrospective_mint_like_recipients_only_not_borrower_census_or_route_tvl',
  }
}

export function normalizeInitialization(raw) {
  const address = String(raw?.address).toLowerCase()
  const blockNumber = uint(raw?.blockNumber)
  const logIndex = uint(raw?.logIndex)
  const blockHash = String(raw?.blockHash).toLowerCase()
  const transactionHash = String(raw?.transactionHash).toLowerCase()
  const topics = raw?.topics?.map((value) => String(value).toLowerCase())
  const data = String(raw?.data).toLowerCase()
  if (
    raw?.removed === true ||
    address !== CONFIGURATOR ||
    blockNumber !== START_BLOCK ||
    blockHash !== START_HASH ||
    transactionHash !== INITIALIZATION_TX ||
    !Array.isArray(topics) ||
    topics.length !== 3 ||
    topics[0] !== INITIALIZATION_TOPICS[0] ||
    topics[1] !== INITIALIZATION_TOPICS[1] ||
    topics.some((word) => !HEX32.test(word)) ||
    !/^0x[0-9a-f]{192}$/.test(data)
  )
    fail('initialization_identity_mismatch')
  let decoded
  try {
    decoded = decodeEventLog({ abi: [RESERVE_INITIALIZED], topics, data })
  } catch {
    fail('initialization_decode_failed')
  }
  const asset = String(decoded.args.asset).toLowerCase()
  const variableDebtToken = String(decoded.args.variableDebtToken).toLowerCase()
  if (asset !== USDE || variableDebtToken !== TOKEN) fail('initialization_reserve_mismatch')
  return {
    address,
    blockNumber,
    blockHash,
    transactionHash,
    logIndex,
    topics,
    data,
    asset,
    variableDebtToken,
  }
}

export function assertDiskFloor(out, stat = statfsSync, expectedBytes = 0) {
  let path = existsSync(out) ? out : dirname(out)
  while (!existsSync(path) && dirname(path) !== path) path = dirname(path)
  const space = stat(path)
  if (Number(space.bavail) * Number(space.bsize) - expectedBytes < MIN_FREE_BYTES)
    fail('disk_reserve_reached')
}

function header(raw, expected) {
  if (
    !raw ||
    !HEX32.test(String(raw.hash).toLowerCase()) ||
    !HEX32.test(String(raw.parentHash).toLowerCase())
  )
    fail('block_header_invalid')
  const number = uint(raw.number)
  if (expected !== undefined && number !== expected) fail('block_number_mismatch')
  return {
    number,
    hash: raw.hash.toLowerCase(),
    parentHash: raw.parentHash.toLowerCase(),
    timestamp: uint(raw.timestamp),
  }
}

export function normalizeLog(raw, from, to) {
  const address = String(raw?.address).toLowerCase()
  const blockNumber = uint(raw?.blockNumber)
  const logIndex = uint(raw?.logIndex)
  const blockHash = String(raw?.blockHash).toLowerCase()
  const transactionHash = String(raw?.transactionHash).toLowerCase()
  const topics = raw?.topics?.map((value) => String(value).toLowerCase())
  const data = String(raw?.data).toLowerCase()
  if (
    raw?.removed === true ||
    address !== TOKEN ||
    blockNumber < from ||
    blockNumber > to ||
    !HEX32.test(blockHash) ||
    !HEX32.test(transactionHash) ||
    !Array.isArray(topics) ||
    topics.length !== 3 ||
    topics[0] !== TRANSFER_TOPIC ||
    topics[1] !== ZERO_TOPIC ||
    topics.some((word) => !HEX32.test(word)) ||
    !/^0x[0-9a-f]{64}$/.test(data)
  )
    fail('log_identity_mismatch')
  let decoded
  try {
    decoded = decodeEventLog({ abi: [TRANSFER], topics, data })
  } catch {
    fail('log_decode_failed')
  }
  const owner = String(decoded.args.to).toLowerCase()
  if (
    String(decoded.args.from).toLowerCase() !== ZERO_ADDRESS ||
    !ADDRESS.test(owner) ||
    owner === ZERO_ADDRESS
  )
    fail('owner_invalid')
  return {
    address,
    blockNumber,
    blockHash,
    transactionHash,
    logIndex,
    topics,
    data,
    owner,
    valueRaw: decoded.args.value.toString(),
  }
}

export function candidateOwners(logs) {
  return [
    ...new Set(logs.filter((log) => BigInt(log.valueRaw) > 0n).map((log) => log.owner)),
  ].sort()
}

function query(from, to) {
  return [
    {
      fromBlock: hex(from),
      toBlock: hex(to),
      address: TOKEN,
      topics: [TRANSFER_TOPIC, ZERO_TOPIC],
    },
  ]
}

function initializationQuery() {
  return [
    {
      fromBlock: hex(START_BLOCK),
      toBlock: hex(START_BLOCK),
      address: CONFIGURATOR,
      topics: INITIALIZATION_TOPICS,
    },
  ]
}

function rpcErrorText(error) {
  return [
    error?.shortMessage,
    error?.message,
    error?.details,
    error?.cause?.shortMessage,
    error?.cause?.message,
    error?.cause?.details,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

function rateLimited(error) {
  return (
    error?.status === 429 ||
    error?.statusCode === 429 ||
    error?.cause?.status === 429 ||
    /\b(?:http\s*)?429\b|too many requests|rate[ _-]?limit|quota|requests? per second|credits? exhausted/.test(
      rpcErrorText(error),
    )
  )
}

function splittable(error) {
  if (rateLimited(error)) return false
  return /result[ _-]?limit|response[ _-]?size|response is too large|block range|range[ _-]?limit|query returned more than|too many (?:logs|results)|more than \d+ (?:logs|results)|exceeds?.*(?:logs|results)/.test(
    rpcErrorText(error),
  )
}

export function classifyRpcFailure(error, method = 'eth_getLogs') {
  if (rateLimited(error)) return 'rate_limit'
  if (method === 'eth_getLogs' && splittable(error)) return 'range_limit'
  return 'failed'
}

function segmentName(segment, bytes) {
  return `${String(segment.fromBlock).padStart(12, '0')}-${String(segment.toBlock).padStart(12, '0')}-${sha256(bytes)}.json`
}

export function appendSegment(out, segment, stat = statfsSync) {
  const bytes = Buffer.from(JSON.stringify(segment))
  if (bytes.length > MAX_SEGMENT_BYTES) fail('segment_size_cap')
  mkdirSync(out, { recursive: true })
  assertDiskFloor(out, stat, bytes.length)
  const target = join(out, segmentName(segment, bytes))
  const temporary = `${target}.${randomUUID()}.tmp`
  let fd
  try {
    fd = openSync(temporary, 'wx', 0o600)
    let offset = 0
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset)
      if (written <= 0) fail('segment_write_failed')
      offset += written
    }
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    linkSync(temporary, target) // Atomic exclusive promotion; never replace a seal.
  } finally {
    if (fd !== null && fd !== undefined) closeSync(fd)
    if (existsSync(temporary)) unlinkSync(temporary)
  }
  return target
}

export function verify({ out = DEFAULT_OUT } = {}) {
  const names = existsSync(out) ? readdirSync(out).sort() : []
  if (names.some((name) => !/^\d{12}-\d{12}-[a-f0-9]{64}\.json$/.test(name)))
    fail('unrecognized_artifact')
  let throughBlock = START_BLOCK - 1,
    frontierHash = null,
    logCount = 0,
    legacyUnprobedSegmentCount = 0
  for (const name of names) {
    const bytes = readFileSync(join(out, name))
    let segment
    try {
      segment = JSON.parse(bytes)
    } catch {
      fail('segment_json_invalid')
    }
    // The first eight-block pilot is an immutable v2 seal. It had no
    // capability probe; verify it exactly, without claiming a supported range.
    const schemaVersion = segment.config?.schemaVersion
    if (![2, 3, 4].includes(schemaVersion)) fail('segment_invalid')
    const legacyUnprobed = schemaVersion === 2
    const expectedConfig = {
      ...config(),
      schemaVersion,
      chunkBlocks: schemaVersion < 4 ? 1_000 : CHUNK_BLOCKS,
    }
    const segmentChunkBlocks = expectedConfig.chunkBlocks
    if (
      segmentName(segment, bytes) !== name ||
      JSON.stringify(segment.config) !== JSON.stringify(expectedConfig) ||
      segment.fromBlock !== throughBlock + 1 ||
      !Number.isSafeInteger(segment.toBlock) ||
      segment.toBlock < segment.fromBlock ||
      (legacyUnprobed
        ? segment.rangeBlocks !== undefined ||
          segment.anchorProbePassedBlocksByReader !== undefined ||
          segment.toBlock - segment.fromBlock >= segmentChunkBlocks
        : !Number.isInteger(segment.rangeBlocks) ||
          segment.rangeBlocks < 1 ||
          segment.rangeBlocks > segmentChunkBlocks ||
          segment.toBlock - segment.fromBlock >= segment.rangeBlocks ||
          (segment.anchorProbePassedBlocksByReader !== null &&
            (!Array.isArray(segment.anchorProbePassedBlocksByReader) ||
              segment.anchorProbePassedBlocksByReader.length !==
                (segment.coverage === 'single_host' ? 1 : 2) ||
              segment.anchorProbePassedBlocksByReader.some(
                (count) =>
                  !Number.isInteger(count) ||
                  count < segment.rangeBlocks ||
                  count > segmentChunkBlocks,
              )))) ||
      segment.fromHeader?.number !== segment.fromBlock ||
      segment.toHeader?.number !== segment.toBlock ||
      !HEX32.test(segment.fromHeader?.hash) ||
      !HEX32.test(segment.toHeader?.hash) ||
      (segment.fromBlock === START_BLOCK && segment.fromHeader.hash !== START_HASH) ||
      (frontierHash && segment.fromHeader.parentHash !== frontierHash) ||
      !Number.isSafeInteger(segment.finalizedHead) ||
      segment.finalizedHead < segment.toBlock ||
      !HEX32.test(segment.finalizedHeadHash) ||
      !Number.isFinite(Date.parse(segment.firstObservedAt)) ||
      segment.retrospectiveLagSeconds !==
        Math.floor(Date.parse(segment.firstObservedAt) / 1000) - segment.toHeader.timestamp ||
      segment.retrospectiveLagSeconds < 0 ||
      !segment.reserveInitialization ||
      !Array.isArray(segment.logs) ||
      !Array.isArray(segment.logBlockHeaders) ||
      !['single_host', 'two_rpc_readers_exact_agreement_not_provider_independence'].includes(
        segment.coverage,
      ) ||
      !Number.isSafeInteger(segment.rawLogCount) ||
      segment.rawLogCount !== segment.logs.length ||
      !Array.isArray(segment.candidateOwners)
    )
      fail('segment_invalid')
    const initialization = normalizeInitialization(segment.reserveInitialization)
    if (JSON.stringify(initialization) !== JSON.stringify(segment.reserveInitialization))
      fail('initialization_seal_invalid')
    const witness = segment.peerWitness
    if (
      !witness ||
      ![1, 2].includes(witness.hostCount) ||
      witness.hostCount !== (segment.coverage === 'single_host' ? 1 : 2) ||
      typeof witness.distinctHostnames !== 'boolean' ||
      (witness.hostCount === 1 && witness.distinctHostnames) ||
      witness.fromHash !== segment.fromHeader.hash ||
      witness.toHash !== segment.toHeader.hash ||
      witness.finalizedHead !== segment.finalizedHead ||
      witness.finalizedHeadHash !== segment.finalizedHeadHash ||
      !Number.isFinite(Date.parse(witness.confirmedAt)) ||
      witness.rawLogCount !== segment.rawLogCount ||
      (witness.hostCount === 2 &&
        witness.initializationSha256 !== sha256(JSON.stringify(initialization))) ||
      (witness.hostCount === 1 && witness.initializationSha256 !== null) ||
      (witness.hostCount === 2 &&
        witness.normalizedLogsSha256 !== sha256(JSON.stringify(segment.logs))) ||
      (witness.hostCount === 1 && witness.normalizedLogsSha256 !== null)
    )
      fail('peer_witness_invalid')
    const headers = new Map()
    for (const saved of segment.logBlockHeaders) {
      if (
        !Number.isSafeInteger(saved.number) ||
        saved.number < segment.fromBlock ||
        saved.number > segment.toBlock ||
        !HEX32.test(saved.hash) ||
        !HEX32.test(saved.parentHash) ||
        !Number.isSafeInteger(saved.timestamp) ||
        headers.has(saved.number)
      )
        fail('log_header_invalid')
      headers.set(saved.number, saved)
    }
    if (
      headers.get(segment.fromBlock)?.hash !== segment.fromHeader.hash ||
      headers.get(segment.toBlock)?.hash !== segment.toHeader.hash
    )
      fail('boundary_header_invalid')
    const seen = new Set()
    for (const entry of segment.logs) {
      const normalized = normalizeLog(entry, segment.fromBlock, segment.toBlock)
      if (JSON.stringify(normalized) !== JSON.stringify(entry)) fail('log_invalid')
      const id = `${entry.transactionHash}:${entry.logIndex}`
      if (seen.has(id)) fail('duplicate_log')
      seen.add(id)
      if (headers.get(entry.blockNumber)?.hash !== entry.blockHash) fail('noncanonical_log')
    }
    if (JSON.stringify(candidateOwners(segment.logs)) !== JSON.stringify(segment.candidateOwners))
      fail('candidate_mismatch')
    throughBlock = segment.toBlock
    frontierHash = segment.toHeader.hash
    logCount += segment.rawLogCount
    if (legacyUnprobed) legacyUnprobedSegmentCount++
  }
  return {
    fromBlock: START_BLOCK,
    throughBlock,
    frontierHash,
    segmentCount: names.length,
    logCount,
    legacyUnprobedSegmentCount,
  }
}

export async function collect({
  rpcRead,
  peerRpcRead = null,
  peerDistinctHostnames = false,
  out = DEFAULT_OUT,
  maxChunks = 1,
  paceMs = 0,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  rangeBlocks = CHUNK_BLOCKS,
  anchorProbePassedBlocksByReader = null,
  initialRpcCalls = 0,
  throughBlock = null,
  now = () => new Date(),
  stat = statfsSync,
}) {
  if (!Number.isInteger(maxChunks) || maxChunks < 1 || maxChunks > MAX_CHUNKS)
    fail('invalid_max_chunks')
  if (!Number.isInteger(paceMs) || paceMs < 0 || paceMs > MAX_PACE_MS) fail('invalid_pace_ms')
  if (!Number.isInteger(rangeBlocks) || rangeBlocks < 1 || rangeBlocks > CHUNK_BLOCKS)
    fail('invalid_range_blocks')
  if (throughBlock !== null && (!Number.isSafeInteger(throughBlock) || throughBlock < START_BLOCK))
    fail('invalid_through_block')
  if (
    anchorProbePassedBlocksByReader !== null &&
    (!Array.isArray(anchorProbePassedBlocksByReader) ||
      anchorProbePassedBlocksByReader.length !== (peerRpcRead ? 2 : 1) ||
      anchorProbePassedBlocksByReader.some(
        (count) => !Number.isInteger(count) || count < rangeBlocks || count > CHUNK_BLOCKS,
      ))
  )
    fail('invalid_probe_ranges')
  if (typeof peerDistinctHostnames !== 'boolean' || (peerDistinctHostnames && !peerRpcRead))
    fail('peer_identity_invalid')
  if (
    !Number.isSafeInteger(initialRpcCalls) ||
    initialRpcCalls < 0 ||
    initialRpcCalls > MAX_RPC_CALLS
  )
    fail('rpc_call_cap')
  let calls = initialRpcCalls
  const guarded = (reader) => async (method, params) => {
    assertDiskFloor(out, stat)
    if (++calls > MAX_RPC_CALLS) fail('rpc_call_cap')
    return reader(method, params)
  }
  const rpc = guarded(rpcRead)
  const peer = peerRpcRead ? guarded(peerRpcRead) : null
  if (uint(await rpc('eth_chainId', [])) !== 1) fail('wrong_chain')
  if (peer && uint(await peer('eth_chainId', [])) !== 1) fail('peer_wrong_chain')
  const anchor = header(await rpc('eth_getBlockByNumber', [hex(START_BLOCK), false]), START_BLOCK)
  if (anchor.hash !== START_HASH) fail('anchor_hash_mismatch')
  const previous = header(
    await rpc('eth_getBlockByNumber', [hex(START_BLOCK - 1), false]),
    START_BLOCK - 1,
  )
  if (anchor.parentHash !== previous.hash) fail('anchor_parent_mismatch')
  const [beforeCode, anchorCode] = await Promise.all([
    rpc('eth_getCode', [TOKEN, hex(START_BLOCK - 1)]),
    rpc('eth_getCode', [TOKEN, hex(START_BLOCK)]),
  ])
  if (
    !/^0x0?$/i.test(String(beforeCode)) ||
    !/^0x[0-9a-f]+$/i.test(String(anchorCode)) ||
    /^0x0+$/i.test(String(anchorCode))
  )
    fail('anchor_code_mismatch')
  if (peer) {
    const peerAnchor = header(
      await peer('eth_getBlockByNumber', [hex(START_BLOCK), false]),
      START_BLOCK,
    )
    const peerPrevious = header(
      await peer('eth_getBlockByNumber', [hex(START_BLOCK - 1), false]),
      START_BLOCK - 1,
    )
    const [peerBeforeCode, peerAnchorCode] = await Promise.all([
      peer('eth_getCode', [TOKEN, hex(START_BLOCK - 1)]),
      peer('eth_getCode', [TOKEN, hex(START_BLOCK)]),
    ])
    if (
      peerAnchor.hash !== anchor.hash ||
      peerPrevious.hash !== previous.hash ||
      peerAnchor.parentHash !== peerPrevious.hash ||
      !/^0x0?$/i.test(String(peerBeforeCode)) ||
      String(peerAnchorCode).toLowerCase() !== String(anchorCode).toLowerCase()
    )
      fail('peer_anchor_mismatch')
  }
  // The deployment boundary is insufficient identity evidence: seal the exact
  // PoolConfigurator ReserveInitialized log naming this USDe variable-debt token.
  const readInitialization = async (reader) => {
    const response = await reader('eth_getLogs', initializationQuery())
    if (
      !Array.isArray(response) ||
      Buffer.byteLength(JSON.stringify(response)) > MAX_RESPONSE_BYTES ||
      response.length !== 1
    )
      fail('initialization_log_missing_or_ambiguous')
    return normalizeInitialization(response[0])
  }
  const reserveInitialization = await readInitialization(rpc)
  const peerInitialization = peer ? await readInitialization(peer) : null
  if (
    peerInitialization &&
    JSON.stringify(peerInitialization) !== JSON.stringify(reserveInitialization)
  )
    fail('peer_initialization_mismatch')
  const primaryFinalized = header(await rpc('eth_getBlockByNumber', ['finalized', false]))
  const peerFinalized = peer
    ? header(await peer('eth_getBlockByNumber', ['finalized', false]))
    : null
  const commonHead = peerFinalized
    ? Math.min(primaryFinalized.number, peerFinalized.number)
    : primaryFinalized.number
  if (throughBlock !== null && throughBlock > commonHead) fail('target_not_finalized')
  const finalized =
    commonHead === primaryFinalized.number
      ? primaryFinalized
      : header(await rpc('eth_getBlockByNumber', [hex(commonHead), false]), commonHead)
  if (peer) {
    const peerCommon =
      commonHead === peerFinalized.number
        ? peerFinalized
        : header(await peer('eth_getBlockByNumber', [hex(commonHead), false]), commonHead)
    if (peerCommon.hash !== finalized.hash) fail('peer_chain_mismatch')
  }
  let state = verify({ out })
  if (state.throughBlock > commonHead) fail('head_behind_frontier')
  if (throughBlock !== null && state.throughBlock > throughBlock) fail('target_behind_frontier')
  if (state.frontierHash) {
    const current = header(
      await rpc('eth_getBlockByNumber', [hex(state.throughBlock), false]),
      state.throughBlock,
    )
    if (current.hash !== state.frontierHash) fail('frontier_reorg')
    if (peer) {
      const peerCurrent = header(
        await peer('eth_getBlockByNumber', [hex(state.throughBlock), false]),
        state.throughBlock,
      )
      if (peerCurrent.hash !== state.frontierHash) fail('peer_frontier_reorg')
    }
  }
  let appended = 0
  const target = throughBlock ?? commonHead
  const readRange = async (reader, from, to) => {
    const logs = await reader('eth_getLogs', query(from, to))
    if (!Array.isArray(logs) || Buffer.byteLength(JSON.stringify(logs)) > MAX_RESPONSE_BYTES)
      throw new Error('usde_debt_mint_response_size_limit')
    if (logs.length >= MAX_LOGS_PER_RESPONSE) throw new Error('usde_debt_mint_result_limit')
    return logs
  }
  async function range(from, to) {
    if (appended >= maxChunks) return
    let response, peerResponse
    try {
      response = await readRange(rpc, from, to)
      peerResponse = peer ? await readRange(peer, from, to) : null
    } catch (error) {
      if (classifyRpcFailure(error) !== 'range_limit') throw error
      if (from === to) fail('ambiguous_singleton')
      const middle = Math.floor((from + to) / 2)
      await range(from, middle)
      if (appended < maxChunks) await range(middle + 1, to)
      return
    }
    const fromHeader = header(await rpc('eth_getBlockByNumber', [hex(from), false]), from)
    const toHeader =
      from === to ? fromHeader : header(await rpc('eth_getBlockByNumber', [hex(to), false]), to)
    if (from === START_BLOCK && fromHeader.hash !== START_HASH) fail('anchor_hash_mismatch')
    if (state.frontierHash && fromHeader.parentHash !== state.frontierHash)
      fail('noncontiguous_chain')
    let peerFrom = null,
      peerTo = null
    if (peer) {
      peerFrom = header(await peer('eth_getBlockByNumber', [hex(from), false]), from)
      peerTo =
        from === to ? peerFrom : header(await peer('eth_getBlockByNumber', [hex(to), false]), to)
      if (peerFrom.hash !== fromHeader.hash || peerTo.hash !== toHeader.hash)
        fail('peer_boundary_mismatch')
    }
    const logs = response
      .map((raw) => normalizeLog(raw, from, to))
      .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)
    const peerLogs = peerResponse
      ? peerResponse
          .map((raw) => normalizeLog(raw, from, to))
          .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)
      : null
    if (peerLogs && JSON.stringify(peerLogs) !== JSON.stringify(logs)) fail('peer_logs_mismatch')
    const seen = new Set()
    for (const log of logs) {
      const id = `${log.transactionHash}:${log.logIndex}`
      if (seen.has(id)) fail('duplicate_log')
      seen.add(id)
    }
    const headers = new Map([
      [from, fromHeader],
      [to, toHeader],
    ])
    for (const number of new Set(logs.map((entry) => entry.blockNumber))) {
      if (!headers.has(number))
        headers.set(number, header(await rpc('eth_getBlockByNumber', [hex(number), false]), number))
    }
    for (const log of logs) {
      if (log.blockHash !== headers.get(log.blockNumber).hash) fail('noncanonical_log')
    }
    const firstObservedAt = now().toISOString()
    const retrospectiveLagSeconds =
      Math.floor(Date.parse(firstObservedAt) / 1000) - toHeader.timestamp
    if (retrospectiveLagSeconds < 0) fail('negative_observation_lag')
    const segment = {
      config: config(),
      reserveInitialization,
      rangeBlocks,
      anchorProbePassedBlocksByReader,
      fromBlock: from,
      toBlock: to,
      fromHeader,
      toHeader,
      finalizedHead: finalized.number,
      finalizedHeadHash: finalized.hash,
      firstObservedAt,
      retrospectiveLagSeconds,
      coverage: peer ? 'two_rpc_readers_exact_agreement_not_provider_independence' : 'single_host',
      rawLogCount: response.length,
      logBlockHeaders: [...headers.values()].sort((a, b) => a.number - b.number),
      logs,
      candidateOwners: candidateOwners(logs),
      peerWitness: {
        hostCount: peer ? 2 : 1,
        distinctHostnames: peerDistinctHostnames,
        confirmedAt: firstObservedAt,
        fromHash: peer ? peerFrom.hash : fromHeader.hash,
        toHash: peer ? peerTo.hash : toHeader.hash,
        finalizedHead: finalized.number,
        finalizedHeadHash: finalized.hash,
        rawLogCount: peerResponse ? peerResponse.length : response.length,
        normalizedLogsSha256: peerLogs ? sha256(JSON.stringify(peerLogs)) : null,
        initializationSha256: peerInitialization
          ? sha256(JSON.stringify(peerInitialization))
          : null,
      },
    }
    try {
      appendSegment(out, segment, stat)
    } catch (error) {
      if (error.message !== 'usde_debt_mint_segment_size_cap' || from === to) throw error
      const middle = Math.floor((from + to) / 2)
      await range(from, middle)
      if (appended < maxChunks) await range(middle + 1, to)
      return
    }
    state = {
      ...state,
      throughBlock: to,
      frontierHash: toHeader.hash,
      segmentCount: state.segmentCount + 1,
      logCount: state.logCount + response.length,
    }
    appended++
    if (paceMs > 0 && appended < maxChunks && state.throughBlock < target) await sleep(paceMs)
  }
  while (appended < maxChunks && state.throughBlock < target) {
    const from = state.throughBlock + 1
    await range(from, Math.min(target, from + rangeBlocks - 1))
  }
  return {
    ...verify({ out }),
    finalizedHead: finalized.number,
    appended,
    rpcCalls: calls,
    hostCount: peer ? 2 : 1,
    rangeBlocks,
    anchorProbePassedBlocksByReader,
    targetBlock: target,
  }
}

export function parseArgs(argv) {
  let mode = null,
    maxChunks = 1,
    paceMs = 0,
    throughBlock = null,
    out = DEFAULT_OUT
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--run' || token === '--verify') {
      if (mode) fail('cli_invalid')
      mode = token
    } else if (token === '--max-chunks') maxChunks = Number(argv[++i])
    else if (token === '--pace-ms') {
      const value = argv[++i]
      if (!/^(?:0|[1-9][0-9]*)$/.test(value ?? '')) fail('cli_invalid')
      paceMs = Number(value)
    } else if (token === '--through-block') throughBlock = Number(argv[++i])
    else if (token === '--out') out = resolve(argv[++i])
    else fail('cli_invalid')
  }
  if (!mode || !Number.isInteger(maxChunks) || maxChunks < 1 || maxChunks > MAX_CHUNKS)
    fail('cli_invalid')
  if (!Number.isInteger(paceMs) || paceMs > MAX_PACE_MS) fail('cli_invalid')
  if (throughBlock !== null && (!Number.isSafeInteger(throughBlock) || throughBlock < START_BLOCK))
    fail('cli_invalid')
  if (out !== DEFAULT_OUT) fail('output_path_not_private')
  return { mode, maxChunks, paceMs, throughBlock, out }
}

const PREFLIGHT_RANGES = [CHUNK_BLOCKS, 1_000, 512, 256, 128, 64, 32, 16, 8, 4, 2, 1]

// Probe the exact token/filter at the anchor. A passed range is evidence for
// that anchor window only, not a promise about every later provider response.
export async function selectRpcReaders({
  raw,
  factory = makeClient,
  out = DEFAULT_OUT,
  stat = statfsSync,
} = {}) {
  if (!raw) fail('rpc_unavailable')
  const healthyByHostname = new Map()
  let preflightRpcCalls = 0
  const probe = async (call) => {
    if (++preflightRpcCalls > MAX_PREFLIGHT_CALLS) fail('preflight_call_cap')
    return call()
  }
  const candidates = String(raw)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 8)
  for (const [ordinal, candidate] of candidates.entries()) {
    if (
      [...healthyByHostname.values()].filter(
        (entry) => entry.anchorProbePassedBlocks === CHUNK_BLOCKS,
      ).length >= 2
    )
      break
    assertDiskFloor(out, stat)
    try {
      const hostname = new URL(candidate).hostname
      const client = factory(candidate)
      if ((await probe(() => client.getChainId())) !== 1) continue
      if (uint(await probe(() => client.request({ method: 'eth_chainId', params: [] }))) !== 1)
        continue
      const anchor = await probe(() => client.getBlock({ blockNumber: BigInt(START_BLOCK) }))
      if (anchor?.hash?.toLowerCase() !== START_HASH) continue
      const head = await probe(() => client.getBlock({ blockTag: 'finalized' }))
      if (!head?.number || !head?.hash) continue
      let anchorProbePassedBlocks = 0
      for (const count of PREFLIGHT_RANGES) {
        try {
          const logs = await probe(() =>
            client.request({
              method: 'eth_getLogs',
              params: query(START_BLOCK, START_BLOCK + count - 1),
            }),
          )
          if (
            Array.isArray(logs) &&
            logs.length < MAX_LOGS_PER_RESPONSE &&
            Buffer.byteLength(JSON.stringify(logs)) <= MAX_RESPONSE_BYTES
          ) {
            anchorProbePassedBlocks = count
            break
          }
        } catch (error) {
          if (error?.message === 'usde_debt_mint_preflight_call_cap') throw error
          if (rateLimited(error)) fail('rpc_rate_limit')
          if (!splittable(error)) fail('rpc_failed')
          // Only an explicit range/response limit can justify a narrower probe.
        }
      }
      if (!anchorProbePassedBlocks) continue
      const existing = healthyByHostname.get(hostname)
      if (!existing || anchorProbePassedBlocks > existing.anchorProbePassedBlocks)
        healthyByHostname.set(hostname, { client, anchorProbePassedBlocks, ordinal })
    } catch (error) {
      if (error?.message === 'usde_debt_mint_preflight_call_cap') throw error
      if (rateLimited(error)) fail('rpc_rate_limit')
      // No URL, credential, or provider error is printed or returned.
    }
  }
  const readers = [...healthyByHostname.values()]
    .sort((a, b) => b.anchorProbePassedBlocks - a.anchorProbePassedBlocks || a.ordinal - b.ordinal)
    .slice(0, 2)
    .map(({ client, anchorProbePassedBlocks }) => ({ client, anchorProbePassedBlocks }))
  if (!readers.length) fail('no_healthy_rpc_host')
  return { readers, preflightRpcCalls }
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const args = parseArgs(argv)
  if (existsSync(args.out) && lstatSync(args.out).isSymbolicLink()) fail('output_path_not_private')
  if (args.mode === '--verify') return verify(args)
  if (dependencies.rpcRead) return collect({ ...args, ...dependencies })
  const env = dependencies.env ?? readEnv()
  const raw =
    dependencies.rpcUrls ??
    process.env.RECORDER_RPC_URLS ??
    process.env.RECORDER_RPC_URL ??
    env.get('RECORDER_RPC_URLS') ??
    env.get('RECORDER_RPC_URL')
  if (!raw) fail('rpc_unavailable')
  const factory = dependencies.makeClient ?? makeClient
  const { readers, preflightRpcCalls } = await selectRpcReaders({
    raw,
    factory,
    out: args.out,
    stat: dependencies.stat ?? statfsSync,
  })
  const safeRead = (client) => async (method, params) => {
    try {
      return await client.request({ method, params })
    } catch (error) {
      const reason = classifyRpcFailure(error, method)
      throw new Error(`usde_debt_mint_rpc_${reason}`)
    }
  }
  const result = await collect({
    ...args,
    rpcRead: safeRead(readers[0].client),
    peerRpcRead: readers[1] ? safeRead(readers[1].client) : null,
    peerDistinctHostnames: Boolean(readers[1]),
    rangeBlocks: Math.min(...readers.map((reader) => reader.anchorProbePassedBlocks)),
    anchorProbePassedBlocksByReader: readers.map((reader) => reader.anchorProbePassedBlocks),
    initialRpcCalls: preflightRpcCalls,
    now: dependencies.now ?? (() => new Date()),
    sleep: dependencies.sleep,
  })
  return { ...result, preflightRpcCalls }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      const message = String(error?.message)
      process.stderr.write(
        `${/^usde_debt_mint_[a-z_]+$/.test(message) ? message : 'usde_debt_mint_rpc_or_provider_failure'}\n`,
      )
      process.exitCode = 1
    },
  )
}
