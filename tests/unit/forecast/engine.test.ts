import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import registryJson from '@/lib/forecast/registry.json'
import {
  appendKlines, decodeCompactSeries, defaultRegistry, findCell, gate, historyCount, parseRegistry, reach, touchProbability, whatCanWeSay,
  type ForecastCell, type PriceSeries, type Registry,
} from '@/lib/forecast'
import { committed } from './helpers'

const OCT10_21 = Date.UTC(2025, 9, 10, 21, 0) / 1000
// The engine fails closed when the synced monitor flags are older than 3 days: pin the wall clock 1 h after the sync.
const FRESH_MS = Date.parse((registryJson as { monitorAsOf: string }).monitorAsOf) + 3600_000
beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(FRESH_MS) })
afterAll(() => { vi.useRealTimers() })
const clone = (): Registry => JSON.parse(JSON.stringify(registryJson))

/** A registry with one cell's class replaced (for gating tests). */
function withClass(id: string, cls: ForecastCell['class']): Registry {
  const r = clone()
  const c = r.cells.find((x) => x.id === id)!
  c.class = cls
  c.label = r.labels[cls]
  c.trigger = false
  return parseRegistry(r)
}

describe('registry', () => {
  it('parses, one row per cell, no duplicates', () => {
    const r = defaultRegistry()
    expect(r.cells.length).toBe(r.horizonsH.length * r.levelsPct.length * 4)
    expect(new Set(r.cells.map((c) => c.id)).size).toBe(r.cells.length)
    for (const c of r.cells) expect(c.source.length).toBeGreaterThan(0)
  })
  it('fails closed on a malformed row', () => {
    const r = clone(); r.cells[0].class = 'MAYBE' as never
    expect(() => parseRegistry(r)).toThrow()
    const r2 = clone(); const w = r2.cells.find((c) => c.class === 'CALIBRATED_WARN')!; w.label = 'odds'
    expect(() => parseRegistry(r2)).toThrow(/required label/)
    expect(() => parseRegistry({ schema: 'x' })).toThrow()
  })
  it('carries the map classes for ETH/BTC (spot checks against the confidence map)', () => {
    const r = defaultRegistry()
    const cls = (h: number, l: number) => findCell(r, 'eth_btc', h, l)!.class
    expect(cls(24, -10)).toBe('CALIBRATED_WARN')
    expect(cls(12, -10)).toBe('RECALIBRATE') // removed from warnings (D12 review)
    expect(cls(72, -20)).toBe('DO_NOT_SHOW') // R22 ruling
    expect(cls(168, -20)).toBe('CALIBRATED') // labelled context
    expect(cls(24, -20)).toBe('HISTORY_COUNT')
    expect(cls(720, -15)).toBe('DO_NOT_SHOW')
    expect(cls(720, -5)).toBe('DO_NOT_SHOW') // P1: label-class row only
    expect(cls(24, -15)).toBe('CALIBRATED') // P3: no deployed monitor
    expect(findCell(r, 'steth', 24, -10)!.class).toBe('DO_NOT_SHOW')
  })
  it('only SKILL / CALIBRATED_WARN cells may trigger', () => {
    for (const c of defaultRegistry().cells) if (c.trigger) expect(['SKILL', 'CALIBRATED_WARN']).toContain(c.class)
  })
})

