import type { NextApiRequest, NextApiResponse } from 'next'

import { CARRY_SCAN_CACHE_CONTROL, loadCarryScan, loadFallbackSnapshot } from '@/lib/carryScan/load'
import { stripOf } from '@/lib/carryScan/strip'

/**
 * GET /api/carry-scan?view=strip — the "New this week" slice for the /carry strip.
 * GET /api/carry-scan                — the whole weekly file (same loader as the page).
 * Reads the data branch with the committed snapshot as fallback (lib/carryScan/load.ts).
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'GET only' })
  }
  try {
    const view = await loadCarryScan({ fallback: loadFallbackSnapshot })
    res.setHeader('Cache-Control', CARRY_SCAN_CACHE_CONTROL)
    return res.status(200).json(req.query.view === 'strip' ? stripOf(view) : view)
  } catch (e) {
    return res
      .status(500)
      .json({ error: e instanceof Error ? e.message.split('\n')[0] : 'carry-scan unavailable' })
  }
}
