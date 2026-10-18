"""Forward liquidation engine on simulated paths (R11.1-v3 call rule, vectorised over paths).

Per account (USD at the t0 oracle): collateral families E (ETH-family), B (BTC-family) and O (all other
collateral, held constant); debt buckets USDC, E-debt, B-debt and other debt (constant). The family LT, bonus and
protocol fee are value-weighted over the account's enabled reserves of the family, e-mode aware
(c1_baddebt.liq.effective_lt / effective_bonus). O's LT comes from the account's own totals; its bonus and fee
are the median of the pool's other collateral reserves (disclosed approximation).

Call rule: r111v3_engine.M_call (R10.1 rule: largest debt bucket, largest eligible collateral bucket, v3.3 close
factor on total debt, seize cap, $1,000 leftover rule, protocol fee), vectorised as m_call_vec (tested equal on
random inputs). Liquidator filter (design 2.6): proceeds after DEX shortfall (Uniswap v3 depth, R8.5 impairment)
minus repay minus gas >= 0, gross >= the $6.43 dust minimum; when the full call fails the filter the liquidator
tries 50 %, 25 % and 10 % of it (C1 search). Prices are oracle prices at two sub-steps per hour (low, close).
Bad debt (design 2.6): deficits burned when an account is left with no collateral, plus max(0, debt - collateral)
of every account at the horizon close, booked once per path; the USDC share is the account's USDC-debt share.
"""
from __future__ import annotations

import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
from c1_baddebt import liq as LQ  # noqa: E402

from sim1 import config as CFG  # noqa: E402

FAM_COLL = ("E", "B", "O")
EPS_USD = 1e-6


def positions(state: dict, market: str) -> dict:
    """Account arrays from a slice-1 state snapshot. No address is kept in the output."""
    m = CFG.MARKETS[market]
    R = state["reserves"]
    em = state["emode"]
    usdc = R[m["usdc"]]
    up = usdc["price"] / 1e8
    others = [r for r in R.values() if r["family"] == "O" and r["lt"] > 0]
    lb_o = float(np.median([r["lb"] for r in others])) / 1e4 if others else 1.05
    fee_o = float(np.median([r["fee"] for r in others])) / 1e4 if others else 0.1
    rows = []
    for _, a in sorted(state["accounts"].items()):
        bal = a["bal"]
        du = bal.get("d:" + m["usdc"], 0) / 10 ** usdc["decimals"] * up
        if du <= 0:
            continue
        acc = {f: {"V": 0.0, "S": 0.0, "LB": 0.0, "FEE": 0.0} for f in ("E", "B")}
        debt = {"E": 0.0, "B": 0.0}
        for asset, r in R.items():
            if r["family"] not in ("E", "B"):
                continue
            px = r["price"] / 1e8
            units = bal.get("a:" + asset, 0) / 10 ** r["decimals"]
            enabled = bool((a["config"] >> (2 * r["id"] + 1)) & 1)
            lt = LQ.effective_lt(r["lt"], r["id"], a["emode"], em) if a["emode"] else r["lt"]
            if units > 0 and enabled and lt > 0:
                lb = LQ.effective_bonus(r["lb"], r["id"], a["emode"], em) if a["emode"] else r["lb"]
                v = units * px
                f = acc[r["family"]]
                f["V"] += v
                f["S"] += v * lt / 1e4
                f["LB"] += v * lb / 1e4
                f["FEE"] += v * r["fee"] / 1e4
            dunits = bal.get("d:" + asset, 0) / 10 ** r["decimals"]
            debt[r["family"]] += dunits * px
        tc = a["totalCollateralBase"] / 1e8
        td = a["totalDebtBase"] / 1e8
        s_tot = tc * a["currentLiquidationThreshold"] / 1e4
        ve, vb = acc["E"]["V"], acc["B"]["V"]
        se, sb = acc["E"]["S"], acc["B"]["S"]
        vo = max(tc - ve - vb, 0.0)
        so = max(s_tot - se - sb, 0.0)
        do = max(td - du - debt["E"] - debt["B"], 0.0)
        den = do + du + debt["E"] + debt["B"]
        rows.append({
            "VE": ve, "VB": vb, "VO": vo,
            "ltE": se / ve if ve > 0 else 0.0, "ltB": sb / vb if vb > 0 else 0.0, "ltO": so / vo if vo > 0 else 0.0,
            "lbE": acc["E"]["LB"] / ve if ve > 0 else 1.0, "lbB": acc["B"]["LB"] / vb if vb > 0 else 1.0,
            "lbO": lb_o,
            "feeE": acc["E"]["FEE"] / ve if ve > 0 else 0.0, "feeB": acc["B"]["FEE"] / vb if vb > 0 else 0.0,
            "feeO": fee_o,
            "DU": du, "DE": debt["E"], "DB": debt["B"], "DO": do,
            "hf_chain": a["healthFactor"] / 1e18,
            "hf_model": (so + se + sb) / den if den > 0 else np.inf,
        })
    P = {k: np.array([r[k] for r in rows], float) for k in rows[0]} if rows else {}
    P["n"] = len(rows)
    dom = np.argmax(np.column_stack([P["VE"], P["VB"], P["VO"]]), axis=1) if rows else np.array([], int)
    P["dominant"] = dom
    return P


