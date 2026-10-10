// Descriptive v2 scheduled-arm evaluation. No probability, duration, or alert.
import { MAX_HORIZON_SECONDS, outcomeProtocol } from './scrvusd-exit-forecast-issue.mjs'
import {
  readBoundLabelsWithPgV2,
  readWitnessedBoundLabelsWithPgV2,
  SCHEMA_V2 as LABEL_SCHEMA_V2,
  WITNESSED_SCHEMA_V2 as WITNESSED_LABEL_SCHEMA_V2,
} from './scrvusd-bound-prospective-exit-labels.mjs'

export const SCHEMA_V2 = 'scrvusd-bound-exit-evaluation-v2'
export const WITNESSED_EVALUATION_SCHEMA_V2 = 'scrvusd-bound-exit-evaluation-witnessed-v1'
export const WITNESSED_TARGET_TOLERANCE_SECONDS = 300
const validUtc = (value) =>
  typeof value === 'string' &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value
const statuses = new Set(['pending', 'matured_unscored', 'missing', 'ambiguous', 'observed'])

function requestedHorizons(horizons, rows) {
  const selected = horizons.length ? horizons : rows.map((row) => row.arm.horizonSeconds)
  if (
    !Array.isArray(selected) ||
    selected.some(
      (value) => !Number.isSafeInteger(value) || value < 1 || value > MAX_HORIZON_SECONDS,
    )
  )
    throw new Error('Invalid v2 evaluation horizons')
  return [...new Set(selected)].sort((a, b) => a - b)
}

function checkedInterval(loss, issuedAtUtc, asOfUtc) {
  if (!loss) return null
  if (
    !validUtc(loss.intervalStartUtc) ||
    !validUtc(loss.intervalEndUtc) ||
    Date.parse(loss.intervalStartUtc) >= Date.parse(loss.intervalEndUtc) ||
    Date.parse(loss.intervalEndUtc) > Date.parse(asOfUtc)
  )
    throw new Error('Invalid v2 first-loss interval chronology')
  const start = (Date.parse(loss.intervalStartUtc) - Date.parse(issuedAtUtc)) / 1000
  const end = (Date.parse(loss.intervalEndUtc) - Date.parse(issuedAtUtc)) / 1000
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    Math.abs(start - loss.secondsFromIssueAtStart) > 1 ||
    Math.abs(end - loss.secondsFromIssueAtEnd) > 1
  )
    throw new Error('V2 first-loss offsets differ from issue time')
  return {
    intervalStartUtc: loss.intervalStartUtc,
    intervalEndUtc: loss.intervalEndUtc,
    startKind: loss.intervalStartKind,
    signedSecondsFromIssueAtStart: start,
    signedSecondsFromIssueAtEnd: end,
    positiveSampledLowerBoundSeconds:
      loss.intervalStartKind === 'post_issue_clean_success_sample' && start > 0 ? start : null,
  }
}

