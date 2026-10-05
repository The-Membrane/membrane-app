/**
 * Membrane's liquidation engine, as applied to an arbitrary multi-asset position.
 *
 * WHAT IS REAL HERE, AND WHAT IS NOT — read before changing anything:
 *
 * REAL (verified against membrane-solidity MASTER 10626e40, cited inline; LE =
 * contracts/LiquidationEngine.sol, Deploy = script/DeployFullSystem.s.sol):
 *   - TWO COLLATERAL CLASSES, derived from a listing's immutable LTV cap
 *     (Collateral.sol:363-365 `_noDelay(cap) = cap > MAX_LTV_HARD_CAP`):
 *       delayed   cap <= 90%   4% band, 8h window          Deploy:213, :254, :1127
 *       no-delay  90% < cap <= 96%   band 0 ⇒ instant mode  Collateral.sol:369-371;
 *                 liquidatable the moment LTV > max LTV     LE:1572-1576, :1708-1710
 *     and a position never mixes the two                    Collateral.sol:510-514,
 *                                                           called from Cdp.sol:1640
 *   - the partial-repay formula                 LE:2663-2710 (full debt at L >= 1)
 *   - the liqDebtMinimum floor                  LE:2718-2729
 *   - the 8-hour delay (28800 s)                Deploy:199 → engine ctor Deploy:481
 *   - the 3pp borrow/liquidation LTV gap        lib/Constants.sol:39; Cdp.sol:1613-1615
 *   - the 90% / 96% max-LTV hard caps           lib/Constants.sol:23, :32
 *   - recall-from-venues BEFORE selling          LE:1106-1107 (`_step1_5_venueRecall`)
 *
 * MODELLED (no source of truth exists yet — say so on screen):
 *   - the per-asset max LTV for ETH, BTC, etc. There is NO Membrane EVM mainnet
 *     deployment (config/evm/chains.ts targets local anvil only). Master's deploy
 *     script DEFINES parameters for four assets (WETH plus three no-delay stables,
 *     below) and their values are taken from it — but it does not list all four:
 *     WETH is listed at genesis, sUSDS and scrvUSD only when their token env vars are
 *     set (Deploy:755-760), and syrupUSDC never (`SYRUPUSDC_SUPPLY_CAP = 0`, Deploy:248,
 *     and `_onboardLaunchAsset` returns early on a zero cap, Deploy:1119). Every OTHER
 *     entry in MEMBRANE_ASSET_LTV is ours and is stamped 'modelled'. They must be
 *     presented as an assumption the user can change, never as protocol state.
 *   - the venue recall rate. It is the dominant variable and it is an input.
 *
 * INTENDED RULES, NOT MASTER (owner rulings 2026-10-04 — the simulator models the rule
 * the owner ruled; master differs and each gap has a fix lane, AGENT_BOARD.md "OWNER
 * RULINGS ON MECHANICS"):
 *   - DEBT FLOOR remainder guard: a liquidation never leaves 0 < debt < liqDebtMinimum;
 *     it repays all instead (`applyDebtMinimum`). Master has no guard (LE:2718-2729).
 *   - RECALL SIZING: a call recalls only what restores the position to borrowable LTV
 *     (`membraneRecallTarget`). Master recalls up to the FULL debt (LE:1320, :1452-1453).
 *   - SAVED: the timer starts and ends at the line — back at or under it is out of the
 *     window. This one MATCHES master (`CdpInternal.insolvent` is `ratio > line`).
 *
 * NOT MODELLED (stated, so nobody mistakes the omission for parity):
 *   - the keeper fee ramp `min((L − T)/L, 20%)` + gas stipend + protocol `_liqFee`
 *     (LE:1817-1835). compare.ts still takes a flat, user-set fee.
 *   - the gas-indexed part of the debt floor (LE:2719-2720); see applyDebtMinimum.
 *   - the stale-timer amnesty at 2 × delay (LE:1590-1594).
 */

import { stamp, type Provenance } from './types'

// ---------------------------------------------------------------- constants

