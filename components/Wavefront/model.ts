/**
 * The wavefront timeline: schema-v2 stream records (lib/wavefront/stream.ts) folded with THE
 * reducer, `applyRecord`, up to a playhead time.
 *
 * Every count and $ total on the page is the reducer's own (`ReplayState.totals`,
 * `.coverage`, `.pending`); nothing here adds up records. What this file adds is an INDEX of
 * the open records (cluster, spiral slot, walked or not, reason) and of each position's first
 * Membrane sale (when, and why), built as records arrive, so the panels can draw one mark per
 * position from the reducer's per-position state.
 *
 * Only WALKED positions are drawn, on both sides: the same positions. A position the
 * simulator does not walk is counted in coverage (n of N) with a short reason, never drawn.
 *
 * Two modes:
 *   retain (replay)   every record is kept; the playhead can move anywhere. Forward folds only
 *                     the new records; back refolds from the start (the whole Oct 10-11
 *                     stream folds in a few ms).
 *   stream (live)     records are folded as they arrive and dropped: memory is the reducer's
 *                     state plus this per-position index, never the record history. The
 *                     playhead is always "now".
 *
 * Playhead semantics (retain): "at time T" is every record with ts < T, plus the tick stamped
 * T (a tick at T summarises exactly the records before it, and sorts first among records at
 * T). So at every 10-minute boundary the fold equals that tick's totals — the reducer
 * verifies it.
 */

import {
  applyRecord,
  createReplayState,
  type ReplayState,
  type SaleWhy,
  type StreamRecord,
  type Totals,
} from '@/lib/wavefront/stream'

/** Bars and ages are counted in 10-minute bins, the stream's tick interval. */
export const BIN_SECONDS = 600
/** Bars cover the last 12 hours. */
export const BAR_BINS = 72

/** Mark codes, per drawn position, per side. */
export const MARK = {
  /** Membrane only: walked, no Membrane decision yet (live). Drawn neutral. */
  pending: 0,
  /** Membrane only: decided, never sold, no 8h window running. */
  kept: 1,
  /** Membrane only: never sold, an 8h window running now. */
  armed: 2,
  /**
   * Membrane only: first "sale" is the census's conservative grid-end sale — an 8h window
   * still running when the data ends, counted as sold by assumption. Drawn hatched.
   */
  gridEnd: 3,
  /** Sold; + age bucket 0..4 (newest .. oldest). */
  sold: 4,
} as const
export const AGE_BUCKETS = 5
export const CODE_COUNT = MARK.sold + AGE_BUCKETS

/**
 * Age bucket of an event `ageBins` 10-minute bins old (the canvas `redAge`):
 * same bin, < 30 min, < ~2 h, < ~12 h, older.
 */
export function ageBucket(ageBins: number): number {
  return ageBins < 1 ? 0 : ageBins < 3 ? 1 : ageBins < 13 ? 2 : ageBins < 73 ? 3 : 4
}

const binOf = (ts: number) => Math.floor(ts / BIN_SECONDS)

export interface WavefrontFrame {
  /** Playhead, unix seconds. */
  t: number
  /** seq of the last record folded. */
  seq: number
  /** The reducer's coverage and totals, as they stand at t. */
  coverage: { walked: number; total: number }
  totals: Totals
  /** The reducer's walked positions with no Membrane decision yet. */
  pending: number
  /**
   * Positions whose first Membrane "sale" is the grid-end sale (a window still running when
   * the data ends). The reducer counts them in positionsSold; the page draws them apart.
   */
  gridEnd: number
  /**
   * Opened positions not walked (coverage.total − coverage.walked), with the short
   * reader-facing reasons (from the open records), largest first.
   */
  notCompared: {
    count: number
    reasons: { reason: string; count: number }[]
    /** Positions not walked anywhere in the stream held (0: the line need not be reserved). */
    inStream: number
  }
  /** Walked positions first liquidated in the hour before t (t − 3600 < open ts). */
  lastHour: number
  /** Clusters hit so far (walked positions), in first-hit order; `index` is the timeline's. */
  clusters: { index: number; name: string; count: number }[]
  /** Drawn (walked) positions, in open order. */
  n: number
  cluster: Uint16Array
  slot: Uint32Array
  real: Uint8Array
  mem: Uint8Array
  /**
   * Positions first sold per 10-minute bin over the last 12 h (drawn positions). Grid-end
   * "sales" are left out: they are an assumption at the data's end, not a decision.
   */
  bars: { real: number[]; mem: number[]; max: number; fromTs: number; toTs: number }
}

