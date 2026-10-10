// Same-asset Compound III supply-rate control at a sealed Aave Core anchor.
// This is a prospective feature capture, not an exit outcome or an alert.
// Comet addresses: compound-finance/comet deployments/mainnet/{usdc,usdt}/roots.json.
import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { decodeFunctionResult, encodeFunctionData, keccak256 } from 'viem'
import { MARKETS, diskGuard } from './aave-core-forward-panel.mjs'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'

export const STUDY = 'aave-compound-peer-rate-v1'
export const OUTPUT_ROOT = resolve('data/research/venue-signals')
export const SOURCE = resolve(
  'data/research/venue-signals/aave-core-anchor-features-2026-09-26.json',
)
export const SOURCE_SHA256 = 'df984f6bcabab38220b18a36627224bd14614ee868ef4dc1a51c7d9b32c2e708'
export const DEFAULT_OUT = resolve(
  'data/research/venue-signals/aave-compound-peer-rate-2026-09-26.json',
)
export const BLOCK = 26_059_633
export const COMETS = Object.freeze([
  Object.freeze({
    name: 'USDC',
    address: '0xc3d688B66703497DAA19211EEdff47f25384cdc3',
    base: MARKETS[0].base,
  }),
  Object.freeze({
    name: 'USDT',
    address: '0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840',
    base: MARKETS[1].base,
  }),
])
const SECONDS_PER_YEAR = 31_536_000n
const RAY = 10n ** 27n
const COMET_RATE_SCALE = 10n ** 18n
const SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const ZERO = '0x0000000000000000000000000000000000000000'
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const seal = (payload) => hash(JSON.stringify(payload))
const lower = (value) => String(value || '').toLowerCase()
const isHash = (value) => /^0x[0-9a-fA-F]{64}$/.test(String(value))
const isAddress = (value) => /^0x[0-9a-fA-F]{40}$/.test(String(value)) && lower(value) !== ZERO
const dateFromSource = (path) =>
  /^aave-core-anchor-features-(2026-\d{2}-\d{2})\.json$/.exec(basename(path))?.[1] || null

export function captureWindow(date, startedAtMs, firstKnownAtMs = null) {
  const start = Date.parse(`${date}T06:00:00.000Z`)
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(startedAtMs) ||
    startedAtMs < start ||
    startedAtMs > start + 30 * 60 * 1000
  )
    throw new Error('Peer capture missed 06:00–06:30 UTC start window')
  if (
    firstKnownAtMs !== null &&
    (!Number.isSafeInteger(firstKnownAtMs) ||
      firstKnownAtMs < startedAtMs ||
      firstKnownAtMs > start + 60 * 60 * 1000)
  )
    throw new Error('Peer capture missed 07:00 UTC finish window')
}

class DiskGuardFailure extends Error {
  constructor() {
    super('Disk guard failed or reserve below 1 GiB')
  }
}
const ABI = [
  {
    type: 'function',
    name: 'baseToken',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'getUtilization',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getSupplyRate',
    stateMutability: 'view',
    inputs: [{ type: 'uint256' }],
    outputs: [{ type: 'uint64' }],
  },
  {
    type: 'function',
    name: 'isWithdrawPaused',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bool' }],
  },
]

function gcd(a, b) {
  a = a < 0n ? -a : a
  while (b !== 0n) [a, b] = [b, a % b]
  return a
}

export function spreadBps(compoundRatePerSecondRaw, aaveLiquidityRateRay) {
  const compound = BigInt(compoundRatePerSecondRaw)
  const aave = BigInt(aaveLiquidityRateRay)
  if (compound < 0n || compound > 2n ** 64n - 1n || aave < 0n)
    throw new Error('Invalid raw supply rate')
  // Both rates are simple base APRs; Compound is 1e18/second, Aave is ray/year.
  const numerator = (compound * SECONDS_PER_YEAR * RAY - aave * COMET_RATE_SCALE) * 10_000n
  const denominator = RAY * COMET_RATE_SCALE
  const divisor = gcd(numerator, denominator)
  const stratum =
    numerator >= 50n * denominator ? 'ge50bp' : numerator <= 0n ? 'le0bp' : 'gt0lt50bp'
  return {
    numerator: (numerator / divisor).toString(),
    denominator: (denominator / divisor).toString(),
    stratum,
  }
}

