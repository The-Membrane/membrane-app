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
 *   - the 96% no-delay listing cap              lib/Constants.sol:32
 *   - recall-from-venues BEFORE selling          LiquidationEngine.sol:924-928
 *
 * MODELLED (no source of truth exists yet — say so on screen):
 *   - the per-asset max LTV for ETH, BTC, etc. There is NO Membrane EVM mainnet
 *     deployment (config/evm/chains.ts targets local anvil only). The defaults in
 *     MEMBRANE_ASSET_LTV are ours and stamped 'modelled' — they must be presented as an
 *     assumption the user can change, never as protocol state — EXCEPT the three launch
 *     stables, whose bootstrap max LTVs ARE in the deploy script (DEPLOY_LAUNCH_LTV:
 *     sUSDS 88%, syrupUSDC 86%, scrvUSD 86%, script/DeployFullSystem.s.sol:243-251).
 *   - the venue recall rate. It is the dominant variable and it is an input.
 */

import { hardCapFor, positionLtvCap } from './collateralClass'
import { stamp, type Provenance } from './types'

// ---------------------------------------------------------------- constants

/** 3pp. `max_borrow_LTV = max_LTV - BORROW_LTV_GAP`. Real: lib/Constants.sol:30. */
export const BORROW_LTV_GAP = 0.03

/** 90% ceiling on a DELAYED asset's max LTV, and 96% on a NO-DELAY listing's cap. Real:
 *  lib/Constants.sol:23 and :32. Defined in collateralClass.ts beside the class rule they
 *  decide, and re-exported here so every existing import keeps working. */
export { MAX_LTV_HARD_CAP, NO_DELAY_LTV_HARD_CAP } from './collateralClass'

/** The cure window in seconds. Real: liquidation-engine/src/contract.rs:52 —
 *  `liquidation_delay: msg.liquidation_delay.unwrap_or(28800)`. */
export const CURE_WINDOW_SECONDS = 28_800

export const CURE_WINDOW_HOURS = CURE_WINDOW_SECONDS / 3600 // 8

/**
 * THE 4% WINDOW — the guarantee. While a breached position stays within this band
 * above the liquidation line, nothing is sold for the cure window. Climb past it and
 * the timer is BROKEN: the sale is immediate (LiquidationEngine.sol:1357 BrokeWindow),
 * at the same fee. Real: `_immediateThreshold = maxLtv + band × maxLtv`
 * (LiquidationEngine.sol:2165-2167); band = per-asset `max_threshold_to_delay`.
 *
 * 4% is what the deploy scripts set for EVERY asset they register
 * (script/DeployFullSystem.s.sol WETH_THRESHOLD_TO_DELAY / LAUNCH_THRESHOLD_TO_DELAY
 * = 4e16, "uniform 4%/8h window"; DeployLiquidationCore.s.sol ATOM_THRESHOLD_TO_DELAY
 * = 4e16). It is PER-ASSET (AssetParams.max_threshold_to_delay, Collateral.sol:48 —
 * same as the Rust cAsset field) and a position's break line uses the collateral-
 * value-weighted average of its assets (Cdp.sol:3575). The only path that stamps a
 * different value is permissionless onboarding (Collateral.sol:213, maybeOnboard →
 * 95e16), which the launch listing never uses.
 */
export const MAX_THRESHOLD_TO_DELAY = 0.04

export const MEMBRANE_CONSTANTS_PROVENANCE: Provenance = stamp(
  'onchain',
  'membrane contract source',
  'BORROW_LTV_GAP + MAX_LTV_HARD_CAP from lib/Constants.sol:23,30; cure window 28800s from liquidation-engine/src/contract.rs:52; 4% break band = max_threshold_to_delay 4e16 on every deploy-registered asset (DeployFullSystem.s.sol, LiquidationEngine.sol:2165); partial-repay formula from LiquidationEngine.sol:2204-2238',
)

/**
 * The DEPLOY's own max LTVs for its three launch stables — REAL values from the deploy
 * script, not modelled (membrane-solidity 16e12329, script/DeployFullSystem.s.sol):
 *
 *   SUSDS_MAX_LTV     = 88e16   :243  "bootstrap temp_ltv (fallback while the Disco pool is
 *                                      below its floor); runs at the 96% cap once covered"
 *   SYRUPUSDC_MAX_LTV = 86e16   :247  "bootstrap temp_ltv (fallback below the Disco floor);
 *                                      exit-queue haircut"
 *   SCRVUSD_MAX_LTV   = 86e16   :251  "bootstrap temp_ltv (fallback below the Disco floor);
 *                                      thinner venue"
 *
 * listed by `_onboardLaunchAsset` at :755-759. They are the BOOTSTRAP line, the one each
 * asset runs at until its Disco pool covers it; after that the listing's 96% cap applies.
 * The simulator uses the bootstrap value, the lower of the two. Stamped by
 * MEMBRANE_DEPLOY_LTV_PROVENANCE, not the modelled stamp.
 */
