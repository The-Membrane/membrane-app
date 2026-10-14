import type { NextApiRequest, NextApiResponse } from 'next'
import { randomBytes } from 'crypto'

import {
  ADDRESS_RE,
  checkThreshold,
  FEED_TOKEN_RE,
  isDirection,
  isMetric,
  MAX_ACTIVE_PER_OWNER,
  thresholdDeepLink,
} from '@/lib/userAlerts/metrics'
import { clientIp, createRateLimiter, type RateLimiter } from '@/lib/userAlerts/rateLimit'
import { addThreshold, createOwnerWithThreshold, ownerByToken, type Sql } from '@/lib/userAlerts/store'
import { liveAllowList, type AllowList } from '@/lib/userAlerts/subjects'
import { feedPath, neonSql, processEnv, siteUrl, telegramOn, type Env } from '@/pages/api/_lib/userAlerts'

// POST /api/alerts — store ONE opt-in threshold ("Alert me at X").
//
//   body  {ownerKind:'address', ownerKey:0x…, metric, subject, direction, threshold,
//          optIn:true, feedToken?}
//   200   {id, feedUrl, telegramLink?}   — this threshold's id and ITS feed, nothing else
//   400   invalid field / opt-in missing        404  feedToken unknown or not this address's
//   409   {error:'cap', max}                    429  rate-limited      503  no storage
//
// THE FEED TOKEN IS THE OWNER. The address is not authenticated (Radar is paste-an-
// address, no signature), so a token keyed to the address alone would hand any
// caller the feed of any address. Instead: a POST without feedToken mints a NEW feed
// (32 random bytes) for that address; a POST with the token of an existing feed adds
// to it — and only if that feed belongs to the same address. Nobody can read or
// extend a feed they were not given. Several feeds per address can exist.
//
// No endpoint lists thresholds by address, by subject or in aggregate. Nothing here
// logs a threshold or an owner key.

export type CreateDeps = {
  env: Env
  sql: () => Sql
  allowList: () => AllowList
  limiter: RateLimiter
  newToken?: () => string
  nowMs?: () => number
}

const bad = (res: NextApiResponse, field: string, message: string) => res.status(400).json({ error: 'invalid', field, message })

export const createAlertsHandler = (deps: CreateDeps) => async (req: NextApiRequest, res: NextApiResponse): Promise<void> => {
  res.setHeader('Cache-Control', 'private, no-store')
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'POST only' })
  }
  if (deps.limiter(clientIp(req))) return res.status(429).json({ error: 'slow down' })
  if (!deps.env('DATABASE_URL')) return res.status(503).json({ error: 'alerts storage unavailable' })

  const body = (typeof req.body === 'string' ? safeParse(req.body) : req.body) ?? {}
  if (body.ownerKind !== 'address') return bad(res, 'ownerKind', "ownerKind must be 'address'.")
  if (typeof body.ownerKey !== 'string' || !ADDRESS_RE.test(body.ownerKey.trim())) {
    return bad(res, 'ownerKey', 'Enter a 0x address.')
  }
  const ownerKey = body.ownerKey.trim().toLowerCase()
  const metric: unknown = body.metric
  if (!isMetric(metric)) return bad(res, 'metric', 'Unknown metric.')
  const subject: unknown = body.subject
  if (typeof subject !== 'string' || !deps.allowList()[metric].has(subject)) {
    return bad(res, 'subject', `No live ${metric} for that subject.`)
  }
  const direction: unknown = body.direction
  if (!isDirection(direction)) return bad(res, 'direction', "Pick 'above' or 'below'.")
  const th = checkThreshold(metric, typeof body.threshold === 'string' ? Number(body.threshold) : body.threshold)
  if (!th.ok) return bad(res, 'threshold', th.message)
  // OPT-IN: nothing is stored without an explicit true.
  if (body.optIn !== true) return bad(res, 'optIn', 'Tick the box to store this alert.')
  const optedInAt = new Date((deps.nowMs ?? Date.now)()).toISOString()
  const t = { metric, subject, direction, threshold: th.value, optedInAt }

  const sql = deps.sql()
  let token: string
  let id: string | null
  try {
    if (body.feedToken !== undefined && body.feedToken !== null) {
      const given = typeof body.feedToken === 'string' ? body.feedToken.trim().toLowerCase() : ''
      const owner = FEED_TOKEN_RE.test(given) ? await ownerByToken(sql, given) : null
      // Same 404 for "no such feed" and "not this address's feed": no oracle.
      if (!owner || owner.kind !== 'address' || owner.key !== ownerKey) return res.status(404).json({ error: 'unknown feed' })
      token = given
      id = await addThreshold(sql, owner.id, t, MAX_ACTIVE_PER_OWNER)
      if (id === null) return res.status(409).json({ error: 'cap', max: MAX_ACTIVE_PER_OWNER })
    } else {
      token = (deps.newToken ?? (() => randomBytes(32).toString('hex')))()
      id = await createOwnerWithThreshold(sql, { kind: 'address', key: ownerKey, token }, t)
    }
  } catch {
    // Deliberately no detail: the error could carry the row we tried to write.
    console.warn('alerts: store failed')
    return res.status(503).json({ error: 'alerts storage unavailable' })
  }

  const tg = telegramOn(deps.env)
  return res.status(200).json({
    id,
    feedUrl: `${siteUrl(deps.env)}${feedPath(token)}?format=rss`,
    ...(tg.on ? { telegramLink: thresholdDeepLink(tg.username, token) } : {}),
  })
}

function safeParse(s: string): any {
  try {
    return JSON.parse(s)
  } catch {
    return {}
  }
}

export default createAlertsHandler({
  env: processEnv,
  sql: neonSql(processEnv),
  allowList: liveAllowList,
  // 12 stores per 10 min per IP: room for every control on a page, not for a script.
  limiter: createRateLimiter({ limit: 12, windowMs: 10 * 60_000 }),
})
