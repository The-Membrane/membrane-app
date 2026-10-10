import type { NextApiRequest, NextApiResponse } from 'next'

import { readLocalHolderExitEvidence } from '@/lib/carry/localHolderExitEvidence'

const ADDRESS = /^0x[0-9a-fA-F]{40}$/

export function parseHolderEvidenceQuery(query: NextApiRequest['query']) {
  if (
    !query ||
    Object.keys(query).some((key) => !['routeKey', 'destination'].includes(key)) ||
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
  const query = parseHolderEvidenceQuery(req.query)
  if (!query) return res.status(400).json({ error: 'invalid_holder_evidence_request' })
  if (
    process.env.NODE_ENV !== 'development' ||
    !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress ?? '')
  )
    return res.status(200).json({
      status: 'unavailable',
      ...query,
      reason: 'local_evidence_only',
      calibratedForecast: false,
      cells: [],
    })
  try {
    return res
      .status(200)
      .json(await readLocalHolderExitEvidence(query.routeKey, query.destination))
  } catch {
    return res.status(503).json({ error: 'holder_evidence_verification_failed' })
  }
}