/** The reader-facing line for why a position is not compared. Census reasons are technical. */
export function reasonPhrase(reason: string | undefined): string {
  const r = (reason ?? '').toLowerCase()
  if (r.startsWith('not located') || r.startsWith('not liquidatable')) {
    return 'not liquidatable when rechecked'
  }
  if (r.includes('series') || r.includes('price')) return 'no price path yet'
  return 'not simulated yet'
}

export interface TimelineOptions {
  /** Keep every record so the playhead can move anywhere (replay). Default true. */
  retain?: boolean
}

export class WavefrontTimeline {
  readonly retain: boolean
  private recs: StreamRecord[] = []
  private state: ReplayState = createReplayState()
  private cursor = 0
  private held = 0
  private seqHeld = 0
  private firstTsHeld: number | null = null
  private lastTsHeld: number | null = null
  private lastTickTsHeld: number | null = null
  /** First Membrane sale per position (an index the fold fills, not a total). */
  private firstSale = new Map<string, { ts: number; why: SaleWhy | undefined }>()
  /** One entry per open record, in seq order. */
  private openSeq: number[] = []
  private openPid: string[] = []
  private openTs: number[] = []
  private openReason: (string | undefined)[] = []
  /** Walked opens: cluster index and spiral slot; -1 / -1 for a position not walked. */
  private openCluster: number[] = []
  private openSlot: number[] = []
  private unwalkedOpens = 0
  private clusterIdx = new Map<string, number>()
  private clusterSize: number[] = []
  /** Cluster names in first-hit order (walked positions only). */
  readonly clusterNames: string[] = []
  readonly protocols = new Set<string>()
  readonly chains = new Set<string>()

  constructor(opts: TimelineOptions = {}) {
    this.retain = opts.retain ?? true
  }

  /** Records appended so far (held or, in stream mode, folded and dropped). */
  get length(): number {
    return this.held
  }
  get lastSeq(): number {
    return this.seqHeld
  }
  get firstTs(): number | null {
    return this.firstTsHeld
  }
  get lastTs(): number | null {
    return this.lastTsHeld
  }
  /** ts of the newest tick appended (live freshness). */
  get lastTickTs(): number | null {
    return this.lastTickTsHeld
  }
  /** Walked positions per cluster over everything appended, in first-hit order. */
  clusterTotals(): number[] {
    return this.clusterSize.slice()
  }

  /**
   * Append records. Idempotent by seq: anything at or below the last seq already held (or
   * repeated within `incoming`) is ignored, so overlapping or repeated pages merge safely.
   * Returns how many records were added. Throws if time would go backwards, or (stream mode)
   * on any record the reducer refuses.
   */
  append(incoming: readonly StreamRecord[]): number {
    const fresh = incoming.filter((r) => r.seq > this.seqHeld).sort((a, b) => a.seq - b.seq)
    let added = 0
    for (const r of fresh) {
      if (r.seq <= this.seqHeld) continue // duplicate seq inside this batch
      if (this.lastTsHeld !== null && r.ts < this.lastTsHeld) {
        throw new Error(`wavefront: seq ${r.seq} at ts ${r.ts} goes back from ${this.lastTsHeld}`)
      }
      // stream mode folds first, so a record the reducer refuses leaves no trace in the index
      if (!this.retain) this.fold(r)
      else this.recs.push(r)
      if (r.kind === 'open') this.indexOpen(r)
      if (r.kind === 'tick') this.lastTickTsHeld = r.ts
      this.seqHeld = r.seq
      this.lastTsHeld = r.ts
      if (this.firstTsHeld === null) this.firstTsHeld = r.ts
      this.held++
      added++
    }
    return added
  }

  private indexOpen(r: Extract<StreamRecord, { kind: 'open' }>) {
    this.openSeq.push(r.seq)
    this.openPid.push(r.pid)
    this.openTs.push(r.ts)
    this.openReason.push(r.reason)
    this.protocols.add(r.protocol)
    this.chains.add(r.chain)
    if (!r.walked) {
      this.unwalkedOpens++
      this.openCluster.push(-1)
      this.openSlot.push(-1)
      return
    }
    let c = this.clusterIdx.get(r.cluster)
    if (c === undefined) {
      c = this.clusterNames.length
      this.clusterIdx.set(r.cluster, c)
      this.clusterNames.push(r.cluster)
      this.clusterSize.push(0)
    }
    this.openCluster.push(c)
    this.openSlot.push(this.clusterSize[c]++)
  }

  private fold(r: StreamRecord) {
    applyRecord(this.state, r)
    if (
      r.kind === 'mem' &&
      (r.event === 'sell' || r.event === 'sell-instant') &&
      !this.firstSale.has(r.pid)
    ) {
      this.firstSale.set(r.pid, { ts: r.ts, why: r.why })
    }
  }

