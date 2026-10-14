/**
 * THE LIVE WAVEFRONT ENGINE — Real vs Membrane on every Aave V3 (every pool in the registry) and
 * Morpho Blue liquidation on Ethereum, Arbitrum, Optimism and Base, appended to the wavefront
 * stream (schema v1, lib/wavefront/stream.ts) minute by minute. docs/WAVEFRONT_LIVE_ENGINE.md
 * has the long form.
 *
 * All I/O is injected (`LiveRpc`, `Clock`, `StreamSink`, a head function), so the SAME code runs
 * live, in the tests (scripted RPC), and over archive blocks on a simulated clock
 * (`--mode historical`), which is how it is checked against the Oct 10-11 census.
 *
 * THE MINUTE LOOP. Minute m spans [S_m, S_m+60). It is processed once EVERY chain has been
 * scanned (eth_getLogs, both topics, every Aave pool + Morpho Blue, false-empty defence —
 * logs.ts) through a confirmed block with timestamp >= S_m+60, so every liquidation with
 * ts < S_m+60 is known. Then, in order:
 *
 *   1. step     every open kernel whose t0 minute is before m, with the prices of ONE
 *               Multicall3 per chain at the block in force at S_m (the highest block with
 *               ts <= S_m — the Oct 10 pull's rule). A held leg whose value is missing is re-read
 *               on another backend; still missing, that position is NOT stepped this minute (no
 *               silent carry-forward): a gap, logged, counted and flagged on the next tick;
 *   2. events   the liquidations with ts in [S_m, S_m+60), chain order: a pid seen for the first
 *               time is read at N-1 (+ prices at N) exactly as the pull read it, located at the N
 *               prices or else at the N-1 prices (debt accrued to ts(N); `priceBasis: 'N-1'`),
 *               built into the census's spec, and emitted as `open` + `real` (+ its kernels' t0
 *               `mem`); a pid already in the stream gets `real` only. Aave real records count the
 *               protocol fee inside seizedUsd (`protocolFeeUsd`);
 *   3. order    the minute's records sorted by (ts, tick < open < real < mem, emission), USD
 *               rounded to cents, seq assigned, each folded by the ONE reducer (`applyRecord`,
 *               which throws on anything the schema forbids);
 *   4. tick     at m = 9, 19, …: the reducer's fold (coverage {walked, total} and totals);
 *   5. close    a position whose kernels are done, or that has had no activity for the horizon
 *               (default 7 days) with no timer armed, stops being stepped;
 *   6. reconcile every `reconcileEveryMinutes`, the trailing window is re-scanned on other
 *               backends; a missed liquidation is processed then, its records flagged
 *               `late: true` (ts = the append time, `eventTs` = its own) — the stream stays
 *               ordered. A chain's pass has a 120 s budget; one that cannot run (independent
 *               backends down or rate-limiting) is retried next time from where the last one
 *               succeeded, so it never holds the stream;
 *   7. commit   the records and the state in one sink commit.
 *
 * A minute processed more than `backfillLagSeconds` after it ended (a restart after downtime,
 * an RPC outage) has every record flagged `backfilled: true`; its prices and logs are archive
 * reads, so the stream has no gaps. An error anywhere in a minute rolls the engine back to the
 * last committed state and the minute is retried. The Aave markets are re-read from the
 * registry at start-up and every day.
 */
import { MembraneKernel, type KernelSpec } from '../kernel'
import type { MorphoEventRecord } from '../morpho'
import { aaveMarketLabel } from '../pid'
import {
  KIND_RANK,
  STREAM_FORMAT,
  STREAM_SCHEMA,
  applyRecord,
  createReplayState,
  isTickMinute,
  roundRecord,
  tickFromState,
  type ReplayState,
  type StreamRecord,
  type StreamWindow,
} from '../stream'
import {
  AaveReader,
  aaveProtocolFee,
  readAaveMarkets,
  type AaveMarket,
  type AaveRead,
} from './aaveRead'
import type { AaveEventRecord } from '../aave'
import { Blocks } from './blocks'
import { pmap } from './calls'
import {
  eventKey,
  parseState,
  stringifyState,
  type AaveLiquidation,
  type LiqEvent,
  type MorphoLiquidation,
} from './codec'
import {
  CHAIN_CONFIG,
  DEFAULT_OWN_CLUSTERS,
  DEFAULTS,
  MARKETS_REFRESH_MINUTES,
  confirmSeconds,
  type ChainConfig,
  type ChainKey,
} from './config'
import { LogScanner, emptyScanStats, type ChunkProvenance } from './logs'
import { MorphoReader, type MorphoMarketLive } from './morphoRead'
import {
  NO_GRID_END,
  aaveRealRecord,
  aaveSpec,
  aaveUsdOf,
  clusterFn,
  isWalked,
  kernelSpecs,
  legRatio,
  morphoRealRecord,
  morphoSpec,
  morphoUsdMode,
  openRecordOf,
  pathKeys,
  restoreKernel,
  snapshotKernel,
  usdPerUnitFn,
  type UsdMode,
} from './positions'
import { MinutePrices, aaveKey, morphoKey } from './prices'
import type { LiveRpc } from './rpc'
import type { StreamSink } from './sinks'
import {
  emptyCounters,
  loadReplay,
  saveReplay,
  type ChainState,
  type EngineState,
  type LiveHeader,
  type LiveRecord,
  type SavedPosition,
  type TickGaps,
} from './state'

