// Offline, retrospective availability fold. Never starts a provider or a job.
import { createHash } from 'node:crypto'
import { constants, closeSync, fstatSync, fsyncSync, openSync, readFileSync, statfsSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { replayCapacityHistoryPair } from './carry-holder-capacity-history.mjs'
import { qLadder, verifyIssues, verifyScores } from './carry-fluid-ftoken-holder.mjs'

export const SCHEMA = 'fluid-retained-holder-availability-backtest-v1'
export const OUTPUT = 'data/research/venue-signals/fluid-retained-holder-backtest-2026-10-08.json'
const DIR = 'data/research/venue-signals/'
export const PINS = Object.freeze({
  receipt: { path: DIR + 'historical-holder-capacity-fluid-usdc-0-1-1-2026-10-07.json', fileSha256: '39608066dd4219595cdb598f5012492cf0d405afa94fbdd3db8a029b814bbda5', contentSha256: '58065f51a8ef2de7519c9afb3670faed976926ab287322e63becfec1490b0865' },
  issue: { path: DIR + 'local-fluid-ftoken-holder-v1/issues/0/00000001.json', fileSha256: '147a6e0bacde2c8a6b32a0fd81d1b6f35fa6dc0a771731c0ca62e080abf05c9b', contentSha256: '7eca409a5963ecfb9def592f5070df756366e76a9613f7c70b03245820cb1fab' },
  score: { path: DIR + 'local-fluid-ftoken-holder-v1/scores/0/00000001.json', fileSha256: 'f9c892409e13915313bd72a875cccd8312700b7fcf8c430ec445696613b4661e', contentSha256: 'ba171b58779ce681116c50a09fa4ec52f25e750cf24d90deb45477f54aa4e1a6' },
  protocol: { path: DIR + 'fluid-protocol-capacity-history-usdc-oct2-2026-10-07.export.json', fileSha256: 'f3911dd6361017f901a12654c83823de78b66e6219036d8eb1b3b66ee6802cf6', contentSha256: '7c6a1e1c0111aa5aa3a81d769e556bf00a8eaa23271bb09644c7bca707115a68' },
})
const MAX_INPUT_BYTES = 9 * 1024 * 1024
const MAX_REPORT_BYTES = 256 * 1024
const RESERVE_BYTES = 256n * 1024n ** 2n
const check = (ok, reason) => { if (!ok) throw Error(reason) }
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
export const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const seal = (value) => ({ ...value, sha256: digest(value) })
const uint = (v) => typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) < 1n << 256n
const utc = (v) => typeof v === 'string' && Number.isSafeInteger(Date.parse(v)) && new Date(Date.parse(v)).toISOString() === v
function verifySeal(value, kind) {
  check(value && typeof value === 'object', kind + '_missing')
  const { sha256, ...body } = value
  check(/^[a-f0-9]{64}$/.test(sha256 ?? '') && digest(body) === sha256, kind + '_integrity')
}
const sourceOf = (v) => ({ blockNumber: v.number, blockHash: v.hash, blockTime: v.atUtc })

// The locator carries a horizon, not a case identity. Reconstruct it from the
// original sealed issue/score and retain EVERY original Q, without selecting an
// outcome or asserting that any research size was an original user's intent.
export function candidateFromOriginal(issue, score) {
  return {
    id: `${issue.routeIndex}:${issue.sequence}:${score.horizonHours}`,
    routeIndex: issue.routeIndex, routeKey: issue.routeKey, destination: issue.vault,
    asset: issue.asset, assetDecimals: issue.identity.assetDecimals, owner: issue.holder,
    plannedHorizonHours: score.horizonHours, issueSha256: issue.sha256, scoreSha256: score.sha256,
    baseline: { source: sourceOf(issue.baseline), summary: issue.position },
    target: { source: sourceOf(score.block), summary: score.positionAtTarget },
    locatorStatus: score.positionAtTarget.sharesRaw === issue.position.sharesRaw ? 'same_shares_candidate' : 'shares_changed',
    summaryOnly: true, oldRequestedQProof: 'not_revalidated',
    oldSummaryNormalizedChange: {
      numeratorRaw: (BigInt(score.positionAtTarget.maxWithdrawRaw) * BigInt(issue.position.claimAssetsRaw) - BigInt(issue.position.maxWithdrawRaw) * BigInt(score.positionAtTarget.claimAssetsRaw)).toString(),
      denominatorRaw: (BigInt(score.positionAtTarget.claimAssetsRaw) * BigInt(issue.position.claimAssetsRaw)).toString(),
    },
  }
}

