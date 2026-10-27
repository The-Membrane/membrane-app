/**
 * Sizing-panel math and the history counts behind it (board ruling Q26-S1).
 *
 * HISTORY, not a forecast: the counts are non-overlapping windows since Sep 2017 in
 * which the Binance hourly low fell at least d below the prior close within H days
 * (review-corrected; see data/drawdownHistory.json `source` and
 * scripts/build-drawdown-history.mjs). Nothing here predicts the next window.
 *
 * Rules this module enforces:
 * - A count is quoted at the borrower's own distance ROUNDED DOWN to the counted grid
 *   (15/20/25/30/40%), so the quoted fall is never deeper than the line distance.
 * - No percentage is derived from a count (the confidence map forbids it).
 * - Context odds exist only as a typed seam: no live D12 feed is wired in the app, so
 *   `CONTEXT_ODDS_FEED` is null and the panel shows no number.
 */
import history from './data/drawdownHistory.json'

export type Underlying = 'ETH' | 'BTC'
export type HorizonDays = 1 | 7 | 30

export const HORIZONS: readonly HorizonDays[] = [1, 7, 30]
/** Fall levels the history counts cover, in whole percent, ascending. */
export const HISTORY_LEVELS: readonly number[] = history.levels
export const HISTORY_SOURCE = history.source

export interface UnderlyingInfo {
  underlying: Underlying
  /** True when the posted asset is a wrapper whose line is shown as an underlying-price equivalent. */
  wrapper: boolean
  /** Basis note for a wrapper; null for the underlying itself. */
  basis: string | null
}

const UNDERLYING_BY_SYM: Record<string, UnderlyingInfo> = {
  ETH: { underlying: 'ETH', wrapper: false, basis: null },
  WETH: { underlying: 'ETH', wrapper: false, basis: null },
  BTC: { underlying: 'BTC', wrapper: false, basis: null },
  wstETH: {
    underlying: 'ETH',
    wrapper: true,
    basis:
      'wstETH is priced as its stETH share rate × ETH. The line is shown as the ETH price at the same % drop; this assumes the wstETH/ETH rate holds. The history is ETH/USDT, not wstETH, and does not include a stETH discount.',
  },
  WBTC: {
    underlying: 'BTC',
    wrapper: true,
    basis:
      'WBTC is priced off BTC. The line is shown as the BTC price at the same % drop; this assumes WBTC stays at 1:1. The history is BTC/USDT, not WBTC, and does not include a depeg.',
  },
}

/** Which price history applies to a posted asset, or null when none does (e.g. a stable vault share). */
export function underlyingFor(sym: string): UnderlyingInfo | null {
  return UNDERLYING_BY_SYM[sym] ?? null
}

/**
 * Fraction the collateral price must fall for the position's LTV to reach the
 * liquidation line M: debt / (value × (1 − d)) = M  ⇒  d = 1 − LTV / M. Clamped to [0, 1].
 */
export function liquidationDistance(ltvPercent: number, line: number): number {
  if (!(line > 0)) return 0
  const d = 1 - ltvPercent / 100 / line
  return Math.min(1, Math.max(0, d))
}

/** Collateral price at which LTV reaches the line: px × (1 − d). */
export function liquidationPrice(px: number, ltvPercent: number, line: number): number {
  return px * (1 - liquidationDistance(ltvPercent, line))
}

/** Whole-percent distance, rounded DOWN (a 16.9% distance reads as 16%). */
export function distancePercentFloor(distance: number): number {
  return Math.floor(distance * 100 + 1e-9)
}

/**
 * The deepest counted level at or below the distance (rounded DOWN to the grid), or
 * null when the line is closer than the shallowest counted level.
 */
export function gradedLevel(
  distance: number,
  levels: readonly number[] = HISTORY_LEVELS,
): number | null {
  const pct = distance * 100 + 1e-9
  let best: number | null = null
  for (const l of levels) if (l <= pct) best = l
  return best
}

