// Finalized onchain event witness for prospective USDe→sUSDe candidates.
// Borrow.onBehalfOf (mode 2) and vault activity are NOT a borrower census,
// retained position, route attribution, or executable exit measurement.
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
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

export const POOL = '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2'
export const USDE = '0x4c9edd5852cd905f086c759e8383e09bff1e68b3'
export const SUSDE = '0x9d39a5de30e57443bff2a8307a4256c8797a3497'
export const STREAMS = ['borrow', 'deposit', 'transfer']
export const CHUNK_BLOCKS = 1_000
export const MAX_CHUNKS = 4
export const LOG_SPLIT_THRESHOLD = 250
export const MAX_RESPONSE_BYTES = 2_000_000
export const MAX_SEGMENT_BYTES = 4_000_000
export const MAX_RPC_CALLS = 256
export const MIN_FREE_BYTES = 1_073_741_824
export const DEFAULT_OUT = join(
  ROOT,
  'data',
  'research',
  'venue-signals',
  'usde-carry-route-entrants',
)

const HEX32 = /^0x[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const ZERO = '0x0000000000000000000000000000000000000000'
const BORROW = parseAbiItem(
  'event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)',
)
const DEPOSIT = parseAbiItem(
  'event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)',
)
const TRANSFER = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
)
const ABI = { borrow: BORROW, deposit: DEPOSIT, transfer: TRANSFER }
const TOPICS = Object.fromEntries(
  STREAMS.map((kind) => [
    kind,
    encodeEventTopics({ abi: [ABI[kind]], eventName: ABI[kind].name })[0].toLowerCase(),
  ]),
)
const hex = (value) => `0x${BigInt(value).toString(16)}`
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const fail = (code) => {
  throw new Error(`usde_scan_${code}`)
}

function uint(value) {
  try {
    const number = Number(BigInt(value))
    if (Number.isSafeInteger(number) && number >= 0) return number
  } catch {
    /* Invalid or missing RPC word. */
  }
  fail('integer_invalid')
}

export function config() {
  return {
    chainId: 1,
    pool: POOL,
    borrowedAsset: USDE,
    destination: SUSDE,
    streams: STREAMS,
    chunkBlocks: CHUNK_BLOCKS,
    logSplitThreshold: LOG_SPLIT_THRESHOLD,
    candidateBorrowMode: 2,
    claim: 'event_observed_candidates_not_borrower_census_or_route_tvl',
  }
}

export function assertDiskFloor(out, stat = statfsSync, expectedBytes = 0) {
  let candidate = existsSync(out) ? out : dirname(out)
  while (!existsSync(candidate) && dirname(candidate) !== candidate) candidate = dirname(candidate)
  const space = stat(candidate)
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
  const timestamp = uint(raw.timestamp)
  return {
    number,
    hash: raw.hash.toLowerCase(),
    parentHash: raw.parentHash.toLowerCase(),
    timestamp,
  }
}

export function normalizeLog(raw, kind, from, to) {
  if (!STREAMS.includes(kind)) fail('stream_invalid')
  const address = String(raw?.address).toLowerCase()
  const blockNumber = uint(raw?.blockNumber)
  const logIndex = uint(raw?.logIndex)
  const blockHash = String(raw?.blockHash).toLowerCase()
  const transactionHash = String(raw?.transactionHash).toLowerCase()
  const topics = raw?.topics?.map((value) => String(value).toLowerCase())
  const data = String(raw?.data).toLowerCase()
  if (
    raw?.removed === true ||
    address !== (kind === 'borrow' ? POOL : SUSDE) ||
    blockNumber < from ||
    blockNumber > to ||
    !HEX32.test(blockHash) ||
    !HEX32.test(transactionHash) ||
    !Array.isArray(topics) ||
    topics[0] !== TOPICS[kind] ||
    topics.some((word) => !HEX32.test(word)) ||
    !/^0x[0-9a-f]*$/.test(data)
  )
    fail('log_identity_mismatch')
  let decoded
  try {
    decoded = decodeEventLog({ abi: [ABI[kind]], topics, data })
  } catch {
    fail('log_decode_failed')
  }
  if (
    kind === 'borrow' &&
    (String(decoded.args.reserve).toLowerCase() !== USDE || decoded.args.amount <= 0n)
  )
    fail('borrow_identity_mismatch')
  const args =
    kind === 'borrow'
      ? {
          reserve: USDE,
          user: decoded.args.user.toLowerCase(),
          onBehalfOf: decoded.args.onBehalfOf.toLowerCase(),
          amountRaw: decoded.args.amount.toString(),
          interestRateMode: Number(decoded.args.interestRateMode),
        }
      : kind === 'deposit'
        ? {
            sender: decoded.args.sender.toLowerCase(),
            owner: decoded.args.owner.toLowerCase(),
            assetsRaw: decoded.args.assets.toString(),
            sharesRaw: decoded.args.shares.toString(),
          }
        : {
            from: decoded.args.from.toLowerCase(),
            to: decoded.args.to.toLowerCase(),
            sharesRaw: decoded.args.value.toString(),
          }
  return { kind, address, blockNumber, blockHash, transactionHash, logIndex, topics, data, args }
}

