import type { NextApiRequest, NextApiResponse } from 'next'

import { feedJson, feedRss, managePath } from '@/lib/userAlerts/feed'
import { apiThreshold, FEED_TOKEN_RE, isDirection, thresholdShapeError, UUID_RE } from '@/lib/userAlerts/metrics'
import { clientIp, createRateLimiter, type RateLimiter } from '@/lib/userAlerts/rateLimit'
import { evaluateOwner, type EvaluateDeps } from '@/lib/userAlerts/service'
import { activeThresholds, editThreshold, ownerByToken, stopThreshold, type Sql } from '@/lib/userAlerts/store'
import { liveSources, readValues } from '@/lib/userAlerts/values'
import { feedPath, neonSql, processEnv, siteUrl, type Env } from '@/pages/api/_lib/userAlerts'

// GET    /api/alerts/feed/[token]              this owner's thresholds + events (JSON)
// GET    /api/alerts/feed/[token]?format=rss   the same as RSS 2.0 — the subscription
// DELETE /api/alerts/feed/[token]?id=<uuid>    stop one of this owner's thresholds
// PATCH  /api/alerts/feed/[token]?id=<uuid>    edit one: body {direction, threshold}
//        → {id, changed}. An edit REPLACES the row (lib/userAlerts/store.ts
//        editThreshold): the new id starts not crossed, carries the reading guard, and
//        no event is written. Same parsing and bounds as POST /api/alerts. An unknown,
//        stopped or someone else's id is the same 404 as for DELETE.
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
// (bounds how often one reader can make one feed evaluate) — then the DB. GET,
// DELETE and PATCH share that whole path and the same headers: private, no-store;
// noindex; no referrer.

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

/** ?id=<uuid>, lower-cased; null when absent or malformed. */
const idOf = (req: NextApiRequest): string | null => {
  const id = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id
  return typeof id === 'string' && UUID_RE.test(id) ? id.toLowerCase() : null
}

const bodyOf = (req: NextApiRequest): Record<string, unknown> => {
  if (typeof req.body !== 'string') return req.body && typeof req.body === 'object' ? req.body : {}
  try {
    const v = JSON.parse(req.body)
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

const METHODS = ['GET', 'DELETE', 'PATCH']

export const createFeedHandler = (deps: FeedDeps) => async (req: NextApiRequest, res: NextApiResponse): Promise<void> => {
  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader('X-Robots-Tag', 'noindex')
  res.setHeader('Referrer-Policy', 'no-referrer')
  if (!METHODS.includes(req.method ?? '')) {
    res.setHeader('Allow', METHODS.join(', '))
    return res.status(405).json({ error: 'GET, DELETE or PATCH only' })
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
      const id = idOf(req)
      if (!id) return res.status(400).json({ error: 'invalid', field: 'id' })
      const stopped = await stopThreshold(sql, owner.id, id)
      return stopped ? res.status(200).json({ stopped: true }) : res.status(404).json({ error: 'unknown alert' })
    }

    if (req.method === 'PATCH') {
      const id = idOf(req)
      if (!id) return res.status(400).json({ error: 'invalid', field: 'id' })
      // The body's shape first (no metric needed), so junk never reaches a lookup.
      const body = bodyOf(req)
      if (!isDirection(body.direction)) return res.status(400).json({ error: 'invalid', field: 'direction', message: "Pick 'above' or 'below'." })
      const shape = thresholdShapeError(body.threshold)
      if (shape) return res.status(400).json({ error: 'invalid', field: 'threshold', message: shape })
      // Only this owner's ACTIVE rows: an unknown, stopped or someone else's id is the
      // same 404 Stop gives.
      const current = (await activeThresholds(sql, owner.id)).find((t) => t.id === id)
      if (!current) return res.status(404).json({ error: 'unknown alert' })
      // The bounds of THIS row's metric — the same rule as creating it.
      const th = apiThreshold(current.metric, body.threshold)
      if (!th.ok) return res.status(400).json({ error: 'invalid', field: 'threshold', message: th.message })
      const editedAt = new Date((deps.nowMs ?? Date.now)()).toISOString()
      const out = await editThreshold(sql, owner.id, id, { direction: body.direction, threshold: th.value, editedAt })
      return out ? res.status(200).json(out) : res.status(404).json({ error: 'unknown alert' })
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
    console.warn(`alerts feed: ${req.method === 'GET' ? 'read' : 'write'} failed`)
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
