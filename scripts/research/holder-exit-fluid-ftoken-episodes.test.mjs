import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { ROUTES } from './carry-fluid-ftoken-payout.mjs'
import { buildFluidFTokenEpisodes } from './holder-exit-fluid-ftoken-episodes.mjs'

const hash = (value) => createHash('sha256').update(value).digest('hex')
const address = (n) => `0x${n.toString(16).padStart(40, '0')}`
const ISSUE_AT = '2026-10-04T00:10:00.000Z'
const BASELINE_AT = '2026-10-04T00:00:00.000Z'
const HOURS = [1, 4, 24, 48, 168]
const subjectKey = (route) => `${route.key}\0${route.vault}\0${route.asset}`
const manifest = {
  subjects: ROUTES.map((route) => ({
    route_key: route.key,
    destination: route.vault,
    asset: route.asset,
  })),
}

function issue(routeIndex = 0, sequence = 1) {
  const route = ROUTES[routeIndex]
  const issueMs = Date.parse(ISSUE_AT)
  return {
    study: 'fluid_ftoken_holder_issue_v1',
    routeIndex,
    routeKey: route.key,
    vault: route.vault,
    asset: route.asset,
    holder: address(123),
    sequence,
    sha256: hash(`issue-${routeIndex}-${sequence}`),
    issuedAtUtc: ISSUE_AT,
    baseline: {
      number: 100,
      hash: `0x${'a'.repeat(64)}`,
      timestamp: Date.parse(BASELINE_AT) / 1_000,
      atUtc: BASELINE_AT,
    },
    cases: [
      { label: 'holder_1pct', assetsRaw: '100', baseline: { status: 'success' } },
      { label: 'holder_10pct', assetsRaw: '1000', baseline: { status: 'evm_revert' } },
    ],
    targets: HOURS.map((horizonHours) => ({
      horizonHours,
      targetAtUtc: new Date(issueMs + horizonHours * 3_600_000).toISOString(),
      deadlineUtc: new Date(issueMs + (horizonHours + 2) * 3_600_000).toISOString(),
    })),
  }
}

function score(parent, status = 'measured', caseRows) {
  const target = parent.targets[0]
  return {
    study: 'fluid_ftoken_holder_score_v1',
    routeIndex: parent.routeIndex,
    routeKey: parent.routeKey,
    issueSequence: parent.sequence,
    issueSha256: parent.sha256,
    horizonHours: 1,
    targetAtUtc: target.targetAtUtc,
    scoredAtUtc: new Date(
      status === 'capture_window_missed'
        ? Date.parse(target.deadlineUtc) + 1_000
        : Date.parse(target.targetAtUtc) + 5 * 60_000,
    ).toISOString(),
    status,
    sha256: hash(`score-${parent.routeIndex}-${parent.sequence}`),
    block:
      status === 'capture_window_missed'
        ? null
        : {
            hash: `0x${'b'.repeat(64)}`,
            timestamp: Date.parse(target.targetAtUtc) / 1_000,
            atUtc: target.targetAtUtc,
          },
    finalizedDeadlineWitness:
      status === 'capture_window_missed'
        ? { timestamp: (Date.parse(target.deadlineUtc) + 1_000) / 1_000 }
        : null,
    cases:
      status === 'measured'
        ? (caseRows ??
          parent.cases.map((row) => ({
            label: row.label,
            assetsRaw: row.assetsRaw,
            entitlement: { status: 'covered' },
            outcome: { status: 'success' },
          })))
        : null,
  }
}

function run(issues = [], scores = [], nowMs = Date.parse('2026-10-04T01:30:00.000Z')) {
  const routeLedgers = ROUTES.map((_, routeIndex) => ({
    routeIndex,
    issues: issues.filter((row) => row.routeIndex === routeIndex),
    scores: scores.filter((row) => row.routeIndex === routeIndex),
  }))
  return buildFluidFTokenEpisodes({
    manifest,
    routeLedgers,
    featuresBySubject: new Map(),
    selectAsOfFeatures: () => ({ featureRefs: [], featureAbstentions: {} }),
    nowMs,
  })
}

