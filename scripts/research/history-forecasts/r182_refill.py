#!/usr/bin/env python3
"""Q26 R18.2 refill model (membrane-board design/Q26_ROUND18_PREREG.md, section R18.2).

Refill = how fast deposits, repayments and fewer new borrows restore withdrawable cash after a withdrawal shock.
Development on SEEN Aave V3 Ethereum Core USDC (and Core USDT as a second seen market). No reserved set is read.

  python3 r182_refill.py build  --datasets <membrane-datasets> --work <dir>      # hourly panel (+ own-flow arrays)
  python3 r182_refill.py synth  --work <dir>                                       # known-answer synthetic test
  python3 r182_refill.py fit    --work <dir> --out <dir>                           # three candidates on dev data
  python3 r182_refill.py check  --datasets <membrane-datasets> --work <dir> --out <dir>   # chain reconciliation

ESTIMAND (fixed in the prereg before the first fit). For a withdrawal surprise s_t ($) in UTC hour t:
  rho(h) = d E[ C(t+h) - C(t) | s_t, F(t-1) ] / d s_t ,  h = 3, 24, 72 hours,
where C(k) is pool cash (USDC.balanceOf(aToken)) at the end of hour k and F(t-1) holds the calendar (hour of week),
lagged flows and utilisation. Hour t itself is excluded (contemporaneous co-movement is not separable at 1 h).
  rho_all(h): every actor's flows.  rho_3P(h) (PRIMARY): flows of the units that withdrew in hour t are removed
  from (t, t+h] (their own return deposits, further withdrawals, borrows and repays), so the number answers
  "how fast do OTHER actors restore cash", which is what a top-holder exit scenario needs.
  Components: deposits D, repays Rp, minus borrows B, minus further withdrawals W, residual O (liquidation repays,
  flash-loan premiums, unmatched transfers).

Decisions (DECISIONS block, fixed before the first real-data fit):
  R182-1  Cash flows are the exact underlying Transfer logs to/from the aToken (aave-pool-cash; USDC only).
  R182-2  Per transaction: W = min(aToken burn of withdrawers, transfers out); D = min(supply mints (caller != Pool),
          transfers in); Rp = min(Repay (useATokens = 0), in - D); B = min(Borrow, out - W); O = net - (D+Rp-W-B).
  R182-3  Units are party1 of Mint/Burn, Repay.user, Borrow.onBehalfOf. Addresses are hashed in memory only
          and never written.
  R182-4  Development span: origin hours 2023-02-01T00Z .. 2026-10-10T00Z (72 h before the data asof). 2026Q2
          is reported with and without (April 2026 run).
  R182-5  Two-way CIs: event unit x 30-day block (event study); 30-day block (single-market LP and DL);
          market x 30-day block (USDC + USDT pooled, reported). B = 2,000 for development.
"""
import argparse
import gzip
import hashlib
import json
import os
import sys
from datetime import datetime, timezone

import numpy as np
import pandas as pd

H0 = int(datetime(2023, 2, 1, tzinfo=timezone.utc).timestamp())
HMAX = 72
POOL = "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2"
RES = {"USDC": {"addr": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "dec": 6},
       "USDT": {"addr": "0xdac17f958d2ee523a2206206994597c13d831ec7", "dec": 6}}
YEARS = (2023, 2024, 2025, 2026)


def sha256_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def uid(series):
    """Stable in-memory unit id from an address (never written)."""
    return pd.util.hash_pandas_object(series.str.lower(), index=False).to_numpy(np.uint64)


# ----------------------------------------------------------------------------------------------- build
def load_transfers(ds):
    out = {}
    for side in ("in", "out"):
        p = os.path.join(ds, f"aave-pool-cash/raw-logs-usdc-{side}.csv.gz")
        t = pd.read_csv(p, usecols=["ts", "tx_hash", "data"])
        t["amt"] = t["data"].map(lambda x: int(x, 16)).astype(float) / 1e6
        out[side] = t.drop(columns="data")
    return out


def load_atoken(ds, res):
    fr = []
    for y in YEARS:
        p = os.path.join(ds, f"depositor-events/events-{res.lower()}-{y}.csv.gz")
        c = pd.read_csv(p, usecols=["ts", "tx_hash", "type", "party1", "party2", "delta1_raw"],
                        dtype={"delta1_raw": "object"})
        c = c[c["type"].isin(["Mint", "Burn"]) & c["delta1_raw"].notna()]
        fr.append(c)
    a = pd.concat(fr, ignore_index=True)
    a["d"] = a["delta1_raw"].map(int).astype(float) / 1e6
    treas = (a["type"] == "Mint") & (a["party2"].str.lower() == POOL)
    a = a[~treas & (a["d"] != 0)].copy()
    a["unit"] = uid(a["party1"])
    return a[["ts", "tx_hash", "d", "unit"]]


def load_repays(ds, res):
    fr = []
    for y in YEARS:
        p = os.path.join(ds, f"aave-pool-debt/repay-events-core-{y}.csv.gz")
        c = pd.read_csv(p, usecols=["ts", "tx_hash", "reserve", "user", "amount_raw", "useATokens"],
                        dtype={"amount_raw": "object"})
        fr.append(c[c["reserve"].str.lower() == RES[res]["addr"]])
    r = pd.concat(fr, ignore_index=True)
    r["amt"] = r["amount_raw"].map(int).astype(float) / 10 ** RES[res]["dec"]
    r["unit"] = uid(r["user"])
    return r[["ts", "tx_hash", "amt", "useATokens", "unit"]]


def load_borrows(ds, res):
    fr = []
    p0 = os.path.join(ds, "aave-pool-debt/borrow-events-core-pre-2023.csv.gz")
    files = [p0] + [os.path.join(ds, f"aave-pool-borrows/borrow-events-core-{y}.csv.gz") for y in YEARS]
    for p in files:
        c = pd.read_csv(p, dtype={"amount_raw": "object"})
        c.columns = [x.strip() for x in c.columns]
        c = c[c["reserve"].str.lower() == RES[res]["addr"]]
        fr.append(c[["ts", "tx_hash", "onBehalfOf", "amount_raw"]])
    b = pd.concat(fr, ignore_index=True).drop_duplicates(["tx_hash", "onBehalfOf", "amount_raw", "ts"])
    b["amt"] = b["amount_raw"].map(int).astype(float) / 10 ** RES[res]["dec"]
    b["unit"] = uid(b["onBehalfOf"])
    return b[["ts", "tx_hash", "amt", "unit"]]


