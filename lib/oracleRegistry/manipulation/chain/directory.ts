/**
 * Chainlink feed directory + a USD price helper.
 *
 * The directory (reference-data-directory.vercel.app) gives each mainnet feed's
 * deviation threshold and heartbeat. The deviation threshold is the free move a push
 * feed allows: its answer may sit up to `threshold` away from the market before an
 * update is forced. Keyed by both proxy and aggregator address, lowercased.
 */

export interface FeedDirEntry {
  proxy: string
  aggregator: string | null
  name: string
  deviationPct: number | null
  heartbeatSec: number | null
}

const DIRECTORY_URL = 'https://reference-data-directory.vercel.app/feeds-mainnet.json'

interface RawFeed {
  proxyAddress?: string
  contractAddress?: string
  name?: string
  threshold?: number
  heartbeat?: number
}

export async function fetchChainlinkDirectory(): Promise<{ entries: FeedDirEntry[]; deviationPct: Record<string, number> }> {
  const res = await fetch(DIRECTORY_URL)
  if (!res.ok) throw new Error(`chainlink directory: http ${res.status}`)
  const raw = (await res.json()) as RawFeed[]
  const entries: FeedDirEntry[] = []
  const deviationPct: Record<string, number> = {}
  for (const f of raw) {
    const proxy = (f.proxyAddress ?? f.contractAddress ?? '').toLowerCase()
    if (!proxy) continue
    const dev = typeof f.threshold === 'number' && f.threshold > 0 ? f.threshold : null
    const e: FeedDirEntry = {
      proxy,
      aggregator: f.contractAddress ? f.contractAddress.toLowerCase() : null,
      name: f.name ?? '',
      deviationPct: dev,
      heartbeatSec: typeof f.heartbeat === 'number' ? f.heartbeat : null,
    }
    entries.push(e)
    if (dev !== null) {
      deviationPct[proxy] = dev
      if (e.aggregator) deviationPct[e.aggregator] = dev
    }
  }
  return { entries, deviationPct }
}

/**
 * USD-per-whole-token resolver. Stablecoins are pinned to $1 (the manipulation engine
 * measures cost and EV in USD and never needs sub-cent precision on a stable); other
 * tokens are read from the Aave oracle and the Comet getPrice path supplied by the
 * caller. Unknown tokens default to $1 with a flag the caller can surface.
 */
const STABLES: Record<string, number> = {
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 1, // USDC
  '0xdac17f958d2ee523a2206206994597c13d831ec7': 1, // USDT
  '0x6b175474e89094c44da98b954eedeac495271d0f': 1, // DAI
  '0xdc035d45d973e3ec169d2276ddab16f1e407384f': 1, // USDS
  '0x4c9edd5852cd905f086c759e8383e09bff1e68b3': 1, // USDe
  '0x8292bb45bf1ee4d140127049757c2e0ff06317ed': 1, // RLUSD
  '0x6c3ea9036406852006290770bedfcaba0e23a0e8': 1, // PYUSD
  '0x853d955acef822db058eb8505911ed77f175b99e': 1, // FRAX
}

export class UsdPrices {
  private cache = new Map<string, number>()
  constructor(seed: Record<string, number> = {}) {
    for (const [k, v] of Object.entries({ ...STABLES, ...seed })) this.cache.set(k.toLowerCase(), v)
  }
  set(addr: string, usd: number): void {
    if (usd > 0) this.cache.set(addr.toLowerCase(), usd)
  }
  has(addr: string): boolean {
    return this.cache.has(addr.toLowerCase())
  }
  /** USD per whole token, or `fallback` (default 1) with no record. */
  get(addr: string, fallback = 1): number {
    return this.cache.get(addr.toLowerCase()) ?? fallback
  }
  isStable(addr: string): boolean {
    return addr.toLowerCase() in STABLES
  }
}
