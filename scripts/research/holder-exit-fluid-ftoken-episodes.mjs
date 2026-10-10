// Pure projection of caller-supplied, already verified Fluid fToken ledgers.
// eth_call callability is neither mined delivery nor a calibrated exit forecast.
import { createHash } from 'node:crypto'

import { ROUTES } from './carry-fluid-ftoken-payout.mjs'

const SHA = /^[0-9a-f]{64}$/
const HASH = /^0x[0-9a-f]{64}$/i
const ADDRESS = /^0x[0-9a-f]{40}$/i
const AMOUNT = /^[1-9][0-9]*$/
const HORIZONS = [1, 4, 24, 48, 168]
const MAX_ISSUES_PER_ROUTE = 2_000
const MAX_SCORES_PER_ROUTE = 10_000
const MAX_EPISODES = 20_000
const sha = (value) => createHash('sha256').update(value).digest('hex')
const key = (route, vault, asset) => `${route}\0${vault.toLowerCase()}\0${asset.toLowerCase()}`
const check = (condition, reason) => {
  if (!condition) throw Error(`holder_episode_panel_fluid_${reason}`)
}
const utcMs = (value) => {
  const ms = Date.parse(value)
  check(Number.isSafeInteger(ms) && new Date(ms).toISOString() === value, 'clock_invalid')
  return ms
}

export function fluidFTokenBoardSubjects(manifest) {
  check(Array.isArray(manifest?.subjects), 'manifest_invalid')
  const board = new Map()
  for (const route of ROUTES) {
    const matches = manifest.subjects.filter(
      (subject) =>
        subject.route_key === route.key &&
        subject.destination?.toLowerCase() === route.vault &&
        subject.asset?.toLowerCase() === route.asset,
    )
    check(matches.length === 1, 'frozen_subject_invalid')
    board.set(key(route.key, route.vault, route.asset), matches[0])
  }
  check(board.size === 3, 'frozen_roster_invalid')
  return board
}

function outcomeOf(score, scoreCase, deadlineMs, nowMs) {
  if (!score)
    return nowMs <= deadlineMs
      ? { status: 'pending', reason: null }
      : { status: 'missing', reason: 'no_verified_score_after_deadline' }
  if (score.status === 'capture_window_missed')
    return { status: 'censored', reason: 'capture_window_missed' }
  if (score.status === 'identity_changed') return { status: 'censored', reason: 'identity_changed' }
  check(score.status === 'measured' && scoreCase, 'score_case_invalid')
  const entitlement = scoreCase.entitlement
  if (entitlement?.status === 'holder_ineligible')
    return { status: 'censored', reason: 'holder_attrition' }
  if (entitlement?.status === 'entitlement_unassessed')
    return { status: 'inconclusive', reason: 'preview_withdraw_reverted' }
  check(entitlement?.status === 'covered', 'entitlement_invalid')
  if (scoreCase.outcome?.status === 'success') return { status: 'simulated_callable', reason: null }
  // A covered revert still has no decoded cause. The verifier only seals evm_revert.
  check(scoreCase.outcome?.status === 'evm_revert', 'assay_invalid')
  return { status: 'inconclusive', reason: 'revert_cause_unknown' }
}

