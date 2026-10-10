// Exploratory, time-ordered venue-capacity study. Read-only against Neon.
// node scripts/research/venue-signal-study.mjs
// The preregistered promotion gate is docs/research/venue-capacity-drivers.md.
// No backfilled depth and no post-outcome feature are admitted.

import { neon } from '@neondatabase/serverless'
import { loadConfig, readEnv } from '../lib/venue-reads.mjs'

const { get } = readEnv()
const dbUrl = get('DATABASE_URL_UNPOOLED') || get('DATABASE_URL')
if (!dbUrl) throw new Error('DATABASE_URL_UNPOOLED / DATABASE_URL is required')
const sql = neon(dbUrl)
const configs = loadConfig().filter((venue) => venue.enabled)

const snapshots = await sql`
  SELECT venue, block, observed_at, instant_usd, params
  FROM venue_snapshots
  WHERE source = 'observed' AND observed_at >= now() - interval '35 days'
  ORDER BY venue, observed_at`
const dailyFlows = await sql`
  SELECT venue, date_trunc('day', block_time) AS day,
    SUM(CASE WHEN direction = 'out' THEN assets_raw::numeric ELSE -assets_raw::numeric END) / 1e18 AS net_out_usd
  FROM venue_flows
  WHERE block_time >= now() - interval '35 days'
  GROUP BY venue, date_trunc('day', block_time)`
const flowByDay = new Map(
  dailyFlows.map((row) => [
    `${row.venue}:${new Date(row.day).toISOString().slice(0, 10)}`,
    Number(row.net_out_usd),
  ]),
)

function validSnapshot(row, config) {
  const p = row.params ?? {}
  if (config.kind === 'atoken-liquidity') {
    const value = row.instant_usd == null ? null : Number(row.instant_usd)
    return Number.isFinite(value) && value > 0
      ? {
          value,
          utilization: p.utilization_pct == null ? null : Number(p.utilization_pct),
          skew: null,
        }
      : null
  }
  const expected = (config.depthMarkets ?? []).filter((market) => market.enabled)
  const markets = p.depthMarkets
  if (!Array.isArray(markets) || markets.length !== expected.length || p.depth_usd == null)
    return null
  let sum = 0
  for (const market of expected) {
    const saved = markets.find(
      (item) => item.address?.toLowerCase() === market.address?.toLowerCase(),
    )
    if (!saved || saved.exitableUsd == null || !Number.isFinite(Number(saved.exitableUsd)))
      return null
    if (market.kind === 'psm-buffer') {
      if (saved.reads?.buffer !== true || saved.reads?.decimals === false) return null
    } else if (
      saved.reads?.reserve0 !== true ||
      saved.reads?.reserve1 !== true ||
      saved.reads?.decimals0 === false ||
      saved.reads?.decimals1 === false
    )
      return null
    sum += Number(saved.exitableUsd)
  }
  const value = Number(p.depth_usd)
  if (!Number.isFinite(value) || value <= 0 || Math.abs(sum - value) > Math.max(1, value * 1e-8))
    return null
  return {
    value,
    utilization: null,
    skew: p.depth_skew_pct == null ? null : Number(p.depth_skew_pct),
  }
}

function dailyAnchors(rows) {
  const byDay = new Map()
  for (const row of rows) {
    const day = row.at.toISOString().slice(0, 10)
    if (!byDay.has(day)) byDay.set(day, row) // first successful read after UTC midnight
  }
  return [...byDay.values()]
}

function averagePrecision(rows, key) {
  const eligible = rows.filter((row) => Number.isFinite(row[key]))
  const positives = eligible.filter((row) => row.drop).length
  if (!positives) return null
  eligible.sort((a, b) => b[key] - a[key])
  let seen = 0
  let hits = 0
  let sumPrecision = 0
  for (const row of eligible) {
    seen++
    if (row.drop) {
      hits++
      sumPrecision += hits / seen
    }
  }
  return { ap: sumPrecision / positives, n: eligible.length, positives }
}

