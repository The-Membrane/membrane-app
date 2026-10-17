"""Q26 R10.5 self-recalibration rung (membrane-board design/Q26_ROUND10_PREREG.md R10.5 and its Deviations).

Development only: a walk-forward on the A6 development predictions (non-blind history). The live blind test is
scored later from the live touch log with `live_recal` (designed here, not wired into the live scorer).

  python3 r105_recal.py freeze --out OUT   write and hash the frozen config (before any score)
  python3 r105_recal.py run    --out OUT   select (W, kappa) by pooled Brier, write and hash frozen-r105.json,
                                           then write the development results (results-dev.json)

Rule, for a cell (asset, T) at issue time t0:
  p'  = expit(logit p - lambda * ln R_w), then the monotone fix across levels (shallow -> deep) at that issue
  p   = the displayed rung (display-a6.json, A6 D3)
  R_w = (sum p + 1) / (sum y + 1) over rows of that (asset, T), all levels, whose truth window ended in
        (t0 - W days, t0] (resolution time = origin + T <= t0)
  lambda = n_ev / (n_ev + kappa), n_ev = sum y over the same rows
No address is read or written.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import subprocess
import sys

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

DATASETS = os.environ.get("MEMBRANE_DATASETS", os.path.join(os.path.expanduser("~"), "membrane-datasets"))
A6_DIR = "history-forecasts/a6/run-015512cb"
INPUTS = {
    "predictions-dev-ETH.csv.gz": f"{A6_DIR}/predictions-dev-ETH.csv.gz",
    "predictions-dev-BTC.csv.gz": f"{A6_DIR}/predictions-dev-BTC.csv.gz",
    "predictions-dev-stETH.csv.gz": f"{A6_DIR}/predictions-dev-stETH.csv.gz",
    "display-a6.json": f"{A6_DIR}/display-a6.json",
}
DISPLAY_SHA256 = "8e9086179ac40da1ec90976c5ba6a551c3893b002f0b7338a097a777a8362e62"   # HISTORY_TOUCH_LIVE D5
ASSETS = ["ETH", "BTC", "stETH"]
HORIZONS = {"6h": 6, "1d": 24, "3d": 72, "7d": 168, "14d": 336, "30d": 720}
W_GRID = [30, 60, 90]
KAPPA_GRID = [5, 10, 20]
EPS = 1e-12
ISSUE_HOUR = 0                      # live issues at 00:17 UTC, asof 00:00Z
BURN_IN_DAYS = 120                  # max W (90) + max T (30 d): every grid point sees a full window
Q2 = (pd.Timestamp("2026-04-01", tz="UTC"), pd.Timestamp("2026-07-01", tz="UTC"))
BOOT_BLOCK = 30
BOOT_REPS = 2000
BOOT_SEED = 20261105
MIN_LIVE_DAYS = 90
ADDR_RE = re.compile(r"0x[0-9a-fA-F]{40}")

DECISIONS = {
    "R105-1": "Displayed rung p per (asset, T) from display-a6.json (A6 D3, sha256 pinned): ETH fH 6h-3d, fbL 7d-30d; "
              "BTC fH everywhere; stETH fHb 6h, a 1d-30d. Dev p = the A6 dev prediction column of that rung "
              "(monotone-fixed, out of fold).",
    "R105-2": "Live emulation: dev issue times are the 00:00Z origins only (one issue per day, like the live log). "
              "All levels of the live grid (ETH/BTC 10, stETH 4) are used; the dev grid equals the live grid.",
    "R105-3": "As-of window: a row enters R_w for an issue at t0 iff its truth window has ended, origin + T <= t0, and "
              "origin + T > t0 - W days (window on resolution time; a window on issue time would leave 30 d cells "
              "empty at W = 30). Sums run over every level of the (asset, T) cell. p in R_w is the static p.",
    "R105-4": "Empty window: R_w = 1 and lambda = 0, so p' = p. p in {0, 1} stays unchanged (logit +-inf); otherwise "
              "logit uses p clipped to [1e-12, 1 - 1e-12].",
    "R105-5": "Monotone fix: running minimum across levels from shallow to deep at each (asset, T, issue). Not re-fixed "
              "across T, as the displayed grid (HISTORY_TOUCH_LIVE D5).",
    "R105-6": "Selection sample: issues with t0 >= first dev origin of the asset + 120 days (every grid point sees a "
              "full window), excluding rows whose (t0, t0 + T] intersects 2026-04-01..2026-06-30 (2026Q2 reported "
              "only). Pooled Brier = mean over every row of ETH, BTC and stETH, all T and levels. Ties: smaller W, "
              "then larger kappa.",
    "R105-7": "Development pass statistics (reported, deciding nothing; the live pass rule applied to dev): per "
              "horizon, BSS of p' vs p pooled over assets and levels, 30-day moving-block bootstrap over issue days "
              "(a_touch.block_bootstrap_indices, 2000 reps, default_rng(20261105)), 95% percentile CI; median |ln R| "
              "over (asset, level) cells with sum y >= 1, R = sum p / sum y, same cells for p' and p.",
    "R105-8": "Walk-forward robustness (reported, deciding nothing): for each year Y 2023..2026, the grid point "
              "with the lowest pooled Brier on selection rows resolved before Y-01-01 is scored on year Y.",
}


# ---------------------------------------------------------------------------------------------
# Rule
# ---------------------------------------------------------------------------------------------
def logit(p):
    p = np.clip(np.asarray(p, float), EPS, 1 - EPS)
    return np.log(p) - np.log1p(-p)


def expit(x):
    return 1.0 / (1.0 + np.exp(-x))


def recal(p, sum_p, sum_y, kappa):
    """p' before the monotone fix. sum_p, sum_y: window sums (static p, outcomes)."""
    p = np.asarray(p, float)
    sum_p = np.asarray(sum_p, float)
    sum_y = np.asarray(sum_y, float)
    R = (sum_p + 1.0) / (sum_y + 1.0)
    lam = sum_y / (sum_y + kappa)
    out = expit(logit(p) - lam * np.log(R))
    out = np.where(p <= 0.0, 0.0, np.where(p >= 1.0, 1.0, out))
    return out