export const DEPLOY_LAUNCH_LTV: Readonly<Record<string, number>> = {
  sUSDS: 0.88,
  syrupUSDC: 0.86,
  scrvUSD: 0.86,
}

/**
 * Per-asset max (liquidation) LTV: MODELLED, except the DEPLOY_LAUNCH_LTV entries.
 *
 * The modelled ones are NOT read from a deployment — none exists. They are a stated
 * assumption, capped by the real hard cap of the asset's class, and the UI exposes them
 * as an editable input. Do not present any of those as a protocol parameter. An asset
 * with no entry (GHO, for one) has NO line: nothing is invented for it.
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
  ...DEPLOY_LAUNCH_LTV,
}

export const MEMBRANE_LTV_PROVENANCE: Provenance = stamp(
  'modelled',
  'modelled — no Membrane mainnet deployment',
  'Membrane has no EVM mainnet deployment, so no live per-asset max LTV exists to read. These are our assumptions, capped at the real 90% MAX_LTV_HARD_CAP (96% NO_DELAY_LTV_HARD_CAP for stables, modelled as no-delay listings) — except sUSDS, syrupUSDC and scrvUSD, which use the deploy script’s own values. Editable in the UI.',
)

/**
 * The stamp for DEPLOY_LAUNCH_LTV: read from a committed source file, not assumed. Kind
 * 'dataset' (a committed file), not 'modelled'; and not 'onchain', which the chip would
 * print with a "fetched HH:MM" clock for a read that never happened (Stamp.tsx).
 */
export const MEMBRANE_DEPLOY_LTV_PROVENANCE: Provenance = stamp(
  'dataset',
  'membrane deploy script',
  'sUSDS 88%, syrupUSDC 86%, scrvUSD 86%: SUSDS_MAX_LTV / SYRUPUSDC_MAX_LTV / SCRVUSD_MAX_LTV in script/DeployFullSystem.s.sol:243, :247, :251 (membrane-solidity 16e12329). Each is the bootstrap max LTV a launch stablecoin runs at until its Disco pool covers it; after that its 96% cap applies.',
)

/** True when `symbol`'s line is the deploy script's own value, not our assumption. */
export function isDeployListedLtv(symbol: string): boolean {
  return Object.prototype.hasOwnProperty.call(DEPLOY_LAUNCH_LTV, symbol)
}

/** The lowest Membrane max LTV a user (slider or URL ?ltv) may set. */
export const MEMBRANE_LTV_INPUT_MIN = 0.3

/**
 * A user-set Membrane line, clamped to what the position's class allows: from
 * MEMBRANE_LTV_INPUT_MIN up to `positionLtvCap` — 96% when every collateral leg is a
 * no-delay stable, else 90% (collateralClass.ts). The slider and URL ?ltv share it.
 */
export function clampMembraneLtv(ltv: number, collateralSymbols: readonly string[]): number {
  const max = positionLtvCap(collateralSymbols)
  if (!Number.isFinite(ltv)) return max
  return Math.min(max, Math.max(MEMBRANE_LTV_INPUT_MIN, ltv))
}

/**
 * Whether Membrane has ANY line for this collateral: at least one leg with a max LTV.
 * When none does (an all-GHO position, say), the position cannot be judged — the
 * weighted line would be 0 and every minute "over" it. Callers must not run it.
 */
export function hasMembraneLine(collateralSymbols: readonly string[]): boolean {
  return collateralSymbols.some((s) => membraneMaxLtv(s) !== null)
}

/**
 * The liquidation line for an asset, or null if we have no assumption for it.
 *
 * Clamped to the hard cap of the asset's MODELLED delay class (collateralClass.ts): a
 * no-delay (stable) listing at NO_DELAY_LTV_HARD_CAP = 96% (lib/Constants.sol:32), a
 * delayed one at MAX_LTV_HARD_CAP = 90% (lib/Constants.sol:23; Collateral.sol:538-540).
 */
