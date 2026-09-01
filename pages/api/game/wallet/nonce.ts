import type { NextApiRequest, NextApiResponse } from 'next'

import { requirePlayer, signWalletNonce } from '@/lib/game/session'

type NonceResult = { nonce: string; message: string } | { error: string }

export default async function handler(req: NextApiRequest, res: NextApiResponse<NonceResult>) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' })
  }

  const playerId = await requirePlayer(req, res)
  if (!playerId) return // requirePlayer already sent 401

  try {
    const { nonce, message } = await signWalletNonce(playerId)
    return res.status(200).json({ nonce, message })
  } catch {
    return res.status(500).json({ error: 'nonce_generation_failed' })
  }
}
