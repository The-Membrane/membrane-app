// Prospective, append-only observations of the nominal $1m crvUSD secondary quote.
// A quote is neither a scrvUSD redemption nor an executable swap fill.
// Dry by default. --run records one finalized mainnet block; --verify is offline.
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
import { decodeFunctionResult, encodeFunctionData, parseAbi } from 'viem'
import { loadConfig, makeClient, readEnv } from '../lib/venue-reads.mjs'

export const STUDY = 'curve-crvusd-secondary-prospective-quote-v1'
export const STUDY_V2 = 'curve-crvusd-secondary-prospective-quote-v2'
export const OUT = resolve('data/research/venue-signals/curve-prospective-quotes')
export const RESERVE_BYTES = 1_073_741_824
export const PARTS = [25_000, 50_000, 75_000, 100_000, 250_000, 500_000, 750_000, 1_000_000]
export const SHARES = [0, 0.25, 0.5, 0.75, 1]
const Q = 1_000_000
const HISTORICAL_LAST_BLOCK = 26_052_485
const HASH = /^0x[0-9a-f]{64}$/
const DECIMAL = /^(0|[1-9][0-9]*)$/
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7'
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const CRVUSD = '0xf939e0a03fb07f59a73314e73794be0e57ac1b4e'
const VAULT = '0x0655977feb2f289a4ab78af67bab0d17aab84367'
const POOLS = [
  '0x390f3595bca2df7d23783dfd126427cceb997bf4',
  '0x4dece678ceceb27446b35c672dc7d61f30bad69e',
]
const ABI = parseAbi([
  'function coins(uint256) view returns (address)',
  'function balances(uint256) view returns (uint256)',
  'function fee() view returns (uint256)',
  'function A() view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function asset() view returns (address)',
  'function totalAssets() view returns (uint256)',
  'function get_dy(int128,int128,uint256) view returns (uint256)',
])
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const unsigned = ({ sha256: _sha256, ...rest }) => rest
const sealed = (payload) => ({ ...payload, sha256: sha(JSON.stringify(payload)) })
const lower = (value) => (typeof value === 'string' ? value.toLowerCase() : '')
const NUMBER_PIN_CAVEAT =
  'EIP-1898 unsupported: calls pinned by block number; canonical hash rechecked before sealing.'
const QUOTE_CAVEAT =
  'Nominal Curve get_dy only; not a scrvUSD holder withdrawal, executable fill, gas-adjusted result, or MEV bound.'
class QuoteCliError extends Error {
  constructor(reason, cause) {
    super(reason === 'disk_reserve' ? 'Quote disk reserve reached' : 'Quote CLI operation failed', {
      cause,
    })
    this.reason = reason
  }
}
const raw = (value) => {
  if (typeof value !== 'string' || !DECIMAL.test(value)) throw new Error('Invalid raw quote amount')
  return BigInt(value)
}

export function sourceIdentity(venues = loadConfig()) {
  const venue = venues.filter((v) => v.name === 'scrvUSD' && v.enabled)
  const pools = venue[0]?.depthMarkets?.filter((p) => p.enabled && p.kind === 'curve-stableswap')
  if (
    venue.length !== 1 ||
    lower(venue[0].address) !== VAULT ||
    lower(venue[0].underlying) !== CRVUSD ||
    venue[0].decimals !== 18 ||
    pools?.length !== 2
  )
    throw new Error('Configured venue identity changed')
  for (let i = 0; i < 2; i++) {
    const p = pools[i]
    if (
      lower(p.address) !== POOLS[i] ||
      lower(p.token0) !== [USDT, USDC][i] ||
      lower(p.token1) !== CRVUSD ||
      lower(p.exitFrom) !== CRVUSD
    )
      throw new Error('Configured pool identity or coin orientation changed')
  }
  const identity = {
    chainId: 1,
    vault: VAULT,
    crvUsd: CRVUSD,
    pools: POOLS.map((address, i) => ({
      address,
      coin0: [USDT, USDC][i],
      coin1: CRVUSD,
      decimals0: 6,
      decimals1: 18,
    })),
  }
  return { ...identity, identitySha256: sha(JSON.stringify(identity)) }
}