function classify(row, asOfUtc) {
  const horizonSeconds = row.arm?.horizonSeconds
  const protocol = outcomeProtocol(row.issuedAtUtc, horizonSeconds)
  const score = row.score
  if (
    !row.issue?.filename ||
    !row.arm?.manifestSha256 ||
    !row.arm?.slotId ||
    !row.anchorBlock?.hash ||
    !row.holder ||
    !row.qAssetsRaw ||
    !row.route ||
    !validUtc(row.issuedAtUtc) ||
    !validUtc(row.targetUtc) ||
    !validUtc(row.captureDeadlineUtc) ||
    row.targetUtc !== protocol.targetUtc ||
    row.captureDeadlineUtc !== protocol.checkpointSelection.captureDeadlineUtc ||
    Date.parse(row.issuedAtUtc) > Date.parse(asOfUtc) ||
    !statuses.has(score?.status)
  )
    throw new Error('Invalid verified v2 scheduled-arm label')
  const scored = ['observed', 'missing', 'ambiguous'].includes(score.status)
  const deadline = Date.parse(row.captureDeadlineUtc)
  if (
    scored !== Boolean(score.ref) ||
    scored !== Boolean(score.scoredAtUtc) ||
    (score.status === 'pending' && Date.parse(asOfUtc) >= deadline) ||
    (score.status === 'matured_unscored' && Date.parse(asOfUtc) < deadline) ||
    (scored &&
      (!validUtc(score.scoredAtUtc) ||
        Date.parse(score.scoredAtUtc) > Date.parse(asOfUtc) ||
        Date.parse(score.scoredAtUtc) < deadline))
  )
    throw new Error('V2 score visibility differs from label status')
  const point = score.pointOutcome
  const trajectory = score.trajectory
  if (
    (score.status === 'observed' && !['success', 'revert'].includes(point?.status)) ||
    (score.status === 'missing' &&
      !['missing', 'missing_quote_checkpoint'].includes(point?.status)) ||
    (score.status === 'ambiguous' &&
      (!point?.status ||
        ['success', 'revert', 'missing', 'missing_quote_checkpoint'].includes(point.status))) ||
    (!scored && (point || trajectory))
  )
    throw new Error('V2 point outcome differs from label status')
  const firstLossInterval = scored
    ? checkedInterval(trajectory?.firstLoss, row.issuedAtUtc, asOfUtc)
    : null
  let evidenceClass
  if (score.status === 'pending')
    evidenceClass =
      Date.parse(asOfUtc) < Date.parse(row.targetUtc) ? 'not_yet_due' : 'capture_window_open'
  else if (score.status === 'matured_unscored') evidenceClass = 'matured_unscored'
  else if (firstLossInterval) evidenceClass = 'first_loss_interval'
  else if (score.status === 'missing') evidenceClass = 'scored_missing'
  else if (score.status === 'ambiguous') evidenceClass = 'scored_ambiguous'
  else if (trajectory?.status === 'right_censored_at_last_sampled_success')
    evidenceClass = 'right_censored_at_sampled_success'
  else if (trajectory?.status === 'right_censored_ambiguous')
    evidenceClass = 'right_censored_ambiguous'
  else if (point?.status === 'revert') evidenceClass = 'point_revert_unattributed'
  else if (point?.status === 'success') evidenceClass = 'point_success_only'
  else evidenceClass = 'unclassified_scored_observation'
  return {
    arm: row.arm,
    issue: row.issue,
    issuedAtUtc: row.issuedAtUtc,
    targetUtc: row.targetUtc,
    captureDeadlineUtc: row.captureDeadlineUtc,
    anchorBlock: row.anchorBlock,
    holder: row.holder,
    qAssetsRaw: row.qAssetsRaw,
    route: row.route,
    baselineStatus: row.baseline?.status ?? null,
    historicalFlowStatus: row.historicalFlowStatus ?? null,
    scoreStatus: score.status,
    score: score.ref,
    scoredAtUtc: score.scoredAtUtc,
    pointStatus: point?.status ?? null,
    trajectoryStatus: trajectory?.status ?? null,
    censorReason: trajectory?.censor?.reason ?? null,
    firstLossInterval,
    latestCleanSampledSuccessBlock: trajectory?.latestCleanSampledSuccessBlock ?? null,
    laterSampledRecovery: trajectory?.recovery ?? null,
    postLossCensor: trajectory?.postLossCensor ?? null,
    postRecoveryCensor: trajectory?.postRecoveryCensor ?? null,
    sampledCodeIdentity: score.sampledCodeIdentity ?? null,
    evidenceClass,
    continuousAvailability: 'unverified',
  }
}

