/** Exact windows within the stated linear / signed-floor model. No native or execution authority. */
export type ModeledTimeFraction = Readonly<{ numerator: string; denominator: string }>
export type ModeledMillisecondBounds = Readonly<{ lowerMs: number; upperMs: number }>
export type ModeledShortageWindow = Readonly<{
  exactStart: ModeledTimeFraction; exactEnd: ModeledTimeFraction; exactDuration: ModeledTimeFraction
  startIncluded: boolean; endIncluded: boolean
  startElapsedMs: ModeledMillisecondBounds; endElapsedMs: ModeledMillisecondBounds; modeledDurationMs: ModeledMillisecondBounds
  leftCensored: boolean; rightCensored: boolean; guaranteedDurationMs: null
}>
export type ModeledShortageWindows = Readonly<{
  status: 'modeled'
  adequacyWindow: { firstIntegerAdequateMs: number; lastIntegerAdequateMs: number } | null
  exactAdequacyWindow: { start: ModeledTimeFraction; end: ModeledTimeFraction } | null
  windows: readonly ModeledShortageWindow[]
  neverInsufficient: boolean; insufficientAtIssue: boolean; insufficientAtHorizon: boolean
  searchIterations: { cash: number; entitlement: number }
  assumption: 'repeat_source_anchored_linear_deltas_with_signed_floor_and_weak_prong_minimum'
  modeled: true; nativeAuthority: false; executionAuthority: false; actualHistoricalContinuousDuration: false
  measuredHistoryDuration: false; calibrated: false; continuousProof: false; guaranteedDurationMs: null
}>
export type ModeledShortageWindowsCensor = Readonly<{
  status: 'censored'; reason: 'projected_stock_uint256_overflow'; windows: null; adequacyWindow: null
  modeled: true; nativeAuthority: false; executionAuthority: false; actualHistoricalContinuousDuration: false
  measuredHistoryDuration: false; calibrated: false; continuousProof: false; guaranteedDurationMs: null
}>
export type ModeledShortageWindowsInput = Readonly<{
  currentIdleCashRaw: string; currentFullEaRaw: string; idleCashDeltaRaw: string; entitlementDeltaRaw: string
  sourceAgeMs: number; periodMs: number; horizonMs: number; requestedRaw: string; competingMRaw: string | null
}>
const MAX = (1n << 256n) - 1n
const FLAGS = Object.freeze({ modeled: true, nativeAuthority: false, executionAuthority: false, actualHistoricalContinuousDuration: false,
  measuredHistoryDuration: false, calibrated: false, continuousProof: false, guaranteedDurationMs: null } as const)