def build_market(ds, res, end_ts):
    """Hourly panel and own-flow arrays for one reserve. USDC uses exact transfers; USDT has no transfer stream
    (components only, O = 0)."""
    nh = (end_ts - H0) // 3600
    a = load_atoken(ds, res)
    r = load_repays(ds, res)
    b = load_borrows(ds, res)
    for df in (a, r, b):
        assert (df["ts"] > 0).all(), "zero timestamp"
    a = a[(a["ts"] >= H0) & (a["ts"] < end_ts)]
    r = r[(r["ts"] >= H0) & (r["ts"] < end_ts)]
    b = b[(b["ts"] >= H0) & (b["ts"] < end_ts)]
    wd = a[a["d"] < 0].assign(x=lambda z: -z["d"])
    sp = a[a["d"] > 0].assign(x=lambda z: z["d"])
    rp_cash = r[r["useATokens"].astype(int) == 0]
    # per tx aggregates
    g = lambda df, col: df.groupby("tx_hash")[col].sum()
    txW, txD, txR, txB = g(wd, "x"), g(sp, "x"), g(rp_cash, "amt"), g(b, "amt")
    meta = {}
    if res == "USDC":
        tr = load_transfers(ds)
        tin = tr["in"][(tr["in"]["ts"] >= H0) & (tr["in"]["ts"] < end_ts)]
        tout = tr["out"][(tr["out"]["ts"] >= H0) & (tr["out"]["ts"] < end_ts)]
        assert (tin["ts"] > 0).all() and (tout["ts"] > 0).all(), "zero timestamp"
        txin, txout = g(tin, "amt"), g(tout, "amt")
        txts = pd.concat([tin.groupby("tx_hash")["ts"].first(), tout.groupby("tx_hash")["ts"].first()])
        txts = txts[~txts.index.duplicated()]
        T = pd.DataFrame({"ts": txts})
        T["in"] = txin.reindex(T.index).fillna(0.0)
        T["out"] = txout.reindex(T.index).fillna(0.0)
        T["W"] = np.minimum(txW.reindex(T.index).fillna(0.0), T["out"])
        T["D"] = np.minimum(txD.reindex(T.index).fillna(0.0), T["in"])
        T["Rp"] = np.minimum(txR.reindex(T.index).fillna(0.0), T["in"] - T["D"])
        T["B"] = np.minimum(txB.reindex(T.index).fillna(0.0), T["out"] - T["W"])
        T["net"] = T["in"] - T["out"]
        T["O"] = T["net"] - (T["D"] + T["Rp"] - T["W"] - T["B"])
        cash_moving = set(T.index[T["out"] > 0])
        cash_in = set(T.index[T["in"] > 0])
        # event-level unit flows restricted to cash-moving txs
        wd = wd[wd["tx_hash"].isin(cash_moving)]
        sp = sp[sp["tx_hash"].isin(cash_in)]
        meta["withdrawBurnsNotCashMovingUSD"] = float(txW[~txW.index.isin(cash_moving)].sum())
        meta["supplyMintsNoTransferInUSD"] = float(txD[~txD.index.isin(cash_in)].sum())
        meta["repayEventsOutsideTransferTxUSD"] = float(txR[~txR.index.isin(cash_in)].sum())
        meta["borrowEventsOutsideTransferTxUSD"] = float(txB[~txB.index.isin(cash_moving)].sum())
    else:
        ids = pd.Index(sorted(set(txW.index) | set(txD.index) | set(txR.index) | set(txB.index)))
        tsmap = pd.concat([wd.groupby("tx_hash")["ts"].first(), sp.groupby("tx_hash")["ts"].first(),
                           rp_cash.groupby("tx_hash")["ts"].first(), b.groupby("tx_hash")["ts"].first()])
        tsmap = tsmap[~tsmap.index.duplicated()]
        T = pd.DataFrame({"ts": tsmap.reindex(ids)})
        for k, s in (("W", txW), ("D", txD), ("Rp", txR), ("B", txB)):
            T[k] = s.reindex(ids).fillna(0.0)
        # repayWithATokens burns are not cash: drop withdrawals in txs whose repays all use aTokens
        ra = r[r["useATokens"].astype(int) == 1].groupby("tx_hash")["amt"].sum()
        T["W"] = np.maximum(T["W"] - ra.reindex(ids).fillna(0.0), 0.0)
        T["in"] = T["D"] + T["Rp"]
        T["out"] = T["W"] + T["B"]
        T["net"] = T["in"] - T["out"]
        T["O"] = 0.0
        ok = set(T.index[T["W"] > 0])
        wd = wd[wd["tx_hash"].isin(ok)]
    T["h"] = ((T["ts"] - H0) // 3600).astype(np.int64)
    P = T.groupby("h")[["in", "out", "net", "W", "D", "Rp", "B", "O"]].sum().reindex(range(nh), fill_value=0.0)
    # Repays of all kinds (debt path) for utilisation
    rall = r.assign(h=lambda z: (z["ts"] - H0) // 3600).groupby("h")["amt"].sum().reindex(range(nh), fill_value=0.0)
    ball = b.assign(h=lambda z: (z["ts"] - H0) // 3600).groupby("h")["amt"].sum().reindex(range(nh), fill_value=0.0)
    P["Rp_all"], P["B_all"] = rall.to_numpy(), ball.to_numpy()
    # unit-level signed flows (cash-moving)
    ev = pd.concat([
        pd.DataFrame({"unit": wd["unit"], "ts": wd["ts"], "s": -wd["x"], "k": 0}),
        pd.DataFrame({"unit": sp["unit"], "ts": sp["ts"], "s": sp["x"], "k": 1}),
        pd.DataFrame({"unit": rp_cash["unit"], "ts": rp_cash["ts"], "s": rp_cash["amt"], "k": 2}),
        pd.DataFrame({"unit": b["unit"], "ts": b["ts"], "s": -b["amt"], "k": 3}),
    ], ignore_index=True)
    ev["h"] = ((ev["ts"] - H0) // 3600).astype(np.int64)
    # withdrawal unit-hours (origins), top unit share per hour
    wuh = wd.assign(h=lambda z: (z["ts"] - H0) // 3600).groupby(["unit", "h"])["x"].sum().reset_index()
    top = wuh.sort_values("x", ascending=False).drop_duplicates("h").set_index("h")
    P["Wtop"] = top["x"].reindex(range(nh)).fillna(0.0).to_numpy()
    P["Wtop_unit"] = top["unit"].reindex(range(nh)).fillna(0).astype(np.uint64).to_numpy()
    P["nWunits"] = wuh.groupby("h").size().reindex(range(nh), fill_value=0).to_numpy()
    own = own_flows(ev, wuh, nh)
    return P, own, meta


def own_flows(ev, wuh, nh):
    """own[k][t, j] = signed flow of type k (0 W, 1 D, 2 Rp, 3 B) in hours t+1..t+j (j = 1..HMAX) by the units that
    withdrew in hour t, summed over those units."""
    own = np.zeros((4, nh, HMAX + 1))
    ev = ev.sort_values(["unit", "h"])
    units = ev["unit"].to_numpy()
    hrs = ev["h"].to_numpy()
    for k in range(4):
        s = np.where(ev["k"].to_numpy() == k, ev["s"].to_numpy(), 0.0)
        G = np.concatenate([[0.0], np.cumsum(s)])
        # global key: rank of unit then hour
        ucodes, uinv = np.unique(units, return_inverse=True)
        key = uinv.astype(np.int64) * (nh + HMAX + 10) + hrs
        qu = np.searchsorted(ucodes, wuh["unit"].to_numpy())
        qt = wuh["h"].to_numpy().astype(np.int64)
        base = qu.astype(np.int64) * (nh + HMAX + 10)
        i0 = np.searchsorted(key, base + qt, side="right")
        for j in range(1, HMAX + 1):
            ij = np.searchsorted(key, base + qt + j, side="right")
            np.add.at(own[k][:, j], qt, G[ij] - G[i0])
    return own


def reserve_cash(ds, res):
    s = pd.read_csv(os.path.join(ds, "depositor-balances/reserve-state.csv"),
                    usecols=["snapshot", "reserve", "block", "block_ts", "totalSupply", "cash", "variableDebt"])
    s = s[(s["reserve"] == res) & s["cash"].notna()].copy()
    s = s[s["snapshot"] != "asof"]
    for c in ("totalSupply", "cash", "variableDebt"):
        s[c] = pd.to_numeric(s[c], errors="coerce") / 1e6
    return s.dropna(subset=["cash"])


def cmd_build(a):
    os.makedirs(a.work, exist_ok=True)
    end_ts = int(datetime(2026, 10, 13, 23, tzinfo=timezone.utc).timestamp())   # last full hour before asof
    out = {}
    for res in ("USDC", "USDT"):
        P, own, meta = build_market(a.datasets, res, end_ts)
        st = reserve_cash(a.datasets, res)
        st = st[st["block_ts"] >= H0]
        # cash path: anchor at first snapshot, exact for USDC (transfers); component-based for USDT
        hrs = ((st["block_ts"].to_numpy() - H0) // 3600).astype(int)
        cum = np.cumsum(P["net"].to_numpy())
        anchor_h, anchor_c = hrs[0], st["cash"].iloc[0]
        cash = anchor_c + cum - cum[anchor_h]
        rec = cash[hrs] - st["cash"].to_numpy()
        # debt path re-anchored daily: debt_end(day) + intraday (B_all - Rp_all)
        debt = np.full(len(P), np.nan)
        bmr = (P["B_all"] - P["Rp_all"]).to_numpy()
        cb = np.cumsum(bmr)
        for i in range(len(hrs)):
            lo = hrs[i]
            hi = hrs[i + 1] if i + 1 < len(hrs) else len(P) - 1
            if lo >= len(P):
                break
            seg = slice(lo, min(hi, len(P) - 1) + 1)
            debt[seg] = st["variableDebt"].iloc[i] + cb[seg] - cb[lo]
        cash_dayanch = np.full(len(P), np.nan)
        for i in range(len(hrs)):
            lo = hrs[i]
            hi = hrs[i + 1] if i + 1 < len(hrs) else len(P) - 1
            if lo >= len(P):
                break
            seg = slice(lo, min(hi, len(P) - 1) + 1)
            cash_dayanch[seg] = st["cash"].iloc[i] + cum[seg] - cum[lo]
        P["cash"] = cash_dayanch
        P["debt"] = debt
        P["util"] = debt / (debt + np.maximum(cash_dayanch, 0))
        P["hour_ts"] = H0 + 3600 * np.arange(len(P))
        P.to_parquet(os.path.join(a.work, f"panel-{res.lower()}.parquet")) if _has_parquet() else \
            P.to_csv(os.path.join(a.work, f"panel-{res.lower()}.csv.gz"), index=False)
        np.save(os.path.join(a.work, f"own-{res.lower()}.npy"), own.astype(np.float32))
        out[res] = {"hours": int(len(P)), "meta": meta,
                    "cashReconcile": {"nSnapshots": int(len(rec)), "maxAbsUSD": float(np.abs(rec).max()),
                                      "maxAbsShareOfSupply": float(np.max(np.abs(rec) /
                                                                          st["totalSupply"].to_numpy())),
                                      "medianAbsUSD": float(np.median(np.abs(rec)))},
                    "totals": {k: float(P[k].sum()) for k in ("in", "out", "net", "W", "D", "Rp", "B", "O")},
                    "residualShareOfGross": float(np.abs(P["O"]).sum() / (P["in"] + P["out"]).sum())}
        print(res, json.dumps(out[res]["cashReconcile"]), out[res]["residualShareOfGross"], flush=True)
    inputs = {}
    for rel in (["aave-pool-cash/raw-logs-usdc-in.csv.gz", "aave-pool-cash/raw-logs-usdc-out.csv.gz",
                 "depositor-balances/reserve-state.csv", "aave-pool-debt/borrow-events-core-pre-2023.csv.gz"]
                + [f"depositor-events/events-{r}-{y}.csv.gz" for r in ("usdc", "usdt") for y in YEARS]
                + [f"aave-pool-debt/repay-events-core-{y}.csv.gz" for y in YEARS]
                + [f"aave-pool-borrows/borrow-events-core-{y}.csv.gz" for y in YEARS]):
        inputs[rel] = sha256_file(os.path.join(a.datasets, rel))
    out["inputs"] = inputs
    out["endTs"] = end_ts
    with open(os.path.join(a.work, "build.json"), "w") as f:
        json.dump(out, f, indent=1, sort_keys=True)


def _has_parquet():
    try:
        import pyarrow  # noqa: F401
        return True
    except ImportError:
        return False


def load_panel(work, res):
    p = os.path.join(work, f"panel-{res.lower()}.parquet")
    P = pd.read_parquet(p) if os.path.exists(p) else pd.read_csv(os.path.join(work, f"panel-{res.lower()}.csv.gz"))
    own = np.load(os.path.join(work, f"own-{res.lower()}.npy")).astype(float)
    return P, own


# ----------------------------------------------------------------------------------------------- estimators
HS = (3, 24, 72)
COMP = ("D", "Rp", "B", "W", "O")          # signed contributions to cash: +D +Rp -B -W +O
SIGN = {"D": 1.0, "Rp": 1.0, "B": -1.0, "W": -1.0, "O": 1.0}
OWNK = {"W": 0, "D": 1, "Rp": 2, "B": 3}   # own[k] is already signed (W, B negative)
LAG0 = 340
GROSS = True


def make_data(P, own, eth):
    n = len(P)
    hts = P["hour_ts"].to_numpy(np.int64)
    d = {k: P[k].to_numpy(float) for k in ("W", "D", "Rp", "B", "O")}
    d["net"] = d["D"] + d["Rp"] - d["B"] - d["W"] + d["O"]
    d["own"] = own
    d["gross"] = d["D"] + d["Rp"] + d["B"] + d["W"]
    d["util"] = P["util"].to_numpy(float)
    d["kink"] = P["kink"].to_numpy(float) if "kink" in P else np.full(n, 0.92)
    d["how"] = ((hts // 3600) + 96) % 168            # 1970-01-01 is a Thursday: shift so 0 = Monday 00Z
    d["hod"] = (hts // 3600) % 24
    d["block"] = ((hts - hts[0]) // (30 * 86400)).astype(int)
    d["eth"] = eth
    d["unit"] = P["Wtop_unit"].to_numpy(np.uint64) if "Wtop_unit" in P else np.zeros(n, np.uint64)
    d["hts"] = hts
    return d


def outcomes(d, t, h, mode, comp=None, pre=False):
    """Sum over (t, t+h] (or the pre-window (t-h-1, t-1] when pre) of signed flows; mode 'all' or '3P'."""
    comps = COMP if comp is None else (comp,)
    y = np.zeros(len(t))
    for c in comps:
        cs = np.concatenate([[0.0], np.cumsum(SIGN[c] * d[c])])
        if pre:
            y += cs[t] - cs[t - h]
        else:
            y += cs[t + h + 1] - cs[t + 1]
            if mode == "3P" and c in OWNK:
                y -= d["own"][OWNK[c]][t, h]
    return y


def _dummies(codes):
    codes = np.asarray(codes)
    u, inv = np.unique(codes, return_inverse=True)
    M = np.zeros((len(codes), len(u)))
    M[np.arange(len(codes)), inv] = 1.0
    return M[:, 1:]


def _lagsum(x, t, a, b):
    cs = np.concatenate([[0.0], np.cumsum(x)])
    return cs[t - a + 1] - cs[t - b]          # sum x[t-b .. t-a]


def lp_controls(d, t, with_net):
    cols = [np.ones(len(t)), _dummies(d["how"][t])]   # no block effects: they use future flows (D-R18.2a)
    W = d["W"]
    cols.append(np.column_stack([W[t - j] for j in range(1, 25)]))
    cols.append(np.column_stack([_lagsum(W, t, 25, 48), _lagsum(W, t, 49, 72), _lagsum(W, t, 73, 168)]))
    u = d["util"][t - 1]
    cols.append(np.nan_to_num(u, nan=np.nanmean(u))[:, None])
    cols.append(np.column_stack([d["eth"][t - j] for j in range(0, 7)]))
    if GROSS:
        g = d["gross"]
        cols.append(np.column_stack([np.log1p(_lagsum(g, t, a_, b_)) for a_, b_ in ((1, 24), (25, 168), (169, 336))]
                                    + [_lagsum(g, t, a_, b_) for a_, b_ in ((1, 24), (25, 168), (169, 336))]))
    if with_net:
        nt = d["net"]
        cols.append(np.column_stack([nt[t - j] for j in range(1, 25)]))
        cols.append(np.column_stack([_lagsum(nt, t, 25, 72), _lagsum(nt, t, 73, 168)]))
    return np.column_stack([c if c.ndim == 2 else c[:, None] for c in cols])


def _resid(X, Y):
    Q, _ = np.linalg.qr(X, mode="reduced")
    return Y - Q @ (Q.T @ Y)


def _block_draws(blocks, B, rng):
    ub = np.unique(blocks)
    idx = np.searchsorted(ub, blocks)
    W = rng.multinomial(len(ub), np.full(len(ub), 1.0 / len(ub)), size=B).astype(float)   # B x nb
    return idx, W


def boot_ratio(num_rows, den_rows, groups, B, rng, groups2=None):
    """Ratio sum(num)/sum(den) with a cluster (pigeonhole two-way when groups2) bootstrap. num_rows: n x k."""
    num_rows = np.atleast_2d(num_rows.T).T
    g1 = np.unique(groups, return_inverse=True)[1]
    n1 = g1.max() + 1
    W1 = rng.multinomial(n1, np.full(n1, 1.0 / n1), size=B).astype(float)
    if groups2 is not None:
        g2 = np.unique(groups2, return_inverse=True)[1]
        n2 = g2.max() + 1
        W2 = rng.multinomial(n2, np.full(n2, 1.0 / n2), size=B).astype(float)
        w = W1[:, g1] * W2[:, g2]
    else:
        w = W1[:, g1]
    est = num_rows.sum(0) / den_rows.sum()
    bs = (w @ num_rows) / (w @ den_rows)[:, None]
    return est, bs


def summarize(est, bs):
    est = np.atleast_1d(est)
    lo, hi = np.nanpercentile(bs, [2.5, 97.5], axis=0)
    sd = np.nanstd(bs, axis=0)
    return [{"est": float(e), "lo": float(a), "hi": float(b), "sd": float(s)} for e, a, b, s in zip(est, lo, hi, sd)]


def fit_lp(d, t, B=2000, seed=1, modes=("3P", "all"), comps=True, shock=None, interact=None, norm=False):
    """Candidate (iii). Returns rho(h) per mode (+ components), pre-trend, and block-bootstrap CIs."""
    rng = np.random.default_rng(seed)
    X1 = lp_controls(d, t, False)
    if shock is None:
        s = _resid(X1, d["W"][t])
    else:
        s = shock
    X2 = lp_controls(d, t, True)
    G = None
    if norm:   # D-R18.2d: divide shock and outcomes by trailing 168 h mean gross flow (scale confounding)
        G = np.maximum(_lagsum(d["gross"], t, 1, 168) / 168.0, 1.0)
        s = s / G
        X2 = np.column_stack([X2, 1.0 / G])
    res = {"n": int(len(t)), "sdShock": float(s.std()), "norm": bool(norm)}
    regs = {"s": s}
    if interact is not None:
        cats = np.unique(interact)
        regs = {f"s_c{int(c)}": s * (interact == c) for c in cats}
    R = _resid(X2, np.column_stack(list(regs.values())))
    keys = []
    Ys = []
    for m in modes:
        for h in HS:
            keys.append((m, "net", h))
            Ys.append(outcomes(d, t, h, m))
            if comps:
                for c in COMP:
                    keys.append((m, c, h))
                    Ys.append(outcomes(d, t, h, m, comp=c))
    Ys = np.column_stack(Ys)
    if G is not None:
        Ys = Ys / G[:, None]
    Y = _resid(X2, Ys)
    bidx, Wb = _block_draws(d["block"][t], B, rng)
    nb = Wb.shape[1]
    out = {}
    for ri, rname in enumerate(regs):
        # multivariate when interacted: solve 2x2 per draw
        pass
    # per-block cross products
    k = R.shape[1]
    RR = np.zeros((nb, k, k))
    RY = np.zeros((nb, k, Y.shape[1]))
    for b in range(nb):
        m_ = bidx == b
        RR[b] = R[m_].T @ R[m_]
        RY[b] = R[m_].T @ Y[m_]
    est = np.linalg.solve(RR.sum(0), RY.sum(0))                 # k x ny
    bs = np.stack([np.linalg.solve(np.tensordot(w, RR, 1), np.tensordot(w, RY, 1)) for w in Wb])   # B x k x ny
    for ri, rname in enumerate(regs):
        sm = summarize(est[ri], bs[:, ri, :])
        for (m, c, h), v in zip(keys, sm):
            out.setdefault(rname, {}).setdefault(m, {}).setdefault(c, {})[f"{h}h"] = v
    if interact is not None and R.shape[1] == 2:
        diff = summarize(est[1] - est[0], bs[:, 1, :] - bs[:, 0, :])
        for (m, c, h), v in zip(keys, diff):
            out.setdefault("hi_minus_lo", {}).setdefault(m, {}).setdefault(c, {})[f"{h}h"] = v
    res["rho"] = out
    res["_s"] = s
    # pre-trend: pre-window flows on s with first-stage controls only (net lags are not in X1)
    if interact is None:
        Yp = np.column_stack([outcomes(d, t, h, "all", pre=True) for h in HS]
                             + [outcomes(d, t, h, "all", comp=c, pre=True) for h in HS for c in ("D", "Rp", "B")])
        if G is not None:
            Yp = Yp / G[:, None]
            X1 = np.column_stack([X1, 1.0 / G])
        Yp = _resid(X1, Yp)
        num = s[:, None] * Yp
        den = s * s
        e, b_ = boot_ratio(num, den, d["block"][t], B, rng)
        names = [f"net_{h}h" for h in HS] + [f"{c}_{h}h" for h in HS for c in ("D", "Rp", "B")]
        res["pretrend"] = dict(zip(names, summarize(e, b_)))
    return res


def fit_dl(d, t, L=72, B=2000, seed=2, w_override=None):
    """Candidate (i). net_t (and components) on W_{t-j}, j=-L..L, hour-of-week, block, ETH abs return."""
    rng = np.random.default_rng(seed)
    W = d["W"] if w_override is None else w_override
    lagcols = np.column_stack([W[t - j] for j in range(-L, L + 1)])     # column i <-> j = i - L
    X = np.column_stack([lagcols, np.ones(len(t)), _dummies(d["how"][t]),
                         np.column_stack([d["eth"][t - j] for j in range(0, 7)])]
                        + ([np.column_stack([f(_lagsum(d["gross"], t, a_, b_)) for a_, b_ in ((73, 168), (169, 336))
                                             for f in (np.log1p, lambda z: z)])] if GROSS else []))
    Ys = {"net": d["net"][t]}
    for c in COMP:
        Ys[c] = SIGN[c] * d[c][t]
    Y = np.column_stack(list(Ys.values()))
    bidx, Wb = _block_draws(d["block"][t], B, rng)
    nb = Wb.shape[1]
    p = X.shape[1]
    XX = np.zeros((nb, p, p))
    XY = np.zeros((nb, p, Y.shape[1]))
    for b in range(nb):
        m_ = bidx == b
        XX[b] = X[m_].T @ X[m_]
        XY[b] = X[m_].T @ Y[m_]
    # linear combos: post cum (j=1..h), lead cum (j=-h..-1), contemporaneous j=0
    A = []
    names = []
    for h in HS:
        a = np.zeros(p); a[L + 1:L + 1 + h] = 1; A.append(a); names.append(f"post_{h}h")
        a = np.zeros(p); a[L - h:L] = 1; A.append(a); names.append(f"lead_{h}h")
    a = np.zeros(p); a[L] = 1; A.append(a); names.append("contemporaneous")
    A = np.array(A)
    lam = 1e-9 * np.trace(XX.sum(0)) / p
    beta = np.linalg.solve(XX.sum(0) + lam * np.eye(p), XY.sum(0))
    est = A @ beta
    bs = np.stack([A @ np.linalg.solve(np.tensordot(w, XX, 1) + lam * np.eye(p), np.tensordot(w, XY, 1))
                   for w in Wb])
    out = {}
    for yi, yn in enumerate(Ys):
        sm = summarize(est[:, yi], bs[:, :, yi])
        out[yn] = dict(zip(names, sm))
    return {"n": int(len(t)), "rho_all": out, "beta_net": beta[:2 * L + 1, 0].tolist()}


def es_events(d, t, q_ev=0.99, sep=72, Ws=None):
    W = d["W"] if Ws is None else Ws
    thr = np.quantile(W[t], q_ev)
    cand = t[W[t] >= thr]
    cand = cand[np.argsort(-W[cand])]
    chosen = []
    taken = np.zeros(len(W), bool)
    for c in cand:
        if not taken[max(0, c - sep):c + sep + 1].any():
            chosen.append(c)
            taken[c] = True
    return np.sort(np.array(chosen, dtype=np.int64)), thr


def es_match(d, t, ev, K=5, q_ctl=0.90, sep=72, thr=None, Ws=None):
    W = d["W"] if Ws is None else Ws
    near = np.zeros(len(W), bool)
    for e in ev:
        near[max(0, e - sep):e + sep + 1] = True
    q90 = np.quantile(W[t], q_ctl) if thr is None else thr
    pool = t[(~near[t]) & (W[t] < q90)]
    wk = lambda x: ((d["how"][x] // 24) >= 5).astype(int)
    f = lambda x: np.column_stack([np.log1p(_lagsum(W, x, 1, 24)), np.log1p(_lagsum(d["D"], x, 1, 24)),
                                   np.nan_to_num(d["util"][x - 1], nan=0.85), x / (365 * 24.0)]
                                  + ([np.log1p(_lagsum(d["gross"], x, 1, 168))] if GROSS else []))
    Fp = f(pool)
    sd = Fp.std(0) + 1e-12
    ctl = np.zeros((len(ev), K), np.int64)
    Fe = f(ev)
    for i, e in enumerate(ev):
        same = (d["hod"][pool] == d["hod"][e]) & (wk(pool) == wk(np.array([e]))[0])
        for win in (336, 672, 10 ** 9):              # local in calendar time first (D-R18.2b)
            m_ = same & (np.abs(pool - e) <= win)
            if m_.sum() >= K:
                break
        cp = pool[m_]
        dist = (((Fp[m_] - Fe[i]) / sd) ** 2).sum(1)
        o = cp[np.argsort(dist)[:K]]
        ctl[i] = np.resize(o, K)
    return ctl


def fit_es(d, t, B=2000, seed=3, ev=None, modes=("3P", "all"), comps=True, q_ev=0.99, did=False, Ws=None):
    """did=False: registered level event study. did=True (D-R18.2b): controls need only W below the event
    threshold, events are 144 h apart, and the matched pre-window difference (same length h) is subtracted;
    the placebo is the same DiD one window earlier."""
    rng = np.random.default_rng(seed)
    sep = 144 if did else 72
    tt = t[(t >= t[0] + 2 * HMAX)] if did else t
    W = d["W"] if Ws is None else Ws          # Ws: shifted shock series for the S3 placebo
    if ev is None:
        ev, thr = es_events(d, tt, q_ev, sep=sep, Ws=W)
    else:
        thr = None
    ctl = es_match(d, tt, ev, sep=sep, thr=(np.quantile(W[tt], q_ev) if did else None), Ws=W)
    den = W[ev] - W[ctl].mean(1)
    res = {"nEvents": int(len(ev)), "threshold": None if thr is None else float(thr),
           "meanEventW": float(W[ev].mean()), "meanControlW": float(W[ctl].mean()),
           "nUnits": int(len(np.unique(d["unit"][ev]))), "nBlocks": int(len(np.unique(d["block"][ev])))}
    keys, nums = [], []
    cflat = ctl.ravel()
    def dd(x_e, x_c):
        return x_e - x_c.reshape(ctl.shape).mean(1)
    for m in modes:
        for h in HS:
            for c in ((None,) + (COMP if comps else ())):
                v = dd(outcomes(d, ev, h, m, comp=c), outcomes(d, cflat, h, m, comp=c))
                if did:
                    v = v - dd(outcomes(d, ev, h, "all", comp=c, pre=True), outcomes(d, cflat, h, "all", comp=c, pre=True))
                keys.append((m, "net" if c is None else c, h, "post"))
                nums.append(v)
    for h in HS:
        for c in (None, "D", "Rp", "B", "W"):
            v = dd(outcomes(d, ev, h, "all", comp=c, pre=True), outcomes(d, cflat, h, "all", comp=c, pre=True))
            if did:
                v = v - dd(outcomes(d, ev - h, h, "all", comp=c, pre=True), outcomes(d, cflat - h, h, "all", comp=c, pre=True))
            keys.append(("pre", "net" if c is None else c, h, "pre"))
            nums.append(v)
    # same-hour (contemporaneous) offset
    for c in ("D", "Rp", "B"):
        keys.append(("same_hour", c, 0, "t"))
        nums.append(SIGN[c] * (d[c][ev] - d[c][ctl].mean(1)))
    num = np.column_stack(nums)
    e1, b1 = boot_ratio(num, den, d["unit"][ev], B, rng, groups2=d["block"][ev])
    eb, bb = boot_ratio(num, den, d["block"][ev], B, rng)
    s1 = summarize(e1, b1)
    sb = summarize(eb, bb)
    out = {}
    for (m, c, h, kind), v, vb in zip(keys, s1, sb):
        v = dict(v)
        v["lo_block"], v["hi_block"] = vb["lo"], vb["hi"]
        out.setdefault(m, {}).setdefault(c, {})[f"{h}h"] = v
    res["rho"] = out
    res["_ev"] = ev
    return res


def old_r72(d, t):
    """The faulted R7.2 estimator: OLS of repays in [t+1, t+1+h) on W_t (no controls)."""
    out = {}
    cs = np.concatenate([[0.0], np.cumsum(d["Rp"])])
    x = d["W"][t]
    for h in HS:
        y = cs[t + 1 + h] - cs[t + 1]
        X = np.column_stack([np.ones_like(x), x])
        b = np.linalg.lstsq(X, y, rcond=None)[0]
        out[f"{h}h"] = float(b[1])
    return out


# ----------------------------------------------------------------------------------------------- synthetic
def kernel(a, tau, L=HMAX):
    j = np.arange(1, L + 1)
    g = np.exp(-j / tau)
    return a * g / g.sum() if a else np.zeros(L)


SYN_K = {"D": (0.12, 18.0), "Rp": (0.06, 24.0), "Bcut": (0.04, 8.0), "Wc": (0.05, 4.0)}


def synth_truth(K):
    """Impulse response with feedback: contagion withdrawals also trigger the kernels."""
    kD, kR, kB, kC = (kernel(*K[x]) for x in ("D", "Rp", "Bcut", "Wc"))
    Wt = np.zeros(HMAX + 1); Wt[0] = 1.0
    D = np.zeros(HMAX + 1); R = np.zeros(HMAX + 1); Bc = np.zeros(HMAX + 1); C = np.zeros(HMAX + 1)
    for s in range(1, HMAX + 1):
        past = Wt[s - 1::-1][:s]           # W_tot(s-1), ..., W_tot(0)
        C[s] = (kC[:s] * past).sum()
        Wt[s] = C[s]
        D[s] = (kD[:s] * past).sum(); R[s] = (kR[:s] * past).sum(); Bc[s] = (kB[:s] * past).sum()
    net = D + R + Bc - C
    cum = lambda x: {f"{h}h": float(x[1:h + 1].sum()) for h in HS}
    return {"net": cum(net), "D": cum(D), "Rp": cum(R), "B": cum(Bc), "W": cum(-C)}


def synth_truth_direct(K):
    """What the DL estimates: the direct response holding other hours' withdrawals fixed (no contagion, no feedback)."""
    kD, kR, kB = (kernel(*K[x]) for x in ("D", "Rp", "Bcut"))
    k = kD + kR + kB
    return {f"{h}h": float(k[:h].sum()) for h in HS}


def synth_series(seed, n=30000, K=SYN_K, round_trips=True, comove="ar", trend=0.0):
    rng = np.random.default_rng(seed)
    t = np.arange(n)
    hod = t % 24
    # latent persistent activity (co-movement) and an observed market driver
    la = np.zeros(n)
    if comove == "ar":
        e = rng.normal(0, 0.03, n)
        for i in range(1, n):
            la[i] = 0.998 * la[i - 1] + e[i]
    else:   # held-out design: two-state Markov activity (x3), mean stay 10 days, plus a weekly cycle
        st = 0
        for i in range(1, n):
            if rng.random() < 1 / 240:
                st = 1 - st
            la[i] = np.log(3.0) * st
        la = la + 0.3 * np.sin(2 * np.pi * t / 168)
    A = np.exp(la)
    vol = np.exp(np.convolve(rng.normal(0, 0.15, n), np.ones(48) / 48, "same"))
    M = np.abs(rng.standard_t(4, n)) * vol * 0.01
    Mm = M / M.mean()
    cyc = 1 + 2.0 * (hod == 0) + 0.5 * (hod == 23)
    # exogenous third-party withdrawals and rare large exits (no return)
    W3 = A * 2.5e6 * cyc * rng.lognormal(-0.7, 1.2, n) * (0.6 + 0.4 * Mm)
    big = rng.random(n) < 0.004
    W3 = W3 + big * A * 4e7 * (rng.pareto(1.6, n) + 1)
    # daily round tripper: withdraws at 23:00, returns at 00:00 next hour
    RT = np.zeros(n)
    if round_trips:
        RT[hod == 23] = A[hod == 23] * 3e7 * rng.lognormal(0, 0.5, (hod == 23).sum())
    kD, kR, kB, kC = (kernel(*K[x]) for x in ("D", "Rp", "Bcut", "Wc"))
    Wc = np.zeros(n)
    Wtot = W3 + RT
    D = A * 3e6 * cyc * rng.lognormal(-0.5, 1.0, n) * (0.6 + 0.4 * Mm)
    Rp = A * 2e6 * cyc * rng.lognormal(-0.5, 0.9, n) * (0.6 + 0.4 * Mm)
    Bb = A * 2e6 * (1 + 0.5 * (hod == 0)) * rng.lognormal(-0.5, 0.9, n) * (0.6 + 0.4 * Mm)
    # same-hour co-movement (excluded from the estimand)
    D = D + 0.3 * W3 * rng.random(n)
    respD = np.zeros(n); respR = np.zeros(n); respB = np.zeros(n)
    L = HMAX
    for i in range(1, n):
        lo = max(0, i - L)
        past = Wtot[lo:i][::-1]
        Wc[i] = (kC[:len(past)] * past).sum()
        Wtot[i] += Wc[i]
        respD[i] = (kD[:len(past)] * past).sum()
        respR[i] = (kR[:len(past)] * past).sum()
        respB[i] = (kB[:len(past)] * past).sum()
    D = D + respD + np.roll(RT, 1) + trend * A * 1e6   # round trip returns as the same unit's deposit
    Rp = Rp + respR
    Bb = np.maximum(Bb - respB, 0.0) + np.minimum(Bb - respB, 0.0)   # allow negative (pure linear response)
    W = W3 + RT + Wc
    own = np.zeros((4, n, HMAX + 1), np.float32)
    if round_trips:
        # the round tripper's own flows after an origin hour at 23:00: return at +1, next trips at +24k, +24k+1
        idx = np.where(RT > 0)[0]
        for j in range(1, HMAX + 1):
            for k_ in range(0, 4):
                tw = idx + 24 * k_ if k_ > 0 else None
                if k_ > 0:
                    ok = tw < n
                    sel = (24 * k_ <= j)
                    if sel:
                        own[0][idx[ok], j] += -RT[tw[ok]]
                okd = idx + 24 * k_ + 1 < n
                if 24 * k_ + 1 <= j:
                    own[1][idx[okd], j] += RT[idx[okd] + 24 * k_]
    hts = H0 + 3600 * t
    P = pd.DataFrame({"hour_ts": hts, "W": W, "D": D, "Rp": Rp, "B": Bb, "O": 0.0,
                      "util": 0.85 + 0.05 * np.tanh(la), "Wtop_unit": np.where(RT > 0, 1, 2 + (t // 1)).astype(np.uint64)})
    return P, own, M


def cmd_synth(a):
    os.makedirs(a.work, exist_ok=True)
    R = a.reps
    designs = {"A_homog": dict(K=SYN_K, round_trips=False), "B_roundtrip": dict(K=SYN_K, round_trips=True),
               "N_null": dict(K={k: (0.0, v[1]) for k, v in SYN_K.items()}, round_trips=True),
               "C_heldout": dict(K=SYN_K, round_trips=True, comove="markov", trend=1.0)}
    if a.designs:
        designs = {k: v for k, v in designs.items() if k in a.designs.split(",")}
    out = {"kernel": SYN_K, "reps": R, "designs": {}}
    for name, cfg in designs.items():
        truth = synth_truth(cfg["K"])
        rows = []
        for r in range(R):
            P, own, M = synth_series({"A_homog": 11000, "B_roundtrip": 22000, "N_null": 33000,
                                      "C_heldout": 44000}[name] + r, **cfg)
            d = make_data(P, own, M)
            t = np.arange(LAG0, len(P) - HMAX - 1)
            lp = fit_lp(d, t, B=a.boot, seed=r, comps=False)
            dl = fit_dl(d, t, B=a.boot, seed=r)
            es = fit_es(d, t, B=a.boot, seed=r, comps=False)
            esd = fit_es(d, t, B=a.boot, seed=r, comps=False, did=True)
            old = old_r72(d, t)
            rows.append({"lp": lp, "dl": dl, "es": es, "esd": esd, "old": old})
            print(name, r, {h: (round(lp["rho"]["s"]["3P"]["net"][h]["est"], 3),
                                round(es["rho"]["3P"]["net"][h]["est"], 3),
                                round(dl["rho_all"]["net"][f"post_{h}"]["est"], 3), round(old[h], 3))
                            for h in ("3h", "24h", "72h")}, flush=True)
        out["designs"][name] = {"truth": truth, "truthDirect": synth_truth_direct(cfg["K"]),
                                "summary": synth_summary(rows, truth, synth_truth_direct(cfg["K"]))}
        with open(os.path.join(a.work, f"synth-{name}.json"), "w") as f:
            json.dump(out["designs"][name], f, indent=1, sort_keys=True)
    with open(os.path.join(a.work, "synth.json"), "w") as f:
        json.dump(out, f, indent=1, sort_keys=True)
    print(json.dumps({k: v["summary"] for k, v in out["designs"].items()}, indent=1))


def synth_summary(rows, truth, tdir):
    S = {}
    def acc(name, getter, tr):
        for h in ("3h", "24h", "72h"):
            v = [getter(r, h) for r in rows]
            est = np.array([x["est"] if isinstance(x, dict) else x for x in v])
            T = tr[h]
            ent = {"truth": T, "meanEst": float(est.mean()), "bias": float(est.mean() - T),
                   "sdEst": float(est.std()), "tol": max(0.02, 0.2 * abs(T))}
            if isinstance(v[0], dict):
                cov = np.mean([(x["lo"] <= T <= x["hi"]) for x in v])
                ent["coverage"] = float(cov)
            ent["passBias"] = bool(abs(ent["bias"]) <= ent["tol"])
            S.setdefault(name, {})[h] = ent
    acc("lp_3P_net", lambda r, h: r["lp"]["rho"]["s"]["3P"]["net"][h], truth["net"])
    acc("es_3P_net", lambda r, h: r["es"]["rho"]["3P"]["net"][h], truth["net"])
    acc("esdid_3P_net", lambda r, h: r["esd"]["rho"]["3P"]["net"][h], truth["net"])
    acc("esdid_pre_net", lambda r, h: r["esd"]["rho"]["pre"]["net"][h], {k: 0.0 for k in truth["net"]})
    acc("lp_all_net", lambda r, h: r["lp"]["rho"]["s"]["all"]["net"][h], truth["net"])
    acc("dl_direct_net", lambda r, h: r["dl"]["rho_all"]["net"][f"post_{h}"], tdir)
    acc("dl_lead_net", lambda r, h: r["dl"]["rho_all"]["net"][f"lead_{h}"], {k: 0.0 for k in truth["net"]})
    acc("lp_pre_net", lambda r, h: r["lp"]["pretrend"][f"net_{h}"], {k: 0.0 for k in truth["net"]})
    acc("es_pre_net", lambda r, h: r["es"]["rho"]["pre"]["net"][h], {k: 0.0 for k in truth["net"]})
    acc("old_r72_repay", lambda r, h: r["old"][h], truth["Rp"])
    return S



# ----------------------------------------------------------------------------------------------- real-data fit
def eth_abs_return(ds, hts):
    j = json.load(open(os.path.join(ds, "binance-klines/ETHUSDT-1h.json")))
    c = np.asarray(j["columns"]["close"], float)
    ts = j["startTs"] + j["stepSeconds"] * np.arange(len(c))
    s = pd.Series(np.log(c), index=ts).reindex(hts).ffill().to_numpy()
    r1 = np.abs(np.diff(s, prepend=s[0]))
    r24 = np.abs(s - np.concatenate([np.full(24, s[0]), s[:-24]]))
    return np.nan_to_num(r1), np.nan_to_num(r24)


def optimal_util(ds, res, hts):
    st = pd.read_csv(os.path.join(ds, "depositor-balances/reserve-state.csv"), usecols=["snapshot", "reserve", "block_ts", "optimal"])
    st = st[(st["reserve"] == res) & st["optimal"].notna()]
    st = st[st["snapshot"] != "asof"].sort_values("block_ts")
    o = pd.to_numeric(st["optimal"], errors="coerce").to_numpy() / 1e27
    idx = np.searchsorted(st["block_ts"].to_numpy(), hts, side="right") - 1
    return np.where(idx >= 0, o[np.clip(idx, 0, None)], np.nan)


def load_real(ds, work, res):
    P, own = load_panel(work, res)
    hts = P["hour_ts"].to_numpy(np.int64)
    r1, r24 = eth_abs_return(ds, hts)
    P["kink"] = optimal_util(ds, res, hts)
    d = make_data(P, own, r1)
    d["eth24"] = r24
    return d


def origins(d, excl_q2=False):
    n = len(d["W"])
    t = np.arange(LAG0, n - HMAX - 1)
    if excl_q2:
        q0 = int(datetime(2026, 4, 1, tzinfo=timezone.utc).timestamp())
        q1 = int(datetime(2026, 7, 1, tzinfo=timezone.utc).timestamp())
        h = d["hts"][t]
        t = t[(h + 3600 * HMAX < q0) | (h - 3600 * 336 >= q1)]
    return t


def perm_lp(d, t, s, nperm, rng):
    """S3: shift the shock by whole weeks (keeps hour-of-week), regress the 3P outcomes on it."""
    X2 = lp_controls(d, t, True)
    Q, _ = np.linalg.qr(X2, mode="reduced")
    Y = np.column_stack([outcomes(d, t, h, "3P") for h in HS] + [outcomes(d, t, h, "all") for h in HS])
    Y = Y - Q @ (Q.T @ Y)
    nw = len(t) // 168
    out = []
    for _ in range(nperm):
        k = 168 * rng.integers(8, nw - 8)
        ss = np.roll(s, k)
        r = ss - Q @ (Q.T @ ss)
        out.append((r @ Y) / (r @ r))
    return np.array(out)


def perm_dl(d, t, nperm, rng):
    nw = len(d["W"]) // 168
    out = []
    for _ in range(nperm):
        k = 168 * rng.integers(8, nw - 8)
        r = fit_dl(d, t, B=1, w_override=np.roll(d["W"], k))
        out.append([r["rho_all"]["net"][f"post_{h}h"]["est"] for h in HS])
    return np.array(out)


def perm_es(d, t, nperm, rng, did=False):
    """S3: shift the whole withdrawal series by whole weeks, select events and controls on the shifted series,
    score the real flows."""
    out = []
    n = len(d["W"])
    for _ in range(nperm):
        k = 168 * rng.integers(8, n // 168 - 8)
        r = fit_es(d, t, B=1, comps=False, modes=("3P",), did=did, Ws=np.roll(d["W"], k))
        out.append([r["rho"]["3P"]["net"][f"{h}h"]["est"] for h in HS])
    return np.array(out)


def strip(o):
    if isinstance(o, dict):
        return {k: strip(v) for k, v in o.items() if not k.startswith("_")}
    if isinstance(o, list):
        return [strip(v) for v in o]
    return o


def pooled_lp(ds_list, B, rng):
    """USDC + USDT pooled LP with a market x 30-day block pigeonhole bootstrap (reported)."""
    parts = []
    for d, t in ds_list:
        X1 = lp_controls(d, t, False)
        s = _resid(X1, d["W"][t])
        X2 = lp_controls(d, t, True)
        r = _resid(X2, s[:, None])[:, 0]
        Y = _resid(X2, np.column_stack([outcomes(d, t, h, "3P") for h in HS] + [outcomes(d, t, h, "all") for h in HS]))
        parts.append((r, Y, d["block"][t]))
    nb = max(p[2].max() for p in parts) + 1
    RR = np.zeros((len(parts), nb))
    RY = np.zeros((len(parts), nb, 2 * len(HS)))
    for m, (r, Y, b) in enumerate(parts):
        for k in range(nb):
            q = b == k
            RR[m, k] = r[q] @ r[q]
            RY[m, k] = r[q] @ Y[q]
    est = RY.sum((0, 1)) / RR.sum()
    Wm = rng.multinomial(len(parts), np.full(len(parts), 1 / len(parts)), size=B)
    Wb = rng.multinomial(nb, np.full(nb, 1 / nb), size=B)
    bs = np.array([np.einsum("m,b,mbk->k", wm, wb, RY) / np.einsum("m,b,mb->", wm, wb, RR) for wm, wb in zip(Wm, Wb)])
    names = [f"3P_{h}h" for h in HS] + [f"all_{h}h" for h in HS]
    # market-specific
    per = [{n: float(v) for n, v in zip(names, RY[m].sum(0) / RR[m].sum())} for m in range(len(parts))]
    return {"pooled": dict(zip(names, summarize(est, bs))), "perMarket": per}


def cmd_fit(a):
    os.makedirs(a.out, exist_ok=True)
    rng = np.random.default_rng(20261823)
    B = a.boot
    d = load_real(a.datasets, a.work, "USDC")
    res = {"schema": "q26-r182/fit/1", "market": "Aave V3 Ethereum Core USDC (seen, development)",
           "estimand": "rho(h) = dE[C(t+h)-C(t)|s_t,F(t-1)]/ds_t, h=3,24,72; 3P removes the hour-t withdrawers' flows",
           "B": B, "seed": 20261823}
    for tag, ex in (("all", False), ("exQ2", True)):
        t = origins(d, ex)
        r = {"nOrigins": int(len(t)), "from": int(d["hts"][t[0]]), "to": int(d["hts"][t[-1]])}
        lp = fit_lp(d, t, B=B, seed=1)
        r["lp"] = lp
        r["lp_norm"] = fit_lp(d, t, B=B, seed=11, norm=True)
        r["dl"] = fit_dl(d, t, B=B, seed=2)
        es = fit_es(d, t, B=B, seed=3)
        r["es"] = es
        r["esdid"] = fit_es(d, t, B=B, seed=33, did=True)
        r["oldR72_onThisPanel"] = old_r72(d, t)
        if tag == "all" or a.perm_both:
            pl = perm_lp(d, t, lp["_s"], a.nperm, rng)
            pd_ = perm_dl(d, t, max(20, a.nperm // 4), rng)
            pe = perm_es(d, t, max(20, a.nperm // 2), rng)
            pedd = perm_es(d, t, max(20, a.nperm // 2), rng, did=True)
            def ps(arr, real, names):
                return {nm: {"mean": float(arr[:, i].mean()), "sd": float(arr[:, i].std()),
                             "q025": float(np.quantile(arr[:, i], 0.025)), "q975": float(np.quantile(arr[:, i], 0.975)),
                             "realRankShare": float((arr[:, i] < real[i]).mean())} for i, nm in enumerate(names)}
            real_lp = [lp["rho"]["s"]["3P"]["net"][f"{h}h"]["est"] for h in HS] + \
                      [lp["rho"]["s"]["all"]["net"][f"{h}h"]["est"] for h in HS]
            r["permutation"] = {
                "lp": ps(pl, real_lp, [f"3P_{h}h" for h in HS] + [f"all_{h}h" for h in HS]),
                "dl": ps(pd_, [r["dl"]["rho_all"]["net"][f"post_{h}h"]["est"] for h in HS], [f"dir_all_{h}h" for h in HS]),
                "es": ps(pe, [es["rho"]["3P"]["net"][f"{h}h"]["est"] for h in HS], [f"3P_{h}h" for h in HS]),
                "esdid": ps(pedd, [r["esdid"]["rho"]["3P"]["net"][f"{h}h"]["est"] for h in HS], [f"3P_{h}h" for h in HS]),
                "n": {"lp": int(len(pl)), "dl": int(len(pd_)), "es": int(len(pe)), "esdid": int(len(pedd))}}
        # utilisation (curve kink) and market state
        u = d["util"][t - 1]
        kink = (u >= d["kink"][t - 1]).astype(int)
        r["lp_byKink"] = fit_lp(d, t, B=B, seed=4, comps=False, interact=kink)["rho"]
        r["kinkShare"] = float(kink.mean())
        terc = np.digitize(u, np.nanquantile(u, [1 / 3, 2 / 3]))
        r["lp_byUtilTercile"] = fit_lp(d, t, B=B, seed=5, comps=False, interact=terc)["rho"]
        r["utilTercileCuts"] = [float(x) for x in np.nanquantile(u, [1 / 3, 2 / 3])]
        e24 = d["eth24"][t - 1]
        et = np.digitize(e24, np.quantile(e24, [1 / 3, 2 / 3]))
        r["lp_byEthTercile"] = fit_lp(d, t, B=B, seed=6, comps=False, interact=et)["rho"]
        evk = es["_ev"]
        ek = (d["util"][evk - 1] >= d["kink"][evk - 1])
        r["es_byKink"] = {}
        for nm, m_ in (("below", ~ek), ("above", ek)):
            if m_.sum() >= 10:
                r["es_byKink"][nm] = fit_es(d, t, B=B, seed=7, ev=evk[m_], comps=False)["rho"]
                r["es_byKink"][nm]["nEvents"] = int(m_.sum())
        res[tag] = strip(r)
        print(tag, "done", flush=True)
    # pooled with USDT (reported)
    du = load_real(a.datasets, a.work, "USDT")
    res["pooled_USDC_USDT"] = pooled_lp([(d, origins(d)), (du, origins(du)[d["hts"][origins(d)][0] <= du["hts"][origins(du)]] if False else origins(du))], B, rng)
    tu = origins(du)
    tu = tu[du["W"][tu - 1].cumsum() > 0]
    res["usdt_lp"] = strip(fit_lp(du, tu, B=B, seed=8, comps=False))
    res["usdt_es"] = strip(fit_es(du, tu, B=B, seed=9, comps=False))
    res["code"] = {"file": "scripts/research/history-forecasts/r182_refill.py", "sha256": sha256_file(os.path.abspath(__file__))}
    res["build"] = json.load(open(os.path.join(a.work, "build.json")))
    with open(os.path.join(a.out, "fit-r182.json"), "w") as f:
        json.dump(res, f, indent=1, sort_keys=True)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build")
    b.add_argument("--datasets", required=True)
    b.add_argument("--work", required=True)
    sy = sub.add_parser("synth")
    sy.add_argument("--work", required=True)
    sy.add_argument("--reps", type=int, default=40)
    sy.add_argument("--boot", type=int, default=300)
    sy.add_argument("--designs", default="")
    fi = sub.add_parser("fit")
    fi.add_argument("--datasets", required=True)
    fi.add_argument("--work", required=True)
    fi.add_argument("--out", required=True)
    fi.add_argument("--boot", type=int, default=2000)
    fi.add_argument("--nperm", type=int, default=200)
    fi.add_argument("--perm-both", action="store_true")
    a = ap.parse_args(argv)
    if a.cmd == "fit":
        cmd_fit(a)
    if a.cmd == "build":
        cmd_build(a)
    elif a.cmd == "synth":
        cmd_synth(a)
    return 0


if __name__ == "__main__":
    sys.exit(main())
