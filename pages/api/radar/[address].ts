import type { NextApiRequest, NextApiResponse } from 'next'
import { isAddress, getAddress, type Address } from 'viem'

import { getRadarPayload } from '@/pages/api/_lib/radarReads'

// PRIVATE, address-specific. Paste ANY mainnet address → its positions across
// our four instrumented venues, stressed against our RECORDED capacity + flow
// corpus. No wallet connect: this is a standalone decision tool.
//
// The full read path lives in pages/api/_lib/radarReads.ts (getRadarPayload) so
// /api/radar/watch and /api/radar/recap read positions IDENTICALLY — no drift.
//
// PROVENANCE DISCIPLINE (owner, docs/BRAND_CHARTS.md §4):
//  - Chain reads are LIVE at request time (balanceOf / convertToAssets).
//  - Capacity + flow facts are RECORDED (venue_snapshots / venue_flows), read
//    from the DB — never re-queried live here.
//  - Nothing is modelled. The only assumption is $1/underlying for the three
//    $-stable ERC4626 underlyings and the aToken (stated in provenance).

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' })

  const raw = req.query.address
  const addrStr = Array.isArray(raw) ? raw[0] : raw
  if (!addrStr || !isAddress(addrStr)) {
    return res.status(400).json({ error: 'invalid address' })
  }
  const address = getAddress(addrStr) as Address

  const payload = await getRadarPayload(address)

  res.setHeader('Cache-Control', 'private, max-age=300')
  return res.status(200).json(payload)
}