function summarize(config) {
  const all = snapshots.filter((row) => row.venue === config.name)
  const valid = all
    .map((row) => {
      const metric = validSnapshot(row, config)
      return metric ? { ...metric, at: new Date(row.observed_at), block: Number(row.block) } : null
    })
    .filter(Boolean)
  const anchors = dailyAnchors(valid)
  const examples = []
  for (let i = 1; i < anchors.length - 1; i++) {
    const prev = anchors[i - 1]
    const now = anchors[i]
    const next = anchors[i + 1]
    const pastHours = (now.at - prev.at) / 3_600_000
    const futureHours = (next.at - now.at) / 3_600_000
    if (pastHours < 20 || pastHours > 28 || futureHours < 20 || futureHours > 28) continue
    const prevDay = prev.at.toISOString().slice(0, 10)
    examples.push({
      at: now.at.toISOString(),
      drop: next.value <= now.value * 0.8,
      outcomePct: (next.value / now.value - 1) * 100,
      momentum: -(now.value / prev.value - 1),
      utilization: Number.isFinite(now.utilization) ? now.utilization : null,
      skew: Number.isFinite(now.skew) ? now.skew : null,
      // Contextual demand proxy, not an accounting decomposition of pool inventory.
      priorNetOutflowRatio: (flowByDay.get(`${config.name}:${prevDay}`) ?? 0) / now.value,
    })
  }
  const boundary = Math.floor(examples.length * 0.7)
  // Purge a full daily anchor around the chronological split.
  const test = examples.slice(boundary + 1)
  const positive = examples.filter((row) => row.drop)
  const negative = examples.length - positive.length
  const byDay = new Map(anchors.map((row) => [row.at.toISOString().slice(0, 10), row]))
  const sevenDay = []
  for (const now of anchors) {
    const date = new Date(now.at)
    date.setUTCDate(date.getUTCDate() + 7)
    const next = byDay.get(date.toISOString().slice(0, 10))
    if (!next || (next.at - now.at) / 3_600_000 > 7 * 24 + 4) continue
    const outcomePct = (next.value / now.value - 1) * 100
    sevenDay.push({ at: now.at.toISOString(), drop: outcomePct <= -35, outcomePct })
  }
  return {
    venue: config.name,
    target:
      config.kind === 'atoken-liquidity'
        ? 'Aave aToken underlying cash'
        : 'configured exit-side reserve inventory',
    observed: all.length,
    valid: valid.length,
    firstValid: valid[0]?.at.toISOString() ?? null,
    lastValid: valid.at(-1)?.at.toISOString() ?? null,
    dailyWindows: examples.length,
    targetEvents: positive.length,
    controls: negative,
    holdoutWindows: test.length,
    holdoutEvents: test.filter((row) => row.drop).length,
    promotionEligible: positive.length >= 20 && negative >= 20,
    allWindowAP: {
      momentum: averagePrecision(examples, 'momentum'),
      utilization: averagePrecision(examples, 'utilization'),
      poolSkew: averagePrecision(examples, 'skew'),
      priorNetOutflow: averagePrecision(examples, 'priorNetOutflowRatio'),
    },
    holdoutAP: {
      momentum: averagePrecision(test, 'momentum'),
      utilization: averagePrecision(test, 'utilization'),
      poolSkew: averagePrecision(test, 'skew'),
      priorNetOutflow: averagePrecision(test, 'priorNetOutflowRatio'),
    },
    eventWindows: positive.map(({ at, outcomePct }) => ({ at, outcomePct })),
    sevenDayWindows: sevenDay.length,
    sevenDayEvents: sevenDay.filter((row) => row.drop),
    // Never relabel this as a predictive result: adjacent venue-days and the
    // shared market factor still leave too few independent crises.
    verdict: 'exploratory only; no volatility/governance series joined',
  }
}

console.log(
  JSON.stringify(
    {
      asOf: new Date().toISOString(),
      preregistration: 'docs/research/venue-capacity-drivers.md',
      results: configs.map(summarize),
    },
    null,
    2,
  ),
)
