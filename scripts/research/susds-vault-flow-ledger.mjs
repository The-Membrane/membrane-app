// Research-only sUSDS direct-vault event coverage. Successful onchain events
// describe historical flow, not executable exits, future capacity, or runway.
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { decodeEventLog, keccak256, parseAbiItem, toEventHash } from 'viem'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import {
  OUT as CHECKPOINT_OUT,
  IMPLEMENTATION_SLOT,
  RESERVE_BYTES,
  readValidatedCheckpoints,
  sourceIdentity,
} from './susds-finalized-checkpoint.mjs'

export const STUDY = 'susds-direct-vault-flow-ledger-v1'
export const OUT = resolve('data/research/venue-signals/susds-vault-flow-ledger')
export const MAX_RANGE = 500
export const MAX_LOGS = 1000
export const MAX_CHUNKS = 16
const MAX_RECEIPT_BYTES = 2 * 1024 * 1024
const HASH = /^0x[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const RAW = /^(0|[1-9][0-9]*)$/
const HOST = /^[a-z0-9.-]{1,255}$/
const EVENTS = Object.freeze(
  [
    {
      kind: 'deposit',
      abi: parseAbiItem(
        'event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)',
      ),
    },
    {
      kind: 'withdraw',
      abi: parseAbiItem(
        'event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)',
      ),
    },
  ].map((item) => ({ ...item, topic0: toEventHash(item.abi).toLowerCase() })),
)
const UPGRADED_TOPIC = toEventHash(
  parseAbiItem('event Upgraded(address indexed implementation)'),
).toLowerCase()
const sha = (data) => createHash('sha256').update(data).digest('hex')
const unsigned = ({ sha256: _sha, ...rest }) => rest
const seal = (value) => ({ ...value, sha256: sha(JSON.stringify(value)) })
const lower = (value) => (typeof value === 'string' ? value.toLowerCase() : '')
const quantity = (value) => `0x${value.toString(16)}`
const safe = (value) => Number.isSafeInteger(value) && value >= 0
const parseQuantity = (value) => {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value))
    throw new Error('Malformed RPC quantity')
  const result = Number(BigInt(value))
  if (!safe(result)) throw new Error('Unsafe RPC quantity')
  return result
}
const header = (raw) => {
  const result = {
    number: parseQuantity(raw?.number),
    hash: lower(raw?.hash),
    parentHash: lower(raw?.parentHash),
    timestamp: parseQuantity(raw?.timestamp),
  }
  if (!HASH.test(result.hash) || !HASH.test(result.parentHash) || !result.timestamp)
    throw new Error('Malformed block header')
  return result
}
const filename = (receipt) =>
  `${String(receipt.range.from.number).padStart(12, '0')}-${String(receipt.range.to.number).padStart(12, '0')}-${receipt.range.to.hash.slice(2)}.json`
const planPath = (out) => join(out, 'plan.json')
const receiptsPath = (out) => join(out, 'receipts')

function diskGuard(path, stat = statfsSync, extra = 0) {
  let ancestor = path
  while (!existsSync(ancestor)) ancestor = dirname(ancestor)
  const fs = stat(ancestor)
  if (Number(fs.bavail) * Number(fs.bsize) - extra < RESERVE_BYTES)
    throw new Error('sUSDS flow disk reserve reached')
}
function append(path, value, stat = statfsSync) {
  const bytes = Buffer.from(JSON.stringify(value) + '\n')
  if (bytes.length > MAX_RECEIPT_BYTES) throw new Error('sUSDS receipt size cap')
  diskGuard(path, stat, bytes.length)
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 })
    linkSync(temporary, path)
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}
function readExact(path) {
  const bytes = readFileSync(path)
  if (bytes.length > MAX_RECEIPT_BYTES || !bytes.toString().endsWith('\n'))
    throw new Error('sUSDS flow physical format mismatch')
  const value = JSON.parse(bytes.toString())
  if (
    !bytes.equals(Buffer.from(JSON.stringify(value) + '\n')) ||
    value.sha256 !== sha(JSON.stringify(unsigned(value)))
  )
    throw new Error('sUSDS flow physical or logical seal mismatch')
  return value
}
async function lock(out) {
  mkdirSync(out, { recursive: true })
  const path = join(out, '.collection.lock')
  const until = Date.now() + 5000
  for (;;) {
    try {
      mkdirSync(path, { mode: 0o700 })
      return () => rmdirSync(path)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      if (Date.now() >= until)
        throw new Error('sUSDS flow lock busy or stale; manual audit required')
      await new Promise((done) => setTimeout(done, 25))
    }
  }
}

