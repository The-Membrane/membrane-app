import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agreeHolderExitCapacityQuotes, buildHolderExitCapacityQuote } from '@/lib/carry/holderExitCapacity'
import type { HolderExitAssessment } from '@/lib/carry/holderExitAssessment'
import { encodeMorphoV2IdleHolderForecastEvidence, type MorphoV2IdleHolderForecastEvidenceWire, type MorphoV2IdleNativeBrowserTrace } from '@/lib/carry/morphoV2IdleHolderForecastEvidence'
import { resolveMorphoV2IdleTrustedProfile } from '@/lib/carry/morphoV2IdleTrustedProfiles'
import {
  issuedMorphoV2IdleJointHolderForecast, morphoV2IdleJointHolderForecastFromResponse,
  morphoV2IdleJointHolderForecastIssue, morphoV2IdleJointHolderForecastIssueFromResponse,
  morphoV2IdleJointHolderForecastRenderWindow, selectedMorphoV2IdleJointHolderForecast,
  selectedMorphoV2IdleJointHolderForecastFromIssue, selectedMorphoV2IdleJointHolderForecastIssue,
  type MorphoV2IdleJointHolderForecastQuestion,
} from '@/lib/carry/morphoV2IdleJointHolderForecastBinding'

const CAPSULE_TEXT = "{\"schemaVersion\":1,\"kind\":\"morpho_v2_idle_pinned_historical_capsule_v1\",\"profileId\":\"morpho_v2_pyusd_b576_observed_idle_history\",\"identity\":{\"profileId\":\"morpho_v2_pyusd_b576_observed_idle_history\",\"routeKey\":\"PYUSD → VaultV2 [PYUSD]\",\"destination\":\"0xb576765fb15505433af24fee2c0325895c559fb2\",\"asset\":\"0x6c3ea9036406852006290770bedfcaba0e23a0e8\",\"assetDecimals\":6,\"shareDecimals\":18},\"captureSharesRaw\":\"352805058661206444\",\"captureOwner\":\"0xf181e2cc93a47cb4903ac71c23ecb873726dc668\",\"anchors\":[{\"identity\":{\"profileId\":\"morpho_v2_pyusd_b576_observed_idle_history\",\"routeKey\":\"PYUSD → VaultV2 [PYUSD]\",\"destination\":\"0xb576765fb15505433af24fee2c0325895c559fb2\",\"asset\":\"0x6c3ea9036406852006290770bedfcaba0e23a0e8\",\"assetDecimals\":6,\"shareDecimals\":18},\"owner\":\"0xf181e2cc93a47cb4903ac71c23ecb873726dc668\",\"source\":{\"chainId\":1,\"blockNumber\":\"26100913\",\"blockHash\":\"0x2fe9266ceaaea215d32a4c5e0701f3c287705f2b976844cf3131534a814aa272\",\"blockTime\":\"2026-10-01T23:59:59.000Z\",\"finalized\":true},\"regime\":{\"kind\":\"zero_adapter_idle\",\"liquidityAdapter\":\"0x0000000000000000000000000000000000000000\",\"liquidityData\":\"0x\",\"vaultRuntimeCodeHash\":\"0xd40a644ba3984c98bcffa15709271ecedf2ff7632d763fad84d7f924bd4f6acd\",\"assetRuntimeCodeHash\":\"0xbc22d0b1173d9ff26383e64a50a807afa931a2809a7b6bae3b051723a1a9ebe1\"},\"idleCashRaw\":\"20919825104652\",\"historicalOwnerSharesRaw\":\"352805058661206444\",\"fixedCurrentStockConversion\":{\"method\":\"native_preview_redeem_fixed_current_shares\",\"source\":{\"chainId\":1,\"blockNumber\":\"26100913\",\"blockHash\":\"0x2fe9266ceaaea215d32a4c5e0701f3c287705f2b976844cf3131534a814aa272\",\"blockTime\":\"2026-10-01T23:59:59.000Z\",\"finalized\":true},\"probeSharesRaw\":\"352805058661206444\",\"asset\":\"0x6c3ea9036406852006290770bedfcaba0e23a0e8\",\"assetDecimals\":6,\"shareDecimals\":18,\"assetsRaw\":\"713612\"}},{\"identity\":{\"profileId\":\"morpho_v2_pyusd_b576_observed_idle_history\",\"routeKey\":\"PYUSD → VaultV2 [PYUSD]\",\"destination\":\"0xb576765fb15505433af24fee2c0325895c559fb2\",\"asset\":\"0x6c3ea9036406852006290770bedfcaba0e23a0e8\",\"assetDecimals\":6,\"shareDecimals\":18},\"owner\":\"0xf181e2cc93a47cb4903ac71c23ecb873726dc668\",\"source\":{\"chainId\":1,\"blockNumber\":\"26108081\",\"blockHash\":\"0x9f430d0cc4301a9f8ea0315223c2ed6e66373f6454baac771cac7449d725ba37\",\"blockTime\":\"2026-10-02T23:59:59.000Z\",\"finalized\":true},\"regime\":{\"kind\":\"zero_adapter_idle\",\"liquidityAdapter\":\"0x0000000000000000000000000000000000000000\",\"liquidityData\":\"0x\",\"vaultRuntimeCodeHash\":\"0xd40a644ba3984c98bcffa15709271ecedf2ff7632d763fad84d7f924bd4f6acd\",\"assetRuntimeCodeHash\":\"0xbc22d0b1173d9ff26383e64a50a807afa931a2809a7b6bae3b051723a1a9ebe1\"},\"idleCashRaw\":\"24375516077801\",\"historicalOwnerSharesRaw\":\"352805058661206444\",\"fixedCurrentStockConversion\":{\"method\":\"native_preview_redeem_fixed_current_shares\",\"source\":{\"chainId\":1,\"blockNumber\":\"26108081\",\"blockHash\":\"0x9f430d0cc4301a9f8ea0315223c2ed6e66373f6454baac771cac7449d725ba37\",\"blockTime\":\"2026-10-02T23:59:59.000Z\",\"finalized\":true},\"probeSharesRaw\":\"352805058661206444\",\"asset\":\"0x6c3ea9036406852006290770bedfcaba0e23a0e8\",\"assetDecimals\":6,\"shareDecimals\":18,\"assetsRaw\":\"713661\"}}],\"provenance\":{\"nativeTerminalFileSha256\":\"37773ac59805072fc8b625bb15d199bf9e14f2a679e528629db1a50f4116360a\",\"nativeReportFileSha256\":\"09f5619b3f07d62a22bf56fb6732a6b4f0a7c6dc91f0781452372ed8d5cbc136\",\"sourceCompanionManifestSha256\":\"6365044aa4e7814602d5ed499ff335d0a6b0d371ee0f56887486e41dbd66e25d\",\"verifiedReplayCompletedAtUtc\":\"2026-10-10T05:30:32.512Z\"},\"claims\":{\"researchOnly\":true,\"authenticated\":false,\"originalAuthority\":false,\"historicalOwnership\":false,\"historicalOwnedEntitlementMeasured\":false,\"currentWalletControl\":false,\"profileApproval\":false,\"sourceImplementationEquivalence\":false,\"holderExecutableExit\":false,\"forecastEligibility\":false,\"executionAuthority\":false,\"forecastAuthority\":false,\"calibrated\":false,\"calibratedProbability\":false,\"coveragePromotion\":false,\"competingMRaw\":null,\"MRaw\":null}}"
const DIRECTORY = 'data/research/venue-signals/pyusd-b576-idle-history-v2-2026-10-10T05-29-29.760Z-b9d9aa95-5eec-4e5d-92af-fd6b4d3d6091'
const ISSUE_MS = Date.parse('2026-10-10T05:30:32.512Z')
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
function fixture(horizonHours = 1, requestedRaw = '500000') {
  const reportText = readFileSync(resolve(DIRECTORY, 'report.json'), 'utf8')
  expect(digest(reportText)).toBe('09f5619b3f07d62a22bf56fb6732a6b4f0a7c6dc91f0781452372ed8d5cbc136')
  const report = JSON.parse(reportText)
  let nativeStartedMs = Infinity, nativeReadMs = -Infinity
  const traces: MorphoV2IdleNativeBrowserTrace[] = report.points[0].nativeReferences.flatMap((ref: { physicalIds: number[] }) => ref.physicalIds.map((physicalId) => {
    const row = JSON.parse(readFileSync(resolve(DIRECTORY, `native-row-${String(physicalId).padStart(3, '0')}.json`), 'utf8')).row
    nativeStartedMs = Math.min(nativeStartedMs, Date.parse(row.observation.startedAtUtc)); nativeReadMs = Math.max(nativeReadMs, Date.parse(row.observation.completedAtUtc))
    const requestText = Buffer.from(row.request.requestBodyBase64, 'base64').toString('utf8'), body = Buffer.from(row.observation.rawBodyBase64, 'base64').toString('utf8')
    expect(digest(requestText)).toBe(row.request.requestBodySha256); expect(digest(body)).toBe(row.observation.bodySha256)
    return { host: row.request.host, key: row.request.key, physicalId, request: JSON.parse(requestText), envelope: JSON.parse(body) }
  }))
  const wire: MorphoV2IdleHolderForecastEvidenceWire = { schema: 'morpho_v2_idle_holder_forecast_evidence_v1', capsuleText: CAPSULE_TEXT, current: { label: 'current', source: report.currentSource, owner: report.subject.owner, probeSharesRaw: report.freshCurrentSharesRaw, traces, startedAtUtc: new Date(nativeStartedMs).toISOString(), readAtUtc: new Date(nativeReadMs).toISOString() }, historicalPreviewSupplement: null }
  const profile = resolveMorphoV2IdleTrustedProfile('PYUSD → VaultV2 [PYUSD]', report.subject.vault, report.subject.asset)!
  const source = { ...wire.current.source, blockNumber: Number(wire.current.source.blockNumber) }
  const question: MorphoV2IdleJointHolderForecastQuestion = { routeKey: profile.identity.routeKey, destination: profile.identity.destination, requestedRaw, requestedAssetAddress: profile.identity.asset, requestedAssetDecimals: 6, requestedHolderAddress: wire.current.owner, horizonHours, asOfMs: ISSUE_MS, independentSource: source }
  const assessment = { status: 'assessed', routeKey: question.routeKey, destinationAddress: question.destination, owner: question.requestedHolderAddress, request: { assetsRaw: requestedRaw, assetAddress: question.requestedAssetAddress, horizonHours }, source: { ...source, originValidation: 'single_provider' }, stages: [{ name: 'withdrawal', status: 'reverted', relatedToRequest: true, amountRaw: requestedRaw, assetAddress: question.requestedAssetAddress }], finalPayout: { status: 'unassessed', amountRaw: null, assetAddress: question.requestedAssetAddress }, forecast: { status: 'unvalidated', futureExit: null, exitDurationHours: null, prospectiveValidated: false } } as HolderExitAssessment
  const quote = buildHolderExitCapacityQuote(assessment, { entitlementRaw: '714000', quotedMaxWithdrawRaw: '0', quotedMaxWithdrawStatus: 'quoted', effectiveLimitRaw: null, withdrawalsPaused: null, sourceHolderPosition: { sharesRaw: wire.current.probeSharesRaw, shareDecimals: 18, method: 'balance_of_owner_at_source' } }, ISSUE_MS)
  if (!quote) throw Error('idle_fixture_generic_quote_invalid')
  const capacityAgreement = agreeHolderExitCapacityQuotes({ host: 'eth-mainnet.g.alchemy.com', quote }, { host: 'rpc.ankr.com', quote }, ISSUE_MS)
  if (!capacityAgreement) throw Error('idle_fixture_generic_agreement_invalid')
  const evidenceText = encodeMorphoV2IdleHolderForecastEvidence(wire)!
  const response = { capacityAgreement, morphoV2IdleHolderForecastEvidence: evidenceText }
  return { wire, question, capacityAgreement, evidenceText, response }
}
function issue(f = fixture()) { return issuedMorphoV2IdleJointHolderForecast(f.capacityAgreement, f.evidenceText, f.question) }