test('three frozen routes, issue clusters and Q cases stay independent', () => {
  const parents = ROUTES.map((_, i) => issue(i))
  const result = run(
    parents,
    parents.map((parent) => score(parent)),
  )
  assert.equal(result.board.size, 3)
  assert.equal(result.episodes.length, 30)
  assert.equal(new Set(result.episodes.map((row) => row.issueClusterSha256)).size, 3)
  assert.equal(result.episodes.filter((row) => row.plannedHorizonHours === 1).length, 6)
  const first = result.episodes.find((row) => row.subject === subjectKey(ROUTES[0]))
  assert.equal(first.outcome.status, 'simulated_callable')
  assert.equal(first.baseline, 'simulated_callable')
  assert.equal(first.fullRoutePaidProofSha256, null)
  assert.equal(first.forecastEligible, false)
  assert.equal(first.analysisPrimaryForCell, false)
  assert.equal(first.qUnit, 'asset_raw')
  assert.equal(first.holderCommitment, hash(`${ROUTES[0].vault}:${parents[0].holder}`))
  assert.equal(result.diagnostics.get(subjectKey(ROUTES[0])).scoredTargets, 1)
})

test('baseline and covered target reverts retain unknown cause; preview and attrition differ', () => {
  const parent = issue()
  const rows = [
    {
      label: parent.cases[0].label,
      assetsRaw: parent.cases[0].assetsRaw,
      entitlement: { status: 'covered' },
      outcome: { status: 'evm_revert' },
    },
    {
      label: parent.cases[1].label,
      assetsRaw: parent.cases[1].assetsRaw,
      entitlement: { status: 'entitlement_unassessed' },
      outcome: null,
    },
  ]
  const result = run([parent], [score(parent, 'measured', rows)])
  const cells = result.episodes.filter((row) => row.plannedHorizonHours === 1)
  assert.deepEqual(
    cells.map((row) => row.outcome),
    [
      { status: 'inconclusive', reason: 'revert_cause_unknown' },
      { status: 'inconclusive', reason: 'preview_withdraw_reverted' },
    ],
  )
  assert.equal(cells[1].baseline, 'inconclusive')
  assert.equal(cells[1].rawBaselineStatus, 'evm_revert')
  assert.equal(cells[0].rawEntitlementStatus, 'covered')
  assert.equal(cells[0].rawScoreOutcome, 'evm_revert')
  rows[1].entitlement.status = 'holder_ineligible'
  const attrition = run([parent], [score(parent, 'measured', rows)])
  assert.deepEqual(attrition.episodes[1].outcome, {
    status: 'censored',
    reason: 'holder_attrition',
  })
})

test('missed and identity censoring, pending and missing remain separate', () => {
  const parent = issue()
  const missed = score(parent, 'capture_window_missed')
  assert.deepEqual(run([parent], [missed], Date.parse(missed.scoredAtUtc)).episodes[0].outcome, {
    status: 'censored',
    reason: 'capture_window_missed',
  })
  assert.deepEqual(run([parent], [score(parent, 'identity_changed')]).episodes[0].outcome, {
    status: 'censored',
    reason: 'identity_changed',
  })
  assert.equal(run([parent]).episodes[0].outcome.status, 'pending')
  assert.deepEqual(run([parent], [], Date.parse('2026-10-05T00:00:00.000Z')).episodes[0].outcome, {
    status: 'missing',
    reason: 'no_verified_score_after_deadline',
  })
})

