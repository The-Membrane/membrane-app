/**
 * JSON-RPC client for the curator-feed collector. fetch only — no viem — so it runs
 * under tsx, bun or node's type stripping without installing anything.
 *
 * ENDPOINTS: CURATOR_FEED_RPC_URLS, then RECORDER_RPC_URL (comma-separated; its first
 * entry is the keyed archive endpoint) from the environment or .env.local, then keyless
 * archive endpoints. KEYS NEVER LEAVE THE PROCESS: an env URL is known only by its
 * label `env:<host>`, and every error message is scrubbed of env URLs before it is
 * thrown, logged or stored.
 *
 * getLogs INTEGRITY (2026-10-07 measurements, see the board entry):
 *   - eth.api.pocket.network answered a 50,000-block topic query with 659 logs where
 *     the true count was 1,008 — no error, just fewer logs. Split into 10,000-block
 *     chunks it matched (149 = 149).
 *   - lib/position-sim/rpcRing.ts getLogsWide can hand back false-EMPTY chunks.
 * So every chunk is read from one endpoint and, when it comes back EMPTY or when
 * `dual` is set, read again from a different endpoint; the result is the UNION by
 * (blockNumber, logIndex). A short endpoint can only omit logs, never invent them, so
 * the union is never worse than either read. Disagreements are counted and stored in
 * the dataset's meta.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

export interface Endpoint {
  url: string
  label: string
  /** Widest getLogs span this endpoint is trusted with. */
  logSpan: number
  /** Accepts JSON-RPC batch arrays. */
  batch: boolean
}

/**
 * Keyless endpoints measured 2026-10-07 (archive eth_call / getLogs span / batch):
 * logSpan 0 = do not use for getLogs. drpc refuses batches of more than 3 on its free
 * plan; blastapi and nodies refuse 10k-block getLogs but serve archive calls.
 */
export const PUBLIC_ENDPOINTS: Omit<Endpoint, 'label'>[] = [
  { url: 'https://gateway.tenderly.co/public/mainnet', logSpan: 10_000, batch: true },
  { url: 'https://mainnet.gateway.tenderly.co', logSpan: 10_000, batch: true },
  { url: 'https://rpc.mevblocker.io', logSpan: 10_000, batch: true },
  // Pocket returned FEWER logs than a second endpoint in all 23 disagreements of the
  // 2026-10-07 182-day run (12,035 logs recovered by re-reads), so it serves calls only.
  { url: 'https://eth.api.pocket.network', logSpan: 0, batch: true },
  { url: 'https://eth.drpc.org', logSpan: 10_000, batch: false },
  { url: 'https://eth-mainnet.public.blastapi.io', logSpan: 0, batch: true },
  { url: 'https://eth-pokt.nodies.app', logSpan: 0, batch: true },
]

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

const host = (u: string): string => {
  try {
    return new URL(u).host
  } catch {
    return 'invalid-url'
  }
}

export function endpointsFromEnv(): Endpoint[] {
  const out: Endpoint[] = []
  for (const k of ['CURATOR_FEED_RPC_URLS', 'RECORDER_RPC_URL']) {
    for (const raw of String(envValue(k) ?? '').split(',')) {
      const url = raw.trim()
      if (url && !out.some((e) => e.url === url))
        out.push({ url, label: `env:${host(url)}`, logSpan: 10_000, batch: true })
    }
  }
  for (const p of PUBLIC_ENDPOINTS)
    if (!out.some((e) => e.url === p.url)) out.push({ ...p, label: host(p.url) })
  return out
}

export interface RpcLog {
  address: string
  topics: string[]
  data: string
  blockNumber: string
  logIndex: string
  transactionHash: string
  blockTimestamp?: string
}

export interface LogFilter {
  address?: string | string[]
  topics: (string | string[] | null)[]
}

