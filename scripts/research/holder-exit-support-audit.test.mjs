import assert from 'node:assert/strict'
import { test } from 'node:test'

import { auditHolderExitSupport } from './holder-exit-support-audit.mjs'

const address = (n) => `0x${n.toString(16).padStart(40, '0')}`
const SGHO_FIXED_Q_RAW = '1000000000000000000'
const manifest = {
  subjects: Array.from({ length: 67 }, (_, index) => ({
    route_key: `route-${Math.min(index, 24)}`,
    destination: address(index + 1),
    asset: address(100 + Math.min(index, 24)),
  })),
}
const target = (horizonHours, deadline = '2026-10-01T03:00:00.000Z') => ({
  horizonHours,
  targetAtUtc: '2026-10-01T02:00:00.000Z',
  captureDeadlineUtc: deadline,
})
const morphoIssue = (sequence, holder, baselineStatus) => ({
  sequence,
  sha256: String(sequence),
  routeKey: 'route-0',
  destination: address(1),
  asset: address(100),
  holder,
  targets: [target(1), target(24)],
  cases: [
    { label: 'small', assetsRaw: '100', baselineStatus },
    { label: 'large', assetsRaw: '1000', baselineStatus },
  ],
})
const directIssue = (sequence, holder, status) => ({
  sequence,
  sha256: String(sequence),
  routeKey: 'route-1',
  destination: address(2),
  originalAsset: address(101),
  candidate: { holder },
  targets: [target(1)],
  cases: [
    {
      label: 'chosen',
      assetsRaw: '100',
      status: 'measured',
      measurement: { status, holderCoverageRaw: '100', coveredRevert: status === 'evm_revert' },
    },
  ],
})
const vaultIssue = (routeIndex, sequence, holder, baselineStatus, status = 'measured') => ({
  sequence,
  sha256: String(sequence),
  routeKey: `route-${routeIndex}`,
  destination: address(routeIndex + 1),
  originalAsset: address(100 + routeIndex),
  candidate: { holder },
  targets: [target(1)],
  cases: [
    {
      label: 'chosen',
      assetsRaw: '100',
      status,
      measurement: status === 'measured' ? { baselineStatus } : null,
    },
  ],
})
const vaultScore = (sequence, status, outcome, transition = null) => ({
  issueSequence: sequence,
  horizonHours: 1,
  cases: [
    {
      label: 'chosen',
      assetsRaw: '100',
      status,
      reason: status === 'unavailable' ? 'capture_window_missed' : null,
      outcome,
      transition,
    },
  ],
})
const fluidIssue = (routeIndex, holder, baselineStatus = 'success') => ({
  routeIndex,
  sequence: 1,
  routeKey: `route-${routeIndex}`,
  vault: address(routeIndex + 1),
  asset: address(100 + routeIndex),
  holder,
  targets: [{ horizonHours: 1, deadlineUtc: '2026-10-01T03:00:00.000Z' }],
  cases: [{ label: 'holder_1pct', assetsRaw: '100', baseline: { status: baselineStatus } }],
})
const fluidScore = (routeIndex, status, entitlement = null, outcome = null) => ({
  routeIndex,
  issueSequence: 1,
  horizonHours: 1,
  status,
  cases:
    status === 'measured'
      ? [{ label: 'holder_1pct', entitlement: { status: entitlement }, outcome }]
      : null,
})
const compoundIssue = (sequence, holder, cases) => ({
  sequence,
  routeKey: 'route-10',
  destination: address(11),
  originalAsset: address(110),
  candidate: { holder },
  targets: [target(1)],
  cases,
})
const compoundCase = (label, assetsRaw, status, coverage, coveredRevert = false) => ({
  label,
  assetsRaw,
  status: status === 'unavailable' ? 'unavailable' : 'measured',
  measurement:
    status === 'unavailable' ? null : { status, holderCoverageRaw: coverage, coveredRevert },
})
const compoundScore = (issueSequence, cases) => ({
  issueSequence,
  horizonHours: 1,
  cases,
})
const audit = (overrides = {}) =>
  auditHolderExitSupport({
    manifest,
    morphoIssues: [],
    morphoScores: [],
    directIssues: [],
    directScores: [],
    now: Date.parse('2026-10-01T04:00:00.000Z'),
    ...overrides,
  })

