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

export interface GovernanceChangeConfig {
  /** An event keeps the rule raised this long (after a ramp reaches its target). */
  windowS: number
  /** A threshold cut is warn when the projected health factor is below this line. */
  warnHf: number
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
  governanceChange: GovernanceChangeConfig | null
  /**
   * The R27 "3% rule" (at risk / act now) for the borrower channel. Optional so configs
   * written before it keep compiling; absent = AT_RISK_RULE. null = off. See atRisk.ts.
   */
  atRisk?: AtRiskConfig | null
  /** Health factor the "what to do" line in a message aims for. */
  targetHf: number
}

/**
 * The "3% rule" (board RULING Q26-R27 60fb0e6, REVIEW c59f67f; knowledge page
 * q26-ui-confidence-map.md, "Borrower alerts").
 *
 *   at risk   the oracle price that liquidates (Membrane: the deployed Oracle.getPrice;
 *             elsewhere the venue's own oracle, CollateralInput.oraclePriceUsd) is within
 *             `threshold` of the position's liquidation price. One alert per episode.
 *   act now   SPOT (CollateralInput.marketPriceUsd) is at or through the liquidation line.
 *             No promise of warning time.
 *   re-arm    the episode ends when the position is more than `rearmDistance` from the line,
 *             the borrower adds collateral or repays, or the position is liquidated.
 *
 * Distance for several collateral legs is the uniform price drop of every non-stable leg
 * (stables held) that reaches the line: the k* rule of r111v5_labels.py on branch
 * research/history-forecasts. Not used for stable/PT loops: CORRELATED_LOOP_HF covers them.
 *
 * Measured on DEVELOPMENT data only (Aave V3 Polygon, 2023–2026). Replace the numbers here
 * and in AT_RISK_SUBTEXT_CONFIG from the live alert logs and from R29 (Membrane's
 * liquidation timer) when those land.
 */
export interface AtRiskConfig {
  /** At risk when distance to the liquidation price is at or below this, 0–1. */
  threshold: number
  /** Episode re-arms once distance is above this, 0–1. */
  rearmDistance: number
  /** The rule must be evaluated at least this often (seconds). */
  evaluationIntervalS: number
}

export const AT_RISK_RULE: AtRiskConfig = {
  // R27: 3% of the liquidation price, oracle basis.
  threshold: 0.03,
  // R27: re-arm after the position moves more than 10% away.
  rearmDistance: 0.1,
  // R27: checked at least hourly.
  evaluationIntervalS: H,
}

/**
 * Subtext under the at-risk alert, in-app and in the dry-run message. A template plus the
 * numbers it fills, so the numbers can be swapped after review without touching copy.
 *
 * The figures are from DEVELOPMENT data, not live outcomes: Aave V3 Polygon, 2023–2026,
 * board RULING Q26-R27 60fb0e6 and REVIEW c59f67f (median lead 8 h; about 74% of oracle
 * touches warned at least 1 h ahead, 90% interval 0.60–0.87; about 1 in 4 got under 1 h).
 * Update them from the live alert logs and from R29 (Membrane's liquidation timer; under
 * review). Never add a probability, and never promise a fixed time to act (no "you have
 * 8 hours": a further oracle drop past the timer's line liquidates at once).
 */
export interface AtRiskSubtextConfig {
  /** {medianLeadH} and {caughtShare} are filled from the fields below. */
  template: string
  medianLeadH: number
  /** Plain-words share, e.g. '3 in 4'. Kept as words so no percentage reads as a probability. */
  caughtShare: string
  provenance: {
    data: 'development' | 'live'
    dataset: string
    ruling: string
    review: string
    warnedAtLeast1hShare: number
    updateFrom: readonly string[]
  }
}

export const AT_RISK_SUBTEXT_CONFIG: AtRiskSubtextConfig = {
  // Copy as corrected by the R31 review (board 769f616): three chains, "touches" not
  // "liquidations", median lead about 10 h on Arbitrum and Optimism (13 h on Polygon).
  template:
    'Past data: alerts at this level came a median of {medianLeadH} hours before liquidation, ' +
    'and about {caughtShare} simulated price touches got at least an hour of warning. Some come ' +
    'faster, so act now if you can.',
  medianLeadH: 10,
  caughtShare: '2 in 3',
  provenance: {
    data: 'development',
    dataset: 'Aave V3 Polygon, Arbitrum, Optimism and Ethereum, 2023–2026 (simulated price touches)',
    ruling: 'Q26-R27 60fb0e6; replications Q26-R30 1f76bc9, Q26-R31 4d6d6a0 and Q26-R33 0bc1946',
    review: 'c59f67f, f6092e8, 57653f4, 769f616',
    warnedAtLeast1hShare: 0.7,
    updateFrom: ['live alert logs', 'R29 (Membrane liquidation timer)'],
  },
}

export function atRiskSubtext(c: AtRiskSubtextConfig = AT_RISK_SUBTEXT_CONFIG): string {
  return c.template
    .replace('{medianLeadH}', String(c.medianLeadH))
    .replace('{caughtShare}', c.caughtShare)
}

/** The rendered at-risk subtext (kept for callers that want the string). */
export const AT_RISK_SUBTEXT = {
  text: atRiskSubtext(),
  provenance: AT_RISK_SUBTEXT_CONFIG.provenance,
} as const

/**
 * Membrane liquidation timer (R29, review board f6092e8). Membrane liquidates on a 1-hour
 * average oracle price. Below the liquidation price P anyone can start an 8-hour timer; below
 * the immediate price X = P / (1 + window) the position can be liquidated at once, timer or
 * not. `window` is CHAIN STATE; `launchWindow` is only the launch default used until a reader
 * supplies it (MarketContext.liquidationWindow). Copy must never state the window as a
 * percentage, never say "a further drop", and never say "you have 8 hours".
 */
export const MEMBRANE_LIQUIDATION = {
  oracleAverageS: H,
  timerS: 8 * H,
  launchWindow: 0.04,
} as const

/**
 * Line-crossing / act-now explainer for Membrane positions (R29 review f6092e8). {P} is the
 * liquidation price, {X} the immediate-liquidation price; the {X} sentence is dropped when
 * X is unknown.
 */
export const ACT_NOW_EXPLAINER = {
  oracle:
    'Membrane uses a 1-hour average oracle price, which can lag the market. If it falls below ' +
    'your liquidation price ({P}), anyone can start an 8-hour liquidation timer.',
  immediate: 'If it falls below {X}, you can be liquidated at once, timer or not.',
  history: 'Past liquidations often came well before the 8 hours ended.',
} as const

/**
 * Post-recovery state (R29 review f6092e8): the oracle is back above the line but a started
 * timer still runs. STUB: the clearRecoveredTimer action is a disabled placeholder until the
 * owner decides; no transaction is wired.
 */
export const RECOVERED_TIMER_COPY = {
  title: 'Repaying does not stop the timer. Clear it now.',
  action: { id: 'clearRecoveredTimer', label: 'Clear timer', enabled: false },
  note: 'Not available yet: awaiting an owner decision.',
} as const

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
  // Reports itself UNCOVERED until a market's governance source is wired. A threshold cut is
  // projected per position: critical below HF 1, warn below the 1.15 line (memo §8b).
  governanceChange: {
    windowS: 24 * H,
    warnHf: 1.15,
    spec: {
      direction: 'above',
      enter: { watch: 0.5, warn: 1.5, critical: 2.5 },
      band: 0,
      dwellS: 0,
      confirm: 1,
      cooldownS: 24 * H,
    },
  },
  atRisk: AT_RISK_RULE,
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
