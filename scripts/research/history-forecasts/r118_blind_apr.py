"""Q26 R11.8 APR blind historical sets (membrane-board design/Q26_ROUND11_PREREG.md D-R11.8a and its Deviations).

  python3 r118_blind_apr.py freeze --inputs DIR --out OUT   write and hash frozen-r118.json (UTC time) before any score
  python3 r118_blind_apr.py run    --inputs DIR --out OUT   check the freeze, forecast, combine, score once, write results

Per market (nine unseen Aave USDC markets, daily 00:00Z origins, 7 d variable borrow APR, q05 q25 q50 q75 q95):
  C3   Q33's published kernel.py + curve_coordinate.py (datasets 84ea4567, run fc8bd4718e378a8d recipe), unchanged:
       half-year banks (1 Jan / 1 Jul), 730 d window, 30 d purge, 7 d embargo, prior 180, bandwidth 1/20, Kish >= 180
  R10.3 r103_curve_apr.daily_state + forecast_origin (code 67e1f71f), unchanged
  E    r114_apr_combo.empirical_quantiles (code b6be18c7), unchanged
  M2   r114_apr_combo.m2_walk_forward, unchanged, per market
  M3   w_R = max(w_R^M2, f(s)) (D-R11.7a R11.7-1), sorted across tau
Tests: weekly-mean EWC HAC t (one-sided), pooled cross-market (Driscoll-Kraay form) and market-clustered t.
No C3, M2 or M3 quantile is written. No address is read or written.
"""
from __future__ import annotations

import argparse
import datetime as dt
import gzip
import hashlib
import importlib.util
import json
import math
import os
import subprocess
import sys
import tempfile
from fractions import Fraction

import numpy as np
import pandas as pd
from scipy.stats import t as student_t

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import r103_curve_apr as R  # noqa: E402
import r114_apr_combo as C  # noqa: E402

DATASETS = R.DATASETS
MARKETS = ["v2-eth-usdc", "v3-arb-usdce", "v3-arb-usdc", "v3-op-usdce", "v3-op-usdc", "v3-poly-usdce",
           "v3-poly-usdc", "v3-avax-usdc", "v3-base-usdc"]
Q33_COMMIT = "84ea4567c75e09b3a58cf202f953b6ff470a81c8"
Q33_FILES = {"kernel": "validation/q33-shrinkage-study/kernel.py",
             "coordinate": "validation/q33-rate-successor/curve_coordinate.py"}
C3_LABEL = "aave-core-usdc"     # kernel.py's venue argument only names trajectory ids; no number depends on it
CODE_PINS = {"r103": "67e1f71f49ac451546b723abdb4c3d5fc1c1c030", "r114": "b6be18c7"}

QS = R.QS
HORIZON_D = 7
MIN_DEBT_USDC = 1_000_000
Q2 = (pd.Timestamp("2026-04-01", tz="UTC"), pd.Timestamp("2026-07-01", tz="UTC"))
WEEK_ANCHOR = pd.Timestamp("2020-11-29", tz="UTC")   # a Sunday; weeks run Sunday..Saturday
MIN_WEEK_ORIGINS = 4
MIN_WEEKS_EVALUABLE = 26
ALPHA_POOLED = 0.025 / 2
CANDIDATES = ["M2", "M3"]
COMPARATORS = ["C3", "R103", "EMP"]
F_FULL_D, F_END_D, F_LEVEL = 7.0, 21.0, 0.5

