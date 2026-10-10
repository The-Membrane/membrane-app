import type { NextApiRequest, NextApiResponse } from 'next'

import { sql } from 'drizzle-orm'

import { db } from '@/db'
import { readLocalNews, selectLocalNews } from '@/scripts/lib/venueNewsLocalStore.mjs'

// PUBLIC. The VENUE NEWS feed — raw external headlines for the carry venues
// Membrane offers, fetched from Google News RSS by scripts/fetch-venue-news.mjs.
// This is INFORMATION, not endorsement: title/source/url/date are served
// VERBATIM as stored — no summarization, no sentiment, no scoring, no LLM.
//
// GET ?venue=<name>  → newest 15 headlines for that one venue.
// GET (no venue)     → newest 15 headlines PER venue (window function), so the
//                      UI can populate every venue chip in a single request.
//
// Ordered newest-first by the article's own pubDate (published_at), falling back
// to when we fetched it. Cached s-maxage 900 (15 min) — the fetcher runs on the
// hourly recorder tick, so a stale-ish edge cache is fine.

export type VenueNewsItem = {
  venue: string
  title: string
  source: string
  url: string
  publishedAt: string | null
  fetchedAt: string
}

const PER_VENUE = 15
const LOCAL_MAX_AGE_MS = 3 * 60 * 60 * 1_000
const LOCAL_FUTURE_SKEW_MS = 5 * 60 * 1_000
const isFresh = (timestamp: string, now: number) => {
  const observed = Date.parse(timestamp)
  return observed >= now - LOCAL_MAX_AGE_MS && observed <= now + LOCAL_FUTURE_SKEW_MS
}
const isLocalDevelopment = (req: NextApiRequest) =>
  process.env.NODE_ENV === 'development' &&
  (req.socket?.remoteAddress === '127.0.0.1' ||
    req.socket?.remoteAddress === '::1' ||
    req.socket?.remoteAddress === '::ffff:127.0.0.1')

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' })

  const venueParam = typeof req.query.venue === 'string' ? req.query.venue : undefined
  if (venueParam !== undefined && venueParam.length > 128)
    return res.status(400).json({ error: 'Invalid venue' })

  // NULLS LAST so a missing pubDate never floats to the top of the feed.
  try {
    const result = venueParam
      ? await db.execute(sql`
        SELECT venue, title, source, url, published_at, fetched_at
        FROM venue_news
        WHERE venue = ${venueParam}
        ORDER BY published_at DESC NULLS LAST, fetched_at DESC
        LIMIT ${PER_VENUE}`)
      : await db.execute(sql`
        SELECT venue, title, source, url, published_at, fetched_at
        FROM (
          SELECT venue, title, source, url, published_at, fetched_at,
                 ROW_NUMBER() OVER (
                   PARTITION BY venue
                   ORDER BY published_at DESC NULLS LAST, fetched_at DESC
                 ) AS rn
          FROM venue_news
        ) ranked
        WHERE rn <= ${PER_VENUE}
        ORDER BY published_at DESC NULLS LAST, fetched_at DESC`)

    const items: VenueNewsItem[] = (result.rows as any[]).map((r) => ({
      venue: r.venue as string,
      title: r.title as string,
      source: r.source as string,
      url: r.url as string,
      publishedAt: r.published_at ? new Date(r.published_at as string).toISOString() : null,
      fetchedAt: new Date(r.fetched_at as string).toISOString(),
    }))

    res.setHeader('Cache-Control', 'public, s-maxage=900, stale-while-revalidate=1800')
    return res
      .status(200)
      .json({ items, provenance: { storage: 'database', feed: 'google_news_rss_search' } })
  } catch {
    if (!isLocalDevelopment(req)) return res.status(503).json({ error: 'venue_news_unavailable' })
    try {
      const snapshot = readLocalNews()
      const now = Date.now()
      if (!snapshot.updatedAt || !isFresh(snapshot.updatedAt, now))
        return res.status(503).json({ error: 'venue_news_unavailable' })
      const items: VenueNewsItem[] = selectLocalNews(snapshot, {
        venue: venueParam,
        perVenue: PER_VENUE,
        fetchedAfter: new Date(now - LOCAL_MAX_AGE_MS).toISOString(),
        fetchedBefore: new Date(now + LOCAL_FUTURE_SKEW_MS).toISOString(),
      }).filter((item: VenueNewsItem) => isFresh(item.fetchedAt, now))
      if (items.length === 0) return res.status(503).json({ error: 'venue_news_unavailable' })
      res.setHeader('Cache-Control', 'no-store')
      return res.status(200).json({
        items,
        provenance: {
          storage: 'local_mac_recorder',
          feed: 'google_news_rss_search',
          snapshotUpdatedAt: snapshot.updatedAt,
          maxAgeSeconds: LOCAL_MAX_AGE_MS / 1_000,
          coverageStatus: 'unavailable',
          pollReceiptBinding: 'not_verified',
        },
      })
    } catch {
      return res.status(503).json({ error: 'venue_news_unavailable' })
    }
  }
}
