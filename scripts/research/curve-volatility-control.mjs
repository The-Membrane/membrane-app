// ETH volatility as a BROAD NEGATIVE CONTROL, not a venue warning.
// Predeclared before the historical read (2026-09-25): at each pinned Curve
// quote block read Chainlink ETH/USD latestRoundData. Reject stale (>4h), bad,
// or future-dated rounds. Trailing 24h realized volatility is
// 100*sqrt(sum(log(p_i/p_(i-1))^2)) over prior sampled prices; require >=6
// returns and >=20h span. Never forward-fill. The high-vol threshold is the
// 90th percentile of the first 70% chronology, excluding +/-24h split embargo.
// Targets (unchanged): $20m quote worsens >=1pp in the next 24h, first crossing
// grouped within 48h, warning >=6h before first crossing. Evaluate the original
// best-single-pool outcome and exploratory two-pool split outcome separately.
// Report sample flags AND 24h-cooldown alert incidents. No predictor is promoted
// without the study's independent-event, baseline, precision, and CI gates.
//
// node scripts/research/curve-volatility-control.mjs --max-samples 40
// node scripts/research/curve-volatility-control.mjs --prices-out /private/tmp/eth-vol-400d.json
// node scripts/research/curve-volatility-control.mjs --prices-in /private/tmp/eth-vol-400d.json

import { readFileSync, writeFileSync } from 'node:fs'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'

const SINGLE_PATH = '/private/tmp/scrvusd-leading-400d-20260925.json'
const SPLIT_PATH = '/private/tmp/scrvusd-split-400d-20260925.json'
const FEED = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419'
const HOUR = 3600
const DAY = 24 * HOUR
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
const decimalsAbi = [
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
]

const args = process.argv.slice(2)
function option(name) {
  const i = args.indexOf(name)
  return i < 0 ? null : args[i + 1]
}
const maxSamples = option('--max-samples') ? Number(option('--max-samples')) : null
const pricesIn = option('--prices-in')
const pricesOut = option('--prices-out')
if (maxSamples !== null && (!Number.isInteger(maxSamples) || maxSamples < 40))
  throw new Error('--max-samples must be an integer >=40')
if (pricesIn && pricesOut) throw new Error('choose --prices-in or --prices-out')

const singles = JSON.parse(readFileSync(SINGLE_PATH, 'utf8')).rows
const splits = JSON.parse(readFileSync(SPLIT_PATH, 'utf8')).rows
const n = maxSamples ?? singles.length
if (splits.length !== singles.length || n > singles.length)
  throw new Error('quote-artifact sample count mismatch')
const rows = singles.slice(0, n).map((row, i) => {
  const split = splits[i]
  if (
    row.block !== split.block ||
    row.at !== split.at ||
    Math.abs(row.quotes['20000000'] - split.singleQuote) > 1e-10
  )
    throw new Error(`quote-artifact mismatch at ${i}`)
  return { block: row.block, at: row.at, single: split.singleQuote, split: split.splitQuote }
})
for (let i = 1; i < rows.length; i++) {
  if (
    rows[i].block <= rows[i - 1].block ||
    rows[i].at <= rows[i - 1].at ||
    rows[i].at - rows[i - 1].at > 4 * HOUR
  )
    throw new Error(`nonmonotonic or >4h quote gap at ${i}`)
}

