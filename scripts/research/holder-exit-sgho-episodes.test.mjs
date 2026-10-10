import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { FIXED_Q_RAW } from './carry-public-sgho-fixed-q-v2-issue.mjs'
import { HORIZONS_HOURS, ROUTE } from './carry-public-sgho-exit-common.mjs'
import { buildSghoEpisodes, sghoBoardSubjects } from './holder-exit-sgho-episodes.mjs'

const sha = (value) => createHash('sha256').update(value).digest('hex')
const seal = (payload) => ({ ...payload, sha256: sha(JSON.stringify(payload)) })
const reseal = (row, changes) =>
  seal({
    ...Object.fromEntries(Object.entries(row).filter(([field]) => field !== 'sha256')),
    ...changes,
  })
const addHours = (utc, hours) => new Date(Date.parse(utc) + hours * 3_600_000).toISOString()
const key = `${ROUTE.routeKey}\0${ROUTE.destination}\0${ROUTE.asset}`
const holder = `0x${'1'.repeat(40)}`
const baselineAt = '2026-10-04T00:00:00.000Z'
const v1At = '2026-10-04T00:15:00.000Z'
const v2At = '2026-10-04T00:30:00.000Z'
const blockHash = `0x${'a'.repeat(64)}`
const manifest = {
  subjects: [{ route_key: ROUTE.routeKey, destination: ROUTE.destination, asset: ROUTE.asset }],
}
const plans = (atUtc) =>
  HORIZONS_HOURS.map((horizonHours) => ({
    horizonHours,
    targetAtUtc: addHours(atUtc, horizonHours),
    captureDeadlineUtc: addHours(atUtc, horizonHours + 2),
  }))

function v1Issue({ selectedHolder = holder, fixedBaseline = 'success' } = {}) {
  return seal({
    study: 'carry_public_sgho_exit_issue_v1',
    sequence: 1,
    routeKey: ROUTE.routeKey,
    destination: ROUTE.destination,
    originalAsset: ROUTE.asset,
    issuedAtUtc: v1At,
    baseline: { targetBlock: '100', targetHash: blockHash, targetBlockAt: baselineAt },
    candidate: { holder: selectedHolder },
    targets: plans(v1At),
    cases: [
      {
        label: 'fixed',
        assetsRaw: FIXED_Q_RAW,
        status: selectedHolder ? 'measured' : 'unavailable',
        reason: selectedHolder ? null : 'baseline_measurement_unavailable',
        measurement: selectedHolder ? { baselineStatus: fixedBaseline } : null,
      },
      {
        label: 'covered',
        assetsRaw: '2000000000000000000',
        status: selectedHolder ? 'measured' : 'unavailable',
        reason: selectedHolder ? null : 'baseline_measurement_unavailable',
        measurement: selectedHolder ? { baselineStatus: 'covered_revert' } : null,
      },
      {
        label: 'unavailable',
        assetsRaw: '3000000000000000000',
        status: 'unavailable',
        reason: 'baseline_measurement_unavailable',
        measurement: null,
      },
      ...[1, 2, 3].map((n) => ({
        label: `omitted_${n}`,
        assetsRaw: null,
        status: 'omitted',
        reason: 'duplicate_q',
        measurement: null,
      })),
    ],
  })
}

function v1Score(issue, firstOutcome = 'simulated_withdraw_success', { late = false } = {}) {
  const plan = issue.targets[0]
  return seal({
    study: 'carry_public_sgho_exit_score_v1',
    sequence: 1,
    issueSequence: issue.sequence,
    issueSha256: issue.sha256,
    routeKey: ROUTE.routeKey,
    destination: ROUTE.destination,
    originalAsset: ROUTE.asset,
    holder: issue.candidate.holder,
    horizonHours: 1,
    targetAtUtc: plan.targetAtUtc,
    captureDeadlineUtc: plan.captureDeadlineUtc,
    scoredAtUtc: late ? addHours(v1At, 4) : addHours(v1At, 1.5),
    onTime: !late,
    target: late ? null : { targetHash: blockHash, targetBlockAt: plan.targetAtUtc },
    cases: issue.cases.map((entry, i) => ({
      label: entry.label,
      assetsRaw: entry.assetsRaw,
      status:
        i === 0 && issue.candidate.holder ? (late ? 'unavailable' : 'measured') : 'ineligible',
      reason: late && i === 0 ? 'capture_window_missed' : i === 0 ? null : 'baseline_not_success',
      outcome: i === 0 && !late ? firstOutcome : null,
    })),
  })
}

