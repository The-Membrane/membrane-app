/**
 * Alert thresholds. DEFAULT_ALERT_CONFIG holds the values recommended by the back-test
 * (docs/research/POSITION-ALERTS-BACKTEST.md). Change a number here only with a re-run of
 * scripts/research/position-alert-backtest.ts that supports it.
 */

import type { LevelSpec } from './levels'
import type { Severity } from './types'

const H = 3600

/**
 * Lowest severity that should reach a phone. Watch fires on positions that live near the
 * 1.30 line (0.68 messages per position-month in the back-test), so it belongs in-app or
 * behind an opt-in; warn and critical are pushed.
 */
export const DEFAULT_PUSH_MIN_SEVERITY: Severity = 'warn'

export interface LiquidationDistanceConfig {
  /** 'sigma' scales the distance by trailing volatility; falls back to `spec` without a vol reading. */
  mode: 'static' | 'sigma'
  /** Static spec: value is the fraction of price the dominant collateral can lose. */
  spec: LevelSpec
  /** Sigma spec: value is ln(price / liquidationPrice) / (hourlyVol × √horizonH). */
  sigmaSpec: LevelSpec
  horizonH: number
}

export interface CushionBurnConfig {
  /** Trailing window over which the health-factor peak is taken. */
  lookbackS: number
  /** Positions at or above this health factor are not checked (their cushion is not thin). */
  maxHf: number
  /** Value: share of the cushion above 1.0 lost since the window peak, 0–1+. */
  spec: LevelSpec
}

export interface DepegConfig {
  stable: LevelSpec
  lst: LevelSpec
  /** Legs below this share of collateral value are not checked. */
  minShare: number
}

export interface ExitCapacityConfig {
  /** Price shock on market-priced collateral the recall must survive, 0–1. */
  shock: number
  /** Health factor the recall must restore after the shock. */
  targetHf: number
  /** Readings older than this are dropped. */
  maxAgeS: number
  /** Value: available exit USD / recall needed USD. */
  spec: LevelSpec
  /**
   * Capacity burn: share of the trailing peak exit capacity that is gone now (0–1). It warns
   * while capacity is still above the recall need, as a lock starts. null = off.
   */
  burn: { lookbackS: number; spec: LevelSpec } | null
}

export interface OracleChangeConfig {
  /** An event keeps the rule raised for this long. */
  windowS: number
  spec: LevelSpec
}

export interface AlertConfig {
  healthFactor: LevelSpec | null
  /** User-chosen LTV lines. Off by default: health factor already covers the venue's line. */
  ltv: LevelSpec | null
  liquidationDistance: LiquidationDistanceConfig | null
  cushionBurn: CushionBurnConfig | null
  depeg: DepegConfig | null
  exitCapacity: ExitCapacityConfig | null
  oracleChange: OracleChangeConfig | null
  /** Health factor the "what to do" line in a message aims for. */
  targetHf: number
}

export const DEFAULT_ALERT_CONFIG: AlertConfig = {
  healthFactor: {
    direction: 'below',
    enter: { watch: 1.3, warn: 1.15, critical: 1.05 },
    band: 0.03,
    dwellS: 2 * H,
    confirm: 1,
    cooldownS: 6 * H,
  },
  ltv: null,
  // Off by default: for one collateral leg, distance = 1 − 1/HF, so it repeats the
  // health-factor rule message for message. Every HF message already states the liquidation
  // price. Users who think in price can opt in with LIQUIDATION_DISTANCE_PRESET.
  liquidationDistance: null,
  // Critical only: half the cushion gone inside 6h is the fast-crash signal (Oct 10 2025).
  // A lower warn line doubled warn-level false alarms for little recall (memo §4).
  cushionBurn: {
    lookbackS: 6 * H,
    maxHf: 1.5,
    spec: {
      direction: 'above',
      enter: { critical: 0.5 },
      band: 0.1,
      dwellS: 2 * H,
      confirm: 1,
      cooldownS: 6 * H,
    },
  },
  depeg: {
    stable: {
      direction: 'above',
      enter: { watch: 50, warn: 150, critical: 500 },
      band: 20,
      dwellS: 2 * H,
      confirm: 2,
      cooldownS: 12 * H,
    },
    lst: {
      direction: 'above',
      enter: { watch: 100, warn: 250, critical: 600 },
      band: 30,
      dwellS: 2 * H,
      confirm: 2,
      cooldownS: 12 * H,
    },
    minShare: 0.05,
  },
  // Exit capacity and oracle change report themselves UNCOVERED until a measured-capacity
  // source and the oracle registry are wired. Neither has passed the external-alert gate
  // (no 30-day calm series; no registry to replay): keep them internal (memo §7–8).
  exitCapacity: {
    shock: 0.2,
    targetHf: 1.1,
    maxAgeS: 2 * H,
    spec: {
      direction: 'below',
      enter: { watch: 3, warn: 1.5, critical: 1 },
      band: 0.2,
      dwellS: 2 * H,
      confirm: 1,
      cooldownS: 12 * H,
    },
    // Off: CAPACITY_BURN_PRESET gave ~3h before the E3 lock but ~5 warn+ per month on calm
    // Aave Core USDC (memo §7).
    burn: null,
  },
  oracleChange: {
    windowS: 24 * H,
    spec: {
      direction: 'above',
      enter: { watch: 0.5, warn: 1.5, critical: 2.5 },
      band: 0,
      dwellS: 0,
      confirm: 1,
      cooldownS: 24 * H,
    },
  },
  targetHf: 1.3,
}

