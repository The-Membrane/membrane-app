"""C1 engine: subject positions at an anchor, liquidations along ETH paths, bad debt booked once per path.

Subject (R8.5): Aave V3 Core accounts with USDC variable debt > 0 and ETH-family collateral (WETH, wstETH,
weETH, rsETH) enabled with a positive balance at the anchor block.

Per account (USD at the anchor oracle):
  ETH-family collateral i: units u_i, price p_i * m(t), LT_i and LB_i (e-mode aware), protocol fee_i.
  USDC debt D_u (constant price). ETH-family debt E (moves with m). Other collateral C_o with its LT-weighted
  sum S_o, and other debt D_o, held constant (DECISION C1-D5). HF(m) = (S_o + m*sum LT_i u_i p_i) / (D_o + D_u + m*E).
Liquidators repay USDC and seize ETH-family collateral only (the subject pair), each hour at the hour low and
then at the hour close, in anchor-HF order, at most MAX_ROUNDS calls per account per sub-step. A call happens
only if (collateral to liquidator sold through the LST pool, then the WETH/USDC curve, at the hour's cumulative
sold volume and impaired depth) - repaid USDC - gas > 0; the liquidator picks the repay among
REPAY_FRACTIONS x max-liquidatable that maximises profit (Chaos-style single search).
Bad debt (booked once, at the horizon): deficits burned when an account is left with no collateral, plus
max(0, debt - collateral) of every other account at the horizon close.
"""
from __future__ import annotations

import numpy as np

from c1_baddebt import liq as LQ

ETH_NAMES = ("WETH", "wstETH", "weETH", "rsETH")
REPAY_FRACTIONS = (0.1, 0.25, 0.5, 0.75, 1.0)
MAX_ROUNDS = 6
GAS_ETH = 0.01          # DECISION C1-D6: ~500k gas at 20 gwei per liquidation call


def positions_from_snapshot(snap: dict) -> tuple[list[dict], dict]:
    R = snap["reserves"]
    em = snap.get("emode", {})
    usdc_p = R["USDC"]["price"] / 1e8
    out, skipped = [], {"no_eth_collateral": 0, "no_usdc_debt": 0}
    for addr, a in snap["accounts"].items():
        du = a["d_USDC"] / 10**R["USDC"]["decimals"] * usdc_p
        if du <= 0:
            skipped["no_usdc_debt"] += 1
            continue
        coll = []
        for n in ETH_NAMES:
            r = R[n]
            units = a["a_" + n] / 10**r["decimals"]
            _, enabled = (bool((a["config"] >> (2 * r["id"])) & 1), bool((a["config"] >> (2 * r["id"] + 1)) & 1))
            lt = LQ.effective_lt(r["lt"], r["id"], a["emode"], em)
            if units > 0 and enabled and lt > 0:
                lb = LQ.effective_bonus(r["lb"], r["id"], a["emode"], em)
                coll.append({"asset": n, "units": units, "price": r["price"] / 1e8, "lt": lt / 1e4, "lb": lb / 1e4,
                             "fee": r["protocol_fee"] / 1e4})
        if not coll:
            skipped["no_eth_collateral"] += 1
            continue
        tc = a["totalCollateralBase"] / 1e8
        td = a["totalDebtBase"] / 1e8
        s_tot = tc * a["currentLiquidationThreshold"] / 1e4
        ve = sum(c["units"] * c["price"] for c in coll)
        se = sum(c["units"] * c["price"] * c["lt"] for c in coll)
        e_debt = sum(a["d_" + n] / 10**R[n]["decimals"] * R[n]["price"] / 1e8 for n in ETH_NAMES)
        c_o = max(tc - ve, 0.0)
        s_o = max(s_tot - se, 0.0)
        d_o = max(td - du - e_debt, 0.0)
        coll.sort(key=lambda c: -c["units"] * c["price"])
        hf_chain = a["healthFactor"] / 1e18
        hf_model = (s_o + se) / (d_o + du + e_debt) if (d_o + du + e_debt) > 0 else np.inf
        A = se
        m_liq = (d_o + du - s_o) / (A - e_debt) if A > e_debt else 0.0
        out.append({"addr": addr, "coll": coll, "du": du, "e_debt": e_debt, "c_o": c_o, "s_o": s_o, "d_o": d_o,
                    "hf_chain": hf_chain, "hf_model": hf_model, "m_liq": m_liq, "debt_total": td, "coll_total": tc})
    out.sort(key=lambda p: p["hf_model"])
    return out, skipped


