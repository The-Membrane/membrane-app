import type { NextApiRequest, NextApiResponse } from 'next'
import { desc, eq, sql } from 'drizzle-orm'

import { db } from '@/db'
import { appSessions } from '@/db/schema'
import { GAME } from '@/lib/game/config'
import { checkRateLimit, getClientIp } from '@/lib/game/rateLimit'
import { requirePlayer } from '@/lib/game/session'

// Phase 5 server-side replacement for persisted-state/useSessionTrackingState.ts's
// localStorage-only session tracking. See docs/OFFCHAIN_QRACING_PLAN.md, Phase 5.

const RATE_LIMIT = 60
const RATE_WINDOW_SECONDS = 10 * 60

type HeartbeatResult =
  | { sessionId: string; startedAt: string }
  | { error: string; retryAfterSeconds?: number }

/** Body is optional and `page` is accepted but not persisted — app_sessions.pages is a
 * heartbeat count (see db/schema.ts), not a page-name log. Kept for future use / callers
 * that want to pass it without a type error. */
function parseBody(body: unknown): { page?: string } {
  if (typeof body !== 'object' || body === null) return {}
  const { page } = body as Record<string, unknown>
  return typeof page === 'string' ? { page: page.slice(0, 512) } : {}
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<HeartbeatResult>) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' })
  }

  const rateLimit = await checkRateLimit(
    `heartbeat:${getClientIp(req)}`,
    RATE_LIMIT,
    RATE_WINDOW_SECONDS,
  )
  if (!rateLimit.allowed) {
    return res
      .status(429)
      .json({ error: 'rate_limited', retryAfterSeconds: rateLimit.retryAfterSeconds })
  }

  const playerId = await requirePlayer(req, res)
  if (!playerId) return

  parseBody(req.body)

  try {
    const [latest] = await db
      .select({
        id: appSessions.id,
        startedAt: appSessions.startedAt,
        lastSeenAt: appSessions.lastSeenAt,
      })
      .from(appSessions)
      .where(eq(appSessions.playerId, playerId))
      .orderBy(desc(appSessions.lastSeenAt))
      .limit(1)

    const now = new Date()
    const isActive =
      !!latest && now.getTime() - latest.lastSeenAt.getTime() < GAME.SESSION_IDLE_WINDOW_MS

    if (isActive && latest) {
      await db
        .update(appSessions)
        .set({ lastSeenAt: now, pages: sql`${appSessions.pages} + 1` })
        .where(eq(appSessions.id, latest.id))

      return res.status(200).json({
        sessionId: latest.id,
        startedAt: latest.startedAt.toISOString(),
      })
    }

    const [created] = await db
      .insert(appSessions)
      .values({ playerId, startedAt: now, lastSeenAt: now, pages: 1 })
      .returning()

    return res.status(200).json({
      sessionId: created.id,
      startedAt: created.startedAt.toISOString(),
    })
  } catch {
    return res.status(500).json({ error: 'heartbeat_failed' })
  }
}
