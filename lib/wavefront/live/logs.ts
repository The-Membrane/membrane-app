/**
 * The event source of one chain: eth_getLogs for BOTH liquidation topics (Aave Pool
 * LiquidationCall, Morpho Blue Liquidate) in one filter, chunked, with the board R33 defence:
 *
 *   - AN EMPTY ANSWER IS NOT A FACT. Every empty chunk is re-asked on a DIFFERENT backend group
 *     before it counts. When the second backend returns logs, its answer is kept and the first
 *     host is quarantined for logs (`falseEmpty`); when no independent backend can answer, the
 *     chunk is NOT believed — `UnconfirmedEmptyError` is thrown and the caller retries later
 *     (the stream waits rather than skipping a minute).
 *   - Every log in an answer is checked: emitter, topic, block inside the asked range, not
 *     removed, and its blockHash equal to the header the engine reads for its timestamp.
 *   - RECONCILIATION re-scans a trailing window on groups OTHER than the ones that answered the
 *     primary scan of each part of it; an event the primary scan missed comes back as `late`.
 *
 * Every primary chunk's answering group is recorded (`provenance`) so the reconciliation can
 * pick an independent backend for exactly that range.
 */
import { NoBackendError, toHex, type ChainKey } from '../../../scripts/oct10-coverage/rpc'
import type { Blocks } from './blocks'
import { decodeLiquidation, type Emitters, type LiqEvent, type RawLog } from './codec'
import {
  AAVE_LIQUIDATION_CALL_TOPIC,
  MORPHO_LIQUIDATE_TOPIC,
  type ChainConfig,
} from './config'
import type { LiveRpc, RpcAnswer } from './rpc'

export class UnconfirmedEmptyError extends Error {}

/** An empty chunk this narrow that no second backend confirms is not believed (thrown). */
export const MIN_CONFIRM_SPAN = 10

export interface ChunkProvenance {
  from: number
  to: number
  group: string
}

export interface ScanStats {
  logCalls: number
  chunks: number
  blocksScanned: number
  events: number
  /** Empty answers confirmed empty by a second, independent backend. */
  emptyConfirmed: number
  /** Empty answers a second backend contradicted (false empties caught). */
  falseEmpty: number
  /** Empty answers no independent backend could confirm (the scan was retried later). */
  unconfirmedEmpty: number
  /** Answers rejected for a foreign / out-of-range / removed log. */
  badAnswers: number
  /** Logs whose blockHash disagreed with the header read for their timestamp. */
  hashMismatch: number
  /** Range refusals that halved the chunk span. */
  spanHalvings: number
}

export const emptyScanStats = (): ScanStats => ({
  logCalls: 0,
  chunks: 0,
  blocksScanned: 0,
  events: 0,
  emptyConfirmed: 0,
  falseEmpty: 0,
  unconfirmedEmpty: 0,
  badAnswers: 0,
  hashMismatch: 0,
  spanHalvings: 0,
})

const RANGE_RE =
  /range|too large|exceed|response size|query returned more|more than \d+ (logs|results)/i

export class LogScanner {
  span: number
  /** host -> quarantined until (ms). Hosts here are never asked for logs. */
  private readonly quarantine = new Map<string, number>()
  readonly stats: ScanStats = emptyScanStats()
  readonly quarantineLog: { host: string; at: number; reason: string }[] = []

  /** Every Aave V3 pool of the chain (from the registry) and Morpho Blue. */
  emitters: Emitters

  constructor(
    readonly rpc: LiveRpc,
    readonly cfg: ChainConfig,
    readonly blocks: Blocks,
    /** Wall clock for quarantine expiry (never a simulated clock: retries happen in real time). */
    readonly now: () => number = () => Date.now(),
  ) {
    this.span = cfg.logChunk
    this.emitters = { aavePools: new Set([cfg.aavePool]), morpho: cfg.morpho }
  }

  /** Watch these Aave pools (the registry's current list) besides Morpho Blue. */
  setAavePools(pools: readonly string[]) {
    this.emitters = { aavePools: new Set(pools.map((p) => p.toLowerCase())), morpho: this.cfg.morpho }
  }

  get chain(): ChainKey {
    return this.cfg.chain
  }

