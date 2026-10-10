// Exploratory ETH volatility negative control for venue-capacity research.
// Read-only: historical Chainlink ETH/USD rounds at recorder snapshot blocks.
// node scripts/research/eth-volatility-probe.mjs
// This is NOT a calibrated forecast: ~3 weeks of common exposure and few drops.

import { neon } from '@neondatabase/serverless'
import { readEnv, makeClient, loadConfig } from '../lib/venue-reads.mjs'

const { get } = readEnv()
const sql = neon(get('DATABASE_URL_UNPOOLED') || get('DATABASE_URL'))
const client = makeClient(get('RECORDER_RPC_URL') || process.env.RECORDER_RPC_URL)
// Same verified mainnet feed already used in lib/position-sim/historyScan.ts.
const ETH_USD = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419'
const feedAbi = [
  {
    type: 'function',
    name: 'latestRoundData',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { type: 'uint80' },
      { type: 'int256' },
      { type: 'uint256' },
      { type: 'uint256' },
      { type: 'uint80' },
    ],
  },
]

const rows = await sql`
  SELECT venue, block, observed_at, instant_usd, params
  FROM venue_snapshots WHERE source = 'observed' AND observed_at >= now() - interval '35 days'
  ORDER BY observed_at`
const common = rows.filter((row) => row.venue === 'aave-v3-usde')
const buckets = new Map()
for (const row of common) {
  const at = new Date(row.observed_at)
  const key = Math.floor(at.getTime() / (4 * 3_600_000))
  if (!buckets.has(key)) buckets.set(key, row)
}
const selected = [...buckets.values()]

async function fetchPrice(row) {
  try {
    const [, answer, , updatedAt] = await client.readContract({
      address: ETH_USD,
      abi: feedAbi,
      functionName: 'latestRoundData',
      blockNumber: BigInt(row.block),
    })
    const price = Number(answer) / 1e8
    if (!Number.isFinite(price) || price <= 0) return null
    return {
      at: new Date(row.observed_at),
      block: Number(row.block),
      price,
      oracleUpdatedAt: new Date(Number(updatedAt) * 1000),
    }
  } catch {
    return null
  }
}
const prices = []
for (let i = 0; i < selected.length; i += 4) {
  prices.push(...(await Promise.all(selected.slice(i, i + 4).map(fetchPrice))))
}
const validPrices = prices.filter(Boolean)
const days = new Map()
for (const point of validPrices) {
  const key = point.at.toISOString().slice(0, 10)
  const p = days.get(key) ?? []
  p.push(point)
  days.set(key, p)
}

function realized24h(day) {
  const end = days.get(day)?.[0]
  if (!end) return null
  const interval = validPrices.filter(
    (point) => point.at > new Date(end.at.getTime() - 24 * 3_600_000) && point.at <= end.at,
  )
  if (interval.length < 5) return null
  let squares = 0
  for (let i = 1; i < interval.length; i++) {
    const r = Math.log(interval[i].price / interval[i - 1].price)
    squares += r * r
  }
  return Math.sqrt(squares) * 100
}

const configs = loadConfig().filter((venue) => venue.enabled)
const allDays = [...days.keys()].sort()
const dated = allDays
  .map((day) => ({ day, volPct: realized24h(day) }))
  .filter((row) => row.volPct !== null)
const train = dated
  .slice(0, Math.floor(dated.length * 0.7))
  .map((row) => row.volPct)
  .sort((a, b) => a - b)
const highThreshold = train[Math.floor(train.length * 0.75)] ?? null

function metric(row, venue) {
  if (venue.kind === 'atoken-liquidity')
    return row.instant_usd == null ? null : Number(row.instant_usd)
  const p = row.params ?? {}
  const expected = (venue.depthMarkets ?? []).filter((market) => market.enabled)
  if (
    p.depth_usd == null ||
    p.depth_complete === false ||
    !Array.isArray(p.depthMarkets) ||
    p.depthMarkets.length !== expected.length
  )
    return null
  if (
    p.depthMarkets.some(
      (market) =>
        market.exitableUsd == null ||
        (market.kind === 'psm-buffer'
          ? market.reads?.buffer !== true
          : market.reads?.reserve0 !== true || market.reads?.reserve1 !== true),
    )
  )
    return null
  return Number(p.depth_usd)
}
const outcomes = []
for (const venue of configs) {
  const daily = new Map()
  for (const row of rows.filter((row) => row.venue === venue.name)) {
    const day = new Date(row.observed_at).toISOString().slice(0, 10)
    const value = metric(row, venue)
    if (!daily.has(day) && Number.isFinite(value) && value > 0) daily.set(day, value)
  }
  for (const { day, volPct } of dated) {
    const next = new Date(`${day}T00:00:00Z`)
    next.setUTCDate(next.getUTCDate() + 1)
    const from = daily.get(day)
    const to = daily.get(next.toISOString().slice(0, 10))
    if (from == null || to == null) continue
    outcomes.push({
      venue: venue.name,
      day,
      volPct,
      highVol: highThreshold !== null && volPct >= highThreshold,
      nextDayPct: (to / from - 1) * 100,
    })
  }
}
const high = outcomes.filter((row) => row.highVol)
const low = outcomes.filter((row) => !row.highVol)
console.log(
  JSON.stringify(
    {
      feed: ETH_USD,
      sampledHistoricalBlocks: selected.length,
      successfulOracleReads: validPrices.length,
      usableVolatilityDays: dated.length,
      highVolThresholdPct: highThreshold,
      observations: outcomes.length,
      highVolObservations: high.length,
      highVolNextDayDrops20Pct: high.filter((row) => row.nextDayPct <= -20).length,
      lowVolObservations: low.length,
      lowVolNextDayDrops20Pct: low.filter((row) => row.nextDayPct <= -20).length,
      highVolDates: [...new Set(high.map((row) => row.day))],
      note: 'Exploratory negative control only. Shared ETH volatility, four correlated venues, short period, no independent target episodes.',
    },
    null,
    2,
  ),
)
