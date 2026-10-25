/**
 * raw (fH) — TypeScript port of the Q26 displayed touch-probability model.
 *
 * Reference: membrane-app branch research/history-forecasts,
 *   scripts/research/history-forecasts/live/q26_live_d12.py  series_origin()   (the D12 live definition)
 *   = r192_borrower.task = r16_dev.task at the L8 levels, built from
 *   a2_touch.ewma_sigma / fhs_predict, a3_touch.S3 / Prep3 / window_min_null_rule / first_quarter_after,
 *   a6_touch.Prep6 / har_components / sigma_fut / parkinson_v.
 *
 * At origin t (bars that open before t):
 *  - spot S = close of the hour ending at t.
 *  - (fH): ln sigma_fut(T) ~ [1, ln D, ln W, ln M], D/W/M = annualized Parkinson variance means over 24/168/720 h,
 *    OLS on every labelled origin i <= qs - T (qs = start of t's UTC quarter: one refit per quarter);
 *    sigma_H(t) = exp(x_t . coef). Standardized depths z_i = ln(min low (i, i+T] / S_i) / (sigma_H(i) sqrt(T/8760));
 *    p(k) = #{z_i <= ln(1+k) / (sigma_H(t) sqrt(T/8760))} / n  (filtered historical simulation).
 *  - (f): the same with the EWMA (half-life 336 h, 1,440 h warm-up) sigma; it replaces (fH) where sigma_H(t) is undefined.
 *  - (a): the training frequency of the depths (plain history).
 *  - running minimum over the level ladder. No Platt, no recalibration.
 * Quarters before the first quarter >= 365 days after the series start are not issued.
 */
import { HOUR, toFloat } from './series'
import type { PriceSeries } from './types'

const ANNUAL = 8760
const SIGMA_HALF_LIFE_H = 336
const SIGMA_WARMUP = 1440
const HAR_WINDOWS = [24, 168, 720] as const
const PARK = 1 / (4 * Math.log(2))
const NULL_FRAC = 0.05
const WARMUP_DAYS = 365
const DAY = 86400

export function maxNulls(T: number, frac = NULL_FRAC): number {
  return Math.floor(frac * T + 1e-9)
}

export function quarterStartTs(y: number, q: number): number {
  return Date.UTC(y, 3 * (q - 1), 1) / 1000
}

export function quarterOf(ts: number): { y: number; q: number; startTs: number; name: string } {
  const d = new Date(ts * 1000)
  const y = d.getUTCFullYear()
  const q = Math.floor(d.getUTCMonth() / 3) + 1
  return { y, q, startTs: quarterStartTs(y, q), name: `${y}Q${q}` }
}

/** a3_touch.first_quarter_after */
export function firstQuarterAfter(firstTs: number, days: number): { y: number; q: number } {
  const lim = firstTs + days * DAY
  let y = new Date(firstTs * 1000).getUTCFullYear()
  let q = 1
  while (quarterStartTs(y, q) < lim) {
    if (q < 4) q++
    else { y++; q = 1 }
  }
  return { y, q }
}

/** Upper-bound binary search: #{v in sorted <= x} (numpy searchsorted side="right"). */
function countLE(sorted: Float64Array, x: number): number {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (sorted[mid] <= x) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** 4x4 linear solve, Gaussian elimination with partial pivoting (np.linalg.solve). null when singular. */
function solve4(A: number[][], b: number[]): number[] | null {
  const n = 4
  const M = A.map((r, i) => [...r, b[i]])
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r
    if (M[p][c] === 0 || !Number.isFinite(M[p][c])) return null
    if (p !== c) { const t = M[p]; M[p] = M[c]; M[c] = t }
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c]
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]
    }
  }
  const x = new Array(n).fill(0)
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n]
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k]
    x[r] = s / M[r][r]
  }
  return x.every(Number.isFinite) ? x : null
}

interface HorizonPrep {
  T: number
  scale: number
  labOk: Uint8Array
  depth: Float64Array
  /** labelled & finite HAR design & finite ln sigma_fut */
  okH: Uint8Array
  /** cumulative sums of X'X (10 unique entries) and X'y, and the row count */
  cumXtX: Float64Array // (N+1) x 10
  cumXty: Float64Array // (N+1) x 4
  cumNH: Int32Array
  folds: Map<number, FoldPrep | null>
}

interface FoldPrep {
  qsIdx: number
  coef: number[] | null
  nReg: number
  zH: Float64Array // sorted training z under sigma_H
  zF: Float64Array // sorted training z under the EWMA sigma
  depth: Float64Array // sorted training depths (plain history)
}

const PAIRS: [number, number][] = []
for (let a = 0; a < 4; a++) for (let b = a; b < 4; b++) PAIRS.push([a, b])

