import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agreeHolderExitCapacityQuotes } from '../../lib/carry/holderExitCapacity'
import { loadMorphoV2IdleCompactPanel } from '../../lib/carry/morphoV2IdleCompactPanel.server'
import { approveMorphoV2IdlePanelHolderForecastEvidence } from '../../lib/carry/morphoV2IdleCompactPanelEvidence'
import { createMorphoV2IdleNativeOrigin, readMorphoV2IdleNativePanelHolder, selectedMorphoV2IdleNativePanelRead, type MorphoV2IdleBoundedOrigin } from '../../lib/carry/morphoV2IdleNativeReader.server'
import { issueMorphoV2IdlePanelHolderForecast, selectedMorphoV2IdleServerPanelHolderForecastIssue } from '../../lib/carry/morphoV2IdleHolderForecastIssuer.server'
import { panelForecastFixture, panelTestAbi, PANEL_TEST_HOSTS, PANEL_TEST_ISSUE_MS, PANEL_TEST_SOURCE_MS } from './morphoV2IdlePanelForecast.fixture'

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] }); vi.setSystemTime(PANEL_TEST_ISSUE_MS) })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
async function fixture(changedStock = false, requestedRaw = '500000') {
  const f = panelForecastFixture({ changedStock, q: requestedRaw }), panel = await loadMorphoV2IdleCompactPanel(f.profile)
  expect(panel).not.toBeNull()
  const starts: { host: string; key: string; at: number }[] = [], occurrences = new Map<string, number>()
  let mutation = (_key: string, _host: string, value: unknown): unknown => value
  const origins = PANEL_TEST_HOSTS.map(host => createMorphoV2IdleNativeOrigin('https://' + host + '/test-only', (async (_url, init) => {
    const sent = JSON.parse(init!.body as string), candidates = f.current.traces.filter(t => t.host === host && t.request.method === sent.method && JSON.stringify(t.request.params) === JSON.stringify(sent.params))
    const key = host + JSON.stringify([sent.method, sent.params]), offset = occurrences.get(key) ?? 0; occurrences.set(key, offset + 1)
    const trace = candidates[offset % candidates.length]
    expect(trace).toBeDefined(); starts.push({ host, key: trace.key, at: performance.now() })
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: sent.id, result: mutation(trace.key, host, structuredClone(trace.envelope.result)) }))
  }) as typeof fetch)) as [MorphoV2IdleBoundedOrigin, MorphoV2IdleBoundedOrigin]
  const input = { profile: f.profile, panel: panel!, request: f.request, capacityAgreement: f.capacity, origins }
  return { ...f, panel: panel!, input, starts, mutate(fn: typeof mutation) { mutation = fn } }
}
async function complete<T>(promise: Promise<T>): Promise<T> {
  let done = false, value: T | undefined, error: unknown
  promise.then(result => { done = true; value = result }, reason => { done = true; error = reason })
  for (let i = 0; i < 2600 && !done; i++) await vi.advanceTimersByTimeAsync(25)
  expect(done).toBe(true); if (error) throw error; return value as T
}
function successfulQ(f: Awaited<ReturnType<typeof fixture>>) {
  const quote = structuredClone(f.capacity.quote); quote.successfulRequestedRawLowerBound = f.request.requestedRaw
  const capacityAgreement = agreeHolderExitCapacityQuotes({ host: PANEL_TEST_HOSTS[0], quote }, { host: PANEL_TEST_HOSTS[1], quote: structuredClone(quote) }, Date.now())!
  const question = { routeKey: f.request.routeKey, destinationAddress: f.request.destination, owner: f.request.owner, assetsRaw: f.request.requestedRaw, finalAssetAddress: f.request.asset, finalAssetDecimals: f.request.assetDecimals }
  const executionAgreement = { question, routeAndContractIdentityVerified: true, inputAndFinalAssetAddressesVerified: true, simulations: PANEL_TEST_HOSTS.map(originHost => ({ question, originHost, source: f.request.source, kind: 'full_route_execution', execution: 'single_call', fullRouteExecutionVerified: true, requiredStages: [{ name: 'atomic_exit', status: 'executed' }], finalAssetAmountRaw: f.request.requestedRaw, status: 'simulated' })) }
  return { ...f.input, capacityAgreement, executionAgreement }
}
describe('original compact-panel current reader and server issuer', () => {
  it.each([false, true])('reads32 genuine current roles only for changedStock=%s and independently binds fullS/Ea', async changed => {
    const f = await fixture(changed), value = await complete(readMorphoV2IdleNativePanelHolder(f.input))
    expect(value).not.toBeNull(); expect(value!.supplementalStarts).toBe(32); expect(value!.sdkPhysicalStarts).toBeNull()
    expect(f.starts).toHaveLength(32); expect(f.starts.every(s => s.key.startsWith('current:'))).toBe(true)
    for (const host of PANEL_TEST_HOSTS) { const calls = f.starts.filter(s => s.host === host); for (let i = 1; i < calls.length; i++) expect(calls[i].at - calls[i - 1].at).toBeGreaterThanOrEqual(250) }
    const expected = { profile: f.profile, panel: f.panel, request: f.request, capacityAgreement: f.capacity, asOfMs: Date.now() }
    expect(selectedMorphoV2IdleNativePanelRead(value, expected)).toBe(value)
    expect(selectedMorphoV2IdleNativePanelRead(structuredClone(value), expected)).toBeNull()
    const issueInput = { ...f.input, nativeRead: value!, horizonHours: 4 }, issue = issueMorphoV2IdlePanelHolderForecast(issueInput)!
    expect(issue).not.toBeNull(); expect(issue.issuedAtMs).toBeGreaterThanOrEqual(value!.completedAtMs)
    const approved = approveMorphoV2IdlePanelHolderForecastEvidence(issue.evidenceText, { ...f.expectation, asOfMs: issue.issuedAtMs })!
    expect(approved.entitlementBasis).toBe(changed ? 'conditional_quote_rate_interval' : 'native_same_stock')
    expect(approved.currentFullEaRaw).toBe(f.expectation.fullEaRaw)
    expect(selectedMorphoV2IdleServerPanelHolderForecastIssue(issue, issueInput, Date.now())).toBe(issue)
    expect(selectedMorphoV2IdleServerPanelHolderForecastIssue(structuredClone(issue), issueInput, Date.now())).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('qualifies an outlook when requestedQ exceeds actual full entitlement and no execution success exists', async () => {
    const f = await fixture(false, '100000000000000'), value = await complete(readMorphoV2IdleNativePanelHolder(f.input))
    expect(value).not.toBeNull(); expect(f.capacity.quote.successfulRequestedRawLowerBound).toBeNull()
    expect(issueMorphoV2IdlePanelHolderForecast({ ...f.input, nativeRead: value!, horizonHours: 24 })).not.toBeNull()
  })
  it.each(['forged panel', 'generic shares', 'generic Ea', 'request Q', 'unapproved origin'])('rejects %s before any supplemental start', async kind => {
    const f = await fixture(), input = { ...f.input }
    if (kind === 'forged panel') input.panel = structuredClone(f.panel)
    if (kind === 'request Q') input.request = { ...f.request, requestedRaw: '1' }
    if (kind === 'unapproved origin') input.origins = [{ ...f.input.origins[0] }, f.input.origins[1]]
    if (kind === 'generic shares' || kind === 'generic Ea') {
      input.capacityAgreement = structuredClone(f.capacity)
      if (kind === 'generic shares') input.capacityAgreement.quote.sourceHolderPosition!.sharesRaw = '1'
      else input.capacityAgreement.quote.entitlementRaw = '1'
    }
    expect(await complete(readMorphoV2IdleNativePanelHolder(input))).toBeNull(); expect(f.starts).toHaveLength(0)
  })
  it.each(['owner code', 'native shares', 'impossible supply', 'native Ea', 'runtime', 'configuration', 'canonical after'])('rejects paired %s disagreement or mismatch and settles timers', async kind => {
    const f = await fixture()
    f.mutate((key, _host, value) => key === 'current:' + ({ 'owner code': 'owner_code', 'native shares': 'actual_owner_shares', 'impossible supply': 'total_supply', 'native Ea': 'fixed_stock_preview', runtime: 'vault_code', configuration: 'liquidity_adapter', 'canonical after': 'header_after' }[kind]) ? kind === 'canonical after' ? { ...(value as object), hash: '0x' + 'a'.repeat(64) } : kind === 'owner code' || kind === 'runtime' ? '0x01' : panelTestAbi('1') : value)
    expect(await complete(readMorphoV2IdleNativePanelHolder(f.input))).toBeNull(); expect(vi.getTimerCount()).toBe(0)
  })
  it('keeps successfulQ execution validation distinct from forecast qualification', async () => {
    const f = await fixture(), input = successfulQ(f), { executionAgreement: _removed, ...withoutExecution } = input
    expect(await complete(readMorphoV2IdleNativePanelHolder(withoutExecution))).toBeNull(); expect(f.starts).toHaveLength(0)
    const value = await complete(readMorphoV2IdleNativePanelHolder(input))
    expect(value).not.toBeNull()
    expect(issueMorphoV2IdlePanelHolderForecast({ ...input, nativeRead: value!, horizonHours: 4 })).not.toBeNull()
  })
  it('denies changed horizon, request, clone, backwards and expired server issue selections', async () => {
    const f = await fixture(), value = await complete(readMorphoV2IdleNativePanelHolder(f.input)), input = { ...f.input, nativeRead: value!, horizonHours: 4 }, issue = issueMorphoV2IdlePanelHolderForecast(input)!
    expect(selectedMorphoV2IdleServerPanelHolderForecastIssue(issue, { ...input, horizonHours: 24 }, Date.now())).toBeNull()
    expect(selectedMorphoV2IdleServerPanelHolderForecastIssue(issue, { ...input, request: { ...input.request, requestedRaw: '1' } }, Date.now())).toBeNull()
    expect(selectedMorphoV2IdleServerPanelHolderForecastIssue(issue, input, issue.issuedAtMs - 1)).toBeNull()
    expect(selectedMorphoV2IdleServerPanelHolderForecastIssue(issue, input, PANEL_TEST_SOURCE_MS + 1800001)).toBeNull()
    expect(issueMorphoV2IdlePanelHolderForecast({ ...input, nativeRead: structuredClone(value!) })).toBeNull()
  })
  it('rechecks source freshness after snapshot work before minting an issue', async () => {
    const f = await fixture(), value = await complete(readMorphoV2IdleNativePanelHolder(f.input)), real = Date.now
    let reads = 0
    vi.spyOn(Date, 'now').mockImplementation(() => ++reads === 1 ? real() : PANEL_TEST_SOURCE_MS + 1800001)
    expect(issueMorphoV2IdlePanelHolderForecast({ ...f.input, nativeRead: value!, horizonHours: 4 })).toBeNull()
  })
})
