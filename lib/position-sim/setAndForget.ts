/**
 * setAndForget — the pure helpers behind the set-and-forget LTV sim (owner ask 2026-10-04:
 * "run a sim to see what LTV per asset will be profitable to set and forget with our recall
 * mech"). ENGINE ONLY: numbers, never copy, no I/O. The driver is
 * scripts/position-sim/set-and-forget-sim.ts; the write-up is docs/research/SET-AND-FORGET-LTV.md.
 *
 * THE QUESTION. A position opened at the close of a historical hour s, at start LTV ℓ, and
 * left untouched for a horizon H: is any collateral SOLD? For one start hour that is a
 * threshold ℓ*(s) — every ℓ at or under it sees no sale. Across every start hour the table
 * reports the minimum (never sold), and the 1st / 5th percentiles (sold in at most 1% / 5%
 * of start hours). That is SURVIVAL, not the ask's "profitable": no fee, venue yield,
 * interest or lost carry enters any number here (refuter finding 2026-10-06; the doc's
 * "Not answered: profitable"). `tallyAtLtv` reports how often recall fired and how much of
 * the deployed debt it unwound, the measured input a profitability model would need.
 *
 * NOTHING HERE RE-IMPLEMENTS THE MECHANICS. Every "is it sold?" is one stressGrid
 * `runStress` call on a `replay` shape built from the measured window — the same walk,
 * recall, window, band, debt floor and owner-ruled intended rules the Risk Frontier runs.
 * The bisection is frontier.ts's `bisectEdge`. The only arithmetic of our own is
 *   - the REPLAY: the window's hourly path, relative to the entry close (`windowReplay`);
 *   - a LOWER BOUND used to bracket and prune: a path whose LTV never crosses the line
 *     cannot sell (nothing calls), so ℓ*(s) ≥ line × (lowest ratio on the replay)
 *     (`windowMinRatios`). It is only ever used to skip runs whose answer it proves.
 *
 * PATH RESOLUTION ('low-close', the default): each hour contributes TWO half-hour steps —
 * its LOW, then its CLOSE. For the oracle the low is a round the feed actually printed
 * inside the hour (drawdowns.ts GRID CONVENTION), so a keeper could have called against
 * it; walking it as a 30-minute step can break the band (an immediate sale) but costs the
 * 8h window at most one half-hour of extra breach. Highs are NOT walked: an intra-hour high
 * could clear an armed timer, which would flatter the delay. 'close' walks closes only.
 *
 * MONOTONICITY. Bisection needs "sold" to be monotone in ℓ. It is for a levered_long
 * position (a higher ℓ is a higher LTV at every step, so it crosses earlier and stays over
 * longer). For carry the one known exception is the debt-floor close (frontier.ts header):
 * it opens only while the debt at a call is under ~2 × liqDebtMinimum. The sim runs
 * $100,000 of collateral, so the debt at any call in the solved range is far above $4,000;
 * the driver still re-checks the worst windows on a whole-percent grid and reports it.
 * So the ℓ* table holds for LARGE positions only. A copy claim at one LTV is measured per
 * position size by `tallyAtLtv` (plain runs, no bisection — driver `--claims`): with the
 * venue returning half, a carry position whose debt is under 2 × liqDebtMinimum ($4,000)
 * has its first recall escalated to the whole loan, gets half back, and sells collateral
 * for the rest on the first line crossing (saleReason 'floor', refuter finding 2026-10-06).
 */
import type { PriceGrid } from './drawdowns'
import { bisectEdge } from './frontier'
import { membraneBorrowLtv, type MembraneClass } from './membrane'
import {
  STRESS_SEVERITY,
  runStress,
  stressRank,
  type ExitCapacityPresetId,
  type PriceShape,
  type StressModelled,
  type StressPosition,
  type TradeShape,
} from './stressGrid'

// ---------------------------------------------------------------- constants

/** The hold horizons of the ask. Hours == steps on the hourly grid. */
export const SET_AND_FORGET_HORIZONS = [
  { label: '30d', hours: 720 },
  { label: '90d', hours: 2160 },
  { label: '365d', hours: 8760 },
] as const