function query(kind, from, to) {
  return [
    {
      fromBlock: hex(from),
      toBlock: hex(to),
      address: kind === 'borrow' ? POOL : SUSDE,
      topics:
        kind === 'borrow'
          ? [TOPICS.borrow, `0x${USDE.slice(2).padStart(64, '0')}`]
          : [TOPICS[kind]],
    },
  ]
}

function splittable(error) {
  const message = `${error?.shortMessage ?? ''} ${error?.message ?? ''}`.toLowerCase()
  return /too many|more than|result[ _]limit|response[ _]size|block range|range limit|range_limit|query returned|exceeds.*logs|timeout/.test(
    message,
  )
}

export function candidateOwners(logs) {
  const variableBorrowOwners = new Set()
  const vaultActivityOwners = new Set()
  for (const log of logs) {
    if (log.kind === 'borrow' && log.args.interestRateMode === 2)
      variableBorrowOwners.add(log.args.onBehalfOf)
    else if (log.kind === 'deposit' && BigInt(log.args.sharesRaw) > 0n)
      vaultActivityOwners.add(log.args.owner)
    else if (log.kind === 'transfer' && BigInt(log.args.sharesRaw) > 0n) {
      if (log.args.from !== ZERO) vaultActivityOwners.add(log.args.from)
      if (log.args.to !== ZERO) vaultActivityOwners.add(log.args.to)
    }
  }
  return {
    variableBorrowOwners: [...variableBorrowOwners].sort(),
    vaultActivityOwners: [...vaultActivityOwners].sort(),
  }
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
    linkSync(temporary, target) // Atomic, exclusive publication; never overwrite a sealed segment.
  } finally {
    if (fd !== null && fd !== undefined) closeSync(fd)
    if (existsSync(temporary)) unlinkSync(temporary)
  }
  return target
}

