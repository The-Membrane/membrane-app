/**
 * drawdowns — pure statistics over a multi-year hourly price history, for the
 * set-and-forget LTV sim (owner ask 2026-10-04: "what LTV per asset will be profitable to
 * set and forget with our recall mech"). ENGINE ONLY: numbers, never copy, no I/O.
 *
 * The data comes from scripts/position-sim/build-price-history.mjs → public/data/price-history/
 * (`PriceHistoryFile`): one regular grid per asset, every source on the SAME hourly index.
 *
 * GRID CONVENTION (every function here relies on it)
 *   Index i is the step OPENING at `startTs + i × stepSeconds`.
 *   close[i]  the price at the END of step i (a kline's close; the oracle round in force at
 *             the step's end).
 *   low[i]    the lowest price inside step i, opening value included (a kline's low; for the
 *   high[i]   oracle, min/max over the round in force at the step's start and every round
 *             printed inside it). A grid without low/high uses close for both.
 *   null      no observation (before a source's coverage, or a missing kline).
 *
 * WHAT EACH STATISTIC MEANS FOR A POSITION
 *   - forward drawdown (`forwardDrawdowns`): a position opened at the close of step t and
 *     left alone sees its LTV scale by close[t] / price; the worst it sees inside the next w
 *     steps is the lowest LOW in (t, t+w]. That is the set-and-forget quantity: the share of
 *     entry hours whose next-w-hours drawdown exceeds x is the share of positions opened at
 *     a uniformly random hour that would have crossed a line x below their entry price.
 *   - rolling peak-to-trough (`rollingMaxDrawdown`): the deepest fall from any running
 *     CLOSE peak to a later LOW inside each w-step window. ≥ the forward drawdown of the
 *     window's first step; the two share the same maximum.
 *   - drop events + recovery (`detectDropEvents`, `recoveryCurve`): the 8h window
 *     question — given a fall of d from a pre-drop level, how often does the price come
 *     back to within the band of that level inside the window?
 *
 * OVERLAP. Every rolling statistic is computed at EVERY step, so neighbouring windows
 * share almost all of their path. Quantiles are still the right population statistic for
 * "a uniformly random entry hour", but the information content is roughly n / w
 * independent windows — reported as `effectiveN` so a 30d p99 from ~80 independent
 * months is never read as if it came from 59,000.
 */
import { CURE_WINDOW_HOURS, MAX_THRESHOLD_TO_DELAY } from './membrane'
import type { PriceShape } from './stressGrid'

export const PRICE_HISTORY_STEP_SECONDS = 3600

/** One column set on a regular grid (see GRID CONVENTION above). */
export interface PriceGrid {
  startTs: number
  stepSeconds: number
  close: readonly (number | null)[]
  low?: readonly (number | null)[]
  high?: readonly (number | null)[]
}

export type PriceSource = 'oracle' | 'binance' | 'coinbase'

/** A run of grid indices (inclusive) served by one source. */
export interface PriceSegment {
  source: PriceSource
  fromIndex: number
  toIndex: number
}

/** The on-disk shape of public/data/price-history/<asset>-1h.json. */
export interface PriceHistoryFile {
  asset: string
  startTs: number
  stepSeconds: number
  count: number
  /** `<source>`, `<source>Low`, `<source>High` per source. */
  columns: Record<string, (number | null)[]>
  /** Which source the primary (oracle-grade where available) series uses, by index. */
  primary?: { segments: PriceSegment[]; note?: string }
}

/** The named windows of the owner's ask. Hours == steps on the hourly grid. */
export const DRAWDOWN_WINDOWS = [
  { label: '1h', hours: 1 },
  { label: '8h', hours: 8 },
  { label: '24h', hours: 24 },
  { label: '7d', hours: 168 },
  { label: '30d', hours: 720 },
] as const

export type DrawdownWindow = { label: string; hours: number }

const ok = (v: number | null | undefined): v is number => v != null && Number.isFinite(v) && v > 0

/** low[i] if observed, else close[i], else null. */
function lowAt(g: PriceGrid, i: number): number | null {
  const l = g.low?.[i]
  if (ok(l)) return l
  const c = g.close[i]
  return ok(c) ? c : null
}