export interface LogStats {
  chunks: number
  /** Chunks read from a second endpoint (empty, or dual mode). */
  rechecked: number
  /** Rechecks where the second endpoint returned a log the first did not. */
  disagreements: number
  /** Logs only the recheck found. */
  recovered: number
  /** Chunks that came back empty from every endpoint asked. */
  emptyConfirmed: number
  /** Endpoint label → chunks where it returned FEWER logs than the other read. */
  shortBy: Record<string, number>
  /** Endpoint label → chunks served. */
  servedBy: Record<string, number>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class FeedRpc {
  private cold = new Map<string, number>()
  private rr = 0
  readonly logStats: LogStats = {
    chunks: 0,
    rechecked: 0,
    disagreements: 0,
    recovered: 0,
    emptyConfirmed: 0,
    servedBy: {},
    shortBy: {},
  }
  calls = 0

  constructor(
    readonly endpoints: Endpoint[],
    private timeoutMs = 30_000,
  ) {
    if (endpoints.length === 0) throw new Error('curator-feed rpc: no endpoints')
  }

  /** Remove every env URL (and its path/query) from a message. */
  scrub(msg: string): string {
    let s = msg
    for (const e of this.endpoints) if (e.label.startsWith('env:')) s = s.split(e.url).join(e.label)
    return s.replace(/https?:\/\/[^\s"']+/g, (u) => {
      const ep = this.endpoints.find((e) => u.startsWith(e.url))
      return ep ? ep.label : host(u)
    })
  }

  private strikes = new Map<string, number>()
  /** Cool an endpoint; repeated failures (rate limits above all) cool it longer. */
  private cool(e: Endpoint, err: unknown): void {
    const limited = /429|rate.?limit|too many/i.test(String(err))
    const n = (this.strikes.get(e.url) ?? 0) + 1
    this.strikes.set(e.url, n)
    const ms = Math.min(120_000, (limited ? 10_000 : 5_000) * 2 ** Math.min(n - 1, 4))
    this.cold.set(e.url, Date.now() + ms)
  }
  private ok(e: Endpoint): void {
    this.strikes.delete(e.url)
  }

  /** Endpoints not cooling that pass `fit`; waits for the first to warm when all are cold. */
  private async live(fit: (e: Endpoint) => boolean = () => true): Promise<Endpoint[]> {
    const pool = this.endpoints.filter(fit)
    if (pool.length === 0) throw new Error('curator-feed rpc: no endpoint fits this request')
    for (;;) {
      const now = Date.now()
      const warm = pool.filter((e) => (this.cold.get(e.url) ?? 0) <= now)
      if (warm.length) {
        const i = this.rr++ % warm.length
        return [...warm.slice(i), ...warm.slice(0, i)]
      }
      await sleep(Math.max(250, Math.min(...pool.map((e) => this.cold.get(e.url) ?? 0)) - now))
    }
  }

  private async post(e: Endpoint, body: unknown): Promise<any> {
    this.calls++
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), this.timeoutMs)
    try {
      const r = await fetch(e.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctl.signal,
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return await r.json()
    } catch (err) {
      throw new Error(this.scrub(`${e.label}: ${String((err as Error)?.message ?? err)}`))
    } finally {
      clearTimeout(t)
    }
  }

  /** One call, rotated across endpoints; failures cool the endpoint and the next is tried. */
  async call<T = any>(method: string, params: unknown[]): Promise<T> {
    let last: unknown
    for (let attempt = 0; attempt < 12; attempt++) {
      const [e] = await this.live()
      try {
        const j = await this.post(e, { jsonrpc: '2.0', id: 1, method, params })
        if (j.error) {
          if (isRevert(j.error))
            throw Object.assign(new Error(`revert: ${j.error.message}`), { revert: true })
          throw new Error(this.scrub(`${e.label}: ${j.error.message ?? JSON.stringify(j.error)}`))
        }
        this.ok(e)
        return j.result as T
      } catch (err) {
        if ((err as { revert?: boolean }).revert) throw err
        last = err
        this.cool(e, err)
      }
    }
    throw new Error(this.scrub(`${method} failed after 12 attempts: ${String(last)}`))
  }