def hf_at(P: dict, mE, mB, i=None):
    sl = slice(None) if i is None else i
    num = P["ltE"][sl] * P["VE"][sl] * mE + P["ltB"][sl] * P["VB"][sl] * mB + P["ltO"][sl] * P["VO"][sl]
    den = P["DU"][sl] + P["DE"][sl] * mE + P["DB"][sl] * mB + P["DO"][sl]
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(den > 0, num / den, np.inf)


def candidates(P: dict, mE_lo, mE_hi, mB_lo, mB_hi) -> np.ndarray:
    """Accounts whose HF can fall below 1 inside the box of oracle multipliers (HF is linear-fractional in
    (mE, mB), so its minimum over a box sits at a corner)."""
    hs = [hf_at(P, a, b) for a in (mE_lo, mE_hi) for b in (mB_lo, mB_hi)]
    return np.where(np.min(hs, axis=0) < 1.0)[0]


def m_call_vec(td, hf, coll_k, debt_j, lb_k, fee_k, cost):
    """Vectorised r111v3_engine.M_call with day.v33 = True. Returns repay, seized, fee, profit."""
    partial = (coll_k >= 2000.0) & (debt_j >= 2000.0) & (hf > 0.95)
    repay = np.where(partial & (debt_j > 0.5 * td), 0.5 * td, debt_j)
    seized = repay * lb_k
    cap = seized > coll_k
    seized = np.where(cap, coll_k, seized)
    repay = np.where(cap, coll_k / lb_k, repay)
    left = (~cap) & (repay < debt_j) & ((debt_j - repay < 1000.0) | (coll_k - seized < 1000.0))
    repay = np.where(left, debt_j, repay)
    seized = np.where(left, repay * lb_k, seized)
    cap2 = left & (seized > coll_k)
    seized = np.where(cap2, coll_k, seized)
    repay = np.where(cap2, coll_k / lb_k, repay)
    fee = (seized - seized / lb_k) * fee_k
    profit = (seized - fee) - repay - cost
    return repay, seized, fee, profit


