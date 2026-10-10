import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  approveMorphoV2IdleHolderForecastEvidence, decodeMorphoV2IdleHolderForecastEvidence,
  encodeMorphoV2IdleHolderForecastEvidence, selectedMorphoV2IdleHolderForecastEvidence,
  morphoV2IdleBrowserPreviewRedeemCalldata, MORPHO_V2_IDLE_PINNED_CAPSULE_SHA256,
  MORPHO_V2_IDLE_BROWSER_LIMITS,
  type MorphoV2IdleHolderForecastEvidenceWire, type MorphoV2IdleNativeBrowserTrace,
} from '@/lib/carry/morphoV2IdleHolderForecastEvidence'
import { resolveMorphoV2IdleTrustedProfile } from '@/lib/carry/morphoV2IdleTrustedProfiles'

const CAPSULE_TEXT = "{\"schemaVersion\":1,\"kind\":\"morpho_v2_idle_pinned_historical_capsule_v1\",\"profileId\":\"morpho_v2_pyusd_b576_observed_idle_history\",\"identity\":{\"profileId\":\"morpho_v2_pyusd_b576_observed_idle_history\",\"routeKey\":\"PYUSD → VaultV2 [PYUSD]\",\"destination\":\"0xb576765fb15505433af24fee2c0325895c559fb2\",\"asset\":\"0x6c3ea9036406852006290770bedfcaba0e23a0e8\",\"assetDecimals\":6,\"shareDecimals\":18},\"captureSharesRaw\":\"352805058661206444\",\"captureOwner\":\"0xf181e2cc93a47cb4903ac71c23ecb873726dc668\",\"anchors\":[{\"identity\":{\"profileId\":\"morpho_v2_pyusd_b576_observed_idle_history\",\"routeKey\":\"PYUSD → VaultV2 [PYUSD]\",\"destination\":\"0xb576765fb15505433af24fee2c0325895c559fb2\",\"asset\":\"0x6c3ea9036406852006290770bedfcaba0e23a0e8\",\"assetDecimals\":6,\"shareDecimals\":18},\"owner\":\"0xf181e2cc93a47cb4903ac71c23ecb873726dc668\",\"source\":{\"chainId\":1,\"blockNumber\":\"26100913\",\"blockHash\":\"0x2fe9266ceaaea215d32a4c5e0701f3c287705f2b976844cf3131534a814aa272\",\"blockTime\":\"2026-10-01T23:59:59.000Z\",\"finalized\":true},\"regime\":{\"kind\":\"zero_adapter_idle\",\"liquidityAdapter\":\"0x0000000000000000000000000000000000000000\",\"liquidityData\":\"0x\",\"vaultRuntimeCodeHash\":\"0xd40a644ba3984c98bcffa15709271ecedf2ff7632d763fad84d7f924bd4f6acd\",\"assetRuntimeCodeHash\":\"0xbc22d0b1173d9ff26383e64a50a807afa931a2809a7b6bae3b051723a1a9ebe1\"},\"idleCashRaw\":\"20919825104652\",\"historicalOwnerSharesRaw\":\"352805058661206444\",\"fixedCurrentStockConversion\":{\"method\":\"native_preview_redeem_fixed_current_shares\",\"source\":{\"chainId\":1,\"blockNumber\":\"26100913\",\"blockHash\":\"0x2fe9266ceaaea215d32a4c5e0701f3c287705f2b976844cf3131534a814aa272\",\"blockTime\":\"2026-10-01T23:59:59.000Z\",\"finalized\":true},\"probeSharesRaw\":\"352805058661206444\",\"asset\":\"0x6c3ea9036406852006290770bedfcaba0e23a0e8\",\"assetDecimals\":6,\"shareDecimals\":18,\"assetsRaw\":\"713612\"}},{\"identity\":{\"profileId\":\"morpho_v2_pyusd_b576_observed_idle_history\",\"routeKey\":\"PYUSD → VaultV2 [PYUSD]\",\"destination\":\"0xb576765fb15505433af24fee2c0325895c559fb2\",\"asset\":\"0x6c3ea9036406852006290770bedfcaba0e23a0e8\",\"assetDecimals\":6,\"shareDecimals\":18},\"owner\":\"0xf181e2cc93a47cb4903ac71c23ecb873726dc668\",\"source\":{\"chainId\":1,\"blockNumber\":\"26108081\",\"blockHash\":\"0x9f430d0cc4301a9f8ea0315223c2ed6e66373f6454baac771cac7449d725ba37\",\"blockTime\":\"2026-10-02T23:59:59.000Z\",\"finalized\":true},\"regime\":{\"kind\":\"zero_adapter_idle\",\"liquidityAdapter\":\"0x0000000000000000000000000000000000000000\",\"liquidityData\":\"0x\",\"vaultRuntimeCodeHash\":\"0xd40a644ba3984c98bcffa15709271ecedf2ff7632d763fad84d7f924bd4f6acd\",\"assetRuntimeCodeHash\":\"0xbc22d0b1173d9ff26383e64a50a807afa931a2809a7b6bae3b051723a1a9ebe1\"},\"idleCashRaw\":\"24375516077801\",\"historicalOwnerSharesRaw\":\"352805058661206444\",\"fixedCurrentStockConversion\":{\"method\":\"native_preview_redeem_fixed_current_shares\",\"source\":{\"chainId\":1,\"blockNumber\":\"26108081\",\"blockHash\":\"0x9f430d0cc4301a9f8ea0315223c2ed6e66373f6454baac771cac7449d725ba37\",\"blockTime\":\"2026-10-02T23:59:59.000Z\",\"finalized\":true},\"probeSharesRaw\":\"352805058661206444\",\"asset\":\"0x6c3ea9036406852006290770bedfcaba0e23a0e8\",\"assetDecimals\":6,\"shareDecimals\":18,\"assetsRaw\":\"713661\"}}],\"provenance\":{\"nativeTerminalFileSha256\":\"37773ac59805072fc8b625bb15d199bf9e14f2a679e528629db1a50f4116360a\",\"nativeReportFileSha256\":\"09f5619b3f07d62a22bf56fb6732a6b4f0a7c6dc91f0781452372ed8d5cbc136\",\"sourceCompanionManifestSha256\":\"6365044aa4e7814602d5ed499ff335d0a6b0d371ee0f56887486e41dbd66e25d\",\"verifiedReplayCompletedAtUtc\":\"2026-10-10T05:30:32.512Z\"},\"claims\":{\"researchOnly\":true,\"authenticated\":false,\"originalAuthority\":false,\"historicalOwnership\":false,\"historicalOwnedEntitlementMeasured\":false,\"currentWalletControl\":false,\"profileApproval\":false,\"sourceImplementationEquivalence\":false,\"holderExecutableExit\":false,\"forecastEligibility\":false,\"executionAuthority\":false,\"forecastAuthority\":false,\"calibrated\":false,\"calibratedProbability\":false,\"coveragePromotion\":false,\"competingMRaw\":null,\"MRaw\":null}}"
const DIRECTORY = 'data/research/venue-signals/pyusd-b576-idle-history-v2-2026-10-10T05-29-29.760Z-b9d9aa95-5eec-4e5d-92af-fd6b4d3d6091'
const ISSUE_MS = Date.parse('2026-10-10T05:30:32.512Z')
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const abi = (value: string) => '0x' + BigInt(value).toString(16).padStart(64, '0')
function fixture() {
  const reportText = readFileSync(resolve(DIRECTORY, 'report.json'), 'utf8')
  expect(digest(reportText)).toBe('09f5619b3f07d62a22bf56fb6732a6b4f0a7c6dc91f0781452372ed8d5cbc136')
  const report = JSON.parse(reportText)
  const point = report.points[0]
  let nativeStartedMs = Infinity, nativeReadMs = -Infinity
  const traces: MorphoV2IdleNativeBrowserTrace[] = point.nativeReferences.flatMap((ref: { physicalIds: number[] }) => ref.physicalIds.map((physicalId) => {
    const row = JSON.parse(readFileSync(resolve(DIRECTORY, `native-row-${String(physicalId).padStart(3, '0')}.json`), 'utf8')).row
    nativeStartedMs = Math.min(nativeStartedMs, Date.parse(row.observation.startedAtUtc)); nativeReadMs = Math.max(nativeReadMs, Date.parse(row.observation.completedAtUtc))
    const requestText = Buffer.from(row.request.requestBodyBase64, 'base64').toString('utf8')
    const body = Buffer.from(row.observation.rawBodyBase64, 'base64').toString('utf8')
    expect(digest(requestText)).toBe(row.request.requestBodySha256)
    expect(digest(body)).toBe(row.observation.bodySha256)
    return { host: row.request.host, key: row.request.key, physicalId, request: JSON.parse(requestText), envelope: JSON.parse(body) }
  }))
  const wire: MorphoV2IdleHolderForecastEvidenceWire = { schema: 'morpho_v2_idle_holder_forecast_evidence_v1', capsuleText: CAPSULE_TEXT, current: { label: 'current', source: report.currentSource, owner: report.subject.owner, probeSharesRaw: report.freshCurrentSharesRaw, traces, startedAtUtc: new Date(nativeStartedMs).toISOString(), readAtUtc: new Date(nativeReadMs).toISOString() }, historicalPreviewSupplement: null }
  const profile = resolveMorphoV2IdleTrustedProfile('PYUSD → VaultV2 [PYUSD]', report.subject.vault, report.subject.asset)!
  const expectation = { profile, owner: wire.current.owner, source: structuredClone(wire.current.source), sharesRaw: wire.current.probeSharesRaw, fullEaRaw: '714000', asOfMs: ISSUE_MS }
  return { wire, expectation }
}
function setResult(wire: MorphoV2IdleHolderForecastEvidenceWire, key: string, raw: string) {
  wire.current.traces.filter((t) => t.key === 'current:' + key).forEach((t) => { t.envelope.result = raw })
}
function changedStock() {
  const f = fixture(), shares = String(BigInt(f.expectation.sharesRaw) + 1n)
  f.expectation.asOfMs += 30000
  f.wire.current.probeSharesRaw = shares; f.expectation.sharesRaw = shares; f.expectation.fullEaRaw = '1000'
  setResult(f.wire, 'actual_owner_shares', abi(shares)); setResult(f.wire, 'fixed_stock_preview', abi('1000'))
  f.wire.current.traces.filter((t) => t.key === 'current:fixed_stock_preview').forEach((t) => { (t.request.params[0] as { data: string }).data = morphoV2IdleBrowserPreviewRedeemCalldata(shares) })
  const capsule = JSON.parse(CAPSULE_TEXT), traces: MorphoV2IdleNativeBrowserTrace[] = []
  capsule.anchors.forEach((point: { source: MorphoV2IdleHolderForecastEvidenceWire['current']['source'] }, anchor: number) => {
    const s = point.source
    ;['header_before', 'fixed_stock_preview', 'header_after'].forEach((role, i) => {
      f.wire.current.traces.slice(0, 2).forEach((template, origin) => {
        const id = 35 + anchor * 6 + i * 2 + origin
        const preview = role === 'fixed_stock_preview'
        traces.push({ host: template.host, key: `historical_${anchor}:${role}`, physicalId: id,
          request: { jsonrpc: '2.0', id, method: preview ? 'eth_call' : 'eth_getBlockByNumber', params: preview ? [{ to: f.expectation.profile.identity.destination, data: morphoV2IdleBrowserPreviewRedeemCalldata(shares) }, { blockHash: s.blockHash, requireCanonical: true }] : ['0x' + BigInt(s.blockNumber).toString(16), false] },
          envelope: { jsonrpc: '2.0', id, result: preview ? abi(anchor === 0 ? '900' : '940') : { hash: s.blockHash, number: '0x' + BigInt(s.blockNumber).toString(16), timestamp: '0x' + (BigInt(Date.parse(s.blockTime)) / 1000n).toString(16) } } })
      })
    })
  })
  f.wire.historicalPreviewSupplement = { sharesRaw: shares, startedAtUtc: '2026-10-10T05:30:33.000Z', readAtUtc: '2026-10-10T05:30:40.000Z', traces }
  return f
}

