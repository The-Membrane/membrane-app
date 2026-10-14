import type { NextApiRequest, NextApiResponse } from 'next'

import { feedJson, feedRss, managePath } from '@/lib/userAlerts/feed'
import { FEED_TOKEN_RE, UUID_RE } from '@/lib/userAlerts/metrics'
import { clientIp, createRateLimiter, type RateLimiter } from '@/lib/userAlerts/rateLimit'
import { evaluateOwner, type EvaluateDeps } from '@/lib/userAlerts/service'
import { ownerByToken, stopThreshold, type Sql } from '@/lib/userAlerts/store'
import { liveSources, readValues } from '@/lib/userAlerts/values'
import { feedPath, neonSql, processEnv, siteUrl, type Env } from '@/pages/api/_lib/userAlerts'

// GET    /api/alerts/feed/[token]              this owner's thresholds + events (JSON)
// GET    /api/alerts/feed/[token]?format=rss   the same as RSS 2.0 — the subscription
// DELETE /api/alerts/feed/[token]?id=<uuid>    stop one of this owner's thresholds
//
// The token (32 random bytes, hex) is the capability: it is the ONLY way any
// threshold is ever returned. An unknown token is a plain 404.
//
// EVALUATE ON READ, no schedule: each GET reads the current values, records
// crossed/cleared transitions (compare-and-set, idempotent per transition) and
// returns the result. A stale or unavailable value is not evaluated and the feed
// says so. private, no-store: an owner's feed is never cached by a shared cache.
//
// ORDER: a malformed token is a 404 before anything else (no DB call); then two
// rate limits — per IP (bounds token-guessing and DB load) and per IP + token
// (bounds how often one reader can make one feed evaluate) — then the DB.

export type FeedDeps = {
  env: Env
  sql: () => Sql
  readValues: (sql: () => Sql) => EvaluateDeps['readValues']
  limits: { ip: RateLimiter; feed: RateLimiter }
  nowMs?: () => number
}

const tokenOf = (req: NextApiRequest): string => {
  const raw = req.query.token
  return (Array.isArray(raw) ? raw[0] : raw ?? '').toLowerCase()
}

export const createFeedHandler = (deps: FeedDeps) => async (req: NextApiRequest, res: NextApiResponse): Promise<void> => {
  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader('X-Robots-Tag', 'noindex')
  if (req.method !== 'GET' && req.method !== 'DELETE') {
    res.setHeader('Allow', 'GET, DELETE')
    return res.status(405).json({ error: 'GET or DELETE only' })
  }
  const token = tokenOf(req)
  if (!FEED_TOKEN_RE.test(token)) return res.status(404).json({ error: 'unknown feed' })
  const ip = clientIp(req)
  // Both limiters always count (no short-circuit), so neither can be bypassed via the other.
  const ipOver = deps.limits.ip(ip)
  const feedOver = deps.limits.feed(`${ip}|${token}`)
  if (ipOver || feedOver) {
    res.setHeader('Retry-After', '60')
    return res.status(429).json({ error: 'slow down' })
  }
  if (!deps.env('DATABASE_URL')) return res.status(503).json({ error: 'alerts storage unavailable' })

  const sql = deps.sql()
  try {
    const owner = await ownerByToken(sql, token)
    if (!owner) return res.status(404).json({ error: 'unknown feed' })

    if (req.method === 'DELETE') {
      const id = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id
      if (typeof id !== 'string' || !UUID_RE.test(id)) return res.status(400).json({ error: 'invalid', field: 'id' })
      const stopped = await stopThreshold(sql, owner.id, id.toLowerCase())
      return stopped ? res.status(200).json({ stopped: true }) : res.status(404).json({ error: 'unknown alert' })
    }

    const feed = await evaluateOwner(sql, owner.id, { readValues: deps.readValues(deps.sql), nowMs: deps.nowMs })
    if (req.query.format === 'rss') {
      const site = siteUrl(deps.env)
      res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8')
      return res
        .status(200)
        .send(feedRss(feed, { feedUrl: `${site}${feedPath(token)}?format=rss`, siteUrl: site, manageUrl: `${site}${managePath(token)}` }))
    }
    return res.status(200).json(feedJson(feed))
  } catch {
    // No detail: an error here could carry this owner's rows.
    console.warn('alerts feed: read failed')
    return res.status(503).json({ error: 'alerts storage unavailable' })
  }
}

export default createFeedHandler({
  env: processEnv,
  sql: neonSql(processEnv),
  readValues: (sql) => (needs) => readValues(needs, liveSources(sql)),
  limits: {
    // Shared feed readers (aggregators) poll many feeds from one IP: generous per IP.
    ip: createRateLimiter({ limit: 300, windowMs: 10 * 60_000 }),
    // One reader of one feed: every 20 s on average is far above any RSS poll (ttl 15 min).
    feed: createRateLimiter({ limit: 30, windowMs: 10 * 60_000 }),
  },
})
