// Historical VaultV2 allocation-event census. Dry by default; --run performs bounded RPC reads.
// --verify reads only local, append-only segment files and their pinned source artifacts.
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, statfsSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeEventLog, encodeAbiParameters, parseAbiItem, toHex } from 'viem'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import { FACTORY_SHA, SUBMIT_SHA, PINNED_HEAD_HASH, readSources } from './morpho-v2-cap-lifecycle-census.mjs'
import { ALLOCATE_TOPIC, DEALLOCATE_TOPIC, MAX_ALLOCATION_IDS } from './morpho-v2-cap-prospective-watch.mjs'

export const STUDY = 'morpho-v2-historical-allocation-census-v1'
export const FROM_BLOCK = 23_375_073
export const TO_BLOCK = 26_052_740
export const FIRST_BLOCK_HASH = '0x17168700f249c854a99e2d127ad54d0ea32af4606763927614c3831002259242'
export const CHUNK_BLOCKS = 1_000
export const MAX_CHUNKS = 4
export const MAX_RPC_CALLS = 256
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
export const MAX_SEGMENT_BYTES = 4 * 1024 * 1024
export const RESERVE_BYTES = 1024 ** 3
const HASH = /^0x[\da-f]{64}$/i
const ADDRESS = /^0x[\da-f]{40}$/i
const HEX = /^0x(?:[\da-f]{2})*$/i
const ABI = {
  allocate: parseAbiItem('event Allocate(address indexed sender,address indexed adapter,uint256 assets,bytes32[] ids,int256 change)'),
  deallocate: parseAbiItem('event Deallocate(address indexed sender,address indexed adapter,uint256 assets,bytes32[] ids,int256 change)'),
}
const TOPIC = { allocate: ALLOCATE_TOPIC, deallocate: DEALLOCATE_TOPIC }
const INPUTS = [{ type: 'uint256' }, { type: 'bytes32[]' }, { type: 'int256' }]
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const defaultOut = 'data/research/venue-signals/morpho-v2-historical-allocation-census'
const sourcePaths = {
  factory: `data/research/venue-signals/${FACTORY_SHA}.json`,
  submit: `data/research/venue-signals/${SUBMIT_SHA}.json`,
}

function quantity(value) {
  const n = typeof value === 'number' ? value : Number(BigInt(value))
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid RPC quantity')
  return n
}
function header(value, expected) {
  const number = quantity(value?.number)
  if (number !== expected || !HASH.test(value?.hash) || !HASH.test(value?.parentHash))
    throw new Error('Invalid canonical header')
  return { number, hash: value.hash.toLowerCase(), parentHash: value.parentHash.toLowerCase() }
}
function rawLog(log) {
  if (!ADDRESS.test(log?.address) || !HASH.test(log?.blockHash) ||
      !HASH.test(log?.transactionHash) || !HEX.test(log?.data) ||
      !Array.isArray(log?.topics) || log.topics.some((x) => !HASH.test(x)))
    throw new Error('Malformed allocation log')
  return {
    address: log.address.toLowerCase(),
    blockNumber: quantity(log.blockNumber),
    blockHash: log.blockHash.toLowerCase(),
    transactionIndex: quantity(log.transactionIndex),
    transactionHash: log.transactionHash.toLowerCase(),
    logIndex: quantity(log.logIndex),
    topics: log.topics.map((x) => x.toLowerCase()),
    data: log.data.toLowerCase(),
  }
}
export function decodeAllocation(kind, raw) {
  if (!ABI[kind] || raw.topics?.length !== 3 || raw.topics[0] !== TOPIC[kind] ||
      raw.topics.slice(1).some((x) => !/^0x0{24}[\da-f]{40}$/.test(x)))
    throw new Error('Malformed allocation topics')
  const { args } = decodeEventLog({ abi: [ABI[kind]], topics: raw.topics, data: raw.data, strict: true })
  if (!Array.isArray(args.ids) || args.ids.length > MAX_ALLOCATION_IDS ||
      args.ids.some((id) => !HASH.test(id)) ||
      encodeAbiParameters(INPUTS, [args.assets, args.ids, args.change]).toLowerCase() !== raw.data)
    throw new Error('Noncanonical or oversized allocation data')
  return {
    vault: raw.address, sender: args.sender.toLowerCase(), adapter: args.adapter.toLowerCase(),
    assets: args.assets.toString(), ids: args.ids.map((x) => x.toLowerCase()),
    change: args.change.toString(),
  }
}
function unsigned(segment) {
  const { segmentSha256, ...body } = segment
  return body
}
export const seal = (segment) => ({ ...unsigned(segment), segmentSha256: sha(JSON.stringify(unsigned(segment))) })
function names(out) {
  if (!existsSync(out)) return []
  const files = readdirSync(out)
  if (files.some((x) => !/^\d{12}-\d{12}\.json(?:\.[\da-f-]+\.tmp)?$/.test(x)))
    throw new Error('Unexpected census file')
  return files.filter((x) => x.endsWith('.json')).sort()
}
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b) }