  /**
   * Many calls. Batch-capable endpoints get JSON-RPC arrays of `size`; a failed batch is
   * retried on the next endpoint, then call by call. Results keep input order; a call
   * that reverts resolves to null (a revert is an answer, not an outage).
   */
  async batch(
    calls: { method: string; params: unknown[] }[],
    size = 40,
    concurrency = 4,
  ): Promise<(any | null)[]> {
    const out: (any | null)[] = new Array(calls.length).fill(null)
    const groups: number[][] = []
    for (let i = 0; i < calls.length; i += size)
      groups.push(Array.from({ length: Math.min(size, calls.length - i) }, (_, k) => i + k))
    let next = 0
    const worker = async () => {
      for (;;) {
        const g = next++
        if (g >= groups.length) return
        const idx = groups[g]
        let done = false
        for (let attempt = 0; attempt < 8 && !done; attempt++) {
          const [e] = await this.live((x) => x.batch)
          try {
            const res = await this.post(
              e,
              idx.map((i, k) => ({ jsonrpc: '2.0', id: k, ...calls[i] })),
            )
            if (!Array.isArray(res))
              throw new Error(`batch: non-array reply ${JSON.stringify(res).slice(0, 80)}`)
            const byId = new Map<number, any>(res.map((r: any) => [Number(r.id), r]))
            // A rate-limit or server error on any member means the batch is not trusted.
            const bad = idx
              .map((_, k) => byId.get(k))
              .find((r) => !r || (r.error && !isRevert(r.error)))
            if (bad !== undefined)
              throw new Error(
                `batch: member error ${JSON.stringify(bad?.error ?? 'missing').slice(0, 80)}`,
              )
            idx.forEach(
              (i, k) => (out[i] = byId.get(k)?.error ? null : (byId.get(k)?.result ?? null)),
            )
            this.ok(e)
            done = true
          } catch (err) {
            this.cool(e, err)
          }
        }
        if (!done) {
          for (const i of idx) {
            try {
              out[i] = await this.call(calls[i].method, calls[i].params)
            } catch (err) {
              if ((err as { revert?: boolean }).revert) out[i] = null
              else throw err
            }
          }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, groups.length) }, worker))
    return out
  }

  /** eth_getLogs over [from, to] in chunks; empty chunks (and all chunks when `dual`) are re-read elsewhere and unioned. */
  async getLogs(
    filter: LogFilter,
    from: number,
    to: number,
    opts: {
      dual?: boolean
      concurrency?: number
      span?: number
      onChunk?: (done: number, total: number) => void
    } = {},
  ): Promise<RpcLog[]> {
    const span =
      opts.span ?? Math.min(...this.endpoints.filter((e) => e.logSpan > 0).map((e) => e.logSpan))
    const chunks: [number, number][] = []
    for (let a = from; a <= to; a += span) chunks.push([a, Math.min(to, a + span - 1)])
    const results: RpcLog[][] = new Array(chunks.length)
    let next = 0
    let done = 0
    const worker = async () => {
      for (;;) {
        const i = next++
        if (i >= chunks.length) return
        results[i] = await this.chunk(filter, chunks[i][0], chunks[i][1], Boolean(opts.dual))
        opts.onChunk?.(++done, chunks.length)
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(opts.concurrency ?? 4, chunks.length) }, worker),
    )
    return results.flat()
  }

  private async readChunk(e: Endpoint, filter: LogFilter, a: number, b: number): Promise<RpcLog[]> {
    const j = await this.post(e, {
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_getLogs',
      params: [{ ...filter, fromBlock: '0x' + a.toString(16), toBlock: '0x' + b.toString(16) }],
    })
    if (j.error) throw new Error(this.scrub(`${e.label}: ${j.error.message ?? 'error'}`))
    if (!Array.isArray(j.result)) throw new Error(`${e.label}: getLogs returned no array`)
    return j.result as RpcLog[]
  }

  private async chunk(filter: LogFilter, a: number, b: number, dual: boolean): Promise<RpcLog[]> {
    this.logStats.chunks++
    const fits = (e: Endpoint) => e.logSpan >= b - a + 1
    let first: { e: Endpoint; logs: RpcLog[] } | null = null
    let lastErr: unknown
    for (let attempt = 0; attempt < 10 && !first; attempt++) {
      const [e] = await this.live(fits)
      try {
        first = { e, logs: await this.readChunk(e, filter, a, b) }
        this.ok(e)
      } catch (err) {
        lastErr = err
        this.cool(e, err)
      }
    }
    if (!first) {
      // Halve and retry: some endpoints refuse a span by result size, not block count.
      if (b > a) {
        const mid = a + Math.floor((b - a) / 2)
        this.logStats.chunks--
        return [
          ...(await this.chunk(filter, a, mid, dual)),
          ...(await this.chunk(filter, mid + 1, b, dual)),
        ]
      }
      throw new Error(this.scrub(`getLogs ${a}-${b} failed on every endpoint: ${String(lastErr)}`))
    }
    this.logStats.servedBy[first.e.label] = (this.logStats.servedBy[first.e.label] ?? 0) + 1
    if (first.logs.length > 0 && !dual) return first.logs
    if (!this.endpoints.some((e) => e !== first!.e && fits(e))) {
      if (first.logs.length === 0) this.logStats.emptyConfirmed++
      return first.logs
    }
    let other: { e: Endpoint; logs: RpcLog[] } | null = null
    for (let attempt = 0; attempt < 6 && !other; attempt++) {
      const [e] = await this.live((x) => x !== first!.e && fits(x))
      try {
        other = { e, logs: await this.readChunk(e, filter, a, b) }
        this.ok(e)
      } catch (err) {
        this.cool(e, err)
      }
    }
    this.logStats.rechecked++
    if (!other) return first.logs
    const key = (l: RpcLog) => `${parseInt(l.blockNumber, 16)}:${parseInt(l.logIndex, 16)}`
    const have = new Set(first.logs.map(key))
    const theirs = new Set(other.logs.map(key))
    const extra = other.logs.filter((l) => !have.has(key(l)))
    if (extra.length) {
      this.logStats.disagreements++
      this.logStats.recovered += extra.length
      this.logStats.shortBy[first.e.label] = (this.logStats.shortBy[first.e.label] ?? 0) + 1
    }
    if (first.logs.some((l) => !theirs.has(key(l))))
      this.logStats.shortBy[other.e.label] = (this.logStats.shortBy[other.e.label] ?? 0) + 1
    const union = [...first.logs, ...extra]
    if (union.length === 0) this.logStats.emptyConfirmed++
    return union
  }
}

const isRevert = (err: { message?: string; code?: number }): boolean =>
  /revert|execution reverted|invalid opcode|out of gas/i.test(String(err?.message ?? '')) ||
  err?.code === 3
