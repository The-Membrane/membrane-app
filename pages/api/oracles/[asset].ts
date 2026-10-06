import type { NextApiRequest, NextApiResponse } from 'next'

import type { AssetViewResponse } from '@/lib/oracleRegistry/apiTypes'
import { cacheHeader, getRegistryModel } from '@/lib/oracleRegistry/server'
import { assetSlug, buildAssetView, findAssetKey } from '@/lib/oracleRegistry/view'

// GET /api/oracles/[asset] — every oracle card for one asset (slug = lower-case catalog
// key: eth, wsteth, pt-srusde-22oct2026 …): verdict, mechanism, 30-day history aligned to
// the asset's consensus line, and the config-change list. Unknown asset → 404 with the
// valid slugs; missing collector files → 200 with available: false and mechanism-only cards.

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'GET only' })
  }
  const slug = typeof req.query.asset === 'string' ? req.query.asset : ''
  try {
    const model = getRegistryModel()
    const key = findAssetKey(model.inputs.catalog, slug)
    const body: AssetViewResponse | null = key ? buildAssetView(model, key) : null
    if (!body) {
      res.setHeader('Cache-Control', cacheHeader(true))
      return res.status(404).json({
        error: 'unknown asset',
        assets: model.inputs.catalog.assets.map((a) => assetSlug(a.key)),
      })
    }
    res.setHeader('Cache-Control', cacheHeader(body.available))
    return res.status(200).json(body)
  } catch {
    res.setHeader('Cache-Control', 'no-store')
    return res.status(503).json({ error: 'registry data could not be read' })
  }
}