export function membraneMaxLtv(symbol: string): number | null {
  const v = MEMBRANE_ASSET_LTV[symbol]
  if (v === undefined) return null
  return Math.min(v, hardCapFor(symbol))
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
 * @param debtMinimumUsd the `liqDebtMinimum` floor; 0 disables it (the default, so
 *                       every pre-existing call site keeps its old behaviour)
 * @returns debt value to repay, clamped to (0, loanValueUsd]
 */
export function membraneRepayValue(
  loanValueUsd: number,
  collValueUsd: number,
  borrowLtv: number,
  debtMinimumUsd = 0,
): number {
  if (loanValueUsd <= 0) return 0
  if (collValueUsd <= 0) return applyDebtMinimum(loanValueUsd, loanValueUsd, debtMinimumUsd)
  const L = loanValueUsd / collValueUsd
  // underwater: repay against ALL collateral value (LiquidationEngine.sol:2216-2218)
  if (L >= 1) return applyDebtMinimum(collValueUsd, loanValueUsd, debtMinimumUsd)
  if (L <= borrowLtv) return 0 // still under the cap: nothing to do — the floor never runs
  const denomB = borrowLtv < 1 ? 1 - borrowLtv : 1
  let frac = ((L - borrowLtv) / L) / denomB
  if (frac > 1) frac = 1
  return applyDebtMinimum(frac * loanValueUsd, loanValueUsd, debtMinimumUsd)
}

/**
 * The deployed partial-liquidation debt floor, in credit VALUE (1e18 == 1 CDT ≈ $1).
 *
 * `script/DeployFullSystem.s.sol:388` calls `setLiqDebtMinimum(2000e18)` immediately
 * after constructing the engine — $2,000 — over the constructor default of
 * `MembraneDeploymentDefaults.DEBT_MINIMUM = 100e18` ($100,
 * `contracts/lib/DeploymentDefaults.sol:51`, which is what
 * `script/DeployLiquidationCore.s.sol` leaves in place because it never calls the
 * setter). The deploy comment cites a 2026-08-12 liquidation-parameter study: "$100
 * chunks are toxic at small sizes".
 */
export const LIQ_DEBT_MINIMUM_USD = 2000

/** The constructor default, kept for the sensitivity line. */
export const LIQ_DEBT_MINIMUM_DEFAULT_USD = 100

/**
 * The `liqDebtMinimum` floor and the remainder guard, exactly as
 * LiquidationEngine.sol:2241-2269 applies them to an already-sized `repayValue`.
 *
 *   dMin = liqDebtMinimum (the contract also takes max(dMin, gasStipend × CHUNK_GAS_MULT);
 *          gas is not modelled here, so the static minimum is the floor — this can only
 *          UNDER-state the escalation, never over-state it)
 *   if dMin != 0 && repay < dMin:
 *       repay = loan                      if loan < dMin                       (:2250-2251)
 *       repay = dMin                      if loan - dMin >= dMin               (:2252-2253)
 *       repay = loan                      otherwise (dMin <= loan < 2 × dMin)  (:2254-2255)
 *   REMAINDER GUARD (:2266-2269), against the STATIC minimum:
 *       if repay < loan && loan - repay < dMin: repay = loan
 *
 * Every comparison in the contract is strict `<`.
 */
export function applyDebtMinimum(
  repayValue: number,
  loanValueUsd: number,
  debtMinimumUsd: number,
): number {
  if (!(debtMinimumUsd > 0) || !(repayValue > 0)) return repayValue
  let repay = repayValue
  if (repay < debtMinimumUsd) {
    if (loanValueUsd < debtMinimumUsd) repay = loanValueUsd
    else if (loanValueUsd - debtMinimumUsd >= debtMinimumUsd) repay = debtMinimumUsd
    else repay = loanValueUsd
  }
  // Remainder guard: a chunk that was already >= dMin can still strand a sub-minimum
  // remainder. Those escalate to the whole loan.
  if (repay < loanValueUsd && loanValueUsd - repay < debtMinimumUsd) repay = loanValueUsd
  return repay
}

/**
 * What a sale takes from COLLATERAL when this same call's venue recall already repaid
 * `recalledUsd` and left the position over its line — the contract's own sizing.
 *
 * Step 2 narrows `repayTarget` with `_getRepayQuantities` (LiquidationEngine.sol:2663),
 * which reads `p.totalDebt` — the PRE-recall debt from Step 1 (:1311, :2671) — and
 * `p.currentLtv` as read AFTER the recall (:1554). So the target is the restore-to-cap
 * fraction at the POST-recall LTV applied to the PRE-recall loan, with the debt floor on
 * that; at or over 100% LTV it is the whole loan (:2673-2688). The sell wall then covers
 * `remaining = repayTarget - totalRepaid` (:2261), and `totalRepaid` already includes the
 * recall. Sold from collateral = max(0, target - recalled).
 *
 * With nothing recalled this is `membraneRepayValue` exactly. (The floor here is
 * `applyDebtMinimum`, as everywhere in this file.)
 */
export function membraneSaleAfterRecall(
  loanPreUsd: number,
  collValueUsd: number,
  borrowLtv: number,
  recalledUsd: number,
  debtMinimumUsd = 0,
): number {
  if (!(recalledUsd > 0))
    return membraneRepayValue(loanPreUsd, collValueUsd, borrowLtv, debtMinimumUsd)
  if (loanPreUsd <= 0) return 0
  const lPost = collValueUsd > 0 ? (loanPreUsd - recalledUsd) / collValueUsd : Infinity
  let target: number
  if (lPost >= 1) {
    target = loanPreUsd // :2673-2688 — the whole loan; the floor is a no-op there
  } else {
    if (lPost <= borrowLtv) return 0
    const denomB = borrowLtv < 1 ? 1 - borrowLtv : 1
    const frac = Math.min(1, (lPost - borrowLtv) / lPost / denomB)
    target = applyDebtMinimum(frac * loanPreUsd, loanPreUsd, debtMinimumUsd)
  }
  return Math.max(0, target - recalledUsd)
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
