// Same-anchor wallet-health context for the four frozen baseline-successful witnesses.
// This is not a withdrawal cause classifier or a predictive alert. Dry by default.
import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { keccak256 } from 'viem'
import { ABI, DISK_FLOOR_BYTES, MARKETS, POOL, diskGuard } from './aave-core-forward-panel.mjs'
import {
  DEFAULT_OUT as DEFAULT_BASELINE,
  readCheckpoint as readBaseline,
} from './aave-core-holder-witness.mjs'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'

export const DEFAULT_OUT = resolve('data/research/venue-signals/aave-core-holder-config-v1.json')
export const FROZEN_BLOCK = 26_059_143
export const EIP1967_IMPLEMENTATION_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const STUDY = 'aave-core-holder-config-v1'
const QUOTE_RAW = '1000000000000'
const FIRST_HORIZON_SECONDS = 6 * 3600
const lower = (value) => String(value || '').toLowerCase()
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const isHash = (value) => /^0x[0-9a-fA-F]{64}$/.test(String(value))
const isAddress = (value) => /^0x[0-9a-fA-F]{40}$/.test(String(value))
const uint = (value, name) => {
  let n
  try {
    n = BigInt(value)
  } catch {
    throw new Error(`Invalid ${name}`)
  }
  if (n < 0n) throw new Error(`Negative ${name}`)
  return n
}
const codeHash = (code, name) => {
  if (typeof code !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(code))
    throw new Error(`${name} missing deployed code`)
  return keccak256(code)
}
const fn = (name, inputs, outputs) => ({
  type: 'function',
  name,
  stateMutability: 'view',
  inputs,
  outputs,
})
const field = (name, type) => ({ name, type })
export const USER_ABI = Object.freeze([
  fn(
    'getUserConfiguration',
    [field('user', 'address')],
    [{ type: 'tuple', components: [field('data', 'uint256')] }],
  ),
  fn(
    'getUserAccountData',
    [field('user', 'address')],
    [
      field('totalCollateralBase', 'uint256'),
      field('totalDebtBase', 'uint256'),
      field('availableBorrowsBase', 'uint256'),
      field('currentLiquidationThreshold', 'uint256'),
      field('ltv', 'uint256'),
      field('healthFactor', 'uint256'),
    ],
  ),
])
const ACCOUNT_FIELDS = [
  'totalCollateralBase',
  'totalDebtBase',
  'availableBorrowsBase',
  'currentLiquidationThreshold',
  'ltv',
  'healthFactor',
]
const empty = (baselinePath) => ({
  study: STUDY,
  chainId: 1,
  pool: POOL,
  baselinePath: resolve(baselinePath),
  frozenBlock: FROZEN_BLOCK,
  quoteRaw: QUOTE_RAW,
  caveat:
    'Pre-withdraw holder health/configuration is context only: it does not prove post-withdraw health or a future revert cause; proxy implementation identity is not attested.',
  records: [],
})

export function readCheckpoint(out = DEFAULT_OUT, baselinePath = DEFAULT_BASELINE) {
  if (!existsSync(out)) return empty(baselinePath)
  const saved = JSON.parse(readFileSync(out, 'utf8'))
  if (!saved?.payload || saved.sha256 !== digest(saved.payload))
    throw new Error('Holder config checkpoint SHA mismatch')
  const data = saved.payload
  const expected = empty(baselinePath)
  if (
    data.study !== STUDY ||
    data.chainId !== 1 ||
    lower(data.pool) !== lower(POOL) ||
    data.baselinePath !== expected.baselinePath ||
    data.frozenBlock !== FROZEN_BLOCK ||
    data.quoteRaw !== QUOTE_RAW ||
    data.caveat !== expected.caveat ||
    !Array.isArray(data.records) ||
    data.records.length > 1
  )
    throw new Error('Holder config checkpoint identity mismatch')
  const baseline = data.records.length
    ? readBaseline(baselinePath).baselines.find((row) => row.block === FROZEN_BLOCK)
    : null
  const frozen = data.records.length ? frozenMarkets(baseline) : []
  for (const row of data.records) {
    if (
      row.baselineBlock !== FROZEN_BLOCK ||
      lower(row.baselineBlockHash) !== lower(baseline.blockHash) ||
      row.baselineSha256 !== baseline.rowSha256 ||
      row.blockTimestamp !== baseline.blockTimestamp ||
      lower(row.poolCodeHash) !== lower(baseline.poolCodeHash) ||
      !Array.isArray(row.markets) ||
      row.markets.length !== MARKETS.length ||
      row.rowSha256 !== digest({ ...row, rowSha256: undefined })
    )
      throw new Error('Holder config row mismatch')
    for (const [index, entry] of frozen.entries()) {
      const market = row.markets[index]
      if (
        market?.name !== entry.market.name ||
        lower(market?.underlying) !== lower(entry.market.base) ||
        lower(market?.aToken) !== lower(entry.market.aToken) ||
        market?.quoteRaw !== QUOTE_RAW ||
        lower(market?.underlyingCodeHash) !== lower(entry.baselineRow.underlyingCodeHash) ||
        lower(market?.aTokenCodeHash) !== lower(entry.baselineRow.aTokenCodeHash) ||
        !Array.isArray(market?.witnesses) ||
        market.witnesses.length !== entry.holders.length ||
        market.witnesses.some(
          (witness, holderIndex) => lower(witness?.holder) !== lower(entry.holders[holderIndex]),
        )
      )
        throw new Error('Holder config witness identity/order mismatch')
    }
  }
  return data
}

