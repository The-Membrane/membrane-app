#!/usr/bin/env python3
"""Build the frozen D13-A1 inputs (membrane-board design/HISTORY_TOUCH_LIVE.md D13-A1). Development only (seen data).

  python3 d13a1_build.py grids    --datasets DS --out OUT        arm C development grids (the dev:ETH / dev:BTC chain series)
  python3 d13a1_build.py rows     --datasets DS --out OUT        arm development rows joined with the D13 target-(b) labels
  python3 d13a1_build.py universe --datasets DS --out OUT        d13a1_golden.json, d13a1_universe.json (next to this file)
  python3 d13a1_build.py oc       --datasets DS --out OUT [--paths 2000]   operating characteristics of each arm's units

Arm C (Chainlink input): the R19.5 input II, i.e. the development series long:ETH / long:BTC (Binance hourly klines
before the splice, the price-history Chainlink oracle columns after it; r12_tail.load_series kind "chain"). Its close,
low and high columns are exported unchanged (float repr) to C-<SYM>-1h.json.gz on the same hour grid as the D12 kline
grid (startTs 2017-08-17T04:00Z). raw (fH) on that grid by q26_live_d12.series_origin equals the R19.5 II rows bit for
bit (checked here at every golden origin and on the runner).
Arm V (Uniswap V3 pool TWAP input): the R19.5 input-V grids, used in place (membrane-datasets
history-forecasts/r19/r195-inputs-f4056460/grids/V-<SYM>-1h.json.gz, sha256 in that grids-manifest.json).
Rows: the R19.5 rows of II and V (rows-r195.npz: daily 00:00Z origins, raw (fH) and (a); arm V only from its pool
splice, 2021-08-11) joined on the origin with the D13 target-(b) labels of the same series (rows-d13.npz yb, strict null rule). Monitor units: the 35 ETHBTC D13 cells
and the 5 ETHBTC pooled -2..-10% units, per arm; v0 and the climatology (e) come from that arm's rows.
"""
from __future__ import annotations

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import gzip  # noqa: E402
import json  # noqa: E402
import subprocess  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402

import numpy as np  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))
import q26_live_common as C  # noqa: E402

STEP, DAY = 3600, 86400
R195_DIR = "history-forecasts/r19/r195-inputs-f4056460"
D13_DIR = "history-forecasts/r19/d13-inputs-93d337c9"
SYMS = {"ETHUSDT": "ETH", "BTCUSDT": "BTC"}
ARMS = ("C", "V")
R195_INP = {"C": "II", "V": "V"}
RHOS = (1.0, 1.25, 0.8, 1.4, 0.7, 2.0, 0.5)
YEARS = (1, 2, 3, 5)


def git_short():
    try:
        return subprocess.check_output(["git", "-C", HERE, "rev-parse", "--short=8", "HEAD"], text=True).strip()
    except Exception:  # noqa: BLE001
        return "?"


def cmd_grids(a):
    import r12_tail as R12
    import r16_dev as RD
    RD.init_btc(a.datasets)
    os.makedirs(a.out, exist_ok=True)
    man = {"code": git_short(), "built": C.iso(int(time.time())), "grids": {}}
    for sym, asset in SYMS.items():
        ser, _, _ = R12.load_series({"key": f"dev:{asset}", "kind": "chain", "asset": asset, "datasets": a.datasets})
        st = int(ser.ts(0))
        cols = {"close": np.asarray(ser.close, float), "low": np.asarray(ser.low, float),
                "high": np.asarray(ser.high, float)}
        n = len(cols["close"])

        def col(x):
            return [None if not np.isfinite(v) else float(v) for v in x]
        doc = {"startTs": st, "stepSeconds": STEP, "count": n,
               "meta": {"input": "C (R19.5 input II)", "what": "development series long:" + asset + " (Binance hourly "
                        "klines before the splice, price-history Chainlink oracle columns after it), exported unchanged",
                        "lastFiniteOpen": int(st + STEP * int(np.flatnonzero(np.isfinite(cols["close"]))[-1]))},
               "columns": {c: col(cols[c]) for c in ("close", "low", "high")}}
        p = os.path.join(a.out, f"C-{sym}-1h.json.gz")
        with open(p, "wb") as f:
            f.write(gzip.compress(json.dumps(doc, separators=(",", ":")).encode(), mtime=0))
        import q26_live_d12 as L12
        st2, back = L12.read_dev_grid(p)
        for c in cols:
            same = np.array_equal(np.isfinite(back[c]), np.isfinite(cols[c])) and np.array_equal(
                back[c][np.isfinite(back[c])], cols[c][np.isfinite(cols[c])])
            if st2 != st or not same:
                raise SystemExit(f"STOP: exported C grid {sym} {c} does not read back equal")
        man["grids"][sym] = {"path": os.path.basename(p), "sha256": C.sha256_file(p), "startTs": st, "count": n,
                             "lastFiniteOpen": doc["meta"]["lastFiniteOpen"]}
        print(sym, man["grids"][sym], flush=True)
    with open(os.path.join(a.out, "grids-manifest.json"), "w") as f:
        json.dump(man, f, indent=1)
        f.write("\n")