/** 3pp. `max_borrow_LTV = max_LTV - BORROW_LTV_GAP`, the SAME gap in both classes.
 *  Real: lib/Constants.sol:39; applied per asset at Cdp.sol:1613-1615 and :5506-5508. */
export const BORROW_LTV_GAP = 0.03

/**
 * 90% — the DELAYED-class ceiling on an asset's max LTV, and the cap a listing gets
 * when it passes 0 (the default listing is therefore delayed).
 * Real: lib/Constants.sol:23; default applied at Collateral.sol:345.
 */
export const MAX_LTV_HARD_CAP = 0.9

/**
 * 96% — the absolute ceiling on a listing's immutable `max_ltv_cap`. A cap ABOVE 90%
 * (and at most 96%) lists the asset in the NO-DELAY class. A cap above 96% cannot be
 * listed at all (`LtvCapOutOfRange`). Real: lib/Constants.sol:32; enforced at
 * Collateral.sol:346-348.
 */
export const NO_DELAY_LTV_HARD_CAP = 0.96

/**
 * The delay in seconds. Real: script/DeployFullSystem.s.sol:199
 * `LIQUIDATION_DELAY_S = 8 hours`, passed to the LiquidationEngine constructor at
 * :481. (Was cited to the Rust `liquidation-engine/src/contract.rs:52`
 * `unwrap_or(28800)`; same value, but master's deploy script is the source now.)
 * Applies to the DELAYED class only — a no-delay position never arms a timer.
 */
export const CURE_WINDOW_SECONDS = 28_800

export const CURE_WINDOW_HOURS = CURE_WINDOW_SECONDS / 3600 // 8

/**
 * THE 4% WINDOW — the DELAYED-class guarantee. While a breached position stays within
 * this band above the liquidation line, the cure window DELAYS the sale (it does not forbid
 * one: a liquidation that would leave 0 < debt < the debt minimum closes the loan, inside
 * the window too — owner ruling 2026-10-04). Climb
 * past it and the timer is BROKEN: the sale is immediate (LE:1695-1696 BrokeWindow),
 * at the same fee. Real: `_immediateThreshold = maxLtv + band × maxLtv` (LE:2554-2557);
 * band = per-asset `max_threshold_to_delay` (Collateral.sol:50), value-weighted across
 * the position's assets (Cdp.sol:5050).
 *
 * 4% is what master's deploy script stamps on every DELAYED asset: WETH genesis
 * `WETH_THRESHOLD_TO_DELAY = 4e16` (DeployFullSystem.s.sol:213) and
 * `LAUNCH_THRESHOLD_TO_DELAY = 4e16` "VOLATILE launch assets only" (:254), applied
 * only when the cap is <= 90% (:1127). A NO-DELAY asset must carry 0
 * (NO_DELAY_THRESHOLD_TO_DELAY). The only path that stamps anything else is
 * permissionless onboarding (Collateral.sol:296 → 95e16), which the launch listing
 * never uses and this model does not cover.
 */
export const MAX_THRESHOLD_TO_DELAY = 0.04

/**
 * 0 — the NO-DELAY class band. A no-delay listing with a non-zero window reverts
 * (`NoDelayAssetHasWindow`, Collateral.sol:369-371); the deploy script writes 0 for
 * every cap above 90% (DeployFullSystem.s.sol:1127). With a weighted band of exactly 0
 * the engine runs in instant mode (LE:1572): threshold = max LTV (LE:1573-1575), and a
 * call that would arm a timer reverts instead (LE:1708-1710). So crossing the line IS
 * the sale — there is no window to cure in.
 */
export const NO_DELAY_THRESHOLD_TO_DELAY = 0

export const MEMBRANE_CONSTANTS_PROVENANCE: Provenance = stamp(
  'onchain',
  'membrane contract source',
  'membrane-solidity master 10626e40: BORROW_LTV_GAP + MAX_LTV_HARD_CAP + NO_DELAY_LTV_HARD_CAP from lib/Constants.sol:23,32,39; class rule cap > 90% ⇒ no-delay (Collateral.sol:363-365), no mixing (Collateral.sol:510-514); 8h delay from DeployFullSystem.s.sol:199; 4% delayed-class band (DeployFullSystem.s.sol:213,254,1127), 0 for no-delay (Collateral.sol:369-371) ⇒ instant mode (LiquidationEngine.sol:1572); partial-repay formula + debt floor from LiquidationEngine.sol:2663-2729. Owner-ruled intended rules (2026-10-04), not yet on master: the debt-floor remainder guard, and recall sized to restore borrowable LTV rather than the full debt',
)

