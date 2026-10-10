import type { NextApiRequest, NextApiResponse } from 'next'

import { ROUTES } from '@/components/Carry/fixtures'
import { buildCarryForecastRegistry } from '@/lib/carry/forecastRegistry'
import { verifiedDirectSupplyDestinations } from '@/lib/carry/forecastRegistryMarkets'
import { GHO_SGHO } from '@/scripts/route-rates/exact-leg-spread.mjs'
import seed from '@/scripts/route-cohort/aug-2026-ab-vault-seed.json'
import recorderConfig from '@/tools/venue-recorder.config.json'

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'GET only' })
  }
  try {
    return res
      .status(200)
      .json(
        buildCarryForecastRegistry(
          ROUTES,
          seed,
          recorderConfig.venues,
          GHO_SGHO.destination,
          verifiedDirectSupplyDestinations(),
        ),
      )
  } catch {
    return res.status(503).json({ error: 'forecast_universe_unavailable' })
  }
}