/**
 * Collateral every simulated position starts with, USD. Large enough that the $2,000 debt
 * floor (LIQ_DEBT_MINIMUM_USD) only sizes sales and never decides WHETHER one happens (see
 * MONOTONICITY above). The engine's default floor is kept.
 */
export const SET_AND_FORGET_COLLATERAL_USD = 100_000

/** Bisection tolerance on the start LTV: 0.02 percentage points. */
export const SET_AND_FORGET_LTV_TOL = 2e-4

/** Each hour is walked as two half-hour steps (low, close). */
export const SUB_STEP_SECONDS = 1800

/**
 * Relative slack on the no-breach lower bound. The engine normalizes its inputs (debt to
 * cents, replay ratios to 8 decimals), so an LTV exactly at line × min ratio can read a
 * hair over the line — and in the no-delay class, or over a forward-filled flat trough held
 * past 8h, that hair is a sale. 1e-5 covers both roundings for any debt over $500.
 */
export const LOWER_BOUND_SLACK = 1e-5

/** The tail shares of the table: never sold, ≤ 1 %, ≤ 5 % of start hours. */
export const TAIL_FRACTIONS = [0, 0.01, 0.05] as const

// -------------------------------------------------------------------- paths

/** An hourly path on the drawdowns.ts grid. NaN = no observation. */
export interface HourlyPath {
  id: string
  startTs: number
  close: Float64Array
  low: Float64Array
}

const fin = (v: number | null | undefined): v is number => v != null && Number.isFinite(v) && v > 0

/** A PriceGrid as a dense hourly path (missing → NaN; a missing low falls back to the close,
 *  and an hour without a close is missing whole). */
export function hourlyPathFromGrid(id: string, g: PriceGrid): HourlyPath {
  if (g.stepSeconds !== 3600) throw new Error(`hourlyPathFromGrid: ${id} is not hourly`)
  const n = g.close.length
  const close = new Float64Array(n)
  const low = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const c = g.close[i]
    const l = g.low?.[i]
    close[i] = fin(c) ? c : NaN
    // No close = no observation for the hour: its low is dropped with it.
    low[i] = !fin(c) ? NaN : fin(l) ? l : c
  }
  return { id, startTs: g.startTs, close, low }
}

/**
 * A daily series (e.g. wstETH `stEthPerToken`) on the hourly grid: day d's value covers every
 * hour of that UTC day, and a missing day carries the last value forward. NaN before the
 * first observation — never back-filled.
 */
export function dailyToHourly(
  daily: readonly (number | null)[],
  dailyStartTs: number,
  hourlyStartTs: number,
  hours: number,
): Float64Array {
  const out = new Float64Array(hours)
  let last = NaN
  let lastDay = -1
  for (let i = 0; i < hours; i++) {
    const day = Math.floor((hourlyStartTs + i * 3600 - dailyStartTs) / 86400)
    if (day !== lastDay) {
      // Walk every day passed since the last hour so a missing day keeps the last value.
      for (let d = Math.max(0, lastDay + 1); d <= day && d < daily.length; d++) {
        const v = daily[d]
        if (fin(v)) last = v
      }
      lastDay = day
    }
    out[i] = day >= 0 ? last : NaN
  }
  return out
}

/**
 * base × factor, hour by hour. `factor.low` multiplies the base LOW (a hedge-free stand-in
 * for the product's low: both lows at the same instant, so it can only be deeper than the
 * product's true low — conservative). NaN anywhere → NaN.
 */
export function multiplyPath(
  id: string,
  base: HourlyPath,
  factor: { close: ArrayLike<number>; low?: ArrayLike<number> },
): HourlyPath {
  const n = base.close.length
  const close = new Float64Array(n)
  const low = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const fc = factor.close[i]
    const fl = factor.low ? factor.low[i] : fc
    close[i] = base.close[i] * fc
    low[i] = base.low[i] * (Number.isFinite(fl) && fl > 0 ? fl : fc)
  }
  return { id, startTs: base.startTs, close, low }
}

