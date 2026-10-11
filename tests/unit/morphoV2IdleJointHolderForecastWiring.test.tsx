import React from 'react'
import { ChakraProvider } from '@chakra-ui/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agreeHolderExitCapacityQuotes, buildHolderExitCapacityQuote } from '@/lib/carry/holderExitCapacity'
import type { HolderExitAssessment } from '@/lib/carry/holderExitAssessment'
import { encodeMorphoV2IdleHolderForecastEvidence, morphoV2IdleBrowserPreviewRedeemCalldata,
  type MorphoV2IdleHolderForecastEvidenceWire, type MorphoV2IdleNativeBrowserTrace } from '@/lib/carry/morphoV2IdleHolderForecastEvidence'
import { resolveMorphoV2IdleTrustedProfile } from '@/lib/carry/morphoV2IdleTrustedProfiles'
import type { MorphoV2IdleJointHolderForecastQuestion } from '@/lib/carry/morphoV2IdleJointHolderForecastBinding'
import { encodeMorphoV2IdlePanelHolderForecastEvidence } from '@/lib/carry/morphoV2IdleCompactPanelEvidence'
import { buildModeledShortageWindows } from '@/lib/carry/modeledShortageWindows'
import { ExitPressureCard, selectedMorphoV2IdleJointForCard, formatExitPressureApproxRaw, formatExitPressureRawRange, morphoIdlePanelDurationValue, morphoIdlePanelCapacityChange,
  type ExitPressureCardProps, type ExitPressureCurrentCash } from '@/components/Carry/ExitPressureCard'
import { holderMorphoV2IdleJointIssueFromResponse, holderTimeProcessIssueFromResponse } from '@/components/Carry/ForecastWorkbench'

// Original archive RPC bytes drive browser gates. These controls claim no live acquisition or execution.
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
  const response = { capacityAgreement, morphoV2IdleHolderForecastEvidence: evidenceText, morphoV2IdleJointIssuedAtUtc: new Date(question.asOfMs).toISOString() }
  return { wire, question, capacityAgreement, evidenceText, response, assessment }
}
function retained(f = fixture(), status = 200, receivedAtMs = f.question.asOfMs + 1000) {
  const { asOfMs: _issueClock, ...question } = f.question
  const response = status === 503 ? { ...f.response, error: 'holder_exit_assessment_unavailable' } : f.response
  return holderMorphoV2IdleJointIssueFromResponse(response, status, question, receivedAtMs)
}
function props(f = fixture()): ExitPressureCardProps {
  return { scenarioMode: 'exit', routeKey: f.question.routeKey, destination: f.question.destination,
    requestedAmount: '0.5', requestedRaw: f.question.requestedRaw, requestedAssetSymbol: 'OTHER',
    requestedAssetAddress: f.question.requestedAssetAddress, requestedAssetDecimals: 6,
    requestedHolderAddress: f.question.requestedHolderAddress, horizonHours: f.question.horizonHours,
    asOfMs: f.question.asOfMs + 1000, currentCash: null, prospectiveCashModel: null,
    historicalScenario: null, grossWithdrawals: null, grossInflows: null, historicalGrossFlow: null,
    morphoPayout: null, holderAssessment: null, expectedEventEnrollment: null, eventContext: null,
    historicalOutlook: null, holderMorphoV2IdleJointIssue: retained(f), holderCapacityAgreement: f.capacityAgreement }
}
function render(value: ExitPressureCardProps) {
  return renderToStaticMarkup(<ChakraProvider><ExitPressureCard {...value} /></ChakraProvider>)
}