def cmd_rows(a):
    Z5 = np.load(os.path.join(a.datasets, R195_DIR, "rows-r195.npz"))
    Z13 = np.load(os.path.join(a.datasets, D13_DIR, "rows-d13.npz"))
    vman = json.load(open(os.path.join(a.datasets, R195_DIR, "grids", "grids-manifest.json")))
    arr, stats = {}, {}
    for arm in ARMS:
        inp = R195_INP[arm]
        for sym in SYMS:
            for T in (6, 12, 24, 72, 168):
                k = f"{inp}|{sym}|{T}|"
                ts5, fH, aa = Z5[k + "ts"], Z5[k + "fH"], Z5[k + "a"]
                ts13, yb = Z13[f"III|{sym}|{T}|ts"], Z13[f"III|{sym}|{T}|yb"]
                pos = {int(t): j for j, t in enumerate(ts13)}
                keep, ys = [], []
                tmin = int(vman["grids"]["V:" + sym]["splice_open_ts"]) if arm == "V" else 0
                for j, t in enumerate(ts5):
                    if int(t) < tmin:                 # arm V: only origins on the pool data (III before the splice)
                        continue
                    jj = pos.get(int(t))
                    if jj is None or yb[jj][0] < 0:
                        continue
                    keep.append(j)
                    ys.append(yb[jj])
                keep = np.array(keep, np.int64)
                o = f"{arm}|{sym}|{T}|"
                arr[o + "ts"] = ts5[keep]
                arr[o + "fH"] = fH[keep]
                arr[o + "a"] = aa[keep]
                arr[o + "yb"] = np.array(ys, np.int8).reshape(-1, fH.shape[1])
                stats[o[:-1]] = {"r195Rows": int(len(ts5)), "joinedLabelled": int(len(keep)),
                                 "first": C.iso(int(ts5[keep][0])) if len(keep) else None}
    np.savez_compressed(os.path.join(a.out, "rows-d13a1.npz"), **arr)
    meta = {"code": git_short(), "finished": C.iso(int(time.time())), "stats": stats}
    with open(os.path.join(a.out, "rows-d13a1-meta.json"), "w") as f:
        json.dump(meta, f, indent=1)
        f.write("\n")
    print(json.dumps(stats), flush=True)


def load_rows(out):
    Z = np.load(os.path.join(out, "rows-d13a1.npz"))
    R = {}
    for k in Z.files:
        arm, sym, T, c = k.split("|")
        R.setdefault((arm, sym, int(T)), {})[c] = Z[k]
    return R


def arm_units():
    import q26_live_d13 as L
    return [u for u in L.monitor_units() if u[3] == "ETHBTC"]


def unit_rows(R, arm, T, js):
    ts, p, y = [], [], []
    for sym in SYMS:
        D = R.get((arm, sym, T))
        if D is None or len(D["ts"]) == 0:
            continue
        ts.append(D["ts"])
        p.append(D["fH"][:, js].astype(float))
        y.append(D["yb"][:, js].astype(float))
    return np.concatenate(ts), np.concatenate(p), np.concatenate(y)


