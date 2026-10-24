/**
 * Block headers and "the block in force at a time" for one chain.
 *
 * The Oct 10 pull's rule (scripts/oct10-coverage/minuteBlocks.ts): the block in force at time t
 * is the HIGHEST block with timestamp <= t (Arbitrum blocks share timestamps; "highest" takes
 * the last of them), accepted only with both headers in hand: ts(b) <= t < ts(b+1). The live
 * engine uses it for every minute start (prices) and, in historical mode, for the simulated head.
 *
 * The search keeps every header it has read (bounded), so consecutive minutes bracket each other
 * and a minute usually costs one or two header reads.
 */
import { toHex, type ChainKey } from '../../../scripts/oct10-coverage/rpc'
import type { LiveRpc } from './rpc'

export interface Header {
  n: number
  ts: number
  hash: string
}

const MAX_KNOWN = 50_000

export class Blocks {
  /** Headers read so far, sorted by number. */
  private known: Header[] = []
  headerReads = 0

  constructor(
    readonly rpc: LiveRpc,
    readonly chain: ChainKey,
    readonly blockSeconds: number,
  ) {}

  /** Index of the first known header with n >= x. */
  private lowerBound(x: number): number {
    let lo = 0
    let hi = this.known.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.known[mid].n < x) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  private remember(h: Header) {
    const i = this.lowerBound(h.n)
    if (this.known[i]?.n === h.n) {
      this.known[i] = h
      return
    }
    this.known.splice(i, 0, h)
    if (this.known.length > MAX_KNOWN) this.known.splice(0, this.known.length - MAX_KNOWN)
  }

  cached(n: number): Header | undefined {
    const i = this.lowerBound(n)
    return this.known[i]?.n === n ? this.known[i] : undefined
  }

  /** Forget headers at or above `n` (after a hash mismatch: they may be from another fork). */
  forgetFrom(n: number) {
    this.known.splice(this.lowerBound(n))
  }

  async header(n: number, opts: { excludeGroups?: string[] } = {}): Promise<Header> {
    if (!opts.excludeGroups) {
      const c = this.cached(n)
      if (c) return c
    }
    this.headerReads++
    const a = await this.rpc.request(this.chain, 'eth_getBlockByNumber', [toHex(n), false], {
      excludeGroups: opts.excludeGroups,
    })
    const b = a.result as { number?: string; hash?: string; timestamp?: string } | null
    if (!b || !b.number || BigInt(b.number) !== BigInt(n))
      throw new Error(`${this.chain} header ${n}: wrong or missing block in answer (${a.host})`)
    const h: Header = { n, ts: Number(BigInt(b.timestamp!)), hash: String(b.hash).toLowerCase() }
    this.remember(h)
    return h
  }

  async latest(): Promise<number> {
    const a = await this.rpc.request(this.chain, 'eth_blockNumber', [])
    return Number(BigInt(a.result as string))
  }

  /** Heads that could not be checked on a second backend group (the poll waited). */
  headUnverified = 0

  /**
   * The head as seen by TWO independent logs-capable backend groups: the lower of the two. A
   * range is only scanned up to (this − confirmations), so both groups had every block of it —
   * a node behind the head answers a range past its own head with a short list, not an error.
   * null when no second group answers (the caller waits and polls again).
   */
  async agreedHead(): Promise<number | null> {
    const a = await this.rpc.request(this.chain, 'eth_blockNumber', [], { kind: 'logs' })
    let b: Awaited<ReturnType<LiveRpc['request']>>
    try {
      b = await this.rpc.request(this.chain, 'eth_blockNumber', [], {
        kind: 'logs',
        excludeGroups: [a.group],
        attempts: 4,
      })
    } catch {
      this.headUnverified++
      return null
    }
    return Math.min(Number(BigInt(a.result as string)), Number(BigInt(b.result as string)))
  }

  /**
   * The highest block <= maxBlock with timestamp <= t, with the next block's header (ts > t).
   * null when every block up to maxBlock has ts <= t (the time is not settled yet).
   */
  async atOrBefore(t: number, maxBlock: number): Promise<{ lo: Header; hi: Header } | null> {
    // Bracket from what is known.
    let hi: Header | null = null
    let lo: Header | null = null
    const top = await this.header(maxBlock)
    if (top.ts <= t) return null
    hi = top
    // Timestamps never decrease with the block number: binary search the known headers below
    // maxBlock for the last one with ts <= t; the one after it (if any) is a tighter hi.
    let a = 0
    let b = this.lowerBound(maxBlock + 1)
    while (a < b) {
      const mid = (a + b) >> 1
      if (this.known[mid].ts <= t) a = mid + 1
      else b = mid
    }
    if (a > 0) lo = this.known[a - 1]
    const next = this.known[a]
    if (next && next.n <= maxBlock && next.ts > t && next.n < hi.n) hi = next
    // Expand downwards when nothing known lies at or before t.
    if (!lo) {
      let step = Math.max(1, Math.ceil((hi.ts - t) / this.blockSeconds))
      for (;;) {
        const n = Math.max(0, hi.n - step)
        const h = await this.header(n)
        if (h.ts <= t) {
          lo = h
          break
        }
        if (n === 0) throw new Error(`${this.chain}: no block at or before ${t}`)
        hi = h
        step *= 2
      }
    }
    // Interpolation search, alternating with bisection so it always converges.
    for (let k = 0; hi.n - lo.n > 1; k++) {
      let m: number
      if (k % 3 !== 2 && hi.ts > lo.ts) {
        m = lo.n + Math.ceil(((t + 1 - lo.ts) * (hi.n - lo.n)) / (hi.ts - lo.ts)) - 1
      } else m = Math.floor((lo.n + hi.n) / 2)
      m = Math.min(hi.n - 1, Math.max(lo.n + 1, m))
      const h = this.cached(m) ?? (await this.header(m))
      if (h.ts <= t) lo = h
      else hi = h
    }
    if (!(lo.ts <= t && t < hi.ts && hi.n === lo.n + 1))
      throw new Error(`${this.chain}: bracket check failed at ${t}`)
    return { lo, hi }
  }
}
