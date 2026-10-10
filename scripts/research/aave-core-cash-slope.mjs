// Exact pre-anchor cash-slope control. This reads only B and earlier blocks;
// neither a later quote nor a withdrawal outcome belongs in this feature.
import { createHash } from 'node:crypto'
import {
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { decodeFunctionResult, encodeFunctionData, keccak256 } from 'viem'
import { ABI, MARKETS, POOL, diskGuard } from './aave-core-forward-panel.mjs'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'

export const STUDY = 'aave-core-cash-slope-v1'
export const OUTPUT_ROOT = resolve('data/research/venue-signals')
export const SOURCE = resolve(
  'data/research/venue-signals/aave-core-anchor-features-2026-09-26.json',
)
export const SOURCE_SHA256 = 'df984f6bcabab38220b18a36627224bd14614ee868ef4dc1a51c7d9b32c2e708'
export const BLOCK = 26_059_633
export const DEFAULT_OUT = resolve(
  'data/research/venue-signals/aave-core-cash-slope-2026-09-26.json',
)
export const LOOKBACK_SECONDS = 86_400
export const MAX_TIMESTAMP_ERROR_SECONDS = 60
export const CAPTURE_START_HOUR_UTC = 6
export const CAPTURE_LATEST_START_HOUR_UTC = 7
export const CAPTURE_FINISH_HOUR_UTC = 7
export const CAPTURE_FINISH_MINUTE_UTC = 30
const SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const ZERO = '0x0000000000000000000000000000000000000000'
const lower = (x) => String(x || '').toLowerCase()
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const seal = (payload) => hash(JSON.stringify(payload))
const isHash = (x) => /^0x[0-9a-fA-F]{64}$/.test(String(x))
const isAddress = (x) => /^0x[0-9a-fA-F]{40}$/.test(String(x)) && lower(x) !== ZERO

export class DiskGuardFailure extends Error {
  constructor() {
    super('Disk reserve guard failed')
    this.name = 'DiskGuardFailure'
  }
}

function guardDisk(checkDisk, out) {
  try {
    checkDisk(out)
  } catch {
    // Preserve failure type, not a potentially credential-bearing exception.
    throw new DiskGuardFailure()
  }
}

function checkCaptureWindow(timeMs, date, stage) {
  if (!/^2026-\d\d-\d\d$/.test(String(date))) throw new Error('Invalid capture date')
  const midnight = Date.parse(`${date}T00:00:00Z`)
  if (!Number.isSafeInteger(midnight) || new Date(midnight).toISOString().slice(0, 10) !== date)
    throw new Error('Invalid capture date')
  if (!Number.isSafeInteger(timeMs)) throw new Error('Invalid local capture clock')
  const first = midnight + CAPTURE_START_HOUR_UTC * 3_600_000
  const latestStart = midnight + CAPTURE_LATEST_START_HOUR_UTC * 3_600_000
  const latestFinish =
    midnight + CAPTURE_FINISH_HOUR_UTC * 3_600_000 + CAPTURE_FINISH_MINUTE_UTC * 60_000
  if (stage === 'start' && (timeMs < first || timeMs >= latestStart))
    throw new Error('Cash-slope capture missed 06:00–07:00 UTC start window')
  if (stage === 'finish' && (timeMs < first || timeMs > latestFinish))
    throw new Error('Cash-slope capture missed 07:30 UTC finish deadline')
}

function scoped(path) {
  const absolute = resolve(path)
  if (!absolute.startsWith(`${OUTPUT_ROOT}/`) || !absolute.endsWith('.json'))
    throw new Error('Cash-slope path outside venue-signals JSON root')
  return absolute
}

export function captureConfig({
  sourcePath = SOURCE,
  expectedSourceSha256 = SOURCE_SHA256,
  block = BLOCK,
  out = DEFAULT_OUT,
} = {}) {
  const source = scoped(sourcePath)
  const output = scoped(out)
  const sourceDate = /^aave-core-anchor-features-(2026-\d\d-\d\d)\.json$/.exec(
    source.slice(OUTPUT_ROOT.length + 1),
  )?.[1]
  const outputDate = /^aave-core-cash-slope-(2026-\d\d-\d\d)\.json$/.exec(
    output.slice(OUTPUT_ROOT.length + 1),
  )?.[1]
  if (
    !sourceDate ||
    sourceDate !== outputDate ||
    sourceDate < '2026-09-26' ||
    sourceDate > '2026-10-09' ||
    Number.isNaN(Date.parse(`${sourceDate}T00:00:00Z`)) ||
    new Date(`${sourceDate}T00:00:00Z`).toISOString().slice(0, 10) !== sourceDate
  )
    throw new Error('Source and output must share a frozen calendar date')
  if (!/^[0-9a-f]{64}$/.test(expectedSourceSha256))
    throw new Error('Explicit lowercase source SHA-256 required')
  if (!Number.isSafeInteger(block) || block <= 0) throw new Error('Positive block required')
  if (
    sourceDate === '2026-09-26' &&
    (source !== SOURCE ||
      output !== DEFAULT_OUT ||
      block !== BLOCK ||
      expectedSourceSha256 !== SOURCE_SHA256)
  )
    throw new Error('Sep 26 source/block/output is frozen')
  return { sourcePath: source, expectedSourceSha256, block, out: output }
}

export function parseCliArgs(args) {
  let run = false
  const options = new Map()
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
      throw new Error('Invalid cash-slope arguments')
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

function readSource(path, expectedSha, block) {
  const physical = readFileSync(path)
  if (hash(physical) !== expectedSha) throw new Error('Aave feature physical SHA mismatch')
  const saved = JSON.parse(physical.toString('utf8'))
  if (!saved?.payload || saved.sha256 !== seal(saved.payload))
    throw new Error('Aave feature payload SHA mismatch')
  const p = saved.payload
  if (
    p.study !== 'aave-core-anchor-features-v1' ||
    p.chainId !== 1 ||
    lower(p.pool) !== lower(POOL) ||
    !Array.isArray(p.rows) ||
    p.rows.length !== 1
  )
    throw new Error('Aave feature study identity mismatch')
  const row = p.rows[0]
  if (
    row.block !== block ||
    !isHash(row.blockHash) ||
    !isHash(row.poolCodeHash) ||
    !Number.isSafeInteger(row.blockTimestamp) ||
    !Number.isSafeInteger(row.observedAtMs) ||
    !Array.isArray(row.markets) ||
    row.markets.length !== MARKETS.length ||
    row.markets.some(
      (m, i) =>
        m.name !== MARKETS[i].name ||
        lower(m.underlying) !== lower(MARKETS[i].base) ||
        lower(m.aToken) !== lower(MARKETS[i].aToken) ||
        !isHash(m.underlyingCodeHash) ||
        !isHash(m.aTokenCodeHash) ||
        !/^\d+$/.test(String(m.rawCashProxy?.cashRaw)),
    )
  )
    throw new Error('Aave feature anchor or market identity mismatch')
  return row
}

function headerShape(header, number) {
  const timestamp = Number(header?.timestamp)
  if (
    Number(header?.number) !== number ||
    !isHash(header?.hash) ||
    !Number.isSafeInteger(timestamp) ||
    timestamp < 0
  )
    throw new Error('Missing canonical block header')
  return { number, hash: lower(header.hash), timestamp }
}

export async function firstBlockAtOrAfter(readHeader, bNumber, bTimestamp) {
  if (!Number.isSafeInteger(bNumber) || bNumber <= 0 || !Number.isSafeInteger(bTimestamp))
    throw new Error('Invalid frozen anchor')
  const target = bTimestamp - LOOKBACK_SECONDS
  if (target < 0) throw new Error('Lookback before genesis')
  // The upper bound B is known to be after target; searching [0, B) cannot
  // choose a block based on cash value or accidentally inspect an outcome.
  let lo = 0
  let hi = bNumber
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2)
    const header = headerShape(await readHeader(mid), mid)
    if (header.timestamp >= target) hi = mid
    else lo = mid + 1
  }
  if (lo >= bNumber) return { selected: null, reason: 'no-prior-block-at-target', target }
  const selected = headerShape(await readHeader(lo), lo)
  const predecessor = lo > 0 ? headerShape(await readHeader(lo - 1), lo - 1) : null
  if (selected.timestamp < target || (predecessor && predecessor.timestamp >= target))
    throw new Error('Timestamp boundary not first canonical block')
  const errorSeconds = selected.timestamp - target
  if (errorSeconds > MAX_TIMESTAMP_ERROR_SECONDS)
    return { selected, predecessor, target, errorSeconds, reason: 'timestamp-error-over-60s' }
  return { selected, predecessor, target, errorSeconds, reason: null }
}

