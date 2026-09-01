// POST /api/mint/expire — optional cleanup: retire THIS player's past-deadline 'issued'
// claims to 'expired' and roll any 'claim_pending' pet back to 'offchain'. The voucher route
// already calls the same helper opportunistically; this endpoint exposes it for a cron/manual
// sweep. Cookie-scoped (only the caller's own claims), so it is safe to call unauthenticated
// of any elevated role.

import type { NextApiRequest, NextApiResponse } from 'next'

import { requirePlayer } from '@/lib/game/session'
import { expireStaleClaims } from '@/lib/mint/claims'

type ExpireResult = { expired: number } | { error: string }

export default async function handler(req: NextApiRequest, res: NextApiResponse<ExpireResult>) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' })
  }

  const playerId = await requirePlayer(req, res)
  if (!playerId) return

  try {
    const expired = await expireStaleClaims(playerId)
    return res.status(200).json({ expired })
  } catch {
    return res.status(500).json({ error: 'expire_failed' })
  }
}
