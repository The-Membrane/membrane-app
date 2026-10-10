// Research-only sGHO proxy Upgraded(address) event journal. An event-only
// history cannot rule out direct EIP-1967 slot writes or unlogged delegatecalls.
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
import { selectRpcUrls } from './share-transfer-source.mjs'

export const PROXY = '0xe1753f2e00940cc31213dd92013cf019dfe4ca1d'
export const DEPLOYMENT_BLOCK = 25_028_623
export const DEFAULT_TARGET = Object.freeze({
  block: 26_074_702,
  hash: '0x4c70f28a508cc76b25d9a2a0b9aa2d9e91164d214756893344025977c5e1dfcf',
})
export const UPGRADED_TOPIC = keccak256(new TextEncoder().encode('Upgraded(address)'))
export const MIN_FREE_BYTES = 1_073_741_824
export const MAX_CHUNKS = 4
export const CHUNK_BLOCKS = 5_000
const MAX_CALLS = 100
const MAX_LOGS = 128
const MAX_BYTES = 250_000
const LOCK = '.sgho-upgrade-history.lock'
const HASH = /^0x[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const FILE = /^(\d{12})-(\d{12})-([a-f0-9]{64})\.json$/
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const lower = (v) => String(v).toLowerCase()
const hex = (n) => `0x${n.toString(16)}`
const fail = (code) => {
  throw new Error(`sgho_upgrade_${code}`)
}
const integer = (v) => {
  try {
    const n = Number(BigInt(v))
    if (Number.isSafeInteger(n) && n >= 0) return n
  } catch {
    /* invalid */
  }
  fail('integer_invalid')
}

function validateTarget(target) {
  if (
    !Number.isSafeInteger(target?.block) ||
    target.block < DEPLOYMENT_BLOCK ||
    !HASH.test(target.hash)
  )
    fail('target_invalid')
}

function header(raw, block) {
  const value = {
    number: integer(raw?.number),
    hash: lower(raw?.hash),
    parentHash: lower(raw?.parentHash),
  }
  if (value.number !== block || !HASH.test(value.hash) || !HASH.test(value.parentHash))
    fail('header_invalid')
  return value
}

export function checkDisk(out, stat = statfsSync, pending = 0) {
  let path = out
  while (!existsSync(path) && dirname(path) !== path) path = dirname(path)
  const space = stat(path)
  if (Number(space.bavail) * Number(space.bsize) - pending < MIN_FREE_BYTES)
    fail('disk_reserve_reached')
}

function lock(out) {
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
    writeSync(fd, JSON.stringify({ token, pid: process.pid }))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  return () => {
    let current
    try {
      current = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      fail('lock_release_unproven')
    }
    if (current.token !== token) fail('lock_release_unproven')
    unlinkSync(path)
  }
}

function normalizeLog(raw, from, to) {
  const blockNumber = integer(raw?.blockNumber)
  const logIndex = integer(raw?.logIndex)
  const topic = lower(raw?.topics?.[1])
  const result = {
    blockNumber,
    blockHash: lower(raw?.blockHash),
    transactionHash: lower(raw?.transactionHash),
    logIndex,
    implementation: `0x${topic.slice(-40)}`,
  }
  if (
    lower(raw?.address) !== PROXY ||
    !Array.isArray(raw?.topics) ||
    raw.topics.length !== 2 ||
    lower(raw.topics[0]) !== UPGRADED_TOPIC ||
    !/^0x0{24}[0-9a-f]{40}$/.test(topic) ||
    !ADDRESS.test(result.implementation) ||
    raw.data !== '0x' ||
    blockNumber < from ||
    blockNumber > to ||
    !HASH.test(result.blockHash) ||
    !HASH.test(result.transactionHash) ||
    raw.removed === true
  )
    fail('log_invalid')
  return result
}

function canonicalLogs(logs) {
  const seen = new Set()
  let lastBlock = -1
  let lastIndex = -1
  for (const log of logs) {
    const key = `${log.transactionHash}:${log.logIndex}`
    if (
      seen.has(key) ||
      log.blockNumber < lastBlock ||
      (log.blockNumber === lastBlock && log.logIndex <= lastIndex)
    )
      fail('log_order_invalid')
    seen.add(key)
    lastBlock = log.blockNumber
    lastIndex = log.logIndex
  }
}

function nameOf(record) {
  return `${String(record.fromBlock).padStart(12, '0')}-${String(record.toBlock).padStart(12, '0')}-${sha(JSON.stringify(record))}.json`
}

function validateSegment(segment, target, previous, name) {
  if (
    segment.schemaVersion !== 1 ||
    segment.chainId !== 1 ||
    segment.proxy !== PROXY ||
    segment.deploymentBlock !== DEPLOYMENT_BLOCK ||
    JSON.stringify(segment.target) !== JSON.stringify(target) ||
    nameOf(segment) !== name ||
    segment.fromBlock !== previous.block + 1 ||
    !Number.isSafeInteger(segment.toBlock) ||
    segment.toBlock < segment.fromBlock ||
    segment.toBlock > target.block ||
    segment.toBlock - segment.fromBlock >= CHUNK_BLOCKS ||
    segment.fromHeader?.number !== segment.fromBlock ||
    segment.toHeader?.number !== segment.toBlock ||
    !HASH.test(segment.fromHeader.hash) ||
    !HASH.test(segment.fromHeader.parentHash) ||
    !HASH.test(segment.toHeader.hash) ||
    !HASH.test(segment.toHeader.parentHash) ||
    (previous.hash && segment.fromHeader.parentHash !== previous.hash) ||
    (segment.fromBlock === segment.toBlock && segment.fromHeader.hash !== segment.toHeader.hash) ||
    (segment.toBlock === target.block && segment.toHeader.hash !== target.hash) ||
    segment.finalizedHead < target.block ||
    !HASH.test(segment.finalizedHeadHash) ||
    segment.providerAgreement !== true ||
    !Number.isFinite(Date.parse(segment.firstObservedAt)) ||
    segment.logCompleteness !== 'not_independently_proven' ||
    segment.interiorAncestry !== 'unproven_between_sparse_pins' ||
    segment.slotWriteCoverage !== 'event_only' ||
    !Array.isArray(segment.logs) ||
    segment.logs.length > MAX_LOGS ||
    !Array.isArray(segment.logBlockHeaders) ||
    segment.logBlockHeaders.length > MAX_LOGS
  )
    fail('segment_invalid')
  const pins = new Map([
    [segment.fromBlock, segment.fromHeader],
    [segment.toBlock, segment.toHeader],
  ])
  for (const h of segment.logBlockHeaders) {
    if (
      !Number.isSafeInteger(h.number) ||
      h.number < segment.fromBlock ||
      h.number > segment.toBlock ||
      !HASH.test(h.hash) ||
      !HASH.test(h.parentHash) ||
      (pins.has(h.number) &&
        (pins.get(h.number).hash !== h.hash || pins.get(h.number).parentHash !== h.parentHash))
    )
      fail('log_header_invalid')
    pins.set(h.number, h)
  }
  const orderedPins = [...pins.values()].sort((a, b) => a.number - b.number)
  // This proves only links between adjacent pinned blocks. The unpinned
  // interior of wider ranges remains unproven and is labeled in every seal.
  for (let i = 1; i < orderedPins.length; i++) {
    if (
      orderedPins[i].number === orderedPins[i - 1].number + 1 &&
      orderedPins[i].parentHash !== orderedPins[i - 1].hash
    )
      fail('pinned_ancestry_invalid')
  }
  for (const log of segment.logs) {
    if (
      !Number.isSafeInteger(log.blockNumber) ||
      log.blockNumber < segment.fromBlock ||
      log.blockNumber > segment.toBlock ||
      !HASH.test(log.blockHash) ||
      !HASH.test(log.transactionHash) ||
      !Number.isSafeInteger(log.logIndex) ||
      log.logIndex < 0 ||
      !ADDRESS.test(log.implementation) ||
      pins.get(log.blockNumber)?.hash !== log.blockHash
    )
      fail('log_replay_invalid')
  }
  canonicalLogs(segment.logs)
  const blocks = [...new Set(segment.logs.map((l) => l.blockNumber))].sort((a, b) => a - b)
  if (JSON.stringify(blocks) !== JSON.stringify(segment.logBlockHeaders.map((h) => h.number)))
    fail('log_header_replay_invalid')
  return { block: segment.toBlock, hash: segment.toHeader.hash }
}

export function verify({ out, target = DEFAULT_TARGET }) {
  validateTarget(target)
  const names = existsSync(out) ? readdirSync(out).sort() : []
  if (names.some((n) => n !== LOCK && !FILE.test(n))) fail('unrecognized_artifact')
  let previous = { block: DEPLOYMENT_BLOCK - 1, hash: null }
  const segments = []
  const upgrades = []
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
    previous = validateSegment(segment, target, previous, name)
    segments.push({
      name,
      sha256: sha(bytes),
      fromBlock: segment.fromBlock,
      toBlock: segment.toBlock,
    })
    upgrades.push(...segment.logs)
  }
  return {
    throughBlock: previous.block,
    frontierHash: previous.hash,
    target,
    fullEventRange: previous.block === target.block,
    segments,
    upgrades,
    logCompleteness: 'not_independently_proven',
    interiorAncestry: 'unproven_between_sparse_pins',
    slotWriteCoverage: 'event_only',
  }
}

