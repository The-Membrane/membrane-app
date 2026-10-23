#!/usr/bin/env python3
"""Q26 R18.4 reusable cash engine: explicit mechanical borrow cap + behavioural deposit/repay (D+Rp) channel.

membrane-board design/Q26_ROUND18_PREREG.md R18.4 (cap accounting, part 3: the simulator-engine function).

Hourly order inside one hour (the same order as the R18.3/R18.4 synthetic pools and the Aave pool):
  1. deposits D and repays Rp arrive (cash +D +Rp; debt -Rp);
  2. withdrawals W execute FIFO against cash; the rest queues (cash never below 0);
  3. borrows execute against the cash that is left: executed = min(demand, cash before borrows).
     This cap is PARAMETER-FREE. The unexecuted part is "blocked borrow demand".
  4. utilisation = debt / supply, and the rate follows the on-chain curve.

What belongs where (parent decision D-R18.3-review, kept by R18.4):
  - mechanical: the cap (step 3) and the queue (step 2) live in the engine, never in a refill kernel;
  - behavioural: only deposits + repays respond to the rate (a class S kernel, e.g. r184_kernel SR-DR);
  - borrow demand has its own model (level dynamics, optional partial retry of blocked demand). Its retry is a
    property of borrowers, so it is a parameter of the borrow-demand model, not of the cap.

No address, no I/O. Pure numpy. Arrays may carry leading batch dimensions (paths x origins); time is the last axis.
"""
from __future__ import annotations

import numpy as np


def curve_rate(u, opt, s1, s2, base=0.0):
    """Aave variable borrow rate at utilisation u (fractions)."""
    u = np.clip(u, 0.0, 1.0)
    return np.where(u <= opt, base + s1 * u / opt, base + s1 + s2 * (u - opt) / (1.0 - opt))


def supply_rate(u, opt, s1, s2, base, rf):
    return curve_rate(u, opt, s1, s2, base) * np.clip(u, 0.0, 1.0) * (1.0 - rf)


def cap_borrows(cash_before_borrows, demand):
    """The mechanical borrow cap. Returns (executed, blocked). Parameter-free."""
    avail = np.maximum(cash_before_borrows, 0.0)
    ex = np.minimum(np.maximum(demand, 0.0), avail)
    return ex, np.maximum(demand, 0.0) - ex


def hour_step(cash, supply, debt, queue, D, Rp, W_new, B_demand, retry_pool=None, retry_frac=0.0, retry_mean=1.0):
    """One engine hour. All inputs are arrays of one shape (USD). Returns a dict with the new state and the
    executed / blocked parts. retry_pool: pending blocked borrow demand; each hour 1/retry_mean of it comes back as
    demand, and retry_frac of newly blocked demand joins it (borrow-demand model parameters; 0 = no retry)."""
    rel = 0.0 if retry_pool is None else retry_pool / max(retry_mean, 1.0)
    pool = None if retry_pool is None else retry_pool - rel
    Rp = np.minimum(Rp, debt)
    cash = cash + D + Rp
    supply = supply + D
    debt = debt - Rp
    q = queue + W_new
    Wx = np.minimum(q, np.maximum(cash, 0.0))
    cash, supply, q = cash - Wx, supply - Wx, q - Wx
    Bx, blk = cap_borrows(cash, B_demand + rel)
    cash, debt = cash - Bx, debt + Bx
    if pool is not None:
        pool = pool + retry_frac * blk
    return {"cash": cash, "supply": supply, "debt": debt, "queue": q, "W_exec": Wx, "B_exec": Bx, "B_blocked": blk,
            "retry_release": rel, "retry_pool": pool}