export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number
  sleep(ms: number): Promise<void>
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
}

/** A clock that only moves when slept on (historical mode, tests). */
export class SimClock implements Clock {
  constructor(public t: number) {}
  now() {
    return this.t
  }
  async sleep(ms: number) {
    this.t += Math.max(0, ms)
  }
}

/**
 * The chain head the engine may read up to (before confirmations). Live: the latest block.
 * Historical: the block in force at the simulated time.
 */
export type HeadFn = (chain: ChainKey, blocks: Blocks, nowSec: number) => Promise<number | null>

export const liveHead: HeadFn = (_chain, blocks) => blocks.latest()

/** Historical head: the block in force at the simulated time (bounded by the real head). */
export function clockHead(): HeadFn {
  const real = new Map<ChainKey, number>()
  return async (chain, blocks, nowSec) => {
    let top = real.get(chain)
    if (top === undefined) real.set(chain, (top = await blocks.latest()))
    const r = await blocks.atOrBefore(Math.floor(nowSec), top)
    return r ? r.lo.n : null
  }
}

export interface EngineDeps {
  rpc: LiveRpc
  clock: Clock
  sink: StreamSink
  head: HeadFn
  /** A real delay for error backoff (the simulated clock does not slow RPC retries). */
  backoff?: (ms: number) => Promise<void>
  log?: (msg: string) => void
}

export interface EngineOptions {
  mode: 'live' | 'historical'
  chains: ChainKey[]
  /** Minute 0 of the stream (window.startTs), unix seconds, a multiple of 60. */
  epochTs: number
  /** First minute a NEW stream processes. Ignored on resume. */
  startMinute: number
  /** Stop before processing this minute (historical --to). */
  endMinute?: number
  horizonMinutes?: number
  reconcileEveryMinutes?: number
  reconcileWindowMinutes?: number
  /** Wall-clock budget of one chain's reconciliation pass (default 120 s). */
  reconcileBudgetSeconds?: number
  backfillLagSeconds?: number
  pollSeconds?: number
  readConcurrency?: number
  ownClusters?: readonly string[]
  walkOnAfterT0BandSale?: boolean
  /** Kernel grid end (the census's 2,879); default: none. */
  lastMinute?: number
  chainConfig?: Partial<Record<ChainKey, ChainConfig>>
}

interface ChainRt {
  cfg: ChainConfig
  blocks: Blocks
  scanner: LogScanner
  /** One reader per Aave pool (the registry's markets). */
  aave: Map<string, AaveReader>
  morpho: MorphoReader
  prices: MinutePrices
}

interface ActivePosition {
  saved: Omit<SavedPosition, 'kernels'>
  specs: Omit<KernelSpec, 'usdPerUnit'>[]
  kernels: MembraneKernel[]
}

type Read =
  | { kind: 'aave'; read: AaveRead; atNm1: AaveEventRecord | null }
  | {
      kind: 'morpho'
      open: boolean
      record: MorphoEventRecord
      atNm1: MorphoEventRecord | null
      market: MorphoMarketLive
      usd: UsdMode
    }

const emptyGaps = (): TickGaps => ({ positionMinutes: 0, positions: 0, sample: [] })

export class LiveEngine {
  readonly opts: Required<
    Omit<EngineOptions, 'endMinute' | 'walkOnAfterT0BandSale' | 'chainConfig'>
  > &
    Pick<EngineOptions, 'endMinute' | 'walkOnAfterT0BandSale'>
  readonly rt = {} as Record<ChainKey, ChainRt>
  state!: EngineState
  private committed = ''
  private replay: ReplayState = createReplayState()
  private active = new Map<string, ActivePosition>()
  private gapPids = new Set<string>()
  private window!: StreamWindow
  private cluster: ReturnType<typeof clusterFn>
  private log: (msg: string) => void
  /** What the engine is doing now (status / stall diagnosis). */
  phase = 'idle'
  /** Timing of the last processed minutes, for the smoke report. */
  readonly minuteLog: { minute: number; ms: number; records: number; backfilled: boolean }[] = []

  constructor(
    readonly deps: EngineDeps,
    options: EngineOptions,
  ) {
    this.opts = {
      horizonMinutes: DEFAULTS.horizonMinutes,
      reconcileEveryMinutes: DEFAULTS.reconcileEveryMinutes,
      reconcileWindowMinutes: DEFAULTS.reconcileWindowMinutes,
      reconcileBudgetSeconds: 120,
      backfillLagSeconds: DEFAULTS.backfillLagSeconds,
      pollSeconds: DEFAULTS.pollSeconds,
      readConcurrency: DEFAULTS.readConcurrency,
      ownClusters: DEFAULT_OWN_CLUSTERS,
      lastMinute: NO_GRID_END,
      ...options,
    } as LiveEngine['opts']
    if (options.epochTs % 60 !== 0) throw new Error('epochTs must be a multiple of 60')
    this.cluster = clusterFn(this.opts.ownClusters)
    this.log = deps.log ?? (() => {})
    for (const chain of this.opts.chains) {
      const cfg = { ...CHAIN_CONFIG[chain], ...(options.chainConfig?.[chain] ?? {}) }
      const blocks = new Blocks(deps.rpc, chain, cfg.blockSeconds)
      this.rt[chain] = {
        cfg,
        blocks,
        scanner: new LogScanner(deps.rpc, cfg, blocks),
        aave: new Map(),
        morpho: new MorphoReader(deps.rpc, cfg),
        prices: new MinutePrices(deps.rpc, chain),
      }
    }
  }