/** First and last index with a finite close, or null. */
export function pathCoverage(p: HourlyPath): { fromIndex: number; toIndex: number } | null {
  let from = -1
  let to = -1
  for (let i = 0; i < p.close.length; i++) {
    if (Number.isFinite(p.close[i])) {
      if (from < 0) from = i
      to = i
    }
  }
  return from < 0 ? null : { fromIndex: from, toIndex: to }
}

export type PathResolution = 'low-close' | 'close'

/**
 * The window [start, start + hours] as a stress-engine replay, relative to the entry close.
 * 'low-close': 1800 s steps [1, low₁, close₁, low₂, close₂, …]; 'close': 3600 s steps
 * [1, close₁, …]. A missing observation is null (the engine forward-fills it). Null when the
 * entry close is missing or the window runs past the path's last observation.
 */
export function windowReplay(
  p: HourlyPath,
  start: number,
  hours: number,
  resolution: PathResolution = 'low-close',
): PriceShape | null {
  const end = start + hours
  if (start < 0 || hours < 1 || end >= p.close.length) return null
  const c0 = p.close[start]
  if (!Number.isFinite(c0) || !Number.isFinite(p.close[end])) return null
  const per = resolution === 'low-close' ? 2 : 1
  const ratios: (number | null)[] = new Array(hours * per + 1)
  ratios[0] = 1
  let k = 1
  for (let i = start + 1; i <= end; i++) {
    if (per === 2) {
      const l = p.low[i]
      ratios[k++] = Number.isFinite(l) ? l / c0 : null
    }
    const c = p.close[i]
    ratios[k++] = Number.isFinite(c) ? c / c0 : null
  }
  return {
    kind: 'replay',
    id: `${p.id}:${start}+${hours}h:${resolution}`,
    stepSeconds: per === 2 ? SUB_STEP_SECONDS : 3600,
    ratios,
  }
}

/**
 * For every start s, the lowest ratio the replay of [s, s + hours] walks — min over the
 * window's observed lows (for 'low-close') and closes, divided by close[s], capped at 1 (the
 * entry itself; the engine forward-fills leading gaps from it). NaN where `windowReplay`
 * would return null. O(n) sliding-window minimum.
 *
 * ℓ*(s) ≥ line × this: below it the LTV never crosses the line, nothing calls, nothing sells.
 */
export function windowMinRatios(
  p: HourlyPath,
  hours: number,
  resolution: PathResolution = 'low-close',
): Float64Array {
  const n = p.close.length
  const m = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const c = p.close[i]
    const l = resolution === 'low-close' ? p.low[i] : NaN
    m[i] = Math.min(Number.isFinite(c) ? c : Infinity, Number.isFinite(l) ? l : Infinity)
  }
  const out = new Float64Array(n).fill(NaN)
  // Deque of indices with increasing m over the window (s, s + hours].
  const dq = new Int32Array(n)
  let head = 0
  let tail = 0
  let next = 1 // next index to push
  for (let s = 0; s + hours < n; s++) {
    const end = s + hours
    while (next <= end) {
      while (tail > head && m[dq[tail - 1]] >= m[next]) tail--
      dq[tail++] = next
      next++
    }
    while (tail > head && dq[head] <= s) head++
    const c0 = p.close[s]
    if (!Number.isFinite(c0) || !Number.isFinite(p.close[end])) continue
    const mn = m[dq[head]]
    out[s] = Number.isFinite(mn) ? Math.min(1, mn / c0) : 1
  }
  return out
}

/**
 * The proven lower bound on ℓ*(s): under line × (lowest replay ratio) the LTV never crosses
 * the line, so nothing calls and nothing sells. Shaved by LOWER_BOUND_SLACK for the engine's
 * input rounding.
 */
export function noBreachBound(line: number, minRatio: number): number {
  return line * minRatio * (1 - LOWER_BOUND_SLACK)
}

