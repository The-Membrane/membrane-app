// Descriptive sampled first-loss timing for the DB-witnessed v2 cohort.
// This pure reducer does not authenticate caller-supplied labels. Public reads
// must enter through readWitnessedFirstLossWithPgV2 below.
import { MAX_HORIZON_SECONDS } from './scrvusd-exit-forecast-issue.mjs'
import {
  evaluateWitnessedBoundLabelsV2,
  witnessedDependenceComponents,
} from './scrvusd-bound-exit-evaluation.mjs'
import {
  readWitnessedBoundLabelsWithPgV2,
  WITNESSED_SCHEMA_V2,
} from './scrvusd-bound-prospective-exit-labels.mjs'

export const SCHEMA = 'scrvusd-witness-first-loss-v1'
const ISSUE_KEY = (issue) =>
  JSON.stringify([issue.filename, issue.logicalSha256, issue.physicalSha256])

function classifyFirstLoss(row, selectedHorizonSeconds, asOfUtc) {
  const witness = Date.parse(row.runVisibleAtUtc)
  const endOfHorizon = witness + selectedHorizonSeconds * 1000
  const interval = row.firstLossInterval
  if (interval) {
    const start = Date.parse(interval.intervalStartUtc)
    const end = Date.parse(interval.intervalEndUtc)
    if (end <= witness) return 'first_sampled_loss_before_witness'
    if (start < witness) return 'first_loss_interval_straddles_witness'
    if (end <= endOfHorizon) return 'definite_post_witness_first_sampled_loss_by_H'
    if (start < endOfHorizon) return 'first_loss_interval_straddles_H'
    return 'first_sampled_loss_later_than_H'
  }

  // A missing or ambiguous checkpoint cannot be converted into sampled success.
  // A prior clean-success sample also cannot repair an ambiguous trajectory.
  if (row.scoreStatus === 'pending')
    return Date.parse(asOfUtc) < endOfHorizon
      ? 'pending_before_H'
      : 'pending_H_elapsed_awaiting_score'
  if (row.scoreStatus === 'matured_unscored') return 'matured_unscored'
  if (row.scoreStatus === 'missing') return 'scored_missing'
  if (row.scoreStatus === 'ambiguous') return 'scored_ambiguous'
  if (row.trajectoryStatus === 'right_censored_ambiguous') return 'right_censored_ambiguous'
  if (row.trajectoryStatus === 'right_censored_at_last_sampled_success') {
    const block = row.latestCleanSampledSuccessBlock
    const timestamp = block?.timestamp
    if (
      !Number.isSafeInteger(timestamp) ||
      timestamp < 0 ||
      timestamp * 1000 > Date.parse(asOfUtc) ||
      (block?.number !== undefined && !Number.isSafeInteger(block.number))
    )
      throw new Error('Right-censor sample lacks a valid as-of block timestamp')
    return timestamp * 1000 >= endOfHorizon
      ? 'right_censored_sampled_success_covers_H'
      : 'right_censored_before_H'
  }
  // A target-at-H point is never promoted to a first-loss label. The point
  // may fall as much as five minutes after H and lacks an intervening path.
  return 'first_loss_path_unresolved'
}

