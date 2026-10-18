"""Q39 mechanism (prereg C.3): per-day seizure schedules on a 0.1% joint-shock grid, the fixed point, and the
cascade lead at a line.

Schedule: for grid multiplier g_k = 1 - 0.001 k (k = 0..600), ETH- and BTC-linked oracle prices both move by
g_k (C.1 joint shock). Positions are liquidated at the first grid step where HF < 1 (efficient liquidators),
with up to MAX_ROUNDS calls per step:
  aave/spark : vendored Aave call rule (callrule.m_call_vec); liquidator receives seized - protocol fee.
  v2         : Aave V2 / Compound V2 (aid test only): 50% of the chosen debt bucket per call.
  morpho     : repay = fM x debt (fM = development median repaid fraction), seize repay x LIF, capped.
  comet      : absorb the whole account; collateral enters reserves (sold only through buyCollateral).
Positions already at HF < 1 before any move are excluded (they were not liquidated in reality: dust or
unprofitable; decision D-Q39-3).
Output per venue: cumulative USD (at the shocked price) delivered to liquidators by class, sold[cls][k];
for comet: cumulative absorbed collateral USD by class and absorbed debt USD.
"""
from __future__ import annotations

import numpy as np

from callrule import m_call_vec

NG = 601
GRID = 1.0 - 0.001 * np.arange(NG)
MAX_ROUNDS = 6
DUST_USD = 1.0   # accounts with < $1 of debt are dust (decision D6n)


def _arr(rec, f):
    return rec[f].astype(float).copy()


def schedule(rec: np.ndarray, kind: str, fM: float = 1.0) -> dict:
    out = {"E": np.zeros(NG), "B": np.zeros(NG)}
    if kind == "comet":
        out.update({"absE": np.zeros(NG), "absB": np.zeros(NG), "absD": np.zeros(NG)})
    if len(rec) == 0:
        return out
    VE, VB, VO = _arr(rec, "VE"), _arr(rec, "VB"), _arr(rec, "VO")
    ltE, ltB, ltO = _arr(rec, "ltE"), _arr(rec, "ltB"), _arr(rec, "ltO")
    lbE, lbB, lbO = _arr(rec, "lbE"), _arr(rec, "lbB"), _arr(rec, "lbO")
    feE, feB, feO = _arr(rec, "feeE"), _arr(rec, "feeB"), _arr(rec, "feeO")
    DE, DB, DO, DM = _arr(rec, "DE"), _arr(rec, "DB"), _arr(rec, "DO"), _arr(rec, "DmaxO")
    # only accounts with shock-linked collateral can be pushed under by the shock
    hf0 = (ltE * VE + ltB * VB + ltO * VO) / np.maximum(DE + DB + DO, 1e-12)
    alive = (VE + VB > 0) & (DE + DB + DO >= DUST_USD) & (hf0 >= 1.0)
    cum = {"E": 0.0, "B": 0.0, "absE": 0.0, "absB": 0.0, "absD": 0.0}
    for k in range(NG):
        g = GRID[k]
        for _ in range(MAX_ROUNDS):
            num = ltE * VE * g + ltB * VB * g + ltO * VO
            den = DE * g + DB * g + DO
            with np.errstate(divide="ignore", invalid="ignore"):
                hf = np.where(den > 1e-9, num / den, np.inf)
            idx = np.where(alive & (hf < 1.0) & (VE + VB + VO > 1e-9))[0]
            if len(idx) == 0:
                break
            if kind == "comet":
                cum["absE"] += float((VE[idx] * g).sum())
                cum["absB"] += float((VB[idx] * g).sum())
                cum["absD"] += float(DO[idx].sum())
                VE[idx] = VB[idx] = VO[idx] = DE[idx] = DB[idx] = DO[idx] = DM[idx] = 0.0
                alive[idx] = False
                break
            if kind == "morpho":
                debt = DO[idx]
                coll = (VE[idx] + VB[idx]) * g
                lb = np.where(VE[idx] > 0, lbE[idx], lbB[idx])
                repay = np.minimum(fM * debt, debt)
                seized = repay * lb
                cap = seized >= coll
                seized = np.where(cap, coll, seized)
                repay = np.where(cap, coll / lb, repay)
                isE = VE[idx] > 0
                cum["E"] += float(seized[isE].sum())
                cum["B"] += float(seized[~isE].sum())
                VE[idx] = np.where(isE, VE[idx] - seized / g, 0.0)
                VB[idx] = np.where(~isE, VB[idx] - seized / g, 0.0)
                DO[idx] = np.where(cap, 0.0, DO[idx] - repay)   # Morpho realizes bad debt at zero collateral
                DM[idx] = DO[idx]
                continue
            # aave / spark (v3.3 rule); "v2" = Aave V2 / Compound V2: fixed 50% close factor on the chosen debt
            dE, dB, dO = DE[idx] * g, DB[idx] * g, DM[idx]
            j = np.argmax(np.column_stack([dE, dB, dO]), axis=1)
            debt_j = np.choose(j, [dE, dB, dO])
            cE, cB, cO = VE[idx] * g, VB[idx] * g, np.where(ltO[idx] > 0, VO[idx], 0.0)
            kk = np.argmax(np.column_stack([cE, cB, cO]), axis=1)
            coll_k = np.choose(kk, [cE, cB, cO])
            lb_k = np.choose(kk, [lbE[idx], lbB[idx], lbO[idx]])
            fe_k = np.choose(kk, [feE[idx], feB[idx], feO[idx]])
            td = dE + dB + DO[idx]
            if kind == "v2":
                lbk = np.maximum(lb_k, 1.0 + 1e-9)
                repay = 0.5 * debt_j
                seized = repay * lbk
                cap = seized > coll_k
                seized = np.where(cap, coll_k, seized)
                repay = np.where(cap, coll_k / lbk, repay)
                fee = (seized - seized / lbk) * fe_k
            else:
                repay, seized, fee, _ = m_call_vec(td, hf[idx], coll_k, debt_j, np.maximum(lb_k, 1.0 + 1e-9), fe_k, 0.0)
            got = seized - fee
            cum["E"] += float(got[kk == 0].sum())
            cum["B"] += float(got[kk == 1].sum())
            VE[idx] -= np.where(kk == 0, seized / g, 0.0)
            VB[idx] -= np.where(kk == 1, seized / g, 0.0)
            VO[idx] -= np.where(kk == 2, seized, 0.0)
            DE[idx] -= np.where(j == 0, repay / g, 0.0)
            DB[idx] -= np.where(j == 1, repay / g, 0.0)
            DO[idx] -= np.where(j == 2, repay, 0.0)
            DM[idx] -= np.where(j == 2, repay, 0.0)
            np.maximum(VE, 0, out=VE), np.maximum(VB, 0, out=VB), np.maximum(VO, 0, out=VO)
            np.maximum(DE, 0, out=DE), np.maximum(DB, 0, out=DB), np.maximum(DO, 0, out=DO)
            np.maximum(DM, 0, out=DM)
            # an account left with no collateral stops (Aave burns the deficit)
            dead = (VE + VB + VO) <= 1e-6
            alive &= ~dead
        for c in out:
            out[c][k] = cum[c]
    return out


