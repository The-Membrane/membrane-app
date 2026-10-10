// Read-only, resumable Curve A-ramp event census for the two configured
// crvUSD exit pools. Events are decoded from the deployed factory-plain-pool
// ABI shape, not from the newer stableswap-ng pool's unrelated read methods.
//
// node scripts/research/curve-ramp-event-census.mjs \
//   --out /private/tmp/scrvusd-rampa-census-400d.json
// Source ABI: the verified deployed pool proxies below, exposing
// RampA(uint256,uint256,uint256,uint256) and StopRampA(uint256,uint256).
// Pool addresses are read from tools/venue-recorder.config.json, not embedded.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { decodeEventLog, parseAbiItem } from 'viem'
import { loadConfig, makeClient, readEnv } from '../lib/venue-reads.mjs'

export const FROM_BLOCK = 23_178_731
export const TO_BLOCK = 26_051_931
export const MAX_CHUNK_BLOCKS = 50_000
export const DEFAULT_CHUNK_BLOCKS = 8_000
export const ABI = [
  parseAbiItem(
    'event RampA(uint256 old_A, uint256 new_A, uint256 initial_time, uint256 future_time)',
  ),
  parseAbiItem('event StopRampA(uint256 A, uint256 t)'),
]
export const SOURCE = [
  'https://etherscan.io/address/0x390f3595bCa2Df7d23783dFd126427CCeb997BF4#code',
  'https://etherscan.io/address/0x4DEcE678ceceb27446b35C672dC7d61F30bAD69E#code',
]

export function configuredPools(config = loadConfig()) {
  const venue = config.find((v) => v.name === 'scrvUSD' && v.enabled)
  if (!venue) throw new Error('Enabled scrvUSD venue not found')
  const markets = venue.depthMarkets?.filter((m) => m.enabled)
  if (markets?.length !== 2 || markets.some((m) => !/^0x[a-fA-F0-9]{40}$/.test(m.address)))
    throw new Error('Expected exactly two configured scrvUSD exit pools')
  return markets.map((m) => ({ address: m.address, name: m.name || m.address }))
}

export function chunks(from, to, size) {
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from > to ||
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > MAX_CHUNK_BLOCKS
  )
    throw new Error('Invalid bounded chunk range')
  const result = []
  for (let start = from; start <= to; start += size)
    result.push({ fromBlock: start, toBlock: Math.min(to, start + size - 1) })
  return result
}

export function eventKey(event) {
  return `${event.pool.toLowerCase()}:${event.txHash.toLowerCase()}:${event.logIndex}`
}

export function decodeRampLog(log, timestamp, expectedPool) {
  if (log.address.toLowerCase() !== expectedPool.toLowerCase())
    throw new Error(`Pool mismatch in log ${log.transactionHash}`)
  if (!/^0x[a-fA-F0-9]{64}$/.test(log.transactionHash || ''))
    throw new Error('Missing transaction hash')
  const block = Number(log.blockNumber)
  const logIndex = Number(log.logIndex)
  if (
    !Number.isSafeInteger(block) ||
    !Number.isSafeInteger(logIndex) ||
    !Number.isSafeInteger(timestamp)
  )
    throw new Error('Invalid log coordinate or timestamp')
  const decoded = decodeEventLog({ abi: ABI, data: log.data, topics: log.topics, strict: true })
  const args = Object.fromEntries(
    Object.entries(decoded.args).map(([key, value]) => [key, value.toString()]),
  )
  return {
    pool: expectedPool,
    type: decoded.eventName,
    block,
    logIndex,
    txHash: log.transactionHash,
    timestamp,
    args,
  }
}

export function normalizeEvents(events) {
  const byKey = new Map()
  for (const event of events) {
    const key = eventKey(event)
    if (byKey.has(key) && JSON.stringify(byKey.get(key)) !== JSON.stringify(event))
      throw new Error(`Conflicting duplicate event ${key}`)
    byKey.set(key, event)
  }
  return [...byKey.values()].sort(
    (a, b) => a.block - b.block || a.logIndex - b.logIndex || a.pool.localeCompare(b.pool),
  )
}

export function summarize(events, pools) {
  const byPool = Object.fromEntries(pools.map((p) => [p.address, { RampA: 0, StopRampA: 0 }]))
  for (const event of events) {
    const pool = pools.find((p) => p.address.toLowerCase() === event.pool.toLowerCase())
    if (!pool || !['RampA', 'StopRampA'].includes(event.type)) throw new Error('Unexpected event')
    byPool[pool.address][event.type]++
  }
  return { total: events.length, byPool }
}

