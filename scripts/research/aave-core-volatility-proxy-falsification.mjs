// Past-only Aave Core USDC/USDT CASH-PROXY falsification. Never a holder-exit alert.
// Threshold and gate frozen in docs/research/venue-capacity-drivers.md before this join.
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, linkSync, readFileSync, statfsSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GRID, COUNT } from './multi-market-exit-prevalence.mjs'
import {
  calendarGroups,
  deriveCohort,
  evaluate,
  features,
  INPUTS,
  readSources,
} from './cash-runway-proxy-screen.mjs'

export const STUDY = 'aave-core-eth-vol-cash-proxy-falsification-v1'
export const PRICE_PATH = resolve(
  'data/research/venue-signals/d873e9278fe740c470e91639a2e48c5542ba14b0ea3086e109177388ab0460e9.json',
)
export const PRICE_SHA = 'd873e9278fe740c470e91639a2e48c5542ba14b0ea3086e109177388ab0460e9'
export const VOL_THRESHOLD_PCT = 5.0486
export const MARKETS = ['aave-usdc', 'USDT']
const HOUR = 3600
const DAY = 24 * HOUR
const Q = 1_000_000
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const assert = (ok, message) => {
  if (!ok) throw new Error(message)
}

export function loadInputs() {
  const { five, expansion } = readSources()
  const bytes = readFileSync(PRICE_PATH)
  assert(sha(bytes) === PRICE_SHA, 'Price physical SHA mismatch')
  const price = JSON.parse(bytes)
  assert(price.study === 'ETH/USD Chainlink as-of pinned Curve quote blocks', 'Wrong price study')
  assert(
    price.feed.toLowerCase() === '0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419',
    'Wrong Chainlink feed',
  )
  assert(price.prices.length === 3184, 'Frozen price count changed')
  assert(
    price.prices.every((row, i) => i === 0 || row.at > price.prices[i - 1].at),
    'Price chronology changed',
  )
  return { five, expansion, prices: price.prices }
}

const validPrice = (p) =>
  Number.isSafeInteger(p.at) &&
  Number.isSafeInteger(p.oracleUpdatedAt) &&
  p.oracleUpdatedAt <= p.at &&
  p.at - p.oracleUpdatedAt <= 4 * HOUR &&
  Number.isFinite(p.price) &&
  p.price > 0 &&
  BigInt(p.answeredInRound) >= BigInt(p.roundId)

export function pastVolAt(prices, anchorAt) {
  assert(Number.isSafeInteger(anchorAt), 'Invalid anchor timestamp')
  let lo = 0,
    hi = prices.length
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (prices[mid].at <= anchorAt) lo = mid + 1
    else hi = mid
  }
  const last = lo - 1
  if (last < 0) return { value: null, reason: 'no-past-price' }
  const recent = prices[last]
  if (
    !validPrice(recent) ||
    recent.oracleUpdatedAt > anchorAt ||
    anchorAt - recent.oracleUpdatedAt > 4 * HOUR
  )
    return { value: null, reason: 'stale-or-invalid-asof-price' }
  let first = last
  while (first > 0 && anchorAt - prices[first - 1].at <= DAY) first--
  if (last - first < 6 || prices[last].at - prices[first].at < 20 * HOUR)
    return { value: null, reason: 'insufficient-trailing-history' }
  let sumSq = 0
  for (let i = first; i <= last; i++) {
    const p = prices[i]
    if (!validPrice(p) || p.oracleUpdatedAt > anchorAt || anchorAt - p.at > DAY)
      return { value: null, reason: 'invalid-trailing-price' }
    if (i > first) {
      if (p.at - prices[i - 1].at > 4 * HOUR)
        return { value: null, reason: 'trailing-gap-over-four-hours' }
      const change = Math.log(p.price / prices[i - 1].price)
      sumSq += change * change
    }
  }
  return {
    value: 100 * Math.sqrt(sumSq),
    latestPriceAt: recent.at,
    latestOracleUpdatedAt: recent.oracleUpdatedAt,
    latestOracleAgeSeconds: anchorAt - recent.oracleUpdatedAt,
    returns: last - first,
  }
}

export function incidents(candidates, trigger) {
  const lastByMarket = new Map(),
    alerts = []
  for (const row of [...candidates].sort(
    (a, b) => a.at - b.at || a.market.localeCompare(b.market),
  )) {
    if (!trigger(row)) continue
    const prior = lastByMarket.get(row.market)
    if (prior !== undefined && row.at - prior < DAY) continue
    lastByMarket.set(row.market, row.at)
    alerts.push(row)
  }
  return alerts
}

