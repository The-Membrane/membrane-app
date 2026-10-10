// Exploratory, read-only correction to the best-single-pool scrvUSD exit proxy.
// The split grid was fixed after seeing the original single-pool outcome, so
// this must never be described as a preregistered or validated warning study.
// Usage: node scripts/research/curve-split-route-study.mjs \
//   --samples-in /private/tmp/scrvusd-leading-400d-20260925.json \
//   --samples-out /private/tmp/scrvusd-split-400d-20260925.json
// Add --limit 5 for a non-comparable RPC pilot (no artifact is written).
// For zero-RPC verification/reanalysis, use --samples-in BASE --split-in SAVED.

import { readFileSync, writeFileSync } from 'node:fs'
import { loadConfig, makeClient, readEnv } from '../lib/venue-reads.mjs'

const HOUR = 3600
const DAY = 24 * HOUR
const SIZE = 20_000_000
const SHARES = [0, 0.25, 0.5, 0.75, 1]
const PARTS = [5_000_000, 10_000_000, 15_000_000, SIZE]
const abi = [
  {
    type: 'function',
    name: 'get_dy',
    stateMutability: 'view',
    inputs: [{ type: 'int128' }, { type: 'int128' }, { type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
  },
]

function argumentsFrom(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith('--') || argv[i + 1] === undefined)
      throw new Error(`Expected --name value near ${argv[i] || '<end>'}`)
    const name = argv[i].slice(2)
    if (
      !(
        name === 'samples-in' ||
        name === 'samples-out' ||
        name === 'split-in' ||
        name === 'limit' ||
        name === 'rpc'
      )
    )
      throw new Error(`Unknown option ${argv[i]}`)
    if (out[name] !== undefined) throw new Error(`Duplicate option ${argv[i]}`)
    out[name] = argv[i + 1]
  }
  if (!out['samples-in']) throw new Error('--samples-in is required')
  if (out.limit !== undefined && (!Number.isSafeInteger(+out.limit) || +out.limit < 3))
    throw new Error('--limit must be an integer >= 3')
  if (out.limit && out['samples-out'])
    throw new Error('Pilot --limit cannot write a full-study artifact')
  if (out['split-in'] && (out['samples-out'] || out.limit || out.rpc))
    throw new Error('--split-in is mutually exclusive with --samples-out, --limit, and --rpc')
  return out
}

const options = argumentsFrom(process.argv.slice(2))
const artifact = JSON.parse(readFileSync(options['samples-in'], 'utf8'))
if (artifact.study !== 'scrvUSD historical direct quotes' || !Array.isArray(artifact.rows))
  throw new Error('Input is not the pinned scrvUSD direct-quote artifact')
if (artifact.rows.length < 3 || !Number.isSafeInteger(artifact.stepBlocks))
  throw new Error('Insufficient or invalid pinned grid')

const venue = loadConfig().find((v) => v.name === 'scrvUSD' && v.enabled)
const pools = venue?.depthMarkets?.filter((p) => p.enabled && p.kind === 'curve-stableswap')
if (
  pools?.length !== 2 ||
  pools[0].token0.toLowerCase() !== '0xdac17f958d2ee523a2206206994597c13d831ec7' ||
  pools[1].token0.toLowerCase() !== '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' ||
  !pools.every(
    (p) =>
      p.token1.toLowerCase() === venue.underlying.toLowerCase() &&
      p.exitFrom.toLowerCase() === venue.underlying.toLowerCase(),
  )
)
  throw new Error('Configured pool order/token orientation changed; reverify route encoding')

const inputRows = options.limit ? artifact.rows.slice(0, +options.limit) : artifact.rows
for (let i = 0; i < inputRows.length; i++) {
  const row = inputRows[i]
  if (
    !Number.isSafeInteger(row.block) ||
    !Number.isSafeInteger(row.at) ||
    row.pools?.length !== 2 ||
    !Number.isFinite(row.quotes?.[SIZE]) ||
    !pools.every(
      (p, j) =>
        row.pools[j].address?.toLowerCase() === p.address.toLowerCase() &&
        Number.isFinite(row.pools[j].quotes?.[SIZE]),
    ) ||
    (i &&
      (row.block - inputRows[i - 1].block !== artifact.stepBlocks ||
        row.at <= inputRows[i - 1].at ||
        row.at - inputRows[i - 1].at > 4 * HOUR))
  )
    throw new Error(`Pinned sample invalid at index ${i}`)
  const oldBest = Math.max(...row.pools.map((p) => p.quotes[SIZE]))
  if (Math.abs(row.quotes[SIZE] - oldBest) > 1e-12)
    throw new Error(`Best-single quote mismatch at index ${i}`)
}

