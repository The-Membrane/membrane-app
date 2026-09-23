/**
 * THE RPC RING — probe, save, cycle (owner 2026-09-23: "probe, save and cycle through
 * them so we don't overload a single one").
 *
 * Free endpoints differ in exactly one thing that matters to a log scan: the widest
 * `eth_getLogs` block range each will serve. Tonight (2026-09-23) the picture was
 * Pocket 10,000 · BlockPI 5,000 · nodies 50 · blastapi/1rpc 10 · everything else dead
 * or refusing — and it changes week to week. So the ring is not a hard-coded list:
 *   1. PROBE each candidate for its real getLogs cap (a topic-filtered call at
 *      10k/5k/2k/1k/800/500/100 blocks, first success wins) and its latency;
 *   2. SAVE the table to public/data/rpc-ring.json with a timestamp, so the next
 *      process (and the page) starts from measured facts, re-probing only when stale;
 *   3. CYCLE: every getLogs call rotates to the next endpoint whose cap covers the
 *      requested span, so no single free tier carries the whole job. A failure marks
 *      the endpoint cold for a cooldown; the ring keeps spinning on the rest.
 * Every other RPC method goes through viem's ordinary fallback over the live endpoints.
 */
import { createPublicClient, fallback, http, parseAbiItem, type PublicClient } from 'viem'
import { mainnet } from 'viem/chains'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

export const CANDIDATES = [
  'https://eth.api.pocket.network',
  'https://ethereum.public.blockpi.network/v1/rpc/public',
  'https://eth.drpc.org',
  'https://ethereum-rpc.publicnode.com',
  'https://eth.llamarpc.com',
  'https://rpc.mevblocker.io',
  'https://rpc.flashbots.net/fast',
  'https://eth.merkle.io',
  'https://cloudflare-eth.com',
  'https://eth.api.onfinality.io/public',
  'https://mainnet.gateway.tenderly.co',
  'https://eth1.lava.build',
  'https://rpc.payload.de',
  'https://api.zan.top/eth-mainnet',
  'https://eth-pokt.nodies.app',
  'https://eth-mainnet.public.blastapi.io',
  'https://1rpc.io/eth',
]

export interface RingEntry {
  url: string
  /** Widest getLogs range that answered, in blocks. 0 = refused every size. */
  cap: number
  /** Latency of the successful probe call, ms. */
  ms: number
  /** Whether eth_blockNumber answered at all. */
  alive: boolean
}
export interface RingTable {
  probedAt: string
  entries: RingEntry[]
}

const PROBE_SIZES = [10_000n, 5_000n, 2_000n, 1_000n, 800n, 600n, 500n, 250n, 100n, 50n, 10n]
const PROBE_FROM = 21_600_000n
const PROBE_AGG = '0x37bC7498f4FF12C19678ee8fE19d713b87F6a9e6' as const // Chainlink ETH/USD aggregator
const ANSWER_UPDATED = parseAbiItem(
  'event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)',
)
export const RING_PATH = join(process.cwd(), 'public', 'data', 'rpc-ring.json')
/** A saved table older than this is re-probed before use. */
export const RING_STALE_MS = 6 * 3600 * 1000

export async function probeRing(candidates: string[] = CANDIDATES, extra: string[] = []): Promise<RingTable> {
  const urls = [...new Set([...extra, ...candidates])]
  const entries = await Promise.all(
    urls.map(async (url): Promise<RingEntry> => {
      const c = createPublicClient({ chain: mainnet, transport: http(url, { timeout: 12_000, retryCount: 0 }) })
      try {
        await c.getBlockNumber()
      } catch {
        return { url, cap: 0, ms: 0, alive: false }
      }
      for (const n of PROBE_SIZES) {
        const t = Date.now()
        try {
          await c.getLogs({ address: PROBE_AGG, event: ANSWER_UPDATED, fromBlock: PROBE_FROM, toBlock: PROBE_FROM + n - 1n })
          return { url, cap: Number(n), ms: Date.now() - t, alive: true }
        } catch {
          // A refusal at this size — pause briefly so a rate limit on one size
          // does not zero the endpoint, then try the next size down.
          await new Promise((r) => setTimeout(r, 250))
        }
      }
      return { url, cap: 0, ms: 0, alive: true }
    }),
  )
  entries.sort((a, b) => b.cap - a.cap || a.ms - b.ms)
  return { probedAt: new Date().toISOString(), entries }
}

