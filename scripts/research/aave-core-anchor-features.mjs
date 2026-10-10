// Same-block prospective features for a previously frozen holder-witness anchor.
// Separates the preregistered cash proxy from Origin's virtual-balance
// borrow-usage model. Neither is an executable outcome or an alert.
// Dry by default; --run requires an explicit baseline block. No later-block reads.
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
import { keccak256, stringToHex } from 'viem'
import { ABI, MARKETS, POOL, diskGuard } from './aave-core-forward-panel.mjs'
import {
  DEFAULT_OUT as DEFAULT_BASELINE,
  readCheckpoint as readBaseline,
} from './aave-core-holder-witness.mjs'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'

export const DEFAULT_OUT = resolve('data/research/venue-signals/aave-core-anchor-features-v1.json')
export const HORIZON_SECONDS = 6 * 3600
export const QUOTE_RAW = 1_000_000n * 10n ** 6n
const STUDY = 'aave-core-anchor-features-v1'
const ZERO = '0x0000000000000000000000000000000000000000'
const lower = (value) => String(value || '').toLowerCase()
const shaBytes = (value) => createHash('sha256').update(value).digest('hex')
const digest = (value) => shaBytes(JSON.stringify(value))
const isHash = (value) => /^0x[0-9a-fA-F]{64}$/.test(String(value))
const isAddress = (value) => /^0x[0-9a-fA-F]{40}$/.test(String(value)) && lower(value) !== ZERO
const VIRTUAL_BALANCE_ABI = [
  {
    type: 'function',
    name: 'getVirtualUnderlyingBalance',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [{ name: '', type: 'uint128' }],
  },
]
const uint = (value, label) => {
  let n
  try {
    n = BigInt(value)
  } catch {
    throw new Error(`Invalid ${label}`)
  }
  if (n < 0n) throw new Error(`Negative ${label}`)
  return n
}
const codeHash = (code, label) => {
  if (typeof code !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(code))
    throw new Error(`${label} missing deployed code`)
  return keccak256(code)
}
const initial = (baselinePath) => ({
  study: STUDY,
  chainId: 1,
  pool: POOL,
  markets: MARKETS,
  baselinePath: resolve(baselinePath),
  feature:
    'At frozen B: preregistered signed raw-cash proxy optimalUsageRatio/10000 - variableDebtSupply/(variableDebtSupply+cash), plus Origin strategy borrow-usage gap with Pool virtual balance if stable-debt mock is zero; both exact rationals. Cash/quote comparator. No fitted threshold or outcome.',
  rows: [],
})

export function readCheckpoint(out = DEFAULT_OUT, baselinePath = DEFAULT_BASELINE) {
  if (!existsSync(out)) return initial(baselinePath)
  const saved = JSON.parse(readFileSync(out, 'utf8'))
  if (!saved?.payload || saved.sha256 !== digest(saved.payload))
    throw new Error('Anchor feature checkpoint SHA mismatch')
  const data = saved.payload
  const expected = initial(baselinePath)
  if (
    data.study !== STUDY ||
    data.chainId !== 1 ||
    lower(data.pool) !== lower(POOL) ||
    JSON.stringify(data.markets) !== JSON.stringify(MARKETS) ||
    data.baselinePath !== expected.baselinePath ||
    data.feature !== expected.feature ||
    !Array.isArray(data.rows) ||
    data.rows.length > 128
  )
    throw new Error('Anchor feature checkpoint identity mismatch')
  let prior = null
  for (const row of data.rows) {
    if (
      !Number.isSafeInteger(row.block) ||
      !isHash(row.blockHash) ||
      !Number.isSafeInteger(row.blockTimestamp) ||
      !Number.isSafeInteger(row.observedAtMs) ||
      !Number.isSafeInteger(row.baselineObservedAtMs) ||
      (row.captureStartedAtMs !== undefined &&
        (!Number.isSafeInteger(row.captureStartedAtMs) ||
          row.captureStartedAtMs < row.blockTimestamp * 1000 ||
          row.captureStartedAtMs < row.baselineObservedAtMs ||
          row.captureStartedAtMs > row.observedAtMs)) ||
      row.observedAtMs < row.baselineObservedAtMs ||
      row.observedAtMs >= (row.blockTimestamp + HORIZON_SECONDS) * 1000 ||
      !/^[0-9a-f]{64}$/.test(String(row.sourcePhysicalSha256)) ||
      !/^[0-9a-f]{64}$/.test(String(row.baselineRowSha256)) ||
      row.previousSha256 !== (prior?.rowSha256 || null) ||
      row.rowSha256 !== digest({ ...row, rowSha256: undefined }) ||
      (prior && (row.block <= prior.block || row.observedAtMs < prior.observedAtMs)) ||
      !Array.isArray(row.markets) ||
      row.markets.length !== MARKETS.length ||
      row.markets.some((market, i) => market.name !== MARKETS[i].name)
    )
      throw new Error('Anchor feature row chain mismatch')
    prior = row
  }
  return data
}