function readSource(path, expectedSha, block) {
  const physical = readFileSync(path)
  if (hash(physical) !== expectedSha) throw new Error('Aave feature physical SHA mismatch')
  const saved = JSON.parse(physical.toString('utf8'))
  if (!saved?.payload || saved.sha256 !== seal(saved.payload))
    throw new Error('Aave feature payload SHA mismatch')
  const source = saved.payload
  if (
    source.study !== 'aave-core-anchor-features-v1' ||
    source.chainId !== 1 ||
    !Array.isArray(source.rows) ||
    source.rows.length !== 1
  )
    throw new Error('Aave feature study identity mismatch')
  const row = source.rows[0]
  if (
    row.block !== block ||
    !isHash(row.blockHash) ||
    !Number.isSafeInteger(row.blockTimestamp) ||
    !Number.isSafeInteger(row.observedAtMs) ||
    !Array.isArray(row.markets) ||
    row.markets.length !== COMETS.length ||
    row.markets.some(
      (market, i) =>
        market.name !== COMETS[i].name ||
        lower(market.underlying) !== lower(COMETS[i].base) ||
        typeof market.flags?.active !== 'boolean' ||
        typeof market.flags?.paused !== 'boolean' ||
        typeof market.flags?.frozen !== 'boolean' ||
        !/^\d+$/.test(String(market.liquidityRateRay)),
    )
  )
    throw new Error('Aave feature anchor or market identity mismatch')
  return { row, physicalSha256: expectedSha }
}

function codeHash(code, label) {
  if (typeof code !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(code))
    throw new Error(`${label} has no deployed code`)
  return keccak256(code)
}

async function implementationAt(rpc, address, pinned) {
  const word = await rpc('eth_getStorageAt', [address, SLOT, pinned])
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(word))) throw new Error('Invalid implementation word')
  const implementation = `0x${word.slice(26)}`.toLowerCase()
  if (implementation === ZERO) return { slot: SLOT, address: null, codeHash: null }
  if (!isAddress(implementation)) throw new Error('Invalid implementation address')
  return {
    slot: SLOT,
    address: implementation,
    codeHash: codeHash(await rpc('eth_getCode', [implementation, pinned]), 'Comet implementation'),
  }
}

