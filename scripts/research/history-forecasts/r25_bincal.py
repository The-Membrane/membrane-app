"""Q26 R25: binned all-origin ladder calibration of TWAP-(fH) that conditions on crowding. DEVELOPMENT ONLY (seen data).

Design, bins, shrinkage, arms, fitting window, statistics and repair rule: membrane-board
design/q26-r25-binned-calibration-2026-10-25.md (registered before any score of this script).

  python3 r25_bincal.py --datasets DS --scr SCR --out OUT [--nsim N]

SCR holds the R11.1-v5 scratch rows-labels.npz and fh-dense.npz (Aave V3 Polygon, development). OUT receives
address-free aggregates only (r25-bincal.json, r25-frozen-candidates.json). No address, account id, key or secret is
read into the output or written.

Arms (fixed at registration):
  A  multiplier per (vol state u6 x 24 h drop dn x distance band), shrunk toward 1 (raw (fH)).
  B  A x crowding COUNT n10 (positions within 10% of the line, same series, same origin day), each cell shrunk
     toward its A parent.
  C  A x crowding SHARE s10 = n10 / n_act (n_act = active single-collateral HF >= 1 positions of that series-day),
     each cell shrunk toward its A parent.
"""
from __future__ import annotations

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import datetime as dt  # noqa: E402
import hashlib  # noqa: E402
import json  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402

import numpy as np  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "live"))
import r111v5_labels as LB  # noqa: E402
import r23_nearline as N  # noqa: E402
import r24_uplift as U  # noqa: E402  (grid_feats, TwoWay, r_block, bss_block, auc_diff, null_band, dump)

HS = LB.HS                                     # (6, 12, 24, 72, 168)
TL = {6: "6h", 12: "12h", 24: "1d", 72: "3d", 168: "7d"}
DAY = 86400
BKS = ((0.0, 0.02), (0.02, 0.05), (0.05, 0.10), (0.10, 0.20), (0.20, 0.30))
BNAMES = ["0-2%", "2-5%", "5-10%", "10-20%", "20-30%"]
T_LO, T_HI = LB.utc(LB.FIRST_ORIGIN), LB.utc(LB.LAST_ORIGIN)          # label period 2022-03-16 .. 2026-09-23
SCORE_LO = LB.utc(dt.date(2023, 1, 1))                                 # scored origins 2023-01-01 .. 2026-09-23
SEED_BOOT, NB = 20261025, 2000
SEED_NULL, NSIM = 7, 2000

# ---- registered bin grid (edges fixed at registration; informed by seen data, see the design note) ----
U6_EDGES = np.array([-0.36, 0.15, 0.67, 1.14])      # 5 vol-state bins of u6 = clip(ln(RV6/RV720), -2, 2)
DN_EDGES = np.array([1e-12, 1.0, 2.0])               # 4 drop bins: dn = 0, (0, 1], (1, 2], > 2
CNT_EDGES = np.array([0.5, 4.5, 18.5])              # 4 count bins: n10 = 0, 1-4, 5-18, >= 19
SHR_EDGES = np.array([1e-12, 0.0125, 0.05])          # 4 share bins: s10 = 0, (0, 1.25%], (1.25%, 5%], > 5%
CALM_U6 = 0.15                                       # calm state: dn = 0 and u6 <= 0.15 (the u6 bin edge)
KAPPA = 2.0                                          # prior strength, in expected events
BAND_HI = (0.02, 0.05, 0.10)
NPB = 5 * 4                                          # parent bins
NCB = 4                                              # crowding bins
ARMS = ["raw", "A", "B", "C"]
ORDER = ["A", "C", "B"]                              # selection order among passing arms
R_BAND = (0.8, 1.25)
GUARD_TOL = 0.02
BSS_LB = -0.005
AUC_TOL = -0.005