  /** Minute start, unix seconds. */
  S(m: number): number {
    return this.window.startTs + 60 * m
  }

  minuteOf(ts: number): number {
    return Math.floor((ts - this.window.startTs) / 60)
  }

  // ---------------------------------------------------------------- markets

  /** The Core market's reader (Morpho loan tokens are priced from its oracle). */
  private core(c: ChainKey): AaveReader {
    const r = this.rt[c].aave.get(this.rt[c].cfg.aavePool)
    if (!r) throw new Error(`${c}: Core Aave market not resolved`)
    return r
  }

  /** (Re)read the chain's Aave markets from the registry at `block`; new pools get readers. */
  private async resolveMarkets(c: ChainKey, block: number, minute: number) {
    const rt = this.rt[c]
    const list = await readAaveMarkets(this.deps.rpc, rt.cfg, block)
    const before = new Set(rt.aave.keys())
    for (const m of list) {
      if (!rt.aave.has(m.pool))
        rt.aave.set(
          m.pool,
          new AaveReader(this.deps.rpc, rt.cfg, m, async (n) => (await rt.blocks.header(n)).ts),
        )
    }
    rt.scanner.setAavePools([...rt.aave.keys()])
    const added = list.filter((m) => !before.has(m.pool))
    if (added.length)
      this.log(
        `${c}: Aave markets ${list
          .map((m) => `${aaveMarketLabel(c, m.pool, m.marketId)} ${m.pool} (${m.marketId})`)
          .join('; ')}`,
      )
    this.state.markets[c] = { minute, list }
    this.state.counters.marketRefreshes++
  }

  // ---------------------------------------------------------------- state

  private serialize(): string {
    const positions: SavedPosition[] = [...this.active.values()].map((p) => ({
      ...p.saved,
      kernels: p.kernels.map((k, i) => ({ spec: p.specs[i], snap: snapshotKernel(k) })),
    }))
    const scanStats: EngineState['scanStats'] = {}
    for (const c of this.opts.chains) scanStats[c] = { ...this.rt[c].scanner.stats }
    return stringifyState({
      ...this.state,
      replay: saveReplay(this.replay),
      positions,
      scanStats,
    } satisfies EngineState)
  }

  private restore(text: string) {
    const s = parseState<EngineState>(text)
    this.state = s
    this.window = s.header.window
    this.replay = loadReplay(s.replay)
    this.active.clear()
    this.gapPids.clear()
    for (const p of s.positions) {
      const { kernels, ...saved } = p
      const usdPerUnit = this.usdFn(p.chain, p.usd)
      this.active.set(p.pid, {
        saved,
        specs: kernels.map((k) => k.spec),
        kernels: kernels.map((k) => restoreKernel({ ...k.spec, usdPerUnit }, k.snap)),
      })
    }
    for (const c of this.opts.chains) {
      const st = s.scanStats[c]
      if (st) Object.assign(this.rt[c].scanner.stats, st)
    }
  }

  private usdFn(chain: ChainKey, mode: UsdMode) {
    const rt = this.rt[chain]
    return usdPerUnitFn(
      mode,
      (minute, key) => rt.prices.get(minute, key),
      Number(rt.aave.get(rt.cfg.aavePool)?.setup?.baseUnit ?? 1e8),
    )
  }

  /** Load the committed state, or create a new stream. */
  async init(): Promise<'created' | 'resumed'> {
    const text = await this.deps.sink.load()
    if (text) {
      const s = parseState<EngineState>(text)
      const chains = s.header.chains.join()
      if (chains !== this.opts.chains.join())
        throw new Error(`stream was created for chains ${chains}, not ${this.opts.chains.join()}`)
      if (s.header.window.startTs !== this.opts.epochTs)
        this.log(`resume: stream epoch ${s.header.window.startTs} (option ${this.opts.epochTs} ignored)`)
      this.window = s.header.window
      this.state = s
      // Markets and setups first: restored positions price from them.
      for (const c of this.opts.chains) {
        const cs = s.chains[c]!
        await this.resolveMarkets(c, cs.scannedTo, s.nextMinute)
        await this.core(c).ensureSetup(cs.scannedTo)
      }
      s.markets = this.state.markets
      this.restore(stringifyState(s))
      this.committed = text
      this.log(
        `resumed at minute ${s.nextMinute} (${new Date(this.S(s.nextMinute) * 1000).toISOString()}), seq ${s.seq}, ${this.active.size} open positions`,
      )
      return 'resumed'
    }
    this.window = { startTs: this.opts.epochTs, stepSeconds: 60, minutes: 0 }
    const header: LiveHeader = {
      kind: 'header',
      format: STREAM_FORMAT,
      schema: STREAM_SCHEMA,
      window: this.window,
      engine: 'wavefront-live',
      mode: this.opts.mode,
      chains: this.opts.chains,
      createdAt: new Date(this.deps.clock.now()).toISOString(),
    }
    this.state = {
      v: 1,
      header,
      seq: 0,
      lastTs: -Infinity,
      nextMinute: this.opts.startMinute,
      chains: {},
      replay: saveReplay(createReplayState()),
      positions: [],
      counters: emptyCounters(),
      scanStats: {},
      pendingGaps: emptyGaps(),
      markets: {},
    }
    const S0 = this.S(this.opts.startMinute)
    for (const c of this.opts.chains) {
      const rt = this.rt[c]
      // The stream starts after the last block before minute startMinute.
      let at: Awaited<ReturnType<Blocks['atOrBefore']>> = null
      for (let i = 0; !at; i++) {
        at = await rt.blocks.atOrBefore(S0 - 1, await rt.blocks.latest())
        if (!at) {
          if (i > 60) throw new Error(`${c}: no block after ${S0 - 1} yet`)
          await this.deps.clock.sleep(5000)
        }
      }
      await this.resolveMarkets(c, at.lo.n, this.opts.startMinute)
      await this.core(c).ensureSetup(at.lo.n)
      await rt.morpho.checkCode(at.lo.n)
      this.state.chains[c] = {
        scannedTo: at.lo.n,
        scannedToTs: at.lo.ts,
        firstBlock: at.lo.n + 1,
        reconciledTo: at.lo.n,
        pending: [],
        seen: [],
        chunks: [],
        minuteBlocks: [],
      }
    }
    this.replay = createReplayState()
    const initial = this.serialize()
    await this.deps.sink.create(header, initial)
    this.committed = initial
    this.log(
      `created stream at minute ${this.opts.startMinute} (${new Date(S0 * 1000).toISOString()}); first blocks ${this.opts.chains
        .map((c) => `${c} ${this.state.chains[c]!.firstBlock}`)
        .join(', ')}`,
    )
    return 'created'
  }