  private excludedHosts(): string[] {
    const t = this.now()
    const out: string[] = []
    for (const [h, until] of this.quarantine) {
      if (until > t) out.push(h)
      else this.quarantine.delete(h)
    }
    return out
  }

  quarantineHost(host: string, reason: string) {
    this.quarantine.set(host, this.now() + 3_600_000)
    this.quarantineLog.push({ host, at: this.now(), reason })
  }

  private params(from: number, to: number) {
    return [
      {
        address: [...this.emitters.aavePools, this.emitters.morpho],
        topics: [[AAVE_LIQUIDATION_CALL_TOPIC, MORPHO_LIQUIDATE_TOPIC]],
        fromBlock: toHex(from),
        toBlock: toHex(to),
      },
    ]
  }

  /** The answer's logs, or a reason it is unusable. */
  private validate(a: RpcAnswer, from: number, to: number): RawLog[] | string {
    if (a.revert) return `revert: ${a.revert.message}`
    if (!Array.isArray(a.result)) return 'not an array'
    const logs = a.result as RawLog[]
    for (const l of logs) {
      const addr = String(l.address).toLowerCase()
      if (!this.emitters.aavePools.has(addr) && addr !== this.emitters.morpho)
        return `foreign emitter ${addr}`
      const t0 = String(l.topics?.[0]).toLowerCase()
      if (t0 !== AAVE_LIQUIDATION_CALL_TOPIC && t0 !== MORPHO_LIQUIDATE_TOPIC)
        return `foreign topic ${t0}`
      const b = Number(BigInt(l.blockNumber))
      if (b < from || b > to) return `log at ${b} outside [${from}, ${to}]`
      if (l.removed) return 'removed log'
    }
    return logs
  }

  /** One logs call with routing, validation and range handling. */
  private async ask(
    from: number,
    to: number,
    excludeGroups: string[] = [],
    attempts?: number,
  ): Promise<{ logs: RawLog[]; host: string; group: string }> {
    for (let attempt = 0; attempt < 6; attempt++) {
      this.stats.logCalls++
      const a = await this.rpc.request(this.chain, 'eth_getLogs', this.params(from, to), {
        kind: 'logs',
        excludeGroups,
        excludeHosts: this.excludedHosts(),
        ...(attempts ? { attempts } : {}),
      })
      const v = this.validate(a, from, to)
      if (typeof v !== 'string') return { logs: v, host: a.host, group: a.group }
      this.stats.badAnswers++
      this.quarantineHost(a.host, `bad logs answer: ${v}`)
    }
    throw new Error(`${this.chain} logs [${from}, ${to}]: no usable answer`)
  }

  /**
   * Scan [from, to] (inclusive). Returns the decoded events (timestamps filled from headers) and
   * the answering group of every chunk. Throws UnconfirmedEmptyError when an empty chunk could
   * not be confirmed on an independent backend — nothing of the range is to be believed then.
   */
  async scan(from: number, to: number): Promise<{ events: LiqEvent[]; chunks: ChunkProvenance[] }> {
    const events: LiqEvent[] = []
    const chunks: ChunkProvenance[] = []
    let b = from
    while (b <= to) {
      const e = Math.min(to, b + this.span - 1)
      let got: { logs: RawLog[]; host: string; group: string }
      try {
        got = await this.ask(b, e)
      } catch (err) {
        if (RANGE_RE.test(String((err as Error).message)) && this.span > 1) {
          this.span = Math.max(1, Math.floor(this.span / 2))
          this.stats.spanHalvings++
          continue
        }
        throw err
      }
      let group = got.group
      if (got.logs.length === 0) {
        // Not a fact until an independent backend says so too.
        let second: { logs: RawLog[]; host: string; group: string }
        try {
          second = await this.ask(b, e, [got.group], 6)
        } catch (err) {
          // Narrower spans are served by more backends (some cap logs at 10 blocks): retry this
          // chunk narrower before calling the empty unconfirmable.
          if (e - b + 1 > MIN_CONFIRM_SPAN) {
            this.span = Math.max(MIN_CONFIRM_SPAN, Math.floor((e - b + 1) / 4))
            this.stats.spanHalvings++
            continue
          }
          this.stats.unconfirmedEmpty++
          throw new UnconfirmedEmptyError(
            `${this.chain} logs [${b}, ${e}]: empty on ${got.host}, unconfirmed (${
              err instanceof NoBackendError ? 'no independent backend' : (err as Error).message
            })`,
          )
        }
        if (second.logs.length > 0) {
          this.stats.falseEmpty++
          this.quarantineHost(got.host, `false empty on [${b}, ${e}]: ${second.host} had ${second.logs.length}`)
          got = second
          group = second.group
        } else {
          this.stats.emptyConfirmed++
          group = `${got.group}+${second.group}`
        }
      }
      for (const l of got.logs) events.push(await this.withTs(decodeLiquidation(this.chain, l, this.emitters)))
      chunks.push({ from: b, to: e, group })
      this.stats.chunks++
      this.stats.blocksScanned += e - b + 1
      this.stats.events += got.logs.length
      b = e + 1
      // Grow back slowly after a halving.
      if (this.span < this.cfg.logChunk) this.span = Math.min(this.cfg.logChunk, this.span * 2)
    }
    return { events, chunks }
  }

