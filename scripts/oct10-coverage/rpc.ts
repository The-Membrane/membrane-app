/**
 * Multi-backend JSON-RPC pool for the Oct 10-11 2025 on-chain pull.
 *
 * Every chain has several keyless ARCHIVE endpoints (tested 2026-10-14 against Oct 2025 state).
 * Endpoints are grouped by BACKEND: two hosts that may be served by the same node fleet share a
 * group, and cross-verification always asks a different group. Per endpoint the pool keeps a
 * concurrency cap and a minimum gap between request starts; a 429 / 5xx / timeout cools the
 * endpoint down with exponential backoff (and halves its cap), and the request moves to another
 * endpoint. Answers that only an archive node can give but this node could not (pruned state,
 * missing trie node) count as endpoint failures, never as data.
 *
 * A REVERT is an answer, not a failure: it is returned as `{ revert }` and the caller decides
 * (and the verifier re-asks it on another backend, because a node without the state can answer
 * an empty `0x` or a revert where an archive node answers the value).
 *
 * Keys never appear here: all endpoints are public. Only hosts are written to outputs.
 */

export type ChainKey = 'mainnet' | 'arbitrum' | 'optimism' | 'base'
export const CHAINS: ChainKey[] = ['mainnet', 'arbitrum', 'optimism', 'base']
export const CHAIN_ID: Record<ChainKey, number> = {
  mainnet: 1,
  arbitrum: 42161,
  optimism: 10,
  base: 8453,
}

export interface EndpointSpec {
  url: string
  /** Backend family. Verification never accepts two answers from one group as independent. */
  group: string
  /** Starting concurrency cap. */
  conc: number
  /** Minimum ms between request starts. */
  gapMs: number
  /** Not used for eth_call / headers, only for logs (or vice versa). */
  logsOnly?: boolean
  noLogs?: boolean
}

/** Archive-capable endpoints per chain, probed 2026-10-14 (eth_call at Oct 10 2025 blocks).
 *  Pocket's gateway and Nodies (a POKT node operator) share the `pokt` group. */
export const ENDPOINTS: Record<ChainKey, EndpointSpec[]> = {
  mainnet: [
    { url: 'https://eth.drpc.org', group: 'drpc', conc: 4, gapMs: 60, noLogs: true },
    { url: 'https://mainnet.gateway.tenderly.co', group: 'tenderly', conc: 4, gapMs: 60 },
    {
      url: 'https://eth-mainnet.public.blastapi.io',
      group: 'blast',
      conc: 3,
      gapMs: 80,
      noLogs: true,
    },
    { url: 'https://eth.api.pocket.network', group: 'pokt', conc: 3, gapMs: 80 },
    { url: 'https://eth-pokt.nodies.app', group: 'pokt', conc: 2, gapMs: 120, noLogs: true },
    {
      url: 'https://ethereum.public.blockpi.network/v1/rpc/public',
      group: 'blockpi',
      conc: 1,
      gapMs: 400,
      logsOnly: true,
    },
  ],
  arbitrum: [
    { url: 'https://arbitrum.gateway.tenderly.co', group: 'tenderly', conc: 4, gapMs: 60 },
    { url: 'https://gateway.tenderly.co/public/arbitrum', group: 'tenderly', conc: 3, gapMs: 80 },
    {
      url: 'https://arbitrum-one.public.blastapi.io',
      group: 'blast',
      conc: 3,
      gapMs: 80,
      noLogs: true,
    },
    { url: 'https://arb-one.api.pocket.network', group: 'pokt', conc: 3, gapMs: 80 },
    { url: 'https://arb-pokt.nodies.app', group: 'pokt', conc: 2, gapMs: 120, noLogs: true },
  ],
  optimism: [
    { url: 'https://optimism.gateway.tenderly.co', group: 'tenderly', conc: 4, gapMs: 60 },
    { url: 'https://optimism.drpc.org', group: 'drpc', conc: 2, gapMs: 150, noLogs: true },
    { url: 'https://op.api.pocket.network', group: 'pokt', conc: 3, gapMs: 80 },
    { url: 'https://optimism.api.onfinality.io/public', group: 'onfinality', conc: 2, gapMs: 150 },
    { url: 'https://mainnet.optimism.io', group: 'op-official', conc: 2, gapMs: 150 },
  ],
  base: [
    { url: 'https://base.drpc.org', group: 'drpc', conc: 4, gapMs: 60, noLogs: true },
    { url: 'https://base.gateway.tenderly.co', group: 'tenderly', conc: 4, gapMs: 60 },
    {
      url: 'https://base-mainnet.public.blastapi.io',
      group: 'blast',
      conc: 3,
      gapMs: 80,
      noLogs: true,
    },
    { url: 'https://base.api.pocket.network', group: 'pokt', conc: 3, gapMs: 80 },
    { url: 'https://base-pokt.nodies.app', group: 'pokt', conc: 2, gapMs: 120, noLogs: true },
    { url: 'https://base.api.onfinality.io/public', group: 'onfinality', conc: 2, gapMs: 150 },
    { url: 'https://mainnet.base.org', group: 'base-official', conc: 2, gapMs: 150 },
  ],
}