def cmd_universe(a):
    import q26_live_d13 as L
    R = load_rows(a.out)
    Z5 = np.load(os.path.join(a.datasets, R195_DIR, "rows-r195.npz"))
    cman = json.load(open(os.path.join(a.out, "grids-manifest.json")))
    vman = json.load(open(os.path.join(a.datasets, R195_DIR, "grids", "grids-manifest.json")))
    golden = {"schema": "q26-touch-live/d13a1-golden/1", "code": git_short(),
              "what": "R19.5 rows of inputs II (arm C) and V (arm V) at the D12 replay origins: raw (fH) and (a) by "
                      "r192_borrower.task (rows-r195.npz)", "rows": {}}
    for arm in ARMS:
        golden["rows"][arm] = {}
        for oi in L.REPLAY_ORIGINS:
            t = C.A.utc(oi)
            golden["rows"][arm][oi] = {}
            for sym in SYMS:
                d = {}
                for T in L.TS:
                    k = f"{R195_INP[arm]}|{sym}|{T}|"
                    j = np.flatnonzero(Z5[k + "ts"] == t)
                    if len(j) != 1:
                        continue
                    d[L.TL[T]] = {nm: [float(v) for v in Z5[k + nm][int(j[0])]] for nm in ("fH", "a")}
                golden["rows"][arm][oi][sym] = d
    gp = os.path.join(HERE, "d13a1_golden.json")
    with open(gp, "w") as f:
        json.dump(golden, f, indent=0, sort_keys=True)
        f.write("\n")
    arms = {}
    for arm in ARMS:
        clim, v0, table = {}, {}, {}
        for key, T, js, g in arm_units():
            ts, p, y = unit_rows(R, arm, T, js)
            Rd = float(p.sum() / y.sum()) if y.sum() > 0 else 1.0
            days, inv = np.unique(ts, return_inverse=True)
            Pd, Yd = np.bincount(inv, (p / Rd).sum(1)), np.bincount(inv, y.sum(1))
            v0[key] = {"A": float(np.mean((Pd / L.R_BAND[1] - Yd) ** 2)),
                       "B": float(np.mean((Yd - Pd / L.R_BAND[0]) ** 2))}
            table[key] = {"rows": int(len(ts)), "days": int(len(days)), "positives": int(y.sum()), "R": Rd,
                          "first": C.iso(int(ts.min()))}
            if len(js) == 1:
                clim[key] = float(y.mean())
                table[key]["BSS_vs_e"] = (float(1 - np.sum((p[:, 0] - y[:, 0]) ** 2)
                                                / np.sum((y[:, 0] - y[:, 0].mean()) ** 2)) if 0 < y.mean() < 1 else None)
            print(arm, key, json.dumps(table[key]), flush=True)
        if arm == "C":
            series = [{"symbol": s, "key": f"C:{s}", "gridPath": f"{a.dirrel}/{cman['grids'][s]['path']}",
                       "gridSha256": cman["grids"][s]["sha256"], "startTs": cman["grids"][s]["startTs"],
                       "feed": SYMS[s]} for s in SYMS]
        else:
            series = [{"symbol": s, "key": f"V:{s}", "gridPath": f"{R195_DIR}/grids/{vman['grids']['V:' + s]['path']}",
                       "gridSha256": vman["grids"]["V:" + s]["sha256"],
                       "spliceOpenTs": vman["grids"]["V:" + s]["splice_open_ts"]} for s in SYMS]
        arms[arm] = {"series": series, "climatology": clim, "v0": v0, "devTable": table}
    U = {"schema": "q26-touch-live/d13a1-universe/1",
         "what": "D13-A1 input arms (ETH/BTC, target (b), report only). gridPath/gridSha256 = the frozen development "
                 "grid of the arm input. climatology = development frequency of target (b) per cell unit on the arm's "
                 "rows. v0 = plug-in prior variance per unit and side (development days, p rescaled to pooled R = 1).",
         "arms": arms, "goldenSha256": C.sha256_file(gp), "inputsDir": a.dirrel, "code": git_short()}
    with open(os.path.join(HERE, "d13a1_universe.json"), "w") as f:
        json.dump(U, f, indent=1)
        f.write("\n")
    print("golden rows:", sum(len(v) for arm in golden["rows"].values() for o in arm.values() for v in o.values()))


