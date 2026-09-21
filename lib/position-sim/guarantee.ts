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
   * The UX claim, and the only one on this surface that is not about liquidation.
   *
   * SOURCE: docs/LTV-CHANGE-PARITY-AUDIT.md (membrane-solidity, 2026-09-21). Verified on
   * master 10626e40: the max LTV is capped at listing and the cap is immutable
   * (Collateral.sol `LtvCapImmutable` in updateAsset; 90% default, ≤ 96%); a DECREASE has
   * no notice period today (LTV_SWITCHING_PERIOD_S is declared and never read;
   * executeLowerLTVMove only deletes an intent and emits; the auction slash and the
   * supply-floor cliff are instant); stake does NOT move the LTV (queryAverageLTV is an
   * MBRN/VT ratio that saturates at the cap unless backers are slashed); createQueue has
   * zero callers, so there is no band below the cap. No per-change magnitude cap exists
   * in the port OR in committed Rust — never claim a step, bps/day, or a band.
   *
   * AFTER the ruled 14-day decrease delay lands (board 2026-09-20, unbuilt as of
   * 2026-09-21), switch to: "…and can never be raised above that cap; any decrease takes
   * 14 days to go live." Not before it merges.
   */
  noDials:
    "Your rate is fixed at open. Each asset's max LTV is capped at listing and can never be " +
    'raised above that cap; today a decrease has no notice period.',
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
  'Your rate is set when you borrow. It moves in one case: your curator vault is repriced to the avoidance rate, the AUM-weighted rate of the lowest-paying vaults. A curator can change the yield split with seven days’ notice.',
  'A recall carries no protocol fee, against a swap-and-rebalance bill every time a keeper adjusts you.',
] as const

/** The caveat that rides with the claims, never collapsed. */
export const CARRY_CLAIMS_CAVEAT = 'Volatile collateral can still be liquidated.'
