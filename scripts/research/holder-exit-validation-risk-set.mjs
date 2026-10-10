// Pure projection of an already verified holder episode panel. This module does
// not read data, issue probes, train a model, or promote a forecast.
import { createHash } from 'node:crypto'

export const HOLDER_EXIT_RISK_SET_VERSION = 1

const PANEL_SCOPE = 'offline_frozen_25_67_holder_episode_panel'
const RISK_SET_SCOPE = 'holder_exit_validation_risk_set_v1'
const SHA = /^[0-9a-f]{64}$/
const BLOCK_HASH = /^0x[0-9a-f]{64}$/i
const ADDRESS = /^0x[0-9a-f]{40}$/i
const MEASURED = new Set(['simulated_callable', 'simulated_impaired'])
const OUTCOMES = new Set([
  'simulated_callable',
  'simulated_impaired',
  'censored',
  'pending',
  'missing',
  'inconclusive',
  'unavailable',
  'not_at_risk',
  'not_assayed',
])
const EXACT_CLOCK = 'independently_witnessed_utc'
const DIRECT_GROSS_FLOW_KINDS = new Set([
  'gross_supplier_withdraw_24h',
  'gross_supplier_supply_24h',
])
// Minimal two-origin tuples attest an operator observation but cannot prove
// that each claimed Ethereum header hashes to its saved block hash.
const VERIFIED_PARENT_LINKS = 'cryptographically_verified_parent_links'
const MAX_ROWS = 20_000

const check = (condition, reason) => {
  if (!condition) throw Error(`holder_exit_risk_set_${reason}`)
}
const sha = (value) => createHash('sha256').update(value).digest('hex')
const identity = (route, destination, asset) =>
  `${route}\0${destination.toLowerCase()}\0${asset.toLowerCase()}`
const utcMs = (value) => {
  const ms = Date.parse(value)
  return Number.isSafeInteger(ms) && new Date(ms).toISOString() === value ? ms : null
}
const uniqueClusters = (rows) =>
  new Set(rows.filter((row) => row.holderCommitment).map((row) => row.issueClusterSha256)).size
const trajectoryKey = (row) =>
  JSON.stringify([
    row.subject,
    row.stageScope,
    row.issueClusterSha256,
    row.holderCommitment,
    row.qRaw,
    String(row.baselineBlock),
    row.baselineBlockHash.toLowerCase(),
  ])

function validateEnvelope(panel, manifest) {
  check(panel?.scope === PANEL_SCOPE, 'panel_scope_invalid')
  check(
    panel.sourceVerification === 'offline_sealed_replay' ||
      panel.sourceVerification === 'caller_supplied',
    'source_verification_invalid',
  )
  check(
    Array.isArray(manifest?.subjects) &&
      manifest.subjects.length === 67 &&
      SHA.test(manifest.sha256 ?? '') &&
      sha(JSON.stringify(manifest.subjects)) === manifest.sha256 &&
      panel.manifestSha256 === manifest.sha256,
    'manifest_invalid',
  )
  const expected = new Map()
  const routes = new Set()
  for (const subject of manifest.subjects) {
    check(
      typeof subject.route_key === 'string' &&
        subject.route_key.length > 0 &&
        ADDRESS.test(subject.destination ?? '') &&
        ADDRESS.test(subject.asset ?? ''),
      'manifest_subject_invalid',
    )
    const key = identity(subject.route_key, subject.destination, subject.asset)
    check(!expected.has(key), 'manifest_subject_duplicate')
    expected.set(key, subject)
    routes.add(subject.route_key)
  }
  check(routes.size === 25, 'manifest_route_count_invalid')
  check(Array.isArray(panel.subjects) && panel.subjects.length === 67, 'subjects_invalid')
  const subjects = new Map()
  for (const subject of panel.subjects) {
    check(
      typeof subject?.routeKey === 'string' &&
        ADDRESS.test(subject.destination ?? '') &&
        ADDRESS.test(subject.asset ?? '') &&
        typeof subject.stageScope === 'string' &&
        subject.stageScope.length > 0 &&
        Array.isArray(subject.episodes),
      'subject_shape_invalid',
    )
    const key = identity(subject.routeKey, subject.destination, subject.asset)
    check(expected.has(key) && !subjects.has(key), 'subject_identity_invalid')
    subjects.set(key, subject)
  }
  check(subjects.size === expected.size, 'subject_count_invalid')
  return subjects
}