  private rollback() {
    this.restore(this.committed)
  }

  // ---------------------------------------------------------------- polling

  private cs(c: ChainKey): ChainState {
    return this.state.chains[c]!
  }

  /** Scan one chain's new confirmed blocks into `pending`. Mutates the chain state only on success. */
  async poll(c: ChainKey, needTs?: number): Promise<void> {
    const rt = this.rt[c]
    const cs = this.cs(c)
    const head = await this.deps.head(c, rt.blocks, this.deps.clock.now() / 1000)
    if (head === null) return
    const target = head - rt.cfg.confirmations
    if (target <= cs.scannedTo) return
    // Not far enough yet for the minute being waited on: wait rather than scan a partial range
    // (a scan costs a logs call and, when empty, its re-ask).
    const h = await rt.blocks.header(target)
    if (needTs !== undefined && h.ts < needTs) return
    const { events, chunks } = await rt.scanner.scan(cs.scannedTo + 1, target)
    const known = new Set([...cs.pending.map(eventKey), ...cs.seen.map(([k]) => k)])
    for (const e of events) if (!known.has(eventKey(e))) cs.pending.push(e)
    cs.chunks.push(...chunks)
    cs.scannedTo = target
    cs.scannedToTs = h.ts
  }

  private async minuteBlock(c: ChainKey, m: number): Promise<number> {
    const cs = this.cs(c)
    const hit = cs.minuteBlocks.find(([k]) => k === m)
    if (hit) return hit[1]
    const r = await this.rt[c].blocks.atOrBefore(this.S(m), cs.scannedTo)
    if (!r) throw new Error(`${c}: minute ${m} start is not settled (scanned to ${cs.scannedTo})`)
    cs.minuteBlocks.push([m, r.lo.n])
    if (cs.minuteBlocks.length > 8) cs.minuteBlocks.splice(0, cs.minuteBlocks.length - 8)
    return r.lo.n
  }

  // ---------------------------------------------------------------- the loop

  /** Process minutes until `stop()` or endMinute. */
  async run(stop: () => boolean = () => false): Promise<void> {
    const backoff = this.deps.backoff ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    let failures = 0
    while (!stop()) {
      const m = this.state.nextMinute
      if (this.opts.endMinute !== undefined && m >= this.opts.endMinute) break
      const E = this.S(m + 1)
      try {
        let waitUntil = 0
        const due: ChainKey[] = []
        for (const c of this.opts.chains) {
          if (this.cs(c).scannedToTs >= E) continue
          const at = (E + confirmSeconds(this.rt[c].cfg) + 1) * 1000
          if (this.deps.clock.now() < at) waitUntil = Math.max(waitUntil, at)
          else due.push(c)
        }
        // Chains are polled in parallel; each mutates only its own state, and only on success.
        this.phase = `poll ${due.join(',')} for minute ${m}`
        const polled = await Promise.allSettled(due.map((c) => this.poll(c, E)))
        this.phase = 'idle'
        const failed = polled.find((p): p is PromiseRejectedResult => p.status === 'rejected')
        if (failed) throw failed.reason
        for (const c of due)
          if (this.cs(c).scannedToTs < E)
            waitUntil = Math.max(waitUntil, this.deps.clock.now() + this.opts.pollSeconds * 1000)
        if (waitUntil) {
          if (stop()) break
          await this.deps.clock.sleep(Math.max(0, waitUntil - this.deps.clock.now()))
          continue
        }
        const recs = await this.processMinute(m)
        failures = 0
        const last = this.minuteLog[this.minuteLog.length - 1]
        this.log(
          `minute ${m} ${new Date(this.S(m) * 1000).toISOString().slice(11, 16)}: ${recs.length} records (${recs.filter((r) => r.kind === 'open').length} open, ${recs.filter((r) => r.kind === 'real').length} real, ${recs.filter((r) => r.kind === 'mem').length} mem), ${this.active.size} positions walking, seq ${this.state.seq}, ${last?.ms ?? 0} ms${last?.backfilled ? ', backfilled' : ''}`,
        )
      } catch (e) {
        failures++
        this.log(`minute ${m}: ${(e as Error).message} (attempt ${failures}; rolled back)`)
        this.rollback()
        this.state.counters.errors++
        await backoff(Math.min(120_000, 2_000 * 2 ** Math.min(6, failures - 1)))
      }
    }
  }

