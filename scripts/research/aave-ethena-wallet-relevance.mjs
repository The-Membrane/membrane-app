// One frozen-block relevance check, not a prediction or withdrawal-intent signal.
// Dry by default; --run makes two hash-pinned ERC20 reads and saves once.
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
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { decodeFunctionResult, encodeFunctionData } from 'viem'
import { MARKETS, diskGuard } from './aave-core-forward-panel.mjs'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'

export const STUDY = 'aave-ethena-wallet-relevance-v1'
export const SOURCE = resolve(
  'data/research/venue-signals/aave-core-anchor-features-2026-09-26.json',
)
export const SOURCE_SHA256 = 'df984f6bcabab38220b18a36627224bd14614ee868ef4dc1a51c7d9b32c2e708'
export const DEFAULT_OUT = resolve(
  'data/research/venue-signals/aave-ethena-wallet-relevance-2026-09-26.json',
)
export const BLOCK = 26_059_633
export const WALLET = '0xb8734a14fbd4aa2d44e6aa830405ffc861ba313c'
const ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
]
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const seal = (payload) => sha(JSON.stringify(payload))
const lower = (value) => String(value || '').toLowerCase()
const isHash = (value) => /^0x[0-9a-fA-F]{64}$/.test(String(value))
const rawUint = (value, label) => {
  if (!/^(0|[1-9][0-9]*)$/.test(String(value))) throw new Error(`Invalid ${label}`)
  return BigInt(value)
}
const guard = (checkDisk, out) => {
  try {
    checkDisk(out)
  } catch {
    throw new Error('Disk reserve guard failed')
  }
}

export function readSource(path = SOURCE, expectedSha256 = SOURCE_SHA256) {
  if (!/^[0-9a-f]{64}$/.test(expectedSha256)) throw new Error('Invalid source SHA')
  const bytes = readFileSync(path)
  if (sha(bytes) !== expectedSha256) throw new Error('Source physical SHA mismatch')
  const saved = JSON.parse(bytes.toString('utf8'))
  if (!saved?.payload || saved.sha256 !== seal(saved.payload))
    throw new Error('Source internal seal mismatch')
  const payload = saved.payload
  if (
    payload.study !== 'aave-core-anchor-features-v1' ||
    payload.chainId !== 1 ||
    !Array.isArray(payload.rows) ||
    payload.rows.length !== 1 ||
    !Array.isArray(payload.markets) ||
    payload.markets.length !== 2
  )
    throw new Error('Source study or chain mismatch')
  const row = payload.rows[0]
  if (
    row.block !== BLOCK ||
    !isHash(row.blockHash) ||
    !Number.isSafeInteger(row.blockTimestamp) ||
    !Number.isSafeInteger(row.observedAtMs) ||
    row.observedAtMs < row.blockTimestamp * 1000 ||
    !Array.isArray(row.markets) ||
    row.markets.length !== 2
  )
    throw new Error('Source block or observation mismatch')
  for (const [i, frozen] of row.markets.entries()) {
    const expected = MARKETS[i]
    const market = payload.markets[i]
    if (
      frozen.name !== expected.name ||
      market.name !== expected.name ||
      lower(frozen.underlying) !== lower(expected.base) ||
      lower(market.base) !== lower(expected.base) ||
      lower(frozen.aToken) !== lower(expected.aToken) ||
      lower(market.aToken) !== lower(expected.aToken) ||
      frozen.decimals !== 6 ||
      market.decimals !== 6
    )
      throw new Error(`${expected.name} frozen token identity mismatch`)
    rawUint(frozen.aTokenSupplyRaw, `${expected.name} supply`)
    rawUint(frozen.rawCashProxy?.cashRaw, `${expected.name} cash`)
  }
  return { row, sourcePhysicalSha256: expectedSha256 }
}

export function classifyUsdt(balanceRaw, cashRaw) {
  const balance = rawUint(balanceRaw, 'USDT balance')
  const cash = rawUint(cashRaw, 'USDT cash')
  return {
    minimumBalanceRaw: '50000000000000',
    minimumCashShareFraction: { numerator: '1', denominator: '4' },
    balanceGate: balance >= 50_000_000n * 10n ** 6n,
    cashShareGate: cash > 0n && balance * 4n >= cash,
    relevantForMaturityStudy:
      balance >= 50_000_000n * 10n ** 6n && cash > 0n && balance * 4n >= cash,
  }
}