describe('class gating', () => {
  const eth = committed('ETHUSDT')
  const id = 'eth_btc:72h:-10'
  it('CALIBRATED_WARN shows a probability with the required label', () => {
    const r = touchProbability('ETH', OCT10_21, 72, -10, eth)
    expect(r.display).toBe('probability')
    expect(r.label).toBe('calibrated, not proven better than alternatives')
    expect(r.p).toBeGreaterThan(0)
    expect(r.p).toBeLessThan(1)
  })
  it('SKILL and CALIBRATED show a probability; CALIBRATED is labelled context, never a trigger', () => {
    expect(touchProbability('ETH', OCT10_21, 72, -10, eth, { registry: withClass(id, 'SKILL') }).display).toBe('probability')
    const c = touchProbability('ETH', OCT10_21, 72, -10, eth, { registry: withClass(id, 'CALIBRATED') })
    expect(c.display).toBe('probability')
    expect(c.label).toMatch(/not a warning/)
    expect(c.cell!.trigger).toBe(false)
  })
  it('HISTORY_COUNT returns a count and never a probability', () => {
    const r = touchProbability('ETH', OCT10_21, 72, -10, eth, { registry: withClass(id, 'HISTORY_COUNT') })
    expect(r.display).toBe('count')
    expect(r.p).toBeNull()
    expect(r.count!.k).toBeGreaterThan(0)
  })
  it.each(['DO_NOT_SHOW', 'RECALIBRATE', 'PENDING', 'SCENARIO'] as const)('%s returns nothing', (cls) => {
    const r = touchProbability('ETH', OCT10_21, 72, -10, eth, { registry: withClass(id, cls) })
    expect(r.display).toBe('none')
    expect(r.p).toBeNull()
    expect(r.count).toBeUndefined()
    expect(r.reason).toBeTruthy()
  })
  it('a regrade flows through by data alone (new cell appears)', () => {
    expect(touchProbability('ETH', OCT10_21, 720, -15, eth).display).toBe('none')
    const r = clone(); const c = r.cells.find((x) => x.id === 'eth_btc:720h:-15')!
    Object.assign(c, { class: 'CALIBRATED_WARN', label: r.labels.CALIBRATED_WARN, model: 'raw_fH' })
    const p = touchProbability('ETH', OCT10_21, 720, -15, eth, { registry: parseRegistry(r) })
    expect(p.display).toBe('probability')
    expect(p.p).toBeGreaterThan(0)
  })
  it('no cell is invented: off-registry horizon or level, unknown asset, missing series', () => {
    expect(touchProbability('ETH', OCT10_21, 8, -10, eth).reason).toMatch(/no registry cell/)
    expect(touchProbability('ETH', OCT10_21, 24, -12, eth).display).toBe('none')
    expect(touchProbability('DOGE', OCT10_21, 24, -10, eth).reason).toMatch(/not in the forecast registry/)
    expect(touchProbability('stETH-market', OCT10_21, 24, -10, null).display).toBe('none')
    expect(touchProbability('BTC', OCT10_21, 72, -10, eth).reason).toMatch(/BTCUSDT required/)
    expect(touchProbability('ETH', OCT10_21, 24, -10, null).display).toBe('none')
  })
  it('near-line limit hides line-relative odds at 6 h-1 d within 10%, not price statements', () => {
    expect(touchProbability('ETH', OCT10_21, 24, -5, eth).display).toBe('none')
    expect(touchProbability('ETH', OCT10_21, 24, -5, eth).reason).toMatch(/Near-line/)
    expect(touchProbability('ETH', OCT10_21, 24, -5, eth, { purpose: 'price' }).display).toBe('probability')
    expect(touchProbability('ETH', OCT10_21, 72, -5, eth).display).toBe('probability')
  })
  it('wstETH (Membrane: Uniswap V3 wstETH/WETH TWAP) is the stETH group: DO NOT SHOW; WETH reads the ETH cells', () => {
    const a = touchProbability('wstETH', OCT10_21, 72, -10, eth)
    expect(a.display).toBe('none')
    expect(a.reason).toMatch(/DO NOT SHOW/)
    expect(a.cell!.group).toBe('steth')
    expect(whatCanWeSay('wstETH', OCT10_21, eth)).toEqual([])
    const b = touchProbability('ETH', OCT10_21, 72, -10, eth)
    expect(touchProbability('WETH', OCT10_21, 72, -10, eth).p).toBe(b.p)
  })
  it('Chainlink-only ETH/BTC cells: 1 h / 3 h -2/-3% PENDING (nothing), 6 h -2..-7% context, 6 h -10% warning', () => {
    const one = touchProbability('ETH', OCT10_21, 1, -2, eth, { purpose: 'price' })
    expect(one.display).toBe('none')
    expect(one.reason).toMatch(/Chainlink/)
    const six = touchProbability('ETH', OCT10_21, 6, -5, eth, { purpose: 'price' })
    expect(six.cell!.class).toBe('CALIBRATED')
    expect(six.cell!.trigger).toBe(false)
    expect(six.cell!.caveat).toMatch(/Chainlink/)
    const ten = touchProbability('ETH', OCT10_21, 6, -10, eth, { purpose: 'price' })
    expect(ten.cell!.class).toBe('CALIBRATED_WARN')
    expect(ten.cell!.trigger).toBe(true)
  })
  it('gate() is pure registry logic', () => {
    const r = defaultRegistry()
    expect(gate(r, null, 'price').display).toBe('none')
    expect(gate(r, findCell(r, 'eth_btc', 24, -20), 'price').display).toBe('count')
  })
})