const quotedRows = []
if (options['split-in']) {
  const saved = JSON.parse(readFileSync(options['split-in'], 'utf8'))
  if (
    saved.study !== 'exploratory fixed-grid split route; post-outcome redesign, no promotion' ||
    !Array.isArray(saved.rows) ||
    saved.rows.length !== inputRows.length ||
    saved.sampleCount !== inputRows.length ||
    saved.requiredSampleCount !== inputRows.length
  )
    throw new Error('Saved split artifact has wrong study identity or incomplete row coverage')
  for (let i = 0; i < inputRows.length; i++) {
    const base = inputRows[i]
    const row = saved.rows[i]
    if (
      row.block !== base.block ||
      row.at !== base.at ||
      !Number.isFinite(row.singleQuote) ||
      !Number.isFinite(row.splitQuote) ||
      Math.abs(row.singleQuote - base.quotes[SIZE]) > 1e-12 ||
      !Array.isArray(row.grid) ||
      row.grid.length !== SHARES.length
    )
      throw new Error(`Saved split artifact grid/baseline mismatch at sample ${i}`)
    for (let j = 0; j < SHARES.length; j++) {
      if (
        row.grid[j].usdtShare !== SHARES[j] ||
        !Number.isFinite(row.grid[j].output) ||
        row.grid[j].output < 0
      )
        throw new Error(`Saved split artifact invalid grid output at sample ${i}, share ${j}`)
    }
    // Endpoints anchor the saved split grid to both independently captured
    // same-block pool quotes, without contacting RPC during offline replay.
    if (
      Math.abs(row.grid[0].output / SIZE - base.pools[1].quotes[SIZE]) > 1e-10 ||
      Math.abs(row.grid.at(-1).output / SIZE - base.pools[0].quotes[SIZE]) > 1e-10
    )
      throw new Error(`Saved split artifact pool endpoint mismatch at sample ${i}`)
    const best = row.grid.reduce((winner, value) => (value.output > winner.output ? value : winner))
    if (
      row.bestUsdtShare !== best.usdtShare ||
      Math.abs(row.splitQuote - best.output / SIZE) > 1e-12 ||
      row.splitQuote + 1e-10 < row.singleQuote
    )
      throw new Error(`Saved split artifact best route mismatch at sample ${i}`)
    quotedRows.push(row)
  }
} else {
  const rpc = options.rpc || process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')
  if (!rpc) throw new Error('Archive RECORDER_RPC_URL or --rpc is required')
  const client = makeClient(rpc)
  const contracts = pools.flatMap((pool) =>
    PARTS.map((part) => ({
      address: pool.address,
      abi,
      functionName: 'get_dy',
      args: [1n, 0n, BigInt(part) * 10n ** 18n],
    })),
  )
  for (let i = 0; i < inputRows.length; i++) {
    const row = inputRows[i]
    // A single pinned multicall makes all grid alternatives share the exact state.
    const result = await client.multicall({
      contracts,
      blockNumber: BigInt(row.block),
      allowFailure: true,
      batchSize: 16_000,
    })
    if (result.length !== contracts.length || result.some((r) => r.status !== 'success'))
      throw new Error(`Incomplete split quote read at block ${row.block}, sample ${i}`)
    const amounts = [0, 1].map((poolIndex) =>
      Object.fromEntries(
        PARTS.map((part, j) => [part, Number(result[poolIndex * PARTS.length + j].result) / 1e6]),
      ),
    )
    for (let j = 0; j < 2; j++) {
      const fresh = amounts[j][SIZE] / SIZE
      if (Math.abs(fresh - row.pools[j].quotes[SIZE]) > 1e-10)
        throw new Error(`Pinned 20m endpoint changed at block ${row.block}, pool ${j}`)
    }
    const grid = SHARES.map((share) => {
      const usdtPart = SIZE * share
      const usdcPart = SIZE - usdtPart
      const output = (usdtPart ? amounts[0][usdtPart] : 0) + (usdcPart ? amounts[1][usdcPart] : 0)
      return { usdtShare: share, output }
    })
    const best = grid.reduce((winner, value) => (value.output > winner.output ? value : winner))
    const splitQuote = best.output / SIZE
    if (!Number.isFinite(splitQuote) || splitQuote + 1e-10 < row.quotes[SIZE])
      throw new Error(`Split quote is worse than best endpoint at block ${row.block}`)
    quotedRows.push({
      block: row.block,
      at: row.at,
      singleQuote: row.quotes[SIZE],
      splitQuote,
      bestUsdtShare: best.usdtShare,
      grid,
    })
    if ((i + 1) % 250 === 0)
      process.stderr.write(`Read ${i + 1}/${inputRows.length} pinned blocks\n`)
  }
}