// Derived synthetic current clock/share controls; the original raw32 fixture above stays unchanged.
// This exact parent-generated history pin is real. Modified current controls claim no fresh RPC read.
function syntheticPanelFixture(otherStock = false, requestedRaw = '1000000') {
  const f = fixture(24, requestedRaw)
  const panelText = readFileSync(resolve('data/research/venue-signals/morpho-v2-idle-compact120-panel-2026-10-10-5f90f936-a60b-48a1-a807-dc91a07be66f/panel.json'), 'utf8')
  expect(Buffer.byteLength(panelText)).toBe(59203)
  expect(digest(panelText)).toBe('770210e547b2d437d3c142bfb6853975eacf62e6ec3caf64af300791ea926a12')
  const panel = JSON.parse(panelText)
  const current = structuredClone(f.wire.current)
  const sourceMs = Math.ceil(Date.parse(panel.actualAvailabilityAtUtc) / 1000) * 1000 + 30000
  const issueMs = sourceMs + 30000
  current.source.blockTime = new Date(sourceMs).toISOString()
  current.startedAtUtc = new Date(sourceMs + 10000).toISOString()
  current.readAtUtc = new Date(sourceMs + 20000).toISOString()
  for (const trace of current.traces) {
    if (typeof trace.request.method === 'string' && trace.request.method.startsWith('eth_getBlock')) {
      const header = trace.envelope.result as { timestamp: string }
      header.timestamp = '0x' + BigInt(sourceMs / 1000).toString(16)
    }
  }
  if (otherStock) {
    current.probeSharesRaw = (BigInt(current.probeSharesRaw) * 2n).toString()
    for (const trace of current.traces) {
      if (trace.key === 'current:actual_owner_shares') trace.envelope.result = '0x' + BigInt(current.probeSharesRaw).toString(16).padStart(64, '0')
      if (trace.key === 'current:fixed_stock_preview') (trace.request.params[0] as { data: string }).data = morphoV2IdleBrowserPreviewRedeemCalldata(current.probeSharesRaw)
    }
  }
  f.question.asOfMs = issueMs
  f.question.independentSource = { ...current.source, blockNumber: Number(current.source.blockNumber) }
  f.assessment.source = { ...f.question.independentSource, originValidation: 'single_provider' }
  const quote = buildHolderExitCapacityQuote(f.assessment, { entitlementRaw: '714000', quotedMaxWithdrawRaw: '0', quotedMaxWithdrawStatus: 'quoted', effectiveLimitRaw: null, withdrawalsPaused: null, sourceHolderPosition: { sharesRaw: current.probeSharesRaw, shareDecimals: 18, method: 'balance_of_owner_at_source' } }, issueMs)!
  f.capacityAgreement = agreeHolderExitCapacityQuotes({ host: 'eth-mainnet.g.alchemy.com', quote }, { host: 'rpc.ankr.com', quote }, issueMs)!
  const evidenceText = encodeMorphoV2IdlePanelHolderForecastEvidence({ schema: 'morpho_v2_idle_holder_forecast_evidence_v2', panelText, current })
  if (!evidenceText || !f.capacityAgreement) throw Error('synthetic_panel_control_invalid')
  f.evidenceText = evidenceText
  f.response = { capacityAgreement: f.capacityAgreement, morphoV2IdleHolderForecastEvidence: evidenceText, morphoV2IdleJointIssuedAtUtc: new Date(issueMs).toISOString() }
  return f
}
function changedStock() {
  const f = fixture(24, '710000'), shares = String(BigInt(f.wire.current.probeSharesRaw) + 1n)
  f.question.asOfMs += 10000
  f.wire.current.probeSharesRaw = shares
  f.wire.current.traces.filter((t) => t.key === 'current:actual_owner_shares').forEach((t) => {
    t.envelope.result = '0x' + BigInt(shares).toString(16).padStart(64, '0')
  })
  f.wire.current.traces.filter((t) => t.key === 'current:fixed_stock_preview').forEach((t) => {
    (t.request.params[0] as { data: string }).data = morphoV2IdleBrowserPreviewRedeemCalldata(shares)
  })
  const report = JSON.parse(readFileSync(resolve(DIRECTORY, 'report.json'), 'utf8'))
  const traces: MorphoV2IdleNativeBrowserTrace[] = []
  ;[0, 1].forEach(anchor => {
    const point = report.points[anchor + 1]
    ;['header_before', 'fixed_stock_preview', 'header_after'].forEach((role, index) => {
      const ref = point.nativeReferences.find((r: { key: string }) => r.key === `anchor_${anchor}:${role}`)
      ref.physicalIds.forEach((originalPhysicalId: number, origin: number) => {
        const row = JSON.parse(readFileSync(resolve(DIRECTORY, `native-row-${String(originalPhysicalId).padStart(3, '0')}.json`), 'utf8')).row
        const request = JSON.parse(Buffer.from(row.request.requestBodyBase64, 'base64').toString('utf8'))
        const envelope = JSON.parse(Buffer.from(row.observation.rawBodyBase64, 'base64').toString('utf8'))
        const id = 35 + anchor * 6 + index * 2 + origin
        request.id = id; envelope.id = id
        if (role === 'fixed_stock_preview') {
          request.params[0].data = morphoV2IdleBrowserPreviewRedeemCalldata(shares)
          envelope.result = '0x' + BigInt(anchor === 0 ? '720000' : '715000').toString(16).padStart(64, '0')
        } else {
          const { hash, number, timestamp } = envelope.result
          envelope.result = { hash, number, timestamp }
        }
        traces.push({ host: row.request.host, key: `historical_${anchor}:${role}`, physicalId: id, request, envelope })
      })
    })
  })
  f.wire.historicalPreviewSupplement = { sharesRaw: shares,
    startedAtUtc: '2026-10-10T05:30:33.000Z', readAtUtc: '2026-10-10T05:30:40.000Z', traces }
  const quote = buildHolderExitCapacityQuote(f.assessment, { entitlementRaw: '714000',
    quotedMaxWithdrawRaw: '0', quotedMaxWithdrawStatus: 'quoted', effectiveLimitRaw: null,
    withdrawalsPaused: null, sourceHolderPosition: { sharesRaw: shares, shareDecimals: 18,
      method: 'balance_of_owner_at_source' } }, f.question.asOfMs)!
  f.capacityAgreement = agreeHolderExitCapacityQuotes({ host: 'eth-mainnet.g.alchemy.com', quote },
    { host: 'rpc.ankr.com', quote }, f.question.asOfMs)!
  f.evidenceText = encodeMorphoV2IdleHolderForecastEvidence(f.wire)!
  f.response = { capacityAgreement: f.capacityAgreement, morphoV2IdleHolderForecastEvidence: f.evidenceText,
    morphoV2IdleJointIssuedAtUtc: new Date(f.question.asOfMs).toISOString() }
  return f
}

