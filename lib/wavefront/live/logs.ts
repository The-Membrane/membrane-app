/**
 * The event source of one chain: eth_getLogs for BOTH liquidation topics (Aave Pool
 * LiquidationCall, Morpho Blue Liquidate) by TOPIC ONLY — any emitter — chunked, with the board
 * R33 defence:
 *
 *   - SCOPE BY CLASSIFICATION, NOT BY ADDRESS LIST. Every log's emitter is classified
 *     (`Classifier`, injected by the engine): an Aave V3 pool iff its ADDRESSES_PROVIDER() is a
 *     provider of the chain's registry (or an allow-listed one), Morpho Blue iff it is the
 *     singleton; anything else with the same signature (Spark, Seamless and other forks, Aave V2
 *     pools) is excluded and counted per emitter (`stats.excludedByEmitter`). A pool added to the
 *     registry is therefore never missed between two registry reads.
 *   - EVERY CHUNK IS ASKED ON TWO INDEPENDENT BACKEND GROUPS and the union kept. A node that
 *     lags the head answers a range past its own head with a SHORT list (dRPC, arb1 — no error),
 *     and a broken node answers `[]` (Pocket): when the two answers differ, the shorter host is
 *     quarantined for logs (`falseEmpty` when it was empty, `shortAnswers` otherwise). An empty
 *     answer no second backend can confirm is NOT believed (`UnconfirmedEmptyError`; the caller
 *     retries later — the stream waits rather than skipping a minute). A non-empty answer whose
 *     second backend does not answer within SECOND_ASK_MS (the independent public backends are
 *     the rate-limited ones) is kept only if its own group holds the chunk's last block — counted
 *     (`unverifiedNonEmpty`; the reconciliation re-checks it) — else the range is retried.
 *   - Every log in an answer is checked: topic, block inside the asked range, not removed, and
 *     its blockHash equal to the header the engine reads for its timestamp.
 *   - RECONCILIATION re-scans a trailing window on groups OTHER than the ones that answered the
 *     primary scan of each part of it; an event the primary scan missed comes back as `late`.
 *     It runs in the background with an AbortSignal (its budget): a cancelled pass stops at once.
 *
 * Every primary chunk's answering groups are recorded (`provenance`) so the reconciliation can
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
import { AbortedError, type LiveRpc, type RpcAnswer } from './rpc'

export class UnconfirmedEmptyError extends Error {}

/** What an emitter is: an Aave V3 pool in scope, Morpho Blue, or out of scope (null). */
export type EmitterKind = 'aave' | 'morpho' | null
export type Classifier = (emitter: string, topic0: string, block: number) => Promise<EmitterKind>

