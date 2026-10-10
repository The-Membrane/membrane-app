// Contiguous sealed share-side Transfer responses, not independently proven log-complete,
// route attribution, or current TVL.
// Dry by default. --run makes live RPC reads from two configured hosts;
// --verify replays local immutable segments without RPC.
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
import { keccak256 } from 'viem'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'

export const TOKENS = Object.freeze({
  sGHO: '0xe1753f2e00940cc31213dd92013cf019dfe4ca1d',
  sUSDe: '0x9d39a5de30e57443bff2a8307a4256c8797a3497',
})
export const TRANSFER_TOPIC = keccak256(
  new TextEncoder().encode('Transfer(address,address,uint256)'),
)
export const MIN_FREE_BYTES = 1_073_741_824
export const CHUNK_BLOCKS = 1_000
export const MAX_CHUNKS = 4
export const MAX_LOGS = 5_000
export const MAX_RPC_CALLS = 512
export const MAX_LOG_BLOCK_HEADERS = 64
export const DEFAULT_PACE_MS = 250
const LOCK = '.share-transfer-source.lock'
const HASH = /^0x[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const FILE = /^(\d{12})-(\d{12})-([a-f0-9]{64})\.json$/
const ZERO = `0x${'0'.repeat(40)}`
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const hex = (n) => `0x${BigInt(n).toString(16)}`
const fail = (name) => {
  throw new Error(`share_source_${name}`)
}
const lower = (value) => String(value).toLowerCase()
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

// Keep endpoint URLs in memory only. Never put a URL (which may contain a key)
// into a diagnostic, artifact, or CLI result.
export function selectRpcUrls(raw, selectedHosts) {
  if (raw === undefined || raw === null || raw === '') fail('two_rpc_hosts_required')
  const configured = String(raw ?? '').split(',')
  if (configured.some((entry) => !entry.trim())) fail('rpc_config_invalid')
  const byHost = new Map()
  for (const entry of configured) {
    const url = entry.trim()
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      fail('rpc_config_invalid')
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname)
      fail('rpc_config_invalid')
    const host = parsed.hostname.toLowerCase()
    if (byHost.has(host)) fail('rpc_host_ambiguous')
    byHost.set(host, url)
  }
  if (selectedHosts === undefined) {
    if (byHost.size !== 2) fail('two_rpc_hosts_required')
    return [...byHost.values()]
  }
  const requested = selectedHosts.split(',').map((host) => host.trim().toLowerCase())
  if (
    requested.length !== 2 ||
    requested.some((host) => !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)) ||
    requested[0] === requested[1]
  )
    fail('rpc_host_selection_invalid')
  if (!requested.every((host) => byHost.has(host))) fail('rpc_host_missing')
  return requested.map((host) => byHost.get(host))
}

// Provider errors may contain credential-bearing URLs and raw response bodies.
// Inspect a bounded cause chain only to choose one of these fixed output codes.
function rpcFailureKind(error, stage) {
  let current = error
  let fallback = 'failure'
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    let message
    let status
    let code
    let name
    let cause
    let transportType
    try {
      message = [current.message, current.shortMessage, current.details]
        .filter((part) => typeof part === 'string')
        .join(' ')
        .toLowerCase()
      status = current.status ?? current.statusCode
      code = current.code
      name = current.name
      cause = current.cause
      transportType = current instanceof TypeError
    } catch {
      return fallback
    }
    if (
      status === 429 ||
      code === 429 ||
      code === -32005 ||
      /(?:http (?:status|error|response)(?: code)?[: ]+429|\brate limit(?:ed| exceeded)?\b|\btoo many requests\b)/.test(
        message,
      )
    )
      return 'rate_limited'
    if (stage === 'code') {
      if (
        /missing trie node|historical state (?:is )?(?:unavailable|not available)|state (?:is )?(?:pruned|unavailable|not available)|archive (?:node|data) (?:is )?(?:required|unavailable)/.test(
          message,
        )
      )
        fallback = 'historical_state_unavailable'
      else if (
        /(?:blockhash|block hash).{0,80}(?:unsupported|not supported|invalid)|(?:unsupported|not supported|invalid).{0,80}(?:blockhash|block hash)|cannot unmarshal object.{0,80}block/.test(
          message,
        )
      )
        fallback = 'block_reference_unsupported'
    }
    if (
      fallback === 'failure' &&
      (transportType ||
        /^(?:HttpRequestError|TimeoutError|NetworkError|SocketError)$/.test(name) ||
        /^(?:ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|UND_ERR_CONNECT_TIMEOUT)$/.test(
          code,
        ))
    )
      fallback = 'transport_failure'
    current = cause
  }
  return fallback
}

