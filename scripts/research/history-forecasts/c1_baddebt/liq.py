"""Aave V3 liquidation rules (Core, v3.3+ LiquidationLogic), exact integer form plus a float form for the simulator.

Constants (LiquidationLogic v3.3):
  DEFAULT_LIQUIDATION_CLOSE_FACTOR = 0.5e4 (applied to the user's TOTAL debt in base currency)
  CLOSE_FACTOR_HF_THRESHOLD       = 0.95e18 (at or below it the close factor is 100 %)
  MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD = 2000e8 (reserve collateral or reserve debt below $2,000 -> 100 %)
  MIN_LEFTOVER_BASE = 1000e8 (a partial liquidation must leave >= $1,000 of that debt and that collateral,
                               unless it takes all of one of them)
Bonus: the collateral reserve's liquidation bonus, or the user's e-mode category bonus when the user is in
e-mode and the collateral is in that category's collateral bitmap. The protocol fee is a share of the bonus
part of the seized collateral and goes to the treasury, not the liquidator.
If a liquidation leaves the user with no collateral at all, the remaining debt is burned as a deficit
(DeficitCreated) -- realized bad debt.
"""
from __future__ import annotations

PERCENTAGE_FACTOR = 10_000
HALF_PERCENTAGE = 5_000
CLOSE_FACTOR = 5_000
HF_THRESHOLD = 950_000_000_000_000_000          # 0.95e18
MIN_BASE_MAX_CF = 2_000 * 10**8
MIN_LEFTOVER_BASE = MIN_BASE_MAX_CF // 2
WAD = 10**18


def percent_mul(value: int, pct: int) -> int:
    if value == 0 or pct == 0:
        return 0
    return (value * pct + HALF_PERCENTAGE) // PERCENTAGE_FACTOR


