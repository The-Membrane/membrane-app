// Read-only Morpho V2 episode audit. One issue is one episode; Q cells share a
// holder and time path. eth_call outcomes are sampled simulations, not payouts.
import { pathToFileURL } from 'node:url'

import {
  readV2Attempts,
  readV2Issues,
  readV2Scores,
  reconcileV2Attempts,
  scoreTransition,
} from './carry-local-morpho-holder-v2.mjs'

export const STUDY = 'morpho_v2_holder_episode_summary_v1'
const HORIZONS = [1, 24]
const ZERO_BRACKETS = () => ({
  baselineSampleToH1ScoreSample: 0,
  baselineSampleToH24ScoreSample: 0,
  H1ScoreSampleToH24ScoreSample: 0,
})
const KEY = (issueSequence, label, horizon) => `${issueSequence}\0${label}\0${horizon}`
const OBSERVED = new Set([
  'simulated_withdraw_success',
  'preview_gap',
  'covered_revert_cause_unknown',
])
const REVERT = new Set(['preview_gap', 'covered_revert_cause_unknown'])

function bracketKey(afterHour, byHour) {
  if (afterHour === 0 && byHour === 1) return 'baselineSampleToH1ScoreSample'
  if (afterHour === 0 && byHour === 24) return 'baselineSampleToH24ScoreSample'
  if (afterHour === 1 && byHour === 24) return 'H1ScoreSampleToH24ScoreSample'
  throw Error('morpho_episode_interval_invalid')
}

function addEarliestInterval(counts, intervals) {
  if (!intervals.length) return
  // If Q cells disagree about the lower bound at the earliest sampled event,
  // retain the wider bound. Never combine different Q paths into a narrow one.
  const firstBy = Math.min(...intervals.map((row) => row.byHour))
  const earliest = intervals.filter((row) => row.byHour === firstBy)
  const after = Math.min(...earliest.map((row) => row.afterHour))
  counts[bracketKey(after, firstBy)]++
}

/**
 * Input must come from readV2Issues/readV2Scores/readV2Attempts, which validate
 * each SHA chain and its RPC evidence. This function also checks score linkage.
 * Its output has no holder address, exact Q, route, destination, or case row.
 */
