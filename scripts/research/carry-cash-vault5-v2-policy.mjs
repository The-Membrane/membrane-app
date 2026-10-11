// Frozen cohort policy. This v2 is a prospective aggregate-cash experiment,
// not a holder exit, flow, or duration model.
import { createHash } from 'node:crypto'

export const VAULT5_SUBJECTS = Object.freeze([
  Object.freeze({
    routeKey: 'AUSD → VaultV2 [AUSD]',
    destination: '0x32401b9fb79065bc15949de0bd43927492f02f0c',
    asset: '0x00000000efe302beaa2b3e6e1b18d08d69a9012a',
  }),
  Object.freeze({
    routeKey: 'USDC → VaultV2 [USDC]',
    destination: '0x069662d2588fcac24b5c209456db965d151556f0',
    asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  }),
  Object.freeze({
    routeKey: 'USDC → VaultV2 [USDC]',
    destination: '0x153bd1abe60104bd46aa05a27fa12d1346d64a57',
    asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  }),
  Object.freeze({
    routeKey: 'USDC → VaultV2 [USDC]',
    destination: '0xd5cce260e7a755ddf0fb9cdf06443d593aaeaa13',
    asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  }),
  Object.freeze({
    routeKey: 'USDC → VaultV2 [USDC]',
    destination: '0xf1ca44eea3a4effcb195a970a2f1d8553f76f9a1',
    asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  }),
])

export const VAULT5_V2_POLICY = Object.freeze({
  study: 'carry-vault5-prospective-aggregate-cash-v2',
  schemaVersion: 2,
  claim: 'aggregate_cash_proxy_only',
  horizonHours: 24,
  targetToleranceHours: 1,
  targetReceiptGraceHours: 1,
  targetSelectionRule:
    'after_deadline_choose_all_five_complete_current_receipt_nearest_h24_then_earliest_block_at_then_sequence',
  sourceMaximumAgeHours: 2,
  tickIntervalHours: 27,
  issueWindowHours: 1,
  developmentPairsPerSubject: 60,
  pointRule: 'lower_median_h24_cash_delta',
  bandRule: 'nearest_rank_p05_p95_signed_residual',
  baselinePointRule: 'source_cash_persistence',
  baselineBandRule: 'nearest_rank_p05_p95_cash_delta',
  minimumCompleteClustersPerSubject: 20,
  minimumScheduleCoveragePercent: 80,
  minimumOutcomeCoveragePercent: 80,
  minimumIntervalCoveragePercent: 80,
  sharpnessRule: 'model_band_width_lte_persistence_band_width',
  pointSkillRule: 'model_mae_strictly_below_persistence_mae',
  cohortRule: 'all_five_subjects_pass_independently',
  holderExecutableExit: false,
  competingFlowMeasured: false,
  durationForecast: false,
})

export const VAULT5_V2_POLICY_SHA256 = createHash('sha256')
  .update(JSON.stringify({ policy: VAULT5_V2_POLICY, subjects: VAULT5_SUBJECTS }))
  .digest('hex')

export const vault5Key = (row) => `${row.routeKey}\0${row.destination}\0${row.asset}`

export function assertVault5Manifest(manifest) {
  if (!manifest || !Array.isArray(manifest.subjects) || manifest.subjects.length !== 67)
    throw new Error('vault5_manifest_invalid')
  const actual = VAULT5_SUBJECTS.map((subject) =>
    manifest.subjects.filter(
      (row) =>
        row.route_key === subject.routeKey &&
        row.destination === subject.destination &&
        row.asset === subject.asset,
    ),
  )
  if (actual.some((rows) => rows.length !== 1)) throw new Error('vault5_manifest_identity')
  return manifest
}

