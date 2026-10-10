import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { encodeFunctionResult, parseAbi } from 'viem'
import { replayCapacityHistoryPair } from '../../scripts/research/carry-holder-capacity-history.mjs'
import { assessCase, buildBacktest, candidateFromOriginal, digest, loadRetainedInputs, PINS, readPinnedInput, seal, writeReportExclusive } from '../../scripts/research/fluid-retained-holder-backtest.mjs'

const INPUT = loadRetainedInputs(resolve(import.meta.dirname, '../..'))
const AT = '2026-10-08T04:50:13.000Z'
const clone = () => structuredClone(INPUT)
const reseal = (v) => { delete v.sha256; v.sha256 = digest(v); return v }
const ABI = parseAbi(['function balanceOf(address) view returns (uint256)', 'function previewRedeem(uint256) view returns (uint256)'])

test('complete retained raw replay binds independent full E and all five original correlated frozen Qs', () => {
  const report = buildBacktest(INPUT, AT)
  assert.equal(report.sha256, digest(Object.fromEntries(Object.entries(report).filter(([key]) => key !== 'sha256'))))
  assert.equal(report.scope.holderFolds, 1)
  assert.equal(report.scope.originalFrozenResearchSizeCases, 5)
  assert.equal(report.scope.casesAreCorrelated, true)
  assert.equal(report.scope.all25RouteQualification, false)
  assert.equal(report.scope.all25ScopePreserved, true)
  assert.equal(report.subject.sharesRaw, '8245195471')
  assert.equal(report.rawNativeReplay.completeReceiptReplayed, true)
  assert.equal(report.rawNativeReplay.physicalRequestStarts, 52)
  assert.equal(report.rawNativeReplay.source.source.blockNumber, 26096246)
  assert.equal(report.rawNativeReplay.outcome.source.blockNumber, 26096637)
  assert.deepEqual(report.cases.map((v) => [v.originalCaseLabel, v.frozenRequestedQRaw]), INPUT.issue.cases.map((v) => [v.label, v.assetsRaw]))
  assert.deepEqual(report.fullEntitlementGrowth, {
    sourceFullEntitlementRaw: '10048495305', outcomeFullEntitlementRaw: '10048575783', deltaRaw: '80478', increasing: true, independentOfRequestedQ: true,
    method: 'previewRedeem_entire_unchanged_share_balance_at_each_endpoint',
  })
  assert.notEqual(report.cases[0].frozenRequestedQRaw, report.fullEntitlementGrowth.sourceFullEntitlementRaw)
  assert.equal(report.cases[4].frozenRequestedQRaw, report.fullEntitlementGrowth.sourceFullEntitlementRaw)
})

test('headroom subtracts frozen Q exactly once; independent persistence arithmetic uses actual 4728 seconds', () => {
  const report = buildBacktest(INPUT, AT)
  assert.equal(report.clocks.plannedHorizonSeconds, 3600)
  assert.equal(report.clocks.actualElapsedSeconds, 4728)
  assert.equal(report.clocks.issueToTargetSeconds, 3603.94)
  for (const c of report.cases) {
    const Q = BigInt(c.frozenRequestedQRaw)
    assert.equal(c.source.conditionalAvailabilityBoundRaw, '10048495305')
    assert.equal(c.source.headroomRaw, (10048495305n - Q).toString())
    assert.equal(c.outcome.headroomRaw, (10048575783n - Q).toString())
    assert.equal(c.sampledHeadroomDeltaRaw, '80478')
    assert.equal(c.shrinking, false)
    assert.deepEqual(c.sampledHeadroomDeltaPerSecond, { numeratorRaw: '80478', denominatorSeconds: 4728 })
    assert.equal(c.persistenceForecast.elapsedSeconds, 4728)
    assert.equal(c.persistenceForecast.signedErrorRaw, '-80478')
    assert.equal(c.persistenceForecast.absoluteErrorRaw, '80478')
    assert.equal(c.persistenceForecast.targetQCovered, true)
  }
  assert.equal(report.cases[4].source.headroomRaw, '0')
  assert.equal(report.cases[4].outcome.headroomRaw, '80478')
})