// ------------------------------------------------------------------ classes

/**
 * The two collateral classes on master. The class is DERIVED from the listing's
 * immutable LTV cap, never set on its own (Collateral.sol:361-366).
 *   'delayed'  — cap <= 90%: arms the 8h window inside the 4% band.
 *   'no-delay' — 90% < cap <= 96%: liquidatable the moment LTV > max LTV.
 */
export type MembraneClass = 'delayed' | 'no-delay'

/** Per-class mechanics. Every field is a master value, cited on its constant above. */
export interface MembraneClassParams {
  readonly class: MembraneClass
  /** Highest max LTV any asset of this class can reach (its cap ceiling). */
  readonly ltvCeiling: number
  /** `max_threshold_to_delay`: the band above the line inside which the window holds.
   *  0 = instant mode — the break line IS the line. */
  readonly band: number
  /** Seconds a breach inside the band is protected. 0 = there is no window. */
  readonly windowSeconds: number
  /** Borrow LTV = max LTV − this. */
  readonly borrowLtvGap: number
}

export const MEMBRANE_CLASS_PARAMS: Readonly<Record<MembraneClass, MembraneClassParams>> = {
  delayed: {
    class: 'delayed',
    ltvCeiling: MAX_LTV_HARD_CAP,
    band: MAX_THRESHOLD_TO_DELAY,
    windowSeconds: CURE_WINDOW_SECONDS,
    borrowLtvGap: BORROW_LTV_GAP,
  },
  'no-delay': {
    class: 'no-delay',
    ltvCeiling: NO_DELAY_LTV_HARD_CAP,
    band: NO_DELAY_THRESHOLD_TO_DELAY,
    // The engine-wide `_liquidationDelay` still exists, but instant mode never arms a
    // timer against it (LE:1708-1710), so for this class the window is 0.
    windowSeconds: 0,
    borrowLtvGap: BORROW_LTV_GAP,
  },
}

/**
 * The class a listing cap puts an asset in. Collateral.sol:363-365:
 * `_noDelay(cap) = cap > MAX_LTV_HARD_CAP`. A cap of 0 is the default listing, which
 * Collateral.sol:345 rewrites to 90% — delayed. (A cap above 96% is unlistable,
 * Collateral.sol:346-348; it is still classified, as no-delay, so callers never crash.)
 */
export function membraneClassOfCap(cap: number): MembraneClass {
  return cap > MAX_LTV_HARD_CAP ? 'no-delay' : 'delayed'
}

// ------------------------------------------------------------- asset table

/**
 * Per-asset max (liquidation) LTV — the asset's `temp_ltv` / current max LTV.
 *
 * FROM MASTER'S DEPLOY SCRIPT (script/DeployFullSystem.s.sol) — its CONSTANTS, not a
 * live listing (WETH lists at genesis; sUSDS and scrvUSD only when their token env vars
 * are set, :755-760; syrupUSDC is BLOCKED — supply cap 0 at :248, and
 * `_onboardLaunchAsset` skips a zero cap at :1119):
 *   WETH       0.80  `WETH_MAX_LTV` :212 ("placeholder; re-derive per risk model")
 *   sUSDS      0.88  `SUSDS_MAX_LTV` :243      bootstrap temp_ltv of a 96%-cap
 *   syrupUSDC  0.86  `SYRUPUSDC_MAX_LTV` :247  no-delay listing; "runs at the 96% cap
 *   scrvUSD    0.86  `SCRVUSD_MAX_LTV` :251    once covered" by the Disco (:243)
 * The bootstrap value is the deterministic one (Collateral.sol:454-472 falls back to
 * temp_ltv until the Disco average exists); pass a line override to model the 96%
 * steady state.
 *
 * MODELLED — every other entry. Ours, not read from anything. Each is a DELAYED
 * listing because the default listing cap is 90% (Collateral.sol:345); a 96% segment
 * of the same token would be a separate listing. The UI exposes the line as an
 * editable input. Do not present any of these as a protocol parameter.
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
  // Master's no-delay launch-asset constants (DeployFullSystem.s.sol:243, :247, :251).
  // syrupUSDC is defined there but not listed (supply cap 0, :248, :1119).
  sUSDS: 0.88,
  syrupUSDC: 0.86,
  scrvUSD: 0.86,
}

/**
 * Each listing's immutable `max_ltv_cap` (Collateral.sol:75). An asset missing here
 * but present in MEMBRANE_ASSET_LTV gets the default 90% cap (Collateral.sol:345), i.e.
 * the delayed class. Real values: DeployFullSystem.s.sol:269-272 — the owner ruled all
 * three launch stables no-delay at 96% (:266-268) and WETH delayed at 90%.
 */
