import type { NextApiRequest, NextApiResponse } from 'next'

import { fetchMerklOpportunities } from '@/lib/netApy/incentives'
import { AnchorNotFinalizedError, readAllVenues, type SnapshotSet } from '@/lib/netApy/read'
import { netApyClient, redactError } from '@/lib/netApy/rpc'
import {
  handleNetApy,
  parseQuery,
  QueryError,
  serialize,
  type NetApyDeps,
  type NetApyListResponse,
  type NetApyVenueResponse,
  type Serialized,
} from '@/lib/netApy/service'
import {
  loadLatestSnapshotSet,
  loadMerklPull,
  loadPinnedSnapshotSet,
  saveMerklPull,
  saveSnapshotSet,
} from '@/lib/netApy/store'
import { asOfOf } from '@/lib/netApy/types'
import { NET_APY_VENUES } from '@/lib/netApy/venues'

// PUBLIC. Net APY at the user's size, per venue — a PROJECTION from on-chain IRM
// parameters read at one block, never a promise.
//
//   GET /api/net-apy?size=100000&side=supply              every venue, compact rows
//   GET /api/net-apy?venue=aave-v3-usdc&size=1000000      one venue's full breakdown
//       &side=supply|borrow   &path=1 (rate-spike axis)   &block=<n> (pinned read)
//       &protocolShare=&curatorShare=  (0–1, a what-if; omitted = "curator-set")
//
// DATA: chain reads at the anchor (lib/netApy/read.ts) over RPC from .env.local
// aliases (lib/netApy/rpc.ts — only `env:<host>` ever leaves the process), Merkl's
// public API for incentives. LOCAL-FIRST: both are kept as JSON under .data/net-apy
// (lib/netApy/store.ts) — no Neon. A live (finalized-anchor) read is reused for 120 s
// of wall clock, measured from when it was read (`asOf`), not from its block's time;
// a pinned block is reused forever. Merkl is reused for 15 min.

const LATEST_MAX_AGE_S = 120
const MERKL_MAX_AGE_S = 15 * 60

let memLatest: SnapshotSet | null = null
let memMerkl: { fetchedAt: number; opportunities: Awaited<ReturnType<typeof fetchMerklOpportunities>> } | null = null

const nowS = () => Math.floor(Date.now() / 1000)

const deps: NetApyDeps = {
  snapshots: async (block) => {
    if (block !== undefined) {
      const stored = loadPinnedSnapshotSet(block)
      if (stored) return stored
      const { client, label } = netApyClient()
      const set = await readAllVenues(client, NET_APY_VENUES, label, block)
      saveSnapshotSet(set)
      return set
    }
    if (memLatest && nowS() - asOfOf(memLatest) <= LATEST_MAX_AGE_S) return memLatest
    const stored = loadLatestSnapshotSet(LATEST_MAX_AGE_S)
    if (stored) return (memLatest = stored)
    const { client, label } = netApyClient()
    const set = await readAllVenues(client, NET_APY_VENUES, label)
    saveSnapshotSet(set)
    return (memLatest = set)
  },
  merkl: async () => {
    if (memMerkl && nowS() - memMerkl.fetchedAt <= MERKL_MAX_AGE_S) return memMerkl
    const stored = loadMerklPull(MERKL_MAX_AGE_S)
    if (stored) return (memMerkl = stored)
    const pull = { fetchedAt: nowS(), opportunities: await fetchMerklOpportunities() }
    saveMerklPull(pull)
    return (memMerkl = pull)
  },
}

export type NetApyResponse = Serialized<NetApyVenueResponse> | Serialized<NetApyListResponse>

export default async function handler(req: NextApiRequest, res: NextApiResponse<NetApyResponse | { error: string; validVenues?: string[] }>) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' })
  let query
  try {
    query = parseQuery(req.query)
  } catch (e) {
    if (e instanceof QueryError) {
      return res.status(e.status).json({ error: e.message, validVenues: e.status === 404 ? NET_APY_VENUES.map((v) => v.venueKey) : undefined })
    }
    throw e
  }
  try {
    const body = await handleNetApy(query, deps)
    res.setHeader('Cache-Control', query.block !== undefined ? 'public, s-maxage=86400' : 'public, s-maxage=60, stale-while-revalidate=300')
    return res.status(200).json(serialize(body) as NetApyResponse)
  } catch (e) {
    if (e instanceof AnchorNotFinalizedError) return res.status(400).json({ error: e.message })
    // The message names the failed call; redactError strips any RPC URL (rpc.ts).
    return res.status(502).json({ error: redactError(e) })
  }
}
