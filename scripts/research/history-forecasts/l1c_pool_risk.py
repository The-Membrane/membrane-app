#!/usr/bin/env python3
"""Q26 round 9 R9.1(d) item 1 (L1c): lender lock and spike risk rerun on snapshot-bias-corrected inputs.

membrane-board design/Q26_ROUND9_PREREG.md @4d46a7e (R9.1(d)1, with Deviations D1-D3), Aave V3 Core USDC.

  python3 l1c_pool_risk.py fit   --datasets <membrane-datasets> --rdu <raw-logs-rdu.csv.gz> --out <dir>
  python3 l1c_pool_risk.py score --datasets <membrane-datasets> --out <dir> --frozen-sha256 <sha256 of frozen-l1c.json>

Same model as R8.4 (l1_pool_risk.py at 9b091355): ridge-1.0 logistic, per-fold 1/99% clipping and z-scoring,
quarterly expanding folds from 2024Q1, one fit per fold x cell. Features are W24 = (t0 - 24 h, t0] time-weighted
values in place of the 00:00Z snapshot values; top-10 holder share and S10 shortfall use QRT-neutralised W24 mean
holder balances. Targets LOCK6 and SPIKE6 (24 h, 7 d) from history-forecasts/r9/run-dfdd3ad8.

`fit` writes frozen-l1c.json (coefficients, scaling, input sha256, panel/prediction sha256) and prints its sha256.
`score` refuses unless that sha256 matches, then applies the registered pass rule and checks literally and writes
results-l1c.json. Addresses are hashed with a random per-run salt on load and never written.
"""
import argparse
import gzip
import hashlib
import json
import math
import os
import re
import secrets
import sys
from collections import defaultdict

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import l1_pool_risk as L1  # noqa: E402
from r9_correct import ray_div, window_segments, word, RAY, YEAR, MICRO  # noqa: E402

PREREG = {"repo": "triccs/membrane-board", "path": "design/Q26_ROUND9_PREREG.md", "commit": "4d46a7e",
          "item": "R9.1(d)1 L1c"}
SCHEMA = "q26-r9/l1c/1"
R9 = "history-forecasts/r9/run-dfdd3ad8"
W24_F = f"{R9}/w24-pool-usdc.csv"
LAB_F = f"{R9}/labels-r9-usdc.csv"
QRTL_F = f"{R9}/qrt-legs-usdc.csv.gz"
SPELL_F = f"{R9}/lock-spells-r9.json"
R9_SHA = {"w24-pool-usdc.csv": "b3cbe460e38ac62f6abfc4b3521ae26328f9aa7ea9ec81c2357f56540f991912",
          "labels-r9-usdc.csv": "99c5529af12a83120083d7225aec8ce5e3579699e406cf937755273c7db995fd",
          "qrt-legs-usdc.csv.gz": "f3da86020fbd5dd4841e816c66611d3bb31a65a9812d5c18bf87f96d5dc5bd8e",
          "lock-spells-r9.json": "3cb78c276cf395940a7648100d4b70107e552e44c2cc28f6ccf2437e67f323b4"}
RDU_SHA = "de5eceb0965d71dd705a66b41864f796df62115d5e7728d65f0db84a99595f19"
L1_RUN = "history-forecasts/l1/run-9b091355"
L1_SHA = {"oos-predictions-l1.csv.gz": "84cbb81aabaf020eb2722d5df3ef57d1a917883bad81389dfca1f6bb390812f2",
          "panel-l1.csv.gz": "eb53e4942763133b4e589e6c3e4fd1828f94ad82c0c859288778ae3d6075896b"}
UNIVERSE = "depositor-events/extended-universe.csv"
EVENTS = L1.EVENTS
ETH = L1.ETH
FEATURES = L1.FEATURES
TARGETS = ("LOCK6", "SPIKE6")
HORIZONS = L1.HORIZONS
LOOKAHEAD_S = 3600
CUTOFF_PRIMARY = "2026-01-22"     # D3: drain-role wallet's first aUSDC event
CUTOFF_BESIDE = "2026-07-01"
AUG_WIN = ("2026-08-01", "2026-10-13")
APRIL_ORIGINS = ("2026-04-18", "2026-04-19", "2026-04-20")
LAST_ORIGIN = "2026-10-06"        # as L1 (last day with ETH RV7)