describe('whatCanWeSay', () => {
  it('returns every displayable cell at the moment, across horizons, with the right display', () => {
    const eth = committed('ETHUSDT')
    const out = whatCanWeSay('ETH', OCT10_21, eth, { purpose: 'price' })
    const hs = new Set(out.map((r) => r.cell!.horizonH))
    expect(hs.has(1) && hs.has(168)).toBe(true)
    for (const r of out) {
      if (r.display === 'probability') expect(['SKILL', 'CALIBRATED_WARN', 'CALIBRATED']).toContain(r.cell!.class)
      if (r.display === 'count') { expect(r.cell!.class).toBe('HISTORY_COUNT'); expect(r.p).toBeNull() }
    }
    // monotone in depth at each horizon
    for (const h of hs) {
      const ps = out.filter((r) => r.cell!.horizonH === h && r.display === 'probability').sort((a, b) => b.cell!.levelPct - a.cell!.levelPct)
      for (let i = 1; i < ps.length; i++) expect(ps[i].p!).toBeLessThanOrEqual(ps[i - 1].p!)
    }
  })
})

/** Synthetic series: flat price with chosen drops, for exact history counts. */
function synthetic(lows: Record<number, number>, n = 2000): PriceSeries {
  const low = Array.from({ length: n }, (_, j) => lows[j] ?? 100)
  const close = low.slice() // a realistic drop: the close follows the low
  return { id: 'ETHUSDT', source: 'test', startTs: 1_600_000_000 - (1_600_000_000 % 3600), close, low, high: close.slice() }
}

describe('historyCount', () => {
  it('counts declustered episodes and only windows that end by asOfTs', () => {
    const s = synthetic({ 100: 89, 101: 88, 500: 95, 900: 90, 1990: 50 })
    const end = s.startTs + 3600 * 1500
    const c = historyCount(s, end, 24, -10)!
    expect(c.k).toBe(2) // 100/101 is one episode; 500 is only -5%; 900 is exactly -10%; 1990 is after asOfTs
    expect(c.n).toBe(Math.floor((1500 - 24 - 1 + 1) / 24))
    expect(c.since).toBe('2020')
    expect(historyCount(s, end, 24, -5)!.k).toBe(3)
    expect(historyCount(s, end, 24, -12)!.k).toBe(1)
    expect(historyCount(s, s.startTs + 3600 * 2000, 24, -40)!.k).toBe(1)
  })
  it('respects sinceTs and rejects bad input', () => {
    const s = synthetic({ 100: 89, 900: 90 })
    expect(historyCount(s, s.startTs + 3600 * 1500, 24, -10, { sinceTs: s.startTs + 3600 * 500 })!.k).toBe(1)
    expect(historyCount(s, s.startTs + 3600 * 1500, 24, 5)).toBeNull()
    expect(historyCount(s, s.startTs + 3600 * 10, 24, -10)).toBeNull()
  })
  it('ETH 3 d -30% on real history is a small count', () => {
    const c = historyCount(committed('ETHUSDT'), OCT10_21, 72, -30)!
    expect(c.k).toBeGreaterThan(0)
    expect(c.k).toBeLessThan(40)
    expect(c.since).toBe('2017')
  })
})