function acquireLock(out) {
  mkdirSync(out, { recursive: true })
  const path = join(out, LOCK)
  let fd
  try {
    fd = openSync(path, 'wx', 0o600)
  } catch {
    fail('lock_held')
  }
  const token = randomUUID()
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token }))
    fsyncSync(fd)
  } catch {
    closeSync(fd)
    unlinkSync(path)
    fail('lock_write_failed')
  }
  closeSync(fd)
  return () => {
    let owner
    try {
      owner = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      fail('lock_release_unproven')
    }
    if (owner.token !== token) fail('lock_release_unproven')
    unlinkSync(path)
  }
}

function number(value) {
  try {
    const n = Number(BigInt(value))
    if (Number.isSafeInteger(n) && n >= 0) return n
  } catch {
    /* invalid */
  }
  fail('integer_invalid')
}

function header(raw, at) {
  const value = {
    number: number(raw?.number),
    hash: lower(raw?.hash),
    parentHash: lower(raw?.parentHash),
    timestamp: number(raw?.timestamp),
  }
  if (
    (at !== undefined && value.number !== at) ||
    !HASH.test(value.hash) ||
    !HASH.test(value.parentHash)
  )
    fail('header_invalid')
  return value
}

export function checkDisk(out, stat = statfsSync, bytes = 0) {
  let path = out
  while (!existsSync(path) && dirname(path) !== path) path = dirname(path)
  const space = stat(path)
  if (Number(space.bavail) * Number(space.bsize) - bytes < MIN_FREE_BYTES)
    fail('disk_reserve_reached')
}

function seal(out, record, stat) {
  const bytes = Buffer.from(JSON.stringify(record))
  if (bytes.length > 2_000_000) fail('segment_size_cap')
  checkDisk(out, stat, bytes.length)
  mkdirSync(out, { recursive: true })
  const name = `${String(record.fromBlock).padStart(12, '0')}-${String(record.toBlock).padStart(12, '0')}-${sha(bytes)}.json`
  const path = join(out, name)
  const temp = `${path}.${randomUUID()}.tmp`
  let fd
  try {
    fd = openSync(temp, 'wx', 0o600)
    let offset = 0
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset)
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    linkSync(temp, path)
  } finally {
    if (fd !== undefined && fd !== null) closeSync(fd)
    if (existsSync(temp)) unlinkSync(temp)
  }
  return { name, sha256: sha(bytes) }
}

function deployment(config) {
  if (
    !TOKENS[config?.token] ||
    config.address !== TOKENS[config.token] ||
    !Number.isSafeInteger(config.deploymentBlock) ||
    config.deploymentBlock < 1 ||
    !Number.isSafeInteger(config.startBlock) ||
    config.startBlock < config.deploymentBlock ||
    config.chainId !== 1
  )
    fail('config_invalid')
}

function normalizeLog(log, config, from, to) {
  if (
    lower(log?.address) !== config.address ||
    !Array.isArray(log?.topics) ||
    log.topics.length !== 3 ||
    lower(log.topics[0]) !== TRANSFER_TOPIC ||
    !HASH.test(lower(log.blockHash)) ||
    !HASH.test(lower(log.transactionHash)) ||
    !/^0x[0-9a-f]{64}$/.test(lower(log.data))
  )
    fail('log_invalid')
  const blockNumber = number(log.blockNumber)
  const logIndex = number(log.logIndex)
  if (blockNumber < from || blockNumber > to) fail('log_range_invalid')
  for (const topic of log.topics.slice(1))
    if (!/^0x0{24}[0-9a-f]{40}$/.test(lower(topic))) fail('log_address_invalid')
  const recipient = `0x${lower(log.topics[2]).slice(-40)}`
  return {
    blockNumber,
    blockHash: lower(log.blockHash),
    transactionHash: lower(log.transactionHash),
    logIndex,
    recipient,
    valueRaw: BigInt(log.data).toString(),
  }
}

