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
 * `env:<domain>`, its provider's registrable domain only (`env:alchemy.com`, `env:quiknode.pro`),
 * and only the label is ever returned, stored or rendered. The label is published (the
 * carry-scout weekly file's `rpc`, the net-APY API), so it never carries an account-specific
 * subdomain (QuickNode `<id>.ethereum-mainnet.quiknode.pro`), a path, a query, a port or
 * credentials. Errors go through `redactError`, which masks env hosts to the same label.
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
    return (
      (env.match(new RegExp(`^${key}=(.*)$`, 'm')) || [])[1]?.trim().replace(/^["']|["']$/g, '') ||
      undefined
    )
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

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

/**
 * The provider part of an RPC URL: its registrable domain, taken as the host's last two
 * labels (eth-mainnet.g.alchemy.com → alchemy.com, <id>.ethereum-mainnet.quiknode.pro →
 * quiknode.pro). A two-part public suffix (co.uk) gives only that suffix: less informative,
 * never more revealing. An IP address has no domain to show.
 */
export function providerDomain(u: string): string {
  let h: string
  try {
    h = new URL(u).hostname.toLowerCase().replace(/\.$/, '')
  } catch {
    return 'invalid-url'
  }
  if (!h) return 'invalid-url'
  if (h.startsWith('[') || IPV4.test(h)) return 'ip-address'
  return h.split('.').slice(-2).join('.')
}

/** Display label for the endpoint list: the first env URL as `env:<domain>`, else the
 *  first public endpoint's own host as `public:<host>` (a fixed public URL, no account). */
export function rpcLabel(envUrls: string[]): string {
  const first = envUrls[0]
  return first ? `env:${providerDomain(first)}` : `public:${host(PUBLIC_ARCHIVE_RPCS[0])}`
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

let envHostsCache: string[] | null = null

/** Hostnames of the env RPC URLs, longest first (an alternation then prefers the full host). */
const envHosts = (envUrls?: string[]): string[] => {
  const of = (urls: string[]) =>
    [
      ...new Set(
        urls.flatMap((u) => {
          try {
            const h = new URL(u).hostname.toLowerCase()
            return h ? [h] : []
          } catch {
            return []
          }
        }),
      ),
    ].sort((a, b) => b.length - a.length)
  if (envUrls) return of(envUrls)
  if (!envHostsCache) envHostsCache = of(envRpcUrls())
  return envHostsCache
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** First line of an error, with any URL replaced — viem puts the endpoint (and its key)
 *  on later lines and sometimes inline — and any env RPC host named without a scheme
 *  (`getaddrinfo ENOTFOUND <host>`) masked to its `env:<domain>` label. Use on every
 *  message that leaves the server. `envUrls` defaults to this process's env RPC URLs. */
export function redactError(e: unknown, envUrls?: string[]): string {
  const msg = e instanceof Error ? e.message : String(e)
  let out = (msg.split('\n')[0] ?? '').replace(/(?:https?|wss?):\/\/\S+/gi, '[rpc]')
  const hosts = envHosts(envUrls)
  // One pass, so a label already written is never masked again.
  if (hosts.length)
    out = out.replace(
      // the host and anything glued to it (`<host>/<key>`, `<host>:443/...`): only the label stays
      new RegExp(`(${hosts.map(escapeRe).join('|')})\\S*`, 'gi'),
      (_m, h: string) => `env:${providerDomain(`https://${h}`)}`,
    )
  return out.slice(0, 300)
}
