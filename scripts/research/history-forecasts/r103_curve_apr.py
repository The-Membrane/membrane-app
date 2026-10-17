"""Q26 R10.3 rate-curve APR challenger to Q33 C3 (membrane-board design/Q26_ROUND10_PREREG.md R10.3 and its Deviations).

Target (the Q33 C3 subject): Aave V3 Core USDC variable borrow APR in the latest block strictly before t0 + 7 d,
origins daily 00:00Z, quantiles q05 q25 q50 q75 q95.

  python3 r103_curve_apr.py freeze --out OUT   write and hash the frozen config (before any score)
  python3 r103_curve_apr.py run    --out OUT   check the frozen config, forecast, score, write results

Model at origin t0 (one fit per origin, nothing tuned on outcomes):
  U_d      = borrow usage at the last R10.1 H read (b_h) strictly before d 00:00Z
  D_d      = logit U_d - logit U_{d-1};  RV_d = D_d^2
  HAR      = OLS of RV_d on [1, RV_{d-1}, mean RV_{d-7..d-1}, mean RV_{d-30..d-1}] over rows d in (t0 - 730 d, t0]
  sig2     = max(fitted, FLOOR_SHARE * mean RV over the training rows)
  z_d      = D_d / sqrt(sig2_d) on the training rows (in-sample fit of the t0 model)
  forecast = iterated HAR sig2 for t0+1 .. t0+7 (forecasts replace unknown RV lags)
  paths    = every 7-consecutive-day block of z in the training rows (all overlapping blocks, equal weight, no seed);
             logit U_T = logit U_t0 + sum_k sqrt(sig2_{t0+k}) z_{j+k-1}
  APR      = Aave default curve (base, slope1, slope2, U_opt) read at the last b_h before t0, applied to U_T.
             Stable debt is 0 for USDC at every hour, so the overall borrow rate is the variable rate.
             A curve change inside (t0, t0 + 7 d] is ignored (curve in force at t0).
  quantile = numpy linear-interpolated empirical quantiles over the paths
No address is read or written.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import os
import re
import subprocess
import sys

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
DATASETS = os.environ.get("MEMBRANE_DATASETS", os.path.join(os.path.expanduser("~"), "membrane-datasets"))

H_INPUT = "history-forecasts/r10/r101-run-d96f48c8/usdc-hourly-inputs.csv.gz"
H_SHA256 = "a57f12fdc14cec042ac3ff30e31513cbb3d698679b404893a5603eb36242dc20"   # R10.1 PROVENANCE
C3_COMMIT = "84ea4567c75e09b3a58cf202f953b6ff470a81c8"   # membrane-datasets research/q33-usdc7-delta (Q33 CHECKPOINT)
C3_RUN = "validation/q33-shrinkage-study/runs/fc8bd4718e378a8d"
C3_FOLDS = ["D1", "D2", "D3", "D4"]
C3_CELL = "aave-core-usdc-borrow-7"

QS = [0.05, 0.25, 0.50, 0.75, 0.95]
HORIZON_D = 7
TRAIN_D = 730
HAR_LAGS = (1, 7, 30)
FLOOR_SHARE = 0.10
MIN_TRAIN_ROWS = 365
Q2 = (pd.Timestamp("2026-04-01", tz="UTC"), pd.Timestamp("2026-07-01", tz="UTC"))
BOOT_BLOCK = 30
BOOT_REPS = 2000
BOOT_SEED = 20261017
GAIN_VS_NOCHANGE = 0.10
MAX_WORSE_VS_C3 = 0.03
ADDR_RE = re.compile(r"0x[0-9a-fA-F]{40}")

DECISIONS = {
    "R103-1": "Daily state U_d = borrow usage (variable + stable debt) / (available + debt) at the last R10.1 H read "
              "strictly before d 00:00Z (hour d-1 23:00 if it has a b_h, else the latest earlier one). Available = "
              "virtual balance where read (v2), else USDC balance of the aToken (v1), as in R10.1A.",
    "R103-2": "Changes D_d = logit U_d - logit U_{d-1}. A change is known at origin t0 iff d <= t0.",
    "R103-3": "HAR variance: OLS with intercept of RV_d = D_d^2 on RV_{d-1}, mean RV_{d-7..d-1}, mean RV_{d-30..d-1}, "
              "refit at each origin on rows d in (t0 - 730 d, t0] with 30 lags inside the data. Fitted values are floored "
              "at 0.10 x the mean RV of the training rows. The first data day is 2023-02-02, so early origins use fewer "
              "than 730 days; an origin with < 365 training rows abstains (counted).",
    "R103-4": "Standardization: z_d = D_d / sqrt(fitted sig2_d) from the origin's own fit (in-sample).",
    "R103-5": "Rescaling at t0: iterated HAR forecasts sig2_{t0+1..t0+7}, unknown RV lags replaced by their forecasts; "
              "day k of a block is scaled by sqrt(sig2_{t0+k}).",
    "R103-6": "Blocks: every 7-consecutive-day block of z among the training rows, equal weight, no random draw and no seed.",
    "R103-7": "Curve: base, slope1, slope2, U_opt at the last b_h before t0, applied to each path's U_T (float64). Stable "
              "debt is 0 at every hour (R10.1 D1), so overall borrow rate = variable rate; the reserve factor does not enter "
              "the borrow APR. Any governance or scheduled curve change inside (t0, t0 + 7 d] is ignored.",
    "R103-8": "Quantiles: numpy linear interpolation over the paths at q05 q25 q50 q75 q95.",
    "R103-9": "No-change: every quantile = the borrow APR stored at the last b_h before t0 (equals Q33 R0 at every C3 "
              "origin, an input check).",
    "R103-10": "Target for all compared forecasts: Q33's published outcome at each matched origin (the C3 subject). The "
               "H-derived target (RDU rate at the last b_h before t0 + 7 d) is computed, its agreement reported, and "
               "scores on it reported only.",
    "R103-11": "Scoring origins: the C3 USDC 7 d origins (shrinkage-study run fc8bd4718e378a8d D1-D4 at datasets "
               "84ea4567) minus origins whose window [t0, t0 + 7 d) intersects 2026-04-01..2026-06-30 "
               "(origins 2026-03-26..2026-06-30); those are reported only.",
    "R103-12": "Pinball: mean over the 5 quantiles, then mean over origins (Q33 convention: reproduces C3 0.00638277 and "
               "R0 0.00905360 over all 822 origins).",
    "R103-13": "Pass: 1 - L/L_nochange >= 0.10 AND L/L_C3 - 1 <= 0.03 on the scoring origins. A 30-day block bootstrap "
               "of both ratios (2000 reps, seed 20261017) is reported only.",
    "R103-14": "Training rows may include 2026Q2 days for later origins; 2026Q2 origins are never scored.",
}


def sha256_bytes(b):
    return hashlib.sha256(b).hexdigest()


def sha256_file(path):
    with open(path, "rb") as f:
        return sha256_bytes(f.read())


def git_sha():
    sha = subprocess.check_output(["git", "-C", HERE, "rev-parse", "HEAD"], text=True).strip()
    dirty = subprocess.check_output(["git", "-C", HERE, "status", "--porcelain", "--", "."], text=True).strip()
    return sha, bool(dirty)


def c3_blob(fold):
    path = f"{C3_RUN}/{fold}/{C3_CELL}/predictions.json.gz"
    b = subprocess.check_output(["git", "-C", DATASETS, "show", f"{C3_COMMIT}:{path}"])
    return path, b


def guard(text):
    if ADDR_RE.search(text):
        raise SystemExit("STOP: address-like string in output")


def write_json(path, obj):
    s = json.dumps(obj, indent=1)
    guard(s)
    with open(path, "w") as f:
        f.write(s + "\n")
    return sha256_file(path)


# ---------------------------------------------------------------------------------------------
# Model
# ---------------------------------------------------------------------------------------------
def logit(u):
    return np.log(u) - np.log1p(-u)


def expit(x):
    return 1.0 / (1.0 + np.exp(-x))


def curve_apr(u, base, s1, s2, opt):
    u = np.asarray(u, dtype=float)
    below = base + s1 * u / opt
    above = base + s1 + s2 * (u - opt) / (1.0 - opt)
    return np.where(u > opt, above, below)


def daily_state(h):
    """Per day d (00:00Z): U_d, APR_d, curve params at d, from the last H read strictly before d."""
    h = h.copy()
    h["t"] = pd.to_datetime(h["hour_utc"], utc=True)
    debt = h["variable_debt_raw"].astype(float) + h["stable_debt_raw"].astype(float)
    avail = np.where(h["virtual_balance_raw"].notna(), h["virtual_balance_raw"].astype(float),
                     h["cash_balance_raw"].astype(float))
    h["U"] = debt / (avail + debt)
    h["apr"] = h["rd_variable_borrow_rate_ray"].map(lambda x: int(x) / 1e27)
    for c in ["optimal_usage_ray", "base_rate_ray", "slope1_ray", "slope2_ray"]:
        h[c[:-4]] = h[c].map(lambda x: int(x) / 1e27)
    h["day"] = h["t"].dt.floor("D") + pd.Timedelta(days=1)   # the last read on date d-1 serves day d (strictly before d 00:00Z)
    days = pd.date_range(h["day"].min(), h["day"].max(), freq="D", tz="UTC")
    last = h.sort_values("t").groupby("day").tail(1).set_index("day")
    cols = ["U", "apr", "optimal_usage", "base_rate", "slope1", "slope2", "block", "stable_debt_raw"]
    d = last[cols].reindex(days).ffill()
    return d


def har_X(rv, idx):
    """HAR regressors for row positions idx (rv array, positions need 30 lags)."""
    c = np.concatenate([[0.0], np.cumsum(rv)])
    x1 = rv[idx - 1]
    x7 = (c[idx] - c[idx - 7]) / 7.0
    x30 = (c[idx] - c[idx - 30]) / 30.0
    return np.column_stack([np.ones(len(idx)), x1, x7, x30])


def forecast_origin(dates, D, i0, curve, u0):
    """Quantiles at origin position i0 (dates[i0] = t0; D[i] is the change ending at dates[i]; D[0] is NaN)."""
    lo = max(31, i0 - TRAIN_D + 1)          # D[1..] valid, 30 lags need positions >= 31
    rows = np.arange(lo, i0 + 1)
    if len(rows) < MIN_TRAIN_ROWS:
        return None, {"abstain": True, "train_rows": int(len(rows))}
    rv = D ** 2
    rv[0] = 0.0
    X = har_X(rv, rows)
    y = rv[rows]
    beta, *_ = np.linalg.lstsq(X, y, rcond=None)
    floor = FLOOR_SHARE * float(np.mean(y))
    sig2 = np.maximum(X @ beta, floor)
    z = D[rows] / np.sqrt(sig2)
    ext = list(rv[: i0 + 1])
    fc = []
    for _ in range(HORIZON_D):
        n = len(ext)
        a = np.array(ext)
        x = np.array([1.0, a[n - 1], a[n - 7:n].mean(), a[n - 30:n].mean()])
        s = max(float(x @ beta), floor)
        fc.append(s)
        ext.append(s)
    scale = np.sqrt(np.array(fc))
    nb = len(z) - HORIZON_D + 1
    W = np.lib.stride_tricks.sliding_window_view(z, HORIZON_D)[:nb]
    S = W @ scale
    uT = expit(logit(u0) + S)
    apr = curve_apr(uT, *curve)
    q = np.quantile(apr, QS)
    return q, {"abstain": False, "train_rows": int(len(rows)), "n_paths": int(nb), "beta": beta.tolist(),
               "sig2_fc_mean": float(np.mean(fc))}


def pinball(qv, y):
    qv = np.asarray(qv, dtype=float)
    e = y - qv
    return float(np.mean(np.maximum(np.array(QS) * e, (np.array(QS) - 1.0) * e)))


# ---------------------------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------------------------
def frozen_config():
    sha, dirty = git_sha()
    if dirty:
        raise SystemExit("STOP: uncommitted code")
    hs = sha256_file(os.path.join(DATASETS, H_INPUT))
    if hs != H_SHA256:
        raise SystemExit("STOP: hourly inputs sha256 mismatch")
    c3 = {}
    for f in C3_FOLDS:
        p, b = c3_blob(f)
        c3[f] = {"commit": C3_COMMIT, "path": p, "sha256": sha256_bytes(b)}
    return {"schema": "q26-r103/frozen-config/1", "item": "Q26 R10.3 rate-curve APR challenger (vs Q33 C3)",
            "prereg": "triccs/membrane-board design/Q26_ROUND10_PREREG.md R10.3",
            "code": {"repo": "The-Membrane/membrane-app", "sha": sha,
                     "path": "scripts/research/history-forecasts/r103_curve_apr.py"},
            "inputs": {"usdc-hourly-inputs.csv.gz": {"path": H_INPUT, "sha256": hs}, "c3": c3},
            "constants": {"quantiles": QS, "horizon_days": HORIZON_D, "train_days": TRAIN_D, "har_lags": HAR_LAGS,
                          "floor_share": FLOOR_SHARE, "min_train_rows": MIN_TRAIN_ROWS,
                          "q2_excluded": ["2026-04-01", "2026-06-30"],
                          "bootstrap": {"block_days": BOOT_BLOCK, "reps": BOOT_REPS, "seed": BOOT_SEED},
                          "pass": {"gain_vs_nochange_min": GAIN_VS_NOCHANGE, "worse_vs_c3_max": MAX_WORSE_VS_C3}},
            "seeds": {"model": None, "bootstrap_reported_only": BOOT_SEED},
            "decisions": DECISIONS}


def cmd_freeze(out):
    os.makedirs(out, exist_ok=True)
    path = os.path.join(out, "frozen-r103.json")
    if os.path.exists(path):
        raise SystemExit("STOP: frozen config exists")
    h = write_json(path, frozen_config())
    with open(path + ".sha256", "w") as f:
        f.write(f"{h}  frozen-r103.json\n")
    print("frozen config", h)


def load_c3():
    rows = []
    for f in C3_FOLDS:
        _, b = c3_blob(f)
        for r in json.load(io.BytesIO(gzip.decompress(b))):
            rows.append({"fold": f, "origin": pd.Timestamp(r["origin_date"], tz="UTC"), "c3": r["C3"],
                         "r0": r["R0"][0], "outcome": float(r["outcome"]), "curve_changed": bool(r["curve_changed"])})
    return pd.DataFrame(rows).sort_values("origin").reset_index(drop=True)


def block_boot(a, b, c, seed):
    """30-day moving-block bootstrap of mean(a)/mean(b) and mean(a)/mean(c) (reported only)."""
    rng = np.random.default_rng(seed)
    n = len(a)
    nb = int(np.ceil(n / BOOT_BLOCK))
    r1, r2 = [], []
    for _ in range(BOOT_REPS):
        st = rng.integers(0, n - BOOT_BLOCK + 1, nb)
        idx = (st[:, None] + np.arange(BOOT_BLOCK)[None, :]).ravel()[:n]
        r1.append(a[idx].mean() / b[idx].mean())
        r2.append(a[idx].mean() / c[idx].mean())
    return np.percentile(r1, [2.5, 97.5]).tolist(), np.percentile(r2, [2.5, 97.5]).tolist()


def cmd_run(out):
    path = os.path.join(out, "frozen-r103.json")
    cfg = json.load(open(path))
    want = open(path + ".sha256").read().split()[0]
    if sha256_file(path) != want:
        raise SystemExit("STOP: frozen config hash")
    now = frozen_config()
    if now["code"]["sha"] != cfg["code"]["sha"] or now["inputs"] != cfg["inputs"]:
        raise SystemExit("STOP: code or inputs differ from the frozen config")
    log = [f"frozen config {want}", f"code {cfg['code']['sha']}"]

    h = pd.read_csv(os.path.join(DATASETS, H_INPUT))
    st = daily_state(h)
    if (st["stable_debt_raw"].astype(float) != 0).any():
        raise SystemExit("STOP: stable debt nonzero (R103-7 assumes 0)")
    dates = st.index
    U = st["U"].to_numpy()
    D = np.full(len(U), np.nan)
    D[1:] = np.diff(logit(U))
    pos = {t: i for i, t in enumerate(dates)}
    c3 = load_c3()
    log.append(f"days {len(dates)} {dates[0].date()}..{dates[-1].date()}; C3 origins {len(c3)}")

    recs = []
    for r in c3.itertuples():
        i0 = pos[r.origin]
        iT = pos[r.origin + pd.Timedelta(days=HORIZON_D)]
        row = st.iloc[i0]
        curve = (row["base_rate"], row["slope1"], row["slope2"], row["optimal_usage"])
        q, info = forecast_origin(dates, D.copy(), i0, curve, row["U"])
        apr0 = float(row["apr"])
        y_h = float(st.iloc[iT]["apr"])
        curve_T = tuple(st.iloc[iT][["base_rate", "slope1", "slope2", "optimal_usage"]])
        rec = {"origin": str(r.origin.date()), "fold": r.fold, "apr_t0": apr0, "u_t0": float(row["U"]),
               "y": r.outcome, "y_h": y_h, "r0_q33": r.r0, "curve_changed_q33": r.curve_changed,
               "curve_changed_h": curve_T != curve,
               "inQ2": bool((r.origin < Q2[1]) and (r.origin + pd.Timedelta(days=HORIZON_D) > Q2[0])),
               "abstain": info["abstain"], "train_rows": info["train_rows"], "n_paths": info.get("n_paths")}
        for k, qq in enumerate(QS):
            rec[f"m_q{int(qq * 100):02d}"] = None if q is None else float(q[k])
        if q is not None:
            rec["L_model"] = pinball(q, r.outcome)
            rec["L_model_h"] = pinball(q, y_h)
        rec["L_nochange"] = pinball([apr0] * 5, r.outcome)
        rec["L_nochange_h"] = pinball([apr0] * 5, y_h)
        rec["L_c3"] = pinball(r.c3, r.outcome)
        rec["L_c3_h"] = pinball(r.c3, y_h)
        rec["c3_cover90"] = bool(r.c3[0] <= r.outcome <= r.c3[4])
        rec["c3_cover50"] = bool(r.c3[1] <= r.outcome <= r.c3[3])
        recs.append(rec)
    P = pd.DataFrame(recs)
    ab = int(P["abstain"].sum())
    log.append(f"abstentions {ab}")

    def summ(g, sfx=""):
        g = g[~g["abstain"]]
        lm, ln, lc = g["L_model" + sfx].mean(), g["L_nochange" + sfx].mean(), g["L_c3" + sfx].mean()
        return {"n": int(len(g)), "L_model": lm, "L_nochange": ln, "L_c3": lc,
                "gain_vs_nochange": 1 - lm / ln, "vs_c3": lm / lc - 1}

    sc = P[~P["inQ2"]].copy()
    if ab:
        log.append("abstaining origins drop from every comparison (matched)")
    main = summ(sc)
    sel = sc[~sc["abstain"]]
    yq = sel["y"].to_numpy()
    cover90 = float(np.mean((sel["m_q05"] <= yq) & (yq <= sel["m_q95"])))
    cover50 = float(np.mean((sel["m_q25"] <= yq) & (yq <= sel["m_q75"])))
    perq = {}
    for qq in QS:
        col = f"m_q{int(qq * 100):02d}"
        e = yq - sel[col].to_numpy()
        perq[col] = float(np.mean(np.maximum(qq * e, (qq - 1) * e)))
    ci_nc, ci_c3 = block_boot(sel["L_model"].to_numpy(), sel["L_nochange"].to_numpy(), sel["L_c3"].to_numpy(), BOOT_SEED)
    passed_nc = main["gain_vs_nochange"] >= GAIN_VS_NOCHANGE
    passed_c3 = main["vs_c3"] <= MAX_WORSE_VS_C3
    res = {"schema": "q26-r103/results/1", "frozenSha256": want, "code": cfg["code"],
           "verdict": "PASS" if (passed_nc and passed_c3) else "FAIL",
           "pass_parts": {"gain_vs_nochange_ge_10pct": bool(passed_nc), "within_3pct_of_c3": bool(passed_c3)},
           "scoring": main, "abstentions": ab,
           "reported_only": {
               "coverage_model": {"q05_q95": cover90, "q25_q75": cover50},
               "coverage_c3": {"q05_q95": float(sel["c3_cover90"].mean()), "q25_q75": float(sel["c3_cover50"].mean())},
               "per_quantile_pinball_model": perq,
               "bootstrap_95ci": {"L_model_over_L_nochange": ci_nc, "L_model_over_L_c3": ci_c3,
                                  "block_days": BOOT_BLOCK, "reps": BOOT_REPS, "seed": BOOT_SEED},
               "by_fold": {f: summ(sc[sc["fold"] == f]) for f in C3_FOLDS},
               "curve_changed_q33": {"yes": summ(sc[sc["curve_changed_q33"]]), "no": summ(sc[~sc["curve_changed_q33"]])},
               "q2_2026": summ(P[P["inQ2"]]),
               "all_822": summ(P),
               "h_target": {"scoring": summ(sc, "_h"),
                            "max_abs_y_minus_y_h": float((P["y"] - P["y_h"]).abs().max()),
                            "n_abs_diff_gt_1e-9": int(((P["y"] - P["y_h"]).abs() > 1e-9).sum())},
               "input_check_max_abs_apr_t0_minus_q33_r0": float((P["apr_t0"] - P["r0_q33"]).abs().max()),
               "curve_changed_flag_agreement": float((P["curve_changed_q33"] == P["curve_changed_h"]).mean()),
           }}
    pred_cols = ["origin", "fold", "inQ2", "abstain", "train_rows", "n_paths", "apr_t0", "u_t0",
                 "m_q05", "m_q25", "m_q50", "m_q75", "m_q95", "y", "y_h", "L_model", "L_nochange", "L_c3",
                 "curve_changed_q33", "curve_changed_h"]
    csv = P[pred_cols].to_csv(index=False)
    guard(csv)
    with gzip.open(os.path.join(out, "predictions-r103.csv.gz"), "wt") as f:
        f.write(csv)
    write_json(os.path.join(out, "results-r103.json"), res)
    log.append(f"verdict {res['verdict']} gain_vs_nochange {main['gain_vs_nochange']:.4f} vs_c3 {main['vs_c3']:+.4f} "
               f"n {main['n']}")
    txt = "\n".join(log) + "\n"
    guard(txt)
    with open(os.path.join(out, "run.log"), "w") as f:
        f.write(txt)
    print(txt)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["freeze", "run"])
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    {"freeze": cmd_freeze, "run": cmd_run}[a.cmd](a.out)


if __name__ == "__main__":
    main()