let priceRows
if (pricesIn) {
  const artifact = JSON.parse(readFileSync(pricesIn, 'utf8'))
  if (
    artifact.study !== 'ETH/USD Chainlink as-of pinned Curve quote blocks' ||
    artifact.feed.toLowerCase() !== FEED.toLowerCase() ||
    artifact.prices.length !== rows.length
  )
    throw new Error('oracle artifact feed/count mismatch')
  priceRows = artifact.prices
} else {
  const rpc = option('--rpc') || process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')
  if (!rpc) throw new Error('Set RECORDER_RPC_URL or --rpc (archive mainnet)')
  const client = makeClient(rpc)
  const endpointDecimals = await Promise.all(
    [rows[0], rows.at(-1)].map((row) =>
      client.readContract({
        address: FEED,
        abi: decimalsAbi,
        functionName: 'decimals',
        blockNumber: BigInt(row.block),
      }),
    ),
  )
  if (endpointDecimals.some((value) => value !== 8))
    throw new Error(
      `Chainlink ETH/USD decimals not 8 at first/last pinned blocks: ${endpointDecimals}`,
    )
  priceRows = Array(rows.length)
  // Small bounded concurrency: archive RPC only, no current-state reads.
  for (let base = 0; base < rows.length; base += 8) {
    const chunk = await Promise.all(
      rows.slice(base, base + 8).map(async (row, j) => {
        try {
          const [roundId, answer, , updatedAt, answeredInRound] = await client.readContract({
            address: FEED,
            abi: feedAbi,
            functionName: 'latestRoundData',
            blockNumber: BigInt(row.block),
          })
          return {
            block: row.block,
            at: row.at,
            roundId: String(roundId),
            answeredInRound: String(answeredInRound),
            price: Number(answer) / 1e8,
            oracleUpdatedAt: Number(updatedAt),
          }
        } catch (error) {
          return {
            block: row.block,
            at: row.at,
            error: String(error?.shortMessage || error?.message || error),
          }
        }
      }),
    )
    for (let j = 0; j < chunk.length; j++) priceRows[base + j] = chunk[j]
  }
  if (pricesOut)
    writeFileSync(
      pricesOut,
      JSON.stringify({
        study: 'ETH/USD Chainlink as-of pinned Curve quote blocks',
        feed: FEED,
        prices: priceRows,
      }),
      { flag: 'wx' },
    )
}

const exclusions = { oracleRead: 0, invalidAnswer: 0, staleOrFuture: 0, insufficientHistory: 0 }
const valid = priceRows.map((p, i) => {
  if (p.block !== rows[i].block || p.at !== rows[i].at)
    throw new Error(`oracle artifact row mismatch at ${i}`)
  if (p.error) {
    exclusions.oracleRead++
    return false
  }
  if (
    !Number.isFinite(p.price) ||
    p.price <= 0 ||
    !Number.isFinite(p.oracleUpdatedAt) ||
    BigInt(p.answeredInRound) < BigInt(p.roundId)
  ) {
    exclusions.invalidAnswer++
    return false
  }
  const age = p.at - p.oracleUpdatedAt
  if (age < 0 || age > 4 * HOUR) {
    exclusions.staleOrFuture++
    return false
  }
  return true
})

const volatility = rows.map((row, i) => {
  if (!valid[i]) return null
  let start = i
  while (start > 0 && row.at - rows[start - 1].at <= DAY) start--
  if (
    i - start < 6 ||
    row.at - rows[start].at < 20 * HOUR ||
    valid.slice(start, i + 1).some((v) => !v)
  ) {
    exclusions.insufficientHistory++
    return null
  }
  let sumSq = 0
  for (let j = start + 1; j <= i; j++) {
    const lr = Math.log(priceRows[j].price / priceRows[j - 1].price)
    sumSq += lr * lr
  }
  return 100 * Math.sqrt(sumSq)
})

function percentile(values, q) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  return sorted.length ? sorted[Math.floor((sorted.length - 1) * q)] : null
}
const splitAt = rows[0].at + (rows.at(-1).at - rows[0].at) * 0.7
const trainIndexes = rows.flatMap((r, i) => (r.at < splitAt - DAY ? [i] : []))
const holdoutIndexes = rows.flatMap((r, i) => (r.at >= splitAt + DAY ? [i] : []))
const threshold = percentile(
  trainIndexes.map((i) => volatility[i]),
  0.9,
)
if (threshold === null) throw new Error('No train-set volatility features')