def window_sums(res_time, p, y, issue_times, W_days):
    """Sums of p and y over rows with res_time in (t - W, t] for each t in issue_times. Times in hours (float)."""
    order = np.argsort(res_time, kind="stable")
    rt = np.asarray(res_time, float)[order]
    cp = np.concatenate([[0.0], np.cumsum(np.asarray(p, float)[order])])
    cy = np.concatenate([[0.0], np.cumsum(np.asarray(y, float)[order])])
    t = np.asarray(issue_times, float)
    hi = np.searchsorted(rt, t, side="right")
    lo = np.searchsorted(rt, t - 24.0 * W_days, side="right")
    return cp[hi] - cp[lo], cy[hi] - cy[lo]


def monotone_levels(P):
    """P[..., k] with k shallow -> deep: running minimum."""
    return np.minimum.accumulate(P, axis=-1)


def apply_cell(t0_h, k, p, y, T_h, W_days, kappa):
    """One (asset, T) cell. Arrays per row (origin hours, level, static p, y). Returns p' per row (same order)."""
    t0_h = np.asarray(t0_h, float)
    sp, sy = window_sums(t0_h + T_h, p, y, t0_h, W_days)
    pr = recal(p, sp, sy, kappa)
    df = pd.DataFrame({"t": t0_h, "k": np.asarray(k, float), "pr": pr, "i": np.arange(len(pr))})
    df = df.sort_values(["t", "k"], ascending=[True, False], kind="stable")   # k -0.02 (shallow) first
    df["pr"] = df.groupby("t", sort=False)["pr"].cummin()
    out = np.empty(len(pr))
    out[df["i"].to_numpy()] = df["pr"].to_numpy()
    return out