DECISIONS = [
    "L1c-1 model, clipping, scaling, ridge, folds, training-row rule, degenerate-fold rule and the BSS/R/bootstrap "
    "definitions are imported unchanged from l1_pool_risk.py (9b091355, DECISIONS L1-6..L1-8). Origins "
    "2023-02-02 .. 2026-10-06 as L1-11; each cell uses origins with all features and a covered label.",
    "L1c-2 pool features from the R9.1(a) W24 raw pool state (w24-pool-usdc.csv, run-dfdd3ad8), not the ex-QRT "
    "cashX: util = W24 time-weighted mean U = 1 - cash/supply (the (a) definition; L1 used variableDebt / "
    "(variableDebt + cash) at the snapshot); cash_supply = W24 mean cash/supply; log_cash = ln(1 + W24 mean "
    "cash USD); borrow_apr = W24 time-weighted mean variableBorrowRate (ReserveDataUpdated word 2, last per tx, "
    "step function, the state in force at t0 - 24 h starts the window, ts <= t0 only); d_borrow_apr = "
    "borrow_apr(t0) - borrow_apr(t0 - 1 d); eth_rv7 unchanged (L1-5, already uses only closed hourly bars).",
    "L1c-3 holder balances: per address in the L1 holder universe (extended-universe.csv: every P_r member and "
    "every address whose event balance reaches $1M), scaled balance from depositor-events G.2 (Mint +rayDiv(value "
    "- balanceIncrease, index), Burn -rayDiv(value + balanceIncrease, index), BalanceTransfer moves its scaled "
    "value exactly; party1/party2 per D1). W24 mean balance USD = (time integral of scaled balance over "
    "(t0 - 24 h, t0]) / 86400 x normalizedIncome(t0 - 12 h) / 1e6 (index drift within a day <= ~0.04%).",
    "L1c-4 QRT neutralisation of holder balances (R9.1(b)): each QRT in qrt-legs-usdc.csv.gz is joined by event "
    "key to its owner; the owner's balance gets outstanding(t) added back (+neutral at the withdraw leg, "
    "-neutral_raw at each redeposit leg). For origin t0 a QRT counts iff withdraw ts <= t0, completion > t0 - "
    "24 h and completion <= t0 + 60 min (the run-dfdd3ad8 feature rule).",
    "L1c-5 top10_share = sum of the 10 largest QRT-neutralised W24 mean balances / W24 mean ex-QRT supply "
    "(w24x_mean_supply, the matching neutralised denominator); s10_shortfall_cash = (that top-10 sum - W24 mean raw "
    "cash) / max(W24 mean raw cash, $1).",
    "L1c-6 labels LOCK6_{24h,7d}, SPIKE6_{24h,7d} and open6 read from labels-r9-usdc.csv (run-dfdd3ad8), "
    "unchanged. Open origins = open6 == 1 (no >= 6 h spell ongoing at t0).",
    "L1c-7 pass rule (LOCK6 24 h moves above LOW): on open OOS origins, BSS vs the expanding base rate (the "
    "fold's training-row mean, as L1-8) has a block-bootstrap 95% CI lower bound > 0 AND 0.5 <= R <= 2, R = sum p "
    "/ sum y on open origins. Bootstrap: 30-day moving blocks over the cell's full OOS calendar series (2000 "
    "draws, default_rng(20261084)), metric computed on the open rows of each draw; draws with no open positive "
    "give no R. R undefined (no open positive) fails the R condition.",
    "L1c-8 (e) model-change budget: per cell, on OOS origins before the cutoff (primary 2026-01-22 per D3; "
    "2026-07-01 beside), corrected = L1c p vs corrected labels, uncorrected = L1 run-9b091355 p vs L1 labels; flag "
    "iff |dBSS| > 0.02 or |d ln R| > 0.2, or either side is not computable (a budget that cannot be evaluated "
    "is not met).",
    "L1c-9 (e) holder-input gap (applied as the pool-input rule): per month, median |W24 neutralised top10_share "
    "- snapshot top-10 share (L1 panel)|; a month before the cutoff with median > 0.02 is flagged.",
    "L1c-10 holder-path check (before the fit): the event-reconstructed point top-10 sum (raw, last state with "
    "ts < t0) vs the L1 panel snapshot top-10 sum (balanceOf-based); median and max relative difference reported; "
    "the run stops if the median exceeds 0.1%.",
]