function v2Issue(parent, baselineStatus = 'success') {
  return seal({
    study: 'carry_public_sgho_fixed_q_issue_v2',
    sequence: 1,
    v1IssueSequence: parent.sequence,
    v1IssueSha256: parent.sha256,
    routeKey: ROUTE.routeKey,
    destination: ROUTE.destination,
    originalAsset: ROUTE.asset,
    holder: parent.candidate.holder,
    assetsRaw: FIXED_Q_RAW,
    issuedAtUtc: v2At,
    baselineStatus,
    targets: plans(v2At),
  })
}

function v2Score(issue, outcome = 'simulated_withdraw_success', { censored = false } = {}) {
  const plan = issue.targets[0]
  const transition = censored
    ? 'censored'
    : outcome === 'simulated_withdraw_success'
      ? issue.baselineStatus === 'success'
        ? 'remained_exitable'
        : 'simulated_recovery'
      : ['holder_shares_zero', 'preview_share_gap'].includes(outcome)
        ? 'holder_attrition'
        : issue.baselineStatus === 'success'
          ? 'lost_exitability'
          : 'still_reverting'
  return seal({
    study: 'carry_public_sgho_fixed_q_score_v2',
    sequence: 1,
    issueSequence: issue.sequence,
    issueSha256: issue.sha256,
    routeKey: ROUTE.routeKey,
    destination: ROUTE.destination,
    originalAsset: ROUTE.asset,
    holder: issue.holder,
    assetsRaw: FIXED_Q_RAW,
    horizonHours: 1,
    targetAtUtc: plan.targetAtUtc,
    captureDeadlineUtc: plan.captureDeadlineUtc,
    scoredAtUtc: censored ? addHours(v2At, 4) : addHours(v2At, 1.5),
    status: censored ? 'censored' : 'measured',
    target: censored ? null : { targetHash: blockHash, targetBlockAt: plan.targetAtUtc },
    outcome: censored ? null : outcome,
    transition,
  })
}

const build = ({
  v1Issues = [],
  v1Scores = [],
  v2Issues = [],
  v2Scores = [],
  nowMs = Date.parse('2026-10-04T05:00:00.000Z'),
  featuresBySubject = new Map(),
  selectAsOfFeatures = () => ({ featureRefs: [], featureAbstentions: {} }),
} = {}) =>
  buildSghoEpisodes({
    manifest,
    v1Issues,
    v1Scores,
    v2Issues,
    v2Scores,
    nowMs,
    featuresBySubject,
    selectAsOfFeatures,
  })

test('exact frozen subject and V1 holder/Q rows; no-holder and omitted Q stay diagnostics', () => {
  assert.equal(sghoBoardSubjects(manifest).get(key), manifest.subjects[0])
  assert.throws(
    () => sghoBoardSubjects({ subjects: [{ ...manifest.subjects[0], asset: holder }] }),
    /frozen_subject_invalid/,
  )
  const parent = v1Issue()
  const projected = build({ v1Issues: [parent], v1Scores: [v1Score(parent)] })
  assert.equal(projected.episodes.length, 15)
  assert.equal(projected.diagnostics.get(key).omittedQCases, 3)
  assert.equal(projected.diagnostics.get(key).scoredTargets, 1)
  assert.equal(projected.episodes[0].issueClusterSha256, parent.sha256)
  assert.equal(projected.episodes[0].holderCommitment, sha(`${ROUTE.destination}:${holder}`))
  assert.equal(projected.episodes[0].qUnit, 'asset_raw')
  assert.equal(projected.episodes[0].fullRoutePaidProofSha256, null)
  assert.equal(projected.episodes[0].forecastEligible, false)
  const noHolder = v1Issue({ selectedHolder: null })
  const empty = build({ v1Issues: [noHolder] })
  assert.equal(empty.episodes.length, 0)
  assert.equal(empty.diagnostics.get(key).noHolderIssues, 1)
})