function checkpointRef(entry) {
  const cp = entry.checkpoint
  if (!cp.contract.implementation || !HASH.test(cp.contract.implementationCodeHash))
    throw new Error('sUSDS checkpoint lacks implementation identity')
  return {
    block: cp.block,
    sha256: cp.sha256,
    physicalSha256: entry.physicalSha256,
    filename: entry.filename,
    vaultCodeHash: cp.contract.vaultCodeHash,
    implementation: cp.contract.implementation,
    implementationCodeHash: cp.contract.implementationCodeHash,
  }
}
export function createPlan({
  checkpoint,
  source = sourceIdentity(),
  rpcHost,
  now = () => new Date(),
}) {
  if (!HOST.test(rpcHost) || !checkpoint?.checkpoint || !checkpoint?.physicalSha256)
    throw new Error('Verified checkpoint and named host required')
  const ref = checkpointRef(checkpoint)
  if (!safe(ref.block.number + 1)) throw new Error('Unsafe start block')
  return seal({
    study: STUDY,
    source,
    checkpoint: ref,
    startBlock: ref.block.number + 1,
    rpcHost,
    createdAtUtc: now().toISOString(),
    evidence: 'checkpoint-anchored-contiguous-combined-and-separate-event-ranges',
    caveat:
      'Checkpoint-anchored backfill may cover blocks mined before plan creation. One RPC host; successful Deposit/Withdraw logs only; complete ranges are provider-attested, not independently exhaustive.',
  })
}
export function readPlan({
  out = OUT,
  source = sourceIdentity(),
  checkpointOut = CHECKPOINT_OUT,
} = {}) {
  const plan = readExact(planPath(out))
  const checkpoints = readValidatedCheckpoints({ out: checkpointOut, identity: source })
  const cp = checkpoints.find((entry) => entry.filename === plan.checkpoint?.filename)
  if (
    !cp ||
    JSON.stringify(plan.source) !== JSON.stringify(source) ||
    JSON.stringify(unsigned(plan)) !==
      JSON.stringify(
        unsigned(
          createPlan({
            checkpoint: cp,
            source,
            rpcHost: plan.rpcHost,
            now: () => new Date(plan.createdAtUtc),
          }),
        ),
      ) ||
    !Number.isFinite(Date.parse(plan.createdAtUtc))
  )
    throw new Error('sUSDS flow plan/checkpoint mismatch')
  return plan
}
export function ensurePlan({
  out = OUT,
  source = sourceIdentity(),
  checkpointOut = CHECKPOINT_OUT,
  rpcHost,
  now,
  stat,
} = {}) {
  if (existsSync(planPath(out))) {
    const plan = readPlan({ out, source, checkpointOut })
    if (plan.rpcHost !== rpcHost) throw new Error('sUSDS flow plan host changed')
    return plan
  }
  if (existsSync(out) && readdirSync(out).filter((name) => name !== '.collection.lock').length)
    throw new Error('sUSDS flow output occupied without plan')
  const checkpoints = readValidatedCheckpoints({ out: checkpointOut, identity: source })
  const checkpoint = checkpoints.at(-1)
  if (!checkpoint) throw new Error('No verified sUSDS checkpoint')
  const plan = createPlan({ checkpoint, source, rpcHost, now })
  append(planPath(out), plan, stat)
  return plan
}

