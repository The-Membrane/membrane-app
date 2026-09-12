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
  provenance: `LiquidationEngine.sol · 28,800 s · break = max LTV × (1 + ${BAND}) · no mainnet deployment yet`,
} as const
