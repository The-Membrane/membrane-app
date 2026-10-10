// Frozen exploratory falsification; never an executable exit or a live alert.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { CASH_SHA256, verifyBytes, validateGrid } from './aave-cash-full-grid-eval.mjs'
import {
  HOUR,
  DAY,
  MAX_GAP,
  assertSeries,
  atOrBefore,
  crossingEpisodes,
  splitIndex,
} from './aave-cash-leading-logic.mjs'

export const Q = 100_000_000
export const DEBT_RISE_USD = 25_000_000
const SOURCE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../data/research/venue-signals',
  `${CASH_SHA256}.json`,
)

const iso = (at) => new Date(at * 1000).toISOString()
const healthy = (row) => row.active && !row.paused && row.cash >= Q

export function debtRise6h(rows, i) {
  const prior = atOrBefore(rows, i, 6 * HOUR)
  return prior
    ? { riseUsd: rows[i].debt - prior.debt, priorAt: prior.at, lagSeconds: rows[i].at - prior.at }
    : null
}

// Labels only: no value from this walk contributes to the warning feature.
export function evaluateWarning(rows, i, episodes) {
  const start = rows[i].at
  const onsetIndices = new Set(episodes.map((event) => event.index))
  let prior = rows[i]
  for (let j = i + 1; j < rows.length; j++) {
    const row = rows[j]
    if (row.at - prior.at > MAX_GAP) return { status: 'missingHorizon' }
    if (!row.active || row.paused) return { status: 'permissionHorizon' }
    if (row.cash < Q) {
      if (row.at > start + DAY) return { status: 'quiet' }
      if (!onsetIndices.has(j)) return { status: 'unlabelledLow', onsetAt: row.at }
      const leadSeconds = prior.at - start
      return {
        status: leadSeconds >= 6 * HOUR && leadSeconds <= DAY ? 'hit' : 'late',
        onsetAt: row.at,
        lastHealthyAt: prior.at,
        leadSeconds,
      }
    }
    if (row.at >= start + DAY) return { status: 'quiet' }
    prior = row
  }
  return { status: 'missingHorizon' }
}

function segmentFor(i, split) {
  if (i < split.trainEnd) return 'train'
  if (i >= split.holdoutStart) return 'holdout'
  return 'purge'
}

