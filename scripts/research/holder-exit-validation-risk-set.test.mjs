import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { buildHolderExitValidationRiskSet } from './holder-exit-validation-risk-set.mjs'

const hash = (value) => createHash('sha256').update(value).digest('hex')
const address = (n) => `0x${n.toString(16).padStart(40, '0')}`
const at = (ms) => new Date(ms).toISOString()
const DAY = 86_400_000
const HOUR = 3_600_000
const START = Date.parse('2026-01-01T00:00:00.000Z')

function fixture() {
  const manifestSubjects = Array.from({ length: 67 }, (_, index) => ({
    route_key: `route_${Math.floor((index * 25) / 67)}`,
    destination: address(index + 1),
    asset: address(10_000 + index),
  }))
  const manifest = {
    subjects: manifestSubjects,
    sha256: hash(JSON.stringify(manifestSubjects)),
  }
  const subjects = manifestSubjects.map((subject) => ({
    routeKey: subject.route_key,
    destination: subject.destination,
    asset: subject.asset,
    stageScope: 'direct_fixture_withdraw_eth_call',
    episodes: [],
  }))
  const panel = {
    scope: 'offline_frozen_25_67_holder_episode_panel',
    manifestSha256: manifest.sha256,
    sourceVerification: 'offline_sealed_replay',
    subjects,
  }
  return { manifest, panel }
}

function row(index, overrides = {}) {
  const issueMs = START + index * 10 * DAY
  return {
    subject: `route_0\0${address(1)}\0${address(10_000)}`,
    stageScope: 'direct_fixture_withdraw_eth_call',
    lane: 'v3',
    issueClusterSha256: hash(`cluster-${index}`),
    issueSha256: hash(`issue-${index}`),
    scoreSha256: hash(`score-${index}`),
    holderCommitment: hash(`holder-${index}`),
    qRaw: '1000000',
    baselineBlock: '100',
    baselineBlockHash: `0x${'1'.repeat(64)}`,
    plannedHorizonHours: 1,
    issueAtUtc: at(issueMs),
    issueClock: 'independently_witnessed_utc',
    featureAvailabilityClock: 'independently_witnessed_utc',
    targetAtUtc: at(issueMs + HOUR),
    deadlineAtUtc: at(issueMs + 3 * HOUR),
    observedAtUtc: at(issueMs + HOUR),
    scoreAtUtc: at(issueMs + 2 * HOUR),
    scoreClock: 'independently_witnessed_utc',
    baseline: 'simulated_callable',
    outcome: { status: 'simulated_callable', reason: null },
    featureRefs: [],
    featureAbstentions: {},
    analysisPrimaryForCell: true,
    ...overrides,
  }
}

const build = (value) => buildHolderExitValidationRiskSet(value)

test('rejects a wrong panel scope, manifest digest, subject identity, and missing primary', () => {
  const { manifest, panel } = fixture()
  assert.throws(
    () => build({ manifest, panel: { ...panel, scope: 'other' } }),
    /panel_scope_invalid/,
  )
  assert.throws(
    () => build({ manifest: { ...manifest, sha256: hash('wrong') }, panel }),
    /manifest_invalid/,
  )
  const wrong = structuredClone(panel)
  wrong.subjects[0].asset = address(999_999)
  assert.throws(() => build({ manifest, panel: wrong }), /subject_identity_invalid/)
  panel.subjects[0].episodes.push(row(0, { analysisPrimaryForCell: false }))
  assert.throws(() => build({ manifest, panel }), /analysis_primary_invalid/)
})