function block(value) {
  const number = Number(BigInt(value?.number ?? -1))
  const timestamp = Number(BigInt(value?.timestamp ?? -1))
  if (
    !Number.isSafeInteger(number) ||
    number < 0 ||
    !Number.isSafeInteger(timestamp) ||
    timestamp < 0 ||
    !HASH.test(lower(value?.hash))
  )
    throw new Error('Invalid finalized block identity')
  return { number, hash: lower(value.hash), timestamp }
}

export function routesFromParts(parts) {
  if (
    !Array.isArray(parts) ||
    parts.length !== 2 ||
    parts.some((side) => !Array.isArray(side) || side.length !== PARTS.length)
  )
    throw new Error('Incomplete quote parts')
  const outputs = parts.map((side) => side.map(raw))
  const grid = SHARES.map((usdtShare) => {
    const usdt = Q * usdtShare,
      usdc = Q - usdt
    const outputRaw =
      (usdt ? outputs[0][PARTS.indexOf(usdt)] : 0n) + (usdc ? outputs[1][PARTS.indexOf(usdc)] : 0n)
    return {
      usdtShare,
      usdtInput: String(usdt),
      usdcInput: String(usdc),
      outputRaw: String(outputRaw),
      output: Number(outputRaw) / 1e6,
    }
  })
  const bestRaw = grid.reduce(
    (best, row) => (BigInt(row.outputRaw) > best ? BigInt(row.outputRaw) : best),
    0n,
  )
  return { 1000000: { grid, bestOutputRaw: String(bestRaw), bestQuote: Number(bestRaw) / 1e12 } }
}

function gridLegsFromParts(parts) {
  const outputs = parts.map((side) => side.map(raw))
  return SHARES.map((usdtShare) => {
    const usdtInput = Q * usdtShare
    const usdcInput = Q - usdtInput
    const leg = (poolIndex, input) => ({
      pool: POOLS[poolIndex],
      crvUsdInputRaw: String(BigInt(input) * 10n ** 18n),
      outputRaw: input ? String(outputs[poolIndex][PARTS.indexOf(input)]) : '0',
    })
    return { usdtShare, usdt: leg(0, usdtInput), usdc: leg(1, usdcInput) }
  })
}

function validCodeSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function validateV2Raw(rawState, parts) {
  const expectedAddresses = [VAULT, CRVUSD, USDT, USDC, ...POOLS]
  if (
    !Array.isArray(rawState?.poolStates) ||
    rawState.poolStates.length !== POOLS.length ||
    rawState.poolStates.some(
      (pool, i) =>
        pool?.address !== POOLS[i] ||
        !Array.isArray(pool.balancesRaw) ||
        pool.balancesRaw.length !== 2 ||
        pool.balancesRaw.some((value) => !DECIMAL.test(value)) ||
        !DECIMAL.test(pool.feeRaw) ||
        !DECIMAL.test(pool.ARaw) ||
        BigInt(pool.ARaw) <= 0n,
    ) ||
    !Array.isArray(rawState?.codeIdentities) ||
    rawState.codeIdentities.length !== expectedAddresses.length ||
    rawState.codeIdentities.some(
      (row, i) => row?.address !== expectedAddresses[i] || !validCodeSha(row.codeSha256),
    ) ||
    JSON.stringify(rawState.gridLegs) !== JSON.stringify(gridLegsFromParts(parts))
  )
    throw new Error('Invalid or incomplete v2 pool state, code identity, or quote legs')
}

function validateCheckpoint(saved, identity) {
  if (saved?.sha256 !== sha(JSON.stringify(unsigned(saved))))
    throw new Error('Checkpoint SHA mismatch')
  const p = unsigned(saved)
  if (
    ![STUDY, STUDY_V2].includes(p.study) ||
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
    p.pinCaveat !== (p.pinMode === 'number-hash-checked' ? NUMBER_PIN_CAVEAT : null) ||
    !DECIMAL.test(p.raw?.vaultAssetsCrvUsd || '') ||
    BigInt(p.raw.vaultAssetsCrvUsd) <= 0n ||
    JSON.stringify(p.routes) !== JSON.stringify(routesFromParts(p.raw?.parts))
  )
    throw new Error('Invalid or incomplete checkpoint')
  if (p.study === STUDY_V2) validateV2Raw(p.raw, p.raw.parts)
  if (p.study === STUDY_V2 && p.quoteCaveat !== QUOTE_CAVEAT)
    throw new Error('Missing v2 nominal-quote caveat')
  return p
}

