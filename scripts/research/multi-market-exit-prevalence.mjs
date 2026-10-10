// Screening proxy only: pinned cash/supply/withdraw flags are not wallet exits.
// Offline by default. --plan prints calls; --run --out ABS_PATH explicitly enables RPC.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, renameSync, statfsSync, writeFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { artifactPath } from './local-artifacts.mjs'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import { MARKETS as COMETS } from './compound-comet-weekly-screen.mjs'
import { MARKETS as USDS } from './compound-comet-usds-weekly-screen.mjs'
import { GRID as AAVE_GRID, POOL as AAVE_POOL } from './aave-cash-full-grid-collector.mjs'

export const GRID = Object.freeze({ first: AAVE_GRID.first, last: AAVE_GRID.last, step: 1800 })
export const COUNT = (GRID.last - GRID.first) / GRID.step + 1
export const MIN_FREE_BYTES = 2_500_000_000
export const SCENARIOS = Object.freeze([
  { name: 'fixed-1m', kind: 'fixed', q: 1_000_000 },
  { name: 'fixed-10m', kind: 'fixed', q: 10_000_000 },
  { name: 'sensitivity-1pct-supply', kind: 'dynamic-sensitivity' },
])
const USDE = '0x4c9EDD5852cd905f086C759E8383e09bff1E68B3'
const USDC = '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
export const MARKETS = Object.freeze([
  {
    name: 'aave-usde',
    kind: 'aave',
    base: USDE,
    aToken: '0x4F5923Fc5FD4a93352581b38B7cD26943012DECF',
    decimals: 18,
  },
  {
    name: 'aave-usdc',
    kind: 'aave',
    base: USDC,
    aToken: '0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c',
    decimals: 6,
  },
  ...[...COMETS, ...USDS].map((m) => ({ ...m, kind: 'comet' })),
])
const CACHE = Object.freeze([
  'aave-usde-cash-full-grid-400d',
  'compound-comet-usdc-usdt-weekly-400d',
  'compound-comet-usds-weekly-400d',
])
const STUDY = 'five-market-pinned-cash-prevalence-v1'
const lower = (s) => String(s).toLowerCase()
const key = (r) => `${r.market}:${r.block}`
const hash = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex')
const fn = (name, inputs, outputs) => ({
  type: 'function',
  name,
  stateMutability: 'view',
  inputs,
  outputs,
})
const param = (name, type) => ({ name, type })
const tokenAbi = [
  fn('balanceOf', [param('owner', 'address')], [param('', 'uint256')]),
  fn('totalSupply', [], [param('', 'uint256')]),
]
const cometAbi = [
  fn('baseToken', [], [param('', 'address')]),
  fn('isWithdrawPaused', [], [param('', 'bool')]),
  fn('totalSupply', [], [param('', 'uint256')]),
]
const reserveAbi = [
  fn(
    'getReserveData',
    [param('asset', 'address')],
    [
      {
        type: 'tuple',
        components: [
          { name: 'configuration', type: 'tuple', components: [param('data', 'uint256')] },
          ...[
            'liquidityIndex',
            'currentLiquidityRate',
            'variableBorrowIndex',
            'currentVariableBorrowRate',
            'currentStableBorrowRate',
          ].map((name) => param(name, 'uint128')),
          param('lastUpdateTimestamp', 'uint40'),
          param('id', 'uint16'),
          param('aTokenAddress', 'address'),
          param('stableDebtTokenAddress', 'address'),
          param('variableDebtTokenAddress', 'address'),
          param('interestRateStrategyAddress', 'address'),
          param('accruedToTreasury', 'uint128'),
          param('unbacked', 'uint128'),
          param('isolationModeTotalDebt', 'uint128'),
        ],
      },
    ],
  ),
]