function decodeLog(raw, source) {
  if (
    lower(raw?.address) !== source.vault ||
    !Array.isArray(raw.topics) ||
    raw.topics.some((topic) => !HASH.test(lower(topic))) ||
    !/^0x[0-9a-f]{128}$/i.test(raw.data || '') ||
    (raw.removed !== undefined && raw.removed !== false)
  )
    throw new Error('Malformed sUSDS event log')
  const stream = EVENTS.find((item) => item.topic0 === lower(raw.topics[0]))
  if (!stream || raw.topics.length !== (stream.kind === 'deposit' ? 3 : 4))
    throw new Error('Unexpected sUSDS event signature')
  let args
  try {
    args = decodeEventLog({
      abi: [stream.abi],
      topics: raw.topics,
      data: raw.data,
      strict: true,
    }).args
  } catch {
    throw new Error('sUSDS event ABI decode failed')
  }
  const actors =
    stream.kind === 'deposit'
      ? { sender: lower(args.sender), owner: lower(args.owner) }
      : { sender: lower(args.sender), receiver: lower(args.receiver), owner: lower(args.owner) }
  if (Object.values(actors).some((value) => !ADDRESS.test(value)))
    throw new Error('Malformed sUSDS event actors')
  const blockHash = lower(raw.blockHash),
    transactionHash = lower(raw.transactionHash)
  if (!HASH.test(blockHash) || !HASH.test(transactionHash))
    throw new Error('Missing sUSDS event hash')
  return {
    kind: stream.kind,
    blockNumber: parseQuantity(raw.blockNumber),
    blockHash,
    transactionHash,
    transactionIndex: parseQuantity(raw.transactionIndex),
    logIndex: parseQuantity(raw.logIndex),
    actors,
    assetsRaw: String(args.assets),
    sharesRaw: String(args.shares),
    raw: { address: lower(raw.address), topics: raw.topics.map(lower), data: lower(raw.data) },
  }
}
const compareEvents = (a, b) =>
  a.blockNumber - b.blockNumber ||
  a.transactionIndex - b.transactionIndex ||
  a.logIndex - b.logIndex

