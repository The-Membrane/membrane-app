// Prospective sUSDS vault identity checkpoints for comparable-vault research.
// No holder selection, exit claim, alert, or database write.
// Sky documents ERC-4626/UUPS semantics at developers.skyeco.com/protocol/tokens/susds/;
// source at github.com/sky-ecosystem/sdai/blob/susds/src/SUsds.sol is not proof
// that any observed deployed implementation matches that repository revision.
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
import { decodeFunctionResult, encodeFunctionData, keccak256, parseAbi } from 'viem'
import { loadConfig, makeClient, readEnv } from '../lib/venue-reads.mjs'

export const STUDY = 'susds-finalized-vault-checkpoint-v1'
export const OUT = resolve('data/research/venue-signals/susds-finalized-checkpoints')
export const RESERVE_BYTES = 1_073_741_824
export const IMPLEMENTATION_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const VAULT = '0xa3931d71877c0e7a3148cb7eb4463524fec27fbd'
const USDS = '0xdc035d45d973e3ec169d2276ddab16f1e407384f'
const ADDRESS = /^0x[0-9a-f]{40}$/
const HASH = /^0x[0-9a-f]{64}$/
const RAW = /^(0|[1-9][0-9]*)$/
const HEX_CODE = /^0x(?:[0-9a-f]{2})+$/
const ABI = parseAbi([
  'function asset() view returns (address)',
  'function decimals() view returns (uint8)',
  'function totalAssets() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function convertToAssets(uint256) view returns (uint256)',
])
const CAVEAT =
  'One finalized-block source and state observation; code hashes do not establish historical implementation parity or holder exit feasibility.'
const NUMBER_PIN_CAVEAT =
  'EIP-1898 unsupported: all reads pinned by number, with canonical block hash rechecked before sealing.'
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const lower = (value) => (typeof value === 'string' ? value.toLowerCase() : '')
const unsigned = ({ sha256: _sha256, ...rest }) => rest
const seal = (payload) => ({ ...payload, sha256: sha(JSON.stringify(payload)) })
const filename = (block) => `${String(block.number).padStart(12, '0')}-${block.hash.slice(2)}.json`

export function sourceIdentity(venues = loadConfig()) {
  const matches = venues.filter((venue) => venue.name === 'sUSDS' && venue.enabled)
  if (
    matches.length !== 1 ||
    lower(matches[0].address) !== VAULT ||
    lower(matches[0].underlying) !== USDS ||
    matches[0].decimals !== 18
  )
    throw new Error('Configured sUSDS vault or asset identity changed')
  const source = { chainId: 1, vault: VAULT, asset: USDS, decimals: 18 }
  return { ...source, identitySha256: sha(JSON.stringify(source)) }
}

function validateIdentity(identity) {
  const expected = { chainId: 1, vault: VAULT, asset: USDS, decimals: 18 }
  if (
    JSON.stringify(identity) !==
    JSON.stringify({ ...expected, identitySha256: sha(JSON.stringify(expected)) })
  )
    throw new Error('sUSDS source identity drift')
  return identity
}

function parseBlock(value) {
  const number = Number(BigInt(value?.number ?? -1))
  const timestamp = Number(BigInt(value?.timestamp ?? -1))
  const hash = lower(value?.hash)
  if (
    !Number.isSafeInteger(number) ||
    number < 0 ||
    !Number.isSafeInteger(timestamp) ||
    timestamp <= 0 ||
    !HASH.test(hash)
  )
    throw new Error('Invalid finalized block')
  return { number, hash, timestamp }
}

function parseImplementationSlot(value) {
  const word = lower(value)
  if (!HASH.test(word)) throw new Error('Invalid implementation storage word')
  if (word === `0x${'0'.repeat(64)}`) return { slotWord: word, implementation: null }
  if (!/^0x0{24}[0-9a-f]{40}$/.test(word)) throw new Error('Malformed implementation slot')
  const implementation = `0x${word.slice(-40)}`
  if (!ADDRESS.test(implementation) || implementation === `0x${'0'.repeat(40)}`)
    throw new Error('Invalid implementation address')
  return { slotWord: word, implementation }
}

export function validateCheckpoint(row, identity = sourceIdentity()) {
  validateIdentity(identity)
  if (!row || row.sha256 !== sha(JSON.stringify(unsigned(row))))
    throw new Error('Checkpoint logical seal mismatch')
  const p = unsigned(row)
  const implementation = parseImplementationSlot(p.contract?.implementationSlotWord)
  if (
    p.study !== STUDY ||
    JSON.stringify(p.source) !== JSON.stringify(identity) ||
    !Number.isSafeInteger(p.block?.number) ||
    p.block.number < 0 ||
    !HASH.test(p.block.hash) ||
    !Number.isSafeInteger(p.block.timestamp) ||
    p.block.timestamp <= 0 ||
    !Number.isFinite(Date.parse(p.captureStartUtc)) ||
    !Number.isFinite(Date.parse(p.captureEndUtc)) ||
    Date.parse(p.captureEndUtc) < Date.parse(p.captureStartUtc) ||
    !['hash', 'number-hash-checked'].includes(p.pinMode) ||
    p.pinCaveat !== (p.pinMode === 'hash' ? null : NUMBER_PIN_CAVEAT) ||
    !HASH.test(p.contract?.vaultCodeHash) ||
    p.contract.implementation !== implementation.implementation ||
    (implementation.implementation === null
      ? p.contract.implementationCodeHash !== null
      : !HASH.test(p.contract.implementationCodeHash)) ||
    p.state?.asset !== USDS ||
    p.state?.decimals !== 18 ||
    !RAW.test(p.state?.totalAssetsRaw || '') ||
    !RAW.test(p.state?.totalSupplyRaw || '') ||
    !RAW.test(p.state?.assetsPerShareRaw || '') ||
    p.caveat !== CAVEAT
  )
    throw new Error('Invalid sUSDS checkpoint')
  return row
}

