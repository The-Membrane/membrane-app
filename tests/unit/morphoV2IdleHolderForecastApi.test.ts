import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { withMorphoV2IdleHolderForecastEvidence } from '@/pages/api/carry/holder-exit-assessment'
import { loadMorphoV2IdleHistory } from '@/lib/carry/morphoV2IdleHistory.server'
import { resolveMorphoV2IdleTrustedProfile } from '@/lib/carry/morphoV2IdleTrustedProfiles'
import { agreeHolderExitCapacityQuotes, type HolderExitCapacityQuote } from '@/lib/carry/holderExitCapacity'
import type { HolderExitAssessmentRequest } from '@/lib/carry/holderExitAssessment'
import type { MorphoV2IdleNativeHistory, MorphoV2IdleNativeTrace } from '@/lib/carry/morphoV2IdleNativeEvidence'
import * as issuer from '@/lib/carry/morphoV2IdleHolderForecastIssuer.server'

const mocks = vi.hoisted(() => ({ load: vi.fn() }))
vi.mock('@/lib/carry/morphoV2IdleHistory.server', async (original) => {
  const actual = await original<typeof import('@/lib/carry/morphoV2IdleHistory.server')>()
  return { ...actual, loadMorphoV2IdleHistory: mocks.load.mockImplementation(actual.loadMorphoV2IdleHistory) }
})
// This suite tests the preserved v1 fallback independently of the compact panel.
vi.mock('@/lib/carry/morphoV2IdleCompactPanel.server', async (original) => {
  const actual = await original<typeof import('@/lib/carry/morphoV2IdleCompactPanel.server')>()
  return { ...actual, loadMorphoV2IdleCompactPanel: vi.fn().mockResolvedValue(null) }
})
// Disable the existing allocated-family startup replay. This suite exercises the separate idle path.
vi.mock('@/lib/carry/morphoV2CurrentProtocolCapacityEvidence', () => ({
  prewarmMorphoV2ProtocolHistory: vi.fn().mockResolvedValue(true),
  readMorphoV2CurrentProtocolOrigin: vi.fn().mockResolvedValue(null),
}))

const HOSTS = ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'] as const
const profile = resolveMorphoV2IdleTrustedProfile('PYUSD → VaultV2 [PYUSD]',
  '0xb576765fb15505433af24fee2c0325895c559fb2', '0x6c3ea9036406852006290770bedfcaba0e23a0e8')!
const NOW = Date.parse('2026-10-10T05:35:47.000Z')
let history: MorphoV2IdleNativeHistory, native: MorphoV2IdleNativeTrace[]
beforeAll(async () => {
  history = await loadMorphoV2IdleHistory(profile)
  const directory = join(process.cwd(), profile.history.nativeDirectory)
  native = []
  for (const name of (await readdir(directory)).filter(name => /^native-row-/.test(name)).sort()) {
    const row = JSON.parse(await readFile(join(directory, name), 'utf8')).row
    if (!row.request.key.startsWith('current:') && !row.request.key.startsWith('anchor_')) continue
    native.push({ host: row.observation.host, key: row.request.key, physicalId: row.physicalId,
      request: row.observation.request, envelope: JSON.parse(Buffer.from(row.observation.rawBodyBase64, 'base64').toString('utf8')) })
  }
})
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
  vi.setSystemTime(NOW)
  mocks.load.mockReset().mockResolvedValue(history)
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

/** Generic capacity is independently agreed; history, native reader and issuer keep their real private brands.
 * Only native fetch is replayed from the retained capture; no approved-flag doubles are used. */