  /** Steps 1-7 for minute m (see the header). Throws on any failure; nothing is committed then. */
  async processMinute(m: number): Promise<LiveRecord[]> {
    const t0 = Date.now()
    const S = this.S(m)
    const E = S + 60
    const live = this.opts.mode === 'live'
    const backfilled = live && this.deps.clock.now() / 1000 > E + this.opts.backfillLagSeconds
    const out: { rec: StreamRecord; i: number }[] = []
    const push = (rec: StreamRecord) => out.push({ rec, i: out.length })

    // ---- 0. markets: re-read the registry once a day of stream time
    for (const c of this.opts.chains) {
      const mk = this.state.markets[c]
      if (!mk || m - mk.minute >= MARKETS_REFRESH_MINUTES) {
        this.phase = `minute ${m}: markets ${c}`
        await this.resolveMarkets(c, await this.minuteBlock(c, m), m)
      }
    }

    // ---- 1. step
    this.phase = `minute ${m}: step`
    const stepping = [...this.active.values()].filter((p) => p.saved.t0Minute < m)
    const chainsStepping = [...new Set(stepping.map((p) => p.saved.chain))]
    const missing = new Map<ChainKey, Set<string>>()
    await Promise.all(
      chainsStepping.map(async (c) => {
        const ps = stepping.filter((p) => p.saved.chain === c)
        const prices = this.rt[c].prices
        const block = await this.minuteBlock(c, m)
        const usdKeys = ps.flatMap((p) => (p.saved.usd.kind === 'aave' ? [p.saved.usd.key] : []))
        const legKeys = ps.flatMap((p) => Object.values(p.saved.legKeys))
        await prices.ensure(m, block, [...legKeys, ...usdKeys])
        // No silent carry-forward: a held leg's missing value is re-read on another backend.
        const nulls = legKeys.filter((k) => prices.get(m, k) == null)
        if (nulls.length) {
          this.state.counters.priceRetries++
          missing.set(c, new Set(await prices.retryMissing(m, nulls)))
        }
      }),
    )
    for (const p of stepping) {
      const gone = missing.get(p.saved.chain)
      const lacking = gone ? Object.values(p.saved.legKeys).filter((k) => gone.has(k)) : []
      if (lacking.length) {
        this.recordGap(p.saved.pid, m, lacking)
        continue
      }
      for (const r of this.stepPosition(p, m)) push(r)
    }

    // ---- 2. events of the minute
    this.phase = `minute ${m}: events`
    const evs: LiqEvent[] = []
    for (const c of this.opts.chains) {
      const cs = this.cs(c)
      const keep: LiqEvent[] = []
      for (const e of cs.pending) {
        if (e.ts < S) throw new Error(`${c} event ${eventKey(e)} at ${e.ts} is before minute ${m}`)
        if (e.ts < E) evs.push(e)
        else keep.push(e)
      }
      cs.pending = keep
    }
    const chainIdx = (c: ChainKey) => this.opts.chains.indexOf(c)
    evs.sort(
      (a, b) =>
        a.ts - b.ts ||
        chainIdx(a.chain) - chainIdx(b.chain) ||
        a.block - b.block ||
        a.logIndex - b.logIndex,
    )
    for (const r of await this.applyEvents(evs, m)) push(r)
    for (const e of evs) this.cs(e.chain).seen.push([eventKey(e), e.ts])

    // ---- 3. order, round, seq, fold
    const emitted: LiveRecord[] = []
    const flags = backfilled ? { backfilled: true as const } : {}
    out.sort((a, b) => a.rec.ts - b.rec.ts || KIND_RANK[a.rec.kind] - KIND_RANK[b.rec.kind] || a.i - b.i)
    for (const { rec } of out) emitted.push(this.append(roundRecord(rec), flags))

    // ---- 4. tick
    if (isTickMinute(m)) {
      const t = tickFromState(this.replay, this.window, m) as LiveRecord
      if (this.state.pendingGaps.positionMinutes) {
        t.gaps = { ...this.state.pendingGaps, positions: this.gapPids.size }
        this.state.pendingGaps = emptyGaps()
        this.gapPids.clear()
      }
      emitted.push(this.append(t, flags))
      this.state.counters.ticks++
    }

    // ---- 5. close
    for (const [pid, p] of this.active) {
      const done = p.kernels.every((k) => k.isDone)
      const idle =
        m - p.saved.lastActivityMinute >= this.opts.horizonMinutes && !p.kernels.some((k) => k.armed)
      if (done || idle) {
        this.active.delete(pid)
        this.state.counters.closedPositions++
      }
    }

    // ---- 6. reconcile
    const every = this.opts.reconcileEveryMinutes
    if (every > 0 && (m + 1) % every === 0) {
      this.phase = `minute ${m}: reconcile`
      for (const r of await this.reconcile(m)) emitted.push(r)
    }

    // ---- 7. commit
    this.phase = `minute ${m}: commit`
    const keepFrom = E - 60 * (this.opts.reconcileWindowMinutes + Math.max(every, 1) + 5)
    for (const c of this.opts.chains) {
      const cs = this.cs(c)
      cs.seen = cs.seen.filter(([, ts]) => ts >= keepFrom)
      this.rt[c].prices.prune(m - 2)
    }
    this.state.nextMinute = m + 1
    this.state.counters.minutes++
    if (backfilled) this.state.counters.backfilledMinutes++
    const text = this.serialize()
    await this.deps.sink.commit(emitted, text)
    this.committed = text
    this.phase = 'idle'
    this.minuteLog.push({ minute: m, ms: Date.now() - t0, records: emitted.length, backfilled })
    if (this.minuteLog.length > 10_000) this.minuteLog.shift()
    return emitted
  }

