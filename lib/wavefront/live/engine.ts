/**
 * THE LIVE WAVEFRONT ENGINE — Real vs Membrane on every Aave V3 liquidation in scope (every pool
 * of the chain's PoolAddressesProviderRegistry, + allow-listed instances) and every Morpho Blue
 * liquidation on Ethereum, Arbitrum, Optimism and Base, appended to the wavefront stream (schema
 * v1, lib/wavefront/stream.ts) minute by minute. docs/WAVEFRONT_LIVE_ENGINE.md has the long form.
 *
 * All I/O is injected (`LiveRpc`, `Clock`, `StreamSink`, a head function), so the SAME code runs
 * live, in the tests (scripted RPC), and over archive blocks on a simulated clock
 * (`--mode historical`), which is how it is checked against the Oct 10-11 census.
 *
 * THE MINUTE LOOP. Minute m spans [S_m, S_m+60). A chain is READY for m once it has been scanned
 * (eth_getLogs by topic, every emitter classified, every chunk on two backends — logs.ts) through
 * a confirmed block with timestamp >= S_m+60, so every liquidation on it with ts < S_m+60 is
 * known. Minute m is processed when every chain is ready — or when the chains that are not have
 * been LAGGING for `chainStallSeconds` (live: 300 s; historical: never). A lagging chain does not
 * hold the others: its positions are not stepped and its liquidations not read for those minutes
 * (flagged on the next tick, `gaps.lagging`), it is polled again with backoff, and when it
 * answers its missed minutes are caught up — stepped on archive prices, liquidations processed —
 * as `late` records (ts = the append time, `eventTs` = their own). Then, for the ready chains:
 *
 *   1. step     every open kernel whose t0 minute is before m, with the prices of ONE
 *               Multicall3 per chain at the block in force at S_m (the highest block with
 *               ts <= S_m — the Oct 10 pull's rule). A held leg whose value is missing is re-read
 *               on another backend; still missing, that position is NOT stepped this minute (no
 *               silent carry-forward): a gap, logged, counted and flagged on the next tick; a
 *               position whose oracle stays silent `maxGapMinutes` in a row is closed (reason on
 *               the tick);
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
 *   5. close    a position whose kernels are done, that has had no activity for the horizon
 *               (default 7 days) with no timer armed, or whose oracle is silent, stops being
 *               stepped — and leaves the state at this commit (the stream is its archive);
 *   6. reconcile reconciliation runs OFF the minute path: every `reconcileEveryMinutes` a
 *               background pass per chain re-scans the trailing window on other backends, with
 *               a wall-clock budget at which it is CANCELLED (AbortSignal). A finished pass is
 *               consumed by the next minute: what the primary scan missed is processed then,
 *               flagged `late: true`. A failed or cancelled pass is retried next time from where
 *               the last success ended (capped at `reconcileMaxCatchupMinutes`, counted). The
 *               processed-event keys a future pass could re-find are never pruned, so a re-found
 *               event is never mistaken for a missed one (`retainFromTs`);
 *   7. commit   the records and the state in one sink commit.
 *
 * A minute processed more than `backfillLagSeconds` after it ended (a restart after downtime,
 * an RPC outage) has every record flagged `backfilled: true`; its prices and logs are archive
 * reads, so the stream has no gaps. An error anywhere in a minute rolls the engine back to the
 * last committed state and the minute is retried. A commit whose outcome was unknown and turned
 * out to have landed (Postgres) makes the engine reload from the sink. The Aave markets are
 * re-read from the registry at start-up, on an unknown emitter, and every day.
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
  type OpenRecord,
  type PositionState,
  type ReplayState,
  type StreamRecord,
  type StreamWindow,
} from '../stream'
import {
  AaveReader,
  aaveProtocolFee,
  readAaveMarketOf,
  readAaveMarkets,
  readAddressesProvider,
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
  KNOWN_NON_REGISTRY_AAVE,
  MARKETS_REFRESH_MINUTES,
  MORPHO_LIQUIDATE_TOPIC,
  allowedAaveProviders,
  confirmSeconds,
  type ChainConfig,
  type ChainKey,
} from './config'
import { LogScanner, emptyScanStats, type ChunkProvenance, type EmitterKind } from './logs'
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
import { AbortedError, type LiveRpc } from './rpc'
import { SinkAheadError, type StreamSink } from './sinks'
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
 * The chain head the engine may read up to (before confirmations). Live: the lower of the heads
 * two independent backend groups report (`Blocks.agreedHead`). Historical: the block in force at
 * the simulated time.
 */
export type HeadFn = (chain: ChainKey, blocks: Blocks, nowSec: number) => Promise<number | null>

export const liveHead: HeadFn = (_chain, blocks) => blocks.agreedHead()

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
  /** Wall-clock budget of one chain's background reconciliation pass (default 120 s). */
  reconcileBudgetSeconds?: number
  /** A pass never reaches back further than this many minutes (default 1440). */
  reconcileMaxCatchupMinutes?: number
  backfillLagSeconds?: number
  pollSeconds?: number
  readConcurrency?: number
  ownClusters?: readonly string[]
  walkOnAfterT0BandSale?: boolean
  /** Kernel grid end (the census's 2,879); default: none. */
  lastMinute?: number
  /** Seconds before a chain that is behind stops holding the others (live 300; historical never). */
  chainStallSeconds?: number
  catchupMinutesPerMinute?: number
  /** Close a position after this many consecutive gap minutes (default 60). */
  maxGapMinutes?: number
  /**
   * Wait for the background reconciliation passes at the start of each minute (historical runs
   * and tests: the stream is then reproducible). Live: false — a pass never holds a minute.
   */
  awaitReconciliation?: boolean
  /**
   * Aave V3 instances outside the registry to bring into scope: labels of KNOWN_NON_REGISTRY_AAVE
   * (`horizon`) or provider addresses. Default none (an owner decision).
   */
  allowAaveProviders?: readonly string[]
  chainConfig?: Partial<Record<ChainKey, ChainConfig>>
}