/** An empty chunk this narrow that no second backend confirms is not believed (thrown). */
export const MIN_CONFIRM_SPAN = 10
/** How long a non-empty chunk waits for its second backend (then: the serving group's block check). */
export const SECOND_ASK_MS = 10_000

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
  /** Non-empty answers a second backend showed to be short (the shorter host is quarantined). */
  shortAnswers: number
  /**
   * Non-empty answers no second backend checked in time, kept because the serving group holds the
   * chunk's last block (the reconciliation re-checks them on independent backends).
   */
  unverifiedNonEmpty: number
  /** Logs of out-of-scope emitters (forks, non-registry instances), total and per emitter. */
  excludedLogs: number
  excludedByEmitter: Record<string, number>
  /** Answers rejected for a foreign-topic / out-of-range / removed log. */
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
  shortAnswers: 0,
  unverifiedNonEmpty: 0,
  excludedLogs: 0,
  excludedByEmitter: {},
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

  /** The Aave V3 pools known so far (the registry's, + allow-listed) and Morpho Blue. */
  emitters: Emitters
  /** Emitter classification (the engine's registry rule); default: the known emitters only. */
  classify: Classifier

  constructor(
    readonly rpc: LiveRpc,
    readonly cfg: ChainConfig,
    readonly blocks: Blocks,
    /** Wall clock for quarantine expiry (never a simulated clock: retries happen in real time). */
    readonly now: () => number = () => Date.now(),
  ) {
    this.span = cfg.logChunk
    this.emitters = { aavePools: new Set([cfg.aavePool]), morpho: cfg.morpho }
    this.classify = async (emitter, topic0) =>
      topic0 === MORPHO_LIQUIDATE_TOPIC
        ? emitter === this.emitters.morpho
          ? 'morpho'
          : null
        : this.emitters.aavePools.has(emitter)
          ? 'aave'
          : null
  }

  /** The Aave pools known so far (decoding; the default classifier). */
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
      if (!/^0x[0-9a-fA-F]{40}$/.test(String(l.address))) return `bad emitter ${l.address}`
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
    signal?: AbortSignal,
  ): Promise<{ logs: RawLog[]; host: string; group: string }> {
    for (let attempt = 0; attempt < 6; attempt++) {
      if (signal?.aborted) throw new AbortedError(`${this.chain} logs [${from}, ${to}]: cancelled`)
      this.stats.logCalls++
      const a = await this.rpc.request(this.chain, 'eth_getLogs', this.params(from, to), {
        kind: 'logs',
        excludeGroups,
        excludeHosts: this.excludedHosts(),
        ...(attempts ? { attempts } : {}),
        ...(signal ? { signal } : {}),
      })
      const v = this.validate(a, from, to)
      if (typeof v !== 'string') return { logs: v, host: a.host, group: a.group }
      this.stats.badAnswers++
      this.quarantineHost(a.host, `bad logs answer: ${v}`)
    }
    throw new Error(`${this.chain} logs [${from}, ${to}]: no usable answer`)
  }

  /**
   * Scan [from, to] (inclusive). Returns the decoded in-scope events (timestamps filled from
   * headers) and the answering groups of every chunk. Throws UnconfirmedEmptyError when an empty
   * chunk could not be confirmed on an independent backend — nothing of the range is to be
   * believed then.
   */
  async scan(from: number, to: number): Promise<{ events: LiqEvent[]; chunks: ChunkProvenance[] }> {
    const events: LiqEvent[] = []
    const chunks: ChunkProvenance[] = []
    let b = from
    while (b <= to) {
      const e = Math.min(to, b + this.span - 1)
      let first: { logs: RawLog[]; host: string; group: string }
      try {
        first = await this.ask(b, e)
      } catch (err) {
        if (RANGE_RE.test(String((err as Error).message)) && this.span > 1) {
          this.span = Math.max(1, Math.floor(this.span / 2))
          this.stats.spanHalvings++
          continue
        }
        throw err
      }
      // The same chunk on an independent backend group. For a non-empty answer the wait is
      // bounded (SECOND_ASK_MS: the independent public backends are the rate-limited ones); past
      // it, the serving group must at least hold the chunk's last block, or the range is retried.
      let second: { logs: RawLog[]; host: string; group: string } | null = null
      const ctrl = first.logs.length > 0 ? new AbortController() : null
      const timer = ctrl ? setTimeout(() => ctrl.abort(), SECOND_ASK_MS) : undefined
      try {
        second = await this.ask(b, e, [first.group], 6, ctrl?.signal)
      } catch (err) {
        if (first.logs.length > 0) {
          if (!(await this.servesBlock(first.group, e)))
            throw new Error(
              `${this.chain} logs [${b}, ${e}]: ${first.host} answered ${first.logs.length} log(s), no second backend in time and its group does not hold block ${e} (a short answer is possible); retried`,
            )
          this.stats.unverifiedNonEmpty++
        } else {
          // Narrower spans are served by more backends (some cap logs at 10 blocks): retry
          // this chunk narrower before calling the empty unconfirmable.
          if (e - b + 1 > MIN_CONFIRM_SPAN) {
            this.span = Math.max(MIN_CONFIRM_SPAN, Math.floor((e - b + 1) / 4))
            this.stats.spanHalvings++
            continue
          }
          this.stats.unconfirmedEmpty++
          throw new UnconfirmedEmptyError(
            `${this.chain} logs [${b}, ${e}]: empty on ${first.host}, unconfirmed (${
              err instanceof NoBackendError ? 'no independent backend' : (err as Error).message
            })`,
          )
        }
      } finally {
        clearTimeout(timer)
      }
      let logs = first.logs
      let group = first.group
      if (second) {
        group = `${first.group}+${second.group}`
        const k = (l: RawLog) => `${Number(BigInt(l.blockNumber))}:${Number(BigInt(l.logIndex))}`
        const a = new Set(first.logs.map(k))
        const bs = new Set(second.logs.map(k))
        const onlySecond = second.logs.filter((l) => !a.has(k(l)))
        const onlyFirst = first.logs.filter((l) => !bs.has(k(l)))
        const short = (ans: typeof first, other: typeof first, n: number) => {
          if (ans.logs.length === 0) this.stats.falseEmpty++
          else this.stats.shortAnswers++
          this.quarantineHost(
            ans.host,
            `${ans.logs.length ? 'short' : 'false empty'} answer on [${b}, ${e}]: ${other.host} had ${n} more`,
          )
        }
        if (onlySecond.length) short(first, second, onlySecond.length)
        if (onlyFirst.length) short(second, first, onlyFirst.length)
        if (!first.logs.length && !second.logs.length) this.stats.emptyConfirmed++
        logs = [...first.logs, ...onlySecond]
      }
      for (const ev of await this.decodeAll(logs, true)) events.push(ev)
      chunks.push({ from: b, to: e, group })
      this.stats.chunks++
      this.stats.blocksScanned += e - b + 1
      b = e + 1
      // Grow back slowly after a halving.
      if (this.span < this.cfg.logChunk) this.span = Math.min(this.cfg.logChunk, this.span * 2)
    }
    return { events, chunks }
  }

  /** Does `group` hold block n (the same hash as the engine's header)? Never throws. */
  private async servesBlock(group: string, n: number): Promise<boolean> {
    try {
      const a = await this.rpc.request(this.chain, 'eth_getBlockByNumber', [toHex(n), false], {
        onlyGroup: group,
        attempts: 2,
      })
      const h = a.result as { number?: string; hash?: string } | null
      if (!h?.number || Number(BigInt(h.number)) !== n) return false
      return String(h.hash).toLowerCase() === (await this.blocks.header(n)).hash
    } catch {
      return false
    }
  }

  /** Classify, decode and time-stamp the in-scope logs; count the excluded ones (primary scan). */
  private async decodeAll(logs: RawLog[], count: boolean): Promise<LiqEvent[]> {
    const out: LiqEvent[] = []
    const sorted = [...logs].sort(
      (x, y) =>
        Number(BigInt(x.blockNumber) - BigInt(y.blockNumber)) ||
        Number(BigInt(x.logIndex) - BigInt(y.logIndex)),
    )
    for (const l of sorted) {
      const emitter = String(l.address).toLowerCase()
      const t0 = String(l.topics[0]).toLowerCase()
      const kind = await this.classify(emitter, t0, Number(BigInt(l.blockNumber)))
      if (!kind) {
        if (count) {
          this.stats.excludedLogs++
          this.stats.excludedByEmitter[emitter] = (this.stats.excludedByEmitter[emitter] ?? 0) + 1
        }
        continue
      }
      const emitters: Emitters =
        kind === 'aave'
          ? { aavePools: new Set([emitter]), morpho: this.cfg.morpho }
          : { aavePools: new Set(), morpho: this.cfg.morpho }
      out.push(await this.withTs(decodeLiquidation(this.chain, l, emitters)))
      if (count) this.stats.events++
    }
    return out
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
    signal?: AbortSignal,
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
          got = await this.ask(x, e, part.exclude, 3, signal)
        } catch (err) {
          if (err instanceof AbortedError || part.exclude.length <= 1) throw err
          calls++
          got = await this.ask(x, e, part.exclude.slice(0, 1), 6, signal)
        }
        used.add(got.group)
        for (const ev of await this.decodeAll(got.logs, false)) events.push(ev)
        x = e + 1
      }
    }
    return { events, calls, groupsUsed: [...used] }
  }
}
