/**
 * The scout's fine print, in one client-safe place: the page renders it from here, and the
 * scan stamps the same lines into each weekly file for the audit trail. Copy rules: never
 * 0%, $0 or "free" for Membrane's charge; positive carry is the spread measured at the scan.
 */
export const CARRY_SCAN_NOTES = [
  'Ethereum stables only · not exhaustive · reported numbers are DeFiLlama’s.',
  'DeFiLlama’s borrow-rate history (chartLendBorrow) is a paid endpoint, so the 30-day check is the pool’s 30-day mean APY minus this week’s benchmark.',
  'Vault APYs (MetaMorpho, Morpho Vault V2, other ERC-4626) are DeFiLlama’s reported figures; supply-queue aggregation is out of scope for v1.',
  '(b) Membrane carry has no borrow term: debt deployed in a canonical venue is paid for with a curator-set share of that venue’s yield, not a borrow rate. With no curator share given it is an upper bound.',
  'Positive carry means the spread measured at this scan, never a promise.',
] as const
