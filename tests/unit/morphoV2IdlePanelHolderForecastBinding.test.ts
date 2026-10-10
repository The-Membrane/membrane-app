import { describe, expect, it } from 'vitest'
import { agreeHolderExitCapacityQuotes } from '../../lib/carry/holderExitCapacity'
import { issuedMorphoV2IdleJointHolderForecastV2, morphoV2IdleJointHolderForecastV2FromResponse, morphoV2IdleJointHolderForecastV2Issue, morphoV2IdleJointHolderForecastV2IssueFromResponse, selectedMorphoV2IdleJointHolderForecastV2, selectedMorphoV2IdleJointHolderForecastV2FromIssue } from '../../lib/carry/morphoV2IdlePanelHolderForecastBinding'
import { panelForecastFixture, PANEL_TEST_HOSTS, PANEL_TEST_ISSUE_MS, PANEL_TEST_SOURCE_MS } from './morphoV2IdlePanelForecast.fixture'

describe('original browser-local compact panel holder forecast and receipt', () => {
  it.each([false, true])('issues distinct native or conditional models changedStock=%s without changing the recorded probe', changed => {
    const f = panelForecastFixture({ changedStock: changed, horizonHours: 24 }), model = issuedMorphoV2IdleJointHolderForecastV2(f.capacity, f.text, f.question)!
    expect(model).not.toBeNull(); expect(model.entitlementBasis).toBe(changed ? 'conditional_quote_rate_interval' : 'native_same_stock')
    expect(model.process.status).toBe(changed ? 'conditional_morpho_v2_idle_joint_entitlement_interval_projection' : 'conditional_morpho_v2_idle_joint_stock_projection')
    expect(model.process.usableDonorCount).toBe(54); expect(model.process.competingMRaw).toBeNull()
    expect(model.panelInspection.configurationCensoredPairs).toBe(6); expect(model.panelInspection.causalUsablePairs).toBe(54)
    expect(model.panelInspection.retrospectiveScores).toMatchObject({ joint: { comparisons: 53, availableAbsoluteErrorSumRaw: '727336' }, matchedPersistence: { comparisons: 53, availableAbsoluteErrorSumRaw: '715779' }, availableErrorImproved: false })
    expect(model.claims.executionValidated).toBe(false); expect(model.claims.guaranteedExecution).toBe(false)
    expect(model.panelInspection.historicalOwnership).toBe(false)
    expect(model.currentSharesRaw).toBe(f.expectation.sharesRaw); expect(model.currentFullEaRaw).toBe(f.expectation.fullEaRaw)
    expect(BigInt(model.capacityInterval.lowerAvailableRaw)).toBeLessThanOrEqual(BigInt(model.capacityInterval.upperAvailableRaw))
    const usable = model.process.scenarios.filter(s => s.status === 'usable')
    expect(usable.every(s => s.sampledTimeline.checkpoints.length === 65)).toBe(true)
    const lowers = usable.map(s => s.measurement.availableRaw), uppers = usable.map(s => 'measurementInterval' in s ? s.measurementInterval.availableUpperRaw : s.measurement.availableRaw)
    expect(model.capacityInterval.lowerAvailableRaw).toBe(lowers.reduce((a, b) => BigInt(a) < BigInt(b) ? a : b))
    expect(model.capacityInterval.upperAvailableRaw).toBe(uppers.reduce((a, b) => BigInt(a) > BigInt(b) ? a : b))
    const expectedMeanPositiveShortfall = usable.reduce((sum, s) => sum + BigInt(s.measurement.shortfallRaw), 0n) / BigInt(usable.length)
    expect(model.capacityInterval.empiricalMean.upperShortfallRaw).toBe(expectedMeanPositiveShortfall.toString())
    expect(model.sampledIntervalSummary.continuousProof).toBe(false)
    expect(model.sampledShortageRuns).toHaveLength(54)
    expect(model.sampledShortageSummary).toMatchObject({ modeled: true, measuredHistoryDuration: false, continuousProof: false, guaranteedDurationMs: null })
  })
  it('keeps currently insufficientQ as visible positive shortfall rather than requiring current execution success', () => {
    const f = panelForecastFixture({ q: '100000000000000', horizonHours: 24 }), model = issuedMorphoV2IdleJointHolderForecastV2(f.capacity, f.text, f.question)!
    expect(model).not.toBeNull(); expect(f.capacity.quote.successfulRequestedRawLowerBound).toBeNull()
    expect(BigInt(model.capacityInterval.lowerShortfallRaw)).toBeGreaterThan(0n)
    expect(model.sampledIntervalSummary.firstSampledDefiniteInsufficiencyMs).toBe(0)
    expect(model.sampledShortageSummary.possible.rightCensoredScenarioCount).toBe(54)
    expect(model.sampledShortageSummary.possible.leftCensoredScenarioCount).toBe(54)
    expect(model.sampledShortageSummary.possible.latestBoundedRecoveryMs).toBeNull()
    expect(model.modeledShortageSummary.possible).toMatchObject({ episodeCount: 54, leftCensoredScenarioCount: 54, rightCensoredScenarioCount: 54, fullEpisodeDurationRangeMs: { lowerMs: 86400000, upperMs: null } })
    expect(model.claims.executionValidated).toBe(false)
  })
  it.each([false, true])('binds analytical windows to fresh raw stocks and each causal donor, changedStock=%s', changed => {
    const f = panelForecastFixture({ changedStock: changed, horizonHours: 24 }), model = issuedMorphoV2IdleJointHolderForecastV2(f.capacity, f.text, f.question)!
    expect(model.modeledShortageWindows).toHaveLength(54)
    for (const s of model.process.scenarios) {
      if (s.status !== 'usable') throw Error('unexpected arithmetic censor')
      const lanes = model.modeledShortageWindows.find(w => w.scenarioId === s.id)!
      for (let i = 0; i < s.sampledTimeline.checkpoints.length; i++) {
        const sample = s.sampledTimeline.checkpoints[i], interval = 'sampledIntervalTimeline' in s ? s.sampledIntervalTimeline.checkpoints[i] : null
        for (const key of ['possible', 'definite'] as const) {
          const window = lanes[key].adequacyWindow, elapsed = sample.elapsedMs
          const insufficient = !window || elapsed < window.firstIntegerAdequateMs || elapsed > window.lastIntegerAdequateMs
          expect(insufficient).toBe(interval ? interval[key === 'possible' ? 'possibleInsufficiency' : 'definiteInsufficiency'] : BigInt(sample.shortfallRaw) > 0n)
        }
      }
      if (!changed) expect(lanes.possible).toEqual(lanes.definite)
      expect(lanes.possible).toMatchObject({ actualHistoricalContinuousDuration: false, measuredHistoryDuration: false, calibrated: false, guaranteedDurationMs: null })
    }
    for (const key of ['possible', 'definite'] as const) {
      const lanes = model.modeledShortageWindows.map(w => w[key]), windows = lanes.flatMap(l => l.windows), summary = model.modeledShortageSummary[key]
      expect(summary.episodeCount).toBe(windows.length)
      expect(summary.neverShortageScenarioCount).toBe(lanes.filter(l => l.neverInsufficient).length)
      if (windows.some(w => w.leftCensored || w.rightCensored)) expect(summary.fullEpisodeDurationRangeMs?.upperMs).toBeNull()
    }
    expect(model.modeledShortageSummary).toMatchObject({ relevantScenarioCount: 54, censoredScenarioCount: 0, basis: 'individual_analytical_model_windows_not_sample_spans', continuousProof: false, guaranteedDurationMs: null })
  })
  it('preserves a conditional outlook for valid zero current cash and full entitlement rather than fabricating funding', () => {
    const f = panelForecastFixture({ idleCashRaw: '0', fullEaRaw: '0' }), model = issuedMorphoV2IdleJointHolderForecastV2(f.capacity, f.text, f.question)!
    expect(model).not.toBeNull(); expect(model.currentFullEaRaw).toBe('0'); expect(model.currentIdleCashRaw).toBe('0')
    expect(model.process.currentObservedMeasurement.availableRaw).toBe('0')
    expect(model.process.currentObservedMeasurement.shortfallRaw).toBe(f.question.requestedRaw)
    expect(model.claims.executionValidated).toBe(false)
  })
  it('keeps historical owner balances diagnostic for a different fresh owner', () => {
    const f = panelForecastFixture({ owner: '0x' + '7'.repeat(40) }), model = issuedMorphoV2IdleJointHolderForecastV2(f.capacity, f.text, f.question)!
    expect(model).not.toBeNull(); expect(model.owner).toBe(f.question.requestedHolderAddress)
    expect(model.panelInspection.historicalOwnership).toBe(false)
    // The model has no historical owned-entitlement field or fabricated ownership evidence.
    expect('historicalOwnedEntitlementAssetRaw' in model).toBe(false)
  })
  it('uses full simultaneous scenario checkpoints for shortage timing, retaining never-lost scenarios', () => {
    const f = panelForecastFixture({ changedStock: true, horizonHours: 24 }), model = issuedMorphoV2IdleJointHolderForecastV2(f.capacity, f.text, f.question)!
    const usable = model.process.scenarios.filter(s => s.status === 'usable'), q = BigInt(f.question.requestedRaw)
    const first = usable[0].sampledTimeline.checkpoints.findIndex((_p, i) => usable.every(s => BigInt('sampledIntervalTimeline' in s ? s.sampledIntervalTimeline.checkpoints[i].availableUpperRaw : s.sampledTimeline.checkpoints[i].availableRaw) < q))
    expect(model.sampledIntervalSummary.firstSampledDefiniteInsufficiencyMs).toBe(first < 0 ? null : usable[0].sampledTimeline.checkpoints[first].elapsedMs)
    const affected = usable.map(s => s.sampledTimeline.firstSampledInsufficiencyMs).filter((x): x is number => x !== null)
    expect(model.sampledIntervalSummary.latestAffectedSampledInsufficiencyMs).toBe(affected.length ? Math.max(...affected) : null)
    expect(model.sampledIntervalSummary.neverInsufficientScenarioCount).toBe(usable.filter(s => s.sampledTimeline.firstSampledInsufficiencyMs === null).length)
    expect(model.sampledIntervalSummary.censoredScenarioCount).toBe(0)
    const possibleLanes = model.sampledShortageRuns.map(s => s.possible)
    expect(model.sampledShortageSummary.possible.rightCensoredScenarioCount).toBe(possibleLanes.filter(l => l.runs.some(r => r.rightCensored)).length)
    expect(model.sampledShortageSummary.possible.neverShortageScenarioCount).toBe(possibleLanes.filter(l => l.neverSampledInsufficient).length)
    const boundedRecoveries = possibleLanes.flatMap(l => l.runs.flatMap(r => r.recoveryBracket ? [r.recoveryBracket.latestElapsedMs] : []))
    expect(model.sampledShortageSummary.possible.latestBoundedRecoveryMs).toBe(boundedRecoveries.length ? Math.max(...boundedRecoveries) : null)
  })
  it('retains only original models and receipts; cloned summaries cannot issue or select', () => {
    const f = panelForecastFixture(), model = issuedMorphoV2IdleJointHolderForecastV2(f.capacity, f.text, f.question)!, issue = morphoV2IdleJointHolderForecastV2Issue(model)!
    expect(selectedMorphoV2IdleJointHolderForecastV2(model, f.question, PANEL_TEST_ISSUE_MS + 1)).toBe(model)
    expect(selectedMorphoV2IdleJointHolderForecastV2FromIssue(issue, f.question, PANEL_TEST_ISSUE_MS + 1)).toBe(model)
    expect(morphoV2IdleJointHolderForecastV2Issue(structuredClone(model))).toBeNull()
    expect(selectedMorphoV2IdleJointHolderForecastV2(structuredClone(model), f.question, PANEL_TEST_ISSUE_MS)).toBeNull()
    expect(selectedMorphoV2IdleJointHolderForecastV2FromIssue(structuredClone(issue), f.question, PANEL_TEST_ISSUE_MS)).toBeNull()
    expect(selectedMorphoV2IdleJointHolderForecastV2FromIssue(JSON.parse(JSON.stringify(issue)), f.question, PANEL_TEST_ISSUE_MS)).toBeNull()
  })
  it.each(['Q', 'horizon', 'owner', 'route', 'vault', 'asset', 'decimals', 'issue clock', 'source'])('denies receipt rebinding %s', kind => {
    const f = panelForecastFixture(), m = issuedMorphoV2IdleJointHolderForecastV2(f.capacity, f.text, f.question)!, issue = morphoV2IdleJointHolderForecastV2Issue(m), question = structuredClone(f.question)
    if (kind === 'Q') question.requestedRaw = '1'
    if (kind === 'horizon') question.horizonHours = 24
    if (kind === 'owner') question.requestedHolderAddress = '0x' + '7'.repeat(40)
    if (kind === 'route') question.routeKey = 'RLUSD → VaultV2 [RLUSD]'
    if (kind === 'vault') question.destination = '0x' + '7'.repeat(40)
    if (kind === 'asset') question.requestedAssetAddress = '0x' + '7'.repeat(40)
    if (kind === 'decimals') question.requestedAssetDecimals = 18
    if (kind === 'issue clock') question.asOfMs++
    if (kind === 'source') question.independentSource!.blockHash = '0x' + 'a'.repeat(64)
    expect(selectedMorphoV2IdleJointHolderForecastV2FromIssue(issue, question, PANEL_TEST_ISSUE_MS + 1)).toBeNull()
  })
  it('denies source TTL expiry, backwards render and horizon expiry without extending issue time', () => {
    const f = panelForecastFixture(), m = issuedMorphoV2IdleJointHolderForecastV2(f.capacity, f.text, f.question)!, issue = morphoV2IdleJointHolderForecastV2Issue(m)
    expect(selectedMorphoV2IdleJointHolderForecastV2FromIssue(issue, f.question, PANEL_TEST_SOURCE_MS + 1800001)).toBeNull()
    expect(selectedMorphoV2IdleJointHolderForecastV2FromIssue(issue, f.question, PANEL_TEST_ISSUE_MS - 1)).toBeNull()
    expect(selectedMorphoV2IdleJointHolderForecastV2FromIssue(issue, f.question, PANEL_TEST_ISSUE_MS + 4 * 3600000)).toBeNull()
  })
  it.each([200, 503])('recognizes only exact %s native response shape with genuine compact/current evidence', status => {
    const f = panelForecastFixture(), response = { ...(status === 503 ? { error: 'holder_exit_assessment_unavailable' } : {}), capacityAgreement: f.capacity, morphoV2IdleHolderForecastEvidence: f.text }
    expect(morphoV2IdleJointHolderForecastV2FromResponse(response, status, f.question)).not.toBeNull()
    expect(morphoV2IdleJointHolderForecastV2IssueFromResponse(response, status, f.question)).not.toBeNull()
    expect(morphoV2IdleJointHolderForecastV2FromResponse({ ...response, morphoV2IdleHolderForecastEvidence: '{}' }, status, f.question)).toBeNull()
    expect(morphoV2IdleJointHolderForecastV2FromResponse({ ...response, error: 'arbitrary' }, 503, f.question)).toBeNull()
    expect(morphoV2IdleJointHolderForecastV2FromResponse(response, 502, f.question)).toBeNull()
  })
  it('does not turn successfulQ summary flags into execution evidence', () => {
    const f = panelForecastFixture(), quote = structuredClone(f.capacity.quote); quote.successfulRequestedRawLowerBound = f.question.requestedRaw
    const successful = agreeHolderExitCapacityQuotes({ host: PANEL_TEST_HOSTS[0], quote }, { host: PANEL_TEST_HOSTS[1], quote: structuredClone(quote) }, f.question.asOfMs)
    expect(issuedMorphoV2IdleJointHolderForecastV2(successful, f.text, f.question)).toBeNull()
    expect(issuedMorphoV2IdleJointHolderForecastV2(successful, f.text, f.question, { approved: true })).toBeNull()
    expect(issuedMorphoV2IdleJointHolderForecastV2(f.capacity, f.text, f.question)).not.toBeNull()
  })
  it('does not evaluate accessors or accept extra question fields', () => {
    const f = panelForecastFixture(); let read = false
    expect(issuedMorphoV2IdleJointHolderForecastV2(f.capacity, f.text, { ...f.question, get unexpected() { read = true; return true } })).toBeNull()
    expect(read).toBe(false)
    expect(issuedMorphoV2IdleJointHolderForecastV2(f.capacity, f.text, { ...f.question, arbitraryApproval: true })).toBeNull()
  })
})
