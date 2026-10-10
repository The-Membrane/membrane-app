// Prospective evidence only: Borrow and sGHO Deposit/Transfer identify candidate
// wallets, not retained borrowed proceeds, route-attributed TVL, or all users.
// Operator chooses the start block; this scanner never invents a Pool epoch.
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeEventLog, encodeEventTopics, parseAbiItem } from 'viem'

import { ROOT, makeClient, readEnv } from '../lib/venue-reads.mjs'
import { GHO_SGHO } from '../route-rates/exact-leg-spread.mjs'

export const POOL = GHO_SGHO.borrowMarket.toLowerCase()
export const GHO = GHO_SGHO.borrowAsset.toLowerCase()
export const SGHO = GHO_SGHO.destination.toLowerCase()
export const STREAMS = ['borrow', 'deposit', 'transfer']
export const CHUNK_BLOCKS = 1_000
export const MAX_CHUNKS = 4
// A previously observed provider silently capped near 322 logs. Treat 250 as
// ambiguous rather than accepting an apparently complete response.
export const LOG_SPLIT_THRESHOLD = 250
export const MAX_RESPONSE_BYTES = 2_000_000
export const MAX_SEGMENT_BYTES = 4_000_000
export const MIN_FREE_BYTES = 1_073_741_824
export const MAX_RPC_CALLS = 256
const DEFAULT_OUT = join(ROOT, 'data', 'research', 'venue-signals', 'carry-route-entrants')
const HEX32 = /^0x[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/
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
const topic = (kind) =>
  encodeEventTopics({ abi: [ABI[kind]], eventName: ABI[kind].name })[0].toLowerCase()
const TOPICS = Object.fromEntries(STREAMS.map((kind) => [kind, topic(kind)]))
const hex = (number) => `0x${BigInt(number).toString(16)}`
const uint = (value) => {
  const number = Number(BigInt(value))
  if (!Number.isSafeInteger(number) || number < 0) throw new Error('invalid_block_or_index')
  return number
}
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')

function config() {
  return {
    chainId: 1,
    pool: POOL,
    borrowedAsset: GHO,
    destination: SGHO,
    streams: STREAMS,
    chunkBlocks: CHUNK_BLOCKS,
    logSplitThreshold: LOG_SPLIT_THRESHOLD,
  }
}

export function assertDiskFloor(out, stat = statfsSync, expectedBytes = 0) {
  const fs = stat(existsSync(out) ? out : dirname(out))
  if (Number(fs.bavail) * Number(fs.bsize) - expectedBytes < MIN_FREE_BYTES) {
    throw new Error('entrant_disk_reserve_reached')
  }
}

function parseHeader(value, expected) {
  if (
    !value ||
    !HEX32.test(String(value.hash).toLowerCase()) ||
    !HEX32.test(String(value.parentHash).toLowerCase())
  )
    throw new Error('invalid_block_header')
  const number = uint(value.number)
  if (expected !== undefined && number !== expected) throw new Error('block_number_mismatch')
  return {
    number,
    hash: value.hash.toLowerCase(),
    parentHash: value.parentHash.toLowerCase(),
    timestamp: uint(value.timestamp),
  }
}

function normalizeLog(raw, kind, from, to) {
  const address = String(raw.address).toLowerCase()
  const blockNumber = uint(raw.blockNumber)
  const logIndex = uint(raw.logIndex)
  const blockHash = String(raw.blockHash).toLowerCase()
  const transactionHash = String(raw.transactionHash).toLowerCase()
  const topics = raw.topics?.map((item) => String(item).toLowerCase())
  const data = String(raw.data).toLowerCase()
  const expectedAddress = kind === 'borrow' ? POOL : SGHO
  if (
    raw.removed === true ||
    address !== expectedAddress ||
    blockNumber < from ||
    blockNumber > to ||
    !HEX32.test(blockHash) ||
    !HEX32.test(transactionHash) ||
    !Array.isArray(topics) ||
    topics[0] !== TOPICS[kind] ||
    topics.some((item) => !HEX32.test(item)) ||
    !/^0x[0-9a-f]*$/.test(data)
  ) {
    throw new Error('entrant_log_identity_mismatch')
  }
  let decoded
  try {
    decoded = decodeEventLog({ abi: [ABI[kind]], topics, data })
  } catch {
    throw new Error('entrant_log_decode_failed')
  }
  if (
    kind === 'borrow' &&
    (String(decoded.args.reserve).toLowerCase() !== GHO || decoded.args.amount <= 0n)
  ) {
    throw new Error('entrant_borrow_identity_mismatch')
  }
  const args =
    kind === 'borrow'
      ? {
          reserve: GHO,
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
      address: kind === 'borrow' ? POOL : SGHO,
      topics:
        kind === 'borrow' ? [TOPICS.borrow, `0x${GHO.slice(2).padStart(64, '0')}`] : [TOPICS[kind]],
    },
  ]
}