export function cashSlope(cashPriorRaw, cashBRaw) {
  const prior = BigInt(cashPriorRaw)
  const current = BigInt(cashBRaw)
  if (prior < 0n || current < 0n) throw new Error('Negative cash')
  if (prior === 0n) return null
  return { numerator: (current - prior).toString(), denominator: prior.toString() }
}

function deployedCodeHash(raw, label) {
  if (typeof raw !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(raw))
    throw new Error(`${label} missing deployed code`)
  return keccak256(raw)
}

async function identityAt(rpc, address, blockHash, label) {
  const pin = { blockHash, requireCanonical: true }
  const proxyCodeHash = deployedCodeHash(await rpc('eth_getCode', [address, pin]), label)
  const word = await rpc('eth_getStorageAt', [address, SLOT, pin])
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(word)))
    throw new Error(`${label} missing implementation slot`)
  const implementation = `0x${word.slice(26)}`.toLowerCase()
  if (implementation === ZERO) return { proxyCodeHash, implementation: null }
  if (!isAddress(implementation)) throw new Error(`${label} invalid implementation`)
  return {
    proxyCodeHash,
    implementation: {
      address: implementation,
      codeHash: deployedCodeHash(
        await rpc('eth_getCode', [implementation, pin]),
        `${label} implementation`,
      ),
    },
  }
}