export function frozenMarkets(baseline) {
  if (
    baseline?.block !== FROZEN_BLOCK ||
    !isHash(baseline.blockHash) ||
    !isHash(baseline.poolCodeHash) ||
    !Array.isArray(baseline.markets) ||
    baseline.markets.length !== MARKETS.length
  )
    throw new Error('Frozen baseline missing or malformed')
  const expectedCounts = [3, 1]
  return baseline.markets.map((row, index) => {
    const market = MARKETS[index]
    if (
      row.name !== market.name ||
      lower(row.underlying) !== lower(market.base) ||
      lower(row.aToken) !== lower(market.aToken) ||
      row.decimals !== market.decimals ||
      row.quoteRaw !== QUOTE_RAW ||
      !isHash(row.underlyingCodeHash) ||
      !isHash(row.aTokenCodeHash) ||
      !Array.isArray(row.candidates) ||
      !Array.isArray(row.qualifyingHolders) ||
      row.qualifyingHolders.length !== expectedCounts[index]
    )
      throw new Error('Frozen market identity/count mismatch')
    const successful = row.candidates.filter((candidate) => candidate.withdraw === 'success')
    if (
      successful.length !== expectedCounts[index] ||
      new Set(row.qualifyingHolders.map(lower)).size !== expectedCounts[index] ||
      successful.some(
        (candidate, i) =>
          lower(candidate.address) !== lower(row.qualifyingHolders[i]) ||
          !isAddress(candidate.address) ||
          candidate.codeStatus !== 'eoa' ||
          uint(candidate.aTokenBalanceRaw, 'baseline holder balance') < BigInt(QUOTE_RAW),
      )
    )
      throw new Error('Frozen successful-holder ledger mismatch')
    return { market, baselineRow: row, holders: row.qualifyingHolders }
  })
}

export function decodeUserBitmap(value, reserveId) {
  const bitmap = uint(value, 'user configuration bitmap')
  if (bitmap >= 1n << 256n) throw new Error('User configuration exceeds uint256')
  if (!Number.isInteger(reserveId) || reserveId < 0 || reserveId > 127)
    throw new Error('Invalid reserve id')
  let anyBorrow = false
  for (let id = 0; id < 128; id++) {
    if (((bitmap >> BigInt(id * 2)) & 1n) === 1n) anyBorrow = true
  }
  return {
    bitmapRaw: bitmap.toString(),
    selectedReserveBorrowing: ((bitmap >> BigInt(reserveId * 2)) & 1n) === 1n,
    selectedReserveCollateral: ((bitmap >> BigInt(reserveId * 2 + 1)) & 1n) === 1n,
    anyBorrow,
  }
}

function accountRaw(value) {
  if (!Array.isArray(value) || value.length !== ACCOUNT_FIELDS.length)
    throw new Error('Malformed user account data')
  return Object.fromEntries(
    ACCOUNT_FIELDS.map((fieldName, index) => [fieldName, uint(value[index], fieldName).toString()]),
  )
}

function observationTime(now, baseline, phase) {
  const observedAtMs = now()
  if (
    !Number.isSafeInteger(observedAtMs) ||
    observedAtMs < baseline.blockTimestamp * 1000 ||
    observedAtMs >= (baseline.blockTimestamp + FIRST_HORIZON_SECONDS) * 1000
  )
    throw new Error(`Wallet configuration ${phase} is not prospective before +6h`)
  return observedAtMs
}

