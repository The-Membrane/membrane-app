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

describe('fresh idle reader with original native fixtures', () => {
  it('replays all32 roles, separates idle cash from total assets and maxWithdraw, and denies clones', async () => {
    const f = fixture(), read = await complete(readMorphoV2IdleNativeHolder(f))
    expect(f.capacityAgreement).not.toBeNull(); expect(read).not.toBeNull()
    expect(read!.supplementalStarts).toBe(32); expect(read!.sdkPhysicalStarts).toBeNull()
    expect(read!.decodedCurrent.historicalPoint.idleCashRaw).toBe('39678091697943')
    expect(read!.decodedCurrent.totalAssetsRaw).toBe('409127963880079')
    expect(read!.historicalPreviewSupplement).toBeNull()
    expect(selectedMorphoV2IdleNativeRead(read, { ...f, asOfMs: Date.now() })).toBe(read)
    expect(selectedMorphoV2IdleNativeRead(structuredClone(read), { ...f, asOfMs: Date.now() })).toBeNull()
    expect(JSON.stringify(read)).not.toContain('private-test-key')
    for (const host of HOSTS) {
      const times = f.starts.filter(start => start.host === host).map(start => start.at)
      for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(250)
    }
  })
  it('rechecks early timer wakes before dispatching and settles every native call', async () => {
    const f = fixture(), starts: { host: string; at: number }[] = []
    let pendingCalls = 0, settledCalls = 0, earlyWakes = 0
    const schedule = globalThis.setTimeout
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback, delay, ...args) => {
      const requested = Number(delay ?? 0), early = requested > 1 && requested <= 250
      if (early) earlyWakes++
      return schedule(callback, early ? Math.max(1, Math.floor(requested) - 1) : delay, ...args)
    }) as typeof setTimeout)
    const origins = HOSTS.map(host => createMorphoV2IdleNativeOrigin('https://' + host + '/private-test-key', (async (_url, init) => {
      const sent = JSON.parse(init!.body as string)
      starts.push({ host, at: performance.now() }); pendingCalls++
      try {
        // Timer advancement also advances the performance clock used for physical spacing.
        await abortableDelay(1, init!.signal!)
        const trace = native.find(item => item.host === host && item.request.method === sent.method &&
          JSON.stringify(item.request.params) === JSON.stringify(sent.params))
        expect(trace).toBeDefined()
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: sent.id, result: trace!.envelope.result }))
      } finally { pendingCalls--; settledCalls++ }
    }) as typeof fetch)) as [MorphoV2IdleBoundedOrigin, MorphoV2IdleBoundedOrigin]
    const read = await complete(readMorphoV2IdleNativeHolder({ ...f, origins }))
    expect(earlyWakes).toBeGreaterThan(0); expect(read).not.toBeNull()
    expect(read!.supplementalStarts).toBe(32); expect(starts).toHaveLength(32)
    for (const host of HOSTS) {
      const times = starts.filter(start => start.host === host).map(start => start.at)
      expect(times).toHaveLength(16)
      for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(250)
    }
    expect(settledCalls).toBe(32); expect(pendingCalls).toBe(0); expect(vi.getTimerCount()).toBe(0)
  })
  it('revalues new fullS at both exact anchors using12 bracketed calls, retaining old ownership only as a diagnostic', async () => {
    const newS = (BigInt(history.captureSharesRaw) + 1n).toString(), f = fixture(newS)
    const read = await complete(readMorphoV2IdleNativeHolder(f))
    expect(read).not.toBeNull(); expect(read!.supplementalStarts).toBe(44)
    expect(read!.historicalPreviewSupplement!.traces).toHaveLength(12)
    expect(read!.historicalPoints.map(point => point.fixedCurrentStockConversion.probeSharesRaw)).toEqual([newS, newS])
    expect(read!.historicalPoints.map(point => point.historicalOwnerSharesRaw)).toEqual([history.captureSharesRaw, history.captureSharesRaw])
    expect(read!.historicalPoints.map(point => point.fixedCurrentStockConversion.assetsRaw)).toEqual(['713613', '713662'])
    const probes = read!.historicalPreviewSupplement!.traces.filter(trace => trace.key.endsWith(':fixed_stock_preview'))
    expect(probes.map(trace => (trace.request.params[0] as { data: string }).data)).toEqual(Array(4).fill('0x4cdad506' + BigInt(newS).toString(16).padStart(64, '0')))
    expect(new Set([...read!.current.traces, ...read!.historicalPreviewSupplement!.traces].map(trace => trace.physicalId)).size).toBe(44)
  })
  it.each(['chain', 'vault_code', 'asset_decimals', 'liquidity_adapter', 'liquidity_data', 'actual_owner_shares', 'fixed_stock_preview', 'idle_cash', 'header_before'])('rejects actual fixture tampering at%s without minting an original', async role => {
    const f = fixture()
    f.mutate((key, host, result) => {
      if (key !== 'current:' + role || host !== HOSTS[1]) return result
      if (role === 'header_before') return { ...(result as object), hash: '0x' + 'a'.repeat(64) }
      if (role === 'chain') return '0x2'
      if (role === 'liquidity_data') return '0x'
      if (role === 'vault_code') return '0x00'
      return '0x' + 'f'.repeat(64)
    })
    expect(await complete(readMorphoV2IdleNativeHolder(f))).toBeNull()
    expect(f.starts.length).toBeLessThanOrEqual(32)
  })
  it('denies source, Q and profile/history clones before any start', async () => {
    const f = fixture()
    expect(await readMorphoV2IdleNativeHolder({ ...f, history: structuredClone(history) })).toBeNull()
    expect(await readMorphoV2IdleNativeHolder({ ...f, profile: structuredClone(profile) })).toBeNull()
    expect(await readMorphoV2IdleNativeHolder({ ...f, request: { ...f.request, requestedRaw: '1' } })).toBeNull()
    expect(await readMorphoV2IdleNativeHolder({ ...f, request: { ...f.request, source: { ...f.request.source, blockHash: '0x' + 'b'.repeat(64) } } })).toBeNull()
    expect(f.starts).toHaveLength(0)
  })
  it('rejects stale or pre-availability current sources and accessor requests before dispatch', async () => {
    const f = fixture(); vi.setSystemTime(Date.parse(f.request.source.blockTime) + 1800001)
    expect(await readMorphoV2IdleNativeHolder(f)).toBeNull()
    vi.setSystemTime(Date.parse(history.provenance.verifiedReplayCompletedAtUtc) - 1)
    expect(await readMorphoV2IdleNativeHolder(f)).toBeNull()
    vi.setSystemTime(NOW)
    let accessed = 0
    const request = Object.defineProperty({ ...f.request }, 'owner', { enumerable: true, get() { accessed++; return f.request.owner } })
    expect(await readMorphoV2IdleNativeHolder({ ...f, request })).toBeNull()
    expect(accessed).toBe(0); expect(f.starts).toHaveLength(0)
  })
  it('does not turn a plain semantic capturedCurrent into a fresh reader instance', () => {
    const f = fixture()
    expect(selectedMorphoV2IdleNativeRead(history.capturedCurrent, { ...f, asOfMs: NOW })).toBeNull()
  })
  it('aborts a pending native fetch at8s and settles before returning with no next start', async () => {
    const f = fixture(); let calls = 0, aborted = false, settled = false
    const origin = createMorphoV2IdleNativeOrigin('https://' + HOSTS[0], (async (_url, init) => {
      calls++
      return await new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => {
        aborted = true; settled = true; reject(new Error('private provider secret'))
      }, { once: true }))
    }) as typeof fetch)
    expect(await complete(readMorphoV2IdleNativeHolder({ ...f, origins: [origin, f.origins[1]] }))).toBeNull()
    expect(calls).toBe(1); expect(aborted && settled).toBe(true); expect(f.starts).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('aborts pending body reads and cancels the original body before returning', async () => {
    const f = fixture(); let cancelled = false
    const origin = createMorphoV2IdleNativeOrigin('https://' + HOSTS[0], (async () => new Response(new ReadableStream({
      pull() { return new Promise<void>(() => {}) }, cancel() { cancelled = true },
    }))) as typeof fetch)
    expect(await complete(readMorphoV2IdleNativeHolder({ ...f, origins: [origin, f.origins[1]] }))).toBeNull()
    expect(cancelled).toBe(true); expect(vi.getTimerCount()).toBe(0)
  })
  it('rejects duplicate JSON keys, RPC errors and oversized bodies at the original parser', async () => {
    for (const body of ['{"jsonrpc":"2.0","id":1,"id":1,"result":"0x1"}', '{"jsonrpc":"2.0","id":1,"error":{"message":"private secret"}}', 'x'.repeat(65537)]) {
      const f = fixture(), origin = createMorphoV2IdleNativeOrigin('https://' + HOSTS[0], (async () => new Response(body)) as typeof fetch)
      expect(await complete(readMorphoV2IdleNativeHolder({ ...f, origins: [origin, f.origins[1]] }))).toBeNull()
      expect(f.starts).toHaveLength(0); expect(vi.getTimerCount()).toBe(0)
    }
  })
  it('validates HTTPS and approved hosts and denies unowned executors', async () => {
    for (const url of ['http://' + HOSTS[0], 'https://unknown.example', 'https://user:password@' + HOSTS[0], 'https://' + HOSTS[0] + '#secret']) {
      expect(() => createMorphoV2IdleNativeOrigin(url)).toThrow()
    }
    const f = fixture(), unowned = { ...f.origins[0] }
    expect(await readMorphoV2IdleNativeHolder({ ...f, origins: [unowned, f.origins[1]] })).toBeNull()
    expect(f.starts).toHaveLength(0)
  })
  it('rechecks source TTL and privately bound Q at later selection', async () => {
    const f = fixture(), read = await complete(readMorphoV2IdleNativeHolder(f))
    expect(read).not.toBeNull()
    expect(selectedMorphoV2IdleNativeRead(read, { ...f, asOfMs: Date.parse(f.request.source.blockTime) + 1800001 })).toBeNull()
    expect(selectedMorphoV2IdleNativeRead(read, { ...f, request: { ...f.request, requestedRaw: '2' }, asOfMs: Date.now() })).toBeNull()
    expect(selectedMorphoV2IdleNativeRead(read, { ...f, asOfMs: NOW - 1 })).toBeNull()
  })
  it('cuts off a pending second call at the absolute12s stage, not a restarted relative deadline', async () => {
    const f = fixture(); let starts = 0, secondAborted = false
    const first = createMorphoV2IdleNativeOrigin('https://' + HOSTS[0], (async (_url, init) => {
      starts++; await abortableDelay(7000, init!.signal!)
      const id = JSON.parse(init!.body as string).id
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: '0x1' }))
    }) as typeof fetch)
    const second = createMorphoV2IdleNativeOrigin('https://' + HOSTS[1], (async (_url, init) => {
      starts++
      return await new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => {
        secondAborted = true; reject(new Error('stage aborted'))
      }, { once: true }))
    }) as typeof fetch)
    const begun = performance.now()
    expect(await complete(readMorphoV2IdleNativeHolder({ ...f, origins: [first, second] }))).toBeNull()
    expect(starts).toBe(2); expect(secondAborted).toBe(true)
    expect(performance.now() - begun).toBeLessThanOrEqual(12025); expect(vi.getTimerCount()).toBe(0)
  })
  it('accepts no row settling on the stage boundary and dispatches no later row', async () => {
    const f = fixture(); f.delay(400)
    expect(await complete(readMorphoV2IdleNativeHolder(f))).toBeNull()
    expect(f.starts.length).toBeLessThanOrEqual(30)
    expect(performance.now()).toBeLessThanOrEqual(12025); expect(vi.getTimerCount()).toBe(0)
  })
  it('checks zero remaining before dispatch and cleans up even if timer arming fails', async () => {
    let starts = 0
    const origin = createMorphoV2IdleNativeOrigin('https://' + HOSTS[0], (async () => { starts++; return new Response('{}') }) as typeof fetch)
    const req = { jsonrpc: '2.0' as const, id: 1, method: 'eth_chainId', params: [] }
    await expect(origin.execute(req, performance.now())).rejects.toThrow()
    expect(starts).toBe(0)
    const arm = vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => { throw new Error('timer unavailable') })
    await expect(origin.execute(req, performance.now() + 1000)).rejects.toThrow()
    arm.mockRestore(); expect(starts).toBe(0); expect(vi.getTimerCount()).toBe(0)
  })
  it('rechecks the60s outer wall clock after original native work', async () => {
    const f = fixture()
    f.mutate((_key, _host, result) => { vi.setSystemTime(NOW + 60001); return result })
    expect(await complete(readMorphoV2IdleNativeHolder(f))).toBeNull()
    expect(f.starts).toHaveLength(1); expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves the generic successfulQ external evidence gate without adding RPCs', async () => {
    const f = successfulQ(fixture())
    expect(f.capacityAgreement).not.toBeNull()
    expect(await readMorphoV2IdleNativeHolder({ ...f, executionAgreement: undefined })).toBeNull()
    const forged = structuredClone(f.executionAgreement); forged.simulations[1].finalAssetAmountRaw = '1'
    expect(await readMorphoV2IdleNativeHolder({ ...f, executionAgreement: forged })).toBeNull()
    expect(f.starts).toHaveLength(0)
    const read = await complete(readMorphoV2IdleNativeHolder(f))
    expect(read).not.toBeNull(); expect(f.starts).toHaveLength(32)
    expect(selectedMorphoV2IdleNativeRead(read, { ...f, asOfMs: Date.now(), executionAgreement: undefined })).toBeNull()
    expect(selectedMorphoV2IdleNativeRead(read, { ...f, asOfMs: Date.now() })).toBe(read)
  })

})