test('counts issue records per exact Q and horizon and keeps repeat holder distinct from sample size', () => {
  const holder = address(999)
  const issues = [
    morphoIssue(1, holder, 'baseline_revert'),
    morphoIssue(2, holder, 'baseline_revert'),
  ]
  const scores = [
    {
      issueSequence: 1,
      horizonHours: 1,
      caseLabel: 'small',
      outcome: 'simulated_withdraw_success',
      transition: 'simulated_recovery',
    },
    {
      issueSequence: 1,
      horizonHours: 1,
      caseLabel: 'large',
      outcome: 'preview_gap',
      transition: 'still_reverting',
    },
    {
      issueSequence: 2,
      horizonHours: 1,
      caseLabel: 'small',
      outcome: 'censored_capture_window_missed',
      transition: 'censored',
    },
  ]
  const result = audit({ morphoIssues: issues, morphoScores: scores })
  const small1 = result.cells.find((cell) => cell.assetsRaw === '100' && cell.horizonHours === 1)
  assert.equal(small1.issueRecords, 2)
  assert.equal(small1.distinctHolders, 1)
  assert.equal(small1.baselineImpairedDistinctHolders, 1)
  assert.equal(small1.baselineControlDistinctHolders, 0)
  assert.equal(small1.baseline.impaired, 2)
  assert.equal(small1.impaired.recovery, 1)
  assert.equal(small1.impaired.censored, 1)
  assert.equal(
    result.cells.find((cell) => cell.assetsRaw === '1000' && cell.horizonHours === 1).impaired
      .entitlementGap,
    1,
  )
  assert.equal(
    result.cells.find((cell) => cell.assetsRaw === '100' && cell.horizonHours === 24).impaired
      .missing,
    2,
  )
  assert.deepEqual(result.denominator, { routeGroups: 25, exactSubjects: 67 })
  assert.equal(result.support.exactSubjectsWithoutIssueInAuditedLedgers, 66)
  assert.equal(result.groups.find((group) => group.routeKey === 'route-24').withIssue, 0)
  assert.equal(JSON.stringify(result).includes(holder), false)
  assert.equal(result.forecastValidated, false)
  assert.equal(result.statisticalIndependenceValidated, false)
})

test('Morpho preview gap is holder entitlement loss, not a covered new revert', () => {
  const issue = morphoIssue(1, address(999), 'simulated_withdraw_success')
  const score = {
    issueSequence: 1,
    horizonHours: 1,
    caseLabel: 'small',
    outcome: 'preview_gap',
    transition: 'new_revert',
  }
  const cell = audit({ morphoIssues: [issue], morphoScores: [score] }).cells.find(
    (row) => row.assetsRaw === '100' && row.horizonHours === 1,
  )
  assert.equal(cell.control.entitlementGap, 1)
  assert.equal(cell.control.newRevert, 0)
})

test('keeps direct control, attrition and impaired baseline with no designed score distinct', () => {
  const issues = [
    directIssue(1, address(777), 'success'),
    directIssue(2, address(778), 'evm_revert'),
  ]
  const scores = [
    {
      issueSequence: 1,
      horizonHours: 1,
      cases: [{ label: 'chosen', status: 'measured', outcome: 'holder_attrition' }],
    },
    {
      issueSequence: 2,
      horizonHours: 1,
      cases: [{ label: 'chosen', status: 'ineligible', outcome: null }],
    },
  ]
  const result = audit({ directIssues: issues, directScores: scores })
  const cell = result.cells[0]
  assert.equal(cell.issueRecords, 2)
  assert.equal(cell.baselineImpairedDistinctHolders, 1)
  assert.equal(cell.baselineControlDistinctHolders, 1)
  assert.deepEqual(cell.baseline, { impaired: 1, control: 1, unavailable: 0 })
  assert.equal(cell.control.attrition, 1)
  assert.equal(cell.impaired.unscoredByDesign, 1)
  assert.equal(cell.impaired.recovery, 0)
})

