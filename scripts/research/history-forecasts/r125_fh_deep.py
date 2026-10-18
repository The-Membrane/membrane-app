"""Q26 R12.5: plain (fH) at deep levels for liquidation-line odds (12 h, 1 d, 3 d; -15%, -20%; -25% reported only).

membrane-board design/Q26_ROUND12_PREREG.md, Deviations D-R12.1c (lead, post hoc on B9) and D-R12.5a (registration).
(fH), (f) and (a) are computed by the frozen R12 / A6 code path (`r12_tail.series_task`, unchanged); (e) is the frozen
R12 development constant per (T, level) (`pooled-frozen-r12.json`, membrane-datasets dev-49e1af3a). No retune.

  python3 r125_fh_deep.py power   --acq ACQ --dev DEVOUT --out OUT [--workers 4]
        B9 (grade C, development effect) and B10: per-cell BSS, block tests and blocks-to-80%-power G* of (fH) vs
        (f), (a), (e). Reads only the locked, already-scored B9/B10 grids.
  python3 r125_fh_deep.py acquire --datasets DS --acq ACQ5 [--only okx|bybit|kucoin]
        outcome-blind builder for the R12.5 blind set B12 (venue-unique USDT pairs: OKX, Bybit, KuCoin). Prints counts
        only.
  python3 r125_fh_deep.py counts  --acq ACQ5 --out OUT
        counts-only check: validated origins and positive crash-episode blocks per cell; no forecast, no score.
  python3 r125_fh_deep.py freeze  --acq ACQ5 --dev DEVOUT --power POWOUT --out OUT
  python3 r125_fh_deep.py run     --acq ACQ5 --dev DEVOUT --cfgdir OUT --out OUT [--workers 4]

No address, key or secret is read or written.
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
import math  # noqa: E402
import re  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402
import urllib.error  # noqa: E402
import urllib.request  # noqa: E402
import zipfile  # noqa: E402
import concurrent.futures as cf  # noqa: E402

import numpy as np  # noqa: E402
from scipy.stats import norm  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import a_touch as A  # noqa: E402
import r112_combine as R112  # noqa: E402
import r12_tail as R12  # noqa: E402

PREREG = {"repo": "triccs/membrane-board", "path": "design/Q26_ROUND12_PREREG.md",
          "deviations": "D-R12.1c (lead), D-R12.5a (registration), D-R12.5b (acquisition/freeze), D-R12.5c (result)"}
STEP, DAY = R12.STEP, R12.DAY
HORIZONS5 = (12, 24, 72)
CONF_LEVELS = (-0.15, -0.20)                     # confirmatory
REP_LEVELS = (-0.25,)                            # reported only
LEVELS5 = CONF_LEVELS + REP_LEVELS
CMPS5 = ("f", "a", "e")
N_CONF = len(HORIZONS5) * len(CONF_LEVELS)       # Holm family: 6 cells
ALPHA = 0.05
Z_POW = float(norm.ppf(1 - ALPHA / N_CONF) + norm.ppf(0.8))
R_BAND = (0.8, 1.25)
MIN_POS_BLOCKS = 30
SEED = 20261825
N_BOOT = R12.N_BOOT


def now_iso():
    return R12.now_iso()


def col_of(k):
    return R12.LEVELS.index(k)


# =============================================================================================
# scoring core (shared by power and run)
# =============================================================================================
def forecasts(res):
    """stack rows of every series (2026Q2 and B9-style tail dropped) -> S, P[fH|f|a] (n, K) monotone-fixed."""
    S = R12.stack_rows(res, lambda rw: ~rw["q2"] & ~rw["tail"])
    if S is None:
        return None, None
    P = {"fH": np.minimum.accumulate(S["pH"].astype(float), axis=1),
         "f": np.minimum.accumulate(S["pf"].astype(float), axis=1),
         "a": np.minimum.accumulate(S["pa"].astype(float), axis=1)}
    return S, P


def score_cell(S, P, ec, T, k, seed_key, groups=None):
    """(fH) vs (f), (a), (e) at one cell: BSS, block bootstrap + CR1 per comparator, R, per-positive-block G*."""
    col = col_of(k)
    yc = S["y"][:, col].astype(float)
    n = len(yc)
    g, G, pb = R12.crash_blocks(S["ts"], S["sid"], yc, T)
    rng = np.random.default_rng(np.random.SeedSequence([SEED, seed_key]))
    idx = rng.integers(0, G, size=(N_BOOT, G))
    ph = P["fH"][:, col]
    sec = (ph - yc) ** 2
    cell = {"T": R12.TL[T], "level": k, "rows": int(n), "series": int(len(np.unique(S["sid"]))),
            "positive_origins": int(yc.sum()), "blocks": int(G), "positive_blocks": int(pb.sum()),
            "R_fH": float(ph.sum() / yc.sum()) if yc.sum() > 0 else None, "vs": {}}
    cell["R_cmp"] = {c: float(P[c][:, col].sum() / yc.sum()) if yc.sum() > 0 else None for c in ("f", "a")}
    cell["R_cmp"]["e"] = float(ec[col] * n / yc.sum()) if yc.sum() > 0 else None
    pmax, gst = [], []
    for cmp in CMPS5:
        pc = np.full(n, ec[col], float) if cmp == "e" else P[cmp][:, col]
        d = sec - (pc - yc) ** 2
        bt = R12.boot_test(g, d, idx)
        ct = R12.cr1_test(g, d)
        dk = R12.dk_hac(S["ts"], d)
        bc = float(np.mean((pc - yc) ** 2))
        Sb, _ = R12.cluster_sums(g, d, G)
        Sp = Sb[pb]
        mb, sb = (float(Sp.mean()), float(Sp.std(ddof=1))) if len(Sp) > 1 else (np.nan, np.nan)
        gs = (Z_POW * sb / mb) ** 2 if (np.isfinite(mb) and mb < 0) else None
        gst.append(gs)
        cell["vs"][cmp] = {"mean_d": float(d.mean()), "bss": 1 - float(sec.mean()) / bc if bc > 0 else None,
                           "boot": bt, "cr1": ct, "dk_hac_reported": dk,
                           "largest_block_share_of_d_sum": float(np.max(np.abs(Sb)) / abs(Sb.sum()))
                           if Sb.sum() != 0 else None,
                           "pos_block_mean_d_sum": mb, "pos_block_sd_d_sum": sb, "G_star": gs}
        pmax += [bt["p_one_sided"], ct["p_one_sided"] if ct["p_one_sided"] is not None else 1.0]
    cell["cell_p"] = float(max(pmax))
    cell["all_mean_d_negative"] = bool(all(cell["vs"][c]["mean_d"] < 0 for c in CMPS5))
    cell["G_star_max"] = None if any(x is None for x in gst) else float(max(gst))
    cell["R_in_band"] = bool(cell["R_fH"] is not None and R_BAND[0] <= cell["R_fH"] <= R_BAND[1])
    cell["reported_only_low_blocks"] = bool(pb.sum() < MIN_POS_BLOCKS)
    # reported: per-year and per-month R(fH), per-fold R, BSS vs f per year
    ts = S["ts"]
    yr = np.array([A.iso(int(t))[:4] for t in ts])
    mo = np.array([A.iso(int(t))[:7] for t in ts])
    pf_ = P["f"][:, col]

    def rby(lab):
        out = {}
        for u in np.unique(lab):
            mm = lab == u
            sy = float(yc[mm].sum())
            bf = float(np.mean((pf_[mm] - yc[mm]) ** 2))
            out[str(u)] = {"rows": int(mm.sum()), "pos": sy, "R_fH": float(ph[mm].sum() / sy) if sy > 0 else None,
                           "R_f": float(pf_[mm].sum() / sy) if sy > 0 else None,
                           "bss_vs_f": 1 - float(sec[mm].mean()) / bf if bf > 0 else None}
        return out
    cell["per_year"] = rby(yr)
    cell["per_month"] = rby(mo)
    if "fold" in S:
        fk = np.array([f"{int(s)}:{int(f)}" for s, f in zip(S["sid"], S["fold"])])
        fr = []
        for u in np.unique(fk):
            mm = fk == u
            sy = float(yc[mm].sum())
            if sy > 0:
                fr.append(float(ph[mm].sum() / sy))
        cell["per_fold_R_fH"] = {"n_folds_with_positives": len(fr),
                                 "median": float(np.median(fr)) if fr else None,
                                 "q25": float(np.quantile(fr, 0.25)) if fr else None,
                                 "q75": float(np.quantile(fr, 0.75)) if fr else None}
    if groups is not None:          # venue cut (reported): same tests on each group's rows
        cell["by_group"] = {}
        for gname, gmask in groups.items():
            if gmask.sum() == 0:
                continue
            Sg = {kk: v[gmask] for kk, v in S.items()}
            Pg = {kk: v[gmask] for kk, v in P.items()}
            sub = score_cell(Sg, Pg, ec, T, k, seed_key + 7000 + len(cell["by_group"]))
            cell["by_group"][gname] = {kk: sub[kk] for kk in ("rows", "series", "positive_origins", "blocks",
                                                               "positive_blocks", "R_fH", "R_cmp", "cell_p",
                                                               "all_mean_d_negative")}
            cell["by_group"][gname]["bss"] = {c: sub["vs"][c]["bss"] for c in CMPS5}
            cell["by_group"][gname]["mean_d"] = {c: sub["vs"][c]["mean_d"] for c in CMPS5}
            cell["by_group"][gname]["boot_p"] = {c: sub["vs"][c]["boot"]["p_one_sided"] for c in CMPS5}
    return cell


def e_consts(dev, T):
    pf = json.load(open(os.path.join(dev, "pooled-frozen-r12.json")))
    return np.array([pf["e"][R12.TL[T]][repr(k)] for k in R12.LEVELS], float)


def power_from(cell, G):
    """power of the cell's weakest comparator leg at G positive blocks (normal approximation)."""
    out = []
    for c in CMPS5:
        v = cell["vs"][c]
        mb, sb = v["pos_block_mean_d_sum"], v["pos_block_sd_d_sum"]
        if not (np.isfinite(mb) and np.isfinite(sb)) or mb >= 0 or sb <= 0:
            out.append(0.0)
            continue
        z = -mb / sb * math.sqrt(G)
        out.append(float(norm.cdf(z - norm.ppf(1 - ALPHA / N_CONF))))
    return min(out)