function validateOriginal(issue, score) {
  verifySeal(issue, 'issue'); verifySeal(score, 'score')
  check(issue.study === 'fluid_ftoken_holder_issue_v1' && issue.routeIndex === 0 && issue.sequence === 1 && issue.previousSha256 === null, 'issue_identity')
  check(score.study === 'fluid_ftoken_holder_score_v1' && score.routeIndex === issue.routeIndex && score.issueSequence === issue.sequence && score.horizonHours === 1 && score.sequence === 1 && score.previousSha256 === null && score.issueSha256 === issue.sha256 && score.status === 'measured', 'score_identity')
  check(score.routeKey === issue.routeKey && equal(score.identity, issue.identity), 'original_identity_mismatch')
  check(uint(issue.position?.claimAssetsRaw) && uint(issue.position?.sharesRaw) && uint(issue.position?.maxWithdrawRaw) && BigInt(issue.position.claimAssetsRaw) > 0n, 'original_position')
  check(Array.isArray(issue.cases) && issue.cases.length > 0 && issue.cases.length <= 5 && equal(issue.cases.map(({label, assetsRaw}) => ({label, assetsRaw})), qLadder(issue.position.claimAssetsRaw)), 'original_q_ladder')
  check(Array.isArray(score.cases) && equal(score.cases.map(({label, assetsRaw}) => ({label, assetsRaw})), issue.cases.map(({label, assetsRaw}) => ({label, assetsRaw}))), 'score_q_identity')
  const target = issue.targets?.find((v) => v.horizonHours === score.horizonHours)
  check(utc(issue.issuedAtUtc) && utc(score.scoredAtUtc) && utc(issue.baseline.atUtc) && utc(score.block.atUtc) && issue.baseline.atUtc === new Date(issue.baseline.timestamp * 1000).toISOString() && score.block.atUtc === new Date(score.block.timestamp * 1000).toISOString(), 'original_clock')
  check(target && score.targetAtUtc === target.targetAtUtc && target.targetAtUtc === new Date(Date.parse(issue.issuedAtUtc) + 3600000).toISOString() && Date.parse(score.block.atUtc) >= Date.parse(target.targetAtUtc) && Date.parse(score.block.atUtc) <= Date.parse(target.deadlineUtc) && Date.parse(score.scoredAtUtc) <= Date.parse(target.deadlineUtc), 'original_target_clock')
  check(Date.parse(issue.baseline.atUtc) <= Date.parse(issue.issuedAtUtc) && Date.parse(issue.issuedAtUtc) < Date.parse(score.block.atUtc), 'original_source_future')
}