test('Aave frozen-Q follow-up replaces matching V1 cells and scores covered reverts', () => {
  const parent = directIssue(1, address(778), 'success')
  parent.marketKey = 'aaveV3Usdc'
  parent.cases.push({
    label: 'impaired',
    assetsRaw: '200',
    status: 'measured',
    measurement: { status: 'evm_revert', holderCoverageRaw: '300', coveredRevert: true },
  })
  const followup = {
    sequence: 1,
    v1IssueSequence: 1,
    v1IssueSha256: parent.sha256,
    routeKey: parent.routeKey,
    destination: parent.destination,
    originalAsset: parent.originalAsset,
    holder: parent.candidate.holder,
    targets: parent.targets,
    cases: [
      { label: 'chosen', assetsRaw: '100', baselineStatus: 'success' },
      { label: 'impaired', assetsRaw: '200', baselineStatus: 'covered_revert' },
    ],
  }
  const score = {
    issueSequence: 1,
    horizonHours: 1,
    status: 'measured',
    cases: [
      { label: 'chosen', assetsRaw: '100', status: 'measured', transition: 'remained_exitable' },
      { label: 'impaired', assetsRaw: '200', status: 'measured', transition: 'simulated_recovery' },
    ],
  }
  const result = audit({
    directIssues: [parent],
    aaveFrozenQIssues: [followup],
    aaveFrozenQScores: [score],
  })
  const control = result.cells.find((cell) => cell.assetsRaw === '100')
  const impaired = result.cells.find((cell) => cell.assetsRaw === '200')
  assert.equal(control.issueRecords, 1)
  assert.equal(control.control.continued, 1)
  assert.equal(impaired.issueRecords, 1)
  assert.equal(impaired.baseline.impaired, 1)
  assert.equal(impaired.impaired.recovery, 1)
  assert.throws(
    () =>
      audit({
        directIssues: [parent],
        aaveFrozenQIssues: [
          { ...followup, cases: [{ ...followup.cases[0], assetsRaw: '2' }, followup.cases[1]] },
        ],
      }),
    /case_mismatch/,
  )
})

test('Aave common-Q counts same holder/Q once across V1, V2 and V3; inconclusive stays unavailable', () => {
  const parent = directIssue(1, address(778), 'success')
  parent.marketKey = 'aaveV3Usdc'
  parent.cases.push({
    label: 'generic',
    assetsRaw: '200',
    status: 'measured',
    measurement: { status: 'evm_revert', holderCoverageRaw: '300', coveredRevert: false },
  })
  const v2 = {
    sequence: 1,
    v1IssueSequence: 1,
    v1IssueSha256: parent.sha256,
    routeKey: parent.routeKey,
    destination: parent.destination,
    originalAsset: parent.originalAsset,
    holder: parent.candidate.holder,
    targets: parent.targets,
    cases: [{ label: 'chosen', assetsRaw: '100', baselineStatus: 'success' }],
  }
  const v3 = {
    sequence: 1,
    v1IssueSequence: 1,
    v1IssueSha256: parent.sha256,
    routeKey: parent.routeKey,
    destination: parent.destination,
    originalAsset: parent.originalAsset,
    holder: parent.candidate.holder,
    targets: parent.targets,
    cases: [
      {
        label: 'fixed_1_usdc',
        assetsRaw: '100',
        status: 'measured',
        measurement: { baselineStatus: 'success' },
      },
      {
        label: 'fixed_1000_usdc',
        assetsRaw: '200',
        status: 'inconclusive',
        measurement: { baselineStatus: 'inconclusive_covered_revert' },
      },
    ],
  }
  const v3Score = {
    issueSequence: 1,
    horizonHours: 1,
    status: 'measured',
    cases: [
      {
        label: 'fixed_1_usdc',
        assetsRaw: '100',
        status: 'measured',
        transition: 'remained_exitable',
      },
    ],
  }
  const result = audit({
    directIssues: [parent],
    aaveFrozenQIssues: [v2],
    aaveCommonQIssues: [v3],
    aaveCommonQScores: [v3Score],
    aaveCommonQAttempts: [
      {
        v1IssueSequence: 1,
        v1IssueSha256: parent.sha256,
        observationStatus: 'operator_observed_unverified',
        verifiedCensor: false,
        observedCondition: 'issue_record_guard_triggered',
      },
    ],
  })
  const measured = result.cells.find((x) => x.assetsRaw === '100')
  const inconclusive = result.cells.find((x) => x.assetsRaw === '200')
  assert.equal(result.support.aaveCommonQUnverifiedDiagnostics, 1)
  assert.equal(measured.issueRecords, 1)
  assert.equal(measured.control.continued, 1)
  assert.equal(result.support.correlatedAaveV1ObservationsExcluded, 2)
  assert.equal(result.support.correlatedAaveV2ObservationsExcluded, 1)
  assert.equal(inconclusive.baseline.unavailable, 1)
  assert.equal(inconclusive.aaveCommonQ.inconclusiveCoveredBaseline, 1)
  assert.throws(
    () =>
      audit({
        directIssues: [parent],
        aaveFrozenQIssues: [v2],
        aaveCommonQIssues: [
          {
            ...v3,
            cases: [
              { ...v3.cases[0], measurement: { baselineStatus: 'covered_revert' } },
              v3.cases[1],
            ],
          },
        ],
      }),
    /baseline_disagreement/,
  )
})