function splittable(error) {
  const message = `${error?.shortMessage ?? ''} ${error?.message ?? ''}`.toLowerCase()
  return /too many|more than|result limit|response size|block range|range limit|range_limit|query returned|exceeds.*logs|timeout/.test(
    message,
  )
}

function segmentName(segment, bytes) {
  return `${String(segment.fromBlock).padStart(12, '0')}-${String(segment.toBlock).padStart(12, '0')}-${sha(bytes)}.json`
}

export function appendSegment(out, segment, stat = statfsSync) {
  const bytes = JSON.stringify(segment)
  if (Buffer.byteLength(bytes) > MAX_SEGMENT_BYTES) throw new Error('entrant_segment_size_cap')
  mkdirSync(out, { recursive: true })
  assertDiskFloor(out, stat, Buffer.byteLength(bytes))
  const target = join(out, segmentName(segment, bytes))
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 })
    linkSync(temporary, target) // Exclusive create: never replace a sealed segment.
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
  return target
}

export function verify({ out = DEFAULT_OUT, fromBlock }) {
  if (!Number.isSafeInteger(fromBlock) || fromBlock < 0)
    throw new Error('explicit_from_block_required')
  const names = existsSync(out) ? readdirSync(out) : []
  if (names.some((name) => !/^\d{12}-\d{12}-[a-f0-9]{64}\.json$/.test(name))) {
    throw new Error('unrecognized_entrant_artifact')
  }
  names.sort()
  let throughBlock = fromBlock - 1
  let frontierHash = null
  for (const name of names) {
    const bytes = readFileSync(join(out, name))
    const segment = JSON.parse(bytes.toString('utf8'))
    if (
      segmentName(segment, bytes) !== name ||
      ![1, 2, 3].includes(segment.schemaVersion) ||
      JSON.stringify(segment.config) !== JSON.stringify(config()) ||
      segment.fromBlock !== throughBlock + 1 ||
      !Number.isSafeInteger(segment.toBlock) ||
      segment.toBlock < segment.fromBlock ||
      segment.toBlock - segment.fromBlock >= CHUNK_BLOCKS ||
      !HEX32.test(segment.fromHeader?.hash) ||
      !HEX32.test(segment.toHeader?.hash) ||
      segment.fromHeader.number !== segment.fromBlock ||
      segment.toHeader.number !== segment.toBlock ||
      (frontierHash && segment.fromHeader.parentHash !== frontierHash) ||
      segment.finalizedHead < segment.toBlock ||
      !HEX32.test(segment.finalizedHeadHash) ||
      !Number.isFinite(Date.parse(segment.firstObservedAt)) ||
      segment.captureLagSeconds !==
        Math.floor(Date.parse(segment.firstObservedAt) / 1000) - segment.toHeader.timestamp ||
      !Array.isArray(segment.scans) ||
      segment.scans.length !== STREAMS.length ||
      !Array.isArray(segment.logs) ||
      !Array.isArray(segment.logBlockHeaders)
    )
      throw new Error('entrant_segment_invalid')
    if (segment.schemaVersion >= 2) {
      const witness = segment.peerWitness
      if (
        !witness ||
        !Number.isFinite(Date.parse(witness.confirmedAt)) ||
        witness.fromHash !== segment.fromHeader.hash ||
        witness.toHash !== segment.toHeader.hash ||
        witness.finalizedHead !== segment.finalizedHead ||
        witness.finalizedHeadHash !== segment.finalizedHeadHash ||
        !HEX32.test(witness.finalizedHeadHash) ||
        !Array.isArray(witness.scans) ||
        witness.scans.length !== STREAMS.length ||
        witness.scans.some(
          (scan, index) =>
            scan.kind !== STREAMS[index] || scan.rawCount !== segment.scans[index].rawCount,
        )
      )
        throw new Error('entrant_peer_witness_invalid')
      if (
        segment.schemaVersion === 3 &&
        (!/^[a-f0-9]{64}$/.test(witness.normalizedLogsSha256) ||
          witness.normalizedLogsSha256 !== sha(JSON.stringify(segment.logs)))
      )
        throw new Error('entrant_peer_digest_invalid')
    }
    const savedHeaders = new Map()
    for (const candidate of segment.logBlockHeaders) {
      if (
        !Number.isSafeInteger(candidate.number) ||
        candidate.number < segment.fromBlock ||
        candidate.number > segment.toBlock ||
        !HEX32.test(candidate.hash) ||
        !HEX32.test(candidate.parentHash) ||
        savedHeaders.has(candidate.number)
      )
        throw new Error('entrant_log_header_invalid')
      savedHeaders.set(candidate.number, candidate)
    }
    if (
      savedHeaders.get(segment.fromBlock)?.hash !== segment.fromHeader.hash ||
      savedHeaders.get(segment.toBlock)?.hash !== segment.toHeader.hash
    )
      throw new Error('entrant_boundary_header_invalid')
    const seen = new Set()
    for (let i = 0; i < STREAMS.length; i++) {
      const scan = segment.scans[i]
      const actual = segment.logs.filter((item) => item.kind === STREAMS[i]).length
      if (
        scan.kind !== STREAMS[i] ||
        scan.fromBlock !== segment.fromBlock ||
        scan.toBlock !== segment.toBlock ||
        scan.rawCount !== actual
      ) {
        throw new Error('entrant_stream_coverage_invalid')
      }
    }
    for (const entry of segment.logs) {
      const decoded = normalizeLog(entry, entry.kind, segment.fromBlock, segment.toBlock)
      if (JSON.stringify(decoded) !== JSON.stringify(entry)) throw new Error('entrant_log_invalid')
      const id = `${entry.transactionHash}:${entry.logIndex}`
      if (seen.has(id)) throw new Error('entrant_duplicate_log')
      seen.add(id)
      if (entry.blockNumber === segment.fromBlock && entry.blockHash !== segment.fromHeader.hash)
        throw new Error('entrant_boundary_hash_mismatch')
      if (entry.blockNumber === segment.toBlock && entry.blockHash !== segment.toHeader.hash)
        throw new Error('entrant_boundary_hash_mismatch')
      if (savedHeaders.get(entry.blockNumber)?.hash !== entry.blockHash)
        throw new Error('entrant_log_header_mismatch')
    }
    throughBlock = segment.toBlock
    frontierHash = segment.toHeader.hash
  }
  return { fromBlock, throughBlock, frontierHash, segmentCount: names.length }
}