test('deduplicates correlated V1/V2/V3 rows and separates onset, control, and recovery samples', () => {
  const { manifest, panel } = fixture()
  const onset = row(0, { outcome: { status: 'simulated_impaired', reason: null } })
  panel.subjects[0].episodes.push(
    { ...onset, lane: 'v1', issueSha256: hash('v1'), analysisPrimaryForCell: undefined },
    { ...onset, lane: 'v2', issueSha256: hash('v2'), analysisPrimaryForCell: false },
    onset,
    row(1),
    row(2, {
      baseline: 'simulated_impaired',
      outcome: { status: 'simulated_callable', reason: null },
    }),
  )
  const got = build({ manifest, panel })
  assert.equal(got.summary.rawRows, 5)
  assert.equal(got.summary.duplicateCorrelatedRows, 2)
  assert.equal(got.summary.primaryRows, 3)
  assert.equal(got.summary.onsetRows, 1)
  assert.equal(got.summary.controlRows, 1)
  assert.equal(got.summary.baseline_impaired_then_callableRows, 1)
  assert.equal(got.summary.issueClusterUpperBound, 3)
  assert.equal(got.durationValidated, false)
  assert.equal(got.forecastValidated, false)
  assert.equal(got.cells.length, 1)
  assert.equal(got.cells[0].holderCommitments.length, 3)
})

test('late feature availability, missed capture, and holder attrition stay in abstention denominators', () => {
  const { manifest, panel } = fixture()
  const late = row(0)
  late.featureRefs = [
    {
      kind: 'gross_flow',
      receiptSha256: hash('feature'),
      sourceAt: at(START),
      firstLocalReceiptAt: at(START + HOUR),
      completedAtUtc: at(START + HOUR),
    },
  ]
  panel.subjects[0].episodes.push(
    late,
    row(1, {
      scoreSha256: null,
      observedAtUtc: null,
      scoreAtUtc: null,
      outcome: { status: 'censored', reason: 'capture_window_missed' },
    }),
    row(2, {
      scoreSha256: null,
      observedAtUtc: null,
      scoreAtUtc: null,
      outcome: { status: 'censored', reason: 'holder_attrition' },
    }),
  )
  const got = build({ manifest, panel, requiredFeatureKinds: ['gross_flow'] })
  assert.equal(got.summary.capture_window_missedRows, 1)
  assert.equal(got.summary.holder_attritionRows, 1)
  assert.equal(got.summary.featureAbstainedPrimaryRows, 3)
  assert.equal(got.split.abstentions.late_feature_availability, 1)
  assert.equal(got.split.abstentions.required_feature_missing, 2)
  assert.equal(got.split.status, 'abstained')
  assert.equal(got.split.holdout, null)
})

test('required direct gross flow needs ancestry and a witnessed feature clock', () => {
  const { manifest, panel } = fixture()
  const flow = {
    kind: 'gross_supplier_withdraw_24h',
    receiptSha256: hash('flow'),
    sourceAt: at(START - 2 * HOUR),
    firstLocalReceiptAt: at(START - HOUR),
    completedAtUtc: at(START - HOUR),
    sourceBaselineAncestry: 'unproven',
    clockBasis: 'local_operator_clock_unwitnessed',
  }
  panel.subjects[0].episodes.push(
    row(0, { featureRefs: [flow] }),
    row(1, {
      featureRefs: [{ ...flow, sourceBaselineAncestry: 'two_origin_attested_parent_links' }],
    }),
    row(2, {
      featureRefs: [
        {
          ...flow,
          sourceBaselineAncestry: 'two_origin_attested_parent_links',
          clockBasis: 'independently_witnessed_utc',
        },
      ],
    }),
    row(3, {
      featureRefs: [
        {
          ...flow,
          sourceBaselineAncestry: 'cryptographically_verified_parent_links',
          clockBasis: 'independently_witnessed_utc',
        },
      ],
    }),
    row(4, {
      featureRefs: [{ ...flow, sourceBaselineAncestry: 'cryptographically_verified_parent_links' }],
    }),
  )
  const result = build({
    manifest,
    panel,
    requiredFeatureKinds: ['gross_supplier_withdraw_24h'],
  })
  assert.equal(result.split.abstentions.source_baseline_ancestry_unproven, 3)
  assert.equal(result.split.abstentions.feature_clock_unwitnessed, 1)
  assert.equal(result.split.exactClockCandidateRows, 1)
  assert.equal(result.forecastValidated, false)
})

