/**
 * The live engine's durable state — everything needed to resume exactly where it stopped:
 * the stream position (seq, last ts, next minute), per chain the last scanned block and the last
 * minute processed, the events scanned but not yet processed, the processed event keys a future
 * reconciliation pass could re-find and the answering backends of those logs chunks, the
 * reducer's fold (coverage and totals) and every OPEN position's kernels as field snapshots.
 *
 * It holds open positions only. A closed position (kernels done, idle past the horizon, or its
 * oracle silent) is dropped from the state at the commit that closes it: the stream itself is
 * its archive, and the engine rebuilds its open-once index (pid -> walked) from the sink at
 * start-up (`StreamSink.opened`). So the state's size follows the positions walking, not the age
 * of the stream.
 *
 * The state is committed TOGETHER with the records of each minute (sinks.ts), so after a crash
 * the stream and the state always agree.
 */
import type { KernelSpec } from '../kernel'
import type {
  PositionState,
  ReplayState,
  STREAM_SCHEMA,
  StreamRecord,
  StreamWindow,
  TickRecord,
} from '../stream'
import type { LiqEvent } from './codec'
import type { ChainKey } from './config'
import type { ChunkProvenance, ScanStats } from './logs'
import type { AaveMarket } from './aaveRead'
import type { KernelSnapshot, UsdMode } from './positions'

/** Minutes a position was NOT stepped because a held leg's oracle value was missing. */
export interface TickGaps {
  /** Position-minutes skipped since the previous tick. */
  positionMinutes: number
  /** Distinct positions among them. */
  positions: number
  /** Up to 20 of them, `pid@minute: key, …`. */
  sample: string[]
  /**
   * Chains that were LAGGING (not answering) in minutes since the previous tick: their positions
   * were not stepped and their liquidations not read in those minutes — this tick's totals do not
   * include them. They are caught up as `late` records when the chain answers again.
   */
  lagging?: { chains: ChainKey[]; positionMinutes: number }
  /** Positions closed since the previous tick because their oracle stayed silent. */
  closed?: { pid: string; reason: string }[]
}

/**
 * A stream record as the live engine writes it: schema v2 (lib/wavefront/stream.ts — pool-
 * qualified Aave pids, `priceBasis` on a walked open, real seized including the Aave protocol
 * fee) plus optional live-only fields that every v2 reader ignores —
 *   backfilled  processed after its minute had ended by more than backfillLagSeconds
 *   late        found by the reconciliation pass (or a lagging chain's catch-up) after the
 *               primary minute had passed
 *   eventTs     a late record's own event time (its `ts` is the append time)
 *   protocolFeeUsd (real, Aave) the liquidation protocol fee inside seizedUsd
 *   gaps        (tick) minutes positions were not stepped for a missing oracle value, lagging
 *               chains, positions closed for a silent oracle
 */
export type LiveRecord = StreamRecord & {
  backfilled?: true
  late?: true
  eventTs?: number
  protocolFeeUsd?: number | null
  gaps?: TickGaps
}

export interface LiveHeader {
  kind: 'header'
  format: 'wavefront-stream'
  schema: typeof STREAM_SCHEMA
  window: StreamWindow
  engine: 'wavefront-live'
  mode: 'live' | 'historical'
  chains: ChainKey[]
  createdAt: string
}

/** An emitter of a liquidation topic that is not in scope (cached classification). */
export interface ExcludedEmitter {
  reason: string
  /** Its ADDRESSES_PROVIDER(), when it has one. */
  provider: string | null
  /** The block it was classified at. */
  block: number
}

export interface ChainState {
  /** Every log up to this block has been scanned (and confirmed, see logs.ts). */
  scannedTo: number
  scannedToTs: number
  /** The block the stream started after (reconciliation never looks before it). */
  firstBlock: number
  /** The last minute processed for this chain (behind nextMinute - 1 while it lags). */
  doneThrough: number
  /** Last block a reconciliation pass covered (the next one starts no later than after it). */
  reconciledTo: number
  reconciledToTs: number
  /** Out-of-scope emitters seen (forks, non-registry instances), by address. */
  excluded: Record<string, ExcludedEmitter>
  /** Scanned, not yet processed (their minute has not been processed). */
  pending: LiqEvent[]
  /**
   * Processed event keys with their ts. A key is dropped only once no future reconciliation pass
   * can start at or before its time (engine.ts `retainFromTs`), so a re-found event is never
   * mistaken for a missed one.
   */
  seen: [string, number][]
  /** Who answered each primary logs chunk, kept as long as a pass could re-check it. */
  chunks: ChunkProvenance[]
  /** Recent minute -> block in force at the minute start. */
  minuteBlocks: [number, number][]
}

export interface SavedKernel {
  spec: Omit<KernelSpec, 'usdPerUnit'>
  snap: KernelSnapshot
}

