// Frozen, read-only eight-reserve Aave V3 Ethereum prevalence expansion.
// No RPC is used except with --run --max-new N. Cash is a necessary proxy,
// never evidence that a particular holder's withdrawal would execute.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, renameSync, statfsSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import { episodes, controls, GRID, COUNT, SCENARIOS } from './multi-market-exit-prevalence.mjs'

export { GRID, COUNT, SCENARIOS }
export const POOL = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2'
export const MIN_FREE_BYTES = 2_500_000_000
export const MARKETS = Object.freeze(
  [
    [
      'DAI',
      '0x6B175474E89094C44Da98b954EedeAC495271d0F',
      '0x018008bfb33d285247A21d44E50697654f754e63',
      18,
    ],
    [
      'USDT',
      '0xdAC17F958D2ee523a2206206994597C13D831ec7',
      '0x23878914EFE38d27C4D67Ab83ed1b93A74D4086a',
      6,
    ],
    [
      'FRAX',
      '0x853d955aCEf822Db058eb8505911ED77F175b99e',
      '0xd4e245848d6E1220DBE62e155d89fa327E43CB06',
      18,
    ],
    [
      'USDS',
      '0xdC035D45d973E3EC169d2276DDab16f1e407384F',
      '0x32a6268f9Ba3642Dda7892aDd74f1D34469A4259',
      18,
    ],
    [
      'LUSD',
      '0x5f98805A4E8be255a32880FDeC7F6728C6568bA0',
      '0x3Fe6a295459FAe07DF8A0ceCC36F37160FE86AA9',
      18,
    ],
    [
      'crvUSD',
      '0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E',
      '0xb82fa9f31612989525992FCfBB09AB22Eff5c85A',
      18,
    ],
    [
      'PYUSD',
      '0x6c3ea9036406852006290770BEdFcAbA0e23A0e8',
      '0x0C0d01AbF3e6aDfcA0989eBbA9d6e85dD58EaB1E',
      6,
    ],
    [
      'RLUSD',
      '0x8292Bb45bf1Ee4d140127049757C2E0fF06317eD',
      '0xFa82580c16A31D0c1bC632A36F82e83EfEF3Eec0',
      18,
    ],
  ].map(([name, base, aToken, decimals]) => Object.freeze({ name, base, aToken, decimals })),
)
const STUDY = 'aave-v3-eight-stable-reserve-expansion-v1'
const ZERO = '0x0000000000000000000000000000000000000000'
const lower = (x) => String(x).toLowerCase()
const id = (x) => `${x.market}:${x.block}`
const digest = (x) => createHash('sha256').update(JSON.stringify(x)).digest('hex')
const field = (name, type) => ({ name, type })
const fn = (name, inputs, outputs) => ({
  type: 'function',
  name,
  stateMutability: 'view',
  inputs,
  outputs,
})
const tokenAbi = [
  fn('balanceOf', [field('owner', 'address')], [field('', 'uint256')]),
  fn('totalSupply', [], [field('', 'uint256')]),
]
const reserveAbi = [
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
]

