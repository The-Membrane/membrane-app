// Prospective Ethereum Core reserve observations. Cash is a reserve-state proxy,
// never proof that any holder's Pool.withdraw would execute. No RPC without --run.
import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { stringToHex } from 'viem'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'

export const POOL = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2'
export const MARKETS = Object.freeze([
  Object.freeze({
    name: 'USDC',
    base: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    aToken: '0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c',
    decimals: 6,
  }),
  Object.freeze({
    name: 'USDT',
    base: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    aToken: '0x23878914EFE38d27C4D67Ab83ed1b93A74D4086a',
    decimals: 6,
  }),
])
export const DEFAULT_OUT = resolve('data/research/venue-signals/aave-core-forward-panel-v1.json')
export const DISK_FLOOR_BYTES = 1 * 1024 ** 3
export const MAX_SAMPLES = 4096
const STUDY = 'aave-core-forward-panel-v1'
const ZERO = '0x0000000000000000000000000000000000000000'
const addr = (value) => String(value || '').toLowerCase()
const sha = (value) => createHash('sha256').update(value).digest('hex')
export const digest = (value) => sha(JSON.stringify(value))
const field = (name, type) => ({ name, type })
const fn = (name, inputs, outputs) => ({
  type: 'function',
  name,
  stateMutability: 'view',
  inputs,
  outputs,
})
export const ABI = Object.freeze({
  reserve: [
    fn(
      'getReserveData',
      [field('asset', 'address')],
      [
        {
          type: 'tuple',
          components: [
            { name: 'configuration', type: 'tuple', components: [field('data', 'uint256')] },
            ...[
              'liquidityIndex',
              'currentLiquidityRate',
              'variableBorrowIndex',
              'currentVariableBorrowRate',
              'currentStableBorrowRate',
            ].map((name) => field(name, 'uint128')),
            field('lastUpdateTimestamp', 'uint40'),
            field('id', 'uint16'),
            field('aTokenAddress', 'address'),
            field('stableDebtTokenAddress', 'address'),
            field('variableDebtTokenAddress', 'address'),
            field('interestRateStrategyAddress', 'address'),
            field('accruedToTreasury', 'uint128'),
            field('unbacked', 'uint128'),
            field('isolationModeTotalDebt', 'uint128'),
          ],
        },
      ],
    ),
  ],
  token: [
    fn('balanceOf', [field('owner', 'address')], [field('', 'uint256')]),
    fn('totalSupply', [], [field('', 'uint256')]),
    fn('decimals', [], [field('', 'uint8')]),
  ],
  strategy: [
    fn(
      'getInterestRateDataBps',
      [field('reserve', 'address')],
      [
        {
          type: 'tuple',
          components: [
            field('optimalUsageRatio', 'uint16'),
            field('baseVariableBorrowRate', 'uint32'),
            field('variableRateSlope1', 'uint32'),
            field('variableRateSlope2', 'uint32'),
          ],
        },
      ],
    ),
  ],
  provider: [fn('ADDRESSES_PROVIDER', [], [field('', 'address')])],
  registry: [fn('getAddress', [field('id', 'bytes32')], [field('', 'address')])],
})

const initial = () => ({
  study: STUDY,
  chainId: 1,
  pool: POOL,
  markets: MARKETS,
  semantics:
    'Pinned Core reserve state and raw token quantities; not an executable holder withdrawal or an exit-risk alert',
  samples: [],
})
const seal = (payload) => ({ payload, sha256: digest(payload) })
const uint = (value, label) => {
  let number
  try {
    number = BigInt(value)
  } catch {
    throw new Error(`Invalid ${label}`)
  }
  if (number < 0n) throw new Error(`Negative ${label}`)
  return number
}
const hexHash = (value) => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)
const validAddress = (value) => /^0x[0-9a-fA-F]{40}$/.test(String(value)) && addr(value) !== ZERO

export function diskGuard(path) {
  let dir = dirname(resolve(path))
  while (!existsSync(dir)) {
    const parent = dirname(dir)
    if (parent === dir) throw new Error('No output ancestor')
    dir = parent
  }
  const stat = statfsSync(dir)
  if (stat.bavail * stat.bsize < DISK_FLOOR_BYTES) throw new Error('Disk reserve below 1 GiB')
}

