/**
 * GET /api/forecast/klines?symbol=ETHUSDT&since=<unix s>
 *
 * Closed Binance spot hourly klines from `since` (normally the end of the committed series in
 * public/data/forecast/), for forecasts "from now". Free public endpoint, no key
 * (data-api.binance.vision). Cached in memory for 5 minutes per (symbol, hour) and at the edge.
 * `since` is clamped to [now - 120 d, now] before the cache key is built; a future `since` is rejected.
 */
import type { NextApiRequest, NextApiResponse } from 'next'
import { clampSince, fetchKlineTail, isForecastSymbol } from '@/lib/forecast/live'
import type { BinanceKline } from '@/lib/forecast/series'

const TTL_MS = 5 * 60 * 1000
const cache = new Map<string, { at: number; klines: BinanceKline[]; fetchedAt: string }>()

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET'])
    return res.status(405).json({ error: `Method ${req.method} Not Allowed` })
  }
  const symbol = String(req.query.symbol ?? '')
  const since = Number(req.query.since)
  if (!isForecastSymbol(symbol)) return res.status(400).json({ error: 'symbol must be ETHUSDT or BTCUSDT' })
  const c = clampSince(since, Date.now())
  if ('error' in c) return res.status(400).json({ error: c.error })
  const key = `${symbol}:${Math.floor(c.since / 3600)}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) {
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600')
    return res.status(200).json({ symbol, source: 'binance:spot:1h', fetchedAt: hit.fetchedAt, klines: hit.klines, cached: true })
  }
  try {
    const klines = await fetchKlineTail(symbol, c.since)
    const fetchedAt = new Date().toISOString()
    cache.set(key, { at: Date.now(), klines, fetchedAt })
    if (cache.size > 64) cache.delete(cache.keys().next().value as string)
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600')
    return res.status(200).json({ symbol, source: 'binance:spot:1h', fetchedAt, klines, cached: false })
  } catch (e) {
    return res.status(502).json({ error: e instanceof Error ? e.message : 'upstream error' })
  }
}
