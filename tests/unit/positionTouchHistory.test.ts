// The generated touch-history table (lib/position/touchHistory.generated.json): internally
// consistent always; recomputed from the hourly series when the private datasets clone is
// present ($MEMBRANE_DATASETS_DIR or ../membrane-datasets, board rule N18).

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  HORIZON_IDS,
  TOUCH_TABLE,
  assertTouchTable,
  periodYears,
  shortSha,
  type HistoryAsset,
} from '@/lib/position/touchHistory'
import {
  atOrBelow,
  floorPct,
  formatFrequency,
  lookupTouch,
  touchAt,
  touchAtLevel,
  touchByHorizon,
} from '@/lib/position/touch'

const t = TOUCH_TABLE
const ASSETS: HistoryAsset[] = ['ETH', 'BTC']
const DIRS = ['fall', 'rise'] as const

describe('touch table: shape', () => {
  it('passes its own structural check, integers only', () => {
    expect(() => assertTouchTable(t)).not.toThrow()
    for (const a of ASSETS)
      for (const d of DIRS)
        for (const h of HORIZON_IDS) {
          const r = t.assets[a][d][h]
          expect(Number.isInteger(r.n)).toBe(true)
          expect(r.touched.every(Number.isInteger)).toBe(true)
        }
  })

  it('rejects a broken table, naming the field', () => {
    const broken = JSON.parse(JSON.stringify(t))
    broken.assets.ETH.fall['7d'].touched.pop()
    expect(() => assertTouchTable(broken)).toThrow(/ETH\.fall\.7d\.touched/)
    const over = JSON.parse(JSON.stringify(t))
    over.assets.BTC.rise['1d'].touched[0] = over.assets.BTC.rise['1d'].n + 1
    expect(() => assertTouchTable(over)).toThrow(/out of range/)
  })

  it('names its source: repo, commit, two files with sha256', () => {
    expect(t.source.repo).toBe('triccs/membrane-datasets')
    expect(t.source.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(shortSha(t)).toBe(t.source.commit.slice(0, 7))
    expect(t.source.paths).toEqual(['price-history/eth-usd-1h.json', 'price-history/btc-usd-1h.json'])
    for (const p of t.source.paths) expect(t.source.sha256[p]).toMatch(/^[0-9a-f]{64}$/)
    expect(t.method).toMatch(/History, not a forecast/)
  })

  it('levels are 1..60 and horizons 1d..30d', () => {
    expect(t.levels).toEqual({ min: 1, max: 60, step: 1 })
    expect(t.horizons.map((h) => h.id)).toEqual(HORIZON_IDS)
    expect(t.horizons.map((h) => h.hours)).toEqual([24, 72, 168, 336, 720])
  })

  it('ETH starts at its oracle-grade span (2020-04-09 first origin), BTC at 2020-01-02', () => {
    for (const h of HORIZON_IDS) {
      expect(t.assets.ETH.fall[h].from).toBe('2020-04-09')
      expect(t.assets.BTC.fall[h].from).toBe('2020-01-02')
    }
    expect(periodYears(t, 'ETH', 'fall')).toBe('2020–26')
  })
})

describe('touch table: internal consistency', () => {
  it('is monotone non-increasing in the level for every asset, direction and horizon', () => {
    for (const a of ASSETS)
      for (const d of DIRS)
        for (const h of HORIZON_IDS) {
          const r = t.assets[a][d][h].touched
          for (let i = 1; i < r.length; i++) expect(r[i]).toBeLessThanOrEqual(r[i - 1])
        }
  })

  it('is non-decreasing in the horizon at every level (counts and frequencies)', () => {
    for (const a of ASSETS)
      for (const d of DIRS)
        for (let L = 0; L < 60; L++)
          for (let k = 1; k < HORIZON_IDS.length; k++) {
            const p = t.assets[a][d][HORIZON_IDS[k - 1]]
            const q = t.assets[a][d][HORIZON_IDS[k]]
            expect(q.touched[L]).toBeGreaterThanOrEqual(p.touched[L])
            expect(q.touched[L] / q.n).toBeGreaterThanOrEqual(p.touched[L] / p.n)
          }
  })

  it('n shrinks with the horizon by at most the horizon (windows past the end are dropped)', () => {
    for (const a of ASSETS)
      for (const d of DIRS) {
        const n = HORIZON_IDS.map((h) => t.assets[a][d][h].n)
        for (let k = 1; k < n.length; k++) expect(n[k]).toBeLessThanOrEqual(n[k - 1])
        expect(n[0] - n[n.length - 1]).toBeLessThanOrEqual(30)
      }
  })
})

describe('touch lookup', () => {
  it('floors the distance toward risk (the larger frequency)', () => {
    const at27 = touchAt(t, 'ETH', 'fall', '7d', 0.2799)
    const at28 = touchAt(t, 'ETH', 'fall', '7d', 0.28)
    expect(at27?.level).toBe(27)
    expect(at28?.level).toBe(28)
    expect(at27!.touched).toBeGreaterThanOrEqual(at28!.touched)
    expect(at27).toMatchObject({ asset: 'ETH', direction: 'fall', horizon: '7d', confidence: null })
    expect(at27!.n).toBe(t.assets.ETH.fall['7d'].n)
    expect(at27!.pct).toBeCloseTo((at27!.touched / at27!.n) * 100, 10)
  })

  it('absorbs float noise in the floor', () => {
    expect(floorPct(0.29)).toBe(29)
    expect(floorPct(0.57)).toBe(57)
    expect(floorPct(0.2899999)).toBe(28)
  })

  it('returns null outside the table and says which side', () => {
    expect(touchAt(t, 'ETH', 'fall', '7d', 0.005)).toBeNull()
    expect(touchAt(t, 'ETH', 'fall', '7d', 0.61)).toBeNull()
    expect(lookupTouch(t, 'ETH', 'fall', '7d', 0.005)).toEqual({ kind: 'within', minLevel: 1 })
    expect(lookupTouch(t, 'ETH', 'fall', '7d', 0.6)).toMatchObject({ kind: 'row' })
    expect(lookupTouch(t, 'ETH', 'fall', '7d', 0.61)).toEqual({ kind: 'beyond', maxLevel: 60 })
    expect(touchAtLevel(t, 'BTC', 'rise', '1d', 0)).toBeNull()
    expect(touchAtLevel(t, 'BTC', 'rise', '1d', 61)).toBeNull()
    expect(touchAtLevel(t, 'BTC', 'rise', '1d', 1.5)).toBeNull()
  })

  it('gives one row per horizon, each period named', () => {
    const rows = touchByHorizon(t, 'BTC', 'rise', 0.1)
    expect(rows.map((r) => r.horizon)).toEqual(HORIZON_IDS)
    for (const r of rows) expect(r.period.from <= r.period.to).toBe(true)
  })

  it('formats a frequency toward risk, never inventing a figure', () => {
    expect(formatFrequency(0, 2365)).toBe('0%')
    expect(formatFrequency(1, 2365)).toBe('<1%')
    expect(formatFrequency(572, 2365)).toBe('25%') // 24.19% rounds up
    expect(formatFrequency(2365, 2365)).toBe('100%')
    expect(formatFrequency(50, 1000)).toBe('5%') // exact, not bumped to 6%
    expect(() => formatFrequency(1, 0)).toThrow()
  })

  it('tests a target in integers', () => {
    expect(atOrBelow(50, 1000, 5)).toBe(true)
    expect(atOrBelow(51, 1000, 5)).toBe(false)
  })
})

// --------------------------------------------------------------------- recompute

const DATASETS = resolve(process.env.MEMBRANE_DATASETS_DIR ?? join(process.cwd(), '..', 'membrane-datasets'))
const PH = join(DATASETS, 'price-history')
const has = existsSync(join(PH, 'eth-usd-1h.json')) && existsSync(join(PH, 'btc-usd-1h.json'))

interface Series {
  startTs: number
  stepSeconds: number
  columns: Record<string, (number | null)[]>
  primary: { segments: { source: string; fromIndex: number; toIndex: number }[] }
}

/** An independent, deliberately naive recompute of one cell. */
function naiveCell(s: Series, dir: 'fall' | 'rise', hours: number, L: number) {
  const seg = s.primary.segments.find((g) => g.source === 'oracle')!
  const close = s.columns.oracle
  const col = dir === 'fall' ? s.columns.oracleLow : s.columns.oracleHigh
  let n = 0
  let touched = 0
  for (let i = seg.fromIndex + 1; i + hours - 1 <= seg.toIndex; i++) {
    if ((s.startTs + i * 3600) % 86400 !== 0) continue
    const S = close[i - 1]
    if (S == null) continue
    const w = col.slice(i, i + hours)
    const vals = w.filter((v): v is number => v != null)
    if (w.length - vals.length > hours * 0.1) continue
    n++
    if (dir === 'fall' ? Math.min(...vals) <= (S * (100 - L)) / 100 : Math.max(...vals) >= (S * (100 + L)) / 100) {
      touched++
    }
  }
  return { n, touched }
}

describe.skipIf(!has)('touch table: recomputed from the hourly series', () => {
  const load = (f: string) => {
    const buf = readFileSync(join(PH, f))
    return { sha: createHash('sha256').update(buf).digest('hex'), json: JSON.parse(buf.toString('utf8')) as Series }
  }
  const eth = has ? load('eth-usd-1h.json') : (null as never)
  const btc = has ? load('btc-usd-1h.json') : (null as never)

  it('was built from these exact files', () => {
    expect(t.source.sha256['price-history/eth-usd-1h.json']).toBe(eth.sha)
    expect(t.source.sha256['price-history/btc-usd-1h.json']).toBe(btc.sha)
  })

  const cells: [HistoryAsset, 'fall' | 'rise', (typeof HORIZON_IDS)[number], number, number][] = [
    ['ETH', 'fall', '7d', 168, 10],
    ['ETH', 'fall', '7d', 168, 27],
    ['ETH', 'fall', '1d', 24, 5],
    ['ETH', 'rise', '30d', 720, 40],
    ['BTC', 'fall', '14d', 336, 20],
    ['BTC', 'rise', '3d', 72, 5],
  ]
  it.each(cells)('%s %s %s at %i%% matches a naive recompute', (asset, dir, h, hours, L) => {
    const s = asset === 'ETH' ? eth.json : btc.json
    const want = naiveCell(s, dir, hours, L)
    const got = t.assets[asset][dir][h]
    expect(got.n).toBe(want.n)
    expect(got.touched[L - 1]).toBe(want.touched)
  })
})