/**
 * Opt-in distance-to-liquidation-price rule. 'sigma' scales the distance by the asset's
 * trailing 24h volatility; it falls back to the static percentage lines with no vol reading.
 * Measured but not default (memo §3): about as efficient as the HF line on hourly history,
 * worse in the Oct 10 crash (hourly vol lags a one-hour crash), blind in Aug 2026 PT-reUSD.
 */
export const LIQUIDATION_DISTANCE_PRESET: LiquidationDistanceConfig = {
  mode: 'sigma',
  horizonH: 24,
  spec: {
    direction: 'below',
    enter: { watch: 0.25, warn: 0.15, critical: 0.07 },
    band: 0.02,
    dwellS: 2 * H,
    confirm: 1,
    cooldownS: 6 * H,
  },
  sigmaSpec: {
    direction: 'below',
    enter: { watch: 3, warn: 2, critical: 1 },
    band: 0.25,
    dwellS: 2 * H,
    confirm: 1,
    cooldownS: 6 * H,
  },
}

/**
 * Health-factor lines for correlated loops: a USD-yielding or PT collateral against a USD
 * debt, with a liquidation line near 0.9 (Morpho LLTV 0.915, Aave e-mode). These loops LIVE
 * at HF 1.01–1.10, so the default 1.30 / 1.15 / 1.05 lines fire on most of them in calm
 * conditions. Measured on the Recall Coverage Dataset's pinned clusters (memo §1b): warn 1.02
 * warned all 20 E4 breaches before the breach (16 at the first read, the rest 11+ minutes
 * ahead) and 2 of 2 in E1, while 11 of 214 E3 loops got a warn (0.086 per position-month)
 * against 145 under the default lines. Opt-in per position, not the default: the thresholds
 * were chosen on the same events they were measured on.
 */
export const CORRELATED_LOOP_HF: LevelSpec = {
  direction: 'below',
  enter: { watch: 1.05, warn: 1.02, critical: 1.01 },
  band: 0.005,
  dwellS: 2 * H,
  confirm: 1,
  cooldownS: 6 * H,
}

/**
 * Exit-capacity burn: share of the trailing 6h peak capacity gone. Measured, not default
 * (memo §7): on the spec's E3 venue (Aave Core USDC) it warned 2.95h before the full lock,
 * ahead of the cover ratio, but it raised about 5 warn+ messages per month across 27 calm
 * months of the same venue. Opt-in: { ...exitCapacity, burn: CAPACITY_BURN_PRESET }.
 */
export const CAPACITY_BURN_PRESET: NonNullable<ExitCapacityConfig['burn']> = {
  lookbackS: 6 * H,
  spec: {
    direction: 'above',
    enter: { watch: 0.3, warn: 0.5, critical: 0.8 },
    band: 0.1,
    dwellS: 2 * H,
    confirm: 1,
    cooldownS: 12 * H,
  },
}

/** A user's own LTV lines, e.g. ltvLines({ warn: 0.7, critical: 0.78 }). */
export function ltvLines(enter: LevelSpec['enter']): LevelSpec {
  return { direction: 'above', enter, band: 0.01, dwellS: 2 * H, confirm: 1, cooldownS: 6 * H }
}