export function validateResume(saved, expected) {
  if (
    saved?.study !== expected.study ||
    saved.from !== expected.from ||
    saved.to !== expected.to ||
    saved.chunkBlocks !== expected.chunkBlocks ||
    !Array.isArray(saved.pools) ||
    JSON.stringify(saved.pools.map((p) => p.address.toLowerCase())) !==
      JSON.stringify(expected.pools.map((p) => p.address.toLowerCase())) ||
    !Number.isSafeInteger(saved.nextChunk) ||
    saved.nextChunk < 0 ||
    saved.nextChunk > chunks(expected.from, expected.to, expected.chunkBlocks).length ||
    !['partial', 'complete'].includes(saved.status) ||
    (saved.status === 'complete' &&
      saved.nextChunk !== chunks(expected.from, expected.to, expected.chunkBlocks).length) ||
    !Array.isArray(saved.events)
  )
    throw new Error('Resume artifact does not match this census')
  const ranges = chunks(expected.from, expected.to, expected.chunkBlocks)
  const through = saved.nextChunk ? ranges[saved.nextChunk - 1].toBlock : expected.from - 1
  if (
    saved.events.some(
      (event) =>
        !Number.isSafeInteger(event.block) ||
        event.block < expected.from ||
        event.block > through ||
        !Number.isSafeInteger(event.logIndex) ||
        event.logIndex < 0 ||
        !Number.isSafeInteger(event.timestamp) ||
        !/^0x[a-fA-F0-9]{64}$/.test(event.txHash || ''),
    )
  )
    throw new Error('Resume artifact event lies outside completed chunks or is malformed')
  if (normalizeEvents(saved.events).length !== saved.events.length)
    throw new Error('Resume artifact has duplicate events')
  const summary = summarize(saved.events, expected.pools)
  if (saved.status === 'complete' && JSON.stringify(saved.summary) !== JSON.stringify(summary))
    throw new Error('Resume artifact summary mismatch')
  return saved
}

function atomicJson(path, value) {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value))
  renameSync(tmp, path)
}

export async function collect({
  client,
  pools,
  from = FROM_BLOCK,
  to = TO_BLOCK,
  chunkBlocks = DEFAULT_CHUNK_BLOCKS,
  out,
}) {
  const ranges = chunks(from, to, chunkBlocks)
  const expected = {
    study: 'Curve crvUSD exit-pool RampA/StopRampA census',
    source: SOURCE,
    from,
    to,
    chunkBlocks,
    pools,
    status: 'partial',
    nextChunk: 0,
    events: [],
  }
  let result = existsSync(out)
    ? validateResume(JSON.parse(readFileSync(out, 'utf8')), expected)
    : expected
  const timestampCache = new Map()
  for (let i = result.nextChunk; i < ranges.length; i++) {
    const range = ranges[i]
    const found = []
    for (const pool of pools) {
      const logs = await client.getLogs({
        address: pool.address,
        events: ABI,
        fromBlock: BigInt(range.fromBlock),
        toBlock: BigInt(range.toBlock),
      })
      for (const log of logs) {
        const block = Number(log.blockNumber)
        if (block < range.fromBlock || block > range.toBlock)
          throw new Error(`Out-of-range log at block ${block}`)
        if (!timestampCache.has(block)) {
          const header = await client.getBlock({ blockNumber: BigInt(block) })
          timestampCache.set(block, Number(header.timestamp))
        }
        found.push(decodeRampLog(log, timestampCache.get(block), pool.address))
      }
    }
    result = { ...result, nextChunk: i + 1, events: normalizeEvents([...result.events, ...found]) }
    atomicJson(out, result)
  }
  result = {
    ...result,
    source: SOURCE,
    status: 'complete',
    summary: summarize(result.events, pools),
  }
  atomicJson(out, result)
  return result
}

function options(args) {
  const result = {}
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith('--') || args[i + 1] === undefined)
      throw new Error('Expected --key value arguments')
    result[args[i].slice(2)] = args[i + 1]
  }
  return result
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const opts = options(process.argv.slice(2))
  const rpc = opts.rpc || process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')
  if (!rpc) throw new Error('Set RECORDER_RPC_URL or --rpc')
  const chunkBlocks =
    opts['chunk-blocks'] === undefined ? DEFAULT_CHUNK_BLOCKS : Number(opts['chunk-blocks'])
  const out = opts.out || '/private/tmp/scrvusd-rampa-census-400d.json'
  const result = await collect({
    client: makeClient(rpc),
    pools: configuredPools(),
    chunkBlocks,
    out,
  })
  process.stdout.write(
    JSON.stringify({
      path: out,
      status: result.status,
      chunks: result.nextChunk,
      summary: result.summary,
    }) + '\n',
  )
}