def sha(p):
    return L1.sha256_file(p)


def check_sha(path, want):
    got = sha(path)
    if got != want:
        raise SystemExit(f"STOP: {path} sha256 {got} != {want}")


# ---------------------------------------------------------------------------------------------
# pure helpers (tested)
# ---------------------------------------------------------------------------------------------
def step_integral(ts, vals, bounds):
    """integral of a right-continuous step function (value 0 before ts[0]) from ts[0] to each bound."""
    ts = np.asarray(ts, dtype=float)
    vals = np.asarray(vals, dtype=float)
    bounds = np.asarray(bounds, dtype=float)
    if len(ts) == 0:
        return np.zeros(len(bounds))
    seg = np.append(np.diff(ts), 0.0) * vals
    cum = np.concatenate([[0.0], np.cumsum(seg)])          # cum[k] = integral up to ts[k]
    k = np.searchsorted(ts, bounds, side="right") - 1
    out = np.where(k >= 0, cum[np.clip(k, 0, None)] + vals[np.clip(k, 0, None)] * (bounds - ts[np.clip(k, 0, None)]),
                   0.0)
    return out


def tw_mean_step(ts, vals, a, b):
    """time-weighted mean over (a, b] of a step function (state in force at a starts the window)."""
    idx, dur = window_segments(np.asarray(ts), a, b)
    if len(idx) == 0 or dur.sum() <= 0:
        return np.nan
    v = np.asarray(vals, float)[idx]
    ok = ~np.isnan(v)
    if not ok.any():
        return np.nan
    return float(np.sum(v[ok] * dur[ok]) / dur[ok].sum())


def qrt_window_adjust(steps, a, b):
    """mean over (a, b] of the outstanding step function built from [(ts, delta), ...] (0 before the first)."""
    if not steps:
        return 0.0
    st = sorted(steps)
    t = np.array([s[0] for s in st], float)
    v = np.cumsum([s[1] for s in st])
    I = step_integral(t, v, [a, b])
    return float((I[1] - I[0]) / (b - a))


def open_boot(pr, B=L1.BOOT_B, block=L1.BOOT_BLOCK_DAYS, seed=L1.BOOT_SEED):
    """moving-block bootstrap over the full OOS series; BSS and R computed on the open rows of each draw."""
    rng = np.random.default_rng(seed)
    n = len(pr)
    p, pb, y = pr["p"].to_numpy(float), pr["p_base"].to_numpy(float), pr["y"].to_numpy(float)
    op = pr["open6"].to_numpy(int) == 1
    nb = int(math.ceil(n / block))
    bs, rs_ = [], []
    for _ in range(B):
        starts = rng.integers(0, max(1, n - block + 1), size=nb)
        idx = np.concatenate([np.arange(s, min(s + block, n)) for s in starts])[:n]
        idx = idx[op[idx]]
        if len(idx) == 0:
            continue
        v = L1.bss(p[idx], pb[idx], y[idx])
        if v is not None:
            bs.append(v)
        r = L1.ratio_R(p[idx], y[idx])
        if r is not None:
            rs_.append(r)
    q = lambda a: [float(np.quantile(a, 0.025)), float(np.quantile(a, 0.975))] if len(a) else None
    return {"bssCI": q(bs), "RCI": q(rs_), "nDrawsBss": len(bs), "nDrawsR": len(rs_), "B": B,
            "blockDays": block, "seed": seed}


def pass_rule(bss_ci, R):
    return bool(bss_ci is not None and bss_ci[0] > 0 and R is not None and 0.5 <= R <= 2.0)


def budget_flag(bss_c, bss_u, R_c, R_u):
    out = {"bssCorrected": bss_c, "bssUncorrected": bss_u, "RCorrected": R_c, "RUncorrected": R_u}
    if bss_c is None or bss_u is None or not R_c or not R_u:
        out.update({"dBSS": None, "dLnR": None, "flag": True, "reason": "not computable"})
        return out
    d, dl = bss_c - bss_u, math.log(R_c) - math.log(R_u)
    out.update({"dBSS": d, "dLnR": dl, "flag": bool(abs(d) > 0.02 or abs(dl) > 0.2),
                "reason": "budget" if (abs(d) > 0.02 or abs(dl) > 0.2) else "within"})
    return out


