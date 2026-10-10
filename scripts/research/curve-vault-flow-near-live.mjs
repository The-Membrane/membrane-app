// A separate, bounded retrospective suffix. Later capture never becomes earlier as-of evidence.
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
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import { classifyVaultFlowError } from './curve-vault-flow-error-class.mjs'
import {
  collect,
  FIRST_LIVE_BLOCK,
  FIRST_LIVE_BLOCK_HASH,
  FIRST_LIVE_RECEIPT_SHA256,
  MAX_CHUNKS,
  MAX_PACE_MS,
  MAX_RANGE,
  OUT as LIVE_OUT,
  RESERVE_BYTES,
  readValidatedReceipts,
  selectRpc,
  sourceIdentity,
} from './curve-vault-flow-ledger.mjs'

export const STUDY = 'scrvusd-vault-flow-near-live-v1'
export const OUT = resolve('data/research/venue-signals/scrvusd-vault-flow-near-live')
export const MIN_WINDOW_SECONDS = 7 * 24 * 60 * 60
export const LOOKBACK_SECONDS = 30 * 24 * 60 * 60
const HASH = /^0x[0-9a-f]{64}$/
const HOST = /^[a-z0-9.-]{1,255}$/
const SHA = /^[0-9a-f]{64}$/
const integer = (n) => Number.isSafeInteger(n) && n >= 0
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const seal = (payload) => ({ ...payload, sha256: sha(JSON.stringify(payload)) })
const unsigned = ({ sha256: _sha, ...payload }) => payload
const quantity = (n) => `0x${n.toString(16)}`
const parseQuantity = (n) => {
  if (typeof n !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(n))
    throw new Error('Malformed RPC quantity')
  const value = Number(BigInt(n))
  if (!integer(value)) throw new Error('Unsafe RPC quantity')
  return value
}
const header = (raw) => {
  const value = {
    number: parseQuantity(raw?.number),
    hash: raw?.hash?.toLowerCase(),
    parentHash: raw?.parentHash?.toLowerCase(),
    timestamp: parseQuantity(raw?.timestamp),
  }
  if (!HASH.test(value.hash) || !HASH.test(value.parentHash) || !value.timestamp)
    throw new Error('Malformed RPC block header')
  return value
}
const planPath = (out) => join(out, 'plan.json')
const receiptDir = (out) => join(out, 'receipts')
const witnessDir = (out) => join(out, 'boundaries')
const receiptPath = (out, receipt) =>
  join(
    receiptDir(out),
    `${String(receipt.range.from.number).padStart(12, '0')}-${String(receipt.range.to.number).padStart(12, '0')}-${receipt.range.to.hash.slice(2)}.json`,
  )
const witnessPath = (out, receipt) =>
  join(
    witnessDir(out),
    `${String(receipt.range.from.number).padStart(12, '0')}-${receipt.range.from.hash.slice(2)}.json`,
  )

function diskGuard(path, stat = statfsSync, extra = 0) {
  let ancestor = path
  while (!existsSync(ancestor)) ancestor = dirname(ancestor)
  const fs = stat(ancestor)
  if (Number(fs.bavail) * Number(fs.bsize) - extra < RESERVE_BYTES)
    throw new Error('Near-live vault flow disk reserve reached')
}

function appendJson(path, value, stat = statfsSync) {
  const bytes = `${JSON.stringify(value)}\n`
  diskGuard(path, stat, Buffer.byteLength(bytes))
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 })
    linkSync(temp, path)
  } finally {
    if (existsSync(temp)) unlinkSync(temp)
  }
}

function readExact(path) {
  const bytes = readFileSync(path)
  if (bytes.length > 16 * 1024 || !bytes.toString().endsWith('\n'))
    throw new Error('Near-live sealed file format changed')
  const saved = JSON.parse(bytes.toString())
  if (
    bytes.toString() !== `${JSON.stringify(saved)}\n` ||
    saved.sha256 !== sha(JSON.stringify(unsigned(saved)))
  )
    throw new Error('Near-live physical or logical seal mismatch')
  return saved
}

