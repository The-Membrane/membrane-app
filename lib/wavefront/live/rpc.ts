/**
 * The RPC seam of the live engine. The engine only ever talks to a `LiveRpc`; production passes
 * the multi-backend `RpcPool` of the Oct 10 pull (scripts/oct10-coverage/rpc.ts — concurrency
 * caps, per-endpoint backoff, backend GROUPS so a re-ask can be independent), the tests pass a
 * scripted fake. `CountingRpc` wraps either and keeps the per-chain, per-method ledger the live
 * smoke reports (calls / minute is the hosting and free-tier sizing input).
 *
 * Endpoint list (`liveEndpoints`). Built from the pull's probed archive list, with these changes
 * for LOGS, measured 2026-10-14 (minute-sized ranges around 20 known Oct 10 liquidations per
 * chain, and a 500-block Optimism range holding 420 LiquidationCall logs):
 *   - Pocket and its Nodies hosts (the `pokt` group) are never asked for logs: on minute-sized
 *     ranges eth.api.pocket.network missed 2 of 20 mainnet events, op.api.pocket.network 13 of
 *     20, op-pokt.nodies.app 20 of 20 — all as `[]` or short answers, never errors (the same
 *     failure the Oct 10 pull and board R33 saw). They still serve eth_call, which the pull
 *     cross-verified;
 *   - dRPC answered all 20 on mainnet, Optimism and Base for ranges this small, and Blast all 20
 *     on mainnet (it caps logs at 10 blocks; a mainnet minute is 5): both become logs backends
 *     there (a wider range is refused and the pool moves on). BlockPI's public mainnet host took
 *     12-27 s per call and timed out half the time: dropped;
 *   - Arbitrum keeps Tenderly and adds the official arb1.arbitrum.io/rpc (20 of 20) as the
 *     second, independent logs backend;
 *   - live mode also adds PublicNode (recent blocks only; archive needs a key) for eth_call and
 *     heads ONLY: it refuses a logs filter without an address (-32701 "Please specify an
 *     address", all three chains, 2026-10-14), and the engine reads logs by topic.
 * rpc.flashbots.net / rpc.mevblocker.io are never listed (lib/position-sim/rpcExclusions.ts),
 * and `liveEndpoints` asserts it.
 *
 * KEYED ENDPOINTS (optional, owner-provided). `WAVEFRONT_RPC_<CHAIN>` (MAINNET, ARBITRUM,
 * OPTIMISM, BASE) = comma-separated URLs. Each becomes its own backend group `keyed-<hostname>`
 * with a higher concurrency, so it carries most traffic; the public groups stay as the
 * independent backends every empty / short answer is re-asked on. A keyed URL usually carries
 * its key in the path or query, so its endpoint's host label is REDACTED to `keyed:<hostname>`
 * (`redactKeyedHosts`) — the pool's ledger, errors and logs never show the URL.
 *
 * `PoolKeeper` re-enables endpoints the pool disabled for capability errors after a cooldown
 * (the pull's pool disables them for good — right for a one-off pull, wrong for a worker that
 * runs for months).
 */
import {
  ENDPOINTS,
  RpcPool,
  type CallOpts,
  type ChainKey,
  type EndpointSpec,
  type RpcAnswer,
} from '../../../scripts/oct10-coverage/rpc'
import { isExcludedLogHost } from '../../position-sim/rpcExclusions'

export type { CallOpts, RpcAnswer }

/** CallOpts plus a cancellation signal (honoured by CountingRpc; the scanner checks it too). */
export type LiveCallOpts = CallOpts & { signal?: AbortSignal }

export class AbortedError extends Error {}

export interface LiveRpc {
  request(chain: ChainKey, method: string, params: unknown[], opts?: LiveCallOpts): Promise<RpcAnswer>
  /** Independent backend groups of a chain that can serve `kind`. */
  groups(chain: ChainKey, kind?: 'call' | 'logs'): string[]
}