async function pinnedImplementation(client, blockHash, checkDisk, out) {
  const pinned = { blockHash, requireCanonical: true }
  checkDisk(out)
  let word
  try {
    word = await client.request({
      method: 'eth_getStorageAt',
      params: [POOL, EIP1967_IMPLEMENTATION_SLOT, pinned],
    })
  } catch {
    return { status: 'unknown', reason: 'pinned-storage-read-unavailable' }
  }
  if (typeof word !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(word) || !/^0x0{24}/i.test(word))
    return { status: 'unknown', reason: 'invalid-eip1967-word' }
  const address = `0x${word.slice(26)}`.toLowerCase()
  if (address === `0x${'0'.repeat(40)}`)
    return { status: 'unknown', reason: 'zero-eip1967-implementation' }
  checkDisk(out)
  try {
    const code = await client.request({
      method: 'eth_getCode',
      params: [address, pinned],
    })
    return { status: 'observed', address, codeHash: codeHash(code, 'Pool implementation') }
  } catch {
    return { status: 'unknown', reason: 'pinned-implementation-code-unavailable', address }
  }
}

export async function collectConfig({
  client,
  baseline,
  out = DEFAULT_OUT,
  checkDisk = diskGuard,
  now = Date.now,
}) {
  const frozen = frozenMarkets(baseline)
  observationTime(now, baseline, 'preflight')
  const rpc = async (method, args = {}) => {
    checkDisk(out)
    return client[method](args)
  }
  if (Number(await rpc('getChainId')) !== 1) throw new Error('Ethereum mainnet required')
  const blockNumber = BigInt(FROZEN_BLOCK)
  const header = await rpc('getBlock', { blockNumber })
  if (
    lower(header?.hash) !== lower(baseline.blockHash) ||
    Number(header?.timestamp) !== baseline.blockTimestamp
  )
    throw new Error('Frozen baseline block is no longer canonical')
  const poolCodeHash = codeHash(await rpc('getCode', { address: POOL, blockNumber }), 'Pool')
  if (lower(poolCodeHash) !== lower(baseline.poolCodeHash))
    throw new Error('Frozen Pool runtime identity changed')
  const poolImplementation = await pinnedImplementation(client, baseline.blockHash, checkDisk, out)
  const markets = []
  for (const { market, baselineRow, holders } of frozen) {
    const underlyingCodeHash = codeHash(
      await rpc('getCode', { address: market.base, blockNumber }),
      `${market.name} underlying`,
    )
    const aTokenCodeHash = codeHash(
      await rpc('getCode', { address: market.aToken, blockNumber }),
      `${market.name} aToken`,
    )
    if (
      lower(underlyingCodeHash) !== lower(baselineRow.underlyingCodeHash) ||
      lower(aTokenCodeHash) !== lower(baselineRow.aTokenCodeHash)
    )
      throw new Error(`${market.name} runtime identity changed`)
    const reserve = await rpc('readContract', {
      address: POOL,
      abi: ABI.reserve,
      functionName: 'getReserveData',
      args: [market.base],
      blockNumber,
    })
    const reserveId = Number(uint(reserve?.id, 'reserve id'))
    const decimals = Number(
      (uint(reserve?.configuration?.data, 'reserve configuration') >> 48n) & 255n,
    )
    if (
      lower(reserve?.aTokenAddress) !== lower(market.aToken) ||
      decimals !== market.decimals ||
      !Number.isInteger(reserveId) ||
      reserveId < 0 ||
      reserveId > 127
    )
      throw new Error(`${market.name} reserve identity mismatch`)
    const witnesses = []
    for (const holder of holders) {
      const witness = {
        holder: lower(holder),
        bitmapRaw: null,
        selectedReserveBorrowing: null,
        selectedReserveCollateral: null,
        anyBorrow: null,
        accountData: null,
        readErrorStages: [],
      }
      witnesses.push(witness)
      checkDisk(out)
      try {
        const configuration = await client.readContract({
          address: POOL,
          abi: USER_ABI,
          functionName: 'getUserConfiguration',
          args: [holder],
          blockNumber,
        })
        Object.assign(witness, decodeUserBitmap(configuration?.data, reserveId))
      } catch {
        witness.readErrorStages.push('getUserConfiguration')
      }
      checkDisk(out)
      try {
        witness.accountData = accountRaw(
          await client.readContract({
            address: POOL,
            abi: USER_ABI,
            functionName: 'getUserAccountData',
            args: [holder],
            blockNumber,
          }),
        )
      } catch {
        witness.readErrorStages.push('getUserAccountData')
      }
    }
    markets.push({
      name: market.name,
      underlying: lower(market.base),
      aToken: lower(market.aToken),
      reserveId,
      quoteRaw: QUOTE_RAW,
      underlyingCodeHash,
      aTokenCodeHash,
      witnesses,
    })
  }
  const finalHeader = await rpc('getBlock', { blockNumber })
  if (
    lower(finalHeader?.hash) !== lower(baseline.blockHash) ||
    Number(finalHeader?.timestamp) !== baseline.blockTimestamp
  )
    throw new Error('Frozen block reorganized during configuration read')
  const observedAtMs = observationTime(now, baseline, 'collection')
  return {
    baselineBlock: FROZEN_BLOCK,
    baselineBlockHash: lower(baseline.blockHash),
    baselineSha256: baseline.rowSha256,
    blockTimestamp: baseline.blockTimestamp,
    observedAtMs,
    poolCodeHash,
    poolImplementation,
    markets,
  }
}