test('known quote bounds retain failed Q, independently growing E, and actual shrinking headroom', () => {
  const b = { entitlementRaw: '100', quotedMaxWithdrawRaw: '90' }
  const t = { entitlementRaw: '120', quotedMaxWithdrawRaw: '70' }
  const c = assessCase({ label: 'fixture_fixed_q', assetsRaw: '95' }, b, t, 4728)
  assert.equal(c.source.conditionalAvailabilityBoundRaw, '90')
  assert.equal(c.source.headroomRaw, '-5')
  assert.equal(c.outcome.headroomRaw, '-25')
  assert.equal(c.sampledHeadroomDeltaRaw, '-20')
  assert.equal(c.shrinking, true)
  assert.equal(c.source.entitlementCovered, true)
  assert.equal(c.source.quotedLimitCovered, false)
  assert.equal(c.persistenceForecast.signedErrorRaw, '20')
  const overE = assessCase({label: 'fixture_q_above_E', assetsRaw: '101'}, b, t, 4728)
  assert.equal(overE.source.entitlementCovered, false)
  assert.equal(overE.source.qCovered, false)
})

test('M remains unknown despite successful endpoints; recovery and continuous duration are censored', () => {
  const r = buildBacktest(INPUT, AT)
  assert.equal(r.queueSemantics.MRaw, null)
  assert.equal(r.queueSemantics.status, 'unknown_unattested')
  assert.equal(r.queueSemantics.queueZeroAssumed, false)
  assert.equal(r.queueSemantics.implementationSourceAttested, false)
  for (const c of r.cases) {
    assert.equal(c.continuousAvailability, 'unknown_between_samples')
    assert.equal(c.availabilityDurationSeconds, null)
    assert.equal(c.durationObservation.intervalSeconds, 4728)
    assert.equal(c.durationObservation.continuousSuccessProved, false)
    assert.equal(c.firstRestrictionTime.status, 'unknown_between_samples')
    assert.equal(c.sampledFirstRestrictionTime.status, 'right_censored_at_target_sample')
    assert.equal(c.firstRestrictionTime.noRestrictionThroughoutIntervalProved, false)
    assert.equal(c.recovery.recoverySeconds, null)
  }
  assert.equal(r.interpretation.holderExecutableExit, false)
  assert.equal(r.interpretation.paymentObserved, false)
  assert.equal(r.interpretation.prospectiveValidated, false)
  assert.equal(r.interpretation.fixedQNativeWithdrawReplay, 'not_revalidated_by_full_entitlement_receipt')
})

test('future Oct2 protocol C/S/W and probabilistic competing flow cannot join the Oct1 fold', () => {
  const r = buildBacktest(INPUT, AT)
  assert.equal(r.protocolModel.status, 'censored_future_protocol_sources')
  assert.equal(r.protocolModel.earliestProtocolSourceAt, '2026-10-02T04:13:11.000Z')
  for (const key of ['C', 'S', 'W', 'competingFlowRaw', 'forwardProbability']) assert.equal(r.protocolModel[key], null)
  assert.equal(r.protocolModel.netCompetingFlowSubtracted, false)
  const bad = clone(); bad.protocol.sourceEvidence[0].blockTime = INPUT.receipt.candidate.baseline.source.blockTime
  reseal(bad.protocol)
  assert.throws(() => buildBacktest(bad, AT), /protocol_future_exclusion_binding/)
})

test('original issue/score hash and source-frozen ladder corruption are rejected', () => {
  const hash = clone(); hash.issue.cases[0].assetsRaw = '1'
  assert.throws(() => buildBacktest(hash, AT), /issue_integrity/)
  const ladder = clone(); ladder.issue.cases[0].assetsRaw = '1'; reseal(ladder.issue); ladder.score.issueSha256 = ladder.issue.sha256; reseal(ladder.score)
  assert.throws(() => buildBacktest(ladder, AT), /original_q_ladder/)
  const identity = clone(); identity.score.cases[0].label = 'different_case'; reseal(identity.score)
  assert.throws(() => buildBacktest(identity, AT), /score_q_identity/)
  const future = clone(); future.issue.issuedAtUtc = '2026-10-02T08:41:31.060Z'; reseal(future.issue); future.score.issueSha256 = future.issue.sha256; reseal(future.score)
  assert.throws(() => buildBacktest(future, AT), /original_target_clock|original_source_future/)
})