export function kinkGap(optimalUsageRatioBps, variableDebtRaw, cashRaw, quoteRaw = QUOTE_RAW) {
  const optimal = uint(optimalUsageRatioBps, 'optimal usage BPS')
  const debt = uint(variableDebtRaw, 'variable debt')
  const cash = uint(cashRaw, 'cash')
  const quote = uint(quoteRaw, 'quote')
  if (optimal > 10_000n || debt + cash === 0n || quote === 0n)
    throw new Error('Undefined kink gap or cash/quote')
  const total = debt + cash
  const numerator = optimal * total - 10_000n * debt
  return {
    optimalUsageRatioBps: optimal.toString(),
    variableDebtSupplyRaw: debt.toString(),
    cashRaw: cash.toString(),
    debtPlusCashRaw: total.toString(),
    signedGapFraction: {
      numerator: numerator.toString(),
      denominator: (10_000n * total).toString(),
    },
    signedGapPercentagePoints: {
      numerator: numerator.toString(),
      denominator: (100n * total).toString(),
    },
    cashPerQuote: { numerator: cash.toString(), denominator: quote.toString() },
  }
}

export function modelKinkGap(optimalUsageRatioBps, totalDebtRaw, virtualBalanceRaw) {
  const totalDebt = uint(totalDebtRaw, 'total debt')
  const virtualBalance = uint(virtualBalanceRaw, 'virtual underlying balance')
  const proxy = kinkGap(optimalUsageRatioBps, totalDebt, virtualBalance)
  return {
    totalDebtRaw: totalDebt.toString(),
    virtualUnderlyingBalanceRaw: virtualBalance.toString(),
    borrowUsageFraction: {
      numerator: totalDebt.toString(),
      denominator: (totalDebt + virtualBalance).toString(),
    },
    signedGapFraction: proxy.signedGapFraction,
    signedGapPercentagePoints: proxy.signedGapPercentagePoints,
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
  return Object.fromEntries(
    keys.map((key, i) => {
      const value = uint(raw?.[key], key)
      if (value > limits[i]) throw new Error(`Unsupported ${key}`)
      return [key, Number(value)]
    }),
  )
}

export function selectBaseline(data, block) {
  if (!Number.isSafeInteger(block) || block < 0) throw new Error('Explicit baseline block required')
  const baseline = data.baselines.find((row) => row.block === block)
  if (
    !baseline ||
    !isHash(baseline.blockHash) ||
    !isHash(baseline.poolCodeHash) ||
    !Number.isSafeInteger(baseline.blockTimestamp) ||
    !Number.isSafeInteger(baseline.observedAtMs) ||
    baseline.observedAtMs < baseline.blockTimestamp * 1000 ||
    baseline.observedAtMs >= (baseline.blockTimestamp + HORIZON_SECONDS) * 1000 ||
    !/^[0-9a-f]{64}$/.test(String(baseline.rowSha256)) ||
    !Array.isArray(baseline.markets) ||
    baseline.markets.length !== MARKETS.length
  )
    throw new Error('Baseline absent, malformed, or observed after +6h target')
  for (const [i, market] of MARKETS.entries()) {
    const row = baseline.markets[i]
    if (
      row.name !== market.name ||
      lower(row.underlying) !== lower(market.base) ||
      lower(row.aToken) !== lower(market.aToken) ||
      row.decimals !== market.decimals ||
      uint(row.quoteRaw, 'baseline quote') !== QUOTE_RAW ||
      !isHash(row.underlyingCodeHash) ||
      !isHash(row.aTokenCodeHash)
    )
      throw new Error('Baseline market identity mismatch')
  }
  return baseline
}

export async function collect({
  client,
  baseline,
  sourcePhysicalSha256,
  out = DEFAULT_OUT,
  checkDisk = diskGuard,
  now = Date.now,
}) {
  const captureStartedAtMs = now()
  if (
    !Number.isSafeInteger(captureStartedAtMs) ||
    captureStartedAtMs < baseline.blockTimestamp * 1000 ||
    captureStartedAtMs < baseline.observedAtMs ||
    captureStartedAtMs >= (baseline.blockTimestamp + HORIZON_SECONDS) * 1000
  )
    throw new Error('Invalid feature capture start time')
  const rpc = async (method, args = {}) => {
    checkDisk(out)
    return client[method](args)
  }
  if (Number(await rpc('getChainId')) !== 1) throw new Error('Ethereum mainnet required')
  const blockNumber = BigInt(baseline.block)
  const header = await rpc('getBlock', { blockNumber })
  if (
    lower(header?.hash) !== lower(baseline.blockHash) ||
    Number(header?.timestamp) !== baseline.blockTimestamp
  )
    throw new Error('Baseline block no longer canonical or provider inconsistent')
  const poolCodeHash = codeHash(await rpc('getCode', { address: POOL, blockNumber }), 'Pool')
  if (lower(poolCodeHash) !== lower(baseline.poolCodeHash))
    throw new Error('Pool code identity changed at baseline')
  const addressesProvider = await rpc('readContract', {
    address: POOL,
    abi: ABI.provider,
    functionName: 'ADDRESSES_PROVIDER',
    blockNumber,
  })
  if (!isAddress(addressesProvider)) throw new Error('Invalid addresses provider')
  const mockStableDebtAddress = await rpc('readContract', {
    address: addressesProvider,
    abi: ABI.registry,
    functionName: 'getAddress',
    args: [stringToHex('MOCK_STABLE_DEBT', { size: 32 })],
    blockNumber,
  })
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(mockStableDebtAddress)))
    throw new Error('Invalid mock stable-debt registry value')
  const zeroMockRegistry = lower(mockStableDebtAddress) === ZERO

  const rows = []
  for (const [i, market] of MARKETS.entries()) {
    const frozen = baseline.markets[i]
    const underlyingCodeHash = codeHash(
      await rpc('getCode', { address: market.base, blockNumber }),
      `${market.name} underlying`,
    )
    const aTokenCodeHash = codeHash(
      await rpc('getCode', { address: market.aToken, blockNumber }),
      `${market.name} aToken`,
    )
    if (
      lower(underlyingCodeHash) !== lower(frozen.underlyingCodeHash) ||
      lower(aTokenCodeHash) !== lower(frozen.aTokenCodeHash)
    )
      throw new Error(`${market.name} code identity mismatch`)
    const reserve = await rpc('readContract', {
      address: POOL,
      abi: ABI.reserve,
      functionName: 'getReserveData',
      args: [market.base],
      blockNumber,
    })
    if (lower(reserve?.aTokenAddress) !== lower(market.aToken))
      throw new Error(`${market.name} aToken identity mismatch`)
    for (const key of ['variableDebtTokenAddress', 'interestRateStrategyAddress']) {
      if (!isAddress(reserve?.[key])) throw new Error(`${market.name} missing ${key}`)
    }
    const stableIsMock =
      !zeroMockRegistry && lower(reserve?.stableDebtTokenAddress) === lower(mockStableDebtAddress)
    const unresolvedZeroRegistry =
      zeroMockRegistry && lower(reserve?.stableDebtTokenAddress) === ZERO
    if (!stableIsMock && !unresolvedZeroRegistry && !isAddress(reserve?.stableDebtTokenAddress))
      throw new Error(`${market.name} missing stable-debt token`)
    const config = uint(reserve?.configuration?.data, 'reserve configuration')
    const configDecimals = Number((config >> 48n) & 255n)
    const tokenDecimals = Number(
      await rpc('readContract', {
        address: market.base,
        abi: ABI.token,
        functionName: 'decimals',
        blockNumber,
      }),
    )
    const aTokenDecimals = Number(
      await rpc('readContract', {
        address: market.aToken,
        abi: ABI.token,
        functionName: 'decimals',
        blockNumber,
      }),
    )
    if ([configDecimals, tokenDecimals, aTokenDecimals].some((n) => n !== market.decimals))
      throw new Error(`${market.name} decimals mismatch`)
    if (uint(reserve.lastUpdateTimestamp, 'reserve update') > BigInt(baseline.blockTimestamp))
      throw new Error(`${market.name} reserve updated after baseline block`)
    const variableDebtToken = reserve.variableDebtTokenAddress
    const strategyAddress = reserve.interestRateStrategyAddress
    const variableDebtCodeHash = codeHash(
      await rpc('getCode', { address: variableDebtToken, blockNumber }),
      `${market.name} variable debt`,
    )
    const variableDebtDecimals = Number(
      await rpc('readContract', {
        address: variableDebtToken,
        abi: ABI.token,
        functionName: 'decimals',
        blockNumber,
      }),
    )
    if (variableDebtDecimals !== market.decimals)
      throw new Error(`${market.name} variable debt decimals mismatch`)
    const strategyCodeHash = codeHash(
      await rpc('getCode', { address: strategyAddress, blockNumber }),
      `${market.name} strategy`,
    )
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
    const virtualBalance = uint(
      await rpc('readContract', {
        address: POOL,
        abi: VIRTUAL_BALANCE_ABI,
        functionName: 'getVirtualUnderlyingBalance',
        args: [market.base],
        blockNumber,
      }),
      `${market.name} virtual underlying balance`,
    )
    const aTokenSupply = await readToken(market.aToken, 'totalSupply')
    const variableDebt = await readToken(variableDebtToken, 'totalSupply')
    const stableDebtSupply = isAddress(reserve.stableDebtTokenAddress)
      ? await readToken(reserve.stableDebtTokenAddress, 'totalSupply')
      : null
    if (stableIsMock && stableDebtSupply !== null && stableDebtSupply !== 0n)
      throw new Error(`${market.name} compatibility mock has nonzero supply`)
    const strategy = parseStrategy(
      await rpc('readContract', {
        address: strategyAddress,
        abi: ABI.strategy,
        functionName: 'getInterestRateDataBps',
        args: [market.base],
        blockNumber,
      }),
    )
    rows.push({
      name: market.name,
      underlying: lower(market.base),
      aToken: lower(market.aToken),
      underlyingCodeHash,
      aTokenCodeHash,
      variableDebtToken: lower(variableDebtToken),
      variableDebtCodeHash,
      strategyAddress: lower(strategyAddress),
      strategyCodeHash,
      stableDebtToken: lower(reserve.stableDebtTokenAddress),
      stableDebtFieldKind: stableIsMock
        ? 'compatibility-mock'
        : unresolvedZeroRegistry
          ? 'unresolved-zero-registry'
          : 'debt-token',
      stableDebtSupplyRaw: stableDebtSupply?.toString() ?? null,
      reserveId: Number(uint(reserve.id, 'reserve id')),
      configurationRaw: config.toString(),
      decimals: configDecimals,
      flags: {
        active: Boolean((config >> 56n) & 1n),
        frozen: Boolean((config >> 57n) & 1n),
        borrowingEnabled: Boolean((config >> 58n) & 1n),
        stableBorrowingEnabled: Boolean((config >> 59n) & 1n),
        paused: Boolean((config >> 60n) & 1n),
      },
      aTokenSupplyRaw: aTokenSupply.toString(),
      liquidityRateRay: uint(reserve.currentLiquidityRate, 'liquidity rate').toString(),
      variableBorrowRateRay: uint(
        reserve.currentVariableBorrowRate,
        'variable borrow rate',
      ).toString(),
      stableBorrowRateRay: uint(reserve.currentStableBorrowRate, 'stable borrow rate').toString(),
      strategyBps: strategy,
      rawCashProxy:
        variableDebt + cash === 0n ? null : kinkGap(strategy.optimalUsageRatio, variableDebt, cash),
      rawCashProxyMissingReason: variableDebt + cash === 0n ? 'zero-proxy-denominator' : null,
      strategyBorrowUsageModel:
        stableIsMock && stableDebtSupply === 0n && variableDebt + virtualBalance > 0n
          ? modelKinkGap(strategy.optimalUsageRatio, variableDebt, virtualBalance)
          : null,
      strategyBorrowUsageMissingReason: zeroMockRegistry
        ? 'zero-mock-registry-cannot-attest-stable-debt'
        : !stableIsMock || stableDebtSupply !== 0n
          ? 'stable-debt-field-not-attested-zero-compatibility-mock'
          : variableDebt + virtualBalance === 0n
            ? 'zero-model-denominator'
            : null,
    })
  }
  const end = await rpc('getBlock', { blockNumber })
  if (lower(end?.hash) !== lower(header.hash) || Number(end?.timestamp) !== baseline.blockTimestamp)
    throw new Error('Pinned baseline block changed during collection')
  const observedAtMs = now()
  if (
    !Number.isSafeInteger(observedAtMs) ||
    observedAtMs < captureStartedAtMs ||
    observedAtMs < baseline.observedAtMs ||
    observedAtMs >= (baseline.blockTimestamp + HORIZON_SECONDS) * 1000
  )
    throw new Error('Feature observation after +6h target or before baseline observation')
  return {
    block: baseline.block,
    blockHash: lower(header.hash),
    blockTimestamp: baseline.blockTimestamp,
    baselineObservedAtMs: baseline.observedAtMs,
    captureStartedAtMs,
    observedAtMs,
    sourcePhysicalSha256,
    baselineRowSha256: baseline.rowSha256,
    poolCodeHash,
    addressesProvider: lower(addressesProvider),
    mockStableDebtAddress: lower(mockStableDebtAddress),
    markets: rows,
  }
}

