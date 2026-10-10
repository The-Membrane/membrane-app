// Aave V3 USDe unencumbered supplier cash-exit runway.
// Archive collection is block-pinned; aToken cash is an upper bound on a
// supplier's instant withdrawal, not a wallet-level withdraw simulation.
// Reserve pause and wallet health factor are separate gates, not target labels.
// node scripts/research/aave-cash-leading-study.mjs --days 7 --step-blocks 1200 --samples-out /private/tmp/aave-usde-7d.json
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { loadConfig, makeClient, readEnv } from '../lib/venue-reads.mjs'
import { analyze, assertSeries, DAY } from './aave-cash-leading-logic.mjs'

const args = process.argv.slice(2)
const opts = Object.fromEntries(
  args.flatMap((arg, i) => (arg.startsWith('--') ? [[arg.slice(2), args[i + 1]]] : [])),
)
const integer = (key, fallback, max) => {
  const n = opts[key] === undefined ? fallback : Number(opts[key])
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error(`--${key} must be 1–${max}`)
  return n
}
const days = integer('days', 7, 500)
const screenOnly = opts['screen-only'] === 'true'
const stepBlocks = integer('step-blocks', 1200, screenOnly ? 60_000 : 7200)
const maxSamples = integer('max-samples', 1000, 10000)
if (opts['samples-in'] && opts['samples-out'])
  throw new Error('Choose --samples-in OR --samples-out')
const config = loadConfig().find((v) => v.name === 'aave-v3-usde' && v.enabled)
if (!config?.address || !config?.underlying || !config?.variableDebtToken)
  throw new Error('Missing configured Aave USDe reserve')
