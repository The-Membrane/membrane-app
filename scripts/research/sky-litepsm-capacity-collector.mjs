// Dry-by-default, bounded Sky LitePSM Pocket receipt collector. A successful
// RPC log response is not independent proof that the provider returned all logs.
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
  decodeFunctionResult,
  encodeFunctionData,
  padHex,
  parseAbi,
  toEventSelector,
} from 'viem'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import { reconcileSkyLitePsmPocket } from './sky-litepsm-capacity-reconcile.mjs'

export const STUDY = 'sky-litepsm-pocket-capacity-receipt-v1'
export const OUT = resolve('data/research/venue-signals/sky-litepsm-pocket-receipts')
export const RESERVE_BYTES = 1_073_741_824
export const MAX_BLOCKS = 256
export const CHUNK_BLOCKS = 64
export const MAX_LOGS_PER_QUERY = 1000
const PSM = '0xf6e72db5454dd049d0788e411b06cfaf16853042'
const POCKET = '0x37305b1cd40574e4c5ce33f8e8306be057fd7341'
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const HASH = /^0x[0-9a-f]{64}$/
const HEX = /^0x(?:[0-9a-f]{2})*$/
const RAW = /^(0|[1-9][0-9]*)$/
const SHA = /^[0-9a-f]{64}$/
const STREAMS = ['buyGem', 'sellGem', 'fileUint', 'usdcTransfersOut', 'usdcTransfersIn']
const EVENTS = parseAbi([
  'event BuyGem(address indexed owner, uint256 value, uint256 fee)',
  'event SellGem(address indexed owner, uint256 value, uint256 fee)',
  'event File(bytes32 indexed what, uint256 data)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
])
const CALLS = parseAbi([
  'function pocket() view returns (address)',
  'function gem() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
])
const TOPICS = Object.fromEntries(
  EVENTS.map((event) => [event.name, toEventSelector(event).toLowerCase()]),
)
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const seal = (value) => ({ ...value, sha256: sha(JSON.stringify(value)) })
const withoutSha = ({ sha256: _sha256, ...rest }) => rest
const lower = (value) => (typeof value === 'string' ? value.toLowerCase() : '')
const hexBlock = (value) => `0x${value.toString(16)}`

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}

function number(value, label) {
  requireValue(
    (typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value)) ||
      (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0),
    `Missing ${label}`,
  )
  const n = Number(BigInt(value))
  requireValue(Number.isSafeInteger(n) && n >= 0, `Invalid ${label}`)
  return n
}

function block(value) {
  requireValue(value && HASH.test(lower(value.hash)), 'Invalid canonical block hash')
  return {
    number: number(value.number, 'block number'),
    hash: lower(value.hash),
    timestamp: number(value.timestamp, 'block timestamp'),
  }
}

function diskGuard(out, stat = statfsSync, extra = 0) {
  let path = out
  while (!existsSync(path)) {
    const parent = dirname(path)
    requireValue(parent !== path, 'No output filesystem ancestor')
    path = parent
  }
  const fs = stat(path)
  requireValue(
    Number(fs.bavail) * Number(fs.bsize) - extra >= RESERVE_BYTES,
    'Disk reserve reached',
  )
}

function rawLog(log, label, fromBlock, toBlock) {
  requireValue(
    log && log.removed !== true && lower(log.removed) !== 'true',
    `${label}: removed log`,
  )
  const blockNumber = number(log.blockNumber, `${label} blockNumber`)
  const transactionIndex = number(log.transactionIndex, `${label} transactionIndex`)
  const logIndex = number(log.logIndex, `${label} logIndex`)
  requireValue(blockNumber >= fromBlock && blockNumber <= toBlock, `${label}: out of chunk`)
  requireValue(
    HASH.test(lower(log.blockHash)) && HASH.test(lower(log.transactionHash)),
    `${label}: missing hash`,
  )
  requireValue(/^0x[0-9a-f]{40}$/.test(lower(log.address)), `${label}: invalid emitter`)
  requireValue(
    Array.isArray(log.topics) && log.topics.every((topic) => HASH.test(lower(topic))),
    `${label}: invalid topics`,
  )
  requireValue(HEX.test(lower(log.data)), `${label}: invalid data`)
  return {
    address: lower(log.address),
    blockNumber,
    blockHash: lower(log.blockHash),
    transactionHash: lower(log.transactionHash),
    transactionIndex,
    logIndex,
    topics: log.topics.map(lower),
    data: lower(log.data),
  }
}