describe('dedicated native PYUSD Workbench and Card connection', () => {
  it.each(['null question', 'nonstring destination', 'present nonstring asset'])(
    'legacy boundary denies %s without throwing', malformedKind => {
      const f = fixture()
      const malformed = malformedKind === 'null question' ? null
        : malformedKind === 'nonstring destination' ? { ...f.question, destination: 123 }
          : { ...f.question, requestedAssetAddress: 123 }
      const invoke = () => holderTimeProcessIssueFromResponse(null, 200,
        malformed as unknown as Parameters<typeof holderTimeProcessIssueFromResponse>[2], null, null)
      expect(invoke).not.toThrow()
      expect(invoke()).toBeNull()
    },
  )
  it.each([200, 503])('retains an original idle receipt at server issue time from HTTP%s', status => {
    const f = fixture(), held = retained(f, status)!, p = { ...props(f), holderMorphoV2IdleJointIssue: held }
    const model = selectedMorphoV2IdleJointForCard(held, p, null)!
    if (model.status !== 'conditional_morpho_v2_idle_joint_holder_forecast') throw Error('expected v1 receipt')
    expect(model).not.toBeNull(); expect(held.question.asOfMs).toBe(ISSUE_MS)
    expect(model.process.sourceAgeMs).toBe(1185512); expect(model.process.competingMRaw).toBeNull()
    expect(model.process.usableDonorCount).toBe(1)
    expect(model.claims).toMatchObject({ executionValidated: false, calibrated: false, calibratedProbability: false })
    expect(render(p)).toContain('Projected exit capacity'); expect(render(p)).toContain('0.714002 PYUSD')
    expect(render(p)).not.toContain('0.714002 OTHER'); expect(render(p)).not.toContain('M ?')
    expect(Date.parse(model.targetAtUtc)).toBe(ISSUE_MS + 3600000)
    expect(holderTimeProcessIssueFromResponse(f.response, status, f.question, null, null)).toBeNull()
  })
  it.each([0, 1])('retains mixed raw successful-Q bounds on canonical503 with successful origin%s', successfulOrigin => {
    const f = fixture(), quotes = f.capacityAgreement.origins.map(origin => structuredClone(origin.quote))
    quotes[successfulOrigin].successfulRequestedRawLowerBound = f.question.requestedRaw
    f.capacityAgreement = agreeHolderExitCapacityQuotes({ host: 'eth-mainnet.g.alchemy.com', quote: quotes[0] },
      { host: 'rpc.ankr.com', quote: quotes[1] }, ISSUE_MS)!
    expect(f.capacityAgreement).not.toBeNull()
    f.response.capacityAgreement = f.capacityAgreement
    const before = structuredClone(f.capacityAgreement), held = retained(f, 503)!, p = { ...props(f), holderMorphoV2IdleJointIssue: held }
    expect(selectedMorphoV2IdleJointForCard(held, p, null)).not.toBeNull()
    expect(render(p)).toContain('0.714002 PYUSD'); expect(f.capacityAgreement).toEqual(before)
    expect(f.capacityAgreement.origins[successfulOrigin].quote.successfulRequestedRawLowerBound).toBe(f.question.requestedRaw)
  })
  it('retains independent execution evidence for successful Q without giving the forecast execution authority', () => {
    const f = fixture()
    ;[f.capacityAgreement.quote, ...f.capacityAgreement.origins.map(origin => origin.quote)].forEach(quote => {
      quote.successfulRequestedRawLowerBound = f.question.requestedRaw; quote.quotedMaxWithdrawRaw = '714000'
    })
    const question = { routeKey: f.question.routeKey, destinationAddress: f.question.destination,
      owner: f.question.requestedHolderAddress, assetsRaw: f.question.requestedRaw,
      finalAssetAddress: f.question.requestedAssetAddress, finalAssetDecimals: 6 }
    const executionAgreement = { question, routeAndContractIdentityVerified: true, inputAndFinalAssetAddressesVerified: true,
      simulations: f.capacityAgreement.origins.map(origin => ({ question, originHost: origin.host,
        source: structuredClone(origin.quote.source), kind: 'full_route_execution', execution: 'single_call',
        fullRouteExecutionVerified: true, requiredStages: [{ name: 'atomic_exit', status: 'executed' }],
        finalAssetAmountRaw: f.question.requestedRaw, status: 'simulated' })) }
    const { asOfMs: _clock, ...q } = f.question
    expect(holderMorphoV2IdleJointIssueFromResponse(f.response, 200, q, ISSUE_MS)).toBeNull()
    const held = holderMorphoV2IdleJointIssueFromResponse({ ...f.response, executionAgreement }, 200, q, ISSUE_MS)!
    const model = selectedMorphoV2IdleJointForCard(held, props(f), null)!
    expect(model).not.toBeNull(); expect(model.claims.executionValidated).toBe(false)
    expect(model.claims.guaranteedExecution).toBe(false)
  })
  it('rejects every noncanonical failure response and forged approval-only payload', () => {
    const f = fixture(), { asOfMs: _clock, ...q } = f.question
    expect(holderMorphoV2IdleJointIssueFromResponse({ ...f.response, error: 'other' }, 503, q, ISSUE_MS)).toBeNull()
    expect(holderMorphoV2IdleJointIssueFromResponse(f.response, 500, q, ISSUE_MS)).toBeNull()
    expect(holderMorphoV2IdleJointIssueFromResponse({ morphoV2IdleJointIssuedAtUtc: new Date(ISSUE_MS).toISOString(),
      morphoV2IdleHolderForecastEvidence: JSON.stringify({ approved: true }) }, 200, q, ISSUE_MS)).toBeNull()
  })
  it.each(['missing', 'noncanonical', 'future', 'before_read', 'accessor'])('rejects the %s server timestamp', kind => {
    const f = fixture(), { asOfMs: _clock, ...q } = f.question
    const response = { ...f.response } as Record<string, unknown>; let invoked = false
    if (kind === 'missing') delete response.morphoV2IdleJointIssuedAtUtc
    if (kind === 'noncanonical') response.morphoV2IdleJointIssuedAtUtc = '2026-10-10T05:30:32Z'
    if (kind === 'future') response.morphoV2IdleJointIssuedAtUtc = new Date(ISSUE_MS + 2000).toISOString()
    if (kind === 'before_read') response.morphoV2IdleJointIssuedAtUtc = new Date(Date.parse(f.wire.current.readAtUtc) - 1).toISOString()
    if (kind === 'accessor') Object.defineProperty(response, 'morphoV2IdleJointIssuedAtUtc', {
      enumerable: true, get() { invoked = true; throw Error('must_not_read_provider_secrets') },
    })
    expect(holderMorphoV2IdleJointIssueFromResponse(response, 200, q, ISSUE_MS + 1000)).toBeNull()
    expect(invoked).toBe(false)
  })
  it('rejects stale reception and clock rollback without reissuing during render', () => {
    const f = fixture(), p = props(f), held = p.holderMorphoV2IdleJointIssue!
    expect(retained(f, 200, Date.parse(f.question.independentSource!.blockTime) + 1800001)).toBeNull()
    expect(selectedMorphoV2IdleJointForCard(held, { ...p, asOfMs: ISSUE_MS - 1 }, null)).toBeNull()
    expect(selectedMorphoV2IdleJointForCard(held, { ...p,
      asOfMs: Date.parse(f.question.independentSource!.blockTime) + 1800001 }, null)).toBeNull()
    const model = selectedMorphoV2IdleJointForCard(held, { ...p, asOfMs: ISSUE_MS + 60000 }, null)!
    expect(model.issuedAtMs).toBe(ISSUE_MS); expect(model.targetAtUtc).toBe(new Date(ISSUE_MS + 3600000).toISOString())
  })
  it.each(['owner', 'route', 'destination', 'Q', 'horizon', 'asset', 'units'])('rejects active %s rebinding', kind => {
    const f = fixture(), p = props(f), held = p.holderMorphoV2IdleJointIssue!
    if (kind === 'owner') p.requestedHolderAddress = '0x' + 'a'.repeat(40)
    if (kind === 'route') p.routeKey = 'USDC → VaultV2 [USDC]'
    if (kind === 'destination') p.destination = '0x' + 'a'.repeat(40)
    if (kind === 'Q') p.requestedRaw = '499999'
    if (kind === 'horizon') p.horizonHours = 24
    if (kind === 'asset') p.requestedAssetAddress = '0x' + 'a'.repeat(40)
    if (kind === 'units') p.requestedAssetDecimals = 18
    expect(selectedMorphoV2IdleJointForCard(held, p, null)).toBeNull()
    expect(render(p)).not.toContain('0.714002 PYUSD')
  })
  it('rejects JSON receipts, approval booleans and conflicting native source witnesses', () => {
    const f = fixture(), p = props(f), held = p.holderMorphoV2IdleJointIssue!
    expect(selectedMorphoV2IdleJointForCard(JSON.parse(JSON.stringify(held)), p, null)).toBeNull()
    expect(selectedMorphoV2IdleJointForCard({ approved: true }, p, null)).toBeNull()
    const current: ExitPressureCurrentCash = { routeKey: p.routeKey, destination: p.destination,
      assetAddress: p.requestedAssetAddress!, assetDecimals: 6, assetSymbol: 'PYUSD',
      cashRaw: '39678091697943', block: String(f.question.independentSource!.blockNumber),
      blockHash: f.question.independentSource!.blockHash, observedAt: f.question.independentSource!.blockTime,
      freshness: 'fresh', label: 'Vault cash' }
    expect(selectedMorphoV2IdleJointForCard(held, p, current)).not.toBeNull()
    expect(selectedMorphoV2IdleJointForCard(held, p, { ...current, blockHash: '0x' + 'a'.repeat(64) })).toBeNull()
    expect(render({ ...p, holderMorphoV2IdleJointIssue: structuredClone(held) })).not.toContain('0.714002 PYUSD')
    expect(render({ ...p, scenarioMode: 'initial_deposit' })).not.toContain('Projected exit capacity')
  })
  it('accepts a matching fetched fallback with no block witness without replacing native cash', () => {
    const f = fixture(), p = props(f), held = p.holderMorphoV2IdleJointIssue!
    const fallback: ExitPressureCurrentCash = { routeKey: p.routeKey, destination: p.destination,
      assetAddress: p.requestedAssetAddress!, assetDecimals: 6, assetSymbol: 'PYUSD', cashRaw: '1',
      observedAt: new Date(ISSUE_MS + 9000).toISOString(), freshness: 'fresh', label: 'Vault cash' }
    const original = selectedMorphoV2IdleJointForCard(held, p, null)!
    const selected = selectedMorphoV2IdleJointForCard(held, p, fallback)
    expect(selected).toBe(original); expect(selected!.currentIdleCashRaw).toBe('39678091697943')
    expect(render({ ...p, currentCash: fallback })).toContain('0.714002 PYUSD')
  })
  it.each(['block', 'hash'])('rejects a conflicting partial %s while a matching partial witness is optional', kind => {
    const f = fixture(), p = props(f), held = p.holderMorphoV2IdleJointIssue!
    const fallback: ExitPressureCurrentCash = { routeKey: p.routeKey, destination: p.destination,
      assetAddress: p.requestedAssetAddress!, assetDecimals: 6, assetSymbol: 'PYUSD', cashRaw: '1',
      observedAt: new Date(ISSUE_MS + 9000).toISOString(), freshness: 'fresh', label: 'Vault cash' }
    const matching = kind === 'block' ? { ...fallback, block: String(f.question.independentSource!.blockNumber) }
      : { ...fallback, blockHash: f.question.independentSource!.blockHash }
    expect(selectedMorphoV2IdleJointForCard(held, p, matching)).not.toBeNull()
    const conflicting = kind === 'block' ? { ...fallback, block: '1' } : { ...fallback, blockHash: '0x' + 'a'.repeat(64) }
    expect(selectedMorphoV2IdleJointForCard(held, p, conflicting)).toBeNull()
    expect(render({ ...p, currentCash: conflicting })).not.toContain('0.714002 PYUSD')
  })
  it.each(['route', 'destination', 'asset', 'units', 'complete_timestamp'])('rejects conflicting fallback %s facts', kind => {
    const f = fixture(), p = props(f), held = p.holderMorphoV2IdleJointIssue!
    const fallback: ExitPressureCurrentCash = { routeKey: p.routeKey, destination: p.destination,
      assetAddress: p.requestedAssetAddress!, assetDecimals: 6, assetSymbol: 'PYUSD', cashRaw: '1',
      observedAt: new Date(ISSUE_MS + 9000).toISOString(), freshness: 'fresh', label: 'Vault cash' }
    if (kind === 'route') fallback.routeKey = 'USDC → VaultV2 [USDC]'
    if (kind === 'destination') fallback.destination = '0x' + 'a'.repeat(40)
    if (kind === 'asset') fallback.assetAddress = '0x' + 'a'.repeat(40)
    if (kind === 'units') fallback.assetDecimals = 18
    if (kind === 'complete_timestamp') {
      fallback.block = String(f.question.independentSource!.blockNumber)
      fallback.blockHash = f.question.independentSource!.blockHash
    }
    expect(selectedMorphoV2IdleJointForCard(held, p, fallback)).toBeNull()
    expect(render({ ...p, currentCash: fallback })).not.toContain('0.714002 PYUSD')
  })
  it('keeps conditional shortfall visible for reverted requested withdrawal', () => {
    const f = fixture(1, '1000000'), p = props(f), html = render(p)
    const model = selectedMorphoV2IdleJointForCard(p.holderMorphoV2IdleJointIssue, p, null)!
    if (model.status !== 'conditional_morpho_v2_idle_joint_holder_forecast') throw Error('expected v1 receipt')
    expect(model).not.toBeNull(); expect(model.process.descriptive.headline?.signedMargin.minimumRaw).toBe('-285998')
    expect(model.process.descriptive.headline?.available.minimumRaw).toBe('714002')
    expect(html).toContain('0.714002 PYUSD'); expect(html).toContain('Shortage 1 · onset bound')
    expect(html).toContain('2026-10-10 05:30 UTC'); expect(html).not.toContain('>Now<')
    expect(render({ ...p, asOfMs: model.issuedAtMs + 600000 })).toContain('2026-10-10 05:30 UTC')
    expect(html).not.toContain('Withdrawal simulation passed')
  })
  it('uses synthetic supplementary ABI-format quotes for shrinking and sampled loss timing', () => {
    const f = changedStock(), p = props(f), model = selectedMorphoV2IdleJointForCard(p.holderMorphoV2IdleJointIssue, p, null)!
    if (model.status !== 'conditional_morpho_v2_idle_joint_holder_forecast') throw Error('expected v1 receipt')
    expect(model).not.toBeNull()
    const s = model.process.scenarios[0]
    expect(s.status).toBe('usable')
    if (s.status !== 'usable') throw Error('expected controlled idle donor')
    expect(s.sampledTimeline.shrinkingAtHorizon).toBe(true)
    expect(s.sampledTimeline.firstSampledCrossing).not.toBeNull()
    const html = render(p)
    expect(html).toContain('SHRINKING'); expect(html).toContain('Shortage 1 · onset bound')
    const utc = (elapsed: number) => new Date(model.issuedAtMs + elapsed).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
    const interval = `${utc(s.sampledTimeline.firstSampledCrossing!.earliestElapsedMs)}–${utc(s.sampledTimeline.firstSampledCrossing!.latestElapsedMs)}`
    expect(html).toContain(interval)
    expect(render({ ...p, asOfMs: model.issuedAtMs + 600000 })).toContain(interval)
    expect(model.issuedAtMs).toBe(f.question.asOfMs)
    expect(html).not.toContain('Ea '); expect(html).not.toContain('M ?')
  })
  it.each([['214002', 6, '0.21'], ['-285998', 6, '−0.29'], ['39678091697943', 6, '40,000,000'],
    ['99999', 6, '0.1'], ['0', 6, '0']])('rounds native %s without float coercion', (raw, decimals, text) => {
    expect(formatExitPressureApproxRaw(String(raw), Number(decimals))).toBe(text)
  })
  it.each([
    ['714002', '714009', '0.71–0.72'],
    ['-285998', '-285991', '−0.29–−0.28'],
    ['-1', '1', '−0.000001–0.000001'],
    ['0', '0', '0'],
    ['719999', '719999', '0.719999'],
    ['-719999', '-719999', '−0.719999'],
    ['2', '1', null],
  ])('keeps interval %s–%s outward rather than collapsing it to a floor', (lower, upper, expected) => {
    expect(formatExitPressureRawRange(lower!, upper!, 6)).toBe(expected)
  })
})