export function screen(rows) {
  assertSeries(rows)
  const split = splitIndex(rows)
  const episodes = crossingEpisodes(rows, Q)
  const episodeSet = new Set(episodes.map((e) => e.at))
  const segments = Object.fromEntries(
    ['train', 'holdout'].map((name) => [
      name,
      {
        eligibleAnchors: 0,
        coveredHistoryAnchors: 0,
        quietAnchors: 0,
        candidateWarnings: 0,
        cooldownSuppressed: 0,
        emittedWarnings: 0,
        scorableWarnings: 0,
        hits: 0,
        nonhits: 0,
        missingHistory: 0,
        missingHorizon: 0,
        permissionExclusions: 0,
        atRiskSeconds: 0,
        warnings: [],
        comparators: {},
      },
    ]),
  )
  const eligible = []
  const lastWarningAt = { train: -Infinity, holdout: -Infinity }
  for (let i = 0; i < rows.length; i++) {
    const name = segmentFor(i, split)
    if (name === 'purge') continue
    const out = segments[name]
    const row = rows[i]
    if (!healthy(row)) {
      out.permissionExclusions += row.cash >= Q && (!row.active || row.paused) ? 1 : 0
      continue
    }
    out.eligibleAnchors++
    if (
      i > 0 &&
      segmentFor(i - 1, split) === name &&
      healthy(rows[i - 1]) &&
      row.at - rows[i - 1].at <= MAX_GAP
    )
      out.atRiskSeconds += row.at - rows[i - 1].at
    const outcome = evaluateWarning(rows, i, episodes)
    if (outcome.status === 'missingHorizon') out.missingHorizon++
    else if (outcome.status === 'permissionHorizon') out.permissionExclusions++
    else if (outcome.status === 'quiet') out.quietAnchors++
    const debt = debtRise6h(rows, i)
    if (!debt) {
      out.missingHistory++
      continue
    }
    out.coveredHistoryAnchors++
    eligible.push({
      i,
      name,
      outcome,
      debt,
      headroomScore: Q / row.cash,
      momentumScore: Math.max(0, (atOrBefore(rows, i, 6 * HOUR)?.cash ?? row.cash) - row.cash),
    })
    if (debt.riseUsd < DEBT_RISE_USD) continue
    out.candidateWarnings++
    if (row.at - lastWarningAt[name] < DAY) {
      out.cooldownSuppressed++
      continue
    }
    lastWarningAt[name] = row.at
    out.emittedWarnings++
    const scorable = !['missingHorizon', 'permissionHorizon'].includes(outcome.status)
    if (scorable) {
      out.scorableWarnings++
      if (outcome.status === 'hit') out.hits++
      else out.nonhits++
    }
    out.warnings.push({
      block: row.block,
      at: row.at,
      debtRiseUsd: debt.riseUsd,
      lookbackSeconds: debt.lagSeconds,
      ...outcome,
    })
  }
  // Fit a score threshold on training feature values alone at the debt rule's
  // emitted-warning budget, then freeze it for holdout. No outcome labels fit it.
  function select(items, score, threshold) {
    const chosen = []
    let lastAt = -Infinity
    for (const item of items) {
      const at = rows[item.i].at
      if (item[score] < threshold || at - lastAt < DAY) continue
      chosen.push(item)
      lastAt = at
    }
    return chosen
  }
  const bySegment = Object.fromEntries(
    ['train', 'holdout'].map((name) => [name, eligible.filter((item) => item.name === name)]),
  )
  for (const [key, score] of [
    ['headroom', 'headroomScore'],
    ['cashMomentum6h', 'momentumScore'],
  ]) {
    const training = bySegment.train
    const values = [...new Set(training.map((item) => item[score]))].sort((a, b) => a - b)
    const choices = [Infinity, ...values].map((threshold) => ({
      threshold,
      alerts: select(training, score, threshold).length,
    }))
    choices.sort(
      (a, b) =>
        Math.abs(a.alerts - segments.train.emittedWarnings) -
          Math.abs(b.alerts - segments.train.emittedWarnings) ||
        a.alerts - b.alerts ||
        b.threshold - a.threshold,
    )
    const frozen = choices[0] ?? { threshold: Infinity, alerts: 0 }
    for (const name of ['train', 'holdout']) {
      const out = segments[name]
      const selected = select(bySegment[name], score, frozen.threshold)
      const scorable = selected.filter(
        (item) => !['missingHorizon', 'permissionHorizon'].includes(item.outcome.status),
      )
      const hits = scorable.filter((item) => item.outcome.status === 'hit')
      out.comparators[key] = {
        threshold: Number.isFinite(frozen.threshold) ? frozen.threshold : null,
        trainBudget: segments.train.emittedWarnings,
        trainBudgetMismatch: frozen.alerts - segments.train.emittedWarnings,
        emittedWarnings: selected.length,
        scorableWarnings: scorable.length,
        hits: hits.length,
        nonhits: scorable.length - hits.length,
        precision: scorable.length ? hits.length / scorable.length : null,
        selectedBlocks: selected.map((item) => rows[item.i].block),
      }
    }
  }
  for (const name of ['train', 'holdout']) {
    const out = segments[name]
    out.independentEpisodes = episodes
      .filter((e) => segmentFor(e.index, split) === name)
      .map((e) => ({ block: e.block, at: e.at, iso: iso(e.at) }))
    out.hitIndependentEpisodes = new Set(
      out.warnings
        .filter((w) => w.status === 'hit' && episodeSet.has(w.onsetAt))
        .map((w) => w.onsetAt),
    ).size
    out.precision = out.scorableWarnings ? out.hits / out.scorableWarnings : null
    out.atRiskMarketWeeks = out.atRiskSeconds / (7 * DAY)
    out.nonhitsPerAtRiskMarketWeek = out.atRiskMarketWeeks
      ? out.nonhits / out.atRiskMarketWeeks
      : null
  }
  const totalScorable = segments.train.scorableWarnings + segments.holdout.scorableWarnings
  const totalHits = segments.train.hits + segments.holdout.hits
  const totalNonhits = segments.train.nonhits + segments.holdout.nonhits
  const totalWeeks = segments.train.atRiskMarketWeeks + segments.holdout.atRiskMarketWeeks
  const precision = totalScorable ? totalHits / totalScorable : null
  const burden = totalWeeks ? totalNonhits / totalWeeks : null
  const retired = (totalScorable >= 10 && precision < 0.5) || (burden !== null && burden > 1)
  return {
    status: 'complete',
    exploratory: true,
    sourceSha256: CASH_SHA256,
    rule: {
      qUsd: Q,
      debtRiseUsd: DEBT_RISE_USD,
      lookbackHours: 6,
      cooldownHours: 24,
      minLastHealthyLeadHours: 6,
      maxLeadHours: 24,
      comparator:
        'past-only training threshold matched to train emitted-warning budget, frozen for holdout; not an executable exit',
    },
    split,
    samples: rows.length,
    episodes: episodes.length,
    segments,
    total: {
      scorableWarnings: totalScorable,
      hits: totalHits,
      nonhits: totalNonhits,
      precision,
      atRiskMarketWeeks: totalWeeks,
      nonhitsPerAtRiskMarketWeek: burden,
      triage: retired ? 'retired' : 'insufficient_or_not_retired_not_validated',
    },
  }
}

export function run() {
  const bytes = readFileSync(SOURCE)
  verifyBytes(bytes, CASH_SHA256)
  const artifact = JSON.parse(bytes)
  if (artifact.study !== 'Aave V3 USDe full 400d pinned cash grid' || artifact.chainId !== 1)
    throw new Error('Wrong pinned source identity')
  return screen(validateGrid(artifact))
}