function classification(row) {
  const status = row.outcome.status
  if (!row.holderCommitment && MEASURED.has(row.baseline)) return 'holder_unavailable'
  if (status === 'censored') {
    if (row.outcome.reason === 'capture_window_missed') return 'capture_window_missed'
    if (row.outcome.reason === 'holder_attrition') return 'holder_attrition'
    return 'other_censored'
  }
  if (['pending', 'missing', 'inconclusive', 'unavailable'].includes(status)) return status
  if (!MEASURED.has(row.baseline)) return 'baseline_not_measured'
  if (status === 'not_at_risk' || status === 'not_assayed') return 'not_assayed'
  if (row.baseline === 'simulated_callable')
    return status === 'simulated_impaired' ? 'onset' : 'control'
  return status === 'simulated_callable' ? 'baseline_impaired_then_callable' : 'still_impaired'
}

function validateRow(row, subjectKey, stageScope) {
  check(
    row?.subject === subjectKey &&
      row.stageScope === stageScope &&
      SHA.test(row.issueClusterSha256 ?? '') &&
      SHA.test(row.issueSha256 ?? '') &&
      (row.scoreSha256 == null || SHA.test(row.scoreSha256)) &&
      (row.analysisCellKey == null || SHA.test(row.analysisCellKey)) &&
      (row.holderCommitment == null || SHA.test(row.holderCommitment)) &&
      typeof row.qRaw === 'string' &&
      /^\d+$/.test(row.qRaw) &&
      ((typeof row.baselineBlock === 'string' && /^\d+$/.test(row.baselineBlock)) ||
        (Number.isSafeInteger(row.baselineBlock) && row.baselineBlock >= 0)) &&
      BLOCK_HASH.test(row.baselineBlockHash ?? '') &&
      Number.isSafeInteger(row.plannedHorizonHours) &&
      row.plannedHorizonHours > 0 &&
      (row.analysisPrimaryForCell == null || typeof row.analysisPrimaryForCell === 'boolean') &&
      [
        'simulated_callable',
        'simulated_impaired',
        'unavailable',
        'inconclusive',
        'time_gated',
      ].includes(row.baseline) &&
      OUTCOMES.has(row.outcome?.status) &&
      (row.outcome.reason == null || typeof row.outcome.reason === 'string') &&
      Array.isArray(row.featureRefs) &&
      row.featureAbstentions &&
      typeof row.featureAbstentions === 'object' &&
      !Array.isArray(row.featureAbstentions),
    'row_shape_invalid',
  )
  const issueMs = utcMs(row.issueAtUtc)
  const targetMs = utcMs(row.targetAtUtc)
  const deadlineMs = utcMs(row.deadlineAtUtc)
  check(issueMs != null && targetMs > issueMs && deadlineMs > targetMs, 'row_clock_invalid')
  check(row.observedAtUtc == null || utcMs(row.observedAtUtc) != null, 'observed_clock_invalid')
  for (const [reason, count] of Object.entries(row.featureAbstentions))
    check(
      typeof reason === 'string' && Number.isSafeInteger(count) && count >= 0,
      'feature_abstention_invalid',
    )
  for (const feature of row.featureRefs)
    check(
      typeof feature?.kind === 'string' &&
        feature.kind.length > 0 &&
        SHA.test(feature.receiptSha256 ?? '') &&
        utcMs(feature.sourceAt) != null &&
        utcMs(feature.firstLocalReceiptAt) != null &&
        utcMs(feature.completedAtUtc) != null,
      'feature_ref_invalid',
    )
}