export const MEMBRANE_ASSET_LTV_CAP: Record<string, number> = {
  sUSDS: 0.96,
  syrupUSDC: 0.96,
  scrvUSD: 0.96,
  WETH: 0.9,
  ETH: 0.9,
}

export const MEMBRANE_LTV_PROVENANCE: Provenance = stamp(
  'modelled',
  'modelled — no Membrane mainnet deployment',
  "Membrane has no EVM mainnet deployment, so no live per-asset max LTV exists to read. WETH, sUSDS, syrupUSDC and scrvUSD use the constants in master's deploy script (DeployFullSystem.s.sol:212-272) — WETH lists at genesis, sUSDS and scrvUSD only when their token env vars are set (:755-760), and syrupUSDC is not listed at all (supply cap 0, :248, :1119); the rest are our assumptions, all capped at their class ceiling (90% delayed, 96% no-delay). Editable in the UI.",
)

/** The listing cap for an asset, or null if we have no line for it at all. */
export function membraneAssetLtvCap(symbol: string): number | null {
  if (MEMBRANE_ASSET_LTV[symbol] === undefined) return null
  return MEMBRANE_ASSET_LTV_CAP[symbol] ?? MAX_LTV_HARD_CAP
}

/** The class an asset lists in, or null if we have no line for it. */
export function membraneAssetClass(symbol: string): MembraneClass | null {
  const cap = membraneAssetLtvCap(symbol)
  return cap === null ? null : membraneClassOfCap(cap)
}

/** The liquidation line for an asset, or null if we have no assumption for it.
 *  Clamped to the asset's OWN cap, as `currentMaxLTV` does (Collateral.sol:469-471):
 *  90% for a delayed listing, up to 96% for a no-delay one. */
export function membraneMaxLtv(symbol: string): number | null {
  const v = MEMBRANE_ASSET_LTV[symbol]
  if (v === undefined) return null
  return Math.min(v, membraneAssetLtvCap(symbol) as number)
}

/** The borrow cap sits a fixed 3pp under the liquidation line, in both classes. */
export function membraneBorrowLtv(maxLtv: number): number {
  return Math.max(0, maxLtv - BORROW_LTV_GAP)
}

// ------------------------------------------------------------ partial repay