def run(positions: list[dict], close_m: np.ndarray, low_m: np.ndarray, phi: np.ndarray, curves: dict,
        eth_price: float, usdc_price: float, horizons: dict[str, int]) -> dict:
    """close_m/low_m/phi: (n, H + 1). curves: {'ETH': Curve, 'wstETH': Curve, ...} (LST curves in LST units,
    sold for WETH). Returns per-path arrays per horizon label: liquidation volume (USDC repaid, USD),
    collateral seized (USD), bad debt (USD), deficits (USD)."""
    n, H1 = close_m.shape
    H = H1 - 1
    vol_t = np.zeros((n, H1))
    seized_t = np.zeros((n, H1))
    deficit_t = np.zeros((n, H1))
    gas_usd_per_m = GAS_ETH * eth_price
    weth_price = eth_price
    m_global_min = float(low_m.min())
    # per-hour cumulative sold volume (reset every hour; shared by all accounts of a path)
    state = []
    for p in positions:
        if p["m_liq"] <= m_global_min and p["hf_model"] >= 1.0:
            state.append(None)
            continue
        st = {"u": np.array([[c["units"]] * n for c in p["coll"]]), "du": np.full(n, p["du"]),
              "closed": np.zeros(n, bool), "touched": np.zeros(n, bool)}
        state.append(st)
    active_idx = [i for i, s in enumerate(state) if s is not None]
    q_eth = np.zeros(n)
    q_lst = {k: np.zeros(n) for k in ETH_NAMES if k != "WETH"}
    for t in range(1, H1):
        q_eth[:] = 0.0
        for v in q_lst.values():
            v[:] = 0.0
        ph = phi[:, t]
        for sub in (low_m[:, t], close_m[:, t]):
            for i in active_idx:
                p, st = positions[i], state[i]
                cand = ((sub < p["m_liq"]) | st["touched"]) & ~st["closed"]
                if not cand.any():
                    continue
                for _ in range(MAX_ROUNDS):
                    idx = np.nonzero(cand)[0]
                    if idx.size == 0:
                        break
                    m = sub[idx]
                    u = st["u"][:, idx]
                    du = st["du"][idx]
                    ce = np.zeros(idx.size)
                    se = np.zeros(idx.size)
                    for k, c in enumerate(p["coll"]):
                        ce += u[k] * c["price"] * m
                        se += u[k] * c["price"] * c["lt"] * m
                    debt = p["d_o"] + du + p["e_debt"] * m
                    hf = (p["s_o"] + se) / np.maximum(debt, 1e-12)
                    liq = (hf < 1.0) & (du > 1e-9) & (ce > 1e-9)
                    if not liq.any():
                        break
                    # collateral reserve: first held asset (anchor value order)
                    k_sel = np.full(idx.size, -1)
                    for k in range(len(p["coll"]) - 1, -1, -1):
                        k_sel = np.where(u[k] > 1e-12, k, k_sel)
                    best_profit = np.full(idx.size, -np.inf)
                    best = None
                    for k, c in enumerate(p["coll"]):
                        sel = liq & (k_sel == k)
                        if not sel.any():
                            continue
                        j = np.nonzero(sel)[0]
                        pi = c["price"] * m[j]
                        coll_usd = u[k, j] * pi
                        mx = LQ.max_debt_float(np, du[j], coll_usd, debt[j], hf[j])
                        for f in REPAY_FRACTIONS:
                            to_liq, fee, repay, seized = LQ.seize_float(np, f * mx, u[k, j], pi, c["lb"], c["fee"])
                            left_d = (du[j] - repay) * usdc_price
                            left_c = (u[k, j] - seized) * pi
                            ok = ((left_d >= 1000) & (left_c >= 1000)) | (seized >= u[k, j] * (1 - 1e-12)) | \
                                 (repay >= du[j] * (1 - 1e-12))
                            gi = idx[j]
                            if c["asset"] == "WETH":
                                weth = to_liq
                            else:
                                cv = curves[c["asset"]]
                                ql = q_lst[c["asset"]][gi]
                                lost = cv.shortfall_phi(ql + to_liq, ph[gi]) - cv.shortfall_phi(ql, ph[gi])
                                weth = (to_liq - lost) * (c["price"] / weth_price)
                            qe = q_eth[gi]
                            ce_ = curves["ETH"]
                            lost_e = ce_.shortfall_phi(qe + weth, ph[gi]) - ce_.shortfall_phi(qe, ph[gi])
                            usd = (weth - lost_e) * weth_price * m[j]
                            profit = usd - repay * usdc_price - gas_usd_per_m * m[j]
                            profit = np.where(ok, profit, -np.inf)
                            better = profit > best_profit[j]
                            if better.any():
                                if best is None:
                                    best = {"k": np.full(idx.size, -1), "repay": np.zeros(idx.size),
                                            "seized": np.zeros(idx.size), "to_liq": np.zeros(idx.size),
                                            "weth": np.zeros(idx.size), "lst": np.zeros(idx.size)}
                                jb = j[better]
                                best_profit[jb] = profit[better]
                                best["k"][jb] = k
                                best["repay"][jb] = repay[better]
                                best["seized"][jb] = seized[better]
                                best["to_liq"][jb] = to_liq[better]
                                best["weth"][jb] = weth[better]
                                best["lst"][jb] = np.where(c["asset"] == "WETH", 0.0, to_liq[better])
                    go = best_profit > 0
                    if best is None or not go.any():
                        break
                    jg = np.nonzero(go)[0]
                    gi = idx[jg]
                    for k, c in enumerate(p["coll"]):
                        kk = best["k"][jg] == k
                        if kk.any():
                            st["u"][k, gi[kk]] -= best["seized"][jg[kk]]
                            st["u"][k, gi[kk]] = np.maximum(st["u"][k, gi[kk]], 0.0)
                            if c["asset"] != "WETH":
                                q_lst[c["asset"]][gi[kk]] += best["lst"][jg[kk]]
                            seized_t[gi[kk], t] += best["seized"][jg[kk]] * c["price"] * m[jg[kk]]
                    st["du"][gi] = np.maximum(st["du"][gi] - best["repay"][jg], 0.0)
                    q_eth[gi] += best["weth"][jg]
                    vol_t[gi, t] += best["repay"][jg] * usdc_price
                    st["touched"][gi] = True
                    # deficit: no collateral left at all (ETH family empty and no other collateral)
                    if p["c_o"] <= 0:
                        empty = st["u"][:, gi].sum(axis=0) <= 1e-12
                        if empty.any():
                            ge = gi[empty]
                            deficit_t[ge, t] += st["du"][ge] + p["d_o"] + p["e_debt"] * sub[ge]
                            st["closed"][ge] = True
                            st["du"][ge] = 0.0
                    cand = np.zeros(n, bool)
                    cand[gi] = True
                    cand &= ~st["closed"]
    out = {}
    for lab, h in horizons.items():
        mh = close_m[:, h]
        bad = deficit_t[:, :h + 1].sum(axis=1).copy()
        for i, p in enumerate(positions):
            st = state[i]
            if st is None:
                u = np.array([[c["units"]] for c in p["coll"]])
                du = np.full(n, p["du"])
                closed = np.zeros(n, bool)
            else:
                u, du, closed = st["u"], st["du"], st["closed"]
            ce = sum(u[k] * c["price"] * mh for k, c in enumerate(p["coll"]))
            debt = p["d_o"] + du + p["e_debt"] * mh
            bad += np.where(closed, 0.0, np.maximum(debt - (ce + p["c_o"]), 0.0))
        out[lab] = {"volume": vol_t[:, 1:h + 1].sum(axis=1), "seized": seized_t[:, 1:h + 1].sum(axis=1),
                    "bad_debt": bad, "deficit": deficit_t[:, :h + 1].sum(axis=1)}
    return out


def run_horizons(positions, close_m, low_m, phi, curves, eth_price, usdc_price, horizons: dict[str, int]) -> dict:
    """One engine run per horizon on the truncated paths, so the end-of-horizon book uses the state at h."""
    res = {}
    for lab, h in horizons.items():
        r = run(positions, close_m[:, :h + 1], low_m[:, :h + 1], phi[:, :h + 1], curves, eth_price, usdc_price,
                {lab: h})
        res[lab] = r[lab]
    return res


def anchor_underwater(positions: list[dict]) -> float:
    """Bad debt already open at the anchor (debt above collateral at m = 1)."""
    s = 0.0
    for p in positions:
        ce = sum(c["units"] * c["price"] for c in p["coll"])
        s += max(p["d_o"] + p["du"] + p["e_debt"] - ce - p["c_o"], 0.0)
    return s
