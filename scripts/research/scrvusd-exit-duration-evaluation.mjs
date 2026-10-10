// Read-only descriptive evaluation of prospective, issue-time scrvUSD exits.
// No row here is a continuous-availability estimate, forecast, or alert.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { MAX_HORIZON_SECONDS, outcomeProtocol } from './scrvusd-exit-forecast-issue.mjs'
import { readLabels, SCHEMA as LABEL_SCHEMA } from './scrvusd-prospective-exit-labels.mjs'

export const SCHEMA = 'scrvusd-exit-duration-evaluation-v1'
const validUtc = (value) =>
  typeof value === 'string' &&
  Number.isSafeInteger(Date.parse(value)) &&
  new Date(value).toISOString() === value

function horizonsOf(horizons) {
  if (
    !Array.isArray(horizons) ||
    horizons.some((h) => !Number.isSafeInteger(h) || h < 1 || h > MAX_HORIZON_SECONDS)
  )
    throw new Error('Invalid requested horizons')
  return [...new Set(horizons)].sort((a, b) => a - b)
}

function classify(row, asOfMs) {
  const issueMs = Date.parse(row.issuedAtUtc)
  const targetMs = Date.parse(row.targetUtc)
  const protocol = outcomeProtocol(row.issuedAtUtc, row.horizonSeconds)
  const deadlineUtc = protocol.checkpointSelection.captureDeadlineUtc
  const deadlineMs = Date.parse(deadlineUtc)
  const score = row.score
  const trajectory = score.trajectory
  const point = score.pointOutcome
  let evidenceClass
  if (score.status === 'pending') {
    evidenceClass =
      asOfMs < targetMs
        ? 'not_yet_due'
        : asOfMs < deadlineMs
          ? 'capture_window_open'
          : 'matured_unscored'
  } else if (trajectory?.firstLoss) {
    evidenceClass = 'first_loss_interval'
  } else if (
    point?.status === 'provider_ambiguity' ||
    trajectory?.censor?.reason === 'provider_ambiguity'
  ) {
    evidenceClass = 'provider_ambiguous'
  } else if (
    point?.status === 'missing_quote_checkpoint' ||
    point?.status === 'missing' ||
    trajectory?.censor?.reason === 'missing_holder_observation' ||
    trajectory?.status === 'unavailable_missing_capture'
  ) {
    evidenceClass = 'missing'
  } else if (trajectory?.status === 'right_censored_ambiguous') {
    evidenceClass = 'right_censored_ambiguous'
  } else if (trajectory?.status === 'right_censored_at_last_sampled_success') {
    evidenceClass = 'right_censored'
  } else if (point?.status === 'revert') {
    evidenceClass = 'point_revert_unattributed'
  } else if (point?.status === 'success') {
    evidenceClass = 'point_success_only'
  } else {
    evidenceClass = 'unclassified_observation'
  }
  const loss = trajectory?.firstLoss ?? null
  const lossStartSeconds = loss?.secondsFromIssueAtStart ?? null
  const lossEndSeconds = loss?.secondsFromIssueAtEnd ?? null
  const postIssueCleanStart =
    loss?.intervalStartKind === 'post_issue_clean_success_sample' &&
    typeof lossStartSeconds === 'number' &&
    lossStartSeconds > 0
  const preLossLastClean = trajectory?.preFirstLossLastCleanSuccessBlock ?? null
  const latestClean = trajectory?.latestCleanSampledSuccessBlock ?? null
  const sampleOffset = (sample) =>
    sample && Number.isSafeInteger(sample.timestamp) ? sample.timestamp - issueMs / 1000 : null
  return {
    issue: row.issue,
    issuedAtUtc: row.issuedAtUtc,
    targetUtc: row.targetUtc,
    captureDeadlineUtc: deadlineUtc,
    horizonOrigin: 'issue_time',
    horizonSeconds: row.horizonSeconds,
    horizonResolution: protocol.horizonResolution,
    targetWindowSeconds: protocol.checkpointSelection.windowSeconds,
    anchorBlock: row.anchorBlock,
    holder: row.holder,
    qAssetsRaw: row.qAssetsRaw,
    route: row.route,
    evidenceClass,
    scoreStatus: score.status,
    scoredAtUtc: score.scoredAtUtc,
    evidenceCutoffUtc: score.evidenceCutoffUtc,
    pointStatus: point?.status ?? null,
    pointSampledAtUtc: point?.sampledAtUtc ?? null,
    pointBlock: point?.block ?? null,
    pointTargetOffsetSeconds: point?.targetOffsetSeconds ?? null,
    pointHolderCaptureEndUtc: point?.holderCaptureEndUtc ?? null,
    trajectoryStatus: trajectory?.status ?? null,
    censorReason: trajectory?.censor?.reason ?? null,
    firstLossInterval: loss
      ? {
          intervalStartUtc: loss.intervalStartUtc,
          intervalEndUtc: loss.intervalEndUtc,
          startKind: loss.intervalStartKind,
          signedSecondsFromIssueAtStart: lossStartSeconds,
          signedSecondsFromIssueAtEnd: lossEndSeconds,
          positiveSampledLowerBoundSeconds: postIssueCleanStart ? lossStartSeconds : null,
        }
      : null,
    preFirstLossLastCleanSampleOffsetSeconds: loss ? sampleOffset(preLossLastClean) : null,
    latestCleanSampledSuccessOffsetSeconds: sampleOffset(latestClean),
    laterSampledRecovery: trajectory?.recovery ?? null,
    laterUnverifiedSuccess: trajectory?.laterSampledSuccess ?? null,
    postLossCensor: trajectory?.postLossCensor ?? null,
    postRecoveryCensor: trajectory?.postRecoveryCensor ?? null,
    relapses: trajectory?.relapses ?? [],
    subsequentRecoveries: trajectory?.subsequentRecoveries ?? [],
    latestComparableStatus: trajectory?.latestComparableStatus ?? null,
    baselineSampleStatus: row.baseline?.status ?? null,
    baselineCapturedAtUtc: row.baseline?.capturedAtUtc ?? null,
    historicalFlowStatus: row.historicalFlowStatus ?? 'unavailable',
    historicalFlowContext: row.historicalFlowContext ?? null,
    baselineCodeIdentity: row.baselineCodeIdentity ?? null,
    sampledCodeIdentity: score.sampledCodeIdentity ?? null,
    continuousAvailability: 'unverified',
  }
}