function seal(out, segment, stat) {
  const bytes = Buffer.from(JSON.stringify(segment))
  if (bytes.length > MAX_BYTES) fail('segment_size_cap')
  checkDisk(out, stat, bytes.length)
  const name = nameOf(segment)
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
    if (fd !== null && fd !== undefined) closeSync(fd)
    if (existsSync(temp)) unlinkSync(temp)
  }
  return { name, sha256: sha(bytes) }
}

export async function collect({
  out,
  target = DEFAULT_TARGET,
  rpcRead,
  peerRpcRead,
  maxChunks = 1,
  windowBlocks = CHUNK_BLOCKS,
  stat = statfsSync,
  now = () => new Date(),
}) {
  validateTarget(target)
  if (
    typeof rpcRead !== 'function' ||
    typeof peerRpcRead !== 'function' ||
    !Number.isInteger(maxChunks) ||
    maxChunks < 1 ||
    maxChunks > MAX_CHUNKS ||
    !Number.isInteger(windowBlocks) ||
    windowBlocks < 1 ||
    windowBlocks > CHUNK_BLOCKS
  )
    fail('bound_invalid')
  checkDisk(out, stat)
  const release = lock(out)
  try {
    let calls = 0
    const read = async (reader, method, params) => {
      checkDisk(out, stat)
      if (++calls > MAX_CALLS) fail('request_budget_exceeded')
      try {
        return await reader(method, params)
      } catch {
        fail('rpc_failure')
      }
    }
    if (
      integer(await read(rpcRead, 'eth_chainId', [])) !== 1 ||
      integer(await read(peerRpcRead, 'eth_chainId', [])) !== 1
    )
      fail('chain_invalid')
    const block = async (reader, n) =>
      header(await read(reader, 'eth_getBlockByNumber', [hex(n), false]), n)
    const agreedBlock = async (n) => {
      const [a, b] = await Promise.all([block(rpcRead, n), block(peerRpcRead, n)])
      if (a.hash !== b.hash || a.parentHash !== b.parentHash) fail('header_mismatch')
      return a
    }
    const finalA = await read(rpcRead, 'eth_getBlockByNumber', ['finalized', false])
    const finalB = await read(peerRpcRead, 'eth_getBlockByNumber', ['finalized', false])
    const headA = header(finalA, integer(finalA?.number))
    const headB = header(finalB, integer(finalB?.number))
    const finalizedHead = Math.min(headA.number, headB.number)
    if (finalizedHead < target.block) fail('target_not_finalized')
    const finalPin = await agreedBlock(finalizedHead)
    const targetPin = await agreedBlock(target.block)
    if (targetPin.hash !== target.hash) fail('target_hash_mismatch')
    let previous = verify({ out, target })
    if (
      previous.frontierHash &&
      (await agreedBlock(previous.throughBlock)).hash !== previous.frontierHash
    )
      fail('frontier_reorg')
    const added = []
    for (let i = 0; i < maxChunks && previous.throughBlock < target.block; i++) {
      const fromBlock = previous.throughBlock + 1
      const toBlock = Math.min(target.block, fromBlock + windowBlocks - 1)
      const fromHeader = await agreedBlock(fromBlock)
      const toHeader = await agreedBlock(toBlock)
      if (previous.frontierHash && fromHeader.parentHash !== previous.frontierHash)
        fail('range_reorg')
      const params = [
        {
          address: PROXY,
          fromBlock: hex(fromBlock),
          toBlock: hex(toBlock),
          topics: [UPGRADED_TOPIC],
        },
      ]
      const [raw, peer] = await Promise.all([
        read(rpcRead, 'eth_getLogs', params),
        read(peerRpcRead, 'eth_getLogs', params),
      ])
      if (
        !Array.isArray(raw) ||
        !Array.isArray(peer) ||
        raw.length > MAX_LOGS ||
        peer.length > MAX_LOGS ||
        Buffer.byteLength(JSON.stringify(raw)) > MAX_BYTES ||
        Buffer.byteLength(JSON.stringify(peer)) > MAX_BYTES
      )
        fail('log_bound_invalid')
      const logs = raw.map((log) => normalizeLog(log, fromBlock, toBlock))
      const peers = peer.map((log) => normalizeLog(log, fromBlock, toBlock))
      canonicalLogs(logs)
      canonicalLogs(peers)
      if (JSON.stringify(logs) !== JSON.stringify(peers)) fail('provider_logs_mismatch')
      const logBlockHeaders = []
      for (const n of [...new Set(logs.map((log) => log.blockNumber))]) {
        const h = await agreedBlock(n)
        if (logs.some((log) => log.blockNumber === n && log.blockHash !== h.hash))
          fail('log_block_reorg')
        logBlockHeaders.push(h)
      }
      if ((await agreedBlock(toBlock)).hash !== toHeader.hash) fail('range_reorg')
      const segment = {
        schemaVersion: 1,
        chainId: 1,
        proxy: PROXY,
        deploymentBlock: DEPLOYMENT_BLOCK,
        target,
        fromBlock,
        toBlock,
        fromHeader,
        toHeader,
        finalizedHead,
        finalizedHeadHash: finalPin.hash,
        providerAgreement: true,
        firstObservedAt: now().toISOString(),
        logCompleteness: 'not_independently_proven',
        interiorAncestry: 'unproven_between_sparse_pins',
        slotWriteCoverage: 'event_only',
        logBlockHeaders,
        logs,
      }
      validateSegment(
        segment,
        target,
        { block: previous.throughBlock, hash: previous.frontierHash },
        nameOf(segment),
      )
      added.push(seal(out, segment, stat))
      previous = verify({ out, target })
    }
    return { ...previous, added }
  } finally {
    release()
  }
}

