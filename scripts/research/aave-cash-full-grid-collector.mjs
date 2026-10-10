// Read-only, resumable 400-day Aave USDe cash grid. No outcome analysis here.
// node scripts/research/aave-cash-full-grid-collector.mjs --out /private/tmp/aave-usde-cash-full-grid-400d-20260925.json
import { readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { artifactPath } from './local-artifacts.mjs'
import { loadConfig, makeClient, readEnv } from '../lib/venue-reads.mjs'

export const GRID = Object.freeze({ first: 23_229_806, last: 26_052_206, step: 900 })
export const EXPECTED = (GRID.last - GRID.first) / GRID.step + 1
export const MAX_GAP_SECONDS = 4 * 3600
export const POOL = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2'
export const SOURCES = ['aave-usde-cash-mar-jun-2026', 'aave-usde-cash-sparse-400d']
const STUDY = 'Aave V3 USDe full 400d pinned cash grid'
const CONFIG = loadConfig().find((v) => v.name === 'aave-v3-usde' && v.enabled)
if (!CONFIG?.address || !CONFIG?.underlying || !CONFIG?.variableDebtToken)
  throw new Error('Missing configured Aave USDe reserve')
const addr = (value) => value?.toLowerCase()
const field = (name, type) => ({ name, type })
const erc20 = [
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [field('', 'uint8')],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [field('', 'address')],
    outputs: [field('', 'uint256')],
  },
  {
    type: 'function',
    name: 'totalSupply',
    stateMutability: 'view',
    inputs: [],
    outputs: [field('', 'uint256')],
  },
]
const reserveData = [
  {
    type: 'function',
    name: 'getReserveData',
    stateMutability: 'view',
    inputs: [field('asset', 'address')],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'configuration', type: 'tuple', components: [field('data', 'uint256')] },
          field('liquidityIndex', 'uint128'),
          field('currentLiquidityRate', 'uint128'),
          field('variableBorrowIndex', 'uint128'),
          field('currentVariableBorrowRate', 'uint128'),
          field('currentStableBorrowRate', 'uint128'),
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
  },
]

export function blocks() {
  return Array.from({ length: EXPECTED }, (_, i) => GRID.first + i * GRID.step)
}

export function validRow(row) {
  return (
    Number.isSafeInteger(row?.block) &&
    row.block >= GRID.first &&
    row.block <= GRID.last &&
    (row.block - GRID.first) % GRID.step === 0 &&
    Number.isSafeInteger(row.at) &&
    row.at > 0 &&
    ['cash', 'debt', 'liquidityRatePct', 'borrowRatePct'].every(
      (key) => Number.isFinite(row[key]) && row[key] >= 0,
    ) &&
    ['active', 'frozen', 'paused'].every((key) => typeof row[key] === 'boolean')
  )
}

export function coverage(rows) {
  const sorted = [...rows].sort((a, b) => a.block - b.block)
  const seen = new Set()
  let maximum = 0
  for (let i = 0; i < sorted.length; i++) {
    const row = sorted[i]
    if (!validRow(row) || seen.has(row.block))
      throw new Error(`Invalid or duplicate block ${row.block}`)
    seen.add(row.block)
    if (i > 0) {
      const seconds = row.at - sorted[i - 1].at
      if (seconds <= 0) throw new Error('Nonmonotonic block timestamps')
      maximum = Math.max(maximum, seconds)
    }
  }
  const missing = blocks().filter((block) => !seen.has(block))
  return {
    expected: EXPECTED,
    present: sorted.length,
    missing: missing.length,
    maxGapSeconds: maximum,
    firstBlock: sorted[0]?.block ?? null,
    lastBlock: sorted.at(-1)?.block ?? null,
    complete: missing.length === 0 && sorted.length === EXPECTED && maximum <= MAX_GAP_SECONDS,
  }
}

export function mergeCached(existing, catalog) {
  const byBlock = new Map(existing.map((row) => [row.block, row]))
  const provenance = {}
  for (const { name, rows } of catalog) {
    let reused = 0
    for (const row of rows) {
      if (!validRow(row)) throw new Error(`Invalid cached row from ${name}`)
      if (!byBlock.has(row.block)) {
        byBlock.set(row.block, { ...row, source: name })
        reused++
      } else {
        const other = byBlock.get(row.block)
        if (JSON.stringify(coreFields(other)) !== JSON.stringify(coreFields(row)))
          throw new Error(`Conflicting exact-block rows at ${row.block}`)
      }
    }
    provenance[name] = reused
  }
  return { rows: [...byBlock.values()].sort((a, b) => a.block - b.block), provenance }
}

