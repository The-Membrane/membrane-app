/**
 * The live tail for "now": closed Binance hourly klines after the committed series ends.
 * Free public endpoint, no key: https://data-api.binance.vision/api/v3/klines (the D12 live definition's source).
 * Used by pages/api/forecast/klines (server, cached) and by loadSeries (client).
 */
import { appendKlines, decodeCompactSeries, HOUR, seriesEndTs, type BinanceKline, type CompactSeries } from './series'
import type { PriceSeries } from './types'

export const BINANCE_KLINES = 'https://data-api.binance.vision/api/v3/klines'
export const FORECAST_SYMBOLS = ['ETHUSDT', 'BTCUSDT'] as const
export type ForecastSymbol = (typeof FORECAST_SYMBOLS)[number]
/** At most this many hours of tail per request (the committed series is refreshed by the build script). */
export const MAX_TAIL_HOURS = 24 * 120

export function isForecastSymbol(s: string): s is ForecastSymbol {
  return (FORECAST_SYMBOLS as readonly string[]).includes(s)
}

/** Fetch closed hourly klines opening at or after sinceTs (unix s). Pages of 1,000. */
export async function fetchKlineTail(
  symbol: ForecastSymbol, sinceTs: number, fetchFn: typeof fetch = fetch, nowMs: number = Date.now(),
): Promise<BinanceKline[]> {
  const from = Math.max(sinceTs, Math.floor(nowMs / 1000) - MAX_TAIL_HOURS * HOUR)
  const out: BinanceKline[] = []
  let start = Math.floor(from / HOUR) * HOUR * 1000
  for (let page = 0; page < 4; page++) {
    const url = `${BINANCE_KLINES}?symbol=${symbol}&interval=1h&startTime=${start}&limit=1000`
    const r = await fetchFn(url, { headers: { accept: 'application/json' } })
    if (!r.ok) throw new Error(`binance klines ${symbol}: HTTP ${r.status}`)
    const data = (await r.json()) as unknown
    if (!Array.isArray(data)) throw new Error(`binance klines ${symbol}: unexpected response`)
    const rows = (data as BinanceKline[]).filter((k) => Number(k[6]) < nowMs)
    out.push(...rows)
    if (data.length < 1000 || rows.length === 0) break
    start = Number(rows[rows.length - 1][0]) + HOUR * 1000
  }
  return out
}

/**
 * Browser or server: the committed series (public/data/forecast/<SYMBOL>-1h.json), optionally extended with the
 * live tail from the API route. Returns the series and a provenance stamp for "source · fetched HH:MM".
 */
export async function loadSeries(
  symbol: ForecastSymbol,
  opts: { live?: boolean; baseUrl?: string; fetchFn?: typeof fetch } = {},
): Promise<{ series: PriceSeries; stamp: { source: string; through: string; fetchedAt: string | null; live: boolean } }> {
  const f = opts.fetchFn ?? fetch
  const base = opts.baseUrl ?? ''
  const r = await f(`${base}/data/forecast/${symbol}-1h.json`)
  if (!r.ok) throw new Error(`forecast series ${symbol}: HTTP ${r.status}`)
  let series = decodeCompactSeries((await r.json()) as CompactSeries)
  let fetchedAt: string | null = null
  let live = false
  if (opts.live) {
    try {
      const t = await f(`${base}/api/forecast/klines?symbol=${symbol}&since=${seriesEndTs(series)}`)
      if (t.ok) {
        const body = (await t.json()) as { klines: BinanceKline[]; fetchedAt: string }
        series = appendKlines(series, body.klines, Date.now(), body.fetchedAt)
        fetchedAt = body.fetchedAt
        live = true
      }
    } catch {
      // the committed series still works; the stamp says it is not live
    }
  }
  const through = new Date((seriesEndTs(series) - HOUR) * 1000).toISOString().replace('.000Z', 'Z')
  return { series, stamp: { source: 'Binance spot 1h klines', through, fetchedAt, live } }
}
