/**
 * The wavefront timeline: an append-only list of schema-v1 stream records (lib/wavefront/stream.ts)
 * folded with THE reducer, `applyRecord`, up to a playhead time.
 *
 * Every count and $ total on the page is the reducer's own (`ReplayState.totals`,
 * `.coverage`); nothing here adds up records. What this file adds is an INDEX of the open
 * records (cluster, spiral slot, walked or not, reason), built as records arrive, so the
 * panels can draw one hex per position, and per-position marks read from the reducer's
 * per-position state.
 *
 * Only WALKED positions are drawn, on both sides: the same positions. A position the
 * simulator does not walk is counted in coverage (n of N) with a short reason, never drawn.
 *
 * Playhead semantics: "at time T" is every record with ts < T, plus the tick stamped T (a tick
 * at T summarises exactly the records before it, and sorts first among records at T). So at
 * every 10-minute boundary the fold equals that tick's totals — the reducer verifies it.
 *
 * Moving forward folds only the new records; moving back refolds from the start (the whole
 * Oct 10-11 stream, 18,484 records, folds in a few ms).
 */

import {
  applyRecord,
  createReplayState,
  type ReplayState,
  type StreamRecord,
  type Totals,
} from '@/lib/wavefront/stream'

/** Bars and ages are counted in 10-minute bins, the stream's tick interval. */
export const BIN_SECONDS = 600
/** Bars cover the last 12 hours. */
export const BAR_BINS = 72

/** Mark codes, per drawn position, per side. */
export const MARK = {
  /** Membrane only: never sold, no 8h window running. */
  kept: 0,
  /** Membrane only: never sold, an 8h window running now. */
  armed: 1,
  /** Sold; + age bucket 0..4 (newest .. oldest). */
  sold: 2,
} as const
export const AGE_BUCKETS = 5

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
  /** Walked positions first liquidated in the hour before t. */
  lastHour: number
  /** Clusters hit so far (walked positions), in first-hit order; `index` is the timeline's. */
  clusters: { index: number; name: string; count: number }[]
  /** Drawn (walked) positions, in open order. */
  n: number
  cluster: Uint16Array
  slot: Uint32Array
  real: Uint8Array
  mem: Uint8Array
  /** Positions sold per 10-minute bin over the last 12 h (drawn positions). */
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

export class WavefrontTimeline {
  private recs: StreamRecord[] = []
  private state: ReplayState = createReplayState()
  private cursor = 0
  /** First Membrane sale per position, unix s — an index the fold fills, not a total. */
  private firstSaleTs = new Map<string, number>()
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

  get length(): number {
    return this.recs.length
  }
  get lastSeq(): number {
    return this.recs.length ? this.recs[this.recs.length - 1].seq : 0
  }
  get firstTs(): number | null {
    return this.recs.length ? this.recs[0].ts : null
  }
  get lastTs(): number | null {
    return this.recs.length ? this.recs[this.recs.length - 1].ts : null
  }

  /**
   * Append records. Idempotent by seq: anything at or below the last seq already held (or
   * repeated within `incoming`) is ignored, so overlapping or repeated pages merge safely.
   * Returns how many records were added. Throws if time would go backwards.
   */
  append(incoming: readonly StreamRecord[]): number {
    const fresh = incoming.filter((r) => r.seq > this.lastSeq).sort((a, b) => a.seq - b.seq)
    let added = 0
    for (const r of fresh) {
      if (r.seq <= this.lastSeq) continue // duplicate seq inside this batch
      const lastTs = this.lastTs
      if (lastTs !== null && r.ts < lastTs) {
        throw new Error(`wavefront: seq ${r.seq} at ts ${r.ts} goes back from ${lastTs}`)
      }
      this.recs.push(r)
      added++
      if (r.kind === 'open') {
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
          continue
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
    }
    return added
  }

  /** Index of the first record NOT included at playhead t. */
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

  /** Fold to playhead t with the reducer and return the reducer's state (do not mutate). */
  foldTo(t: number): ReplayState {
    const cut = this.cutAt(t)
    if (cut < this.cursor) {
      this.state = createReplayState()
      this.cursor = 0
      this.firstSaleTs.clear()
    }
    for (; this.cursor < cut; this.cursor++) {
      const r = this.recs[this.cursor]
      applyRecord(this.state, r)
      if (
        r.kind === 'mem' &&
        (r.event === 'sell' || r.event === 'sell-instant') &&
        !this.firstSaleTs.has(r.pid)
      ) {
        this.firstSaleTs.set(r.pid, r.ts)
      }
    }
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
      if (realBin >= fromBin) barsReal[realBin - fromBin]++
      if (p.mem.sales > 0) {
        const saleBin = binOf(this.firstSaleTs.get(pid) ?? openTs)
        mem[n] = MARK.sold + ageBucket(nowBin - saleBin)
        if (saleBin >= fromBin && saleBin <= nowBin) barsMem[saleBin - fromBin]++
      } else {
        mem[n] = p.mem.armedMask !== 0 ? MARK.armed : MARK.kept
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
        max: Math.max(1, ...barsReal, ...barsMem),
        fromTs: fromBin * BIN_SECONDS,
        toTs: (nowBin + 1) * BIN_SECONDS,
      },
    }
  }
}