export function blocks() {
  return Array.from({ length: COUNT }, (_, i) => GRID.first + i * GRID.step)
}
function identity() {
  return {
    study: STUDY,
    version: 2,
    chainId: 1,
    pool: POOL,
    grid: GRID,
    markets: MARKETS,
    scenarios: SCENARIOS,
    nominalDollarPegAssumption: true,
    semantics:
      'Pinned underlying.balanceOf(aToken), aToken.totalSupply, Pool.getReserveData identity/flags/historical reserve decimals; nominal $1/stable; no wallet execution claim',
  }
}
export function classifyReserve(market, reserve) {
  const actual = lower(reserve?.aTokenAddress)
  if (actual === lower(ZERO))
    return { kind: 'ineligible', reason: 'prelisting', actualAToken: actual }
  if (actual !== lower(market.aToken))
    return {
      kind: 'ineligible',
      reason: 'historical-atoken-identity-mismatch',
      actualAToken: actual,
    }
  return { kind: 'listed' }
}
function onGrid(row) {
  return (
    Number.isSafeInteger(row?.block) &&
    row.block >= GRID.first &&
    row.block <= GRID.last &&
    (row.block - GRID.first) % GRID.step === 0
  )
}
export function validEntry(row) {
  const m = MARKETS.find((x) => x.name === row?.market)
  if (
    !m ||
    !onGrid(row) ||
    !Number.isSafeInteger(row.at) ||
    row.at <= 0 ||
    !/^0x[0-9a-fA-F]{64}$/.test(row.blockHash || '') ||
    lower(row.base) !== lower(m.base) ||
    row.decimals !== m.decimals ||
    !['observed', 'ineligible'].includes(row.kind)
  )
    return false
  if (row.kind === 'ineligible')
    return (
      ['prelisting', 'historical-atoken-identity-mismatch'].includes(row.reason) &&
      /^0x[0-9a-fA-F]{40}$/.test(row.actualAToken || '') &&
      (row.reason !== 'prelisting' || lower(row.actualAToken) === lower(ZERO)) &&
      (row.reason !== 'historical-atoken-identity-mismatch' ||
        (lower(row.actualAToken) !== lower(ZERO) && lower(row.actualAToken) !== lower(m.aToken)))
    )
  return (
    lower(row.actualAToken) === lower(m.aToken) &&
    row.reserveDecimals === m.decimals &&
    Number.isFinite(row.cashUsdAssumingPeg) &&
    row.cashUsdAssumingPeg >= 0 &&
    Number.isFinite(row.supplyUsdAssumingPeg) &&
    row.supplyUsdAssumingPeg >= 0 &&
    ['withdrawPaused', 'active', 'frozen'].every((k) => typeof row[k] === 'boolean')
  )
}
export function validateCheckpoint(data) {
  for (const [k, v] of Object.entries(identity()))
    if (JSON.stringify(data?.[k]) !== JSON.stringify(v))
      throw new Error(`Checkpoint identity mismatch: ${k}`)
  if (
    !['partial', 'complete'].includes(data.status) ||
    !Array.isArray(data.entries) ||
    !Array.isArray(data.failures) ||
    data.entriesSha256 !== digest(data.entries) ||
    data.failuresSha256 !== digest(data.failures)
  )
    throw new Error('Checkpoint corruption/status mismatch')
  const seen = new Set(),
    byBlock = new Map()
  for (const e of data.entries) {
    if (!validEntry(e) || seen.has(id(e))) throw new Error(`Invalid/duplicate entry ${id(e)}`)
    if (
      byBlock.has(e.block) &&
      (byBlock.get(e.block).at !== e.at ||
        lower(byBlock.get(e.block).blockHash) !== lower(e.blockHash))
    )
      throw new Error(`Contradictory block header ${e.block}`)
    seen.add(id(e))
    byBlock.set(e.block, e)
  }
  for (const m of MARKETS) {
    const a = data.entries.filter((e) => e.market === m.name).sort((x, y) => x.block - y.block)
    for (let i = 1; i < a.length; i++)
      if (a[i].at <= a[i - 1].at) throw new Error(`Nonmonotonic timestamps ${m.name}`)
  }
  const failed = new Set()
  for (const f of data.failures) {
    if (
      !MARKETS.some((m) => m.name === f.market) ||
      !onGrid(f) ||
      typeof f.error !== 'string' ||
      !f.error ||
      seen.has(id(f)) ||
      failed.has(id(f))
    )
      throw new Error(`Invalid failure ${id(f)}`)
    failed.add(id(f))
  }
  if (
    (data.status === 'complete') !==
    (data.entries.length === COUNT * MARKETS.length && data.failures.length === 0)
  )
    throw new Error('Unresolved coverage marked complete')
  return data
}
export function snapshot(entries, failures) {
  const a = [...entries].sort((x, y) => x.market.localeCompare(y.market) || x.block - y.block)
  const f = [...failures].sort((x, y) => x.market.localeCompare(y.market) || x.block - y.block)
  return validateCheckpoint({
    ...identity(),
    status: a.length === COUNT * MARKETS.length && !f.length ? 'complete' : 'partial',
    entriesSha256: digest(a),
    failuresSha256: digest(f),
    entries: a,
    failures: f,
  })
}
export function readCheckpoint(path) {
  return existsSync(path) ? validateCheckpoint(JSON.parse(readFileSync(path, 'utf8'))) : null
}
function atomic(path, value) {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value))
  renameSync(tmp, path)
}
function freeBytes(path) {
  const s = statfsSync(path)
  return Number(s.bavail) * Number(s.bsize)
}
export function plan(data = null) {
  const done = new Set((data?.entries || []).map(id))
  const perMarket = Object.fromEntries(
    MARKETS.map((m) => [
      m.name,
      {
        expected: COUNT,
        observed: (data?.entries || []).filter((e) => e.market === m.name && e.kind === 'observed')
          .length,
        ineligible: (data?.entries || []).filter(
          (e) => e.market === m.name && e.kind === 'ineligible',
        ).length,
        unresolved: COUNT - (data?.entries || []).filter((e) => e.market === m.name).length,
      },
    ]),
  )
  return {
    grid: GRID,
    boundaryBlock: GRID.first + Math.floor(COUNT * 0.7) * GRID.step,
    perMarket,
    unresolved: COUNT * MARKETS.length - done.size,
    caveat: 'No network in --plan/--verify; --run requires a bounded --max-new and 2.5GB free.',
  }
}
export async function readPinned(client, market, block) {
  const blockNumber = BigInt(block)
  const header = await client.getBlock({ blockNumber })
  const common = {
    market: market.name,
    block,
    at: Number(header.timestamp),
    blockHash: header.hash,
    base: market.base,
    decimals: market.decimals,
  }
  const reserve = await client.readContract({
    address: POOL,
    abi: reserveAbi,
    functionName: 'getReserveData',
    args: [market.base.toLowerCase()],
    blockNumber,
  })
  const classified = classifyReserve(market, reserve)
  if (classified.kind === 'ineligible') return { ...common, ...classified }
  const bits = BigInt(reserve.configuration.data)
  if (Number((bits >> 48n) & 255n) !== market.decimals)
    throw new Error('Historical reserve decimals mismatch')
  const [cash, supply] = await client.multicall({
    blockNumber,
    allowFailure: false,
    contracts: [
      {
        address: market.base.toLowerCase(),
        abi: tokenAbi,
        functionName: 'balanceOf',
        args: [market.aToken.toLowerCase()],
      },
      { address: market.aToken.toLowerCase(), abi: tokenAbi, functionName: 'totalSupply' },
    ],
  })
  if (Number(reserve.lastUpdateTimestamp) > common.at)
    throw new Error('Future reserve update timestamp')
  return {
    ...common,
    kind: 'observed',
    actualAToken: lower(reserve.aTokenAddress),
    reserveDecimals: Number((bits >> 48n) & 255n),
    cashUsdAssumingPeg: Number(cash) / 10 ** market.decimals,
    supplyUsdAssumingPeg: Number(supply) / 10 ** market.decimals,
    withdrawPaused: Boolean((bits >> 60n) & 1n),
    active: Boolean((bits >> 56n) & 1n),
    frozen: Boolean((bits >> 57n) & 1n),
  }
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function attempt(client, market, block) {
  for (let n = 1; n <= 3; n++) {
    try {
      const entry = await readPinned(client, market, block)
      if (!validEntry(entry)) throw new Error('Invalid pinned entry')
      return { entry }
    } catch (e) {
      if (n === 3)
        return {
          failure: { market: market.name, block, error: String(e?.message || e).slice(0, 300) },
        }
      await delay(n * 500)
    }
  }
}
export async function collect({ out, rpc, client, maxNew, batchSize = 2 }) {
  if (!isAbsolute(out)) throw new Error('Absolute --out required')
  if (
    !Number.isSafeInteger(maxNew) ||
    maxNew < 1 ||
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 3
  )
    throw new Error('Bounded --max-new >=1, --batch-size 1..3 required')
  if (freeBytes(dirname(out)) < MIN_FREE_BYTES) throw new Error('Disk reserve below 2.5GB')
  const old = readCheckpoint(out)
  const entries = new Map((old?.entries || []).map((e) => [id(e), e]))
  const failures = new Map((old?.failures || []).map((e) => [id(e), e]))
  const pending = MARKETS.flatMap((market) =>
    blocks()
      .filter((block) => !entries.has(`${market.name}:${block}`))
      .map((block) => ({ market, block })),
  ).slice(0, maxNew)
  // Avoid an RPC client altogether if this bounded slice is already complete.
  const connected = pending.length
    ? client || makeClient(rpc || process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL'))
    : null
  let state = snapshot([...entries.values()], [...failures.values()])
  atomic(out, state)
  for (let i = 0; i < pending.length; i += batchSize) {
    if (freeBytes(dirname(out)) < MIN_FREE_BYTES) throw new Error('Disk reserve below 2.5GB')
    const batch = await Promise.all(
      pending.slice(i, i + batchSize).map(({ market, block }) => attempt(connected, market, block)),
    )
    for (const item of batch) {
      if (item.entry) {
        entries.set(id(item.entry), item.entry)
        failures.delete(id(item.entry))
      } else failures.set(id(item.failure), item.failure)
    }
    state = snapshot([...entries.values()], [...failures.values()])
    atomic(out, state)
  }
  return state
}

export function score(data) {
  validateCheckpoint(data)
  const boundaryBlock = GRID.first + Math.floor(COUNT * 0.7) * GRID.step
  const boundaryAt = data.entries.find((e) => e.block === boundaryBlock)?.at ?? null
  const result = {
    status: data.status,
    boundaryBlock,
    boundaryAt,
    markets: {},
    pooledIndependentEpisodes: null,
    caveat:
      'Pinned cash/permission proxy only. Prelisting and identity mismatch censor transitions; no executable wallet outcome claim.',
  }
  for (const market of MARKETS) {
    const all = data.entries
      .filter((e) => e.market === market.name)
      .sort((a, b) => a.block - b.block)
    const observed = all.filter((e) => e.kind === 'observed')
    const part = {
      expected: COUNT,
      present: all.length,
      missing: COUNT - all.length,
      prelisting: all.filter((e) => e.reason === 'prelisting').length,
      identityMismatch: all.filter((e) => e.reason === 'historical-atoken-identity-mismatch')
        .length,
      observed: observed.length,
      pausedSamples: observed.filter((e) => e.withdrawPaused).length,
      inactiveSamples: observed.filter((e) => !e.active).length,
      scenarios: {},
    }
    for (const scenario of SCENARIOS) {
      const by = Object.fromEntries(
        ['cash', 'pause'].map((type) => [type, episodes(observed, scenario, type)]),
      )
      const allEvents = [...by.cash.events, ...by.pause.events]
      part.scenarios[scenario.name] = Object.fromEntries(
        ['cash', 'pause'].map((type) => {
          const events =
            boundaryAt === null
              ? []
              : by[type].events.filter((e) => Math.abs(e.at - boundaryAt) > 86400)
          return [
            type,
            {
              observedEpisodes: events.length,
              train: events.filter((e) => e.at < boundaryAt).length,
              holdout: events.filter((e) => e.at > boundaryAt).length,
              purged: by[type].events.length - events.length,
              excluded: by[type].excluded,
              denominator: controls(observed, scenario, allEvents, boundaryAt, type),
              events,
            },
          ]
        }),
      )
    }
    result.markets[market.name] = part
  }
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2),
    opts = {}
  for (let i = 0; i < argv.length; i++) {
    if (['--plan', '--run', '--verify'].includes(argv[i])) opts[argv[i].slice(2)] = true
    else if (argv[i].startsWith('--') && argv[i + 1] !== undefined)
      opts[argv[i].slice(2)] = argv[++i]
    else throw new Error(`Unknown/incomplete argument ${argv[i]}`)
  }
  const modes = ['plan', 'run', 'verify'].filter((x) => opts[x])
  if (modes.length !== 1) throw new Error('Choose --plan | --run | --verify')
  if (opts.verify && (!opts.out || !readCheckpoint(opts.out)))
    throw new Error('--verify needs existing --out')
  if (opts.run && (!opts.out || opts['max-new'] === undefined))
    throw new Error('--run needs --out ABS_PATH and --max-new COUNT')
  const data = opts.run
    ? await collect({
        out: opts.out,
        rpc: opts.rpc,
        maxNew: Number(opts['max-new']),
        batchSize: opts['batch-size'] === undefined ? 2 : Number(opts['batch-size']),
      })
    : opts.out
      ? readCheckpoint(opts.out)
      : null
  console.log(
    JSON.stringify({
      plan: plan(data),
      ...(opts.verify || opts.run ? { score: score(data) } : {}),
      ...(data
        ? {
            entriesSha256: data.entriesSha256,
            failuresSha256: data.failuresSha256,
            status: data.status,
            failures: data.failures.length,
          }
        : {}),
    }),
  )
}
