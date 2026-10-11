import type { NextApiRequest, NextApiResponse } from 'next'

import { readLocalMorphoV2PayoutSummary } from '../../../scripts/lib/localMorphoV2PayoutSummary.mjs'

const ADDRESS = /^0x[0-9a-fA-F]{40}$/

export function parseMorphoPayoutQuery(query: NextApiRequest['query']) {
  if (
    !query ||
    Object.keys(query).length !== 2 ||
    typeof query.routeKey !== 'string' ||
    query.routeKey.length < 1 ||
    query.routeKey.length > 160 ||
    /[\u0000-\u001f\u007f]/.test(query.routeKey) ||
    typeof query.destination !== 'string' ||
    !ADDRESS.test(query.destination)
  )
    return null
  return { routeKey: query.routeKey, destination: query.destination.toLowerCase() }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'GET only' })
  }
  const query = parseMorphoPayoutQuery(req.query)
  if (!query) return res.status(400).json({ error: 'invalid_morpho_payout_request' })
  if (
    process.env.NODE_ENV !== 'development' ||
    !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress ?? '')
  )
    return res.status(200).json({
      status: 'unavailable',
      ...query,
      reason: 'local_evidence_only',
      calibratedForecast: false,
    })
  try {
    return res
      .status(200)
      .json(await readLocalMorphoV2PayoutSummary(query.routeKey, query.destination))
  } catch (error) {
    if (error instanceof Error && error.message === 'morpho_payout_route_not_tracked')
      return res.status(400).json({ error: 'untracked_morpho_payout_route' })
    return res.status(503).json({ error: 'morpho_payout_verification_failed' })
  }
}
