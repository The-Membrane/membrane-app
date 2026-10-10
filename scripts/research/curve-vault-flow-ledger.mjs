// Research-only, append-only coverage ledger for scrvUSD ERC-4626 events.
// A completed quiet range is evidence of zero matching logs in the RPC response;
// it is not evidence that exits were executable or that gross venue flow is known.
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
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import {
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  parseAbi,
  parseAbiItem,
  toEventHash,
} from 'viem'
import { loadConfig, makeClient, readEnv } from '../lib/venue-reads.mjs'
import { readValidatedCheckpoints } from './curve-prospective-quote.mjs'
import { classifyVaultFlowError } from './curve-vault-flow-error-class.mjs'

export const STUDY = 'scrvusd-vault-flow-coverage-v1'
export const OUT = resolve('data/research/venue-signals/scrvusd-vault-flow-ledger')
export const HISTORICAL_OUT = resolve('data/research/venue-signals/scrvusd-vault-flow-history')
export const HISTORICAL_FROM_BLOCK = 23_187_231
export const HISTORICAL_TO_BLOCK = 26_070_875
export const HISTORICAL_QUOTE_SHA256 =
  'ad1ef837f8050fec53dadd220553168510a8227e83e0520b57185b122a16224a'
export const FIRST_LIVE_BLOCK = 26_070_876
export const FIRST_LIVE_BLOCK_HASH =
  '0x3089d303802dee4932be2e37386eb1185735241b39d0fe9d8ab37b07a735213a'
export const FIRST_LIVE_RECEIPT_SHA256 =
  '791b0e67bdb645eb5f9272bb9fdfb22d8dc9d843823b3c787a8727636bd1701c'
export const RESERVE_BYTES = 1_073_741_824
export const MAX_RANGE = 1000
export const MAX_LOGS = 1000
export const MAX_CHUNKS = 32
export const MAX_PACE_MS = 10_000
const MAX_RECEIPT_BYTES = 2 * 1024 * 1024
const VAULT = '0x0655977feb2f289a4ab78af67bab0d17aab84367'
const CRVUSD = '0xf939e0a03fb07f59a73314e73794be0e57ac1b4e'
const HASH = /^0x[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const RAW = /^(0|[1-9][0-9]*)$/
const DEPOSIT = parseAbiItem(
  'event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)',
)
const WITHDRAW = parseAbiItem(
  'event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)',
)
const ASSET_ABI = parseAbi(['function asset() view returns (address)'])
const STREAMS = Object.freeze([
  { kind: 'deposit', topic0: toEventHash(DEPOSIT).toLowerCase(), event: DEPOSIT },
  { kind: 'withdraw', topic0: toEventHash(WITHDRAW).toLowerCase(), event: WITHDRAW },
])
const sha = (data) => createHash('sha256').update(data).digest('hex')
const seal = (payload) => ({ ...payload, sha256: sha(JSON.stringify(payload)) })
const unsigned = ({ sha256: _seal, ...payload }) => payload
const lower = (value) => (typeof value === 'string' ? value.toLowerCase() : '')
const hexQuantity = (n) => `0x${n.toString(16)}`
const integer = (n) => Number.isSafeInteger(n) && n >= 0
const parseQuantity = (value) => {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value))
    throw new Error('Malformed RPC quantity')
  const n = Number(BigInt(value))
  if (!integer(n)) throw new Error('Unsafe RPC quantity')
  return n
}

export function sourceIdentity(venues = loadConfig()) {
  const matches = venues.filter((venue) => venue.name === 'scrvUSD' && venue.enabled)
  if (
    matches.length !== 1 ||
    matches[0].kind !== 'erc4626-cooldown' ||
    lower(matches[0].address) !== VAULT ||
    lower(matches[0].underlying) !== CRVUSD ||
    matches[0].decimals !== 18
  )
    throw new Error('Configured scrvUSD vault identity changed')
  const source = {
    chainId: 1,
    vault: VAULT,
    asset: CRVUSD,
    assetDecimals: 18,
    streams: STREAMS.map(({ kind, topic0 }) => ({ kind, address: VAULT, topic0 })),
  }
  return { ...source, identitySha256: sha(JSON.stringify(source)) }
}