export async function collect({
  client,
  block = BLOCK,
  sourcePath = SOURCE,
  captureDate = dateFromSource(sourcePath),
  expectedSourceSha256 = SOURCE_SHA256,
  out = DEFAULT_OUT,
  checkDisk = diskGuard,
  now = Date.now,
}) {
  const source = readSource(sourcePath, expectedSourceSha256, block)
  const guard = () => {
    try {
      checkDisk(out)
    } catch {
      throw new DiskGuardFailure()
    }
  }
  const missing = (error, row, reason) => {
    if (error instanceof DiskGuardFailure) throw error
    row.failures.push(reason)
  }
  const rpc = async (method, params) => {
    guard()
    return client.request({ method, params })
  }
  const startedAtMs = now()
  if (!Number.isSafeInteger(startedAtMs) || startedAtMs < source.row.observedAtMs)
    throw new Error('Invalid peer capture clock')
  if (captureDate) captureWindow(captureDate, startedAtMs)
  guard()
  if (Number(await client.getChainId()) !== 1) throw new Error('Ethereum mainnet required')
  guard()
  const header = await client.getBlock({ blockNumber: BigInt(block) })
  if (
    lower(header?.hash) !== lower(source.row.blockHash) ||
    Number(header?.number) !== block ||
    Number(header?.timestamp) !== source.row.blockTimestamp
  )
    throw new Error('Pinned Aave block mismatch')
  const pinned = { blockHash: source.row.blockHash, requireCanonical: true }
  const call = async (address, name, args = []) => {
    const data = encodeFunctionData({ abi: ABI, functionName: name, args })
    const result = await rpc('eth_call', [{ to: address, data }, pinned])
    return decodeFunctionResult({ abi: ABI, functionName: name, data: result })
  }
  const rows = []
  for (const [i, market] of COMETS.entries()) {
    const row = {
      market: market.name,
      comet: lower(market.address),
      base: lower(market.base),
      proxyCodeHash: null,
      implementation: null,
      aaveLiquidityRateRay: String(source.row.markets[i].liquidityRateRay),
      aaveFlags: {
        active: source.row.markets[i].flags.active,
        paused: source.row.markets[i].flags.paused,
        frozen: source.row.markets[i].flags.frozen,
      },
      compoundUtilizationRaw: null,
      compoundSupplyRatePerSecondRaw: null,
      withdrawPaused: null,
      spreadBps: null,
      stratum: 'missing',
      failures: [],
    }
    try {
      row.proxyCodeHash = codeHash(await rpc('eth_getCode', [market.address, pinned]), market.name)
    } catch (error) {
      missing(error, row, 'proxy-code-read')
      rows.push(row)
      continue
    }
    try {
      row.implementation = await implementationAt(rpc, market.address, pinned)
    } catch (error) {
      missing(error, row, 'implementation-read')
      rows.push(row)
      continue
    }
    let base
    try {
      base = await call(market.address, 'baseToken')
    } catch (error) {
      missing(error, row, 'baseToken-read')
      rows.push(row)
      continue
    }
    if (lower(base) !== lower(market.base)) throw new Error(`${market.name} Compound base mismatch`)
    try {
      row.compoundUtilizationRaw = String(await call(market.address, 'getUtilization'))
    } catch (error) {
      missing(error, row, 'utilization-read')
    }
    if (row.compoundUtilizationRaw !== null) {
      try {
        row.compoundSupplyRatePerSecondRaw = String(
          await call(market.address, 'getSupplyRate', [BigInt(row.compoundUtilizationRaw)]),
        )
      } catch (error) {
        missing(error, row, 'supply-rate-read')
      }
    }
    try {
      const paused = await call(market.address, 'isWithdrawPaused')
      if (typeof paused !== 'boolean') throw new Error('Invalid pause state')
      row.withdrawPaused = paused
    } catch (error) {
      missing(error, row, 'pause-state-read')
    }
    let rawRateStratum = null
    if (row.compoundSupplyRatePerSecondRaw !== null) {
      const spread = spreadBps(row.compoundSupplyRatePerSecondRaw, row.aaveLiquidityRateRay)
      row.spreadBps = { numerator: spread.numerator, denominator: spread.denominator }
      rawRateStratum = spread.stratum
    }
    if (!row.aaveFlags.active || row.aaveFlags.paused || row.aaveFlags.frozen)
      row.stratum = 'aave-ineligible'
    else if (row.withdrawPaused === true) row.stratum = 'paused'
    else if (row.failures.length > 0) row.stratum = 'missing'
    else if (row.implementation.address === null) row.stratum = 'implementation-unresolved'
    else row.stratum = rawRateStratum
    rows.push(row)
  }
  guard()
  const repeated = await client.getBlock({ blockNumber: BigInt(block) })
  if (lower(repeated?.hash) !== lower(source.row.blockHash))
    throw new Error('Pinned block changed during capture')
  if (hash(readFileSync(sourcePath)) !== expectedSourceSha256)
    throw new Error('Aave source changed during peer capture')
  const firstKnownAtMs = now()
  if (
    !Number.isSafeInteger(firstKnownAtMs) ||
    firstKnownAtMs < startedAtMs ||
    firstKnownAtMs - startedAtMs > 10 * 60 * 1000
  )
    throw new Error('Peer capture exceeded clock bounds')
  if (captureDate) captureWindow(captureDate, startedAtMs, firstKnownAtMs)
  const payload = {
    study: STUDY,
    chainId: 1,
    block,
    blockHash: lower(source.row.blockHash),
    blockTimestamp: source.row.blockTimestamp,
    sourcePhysicalSha256: expectedSourceSha256,
    captureStartedAtMs: startedAtMs,
    firstKnownAtMs,
    markets: rows,
    interpretation:
      'Same-asset simple annualized base supply APR only; no incentives, gas, taxes, cross-venue risk, withdrawal intent, after-anchor outcome, or validated alert. A paused/missing peer stays in the denominator ledger but not a rate stratum.',
  }
  return { payload, sha256: seal(payload) }
}

function underOutputRoot(path) {
  const absolute = resolve(path)
  if (!absolute.startsWith(`${OUTPUT_ROOT}/`))
    throw new Error('Path outside venue-signals output root')
  return absolute
}

export function captureConfig({
  sourcePath = SOURCE,
  expectedSourceSha256 = SOURCE_SHA256,
  block = BLOCK,
  out = DEFAULT_OUT,
} = {}) {
  const source = underOutputRoot(sourcePath)
  const output = underOutputRoot(out)
  const sourceDate = /^aave-core-anchor-features-(2026-\d{2}-\d{2})\.json$/.exec(
    source.slice(OUTPUT_ROOT.length + 1),
  )?.[1]
  const outputDate = /^aave-compound-peer-rate-(2026-\d{2}-\d{2})\.json$/.exec(
    output.slice(OUTPUT_ROOT.length + 1),
  )?.[1]
  const realDate =
    sourceDate &&
    !Number.isNaN(Date.parse(`${sourceDate}T00:00:00Z`)) &&
    new Date(`${sourceDate}T00:00:00Z`).toISOString().slice(0, 10) === sourceDate
  if (
    !sourceDate ||
    !realDate ||
    sourceDate !== outputDate ||
    sourceDate < '2026-09-26' ||
    sourceDate > '2026-10-09'
  )
    throw new Error('Source and output must name the same frozen calendar date')
  if (!/^[0-9a-f]{64}$/.test(expectedSourceSha256))
    throw new Error('Explicit lowercase source SHA-256 required')
  if (!Number.isSafeInteger(block) || block <= 0) throw new Error('Positive integer block required')
  if (
    sourceDate === '2026-09-26' &&
    (source !== SOURCE ||
      output !== DEFAULT_OUT ||
      expectedSourceSha256 !== SOURCE_SHA256 ||
      block !== BLOCK)
  )
    throw new Error('Sep 26 frozen source/block/output cannot be changed')
  return { sourcePath: source, expectedSourceSha256, block, out: output }
}