function highAt(g: PriceGrid, i: number): number | null {
  const h = g.high?.[i]
  if (ok(h)) return h
  const c = g.close[i]
  return ok(c) ? c : null
}

function stepsFor(g: PriceGrid, hours: number): number {
  return Math.max(1, Math.round((hours * 3600) / g.stepSeconds))
}

// ------------------------------------------------------------------ file → grid

/** The grid of one source's columns. Throws when the file has no `<source>` column. */
export function gridFromFile(file: PriceHistoryFile, source: PriceSource): PriceGrid {
  const close = file.columns[source]
  if (!close) throw new Error(`price history ${file.asset}: no '${source}' column`)
  return {
    startTs: file.startTs,
    stepSeconds: file.stepSeconds,
    close,
    low: file.columns[`${source}Low`],
    high: file.columns[`${source}High`],
  }
}

/**
 * The PRIMARY series: each index taken from the source its segment names (the oracle
 * wherever the oracle covers, a labelled market series before that). Indices no segment
 * covers are null. The segments come from the file, so the choice is the build's, made
 * once and recorded — never re-decided by a reader.
 */
export function primaryGrid(file: PriceHistoryFile): PriceGrid & { segments: PriceSegment[] } {
  const segments = file.primary?.segments ?? []
  const n = file.count
  const close: (number | null)[] = new Array(n).fill(null)
  const low: (number | null)[] = new Array(n).fill(null)
  const high: (number | null)[] = new Array(n).fill(null)
  for (const seg of segments) {
    const c = file.columns[seg.source]
    if (!c) throw new Error(`price history ${file.asset}: segment names missing '${seg.source}'`)
    const l = file.columns[`${seg.source}Low`]
    const h = file.columns[`${seg.source}High`]
    const from = Math.max(0, seg.fromIndex)
    const to = Math.min(n - 1, seg.toIndex)
    for (let i = from; i <= to; i++) {
      close[i] = c[i] ?? null
      low[i] = l?.[i] ?? null
      high[i] = h?.[i] ?? null
    }
  }
  return { startTs: file.startTs, stepSeconds: file.stepSeconds, close, low, high, segments }
}

/** First and last index with a close, or null when the column is empty. */
export function coverage(g: PriceGrid): { fromIndex: number; toIndex: number } | null {
  let from = -1
  let to = -1
  for (let i = 0; i < g.close.length; i++) {
    if (ok(g.close[i])) {
      if (from < 0) from = i
      to = i
    }
  }
  return from < 0 ? null : { fromIndex: from, toIndex: to }
}

/** The index whose step contains `ts` (may be out of range). */
export function indexAt(g: Pick<PriceGrid, 'startTs' | 'stepSeconds'>, ts: number): number {
  return Math.floor((ts - g.startTs) / g.stepSeconds)
}

export function tsAt(g: Pick<PriceGrid, 'startTs' | 'stepSeconds'>, i: number): number {
  return g.startTs + i * g.stepSeconds
}

// ------------------------------------------------------------------ drawdowns

/**
 * Forward drawdown from every entry step: d[t] = max(0, 1 − min LOW over (t, t+w] /
 * close[t]). NaN where close[t] is missing, where the window runs past the end of the
 * grid (a truncated window is not a w-step window), or where the window has no
 * observation at all. O(n) via a sliding-window minimum.
 */
export function forwardDrawdowns(g: PriceGrid, windowSteps: number): Float64Array {
  const n = g.close.length
  const w = Math.max(1, Math.floor(windowSteps))
  const out = new Float64Array(n).fill(NaN)
  // minFrom[j] = min LOW over [j, j+w-1]; filled when the window is complete.
  const minFrom = new Float64Array(n).fill(Infinity)
  const deque: number[] = []
  let head = 0
  const val = (i: number) => lowAt(g, i) ?? Infinity
  for (let i = 0; i < n; i++) {
    const v = val(i)
    while (deque.length > head && val(deque[deque.length - 1]) >= v) deque.pop()
    deque.push(i)
    const start = i - w + 1
    if (deque[head] < start) head++
    if (start >= 0) minFrom[start] = val(deque[head])
  }
  for (let t = 0; t + w < n; t++) {
    const c = g.close[t]
    if (!ok(c)) continue
    const m = minFrom[t + 1]
    if (!Number.isFinite(m)) continue
    out[t] = Math.max(0, 1 - m / c)
  }
  return out
}

