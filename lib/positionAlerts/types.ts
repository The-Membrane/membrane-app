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
  | 'twap_changed'
  | 'cap_changed'
  | 'discount_changed'
  | 'quorum_changed'
  | 'upgrade'
  | 'paused'
  | 'price_frozen'

/**
 * One oracle-configuration change. oracleRegistry.ts adapts the registry's change events
 * (feat/oracle-registry) into these and detects frozen prices from an oracle path.
 */
export interface OracleChangeEvent {
  /** Asset symbol the oracle prices. */
  asset: string
  oracle: string
  kind: OracleChangeKind
  /** Epoch seconds. */
  ts: number
  detail: string
  source: string
  /**
   * Direction-aware severity set by the adapter (a raised PT discount is worse than a lowered
   * one). Absent: ORACLE_CHANGE_SEVERITY[kind].
   */
  severity?: Severity
}

/**
 * What a venue's governance changed. A change of the market's own rules moves health factor
 * or the borrower's options with no price move: Euler cut liquidation LTVs on Nov 3 2025 and
 * liquidated a position at HF 1.06 by setting its LTV to 0 on Nov 4 (memo §1b).
 */
export type GovernanceChangeKind =
  /** Liquidation threshold set or ramped to a new value. Severity is projected per position. */
  | 'liquidation_threshold_changed'
  /** Collateral no longer counts: liquidation threshold set to 0, or the token removed. */
  | 'collateral_disabled'
  /** Repay, withdraw or liquidation stopped. The borrower cannot act. */
  | 'paused'
  /** No new supply or borrow, or the token is being wound down. Repay still works. */
  | 'frozen'
  | 'liquidation_bonus_changed'
  | 'rate_model_changed'
  | 'governor_changed'
  /** The market or credit manager gets an end date. */
  | 'expiry_set'

/** One governance change. governance.ts adapts Euler, Gearbox and Aave v3 events into these. */
export interface GovernanceChangeEvent {
  /** Market the change applies to: Euler borrow vault, Gearbox credit manager, Aave pool. */
  market: string
  /** Collateral or reserve symbol it touches. Absent: the whole market. */
  asset?: string
  kind: GovernanceChangeKind
  /** Epoch seconds. */
  ts: number
  detail: string
  source: string
  /** liquidation_threshold_changed: thresholds 0–1, and when a ramp reaches `to`. */
  threshold?: { from?: number; to: number; fullAtTs?: number }
  /** Severity fixed by the adapter. Absent: projected per position (governance.ts). */
  severity?: Severity
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
  /** Governance changes of the position's market (any age; the rule windows them). */
  governanceEvents?: GovernanceChangeEvent[]
  /**
   * False when no governance source is wired for the market. A market whose rules cannot
   * change (Morpho Blue, Silo v2) is covered with no events.
   */
  governanceEventsCovered?: boolean
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
