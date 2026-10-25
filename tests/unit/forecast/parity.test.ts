/**
 * Parity: the TS raw (fH) port against the Python reference (membrane-app research/history-forecasts
 * live/q26_live_d12.py series_origin, float32), stored in tests/unit/fixtures/forecast/fh-parity.json:
 *  - 176 reference rows (11 origins incl. the Oct 10-11 2025 window, ETH/BTC, 1 h-30 d, 8 levels), and
 *  - 10 rows of the PUBLISHED D12 live issue of 2026-10-25 (dev grid + live kline store).
 * Tolerance: 0. Every TS value, rounded to float32 like the reference, must equal the reference exactly.
 */
import { describe, expect, it } from 'vitest'
import fixture from '../fixtures/forecast/fh-parity.json'
import { FhSeriesModel } from '@/lib/forecast/fh'
import { committed, cutAt } from './helpers'

type Row = { origin: string; originTs: number; symbol: 'ETHUSDT' | 'BTCUSDT'; T: number; S: number; fH: number[]; f: number[]; a: number[]; fallback: boolean }
const L8 = fixture.levels as number[]

function compare(rows: Row[], cut: boolean) {
  const full = { ETHUSDT: new FhSeriesModel(committed('ETHUSDT')), BTCUSDT: new FhSeriesModel(committed('BTCUSDT')) }
  let n = 0; let exact = 0; let maxDiff = 0
  const bad: string[] = []
  for (const r of rows) {
    const m = cut ? new FhSeriesModel(cutAt(committed(r.symbol), r.originTs)) : full[r.symbol]
    const p = m.predict(r.originTs, r.T, L8)
    if ('error' in p) { bad.push(`${r.origin} ${r.symbol} ${r.T}: ${p.error}`); continue }
    expect(p.spot).toBe(r.S)
    expect(p.fallback).toBe(r.fallback)
    for (const name of ['fH', 'f', 'a'] as const) {
      for (let j = 0; j < L8.length; j++) {
        n++
        const d = Math.abs(Math.fround(p[name][j]) - r[name][j])
        if (d === 0) exact++
        maxDiff = Math.max(maxDiff, d)
        if (d !== 0) bad.push(`${r.origin} ${r.symbol} ${r.T}h ${name}[${L8[j]}] ts ${p[name][j]} ref ${r[name][j]}`)
      }
    }
  }
  return { n, exact, maxDiff, bad }
}

describe('raw (fH) parity with the Python reference', () => {
  it('matches 176 reference rows on the full committed series (no look-ahead: same as the cut grid)', () => {
    const res = compare(fixture.rows as Row[], false)
    console.log(`parity reference: ${res.exact}/${res.n} exact at float32, max |diff| ${res.maxDiff.toExponential(2)}`)
    expect(res.bad).toEqual([])
    expect(res.n).toBe(176 * 3 * 8)
  }, 120_000)

  it('matches the published D12 live issue of 2026-10-25', () => {
    const res = compare(fixture.published.rows as Row[], false)
    console.log(`parity published: ${res.exact}/${res.n} exact at float32, max |diff| ${res.maxDiff.toExponential(2)}`)
    expect(res.bad).toEqual([])
  }, 120_000)

  it('gives identical values on a series cut at the origin (no look-ahead)', () => {
    const rows = (fixture.rows as Row[]).filter((r) => r.origin.startsWith('2025-10-1') && (r.T === 6 || r.T === 72 || r.T === 168))
    expect(rows.length).toBeGreaterThan(10)
    const full = { ETHUSDT: new FhSeriesModel(committed('ETHUSDT')), BTCUSDT: new FhSeriesModel(committed('BTCUSDT')) }
    for (const r of rows) {
      const cut = new FhSeriesModel(cutAt(committed(r.symbol), r.originTs)).predict(r.originTs, r.T, L8)
      const all = full[r.symbol].predict(r.originTs, r.T, L8)
      if ('error' in cut || 'error' in all) throw new Error('not issued')
      // full float64 values, not just counts
      expect(cut.fH).toEqual(all.fH)
      expect(cut.f).toEqual(all.f)
      expect(cut.a).toEqual(all.a)
      expect(cut.sigmaH).toBe(all.sigmaH)
      expect(cut.spot).toBe(all.spot)
    }
  }, 120_000)
})