describe('browser idle native evidence with actual retained B576 capsule and current RPC bytes', () => {
  it('checks the actual capsule pin, bounded wire and independent C/full S/full Ea channels', () => {
    const f = fixture(), text = encodeMorphoV2IdleHolderForecastEvidence(f.wire)!
    expect(digest(CAPSULE_TEXT)).toBe(MORPHO_V2_IDLE_PINNED_CAPSULE_SHA256)
    expect(Buffer.byteLength(CAPSULE_TEXT)).toBe(3926)
    expect(Buffer.byteLength(text)).toBeLessThan(MORPHO_V2_IDLE_BROWSER_LIMITS.envelopeBytes)
    const approved = approveMorphoV2IdleHolderForecastEvidence(text, f.expectation)!
    expect(approved).not.toBeNull()
    expect(approved.currentIdleCashRaw).toBe('39678091697943')
    expect(approved.currentFullEaRaw).toBe('714000')
    expect(approved.currentSharesRaw).toBe('352805058661206444')
    expect(approved.anchors.map((x) => x.fixedCurrentStockConversion.assetsRaw)).toEqual(['713612', '713661'])
    expect(approved).toMatchObject({ historicalOwnedEntitlementAssetRaw: null, competingMRaw: null,
      claims: { authenticated: false, originalAuthority: false, forecastAuthority: false, executionAuthority: false, calibrated: false } })
    expect(selectedMorphoV2IdleHolderForecastEvidence(approved, f.expectation)).toBe(approved)
    expect(selectedMorphoV2IdleHolderForecastEvidence(structuredClone(approved), f.expectation)).toBeNull()
  })
  it('requires fresh native anchor previews for changed S and never scales old Ea', () => {
    const f = changedStock(), approved = approveMorphoV2IdleHolderForecastEvidence(f.wire, f.expectation)!
    expect(approved).not.toBeNull()
    expect(approved.anchors.map((x) => x.fixedCurrentStockConversion.assetsRaw)).toEqual(['900', '940'])
    expect(approved.anchors.every((x) => x.fixedCurrentStockConversion.probeSharesRaw === f.expectation.sharesRaw)).toBe(true)
    expect(approved.anchors[0].historicalOwnerSharesRaw).toBe('352805058661206444')
    f.wire.historicalPreviewSupplement = null
    expect(approveMorphoV2IdleHolderForecastEvidence(f.wire, f.expectation)).toBeNull()
  })
  it('requires changed-stock anchor previews to start after current native read completion', () => {
    const f = changedStock(), h = f.wire.historicalPreviewSupplement!
    f.wire.current.startedAtUtc = '2026-10-10T05:30:33.000Z'
    f.wire.current.readAtUtc = '2026-10-10T05:30:43.000Z'
    h.startedAtUtc = '2026-10-10T05:30:34.000Z'
    h.readAtUtc = '2026-10-10T05:30:40.000Z'
    expect(approveMorphoV2IdleHolderForecastEvidence(f.wire, f.expectation)).toBeNull()
    h.startedAtUtc = f.wire.current.readAtUtc
    h.readAtUtc = '2026-10-10T05:30:50.000Z'
    expect(approveMorphoV2IdleHolderForecastEvidence(f.wire, f.expectation)).not.toBeNull()
  })
  it('keeps another owner historical stock unknown even when fresh S equals capture S', () => {
    const f = fixture(), owner = '0x' + 'a'.repeat(40)
    f.wire.current.owner = owner; f.expectation.owner = owner
    f.wire.current.traces.filter((t) => t.key === 'current:owner_code').forEach((t) => { t.request.params[0] = owner })
    f.wire.current.traces.filter((t) => t.key === 'current:actual_owner_shares').forEach((t) => { (t.request.params[0] as { data: string }).data = '0x70a08231' + owner.slice(2).padStart(64, '0') })
    const approved = approveMorphoV2IdleHolderForecastEvidence(f.wire, f.expectation)!
    expect(approved).not.toBeNull()
    expect(approved.anchors.every((p) => p.owner === owner && p.historicalOwnerSharesRaw === null)).toBe(true)
  })
  it.each(['idle_cash', 'fixed_stock_preview', 'actual_owner_shares', 'asset', 'share_decimals', 'asset_decimals', 'liquidity_adapter', 'liquidity_data', 'owner_code', 'vault_code', 'asset_code'])('rejects native %s disagreement or changed runtime/regime', (key) => {
    const f = fixture(), t = f.wire.current.traces.find((x) => x.key === 'current:' + key)!
    t.envelope.result = key.endsWith('_code') ? '0x01' : key === 'liquidity_data' ? '0x' : abi('1')
    expect(approveMorphoV2IdleHolderForecastEvidence(f.wire, f.expectation)).toBeNull()
  })
  it.each(['runtime', 'regime', 'units', 'contract owner'])('rejects agreed but invalid %s rather than trusting two matching providers', (kind) => {
    const f = fixture()
    if (kind === 'runtime') setResult(f.wire, 'vault_code', '0x' + '00'.repeat(21808))
    if (kind === 'regime') setResult(f.wire, 'liquidity_adapter', abi('1'))
    if (kind === 'units') setResult(f.wire, 'asset_decimals', abi('18'))
    if (kind === 'contract owner') setResult(f.wire, 'owner_code', '0x00')
    expect(approveMorphoV2IdleHolderForecastEvidence(f.wire, f.expectation)).toBeNull()
  })
  it.each(['host', 'caller', 'hash', 'chain', 'duplicate id', 'header', 'full stock calldata'])('rejects %s trace contamination', (kind) => {
    const f = fixture(), t = f.wire.current.traces.find((x) => x.key === 'current:fixed_stock_preview')!
    if (kind === 'host') t.host = 'unapproved.example'
    if (kind === 'caller') (t.request.params[0] as Record<string, unknown>).from = f.expectation.owner
    if (kind === 'hash') (t.request.params[1] as { blockHash: string }).blockHash = '0x' + 'a'.repeat(64)
    if (kind === 'chain') setResult(f.wire, 'chain', '0x2')
    if (kind === 'duplicate id') t.physicalId = f.wire.current.traces[0].physicalId
    if (kind === 'header') f.wire.current.traces.find((x) => x.key === 'current:header_after')!.envelope.result = { hash: f.expectation.source.blockHash, number: '0x1', timestamp: '0x1' }
    if (kind === 'full stock calldata') (t.request.params[0] as { data: string }).data = morphoV2IdleBrowserPreviewRedeemCalldata('500000')
    expect(approveMorphoV2IdleHolderForecastEvidence(f.wire, f.expectation)).toBeNull()
  })
  it.each(['preview hash', 'old S calldata', 'provider disagreement', 'header', 'missing trace'])('rejects changed-stock supplement %s', (kind) => {
    const f = changedStock(), h = f.wire.historicalPreviewSupplement!, t = h.traces[2]
    if (kind === 'preview hash') (t.request.params[1] as { blockHash: string }).blockHash = f.expectation.source.blockHash
    if (kind === 'old S calldata') (t.request.params[0] as { data: string }).data = morphoV2IdleBrowserPreviewRedeemCalldata('352805058661206444')
    if (kind === 'provider disagreement') t.envelope.result = abi('901')
    if (kind === 'header') h.traces[0].envelope.result = { hash: f.expectation.source.blockHash, number: '0x1', timestamp: '0x1' }
    if (kind === 'missing trace') h.traces.pop()
    expect(approveMorphoV2IdleHolderForecastEvidence(f.wire, f.expectation)).toBeNull()
  })
  it('rejects capsule mutation, summary flags, duplicate keys, oversized UTF-8 and accessors', () => {
    const f = fixture()
    expect(approveMorphoV2IdleHolderForecastEvidence({ approved: true, originalAuthority: true }, f.expectation)).toBeNull()
    f.wire.capsuleText = CAPSULE_TEXT.replace('713612', '713613')
    expect(approveMorphoV2IdleHolderForecastEvidence(f.wire, f.expectation)).toBeNull()
    const text = encodeMorphoV2IdleHolderForecastEvidence(fixture().wire)!
    expect(decodeMorphoV2IdleHolderForecastEvidence(text.replace('"schema":', '"schema":"forged","schema":'))).toBeNull()
    expect(decodeMorphoV2IdleHolderForecastEvidence(' '.repeat(262145))).toBeNull()
    expect(encodeMorphoV2IdleHolderForecastEvidence({ ...fixture().wire, capsuleText: '→'.repeat(30000) })).toBeNull()
    let accessed = false
    const poisoned = Object.defineProperty({}, 'schema', { get() { accessed = true; return 'x' } })
    expect(encodeMorphoV2IdleHolderForecastEvidence(poisoned)).toBeNull()
    expect(accessed).toBe(false)
  })
  it('checks exact expectation, availability, completion, source TTL and original profile identity', () => {
    const f = fixture(), approved = approveMorphoV2IdleHolderForecastEvidence(f.wire, f.expectation)!
    expect(approveMorphoV2IdleHolderForecastEvidence(f.wire, { ...f.expectation, asOfMs: ISSUE_MS - 1 })).toBeNull()
    expect(approveMorphoV2IdleHolderForecastEvidence(f.wire, { ...f.expectation, fullEaRaw: '714001' })).toBeNull()
    expect(approveMorphoV2IdleHolderForecastEvidence(f.wire, { ...f.expectation, profile: structuredClone(f.expectation.profile) })).toBeNull()
    expect(selectedMorphoV2IdleHolderForecastEvidence(approved, { ...f.expectation, asOfMs: Date.parse(f.expectation.source.blockTime) + 1800000 })).toBe(approved)
    expect(selectedMorphoV2IdleHolderForecastEvidence(approved, { ...f.expectation, asOfMs: Date.parse(f.expectation.source.blockTime) + 1800001 })).toBeNull()
    f.wire.current.readAtUtc = '2026-10-10T05:30:33.000Z'
    expect(approveMorphoV2IdleHolderForecastEvidence(f.wire, f.expectation)).toBeNull()
  })
})