/** Projection only: callers must obtain routeLedgers through verifyIssues/verifyScores. */
export function buildFluidFTokenEpisodes({
  manifest,
  routeLedgers,
  featuresBySubject = new Map(),
  selectAsOfFeatures,
  nowMs,
}) {
  const board = fluidFTokenBoardSubjects(manifest)
  check(Number.isSafeInteger(nowMs) && nowMs >= 0, 'now_invalid')
  check(
    typeof selectAsOfFeatures === 'function' && featuresBySubject instanceof Map,
    'features_invalid',
  )
  check(Array.isArray(routeLedgers) && routeLedgers.length === ROUTES.length, 'ledger_invalid')
  const episodes = []
  const diagnostics = new Map(
    [...board.keys()].map((subject) => [subject, { issues: 0, scoredTargets: 0 }]),
  )
  const seenRoutes = new Set()
  for (const ledger of routeLedgers) {
    const index = ledger?.routeIndex
    check(Number.isInteger(index) && index >= 0 && index < ROUTES.length, 'route_invalid')
    check(!seenRoutes.has(index), 'route_duplicate')
    seenRoutes.add(index)
    const route = ROUTES[index]
    const subjectKey = key(route.key, route.vault, route.asset)
    const subject = board.get(subjectKey)
    const { issues, scores } = ledger
    check(
      Array.isArray(issues) &&
        Array.isArray(scores) &&
        issues.length <= MAX_ISSUES_PER_ROUTE &&
        scores.length <= MAX_SCORES_PER_ROUTE,
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
      scoresByCell.set(cell, score)
    }
    const consumed = new Set()
    for (const issue of issues) {
      check(
        issue.study === 'fluid_ftoken_holder_issue_v1' &&
          issue.routeIndex === index &&
          issue.routeKey === route.key &&
          issue.vault?.toLowerCase() === route.vault &&
          issue.asset?.toLowerCase() === route.asset &&
          ADDRESS.test(issue.holder ?? '') &&
          SHA.test(issue.sha256 ?? '') &&
          Number.isSafeInteger(issue.baseline?.number) &&
          issue.baseline.number >= 0 &&
          HASH.test(issue.baseline?.hash ?? '') &&
          Array.isArray(issue.cases) &&
          issue.cases.length > 0 &&
          issue.cases.length <= 5 &&
          Array.isArray(issue.targets) &&
          issue.targets.length === HORIZONS.length,
        'issue_identity_invalid',
      )
      const issueMs = utcMs(issue.issuedAtUtc)
      const baselineMs = utcMs(issue.baseline.atUtc)
      check(
        baselineMs <= issueMs && issue.baseline.timestamp * 1_000 === baselineMs,
        'baseline_clock_invalid',
      )
      const visibleIssue = issueMs <= nowMs
      const featureJoin = visibleIssue
        ? selectAsOfFeatures(featuresBySubject.get(subjectKey) ?? [], subject, issue, {
            baseline: {
              targetBlock: String(issue.baseline.number),
              targetHash: issue.baseline.hash,
              targetBlockAt: issue.baseline.atUtc,
            },
          })
        : null
      if (visibleIssue) diagnostics.get(subjectKey).issues++
      const labels = new Set()
      const amounts = new Set()
      for (const caseRow of issue.cases) {
        check(
          typeof caseRow.label === 'string' &&
            caseRow.label.length > 0 &&
            !labels.has(caseRow.label) &&
            AMOUNT.test(caseRow.assetsRaw ?? '') &&
            !amounts.has(caseRow.assetsRaw) &&
            ['success', 'evm_revert'].includes(caseRow.baseline?.status),
          'issue_case_invalid',
        )
        labels.add(caseRow.label)
        amounts.add(caseRow.assetsRaw)
      }
      for (const [targetIndex, target] of issue.targets.entries()) {
        const horizon = HORIZONS[targetIndex]
        const targetMs = utcMs(target.targetAtUtc)
        const deadlineMs = utcMs(target.deadlineUtc)
        check(
          target.horizonHours === horizon &&
            targetMs === issueMs + horizon * 3_600_000 &&
            deadlineMs === targetMs + 2 * 3_600_000,
          'target_invalid',
        )
        const cell = `${issue.sequence}:${horizon}`
        const recordedScore = scoresByCell.get(cell)
        const scoredMs = recordedScore ? utcMs(recordedScore.scoredAtUtc) : null
        if (recordedScore) {
          const blockAtMs = recordedScore.block ? utcMs(recordedScore.block.atUtc) : null
          const blockClockValid =
            Number.isSafeInteger(recordedScore.block?.timestamp) &&
            recordedScore.block.timestamp > 0 &&
            blockAtMs === recordedScore.block.timestamp * 1_000 &&
            blockAtMs >= targetMs &&
            blockAtMs <= deadlineMs &&
            blockAtMs <= scoredMs
          check(
            recordedScore.study === 'fluid_ftoken_holder_score_v1' &&
              recordedScore.routeIndex === index &&
              recordedScore.routeKey === route.key &&
              recordedScore.issueSha256 === issue.sha256 &&
              SHA.test(recordedScore.sha256 ?? '') &&
              recordedScore.targetAtUtc === target.targetAtUtc &&
              ['measured', 'capture_window_missed', 'identity_changed'].includes(
                recordedScore.status,
              ) &&
              scoredMs >= targetMs &&
              (recordedScore.status === 'capture_window_missed'
                ? scoredMs > deadlineMs
                : scoredMs <= deadlineMs) &&
              (recordedScore.status === 'measured'
                ? Array.isArray(recordedScore.cases) &&
                  recordedScore.cases.length === issue.cases.length &&
                  HASH.test(recordedScore.block?.hash ?? '') &&
                  blockClockValid &&
                  recordedScore.cases.every(
                    (row, i) =>
                      row.label === issue.cases[i].label &&
                      row.assetsRaw === issue.cases[i].assetsRaw &&
                      ['covered', 'holder_ineligible', 'entitlement_unassessed'].includes(
                        row.entitlement?.status,
                      ) &&
                      (row.entitlement.status === 'covered'
                        ? ['success', 'evm_revert'].includes(row.outcome?.status)
                        : row.outcome === null),
                  )
                : recordedScore.cases === null &&
                  (recordedScore.status === 'identity_changed'
                    ? recordedScore.block === null ||
                      (HASH.test(recordedScore.block?.hash ?? '') && blockClockValid)
                    : recordedScore.block === null &&
                      Number.isSafeInteger(recordedScore.finalizedDeadlineWitness?.timestamp) &&
                      recordedScore.finalizedDeadlineWitness.timestamp * 1_000 > deadlineMs &&
                      recordedScore.finalizedDeadlineWitness.timestamp * 1_000 <= scoredMs)),
            'score_binding_invalid',
          )
          consumed.add(cell)
        }
        if (!visibleIssue) continue
        const score = recordedScore && scoredMs <= nowMs ? recordedScore : null
        if (score) {
          diagnostics.get(subjectKey).scoredTargets++
        }
        for (const [caseIndex, caseRow] of issue.cases.entries()) {
          const scoreCase = score?.status === 'measured' ? score.cases[caseIndex] : null
          const outcome = outcomeOf(score, scoreCase, deadlineMs, nowMs)
          episodes.push({
            subject: subjectKey,
            stageScope: 'direct_fluid_ftoken_withdraw_eth_call',
            fullRoutePaidProofSha256: null,
            lane: 'fluid_ftoken',
            issueClusterSha256: issue.sha256,
            issueSha256: issue.sha256,
            scoreSha256: score?.sha256 ?? null,
            holderCommitment: sha(`${route.vault}:${issue.holder.toLowerCase()}`),
            qRaw: caseRow.assetsRaw,
            qUnit: 'asset_raw',
            qCaseLabel: caseRow.label,
            plannedHorizonHours: horizon,
            leadAtIssueMinutes: (targetMs - issueMs) / 60_000,
            targetClockBasis: 'issue_plan',
            issueAtUtc: issue.issuedAtUtc,
            issueClock: 'local_operator_clock_unwitnessed',
            featureAvailabilityClock: 'local_operator_clock_unwitnessed',
            baselineBlock: String(issue.baseline.number),
            baselineBlockHash: issue.baseline.hash,
            baselineAtUtc: issue.baseline.atUtc,
            targetAtUtc: target.targetAtUtc,
            deadlineAtUtc: target.deadlineUtc,
            observedAtUtc: score?.block?.atUtc ?? null,
            labelAvailableAtUtc: score?.scoredAtUtc ?? null,
            ...featureJoin,
            baseline: caseRow.baseline.status === 'success' ? 'simulated_callable' : 'inconclusive',
            outcome,
            rawBaselineStatus: caseRow.baseline.status,
            rawScoreStatus: score?.status ?? null,
            rawEntitlementStatus: scoreCase?.entitlement?.status ?? null,
            rawScoreOutcome: scoreCase?.outcome?.status ?? null,
            analysisPrimaryForCell: false,
            forecastEligible: false,
          })
          check(episodes.length <= MAX_EPISODES, 'row_limit')
        }
      }
    }
    for (const cell of scoresByCell.keys()) check(consumed.has(cell), 'orphan_score')
  }
  return { episodes, diagnostics, board }
}