export function verify({ out = DEFAULT_OUT, fromBlock }) {
  if (!Number.isSafeInteger(fromBlock) || fromBlock < 0) fail('explicit_from_block_required')
  const names = existsSync(out) ? readdirSync(out) : []
  if (names.some((name) => !/^\d{12}-\d{12}-[a-f0-9]{64}\.json$/.test(name)))
    fail('unrecognized_artifact')
  names.sort()
  let throughBlock = fromBlock - 1
  let frontierHash = null
  for (const name of names) {
    const bytes = readFileSync(join(out, name))
    const segment = JSON.parse(bytes)
    if (
      segmentName(segment, bytes) !== name ||
      segment.schemaVersion !== 1 ||
      JSON.stringify(segment.config) !== JSON.stringify(config()) ||
      segment.fromBlock !== throughBlock + 1 ||
      !Number.isSafeInteger(segment.toBlock) ||
      segment.toBlock < segment.fromBlock ||
      segment.toBlock - segment.fromBlock >= CHUNK_BLOCKS ||
      segment.fromHeader?.number !== segment.fromBlock ||
      segment.toHeader?.number !== segment.toBlock ||
      !HEX32.test(segment.fromHeader?.hash) ||
      !HEX32.test(segment.toHeader?.hash) ||
      (frontierHash && segment.fromHeader.parentHash !== frontierHash) ||
      !Number.isSafeInteger(segment.finalizedHead) ||
      segment.finalizedHead < segment.toBlock ||
      !HEX32.test(segment.finalizedHeadHash) ||
      !Number.isFinite(Date.parse(segment.firstObservedAt)) ||
      segment.captureLagSeconds !==
        Math.floor(Date.parse(segment.firstObservedAt) / 1000) - segment.toHeader.timestamp ||
      segment.captureLagSeconds < 0 ||
      !Array.isArray(segment.scans) ||
      segment.scans.length !== STREAMS.length ||
      !Array.isArray(segment.logs) ||
      !Array.isArray(segment.logBlockHeaders) ||
      !['single_host', 'two_rpc_readers_exact_agreement_not_provider_independence'].includes(
        segment.coverage,
      )
    )
      fail('segment_invalid')
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
      !Array.isArray(witness.scans) ||
      witness.scans.length !== STREAMS.length ||
      witness.scans.some(
        (scan, index) =>
          scan.kind !== STREAMS[index] || scan.rawCount !== segment.scans[index].rawCount,
      ) ||
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
    for (const kind of STREAMS) {
      const scan = segment.scans.find((entry) => entry.kind === kind)
      if (
        !scan ||
        scan.fromBlock !== segment.fromBlock ||
        scan.toBlock !== segment.toBlock ||
        scan.rawCount !== segment.logs.filter((entry) => entry.kind === kind).length
      )
        fail('stream_coverage_invalid')
    }
    const seen = new Set()
    for (const entry of segment.logs) {
      const normalized = normalizeLog(entry, entry.kind, segment.fromBlock, segment.toBlock)
      if (JSON.stringify(normalized) !== JSON.stringify(entry)) fail('log_invalid')
      const id = `${entry.transactionHash}:${entry.logIndex}`
      if (seen.has(id)) fail('duplicate_log')
      seen.add(id)
      if (headers.get(entry.blockNumber)?.hash !== entry.blockHash) fail('noncanonical_log')
    }
    if (JSON.stringify(candidateOwners(segment.logs)) !== JSON.stringify(segment.candidates))
      fail('candidate_mismatch')
    throughBlock = segment.toBlock
    frontierHash = segment.toHeader.hash
  }
  return { fromBlock, throughBlock, frontierHash, segmentCount: names.length }
}

