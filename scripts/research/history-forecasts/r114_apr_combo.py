"""Q26 R11.4 APR combination: Q33 C3 + the R10.3 rate-curve model, Aave V3 Core USDC 7 d variable borrow APR
(membrane-board design/Q26_ROUND11_PREREG.md R11.4 and its Deviations D-R11.4*).

  python3 r114_apr_combo.py freeze --out OUT   write and hash the frozen config (UTC timestamp) before any score
  python3 r114_apr_combo.py run    --out OUT   check the frozen config, combine walk-forward once, score, write results

Components (read only): Q33 C3 vectors (membrane-datasets 84ea4567, shrinkage run fc8bd4718e378a8d D1..D4) and the
R10.3 per-origin quantiles (history-forecasts/r10/r103-run-67e1f71f/predictions-r103.csv.gz).
  M1  quantile averaging: q_tau = (q_C3,tau + q_R103,tau) / 2. No fitting.
  M2  per tau, w_k propto exp(-eta * Lbar_k,tau); Lbar = mean pinball at tau of component k over origins j with
      t_j + 7 d in (t0 - 90 d, t0]; eta in {0, 50, 200, 1000} chosen per (origin, tau) by the lowest mean pinball at
      tau of the eta-combination over all origins j with t_j + 7 d <= t0 (each evaluated with its own as-of weights);
      < 30 origins in either set -> equal weights; ties -> the smaller eta; quantiles sorted across tau afterwards.
  E   empirical baseline: trailing-730-day empirical quantiles of the 7-day APR change (APR_d - APR_{d-7}, d <= t0,
      d in (t0 - 730 d, t0]) from the R10.1 hourly reads, added to the APR at t0. Also no-change (reported).
Pass per combiner: one-sided DM (Newey-West lag 7, HLN h = 8, Student t n-1) on per-origin pinball differences,
p < 0.025/2, against C3, R10.3 and E, on the 725 matched origins.
No Q33 quantile is written: outputs hold losses, coverage flags and M2 weights only. No address is read or written.
"""
from __future__ import annotations

import argparse
import datetime as dt
import gzip
import json
import math
import os
import sys

import numpy as np
import pandas as pd
from scipy.stats import t as student_t

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import r103_curve_apr as R  # noqa: E402

DATASETS = R.DATASETS
R103_PRED = "history-forecasts/r10/r103-run-67e1f71f/predictions-r103.csv.gz"
R103_PRED_SHA256 = "4b94e799dbf0534834e8dda5a98827f8550bb77b3a8ae32c2433484b1dca3abd"   # R10.3 PROVENANCE
R103_CODE_SHA = "67e1f71f49ac451546b723abdb4c3d5fc1c1c030"

QS = R.QS
QCOLS = ["q05", "q25", "q50", "q75", "q95"]
HORIZON_D = 7
ETAS = [0.0, 50.0, 200.0, 1000.0]
WEIGHT_WINDOW_D = 90
MIN_RESOLVED = 30
EMP_TRAIN_D = 730
EMP_MIN_ROWS = 365
NW_LAG = 7
ALPHA = 0.025 / 2
COMBINERS = ["M1", "M2"]
COMPARATORS = ["C3", "R103", "EMP"]