export function parseCliArgs(args) {
  const options = new Map()
  let run = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--run') {
      if (run) throw new Error('Duplicate --run')
      run = true
      continue
    }
    if (
      !['--source', '--source-sha256', '--block', '--out'].includes(arg) ||
      options.has(arg) ||
      i + 1 >= args.length ||
      args[i + 1].startsWith('--')
    )
      throw new Error('Invalid peer-rate arguments')
    options.set(arg, args[++i])
  }
  if (options.size !== 0 && options.size !== 4)
    throw new Error('Daily capture requires source, SHA-256, block, and output together')
  const blockText = options.get('--block')
  if (blockText !== undefined && !/^\d+$/.test(blockText)) throw new Error('Invalid block')
  return {
    run,
    config: captureConfig(
      options.size === 0
        ? {}
        : {
            sourcePath: options.get('--source'),
            expectedSourceSha256: options.get('--source-sha256'),
            block: Number(blockText),
            out: options.get('--out'),
          },
    ),
  }
}

export function readSnapshot(out = DEFAULT_OUT, options = {}) {
  const block = options.block ?? BLOCK
  const expectedSourceSha256 = options.expectedSourceSha256 ?? SOURCE_SHA256
  const saved = JSON.parse(readFileSync(out, 'utf8'))
  if (!saved?.payload || saved.sha256 !== seal(saved.payload)) throw new Error('Peer SHA mismatch')
  const p = saved.payload
  if (
    p.study !== STUDY ||
    p.chainId !== 1 ||
    p.block !== block ||
    p.sourcePhysicalSha256 !== expectedSourceSha256 ||
    !isHash(p.blockHash) ||
    !Array.isArray(p.markets) ||
    p.markets.length !== COMETS.length ||
    p.markets.some(
      (r, i) =>
        r.market !== COMETS[i].name ||
        lower(r.comet) !== lower(COMETS[i].address) ||
        lower(r.base) !== lower(COMETS[i].base),
    )
  )
    throw new Error('Peer snapshot identity mismatch')
  return saved
}

export function saveSnapshot(out, snapshot, checkDisk = diskGuard) {
  checkDisk(out)
  if (existsSync(out)) throw new Error('Refusing to overwrite peer snapshot')
  mkdirSync(dirname(out), { recursive: true })
  const temp = `${out}.${process.pid}.tmp`
  let fd
  try {
    fd = openSync(temp, 'wx', 0o600)
    writeFileSync(fd, JSON.stringify(snapshot))
    closeSync(fd)
    fd = undefined
    checkDisk(out)
    // Same-directory hard link is atomic and fails with EEXIST instead of replacing a peer's write.
    linkSync(temp, out)
    unlinkSync(temp)
    const reread = JSON.parse(readFileSync(out, 'utf8'))
    if (reread.sha256 !== seal(reread.payload)) throw new Error('Saved peer SHA mismatch')
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    if (existsSync(temp)) unlinkSync(temp)
    throw error
  }
}

export function plan(options = {}) {
  const config = captureConfig(options)
  return {
    status: 'dry-only',
    study: STUDY,
    source: config.sourcePath,
    sourceSha256: config.expectedSourceSha256,
    block: config.block,
    out: config.out,
    note: 'No RPC or write. --run captures only the explicitly sealed same-block Aave anchor.',
  }
}

export async function run(options) {
  if (options?.out && existsSync(options.out))
    throw new Error('Refusing to overwrite peer snapshot')
  const config = captureConfig(options)
  const out = config.out
  if (existsSync(out)) throw new Error('Refusing to overwrite peer snapshot')
  const snapshot = await collect({
    ...options,
    ...config,
    captureDate: dateFromSource(config.sourcePath),
  })
  saveSnapshot(out, snapshot, options?.checkDisk)
  return {
    status: 'saved',
    out,
    block: config.block,
    firstKnownAtMs: snapshot.payload.firstKnownAtMs,
    sha256: snapshot.sha256,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { run: execute, config } = parseCliArgs(process.argv.slice(2))
    const result = execute
      ? await run({
          ...config,
          client: makeClient(process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')),
        })
      : plan(config)
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch {
    // RPC exceptions can contain credential-bearing URLs.
    process.stderr.write('Peer-rate capture failed; check source, disk, and RPC.\n')
    process.exitCode = 1
  }
}
