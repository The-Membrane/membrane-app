// Pure projection of a caller-supplied, verified Umbrella stkGHO holder ledger.
// These V1 identities and plans are frozen here so projection has no RPC/TS reader import.
// A redeem eth_call is a block-specific simulation, never a mined GHO payout.
import { createHash } from 'node:crypto'

const ROUTE = 'GHO → UmbrellaStakeToken [GHO]'
const VAULT = '0x4f827a63755855cdf3e8f3bcd20265c833f15033'
const GHO = '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f'
const IMPLEMENTATION = '0x75e8ac0c063b6966e2a9954adedf39bde9370197'
const STUDY = 'carry_local_umbrella_gho_holder_v1'
const SHARES_RAW = '1000000000000000000'
const LEGACY_HORIZONS = [1, 24, 48, 168]
const HORIZONS_HOURS = [1, 24, 48, 168, 348, 360, 384, 432]
export const UMBRELLA_SUBJECT = Object.freeze({
  route_key: ROUTE,
  destination: VAULT,
  asset: GHO,
})
const SHA = /^[0-9a-f]{64}$/
const HASH = /^0x[0-9a-f]{64}$/i
const ADDRESS = /^0x[0-9a-f]{40}$/i
const MAX_ISSUES = 2_000
const MAX_SCORES = 16_000
const MAX_ATTEMPTS = 100_000
const MAX_EPISODES = 20_000
const ATTEMPT_SLOT_MS = 30 * 60_000
const LINKED_ATTEMPT_STATUSES = new Set([
  'issued',
  'scored',
  'reconciled_issue',
  'reconciled_score',
])
const ATTEMPT_STATUSES = new Set([
  ...LINKED_ATTEMPT_STATUSES,
  'nothing_due',
  'duplicate_slot',
  'failed',
])
const sha = (value) => createHash('sha256').update(value).digest('hex')
const sealed = (row) => {
  if (!row || !SHA.test(row.sha256 ?? '')) return false
  const { sha256, ...payload } = row
  return sha(JSON.stringify(payload)) === sha256
}
const key = (route, destination, asset) =>
  `${route}\0${destination.toLowerCase()}\0${asset.toLowerCase()}`
const check = (condition, reason) => {
  if (!condition) throw Error(`holder_episode_panel_umbrella_${reason}`)
}
const utcMs = (value) => {
  const ms = Date.parse(value)
  check(Number.isSafeInteger(ms) && new Date(ms).toISOString() === value, 'clock_invalid')
  return ms
}
const headerValid = (block) =>
  Number.isSafeInteger(block?.number) &&
  block.number > 0 &&
  HASH.test(block.hash ?? '') &&
  HASH.test(block.parentHash ?? '') &&
  Number.isSafeInteger(block.timestamp) &&
  block.timestamp > 0
const transitionOf = (issue, measurement) => {
  if (measurement.outcome === 'regime_changed') return 'regime_change_censored'
  if (!measurement.holderEoa || BigInt(measurement.holderSharesRaw) < BigInt(SHARES_RAW))
    return 'holder_attrition'
  if (measurement.outcome === 'success')
    return issue.measurement.outcome === 'success' ? 'still_callable' : 'simulated_call_recovery'
  if (measurement.outcome === 'evm_revert')
    return issue.measurement.outcome === 'success' ? 'became_reverting' : 'still_reverting'
  return 'unassessed'
}

export function umbrellaBoardSubjects(manifest) {
  check(Array.isArray(manifest?.subjects), 'manifest_invalid')
  const matches = manifest.subjects.filter(
    (subject) =>
      subject.route_key === ROUTE &&
      subject.destination?.toLowerCase() === VAULT &&
      subject.asset?.toLowerCase() === GHO,
  )
  check(matches.length === 1, 'frozen_subject_invalid')
  return new Map([[key(ROUTE, VAULT, GHO), matches[0]]])
}