export function firstLiveAnchor({ source = sourceIdentity(), liveOut = LIVE_OUT } = {}) {
  const first = readValidatedReceipts({ out: liveOut, source })[0]
  if (
    first?.sha256 !== FIRST_LIVE_RECEIPT_SHA256 ||
    first.range.from.number !== FIRST_LIVE_BLOCK ||
    first.range.from.hash !== FIRST_LIVE_BLOCK_HASH
  )
    throw new Error('First live receipt anchor changed or unavailable')
  const filename = `${String(first.range.from.number).padStart(12, '0')}-${String(first.range.to.number).padStart(12, '0')}-${first.range.to.hash.slice(2)}.json`
  return {
    number: FIRST_LIVE_BLOCK,
    hash: FIRST_LIVE_BLOCK_HASH,
    timestamp: first.range.from.timestamp,
    receiptSha256: first.sha256,
    receiptPhysicalSha256: sha(readFileSync(join(liveOut, filename))),
  }
}

export async function freezePlan({
  client,
  rpcHost,
  out = OUT,
  source = sourceIdentity(),
  liveOut = LIVE_OUT,
  now = () => new Date(),
  stat = statfsSync,
} = {}) {
  if (!client?.request || !HOST.test(rpcHost)) throw new Error('One named RPC host required')
  if (existsSync(planPath(out))) {
    const prior = readPlan({ out, source, liveOut })
    if (prior.rpcHost !== rpcHost) throw new Error('Near-live plan RPC host changed')
    return prior
  }
  if (existsSync(out) && readdirSync(out).length)
    throw new Error('Near-live output is occupied without a plan')
  const firstLive = firstLiveAnchor({ source, liveOut })
  const request = async (n) =>
    header(await client.request({ method: 'eth_getBlockByNumber', params: [quantity(n), false] }))
  if (parseQuantity(await client.request({ method: 'eth_chainId', params: [] })) !== source.chainId)
    throw new Error('Wrong RPC chain ID')
  const finalized = header(
    await client.request({ method: 'eth_getBlockByNumber', params: ['finalized', false] }),
  )
  if (finalized.number < firstLive.number)
    throw new Error('First live block not finalized on plan RPC')
  const live = await request(firstLive.number)
  if (live.hash !== firstLive.hash || live.timestamp !== firstLive.timestamp)
    throw new Error('First live RPC header disagrees with sealed receipt')
  const end = await request(firstLive.number - 1)
  if (live.parentHash !== end.hash) throw new Error('First live parent hash bridge mismatch')
  const threshold = firstLive.timestamp - LOOKBACK_SECONDS
  if (threshold <= 0 || firstLive.timestamp - threshold < MIN_WINDOW_SECONDS)
    throw new Error('Invalid near-live lookback threshold')
  let lo = 0,
    hi = end.number
  // Greatest finalized archive block at or before the 30-day timestamp.
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    const at = await request(mid)
    if (at.number !== mid) throw new Error('RPC archive block number mismatch')
    if (at.timestamp <= threshold) lo = mid
    else hi = mid - 1
  }
  const start = await request(lo)
  const successor = await request(lo + 1)
  if (
    start.number !== lo ||
    successor.number !== lo + 1 ||
    start.timestamp > threshold ||
    successor.timestamp <= threshold ||
    successor.parentHash !== start.hash
  )
    throw new Error('Thirty-day start boundary was not established')
  const liveAgain = await request(firstLive.number)
  const endAgain = await request(end.number)
  if (liveAgain.hash !== live.hash || endAgain.hash !== end.hash)
    throw new Error('Plan boundary hash drift')
  const plan = seal({
    study: STUDY,
    source,
    sourceIdentitySha256: source.identitySha256,
    firstLive,
    thresholdTimestamp: threshold,
    start: { number: start.number, hash: start.hash, timestamp: start.timestamp },
    successor: {
      number: successor.number,
      hash: successor.hash,
      parentHash: successor.parentHash,
      timestamp: successor.timestamp,
    },
    end: { number: end.number, hash: end.hash, timestamp: end.timestamp },
    firstLiveParentHash: live.parentHash,
    finalizedHead: {
      number: finalized.number,
      hash: finalized.hash,
      timestamp: finalized.timestamp,
    },
    rpcHost,
    capturedAtUtc: now().toISOString(),
    evidence: 'single-rpc-host-headers-and-combined-separate-event-queries',
  })
  validatePlan(plan, { source, firstLive })
  appendJson(planPath(out), plan, stat)
  return plan
}

