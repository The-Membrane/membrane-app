import type { NextApiRequest, NextApiResponse } from 'next'
import {
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  erc20Abi,
  erc4626Abi,
  fallback,
  getAddress,
  http,
  isAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'
import { mainnet } from 'viem/chains'

import {
  aboveDust,
  buildHolderView,
  curatedVaults,
  judgeRead,
  type ChunkResult,
  type HolderView,
} from '@/lib/curatorFeed/holder'
import { HOLDER_IP_LIMIT, HOLDER_RPC_BUDGET, LIMIT_COPY, singleFlight, WindowCounter } from '@/lib/curatorFeed/holderLimits'
import type { FeedFile } from '@/lib/curatorFeed/store'
import { loadFeedFile, unavailableError } from '@/pages/api/_lib/curatorFeedFiles'

// GET /api/curator-feed/holder?address=0x…  YOUR CURATORS THIS WEEK (Today, Safety block).
//
// Address-specific, read-only, no signature. Two reads, nothing modelled:
//   1. HOLDINGS, live on chain at request time: balanceOf(address) on every curated vault
//      the curator feed knows (MetaMorpho V1, Vault V2, Euler Earn) through Multicall3
//      aggregate3 in chunks; then, for each vault with shares, convertToAssets + decimals
//      for the dust rule (lib/curatorFeed/holder.ts aboveDust: ≥ $1 at the feed's price,
//      else ≥ 1e-6 of a share). Shares posted as collateral or wrapped elsewhere are not
//      in balanceOf and are not counted.
//   2. CHANGES, from the curator feed dataset, filtered by buildHolderView.
// A read with a rejected chunk, or more failed calls than judgeRead allows, is a 503
// ("holdings read unavailable") and is never cached: an RPC outage must not read as
// "holds nothing". `view: null` = a clean read found no curated vault above dust.
// Limits (lib/curatorFeed/holderLimits.ts): per-IP requests, a global per-minute budget
// of RPC requests, one read in flight per address. RPC: RECORDER_RPC_URL, as the Radar.

export interface HolderResponse {
  address: string
  /** When the holdings were read, ISO. */
  readAt: string
  view: HolderView | null
}

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const
const aggregate3Abi = [
  {
    type: 'function',
    name: 'aggregate3',
    // payable on chain; declared view so it is read with eth_call.
    stateMutability: 'view',
    inputs: [
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'target', type: 'address' },
          { name: 'allowFailure', type: 'bool' },
          { name: 'callData', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      {
        name: 'returnData',
        type: 'tuple[]',
        components: [
          { name: 'success', type: 'bool' },
          { name: 'returnData', type: 'bytes' },
        ],
      },
    ],
  },
] as const

/** Calls per aggregate3 request. */
const CHUNK = 150

function client(): PublicClient {
  const raw = process.env.RECORDER_RPC_URL
  if (!raw) throw new Error('RECORDER_RPC_URL is not set')
  const urls = raw.split(',').map((u) => u.trim()).filter(Boolean)
  const transport =
    urls.length === 1 ? http(urls[0]) : fallback(urls.map((u) => http(u, { timeout: 15_000 })), { rank: false })
  return createPublicClient({ chain: mainnet, transport }) as PublicClient
}

type Call = { target: Address; callData: Hex }
const chunksOf = <T,>(xs: T[], n: number): T[][] =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n))

/** Each chunk is one eth_call; a rejected request is `{ ok: false }`, never thrown. */
async function aggregate(c: PublicClient, calls: Call[]): Promise<ChunkResult<Hex>[]> {
  return Promise.all(
    chunksOf(calls, CHUNK).map(async (chunk): Promise<ChunkResult<Hex>> => {
      try {
        const res = await c.readContract({
          address: MULTICALL3,
          abi: aggregate3Abi,
          functionName: 'aggregate3',
          args: [chunk.map((x) => ({ target: x.target, allowFailure: true, callData: x.callData }))],
        })
        return {
          ok: true,
          calls: res.map((r) =>
            r.success && r.returnData !== '0x' ? { ok: true as const, value: r.returnData } : { ok: false as const },
          ),
        }
      } catch {
        return { ok: false }
      }
    }),
  )
}
const flat = <T,>(chunks: ChunkResult<T>[]) => chunks.flatMap((c) => (c.ok ? c.calls : []))