export function assessCase({ label, assetsRaw }, baseline, target, elapsedSeconds) {
  check(uint(assetsRaw) && BigInt(assetsRaw) > 0n, 'invalid_q')
  check(Number.isSafeInteger(elapsedSeconds) && elapsedSeconds > 0, 'invalid_elapsed')
  const Q = BigInt(assetsRaw)
  const at = (snapshot) => {
    const E = BigInt(snapshot.entitlementRaw), limit = BigInt(snapshot.quotedMaxWithdrawRaw)
    const bound = E < limit ? E : limit
    return { fullEntitlementRaw: E.toString(), quotedMaxWithdrawRaw: limit.toString(), conditionalAvailabilityBoundRaw: bound.toString(), headroomRaw: (bound - Q).toString(), qCovered: bound >= Q, entitlementCovered: E >= Q, quotedLimitCovered: limit >= Q }
  }
  const source = at(baseline), outcome = at(target)
  const delta = BigInt(outcome.headroomRaw) - BigInt(source.headroomRaw)
  const error = BigInt(source.headroomRaw) - BigInt(outcome.headroomRaw)
  return {
    originalCaseLabel: label, frozenRequestedQRaw: assetsRaw,
    caseIdentity: `0:1:1:${label}`, source, outcome,
    sampledHeadroomDeltaRaw: delta.toString(), shrinking: delta < 0n,
    sampledHeadroomDeltaPerSecond: { numeratorRaw: delta.toString(), denominatorSeconds: elapsedSeconds },
    persistenceForecast: { model: 'source_headroom_persistence', issuedRetrospectively: true, usesOnlySourceEndpoint: true, elapsedSeconds, forecastHeadroomRaw: source.headroomRaw, observedTargetHeadroomRaw: outcome.headroomRaw, signedErrorRaw: error.toString(), errorConvention: 'forecast_minus_observed', absoluteErrorRaw: (error < 0n ? -error : error).toString(), sourcePredictedQCovered: source.qCovered, targetQCovered: outcome.qCovered, coveragePredictionCorrect: source.qCovered === outcome.qCovered },
    sampledRestrictions: source.qCovered && outcome.qCovered ? 'none_observed_at_two_getter_endpoints' : 'q_unavailable_at_one_or_both_getter_endpoints',
    continuousAvailability: 'unknown_between_samples',
    availabilityDurationSeconds: null,
    durationObservation: { status: 'interval_censored_between_endpoints', intervalSeconds: elapsedSeconds, continuousSuccessProved: false },
    firstRestrictionTime: { status: 'unknown_between_samples', value: null, noRestrictionThroughoutIntervalProved: false },
    sampledFirstRestrictionTime: { status: source.qCovered && outcome.qCovered ? 'right_censored_at_target_sample' : source.qCovered ? 'interval_censored_between_endpoints' : 'present_at_source_sample', value: null, onlyDescribesSampledGrid: true },
    recovery: { status: 'unknown_no_observed_restriction_transition', recoverySeconds: null },
  }
}