export function validatePlan(
  plan,
  { source = sourceIdentity(), firstLive = firstLiveAnchor({ source }) } = {},
) {
  if (
    !plan ||
    plan.sha256 !== sha(JSON.stringify(unsigned(plan))) ||
    plan.study !== STUDY ||
    JSON.stringify(plan.source) !== JSON.stringify(source) ||
    plan.sourceIdentitySha256 !== source.identitySha256 ||
    JSON.stringify(plan.firstLive) !== JSON.stringify(firstLive) ||
    plan.thresholdTimestamp !== firstLive.timestamp - LOOKBACK_SECONDS ||
    !integer(plan.start?.number) ||
    !HASH.test(plan.start?.hash) ||
    !integer(plan.start?.timestamp) ||
    plan.start.timestamp > plan.thresholdTimestamp ||
    plan.start.number >= plan.end?.number ||
    plan.successor?.number !== plan.start.number + 1 ||
    !HASH.test(plan.successor?.hash) ||
    plan.successor.parentHash !== plan.start.hash ||
    !integer(plan.successor?.timestamp) ||
    plan.successor.timestamp <= plan.thresholdTimestamp ||
    plan.end?.number !== firstLive.number - 1 ||
    !HASH.test(plan.end?.hash) ||
    !integer(plan.end?.timestamp) ||
    plan.end.timestamp < plan.successor.timestamp ||
    plan.end.timestamp >= firstLive.timestamp ||
    plan.firstLiveParentHash !== plan.end.hash ||
    !integer(plan.finalizedHead?.number) ||
    plan.finalizedHead.number < firstLive.number ||
    !HASH.test(plan.finalizedHead?.hash) ||
    !integer(plan.finalizedHead?.timestamp) ||
    !HOST.test(plan.rpcHost) ||
    !Number.isFinite(Date.parse(plan.capturedAtUtc)) ||
    plan.evidence !== 'single-rpc-host-headers-and-combined-separate-event-queries'
  )
    throw new Error('Near-live plan seal or boundary mismatch')
  return plan
}

export function readPlan({ out = OUT, source = sourceIdentity(), liveOut = LIVE_OUT } = {}) {
  const firstLive = firstLiveAnchor({ source, liveOut })
  return validatePlan(readExact(planPath(out)), { source, firstLive })
}

export function boundaryWitness({ plan, receipt, previous, fromHeader, now = () => new Date() }) {
  if (
    fromHeader.number !== receipt.range.from.number ||
    fromHeader.hash !== receipt.range.from.hash ||
    (previous && fromHeader.parentHash !== previous.range.to.hash) ||
    (!previous && fromHeader.hash !== plan.start.hash)
  )
    throw new Error('Near-live receipt boundary parent hash mismatch')
  return seal({
    study: `${STUDY}-boundary`,
    planSha256: plan.sha256,
    receiptSha256: receipt.sha256,
    previousReceiptSha256: previous?.sha256 ?? null,
    fromBlock: fromHeader.number,
    fromHash: fromHeader.hash,
    fromParentHash: fromHeader.parentHash,
    previousToHash: previous?.range.to.hash ?? null,
    capturedAtUtc: now().toISOString(),
    rpcHost: plan.rpcHost,
  })
}

function verifyWitness(out, plan, receipt, previous) {
  const witness = readExact(witnessPath(out, receipt))
  if (
    witness.study !== `${STUDY}-boundary` ||
    witness.planSha256 !== plan.sha256 ||
    witness.receiptSha256 !== receipt.sha256 ||
    witness.receiptPhysicalSha256 !== sha(readFileSync(receiptPath(out, receipt))) ||
    witness.previousReceiptSha256 !== (previous?.sha256 ?? null) ||
    witness.fromBlock !== receipt.range.from.number ||
    witness.fromHash !== receipt.range.from.hash ||
    !HASH.test(witness.fromParentHash) ||
    witness.previousToHash !== (previous?.range.to.hash ?? null) ||
    (previous && witness.fromParentHash !== previous.range.to.hash) ||
    !Number.isFinite(Date.parse(witness.capturedAtUtc)) ||
    witness.rpcHost !== plan.rpcHost
  )
    throw new Error('Near-live boundary witness mismatch')
  return witness
}