test('retrospective cutoff hides future Fluid issues and scores after validating them', () => {
  const parent = issue()
  const observed = score(parent)
  const routeLedgers = ROUTES.map((_, routeIndex) => ({
    routeIndex,
    issues: routeIndex === 0 ? [parent] : [],
    scores: routeIndex === 0 ? [observed] : [],
  }))
  let featureJoins = 0
  const beforeIssue = buildFluidFTokenEpisodes({
    manifest,
    routeLedgers,
    selectAsOfFeatures: () => {
      featureJoins++
      return { featureRefs: [], featureAbstentions: {} }
    },
    nowMs: Date.parse(ISSUE_AT) - 1,
  })
  assert.equal(beforeIssue.episodes.length, 0)
  assert.equal(beforeIssue.diagnostics.get(subjectKey(ROUTES[0])).issues, 0)
  assert.equal(beforeIssue.diagnostics.get(subjectKey(ROUTES[0])).scoredTargets, 0)
  assert.equal(featureJoins, 0)
  const atIssue = run([parent], [observed], Date.parse(ISSUE_AT))
  assert.equal(atIssue.episodes.length, 10)
  assert.equal(atIssue.diagnostics.get(subjectKey(ROUTES[0])).issues, 1)
  assert.equal(atIssue.diagnostics.get(subjectKey(ROUTES[0])).scoredTargets, 0)

  const beforeScore = run([parent], [observed], Date.parse(observed.scoredAtUtc) - 1)
  const hidden = beforeScore.episodes[0]
  assert.equal(hidden.scoreSha256, null)
  assert.equal(hidden.observedAtUtc, null)
  assert.equal(hidden.rawScoreStatus, null)
  assert.equal(hidden.rawEntitlementStatus, null)
  assert.equal(hidden.rawScoreOutcome, null)
  assert.deepEqual(hidden.outcome, { status: 'pending', reason: null })
  assert.equal(beforeScore.diagnostics.get(subjectKey(ROUTES[0])).issues, 1)
  assert.equal(beforeScore.diagnostics.get(subjectKey(ROUTES[0])).scoredTargets, 0)

  const atScore = run([parent], [observed], Date.parse(observed.scoredAtUtc))
  assert.equal(atScore.episodes[0].scoreSha256, observed.sha256)
  assert.equal(atScore.episodes[0].observedAtUtc, parent.targets[0].targetAtUtc)
  assert.equal(atScore.episodes[0].rawScoreOutcome, 'success')
  assert.equal(atScore.diagnostics.get(subjectKey(ROUTES[0])).scoredTargets, 1)

  assert.throws(
    () =>
      run(
        [parent],
        [{ ...observed, cases: [{ ...observed.cases[0], assetsRaw: '999' }, observed.cases[1]] }],
        Date.parse(observed.scoredAtUtc) - 1,
      ),
    /score_binding_invalid/,
  )
  assert.throws(
    () =>
      run(
        [parent],
        [{ ...observed, scoredAtUtc: 'invalid' }],
        Date.parse(observed.scoredAtUtc) - 1,
      ),
    /clock_invalid/,
  )
  assert.throws(
    () => run([{ ...parent, vault: ROUTES[1].vault }], [], Date.parse(ISSUE_AT) - 1),
    /issue_identity_invalid/,
  )
})

test('a future Fluid capture-miss score leaves the earlier target missing', () => {
  const parent = issue()
  const missed = score(parent, 'capture_window_missed')
  const beforeSeal = run([parent], [missed], Date.parse(missed.scoredAtUtc) - 1)
  assert.deepEqual(beforeSeal.episodes[0].outcome, {
    status: 'missing',
    reason: 'no_verified_score_after_deadline',
  })
  assert.equal(beforeSeal.episodes[0].scoreSha256, null)
  assert.equal(beforeSeal.diagnostics.get(subjectKey(ROUTES[0])).scoredTargets, 0)
  const atSeal = run([parent], [missed], Date.parse(missed.scoredAtUtc))
  assert.equal(atSeal.episodes[0].outcome.status, 'censored')
  assert.equal(atSeal.diagnostics.get(subjectKey(ROUTES[0])).scoredTargets, 1)
})