export function blocks() {
  return Array.from({ length: COUNT }, (_, i) => GRID.first + i * GRID.step)
}
export function validRow(row) {
  const m = MARKETS.find((x) => x.name === row?.market)
  return Boolean(
    m &&
    Number.isSafeInteger(row.block) &&
    row.block >= GRID.first &&
    row.block <= GRID.last &&
    (row.block - GRID.first) % GRID.step === 0 &&
    Number.isSafeInteger(row.at) &&
    row.at > 0 &&
    lower(row.base) === lower(m.base) &&
    row.decimals === m.decimals &&
    Number.isFinite(row.cashUsdAssumingPeg) &&
    row.cashUsdAssumingPeg >= 0 &&
    (row.supplyUsdAssumingPeg === null ||
      (Number.isFinite(row.supplyUsdAssumingPeg) && row.supplyUsdAssumingPeg >= 0)) &&
    typeof row.withdrawPaused === 'boolean' &&
    typeof row.active === 'boolean' &&
    typeof row.frozen === 'boolean' &&
    ['cache', 'archive'].includes(row.source),
  )
}
export function validateRows(rows) {
  if (!Array.isArray(rows)) throw new Error('Rows must be array')
  const seen = new Set()
  const timestamps = new Map()
  for (const row of rows) {
    if (!validRow(row) || seen.has(key(row))) throw new Error(`Invalid/duplicate row ${key(row)}`)
    if (timestamps.has(row.block) && timestamps.get(row.block) !== row.at)
      throw new Error(`Conflicting exact-block timestamp ${row.block}`)
    timestamps.set(row.block, row.at)
    seen.add(key(row))
  }
  for (const market of MARKETS) {
    const ordered = rows.filter((r) => r.market === market.name).sort((a, b) => a.block - b.block)
    for (let i = 1; i < ordered.length; i++)
      if (ordered[i].at <= ordered[i - 1].at)
        throw new Error(`Nonmonotonic timestamps ${market.name}`)
  }
  return seen
}
function identity() {
  return {
    study: STUDY,
    version: 1,
    chainId: 1,
    grid: GRID,
    markets: MARKETS,
    scenarios: SCENARIOS,
    semantics:
      'Pinned $1-base cash and supply proxy; token decimals are assumed from repo configuration, not historically verified; pause/active separate; no wallet execution claim',
  }
}
export function validateCheckpoint(data) {
  const expected = identity()
  for (const prop of Object.keys(expected))
    if (JSON.stringify(data?.[prop]) !== JSON.stringify(expected[prop]))
      throw new Error(`Checkpoint identity mismatch: ${prop}`)
  validateRows(data.rows)
  if (
    !Array.isArray(data.failures) ||
    !['partial', 'complete'].includes(data.status) ||
    data.rowsSha256 !== hash(data.rows) ||
    data.failuresSha256 !== hash(data.failures)
  )
    throw new Error('Checkpoint corruption/status mismatch')
  const seen = new Set(data.rows.map(key))
  const failed = new Set()
  for (const f of data.failures)
    if (
      !MARKETS.some((m) => m.name === f.market) ||
      !blocks().includes(f.block) ||
      typeof f.error !== 'string' ||
      !f.error ||
      seen.has(key(f)) ||
      failed.has(key(f))
    )
      throw new Error('Invalid failure')
    else failed.add(key(f))
  if (
    (data.status === 'complete') !==
    (data.rows.length === COUNT * MARKETS.length &&
      data.failures.length === 0 &&
      data.rows.every((r) => r.supplyUsdAssumingPeg !== null))
  )
    throw new Error('Incomplete rows marked complete')
  return data
}
export function readCheckpoint(path) {
  return existsSync(path) ? validateCheckpoint(JSON.parse(readFileSync(path, 'utf8'))) : null
}
function atomic(path, value) {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value))
  renameSync(tmp, path)
}
export function snapshot(rows, failures) {
  const sorted = [...rows].sort((a, b) => a.market.localeCompare(b.market) || a.block - b.block)
  const ff = [...failures].sort((a, b) => a.market.localeCompare(b.market) || a.block - b.block)
  return {
    ...identity(),
    status:
      sorted.length === COUNT * MARKETS.length &&
      ff.length === 0 &&
      sorted.every((r) => r.supplyUsdAssumingPeg !== null)
        ? 'complete'
        : 'partial',
    rowsSha256: hash(sorted),
    failuresSha256: hash(ff),
    rows: sorted,
    failures: ff,
  }
}
function cachedRow(source, market, row) {
  if (market.name === 'aave-usde')
    return {
      market: market.name,
      block: row.block,
      at: row.at,
      base: market.base,
      decimals: market.decimals,
      cashUsdAssumingPeg: row.cash,
      supplyUsdAssumingPeg: null,
      withdrawPaused: row.paused,
      active: row.active,
      frozen: row.frozen,
      source,
    }
  return {
    market: market.name,
    block: row.block,
    at: row.at,
    base: market.base,
    decimals: market.decimals,
    cashUsdAssumingPeg: row.cashUsdAssumingPeg,
    supplyUsdAssumingPeg: Number(row.totalSupplyRaw) / 10 ** market.decimals,
    withdrawPaused: row.withdrawPaused,
    active: true,
    frozen: false,
    source,
  }
}
export function loadCache() {
  const artifacts = CACHE.map((name) => ({
    name,
    value: JSON.parse(readFileSync(artifactPath({ name }), 'utf8')),
  }))
  const rows = []
  for (const { name, value } of artifacts) {
    if (value.status !== 'complete' || value.chainId !== 1 || !Array.isArray(value.rows))
      throw new Error(`Incomplete/incorrect cache ${name}`)
    if (
      name === CACHE[0] &&
      (lower(value.pool) !== lower(AAVE_POOL) ||
        lower(value.underlying) !== lower(USDE) ||
        lower(value.aToken) !== lower(MARKETS[0].aToken))
    )
      throw new Error('Aave USDe cache identity mismatch')
    for (const item of value.rows) {
      if ((item.block - GRID.first) % GRID.step !== 0) continue
      const market = name === CACHE[0] ? MARKETS[0] : MARKETS.find((m) => m.name === item.market)
      if (
        !market ||
        lower(name === CACHE[0] ? value.underlying : item.base) !== lower(market.base) ||
        (name !== CACHE[0] && lower(item.comet) !== lower(market.comet))
      )
        throw new Error(`Cache market identity mismatch ${name}`)
      const row = cachedRow('cache', market, item)
      if (!validRow(row)) throw new Error(`Invalid cached row ${name}`)
      rows.push(row)
    }
  }
  validateRows(rows)
  return rows
}
export function mergeRows(prior, cache) {
  const merged = new Map(prior.map((r) => [key(r), r]))
  for (const row of cache) {
    const old = merged.get(key(row))
    if (!old) merged.set(key(row), row)
    else if (
      old.at !== row.at ||
      old.cashUsdAssumingPeg !== row.cashUsdAssumingPeg ||
      old.withdrawPaused !== row.withdrawPaused ||
      old.active !== row.active ||
      old.frozen !== row.frozen ||
      old.base.toLowerCase() !== row.base.toLowerCase() ||
      old.decimals !== row.decimals ||
      (old.supplyUsdAssumingPeg !== null &&
        row.supplyUsdAssumingPeg !== null &&
        old.supplyUsdAssumingPeg !== row.supplyUsdAssumingPeg)
    )
      throw new Error(`Conflicting exact-block cache ${key(row)}`)
  }
  return [...merged.values()]
}
export function plan(rows) {
  validateRows(rows)
  const by = new Map(rows.map((r) => [key(r), r]))
  const markets = Object.fromEntries(
    MARKETS.map((m) => {
      const missing = blocks().filter((block) => !by.has(`${m.name}:${block}`)).length
      const supplyOnly = rows.filter(
        (r) => r.market === m.name && r.supplyUsdAssumingPeg === null,
      ).length
      return [
        m.name,
        {
          expected: COUNT,
          cachedFull: COUNT - missing - supplyOnly,
          cachedPartial: supplyOnly,
          missing,
          rpcRows: missing + supplyOnly,
        },
      ]
    }),
  )
  return {
    grid: GRID,
    markets,
    totalRpcRows: Object.values(markets).reduce((n, m) => n + m.rpcRows, 0),
    approxRpcCalls: Object.values(markets).reduce(
      (n, m) => n + (m.missing * 2 + m.cachedPartial),
      0,
    ),
    caveat:
      'Screening proxy; no network until --run; approximate calls exclude retry/multicall internals.',
  }
}
async function readPinned(client, market, block, prior) {
  const blockNumber = BigInt(block)
  if (prior?.supplyUsdAssumingPeg === null && market.name === 'aave-usde') {
    const supply = await client.readContract({
      address: market.aToken,
      abi: tokenAbi,
      functionName: 'totalSupply',
      blockNumber,
    })
    return {
      ...prior,
      supplyUsdAssumingPeg: Number(supply) / 10 ** market.decimals,
      source: 'archive',
    }
  }
  const at = Number((await client.getBlock({ blockNumber })).timestamp)
  if (market.kind === 'comet') {
    const [base, cash, supply, paused] = await client.multicall({
      blockNumber,
      allowFailure: false,
      contracts: [
        { address: market.comet, abi: cometAbi, functionName: 'baseToken' },
        {
          address: market.base.toLowerCase(),
          abi: tokenAbi,
          functionName: 'balanceOf',
          args: [market.comet],
        },
        { address: market.comet, abi: cometAbi, functionName: 'totalSupply' },
        { address: market.comet, abi: cometAbi, functionName: 'isWithdrawPaused' },
      ],
    })
    if (lower(base) !== lower(market.base)) throw new Error('Comet base identity mismatch')
    return {
      market: market.name,
      block,
      at,
      base: market.base,
      decimals: market.decimals,
      cashUsdAssumingPeg: Number(cash) / 10 ** market.decimals,
      supplyUsdAssumingPeg: Number(supply) / 10 ** market.decimals,
      withdrawPaused: paused,
      active: true,
      frozen: false,
      source: 'archive',
    }
  }
  const reserve = await client.readContract({
    address: AAVE_POOL,
    abi: reserveAbi,
    functionName: 'getReserveData',
    args: [market.base.toLowerCase()],
    blockNumber,
  })
  if (lower(reserve.aTokenAddress) !== lower(market.aToken))
    throw new Error('Historical Aave aToken identity mismatch')
  const [cash, supply] = await client.multicall({
    blockNumber,
    allowFailure: false,
    contracts: [
      {
        address: market.base.toLowerCase(),
        abi: tokenAbi,
        functionName: 'balanceOf',
        args: [market.aToken],
      },
      { address: market.aToken, abi: tokenAbi, functionName: 'totalSupply' },
    ],
  })
  const bits = BigInt(reserve.configuration.data)
  return {
    market: market.name,
    block,
    at,
    base: market.base,
    decimals: market.decimals,
    cashUsdAssumingPeg: Number(cash) / 10 ** market.decimals,
    supplyUsdAssumingPeg: Number(supply) / 10 ** market.decimals,
    withdrawPaused: Boolean((bits >> 60n) & 1n),
    active: Boolean((bits >> 56n) & 1n),
    frozen: Boolean((bits >> 57n) & 1n),
    source: 'archive',
  }
}
function freeBytes(path) {
  const s = statfsSync(path)
  return Number(s.bavail) * Number(s.bsize)
}
export async function collect({ out, rpc, client, maxNew = 0, batchSize = 2 }) {
  if (!isAbsolute(out)) throw new Error('Absolute --out required')
  if (
    !Number.isSafeInteger(maxNew) ||
    maxNew < 1 ||
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 4
  )
    throw new Error('Bounded --max-new >=1 and --batch-size 1..4 required')
  if (freeBytes(out.substring(0, out.lastIndexOf('/')) || '/') < MIN_FREE_BYTES)
    throw new Error('Disk reserve below 2.5GB')
  const prior = readCheckpoint(out)
  const rows = new Map(mergeRows(prior?.rows || [], loadCache()).map((r) => [key(r), r]))
  const failures = new Map((prior?.failures || []).map((f) => [key(f), f]))
  const targets = MARKETS.flatMap((market) =>
    blocks()
      .map((block) => ({ market, block }))
      .filter(
        ({ market, block }) =>
          !rows.has(`${market.name}:${block}`) ||
          rows.get(`${market.name}:${block}`).supplyUsdAssumingPeg === null,
      ),
  ).slice(0, maxNew)
  const connected =
    client || makeClient(rpc || process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL'))
  let state = snapshot([...rows.values()], [...failures.values()])
  atomic(out, state)
  for (let i = 0; i < targets.length; i += batchSize) {
    if (freeBytes(out.substring(0, out.lastIndexOf('/')) || '/') < MIN_FREE_BYTES)
      throw new Error('Disk reserve below 2.5GB')
    const batch = await Promise.all(
      targets.slice(i, i + batchSize).map(async ({ market, block }) => {
        try {
          const row = await readPinned(
            connected,
            market,
            block,
            rows.get(`${market.name}:${block}`),
          )
          if (!validRow(row)) throw new Error('Invalid pinned row')
          return { row }
        } catch (error) {
          return {
            failure: {
              market: market.name,
              block,
              error: String(error?.message || error).slice(0, 300),
            },
          }
        }
      }),
    )
    for (const x of batch) {
      const id = key(x.row || x.failure)
      if (x.row) {
        rows.set(id, x.row)
        failures.delete(id)
      } else failures.set(id, x.failure)
    }
    state = snapshot([...rows.values()], [...failures.values()])
    atomic(out, state)
  }
  return state
}

// Require 24h sustained recovered state and 48h separation before a new onset.
// Gaps >8h censor transitions; initial low state is left-censored.
export function episodes(rows, scenario, outcome = 'cash') {
  if (!['cash', 'pause'].includes(outcome)) throw new Error('Unknown outcome')
  const sorted = [...rows].sort((a, b) => a.at - b.at)
  const events = [],
    excluded = {
      leftCensored: 0,
      gapCensored: 0,
      missingSupply: 0,
      ineligibleAnchor: 0,
      pausedOrInactive: 0,
    }
  let prior = null,
    open = false,
    recoveredAt = null,
    lastOnset = -Infinity
  const low = (r) => {
    const q = threshold(r, scenario)
    return q === null ? null : outcome === 'cash' ? r.cashUsdAssumingPeg < q : r.withdrawPaused
  }
  for (const r of sorted) {
    const bad = low(r)
    if (bad === null) {
      excluded.missingSupply++
      prior = null
      open = false
      recoveredAt = null
      continue
    }
    if (!prior || r.at - prior.at > 8 * 3600) {
      if (prior) excluded.gapCensored++
      if (bad) excluded.leftCensored++
      prior = r
      open = bad
      recoveredAt = null
      continue
    }
    if (open) {
      if (!bad && recoveredAt === null) recoveredAt = r.at
      if (bad) recoveredAt = null
      if (!bad && recoveredAt !== null && r.at - recoveredAt >= 24 * 3600) open = false
    } else if (bad) {
      if (!eligibleAnchor(prior, scenario)) excluded.ineligibleAnchor++
      else if (!r.active || (outcome === 'cash' && r.withdrawPaused)) excluded.pausedOrInactive++
      else if (r.at - lastOnset >= 48 * 3600) {
        events.push({
          market: r.market,
          block: r.block,
          at: r.at,
          cause: outcome,
        })
        lastOnset = r.at
      }
      open = true
      recoveredAt = null
    }
    prior = r
  }
  return { events, excluded }
}
function threshold(r, scenario) {
  if (r.supplyUsdAssumingPeg === null) return null
  return scenario.kind === 'fixed' ? scenario.q : 0.01 * r.supplyUsdAssumingPeg
}
function eligibleAnchor(r, scenario) {
  const q = threshold(r, scenario)
  return (
    q !== null &&
    r.supplyUsdAssumingPeg > 0 &&
    (scenario.kind !== 'fixed' || r.supplyUsdAssumingPeg >= q) &&
    r.cashUsdAssumingPeg >= q &&
    r.active &&
    !r.withdrawPaused
  )
}
export function controls(rows, scenario, events, boundaryAt, outcome = 'cash') {
  if (!['cash', 'pause'].includes(outcome)) throw new Error('Unknown outcome')
  const byBlock = new Map(rows.map((r) => [r.block, r]))
  const dayAnchors = new Map()
  for (const r of [...rows].sort((a, b) => a.at - b.at)) {
    const day = Math.floor(r.at / 86400)
    if (!dayAnchors.has(day)) dayAnchors.set(day, r)
  }
  const totals = {
    observedMarketDays: dayAnchors.size,
    eligibleMarketDays: 0,
    controls: 0,
    trainControls: 0,
    holdoutControls: 0,
    unscorable: {
      missingForward: 0,
      insufficientSupplyOrCash: 0,
      pausedOrInactive: 0,
      forwardGap: 0,
      boundaryPurge: 0,
      boundaryUnavailable: 0,
      eventAdjacent: 0,
      forwardDeterioration: 0,
    },
  }
  for (const r of dayAnchors.values()) {
    if (
      r.supplyUsdAssumingPeg === null ||
      r.supplyUsdAssumingPeg <= 0 ||
      (scenario.kind === 'fixed' && r.supplyUsdAssumingPeg < scenario.q) ||
      r.cashUsdAssumingPeg < threshold(r, scenario)
    ) {
      totals.unscorable.insufficientSupplyOrCash++
      continue
    }
    if (!r.active || r.withdrawPaused) {
      totals.unscorable.pausedOrInactive++
      continue
    }
    const future = []
    let previous = r,
      incomplete = null
    for (let n = 1; previous.at - r.at < 24 * 3600; n++) {
      const next = byBlock.get(r.block + n * GRID.step)
      if (!next) {
        incomplete = 'missingForward'
        break
      }
      if (next.at <= previous.at || next.at - previous.at > 8 * 3600) {
        incomplete = 'forwardGap'
        break
      }
      future.push(next)
      previous = next
    }
    if (incomplete) {
      totals.unscorable[incomplete]++
      continue
    }
    if (boundaryAt === null) {
      totals.unscorable.boundaryUnavailable++
      continue
    }
    if (
      Math.abs(r.at - boundaryAt) <= 24 * 3600 ||
      future.some((x) => Math.abs(x.at - boundaryAt) <= 24 * 3600)
    ) {
      totals.unscorable.boundaryPurge++
      continue
    }
    totals.eligibleMarketDays++
    if (
      events.some(
        (e) => Math.abs(e.at - r.at) < 48 * 3600 || (e.at > r.at && e.at <= future.at(-1).at),
      )
    ) {
      totals.unscorable.eventAdjacent++
      continue
    }
    if (
      future
        .filter((x) => x.at - r.at <= 24 * 3600)
        .some(
          (x) =>
            !x.active ||
            x.withdrawPaused ||
            threshold(x, scenario) === null ||
            x.cashUsdAssumingPeg < threshold(x, scenario),
        )
    ) {
      totals.unscorable.forwardDeterioration++
      continue
    }
    totals.controls++
    if (r.at < boundaryAt) totals.trainControls++
    else totals.holdoutControls++
  }
  return totals
}
export function score(rows) {
  validateRows(rows)
  const boundaryBlock = GRID.first + Math.floor(COUNT * 0.7) * GRID.step
  const boundaryAt = rows.find((r) => r.block === boundaryBlock)?.at ?? null
  const result = {
    status:
      rows.length === COUNT * MARKETS.length && rows.every((r) => r.supplyUsdAssumingPeg !== null)
        ? 'complete'
        : 'partial',
    markets: {},
    pooledIndependentEpisodes: null,
    caveat:
      'Observed pinned cash/pauses, not executable wallet withdrawal. Partial/gapped histories cannot establish prevalence or validation.',
  }
  for (const market of MARKETS) {
    const arr = rows.filter((r) => r.market === market.name).sort((a, b) => a.block - b.block)
    const part = {
      expected: COUNT,
      present: arr.length,
      missing: COUNT - arr.length,
      withSupply: arr.filter((r) => r.supplyUsdAssumingPeg !== null).length,
      pausedSamples: arr.filter((r) => r.withdrawPaused).length,
      inactiveSamples: arr.filter((r) => !r.active).length,
      scenarios: {},
    }
    for (const scenario of SCENARIOS) {
      part.scenarios[scenario.name] = {}
      const byOutcome = Object.fromEntries(
        ['cash', 'pause'].map((outcome) => [outcome, episodes(arr, scenario, outcome)]),
      )
      const allEvents = [...byOutcome.cash.events, ...byOutcome.pause.events]
      for (const outcome of ['cash', 'pause']) {
        const by = byOutcome[outcome]
        const kept =
          boundaryAt === null
            ? []
            : by.events.filter((e) => Math.abs(e.at - boundaryAt) > 24 * 3600)
        part.scenarios[scenario.name][outcome] = {
          observedEpisodes: kept.length,
          train: kept.filter((e) => e.at < boundaryAt).length,
          holdout: kept.filter((e) => e.at >= boundaryAt).length,
          purged: by.events.length - kept.length,
          excluded: by.excluded,
          denominator: controls(arr, scenario, allEvents, boundaryAt, outcome),
          events: kept,
        }
      }
    }
    result.markets[market.name] = part
  }
  return result
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2),
    opts = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (['--plan', '--offline', '--run', '--verify'].includes(a)) opts[a.slice(2)] = true
    else if (a.startsWith('--') && args[i + 1] !== undefined) opts[a.slice(2)] = args[++i]
    else throw new Error(`Unknown/incomplete option ${a}`)
  }
  const actions = ['plan', 'offline', 'run', 'verify'].filter((a) => opts[a])
  if (actions.length !== 1) throw new Error('Choose one: --plan | --offline | --verify | --run')
  const source = opts.out && readCheckpoint(opts.out)
  if (opts.verify) {
    if (!opts.out || !source) throw new Error('--verify needs existing --out')
    console.log(
      JSON.stringify({
        status: source.status,
        rows: source.rows.length,
        rowsSha256: source.rowsSha256,
        score: score(source.rows),
      }),
    )
  } else if (opts.plan) {
    const rows = mergeRows(source?.rows || [], loadCache())
    console.log(JSON.stringify(plan(rows)))
  } else if (opts.offline) {
    const rows = mergeRows(source?.rows || [], loadCache())
    console.log(JSON.stringify({ plan: plan(rows), score: score(rows) }))
  } else {
    if (!opts.out) throw new Error('--run needs --out ABS_PATH')
    const data = await collect({
      out: opts.out,
      rpc: opts.rpc,
      maxNew: Number(opts['max-new'] || 0),
      batchSize: Number(opts['batch-size'] || 2),
    })
    console.log(
      JSON.stringify({
        plan: plan(data.rows),
        score: score(data.rows),
        failures: data.failures.length,
      }),
    )
  }
}
