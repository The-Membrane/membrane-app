// Pure projection of a caller-supplied, verified Staked USDat holder ledger.
// requestRedeem is an eth_call: no ticket is minted and no USDat/AUSD is paid.
// Freeze the source identities here to avoid importing the RPC/TypeScript reader.
import { createHash } from 'node:crypto'

const ROUTE = 'AUSD → Staked USDat [USDat]'
const VAULT = '0xd166337499e176bbc38a1fbd113ab144e5bd2df7'
const USDAT = '0x23238f20b894f29041f48d88ee91131c395aaa71'
const VAULT_IMPL = '0x2b7074cf6681382b70e239063931ebe83c0f4e0a'
const VAULT_HASH = '0xec3b77f722a89eec23e7dfb2ddfe63e4d82f37adbc5f75a269ed2c82c3ad0300'
const QUEUE_IMPL = '0xdaf6f8523d7a707d173a12041e1523fdf1373f23'
const QUEUE_HASH = '0x537d27c7b1574e4ab94867b9f5719414169c5941387346bca88b84643612256d'
const STUDY = 'carry_local_staked_usdat_holder_v2'
const SHARES_RAW = '10000000000000000000'
const HORIZONS_HOURS = [1, 4, 24, 48, 168]
const MAX_ISSUES = 2_000
const MAX_SCORES = MAX_ISSUES * HORIZONS_HOURS.length
const MAX_ATTEMPTS = 100_000
const SHA = /^[0-9a-f]{64}$/
const HASH = /^0x[0-9a-f]{64}$/i
const ADDRESS = /^0x[0-9a-f]{40}$/i

export const STAKED_USDAT_SUBJECT = Object.freeze({
  route_key: ROUTE,
  destination: VAULT,
  asset: USDAT,
})

const hash = (value) => createHash('sha256').update(value).digest('hex')
const identity = (route, destination, asset) =>
  `${route}\0${destination.toLowerCase()}\0${asset.toLowerCase()}`