export function readCheckpoint(path) {
  if (!existsSync(path)) return initial()
  const saved = JSON.parse(readFileSync(path, 'utf8'))
  if (!saved?.payload || saved.sha256 !== digest(saved.payload))
    throw new Error('Forward panel checkpoint SHA mismatch')
  const data = saved.payload
  if (
    data.study !== STUDY ||
    data.chainId !== 1 ||
    addr(data.pool) !== addr(POOL) ||
    JSON.stringify(data.markets) !== JSON.stringify(MARKETS) ||
    data.semantics !== initial().semantics ||
    !Array.isArray(data.samples) ||
    data.samples.length > MAX_SAMPLES
  )
    throw new Error('Forward panel checkpoint identity mismatch')
  let priorBlock = -1
  let priorObserved = 0
  let priorRowHash = null
  for (const sample of data.samples) {
    if (
      !Number.isSafeInteger(sample.block) ||
      sample.block <= priorBlock ||
      !hexHash(sample.blockHash) ||
      !Number.isSafeInteger(sample.blockTimestamp) ||
      !Number.isSafeInteger(sample.observedAtMs) ||
      sample.observedAtMs < priorObserved ||
      sample.previousSampleSha256 !== priorRowHash ||
      sample.sampleSha256 !== digest({ ...sample, sampleSha256: undefined }) ||
      !Array.isArray(sample.markets) ||
      sample.markets.length !== MARKETS.length ||
      sample.markets.some((row, i) => row.name !== MARKETS[i].name)
    )
      throw new Error('Forward panel sample chain mismatch')
    priorBlock = sample.block
    priorObserved = sample.observedAtMs
    priorRowHash = sample.sampleSha256
  }
  return data
}

function atomicSave(path, payload, checkDisk) {
  checkDisk(path)
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  let fd
  try {
    fd = openSync(temp, 'wx', 0o600)
    writeFileSync(fd, JSON.stringify(seal(payload)))
    closeSync(fd)
    fd = undefined
    checkDisk(path)
    renameSync(temp, path)
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    if (existsSync(temp)) unlinkSync(temp)
    throw error
  }
}

function parseStrategy(raw) {
  const keys = [
    'optimalUsageRatio',
    'baseVariableBorrowRate',
    'variableRateSlope1',
    'variableRateSlope2',
  ]
  const limits = [10_000n, 2n ** 32n - 1n, 2n ** 32n - 1n, 2n ** 32n - 1n]
  const values = keys.map((key, i) => {
    const value = uint(raw?.[key], key)
    if (value > limits[i]) throw new Error(`Unsupported ${key}`)
    return Number(value)
  })
  return Object.fromEntries(keys.map((key, i) => [key, values[i]]))
}