export const hostOf = (url: string) =>
  new URL(url).host + (new URL(url).pathname.length > 1 ? new URL(url).pathname : '')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Endpoint extends EndpointSpec {
  chain: ChainKey
  host: string
  cap: number
  maxCap: number
  inflight: number
  lastStart: number
  coolUntil: number
  backoffMs: number
  okStreak: number
  disabled: string | null
  stats: {
    calls: number
    ok: number
    reverts: number
    rateLimited: number
    transient: number
    capability: number
    ms: number
  }
}

export interface CallOpts {
  /** Groups that must NOT answer (verification: the group that gave the primary answer). */
  excludeGroups?: Iterable<string>
  /** Hosts that must not answer. */
  excludeHosts?: Iterable<string>
  /** Ask only this group. */
  onlyGroup?: string
  timeoutMs?: number
  /** Total attempts across endpoints before giving up. */
  attempts?: number
  /** Kind of call, to route: 'logs' never goes to noLogs endpoints; others never to logsOnly. */
  kind?: 'call' | 'logs'
}

export interface RpcAnswer {
  /** JSON-RPC `result` when the call succeeded. */
  result?: unknown
  /** Present when the node answered a deterministic revert. */
  revert?: { message: string; data?: string }
  host: string
  group: string
}

export class NoBackendError extends Error {}

/** Messages that mean "this node cannot answer this (state/range/plan)", not "the answer is X". */
const CAPABILITY_RE =
  /missing trie node|pruned|historical state|not available|unknown state|first available|archive|header not found|unknown block|block not found|range|limit|plan|not supported|upgrade|too large|exceed|discontinued|personal token/i
const RATE_RE = /rate|too many|429|throttl|capacity|cu limit|usage limit|busy|quota/i

export class RpcPool {
  readonly endpoints: Record<ChainKey, Endpoint[]>
  private quarantineLog: { host: string; chain: ChainKey; reason: string; at: string }[] = []
  /** Every call, aggregated per host and method. */
  calls = 0
  private lastLog = 0

  constructor(
    specs: Record<ChainKey, EndpointSpec[]> = ENDPOINTS,
    quarantined: { host: string; chain: ChainKey; reason: string; at: string }[] = [],
  ) {
    const make = (chain: ChainKey, s: EndpointSpec): Endpoint => ({
      ...s,
      chain,
      host: hostOf(s.url),
      cap: s.conc,
      maxCap: s.conc * 2,
      inflight: 0,
      lastStart: 0,
      coolUntil: 0,
      backoffMs: 1000,
      okStreak: 0,
      disabled: null,
      stats: { calls: 0, ok: 0, reverts: 0, rateLimited: 0, transient: 0, capability: 0, ms: 0 },
    })
    this.endpoints = Object.fromEntries(
      (Object.keys(specs) as ChainKey[]).map((c) => [c, specs[c].map((s) => make(c, s))]),
    ) as Record<ChainKey, Endpoint[]>
    for (const q of quarantined) this.quarantine(q.chain, q.host, q.reason, q.at)
  }

  quarantine(chain: ChainKey, host: string, reason: string, at = new Date().toISOString()) {
    for (const e of this.endpoints[chain] ?? []) {
      if (e.host === host && !e.disabled) e.disabled = `quarantined: ${reason}`
    }
    if (!this.quarantineLog.some((q) => q.chain === chain && q.host === host))
      this.quarantineLog.push({ host, chain, reason, at })
  }
  quarantined() {
    return [...this.quarantineLog]
  }
  isQuarantined(chain: ChainKey, host: string) {
    return this.quarantineLog.some((q) => q.chain === chain && q.host === host)
  }

  groups(chain: ChainKey, kind: 'call' | 'logs' = 'call'): string[] {
    return [
      ...new Set(
        this.endpoints[chain]
          .filter((e) => !e.disabled && this.routable(e, kind))
          .map((e) => e.group),
      ),
    ]
  }

  private routable(e: Endpoint, kind: 'call' | 'logs') {
    return kind === 'logs' ? !e.noLogs : !e.logsOnly
  }