  private recordGap(pid: string, m: number, keys: string[]) {
    const g = this.state.pendingGaps
    g.positionMinutes++
    this.gapPids.add(pid)
    if (g.sample.length < 20) g.sample.push(`${pid}@${m}: ${keys.join(', ')}`)
    this.state.counters.gapPositionMinutes++
    this.log(`GAP minute ${m}: ${pid} not stepped, oracle value missing on every backend for ${keys.join(', ')}`)
  }

  /** Fold a record into the reducer and give it its seq (and flags). */
  private append(rec: StreamRecord, flags: { backfilled?: true; late?: true; eventTs?: number }) {
    const r = { ...rec, ...flags, seq: this.state.seq + 1 } as LiveRecord
    applyRecord(this.replay, r)
    this.state.seq = r.seq
    this.state.lastTs = r.ts
    const c = this.state.counters
    c.records++
    if (r.kind === 'open') c.opens++
    else if (r.kind === 'real') c.reals++
    else if (r.kind === 'mem') c.mems++
    return r
  }

  private stepPosition(p: ActivePosition, m: number): StreamRecord[] {
    const prices = this.rt[p.saved.chain].prices
    const price = (legKey: string) => {
      const k = p.saved.legKeys[legKey]
      return k ? prices.get(m, k) : undefined
    }
    const out: StreamRecord[] = []
    for (const k of p.kernels) {
      if (k.isDone) continue
      out.push(...k.step(m, (leg) => legRatio(leg, p.saved.anchors, price)))
    }
    if (out.length) p.saved.lastActivityMinute = m
    return out
  }

  // ---------------------------------------------------------------- events

  private async aaveReader(e: AaveLiquidation): Promise<AaveReader> {
    const rt = this.rt[e.chain]
    let r = rt.aave.get(e.pool)
    if (!r) {
      await this.resolveMarkets(e.chain, e.block - 1, this.minuteOf(e.ts))
      r = rt.aave.get(e.pool)
      if (!r) throw new Error(`${e.chain}: ${e.pool} emitted LiquidationCall but is not in the registry`)
    }
    return r
  }

  /** The pull's reads for a batch of liquidations, in parallel. */
  private async readEvents(evs: LiqEvent[], m: number): Promise<Map<string, Read>> {
    const reads = new Map<string, Read>()
    // Which events open their position (the first of an unknown pid in this batch).
    const opening = new Set<string>()
    const seenPid = new Set<string>()
    for (const e of evs) {
      if (!this.replay.positions.has(e.pid) && !seenPid.has(e.pid)) opening.add(eventKey(e))
      seenPid.add(e.pid)
    }
    await pmap(evs, this.opts.readConcurrency, async (e) => {
      const rt = this.rt[e.chain]
      const isOpen = opening.has(eventKey(e))
      if (e.protocol === 'aave-v3') {
        const reader = await this.aaveReader(e)
        const read = await reader.read(e)
        if (!read.hfExact) this.state.counters.hfMismatch++
        // Not located at the N prices: the N-1 prices, balances accrued to ts(N).
        const atNm1 =
          isOpen && !read.record.atN.liquidatable ? await reader.locateAtNm1(e, read) : null
        // The real side falls back to the minute path when the re-read lacks a block-N price.
        const missing = [e.debtAsset, e.collateralAsset].filter((a) => {
          const r = read.record.position.find((x) => x.asset === a)
          return !(r && r.priceN != null && BigInt(r.priceN) > 0n)
        })
        if (missing.length)
          await rt.prices.ensure(
            m,
            await this.minuteBlock(e.chain, m),
            missing.map((a) => aaveKey(reader.setup!.oracle, a)),
          )
        reads.set(eventKey(e), { kind: 'aave', read, atNm1 })
      } else {
        const core = this.core(e.chain)
        await core.ensureSetup(e.block - 1)
        const got = isOpen ? await rt.morpho.readOpen(e) : null
        const market = got?.market ?? (await rt.morpho.market(e.marketId, e.block - 1))
        const usd = morphoUsdMode(
          market.loanSymbol,
          core.isReserve(market.loanToken) ? aaveKey(core.setup!.oracle, market.loanToken) : null,
        )
        if (usd.kind === 'aave') await rt.prices.ensure(m, await this.minuteBlock(e.chain, m), [usd.key])
        reads.set(eventKey(e), {
          kind: 'morpho',
          open: isOpen,
          record: got?.record ?? (await rt.morpho.readLater(e)),
          atNm1: got?.atNm1 ?? null,
          market,
          usd,
        })
      }
    })
    return reads
  }