# ---------------------------------------------------------------------------------------------
# Live blind test (designed; wiring needs a new pin and a HISTORY_TOUCH_LIVE Deviation)
# ---------------------------------------------------------------------------------------------
def live_recal(outcomes, W_days, kappa):
    """Outcome rows of the live log (scores/outcomes-*.jsonl). Uses rows with status 'resolved' and a 'displayed'
    rung whose p is present. Returns rows {date, asset, T, k, y, p, p_recal, issuedAt}. p' at a row uses only
    rows of its (asset, T) with asof + T <= the row's asof (truth window ended before issue), in (asof - W, asof]."""
    rows = []
    for o in outcomes:
        if o.get("status") != "resolved" or not o.get("displayed"):
            continue
        p = (o.get("p") or {}).get(o["displayed"])
        if p is None:
            continue
        rows.append({"date": o["date"], "asset": o["asset"], "T": o["T"], "T_h": int(o["T_h"]), "k": float(o["k"]),
                     "y": int(o["y"]), "p": float(p), "asof": int(o["asof"]), "issuedAt": int(o["issuedAt"])})
    out = []
    if not rows:
        return out
    df = pd.DataFrame(rows)
    for (a, T), g in df.groupby(["asset", "T"], sort=True):
        T_h = int(g["T_h"].iloc[0])
        t0_h = g["asof"].to_numpy() / 3600.0
        pr = apply_cell(t0_h, g["k"].to_numpy(), g["p"].to_numpy(), g["y"].to_numpy(), T_h, W_days, kappa)
        gg = g.assign(p_recal=pr)
        out.extend(gg.to_dict("records"))
    return out


def live_pass(recal_rows, rng_seed=BOOT_SEED, min_days=MIN_LIVE_DAYS):
    """Per horizon: resolved issue days, BSS of p' vs p with the 30-day block CI, median |ln R| of each, PASS."""
    res = {}
    if not recal_rows:
        return res
    df = pd.DataFrame(recal_rows)
    for T in HORIZONS:
        g = df[df["T"] == T]
        days = sorted(g["date"].unique()) if len(g) else []
        r = {"resolvedIssueDays": len(days), "minDays": min_days, "tested": len(days) >= min_days}
        if r["tested"]:
            r.update(pass_stats(g.rename(columns={"date": "day"}), rng_seed))
            r["pass"] = bool(r["bss_ci95"][0] > 0 and r["medAbsLnR_recal"] <= r["medAbsLnR_static"])
        res[T] = r
    return res


# ---------------------------------------------------------------------------------------------
# Statistics
# ---------------------------------------------------------------------------------------------
def med_abs_lnR(g, col):
    vals = []
    for _, c in g.groupby(["asset", "k"]):
        sy = c["y"].sum()
        if sy >= 1:
            vals.append(abs(np.log(c[col].sum() / sy)))
    return float(np.median(vals)) if vals else None, len(vals)


def pass_stats(g, seed):
    """g: rows with day, asset, k, y, p, p_recal. BSS pooled, block CI over days, median |ln R|."""
    import a_touch as A
    g = g.assign(bs=(g["p_recal"] - g["y"]) ** 2, b0=(g["p"] - g["y"]) ** 2)
    per = g.groupby("day")[["bs", "b0"]].sum().sort_index()
    bs, b0 = per["bs"].to_numpy(), per["b0"].to_numpy()
    bss = 1.0 - bs.sum() / b0.sum()
    rng = np.random.default_rng(seed)
    if len(per) >= BOOT_BLOCK:
        idx = A.block_bootstrap_indices(rng, len(per), BOOT_BLOCK, BOOT_REPS)
        boot = 1.0 - bs[idx].sum(axis=1) / b0[idx].sum(axis=1)
        ci = [float(np.quantile(boot, 0.025)), float(np.quantile(boot, 0.975))]
    else:
        ci = [None, None]
    m1, n1 = med_abs_lnR(g, "p_recal")
    m0, _ = med_abs_lnR(g, "p")
    return {"n_rows": int(len(g)), "n_days": int(len(per)), "brier_recal": float(g["bs"].mean()),
            "brier_static": float(g["b0"].mean()), "bss": float(bss), "bss_ci95": ci,
            "medAbsLnR_recal": m1, "medAbsLnR_static": m0, "n_cells_lnR": n1,
            "R_recal": float(g["p_recal"].sum() / max(g["y"].sum(), 1e-12)),
            "R_static": float(g["p"].sum() / max(g["y"].sum(), 1e-12)), "n_y": int(g["y"].sum())}


