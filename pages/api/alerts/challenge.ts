import type { NextApiRequest, NextApiResponse } from 'next'
import { isAddress } from 'viem'

import { createConsentChallenge } from '@/lib/alerts/challenge'

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'POST only' })
  }
  const secret = process.env.ALERT_CONSENT_SECRET ?? ''
  if (secret.length < 32) return res.status(503).json({ error: 'Alert consent is not configured' })
  let body: Record<string, unknown>
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' })
  }
  if (!body || typeof body.address !== 'string' || !isAddress(body.address)) {
    return res.status(400).json({ error: 'Invalid Ethereum address' })
  }
  const challenge = createConsentChallenge(body.address, secret)
  return res.status(200).json(challenge)
}