function validateSegment(segment, config, prior, name) {
  const bytes = Buffer.from(JSON.stringify(segment))
  if (
    name !==
      `${String(segment.fromBlock).padStart(12, '0')}-${String(segment.toBlock).padStart(12, '0')}-${sha(bytes)}.json` ||
    segment.schemaVersion !== 1 ||
    JSON.stringify(segment.config) !== JSON.stringify(config) ||
    segment.fromBlock !== prior.throughBlock + 1 ||
    segment.toBlock < segment.fromBlock ||
    segment.toBlock - segment.fromBlock >= CHUNK_BLOCKS ||
    segment.fromHeader?.number !== segment.fromBlock ||
    segment.toHeader?.number !== segment.toBlock ||
    !HASH.test(segment.fromHeader.hash) ||
    !HASH.test(segment.toHeader.hash) ||
    (prior.frontierHash && segment.fromHeader.parentHash !== prior.frontierHash) ||
    segment.deploymentProof?.priorBlock !== config.deploymentBlock - 1 ||
    segment.deploymentProof?.deploymentBlock !== config.deploymentBlock ||
    !HASH.test(segment.deploymentProof?.priorHash) ||
    !HASH.test(segment.deploymentProof?.deploymentHash) ||
    segment.deploymentProof?.priorCode !== '0x' ||
    !HASH.test(segment.deploymentProof?.deploymentCodeHash) ||
    !Number.isSafeInteger(segment.finalizedHead) ||
    segment.finalizedHead < segment.toBlock ||
    !HASH.test(segment.finalizedHeadHash) ||
    !Array.isArray(segment.logs) ||
    segment.logs.length >= MAX_LOGS ||
    !Array.isArray(segment.logBlockHeaders) ||
    segment.logBlockHeaders.length > MAX_LOG_BLOCK_HEADERS ||
    segment.providerAgreement !== true ||
    !Number.isFinite(Date.parse(segment.firstObservedAt))
  )
    fail('segment_invalid')
  if (segment.fromBlock === segment.toBlock && segment.fromHeader.hash !== segment.toHeader.hash)
    fail('header_mismatch')
  if (
    segment.fromBlock === config.deploymentBlock &&
    (segment.fromHeader.hash !== segment.deploymentProof.deploymentHash ||
      segment.fromHeader.parentHash !== segment.deploymentProof.priorHash)
  )
    fail('deployment_header_mismatch')
  const seen = new Set()
  const headerBlocks = new Set()
  const pinned = new Map([
    [segment.fromBlock, segment.fromHeader.hash],
    [segment.toBlock, segment.toHeader.hash],
  ])
  for (const h of segment.logBlockHeaders) {
    if (
      !Number.isSafeInteger(h.number) ||
      h.number < segment.fromBlock ||
      h.number > segment.toBlock ||
      !HASH.test(h.hash) ||
      headerBlocks.has(h.number) ||
      (pinned.has(h.number) && pinned.get(h.number) !== h.hash)
    )
      fail('log_header_invalid')
    headerBlocks.add(h.number)
    pinned.set(h.number, h.hash)
  }
  for (const log of segment.logs) {
    const key = `${log.blockNumber}:${log.transactionHash}:${log.logIndex}`
    if (
      seen.has(key) ||
      !pinned.has(log.blockNumber) ||
      pinned.get(log.blockNumber) !== log.blockHash ||
      !ADDRESS.test(log.recipient) ||
      !/^(0|[1-9]\d*)$/.test(log.valueRaw)
    )
      fail('log_replay_invalid')
    seen.add(key)
  }
  const candidates = [
    ...new Set(segment.logs.filter((v) => v.recipient !== ZERO).map((v) => v.recipient)),
  ].sort()
  if (JSON.stringify(candidates) !== JSON.stringify(segment.candidateRecipients))
    fail('candidate_replay_invalid')
  return { throughBlock: segment.toBlock, frontierHash: segment.toHeader.hash }
}

