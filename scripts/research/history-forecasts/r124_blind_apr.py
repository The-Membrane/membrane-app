"""Q26 R12.4 APR blind test on B11 (membrane-board design/Q26_ROUND12_PREREG.md D-R12.4a and its Deviations).

  python3 r124_blind_apr.py freeze --inputs DIR --out OUT   write and hash frozen-r124.json (UTC time) before any score
  python3 r124_blind_apr.py run    --inputs DIR --out OUT   check the freeze, forecast, score once, write results

Hypothesis: M2 used everywhere off Core beats C3, the 730-day empirical baseline E and the 90-day empirical baseline E90
on the 7 d variable borrow APR (q05 q25 q50 q75 q95). Mechanism check: under-600-trajectory C3 banks, M2 beats C3.
Components (all frozen, unchanged; as R11.8, imported from r118_blind_apr):
  C3   Q33 kernel.py + curve_coordinate.py at datasets 84ea4567, per reserve
  R10.3 r103_curve_apr (67e1f71f)        E    r114 empirical_quantiles (730 d, >= 365 changes)
  E90  the same construction, 90 d window, >= 60 changes       M2   r114 m2_walk_forward (b6be18c7), per reserve
Primary test: cross-market EWC HAC t on weekly means (Driscoll-Kraay form), one-sided, alpha 0.025 / 3 per comparator.
No C3 or M2 quantile and no per-quantile C3 or M2 loss is written. No address is read or written.
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

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import r103_curve_apr as R  # noqa: E402
import r114_apr_combo as C  # noqa: E402
import r118_blind_apr as B  # noqa: E402

DATASETS = R.DATASETS
QS = R.QS
HORIZON_D = 7
MIN_DEBT_TOKENS = 1_000_000
Q2 = B.Q2
WEEK_ANCHOR = B.WEEK_ANCHOR
MIN_WEEK_ORIGINS = 4
MIN_WEEKS_EVALUABLE = 26
BANK_THRESHOLD = 600
E90_TRAIN_D, E90_MIN_ROWS = 90, 60
CONFIRMATORY = ["C3", "EMP", "E90"]
ALPHA = 0.025 / len(CONFIRMATORY)
ALPHA_CUT = 0.025
NI_MARGIN = 1.05
REPORTED = ["R103", "NC"]
CODE_PINS = {"r103": "67e1f71f49ac451546b723abdb4c3d5fc1c1c030", "r114": "b6be18c7", "r118": "9ab156bb"}

DECISIONS = {
    "R124-1": "Markets: the B11 reserves of D-R12.3a R12.3-1 that pass the three latest-block checks (r124_acquire meta). "
              "Daily read at b_d (last block with ts < d 00:00Z), r118_acquire.read_day unchanged.",
    "R124-2": "Target y(t0) = stored variable borrow rate / 1e27 at b_{t0+7}; that read must exist.",
    "R124-3": "C3 exactly R118-3 (r118_blind_apr.c3_forecasts). Bank size b(t0) = n_trajectories of the C3 bank of the "
              "half-year fold containing t0 (fixed at the fold start).",
    "R124-4": "R10.3 exactly R118-4 with readings-r124.json r103_start.",
    "R124-5": "E = r114 empirical_quantiles unchanged (730 d, >= 365 changes). E90 = the same construction with a 90-day "
              "window and >= 60 changes, else abstain (parent rule after the R11.11 review).",
    "R124-6": "M2 = r114 m2_walk_forward unchanged per reserve over the pool of origins with C3, R10.3 and y.",
    "R124-7": "Scorable: C3, R10.3, E, E90, M2 finite; y exists; total debt at b_t0 >= 1,000,000 tokens (reserve "
              "decimals, stables at $1); window [t0, t0 + 7 d) does not meet 2026-04-01..2026-06-30. Matched removal.",
    "R124-8": "Pinball: mean over 5 quantiles per origin (D-R11.4a). d = L_M2 - L_comparator.",
    "R124-9": "EWC: weekly means (Sun..Sat UTC, >= 4 scorable days), nu = max(2, floor(0.4 n^(2/3))) cosine terms, "
              "t = mean / sqrt(Omega / n), one-sided p = t_cdf(t, nu). Cross-market: per day the equal-weight mean of d "
              "over evaluable reserves scorable that day.",
    "R124-10": "R12.4 PASS: cross-market EWC mean d < 0 and p < 0.025/3 against each of C3, E and E90 (Bonferroni over "
               "the three confirmatory comparators).",
    "R124-11": "Mechanism check: origins with b(t0) < 600, cross-market EWC of L_M2 - L_C3, p < 0.025 and mean < 0. "
               "Reported beside it: b(t0) >= 600, M2 vs C3 and the C3 non-inferiority d = L_C3 - 1.05 L_M2.",
    "R124-12": "Evaluable reserve: >= 26 retained weeks of scorable origins, counted before any loss.",
    "R124-13": "Reported only: R10.3 and no-change comparators, nu sensitivity (4, 8, floor(0.2 n^(2/3)), "
               "floor(0.8 n^(2/3)), 24), reserve-clustered t, per reserve, per year (all comparators), cut x year, "
               "coverage, 2026Q2, low-debt origins.",
    "R124-14": "Publication: per-origin mean losses, coverage flags, bank size, M2 eta and weights; per-quantile losses "
               "for R10.3, E, E90 and no-change only; no C3 or M2 quantile; no y. One run; nothing retuned.",
}


def utcnow():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def empirical_short(st, t0):
    """E90: r114 empirical_quantiles with a 90-day window and >= 60 changes."""
    apr = st["apr"]
    lo = t0 - pd.Timedelta(days=E90_TRAIN_D)
    s = apr[(apr.index > lo - pd.Timedelta(days=HORIZON_D)) & (apr.index <= t0)]
    ch = (s - s.shift(HORIZON_D, freq="D")).dropna()
    ch = ch[(ch.index > lo) & (ch.index <= t0)]
    if len(ch) < E90_MIN_ROWS:
        return None, len(ch)
    return float(apr.loc[t0]) + np.quantile(ch.to_numpy(), QS), len(ch)


def bank_of(folds, day):
    """n_trajectories of the fold containing day (folds: list of {start, n_trajectories}, ascending)."""
    b = None
    for f in folds:
        if f["start"] <= day:
            b = f["n_trajectories"]
    return b


def ewc_nu(w, nu):
    w = np.asarray(w, float)
    n = len(w)
    if n < 3 or nu < 1:
        return None
    x = w - w.mean()
    tt = np.arange(1, n + 1)
    lam = [(math.sqrt(2.0 / n) * float(np.cos(math.pi * j * (tt - 0.5) / n) @ x)) ** 2 for j in range(1, nu + 1)]
    om = float(np.mean(lam))
    if not om > 0:
        return None
    t = float(w.mean()) / math.sqrt(om / n)
    return {"nu": nu, "t": t, "p": float(student_t.cdf(t, nu))}


def nu_grid(n):
    return sorted({4, 8, max(2, int(math.floor(0.2 * n ** (2 / 3)))), max(2, int(math.floor(0.8 * n ** (2 / 3)))), 24})


def cross_market(S, dcol):
    daily = S.groupby("origin")[dcol].mean().sort_index()
    wm, dropped = B.weekly_means(daily.index, daily.to_numpy())
    r = B.ewc_test(wm)
    r["weeks_dropped"] = dropped
    r["nu_sensitivity"] = [ewc_nu(wm, nu) for nu in nu_grid(len(wm))]
    return r


# ---------------------------------------------------------------------------------------------
def load_inputs(inputs):
    info = json.load(open(os.path.join(inputs, "reserves-r124.json")))
    return info, sorted(info)


def input_hashes(inputs):
    _, markets = load_inputs(inputs)
    out = {f"daily-{m}.csv.gz": R.sha256_file(os.path.join(inputs, f"daily-{m}.csv.gz")) for m in markets}
    for name in ("acquire-counts.json", "reserves-r124.json", "readings-r124.json"):
        out[name] = R.sha256_file(os.path.join(inputs, name))
    return out


def frozen_config(inputs):
    sha, dirty = R.git_sha()
    if dirty:
        raise SystemExit("STOP: uncommitted code")
    _, _, q33 = B.load_q33()
    info, markets = load_inputs(inputs)
    return {"schema": "q26-r124/frozen-config/1", "item": "Q26 R12.4 APR blind test on B11 (M2 everywhere off Core)",
            "prereg": "triccs/membrane-board design/Q26_ROUND12_PREREG.md D-R12.4a (+ Deviations)",
            "code": {"repo": "The-Membrane/membrane-app", "sha": sha,
                     "path": "scripts/research/history-forecasts/r124_blind_apr.py", "pins": CODE_PINS},
            "q33_code": {"commit": B.Q33_COMMIT, "files": B.Q33_FILES, "sha256": q33},
            "inputs": {"dir": os.path.relpath(os.path.abspath(inputs), os.path.abspath(DATASETS)),
                       "sha256": input_hashes(inputs)},
            "readings": json.load(open(os.path.join(inputs, "readings-r124.json"))),
            "reserves": info,
            "constants": {"markets": markets, "quantiles": QS, "horizon_days": HORIZON_D,
                          "min_debt_tokens": MIN_DEBT_TOKENS, "q2_excluded": ["2026-04-01", "2026-06-30"],
                          "week_anchor_sunday": str(WEEK_ANCHOR.date()), "min_week_origins": MIN_WEEK_ORIGINS,
                          "min_weeks_evaluable": MIN_WEEKS_EVALUABLE, "bank_threshold": BANK_THRESHOLD,
                          "confirmatory": CONFIRMATORY, "alpha": ALPHA, "alpha_cut": ALPHA_CUT,
                          "ni_margin": NI_MARGIN, "e90": [E90_TRAIN_D, E90_MIN_ROWS],
                          "m2": {"etas": C.ETAS, "window_d": C.WEIGHT_WINDOW_D, "min_resolved": C.MIN_RESOLVED},
                          "emp": {"train_d": C.EMP_TRAIN_D, "min_rows": C.EMP_MIN_ROWS}},
            "seeds": {"model": None}, "decisions": DECISIONS}


def cmd_freeze(inputs, out):
    os.makedirs(out, exist_ok=True)
    path = os.path.join(out, "frozen-r124.json")
    if os.path.exists(path):
        raise SystemExit("STOP: frozen config exists")
    cfg = frozen_config(inputs)
    cfg["created_utc"] = utcnow()
    h = R.write_json(path, cfg)
    with open(path + ".sha256", "w") as f:
        f.write(f"{h}  frozen-r124.json\n")
    print("frozen config", h, cfg["created_utc"])


# ---------------------------------------------------------------------------------------------
def build_market(m, inputs, kernel, coord, rd, dec):
    D = pd.read_csv(os.path.join(inputs, f"daily-{m}.csv.gz"), dtype=str)
    D["block_ts"] = D["block_ts"].astype(int)
    D = D.sort_values("date").reset_index(drop=True)
    rate = {r.date: int(r.rate_ray) / 1e27 for r in D.itertuples()}
    have_curve = D["optimal_usage_ray"].notna() & (D["optimal_usage_ray"] != "None")
    D = D[have_curve].reset_index(drop=True)
    debt = {r.date: (float(r.variable_debt_raw) + float(r.stable_debt_raw if r.stable_debt_raw != "None" else 0))
            / 10 ** dec for r in D.itertuples()}
    st = R.daily_state(B.h_frame(D))
    rq = B.r103_forecasts(st, pd.Timestamp(rd["r103_start"][m], tz="UTC"))
    cq, cinfo = B.c3_forecasts(D, kernel, coord)
    recs = []
    for k in D["date"]:
        t0 = pd.Timestamp(k, tz="UTC")
        tgt = (t0 + pd.Timedelta(days=HORIZON_D)).strftime("%Y-%m-%d")
        c = cq.get(k, (None, "no_fold"))
        q, _ = C.empirical_quantiles(st, t0)
        q90, _ = empirical_short(st, t0)
        recs.append({"market": m, "origin": t0, "y": rate.get(tgt), "apr_t0": rate[k], "debt_t0": debt[k],
                     "c3": c[0], "c3_reason": c[1], "r103": rq.get(t0), "bank": bank_of(cinfo["folds"], k),
                     "emp": None if q is None else np.asarray(q, float),
                     "e90": None if q90 is None else np.asarray(q90, float)})
    P = pd.DataFrame(recs)
    pool = P[P["c3"].notna() & P["r103"].notna() & P["y"].notna()].sort_values("origin").reset_index(drop=True)
    info = {"days": int(len(D)), "c3": cinfo, "c3_available": int(P["c3"].notna().sum()),
            "r103_available": int(P["r103"].notna().sum()), "emp_available": int(P["emp"].notna().sum()),
            "e90_available": int(P["e90"].notna().sum()), "pool": int(len(pool)),
            "c3_abstain_reasons": P.loc[P["c3"].isna(), "c3_reason"].value_counts().to_dict()}
    if len(pool) == 0:
        return pool, info
    dates = pd.DatetimeIndex(pool["origin"])
    Qc = np.array(pool["c3"].tolist(), float)
    Qr = np.array([np.asarray(x) for x in pool["r103"]], float)
    y = pool["y"].to_numpy(float)
    q2, eta2, wa2, cross2 = C.m2_walk_forward(dates, Qc, Qr, y)
    nan5 = [np.nan] * 5
    Q = {"C3": Qc, "R103": Qr, "M2": q2,
         "EMP": np.array([x if x is not None else nan5 for x in pool["emp"]], float),
         "E90": np.array([x if x is not None else nan5 for x in pool["e90"]], float),
         "NC": np.repeat(pool["apr_t0"].to_numpy(float)[:, None], 5, axis=1)}
    for k, q in Q.items():
        Lt = C.pin_mat(q, y)
        pool["L_" + k] = Lt.mean(1)
        if k not in ("C3", "M2"):
            for j, cc in enumerate(C.QCOLS):
                pool[f"L_{k}_{cc}"] = Lt[:, j]
        pool[f"cov90_{k}"] = (q[:, 0] <= y) & (y <= q[:, 4])
        pool[f"cov50_{k}"] = (q[:, 1] <= y) & (y <= q[:, 3])
    for j, cc in enumerate(C.QCOLS):
        pool[f"m2_eta_{cc}"] = eta2[:, j]
        pool[f"m2_w_c3_{cc}"] = wa2[:, j]
    pool["m2_sorted"] = cross2
    pool["young"] = pool["bank"] < BANK_THRESHOLD
    pool["inQ2"] = (pool["origin"] < Q2[1]) & (pool["origin"] + pd.Timedelta(days=HORIZON_D) > Q2[0])
    pool["low_debt"] = pool["debt_t0"] < MIN_DEBT_TOKENS
    pool["emp_ok"] = np.isfinite(Q["EMP"]).all(1) & np.isfinite(Q["E90"]).all(1)
    pool["scorable"] = pool["emp_ok"] & ~pool["inQ2"] & ~pool["low_debt"]
    return pool, info


def block(g, names):
    if len(g) == 0:
        return {"n": 0}
    o = {"n": int(len(g)), **{"L_" + k: float(g["L_" + k].mean()) for k in names}}
    o["ratio_M2_to"] = {k: float(g["L_M2"].mean() / g["L_" + k].mean()) for k in names}
    return o


def cmd_run(inputs, out):
    path = os.path.join(out, "frozen-r124.json")
    cfg = json.load(open(path))
    want = open(path + ".sha256").read().split()[0]
    if R.sha256_file(path) != want:
        raise SystemExit("STOP: frozen config hash")
    if os.path.exists(os.path.join(out, "run.log")) or os.path.exists(os.path.join(out, "run-started.json")):
        raise SystemExit("STOP: a run already started (one run only)")
    now = frozen_config(inputs)
    for k in ("code", "q33_code", "inputs", "readings", "reserves", "constants", "decisions"):
        if now[k] != cfg[k]:
            raise SystemExit(f"STOP: {k} differs from the frozen config")
    start = utcnow()
    R.write_json(os.path.join(out, "run-started.json"), {"frozenSha256": want, "start_utc": start})
    log = [f"frozen config {want} created {cfg['created_utc']}", f"code {cfg['code']['sha']}", f"run start {start}"]
    kernel, coord, _ = B.load_q33()
    rd, info_all = cfg["readings"], cfg["reserves"]
    markets = cfg["constants"]["markets"]
    pools, infos = {}, {}
    for m in markets:
        pools[m], infos[m] = build_market(m, inputs, kernel, coord, rd, int(info_all[m]["decimals"]))
        log.append(f"{m}: days {infos[m]['days']} pool {infos[m]['pool']} C3 first fold {infos[m]['c3']['first_fold']}")
    weeks_ok = {}
    for m in markets:                     # evaluability from scorable counts only (before any loss is read)
        p = pools[m]
        sc = p[p["scorable"]] if len(p) else p
        if len(sc) == 0:
            weeks_ok[m] = 0
            continue
        wk = ((pd.DatetimeIndex(sc["origin"]) - WEEK_ANCHOR) // pd.Timedelta(days=7)).astype(int)
        weeks_ok[m] = int((pd.Series(wk).value_counts() >= MIN_WEEK_ORIGINS).sum())
    evaluable = [m for m in markets if weeks_ok[m] >= MIN_WEEKS_EVALUABLE]
    log.append(f"evaluable reserves K = {len(evaluable)} of {len(markets)}; retained weeks {weeks_ok}")
    S = pd.concat([pools[m][pools[m]["scorable"]] for m in evaluable], ignore_index=True)
    names = ["M2", "C3", "EMP", "E90", "R103", "NC"]

    primary, ok_all = {}, True
    for comp in CONFIRMATORY + REPORTED:
        S["_d"] = S["L_M2"] - S["L_" + comp]
        r = cross_market(S, "_d")
        mm = [float(pools[m].loc[pools[m]["scorable"], "L_M2"].mean()
                    - pools[m].loc[pools[m]["scorable"], "L_" + comp].mean()) for m in evaluable]
        r["reserve_cluster_t_reported_only"] = B.cluster_t(mm)
        r["ratio_pooled_origins"] = float(S["L_M2"].mean() / S["L_" + comp].mean())
        if comp in CONFIRMATORY:
            r["pass"] = bool(r["p"] is not None and r["p"] < ALPHA and r["mean"] < 0)
            ok_all = ok_all and r["pass"]
        primary[comp] = r
    verdict = "PASS" if ok_all else "FAIL"

    Y, Mt = S[S["young"]].copy(), S[~S["young"]].copy()
    Y["_d"] = Y["L_M2"] - Y["L_C3"]
    young = cross_market(Y, "_d") if len(Y) else {"p": None}
    young["n"] = int(len(Y))
    young["pass"] = bool(young.get("p") is not None and young["p"] < ALPHA_CUT and young["mean"] < 0)
    mature = {"n": int(len(Mt))}
    if len(Mt):
        Mt["_d"] = Mt["L_M2"] - Mt["L_C3"]
        mature["M2_vs_C3"] = cross_market(Mt, "_d")
        Mt["_d"] = Mt["L_C3"] - NI_MARGIN * Mt["L_M2"]
        mature["C3_noninferior_5pct"] = cross_market(Mt, "_d")
    mech = "SUPPORTED" if young["pass"] else "NOT SUPPORTED"

    years = sorted(S["origin"].dt.year.unique())
    rep = {
        "pooled_scorable": block(S, names),
        "by_year": {str(yv): block(S[S["origin"].dt.year == yv], names) for yv in years},
        "cut_by_year": {c: {str(yv): block(g[g["origin"].dt.year == yv], names) for yv in years}
                        for c, g in (("young", S[S["young"]]), ("mature", S[~S["young"]]))},
        "per_reserve": {m: {"evaluable": m in evaluable, "retained_weeks": weeks_ok[m], "info": infos[m],
                            **block(pools[m][pools[m]["scorable"]] if len(pools[m]) else pools[m], names)}
                        for m in markets},
        "coverage": {k: {"q05_q95": float(S[f"cov90_{k}"].mean()), "q25_q75": float(S[f"cov50_{k}"].mean())}
                     for k in names},
        "bank_distribution": S["bank"].value_counts().sort_index().to_dict(),
        "m2": {"mean_w_c3": {c: float(S[f"m2_w_c3_{c}"].mean()) for c in C.QCOLS},
               "sorted_scored": int(S["m2_sorted"].sum())},
    }
    allp = pd.concat([pools[m] for m in markets if len(pools[m])], ignore_index=True)
    rep["q2_2026"] = block(allp[allp["inQ2"] & allp["emp_ok"] & ~allp["low_debt"]], names)
    rep["low_debt"] = block(allp[allp["low_debt"] & allp["emp_ok"] & ~allp["inQ2"]], names)
    rep["bank_distribution"] = {str(k): int(v) for k, v in rep["bank_distribution"].items()}

    res = {"schema": "q26-r124/results/1", "frozenSha256": want, "frozen_created_utc": cfg["created_utc"],
           "code": cfg["code"], "verdict": verdict, "mechanism_check": mech, "alpha": ALPHA, "alpha_cut": ALPHA_CUT,
           "K": len(evaluable), "evaluable": evaluable, "n_scorable": int(len(S)),
           "primary": primary, "young_cut": young, "mature_cut_reported": mature, "reported_only": rep}
    pub = ["market", "origin", "scorable", "inQ2", "low_debt", "emp_ok", "bank", "young", "m2_sorted"]
    pub += [f"L_{k}" for k in names] + [f"L_{k}_{c}" for k in ("EMP", "E90", "R103", "NC") for c in C.QCOLS]
    pub += [f"cov90_{k}" for k in names] + [f"cov50_{k}" for k in names]
    pub += [f"m2_eta_{c}" for c in C.QCOLS] + [f"m2_w_c3_{c}" for c in C.QCOLS]
    O = allp[pub].copy()
    O["origin"] = O["origin"].dt.strftime("%Y-%m-%d")
    csv = O.to_csv(index=False)
    R.guard(csv)
    with gzip.open(os.path.join(out, "losses-r124.csv.gz"), "wt") as f:
        f.write(csv)
    R.write_json(os.path.join(out, "results-r124.json"), res)
    log.append(f"VERDICT {verdict} (alpha {ALPHA:.5f} per confirmatory comparator)")
    for comp in CONFIRMATORY + REPORTED:
        r = primary[comp]
        log.append(f"  M2 vs {comp}: ratio {r['ratio_pooled_origins']:.4f} t {r['t']:.3f} nu {r['nu']} p {r['p']:.4g}"
                   + (f" pass {r['pass']}" if comp in CONFIRMATORY else " (reported)"))
    log.append(f"mechanism (bank < {BANK_THRESHOLD}, M2 vs C3) {mech}: n {young['n']} p {young.get('p')}")
    log.append(f"run end {utcnow()}")
    txt = "\n".join(log) + "\n"
    R.guard(txt)
    with open(os.path.join(out, "run.log"), "w") as f:
        f.write(txt)
    print(txt)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["freeze", "run"])
    ap.add_argument("--inputs", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    {"freeze": cmd_freeze, "run": cmd_run}[a.cmd](a.inputs, a.out)


if __name__ == "__main__":
    main()