test('V1 issue and score stay hidden until their local clocks, while hidden scores validate', () => {
  const parent = v1Issue()
  const scored = v1Score(parent)
  const selected = []
  const at = (nowMs, v1Scores = [scored]) =>
    build({
      v1Issues: [parent],
      v1Scores,
      nowMs,
      selectAsOfFeatures: (_features, _subject, issue) => {
        selected.push(issue.issuedAtUtc)
        return { featureRefs: [], featureAbstentions: {} }
      },
    })
  const beforeIssue = at(Date.parse(v1At) - 1)
  assert.equal(beforeIssue.episodes.length, 0)
  assert.equal(beforeIssue.diagnostics.get(key).issues, 0)
  assert.equal(beforeIssue.diagnostics.get(key).omittedQCases, 0)
  assert.equal(beforeIssue.diagnostics.get(key).scoredTargets, 0)
  assert.deepEqual(selected, [])

  const atIssue = at(Date.parse(v1At))
  assert.equal(atIssue.episodes.length, 15)
  assert.equal(atIssue.diagnostics.get(key).issues, 1)
  assert.equal(atIssue.diagnostics.get(key).scoredTargets, 0)
  assert.equal(atIssue.episodes[0].outcome.status, 'pending')
  const beforeScore = at(Date.parse(scored.scoredAtUtc) - 1)
  assert.equal(beforeScore.episodes[0].scoreSha256, null)
  assert.equal(beforeScore.episodes[0].observedAtUtc, null)
  assert.equal(beforeScore.episodes[0].rawScoreStatus, null)
  assert.equal(beforeScore.episodes[0].rawScoreOutcome, null)
  assert.equal(beforeScore.diagnostics.get(key).scoredTargets, 0)
  const atScore = at(Date.parse(scored.scoredAtUtc))
  assert.equal(atScore.episodes[0].outcome.status, 'simulated_callable')
  assert.equal(atScore.episodes[0].scoreSha256, scored.sha256)
  assert.equal(atScore.diagnostics.get(key).scoredTargets, 1)
  assert.equal(atScore.episodes[0].issueClock, 'local_operator_clock_unwitnessed')
  assert.equal(atScore.episodes[0].forecastEligible, false)
  assert.throws(
    () => at(Date.parse(v1At) - 1, [reseal(scored, { scoredAtUtc: 'invalid' })]),
    /clock_invalid/,
  )
})

test('V2 attaches to its V1 cluster without replacing rows or copying V1 target clocks', () => {
  const parent = v1Issue()
  const child = v2Issue(parent)
  const projected = build({
    v1Issues: [parent],
    v1Scores: [v1Score(parent)],
    v2Issues: [child],
    v2Scores: [v2Score(child)],
  })
  assert.equal(projected.episodes.length, 15)
  const v1 = projected.episodes[0]
  const v2 = projected.diagnostics.get(key).linkedV2Children[0]
  assert.equal(v1.targetAtUtc, addHours(v1At, 1))
  assert.equal(v2.targets[0].targetAtUtc, addHours(v2At, 1))
  assert.equal(v2.v1IssueSha256, parent.sha256)
  assert.equal(v2.issueClusterSha256, parent.sha256)
  assert.equal(v2.qUnit, 'asset_raw')
  assert.equal(v2.targets[0].outcome.status, 'simulated_callable')
  assert.equal(v2.targets[0].causalTransition, null)
  assert.equal(projected.diagnostics.get(key).linkedV2ScoredTargets, 1)
})

