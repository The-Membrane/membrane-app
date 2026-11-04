/**
 * FORECAST ENGINE — public types (lane Q41). This file is the stable contract the landing page codes
 * against. Add fields; do not rename or remove them.
 *
 * What the engine forecasts: the touch probability P(min hourly low within the horizon <= spot x (1 + level)),
 * "raw (fH)" of the Q26 research (membrane-board knowledge/q26-ui-confidence-map.md). The registry decides,
 * per cell (asset group x horizon x level), what the UI may show. Horizons are NOT tied to the 8 h delay:
 * any horizon the registry lists is reachable, and new cells appear when the registry data changes.
 *
 * Units used everywhere:
 * - timestamps: unix SECONDS, UTC.
 * - levelPct / lineDistancePct: NEGATIVE percent of spot, e.g. -10 = "a 10% fall".
 * - horizonH: hours.
 */

/** Asset groups of the confidence map. */
export type AssetGroup = 'eth_btc' | 'large_cap' | 'altcoin' | 'young_listing' | 'steth'

/**
 * Confidence classes of the map. RECALIBRATE = informative but miscalibrated with no validated repair:
 * it shows no probability (same as the canonical router, liqwarn/router.py).
 */
export type CellClass =
  | 'SKILL'
  | 'CALIBRATED_WARN'
  | 'CALIBRATED'
  | 'RECALIBRATE'
  | 'PENDING'
  | 'SCENARIO'
  | 'HISTORY_COUNT'
  | 'DO_NOT_SHOW'

export type MonitorStatus = 'deployed' | 'missing' | 'none'

/** What the UI may render for a cell. */
export type Display = 'probability' | 'count' | 'none'

/** One registry row: one asset group x horizon x level. */
export interface ForecastCell {
  /** `${group}:${horizonH}h:${levelPct}` */
  id: string
  group: AssetGroup
  horizonH: number
  /** negative percent, e.g. -10 */
  levelPct: number
  /** The class the UI acts on (after the live-monitor rule: a warning class without a deployed monitor is CALIBRATED). */
  class: CellClass
  /** The class graded in the map, before the live-monitor rule. */
  gradedClass: CellClass
  /** Required UI label for this class (empty when nothing is shown). */
  label: string
  /** Map section, rule id and evidence pointer. */
  source: string
  /** Model the class was graded for: raw (fH), or the frozen C3 recalibration (not ported: shows nothing). */
  model: 'raw_fH' | 'recal_fH' | null
  /** Live calibration monitor covering the cell: deployed, missing (needed but not deployed) or none. */
  monitor: { id: string | null; status: MonitorStatus }
  /** Date (YYYY-MM-DD) of the governing source (map or routing table generation). */
  asOf: string
  /** May drive a warning / trigger. Only SKILL and CALIBRATED_WARN with a deployed monitor. */
  trigger: boolean
  /** Extra caveat the UI must render next to the number (or null). */
  caveat: string | null
}

/** How an app asset maps to a forecast series and a group. */
export interface AssetSpec {
  /** App-side symbol, e.g. "ETH", "WETH", "wstETH". */
  symbol: string
  group: AssetGroup | null
  /** Price series id the engine reads (e.g. "ETHUSDT"), or null when no series is available. */
  series: string | null
  /** How the asset's oracle price relates to the series. */
  basis: 'spot' | 'wrap-rate' | 'none'
  note: string
}

/** Near-line limit (R23 ruling): line-relative odds at these horizons and distances stay hidden. */
export interface NearLineRule {
  minHorizonH: number
  maxHorizonH: number
  /** Distances whose |levelPct| is <= this are "near the line". */
  maxAbsLevelPct: number
  reason: string
  source: string
}

