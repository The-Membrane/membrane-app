import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { evaluate, isBack, isPast, readingFrom, readingKey, type Reading, type ThresholdState } from '@/lib/userAlerts/evaluate'
import {
  base64urlToHex,
  BOUNDS,
  checkThreshold,
  describeThreshold,
  formatValue,
  hexToBase64url,
  hysteresisBand,
  parseSubject,
  PP_BAND,
  PRICE_BAND_FRACTION,
  subjectLabel,
  thresholdDeepLink,
} from '@/lib/userAlerts/metrics'
import { allowListFrom, liveAllowList } from '@/lib/userAlerts/subjects'
import {
  APR_ANCHOR_MAX_AGE_S,
  APR_READ_MAX_AGE_S,
  cachedSource,
  chainlinkPrice,
  CHAINLINK_FEEDS,
  netApySupplyApr,
  readValues,
  recorderUtilization,
  UTILIZATION_MAX_AGE_S,
  type AprSnapshot,
  type ContractReader,
  type ValueSources,
} from '@/lib/userAlerts/values'

// No test may reach the network: any un-stubbed fetch throws.
beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('network call in a unit test')
  })
})
afterEach(() => vi.unstubAllGlobals())

const NOW = Date.parse('2026-10-14T12:00:00Z')
const ok = (value: number): Reading => ({ status: 'ok', value, asOf: '2026-10-14T11:30:00Z', source: 'test' })
const t = (o: Partial<ThresholdState> = {}): ThresholdState => ({
  metric: 'utilization',
  direction: 'above',
  threshold: 50,
  crossedAt: null,
  ...o,
})

describe('isPast / isBack — the boundaries', () => {
  it('"at X" fires at exactly X, both directions', () => {
    expect(isPast('above', 50, 50)).toBe(true)
    expect(isPast('above', 49.999, 50)).toBe(false)
    expect(isPast('below', 2500, 2500)).toBe(true)
    expect(isPast('below', 2500.01, 2500)).toBe(false)
  })
  it('clearing needs MORE than the band; exactly at the band edge is not back', () => {
    // price band 0.5% of 2000 = 10
    expect(hysteresisBand('price', 2000)).toBeCloseTo(10)
    expect(isBack('price', 'above', 1990, 2000)).toBe(false)
    expect(isBack('price', 'above', 1989.99, 2000)).toBe(true)
    expect(isBack('price', 'below', 2010, 2000)).toBe(false)
    expect(isBack('price', 'below', 2010.01, 2000)).toBe(true)
    // util / apr band 0.5 pp
    expect(hysteresisBand('utilization', 90)).toBe(PP_BAND)
    expect(isBack('utilization', 'above', 89.5, 90)).toBe(false)
    expect(isBack('utilization', 'above', 89.49, 90)).toBe(true)
    expect(isBack('apr', 'below', 4.5, 4)).toBe(false)
    expect(isBack('apr', 'below', 4.51, 4)).toBe(true)
    expect(PRICE_BAND_FRACTION).toBe(0.005)
  })
})

