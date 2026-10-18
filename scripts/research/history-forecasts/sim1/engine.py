"""Coupled slice-1 engine: prices -> oracle -> liquidations -> flows -> cash, debt, utilisation, rates.

Hourly order (design 2.7): (1) prices move ((fH) paths) and oracle answers update by feed rules; (2) health
factors update and profitable calls happen (repaid USDC enters the reserve's cash); (3) depositor and borrower
flows apply from the same historical day's flow block (shared calendar), with historical liquidation repayments
removed on Core (double-count guard); (4) cash, supply, debt and utilisation update and rates follow the exact
curve. No behavioural feedback (rates do not change flows). Cash never goes below 0: an outflow larger than cash
is blocked and counted.
"""
from __future__ import annotations

import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
from c1_baddebt import depth as DP  # noqa: E402

from sim1 import config as CFG  # noqa: E402
from sim1 import liq as LQ  # noqa: E402
from sim1 import paths as PA  # noqa: E402

RAY = 1e27


def curve_apr(u, curve_ray: dict):
    """Aave V3 DefaultReserveInterestRateStrategyV2 variable borrow rate (APR, fraction) at utilisation u."""
    opt = curve_ray["optimal"] / RAY
    base, s1, s2 = curve_ray["base"] / RAY, curve_ray["slope1"] / RAY, curve_ray["slope2"] / RAY
    u = np.asarray(u, float)
    return np.where(u > opt, base + s1 + s2 * (u - opt) / (1.0 - opt), base + s1 * u / opt)


def make_curves(state: dict, market: str) -> dict:
    m = CFG.MARKETS[market]
    out = {}
    for fam, d in state["depth"].items():
        if not d["states"]:
            out[fam] = None
            continue
        dec = {d["base"].lower(): d["base_decimals"], m["usdc"]: 6}
        out[fam] = DP.Curve(d["states"], d["base"].lower(), dec)
    return out


def family_price(state: dict, fam: str) -> float:
    sym = {"E": "WETH", "B": "WBTC"}[fam]
    for r in state["reserves"].values():
        if r["symbol"].upper() == sym:
            return r["price"] / 1e8
    return float("nan")


def baseline_underwater(P: dict) -> float:
    """USDC share of max(0, debt - collateral) at t0 prices (already underwater before any path move)."""
    coll = P["VE"] + P["VB"] + P["VO"]
    debt = P["DU"] + P["DE"] + P["DB"] + P["DO"]
    with np.errstate(divide="ignore", invalid="ignore"):
        sh = np.where(debt > 0, P["DU"] / debt, 0.0)
    return float(np.sum(np.maximum(debt - coll, 0.0) * sh))


def run_market(state: dict, market: str, P: dict, paths: dict, flows: dict, depth_mult: float = 1.0) -> dict:
    """One market on one path set. flows: f_cash, dip, g_debt aligned with paths['day_ts'] rows."""
    m = CFG.MARKETS[market]
    T = paths["T"]
    E, Bt = paths["eth"], paths["btc"]
    devE, hbE = m["feeds"]["ETH"]
    devB, hbB = m["feeds"]["BTC"]
    oE = PA.oracle_path(E["close"], E["low"], devE, hbE)
    oB = PA.oracle_path(Bt["close"], Bt["low"], devB, hbB)
    phi = DP.depth_factor(E["close"], **CFG.DEPTH_IMPAIR) * depth_mult
    idx = LQ.candidates(P, oE.min(), oE.max(), oB.min(), oB.max())
    curves = make_curves(state, market)
    px0 = {"E": family_price(state, "E"), "B": family_price(state, "B")}
    L = LQ.run(P, idx, oE, oB, E["close"], Bt["close"], curves, px0, phi, m["gas_usd"], m["dust_usd"])
    base_uw = baseline_underwater(P)
    bd_total = L["usdc_deficit"] + L["bd_underwater"]
    bd_new = np.maximum(bd_total - base_uw, 0.0)
    # cash, debt, rates
    us = state["usdc"]
    S0 = us["atoken_total_supply"] / 1e6
    C0 = us["cash_balance"] / 1e6
    D0 = us["vdebt_total_supply"] / 1e6
    vb_off = ((us["virtual_balance"] or us["cash_balance"]) - us["cash_balance"]) / 1e6
    n = E["close"].shape[0]
    c = np.full(n, C0)
    d = np.full(n, D0)
    cmin = np.full(n, C0)
    cmin24 = np.full(n, C0)
    blocked = np.zeros(n)
    umax = np.full(n, D0 / (C0 + vb_off + D0))
    for h in range(T):
        inhour = np.maximum(c + flows["dip"][:, h] * S0, 0.0)
        cn = c + flows["f_cash"][:, h] * S0 + L["usdc_repay"][:, h]
        blocked += np.maximum(-cn, 0.0)
        cn = np.maximum(cn, 0.0)
        d = np.maximum(d * (1.0 + flows["g_debt"][:, h]) - L["usdc_repay"][:, h], 0.0)
        c = cn
        hm = np.minimum(inhour, c)
        cmin = np.minimum(cmin, hm)
        if h < 24:
            cmin24 = np.minimum(cmin24, hm)
        umax = np.maximum(umax, d / np.maximum(c + vb_off + d, 1e-9))
    d_end = np.maximum(d - L["usdc_deficit"], 0.0)
    u_end = d_end / np.maximum(c + vb_off + d_end, 1e-9)
    rf = us["rf_bps"] / 1e4
    bapr_end = curve_apr(u_end, us["curve_ray"])
    bapr_max = curve_apr(umax, us["curve_ray"])
    sapr_end = bapr_end * u_end * (1.0 - rf)
    u0 = D0 / (C0 + vb_off + D0)
    return {"market": market, "n_accounts": int(P["n"]), "n_candidates": int(len(idx)),
            "baseline_underwater_usd": base_uw, "bad_debt_new": bd_new, "bad_debt_total": bd_total,
            "deficit": L["usdc_deficit"], "liq_volume": L["usdc_repay"].sum(axis=1), "n_calls": L["n_calls"],
            "bd_fam_underwater": L["bd_by_family_underwater"], "bd_fam_deficit": L["bd_by_family_deficit"],
            "min_cash": cmin, "min_cash_24h": cmin24, "cash_end": c, "blocked": blocked, "util_max": umax,
            "util_end": u_end, "bapr_end": bapr_end, "bapr_max": bapr_max, "sapr_end": sapr_end,
            "S0": S0, "C0": C0, "D0": D0, "u0": u0, "bapr0": float(curve_apr(u0, us["curve_ray"])),
            "sapr0": float(curve_apr(u0, us["curve_ray"]) * u0 * (1.0 - rf)),
            "stored_bapr0": us["vrate_ray"] / RAY, "stored_sapr0": us["lrate_ray"] / RAY}


def vault_metrics(res: dict, alloc: dict, withdrawal_usd: float) -> dict:
    """Per path: vault-share bad debt (pro rata of the reserve's new USDC bad debt), liquidity loss (allocation
    that could not leave at the worst hour), lock flags (min cash below the vault's withdrawal size)."""
    bd = 0.0
    ll = 0.0
    lock = {}
    for mk, a in alloc.items():
        r = res[mk]
        share = a / r["S0"]
        bd = bd + share * r["bad_debt_new"]
        ll = ll + np.maximum(a - r["min_cash"], 0.0)
        lock[mk] = r["min_cash"] < min(a, withdrawal_usd)
    return {"bad_debt": bd, "liquidity_loss": ll, "lock": lock}
