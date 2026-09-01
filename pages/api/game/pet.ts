import type { NextApiRequest, NextApiResponse } from 'next'
import { randomInt } from 'node:crypto'
import { and, eq } from 'drizzle-orm'

import { db } from '@/db'
import { pets } from '@/db/schema'
import { checkRateLimit, getClientIp } from '@/lib/game/rateLimit'
import { requirePlayer } from '@/lib/game/session'
import { defaultRarityTable, generateTraits } from '@/types/racingTraits'

const RATE_LIMIT = 5
const RATE_WINDOW_SECONDS = 60 * 60

type PetDto = {
  id: string
  name: string
  status: string
  attrSeed: number
  attributes: unknown
  createdAt: string
}

type PetResult = { pet: PetDto } | { error: string; retryAfterSeconds?: number }

function parseName(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null
  const { name } = body as Record<string, unknown>
  if (typeof name !== 'string') return null
  const trimmed = name.trim()
  if (trimmed.length === 0 || trimmed.length > 24) return null
  return trimmed
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<PetResult>) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' })
  }

  const rateLimit = await checkRateLimit(`pet:${getClientIp(req)}`, RATE_LIMIT, RATE_WINDOW_SECONDS)
  if (!rateLimit.allowed) {
    return res
      .status(429)
      .json({ error: 'rate_limited', retryAfterSeconds: rateLimit.retryAfterSeconds })
  }

  // Cookie only — never trust a playerId in the body.
  const playerId = await requirePlayer(req, res)
  if (!playerId) return

  const name = parseName(req.body)
  if (!name) {
    return res.status(400).json({ error: 'invalid_name' })
  }

  try {
    // One active offchain pet per player.
    const [existing] = await db
      .select({ id: pets.id })
      .from(pets)
      .where(and(eq(pets.playerId, playerId), eq(pets.status, 'offchain')))
      .limit(1)

    if (existing) {
      return res.status(409).json({ error: 'pet_exists' })
    }

    // Server picks the seed; attributes are derived from it so the client can re-derive the
    // exact same pet. int31 avoids the xorshift32 zero fixed point.
    const attrSeed = randomInt(1, 2 ** 31 - 1)
    const attributes = generateTraits(attrSeed, defaultRarityTable())

    const [created] = await db
      .insert(pets)
      .values({ playerId, name, attributes, attrSeed, status: 'offchain' })
      .returning()

    return res.status(200).json({
      pet: {
        id: created.id,
        name: created.name,
        status: created.status,
        attrSeed: created.attrSeed,
        attributes: created.attributes,
        createdAt: created.createdAt.toISOString(),
      },
    })
  } catch {
    return res.status(500).json({ error: 'pet_create_failed' })
  }
}