/**
 * How much debt VALUE a Membrane partial liquidation repays. The same in both classes.
 *
 * This is the Solidity implementation, which deliberately DIVERGES from the Rust:
 *
 *   Solidity  repay = loan × (L − B) / (L × (1 − B))     LE:2689-2710
 *   Rust      repay = loan × (L − B) /  L                cdp/src/liquidations.rs:474-483
 *
 * The `/(1 − B)` factor accounts for the collateral that LEAVES with the repay. The
 * Solidity comment records why the faithful port was abandoned: it "under-repays 5× at
 * B=0.8", which CosmWasm self-heals over repeated keeper calls but Solidity turns into
 * a hard revert via `_assertPositionSolventPostOp`.
 *
 * AT L >= 1 the target is the FULL DEBT (LE:2673-2688), not the collateral value.
 * CHANGED 2026-10-04: this used to return the collateral value — the old Rust cap
 * (cdp rs:472-473). Master threads venue recall through the same target and says a
 * collateral-value cap "strands recallable venue capital as bad debt at insolvency".
 * Collateral consumers stay bounded by holdings downstream, so with no venue capital
 * the collateral actually sold is unchanged; what changes is that recall can now cover
 * the whole debt. A caller that books a repay from COLLATERAL ALONE (the census, the
 * practice engine) must not book this target as closed: past L = 1 it exceeds what the
 * collateral can repay, and the uncovered rest is bad debt (LE:2361-2374). Those callers
 * use `membraneCollateralRepayValue`.
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
  // No collateral value ⇒ L = ∞ ≥ 1 ⇒ the full debt (LE:2673-2688).
  if (collValueUsd <= 0) return loanValueUsd
  const L = loanValueUsd / collValueUsd
  // Underwater: target the FULL debt (LE:2673-2688). The floor is a provable no-op at
  // repay == loan, which is why the contract returns before it (LE:2686-2688).
  if (L >= 1) return loanValueUsd
  if (L <= borrowLtv) return 0 // still under the cap: nothing to do — the floor never runs
  const denomB = borrowLtv < 1 ? 1 - borrowLtv : 1
  let frac = ((L - borrowLtv) / L) / denomB
  if (frac > 1) frac = 1
  return applyDebtMinimum(frac * loanValueUsd, loanValueUsd, debtMinimumUsd)
}

/**
 * The debt a Membrane liquidation can CLOSE FROM COLLATERAL ALONE: the repay target
 * (`membraneRepayValue`) bounded by the collateral value held.
 *
 * Below L = 1 the bound never binds (target <= loan < collateral), so this IS the
 * target. At L >= 1 master still targets the FULL debt (LE:2673-2688) — so venue recall
 * can cover it — but collateral consumers are holdings-bounded downstream, and once the
 * collateral is exhausted the still-uncovered `totalDebt − totalRepaid` is BAD DEBT
 * (`_step7_claimUpdate`, LE:2361-2374), not a repay. Booking the raw target as closed
 * makes insolvency vanish: a $100k debt on $61.5k of collateral would read as $100k
 * repaid and $0 owed.
 *
 * Use it wherever collateral is the only payer (cureWalk, the practice engine, the
 * census's one-repay figure). Paths that recall venue capital first (compare.ts,
 * stressGrid.ts) keep the raw target and bound the COLLATERAL leg themselves.
 */
export function membraneCollateralRepayValue(
  loanValueUsd: number,
  collValueUsd: number,
  borrowLtv: number,
  debtMinimumUsd = 0,
): number {
  return Math.min(
    membraneRepayValue(loanValueUsd, collValueUsd, borrowLtv, debtMinimumUsd),
    Math.max(0, collValueUsd),
  )
}