DECISIONS = {
    "R114-1": "Matched origins: the 725 R10.3 scoring origins (C3 origins 2024-07-01..2026-09-30 minus windows "
              "[t0, t0 + 7 d) meeting 2026-04-01..2026-06-30). The 97 2026Q2 origins are reported only.",
    "R114-2": "Target: Q33's published outcome at each origin for every forecast (R10.3 convention). R10.3's 'y' must "
              "equal it at every origin (input check, STOP otherwise).",
    "R114-3": "Pinball per origin = mean over q05 q25 q50 q75 q95 of max(tau e, (tau - 1) e), e = y - q; per-tau "
              "pinball is that term alone (Q33 / R10.3 convention).",
    "R114-4": "M1: per tau the mean of the C3 and R10.3 quantiles. Monotone by construction.",
    "R114-5": "M2 weight window: origins j with t_j + 7 d <= t0 and t_j + 7 d > t0 - 90 d (resolved in the trailing "
              "90 days, at most 90 origins). Lbar_k,tau = mean per-tau pinball of component k there. "
              "w_k = exp(-eta (Lbar_k - min_k Lbar_k)) normalised.",
    "R114-6": "M2 eta selection: per (origin, tau), over all origins j with t_j + 7 d <= t0 (expanding from the first "
              "C3 origin 2024-07-01), the eta in {0, 50, 200, 1000} with the lowest mean per-tau pinball of the "
              "eta-combination, each j combined with its own as-of weights. Ties -> the smaller eta.",
    "R114-7": "M2 equal weights (eta = 0) when the weight window or the selection set has < 30 origins.",
    "R114-8": "M2 learning pool: all 822 C3 origins, 2026Q2 included as training (R103-14 analogue); 2026Q2 origins "
              "are never scored.",
    "R114-9": "M2 quantiles are sorted across tau after combination (rearrangement); the count of origins that needed "
              "it is reported.",
    "R114-10": "Empirical baseline E: daily APR_d = borrow APR at the last R10.1 H read strictly before d 00:00Z "
               "(R10.3 daily state). Changes APR_d - APR_{d-7} for d <= t0, d in (t0 - 730 d, t0], both ends inside "
               "the data (all overlapping, equal weight); numpy linear quantiles added to APR_t0. < 365 changes -> "
               "abstain (counted; matched removal).",
    "R114-11": "No-change (every quantile = APR_t0) is reported only.",
    "R114-12": "DM per (combiner, comparator): d_i = L_combiner,i - L_comparator,i over the 725 origins in date "
               "order; Newey-West Bartlett long-run variance lag 7; HLN factor with h = 8; one-sided p = "
               "t_cdf(DM_HLN, n - 1). Pass per combiner: p < 0.0125 against all three of C3, R10.3, E.",
    "R114-13": "No Q33 quantile is published. M1 and M2 quantiles are withheld too, because with the public R10.3 "
               "quantiles they would reveal C3. Published: per-origin losses (overall and per tau), coverage flags, "
               "E quantiles, M2 eta and weights.",
    "R114-14": "One fit: the walk-forward rule runs once over the 822 origins; nothing is retuned after a score.",
}

FORWARD_PLAN = {
    "what": "Forward confirmation of any combiner that passes, per R11.4 and R11.3c; reported as a separate item.",
    "origins": "Every daily origin t0 >= 2026-10-01 for which Q33 publishes a C3 aave-core-usdc-borrow-7 vector after "
               "this config's created_utc (the publication commit time must follow it). Origins up to 2026-09-30 are "
               "the development set and never enter the forward test.",
    "components": "C3 = Q33's published vector, read only. R10.3 = recomputed with the frozen R10.3 code "
                  f"({R103_CODE_SHA}, r103_curve_apr.forecast_origin, unchanged constants) on R10.1-style hourly reads "
                  "extended past 2026-10-13 by the frozen R10.1 acquisition code; no retune.",
    "combiner": "The frozen rule of this config (M1 unchanged; M2 continues its walk-forward rule with the same eta "
                "grid, windows and minimums, its pool extended with resolved forward origins).",
    "target": "Q33's published outcome (else the H-derived APR at the last read strictly before t0 + 7 d, flagged).",
    "test": "R11.3c e-process on daily pinball differences d_t = L_better_t - L_comb_t, where better_t is the "
            "component (C3 or R10.3) with the lower mean pinball over forward origins resolved before t0 (C3 until "
            "the first resolution). Betting martingale K = prod(1 + lambda_t x_t), lambda_t in [0, 1/2] by aGRAPA on "
            "x values resolved before t0. x_t = d_t / c_t with the predictable bound c_t = 0.95 * mean_tau "
            "|q_comb,tau - q_better,tau| (>= |d_t| by the 0.95-Lipschitz pinball; known at issue; x_t = 0 when "
            "c_t = 0), so x_t is in [-1, 1] and the null E[d_t | past] <= 0 is unchanged.",
    "overlap": "7-day horizon: 7 interleaved subsequences (origin date mod 7); the statistic is the mean of the 7 "
               "e-processes.",
    "alpha": "0.025 / 2 per passing combiner (Bonferroni over M1, M2; not redistributed if one failed history).",
    "pass": "K >= 1 / alpha (= 80) at any scorer run. Stop with 'not shown' after 730 forward origins.",
}


