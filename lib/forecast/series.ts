/**
 * Hourly price series: decode the committed compact files (public/data/forecast/<SYMBOL>-1h.json,
 * built by scripts/forecast/build-price-series.mjs) and append live Binance klines.
 */
import type { PriceSeries } from './types'

export const HOUR = 3600

/** The committed file format (membrane-forecast-series/1). */
export interface CompactSeries {
  schema: 'membrane-forecast-series/1'
  id: string
  source: string
  startTs: number
  stepSeconds: number
  count: number
  scale: number
  lastOpenIso: string
  provenance?: unknown
  close: (number | null)[]
  lowOff: (number | null)[]
  highOff: (number | null)[]
}

export function decodeCompactSeries(c: CompactSeries): PriceSeries {
  if (c.schema !== 'membrane-forecast-series/1') throw new Error(`unknown series schema ${String(c.schema)}`)
  if (c.stepSeconds !== HOUR) throw new Error('series must be hourly')
  const n = c.close.length
  const close: (number | null)[] = new Array(n)
  const low: (number | null)[] = new Array(n)
  const high: (number | null)[] = new Array(n)
  let prev: number | null = null
  for (let j = 0; j < n; j++) {
    const d = c.close[j]
    if (d === null || d === undefined) { close[j] = null; low[j] = null; high[j] = null; continue }
    const cents: number = prev === null ? d : prev + d
    prev = cents
    // integer cents / scale: the same double as parsing Binance's decimal text
    close[j] = cents / c.scale
    low[j] = (cents - (c.lowOff[j] as number)) / c.scale
    high[j] = (cents + (c.highOff[j] as number)) / c.scale
  }
  return { id: c.id, source: c.source, startTs: c.startTs, close, low, high, fetchedAt: c.lastOpenIso }
}

/** A Binance kline row: [openTimeMs, open, high, low, close, volume, closeTimeMs, ...]. */
export type BinanceKline = [number, string, string, string, string, string, number, ...unknown[]]

/**
 * Append CLOSED klines after the series end (an open kline is never appended; a missing hour stays null).
 * Klines at or before the last series hour are ignored: committed history is never overridden.
 */
export function appendKlines(s: PriceSeries, klines: BinanceKline[], nowMs: number, fetchedAt?: string): PriceSeries {
  const close = Array.from(s.close)
  const low = Array.from(s.low)
  const high = Array.from(s.high)
  for (const k of klines) {
    const o = Number(k[0]) / 1000
    if (Number(k[6]) >= nowMs) continue
    const j = (o - s.startTs) / HOUR
    if (!Number.isInteger(j) || j < close.length) continue
    while (close.length < j) { close.push(null); low.push(null); high.push(null) }
    close.push(Number(k[4])); low.push(Number(k[3])); high.push(Number(k[2]))
  }
  return { ...s, close, low, high, fetchedAt: fetchedAt ?? s.fetchedAt }
}

/** Open time (unix s) of the first hour after the series. */
export function seriesEndTs(s: PriceSeries): number {
  return s.startTs + HOUR * s.close.length
}

/** Float64 views with NaN for missing values (what the model reads). */
export function toFloat(a: ArrayLike<number | null>, n = a.length): Float64Array {
  const out = new Float64Array(n)
  for (let j = 0; j < n; j++) {
    const v = j < a.length ? a[j] : null
    out[j] = v === null || v === undefined ? NaN : v
  }
  return out
}