describe('pinned120 panel UI with explicitly synthetic current controls', () => {
  it.each([200, 503])('retains original v2 receipt from canonical HTTP%s and preserves native same-stock bounds', (status) => {
    const f = syntheticPanelFixture(), held = retained(f, status)!, p = { ...props(f), holderMorphoV2IdleJointIssue: held }
    const model = selectedMorphoV2IdleJointForCard(held, p, null)!
    expect(model).not.toBeNull()
    if (model.status !== 'conditional_morpho_v2_idle_panel_holder_forecast') throw Error('expected v2 receipt')
    expect(model.entitlementBasis).toBe('native_same_stock')
    expect(model.process.status).toBe('conditional_morpho_v2_idle_joint_stock_projection')
    expect(model.capacityInterval.lowerAvailableRaw).toBe(model.process.descriptive.headline!.available.minimumRaw)
    expect(model.capacityInterval.upperAvailableRaw).toBe(model.process.descriptive.headline!.available.maximumRaw)
    expect(model.claims.executionValidated).toBe(false)
    expect(render(p)).toContain(`${formatExitPressureRawRange(model.capacityInterval.lowerAvailableRaw, model.capacityInterval.upperAvailableRaw, 6)} PYUSD`)
    expect(render(p)).toContain('Projected shortage onset')
    expect(render(p)).not.toContain('NATIVE SAME STOCK')
    expect(render(p)).not.toContain('DONORS MAY SHRINK')
  })
  it('shows other-stock interval amounts rather than silently selecting a conservative endpoint', () => {
    const f = syntheticPanelFixture(true), p = props(f)
    const model = selectedMorphoV2IdleJointForCard(p.holderMorphoV2IdleJointIssue, p, null)!
    if (model.status !== 'conditional_morpho_v2_idle_panel_holder_forecast') throw Error('expected v2 receipt')
    expect(model.entitlementBasis).toBe('conditional_quote_rate_interval')
    expect(model.process.status).toBe('conditional_morpho_v2_idle_joint_entitlement_interval_projection')
    expect(BigInt(model.capacityInterval.upperAvailableRaw)).toBeGreaterThan(BigInt(model.capacityInterval.lowerAvailableRaw))
    const html = render(p)
    for (const [low, high] of [[model.capacityInterval.lowerAvailableRaw, model.capacityInterval.upperAvailableRaw], [model.capacityInterval.lowerHeadroomRaw, model.capacityInterval.upperHeadroomRaw], [model.capacityInterval.lowerShortfallRaw, model.capacityInterval.upperShortfallRaw]]) {
      expect(html).toContain(`${formatExitPressureRawRange(low, high, 6)} PYUSD`)
    }
    expect(html).toContain('Projected shortage'); expect(html).toContain('Capacity change')
    expect(html).toContain('Projected shortage duration'); expect(html).toContain(morphoIdlePanelDurationValue(model))
    expect(model.panelInspection.historicalOwnership).toBe(false)
    expect(model.panelInspection.accuracyImprovementClaim).toBe(false)
  })
  it.each(['owner', 'Q', 'horizon', 'source', 'units'])('rejects original v2 receipt with changed active %s', (kind) => {
    const f = syntheticPanelFixture(true), p = props(f), original = p.holderMorphoV2IdleJointIssue
    let witness: ExitPressureCurrentCash | null = null
    if (kind === 'owner') p.requestedHolderAddress = '0x' + 'a'.repeat(40)
    if (kind === 'Q') p.requestedRaw = '999999'
    if (kind === 'horizon') p.horizonHours = 1
    if (kind === 'units') p.requestedAssetDecimals = 18
    if (kind === 'source') witness = { routeKey: p.routeKey, destination: p.destination, assetAddress: p.requestedAssetAddress!, assetDecimals: 6, assetSymbol: 'PYUSD', cashRaw: '1', block: String(f.question.independentSource!.blockNumber), blockHash: '0x' + 'a'.repeat(64), observedAt: f.question.independentSource!.blockTime, freshness: 'fresh', label: 'Vault cash' }
    expect(selectedMorphoV2IdleJointForCard(original, p, witness)).toBeNull()
  })
  it('rejects copied v2 receipts and preserves source zero outcomes independently from old-regime censors', () => {
    const f = syntheticPanelFixture(), p = props(f)
    expect(selectedMorphoV2IdleJointForCard(JSON.parse(JSON.stringify(p.holderMorphoV2IdleJointIssue)), p, null)).toBeNull()
    const model = selectedMorphoV2IdleJointForCard(p.holderMorphoV2IdleJointIssue, p, null)!
    if (model.status !== 'conditional_morpho_v2_idle_panel_holder_forecast') throw Error('expected v2 receipt')
    expect(model.panelInspection.configurationCensoredPairs).toBeGreaterThan(0)
    const zeroCashDonor = model.process.scenarios.find(scenario => scenario.id === 'native_panel_pair_58')
    expect(zeroCashDonor?.status).toBe('usable')
    if (!zeroCashDonor || zeroCashDonor.status !== 'usable') throw Error('expected retained zero-cash donor')
    expect(zeroCashDonor.idleCashDeltaRaw).toBe('-27925379416535')
    expect(zeroCashDonor.measurement.availableRaw).toBe('714072')
    expect(model.capacityInterval.lowerAvailableRaw).toBe('714029')
    expect(model.capacityInterval.upperAvailableRaw).toBe('714075')
    // Historical zero cash is an uncensored endpoint, not projected zero current capacity.
    const panel = JSON.parse(readFileSync(resolve('data/research/venue-signals/morpho-v2-idle-compact120-panel-2026-10-10-5f90f936-a60b-48a1-a807-dc91a07be66f/panel.json'), 'utf8'))
    expect(panel.endpoints[116][3]).toBe('27925379416535')
    expect(panel.endpoints[117][3]).toBe('0')
    expect(panel.endpoints[117][9]).toBe(0)
    expect(BigInt(panel.endpoints[117][3]) - BigInt(panel.endpoints[116][3])).toBe(-27925379416535n)
    expect(render(p)).toContain(`${formatExitPressureRawRange('714029', '714075', 6)} PYUSD`)
    expect(model.process.censoredDonorCount).toBe(0)
  })
  it('formats analytical per-episode durations and open or no-shortage states', () => {
    const f = syntheticPanelFixture(), p = props(f)
    const model = selectedMorphoV2IdleJointForCard(p.holderMorphoV2IdleJointIssue, p, null)!
    if (model.status !== 'conditional_morpho_v2_idle_panel_holder_forecast') throw Error('expected v2 receipt')
    // Display-only copies exercise formatting; they never enter the private receipt or Card selector.
    const hour = 3600000
    const lane = { ...model.modeledShortageSummary.possible, episodeCount: 2, neverShortageScenarioCount: 0, fullEpisodeDurationRangeMs: { lowerMs: hour, upperMs: 3 * hour } }
    const display = { ...model, modeledShortageSummary: { ...model.modeledShortageSummary, possible: lane, definite: lane } }
    expect(morphoIdlePanelDurationValue(display)).toBe('1h–3h')
    const open = { ...display, modeledShortageSummary: { ...display.modeledShortageSummary, possible: { ...lane, rightCensoredScenarioCount: 1, fullEpisodeDurationRangeMs: { lowerMs: hour, upperMs: null } } } }
    expect(morphoIdlePanelDurationValue(open)).toBe('1h–unresolved')
    const never = { ...display, modeledShortageSummary: { ...display.modeledShortageSummary, possible: { ...lane, episodeCount: 0, fullEpisodeDurationRangeMs: null, neverShortageScenarioCount: 1 } } }
    expect(morphoIdlePanelDurationValue(never)).toBe('No projected shortage')
    expect(morphoIdlePanelDurationValue({ ...never, modeledShortageSummary: { ...never.modeledShortageSummary, censoredScenarioCount: 1 } })).toBe('Unresolved')
  })
  it('does not turn a hidden adequate window between samples into a continuous shortage duration', () => {
    const analytic = buildModeledShortageWindows({ currentIdleCashRaw: '0', currentFullEaRaw: '260', requestedRaw: '129', idleCashDeltaRaw: '4', entitlementDeltaRaw: '-4', periodMs: 1000, sourceAgeMs: 0, horizonMs: 64000, competingMRaw: null })!
    if (analytic.status !== 'modeled') throw Error('expected analytical windows')
    expect(analytic.adequacyWindow).toEqual({ firstIntegerAdequateMs: 32250, lastIntegerAdequateMs: 32750 })
    expect(analytic.windows.map(w => w.modeledDurationMs)).toEqual([{ lowerMs: 32250, upperMs: 32250 }, { lowerMs: 31250, upperMs: 31250 }])
    const f = syntheticPanelFixture(), p = props(f), model = selectedMorphoV2IdleJointForCard(p.holderMorphoV2IdleJointIssue, p, null)!
    if (model.status !== 'conditional_morpho_v2_idle_panel_holder_forecast') throw Error('expected v2 receipt')
    // Pure formatting control. Analytical runs supersede misleading sampled-span duration.
    const display = { ...model, modeledShortageWindows: [{ scenarioId: 'hidden-recovery', possible: analytic, definite: analytic }], modeledShortageSummary: { ...model.modeledShortageSummary, possible: { ...model.modeledShortageSummary.possible, neverShortageScenarioCount: 0, episodeCount: 2, fullEpisodeDurationRangeMs: { lowerMs: 31250, upperMs: null } } } }
    expect(morphoIdlePanelDurationValue(display)).toBe('31s–unresolved')
    expect(morphoIdlePanelDurationValue(display)).not.toContain('1min')
  })
  it('contains changed-stock capacity loss when the nonzero-age issue amount is itself an interval', () => {
    const f = syntheticPanelFixture(true), p = props(f)
    const model = selectedMorphoV2IdleJointForCard(p.holderMorphoV2IdleJointIssue, p, null)!
    if (model.status !== 'conditional_morpho_v2_idle_panel_holder_forecast' || model.process.status !== 'conditional_morpho_v2_idle_joint_entitlement_interval_projection') throw Error('expected conditional v2 interval')
    const scenario = model.process.scenarios.find(s => s.status === 'usable')!
    if (scenario.status !== 'usable') throw Error('expected usable interval')
    // Pure display-only regression: S6, probe1, historical Ea2→1, age1000/D1000/H1000.
    // Issue capacity [9,10], target [0,10]. No copied model enters an approval/receipt selector.
    const display = { ...model, process: { ...model.process, sourceAgeMs: 1000, scenarios: [{ ...scenario, issueMeasurement: { ...scenario.issueMeasurement, availableRaw: '9' }, issueInterval: { ...scenario.issueInterval, availableLowerRaw: '9', availableUpperRaw: '10' }, measurementInterval: { ...scenario.measurementInterval, availableLowerRaw: '0', availableUpperRaw: '10' } }] } }
    expect(morphoIdlePanelCapacityChange(display)).toEqual({ lowerRaw: '-10', upperRaw: '1', shrinkingDonorCount: 1, donorCount: 1 })
  })
})
