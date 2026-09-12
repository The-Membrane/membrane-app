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

// ---------------------------------------------------------------- hero A/B

/**
 * WHICH PROOF LEADS THE HERO.
 *
 * Owner brief 2026-09-12, on the liquidation-history block: "test this as the hero as
 * well." So it is an A/B, not a replacement.
 *
 *   'oct10'    the measured Oct 10 2025 stress window — the counterfactual verdict the
 *              page has always led with. A claim about a day, on any wallet.
 *   'history'  the address's OWN liquidation history, replayed against the 8h window
 *              and the 4% band — a claim about events that actually happened to it.
 *
 * The 'history' hero is NEVER allowed to print a zero or an empty state: with no saved
 * dollars, or while the scan is still in flight, it falls back to the Oct 10 verdict.
 * A hero that says "$0" is worse than the hero it replaced.
 */
export type HeroVariant = 'oct10' | 'history'

/** THE DEFAULT. One line to flip the whole site to the history hero. */
export const HERO_VARIANT: HeroVariant = 'oct10'

/**
 * `?hero=history` / `?hero=oct10` override, so the A/B can be run by LINK without a
 * deploy. Anything else falls back to HERO_VARIANT — a typo must not blank the hero.
 */
export function resolveHeroVariant(query: unknown): HeroVariant {
  const raw = Array.isArray(query) ? query[0] : query
  return raw === 'history' || raw === 'oct10' ? raw : HERO_VARIANT
}
