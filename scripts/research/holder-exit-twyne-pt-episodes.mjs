// Pure projection of caller-verified Twyne borrower PT first-leg records.
// The CV eth_call uses the current borrower as account and receiver. It proves
// neither borrower key control nor a mined PT or final USDe payment.
import { createHash } from 'node:crypto'

const ROUTE = 'USDe → AaveV3ATokenWrapper [PT-srUSDe-22OCT2026]'
const WRAPPER = '0x0af56afbddcb140323445bd7211ba90e54e5fd1c'
const PT = '0x59bc9fae5d62b19d4f8d07d758047acb9ee19d34'
const USDE = '0x4c9edd5852cd905f086c759e8383e09bff1e68b3'
const STUDY = 'carry_twyne_borrower_pt_first_leg_v1'
const SEED_SHA256 = 'c3e85a98ff3b634c8e6c4bdd4cc64e94f3bdcc417c071125cd40cdff09a21243'
const Q_RAW = '1000000000000000000'
const HORIZONS = [1, 4, 24, 168]
const HOUR_MS = 3_600_000
const MAX_ISSUES = 2_000
const MAX_SCORES = MAX_ISSUES * HORIZONS.length
const MAX_ATTEMPTS = 100_000
const ADDRESS = /^0x[0-9a-f]{40}$/
const HASH = /^0x[0-9a-f]{64}$/
const SHA = /^[0-9a-f]{64}$/
const DECIMAL = /^(0|[1-9][0-9]*)$/
const RESTRICTED_REASONS = new Set([
  'credit_reserved',
  'position_insufficient',
  'externally_liquidated',
  'evm_revert',
  'under_delivery',
])
const UNSUPPORTED_REASONS = new Set([
  'deployment_unattested',
  'source_unattested',
  'identity_changed',
  'factory_unregistered',
])
const COLLATERAL_VAULTS = new Set([
  '0x259b9f78382febfb76d02d6243ee4f12af7f0c37',
  '0x288b523115e674fa1ac1c2315ae2874065ee7699',
  '0x2cc58a703ad070f6668abaaa19411e0f4ad544b0',
  '0x3db976e1a0beed360a5726bcde9c6d9e17067e06',
  '0x3f937b0a560ebf4621d736fe32b1525940bbfdb0',
  '0x47e2daf6cdda5a164d335985f1cc2731e6c5d53e',
  '0x70162c6c8fe764c2be751a39ea69d4335c4bb8cd',
  '0x78a06d662ba80b94b2462a5cbe04dd234ac5a119',
  '0x8336afcd93fb330650999e45e432a6a4c949850c',
  '0x948eda8a21f16dc7cbbf63d96ffe038866192ad7',
  '0xa732374d0d959085c8eb581fa6abc4064b4c6ab1',
  '0xaea34a8690a5f38ba864ceb461f1f78b971db577',
  '0xbcd26a5819561efa80652b1a02863eb08fa156d8',
  '0xd91c40fe9007083e26768f012f6074090cf44c6a',
  '0xf3ccafb91013e3b6005b3ff0df8bc417bacf7d46',
  '0xf4c8687cbbb2a55657a4cf955df2dd91637ef217',
])

export const TWYNE_PT_SUBJECT = Object.freeze({
  route_key: ROUTE,
  destination: WRAPPER,
  asset: PT,
})

const sha = (value) => createHash('sha256').update(value).digest('hex')
const key = (route, destination, asset) =>
  `${route}\0${destination.toLowerCase()}\0${asset.toLowerCase()}`
const check = (ok, reason) => {
  if (!ok) throw Error(`holder_episode_panel_twyne_pt_${reason}`)
}
const utcMs = (value) => {
  const ms = Date.parse(value)
  check(Number.isSafeInteger(ms) && new Date(ms).toISOString() === value, 'clock_invalid')
  return ms
}
const decimal = (value) => typeof value === 'string' && DECIMAL.test(value)
const expectedIssueKey = (issue) =>
  sha(
    JSON.stringify([
      STUDY,
      SEED_SHA256,
      ROUTE,
      issue.collateralVault,
      issue.borrower,
      Q_RAW,
      issue.baseline.hash,
    ]),
  )

