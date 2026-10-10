// Bounded, read-only recent Transfer recipient sample for the fixed-holder exit pilot.
// It is not a holder census, evidence of key control, or an executable withdrawal.
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
import { decodeFunctionResult, encodeFunctionData, keccak256, parseAbi, stringToHex } from 'viem'
import {
  OUT as QUOTE_OUT,
  readValidatedCheckpoints,
  sourceIdentity,
} from './curve-prospective-quote.mjs'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'

export const STUDY = 'scrvusd-share-holder-seed-v1'
export const OUT = resolve('data/research/venue-signals/scrvusd-share-holder-seed')
export const RANGE_BLOCKS = 1000
export const LOG_CHUNK_BLOCKS = 500
export const MAX_RECIPIENTS = 128
export const MIN_ASSETS_RAW = 1000n * 10n ** 18n
export const MAX_QUOTE_AGE_SECONDS = 7200
export const TRANSFER_TOPIC = keccak256(stringToHex('Transfer(address,address,uint256)'))
const RESERVE_BYTES = 1_073_741_824
const HASH = /^0x[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const UINT = /^(0|[1-9][0-9]*)$/
const CODE = /^0x(?:[0-9a-f]{2})*$/
const ABI = parseAbi([
  'function asset() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function maxWithdraw(address) view returns (uint256)',
])
const CAVEAT =
  'Recent Transfer recipients are candidates, not a full holder census, proof of key control, or executable withdrawals. Quiet ranges and log completeness are attested by one RPC host.'
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const seal = (payload) => ({ ...payload, sha256: sha(JSON.stringify(payload)) })
const unsigned = ({ sha256: _sha256, ...rest }) => rest
const hex = (value) => String(value).toLowerCase()
const blockTag = (number) => `0x${number.toString(16)}`
const decimal = (value) => String(BigInt(value))

function checkpointRef(row) {
  return {
    filename: row.filename,
    logicalSha256: row.checkpoint.sha256,
    physicalSha256: row.physicalSha256,
    block: row.checkpoint.block,
    captureEndUtc: row.checkpoint.captureEndUtc,
  }
}

function canonicalLog(log, { vault, start, end }) {
  const block = Number(BigInt(log.blockNumber))
  const transactionIndex = Number(BigInt(log.transactionIndex))
  const logIndex = Number(BigInt(log.logIndex))
  const topics = log.topics?.map(hex)
  if (
    log.removed === true ||
    hex(log.address) !== vault ||
    block < start ||
    block > end ||
    !Number.isSafeInteger(transactionIndex) ||
    transactionIndex < 0 ||
    !Number.isSafeInteger(logIndex) ||
    logIndex < 0 ||
    !HASH.test(hex(log.blockHash)) ||
    !HASH.test(hex(log.transactionHash)) ||
    topics?.length !== 3 ||
    topics[0] !== TRANSFER_TOPIC ||
    !/^0x0{24}[0-9a-f]{40}$/.test(topics[1]) ||
    !/^0x0{24}[0-9a-f]{40}$/.test(topics[2]) ||
    !/^0x[0-9a-f]{64}$/.test(hex(log.data))
  )
    throw new Error('Invalid Transfer log response')
  return {
    block,
    blockHash: hex(log.blockHash),
    transactionIndex,
    transactionHash: hex(log.transactionHash),
    logIndex,
    from: `0x${topics[1].slice(-40)}`,
    to: `0x${topics[2].slice(-40)}`,
    sharesRaw: decimal(hex(log.data)),
  }
}

function validateLogs(logs, start, end, startHash, endHash) {
  const seen = new Set()
  const blockHashes = new Map()
  for (let i = 0; i < logs.length; i++) {
    const log = logs[i]
    const coord = `${log.block}:${log.transactionIndex}:${log.logIndex}`
    if (
      !Number.isSafeInteger(log.block) ||
      log.block < start ||
      log.block > end ||
      !HASH.test(log.blockHash) ||
      !HASH.test(log.transactionHash) ||
      !Number.isSafeInteger(log.transactionIndex) ||
      log.transactionIndex < 0 ||
      !Number.isSafeInteger(log.logIndex) ||
      log.logIndex < 0 ||
      !ADDRESS.test(log.from) ||
      !ADDRESS.test(log.to) ||
      !UINT.test(log.sharesRaw) ||
      (log.block === start && log.blockHash !== startHash) ||
      (log.block === end && log.blockHash !== endHash) ||
      (blockHashes.has(log.block) && blockHashes.get(log.block) !== log.blockHash) ||
      seen.has(coord) ||
      (i > 0 &&
        `${String(logs[i - 1].block).padStart(12, '0')}:${String(logs[i - 1].transactionIndex).padStart(10, '0')}:${String(logs[i - 1].logIndex).padStart(10, '0')}` >=
          `${String(log.block).padStart(12, '0')}:${String(log.transactionIndex).padStart(10, '0')}:${String(log.logIndex).padStart(10, '0')}`)
    )
      throw new Error('Ambiguous Transfer log ordering or coordinates')
    seen.add(coord)
    blockHashes.set(log.block, log.blockHash)
  }
}

function readResults(results, recipients) {
  if (results.length !== recipients.length) throw new Error('Recipient result count mismatch')
  const candidates = []
  let failed = false
  for (let i = 0; i < results.length; i++) {
    const row = results[i]
    if (
      row.address !== recipients[i] ||
      !['eligible', 'contract', 'dust_or_empty', 'rpc_unavailable'].includes(row.status)
    )
      throw new Error('Invalid recipient result')
    if (row.status === 'rpc_unavailable') {
      if (row.code !== null || row.balanceSharesRaw !== null || row.maxWithdrawAssetsRaw !== null)
        throw new Error('Invalid failed read')
      failed = true
      continue
    }
    if (
      !CODE.test(row.code) ||
      !UINT.test(row.balanceSharesRaw) ||
      !UINT.test(row.maxWithdrawAssetsRaw)
    )
      throw new Error('Invalid pinned recipient read')
    const expected =
      row.code !== '0x'
        ? 'contract'
        : BigInt(row.balanceSharesRaw) > 0n && BigInt(row.maxWithdrawAssetsRaw) >= MIN_ASSETS_RAW
          ? 'eligible'
          : 'dust_or_empty'
    if (row.status !== expected) throw new Error('Recipient eligibility mismatch')
    if (expected === 'eligible') candidates.push(row.address)
  }
  return { candidates, failed }
}

export function validateReceipt(
  receipt,
  { identity = sourceIdentity(), checkpoints, nowUtc = new Date().toISOString() } = {},
) {
  if (!receipt || receipt.sha256 !== sha(JSON.stringify(unsigned(receipt))))
    throw new Error('Seed receipt SHA mismatch')
  const row = checkpoints?.find((candidate) => candidate.filename === receipt.checkpoint?.filename)
  const { start, end, startHash, endHash, ranges } = receipt.window || {}
  if (
    receipt.study !== STUDY ||
    receipt.kind !== 'recent-transfer-recipient-sample' ||
    receipt.caveat !== CAVEAT ||
    JSON.stringify(receipt.source) !== JSON.stringify(identity) ||
    !row ||
    JSON.stringify(receipt.checkpoint) !== JSON.stringify(checkpointRef(row)) ||
    !Number.isSafeInteger(start) ||
    start < 0 ||
    end !== row.checkpoint.block.number ||
    end - start + 1 !== RANGE_BLOCKS ||
    !Array.isArray(ranges) ||
    ranges.length !== 2 ||
    ranges[0]?.start !== start ||
    ranges[0]?.end !== start + LOG_CHUNK_BLOCKS - 1 ||
    ranges[1]?.start !== start + LOG_CHUNK_BLOCKS ||
    ranges[1]?.end !== end ||
    ranges[0]?.startHash !== startHash ||
    ranges[1]?.endHash !== endHash ||
    !HASH.test(ranges[0]?.endHash) ||
    !HASH.test(ranges[1]?.startHash) ||
    !HASH.test(startHash) ||
    endHash !== row.checkpoint.block.hash ||
    !Number.isFinite(Date.parse(receipt.captureStartUtc)) ||
    !Number.isFinite(Date.parse(receipt.captureEndUtc)) ||
    !Number.isFinite(Date.parse(nowUtc)) ||
    Date.parse(receipt.captureStartUtc) < Date.parse(row.checkpoint.captureEndUtc) ||
    Date.parse(receipt.captureStartUtc) < row.checkpoint.block.timestamp * 1000 ||
    Date.parse(receipt.captureStartUtc) >
      row.checkpoint.block.timestamp * 1000 + MAX_QUOTE_AGE_SECONDS * 1000 ||
    Date.parse(receipt.captureEndUtc) < Date.parse(receipt.captureStartUtc) ||
    Date.parse(receipt.captureEndUtc) >
      row.checkpoint.block.timestamp * 1000 + MAX_QUOTE_AGE_SECONDS * 1000 ||
    Date.parse(receipt.captureEndUtc) > Date.parse(nowUtc) ||
    !Array.isArray(receipt.logs) ||
    !Array.isArray(receipt.recipients) ||
    !Array.isArray(receipt.results) ||
    !Array.isArray(receipt.candidates)
  )
    throw new Error('Invalid seed source, window, or capture time')
  validateLogs(receipt.logs, start, end, startHash, endHash)
  for (const range of ranges) {
    if (
      !Number.isSafeInteger(range.logCount) ||
      range.logCount < 0 ||
      receipt.logs.filter((entry) => entry.block >= range.start && entry.block <= range.end)
        .length !== range.logCount ||
      receipt.logs.some(
        (entry) =>
          (entry.block === range.start && entry.blockHash !== range.startHash) ||
          (entry.block === range.end && entry.blockHash !== range.endHash),
      )
    )
      throw new Error('Transfer half-range mismatch')
  }
  const recipients = [...new Set(receipt.logs.map((log) => log.to))].sort()
  if (JSON.stringify(recipients) !== JSON.stringify(receipt.recipients))
    throw new Error('Transfer recipient set mismatch')
  if (recipients.length > MAX_RECIPIENTS) {
    if (
      receipt.status !== 'unavailable' ||
      receipt.reason !== 'recipient_bound_exceeded' ||
      receipt.results.length ||
      receipt.candidates.length
    )
      throw new Error('Recipient bound status mismatch')
  } else {
    const { candidates, failed } = readResults(receipt.results, recipients)
    if (
      receipt.status !== (failed ? 'unavailable' : 'sampled') ||
      receipt.reason !== (failed ? 'rpc_read_ambiguous' : null) ||
      JSON.stringify(receipt.candidates) !== JSON.stringify(failed ? [] : candidates)
    )
      throw new Error('Candidate status mismatch')
  }
  return receipt
}

export async function capture({
  client,
  checkpoints,
  identity = sourceIdentity(),
  now = () => new Date(),
} = {}) {
  if (!client?.request) throw new Error('One RPC client is required')
  const rows = checkpoints ?? readValidatedCheckpoints({ out: QUOTE_OUT, identity })
  const row = rows.at(-1)
  if (!row) return { status: 'unavailable', reason: 'no_validated_quote' }
  const at = row.checkpoint.block
  if (at.number < RANGE_BLOCKS - 1) throw new Error('Insufficient preceding blocks')
  const start = at.number - RANGE_BLOCKS + 1
  const captureStartUtc = now().toISOString()
  if (
    Date.parse(captureStartUtc) < Date.parse(row.checkpoint.captureEndUtc) ||
    Date.parse(captureStartUtc) < at.timestamp * 1000 ||
    Date.parse(captureStartUtc) > at.timestamp * 1000 + MAX_QUOTE_AGE_SECONDS * 1000
  )
    throw new Error('Quote is stale or captured after seed start')
  const request = (method, params) => client.request({ method, params })
  if (Number(BigInt(await request('eth_chainId', []))) !== identity.chainId)
    throw new Error('Wrong chain')
  const block = async (number) => {
    const value = await request('eth_getBlockByNumber', [blockTag(number), false])
    if (Number(BigInt(value?.number)) !== number || !HASH.test(hex(value?.hash)))
      throw new Error('Invalid canonical block response')
    return hex(value.hash)
  }
  const startHash = await block(start)
  if ((await block(at.number)) !== at.hash) throw new Error('Quote block identity changed')
  const middleLeft = start + LOG_CHUNK_BLOCKS - 1
  const middleRight = middleLeft + 1
  const middleLeftHash = await block(middleLeft)
  const middleRightHash = await block(middleRight)
  const finalized = await request('eth_getBlockByNumber', ['finalized', false])
  if (Number(BigInt(finalized?.number)) < at.number) throw new Error('Quote block is not finalized')
  const pin = { blockHash: at.hash, requireCanonical: true }
  const call = async (functionName, args = []) =>
    decodeFunctionResult({
      abi: ABI,
      functionName,
      data: await request('eth_call', [
        { to: identity.vault, data: encodeFunctionData({ abi: ABI, functionName, args }) },
        pin,
      ]),
    })
  if (hex(await call('asset')) !== identity.crvUsd) throw new Error('Vault asset identity changed')
  const ranges = [
    { start, end: middleLeft, startHash, endHash: middleLeftHash },
    { start: middleRight, end: at.number, startHash: middleRightHash, endHash: at.hash },
  ]
  const logs = []
  for (const range of ranges) {
    const rawLogs = await request('eth_getLogs', [
      {
        address: identity.vault,
        fromBlock: blockTag(range.start),
        toBlock: blockTag(range.end),
        topics: [TRANSFER_TOPIC],
      },
    ])
    if (!Array.isArray(rawLogs)) throw new Error('Invalid Transfer half-range response')
    const part = rawLogs.map((log) =>
      canonicalLog(log, {
        vault: identity.vault,
        start: range.start,
        end: range.end,
      }),
    )
    validateLogs(part, range.start, range.end, range.startHash, range.endHash)
    range.logCount = part.length
    logs.push(...part)
  }
  validateLogs(logs, start, at.number, startHash, at.hash)
  for (const [number, claimedHash] of new Map(
    logs.map((entry) => [entry.block, entry.blockHash]),
  )) {
    if ((await block(number)) !== claimedHash)
      throw new Error('Transfer log block identity mismatch')
  }
  const recipients = [...new Set(logs.map((log) => log.to))].sort()
  const results = []
  if (recipients.length <= MAX_RECIPIENTS) {
    for (const address of recipients) {
      try {
        const code = hex(await request('eth_getCode', [address, pin]))
        if (!CODE.test(code)) throw new Error('Invalid code response')
        const balanceSharesRaw = decimal(await call('balanceOf', [address]))
        const maxWithdrawAssetsRaw = decimal(await call('maxWithdraw', [address]))
        const status =
          code !== '0x'
            ? 'contract'
            : BigInt(balanceSharesRaw) > 0n && BigInt(maxWithdrawAssetsRaw) >= MIN_ASSETS_RAW
              ? 'eligible'
              : 'dust_or_empty'
        results.push({ address, status, code, balanceSharesRaw, maxWithdrawAssetsRaw })
      } catch {
        results.push({
          address,
          status: 'rpc_unavailable',
          code: null,
          balanceSharesRaw: null,
          maxWithdrawAssetsRaw: null,
        })
      }
    }
  }
  if (
    (await block(start)) !== startHash ||
    (await block(middleLeft)) !== middleLeftHash ||
    (await block(middleRight)) !== middleRightHash ||
    (await block(at.number)) !== at.hash
  )
    throw new Error('Block identity changed during sample')
  const { candidates, failed } = readResults(
    results,
    recipients.length > MAX_RECIPIENTS ? [] : recipients,
  )
  const status = recipients.length > MAX_RECIPIENTS || failed ? 'unavailable' : 'sampled'
  const receipt = seal({
    study: STUDY,
    kind: 'recent-transfer-recipient-sample',
    source: identity,
    checkpoint: checkpointRef(row),
    window: { start, end: at.number, startHash, endHash: at.hash, ranges },
    captureStartUtc,
    captureEndUtc: now().toISOString(),
    logs,
    recipients,
    results,
    status,
    reason:
      recipients.length > MAX_RECIPIENTS
        ? 'recipient_bound_exceeded'
        : failed
          ? 'rpc_read_ambiguous'
          : null,
    candidates: status === 'sampled' ? candidates : [],
    caveat: CAVEAT,
  })
  return validateReceipt(receipt, { identity, checkpoints: rows, nowUtc: now().toISOString() })
}

function guard(out, stat = statfsSync, extra = 0) {
  let ancestor = out
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor)
    if (parent === ancestor) throw new Error('No output ancestor')
    ancestor = parent
  }
  const fs = stat(ancestor)
  if (Number(fs.bavail) * Number(fs.bsize) - extra < RESERVE_BYTES)
    throw new Error('Seed disk reserve reached')
}

