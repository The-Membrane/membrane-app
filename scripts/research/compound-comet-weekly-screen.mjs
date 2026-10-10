// Read-only Compound III prevalence screen. Weekly observations are not episodes.
// node scripts/research/compound-comet-weekly-screen.mjs --out /private/tmp/compound-comet-weekly-400d.json
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'

export const GRID = Object.freeze({ first: 23_229_806, last: 26_052_206, step: 50_400 })
export const EXPECTED = (GRID.last - GRID.first) / GRID.step + 1
export const SCENARIOS_USD = Object.freeze([1_000_000, 10_000_000, 100_000_000])
export const MARKETS = Object.freeze([
  {
    name: 'cUSDCv3',
    comet: '0xc3d688B66703497DAA19211EEdff47f25384cdc3',
    base: '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    decimals: 6,
  },
  {
    name: 'cUSDTv3',
    comet: '0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840',
    base: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    decimals: 6,
  },
])
const STUDY = 'Compound III Ethereum USDC-USDT weekly cash prevalence screen'
const f = (name, type) => ({ name, type })
const cometAbi = [
  {
    type: 'function',
    name: 'baseToken',
    stateMutability: 'view',
    inputs: [],
    outputs: [f('', 'address')],
  },
  {
    type: 'function',
    name: 'isWithdrawPaused',
    stateMutability: 'view',
    inputs: [],
    outputs: [f('', 'bool')],
  },
  {
    type: 'function',
    name: 'totalSupply',
    stateMutability: 'view',
    inputs: [],
    outputs: [f('', 'uint256')],
  },
  {
    type: 'function',
    name: 'totalBorrow',
    stateMutability: 'view',
    inputs: [],
    outputs: [f('', 'uint256')],
  },
  {
    type: 'function',
    name: 'totalsBasic',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      {
        type: 'tuple',
        components: [
          f('baseSupplyIndex', 'uint64'),
          f('baseBorrowIndex', 'uint64'),
          f('trackingSupplyIndex', 'uint64'),
          f('trackingBorrowIndex', 'uint64'),
          f('totalSupplyBase', 'uint104'),
          f('totalBorrowBase', 'uint104'),
          f('lastAccrualTime', 'uint40'),
          f('pauseFlags', 'uint8'),
        ],
      },
    ],
  },
]
const tokenAbi = [
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [f('', 'uint8')],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [f('', 'address')],
    outputs: [f('', 'uint256')],
  },
]
const key = (market, block) => `${market}:${block}`
const lower = (s) => s?.toLowerCase()

export function blocks() {
  return Array.from({ length: EXPECTED }, (_, i) => GRID.first + i * GRID.step)
}

export function validRow(row, markets = MARKETS) {
  const market = markets.find((m) => m.name === row?.market)
  return Boolean(
    market &&
    Number.isSafeInteger(row.block) &&
    row.block >= GRID.first &&
    row.block <= GRID.last &&
    (row.block - GRID.first) % GRID.step === 0 &&
    Number.isSafeInteger(row.at) &&
    row.at > 0 &&
    lower(row.comet) === lower(market.comet) &&
    lower(row.base) === lower(market.base) &&
    row.decimals === market.decimals &&
    typeof row.withdrawPaused === 'boolean' &&
    [
      'cashRaw',
      'totalSupplyRaw',
      'totalBorrowRaw',
      'totalSupplyBaseRaw',
      'totalBorrowBaseRaw',
      'baseSupplyIndexRaw',
      'baseBorrowIndexRaw',
    ].every((field) => typeof row[field] === 'string' && /^\d+$/.test(row[field])) &&
    Number.isFinite(row.cashUsdAssumingPeg) &&
    row.cashUsdAssumingPeg >= 0 &&
    row.cashUsdAssumingPeg === Number(row.cashRaw) / 10 ** market.decimals &&
    Number.isSafeInteger(row.lastAccrualTime) &&
    row.lastAccrualTime <= row.at,
  )
}