function fixture(sharesRaw = history.captureSharesRaw) {
  const captured = history.capturedCurrent.observation, oldSource = captured.historicalPoint.source
  const source: HolderExitCapacityQuote['source'] = { ...oldSource, blockNumber: Number(oldSource.blockNumber) }
  const input: HolderExitAssessmentRequest = { routeKey: profile.identity.routeKey,
    destinationAddress: profile.identity.destination, owner: profile.history.captureOwner,
    assetsRaw: '1000000', horizonHours: 4 }
  const fullEaRaw = sharesRaw === history.captureSharesRaw ? captured.historicalPoint.fixedCurrentStockConversion.assetsRaw : '714001'
  const quote: HolderExitCapacityQuote = { status: 'holder_capacity_quote', scope: 'existing_holder_position',
    routeKey: input.routeKey, destination: input.destinationAddress, owner: input.owner,
    requestedRaw: input.assetsRaw, asset: profile.identity.asset, assetDecimals: 6, source,
    entitlementRaw: fullEaRaw, quotedMaxWithdrawRaw: '0', quotedMaxWithdrawStatus: 'quoted', effectiveLimitRaw: null, withdrawalsPaused: null,
    sourceHolderPosition: { sharesRaw, shareDecimals: 18, method: 'balance_of_owner_at_source' },
    entitlementMethod: 'preview_redeem_full_position', quotedLimitMethod: 'max_withdraw_owner', effectiveLimitMethod: 'unavailable',
    successfulRequestedRawLowerBound: null, aggregateAccessibleLiquidityRaw: null, hypotheticalDepositCapacityRaw: null,
    holderExecutableExit: false, futureCapacityValidated: false, forecastValidated: false, prospectiveValidated: false, minedPayoutObserved: false }
  const capacityAgreement = agreeHolderExitCapacityQuotes({ host: HOSTS[0], quote }, { host: HOSTS[1], quote: structuredClone(quote) }, NOW)!
  const clients = [{}, {}], selectedUrls = new WeakMap<object, string>()
  const witnesses = HOSTS.map((host, i) => {
    selectedUrls.set(clients[i], 'https://' + host + '/private-api-unit-key')
    return { host, client: clients[i], assessment: { capacityQuote: structuredClone(capacityAgreement.origins[i].quote) } }
  })
  const context = { witnesses, selectedUrls } as unknown as NonNullable<Parameters<typeof withMorphoV2IdleHolderForecastEvidence>[2]>
  const starts: { host: string; method: string }[] = [], occurrences = new Map<string, number>()
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const host = new URL(String(url)).hostname, sent = JSON.parse(init!.body as string)
    starts.push({ host, method: sent.method })
    const candidates = native.filter(trace => trace.host === host && trace.request.method === sent.method)
    const exact = candidates.filter(trace => JSON.stringify(trace.request.params) === JSON.stringify(sent.params))
    const callKey = host + JSON.stringify([sent.method, sent.params]), occurrence = occurrences.get(callKey) ?? 0
    occurrences.set(callKey, occurrence + 1)
    let trace = exact[occurrence % exact.length]
    if (!trace && sent.method === 'eth_call' && sent.params[0].data.startsWith('0x4cdad506'))
      trace = candidates.find(item => item.key.endsWith(':fixed_stock_preview') && item.request.params[1] &&
        (item.request.params[1] as { blockHash: string }).blockHash === sent.params[1].blockHash)
    expect(trace).toBeDefined()
    let result = structuredClone(trace!.envelope.result)
    if (trace!.key === 'current:actual_owner_shares') result = '0x' + BigInt(sharesRaw).toString(16).padStart(64, '0')
    if (trace!.key === 'current:fixed_stock_preview') result = '0x' + BigInt(fullEaRaw).toString(16).padStart(64, '0')
    if (sharesRaw !== history.captureSharesRaw && trace!.key.startsWith('anchor_') && trace!.key.endsWith(':fixed_stock_preview'))
      result = '0x' + (BigInt(result as string) + 1n).toString(16).padStart(64, '0')
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: sent.id, result }), { headers: { 'content-type': 'application/json' } })
  })
  return { input, source, capacityAgreement, context, clients, starts }
}
function successfulQ(f: ReturnType<typeof fixture>) {
  f.input.assetsRaw = '500000'
  const quote = structuredClone(f.capacityAgreement.quote)
  quote.requestedRaw = f.input.assetsRaw; quote.successfulRequestedRawLowerBound = f.input.assetsRaw
  const capacityAgreement = agreeHolderExitCapacityQuotes({ host: HOSTS[0], quote }, { host: HOSTS[1], quote: structuredClone(quote) }, Date.now())!
  f.context.witnesses.forEach((witness, i) => { witness.assessment.capacityQuote = structuredClone(capacityAgreement.origins[i].quote) })
  const question = { routeKey: f.input.routeKey, destinationAddress: f.input.destinationAddress, owner: f.input.owner,
    assetsRaw: f.input.assetsRaw, finalAssetAddress: quote.asset, finalAssetDecimals: quote.assetDecimals }
  const executionAgreement = { question, routeAndContractIdentityVerified: true, inputAndFinalAssetAddressesVerified: true,
    simulations: HOSTS.map(originHost => ({ question, originHost, source: f.source, kind: 'full_route_execution', execution: 'single_call',
      fullRouteExecutionVerified: true, requiredStages: [{ name: 'atomic_exit', status: 'executed' }],
      finalAssetAmountRaw: f.input.assetsRaw, status: 'simulated' })) }
  return { ...f, capacityAgreement, executionAgreement }
}
async function complete<T>(promise: Promise<T>): Promise<T> {
  let done = false, value: T | undefined, error: unknown
  promise.then(result => { value = result; done = true }, reason => { error = reason; done = true })
  for (let i = 0; i < 2600 && !done; i++) await vi.advanceTimersByTimeAsync(25)
  expect(done).toBe(true)
  if (error) throw error
  return value as T
}

