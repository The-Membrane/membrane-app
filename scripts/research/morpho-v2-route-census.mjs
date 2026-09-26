// Read-only, global-topic census of Vault V2 liquidity-adapter changes.
// node scripts/research/morpho-v2-route-census.mjs --max-chunks 1
// node scripts/research/morpho-v2-route-census.mjs --verify true
import { createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAbiItem, toEventSelector, toHex } from 'viem'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'

export const STUDY = 'morpho-v2-route-census-v1'
export const FACTORY_SHA = '745062b27def710352f1b6c5ca220ebc3a953513a384077e190f7eef92ea6aaa'
export const PINNED_HEAD_HASH = '0xf43d7e3b07870c3eef167f2681d6132a337c1c5eefc4a5223e4fdfd4843ad756'
export const FROM_BLOCK = 23_375_073
export const TO_BLOCK = 26_052_740
export const CHUNK_BLOCKS = 8_000
export const RESERVE_BYTES = 2_500_000_000
export const MAX_OUTPUT_BYTES = 32 * 1024 * 1024
export const ROUTE = parseAbiItem(
  'event SetLiquidityAdapterAndData(address indexed sender,address indexed newLiquidityAdapter,bytes indexed newLiquidityData)',
)
export const TOPIC0 = toEventSelector(ROUTE).toLowerCase()
const HASH = /^0x[\da-fA-F]{64}$/
const ADDRESS = /^0x[\da-fA-F]{40}$/
const ZERO_PADDED_ADDRESS = /^0x0{24}[\da-fA-F]{40}$/
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')

export function ranges(from = FROM_BLOCK, to = TO_BLOCK, size = CHUNK_BLOCKS) {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from > to ||
      !Number.isSafeInteger(size) || size < 1 || size > CHUNK_BLOCKS)
    throw new Error('Invalid bounded route range')
  const out = []
  for (let first = from; first <= to; first += size)
    out.push({ fromBlock: first, toBlock: Math.min(to, first + size - 1) })
  return out
}

export function readFactory(path) {
  const bytes = readFileSync(path)
  if (sha(bytes) !== FACTORY_SHA) throw new Error('Factory artifact SHA mismatch')
  const saved = JSON.parse(bytes)
  if (saved.study !== 'morpho-v2-factory-create-v1' || saved.status !== 'complete' ||
      saved.from !== FROM_BLOCK || saved.to !== TO_BLOCK ||
      saved.coverage?.throughBlock !== TO_BLOCK || saved.summary?.uniqueVaultCount !== 757 ||
      saved.events?.length !== 757)
    throw new Error('Factory artifact metadata mismatch')
  const creations = new Map()
  for (const event of saved.events) {
    if (!ADDRESS.test(event.vault) || !Number.isSafeInteger(event.block) ||
        event.block < FROM_BLOCK || event.block > TO_BLOCK ||
        creations.has(event.vault.toLowerCase()))
      throw new Error('Factory creation event mismatch')
    creations.set(event.vault.toLowerCase(), event.block)
  }
  if (creations.size !== 757) throw new Error('Factory vault count mismatch')
  return creations
}

export function decodeRoute(log) {
  if (!ADDRESS.test(log.address) || log.topics?.length !== 4 ||
      log.topics[0]?.toLowerCase() !== TOPIC0 ||
      !ZERO_PADDED_ADDRESS.test(log.topics[1]) ||
      !ZERO_PADDED_ADDRESS.test(log.topics[2]) || !HASH.test(log.topics[3]) ||
      log.data !== '0x' || !HASH.test(log.blockHash) || !HASH.test(log.transactionHash))
    throw new Error('Malformed route log')
  const block = Number(BigInt(log.blockNumber))
  const transactionIndex = Number(BigInt(log.transactionIndex))
  const logIndex = Number(BigInt(log.logIndex))
  if (![block, transactionIndex, logIndex].every(Number.isSafeInteger) ||
      Math.min(block, transactionIndex, logIndex) < 0)
    throw new Error('Malformed route coordinate')
  return {
    vault: log.address.toLowerCase(), block, blockHash: log.blockHash.toLowerCase(),
    transactionIndex, txHash: log.transactionHash.toLowerCase(), logIndex,
    sender: `0x${log.topics[1].slice(-40)}`.toLowerCase(),
    adapter: `0x${log.topics[2].slice(-40)}`.toLowerCase(),
    dataTopicHash: log.topics[3].toLowerCase(),
  }
}

