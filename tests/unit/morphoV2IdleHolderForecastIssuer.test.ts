import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { loadMorphoV2IdleHistory } from '../../lib/carry/morphoV2IdleHistory.server'
import { resolveMorphoV2IdleTrustedProfile } from '../../lib/carry/morphoV2IdleTrustedProfiles'
import { agreeHolderExitCapacityQuotes, type HolderExitCapacityQuote } from '../../lib/carry/holderExitCapacity'
import { type MorphoV2IdleNativeHistory, type MorphoV2IdleNativeTrace } from '../../lib/carry/morphoV2IdleNativeEvidence'
import {
  createMorphoV2IdleNativeOrigin, readMorphoV2IdleNativeHolder, selectedMorphoV2IdleNativeRead,
  type MorphoV2IdleHolderRequest, type MorphoV2IdleBoundedOrigin,
} from '../../lib/carry/morphoV2IdleNativeReader.server'

const profile = resolveMorphoV2IdleTrustedProfile('PYUSD → VaultV2 [PYUSD]', '0xb576765fb15505433af24fee2c0325895c559fb2', '0x6c3ea9036406852006290770bedfcaba0e23a0e8')!
const HOSTS = ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'] as const
let history: MorphoV2IdleNativeHistory, native: MorphoV2IdleNativeTrace[]
const NOW = Date.parse('2026-10-10T05:35:47.000Z')
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
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] }); vi.setSystemTime(NOW) })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
function fixture(sharesRaw = history.captureSharesRaw) {
  const captured = history.capturedCurrent.observation, oldSource = captured.historicalPoint.source
  const source: HolderExitCapacityQuote['source'] = { ...oldSource, blockNumber: Number(oldSource.blockNumber) }
  const request: MorphoV2IdleHolderRequest = { routeKey: profile.identity.routeKey, destination: profile.identity.destination,
    owner: profile.history.captureOwner, requestedRaw: '1000000', asset: profile.identity.asset, assetDecimals: 6, source }
  const fullEaRaw = sharesRaw === history.captureSharesRaw ? captured.historicalPoint.fixedCurrentStockConversion.assetsRaw : '714001'
  const quote: HolderExitCapacityQuote = { status: 'holder_capacity_quote', scope: 'existing_holder_position', ...request,
    entitlementRaw: fullEaRaw, quotedMaxWithdrawRaw: '0', quotedMaxWithdrawStatus: 'quoted', effectiveLimitRaw: null, withdrawalsPaused: null,
    sourceHolderPosition: { sharesRaw, shareDecimals: 18, method: 'balance_of_owner_at_source' },
    entitlementMethod: 'preview_redeem_full_position', quotedLimitMethod: 'max_withdraw_owner', effectiveLimitMethod: 'unavailable',
    successfulRequestedRawLowerBound: null, aggregateAccessibleLiquidityRaw: null, hypotheticalDepositCapacityRaw: null,
    holderExecutableExit: false, futureCapacityValidated: false, forecastValidated: false, prospectiveValidated: false, minedPayoutObserved: false }
  const capacityAgreement = agreeHolderExitCapacityQuotes({ host: HOSTS[0], quote }, { host: HOSTS[1], quote: structuredClone(quote) }, NOW)!
  const starts: { host: string; method: string; params: unknown[]; at: number }[] = []
  const occurrences = new Map<string, number>()
  let delayMs = 0
  let mutation: (key: string, host: string, result: unknown) => unknown = (_key, _host, result) => result
  const origins = HOSTS.map(host => createMorphoV2IdleNativeOrigin('https://' + host + '/private-test-key', (async (_url, init) => {
    const sent = JSON.parse(init!.body as string), at = performance.now()
    starts.push({ host, method: sent.method, params: sent.params, at })
    const candidates = native.filter(trace => trace.host === host && trace.request.method === sent.method)
    const exact = candidates.filter(item => JSON.stringify(item.request.params) === JSON.stringify(sent.params)), callKey = host + JSON.stringify([sent.method, sent.params])
    const occurrence = occurrences.get(callKey) ?? 0; occurrences.set(callKey, occurrence + 1)
    let trace = exact[occurrence % exact.length]
    if (!trace && sent.method === 'eth_call' && sent.params[0].data.startsWith('0x4cdad506')) {
      trace = candidates.find(item => item.key.endsWith(':fixed_stock_preview') && item.request.params[1] &&
        (item.request.params[1] as { blockHash: string }).blockHash === sent.params[1].blockHash)
    }
    expect(trace).toBeDefined()
    if (delayMs > 0) await abortableDelay(delayMs, init!.signal!)
    let result = structuredClone(trace!.envelope.result)
    if (trace!.key === 'current:actual_owner_shares') result = '0x' + BigInt(sharesRaw).toString(16).padStart(64, '0')
    if (trace!.key === 'current:fixed_stock_preview') result = '0x' + BigInt(fullEaRaw).toString(16).padStart(64, '0')
    if (sharesRaw !== history.captureSharesRaw && trace!.key.startsWith('anchor_') && trace!.key.endsWith(':fixed_stock_preview')) {
      result = '0x' + (BigInt(result as string) + 1n).toString(16).padStart(64, '0')
    }
    result = mutation(trace!.key, host, result)
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: sent.id, result }), { headers: { 'content-type': 'application/json' } })
  }) as typeof fetch)) as [MorphoV2IdleBoundedOrigin, MorphoV2IdleBoundedOrigin]
  return { profile, history, request, capacityAgreement, origins, starts,
    mutate(fn: typeof mutation) { mutation = fn }, delay(ms: number) { delayMs = ms } }
}
function abortableDelay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const fail = () => { clearTimeout(timer); reject(new Error('aborted')) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', fail); resolve() }, ms)
    signal.addEventListener('abort', fail, { once: true })
    if (signal.aborted) fail()
  })
}
function successfulQ(f: ReturnType<typeof fixture>) {
  const quote = structuredClone(f.capacityAgreement.quote); quote.successfulRequestedRawLowerBound = f.request.requestedRaw
  const capacityAgreement = agreeHolderExitCapacityQuotes({ host: HOSTS[0], quote }, { host: HOSTS[1], quote: structuredClone(quote) }, Date.now())!
  const question = { routeKey: f.request.routeKey, destinationAddress: f.request.destination, owner: f.request.owner,
    assetsRaw: f.request.requestedRaw, finalAssetAddress: f.request.asset, finalAssetDecimals: f.request.assetDecimals }
  const executionAgreement = { question, routeAndContractIdentityVerified: true, inputAndFinalAssetAddressesVerified: true,
    simulations: HOSTS.map(originHost => ({ question, originHost, source: f.request.source, kind: 'full_route_execution', execution: 'single_call',
      fullRouteExecutionVerified: true, requiredStages: [{ name: 'atomic_exit', status: 'executed' }],
      finalAssetAmountRaw: f.request.requestedRaw, status: 'simulated' })) }
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

import { createHash } from 'node:crypto'
import { approveMorphoV2IdleHolderForecastEvidence } from '../../lib/carry/morphoV2IdleHolderForecastEvidence'
import {
  issueMorphoV2IdleHolderForecast, morphoV2IdlePinnedHistoricalCapsule, selectedMorphoV2IdleServerHolderForecastIssue,
} from '../../lib/carry/morphoV2IdleHolderForecastIssuer.server'

describe('server original idle forecast issuance', () => {
  it('regenerates exact pinned capsule only from original profile and full byte-replayed history', () => {
    const text = morphoV2IdlePinnedHistoricalCapsule(profile, history)!
    expect(Buffer.byteLength(text)).toBe(3926)
    expect(createHash('sha256').update(text).digest('hex')).toBe('880b5424feaf11b8301bdbd560fde261999a31696acac7dccb039fbccc5ddfc6')
    expect(morphoV2IdlePinnedHistoricalCapsule(profile, structuredClone(history))).toBeNull()
    expect(morphoV2IdlePinnedHistoricalCapsule(structuredClone(profile), history)).toBeNull()
  })
  it.each([false, true])('issues bounded browser-replayable transport after current work, changedS=%s', async changed => {
    const sharesRaw = changed ? (BigInt(history.captureSharesRaw) + 1n).toString() : history.captureSharesRaw
    const f = fixture(sharesRaw), nativeRead = (await complete(readMorphoV2IdleNativeHolder(f)))!
    const input = { ...f, nativeRead, horizonHours: 1 }, issue = issueMorphoV2IdleHolderForecast(input)
    expect(issue).not.toBeNull(); expect(issue!.issuedAtMs).toBeGreaterThanOrEqual(nativeRead.completedAtMs)
    expect(Buffer.byteLength(issue!.evidenceText)).toBeLessThanOrEqual(256 * 1024)
    expect(JSON.stringify(issue)).not.toContain('private-test-key')
    const wire = JSON.parse(issue!.evidenceText)
    const approved = approveMorphoV2IdleHolderForecastEvidence(wire, { profile, owner: f.request.owner, source: nativeRead.current.source,
      sharesRaw, fullEaRaw: f.capacityAgreement.quote.entitlementRaw!, asOfMs: issue!.issuedAtMs })
    expect(approved).not.toBeNull()
    expect(approved!.currentIdleCashRaw).toBe('39678091697943')
    expect(approved!.historicalOwnedEntitlementAssetRaw).toBeNull(); expect(approved!.competingMRaw).toBeNull()
    expect(selectedMorphoV2IdleServerHolderForecastIssue(issue, input, Date.now())).toBe(issue)
    expect(selectedMorphoV2IdleServerHolderForecastIssue(structuredClone(issue), input, Date.now())).toBeNull()
    for (const [key, value] of Object.entries(issue!.claims)) if (!['researchOnly', 'competingMRaw', 'MRaw'].includes(key)) expect(value).toBe(false)
  })
  it('rejects original-read clones, decoded/captured points and approval flags', async () => {
    const f = fixture(), nativeRead = (await complete(readMorphoV2IdleNativeHolder(f)))!
    for (const candidate of [structuredClone(nativeRead), history.capturedCurrent, { approved: true, originalAuthority: true }]) {
      expect(issueMorphoV2IdleHolderForecast({ ...f, nativeRead: candidate as typeof nativeRead, horizonHours: 1 })).toBeNull()
    }
  })
  it('binds original profile/history, owner, full stock, source, Q, horizon and original quote', async () => {
    const f = fixture(), nativeRead = (await complete(readMorphoV2IdleNativeHolder(f)))!
    const input = { ...f, nativeRead, horizonHours: 24 }, issue = issueMorphoV2IdleHolderForecast(input)!
    expect(issue).not.toBeNull()
    expect(issueMorphoV2IdleHolderForecast({ ...input, history: structuredClone(history) })).toBeNull()
    expect(issueMorphoV2IdleHolderForecast({ ...input, profile: structuredClone(profile) })).toBeNull()
    for (const patch of [{ owner: '0x' + 'a'.repeat(40) }, { requestedRaw: '1' }, { assetDecimals: 18 }, { source: { ...f.request.source, blockHash: '0x' + 'a'.repeat(64) } }]) {
      const expected = { ...input, request: { ...f.request, ...patch } }
      expect(issueMorphoV2IdleHolderForecast(expected)).toBeNull()
      expect(selectedMorphoV2IdleServerHolderForecastIssue(issue, expected, Date.now())).toBeNull()
    }
    expect(issueMorphoV2IdleHolderForecast({ ...input, horizonHours: 169 })).toBeNull()
    expect(selectedMorphoV2IdleServerHolderForecastIssue(issue, { ...input, horizonHours: 48 }, Date.now())).toBeNull()
    const bad = structuredClone(f.capacityAgreement); bad.origins[1].quote.entitlementRaw = '1'
    expect(issueMorphoV2IdleHolderForecast({ ...input, capacityAgreement: bad })).toBeNull()
  })
  it('rejects expired source, backward clock and expired render independently of currentQ', async () => {
    const f = fixture(), nativeRead = (await complete(readMorphoV2IdleNativeHolder(f)))!
    const input = { ...f, nativeRead, horizonHours: 1 }, issue = issueMorphoV2IdleHolderForecast(input)!
    expect(issue).not.toBeNull()
    expect(selectedMorphoV2IdleServerHolderForecastIssue(issue, input, issue.issuedAtMs - 1)).toBeNull()
    vi.setSystemTime(Date.parse(f.request.source.blockTime) + 1800001)
    expect(issueMorphoV2IdleHolderForecast(input)).toBeNull()
    expect(selectedMorphoV2IdleServerHolderForecastIssue(issue, input)).toBeNull()
  })
  it('requires independent successfulQ evidence at server issuance and later selection', async () => {
    const f = successfulQ(fixture()), nativeRead = (await complete(readMorphoV2IdleNativeHolder(f)))!
    expect(nativeRead).not.toBeNull()
    const input = { ...f, nativeRead, horizonHours: 1 }
    expect(issueMorphoV2IdleHolderForecast({ ...input, executionAgreement: undefined })).toBeNull()
    const issue = issueMorphoV2IdleHolderForecast(input)!
    expect(issue).not.toBeNull()
    expect(selectedMorphoV2IdleServerHolderForecastIssue(issue, { ...input, executionAgreement: undefined })).toBeNull()
    expect(selectedMorphoV2IdleServerHolderForecastIssue(issue, input)).toBe(issue)
  })

  it.each(['expired', 'backward'])('rejects %s clocks advanced during private snapshot preparation', async kind => {
    const f = fixture(), nativeRead = (await complete(readMorphoV2IdleNativeHolder(f)))!
    expect(nativeRead).not.toBeNull()
    const input = { ...f, nativeRead, horizonHours: 1 }, originalClone = globalThis.structuredClone
    let observed = false
    const cloning = vi.spyOn(globalThis, 'structuredClone').mockImplementation((value, options) => {
      const cloned = originalClone(value, options)
      if (value === f.request) {
        observed = true
        vi.setSystemTime(kind === 'expired' ? Date.parse(f.request.source.blockTime) + 1800001 : nativeRead.completedAtMs - 1)
      }
      return cloned
    })
    const result = issueMorphoV2IdleHolderForecast(input)
    cloning.mockRestore()
    expect(observed).toBe(true); expect(result).toBeNull()
  })
  it.each(['backward', 'forward'])('samples a monotonic %s issue clock above native completion', async kind => {
    const f = fixture(), nativeRead = (await complete(readMorphoV2IdleNativeHolder(f)))!
    expect(nativeRead).not.toBeNull()
    const input = { ...f, nativeRead, horizonHours: 1 }, originalClone = globalThis.structuredClone
    const selectionAtMs = nativeRead.completedAtMs + 1000
    const preparedAtMs = nativeRead.completedAtMs + (kind === 'backward' ? 500 : 1500)
    vi.setSystemTime(selectionAtMs)
    let observed = false
    const cloning = vi.spyOn(globalThis, 'structuredClone').mockImplementation((value, options) => {
      const cloned = originalClone(value, options)
      if (value === f.request) { observed = true; vi.setSystemTime(preparedAtMs) }
      return cloned
    })
    const result = issueMorphoV2IdleHolderForecast(input)
    cloning.mockRestore()
    expect(observed).toBe(true); expect(preparedAtMs).toBeGreaterThan(nativeRead.completedAtMs)
    if (kind === 'backward') expect(result).toBeNull()
    else {
      expect(result).not.toBeNull(); expect(result!.issuedAtMs).toBe(preparedAtMs)
      expect(selectedMorphoV2IdleServerHolderForecastIssue(result, input, preparedAtMs)).toBe(result)
    }
  })
  it('captures the issue clock after all private snapshot preparation', async () => {
    const f = fixture(), nativeRead = (await complete(readMorphoV2IdleNativeHolder(f)))!
    const input = { ...f, nativeRead, horizonHours: 1 }, originalClone = globalThis.structuredClone
    const preparedAtMs = Date.now() + 2000
    const cloning = vi.spyOn(globalThis, 'structuredClone').mockImplementation((value, options) => {
      const cloned = originalClone(value, options)
      if (value === f.request) vi.setSystemTime(preparedAtMs)
      return cloned
    })
    const result = issueMorphoV2IdleHolderForecast(input)
    cloning.mockRestore()
    expect(result).not.toBeNull(); expect(result!.issuedAtMs).toBe(preparedAtMs)
    expect(selectedMorphoV2IdleServerHolderForecastIssue(result, input, preparedAtMs)).toBe(result)
  })
  it.each(['expired', 'backward'])('rejects %s clocks after result construction before private issuance', async kind => {
    const f = fixture(), nativeRead = (await complete(readMorphoV2IdleNativeHolder(f)))!
    const input = { ...f, nativeRead, horizonHours: 1 }, originalFreeze = Object.freeze
    let observed = false
    const freezing = vi.spyOn(Object, 'freeze').mockImplementation(value => {
      if (value && typeof value === 'object' && Object.hasOwn(value, 'evidenceText') && Object.hasOwn(value, 'issuedAtMs')) {
        observed = true
        vi.setSystemTime(kind === 'expired' ? Date.parse(f.request.source.blockTime) + 1800001 : (value as { issuedAtMs: number }).issuedAtMs - 1)
      }
      return originalFreeze(value)
    })
    const result = issueMorphoV2IdleHolderForecast(input)
    freezing.mockRestore()
    expect(observed).toBe(true); expect(result).toBeNull()
  })

})