# ---------------------------------------------------------------------------------------------
def utcnow():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def pin_tau(q, y, tau):
    e = y - q
    return np.maximum(tau * e, (tau - 1.0) * e)


def pin_mat(Q, y):
    """Q: n x 5 quantiles, y: n -> n x 5 per-tau pinball."""
    taus = np.array(QS)[None, :]
    e = y[:, None] - Q
    return np.maximum(taus * e, (taus - 1.0) * e)


def nw_lrv(e, L):
    n = len(e)
    v = float(e @ e) / n
    for k in range(1, min(L, n - 1) + 1):
        v += 2.0 * (1.0 - k / (L + 1.0)) * float(e[k:] @ e[:-k]) / n
    return v


def dm_one_sided(d, L=NW_LAG):
    """H1: mean(d) < 0 (the combiner has lower loss). NW Bartlett lag L, HLN h = L + 1, Student t n - 1."""
    d = np.asarray(d, float)
    n = len(d)
    dbar = float(d.mean())
    lrv = nw_lrv(d - dbar, L)
    if not lrv > 0:
        return {"n": n, "mean_diff": dbar, "dm": None, "dm_hln": None, "p_one_sided": None}
    dm = dbar / math.sqrt(lrv / n)
    h = L + 1
    fac2 = (n + 1 - 2 * h + h * (h - 1) / n) / n
    hln = dm * math.sqrt(fac2)
    return {"n": n, "lag": L, "hln_h": h, "mean_diff": dbar, "dm": dm, "dm_hln": hln,
            "p_one_sided": float(student_t.cdf(hln, n - 1))}


def m2_walk_forward(dates, Qa, Qb, y):
    """M2 over origins in date order. Qa, Qb: n x 5 component quantiles; y: n outcomes.
    Returns quantiles (n x 5, sorted), eta (n x 5), weight on component a (n x 5), crossing flags (n)."""
    n = len(dates)
    day = ((dates - dates[0]) / pd.Timedelta(days=1)).astype(int).to_numpy() if hasattr(dates, "to_numpy") else \
        np.asarray(dates, int)
    La = pin_mat(Qa, y)
    Lb = pin_mat(Qb, y)
    ne = len(ETAS)
    # combination per eta at every origin (as-of weights), filled in date order
    comb_loss = np.full((ne, n, 5), np.nan)
    Wa = np.full((ne, n, 5), 0.5)
    out_q = np.zeros((n, 5))
    out_eta = np.zeros((n, 5))
    out_wa = np.full((n, 5), 0.5)
    cross = np.zeros(n, bool)
    taus = np.array(QS)
    for i in range(n):
        res = day + HORIZON_D <= day[i]                       # resolved by t0
        win = res & (day + HORIZON_D > day[i] - WEIGHT_WINDOW_D)
        if win.sum() >= MIN_RESOLVED:
            la, lb = La[win].mean(0), Lb[win].mean(0)
            m = np.minimum(la, lb)
            for k, eta in enumerate(ETAS):
                ea, eb = np.exp(-eta * (la - m)), np.exp(-eta * (lb - m))
                Wa[k, i] = ea / (ea + eb)
        for k in range(ne):
            qc = Wa[k, i] * Qa[i] + (1 - Wa[k, i]) * Qb[i]
            comb_loss[k, i] = pin_tau(qc, y[i], taus)
        if res.sum() >= MIN_RESOLVED and win.sum() >= MIN_RESOLVED:
            sel = comb_loss[:, res, :].mean(1)                 # ne x 5
            kbest = np.argmin(sel, axis=0)                      # first minimum -> smaller eta on ties
        else:
            kbest = np.zeros(5, int)
        wa = Wa[kbest, i, np.arange(5)]
        q = wa * Qa[i] + (1 - wa) * Qb[i]
        if np.any(np.diff(q) < 0):
            cross[i] = True
            q = np.sort(q)
        out_q[i], out_eta[i], out_wa[i] = q, np.array(ETAS)[kbest], wa
    return out_q, out_eta, out_wa, cross


