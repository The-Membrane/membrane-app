import type { NextApiRequest, NextApiResponse } from 'next'
import { sql } from 'drizzle-orm'

import { db } from '@/db'

// PUBLIC — no requirePlayer(). Plain SQL via db.execute (no DB views) per Phase 5 of
// docs/OFFCHAIN_QRACING_PLAN.md, keeping `drizzle-kit push` simple.

export type LeaderboardBoard = 'top_times' | 'byte_earned'

type LeaderboardEntry = {
  rank: number
  playerId: string
  username: string | null
  /** top_times: race time_ticks as a string. byte_earned: raw 6-decimal BYTE total. */
  value: string
}

type LeaderboardResult =
  | { board: LeaderboardBoard; entries: LeaderboardEntry[] }
  | { error: string }

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

function parseLimit(raw: unknown): number {
  const n = Number(Array.isArray(raw) ? raw[0] : raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT
  return Math.min(MAX_LIMIT, Math.floor(n))
}

function parseBoard(raw: unknown): LeaderboardBoard {
  return (Array.isArray(raw) ? raw[0] : raw) === 'byte_earned' ? 'byte_earned' : 'top_times'
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<LeaderboardResult>) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' })
  }

  const board = parseBoard(req.query.board)
  const limit = parseLimit(req.query.limit)

  // Public + cacheable — a stale-by-30s leaderboard is fine and keeps this route cheap
  // under repeated polling.
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60')

  try {
    if (board === 'byte_earned') {
      const rows = await db.execute<{ player_id: string; username: string | null; total: string }>(sql`
        select p.id as player_id, p.username, coalesce(sum(b.delta), 0) as total
        from byte_ledger b
        join players p on p.id = b.player_id
        where b.delta > 0
        group by p.id, p.username
        order by total desc
        limit ${limit}
      `)

      return res.status(200).json({
        board,
        entries: rows.rows.map((r, i) => ({
          rank: i + 1,
          playerId: r.player_id,
          username: r.username,
          value: String(r.total),
        })),
      })
    }

    const rows = await db.execute<{ player_id: string; username: string | null; time_ticks: number }>(sql`
      select p.id as player_id, p.username, r.min_ticks as time_ticks
      from (
        select player_id, min(time_ticks) as min_ticks
        from races
        where verified = true and time_ticks is not null
        group by player_id
      ) r
      join players p on p.id = r.player_id
      order by r.min_ticks asc
      limit ${limit}
    `)

    return res.status(200).json({
      board,
      entries: rows.rows.map((r, i) => ({
        rank: i + 1,
        playerId: r.player_id,
        username: r.username,
        value: String(r.time_ticks),
      })),
    })
  } catch {
    return res.status(500).json({ error: 'leaderboard_load_failed' })
  }
}
