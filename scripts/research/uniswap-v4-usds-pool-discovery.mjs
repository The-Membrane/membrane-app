// Bounded candidate discovery, not a USDS exit route or liquidity assay.
// ABI: https://github.com/Uniswap/v4-core/blob/main/src/interfaces/IPoolManager.sol
// PoolId: https://github.com/Uniswap/v4-core/blob/main/src/types/PoolId.sol
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
import { pathToFileURL } from 'node:url'
import {
  decodeEventLog,
  encodeAbiParameters,
  keccak256,
  padHex,
  parseAbi,
  parseAbiParameters,
  toEventSelector,
} from 'viem'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'

export const STUDY = 'uniswap-v4-usds-initialize-candidates-v1'
export const OUT = resolve('data/research/venue-signals/uniswap-v4-usds-initialize')
export const MAX_BLOCKS = 256
export const CHUNK_BLOCKS = 64
export const RESERVE_BYTES = 1_073_741_824
const MAX_LOGS_PER_QUERY = 1000
const MANAGER = '0x000000000004444c5dc75cb358380d2e3de08a90'
const TOKENS = Object.freeze({
  USDS: '0xdc035d45d973e3ec169d2276ddab16f1e407384f',
  USDC: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  USDT: '0xdac17f958d2ee523a2206206994597c13d831ec7',
  PYUSD: '0x6c3ea9036406852006290770bedfcaba0e23a0e8',
})
const PAIRS = Object.freeze([
  ['USDS', 'USDC'],
  ['USDS', 'USDT'],
  ['USDS', 'PYUSD'],
  ['USDT', 'USDC'],
  ['PYUSD', 'USDC'],
])
const ABI = parseAbi([
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
])
const TOPIC = toEventSelector(ABI[0]).toLowerCase()
const KEY = parseAbiParameters(
  'address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks',
)
const HASH = /^0x[0-9a-f]{64}$/
const HEX = /^0x(?:[0-9a-f]{2})*$/
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const lower = (s) => (typeof s === 'string' ? s.toLowerCase() : '')
const seal = (v) => ({ ...v, sha256: sha(JSON.stringify(v)) })
const withoutSha = ({ sha256: _sha256, ...rest }) => rest
const hexBlock = (n) => `0x${n.toString(16)}`
function need(ok, why) {
  if (!ok) throw new Error(why)
}
function integer(v, label) {
  need(
    (typeof v === 'string' && /^0x[0-9a-f]+$/i.test(v)) ||
      (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0),
    `Invalid ${label}`,
  )
  const n = Number(BigInt(v))
  need(Number.isSafeInteger(n) && n >= 0, `Unsafe ${label}`)
  return n
}
function block(v, expected) {
  const n = integer(v?.number, 'block number')
  need(
    HASH.test(lower(v?.hash)) && (expected === undefined || n === expected),
    'Invalid block header',
  )
  return { number: n, hash: lower(v.hash), timestamp: integer(v.timestamp, 'timestamp') }
}
function guard(out, stat = statfsSync, extra = 0) {
  let p = out
  while (!existsSync(p)) {
    const parent = dirname(p)
    need(parent !== p, 'No output filesystem')
    p = parent
  }
  const fs = stat(p)
  need(Number(fs.bavail) * Number(fs.bsize) - extra >= RESERVE_BYTES, 'Disk reserve reached')
}
function pairFilter(pair) {
  const [x, y] = pair.map((symbol) => TOKENS[symbol]).sort()
  need(x && y && x !== y, 'Unrecognized pair')
  return {
    address: MANAGER,
    topics: [TOPIC, null, padHex(x, { size: 32 }), padHex(y, { size: 32 })],
  }
}
function rawLog(v, first, last, filter) {
  need(v && v.removed !== true && lower(v.removed) !== 'true', 'Removed log')
  const n = integer(v.blockNumber, 'log block'),
    tx = integer(v.transactionIndex, 'tx index')
  const index = integer(v.logIndex, 'log index')
  need(n >= first && n <= last && lower(v.address) === MANAGER, 'Wrong log range/emitter')
  need(HASH.test(lower(v.blockHash)) && HASH.test(lower(v.transactionHash)), 'Missing log hashes')
  need(
    Array.isArray(v.topics) &&
      v.topics.length === 4 &&
      v.topics.every((t) => HASH.test(lower(t))) &&
      filter.topics.every((t, i) => t === null || lower(v.topics[i]) === t),
    'Wrong Initialize topics',
  )
  need(HEX.test(lower(v.data)) && v.data.length === 2 + 5 * 64, 'Wrong Initialize data')
  return {
    address: MANAGER,
    blockNumber: n,
    blockHash: lower(v.blockHash),
    transactionHash: lower(v.transactionHash),
    transactionIndex: tx,
    logIndex: index,
    topics: v.topics.map(lower),
    data: lower(v.data),
  }
}
function candidate(raw, pair) {
  const d = decodeEventLog({ abi: ABI, data: raw.data, topics: raw.topics, strict: true })
  need(d.eventName === 'Initialize', 'Wrong decoded event')
  const a = d.args
  const currency0 = lower(a.currency0),
    currency1 = lower(a.currency1),
    hooks = lower(a.hooks)
  need(
    currency0 < currency1 && hooks.startsWith('0x') && hooks.length === 42,
    'Invalid PoolKey currencies or hook',
  )
  need(BigInt(a.fee) <= 1_000_000n || BigInt(a.fee) === 0x800000n, 'Invalid V4 fee')
  need(a.tickSpacing > 0 && a.tickSpacing <= 32767, 'Invalid V4 tick spacing')
  const id = keccak256(
    encodeAbiParameters(KEY, [currency0, currency1, Number(a.fee), a.tickSpacing, hooks]),
  ).toLowerCase()
  need(id === lower(a.id), 'PoolId/PoolKey mismatch')
  return {
    pair: [...pair],
    poolId: id,
    currency0,
    currency1,
    fee: Number(a.fee),
    tickSpacing: a.tickSpacing,
    hooks,
    sqrtPriceX96Raw: String(a.sqrtPriceX96),
    initialTick: a.tick,
    blockNumber: raw.blockNumber,
    blockHash: raw.blockHash,
    transactionHash: raw.transactionHash,
    transactionIndex: raw.transactionIndex,
    logIndex: raw.logIndex,
  }
}
function filename(r) {
  return `v4-usds-${String(r.fromBlock).padStart(12, '0')}-${String(r.toBlock).padStart(12, '0')}-${r.toHash.slice(2)}.json`
}
function replay(r) {
  need(
    r.study === STUDY &&
      r.chainId === 1 &&
      r.poolManager === MANAGER &&
      Number.isSafeInteger(r.fromBlock) &&
      Number.isSafeInteger(r.toBlock) &&
      r.fromBlock >= 0 &&
      r.toBlock >= r.fromBlock &&
      r.toBlock - r.fromBlock + 1 <= MAX_BLOCKS,
    'Invalid V4 receipt window',
  )
  need(
    Number.isSafeInteger(r.finalized?.number) &&
      r.finalized.number >= r.toBlock &&
      HASH.test(r.finalized?.hash) &&
      HASH.test(r.fromHash) &&
      HASH.test(r.toHash),
    'Unfinalized or unpinned V4 receipt',
  )
  if (r.finalized.number === r.toBlock)
    need(r.finalized.hash === r.toHash, 'Finalized hash mismatch')
  need(
    Number.isFinite(Date.parse(r.captureStartedAt)) &&
      Date.parse(r.captureEndedAt) >= Date.parse(r.captureStartedAt),
    'Invalid capture clocks',
  )
  const expectedChunks = []
  for (let first = r.fromBlock; first <= r.toBlock; first += CHUNK_BLOCKS)
    for (const pair of PAIRS)
      expectedChunks.push({ first, last: Math.min(first + CHUNK_BLOCKS - 1, r.toBlock), pair })
  need(
    Array.isArray(r.chunks) && r.chunks.length === expectedChunks.length,
    'Incomplete pair/chunk coverage',
  )
  const required = new Set([r.fromBlock, r.toBlock])
  const observed = []
  const seen = new Set()
  for (let i = 0; i < expectedChunks.length; i++) {
    const chunk = r.chunks[i],
      e = expectedChunks[i]
    need(
      chunk.first === e.first &&
        chunk.last === e.last &&
        JSON.stringify(chunk.pair) === JSON.stringify(e.pair) &&
        JSON.stringify(chunk.filter) === JSON.stringify(pairFilter(e.pair)) &&
        chunk.status === 'rpc-returned-not-independently-proven' &&
        HASH.test(chunk.firstHash) &&
        HASH.test(chunk.lastHash) &&
        Array.isArray(chunk.logs) &&
        chunk.logs.length < MAX_LOGS_PER_QUERY,
      'Invalid V4 chunk',
    )
    required.add(chunk.first)
    required.add(chunk.last)
    for (const v of chunk.logs) {
      const raw = rawLog(v, chunk.first, chunk.last, chunk.filter)
      need(JSON.stringify(v) === JSON.stringify(raw), 'Noncanonical raw log')
      required.add(raw.blockNumber)
      const key = `${raw.blockHash}:${raw.logIndex}`
      need(!seen.has(key), 'Duplicate V4 log across queries')
      seen.add(key)
      observed.push(candidate(raw, e.pair))
    }
  }
  need(Array.isArray(r.headers) && r.headers.length === required.size, 'Missing V4 headers')
  const headers = new Map()
  let prev = r.fromBlock - 1
  for (const h of r.headers) {
    need(
      Number.isSafeInteger(h?.number) &&
        h.number > prev &&
        required.has(h.number) &&
        HASH.test(h.hash) &&
        Number.isSafeInteger(h.timestamp),
      'Invalid V4 header',
    )
    headers.set(h.number, h.hash)
    prev = h.number
  }
  need(
    headers.get(r.fromBlock) === r.fromHash && headers.get(r.toBlock) === r.toHash,
    'V4 endpoint header mismatch',
  )
  for (const chunk of r.chunks) {
    need(
      headers.get(chunk.first) === chunk.firstHash && headers.get(chunk.last) === chunk.lastHash,
      'V4 chunk header mismatch',
    )
    for (const log of chunk.logs)
      need(headers.get(log.blockNumber) === log.blockHash, 'V4 log/header mismatch')
  }
  need(JSON.stringify(observed) === JSON.stringify(r.candidates), 'V4 candidate replay mismatch')
  need(
    r.caveat ===
      'Candidate PoolKeys only; no route, TVL, liquidity, depth, executable quote, or independent RPC log completeness.',
    'Missing V4 scope caveat',
  )
  return { count: observed.length }
}
export function verify({ out = OUT } = {}) {
  if (!existsSync(out)) return { status: 'absent', receipts: 0, candidates: null, coverage: null }
  const files = readdirSync(out)
    .filter((f) => f.endsWith('.json'))
    .sort()
  if (files.length === 0) return { status: 'empty', receipts: 0, candidates: null, coverage: null }
  let candidates = 0
  const windows = new Set()
  const ranges = []
  const canonical = new Map()
  for (const file of files) {
    const saved = JSON.parse(readFileSync(join(out, file), 'utf8'))
    need(saved.sha256 === sha(JSON.stringify(withoutSha(saved))), 'V4 receipt SHA mismatch')
    const r = withoutSha(saved)
    need(file === filename(r), 'V4 receipt filename mismatch')
    const window = `${r.fromBlock}:${r.toBlock}`
    need(!windows.has(window), 'Duplicate V4 window')
    windows.add(window)
    candidates += replay(r).count
    ranges.push({ fromBlock: r.fromBlock, toBlock: r.toBlock })
    for (const header of r.headers) {
      const prior = canonical.get(header.number)
      need(!prior || prior === header.hash, 'Conflicting V4 canonical header across receipts')
      canonical.set(header.number, header.hash)
    }
  }
  ranges.sort((a, b) => a.fromBlock - b.fromBlock || a.toBlock - b.toBlock)
  const gaps = [],
    overlaps = []
  let frontier = ranges[0].toBlock
  for (const range of ranges.slice(1)) {
    if (range.fromBlock > frontier + 1)
      gaps.push({ fromBlock: frontier + 1, toBlock: range.fromBlock - 1 })
    else if (range.fromBlock <= frontier)
      overlaps.push({ fromBlock: range.fromBlock, toBlock: Math.min(frontier, range.toBlock) })
    frontier = Math.max(frontier, range.toBlock)
  }
  const classification =
    gaps.length && overlaps.length
      ? 'gapped-and-overlapping'
      : gaps.length
        ? 'gapped'
        : overlaps.length
          ? 'overlapping'
          : 'contiguous'
  return {
    status: 'present',
    receipts: files.length,
    candidates,
    coverage: {
      classification,
      fromBlock: ranges[0].fromBlock,
      toBlock: frontier,
      gaps,
      overlaps,
      ranges,
    },
  }
}
export async function collect({
  client,
  fromBlock,
  toBlock,
  out = OUT,
  stat = statfsSync,
  now = () => new Date(),
} = {}) {
  need(client?.request, 'One RPC client required')
  need(
    Number.isSafeInteger(fromBlock) &&
      Number.isSafeInteger(toBlock) &&
      fromBlock >= 0 &&
      toBlock >= fromBlock &&
      toBlock - fromBlock + 1 <= MAX_BLOCKS,
    'Invalid or unbounded V4 window',
  )
  guard(out, stat)
  verify({ out })
  const captureStartedAt = now().toISOString()
  const request = (method, params) => client.request({ method, params })
  need(integer(await request('eth_chainId', []), 'chain ID') === 1, 'Wrong chain')
  const finalized = block(await request('eth_getBlockByNumber', ['finalized', false]))
  need(toBlock <= finalized.number, 'V4 window is not finalized')
  const headers = new Map()
  const getHeader = async (n) => {
    if (!headers.has(n))
      headers.set(n, block(await request('eth_getBlockByNumber', [hexBlock(n), false]), n))
    return headers.get(n)
  }
  const firstHeader = await getHeader(fromBlock),
    lastHeader = await getHeader(toBlock)
  if (toBlock === finalized.number) need(lastHeader.hash === finalized.hash, 'Finalized hash drift')
  const chunks = [],
    candidates = []
  for (let first = fromBlock; first <= toBlock; first += CHUNK_BLOCKS) {
    const last = Math.min(first + CHUNK_BLOCKS - 1, toBlock)
    const a = await getHeader(first),
      b = await getHeader(last)
    for (const pair of PAIRS) {
      const filter = pairFilter(pair)
      const returned = await request('eth_getLogs', [
        {
          fromBlock: hexBlock(first),
          toBlock: hexBlock(last),
          ...filter,
        },
      ])
      need(
        Array.isArray(returned) && returned.length < MAX_LOGS_PER_QUERY,
        'Missing, oversized, or potentially truncated V4 log page',
      )
      const logs = []
      for (const value of returned) {
        const raw = rawLog(value, first, last, filter)
        need(raw.blockHash === (await getHeader(raw.blockNumber)).hash, 'V4 log header mismatch')
        logs.push(raw)
        candidates.push(candidate(raw, pair))
      }
      chunks.push({
        first,
        last,
        pair: [...pair],
        filter,
        status: 'rpc-returned-not-independently-proven',
        firstHash: a.hash,
        lastHash: b.hash,
        logs,
      })
    }
  }
  for (const [n, h] of headers)
    need(
      block(await request('eth_getBlockByNumber', [hexBlock(n), false]), n).hash === h.hash,
      'V4 canonical header drift',
    )
  const receipt = seal({
    study: STUDY,
    chainId: 1,
    poolManager: MANAGER,
    fromBlock,
    toBlock,
    fromHash: firstHeader.hash,
    toHash: lastHeader.hash,
    finalized: { number: finalized.number, hash: finalized.hash },
    captureStartedAt,
    captureEndedAt: now().toISOString(),
    headers: [...headers.values()].sort((a, b) => a.number - b.number),
    chunks,
    candidates,
    caveat:
      'Candidate PoolKeys only; no route, TVL, liquidity, depth, executable quote, or independent RPC log completeness.',
  })
  replay(withoutSha(receipt))
  const bytes = `${JSON.stringify(receipt)}\n`
  guard(out, stat, Buffer.byteLength(bytes))
  mkdirSync(out, { recursive: true })
  const target = join(out, filename(receipt)),
    temp = `${target}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 })
    linkSync(temp, target)
  } finally {
    if (existsSync(temp)) unlinkSync(temp)
  }
  return { status: 'recorded', path: target, candidates: candidates.length }
}
function options(args) {
  const parsed = { run: false, verify: false }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--run' && !parsed.run) parsed.run = true
    else if (arg === '--verify' && !parsed.verify) parsed.verify = true
    else if (['--from', '--to', '--out', '--rpc'].includes(arg) && parsed[arg] === undefined)
      parsed[arg] = args[++i]
    else throw new Error('Unknown or duplicate V4 option')
  }
  need(!(parsed.run && parsed.verify), 'Incompatible modes')
  return parsed
}
async function main() {
  const opts = options(process.argv.slice(2))
  if (opts.verify) return console.log(JSON.stringify(verify({ out: opts['--out'] || OUT })))
  if (!opts.run)
    return console.log(
      JSON.stringify({
        mode: 'dry',
        study: STUDY,
        manager: MANAGER,
        pairs: PAIRS,
        maxBlocks: MAX_BLOCKS,
        candidateOnly: true,
      }),
    )
  const rpc =
    opts['--rpc'] ||
    (process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL'))?.split(',')[0]?.trim()
  need(rpc, 'One RPC host required')
  const result = await collect({
    client: makeClient(rpc),
    fromBlock: Number(opts['--from']),
    toBlock: Number(opts['--to']),
    out: opts['--out'] || OUT,
  })
  console.log(JSON.stringify(result))
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(() => {
    console.error(JSON.stringify({ status: 'error', study: STUDY, reason: 'collector_failed' }))
    process.exitCode = 1
  })