function sameIdentity(a, b) {
  return (
    a?.proxyCodeHash === b?.proxyCodeHash &&
    (a?.implementation?.address || null) === (b?.implementation?.address || null) &&
    (a?.implementation?.codeHash || null) === (b?.implementation?.codeHash || null)
  )
}

export async function collect({
  client,
  sourcePath = SOURCE,
  expectedSourceSha256 = SOURCE_SHA256,
  block = BLOCK,
  out = DEFAULT_OUT,
  checkDisk = diskGuard,
  now = Date.now,
  captureDate = /^aave-core-anchor-features-(2026-\d\d-\d\d)\.json$/.exec(
    sourcePath.split('/').at(-1),
  )?.[1],
}) {
  guardDisk(checkDisk, out)
  const frozen = readSource(sourcePath, expectedSourceSha256, block)
  const startedAtMs = now()
  checkCaptureWindow(startedAtMs, captureDate, 'start')
  if (!Number.isSafeInteger(startedAtMs) || startedAtMs < frozen.observedAtMs)
    throw new Error('Invalid local capture clock')
  const rpc = async (method, params) => {
    guardDisk(checkDisk, out)
    return client.request({ method, params })
  }
  guardDisk(checkDisk, out)
  if (Number(await client.getChainId()) !== 1) throw new Error('Ethereum mainnet required')
  const readHeader = async (number) => {
    guardDisk(checkDisk, out)
    return client.getBlock({ blockNumber: BigInt(number) })
  }
  const anchor = headerShape(await readHeader(block), block)
  if (anchor.hash !== lower(frozen.blockHash) || anchor.timestamp !== frozen.blockTimestamp)
    throw new Error('Frozen B no longer canonical or provider inconsistent')
  const prior = await firstBlockAtOrAfter(readHeader, block, anchor.timestamp)
  const rows = []
  for (const [i, market] of MARKETS.entries()) {
    const source = frozen.markets[i]
    const row = {
      market: market.name,
      underlying: lower(market.base),
      aToken: lower(market.aToken),
      cashBRaw: String(source.rawCashProxy.cashRaw),
      cashPriorRaw: null,
      signedSlopeFraction: null,
      status: 'censored',
      reasons: [],
      identities: null,
    }
    if (!prior.selected || prior.reason) {
      row.reasons.push(prior.reason)
      rows.push(row)
      continue
    }
    try {
      const priorPin = { blockHash: prior.selected.hash, requireCanonical: true }
      const bPin = { blockHash: anchor.hash, requireCanonical: true }
      const pair = async (address, label, expectedBCodeHash, requireImplementation) => {
        const before = await identityAt(rpc, address, prior.selected.hash, label)
        const atB = await identityAt(rpc, address, anchor.hash, label)
        if (atB.proxyCodeHash !== lower(expectedBCodeHash))
          row.reasons.push(`${label}-B-code-mismatch`)
        if (!sameIdentity(before, atB)) row.reasons.push(`${label}-identity-changed`)
        if (requireImplementation && (!before.implementation || !atB.implementation))
          row.reasons.push(`${label}-implementation-unresolved`)
        return { prior: before, atB }
      }
      const pool = await pair(POOL, 'pool', frozen.poolCodeHash, true)
      const underlying = await pair(market.base, 'underlying', source.underlyingCodeHash, false)
      const aToken = await pair(market.aToken, 'aToken', source.aTokenCodeHash, true)
      row.identities = { pool, underlying, aToken }
      const reserveCall = encodeFunctionData({
        abi: ABI.reserve,
        functionName: 'getReserveData',
        args: [market.base],
      })
      const readReserve = async (pin) =>
        decodeFunctionResult({
          abi: ABI.reserve,
          functionName: 'getReserveData',
          data: await rpc('eth_call', [{ to: POOL, data: reserveCall }, pin]),
        })
      const priorReserve = await readReserve(priorPin)
      const bReserve = await readReserve(bPin)
      if (lower(priorReserve?.aTokenAddress) !== lower(market.aToken))
        row.reasons.push('prior-reserve-aToken-mismatch')
      if (lower(bReserve?.aTokenAddress) !== lower(market.aToken))
        row.reasons.push('B-reserve-aToken-mismatch')
      const balanceCall = encodeFunctionData({
        abi: ABI.token,
        functionName: 'balanceOf',
        args: [market.aToken],
      })
      const cash = decodeFunctionResult({
        abi: ABI.token,
        functionName: 'balanceOf',
        data: await rpc('eth_call', [{ to: market.base, data: balanceCall }, priorPin]),
      })
      if (typeof cash !== 'bigint' || cash < 0n) throw new Error('Invalid cash response')
      row.cashPriorRaw = cash.toString()
      row.signedSlopeFraction = cashSlope(cash, row.cashBRaw)
      if (row.signedSlopeFraction === null) row.reasons.push('zero-prior-cash')
      if (row.reasons.length === 0) row.status = 'eligible'
    } catch (error) {
      if (error instanceof DiskGuardFailure) throw error
      // Keep the failed market in the denominator, without leaking RPC URLs.
      guardDisk(checkDisk, out)
      row.reasons.push('prior-or-B-read-failed')
    }
    rows.push(row)
  }
  const endAnchor = headerShape(await readHeader(block), block)
  if (endAnchor.hash !== anchor.hash || endAnchor.timestamp !== anchor.timestamp)
    throw new Error('Frozen B changed during capture')
  if (prior.selected) {
    const endPrior = headerShape(await readHeader(prior.selected.number), prior.selected.number)
    if (endPrior.hash !== prior.selected.hash || endPrior.timestamp !== prior.selected.timestamp)
      throw new Error('Prior canonical block changed during capture')
  }
  guardDisk(checkDisk, out)
  if (hash(readFileSync(sourcePath)) !== expectedSourceSha256)
    throw new Error('Aave feature source changed during capture')
  const firstKnownAtMs = now()
  checkCaptureWindow(firstKnownAtMs, captureDate, 'finish')
  if (
    !Number.isSafeInteger(firstKnownAtMs) ||
    firstKnownAtMs < startedAtMs ||
    firstKnownAtMs - startedAtMs > 10 * 60 * 1000
  )
    throw new Error('Cash-slope capture exceeded clock bounds')
  const payload = {
    study: STUDY,
    chainId: 1,
    captureDate,
    sourcePhysicalSha256: expectedSourceSha256,
    block,
    blockHash: anchor.hash,
    blockTimestamp: anchor.timestamp,
    targetTimestamp: prior.target,
    priorBlock: prior.selected?.number ?? null,
    priorBlockHash: prior.selected?.hash ?? null,
    priorTimestamp: prior.selected?.timestamp ?? null,
    timestampErrorSeconds: prior.errorSeconds ?? null,
    actualElapsedSeconds: prior.selected ? anchor.timestamp - prior.selected.timestamp : null,
    captureStartedAtMs: startedAtMs,
    firstKnownAtMs,
    markets: rows,
    interpretation:
      'Exact 24h pre-B raw aToken cash slope only. A censored row is not zero, safe, or an executable exit outcome. This feature is not a validated alert.',
  }
  return { payload, sha256: seal(payload) }
}