interface ChainRt {
  cfg: ChainConfig
  blocks: Blocks
  scanner: LogScanner
  /** One reader per Aave pool in scope (the registry's markets + allow-listed ones). */
  aave: Map<string, AaveReader>
  morpho: MorphoReader
  prices: MinutePrices
  /** Allow-listed providers outside the registry (lower case). */
  allowed: string[]
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

/** A background reconciliation pass of one chain. */
interface ReconPass {
  chain: ChainKey
  /** The minute it was started at. */
  minute: number
  /** Events with ts >= this are not late (the chain's processed end when the pass started). */
  endTs: number
  /** A lower bound of the pass's first block's ts (the processed keys it needs are kept). */
  lowTs: number
  ctrl: AbortController
  timer: ReturnType<typeof setTimeout> | undefined
  done: boolean
  result?: {
    events: LiqEvent[]
    calls: number
    from: number
    to: number
    fromTs: number
    toTs: number
    capped: boolean
  }
  error?: Error
}

const emptyGaps = (): TickGaps => ({ positionMinutes: 0, positions: 0, sample: [] })

/** A reducer entry for a closed position that gets another record (its open is in the stream). */
function stubPosition(pid: string, walked: boolean): PositionState {
  return {
    open: { kind: 'open', pid, walked } as OpenRecord,
    // Every open is emitted with its first real, so events >= 1 (the totals count positions once).
    real: { events: 1, repaidUsd: 0, seizedUsd: 0, badDebtUsd: 0, unpricedEvents: 0 },
    mem: {
      sales: 0,
      armedMask: 0,
      arms: 0,
      saves: 0,
      repaidUsd: 0,
      soldUsd: 0,
      unpricedSales: 0,
      ltv: null,
      firstSaleMinute: null,
    },
  }
}

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
  /** pid -> walked of every position opened in the stream and closed since (not in the state). */
  private closedIndex = new Map<string, boolean>()
  private window!: StreamWindow
  private cluster: ReturnType<typeof clusterFn>
  private log: (msg: string) => void
  /** Background reconciliation passes by chain (not persisted: restarted by the schedule). */
  private passes = new Map<ChainKey, ReconPass>()
  /** Passes consumed by the minute being processed (dropped once its commit lands). */
  private consuming: ReconPass[] = []
  /** Poll failures per chain and the wall time of the next try. */
  private pollFail = new Map<ChainKey, { n: number; at: number }>()
  /** What the engine is doing now (status / stall diagnosis). */
  phase = 'idle'
  /** Timing of the last processed minutes, for the smoke report. */
  readonly minuteLog: {
    minute: number
    ms: number
    records: number
    backfilled: boolean
    /** Size of the state committed with the minute (characters). */
    stateBytes: number
    lagging?: ChainKey[]
  }[] = []

