/**
 * FORECAST ENGINE — public entry (lane Q41).
 *
 *   touchProbability(asset, asOfTs, horizonH, levelPct, series, opts?)  one cell, gated by its class
 *   whatCanWeSay(asset, asOfTs, series, opts?)                          every displayable cell at a moment, any horizon
 *   reach(asset, nowTs, lineDistancePct, series, opts?)                 per displayable horizon: is the line inside the shown range
 *   historyCount(series, asOfTs, horizonH, levelPct, opts?)             "fell this far within T, K times since YEAR"
 *
 * Series: loadCommittedSeries / decodeCompactSeries (public/data/forecast/<SYMBOL>-1h.json) and appendKlines for
 * the live tail (pages/api/forecast/klines). Timestamps are unix seconds; levels are negative percent.
 */
export * from './types'
export { touchProbability, whatCanWeSay, reach, historyCount, modelFor, originOf } from './engine'
export { defaultRegistry, parseRegistry, resolveAsset, findCell, cellsFor, gate, isNearLine, PROBABILITY_CLASSES } from './registry'
export { decodeCompactSeries, appendKlines, seriesEndTs, HOUR } from './series'
export type { CompactSeries, BinanceKline } from './series'
export { FhSeriesModel } from './fh'
export type { FhPrediction } from './fh'
export { loadSeries, fetchKlineTail, FORECAST_SYMBOLS, BINANCE_KLINES } from './live'
export type { ForecastSymbol } from './live'