function featureAbstention(row, requiredFeatureKinds) {
  const refs = new Map(row.featureRefs.map((feature) => [feature.kind, feature]))
  const issueMs = utcMs(row.issueAtUtc)
  for (const kind of requiredFeatureKinds) if (!refs.has(kind)) return 'required_feature_missing'
  for (const feature of row.featureRefs)
    if (
      utcMs(feature.sourceAt) > issueMs ||
      utcMs(feature.firstLocalReceiptAt) > issueMs ||
      utcMs(feature.completedAtUtc) > issueMs
    )
      return 'late_feature_availability'
  for (const kind of requiredFeatureKinds) {
    if (!DIRECT_GROSS_FLOW_KINDS.has(kind)) continue
    const feature = refs.get(kind)
    if (feature.sourceBaselineAncestry !== VERIFIED_PARENT_LINKS)
      return 'source_baseline_ancestry_unproven'
    if (feature.clockBasis !== EXACT_CLOCK) return 'feature_clock_unwitnessed'
  }
  return null
}

function splitAbstention(row, panel, featureReason) {
  if (featureReason) return featureReason
  if (panel.sourceVerification !== 'offline_sealed_replay') return 'source_not_sealed'
  if (!row.holderCommitment) return 'holder_unavailable'
  if (!row.holderCommitment) return 'holder_unavailable'
  if (!MEASURED.has(row.baseline)) return 'baseline_not_measured'
  if (!MEASURED.has(row.outcome.status)) return `outcome_${row.outcome.status}`
  if (!SHA.test(row.scoreSha256 ?? '')) return 'score_receipt_missing'
  if (row.issueClock !== EXACT_CLOCK || row.featureAvailabilityClock !== EXACT_CLOCK)
    return 'issue_or_feature_clock_unwitnessed'
  if (row.scoreClock !== EXACT_CLOCK) return 'score_clock_unwitnessed'
  const scoreMs = utcMs(row.scoreAtUtc)
  if (scoreMs == null) return 'score_clock_missing'
  const observedMs = utcMs(row.observedAtUtc)
  if (
    observedMs == null ||
    observedMs < utcMs(row.targetAtUtc) ||
    observedMs > utcMs(row.deadlineAtUtc) ||
    scoreMs < observedMs
  )
    return 'score_clock_order_invalid'
  return null
}

// Versioned issues may share a parent and an anchor. A fresh baseline starts a
// new trajectory, while the parent cluster remains one split unit.
function classifyTrajectories(members, continuityBreaks) {
  const trajectories = new Map()
  for (const member of members) {
    const key = trajectoryKey(member)
    const rows = trajectories.get(key) ?? []
    rows.push(member)
    trajectories.set(key, rows)
  }
  for (const [key, rows] of trajectories) {
    rows.sort(
      (a, b) =>
        utcMs(a.targetAtUtc) - utcMs(b.targetAtUtc) ||
        a.plannedHorizonHours - b.plannedHorizonHours,
    )
    const baselines = new Set(
      rows.filter((row) => MEASURED.has(row.baseline)).map((row) => row.baseline),
    )
    if (baselines.size > 1) {
      for (const row of rows) {
        row.classification = 'trajectory_baseline_conflict'
        row.splitAbstention = 'trajectory_baseline_conflict'
      }
      continue
    }
    let firstImpairmentSeen = false
    let currentlyImpaired = rows[0].baseline === 'simulated_impaired'
    let recoverySeen = false
    for (const row of rows) {
      if (!row.holderCommitment) continue
      if (row.correlatedEvidenceVeto) continue
      if (
        utcMs(row.targetAtUtc) > (continuityBreaks.get(key) ?? Infinity) &&
        MEASURED.has(row.outcomeStatus)
      ) {
        row.classification = 'post_continuity_veto_unusable'
        row.splitAbstention = 'post_continuity_veto_unusable'
        continue
      }
      if (row.outcomeStatus === 'censored' && row.outcomeReason === 'holder_attrition') continue
      if (!MEASURED.has(row.baseline) || !MEASURED.has(row.outcomeStatus)) continue
      if (row.outcomeStatus === 'simulated_impaired') {
        if (row.baseline === 'simulated_callable' && !firstImpairmentSeen) {
          row.classification = 'onset'
          firstImpairmentSeen = true
        } else if (recoverySeen && !currentlyImpaired) {
          row.classification = 'relapse_after_recovery'
        } else if (firstImpairmentSeen) {
          row.classification = 'still_impaired_after_onset'
        }
        currentlyImpaired = true
      } else if (currentlyImpaired) {
        row.classification =
          row.baseline === 'simulated_impaired' && !recoverySeen
            ? 'baseline_impaired_then_callable'
            : 'recovery_after_sampled_onset'
        currentlyImpaired = false
        recoverySeen = true
      } else if (recoverySeen) {
        row.classification = 'post_recovery_callable'
      }
    }
  }
}