def empirical_quantiles(st, t0):
    apr = st["apr"]
    lo = t0 - pd.Timedelta(days=EMP_TRAIN_D)
    s = apr[(apr.index > lo - pd.Timedelta(days=HORIZON_D)) & (apr.index <= t0)]
    ch = (s - s.shift(HORIZON_D, freq="D")).dropna()
    ch = ch[(ch.index > lo) & (ch.index <= t0)]
    if len(ch) < EMP_MIN_ROWS:
        return None, len(ch)
    return float(apr.loc[t0]) + np.quantile(ch.to_numpy(), QS), len(ch)


# ---------------------------------------------------------------------------------------------
def frozen_config():
    sha, dirty = R.git_sha()
    if dirty:
        raise SystemExit("STOP: uncommitted code")
    hs = R.sha256_file(os.path.join(DATASETS, R.H_INPUT))
    if hs != R.H_SHA256:
        raise SystemExit("STOP: hourly inputs sha256 mismatch")
    ps = R.sha256_file(os.path.join(DATASETS, R103_PRED))
    if ps != R103_PRED_SHA256:
        raise SystemExit("STOP: R10.3 predictions sha256 mismatch")
    c3 = {}
    for f in R.C3_FOLDS:
        p, b = R.c3_blob(f)
        c3[f] = {"commit": R.C3_COMMIT, "path": p, "sha256": R.sha256_bytes(b)}
    return {"schema": "q26-r114/frozen-config/1",
            "item": "Q26 R11.4 APR combination (Q33 C3 + R10.3), Aave Core USDC 7 d borrow APR",
            "prereg": "triccs/membrane-board design/Q26_ROUND11_PREREG.md R11.4 (+ D-R11.4a)",
            "code": {"repo": "The-Membrane/membrane-app", "sha": sha,
                     "path": "scripts/research/history-forecasts/r114_apr_combo.py"},
            "inputs": {"usdc-hourly-inputs.csv.gz": {"path": R.H_INPUT, "sha256": hs},
                       "predictions-r103.csv.gz": {"path": R103_PRED, "sha256": ps, "r103_code": R103_CODE_SHA},
                       "c3": c3},
            "constants": {"quantiles": QS, "horizon_days": HORIZON_D, "etas": ETAS,
                          "weight_window_days": WEIGHT_WINDOW_D, "min_resolved": MIN_RESOLVED,
                          "emp_train_days": EMP_TRAIN_D, "emp_min_rows": EMP_MIN_ROWS, "nw_lag": NW_LAG,
                          "hln_h": NW_LAG + 1, "alpha_per_test": ALPHA,
                          "q2_excluded": ["2026-04-01", "2026-06-30"], "n_matched_expected": 725},
            "seeds": {"model": None},
            "decisions": DECISIONS, "forward_plan": FORWARD_PLAN}


def cmd_freeze(out):
    os.makedirs(out, exist_ok=True)
    path = os.path.join(out, "frozen-r114.json")
    if os.path.exists(path):
        raise SystemExit("STOP: frozen config exists")
    cfg = frozen_config()
    cfg["created_utc"] = utcnow()
    h = R.write_json(path, cfg)
    with open(path + ".sha256", "w") as f:
        f.write(f"{h}  frozen-r114.json\n")
    print("frozen config", h, cfg["created_utc"])


def summarise(P, names):
    o = {"n": int(len(P))}
    for k in names:
        o["L_" + k] = float(P["L_" + k].mean())
    return o