  /** Records of a batch of liquidations (one minute, or the late ones), in event order. */
  private async applyEvents(evs: LiqEvent[], m: number): Promise<StreamRecord[]> {
    if (!evs.length) return []
    const reads = await this.readEvents(evs, m)
    const out: StreamRecord[] = []
    const ctr = this.state.counters
    for (const e of evs) {
      ctr.eventsByChain[e.chain] = (ctr.eventsByChain[e.chain] ?? 0) + 1
      const read = reads.get(eventKey(e))!
      const known =
        this.replay.positions.has(e.pid) || out.some((r) => r.kind === 'open' && r.pid === e.pid)
      if (read.kind === 'aave') {
        const real = this.aaveReal(e as AaveLiquidation, read.read, m)
        if (known) {
          out.push(real)
          this.touch(e.pid, m)
          continue
        }
        const pool = (e as AaveLiquidation).pool
        const spec = aaveSpec(read.atNm1 ?? read.read.record, this.window, pool)
        const open = openRecordOf(spec, this.cluster(spec)) as LiveRecord
        if (read.atNm1 && isWalked(spec)) {
          open.priceBasis = 'N-1'
          ctr.locatedAtNm1++
        }
        out.push(open, real)
        const oracle = read.read.raw.setup.oracle
        out.push(...this.startPosition(spec, { kind: 'usd' }, m, (k) => aaveKey(oracle, k)))
      } else {
        const usdPerUnit = this.usdFn(e.chain, read.usd)
        const real = morphoRealRecord(e as MorphoLiquidation, read.record, usdPerUnit(m))
        if (known || !read.open) {
          out.push(real)
          this.touch(e.pid, m)
          continue
        }
        const spec = morphoSpec(
          read.atNm1 ?? read.record,
          { collateral: read.market.collateralSymbol, loan: read.market.loanSymbol },
          usdPerUnit,
          this.window,
        )
        const open = openRecordOf(spec, this.cluster(spec)) as LiveRecord
        if (read.atNm1 && isWalked(spec)) {
          open.priceBasis = 'N-1'
          ctr.locatedAtNm1++
        }
        out.push(open, real)
        out.push(...this.startPosition(spec, read.usd, m, (k) => morphoKey(k)))
      }
    }
    return out
  }

  private aaveReal(e: AaveLiquidation, r: AaveRead, m: number) {
    const setup = r.raw.setup
    const dec = (a: string) => {
      const x = setup.assets.find((y) => y.address === a)
      if (!x) throw new Error(`${e.chain}: ${a} is not a reserve of ${e.pool}`)
      return x.decimals
    }
    const unit = Number(setup.baseUnit)
    const fee = aaveProtocolFee(
      BigInt(e.liquidatedCollateralAmount),
      r.fee.bonus,
      r.fee.feePct,
      r.fee.revision,
    )
    const prices = this.rt[e.chain].prices
    return aaveRealRecord(
      e,
      r.record,
      { debt: dec(e.debtAsset), collateral: dec(e.collateralAsset) },
      (asset) => aaveUsdOf(prices.get(m, aaveKey(setup.oracle, asset)), unit),
      fee,
    )
  }

  private touch(pid: string, m: number) {
    const p = this.active.get(pid)
    if (p) p.saved.lastActivityMinute = Math.max(p.saved.lastActivityMinute, m)
  }

  /** Build a walked position's kernels, run their t0 step, and keep it open if it walks on. */
  private startPosition(
    spec: ReturnType<typeof aaveSpec>,
    usd: UsdMode,
    m: number,
    priceKeyOf: (legKey: string) => string,
  ): StreamRecord[] {
    if (!isWalked(spec)) return []
    const specs = kernelSpecs(spec, this.window, {
      lastMinute: this.opts.lastMinute,
      walkOnAfterT0BandSale: this.opts.walkOnAfterT0BandSale,
    })
    const usdPerUnit = this.usdFn(spec.chain as ChainKey, usd)
    const kernels = specs.map((s) => new MembraneKernel({ ...s, usdPerUnit }))
    const out: StreamRecord[] = []
    for (const k of kernels) out.push(...k.start())
    if (kernels.every((k) => k.isDone)) return out
    const { anchors, keys } = pathKeys(spec)
    this.active.set(spec.pid, {
      saved: {
        pid: spec.pid,
        chain: spec.chain as ChainKey,
        protocol: spec.protocol,
        usd,
        legKeys: Object.fromEntries(keys.filter(Boolean).map((k) => [k, priceKeyOf(k)])),
        anchors,
        t0Minute: spec.t0!.minute,
        lastActivityMinute: Math.max(m, spec.t0!.minute),
      },
      specs,
      kernels,
    })
    return out
  }

  // ---------------------------------------------------------------- reconciliation