describe('reach', () => {
  const eth = committed('ETHUSDT')
  it('inside the range: upper bound at the nearest shallower displayable level', () => {
    const r = reach('ETH', OCT10_21, -12, eth)
    const d3 = r.rows.find((x) => x.horizonH === 72)!
    expect(d3.status).toBe('beyond') // 3 d displays -2..-10%; -15% is RECALIBRATE
    expect(d3.edgePct).toBe(-10)
    expect(d3.count!.levelPct).toBe(-12)
    const d1 = r.rows.find((x) => x.horizonH === 24)!
    expect(d1.status).toBe('inside')
    expect(d1.result!.cell!.levelPct).toBe(-10)
    expect(d1.isUpperBound).toBe(true)
    // R23 applies to the line distance (12%), not to the -10% bounding cell: the probability is shown
    expect(d1.result!.display).toBe('probability')
    expect(d1.result!.p).toBeGreaterThan(0)
    expect(d1.reason).not.toMatch(/Near-line/)
  })
  it('exactly on a registry level is not an upper bound', () => {
    const d = reach('ETH', OCT10_21, -15, eth).rows.find((x) => x.horizonH === 24)!
    expect(d.status).toBe('inside')
    expect(d.isUpperBound).toBe(false)
    expect(d.result!.display).toBe('probability')
  })
  it('line beyond every displayable level -> history count; near the line -> hidden', () => {
    const r = reach('ETH', OCT10_21, -35, eth)
    expect(r.rows.length).toBeGreaterThan(0)
    for (const row of r.rows) {
      expect(row.status).toBe('beyond')
      expect(row.result).toBeNull()
      expect(row.count!.levelPct).toBe(-35)
    }
    const near = reach('ETH', OCT10_21, -4, eth)
    expect(near.lineDistancePct).toBe(-4)
    const six = near.rows.find((x) => x.horizonH === 6)!
    expect(six.status).toBe('none')
    expect(six.reason).toMatch(/Near-line/)
    expect(near.rows.find((x) => x.horizonH === 72)!.status).toBe('inside')
  })
  it('through the line -> act now, no probability; unknown asset -> reason', () => {
    expect(reach('ETH', OCT10_21, 0, eth).throughLine).toBe(true)
    expect(reach('ETH', OCT10_21, 0, eth).rows).toEqual([])
    const past = reach('ETH', OCT10_21, 2, eth) // spot already 2% through the line
    expect(past.throughLine).toBe(true)
    expect(past.rows).toEqual([])
    expect(past.lineDistancePct).toBe(2)
    expect(reach('PEPE', OCT10_21, -20, eth).reason).toMatch(/not in the forecast registry/)
  })
  it('horizons are not boxed to the 8 h delay', () => {
    const hs = reach('ETH', OCT10_21, -12, eth).rows.map((x) => x.horizonH)
    expect(hs).toContain(168)
    expect(hs).toContain(72)
    expect(hs).toContain(24)
  })
})

describe('series', () => {
  it('appendKlines adds closed klines only and never overrides history', () => {
    const s = decodeCompactSeries({ schema: 'membrane-forecast-series/1', id: 'ETHUSDT', source: 't', startTs: 0, stepSeconds: 3600, count: 2, scale: 100, lastOpenIso: '', close: [10000, 50], lowOff: [100, 0], highOff: [0, 25] })
    expect(s.close).toEqual([100, 100.5]); expect(s.low).toEqual([99, 100.5]); expect(s.high).toEqual([100, 100.75])
    const k = (h: number, c: string): [number, string, string, string, string, string, number] => [h * 3600_000, c, c, c, c, '0', (h + 1) * 3600_000 - 1]
    const t = appendKlines(s, [k(1, '1'), k(3, '103'), k(4, '104')], 4.5 * 3600_000)
    expect(t.close).toEqual([100, 100.5, null, 103])
  })
})

