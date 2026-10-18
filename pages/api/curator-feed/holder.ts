import type { NextApiRequest, NextApiResponse } from 'next'
import { createPublicClient, erc20Abi, fallback, getAddress, http, isAddress, type Address, type PublicClient } from 'viem'
import { mainnet } from 'viem/chains'

import { buildHolderView, curatedVaults, type HolderView } from '@/lib/curatorFeed/holder'
import { loadFeedFile, unavailableError } from '@/pages/api/_lib/curatorFeedFiles'

// GET /api/curator-feed/holder?address=0x…  YOUR CURATORS THIS WEEK (Today, Safety block).
//
// Address-specific, read-only, no signature. Two reads, nothing modelled:
//   1. HOLDINGS, live on chain at request time: balanceOf(address) on every curated vault
//      the curator feed knows (MetaMorpho V1, Vault V2, Euler Earn), one multicall.
//      Shares > 0 = held. No USD, no amounts: the block names vaults, not balances.
//   2. CHANGES, from the curator feed dataset (scripts/collect-curator-feed.ts), filtered
//      by lib/curatorFeed/holder.ts buildHolderView to the actions those vaults emitted in
//      the 7 days ending at the feed's newest collected block.
// `view: null` = the address holds no curated vault the feed knows (the block prints
// nothing). RPC: RECORDER_RPC_URL, the same endpoint list the Radar reads with.

export interface HolderResponse {
  address: string
  /** When the holdings were read, ISO. */
  readAt: string
  view: HolderView | null
}

function client(): PublicClient {
  const raw = process.env.RECORDER_RPC_URL
  if (!raw) throw new Error('RECORDER_RPC_URL is not set')
  const urls = raw.split(',').map((u) => u.trim()).filter(Boolean)
  const transport =
    urls.length === 1 ? http(urls[0]) : fallback(urls.map((u) => http(u, { timeout: 15_000 })), { rank: false })
  return createPublicClient({ chain: mainnet, transport }) as PublicClient
}

/** The vaults (lowercase) where `owner` holds shares. A failed call is not a holding. */
async function heldVaults(owner: Address, vaults: string[]): Promise<string[]> {
  const res = await client().multicall({
    contracts: vaults.map((v) => ({
      address: v as Address,
      abi: erc20Abi,
      functionName: 'balanceOf' as const,
      args: [owner] as const,
    })),
    allowFailure: true,
    batchSize: 32_768,
  })
  return vaults.filter((_, i) => res[i].status === 'success' && (res[i].result as bigint) > 0n)
}

// One read per address per 5 minutes per server (the Today example address is read on
// every visit with no address entered).
const TTL_MS = 5 * 60_000
const MAX_ENTRIES = 256
const cache = new Map<string, { at: number; held: string[] }>()

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' })
  const raw = Array.isArray(req.query.address) ? req.query.address[0] : req.query.address
  if (!raw || !isAddress(raw)) return res.status(400).json({ error: 'invalid address' })
  const address = getAddress(raw)

  let feed
  try {
    feed = loadFeedFile()
  } catch (e) {
    return res.status(503).json({ error: unavailableError(e) })
  }

  const now = Date.now()
  let hit = cache.get(address)
  if (!hit || now - hit.at > TTL_MS) {
    try {
      hit = { at: now, held: await heldVaults(address, curatedVaults(feed)) }
    } catch {
      return res.status(503).json({ error: 'holdings read unavailable' })
    }
    if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value as string)
    cache.set(address, hit)
  }

  const body: HolderResponse = {
    address,
    readAt: new Date(hit.at).toISOString(),
    view: buildHolderView(feed, hit.held),
  }
  res.setHeader('Cache-Control', 'private, max-age=300')
  return res.status(200).json(body)
}