def cmd_oc(a):
    import d12_oc as O12
    import q26_live_d13 as L
    U = json.load(open(os.path.join(HERE, "d13a1_universe.json")))
    R = load_rows(a.out)
    units = arm_units()
    res = {"schema": "q26-touch-live/d13a1-oc/1", "code": git_short(), "paths": a.paths, "days": a.days,
           "block": O12.BLOCK, "seed": O12.SEED, "arms": {}}
    for arm in ARMS:
        sums, first = {}, None
        for gk, T, js, g in units:
            ts, p, y = unit_rows(R, arm, T, js)
            m = ts < O12.D1
            sums[gk] = (np.repeat(ts[m], len(js)), p[m].ravel(), y[m].ravel())
            first = int(ts[m].min()) if first is None else min(first, int(ts[m].min()))
        d0 = first - first % DAY
        days = np.arange(d0, O12.D1, DAY)
        nd = len(days)
        rng = np.random.default_rng(O12.SEED)
        idx = O12.boot_idx(a.paths, a.days, nd, rng)
        out = {"pool": [C.iso(d0), C.iso(O12.D1 - DAY)], "scenarios": {}}
        for rho in RHOS:
            firsts = {}
            out["scenarios"][str(rho)] = {"units": {}}
            for gk, T, js, g in units:
                ts, p, y = sums[gk]
                Rd = p.sum() / y.sum() if y.sum() > 0 else 1.0
                q = np.clip(p * rho / Rd, 0, 1)
                di = (ts - d0) // DAY
                n_, P_, Y_ = (np.bincount(di, w, nd) for w in (np.ones_like(q), q, y))
                f = O12.run_paths(n_[idx], P_[idx], Y_[idx], L.h_of(T), U["arms"][arm]["v0"][gk]["A"],
                                  U["arms"][arm]["v0"][gk]["B"])
                firsts[gk] = f
                ok = f >= 0
                by = {f"{yy}y": float(np.mean(ok & (f < 365.25 * yy))) for yy in YEARS}
                out["scenarios"][str(rho)]["units"][gk] = {"P_downgrade_by": by, "positives": int(y.sum())}
            F = np.stack([firsts[u[0]] for u in units])

            def fam(Fs):
                return {f"{yy}y": float(np.mean(((Fs >= 0) & (Fs < 365.25 * yy)).any(0))) for yy in YEARS}
            nc = len(L.CELLS)
            mx = {f"{yy}y": max(out["scenarios"][str(rho)]["units"][u[0]]["P_downgrade_by"][f"{yy}y"] for u in units)
                  for yy in YEARS}
            out["scenarios"][str(rho)].update({"family_cells_35": fam(F[:nc]), "family_pooled_5": fam(F[nc:]),
                                               "family_all_40": fam(F), "max_unit": mx})
            print(f"arm {arm} rho {rho} max unit {mx} family 40 {fam(F)}", flush=True)
        res["arms"][arm] = out
    with open(os.path.join(a.out, "oc-d13a1.json"), "w") as f:
        json.dump(res, f, indent=1)
        f.write("\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=("grids", "rows", "universe", "oc"))
    ap.add_argument("--datasets", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--dirrel", default=None, help="the published path of OUT inside membrane-datasets")
    ap.add_argument("--paths", type=int, default=2000)
    ap.add_argument("--days", type=int, default=1826)
    a = ap.parse_args()
    sys.path.insert(0, C.MODEL_DIR)
    {"grids": cmd_grids, "rows": cmd_rows, "universe": cmd_universe, "oc": cmd_oc}[a.cmd](a)


if __name__ == "__main__":
    main()