function holderCodeEvidence(measurement, sequence, legacyLastSequence) {
  if (!measurement || measurement.outcome === 'regime_changed') return 'not_observed'
  const status = measurement.holderCodeStatus
  if (status === undefined) {
    check(
      sequence <= legacyLastSequence &&
        !('holderCodeHex' in measurement) &&
        !('holderCodeHash' in measurement),
      'holder_code_proof_missing',
    )
    return 'legacy_unattested'
  }
  check(
    ['no_code', 'eip7702_delegated', 'contract_code'].includes(status) &&
      measurement.holderEoa === (status !== 'contract_code') &&
      (status === 'no_code'
        ? measurement.holderCodeHex === '0x' && measurement.holderCodeHash === null
        : status === 'eip7702_delegated'
          ? /^0xef0100[0-9a-f]{40}$/i.test(measurement.holderCodeHex ?? '') &&
            HASH.test(measurement.holderCodeHash ?? '')
          : measurement.holderCodeHex === null && HASH.test(measurement.holderCodeHash ?? '')),
    'holder_code_proof_invalid',
  )
  return status
}

function outcomeOf(baselineOutcome, score, deadlineMs, nowMs) {
  if (baselineOutcome === 'evm_revert')
    return { status: 'not_at_risk', reason: 'baseline_revert_cause_unknown' }
  if (!score)
    return nowMs <= deadlineMs
      ? { status: 'pending', reason: null }
      : { status: 'missing', reason: 'no_verified_score_after_deadline' }
  if (score.status === 'missed_deadline')
    return { status: 'censored', reason: 'capture_window_missed' }
  const measurement = score.measurement
  if (measurement.outcome === 'regime_changed')
    return { status: 'censored', reason: 'regime_changed' }
  if (!measurement.holderEoa) return { status: 'censored', reason: 'holder_origin_ineligible' }
  if (BigInt(measurement.holderSharesRaw) < BigInt(SHARES_RAW))
    return { status: 'censored', reason: 'holder_attrition' }
  if (measurement.outcome === 'success') return { status: 'simulated_callable', reason: null }
  if (measurement.outcome === 'evm_revert')
    return { status: 'inconclusive', reason: 'revert_cause_unknown' }
  check(measurement.outcome === 'not_attempted', 'outcome_invalid')
  return { status: 'inconclusive', reason: 'simulation_not_attempted' }
}