export async function collect({
  rpcRead,
  peerRpcRead = null,
  peerDistinctHostnames = false,
  initialRpcCalls = 0,
  fromBlock,
  out = DEFAULT_OUT,
  maxChunks = 1,
  now = () => new Date(),
  stat = statfsSync,
}) {
  if (!Number.isSafeInteger(fromBlock) || fromBlock < 0) fail('explicit_from_block_required')
  if (!Number.isInteger(maxChunks) || maxChunks < 1 || maxChunks > MAX_CHUNKS)
    fail('invalid_max_chunks')
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
  const peerRpc = peerRpcRead ? guarded(peerRpcRead) : null
  if (uint(await rpc('eth_chainId', [])) !== 1) fail('wrong_chain')
  if (peerRpc && uint(await peerRpc('eth_chainId', [])) !== 1) fail('peer_wrong_chain')
  const primaryFinalized = header(await rpc('eth_getBlockByNumber', ['finalized', false]))
  const peerFinalized = peerRpc
    ? header(await peerRpc('eth_getBlockByNumber', ['finalized', false]))
    : null
  const commonHead = peerFinalized
    ? Math.min(primaryFinalized.number, peerFinalized.number)
    : primaryFinalized.number
  const finalized =
    commonHead === primaryFinalized.number
      ? primaryFinalized
      : header(await rpc('eth_getBlockByNumber', [hex(commonHead), false]), commonHead)
  if (peerRpc) {
    const peerCommon =
      commonHead === peerFinalized.number
        ? peerFinalized
        : header(await peerRpc('eth_getBlockByNumber', [hex(commonHead), false]), commonHead)
    if (peerCommon.hash !== finalized.hash) fail('peer_chain_mismatch')
  }
  let state = verify({ out, fromBlock })
  if (state.throughBlock > commonHead) fail('head_behind_frontier')
  if (state.frontierHash) {
    const current = header(
      await rpc('eth_getBlockByNumber', [hex(state.throughBlock), false]),
      state.throughBlock,
    )
    if (current.hash !== state.frontierHash) fail('frontier_reorg')
    if (peerRpc) {
      const peerCurrent = header(
        await peerRpc('eth_getBlockByNumber', [hex(state.throughBlock), false]),
        state.throughBlock,
      )
      if (peerCurrent.hash !== state.frontierHash) fail('peer_frontier_reorg')
    }
  }
  let appended = 0
  const readRange = async (reader, from, to) => {
    const responses = []
    for (const kind of STREAMS) {
      const logs = await reader('eth_getLogs', query(kind, from, to))
      if (!Array.isArray(logs) || Buffer.byteLength(JSON.stringify(logs)) > MAX_RESPONSE_BYTES)
        throw new Error('usde_scan_response_size_limit')
      if (logs.length >= LOG_SPLIT_THRESHOLD) throw new Error('usde_scan_result_limit')
      responses.push({ kind, logs })
    }
    return responses
  }
  async function range(from, to) {
    if (appended >= maxChunks) return
    let responses, peerResponses
    try {
      responses = await readRange(rpc, from, to)
      peerResponses = peerRpc ? await readRange(peerRpc, from, to) : null
    } catch (error) {
      if (!splittable(error)) throw error
      if (from === to) fail('ambiguous_singleton')
      const middle = Math.floor((from + to) / 2)
      await range(from, middle)
      if (appended < maxChunks) await range(middle + 1, to)
      return
    }
    const fromHeader = header(await rpc('eth_getBlockByNumber', [hex(from), false]), from)
    const toHeader =
      from === to ? fromHeader : header(await rpc('eth_getBlockByNumber', [hex(to), false]), to)
    if (state.frontierHash && fromHeader.parentHash !== state.frontierHash)
      fail('noncontiguous_chain')
    let peerFromHeader = null,
      peerToHeader = null
    if (peerRpc) {
      peerFromHeader = header(await peerRpc('eth_getBlockByNumber', [hex(from), false]), from)
      peerToHeader =
        from === to
          ? peerFromHeader
          : header(await peerRpc('eth_getBlockByNumber', [hex(to), false]), to)
      if (peerFromHeader.hash !== fromHeader.hash || peerToHeader.hash !== toHeader.hash)
        fail('peer_boundary_mismatch')
    }
    const normalize = (sets) =>
      sets
        .flatMap(({ kind, logs }) => logs.map((raw) => normalizeLog(raw, kind, from, to)))
        .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)
    const logs = normalize(responses)
    const peerLogs = peerResponses ? normalize(peerResponses) : null
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
    if (Math.floor(Date.parse(firstObservedAt) / 1000) < toHeader.timestamp)
      fail('negative_capture_lag')
    const segment = {
      schemaVersion: 1,
      config: config(),
      coverage: peerRpc
        ? 'two_rpc_readers_exact_agreement_not_provider_independence'
        : 'single_host',
      fromBlock: from,
      toBlock: to,
      fromHeader,
      toHeader,
      finalizedHead: finalized.number,
      finalizedHeadHash: finalized.hash,
      firstObservedAt,
      captureLagSeconds: Math.floor(Date.parse(firstObservedAt) / 1000) - toHeader.timestamp,
      scans: responses.map(({ kind, logs: raw }) => ({
        kind,
        fromBlock: from,
        toBlock: to,
        rawCount: raw.length,
      })),
      logBlockHeaders: [...headers.values()].sort((a, b) => a.number - b.number),
      logs,
      candidates: candidateOwners(logs),
      peerWitness: {
        hostCount: peerRpc ? 2 : 1,
        distinctHostnames: peerDistinctHostnames,
        confirmedAt: firstObservedAt,
        fromHash: peerRpc ? peerFromHeader.hash : fromHeader.hash,
        toHash: peerRpc ? peerToHeader.hash : toHeader.hash,
        finalizedHead: finalized.number,
        finalizedHeadHash: finalized.hash,
        normalizedLogsSha256: peerLogs ? sha256(JSON.stringify(peerLogs)) : null,
        scans: (peerResponses ?? responses).map(({ kind, logs: raw }) => ({
          kind,
          rawCount: raw.length,
        })),
      },
    }
    try {
      appendSegment(out, segment, stat)
    } catch (error) {
      if (error.message !== 'usde_scan_segment_size_cap' || from === to) throw error
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
    }
    appended++
  }
  while (appended < maxChunks && state.throughBlock < commonHead) {
    const from = state.throughBlock + 1
    await range(from, Math.min(commonHead, from + CHUNK_BLOCKS - 1))
  }
  return {
    ...verify({ out, fromBlock }),
    finalizedHead: finalized.number,
    appended,
    rpcCalls: calls,
    hostCount: peerRpc ? 2 : 1,
  }
}