export function coverage(rows, markets = MARKETS) {
  const seen = new Set()
  const perMarket = {}
  for (const market of markets) {
    const sorted = rows.filter((r) => r.market === market.name).sort((a, b) => a.block - b.block)
    let maxGapSeconds = 0
    let maxGapBlocks = null
    for (let i = 0; i < sorted.length; i++) {
      const row = sorted[i]
      if (!validRow(row, markets) || seen.has(key(row.market, row.block)))
        throw new Error(`Invalid/duplicate row ${key(row.market, row.block)}`)
      seen.add(key(row.market, row.block))
      if (i) {
        const gap = row.at - sorted[i - 1].at
        if (gap <= 0) throw new Error(`Nonmonotonic timestamps ${market.name}`)
        if (gap > maxGapSeconds) {
          maxGapSeconds = gap
          maxGapBlocks = [sorted[i - 1].block, row.block]
        }
      }
    }
    perMarket[market.name] = {
      expected: EXPECTED,
      present: sorted.length,
      missing: EXPECTED - sorted.length,
      maxGapSeconds,
      maxGapBlocks,
      firstBlock: sorted[0]?.block ?? null,
      lastBlock: sorted.at(-1)?.block ?? null,
    }
  }
  if (seen.size !== rows.length) throw new Error('Unknown market rows')
  return {
    expected: EXPECTED * markets.length,
    present: rows.length,
    missing: EXPECTED * markets.length - rows.length,
    complete: rows.length === EXPECTED * markets.length,
    markets: perMarket,
  }
}

export function summarize(rows, markets = MARKETS) {
  const state = coverage(rows, markets)
  if (!state.complete) throw new Error('Cannot summarize incomplete weekly history')
  const output = {}
  for (const market of markets) {
    const sorted = rows.filter((r) => r.market === market.name).sort((a, b) => a.block - b.block)
    const trainCount = Math.floor(sorted.length * 0.7)
    const split = { train: sorted.slice(0, trainCount), holdout: sorted.slice(trainCount) }
    output[market.name] = {
      trainCount,
      holdoutCount: sorted.length - trainCount,
      boundary: {
        lastTrainBlock: split.train.at(-1).block,
        firstHoldoutBlock: split.holdout[0].block,
        gapSeconds: split.holdout[0].at - split.train.at(-1).at,
        rule: 'Assign each raw downcrossing to its current sample; boundary crossing is separate, not a holdout onset.',
      },
      splits: Object.fromEntries(
        Object.entries(split).map(([name, subset]) => [
          name,
          {
            firstAt: subset[0].at,
            lastAt: subset.at(-1).at,
            minCashUsdAssumingPeg: Math.min(...subset.map((r) => r.cashUsdAssumingPeg)),
            pausedSamples: subset.filter((r) => r.withdrawPaused).length,
            scenarios: Object.fromEntries(
              SCENARIOS_USD.map((q) => [
                String(q),
                {
                  belowSamples: subset.filter((r) => r.cashUsdAssumingPeg < q).length,
                  rawDowncrossings: subset
                    .slice(1)
                    .filter((r, i) => subset[i].cashUsdAssumingPeg >= q && r.cashUsdAssumingPeg < q)
                    .length,
                  boundaryDowncrossing:
                    name === 'holdout' &&
                    split.train.at(-1).cashUsdAssumingPeg >= q &&
                    subset[0].cashUsdAssumingPeg < q,
                },
              ]),
            ),
          },
        ]),
      ),
    }
  }
  return {
    coverage: state,
    markets: output,
    caveat:
      'Weekly sampled base cash at $1 peg is not an independent stress episode, intraweek minimum, executable exit quote, or wallet withdrawal verdict.',
  }
}

