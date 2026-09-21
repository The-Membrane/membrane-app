import { CURE_WINDOW_HOURS, MAX_THRESHOLD_TO_DELAY } from './membrane'

const BAND = `${(MAX_THRESHOLD_TO_DELAY * 100).toFixed(0)}%`
const LTV_SHIFT_CAP = 5;

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
    `You aren't liquidated when you cross the LLTV. Staying within ${BAND} of it delays your liquidation for ${CURE_WINDOW_HOURS} hours. Time to manage and protection from wicks. `,
    // , ` + 'by you or by the venue capital Membrane recalls first.',
  /** One sentence. The condition. Rendered next to the claim, never collapsed. */
  limit: `Past ${BAND} the liquidation is immediate, but only partially down to the maximum borrowable LTV.`,
  /**
   * The UX claim, and the only one on this surface that is not about liquidation.
   *
   * VERIFIED 2026-09-12 in membrane-solidity: there is NO per-change LTV cap and NO
   * 14-day delay on LTV. LTV is a live MBRN-stake ratio (LtvDisco.sol:1767-1782,
   * capped at the 90% hard cap) inside a per-asset [minLTV, maxLTV] band fixed once at
   * createQueue (LtvDisco.sol:868-878). The stake that moves it sits behind 7-day
   * unstaking / switching floors (Constants.sol:110-114). The 14d+2d timelock governs
   * config FIELDS, not the LTV number. An open position is liquidated against its
   * CACHED LTV until deposit/withdraw re-stamps it (Cdp.sol:2148, 4221-4229), but the
   * owner ruled that clause out of the copy. What IS fixed is the rate on drawn debt.
   */
  noDials:
    "LTV moves with MBRN voters with capital at-risk, on a 14 day notice, " +
    `at a max of ${LTV_SHIFT_CAP}% per window.`,
  provenance: `LiquidationEngine.sol · 28,800 s · break = max LTV × (1 + ${BAND}) · no mainnet deployment yet`,
} as const

/**
 * THE CARRY CLAIMS — comms/marketing claims list, owner, Sep 2026. One line each.
 *
 * Claim 1 is framed as SENIORITY, never impossibility: the spread can invert in a worst
 * case, and what the borrower gets is TIME. The 14 days of yield curators cover is the
 * owner's own figure (owner statement 2026-09-12) — it is the source for every instance
 * of that number on this surface (VerdictHero's carry line, FinePrint's CARRY_TERMS).
 * It replaces the vaguer "curators cover it first through required bonds", which named
 * a mechanism instead of the thing the borrower actually receives.
 */
export const CARRY_CLAIMS = [
  'Borrow cost comes out of the carry yield. If the spread inverts, curators cover 14 days of yield to give you time to act.',
  'No babysitting, no keeper to fail. Unwinds run in-house with no protocol fee.',
  'Your rate is set when you borrow. Any change to it comes with seven days’ notice — never a rate hike while you are trying to exit.',
] as const

/** Card titles, one per CARRY_CLAIMS entry, same order. ≤ 5 words. The fourth claim
 *  (recall vs rebalance fee) was REMOVED by the owner 2026-09-21 as incorrect. */
export const CARRY_CLAIM_TITLES = [
  'Paid from yield',
  'No keeper to fail',
  'Repricing on 7 days\' notice',
] as const

/** The caveat that rides with the claims, never collapsed. */
export const CARRY_CLAIMS_CAVEAT = 'Volatile collateral can still be liquidated.'
