// The generated forecast table (lib/position/touchHistory.generated.json) and its builder
// (scripts/position/build-touch-history.mjs): internally consistent always; checked
// against validation/t1 and recomputed from the hourly series when the private datasets
// clone is present ($MEMBRANE_DATASETS_DIR or ../membrane-datasets, board rule N18).

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'

import {
  BOOTSTRAP,
  CONFIDENCE_RULE,
  T1_LEVELS,
  bandFromDraw,
  bandTopFloor,
  blockDraw,
  floorBandTop,
  confidenceLabel,
  crossCheckT1,
  makeRng,
  parseT1Csv,
  touchedCounts,
} from '@/scripts/position/build-touch-history.mjs'
import {
  HORIZON_IDS,
  STALE_AFTER_DAYS,
  TOUCH_TABLE,
  assertTouchTable,
  isStale,
  meanN,
  periodYears,
  shortSha,
  type HistoryAsset,
} from '@/lib/position/touchHistory'
import {
  atOrBelow,
  confidenceLine,
  confidenceOf,
  floorPct,
  bandTopPct,
  formatBand,
  formatChance,
  lookupTouch,
  touchAt,
  touchAtLevel,
  touchByHorizon,
  touchCurve,
} from '@/lib/position/touch'

const t = TOUCH_TABLE
const ASSETS: HistoryAsset[] = ['ETH', 'BTC']
const DIRS = ['fall', 'rise'] as const