function outcome(type) {
  const candidates = []
  const crossingTimes = []
  let incompleteHorizon = 0
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const future = rows.slice(i + 1).filter((r) => r.at - row.at <= DAY)
    if (!future.length || future.at(-1).at - row.at < 20 * HOUR) {
      incompleteHorizon++
      continue
    }
    const first = future.find((r) => (row[type] - r[type]) * 100 >= 1)
    candidates.push({ i, at: row.at, firstCross: first?.at ?? null })
    if (first) crossingTimes.push(first.at)
  }
  crossingTimes.sort((a, b) => a - b)
  const episodes = []
  for (const at of crossingTimes) {
    const last = episodes.at(-1)
    if (!last || at - last.last >= 48 * HOUR) episodes.push({ first: at, last: at })
    else last.last = at
  }
  const candidateByIndex = new Map(candidates.map((c) => [c.i, c]))
  const train = trainIndexes.map((i) => candidateByIndex.get(i)).filter(Boolean)
  const holdout = holdoutIndexes.map((i) => candidateByIndex.get(i)).filter(Boolean)
  const holdoutEpisodes = episodes.filter((e) => e.first >= splitAt + DAY)
  const trainEpisodes = episodes.filter((e) => e.last < splitAt - DAY)
  const flags = holdout.filter((r) => volatility[r.i] !== null && volatility[r.i] >= threshold)
  const incidents = []
  for (const flag of flags) {
    // User-facing incidents deduplicated by a 24h cooldown, not per 3h window.
    if (!incidents.length || flag.at - incidents.at(-1).at >= DAY) incidents.push(flag)
  }
  const warned = new Set()
  function predictedEpisode(flag) {
    const e = holdoutEpisodes.find(
      (event) => event.first - flag.at >= 6 * HOUR && event.first - flag.at <= DAY,
    )
    if (e) warned.add(e.first)
    return Boolean(e)
  }
  const timelyFlags = flags.filter(predictedEpisode)
  const incidentHits = incidents.filter(predictedEpisode)
  // Strict comparator to the original quote study: the flagged anchor's OWN
  // future quote must cross the 1pp target in the alerted episode.
  function strictPredictedEpisode(flag) {
    if (flag.firstCross === null) return false
    const e = holdoutEpisodes.find(
      (event) => flag.firstCross >= event.first && flag.firstCross <= event.last,
    )
    return Boolean(e && e.first - flag.at >= 6 * HOUR && e.first - flag.at <= DAY)
  }
  const strictTimelyFlags = flags.filter(strictPredictedEpisode)
  const strictTimelyIncidents = incidents.filter(strictPredictedEpisode)
  const falseIncidents = incidents.length - incidentHits.length
  const holdoutWeeks = holdout.length > 1 ? (holdout.at(-1).at - holdout[0].at) / (7 * DAY) : null
  const controls = []
  for (const c of candidates) {
    if (
      c.firstCross ||
      episodes.some((e) => c.at >= e.first - 48 * HOUR && c.at <= e.last + 48 * HOUR)
    )
      continue
    if (!controls.length || c.at - controls.at(-1) >= 48 * HOUR) controls.push(c.at)
  }
  return {
    type,
    target: '$20m quote output/input falls >=1pp within next 24h',
    candidateWindows: candidates.length,
    incompleteHorizon,
    independentEpisodes: episodes.length,
    independentControls: controls.length,
    trainWindows: train.length,
    trainTargetWindows: train.filter((c) => c.firstCross).length,
    trainEpisodes: trainEpisodes.length,
    holdoutWindows: holdout.length,
    holdoutTargetWindows: holdout.filter((c) => c.firstCross).length,
    holdoutEpisodes: holdoutEpisodes.length,
    holdoutVolatilityFeatureWindows: holdout.filter((c) => volatility[c.i] !== null).length,
    holdoutHighVolFlags: flags.length,
    timelyHighVolFlags: timelyFlags.length,
    strictOwnWindowTimelyFlags: strictTimelyFlags.length,
    alertedEpisodes: warned.size,
    alertIncidents: incidents.length,
    timelyIncidents: incidentHits.length,
    falseIncidents,
    strictOwnWindowTimelyIncidents: strictTimelyIncidents.length,
    falseIncidentsPerVenueWeek: holdoutWeeks ? falseIncidents / holdoutWeeks : null,
    holdoutEpisodeFirstCrosses: holdoutEpisodes.map((e) => new Date(e.first * 1000).toISOString()),
  }
}

console.log(
  JSON.stringify(
    {
      study: 'predeclared ETH/USD trailing-realized-volatility negative control',
      feed: FEED,
      sourceSamples: rows.length,
      oracleReadSuccess: priceRows.length - exclusions.oracleRead,
      usableTrailing24hFeatures: volatility.filter(Number.isFinite).length,
      exclusions,
      trainP90VolatilityPct: threshold,
      firstAt: new Date(rows[0].at * 1000).toISOString(),
      lastAt: new Date(rows.at(-1).at * 1000).toISOString(),
      single: outcome('single'),
      split: outcome('split'),
      promotionEligible: false,
      reason:
        'Exploratory control; no walk-forward superiority CI, calibration, or independent-event gate established.',
    },
    null,
    2,
  ),
)