const ARCHIVE_EXTRA: Partial<Record<ChainKey, EndpointSpec[]>> = {
  arbitrum: [{ url: 'https://arb1.arbitrum.io/rpc', group: 'arb-official', conc: 2, gapMs: 150 }],
}
const LIVE_EXTRA: Partial<Record<ChainKey, EndpointSpec[]>> = {
  mainnet: [
    { url: 'https://ethereum-rpc.publicnode.com', group: 'publicnode', conc: 2, gapMs: 150, noLogs: true },
  ],
  optimism: [
    { url: 'https://optimism-rpc.publicnode.com', group: 'publicnode', conc: 2, gapMs: 150, noLogs: true },
  ],
  base: [{ url: 'https://base-rpc.publicnode.com', group: 'publicnode', conc: 2, gapMs: 150, noLogs: true }],
}
/** Groups that rate-limit keyless callers on the first request, or time out (2026-10-14). */
const DROPPED_GROUPS = new Set(['onfinality', 'blockpi'])
/** Groups never asked for logs (false empties, see the header). */
const NO_LOGS_GROUPS = new Set(['pokt'])
/** Groups asked for logs on these chains although the pull's list had them call-only. */
const LOGS_ON: Partial<Record<ChainKey, Set<string>>> = {
  mainnet: new Set(['drpc', 'blast']),
  optimism: new Set(['drpc']),
  base: new Set(['drpc']),
}

/**
 * The endpoint table for a mode. `historical` reads Oct 2025 state and logs (archive hosts
 * only); `live` reads blocks a minute or two old and may also use recent-only hosts.
 */
/** Keyed endpoints from the environment (see the header). Never logged: only hostnames are. */
export function keyedEndpoints(
  env: Record<string, string | undefined> = process.env,
): Record<ChainKey, EndpointSpec[]> {
  const out = {} as Record<ChainKey, EndpointSpec[]>
  for (const chain of Object.keys(ENDPOINTS) as ChainKey[]) {
    const raw = env[`WAVEFRONT_RPC_${chain.toUpperCase()}`] ?? ''
    out[chain] = raw
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean)
      .map((url) => {
        let hostname: string
        try {
          hostname = new URL(url).hostname
        } catch {
          throw new Error(`WAVEFRONT_RPC_${chain.toUpperCase()}: an entry is not a URL`)
        }
        if (isExcludedLogHost(url))
          throw new Error(`WAVEFRONT_RPC_${chain.toUpperCase()}: ${hostname} is excluded for logs`)
        return { url, group: `keyed-${hostname}`, conc: 8, gapMs: 0 }
      })
  }
  return out
}

export function liveEndpoints(
  mode: 'live' | 'historical',
  env: Record<string, string | undefined> = {},
): Record<ChainKey, EndpointSpec[]> {
  const out = {} as Record<ChainKey, EndpointSpec[]>
  const keyed = keyedEndpoints(env)
  for (const chain of Object.keys(ENDPOINTS) as ChainKey[]) {
    const base = ENDPOINTS[chain]
      .filter((e) => !DROPPED_GROUPS.has(e.group))
      .map((e) =>
        NO_LOGS_GROUPS.has(e.group)
          ? { ...e, noLogs: true, logsOnly: false }
          : LOGS_ON[chain]?.has(e.group)
            ? { ...e, noLogs: false }
            : { ...e },
      )
    const list = [
      ...keyed[chain],
      ...base,
      // arb1.arbitrum.io keeps recent state only: in historical mode it serves logs, not eth_call.
      ...(ARCHIVE_EXTRA[chain] ?? []).map((e) => (mode === 'historical' ? { ...e, logsOnly: true } : e)),
      ...(mode === 'live' ? (LIVE_EXTRA[chain] ?? []) : []),
    ]
    for (const e of list) {
      if (!e.noLogs && isExcludedLogHost(e.url))
        throw new Error(`liveEndpoints: ${e.url} is excluded for eth_getLogs (board R33)`)
    }
    out[chain] = list
  }
  return out
}

export interface MethodCount {
  calls: number
  errors: number
  reverts: number
}

/** Replace keyed endpoints' host labels (the pool derives them from the URL, path included). */
export function redactKeyedHosts(pool: RpcPool): string[] {
  const labels: string[] = []
  for (const list of Object.values(pool.endpoints)) {
    for (const e of list) {
      if (!e.group.startsWith('keyed-')) continue
      e.host = `keyed:${new URL(e.url).hostname}`
      labels.push(e.host)
    }
  }
  return labels
}

/** The pool for a mode: public endpoints + keyed ones from `env`, keyed hosts redacted. */
export function buildPool(
  mode: 'live' | 'historical',
  env: Record<string, string | undefined> = process.env,
): { pool: RpcPool; keyedHosts: string[] } {
  const pool = new RpcPool(liveEndpoints(mode, env))
  return { pool, keyedHosts: redactKeyedHosts(pool) }
}