export function verify({ out = OUT, identity = sourceIdentity() } = {}) {
  if (!existsSync(out)) return { count: 0, latestBlock: null }
  const files = readdirSync(out)
    .filter((name) => name.endsWith('.json'))
    .sort()
  const seen = new Set()
  let latestBlock = null
  for (const file of files) {
    const saved = JSON.parse(readFileSync(join(out, file), 'utf8'))
    const p = validateCheckpoint(saved, identity)
    if (
      file !== `${String(p.block.number).padStart(12, '0')}-${p.block.hash.slice(2)}.json` ||
      seen.has(p.block.number)
    )
      throw new Error('Duplicate block or checkpoint filename mismatch')
    seen.add(p.block.number)
    latestBlock = Math.max(latestBlock ?? 0, p.block.number)
  }
  return { count: files.length, latestBlock }
}

// Consumers use this reader so every row is checked against the recorder's
// original seal, route reconstruction, source identity, and filename rule.
export function readValidatedCheckpoints({ out = OUT, identity = sourceIdentity() } = {}) {
  verify({ out, identity })
  if (!existsSync(out)) return []
  return readdirSync(out)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const bytes = readFileSync(join(out, name))
      const saved = JSON.parse(bytes.toString('utf8'))
      const checkpoint = validateCheckpoint(saved, identity)
      // Keep the validated logical seal as well as the byte-level seal. Forecast
      // receipts bind both; validateCheckpoint intentionally returns unsigned data.
      return {
        checkpoint: { ...checkpoint, sha256: saved.sha256 },
        physicalSha256: sha(bytes),
        filename: name,
      }
    })
    .sort((a, b) => a.checkpoint.block.timestamp - b.checkpoint.block.timestamp)
}

function diskGuard(out, stat = statfsSync, extra = 0) {
  let path = out
  while (!existsSync(path)) {
    const parent = dirname(path)
    if (parent === path) throw new Error('No existing output ancestor')
    path = parent
  }
  const fs = stat(path)
  if (Number(fs.bavail) * Number(fs.bsize) - extra < RESERVE_BYTES)
    throw new QuoteCliError('disk_reserve')
}