function dependence(rows) {
  const parent = rows.map((_, index) => index)
  const find = (index) => (parent[index] === index ? index : (parent[index] = find(parent[index])))
  const union = (a, b) => {
    parent[find(b)] = find(a)
  }
  for (let i = 0; i < rows.length; i++) {
    for (let j = 0; j < i; j++) {
      const a = rows[i]
      const b = rows[j]
      if (a.route !== b.route) continue
      const sameAnchor =
        a.anchorBlock.number === b.anchorBlock.number && a.anchorBlock.hash === b.anchorBlock.hash
      const overlap =
        Date.parse(a.issuedAtUtc) <= Date.parse(b.captureDeadlineUtc) &&
        Date.parse(b.issuedAtUtc) <= Date.parse(a.captureDeadlineUtc)
      if (sameAnchor || overlap) union(i, j)
    }
  }
  const groups = new Map()
  rows.forEach((row, index) => {
    const root = find(index)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root).push(row.issue)
  })
  return [...groups.values()].map((issues, index) => ({
    id: `v2-dependent-window-${index + 1}`,
    issueCount: issues.length,
    issues,
    reason: 'same_anchor_or_overlapping_single_vault_capture_window',
  }))
}

// Reuse the evaluator's dependency rule for alternate descriptive H risk sets.
export function witnessedDependenceComponents(rows) {
  return dependence(rows)
}

// Pure reduction accepts only the v2 label shape. Public callers should use
// readBoundEvaluationWithPgV2, which verifies retained issue/score/DB evidence.
export function evaluateBoundLabelsV2({ labels, horizons = [] }) {
  if (
    labels?.schema !== LABEL_SCHEMA_V2 ||
    labels.cohort !== 'scheduled_bound_v2_only' ||
    labels.chronologicalBacktestEligible !== false ||
    labels.historicalAvailabilityCertified !== false ||
    labels.asOfSemantics !== 'retrospective_reconstruction_from_current_verified_ledger' ||
    !validUtc(labels.asOfUtc) ||
    !Array.isArray(labels.rows)
  )
    throw new Error('V2 evaluation requires verified retrospective bound labels')
  const selected = requestedHorizons(horizons, labels.rows)
  const allRows = labels.rows.map((row) => classify(row, labels.asOfUtc))
  const rows = allRows.filter((row) => selected.includes(row.arm.horizonSeconds))
  const clusters = dependence(rows)
  return {
    schema: SCHEMA_V2,
    sourceLabelsSchema: LABEL_SCHEMA_V2,
    cohort: 'scheduled_bound_v2_only',
    asOfUtc: labels.asOfUtc,
    asOfSemantics: labels.asOfSemantics,
    historicalAvailabilityCertified: false,
    chronologicalBacktestEligible: false,
    evidenceLevel: 'research_only',
    requestedHorizonsSeconds: selected,
    denominators: {
      allIssued: allRows.length,
      requestedIssued: rows.length,
      scored: rows.filter((row) => ['observed', 'missing', 'ambiguous'].includes(row.scoreStatus))
        .length,
      pending: rows.filter((row) => row.scoreStatus === 'pending').length,
      maturedUnscored: rows.filter((row) => row.scoreStatus === 'matured_unscored').length,
      dependencyComponentCount: clusters.length,
      multiIssueDependencyComponentCount: clusters.filter((cluster) => cluster.issueCount > 1)
        .length,
      independentEpisodeCount: null,
    },
    byHorizon: selected.map((horizonSeconds) => {
      const relevant = rows.filter((row) => row.arm.horizonSeconds === horizonSeconds)
      return {
        horizonSeconds,
        issued: relevant.length,
        evidenceClasses: Object.fromEntries(
          [...new Set(relevant.map((row) => row.evidenceClass))]
            .sort()
            .map((kind) => [kind, relevant.filter((row) => row.evidenceClass === kind).length]),
        ),
        pointStatuses: Object.fromEntries(
          [...new Set(relevant.map((row) => row.pointStatus ?? 'unscored'))]
            .sort()
            .map((status) => [
              status,
              relevant.filter((row) => (row.pointStatus ?? 'unscored') === status).length,
            ]),
        ),
        independentEpisodeCount: null,
      }
    }),
    dependentClusters: clusters,
    forecast: { status: 'unavailable', probability: null, likelyDurationSeconds: null },
    alert: { status: 'unavailable' },
    caveat:
      'V2 rows are retrospective, dependent, discrete sampled observations. Missing, ambiguity, and unscored rows are not exit failures. First loss is interval-censored and clean samples do not prove continuous availability.',
    rows,
  }
}