  /** Index of the first record NOT included at playhead t (retain mode). */
  private cutAt(t: number): number {
    let lo = 0
    let hi = this.recs.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (this.recs[mid].ts < t) lo = mid + 1
      else hi = mid
    }
    // The tick stamped exactly t summarises everything before it: include it.
    while (lo < this.recs.length && this.recs[lo].ts === t && this.recs[lo].kind === 'tick') lo++
    return lo
  }

  /**
   * Fold to playhead t with the reducer and return the reducer's state (do not mutate). In
   * stream mode everything appended is already folded; t is ignored.
   */
  foldTo(t: number): ReplayState {
    if (!this.retain) return this.state
    const cut = this.cutAt(t)
    if (cut < this.cursor) {
      this.state = createReplayState()
      this.cursor = 0
      this.firstSale.clear()
    }
    for (; this.cursor < cut; this.cursor++) this.fold(this.recs[this.cursor])
    return this.state
  }

  /** Everything the page draws at playhead t. */
  frameAt(t: number): WavefrontFrame {
    const s = this.foldTo(t)
    // opens folded so far: those with seq <= the reducer's seq
    let lo = 0
    let hi = this.openSeq.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (this.openSeq[mid] <= s.seq) lo = mid + 1
      else hi = mid
    }
    const opened = lo
    const cluster = new Uint16Array(opened)
    const slot = new Uint32Array(opened)
    const real = new Uint8Array(opened)
    const mem = new Uint8Array(opened)
    const counts = new Array<number>(this.clusterNames.length).fill(0)
    const nowBin = binOf(t - 1)
    const fromBin = nowBin - BAR_BINS + 1
    const barsReal = new Array<number>(BAR_BINS).fill(0)
    const barsMem = new Array<number>(BAR_BINS).fill(0)
    const reasons = new Map<string, number>()
    let n = 0
    let lastHour = 0
    let gridEnd = 0
    for (let i = 0; i < opened; i++) {
      const c = this.openCluster[i]
      if (c < 0) {
        const why = reasonPhrase(this.openReason[i])
        reasons.set(why, (reasons.get(why) ?? 0) + 1)
        continue
      }
      const pid = this.openPid[i]
      const p = s.positions.get(pid)
      if (!p) continue
      cluster[n] = c
      slot[n] = this.openSlot[i]
      counts[c]++
      // Real: the open IS the position's first liquidation.
      const openTs = this.openTs[i]
      if (openTs > t - 3600) lastHour++
      const realBin = binOf(openTs)
      real[n] = MARK.sold + ageBucket(nowBin - realBin)
      if (realBin >= fromBin && realBin <= nowBin) barsReal[realBin - fromBin]++
      // Membrane: the reducer's status, with the grid-end assumption drawn apart.
      if (p.mem.sales > 0) {
        const first = this.firstSale.get(pid)
        if (first?.why === 'grid-end') {
          mem[n] = MARK.gridEnd
          gridEnd++
        } else {
          const saleBin = binOf(first?.ts ?? openTs)
          mem[n] = MARK.sold + ageBucket(nowBin - saleBin)
          if (saleBin >= fromBin && saleBin <= nowBin) barsMem[saleBin - fromBin]++
        }
      } else if (p.mem.armedMask !== 0) {
        mem[n] = MARK.armed
      } else if (p.mem.arms + p.mem.saves > 0) {
        mem[n] = MARK.kept
      } else {
        mem[n] = MARK.pending
      }
      n++
    }
    const clusters: WavefrontFrame['clusters'] = []
    counts.forEach((count, index) => {
      if (count > 0) clusters.push({ index, name: this.clusterNames[index], count })
    })
    const T = s.totals
    return {
      t,
      seq: s.seq,
      coverage: { ...s.coverage },
      totals: { real: { ...T.real }, mem: { ...T.mem } },
      pending: s.pending,
      gridEnd,
      notCompared: {
        count: s.coverage.total - s.coverage.walked,
        reasons: [...reasons]
          .map(([reason, count]) => ({ reason, count }))
          .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
        inStream: this.unwalkedOpens,
      },
      lastHour,
      clusters,
      n,
      cluster: cluster.subarray(0, n),
      slot: slot.subarray(0, n),
      real: real.subarray(0, n),
      mem: mem.subarray(0, n),
      bars: {
        real: barsReal,
        mem: barsMem,
        max: Math.max(0, ...barsReal, ...barsMem),
        fromTs: fromBin * BIN_SECONDS,
        toTs: (nowBin + 1) * BIN_SECONDS,
      },
    }
  }
}
