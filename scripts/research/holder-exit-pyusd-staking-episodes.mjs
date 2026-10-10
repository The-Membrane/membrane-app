// Pure projection of caller-verified Hastra PRIME → wYLDS prospective evidence.
// The source's redeem eth_call does not attest a mined wYLDS, USDC, or PYUSD payout.
import { createHash } from 'node:crypto'

const ROUTE = 'PYUSD → StakingVault [wYLDS]'
const PRIME = '0x19ebb35279a16207ec4ba82799cc64715065f7f6'
const WYLDS = '0x6ad038ca6c04e885630851278ca0a856ad9a66cc'
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const STUDY = 'pyusd_staking_prime_prospective_v1'
const HORIZONS = [1, 4, 24, 48, 168]
const ASSESSMENT = 'first_stage_only_usdc_pyusd_unassessed'
const STAGES = new Set([
  'insufficient_prime_shares',
  'staking_paused',
  'holder_frozen',
  'below_max_redeem',
  'redeem_reverted',
  'zero_wylds_out',
  'prime_to_wylds_callable',
])
const MAX_ISSUES = 2_000
const MAX_SCORES = MAX_ISSUES * HORIZONS.length
const MAX_ATTEMPTS = 100_000
const SHA = /^[0-9a-f]{64}$/
const HASH = /^0x[0-9a-f]{64}$/i
const ADDRESS = /^0x[0-9a-f]{40}$/i
const DECIMAL = /^(0|[1-9][0-9]*)$/

export const PYUSD_STAKING_SUBJECT = Object.freeze({
  route_key: ROUTE,
  destination: PRIME,
  asset: WYLDS,
})

const hash = (value) => createHash('sha256').update(value).digest('hex')
const key = (route, destination, asset) =>
  `${route}\0${destination.toLowerCase()}\0${asset.toLowerCase()}`
const check = (condition, reason) => {
  if (!condition) throw Error(`holder_episode_panel_pyusd_staking_${reason}`)
}
const utcMs = (value) => {
  const ms = Date.parse(value)
  check(Number.isSafeInteger(ms) && new Date(ms).toISOString() === value, 'clock_invalid')
  return ms
}
const decimal = (value) => typeof value === 'string' && DECIMAL.test(value)
const sealed = (row) => {
  if (!row || !SHA.test(row.sha256 ?? '')) return false
  const { sha256, ...body } = row
  return hash(JSON.stringify(body)) === sha256
}

function assertChain(rows, kind, limit) {
  check(Array.isArray(rows) && rows.length <= limit, 'ledger_limit')
  let previous = null
  for (const [index, row] of rows.entries()) {
    check(
      row?.study === STUDY &&
        row.kind === kind &&
        row.sequence === index + 1 &&
        row.previousSha256 === previous &&
        sealed(row),
      `${kind}_chain_invalid`,
    )
    previous = row.sha256
  }
}

function assertAssay(assay, holder, qRaw) {
  check(
    assay?.holder?.toLowerCase() === holder.toLowerCase() &&
      assay.qRaw === qRaw &&
      decimal(assay.primeSharesRaw) &&
      decimal(assay.maxRedeemRaw) &&
      (assay.previewWyldsRaw === null || decimal(assay.previewWyldsRaw)) &&
      (assay.simulatedWyldsRaw === null || decimal(assay.simulatedWyldsRaw)) &&
      typeof assay.stakingPaused === 'boolean' &&
      typeof assay.stakingFrozen === 'boolean' &&
      STAGES.has(assay.stage) &&
      assay.pyusdPayout === 'not_attested' &&
      assay.yieldStage?.requestAssessed === false &&
      assay.yieldStage.completion === 'admin_gated_unassessed' &&
      assay.yieldStage.usdcPayout === 'not_attested',
    'assay_invalid',
  )
  const q = BigInt(qRaw)
  const shares = BigInt(assay.primeSharesRaw)
  const max = BigInt(assay.maxRedeemRaw)
  const simulated = assay.simulatedWyldsRaw === null ? null : BigInt(assay.simulatedWyldsRaw)
  const expected =
    shares < q
      ? 'insufficient_prime_shares'
      : assay.stakingPaused
        ? 'staking_paused'
        : assay.stakingFrozen
          ? 'holder_frozen'
          : max < q
            ? 'below_max_redeem'
            : simulated === null
              ? 'redeem_reverted'
              : simulated === 0n
                ? 'zero_wylds_out'
                : 'prime_to_wylds_callable'
  check(assay.stage === expected, 'stage_inconsistent')
}