class Refused extends Error {}
class Unavailable extends Error {}

const rpcBudget = new WindowCounter(HOLDER_RPC_BUDGET)
const perIp = new WindowCounter(HOLDER_IP_LIMIT)
const spend = (requests: number) => {
  if (!rpcBudget.take('rpc', Date.now(), requests)) throw new Refused(LIMIT_COPY.budget)
}

/** The curated vaults (lowercase) where `owner` holds more than dust. */
async function heldVaults(owner: Address, feed: FeedFile): Promise<string[]> {
  const vaults = curatedVaults(feed)
  const c = client()
  spend(Math.ceil(vaults.length / CHUNK))
  const balanceData = encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [owner] })
  const balChunks = await aggregate(
    c,
    vaults.map((v) => ({ target: v as Address, callData: balanceData })),
  )
  if (!judgeRead(balChunks, vaults.length).ok) throw new Unavailable()
  const bal = flat(balChunks)
  const withShares = vaults
    .map((v, i) => {
      const r = bal[i]
      const shares = r.ok ? decodeFunctionResult({ abi: erc20Abi, functionName: 'balanceOf', data: r.value }) : 0n
      return { vault: v, shares }
    })
    .filter((x) => x.shares > 0n)
  if (withShares.length === 0) return []

  // Dust: convertToAssets(shares) and decimals() for each vault with shares.
  const calls: Call[] = withShares.flatMap((x) => [
    {
      target: x.vault as Address,
      callData: encodeFunctionData({ abi: erc4626Abi, functionName: 'convertToAssets', args: [x.shares] }),
    },
    { target: x.vault as Address, callData: encodeFunctionData({ abi: erc20Abi, functionName: 'decimals' }) },
  ])
  spend(Math.ceil(calls.length / CHUNK))
  const dustChunks = await aggregate(c, calls)
  if (!judgeRead(dustChunks, calls.length).ok) throw new Unavailable()
  const dust = flat(dustChunks)
  return withShares
    .filter((x, i) => {
      const a = dust[2 * i]
      const d = dust[2 * i + 1]
      // A vault whose follow-up reads failed keeps the old rule (shares > 0): it is held.
      if (!a.ok || !d.ok) return true
      const info = feed.entities.vaults[x.vault]
      const token = feed.entities.tokens[info.asset]
      return aboveDust({
        vault: x.vault,
        shares: x.shares,
        shareDecimals: decodeFunctionResult({ abi: erc20Abi, functionName: 'decimals', data: d.value }),
        assets: decodeFunctionResult({ abi: erc4626Abi, functionName: 'convertToAssets', data: a.value }),
        assetDecimals: token?.decimals ?? 18,
        priceUsd: token?.priceUsd,
      })
    })
    .map((x) => x.vault)
}

// Clean reads only, one per address per 5 minutes per server.
const TTL_MS = 5 * 60_000
const MAX_ENTRIES = 256
const cache = new Map<string, { at: number; held: string[] }>()
const inFlight = new Map<string, Promise<{ at: number; held: string[] }>>()

const clientIp = (req: NextApiRequest): string => {
  const fwd = req.headers['x-forwarded-for']
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim()
  return first || req.socket?.remoteAddress || 'unknown'
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' })
  const raw = Array.isArray(req.query.address) ? req.query.address[0] : req.query.address
  if (!raw || !isAddress(raw)) return res.status(400).json({ error: 'invalid address' })
  const address = getAddress(raw)
  if (!perIp.take(clientIp(req), Date.now())) return res.status(429).json({ error: LIMIT_COPY.ip })

  let feed: FeedFile
  try {
    feed = loadFeedFile()
  } catch (e) {
    return res.status(503).json({ error: unavailableError(e) })
  }

  let hit = cache.get(address)
  if (!hit || Date.now() - hit.at > TTL_MS) {
    try {
      hit = await singleFlight(inFlight, address, () =>
        heldVaults(address, feed).then((held) => ({ at: Date.now(), held })),
      )
    } catch (e) {
      if (e instanceof Refused) return res.status(429).json({ error: e.message })
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