def cmd_run(out):
    path = os.path.join(out, "frozen-r114.json")
    cfg = json.load(open(path))
    want = open(path + ".sha256").read().split()[0]
    if R.sha256_file(path) != want:
        raise SystemExit("STOP: frozen config hash")
    now = frozen_config()
    if now["code"]["sha"] != cfg["code"]["sha"] or now["inputs"] != cfg["inputs"]:
        raise SystemExit("STOP: code or inputs differ from the frozen config")
    log = [f"frozen config {want} created {cfg['created_utc']}", f"code {cfg['code']['sha']}", f"run start {utcnow()}"]

    c3 = R.load_c3()
    r3 = pd.read_csv(os.path.join(DATASETS, R103_PRED))
    r3["origin"] = pd.to_datetime(r3["origin"], utc=True)
    P = c3.merge(r3, on="origin", how="inner", suffixes=("", "_r3"))
    if len(P) != len(c3) or len(P) != 822 or P["abstain"].any():
        raise SystemExit("STOP: R10.3 / C3 origin mismatch")
    if (P["y"] - P["outcome"]).abs().max() > 1e-12:
        raise SystemExit("STOP: R10.3 target differs from Q33 outcome")
    P = P.sort_values("origin").reset_index(drop=True)
    dates = pd.DatetimeIndex(P["origin"])
    if not (np.diff(dates.asi8) == 86400 * 10**9).all():
        raise SystemExit("STOP: C3 origins are not consecutive days")
    y = P["outcome"].to_numpy()
    Qc = np.array(P["c3"].tolist(), float)
    Qr = P[["m_q05", "m_q25", "m_q50", "m_q75", "m_q95"]].to_numpy(float)
    if np.any(np.diff(Qc, axis=1) < 0) or np.any(np.diff(Qr, axis=1) < 0):
        log.append("note: a component has crossing quantiles (used as published)")
    # sanity: recomputed component losses equal the published R10.3 columns
    if np.abs(pin_mat(Qr, y).mean(1) - P["L_model"].to_numpy()).max() > 1e-12 or \
            np.abs(pin_mat(Qc, y).mean(1) - P["L_c3"].to_numpy()).max() > 1e-12:
        raise SystemExit("STOP: component losses do not reproduce R10.3 columns")

    Q = {"C3": Qc, "R103": Qr, "M1": 0.5 * (Qc + Qr)}
    q2, eta2, wa2, cross2 = m2_walk_forward(dates, Qc, Qr, y)
    Q["M2"] = q2
    st = R.daily_state(pd.read_csv(os.path.join(DATASETS, R.H_INPUT)))
    emp, nrows = [], []
    for t0 in dates:
        q, nr = empirical_quantiles(st, t0)
        emp.append(q if q is not None else [np.nan] * 5)
        nrows.append(nr)
    Q["EMP"] = np.array(emp, float)
    emp_abst = np.isnan(Q["EMP"]).any(1)
    apr0 = st["apr"].reindex(dates).to_numpy(float)
    if np.abs(apr0 - P["r0"].to_numpy()).max() > 1e-12:
        raise SystemExit("STOP: APR_t0 differs from Q33 R0")
    Q["NC"] = np.repeat(apr0[:, None], 5, axis=1)
    names = ["M1", "M2", "C3", "R103", "EMP", "NC"]
    for k in names:
        Lt = pin_mat(Q[k], y)
        P["L_" + k] = Lt.mean(1)
        for j, c in enumerate(QCOLS):
            P[f"L_{k}_{c}"] = Lt[:, j]
        P[f"cov90_{k}"] = (Q[k][:, 0] <= y) & (y <= Q[k][:, 4])
        P[f"cov50_{k}"] = (Q[k][:, 1] <= y) & (y <= Q[k][:, 3])
    P["emp_abstain"] = emp_abst
    P["emp_rows"] = nrows
    for j, c in enumerate(QCOLS):
        P[f"m2_eta_{c}"] = eta2[:, j]
        P[f"m2_w_c3_{c}"] = wa2[:, j]
        P[f"emp_{c}"] = Q["EMP"][:, j]
    P["m2_sorted"] = cross2
    log.append(f"origins {len(P)}; E abstentions {int(emp_abst.sum())}; M2 sorted {int(cross2.sum())}")

    sc = P[~P["inQ2"] & ~P["emp_abstain"]].copy()
    if len(sc) != 725:
        log.append(f"WARNING matched origins {len(sc)} != 725")
    tests, verdict = {}, {}
    for m in COMBINERS:
        tests[m] = {}
        ok = True
        for c in COMPARATORS:
            r = dm_one_sided((sc["L_" + m] - sc["L_" + c]).to_numpy())
            r["ratio"] = float(sc["L_" + m].mean() / sc["L_" + c].mean())
            r["pass"] = bool(r["p_one_sided"] is not None and r["p_one_sided"] < ALPHA and r["mean_diff"] < 0)
            tests[m][c] = r
            ok = ok and r["pass"]
        verdict[m] = "PASS" if ok else "FAIL"

    def block(g):
        s = summarise(g, names)
        s["ratio_vs"] = {m: {c: float(g["L_" + m].mean() / g["L_" + c].mean()) for c in COMPARATORS + ["NC"]}
                         for m in COMBINERS}
        return s

    rep = {
        "by_fold": {f: block(sc[sc["fold"] == f]) for f in R.C3_FOLDS},
        "per_quantile": {k: {c: float(sc[f"L_{k}_{c}"].mean()) for c in QCOLS} for k in names},
        "coverage": {k: {"q05_q95": float(sc[f"cov90_{k}"].mean()), "q25_q75": float(sc[f"cov50_{k}"].mean())}
                     for k in names},
        "curve_changed_q33": {"yes": block(sc[sc["curve_changed"]]), "no": block(sc[~sc["curve_changed"]])},
        "q2_2026": block(P[P["inQ2"] & ~P["emp_abstain"]]),
        "all_822": block(P[~P["emp_abstain"]]),
        "dm_vs_nochange": {m: dm_one_sided((sc["L_" + m] - sc["L_NC"]).to_numpy()) for m in COMBINERS},
        "m2": {"eta_share": {c: {str(e): float((sc[f"m2_eta_{c}"] == e).mean()) for e in ETAS} for c in QCOLS},
               "mean_w_c3": {c: float(sc[f"m2_w_c3_{c}"].mean()) for c in QCOLS},
               "mean_w_c3_by_fold": {f: {c: float(sc.loc[sc["fold"] == f, f"m2_w_c3_{c}"].mean()) for c in QCOLS}
                                     for f in R.C3_FOLDS},
               "equal_weight_origins_scored": int((sc[[f"m2_eta_{c}" for c in QCOLS]] == 0).all(1).sum()),
               "sorted_origins_scored": int(sc["m2_sorted"].sum())},
    }
    res = {"schema": "q26-r114/results/1", "frozenSha256": want, "frozen_created_utc": cfg["created_utc"],
           "code": cfg["code"], "verdict": verdict, "alpha_per_test": ALPHA,
           "scoring": block(sc), "tests": tests, "reported_only": rep}

    pub = ["origin", "fold", "inQ2", "curve_changed", "emp_abstain", "emp_rows", "m2_sorted"]
    pub += [f"L_{k}" for k in names] + [f"L_{k}_{c}" for k in names for c in QCOLS]
    pub += [f"cov90_{k}" for k in names] + [f"cov50_{k}" for k in names]
    pub += [f"emp_{c}" for c in QCOLS] + [f"m2_eta_{c}" for c in QCOLS] + [f"m2_w_c3_{c}" for c in QCOLS]
    O = P[pub].copy()
    O["origin"] = O["origin"].dt.strftime("%Y-%m-%d")
    csv = O.to_csv(index=False)
    R.guard(csv)
    with gzip.open(os.path.join(out, "predictions-r114.csv.gz"), "wt") as f:
        f.write(csv)
    R.write_json(os.path.join(out, "results-r114.json"), res)
    for m in COMBINERS:
        t = tests[m]
        log.append(f"{m} {verdict[m]} L {res['scoring']['L_' + m]:.7f} | " + " ".join(
            f"{c} ratio {t[c]['ratio']:.4f} p {t[c]['p_one_sided']:.4g}" for c in COMPARATORS))
    log.append(f"run end {utcnow()}")
    txt = "\n".join(log) + "\n"
    R.guard(txt)
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
