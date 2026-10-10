// Read-only historical size-aware crvUSD secondary exit study.
// See curve-size-aware-logic.mjs for precommitted target, actionability, gates.
// Uses the cached 400d quote block grid. --out writes the complete pinned
// enrichment once; --in replays it entirely offline. No logs are queried.

import { readFileSync, writeFileSync } from 'node:fs'
import { loadConfig, makeClient, readEnv } from '../lib/venue-reads.mjs'
import { episodeSummary } from './curve-size-aware-logic.mjs'

const sizes = [100_000, 1_000_000]
const shares = [0, 0.25, 0.5, 0.75, 1]
const parts = [25_000, 50_000, 75_000, 100_000, 250_000, 500_000, 750_000, 1_000_000]
const args = process.argv.slice(2)
const opts = {}
for (let i = 0; i < args.length; i += 2) {
  if (!args[i]?.startsWith('--') || args[i + 1] === undefined)
    throw new Error(`Expected --name value near ${args[i]}`)
  const key = args[i].slice(2)
  if (!['base', 'out', 'in', 'rpc', 'limit'].includes(key) || opts[key])
    throw new Error(`Invalid or duplicate option ${args[i]}`)
  opts[key] = args[i + 1]
}
if (!opts.base || (!opts.in && !opts.out))
  throw new Error('Supply --base and --out for RPC, or --in for offline replay')
if (opts.in && (opts.rpc || opts.limit)) throw new Error('--in requires no RPC or limit')
const limit = opts.limit === undefined ? null : Number(opts.limit)
if (limit !== null && (!Number.isSafeInteger(limit) || limit < 3 || limit > 3184))
  throw new Error('--limit must be 3..3184')
const base = JSON.parse(readFileSync(opts.base, 'utf8'))
if (base.study !== 'scrvUSD historical direct quotes' || base.rows?.length !== 3184)
  throw new Error('Expected complete cached 400d direct-quote artifact')
const baseRows = limit ? base.rows.slice(0, limit) : base.rows
const venue = loadConfig().find((v) => v.name === 'scrvUSD' && v.enabled)
const pools = venue?.depthMarkets?.filter((p) => p.enabled && p.kind === 'curve-stableswap')
if (
  pools?.length !== 2 ||
  pools[0].token0.toLowerCase() !== '0xdac17f958d2ee523a2206206994597c13d831ec7' ||
  pools[1].token0.toLowerCase() !== '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' ||
  !pools.every((p) => p.token1.toLowerCase() === venue.underlying.toLowerCase())
)
  throw new Error('Configured pool identity or token orientation changed')