test('zero onsets and unwitnessed panel clocks cannot produce validation eligibility', () => {
  const { manifest, panel } = fixture()
  panel.subjects[0].episodes.push(
    row(0, {
      issueClock: 'local_operator_clock_unwitnessed',
      featureAvailabilityClock: 'local_operator_clock_unwitnessed',
      scoreAtUtc: null,
    }),
    row(1, {
      issueClock: 'local_operator_clock_unwitnessed',
      featureAvailabilityClock: 'local_operator_clock_unwitnessed',
      scoreAtUtc: null,
    }),
  )
  const got = build({ manifest, panel })
  assert.equal(got.summary.onsetRows, 0)
  assert.equal(got.summary.controlRows, 2)
  assert.equal(got.split.exactClockCandidateClusters, 0)
  assert.equal(got.split.abstentions.issue_or_feature_clock_unwitnessed, 2)
  assert.equal(got.eligibility.holdout, 'abstain')
  assert.equal(got.eligibility.predictiveHolderAlert, false)
  assert.ok(got.eligibility.reasons.includes('no_callable_to_impaired_onsets'))
  assert.ok(got.eligibility.reasons.includes('no_independently_witnessed_issue_score_clocks'))
})

test('RFC3161 evidence under a caller-supplied pin cannot enter the independent-clock split', () => {
  const { manifest, panel } = fixture()
  panel.subjects[0].episodes.push(
    row(0, {
      issueClock: 'rfc3161_verified_under_supplied_pin',
    }),
    row(1, {
      scoreClock: 'rfc3161_verified_under_supplied_pin',
    }),
  )
  const got = build({ manifest, panel })
  assert.equal(got.split.exactClockCandidateRows, 0)
  assert.equal(got.split.exactClockCandidateClusters, 0)
  assert.equal(got.split.abstentions.issue_or_feature_clock_unwitnessed, 1)
  assert.equal(got.split.abstentions.score_clock_unwitnessed, 1)
  assert.equal(got.eligibility.predictiveHolderAlert, false)
  assert.ok(got.eligibility.reasons.includes('no_independently_witnessed_issue_score_clocks'))
})

test('a holderless measured-looking screen cannot enter the validation split', () => {
  const { manifest, panel } = fixture()
  panel.subjects[0].episodes.push(
    row(0, {
      holderCommitment: null,
      outcome: { status: 'simulated_impaired', reason: null },
    }),
  )
  const got = build({ manifest, panel })
  assert.equal(got.summary.holderlessPrimaryRows, 1)
  assert.equal(got.summary.onsetRows, 0)
  assert.equal(got.summary.holder_unavailableRows, 1)
  assert.equal(got.split.abstentions.holder_unavailable, 1)
  assert.equal(got.split.exactClockCandidateClusters, 0)
})

test('a mechanically time-gated baseline and missing exact score clock do not become onset evidence', () => {
  const { manifest, panel } = fixture()
  panel.subjects[0].episodes.push(
    row(0, {
      baseline: 'time_gated',
      outcome: { status: 'not_at_risk', reason: 'cooldown_not_yet_eligible' },
    }),
    row(1, { scoreAtUtc: null }),
  )
  const got = build({ manifest, panel })
  assert.equal(got.summary.baselineNotMeasuredRows, 1)
  assert.equal(got.summary.onsetRows, 0)
  assert.equal(got.split.abstentions.baseline_not_measured, 1)
  assert.equal(got.split.abstentions.score_clock_missing, 1)
  assert.equal(got.cells[0].validation.status, 'abstain')
})