function readRow(path, identity) {
  const bytes = readFileSync(path)
  const row = validateCheckpoint(JSON.parse(bytes.toString('utf8')), identity)
  if (!bytes.equals(Buffer.from(JSON.stringify(row) + '\n')))
    throw new Error('Checkpoint physical bytes mismatch')
  return { checkpoint: row, physicalSha256: sha(bytes) }
}

export function readValidatedCheckpoints({ out = OUT, identity = sourceIdentity() } = {}) {
  validateIdentity(identity)
  if (!existsSync(out)) return []
  const files = readdirSync(out)
    .filter((name) => name.endsWith('.json'))
    .sort()
  const seen = new Set()
  return files.map((name) => {
    const result = readRow(join(out, name), identity)
    const block = result.checkpoint.block
    if (name !== filename(block) || seen.has(block.number))
      throw new Error('Checkpoint filename or duplicate finalized height')
    seen.add(block.number)
    return { ...result, filename: name }
  })
}

export function verify({ out = OUT, identity = sourceIdentity() } = {}) {
  const rows = readValidatedCheckpoints({ out, identity })
  return {
    count: rows.length,
    latestBlock: rows.length ? rows.at(-1).checkpoint.block.number : null,
  }
}

function diskGuard(out, stat = statfsSync, extra = 0) {
  let ancestor = out
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor)
    if (parent === ancestor) throw new Error('No output ancestor')
    ancestor = parent
  }
  const fs = stat(ancestor)
  if (Number(fs.bavail) * Number(fs.bsize) - extra < RESERVE_BYTES)
    throw new Error('sUSDS checkpoint disk reserve reached')
}

