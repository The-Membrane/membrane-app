#!/usr/bin/env python3
"""Build the frozen D13 inputs (membrane-board design/HISTORY_TOUCH_LIVE.md D13). Development only (seen data).

  python3 d13_build.py grids --datasets DS --out OUT [--workers 4]   1 m files -> III grids (d13_twap, fsum windows)
  python3 d13_build.py rows  --datasets DS --out OUT [--workers 4]   r192_borrower.task on III and on the kline grids
  python3 d13_build.py universe --datasets DS --out OUT              d13_golden.json, d13_universe.json (next to this)

grids: Binance spot 1 m klines from data.binance.vision (monthly files to 2026-09, daily files 2026-10-01 .. 2026-10-23;
keyless). Every 1 m close is parsed with float(); G and the hour bars come from live/d13_twap.py, the same function the
live block runs. One grid per series on the hour grid of that series' development kline grid (same startTs, so the
folds are shared), from startTs to GRID_END = 2026-10-24T00:00Z. Values round10. sha256 per grid and per 1 m file.
rows: raw (fH), (f), (a) by the unchanged r192_borrower.task on each III grid (daily 00:00Z origins), and the same on
each kline grid (the D12 grid) for the report-only ratio arm. The target-(b) label of every row is recomputed with the
live label function (q26_live_d13.label_b: any null hour in the window censors it). Anchor flags on (b) crossings.
universe: the golden rows at the D12 replay origins, the climatology (e) and plug-in prior variances v0 per D13 monitor
unit, the development path-unavailable share per cell, the ratio-arm sums, and the development table.
"""
from __future__ import annotations

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import csv  # noqa: E402
import gzip  # noqa: E402
import hashlib  # noqa: E402
import io  # noqa: E402
import json  # noqa: E402
import multiprocessing as mp  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402
import urllib.error  # noqa: E402
import urllib.request  # noqa: E402
import zipfile  # noqa: E402

import numpy as np  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import d13_twap as TW  # noqa: E402
import q26_live_common as C  # noqa: E402

STEP, DAY = 3600, 86400
UA = {"user-agent": "curl/8.5.0"}
MONTHS_TO = (2026, 9)
DAYS_FROM, DAYS_TO = C.A.utc("2026-10-01T00:00:00Z"), C.A.utc("2026-10-24T00:00:00Z")


def get(url, tries=6, timeout=120):
    for t in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code in (400, 404):
                return None
            time.sleep(2 + 4 * t)
        except Exception:  # noqa: BLE001
            time.sleep(2 + 4 * t)
    raise RuntimeError(url)