export function save({
  receipt,
  out = OUT,
  quoteOut = QUOTE_OUT,
  identity = sourceIdentity(),
  stat = statfsSync,
} = {}) {
  const checkpoints = readValidatedCheckpoints({ out: quoteOut, identity })
  validateReceipt(receipt, { identity, checkpoints })
  const file = join(
    out,
    `${String(receipt.window.end).padStart(12, '0')}-${receipt.window.endHash.slice(2)}.json`,
  )
  if (existsSync(file)) throw new Error('Seed receipt already exists')
  const bytes = JSON.stringify(receipt) + '\n'
  guard(out, stat, Buffer.byteLength(bytes))
  mkdirSync(out, { recursive: true })
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 })
    linkSync(temp, file)
  } finally {
    if (existsSync(temp)) unlinkSync(temp)
  }
  return file
}

export function verify({ out = OUT, quoteOut = QUOTE_OUT, identity = sourceIdentity() } = {}) {
  const checkpoints = readValidatedCheckpoints({ out: quoteOut, identity })
  if (!existsSync(out)) return { count: 0, latestBlock: null }
  const files = readdirSync(out)
    .filter((name) => name.endsWith('.json'))
    .sort()
  const seen = new Set()
  let latestBlock = null
  for (const name of files) {
    const receipt = JSON.parse(readFileSync(join(out, name), 'utf8'))
    validateReceipt(receipt, { identity, checkpoints })
    if (
      name !==
        `${String(receipt.window.end).padStart(12, '0')}-${receipt.window.endHash.slice(2)}.json` ||
      seen.has(receipt.window.end)
    )
      throw new Error('Seed filename or duplicate block mismatch')
    seen.add(receipt.window.end)
    latestBlock = receipt.window.end
  }
  return { count: files.length, latestBlock }
}

