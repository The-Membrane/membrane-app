import fs from 'node:fs'
import path from 'node:path'
import { decodeCompactSeries, type CompactSeries } from '@/lib/forecast/series'
import type { PriceSeries } from '@/lib/forecast/types'

const cache = new Map<string, PriceSeries>()
/** The committed series (public/data/forecast/<SYMBOL>-1h.json), decoded once per test file. */
export function committed(sym: 'ETHUSDT' | 'BTCUSDT'): PriceSeries {
  let s = cache.get(sym)
  if (!s) {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../public/data/forecast', `${sym}-1h.json`), 'utf8')) as CompactSeries
    s = decodeCompactSeries(raw)
    cache.set(sym, s)
  }
  return s
}

/** The same series cut at an origin (bars that open before it), like the reference grid. */
export function cutAt(s: PriceSeries, originTs: number): PriceSeries {
  const n = (originTs - s.startTs) / 3600
  return { ...s, close: Array.from(s.close).slice(0, n), low: Array.from(s.low).slice(0, n), high: Array.from(s.high).slice(0, n) }
}