def shock_path(base, X, dr_response, retry_frac=0.0, retry_mean=1.0):
    """Counterfactual of an extra withdrawal X (USD) in hour 0 against a base path, with the cap explicit.

    base: dict of arrays (..., L) for hours 0..L-1 (hour 0 = the shock hour): cash (end of hour, >= 0), S, debt,
      B (executed borrows; used as borrow demand in both arms), opt, s1, s2, base_rate, rf.
    dr_response(j, dz_hist, dzb_hist) -> extra D and Rp in hour j (USD, two arrays), given the histories (..., j)
      of the supply-rate change dz and the borrow-rate change dzb (shocked - base) for hours 0..j-1. Pass None for
      the mechanical part only.
    Returns per-hour extra flows (shocked - base): dD, dRp, blocked (borrows not executed because of the shock,
    net of any retry), dW (shock withdrawals executed), and the spread change dz.
    """
    X = np.asarray(X, float)
    L = base["cash"].shape[-1]
    shp = np.broadcast_shapes(X.shape, base["cash"].shape[:-1])
    out = {k: np.zeros(shp + (L,)) for k in ("dD", "dRp", "blocked", "dW", "dz", "dzb", "queue")}
    q = np.broadcast_to(X, shp).astype(float).copy()         # shock demand not yet executed
    gap_cash = np.zeros(shp)        # shocked cash - base cash (<= 0) carried to the next hour
    dS = np.zeros(shp)
    dDebt = np.zeros(shp)
    pool = np.zeros(shp)
    for j in range(L):
        dD, dRp = (np.zeros(shp), np.zeros(shp)) if (dr_response is None or j == 0) else dr_response(j, out["dz"][..., :j],
                                                                                         out["dzb"][..., :j])
        # base hour j: cash end c, executed borrows Bb; base cash before borrows = c + Bb
        c, Bb = base["cash"][..., j], base["B"][..., j]
        rel = pool / max(retry_mean, 1.0)
        pool = pool - rel
        pre = c + Bb + gap_cash + dD + dRp            # shocked cash after D, Rp and base withdrawals
        Wx = np.minimum(q, np.maximum(pre, 0.0))
        q = q - Wx
        pre = pre - Wx
        ex, _ = cap_borrows(pre, Bb + rel)
        blk = Bb + rel - ex                             # demand the cap stopped this hour
        pool = pool + retry_frac * np.maximum(blk - rel, 0.0) if retry_frac > 0 else pool
        cash_s = pre - ex
        gap_cash = cash_s - c
        dS = dS + dD - Wx
        dDebt = dDebt - dRp + (ex - Bb)
        S_s = base["S"][..., j] + dS
        debt_s = base["debt"][..., j] + dDebt
        u_s = np.where(q > 1e-6, 1.0, debt_s / np.maximum(S_s, 1.0))
        u_b = base["debt"][..., j] / np.maximum(base["S"][..., j], 1.0)
        a = (base["opt"][..., j], base["s1"][..., j], base["s2"][..., j], base["base_rate"][..., j], base["rf"][..., j])
        out["dz"][..., j] = supply_rate(u_s, *a) - supply_rate(u_b, *a)
        out["dzb"][..., j] = curve_rate(u_s, *a[:4]) - curve_rate(u_b, *a[:4])
        out["dD"][..., j], out["dRp"][..., j] = dD, dRp
        out["blocked"][..., j] = Bb - ex                # net of retry: base executed minus shocked executed
        out["dW"][..., j] = Wx
        out["queue"][..., j] = q
    return out


def self_test():
    """Known answers for the cap (run by `python3 r184_engine.py`)."""
    ex, blk = cap_borrows(np.array([5.0, 0.0, -3.0]), np.array([3.0, 2.0, 1.0]))
    assert np.allclose(ex, [3, 0, 0]) and np.allclose(blk, [0, 2, 1])
    # a shock larger than cash: no borrow executes while the queue is open, blocked = base borrows
    L = 4
    base = {"cash": np.full(L, 10.0), "S": np.full(L, 100.0), "debt": np.full(L, 90.0), "B": np.full(L, 4.0),
            "opt": np.full(L, 0.9), "s1": np.full(L, 0.04), "s2": np.full(L, 0.6), "base_rate": np.zeros(L),
            "rf": np.full(L, 0.1)}
    o = shock_path(base, np.array(30.0), None)
    # hour 0: pre = 14, W executes 14, queue 16, borrows 0 -> blocked 4; later hours: pre = 14 - 10 (gap) ...
    assert np.isclose(o["dW"][0], 14.0) and np.isclose(o["blocked"][0], 4.0)
    assert np.all(o["dz"] > 0)
    tot = o["dW"].sum() + o["queue"][-1]
    assert np.isclose(tot, 30.0)
    return True


if __name__ == "__main__":
    print("r184_engine self-test", self_test())