DECISIONS = {
    "R118-1": "Markets: the nine of D-R11.8a R11.8-1. Daily read at b_d (last block with ts < d 00:00Z).",
    "R118-2": "Target y(t0) = stored variable borrow rate / 1e27 at b_{t0+7}; that read must exist.",
    "R118-3": "C3 = Q33 kernel.py/curve_coordinate.py at 84ea4567, unchanged; row u = invert_rate(curve, stored rate), "
              "days outside the curve domain or with an unidentifiable curve have no row; banks at each 1 Jan / 1 Jul "
              "from the market's first year; the first fold is the first eligible bank (n >= 180); per-origin Kish < 180 "
              "abstains; levels priced through the curve at t0. The venue argument is the fixed label 'aave-core-usdc'.",
    "R118-4": "R10.3 = r103 daily_state + forecast_origin unchanged on one row per day (the b_d read served to day d); "
              "U = (variable + stable debt) / (available + debt), available = virtual balance where read, else the "
              "aToken's asset balance. The stable-debt STOP is not applied (variable curve uses total usage). "
              "Exceptions or non-finite quantiles abstain.",
    "R118-5": "E = r114 empirical_quantiles unchanged on the market's daily APR (>= 365 changes).",
    "R118-6": "M2 = r114 m2_walk_forward unchanged per market over the pool of origins with C3, R10.3 and y.",
    "R118-7": "M3: w_R = max(1 - w_C3^M2, f(s)), f = 0.5 (s <= 7 d), 0.5 (21 - s) / 14 (7 < s < 21), 0 (s >= 21); "
              "s = (t0 - block time of the first hourly read with the new curve) in days, over changes strictly before "
              "t0; none -> s = inf. q = (1 - w_R) q_C3 + w_R q_R103, sorted across tau.",
    "R118-8": "Scorable: C3, R10.3, E, M2, M3 finite; y exists; total debt at b_t0 >= 1,000,000 USDC; window "
              "[t0, t0 + 7 d) does not meet 2026-04-01..2026-06-30. Matched removal.",
    "R118-9": "Pinball: mean over 5 quantiles per origin (D-R11.4a). d = L_candidate - L_comparator.",
    "R118-10": "EWC: weekly means (Sun..Sat UTC, >= 4 scorable origins), nu = max(2, floor(0.4 n^(2/3))) cosine terms, "
               "t = mean / sqrt(Omega / n), one-sided p = t_cdf(t, nu).",
    "R118-11": "Pooled (a): per day the equal-weight mean of d over evaluable markets scorable that day, then EWC on "
               "its weekly means. Pooled (b): one-sided t on the G evaluable markets' mean d, G - 1 df. "
               "Pooled PASS: (a) and (b) p < 0.0125 and mean d < 0 against each of C3, R10.3, E.",
    "R118-12": "Per market: EWC p < 0.025 / (2 K) and mean d < 0 against each comparator; K = evaluable markets "
               "(>= 26 retained weeks), counted before any loss.",
    "R118-13": "Publication: losses, coverage flags, M2 eta and weights, s; no C3, M2 or M3 quantile.",
    "R118-14": "One run; nothing retuned.",
}


def utcnow():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha256_bytes(b):
    return hashlib.sha256(b).hexdigest()


# ---------------------------------------------------------------------------------------------
# Q33 C3 code (read-only, unchanged)
# ---------------------------------------------------------------------------------------------
def q33_sources():
    out = {}
    for k, p in Q33_FILES.items():
        out[k] = subprocess.check_output(["git", "-C", DATASETS, "show", f"{Q33_COMMIT}:{p}"])
    return out


def load_q33():
    src = q33_sources()
    d = tempfile.mkdtemp(prefix="q33c3-")
    mods = {}
    for k, b in src.items():
        p = os.path.join(d, os.path.basename(Q33_FILES[k]))
        with open(p, "wb") as f:
            f.write(b)
        spec = importlib.util.spec_from_file_location(f"q33_{k}", p)
        m = importlib.util.module_from_spec(spec)
        sys.modules[f"q33_{k}"] = m
        spec.loader.exec_module(m)
        mods[k] = m
    return mods["kernel"], mods["coordinate"], {k: sha256_bytes(b) for k, b in src.items()}


def c3_rows(D, coord):
    rows = {}
    for r in D.itertuples():
        try:
            curve = coord.Curve(int(r.optimal_usage_ray), int(r.base_rate_ray), int(r.slope1_ray), int(r.slope2_ray))
            rows[r.date] = {"curve": curve, "u": coord.invert_rate(curve, int(r.rate_ray))}
        except (ValueError, TypeError):
            continue
    return rows