function tally(rows) {
  const classes = [
    'onset',
    'control',
    'baseline_impaired_then_callable',
    'recovery_after_sampled_onset',
    'still_impaired_after_onset',
    'relapse_after_recovery',
    'post_recovery_callable',
    'post_continuity_veto_unusable',
    'correlated_holder_attrition',
    'correlated_outcome_conflict',
    'correlated_baseline_conflict',
    'correlated_baseline_anchor_conflict',
    'correlated_target_conflict',
    'trajectory_baseline_conflict',
    'still_impaired',
    'capture_window_missed',
    'holder_attrition',
    'other_censored',
    'pending',
    'missing',
    'inconclusive',
    'unavailable',
    'not_assayed',
    'baseline_not_measured',
    'holder_unavailable',
  ]
  const out = {
    primaryRows: rows.length,
    issueClusterUpperBound: uniqueClusters(rows),
    holderlessPrimaryRows: rows.filter((row) => !row.holderCommitment).length,
    baselineCallableRows: rows.filter((row) => row.baseline === 'simulated_callable').length,
    baselineImpairedRows: rows.filter((row) => row.baseline === 'simulated_impaired').length,
    baselineNotMeasuredRows: rows.filter((row) => !MEASURED.has(row.baseline)).length,
    scoredRows: rows.filter((row) => MEASURED.has(row.outcomeStatus)).length,
  }
  for (const name of classes) {
    const matching = rows.filter((row) => row.classification === name)
    out[`${name}Rows`] = matching.length
    out[`${name}ClusterUpperBound`] = uniqueClusters(matching)
  }
  const sampledRecoveries = rows.filter((row) =>
    ['baseline_impaired_then_callable', 'recovery_after_sampled_onset'].includes(
      row.classification,
    ),
  )
  out.sampledRecoveryRows = sampledRecoveries.length
  out.sampledRecoveryClusterUpperBound = uniqueClusters(sampledRecoveries)
  const ongoingImpairments = rows.filter((row) =>
    ['still_impaired', 'still_impaired_after_onset'].includes(row.classification),
  )
  out.ongoingImpairmentRows = ongoingImpairments.length
  out.ongoingImpairmentClusterUpperBound = uniqueClusters(ongoingImpairments)
  return out
}