function block(value) {
  const result = {
    number: parseQuantity(value?.number),
    hash: lower(value?.hash),
    timestamp: parseQuantity(value?.timestamp),
  }
  if (!HASH.test(result.hash) || result.timestamp <= 0) throw new Error('Malformed block')
  return result
}

function decodeLog(value, source) {
  if (
    lower(value?.address) !== source.vault ||
    !Array.isArray(value?.topics) ||
    ![3, 4].includes(value.topics.length) ||
    value.topics.some((topic) => !HASH.test(lower(topic))) ||
    !/^0x[0-9a-f]{128}$/i.test(value.data || '') ||
    (value.removed !== undefined && value.removed !== false)
  )
    throw new Error('Malformed vault event log')
  const topic0 = lower(value.topics[0])
  const stream = STREAMS.find((s) => s.topic0 === topic0)
  if (!stream || value.topics.length !== (stream.kind === 'deposit' ? 3 : 4))
    throw new Error('Unexpected vault event signature')
  const blockNumber = parseQuantity(value.blockNumber)
  const logIndex = parseQuantity(value.logIndex)
  const transactionIndex = parseQuantity(value.transactionIndex)
  const blockHash = lower(value.blockHash)
  const transactionHash = lower(value.transactionHash)
  if (!HASH.test(blockHash) || !HASH.test(transactionHash))
    throw new Error('Missing event block or transaction hash')
  let args
  try {
    args = decodeEventLog({
      abi: [stream.event],
      topics: value.topics,
      data: value.data,
      strict: true,
    }).args
  } catch {
    throw new Error('Vault event ABI decode failed')
  }
  const actors =
    stream.kind === 'deposit'
      ? { sender: lower(args.sender), owner: lower(args.owner) }
      : { sender: lower(args.sender), receiver: lower(args.receiver), owner: lower(args.owner) }
  if (Object.values(actors).some((address) => !ADDRESS.test(address)))
    throw new Error('Malformed vault event actors')
  return {
    kind: stream.kind,
    blockNumber,
    blockHash,
    transactionHash,
    transactionIndex,
    logIndex,
    actors,
    assetsRaw: args.assets.toString(),
    sharesRaw: args.shares.toString(),
    raw: {
      address: lower(value.address),
      topics: value.topics.map(lower),
      data: lower(value.data),
    },
  }
}

function eventOrder(a, b) {
  return (
    a.blockNumber - b.blockNumber ||
    a.transactionIndex - b.transactionIndex ||
    a.logIndex - b.logIndex
  )
}