export async function collectSample({
  client,
  out = DEFAULT_OUT,
  checkDisk = diskGuard,
  now = () => Date.now(),
  confirmations = 64,
}) {
  if (!Number.isSafeInteger(confirmations) || confirmations < 12 || confirmations > 2048)
    throw new Error('confirmations must be 12–2048')
  const rpc = async (method, args = {}) => {
    checkDisk(out)
    return client[method](args)
  }
  if (Number(await rpc('getChainId')) !== 1) throw new Error('Ethereum mainnet chain id required')
  const head = uint(await rpc('getBlockNumber'), 'head')
  if (head <= BigInt(confirmations)) throw new Error('Head is before confirmation depth')
  const blockNumber = head - BigInt(confirmations)
  if (blockNumber > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Unsupported block number')
  const header = await rpc('getBlock', { blockNumber })
  const block = Number(blockNumber)
  const blockTimestamp = Number(uint(header?.timestamp, 'timestamp'))
  if (!hexHash(header?.hash) || !Number.isSafeInteger(blockTimestamp))
    throw new Error('Invalid pinned block header')
  const addressesProvider = await rpc('readContract', {
    address: POOL,
    abi: ABI.provider,
    functionName: 'ADDRESSES_PROVIDER',
    blockNumber,
  })
  if (!validAddress(addressesProvider)) throw new Error('Invalid Aave addresses provider')
  const mockStableDebtAddress = await rpc('readContract', {
    address: addressesProvider,
    abi: ABI.registry,
    functionName: 'getAddress',
    args: [stringToHex('MOCK_STABLE_DEBT', { size: 32 })],
    blockNumber,
  })
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(mockStableDebtAddress)))
    throw new Error('Invalid Aave mock stable-debt address')
  const rows = []
  for (const market of MARKETS) {
    const reserve = await rpc('readContract', {
      address: POOL,
      abi: ABI.reserve,
      functionName: 'getReserveData',
      args: [market.base],
      blockNumber,
    })
    if (addr(reserve?.aTokenAddress) !== addr(market.aToken))
      throw new Error(`${market.name} aToken identity mismatch`)
    for (const key of ['variableDebtTokenAddress', 'interestRateStrategyAddress']) {
      if (!validAddress(reserve?.[key])) throw new Error(`${market.name} missing ${key}`)
    }
    const stableIsMock = addr(reserve?.stableDebtTokenAddress) === addr(mockStableDebtAddress)
    if (!stableIsMock && !validAddress(reserve?.stableDebtTokenAddress))
      throw new Error(`${market.name} missing stableDebtTokenAddress`)
    const bits = uint(reserve?.configuration?.data, 'configuration')
    const decimals = Number((bits >> 48n) & 255n)
    const tokenDecimals = Number(
      await rpc('readContract', {
        address: market.base,
        abi: ABI.token,
        functionName: 'decimals',
        blockNumber,
      }),
    )
    if (decimals !== market.decimals || tokenDecimals !== market.decimals)
      throw new Error(`${market.name} decimals mismatch`)
    if (uint(reserve.lastUpdateTimestamp, 'reserve update') > BigInt(blockTimestamp))
      throw new Error(`${market.name} future reserve update`)
    const readToken = async (address, functionName, args = []) =>
      uint(
        await rpc('readContract', {
          address,
          abi: ABI.token,
          functionName,
          args,
          blockNumber,
        }),
        `${market.name} ${functionName}`,
      )
    const cash = await readToken(market.base, 'balanceOf', [market.aToken])
    const supply = await readToken(market.aToken, 'totalSupply')
    const variableDebt = await readToken(reserve.variableDebtTokenAddress, 'totalSupply')
    const stableDebt = validAddress(reserve.stableDebtTokenAddress)
      ? await readToken(reserve.stableDebtTokenAddress, 'totalSupply')
      : null
    if (stableIsMock && stableDebt !== null && stableDebt !== 0n)
      throw new Error(`${market.name} compatibility mock has nonzero supply`)
    const strategy = parseStrategy(
      await rpc('readContract', {
        address: reserve.interestRateStrategyAddress,
        abi: ABI.strategy,
        functionName: 'getInterestRateDataBps',
        args: [market.base],
        blockNumber,
      }),
    )
    rows.push({
      name: market.name,
      underlying: addr(market.base),
      aToken: addr(reserve.aTokenAddress),
      decimals,
      reserveId: Number(uint(reserve.id, 'reserve id')),
      stableDebtToken: addr(reserve.stableDebtTokenAddress),
      stableDebtFieldKind: stableIsMock ? 'compatibility-mock' : 'debt-token',
      variableDebtToken: addr(reserve.variableDebtTokenAddress),
      interestRateStrategy: addr(reserve.interestRateStrategyAddress),
      configurationRaw: bits.toString(),
      flags: {
        active: Boolean((bits >> 56n) & 1n),
        frozen: Boolean((bits >> 57n) & 1n),
        borrowingEnabled: Boolean((bits >> 58n) & 1n),
        stableBorrowingEnabled: Boolean((bits >> 59n) & 1n),
        paused: Boolean((bits >> 60n) & 1n),
      },
      cashRaw: cash.toString(),
      aTokenSupplyRaw: supply.toString(),
      variableDebtSupplyRaw: variableDebt.toString(),
      stableDebtSupplyRaw: stableDebt?.toString() ?? null,
      liquidityRateRay: uint(reserve.currentLiquidityRate, 'liquidity rate').toString(),
      variableBorrowRateRay: uint(
        reserve.currentVariableBorrowRate,
        'variable borrow rate',
      ).toString(),
      stableBorrowRateRay: uint(reserve.currentStableBorrowRate, 'stable borrow rate').toString(),
      strategyBps: strategy,
    })
  }
  const endHeader = await rpc('getBlock', { blockNumber })
  if (
    addr(endHeader?.hash) !== addr(header.hash) ||
    Number(endHeader?.timestamp) !== blockTimestamp
  )
    throw new Error('Pinned block reorganization or inconsistent RPC')
  const observedAtMs = now()
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs < blockTimestamp * 1000)
    throw new Error('Invalid local observation time')
  return {
    block,
    blockHash: addr(header.hash),
    blockTimestamp,
    observedAtMs,
    addressesProvider: addr(addressesProvider),
    mockStableDebtAddress: addr(mockStableDebtAddress),
    markets: rows,
  }
}

