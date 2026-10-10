// Development-slice ablation fixed in docs/research/venue-capacity-drivers.md
// before this run. This is not a holdout or a production alert.
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { empiricalQuantile, rollingSixHourDrops } from './aave-freeze-event-logic.mjs'
import { assertSeries, crossingEpisodes } from './aave-cash-leading-logic.mjs'

export const HOUR = 3600
export const DAY = 24 * HOUR
export const Q = 100_000_000
export const MAX_GAP = 4 * HOUR

function iso(at) {
  return new Date(at * 1000).toISOString()
}

// A six-hour comparison uses the closest observed sample within one hour,
// never a future row or a path containing an unobserved >4h gap.
export function sixHourDrop(rows, index) {
  const current = rows[index]
  let best = null
  for (let j = index - 1; j >= 0; j--) {
    const lag = current.at - rows[j].at
    if (lag > 7 * HOUR) break
    if (Math.abs(lag - 6 * HOUR) > HOUR) continue
    if (rows.slice(j + 1, index + 1).some((row, k) => row.at - rows[j + k].at > MAX_GAP)) continue
    const error = Math.abs(lag - 6 * HOUR)
    if (!best || error < best.error) best = { prior: rows[j], error }
  }
  return best ? { priorAt: best.prior.at, drop: best.prior.cash - current.cash } : null
}

export function pastBaseline(rows, index) {
  const at = rows[index].at
  const start = at - 14 * DAY
  const history = rows.filter((row) => row.at >= start - 7 * HOUR && row.at < at)
  if (
    history.length < 75 ||
    history[0].at > start + MAX_GAP ||
    history.at(-1).at < at - MAX_GAP ||
    history.some((row, k) => k > 0 && row.at - history[k - 1].at > MAX_GAP)
  )
    return null
  const drops = rollingSixHourDrops(history, at, 14)
  if (drops.length < 60) return null
  return {
    p95: empiricalQuantile(
      drops.map((row) => row.drop),
      0.95,
    ),
    pairs: drops.length,
  }
}

export function firstCrossingInHorizon(rows, index) {
  const at = rows[index].at
  let prior = rows[index]
  for (let j = index + 1; j < rows.length; j++) {
    const row = rows[j]
    if (row.at - prior.at > MAX_GAP) return { complete: false, first: null }
    if (row.at > at + DAY) return { complete: true, first: null }
    if (prior.cash >= Q && row.cash < Q)
      return {
        complete: row.at - at >= 6 * HOUR && row.at - at <= DAY,
        first: { index: j, at: row.at, block: row.block, leadHours: (row.at - at) / HOUR },
      }
    if (row.cash < Q) return { complete: false, first: null }
    if (row.at >= at + DAY) return { complete: true, first: null }
    prior = row
  }
  return { complete: false, first: null }
}

export function suppressFor24Hours(alerts) {
  const kept = []
  let lastAlertAt = -Infinity
  for (const alert of alerts) {
    if (alert.at - lastAlertAt < DAY) continue
    kept.push(alert)
    lastAlertAt = alert.at
  }
  return kept
}

