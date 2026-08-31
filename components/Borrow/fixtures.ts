/**
 * Mock/reference data ported from public/proto/borrow.html's inline <script>
 * blocks (WALLET :215-219, oracle O map + ADAPTER_BULLETS/TWAP_BULLETS
 * :558-591). Wallet-scoped fields are demo fixtures under useDemoMode;
 * oracle-card copy is protocol-scoped reference text, stamped `mock` until a
 * live source is wired (see the header comment in the proto: the assets
 * named here must be actually wired on Oracle.sol before this page ships
 * publicly — docs/GAME_LAUNCH_PLAN.md P3).
 */
import type { CollateralAsset, OracleCardEntry } from './types'

/** CDT borrow rate today, %/yr — moves with protocol conditions. */
export const RATE = 4.2

/** Demo wallet's postable collateral. B = borrow cap, M = liquidation line, both LTV fractions. */
export const WALLET: CollateralAsset[] = [
  { sym: 'WBTC', bal: 0.42, px: 115200, dp: 4, yld: 0.0, B: 0.6, M: 0.73, vol: 0.343 },
  { sym: 'wstETH', bal: 2.6, px: 4310, dp: 3, yld: 3.0, B: 0.63, M: 0.75, vol: 0.42 },
  { sym: 'sUSDS', bal: 12400, px: 1.0, dp: 0, yld: 6.5, B: 0.83, M: 0.86, vol: 0.006 },
]

const TIMELOCK =
  'Three numeric risk params (fallback window, max deviation, breaker threshold) sit behind a <b class="mut">14-day timelock</b>; listing powers <b class="mut">die permanently at renounceOwnership()</b>. The circuit breaker is permissionless — deviation math, not a key.'
const NOSIG =
  'No committee reports this price: <b class="not">no signer set or multisig attestation exists</b> anywhere in the oracle stack — only pool math.'

const ADAPTER_SUMMARY =
  'Priced as the vault’s own share rate × the underlying’s on-chain Uniswap TWAP. No Chainlink anywhere in this stack — feeds that cannot stand alone are barred from being primary.'
const ADAPTER_BULLETS = [
  'The vault’s <b class="does">share rate does affect</b> the price — instantly on the way down, growth-capped on the way up (max-yield-per-second clamp; under-pricing collateral is the safe direction).',
  'The underlying’s <b class="does">1-hour Uniswap TWAP does affect</b> the price.',
  'The wrapper’s own <b class="not">market quote does not affect</b> it — the oracle reads the vault’s exchange rate, not a pool price of the wrapper.',
  'The price <b class="does">can float above $1</b> as yield accrues — adapter assets are deliberately exempt from the USD-par clamp.',
  NOSIG,
  TIMELOCK,
]

const TWAP_SUMMARY =
  'Two-tier Uniswap V3 TWAP: a 1-hour window primary, and a 10-minute read of the same pool as fallback. If both fail, the price REVERTS — borrows halt rather than running on a stale number.'
const TWAP_BULLETS = [
  'The pool’s <b class="does">1h TWAP does affect</b> your liquidation line; the fallback is a <b class="does">shorter read of the same pool</b> — never a number someone typed.',
  'A <b class="not">stale price is never served</b>: both windows failing halts pricing (PriceStale) instead of freezing a value.',
  'Both tiers readable but diverging beyond the deviation cap also <b class="not">refuses to price</b> (OracleSourcesDisagree).',
  NOSIG,
  TIMELOCK,
]

/** Shared provenance line rendered at the foot of every oracle card. */
export const ORACLE_PROVENANCE =
  'Sources: Oracle.sol · Adapter4626Base.sol · OracleTemplateFactory.sol · AUTONOMOUS-ORACLE-RISK-REGISTER.md (membrane-solidity, read Aug 26 2026 — line numbers drift, the code is the truth). Written to the best of our ability; for exact behavior, read the oracle code itself.'

/**
 * Oracle info-card content, keyed by symbol — ported from the proto's `O`
 * map. Only the assets the Borrow wallet actually offers (WBTC, wstETH,
 * sUSDS) are included; the proto's PT/scenario-chart entry is out of scope
 * here since no PT asset appears in this page's wallet fixtures.
 */
export const ORACLE_CARDS: Record<string, OracleCardEntry> = {
  sUSDS: {
    sym: 'sUSDS',
    tag: { variant: 'med', label: 'medium (AOR-3/5 · share-rate)' },
    summary: ADAPTER_SUMMARY,
    bullets: ADAPTER_BULLETS,
  },
  WBTC: {
    sym: 'WBTC',
    tag: { variant: 'med', label: 'medium (AOR-2 · route depth)' },
    summary: TWAP_SUMMARY,
    bullets: [
      ...TWAP_BULLETS,
      'Register’s live residual for TWAP assets: <b class="mut">thin or self-created pools</b> (AOR-2, medium) — no minimum-liquidity floor exists on autonomous routes today.',
    ],
  },
  wstETH: {
    sym: 'wstETH',
    tag: { variant: 'med', label: 'medium (AOR-2 · route depth)' },
    summary: TWAP_SUMMARY,
    bullets: TWAP_BULLETS,
  },
}