export interface SavedPosition {
  pid: string
  chain: ChainKey
  protocol: 'aave-v3' | 'morpho-blue'
  usd: UsdMode
  /** Kernel leg key -> MinutePrices key (aave:<oracle>:<asset> / morpho:<oracle>). */
  legKeys: Record<string, string>
  anchors: Record<string, number>
  t0Minute: number
  lastActivityMinute: number
  /** Consecutive minutes not stepped for a missing oracle value (closed at maxGapMinutes). */
  gapStreak: number
  kernels: SavedKernel[]
}

export interface Counters {
  minutes: number
  backfilledMinutes: number
  ticks: number
  records: number
  opens: number
  reals: number
  mems: number
  lateEvents: number
  reconcileRuns: number
  reconcileCalls: number
  /** Seen events a reconciliation answer did not contain (short answer or reorg). */
  reconcileShort: number
  /** Reconciliation passes of a chain that could not run or were cancelled (retried next time). */
  reconcileFailures: number
  /** Passes whose range was cut to reconcileMaxCatchupMinutes (an unchecked stretch, logged). */
  reconcileCapped: number
  /** Positions closed because their oracle stayed silent for maxGapMinutes. */
  gapClosed: number
  /** Chain-minutes a chain was lagging (its minute not processed with the others). */
  laggingChainMinutes: number
  /** Minutes of a lagging chain processed later (catch-up, `late` records). */
  catchupMinutes: number
  /** Head polls that failed (the chain is retried; the others carry on). */
  pollErrors: number
  /** Reloads from the sink after a commit whose outcome was unknown had landed. */
  sinkReloads: number
  /**
   * Aave protocol fees taken from the receipt's treasury Transfer (the census's source), from
   * the LiquidationLogic arithmetic (no transfer in the receipt), and receipt fees one or more
   * units off the arithmetic (the aToken's scaled-balance rounding).
   */
  feeFromReceipt: number
  feeFromArithmetic: number
  feeScaledRounding: number
  closedPositions: number
  errors: number
  hfMismatch: number
  /** Positions located at the N-1 prices (not at N). */
  locatedAtNm1: number
  /** Position-minutes not stepped for a missing oracle value, and price re-reads. */
  gapPositionMinutes: number
  priceRetries: number
  eventsByChain: Record<string, number>
  /** Aave markets resolved from the registry, by chain. */
  marketRefreshes: number
}

export const emptyCounters = (): Counters => ({
  minutes: 0,
  backfilledMinutes: 0,
  ticks: 0,
  records: 0,
  opens: 0,
  reals: 0,
  mems: 0,
  lateEvents: 0,
  reconcileRuns: 0,
  reconcileCalls: 0,
  reconcileShort: 0,
  reconcileFailures: 0,
  reconcileCapped: 0,
  gapClosed: 0,
  laggingChainMinutes: 0,
  catchupMinutes: 0,
  pollErrors: 0,
  sinkReloads: 0,
  feeFromReceipt: 0,
  feeFromArithmetic: 0,
  feeScaledRounding: 0,
  closedPositions: 0,
  errors: 0,
  hfMismatch: 0,
  locatedAtNm1: 0,
  gapPositionMinutes: 0,
  priceRetries: 0,
  eventsByChain: {},
  marketRefreshes: 0,
})

export interface SavedReplay {
  seq: number
  ts: number
  positions: [string, PositionState][]
  order: string[]
  coverage: { walked: number; total: number }
  totals: ReplayState['totals']
  lastTick: TickRecord | null
  ticks: number
}

export interface EngineState {
  v: 2
  header: LiveHeader
  seq: number
  lastTs: number
  nextMinute: number
  chains: Partial<Record<ChainKey, ChainState>>
  replay: SavedReplay
  positions: SavedPosition[]
  counters: Counters
  scanStats: Partial<Record<ChainKey, ScanStats>>
  /** Gaps since the last tick (flushed into it), and the distinct positions among them. */
  pendingGaps: TickGaps
  pendingGapPids: string[]
  /** Aave markets per chain at the last registry read, and the minute it was read. */
  markets: Partial<Record<ChainKey, { minute: number; list: AaveMarket[] }>>
}

/** The reducer's fold without the positions in `drop` (closed: not kept in the state). */
export function saveReplay(r: ReplayState, drop: ReadonlySet<string> = new Set()): SavedReplay {
  return {
    seq: r.seq,
    ts: r.ts,
    positions: [...r.positions].filter(([pid]) => !drop.has(pid)),
    // The open order is not needed by the engine (and grows with every position): not kept.
    order: [],
    coverage: { ...r.coverage },
    totals: JSON.parse(JSON.stringify(r.totals)),
    lastTick: r.lastTick,
    ticks: r.ticks,
  }
}

export function loadReplay(s: SavedReplay): ReplayState {
  return {
    seq: s.seq,
    ts: s.ts,
    positions: new Map(s.positions),
    order: [...s.order],
    coverage: { ...s.coverage },
    totals: JSON.parse(JSON.stringify(s.totals)),
    lastTick: s.lastTick,
    ticks: s.ticks,
  }
}