function append(out, row, stat) {
  const bytes = JSON.stringify(row) + '\n'
  diskGuard(out, stat, Buffer.byteLength(bytes))
  const target = join(out, filename(row.block))
  const temp = `${target}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 })
    linkSync(temp, target)
  } finally {
    if (existsSync(temp)) unlinkSync(temp)
  }
  return { path: target, physicalSha256: sha(Buffer.from(bytes)) }
}

async function lock(out, timeoutMs) {
  mkdirSync(out, { recursive: true })
  const path = join(out, '.collection.lock')
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      mkdirSync(path, { mode: 0o700 })
      return () => rmdirSync(path)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      if (Date.now() >= deadline)
        throw new Error('sUSDS collection lock busy or stale; manual audit required')
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
}

function unsupportedHashPin(error) {
  const message = `${error?.message || ''} ${error?.cause?.message || ''}`.toLowerCase()
  return /blockhash.*(not supported|unsupported|invalid argument)|eip.?1898.*(not supported|unsupported)|cannot unmarshal object|invalid block parameter/.test(
    message,
  )
}

export async function collect({
  client,
  out = OUT,
  identity = sourceIdentity(),
  now = () => new Date(),
  stat = statfsSync,
  lockTimeoutMs = 30_000,
} = {}) {
  if (!client?.request) throw new Error('One RPC client is required')
  validateIdentity(identity)
  if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 0 || lockTimeoutMs > 120_000)
    throw new Error('Invalid lock timeout')
  diskGuard(out, stat)
  const release = await lock(out, lockTimeoutMs)
  try {
    const rows = readValidatedCheckpoints({ out, identity })
    const request = (method, params) => client.request({ method, params })
    const captureStartUtc = now().toISOString()
    if (Number(BigInt(await request('eth_chainId', []))) !== 1) throw new Error('Wrong chain ID')
    const at = parseBlock(await request('eth_getBlockByNumber', ['finalized', false]))
    const canonicalCheck = async () => {
      const canonical = parseBlock(
        await request('eth_getBlockByNumber', [`0x${at.number.toString(16)}`, false]),
      )
      if (canonical.hash !== at.hash || canonical.timestamp !== at.timestamp)
        throw new Error('Canonical finalized block drift')
    }
    const existing = rows.find((row) => row.checkpoint.block.number === at.number)
    if (existing) {
      if (
        existing.checkpoint.block.hash !== at.hash ||
        existing.checkpoint.block.timestamp !== at.timestamp
      )
        throw new Error('Finalized-height conflict with saved checkpoint')
      await canonicalCheck()
      return {
        status: 'unchanged',
        block: at.number,
        path: join(out, existing.filename),
        physicalSha256: existing.physicalSha256,
      }
    }
    if (rows.length && at.number <= rows.at(-1).checkpoint.block.number)
      throw new Error('Finalized block predates saved prospective checkpoint')
    const age = Date.parse(captureStartUtc) / 1000 - at.timestamp
    if (age < -60 || age > 3600) throw new Error('Finalized block stale or ahead of clock')
    const pinned = (mode) =>
      mode === 'hash'
        ? { blockHash: at.hash, requireCanonical: true }
        : `0x${at.number.toString(16)}`
    const call = async (functionName, args, mode) => {
      const data = encodeFunctionData({ abi: ABI, functionName, args })
      const value = await request('eth_call', [{ to: VAULT, data }, pinned(mode)])
      if (typeof value !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(value))
        throw new Error('Incomplete pinned vault call')
      return decodeFunctionResult({ abi: ABI, functionName, data: value })
    }
    let pinMode = 'hash'
    let asset
    try {
      asset = lower(await call('asset', [], pinMode))
    } catch (error) {
      if (!unsupportedHashPin(error)) throw error
      pinMode = 'number-hash-checked'
      asset = lower(await call('asset', [], pinMode))
    }
    if (asset !== USDS) throw new Error('Pinned vault asset mismatch')
    const [decimals, totalAssets, totalSupply, assetsPerShare] = await Promise.all([
      call('decimals', [], pinMode),
      call('totalAssets', [], pinMode),
      call('totalSupply', [], pinMode),
      call('convertToAssets', [10n ** 18n], pinMode),
    ])
    if (Number(decimals) !== 18) throw new Error('Pinned sUSDS decimals mismatch')
    const [vaultCode, slotWord] = await Promise.all([
      request('eth_getCode', [VAULT, pinned(pinMode)]),
      request('eth_getStorageAt', [VAULT, IMPLEMENTATION_SLOT, pinned(pinMode)]),
    ])
    if (!HEX_CODE.test(lower(vaultCode))) throw new Error('Missing pinned vault code')
    const implementation = parseImplementationSlot(slotWord)
    let implementationCodeHash = null
    if (implementation.implementation !== null) {
      const code = lower(
        await request('eth_getCode', [implementation.implementation, pinned(pinMode)]),
      )
      if (!HEX_CODE.test(code)) throw new Error('Missing pinned implementation code')
      implementationCodeHash = keccak256(code)
    }
    await canonicalCheck()
    const captureEndUtc = now().toISOString()
    if (Date.parse(captureEndUtc) / 1000 - at.timestamp > 3600)
      throw new Error('Finalized block became stale during capture')
    const row = seal({
      study: STUDY,
      source: identity,
      captureStartUtc,
      captureEndUtc,
      block: at,
      pinMode,
      pinCaveat: pinMode === 'hash' ? null : NUMBER_PIN_CAVEAT,
      contract: {
        vaultCodeHash: keccak256(lower(vaultCode)),
        implementationSlotWord: implementation.slotWord,
        implementation: implementation.implementation,
        implementationCodeHash,
      },
      state: {
        asset,
        decimals: Number(decimals),
        totalAssetsRaw: String(totalAssets),
        totalSupplyRaw: String(totalSupply),
        assetsPerShareRaw: String(assetsPerShare),
      },
      caveat: CAVEAT,
    })
    validateCheckpoint(row, identity)
    const saved = append(out, row, stat)
    return { status: 'recorded', block: at.number, ...saved }
  } finally {
    release()
  }
}

function parseOptions(args) {
  const options = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!['--run', '--verify', '--rpc'].includes(arg) || options[arg])
      throw new Error('Unknown or duplicate option')
    options[arg] = arg === '--rpc' ? args[++i] : true
    if (!options[arg]) throw new Error('Missing RPC option value')
  }
  if ((options['--run'] && options['--verify']) || (options['--rpc'] && !options['--run']))
    throw new Error('Incompatible options')
  return options
}

export function selectRpc(explicit, configured) {
  if (explicit !== undefined) {
    if (typeof explicit !== 'string' || !explicit.trim() || explicit.includes(','))
      throw new Error('Exactly one explicit RPC host required')
    return explicit.trim()
  }
  const first = typeof configured === 'string' ? configured.split(',')[0].trim() : ''
  if (!first) throw new Error('Configured RPC host missing')
  return first
}

async function main() {
  const options = parseOptions(process.argv.slice(2))
  if (options['--verify']) return console.log(JSON.stringify(verify()))
  const identity = sourceIdentity()
  if (!options['--run'])
    return console.log(JSON.stringify({ mode: 'dry', study: STUDY, source: identity, out: OUT }))
  const configured = options['--rpc']
    ? undefined
    : process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')
  const rpc = selectRpc(options['--rpc'], configured)
  console.log(JSON.stringify(await collect({ client: makeClient(rpc), identity })))
}

export const safeCliError = () => 'sUSDS checkpoint collection or verification failed'

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    // Provider messages can contain RPC URLs or credentials.
    console.error(safeCliError())
    process.exitCode = 1
  })
}