  private eligible(chain: ChainKey, opts: CallOpts, tried: Set<string>): Endpoint[] {
    const exG = new Set(opts.excludeGroups ?? [])
    const exH = new Set(opts.excludeHosts ?? [])
    const kind = opts.kind ?? 'call'
    return this.endpoints[chain].filter(
      (e) =>
        !e.disabled &&
        this.routable(e, kind) &&
        !exG.has(e.group) &&
        !exH.has(e.host) &&
        (!opts.onlyGroup || e.group === opts.onlyGroup) &&
        !tried.has(e.host),
    )
  }

  private async acquire(chain: ChainKey, opts: CallOpts, tried: Set<string>): Promise<Endpoint> {
    for (;;) {
      let pool = this.eligible(chain, opts, tried)
      if (!pool.length) {
        // Everything not yet tried is excluded: allow re-trying already-tried hosts.
        pool = this.eligible(chain, opts, new Set())
        if (!pool.length)
          throw new NoBackendError(
            `${chain}: no eligible endpoint (${JSON.stringify(opts.excludeGroups ? [...opts.excludeGroups] : [])})`,
          )
        tried.clear()
      }
      const now = Date.now()
      const ready = pool
        .filter((e) => e.coolUntil <= now && e.inflight < e.cap && now - e.lastStart >= e.gapMs)
        .sort((a, b) => a.inflight / a.cap - b.inflight / b.cap || a.lastStart - b.lastStart)
      if (ready.length) {
        const e = ready[0]
        e.inflight++
        e.lastStart = now
        return e
      }
      await sleep(15 + Math.random() * 25)
    }
  }

  private release(
    e: Endpoint,
    outcome: 'ok' | 'revert' | 'rate' | 'transient' | 'capability',
    ms: number,
  ) {
    e.inflight--
    e.stats.calls++
    e.stats.ms += ms
    if (outcome === 'ok' || outcome === 'revert') {
      if (outcome === 'ok') e.stats.ok++
      else e.stats.reverts++
      e.okStreak++
      e.backoffMs = 1000
      if (e.okStreak >= 40 && e.cap < e.maxCap) {
        e.cap++
        e.okStreak = 0
      }
      return
    }
    e.okStreak = 0
    if (outcome === 'rate') {
      e.stats.rateLimited++
      e.cap = Math.max(1, Math.floor(e.cap / 2))
    } else if (outcome === 'capability') e.stats.capability++
    else e.stats.transient++
    e.coolUntil = Date.now() + e.backoffMs + Math.random() * 500
    e.backoffMs = Math.min(60_000, e.backoffMs * 2)
  }

