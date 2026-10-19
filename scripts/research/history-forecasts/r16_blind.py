"""Q26 R16.2 blind test on B20a: freeze, counts-only check, single run. membrane-board design/Q26_ROUND16_PREREG.md
D-R16.2b (primary cells, power rule, PASS rule) and inventory section 20.

  freeze  fit the learned parts on ALL development rows (seen data) and write a frozen config:
          gb per T (r16_dev.fit_gb on every dev row), and the stack weights st / lp per T fitted on the dev rows with
          CROSS-FITTED gb predictions (as on blind data, where gb is out of sample). Output frozen-r162.pkl +
          frozen-r162.json (code sha, input sha256 values, seed, UTC creation time, pickle sha256).
  counts  counts-only check of B20a (registered fields only: series with rows, rows, positive rows, positive 4-week
          blocks, 4-week blocks with rows, per primary cell). No forecast, no score.
  run     once: r16_dev rows recipe on B20a, frozen gb / st / lp applied, primary cells scored (two-way pigeonhole
          bootstrap B 10,000: centred and percentile one-sided p; CGM two-way cluster z; R; leave-top-k).

  python3 r16_blind.py freeze --dev DEV --out OUT
  python3 r16_blind.py counts --datasets DS --out OUT
  python3 r16_blind.py run    --datasets DS --dev DEV --out OUT
"""
from __future__ import annotations

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import hashlib  # noqa: E402
import json  # noqa: E402
import math  # noqa: E402
import multiprocessing as mp  # noqa: E402
import pickle  # noqa: E402
import sys  # noqa: E402

import numpy as np  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import r12_tail as R12  # noqa: E402
import r16_dev as D  # noqa: E402

DAY = 86400
ACQ_END = 1790812800          # 2026-10-01T00:00:00Z
FROZEN_TS = (1, 3, 12, 6, 24, 72)   # the frozen pickle covers these; the run uses the PRIMARY horizons
# primary cells: filled by D-R16.2b (model, comparator, T, level); edited only before the freeze commit
PRIMARY = [{"model": "lp", "comparator": "fH", "T": 12, "level": -0.02},
           {"model": "st", "comparator": "fH", "T": 12, "level": -0.02},
           {"model": "gH", "comparator": "fH", "T": 24, "level": -0.07},
           {"model": "lp", "comparator": "fH", "T": 6, "level": -0.03}]
# PASS per cell (D-R16.2b): Holm over the 4 cells at alpha 0.05 one-sided on max(centred p, percentile p);
# AND R(model) in 0.8-1.25; AND leave-top-k mean d < 0. CGM two-way z reported beside.


def sha_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def cmd_freeze(a):
    meta = json.load(open(os.path.join(a.dev, "rows-meta.json")))
    keys = meta["series"]
    rng = np.random.default_rng(D.SEED)
    frozen, inputs = {}, {}
    Ts = FROZEN_TS
    for T in Ts:
        fp = os.path.join(a.dev, f"rows-T{T}.npz")
        inputs[fp] = sha_file(fp)
        Z = np.load(fp)
        R = {k: Z[k] for k in Z.files}
        P = {m: R[m].astype(np.float32) for m in D.ALL_ROW_MODELS}
        L = len(D.LV[T])
        lnk = np.log1p(np.array(D.LV[T]))

        def mk_gb(tr, te):
            clf = D.fit_gb(R, tr, lnk, rng)
            idx = np.where(te)[0]
            return np.column_stack([clf.predict_proba(D.gb_design(R, idx, j, lnk))[:, 1] for j in range(L)])
        P["gb"] = np.minimum.accumulate(D.crossfit(R, T, keys, None, mk_gb), axis=1)
        allrows = np.ones(len(R["ts"]), bool)
        gb = D.fit_gb(R, allrows, lnk, rng)
        st = D.fit_stack_llp(R, allrows, P, L, rng)
        lp = D.fit_lp(R, allrows, P, L, rng)
        frozen[T] = {"gb": gb, "st": st, "lp": lp}
        print(f"{R12.now_iso()} frozen T {T}: lp weights {np.round(lp, 3).tolist()} st coef "
              f"{np.round(st.coef_.ravel(), 3).tolist()}", flush=True)
    os.makedirs(a.out, exist_ok=True)
    pk = os.path.join(a.out, "frozen-r162.pkl")
    pickle.dump(frozen, open(pk, "wb"))
    cfg = {"schema": "q26-r16.2-frozen/1", "created_utc": R12.now_iso(), "code": D.git_sha(), "seed": D.SEED,
           "stack": list(D.STACK), "feats": list(D.FEATS), "primary": PRIMARY, "inputs_sha256": inputs,
           "pickle_sha256": sha_file(pk), "sklearn": __import__("sklearn").__version__}
    json.dump(cfg, open(os.path.join(a.out, "frozen-r162.json"), "w"), indent=1)
    print("frozen config sha256", sha_file(os.path.join(a.out, "frozen-r162.json")))


