import type { NextApiRequest, NextApiResponse } from 'next'

import { readLocalDirectSupplierSupplySummary } from '../../../scripts/lib/carry-direct-supplier-flow-summary.mjs'
import { parseDirectSupplierFlowQuery } from './direct-supplier-flow-context'

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'GET only' })
  }
  const marketKey = parseDirectSupplierFlowQuery(req.query)
  if (!marketKey) return res.status(400).json({ error: 'invalid_direct_supplier_supply_request' })
  if (
    process.env.NODE_ENV !== 'development' ||
    !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress ?? '')
  )
    return res.status(200).json({
      status: 'unavailable',
      marketKey,
      reason: 'local_evidence_only',
      calibratedForecast: false,
    })
  try {
    return res.status(200).json(readLocalDirectSupplierSupplySummary(marketKey))
  } catch {
    return res.status(503).json({ error: 'direct_supplier_supply_verification_failed' })
  }
}