# ------------------------------------------------------------------------------- fixed point
def sell_flow(sched: dict, asset: str, s: dict, comet_caps: dict | None = None) -> np.ndarray:
    """Q_A[k]: cumulative sold USD of class `asset` ('E' or 'B') on the grid. sched = {venue: schedule};
    s = {venue: sell-through}. comet_caps = {venue: base headroom USD at k=0 before absorbs}."""
    Q = np.zeros(NG)
    for v, sc in sched.items():
        if "absD" in sc:
            cap = (comet_caps or {}).get(v, 0.0)
            head = np.maximum(0.0, cap + sc["absD"])   # absorbs spend reserves, raising headroom by absorbed debt
            tot = sc["absE"] + sc["absB"]
            with np.errstate(divide="ignore", invalid="ignore"):
                share = np.where(tot > 0, sc["abs" + asset] / tot, 0.0)
            Q += s.get(v, 0.0) * np.minimum(sc["abs" + asset], head * share)
        else:
            Q += s.get(v, 0.0) * sc[asset]
    return Q


def overshoot(Q: np.ndarray, Yp: float, sigma_d: float, delta: float) -> np.ndarray:
    """o(m) <= 0 for starting moves m_k = -0.001 k (k = 0..600). Impact dlnP = -Yp * sigma_d * sqrt(Q)
    (V held constant and absorbed into Yp: deviation D3). The oracle prints only moves >= delta (C.3.3/C.3.5)."""
    o = np.zeros(NG)
    if Yp <= 0:
        return o
    for k in range(NG):
        g0 = GRID[k]
        p = g0
        for _ in range(200):
            kk = min(NG - 1, int(round((1.0 - p) / 0.001)))
            p_new = g0 * np.exp(-Yp * sigma_d * np.sqrt(max(Q[kk], 0.0)))
            if abs(np.log(p_new / p)) < delta:
                break
            p = p_new
            if p <= GRID[-1]:
                p = GRID[-1]
                break
        o[k] = np.log(p / g0)
    return o


def lead(o: np.ndarray, d: float) -> float:
    """c(d) = d - |m*|, m* the smallest starting move whose cascade reaches 1 - d (C.3.6)."""
    final = GRID * np.exp(o)
    hit = np.where(final <= 1.0 - d + 1e-12)[0]
    if len(hit) == 0:
        return 0.0
    m_star = hit[0] / 1000.0
    return max(0.0, round(d - m_star, 6))


# ------------------------------------------------------------------------------- naive baseline (C.5.4)
def naive_density(rec_list: list[np.ndarray], asset: str) -> np.ndarray:
    """D_all[k]: all class-`asset` collateral USD (at the shocked price) of accounts whose HF < 1 at g_k,
    100% sold, no close factor."""
    D = np.zeros(NG)
    for rec in rec_list:
        if len(rec) == 0:
            continue
        VE, VB, VO = rec["VE"], rec["VB"], rec["VO"]
        num0 = rec["ltO"] * VO
        a = rec["ltE"] * VE + rec["ltB"] * VB
        den0 = rec["DO"]
        b = rec["DE"] + rec["DB"]
        hf0 = (a + num0) / np.maximum(den0 + b, 1e-12)
        ok = (VE + VB > 0) & (hf0 >= 1.0) & (den0 + b >= DUST_USD)
        # HF(g) = (a g + num0)/(b g + den0) < 1  <=>  g (a - b) < den0 - num0
        with np.errstate(divide="ignore", invalid="ignore"):
            gl = np.where(a - b > 0, (den0 - num0) / (a - b), -np.inf)
        V = VE if asset == "E" else VB
        sel = ok & (V > 0) & (gl > GRID[-1])
        gl, Vs = gl[sel], V[sel]
        ks = np.clip(np.ceil((1.0 - gl) / 0.001).astype(int), 0, NG - 1)
        add = np.zeros(NG)
        np.add.at(add, ks, Vs)
        D += np.cumsum(add) * GRID
    return D


def naive_overshoot(D: np.ndarray, lam: float) -> np.ndarray:
    o = np.zeros(NG)
    for k in range(NG):
        p = GRID[k] * max(1e-6, 1.0 - lam * D[k])
        o[k] = np.log(p / GRID[k])
    return o