export function buildBacktest({ receipt, issue, score, protocol, provenance = null }, analysisAt) {
  validateOriginal(issue, score)
  check(issue.sha256 === PINS.issue.contentSha256 && score.sha256 === PINS.score.contentSha256, 'original_content_pin')
  check(utc(analysisAt) && analysisAt.startsWith('2026-10-08T'), 'analysis_clock')
  verifySeal(receipt, 'receipt'); verifySeal(protocol, 'protocol')
  const candidate = candidateFromOriginal(issue, score)
  check(equal(candidate, receipt.candidate), 'candidate_original_binding')
  const replay = replayCapacityHistoryPair(receipt, [candidate])
  check(replay.status === 'verified_historical_holder_getter_pair', 'native_replay_' + replay.reason)
  check(replay.fullEntitlementSourceSimulationsVerified && replay.baseline.fullEntitlementSimulation.requestedRaw === replay.baseline.entitlementRaw && replay.target.fullEntitlementSimulation.requestedRaw === replay.target.entitlementRaw, 'full_entitlement_simulation_unverified')
  check(replay.summaryComparison.every((v) => v.sharesMatch && v.entitlementMatch && v.maxWithdrawMatch), 'original_summary_raw_mismatch')
  check(Date.parse(receipt.startedAt) >= Date.parse(replay.target.source.blockTime) && Date.parse(receipt.capturedAt) <= Date.parse(analysisAt) && Date.parse(score.scoredAtUtc) <= Date.parse(receipt.startedAt), 'acquisition_clock')
  const actualElapsedSeconds = (Date.parse(replay.target.source.blockTime) - Date.parse(replay.baseline.source.blockTime)) / 1000
  check(Number.isSafeInteger(actualElapsedSeconds) && actualElapsedSeconds === replay.actualElapsedSeconds, 'actual_elapsed_mismatch')
  const subject = { routeKey: replay.routeKey, destination: replay.destination, asset: replay.asset, assetDecimals: replay.assetDecimals }
  check(equal(protocol.subject, subject), 'protocol_subject_mismatch')
  check(Array.isArray(protocol.sourceEvidence) && protocol.sourceEvidence.length === 2 && protocol.sourceEvidence.every((v) => utc(v.blockTime) && v.blockNumber > replay.target.source.blockNumber && Date.parse(v.blockTime) > Date.parse(replay.target.source.blockTime)), 'protocol_future_exclusion_binding')
  check(receipt.sha256 === PINS.receipt.contentSha256 && protocol.sha256 === PINS.protocol.contentSha256, 'retained_content_pin')
  check(provenance === null || equal(provenance, Object.fromEntries(Object.entries(PINS).map(([k, v]) => [k, { ...v, authority: k === 'protocol' ? 'future_source_exclusion_only' : 'retained_raw_receipt_or_original_ledger' }]))), 'provenance_binding')
  const fullEntitlementDeltaRaw = (BigInt(replay.target.entitlementRaw) - BigInt(replay.baseline.entitlementRaw)).toString()
  const report = {
    schema: SCHEMA, status: 'retrospective_conditional_holder_getter_availability_fold',
    analysisAt, scope: { holderFolds: 1, originalFrozenResearchSizeCases: issue.cases.length, casesAreCorrelated: true, routeCoverage: 'one_fluid_usdc_holder_pair_only', all25RouteQualification: false, all25ScopePreserved: true },
    clocks: { originalIssuedAt: issue.issuedAtUtc, originalScoredAt: score.scoredAtUtc, historicalSourceAt: replay.baseline.source.blockTime, historicalOutcomeAt: replay.target.source.blockTime, nativeAcquisitionStartedAt: receipt.startedAt, nativeAcquisitionCompletedAt: receipt.capturedAt, analysisAt, plannedHorizonSeconds: candidate.plannedHorizonHours * 3600, actualElapsedSeconds, issueToTargetSeconds: (Date.parse(replay.target.source.blockTime) - Date.parse(issue.issuedAtUtc)) / 1000, prospectiveIssue: false },
    provenance: provenance ?? { receipt: { contentSha256: receipt.sha256 }, issue: { contentSha256: issue.sha256 }, score: { contentSha256: score.sha256 }, protocol: { contentSha256: protocol.sha256 } },
    originalBinding: { candidateId: candidate.id, candidateSha256: digest(candidate), issueSequence: issue.sequence, scoreSequence: score.sequence, issueSha256: issue.sha256, scoreSha256: score.sha256, originalCaseResolution: 'all_original_source_frozen_ladder_cases_no_hindsight_selection', originalUserRequestedCaseKnown: false, originalCaseLabels: issue.cases.map((c) => c.label) },
    subject: { ...subject, chainId: 1, owner: replay.owner, sharesRaw: replay.sharesRaw, shareDecimals: replay.baseline.shareDecimals },
    rawNativeReplay: { status: replay.status, source: replay.baseline, outcome: replay.target, captureReceiptSha256: replay.captureReceiptSha256, summaryComparison: replay.summaryComparison, completeReceiptReplayed: true, origins: receipt.origins, physicalRequestStarts: receipt.budget.physicalRequestStarts, fullEntitlementSourceSimulationsVerified: true },
    fullEntitlementGrowth: { sourceFullEntitlementRaw: replay.baseline.entitlementRaw, outcomeFullEntitlementRaw: replay.target.entitlementRaw, deltaRaw: fullEntitlementDeltaRaw, increasing: BigInt(fullEntitlementDeltaRaw) > 0n, independentOfRequestedQ: true, method: 'previewRedeem_entire_unchanged_share_balance_at_each_endpoint' },
    queueSemantics: { MRaw: null, status: 'unknown_unattested', implementationSourceAttested: false, sameObservedEip1967Identity: replay.sameObservedContractIdentity, observedVaultRuntimeCodeHashUnchanged: replay.baseline.mechanismIdentity.vaultRuntimeCodeHash === replay.target.mechanismIdentity.vaultRuntimeCodeHash, queueZeroAssumed: false },
    protocolModel: { status: 'censored_future_protocol_sources', earliestProtocolSourceAt: protocol.sourceEvidence[0].blockTime, sourceEvidence: protocol.sourceEvidence, competingFlowRaw: null, C: null, S: null, W: null, netCompetingFlowSubtracted: false, probabilisticModel: 'censored_no_asof_protocol_process', forwardProbability: null, reason: 'oct2_protocol_samples_postdate_oct1_holder_source_and_outcome' },
    cases: issue.cases.map((c) => assessCase(c, replay.baseline, replay.target, actualElapsedSeconds)),
    interpretation: { target: 'conditional_getter_availability_only', fullHolderAvailability: 'bound_min_full_entitlement_maxWithdraw_then_subtract_each_frozen_Q_once', continuousAvailability: 'unknown_between_samples', futureAvailability: 'not_established', execution: 'not_observed', minedPayment: 'not_observed', fixedQNativeWithdrawReplay: 'not_revalidated_by_full_entitlement_receipt', originalQAssays: 'sealed_original_issue_score_summaries_not_new_native_Q_calls', restrictionsAndRecovery: 'two_endpoints_do_not_identify_intervening_restrictions_or_recovery', prospectiveValidated: false, holderExecutableExit: false, paymentObserved: false, normalizationApplied: false },
  }
  return seal(report)
}