/** Everything the model derives from one series, cached; valid for any origin inside the series. */
export class FhSeriesModel {
  readonly id: string
  readonly startTs: number
  readonly N: number
  readonly close: Float64Array
  readonly low: Float64Array
  readonly high: Float64Array
  /** spot[i] = close[i-1] (length N+1) */
  readonly spot: Float64Array
  /** EWMA sigma at origins 0..N */
  readonly sigma: Float64Array
  /** HAR design rows ln D, ln W, ln M at origins 0..N (NaN where undefined) */
  readonly har: Float64Array // (N+1) x 3
  readonly okX: Uint8Array
  private horizons = new Map<number, HorizonPrep>()
  private wmins = new Map<number, Float64Array>()

  constructor(s: PriceSeries) {
    this.id = s.id
    this.startTs = s.startTs
    this.N = s.close.length
    this.close = toFloat(s.close)
    this.low = toFloat(s.low)
    this.high = toFloat(s.high)
    const N = this.N
    this.spot = new Float64Array(N + 1)
    this.spot[0] = NaN
    for (let j = 0; j < N; j++) this.spot[j + 1] = this.close[j]
    this.sigma = ewmaSigma(this.close)
    this.har = new Float64Array((N + 1) * 3)
    this.okX = new Uint8Array(N + 1)
    const v = parkinsonV(this.high, this.low)
    HAR_WINDOWS.forEach((W, c) => {
      const m = windowMeanNullRule(v, W, 0)
      for (let i = 0; i <= N; i++) {
        const x = ANNUAL * m[i]
        this.har[i * 3 + c] = x > 0 ? Math.log(x) : NaN
      }
    })
    for (let i = 0; i <= N; i++) {
      this.okX[i] = Number.isFinite(this.har[i * 3]) && Number.isFinite(this.har[i * 3 + 1]) && Number.isFinite(this.har[i * 3 + 2]) ? 1 : 0
    }
  }

  /** Minimum non-null low over hours i .. i+T-1 at origins 0..N (null-hour rule), cached. */
  windowMin(T: number): Float64Array {
    let w = this.wmins.get(T)
    if (!w) { w = windowMinNullRule(this.low, T); this.wmins.set(T, w) }
    return w
  }

  originIndex(originTs: number): number {
    return (originTs - this.startTs) / HOUR
  }

  private horizon(T: number): HorizonPrep {
    let h = this.horizons.get(T)
    if (h) return h
    const N = this.N
    const wmin = this.windowMin(T)
    const labOk = new Uint8Array(N + 1)
    const depth = new Float64Array(N + 1).fill(NaN)
    for (let i = 0; i <= N; i++) {
      if (Number.isFinite(this.spot[i]) && Number.isFinite(wmin[i])) {
        labOk[i] = 1
        depth[i] = Math.log(wmin[i] / this.spot[i])
      }
    }
    const sfut = sigmaFut(this.close, T, 0)
    const okH = new Uint8Array(N + 1)
    const cumXtX = new Float64Array((N + 1) * 10)
    const cumXty = new Float64Array((N + 1) * 4)
    const cumNH = new Int32Array(N + 1)
    const acc = new Float64Array(10)
    const accy = new Float64Array(4)
    let cnt = 0
    const x = [1, 0, 0, 0]
    for (let i = 0; i <= N; i++) {
      const lf = Math.log(sfut[i])
      if (labOk[i] && this.okX[i] && Number.isFinite(lf)) {
        okH[i] = 1
        x[1] = this.har[i * 3]; x[2] = this.har[i * 3 + 1]; x[3] = this.har[i * 3 + 2]
        for (let p = 0; p < 10; p++) acc[p] += x[PAIRS[p][0]] * x[PAIRS[p][1]]
        for (let a = 0; a < 4; a++) accy[a] += x[a] * lf
        cnt++
      } else {
        // numpy adds the zeroed row: + 0.0 (identical value)
      }
      cumXtX.set(acc, i * 10)
      cumXty.set(accy, i * 4)
      cumNH[i] = cnt
    }
    h = { T, scale: Math.sqrt(T / ANNUAL), labOk, depth, okH, cumXtX, cumXty, cumNH, folds: new Map() }
    this.horizons.set(T, h)
    return h
  }

  private sigmaHAt(coef: number[] | null, i: number): number {
    if (!coef || !this.okX[i]) return NaN
    const v = Math.exp(coef[0] + this.har[i * 3] * coef[1] + this.har[i * 3 + 1] * coef[2] + this.har[i * 3 + 2] * coef[3])
    return v > 0 && Number.isFinite(v) ? v : NaN
  }