function save(out, baselinePath, payload, checkDisk) {
  checkDisk(out)
  mkdirSync(dirname(out), { recursive: true })
  const temp = `${out}.${process.pid}.tmp`
  let fd
  try {
    fd = openSync(temp, 'wx', 0o600)
    writeFileSync(fd, JSON.stringify({ payload, sha256: digest(payload) }))
    closeSync(fd)
    fd = undefined
    checkDisk(out)
    renameSync(temp, out)
    readCheckpoint(out, baselinePath)
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    if (existsSync(temp)) unlinkSync(temp)
    throw error
  }
}

export async function run({
  client,
  baselineBlock,
  baselinePath = DEFAULT_BASELINE,
  out = DEFAULT_OUT,
  checkDisk = diskGuard,
  now,
}) {
  if (baselineBlock !== FROZEN_BLOCK) throw new Error('Explicit frozen baseline block required')
  checkDisk(out)
  mkdirSync(dirname(out), { recursive: true })
  const lock = `${out}.lock`
  let fd
  try {
    fd = openSync(lock, 'wx', 0o600)
    const baseline = readBaseline(baselinePath).baselines.find((row) => row.block === baselineBlock)
    frozenMarkets(baseline)
    const clock = now || Date.now
    observationTime(clock, baseline, 'preflight')
    const saved = readCheckpoint(out, baselinePath)
    if (saved.records.length) throw new Error('Frozen wallet configuration already recorded')
    const result = await collectConfig({ client, baseline, out, checkDisk, now: clock })
    const refreshed = readBaseline(baselinePath).baselines.find(
      (row) => row.block === baselineBlock,
    )
    if (refreshed?.rowSha256 !== baseline.rowSha256)
      throw new Error('Baseline changed during wallet configuration collection')
    observationTime(clock, baseline, 'save')
    const row = { ...result, rowSha256: digest(result) }
    save(out, baselinePath, { ...saved, records: [row] }, checkDisk)
    return {
      out,
      baselineBlock,
      witnessCounts: row.markets.map((market) => ({
        name: market.name,
        count: market.witnesses.length,
      })),
    }
  } finally {
    if (fd !== undefined) {
      closeSync(fd)
      unlinkSync(lock)
    }
  }
}

export function plan({ baselinePath = DEFAULT_BASELINE, out = DEFAULT_OUT } = {}) {
  const data = readBaseline(baselinePath)
  const baseline = data.baselines.find((row) => row.block === FROZEN_BLOCK)
  return {
    status: 'dry-only',
    out,
    baselineBlock: FROZEN_BLOCK,
    frozenWitnesses: baseline
      ? frozenMarkets(baseline).map((row) => ({ name: row.market.name, count: row.holders.length }))
      : [],
    recorded: readCheckpoint(out, baselinePath).records.length,
    diskFloorBytes: DISK_FLOOR_BYTES,
    caveat:
      'No RPC or write; --run --baseline-block reads only the frozen anchor. Pre-withdraw account data is context, not a cause.',
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2)
    const flag = (name) => {
      const at = args.indexOf(name)
      return at < 0 ? undefined : args[at + 1]
    }
    const known = new Set(['--run', '--baseline', '--out', '--baseline-block'])
    for (let i = 0; i < args.length; i++) {
      if (!known.has(args[i])) throw new Error('Invalid argument')
      if (args[i] !== '--run' && (!args[i + 1] || args[i + 1].startsWith('--')))
        throw new Error('Missing argument value')
      if (args[i] !== '--run') i++
    }
    const baselinePath = flag('--baseline') || DEFAULT_BASELINE
    const out = flag('--out') || DEFAULT_OUT
    const result = args.includes('--run')
      ? await run({
          client: makeClient(process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')),
          baselineBlock: Number(flag('--baseline-block')),
          baselinePath,
          out,
        })
      : plan({ baselinePath, out })
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch {
    // Provider errors may embed credential-bearing URLs.
    process.stderr.write('Holder config failed. Check frozen block, RPC, disk, and checkpoint.\n')
    process.exitCode = 1
  }
}
