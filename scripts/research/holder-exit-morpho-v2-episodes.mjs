import { createHash } from 'node:crypto'

import { BOARD_ROUTES, scoreTransition } from './carry-local-morpho-holder-v2.mjs'

const SHA = /^[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/i
const HASH = /^0x[0-9a-f]{64}$/i
const MAX_EPISODES = 20_000
const sha = (value) => createHash('sha256').update(value).digest('hex')
const key = (route, destination, asset) =>
  `${route}\0${destination.toLowerCase()}\0${asset.toLowerCase()}`
const requirePanel = (condition, reason) => {
  if (!condition) throw Error(`holder_episode_panel_morpho_${reason}`)
}
const time = (value) => {
  const ms = Date.parse(value)
  requirePanel(Number.isSafeInteger(ms) && new Date(ms).toISOString() === value, 'clock_invalid')
  return ms
}

export function morphoBoardSubjects(manifest) {
  const lookup = new Map(
    manifest.subjects.map((subject) => [
      key(subject.route_key, subject.destination, subject.asset),
      subject,
    ]),
  )
  const board = new Map()
  for (const route of BOARD_ROUTES) {
    const subject = lookup.get(key(route.routeKey, route.destination, route.asset))
    requirePanel(subject, 'frozen_subject_missing')
    board.set(key(route.routeKey, route.destination, route.asset), subject)
  }
  requirePanel(
    board.size === 49 && new Set([...board.values()].map((s) => s.route_key)).size === 7,
    'frozen_roster_invalid',
  )
  return board
}

function baselineOf(row) {
  if (row.baselineStatus === 'simulated_withdraw_success') return 'simulated_callable'
  if (row.baselineStatus === 'baseline_revert') return 'simulated_impaired'
  requirePanel(row.baselineStatus === 'unavailable', 'baseline_invalid')
  return 'unavailable'
}

function outcomeOf(baseline, score, deadlineMs, nowMs) {
  if (baseline === 'unavailable') return { status: 'not_at_risk', reason: 'baseline_unavailable' }
  if (!score)
    return nowMs <= deadlineMs
      ? { status: 'pending', reason: null }
      : { status: 'missing', reason: 'no_verified_score_after_deadline' }
  if (score.outcome === 'censored_capture_window_missed')
    return { status: 'censored', reason: 'capture_window_missed' }
  if (score.outcome === 'holder_attrition')
    return { status: 'censored', reason: 'holder_attrition' }
  if (score.outcome === 'preview_gap')
    return { status: 'inconclusive', reason: 'preview_share_gap' }
  if (score.outcome === 'inconclusive_revert' || score.outcome === 'covered_revert_cause_unknown')
    return { status: 'inconclusive', reason: 'revert_cause_unknown' }
  requirePanel(score.outcome === 'simulated_withdraw_success', 'outcome_invalid')
  return { status: 'simulated_callable', reason: null }
}

/** Project already verified local Morpho records; never verify an injected test fixture as a seal. */
export function buildMorphoV2Episodes({
  manifest,
  issues = [],
  scores = [],
  featuresBySubject = new Map(),
  selectAsOfFeatures,
  nowMs,
}) {
  const board = morphoBoardSubjects(manifest)
  requirePanel(
    Array.isArray(issues) &&
      Array.isArray(scores) &&
      issues.length <= 10_000 &&
      scores.length <= 50_000,
    'ledger_invalid',
  )
  requirePanel(Number.isSafeInteger(nowMs) && nowMs >= 0, 'now_invalid')
  requirePanel(
    featuresBySubject instanceof Map && typeof selectAsOfFeatures === 'function',
    'features_invalid',
  )
  const issueBySequence = new Map()
  for (const issue of issues) {
    requirePanel(
      Number.isSafeInteger(issue.sequence) && !issueBySequence.has(issue.sequence),
      'issue_duplicate',
    )
    issueBySequence.set(issue.sequence, issue)
  }
  const scoresByCell = new Map()
  for (const score of scores) {
    const cell = `${score.issueSequence}:${score.caseLabel}:${score.horizonHours}`
    requirePanel(!scoresByCell.has(cell), 'score_duplicate')
    scoresByCell.set(cell, score)
  }
  const consumedScores = new Set()
  const episodes = []
  const diagnostics = new Map(
    [...board.keys()].map((subject) => [
      subject,
      {
        issues: 0,
        noHolderIssues: 0,
        baselineUnavailableIssues: 0,
        issuedIssues: 0,
      },
    ]),
  )
  for (const issue of issues) {
    const subjectKey = key(issue.routeKey, issue.destination, issue.asset)
    const subject = board.get(subjectKey)
    // The verified V2 ledger includes supplemental seeds outside the frozen manifest.
    if (!subject) {
      requirePanel(
        !BOARD_ROUTES.some(
          (route) =>
            route.routeKey === issue.routeKey &&
            route.destination.toLowerCase() === issue.destination.toLowerCase(),
        ),
        'issue_identity_invalid',
      )
      continue
    }
    requirePanel(
      SHA.test(issue.sha256 ?? '') &&
        HASH.test(issue.baseline?.targetHash ?? '') &&
        /^\d+$/.test(issue.baseline?.targetBlock ?? '') &&
        issue.baseline.routeKey === issue.routeKey &&
        issue.baseline.destination.toLowerCase() === issue.destination.toLowerCase() &&
        issue.baseline.asset.toLowerCase() === issue.asset.toLowerCase() &&
        ['issued', 'no_holder', 'baseline_unavailable'].includes(issue.status) &&
        Array.isArray(issue.cases) &&
        Array.isArray(issue.targets),
      'issue_identity_invalid',
    )
    requirePanel(
      issue.status !== 'no_holder' || (issue.holder === null && issue.cases.length === 0),
      'no_holder_invalid',
    )
    const issuedMs = time(issue.issuedAtUtc)
    const baselineMs = time(issue.baseline.targetBlockAt)
    requirePanel(baselineMs <= issuedMs, 'baseline_clock_invalid')
    const visibleIssue = issuedMs <= nowMs
    if (visibleIssue) {
      const info = diagnostics.get(subjectKey)
      info.issues++
      if (issue.status === 'no_holder') info.noHolderIssues++
      if (issue.status === 'baseline_unavailable') info.baselineUnavailableIssues++
      if (issue.status === 'issued') info.issuedIssues++
    }
    if (issue.status === 'no_holder') continue
    requirePanel(
      ADDRESS.test(issue.holder ?? '') &&
        issue.candidate?.evidenceDoc?.selectedHolderCommitment ===
          sha(`${issue.destination.toLowerCase()}:${issue.holder.toLowerCase()}`),
      'holder_invalid',
    )
    const featureJoin = visibleIssue
      ? selectAsOfFeatures(featuresBySubject.get(subjectKey) ?? [], subject, issue, issue)
      : null
    const seenLabels = new Set()
    const seenQ = new Set()
    for (const row of issue.cases) {
      requirePanel(typeof row.label === 'string' && !seenLabels.has(row.label), 'case_duplicate')
      seenLabels.add(row.label)
      if (row.assetsRaw === null) {
        requirePanel(
          row.omittedReason != null && row.baselineStatus === 'omitted',
          'omission_invalid',
        )
        continue
      }
      requirePanel(
        /^\d+$/.test(row.assetsRaw) && !seenQ.has(row.assetsRaw) && row.omittedReason === null,
        'q_invalid',
      )
      seenQ.add(row.assetsRaw)
      const baseline = baselineOf(row)
      const seenHorizons = new Set()
      for (const target of issue.targets) {
        const targetMs = time(target.targetAtUtc)
        const deadlineMs = time(target.captureDeadlineUtc)
        requirePanel(
          Number.isSafeInteger(target.horizonHours) &&
            target.horizonHours > 0 &&
            !seenHorizons.has(target.horizonHours) &&
            targetMs > issuedMs &&
            deadlineMs > targetMs,
          'target_invalid',
        )
        seenHorizons.add(target.horizonHours)
        const score = scoresByCell.get(`${issue.sequence}:${row.label}:${target.horizonHours}`)
        const scoredMs = score ? time(score.scoredAtUtc) : null
        if (score) {
          requirePanel(
            score.issueSha256 === issue.sha256 &&
              score.caseLabel === row.label &&
              score.assetsRaw === row.assetsRaw &&
              score.baselineStatus === row.baselineStatus &&
              score.caseEvidenceSha256 === row.evidenceSha256 &&
              score.routeKey === issue.routeKey &&
              score.destination.toLowerCase() === issue.destination.toLowerCase() &&
              score.asset.toLowerCase() === issue.asset.toLowerCase() &&
              score.holder.toLowerCase() === issue.holder.toLowerCase() &&
              score.targetAtUtc === target.targetAtUtc &&
              score.captureDeadlineUtc === target.captureDeadlineUtc &&
              scoredMs >= targetMs &&
              score.transition === scoreTransition(row.baselineStatus, score.outcome) &&
              SHA.test(score.sha256 ?? ''),
            'score_binding_invalid',
          )
          consumedScores.add(`${issue.sequence}:${row.label}:${target.horizonHours}`)
        }
        if (!visibleIssue) continue
        const visibleScore = score && scoredMs <= nowMs ? score : null
        const outcome = outcomeOf(baseline, visibleScore, deadlineMs, nowMs)
        episodes.push({
          subject: subjectKey,
          stageScope: 'direct_morpho_vaultv2_withdraw_eth_call',
          fullRoutePaidProofSha256: null,
          lane: 'morpho_v2',
          issueClusterSha256: issue.sha256,
          issueSha256: issue.sha256,
          scoreSha256: visibleScore?.sha256 ?? null,
          holderCommitment: sha(`${issue.destination.toLowerCase()}:${issue.holder.toLowerCase()}`),
          qRaw: row.assetsRaw,
          qUnit: 'asset_raw',
          qCaseLabel: row.label,
          plannedHorizonHours: target.horizonHours,
          leadAtIssueMinutes: (targetMs - issuedMs) / 60_000,
          targetClockBasis: 'issue_plan',
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
          baseline,
          outcome,
          rawScoreOutcome: visibleScore?.outcome ?? null,
          rawScoreTransition: visibleScore?.transition ?? null,
          ...featureJoin,
          analysisPrimaryForCell: false,
          forecastEligible: false,
        })
        requirePanel(episodes.length <= MAX_EPISODES, 'row_limit')
      }
    }
  }
  for (const score of scores) {
    const issue = issueBySequence.get(score.issueSequence)
    requirePanel(issue && score.issueSha256 === issue.sha256, 'orphan_score')
    if (!board.has(key(issue.routeKey, issue.destination, issue.asset))) continue
    requirePanel(
      consumedScores.has(`${score.issueSequence}:${score.caseLabel}:${score.horizonHours}`),
      'orphan_score',
    )
  }
  return { episodes, diagnostics, board }
}