  /** Fill ts from the block header and check the log's block hash against it. */
  private async withTs(ev: LiqEvent): Promise<LiqEvent> {
    let h = await this.blocks.header(ev.block)
    if (ev.blockHash && h.hash !== ev.blockHash) {
      // Ask another backend for the header before calling it a fork.
      this.blocks.forgetFrom(ev.block)
      h = await this.blocks.header(ev.block, { excludeGroups: [] })
      if (h.hash !== ev.blockHash) {
        this.stats.hashMismatch++
        throw new Error(
          `${this.chain} block ${ev.block}: log blockHash ${ev.blockHash} != header ${h.hash}`,
        )
      }
    }
    return { ...ev, ts: h.ts }
  }

  /**
   * Re-scan [from, to] on backends independent of the ones that answered the primary scan of
   * each part (`provenance`). Returns every event found; the caller diffs against what it saw.
   */
  async reconcile(
    from: number,
    to: number,
    provenance: readonly ChunkProvenance[],
  ): Promise<{ events: LiqEvent[]; calls: number; groupsUsed: string[] }> {
    const events: LiqEvent[] = []
    const used = new Set<string>()
    let calls = 0
    // Split [from, to] into runs that ONE backend group can re-check independently: each primary
    // chunk allows every logs group that did not answer it; consecutive chunks are merged while
    // some group is allowed for all of them.
    const all = this.rpc.groups(this.chain, 'logs')
    const runs: { from: number; to: number; allowed: Set<string> }[] = []
    let b = from
    const sorted = [...provenance].sort((x, y) => x.from - y.from)
    while (b <= to) {
      const p = sorted.find((c) => c.from <= b && b <= c.to)
      const e = Math.min(to, p ? p.to : (sorted.find((c) => c.from > b)?.from ?? to + 1) - 1)
      const answered = p ? p.group.split('+') : []
      let allowed = new Set(all.filter((g) => !answered.includes(g)))
      if (!allowed.size) allowed = new Set(all.filter((g) => g !== answered[0]))
      const last = runs[runs.length - 1]
      const inter = last ? new Set([...last.allowed].filter((g) => allowed.has(g))) : null
      if (last && inter && inter.size && last.to === b - 1) {
        last.to = e
        last.allowed = inter
      } else runs.push({ from: b, to: e, allowed })
      b = e + 1
    }
    const parts = runs.map((r) => ({
      from: r.from,
      to: r.to,
      exclude: all.filter((g) => !r.allowed.has(g)),
    }))
    for (const part of parts) {
      let x = part.from
      while (x <= part.to) {
        const e = Math.min(part.to, x + this.span - 1)
        // Prefer a group outside every one that answered this part; when those backends cannot
        // answer (none left, rate-limited), any group but the first that answered.
        let got: { logs: RawLog[]; host: string; group: string }
        calls++
        try {
          got = await this.ask(x, e, part.exclude, 3)
        } catch (err) {
          if (part.exclude.length <= 1) throw err
          calls++
          got = await this.ask(x, e, part.exclude.slice(0, 1), 6)
        }
        used.add(got.group)
        for (const l of got.logs) events.push(await this.withTs(decodeLiquidation(this.chain, l, this.emitters)))
        x = e + 1
      }
    }
    return { events, calls, groupsUsed: [...used] }
  }
}