export function validateReceipt(saved, source, previous) {
  if (!saved || saved.sha256 !== sha(JSON.stringify(unsigned(saved))))
    throw new Error('Vault flow receipt SHA mismatch')
  const p = unsigned(saved)
  if (
    p.study !== STUDY ||
    JSON.stringify(p.source) !== JSON.stringify(source) ||
    !integer(p.range?.from?.number) ||
    !integer(p.range?.to?.number) ||
    p.range.to.number < p.range.from.number ||
    p.range.to.number - p.range.from.number + 1 > MAX_RANGE ||
    !HASH.test(p.range.from.hash) ||
    !HASH.test(p.range.to.hash) ||
    !integer(p.range.from.timestamp) ||
    !integer(p.range.to.timestamp) ||
    p.range.from.timestamp > p.range.to.timestamp ||
    !integer(p.finalizedHead?.number) ||
    !HASH.test(p.finalizedHead.hash) ||
    p.range.to.number > p.finalizedHead.number ||
    !integer(p.finalizedHead.timestamp) ||
    p.pin?.mode !== 'finalized-range-boundary-and-event-hash-recheck' ||
    p.pin.streamCrossCheck !== 'combined-and-separate-topics' ||
    p.pin.assetCheck !== 'from-and-to-block-hash' ||
    typeof p.pin.rpcHost !== 'string' ||
    !/^[a-z0-9.-]{1,255}$/.test(p.pin.rpcHost) ||
    !Number.isFinite(Date.parse(p.captureStartUtc)) ||
    !Number.isFinite(Date.parse(p.captureEndUtc)) ||
    Date.parse(p.captureEndUtc) < Date.parse(p.captureStartUtc) ||
    !Array.isArray(p.events) ||
    p.events.length >= MAX_LOGS ||
    p.counts?.deposit !== p.events.filter((e) => e.kind === 'deposit').length ||
    p.counts?.withdraw !== p.events.filter((e) => e.kind === 'withdraw').length ||
    p.previousReceiptSha256 !== (previous?.sha256 || null)
  )
    throw new Error('Invalid vault flow receipt')
  if (previous && p.range.from.number !== previous.range.to.number + 1)
    throw new Error('Vault flow coverage gap or overlap')
  if (previous && p.range.from.timestamp <= previous.range.to.timestamp)
    throw new Error('Vault flow range timestamp did not advance')
  const seen = new Set()
  for (let i = 0; i < p.events.length; i++) {
    const event = p.events[i]
    const decoded = decodeLog(
      {
        ...event.raw,
        blockNumber: hexQuantity(event.blockNumber),
        blockHash: event.blockHash,
        transactionHash: event.transactionHash,
        transactionIndex: hexQuantity(event.transactionIndex),
        logIndex: hexQuantity(event.logIndex),
      },
      source,
    )
    const { blockTimestamp: _timestamp, ...withoutTimestamp } = event
    if (JSON.stringify(decoded) !== JSON.stringify(withoutTimestamp))
      throw new Error('Vault flow event fields mismatch raw log')
    if (
      event.blockNumber < p.range.from.number ||
      event.blockNumber > p.range.to.number ||
      !integer(event.blockTimestamp) ||
      event.blockTimestamp < p.range.from.timestamp ||
      event.blockTimestamp > p.range.to.timestamp ||
      (event.blockNumber === p.range.from.number && event.blockHash !== p.range.from.hash) ||
      (event.blockNumber === p.range.to.number && event.blockHash !== p.range.to.hash) ||
      (i > 0 && eventOrder(p.events[i - 1], event) >= 0)
    )
      throw new Error('Vault flow event outside range or unordered')
    const key = `${event.transactionHash}:${event.logIndex}`
    if (seen.has(key)) throw new Error('Duplicate vault flow event')
    seen.add(key)
  }
  return p
}

function receiptFilename(p) {
  return `${String(p.range.from.number).padStart(12, '0')}-${String(p.range.to.number).padStart(12, '0')}-${p.range.to.hash.slice(2)}.json`
}

export function readValidatedReceipts({ out = OUT, source = sourceIdentity() } = {}) {
  if (!existsSync(out)) return []
  const files = readdirSync(out)
    .filter((name) => name.endsWith('.json'))
    .sort()
  let previous = null
  const seenEvents = new Set()
  const receipts = []
  for (const name of files) {
    const bytes = readFileSync(join(out, name))
    if (bytes.length > MAX_RECEIPT_BYTES) throw new Error('Vault flow receipt size cap')
    const saved = JSON.parse(bytes.toString('utf8'))
    const p = validateReceipt(saved, source, previous)
    if (name !== receiptFilename(p)) throw new Error('Vault flow filename mismatch')
    for (const event of p.events) {
      const key = `${event.transactionHash}:${event.logIndex}`
      if (seenEvents.has(key)) throw new Error('Duplicate vault flow event across receipts')
      seenEvents.add(key)
    }
    receipts.push(saved)
    previous = { ...p, sha256: saved.sha256 }
  }
  return receipts
}

export function verify({ out = OUT, source = sourceIdentity() } = {}) {
  const receipts = readValidatedReceipts({ out, source })
  const first = receipts[0]
  const last = receipts.at(-1)
  return {
    count: receipts.length,
    fromBlock: first?.range.from.number ?? null,
    throughBlock: last?.range.to.number ?? null,
    lastReceiptSha256: last?.sha256 ?? null,
  }
}

