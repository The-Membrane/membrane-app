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
 *  - the band value: per-asset `max_threshold_to_delay`; 4% is the owner's LAUNCH
 *    parameter — the repo registration default is 95e16 (Collateral.sol:213), so the
 *    launch listing must set 4e16 for this copy to be true on mainnet.
 *  - window length: DEFAULT_LIQUIDATION_DELAY_S = 28800 (:322), timelock-governed.
 *  - after: the repay target restores the borrow line, not the whole position.
 *
 * Every sentence below must stay true to those lines. Change the code, change this.
 */
export const GUARANTEE = {
  name: `${BAND}.`,
  claim:
    `Cross the liquidation line on Membrane and nothing is sold — as long as the position stays within ${BAND} ` +
    `above the line. Inside that band you have ${CURE_WINDOW_HOURS} hours to cure it: by you, or by the venue ` +
    'capital Membrane recalls first. And when a sale does happen, it is only enough to restore the borrow ' +
    'line, never the whole position.',
  /** The condition. Rendered next to the claim, never collapsed. */
  limit:
    `The ${CURE_WINDOW_HOURS} hours are not the guarantee; the ${BAND} is. Climb more than ${BAND} past the line and ` +
    'the window is broken: the sale is immediate, at the same fee. The simulator applies this break.',
  provenance:
    `LiquidationEngine.sol · window 28,800 s (timelocked) · break line = max LTV × (1 + ${BAND}) · ${BAND} is the ` +
    'launch listing parameter, not yet a mainnet value — a rule in code, not a promise from a person.',
} as const