test('Aave common-Q operator diagnostic is reported without inventing a holder outcome', () => {
  const parent = directIssue(1, address(778), 'success')
  parent.marketKey = 'aaveV3Usdc'
  const attempt = {
    v1IssueSequence: 1,
    v1IssueSha256: parent.sha256,
    observationStatus: 'operator_observed_unverified',
    verifiedCensor: false,
    observedCondition: 'issue_record_guard_triggered',
  }
  const result = audit({ directIssues: [parent], aaveCommonQAttempts: [attempt] })
  assert.equal(result.support.aaveCommonQUnverifiedDiagnostics, 1)
  assert.equal(result.cells[0].issueRecords, 1)
  assert.throws(
    () =>
      audit({
        directIssues: [parent],
        aaveCommonQAttempts: [{ ...attempt, observedCondition: 'unknown' }],
      }),
    /attempt_invalid/,
  )
})

test('fails closed on duplicate Q and nonfrozen denominator', () => {
  const issue = morphoIssue(1, address(999), 'baseline_revert')
  issue.cases[1].assetsRaw = '100'
  assert.throws(() => audit({ morphoIssues: [issue] }), /support_duplicate_q_in_issue/)
  assert.throws(
    () => audit({ manifest: { subjects: manifest.subjects.slice(1) } }),
    /support_manifest_not_frozen_25_67/,
  )
})

test('separates ledger presence from a measured baseline', () => {
  const issue = directIssue(1, address(777), 'success')
  issue.cases[0].status = 'unavailable'
  issue.cases[0].measurement = null
  const result = audit({ directIssues: [issue] })
  assert.equal(result.support.exactSubjectsWithIssueInAuditedLedgers, 1)
  assert.equal(result.support.exactSubjectsWithMeasuredBaselineInAuditedLedgers, 0)
  assert.equal(result.support.exactCellsWithMeasuredBaselineInAuditedLedgers, 0)
})

test('accounts for all four verified vault ledgers without treating inconclusive as impaired', () => {
  const result = audit({
    sghoIssues: [vaultIssue(2, 1, address(702), 'covered_revert')],
    susdsIssues: [vaultIssue(3, 1, address(703), 'inconclusive')],
    stusdsIssues: [vaultIssue(4, 1, address(704), 'covered_revert')],
    usd3Issues: [vaultIssue(5, 1, address(705), 'success')],
    stusdsScores: [vaultScore(1, 'measured', 'simulated_withdraw_success', 'simulated_recovery')],
    usd3Scores: [vaultScore(1, 'measured', 'withdraw_revert_cause_unknown')],
  })
  const byRoute = (index) => result.cells.find((cell) => cell.routeKey === `route-${index}`)
  assert.equal(byRoute(2).baseline.impaired, 1)
  assert.equal(byRoute(2).impaired.unscoredByDesign, 1)
  assert.equal(byRoute(3).baseline.unavailable, 1)
  assert.equal(byRoute(3).baseline.impaired, 0)
  assert.equal(byRoute(4).impaired.recovery, 1)
  assert.equal(byRoute(5).control.newRevert, 1)
  assert.equal(result.support.exactSubjectsWithIssueInAuditedLedgers, 4)
  assert.equal(result.support.exactSubjectsWithMeasuredBaselineInAuditedLedgers, 3)
  assert.equal(JSON.stringify(result).includes(address(704)), false)
  assert.equal(result.statisticalIndependenceValidated, false)
})

