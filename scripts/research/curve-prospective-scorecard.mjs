// Read-only evaluation of sealed, prospective nominal $1m Curve quote issues.
// Calendar splits and episode selection are fixed before observing outcomes.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  readHistorical,
  verifyIssues as verifyQuoteIssues,
  OUT as QUOTE_OUT,
  HORIZONS as QUOTE_HORIZONS,
} from './curve-prospective-forecast.mjs'
import {
  verifyIssues as verifyDurationIssues,
  OUT as DURATION_OUT,
} from './curve-prospective-duration.mjs'
import {
  readHistorical as readLevelHistorical,
  verifyIssues as verifyLevelIssues,
  OUT as LEVEL_OUT,
  HORIZONS as LEVEL_HORIZONS,
} from './curve-prospective-level-forecast.mjs'
import { OUT as CHECKPOINTS, readValidatedCheckpoints } from './curve-prospective-quote.mjs'
import { HORIZONS as DURATION_HORIZONS } from './curve-quote-duration-study.mjs'

export const STUDY = 'curve-prospective-nominal-quote-scorecard-v2'
export const PERIODS = Object.freeze([
  { name: 'development', startUtc: '2026-09-27T00:00:00.000Z', endUtc: '2027-05-27T00:00:00.000Z' },
  { name: 'calibration', startUtc: '2027-05-27T00:00:00.000Z', endUtc: '2028-01-27T00:00:00.000Z' },
  { name: 'evaluation', startUtc: '2028-01-27T00:00:00.000Z', endUtc: null },
])
const HOUR = 3600
const ENDPOINT_TOLERANCE = 90 * 60
const MIN_NONOVERLAPPING_PAIRED = 30
const MIN_DURATION_EVENTS = 5

function readLane(out) {
  if (!existsSync(out)) return { issues: [], scores: [] }
  const issues = [],
    scores = []
  for (const filename of readdirSync(out).filter((name) => name.endsWith('.json'))) {
    const saved = JSON.parse(readFileSync(join(out, filename), 'utf8'))
    if (filename.endsWith('.score.json')) scores.push(saved)
    else issues.push({ ...saved, filename })
  }
  return { issues, scores }
}

function periodOf(issuedAtUtc, periods) {
  const at = Date.parse(issuedAtUtc)
  if (!Number.isFinite(at)) throw new Error('Invalid issue time')
  return (
    periods.find(
      (period) =>
        at >= Date.parse(period.startUtc) &&
        (period.endUtc === null || at < Date.parse(period.endUtc)),
    )?.name ?? 'outside_periods'
  )
}

function assertIssue(issue, lane) {
  const at = Date.parse(issue.issuedAtUtc)
  const block = issue.block
  if (
    !Number.isFinite(at) ||
    !Number.isSafeInteger(block?.timestamp) ||
    !Number.isSafeInteger(issue.horizonHours) ||
    issue.horizonHours <= 0 ||
    typeof block.hash !== 'string' ||
    typeof issue.sha256 !== 'string' ||
    typeof issue.filename !== 'string' ||
    !Number.isFinite(issue.currentQuote) ||
    at < block.timestamp * 1000 ||
    at >= (block.timestamp + issue.horizonHours * HOUR - ENDPOINT_TOLERANCE) * 1000 ||
    (['quote', 'levelQuote'].includes(lane) &&
      !['research_forecast', 'unavailable', 'insufficient_sample'].includes(issue.status)) ||
    (lane === 'duration' &&
      !['research_only', 'ineligible_anchor', 'incomplete_24h_history'].includes(issue.status))
  )
    throw new Error('Invalid or non-prospective issue')
}

function scoreMap(scores, issues) {
  const byFilename = new Map(issues.map((issue) => [issue.filename, issue]))
  const map = new Map()
  for (const score of scores) {
    const issue = byFilename.get(score.issueFilename)
    if (
      !issue ||
      score.issueSha256 !== issue.sha256 ||
      score.horizonHours !== issue.horizonHours ||
      score.targetAt !== issue.block.timestamp + issue.horizonHours * HOUR ||
      map.has(score.issueFilename)
    )
      throw new Error('Unmatched or duplicate score')
    map.set(score.issueFilename, score)
  }
  return map
}

function emptyLane() {
  return {
    issued: 0,
    selectedEpisodes: 0,
    overlapExcluded: 0,
    modelEligible: 0,
    modelAbstained: 0,
    pendingAllIssued: 0,
    missingMaturedScoreAllIssued: 0,
    censoredOrUnresolvedAllIssued: 0,
    resolvedAllIssued: 0,
    pending: 0,
    missingMaturedScore: 0,
    censoredOrUnresolved: 0,
    resolved: 0,
    pairedScored: 0,
    events: 0,
    modelMae: null,
    persistenceMae: null,
    empiricalIntervalCoverage: null,
    modelBrier: null,
    persistenceBrier: null,
    verdict: 'abstain_insufficient_nonoverlapping_outcomes',
  }
}