export interface Registry {
  schema: 'membrane-forecast-registry/1'
  version: string
  generatedAt: string
  /** sha256 of the confidence map the cells came from. */
  mapSha256: string
  routingTableVersion: string
  model: { id: 'raw_fH'; definition: string; source: string }
  horizonsH: number[]
  levelsPct: number[]
  cells: ForecastCell[]
  nearLine: NearLineRule
  assets: AssetSpec[]
  labels: Record<CellClass, string>
  /**
   * Commit time (ISO) of the live D12 monitor flags (d12/classes.json) synced into this registry. When it is missing
   * or older than 3 days, the engine fails closed: every CALIBRATED_WARN cell displays as CALIBRATED, no trigger.
   */
  monitorAsOf?: string
  monitorSource?: { path: string; sha256: string; lastLedgerDate: string | null; downgraded: string[] }
}

/**
 * Hourly OHLC series. Bar j opens at startTs + 3600 * j. A missing hour is null (never forward-filled).
 * Forecasts at origin t read only bars that open before t.
 */
export interface PriceSeries {
  /** Series id, e.g. "ETHUSDT". */
  id: string
  /** Where the bars come from, e.g. "binance:spot:1h". */
  source: string
  startTs: number
  close: ArrayLike<number | null>
  low: ArrayLike<number | null>
  high: ArrayLike<number | null>
  /** When the newest bars were fetched (ISO), for the "source · fetched HH:MM" stamp. */
  fetchedAt?: string
}

/** "fell this far within T, K times since YEAR" (never a percentage). */
export interface HistoryCount {
  /** Declustered episodes: an origin whose next horizonH hours touched the level; after an episode the scan skips horizonH hours. */
  k: number
  /** Number of disjoint horizon-length windows scanned. Context only: the UI must NOT divide k by n. */
  n: number
  /** Year of the first scanned origin, e.g. "2017". */
  since: string
  horizonH: number
  levelPct: number
  firstTs: number
  lastTs: number
  seriesId: string
}

export type Purpose =
  /** The level is the user's liquidation-line distance (default; the near-line limit applies). */
  | 'line'
  /** A plain price-move statement, not tied to a position line. */
  | 'price'

export interface TouchOptions {
  purpose?: Purpose
  /** Override the registry (tests, research builds). */
  registry?: Registry
  /** Year floor for history counts (default: the whole series). */
  countSinceTs?: number
  /** Wall clock for the monitor-freshness check (ms; default Date.now()). */
  nowMs?: number
}

export interface TouchResult {
  /** Probability, only when display === 'probability'. */
  p: number | null
  /** The registry cell (null when the asset, horizon or level has no cell). */
  cell: ForecastCell | null
  display: Display
  /** Label the UI must render with the value. */
  label: string
  /** Why nothing (or only a count) is shown. */
  reason: string | null
  count?: HistoryCount
  /** The model origin actually used: asOfTs floored to the hour. */
  originTs: number
  /** Spot at the origin (close of the hour ending at the origin), when known. */
  spot: number | null
  /** The raw (fH) value was replaced by (f) because sigma_H was undefined at the origin. */
  fallback?: boolean
  /** Model internals, for audits. */
  model?: { quarter: string; nTrain: number; sigmaH: number | null; sigmaF: number | null }
}

export interface ReachRow {
  horizonH: number
  /**
   * 'inside'  the line lies inside the displayable level range at this horizon (p is the line-cell probability
   *           when the line sits on a registry level, otherwise the probability of the nearest shallower
   *           displayable level, an UPPER bound for the line).
   * 'beyond'  the line is deeper than every displayable level at this horizon (history count, or nothing).
   * 'none'    nothing displayable at this horizon.
   */
  status: 'inside' | 'beyond' | 'none'
  /** Deepest displayable level at this horizon (the range edge), or null. */
  edgePct: number | null
  /** Shallowest displayable level at this horizon, or null. */
  shallowPct: number | null
  /** The cell whose value is shown (nearest displayable level at or shallower than the line). */
  result: TouchResult | null
  /** true when result.p is for a level shallower than the line (an upper bound for touching the line). */
  isUpperBound: boolean
  count?: HistoryCount
  reason: string | null
}

export interface ReachResult {
  asset: string
  originTs: number
  lineDistancePct: number
  rows: ReachRow[]
  /** Set when spot is already at or through the line: "act now", no probability (R27 / R12.7). */
  throughLine: boolean
  reason: string | null
}
