/**
 * THE ONE DEFINITION of stable collateral and of the liquidation-delay class.
 *
 * Both engines read it: the Oct 10 census (scripts/build-evidence.ts) and the
 * per-address simulator (lib/position-sim/compare.ts, scenario.ts). There used to be two
 * stable lists — `HELD_AT_ONE` in scenario.ts and `STABLES` in build-evidence.ts — that
 * disagreed on nine symbols. Do not reintroduce a second list; import this one.
 *
 * ---------------------------------------------------------------------------
 * CONTRACT TRUTH (membrane-solidity master 16e12329)
 * ---------------------------------------------------------------------------
 * The contracts carry NO stablecoin label. ee680ded introduced an `is_stablecoin` flag;
 * fc92ed4f (merged in 6b8789ae) replaced it with ONE immutable listing parameter, the LTV
 * cap `AssetParams.max_ltv_cap` (contracts/Collateral.sol:75, immutable via
 * `LtvCapImmutable`, Collateral.sol:383-385). The delay class is DERIVED from that cap:
 *
 *     _noDelay(cap) = cap > MAX_LTV_HARD_CAP           Collateral.sol:424-426 (strict >)
 *     MAX_LTV_HARD_CAP      = 9e17                     lib/Constants.sol:23
 *     NO_DELAY_LTV_HARD_CAP = 96e16                    lib/Constants.sol:32
 *
 * A no-delay listing must carry `max_threshold_to_delay == 0`
 * (`_requireNoWindowIfNoDelay`, Collateral.sol:430-432), so the liquidation engine runs it
 * in instant mode: sold the minute LTV is over the line, no timer, no band
 * (LiquidationEngine.sol:1572-1576, :1708-1710). A delayed asset's live max LTV is
 * clamped to its cap, which is at most 90% (Collateral.sol:538-540, :562). A position may
 * not hold both classes (`requireSameCollateralClass`, Cdp.sol:1650-1651, reverting
 * `MixedDelayClassCollateral`, Collateral.sol:789-793).
 *
 * MODELLED LISTING ASSUMPTION — stated, not hidden: because the class follows the cap and
 * not a label, "stable => no-delay" is OUR assumption about how a stable would be listed.
 * It mirrors the deploy script, which lists all three launch stables (sUSDS, syrupUSDC,
 * scrvUSD) at cap 96e16, i.e. no-delay, and WETH at 90e16 with the 4% window
 * (script/DeployFullSystem.s.sol:269-272; `_onboardLaunchAsset` sets the window to 0 when
 * the cap is above 90%, :1127).
 *
 * IMPORT CYCLE, deliberate and benign: this module reads the two caps from membrane.ts,
 * and membrane.ts reads `isNoDelayCollateral` from here for `membraneMaxLtv`. Every
 * cross-module use is inside a function body, never at module top level, so either load
 * order resolves. Keep it that way.
 */

import { MAX_LTV_HARD_CAP, NO_DELAY_LTV_HARD_CAP } from './membrane'

export { NO_DELAY_LTV_HARD_CAP }

/**
 * Dollar stables whose Oct 10 path is a flat $1.00. The union of the old
 * scenario.ts `HELD_AT_ONE` and the old build-evidence.ts `STABLES`.
 */
const HELD_AT_ONE_SYMBOLS = [
  'USDC',
  'USDT',
  'USD₮0',
  'USDT0',
  'DAI',
  'GHO',
  'LUSD',
  'USDS',
  'sUSD',
  'FRAX',
  'USDC.e',
  'crvUSD',
  'MAI',
  'USDbC',
  'sDAI',
  'sUSDS',
] as const

/**
 * Synthetic dollars that are stable for the DELAY CLASS but are NOT held at $1: USDe is
 * the one that actually moved on Oct 10 (Binance spot printed $0.6651 at 21:43 UTC) and
 * it has its own measured series (scenario.ts SYMBOL_TO_SERIES.USDe = 'usdeSpot').
 * Pricing it flat would erase the one stable move the day recorded.
 */
export const MEASURED_STABLES: readonly string[] = ['USDe', 'sUSDe']

/** Every symbol modelled as stable collateral. */
export const STABLE_SYMBOLS: readonly string[] = [...HELD_AT_ONE_SYMBOLS, ...MEASURED_STABLES]

const STABLE_SET: ReadonlySet<string> = new Set(STABLE_SYMBOLS)
const MEASURED_SET: ReadonlySet<string> = new Set(MEASURED_STABLES)

/** True when `symbol` is modelled as a dollar stable (held at $1 or measured). */
export function isStable(symbol: string): boolean {
  return STABLE_SET.has(symbol)
}

/** A stable whose Oct 10 price path is a flat $1.00: stable and not measured. */
export function heldAtOne(symbol: string): boolean {
  return STABLE_SET.has(symbol) && !MEASURED_SET.has(symbol)
}

/**
 * True when `symbol` is modelled as listed in the NO-DELAY class (cap 96%, window 0).
 *
 * MODELLED: the contracts have no stable label since fc92ed4f — the class follows the
 * listing's immutable `max_ltv_cap` (Collateral.sol:424-426). Stable => no-delay is the
 * listing assumption, mirroring DeployFullSystem.s.sol:269-271 (sUSDS, syrupUSDC, scrvUSD
 * at 96e16). Every other symbol is modelled as a default, delayed listing.
 */
export function isNoDelayCollateral(symbol: string): boolean {
  return isStable(symbol)
}

/**
 * A liquidation line above 90% is only possible in the no-delay class: a delayed asset's
 * max LTV is clamped to a cap of at most MAX_LTV_HARD_CAP (Collateral.sol:538-540, :562).
 * Strict `>`, exactly like `_noDelay` (Collateral.sol:425). 0.90 itself is delayed.
 */
export function lineIsNoDelay(line: number): boolean {
  return line > MAX_LTV_HARD_CAP
}

/** The hard cap that applies to a symbol's max LTV under its modelled class. */
export function hardCapFor(symbol: string): number {
  return isNoDelayCollateral(symbol) ? NO_DELAY_LTV_HARD_CAP : MAX_LTV_HARD_CAP
}

export type DelayClass = 'no-delay' | 'delayed' | 'mixed'

/**
 * The delay class of a position holding `symbols` as collateral, judged against `line`.
 *
 *   'mixed'     the symbols span both classes. Such a position cannot exist on Membrane:
 *               the CDP reverts `MixedDelayClassCollateral` when the second class enters
 *               (Cdp.sol:1650-1651, Collateral.sol:789-793).
 *   'no-delay'  every symbol is no-delay, OR the line is above 90% (`lineIsNoDelay`) —
 *               only a no-delay listing can carry such a line.
 *   'delayed'   otherwise.
 *
 * An empty symbol list is judged on the line alone.
 */
export function delayClassOf(symbols: readonly string[], line?: number): DelayClass {
  const distinct = Array.from(new Set(symbols))
  const noDelay = distinct.filter(isNoDelayCollateral).length
  if (noDelay > 0 && noDelay < distinct.length) return 'mixed'
  if (distinct.length > 0 && noDelay === distinct.length) return 'no-delay'
  return line !== undefined && lineIsNoDelay(line) ? 'no-delay' : 'delayed'
}