function summarize(alerts, events, groups) {
  const hits = []
  for (const alert of alerts) {
    const event = events.find(
      (e) =>
        e.market === alert.market &&
        e.priorHealthyAt - alert.at >= 6 * HOUR &&
        e.at - alert.at <= DAY,
    )
    if (event)
      hits.push({
        market: alert.market,
        alertBlock: alert.block,
        eventBlock: event.block,
        conservativeLeadSeconds: event.priorHealthyAt - alert.at,
        sampledLeadSeconds: event.at - alert.at,
        group: groups.get(`${event.market}:${event.block}`),
      })
  }
  return {
    alerts: alerts.length,
    hits: hits.length,
    falseAlerts: alerts.length - hits.length,
    precision: alerts.length ? hits.length / alerts.length : null,
    distinctHitGroups: new Set(hits.map((hit) => hit.group)).size,
    matched: hits,
  }
}

const percentile = (values, pct) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  return sorted.length ? sorted[Math.floor(((sorted.length - 1) * pct) / 100)] : null
}

export function chooseCashComparator(train, events, groups, maxTrainAlerts) {
  if (maxTrainAlerts === 0) return null
  const choices = []
  for (const field of ['cashHeadroom', 'cashDrop24']) {
    for (let pct = 1; pct <= 99; pct++) {
      const threshold = percentile(
        train.map((row) => row[field]),
        pct,
      )
      if (threshold === null) continue
      const trigger = (row) =>
        field === 'cashHeadroom' ? row[field] <= threshold : row[field] >= threshold
      const score = summarize(incidents(train, trigger), events, groups)
      if (score.alerts === 0 || score.alerts > maxTrainAlerts) continue
      choices.push({ field, percentile: pct, threshold, score })
    }
  }
  choices.sort(
    (a, b) =>
      b.score.precision - a.score.precision ||
      b.score.distinctHitGroups - a.score.distinctHitGroups ||
      a.score.alerts - b.score.alerts ||
      ['cashHeadroom', 'cashDrop24'].indexOf(a.field) -
        ['cashHeadroom', 'cashDrop24'].indexOf(b.field) ||
      a.percentile - b.percentile,
  )
  return choices[0] || null
}

export function evaluateProxy(inputs) {
  const { five, expansion, prices } = inputs
  const sourceScreen = evaluate(five, expansion)
  const boundaryAt = sourceScreen.frozen.boundaryAt
  const cohort = deriveCohort(five, expansion)
  const groups = calendarGroups(cohort.all)
  const events = cohort.cash.filter((e) => MARKETS.includes(e.market))
  const pauses = cohort.pause.filter((e) => MARKETS.includes(e.market))
  const rows = [...five.rows, ...expansion.entries].filter((row) => MARKETS.includes(row.market))
  assert(rows.length === 2 * COUNT, 'Core two-market grid changed')
  const byMarket = new Map(MARKETS.map((market) => [market, new Map()]))
  for (const row of rows) byMarket.get(row.market).set(row.block, row)
  for (const event of events) {
    const prior = byMarket.get(event.market).get(event.block - GRID.step)
    assert(
      prior && Number.isSafeInteger(prior.at) && prior.at < event.at,
      'Missing prior onset bracket',
    )
    event.priorHealthyAt = prior.at
  }
  const volByAt = new Map(),
    candidates = [],
    missing = {},
    ledger = []
  for (const row of rows) {
    if (!volByAt.has(row.at)) volByAt.set(row.at, pastVolAt(prices, row.at))
    const vol = volByAt.get(row.at)
    const cash = features(byMarket.get(row.market), row.block)
    const split =
      row.at + DAY < boundaryAt - DAY ? 'train' : row.at >= boundaryAt + DAY ? 'holdout' : 'embargo'
    const reason = cash.reason || vol.reason || (split === 'embargo' ? 'split-embargo' : null)
    ledger.push({
      market: row.market,
      block: row.block,
      at: row.at,
      split,
      reason,
      latestPriceAt: vol.latestPriceAt ?? null,
      latestOracleUpdatedAt: vol.latestOracleUpdatedAt ?? null,
      latestOracleAgeSeconds: vol.latestOracleAgeSeconds ?? null,
      volPct: vol.value,
      cashHeadroom: cash.cashHeadroom ?? null,
      cashDrop24: cash.cashDrop24 ?? null,
    })
    if (reason) {
      missing[reason] = (missing[reason] || 0) + 1
      continue
    }
    candidates.push({
      market: row.market,
      block: row.block,
      at: row.at,
      split,
      volPct: vol.value,
      latestOracleUpdatedAt: vol.latestOracleUpdatedAt,
      latestOracleAgeSeconds: vol.latestOracleAgeSeconds,
      cashHeadroom: cash.cashHeadroom,
      cashDrop24: cash.cashDrop24,
    })
  }
  const train = candidates.filter((r) => r.split === 'train'),
    holdout = candidates.filter((r) => r.split === 'holdout')
  const trainEvents = events.filter((e) => e.at < boundaryAt - DAY)
  const holdoutEvents = events.filter((e) => e.at >= boundaryAt + DAY)
  const holdoutEventGroups = new Set(holdoutEvents.map((e) => groups.get(`${e.market}:${e.block}`)))
    .size
  const trainVol = summarize(
    incidents(train, (r) => r.volPct >= VOL_THRESHOLD_PCT),
    trainEvents,
    groups,
  )
  const holdoutVol = summarize(
    incidents(holdout, (r) => r.volPct >= VOL_THRESHOLD_PCT),
    holdoutEvents,
    groups,
  )
  const cashChoice = chooseCashComparator(train, trainEvents, groups, trainVol.alerts)
  const cashTrigger =
    cashChoice &&
    ((r) =>
      cashChoice.field === 'cashHeadroom'
        ? r.cashHeadroom <= cashChoice.threshold
        : r.cashDrop24 >= cashChoice.threshold)
  const holdoutCash = cashChoice
    ? summarize(incidents(holdout, cashTrigger), holdoutEvents, groups)
    : null
  const gate =
    holdoutVol.distinctHitGroups >= 2 &&
    holdoutCash &&
    holdoutVol.alerts <= holdoutCash.alerts &&
    holdoutVol.precision > holdoutCash.precision
      ? 'proxy-feasibility-only'
      : 'broad-eth-volatility-not-retained'
  return {
    study: STUDY,
    caveat:
      'Past-only cash-runway proxy test, not holder-executable prediction or real local lead.',
    frozen: {
      markets: MARKETS,
      q: Q,
      volThresholdPct: VOL_THRESHOLD_PCT,
      windowSeconds: DAY,
      minimumReturns: 6,
      minimumSpanSeconds: 20 * HOUR,
      maxOracleAgeSeconds: 4 * HOUR,
      horizonSeconds: [6 * HOUR, DAY],
      cooldownSeconds: DAY,
      splitBlock: GRID.first + Math.floor(COUNT * 0.7) * GRID.step,
      boundaryAt,
      embargoSeconds: DAY,
      sourcePhysicalSha256: {
        ...Object.fromEntries(Object.entries(INPUTS).map(([k, v]) => [k, v.sha256])),
        price: PRICE_SHA,
      },
    },
    denominator: {
      gridRows: rows.length,
      eligibleRows: candidates.length,
      missing,
      cashOnsets: events.length,
      pauseOnsets: pauses.length,
      trainRows: train.length,
      holdoutRows: holdout.length,
      trainEvents: trainEvents.length,
      holdoutEvents: holdoutEvents.length,
      holdoutEventGroups,
    },
    feasibility:
      holdoutEventGroups < 2
        ? 'underpowered-one-holdout-proxy-episode'
        : 'eligible-for-frozen-gate',
    events,
    ledger,
    trainVol,
    holdoutVol,
    cashOnlyTrainingSelection: cashChoice,
    holdoutCash,
    gate,
  }
}