def c3_forecasts(D, kernel, coord):
    """dict date -> (5 quantiles or None, reason)."""
    rows = c3_rows(D, coord)
    dates = sorted(D["date"])
    first, last = dt.date.fromisoformat(dates[0]), dt.date.fromisoformat(dates[-1])
    starts = [dt.date(yy, mth, 1) for yy in range(first.year, last.year + 1) for mth in (1, 7)
              if dt.date(yy, mth, 1) <= last]
    banks = []
    for s in starts:
        bank = kernel.fit_bank(rows, s.isoformat(), HORIZON_D, C3_LABEL)
        banks.append((s, bank))
    eligible = [i for i, (_, b) in enumerate(banks) if b["eligible"]]
    out, info = {}, {"folds": [], "first_fold": None}
    if not eligible:
        return out, info
    i0 = eligible[0]
    info["first_fold"] = banks[i0][0].isoformat()
    for j in range(i0, len(banks)):
        s, bank = banks[j]
        e = banks[j + 1][0] if j + 1 < len(banks) else dt.date(2100, 1, 1)
        info["folds"].append({"start": s.isoformat(), "n_trajectories": bank["n_trajectories"],
                              "eligible": bank["eligible"]})
        for k in dates:
            dk = dt.date.fromisoformat(k)
            if not (s <= dk < e):
                continue
            if k not in rows:
                out[k] = (None, "coordinate_unavailable")
                continue
            if not bank["eligible"]:
                out[k] = (None, "bank_ineligible")
                continue
            p = kernel.predict_levels(rows[k]["u"], bank)
            if not p["eligible"]:
                out[k] = (None, p["reason"])
                continue
            out[k] = ([float(coord.price_coordinate(rows[k]["curve"], lv) / coord.RAY) for lv in p["levels"]], None)
    return out, info


# ---------------------------------------------------------------------------------------------
# R10.3 and E on a market
# ---------------------------------------------------------------------------------------------
def h_frame(D):
    """One 'hourly' row per day: the b_d read (block on date d-1) so r103.daily_state serves it to day d."""
    h = pd.DataFrame({
        "hour_utc": pd.to_datetime(D["block_ts"], unit="s", utc=True).dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "variable_debt_raw": D["variable_debt_raw"].astype(float),
        "stable_debt_raw": D["stable_debt_raw"].astype(float),
        "virtual_balance_raw": pd.to_numeric(D["virtual_balance_raw"], errors="coerce"),
        "cash_balance_raw": D["cash_balance_raw"].astype(float),
        "rd_variable_borrow_rate_ray": D["rate_ray"].astype(str),
        "optimal_usage_ray": D["optimal_usage_ray"].astype(str),
        "base_rate_ray": D["base_rate_ray"].astype(str),
        "slope1_ray": D["slope1_ray"].astype(str),
        "slope2_ray": D["slope2_ray"].astype(str),
        "block": D["block"].astype(int)})
    return h


def r103_forecasts(st, start_day):
    """Quantiles per origin from r103.forecast_origin, on the day series from start_day (U in (0,1) from there)."""
    st = st[st.index >= start_day]
    dates = st.index
    U = st["U"].to_numpy(float)
    D = np.full(len(U), np.nan)
    with np.errstate(divide="ignore", invalid="ignore"):
        D[1:] = np.diff(R.logit(U))
    out = {}
    for i0, t0 in enumerate(dates):
        row = st.iloc[i0]
        curve = (row["base_rate"], row["slope1"], row["slope2"], row["optimal_usage"])
        try:
            with np.errstate(all="ignore"):
                q, info = R.forecast_origin(dates, D.copy(), i0, curve, row["U"])
        except (np.linalg.LinAlgError, ValueError, FloatingPointError):
            q = None
        if q is not None and np.all(np.isfinite(q)):
            out[t0] = np.asarray(q, float)
    return out


