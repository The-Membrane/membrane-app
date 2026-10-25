import type { NextApiRequest, NextApiResponse } from 'next'

import { parseAddress } from '@/lib/position-sim'
import type { CensusRow } from '@/lib/landing/census'
import { censusRowServer } from '@/lib/landing/censusServer'

/**
 * `GET /api/sim/census/0x…` — the address's included, priced mainnet row in the Oct 10
 * census (public/data/oct10-2025/evidence.json), or `{ row: null }`. Server-side so the
 * 2 MB cohort never ships to the browser.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse<{ row: CensusRow | null } | { error: string }>) {
  const raw = Array.isArray(req.query.address) ? req.query.address[0] : req.query.address
  const address = parseAddress(raw ?? '')
  if (!address) return res.status(400).json({ error: 'not an address' })
  try {
    res.setHeader('Cache-Control', 'public, s-maxage=86400')
    return res.status(200).json({ row: censusRowServer(address) })
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message })
  }
}
