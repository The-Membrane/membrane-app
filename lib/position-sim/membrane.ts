/**
 * Membrane's liquidation engine, as applied to an arbitrary multi-asset position.
 *
 * WHAT IS REAL HERE, AND WHAT IS NOT — read before changing anything:
 *
 * REAL (verified against contract source, cited inline):
 *   - the partial-repay formula                 LiquidationEngine.sol:2204-2238
 *   - the 8-hour cure window (28800 s)          liquidation-engine/src/contract.rs:52
 *   - the 3pp borrow/liquidation LTV gap        lib/Constants.sol:26-30
 *   - the 90% max-LTV hard cap                  lib/Constants.sol:23
 *   - recall-from-venues BEFORE selling          LiquidationEngine.sol:924-928
 *
 * MODELLED (no source of truth exists yet — say so on screen):
 *   - the per-asset max LTV for ETH, BTC, etc. There is NO Membrane EVM mainnet
 *     deployment (config/evm/chains.ts targets local anvil only) and no committed
 *     mainnet LTV configuration anywhere in membrane-core or membrane-solidity.
 *     The defaults in MEMBRANE_ASSET_LTV are ours, and every one is stamped
 *     'modelled'. They must be presented as an assumption the user can change,
 *     never as protocol state.
 *   - the venue recall rate. It is the dominant variable and it is an input.
 */

import { stamp, type Provenance } from './types'

// ---------------------------------------------------------------- constants

/** 3pp. `max_borrow_LTV = max_LTV - BORROW_LTV_GAP`. Real: lib/Constants.sol:30. */
export const BORROW_LTV_GAP = 0.03

/** 90% ceiling on any asset's max LTV. Real: lib/Constants.sol:23. */
export const MAX_LTV_HARD_CAP = 0.9

/** The cure window in seconds. Real: liquidation-engine/src/contract.rs:52 —
 *  `liquidation_delay: msg.liquidation_delay.unwrap_or(28800)`. */
export const CURE_WINDOW_SECONDS = 28_800

export const CURE_WINDOW_HOURS = CURE_WINDOW_SECONDS / 3600 // 8

export const MEMBRANE_CONSTANTS_PROVENANCE: Provenance = stamp(
  'onchain',
  'membrane contract source',
  'BORROW_LTV_GAP + MAX_LTV_HARD_CAP from lib/Constants.sol:23,30; cure window 28800s from liquidation-engine/src/contract.rs:52; partial-repay formula from LiquidationEngine.sol:2204-2238',
)

/**
 * MODELLED per-asset max (liquidation) LTV.
 *
 * These are NOT read from a deployment — none exists. They are a stated assumption,
 * capped by the real MAX_LTV_HARD_CAP, and the UI exposes them as an editable input.
 * Do not present any of these as a protocol parameter.
 */
export const MEMBRANE_ASSET_LTV: Record<string, number> = {
  WETH: 0.8,
  ETH: 0.8,
  wstETH: 0.78,
  weETH: 0.75,
  rETH: 0.75,
  stETH: 0.78,
  WBTC: 0.75,
  cbBTC: 0.75,
  tBTC: 0.7,
  USDC: 0.87,
  USDT: 0.87,
  DAI: 0.87,
  sDAI: 0.85,
  USDe: 0.8,
  sUSDe: 0.78,
  LINK: 0.65,
}

export const MEMBRANE_LTV_PROVENANCE: Provenance = stamp(
  'modelled',
  'modelled — no Membrane mainnet deployment',
  'Membrane has no EVM mainnet deployment, so no live per-asset max LTV exists to read. These are our assumptions, capped at the real 90% MAX_LTV_HARD_CAP. Editable in the UI.',
)

/** The liquidation line for an asset, or null if we have no assumption for it. */
export function membraneMaxLtv(symbol: string): number | null {
  const v = MEMBRANE_ASSET_LTV[symbol]
  if (v === undefined) return null
  return Math.min(v, MAX_LTV_HARD_CAP)
}

/** The borrow cap sits a fixed 3pp under the liquidation line. */
export function membraneBorrowLtv(maxLtv: number): number {
  return Math.max(0, maxLtv - BORROW_LTV_GAP)
}

// ------------------------------------------------------------ partial repay