export function parseCli(args) {
  if (args.length === 0 || (args.length === 1 && args[0] === '--verify'))
    return { mode: '--verify', rpcIndex: 0 }
  if (args.length === 1 && args[0] === '--run') return { mode: '--run', rpcIndex: 0 }
  if (
    args.length === 3 &&
    args[0] === '--run' &&
    args[1] === '--rpc-index' &&
    /^(0|[1-9][0-9]*)$/.test(args[2])
  ) {
    const rpcIndex = Number(args[2])
    if (Number.isSafeInteger(rpcIndex)) return { mode: '--run', rpcIndex }
  }
  throw new Error('Invalid seed CLI arguments')
}

export function selectConfiguredRpc(configured, index) {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error('Invalid RPC index')
  const urls = configured
    ? String(configured)
        .split(',')
        .map((url) => url.trim())
    : []
  if (index >= urls.length || !urls[index]) throw new Error('Configured RPC index unavailable')
  const selected = urls[index]
  const parsed = new URL(selected)
  if (!['https:', 'http:'].includes(parsed.protocol) || !parsed.hostname)
    throw new Error('Invalid selected RPC URL')
  return selected
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { mode, rpcIndex } = parseCli(process.argv.slice(2))
    if (mode === '--verify') console.log(JSON.stringify(verify()))
    else {
      verify()
      const configured = process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL') || ''
      const rpc = selectConfiguredRpc(configured, rpcIndex)
      const receipt = await capture({ client: makeClient(rpc) })
      if (receipt.sha256)
        console.log(
          JSON.stringify({
            file: save({ receipt }),
            status: receipt.status,
            reason: receipt.reason,
            candidateCount: receipt.candidates.length,
          }),
        )
      else console.log(JSON.stringify(receipt))
    }
  } catch {
    console.error('[scrvusd-share-holder-seed] unavailable')
    process.exitCode = 1
  }
}