function assertChain(rows, kind, limit) {
  check(Array.isArray(rows) && rows.length <= limit, 'ledger_limit')
  let previous = null
  for (const [index, row] of rows.entries()) {
    const { sha256, ...body } = row ?? {}
    check(
      row?.study === STUDY &&
        row.kind === kind &&
        row.sequence === index + 1 &&
        row.previousSha256 === previous &&
        SHA.test(sha256 ?? '') &&
        sha(JSON.stringify(body)) === sha256,
      `${kind}_chain_invalid`,
    )
    previous = sha256
  }
}

function assertMeasurement(measurement, collateralVault, block) {
  const e = measurement?.evidence
  check(
    measurement?.routeKey === ROUTE &&
      measurement.collateralVault === collateralVault &&
      measurement.requestedPtRaw === Q_RAW &&
      (measurement.borrower === null || ADDRESS.test(measurement.borrower)) &&
      e?.chainId === 1 &&
      e.blockNumber === block.number &&
      e.blockHash === block.hash &&
      e.blockTimestamp === block.timestamp &&
      e.source === 'ethereum_finalized_eip1898_eth_call' &&
      e.firstLeg === 'twyne_cv_redeem_underlying_pt' &&
      e.receiver === 'borrower' &&
      e.borrowerKeyControl === 'unassessed' &&
      e.finalUsdePayout === 'unassessed' &&
      e.deploymentSourceEquivalence === 'unassessed' &&
      (measurement.status === 'observed'
        ? measurement.reason === null &&
          measurement.borrower !== null &&
          decimal(e.returnedPtRaw) &&
          BigInt(e.returnedPtRaw) >= BigInt(Q_RAW)
        : measurement.status === 'restricted'
          ? measurement.borrower !== null && RESTRICTED_REASONS.has(measurement.reason)
          : measurement.status === 'unsupported' && UNSUPPORTED_REASONS.has(measurement.reason)) &&
      (measurement.status === 'unsupported' ||
        (e.asset?.toLowerCase() === WRAPPER && e.targetAsset?.toLowerCase() === USDE)),
    'measurement_invalid',
  )
}

function baselineOf(measurement) {
  if (measurement.status === 'observed') return { baseline: 'simulated_callable', reason: null }
  if (measurement.reason === 'position_insufficient')
    return { baseline: 'unavailable', reason: 'collateral_vault_position_insufficient' }
  return {
    baseline: 'inconclusive',
    reason:
      measurement.reason === 'evm_revert'
        ? 'revert_cause_unknown'
        : `borrower_first_leg_${measurement.reason}`,
  }
}

function outcomeOf(baseline, score, deadlineMs, nowMs) {
  if (baseline.baseline !== 'simulated_callable')
    return { status: 'not_at_risk', reason: `baseline_${baseline.reason}` }
  if (!score)
    return nowMs <= deadlineMs
      ? { status: 'pending', reason: null }
      : { status: 'missing', reason: 'no_verified_score_after_deadline' }
  if (score.status === 'censored') return { status: 'censored', reason: 'capture_window_missed' }
  if (score.outcome === 'pt_first_leg_simulated')
    return { status: 'simulated_callable', reason: null }
  if (score.outcome === 'controller_changed')
    return { status: 'censored', reason: 'borrower_controller_changed' }
  if (score.outcome === 'unavailable')
    return { status: 'inconclusive', reason: 'assay_unavailable' }
  if (score.measurement.reason === 'position_insufficient')
    return { status: 'censored', reason: 'collateral_vault_position_attrition' }
  if (score.measurement.reason === 'externally_liquidated')
    return { status: 'censored', reason: 'collateral_vault_external_liquidation' }
  return {
    status: 'inconclusive',
    reason:
      score.measurement.reason === 'evm_revert'
        ? 'revert_cause_unknown'
        : `borrower_first_leg_${score.measurement.reason}`,
  }
}