export function verify({ out = OUT, source = sourceIdentity(), liveOut = LIVE_OUT } = {}) {
  const plan = readPlan({ out, source, liveOut })
  const receipts = readValidatedReceipts({ out: receiptDir(out), source })
  if (
    receipts[0] &&
    (receipts[0].range.from.number !== plan.start.number ||
      receipts[0].range.from.hash !== plan.start.hash ||
      receipts[0].range.from.timestamp !== plan.start.timestamp)
  )
    throw new Error('Near-live first receipt disagrees with plan')
  let previous = null
  for (const receipt of receipts) {
    if (
      receipt.range.to.number > plan.end.number ||
      (receipt.range.to.number === plan.end.number &&
        (receipt.range.to.hash !== plan.end.hash ||
          receipt.range.to.timestamp !== plan.end.timestamp)) ||
      Date.parse(receipt.captureStartUtc) < Date.parse(plan.capturedAtUtc)
    )
      throw new Error('Near-live receipt exceeds plan or predates plan')
    verifyWitness(out, plan, receipt, previous)
    previous = receipt
  }
  const witnessFiles = existsSync(witnessDir(out))
    ? readdirSync(witnessDir(out)).filter((name) => name.endsWith('.json'))
    : []
  if (witnessFiles.length !== receipts.length)
    throw new Error('Near-live boundary witness count mismatch')
  return {
    study: STUDY,
    planSha256: plan.sha256,
    receipts: receipts.length,
    fromBlock: plan.start.number,
    throughBlock: previous?.range.to.number ?? null,
    completeToFirstLive:
      previous?.range.to.number === plan.end.number &&
      previous.range.to.hash === plan.firstLiveParentHash,
    capturedAfter: plan.capturedAtUtc,
    evidence: plan.evidence,
  }
}

// Consumers must use this prefix for historical as-of replay. A later scan is
// never retroactively available to an older forecast issue.
export function availableReceiptsAt({
  issuedAtUtc,
  out = OUT,
  source = sourceIdentity(),
  liveOut = LIVE_OUT,
} = {}) {
  const issued = Date.parse(issuedAtUtc)
  if (!Number.isFinite(issued)) throw new Error('Invalid near-live issue time')
  const status = verify({ out, source, liveOut })
  const plan = readPlan({ out, source, liveOut })
  if (Date.parse(plan.capturedAtUtc) > issued) return []
  const receipts = readValidatedReceipts({ out: receiptDir(out), source })
  const available = []
  for (let i = 0; i < receipts.length; i++) {
    const receipt = receipts[i]
    const witness = verifyWitness(out, plan, receipt, receipts[i - 1])
    if (Date.parse(receipt.captureEndUtc) > issued || Date.parse(witness.capturedAtUtc) > issued)
      break
    available.push(receipt)
  }
  if (status.receipts !== receipts.length) throw new Error('Near-live receipt count drift')
  return available
}

