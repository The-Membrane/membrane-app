// Fixed before opening the 400-day outcome series. Offline evaluation only;
// this script does not issue RPC calls or produce a product alert.
import { createHash } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { evaluate, DAY, HOUR, Q } from './aave-cash-event-ablation.mjs'
import { assertSeries, independentControls } from './aave-cash-leading-logic.mjs'

export const CASH_SHA256 = '8489c2135c2d0a981d948876b16fd40e409e710e9f1d169ef3c23aa99c7b9681'
export const EVENTS_SHA256 = 'b9492de70a178957531a810917232e7e50a3c4fbe85fe3cf464c88d772df120f'
export const GRID = Object.freeze({ first: 23_229_806, last: 26_052_206, step: 900 })
export const FIXED_RULE = Object.freeze({
  qUsd: Q,
  baseline: 'strictly prior 14d empirical p95 of covered 6h cash drops',
  alert: 'covered 6h cash drop > past-only p95 with USDe cash >= q; no fitted threshold',
  outcome: 'first sampled crossing below q at +6–24h, with <=4h adjacent gaps',
  eventLookbackHours: 6,
  eventGate: 'positive other-reserve freeze/pause before candidate; independent 24h cooldown',
  split: 'first 70% of chronological samples for training, last 30% holdout, 24h purge either side',
  promotionGate: {
    minIndependentEpisodes: 20,
    minIndependentControls: 20,
    minLeadHours: 6,
    holdoutPrecision: 0.8,
    holdoutRecall: 0.5,
    eventPrecisionLift: 0.15,
    maxRecallLoss: 0.1,
  },
})

const iso = (at) => new Date(at * 1000).toISOString()

export function verifyBytes(bytes, expectedSha256) {
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== expectedSha256) throw new Error(`Source SHA-256 mismatch: ${actual}`)
  return actual
}

export function validateGrid(artifact, expected = GRID) {
  const { rows, grid, coverage } = artifact
  if (artifact.status !== 'complete' || artifact.failedReadCount !== 0)
    throw new Error('Incomplete cash source')
  if (
    !grid ||
    grid.first !== expected.first ||
    grid.last !== expected.last ||
    grid.step !== expected.step ||
    (expected.last - expected.first) % expected.step !== 0
  )
    throw new Error('Wrong fixed block grid')
  const count = (expected.last - expected.first) / expected.step + 1
  if (!Array.isArray(rows) || rows.length !== count) throw new Error('Incomplete grid row count')
  if (
    !coverage ||
    coverage.complete !== true ||
    coverage.expected !== count ||
    coverage.present !== count ||
    coverage.missing !== 0 ||
    coverage.maxGapSeconds > 4 * HOUR
  )
    throw new Error('Incomplete grid coverage')
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].block !== expected.first + i * expected.step)
      throw new Error(`Wrong block grid at ${i}`)
  }
  assertSeries(rows)
  return rows
}

function scoreArm(alerts, episodes) {
  const episodeTimes = new Set(episodes.map((episode) => episode.at))
  const matched = alerts.filter((alert) => episodeTimes.has(alert.targetAt))
  const hitTimes = new Set(matched.map((alert) => alert.targetAt))
  return {
    independentEpisodes: episodes.length,
    alerts: alerts.length,
    hits: matched.length,
    falseAlerts: alerts.length - matched.length,
    precision: alerts.length ? matched.length / alerts.length : null,
    hitIndependentEpisodes: hitTimes.size,
    recall: episodes.length ? hitTimes.size / episodes.length : null,
    leadHours: matched.map((alert) => alert.leadHours),
    alertsDetail: alerts,
  }
}

export function splitAndScore(rows, episodes, cashAlerts, gatedAlerts) {
  const boundaryIndex = Math.floor(rows.length * 0.7)
  const boundaryAt = rows[boundaryIndex].at
  let trainEnd = boundaryIndex
  while (trainEnd > 0 && rows[trainEnd - 1].at > boundaryAt - DAY) trainEnd--
  let holdoutStart = boundaryIndex
  while (holdoutStart < rows.length && rows[holdoutStart].at < boundaryAt + DAY) holdoutStart++
  const indexByTime = new Map(rows.map((row, i) => [row.at, i]))
  const selected = (items, start, end) =>
    items.filter((item) => {
      const i = indexByTime.get(item.at)
      return i !== undefined && i >= start && i < end
    })
  const build = (start, end) => {
    const segmentEpisodes = selected(episodes, start, end)
    return {
      episodes: segmentEpisodes,
      cashOnly: scoreArm(selected(cashAlerts, start, end), segmentEpisodes),
      eventGated: scoreArm(selected(gatedAlerts, start, end), segmentEpisodes),
    }
  }
  const train = build(0, trainEnd)
  const holdout = build(holdoutStart, rows.length)
  const totalEpisodes = train.episodes.length + holdout.episodes.length
  const p = FIXED_RULE.promotionGate
  let promotion = { status: 'failed', reason: 'promotion thresholds not met' }
  if (!holdout.episodes.length || !holdout.cashOnly.alerts || !holdout.eventGated.alerts)
    promotion = {
      status: 'unassessable',
      reason: 'zero holdout episodes or zero alerts in a comparator arm',
    }
  else if (totalEpisodes < p.minIndependentEpisodes)
    promotion = { status: 'failed', reason: 'fewer than 20 independent train+holdout episodes' }
  return {
    split: {
      boundaryIndex,
      boundaryAt,
      boundaryIso: iso(boundaryAt),
      trainEnd,
      trainLastAt: rows[trainEnd - 1]?.at ?? null,
      holdoutStart,
      holdoutFirstAt: rows[holdoutStart]?.at ?? null,
      purgeSeconds: DAY,
    },
    train,
    holdout,
    promotion,
  }
}