describe('evaluate', () => {
  it('not crossed → crossed at or past the line', () => {
    expect(evaluate(t(), ok(50))).toEqual({ kind: 'crossed', value: 50 })
    expect(evaluate(t(), ok(49.9))).toEqual({ kind: 'held', value: 49.9, crossed: false })
  })
  it('crossed stays crossed inside the band, clears beyond it', () => {
    const crossed = t({ crossedAt: '2026-10-14T10:00:00Z' })
    expect(evaluate(crossed, ok(55))).toEqual({ kind: 'held', value: 55, crossed: true })
    expect(evaluate(crossed, ok(49.6))).toEqual({ kind: 'held', value: 49.6, crossed: true })
    expect(evaluate(crossed, ok(49.4))).toEqual({ kind: 'cleared', value: 49.4 })
  })
  it('a stale or unavailable value is never evaluated — no crossing, no clearing', () => {
    const stale: Reading = { status: 'stale', value: 99, asOf: '2026-10-14T01:00:00Z', source: 'x', maxAgeS: 7200 }
    const gone: Reading = { status: 'unavailable', source: 'x', reason: 'rpc down' }
    expect(evaluate(t(), stale)).toEqual({ kind: 'skipped', reason: 'stale', crossed: false })
    expect(evaluate(t({ crossedAt: '2026-10-14T10:00:00Z' }), { ...stale, value: 0 })).toEqual({ kind: 'skipped', reason: 'stale', crossed: true })
    expect(evaluate(t(), gone)).toEqual({ kind: 'skipped', reason: 'unavailable', crossed: false })
    expect(evaluate(t(), undefined)).toEqual({ kind: 'skipped', reason: 'unavailable', crossed: false })
    expect(evaluate(t(), ok(NaN))).toEqual({ kind: 'skipped', reason: 'unavailable', crossed: false })
  })
  it('a reading older than the one the state last moved on is superseded, never evaluated', () => {
    const crossed = t({ crossedAt: '2026-10-14T11:30:00Z', lastAsOf: '2026-10-14T11:30:00.000Z' })
    const older: Reading = { status: 'ok', value: 10, asOf: '2026-10-14T11:00:00.000Z', source: 'x' }
    expect(evaluate(crossed, older)).toEqual({ kind: 'skipped', reason: 'superseded', crossed: true })
    // the same as-of (same reading again) is evaluated as usual
    expect(evaluate(crossed, { ...older, asOf: '2026-10-14T11:30:00.000Z' })).toEqual({ kind: 'cleared', value: 10 })
  })
  it('repeated reads are idempotent and a value hovering at the line does not flap', () => {
    // Drive a tiny state machine with a series of reads; count transitions.
    let state = t({ metric: 'price', direction: 'below', threshold: 2500 })
    const transitions: string[] = []
    for (const v of [2510, 2500, 2500, 2499, 2505, 2512.5, 2499, 2512.51, 2512.51, 2400]) {
      const ev = evaluate(state, ok(v))
      if (ev.kind === 'crossed') state = { ...state, crossedAt: `t${transitions.push('crossed')}` }
      if (ev.kind === 'cleared') state = { ...state, crossedAt: (transitions.push('cleared'), null) }
    }
    // 2500 crosses (at X); 2505 / 2512.5 stay inside the 12.5 band; 2512.51 clears; 2400 re-crosses.
    expect(transitions).toEqual(['crossed', 'cleared', 'crossed'])
  })
})

describe('readingFrom — staleness by the source cadence × 2', () => {
  const base = { nowMs: NOW, maxAgeS: 7200, source: 'Chainlink ETH / USD' }
  it('fresh, exactly at the limit, and past it', () => {
    expect(readingFrom({ ...base, value: 1, asOfMs: NOW - 60_000 }).status).toBe('ok')
    expect(readingFrom({ ...base, value: 1, asOfMs: NOW - 7_200_000 }).status).toBe('ok')
    expect(readingFrom({ ...base, value: 1, asOfMs: NOW - 7_200_001 }).status).toBe('stale')
  })
  it('a slightly future timestamp (clock skew) is fresh; missing value or time is unavailable', () => {
    expect(readingFrom({ ...base, value: 1, asOfMs: NOW + 5_000 }).status).toBe('ok')
    expect(readingFrom({ ...base, value: null, asOfMs: NOW }).status).toBe('unavailable')
    expect(readingFrom({ ...base, value: 1, asOfMs: null }).status).toBe('unavailable')
  })
})

describe('metrics', () => {
  it('bounds per metric', () => {
    expect(checkThreshold('price', 0).ok).toBe(false)
    expect(checkThreshold('price', 0.01).ok).toBe(true)
    expect(checkThreshold('price', BOUNDS.price.max).ok).toBe(true)
    expect(checkThreshold('price', BOUNDS.price.max + 1).ok).toBe(false)
    expect(checkThreshold('utilization', -0.1).ok).toBe(false)
    expect(checkThreshold('utilization', 0).ok).toBe(true)
    expect(checkThreshold('utilization', 100).ok).toBe(true)
    expect(checkThreshold('utilization', 100.1).ok).toBe(false)
    expect(checkThreshold('apr', 500).ok).toBe(true)
    expect(checkThreshold('apr', 501).ok).toBe(false)
    expect(checkThreshold('apr', NaN).ok).toBe(false)
    expect(checkThreshold('apr', Infinity).ok).toBe(false)
    expect(checkThreshold('apr', '5' as unknown as number).ok).toBe(false)
    expect(checkThreshold('price', 2500.1234567)).toEqual({ ok: true, value: 2500.123457 })
  })
  it('words and figures', () => {
    expect(formatValue('price', 2510.734)).toBe('$2,510.73')
    expect(formatValue('utilization', 44.25)).toBe('44.3%')
    expect(formatValue('apr', 4.371)).toBe('4.37%')
    expect(subjectLabel('asset:ETH')).toBe('ETH')
    expect(subjectLabel('venue:aave-v3-usde')).toBe('Aave v3 USDe')
    expect(subjectLabel('venue:sUSDe')).toBe('sUSDe')
    expect(describeThreshold({ metric: 'price', subject: 'asset:ETH', direction: 'below', threshold: 2500 })).toBe('ETH price below $2,500.00')
    expect(parseSubject('venue:aave-v3-usde')).toEqual({ kind: 'venue', venue: 'aave-v3-usde' })
    expect(parseSubject('venue:')).toBeNull()
    expect(parseSubject('asset:ETH; drop table')).toBeNull()
  })
  it('the feed token round-trips through base64url and the deep link fits Telegram', () => {
    const hex = 'a1'.repeat(16) + '0f'.repeat(16)
    const b64 = hexToBase64url(hex)
    expect(b64).toHaveLength(43)
    expect(b64).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(base64urlToHex(b64)).toBe(hex)
    for (const h of ['00'.repeat(32), 'ff'.repeat(32), '0123456789abcdef'.repeat(4)]) expect(base64urlToHex(hexToBase64url(h))).toBe(h)
    const link = thresholdDeepLink('@membrane_alerts_bot', hex)
    const payload = link.split('?start=')[1]
    expect(link.startsWith('https://t.me/membrane_alerts_bot?start=th_')).toBe(true)
    expect(payload).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    expect(base64urlToHex('not base64!')).toBeNull()
  })
})