test('uses sGHO fixed-Q V2 in place of its correlated V1 parent at the same exact cell', () => {
  const holder = address(702)
  const parent = vaultIssue(2, 1, holder, 'covered_revert')
  parent.sha256 = 'parent-hash'
  parent.cases[0].assetsRaw = SGHO_FIXED_Q_RAW
  parent.cases.push({
    label: 'larger',
    assetsRaw: '2000000000000000000',
    status: 'measured',
    measurement: { baselineStatus: 'success' },
  })
  const fixed = {
    v1IssueSequence: 1,
    v1IssueSha256: parent.sha256,
    sequence: 1,
    routeKey: parent.routeKey,
    destination: parent.destination,
    originalAsset: parent.originalAsset,
    holder,
    assetsRaw: SGHO_FIXED_Q_RAW,
    baselineStatus: 'covered_revert',
    targets: [target(1)],
  }
  const result = audit({
    sghoIssues: [parent],
    sghoFixedQIssues: [fixed],
    sghoFixedQScores: [
      {
        issueSequence: 1,
        horizonHours: 1,
        status: 'measured',
        outcome: 'simulated_withdraw_success',
        transition: 'simulated_recovery',
      },
    ],
  })
  const fixedCell = result.cells.find((cell) => cell.assetsRaw === SGHO_FIXED_Q_RAW)
  const largerCell = result.cells.find((cell) => cell.assetsRaw === '2000000000000000000')
  assert.equal(fixedCell.issueRecords, 1)
  assert.deepEqual(fixedCell.baseline, { impaired: 1, control: 0, unavailable: 0 })
  assert.equal(fixedCell.impaired.recovery, 1)
  assert.equal(fixedCell.impaired.unscoredByDesign, 0)
  assert.equal(largerCell.issueRecords, 1)
  assert.equal(largerCell.control.missing, 1)
  assert.equal(result.support.correlatedSghoV1ObservationsExcluded, 1)
  assert.equal(result.support.exactSubjectsWithIssueInAuditedLedgers, 1)
  assert.equal(JSON.stringify(result).includes(holder), false)
  assert.throws(
    () => audit({ sghoIssues: [], sghoFixedQIssues: [fixed] }),
    /support_sgho_fixed_q_parent_mismatch/,
  )
  const conflictingParent = structuredClone(parent)
  conflictingParent.cases[0].measurement.baselineStatus = 'success'
  assert.throws(
    () => audit({ sghoIssues: [conflictingParent], sghoFixedQIssues: [fixed] }),
    /support_sgho_fixed_q_baseline_disagreement/,
  )
  const unavailableParent = structuredClone(parent)
  unavailableParent.cases[0].status = 'unavailable'
  unavailableParent.cases[0].measurement = null
  assert.equal(
    audit({ sghoIssues: [unavailableParent], sghoFixedQIssues: [fixed] }).cells.find(
      (cell) => cell.assetsRaw === SGHO_FIXED_Q_RAW,
    ).baseline.impaired,
    1,
  )
})