/**
 * Deepest peak-to-trough fall inside each window of w steps ENDING at t: the path is
 * close[t−w] (the window's opening price) then steps t−w+1 … t; the peak is the running
 * max CLOSE, the trough each later step's LOW (a step's low is checked against the peak
 * BEFORE its own close can raise it). NaN for the first w indices and where the opening
 * close is missing. O(n·w): ~42M steps for 30d over 6.7 years — fine offline.
 */
export function rollingMaxDrawdown(g: PriceGrid, windowSteps: number): Float64Array {
  const n = g.close.length
  const w = Math.max(1, Math.floor(windowSteps))
  const out = new Float64Array(n).fill(NaN)
  for (let t = w; t < n; t++) {
    const open = g.close[t - w]
    if (!ok(open)) continue
    let peak = open
    let mdd = 0
    for (let s = t - w + 1; s <= t; s++) {
      const l = lowAt(g, s)
      if (l != null) {
        const dd = 1 - l / peak
        if (dd > mdd) mdd = dd
      }
      const c = g.close[s]
      if (ok(c) && c > peak) peak = c
    }
    out[t] = mdd
  }
  return out
}

/** Type-7 (linear interpolation) quantile of an ASCENDING array. NaN when empty. */
export function quantileSorted(sorted: ArrayLike<number>, q: number): number {
  const n = sorted.length
  if (n === 0) return NaN
  if (n === 1) return sorted[0]
  const h = (n - 1) * Math.min(1, Math.max(0, q))
  const lo = Math.floor(h)
  const hi = Math.min(n - 1, lo + 1)
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo])
}

export interface DrawdownStats {
  /** Finite observations. */
  n: number
  /** n / window steps, floored: roughly how many INDEPENDENT windows the sample holds. */
  effectiveN: number
  p50: number
  p90: number
  p99: number
  max: number
  /** Index and step-open timestamp of the maximum (−1 / NaN when n = 0). */
  maxIndex: number
  maxTs: number
}

export function drawdownStats(
  values: ArrayLike<number>,
  windowSteps: number,
  grid: Pick<PriceGrid, 'startTs' | 'stepSeconds'>,
): DrawdownStats {
  const xs: number[] = []
  let max = -Infinity
  let maxIndex = -1
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (!Number.isFinite(v)) continue
    xs.push(v)
    if (v > max) {
      max = v
      maxIndex = i
    }
  }
  xs.sort((a, b) => a - b)
  return {
    n: xs.length,
    effectiveN: Math.floor(xs.length / Math.max(1, windowSteps)),
    p50: quantileSorted(xs, 0.5),
    p90: quantileSorted(xs, 0.9),
    p99: quantileSorted(xs, 0.99),
    max: xs.length ? max : NaN,
    maxIndex,
    maxTs: maxIndex >= 0 ? tsAt(grid, maxIndex) : NaN,
  }
}

export type DrawdownMode = 'forward' | 'rolling'

export interface DrawdownRow extends DrawdownStats {
  label: string
  hours: number
  mode: DrawdownMode
}

/** p50/p90/p99/max per window. `forward` = entry-relative (set-and-forget); `rolling` = peak-to-trough inside each window. */
export function drawdownTable(
  g: PriceGrid,
  opts: {
    windows?: readonly DrawdownWindow[]
    mode?: DrawdownMode
    fromIndex?: number
    toIndex?: number
  } = {},
): DrawdownRow[] {
  const mode = opts.mode ?? 'forward'
  const windows = opts.windows ?? DRAWDOWN_WINDOWS
  const sub = sliceGrid(g, opts.fromIndex, opts.toIndex)
  return windows.map((win) => {
    const steps = stepsFor(sub, win.hours)
    const values =
      mode === 'forward' ? forwardDrawdowns(sub, steps) : rollingMaxDrawdown(sub, steps)
    const stats = drawdownStats(values, steps, sub)
    return { label: win.label, hours: win.hours, mode, ...stats }
  })
}

