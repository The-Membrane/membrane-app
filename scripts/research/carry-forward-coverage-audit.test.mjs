import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  runForwardCoverageAudit,
  summarizeForwardCoverage,
} from './carry-forward-coverage-audit.mjs'

test('verified public and frozen ledgers partition 68 exact subjects once', async () => {
  const result = await runForwardCoverageAudit()
  assert.deepEqual(result.publicRegistry, {
    routeGroups: 26,
    exactSubjects: 68,
    identityVerified: true,
  })
  assert.equal(result.historical, undefined)
  assert.equal(result.forward, undefined)
  assert.equal(
    result.retrospectiveModelEligibility.evidenceScope,
    'sealed_retrospective_model_eligibility',
  )
  assert.equal(result.retrospectiveModelEligibility.eligibleSubjects, 48)
  assert.equal(result.retrospectiveModelEligibility.eligibleRouteGroups, 16)
  assert.equal(result.retrospectiveModelEligibility.ineligibleSubjects, 20)
  assert.equal(result.retrospectiveModelEligibility.liveIssueCountAssessed, false)
  assert.equal(result.retrospectiveModelEligibility.historicalBacktestOnly, true)
  assert.deepEqual(result.retrospectiveModelEligibility.reasons, {
    untouched_interval_failed: 6,
    untouched_point_failed: 1,
    model_selection_failed: 8,
    incomplete_history: 1,
    payout_data_unavailable: 3,
    exact_endpoint_unassessed: 1,
  })
  assert.equal(
    result.subjects.find((row) => row.routeKey.includes('sGho'))?.status,
    'sealed_retrospective_model_ineligible',
  )
  assert.equal(
    result.subjects.filter((row) => row.status === 'sealed_retrospective_model_eligible').length,
    48,
  )
  assert.equal(
    result.subjects.every(
      (row) =>
        row.historicalBacktestOnly === true &&
        row.liveIssueCountAssessed === false &&
        row.prospectiveValidated === false,
    ),
    true,
  )
  assert.equal(
    result.subjects.find((row) => row.cohort === 'supplemental')?.reason,
    'model_selection_failed',
  )
  assert.deepEqual(summarizeForwardCoverage(result.subjects), result.retrospectiveModelEligibility)
  assert.deepEqual(
    summarizeForwardCoverage(structuredClone(result.subjects)),
    result.retrospectiveModelEligibility,
  )
})

test('partition rejects duplicate, missing, invalid reason and claim inflation', async () => {
  const { subjects } = await runForwardCoverageAudit()
  assert.throws(() => summarizeForwardCoverage(subjects.slice(1)), /partition_size/)
  assert.throws(
    () => summarizeForwardCoverage([subjects[0], ...subjects.slice(0, -1)]),
    /partition_duplicate/,
  )
  const unclassified = structuredClone(subjects)
  unclassified.find((row) => row.status === 'sealed_retrospective_model_ineligible').reason =
    'unknown'
  assert.throws(() => summarizeForwardCoverage(unclassified), /partition_unclassified/)
  const inflated = structuredClone(subjects)
  inflated[0].holderExecutableExit = true
  assert.throws(() => summarizeForwardCoverage(inflated), /partition_claim/)
})