export function verify({ out = defaultOut, sources, requireExisting = false }) {
  const files = names(out)
  if (requireExisting && !files.length) throw new Error('No census segments')
  if (sources.vaults.size !== 757) throw new Error('Wrong factory cohort')
  let throughBlock = FROM_BLOCK - 1, frontierHash = null, lastSegmentSha256 = null
  let eventCount = 0
  for (const file of files) {
    const bytes = readFileSync(join(out, file))
    const saved = JSON.parse(bytes)
    if (bytes.length > MAX_SEGMENT_BYTES || saved.study !== STUDY || saved.chainId !== 1 ||
        saved.factoryArtifactSha256 !== FACTORY_SHA || saved.submitArtifactSha256 !== SUBMIT_SHA ||
        saved.pinnedHeadHash !== PINNED_HEAD_HASH ||
        saved.from !== throughBlock + 1 || saved.to < saved.from || saved.to > TO_BLOCK ||
        saved.to - saved.from + 1 > CHUNK_BLOCKS ||
        file !== `${String(saved.from).padStart(12, '0')}-${String(saved.to).padStart(12, '0')}.json` ||
        saved.previousSegmentSha256 !== lastSegmentSha256 ||
        saved.previousFrontierHash !== frontierHash ||
        !HASH.test(saved.fromHash) || !HASH.test(saved.toHash) ||
        (saved.from === FROM_BLOCK && saved.fromHash !== FIRST_BLOCK_HASH) ||
        (saved.to === TO_BLOCK && saved.toHash !== PINNED_HEAD_HASH) ||
        saved.segmentSha256 !== sha(JSON.stringify(unsigned(saved))) ||
        !same(saved.scans?.map((x) => x.kind), ['allocate', 'deallocate']) ||
        !Array.isArray(saved.events) ||
        !same(saved.limitations, ['event-source-abi-not-every-deployed-runtime-attested',
          'event-assets-are-not-per-id-dollars', 'allocation-change-is-not-exit-capacity']))
      throw new Error('Census segment seal or continuity mismatch')
    const coordinate = new Set()
    const blockHashes = new Map()
    let prior = [-1, -1, -1]
    for (const event of saved.events) {
      const raw = rawLog(event.raw)
      if (!TOPIC[event.kind] || raw.topics[0] !== TOPIC[event.kind] ||
          !sources.vaults.has(raw.address) || sources.vaults.get(raw.address) > raw.blockNumber ||
          raw.blockNumber < saved.from || raw.blockNumber > saved.to ||
          (raw.blockNumber === saved.from && raw.blockHash !== saved.fromHash) ||
          (raw.blockNumber === saved.to && raw.blockHash !== saved.toHash) ||
          !same(decodeAllocation(event.kind, raw), event.detail))
        throw new Error('Invalid census event')
      const key = `${raw.transactionHash}:${raw.logIndex}`
      const next = [raw.blockNumber, raw.transactionIndex, raw.logIndex]
      if (coordinate.has(key) || next[0] < prior[0] ||
          (next[0] === prior[0] && (next[1] < prior[1] ||
            (next[1] === prior[1] && next[2] <= prior[2]))))
        throw new Error('Duplicate or unordered census event')
      coordinate.add(key)
      prior = next
      const oldHash = blockHashes.get(raw.blockNumber)
      if (oldHash && oldHash !== raw.blockHash) throw new Error('Conflicting block hashes')
      blockHashes.set(raw.blockNumber, raw.blockHash)
    }
    for (const scan of saved.scans) {
      if (scan.topic !== TOPIC[scan.kind] || scan.from !== saved.from || scan.to !== saved.to ||
          !Number.isSafeInteger(scan.rawCount) || scan.rawCount < scan.eventCount ||
          scan.eventCount !== saved.events.filter((x) => x.kind === scan.kind).length)
        throw new Error('Incomplete scan accounting')
    }
    if (frontierHash && saved.fromParentHash !== frontierHash)
      throw new Error('Noncontiguous header ancestry')
    if (!frontierHash && !HASH.test(saved.fromParentHash))
      throw new Error('Missing first parent hash')
    throughBlock = saved.to
    frontierHash = saved.toHash
    lastSegmentSha256 = sha(bytes)
    eventCount += saved.events.length
  }
  return { throughBlock, frontierHash, lastSegmentSha256, segmentCount: files.length,
    eventCount, complete: throughBlock === TO_BLOCK }
}