# ---------------------------------------------------------------------------------------------
# inputs
# ---------------------------------------------------------------------------------------------
def load_rdu(path):
    r = pd.read_csv(path, usecols=["block", "ts", "tx_index", "log_index", "data"], dtype={"data": str})
    r = r.sort_values(["block", "tx_index", "log_index"], kind="mergesort")
    r["vb"] = [word(d, 2) / RAY for d in r["data"]]
    r["lr"] = [word(d, 0) / RAY for d in r["data"]]
    r["li"] = [word(d, 3) / RAY for d in r["data"]]
    last = r.groupby(["block", "tx_index"], sort=True).tail(1)
    last = last.groupby("ts", sort=True).tail(1)
    return last[["ts", "vb", "lr", "li"]].reset_index(drop=True)


def norm_income(rdu, t):
    k = np.searchsorted(rdu["ts"].to_numpy(np.int64), t, side="right") - 1
    k = np.clip(k, 0, None)
    li, lr, rts = rdu["li"].to_numpy()[k], rdu["lr"].to_numpy()[k], rdu["ts"].to_numpy()[k]
    return li * (1.0 + lr * (np.asarray(t) - rts) / YEAR)


def load_holder_events(datasets, universe, salt):
    """-> per-unit (ts array, scaled-balance-after array), key->unit map for QRT legs (Burns/Mints only)."""
    cols = ["block", "ts", "tx_index", "log_index", "type", "party1", "party2", "value_raw", "delta1_raw",
            "index_ray"]
    h = lambda a: hashlib.sha256((salt + a.lower()).encode()).hexdigest()[:16]
    uni = {h(a) for a in universe}
    rows = []
    keyunit = {}
    for rel in EVENTS:
        for ch in pd.read_csv(os.path.join(datasets, rel), usecols=cols, chunksize=1_000_000,
                              dtype={"party1": str, "party2": str, "value_raw": str, "delta1_raw": str,
                                     "index_ray": str}):
            ch = ch[ch["type"].isin(["Mint", "Burn", "BalanceTransfer"])]
            u1 = [h(a) for a in ch["party1"]]
            u2 = [h(a) if isinstance(a, str) else "" for a in ch["party2"]]
            for blk, ts, tx, lg, typ, a1, a2, val, d1, ix in zip(ch["block"], ch["ts"], ch["tx_index"],
                                                                 ch["log_index"], ch["type"], u1, u2,
                                                                 ch["value_raw"], ch["delta1_raw"], ch["index_ray"]):
                k = (int(blk), int(tx), int(lg))
                if typ in ("Mint", "Burn"):
                    keyunit[k] = a1
                    if a1 in uni and isinstance(d1, str):
                        d = int(d1)
                        s = ray_div(abs(d), int(ix))
                        rows.append((k, int(ts), a1, s if d >= 0 else -s))
                else:
                    s = int(val)
                    if a1 in uni:
                        rows.append((k, int(ts), a1, -s))
                    if a2 in uni:
                        rows.append((k, int(ts), a2, s))
    rows.sort(key=lambda r: r[0])
    per = defaultdict(lambda: ([], []))
    bal = defaultdict(int)
    for k, ts, u, ds in rows:
        bal[u] += ds
        t_, v_ = per[u]
        if t_ and t_[-1] == ts:
            v_[-1] = bal[u]
        else:
            t_.append(ts)
            v_.append(bal[u])
    return {u: (np.array(t, np.int64), np.array(v, float)) for u, (t, v) in per.items()}, keyunit