  private fold(h: HorizonPrep, qsIdx: number): FoldPrep | null {
    if (h.folds.has(qsIdx)) return h.folds.get(qsIdx) as FoldPrep | null
    const lim = Math.min(qsIdx - h.T, this.N)
    let out: FoldPrep | null = null
    if (lim > 0) {
      const nReg = h.cumNH[lim]
      let coef: number[] | null = null
      if (nReg >= 4) {
        const c = h.cumXtX.subarray(lim * 10, lim * 10 + 10)
        const A = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]
        PAIRS.forEach(([a, b], p) => { A[a][b] = c[p]; A[b][a] = c[p] })
        coef = solve4(A, Array.from(h.cumXty.subarray(lim * 4, lim * 4 + 4)))
      }
      const zH: number[] = []
      const zF: number[] = []
      const dd: number[] = []
      for (let i = 0; i <= lim; i++) {
        if (!h.labOk[i]) continue
        const d = h.depth[i]
        if (Number.isFinite(d)) dd.push(d)
        const sf = this.sigma[i]
        if (sf > 0) zF.push(d / (sf * h.scale))
        const sh = this.sigmaHAt(coef, i)
        if (sh > 0) zH.push(d / (sh * h.scale))
      }
      const srt = (a: number[]) => Float64Array.from(a).sort()
      out = { qsIdx, coef, nReg, zH: srt(zH), zF: srt(zF), depth: srt(dd) }
    }
    h.folds.set(qsIdx, out)
    return out
  }

  /**
   * raw (fH), (f) and (a) at one origin for one horizon over a level ladder (fractions, shallow -> deep).
   * Returns null with a reason when the reference would not issue a row.
   */
  predict(originTs: number, T: number, levels: number[]): FhPrediction | { error: string } {
    const i = this.originIndex(originTs)
    if (!Number.isInteger(i)) return { error: 'origin is not on the hourly grid' }
    if (i < 1 || i > this.N) return { error: 'origin outside the price series' }
    if (!Number.isFinite(this.spot[i])) return { error: 'no close in the hour before the origin' }
    let lastFinite = -1
    for (let j = i - 1; j >= 0 && j >= i - 30 * 24; j--) if (Number.isFinite(this.close[j])) { lastFinite = j; break }
    if (lastFinite < 0) return { error: 'no kline in the 30 days before the origin (delisted or halted)' }
    const qo = quarterOf(originTs)
    const fq = firstQuarterAfter(this.startTs, WARMUP_DAYS)
    if (qo.y < fq.y || (qo.y === fq.y && qo.q < fq.q)) {
      return { error: 'younger than the development fold rule (first quarter >= 365 d after the first kline)' }
    }
    const qsIdx = this.originIndex(qo.startTs)
    const h = this.horizon(T)
    if (qsIdx - T <= 0) return { error: `no training origin at ${T} h` }
    const f = this.fold(h, qsIdx)
    if (!f) return { error: `no training origin at ${T} h` }
    const sH = this.sigmaHAt(f.coef, i)
    const sF = this.sigma[i] > 0 ? this.sigma[i] : NaN
    const fhs = (z: Float64Array, s: number) => levels.map((k) => {
      const thr = Math.log1p(k) / (s * h.scale)
      if (z.length === 0 || !Number.isFinite(thr)) return NaN
      return countLE(z, thr) / z.length
    })
    let pH = fhs(f.zH, sH)
    const pF = fhs(f.zF, sF)
    const fallback = !pH.every(Number.isFinite)
    if (fallback) pH = pF
    if (!pH.every(Number.isFinite) || !pF.every(Number.isFinite)) return { error: `(fH)/(f) undefined at ${T} h` }
    const pA = levels.map((k) => countLE(f.depth, Math.log1p(k)) / Math.max(f.depth.length, 1))
    return {
      originTs, T, levels, spot: this.spot[i], quarter: qo.name,
      fH: runMin(pH), f: runMin(pF), a: runMin(pA), fallback,
      nTrain: fallback ? f.zF.length : f.zH.length, sigmaH: Number.isFinite(sH) ? sH : null,
      sigmaF: Number.isFinite(sF) ? sF : null, coef: f.coef,
    }
  }
}

export interface FhPrediction {
  originTs: number
  T: number
  levels: number[]
  spot: number
  quarter: string
  fH: number[]
  f: number[]
  a: number[]
  fallback: boolean
  nTrain: number
  sigmaH: number | null
  sigmaF: number | null
  coef: number[] | null
}

function runMin(p: number[]): number[] {
  const out = p.slice()
  for (let j = 1; j < out.length; j++) out[j] = Math.min(out[j], out[j - 1])
  return out
}

