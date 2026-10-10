// Pure projection of caller-verified EXISTING sUSDe pending-queue observations.
// A simulated unstake is a read-only claim assay. This ledger has no mined
// USDe delivery and must not be joined to hypothetical cooldown initiation.
import { createHash } from 'node:crypto'

const ROUTE = 'USDe → Staked USDe [USDe]'
const VAULT = '0x9d39a5de30e57443bff2a8307a4256c8797a3497'
const USDE = '0x4c9edd5852cd905f086c759e8383e09bff1e68b3'
const SILO = '0x7fc7c91d556b400afa565013e3f32055a0713425'
const ISSUE_STUDY = 'susde_public_pending_exit_issue_v1'
const SCORE_STUDY = 'susde_public_pending_exit_score_v1'
const HORIZONS = [1, 4, 24, 48, 168]
const HOUR_MS = 3_600_000
const MAX_ISSUES = 2_000
const MAX_SCORES = MAX_ISSUES * HORIZONS.length
const SHA = /^[0-9a-f]{64}$/
const HASH = /^0x[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const DECIMAL = /^(0|[1-9][0-9]*)$/
const CLAIMS = new Set([
  'not_yet_eligible',
  'simulated_unstake_success',
  'unstake_revert_cause_unknown',
])

export const SUSDE_PENDING_SUBJECT = Object.freeze({
  route_key: ROUTE,
  destination: VAULT,
  asset: USDE,
})

const sha = (value) => createHash('sha256').update(value).digest('hex')
const key = (route, destination, asset) =>
  `${route}\0${destination.toLowerCase()}\0${asset.toLowerCase()}`
const check = (ok, reason) => {
  if (!ok) throw Error(`holder_episode_panel_susde_pending_${reason}`)
}
const utcMs = (value) => {
  const ms = Date.parse(value)
  check(Number.isSafeInteger(ms) && new Date(ms).toISOString() === value, 'clock_invalid')
  return ms
}
const decimal = (value) => typeof value === 'string' && DECIMAL.test(value)

function assertChain(rows, study, limit) {
  check(Array.isArray(rows) && rows.length <= limit, 'ledger_limit')
  let previous = null
  for (const [index, row] of rows.entries()) {
    const { sha256, ...body } = row ?? {}
    check(
      row?.study === study &&
        row.sequence === index + 1 &&
        row.previousSha256 === previous &&
        SHA.test(sha256 ?? '') &&
        sha(JSON.stringify(body)) === sha256,
      'chain_invalid',
    )
    previous = sha256
  }
}

function assertMeasurement(measurement, holder, blockNumber, blockHash) {
  check(
    measurement?.holder === holder &&
      measurement.blockNumber === blockNumber &&
      measurement.blockHash === blockHash &&
      measurement.readOnly === true &&
      measurement.minedDeliveryProven === false &&
      decimal(measurement.pendingAssetsRaw) &&
      (BigInt(measurement.pendingAssetsRaw) === 0n
        ? measurement.cooldownEndUtc === null && measurement.claim === 'no_pending'
        : utcMs(measurement.cooldownEndUtc) > 0 && CLAIMS.has(measurement.claim)),
    'measurement_invalid',
  )
}

function selectedQueue(issue) {
  check(Array.isArray(issue.screened) && issue.screened.length <= 8, 'screen_invalid')
  const selected = issue.screened.filter((row) => row?.status === 'selected')
  check(selected.length === 1, 'selected_queue_invalid')
  const row = selected[0]
  check(
    row.holderCommitment === sha(`${VAULT}:${issue.holder}`) &&
      HASH.test(row.discoveryTransactionHash ?? '') &&
      decimal(row.discoveryBlock) &&
      decimal(row.discoveryLogIndex) &&
      row.receiptProof?.transactionHash === row.discoveryTransactionHash &&
      HASH.test(row.receiptProof?.blockHash ?? '') &&
      BigInt(row.discoveryBlock) < BigInt(issue.anchor.blockNumber),
    'selected_queue_invalid',
  )
  // A queue can be issued more than once. Cluster its receipt-screened origin,
  // owner and frozen queue state, while leaving each issue's target clock intact.
  return sha(
    JSON.stringify([
      ISSUE_STUDY,
      VAULT,
      issue.holder,
      issue.pendingAssetsRaw,
      issue.cooldownEndUtc,
      row.discoveryTransactionHash,
      row.receiptProof.blockHash,
      row.discoveryBlock,
      row.discoveryLogIndex,
    ]),
  )
}

function expectedOutcome(issue, measurement) {
  const pending = BigInt(measurement.pendingAssetsRaw)
  const original = BigInt(issue.pendingAssetsRaw)
  if (pending === 0n) return 'queue_absent_cause_unknown'
  if (pending < original) return 'queue_amount_changed_cause_unknown'
  if (pending > original || measurement.cooldownEndUtc !== issue.cooldownEndUtc)
    return 'queue_reset_or_replaced'
  if (measurement.claim === 'not_yet_eligible') return 'not_yet_eligible'
  if (measurement.claim === 'simulated_unstake_success')
    return 'simulated_whole_queue_unstake_success'
  if (measurement.claim === 'unstake_revert_cause_unknown') return 'unstake_revert_cause_unknown'
  throw Error('holder_episode_panel_susde_pending_claim_invalid')
}

function baselineOf(issue) {
  if (issue.measurement.claim === 'simulated_unstake_success')
    return { baseline: 'simulated_callable', reason: null }
  if (issue.measurement.claim === 'not_yet_eligible')
    return { baseline: 'time_gated', reason: 'cooldown_not_yet_eligible' }
  return { baseline: 'inconclusive', reason: 'unstake_revert_cause_unknown' }
}

function outcomeOf(baseline, score, deadlineMs, nowMs) {
  if (baseline.baseline === 'inconclusive')
    return { status: 'not_at_risk', reason: 'baseline_unstake_revert_cause_unknown' }
  if (!score)
    return nowMs <= deadlineMs
      ? { status: 'pending', reason: null }
      : { status: 'missing', reason: 'no_verified_score_after_deadline' }
  if (!score.onTime) return { status: 'censored', reason: 'capture_window_missed' }
  if (score.outcome === 'simulated_whole_queue_unstake_success')
    return { status: 'simulated_callable', reason: null }
  if (score.outcome === 'not_yet_eligible')
    return { status: 'not_at_risk', reason: 'cooldown_not_yet_eligible' }
  if (score.outcome === 'unstake_revert_cause_unknown')
    return { status: 'inconclusive', reason: 'unstake_revert_cause_unknown' }
  if (score.outcome === 'queue_absent_cause_unknown')
    return { status: 'censored', reason: 'queue_absent_cause_unknown' }
  if (score.outcome === 'queue_amount_changed_cause_unknown')
    return { status: 'censored', reason: 'queue_amount_changed_cause_unknown' }
  return { status: 'censored', reason: 'queue_reset_or_replaced' }
}

export function susdePendingBoardSubjects(manifest) {
  check(Array.isArray(manifest?.subjects), 'manifest_invalid')
  const matches = manifest.subjects.filter(
    (subject) =>
      subject.route_key === ROUTE &&
      subject.destination?.toLowerCase() === VAULT &&
      subject.asset?.toLowerCase() === USDE,
  )
  check(matches.length === 1, 'frozen_subject_invalid')
  return new Map([[key(ROUTE, VAULT, USDE), matches[0]]])
}

/** Accept only verifyIssues() and verifyScores() results from the pending-exit readers. */
export function buildSusdePendingEpisodes({
  manifest,
  issues,
  scores,
  featuresBySubject = new Map(),
  selectAsOfFeatures,
  nowMs,
}) {
  const board = susdePendingBoardSubjects(manifest)
  check(Number.isSafeInteger(nowMs) && nowMs >= 0, 'now_invalid')
  check(
    featuresBySubject instanceof Map && typeof selectAsOfFeatures === 'function',
    'features_invalid',
  )
  assertChain(issues, ISSUE_STUDY, MAX_ISSUES)
  assertChain(scores, SCORE_STUDY, MAX_SCORES)
  const subjectKey = key(ROUTE, VAULT, USDE)
  const subject = board.get(subjectKey)
  const counts = {
    issues: 0,
    uniqueQueues: 0,
    scoredTargets: 0,
    measuredTargets: 0,
    missedWindowTargets: 0,
    queueAttritionCensors: 0,
    unknownReverts: 0,
    pendingTargets: 0,
    missingTargets: 0,
    minedDeliveryProven: false,
  }
  const diagnostics = new Map([[subjectKey, counts]])
  const queueByIssue = new Map()
  const queueClusters = new Set()
  const visibleIssues = []
  const visibleIssueSequences = new Set()
  for (const issue of issues) {
    const anchor = issue.anchor
    check(
      issue.chainId === 1 &&
        issue.routeKey === ROUTE &&
        issue.vault === VAULT &&
        issue.originalAsset === USDE &&
        issue.silo === SILO &&
        ADDRESS.test(issue.holder ?? '') &&
        decimal(issue.pendingAssetsRaw) &&
        BigInt(issue.pendingAssetsRaw) > 0n &&
        utcMs(issue.cooldownEndUtc) > 0 &&
        issue.estimand === 'existing_pending_whole_queue_unstake_simulation' &&
        issue.minedDeliveryProven === false &&
        issue.representativeCohort === false &&
        decimal(anchor?.blockNumber) &&
        BigInt(anchor.blockNumber) > 0n &&
        HASH.test(anchor.blockHash ?? '') &&
        Array.isArray(issue.targets) &&
        issue.targets.length === HORIZONS.length,
      'issue_identity_invalid',
    )
    const issueMs = utcMs(issue.issuedAtUtc)
    const baselineMs = utcMs(anchor.blockAtUtc)
    check(
      baselineMs <= issueMs + 120_000 &&
        issueMs - baselineMs <= HOUR_MS &&
        utcMs(anchor.observedAtUtc) <= issueMs &&
        issueMs - utcMs(anchor.observedAtUtc) <= 10 * 60_000,
      'issue_clock_invalid',
    )
    assertMeasurement(issue.measurement, issue.holder, anchor.blockNumber, anchor.blockHash)
    check(
      issue.measurement.pendingAssetsRaw === issue.pendingAssetsRaw &&
        issue.measurement.cooldownEndUtc === issue.cooldownEndUtc,
      'issue_queue_invalid',
    )
    for (const [index, target] of issue.targets.entries())
      check(
        target?.horizonHours === HORIZONS[index] &&
          utcMs(target.targetAtUtc) === issueMs + HORIZONS[index] * HOUR_MS &&
          utcMs(target.captureDeadlineUtc) === issueMs + (HORIZONS[index] + 2) * HOUR_MS,
        'target_invalid',
      )
    const queueCluster = selectedQueue(issue)
    queueByIssue.set(issue.sequence, queueCluster)
    if (issueMs <= nowMs) {
      visibleIssues.push(issue)
      visibleIssueSequences.add(issue.sequence)
      queueClusters.add(queueCluster)
    }
  }
  counts.issues = visibleIssues.length
  counts.uniqueQueues = queueClusters.size
  const scoresByCell = new Map()
  const seenScoreCells = new Set()
  for (const score of scores) {
    const issue = issues[score.issueSequence - 1]
    const target = issue?.targets.find((row) => row.horizonHours === score.horizonHours)
    const cell = `${score.issueSequence}:${score.horizonHours}`
    check(
      issue &&
        target &&
        !seenScoreCells.has(cell) &&
        score.issueSha256 === issue.sha256 &&
        score.routeKey === ROUTE &&
        score.vault === VAULT &&
        score.originalAsset === USDE &&
        score.silo === SILO &&
        score.holder === issue.holder &&
        score.pendingAssetsRaw === issue.pendingAssetsRaw &&
        score.cooldownEndUtc === issue.cooldownEndUtc &&
        score.targetAtUtc === target.targetAtUtc &&
        score.captureDeadlineUtc === target.captureDeadlineUtc &&
        score.minedDeliveryProven === false &&
        typeof score.onTime === 'boolean',
      'score_binding_invalid',
    )
    seenScoreCells.add(cell)
    const targetMs = utcMs(target.targetAtUtc)
    const deadlineMs = utcMs(target.captureDeadlineUtc)
    const scoredMs = utcMs(score.scoredAtUtc)
    check(scoredMs >= targetMs && score.onTime === scoredMs <= deadlineMs, 'score_clock_invalid')
    const visible = visibleIssueSequences.has(score.issueSequence) && scoredMs <= nowMs
    if (!score.onTime) {
      check(
        score.outcome === 'capture_window_missed' &&
          score.target === null &&
          score.measurement === null,
        'score_censor_invalid',
      )
      if (visible) counts.missedWindowTargets++
    } else {
      const targetBlock = score.target?.targetBlock
      const targetHash = score.target?.targetHash
      check(
        decimal(targetBlock) &&
          BigInt(targetBlock) > BigInt(issue.anchor.blockNumber) &&
          HASH.test(targetHash ?? '') &&
          utcMs(score.target.targetBlockAt) >= targetMs &&
          utcMs(score.target.targetBlockAt) <= deadlineMs &&
          utcMs(score.target.targetObservedAt) >= utcMs(score.target.targetBlockAt) &&
          utcMs(score.target.targetObservedAt) <= scoredMs,
        'score_target_invalid',
      )
      assertMeasurement(score.measurement, issue.holder, targetBlock, targetHash)
      check(score.outcome === expectedOutcome(issue, score.measurement), 'score_outcome_invalid')
      if (visible) counts.measuredTargets++
    }
    if (visible) {
      scoresByCell.set(cell, score)
      counts.scoredTargets++
    }
  }
  const episodes = []
  for (const issue of visibleIssues) {
    const baselineAtUtc = issue.anchor.blockAtUtc
    const featureJoin = selectAsOfFeatures(
      featuresBySubject.get(subjectKey) ?? [],
      subject,
      issue,
      {
        baseline: {
          targetBlock: issue.anchor.blockNumber,
          targetHash: issue.anchor.blockHash,
          targetBlockAt: baselineAtUtc,
        },
      },
    )
    check(featureJoin && typeof featureJoin === 'object', 'feature_join_invalid')
    const baseline = baselineOf(issue)
    for (const target of issue.targets) {
      const score = scoresByCell.get(`${issue.sequence}:${target.horizonHours}`)
      const outcome = outcomeOf(baseline, score, utcMs(target.captureDeadlineUtc), nowMs)
      if (outcome.status === 'pending') counts.pendingTargets++
      if (outcome.status === 'missing') counts.missingTargets++
      if (
        outcome.reason === 'queue_absent_cause_unknown' ||
        outcome.reason === 'queue_amount_changed_cause_unknown' ||
        outcome.reason === 'queue_reset_or_replaced'
      )
        counts.queueAttritionCensors++
      if (outcome.reason === 'unstake_revert_cause_unknown') counts.unknownReverts++
      episodes.push({
        subject: subjectKey,
        stageScope: 'susde_pending_unstake_eth_call',
        payoutAssessment: 'existing_pending_claim_only_mined_usde_unassessed',
        fullRoutePaidProofSha256: null,
        lane: ISSUE_STUDY,
        issueClusterSha256: queueByIssue.get(issue.sequence),
        analysisCellKey: issue.sha256,
        issueSha256: issue.sha256,
        scoreSha256: score?.sha256 ?? null,
        holderCommitment: sha(`${VAULT}:${issue.holder}`),
        qRaw: issue.pendingAssetsRaw,
        qUnit: 'USDe_pending_whole_queue_assets',
        qCaseLabel: 'existing_pending_whole_queue',
        cooldownEndUtc: issue.cooldownEndUtc,
        plannedHorizonHours: target.horizonHours,
        leadAtIssueMinutes: (utcMs(target.targetAtUtc) - utcMs(issue.issuedAtUtc)) / 60_000,
        targetClockBasis: 'issue_clock_plan',
        issueAtUtc: issue.issuedAtUtc,
        issueClock: 'local_operator_clock_unwitnessed',
        featureAvailabilityClock: 'local_operator_clock_unwitnessed',
        baselineBlock: issue.anchor.blockNumber,
        baselineBlockHash: issue.anchor.blockHash,
        baselineAtUtc,
        targetAtUtc: target.targetAtUtc,
        deadlineAtUtc: target.captureDeadlineUtc,
        observedAtUtc: score?.onTime ? score.target.targetBlockAt : null,
        labelAvailableAtUtc: score?.scoredAtUtc ?? null,
        ...featureJoin,
        baseline: baseline.baseline,
        baselineReason: baseline.reason,
        outcome,
        rawBaselineClaim: issue.measurement.claim,
        rawBaselinePendingAssetsRaw: issue.measurement.pendingAssetsRaw,
        rawScoreOutcome: score?.outcome ?? null,
        rawScoreClaim: score?.measurement?.claim ?? null,
        rawScorePendingAssetsRaw: score?.measurement?.pendingAssetsRaw ?? null,
        rawScoreCooldownEndUtc: score?.measurement?.cooldownEndUtc ?? null,
        minedDeliveryProven: false,
        analysisPrimaryForCell: false,
        forecastEligible: false,
      })
      check(episodes.length <= MAX_SCORES, 'row_limit')
    }
  }
  return { board, episodes, diagnostics }
}
