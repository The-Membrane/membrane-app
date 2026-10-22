import type { NextApiRequest, NextApiResponse } from 'next'

import { compact } from '@/lib/curatorFeed/format'
import {
  buildAttributionResponse,
  buildExposureResponse,
  buildFeedResponse,
  buildFlagsResponse,
  buildSpikeResponse,
  buildVaultExposure,
  parseFeedQuery,
  QueryError,
} from '@/lib/curatorFeed/service'
import type { FeedFile } from '@/lib/curatorFeed/store'
import { loadExposureFile, loadFeedFile, unavailableError } from '@/pages/api/_lib/curatorFeedFiles'

// PUBLIC. Curator action feed — what Morpho / Euler Earn curators (and Aave v3, as the
// protocol-level analogue) changed on Ethereum mainnet: caps, removals, queues,
// timelocks, roles; clustered exits of one collateral across curators; which vaults
// hold which collateral; and large vault withdrawals measured against the market move.
//
//   GET /api/curator-feed                    feed (see lib/curatorFeed/service.ts)
//   GET /api/curator-feed?view=exposure      collateral → vaults at the head block (&by=vault: vault → markets)
//   GET /api/curator-feed?view=attribution   vault withdrawals vs utilization / rate (&limit=, total)
//   GET /api/curator-feed?view=flags         oracle kind / reverting / stale, one-borrower
//                                            markets, curator shifts (lib/curatorFeed/flags.ts)
//   GET /api/curator-feed?view=spikes        borrow-rate jumps and who moved the market
//                                            (&minUsd= market supply floor, &limit=, &only=reallocation|drained)
//
// DATA: written by scripts/collect-curator-feed.ts (pnpm curators:feed). LOCAL-FIRST:
// .data/curator-feed (the collector's live copy, updated in place by the tick) when it
// holds a feed, else the canonical copy in the private datasets repo
// ($MEMBRANE_DATASETS_DIR or ../membrane-datasets, dir curator-feed — board rule N18; no
// copy in public/). Read from disk, re-parsed only when the file changes. Status
// (pending / executable / history) is computed against the request clock, so a cap
// change leaves its timelock window without a re-collect. Cached: s-maxage 300.

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' })
  let q
  try {
    q = parseFeedQuery(req.query)
  } catch (e) {
    if (e instanceof QueryError) return res.status(400).json({ error: e.message })
    throw e
  }
  let feed: FeedFile
  try {
    feed = loadFeedFile()
  } catch (e) {
    return res.status(503).json({ error: unavailableError(e) })
  }
  const nowS = Math.floor(Date.now() / 1000)
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600')
  try {
    if (q.view === 'exposure') {
      const exposure = loadExposureFile()
      return res
        .status(200)
        .json(
          q.by === 'vault'
            ? buildVaultExposure(feed, exposure, q)
            : buildExposureResponse(feed, exposure, q),
        )
    }
    if (q.view === 'attribution') {
      const rows = buildAttributionResponse(feed, q, compact)
      return res.status(200).json({ rows: rows.slice(0, q.limit), total: rows.length })
    }
    if (q.view === 'flags') {
      return res.status(200).json(buildFlagsResponse(feed, loadExposureFile(), q, compact))
    }
    if (q.view === 'spikes') return res.status(200).json(buildSpikeResponse(feed, q, compact))
    return res.status(200).json(buildFeedResponse(feed, q, nowS))
  } catch (e) {
    if (e instanceof QueryError) return res.status(400).json({ error: e.message })
    throw e
  }
}
