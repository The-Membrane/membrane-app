import { CURE_WINDOW_HOURS, MAX_THRESHOLD_TO_DELAY } from './membrane'

const BAND = `${(MAX_THRESHOLD_TO_DELAY * 100).toFixed(0)}%`

/**
 * THE NAMED GUARANTEE. A guarantee described as a mechanism is a guarantee unsold —
 * so this names it, in one place, from verified contract facts only.
 *
 * Owner ruling 2026-09-11: THE 4% WINDOW is the guarantee. The 8 hours are NOT
 * guaranteed — they hold only while the position stays inside the band; break the
 * band and the timer is broken.
 *
 * Verified against membrane-solidity (feat/carry-usp-free-deployed-debt):
 *  - in-window: TimerStarted / SavedByDelay short-circuit before any seizure
 *    (LiquidationEngine.sol:893-908, :1394-1407) — a timer is armed, collateral is
 *    untouched.
 *  - the break: `aboveThreshold && hasTimer → BrokeWindow` (:1357), immediate sale at
 *    the same fee (:1479-1493); `_immediateThreshold = maxLtv + band × maxLtv` (:2165).
 *  - the band value: per-asset `max_threshold_to_delay` (Collateral.sol:48; same shape
 *    as the Rust cAsset field); a position's break line is the collateral-value-weighted
 *    average of its assets (Cdp.sol:3575). The deploy scripts set 4e16 on EVERY asset
 *    they register (DeployFullSystem.s.sol WETH_/LAUNCH_THRESHOLD_TO_DELAY,
 *    DeployLiquidationCore.s.sol ATOM_THRESHOLD_TO_DELAY). Only permissionless
 *    onboarding stamps 95e16 (Collateral.sol:213) — not a launch path.
 *  - window length: DEFAULT_LIQUIDATION_DELAY_S = 28800 (:322), timelock-governed.
 *  - after: the repay target restores the borrow line, not the whole position.
 *
 * Every sentence below must stay true to those lines. Change the code, change this.
 */
export const GUARANTEE = {
  name: `${BAND}.`,
  /** One sentence. The claim. */
  claim:
    `Cross the line and nothing is sold while you stay within ${BAND} of it — ${CURE_WINDOW_HOURS} hours to cure, ` +
    'by you or by the venue capital Membrane recalls first.',
  /** One sentence. The condition. Rendered next to the claim, never collapsed. */
  limit: `Past ${BAND} the sale is immediate, and only enough to restore the borrow line.`,
  /**
   * One sentence. The UX claim, and the only one on this surface that is not about
   * liquidation. Verbatim lead of docs/marketing/no-dials-usp.md — do not paraphrase
   * it and do not add a second sentence beside it.
   */
  noDials: 'Nobody can change the terms of your position after you open it.',
  provenance: `LiquidationEngine.sol · 28,800 s · break = max LTV × (1 + ${BAND}) · no mainnet deployment yet`,
} as const

/**
 * THE CARRY CLAIMS — comms/marketing claims list, owner, Sep 2026. One line each, no
 * numbers (the public bond-coverage figure is not published yet — do not invent one).
 * Claim 1 is framed as SENIORITY, never impossibility: the spread can invert in a
 * worst case; curator bonds eat it before the borrower does.
 */
export const CARRY_CLAIMS = [
  'Borrow cost comes out of the carry yield. If the spread inverts, curator bonds eat it before you do.',
  'No babysitting, no keeper to fail. Unwinds run in-house and take their fee from the debt, never your principal.',
  "A venue that blocks your exit can't reprice you. No Aave-style rate hike while you wait.",
  'A recall costs a fee on the debt — not a swap-and-rebalance bill every time a keeper adjusts you.',
] as const

/** The caveat that rides with the claims, never collapsed. */
export const CARRY_CLAIMS_CAVEAT = 'Volatile collateral can still be liquidated.'