def run(P: dict, idx: np.ndarray, oE: np.ndarray, oB: np.ndarray, closeE: np.ndarray, closeB: np.ndarray,
        curves: dict, px0: dict, phi: np.ndarray, gas_usd: float, dust_usd: float) -> dict:
    """Simulate liquidations of accounts idx (processed in t0-HF order) on oracle sub-step multipliers oE, oB
    (n, 2T). closeE/closeB (n, T + 1): horizon-close multipliers for end-of-path bad debt. phi (n, T + 1)."""
    n, S2 = oE.shape
    T = S2 // 2
    usdc_repay = np.zeros((n, T))
    usdc_deficit = np.zeros(n)
    bd_end = np.zeros(n)
    bd_fam = np.zeros((3, n))
    seized_usd = np.zeros(n)
    n_calls = np.zeros(n, dtype=np.int64)
    n_unprofitable = np.zeros(n, dtype=np.int64)
    sold = {"E": np.zeros((n, T)), "B": np.zeros((n, T))}
    bd_fam_def = np.zeros((3, n))
    order = idx[np.argsort(P["hf_model"][idx], kind="stable")]
    for i in order:
        # paths where the untouched account ever has HF < 1 (no other path can see a call or end underwater)
        hf_static = hf_at(P, oE, oB, i)
        hit = hf_static.min(axis=1) < 1.0
        if not hit.any():
            continue
        rows = np.where(hit)[0]
        s_first = int(np.argmax((hf_static[rows] < 1.0).any(axis=0)))
        r = len(rows)
        oEr, oBr = oE[rows], oB[rows]
        cE = np.full(r, P["VE"][i])
        cB = np.full(r, P["VB"][i])
        cO = np.full(r, P["VO"][i])
        dU = np.full(r, P["DU"][i])
        dE = np.full(r, P["DE"][i])
        dB = np.full(r, P["DB"][i])
        dO = np.full(r, P["DO"][i])
        lt = np.array([P["ltE"][i], P["ltB"][i], P["ltO"][i]])
        lb = np.array([P["lbE"][i], P["lbB"][i], P["lbO"][i]])
        fe = np.array([P["feeE"][i], P["feeB"][i], P["feeO"][i]])
        elig = lt > 0
        defic = np.zeros(r, bool)
        for s in range(s_first, S2):
            h = s // 2
            mE, mB = oEr[:, s], oBr[:, s]
            stop = np.zeros(r, bool)
            for _ in range(CFG.MAX_CALLS):
                coll = np.column_stack([cE * mE, cB * mB, cO]) * elig[None, :]
                debt = np.column_stack([dU, dE * mE, dB * mB, dO])
                td = debt.sum(axis=1)
                num = coll @ lt
                with np.errstate(divide="ignore", invalid="ignore"):
                    hf = np.where(td > EPS_USD, num / td, np.inf)
                act = (hf < 1.0) & (coll.sum(axis=1) > EPS_USD) & ~stop & ~defic
                if not act.any():
                    break
                a = np.where(act)[0]
                ga = rows[a]                       # global path ids
                j = np.argmax(debt[a], axis=1)
                k = np.argmax(coll[a], axis=1)
                ck = coll[a, k]
                dj = debt[a, j]
                lbk, fek = lb[k], fe[k]
                best = np.full(len(a), -1.0)
                rep_c = np.zeros(len(a))
                sz_c = np.zeros(len(a))
                units_c = np.zeros(len(a))
                for frac in CFG.REPAY_FRACTIONS:
                    rep, sz, fee, prof = m_call_vec(td[a], hf[a], ck, dj, lbk, fek, gas_usd)
                    if frac < 1.0:
                        rep = rep * frac
                        sz = np.minimum(rep * lbk, ck)
                        rep = np.minimum(rep, sz / lbk)
                        fee = (sz - sz / lbk) * fek
                        prof = (sz - fee) - rep - gas_usd
                    units = np.zeros(len(a))
                    slip = np.zeros(len(a))
                    for fi, fam in ((0, "E"), (1, "B")):
                        mk = k == fi
                        if not mk.any() or curves.get(fam) is None:
                            continue
                        pr = px0[fam] * (mE[a[mk]] if fam == "E" else mB[a[mk]])
                        u = (sz[mk] - fee[mk]) / pr
                        cum = sold[fam][ga[mk], h]
                        ph = phi[ga[mk], h + 1]
                        cv = curves[fam]
                        slip[mk] = (cv.shortfall_phi(cum + u, ph) - cv.shortfall_phi(cum, ph)) * pr
                        units[mk] = u
                    net = prof - slip
                    ok = (best < 0) & (net >= 0) & (prof + gas_usd >= dust_usd) & (rep > 0)
                    best = np.where(ok, net, best)
                    rep_c = np.where(ok, rep, rep_c)
                    sz_c = np.where(ok, sz, sz_c)
                    units_c = np.where(ok, units, units_c)
                done = best >= 0
                stop[a[~done]] = True
                n_unprofitable[ga[~done]] += 1
                if not done.any():
                    continue
                a2, j2, k2 = a[done], j[done], k[done]
                g2 = rows[a2]
                rp, sz, un = rep_c[done], sz_c[done], units_c[done]
                for jj, arr, mult in ((0, dU, None), (1, dE, mE), (2, dB, mB), (3, dO, None)):
                    mk = j2 == jj
                    if mk.any():
                        qd = rp[mk] if mult is None else rp[mk] / mult[a2[mk]]
                        arr[a2[mk]] = np.maximum(arr[a2[mk]] - qd, 0.0)
                        if jj == 0:
                            usdc_repay[g2[mk], h] += rp[mk]
                for kk, arr, mult, fam in ((0, cE, mE, "E"), (1, cB, mB, "B"), (2, cO, None, None)):
                    mk = k2 == kk
                    if mk.any():
                        qc = sz[mk] if mult is None else sz[mk] / mult[a2[mk]]
                        arr[a2[mk]] = np.maximum(arr[a2[mk]] - qc, 0.0)
                        if fam is not None:
                            sold[fam][g2[mk], h] += un[mk]
                seized_usd[g2] += sz
                n_calls[g2] += 1
            # deficit (v3.3): no collateral left and debt remaining -> burned
            gone = (~defic) & ((cE * elig[0] + cB * elig[1] + cO * elig[2]) <= EPS_USD) & \
                   ((dU + dE + dB + dO) > EPS_USD)
            if gone.any():
                usdc_deficit[rows[gone]] += dU[gone]
                bd_fam_def[int(P["dominant"][i])][rows[gone]] += dU[gone]
                defic |= gone
        mEe, mBe = closeE[rows, -1], closeB[rows, -1]
        coll_end = cE * mEe + cB * mBe + cO
        debt_end = dU + dE * mEe + dB * mBe + dO
        with np.errstate(divide="ignore", invalid="ignore"):
            share_u = np.where(debt_end > 0, dU / debt_end, 0.0)
        under = np.where(~defic, np.maximum(debt_end - coll_end, 0.0) * share_u, 0.0)
        bd_end[rows] += under
        bd_fam[int(P["dominant"][i])][rows] += under
    return {"usdc_repay": usdc_repay, "usdc_deficit": usdc_deficit, "bd_underwater": bd_end,
            "bd_by_family_underwater": bd_fam, "seized_usd": seized_usd, "n_calls": n_calls,
            "n_unprofitable_checks": n_unprofitable, "sold": sold, "order": order, "bd_by_family_deficit": bd_fam_def}
