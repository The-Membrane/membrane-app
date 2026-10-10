// Offline projection of sealed direct-vault holder/Q issues. All outcomes are eth_call only.
import { createHash } from 'node:crypto'

import { ROUTE as USD3, HORIZONS_HOURS as USD3_HORIZONS } from './carry-public-usd3-exit-common.mjs'
import {
  ROUTE as STUSDS,
  HORIZONS_HOURS as STUSDS_HORIZONS,
} from './carry-public-stusds-exit-common.mjs'
import {
  ROUTE as SUSDS,
  HORIZONS_HOURS as SUSDS_HORIZONS,
} from './carry-public-susds-exit-common.mjs'

const ROUTES = [
  { lane: 'usd3', route: USD3, horizons: USD3_HORIZONS },
  { lane: 'stusds', route: STUSDS, horizons: STUSDS_HORIZONS },
  { lane: 'susds', route: SUSDS, horizons: SUSDS_HORIZONS },
]
const SHA = /^[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const BLOCK_HASH = /^0x[0-9a-f]{64}$/
const AMOUNT = /^(0|[1-9][0-9]*)$/
const sha = (value) => createHash('sha256').update(value).digest('hex')
const key = (route, destination, asset) =>
  `${route}\0${destination.toLowerCase()}\0${asset.toLowerCase()}`
const check = (ok, reason) => {
  if (!ok) throw Error(`holder_episode_panel_direct_vault_${reason}`)
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

export function directVaultBoardSubjects(manifest) {
  check(Array.isArray(manifest?.subjects), 'manifest_invalid')
  const board = new Map()
  for (const { route } of ROUTES) {
    const matches = manifest.subjects.filter(
      (subject) =>
        subject.route_key === route.routeKey &&
        subject.destination?.toLowerCase() === route.destination &&
        subject.asset?.toLowerCase() === route.asset,
    )
    check(matches.length === 1, 'frozen_subject_invalid')
    board.set(key(route.routeKey, route.destination, route.asset), matches[0])
  }
  check(board.size === 3, 'frozen_roster_invalid')
  return board
}

function baselineOf(entry, holder) {
  if (!holder) return { status: 'unavailable', reason: 'no_holder' }
  if (entry.status === 'omitted')
    return { status: 'unavailable', reason: entry.reason ?? 'q_omitted' }
  if (entry.status === 'unavailable') return { status: 'unavailable', reason: entry.reason }
  check(entry.status === 'measured', 'baseline_status_invalid')
  if (entry.measurement?.baselineStatus === 'success')
    return { status: 'simulated_callable', reason: null }
  if (entry.measurement?.baselineStatus === 'covered_revert')
    return { status: 'inconclusive', reason: 'revert_cause_unknown' }
  check(entry.measurement?.baselineStatus === 'inconclusive', 'baseline_status_invalid')
  return { status: 'inconclusive', reason: 'baseline_inconclusive' }
}

function outcomeOf(baseline, score, scoreCase, deadlineMs, nowMs) {
  if (baseline.status === 'unavailable' || baseline.status === 'inconclusive')
    return { status: 'not_at_risk', reason: `baseline_${baseline.reason}` }
  if (!score)
    return nowMs <= deadlineMs
      ? { status: 'pending', reason: null }
      : { status: 'missing', reason: 'no_verified_score_after_deadline' }
  if (scoreCase.status === 'unavailable')
    return { status: 'censored', reason: 'capture_window_missed' }
  check(scoreCase.status === 'measured', 'score_case_invalid')
  switch (scoreCase.outcome) {
    case 'simulated_withdraw_success':
      return { status: 'simulated_callable', reason: null }
    case 'holder_shares_zero':
      return { status: 'censored', reason: 'holder_attrition' }
    case 'preview_share_gap':
      return { status: 'inconclusive', reason: 'preview_share_gap' }
    case 'withdraw_revert_cause_unknown':
      return { status: 'inconclusive', reason: 'revert_cause_unknown' }
    default:
      throw Error('holder_episode_panel_direct_vault_outcome_invalid')
  }
}

/** Projection only. Default panel loaders supply independently verified sealed ledgers. */
export function buildDirectVaultEpisodes({
  manifest,
  routeLedgers,
  featuresBySubject = new Map(),
  selectAsOfFeatures,
  nowMs,
}) {
  const board = directVaultBoardSubjects(manifest)
  check(Number.isSafeInteger(nowMs) && nowMs >= 0, 'now_invalid')
  check(
    featuresBySubject instanceof Map && typeof selectAsOfFeatures === 'function',
    'features_invalid',
  )
  check(Array.isArray(routeLedgers) && routeLedgers.length === ROUTES.length, 'ledgers_invalid')
  const episodes = []
  const diagnostics = new Map(
    [...board.keys()].map((subject) => [
      subject,
      { issues: 0, noHolderIssues: 0, omittedQCases: 0, scoredTargets: 0 },
    ]),
  )
  const seenLanes = new Set()
  for (const ledger of routeLedgers) {
    const spec = ROUTES.find((row) => row.lane === ledger?.lane)
    check(spec && !seenLanes.has(spec.lane), 'lane_invalid')
    seenLanes.add(spec.lane)
    const { route, horizons, lane } = spec
    const subjectKey = key(route.routeKey, route.destination, route.asset)
    const subject = board.get(subjectKey)
    const { issues, scores } = ledger
    check(
      Array.isArray(issues) &&
        issues.length <= 2_000 &&
        Array.isArray(scores) &&
        scores.length <= 10_000,
      'ledger_limit',
    )
    const issueBySequence = new Map()
    for (const issue of issues) {
      check(
        Number.isSafeInteger(issue?.sequence) &&
          issue.sequence > 0 &&
          !issueBySequence.has(issue.sequence),
        'issue_duplicate',
      )
      issueBySequence.set(issue.sequence, issue)
    }
    const scoresByCell = new Map()
    for (const score of scores) {
      const issue = issueBySequence.get(score?.issueSequence)
      check(issue && score.issueSha256 === issue.sha256, 'orphan_score')
      const cell = `${score.issueSequence}:${score.horizonHours}`
      check(!scoresByCell.has(cell), 'score_duplicate')
      scoresByCell.set(cell, { row: score, scoredAtMs: utcMs(score.scoredAtUtc) })
    }
    const consumed = new Set()
    for (const issue of issues) {
      check(
        issue.study === `carry_public_${lane}_exit_issue_v1` &&
          sealed(issue) &&
          issue.routeKey === route.routeKey &&
          issue.destination === route.destination &&
          issue.originalAsset === route.asset &&
          (issue.candidate?.holder === null || ADDRESS.test(issue.candidate?.holder ?? '')) &&
          AMOUNT.test(issue.baseline?.targetBlock ?? '') &&
          BLOCK_HASH.test(issue.baseline?.targetHash ?? '') &&
          Array.isArray(issue.targets) &&
          issue.targets.length === horizons.length &&
          Array.isArray(issue.cases) &&
          issue.cases.length === 6,
        'issue_identity_invalid',
      )
      const issueMs = utcMs(issue.issuedAtUtc)
      const baselineMs = utcMs(issue.baseline.targetBlockAt)
      check(baselineMs <= issueMs, 'baseline_clock_invalid')
      const issueVisible = issueMs <= nowMs
      if (issueVisible) {
        diagnostics.get(subjectKey).issues++
        diagnostics.get(subjectKey).omittedQCases += issue.cases.filter(
          (entry) => entry.assetsRaw === null,
        ).length
      }
      if (!issue.candidate.holder) {
        if (issueVisible) diagnostics.get(subjectKey).noHolderIssues++
        check(
          issue.cases.every((entry) => entry.status !== 'measured'),
          'no_holder_cases_invalid',
        )
        continue
      }
      let featureJoin = null
      const labels = new Set()
      for (const entry of issue.cases) {
        check(
          typeof entry.label === 'string' &&
            entry.label.length > 0 &&
            !labels.has(entry.label) &&
            (entry.assetsRaw === null || AMOUNT.test(entry.assetsRaw ?? '')),
          'q_invalid',
        )
        labels.add(entry.label)
      }
      for (const [targetIndex, target] of issue.targets.entries()) {
        const horizon = horizons[targetIndex]
        const targetMs = utcMs(target.targetAtUtc)
        const deadlineMs = utcMs(target.captureDeadlineUtc)
        check(
          target.horizonHours === horizon &&
            targetMs === issueMs + horizon * 3_600_000 &&
            deadlineMs === targetMs + 2 * 3_600_000,
          'target_invalid',
        )
        const cell = `${issue.sequence}:${horizon}`
        const scoreRecord = scoresByCell.get(cell)
        const score = scoreRecord?.row
        if (score) {
          check(scoreRecord.scoredAtMs >= targetMs, 'score_clock_invalid')
          check(
            score.study === `carry_public_${lane}_exit_score_v1` &&
              sealed(score) &&
              score.issueSha256 === issue.sha256 &&
              score.routeKey === route.routeKey &&
              score.destination === route.destination &&
              score.originalAsset === route.asset &&
              score.holder === issue.candidate.holder &&
              score.targetAtUtc === target.targetAtUtc &&
              score.captureDeadlineUtc === target.captureDeadlineUtc &&
              Array.isArray(score.cases) &&
              score.cases.length === issue.cases.length &&
              (score.target === null ||
                (BLOCK_HASH.test(score.target?.targetHash ?? '') &&
                  utcMs(score.target.targetBlockAt) >= targetMs &&
                  utcMs(score.target.targetBlockAt) <= deadlineMs)),
            'score_binding_invalid',
          )
          consumed.add(cell)
          if (issueVisible && scoreRecord.scoredAtMs <= nowMs)
            diagnostics.get(subjectKey).scoredTargets++
        }
        for (const [i, entry] of issue.cases.entries()) {
          const scoreCase = score?.cases[i]
          check(
            !score || (scoreCase?.label === entry.label && scoreCase.assetsRaw === entry.assetsRaw),
            'score_q_binding_invalid',
          )
          if (entry.assetsRaw === null) {
            check(entry.status === 'omitted', 'case_omission_invalid')
            continue
          }
          const baseline = baselineOf(entry, issue.candidate.holder)
          if (score && baseline.status === 'simulated_callable')
            check(
              scoreCase?.status === 'measured' || scoreCase?.status === 'unavailable',
              'score_case_invalid',
            )
          if (!issueVisible) continue
          if (featureJoin === null)
            featureJoin = selectAsOfFeatures(
              featuresBySubject.get(subjectKey) ?? [],
              subject,
              issue,
              {
                baseline: {
                  targetBlock: issue.baseline.targetBlock,
                  targetHash: issue.baseline.targetHash,
                  targetBlockAt: issue.baseline.targetBlockAt,
                },
              },
            )
          const visibleScore = scoreRecord?.scoredAtMs <= nowMs ? score : null
          const visibleScoreCase = visibleScore ? scoreCase : null
          const outcome = outcomeOf(baseline, visibleScore, visibleScoreCase, deadlineMs, nowMs)
          episodes.push({
            subject: subjectKey,
            stageScope: `direct_${lane}_withdraw_eth_call`,
            fullRoutePaidProofSha256: null,
            lane,
            issueClusterSha256: issue.sha256,
            issueSha256: issue.sha256,
            scoreSha256: visibleScore?.sha256 ?? null,
            holderCommitment: issue.candidate.holder
              ? sha(`${route.destination}:${issue.candidate.holder}`)
              : null,
            qRaw: entry.assetsRaw,
            qUnit: 'asset_raw',
            qCaseLabel: entry.label,
            plannedHorizonHours: horizon,
            leadAtIssueMinutes: horizon * 60,
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
          check(episodes.length <= 20_000, 'row_limit')
        }
      }
    }
    for (const cell of scoresByCell.keys()) check(consumed.has(cell), 'orphan_score')
  }
  return { episodes, diagnostics, board }
}