export function buildWitnessedFirstLoss({ labels, horizons }) {
  if (labels?.schema !== WITNESSED_SCHEMA_V2 || labels.retainedReceiptVisibilityCertified !== true)
    throw new Error('First-loss study requires DB-reconciled witnessed v2 labels')
  if (
    !Array.isArray(horizons) ||
    !horizons.length ||
    horizons.some(
      (horizon) => !Number.isSafeInteger(horizon) || horizon < 1 || horizon > MAX_HORIZON_SECONDS,
    )
  )
    throw new Error('First-loss study requires selected H within protocol maximum')
  const evaluation = evaluateWitnessedBoundLabelsV2({ labels, horizons })
  const sourceByIssue = new Map()
  for (const source of labels.rows) {
    const key = ISSUE_KEY(source.issue)
    if (sourceByIssue.has(key)) throw new Error('Duplicate witnessed issue reference')
    sourceByIssue.set(key, source)
  }
  const byHorizon = evaluation.requestedHorizonsSeconds.map((H) => {
    const eligible = evaluation.allIssuedRows.filter(
      (row) => row.certifiedMinimumPublicationLeadSeconds >= H,
    )
    const notEnrolled = evaluation.allIssuedRows
      .filter((row) => row.certifiedMinimumPublicationLeadSeconds < H)
      .map((row) => ({
        issue: row.issue,
        arm: row.arm,
        holder: row.holder,
        qAssetsRaw: row.qAssetsRaw,
        route: row.route,
        remainingLeadSeconds: row.certifiedMinimumPublicationLeadSeconds,
        reason: 'insufficient_remaining_lead_for_H',
      }))
    if (eligible.length + notEnrolled.length !== evaluation.denominators.allIssuedRiskSet)
      throw new Error('First-loss H risk set differs from validated issued rows')
    const rows = eligible.map((row) => {
      const source = sourceByIssue.get(ISSUE_KEY(row.issue))
      if (
        !source ||
        source.targetUtc !== row.targetUtc ||
        source.runVisibleAtUtc !== row.runVisibleAtUtc ||
        source.holder !== row.holder ||
        source.qAssetsRaw !== row.qAssetsRaw ||
        source.route !== row.route ||
        source.anchorBlock?.number !== row.anchorBlock?.number ||
        source.anchorBlock?.hash !== row.anchorBlock?.hash
      )
        throw new Error('First-loss source differs from eligible witnessed issue')
      if (row.currentAtDecision !== 'unverified')
        throw new Error('Current exit baseline must remain unverified')
      const firstLossClass = classifyFirstLoss(row, H, labels.asOfUtc)
      return {
        issue: row.issue,
        arm: row.arm,
        anchorBlock: row.anchorBlock,
        holder: row.holder,
        qAssetsRaw: row.qAssetsRaw,
        route: row.route,
        issuedAtUtc: row.issuedAtUtc,
        runVisibleAtUtc: row.runVisibleAtUtc,
        selectedHorizonEndsAtUtc: new Date(
          Date.parse(row.runVisibleAtUtc) + H * 1000,
        ).toISOString(),
        targetUtc: row.targetUtc,
        captureDeadlineUtc: row.captureDeadlineUtc,
        certifiedMinimumPublicationLeadSeconds: row.certifiedMinimumPublicationLeadSeconds,
        baselineSampleAgeSecondsAtWitness: row.baselineSampleAgeSecondsAtWitness,
        currentAtDecision: 'unverified',
        scoreStatus: row.scoreStatus,
        pointStatus: row.pointStatus,
        trajectoryStatus: row.trajectoryStatus,
        firstLossClass,
        firstLossInterval: row.firstLossInterval,
        firstLossIntervalFromWitness: row.firstLossIntervalFromWitness,
        latestCleanSampledSuccessBlock: row.latestCleanSampledSuccessBlock,
        sampledContinuity: 'unverified',
      }
    })
    const classes = Object.fromEntries(
      [...new Set(rows.map((row) => row.firstLossClass))]
        .sort()
        .map((name) => [name, rows.filter((row) => row.firstLossClass === name).length]),
    )
    const dependentClusters = witnessedDependenceComponents(eligible)
    return {
      requestedHorizonSeconds: H,
      selectionRule: 'certified_remaining_lead_at_least_H',
      witnessedRunArms: evaluation.armDenominators.total,
      allIssuedRiskSet: evaluation.denominators.allIssuedRiskSet,
      eligibleIssued: rows.length,
      notEnrolled,
      insufficientRemainingLead: notEnrolled.length,
      classes,
      scoreStatuses: {
        observed: eligible.filter((row) => row.scoreStatus === 'observed').length,
        missing: eligible.filter((row) => row.scoreStatus === 'missing').length,
        ambiguous: eligible.filter((row) => row.scoreStatus === 'ambiguous').length,
        pending: eligible.filter((row) => row.scoreStatus === 'pending').length,
        maturedUnscored: eligible.filter((row) => row.scoreStatus === 'matured_unscored').length,
      },
      dependentClusters,
      dependencyComponentCount: dependentClusters.length,
      independentEpisodeCount: null,
      rows,
    }
  })
  return {
    schema: SCHEMA,
    sourceLabelsSchema: WITNESSED_SCHEMA_V2,
    sourceEvaluationSchema: evaluation.schema,
    cohort: evaluation.cohort,
    asOfUtc: evaluation.asOfUtc,
    asOfSemantics: labels.asOfSemantics,
    retainedReceiptVisibilityCertified: true,
    witnessedRunCohortComplete: true,
    scheduledSlotCohortComplete: false,
    historicalAvailabilityCertified: false,
    chronologicalBacktestEligible: false,
    evidenceLevel: 'research_only',
    armDenominators: evaluation.armDenominators,
    requestedHorizonsSeconds: evaluation.requestedHorizonsSeconds,
    byHorizon,
    forecast: { status: 'unavailable', probability: null, likelyDurationSeconds: null },
    alert: { status: 'unavailable' },
    caveat:
      'Only sampled first-loss intervals are classified. Current ability at run witness and continuous exit ability are unverified. Point outcomes, missing checkpoints and ambiguous gaps do not create a first-loss binary label. DB-witnessed runs do not cover every scheduled slot; dependent components are not independent episodes.',
  }
}

export async function readWitnessedFirstLossWithPgV2({ horizons, ...options } = {}) {
  if (!Array.isArray(horizons) || !horizons.length)
    throw new Error('First-loss study requires selected H')
  const labels = await readWitnessedBoundLabelsWithPgV2(options)
  return buildWitnessedFirstLoss({ labels, horizons })
}