describe('live tail', () => {
  it('fetchKlineTail pages, drops the open kline and never needs a key', async () => {
    const { fetchKlineTail } = await import('@/lib/forecast/live')
    const now = 1_792_900_000_000
    const urls: string[] = []
    const fake = (async (url: string) => {
      urls.push(url)
      const start = Number(new URL(url).searchParams.get('startTime'))
      const rows = [0, 1, 2].map((h) => [start + h * 3600_000, '1', '1', '1', '1', '0', start + (h + 1) * 3600_000 - 1])
      return { ok: true, json: async () => rows.filter((k) => (k[0] as number) < now) } as Response
    }) as typeof fetch
    const k = await fetchKlineTail('ETHUSDT', Math.floor(now / 1000) - 2 * 3600, fake, now)
    expect(urls[0]).toMatch(/^https:\/\/data-api\.binance\.vision\/api\/v3\/klines\?symbol=ETHUSDT&interval=1h/)
    expect(k.every((x) => Number(x[6]) < now)).toBe(true)
    expect(k.length).toBeGreaterThan(0)
  })
})

describe('live monitor freshness (fail closed)', () => {
  const eth = committed('ETHUSDT')
  const reg = defaultRegistry()
  it('fresh flags keep CALIBRATED_WARN and its trigger', () => {
    const r = touchProbability('ETH', OCT10_21, 72, -10, eth, { nowMs: FRESH_MS })
    expect(r.cell!.class).toBe('CALIBRATED_WARN')
    expect(r.cell!.trigger).toBe(true)
  })
  it('flags older than 3 days: every warning cell becomes CALIBRATED context, no trigger', () => {
    const late = FRESH_MS + 3 * 86400_000
    const r = touchProbability('ETH', OCT10_21, 72, -10, eth, { nowMs: late })
    expect(r.display).toBe('probability')
    expect(r.cell!.class).toBe('CALIBRATED')
    expect(r.label).toBe(reg.labels.CALIBRATED)
    expect(r.cell!.trigger).toBe(false)
    expect(r.cell!.caveat).toMatch(/older than 3 days/)
    expect(whatCanWeSay('ETH', OCT10_21, eth, { nowMs: late }).some((x) => x.cell!.class === 'CALIBRATED_WARN' || x.cell!.trigger)).toBe(false)
  })
  it('missing monitorAsOf fails closed too', () => {
    const r2 = clone(); delete (r2 as { monitorAsOf?: string }).monitorAsOf
    const r = touchProbability('ETH', OCT10_21, 72, -10, eth, { registry: parseRegistry(r2), nowMs: FRESH_MS })
    expect(r.cell!.class).toBe('CALIBRATED')
    expect(r.cell!.caveat).toMatch(/missing/)
  })
  it('a cell the monitor downgraded (synced from d12/classes.json) shows as CALIBRATED, no trigger', () => {
    // what gen_registry.py P5 writes for a downgraded cell
    const r2 = clone(); const c = r2.cells.find((x) => x.id === 'eth_btc:72h:-10')!
    Object.assign(c, { class: 'CALIBRATED', label: r2.labels.CALIBRATED, trigger: false, caveat: 'live D12 monitor downgraded this cell' })
    const r = touchProbability('ETH', OCT10_21, 72, -10, eth, { registry: parseRegistry(r2), nowMs: FRESH_MS })
    expect(r.cell!.class).toBe('CALIBRATED')
    expect(r.cell!.trigger).toBe(false)
  })
  it('parseRegistry validates the monitor field', () => {
    const r2 = clone(); (r2.cells[0].monitor as { status: string }).status = 'needed'
    expect(() => parseRegistry(r2)).toThrow(/monitor status/)
    const r3 = clone(); const t = r3.cells.find((x) => x.trigger)!; t.monitor.status = 'missing'
    expect(() => parseRegistry(r3)).toThrow(/deployed monitor/)
    for (const c of reg.cells) expect(['deployed', 'missing', 'none']).toContain(c.monitor.status)
  })
})