const check = (condition, reason) => {
  if (!condition) throw Error(`holder_episode_panel_staked_usdat_${reason}`)
}
const sealed = (row) => {
  if (!row || !SHA.test(row.sha256 ?? '')) return false
  const { sha256, ...payload } = row
  return hash(JSON.stringify(payload)) === sha256
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
const rawAtLeastQ = (value) =>
  typeof value === 'string' && /^\d+$/.test(value) && BigInt(value) >= BigInt(SHARES_RAW)
const rawAmount = (value) => typeof value === 'string' && /^\d+$/.test(value)
const pinnedRegime = (regime) =>
  regime?.vaultImpl?.toLowerCase() === VAULT_IMPL &&
  regime?.vaultCodeHash?.toLowerCase() === VAULT_HASH &&
  regime?.queueImpl?.toLowerCase() === QUEUE_IMPL &&
  regime?.queueCodeHash?.toLowerCase() === QUEUE_HASH

function transitionOf(issue, measurement) {
  if (measurement.outcome === 'regime_changed') return 'regime_change_censored'
  if (!measurement.holderEoa || BigInt(measurement.holderSharesRaw) < BigInt(SHARES_RAW))
    return 'holder_attrition'
  if (
    BigInt(measurement.maxRedeemSharesRaw) < BigInt(SHARES_RAW) ||
    measurement.outcome === 'not_attempted'
  )
    return 'request_unavailable'
  if (issue.measurement.outcome === 'evm_revert' && measurement.outcome === 'success')
    return 'simulated_call_recovery'
  if (issue.measurement.outcome === 'evm_revert' && measurement.outcome === 'evm_revert')
    return 'still_reverting'
  if (issue.measurement.outcome === 'success' && measurement.outcome === 'success')
    return 'still_callable'
  if (issue.measurement.outcome === 'success' && measurement.outcome === 'evm_revert')
    return 'became_reverting'
  return 'unclassified'
}

function outcomeOf(issue, score, deadlineMs, nowMs) {
  if (!score)
    return nowMs <= deadlineMs
      ? { status: 'pending', reason: null }
      : { status: 'missing', reason: 'no_verified_score_after_deadline' }
  if (score.status === 'missed_deadline')
    return { status: 'censored', reason: 'capture_window_missed' }
  if (score.transition === 'regime_change_censored')
    return { status: 'censored', reason: 'regime_changed' }
  if (score.transition === 'holder_attrition')
    return { status: 'censored', reason: 'holder_attrition' }
  if (score.transition === 'request_unavailable')
    return { status: 'censored', reason: 'request_unavailable' }
  // A generic baseline revert does not identify venue impairment or its cause.
  if (issue.measurement.outcome === 'evm_revert')
    return { status: 'not_at_risk', reason: 'baseline_revert_cause_unknown' }
  if (score.transition === 'still_callable') return { status: 'simulated_callable', reason: null }
  if (score.transition === 'became_reverting')
    return { status: 'inconclusive', reason: 'revert_cause_unknown' }
  throw Error('holder_episode_panel_staked_usdat_outcome_invalid')
}

export function stakedUsdatBoardSubjects(manifest) {
  check(Array.isArray(manifest?.subjects), 'manifest_invalid')
  const matches = manifest.subjects.filter(
    (subject) =>
      subject.route_key === ROUTE &&
      subject.destination?.toLowerCase() === VAULT &&
      subject.asset?.toLowerCase() === USDAT,
  )
  check(matches.length === 1, 'frozen_subject_invalid')
  return new Map([[identity(ROUTE, VAULT, USDAT), matches[0]]])
}

/** Call with carry-local-staked-usdat-holder.verifyAll(false)'s result. No I/O or RPC here. */
export function buildStakedUsdatEpisodes({
  manifest,
  ledger,
  featuresBySubject = new Map(),
  selectAsOfFeatures,
  nowMs,
}) {
  const board = stakedUsdatBoardSubjects(manifest)
  check(Number.isSafeInteger(nowMs) && nowMs >= 0, 'now_invalid')
  check(
    featuresBySubject instanceof Map && typeof selectAsOfFeatures === 'function',
    'features_invalid',
  )
  const { issues, scores, attempts, orphanIssues = 0, orphanScores = 0 } = ledger ?? {}
  check(
    Array.isArray(issues) &&
      issues.length <= MAX_ISSUES &&
      Array.isArray(scores) &&
      scores.length <= MAX_SCORES &&
      Array.isArray(attempts) &&
      attempts.length <= MAX_ATTEMPTS &&
      orphanIssues === 0 &&
      orphanScores === 0,
    'ledger_limit_or_orphans',
  )
  const subjectKey = identity(ROUTE, VAULT, USDAT)
  const subject = board.get(subjectKey)
  const counts = {
    issues: 0,
    scoredTargets: 0,
    measuredTargets: 0,
    missedDeadlineTargets: 0,
    pendingTargets: 0,
    missingTargets: 0,
    holderAttritionCensors: 0,
    regimeChangeCensors: 0,
    requestUnavailableCensors: 0,
    attempts: 0,
  }
  const diagnostics = new Map([[subjectKey, counts]])
  for (const attempt of attempts) {
    check(sealed(attempt), 'attempt_unsealed')
    const startedMs = utcMs(attempt.startedAtUtc)
    const finishedMs = utcMs(attempt.finishedAtUtc)
    check(startedMs <= finishedMs, 'attempt_clock_invalid')
    if (finishedMs <= nowMs) counts.attempts++
  }
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
      'orphan_or_unsealed_score',
    )
    const cell = `${score.issueSequence}:${score.horizonHours}`
    check(!scoresByCell.has(cell), 'score_duplicate')
    scoresByCell.set(cell, score)
  }
  const episodes = []
  const consumed = new Set()
  for (const issue of issues) {
    check(
      issue.study === STUDY &&
        issue.kind === 'issue' &&
        issue.routeKey === ROUTE &&
        issue.destination?.toLowerCase() === VAULT &&
        issue.sharesRaw === SHARES_RAW &&
        ADDRESS.test(issue.holder ?? '') &&
        headerValid(issue.baseline) &&
        pinnedRegime(issue.measurement?.regime) &&
        issue.measurement?.holderEoa === true &&
        rawAtLeastQ(issue.measurement?.holderSharesRaw) &&
        rawAtLeastQ(issue.measurement?.maxRedeemSharesRaw) &&
        ['success', 'evm_revert'].includes(issue.measurement?.outcome) &&
        Array.isArray(issue.targets) &&
        issue.targets.length === HORIZONS_HOURS.length,
      'issue_identity_invalid',
    )
    const issueMs = utcMs(issue.issuedAtUtc)
    const baselineMs = issue.baseline.timestamp * 1_000
    check(baselineMs <= issueMs, 'baseline_clock_invalid')
    const visibleIssue = issueMs <= nowMs
    if (visibleIssue) counts.issues++
    const featureJoin = visibleIssue
      ? selectAsOfFeatures(featuresBySubject.get(subjectKey) ?? [], subject, issue, {
          baseline: {
            targetBlock: String(issue.baseline.number),
            targetHash: issue.baseline.hash,
            targetBlockAt: new Date(baselineMs).toISOString(),
          },
        })
      : null
    for (const [index, target] of issue.targets.entries()) {
      const horizon = HORIZONS_HOURS[index]
      const targetMs = utcMs(target.targetAtUtc)
      const deadlineMs = utcMs(target.deadlineUtc)
      check(
        target.horizonHours === horizon &&
          targetMs === baselineMs + horizon * 3_600_000 &&
          issueMs < targetMs &&
          deadlineMs === targetMs + 2 * 3_600_000,
        'target_invalid',
      )
      const cell = `${issue.sequence}:${horizon}`
      const recordedScore = scoresByCell.get(cell)
      let scoredMs = null
      if (recordedScore) {
        check(
          recordedScore.study === STUDY &&
            recordedScore.kind === 'score' &&
            recordedScore.issueSha256 === issue.sha256 &&
            recordedScore.horizonHours === horizon &&
            ['measured', 'missed_deadline'].includes(recordedScore.status),
          'score_binding_invalid',
        )
        scoredMs = utcMs(recordedScore.scoredAtUtc)
        if (recordedScore.status === 'measured') {
          check(
            targetMs <= scoredMs &&
              scoredMs <= deadlineMs &&
              headerValid(recordedScore.targetBlock) &&
              headerValid(recordedScore.parentBlock) &&
              recordedScore.parentBlock.number === recordedScore.targetBlock.number - 1 &&
              recordedScore.parentBlock.hash.toLowerCase() ===
                recordedScore.targetBlock.parentHash.toLowerCase() &&
              recordedScore.parentBlock.timestamp * 1_000 < targetMs &&
              recordedScore.targetBlock.timestamp * 1_000 >= targetMs &&
              recordedScore.targetBlock.timestamp * 1_000 <= scoredMs &&
              ['success', 'evm_revert', 'not_attempted', 'regime_changed'].includes(
                recordedScore.measurement?.outcome,
              ) &&
              (recordedScore.measurement.outcome === 'regime_changed' ||
                (pinnedRegime(recordedScore.measurement.regime) &&
                  rawAmount(recordedScore.measurement.holderSharesRaw) &&
                  rawAmount(recordedScore.measurement.maxRedeemSharesRaw))) &&
              recordedScore.transition === transitionOf(issue, recordedScore.measurement),
            'score_measurement_invalid',
          )
        } else {
          check(
            scoredMs > deadlineMs &&
              recordedScore.targetBlock === null &&
              recordedScore.parentBlock === null &&
              recordedScore.measurement === null &&
              recordedScore.transition === 'missing',
            'score_missed_invalid',
          )
        }
        consumed.add(cell)
      }
      if (!visibleIssue) continue
      const score = recordedScore && scoredMs <= nowMs ? recordedScore : null
      if (score) {
        counts.scoredTargets++
        if (score.status === 'measured') {
          counts.measuredTargets++
          if (score.transition === 'holder_attrition') counts.holderAttritionCensors++
          if (score.transition === 'regime_change_censored') counts.regimeChangeCensors++
          if (score.transition === 'request_unavailable') counts.requestUnavailableCensors++
        } else counts.missedDeadlineTargets++
      } else if (nowMs <= deadlineMs) counts.pendingTargets++
      else counts.missingTargets++
      const outcome = outcomeOf(issue, score, deadlineMs, nowMs)
      episodes.push({
        subject: subjectKey,
        stageScope: 'staked_usdat_redeem_eth_call',
        fullRoutePaidProofSha256: null,
        lane: 'staked_usdat_holder_v2',
        issueClusterSha256: issue.sha256,
        issueSha256: issue.sha256,
        scoreSha256: score?.sha256 ?? null,
        holderCommitment: hash(`${VAULT}:${issue.holder.toLowerCase()}`),
        qRaw: SHARES_RAW,
        qUnit: 'stUSDat_shares',
        qCaseLabel: 'fixed_ten_stusdat_shares',
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
          score?.status === 'measured'
            ? new Date(score.targetBlock.timestamp * 1_000).toISOString()
            : null,
        labelAvailableAtUtc: score?.scoredAtUtc ?? null,
        ...featureJoin,
        baseline: issue.measurement.outcome === 'success' ? 'simulated_callable' : 'inconclusive',
        baselineReason: issue.measurement.outcome === 'evm_revert' ? 'revert_cause_unknown' : null,
        outcome,
        rawBaselineStatus: issue.measurement.outcome,
        rawBaselineHolderSharesRaw: issue.measurement.holderSharesRaw,
        rawBaselineMaxRedeemSharesRaw: issue.measurement.maxRedeemSharesRaw,
        rawBaselineVaultPaused: issue.measurement.vaultPaused ?? null,
        rawBaselineQueuePaused: issue.measurement.queuePaused ?? null,
        rawScoreStatus: score?.status ?? null,
        rawScoreOutcome: score?.measurement?.outcome ?? null,
        rawScoreHolderSharesRaw: score?.measurement?.holderSharesRaw ?? null,
        rawScoreMaxRedeemSharesRaw: score?.measurement?.maxRedeemSharesRaw ?? null,
        rawScoreVaultPaused: score?.measurement?.vaultPaused ?? null,
        rawScoreQueuePaused: score?.measurement?.queuePaused ?? null,
        rawTransition: score?.transition ?? null,
        analysisPrimaryForCell: false,
        forecastEligible: false,
      })
      check(episodes.length <= MAX_SCORES, 'row_limit')
    }
  }
  for (const cell of scoresByCell.keys()) check(consumed.has(cell), 'orphan_score')
  return { board, episodes, diagnostics }
}