  constructor(
    readonly deps: EngineDeps,
    options: EngineOptions,
  ) {
    this.opts = {
      horizonMinutes: DEFAULTS.horizonMinutes,
      reconcileEveryMinutes: DEFAULTS.reconcileEveryMinutes,
      reconcileWindowMinutes: DEFAULTS.reconcileWindowMinutes,
      reconcileBudgetSeconds: DEFAULTS.reconcileBudgetSeconds,
      reconcileMaxCatchupMinutes: DEFAULTS.reconcileMaxCatchupMinutes,
      backfillLagSeconds: DEFAULTS.backfillLagSeconds,
      pollSeconds: DEFAULTS.pollSeconds,
      readConcurrency: DEFAULTS.readConcurrency,
      ownClusters: DEFAULT_OWN_CLUSTERS,
      lastMinute: NO_GRID_END,
      chainStallSeconds: options.mode === 'live' ? DEFAULTS.chainStallSeconds : Infinity,
      catchupMinutesPerMinute: DEFAULTS.catchupMinutesPerMinute,
      maxGapMinutes: DEFAULTS.maxGapMinutes,
      awaitReconciliation: options.mode !== 'live',
      allowAaveProviders: [],
      ...options,
    } as LiveEngine['opts']
    if (options.epochTs % 60 !== 0) throw new Error('epochTs must be a multiple of 60')
    this.cluster = clusterFn(this.opts.ownClusters)
    this.log = deps.log ?? (() => {})
    for (const chain of this.opts.chains) {
      const cfg = { ...CHAIN_CONFIG[chain], ...(options.chainConfig?.[chain] ?? {}) }
      const blocks = new Blocks(deps.rpc, chain, cfg.blockSeconds)
      const scanner = new LogScanner(deps.rpc, cfg, blocks)
      scanner.classify = (emitter, topic0, block) => this.classify(chain, emitter, topic0, block)
      this.rt[chain] = {
        cfg,
        blocks,
        scanner,
        aave: new Map(),
        morpho: new MorphoReader(deps.rpc, cfg),
        prices: new MinutePrices(deps.rpc, chain),
        allowed: allowedAaveProviders(chain, this.opts.allowAaveProviders),
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

  // ---------------------------------------------------------------- markets and scope

  /** The Core market's reader (Morpho loan tokens are priced from its oracle). */
  private core(c: ChainKey): AaveReader {
    const r = this.rt[c].aave.get(this.rt[c].cfg.aavePool)
    if (!r) throw new Error(`${c}: Core Aave market not resolved`)
    return r
  }

  private addReader(c: ChainKey, m: AaveMarket) {
    const rt = this.rt[c]
    if (rt.aave.has(m.pool)) return
    rt.aave.set(m.pool, new AaveReader(this.deps.rpc, rt.cfg, m, async (n) => (await rt.blocks.header(n)).ts))
    rt.scanner.setAavePools([...rt.aave.keys()])
  }

  /**
   * (Re)read the chain's Aave markets from the registry at `block` (+ the allow-listed providers);
   * new pools get readers. Returns the registry's list.
   */
  private async resolveMarkets(c: ChainKey, block: number, minute: number): Promise<AaveMarket[]> {
    const rt = this.rt[c]
    const list = await readAaveMarkets(this.deps.rpc, rt.cfg, block)
    const all = [...list]
    for (const p of rt.allowed) {
      if (all.some((m) => m.provider === p)) continue
      const mk = await readAaveMarketOf(this.deps.rpc, c, p, block)
      if (mk && mk.pool !== '0x0000000000000000000000000000000000000000') all.push(mk)
    }
    const before = new Set(rt.aave.keys())
    for (const m of all) this.addReader(c, m)
    if (all.some((m) => !before.has(m.pool)))
      this.log(
        `${c}: Aave markets ${all
          .map((m) => `${this.marketLabel(c, m)} ${m.pool} (${m.marketId})`)
          .join('; ')}`,
      )
    this.state.markets[c] = { minute, list: all }
    this.state.counters.marketRefreshes++
    return list
  }

  private marketLabel(c: ChainKey, m: AaveMarket) {
    return (
      KNOWN_NON_REGISTRY_AAVE[c]?.find((k) => k.pool === m.pool)?.label ??
      aaveMarketLabel(c, m.pool, m.marketId)
    )
  }

  /**
   * THE SCOPE RULE for a liquidation-topic log's emitter. Morpho `Liquidate`: the singleton only.
   * Aave `LiquidationCall`: a known pool; else (an unknown emitter) the registry is re-read at the
   * log's block — a new registry pool gets a reader — and otherwise the emitter is an Aave V3 pool
   * iff its ADDRESSES_PROVIDER() is a registry provider or an allow-listed one. Anything else
   * (Spark, Seamless and other forks, Aave V2 pools, non-registry instances such as Horizon when
   * not allowed) is excluded: cached in the chain state, its logs counted per emitter.
   */
  private async classify(c: ChainKey, emitter: string, topic0: string, block: number): Promise<EmitterKind> {
    const rt = this.rt[c]
    const cs = this.cs(c)
    if (topic0 === MORPHO_LIQUIDATE_TOPIC) {
      if (emitter === rt.cfg.morpho) return 'morpho'
      if (!cs.excluded[emitter])
        cs.excluded[emitter] = {
          reason: 'Morpho Liquidate signature from a contract that is not the Morpho Blue singleton',
          provider: null,
          block,
        }
      return null
    }
    if (rt.aave.has(emitter)) return 'aave'
    if (cs.excluded[emitter]) return null
    const list = await this.resolveMarkets(c, block, this.state.nextMinute)
    if (rt.aave.has(emitter)) return 'aave'
    const provider = await readAddressesProvider(this.deps.rpc, c, emitter, block)
    const registered = provider ? list.find((m) => m.provider === provider) : undefined
    if (registered) {
      // A registry provider whose getPool() is another address: still an Aave V3 pool of the
      // registry's market (the rule), read at its own address.
      this.addReader(c, { ...registered, pool: emitter })
      this.log(`${c}: ${emitter} is an Aave V3 pool of registry provider ${provider} (its pool is ${registered.pool})`)
      return 'aave'
    }
    if (provider && rt.allowed.includes(provider)) {
      const mk = await readAaveMarketOf(this.deps.rpc, c, provider, block)
      if (mk && mk.pool === emitter) {
        this.addReader(c, mk)
        return 'aave'
      }
    }
    const known = KNOWN_NON_REGISTRY_AAVE[c]?.find((k) => k.provider === provider || k.pool === emitter)
    const reason = !provider
      ? 'no ADDRESSES_PROVIDER() (not an Aave V3 pool: an Aave V2 pool or another contract)'
      : known
        ? `${known.label}: an Aave V3 instance outside the registry (in scope only with --allow-aave-provider ${known.label})`
        : `ADDRESSES_PROVIDER ${provider} is not in the registry (an Aave V3 fork)`
    cs.excluded[emitter] = { reason, provider, block }
    this.log(`${c}: excluded emitter ${emitter}: ${reason}`)
    return null
  }

  // ---------------------------------------------------------------- state

  private serialize(drop: ReadonlySet<string> = new Set()): string {
    const positions: SavedPosition[] = [...this.active.values()].map((p) => ({
      ...p.saved,
      kernels: p.kernels.map((k, i) => ({ spec: p.specs[i], snap: snapshotKernel(k) })),
    }))
    const scanStats: EngineState['scanStats'] = {}
    for (const c of this.opts.chains) scanStats[c] = { ...this.rt[c].scanner.stats }
    return stringifyState({
      ...this.state,
      replay: saveReplay(this.replay, drop),
      positions,
      scanStats,
    } satisfies EngineState)
  }

  private restore(text: string) {
    const s = parseState<EngineState>(text)
    if (s.v !== 2) throw new Error(`engine state v${s.v}: this engine reads v2 (start a new stream)`)
    this.state = s
    this.window = s.header.window
    this.replay = loadReplay(s.replay)
    this.active.clear()
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

  /** The open-once index of closed positions, from the stream (every open minus the open ones). */
  private async loadClosedIndex() {
    this.closedIndex = new Map()
    for (const [pid, walked] of await this.deps.sink.opened())
      if (!this.replay.positions.has(pid)) this.closedIndex.set(pid, walked)
  }

  /** Has this pid been opened in the stream (open now, or closed)? */
  private known(pid: string) {
    return this.replay.positions.has(pid) || this.closedIndex.has(pid)
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
      if (s.v !== 2) throw new Error(`engine state v${s.v}: this engine reads v2 (start a new stream)`)
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
      await this.loadClosedIndex()
      this.log(
        `resumed at minute ${s.nextMinute} (${new Date(this.S(s.nextMinute) * 1000).toISOString()}), seq ${s.seq}, ${this.active.size} open positions, ${this.closedIndex.size} closed`,
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
      v: 2,
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
      pendingGapPids: [],
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
      this.state.chains[c] = {
        scannedTo: at.lo.n,
        scannedToTs: at.lo.ts,
        firstBlock: at.lo.n + 1,
        doneThrough: this.opts.startMinute - 1,
        reconciledTo: at.lo.n,
        reconciledToTs: at.lo.ts,
        excluded: {},
        pending: [],
        seen: [],
        chunks: [],
        minuteBlocks: [],
      }
      await this.resolveMarkets(c, at.lo.n, this.opts.startMinute)
      await this.core(c).ensureSetup(at.lo.n)
      await rt.morpho.checkCode(at.lo.n)
    }
    this.replay = createReplayState()
    this.closedIndex = new Map()
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

  /** The sink is ahead of the engine (a commit with an unknown outcome had landed): reload. */
  private async reload() {
    const text = await this.deps.sink.load()
    if (!text) throw new Error('reload: the sink has no state')
    this.restore(text)
    this.committed = text
    await this.loadClosedIndex()
    // The passes that minute consumed are in the landed state already.
    for (const p of this.consuming) if (this.passes.get(p.chain) === p) this.passes.delete(p.chain)
    this.consuming = []
    this.state.counters.sinkReloads++
    this.log(`reloaded from the sink at minute ${this.state.nextMinute}, seq ${this.state.seq}`)
  }

  // ---------------------------------------------------------------- polling

  private cs(c: ChainKey): ChainState {
    return this.state.chains[c]!
  }

  /**
   * Scan one chain's new confirmed blocks into `pending`. Mutates the chain state only on
   * success. With `needTs`, waits (returns) until the confirmed head reaches it.
   */
  async poll(c: ChainKey, needTs?: number): Promise<void> {
    const rt = this.rt[c]
    const cs = this.cs(c)
    const head = await this.deps.head(c, rt.blocks, this.deps.clock.now() / 1000)
    if (head === null) return
    const target = head - rt.cfg.confirmations
    if (target <= cs.scannedTo) return
    // Not far enough yet for the minute being waited on: wait rather than scan a partial range
    // (a scan costs two logs calls per chunk).
    const h = await rt.blocks.header(target)
    if (needTs !== undefined && h.ts < needTs) return
    const { events, chunks } = await rt.scanner.scan(cs.scannedTo + 1, target)
    const known = new Set([...cs.pending.map(eventKey), ...cs.seen.map(([k]) => k)])
    for (const e of events) if (!known.has(eventKey(e))) cs.pending.push(e)
    // Provenance: adjacent chunks answered by the same groups are one range (keeps it small).
    for (const ch of chunks) {
      const last = cs.chunks[cs.chunks.length - 1]
      if (last && last.group === ch.group && last.to + 1 === ch.from) last.to = ch.to
      else cs.chunks.push({ ...ch })
    }
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

  /** The last minute whose end the chain has been scanned to (a block with ts >= its end). */
  private scannedMinute(c: ChainKey): number {
    return this.minuteOf(this.cs(c).scannedToTs) - 1
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
        const behind = (c: ChainKey) => this.cs(c).doneThrough < m - 1
        for (const c of this.opts.chains) {
          if (this.cs(c).scannedToTs >= E) continue
          const at = (E + confirmSeconds(this.rt[c].cfg) + 1) * 1000
          if (this.deps.clock.now() < at && !behind(c) && !this.pollFail.has(c))
            waitUntil = Math.max(waitUntil, at)
          else due.push(c)
        }
        // Chains are polled in parallel; each mutates only its own state, and only on success.
        // A chain that fails is retried with backoff; the others are not held by it.
        this.phase = `poll ${due.join(',')} for minute ${m}`
        const polled = await Promise.allSettled(due.map((c) => this.poll(c, behind(c) ? undefined : E)))
        this.phase = 'idle'
        let retryIn = 0
        polled.forEach((p, i) => {
          const c = due[i]
          if (p.status === 'fulfilled') {
            this.pollFail.delete(c)
            return
          }
          const n = (this.pollFail.get(c)?.n ?? 0) + 1
          const delay = Math.min(60_000, 2_000 * 2 ** Math.min(5, n - 1))
          this.pollFail.set(c, { n, at: Date.now() + delay })
          retryIn = retryIn ? Math.min(retryIn, delay) : delay
          this.state.counters.pollErrors++
          this.log(`poll ${c} for minute ${m}: ${(p.reason as Error).message} (attempt ${n})`)
        })
        const notReady = this.opts.chains.filter((c) => this.cs(c).scannedToTs < E)
        let lagging = new Set<ChainKey>()
        if (notReady.length) {
          const stallAt = (c: ChainKey) =>
            (E + confirmSeconds(this.rt[c].cfg) + 1 + this.opts.chainStallSeconds) * 1000
          const stalled = notReady.filter((c) => behind(c) || this.deps.clock.now() >= stallAt(c))
          if (stalled.length === notReady.length && stalled.length < this.opts.chains.length) {
            lagging = new Set(stalled)
          } else {
            if (stop()) break
            for (const c of notReady)
              if (due.includes(c) && !this.pollFail.has(c))
                waitUntil = Math.max(waitUntil, this.deps.clock.now() + this.opts.pollSeconds * 1000)
            // A stalled chain's deadline also ends the wait (the others then go on without it).
            for (const c of notReady)
              if (Number.isFinite(this.opts.chainStallSeconds) && !stalled.includes(c) && waitUntil)
                waitUntil = Math.min(waitUntil, Math.max(this.deps.clock.now() + 1000, stallAt(c)))
            const sleepMs = waitUntil ? Math.max(0, waitUntil - this.deps.clock.now()) : 0
            // A failed poll: back off in REAL time (the clock may be simulated), no longer than
            // the wait for the others.
            if (retryIn) await backoff(sleepMs ? Math.min(retryIn, sleepMs) : retryIn)
            else await this.deps.clock.sleep(sleepMs)
            continue
          }
        }
        const recs = await this.processMinute(m, lagging)
        failures = 0
        const last = this.minuteLog[this.minuteLog.length - 1]
        this.log(
          `minute ${m} ${new Date(this.S(m) * 1000).toISOString().slice(11, 16)}: ${recs.length} records (${recs.filter((r) => r.kind === 'open').length} open, ${recs.filter((r) => r.kind === 'real').length} real, ${recs.filter((r) => r.kind === 'mem').length} mem${recs.some((r) => r.late) ? `, ${recs.filter((r) => r.late).length} late` : ''}), ${this.active.size} positions walking, seq ${this.state.seq}, ${last?.ms ?? 0} ms${last?.backfilled ? ', backfilled' : ''}${last?.lagging?.length ? `, LAGGING ${last.lagging.join(',')}` : ''}`,
        )
      } catch (e) {
        if (e instanceof SinkAheadError) {
          this.log(`minute ${m}: ${e.message}`)
          try {
            await this.reload()
          } catch (r) {
            this.log(`reload failed: ${(r as Error).message}`)
            await backoff(5_000)
          }
          continue
        }
        failures++
        this.log(`minute ${m}: ${(e as Error).message} (attempt ${failures}; rolled back)`)
        this.rollback()
        this.consuming = []
        this.state.counters.errors++
        await backoff(Math.min(120_000, 2_000 * 2 ** Math.min(6, failures - 1)))
      }
    }
  }

  /**
   * Step chain `chains`' open positions at minute k and process their liquidations of minute k.
   * Returns the records in stream order (ts, kind, emission) — not yet rounded or appended.
   */
  private async advance(chains: ChainKey[], k: number): Promise<StreamRecord[]> {
    const S = this.S(k)
    const E = S + 60
    const out: { rec: StreamRecord; i: number }[] = []
    const push = (rec: StreamRecord) => out.push({ rec, i: out.length })

    // ---- 1. step
    const on = new Set(chains)
    const stepping = [...this.active.values()].filter((p) => on.has(p.saved.chain) && p.saved.t0Minute < k)
    const chainsStepping = [...new Set(stepping.map((p) => p.saved.chain))]
    const missing = new Map<ChainKey, Set<string>>()
    await Promise.all(
      chainsStepping.map(async (c) => {
        const ps = stepping.filter((p) => p.saved.chain === c)
        const prices = this.rt[c].prices
        const block = await this.minuteBlock(c, k)
        const usdKeys = ps.flatMap((p) => (p.saved.usd.kind === 'aave' ? [p.saved.usd.key] : []))
        const legKeys = ps.flatMap((p) => Object.values(p.saved.legKeys))
        await prices.ensure(k, block, [...legKeys, ...usdKeys])
        // No silent carry-forward: a held leg's missing value is re-read on another backend.
        const nulls = legKeys.filter((x) => prices.get(k, x) == null)
        if (nulls.length) {
          this.state.counters.priceRetries++
          missing.set(c, new Set(await prices.retryMissing(k, nulls)))
        }
      }),
    )
    for (const p of stepping) {
      const gone = missing.get(p.saved.chain)
      const lacking = gone ? Object.values(p.saved.legKeys).filter((x) => gone.has(x)) : []
      if (lacking.length) {
        this.recordGap(p, k, lacking)
        continue
      }
      p.saved.gapStreak = 0
      for (const r of this.stepPosition(p, k)) push(r)
    }

    // ---- 2. events of the minute
    const evs: LiqEvent[] = []
    for (const c of chains) {
      const cs = this.cs(c)
      const keep: LiqEvent[] = []
      for (const e of cs.pending) {
        if (e.ts < S) throw new Error(`${c} event ${eventKey(e)} at ${e.ts} is before minute ${k}`)
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
    for (const r of await this.applyEvents(evs, k)) push(r)
    for (const e of evs) this.cs(e.chain).seen.push([eventKey(e), e.ts])
    for (const c of chains) this.cs(c).doneThrough = k

    out.sort((a, b) => a.rec.ts - b.rec.ts || KIND_RANK[a.rec.kind] - KIND_RANK[b.rec.kind] || a.i - b.i)
    return out.map((x) => x.rec)
  }

  /** Steps 0-7 for minute m (see the header). Throws on any failure; nothing is committed then. */
  async processMinute(m: number, lagging: ReadonlySet<ChainKey> = new Set()): Promise<LiveRecord[]> {
    const t0 = Date.now()
    const S = this.S(m)
    const E = S + 60
    const live = this.opts.mode === 'live'
    const backfilled = live && this.deps.clock.now() / 1000 > E + this.opts.backfillLagSeconds
    const flags = backfilled ? { backfilled: true as const } : {}
    const emitted: LiveRecord[] = []
    const lag = new Set(lagging)
    const ctr = this.state.counters

    // ---- 0a. finished background reconciliation passes: what they found that nobody saw
    if (this.opts.awaitReconciliation) await this.settle()
    this.consuming = [...this.passes.values()].filter((p) => p.done)
    const late = await this.consumePasses(this.consuming, m)

    // ---- 0b. catch-up: a chain behind (it lagged) gets its missed minutes, as late records
    for (const c of this.opts.chains) {
      const cs = this.cs(c)
      if (cs.doneThrough >= m - 1) continue
      const upTo = Math.min(m - 1, this.scannedMinute(c), cs.doneThrough + this.opts.catchupMinutesPerMinute)
      for (let k = cs.doneThrough + 1; k <= upTo; k++) {
        this.phase = `minute ${m}: catch up ${c} minute ${k}`
        for (const r of await this.advance([c], k)) {
          const rounded = roundRecord(r)
          emitted.push(this.append({ ...rounded, ts: Math.max(rounded.ts, S) }, { ...flags, late: true, eventTs: rounded.ts }))
        }
        ctr.catchupMinutes++
      }
      if (upTo >= cs.doneThrough + 1 && cs.doneThrough >= m - 1)
        this.log(`${c}: caught up through minute ${m - 1}`)
      if (cs.doneThrough < m - 1) lag.add(c)
    }
    const ready = this.opts.chains.filter((c) => !lag.has(c))

    // ---- 0c. markets: re-read the registry once a day of stream time
    for (const c of ready) {
      const mk = this.state.markets[c]
      if (!mk || m - mk.minute >= MARKETS_REFRESH_MINUTES) {
        this.phase = `minute ${m}: markets ${c}`
        await this.resolveMarkets(c, await this.minuteBlock(c, m), m)
      }
    }

    // ---- 1-3. step, events, order, round, seq, fold
    this.phase = `minute ${m}: step and events`
    for (const r of ready.length ? await this.advance(ready, m) : []) emitted.push(this.append(roundRecord(r), flags))
    if (lag.size) {
      ctr.laggingChainMinutes += lag.size
      const g = (this.state.pendingGaps.lagging ??= { chains: [], positionMinutes: 0 })
      for (const c of lag) if (!g.chains.includes(c)) g.chains.push(c)
      for (const p of this.active.values())
        if (lag.has(p.saved.chain) && p.saved.t0Minute < m) g.positionMinutes++
    }

    // ---- 4. tick
    if (isTickMinute(m)) {
      const t = tickFromState(this.replay, this.window, m) as LiveRecord
      const g = this.state.pendingGaps
      if (g.positionMinutes || g.lagging || g.closed) {
        t.gaps = { ...g, positions: this.state.pendingGapPids.length }
        this.state.pendingGaps = emptyGaps()
        this.state.pendingGapPids = []
      }
      emitted.push(this.append(t, flags))
      ctr.ticks++
    }

    // ---- 5. close
    for (const [pid, p] of this.active) {
      if (lag.has(p.saved.chain)) continue
      const done = p.kernels.every((k) => k.isDone)
      const idle =
        m - p.saved.lastActivityMinute >= this.opts.horizonMinutes && !p.kernels.some((k) => k.armed)
      const silent = p.saved.gapStreak >= this.opts.maxGapMinutes
      if (done || idle || silent) {
        this.active.delete(pid)
        ctr.closedPositions++
        if (silent && !done) {
          const reason = `oracle silent ${p.saved.gapStreak} minutes in a row${p.kernels.some((k) => k.armed) ? ' (an armed timer abandoned)' : ''}`
          ;(this.state.pendingGaps.closed ??= []).push({ pid, reason })
          ctr.gapClosed++
          this.log(`closed ${pid} at minute ${m}: ${reason}`)
        }
      }
    }

    // ---- 6. late events from the reconciliation; start the passes that are due
    if (late.length) {
      this.phase = `minute ${m}: late events`
      for (const r of await this.processLate(late, m, E)) emitted.push(r)
    }
    const every = this.opts.reconcileEveryMinutes
    if (every > 0 && (m + 1) % every === 0)
      for (const c of ready) if (!this.passes.has(c)) this.startPass(c, m)

    // ---- 7. commit
    this.phase = `minute ${m}: commit`
    for (const c of this.opts.chains) {
      const cs = this.cs(c)
      const keep = this.retainFromTs(c, m)
      cs.seen = cs.seen.filter(([, ts]) => ts >= keep)
      this.rt[c].prices.prune(Math.min(m, cs.doneThrough + 1) - 2)
    }
    this.state.nextMinute = m + 1
    ctr.minutes++
    if (backfilled) ctr.backfilledMinutes++
    // Closed positions leave the state with this commit (the stream is their archive).
    const closing = new Set([...this.replay.positions.keys()].filter((pid) => !this.active.has(pid)))
    const text = this.serialize(closing)
    await this.deps.sink.commit(emitted, text)
    this.committed = text
    for (const pid of closing) {
      this.closedIndex.set(pid, this.replay.positions.get(pid)!.open.walked)
      this.replay.positions.delete(pid)
    }
    this.replay.order.length = 0
    for (const p of this.consuming) if (this.passes.get(p.chain) === p) this.passes.delete(p.chain)
    this.consuming = []
    this.phase = 'idle'
    this.minuteLog.push({
      minute: m,
      ms: Date.now() - t0,
      records: emitted.length,
      backfilled,
      stateBytes: text.length,
      ...(lag.size ? { lagging: [...lag] } : {}),
    })
    if (this.minuteLog.length > 10_000) this.minuteLog.shift()
    return emitted
  }

  private recordGap(p: ActivePosition, m: number, keys: string[]) {
    const pid = p.saved.pid
    const g = this.state.pendingGaps
    g.positionMinutes++
    if (!this.state.pendingGapPids.includes(pid)) this.state.pendingGapPids.push(pid)
    if (g.sample.length < 20) g.sample.push(`${pid}@${m}: ${keys.join(', ')}`)
    p.saved.gapStreak = (p.saved.gapStreak ?? 0) + 1
    this.state.counters.gapPositionMinutes++
    this.log(`GAP minute ${m}: ${pid} not stepped, oracle value missing on every backend for ${keys.join(', ')}`)
  }

  /** Fold a record into the reducer and give it its seq (and flags). */
  private append(rec: StreamRecord, flags: { backfilled?: true; late?: true; eventTs?: number }) {
    const r = { ...rec, ...flags, seq: this.state.seq + 1 } as LiveRecord
    // A closed position's state is rebuilt from its index entry when it gets another record.
    if (r.kind !== 'open' && r.kind !== 'tick' && !this.replay.positions.has(r.pid)) {
      const walked = this.closedIndex.get(r.pid)
      if (walked !== undefined) this.replay.positions.set(r.pid, stubPosition(r.pid, walked))
    }
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
      if (!r) throw new Error(`${e.chain}: ${e.pool} emitted LiquidationCall but is not in scope`)
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
      if (!this.known(e.pid) && !seenPid.has(e.pid)) opening.add(eventKey(e))
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
      const known = this.known(e.pid) || out.some((r) => r.kind === 'open' && r.pid === e.pid)
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
        gapStreak: 0,
      },
      specs,
      kernels,
    })
    return out
  }

  // ---------------------------------------------------------------- reconciliation

  /**
   * The oldest processed-event time a future reconciliation pass of chain c could re-find, from
   * minute m on: a pass starts at max(the cap, min(the window start, the last success's end)),
   * and every one of those only moves forward — so a key older than this is never needed again,
   * and a key not older is never dropped (a re-found event is never taken for a missed one).
   */
  private retainFromTs(c: ChainKey, m: number): number {
    const cs = this.cs(c)
    const end = this.S(m + 1)
    const capTs = end - 60 * this.opts.reconcileMaxCatchupMinutes
    let keep = Math.max(capTs, Math.min(this.S(m + 1 - this.opts.reconcileWindowMinutes), cs.reconciledToTs))
    const p = this.passes.get(c)
    if (p) keep = Math.min(keep, p.lowTs)
    return keep - 120
  }

  /** Start a background reconciliation pass of chain c at minute m (it never blocks a minute). */
  private startPass(c: ChainKey, m: number) {
    const rt = this.rt[c]
    const cs = this.cs(c)
    const endMinute = cs.doneThrough
    const endTs = this.S(endMinute + 1)
    const windowFromTs = this.S(endMinute + 1 - this.opts.reconcileWindowMinutes)
    const capTs = this.S(m + 1) - 60 * this.opts.reconcileMaxCatchupMinutes
    // A snapshot of what the pass needs: it runs while minutes go on.
    const snap = {
      firstBlock: cs.firstBlock,
      scannedTo: cs.scannedTo,
      reconciledTo: cs.reconciledTo,
      chunks: [...cs.chunks],
    }
    const pass: ReconPass = {
      chain: c,
      minute: m,
      endTs,
      lowTs: Math.max(capTs, Math.min(windowFromTs, cs.reconciledToTs)),
      ctrl: new AbortController(),
      timer: undefined,
      done: false,
    }
    pass.timer = setTimeout(() => pass.ctrl.abort(), this.opts.reconcileBudgetSeconds * 1000)
    pass.timer.unref?.()
    this.passes.set(c, pass)
    const run = async () => {
      const toAt = await rt.blocks.atOrBefore(endTs - 1, snap.scannedTo)
      if (!toAt) throw new Error(`minute ${endMinute} end not settled`)
      const firstTs = (await rt.blocks.header(snap.firstBlock)).ts
      const fromAt =
        windowFromTs - 1 >= firstTs ? await rt.blocks.atOrBefore(windowFromTs - 1, snap.scannedTo) : null
      // Never leave a hole: start no later than where the last successful pass ended …
      let from = Math.max(
        snap.firstBlock,
        Math.min(fromAt ? fromAt.lo.n + 1 : snap.firstBlock, snap.reconciledTo + 1),
      )
      const to = toAt.lo.n
      if (to < from) return { events: [], calls: 0, from, to, fromTs: endTs, toTs: toAt.lo.ts, capped: false }
      let fromTs = (await rt.blocks.header(from)).ts
      // … but never further back than the cap (an unchecked stretch, counted and logged).
      let capped = false
      if (fromTs < capTs) {
        const capAt = (await rt.blocks.atOrBefore(capTs - 1, snap.scannedTo))!
        from = capAt.lo.n + 1
        fromTs = capAt.hi.ts
        capped = true
      }
      const chunks: ChunkProvenance[] = snap.chunks.filter((x) => x.to >= from && x.from <= to)
      const got = await rt.scanner.reconcile(from, to, chunks, pass.ctrl.signal)
      return { events: got.events, calls: got.calls, from, to, fromTs, toTs: toAt.lo.ts, capped }
    }
    run().then(
      (r) => {
        pass.result = r
      },
      (e) => {
        pass.error = pass.ctrl.signal.aborted
          ? new AbortedError(`cancelled at its ${this.opts.reconcileBudgetSeconds} s budget`)
          : (e as Error)
      },
    ).finally(() => {
      clearTimeout(pass.timer)
      pass.done = true
    })
  }

  /**
   * Finished passes: what they found that was neither processed (`seen`) nor scanned for a later
   * minute (`pending`) is LATE. Updates each chain's reconciled-through point on success.
   */
  private async consumePasses(passes: ReconPass[], m: number): Promise<LiqEvent[]> {
    const late: LiqEvent[] = []
    const ctr = this.state.counters
    for (const p of passes) {
      const cs = this.cs(p.chain)
      if (p.error || !p.result) {
        ctr.reconcileFailures++
        this.log(
          `reconciliation of ${p.chain} started at minute ${p.minute} failed (${p.error?.message ?? 'no result'}); retried next time from block ${cs.reconciledTo + 1}`,
        )
        continue
      }
      const r = p.result
      ctr.reconcileRuns++
      ctr.reconcileCalls += r.calls
      if (r.capped) {
        ctr.reconcileCapped++
        this.log(
          `reconciliation of ${p.chain}: range capped at ${this.opts.reconcileMaxCatchupMinutes} minutes (blocks ${cs.reconciledTo + 1}-${r.from - 1} not re-checked)`,
        )
      }
      const seen = new Set(cs.seen.map(([k]) => k))
      const later = new Set(cs.pending.map(eventKey))
      const found = new Set<string>()
      for (const e of r.events) {
        const k = eventKey(e)
        found.add(k)
        if (e.ts >= p.endTs || seen.has(k) || later.has(k) || late.some((x) => eventKey(x) === k)) continue
        late.push(e)
      }
      // Processed events in the range the pass did not return (a short answer, or a reorg).
      for (const [k, ts] of cs.seen) if (ts >= r.fromTs && ts < p.endTs && !found.has(k)) ctr.reconcileShort++
      if (r.to > cs.reconciledTo) {
        cs.reconciledTo = r.to
        cs.reconciledToTs = r.toTs
      }
      cs.chunks = cs.chunks.filter((x) => x.to >= r.from)
    }
    if (late.length) {
      ctr.lateEvents += late.length
      this.log(`reconciliation at minute ${m}: ${late.length} late event(s)`)
    }
    return late
  }

  /** Process late events at the end of minute m: records flagged late, ts the append time E. */
  private async processLate(late: LiqEvent[], m: number, E: number): Promise<LiveRecord[]> {
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
      // A late position walks from its own t0 to its chain's processed end on archive prices.
      const p = this.active.get(e.pid)
      const through = this.cs(e.chain).doneThrough
      if (p && recs.some((r) => r.kind === 'open')) {
        for (let k = p.saved.t0Minute + 1; k <= through && this.active.has(e.pid); k++) {
          const block = await this.minuteBlock(e.chain, k)
          const prices = this.rt[e.chain].prices
          const keys = Object.values(p.saved.legKeys)
          await prices.ensure(k, block, [...keys, ...(p.saved.usd.kind === 'aave' ? [p.saved.usd.key] : [])])
          const lacking = await prices.retryMissing(k, keys)
          if (lacking.length) {
            this.recordGap(p, k, lacking)
            continue
          }
          p.saved.gapStreak = 0
          recs.push(...this.stepPosition(p, k))
        }
      }
      for (const r of recs) {
        const rounded = roundRecord(r)
        out.push(this.append({ ...rounded, ts: Math.max(rounded.ts, E) }, { late: true, eventTs: rounded.ts }))
      }
      this.cs(e.chain).seen.push([eventKey(e), e.ts])
    }
    void m
    return out
  }

  /** Wait for the background passes (tests, a clean stop). */
  async settle(): Promise<void> {
    while ([...this.passes.values()].some((p) => !p.done)) await new Promise((r) => setTimeout(r, 5))
  }

  /** Cancel the background passes (a stop). */
  cancelPasses() {
    for (const p of this.passes.values()) {
      clearTimeout(p.timer)
      p.ctrl.abort()
    }
  }

  // ---------------------------------------------------------------- reporting

  status() {
    return {
      phase: this.phase,
      nextMinute: this.state.nextMinute,
      nextMinuteIso: new Date(this.S(this.state.nextMinute) * 1000).toISOString(),
      seq: this.state.seq,
      openPositions: this.active.size,
      closedPositions: this.closedIndex.size,
      stateBytes: this.committed.length,
      coverage: { ...this.replay.coverage },
      totals: this.replay.totals,
      counters: this.state.counters,
      reconciliation: Object.fromEntries(
        [...this.passes].map(([c, p]) => [c, { startedAtMinute: p.minute, done: p.done, error: p.error?.message }]),
      ),
      chains: Object.fromEntries(
        this.opts.chains.map((c) => [
          c,
          {
            scannedTo: this.cs(c).scannedTo,
            firstBlock: this.cs(c).firstBlock,
            doneThrough: this.cs(c).doneThrough,
            blocksScanned: this.cs(c).scannedTo - this.cs(c).firstBlock + 1,
            pending: this.cs(c).pending.length,
            seenKeys: this.cs(c).seen.length,
            reconciledTo: this.cs(c).reconciledTo,
            pollFailures: this.pollFail.get(c)?.n ?? 0,
            markets: this.state.markets[c]?.list.map((x) => `${this.marketLabel(c, x)} ${x.pool}`),
            excludedEmitters: this.cs(c).excluded,
            scan: this.rt[c].scanner.stats,
            quarantine: this.rt[c].scanner.quarantineLog,
            headerReads: this.rt[c].blocks.headerReads,
            headUnverified: this.rt[c].blocks.headUnverified,
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