export async function collect({
  client,
  sourcePath = SOURCE,
  expectedSourceSha256 = SOURCE_SHA256,
  out = DEFAULT_OUT,
  checkDisk = diskGuard,
  now = Date.now,
} = {}) {
  guard(checkDisk, out)
  const source = readSource(sourcePath, expectedSourceSha256)
  const rpc = async (method, args) => {
    guard(checkDisk, out)
    return client[method](args)
  }
  if (Number(await rpc('getChainId')) !== 1) throw new Error('Ethereum mainnet required')
  const header = await rpc('getBlock', { blockNumber: BigInt(BLOCK) })
  if (
    lower(header?.hash) !== lower(source.row.blockHash) ||
    Number(header?.timestamp) !== source.row.blockTimestamp
  )
    throw new Error('Frozen block is not canonical on provider')
  const markets = []
  for (const [i, market] of MARKETS.entries()) {
    const frozen = source.row.markets[i]
    const data = encodeFunctionData({ abi: ABI, functionName: 'balanceOf', args: [WALLET] })
    const response = await rpc('request', {
      method: 'eth_call',
      params: [
        { to: market.aToken, data },
        { blockHash: source.row.blockHash, requireCanonical: true },
      ],
    })
    const balance = decodeFunctionResult({ abi: ABI, functionName: 'balanceOf', data: response })
    if (typeof balance !== 'bigint' || balance < 0n) throw new Error('Invalid balanceOf response')
    const cash = rawUint(frozen.rawCashProxy.cashRaw, 'cash')
    const supply = rawUint(frozen.aTokenSupplyRaw, 'supply')
    markets.push({
      name: market.name,
      underlying: lower(market.base),
      aToken: lower(market.aToken),
      decimals: market.decimals,
      balanceRaw: balance.toString(),
      cashRaw: cash.toString(),
      aTokenSupplyRaw: supply.toString(),
      shareOfCash:
        cash === 0n ? null : { numerator: balance.toString(), denominator: cash.toString() },
      shareOfSupply:
        supply === 0n ? null : { numerator: balance.toString(), denominator: supply.toString() },
      ...(market.name === 'USDT' ? { sourceRelevanceTriage: classifyUsdt(balance, cash) } : {}),
    })
  }
  const end = await rpc('getBlock', { blockNumber: BigInt(BLOCK) })
  if (
    lower(end?.hash) !== lower(header.hash) ||
    Number(end?.timestamp) !== source.row.blockTimestamp
  )
    throw new Error('Frozen block changed during reads')
  const observedAtMs = now()
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs < source.row.observedAtMs)
    throw new Error('Invalid local observation time')
  return {
    study: STUDY,
    chainId: 1,
    block: BLOCK,
    blockHash: lower(header.hash),
    blockTimestamp: source.row.blockTimestamp,
    observedAtMs,
    sourcePath: resolve(sourcePath),
    sourcePhysicalSha256: source.sourcePhysicalSha256,
    wallet: WALLET,
    markets,
    interpretation:
      'Source-relevance triage only: wallet balance is neither liquid backing nor withdrawal intent; no predictive badge.',
  }
}

export function readSnapshot(path = DEFAULT_OUT) {
  const saved = JSON.parse(readFileSync(path, 'utf8'))
  if (!saved?.payload || saved.sha256 !== seal(saved.payload))
    throw new Error('Snapshot seal mismatch')
  if (
    saved.payload.study !== STUDY ||
    saved.payload.chainId !== 1 ||
    saved.payload.block !== BLOCK ||
    !isHash(saved.payload.blockHash) ||
    saved.payload.wallet !== WALLET ||
    !Number.isSafeInteger(saved.payload.observedAtMs) ||
    !Array.isArray(saved.payload.markets) ||
    saved.payload.markets.length !== 2
  )
    throw new Error('Snapshot identity mismatch')
  return saved
}

export function saveSnapshot(out, payload, checkDisk = diskGuard) {
  if (existsSync(out)) throw new Error('Refusing to overwrite wallet snapshot')
  guard(checkDisk, out)
  mkdirSync(dirname(out), { recursive: true })
  const temp = `${out}.${process.pid}.tmp`
  let fd
  try {
    fd = openSync(temp, 'wx', 0o600)
    writeFileSync(fd, JSON.stringify({ payload, sha256: seal(payload) }))
    closeSync(fd)
    fd = undefined
    guard(checkDisk, out)
    linkSync(temp, out)
    unlinkSync(temp)
    return readSnapshot(out)
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    if (existsSync(temp)) unlinkSync(temp)
    throw error
  }
}

export function plan() {
  return {
    status: 'dry-only',
    study: STUDY,
    source: SOURCE,
    sourceSha256: SOURCE_SHA256,
    block: BLOCK,
    out: DEFAULT_OUT,
    note: 'No RPC or write. --run reads only the sealed Sep 26 anchor.',
  }
}

export async function run(options = {}) {
  const out = options.out || DEFAULT_OUT
  if (existsSync(out)) throw new Error('Refusing to overwrite wallet snapshot')
  const payload = await collect({ ...options, out })
  const saved = saveSnapshot(out, payload, options.checkDisk)
  return { status: 'saved', out, observedAtMs: payload.observedAtMs, sha256: saved.sha256 }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== '--run'))
      throw new Error('Only --run is accepted')
    const result =
      process.argv[2] === '--run'
        ? await run({
            client: makeClient(process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')),
          })
        : plan()
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch {
    // RPC exception strings can contain credential-bearing endpoint URLs.
    process.stderr.write('Ethena wallet relevance capture failed; check source, disk, and RPC.\n')
    process.exitCode = 1
  }
}