export function latestQuoteBoundary(checkpoints = readValidatedCheckpoints()) {
  if (!checkpoints.length) throw new Error('No sealed prospective quote checkpoint')
  const latest = checkpoints.reduce((best, item) =>
    !best || item.checkpoint.block.number > best.checkpoint.block.number ? item : best,
  )
  const { number, hash } = latest.checkpoint.block
  if (!integer(number) || !HASH.test(hash)) throw new Error('Invalid quote checkpoint boundary')
  return { number, hash, checkpointSha256: latest.checkpoint.sha256 }
}

export function verifyLatestQuoteAlignment({
  out = OUT,
  source = sourceIdentity(),
  checkpoints = readValidatedCheckpoints(),
} = {}) {
  const target = latestQuoteBoundary(checkpoints)
  const receipts = readValidatedReceipts({ out, source })
  const end = receipts.at(-1)?.range.to
  if (end?.number !== target.number || end.hash !== target.hash)
    throw new Error('Vault flow frontier is not aligned to latest quote checkpoint')
  return {
    ...verify({ out, source }),
    quoteBlock: target.number,
    quoteCheckpointSha256: target.checkpointSha256,
  }
}

const HISTORICAL_PLAN_FILE = 'scan-plan.meta'

export function historicalPlan({ source = sourceIdentity(), liveOut = OUT } = {}) {
  const first = readValidatedReceipts({ out: liveOut, source })[0]
  if (
    first?.range.from.number !== FIRST_LIVE_BLOCK ||
    first.range.from.hash !== FIRST_LIVE_BLOCK_HASH ||
    first.sha256 !== FIRST_LIVE_RECEIPT_SHA256
  )
    throw new Error('First live vault flow receipt anchor changed or unavailable')
  return seal({
    study: 'scrvusd-vault-flow-historical-scan-plan-v1',
    sourceIdentitySha256: source.identitySha256,
    fromBlock: HISTORICAL_FROM_BLOCK,
    toBlock: HISTORICAL_TO_BLOCK,
    quoteSourcePhysicalSha256: HISTORICAL_QUOTE_SHA256,
    firstLive: {
      block: FIRST_LIVE_BLOCK,
      blockHash: FIRST_LIVE_BLOCK_HASH,
      receiptSha256: FIRST_LIVE_RECEIPT_SHA256,
    },
  })
}

export function ensureHistoricalPlan({
  out = HISTORICAL_OUT,
  source = sourceIdentity(),
  liveOut = OUT,
  stat = statfsSync,
  create = false,
} = {}) {
  const expected = historicalPlan({ source, liveOut })
  const path = join(out, HISTORICAL_PLAN_FILE)
  if (!existsSync(path)) {
    if (!create) throw new Error('Historical scan plan unavailable')
    if (
      existsSync(out) &&
      readdirSync(out, { withFileTypes: true }).some((entry) => entry.name.endsWith('.json'))
    )
      throw new Error('Historical receipts exist without scan plan')
    const bytes = `${JSON.stringify(expected)}\n`
    diskGuard(out, stat, Buffer.byteLength(bytes))
    mkdirSync(out, { recursive: true })
    const temp = `${path}.${randomUUID()}.tmp`
    try {
      writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 })
      linkSync(temp, path)
    } finally {
      if (existsSync(temp)) unlinkSync(temp)
    }
  }
  const actual = JSON.parse(readFileSync(path, 'utf8'))
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error('Historical scan plan mismatch')
  const receipts = readValidatedReceipts({ out, source })
  if (
    (receipts[0] && receipts[0].range.from.number !== expected.fromBlock) ||
    receipts.some((receipt) => receipt.range.to.number > expected.toBlock)
  )
    throw new Error('Historical coverage outside frozen scan bounds')
  return expected
}

function diskGuard(out, stat = statfsSync, extra = 0) {
  let path = out
  while (!existsSync(path)) {
    const parent = dirname(path)
    if (parent === path) throw new Error('No output ancestor')
    path = parent
  }
  const fs = stat(path)
  if (Number(fs.bavail) * Number(fs.bsize) - extra < RESERVE_BYTES)
    throw new Error('Vault flow disk reserve reached')
}

