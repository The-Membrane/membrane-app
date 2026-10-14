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
 *   - live mode also adds PublicNode (recent blocks only; archive needs a key).
 * rpc.flashbots.net / rpc.mevblocker.io are never listed (lib/position-sim/rpcExclusions.ts),
 * and `liveEndpoints` asserts it.
 */
import {
  ENDPOINTS,
  type CallOpts,
  type ChainKey,
  type EndpointSpec,
  type RpcAnswer,
} from '../../../scripts/oct10-coverage/rpc'
import { isExcludedLogHost } from '../../position-sim/rpcExclusions'

export type { CallOpts, RpcAnswer }

export interface LiveRpc {
  request(chain: ChainKey, method: string, params: unknown[], opts?: CallOpts): Promise<RpcAnswer>
  /** Independent backend groups of a chain that can serve `kind`. */
  groups(chain: ChainKey, kind?: 'call' | 'logs'): string[]
}

const ARCHIVE_EXTRA: Partial<Record<ChainKey, EndpointSpec[]>> = {
  arbitrum: [{ url: 'https://arb1.arbitrum.io/rpc', group: 'arb-official', conc: 2, gapMs: 150 }],
}
const LIVE_EXTRA: Partial<Record<ChainKey, EndpointSpec[]>> = {
  mainnet: [
    { url: 'https://ethereum-rpc.publicnode.com', group: 'publicnode', conc: 2, gapMs: 150 },
  ],
  optimism: [
    { url: 'https://optimism-rpc.publicnode.com', group: 'publicnode', conc: 2, gapMs: 150 },
  ],
  base: [{ url: 'https://base-rpc.publicnode.com', group: 'publicnode', conc: 2, gapMs: 150 }],
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
export function liveEndpoints(mode: 'live' | 'historical'): Record<ChainKey, EndpointSpec[]> {
  const out = {} as Record<ChainKey, EndpointSpec[]>
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

/**
 * Wraps a LiveRpc: counts every request by chain and method, keeps the in-flight set (for the
 * status report), and bounds every request with a hard timeout so a hung transport can never
 * stall the engine (the minute fails, rolls back and is retried).
 */
export class CountingRpc implements LiveRpc {
  readonly counts = new Map<string, MethodCount>()
  readonly startedAt = Date.now()
  readonly inflight = new Map<number, { chain: string; method: string; since: number }>()
  private nextId = 0
  constructor(
    readonly inner: LiveRpc,
    readonly timeoutMs = 180_000,
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
    opts?: CallOpts,
  ): Promise<RpcAnswer> {
    this.bump(chain, method, (c) => c.calls++)
    const id = this.nextId++
    this.inflight.set(id, { chain, method, since: Date.now() })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const a = await Promise.race([
        this.inner.request(chain, method, params, opts),
        new Promise<never>((_, rej) => {
          timer = setTimeout(
            () => rej(new Error(`${chain} ${method}: no answer in ${this.timeoutMs} ms`)),
            this.timeoutMs,
          )
        }),
      ])
      if (a.revert) this.bump(chain, method, (c) => c.reverts++)
      return a
    } catch (e) {
      this.bump(chain, method, (c) => c.errors++)
      throw e
    } finally {
      clearTimeout(timer)
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