/** Index (absolute) of the lowest walked point in [start + 1, start + hours], and its ratio. */
export function windowTrough(
  p: HourlyPath,
  start: number,
  hours: number,
  resolution: PathResolution = 'low-close',
): { index: number; ratio: number } | null {
  const c0 = p.close[start]
  if (!Number.isFinite(c0)) return null
  let best = Infinity
  let at = -1
  for (let i = start + 1; i <= Math.min(p.close.length - 1, start + hours); i++) {
    const v = Math.min(
      Number.isFinite(p.close[i]) ? p.close[i] : Infinity,
      resolution === 'low-close' && Number.isFinite(p.low[i]) ? p.low[i] : Infinity,
    )
    if (v < best) {
      best = v
      at = i
    }
  }
  return at < 0 ? null : { index: at, ratio: best / c0 }
}

// --------------------------------------------------------------- the case

/** One cell of the table: what the position is, before its start LTV is chosen. */
export interface SetAndForgetCase {
  line: number
  membraneClass: MembraneClass
  tradeShape: TradeShape
  /** Carry only: the named exit-capacity level. The whole debt is deployed. */
  exitCapacityPreset?: ExitCapacityPresetId
  /** Default SET_AND_FORGET_COLLATERAL_USD. */
  collateralUsd?: number
  /** Default: the engine's (LIQ_DEBT_MINIMUM_USD). */
  debtMinimumUsd?: number
}

/**
 * The stress position at start LTV `ltv`. A carry position deploys ALL of its debt (the
 * owner's carry definition: the borrowed CDT sits in a venue) and must name its exit
 * capacity — the engine refuses a silent ×1 (owner ruling 2026-10-04).
 */
export function casePosition(c: SetAndForgetCase, ltv: number): StressPosition {
  const collateralUsd = c.collateralUsd ?? SET_AND_FORGET_COLLATERAL_USD
  const debtUsd = ltv * collateralUsd
  const carry = c.tradeShape === 'carry'
  return {
    collateralUsd,
    debtUsd,
    line: c.line,
    membraneClass: c.membraneClass,
    tradeShape: c.tradeShape,
    ...(carry ? { deployedUsd: debtUsd, exitCapacityPreset: c.exitCapacityPreset } : {}),
    ...(c.debtMinimumUsd !== undefined ? { debtMinimumUsd: c.debtMinimumUsd } : {}),
  }
}

/** The highest start LTV the case can open at: the borrow cap, line − 3pp. */
export function caseBorrowCap(c: SetAndForgetCase): number {
  return membraneBorrowLtv(c.line)
}

/** One engine run. Throws on `not_modelled` — every case here is a modelled position. */
export function runCase(c: SetAndForgetCase, shape: PriceShape, ltv: number): StressModelled {
  const r = runStress(casePosition(c, ltv), { price: shape })
  if (r.outcome === 'not_modelled') {
    throw new Error(`set-and-forget: not modelled (${r.reason}) at ltv ${ltv} on ${r.scenarioId}`)
  }
  return r
}

export const isSold = (r: StressModelled): boolean => stressRank(r) >= STRESS_SEVERITY.sold

export interface StartSolve {
  /**
   * 'cap'   no sale even at the borrow cap: safe = the cap (the answer is cap-bound).
   * 'found' a sale edge under the cap: every LTV ≤ safe tested clean, `triggersAt` sold.
   */
  status: 'cap' | 'found'
  /** Highest start LTV seen with no sale (bracket low end). */
  safe: number
  /** Lowest start LTV seen to sell (bracket high end); null when cap-bound. */
  triggersAt: number | null
  /** The engine node at `triggersAt` (sale reason, time to sale); null when cap-bound. */
  at: StressModelled | null
  /** Engine runs spent. */
  runs: number
  /** True when the engine sold AT the proven lower bound (should never happen; reported). */
  boundViolated: boolean
}

/**
 * ℓ*(s) for one window by bisection on the start LTV, every probe an engine run.
 * `lowerBound` (`noBreachBound`) is where nothing can breach; `upperHint` is an optional
 * guess of a selling LTV (verified by the engine before it is used — a wrong hint only costs
 * runs, never correctness).
 */
