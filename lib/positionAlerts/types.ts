/**
 * Shared types for the position-alert rule engine.
 *
 * The engine is pure: a snapshot of one position plus a market context goes in, alerts and
 * the next tracker state come out. No I/O, no clock reads, no delivery. Delivery is a
 * separate, dry-run-only formatter (telegram.ts) — personal alerts must not reuse the
 * radar alarm sender (scripts/lib/notify.mjs, scripts/lib/telegramBot.mjs).
 *
 * Time is epoch SECONDS everywhere in this module.
 */

export type Severity = 'watch' | 'warn' | 'critical'

/** 0 = clear. 1..3 = watch, warn, critical. */
export type Level = 0 | 1 | 2 | 3

export const SEVERITIES: readonly Severity[] = ['watch', 'warn', 'critical']
export const levelOf = (s: Severity): Level => (SEVERITIES.indexOf(s) + 1) as Level
export const severityOf = (l: Level): Severity | null => (l === 0 ? null : SEVERITIES[l - 1])

/**
 * How the VENUE prices a collateral asset. This decides whether a market move can
 * liquidate the position at all:
 *   market        the oracle follows the market price (Chainlink ETH/USD, a pool TWAP)
 *   exchangeRate  the oracle uses a redemption/wrap rate (Aave wstETH, CAPO LST feeds) —
 *                 a market depeg does not move health factor
 *   hardcoded     the oracle returns a constant (Stream xUSD markets, Nov 2025)
 */
export type OracleBasis = 'market' | 'exchangeRate' | 'hardcoded'

export type PegClass = 'stable' | 'lst'

/** What an asset should be worth: $1, or `rate` units of an underlying (stETH → ETH). */
export interface PegRef {
  class: PegClass
  /** 'USD' for stables, the underlying symbol for LSTs (e.g. 'ETH'). */
  underlying: string
  /** Units of underlying one unit of the asset redeems for. 1 for stables and stETH. */
  rate: number
}

export interface CollateralInput {
  symbol: string
  amount: number
  /** The price the venue's own oracle uses. Liquidation is decided on this. */
  oraclePriceUsd: number
  /** What the asset sells for. Defaults to oraclePriceUsd. */
  marketPriceUsd?: number
  /** Venue liquidation threshold, 0–1. */
  liquidationThreshold: number
  oracleBasis?: OracleBasis
  peg?: PegRef
}

export interface DebtInput {
  symbol: string
  amount: number
  priceUsd: number
}

export interface PositionSnapshot {
  id: string
  /** Epoch seconds of the observation. */
  ts: number
  /** Human label, e.g. 'Aave V3' or 'Morpho · PT-reUSD/USDC 91.5%'. */
  venue: string
  collateral: CollateralInput[]
  debt: DebtInput[]
}

/** Venue exit capacity, as a measured reading. See capacity.ts. */
export interface CapacityReading {
  venue: string
  /** USD that could leave the venue now (instant liquidity / cash / quoted exit). */
  availableUsd: number
  /** Epoch seconds of the reading. */
  asOf: number
  provenance: string
}

export type OracleChangeKind =
  | 'feed_replaced'
  | 'source_changed'
  | 'heartbeat_changed'
  | 'deviation_changed'
  | 'cap_changed'
  | 'paused'
  | 'price_frozen'

/** One oracle-configuration change. The registry that emits these is not built yet. */
export interface OracleChangeEvent {
  /** Asset symbol the oracle prices. */
  asset: string
  oracle: string
  kind: OracleChangeKind
  /** Epoch seconds. */
  ts: number
  detail: string
  source: string
}

/** Everything outside the position the rules may read. Every field is optional. */
export interface MarketContext {
  /** USD price of each peg underlying, e.g. { ETH: 2650 }. */
  underlyingUsd?: Record<string, number>
  /** Trailing realised volatility per collateral symbol: stdev of 1h log returns. */
  hourlyVol?: Record<string, number>
  /** Exit capacity of the venues the position would recall from. */
  capacity?: CapacityReading[]
  /** Oracle changes already observed (any age; the rule windows them). */
  oracleEvents?: OracleChangeEvent[]
  /** False when no oracle-change source is wired. The rule then reports itself uncovered. */
  oracleEventsCovered?: boolean
}

export type TransitionKind = 'fire' | 'escalate' | 'ease' | 'clear' | 'suppressed'

export interface Alert {
  positionId: string
  ruleId: string
  /** Sub-key inside a rule (a collateral symbol for depeg, a venue for capacity). */
  key: string
  transition: TransitionKind
  from: Level
  to: Level
  /** Severity of the new level, or of the level being left on ease/clear. */
  severity: Severity
  /** Highest level of the episode so far (on clear: of the episode that just ended). */
  peak: Level
  ts: number
  value: number
  /** The threshold that was crossed (enter threshold on fire/escalate, clear line on clear). */
  threshold: number
  title: string
  detail: string
  evidence: Record<string, number | string | null>
}