test('V2 child and score wait for child and score clocks without losing parent integrity', () => {
  const parent = v1Issue()
  const child = v2Issue(parent)
  const scored = v2Score(child)
  const selected = []
  const at = (nowMs, v2Scores = [scored]) =>
    build({
      v1Issues: [parent],
      v2Issues: [child],
      v2Scores,
      nowMs,
      selectAsOfFeatures: (_features, _subject, issue) => {
        selected.push(issue.issuedAtUtc)
        return { featureRefs: [], featureAbstentions: {} }
      },
    })
  const beforeChild = at(Date.parse(v2At) - 1)
  assert.deepEqual(selected, [v1At])
  assert.equal(beforeChild.diagnostics.get(key).linkedV2Issues, 0)
  assert.equal(beforeChild.diagnostics.get(key).linkedV2ScoredTargets, 0)
  assert.deepEqual(beforeChild.diagnostics.get(key).linkedV2Children, [])

  selected.length = 0
  const atChild = at(Date.parse(v2At))
  assert.deepEqual(selected, [v1At, v2At])
  assert.equal(atChild.diagnostics.get(key).linkedV2Issues, 1)
  assert.equal(
    atChild.diagnostics.get(key).linkedV2Children[0].targets[0].outcome.status,
    'pending',
  )
  const beforeScore = at(Date.parse(scored.scoredAtUtc) - 1).diagnostics.get(key)
  assert.equal(beforeScore.linkedV2ScoredTargets, 0)
  assert.equal(beforeScore.linkedV2Children[0].targets[0].scoreSha256, null)
  assert.equal(beforeScore.linkedV2Children[0].targets[0].rawScoreOutcome, null)
  assert.equal(beforeScore.linkedV2Children[0].targets[0].observedAtUtc, null)
  const atScore = at(Date.parse(scored.scoredAtUtc)).diagnostics.get(key)
  assert.equal(atScore.linkedV2ScoredTargets, 1)
  assert.equal(atScore.linkedV2Children[0].targets[0].scoreSha256, scored.sha256)
  assert.equal(atScore.linkedV2Children[0].targets[0].outcome.status, 'simulated_callable')
  assert.throws(
    () => at(Date.parse(v2At) - 1, [reseal(scored, { transition: 'lost_exitability' })]),
    /v2_transition_invalid/,
  )
  assert.throws(
    () =>
      build({
        v1Issues: [parent],
        v2Issues: [reseal(child, { v1IssueSha256: sha('wrong') })],
        nowMs: Date.parse(v2At) - 1,
      }),
    /v2_parent_binding_invalid/,
  )
})

test('covered baseline and covered future reverts stay inconclusive, never causal recovery', () => {
  const parent = v1Issue({ fixedBaseline: 'covered_revert' })
  const child = v2Issue(parent, 'covered_revert')
  const projected = build({ v1Issues: [parent], v2Issues: [child], v2Scores: [v2Score(child)] })
  assert.equal(projected.episodes[0].baseline, 'inconclusive')
  assert.equal(projected.episodes[0].outcome.status, 'not_at_risk')
  const sidecar = projected.diagnostics.get(key).linkedV2Children[0].targets[0]
  assert.equal(sidecar.rawSourceTransition, 'simulated_recovery')
  assert.equal(sidecar.baseline, 'inconclusive')
  assert.equal(sidecar.outcome.status, 'not_at_risk')
  assert.equal(sidecar.causalTransition, null)

  const callable = v1Issue()
  const v1Revert = build({
    v1Issues: [callable],
    v1Scores: [v1Score(callable, 'withdraw_revert_cause_unknown')],
  })
  assert.deepEqual(v1Revert.episodes[0].outcome, {
    status: 'inconclusive',
    reason: 'revert_cause_unknown',
  })
  const callableChild = v2Issue(callable)
  const v2Revert = build({
    v1Issues: [callable],
    v2Issues: [callableChild],
    v2Scores: [v2Score(callableChild, 'withdraw_revert_cause_unknown')],
  })
  assert.equal(
    v2Revert.diagnostics.get(key).linkedV2Children[0].targets[0].outcome.status,
    'inconclusive',
  )
})