function assertSnapshot(snapshot, issue, target = null) {
  check(
    snapshot?.routeKey === ROUTE &&
      snapshot.destination?.toLowerCase() === PRIME &&
      snapshot.chainId === 1 &&
      decimal(snapshot.blockNumber) &&
      HASH.test(snapshot.blockHash ?? '') &&
      Number.isSafeInteger(snapshot.blockTimestamp) &&
      snapshot.blockTimestamp > 0 &&
      snapshot.finalPayout === 'unassessed' &&
      snapshot.pyusdConversion === 'not_attested' &&
      snapshot.identity?.primeAsset?.toLowerCase() === WYLDS &&
      snapshot.identity?.yieldAsset?.toLowerCase() === USDC &&
      snapshot.identity?.primeDecimals === 6 &&
      snapshot.identity?.yieldDecimals === 6 &&
      snapshot.identity?.usdcDecimals === 6 &&
      snapshot.identity?.pyusdDecimals === 6 &&
      (!target ||
        (snapshot.blockNumber === target.number &&
          snapshot.blockHash === target.hash &&
          snapshot.blockTimestamp === target.timestamp)),
    'snapshot_invalid',
  )
  assertAssay(snapshot.assay, issue.holder, issue.qRaw)
}

function outcomeOf(issue, score, deadlineMs, nowMs) {
  if (issue.baseline.assay.stage !== 'prime_to_wylds_callable')
    return {
      status: 'not_at_risk',
      reason:
        issue.baseline.assay.stage === 'redeem_reverted'
          ? 'baseline_revert_cause_unknown'
          : 'baseline_first_stage_noncallable',
    }
  if (!score)
    return nowMs <= deadlineMs
      ? { status: 'pending', reason: null }
      : { status: 'missing', reason: 'no_verified_score_after_deadline' }
  if (score.status === 'missed_window')
    return { status: 'censored', reason: 'capture_window_missed' }
  const assay = score.measurement.assay
  if (BigInt(assay.primeSharesRaw) < BigInt(issue.qRaw))
    return { status: 'censored', reason: 'holder_attrition' }
  if (assay.stage === 'prime_to_wylds_callable')
    return { status: 'simulated_callable', reason: null }
  return {
    status: 'inconclusive',
    reason:
      assay.stage === 'redeem_reverted'
        ? 'revert_cause_unknown'
        : 'first_stage_noncallable_cause_unassessed',
  }
}

export function pyUsdStakingBoardSubjects(manifest) {
  check(Array.isArray(manifest?.subjects), 'manifest_invalid')
  const matches = manifest.subjects.filter(
    (subject) =>
      subject.route_key === ROUTE &&
      subject.destination?.toLowerCase() === PRIME &&
      subject.asset?.toLowerCase() === WYLDS,
  )
  check(matches.length === 1, 'frozen_subject_invalid')
  return new Map([[key(ROUTE, PRIME, WYLDS), matches[0]]])
}