export function validateReceipt(receipt, plan, previous = null) {
  if (
    !receipt ||
    receipt.sha256 !== sha(JSON.stringify(unsigned(receipt))) ||
    receipt.study !== STUDY ||
    receipt.planSha256 !== plan.sha256 ||
    JSON.stringify(receipt.source) !== JSON.stringify(plan.source) ||
    !safe(receipt.range?.from?.number) ||
    !safe(receipt.range?.to?.number) ||
    receipt.range.to.number < receipt.range.from.number ||
    receipt.range.to.number - receipt.range.from.number + 1 > MAX_RANGE ||
    !HASH.test(receipt.range.from.hash) ||
    !HASH.test(receipt.range.to.hash) ||
    !safe(receipt.range.from.timestamp) ||
    !safe(receipt.range.to.timestamp) ||
    receipt.range.to.timestamp < receipt.range.from.timestamp ||
    receipt.range.from.number !== (previous ? previous.range.to.number + 1 : plan.startBlock) ||
    receipt.range.from.parentHash !== (previous?.range.to.hash ?? plan.checkpoint.block.hash) ||
    receipt.range.to.number > receipt.finalizedHead?.number ||
    !HASH.test(receipt.finalizedHead.hash) ||
    receipt.previousReceiptSha256 !== (previous?.sha256 ?? null) ||
    receipt.planCreatedAtUtc !== plan.createdAtUtc ||
    receipt.rpcHost !== plan.rpcHost ||
    receipt.completeness !== 'combined-and-separate-topic-results-match-below-cap' ||
    !Number.isFinite(Date.parse(receipt.captureStartUtc)) ||
    !Number.isFinite(Date.parse(receipt.captureEndUtc)) ||
    Date.parse(receipt.captureStartUtc) < Date.parse(plan.createdAtUtc) ||
    Date.parse(receipt.captureEndUtc) < Date.parse(receipt.captureStartUtc) ||
    !Array.isArray(receipt.events) ||
    receipt.events.length >= MAX_LOGS ||
    receipt.code?.vault !== plan.checkpoint.vaultCodeHash ||
    receipt.code?.implementation !== plan.checkpoint.implementation ||
    receipt.code?.implementationCodeHash !== plan.checkpoint.implementationCodeHash
  )
    throw new Error('Invalid sUSDS flow receipt')
  if (previous && receipt.range.from.timestamp <= previous.range.to.timestamp)
    throw new Error('sUSDS flow time did not advance')
  if (
    receipt.events.filter((e) => e.kind === 'deposit').length !== receipt.counts?.deposit ||
    receipt.events.filter((e) => e.kind === 'withdraw').length !== receipt.counts?.withdraw
  )
    throw new Error('sUSDS event counts mismatch')
  const seen = new Set()
  for (let i = 0; i < receipt.events.length; i++) {
    const event = receipt.events[i]
    const decoded = decodeLog(
      {
        ...event.raw,
        blockNumber: quantity(event.blockNumber),
        blockHash: event.blockHash,
        transactionHash: event.transactionHash,
        transactionIndex: quantity(event.transactionIndex),
        logIndex: quantity(event.logIndex),
      },
      plan.source,
    )
    const { blockTimestamp: _time, ...withoutTime } = event
    if (
      JSON.stringify(decoded) !== JSON.stringify(withoutTime) ||
      event.blockNumber < receipt.range.from.number ||
      event.blockNumber > receipt.range.to.number ||
      !safe(event.blockTimestamp) ||
      event.blockTimestamp < receipt.range.from.timestamp ||
      event.blockTimestamp > receipt.range.to.timestamp ||
      (event.blockNumber === receipt.range.from.number &&
        event.blockHash !== receipt.range.from.hash) ||
      (event.blockNumber === receipt.range.to.number &&
        event.blockHash !== receipt.range.to.hash) ||
      (i && compareEvents(receipt.events[i - 1], event) >= 0)
    )
      throw new Error('sUSDS event not ordered or hash-pinned')
    const key = `${event.transactionHash}:${event.logIndex}`
    if (seen.has(key)) throw new Error('Duplicate sUSDS event')
    seen.add(key)
  }
  return receipt
}
export function readValidatedReceipts({
  out = OUT,
  source = sourceIdentity(),
  checkpointOut = CHECKPOINT_OUT,
} = {}) {
  if (!existsSync(planPath(out))) {
    if (existsSync(out) && readdirSync(out).some((name) => name !== '.collection.lock'))
      throw new Error('sUSDS flow output occupied without plan')
    return []
  }
  const plan = readPlan({ out, source, checkpointOut })
  const dir = receiptsPath(out)
  if (!existsSync(dir)) return []
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
  const result = []
  const seen = new Set()
  for (const file of files) {
    const receipt = validateReceipt(readExact(join(dir, file)), plan, result.at(-1))
    if (file !== filename(receipt)) throw new Error('sUSDS receipt filename mismatch')
    for (const event of receipt.events) {
      const key = `${event.transactionHash}:${event.logIndex}`
      if (seen.has(key)) throw new Error('Duplicate sUSDS event across receipts')
      seen.add(key)
    }
    result.push(receipt)
  }
  return result
}
export function verify({
  out = OUT,
  source = sourceIdentity(),
  checkpointOut = CHECKPOINT_OUT,
} = {}) {
  if (!existsSync(planPath(out))) {
    readValidatedReceipts({ out, source, checkpointOut })
    return { study: STUDY, status: 'no_plan', receipts: 0 }
  }
  const plan = readPlan({ out, source, checkpointOut })
  const receipts = readValidatedReceipts({ out, source, checkpointOut })
  return {
    study: STUDY,
    status: 'verified',
    planSha256: plan.sha256,
    checkpointBlock: plan.checkpoint.block.number,
    receipts: receipts.length,
    fromBlock: receipts[0]?.range.from.number ?? null,
    throughBlock: receipts.at(-1)?.range.to.number ?? null,
    caveat: plan.caveat,
  }
}

async function checkCode(request, plan, at) {
  const pin = { blockHash: at.hash, requireCanonical: true }
  const vaultCode = lower(await request('eth_getCode', [plan.source.vault, pin]))
  const slot = lower(
    await request('eth_getStorageAt', [plan.source.vault, IMPLEMENTATION_SLOT, pin]),
  )
  const implementation = `0x${slot.slice(-40)}`
  if (
    !/^0x(?:[0-9a-f]{2})+$/.test(vaultCode) ||
    !HASH.test(slot) ||
    implementation !== plan.checkpoint.implementation ||
    keccak256(vaultCode) !== plan.checkpoint.vaultCodeHash
  )
    throw new Error('sUSDS vault or implementation identity changed')
  const code = lower(await request('eth_getCode', [implementation, pin]))
  if (
    !/^0x(?:[0-9a-f]{2})+$/.test(code) ||
    keccak256(code) !== plan.checkpoint.implementationCodeHash
  )
    throw new Error('sUSDS implementation code changed')
}
const isLimit = (error) =>
  /(?:too many|exceed|more than).*?(?:logs|results|blocks|entries)|(?:query|block) range|result window|response size/i.test(
    String(error?.message || ''),
  )