export async function run({
  client,
  out = DEFAULT_OUT,
  checkDisk = diskGuard,
  now,
  confirmations = 64,
}) {
  checkDisk(out)
  mkdirSync(dirname(out), { recursive: true })
  const lock = `${out}.lock`
  let fd
  try {
    fd = openSync(lock, 'wx', 0o600)
    const data = readCheckpoint(out)
    if (data.samples.length >= MAX_SAMPLES) throw new Error('Forward panel sample cap reached')
    const fresh = await collectSample({ client, out, checkDisk, now, confirmations })
    const previous = data.samples.at(-1)
    if (previous && (fresh.block <= previous.block || fresh.observedAtMs < previous.observedAtMs))
      throw new Error('Non-monotone sample block or local time')
    if (previous) {
      checkDisk(out)
      const oldHeader = await client.getBlock({ blockNumber: BigInt(previous.block) })
      if (
        addr(oldHeader?.hash) !== previous.blockHash ||
        Number(oldHeader?.timestamp) !== previous.blockTimestamp
      )
        throw new Error('Previously saved block is no longer canonical')
    }
    const withoutHash = { ...fresh, previousSampleSha256: previous?.sampleSha256 || null }
    const row = { ...withoutHash, sampleSha256: digest(withoutHash) }
    const updated = { ...data, samples: [...data.samples, row] }
    atomicSave(out, updated, checkDisk)
    return { out, samples: updated.samples.length, block: row.block, blockHash: row.blockHash }
  } finally {
    if (fd !== undefined) {
      closeSync(fd)
      unlinkSync(lock)
    }
  }
}

export function plan(out = DEFAULT_OUT) {
  const data = readCheckpoint(out)
  return {
    out,
    status: 'dry-only',
    samples: data.samples.length,
    lastBlock: data.samples.at(-1)?.block ?? null,
    caveat:
      'No RPC or write. --run collects one near-finalized mainnet block; reserve cash is not executable withdrawal ability.',
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2)
    const option = (name) => {
      const at = args.indexOf(name)
      return at < 0 ? undefined : args[at + 1]
    }
    const allowed = new Set(['--run', '--out', '--confirmations'])
    if (
      args.some((arg, i) => arg.startsWith('--') && !allowed.has(arg)) ||
      args.some(
        (arg, i) =>
          !arg.startsWith('--') && (i === 0 || !['--out', '--confirmations'].includes(args[i - 1])),
      )
    )
      throw new Error('Invalid command-line arguments')
    const out = option('--out') || DEFAULT_OUT
    const confirmations =
      option('--confirmations') === undefined ? 64 : Number(option('--confirmations'))
    const result = args.includes('--run')
      ? await run({
          client: makeClient(process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')),
          out,
          confirmations,
        })
      : plan(out)
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch {
    // viem exceptions can contain endpoint URLs with credentials in their stack.
    process.stderr.write('Forward panel failed. Check local RPC, disk, and checkpoint state.\n')
    process.exitCode = 1
  }
}
