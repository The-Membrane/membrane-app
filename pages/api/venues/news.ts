import type { NextApiRequest, NextApiResponse } from 'next'

import { sql } from 'drizzle-orm'

import { db } from '@/db'
import { loadWireFrames } from '@/lib/venueWire/load'
import { buildWire, parseWireQuery, QueryError, type WireQuery } from '@/lib/venueWire/service'
import type { WireFrames } from '@/lib/venueWire/series'

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
//
// THE WIRE (board Q13; design/DESIGN_RULES.md §5b) — Membrane's own venue news:
// anomalies against each venue's own measured history, as deterministic templated
// one-line stories with three labels (measured change, observed driver, possible
// leading signal), ranked by impact on risk or reward. No database: it reads the
// private datasets repo (lib/venueWire/load.ts, board rule N18).
//
// GET ?view=wire       → ranked stories in the window that ends at asOf
//     [&asOf=<unix s | ISO>]   evaluation time; default = the newest venue reading
//     [&venue=<id>]            a venue-stress id (aave-core-usdc) or asset (eth, steth,
//                              usdc, usde): its stories and the asset stories that move it
//     [&limit=1..100]          default 20
// GET ?view=baselines  → each series judged at asOf: percentile bands and
//                        "lowest / highest since" (the instrument panel behind the stories)
//
// A story with `stale: true` comes from an input older than the stale limit: a client
// hatches it and suppresses its headline (§4). `uncovered` lists every series that gave
// no verdict, so a quiet wire never reads as all-clear. Cached s-maxage 300.

export type VenueNewsItem = {
  venue: string
  title: string
  source: string
  url: string
  publishedAt: string | null
  fetchedAt: string
}

const PER_VENUE = 15

// Detection over the full history takes a few hundred ms: memoize per query and
// 5-minute bucket, and drop the memo when the input files change.
let wireMemo: { frames: WireFrames; bodies: Map<string, unknown> } | null = null
const WIRE_MEMO_MAX = 32

function wireBody(q: WireQuery, now: number): unknown {
  const frames = loadWireFrames()
  if (wireMemo?.frames !== frames) wireMemo = { frames, bodies: new Map() }
  const key = JSON.stringify([
    q.view,
    q.asOf ?? null,
    q.venue ?? null,
    q.limit,
    Math.floor(now / 300),
  ])
  const hit = wireMemo.bodies.get(key)
  if (hit) return hit
  const body = buildWire(frames, q, { now })
  if (wireMemo.bodies.size >= WIRE_MEMO_MAX) wireMemo.bodies.clear()
  wireMemo.bodies.set(key, body)
  return body
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' })

  if (req.query.view !== undefined) {
    let q: WireQuery
    try {
      q = parseWireQuery(req.query)
    } catch (e) {
      if (e instanceof QueryError) return res.status(400).json({ error: e.message })
      throw e
    }
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600')
    return res.status(200).json(wireBody(q, Math.floor(Date.now() / 1000)))
  }

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