function dependence(rows) {
  const parent = rows.map((_, i) => i)
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const union = (i, j) => {
    parent[find(j)] = find(i)
  }
  const sameAnchorGroups = new Map()
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const key = JSON.stringify([
      row.anchorBlock.number,
      row.anchorBlock.hash,
      row.holder.toLowerCase(),
      row.qAssetsRaw,
      row.route,
    ])
    const prior = sameAnchorGroups.get(key)
    if (prior !== undefined) union(i, prior)
    else sameAnchorGroups.set(key, i)
    for (let j = 0; j < i; j++) {
      const other = rows[j]
      if (row.route !== other.route) continue // one fixed vault in this study
      if (
        Date.parse(row.issuedAtUtc) <= Date.parse(other.captureDeadlineUtc) &&
        Date.parse(other.issuedAtUtc) <= Date.parse(row.captureDeadlineUtc)
      )
        union(i, j)
    }
  }
  const clusters = new Map()
  rows.forEach((row, i) => {
    const root = find(i)
    if (!clusters.has(root)) clusters.set(root, [])
    clusters.get(root).push(row.issue)
  })
  return [...clusters.values()].map((issues, index) => ({
    id: `dependent-window-${index + 1}`,
    issueCount: issues.length,
    issues,
    reason: 'same_anchor_holder_amount_or_overlapping_single_vault_target_window',
  }))
}

// A synthetic fixture may be supplied for deterministic tests. Real evidence
// must enter through readEvaluation, which invokes the verified ledger reader.
export function evaluateLabels({ labels, horizons = [] }) {
  if (labels?.schema !== LABEL_SCHEMA || !validUtc(labels.asOfUtc) || !Array.isArray(labels.rows))
    throw new Error('Invalid verified labels')
  const requestedHorizonsSeconds = horizonsOf(
    horizons.length ? horizons : labels.rows.map((row) => row.horizonSeconds),
  )
  const rows = labels.rows.map((row) => {
    if (
      !validUtc(row.issuedAtUtc) ||
      !validUtc(row.targetUtc) ||
      row.horizonOrigin !== 'issue_time' ||
      row.targetUtc !== outcomeProtocol(row.issuedAtUtc, row.horizonSeconds).targetUtc ||
      !row.issue?.filename ||
      !row.anchorBlock?.hash ||
      !row.holder ||
      !row.qAssetsRaw ||
      !['pending', 'observed'].includes(row.score?.status) ||
      Date.parse(row.issuedAtUtc) > Date.parse(labels.asOfUtc) ||
      (row.score.status === 'observed' &&
        (!validUtc(row.score.scoredAtUtc) ||
          Date.parse(row.score.scoredAtUtc) > Date.parse(labels.asOfUtc)))
    )
      throw new Error('Invalid prospective issue label')
    return classify(row, Date.parse(labels.asOfUtc))
  })
  const byHorizon = requestedHorizonsSeconds.map((horizonSeconds) => {
    const selected = rows.filter((row) => row.horizonSeconds === horizonSeconds)
    return {
      horizonSeconds,
      issued: selected.length,
      classes: Object.fromEntries(
        [...new Set(selected.map((row) => row.evidenceClass))]
          .sort()
          .map((status) => [status, selected.filter((row) => row.evidenceClass === status).length]),
      ),
      independentEpisodeCount: null,
    }
  })
  return {
    schema: SCHEMA,
    asOfUtc: labels.asOfUtc,
    requestedHorizonsSeconds,
    denominators: {
      allIssued: rows.length,
      requestedIssued: rows.filter((row) => requestedHorizonsSeconds.includes(row.horizonSeconds))
        .length,
      scored: rows.filter((row) => row.scoreStatus === 'observed').length,
      unscored: rows.filter((row) => row.scoreStatus === 'pending').length,
      independentEpisodeCount: null,
    },
    byHorizon,
    dependentClusters: dependence(rows),
    forecast: { status: 'unavailable', probability: null, likelyDurationSeconds: null },
    alert: { status: 'unavailable' },
    caveat:
      'Discrete sampled points and signed first-loss intervals do not establish continuous exit availability or a calibrated remaining duration. The local issue and score clocks, code identity, and source capture times remain distinct.',
    rows,
  }
}

export function readEvaluation({ asOfUtc, horizons = [], ...options } = {}) {
  return evaluateLabels({ labels: readLabels({ asOfUtc, ...options }), horizons })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [asOfUtc = new Date().toISOString(), ...horizonArgs] = process.argv.slice(2)
    if (horizonArgs.some((value) => !/^[1-9][0-9]*$/.test(value)))
      throw new Error('Usage: [asOfUtc] [horizonSeconds ...]')
    console.log(JSON.stringify(readEvaluation({ asOfUtc, horizons: horizonArgs.map(Number) })))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