/** Call with pyusd-staking-prospective.verifyEvidence(root)'s sealed result. */
export function buildPyUsdStakingEpisodes({
  manifest,
  ledger,
  featuresBySubject = new Map(),
  selectAsOfFeatures,
  nowMs,
}) {
  const board = pyUsdStakingBoardSubjects(manifest)
  check(Number.isSafeInteger(nowMs) && nowMs >= 0, 'now_invalid')
  check(
    featuresBySubject instanceof Map && typeof selectAsOfFeatures === 'function',
    'features_invalid',
  )
  const { issues, scores, attempts } = ledger ?? {}
  assertChain(issues, 'issues', MAX_ISSUES)
  assertChain(scores, 'scores', MAX_SCORES)
  assertChain(attempts, 'attempts', MAX_ATTEMPTS)
  const subjectKey = key(ROUTE, PRIME, WYLDS)
  const subject = board.get(subjectKey)
  const counts = {
    issues: 0,
    scoredTargets: 0,
    measuredTargets: 0,
    missedWindowTargets: 0,
    pendingTargets: 0,
    missingTargets: 0,
    holderAttritionCensors: 0,
    inconclusiveReverts: 0,
    attempts: 0,
    payoutAssessment: ASSESSMENT,
  }
  const diagnostics = new Map([[subjectKey, counts]])
  for (const attempt of attempts) {
    const attemptMs = utcMs(attempt.atUtc)
    check(
      ['issue', 'score'].includes(attempt.action) &&
        ['sealed', 'retry', 'no_due', 'no_fresh_holder'].includes(attempt.status) &&
        (attempt.reason === null || /^pyusd_[a-z0-9_]+$/.test(attempt.reason ?? '')),
      'attempt_invalid',
    )
    if (attemptMs <= nowMs) counts.attempts++
  }
  const issueBySequence = new Map()
  const visibleIssueSequences = new Set()
  const holders = new Set()
  for (const issue of issues) {
    check(
      issue.routeKey === ROUTE &&
        issue.destination?.toLowerCase() === PRIME &&
        ADDRESS.test(issue.holder ?? '') &&
        decimal(issue.qRaw) &&
        BigInt(issue.qRaw) > 0n &&
        issue.payoutAssessment === ASSESSMENT &&
        Array.isArray(issue.targets) &&
        issue.targets.length === HORIZONS.length &&
        !holders.has(issue.holder.toLowerCase()),
      'issue_identity_invalid',
    )
    holders.add(issue.holder.toLowerCase())
    issueBySequence.set(issue.sequence, issue)
    assertSnapshot(issue.baseline, issue)
    const issueMs = utcMs(issue.issuedAtUtc)
    check(
      issue.baseline.blockTimestamp * 1_000 <= issueMs + 120_000 &&
        issueMs - issue.baseline.blockTimestamp * 1_000 <= 7_200_000,
      'baseline_clock_invalid',
    )
    for (const [index, target] of issue.targets.entries()) {
      const horizon = HORIZONS[index]
      check(
        target?.horizonHours === horizon &&
          utcMs(target.targetAtUtc) === issueMs + horizon * 3_600_000 &&
          utcMs(target.deadlineAtUtc) === issueMs + (horizon + 2) * 3_600_000,
        'target_invalid',
      )
    }
    if (issueMs <= nowMs) {
      visibleIssueSequences.add(issue.sequence)
      counts.issues++
    }
  }
  const scoresByCell = new Map()
  for (const score of scores) {
    const issue = issueBySequence.get(score.issueSequence)
    const plan = issue?.targets.find((target) => target.horizonHours === score.horizonHours)
    const cell = `${score.issueSequence}:${score.horizonHours}`
    check(
      issue &&
        plan &&
        !scoresByCell.has(cell) &&
        score.issueSha256 === issue.sha256 &&
        score.targetAtUtc === plan.targetAtUtc &&
        score.deadlineAtUtc === plan.deadlineAtUtc &&
        score.payoutAssessment === ASSESSMENT &&
        ['measured', 'missed_window'].includes(score.status),
      'score_binding_invalid',
    )
    const scoredMs = utcMs(score.scoredAtUtc)
    const targetMs = utcMs(plan.targetAtUtc)
    const deadlineMs = utcMs(plan.deadlineAtUtc)
    const scoreVisible = visibleIssueSequences.has(issue.sequence) && scoredMs <= nowMs
    if (score.status === 'measured') {
      check(
        scoredMs >= targetMs &&
          scoredMs <= deadlineMs &&
          decimal(score.target?.number) &&
          HASH.test(score.target?.hash ?? '') &&
          Number.isSafeInteger(score.target?.timestamp) &&
          score.target.timestamp * 1_000 >= targetMs &&
          score.target.timestamp * 1_000 <= deadlineMs &&
          score.target.timestamp * 1_000 <= scoredMs &&
          score.deadlineWitness === null,
        'measured_target_invalid',
      )
      assertSnapshot(score.measurement, issue, score.target)
      if (scoreVisible) counts.measuredTargets++
    } else {
      check(
        scoredMs > deadlineMs &&
          score.target === null &&
          score.measurement === null &&
          Array.isArray(score.deadlineWitness?.heads) &&
          score.deadlineWitness.heads.length === 2 &&
          score.deadlineWitness.heads.every(
            (head) =>
              Number.isSafeInteger(head?.timestamp) &&
              head.timestamp * 1_000 >= deadlineMs &&
              head.timestamp * 1_000 <= scoredMs,
          ) &&
          Array.isArray(score.deadlineWitness.commonHeaders) &&
          score.deadlineWitness.commonHeaders.length === 2 &&
          score.deadlineWitness.commonHeaders.every(
            (header) =>
              Number.isSafeInteger(header?.timestamp) &&
              header.timestamp * 1_000 >= deadlineMs &&
              header.timestamp * 1_000 <= scoredMs,
          ),
        'missed_window_invalid',
      )
      if (scoreVisible) counts.missedWindowTargets++
    }
    if (scoreVisible) counts.scoredTargets++
    scoresByCell.set(cell, score)
  }
  const episodes = []
  for (const issue of issues) {
    if (!visibleIssueSequences.has(issue.sequence)) continue
    const baselineAtUtc = new Date(issue.baseline.blockTimestamp * 1_000).toISOString()
    const featureJoin = selectAsOfFeatures(
      featuresBySubject.get(subjectKey) ?? [],
      subject,
      issue,
      {
        baseline: {
          targetBlock: issue.baseline.blockNumber,
          targetHash: issue.baseline.blockHash,
          targetBlockAt: baselineAtUtc,
        },
      },
    )
    check(featureJoin && typeof featureJoin === 'object', 'feature_join_invalid')
    const baselineCallable = issue.baseline.assay.stage === 'prime_to_wylds_callable'
    for (const plan of issue.targets) {
      const score = scoresByCell.get(`${issue.sequence}:${plan.horizonHours}`)
      const visibleScore = score && utcMs(score.scoredAtUtc) <= nowMs ? score : null
      const deadlineMs = utcMs(plan.deadlineAtUtc)
      const outcome = outcomeOf(issue, visibleScore, deadlineMs, nowMs)
      if (outcome.status === 'pending') counts.pendingTargets++
      if (outcome.status === 'missing') counts.missingTargets++
      if (outcome.reason === 'holder_attrition') counts.holderAttritionCensors++
      if (outcome.reason === 'revert_cause_unknown') counts.inconclusiveReverts++
      episodes.push({
        subject: subjectKey,
        stageScope: 'pyusd_staking_first_stage_eth_call',
        payoutAssessment: ASSESSMENT,
        fullRoutePaidProofSha256: null,
        lane: 'pyusd_staking_prime_prospective_v1',
        issueClusterSha256: issue.sha256,
        issueSha256: issue.sha256,
        scoreSha256: visibleScore?.sha256 ?? null,
        holderCommitment: hash(`${PRIME}:${issue.holder.toLowerCase()}`),
        qRaw: issue.qRaw,
        qUnit: 'PRIME_shares',
        qCaseLabel: 'issue_frozen_prime_shares',
        plannedHorizonHours: plan.horizonHours,
        leadAtIssueMinutes: (utcMs(plan.targetAtUtc) - utcMs(issue.issuedAtUtc)) / 60_000,
        targetClockBasis: 'issue_clock_plan',
        issueAtUtc: issue.issuedAtUtc,
        issueClock: 'local_operator_clock_unwitnessed',
        featureAvailabilityClock: 'local_operator_clock_unwitnessed',
        baselineBlock: issue.baseline.blockNumber,
        baselineBlockHash: issue.baseline.blockHash,
        baselineAtUtc,
        targetAtUtc: plan.targetAtUtc,
        deadlineAtUtc: plan.deadlineAtUtc,
        observedAtUtc:
          visibleScore?.status === 'measured'
            ? new Date(visibleScore.target.timestamp * 1_000).toISOString()
            : null,
        labelAvailableAtUtc: visibleScore?.scoredAtUtc ?? null,
        ...featureJoin,
        baseline: baselineCallable ? 'simulated_callable' : 'inconclusive',
        baselineReason: baselineCallable
          ? null
          : issue.baseline.assay.stage === 'redeem_reverted'
            ? 'revert_cause_unknown'
            : 'first_stage_noncallable_cause_unassessed',
        outcome,
        rawBaselineStage: issue.baseline.assay.stage,
        rawBaselineOutcome: issue.baseline.assay.stage,
        rawBaselinePrimeSharesRaw: issue.baseline.assay.primeSharesRaw,
        rawBaselineMaxRedeemRaw: issue.baseline.assay.maxRedeemRaw,
        rawBaselinePreviewWyldsRaw: issue.baseline.assay.previewWyldsRaw,
        rawBaselineSimulatedWyldsRaw: issue.baseline.assay.simulatedWyldsRaw,
        rawScoreStatus: visibleScore?.status ?? null,
        rawScoreStage: visibleScore?.measurement?.assay?.stage ?? null,
        rawScoreOutcome: visibleScore?.measurement?.assay?.stage ?? null,
        rawScorePrimeSharesRaw: visibleScore?.measurement?.assay?.primeSharesRaw ?? null,
        rawScoreMaxRedeemRaw: visibleScore?.measurement?.assay?.maxRedeemRaw ?? null,
        rawScorePreviewWyldsRaw: visibleScore?.measurement?.assay?.previewWyldsRaw ?? null,
        rawScoreSimulatedWyldsRaw: visibleScore?.measurement?.assay?.simulatedWyldsRaw ?? null,
        finalPayout: 'unassessed',
        usdcPayout: 'not_attested',
        pyusdConversion: 'not_attested',
        pyusdPayout: 'not_attested',
        analysisPrimaryForCell: false,
        forecastEligible: false,
      })
      check(episodes.length <= MAX_SCORES, 'row_limit')
    }
  }
  return { board, episodes, diagnostics }
}