def holder_features(per, rdu, t0s, qsteps):
    """-> DataFrame per origin: top10 neutralised W24 mean sum (USD), raw point top10 sum (USD), raw W24 top10."""
    t0s = np.asarray(t0s, np.int64)
    bounds = np.concatenate([[t0s[0] - 86400], t0s]).astype(float)
    units = list(per.keys())
    M = np.zeros((len(units), len(t0s)))
    P = np.zeros((len(units), len(t0s)))
    for i, u in enumerate(units):
        ts, v = per[u]
        I = step_integral(ts, v, bounds)
        M[i] = np.diff(I) / 86400.0
        k = np.searchsorted(ts, t0s, side="left") - 1
        P[i] = np.where(k >= 0, v[np.clip(k, 0, None)], 0.0)
    ni_mid = norm_income(rdu, t0s - 43200)
    ni_pt = norm_income(rdu, t0s - 1)
    M = M * ni_mid / MICRO
    P = P * ni_pt / MICRO
    MX = M.copy()
    uidx = {u: i for i, u in enumerate(units)}
    nq = np.zeros(len(t0s), int)
    for unit, b_ts, done_ts, steps in qsteps:
        if unit not in uidx:
            continue
        lo = np.searchsorted(t0s, b_ts, side="left")          # t0 >= burn ts
        for j in range(lo, len(t0s)):
            t0 = int(t0s[j])
            if done_ts <= t0 - 86400:
                break
            if done_ts > t0 + LOOKAHEAD_S:
                continue
            MX[uidx[unit], j] += qrt_window_adjust(steps, t0 - 86400, t0) / MICRO
            nq[j] += 1
    top = lambda A: np.sort(A, axis=0)[-10:, :].sum(axis=0)
    return pd.DataFrame({"t0": t0s, "top10x_w24": top(MX), "top10_w24_raw": top(M), "top10_point": top(P),
                         "n_qrt_holder": nq})


def load_qsteps(datasets, keyunit):
    lg = pd.read_csv(os.path.join(datasets, QRTL_F))
    out = []
    for qid, g in lg.groupby("qrt_id", sort=True):
        w = g[g["leg"] == "withdraw"].iloc[0]
        unit = keyunit.get((int(w["block"]), int(w["tx_index"]), int(w["log_index"])))
        if unit is None:
            raise SystemExit(f"STOP: QRT {qid} withdraw leg not found in depositor-events")
        steps = [(int(w["ts"]), float(int(w["neutral_raw"])))]
        for _, r in g[g["leg"] == "redeposit"].iterrows():
            steps.append((int(r["ts"]), -float(int(r["neutral_raw"]))))
        done = int(g.loc[g["leg"] == "redeposit", "ts"].max())
        out.append((unit, int(w["ts"]), done, steps))
    return out


# ---------------------------------------------------------------------------------------------
# panel
# ---------------------------------------------------------------------------------------------
def build_panel(a):
    for f, h in R9_SHA.items():
        check_sha(os.path.join(a.datasets, R9, f), h)
    for f, h in L1_SHA.items():
        check_sha(os.path.join(a.datasets, L1_RUN, f), h)
    check_sha(a.rdu, RDU_SHA)
    salt = secrets.token_hex(32)
    W = pd.read_csv(os.path.join(a.datasets, W24_F))
    W = W[W["origin"] <= LAST_ORIGIN].reset_index(drop=True)
    lab = pd.read_csv(os.path.join(a.datasets, LAB_F))
    print("rdu", flush=True)
    rdu = load_rdu(a.rdu)
    T, VB = rdu["ts"].to_numpy(np.int64), rdu["vb"].to_numpy(float)
    W["borrow_apr"] = [tw_mean_step(T, VB, t0 - 86400, t0) for t0 in W["t0"]]
    print("holders", flush=True)
    uni = pd.read_csv(os.path.join(a.datasets, UNIVERSE), dtype=str)
    uni = uni[uni["reserve"] == "USDC"]["address"].tolist()
    per, keyunit = load_holder_events(a.datasets, uni, salt)
    qsteps = load_qsteps(a.datasets, keyunit)
    del keyunit
    H = holder_features(per, rdu, W["t0"].to_numpy(np.int64), qsteps)
    eth_ts, eth_px = L1.load_eth(a.datasets)
    l1p = pd.read_csv(os.path.join(a.datasets, L1_RUN, "panel-l1.csv.gz"))
    P = W.merge(H, on="t0", how="left")
    P["util"] = P["w24_mean_util"]
    P["cash_supply"] = P["w24_mean_cash_supply"]
    P["log_cash"] = np.log1p(P["w24_mean_cash"])
    prev = dict(zip(P["t0"], P["borrow_apr"]))
    P["d_borrow_apr"] = [P_ - prev[t - 86400] if (t - 86400) in prev else np.nan
                         for t, P_ in zip(P["t0"], P["borrow_apr"])]
    P["eth_rv7"] = [L1.eth_rv7(eth_ts, eth_px, int(t)) for t in P["t0"]]
    P["top10_share"] = P["top10x_w24"] / P["w24x_mean_supply"]
    P["s10_shortfall_cash"] = (P["top10x_w24"] - P["w24_mean_cash"]) / P["w24_mean_cash"].clip(lower=1.0)
    P["snapshot"] = P["origin"]
    P = P.merge(lab.drop(columns=["origin"]), on="t0", how="left")
    # holder-path check vs the L1 snapshot top-10 (balanceOf-based)
    chk = P.merge(l1p[["t0", "top10_share", "cash_supply", "log_cash"]].rename(
        columns={"top10_share": "l1_top10_share", "cash_supply": "l1_cs", "log_cash": "l1_lc"}), on="t0", how="inner")
    l1_sum = chk["l1_top10_share"] * (np.expm1(chk["l1_lc"]) / chk["l1_cs"])
    rel = ((chk["top10_point"] - l1_sum) / l1_sum).abs()
    hcheck = {"n": int(rel.notna().sum()), "medianAbsRel": float(rel.median()), "p99AbsRel": float(rel.quantile(0.99)),
              "maxAbsRel": float(rel.max()), "maxAt": chk.loc[rel.idxmax(), "origin"], "stopIfMedianOver": 0.001}
    hcheck["PASS"] = hcheck["medianAbsRel"] <= 0.001
    P["l1_top10_share_snapshot"] = P["t0"].map(dict(zip(l1p["t0"], l1p["top10_share"])))
    return P, hcheck