# ---------------------------------------------------------------------------------------------
# M3, tests
# ---------------------------------------------------------------------------------------------
def f_floor(s_days):
    if s_days <= F_FULL_D:
        return F_LEVEL
    if s_days < F_END_D:
        return F_LEVEL * (F_END_D - s_days) / (F_END_D - F_FULL_D)
    return 0.0


def s_days(t0_ts, change_ts):
    """change_ts sorted ascending (unix s). Days since the last change strictly before t0; inf if none."""
    prior = [c for c in change_ts if c < t0_ts]
    return (t0_ts - prior[-1]) / 86400.0 if prior else math.inf


def m3_quantiles(Qc, Qr, wa_m2, svals):
    out = np.zeros_like(Qc)
    wr_all = np.zeros_like(Qc)
    for i in range(len(Qc)):
        f = f_floor(svals[i])
        wr = np.maximum(1.0 - wa_m2[i], f)
        q = (1.0 - wr) * Qc[i] + wr * Qr[i]
        out[i] = np.sort(q)
        wr_all[i] = wr
    return out, wr_all


def ewc_test(w):
    """One-sided EWC HAC t-test of H1: mean < 0 on the series w (weekly means)."""
    w = np.asarray(w, float)
    n = len(w)
    if n < 3:
        return {"n_weeks": n, "mean": float(w.mean()) if n else None, "t": None, "nu": None, "p": None}
    nu = max(2, int(math.floor(0.4 * n ** (2.0 / 3.0))))
    x = w - w.mean()
    tt = np.arange(1, n + 1)
    lam = [(math.sqrt(2.0 / n) * float(np.cos(math.pi * j * (tt - 0.5) / n) @ x)) ** 2 for j in range(1, nu + 1)]
    om = float(np.mean(lam))
    if not om > 0:
        return {"n_weeks": n, "mean": float(w.mean()), "t": None, "nu": nu, "p": None}
    t = float(w.mean()) / math.sqrt(om / n)
    return {"n_weeks": n, "mean": float(w.mean()), "t": t, "nu": nu, "p": float(student_t.cdf(t, nu))}