test('one holder trajectory counts first onset, sampled recovery, and relapse separately', () => {
  const { manifest, panel } = fixture()
  const sequence = [
    ['simulated_callable', 1],
    ['simulated_impaired', 4],
    ['simulated_callable', 24],
    ['simulated_callable', 48],
    ['simulated_impaired', 72],
  ]
  panel.subjects[0].episodes.push(
    ...sequence.map(([status, horizon]) =>
      row(0, {
        issueSha256: hash(`trajectory-${horizon}`),
        scoreSha256: hash(`trajectory-score-${horizon}`),
        plannedHorizonHours: horizon,
        targetAtUtc: at(START + horizon * HOUR),
        observedAtUtc: at(START + horizon * HOUR),
        deadlineAtUtc: at(START + (horizon + 2) * HOUR),
        scoreAtUtc: at(START + (horizon + 1) * HOUR),
        outcome: { status, reason: null },
      }),
    ),
  )
  const got = build({ manifest, panel })
  assert.equal(got.summary.controlRows, 1)
  assert.equal(got.summary.onsetRows, 1)
  assert.equal(got.summary.recovery_after_sampled_onsetRows, 1)
  assert.equal(got.summary.post_recovery_callableRows, 1)
  assert.equal(got.summary.relapse_after_recoveryRows, 1)
  assert.equal(got.summary.sampledRecoveryClusterUpperBound, 1)
  assert.equal(got.summary.issueClusterUpperBound, 1)
})

test('a later observation after holder attrition cannot restore the same episode control', () => {
  const { manifest, panel } = fixture()
  panel.subjects[0].episodes.push(
    row(0, {
      scoreSha256: null,
      observedAtUtc: null,
      scoreAtUtc: null,
      outcome: { status: 'censored', reason: 'holder_attrition' },
    }),
    row(0, {
      plannedHorizonHours: 4,
      issueSha256: hash('later-issue'),
      scoreSha256: hash('later-score'),
      targetAtUtc: at(START + 4 * HOUR),
      observedAtUtc: at(START + 4 * HOUR),
      deadlineAtUtc: at(START + 6 * HOUR),
      scoreAtUtc: at(START + 5 * HOUR),
    }),
  )
  const got = build({ manifest, panel })
  assert.equal(got.summary.holder_attritionRows, 1)
  assert.equal(got.summary.post_continuity_veto_unusableRows, 1)
  assert.equal(got.summary.controlRows, 0)
  assert.equal(got.split.abstentions.post_continuity_veto_unusable, 1)
})

test('a nonprimary attrition vetoes its cell and later same-baseline horizon, not a fresh baseline', () => {
  const { manifest, panel } = fixture()
  panel.subjects[0].episodes.push(
    row(0),
    row(0, {
      issueSha256: hash('attrited-reissue'),
      scoreSha256: hash('attrited-score'),
      analysisPrimaryForCell: undefined,
      outcome: { status: 'censored', reason: 'holder_attrition' },
    }),
    row(0, {
      issueSha256: hash('same-baseline-later'),
      scoreSha256: hash('same-baseline-later-score'),
      plannedHorizonHours: 4,
      targetAtUtc: at(START + 4 * HOUR),
      observedAtUtc: at(START + 4 * HOUR),
      deadlineAtUtc: at(START + 6 * HOUR),
      scoreAtUtc: at(START + 5 * HOUR),
    }),
    row(0, {
      issueSha256: hash('fresh-baseline-later'),
      scoreSha256: hash('fresh-baseline-later-score'),
      baselineBlock: '101',
      baselineBlockHash: `0x${'2'.repeat(64)}`,
      plannedHorizonHours: 8,
      targetAtUtc: at(START + 8 * HOUR),
      observedAtUtc: at(START + 8 * HOUR),
      deadlineAtUtc: at(START + 10 * HOUR),
      scoreAtUtc: at(START + 9 * HOUR),
    }),
  )
  const got = build({ manifest, panel })
  assert.equal(got.summary.correlated_holder_attritionRows, 1)
  assert.equal(got.summary.post_continuity_veto_unusableRows, 1)
  assert.equal(got.summary.controlRows, 1)
  assert.equal(got.summary.issueClusterUpperBound, 1)
})