def qidx(ts):
    d = (np.asarray(ts, np.int64) // DAY).astype("datetime64[D]")
    y = d.astype("datetime64[Y]").astype(int) + 1970
    m = d.astype("datetime64[M]").astype(int) % 12
    return (y - 2022) * 4 + m // 3


def qstart(q):
    return LB.utc(dt.date(2022 + q // 4, 3 * (q % 4) + 1, 1))


def parent_bin(u6, dn):
    ok = np.isfinite(u6) & np.isfinite(dn)
    b = np.searchsorted(U6_EDGES, np.where(ok, u6, 0), side="right") * 4 + \
        np.searchsorted(DN_EDGES, np.where(ok, dn, 0), side="right")
    return np.where(ok, b, -1)


def crowd_bin(arm, cnt, shr):
    if arm == "B":
        return np.searchsorted(CNT_EDGES, cnt, side="right")
    return np.searchsorted(SHR_EDGES, shr, side="left")


def band_levels(levels):
    lv = -np.asarray(levels)
    return [np.nonzero(lv <= 0.02 + 1e-12)[0],
            np.nonzero((lv > 0.02 + 1e-12) & (lv <= 0.05 + 1e-12))[0],
            np.nonzero((lv > 0.05 + 1e-12) & (lv <= 0.10 + 1e-12))[0]]


def fit_tables(tab, Hs, q):
    """Multiplier tables from label-period rows resolved before quarter q starts (origin + H <= start).
    -> mA (3, NPB), mB (3, NPB, NCB), mC (3, NPB, NCB), plus fit counts."""
    a = qstart(q)
    PP, YP = np.zeros((3, NPB)), np.zeros((3, NPB))
    PB, YB_, PC, YC = (np.zeros((3, NPB, NCB)) for _ in range(4))
    nrow = 0
    for T in tab:
        m = (T["ts"] + Hs <= a) & (T["pb"] >= 0)
        nrow += int(m.sum())
        pb, cb, cs = T["pb"][m], T["cbB"][m], T["cbC"][m]
        for b in range(3):
            np.add.at(PP[b], pb, T["SP"][m, b])
            np.add.at(YP[b], pb, T["SY"][m, b])
            np.add.at(PB[b], (pb, cb), T["SP"][m, b])
            np.add.at(YB_[b], (pb, cb), T["SY"][m, b])
            np.add.at(PC[b], (pb, cs), T["SP"][m, b])
            np.add.at(YC[b], (pb, cs), T["SY"][m, b])
    mA = (YP + KAPPA) / (PP + KAPPA)
    mB = (YB_ + KAPPA * mA[:, :, None]) / (PB + KAPPA)
    mC = (YC + KAPPA * mA[:, :, None]) / (PC + KAPPA)
    return {"A": mA, "B": mB, "C": mC, "rows": nrow, "PP": PP, "YP": YP, "PB": PB, "YB": YB_, "PC": PC, "YC": YC}


def mult_of(tabs_q, arm, q, band, pb, cbB, cbC):
    """Per-row multiplier for rows with quarter q, band index, parent bin pb, crowding bins. Missing pb -> 1."""
    out = np.ones(len(pb))
    for qq in np.unique(q):
        sel = (q == qq) & (pb >= 0) & (band >= 0) & (band <= 2)
        if not sel.any():
            continue
        M = tabs_q[int(qq)][arm]
        if arm == "A":
            out[sel] = M[band[sel], pb[sel]]
        else:
            cb = cbB if arm == "B" else cbC
            out[sel] = M[band[sel], pb[sel], cb[sel]]
    return out


def main():
    ap = argparse.ArgumentParser()
    for k in ("datasets", "scr", "out"):
        ap.add_argument(f"--{k}", required=True)
    ap.add_argument("--nsim", type=int, default=NSIM)
    a = ap.parse_args()
    t0 = time.time()
    F = np.load(os.path.join(a.scr, "fh-dense.npz"))
    levels = F["levels"]
    bl = band_levels(levels)
    assert [len(x) for x in bl] == [4, 4, 4], [len(x) for x in bl]
    near_lv = np.concatenate(bl)
    far_lv = np.nonzero((-levels > 0.10 + 1e-12) & (-levels <= 0.30 + 1e-12))[0]
    Z = np.load(os.path.join(a.scr, "rows-labels.npz"))
    series = [str(x) for x in Z["series"]]
    day, hf0, single, kX, yB = Z["day"], Z["hf0"], Z["singleX"], Z["kX"], Z["yB"]
    print(f"loaded {len(day):,} rows {time.time() - t0:.0f}s", flush=True)

    # crowding per (series, origin day) from origin positions only (6 h column distance; no label read)
    k6 = kX[:, 0]
    act = ~(hf0 < 1.0) & (single >= 0) & np.isfinite(k6) & (k6 < 0)
    near = act & (k6 > -0.10)
    ka = single[act].astype(np.int64) * 10**7 + day[act] // DAY
    au, ac = np.unique(ka, return_counts=True)
    kn = single[near].astype(np.int64) * 10**7 + day[near] // DAY
    nu, nc = np.unique(kn, return_counts=True)
    del k6, act, near, ka, kn

    def crowd_of(xi, ts):
        q = int(xi) * 10**7 + np.asarray(ts, np.int64) // DAY
        j = np.minimum(np.searchsorted(nu, q), len(nu) - 1)
        cnt = np.where(nu[j] == q, nc[j], 0).astype(float)
        j2 = np.minimum(np.searchsorted(au, q), len(au) - 1)
        nact = np.where(au[j2] == q, ac[j2], 0).astype(float)
        shr = np.where(nact > 0, cnt / np.maximum(nact, 1), 0.0)
        return cnt, shr

    grids = {x: LB.read_iii(a.datasets, LB.SERIES[x][1]) for x in series}
    out = {"what": "Q26 R25 binned all-origin ladder calibration of TWAP-(fH) conditioned on crowding (development, "
                   "Aave V3 Polygon label B); design membrane-board design/q26-r25-binned-calibration-2026-10-25.md",
           "grid": {"u6_edges": U6_EDGES.tolist(), "dn_edges": DN_EDGES.tolist(), "n10_edges": CNT_EDGES.tolist(),
                    "s10_edges": SHR_EDGES.tolist(), "kappa": KAPPA, "calm_u6": CALM_U6},
           "bootstrap": {"B": NB, "seed": SEED_BOOT, "kind": "pigeonhole two-way series x week; one-way week"},
           "null": {"nsim": a.nsim, "seed": SEED_NULL, "kind": "one uniform per series x origin day"},
           "by_H": {}, "final_tables": {}}
    q_lo, q_hi = int(qidx([SCORE_LO])[0]), int(qidx([T_HI])[0])
    for hj, Hh in enumerate(HS):
        Hs = Hh * 3600
        tab = []
        for xi, x in enumerate(series):
            key = f"{x}|{Hh}|"
            ts = F[key + "ts"]
            o = np.argsort(ts)
            ts = ts[o]
            m = (ts >= T_LO) & (ts <= T_HI)
            ts = ts[m]
            P = F[key + "fH"][o][m].astype(float)
            Y = F[key + "y"][o][m].astype(float)
            st, g = grids[x]
            f = U.grid_feats(st, g["close"], ts)
            cnt, shr = crowd_of(xi, ts)
            T = {"ts": ts, "P": P, "Y": Y, "u6": f["u6"], "dn": f["dn"], "pb": parent_bin(f["u6"], f["dn"]),
                 "cnt": cnt, "shr": shr, "cbB": crowd_bin("B", cnt, shr), "cbC": crowd_bin("C", cnt, shr),
                 "q": qidx(ts)}
            T["SP"] = np.stack([P[:, bl[b]].sum(1) for b in range(3)], 1)
            T["SY"] = np.stack([Y[:, bl[b]].sum(1) for b in range(3)], 1)
            tab.append(T)
        tabs_q = {q: fit_tables(tab, Hs, q) for q in range(q_lo, q_hi + 1)}
        fin = fit_tables(tab, Hs, q_hi + 1)          # all rows resolved before 2026-10-01: the frozen table
        out["final_tables"][TL[Hh]] = {arm: np.round(fin[arm], 5).tolist() for arm in ("A", "B", "C")}
        out["final_tables"][TL[Hh]]["fit_rows"] = fin["rows"]
        out["final_tables"][TL[Hh]]["parent_pos"] = np.round(fin["YP"], 1).tolist()
        print(f"H {Hh}: fitted {len(tabs_q)} quarters {time.time() - t0:.0f}s", flush=True)

        # ---- ladder guards on scored origins (2023-01 ..), every level, positives beside every ratio ----
        guard = {}
        for arm in ARMS:
            lvP, lvY = np.zeros(len(levels)), np.zeros(len(levels))
            oP, oY = 0.0, 0.0
            for T in tab:
                m = T["ts"] >= SCORE_LO
                Pc = T["P"][m].copy()
                if arm != "raw":
                    for b in range(3):
                        mu = mult_of(tabs_q, arm, T["q"][m], np.full(m.sum(), b), T["pb"][m], T["cbB"][m], T["cbC"][m])
                        Pc[:, bl[b]] = np.minimum(1.0, Pc[:, bl[b]] * mu[:, None])
                Y = T["Y"][m]
                lvP += Pc.sum(0)
                lvY += Y.sum(0)
                calm = (T["dn"][m] <= 0) & (T["u6"][m] <= CALM_U6)
                oP += Pc[calm][:, near_lv].sum()
                oY += Y[calm][:, near_lv].sum()
            Yn, Yf = lvY[near_lv].sum(), lvY[far_lv].sum()
            guard[arm] = {"near_levels_R": float(lvP[near_lv].sum() / Yn), "pos_near": int(Yn),
                          "far_levels_R": float(lvP[far_lv].sum() / Yf) if Yf else None, "pos_far": int(Yf),
                          "ordinary_origins_near_levels_R": float(oP / oY) if oY else None, "pos_ordinary": int(oY),
                          "per_level": {f"{-levels[j] * 100:g}%": {"R": (round(float(lvP[j] / lvY[j]), 3) if lvY[j]
                                                                      else None), "pos": int(lvY[j])}
                                        for j in np.r_[near_lv, far_lv]}}

        # ---- scored positions ----
        sub = ~(hf0 < 1.0) & (single >= 0) & (yB[:, hj] >= 0) & np.isfinite(kX[:, hj]) & (kX[:, hj] < 0) \
            & (kX[:, hj] > -0.30) & (day >= SCORE_LO) & (day <= T_HI)
        vi = np.nonzero(sub)[0]
        k = kX[vi, hj].astype(float)
        sx = single[vi].astype(int)
        dv = day[vi]
        pf = np.full(len(vi), np.nan)
        u6 = np.full(len(vi), np.nan)
        dn = np.full(len(vi), np.nan)
        cnt = np.zeros(len(vi))
        shr = np.zeros(len(vi))
        for xi, x in enumerate(series):
            key = f"{x}|{Hh}|"
            ts_x, fh_x = F[key + "ts"], F[key + "fH"]
            o = np.argsort(ts_x)
            ts_x, fh_x = ts_x[o], fh_x[o].astype(float)
            m = np.nonzero(sx == xi)[0]
            tt = dv[m]
            j = np.searchsorted(ts_x, tt)
            jj = np.minimum(j, len(ts_x) - 1)
            nres = np.searchsorted(ts_x, tt - Hs, side="right")
            g = (j < len(ts_x)) & (ts_x[jj] == tt) & (nres >= 30)
            pf[m[g]] = N.interp(k[m[g]], levels, fh_x[jj[g]])
            st, gg = grids[x]
            fx = U.grid_feats(st, gg["close"], tt)
            u6[m], dn[m] = fx["u6"], fx["dn"]
            cnt[m], shr[m] = crowd_of(xi, tt)
        ok = np.isfinite(pf)
        vi, k, sx, dv, pf, u6, dn, cnt, shr = (v[ok] for v in (vi, k, sx, dv, pf, u6, dn, cnt, shr))
        yb = yB[vi, hj].astype(float)
        bk = np.full(len(k), -1)
        for bi, (lo, hi) in enumerate(BKS):
            bk[(-k >= lo) & (-k < hi)] = bi
        pb = parent_bin(u6, dn)
        cbB, cbC = crowd_bin("B", cnt, shr), crowd_bin("C", cnt, shr)
        qv = qidx(dv)
        P = {"raw": pf}
        for arm in ("A", "B", "C"):
            P[arm] = np.minimum(1.0, pf * mult_of(tabs_q, arm, qv, bk, pb, cbB, cbC))
        tw = U.TwoWay(sx, dv, len(series), seed=SEED_BOOT, B=NB)
        calm = (dn <= 0) & (u6 <= CALM_U6)
        nearm = (bk >= 0) & (bk <= 2)
        ent = {"rows_scored": int(len(k)), "feature_missing_rows": int((pb < 0).sum()),
               "guard_ladder": guard, "arms": {}}
        for arm in ARMS:
            p = P[arm]
            e = {"R": {BNAMES[b]: U.r_block(tw, p, yb, bk == b) for b in range(len(BKS))}}
            e["R"]["near_0-10%"] = U.r_block(tw, p, yb, nearm)
            e["calm_near_R"] = U.r_block(tw, p, yb, nearm & calm)
            e["calm_R_by_bucket"] = {BNAMES[b]: U.r_block(tw, p, yb, (bk == b) & calm) for b in range(3)}
            allm = bk >= 0
            if arm != "raw":
                e["bss_vs_raw_all"] = U.bss_block(tw, yb, p, pf, allm)
                e["bss_vs_raw_near"] = U.bss_block(tw, yb, p, pf, nearm)
                e["auc_all"] = U.auc_diff(tw, yb, p, pf, allm)
            else:
                e["auc_all"] = {"auc": LB.auc(p[allm], yb[allm])}
            if arm in ("B", "C"):
                top = nearm & ((cbB == 3) if arm == "B" else (cbC == 3))
                sdk = sx[top].astype(np.int64) * 10**7 + dv[top] // DAY
                e["top_crowding_bin"] = {"positions": int(top.sum()), "pos": int(yb[top].sum()),
                                         "series_days": int(len(np.unique(sdk))),
                                         "R_raw": float(pf[top].sum() / yb[top].sum()) if yb[top].sum() else None,
                                         "R_arm": float(p[top].sum() / yb[top].sum()) if yb[top].sum() else None}
            ent["arms"][arm] = e
        sdk = sx[nearm].astype(np.int64) * 10**7 + dv[nearm] // DAY
        _, sdinv = np.unique(sdk, return_inverse=True)
        ent["near_series_days"] = int(sdinv.max() + 1)
        yp = yb[nearm] > 0
        ent["near_series_days_with_pos"] = int(len(np.unique(sdinv[yp])))
        ent["null"] = U.null_band({arm: P[arm][nearm] for arm in ARMS}, sdinv, sdinv.max() + 1, bk[nearm], 3,
                                  nsim=a.nsim)
        out["by_H"][TL[Hh]] = ent
        rr = {arm: [round(ent["arms"][arm]["R"][BNAMES[b]]["R"], 3) for b in range(3)] for arm in ARMS}
        print(f"H {Hh}: near R {json.dumps(rr)} | {time.time() - t0:.0f}s", flush=True)
        if Hh == 6:
            exp = (0.67, 0.51, 0.37)                 # REVIEW R24 raw 6 h near R, 2023-01 .. 2026-09
            if any(abs(g_ - e_) > 0.006 for g_, e_ in zip(rr["raw"], exp)):
                raise SystemExit(f"STOP: raw 6 h R {rr['raw']} does not reproduce {exp}")
    out["rule"] = rule(out)
    os.makedirs(a.out, exist_ok=True)
    U.dump(out, os.path.join(a.out, "r25-bincal.json"))
    print("selected:", out["rule"]["selected"], f"{time.time() - t0:.0f}s", flush=True)


def _farther(r0, r1):
    return r0 is not None and r1 is not None and abs(np.log(r1)) > abs(np.log(r0)) + GUARD_TOL


def rule(out):
    res = {}
    for arm in ("A", "B", "C"):
        cells, fails, g = {}, [], {}
        for H in ("6h", "1d"):
            ent = out["by_H"][H]
            for b in BNAMES[:3]:
                R = ent["arms"][arm]["R"][b]["R"]
                q = ent["null"][arm][b]["q05_q50_q95"]
                ok = R is not None and R_BAND[0] <= R <= R_BAND[1] and q is not None and q[0] <= R <= q[2]
                cells[f"{H} {b}"] = {"R": R, "pos": ent["arms"][arm]["R"][b]["pos"], "null": q, "pass": bool(ok)}
                if not ok:
                    fails.append(f"near {H} {b}")
            r0, r1 = ent["arms"]["raw"]["calm_near_R"]["R"], ent["arms"][arm]["calm_near_R"]["R"]
            ok = not _farther(r0, r1)
            g[f"{H} calm positions"] = {"raw": r0, "arm": r1, "pos": ent["arms"][arm]["calm_near_R"]["pos"],
                                        "pass": bool(ok)}
            if not ok:
                fails.append(f"calm {H}")
            au = ent["arms"][arm]["auc_all"]["diff"]
            g[f"{H} auc"] = {"diff": au, "pass": bool(au >= AUC_TOL)}
            if au < AUC_TOL:
                fails.append(f"auc {H}")
        for H in ("6h", "1d", "3d", "7d"):
            bs = out["by_H"][H]["arms"][arm]["bss_vs_raw_all"]
            ok = bs["ci90_twoway"] is not None and bs["ci90_twoway"][0] > BSS_LB
            g[f"{H} bss"] = {"bss": bs["bss"], "ci90_twoway": bs["ci90_twoway"], "pass": bool(ok)}
            if not ok:
                fails.append(f"bss {H}")
        for H in ("3d", "7d"):
            ent = out["by_H"][H]
            for b in BNAMES[:3]:
                r0, r1 = ent["arms"]["raw"]["R"][b]["R"], ent["arms"][arm]["R"][b]["R"]
                ok = not _farther(r0, r1) or (r1 is not None and R_BAND[0] <= r1 <= R_BAND[1])
                g[f"{H} near {b}"] = {"raw": r0, "arm": r1, "pos": ent["arms"][arm]["R"][b]["pos"], "pass": bool(ok)}
                if not ok:
                    fails.append(f"long {H} {b}")
        for H, ent in out["by_H"].items():
            gd = ent["guard_ladder"]
            for grp, pk in (("near_levels_R", "pos_near"), ("ordinary_origins_near_levels_R", "pos_ordinary")):
                r0, r1 = gd["raw"][grp], gd[arm][grp]
                ok = not _farther(r0, r1)
                g[f"{H} ladder {grp}"] = {"raw": r0, "arm": r1, "pos": gd[arm][pk], "pass": bool(ok)}
                if not ok:
                    fails.append(f"ladder {H} {grp}")
        res[arm] = {"near_cells": cells, "near_cells_pass": int(sum(c["pass"] for c in cells.values())),
                    "guards": g, "fails": fails, "REPAIRS": len(fails) == 0}
    passing = [x for x in ORDER if res[x]["REPAIRS"]]
    res["selected"] = passing[0] if passing else None
    res["most_near_cells_descriptive"] = max(ORDER, key=lambda x: res[x]["near_cells_pass"])
    return res


def file_sha(p):
    return hashlib.sha256(open(p, "rb").read()).hexdigest()


if __name__ == "__main__":
    main()
