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
 * Keyless public mainnet endpoints, in preference order. The Tenderly public gateway
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

let cached: PublicClient | null = null

export function getMainnetClient(): PublicClient {
  if (cached) return cached
  const override = process.env.NEXT_PUBLIC_MAINNET_RPC_URL
  const urls = override ? [override, ...PUBLIC_MAINNET_RPCS] : [...PUBLIC_MAINNET_RPCS]
  cached = createPublicClient({
    chain: mainnet,
    // rank:false keeps the declared order; a failed endpoint falls through to the next.
    transport: fallback(
      urls.map((url) => http(url, { timeout: 12_000, retryCount: 1 })),
      { rank: false, retryCount: 1 },
    ),
    batch: { multicall: { wait: 24 } },
  }) as PublicClient
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
