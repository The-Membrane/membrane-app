import { readFileSync, statSync } from 'fs'
import { join } from 'path'
import type { NextApiRequest, NextApiResponse } from 'next'

import { compact } from '@/lib/curatorFeed/format'
import {
  buildAttributionResponse,
  buildExposureResponse,
  buildFeedResponse,
  buildVaultExposure,
  parseFeedQuery,
  QueryError,
} from '@/lib/curatorFeed/service'
import {
  parseExposureFile,
  parseFeedFile,
  type ExposureFile,
  type FeedFile,
} from '@/lib/curatorFeed/store'

// PUBLIC. Curator action feed — what Morpho / Euler Earn curators (and Aave v3, as the
// protocol-level analogue) changed on Ethereum mainnet: caps, removals, queues,
// timelocks, roles; clustered exits of one collateral across curators; which vaults
// hold which collateral; and large vault withdrawals measured against the market move.
//
//   GET /api/curator-feed                    feed (see lib/curatorFeed/service.ts)
//   GET /api/curator-feed?view=exposure      collateral → vaults at the head block (&by=vault: vault → markets)
//   GET /api/curator-feed?view=attribution   vault withdrawals vs utilization / rate
//
// DATA: public/data/curator-feed/*.json written by scripts/collect-curator-feed.ts
// (pnpm curators:feed). Read from disk, re-parsed only when the file changes. Status
// (pending / executable / history) is computed against the request clock, so a cap
// change leaves its timelock window without a re-collect. Cached: s-maxage 300.

const DIR = join(process.cwd(), 'public', 'data', 'curator-feed')

type Cached<T> = { mtimeMs: number; value: T }
let feedCache: Cached<FeedFile> | null = null
let exposureCache: Cached<ExposureFile> | null = null

function load<T>(name: string, parse: (raw: unknown) => T, cache: Cached<T> | null): Cached<T> {
  const path = join(DIR, name)
  const { mtimeMs } = statSync(path)
  if (cache && cache.mtimeMs === mtimeMs) return cache
  return { mtimeMs, value: parse(JSON.parse(readFileSync(path, 'utf8'))) }
}

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
    feedCache = load('feed.json', parseFeedFile, feedCache)
    feed = feedCache.value
  } catch (e) {
    return res.status(503).json({
      error: `curator feed dataset unavailable — run pnpm curators:feed (${String((e as Error).message).slice(0, 120)})`,
    })
  }
  const nowS = Math.floor(Date.now() / 1000)
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600')
  try {
    if (q.view === 'exposure') {
      exposureCache = load('exposure.json', parseExposureFile, exposureCache)
      return res
        .status(200)
        .json(
          q.by === 'vault'
            ? buildVaultExposure(feed, exposureCache.value, q)
            : buildExposureResponse(feed, exposureCache.value, q),
        )
    }
    if (q.view === 'attribution')
      return res.status(200).json({ rows: buildAttributionResponse(feed, q, compact) })
    return res.status(200).json(buildFeedResponse(feed, q, nowS))
  } catch (e) {
    if (e instanceof QueryError) return res.status(400).json({ error: e.message })
    throw e
  }
}