/**
 * How much debt VALUE a Membrane partial liquidation repays.
 *
 * This is the Solidity implementation, which deliberately DIVERGES from the Rust:
 *
 *   Solidity  repay = loan × (L − B) / (L × (1 − B))     LiquidationEngine.sol:2222-2238
 *   Rust      repay = loan × (L − B) /  L                cdp/src/liquidations.rs:474-483
 *
 * The `/(1 − B)` factor accounts for the collateral that LEAVES with the repay. The
 * Solidity comment records why the faithful port was abandoned: it "under-repays 5× at
 * B=0.8", which CosmWasm self-heals over repeated keeper calls but Solidity turns into
 * a hard revert via `_assertPositionSolventPostOp`.
 *
 * The simulator targets the EVM product, so it uses the Solidity form. Note that
 * lib/gauntlet-engine/core.ts `repayNeeded` still implements the RUST form — that is
 * the game's engine and is deliberately left alone.
 *
 * @param loanValueUsd  total debt value
 * @param collValueUsd  total collateral value after the price move
 * @param borrowLtv     B — the borrow cap to restore to
 * @returns debt value to repay, clamped to (0, loanValueUsd]
 */
export function membraneRepayValue(
  loanValueUsd: number,
  collValueUsd: number,
  borrowLtv: number,
): number {
  if (loanValueUsd <= 0) return 0
  if (collValueUsd <= 0) return loanValueUsd
  const L = loanValueUsd / collValueUsd
  if (L >= 1) return collValueUsd // underwater: repay against ALL collateral value
  if (L <= borrowLtv) return 0 // still under the cap: nothing to do
  const denomB = borrowLtv < 1 ? 1 - borrowLtv : 1
  let frac = ((L - borrowLtv) / L) / denomB
  if (frac > 1) frac = 1
  return frac * loanValueUsd
}

/**
 * The same call under a FULL-REPAYMENT engine, for the side-by-side. Most lending
 * markets repay a close-factor share of the whole loan rather than restoring to a cap.
 */
export function fullRepayValue(loanValueUsd: number, closeFactor: number): number {
  return Math.max(0, Math.min(1, closeFactor)) * loanValueUsd
}

// ------------------------------------------------------------------- recall

export interface VenueRecall {
  /** Share of deployed value that returns when asked. The dominant variable. */
  recallRate: number
  /** Share of deployed value that can arrive INSIDE the 8h cure window. */
  fastRate: number
  /** Value currently deployed to venues, in USD. */
  deployedUsd: number
  provenance: Provenance
}

export interface RecallOutcome {
  /** USD the venues actually returned against the call. */
  recalledUsd: number
  /** USD the venues could return inside the cure window. */
  fastUsd: number
  /** USD the call still wants after the recall. This is what hits collateral. */
  shortfallUsd: number
  /** True if fast capital alone covered the call — cured, nothing sold. */
  cured: boolean
}

/**
 * Membrane recalls liquid value from deployment venues BEFORE touching collateral —
 * `_step1_5_venueRecall` runs between debt accrual and collateral assessment
 * (LiquidationEngine.sol:924-928). Only the shortfall reaches the collateral.
 */
export function applyRecall(neededUsd: number, venue: VenueRecall | null): RecallOutcome {
  if (!venue || venue.deployedUsd <= 0 || neededUsd <= 0) {
    return { recalledUsd: 0, fastUsd: 0, shortfallUsd: Math.max(0, neededUsd), cured: false }
  }
  const available = venue.deployedUsd * clamp01(venue.recallRate)
  const fast = venue.deployedUsd * clamp01(venue.fastRate)
  const recalled = Math.min(available, neededUsd)
  return {
    recalledUsd: recalled,
    fastUsd: fast,
    shortfallUsd: Math.max(0, neededUsd - recalled),
    cured: fast >= neededUsd,
  }
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

/** Collateral-weighted Membrane liquidation line for a basket. Returns null when any
 *  asset has no modelled LTV — we refuse to guess rather than substitute a default. */
export function weightedMembraneLine(
  legs: { symbol: string; valueUsd: number }[],
): { maxLtv: number; borrowLtv: number; unknown: string[] } {
  let num = 0
  let den = 0
  const unknown: string[] = []
  for (const leg of legs) {
    const m = membraneMaxLtv(leg.symbol)
    if (m === null) {
      unknown.push(leg.symbol)
      continue
    }
    num += m * leg.valueUsd
    den += leg.valueUsd
  }
  const maxLtv = den > 0 ? num / den : 0
  return { maxLtv, borrowLtv: membraneBorrowLtv(maxLtv), unknown }
}