export function twynePtBoardSubjects(manifest) {
  check(Array.isArray(manifest?.subjects), 'manifest_invalid')
  const matches = manifest.subjects.filter(
    (subject) =>
      subject.route_key === ROUTE &&
      subject.destination?.toLowerCase() === WRAPPER &&
      subject.asset?.toLowerCase() === PT,
  )
  check(matches.length === 1, 'frozen_subject_invalid')
  return new Map([[key(ROUTE, WRAPPER, PT), matches[0]]])
}

/** Accept only carry-twyne-borrower-pt.verifyLedgers(root)'s sealed result. */
export function buildTwynePtEpisodes({
  manifest,
  ledger,
  featuresBySubject = new Map(),
  selectAsOfFeatures,
  nowMs,
}) {
  const board = twynePtBoardSubjects(manifest)
  check(Number.isSafeInteger(nowMs) && nowMs >= 0, 'now_invalid')
  check(
    featuresBySubject instanceof Map && typeof selectAsOfFeatures === 'function',
    'features_invalid',
  )
  const { issues, scores, attempts } = ledger ?? {}
  assertChain(issues, 'issues', MAX_ISSUES)
  assertChain(scores, 'scores', MAX_SCORES)
  assertChain(attempts, 'attempts', MAX_ATTEMPTS)
  const subjectKey = key(ROUTE, WRAPPER, PT)
  const subject = board.get(subjectKey)
  const counts = {
    issues: 0,
    scoredTargets: 0,
    measuredTargets: 0,
    missedWindowTargets: 0,
    pendingTargets: 0,
    missingTargets: 0,
    controllerChangeCensors: 0,
    positionAttritionCensors: 0,
    restrictedTargets: 0,
    unavailableTargets: 0,
    attempts: 0,
    payoutAssessment: 'borrower_pt_first_leg_only_final_usde_unassessed',
  }
  const diagnostics = new Map([[subjectKey, counts]])
  for (const attempt of attempts) {
    const attemptMs = utcMs(attempt.atUtc)
    check(
      ['issue', 'score'].includes(attempt.phase) &&
        ['source_unavailable', 'identity_unavailable', 'target_not_finalized'].includes(
          attempt.reason,
        ) &&
        attemptMs > 0,
      'attempt_invalid',
    )
    if (attemptMs <= nowMs) counts.attempts++
  }
  const issueBySequence = new Map()
  const visibleIssues = new Set()
  for (const issue of issues) {
    const b = issue.baseline
    check(
      issue.seedSha256 === SEED_SHA256 &&
        issue.routeKey === ROUTE &&
        issue.asset === PT &&
        issue.qRaw === Q_RAW &&
        COLLATERAL_VAULTS.has(issue.collateralVault) &&
        ADDRESS.test(issue.borrower ?? '') &&
        issue.scope === 'borrower_pt_first_leg_simulation_only' &&
        Number.isSafeInteger(issue.slot) &&
        issue.slot === Math.floor(utcMs(issue.issuedAtUtc) / 1_800_000) &&
        Number.isSafeInteger(b?.number) &&
        b.number > 0 &&
        HASH.test(b.hash ?? '') &&
        Number.isSafeInteger(b.timestamp) &&
        b.timestamp > 0 &&
        issue.issueKey === expectedIssueKey(issue) &&
        Array.isArray(issue.targets) &&
        issue.targets.length === HORIZONS.length,
      'issue_identity_invalid',
    )
    const issueMs = utcMs(issue.issuedAtUtc)
    check(
      b.timestamp * 1_000 <= issueMs && issueMs - b.timestamp * 1_000 <= 2 * HOUR_MS,
      'baseline_clock_invalid',
    )
    assertMeasurement(issue.measurement, issue.collateralVault, b)
    check(
      issue.measurement.status !== 'unsupported' && issue.measurement.borrower === issue.borrower,
      'issue_borrower_invalid',
    )
    for (const [index, target] of issue.targets.entries())
      check(
        target?.horizonHours === HORIZONS[index] &&
          utcMs(target.targetAtUtc) === issueMs + HORIZONS[index] * HOUR_MS &&
          utcMs(target.deadlineAtUtc) === issueMs + (HORIZONS[index] + 2) * HOUR_MS,
        'target_invalid',
      )
    issueBySequence.set(issue.sequence, issue)
    if (issueMs <= nowMs) {
      visibleIssues.add(issue.sequence)
      counts.issues++
    }
  }
  const scoresByCell = new Map()
  const visibleScoresByCell = new Map()
  for (const score of scores) {
    const issue = issueBySequence.get(score.issueSequence)
    const plan = issue?.targets.find((target) => target.horizonHours === score.horizonHours)
    const cell = `${score.issueSequence}:${score.horizonHours}`
    check(
      issue &&
        plan &&
        !scoresByCell.has(cell) &&
        score.issueSha256 === issue.sha256 &&
        score.issueKey === issue.issueKey &&
        score.seedSha256 === SEED_SHA256 &&
        score.routeKey === ROUTE &&
        score.collateralVault === issue.collateralVault &&
        score.borrower === issue.borrower &&
        score.qRaw === Q_RAW &&
        score.scope === issue.scope &&
        score.targetAtUtc === plan.targetAtUtc &&
        score.deadlineAtUtc === plan.deadlineAtUtc &&
        ['measured', 'censored'].includes(score.status) &&
        Number.isSafeInteger(score.block?.number) &&
        score.block.number > issue.baseline.number &&
        HASH.test(score.block.hash ?? '') &&
        Number.isSafeInteger(score.block.timestamp),
      'score_binding_invalid',
    )
    const targetMs = utcMs(plan.targetAtUtc)
    const deadlineMs = utcMs(plan.deadlineAtUtc)
    const scoredMs = utcMs(score.scoredAtUtc)
    check(score.block.timestamp * 1_000 <= scoredMs, 'score_block_clock_invalid')
    if (score.status === 'censored') {
      check(
        score.reason === 'missed_physical_window' &&
          score.measurement === null &&
          !Object.hasOwn(score, 'outcome') &&
          score.block.timestamp * 1_000 > deadlineMs &&
          scoredMs > deadlineMs,
        'score_censor_invalid',
      )
    } else {
      check(
        scoredMs >= targetMs &&
          scoredMs <= deadlineMs &&
          score.block.timestamp * 1_000 >= targetMs &&
          score.block.timestamp * 1_000 <= deadlineMs,
        'score_clock_invalid',
      )
      assertMeasurement(score.measurement, issue.collateralVault, score.block)
      const expected =
        score.measurement.borrower === null || score.measurement.status === 'unsupported'
          ? 'unavailable'
          : score.measurement.borrower !== issue.borrower
            ? 'controller_changed'
            : score.measurement.status === 'observed'
              ? 'pt_first_leg_simulated'
              : 'restricted'
      check(score.outcome === expected, 'score_outcome_invalid')
    }
    scoresByCell.set(cell, score)
    if (scoredMs <= nowMs && visibleIssues.has(score.issueSequence)) {
      visibleScoresByCell.set(cell, score)
      counts.scoredTargets++
      if (score.status === 'censored') counts.missedWindowTargets++
      else {
        counts.measuredTargets++
        if (score.outcome === 'restricted') counts.restrictedTargets++
        if (score.outcome === 'unavailable') counts.unavailableTargets++
      }
    }
  }
  const episodes = []
  for (const issue of issues) {
    if (!visibleIssues.has(issue.sequence)) continue
    const baselineAtUtc = new Date(issue.baseline.timestamp * 1_000).toISOString()
    const featureJoin = selectAsOfFeatures(
      featuresBySubject.get(subjectKey) ?? [],
      subject,
      issue,
      {
        baseline: {
          targetBlock: String(issue.baseline.number),
          targetHash: issue.baseline.hash,
          targetBlockAt: baselineAtUtc,
        },
      },
    )
    check(featureJoin && typeof featureJoin === 'object', 'feature_join_invalid')
    const baseline = baselineOf(issue.measurement)
    for (const plan of issue.targets) {
      const score = visibleScoresByCell.get(`${issue.sequence}:${plan.horizonHours}`)
      const deadlineMs = utcMs(plan.deadlineAtUtc)
      const outcome = outcomeOf(baseline, score, deadlineMs, nowMs)
      if (outcome.status === 'pending') counts.pendingTargets++
      if (outcome.status === 'missing') counts.missingTargets++
      if (outcome.reason === 'borrower_controller_changed') counts.controllerChangeCensors++
      if (
        ['collateral_vault_position_attrition', 'collateral_vault_external_liquidation'].includes(
          outcome.reason,
        )
      )
        counts.positionAttritionCensors++
      episodes.push({
        subject: subjectKey,
        stageScope: 'twyne_pt_borrower_first_leg_eth_call',
        payoutAssessment: counts.payoutAssessment,
        fullRoutePaidProofSha256: null,
        lane: STUDY,
        issueClusterSha256: issue.sha256,
        issueSha256: issue.sha256,
        scoreSha256: score?.sha256 ?? null,
        holderCommitment: sha(`${issue.collateralVault}:${issue.borrower}`),
        collateralVault: issue.collateralVault,
        borrowerCommitment: sha(issue.borrower),
        qRaw: Q_RAW,
        qUnit: 'PT_srusde_first_leg_assets',
        qCaseLabel: 'fixed_1_pt',
        originalAsset: USDE,
        firstLegAsset: PT,
        firstLegOnly: true,
        borrowerKeyControl: 'unassessed',
        finalPayoutStatus: 'unassessed',
        plannedHorizonHours: plan.horizonHours,
        leadAtIssueMinutes: (utcMs(plan.targetAtUtc) - utcMs(issue.issuedAtUtc)) / 60_000,
        targetClockBasis: 'issue_clock_plan',
        issueAtUtc: issue.issuedAtUtc,
        issueClock: 'local_operator_clock_unwitnessed',
        featureAvailabilityClock: 'local_operator_clock_unwitnessed',
        baselineBlock: String(issue.baseline.number),
        baselineBlockHash: issue.baseline.hash,
        baselineAtUtc,
        targetAtUtc: plan.targetAtUtc,
        deadlineAtUtc: plan.deadlineAtUtc,
        observedAtUtc:
          score?.status === 'measured'
            ? new Date(score.block.timestamp * 1_000).toISOString()
            : null,
        labelAvailableAtUtc: score?.scoredAtUtc ?? null,
        ...featureJoin,
        baseline: baseline.baseline,
        baselineReason: baseline.reason,
        outcome,
        rawBaselineStatus: issue.measurement.status,
        rawBaselineReason: issue.measurement.reason,
        rawBaselineReturnedPtRaw: issue.measurement.evidence.returnedPtRaw ?? null,
        rawScoreStatus: score?.status ?? null,
        rawScoreOutcome: score?.status === 'measured' ? score.outcome : null,
        rawScoreMeasurementStatus: score?.measurement?.status ?? null,
        rawScoreReason: score?.measurement?.reason ?? score?.reason ?? null,
        rawScoreBorrowerCommitment: score?.measurement?.borrower
          ? sha(score.measurement.borrower)
          : null,
        rawScoreReturnedPtRaw: score?.measurement?.evidence?.returnedPtRaw ?? null,
        analysisPrimaryForCell: false,
        forecastEligible: false,
      })
      check(episodes.length <= MAX_SCORES, 'row_limit')
    }
  }
  return { board, episodes, diagnostics }
}
