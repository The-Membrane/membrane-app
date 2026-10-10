// Offline retrospective scenario/error fold. No RPC, jobs, or target fitting.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildBacktest, digest, loadRetainedInputs, readPinnedInput, seal, writeReportExclusive } from './fluid-retained-holder-backtest.mjs'
import { replayProtocolCapacityPair } from './carry-protocol-capacity-history.mjs'
import { replayFluidCapacityProngs } from './carry-fluid-capacity-prongs.mjs'

export const OUTPUT = 'data/research/venue-signals/fluid-aligned-holder-flow-backtest-2026-10-08.json'
export const CAPTURE_ROOT = fileURLToPath(new URL('../../data/research/venue-signals/fluid-aligned-history-evidence-2026-10-08/', import.meta.url))
export const CAPTURE_PINS = Object.freeze({
  plan: { path: 'frozen-plan-v5.json', fileSha256: '3f0262c128dfbe4ac773a3b46f03edf915e4773012236199c13107caa1f84c11', contentSha256: '42b56ba3e6c3cede7c5aa894d386fc848f309409c00a27cb83f6af3afa2adce2' },
  trainingReceipt: { path: 'v2-training.receipt.json', fileSha256: 'de7a2499ac0e16937e46120a332eac4c6f5372fff24427acb78623aef7575e47', contentSha256: '5c6757976cc01410d4dfbdd9b3e868515be533386e06e56d7f400c4d6aa0ab8d' },
  training: { path: 'v2-training.export.json', fileSha256: 'cba7c678cafb3686b5e1f05d312499b99e43f27697a6013ce3660c429e9de703', contentSha256: '283e94e5cc3b0c30bad8b2397931837a5633ae652ad4fa0dee680f631647e3d3' },
  holdoutReceipt: { path: 'v2-holdout.receipt.json', fileSha256: 'e53d61be167ee7552cbf501c351815fd4edda2078f959bd066981c52c50a9298', contentSha256: 'b48a31afcd838b11485b73f4684225be75fdd60fa6559daaa7953bb81c93aea5' },
  holdout: { path: 'v2-holdout.export.json', fileSha256: '4257a3f799a3c342128b45eb1fb9308ffc51c655a959f8f7ad047a60a4bd7151', contentSha256: '742ea6e56e83fe4136e590c3ef8044fd88ab236ff130d5fc57a324e433cd7fb8' },
})
const check = (ok, reason) => { if (!ok) throw Error(reason) }
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const MAX = (1n << 256n) - 1n
const uint = v => { check(typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) <= MAX, 'native_uint'); return BigInt(v) }
const signed = v => { check(typeof v === 'string' && /^-?(0|[1-9][0-9]{0,77})$/.test(v) && v !== '-0' && BigInt(v) >= -MAX && BigInt(v) <= MAX, 'native_signed'); return BigInt(v) }
const verifySeal = v => { const { sha256, ...body } = v; check(digest(body) === sha256, 'input_seal') }
const keys = { C: 'sharedLiquidityCashRaw', S: 'resolverSupplyRaw', W: 'expandedWithdrawalLimitRaw' }
export function nativeProngs(value) { return Object.fromEntries(Object.entries(keys).map(([key, field]) => [key, uint(value[field]).toString()])) }
export function projectProngs(source, donorDelta, elapsedSeconds, donorSeconds) {
  check(Number.isSafeInteger(elapsedSeconds) && elapsedSeconds > 0 && Number.isSafeInteger(donorSeconds) && donorSeconds > 0, 'duration')
  const projected = {}, scaledDelta = {}
  for (const key of Object.keys(keys)) {
    const delta = signed(donorDelta[key]) * BigInt(elapsedSeconds) / BigInt(donorSeconds)
    const value = uint(source[key]) + delta, stock = value < 0n ? 0n : value
    check(stock <= MAX, 'projected_stock_overflow')
    scaledDelta[key] = delta.toString(); projected[key] = stock.toString()
  }
  return { projected, scaledDelta, rounding: 'signed_ratio_truncated_toward_zero_then_physical_stocks_floored_at_zero' }
}
export function holderBound(fullEaRaw, prongs) {
  const Ea = uint(fullEaRaw), C = uint(prongs.C), S = uint(prongs.S), W = uint(prongs.W)
  const unlocked = S > W ? S - W : 0n, protocol = C < unlocked ? C : unlocked
  const bound = Ea < protocol ? Ea : protocol
  return { fullEaRaw, ...prongs, unlockedSupplyRaw: unlocked.toString(), protocolCapacityRaw: protocol.toString(), holderCapacityRaw: bound.toString(), bindingProng: Ea < protocol ? 'full_Ea' : Ea > protocol ? C < unlocked ? 'C' : C > unlocked ? 'S_minus_W' : 'C_and_S_minus_W' : 'full_Ea_and_protocol' }
}
export function foldCases(cases, EaSource, EaTarget, source, forecast, outcome) {
  const bounds = { source: holderBound(EaSource, source), forecast: holderBound(EaSource, forecast), outcome: holderBound(EaTarget, outcome) }
  const rows = cases.map(({ label, assetsRaw }) => {
    const Q = uint(assetsRaw), at = state => BigInt(bounds[state].holderCapacityRaw) - Q
    const a = at('source'), f = at('forecast'), t = at('outcome'), error = f - t, persistenceError = a - t
    const abs = v => (v < 0n ? -v : v).toString()
    return { label, requestedQRaw: assetsRaw, sourceHeadroomRaw: a.toString(), forecastHeadroomRaw: f.toString(), observedHeadroomRaw: t.toString(), observedHeadroomDeltaRaw: (t - a).toString(), signedErrorRaw: error.toString(), absoluteErrorRaw: abs(error), persistenceForecastHeadroomRaw: a.toString(), persistenceSignedErrorRaw: persistenceError.toString(), persistenceAbsoluteErrorRaw: abs(persistenceError), absoluteErrorImprovementRaw: (BigInt(abs(persistenceError)) - BigInt(abs(error))).toString(), sourceQCovered: a >= 0n, forecastQCovered: f >= 0n, observedQCovered: t >= 0n, coveragePredictionCorrect: (f >= 0n) === (t >= 0n), sampledFirstRestriction: { status: a >= 0n && t >= 0n ? 'right_censored_at_target_sample' : a >= 0n ? 'interval_censored_between_endpoints' : 'present_at_source_sample', restrictionTime: null, continuousAvailability: 'unknown_between_samples', recoveryTime: null } }
  })
  return { bounds, cases: rows }
}
function validatePair(pair) {
  verifySeal(pair)
  check(pair.status === 'verified_conditional_protocol_prong_history' && pair.holderExecutableExit === false && pair.forwardProbability === false, 'protocol_claim_scope')
  check(pair.sourceEvidence.length === 2 && pair.sourceEvidence[0].blockNumber < pair.sourceEvidence[1].blockNumber, 'protocol_sources')
  const seconds = (Date.parse(pair.sourceEvidence[1].blockTime) - Date.parse(pair.sourceEvidence[0].blockTime)) / 1000
  check(seconds > 0 && pair.elapsedSeconds === seconds, 'protocol_elapsed')
  const a = nativeProngs(pair.baselineProngs), b = nativeProngs(pair.targetProngs)
  for (const key of Object.keys(keys)) check((uint(b[key]) - uint(a[key])).toString() === pair.signedNativeDeltas[key], 'protocol_delta')
}
export async function buildAlignedBacktest(inputs, analysisAt) {
  const { original, plan, training, holdout, trainingReceipt, holdoutReceipt } = inputs
  // Reuse the previously verified original ledger/complete full-holder replay gates.
  // Its October 2 protocol input is retained solely as an excluded future-source witness.
  const originalReport = buildBacktest(original, analysisAt)
  verifySeal(plan); check(plan.sha256 === CAPTURE_PINS.plan.contentSha256, 'frozen_plan_pin')
  for (const [key, value] of Object.entries({ training, holdout, trainingReceipt, holdoutReceipt })) {
    verifySeal(value); check(value.sha256 === CAPTURE_PINS[key].contentSha256, 'capture_content_pin')
  }
  validatePair(training); validatePair(holdout)
  for (const [receipt, exported] of [[trainingReceipt, training], [holdoutReceipt, holdout]]) {
    check(equal(await replayProtocolCapacityPair(receipt, plan.protocolPlan, replayFluidCapacityProngs), exported), 'complete_protocol_replay_mismatch')
    check(receipt.physicalRequestStarts === 56 && receipt.outcomes.every(o => o.receipt.budget.physicalRequestStarts === 28), 'capture_read_count')
    check(Date.parse(receipt.capturedAt) <= Date.parse(analysisAt), 'analysis_before_capture')
  }
  check(equal(training.subject, holdout.subject) && equal(holdout.subject, { routeKey: originalReport.subject.routeKey, destination: originalReport.subject.destination, asset: originalReport.subject.asset, assetDecimals: originalReport.subject.assetDecimals }), 'native_subject')
  const raw = originalReport.rawNativeReplay
  const sameSource = (a, b) => a.blockNumber === b.blockNumber && a.blockHash === b.blockHash && a.blockTime === b.blockTime
  check(sameSource(holdout.sourceEvidence[0], raw.source.source) && sameSource(holdout.sourceEvidence[1], raw.outcome.source), 'holder_protocol_alignment')
  check(training.sourceEvidence[1].blockNumber < holdout.sourceEvidence[0].blockNumber && Date.parse(training.sourceEvidence[1].blockTime) < Date.parse(holdout.sourceEvidence[0].blockTime), 'future_training')
  check(equal([...training.sourceEvidence, ...holdout.sourceEvidence], plan.sources) && training.elapsedSeconds === 86400 && holdout.elapsedSeconds === 4728, 'frozen_source_grid')
  check(plan.training.donorCount === 1 && plan.holderFacts.MRaw === null, 'frozen_scope')
  const source = nativeProngs(holdout.baselineProngs), target = nativeProngs(holdout.targetProngs)
  const projection = projectProngs(source, training.signedNativeDeltas, holdout.elapsedSeconds, training.elapsedSeconds)
  const result = foldCases(original.issue.cases, raw.source.entitlementRaw, raw.outcome.entitlementRaw, source, projection.projected, target)
  check(result.cases.length === 5, 'all_five_original_Qs')
  const identities = [...training.runtimeIdentities, ...holdout.runtimeIdentities]
  const runtimeMatch = identities.every(v => equal(v, identities[0]))
  const exclusions = ['queued_M_unknown_excluded_from_active_Ea', 'historical_runtime_source_equivalence_unattested', 'pause_and_authority_unknown', 'proxy_implementation_continuity_unknown', 'shared_bank_gross_competing_flow_incomplete', 'target_is_sampled_conditional_capacity_not_payment', 'fixed_Q_native_assays_not_revalidated_by_full_Ea_receipt']
  if (!runtimeMatch) exclusions.push('captured_runtime_identity_mismatch')
  if (!training.regime.stableParameters || !holdout.regime.stableParameters) exclusions.push('withdrawal_limit_parameter_regime_changed')
  return seal({ schema: 'fluid_aligned_full_holder_NET_scenario_backtest_v1', analysisAt, status: 'conditional_retrospective_scenario_error_fold', subject: originalReport.subject,
    scope: { holderFolds: 1, trainingDonors: 1, originalFrozenResearchSizeCases: 5, casesAreCorrelated: true, all25RouteQualification: false },
    lineage: { original: original.provenance, captures: CAPTURE_PINS, frozenPlanSha256: plan.sha256, acquisitionReadCount: trainingReceipt.physicalRequestStarts + holdoutReceipt.physicalRequestStarts, completeProtocolReceiptsReplayed: true, completeHolderReceiptReplayed: true },
    clocks: { originalIssuedAt: original.issue.issuedAtUtc, originalScoredAt: original.score.scoredAtUtc, historicalSources: plan.sources, trainingAcquiredAt: trainingReceipt.capturedAt, holdoutAcquiredAt: holdoutReceipt.capturedAt, sourceTrainingLocallyKnownAt: plan.provenance.training.map(a => a.firstLocalReceiptAt), donorTransformFrozenBeforeNewAcquisition: true, scoringImplementationFrozenBeforeAcquisition: false, prospectiveIssue: false, plannedHorizonSeconds: originalReport.clocks.plannedHorizonSeconds, actualHorizonSeconds: holdout.elapsedSeconds, trainingSeconds: training.elapsedSeconds, acquisitionIsAfterHistoricalIssue: true },
    method: { formula: 'min(full_Ea_source,C_projected,max(0,S_projected-W_projected))-Q', outcomeFormula: 'min(full_Ea_target,C_target,max(0,S_target-W_target))-Q', trainingTransform: 'joint_native_signed_NET_deltas_times_actual_horizon_over_donor_duration', donorDeltasRaw: training.signedNativeDeltas, observedHoldoutDeltasRaw: holdout.signedNativeDeltas, ...projection, competingFlowSubtractedAgain: false, requestedQSubtractedOnce: true, fullEaForecastAssumption: 'source_full_Ea_held_constant_no_new_earnings', targetUsedForFitting: false },
    fullHolder: { sourceEaRaw: raw.source.entitlementRaw, targetEaRaw: raw.outcome.entitlementRaw, observedEaGrowthRaw: (uint(raw.outcome.entitlementRaw) - uint(raw.source.entitlementRaw)).toString(), sharesRaw: originalReport.subject.sharesRaw, MRaw: null, MAuthority: 'unknown', unknownMNotAddedToMeasuredEa: true },
    ...result, regime: { capturedRuntimeIdentitiesMatch: runtimeMatch, training: training.regime, holdout: holdout.regime, trainingLimitParameters: [training.baselineLimitParameters, training.targetLimitParameters], holdoutLimitParameters: [holdout.baselineLimitParameters, holdout.targetLimitParameters] },
    comparison: { allForecastsTiePersistence: result.cases.every(c => c.forecastHeadroomRaw === c.persistenceForecastHeadroomRaw), entitlementBindsAllThreeStates: Object.values(result.bounds).every(b => b.bindingProng === 'full_Ea'), protocolModelImprovementEstablished: false, errorConvention: 'forecast_minus_observed', pairedErrorUnit: 'one_correlated_holder_episode' },
    exclusions, claims: { forwardProbability: null, calibratedAccuracy: false, outOfSampleForecastClaim: false, probabilisticBand: null, restrictionDuration: null, continuousAvailability: false, forecastValidated: false, prospectiveValidated: false, holderExecutableExit: false, minedPayoutObserved: false, wholeHolderWithQueuedClaimsValidated: false },
  })
}
export function loadAlignedInputs(root = process.cwd(), captureRoot = CAPTURE_ROOT) {
  return { original: loadRetainedInputs(root), ...Object.fromEntries(Object.entries(CAPTURE_PINS).map(([key, pin]) => [key, readPinnedInput(captureRoot, pin)])) }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] ?? 'check', option = name => process.argv.find(a => a.startsWith('--' + name + '='))?.slice(name.length + 3)
  check(['check', 'write'].includes(mode), 'mode')
  const report = await buildAlignedBacktest(loadAlignedInputs(process.cwd(), option('capture-root') ?? CAPTURE_ROOT), option('analysis-at') ?? new Date().toISOString())
  console.log(JSON.stringify(mode === 'write' ? writeReportExclusive(option('output') ?? OUTPUT, report) : { status: report.status, cases: report.cases.length, completeRawReplay: true, reportSha256: report.sha256, claims: report.claims }))
}