function append(out, receipt, stat) {
  const bytes = `${JSON.stringify(receipt)}\n`
  if (Buffer.byteLength(bytes) > MAX_RECEIPT_BYTES) throw new Error('Vault flow receipt size cap')
  diskGuard(out, stat, Buffer.byteLength(bytes))
  mkdirSync(out, { recursive: true })
  const target = join(out, receiptFilename(receipt))
  const temp = `${target}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 })
    linkSync(temp, target)
  } finally {
    if (existsSync(temp)) unlinkSync(temp)
  }
  return target
}

function isLimit(error) {
  const message = `${error?.message || ''} ${error?.cause?.message || ''}`.toLowerCase()
  return /(?:too many|exceed|more than).*?(?:logs|results|blocks|entries)|(?:query|block) range|result window|response size/.test(
    message,
  )
}

function isRateLimited(error) {
  const message = `${error?.message || ''} ${error?.cause?.message || ''}`.toLowerCase()
  return (
    [error?.status, error?.statusCode, error?.cause?.status, error?.cause?.statusCode].some(
      (status) => Number(status) === 429,
    ) || /\b429\b|rate.?limit|too many requests/.test(message)
  )
}

async function readRange(request, source, fromNumber, toNumber, finalizedHead, rpcHost, now) {
  const captureStartUtc = now().toISOString()
  const getBlock = async (n) =>
    block(await request('eth_getBlockByNumber', [hexQuantity(n), false]))
  const from = await getBlock(fromNumber)
  const to = fromNumber === toNumber ? from : await getBlock(toNumber)
  if (from.number !== fromNumber || to.number !== toNumber)
    throw new Error('RPC block number mismatch')
  const data = encodeFunctionData({ abi: ASSET_ABI, functionName: 'asset' })
  for (const boundary of from.number === to.number ? [from] : [from, to]) {
    const assetData = await request('eth_call', [
      { to: source.vault, data },
      { blockHash: boundary.hash, requireCanonical: true },
    ])
    if (
      lower(decodeFunctionResult({ abi: ASSET_ABI, functionName: 'asset', data: assetData })) !==
      source.asset
    )
      throw new Error('Onchain vault asset identity mismatch')
  }
  const fetchLogs = async (topics) => {
    try {
      return await request('eth_getLogs', [
        {
          fromBlock: hexQuantity(fromNumber),
          toBlock: hexQuantity(toNumber),
          address: source.vault,
          topics: [topics],
        },
      ])
    } catch (error) {
      // A provider throttle is not evidence that a range exceeded its log cap.
      if (isRateLimited(error)) throw error
      if (isLimit(error)) return null
      throw error
    }
  }
  const combined = await fetchLogs(source.streams.map((stream) => stream.topic0))
  if (combined === null) return { split: true }
  if (!Array.isArray(combined)) throw new Error('Malformed combined RPC log result')
  if (combined.length >= MAX_LOGS) return { split: true }
  const events = combined.map((log) => decodeLog(log, source)).sort(eventOrder)
  const separate = []
  for (const stream of source.streams) {
    const raw = await fetchLogs(stream.topic0)
    if (raw === null) return { split: true }
    if (!Array.isArray(raw)) throw new Error('Malformed stream RPC log result')
    if (raw.length >= MAX_LOGS) return { split: true }
    const decoded = raw.map((log) => decodeLog(log, source))
    if (decoded.some((event) => event.kind !== stream.kind))
      throw new Error('RPC stream filter mismatch')
    separate.push(...decoded)
  }
  separate.sort(eventOrder)
  if (JSON.stringify(events) !== JSON.stringify(separate))
    throw new Error('Combined and per-stream vault log mismatch')
  const seen = new Set()
  for (const event of events) {
    if (event.blockNumber < fromNumber || event.blockNumber > toNumber)
      throw new Error('RPC returned event outside requested range')
    const key = `${event.transactionHash}:${event.logIndex}`
    if (seen.has(key)) throw new Error('Duplicate RPC vault log')
    seen.add(key)
  }
  const eventBlocks = new Map([
    [from.number, from],
    [to.number, to],
  ])
  for (const event of events) {
    if (!eventBlocks.has(event.blockNumber))
      eventBlocks.set(event.blockNumber, await getBlock(event.blockNumber))
    const at = eventBlocks.get(event.blockNumber)
    if (at.number !== event.blockNumber || at.hash !== event.blockHash)
      throw new Error('RPC event block hash mismatch')
    event.blockTimestamp = at.timestamp
  }
  const afterFrom = await getBlock(fromNumber)
  const afterTo = fromNumber === toNumber ? afterFrom : await getBlock(toNumber)
  if (
    afterFrom.hash !== from.hash ||
    afterTo.hash !== to.hash ||
    afterFrom.timestamp !== from.timestamp ||
    afterTo.timestamp !== to.timestamp
  )
    throw new Error('Canonical range boundary drift')
  const captureEndUtc = now().toISOString()
  const payload = {
    study: STUDY,
    source,
    range: { from, to },
    finalizedHead,
    captureStartUtc,
    captureEndUtc,
    pin: {
      mode: 'finalized-range-boundary-and-event-hash-recheck',
      rpcHost,
      streamCrossCheck: 'combined-and-separate-topics',
      assetCheck: 'from-and-to-block-hash',
    },
    counts: {
      deposit: events.filter((e) => e.kind === 'deposit').length,
      withdraw: events.filter((e) => e.kind === 'withdraw').length,
    },
    events,
  }
  return { payload }
}

export async function collect({
  client,
  out = OUT,
  source = sourceIdentity(),
  fromBlock,
  toBlock,
  expectedTargetHash,
  maxChunks = 1,
  range = MAX_RANGE,
  rpcHost = 'unknown',
  paceMs = 0,
  stat = statfsSync,
  now = () => new Date(),
  monotonicMs = () => performance.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!client?.request) throw new Error('One RPC client required')
  if (
    !integer(maxChunks) ||
    maxChunks < 1 ||
    maxChunks > MAX_CHUNKS ||
    !integer(range) ||
    range < 1 ||
    range > MAX_RANGE ||
    !integer(paceMs) ||
    paceMs > MAX_PACE_MS ||
    (toBlock !== undefined && (!integer(toBlock) || toBlock < 1)) ||
    (expectedTargetHash !== undefined &&
      (toBlock === undefined || !HASH.test(expectedTargetHash))) ||
    !/^[a-z0-9.-]{1,255}$/.test(rpcHost)
  )
    throw new Error('Invalid bounded scan options')
  diskGuard(out, stat)
  const prior = readValidatedReceipts({ out, source })
  const previousReceipt = prior.at(-1) ?? null
  if (!prior.length && !integer(fromBlock)) throw new Error('First scan requires --from-block')
  const next = previousReceipt ? previousReceipt.range.to.number + 1 : fromBlock
  if (fromBlock !== undefined && fromBlock !== next)
    throw new Error('From-block disagrees with coverage frontier')
  if (toBlock !== undefined && prior.some((receipt) => receipt.range.to.number > toBlock))
    throw new Error('Coverage exceeds requested to-block')
  const seenEvents = new Set(
    prior.flatMap((receipt) =>
      receipt.events.map((event) => `${event.transactionHash}:${event.logIndex}`),
    ),
  )
  let lastRequestStart = null
  const request = async (method, params) => {
    if (paceMs && lastRequestStart !== null) {
      const remaining = lastRequestStart + paceMs - monotonicMs()
      if (remaining > 0) await sleep(remaining)
    }
    if (paceMs) lastRequestStart = monotonicMs()
    return client.request({ method, params })
  }
  if (parseQuantity(await request('eth_chainId', [])) !== 1) throw new Error('Wrong RPC chain ID')
  const finalizedHead = block(await request('eth_getBlockByNumber', ['finalized', false]))
  if (expectedTargetHash !== undefined) {
    if (finalizedHead.number < toBlock) throw new Error('Quote block is not finalized on flow RPC')
    const target = block(await request('eth_getBlockByNumber', [hexQuantity(toBlock), false]))
    if (target.number !== toBlock || target.hash !== expectedTargetHash)
      throw new Error('Flow RPC quote block hash mismatch')
    if (
      previousReceipt?.range.to.number === toBlock &&
      previousReceipt.range.to.hash !== expectedTargetHash
    )
      throw new Error('Existing flow receipt quote block hash mismatch')
  }
  const targetBlock = Math.min(toBlock ?? finalizedHead.number, finalizedHead.number)
  let cursor = next
  let previous = previousReceipt
  const paths = []
  while (paths.length < maxChunks && cursor <= targetBlock) {
    const end = Math.min(cursor + range - 1, targetBlock)
    const result = await readRange(request, source, cursor, end, finalizedHead, rpcHost, now)
    if (result.split) {
      if (end === cursor) throw new Error('Single-block RPC log limit reached')
      range = Math.max(1, Math.floor((end - cursor + 1) / 2))
      continue
    }
    if (
      expectedTargetHash !== undefined &&
      end === toBlock &&
      result.payload.range.to.hash !== expectedTargetHash
    )
      throw new Error('Vault flow receipt quote block hash mismatch')
    for (const event of result.payload.events) {
      const key = `${event.transactionHash}:${event.logIndex}`
      if (seenEvents.has(key)) throw new Error('Duplicate vault flow event across receipts')
    }
    const receipt = seal({ ...result.payload, previousReceiptSha256: previous?.sha256 ?? null })
    validateReceipt(receipt, source, previous)
    const path = append(out, receipt, stat)
    paths.push(path)
    for (const event of receipt.events) seenEvents.add(`${event.transactionHash}:${event.logIndex}`)
    previous = receipt
    cursor = end + 1
  }
  if (expectedTargetHash !== undefined) {
    const target = block(await request('eth_getBlockByNumber', [hexQuantity(toBlock), false]))
    if (target.number !== toBlock || target.hash !== expectedTargetHash)
      throw new Error('Flow RPC quote block hash drift')
    if (cursor > toBlock && previous?.range.to.hash !== expectedTargetHash)
      throw new Error('Vault flow receipt quote block hash mismatch')
  }
  return {
    saved: paths.length,
    paths,
    throughBlock: cursor - 1,
    finalizedHead: finalizedHead.number,
    completeThroughFinalized: cursor > finalizedHead.number,
    targetBlock: toBlock ?? null,
    completeThroughTarget: toBlock === undefined ? null : cursor > toBlock,
  }
}

export async function collectToLatestQuote({ checkpoints, ...options } = {}) {
  const sealedCheckpoints = checkpoints ?? readValidatedCheckpoints()
  const target = latestQuoteBoundary(sealedCheckpoints)
  const result = await collect({
    ...options,
    toBlock: target.number,
    expectedTargetHash: target.hash,
  })
  if (!result.completeThroughTarget)
    throw new Error('Bounded vault flow catch-up did not reach latest quote block')
  if (
    checkpoints === undefined &&
    latestQuoteBoundary(readValidatedCheckpoints()).checkpointSha256 !== target.checkpointSha256
  )
    throw new Error('Latest quote checkpoint changed during vault flow catch-up')
  const aligned = verifyLatestQuoteAlignment({
    out: options.out ?? OUT,
    source: options.source ?? sourceIdentity(),
    checkpoints: sealedCheckpoints,
  })
  return { ...result, quoteCheckpointSha256: aligned.quoteCheckpointSha256 }
}

export function parseOptions(args) {
  const opts = {}
  for (let i = 0; i < args.length; i++) {
    const name = args[i]
    if (
      ![
        '--run',
        '--verify',
        '--from-block',
        '--to-block',
        '--to-latest-quote',
        '--historical',
        '--max-chunks',
        '--range',
        '--rpc',
        '--rpc-index',
        '--pace-ms',
      ].includes(name) ||
      Object.hasOwn(opts, name)
    )
      throw new Error('Unknown or duplicate option')
    const value = ['--run', '--verify', '--historical', '--to-latest-quote'].includes(name)
      ? true
      : args[++i]
    if (!value) throw new Error('Missing option value')
    opts[name] = value
  }
  if (
    (opts['--run'] && opts['--verify']) ||
    (opts['--rpc'] && opts['--rpc-index'] !== undefined) ||
    (opts['--to-latest-quote'] &&
      (opts['--to-block'] || opts['--historical'] || (!opts['--run'] && !opts['--verify']))) ||
    (!opts['--run'] &&
      [
        '--from-block',
        '--to-block',
        '--max-chunks',
        '--range',
        '--rpc',
        '--rpc-index',
        '--pace-ms',
      ].some((x) => opts[x] !== undefined)) ||
    (opts['--historical'] && (opts['--from-block'] || opts['--to-block']))
  )
    throw new Error('Incompatible options')
  return opts
}

function optionalInteger(value, label) {
  if (value === undefined) return undefined
  if (!RAW.test(value)) throw new Error(`Invalid ${label}`)
  const n = Number(value)
  if (!integer(n)) throw new Error(`Invalid ${label}`)
  return n
}

export function selectRpc(explicit, configured, index = 0) {
  if (!integer(index) || (explicit !== undefined && index !== 0))
    throw new Error('Invalid RPC index')
  const urls = typeof configured === 'string' ? configured.split(',').map((url) => url.trim()) : []
  if (explicit === undefined && (index >= urls.length || !urls[index]))
    throw new Error('Configured RPC index unavailable')
  const rpc = explicit === undefined ? urls[index] : explicit
  if (typeof rpc !== 'string' || !rpc.trim() || rpc.includes(','))
    throw new Error('Exactly one RPC URL required')
  const parsed = new URL(rpc)
  if (!['https:', 'http:'].includes(parsed.protocol) || !parsed.hostname)
    throw new Error('Invalid RPC URL')
  return { url: rpc, host: parsed.hostname.toLowerCase() }
}

async function main() {
  const opts = parseOptions(process.argv.slice(2))
  const historical = !!opts['--historical']
  const out = historical ? HISTORICAL_OUT : OUT
  if (opts['--verify']) {
    if (historical) ensureHistoricalPlan({ out })
    return console.log(
      JSON.stringify(
        opts['--to-latest-quote'] ? verifyLatestQuoteAlignment({ out }) : verify({ out }),
      ),
    )
  }
  const source = sourceIdentity()
  if (!opts['--run'])
    return console.log(
      JSON.stringify({
        mode: 'dry',
        study: STUDY,
        out,
        source,
        historical: historical ? historicalPlan({ source }) : null,
        limits: {
          maxRange: MAX_RANGE,
          maxLogs: MAX_LOGS,
          maxChunks: MAX_CHUNKS,
          maxPaceMs: MAX_PACE_MS,
        },
      }),
    )
  const configured = opts['--rpc']
    ? undefined
    : process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')
  const rpc = selectRpc(
    opts['--rpc'],
    configured,
    optionalInteger(opts['--rpc-index'], '--rpc-index') ?? 0,
  )
  if (historical) ensureHistoricalPlan({ out, source, create: true })
  const options = {
    client: makeClient(rpc.url),
    out,
    rpcHost: rpc.host,
    fromBlock: historical
      ? verify({ out, source }).count === 0
        ? HISTORICAL_FROM_BLOCK
        : undefined
      : optionalInteger(opts['--from-block'], '--from-block'),
    toBlock: historical ? HISTORICAL_TO_BLOCK : optionalInteger(opts['--to-block'], '--to-block'),
    maxChunks: optionalInteger(opts['--max-chunks'], '--max-chunks') ?? 1,
    range: optionalInteger(opts['--range'], '--range') ?? MAX_RANGE,
    paceMs: optionalInteger(opts['--pace-ms'], '--pace-ms') ?? 0,
  }
  const result = opts['--to-latest-quote']
    ? await collectToLatestQuote(options)
    : await collect(options)
  if (historical) ensureHistoricalPlan({ out, source })
  console.log(JSON.stringify(result))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    // Provider errors may contain RPC URLs or credentials. Never echo them.
    console.error(`Vault flow collection or verification failed [${classifyVaultFlowError(error)}]`)
    process.exitCode = 1
  })
}