/** Call with verifyAll(false)'s result; this function never reads files or calls an RPC. */
export function buildUmbrellaEpisodes({
  manifest,
  ledger,
  featuresBySubject = new Map(),
  selectAsOfFeatures,
  nowMs,
}) {
  const board = umbrellaBoardSubjects(manifest)
  check(Number.isSafeInteger(nowMs) && nowMs >= 0, 'now_invalid')
  check(
    featuresBySubject instanceof Map && typeof selectAsOfFeatures === 'function',
    'features_invalid',
  )
  const { issues, scores, attempts } = ledger ?? {}
  check(
    Array.isArray(issues) &&
      issues.length <= MAX_ISSUES &&
      Array.isArray(scores) &&
      scores.length <= MAX_SCORES &&
      Array.isArray(attempts) &&
      attempts.length <= MAX_ATTEMPTS,
    'ledger_limit',
  )
  const subjectKey = key(ROUTE, VAULT, GHO)
  const subject = board.get(subjectKey)
  let visibleAttempts = 0
  let previousAttemptSha256 = null
  const linkedAttemptRecords = new Set()
  for (const [index, attempt] of attempts.entries()) {
    check(
      attempt?.sequence === index + 1 &&
        attempt.previousSha256 === previousAttemptSha256 &&
        sealed(attempt),
      'attempt_chain_invalid',
    )
    const startedMs = utcMs(attempt.startedAtUtc)
    const finishedMs = utcMs(attempt.finishedAtUtc)
    const linked = LINKED_ATTEMPT_STATUSES.has(attempt.status)
    check(
      attempt.study === STUDY &&
        attempt.kind === 'attempt' &&
        ['issue', 'score'].includes(attempt.mode) &&
        finishedMs >= startedMs &&
        attempt.slot === Math.floor(startedMs / ATTEMPT_SLOT_MS) &&
        ATTEMPT_STATUSES.has(attempt.status) &&
        (linked
          ? Number.isSafeInteger(attempt.recordSequence) &&
            attempt.recordSequence > 0 &&
            SHA.test(attempt.recordSha256 ?? '')
          : attempt.recordSequence === null && attempt.recordSha256 === null),
      'attempt_invalid',
    )
    if (linked) {
      const mode = ['issued', 'reconciled_issue'].includes(attempt.status) ? 'issue' : 'score'
      const record = (mode === 'issue' ? issues : scores)[attempt.recordSequence - 1]
      const recordKey = `${mode}:${attempt.recordSequence}`
      const recordedMs = record && utcMs(record[mode === 'issue' ? 'issuedAtUtc' : 'scoredAtUtc'])
      check(
        record?.sha256 === attempt.recordSha256 &&
          !linkedAttemptRecords.has(recordKey) &&
          (attempt.status.startsWith('reconciled_')
            ? recordedMs <= startedMs
            : startedMs <= recordedMs && recordedMs <= finishedMs),
        'attempt_link_invalid',
      )
      linkedAttemptRecords.add(recordKey)
    }
    if (finishedMs <= nowMs) visibleAttempts++
    previousAttemptSha256 = attempt.sha256
  }
  const diagnostics = new Map([
    [
      subjectKey,
      {
        issues: 0,
        scoredTargets: 0,
        measuredTargets: 0,
        missedDeadlineTargets: 0,
        attempts: visibleAttempts,
        legacyIssueHolderCodeProofs: 0,
        legacyScoreHolderCodeProofs: 0,
        rawAttestedIssueHolderCodeProofs: 0,
        rawAttestedMeasuredScoreHolderCodeProofs: 0,
        rawAttestedCells: 0,
      },
    ],
  ])
  const counts = diagnostics.get(subjectKey)
  const issueBySequence = new Map()
  for (const issue of issues) {
    check(
      Number.isSafeInteger(issue?.sequence) &&
        issue.sequence > 0 &&
        !issueBySequence.has(issue.sequence) &&
        sealed(issue),
      'issue_duplicate_or_unsealed',
    )
    issueBySequence.set(issue.sequence, issue)
  }
  const scoresByCell = new Map()
  for (const score of scores) {
    const issue = issueBySequence.get(score?.issueSequence)
    check(
      issue &&
        score.issueSha256 === issue.sha256 &&
        sealed(score) &&
        Number.isSafeInteger(score.horizonHours),
      'orphan_score',
    )
    const cell = `${score.issueSequence}:${score.horizonHours}`
    check(!scoresByCell.has(cell), 'score_duplicate')
    scoresByCell.set(cell, score)
  }
  const episodes = []
  const consumed = new Set()
  for (const issue of issues) {
    const horizons = issue.sequence === 1 ? LEGACY_HORIZONS : HORIZONS_HOURS
    check(
      issue.study === STUDY &&
        issue.kind === 'issue' &&
        issue.routeKey === ROUTE &&
        issue.destination?.toLowerCase() === VAULT &&
        issue.sharesRaw === SHARES_RAW &&
        ADDRESS.test(issue.holder ?? '') &&
        headerValid(issue.baseline) &&
        issue.measurement?.asset?.toLowerCase() === GHO &&
        issue.measurement?.implementation?.toLowerCase() === IMPLEMENTATION &&
        HASH.test(issue.measurement?.codeHash ?? '') &&
        issue.measurement?.holderEoa === true &&
        ['success', 'evm_revert'].includes(issue.measurement?.outcome) &&
        BigInt(issue.measurement?.holderSharesRaw ?? '0') >= BigInt(SHARES_RAW) &&
        Array.isArray(issue.targets) &&
        issue.targets.length === horizons.length,
      'issue_identity_invalid',
    )
    const issueMs = utcMs(issue.issuedAtUtc)
    const baselineMs = issue.baseline.timestamp * 1_000
    check(baselineMs <= issueMs, 'baseline_clock_invalid')
    const issueCodeEvidence = holderCodeEvidence(issue.measurement, issue.sequence, 3)
    const issueVisible = issueMs <= nowMs
    if (issueVisible) {
      counts.issues++
      if (issueCodeEvidence === 'legacy_unattested') counts.legacyIssueHolderCodeProofs++
      else counts.rawAttestedIssueHolderCodeProofs++
    }
    const featureJoin = issueVisible
      ? selectAsOfFeatures(featuresBySubject.get(subjectKey) ?? [], subject, issue, {
          baseline: {
            targetBlock: String(issue.baseline.number),
            targetHash: issue.baseline.hash,
            targetBlockAt: new Date(baselineMs).toISOString(),
          },
        })
      : null
    for (const [index, target] of issue.targets.entries()) {
      const horizon = horizons[index]
      const targetMs = utcMs(target.targetAtUtc)
      const deadlineMs = utcMs(target.deadlineUtc)
      check(
        target.horizonHours === horizon &&
          targetMs === baselineMs + horizon * 3_600_000 &&
          targetMs > issueMs &&
          deadlineMs === targetMs + 2 * 3_600_000,
        'target_invalid',
      )
      const cell = `${issue.sequence}:${horizon}`
      const score = scoresByCell.get(cell)
      let scoreCodeEvidence = 'not_observed'
      let scoreVisible = false
      if (score) {
        check(
          score.study === STUDY &&
            score.kind === 'score' &&
            score.issueSha256 === issue.sha256 &&
            score.horizonHours === horizon &&
            ['measured', 'missed_deadline'].includes(score.status),
          'score_binding_invalid',
        )
        const scoredMs = utcMs(score.scoredAtUtc)
        scoreVisible = issueVisible && scoredMs <= nowMs
        if (score.status === 'measured') {
          check(
            targetMs <= scoredMs &&
              scoredMs <= deadlineMs &&
              headerValid(score.targetBlock) &&
              headerValid(score.parentBlock) &&
              score.targetBlock.number === score.parentBlock.number + 1 &&
              score.targetBlock.parentHash.toLowerCase() === score.parentBlock.hash.toLowerCase() &&
              score.parentBlock.timestamp * 1_000 < targetMs &&
              score.targetBlock.timestamp * 1_000 >= targetMs &&
              score.targetBlock.timestamp * 1_000 <= scoredMs &&
              score.measurement &&
              ['success', 'evm_revert', 'not_attempted', 'regime_changed'].includes(
                score.measurement.outcome,
              ) &&
              (score.measurement.outcome === 'regime_changed' ||
                (score.measurement.asset?.toLowerCase() === GHO &&
                  score.measurement.codeHash === issue.measurement.codeHash)) &&
              score.transition === transitionOf(issue, score.measurement),
            'score_measurement_invalid',
          )
          scoreCodeEvidence = holderCodeEvidence(score.measurement, score.sequence, 5)
          if (scoreVisible) {
            counts.measuredTargets++
            if (scoreCodeEvidence === 'legacy_unattested') counts.legacyScoreHolderCodeProofs++
            else if (scoreCodeEvidence !== 'not_observed')
              counts.rawAttestedMeasuredScoreHolderCodeProofs++
          }
        } else {
          check(
            scoredMs > deadlineMs &&
              headerValid(score.deadlineFinalizedBlock) &&
              score.deadlineFinalizedBlock.timestamp * 1_000 > deadlineMs &&
              score.deadlineFinalizedBlock.timestamp * 1_000 <= scoredMs &&
              score.targetBlock === null &&
              score.parentBlock === null &&
              score.measurement === null &&
              score.transition === 'missing',
            'score_missed_invalid',
          )
          if (scoreVisible) counts.missedDeadlineTargets++
        }
        consumed.add(cell)
        if (scoreVisible) counts.scoredTargets++
      }
      if (!issueVisible) continue
      const visibleScore = scoreVisible ? score : null
      const visibleScoreCodeEvidence = scoreVisible ? scoreCodeEvidence : 'not_observed'
      const rawAttestedCell =
        issueCodeEvidence !== 'legacy_unattested' &&
        !['legacy_unattested', 'not_observed'].includes(visibleScoreCodeEvidence)
      if (rawAttestedCell) counts.rawAttestedCells++
      episodes.push({
        subject: subjectKey,
        stageScope: 'direct_umbrella_redeem_eth_call',
        fullRoutePaidProofSha256: null,
        lane: 'umbrella_stkgho',
        issueClusterSha256: issue.sha256,
        issueSha256: issue.sha256,
        scoreSha256: visibleScore?.sha256 ?? null,
        holderCommitment: sha(`${VAULT}:${issue.holder.toLowerCase()}`),
        qRaw: SHARES_RAW,
        qUnit: 'stkGHO_shares',
        qCaseLabel: 'fixed_one_stkgho_share',
        plannedHorizonHours: horizon,
        leadAtIssueMinutes: (targetMs - issueMs) / 60_000,
        targetClockBasis: 'baseline_block_timestamp_plan',
        issueAtUtc: issue.issuedAtUtc,
        issueClock: 'local_operator_clock_unwitnessed',
        featureAvailabilityClock: 'local_operator_clock_unwitnessed',
        baselineBlock: String(issue.baseline.number),
        baselineBlockHash: issue.baseline.hash,
        baselineAtUtc: new Date(baselineMs).toISOString(),
        targetAtUtc: target.targetAtUtc,
        deadlineAtUtc: target.deadlineUtc,
        observedAtUtc:
          visibleScore?.status === 'measured'
            ? new Date(visibleScore.targetBlock.timestamp * 1_000).toISOString()
            : null,
        labelAvailableAtUtc: visibleScore?.scoredAtUtc ?? null,
        ...featureJoin,
        baseline: issue.measurement.outcome === 'success' ? 'simulated_callable' : 'inconclusive',
        baselineReason: issue.measurement.outcome === 'evm_revert' ? 'revert_cause_unknown' : null,
        outcome: outcomeOf(issue.measurement.outcome, visibleScore, deadlineMs, nowMs),
        issueHolderCodeEvidence: issueCodeEvidence,
        scoreHolderCodeEvidence: visibleScoreCodeEvidence,
        rawHolderCodeAttestedCell: rawAttestedCell,
        rawBaselineStatus: issue.measurement.outcome,
        rawBaselineGate: issue.measurement.gate ?? null,
        rawBaselineWindowOpen: issue.measurement.windowOpen ?? null,
        rawBaselineGhoRaw: issue.measurement.ghoRaw ?? null,
        rawScoreStatus: visibleScore?.status ?? null,
        rawScoreOutcome: visibleScore?.measurement?.outcome ?? null,
        rawScoreGate: visibleScore?.measurement?.gate ?? null,
        rawScoreWindowOpen: visibleScore?.measurement?.windowOpen ?? null,
        rawScoreGhoRaw: visibleScore?.measurement?.ghoRaw ?? null,
        rawTransition: visibleScore?.transition ?? null,
        analysisPrimaryForCell: false,
        forecastEligible: false,
      })
      check(episodes.length <= MAX_EPISODES, 'row_limit')
    }
  }
  for (const cell of scoresByCell.keys()) check(consumed.has(cell), 'orphan_score')
  return { board, episodes, diagnostics }
}