export function verify({ out, config }) {
  deployment(config)
  const names = existsSync(out) ? readdirSync(out).sort() : []
  if (names.some((n) => n !== LOCK && !FILE.test(n))) fail('unrecognized_artifact')
  let prior = { throughBlock: config.startBlock - 1, frontierHash: null }
  const candidates = new Set()
  const segments = []
  let proofHash = null
  for (const name of names) {
    if (name === LOCK) continue
    const bytes = readFileSync(join(out, name))
    if (sha(bytes) !== FILE.exec(name)[3]) fail('hash_mismatch')
    let segment
    try {
      segment = JSON.parse(bytes)
    } catch {
      fail('json_invalid')
    }
    prior = validateSegment(segment, config, prior, name)
    const currentProof = sha(JSON.stringify(segment.deploymentProof))
    if (proofHash && proofHash !== currentProof) fail('deployment_proof_changed')
    proofHash = currentProof
    for (const address of segment.candidateRecipients) candidates.add(address)
    segments.push({ name, sha256: sha(bytes) })
  }
  return {
    ...prior,
    segments,
    deploymentProofSha256: proofHash,
    contiguousFromDeployment: config.startBlock === config.deploymentBlock && segments.length > 0,
    logCompleteness: 'not_independently_proven',
    candidateRecipients: [...candidates].sort(),
  }
}

