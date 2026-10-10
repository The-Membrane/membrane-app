// Offline projection of verified sGHO ledgers. V2 is a linked diagnostic, not a second cohort.
import { createHash } from 'node:crypto'

import { FIXED_Q_RAW } from './carry-public-sgho-fixed-q-v2-issue.mjs'
import { HORIZONS_HOURS, ROUTE } from './carry-public-sgho-exit-common.mjs'

const SHA = /^[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const BLOCK_HASH = /^0x[0-9a-f]{64}$/
const AMOUNT = /^(0|[1-9][0-9]*)$/
const HOUR_MS = 3_600_000
const MAX_ISSUES = 2_000
const MAX_SCORES = 10_000
const MAX_ROWS = 20_000
const sha = (value) => createHash('sha256').update(value).digest('hex')
const key = (route, destination, asset) =>
  `${route}\0${destination.toLowerCase()}\0${asset.toLowerCase()}`
const check = (ok, reason) => {
  if (!ok) throw Error(`holder_episode_panel_sgho_${reason}`)
}
const utcMs = (value) => {
  const ms = Date.parse(value)
  check(Number.isSafeInteger(ms) && new Date(ms).toISOString() === value, 'clock_invalid')
  return ms
}
const sealed = (row) => {
  const { sha256, ...payload } = row
  return SHA.test(sha256 ?? '') && sha(JSON.stringify(payload)) === sha256
}
const subjectKey = key(ROUTE.routeKey, ROUTE.destination, ROUTE.asset)

export function sghoBoardSubjects(manifest) {
  check(Array.isArray(manifest?.subjects), 'manifest_invalid')
  const matches = manifest.subjects.filter(
    (subject) =>
      subject.route_key === ROUTE.routeKey &&
      subject.destination?.toLowerCase() === ROUTE.destination &&
      subject.asset?.toLowerCase() === ROUTE.asset,
  )
  check(matches.length === 1, 'frozen_subject_invalid')
  return new Map([[subjectKey, matches[0]]])
}

function indexIssues(issues, study) {
  check(Array.isArray(issues) && issues.length <= MAX_ISSUES, 'issue_limit')
  const bySequence = new Map()
  for (const issue of issues) {
    check(
      Number.isSafeInteger(issue?.sequence) &&
        issue.sequence > 0 &&
        !bySequence.has(issue.sequence) &&
        issue.study === study &&
        sealed(issue) &&
        issue.routeKey === ROUTE.routeKey &&
        issue.destination === ROUTE.destination &&
        issue.originalAsset === ROUTE.asset,
      'issue_identity_invalid',
    )
    bySequence.set(issue.sequence, issue)
  }
  return bySequence
}

function indexScores(scores, issues, study) {
  check(Array.isArray(scores) && scores.length <= MAX_SCORES, 'score_limit')
  const byCell = new Map()
  for (const score of scores) {
    const issue = issues.get(score?.issueSequence)
    const cell = `${score?.issueSequence}:${score?.horizonHours}`
    check(
      issue &&
        !byCell.has(cell) &&
        score.study === study &&
        sealed(score) &&
        score.issueSha256 === issue.sha256 &&
        score.routeKey === ROUTE.routeKey &&
        score.destination === ROUTE.destination &&
        score.originalAsset === ROUTE.asset,
      'score_binding_invalid',
    )
    byCell.set(cell, score)
  }
  return byCell
}

function validatePlan(issue, target, horizon) {
  const issuedMs = utcMs(issue.issuedAtUtc)
  const targetMs = utcMs(target?.targetAtUtc)
  const deadlineMs = utcMs(target?.captureDeadlineUtc)
  check(
    target.horizonHours === horizon &&
      targetMs === issuedMs + horizon * HOUR_MS &&
      deadlineMs === targetMs + 2 * HOUR_MS,
    'target_invalid',
  )
  return { targetMs, deadlineMs }
}

function validateScoreClock(score, issue, target, targetMs, deadlineMs) {
  if (!score) return
  check(
    score.holder === (issue.holder ?? issue.candidate?.holder) &&
      score.targetAtUtc === target.targetAtUtc &&
      score.captureDeadlineUtc === target.captureDeadlineUtc &&
      utcMs(score.scoredAtUtc) >= targetMs,
    'score_binding_invalid',
  )
  if (score.target !== null) {
    check(
      BLOCK_HASH.test(score.target?.targetHash ?? '') &&
        utcMs(score.target.targetBlockAt) >= targetMs &&
        utcMs(score.target.targetBlockAt) <= deadlineMs,
      'score_target_invalid',
    )
  }
}

function baselineOf(entry) {
  if (entry.status === 'unavailable')
    return { status: 'unavailable', reason: entry.reason ?? 'baseline_unavailable' }
  check(entry.status === 'measured', 'baseline_status_invalid')
  if (entry.measurement?.baselineStatus === 'success')
    return { status: 'simulated_callable', reason: null }
  if (entry.measurement?.baselineStatus === 'covered_revert')
    return { status: 'inconclusive', reason: 'revert_cause_unknown' }
  check(entry.measurement?.baselineStatus === 'inconclusive', 'baseline_status_invalid')
  return { status: 'inconclusive', reason: 'baseline_inconclusive' }
}

function observedOutcome(raw) {
  switch (raw) {
    case 'simulated_withdraw_success':
      return { status: 'simulated_callable', reason: null }
    case 'holder_shares_zero':
      return { status: 'censored', reason: 'holder_attrition' }
    case 'preview_share_gap':
      return { status: 'inconclusive', reason: 'preview_share_gap' }
    case 'withdraw_revert_cause_unknown':
      return { status: 'inconclusive', reason: 'revert_cause_unknown' }
    default:
      throw Error('holder_episode_panel_sgho_outcome_invalid')
  }
}

function outcomeOf(baseline, score, scoreCase, deadlineMs, nowMs) {
  if (baseline.status !== 'simulated_callable')
    return { status: 'not_at_risk', reason: `baseline_${baseline.reason}` }
  if (!score)
    return nowMs <= deadlineMs
      ? { status: 'pending', reason: null }
      : { status: 'missing', reason: 'no_verified_score_after_deadline' }
  if (scoreCase?.status === 'unavailable') {
    check(scoreCase.reason === 'capture_window_missed', 'score_case_invalid')
    return { status: 'censored', reason: 'capture_window_missed' }
  }
  check(scoreCase?.status === 'measured', 'score_case_invalid')
  return observedOutcome(scoreCase.outcome)
}

function linkedV2Outcome(issue, score, deadlineMs, nowMs) {
  const baseline =
    issue.baselineStatus === 'success'
      ? { status: 'simulated_callable', reason: null }
      : { status: 'inconclusive', reason: 'revert_cause_unknown' }
  check(['success', 'covered_revert'].includes(issue.baselineStatus), 'v2_baseline_invalid')
  if (!score)
    return {
      baseline,
      observed: null,
      outcome:
        baseline.status === 'inconclusive'
          ? { status: 'not_at_risk', reason: 'baseline_revert_cause_unknown' }
          : nowMs <= deadlineMs
            ? { status: 'pending', reason: null }
            : { status: 'missing', reason: 'no_verified_score_after_deadline' },
    }
  if (score.status === 'censored') {
    check(score.target === null && score.transition === 'censored', 'v2_score_invalid')
    return {
      baseline,
      observed: null,
      outcome:
        baseline.status === 'inconclusive'
          ? { status: 'not_at_risk', reason: 'baseline_revert_cause_unknown' }
          : { status: 'censored', reason: 'capture_window_missed' },
    }
  }
  check(score.status === 'measured', 'v2_score_invalid')
  const observed = observedOutcome(score.outcome)
  const expectedTransition =
    score.outcome === 'simulated_withdraw_success'
      ? issue.baselineStatus === 'success'
        ? 'remained_exitable'
        : 'simulated_recovery'
      : ['holder_shares_zero', 'preview_share_gap'].includes(score.outcome)
        ? 'holder_attrition'
        : issue.baselineStatus === 'success'
          ? 'lost_exitability'
          : 'still_reverting'
  check(score.transition === expectedTransition, 'v2_transition_invalid')
  return {
    baseline,
    observed,
    outcome:
      baseline.status === 'inconclusive'
        ? { status: 'not_at_risk', reason: 'baseline_revert_cause_unknown' }
        : observed,
  }
}

/** Project caller-supplied verified ledgers; default readers must run the four sealed verifiers. */
export function buildSghoEpisodes({
  manifest,
  v1Issues = [],
  v1Scores = [],
  v2Issues = [],
  v2Scores = [],
  featuresBySubject = new Map(),
  selectAsOfFeatures,
  nowMs,
}) {
  const board = sghoBoardSubjects(manifest)
  check(
    Number.isSafeInteger(nowMs) &&
      nowMs >= 0 &&
      featuresBySubject instanceof Map &&
      typeof selectAsOfFeatures === 'function',
    'inputs_invalid',
  )
  const subject = board.get(subjectKey)
  const parents = indexIssues(v1Issues, 'carry_public_sgho_exit_issue_v1')
  const children = indexIssues(v2Issues, 'carry_public_sgho_fixed_q_issue_v2')
  const v1ScoresByCell = indexScores(v1Scores, parents, 'carry_public_sgho_exit_score_v1')
  const v2ScoresByCell = indexScores(v2Scores, children, 'carry_public_sgho_fixed_q_score_v2')
  const diagnostics = new Map([
    [
      subjectKey,
      {
        issues: 0,
        noHolderIssues: 0,
        omittedQCases: 0,
        scoredTargets: 0,
        linkedV2Issues: 0,
        linkedV2ScoredTargets: 0,
        linkedV2Children: [],
      },
    ],
  ])
  const info = diagnostics.get(subjectKey)
  const episodes = []
  const consumedV1Scores = new Set()
  for (const issue of v1Issues) {
    check(
      AMOUNT.test(issue.baseline?.targetBlock ?? '') &&
        BLOCK_HASH.test(issue.baseline?.targetHash ?? '') &&
        Array.isArray(issue.targets) &&
        issue.targets.length === HORIZONS_HOURS.length &&
        Array.isArray(issue.cases) &&
        issue.cases.length === 6 &&
        (issue.candidate?.holder === null || ADDRESS.test(issue.candidate?.holder ?? '')),
      'v1_issue_invalid',
    )
    const issueMs = utcMs(issue.issuedAtUtc)
    check(utcMs(issue.baseline.targetBlockAt) <= issueMs, 'baseline_clock_invalid')
    const issueVisible = issueMs <= nowMs
    if (issueVisible) {
      info.issues++
      if (!issue.candidate.holder) info.noHolderIssues++
    }
    const seenLabels = new Set()
    const seenAmounts = new Set()
    for (const entry of issue.cases) {
      check(
        typeof entry.label === 'string' && entry.label.length > 0 && !seenLabels.has(entry.label),
        'q_invalid',
      )
      seenLabels.add(entry.label)
      if (entry.assetsRaw === null) {
        check(entry.status === 'omitted', 'q_omission_invalid')
        if (issueVisible) info.omittedQCases++
      } else {
        check(AMOUNT.test(entry.assetsRaw) && !seenAmounts.has(entry.assetsRaw), 'q_invalid')
        seenAmounts.add(entry.assetsRaw)
        if (!issue.candidate.holder) check(entry.status !== 'measured', 'no_holder_case_invalid')
      }
    }
    const featureJoin =
      issueVisible && issue.candidate.holder
        ? selectAsOfFeatures(featuresBySubject.get(subjectKey) ?? [], subject, issue, issue)
        : null
    for (const [targetIndex, target] of issue.targets.entries()) {
      const horizon = HORIZONS_HOURS[targetIndex]
      const { targetMs, deadlineMs } = validatePlan(issue, target, horizon)
      const score = v1ScoresByCell.get(`${issue.sequence}:${horizon}`)
      if (score) {
        consumedV1Scores.add(`${issue.sequence}:${horizon}`)
        validateScoreClock(score, issue, target, targetMs, deadlineMs)
        check(
          Array.isArray(score.cases) &&
            score.cases.length === issue.cases.length &&
            score.onTime === utcMs(score.scoredAtUtc) <= deadlineMs &&
            (score.onTime ? score.target !== null : score.target === null),
          'v1_score_invalid',
        )
        if (issueVisible && utcMs(score.scoredAtUtc) <= nowMs) info.scoredTargets++
      }
      for (const [caseIndex, entry] of issue.cases.entries()) {
        const scoreCase = score?.cases[caseIndex]
        if (score)
          check(
            scoreCase?.label === entry.label && scoreCase.assetsRaw === entry.assetsRaw,
            'v1_score_q_invalid',
          )
        if (!issue.candidate.holder || entry.assetsRaw === null) continue
        const baseline = baselineOf(entry)
        if (!issueVisible) continue
        const visibleScore = score && utcMs(score.scoredAtUtc) <= nowMs ? score : null
        const visibleScoreCase = visibleScore ? scoreCase : null
        const outcome = outcomeOf(baseline, visibleScore, visibleScoreCase, deadlineMs, nowMs)
        episodes.push({
          subject: subjectKey,
          stageScope: 'direct_sgho_withdraw_eth_call',
          fullRoutePaidProofSha256: null,
          lane: 'sgho_v1',
          issueClusterSha256: issue.sha256,
          issueSha256: issue.sha256,
          scoreSha256: visibleScore?.sha256 ?? null,
          holderCommitment: sha(`${ROUTE.destination}:${issue.candidate.holder}`),
          qRaw: entry.assetsRaw,
          qUnit: 'asset_raw',
          qCaseLabel: entry.label,
          plannedHorizonHours: horizon,
          leadAtIssueMinutes: horizon * 60,
          targetClockBasis: 'v1_issue_plan',
          issueAtUtc: issue.issuedAtUtc,
          issueClock: 'local_operator_clock_unwitnessed',
          featureAvailabilityClock: 'local_operator_clock_unwitnessed',
          baselineBlock: issue.baseline.targetBlock,
          baselineBlockHash: issue.baseline.targetHash,
          baselineAtUtc: issue.baseline.targetBlockAt,
          targetAtUtc: target.targetAtUtc,
          deadlineAtUtc: target.captureDeadlineUtc,
          observedAtUtc: visibleScore?.target?.targetBlockAt ?? null,
          labelAvailableAtUtc: visibleScore?.scoredAtUtc ?? null,
          ...featureJoin,
          baseline: baseline.status,
          baselineReason: baseline.reason,
          outcome,
          rawBaselineStatus: entry.measurement?.baselineStatus ?? null,
          rawScoreStatus: visibleScoreCase?.status ?? null,
          rawScoreOutcome: visibleScoreCase?.outcome ?? null,
          analysisPrimaryForCell: false,
          forecastEligible: false,
        })
        check(episodes.length <= MAX_ROWS, 'row_limit')
      }
    }
  }
  for (const cell of v1ScoresByCell.keys()) check(consumedV1Scores.has(cell), 'v1_orphan_score')
  const linkedParents = new Set()
  const consumedV2Scores = new Set()
  for (const issue of v2Issues) {
    const parent = parents.get(issue.v1IssueSequence)
    check(
      parent &&
        issue.v1IssueSha256 === parent.sha256 &&
        !linkedParents.has(parent.sequence) &&
        ADDRESS.test(issue.holder ?? '') &&
        issue.holder === parent.candidate.holder &&
        issue.assetsRaw === FIXED_Q_RAW &&
        Array.isArray(issue.targets) &&
        issue.targets.length === HORIZONS_HOURS.length &&
        ['success', 'covered_revert'].includes(issue.baselineStatus),
      'v2_parent_binding_invalid',
    )
    linkedParents.add(parent.sequence)
    const matching = parent.cases.filter((entry) => entry.assetsRaw === FIXED_Q_RAW)
    check(matching.length <= 1, 'v2_parent_q_duplicate')
    if (matching[0]?.status === 'measured')
      check(
        matching[0].measurement?.baselineStatus === issue.baselineStatus,
        'v2_baseline_disagreement',
      )
    const issueMs = utcMs(issue.issuedAtUtc)
    const parentIssueMs = utcMs(parent.issuedAtUtc)
    check(
      issueMs >= parentIssueMs && issueMs - utcMs(parent.baseline.targetBlockAt) <= 45 * 60_000,
      'v2_issue_clock_invalid',
    )
    const issueVisible = issueMs <= nowMs && parentIssueMs <= nowMs
    const featureJoin = issueVisible
      ? selectAsOfFeatures(featuresBySubject.get(subjectKey) ?? [], subject, issue, parent)
      : null
    const targets = []
    for (const [targetIndex, target] of issue.targets.entries()) {
      const horizon = HORIZONS_HOURS[targetIndex]
      const { targetMs, deadlineMs } = validatePlan(issue, target, horizon)
      const score = v2ScoresByCell.get(`${issue.sequence}:${horizon}`)
      if (score) {
        consumedV2Scores.add(`${issue.sequence}:${horizon}`)
        validateScoreClock(score, issue, target, targetMs, deadlineMs)
        check(
          score.assetsRaw === FIXED_Q_RAW &&
            (score.status === 'measured'
              ? score.target !== null && utcMs(score.scoredAtUtc) <= deadlineMs
              : score.status === 'censored' &&
                score.target === null &&
                utcMs(score.scoredAtUtc) > deadlineMs),
          'v2_score_invalid',
        )
        if (issueVisible && utcMs(score.scoredAtUtc) <= nowMs) info.linkedV2ScoredTargets++
      }
      const validated = linkedV2Outcome(issue, score, deadlineMs, nowMs)
      if (!issueVisible) continue
      const visibleScore = score && utcMs(score.scoredAtUtc) <= nowMs ? score : null
      const projected = visibleScore ? validated : linkedV2Outcome(issue, null, deadlineMs, nowMs)
      targets.push({
        plannedHorizonHours: horizon,
        targetClockBasis: 'v2_issue_plan',
        targetAtUtc: target.targetAtUtc,
        deadlineAtUtc: target.captureDeadlineUtc,
        observedAtUtc: visibleScore?.target?.targetBlockAt ?? null,
        labelAvailableAtUtc: visibleScore?.scoredAtUtc ?? null,
        scoreSha256: visibleScore?.sha256 ?? null,
        baseline: projected.baseline.status,
        baselineReason: projected.baseline.reason,
        outcome: projected.outcome,
        observedSimulation: projected.observed,
        rawScoreOutcome: visibleScore?.outcome ?? null,
        rawSourceTransition: visibleScore?.transition ?? null,
        causalTransition: null,
        fullRoutePaidProofSha256: null,
        forecastEligible: false,
      })
    }
    if (issueVisible) {
      info.linkedV2Issues++
      info.linkedV2Children.push({
        v1IssueSequence: parent.sequence,
        v1IssueSha256: parent.sha256,
        issueClusterSha256: parent.sha256,
        issueSha256: issue.sha256,
        holderCommitment: sha(`${ROUTE.destination}:${issue.holder}`),
        qRaw: FIXED_Q_RAW,
        qUnit: 'asset_raw',
        issueAtUtc: issue.issuedAtUtc,
        baselineBlock: parent.baseline.targetBlock,
        baselineBlockHash: parent.baseline.targetHash,
        baselineAtUtc: parent.baseline.targetBlockAt,
        rawBaselineStatus: issue.baselineStatus,
        ...featureJoin,
        targets,
      })
    }
  }
  for (const cell of v2ScoresByCell.keys()) check(consumedV2Scores.has(cell), 'v2_orphan_score')
  return { board, episodes, diagnostics }
}