/**
 * How much debt VALUE one liquidation call asks the deployment venues to RECALL.
 *
 * OWNER RULING 2026-10-04 (RECALL SIZING): "Master should only attempt to liquidate and
 * therefore recall from LLTV to borrowable LTV." The recall asks for the debt that takes
 * the position from where it is back to its borrow LTV B (= line − 3pp) — never the whole
 * debt just because the line was crossed.
 *
 * WHY NOT `membraneRepayValue` ITSELF. That formula, `loan × (L − B) / (L × (1 − B))`,
 * sizes a repay paid FROM COLLATERAL: the seized collateral leaves with the repay, hence
 * the `/(1 − B)`. Recalled venue capital takes no collateral with it, so the debt that
 * lands the position exactly at B is
 *
 *     recall = loan − B × collateral      (= membraneRepayValue × (1 − B))
 *
 * Asking venues for the collateral-formula amount would over-recall by 1/(1 − B) — about
 * 4.3× at B = 77% — and land a fully answered recall far UNDER the borrow LTV (82% → 60%
 * for a $82k loan on $100k), not at it. The same holds past L = 1: an underwater position
 * whose venues can answer `loan − B × collateral` is restored to B, so the recall does not
 * ask for the full debt there either. The full debt is asked only when there is no
 * collateral value, or when the debt floor below calls for it.
 *
 * The debt floor (`applyDebtMinimum`, with the ruled remainder guard) applies to the ask
 * like any repay: a sub-$2,000 ask lifts per LE:2721-2728, and an ask that would strand
 * 0 < remainder < dMin becomes the whole loan.
 *
 * What ARRIVES is still capped by venue capacity — the caller bounds it
 * (compare.ts: `recallRate` × the capital still deployed; stressGrid.ts: the venue stock).
 *
 * MASTER DIVERGENCE: master 10626e40 sets `repayTarget = totalDebt` before Step 1.5
 * (LE:1320) and each venue sends `min(retrievable, repayTarget − totalRepaid)` (LE:1452-1453)
 * — the recall asks for the FULL debt on every call. Fix lane: "Fix LE debt-floor dust and
 * recall sizing" (AGENT_BOARD.md, OWNER RULINGS ON MECHANICS 2026-10-04).
 *
 * @returns debt value to recall, in [0, loanValueUsd]; 0 when L <= B (nothing to restore)
 */
export function membraneRecallTarget(
  loanValueUsd: number,
  collValueUsd: number,
  borrowLtv: number,
  debtMinimumUsd = 0,
): number {
  if (!(loanValueUsd > 0)) return 0
  // No collateral value: no LTV to restore to — only closing the debt ends the breach.
  if (!(collValueUsd > 0)) return loanValueUsd
  const restore = loanValueUsd - Math.max(0, borrowLtv) * collValueUsd
  if (!(restore > 0)) return 0 // at or under B: nothing to recall
  return applyDebtMinimum(Math.min(restore, loanValueUsd), loanValueUsd, debtMinimumUsd)
}

/**
 * The deployed partial-liquidation debt floor, in credit VALUE (1e18 == 1 CDT ≈ $1).
 *
 * `script/DeployFullSystem.s.sol:486` calls `setLiqDebtMinimum(2000e18)` immediately
 * after constructing the engine — $2,000 — over the constructor default of
 * `MembraneDeploymentDefaults.DEBT_MINIMUM = 100e18` ($100,
 * `contracts/lib/DeploymentDefaults.sol:51`, written by the engine constructor at
 * LE:734). The deploy comment cites a 2026-08-12 liquidation-parameter study: "$100
 * chunks are toxic at small sizes".
 */
export const LIQ_DEBT_MINIMUM_USD = 2000

/** The constructor default, kept for the sensitivity line. */
export const LIQ_DEBT_MINIMUM_DEFAULT_USD = 100

/**
 * The `liqDebtMinimum` floor applied to an already-sized `repayValue`: master's
 * LE:2718-2729 floor, PLUS the remainder guard the owner ruled is the intended rule.
 *
 *   dMin = liqDebtMinimum
 *          (the contract also takes max(dMin, gasStipend × CHUNK_GAS_MULT) — LE:2719-2720,
 *          stipend = $20 × basefee / 5 gwei (LE:447-448, :953-955), multiplier 50
 *          (LE:454). Gas is not modelled here, so the static minimum is the floor —
 *          this can only UNDER-state the escalation, never over-state it.)
 *   if dMin != 0 && repay < dMin:
 *       repay = loan                      if loan < dMin                       (:2722-2723)
 *       repay = dMin                      if loan - dMin >= dMin               (:2724-2725)
 *       repay = loan                      otherwise (dMin <= loan < 2 × dMin)  (:2726-2727)
 *   REMAINDER GUARD (owner ruling 2026-10-04 — NOT on master):
 *       if repay < loan && loan - repay < dMin: repay = loan
 *
 * Every comparison in the contract is strict `<`; the guard uses the same strictness, so
 * a remainder of exactly dMin stands.
 *
 * OWNER RULING 2026-10-04 (DEBT FLOOR): "a liquidation must never leave
 * 0 < remaining debt < liqDebtMinimum; if it would, repay ALL." Leaving sub-minimum dust
 * is a bug that is "supposed to be fixed". The simulator models the INTENDED rule, so the
 * guard is back (it was removed earlier the same day to match master).
 * MASTER DIVERGENCE: membrane-solidity master 10626e40 has no guard — after the floor
 * closes at LE:2729 it goes straight to the credit amount, so a formula repay already
 * >= dMin that strands 0 < remainder < dMin is left standing there (e.g. repay $9,000 of
 * a $10,000 loan leaves $1,000). Fix lane: "Fix LE debt-floor dust and recall sizing"
 * (AGENT_BOARD.md, OWNER RULINGS ON MECHANICS 2026-10-04).
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
  // Remainder guard (owner ruling 2026-10-04; not on master): a chunk that is already
  // >= dMin can still strand a sub-minimum remainder. It escalates to the whole loan.
  if (repay < loanValueUsd && loanValueUsd - repay < debtMinimumUsd) repay = loanValueUsd
  return repay
}

/** Debt below this many USD counts as closed (float noise from proportional commits). */
const DEBT_FLOOR_DUST_USD = 1e-6

