// Prospective code identity for the scrvUSD EIP-1167 vault and its embedded target.
// A code identity is a comparability control, not proof of future exit availability.
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
import { keccak256 } from 'viem'
import {
  OUT as QUOTE_OUT,
  readValidatedCheckpoints,
  sourceIdentity,
} from './curve-prospective-quote.mjs'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'

export const STUDY = 'scrvusd-target-code-attestation-v1'
export const OUT = resolve('data/research/venue-signals/scrvusd-target-code-attestations')
export const MAX_CHECKPOINT_AGE_SECONDS = 7200
export const RESERVE_BYTES = 1_073_741_824
const PREFIX = '363d3d373d3d3d363d73'
const SUFFIX = '5af43d82803e903d91602b57fd5bf3'
const SHA = /^[0-9a-f]{64}$/
const HASH = /^0x[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const CODE = /^0x(?:[0-9a-f]{2})+$/
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const unsigned = ({ sha256: _sha256, ...payload }) => payload
const seal = (payload) => ({ ...payload, sha256: sha(JSON.stringify(payload)) })
const name = (block) => `${String(block.number).padStart(12, '0')}-${block.hash.slice(2)}.json`
const pin = (block) => ({ blockHash: block.hash, requireCanonical: true })

export function parseEip1167Runtime(code) {
  if (typeof code !== 'string') throw new Error('Unknown vault runtime')
  const lowered = code.toLowerCase()
  if (
    lowered.length !== 92 ||
    !lowered.startsWith(`0x${PREFIX}`) ||
    !lowered.endsWith(SUFFIX) ||
    !/^0x[0-9a-f]{90}$/.test(lowered)
  )
    throw new Error('Unknown vault runtime: exact 45-byte EIP-1167 required')
  const target = `0x${lowered.slice(22, 62)}`
  if (!ADDRESS.test(target) || target === `0x${'0'.repeat(40)}`)
    throw new Error('Invalid embedded target')
  return target
}

function parseBlock(value) {
  let number, timestamp
  try {
    number = Number(BigInt(value?.number))
    timestamp = Number(BigInt(value?.timestamp))
  } catch {
    throw new Error('Invalid block response')
  }
  const hash = String(value?.hash).toLowerCase()
  if (
    !Number.isSafeInteger(number) ||
    number < 0 ||
    !Number.isSafeInteger(timestamp) ||
    timestamp <= 0 ||
    !HASH.test(hash)
  )
    throw new Error('Invalid block response')
  return { number, hash, timestamp }
}

function matchesBlock(actual, expected) {
  return (
    actual.number === expected.number &&
    actual.hash === expected.hash &&
    actual.timestamp === expected.timestamp
  )
}

function validate(receipt, { identity, checkpoints, nowUtc = new Date().toISOString() }) {
  if (!receipt || receipt.sha256 !== sha(JSON.stringify(unsigned(receipt))))
    throw new Error('Attestation logical seal mismatch')
  const row = checkpoints.find((item) => item.filename === receipt.checkpoint?.filename)
  const block = receipt.block
  const start = Date.parse(receipt.captureStartUtc)
  const end = Date.parse(receipt.captureEndUtc)
  const now = Date.parse(nowUtc)
  if (
    receipt.study !== STUDY ||
    receipt.kind !== 'prospective-code-identity' ||
    JSON.stringify(receipt.source) !== JSON.stringify(identity) ||
    !row ||
    receipt.checkpoint.logicalSha256 !== row.checkpoint.sha256 ||
    receipt.checkpoint.physicalSha256 !== row.physicalSha256 ||
    !SHA.test(receipt.checkpoint.logicalSha256) ||
    !SHA.test(receipt.checkpoint.physicalSha256) ||
    JSON.stringify(block) !== JSON.stringify(row.checkpoint.block) ||
    receipt.checkpoint.captureEndUtc !== row.checkpoint.captureEndUtc ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    !Number.isFinite(now) ||
    start < Date.parse(row.checkpoint.captureEndUtc) ||
    start < block.timestamp * 1000 ||
    start > block.timestamp * 1000 + MAX_CHECKPOINT_AGE_SECONDS * 1000 ||
    end < start ||
    end > now ||
    end > block.timestamp * 1000 + MAX_CHECKPOINT_AGE_SECONDS * 1000 ||
    receipt.status !== 'attested' ||
    receipt.route !== 'exact_eip1167_runtime' ||
    !CODE.test(receipt.vaultRuntime) ||
    receipt.target !== parseEip1167Runtime(receipt.vaultRuntime) ||
    receipt.vaultCodeHash !== keccak256(receipt.vaultRuntime) ||
    !CODE.test(receipt.targetCode) ||
    receipt.targetCodeHash !== keccak256(receipt.targetCode)
  )
    throw new Error('Invalid target code attestation')
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
  if (!row) throw new Error('No verified quote checkpoint')
  const block = row.checkpoint.block
  const captureStartUtc = now().toISOString()
  if (
    Date.parse(captureStartUtc) < Date.parse(row.checkpoint.captureEndUtc) ||
    Date.parse(captureStartUtc) < block.timestamp * 1000 ||
    Date.parse(captureStartUtc) > block.timestamp * 1000 + MAX_CHECKPOINT_AGE_SECONDS * 1000
  )
    throw new Error('Quote checkpoint is stale or capture timing invalid')
  const request = (method, params) => client.request({ method, params })
  if (Number(BigInt(await request('eth_chainId', []))) !== identity.chainId)
    throw new Error('Wrong chain')
  const canonical = async () =>
    parseBlock(await request('eth_getBlockByNumber', [`0x${block.number.toString(16)}`, false]))
  const finalized = async () =>
    parseBlock(await request('eth_getBlockByNumber', ['finalized', false]))
  if ((await finalized()).number < block.number || !matchesBlock(await canonical(), block))
    throw new Error('Checkpoint is not finalized and canonical')
  const vaultRuntime = String(
    await request('eth_getCode', [identity.vault, pin(block)]),
  ).toLowerCase()
  const target = parseEip1167Runtime(vaultRuntime)
  const targetCode = String(await request('eth_getCode', [target, pin(block)])).toLowerCase()
  if (!CODE.test(targetCode)) throw new Error('Embedded target code unavailable')
  if ((await finalized()).number < block.number || !matchesBlock(await canonical(), block))
    throw new Error('Checkpoint canonical identity changed during capture')
  const captureEndUtc = now().toISOString()
  const receipt = seal({
    study: STUDY,
    kind: 'prospective-code-identity',
    source: identity,
    checkpoint: {
      filename: row.filename,
      logicalSha256: row.checkpoint.sha256,
      physicalSha256: row.physicalSha256,
      captureEndUtc: row.checkpoint.captureEndUtc,
    },
    block,
    captureStartUtc,
    captureEndUtc,
    status: 'attested',
    route: 'exact_eip1167_runtime',
    vaultRuntime,
    vaultCodeHash: keccak256(vaultRuntime),
    target,
    targetCode,
    targetCodeHash: keccak256(targetCode),
  })
  return validate(receipt, { identity, checkpoints: rows, nowUtc: captureEndUtc })
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
    throw new Error('Attestation disk reserve reached')
}

function readCanonicalReceipt(path, context) {
  const bytes = readFileSync(path)
  const receipt = JSON.parse(bytes.toString('utf8'))
  if (!bytes.equals(Buffer.from(`${JSON.stringify(receipt)}\n`)))
    throw new Error('Attestation physical bytes mismatch')
  return { receipt: validate(receipt, context), physicalSha256: sha(bytes) }
}

// Read the exact checkpoint receipt for an as-of consumer. A later valid
// capture cannot be retroactively attached to an earlier issue.
export function readVerifiedAtCheckpoint({
  out = OUT,
  identity = sourceIdentity(),
  checkpoint,
  asOfUtc,
  nowUtc = new Date().toISOString(),
} = {}) {
  if (!Number.isFinite(Date.parse(asOfUtc)) || !Number.isFinite(Date.parse(nowUtc)))
    throw new Error('Invalid attestation as-of clock')
  const path = join(out, name(checkpoint.checkpoint.block))
  if (!existsSync(path)) return null
  const { receipt, physicalSha256 } = readCanonicalReceipt(path, {
    identity,
    checkpoints: [checkpoint],
    nowUtc,
  })
  if (Date.parse(receipt.captureEndUtc) > Date.parse(asOfUtc)) return null
  return { filename: name(receipt.block), issue: receipt, physicalSha256 }
}

export { validate as validateAttestation }

export function save({
  receipt,
  out = OUT,
  stat = statfsSync,
  identity = sourceIdentity(),
  checkpoints,
  nowUtc,
} = {}) {
  const rows = checkpoints ?? readValidatedCheckpoints({ out: QUOTE_OUT, identity })
  validate(receipt, { identity, checkpoints: rows, nowUtc })
  const bytes = `${JSON.stringify(receipt)}\n`
  diskGuard(out, stat, Buffer.byteLength(bytes))
  mkdirSync(out, { recursive: true })
  const path = join(out, name(receipt.block))
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 })
    linkSync(temp, path)
  } finally {
    if (existsSync(temp)) unlinkSync(temp)
  }
  return path
}