export async function collect({
  out,
  config,
  rpcRead,
  peerRpcRead,
  maxChunks = 1,
  windowBlocks = CHUNK_BLOCKS,
  paceMs = 0,
  stat = statfsSync,
  now = () => new Date(),
}) {
  deployment(config)
  if (
    typeof rpcRead !== 'function' ||
    typeof peerRpcRead !== 'function' ||
    !Number.isInteger(maxChunks) ||
    maxChunks < 1 ||
    maxChunks > MAX_CHUNKS ||
    !Number.isInteger(windowBlocks) ||
    windowBlocks < 1 ||
    windowBlocks > CHUNK_BLOCKS ||
    !Number.isInteger(paceMs) ||
    paceMs < 0 ||
    paceMs > 5_000
  )
    fail('reader_or_bound_invalid')
  checkDisk(out, stat)
  const releaseLock = acquireLock(out)
  try {
    let calls = 0
    const read = async (reader, side, stage, method, params) => {
      checkDisk(out, stat)
      if (++calls > MAX_RPC_CALLS) fail('request_budget_exceeded')
      if (paceMs > 0 && calls > 1) await sleep(paceMs)
      try {
        return await reader(method, params)
      } catch (error) {
        fail(`rpc_${side}_${stage}_${rpcFailureKind(error, stage)}`)
      }
    }
    if (
      number(await read(rpcRead, 'primary', 'chain', 'eth_chainId', [])) !== 1 ||
      number(await read(peerRpcRead, 'peer', 'chain', 'eth_chainId', [])) !== 1
    )
      fail('chain_invalid')
    const head = header(
      await read(rpcRead, 'primary', 'head', 'eth_getBlockByNumber', ['finalized', false]),
    )
    const peerHead = header(
      await read(peerRpcRead, 'peer', 'head', 'eth_getBlockByNumber', ['finalized', false]),
    )
    const common = Math.min(head.number, peerHead.number)
    if (common < config.deploymentBlock) fail('deployment_not_finalized')
    const at = async (reader, side, block) =>
      header(await read(reader, side, 'header', 'eth_getBlockByNumber', [hex(block), false]), block)
    const primaryAt = (block) => at(rpcRead, 'primary', block)
    const peerAt = (block) => at(peerRpcRead, 'peer', block)
    const commonHeader = await primaryAt(common)
    if ((await peerAt(common)).hash !== commonHeader.hash) fail('provider_head_mismatch')
    const state = verify({ out, config })
    if (state.throughBlock > common) fail('frontier_ahead')
    if (
      state.frontierHash &&
      ((await primaryAt(state.throughBlock)).hash !== state.frontierHash ||
        (await peerAt(state.throughBlock)).hash !== state.frontierHash)
    )
      fail('frontier_reorg')
    const priorHeader = await primaryAt(config.deploymentBlock - 1)
    const deploymentHeader = await primaryAt(config.deploymentBlock)
    if (
      deploymentHeader.parentHash !== priorHeader.hash ||
      (await peerAt(config.deploymentBlock - 1)).hash !== priorHeader.hash ||
      (await peerAt(config.deploymentBlock)).hash !== deploymentHeader.hash
    )
      fail('deployment_header_mismatch')
    const priorPin = { blockHash: priorHeader.hash, requireCanonical: true }
    const deploymentPin = { blockHash: deploymentHeader.hash, requireCanonical: true }
    const priorCode = lower(
      await read(rpcRead, 'primary', 'code', 'eth_getCode', [config.address, priorPin]),
    )
    const code = lower(
      await read(rpcRead, 'primary', 'code', 'eth_getCode', [config.address, deploymentPin]),
    )
    const peerPrior = lower(
      await read(peerRpcRead, 'peer', 'code', 'eth_getCode', [config.address, priorPin]),
    )
    const peerCode = lower(
      await read(peerRpcRead, 'peer', 'code', 'eth_getCode', [config.address, deploymentPin]),
    )
    if (
      (await primaryAt(config.deploymentBlock - 1)).hash !== priorHeader.hash ||
      (await primaryAt(config.deploymentBlock)).hash !== deploymentHeader.hash ||
      (await peerAt(config.deploymentBlock - 1)).hash !== priorHeader.hash ||
      (await peerAt(config.deploymentBlock)).hash !== deploymentHeader.hash
    )
      fail('deployment_header_reorg')
    if (
      priorCode !== '0x' ||
      peerPrior !== '0x' ||
      !/^0x[0-9a-f]+$/.test(code) ||
      code === '0x' ||
      code.length % 2 !== 0 ||
      code !== peerCode
    )
      fail('deployment_code_invalid')
    const deploymentProof = {
      priorBlock: config.deploymentBlock - 1,
      deploymentBlock: config.deploymentBlock,
      priorHash: priorHeader.hash,
      deploymentHash: deploymentHeader.hash,
      priorCode,
      deploymentCodeHash: keccak256(code),
    }
    if (
      state.deploymentProofSha256 &&
      state.deploymentProofSha256 !== sha(JSON.stringify(deploymentProof))
    )
      fail('deployment_identity_changed')
    let frontier = state.throughBlock
    let frontierHash = state.frontierHash
    const added = []
    for (let i = 0; i < maxChunks && frontier < common; i++) {
      const fromBlock = frontier + 1
      const toBlock = Math.min(common, fromBlock + windowBlocks - 1)
      const fromHeader = await primaryAt(fromBlock)
      const toHeader = await primaryAt(toBlock)
      if (
        (frontierHash && fromHeader.parentHash !== frontierHash) ||
        (await peerAt(fromBlock)).hash !== fromHeader.hash ||
        (await peerAt(toBlock)).hash !== toHeader.hash
      )
        fail('range_reorg')
      const params = [
        {
          address: config.address,
          fromBlock: hex(fromBlock),
          toBlock: hex(toBlock),
          topics: [TRANSFER_TOPIC],
        },
      ]
      const raw = await read(rpcRead, 'primary', 'logs', 'eth_getLogs', params)
      const peer = await read(peerRpcRead, 'peer', 'logs', 'eth_getLogs', params)
      if (
        !Array.isArray(raw) ||
        !Array.isArray(peer) ||
        raw.length >= MAX_LOGS ||
        peer.length >= MAX_LOGS ||
        Buffer.byteLength(JSON.stringify(raw)) > 1_000_000 ||
        Buffer.byteLength(JSON.stringify(peer)) > 1_000_000
      )
        fail('log_bound_invalid')
      const logs = raw.map((l) => normalizeLog(l, config, fromBlock, toBlock))
      const peers = peer.map((l) => normalizeLog(l, config, fromBlock, toBlock))
      const sort = (a, b) =>
        a.blockNumber - b.blockNumber ||
        a.logIndex - b.logIndex ||
        a.transactionHash.localeCompare(b.transactionHash)
      logs.sort(sort)
      peers.sort(sort)
      if (JSON.stringify(logs) !== JSON.stringify(peers)) fail('provider_logs_mismatch')
      const blocks = [...new Set(logs.map((l) => l.blockNumber))].sort((a, b) => a - b)
      if (blocks.length > MAX_LOG_BLOCK_HEADERS) fail('log_header_budget_exceeded')
      const logBlockHeaders = []
      for (const block of blocks) {
        const h = await primaryAt(block)
        if (
          h.hash !== (await peerAt(block)).hash ||
          logs.some((l) => l.blockNumber === block && l.blockHash !== h.hash)
        )
          fail('log_block_reorg')
        logBlockHeaders.push({ number: block, hash: h.hash })
      }
      const recanonical = await primaryAt(toBlock)
      if (recanonical.hash !== toHeader.hash || (await peerAt(toBlock)).hash !== toHeader.hash)
        fail('range_reorg')
      const segment = {
        schemaVersion: 1,
        config,
        deploymentProof,
        fromBlock,
        toBlock,
        fromHeader,
        toHeader,
        finalizedHead: common,
        finalizedHeadHash: commonHeader.hash,
        providerAgreement: true,
        firstObservedAt: now().toISOString(),
        logBlockHeaders,
        logs,
        candidateRecipients: [
          ...new Set(logs.filter((l) => l.recipient !== ZERO).map((l) => l.recipient)),
        ].sort(),
      }
      const candidateBytes = Buffer.from(JSON.stringify(segment))
      const candidateName = `${String(fromBlock).padStart(12, '0')}-${String(toBlock).padStart(12, '0')}-${sha(candidateBytes)}.json`
      validateSegment(segment, config, { throughBlock: frontier, frontierHash }, candidateName)
      const named = seal(out, segment, stat)
      added.push(named)
      frontier = toBlock
      frontierHash = toHeader.hash
    }
    return { ...verify({ out, config }), added }
  } finally {
    releaseLock()
  }
}