/**
 * OWNER RULING 2026-10-04 (DEBT FLOOR) applied to what a call ACTUALLY REPAID — not only to
 * what it asked for. `applyDebtMinimum` sizes the ASK (the recall target, the sale target);
 * a venue recall that arrives SHORT of an ask already escalated to the whole loan can still
 * strand 0 < remainder < dMin. "A liquidation must never leave 0 < remaining debt <
 * liqDebtMinimum; if it would, repay ALL": the call then repays the remainder too, and with
 * the venue already short the only payer left is collateral — a sale.
 *
 * Example ($2,000 floor): $3,000 debt on $3,300 collateral at a 90% line. The restore ask
 * ($129) lifts to the whole $3,000 (loan < 2 × dMin, LE:2726-2727); the venue holds $2,500.
 * The recall alone would land at LTV 15% — under the line — but leave $500 owed, so the
 * call sells $500 (plus fee) of collateral and closes the loan.
 *
 * MASTER DIVERGENCE: master 10626e40's recall-only lane (LE:1623-1658) commits whatever the
 * venues sent with no floor at all, so this dust stands on master. Fix lane: "Fix LE
 * debt-floor dust and recall sizing" (AGENT_BOARD.md, OWNER RULINGS ON MECHANICS
 * 2026-10-04).
 *
 * Strict like every floor comparison: a remainder of exactly dMin stands.
 *
 * @returns the debt the call must still repay so it leaves no sub-minimum remainder — the
 *          whole remainder when it would be in (0, dMin), else 0
 */
export function debtFloorRemainder(
  loanValueUsd: number,
  repaidUsd: number,
  debtMinimumUsd: number,
): number {
  if (!(debtMinimumUsd > 0)) return 0
  const rest = loanValueUsd - repaidUsd
  return rest > DEBT_FLOOR_DUST_USD && rest < debtMinimumUsd ? rest : 0
}

/**
 * The same call under a FULL-REPAYMENT engine, for the side-by-side. Most lending
 * markets repay a close-factor share of the whole loan rather than restoring to a cap.
 */
export function fullRepayValue(loanValueUsd: number, closeFactor: number): number {
  return Math.max(0, Math.min(1, closeFactor)) * loanValueUsd
}

// ------------------------------------------------------------------- recall

/**
 * The venue side of a recall. There is ONE rate: the share of the capital still deployed
 * that one keeper call gets back. (A second "fast rate" — the share arriving inside the
 * 8h window — was REMOVED 2026-10-04 by owner ruling: master's per-call recall is
 * synchronous, LE:1453, so there is no in-window arrival curve to model.)
 */
export interface VenueRecall {
  /** Share of deployed value that returns when asked. The dominant variable. */
  recallRate: number
  /** Value currently deployed to venues, in USD. */
  deployedUsd: number
  provenance: Provenance
}

export interface RecallOutcome {
  /** USD the venues actually returned against the call. */
  recalledUsd: number
  /** USD the call still wants after the recall. This is what hits collateral. */
  shortfallUsd: number
}