# ---------------------------------------------------------------------------------------------
# Data
# ---------------------------------------------------------------------------------------------
def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def git_sha():
    sha = subprocess.check_output(["git", "-C", HERE, "rev-parse", "HEAD"], text=True).strip()
    dirty = subprocess.check_output(["git", "-C", HERE, "status", "--porcelain", "--", "."], text=True).strip()
    return sha, bool(dirty)


def load_dev(displayed):
    frames = []
    for a in ASSETS:
        d = pd.read_csv(os.path.join(DATASETS, INPUTS[f"predictions-dev-{a}.csv.gz"]))
        d["t0"] = pd.to_datetime(d["t0"], utc=True)
        d = d[d["t0"].dt.hour == ISSUE_HOUR].copy()
        p = np.full(len(d), np.nan)
        for T in HORIZONS:
            m = (d["T"] == T).to_numpy()
            p[m] = d.loc[m, "p_" + displayed[a][T]].to_numpy()
        d["p"] = p
        d["asset"] = a
        frames.append(d[["asset", "t0", "T", "k", "y", "regime", "p"]])
    d = pd.concat(frames, ignore_index=True)
    if d["p"].isna().any():
        raise SystemExit("STOP: missing displayed p")
    d["T_h"] = d["T"].map(HORIZONS)
    d["t0_h"] = (d["t0"] - pd.Timestamp("1970-01-01", tz="UTC")).dt.total_seconds() / 3600.0
    d["day"] = d["t0"].dt.strftime("%Y-%m-%d")
    first = d.groupby("asset")["t0"].transform("min")
    end = d["t0"] + pd.to_timedelta(d["T_h"], unit="h")
    d["inQ2"] = (d["t0"] < Q2[1]) & (end > Q2[0])
    d["burnin"] = d["t0"] < first + pd.Timedelta(days=BURN_IN_DAYS)
    d["res"] = end
    return d


def apply_all(d, W, kappa):
    pr = np.empty(len(d))
    for (a, T), g in d.groupby(["asset", "T"], sort=False):
        pr[g.index.to_numpy()] = apply_cell(g["t0_h"].to_numpy(), g["k"].to_numpy(), g["p"].to_numpy(),
                                            g["y"].to_numpy(), HORIZONS[T], W, kappa)
    return pr


def guard(text):
    if ADDR_RE.search(text):
        raise SystemExit("STOP: address-like string in output")


def write_json(path, obj):
    s = json.dumps(obj, indent=1, sort_keys=False)
    guard(s)
    with open(path, "w") as f:
        f.write(s + "\n")
    return sha256_file(path)


# ---------------------------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------------------------
def frozen_config():
    sha, dirty = git_sha()
    if dirty:
        raise SystemExit("STOP: uncommitted code")
    ins = {k: {"path": v, "sha256": sha256_file(os.path.join(DATASETS, v))} for k, v in INPUTS.items()}
    if ins["display-a6.json"]["sha256"] != DISPLAY_SHA256:
        raise SystemExit("STOP: display-a6.json sha256 mismatch")
    disp = json.load(open(os.path.join(DATASETS, INPUTS["display-a6.json"])))["displayed"]
    return {"schema": "q26-r105/frozen-config/1", "item": "Q26 R10.5 self-recalibration rung (development)",
            "prereg": "triccs/membrane-board design/Q26_ROUND10_PREREG.md R10.5",
            "code": {"repo": "The-Membrane/membrane-app", "sha": sha, "path": "scripts/research/history-forecasts/r105_recal.py"},
            "inputs": ins, "displayed": disp, "W_grid": W_GRID, "kappa_grid": KAPPA_GRID, "eps": EPS,
            "issueHourUTC": ISSUE_HOUR, "burnInDays": BURN_IN_DAYS, "q2Excluded": [str(Q2[0].date()), "2026-06-30"],
            "bootstrap": {"block_days": BOOT_BLOCK, "reps": BOOT_REPS, "seed": BOOT_SEED},
            "decisions": DECISIONS}