/**
 * Re-enables endpoints the pool disabled for capability errors once `cooldownMs` has passed
 * (their capability counter is reset so one more refusal does not disable them again at once).
 */
export class PoolKeeper {
  private since = new Map<object, number>()
  private last = 0
  reenabled = 0
  constructor(
    readonly pool: RpcPool,
    readonly cooldownMs = 15 * 60_000,
    readonly now: () => number = () => Date.now(),
  ) {}
  tick() {
    const t = this.now()
    if (t - this.last < 30_000) return
    this.last = t
    for (const list of Object.values(this.pool.endpoints)) {
      for (const e of list) {
        if (!e.disabled || !e.disabled.startsWith('capability')) {
          this.since.delete(e)
          continue
        }
        const at = this.since.get(e)
        if (at === undefined) this.since.set(e, t)
        else if (t - at >= this.cooldownMs) {
          e.disabled = null
          e.stats.capability = 0
          this.since.delete(e)
          this.reenabled++
        }
      }
    }
  }
}

/**
 * Wraps a LiveRpc: counts every request by chain and method, keeps the in-flight set (for the
 * status report), bounds every request with a hard timeout so a hung transport can never stall
 * the engine (the minute fails, rolls back and is retried), and honours a cancellation signal
 * (the caller stops waiting at once; the transport's own timeout ends the request).
 */
export class CountingRpc implements LiveRpc {
  readonly counts = new Map<string, MethodCount>()
  readonly startedAt = Date.now()
  readonly inflight = new Map<number, { chain: string; method: string; since: number }>()
  private nextId = 0
  constructor(
    readonly inner: LiveRpc,
    readonly timeoutMs = 180_000,
    readonly keeper?: PoolKeeper,
  ) {}

  private bump(chain: string, method: string, f: (c: MethodCount) => void) {
    const k = `${chain}|${method}`
    let c = this.counts.get(k)
    if (!c) this.counts.set(k, (c = { calls: 0, errors: 0, reverts: 0 }))
    f(c)
  }

  async request(
    chain: ChainKey,
    method: string,
    params: unknown[],
    opts?: LiveCallOpts,
  ): Promise<RpcAnswer> {
    const { signal, ...rest } = opts ?? {}
    if (signal?.aborted) throw new AbortedError(`${chain} ${method}: cancelled`)
    this.keeper?.tick()
    this.bump(chain, method, (c) => c.calls++)
    const id = this.nextId++
    this.inflight.set(id, { chain, method, since: Date.now() })
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    try {
      const a = await Promise.race([
        this.inner.request(chain, method, params, rest),
        new Promise<never>((_, rej) => {
          timer = setTimeout(
            () => rej(new Error(`${chain} ${method}: no answer in ${this.timeoutMs} ms`)),
            this.timeoutMs,
          )
          if (signal) {
            onAbort = () => rej(new AbortedError(`${chain} ${method}: cancelled`))
            signal.addEventListener('abort', onAbort, { once: true })
          }
        }),
      ])
      if (a.revert) this.bump(chain, method, (c) => c.reverts++)
      return a
    } catch (e) {
      this.bump(chain, method, (c) => c.errors++)
      throw e
    } finally {
      clearTimeout(timer)
      if (signal && onAbort) signal.removeEventListener('abort', onAbort)
      this.inflight.delete(id)
    }
  }

  /** Requests in flight for longer than `ms`. */
  stuck(ms = 30_000) {
    const now = Date.now()
    return [...this.inflight.values()]
      .filter((x) => now - x.since > ms)
      .map((x) => ({ ...x, seconds: Math.round((now - x.since) / 1000) }))
  }

  groups(chain: ChainKey, kind?: 'call' | 'logs'): string[] {
    return this.inner.groups(chain, kind)
  }

  /** { chain: { method: {calls, errors, reverts} } } */
  snapshot(): Record<string, Record<string, MethodCount>> {
    const out: Record<string, Record<string, MethodCount>> = {}
    for (const [k, v] of this.counts) {
      const [chain, method] = k.split('|')
      ;(out[chain] ??= {})[method] = { ...v }
    }
    return out
  }

  total(chain?: string): number {
    let n = 0
    for (const [k, v] of this.counts) if (!chain || k.startsWith(chain + '|')) n += v.calls
    return n
  }
}
