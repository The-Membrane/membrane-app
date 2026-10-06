/**
 * Mainnet client for net-APY-at-size. Server-side only.
 *
 * URL ORDER: NET_APY_RPC_URL, then RECORDER_RPC_URL (the recorder's keyed mainnet list,
 * comma-separated), then NEXT_PUBLIC_MAINNET_RPC_URL — all from .env.local — then two
 * keyless endpoints that served ARCHIVE reads on 2026-10-05 (a pinned-block read needs
 * archive state; publicnode refuses it without a token, so it is last and only good
 * for latest-block reads).
 *
 * KEYS NEVER LEAVE THE PROCESS. A URL that came from the env is labelled
 * `env:<host>` (lib/position-sim/rpcRing.ts convention) and only the label is ever
 * returned, stored or rendered.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { createPublicClient, fallback, http, type PublicClient } from 'viem'
import { mainnet } from 'viem/chains'

export const PUBLIC_ARCHIVE_RPCS = [
  'https://gateway.tenderly.co/public/mainnet',
  'https://eth.drpc.org',
  'https://ethereum-rpc.publicnode.com',
] as const

const ENV_KEYS = ['NET_APY_RPC_URL', 'RECORDER_RPC_URL', 'NEXT_PUBLIC_MAINNET_RPC_URL'] as const

/**
 * Next injects .env.local into API routes; vitest and tsx scripts get nothing, so for
 * them the file is hand-parsed (same approach as scripts/lib/venue-reads.mjs). Values
 * are returned to the caller only — never logged.
 */
function envValue(key: string): string | undefined {
  if (process.env[key]) return process.env[key]
  try {
    const env = readFileSync(join(process.cwd(), '.env.local'), 'utf8')
    return (env.match(new RegExp(`^${key}=(.*)$`, 'm')) || [])[1]?.trim().replace(/^["']|["']$/g, '') || undefined
  } catch {
    return undefined
  }
}

export function envRpcUrls(): string[] {
  const out: string[] = []
  for (const k of ENV_KEYS) {
    for (const u of String(envValue(k) ?? '').split(',')) {
      const s = u.trim()
      if (s && !out.includes(s)) out.push(s)
    }
  }
  return out
}

const host = (u: string): string => {
  try {
    return new URL(u).host
  } catch {
    return 'invalid-url'
  }
}

/** Display label for the endpoint list: env hosts as `env:<host>`, public hosts bare. */
export function rpcLabel(envUrls: string[]): string {
  const first = envUrls[0]
  return first ? `env:${host(first)}` : `public:${host(PUBLIC_ARCHIVE_RPCS[0])}`
}

let cached: { client: PublicClient; label: string } | null = null

export function netApyClient(): { client: PublicClient; label: string } {
  if (cached) return cached
  const env = envRpcUrls()
  const urls = [...env, ...PUBLIC_ARCHIVE_RPCS.filter((u) => !env.includes(u))]
  const client = createPublicClient({
    chain: mainnet,
    transport: fallback(
      urls.map((u) => http(u, { timeout: 15_000, retryCount: 1 })),
      { rank: false, retryCount: 1 },
    ),
    // One venue is ~6 reads at the same block; batching folds them into Multicall3.
    batch: { multicall: { wait: 16 } },
  }) as PublicClient
  cached = { client, label: rpcLabel(env) }
  return cached
}

/** First line of an error, with any URL replaced — viem puts the endpoint (and its key)
 *  on later lines and sometimes inline. Use on every message that leaves the server. */
export function redactError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  return (msg.split('\n')[0] ?? '').replace(/https?:\/\/\S+/g, '[rpc]').slice(0, 300)
}