export function readSnapshot(out = DEFAULT_OUT, options = {}) {
  const saved = JSON.parse(readFileSync(out, 'utf8'))
  if (!saved?.payload || saved.sha256 !== seal(saved.payload))
    throw new Error('Cash-slope payload SHA mismatch')
  const p = saved.payload
  if (
    p.study !== STUDY ||
    p.chainId !== 1 ||
    p.block !== (options.block ?? BLOCK) ||
    p.sourcePhysicalSha256 !== (options.expectedSourceSha256 ?? SOURCE_SHA256) ||
    !isHash(p.blockHash) ||
    !Array.isArray(p.markets) ||
    p.markets.length !== MARKETS.length ||
    p.markets.some((r, i) => r.market !== MARKETS[i].name)
  )
    throw new Error('Cash-slope snapshot identity mismatch')
  return saved
}

export function saveSnapshot(out, snapshot, checkDisk = diskGuard, now = Date.now) {
  guardDisk(checkDisk, out)
  checkCaptureWindow(now(), snapshot.payload.captureDate, 'finish')
  if (existsSync(out)) throw new Error('Refusing to overwrite cash-slope snapshot')
  mkdirSync(dirname(out), { recursive: true })
  const temp = `${out}.${process.pid}.tmp`
  let fd
  try {
    fd = openSync(temp, 'wx', 0o600)
    writeFileSync(fd, JSON.stringify(snapshot))
    closeSync(fd)
    fd = undefined
    guardDisk(checkDisk, out)
    checkCaptureWindow(now(), snapshot.payload.captureDate, 'finish')
    linkSync(temp, out) // atomic, EEXIST if another capture won the race
    unlinkSync(temp)
    if (
      readSnapshot(out, {
        block: snapshot.payload.block,
        expectedSourceSha256: snapshot.payload.sourcePhysicalSha256,
      }).sha256 !== snapshot.sha256
    )
      throw new Error('Saved cash-slope SHA mismatch')
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
    ...config,
    note: 'No RPC or write. --run reads only the sealed B and earlier canonical blocks.',
  }
}

export async function run(options = {}) {
  const config = captureConfig(options)
  if (existsSync(config.out)) throw new Error('Refusing to overwrite cash-slope snapshot')
  const snapshot = await collect({ ...options, ...config })
  saveSnapshot(config.out, snapshot, options.checkDisk, options.now)
  return {
    status: 'saved',
    out: config.out,
    block: config.block,
    priorBlock: snapshot.payload.priorBlock,
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
    // A provider exception may contain a credential-bearing URL.
    process.stderr.write('Cash-slope capture failed. Check sealed source, RPC, disk, and clock.\n')
    process.exitCode = 1
  }
}