describe('forecast table: shape', () => {
  it('passes its own structural check, integers only', () => {
    expect(() => assertTouchTable(t)).not.toThrow()
    for (const a of ASSETS)
      for (const d of DIRS)
        for (const h of HORIZON_IDS) {
          const r = t.assets[a][d][h]
          for (const xs of [r.touched, r.lo, r.hi]) expect(xs.every(Number.isInteger)).toBe(true)
        }
  })

  it('rejects a broken table, naming the field', () => {
    const broken = JSON.parse(JSON.stringify(t))
    broken.assets.ETH.fall['7d'].touched.pop()
    expect(() => assertTouchTable(broken)).toThrow(/ETH\.fall\.7d\.touched/)
    const crossed = JSON.parse(JSON.stringify(t))
    crossed.assets.BTC.rise['1d'].lo[0] = crossed.assets.BTC.rise['1d'].hi[0] + 1
    expect(() => assertTouchTable(crossed)).toThrow(/band crosses/)
    const unchecked = JSON.parse(JSON.stringify(t))
    unchecked.t1Check.mismatches = 1
    expect(() => assertTouchTable(unchecked)).toThrow(/t1Check/)
  })

  it('names its source, its period and the t1 check it passed', () => {
    expect(t.source.repo).toBe('triccs/membrane-datasets')
    expect(t.source.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(shortSha(t)).toBe(t.source.commit.slice(0, 7))
    expect(t.source.paths).toEqual([
      'price-history/eth-usd-1h.json',
      'price-history/btc-usd-1h.json',
      'validation/t1/forecasts-calib.csv.gz',
      'validation/t1/forecasts-test.csv.gz',
    ])
    expect(t.period).toMatchObject({
      from: '2021-03-25',
      to: '2026-10-05',
      calib: { from: '2021-03-25', to: '2023-12-31' },
      test: { from: '2024-01-01', to: '2026-10-05' },
    })
    expect(t.t1Check).toEqual({ rowsCompared: 100_050, origins: 20_010, mismatches: 0 })
    expect(periodYears(t)).toBe('2021–26')
  })

  it('carries the bootstrap and the confidence rule in the file, and the rule in the method text', () => {
    expect(t.bootstrap).toMatchObject({ replicates: 2000, seed: 20261012, band: 0.9 })
    expect(t.confidenceRule).toMatchObject({ levels: [5, 10, 15, 20, 30], highMinChecks: 4, mediumMinShare: 0.5, preliminary: true })
    expect(t.method).toMatch(/High if every check holds and there are at least 4, medium if at least half hold, low otherwise, untested/)
    expect(t.method).toMatch(/90% moving-block bootstrap \(blocks of max\(30, 2T\) days that never span the purged 2024-01-01 seam/)
    expect(t.method).toMatch(/band top is floored at 3T\/n, the rule of three on the n\/T non-overlapping T-day windows/)
    expect(t.bootstrap.bandTopFloor).toMatch(/^3T touches of n/)
  })

  it('every band top is at least the rule of three on independent windows, 3T of n', () => {
    const days = Object.fromEntries(t.horizons.map((h) => [h.id, h.days]))
    for (const a of ASSETS)
      for (const d of DIRS)
        for (const h of HORIZON_IDS) {
          const r = t.assets[a][d][h]
          for (const hi of r.hi) expect(hi).toBeGreaterThanOrEqual(Math.min(r.n, 3 * days[h]))
        }
    // BTC 30d: ~1,963 daily origins are only ~65 windows that share no day. A 47% fall
    // never happened, and the band says so honestly: up to 3·30/1,963 = 4.6%, not 1%.
    const btc30 = t.assets.BTC.fall['30d']
    expect(btc30.touched[47 - 1]).toBe(0)
    expect(formatBand(btc30.lo[47 - 1], btc30.hi[47 - 1], btc30.n)).toBe('up to 5%')
  })

  it('n per horizon is t1’s row count per asset (calib + test)', () => {
    // results.json / the CSVs: calib 1012/1010/1006/999/983, test 1009/1007/1003/996/980.
    const want = { '1d': 2021, '3d': 2017, '7d': 2009, '14d': 1995, '30d': 1963 }
    for (const a of ASSETS) for (const d of DIRS) for (const h of HORIZON_IDS) expect(t.assets[a][d][h].n).toBe(want[h])
    expect(meanN(t, 'ETH', 'fall')).toBe(2000)
  })
})

describe('forecast table: internal consistency', () => {
  it('point and band are monotone non-increasing in the level', () => {
    for (const a of ASSETS)
      for (const d of DIRS)
        for (const h of HORIZON_IDS) {
          const r = t.assets[a][d][h]
          for (const xs of [r.touched, r.lo, r.hi]) for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeLessThanOrEqual(xs[i - 1])
        }
  })

  it('the band contains the point at every cell', () => {
    for (const a of ASSETS)
      for (const d of DIRS)
        for (const h of HORIZON_IDS) {
          const r = t.assets[a][d][h]
          r.touched.forEach((x, i) => {
            expect(r.lo[i]).toBeLessThanOrEqual(x)
            expect(x).toBeLessThanOrEqual(r.hi[i])
          })
        }
  })

  it('is non-decreasing in the horizon at every level (counts and chances)', () => {
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

  it('every confidence label follows the rule from its own checks', () => {
    for (const a of ASSETS)
      for (const d of DIRS)
        for (const h of HORIZON_IDS) {
          const c = t.assets[a][d][h].confidence
          expect(c.detail).toHaveLength(c.checks)
          expect(c.detail.filter((x) => x[7] === 1)).toHaveLength(c.held)
          for (const [level, cn, ct, clo, chi, tn, tt, holds] of c.detail) {
            expect(T1_LEVELS).toContain(level)
            expect(ct + tt).toBeGreaterThan(0)
            expect(holds).toBe(clo * tn <= tt * cn && tt * cn <= chi * tn ? 1 : 0)
          }
          expect(c.label).toBe(confidenceLabel(c.held, c.checks))
        }
  })
})

describe('the builder’s pure parts', () => {
  it('the label rule, as named constants', () => {
    expect(CONFIDENCE_RULE).toEqual({ highMinChecks: 4, mediumMinShare: 0.5 })
    expect(confidenceLabel(0, 0)).toBe('untested')
    expect(confidenceLabel(5, 5)).toBe('high')
    expect(confidenceLabel(4, 4)).toBe('high')
    expect(confidenceLabel(3, 3)).toBe('medium') // all held, but fewer than 4 checks
    expect(confidenceLabel(4, 5)).toBe('medium')
    expect(confidenceLabel(2, 4)).toBe('medium')
    expect(confidenceLabel(2, 5)).toBe('low')
    expect(confidenceLabel(0, 1)).toBe('low')
  })

  it('the PRNG is deterministic per seed', () => {
    const a = makeRng(BOOTSTRAP.seed)
    const b = makeRng(BOOTSTRAP.seed)
    const c = makeRng(1)
    const xs = Array.from({ length: 5 }, () => a.next())
    expect(Array.from({ length: 5 }, () => b.next())).toEqual(xs)
    expect(Array.from({ length: 5 }, () => c.next())).not.toEqual(xs)
    const r = makeRng(7)
    for (let i = 0; i < 1000; i++) {
      const v = r.int(17)
      expect(v >= 0 && v < 17 && Number.isInteger(v)).toBe(true)
    }
  })

  it('t1’s block scheme: max(30, 2T)-day blocks, ceil(N/b) per replicate', () => {
    const d7 = blockDraw(makeRng(1), 1003, 7, 10)
    expect(d7.b).toBe(30)
    expect(d7.nb).toBe(34)
    const d30 = blockDraw(makeRng(1), 980, 30, 10)
    expect(d30.b).toBe(60)
    expect(d30.nb).toBe(17)
    for (const s of d30.starts.flat()) expect(s >= 0 && s <= 980 - 60).toBe(true)
  })

  it('floors a band top at 3T, and never past n', () => {
    expect(bandTopFloor(30)).toBe(90)
    expect(floorBandTop([500, 120, 40, 0], 30, 1963)).toEqual([500, 120, 90, 90])
    expect(floorBandTop([2, 0], 1, 2021)).toEqual([3, 3])
    expect(floorBandTop([0], 30, 50)).toEqual([50])
  })

  it('a block never spans a seam (the purged 2024-01-01 gap)', () => {
    const d = blockDraw(makeRng(5), 200, 7, 50, [90])
    for (const st of d.starts.flat()) expect(st + d.b <= 90 || st >= 90).toBe(true)
    // Both sides are still drawn from.
    const flat = d.starts.flat()
    expect(flat.some((st) => st < 90) && flat.some((st) => st >= 90)).toBe(true)
  })

  it('touched counts and the band on a toy series', () => {
    expect(touchedCounts([0, 1, 3, 3]).slice(0, 4)).toEqual([3, 2, 2, 0])
    const deepest = Array.from({ length: 120 }, (_, i) => (i % 10 === 0 ? 5 : 0))
    const draw = blockDraw(makeRng(3), deepest.length, 1, 200)
    const { lo, hi } = bandFromDraw(draw, deepest)
    const pt = touchedCounts(deepest)
    expect(pt[4]).toBe(12)
    expect(lo[4]).toBeLessThanOrEqual(12)
    expect(hi[4]).toBeGreaterThanOrEqual(12)
    expect(lo[5]).toBe(0)
    expect(hi[5]).toBe(0)
  })

  it('the t1 cross-check fails loudly on a changed truth', () => {
    const ours = { ETH: { 1: [{ t0: 1616630400, split: 'calib', S: 100, fall: 6, rise: 0 }] } }
    const rows = parseT1Csv('kind,asof,asset,T,k,S,L,y_oracle\nretrospective,2021-03-25T00:00:00Z,ETH,1,-0.05,100,95,1\n')
    expect(crossCheckT1(rows, ours).rowsCompared).toBe(1)
    const bad = parseT1Csv('kind,asof,asset,T,k,S,L,y_oracle\nretrospective,2021-03-25T00:00:00Z,ETH,1,-0.05,100,95,0\n')
    expect(() => crossCheckT1(bad, ours)).toThrow(/y_oracle/)
  })
})

describe('forecast lookup', () => {
  it('floors the distance toward risk (the larger chance), with its band and confidence', () => {
    const at27 = touchAt(t, 'ETH', 'fall', '7d', 0.2799)
    const at28 = touchAt(t, 'ETH', 'fall', '7d', 0.28)
    expect(at27?.level).toBe(27)
    expect(at28?.level).toBe(28)
    expect(at27!.touched).toBeGreaterThanOrEqual(at28!.touched)
    expect(at27).toMatchObject({ asset: 'ETH', direction: 'fall', horizon: '7d' })
    expect(at27!.loPct).toBeLessThanOrEqual(at27!.pct)
    expect(at27!.hiPct).toBeGreaterThanOrEqual(at27!.pct)
    expect(at27!.confidence).toMatchObject({ source: 't1-span-check', preliminary: true })
    expect(at27!.confidence!.basis).toMatch(/^held in \d of \d checks$/)
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

  it('a curve is one point per whole level', () => {
    const c = touchCurve(t, 'ETH', 'fall', '7d', 5, 30)
    expect(c.map((x) => x.level)).toEqual(Array.from({ length: 26 }, (_, i) => i + 5))
    expect(touchCurve(t, 'ETH', 'fall', '7d', 58, 65).map((x) => x.level)).toEqual([58, 59, 60])
    expect(touchByHorizon(t, 'BTC', 'rise', 0.1).map((r) => r.horizon)).toEqual(HORIZON_IDS)
  })

  it('formats a chance up and a band outward, and never shows 0%', () => {
    expect(formatChance(0, 2009)).toBe('<1%') // zero touches is not a zero chance
    expect(formatChance(1, 2009)).toBe('<1%')
    expect(formatChance(488, 2009)).toBe('25%') // 24.29% rounds up
    expect(formatChance(50, 1000)).toBe('5%') // exact, not bumped
    expect(formatBand(41, 59, 200)).toBe('20–30%') // 20.5 floored, 29.5 ceiled
    expect(formatBand(1, 3, 2009)).toBe('up to 1%')
    expect(formatBand(0, 40, 2009)).toBe('up to 2%')
    // No touches anywhere: the top is the rule of three, 3/n, rounded up — never 0.
    expect(formatBand(0, 0, 2009)).toBe('up to 1%')
    expect(bandTopPct(0, 200)).toBe(2)
    expect(() => formatChance(1, 0)).toThrow()
    // Nothing in the whole table formats to a "0".
    for (const a of ASSETS)
      for (const d of DIRS)
        for (const h of HORIZON_IDS) {
          const r = t.assets[a][d][h]
          r.touched.forEach((x, i) => {
            expect(formatChance(x, r.n)).not.toMatch(/^0/)
            expect(formatBand(r.lo[i], r.hi[i], r.n)).not.toMatch(/(^|\D)0%|^0/)
          })
        }
  })

  it('states the confidence with its basis and "preliminary"', () => {
    const c = confidenceOf(t, 'ETH', 'fall', '7d')
    expect(confidenceLine(c)).toMatch(/^Confidence: (high|medium|low|untested) · (held in \d of \d checks|no checks) · preliminary$/)
    expect(confidenceLine(null)).toBeNull()
    expect(confidenceLine({ ...c, label: 'untested', basis: 'no checks' })).toBe('Confidence: untested · no checks · preliminary')
  })

  it('tests a target in integers', () => {
    expect(atOrBelow(50, 1000, 5)).toBe(true)
    expect(atOrBelow(51, 1000, 5)).toBe(false)
  })

  it('goes STALE one longest horizon after the data ends', () => {
    const end = Date.parse(t.period.dataEnd)
    expect(STALE_AFTER_DAYS).toBe(30)
    expect(isStale(t, end + 29 * 86_400_000)).toBe(false)
    expect(isStale(t, end + 31 * 86_400_000)).toBe(true)
  })
})

// --------------------------------------------------------------------- recompute

const DATASETS = resolve(process.env.MEMBRANE_DATASETS_DIR ?? join(process.cwd(), '..', 'membrane-datasets'))
const PH = join(DATASETS, 'price-history')
const T1 = join(DATASETS, 'validation', 't1')
const has = existsSync(join(PH, 'eth-usd-1h.json')) && existsSync(join(T1, 'forecasts-test.csv.gz'))

interface Series {
  startTs: number
  columns: Record<string, (number | null)[]>
}

/** An independent, deliberately naive recompute of one cell on t1's rows. */
function naiveCell(s: Series, dir: 'fall' | 'rise', days: number, L: number) {
  const CS = Date.UTC(2021, 2, 25) / 1000
  const SP = Date.UTC(2024, 0, 1) / 1000
  const TE = Date.UTC(2026, 9, 6, 3) / 1000
  const idx = (ts: number) => (ts - s.startTs) / 3600
  let n = 0
  let touched = 0
  for (let t0 = CS; t0 + 86400 <= TE; t0 += 86400) {
    const end = t0 + days * 86400
    if (t0 < SP ? end > SP : end > TE) continue
    const S = s.columns.oracle[idx(t0 - 3600)]!
    const w = (dir === 'fall' ? s.columns.oracleLow : s.columns.oracleHigh).slice(idx(t0), idx(end - 3600) + 1) as number[]
    n++
    if (dir === 'fall' ? Math.min(...w) <= S * (1 - L / 100) : Math.max(...w) >= S * (1 + L / 100)) touched++
  }
  return { n, touched }
}

describe.skipIf(!has)('forecast table: against the datasets', () => {
  const load = (dir: string, f: string) => readFileSync(join(dir, f))
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
  const ethBuf = has ? load(PH, 'eth-usd-1h.json') : (null as never)
  const btcBuf = has ? load(PH, 'btc-usd-1h.json') : (null as never)
  const eth = has ? (JSON.parse(ethBuf.toString('utf8')) as Series) : (null as never)
  const btc = has ? (JSON.parse(btcBuf.toString('utf8')) as Series) : (null as never)

  it('was built from these exact files', () => {
    expect(t.source.sha256['price-history/eth-usd-1h.json']).toBe(sha(ethBuf))
    expect(t.source.sha256['price-history/btc-usd-1h.json']).toBe(sha(btcBuf))
    for (const f of ['forecasts-calib.csv.gz', 'forecasts-test.csv.gz']) {
      expect(t.source.sha256[`validation/t1/${f}`]).toBe(sha(load(T1, f)))
    }
  })

  it('equals the frequency of t1’s y_oracle at every t1 level and horizon (calib + test)', () => {
    const rows = ['forecasts-calib.csv.gz', 'forecasts-test.csv.gz'].flatMap((f) =>
      parseT1Csv(gunzipSync(load(T1, f)).toString('utf8')),
    )
    for (const a of ASSETS)
      for (const h of t.horizons) {
        for (const L of T1_LEVELS) {
          const cell = rows.filter((r) => r.asset === a && r.T === h.days && Math.round(-r.k * 100) === L)
          const r = t.assets[a].fall[h.id]
          expect(cell.length).toBe(r.n)
          expect(cell.reduce((s, x) => s + x.y, 0)).toBe(r.touched[L - 1])
        }
      }
  })

  const cells: [HistoryAsset, 'fall' | 'rise', (typeof HORIZON_IDS)[number], number, number][] = [
    ['ETH', 'fall', '7d', 7, 27],
    ['ETH', 'fall', '1d', 1, 3],
    ['ETH', 'rise', '30d', 30, 40],
    ['BTC', 'fall', '14d', 14, 22],
    ['BTC', 'rise', '3d', 3, 8],
  ]
  it.each(cells)('%s %s %s at %i%% (off t1’s levels) matches a naive recompute', (asset, dir, h, days, L) => {
    const want = naiveCell(asset === 'ETH' ? eth : btc, dir, days, L)
    const got = t.assets[asset][dir][h]
    expect(got.n).toBe(want.n)
    expect(got.touched[L - 1]).toBe(want.touched)
  })
})