function payload(saved) {
  const { checkpointSha256, ...rest } = saved
  return rest
}
export function seal(saved) { return { ...saved, checkpointSha256: sha(JSON.stringify(payload(saved))) } }

export function validateCheckpoint(saved, creations, expected = {}) {
  const chunkRanges = ranges(FROM_BLOCK, TO_BLOCK, CHUNK_BLOCKS)
  if (saved?.study !== STUDY || saved.chainId !== 1 ||
      saved.factoryArtifactSha256 !== FACTORY_SHA ||
      saved.pinnedHeadHash?.toLowerCase() !== PINNED_HEAD_HASH ||
      saved.from !== FROM_BLOCK || saved.to !== TO_BLOCK || saved.chunkBlocks !== CHUNK_BLOCKS ||
      saved.topic0 !== TOPIC0 || !['partial', 'complete'].includes(saved.status) ||
      !Number.isSafeInteger(saved.nextChunk) || saved.nextChunk < 0 ||
      saved.nextChunk > chunkRanges.length || !Array.isArray(saved.chunks) ||
      saved.chunks.length !== saved.nextChunk || !Array.isArray(saved.events) ||
      !Number.isSafeInteger(saved.nonCohortLogs) || saved.nonCohortLogs < 0 ||
      !Number.isSafeInteger(saved.preCreationLogs) || saved.preCreationLogs < 0 ||
      saved.status !== (saved.nextChunk === chunkRanges.length ? 'complete' : 'partial') ||
      !/^[\da-f]{64}$/.test(saved.checkpointSha256 || '') ||
      sha(JSON.stringify(payload(saved))) !== saved.checkpointSha256)
    throw new Error('Route checkpoint metadata or integrity mismatch')
  const through = saved.nextChunk ? chunkRanges[saved.nextChunk - 1].toBlock : FROM_BLOCK - 1
  if (saved.coverage?.fromBlock !== FROM_BLOCK || saved.coverage?.throughBlock !== through ||
      saved.coverage?.chunksComplete !== saved.nextChunk ||
      saved.coverage?.chunksExpected !== chunkRanges.length ||
      saved.coverage?.complete !== (saved.status === 'complete'))
    throw new Error('Route checkpoint coverage mismatch')
  let nextEvent = 0, nonCohort = 0, preCreation = 0
  for (let i = 0; i < saved.chunks.length; i++) {
    const chunk = saved.chunks[i], range = chunkRanges[i]
    if (chunk.fromBlock !== range.fromBlock || chunk.toBlock !== range.toBlock ||
        !Number.isSafeInteger(chunk.matchedLogs) || chunk.matchedLogs < 0 ||
        !Number.isSafeInteger(chunk.nonCohortLogs) || chunk.nonCohortLogs < 0 ||
        !Number.isSafeInteger(chunk.preCreationLogs) || chunk.preCreationLogs < 0 ||
        !Number.isSafeInteger(chunk.eventCount) || chunk.eventCount < 0 ||
        chunk.matchedLogs !== chunk.nonCohortLogs + chunk.preCreationLogs + chunk.eventCount ||
        !/^[\da-f]{64}$/.test(chunk.eventsSha256 || ''))
      throw new Error('Route chunk accounting mismatch')
    const events = saved.events.slice(nextEvent, nextEvent + chunk.eventCount)
    if (events.length !== chunk.eventCount || sha(JSON.stringify(events)) !== chunk.eventsSha256)
      throw new Error('Route chunk event integrity mismatch')
    for (const event of events) {
      if (event.block < range.fromBlock || event.block > range.toBlock) throw new Error('Route event outside chunk')
    }
    nextEvent += chunk.eventCount
    nonCohort += chunk.nonCohortLogs
    preCreation += chunk.preCreationLogs
  }
  if (nextEvent !== saved.events.length || nonCohort !== saved.nonCohortLogs ||
      preCreation !== saved.preCreationLogs)
    throw new Error('Route aggregate accounting mismatch')
  let priorBlock = -1, priorIndex = -1
  for (const event of saved.events) {
    if (!ADDRESS.test(event.vault) || !ADDRESS.test(event.sender) || !ADDRESS.test(event.adapter) ||
        !HASH.test(event.blockHash) || !HASH.test(event.txHash) ||
        !HASH.test(event.dataTopicHash) || !Number.isSafeInteger(event.block) ||
        !Number.isSafeInteger(event.transactionIndex) || !Number.isSafeInteger(event.logIndex) ||
        event.block < (creations.get(event.vault.toLowerCase()) ?? Infinity) ||
        event.block > through || event.block < priorBlock ||
        (event.block === priorBlock && event.logIndex <= priorIndex))
      throw new Error('Malformed, pre-creation, or unordered route event')
    priorBlock = event.block; priorIndex = event.logIndex
  }
  if (expected.complete && saved.status !== 'complete') throw new Error('Incomplete route census')
  return saved
}

