import type { NextApiRequest, NextApiResponse } from 'next'
import { and, desc, eq, sql } from 'drizzle-orm'

import { db } from '@/db'
import { byteLedger, energy, pets, players, races } from '@/db/schema'
import { GAME, computeEnergy } from '@/lib/game/config'
import { requirePlayer } from '@/lib/game/session'

type PetDto = {
  id: string
  name: string
  status: string
  attrSeed: number
  attributes: unknown
  createdAt: string
} | null

type RaceDto = {
  id: string
  mazeSeed: number
  difficulty: number
  status: string
  verified: boolean
  timeTicks: number | null
  byteAwarded: string | null
  createdAt: string
}

type StateResult =
  | {
      player: { id: string; username: string | null; createdAt: string }
      pet: PetDto
      byteBalance: string
      energy: { value: number; max: number; refillAt: string | null }
      races: RaceDto[]
    }
  | { error: string }

export default async function handler(req: NextApiRequest, res: NextApiResponse<StateResult>) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' })
  }

  const playerId = await requirePlayer(req, res)
  if (!playerId) return

  try {
    // One round trip: player, active pet, BYTE balance, energy, last 10 races.
    const [playerRows, petRows, balanceRows, energyRows, raceRows] = await db.batch([
      db.select().from(players).where(eq(players.id, playerId)).limit(1),
      db
        .select()
        .from(pets)
        .where(and(eq(pets.playerId, playerId), eq(pets.status, 'offchain')))
        .limit(1),
      db
        .select({ total: sql<string>`coalesce(sum(${byteLedger.delta}), 0)` })
        .from(byteLedger)
        .where(eq(byteLedger.playerId, playerId)),
      db
        .select({ value: energy.value, updatedAt: energy.updatedAt })
        .from(energy)
        .where(eq(energy.playerId, playerId))
        .limit(1),
      db
        .select({
          id: races.id,
          mazeSeed: races.mazeSeed,
          difficulty: races.difficulty,
          status: races.status,
          verified: races.verified,
          timeTicks: races.timeTicks,
          byteAwarded: races.byteAwarded,
          createdAt: races.createdAt,
        })
        .from(races)
        .where(eq(races.playerId, playerId))
        .orderBy(desc(races.createdAt))
        .limit(10),
    ])

    const playerRow = playerRows[0]
    if (!playerRow) {
      return res.status(404).json({ error: 'player_not_found' })
    }

    const petRow = petRows[0]
    const now = new Date()
    const storedValue = energyRows[0] ? energyRows[0].value : GAME.ENERGY_MAX
    const anchor = energyRows[0] ? energyRows[0].updatedAt : now

    return res.status(200).json({
      player: {
        id: playerRow.id,
        username: playerRow.username,
        createdAt: playerRow.createdAt.toISOString(),
      },
      pet: petRow
        ? {
            id: petRow.id,
            name: petRow.name,
            status: petRow.status,
            attrSeed: petRow.attrSeed,
            attributes: petRow.attributes,
            createdAt: petRow.createdAt.toISOString(),
          }
        : null,
      byteBalance: BigInt(balanceRows[0]?.total ?? '0').toString(),
      energy: computeEnergy(storedValue, anchor, now),
      races: raceRows.map((r) => ({
        id: r.id,
        mazeSeed: Number(r.mazeSeed),
        difficulty: r.difficulty,
        status: r.status,
        verified: r.verified,
        timeTicks: r.timeTicks,
        byteAwarded: r.byteAwarded != null ? r.byteAwarded.toString() : null,
        createdAt: r.createdAt.toISOString(),
      })),
    })
  } catch {
    return res.status(500).json({ error: 'state_load_failed' })
  }
}