test('malformed future Fluid block and witness clocks fail before score visibility', () => {
  const parent = issue()
  const measured = score(parent)
  const futureBlockMs = Date.parse(measured.scoredAtUtc) + 1_000
  const beforeMeasured = Date.parse(measured.scoredAtUtc) - 1
  assert.throws(
    () =>
      run(
        [parent],
        [
          {
            ...measured,
            block: {
              ...measured.block,
              timestamp: futureBlockMs / 1_000,
              atUtc: new Date(futureBlockMs).toISOString(),
            },
          },
        ],
        beforeMeasured,
      ),
    /score_binding_invalid/,
  )
  assert.throws(
    () =>
      run(
        [parent],
        [
          {
            ...measured,
            block: {
              ...measured.block,
              atUtc: new Date(Date.parse(measured.block.atUtc) + 1_000).toISOString(),
            },
          },
        ],
        beforeMeasured,
      ),
    /score_binding_invalid/,
  )
  const identityChanged = score(parent, 'identity_changed')
  assert.throws(
    () =>
      run(
        [parent],
        [
          {
            ...identityChanged,
            block: {
              ...identityChanged.block,
              timestamp: futureBlockMs / 1_000,
              atUtc: new Date(futureBlockMs).toISOString(),
            },
          },
        ],
        beforeMeasured,
      ),
    /score_binding_invalid/,
  )
  const missed = score(parent, 'capture_window_missed')
  assert.throws(
    () =>
      run(
        [parent],
        [
          {
            ...missed,
            finalizedDeadlineWitness: {
              timestamp: Date.parse(missed.scoredAtUtc) / 1_000 + 1,
            },
          },
        ],
        Date.parse(missed.scoredAtUtc) - 1,
      ),
    /score_binding_invalid/,
  )
})

test('route, issue SHA, target, Q and orphan forgeries fail closed', () => {
  const parent = issue()
  const observed = score(parent)
  const checkForgery = (mutate, pattern) => {
    const forgedIssue = structuredClone(parent)
    const forgedScore = structuredClone(observed)
    mutate(forgedIssue, forgedScore)
    assert.throws(() => run([forgedIssue], [forgedScore]), pattern)
  }
  checkForgery((row) => (row.vault = ROUTES[1].vault), /issue_identity_invalid/)
  checkForgery((row) => (row.asset = ROUTES[1].asset), /issue_identity_invalid/)
  checkForgery((row) => (row.routeKey = ROUTES[1].key), /issue_identity_invalid/)
  checkForgery((_, row) => (row.issueSha256 = hash('other')), /orphan_score/)
  checkForgery(
    (_, row) => (row.targetAtUtc = row.block.atUtc = BASELINE_AT),
    /score_binding_invalid/,
  )
  checkForgery((_, row) => (row.cases[0].assetsRaw = '999'), /score_binding_invalid/)
  const orphan = { ...observed, issueSequence: 999 }
  assert.throws(() => run([parent], [orphan]), /orphan_score/)
})

test('feature as-of selector receives the exact subject and baseline in the panel shape', () => {
  const parent = issue()
  const features = [{ kind: 'aggregate_cash' }]
  const map = new Map([[subjectKey(ROUTES[0]), features]])
  const result = buildFluidFTokenEpisodes({
    manifest,
    routeLedgers: ROUTES.map((_, routeIndex) => ({
      routeIndex,
      issues: routeIndex === 0 ? [parent] : [],
      scores: [],
    })),
    featuresBySubject: map,
    selectAsOfFeatures: (received, subject, receivedIssue, baseline) => {
      assert.equal(received, features)
      assert.equal(subject, manifest.subjects[0])
      assert.equal(receivedIssue, parent)
      assert.equal(baseline.baseline.targetBlock, '100')
      return { featureRefs: [{ kind: 'aggregate_cash' }], featureAbstentions: {} }
    },
    nowMs: Date.parse('2026-10-04T01:30:00.000Z'),
  })
  assert.equal(result.episodes[0].featureRefs[0].kind, 'aggregate_cash')
})