function parseArgs(argv) {
  let mode = null,
    fromBlock = null,
    maxChunks = 1,
    out = DEFAULT_OUT
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--run' || token === '--verify') {
      if (mode) fail('cli_invalid')
      mode = token
    } else if (token === '--from-block') fromBlock = Number(argv[++i])
    else if (token === '--max-chunks') maxChunks = Number(argv[++i])
    else if (token === '--out') out = resolve(argv[++i])
    else fail('cli_invalid')
  }
  if (
    !mode ||
    !Number.isSafeInteger(fromBlock) ||
    fromBlock < 0 ||
    !Number.isInteger(maxChunks) ||
    maxChunks < 1 ||
    maxChunks > MAX_CHUNKS
  )
    fail('cli_invalid')
  return { mode, fromBlock, maxChunks, out }
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const args = parseArgs(argv)
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
  const clientFactory = dependencies.makeClient ?? makeClient
  const choices = []
  const hostnames = new Set()
  let preflightRpcCalls = 0
  const probe = async (call) => {
    if (++preflightRpcCalls > MAX_RPC_CALLS) fail('rpc_call_cap')
    return call()
  }
  for (const candidate of String(raw)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 8)) {
    if (choices.length === 2) break
    try {
      const hostname = new URL(candidate).hostname
      if (hostnames.has(hostname)) continue
      assertDiskFloor(args.out)
      const client = clientFactory(candidate)
      if ((await probe(() => client.getChainId())) !== 1) continue
      // Collection uses raw request(), which can fail even when viem's action succeeds.
      if (uint(await probe(() => client.request({ method: 'eth_chainId', params: [] }))) !== 1)
        continue
      const head = await probe(() => client.getBlock({ blockTag: 'finalized' }))
      if (!head?.number || !head?.hash) continue
      const probeBlock = Number(head.number)
      if (!Number.isSafeInteger(probeBlock)) continue
      let suitable = true
      for (const kind of STREAMS) {
        const logs = await probe(() =>
          client.request({
            method: 'eth_getLogs',
            params: query(kind, probeBlock, probeBlock),
          }),
        )
        if (
          !Array.isArray(logs) ||
          logs.length >= LOG_SPLIT_THRESHOLD ||
          Buffer.byteLength(JSON.stringify(logs)) > MAX_RESPONSE_BYTES
        ) {
          suitable = false
          break
        }
      }
      if (!suitable) continue
      choices.push(client)
      hostnames.add(hostname)
    } catch (error) {
      if (error?.message === 'usde_scan_rpc_call_cap') throw error
      /* Never print provider errors or credential-bearing URLs. */
    }
  }
  if (!choices.length) fail('no_healthy_rpc_host')
  const safeRead = (client) => async (method, params) => {
    try {
      return await client.request({ method, params })
    } catch (error) {
      const reason =
        method === 'eth_getLogs' && splittable(error)
          ? 'range_limit'
          : /rate limit|quota|429/i.test(String(error?.message))
            ? 'rate_limit'
            : 'failed'
      throw new Error(`usde_scan_rpc_${reason}`)
    }
  }
  const result = await collect({
    ...args,
    rpcRead: safeRead(choices[0]),
    peerRpcRead: choices[1] ? safeRead(choices[1]) : null,
    peerDistinctHostnames: Boolean(choices[1]),
    initialRpcCalls: preflightRpcCalls,
    now: dependencies.now ?? (() => new Date()),
  })
  return { ...result, preflightRpcCalls }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      const message = String(error?.message)
      process.stderr.write(
        `${/^usde_scan_[a-z_]+$/.test(message) ? message : 'usde_scan_rpc_or_provider_failure'}\n`,
      )
      process.exitCode = 1
    },
  )
}
