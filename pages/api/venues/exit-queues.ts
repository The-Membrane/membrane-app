import type { NextApiRequest, NextApiResponse } from 'next'

import { buildExitQueueFeed } from '@/lib/exitQueue/feed'
import { DEFAULT_DIR, loadLedger } from '@/lib/exitQueue/store'
import { allVenues } from '@/lib/exitQueue/venues'

/**
 * GET /api/venues/exit-queues[?venue=<key>]
 *
 * Per-venue exit-queue metrics from the local ledger (data/exit-queue/, written by
 * scripts/record-exit-queues.ts). Local-first: on a host without the ledger files
 * every venue comes back with `anchor: null` and status `no_local_ledger`. Nothing
 * here calls an RPC.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' })
  const raw = req.query.venue
  const venue = Array.isArray(raw) ? raw[0] : raw
  const defs = allVenues().filter((d) => !venue || d.key === venue)
  if (!defs.length) return res.status(404).json({ error: 'unknown venue' })
  try {
    const feed = buildExitQueueFeed(
      defs.map((def) => ({ def, ledger: loadLedger(def.key, DEFAULT_DIR) })),
    )
    res.setHeader('Cache-Control', 'no-store')
    return res.status(200).json(feed)
  } catch {
    return res.status(500).json({ error: 'exit-queue ledger unreadable' })
  }
}
