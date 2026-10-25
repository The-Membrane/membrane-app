/**
 * FORECAST ENGINE — public entry (lane Q41). Interface first: these signatures are stable.
 * Implementation lands in follow-up commits on feat/forecast-engine; until then every call returns
 * display 'none' with a reason, so the landing page can code against the contract now.
 */
import type { PriceSeries, ReachResult, TouchOptions, TouchResult, HistoryCount } from './types'

export * from './types'

const PENDING = 'forecast engine pending (feat/forecast-engine interface-first commit)'

/** P(min low within horizonH <= spot x (1 + levelPct/100)) at asOfTs, gated by the registry cell class. */
export function touchProbability(
  asset: string,
  asOfTs: number,
  horizonH: number,
  levelPct: number,
  priceSeries: PriceSeries | null,
  opts: TouchOptions = {},
): TouchResult {
  void asset; void horizonH; void levelPct; void priceSeries; void opts
  return { p: null, cell: null, display: 'none', label: '', reason: PENDING, originTs: Math.floor(asOfTs / 3600) * 3600, spot: null }
}

/** Every cell the registry lets the UI show for this asset at asOfTs, any horizon. */
export function whatCanWeSay(asset: string, asOfTs: number, priceSeries: PriceSeries | null, opts: TouchOptions = {}): TouchResult[] {
  void asset; void asOfTs; void priceSeries; void opts
  return []
}

/** For each displayable horizon: is the user's liquidation line inside the shown level range, and the range edge. */
export function reach(asset: string, nowTs: number, lineDistancePct: number, priceSeries: PriceSeries | null, opts: TouchOptions = {}): ReachResult {
  void priceSeries; void opts
  return { asset, originTs: Math.floor(nowTs / 3600) * 3600, lineDistancePct, rows: [], throughLine: false, reason: PENDING }
}

/** "fell this far within T, K times since YEAR" from price history (counts only, never a percentage). */
export function historyCount(series: PriceSeries, asOfTs: number, horizonH: number, levelPct: number, opts: { sinceTs?: number } = {}): HistoryCount | null {
  void series; void asOfTs; void horizonH; void levelPct; void opts
  return null
}