function makeSplit(members) {
  const candidates = members.filter((member) => member.splitAbstention === null)
  const clusters = new Map()
  for (const member of candidates) {
    const current = clusters.get(member.issueClusterSha256) ?? {
      issueClusterSha256: member.issueClusterSha256,
      firstIssueMs: Infinity,
      lastScoreMs: -Infinity,
      members: [],
    }
    current.firstIssueMs = Math.min(current.firstIssueMs, utcMs(member.issueAtUtc))
    current.lastScoreMs = Math.max(current.lastScoreMs, utcMs(member.scoreAtUtc))
    current.members.push(member)
    clusters.set(member.issueClusterSha256, current)
  }
  const sorted = [...clusters.values()].sort(
    (a, b) =>
      a.firstIssueMs - b.firstIssueMs || a.issueClusterSha256.localeCompare(b.issueClusterSha256),
  )
  const abstentions = {}
  for (const member of members) {
    if (member.splitAbstention)
      abstentions[member.splitAbstention] = (abstentions[member.splitAbstention] ?? 0) + 1
  }
  if (sorted.length < 3)
    return {
      status: 'abstained',
      reason: 'fewer_than_three_exact_clock_clusters',
      exactClockCandidateRows: candidates.length,
      exactClockCandidateClusters: sorted.length,
      abstentions,
      fit: null,
      calibration: null,
      holdout: null,
    }
  const fitEnd = Math.max(1, Math.floor(sorted.length * 0.6))
  const calibrationEnd = Math.max(fitEnd + 1, Math.floor(sorted.length * 0.8))
  const partitions = [
    sorted.slice(0, fitEnd),
    sorted.slice(fitEnd, calibrationEnd),
    sorted.slice(calibrationEnd),
  ]
  const embargoMs = Math.max(...candidates.map((row) => row.plannedHorizonHours)) * 3_600_000
  const boundarySafe = (left, right) =>
    Math.max(...left.map((cluster) => cluster.lastScoreMs)) + embargoMs <=
    Math.min(...right.map((cluster) => cluster.firstIssueMs))
  if (
    !partitions.every((partition) => partition.length > 0) ||
    !boundarySafe(partitions[0], partitions[1]) ||
    !boundarySafe(partitions[1], partitions[2])
  )
    return {
      status: 'abstained',
      reason: 'horizon_embargo_or_partition_failed',
      exactClockCandidateRows: candidates.length,
      exactClockCandidateClusters: sorted.length,
      embargoHours: embargoMs / 3_600_000,
      abstentions,
      fit: null,
      calibration: null,
      holdout: null,
    }
  const summarize = (partition) => {
    const rows = partition.flatMap((cluster) => cluster.members)
    return {
      issueClusters: partition.map((cluster) => cluster.issueClusterSha256),
      firstIssueAtUtc: new Date(
        Math.min(...partition.map((cluster) => cluster.firstIssueMs)),
      ).toISOString(),
      lastScoreAtUtc: new Date(
        Math.max(...partition.map((cluster) => cluster.lastScoreMs)),
      ).toISOString(),
      ...tally(rows),
    }
  }
  return {
    status: 'descriptive_split_only',
    reason: 'physical_independence_and_model_validation_unverified',
    exactClockCandidateRows: candidates.length,
    exactClockCandidateClusters: sorted.length,
    embargoHours: embargoMs / 3_600_000,
    abstentions,
    fit: summarize(partitions[0]),
    calibration: summarize(partitions[1]),
    holdout: summarize(partitions[2]),
  }
}

/**
 * Build denominators from the frozen 25/67 panel and its independently supplied
 * manifest. A score availability clock is absent from the current panel, so
 * its real rows abstain from chronological validation by design.
 */