function coreFields(row) {
  const { block, at, cash, debt, liquidityRatePct, borrowRatePct, active, frozen, paused } = row
  return { block, at, cash, debt, liquidityRatePct, borrowRatePct, active, frozen, paused }
}

function loadCached() {
  return SOURCES.map((name) => {
    // artifactPath verifies the full SHA-256 and schema before any reuse.
    const artifact = JSON.parse(readFileSync(artifactPath({ name }), 'utf8'))
    if (
      artifact.study !== 'Aave V3 USDe unencumbered supplier cash-exit runway' ||
      artifact.status !== 'complete' ||
      artifact.chainId !== 1 ||
      addr(artifact.pool) !== addr(POOL) ||
      addr(artifact.underlying) !== addr(CONFIG.underlying) ||
      addr(artifact.aToken) !== addr(CONFIG.address) ||
      addr(artifact.variableDebtToken) !== addr(CONFIG.variableDebtToken)
    )
      throw new Error(`Cached artifact identity mismatch: ${name}`)
    return { name, rows: artifact.rows }
  })
}

function identity() {
  return {
    study: STUDY,
    version: 1,
    chainId: 1,
    pool: POOL,
    underlying: CONFIG.underlying,
    aToken: CONFIG.address,
    variableDebtToken: CONFIG.variableDebtToken,
    grid: GRID,
    semantics:
      'cash=USDe.balanceOf(aToken); debt=variableDebt.totalSupply; pinned Pool.getReserveData rates, flags and token identities; $1/USDe assumed',
  }
}

function checkedResume(path) {
  if (!existsSync(path)) return { rows: [], failures: [] }
  const value = JSON.parse(readFileSync(path, 'utf8'))
  const expected = identity()
  for (const key of [
    'study',
    'version',
    'chainId',
    'pool',
    'underlying',
    'aToken',
    'variableDebtToken',
  ])
    if (addr(String(value[key])) !== addr(String(expected[key])))
      throw new Error(`Resume identity mismatch: ${key}`)
  if (
    JSON.stringify(value.grid) !== JSON.stringify(GRID) ||
    !['partial', 'complete'].includes(value.status) ||
    !Array.isArray(value.rows) ||
    !Array.isArray(value.failures)
  )
    throw new Error('Malformed resume artifact')
  coverage(value.rows)
  return value
}

function atomic(path, object) {
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(object))
  renameSync(temp, path)
}

function flags(reserve, block, at) {
  if (
    addr(reserve.aTokenAddress) !== addr(CONFIG.address) ||
    addr(reserve.variableDebtTokenAddress) !== addr(CONFIG.variableDebtToken)
  )
    throw new Error(`Reserve token address mismatch at ${block}`)
  if (Number(reserve.lastUpdateTimestamp) > at) throw new Error(`Future reserve update at ${block}`)
  const bits = BigInt(reserve.configuration.data)
  return {
    active: Boolean((bits >> 56n) & 1n),
    frozen: Boolean((bits >> 57n) & 1n),
    paused: Boolean((bits >> 60n) & 1n),
  }
}