function own(x: unknown): x is Record<keyof ModeledShortageWindowsInput, unknown> {
  if (!x || typeof x !== 'object' || Array.isArray(x) || Object.getPrototypeOf(x) !== Object.prototype && Object.getPrototypeOf(x) !== null || Object.getOwnPropertySymbols(x).length) return false
  const keys = ['currentIdleCashRaw', 'currentFullEaRaw', 'idleCashDeltaRaw', 'entitlementDeltaRaw', 'sourceAgeMs', 'periodMs', 'horizonMs', 'requestedRaw', 'competingMRaw'], ds = Object.getOwnPropertyDescriptors(x)
  return Object.keys(ds).length === keys.length && keys.every(k => ds[k] && Object.hasOwn(ds[k], 'value') && ds[k].enumerable)
}
function integer(x: unknown, signed = false): bigint | null {
  if (typeof x !== 'string' || x.length > 79 || !(signed ? /^(0|-?[1-9][0-9]*)$/ : /^(0|[1-9][0-9]*)$/).test(x)) return null
  const n = BigInt(x); return n >= (signed ? -MAX : 0n) && n <= MAX ? n : null
}
const floor = (n: bigint, d: bigint) => n >= 0n ? n / d : -((-n + d - 1n) / d)
type Fraction = { n: bigint; d: bigint }
function fraction(n: bigint, d = 1n): Fraction {
  if (d < 0n) { n = -n; d = -d }
  let a = n < 0n ? -n : n, b = d
  while (b) { const r = a % b; a = b; b = r }
  return { n: n / a, d: d / a }
}
const compare = (a: Fraction, b: Fraction) => a.n * b.d - b.n * a.d
const jsonFraction = (x: Fraction): ModeledTimeFraction => ({ numerator: x.n.toString(), denominator: x.d.toString() })
const bounds = (x: Fraction): ModeledMillisecondBounds => ({ lowerMs: Number(x.n / x.d), upperMs: Number((x.n + x.d - 1n) / x.d) })
type Prong = { integerWindow: { first: number; last: number } | null; exactWindow: { start: Fraction; end: Fraction } | null; iterations: number }
/** floor(delta*u/D)>=K iff delta*u>=K*D, so the exact transition is rational. */
function prong(initial: bigint, delta: bigint, threshold: bigint, age: number, period: number, horizon: number): Prong {
  const at = (t: number) => initial + floor(delta * BigInt(age + t), BigInt(period)) >= threshold
  const zero = fraction(0n), end = fraction(BigInt(horizon))
  let iterations = 0, integerWindow: Prong['integerWindow'], exactWindow: Prong['exactWindow']
  if (delta === 0n) return { integerWindow: at(0) ? { first: 0, last: horizon } : null, exactWindow: at(0) ? { start: zero, end } : null, iterations }
  const boundary = fraction((threshold - initial) * BigInt(period) - delta * BigInt(age), delta)
  if (delta > 0n) {
    exactWindow = compare(boundary, end) > 0n ? null : { start: compare(boundary, zero) < 0n ? zero : boundary, end }
    if (!at(horizon)) integerWindow = null
    else {
      let lo = 0, hi = horizon
      while (lo < hi) { iterations++; const mid = Math.floor((lo + hi) / 2); if (at(mid)) hi = mid; else lo = mid + 1 }
      integerWindow = { first: lo, last: horizon }
    }
  } else {
    exactWindow = compare(boundary, zero) < 0n ? null : { start: zero, end: compare(boundary, end) > 0n ? end : boundary }
    if (!at(0)) integerWindow = null
    else {
      let lo = 0, hi = horizon
      while (lo < hi) { iterations++; const mid = Math.ceil((lo + hi) / 2); if (at(mid)) lo = mid; else hi = mid - 1 }
      integerWindow = { first: 0, last: lo }
    }
  }
  return { integerWindow, exactWindow, iterations }
}
export function buildModeledShortageWindows(value: unknown): ModeledShortageWindows | ModeledShortageWindowsCensor | null {
  try {
    if (!own(value)) return null
    const cash = integer(value.currentIdleCashRaw), ea = integer(value.currentFullEaRaw), dc = integer(value.idleCashDeltaRaw, true), de = integer(value.entitlementDeltaRaw, true), q = integer(value.requestedRaw), reserve = value.competingMRaw === null ? 0n : integer(value.competingMRaw)
    if (cash === null || ea === null || dc === null || de === null || q === null || q === 0n || reserve === null || !Number.isSafeInteger(value.sourceAgeMs) || Number(value.sourceAgeMs) < 0 || Number(value.sourceAgeMs) > 1800000 || !Number.isSafeInteger(value.periodMs) || Number(value.periodMs) <= 0 || !Number.isSafeInteger(value.horizonMs) || Number(value.horizonMs) < 1 || Number(value.horizonMs) > 7 * 86400000) return null
    const age = Number(value.sourceAgeMs), period = Number(value.periodMs), horizon = Number(value.horizonMs)
    const raw = (initial: bigint, delta: bigint, t: number) => initial + floor(delta * BigInt(age + t), BigInt(period))
    // Each prong is monotone. Endpoints cover the entire model's uint256 overflow risk.
    if ([raw(cash, dc, 0), raw(cash, dc, horizon), raw(ea, de, 0), raw(ea, de, horizon)].some(n => n > MAX)) return { status: 'censored', reason: 'projected_stock_uint256_overflow', windows: null, adequacyWindow: null, ...FLAGS }
    const c = prong(cash, dc, q + reserve, age, period, horizon), e = prong(ea, de, q, age, period, horizon)
    let adequacyWindow: ModeledShortageWindows['adequacyWindow'] = null, exact: Prong['exactWindow'] = null
    if (c.integerWindow && e.integerWindow) {
      const first = Math.max(c.integerWindow.first, e.integerWindow.first), last = Math.min(c.integerWindow.last, e.integerWindow.last)
      if (first <= last) adequacyWindow = { firstIntegerAdequateMs: first, lastIntegerAdequateMs: last }
    }
    if (c.exactWindow && e.exactWindow) {
      const start = compare(c.exactWindow.start, e.exactWindow.start) > 0n ? c.exactWindow.start : e.exactWindow.start
      const end = compare(c.exactWindow.end, e.exactWindow.end) < 0n ? c.exactWindow.end : e.exactWindow.end
      if (compare(start, end) <= 0n) exact = { start, end }
    }
    const windows: ModeledShortageWindow[] = [], zero = fraction(0n), end = fraction(BigInt(horizon))
    const retain = (start: Fraction, finish: Fraction, startIncluded: boolean, endIncluded: boolean, leftCensored: boolean, rightCensored: boolean) => {
      const duration = fraction(finish.n * start.d - start.n * finish.d, finish.d * start.d)
      windows.push({ exactStart: jsonFraction(start), exactEnd: jsonFraction(finish), exactDuration: jsonFraction(duration), startIncluded, endIncluded,
        startElapsedMs: bounds(start), endElapsedMs: bounds(finish), modeledDurationMs: bounds(duration), leftCensored, rightCensored, guaranteedDurationMs: null })
    }
    if (!exact) retain(zero, end, true, true, true, true)
    else {
      if (compare(exact.start, zero) > 0n) retain(zero, exact.start, true, false, true, false)
      if (compare(exact.end, end) < 0n) retain(exact.end, end, false, true, false, true)
    }
    const adequate = (t: number) => raw(cash, dc, t) >= q + reserve && raw(ea, de, t) >= q
    return { status: 'modeled', adequacyWindow, exactAdequacyWindow: exact ? { start: jsonFraction(exact.start), end: jsonFraction(exact.end) } : null,
      windows, neverInsufficient: windows.length === 0, insufficientAtIssue: !adequate(0), insufficientAtHorizon: !adequate(horizon), searchIterations: { cash: c.iterations, entitlement: e.iterations },
      assumption: 'repeat_source_anchored_linear_deltas_with_signed_floor_and_weak_prong_minimum', ...FLAGS }
  } catch { return null }
}