export function solveStartLtv(
  c: SetAndForgetCase,
  shape: PriceShape,
  opts: { lowerBound?: number; upperHint?: number; tol?: number } = {},
): StartSolve {
  const cap = caseBorrowCap(c)
  const tol = opts.tol ?? SET_AND_FORGET_LTV_TOL
  let runs = 0
  const memo = new Map<number, StressModelled>()
  const run = (ltv: number) => {
    let r = memo.get(ltv)
    if (!r) {
      r = runCase(c, shape, ltv)
      runs++
      memo.set(ltv, r)
    }
    return r
  }
  const sells = (ltv: number) => isSold(run(ltv))

  if (!sells(cap)) {
    return { status: 'cap', safe: cap, triggersAt: null, at: null, runs, boundViolated: false }
  }
  let lo = Math.max(0, Math.min(cap, opts.lowerBound ?? 0))
  let boundViolated = false
  if (lo > 0 && sells(lo)) {
    boundViolated = true
    lo = 0
  }
  let hi = cap
  const hint = opts.upperHint
  if (hint !== undefined && hint > lo && hint < cap && sells(hint)) hi = hint
  const b = bisectEdge(sells, lo, hi, tol)
  if (b.status === 'found') {
    return {
      status: 'found',
      safe: b.safeBelow,
      triggersAt: b.triggersAt,
      at: run(b.triggersAt),
      runs,
      boundViolated,
    }
  }
  // 'already': sells at lo (only reachable with lo = 0, i.e. it sells with no debt — not a
  // position); 'beyond_range' cannot happen (hi sells by construction). Report the edge as 0.
  return { status: 'found', safe: 0, triggersAt: lo, at: run(lo), runs, boundViolated }
}

// ------------------------------------------------------- one LTV, every start

/** One start LTV across a population of start hours — the direct check behind a copy claim. */
export interface LtvTally {
  ltv: number
  /** Start hours in the population. */
  n: number
  /** Starts whose path crosses the line at this LTV (a call fires). */
  breached: number
  /** Starts where a recall drew venue capital — "never sold" is not "untouched". */
  recalled: number
  /**
   * What the recalls drew, as a share of the starting debt (carry: the deployed capital), over
   * the `recalled` starts — the part of the carry that was unwound (lower nearest-rank
   * quantiles). Null when no recall drew.
   */
  recallDrawnShareOfDebt: { median: number; p95: number; max: number } | null
  sold: number
  /** First-sale reason ('band' | 'expiry' | 'floor') among the sold starts. */
  bySaleReason: Record<string, number>
  runs: number
}

/**
 * The share of start hours sold at ONE start LTV: a plain engine run per start, no
 * bisection. Unlike the ℓ* tail it needs no monotonicity, so it holds where "sold" is NOT
 * monotone in the LTV — a small carry position, where the $2,000 debt floor turns the first
 * recall into a whole-loan close (MONOTONICITY above). A start whose proven bound
 * (`noBreachBound`) is at or above `ltv` never crosses the line; it is counted clean without
 * a run.
 */
export function tallyAtLtv(
  c: SetAndForgetCase,
  p: HourlyPath,
  starts: readonly number[],
  hours: number,
  ltv: number,
  resolution: PathResolution = 'low-close',
  minRatios: Float64Array = windowMinRatios(p, hours, resolution),
): LtvTally {
  const t: LtvTally = {
    ltv,
    n: starts.length,
    breached: 0,
    recalled: 0,
    recallDrawnShareOfDebt: null,
    sold: 0,
    bySaleReason: {},
    runs: 0,
  }
  const debtUsd = casePosition(c, ltv).debtUsd
  const drawnShares: number[] = []
  for (const s of starts) {
    if (noBreachBound(c.line, minRatios[s]) >= ltv) continue
    const shape = windowReplay(p, s, hours, resolution)
    if (!shape) throw new Error(`tallyAtLtv: start ${s} has no complete window`)
    const r = runCase(c, shape, ltv)
    t.runs++
    if (r.timeToBreachSeconds !== null) t.breached++
    if ((r.recallDrawnUsd ?? 0) > 0) {
      t.recalled++
      drawnShares.push(r.recallDrawnUsd! / debtUsd)
    }
    if (isSold(r)) {
      t.sold++
      const why = r.saleReason ?? 'unknown'
      t.bySaleReason[why] = (t.bySaleReason[why] ?? 0) + 1
    }
  }
  if (drawnShares.length) {
    drawnShares.sort((a, b) => a - b)
    const q = (f: number) => drawnShares[Math.floor(f * (drawnShares.length - 1))]
    t.recallDrawnShareOfDebt = { median: q(0.5), p95: q(0.95), max: q(1) }
  }
  return t
}

