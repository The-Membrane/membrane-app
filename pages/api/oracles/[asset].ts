import type { NextApiRequest, NextApiResponse } from 'next'

import type { AssetViewResponse } from '@/lib/oracleRegistry/apiTypes'
import { getConfigCard, getConfigIndex } from '@/lib/oracleRegistry/config/server'
import { cacheHeader, getRegistryModel } from '@/lib/oracleRegistry/server'
import { assetSlug, buildAssetView, findAssetKey } from '@/lib/oracleRegistry/view'

// GET /api/oracles/[asset] — every oracle card for one asset (slug = lower-case catalog
// key: eth, wsteth, pt-srusde-22oct2026 …): verdict, mechanism, 30-day history aligned to
// the asset's consensus line, and the config-change list. Unknown asset → 404 with the
// valid slugs; missing collector files → 200 with available: false and mechanism-only cards.
//
// GET /api/oracles/[asset]?view=config[&history=all] — the asset's CONFIG CARD (trust
// configuration + change timeline, data/oracle-registry/config). Slugs: the oracle asset's
// slug or a config-only subject key (rseth). Quiet historical rows are trimmed unless
// history=all; every pending, proposed, red and still-in-effect row is always included.

function configHandler(req: NextApiRequest, res: NextApiResponse, slug: string) {
  try {
    const body = getConfigCard(slug, { keep: req.query.history === 'all' ? 'all' : undefined })
    if (!body) {
      res.setHeader('Cache-Control', cacheHeader(true))
      return res.status(404).json({
        error: 'unknown config subject',
        subjects: getConfigIndex().subjects.map((s) => s.slug),
      })
    }
    res.setHeader('Cache-Control', cacheHeader(body.available))
    return res.status(200).json(body)
  } catch {
    res.setHeader('Cache-Control', 'no-store')
    return res.status(503).json({ error: 'config data could not be read' })
  }
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'GET only' })
  }
  const slug = typeof req.query.asset === 'string' ? req.query.asset : ''
  if (req.query.view === 'config') return configHandler(req, res, slug)
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