def phase_fit(a):
    os.makedirs(a.out, exist_ok=True)
    pf = os.path.join(a.out, "frozen-l1c.json")
    if os.path.exists(pf):
        raise SystemExit(f"STOP: {pf} exists (fit once; never rewritten)")
    P, hcheck = build_panel(a)
    print("holder check", json.dumps(hcheck), flush=True)
    if not hcheck["PASS"]:
        json.dump({"holderCheck": hcheck}, open(os.path.join(a.out, "stop-l1c.json"), "w"), indent=1)
        raise SystemExit("STOP: holder-path check failed")
    frozen = {"schema": SCHEMA, "prereg": PREREG, "features": list(FEATURES), "ridgeLambda": L1.RIDGE_LAMBDA,
              "clipQuantiles": list(L1.CLIP_Q), "decisions": DECISIONS, "holderCheck": hcheck,
              "inputs": {**{f"{R9}/{f}": h for f, h in R9_SHA.items()},
                         **{f"{L1_RUN}/{f}": h for f, h in L1_SHA.items()},
                         "aave-pool-cash/raw-logs-rdu.csv.gz": RDU_SHA,
                         UNIVERSE: sha(os.path.join(a.datasets, UNIVERSE)),
                         ETH: sha(os.path.join(a.datasets, ETH)),
                         **{e: sha(os.path.join(a.datasets, e)) for e in EVENTS}},
              "code": {"file": "scripts/research/history-forecasts/l1c_pool_risk.py", "sha256": sha(__file__),
                       "l1_pool_risk.py": sha(L1.__file__)},
              "fits": {}}
    allpred = []
    for tgt in TARGETS:
        for hn, hs in HORIZONS.items():
            col = f"{tgt}_{hn}"
            fits, pr = L1.fit_folds(P, col, hs)
            frozen["fits"][col] = fits
            pr["cell"] = col
            allpred.append(pr)
    pred = pd.concat(allpred, ignore_index=True)
    keep = ["origin", "snapshot", "t0"] + list(FEATURES) + [
        "top10x_w24", "top10_w24_raw", "top10_point", "n_qrt_holder", "l1_top10_share_snapshot", "w24_mean_cash",
        "w24x_mean_supply", "snap_cash_supply", "open6"] + [f"{t}_{h}" for t in TARGETS for h in HORIZONS]
    P[keep].to_csv(os.path.join(a.out, "panel-l1c.csv.gz"), index=False)
    pred.to_csv(os.path.join(a.out, "oos-predictions-l1c.csv.gz"), index=False)
    frozen["outputs"] = {f: sha(os.path.join(a.out, f)) for f in ("panel-l1c.csv.gz", "oos-predictions-l1c.csv.gz")}
    data = (json.dumps(frozen, indent=1, sort_keys=True, default=float) + "\n").encode()
    with open(pf, "xb") as f:
        f.write(data)
    print(hashlib.sha256(data).hexdigest())
    return 0