  /** One JSON-RPC request, routed and retried. Throws only when every attempt failed. */
  async request(
    chain: ChainKey,
    method: string,
    params: unknown[],
    opts: CallOpts = {},
  ): Promise<RpcAnswer> {
    const attempts = opts.attempts ?? 14
    const tried = new Set<string>()
    let last = ''
    for (let a = 0; a < attempts; a++) {
      const e = await this.acquire(chain, opts, tried)
      tried.add(e.host)
      const t0 = Date.now()
      this.calls++
      let outcome: 'ok' | 'revert' | 'rate' | 'transient' | 'capability' = 'transient'
      try {
        const r = await fetch(e.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'user-agent': 'curl/8.5.0' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
        })
        const text = await r.text()
        let j: {
          result?: unknown
          error?: { code?: number; message?: string; data?: unknown }
        } | null = null
        try {
          j = JSON.parse(text)
        } catch {
          j = null
        }
        if (
          r.status === 429 ||
          (j?.error &&
            RATE_RE.test(String(j.error.message ?? '')) &&
            !/revert/i.test(String(j.error.message ?? '')))
        ) {
          outcome = 'rate'
          last = `${e.host} rate-limited: ${text.slice(0, 120)}`
          continue
        }
        if (!j || (r.status >= 400 && !j.error)) {
          outcome = r.status >= 500 || !j ? 'transient' : 'capability'
          last = `${e.host} HTTP ${r.status}: ${text.slice(0, 120)}`
          continue
        }
        if (j.error) {
          const msg = String(j.error.message ?? '')
          // Out-of-gas is an endpoint gas cap, not an answer: it falls through to retry elsewhere.
          const isRevert =
            j.error.code === 3 || /execution reverted|invalid opcode|stack underflow/i.test(msg)
          if (isRevert) {
            outcome = 'revert'
            const data =
              typeof j.error.data === 'string'
                ? j.error.data
                : (j.error.data as { data?: string } | undefined)?.data
            return {
              revert: {
                message: msg.slice(0, 300),
                data: typeof data === 'string' ? data : undefined,
              },
              host: e.host,
              group: e.group,
            }
          }
          outcome = CAPABILITY_RE.test(msg) ? 'capability' : 'transient'
          last = `${e.host} error ${j.error.code}: ${msg.slice(0, 160)}`
          if (outcome === 'capability' && method !== 'eth_getLogs') {
            // A node that cannot serve the state is not a backend for this run.
            if (e.stats.capability >= 4 && e.stats.ok < e.stats.capability)
              e.disabled = `capability: ${msg.slice(0, 120)}`
          }
          continue
        }
        if (j.result === null && method !== 'eth_getTransactionReceipt') {
          // null block / null result: a node behind or without the data.
          outcome = 'capability'
          last = `${e.host} null result`
          continue
        }
        outcome = 'ok'
        return { result: j.result, host: e.host, group: e.group }
      } catch (err) {
        outcome = 'transient'
        last = `${e.host} ${(err as Error).name}: ${String((err as Error).message).slice(0, 120)}`
      } finally {
        this.release(e, outcome, Date.now() - t0)
        if (Date.now() - this.lastLog > 60_000) {
          this.lastLog = Date.now()
          process.stderr.write(`[rpc] ${new Date().toISOString()} calls=${this.calls}\n`)
        }
      }
    }
    throw new Error(`${chain} ${method} failed after ${attempts} attempts: ${last}`)
  }

  /** Logs-capable endpoints of a chain (not disabled), for callers that pick hosts themselves. */
  logEndpoints(chain: ChainKey): { url: string; host: string; group: string }[] {
    return this.endpoints[chain]
      .filter((e) => !e.disabled && !e.noLogs)
      .map((e) => ({ url: e.url, host: e.host, group: e.group }))
  }

  /** ONE attempt on ONE endpoint (gated by its concurrency cap and gap, counted in its stats).
   *  Returns the JSON-RPC result or the error message; the caller decides what to do. */
  async requestOn(
    chain: ChainKey,
    host: string,
    method: string,
    params: unknown[],
    timeoutMs = 60_000,
  ): Promise<{ result?: unknown; error?: string; rate?: boolean }> {
    const e0 = this.endpoints[chain].find((e) => e.host === host)
    if (!e0) throw new Error(`no endpoint ${host}`)
    const e = await this.acquire(
      chain,
      {
        onlyGroup: e0.group,
        excludeHosts: this.endpoints[chain].filter((x) => x.host !== host).map((x) => x.host),
        kind: e0.noLogs ? 'call' : 'logs',
      },
      new Set(),
    )
    const t0 = Date.now()
    this.calls++
    let outcome: 'ok' | 'rate' | 'transient' | 'capability' = 'transient'
    try {
      const r = await fetch(e.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'curl/8.5.0' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const text = await r.text()
      let j: { result?: unknown; error?: { message?: string } } | null = null
      try {
        j = JSON.parse(text)
      } catch {
        j = null
      }
      if (r.status === 429 || (j?.error && RATE_RE.test(String(j.error.message ?? '')))) {
        outcome = 'rate'
        return { error: `rate-limited: ${text.slice(0, 160)}`, rate: true }
      }
      if (!j) return { error: `HTTP ${r.status}: ${text.slice(0, 160)}` }
      if (j.error) {
        outcome = 'capability'
        return { error: String(j.error.message ?? JSON.stringify(j.error)).slice(0, 200) }
      }
      if (j.result === null || j.result === undefined) return { error: 'null result' }
      outcome = 'ok'
      return { result: j.result }
    } catch (err) {
      return { error: `${(err as Error).name}: ${String((err as Error).message).slice(0, 160)}` }
    } finally {
      // A refused range is not a fault of the endpoint: no cooldown for capability answers here.
      if (outcome === 'capability') {
        e.inflight--
        e.stats.calls++
        e.stats.capability++
        e.stats.ms += Date.now() - t0
      } else this.release(e, outcome, Date.now() - t0)
    }
  }

  /** Per-host statistics for the provenance. */
  ledger() {
    const out: Record<string, unknown>[] = []
    for (const chain of Object.keys(this.endpoints) as ChainKey[]) {
      for (const e of this.endpoints[chain]) {
        out.push({
          chain,
          host: e.host,
          group: e.group,
          ...e.stats,
          avgMs: e.stats.calls ? Math.round(e.stats.ms / e.stats.calls) : 0,
          disabled: e.disabled,
        })
      }
    }
    return out
  }
}

/** Normalized form used for byte-equality between backends. */
export function normalizeAnswer(a: RpcAnswer): string {
  if (a.revert) return 'REVERT'
  return typeof a.result === 'string' ? a.result.toLowerCase() : JSON.stringify(a.result)
}

export const toHex = (n: number | bigint) => '0x' + BigInt(n).toString(16)