def parse_zip(raw):
    """-> list of (open ts seconds, close float) from a data.binance.vision 1 m zip (ms or us open times)."""
    z = zipfile.ZipFile(io.BytesIO(raw))
    out = []
    with z.open(z.namelist()[0]) as f:
        for row in csv.reader(io.TextIOWrapper(f, "ascii")):
            if not row or not row[0][:1].isdigit():
                continue
            o = int(row[0])
            o = o // 1000 if o > 10 ** 14 else o            # microseconds from 2025
            out.append((o // 1000, float(row[4])))
    return out


def d12_series():
    return json.load(open(os.path.join(HERE, "d12_universe.json")))["series"]


def build_grid(args):
    import q26_live_d13 as L
    e, datasets, out = args
    sym = e["symbol"]
    st = int(e["startTs"])
    t0 = st - STEP                                           # one hour of look-back before the first grid hour
    nmin = (L.GRID_END - t0) // 60
    closes = [None] * nmin
    shas, nrows, dup, offgrid = {}, 0, 0, 0
    y, m = int(C.iso(st)[:4]), int(C.iso(st)[5:7])
    files = []
    while (y, m) <= MONTHS_TO:
        files.append((f"{y:04d}-{m:02d}", f"https://data.binance.vision/data/spot/monthly/klines/{sym}/1m/"
                                          f"{sym}-1m-{y:04d}-{m:02d}.zip"))
        y, m = (y, m + 1) if m < 12 else (y + 1, 1)
    for d in range(DAYS_FROM, DAYS_TO, DAY):
        dd = C.utc_date(d)
        files.append((dd, f"https://data.binance.vision/data/spot/daily/klines/{sym}/1m/{sym}-1m-{dd}.zip"))
    for name, url in files:
        raw = get(url)
        if raw is None:
            continue
        shas[name] = hashlib.sha256(raw).hexdigest()
        for o, c in parse_zip(raw):
            # Floor to the minute slot, as R19.5 did: 2017-12-04 06:00:20 .. 2017-12-18 the files' open times sit
            # 20 s off the minute grid. A later row in the same slot replaces an earlier one (R19.5: last write wins).
            j = (o - t0) // 60
            if not (0 <= j < nmin) or not (c > 0):
                continue
            if (o - t0) % 60:
                offgrid += 1
            if closes[j] is not None:
                dup += 1
            closes[j] = c
            nrows += 1
    Gm = TW.minute_G(TW.ln_closes(closes))
    lo, hi, cl = TW.hour_bars(Gm, 1, None)                    # hour 0 of the minute slots is the look-back hour
    g10 = np.array([[np.nan if v is None else v for v in r] for r in TW.g10_points(Gm, 1, None)], float)
    os.makedirs(os.path.join(out, "g10"), exist_ok=True)
    np.save(os.path.join(out, "g10", f"g10-{sym}.npy"), g10)   # development only (anchor flag share); not published
    del Gm
    n = (L.GRID_END - st) // STEP
    assert len(cl) == n
    gd = os.path.join(out, "grids")
    os.makedirs(gd, exist_ok=True)
    p = os.path.join(gd, f"III-{sym}-1h.json.gz")
    doc = {"startTs": st, "stepSeconds": STEP, "count": n,
           "meta": {"input": "III", "what": "1 h geometric-mean TWAP path of Binance 1 m closes (d13_twap, fsum "
                                            "windows, round10)", "gridEnd": L.GRID_END},
           "columns": {"close": cl, "low": lo, "high": hi}}
    with open(p, "wb") as f:
        f.write(gzip.compress(json.dumps(doc, separators=(",", ":")).encode(), mtime=0))
    tail0 = (L.TAIL_START - t0) // 60                        # last 26 h of 1 m closes (TWAP replay, splice check)
    tail = closes[tail0:]
    return sym, {"path": os.path.basename(p), "sha256": C.sha256_file(p), "count": n,
                 "finiteClose": sum(v is not None for v in cl), "nullLow": sum(v is None for v in lo),
                 "minuteRows": nrows, "duplicateMinutes": dup, "offGridMinutes": offgrid, "files": shas,
                 "tailFromTs": int(L.TAIL_START), "tailCloses": tail}


def cmd_grids(a):
    S = d12_series()
    with mp.get_context("fork").Pool(a.workers) as pool:
        res = dict(pool.imap_unordered(build_grid, [(e, a.datasets, a.out) for e in S]))
    man = {"code": C_git(), "built": C.iso(int(time.time())), "grids": {e["symbol"]: res[e["symbol"]] for e in S}}
    with open(os.path.join(a.out, "grids", "grids-manifest.json"), "w") as f:
        json.dump(man, f, indent=1)
    for e in S:
        r = res[e["symbol"]]
        print(e["symbol"], r["sha256"][:12], r["count"], r["finiteClose"], r["minuteRows"], len(r["files"]), flush=True)


def C_git():
    import subprocess
    try:
        return subprocess.check_output(["git", "-C", HERE, "rev-parse", "--short=8", "HEAD"], text=True).strip()
    except Exception:  # noqa: BLE001
        return "?"


# =====================================================================================================================
# rows
# =====================================================================================================================
def _task(args):
    import r192_borrower as B
    key, path, sym, inp = args
    r = B.task({"key": key, "kind": "grid", "path": path})
    out = {}
    for T, R in r["rows"].items():
        m = R["ts"] % DAY == 0
        out[T] = {k: np.asarray(R[k])[m] for k in ("ts", "y", "a", "f", "fH")}
    return (inp, sym), out


def cmd_rows(a):
    import q26_live_d13 as L
    import r16_dev as RD
    RD.init_btc(a.datasets)
    S = d12_series()
    jobs = []
    for e in S:
        jobs.append((e["key"], os.path.join(a.out, "grids", f"III-{e['symbol']}-1h.json.gz"), e["symbol"], "III"))
        jobs.append((e["key"], os.path.join(a.datasets, e["path"]), e["symbol"], "I"))
    with mp.get_context("fork").Pool(a.workers, maxtasksperchild=4) as pool:
        res = dict(pool.imap_unordered(_task, jobs, chunksize=1))
    arr = {}
    stats = {"labelEqual": 0, "labelCompared": 0, "censoredStrict": 0}
    for e in S:
        sym = e["symbol"]
        st, g = L.read_grid(os.path.join(a.out, "grids", f"III-{sym}-1h.json.gz"))
        g10 = np.load(os.path.join(a.out, "g10", f"g10-{sym}.npy"))
        for T in L.TS:
            for inp in ("III", "I"):
                R = res[(inp, sym)].get(T)
                if R is None:
                    continue
                yb, fl, flh, S0 = [], [], [], []
                for t in R["ts"]:
                    i = (int(t) - st) // STEP
                    s0 = g["close"][i - 1] if i >= 1 else np.nan
                    lab = L.label_b(g["low"][i:i + T], s0, T) if np.isfinite(s0) else None
                    yb.append([-1] * len(L.L8) if lab is None else lab)
                    fl.append(L.anchor_flags10(g10, g["low"], i, T, s0) if lab is not None else [0] * len(L.L8))
                    flh.append(L.anchor_flags(g["close"], g["low"], i, T, s0) if lab is not None else [0] * len(L.L8))
                    S0.append(s0)
                yb, fl, flh = np.array(yb, np.int8), np.array(fl, np.int8), np.array(flh, np.int8)
                if inp == "III":
                    ok = yb[:, 0] >= 0
                    stats["censoredStrict"] += int((~ok).sum())
                    stats["labelCompared"] += int(ok.sum())
                    stats["labelEqual"] += int(np.all(yb[ok] == R["y"][ok], axis=1).sum())
                for c, v in R.items():
                    arr[f"{inp}|{sym}|{T}|{c}"] = v
                arr[f"{inp}|{sym}|{T}|yb"] = yb
                arr[f"{inp}|{sym}|{T}|flag"] = fl
                arr[f"{inp}|{sym}|{T}|flagH"] = flh
    np.savez_compressed(os.path.join(a.out, "rows-d13.npz"), **arr)
    meta = {"code": C_git(), "finished": C.iso(int(time.time())), **stats}
    json.dump(meta, open(os.path.join(a.out, "rows-d13-meta.json"), "w"), indent=1)
    print(json.dumps(meta), flush=True)


def load_rows(out):
    Z = np.load(os.path.join(out, "rows-d13.npz"))
    R = {}
    for k in Z.files:
        inp, sym, T, c = k.split("|")
        R.setdefault((inp, sym, int(T)), {})[c] = Z[k]
    return R


# =====================================================================================================================
# universe
# =====================================================================================================================
def unit_rows(L, R, S, g, T, js, inp="III"):
    """-> ts, p (n, len(js)), y (n, len(js)) over the group's rows with a defined (b) label."""
    ts, p, y = [], [], []
    for e in S:
        if e["group"] != g or (inp, e["symbol"], T) not in R:
            continue
        D = R[(inp, e["symbol"], T)]
        ok = D["yb"][:, 0] >= 0
        ts.append(D["ts"][ok])
        p.append(D["fH"][ok][:, js].astype(float))
        y.append(D["yb"][ok][:, js].astype(float))
    return np.concatenate(ts), np.concatenate(p), np.concatenate(y)


def cmd_universe(a):
    import q26_live_d13 as L
    S = d12_series()
    R = load_rows(a.out)
    man = json.load(open(os.path.join(a.out, "grids", "grids-manifest.json")))
    golden = {"schema": "q26-touch-live/d13-golden/1", "code": C_git(),
              "what": "r192_borrower.task rows on the D13 III grids at the D12 replay origins, and the target-(b) label",
              "rows": {}}
    for oi in L.REPLAY_ORIGINS:
        ts = C.A.utc(oi)
        golden["rows"][oi] = {}
        for e in S:
            d = {}
            for T in L.TS:
                D = R.get(("III", e["symbol"], T))
                if D is None:
                    continue
                j = np.flatnonzero(D["ts"] == ts)
                if len(j) != 1:
                    continue
                j = int(j[0])
                d[L.TL[T]] = {nm: [float(v) for v in D[nm][j]] for nm in ("fH", "f", "a")}
                d[L.TL[T]]["yb"] = [int(v) for v in D["yb"][j]]
            golden["rows"][oi][e["symbol"]] = d
    gp = os.path.join(HERE, "d13_golden.json")
    with open(gp, "w") as f:
        json.dump(golden, f, indent=0, sort_keys=True)
        f.write("\n")
    clim, v0, table, share, shareH, ratio = {}, {}, {}, {}, {}, {}
    for key, T, js, g in L.monitor_units():
        ts, p, y = unit_rows(L, R, S, g, T, js)
        Rd = float(p.sum() / y.sum()) if y.sum() > 0 else 1.0
        days, inv = np.unique(ts, return_inverse=True)
        Pd, Yd = np.bincount(inv, (p / Rd).sum(1)), np.bincount(inv, y.sum(1))
        v0[key] = {"A": float(np.mean((Pd / L.R_BAND[1] - Yd) ** 2)), "B": float(np.mean((Yd - Pd / L.R_BAND[0]) ** 2))}
        table[key] = {"rows": int(len(ts)), "days": int(len(days)), "positives": int(y.sum()), "R": Rd}
        if len(js) == 1:
            k = L.L8[js[0]]
            clim[key] = float(y.mean())
            # path-unavailable share among (b) crossings (development, report only)
            fl, flh, yy = [], [], []
            for e in S:
                D = R.get(("III", e["symbol"], T))
                if e["group"] != g or D is None:
                    continue
                ok = D["yb"][:, 0] >= 0
                yy.append(D["yb"][ok][:, js[0]])
                fl.append(D["flag"][ok][:, js[0]])
                flh.append(D["flagH"][ok][:, js[0]])
            yy, fl, flh = np.concatenate(yy), np.concatenate(fl), np.concatenate(flh)
            share[key] = {"crossings": int(yy.sum()), "flagged": int(fl.sum()),
                          "share": float(fl.sum() / yy.sum()) if yy.sum() else None}
            shareH[key] = {"crossings": int(yy.sum()), "flagged": int(flh.sum()),
                           "share": float(flh.sum() / yy.sum()) if yy.sum() else None}
            table[key]["pathUnavailableShare"] = share[key]["share"]
            table[key]["pathUnavailableShareHourly"] = shareH[key]["share"]
            # ratio arm (report only): kline (fH) sums on (b) by resolution time
            tsI, pI, yI = unit_rows(L, R, S, g, T, js, inp="I")
            res_t = tsI + T * STEP
            ratio[key] = {"before2026Q4": [float(pI[res_t <= L.Q4_2026].sum()), float(yI[res_t <= L.Q4_2026].sum())],
                          "all": [float(pI.sum()), float(yI.sum())]}
            table[key]["R_klineOnB"] = float(pI.sum() / yI.sum()) if yI.sum() else None
            table[key]["BSS_vs_e"] = float(1 - np.sum((p[:, 0] - y[:, 0]) ** 2) / np.sum((y[:, 0] - y[:, 0].mean()) ** 2)) \
                if 0 < y.mean() < 1 else None
        print(key, json.dumps(table[key]), flush=True)
    gpath = {e["symbol"]: f"{L.GRID_DIR}/{man['grids'][e['symbol']]['path']}" for e in S}
    series = []
    for e in S:
        m = man["grids"][e["symbol"]]
        series.append({**{k: e[k] for k in ("key", "symbol", "group", "path", "sha256", "startTs", "devEndOpen")},
                       "gridPath": gpath[e["symbol"]], "gridSha256": m["sha256"], "gridCount": m["count"],
                       "tailCloses": m["tailCloses"]})
    U = {"schema": "q26-touch-live/d13-universe/1",
         "what": "D13 universe: the 20 D12 series. path/sha256 = the D12 kline grid (ratio arm), gridPath/gridSha256 = "
                 "the D13 III grid (1 h TWAP path of Binance 1 m closes, d13_twap). tailCloses = the 1 m closes from "
                 "STORE_START to GRID_END in the development files (splice check of the live store). climatology = "
                 "development frequency of target (b) per cell unit. v0 = plug-in prior variance per unit and side "
                 "(development days, p rescaled to pooled R = 1). ratioSums = kline (fH) and (b) sums of the ratio arm.",
         "series": series, "climatology": clim, "v0": v0, "devTable": table, "pathUnavailableDev": share, "pathUnavailableDevHourly": shareH,
         "ratioSums": ratio, "goldenSha256": C.sha256_file(gp), "gridsManifestCode": man["code"], "code": C_git()}
    with open(os.path.join(HERE, "d13_universe.json"), "w") as f:
        json.dump(U, f, indent=1)
        f.write("\n")
    print("golden rows:", sum(len(v) for o in golden["rows"].values() for v in o.values()))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=("grids", "rows", "universe"))
    ap.add_argument("--datasets", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--workers", type=int, default=4)
    a = ap.parse_args()
    sys.path.insert(0, C.MODEL_DIR)
    {"grids": cmd_grids, "rows": cmd_rows, "universe": cmd_universe}[a.cmd](a)


if __name__ == "__main__":
    main()