export function evaluate(rows, events) {
  assertSeries(rows)
  const positiveEvents = events
    .filter(
      (event) =>
        event.enabled &&
        (event.type === 'ReserveFrozen' || event.type === 'ReservePaused') &&
        event.asset.toLowerCase() !== event.targetAsset.toLowerCase(),
    )
    .sort((a, b) => a.at - b.at)
  const episodes = crossingEpisodes(rows, Q)
  const rawCrossings = rows
    .slice(1)
    .flatMap((row, i) =>
      row.at - rows[i].at <= MAX_GAP && rows[i].cash >= Q && row.cash < Q
        ? [{ at: row.at, block: row.block, iso: iso(row.at) }]
        : [],
    )
  const candidates = []
  let eligibleAnchors = 0
  let scoreableAnchors = 0
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (!row.active || row.paused || row.cash < Q) continue
    const baseline = pastBaseline(rows, i)
    const observed = sixHourDrop(rows, i)
    if (!baseline || !observed) continue
    eligibleAnchors++
    const outcome = firstCrossingInHorizon(rows, i)
    if (outcome.complete) scoreableAnchors++
    if (observed.drop <= baseline.p95 || !outcome.complete) continue
    const alert = {
      at: row.at,
      iso: iso(row.at),
      block: row.block,
      cash: row.cash,
      sixHourDrop: observed.drop,
      priorAt: observed.priorAt,
      past14dP95: baseline.p95,
      baselinePairs: baseline.pairs,
      targetAt: outcome.first?.at ?? null,
      targetIso: outcome.first ? iso(outcome.first.at) : null,
      leadHours: outcome.first?.leadHours ?? null,
      precedingEvent:
        positiveEvents
          .filter((event) => event.at <= row.at && event.at >= row.at - 6 * HOUR)
          .at(-1) ?? null,
    }
    candidates.push(alert)
  }
  const cashOnly = suppressFor24Hours(candidates)
  const gated = suppressFor24Hours(candidates.filter((alert) => alert.precedingEvent))
  function summary(alerts) {
    const hits = alerts.filter((alert) => alert.targetAt !== null)
    const hitEpisodes = new Set(
      hits
        .filter((alert) => episodes.some((episode) => episode.at === alert.targetAt))
        .map((alert) => alert.targetAt),
    )
    return {
      alerts: alerts.length,
      hits: hits.length,
      falseAlerts: alerts.length - hits.length,
      precision: alerts.length ? hits.length / alerts.length : null,
      hitIndependentEpisodes: hitEpisodes.size,
      independentEpisodes: episodes.length,
      recall: episodes.length ? hitEpisodes.size / episodes.length : null,
      leadHours: hits.map((alert) => alert.leadHours),
      alertsDetail: alerts,
    }
  }
  return {
    status: 'complete',
    exploratory: true,
    rule: {
      qUsd: Q,
      baseline: 'strictly prior 14d empirical p95 of covered 6h cash drops',
      alarm: 'current covered 6h drop > prior p95 at cash >= q',
      suppressionHours: 24,
      target: 'first observed cash < q at +6–24h with complete <=4h intermediate gaps',
      eventGate:
        'same qualifying cash candidates with positive cross-reserve freeze/pause in prior 6h, then independent 24h suppression',
    },
    samples: rows.length,
    span: { first: iso(rows[0].at), last: iso(rows.at(-1).at) },
    eligibleAnchors,
    scoreableAnchors,
    candidateAlarms: candidates.length,
    rawCrossings,
    independentEpisodes: episodes.map((episode) => ({ ...episode, iso: iso(episode.at) })),
    cashOnly: summary(cashOnly),
    eventGated: summary(gated),
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const opts = Object.fromEntries(
    process.argv
      .slice(2)
      .flatMap((arg, i, args) => (arg.startsWith('--') ? [[arg.slice(2), args[i + 1]]] : [])),
  )
  if (!opts.out) throw new Error('Pass --out to save the complete offline result')
  const manifest = JSON.parse(readFileSync('data/research/venue-signals/manifest.json', 'utf8'))
  const pathFor = (name) => `data/research/venue-signals/${manifest.artifacts[name].file}`
  const rows = JSON.parse(
    readFileSync(opts['cash-in'] || pathFor('aave-usde-cash-mar-jun-2026'), 'utf8'),
  ).rows
  const events = JSON.parse(
    readFileSync(opts['events-in'] || pathFor('aave-freeze-events-400d'), 'utf8'),
  ).events
  const result = evaluate(rows, events)
  const tmp = `${opts.out}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(result))
  renameSync(tmp, opts.out)
  console.log(
    JSON.stringify(
      {
        cashOnly: result.cashOnly,
        eventGated: result.eventGated,
        rawCrossings: result.rawCrossings,
        independentEpisodes: result.independentEpisodes,
      },
      null,
      2,
    ),
  )
}
