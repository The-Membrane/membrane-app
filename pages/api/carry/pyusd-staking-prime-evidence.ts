import type { NextApiRequest, NextApiResponse } from 'next'

import { PRIME, ROUTE } from '../../../scripts/research/pyusd-staking-economic-exit.mjs'
import {
  readRows,
  summarizeProspective,
  verify,
} from '../../../scripts/research/pyusd-staking-prospective.mjs'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'GET only' })
  }
  if (
    Object.keys(req.query).length !== 2 ||
    req.query.routeKey !== ROUTE ||
    typeof req.query.destination !== 'string' ||
    req.query.destination.toLowerCase() !== PRIME
  )
    return res.status(400).json({ error: 'invalid_pyusd_prime_route' })
  if (
    process.env.NODE_ENV !== 'development' ||
    !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress ?? '')
  )
    return res.status(200).json({
      status: 'unavailable',
      routeKey: ROUTE,
      destination: PRIME,
      scope: 'prime_to_wylds_callable_only',
      finalPayoutAssessment: 'usdc_and_pyusd_unassessed',
      calibratedForecast: false,
      cells: [],
      reason: 'local_evidence_only',
    })
  try {
    await verify()
    const [issues, scores] = await Promise.all([readRows('issues'), readRows('scores')])
    return res.status(200).json(summarizeProspective(issues, scores))
  } catch {
    return res.status(503).json({ error: 'pyusd_prime_evidence_verification_failed' })
  }
}