async function readPinned(client, block) {
  const blockNumber = BigInt(block)
  const header = await client.getBlock({ blockNumber })
  const at = Number(header.timestamp)
  const [decimals, cashRaw, debtRaw, reserve] = await client.multicall({
    blockNumber,
    allowFailure: false,
    contracts: [
      { address: CONFIG.underlying, abi: erc20, functionName: 'decimals' },
      { address: CONFIG.underlying, abi: erc20, functionName: 'balanceOf', args: [CONFIG.address] },
      { address: CONFIG.variableDebtToken, abi: erc20, functionName: 'totalSupply' },
      {
        address: POOL,
        abi: reserveData,
        functionName: 'getReserveData',
        args: [CONFIG.underlying],
      },
    ],
  })
  if (decimals !== 18) throw new Error(`Unexpected USDe decimals ${decimals} at ${block}`)
  const row = {
    block,
    at,
    cash: Number(cashRaw) / 1e18,
    debt: Number(debtRaw) / 1e18,
    liquidityRatePct: Number(reserve.currentLiquidityRate) / 1e25,
    borrowRatePct: Number(reserve.currentVariableBorrowRate) / 1e25,
    ...flags(reserve, block, at),
    source: 'archive-read',
  }
  if (!validRow(row)) throw new Error(`Invalid archive row at ${block}`)
  return row
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function readWithRetry(client, block) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return { block, row: await readPinned(client, block) }
    } catch (error) {
      if (attempt === 3) return { block, failure: String(error?.message || error).slice(0, 500) }
      await delay(attempt * 1000)
    }
  }
}

export async function collect({
  out,
  maxNew = Infinity,
  rpc,
  client: injectedClient,
  batchSize = 4,
}) {
  if (!out || !out.startsWith('/')) throw new Error('--out must be an absolute path')
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 16)
    throw new Error('batchSize must be 1–16')
  if (maxNew !== Infinity && (!Number.isSafeInteger(maxNew) || maxNew < 0))
    throw new Error('maxNew must be a nonnegative integer')
  const prior = checkedResume(out)
  const { rows, provenance } = mergeCached(prior.rows, loadCached())
  const rowMap = new Map(rows.map((row) => [row.block, row]))
  const pending = blocks().filter((block) => !rowMap.has(block))
  const selected = pending.slice(0, maxNew)
  const failures = new Map(prior.failures.map((failure) => [failure.block, failure]))
  const client = selected.length
    ? injectedClient ||
      makeClient(rpc || process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL'))
    : null
  if (selected.length && !client) throw new Error('Archive RPC unavailable')
  const save = () => {
    const current = [...rowMap.values()].sort((a, b) => a.block - b.block)
    const state = coverage(current)
    const object = {
      ...identity(),
      status: state.complete && failures.size === 0 ? 'complete' : 'partial',
      provenance: {
        verifiedCatalogSources: SOURCES,
        reusedThisRun: provenance,
        catalogRowCounts: Object.fromEntries(
          SOURCES.map((name) => [name, current.filter((row) => row.source === name).length]),
        ),
        cachedRows: current.filter((row) => SOURCES.includes(row.source)).length,
        archiveRows: current.filter((row) => row.source === 'archive-read').length,
      },
      coverage: state,
      failedReadCount: failures.size,
      failures: [...failures.values()].sort((a, b) => a.block - b.block),
      rows: current,
    }
    atomic(out, object)
    return object
  }
  // Persist SHA-verified reuse before archive calls; an interrupted run resumes from here.
  let result = save()
  for (let i = 0; i < selected.length; i += batchSize) {
    const batch = await Promise.all(
      selected.slice(i, i + batchSize).map((block) => readWithRetry(client, block)),
    )
    for (const item of batch) {
      if (item.row) {
        rowMap.set(item.block, item.row)
        failures.delete(item.block)
      } else failures.set(item.block, { block: item.block, error: item.failure })
    }
    result = save()
    if ((i / batchSize) % 20 === 0 || i + batchSize >= selected.length)
      console.error(
        JSON.stringify({
          progress: Math.min(i + batchSize, selected.length),
          selected: selected.length,
          present: result.coverage.present,
          missing: result.coverage.missing,
          failures: result.failedReadCount,
        }),
      )
  }
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const options = {}
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith('--') || args[i + 1] === undefined)
      throw new Error(
        'Usage: --out ABSOLUTE_PATH [--max-new COUNT] [--rpc URL] [--batch-size COUNT]',
      )
    options[args[i].slice(2)] = args[i + 1]
  }
  const maxNew = options['max-new'] === undefined ? Infinity : Number(options['max-new'])
  const batchSize = options['batch-size'] === undefined ? 4 : Number(options['batch-size'])
  const result = await collect({ out: options.out, maxNew, batchSize, rpc: options.rpc })
  console.log(
    JSON.stringify({
      status: result.status,
      coverage: result.coverage,
      provenance: result.provenance,
      failedReadCount: result.failedReadCount,
    }),
  )
}