export async function run({
  client,
  out = OUT,
  source = sourceIdentity(),
  liveOut = LIVE_OUT,
  rpcHost,
  maxChunks = 1,
  range = MAX_RANGE,
  paceMs = 0,
  stat = statfsSync,
  now = () => new Date(),
} = {}) {
  const plan = readPlan({ out, source, liveOut })
  if (
    !client?.request ||
    rpcHost !== plan.rpcHost ||
    !integer(maxChunks) ||
    maxChunks < 1 ||
    maxChunks > MAX_CHUNKS ||
    !integer(range) ||
    range < 1 ||
    range > MAX_RANGE ||
    !integer(paceMs) ||
    paceMs > MAX_PACE_MS
  )
    throw new Error('Invalid bounded near-live run options')
  diskGuard(out, stat)
  const getHeader = async (number) =>
    header(
      await client.request({
        method: 'eth_getBlockByNumber',
        params: [quantity(number), false],
      }),
    )
  // Repair only a crash between immutable receipt and witness publication.
  const existing = readValidatedReceipts({ out: receiptDir(out), source })
  let previous = null
  for (const receipt of existing) {
    const path = witnessPath(out, receipt)
    if (!existsSync(path)) {
      const fromHeader = await getHeader(receipt.range.from.number)
      const witness = {
        ...unsigned(boundaryWitness({ plan, receipt, previous, fromHeader, now })),
        receiptPhysicalSha256: sha(readFileSync(receiptPath(out, receipt))),
      }
      const sealedWitness = seal(witness)
      appendJson(path, sealedWitness, stat)
    }
    previous = receipt
  }
  verify({ out, source, liveOut })
  const paths = []
  for (let i = 0; i < maxChunks; i++) {
    const current = readValidatedReceipts({ out: receiptDir(out), source })
    const last = current.at(-1)
    if (last?.range.to.number === plan.end.number) break
    const result = await collect({
      client,
      out: receiptDir(out),
      source,
      fromBlock: current.length ? undefined : plan.start.number,
      toBlock: plan.end.number,
      expectedTargetHash: plan.end.hash,
      maxChunks: 1,
      range,
      paceMs,
      rpcHost,
      stat,
      now,
    })
    if (result.saved !== 1) break
    const next = readValidatedReceipts({ out: receiptDir(out), source }).at(-1)
    const fromHeader = await getHeader(next.range.from.number)
    const witness = {
      ...unsigned(boundaryWitness({ plan, receipt: next, previous: last, fromHeader, now })),
      receiptPhysicalSha256: sha(readFileSync(receiptPath(out, next))),
    }
    appendJson(witnessPath(out, next), seal(witness), stat)
    paths.push(...result.paths)
    if (paceMs && i + 1 < maxChunks) await new Promise((resolve) => setTimeout(resolve, paceMs))
  }
  return { ...verify({ out, source, liveOut }), saved: paths.length, paths }
}

export function parseOptions(args) {
  const opts = {}
  for (let i = 0; i < args.length; i++) {
    const key = args[i]
    if (
      ![
        '--plan',
        '--run',
        '--verify',
        '--max-chunks',
        '--range',
        '--pace-ms',
        '--rpc',
        '--rpc-index',
      ].includes(key) ||
      Object.hasOwn(opts, key)
    )
      throw new Error('Unknown or duplicate option')
    const value = ['--plan', '--run', '--verify'].includes(key) ? true : args[++i]
    if (!value) throw new Error('Missing option value')
    opts[key] = value
  }
  if (
    ['--plan', '--run', '--verify'].filter((key) => opts[key]).length > 1 ||
    (opts['--rpc'] && opts['--rpc-index']) ||
    (!opts['--run'] && ['--max-chunks', '--range', '--pace-ms'].some((key) => opts[key])) ||
    (!opts['--run'] && !opts['--plan'] && (opts['--rpc'] || opts['--rpc-index']))
  )
    throw new Error('Incompatible options')
  return opts
}

const bounded = (value, fallback, max) => {
  if (value === undefined) return fallback
  if (!/^(0|[1-9][0-9]*)$/.test(value) || Number(value) > max)
    throw new Error('Invalid bounded option')
  return Number(value)
}

async function main() {
  const opts = parseOptions(process.argv.slice(2))
  if (opts['--verify']) return console.log(JSON.stringify(verify()))
  if (!opts['--plan'] && !opts['--run'])
    return console.log(
      JSON.stringify({
        mode: 'dry',
        study: STUDY,
        out: OUT,
        planExists: existsSync(planPath(OUT)),
        limits: { maxChunks: MAX_CHUNKS, maxRange: MAX_RANGE, maxPaceMs: MAX_PACE_MS },
      }),
    )
  const configured = opts['--rpc']
    ? undefined
    : process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')
  const rpc = selectRpc(opts['--rpc'], configured, bounded(opts['--rpc-index'], 0, 100))
  const client = makeClient(rpc.url)
  const result = opts['--plan']
    ? await freezePlan({ client, rpcHost: rpc.host })
    : await run({
        client,
        rpcHost: rpc.host,
        maxChunks: bounded(opts['--max-chunks'], 1, MAX_CHUNKS),
        range: bounded(opts['--range'], MAX_RANGE, MAX_RANGE),
        paceMs: bounded(opts['--pace-ms'], 0, MAX_PACE_MS),
      })
  console.log(JSON.stringify(result))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    // RPC errors may contain credentials. Never print them.
    console.error(
      `Near-live vault flow plan, run, or verification failed [${classifyVaultFlowError(error)}]`,
    )
    process.exitCode = 1
  })
}