const abs = (value) => (value < 0n ? -value : value)
const ordered = (values) => [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
const rank = (values, numerator, denominator) =>
  ordered(values)[Math.max(0, Math.ceil((values.length * numerator) / denominator) - 1)]

export function fitVault5Parameters(changes) {
  if (
    !Array.isArray(changes) ||
    changes.length !== VAULT5_V2_POLICY.developmentPairsPerSubject ||
    changes.some((value) => typeof value !== 'string' || !/^-?(0|[1-9][0-9]*)$/.test(value))
  )
    throw new Error('vault5_development_changes')
  const deltas = changes.map(BigInt)
  const median = ordered(deltas)[Math.floor((deltas.length - 1) / 2)]
  const residuals = deltas.map((value) => value - median)
  const low = rank(residuals, 5, 100)
  const high = rank(residuals, 95, 100)
  const baselineLow = rank(deltas, 5, 100)
  const baselineHigh = rank(deltas, 95, 100)
  if (high < low || baselineHigh < baselineLow || abs(median) > 1n << 256n)
    throw new Error('vault5_development_parameters')
  return {
    pointDeltaRaw: median.toString(),
    residualLowRaw: low.toString(),
    residualHighRaw: high.toString(),
    baselineLowRaw: baselineLow.toString(),
    baselineHighRaw: baselineHigh.toString(),
  }
}

const clamp = (value) => (value < 0n ? 0n : value > (1n << 256n) - 1n ? (1n << 256n) - 1n : value)

export function projectVault5Cash(sourceCashRaw, parameters) {
  if (!/^(0|[1-9][0-9]*)$/.test(sourceCashRaw ?? '')) throw new Error('vault5_source_cash')
  const source = BigInt(sourceCashRaw)
  const point = clamp(source + BigInt(parameters.pointDeltaRaw))
  const low = clamp(point + BigInt(parameters.residualLowRaw))
  const high = clamp(point + BigInt(parameters.residualHighRaw))
  const baselineLow = clamp(source + BigInt(parameters.baselineLowRaw))
  const baselineHigh = clamp(source + BigInt(parameters.baselineHighRaw))
  return {
    sourceCashRaw,
    pointRaw: point.toString(),
    lowRaw: low.toString(),
    highRaw: high.toString(),
    baselinePointRaw: sourceCashRaw,
    baselineLowRaw: baselineLow.toString(),
    baselineHighRaw: baselineHigh.toString(),
  }
}

export function assessVault5Subjects(issues, scores, ticks) {
  const missed = ticks.filter((row) => row.content.status === 'missed').length
  const issued = issues.length
  const scheduled = ticks.length
  const scoreByIssue = new Map(scores.map((row) => [row.content.issueSha256, row]))
  const rows = VAULT5_SUBJECTS.map((subject) => {
    const key = vault5Key(subject)
    const attempts = issues.map((issue) =>
      issue.content.attempts.find((row) => vault5Key(row) === key),
    )
    const outcomes = issues.flatMap(
      (issue) =>
        scoreByIssue.get(issue.sha256)?.content.outcomes.filter((row) => vault5Key(row) === key) ??
        [],
    )
    const complete = outcomes.filter((row) => row.status === 'observed')
    const covered = complete.filter((row) => row.covered).length
    const modelError = complete.reduce((sum, row) => sum + BigInt(row.modelAbsoluteErrorRaw), 0n)
    const baselineError = complete.reduce(
      (sum, row) => sum + BigInt(row.baselineAbsoluteErrorRaw),
      0n,
    )
    const widthPass = complete.every(
      (row) => BigInt(row.modelWidthRaw) <= BigInt(row.baselineWidthRaw),
    )
    const schedulePass =
      scheduled > 0 && issued * 100 >= scheduled * VAULT5_V2_POLICY.minimumScheduleCoveragePercent
    const outcomePass =
      issued > 0 && complete.length * 100 >= issued * VAULT5_V2_POLICY.minimumOutcomeCoveragePercent
    const intervalPass =
      complete.length > 0 &&
      covered * 100 >= complete.length * VAULT5_V2_POLICY.minimumIntervalCoveragePercent
    const passed =
      complete.length >= VAULT5_V2_POLICY.minimumCompleteClustersPerSubject &&
      schedulePass &&
      outcomePass &&
      intervalPass &&
      widthPass &&
      modelError < baselineError
    return {
      ...subject,
      completeClusters: complete.length,
      issuedAttempts: attempts.length,
      schedulePass,
      outcomePass,
      intervalPass,
      widthPass,
      pointSkillPass: complete.length > 0 && modelError < baselineError,
      covered,
      passed,
    }
  })
  return {
    scheduledClusters: scheduled,
    issuedClusters: issued,
    missedClusters: missed,
    scoredClusters: scores.length,
    bySubject: rows,
    cohortPassed: rows.every((row) => row.passed),
    claim: 'aggregate_cash_proxy_only',
    holderExecutableExit: false,
    prospectiveValidated: rows.every((row) => row.passed),
  }
}