export interface HistoryCount {
  underlying: Underlying
  horizonDays: HorizonDays
  /** The fall level the count is quoted at, whole percent. */
  levelPct: number
  /** Non-overlapping windows since Sep 2017 with a fall of at least `levelPct` within the horizon. */
  windows: number
  /**
   * True when the line is closer than the shallowest counted level: the count is then
   * quoted at that level, and every one of those falls would have passed the line.
   */
  lineCloserThanGrid: boolean
}

type CountTable = Record<string, Record<string, Record<string, number>>>

/** History count at the borrower's own distance rounded down to the counted grid. */
export function historyCount(
  underlying: Underlying,
  horizonDays: HorizonDays,
  distance: number,
): HistoryCount {
  const graded = gradedLevel(distance)
  const levelPct = graded ?? HISTORY_LEVELS[0]
  const windows = (history.counts as CountTable)[underlying][String(horizonDays)][String(levelPct)]
  return { underlying, horizonDays, levelPct, windows, lineCloserThanGrid: graded === null }
}

export interface StressLine {
  id: string
  /** e.g. 'Mar 2020' */
  label: string
  /** Worst fall inside the horizon from that event, whole percent (display). */
  dropPct: number
  /** True when a repeat of that fall would reach the line. Uses the unrounded drop. */
  reachesLine: boolean
}

type StressTable = Record<
  string,
  Record<string, { id: string; label: string; drop: number; dropPct: number }[]>
>

/** Named worst drops (Mar 2020, Aug 2024, Oct 2025) for one horizon, tested against the line distance. */
export function stressLines(
  underlying: Underlying,
  horizonDays: HorizonDays,
  distance: number,
): StressLine[] {
  return (history.stress as StressTable)[underlying][String(horizonDays)].map((e) => ({
    id: e.id,
    label: e.label,
    dropPct: e.dropPct,
    reachesLine: e.drop >= distance,
  }))
}

/** Borrow cost of `debt` over `days` at `ratePercent` per year (simple accrual). */
export function carryCost(debt: number, ratePercent: number, days: number): number {
  return (debt * ratePercent * days) / 100 / 365
}

// ---------------------------------------------------------------------------
// Context odds seam (7 d only). Confidence map, ETH/BTC 7 d: −10% and −15% are
// CALIBRATED-WARN, −20% is labelled context. Odds are quoted AT the graded level,
// never as a recommendation.
// ---------------------------------------------------------------------------

export type ContextOddsClass = 'calibrated-warn' | 'context'

export interface ContextOddsLevel {
  levelPct: 10 | 15 | 20
  cls: ContextOddsClass
  /** The class label the confidence map requires beside the number. */
  label: string
}

export const CONTEXT_ODDS_LEVELS: readonly ContextOddsLevel[] = [
  {
    levelPct: 10,
    cls: 'calibrated-warn',
    label: 'calibrated, not proven better than alternatives',
  },
  {
    levelPct: 15,
    cls: 'calibrated-warn',
    label: 'calibrated, not proven better than alternatives',
  },
  { levelPct: 20, cls: 'context', label: 'context · not a warning' },
]

/** The 7 d odds level the borrower's distance rounds down to, or null when closer than 10%. */
export function contextOddsLevel(distance: number): ContextOddsLevel | null {
  const pct = distance * 100 + 1e-9
  let best: ContextOddsLevel | null = null
  for (const l of CONTEXT_ODDS_LEVELS) if (l.levelPct <= pct) best = l
  return best
}

/** One live D12 issue for one cell (raw (fH), Binance-input). */
export interface ContextOdds {
  underlying: Underlying
  horizonDays: 7
  levelPct: ContextOddsLevel['levelPct']
  /** Probability the Binance hourly low touches −levelPct within 7 days, 0..1. */
  probability: number
  /** ISO time of the D12 issue the number comes from (stamped `source · fetched HH:MM`). */
  issuedAt: string
  source: string
}

/** Reads the latest live D12 issue for an underlying. */
export type ContextOddsFeed = (underlying: Underlying) => Promise<ContextOdds[]>

/**
 * OPEN SEAM: no live D12 feed exists in the app. Until one is wired (a new surface
 * feed, per the S1 README), this stays null and the panel shows no odds number.
 */
export const CONTEXT_ODDS_FEED: ContextOddsFeed | null = null