/** A sub-grid over [fromIndex, toIndex] (inclusive), re-based so index 0 is fromIndex. */
export function sliceGrid(g: PriceGrid, fromIndex?: number, toIndex?: number): PriceGrid {
  const n = g.close.length
  const from = Math.max(0, Math.floor(fromIndex ?? 0))
  const to = Math.min(n - 1, Math.floor(toIndex ?? n - 1))
  if (from === 0 && to === n - 1) return g
  return {
    startTs: tsAt(g, from),
    stepSeconds: g.stepSeconds,
    close: g.close.slice(from, to + 1),
    low: g.low?.slice(from, to + 1),
    high: g.high?.slice(from, to + 1),
  }
}

export interface WorstWindow {
  /** Entry step (its close is the reference). */
  index: number
  ts: number
  entryPrice: number
  troughIndex: number
  troughTs: number
  troughPrice: number
  drop: number
}

/**
 * The k deepest forward drawdowns over w steps that do not overlap: each pick blocks
 * entries within w steps of it on either side, so one crash is reported once. Windows
 * with no drawdown at all are never listed.
 */
export function worstWindows(g: PriceGrid, windowSteps: number, k: number): WorstWindow[] {
  const w = Math.max(1, Math.floor(windowSteps))
  const d = forwardDrawdowns(g, w)
  const order = Array.from(d.keys())
    .filter((i) => Number.isFinite(d[i]) && d[i] > 0)
    .sort((a, b) => d[b] - d[a] || a - b)
  const blocked = new Uint8Array(d.length)
  const out: WorstWindow[] = []
  for (const t of order) {
    if (out.length >= k) break
    if (blocked[t]) continue
    let troughIndex = -1
    let trough = Infinity
    for (let s = t + 1; s <= t + w; s++) {
      const l = lowAt(g, s)
      if (l != null && l < trough) {
        trough = l
        troughIndex = s
      }
    }
    out.push({
      index: t,
      ts: tsAt(g, t),
      entryPrice: g.close[t] as number,
      troughIndex,
      troughTs: tsAt(g, troughIndex),
      troughPrice: trough,
      drop: d[t],
    })
    for (let s = Math.max(0, t - w); s <= Math.min(d.length - 1, t + w); s++) blocked[s] = 1
  }
  return out
}

// ------------------------------------------------------------------ drops, wicks, recovery

export interface DropEventOptions {
  /** Fall from the pre-drop level that defines an event (0.10 = 10%). */
  drop: number
  /** The pre-drop level is the highest CLOSE over this many steps before the event step.
   *  So an event is "a fall of ≥ drop inside ≤ lookbackSteps". Default 24. */
  lookbackSteps?: number
  /** Recovered = a close back at or above refPrice × (1 − band). Default 4%
   *  (MAX_THRESHOLD_TO_DELAY, taken as a PRICE fraction as the owner's question states it;
   *  the engine's band is in LTV terms, which is a b / (1 + b) = 3.85% price band —
   *  `ltvBandToPriceBand`). */
  band?: number
  /** Steps, counting the event step itself, in which a recovery counts. Default 8
   *  (CURE_WINDOW_HOURS). The drop happens at an unknown moment inside the event step, so
   *  only closes at most `windowSteps` steps after that step OPENED are counted — a
   *  recovery in the window's last partial hour is missed (conservative). */
  windowSteps?: number
  /** 'close' (default): a step that touches the band intra-hour but closes below it is
   *  not a recovery. 'high' counts the touch from the step after the event on (the event
   *  step's own high may predate its low, so it always uses the close). */
  recoverOn?: 'close' | 'high'
}

export interface DropEvent {
  /** The first step whose LOW reached refPrice × (1 − drop). */
  index: number
  ts: number
  refPrice: number
  refIndex: number
  /** Lowest LOW from the event step until recovery (or the window's end). */
  troughPrice: number
  troughIndex: number
  /** 1 − troughPrice / refPrice. ≥ drop. */
  maxDrop: number
  recovered: boolean
  recoveredIndex: number | null
  /** recoveredIndex − index + 1: the recovering close came at most this many hours after the drop. */
  stepsToRecover: number | null
  /** 'wick' = recovered inside the window; 'sustained' = still below the band at its end. */
  kind: 'wick' | 'sustained'
}

/** The LTV band b expressed as a price fall: LTV ∝ 1 / price, so L(1 + b) ⇔ price × 1/(1 + b). */
export function ltvBandToPriceBand(b: number): number {
  return b / (1 + b)
}