function identity(study = STUDY, markets = MARKETS) {
  return {
    study,
    version: 1,
    chainId: 1,
    grid: GRID,
    markets,
    scenariosUsdAssumingPeg: SCENARIOS_USD,
    semantics:
      'Pinned baseToken.balanceOf(Comet); Comet totalSupply/totalBorrow accrued present values plus totalsBasic principal/index; isWithdrawPaused. Cash assumes $1 peg.',
  }
}
function resume(path, study = STUDY, markets = MARKETS) {
  if (!existsSync(path)) return { rows: [], failures: [] }
  const data = JSON.parse(readFileSync(path, 'utf8'))
  const expected = identity(study, markets)
  for (const prop of [
    'study',
    'version',
    'chainId',
    'grid',
    'markets',
    'scenariosUsdAssumingPeg',
    'semantics',
  ])
    if (JSON.stringify(data[prop]) !== JSON.stringify(expected[prop]))
      throw new Error(`Resume identity mismatch: ${prop}`)
  if (
    !['partial', 'complete'].includes(data.status) ||
    !Array.isArray(data.rows) ||
    !Array.isArray(data.failures)
  )
    throw new Error('Malformed resume artifact')
  const state = coverage(data.rows, markets)
  const failed = new Set()
  const successful = new Set(data.rows.map((row) => key(row.market, row.block)))
  for (const failure of data.failures) {
    const id = key(failure.market, failure.block)
    if (
      !markets.some((market) => market.name === failure.market) ||
      !Number.isSafeInteger(failure.block) ||
      failure.block < GRID.first ||
      failure.block > GRID.last ||
      (failure.block - GRID.first) % GRID.step !== 0 ||
      typeof failure.error !== 'string' ||
      !failure.error ||
      failed.has(id) ||
      successful.has(id)
    )
      throw new Error(`Invalid/duplicate resume failure ${id}`)
    failed.add(id)
  }
  if (
    JSON.stringify(data.coverage) !== JSON.stringify(state) ||
    data.failedReadCount !== failed.size ||
    (data.status === 'complete') !== (state.complete && failed.size === 0)
  )
    throw new Error('Resume coverage/status mismatch')
  return data
}
function atomic(path, object) {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(object))
  renameSync(tmp, path)
}

async function readPinned(client, market, block, markets) {
  const blockNumber = BigInt(block)
  const at = Number((await client.getBlock({ blockNumber })).timestamp)
  const [base, decimals, cash, withdrawPaused, totalSupply, totalBorrow, totals] =
    await client.multicall({
      blockNumber,
      allowFailure: false,
      contracts: [
        { address: market.comet, abi: cometAbi, functionName: 'baseToken' },
        { address: market.base.toLowerCase(), abi: tokenAbi, functionName: 'decimals' },
        {
          address: market.base.toLowerCase(),
          abi: tokenAbi,
          functionName: 'balanceOf',
          args: [market.comet],
        },
        { address: market.comet, abi: cometAbi, functionName: 'isWithdrawPaused' },
        { address: market.comet, abi: cometAbi, functionName: 'totalSupply' },
        { address: market.comet, abi: cometAbi, functionName: 'totalBorrow' },
        { address: market.comet, abi: cometAbi, functionName: 'totalsBasic' },
      ],
    })
  if (lower(base) !== lower(market.base) || Number(decimals) !== market.decimals)
    throw new Error(`Base identity mismatch at ${market.name} ${block}`)
  const row = {
    market: market.name,
    comet: market.comet,
    base: market.base,
    decimals: Number(decimals),
    block,
    at,
    cashRaw: cash.toString(),
    cashUsdAssumingPeg: Number(cash) / 10 ** market.decimals,
    withdrawPaused,
    totalSupplyRaw: totalSupply.toString(),
    totalBorrowRaw: totalBorrow.toString(),
    totalSupplyBaseRaw: totals.totalSupplyBase.toString(),
    totalBorrowBaseRaw: totals.totalBorrowBase.toString(),
    baseSupplyIndexRaw: totals.baseSupplyIndex.toString(),
    baseBorrowIndexRaw: totals.baseBorrowIndex.toString(),
    lastAccrualTime: Number(totals.lastAccrualTime),
  }
  if (!validRow(row, markets)) throw new Error(`Invalid pinned row ${key(market.name, block)}`)
  return row
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function readWithRetry(client, market, block, markets) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return { row: await readPinned(client, market, block, markets) }
    } catch (error) {
      if (attempt === 3)
        return {
          failure: {
            market: market.name,
            block,
            error: String(error?.message || error).slice(0, 400),
          },
        }
      await delay(attempt * 1000)
    }
  }
}