export function summarizeVerifiedMorphoV2Episodes({
  issues,
  scores,
  attempts,
  evaluationClockUtc,
}) {
  const asOf = Date.parse(evaluationClockUtc)
  if (
    !Array.isArray(issues) ||
    !Array.isArray(scores) ||
    !Array.isArray(attempts) ||
    !Number.isFinite(asOf) ||
    new Date(asOf).toISOString() !== evaluationClockUtc
  )
    throw Error('morpho_episode_input_invalid')
  const byIssue = new Map()
  const exactSubjects = new Set()
  for (const issue of issues) {
    if (
      !Number.isSafeInteger(issue.sequence) ||
      issue.sequence < 1 ||
      byIssue.has(issue.sequence) ||
      typeof issue.routeKey !== 'string' ||
      typeof issue.destination !== 'string' ||
      typeof issue.asset !== 'string' ||
      !Array.isArray(issue.cases) ||
      !Array.isArray(issue.targets)
    )
      throw Error('morpho_episode_issue_invalid')
    byIssue.set(issue.sequence, issue)
    exactSubjects.add(`${issue.routeKey}\0${issue.destination}\0${issue.asset}`)
  }
  const scoreByKey = new Map()
  for (const score of scores) {
    const issue = byIssue.get(score.issueSequence)
    const row = issue?.cases.find((entry) => entry.label === score.caseLabel)
    const plan = issue?.targets.find((entry) => entry.horizonHours === score.horizonHours)
    const key = KEY(score.issueSequence, score.caseLabel, score.horizonHours)
    if (
      !issue ||
      !row ||
      !plan ||
      scoreByKey.has(key) ||
      score.issueSha256 !== issue.sha256 ||
      score.routeKey !== issue.routeKey ||
      score.destination !== issue.destination ||
      score.asset !== issue.asset ||
      score.holder !== issue.holder ||
      score.assetsRaw !== row.assetsRaw ||
      score.baselineStatus !== row.baselineStatus ||
      score.targetAtUtc !== plan.targetAtUtc ||
      score.transition !== scoreTransition(row.baselineStatus, score.outcome)
    )
      throw Error('morpho_episode_score_link_invalid')
    scoreByKey.set(key, score)
  }
  const reconciliation = reconcileV2Attempts(issues, attempts)
  const counts = {
    issues: issues.length,
    exactSubjects: exactSubjects.size,
    issuesWithHolder: 0,
    issuesWithMeasuredBaseline: 0,
    uniqueMeasuredHolders: 0,
    uniqueMeasuredSubjectHolders: 0,
    noHolder: 0,
    baselineUnavailable: 0,
    newSimulationRevertEpisodes: 0,
    laterSimulatedSuccessEpisodes: 0,
    sampledStillRevertingH1: 0,
    sampledStillRevertingH24: 0,
    captureCensoredEpisodes: 0,
    overdueUnscoredEpisodes: 0,
    futureUnscoredEpisodes: 0,
    inconclusiveEpisodes: 0,
    holderAttritionEpisodes: 0,
  }
  const firstSimulationRevertBrackets = ZERO_BRACKETS()
  const laterSimulatedSuccessBrackets = ZERO_BRACKETS()
  const measuredHolders = new Set()
  const measuredSubjectHolders = new Set()
  for (const issue of issues) {
    if (issue.holder) counts.issuesWithHolder++
    if (issue.status === 'no_holder') counts.noHolder++
    if (issue.status === 'baseline_unavailable') counts.baselineUnavailable++
    const onset = []
    const recovery = []
    const impairedAt = new Set()
    let measuredBaseline = false
    let censored = false
    let overdue = false
    let future = false
    let inconclusive = false
    let attrition = false
    for (const row of issue.cases) {
      if (!['simulated_withdraw_success', 'baseline_revert'].includes(row.baselineStatus)) continue
      measuredBaseline = true
      let priorState = row.baselineStatus === 'baseline_revert' ? 'revert' : 'success'
      let priorHour = 0
      for (const horizon of HORIZONS) {
        const plan = issue.targets.find((entry) => entry.horizonHours === horizon)
        if (!plan) throw Error('morpho_episode_target_missing')
        const score = scoreByKey.get(KEY(issue.sequence, row.label, horizon))
        if (!score) {
          if (asOf > Date.parse(plan.captureDeadlineUtc)) overdue = true
          else future = true
          continue
        }
        if (score.outcome === 'censored_capture_window_missed') {
          censored = true
          continue
        }
        if (score.outcome === 'inconclusive_revert') {
          inconclusive = true
          continue
        }
        if (score.outcome === 'holder_attrition') {
          attrition = true
          continue
        }
        if (!OBSERVED.has(score.outcome)) throw Error('morpho_episode_outcome_invalid')
        const state = REVERT.has(score.outcome) ? 'revert' : 'success'
        if (priorState === 'success' && state === 'revert')
          onset.push({ afterHour: priorHour, byHour: horizon })
        if (priorState === 'revert' && state === 'success')
          recovery.push({ afterHour: priorHour, byHour: horizon })
        if (priorState === 'revert' && state === 'revert') impairedAt.add(horizon)
        priorState = state
        priorHour = horizon
      }
    }
    if (measuredBaseline) {
      counts.issuesWithMeasuredBaseline++
      measuredHolders.add(issue.holder)
      measuredSubjectHolders.add(
        `${issue.routeKey}\0${issue.destination}\0${issue.asset}\0${issue.holder}`,
      )
    }
    if (onset.length) counts.newSimulationRevertEpisodes++
    if (recovery.length) counts.laterSimulatedSuccessEpisodes++
    if (impairedAt.has(1)) counts.sampledStillRevertingH1++
    if (impairedAt.has(24)) counts.sampledStillRevertingH24++
    if (censored) counts.captureCensoredEpisodes++
    if (overdue) counts.overdueUnscoredEpisodes++
    if (future) counts.futureUnscoredEpisodes++
    if (inconclusive) counts.inconclusiveEpisodes++
    if (attrition) counts.holderAttritionEpisodes++
    addEarliestInterval(firstSimulationRevertBrackets, onset)
    addEarliestInterval(laterSimulatedSuccessBrackets, recovery)
  }
  counts.uniqueMeasuredHolders = measuredHolders.size
  counts.uniqueMeasuredSubjectHolders = measuredSubjectHolders.size
  return {
    study: STUDY,
    evaluationClockUtc,
    evaluationClockOnly: true,
    episodeUnit: 'issue',
    independenceAcrossIssuesUnverified: true,
    episodeFlagsMayOverlap: true,
    sampledSimulationOnly: true,
    bracketBasis: 'actual_baseline_and_score_samples_not_nominal_hours_or_condition_duration',
    forecastValidated: false,
    holderExecutableExit: false,
    likelyDurationAvailable: false,
    counts,
    firstSimulationRevertBrackets,
    laterSimulatedSuccessBrackets,
    chainTips: {
      issues: { records: issues.length, sha256: issues.at(-1)?.sha256 ?? null },
      scores: { records: scores.length, sha256: scores.at(-1)?.sha256 ?? null },
      attempts: { records: attempts.length, sha256: attempts.at(-1)?.sha256 ?? null },
    },
    attemptReconciliation: {
      linkedIssues: reconciliation.linkedIssues,
      reconstructedIssues: reconciliation.reconstructedIssues,
      orphanIssues: reconciliation.orphanIssues.length,
      unissuedAttempts: reconciliation.unissuedAttempts.length,
    },
  }
}

export async function readMorphoV2HolderEpisodeSummary(
  evaluationClockUtc = new Date().toISOString(),
) {
  const issues = await readV2Issues()
  const scores = await readV2Scores(issues)
  const attempts = await readV2Attempts()
  return summarizeVerifiedMorphoV2Episodes({ issues, scores, attempts, evaluationClockUtc })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2)
    throw Error('usage: node scripts/research/morpho-v2-holder-episode-summary.mjs')
  console.log(JSON.stringify(await readMorphoV2HolderEpisodeSummary(), null, 2))
}