function summarizeLane(rows, lane, asOfSeconds) {
  const result = emptyLane()
  const absoluteModelErrors = [],
    absolutePersistenceErrors = [],
    covered = []
  const modelBrier = [],
    persistenceBrier = []
  for (const row of rows) {
    result.issued++
    const { issue, score } = row
    if (!score) {
      if (asOfSeconds < issue.block.timestamp + issue.horizonHours * HOUR + ENDPOINT_TOLERANCE)
        result.pendingAllIssued++
      else result.missingMaturedScoreAllIssued++
    } else if (
      lane === 'duration'
        ? !['no_below_threshold_breach_observed', 'first_breach_observed'].includes(
            score.stateAtHorizon,
          )
        : score.status !== 'observed' || !Number.isFinite(score.actualQuote)
    )
      result.censoredOrUnresolvedAllIssued++
    else result.resolvedAllIssued++
    if (row.overlap) {
      result.overlapExcluded++
      continue
    }
    result.selectedEpisodes++
    const quoteLane = lane === 'quote' || lane === 'levelQuote'
    const eligible = quoteLane
      ? issue.status === 'research_forecast'
      : issue.status === 'research_only' &&
        issue.analog?.status === 'exploratory_estimate' &&
        Number.isFinite(issue.analog?.noBelowThresholdBreachFraction)
    if (eligible) result.modelEligible++
    else result.modelAbstained++
    if (!score) {
      if (asOfSeconds < issue.block.timestamp + issue.horizonHours * HOUR + ENDPOINT_TOLERANCE)
        result.pending++
      else result.missingMaturedScore++
      continue
    }
    const actual = quoteLane
      ? score.status === 'observed' && Number.isFinite(score.actualQuote)
        ? score.actualQuote
        : null
      : score.stateAtHorizon === 'no_below_threshold_breach_observed'
        ? 1
        : score.stateAtHorizon === 'first_breach_observed'
          ? 0
          : null
    if (actual === null) {
      result.censoredOrUnresolved++
      continue
    }
    result.resolved++
    if (!eligible) continue
    if (quoteLane) {
      if (
        !Number.isFinite(issue.projectedQuote) ||
        !Array.isArray(issue.empiricalAnalogInterval) ||
        issue.empiricalAnalogInterval.length !== 2 ||
        issue.empiricalAnalogInterval.some((x) => !Number.isFinite(x))
      )
        throw new Error('Eligible quote issue lacks immutable prediction')
      absoluteModelErrors.push(Math.abs(issue.projectedQuote - actual))
      absolutePersistenceErrors.push(Math.abs(issue.currentQuote - actual))
      covered.push(
        Number(
          actual >= issue.empiricalAnalogInterval[0] && actual <= issue.empiricalAnalogInterval[1],
        ),
      )
    } else {
      const p = issue.analog.noBelowThresholdBreachFraction
      if (p < 0 || p > 1) throw new Error('Invalid issued probability')
      if (actual === 0) result.events++
      modelBrier.push((p - actual) ** 2)
      persistenceBrier.push((1 - actual) ** 2)
    }
    result.pairedScored++
  }
  // Nonoverlapping windows avoid duplicate hourly outcomes; they do not
  // establish statistical independence across a shared market regime.
  const ready =
    result.pairedScored >= MIN_NONOVERLAPPING_PAIRED &&
    (lane !== 'duration' || result.events >= MIN_DURATION_EVENTS)
  if (ready) {
    const mean = (xs) => xs.reduce((sum, x) => sum + x, 0) / xs.length
    if (lane !== 'duration') {
      result.modelMae = mean(absoluteModelErrors)
      result.persistenceMae = mean(absolutePersistenceErrors)
      result.empiricalIntervalCoverage = mean(covered)
    } else {
      result.modelBrier = mean(modelBrier)
      result.persistenceBrier = mean(persistenceBrier)
    }
    result.verdict = 'research_evaluation_only'
  }
  return result
}