async function captureRange(request, plan, start, end, finalized, now) {
  const started = now().toISOString()
  const get = async (n) => header(await request('eth_getBlockByNumber', [quantity(n), false]))
  const from = await get(start),
    to = end === start ? from : await get(end)
  if (from.number !== start || to.number !== end) throw new Error('sUSDS range height mismatch')
  await checkCode(request, plan, from)
  if (end !== start) await checkCode(request, plan, to)
  const logs = async (topics) => {
    try {
      return await request('eth_getLogs', [
        {
          fromBlock: quantity(start),
          toBlock: quantity(end),
          address: plan.source.vault,
          topics: [topics],
        },
      ])
    } catch (error) {
      if (isLimit(error)) return null
      throw error
    }
  }
  const combined = await logs(EVENTS.map((item) => item.topic0))
  if (combined === null) return { split: true }
  if (!Array.isArray(combined)) throw new Error('Malformed sUSDS combined logs')
  if (combined.length >= MAX_LOGS) return { split: true }
  const events = combined.map((item) => decodeLog(item, plan.source)).sort(compareEvents)
  const separate = []
  for (const stream of EVENTS) {
    const found = await logs(stream.topic0)
    if (found === null) return { split: true }
    if (!Array.isArray(found)) throw new Error('Malformed sUSDS stream logs')
    if (found.length >= MAX_LOGS) return { split: true }
    const decoded = found.map((item) => decodeLog(item, plan.source))
    if (decoded.some((item) => item.kind !== stream.kind)) throw new Error('sUSDS stream mismatch')
    separate.push(...decoded)
  }
  separate.sort(compareEvents)
  if (JSON.stringify(events) !== JSON.stringify(separate))
    throw new Error('sUSDS combined/separate logs disagree')
  // Endpoint code checks would miss an implementation changed and restored
  // within an otherwise quiet range.
  const upgrades = await logs(UPGRADED_TOPIC)
  if (upgrades === null) return { split: true }
  if (!Array.isArray(upgrades) || upgrades.length >= MAX_LOGS)
    throw new Error('Malformed or capped sUSDS upgrade logs')
  if (upgrades.length) throw new Error('sUSDS implementation upgrade inside flow range')
  const seen = new Set(),
    eventBlocks = new Map([
      [start, from],
      [end, to],
    ])
  for (const event of events) {
    if (event.blockNumber < start || event.blockNumber > end)
      throw new Error('sUSDS event outside query range')
    const key = `${event.transactionHash}:${event.logIndex}`
    if (seen.has(key)) throw new Error('Duplicate sUSDS RPC event')
    seen.add(key)
    if (!eventBlocks.has(event.blockNumber))
      eventBlocks.set(event.blockNumber, await get(event.blockNumber))
    const at = eventBlocks.get(event.blockNumber)
    if (at.hash !== event.blockHash) throw new Error('sUSDS event block hash mismatch')
    await checkCode(request, plan, at)
    event.blockTimestamp = at.timestamp
  }
  const fromAgain = await get(start),
    toAgain = end === start ? fromAgain : await get(end)
  if (
    fromAgain.hash !== from.hash ||
    toAgain.hash !== to.hash ||
    fromAgain.timestamp !== from.timestamp ||
    toAgain.timestamp !== to.timestamp
  )
    throw new Error('sUSDS canonical boundary drift')
  return {
    payload: {
      study: STUDY,
      planSha256: plan.sha256,
      planCreatedAtUtc: plan.createdAtUtc,
      source: plan.source,
      range: { from, to },
      finalizedHead: finalized,
      captureStartUtc: started,
      captureEndUtc: now().toISOString(),
      rpcHost: plan.rpcHost,
      completeness: 'combined-and-separate-topic-results-match-below-cap',
      code: {
        vault: plan.checkpoint.vaultCodeHash,
        implementation: plan.checkpoint.implementation,
        implementationCodeHash: plan.checkpoint.implementationCodeHash,
      },
      counts: {
        deposit: events.filter((e) => e.kind === 'deposit').length,
        withdraw: events.filter((e) => e.kind === 'withdraw').length,
      },
      events,
    },
  }
}
export async function collect({
  client,
  out = OUT,
  source = sourceIdentity(),
  checkpointOut = CHECKPOINT_OUT,
  rpcHost,
  maxChunks = 1,
  range = MAX_RANGE,
  stat = statfsSync,
  now = () => new Date(),
} = {}) {
  if (
    !client?.request ||
    !HOST.test(rpcHost) ||
    !safe(maxChunks) ||
    maxChunks < 1 ||
    maxChunks > MAX_CHUNKS ||
    !safe(range) ||
    range < 1 ||
    range > MAX_RANGE
  )
    throw new Error('Invalid bounded sUSDS scan options')
  const unlock = await lock(out)
  try {
    diskGuard(out, stat)
    if (
      parseQuantity(await client.request({ method: 'eth_chainId', params: [] })) !== source.chainId
    )
      throw new Error('Wrong sUSDS flow chain')
    const plan = ensurePlan({ out, source, checkpointOut, rpcHost, now, stat })
    const receipts = readValidatedReceipts({ out, source, checkpointOut })
    const request = (method, params) => client.request({ method, params })
    const finalized = header(await request('eth_getBlockByNumber', ['finalized', false]))
    let previous = receipts.at(-1) ?? null
    let cursor = previous ? previous.range.to.number + 1 : plan.startBlock
    const paths = []
    for (let i = 0; i < maxChunks && cursor <= finalized.number; i++) {
      let width = Math.min(range, finalized.number - cursor + 1)
      let captured
      for (;;) {
        captured = await captureRange(request, plan, cursor, cursor + width - 1, finalized, now)
        if (!captured.split) break
        if (width === 1) throw new Error('Single-block sUSDS log limit reached')
        width = Math.max(1, Math.floor(width / 2))
      }
      const receipt = seal({ ...captured.payload, previousReceiptSha256: previous?.sha256 ?? null })
      validateReceipt(receipt, plan, previous)
      const path = join(receiptsPath(out), filename(receipt))
      append(path, receipt, stat)
      paths.push(path)
      previous = receipt
      cursor = receipt.range.to.number + 1
    }
    return {
      ...verify({ out, source, checkpointOut }),
      saved: paths.length,
      paths,
      finalizedBlock: finalized.number,
    }
  } finally {
    unlock()
  }
}