// --------------------------------------------------------------- the tail

export interface LowTail<T> {
  /** Every solved key → its result, in solve order. */
  solved: Map<number, T>
  /** The k smallest safe values found, ascending. Exact for the whole population. */
  lowest: number[]
  /** Keys solved before the prune stopped. */
  solvedCount: number
}

/**
 * The k smallest ℓ*(s) over a population of start hours, solving as few as possible.
 * Starts are visited in ascending order of their proven lower bound; once k values are in
 * hand and the next start's lower bound is at or above the k-th smallest, no unvisited start
 * can enter the lowest k (its ℓ* ≥ its bound ≥ the k-th), so the walk stops. The result is
 * exactly what solving every start would give for the lowest k.
 */
export function solveLowTail<T>(
  keys: readonly number[],
  lowerBound: (key: number) => number,
  k: number,
  solve: (key: number) => { safe: number; result: T },
): LowTail<T> {
  const order = keys.slice().sort((a, b) => lowerBound(a) - lowerBound(b))
  const lowest: number[] = []
  const solved = new Map<number, T>()
  let solvedCount = 0
  for (const key of order) {
    if (lowest.length >= k && lowerBound(key) >= lowest[k - 1]) break
    const { safe, result } = solve(key)
    solved.set(key, result)
    solvedCount++
    // Sorted insert, keep k.
    let lo = 0
    let hi = lowest.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (lowest[mid] <= safe) lo = mid + 1
      else hi = mid
    }
    lowest.splice(lo, 0, safe)
    if (lowest.length > k) lowest.pop()
  }
  return { solved, lowest, solvedCount }
}

/** k for a population of n: enough lowest values to read every fraction's quantile. */
export function tailK(n: number, fractions: readonly number[] = TAIL_FRACTIONS): number {
  return Math.min(n, Math.floor(Math.max(...fractions) * n) + 1)
}

/**
 * The start LTV sold in at most a fraction f of the n start hours: the largest ℓ with
 * #{s : ℓ*(s) < ℓ} ≤ ⌊f·n⌋, i.e. the ⌊f·n⌋-th smallest ℓ* (0-based). f = 0 is the minimum —
 * never sold. `lowest` must hold at least ⌊f·n⌋ + 1 ascending values.
 */
export function tailQuantile(lowest: readonly number[], n: number, f: number): number {
  const i = Math.floor(f * n)
  if (i >= lowest.length)
    throw new Error(`tailQuantile: need ${i + 1} lowest values, have ${lowest.length}`)
  return lowest[i]
}

/**
 * Round DOWN to `dp` decimals (toward risk: the quoted LTV is never above the measured edge).
 * A tiny epsilon keeps an exact grid value (0.77) from flooring to the step below it.
 */
export function floorTo(x: number, dp: number): number {
  const f = 10 ** dp
  return Math.floor(x * f + 1e-9) / f
}

/** Leverage of a looped long at start LTV ℓ (debt swapped back into the asset): 1 / (1 − ℓ). */
export function loopLeverage(ltv: number): number {
  return 1 / (1 - ltv)
}

/** Health factor at start LTV ℓ against a line: line / ℓ. */
export function healthFactor(line: number, ltv: number): number {
  return line / ltv
}