describe('allow-list from the live recorder config', () => {
  it('price: ETH, BTC; utilization and APR: only enabled venues with a live source', () => {
    const a = liveAllowList()
    expect([...a.price].sort()).toEqual(['asset:BTC', 'asset:ETH'])
    // Only the Aave reserve records utilization AND is in the net-APY registry.
    expect([...a.utilization]).toEqual(['venue:aave-v3-usde'])
    expect([...a.apr]).toEqual(['venue:aave-v3-usde'])
    expect(a.utilization.has('venue:sUSDe')).toBe(false)
  })
  it('disabled venues never appear', () => {
    const a = allowListFrom([
      { name: 'aave-v3-usdc', enabled: false, variableDebtToken: '0x1' },
      { name: 'aave-v3-usde', enabled: true, variableDebtToken: '0x2' },
    ])
    expect([...a.utilization]).toEqual(['venue:aave-v3-usde'])
    expect([...a.apr]).toEqual(['venue:aave-v3-usde'])
  })
})

describe('values — Chainlink price (fake chain)', () => {
  const round = (answer: bigint, updatedAtS: number) => [1n, answer, 0n, BigInt(updatedAtS), 1n] as const
  const client = (o: { decimals?: number; description?: string; answer?: bigint; updatedAtS?: number; throws?: Error } = {}): ContractReader => ({
    readContract: async ({ address, functionName }) => {
      if (o.throws) throw o.throws
      expect(address).toBe(CHAINLINK_FEEDS.ETH.proxy)
      if (functionName === 'decimals') return o.decimals ?? 8
      if (functionName === 'description') return o.description ?? 'ETH / USD'
      return round(o.answer ?? 251073456333n, o.updatedAtS ?? NOW / 1000 - 2460)
    },
  })
  it('decodes the answer at the verified decimals and names the feed', async () => {
    const r = await chainlinkPrice(() => client(), () => NOW)('ETH')
    expect(r).toEqual({ status: 'ok', value: 2510.73456333, asOf: new Date(NOW - 2_460_000).toISOString(), source: 'Chainlink ETH / USD' })
  })
  it('refuses a feed whose identity does not match', async () => {
    expect((await chainlinkPrice(() => client({ description: 'BTC / USD' }), () => NOW)('ETH')).status).toBe('unavailable')
    expect((await chainlinkPrice(() => client({ decimals: 18 }), () => NOW)('ETH')).status).toBe('unavailable')
    expect((await chainlinkPrice(() => client({ answer: 0n }), () => NOW)('ETH')).status).toBe('unavailable')
  })
  it('stale past 2 × the 1h heartbeat; an RPC error is unavailable with the URL redacted', async () => {
    expect((await chainlinkPrice(() => client({ updatedAtS: NOW / 1000 - 7201 }), () => NOW)('ETH')).status).toBe('stale')
    const r = await chainlinkPrice(() => client({ throws: new Error('fetch failed https://rpc.example/KEY123') }), () => NOW)('ETH')
    expect(r.status).toBe('unavailable')
    expect(JSON.stringify(r)).not.toContain('KEY123')
  })
})