def percent_div(value: int, pct: int) -> int:
    return (value * PERCENTAGE_FACTOR + pct // 2) // pct


def effective_bonus(reserve_lb: int, reserve_id: int, emode: int, emode_cfg: dict) -> int:
    """Liquidation bonus that applies to (user, collateral reserve)."""
    if emode:
        c = emode_cfg[str(emode)] if str(emode) in emode_cfg else emode_cfg[emode]
        if (c["collateral_bitmap"] >> reserve_id) & 1:
            return c["lb"]
    return reserve_lb


def effective_lt(reserve_lt: int, reserve_id: int, emode: int, emode_cfg: dict) -> int:
    if emode:
        c = emode_cfg[str(emode)] if str(emode) in emode_cfg else emode_cfg[emode]
        if (c["collateral_bitmap"] >> reserve_id) & 1:
            return c["lt"]
    return reserve_lt


def max_liquidatable_debt(user_reserve_debt: int, debt_price: int, debt_unit: int, user_coll_balance: int,
                          coll_price: int, coll_unit: int, total_debt_base: int, health_factor: int) -> int:
    debt_base = user_reserve_debt * debt_price // debt_unit
    coll_base = user_coll_balance * coll_price // coll_unit
    m = user_reserve_debt
    if coll_base >= MIN_BASE_MAX_CF and debt_base >= MIN_BASE_MAX_CF and health_factor > HF_THRESHOLD:
        cap_base = percent_mul(total_debt_base, CLOSE_FACTOR)
        if debt_base > cap_base:
            m = cap_base * debt_unit // debt_price
    return m


def percent_mul_floor(value: int, pct: int) -> int:
    return value * pct // PERCENTAGE_FACTOR


def percent_mul_ceil(value: int, pct: int) -> int:
    return -(-value * pct // PERCENTAGE_FACTOR)


def percent_div_floor(value: int, pct: int) -> int:
    return value * PERCENTAGE_FACTOR // pct


# Core Pool implementation upgrade at block 25,199,939 changed the rounding of the seized collateral
# (directional rounding, Aave v3.5+): identified empirically from real LiquidationCall events (see the
# spot-check fixture): bonus-scaled collateral floors, the bonus split floors, the protocol fee ceils.
DIRECTIONAL_ROUNDING_FROM_BLOCK = 25_199_939


def rounding_for_block(block: int) -> str:
    return "directional" if block >= DIRECTIONAL_ROUNDING_FROM_BLOCK else "half_up"


def collateral_to_liquidate(debt_to_cover: int, debt_price: int, debt_unit: int, coll_price: int, coll_unit: int,
                            liquidation_bonus: int, protocol_fee_bps: int, user_coll_balance: int,
                            rounding: str = "half_up"):
    """Returns (collateral to the liquidator, debt repaid, protocol fee in collateral units) --
    LiquidationLogic._calculateAvailableCollateralToLiquidate. rounding: 'half_up' (v3.0-v3.4 WadRayMath /
    PercentageMath) or 'directional' (Core after block 25,199,939). The capped branch under 'directional'
    is not verified against chain data (no capped spot check in that era)."""
    pm = percent_mul if rounding == "half_up" else percent_mul_floor
    pdv = percent_div if rounding == "half_up" else percent_div_floor
    pmf = percent_mul if rounding == "half_up" else percent_mul_ceil
    base_coll = (debt_price * debt_to_cover * coll_unit) // (coll_price * debt_unit)
    max_coll = pm(base_coll, liquidation_bonus)
    if max_coll > user_coll_balance:
        coll = user_coll_balance
        debt_needed = percent_div((coll_price * coll * debt_unit) // (debt_price * coll_unit), liquidation_bonus)
    else:
        coll = max_coll
        debt_needed = debt_to_cover
    fee = 0
    if protocol_fee_bps:
        bonus_coll = coll - pdv(coll, liquidation_bonus)
        fee = pmf(bonus_coll, protocol_fee_bps)
        return coll - fee, debt_needed, fee
    return coll, debt_needed, 0


def liquidate_exact(debt_to_cover: int, user_reserve_debt: int, debt_price: int, debt_dec: int,
                    user_coll_balance: int, coll_price: int, coll_dec: int, liquidation_bonus: int,
                    protocol_fee_bps: int, total_debt_base: int, health_factor: int) -> dict:
    """Full v3.3 path for one call: close factor, collateral, dust rule. Raises on HF >= 1 or dust."""
    if health_factor >= WAD:
        raise ValueError("health factor not below 1")
    du, cu = 10**debt_dec, 10**coll_dec
    mx = max_liquidatable_debt(user_reserve_debt, debt_price, du, user_coll_balance, coll_price, cu,
                               total_debt_base, health_factor)
    actual = min(debt_to_cover, mx)
    coll, debt, fee = collateral_to_liquidate(actual, debt_price, du, coll_price, cu, liquidation_bonus,
                                              protocol_fee_bps, user_coll_balance)
    left_debt_ok = (user_reserve_debt - debt) * debt_price // du >= MIN_LEFTOVER_BASE
    left_coll_ok = (user_coll_balance - coll - fee) * coll_price // cu >= MIN_LEFTOVER_BASE
    if not ((left_debt_ok and left_coll_ok) or coll + fee == user_coll_balance or debt == user_reserve_debt):
        raise ValueError("MUST_NOT_LEAVE_DUST")
    return {"max_liquidatable": mx, "debt_repaid": debt, "collateral_to_liquidator": coll, "protocol_fee": fee}


# ---------------------------------------------------------------------------------------------
# Float form (USD / token units), vectorised by the simulator over paths
# ---------------------------------------------------------------------------------------------

def max_debt_float(np, reserve_debt_usd, coll_reserve_usd, total_debt_usd, hf):
    cap = 0.5 * total_debt_usd
    partial = (coll_reserve_usd >= 2000.0) & (reserve_debt_usd >= 2000.0) & (hf > 0.95)
    return np.where(partial & (reserve_debt_usd > cap), cap, reserve_debt_usd)


def seize_float(np, repay_usd, coll_units, coll_price_usd, lb, fee_frac):
    """Collateral seized for `repay_usd` (capped at the balance). Returns (units to liquidator, units fee,
    repay actually needed in USD, units seized in total)."""
    want = repay_usd * lb / coll_price_usd
    capped = want > coll_units
    seized = np.where(capped, coll_units, want)
    repay = np.where(capped, coll_units * coll_price_usd / lb, repay_usd)
    fee = (seized - seized / lb) * fee_frac
    return seized - fee, fee, repay, seized
