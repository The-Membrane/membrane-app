import type { NextApiRequest, NextApiResponse } from 'next'
import { isAddress, getAddress } from 'viem'
import { sql } from 'drizzle-orm'

import { db } from '@/db'
import { heldVenues, matchAlerts, toRss, type AlarmLike, type WatchLike } from '@/components/Radar/alertLogic'
import { footerFor, uncoveredByVenue } from '@/pages/api/_lib/uncovered'
import { deepLink } from '@/components/Radar/telegramLogic'

// GET /api/radar/alerts/[address] — PER-ADDRESS VENUE ALERTS.
// GET /api/radar/alerts/[address]?format=rss — the same, as a subscribable feed.
//
// The join of two tables the recorder already writes: strat_watches (what the
// address holds) × venue_alarms (what just fired, written each tick by
// scripts/check-venue-alarms.mjs). No chain reads, no new signal, no new table.
// Only WATCHED addresses have alerts — "Track this address" on Radar is the
// subscribe step, and the feed needs no account or personal data.
//
// PUBLIC and read-only. Tracking is already public (the Strats board lists every
// watched address), so exposing which alarms touch a watched address reveals
// nothing the board does not.

const SITE = process.env.NEXT_PUBLIC_SITE_URL || 'https://membrane.money'
const CHAIN = 'ethereum'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' })
  const raw = req.query.address
  if (typeof raw !== 'string' || !isAddress(raw)) return res.status(400).json({ error: 'invalid address' })
  const address = getAddress(raw)

  const watchRes = await db.execute(sql`
    SELECT created_at AS "createdAt", entry_positions AS "entryPositions", last_scanned AS "lastScanned"
    FROM strat_watches WHERE address = ${address} LIMIT 1`)
  const w = (watchRes.rows as any[])[0]
  if (!w) {
    return res.status(404).json({ error: 'not tracked', hint: 'track this address on Radar to receive alerts' })
  }
  const watch: WatchLike = {
    createdAt: new Date(w.createdAt).toISOString(),
    entryPositions: Array.isArray(w.entryPositions) ? w.entryPositions : null,
    lastScanned: w.lastScanned ?? null,
  }
  const held = heldVenues(watch)

  // The alarm table is small (dedupe-while-open, one row per fired condition):
  // pull open + cleared-since-watch and let the pure matcher do the routing.
  const alarmRes = await db.execute(sql`
    SELECT venue, kind, severity, evidence, fired_at AS "firedAt", cleared_at AS "clearedAt"
    FROM venue_alarms
    WHERE cleared_at IS NULL OR cleared_at >= ${watch.createdAt}`)
  const alarms: AlarmLike[] = (alarmRes.rows as any[]).map((r) => ({
    venue: r.venue,
    kind: r.kind,
    severity: r.severity,
    evidence: r.evidence ?? null,
    firedAt: new Date(r.firedAt).toISOString(),
    clearedAt: r.clearedAt ? new Date(r.clearedAt).toISOString() : null,
  }))
  const { open, recent } = matchAlerts(held, alarms, watch.createdAt)
  // Blind spots for exactly the venues this address holds (one source: coverageFor).
  const footer = held.length ? footerFor(await uncoveredByVenue(held)) : 'no held venues: nothing to watch'

  const radarUrl = `${SITE}/${CHAIN}/radar?address=${address}`
  const feedUrl = `${SITE}/api/radar/alerts/${address}?format=rss`
  // Telegram subscribe deep link (MOAT step 7) — null while the alerts bot env is
  // unset, so the "telegram" link stays hidden until the bot exists.
  const botUser = process.env.TELEGRAM_ALERTS_BOT_USERNAME
  const telegramLink =
    process.env.TELEGRAM_ALERTS_BOT_TOKEN && botUser ? deepLink(botUser, address) : null

  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600')
  if (req.query.format === 'rss') {
    res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8')
    return res
      .status(200)
      .send(toRss({ address, radarUrl, feedUrl, open, recent, footer }))
  }
  return res.status(200).json({
    address,
    watched_since: watch.createdAt,
    held,
    open,
    recent,
    feed_url: feedUrl,
    telegram_link: telegramLink,
    uncovered: footer,
  })
}