describe('values — recorder utilization (fake sql)', () => {
  const sqlOf = (rows: any[]) => () => (async () => rows) as any
  it('reads the latest observed snapshot', async () => {
    const r = await recorderUtilization(sqlOf([{ observedAt: new Date(NOW - 1_800_000).toISOString(), utilizationPct: '44.2' }]), () => NOW)('aave-v3-usde')
    expect(r).toMatchObject({ status: 'ok', value: 44.2 })
  })
  it('stale after 2 hourly ticks; missing row or value is unavailable', async () => {
    const old = await recorderUtilization(sqlOf([{ observedAt: new Date(NOW - UTILIZATION_MAX_AGE_S * 1000 - 1).toISOString(), utilizationPct: '44.2' }]), () => NOW)('x')
    expect(old.status).toBe('stale')
    expect((await recorderUtilization(sqlOf([]), () => NOW)('x')).status).toBe('unavailable')
    expect((await recorderUtilization(sqlOf([{ observedAt: new Date(NOW).toISOString(), utilizationPct: null }]), () => NOW)('x')).status).toBe('unavailable')
  })
})

describe('values — net-APY supply APR (injected read)', () => {
  const snap = (o: Partial<AprSnapshot> = {}): AprSnapshot => ({
    supplyApr: 0.0437,
    readAtS: NOW / 1000 - 30,
    anchorTs: NOW / 1000 - 900,
    block: '26123456',
    ...o,
  })
  it('percent, as of the finalized anchor, source names the block', async () => {
    const r = await netApySupplyApr(async () => snap(), () => NOW)('aave-v3-usde')
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.value).toBeCloseTo(4.37)
    expect(r.asOf).toBe(new Date(NOW - 900_000).toISOString())
    expect(r.source).toBe('Aave v3 USDe supply APR · on-chain at block 26123456')
  })
  it('stale when the read is old or finality stalled; a failed read is unavailable', async () => {
    expect((await netApySupplyApr(async () => snap({ readAtS: NOW / 1000 - APR_READ_MAX_AGE_S - 1 }), () => NOW)('aave-v3-usde')).status).toBe('stale')
    expect((await netApySupplyApr(async () => snap({ anchorTs: NOW / 1000 - APR_ANCHOR_MAX_AGE_S - 1 }), () => NOW)('aave-v3-usde')).status).toBe('stale')
    expect((await netApySupplyApr(async () => Promise.reject(new Error('reverted')), () => NOW)('aave-v3-usde')).status).toBe('unavailable')
  })
})

describe('cachedSource — a cache hit ages like an uncached value', () => {
  it('re-classifies the cached raw value against the clock on every hit', async () => {
    let clock = NOW
    let fetches = 0
    const src = cachedSource(
      3_600_000, // a long TTL: the hit must still turn stale on its own
      async () => (fetches++, { status: 'raw' as const, value: 44, asOfMs: NOW - 7_000_000, source: 's', maxAgeS: 7200 }),
      () => clock,
    )
    expect((await src('aave-v3-usde')).status).toBe('ok')
    clock += 300_000 // the as-of is now past 2h
    expect((await src('aave-v3-usde')).status).toBe('stale')
    expect(fetches).toBe(1)
  })
  it('an unavailable result is not cached', async () => {
    let fetches = 0
    const src = cachedSource(60_000, async () => (fetches++, { status: 'unavailable' as const, source: 's', reason: 'down' }), () => NOW)
    await src('x')
    await src('x')
    expect(fetches).toBe(2)
  })
})

describe('readValues', () => {
  it('reads each distinct need once and routes it to its source', async () => {
    const calls: string[] = []
    const sources: ValueSources = {
      price: async (a) => (calls.push(`price:${a}`), ok(2500)),
      utilization: async (v) => (calls.push(`util:${v}`), ok(44)),
      apr: async (v) => (calls.push(`apr:${v}`), ok(4)),
    }
    const m = await readValues(
      [
        { metric: 'price', subject: 'asset:ETH' },
        { metric: 'price', subject: 'asset:ETH' },
        { metric: 'utilization', subject: 'venue:aave-v3-usde' },
        { metric: 'apr', subject: 'venue:aave-v3-usde' },
        { metric: 'price', subject: 'asset:DOGE' },
        { metric: 'utilization', subject: 'asset:ETH' },
      ],
      sources,
    )
    expect(calls.sort()).toEqual(['apr:aave-v3-usde', 'price:ETH', 'util:aave-v3-usde'])
    expect(m.get(readingKey('price', 'asset:ETH'))?.status).toBe('ok')
    expect(m.get(readingKey('price', 'asset:DOGE'))?.status).toBe('unavailable')
    expect(m.get(readingKey('utilization', 'asset:ETH'))?.status).toBe('unavailable')
  })
})