function atomic(path, value, diskStats = statfsSync) {
  mkdirSync(dirname(path), { recursive: true })
  const bytes = JSON.stringify(value)
  if (Buffer.byteLength(bytes) > MAX_OUTPUT_BYTES) throw new Error('Route output size cap reached')
  const disk = diskStats(dirname(path))
  if (Number(disk.bavail) * Number(disk.bsize) - Buffer.byteLength(bytes) < RESERVE_BYTES)
    throw new Error('Route disk reserve reached')
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, bytes, { mode: 0o600 })
  renameSync(temp, path)
}

async function retry(operation, retries, pause) {
  for (let i = 0; ; i++) {
    try { return await operation() }
    catch (error) {
      if (i >= retries) throw new Error('RPC read failed', { cause: error })
      await pause(Math.min(10_000, 500 * 2 ** i))
    }
  }
}

export async function collect({
  client, rpcRead = (method, params) => client.request({ method, params }), out, creations,
  maxChunks = Infinity, retries = 3,
  pause = (ms) => new Promise((done) => setTimeout(done, ms)), onProgress = () => {},
  diskStats = statfsSync,
}) {
  if (!(creations instanceof Map) || creations.size !== 757)
    throw new Error('Expected pinned 757-vault creation map')
  if (!Number.isSafeInteger(maxChunks) && maxChunks !== Infinity)
    throw new Error('Invalid maxChunks')
  if (maxChunks < 0) throw new Error('Invalid maxChunks')
  const chainId = await retry(() => client.getChainId(), retries, pause)
  if (chainId !== 1) throw new Error('Wrong chain ID')
  const head = await retry(() => client.getBlock({ blockNumber: BigInt(TO_BLOCK) }), retries, pause)
  if (head.hash?.toLowerCase() !== PINNED_HEAD_HASH) throw new Error('Pinned head mismatch')
  const chunkRanges = ranges()
  let saved = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : seal({
    study: STUDY, chainId: 1, factoryArtifactSha256: FACTORY_SHA,
    pinnedHeadHash: PINNED_HEAD_HASH, from: FROM_BLOCK, to: TO_BLOCK,
    chunkBlocks: CHUNK_BLOCKS, topic0: TOPIC0, status: 'partial', nextChunk: 0,
    chunks: [], events: [], nonCohortLogs: 0, preCreationLogs: 0,
    coverage: { fromBlock: FROM_BLOCK, throughBlock: FROM_BLOCK - 1,
      chunksComplete: 0, chunksExpected: chunkRanges.length, complete: false },
  })
  validateCheckpoint(saved, creations)
  if (!existsSync(out)) atomic(out, saved, diskStats)
  const stopAt = Math.min(chunkRanges.length, saved.nextChunk + maxChunks)
  for (let i = saved.nextChunk; i < stopAt; i++) {
    const range = chunkRanges[i]
    const logs = await retry(() => rpcRead('eth_getLogs', [{
      fromBlock: toHex(range.fromBlock), toBlock: toHex(range.toBlock), topics: [TOPIC0],
    }]), retries, pause)
    if (!Array.isArray(logs)) throw new Error('Malformed RPC log response')
    const events = [], coordinates = new Set()
    let nonCohortLogs = 0, preCreationLogs = 0
    for (const log of logs) {
      const event = decodeRoute(log)
      if (event.block < range.fromBlock || event.block > range.toBlock)
        throw new Error('Out-of-range route log')
      const key = `${event.txHash}:${event.logIndex}`
      if (coordinates.has(key)) throw new Error('Duplicate route log')
      coordinates.add(key)
      const creation = creations.get(event.vault)
      if (creation === undefined) nonCohortLogs++
      else if (event.block < creation)
        throw new Error('Cohort route event predates factory creation')
      else events.push(event)
    }
    events.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex)
    saved = seal({ ...payload(saved),
      status: i + 1 === chunkRanges.length ? 'complete' : 'partial', nextChunk: i + 1,
      chunks: [...saved.chunks, {
        ...range, matchedLogs: logs.length, nonCohortLogs, preCreationLogs,
        eventCount: events.length, eventsSha256: sha(JSON.stringify(events)),
      }],
      events: [...saved.events, ...events],
      nonCohortLogs: saved.nonCohortLogs + nonCohortLogs,
      preCreationLogs: saved.preCreationLogs + preCreationLogs,
      coverage: { fromBlock: FROM_BLOCK, throughBlock: range.toBlock,
        chunksComplete: i + 1, chunksExpected: chunkRanges.length,
        complete: i + 1 === chunkRanges.length },
    })
    validateCheckpoint(saved, creations)
    atomic(out, saved, diskStats)
    onProgress(saved)
  }
  return saved
}

