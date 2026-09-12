/**
 * WHICH SIMULATOR THE COLD VISITOR LANDS ON.
 *
 * Owner ruling 2026-09-12: "Keep this build as a toggle flip in case we want to go back
 * to borrower-first — or a separate page." So it is both. Two routes exist and both are
 * indexable; ONE constant decides which one `/` sends a stranger to, and which one the
 * nav's single "Simulator" item points at.
 *
 * The two modes are the same simulator with a different LEAD:
 *   - 'carry'    the bill comes first — what the source protocol charges a deployed
 *                carry per year, with the liquidation verdict as the second reason.
 *                Membrane is paid out of the venue's yield, never a fixed 0%.
 *   - 'borrower' the safety verdict is ALWAYS the headline. The carry cost, when the
 *                wallet on screen even has one, drops to the secondary line.
 *
 * Flipping LANDING_SIM_MODE is the whole revert. Nothing else needs to move.
 */

export type SimMode = 'carry' | 'borrower'

/**
 * THE FLIP. One line to go back to carry-first.
 *
 * Owner layout ruling 2026-09-12: ONE landing page — "the sim is borrows, while under the
 * fold is carries". So the borrower build leads: the hero SELLS carry in its subhead and
 * PROVES the rails with the borrow verdict; CarrySection sells the carry product with its
 * own live evidence directly under the fold; the CTA repeats at the foot. The carry-first
 * page stays live, indexable and one constant away.
 */
export const LANDING_SIM_MODE: SimMode = 'borrower'

/** Chain-relative route for each mode. Prefix with `/${chain}` to navigate. */
export const SIM_ROUTE: Record<SimMode, string> = {
  carry: '/carry-simulator',
  borrower: '/simulator',
}

/** The mode a given route serves — the inverse of SIM_ROUTE. */
export const OTHER_MODE: Record<SimMode, SimMode> = {
  carry: 'borrower',
  borrower: 'carry',
}

/** The one-line link each page carries to its sibling, at the foot of the page. */
export const SIM_MODE_LINK_LABEL: Record<SimMode, string> = {
  carry: 'carry-first version →',
  borrower: 'borrower-first version →',
}