test('pending, missing, missed capture and holder attrition remain distinct', () => {
  const parent = v1Issue()
  assert.equal(
    build({ v1Issues: [parent], nowMs: Date.parse('2026-10-04T01:45:00.000Z') }).episodes[0].outcome
      .status,
    'pending',
  )
  assert.equal(
    build({ v1Issues: [parent], nowMs: Date.parse('2026-10-05T00:00:00.000Z') }).episodes[0].outcome
      .status,
    'missing',
  )
  assert.deepEqual(
    build({ v1Issues: [parent], v1Scores: [v1Score(parent, undefined, { late: true })] })
      .episodes[0].outcome,
    {
      status: 'censored',
      reason: 'capture_window_missed',
    },
  )
  assert.deepEqual(
    build({ v1Issues: [parent], v1Scores: [v1Score(parent, 'holder_shares_zero')] }).episodes[0]
      .outcome,
    { status: 'censored', reason: 'holder_attrition' },
  )
  const child = v2Issue(parent)
  assert.equal(
    build({
      v1Issues: [parent],
      v2Issues: [child],
      v2Scores: [v2Score(child, undefined, { censored: true })],
    }).diagnostics.get(key).linkedV2Children[0].targets[0].outcome.status,
    'censored',
  )
})

test('parent sequence, SHA, holder, baseline and score bindings reject forgeries', () => {
  const parent = v1Issue()
  const child = v2Issue(parent)
  const score = v2Score(child)
  const changed = (row, updates) =>
    seal({ ...Object.fromEntries(Object.entries(row).filter(([k]) => k !== 'sha256')), ...updates })
  assert.throws(
    () => build({ v1Issues: [parent], v2Issues: [changed(child, { v1IssueSequence: 2 })] }),
    /v2_parent_binding_invalid/,
  )
  assert.throws(
    () =>
      build({ v1Issues: [parent], v2Issues: [changed(child, { v1IssueSha256: sha('wrong') })] }),
    /v2_parent_binding_invalid/,
  )
  assert.throws(
    () =>
      build({ v1Issues: [parent], v2Issues: [changed(child, { holder: `0x${'2'.repeat(40)}` })] }),
    /v2_parent_binding_invalid/,
  )
  assert.throws(
    () =>
      build({
        v1Issues: [parent],
        v2Issues: [changed(child, { baselineStatus: 'covered_revert' })],
      }),
    /v2_baseline_disagreement/,
  )
  assert.throws(() => build({ v1Issues: [parent], v2Scores: [score] }), /score_binding_invalid/)
  assert.throws(
    () =>
      build({
        v1Issues: [parent],
        v2Issues: [child],
        v2Scores: [changed(score, { issueSha256: sha('wrong') })],
      }),
    /score_binding_invalid/,
  )
  assert.throws(
    () => build({ v1Issues: [parent], v2Issues: [child, child] }),
    /issue_identity_invalid/,
  )
  assert.throws(
    () =>
      build({ v1Issues: [parent], v1Scores: [changed(v1Score(parent), { horizonHours: 999 })] }),
    /v1_orphan_score/,
  )
  assert.throws(
    () =>
      build({
        v1Issues: [parent],
        v2Issues: [child],
        v2Scores: [changed(score, { horizonHours: 999 })],
      }),
    /v2_orphan_score/,
  )
})

test('as-of features use V1 and V2 issue times against the shared baseline', () => {
  const parent = v1Issue()
  const child = v2Issue(parent)
  const features = [{ kind: 'aggregate_cash' }]
  const seen = []
  const projected = build({
    v1Issues: [parent],
    v2Issues: [child],
    featuresBySubject: new Map([[key, features]]),
    selectAsOfFeatures: (received, subject, issue, baseline) => {
      assert.equal(received, features)
      assert.equal(subject, manifest.subjects[0])
      assert.equal(baseline.baseline.targetBlock, '100')
      seen.push(issue.issuedAtUtc)
      return {
        featureRefs: [{ kind: 'aggregate_cash', at: issue.issuedAtUtc }],
        featureAbstentions: {},
      }
    },
  })
  assert.deepEqual(seen, [v1At, v2At])
  assert.equal(projected.episodes[0].featureRefs[0].at, v1At)
  assert.equal(projected.diagnostics.get(key).linkedV2Children[0].featureRefs[0].at, v2At)
})