export async function collect({
  rpcRead,
  peerRpcRead,
  fromBlock,
  out = DEFAULT_OUT,
  maxChunks = 1,
  now = () => new Date(),
  stat = statfsSync,
}) {
  if (!Number.isSafeInteger(fromBlock) || fromBlock < 0)
    throw new Error('explicit_from_block_required')
  if (!Number.isInteger(maxChunks) || maxChunks < 1 || maxChunks > MAX_CHUNKS)
    throw new Error('invalid_max_chunks')
  let calls = 0
  const rpc = async (method, params) => {
    assertDiskFloor(out, stat)
    if (++calls > MAX_RPC_CALLS) throw new Error('entrant_rpc_call_cap')
    return rpcRead(method, params)
  }
  const peerRpc = peerRpcRead
    ? async (method, params) => {
        assertDiskFloor(out, stat)
        if (++calls > MAX_RPC_CALLS) throw new Error('entrant_rpc_call_cap')
        return peerRpcRead(method, params)
      }
    : null
  if (uint(await rpc('eth_chainId', [])) !== 1) throw new Error('ethereum_mainnet_required')
  if (peerRpc && uint(await peerRpc('eth_chainId', [])) !== 1)
    throw new Error('entrant_peer_mainnet_required')
  const primaryFinalized = parseHeader(await rpc('eth_getBlockByNumber', ['finalized', false]))
  const peerFinalized = peerRpc
    ? parseHeader(await peerRpc('eth_getBlockByNumber', ['finalized', false]))
    : null
  const commonHead = peerFinalized
    ? Math.min(primaryFinalized.number, peerFinalized.number)
    : primaryFinalized.number
  const finalized =
    commonHead === primaryFinalized.number
      ? primaryFinalized
      : parseHeader(await rpc('eth_getBlockByNumber', [hex(commonHead), false]), commonHead)
  if (peerRpc) {
    const peerCommon =
      commonHead === peerFinalized.number
        ? peerFinalized
        : parseHeader(await peerRpc('eth_getBlockByNumber', [hex(commonHead), false]), commonHead)
    if (finalized.hash !== peerCommon.hash) throw new Error('entrant_peer_chain_mismatch')
  }
  let state = verify({ out, fromBlock })
  if (state.frontierHash) {
    const current = parseHeader(
      await rpc('eth_getBlockByNumber', [hex(state.throughBlock), false]),
      state.throughBlock,
    )
    if (current.hash !== state.frontierHash) throw new Error('entrant_frontier_reorg')
  }
  let appended = 0
  async function range(from, to) {
    if (appended >= maxChunks) return
    let responses
    try {
      responses = []
      for (const kind of STREAMS) {
        const logs = await rpc('eth_getLogs', query(kind, from, to))
        if (!Array.isArray(logs) || Buffer.byteLength(JSON.stringify(logs)) > MAX_RESPONSE_BYTES)
          throw new Error('response size limit')
        if (logs.length >= LOG_SPLIT_THRESHOLD) throw new Error('result limit')
        responses.push({ kind, logs })
      }
    } catch (error) {
      if (!splittable(error)) throw error
      if (from === to) throw new Error('entrant_ambiguous_singleton')
      const mid = Math.floor((from + to) / 2)
      await range(from, mid)
      if (appended < maxChunks) await range(mid + 1, to)
      return
    }
    let peerResponses = null
    if (peerRpc) {
      try {
        peerResponses = []
        for (const kind of STREAMS) {
          const logs = await peerRpc('eth_getLogs', query(kind, from, to))
          if (!Array.isArray(logs) || Buffer.byteLength(JSON.stringify(logs)) > MAX_RESPONSE_BYTES)
            throw new Error('response size limit')
          if (logs.length >= LOG_SPLIT_THRESHOLD) throw new Error('result limit')
          peerResponses.push({ kind, logs })
        }
      } catch (error) {
        if (!splittable(error)) throw error
        if (from === to) throw new Error('entrant_ambiguous_singleton')
        const mid = Math.floor((from + to) / 2)
        await range(from, mid)
        if (appended < maxChunks) await range(mid + 1, to)
        return
      }
    }
    const fromHeader = parseHeader(await rpc('eth_getBlockByNumber', [hex(from), false]), from)
    const toHeader =
      from === to
        ? fromHeader
        : parseHeader(await rpc('eth_getBlockByNumber', [hex(to), false]), to)
    if (state.frontierHash && fromHeader.parentHash !== state.frontierHash)
      throw new Error('entrant_noncontiguous_chain')
    let peerFromHeader = null
    let peerToHeader = null
    if (peerRpc) {
      peerFromHeader = parseHeader(await peerRpc('eth_getBlockByNumber', [hex(from), false]), from)
      peerToHeader =
        from === to
          ? peerFromHeader
          : parseHeader(await peerRpc('eth_getBlockByNumber', [hex(to), false]), to)
      if (peerFromHeader.hash !== fromHeader.hash || peerToHeader.hash !== toHeader.hash)
        throw new Error('entrant_peer_boundary_mismatch')
    }
    const logs = responses.flatMap(({ kind, logs: raw }) =>
      raw.map((entry) => normalizeLog(entry, kind, from, to)),
    )
    logs.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)
    let peerLogsDigest = null
    if (peerResponses) {
      const peerLogs = peerResponses.flatMap(({ kind, logs: raw }) =>
        raw.map((entry) => normalizeLog(entry, kind, from, to)),
      )
      peerLogs.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)
      if (JSON.stringify(peerLogs) !== JSON.stringify(logs))
        throw new Error('entrant_peer_logs_mismatch')
      peerLogsDigest = sha(JSON.stringify(peerLogs))
    }
    const seen = new Set()
    for (const log of logs) {
      const id = `${log.transactionHash}:${log.logIndex}`
      if (seen.has(id)) throw new Error('entrant_duplicate_log')
      seen.add(id)
    }
    const headers = new Map([
      [from, fromHeader],
      [to, toHeader],
    ])
    for (const number of new Set(logs.map((log) => log.blockNumber))) {
      if (!headers.has(number))
        headers.set(
          number,
          parseHeader(await rpc('eth_getBlockByNumber', [hex(number), false]), number),
        )
    }
    for (const log of logs) {
      if (log.blockHash !== headers.get(log.blockNumber).hash)
        throw new Error('entrant_noncanonical_log')
    }
    const observedAt = now().toISOString()
    const segment = {
      schemaVersion: peerRpc ? 3 : 1,
      config: config(),
      fromBlock: from,
      toBlock: to,
      fromHeader,
      toHeader,
      finalizedHead: finalized.number,
      finalizedHeadHash: finalized.hash,
      firstObservedAt: observedAt,
      ...(peerRpc
        ? {
            peerWitness: {
              confirmedAt: observedAt,
              fromHash: peerFromHeader.hash,
              toHash: peerToHeader.hash,
              finalizedHead: finalized.number,
              finalizedHeadHash: finalized.hash,
              normalizedLogsSha256: peerLogsDigest,
              scans: peerResponses.map(({ kind, logs: raw }) => ({
                kind,
                rawCount: raw.length,
              })),
            },
          }
        : {}),
      captureLagSeconds: Math.floor(Date.parse(observedAt) / 1000) - toHeader.timestamp,
      scans: responses.map(({ kind, logs: raw }) => ({
        kind,
        fromBlock: from,
        toBlock: to,
        rawCount: raw.length,
      })),
      logBlockHeaders: [...headers.values()].sort((a, b) => a.number - b.number),
      logs,
    }
    try {
      appendSegment(out, segment, stat)
    } catch (error) {
      if (error.message !== 'entrant_segment_size_cap' || from === to) throw error
      const mid = Math.floor((from + to) / 2)
      await range(from, mid)
      if (appended < maxChunks) await range(mid + 1, to)
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
  while (appended < maxChunks && state.throughBlock < finalized.number) {
    const from = state.throughBlock + 1
    await range(from, Math.min(finalized.number, from + CHUNK_BLOCKS - 1))
  }
  return {
    ...verify({ out, fromBlock }),
    finalizedHead: finalized.number,
    appended,
    rpcCalls: calls,
  }
}