test('sGHO fixed-Q V2 separates impairment, control, attrition, censoring, and pending', () => {
  const parents = Array.from({ length: 6 }, (_, index) => {
    const issue = vaultIssue(
      2,
      index + 1,
      address(710 + index),
      index < 4 ? 'covered_revert' : 'success',
    )
    issue.sha256 = `parent-${index + 1}`
    issue.cases[0].assetsRaw = SGHO_FIXED_Q_RAW
    return issue
  })
  const fixed = parents.map((parent, index) => ({
    v1IssueSequence: parent.sequence,
    v1IssueSha256: parent.sha256,
    sequence: index + 1,
    routeKey: parent.routeKey,
    destination: parent.destination,
    originalAsset: parent.originalAsset,
    holder: parent.candidate.holder,
    assetsRaw: SGHO_FIXED_Q_RAW,
    baselineStatus: index < 4 ? 'covered_revert' : 'success',
    targets: [target(1)],
  }))
  const score = (issueSequence, status, transition) => ({
    issueSequence,
    horizonHours: 1,
    status,
    transition,
  })
  const result = audit({
    sghoIssues: parents,
    sghoFixedQIssues: fixed,
    sghoFixedQScores: [
      score(1, 'measured', 'still_reverting'),
      score(2, 'measured', 'holder_attrition'),
      score(3, 'censored', 'censored'),
      score(5, 'measured', 'lost_exitability'),
    ],
  })
  const cell = result.cells[0]
  assert.equal(cell.issueRecords, 6)
  assert.equal(cell.impaired.still, 1)
  assert.equal(cell.impaired.attrition, 1)
  assert.equal(cell.impaired.censored, 1)
  assert.equal(cell.impaired.missing, 1)
  assert.equal(cell.control.newRevert, 1)
  assert.equal(cell.control.missing, 1)
  assert.equal(result.support.correlatedSghoV1ObservationsExcluded, 6)
  const pending = audit({
    sghoIssues: parents,
    sghoFixedQIssues: fixed,
    now: Date.parse('2026-10-01T02:30:00.000Z'),
  }).cells[0]
  assert.equal(pending.impaired.pending, 4)
  assert.equal(pending.control.pending, 2)
})

test('separates missing, pending, censored, and holder attrition in vault scores', () => {
  const issues = [
    vaultIssue(6, 1, address(706), 'covered_revert'),
    vaultIssue(6, 2, address(707), 'covered_revert'),
    vaultIssue(6, 3, address(708), 'covered_revert'),
    vaultIssue(6, 4, address(709), 'success'),
  ]
  const result = audit({
    stusdsIssues: issues,
    stusdsScores: [
      vaultScore(2, 'unavailable', null, 'censored'),
      vaultScore(3, 'measured', 'holder_shares_zero', 'holder_attrition'),
    ],
    now: Date.parse('2026-10-01T04:00:00.000Z'),
  })
  const cell = result.cells[0]
  assert.equal(cell.impaired.missing, 1)
  assert.equal(cell.impaired.censored, 1)
  assert.equal(cell.impaired.attrition, 1)
  assert.equal(cell.control.missing, 1)
  const pending = audit({ stusdsIssues: issues, now: Date.parse('2026-10-01T02:30:00.000Z') })
  assert.equal(pending.cells[0].impaired.pending, 3)
  assert.equal(pending.cells[0].control.pending, 1)
})

test('counts three exact Fluid fToken subjects without conflating route-local score sequences', () => {
  const result = audit({
    fluidFtokenIssues: [
      fluidIssue(7, address(707)),
      fluidIssue(8, address(808), 'evm_revert'),
      fluidIssue(9, address(909)),
    ],
    fluidFtokenScores: [
      fluidScore(7, 'measured', 'covered', { status: 'success' }),
      fluidScore(8, 'measured', 'holder_ineligible'),
      fluidScore(9, 'identity_changed'),
    ],
  })
  const cell = (index) => result.cells.find((item) => item.routeKey === `route-${index}`)
  assert.equal(result.support.exactSubjectsWithIssueInAuditedLedgers, 3)
  assert.equal(result.support.exactSubjectsWithMeasuredBaselineInAuditedLedgers, 2)
  assert.equal(cell(7).control.continued, 1)
  assert.equal(cell(8).baseline.unavailable, 1)
  assert.equal(cell(8).fluid.baselineRevertUnassessed, 1)
  assert.equal(cell(8).fluid.target.holderIneligible, 1)
  assert.equal(cell(8).impaired.recovery, 0)
  assert.equal(cell(9).control.censored, 1)
  assert.equal(cell(9).fluid.target.identityChanged, 1)
  assert.equal(JSON.stringify(result).includes(address(707)), false)
})