describe('klines route and live tail limits', () => {
  it('clampSince clamps to [now - 120 d, now] and rejects the future', async () => {
    const { clampSince, MAX_TAIL_HOURS } = await import('@/lib/forecast/live')
    const now = 1_792_900_000_000
    const n = Math.floor(now / 1000)
    expect(clampSince(n + 3600, now)).toEqual({ error: 'since is in the future' })
    expect(clampSince(1, now)).toEqual({ since: n - MAX_TAIL_HOURS * 3600 })
    expect(clampSince(n - 7200, now)).toEqual({ since: n - 7200 })
    expect('error' in clampSince(Number.NaN, now)).toBe(true)
  })
  it('the route rejects a future since and builds its cache key from the clamped value', async () => {
    const handler = (await import('@/pages/api/forecast/klines')).default
    const calls: string[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (u: string) => { calls.push(u); return { ok: true, json: async () => [] } as unknown as Response }) as typeof fetch
    const run = async (query: Record<string, string>) => {
      let status = 0; let body: unknown = null
      const res = { status(s: number) { status = s; return this }, json(b: unknown) { body = b; return this }, setHeader() { return this } }
      await handler({ method: 'GET', query } as never, res as never)
      return { status, body }
    }
    try {
      const now = Math.floor(Date.now() / 1000)
      expect((await run({ symbol: 'ETHUSDT', since: String(now + 7200) })).status).toBe(400)
      expect((await run({ symbol: 'DOGEUSDT', since: String(now) })).status).toBe(400)
      const a = await run({ symbol: 'ETHUSDT', since: '1000' })
      const b = await run({ symbol: 'ETHUSDT', since: '2000' }) // both clamp to now-120 d: same key, served from cache
      expect(a.status).toBe(200)
      expect((b.body as { cached: boolean }).cached).toBe(true)
      expect(calls.length).toBe(1)
      expect(Number(new URL(calls[0]).searchParams.get('startTime')) / 1000).toBeGreaterThanOrEqual(now - 120 * 86400 - 3600)
    } finally {
      globalThis.fetch = realFetch
    }
  })
  it('loadSeries refuses a tail gap longer than 120 days instead of padding nulls', async () => {
    const { loadSeries } = await import('@/lib/forecast/live')
    const compact = { schema: 'membrane-forecast-series/1', id: 'ETHUSDT', source: 't', startTs: 0, stepSeconds: 3600, count: 1, scale: 100, lastOpenIso: '', close: [10000], lowOff: [0], highOff: [0] }
    let tailCalls = 0
    const f = (async (u: string) => {
      if (u.includes('/api/forecast/klines')) { tailCalls++; return { ok: true, json: async () => ({ klines: [], fetchedAt: 'x' }) } }
      return { ok: true, json: async () => compact }
    }) as unknown as typeof fetch
    const out = await loadSeries('ETHUSDT', { live: true, fetchFn: f }, 200 * 86400_000)
    expect(out.stamp.live).toBe(false)
    expect(out.stamp.reason).toMatch(/rebuild/)
    expect(tailCalls).toBe(0)
    expect(out.series.close.length).toBe(1)
    const ok = await loadSeries('ETHUSDT', { live: true, fetchFn: f }, 10 * 86400_000)
    expect(ok.stamp.live).toBe(true)
  })
})