test('conflicting measured sidecars veto their exact cell and its unresolved continuation', () => {
  const { manifest, panel } = fixture()
  panel.subjects[0].episodes.push(
    row(0),
    row(0, {
      issueSha256: hash('conflicting-reissue'),
      scoreSha256: hash('conflicting-score'),
      analysisPrimaryForCell: undefined,
      outcome: { status: 'simulated_impaired', reason: null },
    }),
    row(0, {
      plannedHorizonHours: 4,
      targetAtUtc: at(START + 4 * HOUR),
      observedAtUtc: at(START + 4 * HOUR),
      deadlineAtUtc: at(START + 6 * HOUR),
      scoreAtUtc: at(START + 5 * HOUR),
    }),
  )
  const got = build({ manifest, panel })
  assert.equal(got.summary.correlated_outcome_conflictRows, 1)
  assert.equal(got.summary.post_continuity_veto_unusableRows, 1)
  assert.equal(got.summary.controlRows, 0)
  assert.equal(got.split.abstentions.correlated_outcome_conflict, 1)
})

test('ongoing-impaired support includes post-onset still-impaired clusters', () => {
  const { manifest, panel } = fixture()
  panel.subjects[0].episodes.push(
    row(0, { outcome: { status: 'simulated_impaired', reason: null } }),
    row(0, {
      plannedHorizonHours: 4,
      targetAtUtc: at(START + 4 * HOUR),
      observedAtUtc: at(START + 4 * HOUR),
      deadlineAtUtc: at(START + 6 * HOUR),
      scoreAtUtc: at(START + 5 * HOUR),
      outcome: { status: 'simulated_impaired', reason: null },
    }),
  )
  const got = build({ manifest, panel })
  assert.equal(got.summary.still_impairedClusterUpperBound, 0)
  assert.equal(got.summary.still_impaired_after_onsetClusterUpperBound, 1)
  assert.equal(got.summary.ongoingImpairmentClusterUpperBound, 1)
})

test('exact-clock split is chronological, cluster-disjoint, and horizon embargoed', () => {
  const { manifest, panel } = fixture()
  for (let index = 0; index < 6; index++) panel.subjects[0].episodes.push(row(index))
  panel.subjects[0].episodes.push(
    row(0, {
      issueSha256: hash('same-cluster-second-horizon'),
      scoreSha256: hash('same-cluster-second-score'),
      plannedHorizonHours: 2,
      targetAtUtc: at(START + 2 * HOUR),
      observedAtUtc: at(START + 2 * HOUR),
      scoreAtUtc: at(START + 3 * HOUR),
    }),
  )
  const got = build({ manifest, panel })
  assert.equal(got.split.status, 'descriptive_split_only')
  assert.equal(got.split.exactClockCandidateClusters, 6)
  const split = [got.split.fit, got.split.calibration, got.split.holdout]
  assert.equal(new Set(split.flatMap((part) => part.issueClusters)).size, 6)
  assert.ok(
    Date.parse(split[0].lastScoreAtUtc) + got.split.embargoHours * HOUR <=
      Date.parse(split[1].firstIssueAtUtc),
  )
  assert.ok(
    Date.parse(split[1].lastScoreAtUtc) + got.split.embargoHours * HOUR <=
      Date.parse(split[2].firstIssueAtUtc),
  )
  assert.equal(got.forecastValidated, false)
  assert.equal(got.eligibility.holdout, 'descriptive_only')
  assert.equal(got.cells[0].validation.alertHoldoutUpperBoundFloor, false)
})

test('split abstains if the scheduled horizons overlap a chronological boundary', () => {
  const { manifest, panel } = fixture()
  for (let index = 0; index < 6; index++) {
    const issueMs = START + index * 2 * HOUR
    panel.subjects[0].episodes.push(
      row(index, {
        issueAtUtc: at(issueMs),
        targetAtUtc: at(issueMs + HOUR),
        observedAtUtc: at(issueMs + HOUR),
        deadlineAtUtc: at(issueMs + 3 * HOUR),
        scoreAtUtc: at(issueMs + 2 * HOUR),
      }),
    )
  }
  const got = build({ manifest, panel })
  assert.equal(got.split.status, 'abstained')
  assert.equal(got.split.reason, 'horizon_embargo_or_partition_failed')
  assert.equal(got.split.holdout, null)
})