def b20_specs(datasets, part="B20a"):
    d = os.path.join(datasets, "b20-xt-bingx-prices", part)
    man = json.load(open(os.path.join(d, "manifest-acquire.json")))
    sp = []
    for b, v in sorted(man["series"].items()):
        p = os.path.join(d, v["file"])
        if sha_file(p) != v["sha256"]:
            raise SystemExit(f"STOP: sha256 mismatch {p}")
        sp.append({"key": f"{part}:{b}", "asset": b, "kind": "grid", "path": p, "cap_full": ACQ_END,
                   "cap_primary": ACQ_END})
    return sp


def counts_task(spec):
    import a6_touch as A6
    ser, folds, caps = R12.load_series(spec)
    out = {}
    N1 = len(ser.close) + 1
    ts_all = ser.base_ts + 3600 * np.arange(N1)
    fold_q = [f for f in folds if f["qs_i"] < N1]
    for c in PRIMARY:
        T, k = c["T"], c["level"]
        P6 = A6.Prep6(ser, T, with_fbL=False)
        P = P6.P
        st = D.ORIGIN_STEP[T]
        tsl, yl = [], []
        for f in fold_q:
            qs, qe = f["qs_i"], min(f["qe_i"], P6.n)
            te = np.arange(qs, qe)
            te = te[P.lab_ok[te] & (ts_all[te] + T * 3600 <= caps["full"]) & (ts_all[te] % (st * 3600) == 0)]
            te = te[np.isfinite(P.depth[te])]
            ts = ts_all[te]
            m = ~((ts + T * 3600 > R12.Q2_START) & (ts < R12.Q2_END))
            tsl.append(ts[m])
            yl.append(P.depth[te][m] <= math.log1p(k))
        ts = np.concatenate(tsl) if tsl else np.zeros(0, int)
        y = np.concatenate(yl) if yl else np.zeros(0, bool)
        out[f"{D.TL[T]} {k}"] = {"rows": int(len(ts)), "pos": int(y.sum()),
                                 "blocks": sorted(set((ts // (28 * DAY)).tolist())),
                                 "pos_blocks": sorted(set((ts[y] // (28 * DAY)).tolist()))}
    return spec["key"], out


def cmd_counts(a):
    specs = b20_specs(a.datasets)
    acc = {}
    with mp.get_context("fork").Pool(3) as pool:
        for key, o in pool.imap_unordered(counts_task, specs):
            for ck, v in o.items():
                d = acc.setdefault(ck, {"series_with_rows": 0, "rows": 0, "pos": 0, "blocks": set(), "pos_blocks": set()})
                d["series_with_rows"] += int(v["rows"] > 0)
                d["rows"] += v["rows"]
                d["pos"] += v["pos"]
                d["blocks"] |= set(v["blocks"])
                d["pos_blocks"] |= set(v["pos_blocks"])
    out = {"schema": "q26-r16.2-counts/1", "created_utc": R12.now_iso(), "code": D.git_sha(),
           "note": "counts only (registered fields); no forecast, no score", "cells": {}}
    for ck, d in acc.items():
        out["cells"][ck] = {"series_with_rows": d["series_with_rows"], "rows": d["rows"], "pos": d["pos"],
                            "blocks_4w": len(d["blocks"]), "pos_blocks_4w": len(d["pos_blocks"])}
    os.makedirs(a.out, exist_ok=True)
    json.dump(out, open(os.path.join(a.out, "counts-r162-b20a.json"), "w"), indent=1)
    print(json.dumps(out["cells"], indent=1))


def cgm_z(d, sid, blk):
    """Cameron-Gelbach-Miller two-way cluster-robust z of mean d (series, block)."""
    n = len(d)
    e = d - d.mean()

    def v_of(g):
        _, inv = np.unique(g, return_inverse=True)
        s = np.bincount(inv, weights=e)
        return np.sum(s ** 2) / n ** 2
    inter = sid.astype(np.int64) * 100000 + blk
    V = v_of(sid) + v_of(blk) - v_of(inter)
    return float(d.mean() / math.sqrt(V)) if V > 0 else None


def cmd_run(a):
    cfgp = os.path.join(a.out, "frozen-r162.json")
    cfg = json.load(open(cfgp))
    pk = os.path.join(a.out, "frozen-r162.pkl")
    if sha_file(pk) != cfg["pickle_sha256"]:
        raise SystemExit("STOP: frozen pickle sha256 mismatch")
    frozen = pickle.load(open(pk, "rb"))
    D.init_btc(a.datasets)
    specs = b20_specs(a.datasets)
    res_rows = {T: [] for T in frozen}
    keys = []
    with mp.get_context("fork").Pool(3, maxtasksperchild=4) as pool:
        for r in pool.imap_unordered(D.task, specs, chunksize=1):
            sid = len(keys)
            keys.append(r["key"])
            for T, R in r["rows"].items():
                if T in frozen:
                    R["sid"] = np.full(len(R["ts"]), sid, np.int32)
                    res_rows[T].append(R)
    out = {"schema": "q26-r16.2-blind/1", "created_utc": R12.now_iso(), "code": D.git_sha(),
           "frozen_config_sha256": sha_file(cfgp), "series": keys, "cells": {}}
    for c in PRIMARY:
        T, k, m, C = c["T"], c["level"], c["model"], c["comparator"]
        R = {kk: np.concatenate([x[kk] for x in res_rows[T]]) for kk in res_rows[T][0]}
        L = len(D.LV[T])
        lnk = np.log1p(np.array(D.LV[T]))
        P = {mm: R[mm].astype(float) for mm in D.ALL_ROW_MODELS}
        fz = frozen[T]
        idx = np.arange(len(R["ts"]))
        P["gb"] = np.minimum.accumulate(np.column_stack(
            [fz["gb"].predict_proba(D.gb_design(R, idx, j, lnk))[:, 1] for j in range(L)]), axis=1)
        P["st"] = np.minimum.accumulate(np.column_stack(
            [fz["st"].predict_proba(np.column_stack([D.lg(P[s][:, j]) for s in D.STACK]))[:, 1]
             for j in range(L)]), axis=1)
        P["lp"] = np.minimum.accumulate(np.column_stack(
            [np.column_stack([P[s][:, j] for s in D.STACK]) @ fz["lp"] for j in range(L)]), axis=1)
        j = list(D.LV[T]).index(k)
        y = R["y"][:, j].astype(float)
        pm, pc = np.clip(P[m][:, j], 0, 1), np.clip(P[C][:, j], 0, 1)
        d = (pm - y) ** 2 - (pc - y) ** 2
        blk = (R["ts"] // (28 * DAY)).astype(np.int64)
        tw = D.TwoWay(R["sid"], blk, B=10000, seed=D.SEED)
        z = tw.z(d)
        # centred one-sided p (H1: mean d < 0): share of bootstrap means (re-centred) at or below the observed mean
        cell = {"model": m, "comparator": C, "rows": int(len(y)), "pos": int(y.sum()),
                "pos_blocks_4w": int(len(np.unique(blk[y > 0]))), "series": int(len(np.unique(R["sid"]))),
                "bss_vs_C": float(1 - np.mean((pm - y) ** 2) / np.mean((pc - y) ** 2)),
                "R_model": float(pm.sum() / max(y.sum(), 1)), "R_C": float(pc.sum() / max(y.sum(), 1)),
                "two_way": z, "p_centred": float(1 - __import__("scipy.stats", fromlist=["norm"]).norm.cdf(-z["z"]))
                if z["z"] is not None else None, "p_percentile": z["pct_p"], "cgm_z": cgm_z(d, R["sid"], blk),
                "leave_top_k": D.leave_top_k(R["sid"], d)}
        cell["MCB_DSC_model"] = D.corp(pm, y)
        cell["MCB_DSC_C"] = D.corp(pc, y)
        out["cells"][f"{m} vs {C} {D.TL[T]} {k}"] = cell
        print(json.dumps({kk: v for kk, v in cell.items() if kk != "two_way"}, default=float), flush=True)
    out["finished_utc"] = R12.now_iso()
    json.dump(out, open(os.path.join(a.out, "blind-r162-b20a.json"), "w"), indent=1, default=float)


def cmd_config(a):
    """rewrite the frozen config with the registered PRIMARY cells (the pickle is unchanged; its sha256 is checked)."""
    cfgp = os.path.join(a.out, "frozen-r162.json")
    cfg = json.load(open(cfgp))
    pk = os.path.join(a.out, "frozen-r162.pkl")
    if sha_file(pk) != cfg["pickle_sha256"]:
        raise SystemExit("STOP: pickle sha256 mismatch")
    cfg["primary"] = PRIMARY
    cfg["config_code"] = D.git_sha()
    cfg["config_utc"] = R12.now_iso()
    json.dump(cfg, open(cfgp, "w"), indent=1)
    print("frozen config sha256", sha_file(cfgp))


def cmd_powersim(a):
    """power at the B20a counts by resampling development rows into B20a-shaped sets (D-R13.5c rule 1: the
    registered statistic on development). Each replicate: S_b dev series drawn without replacement; for each, a
    contiguous run of rows_b / S_b origins inside 2022-01-01..2026-09-30 (outside 2026Q2); the cell's Brier
    difference d (cross-fitted models, as in the dev score); two-way pigeonhole bootstrap B 2,000; PASS if
    max(centred p, percentile p) <= 0.05 / M (Holm worst case) and mean d < 0. Power = share of passing replicates."""
    from scipy.stats import norm
    import datetime as _dt
    counts = json.load(open(os.path.join(a.out, "counts-r162-b20a.json")))["cells"]
    meta = json.load(open(os.path.join(a.dev, "rows-meta.json")))
    keys = meta["series"]
    rng = np.random.default_rng(D.SEED + 7)
    t_lo = int(_dt.datetime(2022, 1, 1, tzinfo=_dt.timezone.utc).timestamp())
    M = len(PRIMARY)
    out = {"schema": "q26-r16.2-powersim/1", "code": D.git_sha(), "M": M, "reps": a.reps, "cells": {}}
    cache = {}
    for c in PRIMARY:
        T, k, m, C = c["T"], c["level"], c["model"], c["comparator"]
        if T not in cache:
            Z = np.load(os.path.join(a.dev, f"rows-T{T}.npz"))
            R = {kk: Z[kk] for kk in Z.files}
            P = {mm: R[mm].astype(np.float32) for mm in D.ALL_ROW_MODELS}
            L = len(D.LV[T])
            lnk = np.log1p(np.array(D.LV[T]))

            def mk_gb(tr, te):
                clf = D.fit_gb(R, tr, lnk, rng)
                idx = np.where(te)[0]
                return np.column_stack([clf.predict_proba(D.gb_design(R, idx, j, lnk))[:, 1] for j in range(L)])
            P["gb"] = np.minimum.accumulate(D.crossfit(R, T, keys, None, mk_gb), axis=1)

            def mk_st(tr, te):
                clf = D.fit_stack_llp(R, tr, P, L, rng)
                ii = np.where(te)[0]
                return np.column_stack([clf.predict_proba(np.column_stack([D.lg(P[s_][ii, j]) for s_ in D.STACK]))[:, 1]
                                        for j in range(L)])
            P["st"] = np.minimum.accumulate(D.crossfit(R, T, keys, None, mk_st), axis=1)

            def mk_lp(tr, te):
                w = D.fit_lp(R, tr, P, L, rng)
                ii = np.where(te)[0]
                return np.column_stack([np.column_stack([P[s_][ii, j] for s_ in D.STACK]) @ w for j in range(L)])
            P["lp"] = np.minimum.accumulate(D.crossfit(R, T, keys, None, mk_lp), axis=1)
            cache[T] = (R, P)
        R, P = cache[T]
        j = list(D.LV[T]).index(k)
        y = R["y"][:, j].astype(float)
        d_all = (P[m][:, j] - y) ** 2 - (P[C][:, j] - y) ** 2
        ok = (R["ts"] >= t_lo) & ~((R["ts"] + T * 3600 > R12.Q2_START) & (R["ts"] < R12.Q2_END))
        ck = f"{D.TL[T]} {k}"
        Sb = counts[ck]["series_with_rows"]
        per = max(1, counts[ck]["rows"] // Sb)
        by = {}
        for sid in np.unique(R["sid"][ok]):
            idx = np.where(ok & (R["sid"] == sid))[0]
            if len(idx) >= per:
                by[int(sid)] = idx
        elig = np.array(sorted(by))
        passes, zs = 0, []
        for r in range(a.reps):
            ss = rng.choice(elig, Sb, replace=False)
            parts = []
            for s_ in ss:
                idx = by[s_]
                st0 = rng.integers(0, len(idx) - per + 1)
                parts.append(idx[st0:st0 + per])
            ii = np.concatenate(parts)
            tw = D.TwoWay(R["sid"][ii], (R["ts"][ii] // (28 * DAY)).astype(np.int64), B=2000, seed=int(rng.integers(1e9)))
            zz = tw.z(d_all[ii])
            if zz["z"] is None:
                continue
            pc = float(norm.cdf(zz["z"]))
            pp = zz["pct_p"]
            zs.append(zz["z"])
            passes += int(zz["mean"] < 0 and max(pc, pp) <= 0.05 / M)
        out["cells"][f"{m} vs {C} {ck}"] = {"S_b": Sb, "rows_per_series": per, "eligible_dev_series": int(len(elig)),
                                            "power": passes / a.reps, "median_z": float(np.median(zs)),
                                            "z_q10_q90": [float(np.quantile(zs, 0.1)), float(np.quantile(zs, 0.9))]}
        print(json.dumps({f"{m} vs {C} {ck}": out["cells"][f"{m} vs {C} {ck}"]}), flush=True)
    json.dump(out, open(os.path.join(a.out, "powersim-r162-b20a.json"), "w"), indent=1)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("freeze")
    s.add_argument("--dev", required=True)
    s.add_argument("--out", required=True)
    s = sub.add_parser("counts")
    s.add_argument("--datasets", required=True)
    s.add_argument("--out", required=True)
    s = sub.add_parser("run")
    s.add_argument("--datasets", required=True)
    s.add_argument("--dev", required=True)
    s.add_argument("--out", required=True)
    s = sub.add_parser("powersim")
    s.add_argument("--dev", required=True)
    s.add_argument("--out", required=True)
    s.add_argument("--reps", type=int, default=200)
    s = sub.add_parser("config")
    s.add_argument("--out", required=True)
    a = ap.parse_args()
    {"freeze": cmd_freeze, "counts": cmd_counts, "run": cmd_run, "config": cmd_config, "powersim": cmd_powersim}[a.cmd](a)


if __name__ == "__main__":
    main()