def cmd_freeze(out):
    os.makedirs(out, exist_ok=True)
    path = os.path.join(out, "frozen-r105-config.json")
    if os.path.exists(path):
        raise SystemExit("STOP: frozen config exists")
    h = write_json(path, frozen_config())
    with open(path + ".sha256", "w") as f:
        f.write(f"{h}  frozen-r105-config.json\n")
    print("frozen config", h)


def cmd_run(out):
    path = os.path.join(out, "frozen-r105-config.json")
    cfg = json.load(open(path))
    want = open(path + ".sha256").read().split()[0]
    if sha256_file(path) != want:
        raise SystemExit("STOP: frozen config hash")
    now = frozen_config()
    if now["code"]["sha"] != cfg["code"]["sha"] or now["inputs"] != cfg["inputs"]:
        raise SystemExit("STOP: code or inputs differ from the frozen config")
    d = load_dev(cfg["displayed"])
    sel = (~d["burnin"]) & (~d["inQ2"])
    log = []
    grid = {}
    preds = {}
    for W in W_GRID:
        for kap in KAPPA_GRID:
            pr = apply_all(d, W, kap)
            preds[(W, kap)] = pr
            b = float(np.mean((pr[sel] - d["y"].to_numpy()[sel]) ** 2))
            grid[f"W{W}_k{kap}"] = b
    b_static = float(np.mean((d["p"].to_numpy()[sel] - d["y"].to_numpy()[sel]) ** 2))
    best = min(((grid[f"W{W}_k{k}"], W, -k) for W in W_GRID for k in KAPPA_GRID))
    W_s, k_s = best[1], -best[2]
    frozen = {"schema": "q26-r105/frozen/1", "configSha256": want, "code": cfg["code"],
              "selected": {"W_days": W_s, "kappa": k_s}, "rule": {
                  "p_recal": "expit(logit p - lambda * ln R_w), then running minimum across levels shallow->deep",
                  "R_w": "(sum p + 1) / (sum y + 1), rows of the (asset, T) cell, all levels, origin + T in (t0 - W days, t0]",
                  "lambda": "n_ev / (n_ev + kappa), n_ev = sum y over the same rows",
                  "p": "displayed rung (display-a6.json)", "edge": DECISIONS["R105-4"]},
              "selectionBrier": grid, "selectionBrierStatic": b_static, "selectionRows": int(sel.sum())}
    fh = write_json(os.path.join(out, "frozen-r105.json"), frozen)
    with open(os.path.join(out, "frozen-r105.json.sha256"), "w") as f:
        f.write(f"{fh}  frozen-r105.json\n")
    log.append(f"selected W={W_s} kappa={k_s} frozen-r105.json {fh}")
    print(log[-1])

    # results (reported)
    d["p_recal"] = preds[(W_s, k_s)]
    res = {"schema": "q26-r105/results-dev/1", "frozenSha256": fh, "configSha256": want, "selected": frozen["selected"],
           "grid": grid, "staticBrier": b_static, "perHorizon": {}, "perAssetHorizon": {}, "q2Reported": {},
           "gridPerHorizonBSS": {}, "walkForward": {}, "lambda": {}}
    S = d[sel]
    for T in HORIZONS:
        res["perHorizon"][T] = pass_stats(S[S["T"] == T], BOOT_SEED)
        res["perHorizon"][T]["devPass"] = bool(res["perHorizon"][T]["bss_ci95"][0] > 0 and
                                               res["perHorizon"][T]["medAbsLnR_recal"] <= res["perHorizon"][T]["medAbsLnR_static"])
        q = d[d["inQ2"] & (d["T"] == T)]
        if len(q):
            qq = q.assign(bs=(q["p_recal"] - q["y"]) ** 2, b0=(q["p"] - q["y"]) ** 2)
            res["q2Reported"][T] = {"n_rows": int(len(q)), "bss": float(1 - qq["bs"].sum() / qq["b0"].sum()),
                                    "R_recal": float(q["p_recal"].sum() / max(q["y"].sum(), 1e-12)),
                                    "R_static": float(q["p"].sum() / max(q["y"].sum(), 1e-12)), "n_y": int(q["y"].sum())}
        for (W, kap), pr in preds.items():
            m = (sel & (d["T"] == T)).to_numpy()
            y = d["y"].to_numpy()[m]
            res["gridPerHorizonBSS"].setdefault(T, {})[f"W{W}_k{kap}"] = float(
                1 - np.sum((pr[m] - y) ** 2) / np.sum((d["p"].to_numpy()[m] - y) ** 2))
        for a in ASSETS:
            g = S[(S["T"] == T) & (S["asset"] == a)]
            gg = g.assign(bs=(g["p_recal"] - g["y"]) ** 2, b0=(g["p"] - g["y"]) ** 2)
            res["perAssetHorizon"].setdefault(a, {})[T] = {
                "n_rows": int(len(g)), "n_y": int(g["y"].sum()), "bss": float(1 - gg["bs"].sum() / gg["b0"].sum()),
                "R_recal": float(g["p_recal"].sum() / max(g["y"].sum(), 1e-12)),
                "R_static": float(g["p"].sum() / max(g["y"].sum(), 1e-12)),
                "medAbsLnR_recal": med_abs_lnR(g, "p_recal")[0], "medAbsLnR_static": med_abs_lnR(g, "p")[0]}
    # lambda distribution at the selected point (per asset, T at issue level)
    for (a, T), g in d[sel].groupby(["asset", "T"]):
        gi = g.drop_duplicates("t0")
        full = d[(d["asset"] == a) & (d["T"] == T)]
        sp, sy = window_sums(full["t0_h"].to_numpy() + HORIZONS[T], full["p"].to_numpy(), full["y"].to_numpy(),
                             gi["t0_h"].to_numpy(), W_s)
        lam = sy / (sy + k_s)
        res["lambda"].setdefault(a, {})[T] = {"median": float(np.median(lam)), "p90": float(np.quantile(lam, 0.9)),
                                             "medianLnR": float(np.median(np.log((sp + 1) / (sy + 1))))}
    # walk-forward robustness (deciding nothing)
    y_all = d["y"].to_numpy()
    for Y in [2023, 2024, 2025, 2026]:
        ys = pd.Timestamp(f"{Y}-01-01", tz="UTC")
        ye = pd.Timestamp(f"{Y + 1}-01-01", tz="UTC")
        tr = (sel & (d["res"] <= ys)).to_numpy()
        te = (sel & (d["t0"] >= ys) & (d["t0"] < ye)).to_numpy()
        if tr.sum() == 0 or te.sum() == 0:
            continue
        sc = min((float(np.mean((preds[(W, k)][tr] - y_all[tr]) ** 2)), W, -k) for W in W_GRID for k in KAPPA_GRID)
        Wy, ky = sc[1], -sc[2]
        b0 = np.sum((d["p"].to_numpy()[te] - y_all[te]) ** 2)
        res["walkForward"][str(Y)] = {"chosen": {"W_days": Wy, "kappa": ky}, "n_rows": int(te.sum()),
                                      "bss_chosen": float(1 - np.sum((preds[(Wy, ky)][te] - y_all[te]) ** 2) / b0),
                                      "bss_frozen": float(1 - np.sum((preds[(W_s, k_s)][te] - y_all[te]) ** 2) / b0)}
    rh = write_json(os.path.join(out, "results-dev.json"), res)
    log.append(f"results-dev.json {rh}")
    for T, r in res["perHorizon"].items():
        log.append(f"{T} BSS {r['bss']:+.5f} CI [{r['bss_ci95'][0]:+.5f}, {r['bss_ci95'][1]:+.5f}] "
                   f"med|lnR| {r['medAbsLnR_recal']:.3f} vs {r['medAbsLnR_static']:.3f} devPass={r['devPass']}")
    with open(os.path.join(out, "run-log.txt"), "w") as f:
        f.write("\n".join(log) + "\n")
    print("\n".join(log))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["freeze", "run"])
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    cmd_freeze(a.out) if a.cmd == "freeze" else cmd_run(a.out)


if __name__ == "__main__":
    main()
