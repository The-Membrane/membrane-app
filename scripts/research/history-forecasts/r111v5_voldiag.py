"""Q26 R11.1-v5 report-only diagnostic (D-R11.1t): is the near-line under-forecast of raw (fH) on label B a
volatility-state selection effect?

Vol state at an origin = RV24 / sigma_H: RV24 = root mean square of the 24 hourly log returns of the III close
ending at the origin; sigma_H = the (fH) HAR scale at that origin (r192_borrower.task feature lsH). Buckets =
quintiles of the vol state over all daily origins of that series and horizon (in-sample; diagnostic only).

  python3 r111v5_voldiag.py --datasets DS --scr SCR --out OUT

Reports per horizon (6 h, 12 h, 1 d): the near-line (0-10%) label-B paths' vol-state distribution, R per bucket,
and the series-level R at the 0.5-10% ladder levels over all origins per bucket; the all-origins R reweighted to the
near-line vol-state mix ("matched") against the near-line R. No live model is touched.
"""
from __future__ import annotations

import argparse
import json
import multiprocessing as mp
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "live"))
import r111v5_labels as LB  # noqa: E402

HS = (6, 12, 24)
NQ = 5


def _task(args):
    key, path = args
    import r192_borrower as B
    B.L8 = LB.DENSE
    r = B.task({"key": key, "kind": "grid", "path": path})
    out = {}
    for T, R in r["rows"].items():
        m = R["ts"] % LB.DAY == 0
        out[T] = {k: np.asarray(R[k])[m] for k in ("ts", "y", "fH", "lsH")}
    return key, out


def main():
    ap = argparse.ArgumentParser()
    for k in ("datasets", "scr", "out"):
        ap.add_argument(f"--{k}", required=True)
    a = ap.parse_args()
    import r16_dev as RD
    RD.init_btc(a.datasets)
    jobs = [(key, os.path.join(a.datasets, LB.D13_DIR, f"III-{sym}-1h.json.gz")) for key, sym in LB.SERIES.values()]
    with mp.get_context("fork").Pool(2) as pool:
        res = dict(pool.imap_unordered(_task, jobs))
    Z = np.load(os.path.join(a.scr, "rows-labels.npz"))
    series = [str(x) for x in Z["series"]]
    day, hf0, single, kX, yB = Z["day"], Z["hf0"], Z["singleX"], Z["kX"], Z["yB"]
    levels = np.array(LB.DENSE)
    near_lv = np.abs(levels) <= 0.10
    out = {"what": "R11.1-v5 vol-state diagnostic of the near-line (fH) under-forecast on label B (report only)",
           "vol_state": "RV24 / sigma_H, quintiles over all daily origins per series and horizon", "by_H": {}}
    for Hh in HS:
        rows_near = []           # (vol bucket, p, y)
        all_b = np.zeros((NQ, 2))
        for xi, x in enumerate(series):
            key, sym = LB.SERIES[x]
            R = res[key].get(Hh)
            if R is None:
                continue
            st, g = LB.read_iii(a.datasets, sym)
            close = np.asarray(g["close"], float)
            lr = np.diff(np.log(close))                      # lr[j] = log(close[j + 1] / close[j])
            ts = R["ts"]
            b0 = (ts - st) // 3600
            rv = np.full(len(ts), np.nan)
            for i, b in enumerate(b0.tolist()):
                w = lr[b - 25:b - 1] if b - 25 >= 0 else np.array([])
                if len(w) == 24 and np.all(np.isfinite(w)):
                    rv[i] = np.sqrt(np.mean(w ** 2))
            vs = rv / np.exp(R["lsH"].astype(float))
            ok = np.isfinite(vs)
            edges = np.quantile(vs[ok], np.linspace(0, 1, NQ + 1)[1:-1])
            vb = np.where(ok, np.searchsorted(edges, vs), -1)
            for q in range(NQ):
                m = vb == q
                all_b[q, 0] += R["fH"][m][:, near_lv].astype(float).sum()
                all_b[q, 1] += R["y"][m][:, near_lv].astype(float).sum()
            # near-line label-B paths of this series
            sub = np.nonzero((single == xi) & (hf0 >= 1) & (yB[:, LB.HS.index(Hh)] >= 0)
                             & np.isfinite(kX[:, LB.HS.index(Hh)]) & (kX[:, LB.HS.index(Hh)] < 0)
                             & (kX[:, LB.HS.index(Hh)] >= -0.10))[0]
            if len(sub) == 0:
                continue
            kk = kX[sub, LB.HS.index(Hh)]
            dd = np.round(-kk / 0.0025).astype(np.int64)
            keyd = (day[sub] // LB.DAY) * 10**5 + dd
            _, first = np.unique(keyd, return_index=True)
            sub, kk = sub[first], kk[first]
            j = np.searchsorted(ts, day[sub])
            have = (j < len(ts)) & (ts[np.minimum(j, len(ts) - 1)] == day[sub])
            sub, kk, j = sub[have], kk[have], j[have]
            p = LB.interp_logp(kk, levels, R["fH"][j])
            for q, pp, yy in zip(vb[j].tolist(), p.tolist(), yB[sub, LB.HS.index(Hh)].tolist()):
                if q >= 0:
                    rows_near.append((q, pp, yy))
        rn = np.array(rows_near, float) if rows_near else np.zeros((0, 3))
        ent = {"near_paths": int(len(rn)), "near_R_all_buckets": float(rn[:, 1].sum() / rn[:, 2].sum()) if rn[:, 2].sum() else None,
               "buckets": {}}
        w = np.array([(rn[:, 0] == q).mean() if len(rn) else 0 for q in range(NQ)])
        for q in range(NQ):
            m = rn[:, 0] == q
            ent["buckets"][f"q{q + 1}"] = {
                "near_share": float(w[q]), "near_paths": int(m.sum()), "near_pos": int(rn[m, 2].sum()),
                "near_R": float(rn[m, 1].sum() / rn[m, 2].sum()) if rn[m, 2].sum() else None,
                "all_origins_R_at_0p5_10pct_levels": float(all_b[q, 0] / all_b[q, 1]) if all_b[q, 1] else None}
        ent["all_origins_R_unweighted"] = float(all_b[:, 0].sum() / all_b[:, 1].sum())
        # all-origin R reweighted to the near-line vol-state mix (per-bucket sums scaled by near share / all share)
        share_all = np.full(NQ, 1.0 / NQ)
        sw = w / share_all
        ent["all_origins_R_matched_to_near_mix"] = float((sw * all_b[:, 0]).sum() / (sw * all_b[:, 1]).sum())
        out["by_H"][f"{Hh}h"] = ent
        print(Hh, json.dumps(ent), flush=True)
    os.makedirs(a.out, exist_ok=True)
    with open(os.path.join(a.out, "r111v5-voldiag.json"), "w") as f:
        json.dump(out, f, indent=1)


if __name__ == "__main__":
    main()