function parseArgs(argv) {
  let mode = null
  const options = {}
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i]
    if (item === '--run' || item === '--verify') {
      if (mode) fail('cli_invalid')
      mode = item
    } else if (
      [
        '--token',
        '--deployment-block',
        '--start-block',
        '--out',
        '--max-chunks',
        '--window-blocks',
        '--pace-ms',
        '--rpc-hosts',
      ].includes(item)
    ) {
      if (options[item] !== undefined || !argv[i + 1]) fail('cli_invalid')
      options[item] = argv[++i]
    } else fail('cli_invalid')
  }
  if (!mode || !options['--token'] || !options['--deployment-block'] || !options['--out'])
    fail('cli_invalid')
  const config = {
    chainId: 1,
    token: options['--token'],
    address: TOKENS[options['--token']],
    deploymentBlock: Number(options['--deployment-block']),
    startBlock: Number(options['--start-block'] ?? options['--deployment-block']),
  }
  deployment(config)
  const maxChunks = Number(options['--max-chunks'] ?? 1)
  if (!Number.isInteger(maxChunks) || maxChunks < 1 || maxChunks > MAX_CHUNKS) fail('cli_invalid')
  const windowBlocks = Number(options['--window-blocks'] ?? CHUNK_BLOCKS)
  const paceMs = Number(options['--pace-ms'] ?? DEFAULT_PACE_MS)
  if (
    !Number.isInteger(windowBlocks) ||
    windowBlocks < 1 ||
    windowBlocks > CHUNK_BLOCKS ||
    !Number.isInteger(paceMs) ||
    paceMs < 0 ||
    paceMs > 5_000
  )
    fail('cli_invalid')
  return {
    mode,
    out: resolve(options['--out']),
    config,
    maxChunks,
    windowBlocks,
    paceMs,
    rpcHosts: options['--rpc-hosts'],
  }
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const args = parseArgs(argv)
  if (args.mode === '--verify') return verify(args)
  if (dependencies.rpcRead && dependencies.peerRpcRead) return collect({ ...args, ...dependencies })
  const env = dependencies.env ?? readEnv()
  const raw =
    dependencies.rpcUrls ??
    (dependencies.env ? undefined : process.env.RECORDER_RPC_URLS) ??
    env.get('RECORDER_RPC_URLS') ??
    (dependencies.env ? undefined : process.env.RECORDER_RPC_URL) ??
    env.get('RECORDER_RPC_URL')
  const urls = selectRpcUrls(raw, args.rpcHosts)
  const factory = dependencies.makeClient ?? makeClient
  const readers = urls.map((url) => {
    try {
      const client = factory(url)
      return (method, params) => client.request({ method, params })
    } catch {
      fail('rpc_config_invalid')
    }
  })
  checkDisk(args.out, dependencies.stat ?? statfsSync)
  return collect({
    ...args,
    rpcRead: readers[0],
    peerRpcRead: readers[1],
    stat: dependencies.stat ?? statfsSync,
    now: dependencies.now ?? (() => new Date()),
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (result) =>
      process.stdout.write(
        `${JSON.stringify({
          throughBlock: result.throughBlock,
          frontierHash: result.frontierHash,
          segmentCount: result.segments.length,
          candidateCount: result.candidateRecipients.length,
          contiguousFromDeployment: result.contiguousFromDeployment,
          logCompleteness: result.logCompleteness,
          addedSegments: result.added?.length ?? 0,
        })}\n`,
      ),
    (error) => {
      process.stderr.write(
        `${String(error.message).startsWith('share_source_') ? error.message : 'share_source_failure'}\n`,
      )
      process.exitCode = 1
    },
  )
}
