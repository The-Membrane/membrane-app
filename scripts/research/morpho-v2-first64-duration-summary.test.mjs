import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { FACTORY_SHA } from './morpho-v2-full-cohort-baseline.mjs'
import { STAGE1_SHA } from './morpho-v2-exit-baseline-pilot.mjs'
import { loadPlan } from './morpho-v2-first64-treated-outcomes.mjs'
import { readSummary, summarizeVerified } from './morpho-v2-first64-duration-summary.mjs'

const baseDir = 'data/research/venue-signals/'
const paths = {
  treatedPath: `${baseDir}morpho-v2-signer-baseline-v2.json`,
  manifestPath: `${baseDir}morpho-v2-full-cohort-manifest.json`,
  factoryPath: `${baseDir}${FACTORY_SHA}.json`,
  stage1Path: `${baseDir}${STAGE1_SHA}.json`,
  out: `${baseDir}morpho-v2-first64-treated-outcomes-v1.json`,
}
const plan = loadPlan(paths)
const saved = JSON.parse(readFileSync(paths.out))
const clone = () => structuredClone(saved)
function seal(snapshot) {
  delete snapshot.checkpointSha256
  snapshot.checkpointSha256 = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
  return snapshot
}

test('real partial artifact keeps all frozen rows and missing denominator', () => {
  const result = readSummary(paths)
  assert.equal(result.counts.frozenRows, 64)
  assert.equal(result.counts.baselineEligible, 58)
  assert.equal(result.counts.baselineIneligible, 6)
  assert.equal(result.counts.pairsWithConcurrentEligibleScheduledActions, 52)
  assert.equal(result.counts.pairsWithSingleEligibleScheduledActionAtFirstExecutableAt, 6)
  assert.equal(result.counts.concurrentEligibleScheduledActionSlots, 52)
  assert.equal(result.counts.pairsWithLaterEligibleScheduledActions, 0)
  assert.equal(result.dependence.byEligibleScheduledActionCountAtFirstExecutableAt['2'].rows, 52)
  assert.equal(result.dependence.byEligibleScheduledActionCountAtFirstExecutableAt['1'].rows, 6)
  assert.equal(result.rows[0].eligibleScheduledActionCountAtFirstExecutableAt, 2)
  assert.equal(result.rows[0].otherEligibleScheduledActionTimes[0], saved.rows[0].executableAt)
  assert.equal(result.rows[0].singleActionAttribution.status, 'unavailable')
  assert.equal(result.singleActionAttribution.status, 'unavailable')
  const loneSchedule = result.rows.find(
    (row) =>
      row.baselineStatus === 'baseline-success' &&
      row.eligibleScheduledActionCountAtFirstExecutableAt === 1,
  )
  assert.equal(loneSchedule.singleActionAttribution.status, 'unavailable')
  assert.equal(loneSchedule.singleActionAttribution.reason, 'scheduled-action-execution-unverified')
  assert.equal(result.counts.missingBaseline, 57)
  assert.equal(result.counts.pendingFollowUp, 0)
  assert.equal(result.counts.observedSuccessRightCensors, 1)
  assert.equal(result.counts.firstObservedRevertIntervals, 0)
  assert.equal(result.counts.cleanSuccessSamples, 2)
  assert.equal(result.counts.scheduledOutcomeSlots, 116)
  assert.equal(result.counts.missingSamples, 114)
  assert.equal(result.counts.pairsWithPendingSamples, 57)
  assert.equal(result.dependence.uniqueVaults, 44)
  assert.equal(result.dependence.uniqueHolders, 48)
  assert.equal(result.counts.materialityUnclassified, 0)
  assert.equal(result.rows[0].asset, saved.rows[0].baseline.asset)
  assert.equal(result.rows[0].assetEvidence, 'pinned-manifest')
  assert.equal(result.rows[0].qOverVaultAssetsStratum, 'over-5-to-10bp')
  assert.equal(result.forecast.status, 'unavailable')
  assert.match(result.outcomePhysicalSha256, /^[a-f\d]{64}$/)
  assert.equal(
    result.rows[0].episode.observedCleanSuccessSeconds,
    saved.rows[0].outcomes.plus7d.timestamp - saved.rows[0].baseline.timestamp,
  )
  assert.equal(result.rows[0].episode.startBasis, 'pre-block-baseline')
  assert.equal(
    result.rows[0].episode.preExecutableGapSeconds,
    saved.rows[0].executableAt - saved.rows[0].baseline.timestamp,
  )
  assert.equal(result.rows[0].samples[0].targetElapsedFromExecutableSeconds, 86400)
  assert.equal(result.rows[0].samples[0].targetTimestamp, saved.rows[0].executableAt + 86400)
})

test('scheduled multiplicity counts equal-time actions without treating later eligibility as execution', () => {
  const snapshot = clone()
  const syntheticPlan = structuredClone(plan)
  const at = snapshot.rows[0].executableAt
  snapshot.rows[0].coInterventionTimes = [at, at, at + 86400]
  syntheticPlan[0].coInterventionTimes = [at, at, at + 86400]
  const result = summarizeVerified(seal(snapshot), syntheticPlan)
  assert.equal(result.rows[0].eligibleScheduledActionCountAtFirstExecutableAt, 3)
  assert.equal(result.rows[0].otherEligibleScheduledActionCountAfterFirstExecutableAt, 1)
  assert.equal(result.counts.pairsWithConcurrentEligibleScheduledActions, 52)
  assert.equal(result.counts.concurrentEligibleScheduledActionSlots, 53)
  assert.equal(result.counts.pairsWithLaterEligibleScheduledActions, 1)
  assert.equal(result.rows[0].singleActionAttribution.status, 'unavailable')
  assert.equal(result.rows[0].classification, 'observed-success-right-censor')
})

