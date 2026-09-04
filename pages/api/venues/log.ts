import type { NextApiRequest, NextApiResponse } from 'next'

import { fetchVenueLogEntries, type VenueLogEntry } from '@/pages/api/_lib/venueLogQuery'

// PUBLIC. The venue state-change log ("news tracker") — consequences, never
// headlines. Two provenances, both labeled:
//  - 'observed'      → venue_events rows written live by the hourly recorder
//    (discrete param changes + >20% liquidity shifts; drift is filtered at
//    the source, scripts/record-venue-liquidity.mjs).
//  - 'reconstructed' → discrete-param changes DERIVED at read time from
//    backfilled archive snapshots (e.g. Ethena's cooldown cut). These are
//    real on-chain state transitions, but the recorder wasn't running when
//    they happened, so they are never written into venue_events — the events
//    table stays a log of what the recorder itself witnessed.
// The query lives in pages/api/_lib/venueLogQuery.ts so /api/radar/recap reads
// the same entries (bounded to a hold window). Cached: s-maxage 300.

export type { VenueLogEntry }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' })

  const entries = await fetchVenueLogEntries()

  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600')
  return res.status(200).json({ entries })
}