function target(rows, field) {
  const candidates = []
  const crossings = []
  for (let i = 0; i < rows.length; i++) {
    const anchor = rows[i]
    const future = []
    for (let j = i + 1; j < rows.length && rows[j].at - anchor.at <= DAY; j++) future.push(rows[j])
    if (!future.length || future.at(-1).at - anchor.at < 20 * HOUR) continue
    const crossing = future.find((r) => (anchor[field] - r[field]) * 100 >= 1)?.at ?? null
    candidates.push({ at: anchor.at, crossing })
    if (crossing !== null) crossings.push(crossing)
  }
  crossings.sort((a, b) => a - b)
  const episodes = []
  for (const at of crossings) {
    const last = episodes.at(-1)
    if (!last || at - last.last >= 48 * HOUR) episodes.push({ first: at, last: at })
    else last.last = at
  }
  const splitAt = rows[0].at + (rows.at(-1).at - rows[0].at) * 0.7
  const trainEpisodes = episodes.filter((e) => e.last < splitAt - DAY)
  const holdoutEpisodes = episodes.filter((e) => e.first >= splitAt + DAY)
  const warnableEpisodes = episodes.filter((e) =>
    candidates.some(
      (r) =>
        r.crossing !== null &&
        r.crossing >= e.first &&
        r.crossing <= e.last &&
        e.first - r.at >= 6 * HOUR,
    ),
  )
  return {
    candidateWindows: candidates.length,
    positiveWindows: candidates.filter((r) => r.crossing !== null).length,
    sixHourLeadWindows: candidates.filter(
      (r) => r.crossing !== null && r.crossing - r.at >= 6 * HOUR,
    ).length,
    episodes: episodes.length,
    trainEpisodes: trainEpisodes.length,
    holdoutEpisodes: holdoutEpisodes.length,
    warnableEpisodes: warnableEpisodes.length,
    episodeStarts: episodes.map((e) => new Date(e.first * 1000).toISOString()),
  }
}

const improvementsPp = quotedRows.map((r) => (r.splitQuote - r.singleQuote) * 100)
const sorted = [...improvementsPp].sort((a, b) => a - b)
const percentile = (p) => sorted[Math.floor((sorted.length - 1) * p)]
const full = !options.limit
const single = full ? target(quotedRows, 'singleQuote') : null
const split = full ? target(quotedRows, 'splitQuote') : null
const summary = {
  study: 'exploratory fixed-grid split route; post-outcome redesign, no promotion',
  sampleCount: quotedRows.length,
  requiredSampleCount: inputRows.length,
  firstBlock: quotedRows[0].block,
  lastBlock: quotedRows.at(-1).block,
  firstQuote: {
    single: quotedRows[0].singleQuote,
    split: quotedRows[0].splitQuote,
    usdtShare: quotedRows[0].bestUsdtShare,
  },
  lastQuote: {
    single: quotedRows.at(-1).singleQuote,
    split: quotedRows.at(-1).splitQuote,
    usdtShare: quotedRows.at(-1).bestUsdtShare,
  },
  improvementPp: {
    min: sorted[0],
    median: percentile(0.5),
    p90: percentile(0.9),
    max: sorted.at(-1),
  },
  splitShareCounts: Object.fromEntries(
    SHARES.map((share) => [share, quotedRows.filter((r) => r.bestUsdtShare === share).length]),
  ),
  single,
  split,
  assumptions: [
    'Fixed 0/25/50/75/100% crvUSD allocation to USDT, remainder USDC; best sum of two pinned Curve get_dy outputs',
    'USDT and USDC each counted at $1; excludes stablecoin depeg, gas, MEV, scrvUSD redemption, other routes',
    'Fixed $20m is hypothetical and may exceed the vault totalAssets at some historical blocks; size-aware position targets are needed',
    'Grid/target selected after original single-pool outcome was inspected; no predictor is validated',
  ],
}
if (options['samples-out'])
  writeFileSync(options['samples-out'], JSON.stringify({ ...summary, rows: quotedRows }) + '\n', {
    flag: 'wx',
  })
console.log(JSON.stringify(summary, null, 2))