/**
 * Membrane recalls liquid value from deployment venues BEFORE touching collateral —
 * `_step1_5_venueRecall` runs before the collateral assessment on every call
 * (LE:1106-1107), in BOTH classes. Only the shortfall reaches the collateral.
 * `neededUsd` is the call's recall ASK — size it with `membraneRecallTarget` (owner
 * ruling 2026-10-04: restore to borrowable LTV, not the full debt, which is what master
 * asks at LE:1320 / :1452-1453). What arrives is capped at `recallRate × deployedUsd`.
 */
export function applyRecall(neededUsd: number, venue: VenueRecall | null): RecallOutcome {
  if (!venue || venue.deployedUsd <= 0 || neededUsd <= 0) {
    return { recalledUsd: 0, shortfallUsd: Math.max(0, neededUsd) }
  }
  const available = venue.deployedUsd * clamp01(venue.recallRate)
  const recalled = Math.min(available, neededUsd)
  return {
    recalledUsd: recalled,
    shortfallUsd: Math.max(0, neededUsd - recalled),
  }
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

// ------------------------------------------------------------ basket line

export interface MembraneLine {
  /** Collateral-value-weighted max LTV over the legs with a known line. */
  maxLtv: number
  /** `maxLtv − BORROW_LTV_GAP` (the weighted borrow LTVs, Cdp.sol:5049). */
  borrowLtv: number
  /** Symbols with no line — left OUT of every weighted figure, never guessed. */
  unknown: string[]
  /**
   * The basket's class. 'mixed' is a basket master REFUSES to hold in one position
   * (`MixedDelayClassCollateral`, Collateral.sol:510-514, called at Cdp.sol:1640) — it
   * would have to be split into a delayed and a no-delay position. An all-unknown
   * basket reports 'delayed', the default listing's class (Collateral.sol:345).
   */
  class: MembraneClass | 'mixed'
  /** True when known legs come from both classes. Same as `class === 'mixed'`. */
  mixed: boolean
  /**
   * The basket's `max_threshold_to_delay`. Exactly MAX_THRESHOLD_TO_DELAY for a
   * delayed basket and exactly 0 (instant mode) for a no-delay one. For a 'mixed'
   * basket it is the value-weighted average the engine WOULD compute
   * (Cdp.sol:5050) were the basket allowed — an approximation of an impossible
   * position, to be flagged on screen.
   */
  band: number
}

/** Collateral-weighted Membrane liquidation line, band and class for a basket. Assets
 *  with no modelled LTV are excluded from every weighted figure — we refuse to guess
 *  rather than substitute a default. */
export function weightedMembraneLine(legs: { symbol: string; valueUsd: number }[]): MembraneLine {
  let num = 0
  let den = 0
  let bandNum = 0
  let sawDelayed = false
  let sawNoDelay = false
  const unknown: string[] = []
  for (const leg of legs) {
    const m = membraneMaxLtv(leg.symbol)
    const cls = membraneAssetClass(leg.symbol)
    if (m === null || cls === null) {
      unknown.push(leg.symbol)
      continue
    }
    if (cls === 'no-delay') sawNoDelay = true
    else sawDelayed = true
    num += m * leg.valueUsd
    bandNum += MEMBRANE_CLASS_PARAMS[cls].band * leg.valueUsd
    den += leg.valueUsd
  }
  const maxLtv = den > 0 ? num / den : 0
  const mixed = sawDelayed && sawNoDelay
  const cls: MembraneClass | 'mixed' = mixed ? 'mixed' : sawNoDelay ? 'no-delay' : 'delayed'
  // Pure baskets use the class constant EXACTLY (no float drift from re-weighting a
  // uniform band), so every pre-existing delayed run is bit-for-bit unchanged.
  const band =
    cls === 'mixed' ? (den > 0 ? bandNum / den : MAX_THRESHOLD_TO_DELAY) : MEMBRANE_CLASS_PARAMS[cls].band
  return { maxLtv, borrowLtv: membraneBorrowLtv(maxLtv), unknown, class: cls, mixed, band }
}