function atomicSave(out, payload, baselinePath, checkDisk) {
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
  now = Date.now,
}) {
  checkDisk(out)
  mkdirSync(dirname(out), { recursive: true })
  const lock = `${out}.lock`
  let fd
  try {
    fd = openSync(lock, 'wx', 0o600)
    const data = readCheckpoint(out, baselinePath)
    if (data.rows.length >= 128 || data.rows.some((row) => row.block === baselineBlock))
      throw new Error('Feature cap or duplicate baseline block')
    const physical = readFileSync(baselinePath)
    const sourcePhysicalSha256 = shaBytes(physical)
    const baseline = selectBaseline(readBaseline(baselinePath), baselineBlock)
    if (now() >= (baseline.blockTimestamp + HORIZON_SECONDS) * 1000)
      throw new Error('Feature observation cannot begin after +6h target')
    const row = await collect({ client, baseline, sourcePhysicalSha256, out, checkDisk, now })
    if (shaBytes(readFileSync(baselinePath)) !== sourcePhysicalSha256)
      throw new Error('Baseline source changed during feature collection')
    const previous = data.rows.at(-1)
    if (previous && (row.block <= previous.block || row.observedAtMs < previous.observedAtMs))
      throw new Error('Non-monotone feature anchor')
    const withoutHash = { ...row, previousSha256: previous?.rowSha256 || null }
    const saved = { ...withoutHash, rowSha256: digest(withoutHash) }
    atomicSave(out, { ...data, rows: [...data.rows, saved] }, baselinePath, checkDisk)
    return { out, block: saved.block, markets: saved.markets.map((market) => market.name) }
  } finally {
    if (fd !== undefined) {
      closeSync(fd)
      unlinkSync(lock)
    }
  }
}