export async function collect({
  out,
  maxNew = Infinity,
  batchSize = 4,
  rpc,
  client: suppliedClient,
  study = STUDY,
  markets = MARKETS,
}) {
  if (!out?.startsWith('/')) throw new Error('--out must be an absolute path')
  if (maxNew !== Infinity && (!Number.isSafeInteger(maxNew) || maxNew < 0))
    throw new Error('Bad maxNew')
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 16)
    throw new Error('Bad batchSize')
  if (
    !Array.isArray(markets) ||
    markets.length === 0 ||
    new Set(markets.map((m) => m.name)).size !== markets.length
  )
    throw new Error('Bad market list')
  const old = resume(out, study, markets)
  const rows = new Map(old.rows.map((row) => [key(row.market, row.block), row]))
  const failures = new Map(old.failures.map((row) => [key(row.market, row.block), row]))
  const pending = markets.flatMap((market) =>
    blocks()
      .filter((block) => !rows.has(key(market.name, block)))
      .map((block) => ({ market, block })),
  )
  const selected = pending.slice(0, maxNew)
  const client = selected.length
    ? suppliedClient ||
      makeClient(rpc || process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL'))
    : null
  const save = () => {
    const savedRows = [...rows.values()].sort(
      (a, b) => a.market.localeCompare(b.market) || a.block - b.block,
    )
    const savedFailures = [...failures.values()].sort(
      (a, b) => a.market.localeCompare(b.market) || a.block - b.block,
    )
    const state = coverage(savedRows, markets)
    const data = {
      ...identity(study, markets),
      status: state.complete && !savedFailures.length ? 'complete' : 'partial',
      coverage: state,
      failedReadCount: savedFailures.length,
      failures: savedFailures,
      rows: savedRows,
    }
    atomic(out, data)
    return data
  }
  let result = save()
  for (let i = 0; i < selected.length; i += batchSize) {
    const batch = await Promise.all(
      selected
        .slice(i, i + batchSize)
        .map(({ market, block }) => readWithRetry(client, market, block, markets)),
    )
    for (const item of batch) {
      const id = item.row
        ? key(item.row.market, item.row.block)
        : key(item.failure.market, item.failure.block)
      if (item.row) {
        rows.set(id, item.row)
        failures.delete(id)
      } else failures.set(id, item.failure)
    }
    result = save()
    if ((i / batchSize) % 8 === 0 || i + batchSize >= selected.length)
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
  const args = process.argv.slice(2),
    opts = {}
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith('--') || args[i + 1] === undefined)
      throw new Error(
        'Usage: --out ABSOLUTE_PATH [--max-new COUNT] [--batch-size COUNT] [--rpc URL]',
      )
    opts[args[i].slice(2)] = args[i + 1]
  }
  const result = await collect({
    out: opts.out,
    maxNew: opts['max-new'] === undefined ? Infinity : Number(opts['max-new']),
    batchSize: opts['batch-size'] === undefined ? 4 : Number(opts['batch-size']),
    rpc: opts.rpc,
  })
  console.log(
    JSON.stringify({
      status: result.status,
      coverage: result.coverage,
      failedReadCount: result.failedReadCount,
      summary: result.status === 'complete' ? summarize(result.rows) : null,
    }),
  )
}