const quoteAbi = [
  {
    type: 'function',
    name: 'get_dy',
    stateMutability: 'view',
    inputs: [{ type: 'int128' }, { type: 'int128' }, { type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
  },
]
const assetsAbi = [
  {
    type: 'function',
    name: 'totalAssets',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
]

function verifyRow(row, baseRow, i) {
  if (
    row.block !== baseRow.block ||
    row.at !== baseRow.at ||
    !Number.isFinite(row.vaultAssetsCrvUsd) ||
    row.vaultAssetsCrvUsd <= 0
  )
    throw new Error(`Invalid size-aware row identity/assets at ${i}`)
  for (const size of sizes) {
    const route = row.routes?.[size]
    if (!route || route.grid?.length !== shares.length || !Number.isFinite(route.bestQuote))
      throw new Error(`Invalid route at ${i}/${size}`)
    for (let j = 0; j < shares.length; j++) {
      if (route.grid[j].usdtShare !== shares[j] || !Number.isFinite(route.grid[j].output))
        throw new Error(`Invalid route grid at ${i}/${size}/${j}`)
    }
    const best = Math.max(...route.grid.map((g) => g.output)) / size
    if (
      Math.abs(best - route.bestQuote) > 1e-12 ||
      (size === 1_000_000 &&
        (Math.abs(route.grid[0].output / size - baseRow.pools[1].quotes[size]) > 1e-10 ||
          Math.abs(route.grid[4].output / size - baseRow.pools[0].quotes[size]) > 1e-10))
    )
      throw new Error(`Route mismatch at ${i}/${size}`)
  }
}

let rows
if (opts.in) {
  const saved = JSON.parse(readFileSync(opts.in, 'utf8'))
  if (saved.study !== 'fixed-size two-pool scrvUSD secondary exits' || saved.rows?.length !== 3184)
    throw new Error('Saved size-aware artifact is incomplete/wrong study')
  rows = saved.rows
  rows.forEach((row, i) => verifyRow(row, baseRows[i], i))
} else {
  const rpc = opts.rpc || process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')
  if (!rpc) throw new Error('Archive RPC missing')
  const client = makeClient(rpc)
  const contracts = [
    ...pools.flatMap((pool) =>
      parts.map((part) => ({
        address: pool.address,
        abi: quoteAbi,
        functionName: 'get_dy',
        args: [1n, 0n, BigInt(part) * 10n ** 18n],
      })),
    ),
    { address: venue.address, abi: assetsAbi, functionName: 'totalAssets' },
  ]
  rows = []
  for (let i = 0; i < baseRows.length; i++) {
    const source = baseRows[i]
    const result = await client.multicall({
      contracts,
      blockNumber: BigInt(source.block),
      allowFailure: true,
      batchSize: 16_000,
    })
    if (result.length !== contracts.length || result.some((r) => r.status !== 'success'))
      throw new Error(`Incomplete pinned read at sample ${i}, block ${source.block}`)
    const outputs = result.slice(0, -1).map((r) => Number(r.result) / 1e6)
    const vaultAssetsCrvUsd = Number(result.at(-1).result) / 1e18
    const routes = {}
    for (const size of sizes) {
      const grid = shares.map((share) => {
        const usdt = size * share
        const usdc = size - usdt
        const output =
          (usdt ? outputs[parts.indexOf(usdt)] : 0) +
          (usdc ? outputs[parts.length + parts.indexOf(usdc)] : 0)
        if (!Number.isFinite(output)) throw new Error(`Missing grid part at sample ${i}`)
        return { usdtShare: share, output }
      })
      routes[size] = {
        grid,
        bestQuote: Math.max(...grid.map((g) => g.output)) / size,
      }
    }
    const row = { block: source.block, at: source.at, vaultAssetsCrvUsd, routes }
    verifyRow(row, source, i)
    rows.push(row)
    if ((i + 1) % 250 === 0) process.stderr.write(`Pinned ${i + 1}/${baseRows.length} blocks\n`)
  }
}
const summary = {
  study: 'fixed-size two-pool scrvUSD secondary exits',
  preregistration:
    'Fixed sizes, route grid, 0.25pp threshold and >=6h lead set before enrichment; recovery/control guards revised during validation; exploratory, not fully preregistered',
  sampleCount: rows.length,
  firstBlock: rows[0].block,
  lastBlock: rows.at(-1).block,
  sizes: Object.fromEntries(
    sizes.map((size) => {
      const quotes = rows.map((r) => r.routes[size].bestQuote)
      const assetFractions = rows.map((r) => size / r.vaultAssetsCrvUsd)
      const outcome =
        rows.length === 3184
          ? episodeSummary(
              rows.map((r) => ({
                at: r.at,
                block: r.block,
                quote: r.routes[size].bestQuote,
              })),
              'quote',
            )
          : null
      return [
        size,
        {
          quoteMin: Math.min(...quotes),
          quoteMax: Math.max(...quotes),
          fractionMin: Math.min(...assetFractions),
          fractionMax: Math.max(...assetFractions),
          outcome,
          postHocExitImpairmentSensitivity: outcome
            ? {
                definition:
                  'onsetQuote <0.995; selected after primary outcome inspection, not preregistered',
                actionableOnsets: outcome.episodesDetail.filter(
                  (episode) => episode.opportunityCount > 0 && episode.onsetQuote < 0.995,
                ).length,
              }
            : null,
        },
      ]
    }),
  ),
  caveats: [
    'Vault scrvUSD shares redeem to crvUSD; this measures only the secondary crvUSD-to-USDT/USDC leg, not loss of crvUSD redemption.',
    'Pinned get_dy is a nominal historical quote, not guaranteed transaction execution; USDT/USDC each valued at $1.',
    'Fixed input preserves same-position comparability across time; vault totalAssets only contextualizes position size.',
    'No alert promotion without independent events, holdout improvement and confidence interval gates.',
  ],
}
if (opts.out) writeFileSync(opts.out, JSON.stringify({ ...summary, rows }) + '\n', { flag: 'wx' })
console.log(JSON.stringify(summary, null, 2))
