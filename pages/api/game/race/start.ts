import type { NextApiRequest, NextApiResponse } from 'next'
import { randomInt } from 'node:crypto'
import { and, eq, lt, sql } from 'drizzle-orm'

import { db } from '@/db'
import { energy, pets, races } from '@/db/schema'
import { GAME, computeEnergy, refillAtForTarget } from '@/lib/game/config'
import { checkRateLimit, getClientIp } from '@/lib/game/rateLimit'
import { requirePlayer } from '@/lib/game/session'

const RATE_LIMIT = 30
const RATE_WINDOW_SECONDS = 10 * 60
// Refuse a new race if the player somehow has more than this many still-open races after
// expiry cleanup runs below (abandoned-race hygiene; not a normal-play limit).
const MAX_OPEN_RACES = 3

type StartResult =
  | { raceId: string; mazeSeed: number; difficulty: number }
  | { error: string; energy?: number; refillAt?: string | null; retryAfterSeconds?: number }

function parseDifficulty(body: unknown): number {
  if (typeof body === 'object' && body !== null) {
    const { difficulty } = body as Record<string, unknown>
    if (typeof difficulty === 'number' && Number.isFinite(difficulty)) {
      return Math.max(1, Math.min(5, Math.floor(difficulty)))
    }
  }
  return 1
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<StartResult>) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' })
  }

  const rateLimit = await checkRateLimit(
    `race_start:${getClientIp(req)}`,
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

  const difficulty = parseDifficulty(req.body)

  try {
    // Must have an active offchain pet to race.
    const [pet] = await db
      .select({ id: pets.id })
      .from(pets)
      .where(and(eq(pets.playerId, playerId), eq(pets.status, 'offchain')))
      .limit(1)

    if (!pet) {
      return res.status(400).json({ error: 'no_pet' })
    }

    // Abandoned-race hygiene: expire any of this player's 'open' races older than the submit
    // window (race/submit already does this per-race on submit; do it here too so races the
    // player never comes back to submit don't pile up).
    const expiryCutoff = new Date(Date.now() - GAME.RACE_SUBMIT_WINDOW_MS)
    await db
      .update(races)
      .set({ status: 'expired' })
      .where(
        and(eq(races.playerId, playerId), eq(races.status, 'open'), lt(races.createdAt, expiryCutoff)),
      )

    const [{ openCount }] = await db
      .select({ openCount: sql<number>`count(*)::int` })
      .from(races)
      .where(and(eq(races.playerId, playerId), eq(races.status, 'open')))

    if (openCount > MAX_OPEN_RACES) {
      return res.status(409).json({ error: 'too_many_open_races' })
    }

    // Current energy = stored value refilled continuously since updated_at. A missing row means
    // a fresh player at full energy.
    const [energyRow] = await db
      .select({ value: energy.value, updatedAt: energy.updatedAt })
      .from(energy)
      .where(eq(energy.playerId, playerId))
      .limit(1)

    const now = new Date()
    const storedValue = energyRow ? energyRow.value : GAME.ENERGY_MAX
    const anchor = energyRow ? energyRow.updatedAt : now
    const current = computeEnergy(storedValue, anchor, now).value

    if (current < GAME.ENERGY_PER_RACE) {
      return res.status(402).json({
        error: 'insufficient_energy',
        energy: current,
        refillAt: refillAtForTarget(storedValue, anchor, GAME.ENERGY_PER_RACE),
      })
    }

    const newEnergy = current - GAME.ENERGY_PER_RACE
    const mazeSeed = randomInt(1, 2 ** 31 - 1)

    // Atomic: spend energy (upsert, anchor reset to now) + open the race row. neon-http has no
    // interactive db.transaction — db.batch wraps both in one Postgres BEGIN/COMMIT.
    const results = await db.batch([
      db
        .insert(energy)
        .values({ playerId, value: newEnergy, updatedAt: now })
        .onConflictDoUpdate({
          target: energy.playerId,
          set: { value: newEnergy, updatedAt: now },
        }),
      db
        .insert(races)
        .values({
          playerId,
          petId: pet.id,
          mazeSeed: String(mazeSeed),
          difficulty,
          status: 'open',
        })
        .returning({ id: races.id }),
    ])

    const raceId = (results[1] as Array<{ id: string }>)[0].id

    return res.status(200).json({ raceId, mazeSeed, difficulty })
  } catch {
    return res.status(500).json({ error: 'race_start_failed' })
  }
}