export function plan(out = DEFAULT_OUT, baselinePath = DEFAULT_BASELINE) {
  const data = readCheckpoint(out, baselinePath)
  return {
    out,
    status: 'dry-only',
    rows: data.rows.length,
    caveat: 'No RPC or write. Explicit --run --baseline-block collects same-block features only.',
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2)
    const allowed = new Set(['--run', '--baseline-block', '--baseline', '--out'])
    const valued = new Set(['--baseline-block', '--baseline', '--out'])
    if (
      args.some((arg, i) =>
        arg.startsWith('--') ? !allowed.has(arg) : i === 0 || !valued.has(args[i - 1]),
      ) ||
      [...allowed].some((arg) => args.filter((value) => value === arg).length > 1)
    )
      throw new Error('Invalid command-line arguments')
    const option = (name) => {
      const at = args.indexOf(name)
      return at < 0 ? undefined : args[at + 1]
    }
    const out = option('--out') || DEFAULT_OUT
    const baselinePath = option('--baseline') || DEFAULT_BASELINE
    const blockText = option('--baseline-block')
    const baselineBlock = blockText === undefined ? NaN : Number(blockText)
    const result = args.includes('--run')
      ? await run({
          client: makeClient(process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')),
          baselineBlock,
          baselinePath,
          out,
        })
      : plan(out, baselinePath)
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch {
    // RPC exceptions may contain credential-bearing URLs.
    process.stderr.write('Anchor feature collection failed. Check disk, RPC, and baseline state.\n')
    process.exitCode = 1
  }
}