export function saveResult(out, result) {
  assert(!existsSync(out), 'Refusing to overwrite volatility screen')
  const payload = { result, resultSha256: sha(JSON.stringify(result)) }
  const bytes = JSON.stringify(payload)
  const disk = statfsSync(dirname(out), { bigint: true })
  assert(
    disk.bavail * disk.bsize - BigInt(Buffer.byteLength(bytes)) >= 1_073_741_824n,
    'Disk reserve reached',
  )
  const pending = `${out}.pending-${randomUUID()}`
  try {
    writeFileSync(pending, bytes, { flag: 'wx', mode: 0o600 })
    verifySaved(pending, result)
    linkSync(pending, out)
  } finally {
    if (existsSync(pending)) unlinkSync(pending)
  }
  return sha(readFileSync(out))
}

export function verifySaved(path, expected = null) {
  const bytes = readFileSync(path)
  const payload = JSON.parse(bytes)
  assert(payload.result?.study === STUDY, 'Saved study mismatch')
  assert(payload.resultSha256 === sha(JSON.stringify(payload.result)), 'Saved result seal mismatch')
  if (expected)
    assert(JSON.stringify(payload.result) === JSON.stringify(expected), 'Saved result changed')
  assert(payload.result.ledger?.length === 2 * COUNT, 'Saved row ledger incomplete')
  assert(
    payload.result.frozen.sourcePhysicalSha256.price === PRICE_SHA,
    'Saved price source changed',
  )
  return sha(bytes)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = resolve(
    'data/research/venue-signals/aave-core-volatility-proxy-falsification-v1.json',
  )
  const result = evaluateProxy(loadInputs())
  if (process.argv.includes('--verify'))
    process.stdout.write(
      JSON.stringify({ out, physicalSha256: verifySaved(out, result), verified: true }) + '\n',
    )
  else if (process.argv.includes('--run'))
    process.stdout.write(
      JSON.stringify({
        out,
        physicalSha256: saveResult(out, result),
        denominator: result.denominator,
        holdoutVol: result.holdoutVol,
        holdoutCash: result.holdoutCash,
        gate: result.gate,
      }) + '\n',
    )
  else
    process.stdout.write(
      JSON.stringify({
        dry: true,
        denominator: result.denominator,
        trainVol: result.trainVol,
        holdoutVol: result.holdoutVol,
        cashOnlyTrainingSelection: result.cashOnlyTrainingSelection,
        holdoutCash: result.holdoutCash,
        gate: result.gate,
      }) + '\n',
    )
}