export function readPinnedInput(root, pin) {
  const path = resolve(root, pin.path), fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    check(stat.isFile() && stat.size > 0 && stat.size <= MAX_INPUT_BYTES, 'input_size_or_kind')
    const bytes = readFileSync(fd), after = fstatSync(fd)
    check(stat.size === bytes.length && stat.size === after.size && stat.mtimeMs === after.mtimeMs && stat.ino === after.ino, 'input_changed')
    check(createHash('sha256').update(bytes).digest('hex') === pin.fileSha256, 'input_file_hash')
    const value = JSON.parse(bytes.toString('utf8'))
    verifySeal(value, 'input')
    check(value.sha256 === pin.contentSha256, 'input_content_pin')
    return value
  } finally { closeSync(fd) }
}

export function loadRetainedInputs(root = process.cwd()) {
  const inputs = {}
  for (const [kind, pin] of Object.entries(PINS)) inputs[kind] = readPinnedInput(root, pin)
  // Existing original ledger verification also checks discovery witnesses,
  // ladder assays, source clocks, linked sequence seals, and score eligibility.
  const issues = verifyIssues(0, resolve(root, DIR + 'local-fluid-ftoken-holder-v1/issues/0'))
  const scores = verifyScores(0, issues, resolve(root, DIR + 'local-fluid-ftoken-holder-v1/scores/0'))
  check(equal(issues[0], inputs.issue) && equal(scores.find((s) => s.sha256 === inputs.score.sha256), inputs.score), 'original_ledger_verification')
  inputs.provenance = Object.fromEntries(Object.entries(PINS).map(([k, v]) => [k, { ...v, authority: k === 'protocol' ? 'future_source_exclusion_only' : 'retained_raw_receipt_or_original_ledger' }]))
  return inputs
}

export function writeReportExclusive(path, report) {
  verifySeal(report, 'report')
  const bytes = Buffer.from(JSON.stringify(report, null, 2) + '\n')
  check(bytes.length <= MAX_REPORT_BYTES, 'report_oversize')
  const disk = statfsSync(dirname(resolve(path)), { bigint: true })
  check(disk.bavail * disk.bsize - BigInt(bytes.length) >= RESERVE_BYTES, 'disk_reserve')
  // Exclusive create preserves existing outputs; 0600 is never broadened.
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
  return { path: resolve(path), bytes: bytes.length, fileSha256: createHash('sha256').update(bytes).digest('hex'), contentSha256: report.sha256 }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, analysisAt, output = OUTPUT] = process.argv.slice(2)
    check(mode === 'write' || mode === 'verify', 'usage_write_or_verify_analysisAt_output')
    const report = buildBacktest(loadRetainedInputs(), analysisAt)
    if (mode === 'write') console.log(JSON.stringify(writeReportExclusive(output, report)))
    else console.log(JSON.stringify({ schema: report.schema, contentSha256: report.sha256, folds: 1, cases: report.cases.length, actualElapsedSeconds: report.clocks.actualElapsedSeconds }))
  } catch (error) { console.error('fluid_retained_backtest_' + error.message); process.exitCode = 1 }
}