export function verify({ out = OUT, identity = sourceIdentity(), checkpoints, nowUtc } = {}) {
  const rows = checkpoints ?? readValidatedCheckpoints({ out: QUOTE_OUT, identity })
  if (!existsSync(out)) return { count: 0, latestBlock: null }
  const files = readdirSync(out)
    .filter((file) => file.endsWith('.json'))
    .sort()
  const seen = new Set()
  for (const file of files) {
    const { receipt } = readCanonicalReceipt(join(out, file), {
      identity,
      checkpoints: rows,
      nowUtc,
    })
    if (file !== name(receipt.block) || seen.has(receipt.block.number))
      throw new Error('Attestation filename or duplicate block mismatch')
    seen.add(receipt.block.number)
  }
  return { count: files.length, latestBlock: files.length ? Math.max(...seen) : null }
}

export async function run({
  client,
  out = OUT,
  identity = sourceIdentity(),
  checkpoints,
  stat = statfsSync,
  now = () => new Date(),
} = {}) {
  const rows = checkpoints ?? readValidatedCheckpoints({ out: QUOTE_OUT, identity })
  verify({ out, identity, checkpoints: rows, nowUtc: now().toISOString() })
  const latest = rows.at(-1)
  if (!latest) throw new Error('No verified quote checkpoint')
  const path = join(out, name(latest.checkpoint.block))
  if (existsSync(path)) {
    const { receipt } = readCanonicalReceipt(path, {
      identity,
      checkpoints: rows,
      nowUtc: now().toISOString(),
    })
    return { status: 'unchanged', path, target: receipt.target }
  }
  diskGuard(out, stat)
  const receipt = await capture({ client, checkpoints: rows, identity, now })
  try {
    return {
      status: 'attested',
      path: save({ receipt, out, stat, identity, checkpoints: rows, nowUtc: now().toISOString() }),
      target: receipt.target,
    }
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    // Another writer may have won the immutable link. Treat it as unchanged
    // only if the whole journal and this exact checkpoint still verify.
    verify({ out, identity, checkpoints: rows, nowUtc: now().toISOString() })
    const { receipt: existing } = readCanonicalReceipt(path, {
      identity,
      checkpoints: rows,
      nowUtc: now().toISOString(),
    })
    return { status: 'unchanged', path, target: existing.target }
  }
}

export function parseCli(args) {
  if (!args.length || (args.length === 1 && args[0] === '--verify')) return '--verify'
  if (args.length === 1 && args[0] === '--run') return '--run'
  throw new Error('Invalid attestation CLI')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const mode = parseCli(process.argv.slice(2))
    if (mode === '--verify') console.log(JSON.stringify(verify()))
    else {
      const configured = process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL') || ''
      const rpc = configured.split(',').map((item) => item.trim())[0]
      if (!rpc || !/^https?:\/\//.test(rpc)) throw new Error('No configured RPC')
      console.log(JSON.stringify(await run({ client: makeClient(rpc) })))
    }
  } catch {
    console.error('[scrvusd-target-code-attestation] unavailable')
    process.exitCode = 1
  }
}
