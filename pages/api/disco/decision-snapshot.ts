import type { NextApiRequest, NextApiResponse } from 'next'

import {
  DEPOSIT_KEY_RE,
  DiscoSnapshotError,
  localDiscoClient,
  readDiscoDecisionSnapshot,
} from '@/lib/disco/decisionSnapshot'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'POST only' })
  }
  const body = req.body
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => key !== 'chainId' && key !== 'depositKey') ||
    JSON.stringify(body).length > 256 ||
    body.chainId !== 31337 ||
    typeof body.depositKey !== 'string' ||
    !DEPOSIT_KEY_RE.test(body.depositKey)
  )
    return res.status(400).json({ error: 'invalid_deposit_or_chain' })

  try {
    const snapshot = await readDiscoDecisionSnapshot(localDiscoClient(), body.depositKey)
    return res.status(200).json(snapshot)
  } catch (error) {
    if (error instanceof DiscoSnapshotError) {
      if (error.reason === 'deposit_missing') return res.status(404).json({ error: error.reason })
      if (error.reason === 'wrong_chain' || error.reason === 'not_deployed') {
        return res.status(503).json({ error: 'local_disco_unavailable' })
      }
    }
    // RPC errors can contain credential-bearing URLs; do not log or relay them.
    return res.status(503).json({ error: 'disco_snapshot_unavailable' })
  }
}