function diskGuard(out, stat, expected = 0) {
  const fs = stat(dirname(out))
  if (Number(fs.bavail) * Number(fs.bsize) - expected < RESERVE_BYTES)
    throw new Error('Historical census 1GiB disk reserve reached')
}
function append(out, segment, stat) {
  const bytes = JSON.stringify(segment)
  if (Buffer.byteLength(bytes) > MAX_SEGMENT_BYTES) throw new Error('Segment byte cap reached')
  diskGuard(out, stat, Buffer.byteLength(bytes))
  mkdirSync(out, { recursive: true })
  const file = `${String(segment.from).padStart(12, '0')}-${String(segment.to).padStart(12, '0')}.json`
  const target = join(out, file), temporary = `${target}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 })
    linkSync(temporary, target)
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

export async function collect({ rpcRead, sources, out = defaultOut, maxChunks = 1,
  stat = statfsSync, onProgress = () => {} }) {
  if (!Number.isSafeInteger(maxChunks) || maxChunks < 1 || maxChunks > MAX_CHUNKS)
    throw new Error('Invalid bounded chunk count')
  let calls = 0
  const rpc = async (method, params) => {
    diskGuard(out, stat)
    if (++calls > MAX_RPC_CALLS) throw new Error('RPC call cap reached')
    return rpcRead(method, params)
  }
  let state = verify({ out, sources })
  if (quantity(await rpc('eth_chainId', [])) !== 1) throw new Error('Wrong chain')
  const pinned = header(await rpc('eth_getBlockByNumber', [toHex(TO_BLOCK), false]), TO_BLOCK)
  if (pinned.hash !== PINNED_HEAD_HASH) throw new Error('Pinned head changed')
  if (state.frontierHash) {
    const frontier = header(await rpc('eth_getBlockByNumber', [toHex(state.throughBlock), false]), state.throughBlock)
    if (frontier.hash !== state.frontierHash) throw new Error('Saved frontier reorged')
  }
  for (let i = 0; i < maxChunks && !state.complete; i++) {
    const from = state.throughBlock + 1, to = Math.min(TO_BLOCK, from + CHUNK_BLOCKS - 1)
    const first = header(await rpc('eth_getBlockByNumber', [toHex(from), false]), from)
    const last = header(await rpc('eth_getBlockByNumber', [toHex(to), false]), to)
    if ((from === FROM_BLOCK && first.hash !== FIRST_BLOCK_HASH) ||
        (state.frontierHash && first.parentHash !== state.frontierHash) ||
        (to === TO_BLOCK && last.hash !== PINNED_HEAD_HASH))
      throw new Error('Historical chain boundary mismatch')
    const scans = [], fetched = []
    for (const kind of ['allocate', 'deallocate']) {
      const response = await rpc('eth_getLogs', [{ fromBlock: toHex(from), toBlock: toHex(to), topics: [TOPIC[kind]] }])
      if (!Array.isArray(response) || Buffer.byteLength(JSON.stringify(response)) > MAX_RESPONSE_BYTES)
        throw new Error('Malformed or oversized logs response')
      scans.push({ kind, topic: TOPIC[kind], from, to, rawCount: response.length, eventCount: 0 })
      for (const item of response) fetched.push({ kind, raw: rawLog(item) })
    }
    fetched.sort((a, b) => a.raw.blockNumber - b.raw.blockNumber ||
      a.raw.transactionIndex - b.raw.transactionIndex || a.raw.logIndex - b.raw.logIndex)
    const coordinates = new Set(), events = [], hashes = new Map()
    for (const { kind, raw } of fetched) {
      if (raw.topics[0] !== TOPIC[kind] || raw.blockNumber < from || raw.blockNumber > to ||
          (raw.blockNumber === from && raw.blockHash !== first.hash) ||
          (raw.blockNumber === to && raw.blockHash !== last.hash))
        throw new Error('Out-of-range or noncanonical log')
      const key = `${raw.transactionHash}:${raw.logIndex}`
      if (coordinates.has(key)) throw new Error('Duplicate RPC log')
      coordinates.add(key)
      const oldHash = hashes.get(raw.blockNumber)
      if (oldHash && oldHash !== raw.blockHash) throw new Error('Conflicting RPC block hashes')
      hashes.set(raw.blockNumber, raw.blockHash)
      if (!sources.vaults.has(raw.address) || sources.vaults.get(raw.address) > raw.blockNumber)
        continue // Global topic scan includes other contracts and pre-creation addresses.
      events.push({ kind, raw, detail: decodeAllocation(kind, raw) })
      scans.find((x) => x.kind === kind).eventCount++
    }
    for (const [number, hash] of hashes) {
      if (number === from || number === to) continue
      const canonical = header(await rpc('eth_getBlockByNumber', [toHex(number), false]), number)
      if (canonical.hash !== hash) throw new Error('Orphan interior log')
    }
    const endCheck = header(await rpc('eth_getBlockByNumber', [toHex(to), false]), to)
    if (endCheck.hash !== last.hash ||
        (state.frontierHash && header(await rpc('eth_getBlockByNumber',
          [toHex(state.throughBlock), false]), state.throughBlock).hash !== state.frontierHash))
      throw new Error('Chain changed before append')
    const fresh = verify({ out, sources })
    if (fresh.throughBlock !== state.throughBlock || fresh.lastSegmentSha256 !== state.lastSegmentSha256)
      throw new Error('Concurrent census append')
    const segment = seal({
      study: STUDY, chainId: 1, factoryArtifactSha256: FACTORY_SHA,
      submitArtifactSha256: SUBMIT_SHA, pinnedHeadHash: PINNED_HEAD_HASH,
      previousSegmentSha256: state.lastSegmentSha256, previousFrontierHash: state.frontierHash,
      from, to, fromHash: first.hash, fromParentHash: first.parentHash, toHash: last.hash,
      scans, events,
      limitations: ['event-source-abi-not-every-deployed-runtime-attested',
        'event-assets-are-not-per-id-dollars', 'allocation-change-is-not-exit-capacity'],
    })
    append(out, segment, stat)
    state = verify({ out, sources, requireExisting: true })
    onProgress({ throughBlock: state.throughBlock, eventCount: state.eventCount, segmentCount: state.segmentCount })
  }
  return { ...state, rpcCalls: calls }
}

function options(args) {
  const out = { run: false, verify: false, maxChunks: 1 }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--run') out.run = true
    else if (args[i] === '--verify') out.verify = true
    else if (['--out', '--factory', '--submit', '--rpc', '--max-chunks'].includes(args[i]))
      out[args[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = args[++i]
    else throw new Error('Unknown census option')
  }
  out.maxChunks = Number(out.maxChunks)
  if (out.run && out.verify) throw new Error('Choose run or verify')
  return out
}
async function main() {
  try {
    const opts = options(process.argv.slice(2))
    const out = resolve(opts.out || defaultOut)
    const sources = readSources(resolve(opts.factory || sourcePaths.factory),
      resolve(opts.submit || sourcePaths.submit))
    const state = verify({ out, sources, requireExisting: opts.verify })
    if (!opts.run) {
      process.stdout.write(JSON.stringify({ dry: !opts.verify, verified: !!opts.verify,
        throughBlock: state.throughBlock, complete: state.complete,
        segmentCount: state.segmentCount, nextFrom: state.complete ? null : state.throughBlock + 1,
        maxChunks: opts.maxChunks, chunkBlocks: CHUNK_BLOCKS, noRpcOrWrites: true }) + '\n')
    } else {
      const url = opts.rpc || process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')
      if (!url) throw new Error('Missing RPC configuration')
      const client = makeClient(url)
      const result = await collect({ rpcRead: (method, params) => client.request({ method, params }),
        sources, out, maxChunks: opts.maxChunks })
      process.stdout.write(JSON.stringify({ throughBlock: result.throughBlock,
        segmentCount: result.segmentCount, eventCount: result.eventCount,
        complete: result.complete, rpcCalls: result.rpcCalls }) + '\n')
    }
  } catch {
    // RPC errors may contain credential-bearing URLs.
    process.stderr.write('Historical allocation census stopped: source, RPC, or integrity validation failed.\n')
    process.exitCode = 1
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