test('keeps covered target revert, entitlement uncertainty, missed capture, and pending separate', () => {
  const issue = fluidIssue(7, address(707))
  const score = fluidScore(7, 'measured', 'covered', { status: 'evm_revert' })
  const measured = audit({ fluidFtokenIssues: [issue], fluidFtokenScores: [score] }).cells[0]
  assert.equal(measured.control.ambiguous, 1)
  assert.equal(measured.fluid.target.coveredRevert, 1)
  const uncertain = audit({
    fluidFtokenIssues: [issue],
    fluidFtokenScores: [fluidScore(7, 'measured', 'entitlement_unassessed')],
  }).cells[0]
  assert.equal(uncertain.control.entitlementUnassessed, 1)
  const missed = audit({
    fluidFtokenIssues: [issue],
    fluidFtokenScores: [fluidScore(7, 'capture_window_missed')],
  }).cells[0]
  assert.equal(missed.control.censored, 1)
  assert.equal(missed.fluid.target.captureWindowMissed, 1)
  const pending = audit({
    fluidFtokenIssues: [issue],
    now: Date.parse('2026-10-01T02:00:00.000Z'),
  }).cells[0]
  assert.equal(pending.control.pending, 1)
  assert.equal(pending.fluid.target.pending, 1)
  assert.throws(
    () =>
      audit({
        fluidFtokenIssues: [issue],
        fluidFtokenScores: [score, score],
      }),
    /support_score_duplicate/,
  )
})

test('counts Compound supplied-position controls but not uncovered Comet debt-capable calls', () => {
  const holder = address(1010)
  const issue = compoundIssue(1, holder, [
    compoundCase('supplied', '100', 'success', '100'),
    compoundCase('uncovered_success', '200', 'success', '100'),
    compoundCase('uncovered_revert', '300', 'evm_revert', '100'),
    compoundCase('covered_revert', '50', 'evm_revert', '100', true),
  ])
  const result = audit({ compoundIssues: [issue] })
  const cell = (q) => result.cells.find((entry) => entry.assetsRaw === q)
  assert.equal(result.support.exactSubjectsWithIssueInAuditedLedgers, 1)
  assert.equal(result.support.exactCellsWithMeasuredBaselineInAuditedLedgers, 2)
  assert.equal(cell('100').baseline.control, 1)
  assert.equal(cell('200').baseline.unavailable, 1)
  assert.equal(cell('200').compound.baselineInsufficientCoverage, 1)
  assert.equal(cell('200').compound.target.ineligibleBaseline, 1)
  assert.equal(cell('300').baseline.unavailable, 1)
  assert.equal(cell('50').baseline.impaired, 1)
  assert.equal(cell('50').impaired.unscoredByDesign, 1)
  assert.equal(cell('50').compound.target.ineligibleBaseline, 1)
  assert.equal(JSON.stringify(result).includes(holder), false)
})

test('keeps Compound target success, covered revert, attrition, censor, pending and missing distinct', () => {
  const issues = [
    compoundIssue(1, address(1010), [compoundCase('a', '100', 'success', '100')]),
    compoundIssue(2, address(1020), [compoundCase('a', '100', 'success', '100')]),
  ]
  const base = (scores, now) => audit({ compoundIssues: issues, compoundScores: scores, now })
  const measured = base([
    compoundScore(1, [{ label: 'a', status: 'measured', outcome: 'exit_success' }]),
    compoundScore(2, [{ label: 'a', status: 'measured', outcome: 'exit_revert_cause_unknown' }]),
  ]).cells[0]
  assert.equal(measured.issueRecords, 2)
  assert.equal(measured.distinctHolders, 2)
  assert.equal(measured.control.continued, 1)
  assert.equal(measured.control.ambiguous, 1)
  assert.equal(measured.compound.target.success, 1)
  assert.equal(measured.compound.target.coveredRevert, 1)
  const attrition = base([
    compoundScore(1, [{ label: 'a', status: 'measured', outcome: 'holder_attrition' }]),
  ]).cells[0]
  assert.equal(attrition.control.attrition, 1)
  assert.equal(attrition.compound.target.holderAttrition, 1)
  const censored = base([
    compoundScore(1, [{ label: 'a', status: 'unavailable', reason: 'capture_window_missed' }]),
  ]).cells[0]
  assert.equal(censored.control.censored, 1)
  assert.equal(censored.compound.target.captureWindowMissed, 1)
  assert.equal(base([], Date.parse('2026-10-01T02:30:00.000Z')).cells[0].control.pending, 2)
  assert.equal(base([]).cells[0].control.missing, 2)
  assert.throws(() => base([compoundScore(1, []), compoundScore(1, [])]), /support_score_duplicate/)
})