test('source mismatch and changed share identity are rejected rather than borrowing original summary', () => {
  const mismatch = clone(); mismatch.receipt.candidate.baseline.source.blockHash = '0x' + '1'.repeat(64); reseal(mismatch.receipt)
  assert.throws(() => buildBacktest(mismatch, AT), /candidate_original_binding/)
  const changed = clone(); changed.score.positionAtTarget.sharesRaw = '8245195472'; reseal(changed.score)
  assert.throws(() => buildBacktest(changed, AT), /original_content_pin/)
  // Also test the native decoder after both raw origins agree on changed shares.
  const raw = clone().receipt
  for (const tr of raw.traces.filter((v) => v.phase === 'target:balance')) tr.response.result = encodeFunctionResult({ abi: ABI, functionName: 'balanceOf', result: 8245195472n })
  reseal(raw)
  const replay = replayCapacityHistoryPair(raw, [candidateFromOriginal(INPUT.issue, INPUT.score)])
  assert.equal(replay.status, 'censored_historical_holder_getter_pair')
  assert.ok(['request_binding', 'position_changed'].includes(replay.reason), replay.reason)
})

test('raw full-entitlement attestation, receipt seal, and missing simulation are strict controls', () => {
  const corrupt = clone(); corrupt.receipt.traces.find((v) => v.phase === 'baseline:entitlement').response.result = '0x00'
  assert.throws(() => buildBacktest(corrupt, AT), /receipt_integrity/)
  reseal(corrupt.receipt)
  assert.throws(() => buildBacktest(corrupt, AT), /native_replay_/)
  const absent = clone(); absent.receipt.simulateFullEntitlement = false
  absent.receipt.traces = absent.receipt.traces.filter((v) => !/(owner_code|withdraw_full_entitlement)$/.test(v.phase))
  absent.receipt.traces.forEach((v, index) => { v.request.id = index + 1; if (v.response) v.response.id = index + 1 })
  absent.receipt.budget.physicalRequestStarts = absent.receipt.traces.length
  reseal(absent.receipt)
  assert.throws(() => buildBacktest(absent, AT), /full_entitlement_simulation_unverified/)
  const forgedQ = clone(); forgedQ.receipt.candidate.issueSha256 = 'f'.repeat(64); reseal(forgedQ.receipt)
  assert.throws(() => buildBacktest(forgedQ, AT), /candidate_original_binding/)
})

test('acquisition and analysis clocks do not relabel archival Oct1 samples as prospective Oct8 samples', () => {
  const r = buildBacktest(INPUT, AT)
  assert.equal(r.clocks.historicalSourceAt, '2026-10-01T08:22:47.000Z')
  assert.equal(r.clocks.nativeAcquisitionCompletedAt, '2026-10-07T10:56:39.249Z')
  assert.equal(r.clocks.analysisAt, AT)
  assert.equal(r.clocks.prospectiveIssue, false)
  assert.throws(() => buildBacktest(INPUT, '2026-10-07T04:50:13.000Z'), /analysis_clock/)
  const early = clone(); early.receipt.startedAt = '2026-09-30T10:56:37.586Z'; reseal(early.receipt)
  assert.throws(() => buildBacktest(early, AT), /native_replay_|acquisition_clock/)
})

test('pinned source reader rejects byte-hash tampering and symlinks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fluid-holder-read-control-'))
  const value = seal({ example: 1 }), bytes = JSON.stringify(value) + '\n'
  writeFileSync(join(dir, 'proof.json'), bytes, { flag: 'wx', mode: 0o600 })
  const pin = { path: 'proof.json', fileSha256: createHash('sha256').update(bytes).digest('hex'), contentSha256: value.sha256 }
  assert.deepEqual(readPinnedInput(dir, pin), value)
  assert.throws(() => readPinnedInput(dir, { ...pin, fileSha256: PINS.issue.fileSha256 }), /input_file_hash/)
  symlinkSync(join(dir, 'proof.json'), join(dir, 'link.json'))
  assert.throws(() => readPinnedInput(dir, { ...pin, path: 'link.json' }), /ELOOP/)
})

test('exclusive sealed writer is bounded, mode 0600, and preserves an existing report byte for byte', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fluid-holder-writer-control-')), path = join(dir, 'report.json')
  const r = buildBacktest(INPUT, AT), written = writeReportExclusive(path, r), before = readFileSync(path)
  assert.equal(written.contentSha256, r.sha256)
  assert.equal(written.bytes, before.length)
  assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.throws(() => writeReportExclusive(path, r), /EEXIST/)
  assert.deepEqual(readFileSync(path), before)
  assert.throws(() => writeReportExclusive(join(dir, 'oversized.json'), seal({ padding: 'x'.repeat(256 * 1024) })), /report_oversize/)
})