export async function readBoundEvaluationWithPgV2({ horizons = [], ...options } = {}) {
  const labels = await readBoundLabelsWithPgV2(options)
  return evaluateBoundLabelsV2({ labels, horizons })
}

// A user-selected H is admitted only by a scheduled target in [witness+H,
// witness+H+300s]. No interpolation or shorter enrolled arm enters its risk set.
export function evaluateWitnessedBoundLabelsV2({ labels, horizons }) {
  if (
    labels?.schema !== WITNESSED_LABEL_SCHEMA_V2 ||
    labels.cohort !== 'scheduled_bound_v2_witnessed_only' ||
    labels.asOfSemantics !== 'retained_receipt_asof_reconstruction' ||
    labels.witnessedRunCohortComplete !== true ||
    labels.scheduledSlotCohortComplete !== false ||
    labels.fullCohortComplete !== false ||
    labels.chronologicalBacktestEligible !== false ||
    !validUtc(labels.asOfUtc) ||
    !Array.isArray(labels.rows) ||
    !labels.armDenominators ||
    !Number.isSafeInteger(labels.armDenominators.total) ||
    labels.armDenominators.total !== labels.armDenominators.runs * 4 ||
    ['issued', 'abstained', 'failed', 'unknown'].some(
      (status) =>
        !Number.isSafeInteger(labels.armDenominators[status]) || labels.armDenominators[status] < 0,
    ) ||
    labels.armDenominators.total !==
      ['issued', 'abstained', 'failed', 'unknown'].reduce(
        (sum, status) => sum + labels.armDenominators[status],
        0,
      ) ||
    labels.armDenominators.issued !== labels.rows.length
  )
    throw new Error('Witnessed evaluation requires reconciled DB four-arm labels')
  if (!Array.isArray(horizons) || !horizons.length)
    throw new Error('Witnessed evaluation requires a user-selected horizon')
  const selected = requestedHorizons(horizons, labels.rows)
  const allRows = labels.rows.map((source) => {
    const row = classify(source, labels.asOfUtc)
    const witness = Date.parse(source.runVisibleAtUtc)
    const lead = (Date.parse(row.targetUtc) - witness) / 1000
    const scoreVisible = source.score?.scoreVisibleAtUtc
    const scored = ['observed', 'missing', 'ambiguous'].includes(row.scoreStatus)
    if (
      !validUtc(source.runVisibleAtUtc) ||
      witness > Date.parse(labels.asOfUtc) ||
      !Number.isFinite(lead) ||
      lead < 0 ||
      source.certifiedMinimumPublicationLeadSeconds !== lead ||
      source.currentAtDecision !== 'unverified' ||
      (source.baselineSampleAgeSecondsAtWitness !== null &&
        (!Number.isFinite(source.baselineSampleAgeSecondsAtWitness) ||
          source.baselineSampleAgeSecondsAtWitness < 0)) ||
      (scored &&
        (!validUtc(scoreVisible) || Date.parse(scoreVisible) > Date.parse(labels.asOfUtc))) ||
      (!scored && scoreVisible !== null)
    )
      throw new Error('Witnessed label visibility or lead differs from DB cutoff')
    const firstLoss = row.firstLossInterval
    return {
      ...row,
      runVisibleAtUtc: source.runVisibleAtUtc,
      certifiedMinimumPublicationLeadSeconds: lead,
      baselineSampleAgeSecondsAtWitness: source.baselineSampleAgeSecondsAtWitness,
      currentAtDecision: 'unverified',
      scoreVisibleAtUtc: scoreVisible,
      firstLossIntervalFromWitness: firstLoss
        ? {
            signedSecondsAtStart: (Date.parse(firstLoss.intervalStartUtc) - witness) / 1000,
            signedSecondsAtEnd: (Date.parse(firstLoss.intervalEndUtc) - witness) / 1000,
          }
        : null,
    }
  })
  const byHorizon = selected.map((horizonSeconds) => {
    const eligible = allRows.filter((row) => {
      const targetLagSeconds =
        (Date.parse(row.targetUtc) - Date.parse(row.runVisibleAtUtc)) / 1000 - horizonSeconds
      return targetLagSeconds >= 0 && targetLagSeconds <= WITNESSED_TARGET_TOLERANCE_SECONDS
    })
    const groups = dependence(eligible)
    return {
      requestedHorizonSeconds: horizonSeconds,
      exactTargetToleranceSeconds: WITNESSED_TARGET_TOLERANCE_SECONDS,
      eligibleIssued: eligible.length,
      abstainedNoExactTarget: allRows.length - eligible.length,
      observed: eligible.filter((row) => row.scoreStatus === 'observed').length,
      missing: eligible.filter((row) => row.scoreStatus === 'missing').length,
      ambiguous: eligible.filter((row) => row.scoreStatus === 'ambiguous').length,
      pending: eligible.filter((row) => row.scoreStatus === 'pending').length,
      maturedUnscored: eligible.filter((row) => row.scoreStatus === 'matured_unscored').length,
      pointStatuses: Object.fromEntries(
        [...new Set(eligible.map((row) => row.pointStatus ?? 'unscored'))]
          .sort()
          .map((status) => [
            status,
            eligible.filter((row) => (row.pointStatus ?? 'unscored') === status).length,
          ]),
      ),
      firstLossIntervalCount: eligible.filter((row) => row.firstLossInterval).length,
      dependencyComponentCount: groups.length,
      independentEpisodeCount: null,
      issues: eligible.map((row) => row.issue),
    }
  })
  const eligibleIssueNames = new Set(
    byHorizon.flatMap((group) => group.issues.map((issue) => issue.filename)),
  )
  const rows = allRows.filter((row) => eligibleIssueNames.has(row.issue.filename))
  const groups = dependence(rows)
  return {
    schema: WITNESSED_EVALUATION_SCHEMA_V2,
    sourceLabelsSchema: WITNESSED_LABEL_SCHEMA_V2,
    cohort: labels.cohort,
    cohortScope: 'db_witnessed_runs_at_asof',
    asOfUtc: labels.asOfUtc,
    historicalAvailabilityCertified: false,
    witnessedRunCohortComplete: true,
    scheduledSlotCohortComplete: false,
    chronologicalBacktestEligible: false,
    evidenceLevel: 'research_only',
    requestedHorizonsSeconds: selected,
    armDenominators: labels.armDenominators,
    // Validated issued rows before exact-target H selection. Research consumers
    // studying witnessed paths within a shorter H may use these with their own
    // explicit enrollment rule; `rows` below retains exact-target semantics.
    allIssuedRows: allRows,
    denominators: {
      witnessedRunArms: labels.armDenominators.total,
      allIssuedRiskSet: allRows.length,
      requestedEligibleIssued: rows.length,
      observed: rows.filter((row) => row.scoreStatus === 'observed').length,
      missing: rows.filter((row) => row.scoreStatus === 'missing').length,
      ambiguous: rows.filter((row) => row.scoreStatus === 'ambiguous').length,
      pending: rows.filter((row) => row.scoreStatus === 'pending').length,
      maturedUnscored: rows.filter((row) => row.scoreStatus === 'matured_unscored').length,
      dependencyComponentCount: groups.length,
      independentEpisodeCount: null,
    },
    byHorizon,
    dependentClusters: groups,
    forecast: { status: 'unavailable', probability: null, likelyDurationSeconds: null },
    alert: { status: 'unavailable' },
    caveat:
      'Four-arm counts cover DB-witnessed runs, not every scheduled slot. Exact target matching abstains outside the predeclared five-minute tolerance. Point outcomes and interval-censored first loss are separate; sampled success does not prove continuous ability. Source capture times are self-reported; probability, likely duration, alerts, and independent episode count are unavailable.',
    rows,
  }
}

export async function readWitnessedBoundEvaluationWithPgV2({ horizons, ...options } = {}) {
  if (!Array.isArray(horizons) || !horizons.length)
    throw new Error('Witnessed evaluation requires a user-selected horizon')
  const labels = await readWitnessedBoundLabelsWithPgV2(options)
  return evaluateWitnessedBoundLabelsV2({ labels, horizons })
}