function coords(log) {
  return {
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    transactionHash: log.transactionHash,
    transactionIndex: log.transactionIndex,
    logIndex: log.logIndex,
  }
}

function filterFor(stream) {
  if (stream === 'buyGem') return { address: PSM, topics: [TOPICS.BuyGem] }
  if (stream === 'sellGem') return { address: PSM, topics: [TOPICS.SellGem] }
  if (stream === 'fileUint') return { address: PSM, topics: [TOPICS.File] }
  if (stream === 'usdcTransfersOut')
    return { address: USDC, topics: [TOPICS.Transfer, padHex(POCKET, { size: 32 })] }
  if (stream === 'usdcTransfersIn')
    return { address: USDC, topics: [TOPICS.Transfer, null, padHex(POCKET, { size: 32 })] }
  throw new Error('Unknown Sky stream')
}

function project(log, stream) {
  const eventName =
    stream === 'buyGem'
      ? 'BuyGem'
      : stream === 'sellGem'
        ? 'SellGem'
        : stream === 'fileUint'
          ? 'File'
          : 'Transfer'
  const filter = filterFor(stream)
  requireValue(
    log.address === filter.address &&
      log.topics.length === (stream.startsWith('usdcTransfers') ? 3 : 2) &&
      log.topics[0] === TOPICS[eventName] &&
      filter.topics.every((topic, i) => topic === null || topic === log.topics[i]),
    'Wrong Sky emitter, event or filtered topic',
  )
  const decoded = decodeEventLog({ abi: EVENTS, topics: log.topics, data: log.data, strict: true })
  requireValue(decoded.eventName === eventName, 'Wrong decoded Sky event')
  if (stream === 'buyGem' || stream === 'sellGem')
    return {
      ...coords(log),
      emitter: log.address,
      owner: lower(decoded.args.owner),
      valueRaw: String(decoded.args.value),
      feeRaw: String(decoded.args.fee),
    }
  if (stream === 'fileUint')
    return {
      ...coords(log),
      emitter: log.address,
      what: lower(decoded.args.what),
      dataRaw: String(decoded.args.data),
    }
  return {
    ...coords(log),
    token: log.address,
    from: lower(decoded.args.from),
    to: lower(decoded.args.to),
    amountRaw: String(decoded.args.value),
  }
}

function replayChunk(chunk, stream, canonical) {
  requireValue(
    STREAMS.includes(stream) &&
      chunk.stream === stream &&
      chunk.status === 'rpc-returned-complete-not-independently-proven' &&
      HASH.test(chunk.firstHash) &&
      HASH.test(chunk.lastHash) &&
      Number.isSafeInteger(chunk.fromBlock) &&
      Number.isSafeInteger(chunk.toBlock) &&
      chunk.toBlock >= chunk.fromBlock &&
      chunk.toBlock - chunk.fromBlock < CHUNK_BLOCKS,
    'Invalid Sky chunk boundaries',
  )
  if (canonical)
    requireValue(
      canonical.get(chunk.fromBlock) === chunk.firstHash &&
        canonical.get(chunk.toBlock) === chunk.lastHash,
      'Sky chunk boundary/header hash mismatch',
    )
  const query = chunk.query
  requireValue(
    query &&
      JSON.stringify(query.filter) === JSON.stringify(filterFor(stream)) &&
      Array.isArray(query.logs) &&
      query.logs.length < MAX_LOGS_PER_QUERY,
    'Invalid or missing raw Sky query',
  )
  const seen = new Set()
  return query.logs.map((log, i) => {
    const row = rawLog(log, `${stream}[${i}]`, chunk.fromBlock, chunk.toBlock)
    requireValue(JSON.stringify(row) === JSON.stringify(log), 'Noncanonical raw Sky log fields')
    const key = `${row.blockHash}:${row.logIndex}`
    requireValue(!seen.has(key), 'Duplicate raw Sky log')
    seen.add(key)
    if (row.blockNumber === chunk.fromBlock)
      requireValue(row.blockHash === chunk.firstHash, 'Sky first boundary hash mismatch')
    if (row.blockNumber === chunk.toBlock)
      requireValue(row.blockHash === chunk.lastHash, 'Sky last boundary hash mismatch')
    if (canonical)
      requireValue(
        canonical.get(row.blockNumber) === row.blockHash,
        'Sky raw log/header hash mismatch',
      )
    return project(row, stream)
  })
}