/**
 * Every fall of ≥ `drop` from its pre-drop level, DE-CLUSTERED: once an event resolves
 * (recovers, or its window ends), the next event's pre-drop level may only use closes
 * AFTER that resolution. A sustained crash is therefore one event per fresh d-fall, not
 * one event every window while the old peak is still inside the lookback. Events whose
 * window would run past the end of the grid are not reported (their outcome is unknown).
 */
export function detectDropEvents(g: PriceGrid, opts: DropEventOptions): DropEvent[] {
  const n = g.close.length
  const lookback = Math.max(1, Math.floor(opts.lookbackSteps ?? 24))
  const band = opts.band ?? MAX_THRESHOLD_TO_DELAY
  const win = Math.max(1, Math.floor(opts.windowSteps ?? CURE_WINDOW_HOURS))
  const recoverOn = opts.recoverOn ?? 'close'
  if (!(opts.drop > 0 && opts.drop < 1)) return []
  const events: DropEvent[] = []
  let freshFrom = 0 // closes before this index may not set a pre-drop level
  for (let t = 1; t < n; t++) {
    const lo = Math.max(freshFrom, t - lookback)
    let ref = -Infinity
    let refIndex = -1
    for (let s = lo; s < t; s++) {
      const c = g.close[s]
      if (ok(c) && c >= ref) {
        ref = c
        refIndex = s
      }
    }
    if (refIndex < 0) continue
    const l = lowAt(g, t)
    if (l == null || l > ref * (1 - opts.drop)) continue
    const end = t + win - 1
    if (end >= n) break
    const target = ref * (1 - band)
    let recoveredIndex: number | null = null
    for (let s = t; s <= end; s++) {
      const v = s > t && recoverOn === 'high' ? highAt(g, s) : g.close[s]
      if (ok(v) && v >= target) {
        recoveredIndex = s
        break
      }
    }
    const stop = recoveredIndex ?? end
    let trough = Infinity
    let troughIndex = t
    for (let s = t; s <= stop; s++) {
      const x = lowAt(g, s)
      if (x != null && x < trough) {
        trough = x
        troughIndex = s
      }
    }
    events.push({
      index: t,
      ts: tsAt(g, t),
      refPrice: ref,
      refIndex,
      troughPrice: trough,
      troughIndex,
      maxDrop: 1 - trough / ref,
      recovered: recoveredIndex !== null,
      recoveredIndex,
      stepsToRecover: recoveredIndex === null ? null : recoveredIndex - t + 1,
      kind: recoveredIndex === null ? 'sustained' : 'wick',
    })
    freshFrom = stop + 1
    t = stop // loop increments past the resolution
  }
  return events
}

/** Wilson score interval for k successes in n trials. [NaN, NaN] when n = 0. */
export function wilsonInterval(k: number, n: number, z = 1.96): [number, number] {
  if (n <= 0) return [NaN, NaN]
  const p = k / n
  const z2 = z * z
  const denom = 1 + z2 / n
  const centre = (p + z2 / (2 * n)) / denom
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom
  return [Math.max(0, centre - half), Math.min(1, centre + half)]
}

export interface RecoveryRow {
  drop: number
  events: number
  recovered: number
  /** P(back within the band inside the window | a fall of ≥ drop). NaN with no events. */
  p: number
  /** 95% Wilson interval. */
  ciLow: number
  ciHigh: number
  /** Median steps to the recovering close, over recovered events. */
  medianStepsToRecover: number
  /** Mean depth actually reached (maxDrop) over the events. */
  meanMaxDrop: number
}

/** P(recovery within the window | drop of d) for each d — the 8h-window question. */
export function recoveryCurve(
  g: PriceGrid,
  drops: readonly number[],
  opts: Omit<DropEventOptions, 'drop'> = {},
): RecoveryRow[] {
  return drops.map((drop) => {
    const ev = detectDropEvents(g, { ...opts, drop })
    const rec = ev.filter((e) => e.recovered)
    const steps = rec.map((e) => e.stepsToRecover as number).sort((a, b) => a - b)
    const [ciLow, ciHigh] = wilsonInterval(rec.length, ev.length)
    return {
      drop,
      events: ev.length,
      recovered: rec.length,
      p: ev.length ? rec.length / ev.length : NaN,
      ciLow,
      ciHigh,
      medianStepsToRecover: quantileSorted(steps, 0.5),
      meanMaxDrop: ev.length ? ev.reduce((a, e) => a + e.maxDrop, 0) / ev.length : NaN,
    }
  })
}