const HORIZONS = [
  { label: '24h', seconds: 86_400 },
  { label: '7d', seconds: 604_800 },
]
const iso = (seconds) => new Date(seconds * 1000).toISOString()
const unit = (raw) => {
  const sign = raw < 0n ? '-' : ''
  const value = raw < 0n ? -raw : raw
  const whole = value / 10n ** 18n
  const fraction = (value % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '')
  return sign + whole + (fraction ? `.${fraction}` : '')
}
function lowerBound(events, time) {
  let lo = 0,
    hi = events.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (events[mid].blockTimestamp < time) lo = mid + 1
    else hi = mid
  }
  return lo
}
function maximum(events, from, toExclusive, horizon, metric) {
  const latest = toExclusive - horizon.seconds
  if (latest < from)
    return {
      status: 'unavailable',
      reason: 'less_than_one_complete_window',
      horizon: horizon.label,
    }
  const candidates = new Set([from])
  for (const event of events) {
    const enter = event.blockTimestamp - horizon.seconds + 1
    if (enter >= from && enter <= latest) candidates.add(enter)
    if (metric === 'net' && event.kind === 'deposit') {
      const leave = event.blockTimestamp + 1
      if (leave >= from && leave <= latest) candidates.add(leave)
    }
  }
  const deposits = [0n],
    withdrawals = [0n]
  for (const event of events) {
    const amount = BigInt(event.assetsRaw)
    deposits.push(deposits.at(-1) + (event.kind === 'deposit' ? amount : 0n))
    withdrawals.push(withdrawals.at(-1) + (event.kind === 'withdraw' ? amount : 0n))
  }
  let best
  for (const start of [...candidates].sort((a, b) => a - b)) {
    const left = lowerBound(events, start),
      right = lowerBound(events, start + horizon.seconds)
    const grossDeposits = deposits[right] - deposits[left]
    const grossWithdrawals = withdrawals[right] - withdrawals[left]
    const value = metric === 'gross' ? grossWithdrawals : grossWithdrawals - grossDeposits
    if (!best || value > best.value) best = { start, value, grossDeposits, grossWithdrawals }
  }
  return {
    status: 'observed',
    horizon: horizon.label,
    startUtc: iso(best.start),
    endExclusiveUtc: iso(best.start + horizon.seconds),
    ...(metric === 'gross'
      ? { grossWithdrawalsRaw: String(best.value), grossWithdrawalsUsds: unit(best.value) }
      : {
          signedNetDepletionRaw: String(best.value),
          signedNetDepletionUsds: unit(best.value),
          grossDepositsRaw: String(best.grossDeposits),
          grossWithdrawalsRaw: String(best.grossWithdrawals),
        }),
  }
}
export function summarizeReceipts(receipts) {
  if (!receipts.length)
    return { study: STUDY, status: 'unavailable', reason: 'no_verified_coverage' }
  const events = receipts
    .flatMap((receipt) => receipt.events)
    .sort((a, b) => a.blockTimestamp - b.blockTimestamp || compareEvents(a, b))
  const from = receipts[0].range.from.timestamp,
    toExclusive = receipts.at(-1).range.to.timestamp + 1
  if (!safe(toExclusive)) throw new Error('Unsafe sUSDS coverage end')
  const planCreatedAtUtc = receipts[0].planCreatedAtUtc ?? null
  if (receipts.some((receipt) => (receipt.planCreatedAtUtc ?? null) !== planCreatedAtUtc))
    throw new Error('Mixed sUSDS plan times')
  const planSecond =
    planCreatedAtUtc === null ? null : Math.floor(Date.parse(planCreatedAtUtc) / 1000)
  if (planSecond !== null && !safe(planSecond)) throw new Error('Invalid sUSDS plan time')
  const blockTimeRelativeToPlan =
    planSecond === null
      ? 'unknown'
      : receipts.at(-1).range.to.timestamp < planSecond
        ? 'all_block_timestamps_before_plan_second'
        : from > planSecond
          ? 'all_block_timestamps_after_plan_second'
          : 'mixed_or_same_second_ambiguous'
  let deposits = 0n,
    withdrawals = 0n
  for (const event of events) {
    if (!RAW.test(event.assetsRaw)) throw new Error('Malformed sUSDS amount')
    if (event.kind === 'deposit') deposits += BigInt(event.assetsRaw)
    else if (event.kind === 'withdraw') withdrawals += BigInt(event.assetsRaw)
    else throw new Error('Unexpected sUSDS event kind')
  }
  return {
    study: STUDY,
    status: 'observed',
    unit: 'USDS',
    rawDecimals: 18,
    observation: 'successful_susds_direct_vault_deposit_and_withdraw_events_only',
    coverage: {
      fromBlock: receipts[0].range.from.number,
      throughBlock: receipts.at(-1).range.to.number,
      fromUtc: iso(from),
      endExclusiveUtc: iso(toExclusive),
      planCreatedAtUtc,
      blockTimeRelativeToPlan,
      verifiedQuietRangesIncluded: true,
    },
    totals: {
      grossDepositsRaw: String(deposits),
      grossWithdrawalsRaw: String(withdrawals),
      signedNetDepletionRaw: String(withdrawals - deposits),
      grossDepositsUsds: unit(deposits),
      grossWithdrawalsUsds: unit(withdrawals),
      signedNetDepletionUsds: unit(withdrawals - deposits),
    },
    maximumObservedCompleteWindowGrossWithdrawals: Object.fromEntries(
      HORIZONS.map((h) => [h.label, maximum(events, from, toExclusive, h, 'gross')]),
    ),
    maximumObservedCompleteWindowSignedNetDepletion: Object.fromEntries(
      HORIZONS.map((h) => [h.label, maximum(events, from, toExclusive, h, 'net')]),
    ),
    caveat: 'Historical event flow only; no direct-holder exit implication or forecast runway.',
  }
}
export function summarize(options = {}) {
  return summarizeReceipts(readValidatedReceipts(options))
}

