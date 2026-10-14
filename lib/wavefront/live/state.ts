/**
 * The live engine's durable state — everything needed to resume exactly where it stopped:
 * the stream position (seq, last ts, next minute), per chain the last scanned block, the events
 * scanned but not yet processed, the recently processed event keys and the answering backend of
 * every recent logs chunk (for the reconciliation), the reducer's fold (for ticks and the
 * open-once rule), and every open position's kernels as field snapshots.
 *
 * The state is committed TOGETHER with the records of each minute (sinks.ts), so after a crash
 * the stream and the state always agree.
 */
import type { KernelSpec } from '../kernel'
import type { PositionState, ReplayState, StreamRecord, StreamWindow, TickRecord } from '../stream'
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
}

/**
 * A stream record as the live engine writes it: schema v1 plus optional fields —
 *   backfilled  processed after its minute had ended by more than backfillLagSeconds
 *   late        found by the reconciliation pass after the primary scan had missed it
 *   eventTs     a late record's own event time (its `ts` is the append time)
 *   priceBasis  (open) 'N-1' when the position was located at the N-1 prices (see aaveRead.ts)
 *   protocolFeeUsd (real, Aave) the liquidation protocol fee inside seizedUsd
 *   gaps        (tick) minutes positions were not stepped for a missing oracle value
 */
export type LiveRecord = StreamRecord & {
  backfilled?: true
  late?: true
  eventTs?: number
  priceBasis?: 'N-1'
  protocolFeeUsd?: number | null
  gaps?: TickGaps
}

export interface LiveHeader {
  kind: 'header'
  format: 'wavefront-stream'
  schema: 1
  window: StreamWindow
  engine: 'wavefront-live'
  mode: 'live' | 'historical'
  chains: ChainKey[]
  createdAt: string
}

export interface ChainState {
  /** Every log up to this block has been scanned (and confirmed, see logs.ts). */
  scannedTo: number
  scannedToTs: number
  /** The block the stream started after (reconciliation never looks before it). */
  firstBlock: number
  /** Last block a reconciliation pass covered (the next one starts no later than after it). */
  reconciledTo: number
  /** Scanned, not yet processed (their minute has not been processed). */
  pending: LiqEvent[]
  /** Processed event keys with their ts, kept for the reconciliation window. */
  seen: [string, number][]
  /** Who answered each primary logs chunk, kept for the reconciliation window. */
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
  /** Reconciliation passes of a chain that could not run (retried next time). */
  reconcileFailures: number
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
  v: 1
  header: LiveHeader
  seq: number
  lastTs: number
  nextMinute: number
  chains: Partial<Record<ChainKey, ChainState>>
  replay: SavedReplay
  positions: SavedPosition[]
  counters: Counters
  scanStats: Partial<Record<ChainKey, ScanStats>>
  /** Gaps since the last tick (flushed into it). */
  pendingGaps: TickGaps
  /** Aave markets per chain at the last registry read, and the minute it was read. */
  markets: Partial<Record<ChainKey, { minute: number; list: AaveMarket[] }>>
}

export function saveReplay(r: ReplayState): SavedReplay {
  return {
    seq: r.seq,
    ts: r.ts,
    positions: [...r.positions],
    order: [...r.order],
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