// ---------------------------------------------------------------------------------------------------------------
// series transforms (numpy semantics; origins 0..N, length N+1)
// ---------------------------------------------------------------------------------------------------------------

/** a2_touch.ewma_sigma: origin i uses returns r_m, m <= i-1. */
export function ewmaSigma(close: Float64Array): Float64Array {
  const n = close.length
  const out = new Float64Array(n + 1).fill(NaN)
  const lam = Math.pow(0.5, 1 / SIGMA_HALF_LIFE_H)
  let num = 0
  let den = 0
  let cnt = 0
  for (let m = 0; m < n; m++) {
    const r = m >= 1 ? Math.log(close[m] / close[m - 1]) : NaN
    const valid = Number.isFinite(r)
    num = (valid ? r * r : 0) + lam * num
    den = (valid ? 1 : 0) + lam * den
    if (valid) cnt++
    if (cnt >= SIGMA_WARMUP && den > 0) {
      const s = Math.sqrt(ANNUAL * num / den)
      out[m + 1] = s > 0 ? s : NaN
    }
  }
  return out
}

/** a3_touch.window_min_null_rule: min of non-null lows over hours i .. i+T-1. */
export function windowMinNullRule(low: Float64Array, T: number): Float64Array {
  const n = low.length
  const out = new Float64Array(n + 1).fill(NaN)
  if (n < T) return out
  const mx = maxNulls(T)
  // sliding minimum (monotone deque) over lows with nulls as +Infinity
  const dq = new Int32Array(n)
  let head = 0
  let tail = 0
  let nulls = 0
  for (let j = 0; j < n; j++) {
    const v = Number.isFinite(low[j]) ? low[j] : Infinity
    if (!Number.isFinite(low[j])) nulls++
    while (tail > head && (Number.isFinite(low[dq[tail - 1]]) ? low[dq[tail - 1]] : Infinity) >= v) tail--
    dq[tail++] = j
    const i = j - T + 1
    if (i < 0) continue
    if (dq[head] < i) head++
    if (i > 0 && !Number.isFinite(low[i - 1])) nulls--
    const m = Number.isFinite(low[dq[head]]) ? low[dq[head]] : Infinity
    if (nulls <= mx && Number.isFinite(m)) out[i] = m
  }
  return out
}

/** a6_touch.parkinson_v */
export function parkinsonV(high: Float64Array, low: Float64Array): Float64Array {
  const v = new Float64Array(high.length)
  for (let j = 0; j < high.length; j++) {
    const h = high[j]
    const l = low[j]
    v[j] = Number.isFinite(h) && Number.isFinite(l) && h > 0 && l > 0 && h >= l ? Math.log(h / l) ** 2 * PARK : NaN
  }
  return v
}

/** a6_touch.window_mean_null_rule: mean of non-null x[j], j = i-W .. i-1. */
export function windowMeanNullRule(x: Float64Array, W: number, startI: number): Float64Array {
  const n = x.length
  const out = new Float64Array(n + 1).fill(NaN)
  if (n < W) return out
  const cs = new Float64Array(n + 1)
  const cn = new Int32Array(n + 1)
  for (let j = 0; j < n; j++) {
    const f = Number.isFinite(x[j])
    cs[j + 1] = cs[j] + (f ? x[j] : 0)
    cn[j + 1] = cn[j] + (f ? 1 : 0)
  }
  const mx = maxNulls(W)
  for (let i = W; i <= n; i++) {
    const s = cs[i] - cs[i - W]
    const m = cn[i] - cn[i - W]
    if (W - m <= mx && m > 0 && i - W >= startI) out[i] = s / m
  }
  return out
}

/** a6_touch.sigma_fut: realized vol of the returns in hours i .. i+T-1 (annualized). */
export function sigmaFut(close: Float64Array, T: number, startI: number): Float64Array {
  const n = close.length
  const out = new Float64Array(n + 1).fill(NaN)
  if (n < T + 1) return out
  const cs = new Float64Array(n + 1)
  const cn = new Int32Array(n + 1)
  for (let j = 0; j < n; j++) {
    const r = j >= 1 ? Math.log(close[j] / close[j - 1]) : NaN
    const f = Number.isFinite(r)
    cs[j + 1] = cs[j] + (f ? r * r : 0)
    cn[j + 1] = cn[j] + (f ? 1 : 0)
  }
  const mx = maxNulls(T)
  for (let i = 1; i <= n - T; i++) {
    const s = cs[i + T] - cs[i]
    const m = cn[i + T] - cn[i]
    const val = Math.sqrt(ANNUAL * s / (m > 0 ? m : 1))
    if (T - m <= mx && m > 0 && i - 1 >= startI && val > 0) out[i] = val
  }
  return out
}