export function selectRpc(configured, index = 0) {
  const urls =
    typeof configured === 'string' ? configured.split(',').map((item) => item.trim()) : []
  if (!safe(index) || index >= urls.length || !urls[index]) throw new Error('RPC index unavailable')
  const url = new URL(urls[index])
  if (!['http:', 'https:'].includes(url.protocol) || !HOST.test(url.hostname))
    throw new Error('Invalid RPC URL')
  return { url: url.toString(), host: url.hostname.toLowerCase() }
}
export function recorderRpcRing({ env = process.env, config = readEnv() } = {}) {
  return env.RECORDER_RPC_URL || config.get('RECORDER_RPC_URL')
}
export function parseOptions(args) {
  const mode = args[0]
  if (mode === '--verify' || mode === '--summary') {
    if (args.length !== 1) throw new Error('Invalid sUSDS flow CLI options')
    return { mode, values: {} }
  }
  if (mode !== '--run' || args.length > 7 || args.length % 2 !== 1)
    throw new Error('Invalid sUSDS flow CLI options')
  const values = {}
  for (let i = 1; i < args.length; i += 2) {
    if (
      !['--rpc-index', '--range', '--max-chunks'].includes(args[i]) ||
      values[args[i]] !== undefined ||
      !RAW.test(args[i + 1] || '')
    )
      throw new Error('Invalid sUSDS flow CLI option')
    const value = Number(args[i + 1])
    if (!safe(value)) throw new Error('Invalid sUSDS flow CLI option value')
    values[args[i]] = value
  }
  return { mode, values }
}
const SOURCE_ERRORS = new Set([
  'Configured sUSDS vault or asset identity changed',
  'sUSDS source identity drift',
  'sUSDS checkpoint lacks implementation identity',
  'No verified sUSDS checkpoint',
  'sUSDS flow plan/checkpoint mismatch',
  'Wrong sUSDS flow chain',
  'sUSDS vault or implementation identity changed',
  'sUSDS implementation code changed',
  'sUSDS implementation upgrade inside flow range',
  'sUSDS event block hash mismatch',
  'sUSDS canonical boundary drift',
])
const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
])
const TIMEOUT_NAMES = new Set([
  'AbortError',
  'TimeoutError',
  'SocketError',
  'ConnectTimeoutError',
  'HeadersTimeoutError',
  'BodyTimeoutError',
  'FetchError',
])
function safeGet(value, key) {
  try {
    return value?.[key]
  } catch {
    return undefined
  }
}
// Only fixed labels leave the CLI. RPC error messages may embed credentialed URLs.
export function classifySusdsFlowError(error) {
  const chain = [],
    seen = new Set()
  for (let current = error; current && chain.length < 5 && !seen.has(current); ) {
    seen.add(current)
    chain.push(current)
    current = safeGet(current, 'cause')
  }
  if (
    chain.some((entry) =>
      [
        safeGet(entry, 'status'),
        safeGet(entry, 'statusCode'),
        safeGet(safeGet(entry, 'response'), 'status'),
      ].some((status) => status === 429 || status === '429'),
    )
  )
    return 'rate_limited'
  for (const entry of chain) {
    const message = safeGet(entry, 'message')
    if (message === 'sUSDS flow disk reserve reached' || safeGet(entry, 'code') === 'ENOSPC')
      return 'disk_reserve'
    if (SOURCE_ERRORS.has(message)) return 'invalid_source'
    if (
      TIMEOUT_CODES.has(safeGet(entry, 'code')) ||
      TIMEOUT_NAMES.has(safeGet(entry, 'name')) ||
      (safeGet(entry, 'name') === 'TypeError' && message === 'fetch failed')
    )
      return 'transport_timeout'
  }
  return 'unknown'
}
async function main() {
  const { mode, values } = parseOptions(process.argv.slice(2))
  if (mode === '--verify') return console.log(JSON.stringify(verify()))
  if (mode === '--summary') return console.log(JSON.stringify(summarize()))
  const rpc = selectRpc(recorderRpcRing(), values['--rpc-index'] ?? 0)
  console.log(
    JSON.stringify(
      await collect({
        client: makeClient(rpc.url),
        rpcHost: rpc.host,
        range: values['--range'] ?? MAX_RANGE,
        maxChunks: values['--max-chunks'] ?? 1,
      }),
    ),
  )
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(
      `sUSDS flow collection or verification unavailable [${classifySusdsFlowError(error)}]`,
    )
    process.exitCode = 1
  })
