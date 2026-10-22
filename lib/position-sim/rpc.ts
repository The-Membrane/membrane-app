/**
 * A read-only Ethereum mainnet client for the position simulator.
 *
 * WHY THIS IS SEPARATE FROM config/evm: the app's wagmi client targets local anvil
 * (config/evm/chains.ts) because that is where Membrane is deployed. The simulator
 * reads MAINNET lending positions from Aave / Morpho / Compound / Spark, which anvil
 * does not have. So it needs its own client, pointed at mainnet, and it is strictly
 * read-only — no signer is ever attached and no write method is exposed.
 *
 * Endpoints are keyless public RPCs. `NEXT_PUBLIC_MAINNET_RPC_URL` overrides the list
 * when a dedicated endpoint is available.
 */

import { createPublicClient, fallback, http, type PublicClient } from 'viem'
import { mainnet } from 'viem/chains'

/**
 * Keyless public mainnet endpoints for SERVER and script reads, in preference order (a
 * browser uses BROWSER_MAINNET_RPCS below). The Tenderly public gateway
 * is first because the Oct 10 dataset pull established it as the only free endpoint
 * that reliably served both archive state and large getLogs spans
 * (public/data/oct10-2025/manifest.json).
 */
export const PUBLIC_MAINNET_RPCS = [
  'https://gateway.tenderly.co/public/mainnet',
  'https://eth.llamarpc.com',
  'https://ethereum-rpc.publicnode.com',
  'https://rpc.ankr.com/eth',
  'https://eth.drpc.org',
] as const

/**
 * The endpoints a BROWSER reads from, in order. Checked 2026-10-16 with a real Chromium
 * preflight (a JSON POST from a local page), not curl:
 *   pass  ethereum-rpc.publicnode.com, eth.drpc.org, gateway.tenderly.co, rpc.mevblocker.io
 *   fail  eth.llamarpc.com and eth.merkle.io (CORS preflight blocked: net::ERR_FAILED);
 *         rpc.ankr.com/eth (now wants a key), 1rpc.io/eth (rate-limit error body) and
 *         cloudflare-eth.com ("cannot fulfill") answer 200 with an error, so they are left out.
 * Tenderly is not first here: it throttles (429) under one page's fan-out. It stays first in
 * PUBLIC_MAINNET_RPCS for server and script archive reads.
 */
export const BROWSER_MAINNET_RPCS = [
  'https://ethereum-rpc.publicnode.com',
  'https://eth.drpc.org',
  'https://gateway.tenderly.co/public/mainnet',
  'https://rpc.mevblocker.io',
] as const

/** Per-request timeout. A throttled or blocked endpoint fails fast and the next one answers. */
export const RPC_REQUEST_TIMEOUT_MS = 8_000

export interface MainnetClientOptions {
  /** Injected fetch, for tests (a 429-ing or CORS-failing endpoint). */
  fetchFn?: typeof fetch
  timeoutMs?: number
}

/**
 * A read-only mainnet client over `urls`. A 429, a CORS failure or a timeout moves to the
 * NEXT endpoint at once (no per-endpoint retry: retrying a throttled endpoint is what kept
 * the page "reading…"); the whole list is tried twice before the call fails.
 */
export function createMainnetClient(urls: readonly string[], o: MainnetClientOptions = {}): PublicClient {
  return createPublicClient({
    chain: mainnet,
    transport: fallback(
      urls.map((url) =>
        http(url, { timeout: o.timeoutMs ?? RPC_REQUEST_TIMEOUT_MS, retryCount: 0, ...(o.fetchFn ? { fetchFn: o.fetchFn } : {}) }),
      ),
      // rank:false keeps the declared order; a failed endpoint falls through to the next.
      { rank: false, retryCount: 1, retryDelay: 250 },
    ),
    batch: { multicall: { wait: 24 } },
  }) as PublicClient
}

let cached: PublicClient | null = null

export function getMainnetClient(): PublicClient {
  if (cached) return cached
  const override = process.env.NEXT_PUBLIC_MAINNET_RPC_URL
  // In a browser only endpoints that pass a CORS preflight; on a server, the archive order.
  const base = typeof window !== 'undefined' ? BROWSER_MAINNET_RPCS : PUBLIC_MAINNET_RPCS
  const urls = override ? [override, ...base] : [...base]
  cached = createMainnetClient(urls)
  return cached
}

/** Human-readable RPC label for the provenance stamp. */
export function rpcLabel(): string {
  const override = process.env.NEXT_PUBLIC_MAINNET_RPC_URL
  if (override) {
    try {
      return new URL(override).host
    } catch {
      return 'configured rpc'
    }
  }
  return 'public rpc'
}

/** Normalises and validates a user-pasted address. Returns null when it is not one. */
export function parseAddress(input: string): `0x${string}` | null {
  const s = input.trim()
  return /^0x[0-9a-fA-F]{40}$/.test(s) ? (s.toLowerCase() as `0x${string}`) : null
}

/** Scale a bigint down by `decimals` into a JS number. Positions are small enough
 *  that float precision is not a concern at display scale. */
export function toNumber(v: bigint, decimals: number): number {
  if (decimals === 0) return Number(v)
  const d = 10n ** BigInt(decimals)
  const whole = v / d
  const frac = v % d
  return Number(whole) + Number(frac) / Number(d)
}
