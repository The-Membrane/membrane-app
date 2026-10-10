// Descriptive issue-time risk sets from verified prospective exit labels.
// Sampled bounds are not continuous availability or a future duration forecast.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { MAX_HORIZON_SECONDS } from './scrvusd-exit-forecast-issue.mjs'
import { readEvaluation, SCHEMA as EVALUATION_SCHEMA } from './scrvusd-exit-duration-evaluation.mjs'

export const SCHEMA = 'scrvusd-exit-horizon-evidence-v1'
export const MAX_REQUESTED_HORIZONS = 64

const validUtc = (value) =>
  typeof value === 'string' &&
  Number.isSafeInteger(Date.parse(value)) &&
  new Date(value).toISOString() === value

const issueKey = (issue) => JSON.stringify(issue)

const emptyCounts = () => ({
  firstLossIntervalEndedByHorizon: 0,
  firstLossIntervalStraddlesHorizon: 0,
  firstLossIntervalStartsAfterHorizon: 0,
  rightCensoredBeforeHorizon: 0,
  rightCensoredAtOrAfterHorizon: 0,
  notEnrolledForHorizon: 0,
  pendingNotYetDue: 0,
  pendingRequestedHorizonPassedLongerFollowUp: 0,
  pendingCaptureWindowOpen: 0,
  pendingMaturedUnscored: 0,
  pendingUnknown: 0,
  missing: 0,
  providerAmbiguous: 0,
  ambiguousCensor: 0,
  pointOnlyOrUnclassified: 0,
  invalidTemporalEvidence: 0,
})

function evidenceAt(row, horizonSeconds, asOfMs) {
  if (!validUtc(row?.issuedAtUtc) || Date.parse(row.issuedAtUtc) > asOfMs)
    throw new Error('Issue is not available at requested as-of')
  if (
    row.scoreStatus === 'observed' &&
    (!validUtc(row.scoredAtUtc) || Date.parse(row.scoredAtUtc) > asOfMs)
  )
    throw new Error('Score is not available at requested as-of')
  if (!Number.isSafeInteger(row.horizonSeconds) || row.horizonSeconds < 1)
    return 'invalidTemporalEvidence'
  if (row.horizonSeconds < horizonSeconds) return 'notEnrolledForHorizon'

  if (row.scoreStatus === 'pending') {
    if (row.horizonSeconds > horizonSeconds) {
      const requestedTargetMs = Date.parse(row.issuedAtUtc) + horizonSeconds * 1000
      return asOfMs < requestedTargetMs
        ? 'pendingNotYetDue'
        : 'pendingRequestedHorizonPassedLongerFollowUp'
    }
    if (row.evidenceClass === 'not_yet_due') return 'pendingNotYetDue'
    if (row.evidenceClass === 'capture_window_open') return 'pendingCaptureWindowOpen'
    if (row.evidenceClass === 'matured_unscored') return 'pendingMaturedUnscored'
    return 'pendingUnknown'
  }
  if (row.evidenceClass === 'missing') return 'missing'
  if (row.evidenceClass === 'provider_ambiguous') return 'providerAmbiguous'
  if (row.evidenceClass === 'right_censored_ambiguous') return 'ambiguousCensor'

  if (row.evidenceClass === 'first_loss_interval') {
    const interval = row.firstLossInterval
    const start = interval?.signedSecondsFromIssueAtStart
    const end = interval?.signedSecondsFromIssueAtEnd
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start >= end ||
      end <= 0 ||
      !validUtc(interval.intervalStartUtc) ||
      !validUtc(interval.intervalEndUtc) ||
      Date.parse(interval.intervalStartUtc) > asOfMs ||
      Date.parse(interval.intervalEndUtc) > asOfMs ||
      Date.parse(interval.intervalEndUtc) <= Date.parse(interval.intervalStartUtc) ||
      Math.abs(
        (Date.parse(interval.intervalStartUtc) - Date.parse(row.issuedAtUtc)) / 1000 - start,
      ) > 1 ||
      Math.abs((Date.parse(interval.intervalEndUtc) - Date.parse(row.issuedAtUtc)) / 1000 - end) > 1
    )
      return 'invalidTemporalEvidence'
    if (end <= horizonSeconds) return 'firstLossIntervalEndedByHorizon'
    if (start < horizonSeconds) return 'firstLossIntervalStraddlesHorizon'
    return 'firstLossIntervalStartsAfterHorizon'
  }

  if (row.evidenceClass === 'right_censored') {
    const offset = row.latestCleanSampledSuccessOffsetSeconds
    if (!Number.isFinite(offset)) return 'invalidTemporalEvidence'
    if (Date.parse(row.issuedAtUtc) + offset * 1000 > asOfMs) return 'invalidTemporalEvidence'
    return offset >= horizonSeconds ? 'rightCensoredAtOrAfterHorizon' : 'rightCensoredBeforeHorizon'
  }
  return 'pointOnlyOrUnclassified'
}

