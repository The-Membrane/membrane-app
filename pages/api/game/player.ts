import type { NextApiRequest, NextApiResponse } from 'next'
import { eq } from 'drizzle-orm'

import { db } from '@/db'
import { players, playerWallets } from '@/db/schema'
import { getPlayerId, setPlayerCookie } from '@/lib/game/session'

type PlayerWalletDto = {
  address: string
  chainId: number
  verifiedAt: string | null
}

type PlayerDto = {
  id: string
  username: string | null
  createdAt: string
  wallets: PlayerWalletDto[]
}

type PlayerResult = { player: PlayerDto } | { error: string }

function generateUsername(): string {
  const suffix = Math.floor(1000 + Math.random() * 9000) // 4-digit, display handle only — no uniqueness needed
  return `racer-${suffix}`
}

async function loadPlayerDto(playerId: string): Promise<PlayerDto | null> {
  const [row] = await db.select().from(players).where(eq(players.id, playerId)).limit(1)
  if (!row) return null

  const wallets = await db
    .select({
      address: playerWallets.address,
      chainId: playerWallets.chainId,
      verifiedAt: playerWallets.verifiedAt,
    })
    .from(playerWallets)
    .where(eq(playerWallets.playerId, playerId))

  return {
    id: row.id,
    username: row.username,
    createdAt: row.createdAt.toISOString(),
    wallets: wallets.map((w) => ({
      address: w.address,
      chainId: w.chainId,
      verifiedAt: w.verifiedAt ? w.verifiedAt.toISOString() : null,
    })),
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<PlayerResult>) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' })
  }

  try {
    const existingId = await getPlayerId(req)
    if (existingId) {
      const existing = await loadPlayerDto(existingId)
      // Cookie verified but the row is gone (e.g. it was merged away as an orphan) —
      // fall through and mint a fresh player rather than erroring.
      if (existing) {
        return res.status(200).json({ player: existing })
      }
    }

    const [created] = await db.insert(players).values({ username: generateUsername() }).returning()

    await setPlayerCookie(res, created.id)

    return res.status(200).json({
      player: {
        id: created.id,
        username: created.username,
        createdAt: created.createdAt.toISOString(),
        wallets: [],
      },
    })
  } catch {
    // Never leak db/connection error text to the client.
    return res.status(500).json({ error: 'player_lookup_failed' })
  }
}
