import type { NextApiRequest, NextApiResponse } from 'next'
import { desc, eq, sql } from 'drizzle-orm'

import { db } from '@/db'
import { appPointsLedger } from '@/db/schema'
import { requirePlayer } from '@/lib/game/session'

type PointsEntryDto = {
  id: string
  delta: string
  reason: string
  meta: unknown
  createdAt: string
}

type PointsResult = { totalPoints: string; recent: PointsEntryDto[] } | { error: string }

export default async function handler(req: NextApiRequest, res: NextApiResponse<PointsResult>) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' })
  }

  const playerId = await requirePlayer(req, res)
  if (!playerId) return

  try {
    // One round trip: running total + the last 20 credits, same db.batch pattern as
    // pages/api/game/state.ts (no db.transaction on this client).
    const [sumRows, recentRows] = await db.batch([
      db
        .select({ total: sql<string>`coalesce(sum(${appPointsLedger.delta}), 0)` })
        .from(appPointsLedger)
        .where(eq(appPointsLedger.playerId, playerId)),
      db
        .select()
        .from(appPointsLedger)
        .where(eq(appPointsLedger.playerId, playerId))
        .orderBy(desc(appPointsLedger.createdAt))
        .limit(20),
    ])

    return res.status(200).json({
      totalPoints: BigInt(sumRows[0]?.total ?? '0').toString(),
      recent: recentRows.map((r) => ({
        id: r.id,
        delta: r.delta.toString(),
        reason: r.reason,
        meta: r.meta,
        createdAt: r.createdAt.toISOString(),
      })),
    })
  } catch {
    return res.status(500).json({ error: 'points_load_failed' })
  }
}