export function buildHolderExitValidationRiskSet({ panel, manifest, requiredFeatureKinds = [] }) {
  const subjects = validateEnvelope(panel, manifest)
  check(
    Array.isArray(requiredFeatureKinds) &&
      requiredFeatureKinds.every((kind) => typeof kind === 'string' && kind.length > 0) &&
      new Set(requiredFeatureKinds).size === requiredFeatureKinds.length,
    'required_features_invalid',
  )
  const members = []
  let rawRows = 0
  let duplicateRows = 0
  const seenCells = new Map()
  const sourceFeatureAbstentions = {}
  for (const [subjectKey, subject] of subjects) {
    for (const row of subject.episodes) {
      rawRows++
      check(rawRows <= MAX_ROWS, 'row_limit')
      validateRow(row, subjectKey, subject.stageScope)
      const correlationKey = JSON.stringify([
        subjectKey,
        subject.stageScope,
        row.issueClusterSha256,
        row.analysisCellKey ?? 'shared',
        row.holderCommitment,
        row.qRaw,
        row.plannedHorizonHours,
      ])
      const previous = seenCells.get(correlationKey) ?? { primary: 0, rows: [], member: null }
      previous.rows.push(row)
      if (row.analysisPrimaryForCell) previous.primary++
      seenCells.set(correlationKey, previous)
      if (row.analysisPrimaryForCell !== true) {
        duplicateRows++
        continue
      }
      for (const [reason, count] of Object.entries(row.featureAbstentions))
        sourceFeatureAbstentions[reason] = (sourceFeatureAbstentions[reason] ?? 0) + count
      const featureReason = featureAbstention(row, requiredFeatureKinds)
      const member = {
        routeKey: subject.routeKey,
        destination: subject.destination,
        asset: subject.asset,
        subject: subjectKey,
        stageScope: row.stageScope,
        holderCommitment: row.holderCommitment,
        qRaw: row.qRaw,
        qUnit: row.qUnit ?? null,
        baselineBlock: String(row.baselineBlock),
        baselineBlockHash: row.baselineBlockHash,
        plannedHorizonHours: row.plannedHorizonHours,
        issueClusterSha256: row.issueClusterSha256,
        analysisCellKey: row.analysisCellKey ?? null,
        issueSha256: row.issueSha256,
        scoreSha256: row.scoreSha256,
        issueAtUtc: row.issueAtUtc,
        targetAtUtc: row.targetAtUtc,
        observedAtUtc: row.observedAtUtc,
        scoreAtUtc: row.scoreAtUtc ?? null,
        baseline: row.baseline,
        outcomeStatus: row.outcome.status,
        outcomeReason: row.outcome.reason ?? null,
        classification: classification(row),
        correlatedEvidenceVeto: null,
        featureAbstention: featureReason,
        splitAbstention: splitAbstention(row, panel, featureReason),
      }
      previous.member = member
      members.push(member)
    }
  }
  const continuityBreaks = new Map()
  for (const cell of seenCells.values()) {
    check(cell.primary === 1 && cell.member, 'analysis_primary_invalid')
    const measuredOutcomes = new Set(
      cell.rows.filter((row) => MEASURED.has(row.outcome.status)).map((row) => row.outcome.status),
    )
    const measuredBaselines = new Set(
      cell.rows.filter((row) => MEASURED.has(row.baseline)).map((row) => row.baseline),
    )
    const baselineAnchors = new Set(
      cell.rows.map((row) => `${String(row.baselineBlock)}:${row.baselineBlockHash.toLowerCase()}`),
    )
    const targets = new Set(cell.rows.map((row) => row.targetAtUtc))
    const nonprimaryAttrition = cell.rows.some(
      (row) =>
        row.analysisPrimaryForCell !== true &&
        row.outcome.status === 'censored' &&
        row.outcome.reason === 'holder_attrition',
    )
    const veto = nonprimaryAttrition
      ? 'correlated_holder_attrition'
      : measuredOutcomes.size > 1
        ? 'correlated_outcome_conflict'
        : measuredBaselines.size > 1
          ? 'correlated_baseline_conflict'
          : baselineAnchors.size > 1
            ? 'correlated_baseline_anchor_conflict'
            : targets.size > 1
              ? 'correlated_target_conflict'
              : null
    if (veto) {
      cell.member.classification = veto
      cell.member.splitAbstention = veto
      cell.member.correlatedEvidenceVeto = veto
    }
    if (
      veto ||
      (cell.member.outcomeStatus === 'censored' && cell.member.outcomeReason === 'holder_attrition')
    ) {
      const affected = veto
        ? cell.rows
        : cell.rows.filter((row) => row.analysisPrimaryForCell === true)
      const breakAt = Math.min(...cell.rows.map((row) => utcMs(row.targetAtUtc)))
      for (const row of affected) {
        if (!row.holderCommitment) continue
        const key = trajectoryKey(row)
        continuityBreaks.set(key, Math.min(continuityBreaks.get(key) ?? Infinity, breakAt))
      }
    }
  }
  classifyTrajectories(members, continuityBreaks)
  const cells = new Map()
  for (const member of members) {
    const key = JSON.stringify([
      member.subject,
      member.stageScope,
      member.qRaw,
      member.plannedHorizonHours,
    ])
    const cell = cells.get(key) ?? {
      routeKey: member.routeKey,
      destination: member.destination,
      asset: member.asset,
      subject: member.subject,
      stageScope: member.stageScope,
      qRaw: member.qRaw,
      plannedHorizonHours: member.plannedHorizonHours,
      rows: [],
    }
    cell.rows.push(member)
    cells.set(key, cell)
  }
  const split = makeSplit(members)
  const overall = tally(members)
  const phaseClusters =
    split.status === 'descriptive_split_only'
      ? Object.fromEntries(
          ['fit', 'calibration', 'holdout'].map((phase) => [
            phase,
            new Set(split[phase].issueClusters),
          ]),
        )
      : null
  return {
    scope: RISK_SET_SCOPE,
    version: HOLDER_EXIT_RISK_SET_VERSION,
    panelScope: panel.scope,
    manifestSha256: manifest.sha256,
    sourceVerification: panel.sourceVerification,
    holderExecutableExit: false,
    forecastValidated: false,
    statisticalIndependenceValidated: false,
    durationValidated: false,
    summary: {
      routeGroups: 25,
      exactSubjects: 67,
      rawRows,
      duplicateCorrelatedRows: duplicateRows,
      ...overall,
      sourceFeatureAbstentions,
      featureAbstainedPrimaryRows: members.filter((member) => member.featureAbstention).length,
      splitAbstainedPrimaryRows: members.filter((member) => member.splitAbstention).length,
    },
    cells: [...cells.values()].map(({ rows, ...cell }) => {
      const phases = phaseClusters
        ? Object.fromEntries(
            ['fit', 'calibration', 'holdout'].map((phase) => [
              phase,
              tally(
                rows.filter(
                  (row) =>
                    row.splitAbstention === null &&
                    phaseClusters[phase].has(row.issueClusterSha256),
                ),
              ),
            ]),
          )
        : null
      return {
        ...cell,
        holderCommitments: [...new Set(rows.map((row) => row.holderCommitment).filter(Boolean))],
        ...tally(rows),
        splitCandidateRows: rows.filter((row) => row.splitAbstention === null).length,
        validation: phases
          ? {
              status: 'descriptive_only',
              ...phases,
              twentyClusterUpperBoundInEachPhase: [
                phases.fit,
                phases.calibration,
                phases.holdout,
              ].every((phase) => phase.issueClusterUpperBound >= 20),
              alertHoldoutUpperBoundFloor:
                phases.holdout.onsetClusterUpperBound >= 20 &&
                phases.holdout.controlClusterUpperBound >= 20,
              durationHoldoutUpperBoundFloor:
                phases.holdout.sampledRecoveryClusterUpperBound >= 20 &&
                phases.holdout.ongoingImpairmentClusterUpperBound >= 20,
              forecastEligible: false,
            }
          : { status: 'abstain', reason: split.reason, forecastEligible: false },
      }
    }),
    members,
    split,
    eligibility: {
      fit: split.fit === null ? 'abstain' : 'descriptive_only',
      calibration: split.calibration === null ? 'abstain' : 'descriptive_only',
      holdout: split.holdout === null ? 'abstain' : 'descriptive_only',
      predictiveHolderAlert: false,
      restrictionDuration: false,
      reasons: [
        ...(overall.onsetClusterUpperBound === 0 ? ['no_callable_to_impaired_onsets'] : []),
        ...(overall.sampledRecoveryClusterUpperBound === 0 ? ['no_sampled_recoveries'] : []),
        ...(split.exactClockCandidateClusters === 0
          ? ['no_independently_witnessed_issue_score_clocks']
          : []),
        'no_physical_independence_proof',
        'no_untouched_holdout_model_comparison',
        'no_calibrated_duration_coverage',
      ],
    },
  }
}
