import type { NextApiRequest, NextApiResponse } from 'next'

import { sql } from 'drizzle-orm'

import { db } from '@/db'

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

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' })

  const venueParam = typeof req.query.venue === 'string' ? req.query.venue : undefined

  // NULLS LAST so a missing pubDate never floats to the top of the feed.
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
  return res.status(200).json({ items })
}