  /**
   * Re-scan the trailing window of every chain on independent backends; process what the primary
   * scan missed as `late` records appended at the end of minute m. A chain whose reconciliation
   * cannot run is skipped (counted) and covered next time from where it last succeeded.
   */
  private async reconcile(m: number): Promise<LiveRecord[]> {
    const E = this.S(m + 1)
    const fromMinute = m + 1 - this.opts.reconcileWindowMinutes
    const late: LiqEvent[] = []
    const ctr = this.state.counters
    for (const c of this.opts.chains) {
      const rt = this.rt[c]
      const cs = this.cs(c)
      try {
        const fromAt = await rt.blocks.atOrBefore(this.S(fromMinute) - 1, cs.scannedTo)
        const toAt = await rt.blocks.atOrBefore(E - 1, cs.scannedTo)
        if (!toAt) continue
        // Never leave a hole: start no later than where the last successful pass ended.
        const from = Math.max(
          cs.firstBlock,
          Math.min(fromAt ? fromAt.lo.n + 1 : cs.firstBlock, (cs.reconciledTo ?? cs.firstBlock - 1) + 1),
        )
        const to = toAt.lo.n
        if (to < from) continue
        const chunks: ChunkProvenance[] = cs.chunks.filter((x) => x.to >= from && x.from <= to)
        // A time budget: an independent backend that is rate-limiting must not hold the stream
        // (the pass is retried next time from where the last success ended).
        let timer: ReturnType<typeof setTimeout> | undefined
        const got = await Promise.race([
          rt.scanner.reconcile(from, to, chunks),
          new Promise<never>((_, rej) => {
            timer = setTimeout(
              () => rej(new Error(`over its ${this.opts.reconcileBudgetSeconds} s budget`)),
              this.opts.reconcileBudgetSeconds * 1000,
            )
          }),
        ]).finally(() => clearTimeout(timer))
        ctr.reconcileRuns++
        ctr.reconcileCalls += got.calls
        const seen = new Set(cs.seen.map(([k]) => k))
        const later = new Set(cs.pending.map(eventKey)) // events of later minutes are not late
        const found = new Set<string>()
        for (const e of got.events) {
          const k = eventKey(e)
          found.add(k)
          if (e.ts >= E || seen.has(k) || later.has(k)) continue
          late.push(e)
        }
        // Seen events in the window the reconciliation did not return (short answer / reorg).
        const fromTs = (await rt.blocks.header(from)).ts
        for (const [k, ts] of cs.seen) if (ts >= fromTs && ts < E && !found.has(k)) ctr.reconcileShort++
        cs.reconciledTo = to
        cs.chunks = cs.chunks.filter((x) => x.to >= from)
      } catch (e) {
        ctr.reconcileFailures = (ctr.reconcileFailures ?? 0) + 1
        this.log(`reconciliation of ${c} at minute ${m} failed (${(e as Error).message}); retried next time`)
      }
    }
    if (!late.length) return []
    ctr.lateEvents += late.length
    this.log(`reconciliation at minute ${m}: ${late.length} late event(s)`)
    const chainIdx = (c: ChainKey) => this.opts.chains.indexOf(c)
    late.sort(
      (a, b) =>
        a.ts - b.ts ||
        chainIdx(a.chain) - chainIdx(b.chain) ||
        a.block - b.block ||
        a.logIndex - b.logIndex,
    )
    const out: LiveRecord[] = []
    for (const e of late) {
      const em = this.minuteOf(e.ts)
      const recs = await this.applyEvents([e], em)
      // A late position walks from its own t0 to minute m on archive prices (catch-up).
      const p = this.active.get(e.pid)
      if (p && recs.some((r) => r.kind === 'open')) {
        for (let k = p.saved.t0Minute + 1; k <= m && this.active.has(e.pid); k++) {
          const block = await this.minuteBlock(e.chain, k)
          const prices = this.rt[e.chain].prices
          const keys = Object.values(p.saved.legKeys)
          await prices.ensure(k, block, [...keys, ...(p.saved.usd.kind === 'aave' ? [p.saved.usd.key] : [])])
          const lacking = await prices.retryMissing(k, keys)
          if (lacking.length) {
            this.recordGap(e.pid, k, lacking)
            continue
          }
          recs.push(...this.stepPosition(p, k))
        }
      }
      for (const r of recs) {
        const rounded = roundRecord(r)
        out.push(this.append({ ...rounded, ts: Math.max(rounded.ts, E) }, { late: true, eventTs: rounded.ts }))
      }
      this.cs(e.chain).seen.push([eventKey(e), e.ts])
    }
    return out
  }

  // ---------------------------------------------------------------- reporting

  status() {
    return {
      phase: this.phase,
      nextMinute: this.state.nextMinute,
      nextMinuteIso: new Date(this.S(this.state.nextMinute) * 1000).toISOString(),
      seq: this.state.seq,
      openPositions: this.active.size,
      coverage: { ...this.replay.coverage },
      totals: this.replay.totals,
      counters: this.state.counters,
      chains: Object.fromEntries(
        this.opts.chains.map((c) => [
          c,
          {
            scannedTo: this.cs(c).scannedTo,
            firstBlock: this.cs(c).firstBlock,
            blocksScanned: this.cs(c).scannedTo - this.cs(c).firstBlock + 1,
            pending: this.cs(c).pending.length,
            markets: this.state.markets[c]?.list.map((x) => `${aaveMarketLabel(c, x.pool, x.marketId)} ${x.pool}`),
            scan: this.rt[c].scanner.stats,
            quarantine: this.rt[c].scanner.quarantineLog,
            headerReads: this.rt[c].blocks.headerReads,
            priceMulticalls: this.rt[c].prices.multicalls,
            priceRetries: this.rt[c].prices.retries,
            aave: Object.fromEntries([...this.rt[c].aave].map(([pool, r]) => [pool, r.stats])),
            morpho: this.rt[c].morpho.stats,
          },
        ]),
      ),
    }
  }
}

export { emptyScanStats }