# ---------------------------------------------------------------------------------------------
# score
# ---------------------------------------------------------------------------------------------
def cell_stats(pr):
    y, p, pb = pr["y"].to_numpy(float), pr["p"].to_numpy(float), pr["p_base"].to_numpy(float)
    if len(y) == 0:
        return {"n": 0}
    return {"n": int(len(y)), "nPos": int(y.sum()), "bssVsBase": L1.bss(p, pb, y), "R": L1.ratio_R(p, y),
            "brier": L1.brier(p, y), "brierBase": L1.brier(pb, y)}


def phase_score(a):
    pf = os.path.join(a.out, "frozen-l1c.json")
    if sha(pf) != a.frozen_sha256:
        raise SystemExit("STOP: frozen-l1c.json sha256 does not match --frozen-sha256")
    frozen = json.load(open(pf))
    for f, h in frozen["outputs"].items():
        if sha(os.path.join(a.out, f)) != h:
            raise SystemExit(f"STOP: {f} changed since the freeze")
    for f, h in L1_SHA.items():
        check_sha(os.path.join(a.datasets, L1_RUN, f), h)
    panel = pd.read_csv(os.path.join(a.out, "panel-l1c.csv.gz"))
    pred = pd.read_csv(os.path.join(a.out, "oos-predictions-l1c.csv.gz"))
    pred = pred.merge(panel[["t0", "open6"]], on="t0", how="left")
    l1pred = pd.read_csv(os.path.join(a.datasets, L1_RUN, "oos-predictions-l1.csv.gz"))
    lab = pd.read_csv(os.path.join(a.datasets, LAB_F))
    res = {"schema": SCHEMA, "prereg": PREREG, "frozenSha256": a.frozen_sha256, "decisions": DECISIONS,
           "holderCheck": frozen["holderCheck"], "cells": {}}
    for col in frozen["fits"]:
        pr = pred[pred["cell"] == col].sort_values("t0").reset_index(drop=True)
        base = L1.score_cell(pr.drop(columns=["open6"]), panel, col)
        op = pr[pr["open6"] == 1]
        ob = open_boot(pr)
        base["open"] = {**cell_stats(op), **ob, "nPosOpenDays": op.loc[op["y"] == 1, "snapshot"].tolist()}
        base["folds"] = [{k: f.get(k) for k in ("quarter", "nTrain", "nTrainPos", "baseRate", "degenerate", "nTest")}
                         for f in frozen["fits"][col]]
        nd = [f for f in frozen["fits"][col] if not f["degenerate"]]
        if nd:
            base["lastFoldCoef"] = dict(zip(["intercept"] + list(FEATURES), nd[-1]["coef"]))
        # uncorrected comparison on the same origins
        ucol = col.replace("6", "")
        up = l1pred[l1pred["cell"] == ucol].merge(lab[["t0", "open6", col]], on="t0", how="left")
        upo = up[up["open6"] == 1]
        base["uncorrectedL1SameOpenOrigins"] = {
            "vsL1Labels": cell_stats(upo),
            "vsCorrectedLabels": cell_stats(upo.assign(y=upo[col]).dropna(subset=["y"]))}
        # (e) model-change budget
        bud = {}
        for name, cut in (("pre2026-01-22_primary", CUTOFF_PRIMARY), ("pre2026-07-01_beside", CUTOFF_BESIDE)):
            c = cell_stats(pr[pr["snapshot"] < cut])
            u = cell_stats(up[up["snapshot"] < cut])
            bud[name] = {**budget_flag(c.get("bssVsBase"), u.get("bssVsBase"), c.get("R"), u.get("R")),
                         "nCorrected": c.get("n"), "nPosCorrected": c.get("nPos"), "nUncorrected": u.get("n"),
                         "nPosUncorrected": u.get("nPos")}
        base["eModelChangeBudget"] = bud
        res["cells"][col] = base
    # registered pass rule
    lk = res["cells"]["LOCK6_24h"]["open"]
    passed = pass_rule(lk["bssCI"], lk["R"])
    res["passLOCK6_24h"] = {"bssOpen": lk.get("bssVsBase"), "bssCI": lk["bssCI"], "R": lk.get("R"),
                            "ciLowerGt0": bool(lk["bssCI"] is not None and lk["bssCI"][0] > 0),
                            "RIn0p5to2": bool(lk.get("R") is not None and 0.5 <= lk["R"] <= 2.0),
                            "PASS": passed, "label": "above LOW permitted" if passed else "LOW"}
    # consistency checks
    aug = lab[(lab["origin"] >= AUG_WIN[0]) & (lab["origin"] <= AUG_WIN[1]) & lab["LOCK6_24h"].notna()]
    apr = lab[lab["origin"].isin(APRIL_ORIGINS)]
    res["consistency"] = {
        "lock6_24h_days_aug_oct": {"days": int(aug["LOCK6_24h"].sum()), "origins": int(len(aug)),
                                   "share": float(aug["LOCK6_24h"].mean()), "PASS": bool(aug["LOCK6_24h"].mean() <= 0.05)},
        "april_lock_labelled": {"rows": apr[["origin", "LOCK6_24h", "L1_LOCK_24h", "open6"]].to_dict("records"),
                                "PASS": bool((apr.loc[apr["L1_LOCK_24h"] == 1, "LOCK6_24h"] == 1).all())},
    }
    # origin 2026-04-19
    o = {}
    for col in frozen["fits"]:
        m = pred[(pred["cell"] == col) & (pred["snapshot"] == "2026-04-19")]
        u = l1pred[(l1pred["cell"] == col.replace("6", "")) & (l1pred["snapshot"] == "2026-04-19")]
        o[col] = {"p": float(m["p"].iloc[0]) if len(m) else None, "p_base": float(m["p_base"].iloc[0]) if len(m) else None,
                  "y": float(m["y"].iloc[0]) if len(m) else None, "quarter": m["quarter"].iloc[0] if len(m) else None,
                  "uncorrectedL1_p": float(u["p"].iloc[0]) if len(u) else None}
    res["origin2026_04_19"] = o
    # (e) holder-input gap by month
    panel["gap"] = (panel["top10_share"] - panel["l1_top10_share_snapshot"]).abs()
    panel["month"] = panel["origin"].str[:7]
    gm = panel.groupby("month")["gap"].agg(["median", lambda s: s.quantile(0.95)]).reset_index()
    gm.columns = ["month", "median_abs_gap", "p95_abs_gap"]
    res["eHolderInputGap"] = {
        "byMonth": gm.to_dict("records"),
        "flaggedPre2026_01_22_primary": gm[(gm["month"] < CUTOFF_PRIMARY[:7]) & (gm["median_abs_gap"] > 0.02)]["month"].tolist(),
        "flaggedPre2026_07_beside": gm[(gm["month"] < CUTOFF_BESIDE[:7]) & (gm["median_abs_gap"] > 0.02)]["month"].tolist(),
        "note": "2026-01 is partly post-cutoff; months strictly before 2026-01 are primary"}
    res["eventsPerYear"] = {col: res["cells"][col]["positiveDaysPerYearAll"] for col in res["cells"]}
    out = os.path.join(a.out, "results-l1c.json")
    txt = json.dumps(res, indent=1, sort_keys=True, default=float)
    if re.search(r"0x[0-9a-fA-F]{40}(?![0-9a-fA-F])", txt):
        raise SystemExit("STOP: address-like string in results")
    open(out, "w").write(txt)
    summ = {"pass": res["passLOCK6_24h"], "consistency": {k: v["PASS"] for k, v in res["consistency"].items()},
            "cells": {c: {"all": {k: v[k] for k in ("nTest", "nPos", "bssVsBase", "bssCI", "R")},
                          "open": {k: v["open"].get(k) for k in ("n", "nPos", "bssVsBase", "bssCI", "R")},
                          "budget": {n: {k: b[k] for k in ("dBSS", "dLnR", "flag", "reason")}
                                     for n, b in v["eModelChangeBudget"].items()}}
                      for c, v in res["cells"].items()},
            "holderGap": {k: res["eHolderInputGap"][k] for k in ("flaggedPre2026_01_22_primary",
                                                               "flaggedPre2026_07_beside")}}
    print(json.dumps(summ, indent=1, default=float))
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("phase", choices=["fit", "score"])
    ap.add_argument("--datasets", required=True)
    ap.add_argument("--rdu")
    ap.add_argument("--out", required=True)
    ap.add_argument("--frozen-sha256")
    a = ap.parse_args(argv)
    return phase_fit(a) if a.phase == "fit" else phase_score(a)


if __name__ == "__main__":
    sys.exit(main())