describe('original browser idle holder forecast binding', () => {
  it.each([[1, '714002', '214002'], [4, '714008', '214008'], [24, '714049', '214049']])('binds H%s using actual native capsule, source age and Q once', (hours, ea, headroom) => {
    const f = fixture(Number(hours)), model = issue(f)!
    expect(model).not.toBeNull()
    expect(model.process.sourceAgeMs).toBe(1185512)
    expect(model.currentIdleCashRaw).toBe('39678091697943')
    expect(model.currentSharesRaw).toBe('352805058661206444')
    expect(model.currentFullEaRaw).toBe('714000')
    const scenario = model.process.scenarios[0]
    expect(scenario.status).toBe('usable')
    if (scenario.status !== 'usable') throw Error('expected native donor')
    expect(scenario.measurement.projectedFullEaRaw).toBe(ea)
    expect(scenario.measurement.headroomRaw).toBe(headroom)
    expect(scenario.measurement.bindingProng).toBe('full_entitlement')
    expect(model.process.descriptive.headline?.headroom).toMatchObject({ sampleCount: 1, minimumRaw: headroom, maximumRaw: headroom, confidenceInterval: false })
    expect(model.process.competingMRaw).toBeNull()
    expect(model.targetAtUtc).toBe(new Date(ISSUE_MS + Number(hours) * 3600000).toISOString())
    expect(model.claims).toMatchObject({ authenticated: false, originalAuthority: false, sourceImplementationEquivalence: false, executionValidated: false, guaranteedExecution: false, forecastValidated: false, prospectiveValidation: false, calibrated: false, calibratedProbability: false })
    expect(Object.isFrozen(model)).toBe(true)
  })
  it('shows insufficiency despite positive full Ea and preserves a reverted Q assessment', () => {
    const f = fixture(1, '1000000'), model = issue(f)!
    expect(model).not.toBeNull()
    expect(model.process.descriptive.headline?.headroom.minimumRaw).toBe('0')
    expect(model.process.descriptive.headline?.shortfall.minimumRaw).toBe('285998')
    expect(model.process.descriptive.headline?.signedMargin.minimumRaw).toBe('-285998')
    const scenario = model.process.scenarios[0]
    if (scenario.status !== 'usable') throw Error('expected native donor')
    expect(scenario.sampledTimeline.insufficientAtIssue).toBe(true)
    expect(scenario.sampledTimeline.guaranteedDurationMs).toBeNull()
  })
  it('preserves the existing independent execution gate for a synthetic successful-Q lower bound', () => {
    const f = fixture()
    ;[f.capacityAgreement.quote, ...f.capacityAgreement.origins.map((o) => o.quote)].forEach((quote) => {
      quote.successfulRequestedRawLowerBound = f.question.requestedRaw
      quote.quotedMaxWithdrawRaw = '714000'
    })
    expect(issue(f)).toBeNull()
    const question = { routeKey: f.question.routeKey, destinationAddress: f.question.destination, owner: f.question.requestedHolderAddress, assetsRaw: f.question.requestedRaw, finalAssetAddress: f.question.requestedAssetAddress, finalAssetDecimals: f.question.requestedAssetDecimals }
    const executionAgreement = { question, routeAndContractIdentityVerified: true, inputAndFinalAssetAddressesVerified: true,
      simulations: f.capacityAgreement.origins.map((origin) => ({ question, originHost: origin.host, source: structuredClone(origin.quote.source), kind: 'full_route_execution', execution: 'single_call', fullRouteExecutionVerified: true, requiredStages: [{ name: 'atomic_exit', status: 'executed' }], finalAssetAmountRaw: f.question.requestedRaw, status: 'simulated' })) }
    const model = issuedMorphoV2IdleJointHolderForecast(f.capacityAgreement, f.evidenceText, f.question, executionAgreement)!
    expect(model).not.toBeNull()
    expect(model.claims.guaranteedExecution).toBe(false)
    expect(model.claims.executionValidated).toBe(false)
    expect(issuedMorphoV2IdleJointHolderForecast(f.capacityAgreement, f.evidenceText, f.question, { approved: true })).toBeNull()
    executionAgreement.simulations[0].finalAssetAmountRaw = '499999'
    expect(issuedMorphoV2IdleJointHolderForecast(f.capacityAgreement, f.evidenceText, f.question, executionAgreement)).toBeNull()
  })
  it('issues a dedicated original receipt and rejects models or receipts reconstructed from JSON', () => {
    const f = fixture(), model = issue(f)!, receipt = morphoV2IdleJointHolderForecastIssue(model)!
    expect(receipt.kind).toBe('morpho_v2_idle_joint_holder_forecast_issue_v1')
    expect(receipt).toMatchObject({ sharesRaw: model.currentSharesRaw, fullEntitlementRaw: model.currentFullEaRaw, requestedRaw: '500000', issuedAtMs: ISSUE_MS })
    expect(selectedMorphoV2IdleJointHolderForecast(model, f.question, ISSUE_MS)).toBe(model)
    expect(selectedMorphoV2IdleJointHolderForecastFromIssue(receipt, f.question, ISSUE_MS)).toBe(model)
    expect(selectedMorphoV2IdleJointHolderForecastIssue(receipt, f.question, ISSUE_MS)).toBe(receipt)
    expect(morphoV2IdleJointHolderForecastIssue(JSON.parse(JSON.stringify(model)))).toBeNull()
    expect(selectedMorphoV2IdleJointHolderForecastFromIssue(JSON.parse(JSON.stringify(receipt)), f.question, ISSUE_MS)).toBeNull()
    expect(selectedMorphoV2IdleJointHolderForecastFromIssue({ ...receipt, sharesRaw: '1' }, f.question, ISSUE_MS)).toBeNull()
  })
  it.each(['Q', 'horizon', 'route', 'owner', 'units', 'source', 'issue time', 'stock field'])('denies original receipt rebinding %s', (kind) => {
    const f = fixture(), model = issue(f)!, receipt = morphoV2IdleJointHolderForecastIssue(model)!, q = structuredClone(f.question) as MorphoV2IdleJointHolderForecastQuestion & { sharesRaw?: string }
    if (kind === 'Q') q.requestedRaw = '499999'
    if (kind === 'horizon') q.horizonHours = 4
    if (kind === 'route') q.routeKey += ' '
    if (kind === 'owner') q.requestedHolderAddress = '0x' + 'a'.repeat(40)
    if (kind === 'units') q.requestedAssetDecimals = 18
    if (kind === 'source') q.independentSource!.blockHash = '0x' + 'a'.repeat(64)
    if (kind === 'issue time') q.asOfMs++
    if (kind === 'stock field') q.sharesRaw = '1'
    expect(selectedMorphoV2IdleJointHolderForecastFromIssue(receipt, q, ISSUE_MS)).toBeNull()
  })
  it('advances only render clock within original freshness and target bounds', () => {
    const f = fixture(), model = issue(f)!, receipt = morphoV2IdleJointHolderForecastIssue(model)!, expiry = Date.parse(model.sourceProofValidUntil)
    expect(morphoV2IdleJointHolderForecastRenderWindow(model, ISSUE_MS - 1)).toBe(false)
    expect(selectedMorphoV2IdleJointHolderForecastFromIssue(receipt, f.question, expiry)).toBe(model)
    expect(selectedMorphoV2IdleJointHolderForecastFromIssue(receipt, f.question, expiry + 1)).toBeNull()
    expect(morphoV2IdleJointHolderForecastRenderWindow(model, Date.parse(model.targetAtUtc))).toBe(false)
    expect(model.issuedAtMs).toBe(ISSUE_MS)
  })
  it.each(['top quote', 'native Ea', 'native S', 'units', 'method', 'source', 'owner', 'Q', 'hosts', 'missing position'])('rejects independent generic-capacity %s mismatch', (kind) => {
    const f = fixture()
    if (kind === 'top quote') f.capacityAgreement.quote.entitlementRaw = '1'
    else f.capacityAgreement.origins.forEach((o) => {
      if (kind === 'native Ea') o.quote.entitlementRaw = '714001'
      if (kind === 'native S') o.quote.sourceHolderPosition!.sharesRaw = '1'
      if (kind === 'units') o.quote.sourceHolderPosition!.shareDecimals = 6
      if (kind === 'method') o.quote.entitlementMethod = 'unavailable'
      if (kind === 'source') o.quote.source.blockHash = '0x' + 'a'.repeat(64)
      if (kind === 'owner') o.quote.owner = '0x' + 'a'.repeat(40)
      if (kind === 'Q') o.quote.requestedRaw = '499999'
      if (kind === 'hosts') o.host = 'rpc.ankr.com'
      if (kind === 'missing position') delete o.quote.sourceHolderPosition
    })
    expect(issue(f)).toBeNull()
  })
  it('accepts only the two supported HTTP publications, with the exact unavailable error on 503', () => {
    const f = fixture()
    expect(morphoV2IdleJointHolderForecastFromResponse(f.response, 200, f.question)).not.toBeNull()
    const unavailable = { ...f.response, error: 'holder_exit_assessment_unavailable' }
    expect(morphoV2IdleJointHolderForecastIssueFromResponse(unavailable, 503, f.question)).not.toBeNull()
    expect(morphoV2IdleJointHolderForecastFromResponse(f.response, 503, f.question)).toBeNull()
    expect(morphoV2IdleJointHolderForecastFromResponse({ ...f.response, error: 'other' }, 503, f.question)).toBeNull()
    expect(morphoV2IdleJointHolderForecastFromResponse(f.response, 500, f.question)).toBeNull()
    expect(morphoV2IdleJointHolderForecastFromResponse({ ...f.response, morphoV2IdleHolderForecastEvidence: { approved: true } }, 200, f.question)).toBeNull()
  })
  it('allows the seven-day mathematical cap, rejects longer horizons and rejects getter questions unread', () => {
    expect(issue(fixture(168))).not.toBeNull()
    expect(issue(fixture(169))).toBeNull()
    const f = fixture(); let accessed = false
    const q = Object.defineProperty({}, 'routeKey', { enumerable: true, get() { accessed = true; return f.question.routeKey } })
    expect(issuedMorphoV2IdleJointHolderForecast(f.capacityAgreement, f.evidenceText, q)).toBeNull()
    expect(accessed).toBe(false)
  })
})