function append(out, checkpoint, stat) {
  const bytes = JSON.stringify(checkpoint) + '\n'
  diskGuard(out, stat, Buffer.byteLength(bytes))
  mkdirSync(out, { recursive: true })
  const target = join(
    out,
    `${String(checkpoint.block.number).padStart(12, '0')}-${checkpoint.block.hash.slice(2)}.json`,
  )
  const temp = `${target}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 })
    linkSync(temp, target)
  } finally {
    if (existsSync(temp)) unlinkSync(temp)
  }
  return target
}

function isUnsupportedHashPin(error) {
  const message = `${error?.message || ''} ${error?.cause?.message || ''}`.toLowerCase()
  return /blockhash.*(not supported|unsupported|invalid argument)|eip.?1898.*(not supported|unsupported)|cannot unmarshal object|invalid block parameter/.test(
    message,
  )
}

async function acquireCollectionLock(out, timeoutMs) {
  mkdirSync(out, { recursive: true })
  const path = join(out, '.collection.lock')
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      mkdirSync(path, { mode: 0o700 })
      return () => rmdirSync(path)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      // A crashed writer leaves the directory behind. Never break it by age:
      // an apparently stale owner could still be writing a sealed receipt.
      if (Date.now() >= deadline)
        throw new Error('Quote collection lock busy or stale; manual audit required')
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
}

export async function collect(options = {}) {
  const { client, out = OUT, stat = statfsSync, lockTimeoutMs = 30_000 } = options
  if (!client?.request) throw new Error('One RPC client is required')
  if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 0 || lockTimeoutMs > 120_000)
    throw new Error('Invalid collection lock timeout')
  diskGuard(out, stat)
  const release = await acquireCollectionLock(out, lockTimeoutMs)
  try {
    return await collectLocked(options)
  } finally {
    release()
  }
}

async function collectLocked({
  client,
  out = OUT,
  identity = sourceIdentity(),
  stat = statfsSync,
  now = () => new Date(),
} = {}) {
  let existing
  try {
    existing = verify({ out, identity })
  } catch (error) {
    throw new QuoteCliError('verification_failed', error)
  }
  const captureStartUtc = now().toISOString()
  const request = async (method, params) => {
    try {
      return await client.request({ method, params })
    } catch (error) {
      throw new QuoteCliError('rpc_failure', error)
    }
  }
  if (Number(BigInt(await request('eth_chainId', []))) !== 1) throw new Error('Wrong chain ID')
  const at = block(await request('eth_getBlockByNumber', ['finalized', false]))
  const existingPath = join(out, `${String(at.number).padStart(12, '0')}-${at.hash.slice(2)}.json`)
  if (existsSync(existingPath)) {
    // verify() checked the whole append-only set and its source identity. Recheck
    // this receipt and the canonical block before treating a replay as unchanged.
    const saved = JSON.parse(readFileSync(existingPath, 'utf8'))
    const checkpoint = validateCheckpoint(saved, identity)
    if (
      checkpoint.block.number !== at.number ||
      checkpoint.block.hash !== at.hash ||
      checkpoint.block.timestamp !== at.timestamp
    )
      throw new Error('Existing checkpoint conflicts with finalized block')
    const canonical = block(
      await request('eth_getBlockByNumber', [`0x${at.number.toString(16)}`, false]),
    )
    if (canonical.hash !== at.hash || canonical.timestamp !== at.timestamp)
      throw new Error('Canonical block hash drift')
    return {
      status: 'unchanged',
      path: existingPath,
      block: at.number,
      bestQuote: checkpoint.routes['1000000'].bestQuote,
      pinMode: checkpoint.pinMode,
      pinCaveat: checkpoint.pinCaveat,
    }
  }
  if (
    at.number <= HISTORICAL_LAST_BLOCK ||
    (existing.latestBlock !== null && at.number <= existing.latestBlock)
  )
    throw new Error('Finalized block is not a new prospective checkpoint')
  const ageSeconds = Math.floor(Date.parse(captureStartUtc) / 1000) - at.timestamp
  if (ageSeconds < -60 || ageSeconds > 3600)
    throw new Error('Finalized block is stale or ahead of capture clock')
  const pinnedBlock = (pinMode) =>
    pinMode === 'hash'
      ? { blockHash: at.hash, requireCanonical: true }
      : `0x${at.number.toString(16)}`
  const call = async (address, functionName, args = [], pinMode = 'hash') => {
    const data = encodeFunctionData({ abi: ABI, functionName, args })
    const value = await request('eth_call', [{ to: address, data }, pinnedBlock(pinMode)])
    if (typeof value !== 'string' || !/^0x[\da-fA-F]+$/.test(value))
      throw new Error('Incomplete pinned call')
    return decodeFunctionResult({ abi: ABI, functionName, data: value })
  }
  let pinMode = 'hash'
  try {
    await call(POOLS[0], 'coins', [0n])
  } catch (error) {
    if (!isUnsupportedHashPin(error)) throw error
    pinMode = 'number-hash-checked'
  }
  const read = (address, functionName, args = []) => call(address, functionName, args, pinMode)
  const asset = lower(await read(VAULT, 'asset'))
  if (asset !== CRVUSD) throw new Error('Vault asset identity mismatch')
  for (let i = 0; i < 2; i++) {
    if (
      lower(await read(POOLS[i], 'coins', [0n])) !== [USDT, USDC][i] ||
      lower(await read(POOLS[i], 'coins', [1n])) !== CRVUSD ||
      Number(await read([USDT, USDC][i], 'decimals')) !== 6 ||
      Number(await read(CRVUSD, 'decimals')) !== 18
    )
      throw new Error('Onchain pool coin orientation or decimals mismatch')
  }
  const vaultAssetsCrvUsd = String(await read(VAULT, 'totalAssets'))
  const poolStates = []
  for (const pool of POOLS)
    poolStates.push({
      address: pool,
      balancesRaw: [
        String(await read(pool, 'balances', [0n])),
        String(await read(pool, 'balances', [1n])),
      ],
      feeRaw: String(await read(pool, 'fee')),
      ARaw: String(await read(pool, 'A')),
    })
  const codeIdentities = []
  for (const address of [VAULT, CRVUSD, USDT, USDC, ...POOLS]) {
    const code = await request('eth_getCode', [address, pinnedBlock(pinMode)])
    if (typeof code !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(code))
      throw new Error('Missing or invalid pinned onchain code identity')
    codeIdentities.push({ address, codeSha256: sha(Buffer.from(code.slice(2), 'hex')) })
  }
  const parts = []
  for (const pool of POOLS) {
    const side = []
    for (const part of PARTS)
      side.push(String(await read(pool, 'get_dy', [1n, 0n, BigInt(part) * 10n ** 18n])))
    parts.push(side)
  }
  const routes = routesFromParts(parts)
  const gridLegs = gridLegsFromParts(parts)
  const canonical = block(
    await request('eth_getBlockByNumber', [`0x${at.number.toString(16)}`, false]),
  )
  if (canonical.hash !== at.hash || canonical.timestamp !== at.timestamp)
    throw new Error('Canonical block hash drift')
  const captureEndUtc = now().toISOString()
  if (Date.parse(captureEndUtc) / 1000 - at.timestamp > 3600)
    throw new Error('Finalized block became stale during capture')
  const checkpoint = sealed({
    study: STUDY_V2,
    source: identity,
    captureStartUtc,
    captureEndUtc,
    block: at,
    pinMode,
    pinCaveat: pinMode === 'number-hash-checked' ? NUMBER_PIN_CAVEAT : null,
    quoteCaveat: QUOTE_CAVEAT,
    raw: { vaultAssetsCrvUsd, parts, poolStates, codeIdentities, gridLegs },
    routes,
  })
  validateCheckpoint(checkpoint, identity)
  const path = append(out, checkpoint, stat)
  return {
    status: 'recorded',
    path,
    block: at.number,
    bestQuote: routes['1000000'].bestQuote,
    pinMode,
    pinCaveat: checkpoint.pinCaveat,
  }
}

export function selectRpc(explicit, configured) {
  if (explicit !== undefined) {
    if (typeof explicit !== 'string' || !explicit.trim() || explicit.includes(','))
      throw new Error('Exactly one RPC host required for --rpc')
    return explicit.trim()
  }
  const first = typeof configured === 'string' ? configured.split(',')[0].trim() : ''
  if (!first) throw new Error('Configured RPC host missing')
  return first
}

function options(args) {
  const opts = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!['--run', '--verify', '--rpc'].includes(arg) || opts[arg])
      throw new Error('Unknown or duplicate option')
    opts[arg] = arg === '--rpc' ? args[++i] : true
    if (!opts[arg]) throw new Error('Missing RPC option value')
  }
  if ((opts['--run'] && opts['--verify']) || (opts['--rpc'] && !opts['--run']))
    throw new Error('Incompatible options')
  return opts
}

async function main() {
  const opts = options(process.argv.slice(2))
  if (opts['--verify']) {
    try {
      return console.log(JSON.stringify(verify()))
    } catch (error) {
      throw new QuoteCliError('verification_failed', error)
    }
  }
  const identity = sourceIdentity()
  if (!opts['--run'])
    return console.log(JSON.stringify({ mode: 'dry', study: STUDY_V2, out: OUT, source: identity }))
  const configured = opts['--rpc']
    ? undefined
    : process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')
  const rpc = selectRpc(opts['--rpc'], configured)
  const result = await collect({ client: makeClient(rpc) })
  console.log(JSON.stringify(result))
}

export const safeCliError = (error) =>
  JSON.stringify({
    status: 'error',
    study: STUDY_V2,
    reason: error instanceof QuoteCliError ? error.reason : 'collection_failed',
  })

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    // Emit only locally assigned reason codes; provider errors can contain credentials.
    console.error(safeCliError(error))
    process.exitCode = 1
  })
}
