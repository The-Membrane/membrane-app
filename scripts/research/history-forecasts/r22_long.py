"""Q26 R22: ETH/BTC deep borrower-warning cells regraded on pre-2017 history spliced to Binance. DEVELOPMENT ONLY.

Design, splice rule, arms, statistics and the era rule: membrane-board design/q26-r22-long-history-2026-10-25.md
(registered at board 7a91774 before any score of this script).

Every price read here is seen data. Bitstamp BTC and Coinbase BTC/ETH are the spent A3 locked set. Kraken ETH is the
spent R11.10 P1 blind (already in development panels). Nothing here is blind evidence and nothing ships from it.

  python3 r22_long.py grids --datasets DS --out OUT     (spliced ETH and BTC grids, splice gaps, null counts)
  python3 r22_long.py rows  --datasets DS --out OUT     (r192_borrower.task on B0 Binance grids and on the spliced grids)
  python3 r22_long.py check --datasets DS --out OUT     (B0 rows vs published R19.5 input I rows, bit for bit)
  python3 r22_long.py score --out OUT [--seeds 5]       (B0, L1, L2 grades, era tables, sensitivities)
No address, key or secret is read or written.
"""
from __future__ import annotations

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import datetime as dt  # noqa: E402
import gzip  # noqa: E402
import json  # noqa: E402
import math  # noqa: E402
import multiprocessing as mp  # noqa: E402
import shutil  # noqa: E402
import subprocess  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402

import numpy as np  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

STEP, DAY = 3600, 86400
TS_B = (6, 12, 24, 72, 168)
TL = {6: "6h", 12: "12h", 24: "1d", 72: "3d", 168: "7d"}
L8 = (-0.02, -0.03, -0.05, -0.07, -0.10, -0.15, -0.20, -0.30)
LV = (-0.10, -0.15, -0.20, -0.30)
JL = [L8.index(k) for k in LV]
SPLICE = 1502942400                       # 2017-08-17T04:00Z, first Binance kline (ETHUSDT and BTCUSDT)
B_BOOT = 1000
ARM_OFF = {"B0": 0, "L1": 100000, "L2": 200000}
SEED_STEP = 7919                          # extra seed offsets for the seed-spread re-run
E1_END, E2_END = 1483228800, 1609459200   # 2017-01-01, 2021-01-01
R195_ROWS = "history-forecasts/r19/r195-inputs-f4056460/rows-r195.npz"
DISK_STOP = 1.5e9


def utc(s):
    return int(dt.datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc).timestamp())


