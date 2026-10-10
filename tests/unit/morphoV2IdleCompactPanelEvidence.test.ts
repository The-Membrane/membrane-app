import { describe, expect, it } from 'vitest'
import { approveMorphoV2IdlePanelHolderForecastEvidence, decodeMorphoV2IdleCompactPanel, pinnedMorphoV2IdleCompactPanel, decodeMorphoV2IdlePanelHolderForecastEvidence, selectedMorphoV2IdlePanelHolderForecastEvidence } from '../../lib/carry/morphoV2IdleCompactPanelEvidence'
import { panelForecastFixture, panelTestAbi, PANEL_TEST_ISSUE_MS } from './morphoV2IdlePanelForecast.fixture'

describe('pinned compact panel plus independently replayed native current facts', () => {
  it('preserves both native-regime and scorer censors on all twelve older-configuration endpoints', () => {
    const f = panelForecastFixture(), panel = pinnedMorphoV2IdleCompactPanel(f.panelText, f.profile)!
    expect(panel).not.toBeNull()
    expect(panel.censorReasons).toEqual([[], ['idle_regime_differed', 'configuration_or_runtime_mismatch']])
    expect(panel.endpoints.slice(0, 12).every(p => panel.censorReasons[p[9]].length === 2)).toBe(true)
    expect(panel.endpoints.slice(12).every(p => panel.censorReasons[p[9]].length === 0)).toBe(true)
    for (const reasons of [['idle_regime_differed'], ['configuration_or_runtime_mismatch'], ['idle_regime_differed', 'unknown_censor']]) {
      const dropped = JSON.parse(f.panelText); dropped.censorReasons[1] = reasons
      expect(decodeMorphoV2IdleCompactPanel(JSON.stringify(dropped), f.profile)).toBeNull()
    }
  })
  it('distinguishes the selected120-tuple catalog commitment and retained absolute provenance from an audit-file hash or runtime path', () => {
    const f = panelForecastFixture(), panel = pinnedMorphoV2IdleCompactPanel(f.panelText, f.profile)!
    expect(panel).not.toBeNull()
    expect(panel.sourceCommitments.catalogSha256).toBe('88333133c895b7bba37a83677cb91388e9fc12b3462599f480d537f5d6ed517f')
    expect(panel.sourceCommitments.headerExecutionAcceptance.path).toBe('/Users/EBmic/membrane-app/data/research/venue-signals/morpho-v2-idle-header-backfill-parent-acceptance-2026-10-10-015a13f5-aa80-4647-9087-2f0a4f402495/manifest.json')
    const wholeAudit = JSON.parse(f.panelText)
    wholeAudit.sourceCommitments.catalogSha256 = '02e5fef639fa564e0b6e07487415aabd673e5055f6e6d9f64c8f76643e0c7917'
    expect(decodeMorphoV2IdleCompactPanel(JSON.stringify(wholeAudit), f.profile)).toBeNull()
    const rewrittenProvenance = JSON.parse(f.panelText)
    rewrittenProvenance.sourceCommitments.headerExecutionAcceptance.path = panel.sourceCommitments.headerExecutionAcceptance.path.replace('/Users/EBmic/membrane-app/', '')
    expect(decodeMorphoV2IdleCompactPanel(JSON.stringify(rewrittenProvenance), f.profile)).toBeNull()
  })
  it('retains all120 native-or-censored endpoints and the losing matched baseline without authority promotion', () => {
    const f = panelForecastFixture(), a = approveMorphoV2IdlePanelHolderForecastEvidence(f.text, f.expectation)!
    expect(a).not.toBeNull(); expect(a.panel.endpoints).toHaveLength(120); expect(a.panel.cohorts).toHaveLength(60)
    expect(a.panel.retrospectiveScores).toMatchObject({ joint: { comparisons: 53, availableAbsoluteErrorSumRaw: '727336' }, matchedPersistence: { comparisons: 53, availableAbsoluteErrorSumRaw: '715779' }, availableErrorImproved: false })
    expect(a.panel.retrospectiveScores.matchedPersistence.availableAbsoluteErrorSumRaw).toBe('715779')
    expect(a.panel.counts.censoredEndpoints).toBe(12)
    expect(a.entitlementBasis).toBe('native_same_stock'); expect(a.historicalOwnedEntitlementAssetRaw).toBeNull()
    expect(selectedMorphoV2IdlePanelHolderForecastEvidence(a, f.expectation)).toBe(a)
    expect(selectedMorphoV2IdlePanelHolderForecastEvidence(structuredClone(a), f.expectation)).toBeNull()
  })
  it('keeps differentS as conditional rates with actual current fullS/Ea and no native history repricing', () => {
    const f = panelForecastFixture({ changedStock: true }), a = approveMorphoV2IdlePanelHolderForecastEvidence(f.evidence, f.expectation)!
    expect(a.entitlementBasis).toBe('conditional_quote_rate_interval')
    expect(a.currentSharesRaw).toBe(f.expectation.sharesRaw); expect(a.currentFullEaRaw).toBe('1428001')
    expect(a.panel.recordedProbe.sharesRaw).toBe('352805058661206444')
    expect(f.evidence.current.traces).toHaveLength(32)
  })
  it.each(['cash', 'Ea', 'owner stock', 'impossible supply', 'runtime', 'owner code', 'adapter', 'unit', 'canonical', 'method', 'calldata', 'host', 'RPC error', 'missing row'])('denies native current %s mismatch', kind => {
    const f = panelForecastFixture(), ts = f.current.traces
    const mutate = (key: string, fn: (t: typeof ts[number]) => void) => ts.filter(t => t.key === 'current:' + key).forEach(fn)
    if (kind === 'cash') ts.find(t => t.key === 'current:idle_cash')!.envelope.result = panelTestAbi('1')
    if (kind === 'Ea') mutate('fixed_stock_preview', t => { t.envelope.result = panelTestAbi('1') })
    if (kind === 'owner stock') mutate('actual_owner_shares', t => { t.envelope.result = panelTestAbi('1') })
    if (kind === 'impossible supply') mutate('total_supply', t => { t.envelope.result = panelTestAbi('1') })
    if (kind === 'runtime') mutate('vault_code', t => { t.envelope.result = '0x01' })
    if (kind === 'owner code') mutate('owner_code', t => { t.envelope.result = '0x01' })
    if (kind === 'adapter') mutate('liquidity_adapter', t => { t.envelope.result = panelTestAbi('1') })
    if (kind === 'unit') mutate('asset_decimals', t => { t.envelope.result = panelTestAbi('18') })
    if (kind === 'canonical') mutate('header_after', t => { (t.envelope.result as { hash: string }).hash = '0x' + 'a'.repeat(64) })
    if (kind === 'method') ts[0].request.method = 'eth_call'
    if (kind === 'calldata') mutate('fixed_stock_preview', t => { (t.request.params[0] as { data: string }).data = '0x4cdad506' + '0'.repeat(63) + '1' })
    if (kind === 'host') ts[0].host = 'bad.example'
    if (kind === 'RPC error') Object.assign(ts[0].envelope, { error: { code: -1 } })
    if (kind === 'missing row') ts.pop()
    expect(approveMorphoV2IdlePanelHolderForecastEvidence(f.evidence, f.expectation)).toBeNull()
  })
  it('retains legitimate paired zero cash and zero full entitlement with feasible positive actual stock', () => {
    const f = panelForecastFixture({ fullEaRaw: '0', idleCashRaw: '0' }), a = approveMorphoV2IdlePanelHolderForecastEvidence(f.text, f.expectation)!
    expect(a).not.toBeNull(); expect(a.currentFullEaRaw).toBe('0'); expect(a.currentIdleCashRaw).toBe('0')
  })
  it.each(['stock', 'regime', 'source', 'units', 'score green flag', 'authority', 'missing endpoint', 'file/body commitment swap'])('rejects compact %s mutation without accepting report booleans', kind => {
    const f = panelForecastFixture(), p = JSON.parse(f.panelText)
    if (kind === 'stock') p.recordedProbe.sharesRaw = '1'
    if (kind === 'regime') p.regimes[0].liquidityData = '0x01'
    if (kind === 'source') p.endpoints[1][1] = p.endpoints[0][1]
    if (kind === 'units') p.identity.assetDecimals = 18
    if (kind === 'score green flag') p.retrospectiveScores.availableErrorImproved = true
    if (kind === 'authority') p.claims.originalAuthority = true
    if (kind === 'missing endpoint') p.endpoints.pop()
    if (kind === 'file/body commitment swap') [p.cohorts[0][1], p.cohorts[0][2]] = [p.cohorts[0][2], p.cohorts[0][1]]
    const text = JSON.stringify(p)
    expect(pinnedMorphoV2IdleCompactPanel(text, f.profile)).toBeNull()
    if (kind !== 'file/body commitment swap') expect(decodeMorphoV2IdleCompactPanel(text, f.profile)).toBeNull()
  })
  it('declines unavailable/future/stale current inputs and expires original evidence without reissuing', () => {
    const f = panelForecastFixture(), a = approveMorphoV2IdlePanelHolderForecastEvidence(f.text, f.expectation)!
    expect(selectedMorphoV2IdlePanelHolderForecastEvidence(a, { ...f.expectation, asOfMs: Date.parse(f.current.source.blockTime) + 1800000 })).toBe(a)
    expect(selectedMorphoV2IdlePanelHolderForecastEvidence(a, { ...f.expectation, asOfMs: Date.parse(f.current.source.blockTime) + 1800001 })).toBeNull()
    expect(approveMorphoV2IdlePanelHolderForecastEvidence(f.text, { ...f.expectation, asOfMs: PANEL_TEST_ISSUE_MS - 240001 })).toBeNull()
    expect(approveMorphoV2IdlePanelHolderForecastEvidence(f.text, { ...f.expectation, asOfMs: Date.parse(JSON.parse(f.panelText).actualAvailabilityAtUtc) - 1 })).toBeNull()
  })
  it('rejects oversized/noncanonical/duplicate-key wire and extra supplement fields', () => {
    const f = panelForecastFixture()
    expect(decodeMorphoV2IdlePanelHolderForecastEvidence(' ' + f.text)).toBeNull()
    expect(decodeMorphoV2IdlePanelHolderForecastEvidence('{"schema":"x",' + f.text.slice(1))).toBeNull()
    expect(decodeMorphoV2IdlePanelHolderForecastEvidence('x'.repeat(256 * 1024 + 1))).toBeNull()
    expect(decodeMorphoV2IdlePanelHolderForecastEvidence(JSON.stringify({ ...f.evidence, historicalPreviewSupplement: null }))).toBeNull()
  })
})
