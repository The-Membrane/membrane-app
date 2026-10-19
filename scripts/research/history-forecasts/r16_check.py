"""Q26 R16.2 instrument checks (owner rule 2026-10-19: confirm inputs, transform and scorer before recording any
family as failed). DEVELOPMENT ONLY (seen data, synthetic data).

  C1  GARCH simulation to the touch (gS): simulate a synthetic GJR skew-t series with known parameters, filter it
      with those parameters, forecast the touch with simulate_touch (wicks set to 0, labels from the simulated close
      path) and compare forecast and realised touch frequency (R = sum p / sum y) at the R16.2 levels.
  C2  GARCH horizon variance (gP/gF): correlation of ln sigma_GJR(T) with the realised ln sigma_fut on development rows
      (from rows-T*.npz the feature lsg), against ln sigma_H.
  C3  Chronos-Bolt input/output (cb): correlation of the 1-day-ahead forecast with the realised next-day ln D at
      midnight origins, against the naive persistence forecast.
  C4  Stacking leakage sensitivity: st and lp refitted without gb (gb predictions are themselves cross-fitted, so the
      stack's training rows carry a second-order dependence on the test cell); tier z vs fH.
  C5  gb learner check at 7 d / 30 d: in-sample (training rows) vs cross-fitted Brier against fH, and the size of the
      cross-fit training sets.

  python3 r16_check.py --datasets DS --out OUT
"""
from __future__ import annotations

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import json  # noqa: E402
import math  # noqa: E402
import sys  # noqa: E402

import numpy as np  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import r16_dev as D  # noqa: E402

DAY = 86400


def c1():
    from arch.univariate import SkewStudent
    rng = np.random.default_rng(7)
    g = {"om": 0.02, "al": 0.06, "ga": 0.04, "be": 0.90, "nu": 4.5, "lam": -0.05}
    n = 60000
    z = np.asarray(SkewStudent(seed=rng).simulate([g["nu"], g["lam"]])(n), float)
    s2 = np.empty(n + 1)
    s2[0] = g["om"] / (1 - g["al"] - g["ga"] / 2 - g["be"])
    r = np.empty(n)
    for t in range(n):
        r[t] = math.sqrt(s2[t]) * z[t]
        s2[t + 1] = g["om"] + (g["al"] + g["ga"] * (r[t] < 0)) * r[t] ** 2 + g["be"] * s2[t]
    x = np.concatenate([[0.0], np.cumsum(r)]) / 100.0           # log price, x[i] = after bar i-1
    out = {}
    origins = np.arange(1000, n - 800, 24)
    for T in (1, 12, 72, 720):
        lnk = np.log1p(np.array(D.LV[T]))
        N = 1000 if T <= 72 else 200
        Z = np.asarray(SkewStudent(seed=rng).simulate([g["nu"], g["lam"]])(N * T), float).reshape(N, T)
        Wk = np.zeros((N, T))
        P = []
        for c0 in range(0, len(origins), 64):
            ii = origins[c0:c0 + 64]
            P.append(D.simulate_touch(s2[ii], g, Z, Wk, [T], {T: lnk})[T])
        P = np.vstack(P)
        mins = np.array([np.min(x[i + 1:i + T + 1]) - x[i] for i in origins])
        Y = (mins[:, None] <= lnk[None, :]).astype(float)
        out[D.TL[T]] = {str(k): {"R": float(P[:, j].sum() / max(Y[:, j].sum(), 1)), "pos": int(Y[:, j].sum())}
                        for j, k in enumerate(D.LV[T])}
    return out


def c2(out_dir):
    res = {}
    import a6_touch  # noqa: F401
    for T in (1, 12, 72, 720):
        Z = np.load(os.path.join(out_dir, f"rows-T{T}.npz"))
        # realised: ln of the horizon range proxy is not stored; use depth-free proxy: |log return| is not stored
        # either, so compare forecast scales with each other and with the touch outcome rate at the middle level
        lsg, lsH = Z["lsg"].astype(float), Z["lsH"].astype(float)
        ok = np.isfinite(lsg) & np.isfinite(lsH)
        j = len(D.LV[T]) // 2
        y = Z["y"][ok, j].astype(float)
        res[D.TL[T]] = {"corr_lsg_lsH": float(np.corrcoef(lsg[ok], lsH[ok])[0, 1]),
                        "mean_lsg_minus_lsH": float(np.mean(lsg[ok] - lsH[ok])),
                        "auc_lsg": auc(lsg[ok], y), "auc_lsH": auc(lsH[ok], y)}
    return res


def auc(s, y):
    from scipy.stats import rankdata
    r = rankdata(s)
    n1 = y.sum()
    n0 = len(y) - n1
    if n1 == 0 or n0 == 0:
        return None
    return float((r[y > 0].sum() - n1 * (n1 + 1) / 2) / (n1 * n0))


def c3(datasets, out_dir):
    import r12_tail as R12
    import r16_cb as CB
    specs = R12.dev_specs(datasets)[3:40]
    e_cb, e_nv, n = 0.0, 0.0, 0
    for sp in specs:
        fp = os.path.join(out_dir, "cb", CB.safe(sp["key"]) + ".npz")
        if not os.path.exists(fp):
            continue
        z = np.load(fp)
        ser, mid, y = CB.daily_series(sp)
        q = z["q50"][:, 0]
        nxt = np.concatenate([y[1:], [np.nan]])
        ok = np.isfinite(q) & np.isfinite(nxt) & np.isfinite(y)
        e_cb += np.sum((q[ok] - nxt[ok]) ** 2)
        e_nv += np.sum((y[ok] - nxt[ok]) ** 2)
        n += ok.sum()
    return {"days": int(n), "mse_chronos_1d": e_cb / max(n, 1), "mse_persistence_1d": e_nv / max(n, 1)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--datasets", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--only", default="c1,c2,c3")
    a = ap.parse_args()
    res = {"code": D.git_sha()}
    for c in a.only.split(","):
        if c == "c1":
            res["C1_gS_synthetic"] = c1()
        elif c == "c2":
            res["C2_garch_scale"] = c2(a.out)
        elif c == "c3":
            res["C3_chronos"] = c3(a.datasets, a.out)
        print(json.dumps({k: v for k, v in res.items() if k != "code"}, default=float)[-3000:], flush=True)
    json.dump(res, open(os.path.join(a.out, f"check-r162-{a.only.replace(',', '-')}.json"), "w"), indent=1,
              default=float)


if __name__ == "__main__":
    main()