export interface IntrabarWick {
  index: number
  ts: number
  /** 1 − low / min(previous close, own close): how far the step dipped below both ends. */
  depth: number
  low: number
}

/**
 * Single-step wicks: steps whose LOW sits ≥ minDepth below BOTH the previous close and
 * their own close — a fall and a recovery inside one step. On the market series these are
 * the prints an hourly close (and often the oracle) never shows.
 */
export function intrabarWicks(g: PriceGrid, minDepth: number): IntrabarWick[] {
  const out: IntrabarWick[] = []
  for (let i = 1; i < g.close.length; i++) {
    const prev = g.close[i - 1]
    const c = g.close[i]
    const l = g.low?.[i]
    if (!ok(prev) || !ok(c) || !ok(l)) continue
    const depth = 1 - l / Math.min(prev, c)
    if (depth >= minDepth) out.push({ index: i, ts: tsAt(g, i), depth, low: l })
  }
  return out
}

// ------------------------------------------------------------------ cross-checks

export interface DiffStats {
  /** Steps where both series have a value. */
  n: number
  /** Mean of (a / b − 1) in basis points (signed: positive = a above b). */
  meanBps: number
  medianAbsBps: number
  p90AbsBps: number
  p99AbsBps: number
  maxAbsBps: number
  /** Index / timestamp of the largest |difference|. */
  maxIndex: number
  maxTs: number
}

/** a vs b on the same grid, in bps of b. Only steps where both are observed count. */
export function seriesDiffStats(
  a: readonly (number | null)[],
  b: readonly (number | null)[],
  grid: Pick<PriceGrid, 'startTs' | 'stepSeconds'>,
  range: { fromIndex?: number; toIndex?: number } = {},
): DiffStats {
  const from = Math.max(0, range.fromIndex ?? 0)
  const to = Math.min(Math.min(a.length, b.length) - 1, range.toIndex ?? Infinity)
  const abs: number[] = []
  let sum = 0
  let maxAbs = -1
  let maxIndex = -1
  for (let i = from; i <= to; i++) {
    const x = a[i]
    const y = b[i]
    if (!ok(x) || !ok(y)) continue
    const bps = (x / y - 1) * 1e4
    sum += bps
    const m = Math.abs(bps)
    abs.push(m)
    if (m > maxAbs) {
      maxAbs = m
      maxIndex = i
    }
  }
  abs.sort((p, q) => p - q)
  return {
    n: abs.length,
    meanBps: abs.length ? sum / abs.length : NaN,
    medianAbsBps: quantileSorted(abs, 0.5),
    p90AbsBps: quantileSorted(abs, 0.9),
    p99AbsBps: quantileSorted(abs, 0.99),
    maxAbsBps: abs.length ? maxAbs : NaN,
    maxIndex,
    maxTs: maxIndex >= 0 ? tsAt(grid, maxIndex) : NaN,
  }
}

// ------------------------------------------------------------------ engine bridge

/**
 * A measured window as a stress-engine replay (stressGrid `PriceShape` 'replay'):
 * steps [fromIndex, toIndex], relative to close[fromIndex]. `use: 'low'` walks each later
 * step at its LOW — the conservative path (the engine then never sees an intra-hour
 * recovery); 'close' (default) walks closes. Null when the entry close is missing or the
 * window has fewer than two steps.
 */
export function historyReplayShape(
  g: PriceGrid,
  fromIndex: number,
  toIndex: number,
  opts: { id: string; use?: 'close' | 'low' },
): PriceShape | null {
  const from = Math.max(0, Math.floor(fromIndex))
  const to = Math.min(g.close.length - 1, Math.floor(toIndex))
  if (to - from < 1) return null
  const base = g.close[from]
  if (!ok(base)) return null
  const ratios: (number | null)[] = [1]
  for (let i = from + 1; i <= to; i++) {
    const v = opts.use === 'low' ? lowAt(g, i) : g.close[i]
    ratios.push(ok(v) ? v / base : null)
  }
  return { kind: 'replay', id: opts.id, stepSeconds: g.stepSeconds, ratios }
}