function parseArgs(args) {
  let mode = null,
    fromBlock = null,
    maxChunks = 1,
    out = DEFAULT_OUT
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--run' || args[i] === '--verify') mode = args[i]
    else if (args[i] === '--from-block') fromBlock = Number(args[++i])
    else if (args[i] === '--max-chunks') maxChunks = Number(args[++i])
    else if (args[i] === '--out') out = resolve(args[++i])
    else throw new Error('Usage: --run|--verify --from-block N [--max-chunks 1..4] [--out DIR]')
  }
  if (!mode || !Number.isSafeInteger(fromBlock) || fromBlock < 0)
    throw new Error('explicit --run|--verify and --from-block N required')
  return { mode, fromBlock, maxChunks, out }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.mode === '--verify') return verify(args)
  const { get } = readEnv()
  const url =
    process.env.RECORDER_RPC_URLS ||
    process.env.RECORDER_RPC_URL ||
    get('RECORDER_RPC_URLS') ||
    get('RECORDER_RPC_URL')
  if (!url) throw new Error('recorder_rpc_required')
  const urls = String(url)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  const chosen = []
  const hosts = new Set()
  for (const candidate of urls) {
    if (chosen.length === 2) break
    try {
      const host = new URL(candidate).hostname
      if (hosts.has(host)) continue
      assertDiskFloor(args.out)
      const client = makeClient(candidate)
      if ((await client.getChainId()) !== 1) continue
      const head = await client.getBlock({ blockTag: 'finalized' })
      const from = Math.max(0, Number(head.number) - CHUNK_BLOCKS + 1)
      let suitable = true
      for (const kind of STREAMS) {
        const logs = await client.request({
          method: 'eth_getLogs',
          params: query(kind, from, Number(head.number)),
        })
        if (
          !Array.isArray(logs) ||
          logs.length >= LOG_SPLIT_THRESHOLD ||
          Buffer.byteLength(JSON.stringify(logs)) > MAX_RESPONSE_BYTES
        ) {
          suitable = false
          break
        }
      }
      if (suitable) {
        chosen.push(client)
        hosts.add(host)
      }
    } catch {
      // Health probe failures may contain credential-bearing URLs; do not log.
    }
  }
  if (chosen.length !== 2) throw new Error('entrant_two_healthy_rpc_hosts_required')
  const [primary, peer] = chosen
  const safeRpc = (client, side) => async (method, params) => {
    try {
      return await client.request({ method, params })
    } catch (error) {
      const reason = splittable(error)
        ? 'range_limit'
        : /rate limit|quota|429/i.test(String(error?.message))
          ? 'rate_limit'
          : 'failed'
      throw new Error(`entrant_${side}_${method}_${reason}`)
    }
  }
  return collect({
    ...args,
    rpcRead: safeRpc(primary, 'primary'),
    peerRpcRead: safeRpc(peer, 'peer'),
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      // RPC clients can include credential-bearing URLs in error messages.
      const safeCode = /^[a-z][a-z0-9_]+$/.test(String(error?.message))
        ? error.message
        : 'entrant_rpc_or_provider_failure'
      process.stderr.write(`${safeCode}\n`)
      process.exitCode = 1
    })
}
