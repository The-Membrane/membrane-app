// Limits on /api/curator-feed/holder, which spends RECORDER_RPC_URL calls per address.
// Pure (the clock is passed in), so the unit tests drive it without timers.
//
//   per IP        HOLDER_IP_LIMIT requests a minute (cached answers included: cheap, but a
//                 scraper walking addresses is the case to stop)
//   global RPC    HOLDER_RPC_BUDGET RPC requests a minute across every reader; a fresh
//                 read that would overrun it is refused before it starts
//   in flight     one read per address at a time (the handler's promise map)

export const WINDOW_MS = 60_000
export const HOLDER_IP_LIMIT = 20
/** One fresh read costs ceil(vaults / chunk) + 1 RPC requests (≈ 6 today). */
export const HOLDER_RPC_BUDGET = 120

export const LIMIT_COPY = {
  ip: 'Too many requests from this address. Try again in a minute.',
  budget: 'Holdings reads are busy. Try again in a minute.',
} as const

/** Fixed one-minute windows per key. */
export class WindowCounter {
  private windows = new Map<string, { start: number; n: number }>()
  constructor(
    private readonly limit: number,
    private readonly maxKeys = 10_000,
  ) {}

  /** Take `cost` units for `key` at `nowMs`; false (nothing taken) when it would exceed. */
  take(key: string, nowMs: number, cost = 1): boolean {
    let w = this.windows.get(key)
    if (!w || nowMs - w.start >= WINDOW_MS) {
      if (!w && this.windows.size >= this.maxKeys) this.sweep(nowMs)
      w = { start: nowMs, n: 0 }
      this.windows.set(key, w)
    }
    if (w.n + cost > this.limit) return false
    w.n += cost
    return true
  }

  private sweep(nowMs: number) {
    for (const [k, w] of this.windows) if (nowMs - w.start >= WINDOW_MS) this.windows.delete(k)
    // Still full: drop the oldest key (Map keeps insertion order).
    if (this.windows.size >= this.maxKeys) this.windows.delete(this.windows.keys().next().value as string)
  }
}

/** RPC requests one fresh read will make: the balance chunks plus one dust read. */
export const readCost = (vaults: number, chunk: number): number => Math.ceil(vaults / chunk) + 1

/** One promise per key while it runs: concurrent readers of one address share a read. */
export function singleFlight<V>(map: Map<string, Promise<V>>, key: string, run: () => Promise<V>): Promise<V> {
  const running = map.get(key)
  if (running) return running
  const p = run()
  map.set(key, p)
  p.finally(() => map.delete(key)).catch(() => {})
  return p
}