/**
 * KEYS NEVER TOUCH DISK. A URL from RECORDER_RPC_URL (the keyed ones) is saved under the
 * alias `env:<host>` and re-resolved from RECORDER_RPC_URL at load time, so the table
 * under public/ (served by the app, tracked by git) holds only public hosts.
 */
const envUrls = (): string[] =>
  String(process.env.RECORDER_RPC_URL ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const aliasFor = (url: string): string => (envUrls().includes(url) ? `env:${new URL(url).host}` : url)
const resolveAlias = (u: string): string | null => {
  if (!u.startsWith('env:')) return u
  const host = u.slice(4)
  return envUrls().find((x) => new URL(x).host === host) ?? null
}

export function loadRing(): RingTable | null {
  try {
    const t = JSON.parse(readFileSync(RING_PATH, 'utf8')) as RingTable
    const entries = t.entries
      .map((e) => ({ ...e, url: resolveAlias(e.url) }))
      .filter((e): e is RingEntry => e.url !== null)
    return { ...t, entries }
  } catch {
    return null
  }
}
export function saveRing(t: RingTable): void {
  const redacted: RingTable = { ...t, entries: t.entries.map((e) => ({ ...e, url: aliasFor(e.url) })) }
  writeFileSync(RING_PATH, JSON.stringify(redacted, null, 2) + '\n')
}

/** Saved table if fresh, else probe + save. `extra` URLs (e.g. env) are probed too. */
export async function ensureRing(extra: string[] = [], maxAgeMs = RING_STALE_MS): Promise<RingTable> {
  const saved = loadRing()
  if (saved && Date.now() - Date.parse(saved.probedAt) < maxAgeMs && extra.every((u) => saved.entries.some((e) => e.url === u))) {
    return saved
  }
  const t = await probeRing(CANDIDATES, extra)
  saveRing(t)
  return t
}

/**
 * The cycling client. `getLogsRing` picks, round-robin, the next endpoint whose cap
 * covers the span; on failure the endpoint cools for `cooldownMs` and the next is tried.
 * Spans wider than the widest live cap are split into cap-sized pieces.
 */
export interface RingStat {
  host: string
  calls: number
  ok: number
  failed: number
  /** Blocks of getLogs range served successfully. */
  blocks: number
  /** Mean latency of successful calls, ms. */
  avgMs: number
}

export class RpcRing {
  private i = 0
  private cold = new Map<string, number>()
  private stat = new Map<string, { calls: number; ok: number; failed: number; blocks: number; ms: number }>()
  private clients = new Map<string, PublicClient>()
  readonly table: RingTable
  readonly minCap: number
  constructor(table: RingTable, private cooldownMs = 20_000) {
    this.table = table
    const live = table.entries.filter((e) => e.cap > 0)
    if (live.length === 0) throw new Error('rpc ring: no endpoint serves eth_getLogs — re-probe or add a keyed RPC')
    this.minCap = Math.min(...live.map((e) => e.cap))
  }
  /** Endpoints that serve at least `span` blocks and are not cooling. */
  private eligible(span: number): RingEntry[] {
    const now = Date.now()
    return this.table.entries.filter((e) => e.cap >= span && (this.cold.get(e.url) ?? 0) < now)
  }
  private client(url: string): PublicClient {
    let c = this.clients.get(url)
    if (!c) {
      c = createPublicClient({ chain: mainnet, transport: http(url, { timeout: 20_000, retryCount: 0 }) }) as PublicClient
      this.clients.set(url, c)
    }
    return c
  }
  /** Widest span any live endpoint serves right now. */
  maxCap(): number {
    const e = this.eligible(1)
    return e.length ? Math.max(...e.map((x) => x.cap)) : 0
  }
  /** One getLogs over [from, to], rotated across every endpoint that can serve it. */
  async getLogs<T>(args: Parameters<PublicClient['getLogs']>[0] & { fromBlock: bigint; toBlock: bigint }): Promise<T[]> {
    const span = Number(args.toBlock - args.fromBlock + 1n)
    let lastErr: unknown = null
    for (let attempt = 0; attempt < this.table.entries.length; attempt++) {
      const pool = this.eligible(span)
      if (pool.length === 0) break
      const e = pool[this.i++ % pool.length]
      const st = this.stat.get(e.url) ?? { calls: 0, ok: 0, failed: 0, blocks: 0, ms: 0 }
      this.stat.set(e.url, st)
      st.calls++
      const t0 = Date.now()
      try {
        const r = (await this.client(e.url).getLogs(args as any)) as T[]
        st.ok++
        st.blocks += span
        st.ms += Date.now() - t0
        return r
      } catch (err) {
        st.failed++
        lastErr = err
        this.cold.set(e.url, Date.now() + this.cooldownMs)
      }
    }
    throw new Error(`rpc ring: no endpoint served getLogs over ${span} blocks: ${String(lastErr).slice(0, 160)}`)
  }
  /** getLogs over any range, split into pieces no wider than the ring can serve. */
  async getLogsWide<T>(args: Parameters<PublicClient['getLogs']>[0] & { fromBlock: bigint; toBlock: bigint }): Promise<T[]> {
    const out: T[] = []
    let cursor = args.fromBlock
    // Start at the widest live cap; on a failure halve the piece (a narrower piece
    // is eligible on more endpoints) down to the smallest live cap, then wait out
    // one cooldown and try the floor once more before giving up.
    let span = BigInt(Math.max(this.maxCap(), this.minCap))
    const floor = BigInt(this.minCap)
    let waited = false
    while (cursor <= args.toBlock) {
      const to = cursor + span - 1n < args.toBlock ? cursor + span - 1n : args.toBlock
      try {
        out.push(...(await this.getLogs<T>({ ...args, fromBlock: cursor, toBlock: to })))
        cursor = to + 1n
        waited = false
      } catch (err) {
        if (span > floor) {
          span = span / 2n > floor ? span / 2n : floor
          continue
        }
        if (!waited) {
          waited = true
          await new Promise((r) => setTimeout(r, this.cooldownMs + 500))
          continue
        }
        throw err
      }
    }
    return out
  }
  /**
   * Who actually carried the work (owner 2026-09-23: "track which ones work the best
   * for us so I know what I want to actually pay for"). Hosts only — never keys.
   */
  stats(): RingStat[] {
    return [...this.stat.entries()]
      .map(([url, s]) => ({
        host: new URL(url).host,
        calls: s.calls,
        ok: s.ok,
        failed: s.failed,
        blocks: s.blocks,
        avgMs: s.ok ? Math.round(s.ms / s.ok) : 0,
      }))
      .sort((a, b) => b.blocks - a.blocks)
  }
  /** Append this run's stats to public/data/rpc-ring-stats.json (hosts only). */
  saveStats(runLabel: string): void {
    const path = join(process.cwd(), 'public', 'data', 'rpc-ring-stats.json')
    let prev: { runs: { run: string; at: string; stats: RingStat[] }[] } = { runs: [] }
    try {
      prev = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      /* first run */
    }
    const runs = prev.runs.filter((r) => r.run !== runLabel)
    runs.push({ run: runLabel, at: new Date().toISOString(), stats: this.stats() })
    writeFileSync(path, JSON.stringify({ runs }, null, 2) + '\n')
  }
  /** A plain viem client over the live endpoints for every non-getLogs call. */
  readClient(): PublicClient {
    const live = this.table.entries.filter((e) => e.alive)
    return createPublicClient({
      chain: mainnet,
      transport: fallback(live.map((e) => http(e.url, { timeout: 20_000, retryCount: 1 })), { rank: false, retryCount: 1 }),
    }) as PublicClient
  }
}