test('clean first sampled revert is interval bounded by last clean success', () => {
  const snapshot = clone()
  const row = snapshot.rows[0]
  row.outcomes.plus7d.call = 'evm-revert'
  row.outcomes.plus7d.status = 'evm-revert'
  const result = summarizeVerified(seal(snapshot), plan)
  const episode = result.rows[0].episode
  assert.equal(result.rows[0].classification, 'first-observed-revert-interval')
  assert.equal(result.counts.firstObservedRevertIntervals, 1)
  assert.equal(episode.firstObservedRevert.afterTimestamp, row.outcomes.plus24h.timestamp)
  assert.equal(episode.firstObservedRevert.byTimestamp, row.outcomes.plus7d.timestamp)
  assert.equal(result.forecast.status, 'unavailable')
})

test('provider ambiguity censors and never becomes simulated failure', () => {
  const snapshot = clone()
  const probe = snapshot.rows[0].outcomes.plus7d
  probe.call = 'rpc-or-archive-error'
  probe.status = 'censored'
  probe.censoring = ['call-unresolved']
  const result = summarizeVerified(seal(snapshot), plan)
  assert.equal(result.rows[0].classification, 'ambiguous-right-censor')
  assert.equal(
    result.rows[0].episode.observedCleanSuccessSeconds,
    saved.rows[0].outcomes.plus24h.timestamp - saved.rows[0].baseline.timestamp,
  )
  assert.equal(result.counts.ambiguousSamples, 1)
  assert.equal(result.counts.firstObservedRevertIntervals, 0)
})

test('ambiguous intermediate call stops comparable episode despite later clean revert', () => {
  const snapshot = clone()
  const first = snapshot.rows[0].outcomes.plus24h
  first.call = 'rpc-or-archive-error'
  first.status = 'censored'
  first.censoring = ['call-unresolved']
  const later = snapshot.rows[0].outcomes.plus7d
  later.call = 'evm-revert'
  later.status = 'evm-revert'
  const result = summarizeVerified(seal(snapshot), plan)
  assert.equal(result.rows[0].classification, 'ambiguous-right-censor')
  assert.equal(result.rows[0].episode.stopReason, 'ambiguous-censor')
  assert.equal(result.rows[0].episode.firstObservedRevert, null)
  assert.equal(result.rows[0].samples[1].kind, 'clean-simulated-revert')
  assert.equal(result.rows[0].samples[1].comparableAtSample, false)
  assert.equal(result.counts.cleanRevertSamples, 1)
  assert.equal(result.counts.firstObservedRevertIntervals, 0)
})

test('missing intermediate target blocks later revert interval', () => {
  const snapshot = clone()
  const row = snapshot.rows[0]
  delete row.outcomes.plus24h
  row.outcomes.plus7d.call = 'evm-revert'
  row.outcomes.plus7d.status = 'evm-revert'
  row.status = 'partial'
  const result = summarizeVerified(seal(snapshot), plan)
  assert.equal(result.rows[0].classification, 'pending-follow-up')
  assert.equal(result.rows[0].samples[0].kind, 'missing')
  assert.equal(result.rows[0].samples[1].comparableAtSample, false)
  assert.equal(result.counts.firstObservedRevertIntervals, 0)
  assert.equal(result.counts.missingSamples, 115)
})

test('revert after holder share attrition is censored, not a clean failure', () => {
  const snapshot = clone()
  const probe = snapshot.rows[0].outcomes.plus7d
  probe.call = 'evm-revert'
  probe.status = 'censored'
  probe.holderClaimAssets = '0'
  probe.censoring = ['holder-claim-below-frozen-q']
  const result = summarizeVerified(seal(snapshot), plan)
  assert.equal(result.rows[0].classification, 'ambiguous-right-censor')
  assert.equal(result.counts.cleanRevertSamples, 0)
  assert.equal(result.counts.ambiguousSamples, 1)
})

test('not-finalized future sample is pending with measured earlier success', () => {
  const snapshot = clone()
  const row = snapshot.rows[0]
  const target = row.outcomes.plus7d.targetTimestamp
  row.outcomes.plus7d = {
    status: 'not-finalized',
    targetTimestamp: target,
    finalizedHead: { timestamp: target - 1 },
  }
  row.status = 'partial'
  const result = summarizeVerified(seal(snapshot), plan)
  assert.equal(result.rows[0].classification, 'pending-follow-up')
  assert.equal(result.rows[0].samples[1].kind, 'not-finalized')
  assert.equal(result.counts.notFinalizedSamples, 1)
})

test('checksum and frozen source assertions run before summary', () => {
  const snapshot = clone()
  snapshot.rows[0].holder = snapshot.rows[1].holder
  assert.throws(() => summarizeVerified(snapshot, plan), /checksum/i)
  assert.throws(() => summarizeVerified(seal(snapshot), plan), /frozen row 0 holder/i)
})