function options(args) {
  const parsed = {}
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith('--') || args[i + 1] === undefined)
      throw new Error('Expected --key value arguments')
    parsed[args[i].slice(2)] = args[i + 1]
  }
  return parsed
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opts = options(process.argv.slice(2))
  const out = resolve(opts.out || 'data/research/venue-signals/morpho-v2-route-census.json')
  const factory = resolve(opts.factory ||
    `data/research/venue-signals/${FACTORY_SHA}.json`)
  try {
    const creations = readFactory(factory)
    if (opts.verify === 'true') {
      const saved = validateCheckpoint(JSON.parse(readFileSync(out, 'utf8')), creations)
      process.stdout.write(JSON.stringify({ path: out, status: saved.status,
        coverage: saved.coverage, eventCount: saved.events.length,
        nonCohortLogs: saved.nonCohortLogs, preCreationLogs: saved.preCreationLogs,
        sha256: sha(readFileSync(out)) }) + '\n')
    } else {
      const rpc = opts.rpc || process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')
      if (!rpc) throw new Error('Set RECORDER_RPC_URL or --rpc')
      const saved = await collect({ client: makeClient(rpc), out, creations,
        maxChunks: opts['max-chunks'] === undefined ? Infinity : Number(opts['max-chunks']),
        onProgress: (x) => process.stdout.write(
          `chunks ${x.nextChunk}/${x.coverage.chunksExpected}, routes ${x.events.length}\n`),
      })
      process.stdout.write(JSON.stringify({ path: out, status: saved.status,
        coverage: saved.coverage, eventCount: saved.events.length,
        nonCohortLogs: saved.nonCohortLogs, preCreationLogs: saved.preCreationLogs,
        sha256: sha(readFileSync(out)) }) + '\n')
    }
  } catch (error) {
    // Provider errors can include credential-bearing RPC URLs; print only known safe categories.
    process.stderr.write(`Route census stopped; checkpoint remains at ${out}. ` +
      (error.message === 'RPC read failed' ? 'RPC read failed.' : 'Validation or resource guard failed.') + '\n')
    process.exitCode = 1
  }
}
