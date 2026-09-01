import type { NextApiRequest, NextApiResponse } from 'next'
import { and, eq, gte, inArray, sql } from 'drizzle-orm'

import { db } from '@/db'
import { byteLedger, races } from '@/db/schema'
import { GAME, computeByteAward, utcDayRange } from '@/lib/game/config'
import { generateMaze } from '@/lib/game/maze'
import { awardPoints } from '@/lib/game/points'
import { checkRateLimit, getClientIp } from '@/lib/game/rateLimit'
import { replayPath } from '@/lib/game/replay'
import { requirePlayer } from '@/lib/game/session'

const RATE_LIMIT = 30
const RATE_WINDOW_SECONDS = 10 * 60

type SubmitResult =
  | {
      verified: boolean
      ticks: number
      byteAwarded: string
      newBalance: string
      capReached?: true
    }
  | { error: string; retryAfterSeconds?: number }

type SubmitBody = { raceId: string; moves: number[] }

function parseBody(body: unknown): SubmitBody | null {
  if (typeof body !== 'object' || body === null) return null
  const { raceId, moves } = body as Record<string, unknown>
  if (typeof raceId !== 'string' || raceId.length === 0) return null
  if (!Array.isArray(moves) || moves.length > GAME.MAX_SUBMITTED_MOVES) return null
  // Coerce to a clean number[] — replayPath is total, but keep what we persist tidy.
  const clean = moves.map((m) => Number(m))
  return { raceId, moves: clean }
}

async function balanceOf(playerId: string): Promise<bigint> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${byteLedger.delta}), 0)` })
    .from(byteLedger)
    .where(eq(byteLedger.playerId, playerId))
  return BigInt(row?.total ?? '0')
}

// Sum of today's (UTC day) byte_ledger credits from wins only — mint_debit/admin entries
// never count against the faucet cap. Drives the Phase 3 daily BYTE cap in computeByteAward.
async function earnedToday(playerId: string): Promise<bigint> {
  const { start, end } = utcDayRange()
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${byteLedger.delta}), 0)` })
    .from(byteLedger)
    .where(
      and(
        eq(byteLedger.playerId, playerId),
        inArray(byteLedger.reason, ['race_win', 'rps_win']),
        gte(byteLedger.createdAt, start),
        sql`${byteLedger.createdAt} < ${end}`,
      ),
    )
  return BigInt(row?.total ?? '0')
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<SubmitResult>) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' })
  }

  const rateLimit = await checkRateLimit(
    `submit:${getClientIp(req)}`,
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

  const body = parseBody(req.body)
  if (!body) {
    return res.status(400).json({ error: 'invalid_payload' })
  }

  try {
    const [race] = await db.select().from(races).where(eq(races.id, body.raceId)).limit(1)

    if (!race || race.playerId !== playerId) {
      return res.status(404).json({ error: 'race_not_found' })
    }
    if (race.status !== 'open') {
      return res.status(409).json({ error: 'race_not_open' })
    }

    // Aged-out races cannot be credited — close them as expired.
    const ageMs = Date.now() - race.createdAt.getTime()
    if (ageMs > GAME.RACE_SUBMIT_WINDOW_MS) {
      await db.update(races).set({ status: 'expired' }).where(eq(races.id, race.id))
      return res.status(409).json({ error: 'race_expired' })
    }

    // Server regenerates the exact maze from the stored seed + difficulty and replays the path.
    // The client's claimed outcome is never trusted — only its moves.
    const maze = generateMaze(Number(race.mazeSeed), race.difficulty)
    const result = replayPath(maze, body.moves)

    if (!result.finished) {
      // Honest no-credit close.
      await db
        .update(races)
        .set({
          status: 'submitted',
          verified: false,
          submittedPath: body.moves,
          timeTicks: result.ticks,
        })
        .where(eq(races.id, race.id))

      const newBalance = await balanceOf(playerId)
      return res.status(200).json({
        verified: false,
        ticks: result.ticks,
        byteAwarded: '0',
        newBalance: newBalance.toString(),
      })
    }

    // Verified win: apply the Phase 3 daily faucet cap before crediting BYTE.
    const [prevBalance, earned] = await Promise.all([balanceOf(playerId), earnedToday(playerId)])
    const award = computeByteAward(earned, GAME.BYTE_PER_WIN, GAME.DAILY_BYTE_CAP)

    if (award === 0n) {
      // Cap already reached today: the race is still verified and its time recorded, but no
      // BYTE is credited. capReached lets the UI say so honestly instead of pretending the
      // win didn't count.
      await db
        .update(races)
        .set({
          status: 'submitted',
          verified: true,
          submittedPath: body.moves,
          timeTicks: result.ticks,
          byteAwarded: 0n,
        })
        .where(eq(races.id, race.id))

      return res.status(200).json({
        verified: true,
        ticks: result.ticks,
        byteAwarded: '0',
        newBalance: prevBalance.toString(),
        capReached: true,
      })
    }

    // Credit BYTE (and Phase 5 engagement points) atomically with closing the race
    // (append-only ledgers). This branch is only reached when award > 0n — the
    // award === 0n / cap-reached case already returned above.
    await db.batch([
      db
        .update(races)
        .set({
          status: 'submitted',
          verified: true,
          submittedPath: body.moves,
          timeTicks: result.ticks,
          byteAwarded: award,
        })
        .where(eq(races.id, race.id)),
      db.insert(byteLedger).values({
        playerId,
        delta: award,
        reason: 'race_win',
        raceId: race.id,
      }),
      awardPoints(playerId, GAME.POINTS_PER_RACE_WIN, 'race_win', { raceId: race.id }),
    ])

    const newBalance = prevBalance + award
    return res.status(200).json({
      verified: true,
      ticks: result.ticks,
      byteAwarded: award.toString(),
      newBalance: newBalance.toString(),
      ...(award < GAME.BYTE_PER_WIN ? { capReached: true } : {}),
    })
  } catch {
    return res.status(500).json({ error: 'race_submit_failed' })
  }
}