export function evaluateFullGrid(cashArtifact, eventsArtifact) {
  if (
    cashArtifact.study !== 'Aave V3 USDe full 400d pinned cash grid' ||
    cashArtifact.chainId !== 1
  )
    throw new Error('Wrong cash study or chain')
  if (
    cashArtifact.pool?.toLowerCase() !== '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2' ||
    cashArtifact.underlying?.toLowerCase() !== '0x4c9edd5852cd905f086c759e8383e09bff1e68b3'
  )
    throw new Error('Wrong reserve identity')
  const rows = validateGrid(cashArtifact)
  if (
    eventsArtifact.status !== 'complete' ||
    eventsArtifact.study !== 'Aave V3 Ethereum cross-reserve configuration event census' ||
    eventsArtifact.from !== GRID.first ||
    eventsArtifact.to !== GRID.last ||
    !Array.isArray(eventsArtifact.events)
  )
    throw new Error('Incomplete or mismatched event census')
  const base = evaluate(rows, eventsArtifact.events)
  const split = splitAndScore(
    rows,
    base.independentEpisodes,
    base.cashOnly.alertsDetail,
    base.eventGated.alertsDetail,
  )
  const allEpisodes = base.independentEpisodes
  const trainControls = independentControls(rows, Q, allEpisodes, 0, split.split.trainEnd)
  const holdoutControls = independentControls(
    rows,
    Q,
    allEpisodes,
    split.split.holdoutStart,
    rows.length,
  )
  split.train.independentControls = trainControls
  split.holdout.independentControls = holdoutControls
  const p = FIXED_RULE.promotionGate
  const totalEpisodes = split.train.episodes.length + split.holdout.episodes.length
  const totalControls = trainControls + holdoutControls
  if (split.promotion.status !== 'unassessable') {
    const cash = split.holdout.cashOnly
    const gated = split.holdout.eventGated
    const met =
      totalEpisodes >= p.minIndependentEpisodes &&
      totalControls >= p.minIndependentControls &&
      gated.precision >= p.holdoutPrecision &&
      gated.recall >= p.holdoutRecall &&
      gated.precision - cash.precision >= p.eventPrecisionLift &&
      cash.recall - gated.recall <= p.maxRecallLoss &&
      gated.leadHours.every((lead) => lead >= p.minLeadHours)
    split.promotion = {
      status: met ? 'passed' : 'failed',
      reason: met ? 'all prespecified gates passed' : 'one or more prespecified gates failed',
      checks: {
        totalEpisodes,
        totalControls,
        holdoutCashPrecision: cash.precision,
        holdoutCashRecall: cash.recall,
        holdoutEventPrecision: gated.precision,
        holdoutEventRecall: gated.recall,
        precisionLift: gated.precision - cash.precision,
        recallLoss: cash.recall - gated.recall,
      },
    }
  }
  return {
    status: 'complete',
    study: 'Fixed full-400d walk-forward Aave USDe cash and cross-asset-event ablation',
    exploratory: true,
    rule: FIXED_RULE,
    sources: { cashSha256: CASH_SHA256, eventCensusSha256: EVENTS_SHA256 },
    grid: { ...cashArtifact.grid, ...cashArtifact.coverage },
    samples: rows.length,
    span: { first: iso(rows[0].at), last: iso(rows.at(-1).at) },
    base: {
      eligibleAnchors: base.eligibleAnchors,
      scoreableAnchors: base.scoreableAnchors,
      candidateAlarms: base.candidateAlarms,
      rawCrossings: base.rawCrossings,
      independentEpisodes: base.independentEpisodes,
    },
    ...split,
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const opts = Object.fromEntries(
    process.argv
      .slice(2)
      .flatMap((arg, i, args) => (arg.startsWith('--') ? [[arg.slice(2), args[i + 1]]] : [])),
  )
  if (!opts['cash-in'] || !opts['events-in'] || !opts.out)
    throw new Error('Pass --cash-in, --events-in, and --out; no RPC fallback exists')
  const cashBytes = readFileSync(opts['cash-in'])
  const eventsBytes = readFileSync(opts['events-in'])
  verifyBytes(cashBytes, CASH_SHA256)
  verifyBytes(eventsBytes, EVENTS_SHA256)
  const result = evaluateFullGrid(JSON.parse(cashBytes), JSON.parse(eventsBytes))
  const tmp = `${opts.out}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(result))
  renameSync(tmp, opts.out)
  const compact = (period) => ({
    independentEpisodes: period.episodes.length,
    independentControls: period.independentControls,
    cashOnly: { ...period.cashOnly, alertsDetail: undefined },
    eventGated: { ...period.eventGated, alertsDetail: undefined },
  })
  console.log(
    JSON.stringify(
      {
        split: result.split,
        train: compact(result.train),
        holdout: compact(result.holdout),
        promotion: result.promotion,
      },
      null,
      2,
    ),
  )
}
