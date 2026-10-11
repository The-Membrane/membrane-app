/**
 * The scout's fine print, in one client-safe place: the page renders it from here, and the
 * scan stamps the same lines into each weekly file for the audit trail. Copy rules: never
 * 0%, $0 or "free" for Membrane's charge; positive carry is the spread measured at the scan.
 * How venue APYs are formed is not here: each weekly file carries its own `venueApyRule`
 * (lib/carryScan/venueApy.ts VENUE_APY_RULE), so an older snapshot is described as it was built.
 */
export const CARRY_SCAN_NOTES = [
  'Ethereum stables only · not exhaustive · hover, focus or tap a venue APY to see every source behind it.',
  'DeFiLlama’s borrow-rate history (chartLendBorrow) is a paid endpoint, so the 30-day check is the pool’s 30-day mean APY minus this week’s benchmark.',
  '(b) Membrane carry has no borrow term: debt deployed in a canonical venue is paid for with a curator-set share of that venue’s yield, not a borrow rate. With no curator share given it is an upper bound.',
  'Positive carry means the spread measured at this scan, never a promise.',
] as const