def iso(t):
    return dt.datetime.fromtimestamp(int(t), dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def now():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def git_sha():
    try:
        return subprocess.check_output(["git", "-C", HERE, "rev-parse", "--short=8", "HEAD"], text=True).strip()
    except Exception:  # noqa: BLE001
        return "unknown"


def free_disk():
    return shutil.disk_usage("/").free


# registered splice table (design section 1): (asset, venue, path, first hour open, last hour open, null zero-volume)
def splice_plan(ds):
    fb = os.path.join(ds, "final-blind-prices")
    return {
        "BTC": [("bitstamp", os.path.join(fb, "bitstamp-btc-usd-1h.json"), utc("2013-01-01T00:00:00Z"), SPLICE - STEP, True),
                ("binance", os.path.join(ds, "binance-klines/BTCUSDT-1h.json"), SPLICE, None, False)],
        "ETH": [("kraken", os.path.join(ds, "history-forecasts/r11/r1110-run-a91e04ad/acq/kraken-xethzusd-1h.json"),
                 utc("2016-01-01T00:00:00Z"), utc("2016-06-30T23:00:00Z"), True),
                ("coinbase", os.path.join(fb, "coinbase-eth-usd-1h.json"), utc("2016-07-01T00:00:00Z"), SPLICE - STEP, True),
                ("binance", os.path.join(ds, "binance-klines/ETHUSDT-1h.json"), SPLICE, None, False)],
    }


def read_raw(path):
    raw = open(path, "rb").read()
    if path.endswith(".gz"):
        raw = gzip.decompress(raw)
    return json.loads(raw)


def build_spliced(ds, asset):
    plan = splice_plan(ds)[asset]
    st = plan[0][2]
    segs, info = [], []
    for venue, path, t0, t1, null_zero in plan:
        d = read_raw(path)
        s0 = int(d["startTs"])
        cols = d["columns"]
        n = len(cols["close"])
        if t1 is None:
            t1 = s0 + STEP * (n - 1)
        i0, i1 = (t0 - s0) // STEP, (t1 - s0) // STEP + 1
        assert i0 >= 0 and i1 <= n, (venue, i0, i1, n)
        seg = {c: list(cols[c][i0:i1]) for c in ("open", "high", "low", "close", "volume")}
        nz = 0
        if null_zero:
            for j, v in enumerate(seg["volume"]):
                if v is None or float(v) == 0.0:
                    if seg["close"][j] is not None:
                        nz += 1
                    for c in ("open", "high", "low", "close"):
                        seg[c][j] = None
        nn = sum(1 for v in seg["close"] if v is None)
        info.append({"venue": venue, "first": iso(t0), "last": iso(t1), "hours": i1 - i0, "nulled_zero_volume": nz,
                     "null_hours_after": nn, "source": d.get("source", "")[:200]})
        segs.append((t0, seg))
    out = {c: [] for c in ("open", "high", "low", "close", "volume")}
    t_exp = st
    for t0, seg in segs:
        assert t0 == t_exp, (asset, iso(t0), iso(t_exp))
        for c in out:
            out[c].extend(seg[c])
        t_exp = t0 + STEP * len(seg["close"])
    # splice gaps: ln(first open of the new venue / last non-null close of the previous venue)
    gaps = []
    for j in range(1, len(segs)):
        t0 = segs[j][0]
        k = (t0 - st) // STEP
        prev = next((out["close"][q] for q in range(k - 1, -1, -1) if out["close"][q] is not None), None)
        first = next((out["open"][q] for q in range(k, len(out["open"])) if out["open"][q] is not None), None)
        gaps.append({"at": iso(t0), "from": info[j - 1]["venue"], "to": info[j]["venue"],
                     "ln_gap": math.log(float(first) / float(prev))})
    return st, out, info, gaps


def grid_path(out, asset):
    return os.path.join(out, "grids", f"{asset}-spliced-1h.json.gz")


def cmd_grids(a):
    os.makedirs(os.path.join(a.out, "grids"), exist_ok=True)
    meta = {"code": git_sha(), "created_utc": now(), "assets": {}}
    for asset in ("BTC", "ETH"):
        st, cols, info, gaps = build_spliced(a.datasets, asset)
        doc = {"schema": "q26-r22/spliced-hourly/1", "asset": f"{asset}/USD(T) spliced", "startTs": st, "stepSeconds": STEP,
               "count": len(cols["close"]), "rule": "membrane-board design/q26-r22-long-history-2026-10-25.md section 1",
               "segments": info, "columns": cols}
        raw = json.dumps(doc, separators=(",", ":")).encode()
        with open(grid_path(a.out, asset), "wb") as f:
            f.write(gzip.compress(raw, 6, mtime=0))
        meta["assets"][asset] = {"start": iso(st), "hours": len(cols["close"]), "segments": info, "splice_gaps": gaps}
        print(asset, iso(st), len(cols["close"]), json.dumps(gaps), flush=True)
    json.dump(meta, open(os.path.join(a.out, "grids-meta.json"), "w"), indent=1)


# =====================================================================================================================
# rows
# =====================================================================================================================
def specs(a):
    return [{"arm": "B0", "sym": "ETHUSDT", "key": "binance:ETHUSDT", "kind": "grid",
             "path": os.path.join(a.datasets, "binance-klines/ETHUSDT-1h.json")},
            {"arm": "B0", "sym": "BTCUSDT", "key": "binance:BTCUSDT", "kind": "grid",
             "path": os.path.join(a.datasets, "binance-klines/BTCUSDT-1h.json")},
            {"arm": "L", "sym": "ETHUSDT", "key": "r22:ETH", "kind": "grid", "path": grid_path(a.out, "ETH")},
            {"arm": "L", "sym": "BTCUSDT", "key": "r22:BTC", "kind": "grid", "path": grid_path(a.out, "BTC")}]


def _rows_job(spec):
    import r192_borrower as B
    t0 = time.time()
    r = B.task({k: v for k, v in spec.items() if k in ("key", "kind", "path")})
    out = {}
    for T, R in r["rows"].items():
        m = R["ts"] % DAY == 0
        out[T] = {k: np.asarray(R[k])[m] for k in ("ts", "y", "a", "fH")}
    return spec["arm"], spec["sym"], out, time.time() - t0


def cmd_rows(a):
    import r16_dev as RD
    if free_disk() < DISK_STOP:
        sys.exit("disk below 1.5 GB: stop")
    RD.init_btc(a.datasets)
    sp = specs(a)
    arr = {}
    print(now(), f"START r22 rows; code {git_sha()}", flush=True)
    with mp.get_context("fork").Pool(a.workers, maxtasksperchild=1) as pool:
        for arm, sym, res, sec in pool.imap_unordered(_rows_job, sp, chunksize=1):
            for T, R in res.items():
                for c, v in R.items():
                    arr[f"{arm}|{sym}|{T}|{c}"] = v
            print(now(), f"  {arm} {sym} {sec:.0f}s", flush=True)
    np.savez_compressed(os.path.join(a.out, "rows-r22.npz"), **arr)
    json.dump({"code": git_sha(), "finished_utc": now()}, open(os.path.join(a.out, "rows-r22-meta.json"), "w"), indent=1)


def load_rows(out):
    Z = np.load(os.path.join(out, "rows-r22.npz"))
    R = {}
    for k in Z.files:
        arm, sym, T, c = k.split("|")
        R.setdefault((arm, sym, int(T)), {})[c] = Z[k]
    return R


def cmd_check(a):
    R = load_rows(a.out)
    Z = np.load(os.path.join(a.datasets, R195_ROWS))
    res = {"code": git_sha(), "cells": {}}
    ok_all = True
    for sym in ("ETHUSDT", "BTCUSDT"):
        for T in TS_B:
            d = R[("B0", sym, T)]
            e = {c: Z[f"I|{sym}|{T}|{c}"] for c in ("ts", "y", "a", "fH")}
            same_ts = len(d["ts"]) == len(e["ts"]) and bool((d["ts"] == e["ts"]).all())
            ent = {"rows": int(len(d["ts"])), "rows_r195": int(len(e["ts"])), "ts_equal": same_ts}
            if same_ts:
                for c in ("y", "a", "fH"):
                    ent[f"max_abs_{c}"] = float(np.max(np.abs(d[c].astype(np.float64) - e[c].astype(np.float64))))
                ok = all(ent[f"max_abs_{c}"] == 0 for c in ("y", "a", "fH"))
            else:
                ok = False
            ent["pass"] = ok
            ok_all &= ok
            # L vs B0 on common origins: labels must be equal (same Binance lows) where the window is after the splice
            L = R[("L", sym, T)]
            com, ib, il = np.intersect1d(d["ts"], L["ts"], return_indices=True)
            ent["L_common"] = int(len(com))
            ent["L_missing_B0"] = int(len(d["ts"]) - len(com))
            ent["L_label_mismatch"] = int((d["y"][ib] != L["y"][il]).any(axis=1).sum())
            ent["L_vs_B0_mean_abs_dfH"] = [float(np.mean(np.abs(L["fH"][il, j] - d["fH"][ib, j]))) for j in JL]
            res["cells"][f"{sym}|{TL[T]}"] = ent
            print(sym, TL[T], json.dumps(ent), flush=True)
    res["pass"] = bool(ok_all)
    json.dump(res, open(os.path.join(a.out, "check-r22.json"), "w"), indent=1)
    print("PASS" if ok_all else "FAIL")


# =====================================================================================================================
# score
# =====================================================================================================================
def panel(R, arm, T):
    """-> dict ts, y, a, p (n, 8), sid, crossing count. arm in B0, L1, L2."""
    parts, dropped = [], 0
    for si, sym in enumerate(("ETHUSDT", "BTCUSDT")):
        if arm == "B0":
            d = R[("B0", sym, T)]
            m = np.ones(len(d["ts"]), bool)
        else:
            d = R[("L", sym, T)]
            # crossing: t < splice <= t + T  (the window holds hours opening at t .. t + T - 1 h)
            cross = (d["ts"] < SPLICE) & (d["ts"] + T * STEP > SPLICE)
            dropped += int(cross.sum())
            m = ~cross
            if arm == "L2":
                m &= np.isin(d["ts"], R[("B0", sym, T)]["ts"])
        fin = np.isfinite(d["fH"]).all(axis=1) & (d["y"] >= 0).all(axis=1)
        m &= fin
        parts.append({"ts": d["ts"][m], "y": d["y"][m], "a": d["a"][m].astype(np.float64),
                      "p": d["fH"][m].astype(np.float64), "sid": np.full(int(m.sum()), si)})
    out = {k: np.concatenate([q[k] for q in parts]) for k in parts[0]}
    out["dropped_cross"] = dropped
    return out


def grade(P, T, j, jj, seed, time_only=True, pe=None, mask=None):
    import r193_regrade as G
    m = np.ones(len(P["ts"]), bool) if mask is None else mask
    ts, sid = P["ts"][m], P["sid"][m]
    yy = P["y"][m, j].astype(np.float64)
    if pe is None:
        pe = G.asof_rate(P["ts"], T, P["y"][:, j].astype(np.float64))
    pe = pe[m]
    blk = G.block_of(ts, T)
    st = G.cell_stats(np.clip(P["p"][m, j], 0, 1), P["a"][m, j], yy, sid, blk, time_only=time_only, B=B_BOOT, seed=seed,
                      pe=pe)
    st["class"] = G.classify(st)
    st["mean_p"] = float(np.mean(P["p"][m, j])) if m.any() else None
    st["sum_p"] = float(np.sum(P["p"][m, j]))
    return st


def pooled_R(P, T, mask, seed):
    """horizon-pooled over the four levels: R = sum p / sum y, ln R bootstrap variance and 95% interval (28-day blocks)."""
    import r193_regrade as G
    ts = P["ts"][mask]
    p = P["p"][mask][:, JL].sum(1)
    y = P["y"][mask][:, JL].sum(1).astype(np.float64)
    if y.sum() < 2:
        return {"R": None, "pos": int(y.sum())}
    blk = G.block_of(ts, T)
    pi, Pn, W = G.boot_weights(P["sid"][mask], blk, True, B_BOOT, seed)
    sp, sy = np.bincount(pi, p, Pn), np.bincount(pi, y, Pn)
    with np.errstate(divide="ignore", invalid="ignore"):
        lr = np.log((W @ sp) / (W @ sy))
    lr = lr[np.isfinite(lr)]
    return {"R": float(p.sum() / y.sum()), "R_lo": float(math.exp(np.quantile(lr, 0.025))),
            "R_hi": float(math.exp(np.quantile(lr, 0.975))), "var_lnR": float(np.var(lr, ddof=1)), "pos": int(y.sum()),
            "rows": int(mask.sum())}


def pooled_slope(P, T, mask, seed):
    """calibration slope on the rows x four levels stacked (r193 cell_stats on the stacked set, 28-day blocks)."""
    import r193_regrade as G
    ts = np.repeat(P["ts"][mask], len(JL))
    sid = np.repeat(P["sid"][mask], len(JL))
    p = P["p"][mask][:, JL].reshape(-1)
    y = P["y"][mask][:, JL].reshape(-1).astype(np.float64)
    a_ = P["a"][mask][:, JL].reshape(-1)
    if y.sum() < 2:
        return None
    st = G.cell_stats(np.clip(p, 0, 1), a_, y, sid, G.block_of(ts, T), time_only=True, B=B_BOOT, seed=seed)
    return {"slope": st.get("slope"), "R": st.get("R"), "auc": st.get("auc"), "pos": st["pos"]}


def fmt3(v, nd=2):
    if v is None or not isinstance(v, list):
        return "—"
    return f"{v[0]:.{nd}f} ({v[1]:.{nd}f}–{v[2]:.{nd}f})"


MAP_CLASS = {  # current UI-map Binance-definition classes (knowledge/q26-ui-confidence-map.md, 2026-10-24/25)
    (6, -10): "CALIBRATED-WARN", (6, -15): "HISTORY COUNT", (6, -20): "HISTORY COUNT", (6, -30): "HISTORY COUNT",
    (12, -10): "RECALIBRATE", (12, -15): "HISTORY COUNT", (12, -20): "HISTORY COUNT", (12, -30): "HISTORY COUNT",
    (24, -10): "CALIBRATED-WARN", (24, -15): "CALIBRATED-WARN", (24, -20): "HISTORY COUNT", (24, -30): "HISTORY COUNT",
    (72, -10): "CALIBRATED-WARN", (72, -15): "RECALIBRATE", (72, -20): "CALIBRATED (labelled context)",
    (72, -30): "HISTORY COUNT",
    (168, -10): "CALIBRATED-WARN", (168, -15): "CALIBRATED-WARN", (168, -20): "CALIBRATED (labelled context)",
    (168, -30): "DO NOT SHOW"}


def cmd_score(a):
    import r193_regrade as G
    R = load_rows(a.out)
    res = {"code": git_sha(), "started_utc": now(), "cells": {}, "seeds": {}, "twoway": {}, "e_long": {}, "era": {},
           "counts": {}, "ethbtc_split": {}}
    for T in TS_B:
        Pn = {arm: panel(R, arm, T) for arm in ("B0", "L1", "L2")}
        res["counts"][TL[T]] = {arm: {"rows": int(len(P["ts"])), "first": iso(P["ts"].min()), "last": iso(P["ts"].max()),
                                      "dropped_cross": P["dropped_cross"]} for arm, P in Pn.items()}
        # L2 vs B0 row identity (registered: same ts set per series)
        b, l2 = Pn["B0"], Pn["L2"]
        res["counts"][TL[T]]["L2_equals_B0_rows"] = bool(len(b["ts"]) == len(l2["ts"])
                                                         and (np.sort(b["ts"] * 2 + b["sid"]) == np.sort(l2["ts"] * 2 + l2["sid"])).all())
        L1 = Pn["L1"]
        for jj, (j, k) in enumerate(zip(JL, LV)):
            kk = int(round(k * 100))
            base_seed = 1000 * T + 10 * jj
            for arm, P in Pn.items():
                st = grade(P, T, j, jj, base_seed + ARM_OFF[arm])
                res["cells"][f"{arm}|{TL[T]}|{kk}"] = st
                # seed spread
                cl = [st["class"]]
                for s in range(1, a.seeds):
                    cl.append(grade(P, T, j, jj, base_seed + ARM_OFF[arm] + SEED_STEP * s)["class"])
                res["seeds"][f"{arm}|{TL[T]}|{kk}"] = cl
                # two-way sensitivity
                tw = grade(P, T, j, jj, base_seed + ARM_OFF[arm] + 50000, time_only=False)
                res["twoway"][f"{arm}|{TL[T]}|{kk}"] = {"class": tw["class"], "R": tw.get("R"), "slope": tw.get("slope"),
                                                       "bss_a": tw.get("bss_a"), "bss_e_asof": tw.get("bss_e_asof")}
                # per-asset R (report)
                for si, nm in ((0, "ETH"), (1, "BTC")):
                    msk = P["sid"] == si
                    yv = P["y"][msk, j]
                    res["ethbtc_split"][f"{arm}|{TL[T]}|{kk}|{nm}"] = {
                        "pos": int(yv.sum()), "R": float(P["p"][msk, j].sum() / yv.sum()) if yv.sum() else None}
            # L2 secondary (e): as-of over L1 rows (includes resolved pre-B0 labels), evaluated at the L2 rows
            pe_long = G.asof_rate(L1["ts"], T, L1["y"][:, j].astype(np.float64))
            o = np.argsort(L1["ts"] + T * STEP, kind="mergesort")
            rt = (L1["ts"] + T * STEP)[o]
            cy = np.r_[0.0, np.cumsum(L1["y"][o, j].astype(float))]
            kq = np.searchsorted(rt, l2["ts"], side="right")
            pe2 = (cy[kq] + 0.5) / (kq + 1.0)
            del pe_long
            st2 = grade(l2, T, j, jj, base_seed + ARM_OFF["L2"], pe=pe2)
            res["e_long"][f"L2|{TL[T]}|{kk}"] = {"class": st2["class"], "bss_e_asof": st2.get("bss_e_asof")}
            # era tables per cell on L1 (asof (e) from the full L1 panel)
            pe_full = G.asof_rate(L1["ts"], T, L1["y"][:, j].astype(np.float64))
            for era, msk in era_masks(L1).items():
                if msk.sum() == 0 or L1["y"][msk, j].sum() < 2:
                    res["era"][f"cell|{TL[T]}|{kk}|{era}"] = {"rows": int(msk.sum()), "pos": int(L1["y"][msk, j].sum())}
                    continue
                st = grade(L1, T, j, jj, base_seed + 300000 + hash_era(era), pe=pe_full, mask=msk)
                res["era"][f"cell|{TL[T]}|{kk}|{era}"] = {k_: st.get(k_) for k_ in
                                                          ("rows", "pos", "R", "slope", "bss_a", "bss_e_asof", "auc", "class")}
            print(now(), TL[T], kk, " ".join(f"{arm}:{res['cells'][f'{arm}|{TL[T]}|{kk}']['class']}" for arm in Pn), flush=True)
        # horizon-pooled era tests on L1
        for era, msk in era_masks(L1).items():
            res["era"][f"pool|{TL[T]}|{era}"] = {"R": pooled_R(L1, T, msk, 7 * T + hash_era(era)),
                                                 "slope": pooled_slope(L1, T, msk, 7 * T + 13 + hash_era(era))}
        for x, ys in (("E1", ("E2", "E3")), ("venue", ("binance",))):
            rx = res["era"][f"pool|{TL[T]}|{x}"]["R"]
            if x == "E1":
                mrest = era_masks(L1)["E2"] | era_masks(L1)["E3"]
                rr = pooled_R(L1, T, mrest, 7 * T + 99)
                nm = f"pool|{TL[T]}|E1_vs_E2E3"
            else:
                rr = res["era"][f"pool|{TL[T]}|binance"]["R"]
                nm = f"pool|{TL[T]}|venue_vs_binance"
            if rx.get("R") and rr.get("R"):
                z = (math.log(rx["R"]) - math.log(rr["R"])) / math.sqrt(rx["var_lnR"] + rr["var_lnR"])
            else:
                z = None
            res["era"][nm] = {"z_lnR": z, "R_x": rx.get("R"), "R_rest": rr.get("R")}
    res["finished_utc"] = now()
    json.dump(res, open(os.path.join(a.out, "score-r22.json"), "w"))
    report(res, a.out)


def hash_era(e):
    return {"E1": 1, "E2": 2, "E3": 3, "venue": 4, "binance": 5}[e]


def era_masks(P):
    ts = P["ts"]
    return {"E1": ts < E1_END, "E2": (ts >= E1_END) & (ts < E2_END), "E3": ts >= E2_END,
            "venue": ts < SPLICE, "binance": ts >= SPLICE}


def order(c):
    return {"HISTORY COUNT": 0, "DO NOT SHOW": 1, "CALIBRATED (labelled context)": 1.5, "RECALIBRATE": 2,
            "CALIBRATED-WARN": 3}.get(c, -1)


def report(res, out):
    C = res["cells"]
    L = ["# Q26 R22 — ETH/BTC deep cells on spliced pre-2017 + Binance history (DEVELOPMENT ONLY, seen and spent data)", "",
         f"code {res['code']}; registration membrane-board 7a91774. Intervals 95%, 28-day time blocks (R19.3c ETH/BTC "
         "convention), B = 1,000. (e) = as-of group base rate (D-R19.3c).", ""]
    L.append("## Rows")
    L.append("| T | B0 rows (first) | L1 rows (first) | L1 splice-crossing dropped | L2 = B0 rows |")
    L.append("|---|---|---|---|---|")
    for T in TS_B:
        c = res["counts"][TL[T]]
        L.append(f"| {TL[T]} | {c['B0']['rows']} ({c['B0']['first'][:10]}) | {c['L1']['rows']} ({c['L1']['first'][:10]}) | "
                 f"{c['L1']['dropped_cross']} | {c['L2_equals_B0_rows']} |")
    for arm in ("B0", "L2", "L1"):
        L += ["", f"## Arm {arm}", "",
              "| Cell | pos (blocks) | R | slope | BSS vs (a) | BSS vs as-of (e) | AUC | class | seeds | two-way class | map class |",
              "|---|---|---|---|---|---|---|---|---|---|---|"]
        for T in TS_B:
            for k in LV:
                kk = int(round(k * 100))
                s = C[f"{arm}|{TL[T]}|{kk}"]
                sd = res["seeds"][f"{arm}|{TL[T]}|{kk}"]
                frag = "stable" if len(set(sd)) == 1 else "FRAGILE " + "/".join(sorted(set(sd)))
                L.append(f"| {TL[T]} {kk}% | {s['pos']} ({s.get('pos_blocks', '—')}) | {fmt3(s.get('R'))} | {fmt3(s.get('slope'))} | "
                         f"{fmt3(s.get('bss_a'), 3)} | {fmt3(s.get('bss_e_asof'), 3)} | {fmt3(s.get('auc'))} | **{s['class']}** | "
                         f"{frag} | {res['twoway'][f'{arm}|{TL[T]}|{kk}']['class']} | {MAP_CLASS[(T, kk)]} |")
    L += ["", "## Class changes", "", "| Cell | map | B0 | L2 | L1 | L2 with long (e) | fitting effect (L2 vs B0) | scoring effect (L1 vs L2) |",
          "|---|---|---|---|---|---|---|---|"]
    for T in TS_B:
        for k in LV:
            kk = int(round(k * 100))
            b, l2, l1 = (C[f"{x}|{TL[T]}|{kk}"]["class"] for x in ("B0", "L2", "L1"))
            L.append(f"| {TL[T]} {kk}% | {MAP_CLASS[(T, kk)]} | {b} | {l2} | {l1} | {res['e_long'][f'L2|{TL[T]}|{kk}']['class']} | "
                     f"{'—' if b == l2 else b + ' → ' + l2} | {'—' if l1 == l2 else l2 + ' → ' + l1} |")
    L += ["", "## Era check on L1 (horizon pooled over −10…−30%)", "",
          "| T | era | rows | pos | R (95%) | slope (95%) |", "|---|---|---|---|---|---|"]
    for T in TS_B:
        for era in ("E1", "E2", "E3", "venue", "binance"):
            e = res["era"][f"pool|{TL[T]}|{era}"]
            r, s = e["R"], e["slope"]
            rs = f"{r['R']:.2f} ({r['R_lo']:.2f}–{r['R_hi']:.2f})" if r.get("R") else "—"
            L.append(f"| {TL[T]} | {era} | {r.get('rows', '—')} | {r.get('pos')} | {rs} | {fmt3(s['slope']) if s else '—'} |")
        z1, z2 = res["era"][f"pool|{TL[T]}|E1_vs_E2E3"]["z_lnR"], res["era"][f"pool|{TL[T]}|venue_vs_binance"]["z_lnR"]
        L.append(f"| {TL[T]} | z ln R: E1 vs E2∪E3 {z1 if z1 is None else round(z1, 2)}; venue vs Binance "
                 f"{z2 if z2 is None else round(z2, 2)} | | | | |")
    L += ["", "## Era check per cell on L1", "", "| Cell | E1 pos, R, slope | E2 pos, R, slope | E3 pos, R, slope |", "|---|---|---|---|"]
    for T in TS_B:
        for k in LV:
            kk = int(round(k * 100))
            row = []
            for era in ("E1", "E2", "E3"):
                e = res["era"][f"cell|{TL[T]}|{kk}|{era}"]
                row.append(f"{e['pos']}, {fmt3(e.get('R'))}, {fmt3(e.get('slope'))}" if e.get("R") else f"{e['pos']}, —")
            L.append(f"| {TL[T]} {kk}% | " + " | ".join(row) + " |")
    open(os.path.join(out, "summary-r22.md"), "w").write("\n".join(L) + "\n")
    print("\n".join(L))


def cmd_decomp(a):
    """post-hoc, report only (D-R22a): L1 rows split into the segments B0 does not hold, per cell; R per segment."""
    R = load_rows(a.out)
    segs = (("venue 2014-2016", 0, E1_END), ("venue 2017-01..splice", E1_END, SPLICE),
            ("Binance splice..2018-09 (B0 warm-up)", SPLICE, utc("2018-10-01T00:00:00Z")),
            ("Binance 2018-10+ (= L2 rows)", utc("2018-10-01T00:00:00Z"), 1 << 40))
    res = {"code": git_sha(), "cells": {}}
    L = ["# R22 post-hoc decomposition of L1 rows (report only, D-R22a)", "",
         "| Cell | segment | rows | pos (ETH / BTC) | sum p | R |", "|---|---|---|---|---|---|"]
    for T in TS_B:
        P = panel(R, "L1", T)
        for j, k in zip(JL, LV):
            kk = int(round(k * 100))
            for nm, t0, t1 in segs:
                m = (P["ts"] >= t0) & (P["ts"] < t1)
                y = P["y"][m, j]
                pe, pb = int(y[P["sid"][m] == 0].sum()), int(y[P["sid"][m] == 1].sum())
                sp_ = float(P["p"][m, j].sum())
                r = sp_ / y.sum() if y.sum() else None
                res["cells"][f"{TL[T]}|{kk}|{nm}"] = {"rows": int(m.sum()), "pos_eth": pe, "pos_btc": pb, "sum_p": sp_, "R": r}
                L.append(f"| {TL[T]} {kk}% | {nm} | {int(m.sum())} | {pe + pb} ({pe} / {pb}) | {sp_:.1f} | "
                         f"{'—' if r is None else f'{r:.2f}'} |")
    json.dump(res, open(os.path.join(a.out, "decomp-r22.json"), "w"), indent=1)
    open(os.path.join(a.out, "decomp-r22.md"), "w").write("\n".join(L) + "\n")
    print("\n".join(L))


def main():
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest="cmd", required=True)
    for nm in ("grids", "rows", "check", "score", "decomp"):
        p = sp.add_parser(nm)
        p.add_argument("--datasets", default="/home/user/membrane-datasets")
        p.add_argument("--out", required=True)
        p.add_argument("--workers", type=int, default=2)
        p.add_argument("--seeds", type=int, default=5)
    a = ap.parse_args()
    {"grids": cmd_grids, "rows": cmd_rows, "check": cmd_check, "score": cmd_score, "decomp": cmd_decomp}[a.cmd](a)


if __name__ == "__main__":
    main()