describe('separate idle API optional evidence with retained native fixture replay', () => {
  it('adds the bounded native string and final clock to a canonical503 capacity response without changing its error', async () => {
    const f = fixture(), response = { error: 'holder_exit_assessment_unavailable', capacityAgreement: f.capacityAgreement }
    const result = await complete(withMorphoV2IdleHolderForecastEvidence(f.input, response, f.context))
    expect(result.error).toBe(response.error); expect(result.capacityAgreement).toBe(response.capacityAgreement)
    expect(f.starts).toHaveLength(32); expect(mocks.load).toHaveBeenCalledOnce()
    expect(typeof result.morphoV2IdleHolderForecastEvidence).toBe('string')
    const wire = JSON.parse(result.morphoV2IdleHolderForecastEvidence!)
    expect(wire.current.probeSharesRaw).toBe(history.captureSharesRaw)
    expect(Date.parse(result.morphoV2IdleJointIssuedAtUtc!)).toBeGreaterThanOrEqual(Date.parse(wire.current.readAtUtc))
    expect(JSON.stringify(result)).not.toContain('private-api-unit-key')
    expect(result).not.toHaveProperty('morphoV2CurrentProtocolCapacityEvidence')
  })
  it('keeps the independent successful-Q execution gate for a200 response', async () => {
    const f = successfulQ(fixture()), response = { capacityAgreement: f.capacityAgreement, executionAgreement: f.executionAgreement }
    const result = await complete(withMorphoV2IdleHolderForecastEvidence(f.input, response, f.context))
    expect(f.starts).toHaveLength(32); expect(result.morphoV2IdleHolderForecastEvidence).toBeDefined()
    expect(result.executionAgreement).toBe(response.executionAgreement)
  })
  it('denies successful-Q metadata without its independent execution agreement before optional work', async () => {
    const f = successfulQ(fixture()), response = { capacityAgreement: f.capacityAgreement }
    expect(await withMorphoV2IdleHolderForecastEvidence(f.input, response, f.context)).toBe(response)
    expect(f.starts).toHaveLength(0); expect(mocks.load).not.toHaveBeenCalled()
  })
  it.each(HOSTS)('retains canonical503 idle evidence with only %s carrying a raw successful-Q bound', async (boundHost) => {
    const f = fixture()
    f.input.assetsRaw = '500000'
    const quote = structuredClone(f.capacityAgreement.quote)
    quote.requestedRaw = f.input.assetsRaw
    const rawOrigins = HOSTS.map(host => ({ host, quote: { ...structuredClone(quote),
      successfulRequestedRawLowerBound: host === boundHost ? f.input.assetsRaw : null } }))
    const capacityAgreement = agreeHolderExitCapacityQuotes(rawOrigins[0], rawOrigins[1], Date.now())!
    expect(capacityAgreement).not.toBeNull()
    expect(capacityAgreement.quote.successfulRequestedRawLowerBound).toBeNull()
    expect(capacityAgreement.origins.map(origin => origin.quote.successfulRequestedRawLowerBound))
      .toEqual(HOSTS.map(host => host === boundHost ? f.input.assetsRaw : null))
    f.context.witnesses.forEach((witness, i) => {
      witness.assessment.capacityQuote = structuredClone(capacityAgreement.origins[i].quote)
    })
    const response = { error: 'holder_exit_assessment_unavailable', capacityAgreement }
    const result = await complete(withMorphoV2IdleHolderForecastEvidence(f.input, response, f.context))
    expect(result.error).toBe(response.error)
    expect(result.capacityAgreement).toBe(capacityAgreement)
    expect(result).not.toHaveProperty('executionAgreement')
    expect(f.starts).toHaveLength(32)
    expect(typeof result.morphoV2IdleHolderForecastEvidence).toBe('string')
    const wire = JSON.parse(result.morphoV2IdleHolderForecastEvidence!)
    expect(wire.current.probeSharesRaw).toBe(history.captureSharesRaw)
    expect(wire.current.source).toMatchObject({ blockHash: f.source.blockHash, blockTime: f.source.blockTime })
    expect(wire.historicalPreviewSupplement).toBeNull()
  })
  it('acquires all12 extra anchor traces for new S and stamps the issue after their completion', async () => {
    const f = fixture((BigInt(history.captureSharesRaw) + 1n).toString()), response = { capacityAgreement: f.capacityAgreement }
    const result = await complete(withMorphoV2IdleHolderForecastEvidence(f.input, response, f.context))
    expect(f.starts).toHaveLength(44)
    const wire = JSON.parse(result.morphoV2IdleHolderForecastEvidence!)
    expect(wire.historicalPreviewSupplement.sharesRaw).toBe(f.capacityAgreement.quote.sourceHolderPosition!.sharesRaw)
    expect(wire.historicalPreviewSupplement.traces).toHaveLength(12)
    expect(Date.parse(result.morphoV2IdleJointIssuedAtUtc!)).toBeGreaterThanOrEqual(Date.parse(wire.historicalPreviewSupplement.readAtUtc))
  })
  it.each(['request Q', 'destination', 'horizon', 'missing URL', 'URL host', 'witness quote', 'missing witness'])
    ('declines %s before optional history or native dispatch', async (kind) => {
      const f = fixture(), response = { capacityAgreement: f.capacityAgreement }
      if (kind === 'request Q') f.input.assetsRaw = '1'
      if (kind === 'destination') f.input.destinationAddress = '0x' + '1'.repeat(40)
      if (kind === 'horizon') f.input.horizonHours = 169
      if (kind === 'missing URL') f.context.selectedUrls.delete(f.clients[1])
      if (kind === 'URL host') f.context.selectedUrls.set(f.clients[1], 'https://' + HOSTS[0] + '/private-api-unit-key')
      if (kind === 'witness quote') f.context.witnesses[1].assessment.capacityQuote!.entitlementRaw = '1'
      if (kind === 'missing witness') f.context.witnesses = f.context.witnesses.slice(0, 1)
      expect(await withMorphoV2IdleHolderForecastEvidence(f.input, response, f.context)).toBe(response)
      expect(f.starts).toHaveLength(0); expect(mocks.load).not.toHaveBeenCalled()
    })
  it('preserves the original response when the explicit history replay fails', async () => {
    const f = fixture(), response = { capacityAgreement: f.capacityAgreement }
    mocks.load.mockRejectedValueOnce(new Error('fixture_history_unavailable'))
    expect(await withMorphoV2IdleHolderForecastEvidence(f.input, response, f.context)).toBe(response)
    expect(f.starts).toHaveLength(0)
  })
  it('preserves the canonical503 response when optional native fetch fails without retrying', async () => {
    const f = fixture(), response = { error: 'holder_exit_assessment_unavailable', capacityAgreement: f.capacityAgreement }
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error('fixture_native_unavailable'))
    expect(await complete(withMorphoV2IdleHolderForecastEvidence(f.input, response, f.context))).toBe(response)
    expect(globalThis.fetch).toHaveBeenCalledOnce()
  })
  it('declines an original issued transport if source freshness expires before the final response clock', async () => {
    const f = fixture(), response = { capacityAgreement: f.capacityAgreement }, issue = issuer.issueMorphoV2IdleHolderForecast
    vi.spyOn(issuer, 'issueMorphoV2IdleHolderForecast').mockImplementation(input => {
      const original = issue(input)
      expect(original).not.toBeNull()
      vi.setSystemTime(Date.parse(f.source.blockTime) + 1_800_001)
      return original
    })
    expect(await complete(withMorphoV2IdleHolderForecastEvidence(f.input, response, f.context))).toBe(response)
    expect(f.starts).toHaveLength(32)
  })
})