const POOL = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2'
const erc20 = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'totalSupply',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
]
const component = (name, type) => ({ name, type })
const reserveData = [
  {
    type: 'function',
    name: 'getReserveData',
    stateMutability: 'view',
    inputs: [component('asset', 'address')],
    outputs: [
      {
        type: 'tuple',
        components: [
          component('configuration', 'tuple'),
          component('liquidityIndex', 'uint128'),
          component('currentLiquidityRate', 'uint128'),
          component('variableBorrowIndex', 'uint128'),
          component('currentVariableBorrowRate', 'uint128'),
          component('currentStableBorrowRate', 'uint128'),
          component('lastUpdateTimestamp', 'uint40'),
          component('id', 'uint16'),
          component('aTokenAddress', 'address'),
          component('stableDebtTokenAddress', 'address'),
          component('variableDebtTokenAddress', 'address'),
          component('interestRateStrategyAddress', 'address'),
          component('accruedToTreasury', 'uint128'),
          component('unbacked', 'uint128'),
          component('isolationModeTotalDebt', 'uint128'),
        ],
      },
    ],
  },
]
// The nested configuration map is ABI-encoded as one uint256 word.
reserveData[0].outputs[0].components[0].components = [component('data', 'uint256')]
const lower = (s) => s.toLowerCase()
function assertReserve(data, block) {
  if (
    lower(data.aTokenAddress) !== lower(config.address) ||
    lower(data.variableDebtTokenAddress) !== lower(config.variableDebtToken)
  )
    throw new Error(`Reserve token address mismatch at block ${block}`)
  const bits = BigInt(data.configuration.data)
  return {
    active: Boolean((bits >> 56n) & 1n),
    frozen: Boolean((bits >> 57n) & 1n),
    paused: Boolean((bits >> 60n) & 1n),
  }
}
function atomicJson(path, value) {
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(value))
  renameSync(temp, path)
}
let rows = []
let artifact
if (opts['samples-in']) {
  artifact = JSON.parse(readFileSync(opts['samples-in'], 'utf8'))
  if (
    artifact.study !== 'Aave V3 USDe unencumbered supplier cash-exit runway' ||
    artifact.status !== 'complete' ||
    artifact.chainId !== 1 ||
    artifact.pool?.toLowerCase() !== POOL.toLowerCase() ||
    artifact.underlying?.toLowerCase() !== config.underlying.toLowerCase() ||
    artifact.aToken?.toLowerCase() !== config.address.toLowerCase() ||
    artifact.variableDebtToken?.toLowerCase() !== config.variableDebtToken.toLowerCase()
  )
    throw new Error('Invalid Aave USDe artifact identity or incomplete samples')
  rows = assertSeries(artifact.rows)
} else {
  if (!opts['samples-out'])
    throw new Error('Pass --samples-out to preserve pinned reads before analysis')
  const rpc = opts.rpc || process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')
  if (!rpc) throw new Error('Set RECORDER_RPC_URL or pass --rpc')
  const client = makeClient(rpc)
  const head = opts['end-block']
    ? BigInt(integer('end-block', 0, 100_000_000))
    : (await client.getBlockNumber()) - 64n
  const end = await client.getBlock({ blockNumber: head })
  const cutoff = Number(end.timestamp) - days * DAY
  const maxExpected = Math.ceil((days * DAY) / (12 * stepBlocks)) + 3
  if (maxExpected > maxSamples)
    throw new Error(`Need about ${maxExpected} samples; raise --max-samples`)
  const read = async (block, at) => {
    const result = await client.multicall({
      blockNumber: block,
      allowFailure: false,
      contracts: [
        { address: config.underlying, abi: erc20, functionName: 'decimals' },
        {
          address: config.underlying,
          abi: erc20,
          functionName: 'balanceOf',
          args: [config.address],
        },
        { address: config.variableDebtToken, abi: erc20, functionName: 'totalSupply' },
        {
          address: POOL,
          abi: reserveData,
          functionName: 'getReserveData',
          args: [config.underlying],
        },
      ],
    })
    const [decimals, cashRaw, debtRaw, reserve] = result
    if (decimals !== 18) throw new Error(`Unexpected USDe decimals ${decimals} at ${block}`)
    const flags = assertReserve(reserve, block)
    if (Number(reserve.lastUpdateTimestamp) > at)
      throw new Error(`Future reserve update at ${block}`)
    return {
      block: Number(block),
      at,
      cash: Number(cashRaw) / 1e18,
      debt: Number(debtRaw) / 1e18,
      liquidityRatePct: Number(reserve.currentLiquidityRate) / 1e25,
      borrowRatePct: Number(reserve.currentVariableBorrowRate) / 1e25,
      ...flags,
    }
  }
  const meta = {
    study: 'Aave V3 USDe unencumbered supplier cash-exit runway',
    version: 1,
    chainId: 1,
    pool: POOL,
    underlying: config.underlying,
    aToken: config.address,
    variableDebtToken: config.variableDebtToken,
    days,
    stepBlocks,
    endBlock: Number(head),
    semantics:
      'cash=USDe.balanceOf(aToken); debt=variableDebt.totalSupply; pinned Pool.getReserveData addresses, rates, flags; $1/USDe assumed',
  }
  for (
    let block = head;
    block >= 0n;
    block = block > BigInt(stepBlocks) ? block - BigInt(stepBlocks) : 0n
  ) {
    const header = await client.getBlock({ blockNumber: block })
    const at = Number(header.timestamp)
    if (at < cutoff) break
    rows.push(await read(block, at))
    if (rows.length % 50 === 0)
      atomicJson(opts['samples-out'], { ...meta, status: 'partial', rows: [...rows].reverse() })
    if (rows.length >= maxSamples)
      throw new Error('Reached max samples before full requested history')
  }
  rows.reverse()
  assertSeries(rows)
  artifact = { ...meta, status: 'complete', rows }
  atomicJson(opts['samples-out'], artifact)
}
const result = screenOnly ? null : analyze(rows)
const gaps = rows.slice(1).map((r, i) => r.at - rows[i].at)
const cashSorted = rows.map((r) => r.cash).sort((a, b) => a - b)
const quantile = (p) => cashSorted[Math.floor((cashSorted.length - 1) * p)]
console.log(
  JSON.stringify(
    {
      study: artifact.study,
      sampleCount: rows.length,
      fromBlock: rows[0].block,
      toBlock: rows.at(-1).block,
      fromAt: rows[0].at,
      toAt: rows.at(-1).at,
      maxGapHours: Math.max(...gaps) / 3600,
      minCash: Math.min(...rows.map((r) => r.cash)),
      maxCash: Math.max(...rows.map((r) => r.cash)),
      cashQuantiles: { p10: quantile(0.1), median: quantile(0.5), p90: quantile(0.9) },
      cashAtOrBelow: Object.fromEntries(
        [10_000_000, 50_000_000, 100_000_000].map((q) => [
          q,
          rows.filter((r) => r.cash < q).length,
        ]),
      ),
      minDebt: Math.min(...rows.map((r) => r.debt)),
      maxDebt: Math.max(...rows.map((r) => r.debt)),
      pausedSamples: rows.filter((r) => r.paused).length,
      frozenSamples: rows.filter((r) => r.frozen).length,
      ...(result || {}),
    },
    null,
    2,
  ),
)