// Synthetic evaluations are accepted for tests; production calls readHorizonEvidence,
// which reads and verifies the complete issue/score source ledgers first.
export function buildHorizonEvidence(evaluation, horizons = evaluation?.requestedHorizonsSeconds) {
  if (
    evaluation?.schema !== EVALUATION_SCHEMA ||
    !validUtc(evaluation.asOfUtc) ||
    !Array.isArray(evaluation.rows) ||
    !Array.isArray(evaluation.dependentClusters) ||
    !Array.isArray(horizons) ||
    horizons.length > MAX_REQUESTED_HORIZONS ||
    horizons.some((h) => !Number.isSafeInteger(h) || h < 1 || h > MAX_HORIZON_SECONDS)
  )
    throw new Error('Invalid exit duration evaluation or horizons')
  const selectedHorizons = [...new Set(horizons)].sort((a, b) => a - b)
  const asOfMs = Date.parse(evaluation.asOfUtc)
  const byHorizon = selectedHorizons.map((horizonSeconds) => {
    const counts = emptyCounts()
    const rows = evaluation.rows.map((row) => ({
      issue: row.issue,
      issuedHorizonSeconds: row.horizonSeconds,
      evidence: evidenceAt(row, horizonSeconds, asOfMs),
    }))
    for (const row of rows) counts[row.evidence]++
    const usedIssues = new Set(
      rows
        .filter((row) => row.evidence !== 'notEnrolledForHorizon')
        .map((row) => issueKey(row.issue)),
    )
    const involvedComponents = evaluation.dependentClusters
      .map(
        (cluster) => cluster.issues?.filter((issue) => usedIssues.has(issueKey(issue))).length ?? 0,
      )
      .filter((issueCount) => issueCount > 0)
    return {
      horizonSeconds,
      horizonOrigin: 'issue_time',
      allIssuedObservations: rows.length,
      issuedObservations: rows.length - counts.notEnrolledForHorizon,
      counts,
      dependence: {
        dependencyComponentCount: involvedComponents.length,
        multiIssueDependencyComponentCount: involvedComponents.filter(
          (issueCount) => issueCount >= 2,
        ).length,
        independentEpisodeCount: null,
      },
      rows,
    }
  })
  return {
    schema: SCHEMA,
    asOfUtc: evaluation.asOfUtc,
    evidenceLevel: 'research_only',
    forecastEligible: false,
    requestedHorizonsSeconds: selectedHorizons,
    allIssuedObservations: evaluation.rows.length,
    dependentClusters: evaluation.dependentClusters,
    byHorizon,
    forecast: { probability: null, likelyDurationSeconds: null },
    caveat:
      'Counts are dependent issued observations, not independent episodes. A clean sample proves only that instant; first sampled loss intervals and right censoring do not prove continuous exit ability or future duration.',
  }
}

export function readHorizonEvidence({
  asOfUtc = new Date().toISOString(),
  horizons = [],
  ...options
} = {}) {
  if (!Array.isArray(horizons) || horizons.length > MAX_REQUESTED_HORIZONS)
    throw new Error('Invalid requested horizons')
  const evaluation = readEvaluation({ asOfUtc, horizons, ...options })
  return buildHorizonEvidence(
    evaluation,
    horizons.length ? horizons : evaluation.requestedHorizonsSeconds,
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [asOfUtc = new Date().toISOString(), ...horizonArgs] = process.argv.slice(2)
    if (horizonArgs.some((value) => !/^[1-9][0-9]*$/.test(value)))
      throw new Error('Usage: [asOfUtc] [horizonSeconds ...]')
    console.log(JSON.stringify(readHorizonEvidence({ asOfUtc, horizons: horizonArgs.map(Number) })))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