def weekly_means(dates, vals):
    s = pd.Series(np.asarray(vals, float), index=pd.DatetimeIndex(dates))
    wk = ((s.index - WEEK_ANCHOR) // pd.Timedelta(days=7)).astype(int)
    g = s.groupby(wk)
    cnt, mean = g.size(), g.mean()
    keep = cnt >= MIN_WEEK_ORIGINS
    return mean[keep].sort_index().to_numpy(), int((~keep).sum())


def cluster_t(means):
    m = np.asarray(means, float)
    G = len(m)
    if G < 2:
        return {"G": G, "mean": float(m.mean()) if G else None, "t": None, "p": None}
    se = float(m.std(ddof=1)) / math.sqrt(G)
    if not se > 0:
        return {"G": G, "mean": float(m.mean()), "t": None, "p": None}
    t = float(m.mean()) / se
    return {"G": G, "mean": float(m.mean()), "t": t, "df": G - 1, "p": float(student_t.cdf(t, G - 1))}


# ---------------------------------------------------------------------------------------------
# inputs / freeze
# ---------------------------------------------------------------------------------------------
def load_market(inputs, m):
    D = pd.read_csv(os.path.join(inputs, f"daily-{m}.csv.gz"), dtype=str)
    D["block_ts"] = D["block_ts"].astype(int)
    ch = pd.read_csv(os.path.join(inputs, f"curve-changes-{m}.csv"))
    return D, sorted(int(x) for x in ch["block_ts"])


def input_hashes(inputs):
    out = {}
    for m in MARKETS:
        for name in (f"daily-{m}.csv.gz", f"curve-changes-{m}.csv"):
            p = os.path.join(inputs, name)
            out[name] = R.sha256_file(p)
    out["acquire-counts.json"] = R.sha256_file(os.path.join(inputs, "acquire-counts.json"))
    return out


def readings_path(inputs):
    return os.path.join(inputs, "readings-r118.json")


def frozen_config(inputs):
    sha, dirty = R.git_sha()
    if dirty:
        raise SystemExit("STOP: uncommitted code")
    _, _, q33 = load_q33()
    rd = json.load(open(readings_path(inputs)))
    return {"schema": "q26-r118/frozen-config/1", "item": "Q26 R11.8 APR blind historical sets",
            "prereg": "triccs/membrane-board design/Q26_ROUND11_PREREG.md D-R11.8a (+ D-R11.8b)",
            "code": {"repo": "The-Membrane/membrane-app", "sha": sha,
                     "path": "scripts/research/history-forecasts/r118_blind_apr.py", "pins": CODE_PINS},
            "q33_code": {"commit": Q33_COMMIT, "files": Q33_FILES, "sha256": q33},
            "inputs": {"dir": os.path.relpath(os.path.abspath(inputs), os.path.abspath(DATASETS)),
                       "sha256": input_hashes(inputs), "readings_sha256": R.sha256_file(readings_path(inputs))},
            "readings": rd,
            "constants": {"markets": MARKETS, "quantiles": QS, "horizon_days": HORIZON_D,
                          "min_debt_usdc": MIN_DEBT_USDC, "q2_excluded": ["2026-04-01", "2026-06-30"],
                          "week_anchor_sunday": str(WEEK_ANCHOR.date()), "min_week_origins": MIN_WEEK_ORIGINS,
                          "min_weeks_evaluable": MIN_WEEKS_EVALUABLE, "alpha_pooled": ALPHA_POOLED,
                          "alpha_market": "0.025 / (2 K)", "m3_f": [F_FULL_D, F_END_D, F_LEVEL],
                          "m2": {"etas": C.ETAS, "window_d": C.WEIGHT_WINDOW_D, "min_resolved": C.MIN_RESOLVED},
                          "emp": {"train_d": C.EMP_TRAIN_D, "min_rows": C.EMP_MIN_ROWS}},
            "seeds": {"model": None}, "decisions": DECISIONS}


def cmd_freeze(inputs, out):
    os.makedirs(out, exist_ok=True)
    path = os.path.join(out, "frozen-r118.json")
    if os.path.exists(path):
        raise SystemExit("STOP: frozen config exists")
    cfg = frozen_config(inputs)
    cfg["created_utc"] = utcnow()
    h = R.write_json(path, cfg)
    with open(path + ".sha256", "w") as f:
        f.write(f"{h}  frozen-r118.json\n")
    print("frozen config", h, cfg["created_utc"])


# ---------------------------------------------------------------------------------------------
# run
# ---------------------------------------------------------------------------------------------
def build_market(m, inputs, kernel, coord, rd):
    D, changes = load_market(inputs, m)
    D = D.sort_values("date").reset_index(drop=True)
    rate = {r.date: int(r.rate_ray) / 1e27 for r in D.itertuples()}          # target needs no curve
    have_curve = D["optimal_usage_ray"].notna() & (D["optimal_usage_ray"] != "None")
    D = D[have_curve].reset_index(drop=True)
    debt = {r.date: (float(r.variable_debt_raw) + float(r.stable_debt_raw)) / 1e6 for r in D.itertuples()}
    st = R.daily_state(h_frame(D))
    start_day = pd.Timestamp(rd["r103_start"][m], tz="UTC")
    rq = r103_forecasts(st, start_day)
    cq, cinfo = c3_forecasts(D, kernel, coord)
    recs = []
    for k in D["date"]:
        t0 = pd.Timestamp(k, tz="UTC")
        tgt = (t0 + pd.Timedelta(days=HORIZON_D)).strftime("%Y-%m-%d")
        c = cq.get(k, (None, "no_fold"))
        rec = {"market": m, "origin": t0, "y": rate.get(tgt), "apr_t0": rate[k], "debt_t0": debt[k],
               "c3": c[0], "c3_reason": c[1], "r103": rq.get(t0)}
        q, nr = C.empirical_quantiles(st, t0)
        rec["emp"] = None if q is None else np.asarray(q, float)
        recs.append(rec)
    P = pd.DataFrame(recs)
    pool = P[P["c3"].notna() & P["r103"].notna() & P["y"].notna()].sort_values("origin").reset_index(drop=True)
    info = {"days": int(len(D)), "c3": cinfo, "r103_start": rd["r103_start"][m],
            "c3_available": int(P["c3"].notna().sum()), "r103_available": int(P["r103"].notna().sum()),
            "emp_available": int(P["emp"].notna().sum()), "pool": int(len(pool)),
            "c3_abstain_reasons": P.loc[P["c3"].isna(), "c3_reason"].value_counts().to_dict(),
            "curve_changes": len(changes)}
    if len(pool) == 0:
        return pool, info
    dates = pd.DatetimeIndex(pool["origin"])
    Qc = np.array(pool["c3"].tolist(), float)
    Qr = np.array([np.asarray(x) for x in pool["r103"]], float)
    y = pool["y"].to_numpy(float)
    q2, eta2, wa2, cross2 = C.m2_walk_forward(dates, Qc, Qr, y)
    sv = [s_days(int(t.timestamp()), changes) for t in dates]
    q3, wr3 = m3_quantiles(Qc, Qr, wa2, sv)
    Q = {"C3": Qc, "R103": Qr, "M2": q2, "M3": q3,
         "EMP": np.array([x if x is not None else [np.nan] * 5 for x in pool["emp"]], float),
         "NC": np.repeat(pool["apr_t0"].to_numpy(float)[:, None], 5, axis=1)}
    for k, q in Q.items():
        Lt = C.pin_mat(q, y)
        pool["L_" + k] = Lt.mean(1)
        for j, cc in enumerate(C.QCOLS):
            pool[f"L_{k}_{cc}"] = Lt[:, j]
        pool[f"cov90_{k}"] = (q[:, 0] <= y) & (y <= q[:, 4])
        pool[f"cov50_{k}"] = (q[:, 1] <= y) & (y <= q[:, 3])
    for j, cc in enumerate(C.QCOLS):
        pool[f"m2_eta_{cc}"] = eta2[:, j]
        pool[f"m2_w_c3_{cc}"] = wa2[:, j]
        pool[f"m3_w_r103_{cc}"] = wr3[:, j]
    pool["m2_sorted"] = cross2
    pool["s_days"] = sv
    pool["curve_recent"] = np.array(sv) < F_END_D
    pool["inQ2"] = (pool["origin"] < Q2[1]) & (pool["origin"] + pd.Timedelta(days=HORIZON_D) > Q2[0])
    pool["low_debt"] = pool["debt_t0"] < MIN_DEBT_USDC
    pool["emp_ok"] = np.isfinite(Q["EMP"]).all(1)
    pool["scorable"] = pool["emp_ok"] & ~pool["inQ2"] & ~pool["low_debt"]
    return pool, info


def cmd_run(inputs, out):
    path = os.path.join(out, "frozen-r118.json")
    cfg = json.load(open(path))
    want = open(path + ".sha256").read().split()[0]
    if R.sha256_file(path) != want:
        raise SystemExit("STOP: frozen config hash")
    if os.path.exists(os.path.join(out, "run.log")) or os.path.exists(os.path.join(out, "run-started.json")):
        raise SystemExit("STOP: a run already started (one run only)")
    now = frozen_config(inputs)
    for k in ("code", "q33_code", "inputs", "readings", "constants", "decisions"):
        if now[k] != cfg[k]:
            raise SystemExit(f"STOP: {k} differs from the frozen config")
    start = utcnow()
    R.write_json(os.path.join(out, "run-started.json"), {"frozenSha256": want, "start_utc": start})
    log = [f"frozen config {want} created {cfg['created_utc']}", f"code {cfg['code']['sha']}", f"run start {start}"]
    kernel, coord, _ = load_q33()
    rd = cfg["readings"]
    pools, infos = {}, {}
    for m in MARKETS:
        pool, info = build_market(m, inputs, kernel, coord, rd)
        pools[m], infos[m] = pool, info
        log.append(f"{m}: days {info['days']} pool {info['pool']} C3 first fold {info['c3']['first_fold']}")
    # evaluability from scorable counts only (before any loss is read)
    weeks_ok = {}
    for m in MARKETS:
        p = pools[m]
        if len(p) == 0:
            weeks_ok[m] = 0
            continue
        sc = p[p["scorable"]]
        if len(sc) == 0:
            weeks_ok[m] = 0
            continue
        wk = ((pd.DatetimeIndex(sc["origin"]) - WEEK_ANCHOR) // pd.Timedelta(days=7)).astype(int)
        weeks_ok[m] = int((pd.Series(wk).value_counts() >= MIN_WEEK_ORIGINS).sum())
    evaluable = [m for m in MARKETS if weeks_ok[m] >= MIN_WEEKS_EVALUABLE]
    K = len(evaluable)
    alpha_m = 0.025 / (2 * K) if K else None
    log.append(f"evaluable markets K = {K}: {evaluable}; retained weeks {weeks_ok}")

    S = pd.concat([pools[m][pools[m]["scorable"]] for m in evaluable], ignore_index=True)
    names = ["M2", "M3", "C3", "R103", "EMP", "NC"]
    per_market, pooled = {}, {}
    verdict = {"pooled": {}, "per_market": {}}
    for cand in CANDIDATES:
        pooled[cand] = {}
        okp = True
        for comp in COMPARATORS:
            S["_d"] = S["L_" + cand] - S["L_" + comp]
            daily = S.groupby("origin")["_d"].mean().sort_index()
            wm, dropped = weekly_means(daily.index, daily.to_numpy())
            a = ewc_test(wm)
            a["weeks_dropped"] = dropped
            mm = [float(pools[m].loc[pools[m]["scorable"], "L_" + cand].mean()
                        - pools[m].loc[pools[m]["scorable"], "L_" + comp].mean()) for m in evaluable]
            b = cluster_t(mm)
            ok = (a["p"] is not None and a["p"] < ALPHA_POOLED and a["mean"] < 0 and
                  b["p"] is not None and b["p"] < ALPHA_POOLED and b["mean"] < 0)
            pooled[cand][comp] = {"cross_market_ewc": a, "market_cluster_t": b,
                                  "ratio_pooled_origins": float(S["L_" + cand].mean() / S["L_" + comp].mean()),
                                  "pass": bool(ok)}
            okp = okp and ok
        verdict["pooled"][cand] = "PASS" if okp else "FAIL"
    for m in MARKETS:
        per_market[m] = {"evaluable": m in evaluable, "retained_weeks": weeks_ok[m], "info": infos[m]}
        if m not in evaluable:
            verdict["per_market"][m] = {c: "NOT EVALUABLE" for c in CANDIDATES}
            continue
        sc = pools[m][pools[m]["scorable"]]
        per_market[m]["n_origins"] = int(len(sc))
        per_market[m]["L"] = {k: float(sc["L_" + k].mean()) for k in names}
        per_market[m]["tests"] = {}
        verdict["per_market"][m] = {}
        for cand in CANDIDATES:
            per_market[m]["tests"][cand] = {}
            ok_all = True
            for comp in COMPARATORS:
                wm, dropped = weekly_means(sc["origin"], (sc["L_" + cand] - sc["L_" + comp]).to_numpy())
                r = ewc_test(wm)
                r["weeks_dropped"] = dropped
                r["ratio"] = float(sc["L_" + cand].mean() / sc["L_" + comp].mean())
                r["pass"] = bool(r["p"] is not None and r["p"] < alpha_m and r["mean"] < 0)
                per_market[m]["tests"][cand][comp] = r
                ok_all = ok_all and r["pass"]
            verdict["per_market"][m][cand] = "PASS" if ok_all else "FAIL"

    def block(g):
        if len(g) == 0:
            return {"n": 0}
        o = {"n": int(len(g)), **{"L_" + k: float(g["L_" + k].mean()) for k in names}}
        o["ratio_vs_C3"] = {k: float(g["L_" + k].mean() / g["L_C3"].mean()) for k in names}
        return o

    allp = pd.concat([pools[m] for m in MARKETS if len(pools[m])], ignore_index=True)
    rep = {
        "pooled_scorable": block(S),
        "per_quantile": {k: {c: float(S[f"L_{k}_{c}"].mean()) for c in C.QCOLS} for k in names},
        "coverage": {k: {"q05_q95": float(S[f"cov90_{k}"].mean()), "q25_q75": float(S[f"cov50_{k}"].mean())}
                     for k in names},
        "curve_recent_split": {"s_lt_21d": block(S[S["curve_recent"]]), "else": block(S[~S["curve_recent"]])},
        "by_year": {str(yv): block(S[S["origin"].dt.year == yv]) for yv in sorted(S["origin"].dt.year.unique())},
        "per_market_blocks": {m: block(pools[m][pools[m]["scorable"]]) for m in MARKETS if len(pools[m])},
        "q2_2026": block(allp[allp["inQ2"] & allp["emp_ok"] & ~allp["low_debt"]]),
        "low_debt": block(allp[allp["low_debt"] & allp["emp_ok"] & ~allp["inQ2"]]),
        "m2": {"eta_share": {c: {str(e): float((S[f"m2_eta_{c}"] == e).mean()) for e in C.ETAS} for c in C.QCOLS},
               "mean_w_c3": {c: float(S[f"m2_w_c3_{c}"].mean()) for c in C.QCOLS},
               "sorted_scored": int(S["m2_sorted"].sum())},
        "m3": {"share_floor_active": float((S["s_days"] < F_END_D).mean()),
               "mean_w_r103": {c: float(S[f"m3_w_r103_{c}"].mean()) for c in C.QCOLS}},
    }
    res = {"schema": "q26-r118/results/1", "frozenSha256": want, "frozen_created_utc": cfg["created_utc"],
           "code": cfg["code"], "verdict": verdict, "alpha_pooled": ALPHA_POOLED, "alpha_market": alpha_m,
           "K": K, "evaluable": evaluable, "pooled": pooled, "per_market": per_market, "reported_only": rep}
    pub = ["market", "origin", "scorable", "inQ2", "low_debt", "emp_ok", "s_days", "curve_recent", "m2_sorted"]
    pub += [f"L_{k}" for k in names] + [f"L_{k}_{c}" for k in names for c in C.QCOLS]
    pub += [f"cov90_{k}" for k in names] + [f"cov50_{k}" for k in names]
    pub += [f"m2_eta_{c}" for c in C.QCOLS] + [f"m2_w_c3_{c}" for c in C.QCOLS] + [f"m3_w_r103_{c}" for c in C.QCOLS]
    O = allp[pub].copy()
    O["origin"] = O["origin"].dt.strftime("%Y-%m-%d")
    csv = O.to_csv(index=False)
    R.guard(csv)
    with gzip.open(os.path.join(out, "losses-r118.csv.gz"), "wt") as f:
        f.write(csv)
    R.write_json(os.path.join(out, "results-r118.json"), res)
    for cand in CANDIDATES:
        log.append(f"pooled {cand} {verdict['pooled'][cand]} | " + " ".join(
            f"{c}: ratio {pooled[cand][c]['ratio_pooled_origins']:.4f} pEWC {pooled[cand][c]['cross_market_ewc']['p']:.4g}"
            f" pCL {pooled[cand][c]['market_cluster_t']['p']:.4g}" for c in COMPARATORS))
    for m in MARKETS:
        log.append(f"{m}: {verdict['per_market'][m]}")
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