# =============================================================================================
# power on B9 (grade C) and B10 -- the development effect for R12.5
# =============================================================================================
def link_acq(acq_r12, datasets):
    """the R12 builder layout: ACQ/b9, ACQ/b10 -> membrane-datasets locked folders."""
    os.makedirs(acq_r12, exist_ok=True)
    for sub, src in (("b9", "b9-delisted-prices"), ("b10", "b10-bitfinex-prices")):
        p = os.path.join(acq_r12, sub)
        if not os.path.exists(p):
            os.symlink(os.path.join(datasets, src), p)


def cmd_power(a):
    os.makedirs(a.out, exist_ok=True)
    logf = open(os.path.join(a.out, "power-log.txt"), "a")

    def log(s):
        line = f"{now_iso()} {s}"
        print(line, flush=True)
        logf.write(line + "\n")
        logf.flush()
    if a.datasets:
        link_acq(a.acq, a.datasets)
    out = {"schema": "q26-r125/power/1", "started_utc": now_iso(), "code_sha": R112.git_sha(),
           "code_clean": R112.git_clean(), "z_power": Z_POW, "alpha_family": ALPHA, "n_conf": N_CONF,
           "note": "B9 and B10 are grade C for 1 h-3 d touch (D-R12.1b); this is the development effect for R12.5",
           "sets": {}}
    for setname in ("b9", "b10"):
        specs, _ = R12.blind_specs(a.acq, setname)
        cells = {}
        for ti, T in enumerate(HORIZONS5):
            res = R12.run_pool([{"spec": s, "T": T, "grid": "1h"} for s in specs], a.workers, log, f"{setname} "
                               f"{R12.TL[T]}")
            S, P = forecasts(res)
            ec = e_consts(a.dev, T)
            for j, k in enumerate(LEVELS5):
                c = score_cell(S, P, ec, T, k, 100 * ti + j + (0 if setname == "b9" else 50))
                for kk in ("per_month",):
                    c.pop(kk, None)
                cells[f"{R12.TL[T]} {k}"] = c
                log(f"  {setname} {R12.TL[T]} {k:+.2f}: R(fH) {c['R_fH']:.3f}; " + "; ".join(
                    f"vs {cc} BSS {c['vs'][cc]['bss']:+.4f} pb {c['vs'][cc]['boot']['p_one_sided']:.3g} "
                    f"pt {c['vs'][cc]['cr1']['p_one_sided']:.3g} G* {c['vs'][cc]['G_star']}" for cc in CMPS5) +
                    f"; cell p {c['cell_p']:.3g}; pos blocks {c['positive_blocks']}")
            del res
        out["sets"][setname] = cells
    out["finished_utc"] = now_iso()
    h = R112.write_json(os.path.join(a.out, "power-r125.json"), out)
    log(f"power done; sha256 {h}")


# =============================================================================================
# main
# =============================================================================================
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=("power", "acquire", "counts", "freeze", "run"))
    ap.add_argument("--datasets")
    ap.add_argument("--acq")
    ap.add_argument("--dev")
    ap.add_argument("--out")
    ap.add_argument("--power")
    ap.add_argument("--cfgdir")
    ap.add_argument("--only")
    ap.add_argument("--workers", type=int, default=4)
    a = ap.parse_args()
    {"power": cmd_power}[a.cmd](a)


if __name__ == "__main__":
    main()