function parseArgs(argv) {
  const options = {}
  let mode
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i]
    if (item === '--run' || item === '--verify') {
      if (mode) fail('cli_invalid')
      mode = item
    } else if (
      [
        '--out',
        '--rpc-hosts',
        '--target-block',
        '--target-hash',
        '--max-chunks',
        '--window-blocks',
      ].includes(item)
    ) {
      if (options[item] !== undefined || !argv[i + 1]) fail('cli_invalid')
      options[item] = argv[++i]
    } else fail('cli_invalid')
  }
  if (
    !mode ||
    !options['--out'] ||
    Boolean(options['--target-block']) !== Boolean(options['--target-hash'])
  )
    fail('cli_invalid')
  const target = options['--target-block']
    ? { block: Number(options['--target-block']), hash: lower(options['--target-hash']) }
    : DEFAULT_TARGET
  validateTarget(target)
  return {
    mode,
    out: resolve(options['--out']),
    target,
    rpcHosts: options['--rpc-hosts'],
    maxChunks: Number(options['--max-chunks'] ?? 1),
    windowBlocks: Number(options['--window-blocks'] ?? CHUNK_BLOCKS),
  }
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const args = parseArgs(argv)
  if (args.mode === '--verify') return verify(args)
  if (dependencies.rpcRead && dependencies.peerRpcRead) return collect({ ...args, ...dependencies })
  if (!args.rpcHosts) fail('rpc_host_selection_required')
  const env = dependencies.env ?? readEnv()
  const raw =
    dependencies.rpcUrls ??
    (dependencies.env ? undefined : process.env.RECORDER_RPC_URLS) ??
    env.get('RECORDER_RPC_URLS') ??
    (dependencies.env ? undefined : process.env.RECORDER_RPC_URL) ??
    env.get('RECORDER_RPC_URL')
  let urls
  try {
    urls = selectRpcUrls(raw, args.rpcHosts)
  } catch {
    fail('rpc_config_invalid')
  }
  const factory = dependencies.makeClient ?? makeClient
  const readers = urls.map((url) => {
    try {
      const client = factory(url)
      return (method, params) => client.request({ method, params })
    } catch {
      fail('rpc_config_invalid')
    }
  })
  return collect({
    ...args,
    rpcRead: readers[0],
    peerRpcRead: readers[1],
    stat: dependencies.stat ?? statfsSync,
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((result) => {
      process.stdout.write(
        `${JSON.stringify({
          throughBlock: result.throughBlock,
          frontierHash: result.frontierHash,
          fullEventRange: result.fullEventRange,
          segmentCount: result.segments.length,
          upgradeCount: result.upgrades.length,
          added: result.added,
          logCompleteness: result.logCompleteness,
          interiorAncestry: result.interiorAncestry,
          slotWriteCoverage: result.slotWriteCoverage,
        })}\n`,
      )
    })
    .catch((error) => {
      process.stderr.write(
        `${String(error?.message).startsWith('sgho_upgrade_') ? error.message : 'sgho_upgrade_failure'}\n`,
      )
      process.exitCode = 1
    })
}