function receiptName(receipt) {
  return `sky-litepsm-${String(receipt.from.blockNumber).padStart(12, '0')}-${String(receipt.to.blockNumber).padStart(12, '0')}-${receipt.to.blockHash.slice(2)}.json`
}

function append(out, receipt, stat) {
  const bytes = `${JSON.stringify(receipt)}\n`
  diskGuard(out, stat, Buffer.byteLength(bytes))
  mkdirSync(out, { recursive: true })
  const target = join(out, receiptName(receipt))
  const temp = `${target}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 })
    linkSync(temp, target)
  } finally {
    if (existsSync(temp)) unlinkSync(temp)
  }
  return target
}

export function verify({ out = OUT } = {}) {
  if (!existsSync(out)) return { count: 0 }
  const files = readdirSync(out)
    .filter((name) => name.endsWith('.json'))
    .sort()
  const windows = new Set()
  for (const file of files) {
    const saved = JSON.parse(readFileSync(join(out, file), 'utf8'))
    requireValue(
      saved.sha256 === sha(JSON.stringify(withoutSha(saved))),
      'Sky receipt SHA mismatch',
    )
    const receipt = withoutSha(saved)
    requireValue(
      receipt.study === STUDY && file === receiptName(receipt),
      'Wrong Sky receipt identity',
    )
    const window = `${receipt.from.blockNumber}:${receipt.to.blockNumber}`
    requireValue(!windows.has(window), 'Duplicate Sky window receipt')
    windows.add(window)
    requireValue(
      receipt.chainId === 1 &&
        receipt.psm === PSM &&
        receipt.pocket === POCKET &&
        receipt.usdc === USDC,
      'Wrong Sky route',
    )
    requireValue(
      Number.isFinite(Date.parse(receipt.captureStartedAt)) &&
        Number.isFinite(Date.parse(receipt.captureEndedAt)) &&
        Date.parse(receipt.captureEndedAt) >= Date.parse(receipt.captureStartedAt),
      'Invalid Sky capture clock',
    )
    requireValue(
      receipt.to.blockNumber > receipt.from.blockNumber &&
        receipt.to.blockNumber - receipt.from.blockNumber <= MAX_BLOCKS &&
        receipt.finalized?.number >= receipt.to.blockNumber &&
        HASH.test(receipt.finalized?.hash) &&
        (receipt.finalized.number !== receipt.to.blockNumber ||
          receipt.finalized.hash === receipt.to.blockHash),
      'Invalid Sky finalized window',
    )
    requireValue(
      Array.isArray(receipt.identities) &&
        receipt.identities.length === 2 &&
        [receipt.from, receipt.to].every(
          (end, i) =>
            Number.isSafeInteger(end.blockNumber) &&
            HASH.test(end.blockHash) &&
            RAW.test(end.pocketUsdcRaw) &&
            receipt.identities[i]?.blockNumber === end.blockNumber &&
            receipt.identities[i]?.blockHash === end.blockHash &&
            receipt.identities[i]?.psmPocket === POCKET &&
            receipt.identities[i]?.psmGem === USDC &&
            SHA.test(receipt.identities[i]?.psmCodeSha256) &&
            SHA.test(receipt.identities[i]?.usdcCodeSha256),
        ),
      'Invalid Sky endpoint identities',
    )
    requireValue(Array.isArray(receipt.canonicalBlocks), 'Missing Sky canonical block map')
    const canonical = new Map()
    let previous = receipt.from.blockNumber - 1
    for (const point of receipt.canonicalBlocks) {
      requireValue(
        Number.isSafeInteger(point?.blockNumber) &&
          point.blockNumber > previous &&
          point.blockNumber >= receipt.from.blockNumber &&
          point.blockNumber <= receipt.to.blockNumber &&
          HASH.test(point.blockHash),
        'Invalid Sky canonical block map',
      )
      canonical.set(point.blockNumber, point.blockHash)
      previous = point.blockNumber
    }
    requireValue(
      canonical.get(receipt.from.blockNumber) === receipt.from.blockHash &&
        canonical.get(receipt.to.blockNumber) === receipt.to.blockHash,
      'Sky endpoint/header hash mismatch',
    )
    const requiredCanonical = new Set([receipt.from.blockNumber, receipt.to.blockNumber])
    const coverage = {}
    const logs = {}
    for (const stream of STREAMS) {
      const chunks = receipt.chunks?.[stream]
      requireValue(Array.isArray(chunks) && chunks.length > 0, `Missing Sky ${stream} chunks`)
      coverage[stream] = []
      logs[stream] = []
      for (const chunk of chunks) {
        requireValue(
          chunk.sha256 === sha(JSON.stringify(withoutSha(chunk))),
          'Sky chunk SHA mismatch',
        )
        const projected = replayChunk(chunk, stream, canonical)
        requiredCanonical.add(chunk.fromBlock)
        requiredCanonical.add(chunk.toBlock)
        for (const row of chunk.query.logs) requiredCanonical.add(row.blockNumber)
        requireValue(
          JSON.stringify(projected) === JSON.stringify(chunk.normalized),
          'Sky raw projection mismatch',
        )
        coverage[stream].push({
          fromBlock: chunk.fromBlock,
          toBlock: chunk.toBlock,
          source: 'rpc:eth_getLogs',
          receiptSha256: chunk.sha256,
          complete: true,
        })
        logs[stream].push(...projected)
      }
    }
    requireValue(
      canonical.size === requiredCanonical.size &&
        [...canonical.keys()].every((n) => requiredCanonical.has(n)),
      'Sky canonical block map does not match observed blocks',
    )
    requireValue(
      JSON.stringify(logs) === JSON.stringify(receipt.logs),
      'Sky chunk/log projection mismatch',
    )
    const result = reconcileSkyLitePsmPocket({
      chainId: 1,
      psm: PSM,
      pocket: POCKET,
      usdc: USDC,
      from: { ...receipt.from, ...receipt.identities[0] },
      to: { ...receipt.to, ...receipt.identities[1] },
      coverage,
      logs,
    })
    requireValue(
      JSON.stringify(result) === JSON.stringify(receipt.reconciliation),
      'Sky reconciliation mismatch',
    )
    requireValue(result.endpointMinusTransfersRaw === '0', 'Sky Pocket balance residual is nonzero')
  }
  return { count: files.length }
}

export async function collect({
  client,
  fromBlock,
  toBlock,
  out = OUT,
  stat = statfsSync,
  now = () => new Date(),
} = {}) {
  requireValue(client?.request, 'One RPC client required')
  requireValue(
    Number.isSafeInteger(fromBlock) &&
      Number.isSafeInteger(toBlock) &&
      fromBlock >= 0 &&
      toBlock > fromBlock &&
      toBlock - fromBlock <= MAX_BLOCKS,
    'Invalid or unbounded Sky (A,B]',
  )
  diskGuard(out, stat)
  verify({ out })
  const captureStartedAt = now().toISOString()
  const request = (method, params) => client.request({ method, params })
  requireValue(number(await request('eth_chainId', []), 'chain ID') === 1, 'Wrong chain ID')
  const finalized = block(await request('eth_getBlockByNumber', ['finalized', false]))
  requireValue(toBlock <= finalized.number, 'Sky B is not finalized')
  const getBlock = async (n) => {
    const value = block(await request('eth_getBlockByNumber', [hexBlock(n), false]))
    requireValue(value.number === n, 'Sky canonical block number mismatch')
    return value
  }
  const a = await getBlock(fromBlock)
  const b = await getBlock(toBlock)
  requireValue(
    toBlock !== finalized.number || b.hash === finalized.hash,
    'Sky finalized B hash mismatch',
  )
  const pin = (point) => ({ blockHash: point.hash, requireCanonical: true })
  const call = async (address, functionName, args, point) => {
    const data = encodeFunctionData({ abi: CALLS, functionName, args })
    const result = await request('eth_call', [{ to: address, data }, pin(point)])
    requireValue(
      typeof result === 'string' && /^0x[0-9a-fA-F]+$/.test(result),
      'Incomplete pinned Sky call',
    )
    return decodeFunctionResult({ abi: CALLS, functionName, data: result })
  }
  const code = async (address, point) => {
    const result = lower(await request('eth_getCode', [address, pin(point)]))
    requireValue(/^0x(?:[0-9a-f]{2})+$/.test(result), 'Missing pinned Sky runtime code')
    return sha(Buffer.from(result.slice(2), 'hex'))
  }
  const identities = []
  const endpoints = []
  for (const point of [a, b]) {
    const psmPocket = lower(await call(PSM, 'pocket', [], point))
    const psmGem = lower(await call(PSM, 'gem', [], point))
    requireValue(psmPocket === POCKET && psmGem === USDC, 'Pinned Sky PSM identity mismatch')
    identities.push({
      blockNumber: point.number,
      blockHash: point.hash,
      psmPocket,
      psmGem,
      psmCodeSha256: await code(PSM, point),
      usdcCodeSha256: await code(USDC, point),
    })
    endpoints.push({
      blockNumber: point.number,
      blockHash: point.hash,
      pocketUsdcRaw: String(await call(USDC, 'balanceOf', [POCKET], point)),
    })
  }
  const knownBlocks = new Map([
    [a.number, a.hash],
    [b.number, b.hash],
  ])
  const canonical = async (n) => {
    if (!knownBlocks.has(n)) knownBlocks.set(n, (await getBlock(n)).hash)
    return knownBlocks.get(n)
  }
  const chunks = Object.fromEntries(STREAMS.map((stream) => [stream, []]))
  const logs = Object.fromEntries(STREAMS.map((stream) => [stream, []]))
  for (let first = fromBlock + 1; first <= toBlock; first += CHUNK_BLOCKS) {
    const last = Math.min(first + CHUNK_BLOCKS - 1, toBlock)
    const firstHash = await canonical(first)
    const lastHash = await canonical(last)
    for (const stream of STREAMS) {
      const filter = filterFor(stream)
      const response = await request('eth_getLogs', [
        { fromBlock: hexBlock(first), toBlock: hexBlock(last), ...filter },
      ])
      requireValue(
        Array.isArray(response) && response.length < MAX_LOGS_PER_QUERY,
        `${stream}: missing, oversized, or potentially truncated log page`,
      )
      const seen = new Set()
      const raw = []
      for (let i = 0; i < response.length; i++) {
        const row = rawLog(response[i], `${stream}[${i}]`, first, last)
        const key = `${row.blockHash}:${row.logIndex}`
        requireValue(!seen.has(key), 'Duplicate Sky log within one query')
        seen.add(key)
        requireValue(
          row.blockHash === (await canonical(row.blockNumber)),
          'Sky log block hash mismatch',
        )
        raw.push(row)
      }
      const chunk = seal({
        stream,
        status: 'rpc-returned-complete-not-independently-proven',
        fromBlock: first,
        toBlock: last,
        firstHash,
        lastHash,
        query: { filter, logs: raw },
        normalized: raw.map((row) => project(row, stream)),
      })
      requireValue(
        JSON.stringify(replayChunk(chunk, stream)) === JSON.stringify(chunk.normalized),
        'Sky raw projection mismatch',
      )
      chunks[stream].push(chunk)
      logs[stream].push(...chunk.normalized)
    }
  }
  const coverage = Object.fromEntries(
    STREAMS.map((stream) => [
      stream,
      chunks[stream].map((chunk) => ({
        fromBlock: chunk.fromBlock,
        toBlock: chunk.toBlock,
        source: 'rpc:eth_getLogs',
        receiptSha256: chunk.sha256,
        complete: true,
      })),
    ]),
  )
  const reconciliation = reconcileSkyLitePsmPocket({
    chainId: 1,
    psm: PSM,
    pocket: POCKET,
    usdc: USDC,
    from: { ...endpoints[0], ...identities[0] },
    to: { ...endpoints[1], ...identities[1] },
    coverage,
    logs,
  })
  requireValue(
    reconciliation.endpointMinusTransfersRaw === '0',
    'Sky Pocket balance residual is nonzero',
  )
  for (const [n, expectedHash] of knownBlocks)
    requireValue((await getBlock(n)).hash === expectedHash, 'Sky canonical block hash drift')
  const canonicalBlocks = [...knownBlocks]
    .sort(([a], [b]) => a - b)
    .map(([blockNumber, blockHash]) => ({ blockNumber, blockHash }))
  const receipt = seal({
    study: STUDY,
    chainId: 1,
    psm: PSM,
    pocket: POCKET,
    usdc: USDC,
    captureStartedAt,
    captureEndedAt: now().toISOString(),
    finalized: { number: finalized.number, hash: finalized.hash },
    from: endpoints[0],
    to: endpoints[1],
    identities,
    canonicalBlocks,
    chunks,
    logs,
    reconciliation,
    caveat:
      'One RPC host, returned log ranges and pinned Pocket arithmetic only; not independent log completeness, causal intent, or executable exit capacity.',
  })
  const path = append(out, receipt, stat)
  return {
    status: 'recorded',
    path,
    fromBlock,
    toBlock,
    endpointResidualRaw: reconciliation.endpointMinusTransfersRaw,
  }
}

function options(args) {
  const parsed = { run: false, verify: false, out: OUT }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--run' && !parsed.run) parsed.run = true
    else if (arg === '--verify' && !parsed.verify) parsed.verify = true
    else if (['--from', '--to', '--out', '--rpc'].includes(arg) && !parsed[arg])
      parsed[arg] = args[++i]
    else throw new Error('Unknown or duplicate Sky option')
  }
  requireValue(!(parsed.run && parsed.verify), 'Incompatible Sky modes')
  return parsed
}

async function main() {
  const parsed = options(process.argv.slice(2))
  if (parsed.verify) return console.log(JSON.stringify(verify({ out: parsed['--out'] || OUT })))
  if (!parsed.run)
    return console.log(JSON.stringify({ mode: 'dry', study: STUDY, maxBlocks: MAX_BLOCKS }))
  const rpc =
    parsed['--rpc'] ||
    (process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL'))?.split(',')[0]?.trim()
  requireValue(rpc, 'One RPC host required')
  const result = await collect({
    client: makeClient(rpc),
    fromBlock: Number(parsed['--from']),
    toBlock: Number(parsed['--to']),
    out: parsed['--out'] || OUT,
  })
  console.log(JSON.stringify(result))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(() => {
    console.error(JSON.stringify({ status: 'error', study: STUDY, reason: 'collector_failed' }))
    process.exitCode = 1
  })
