import type { NextApiRequest, NextApiResponse } from 'next'

import type { OracleIndexResponse } from '@/lib/oracleRegistry/apiTypes'
import type { ConfigIndexResponse } from '@/lib/oracleRegistry/config/apiTypes'
import { getConfigIndex } from '@/lib/oracleRegistry/config/server'
import { cacheHeader, getRegistryModel } from '@/lib/oracleRegistry/server'
import { buildIndex } from '@/lib/oracleRegistry/view'

// GET /api/oracles — the oracle registry's asset list: one summary per asset (consensus
// price, member count, colour counts, worst outlier) from the collector's latest snapshot
// in data/oracle-registry/. Missing files degrade to { available: false }, never a 500.
//
// GET /api/oracles?view=config — the config-card subjects: one summary per subject (open red
// flags, pending, proposed, as-of block) from data/oracle-registry/config.

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'GET only' })
  }
  if (req.query.view === 'config') {
    let body: ConfigIndexResponse
    try {
      body = getConfigIndex()
    } catch {
      body = { available: false, subjects: [] }
    }
    res.setHeader('Cache-Control', cacheHeader(body.available))
    return res.status(200).json(body)
  }
  try {
    const body: OracleIndexResponse = buildIndex(getRegistryModel())
    res.setHeader('Cache-Control', cacheHeader(body.available))
    return res.status(200).json(body)
  } catch {
    const body: OracleIndexResponse = {
      available: false,
      reason: 'registry data could not be read',
      snapshot: null,
      assets: [],
    }
    res.setHeader('Cache-Control', cacheHeader(false))
    return res.status(200).json(body)
  }
}