export function buildScorecard({
  quote,
  duration,
  levelQuote = { issues: [], scores: [] },
  asOfSeconds,
  periods = PERIODS,
}) {
  if (!Number.isSafeInteger(asOfSeconds)) throw new Error('Invalid evidence cutoff')
  const lanes = { quote, levelQuote, duration }
  const horizons = {
    quote: QUOTE_HORIZONS,
    levelQuote: LEVEL_HORIZONS,
    duration: DURATION_HORIZONS,
  }
  const grouped = new Map()
  const scoreMaps = {}
  for (const [lane, data] of Object.entries(lanes)) {
    scoreMaps[lane] = scoreMap(data.scores, data.issues)
    for (const issue of data.issues) {
      assertIssue(issue, lane)
      if (!horizons[lane].includes(issue.horizonHours)) throw new Error('Unexpected issued horizon')
      if (Date.parse(issue.issuedAtUtc) > asOfSeconds * 1000)
        throw new Error('Issue after evidence cutoff')
      const key = `${issue.block.hash}:${issue.horizonHours}`
      const group = grouped.get(key) ?? {
        block: issue.block,
        horizonHours: issue.horizonHours,
        issues: {},
      }
      if (group.block.timestamp !== issue.block.timestamp || group.issues[lane])
        throw new Error('Conflicting episode identity')
      group.issues[lane] = issue
      grouped.set(key, group)
    }
  }
  const groups = [...grouped.values()].sort(
    (a, b) =>
      a.block.timestamp - b.block.timestamp ||
      a.block.hash.localeCompare(b.block.hash) ||
      a.horizonHours - b.horizonHours,
  )
  const nextAllowedByLaneHorizon = new Map(),
    rows = []
  for (const group of groups) {
    for (const [lane, issue] of Object.entries(group.issues)) {
      const selectionKey = `${lane}:${group.horizonHours}`
      const overlap =
        group.block.timestamp < (nextAllowedByLaneHorizon.get(selectionKey) ?? -Infinity)
      if (!overlap)
        nextAllowedByLaneHorizon.set(
          selectionKey,
          group.block.timestamp + group.horizonHours * HOUR + ENDPOINT_TOLERANCE,
        )
      rows.push({
        lane,
        issue,
        overlap,
        score: scoreMaps[lane].get(issue.filename) ?? null,
        period: periodOf(issue.issuedAtUtc, periods),
      })
    }
  }
  for (const row of rows) {
    if (row.score && asOfSeconds < row.score.targetAt + ENDPOINT_TOLERANCE)
      throw new Error('Score precedes complete endpoint window at evidence cutoff')
    if (
      row.lane === 'levelQuote' &&
      row.score &&
      (!Number.isFinite(Date.parse(row.score.scoredAtUtc)) ||
        Date.parse(row.score.scoredAtUtc) > asOfSeconds * 1000 ||
        Date.parse(row.score.scoredAtUtc) < Date.parse(row.issue.issuedAtUtc))
    )
      throw new Error('Level score outside evidence cutoff')
  }
  const byPeriod = {}
  for (const period of [...periods.map((p) => p.name), 'outside_periods']) {
    byPeriod[period] = Object.fromEntries(
      Object.entries(horizons).map(([lane, values]) => [
        lane,
        Object.fromEntries(
          values.map((horizon) => [
            horizon,
            summarizeLane(
              rows.filter(
                (r) => r.period === period && r.lane === lane && r.issue.horizonHours === horizon,
              ),
              lane,
              asOfSeconds,
            ),
          ]),
        ),
      ]),
    )
  }
  return {
    study: STUDY,
    asOfSeconds,
    periods,
    episodeRule:
      'Within each lane and horizon, select earliest issue block; next starts after horizon plus 90 minutes. Lane selections are separate, but their market outcomes can overlap; pair comparisons require a separate shared-block join.',
    denominatorRule:
      'For each lane/horizon/period: issued = pendingAllIssued + missingMaturedScoreAllIssued + censoredOrUnresolvedAllIssued + resolvedAllIssued = selectedEpisodes + overlapExcluded. SelectedEpisodes = pending + missingMaturedScore + censoredOrUnresolved + resolved; pairedScored is the model-eligible subset of resolved.',
    minimumNonoverlappingPaired: MIN_NONOVERLAPPING_PAIRED,
    minimumDurationEvents: MIN_DURATION_EVENTS,
    source: 'verified sealed issue and score sidecars; nominal $1m get_dy quote only',
    scoreAvailability:
      'V1 quote/duration score sidecars are present-corpus snapshots without first-availability timestamps. V2 level quote scores have a sealed scoredAtUtc checked against this snapshot cutoff; neither form proves historical publication to users.',
    byPeriod,
    forecastReady: false,
    caveat:
      'V1 and v2 lanes are scored separately; cases cannot be pooled to pass a sample gate. Nonoverlapping windows can still share a market regime. The v2 analog interval is exploratory, not calibrated. Research evaluation does not establish vault exit probability or a live alert threshold.',
  }
}

export function runScorecard({
  checkpointOut = CHECKPOINTS,
  quoteOut = QUOTE_OUT,
  levelOut = LEVEL_OUT,
  durationOut = DURATION_OUT,
} = {}) {
  const history = readHistorical()
  const checkpoints = readValidatedCheckpoints({ out: checkpointOut })
  verifyQuoteIssues({ history, checkpoints, out: quoteOut })
  verifyLevelIssues({ history: readLevelHistorical(), checkpoints, out: levelOut })
  verifyDurationIssues({ history, checkpoints, out: durationOut })
  return buildScorecard({
    quote: readLane(quoteOut),
    levelQuote: readLane(levelOut),
    duration: readLane(durationOut),
    asOfSeconds: Math.floor(Date.now() / 1000),
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(runScorecard()))
  } catch {
    console.error('Prospective scorecard verification failed')
    process.exitCode = 1
  }
}
