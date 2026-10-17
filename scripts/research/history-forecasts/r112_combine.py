"""Q26 R11.2 short-horizon ETH/USD touch combination (membrane-board design/Q26_ROUND11_PREREG.md R11.2 and its
Deviations D-R11.2a..).

  python3 r112_combine.py freeze --datasets DS --acq ACQ --counts COUNTS --out OUT
        write and hash frozen-r112-config.json (code sha, input sha256 values, readings, constants, seeds,
        included features, UTC creation time). No fit, no forecast, no score.
  python3 r112_combine.py run    --datasets DS --acq ACQ --out OUT
        verify the frozen config, build the base rung p0 ((fH), A6 recipe, extended to 1 h, 3 h, 12 h) and rung (a),
        verify p0 and (a) against the published A6 dev predictions, build the features, fit the walk-forward ridge
        logistic combiner ONCE per (T, quarter), write and hash the coefficients (frozen-r112-coefs.json, last
        dev fold = the forward/blind coefficients) BEFORE any score, then score per horizon and write results.

Subject: P(min ETH/USD over (t, t+T] <= S (1+k)), Chainlink truth (A-series long:ETH, Chainlink on the dev span).
Combiner per T: logit p_c = a_band + b logit p0 + sum_j c_j x_j, ridge 1.0 on (b, c) - (1, 0), standardised x,
intercepts unpenalised, then the running minimum across levels (shallow -> deep).
No address is read or written. Every output is checked for 0x + 40 hex.
"""
from __future__ import annotations

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import bisect  # noqa: E402
import csv  # noqa: E402
import gzip  # noqa: E402
import hashlib  # noqa: E402
import json  # noqa: E402
import math  # noqa: E402
import re  # noqa: E402
import subprocess  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402
from datetime import datetime, timezone  # noqa: E402

import numpy as np  # noqa: E402
from scipy.special import expit  # noqa: E402
from scipy.stats import t as student_t  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import a_touch as A  # noqa: E402
import a2_touch as M2  # noqa: E402
import a3_touch as M3  # noqa: E402
import a6_touch as A6  # noqa: E402

PREREG = {"repo": "triccs/membrane-board", "path": "design/Q26_ROUND11_PREREG.md", "commit": "348d813",
          "item": "R11.2", "deviations": "D-R11.2a.."}
STEP, DAY = 3600, 86400
ADDR_RE = re.compile(r"0x[0-9a-fA-F]{40}")

# R11.2 horizons: (hours, label, origin grid)
HORIZONS = ((1, "1h", "hourly"), (3, "3h", "hourly"), (6, "6h", "hourly"), (12, "12h", "hourly"),
            (24, "1d", "daily"), (72, "3d", "daily"))
A6_H = tuple(A.HORIZONS_H)                        # (6, 24, 72, 168, 336, 720): A6 monotone fix across these
NEW_H = (1, 3, 12)
LEVELS = tuple(A.LEVELS["ETH"])                   # live ETH grid -2% .. -40%
K = len(LEVELS)
BANDS = A6.band_of("ETH", LEVELS)                 # A4 depth bands: 0 shallow, 1 middle, 2 deep
DEEP_BAND = 2
P_CLIP = 1e-4                                     # A6 P_CLIP before logit p0
PM_CLIP = 0.005                                   # Polymarket price clip before logit
RIDGE = 1.0
MIN_POS_EP = 30                                   # cells with < 30 positive episodes: reported only
CHECK_NEP = 10                                    # deep |ln R| cells need n_ep >= 10 for both rungs (A6)
DEEP_TOL = 0.05
N_HORIZONS_TESTED = 6
ALPHA_DEV = 0.05 / N_HORIZONS_TESTED              # one-sided, Bonferroni over 6 horizons
ALPHA_BLIND = 0.025 / N_HORIZONS_TESTED
R_BAND = (0.8, 1.25)
R105_W_DAYS, R105_KAPPA = 90, 20                  # frozen R10.5 (frozen-r105.json)
FEATURE_MIN_DAYS = 365
DEV_LAST_ORIGIN = A.utc("2026-09-30T23:00:00Z")
Q2_START, Q2_END = A.utc("2026-04-01T00:00:00Z"), A.utc("2026-07-01T00:00:00Z")
LAST_FOLD = "2026Q3"
PM_STALE_H = 3                                    # Polymarket price must be printed in [t - 3 h, t)
NULL_SEED, NULL_REPS, NULL_BLOCK = 20261118, 2000, 30

A6_DIR = "history-forecasts/a6/run-015512cb"
INPUT_FILES = {                                   # datasets-relative
    "eth_price": A.INPUTS["eth_price"][0],
    "binance_ethusdt": "binance-klines/ETHUSDT-1h.json",
    "eth_dvol": A.INPUTS["eth_dvol"][0],
    "a6_pred_eth": f"{A6_DIR}/predictions-dev-ETH.csv.gz",
    "a6_display": f"{A6_DIR}/display-a6.json",
    "r105_frozen": "history-forecasts/r10/r105-run-2d377e73/frozen-r105.json",
}
ACQ_FILES = {"funding": "funding-ethusdt.csv", "hyperliquid": "hl-funding-eth.csv",
             "polymarket_prices": "pm-eth-dip-prices.csv.gz", "polymarket_markets": "pm-eth-markets.csv",
             "counts": "counts-r112.json"}

FEATURES_ALL = ("fund_lvl", "fund_chg24", "dvol_ratio", "hl_fund", "pm_dip", "r105_delta")
FEATURE_REQUIRED = ("fund_lvl", "fund_chg24", "dvol_ratio", "r105_delta")

DECISIONS = {
    "R112-1": "Base rung p0 = (fH) A6 recipe. 6h, 1d, 3d: A6 displayed rung (fH for ETH, A6 D3) with A6's monotone "
              "fix across the six A6 horizons, at every hourly origin; checked equal to the published A6 dev "
              "column p_fH on the 6-hourly grid (else STOP). 1h, 3h, 12h: (fH) unchanged recipe (in-fold HAR OLS, "
              "FHS counts, (f) fallback), running minimum across levels only.",
    "R112-2": "Rung (a) = A6 rung (a) (expanding frequency on the Chainlink-only oracle:ETH series to Q_start - T, as A6 dev_task), the same fixes; checked against p_a.",
    "R112-3": "Origins: every hour for 1h-12h; 00:00Z for 1d and 3d. Labels: A-series long:ETH (Chainlink on the "
              "dev span, oracleLow incl. the round in force at the hour start).",
    "R112-4": "logit p0 enters unstandardised (p0 clipped to [1e-4, 1-1e-4]) so (a=0, b=1, c=0) is the identity; "
              "every x_j is standardised by its training-row mean and sd of the fold.",
    "R112-5": "Funding level = Binance ETHUSDT last fundingRate with calc_time < t. 24h change = level(t) - "
              "level(t - 24h).",
    "R112-6": "DVOL ratio = ln((DVOL close of the candle opening at t - 1h)/100 / sigma_H(t; T)), sigma_H from the "
              "HAR coefficients of the A6-recipe fold that issued the row's p0; (f) sigma_hat if sigma_H is missing.",
    "R112-7": "Hyperliquid funding = last ETH hourly fundingRate with time < t (only if counts pass).",
    "R112-8": "Polymarket dip feature (only if counts pass) = logit(clip(p_yes, 0.005, 0.995)) of one dip market: "
              "among dip ladders active at t (market start < t) whose end >= t + T, the event with the soonest end; "
              "within it the dip strike below S_t nearest S_t(1+k) in |ln|; its last hourly price in [t - 3h, t). "
              "Else missing.",
    "R112-9": "R10.5 delta = -lambda ln R_w with frozen W = 90 d, kappa = 20: rows = 00:00Z p0 rows of the same T "
              "(all levels) with origin + T in (t - 90 d, t]; R_w = (sum p + 1)/(sum y + 1), lambda = n_ev/(n_ev + "
              "20). Empty window -> 0.",
    "R112-10": "Missing feature value (after the training start) -> 0 on the standardised scale (training mean).",
    "R112-11": "Training start = the latest first-data time among included features and p0 (2021-01-01). "
               "First scored quarter = first quarter whose start is >= 365 days after every included feature's "
               "first data time. Training for quarter Q: rows with t >= training start and t + T <= Q start, "
               "expanding; 2026Q2 rows are training rows for 2026Q3.",
    "R112-12": "Fit (D-R11.2b): Newton with backtracking on sum log-loss + 0.5 * 1.0 * ||(a, b, c) - (0, 1, 0)||^2 "
               "(band intercepts penalised toward 0 too), start at the identity, tol 1e-10, at most 100 iterations. "
               "One fit per (T, quarter).",
    "R112-13": "Validated rows: origins in scored quarters, t <= 2026-09-30T23:00Z, label finite, window "
               "[t, t+T] not meeting 2026-04-01..2026-06-30 (those are reported only), and (T, level) cells with "
               ">= 30 positive episodes. Positive episodes = runs of y = 1 over consecutive origins of the T grid, "
               "counted on all p0 rows 2021Q1-2026Q3 (the ETH Chainlink dev span).",
    "R112-14": "DM: d_t = mean over the origin's validated levels of (p_c - y)^2 - (cmp - y)^2, origins in time "
               "order; Newey-West Bartlett lag T_h - 1 (hourly rows) or T_d - 1 (daily rows); HLN factor with "
               "h = lag + 1; one-sided p = t-cdf(DM_HLN, n - 1). Pass needs p < 0.05/6 vs p0 AND vs (a).",
    "R112-15": "Pooled R = sum p_c / sum y on validated rows; must lie in [0.8, 1.25].",
    "R112-16": "Deep-band median |ln R|: cells = deep levels (-20..-40%) x regimes low and high (pooled, A6 "
               "'low+high' reading), validated rows, n_ep >= 10 and finite positive R for p_c and p0. Pass needs "
               "median(p_c) - median(p0) <= 0.05. No eligible cell -> not testable, does not block.",
    "R112-17": "Feature-drop (reported): frozen fits with that standardised feature set to 0; BSS = 1 - "
               "Brier(full)/Brier(drop).",
    "R112-18": "Blind/forward coefficients = the 2026Q3 fold fit per T (frozen-r112-coefs.json, hashed before any "
               "score). Forward test: R11.3c aGRAPA e-process (r113_controller code) on daily d_t = Brier(p0) - "
               "Brier(p_c) over the issue's resolved rows, alpha = 0.025/6, 3d as 3 interleaved subsequences.",
}


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def git_sha():
    return subprocess.check_output(["git", "-C", HERE, "rev-parse", "HEAD"], text=True).strip()


def git_clean():
    out = subprocess.check_output(["git", "-C", HERE, "status", "--porcelain", "--", "."], text=True)
    return not [ln for ln in out.splitlines() if not ln.startswith("??")]


def guard_text(s):
    if ADDR_RE.search(s):
        raise SystemExit("STOP: address-like string in an output")


def write_json(path, obj):
    s = json.dumps(obj, indent=1, sort_keys=False, default=float)
    guard_text(s)
    with open(path, "w") as f:
        f.write(s + "\n")
    with open(path + ".sha256", "w") as f:
        f.write(f"{sha256_file(path)}  {os.path.basename(path)}\n")
    return sha256_file(path)


def logit(p, c=P_CLIP):
    p = np.clip(np.asarray(p, float), c, 1.0 - c)
    return np.log(p) - np.log1p(-p)


def quarter_of(ts):
    d = datetime.fromtimestamp(ts, tz=timezone.utc)
    return f"{d.year}Q{(d.month - 1) // 3 + 1}"


def quarter_start_ts(name):
    y, q = int(name[:4]), int(name[-1])
    return A.quarter_start(y, q)


def next_quarter(name):
    y, q = int(name[:4]), int(name[-1])
    return f"{y}Q{q + 1}" if q < 4 else f"{y + 1}Q1"


# ---------------------------------------------------------------------------------------------
# Base rung p0 and rung (a) on the hourly origin grid
# ---------------------------------------------------------------------------------------------
def build_series(datasets):
    D = M3.build_dev(datasets)
    A6.attach_highs_dev(datasets, D)
    return D["long:ETH"], D["oracle:ETH"]


def fold_raw(ser, P6, Pa, T, qs_i, te):
    """(fH) with the (f) fallback, (a) (frequency on the oracle-only series, as A6 dev_task), and sigma_H at the
    test origins, one fold."""
    P = P6.P
    lim = qs_i - T
    tr = P6.i <= lim
    coef, _ = P6.har_coef(qs_i)
    sH = P6.sigma_H(coef)
    zH, vH = P6.z_of(sH)
    sH_te = P6.sigma_H(coef, P6.X[te], P6.okX[te])
    pH = M2.fhs_predict(zH[vH & tr], P.thresholds(sH_te))
    pf = M2.fhs_predict(P.z[1.0][P.valid[1.0] & tr], P.thresholds(ser.sigma[te]))
    fb = ~np.all(np.isfinite(pH), axis=1)
    pH[fb] = pf[fb]
    pa = np.tile(Pa.freq_upto(lim), (len(te), 1))
    sig = np.where(np.isfinite(sH_te) & (sH_te > 0), sH_te, ser.sigma[te])
    return pH, pa, sig


def build_base(ser, oser, log=print):
    folds = M3.dev_folds(ser)
    allH = tuple(sorted(set(A6_H) | set(NEW_H)))
    preps = {T: A6.Prep6(ser, T, with_fbL=False) for T in allH}
    preps_a = {T: (preps[T].P if oser is ser else M3.Prep3(oser, T, beta_select=False)) for T in allH}
    te_all, fold_all = [], []
    raw = {T: {"p0": [], "pa": [], "sig": []} for T in allH}
    for fi, f in enumerate(folds):
        te = np.arange(f["qs_i"], min(f["qe_i"], ser.n_orig))
        te_all.append(te)
        fold_all.append(np.full(len(te), fi))
        for T in allH:
            pH, pa, sig = fold_raw(ser, preps[T], preps_a[T], T, f["qs_i"], te)
            raw[T]["p0"].append(pH)
            raw[T]["pa"].append(pa)
            raw[T]["sig"].append(sig)
    te_all = np.concatenate(te_all)
    fold_all = np.concatenate(fold_all)
    cat = {T: {k: np.concatenate(v) for k, v in d.items()} for T, d in raw.items()}
    base = {"te": te_all, "fold": fold_all, "fold_names": [f["name"] for f in folds],
            "ts": ser.base_ts + STEP * te_all, "regime": ser.regime[te_all], "spot": ser.spot[te_all]}
    # A6 monotone fix across the six A6 horizons, per rung
    for rung in ("p0", "pa"):
        G = np.stack([cat[T][rung] for T in A6_H], axis=1)
        if np.isnan(G).any():
            raise SystemExit(f"STOP: gaps in the A6-horizon {rung} grid")
        F = A.monotone_fix(G)
        for ti, T in enumerate(A6_H):
            cat[T][rung + "_fixed"] = F[:, ti, :]
    for T in NEW_H:
        for rung in ("p0", "pa"):
            cat[T][rung + "_fixed"] = np.minimum.accumulate(cat[T][rung], axis=1)
    for T, _, _ in HORIZONS:
        base[T] = {"p0": cat[T]["p0_fixed"], "pa": cat[T]["pa_fixed"], "sig": cat[T]["sig"],
                   "y": ser.labels(T)[te_all]}
    log(f"base built: {len(te_all)} hourly origins, folds {base['fold_names'][0]}..{base['fold_names'][-1]}")
    return base


def verify_a6(base, path, log=print):
    """p0 and (a) at 6h, 1d, 3d on the A6 6-hourly grid must equal the published A6 dev predictions."""
    import pandas as pd
    pub = pd.read_csv(path, usecols=["t0", "T", "k", "y", "p_a", "p_fH"])
    lab = {"6h": 6, "1d": 24, "3d": 72}
    pub = pub[pub["T"].isin(lab)]
    umap = {u: A.utc(u) for u in pub["t0"].unique()}
    ts_pub = pub["t0"].map(umap).to_numpy().astype(np.int64)
    pos = {int(t): j for j, t in enumerate(base["ts"])}
    out = {}
    for TL, T in lab.items():
        m = (pub["T"] == TL).to_numpy()
        j = np.array([pos[int(t)] for t in ts_pub[m]])
        ki = np.array([LEVELS.index(float(k)) for k in pub["k"].to_numpy()[m]])
        d0 = np.abs(base[T]["p0"][j, ki] - pub["p_fH"].to_numpy()[m])
        da = np.abs(base[T]["pa"][j, ki] - pub["p_a"].to_numpy()[m])
        dy = np.abs(base[T]["y"][j, ki] - pub["y"].to_numpy()[m])
        out[TL] = {"rows": int(m.sum()), "max_abs_diff_p0": float(d0.max()), "max_abs_diff_pa": float(da.max()),
                   "max_abs_diff_y": float(np.nanmax(dy))}
        if d0.max() > 1e-9 or da.max() > 1e-9 or np.nanmax(dy) > 0:
            raise SystemExit(f"STOP: base rung differs from the published A6 dev predictions at {TL}: {out[TL]}")
    log(f"A6 check passed: {out}")
    return out


# ---------------------------------------------------------------------------------------------
# Features
# ---------------------------------------------------------------------------------------------
def load_step_series(path, tcol, vcol, scale_ms=True):
    tt, vv = [], []
    with open(path) as f:
        for r in csv.DictReader(f):
            tt.append(int(r[tcol]) / (1000.0 if scale_ms else 1.0))
            vv.append(float(r[vcol]))
    o = np.argsort(tt, kind="mergesort")
    return np.asarray(tt)[o], np.asarray(vv)[o]


def last_before(tt, vv, t):
    """value of the last row with time < t (strictly), NaN if none."""
    j = np.searchsorted(tt, t, side="left") - 1
    out = np.full(len(t), np.nan)
    ok = j >= 0
    out[ok] = vv[j[ok]]
    return out


def load_dvol(path):
    d = json.load(open(path))
    m = {}
    for row in d["rows"]:
        if row[4] is not None:
            m[int(row[0]) // 1000] = float(row[4])
    return m


def load_pm(acq):
    mk = {}
    with open(os.path.join(acq, ACQ_FILES["polymarket_markets"])) as f:
        for r in csv.DictReader(f):
            if r["side"] not in ("dip", "dip_legacy"):
                continue
            mk[r["market_id"]] = {"event": r["event_slug"], "strike": float(r["strike"]), "start": int(r["start"]),
                                  "end": int(r["end"])}
    px = {}
    with gzip.open(os.path.join(acq, ACQ_FILES["polymarket_prices"]), "rt") as f:
        for r in csv.DictReader(f):
            px.setdefault(r["market_id"], []).append((int(r["t"]), float(r["p_yes"])))
    ev = {}
    for mid, m in mk.items():
        if mid not in px:
            continue
        s = sorted(px[mid])
        m["t"] = np.array([a for a, _ in s], float)
        m["p"] = np.array([b for _, b in s], float)
        e = ev.setdefault(m["event"], {"end": m["end"], "markets": []})
        e["end"] = max(e["end"], m["end"])
        e["markets"].append(mid)
    return mk, ev


def pm_feature(mk, ev, ts, spot, T):
    """(n, K) Polymarket dip feature (R112-8)."""
    out = np.full((len(ts), K), np.nan)
    evl = sorted(ev.items(), key=lambda kv: (kv[1]["end"], kv[0]))
    ends = [e["end"] for _, e in evl]
    starts = {name: min(mk[m]["start"] for m in e["markets"]) for name, e in evl}
    first = min(starts.values()) if starts else None
    for n, (t, s) in enumerate(zip(ts, spot)):
        if first is None or t < first or not np.isfinite(s):
            continue
        for name, e in evl[bisect.bisect_left(ends, t + T * STEP):]:
            if starts[name] >= t:
                continue
            cand = []
            for mid in e["markets"]:
                m = mk[mid]
                if m["start"] >= t or m["end"] < t + T * STEP or m["strike"] >= s:
                    continue
                j = bisect.bisect_left(m["t"], t) - 1
                if j < 0 or m["t"][j] < t - PM_STALE_H * STEP:
                    continue
                cand.append((m["strike"], m["p"][j]))
            if not cand:
                continue
            ks = np.array([c[0] for c in cand])
            ps = np.array([c[1] for c in cand])
            tgt = s * (1.0 + np.asarray(LEVELS))
            idx = np.argmin(np.abs(np.log(ks[None, :] / tgt[:, None])), axis=1)
            out[n] = logit(ps[idx], PM_CLIP)
            break
    return out


def r105_delta(base, T, ts_query):
    """R112-9 as-of R10.5 delta at each query time (one value per origin, all levels)."""
    b = base[T]
    m00 = (base["ts"] % DAY) == 0
    y = b["y"][m00]
    p = b["p0"][m00]
    ok = np.all(np.isfinite(y), axis=1)
    res = base["ts"][m00][ok] + T * STEP
    sp = p[ok].sum(axis=1)
    sy = y[ok].sum(axis=1)
    o = np.argsort(res, kind="mergesort")
    res, sp, sy = res[o], sp[o], sy[o]
    csp = np.concatenate([[0.0], np.cumsum(sp)])
    csy = np.concatenate([[0.0], np.cumsum(sy)])
    hi = np.searchsorted(res, ts_query, side="right")
    lo = np.searchsorted(res, ts_query - R105_W_DAYS * DAY, side="right")
    SP = csp[hi] - csp[lo]
    SY = csy[hi] - csy[lo]
    Rw = (SP + 1.0) / (SY + 1.0)
    lam = SY / (SY + R105_KAPPA)
    return -lam * np.log(Rw)


def feature_starts(acq, datasets, included):
    st = {"p0": A.utc("2021-01-01T00:00:00Z")}
    tt, _ = load_step_series(os.path.join(acq, ACQ_FILES["funding"]), "calc_time_ms", "last_funding_rate")
    st["fund_lvl"] = float(tt[0])
    st["fund_chg24"] = float(tt[0]) + DAY
    dv = load_dvol(os.path.join(datasets, INPUT_FILES["eth_dvol"]))
    st["dvol_ratio"] = float(min(dv)) + STEP
    st["r105_delta"] = st["p0"]
    if "hl_fund" in included:
        tt, _ = load_step_series(os.path.join(acq, ACQ_FILES["hyperliquid"]), "time_ms", "funding_rate")
        st["hl_fund"] = float(tt[0])
    if "pm_dip" in included:
        with gzip.open(os.path.join(acq, ACQ_FILES["polymarket_prices"]), "rt") as f:
            st["pm_dip"] = float(min(int(r["t"]) for r in csv.DictReader(f)))
    return st


def first_scored_quarter(starts):
    need = max(starts.values()) + FEATURE_MIN_DAYS * DAY
    q = "2021Q1"
    while quarter_start_ts(q) < need:
        q = next_quarter(q)
    return q


def build_features(base, T, grid, included, datasets, acq, cache):
    """Rows of horizon T: origin positions, then raw feature arrays (n,) or (n, K)."""
    ts_all = base["ts"]
    sel = np.ones(len(ts_all), bool) if grid == "hourly" else (ts_all % DAY) == 0
    pos = np.where(sel)[0]
    ts = ts_all[pos]
    F = {}
    if "fund" not in cache:
        cache["fund"] = load_step_series(os.path.join(acq, ACQ_FILES["funding"]), "calc_time_ms",
                                         "last_funding_rate")
    tt, vv = cache["fund"]
    F["fund_lvl"] = last_before(tt, vv, ts)
    F["fund_chg24"] = F["fund_lvl"] - last_before(tt, vv, ts - DAY)
    if "dvol" not in cache:
        cache["dvol"] = load_dvol(os.path.join(datasets, INPUT_FILES["eth_dvol"]))
    dv = np.array([cache["dvol"].get(int(t) - STEP, np.nan) for t in ts])
    with np.errstate(invalid="ignore", divide="ignore"):
        F["dvol_ratio"] = np.log((dv / 100.0) / base[T]["sig"][pos])
    if "hl_fund" in included:
        if "hl" not in cache:
            cache["hl"] = load_step_series(os.path.join(acq, ACQ_FILES["hyperliquid"]), "time_ms", "funding_rate")
        F["hl_fund"] = last_before(*cache["hl"], ts)
    if "pm_dip" in included:
        if "pm" not in cache:
            cache["pm"] = load_pm(acq)
        F["pm_dip"] = pm_feature(*cache["pm"], ts, base["spot"][pos], T)
    F["r105_delta"] = r105_delta(base, T, ts)
    return pos, ts, {k: F[k] for k in included}


# ---------------------------------------------------------------------------------------------
# Combiner
# ---------------------------------------------------------------------------------------------
def design(lp0, Z, bands):
    """X = [band one-hot (3), logit p0, Z...] for flattened rows."""
    n = len(lp0)
    B = np.zeros((n, 3))
    B[np.arange(n), bands] = 1.0
    return np.column_stack([B, lp0, Z]) if Z.shape[1] else np.column_stack([B, lp0])


def fit_ridge(X, y, n_feat, lam=RIDGE, tol=1e-10, max_iter=100):
    p = X.shape[1]
    th0 = np.zeros(p)
    th0[3] = 1.0
    pen = np.full(p, lam)          # D-R11.2b: the band intercepts are penalised toward 0 as well (1h deep band
    #                                has no positive training row, so an unpenalised intercept has no finite MLE)

    def obj(t):
        e = X @ t
        return float(np.sum(np.logaddexp(0.0, e) - y * e) + 0.5 * np.sum(pen * (t - th0) ** 2))

    th = th0.copy()
    f = obj(th)
    info = {"converged": False}
    for it in range(1, max_iter + 1):
        eta = X @ th
        mu = expit(eta)
        g = X.T @ (mu - y) + pen * (th - th0)
        w = mu * (1.0 - mu)
        H = (X * w[:, None]).T @ X + np.diag(pen)
        step = np.linalg.solve(H, g)
        s_ = 1.0
        while True:                # backtracking on the convex objective
            cand = th - s_ * step
            fc = obj(cand)
            if fc <= f + 1e-12 * abs(f) or s_ < 1e-8:
                break
            s_ *= 0.5
        th, f = cand, fc
        if np.max(np.abs(s_ * step)) < tol:
            info = {"converged": True}
            break
    eta = X @ th
    ll = float(np.sum(np.logaddexp(0.0, eta) - y * eta))
    info.update({"iterations": it, "neg_loglik": ll, "penalty": float(0.5 * np.sum(pen * (th - th0) ** 2)),
                 "n_rows": int(len(y))})
    return th, info


def standardise(F, rows_tr, included):
    mu, sd = {}, {}
    for j in included:
        v = F[j][rows_tr]
        v = v[np.isfinite(v)]
        mu[j] = float(v.mean()) if len(v) else 0.0
        s = float(v.std()) if len(v) else 1.0
        sd[j] = s if s > 0 else 1.0
    return mu, sd


def z_matrix(F, rows, included, mu, sd, drop=None):
    """(len(rows), K, m) standardised features, missing -> 0, drop -> 0."""
    Z = np.zeros((len(rows), K, len(included)))
    for c, j in enumerate(included):
        if j == drop:
            continue
        v = F[j][rows]
        if v.ndim == 1:
            v = np.repeat(v[:, None], K, axis=1)
        z = (v - mu[j]) / sd[j]
        Z[:, :, c] = np.where(np.isfinite(z), z, 0.0)
    return Z


def predict(th, lp0_rows, Z):
    n = lp0_rows.shape[0]
    X = design(lp0_rows.ravel(), Z.reshape(n * K, -1), np.tile(BANDS, n))
    p = expit(X @ th).reshape(n, K)
    return np.minimum.accumulate(p, axis=1)


def walk_forward(base, T, pos, ts, F, included, q_first, log=print):
    """One fit per scored quarter. Returns fits {quarter: {...}} and predictions for test rows."""
    b = base[T]
    y = b["y"][pos]
    lp0 = logit(b["p0"][pos])
    train_start = max(A.utc("2021-01-01T00:00:00Z"), FIT_STATE["train_start"])
    qs = []
    q = q_first
    while q != next_quarter(LAST_FOLD):
        qs.append(q)
        q = next_quarter(q)
    fits, pred = {}, {"rows": [], "pc": [], "drop": {j: [] for j in included}}
    for q in qs:
        qs_ts, qe_ts = quarter_start_ts(q), quarter_start_ts(next_quarter(q))
        tr = (ts >= train_start) & (ts + T * STEP <= qs_ts) & np.all(np.isfinite(y), axis=1)
        rows_tr = np.where(tr)[0]
        mu, sd = standardise(F, rows_tr, included)
        Ztr = z_matrix(F, rows_tr, included, mu, sd)
        X = design(lp0[rows_tr].ravel(), Ztr.reshape(len(rows_tr) * K, -1), np.tile(BANDS, len(rows_tr)))
        th, info = fit_ridge(X, y[rows_tr].ravel(), len(included))
        te = np.where((ts >= qs_ts) & (ts < qe_ts) & (ts <= DEV_LAST_ORIGIN))[0]
        Zte = z_matrix(F, te, included, mu, sd)
        pred["rows"].append(te)
        pred["pc"].append(predict(th, lp0[te], Zte))
        for j in included:
            pred["drop"][j].append(predict(th, lp0[te], z_matrix(F, te, included, mu, sd, drop=j)))
        fits[q] = {"theta": {"a_band0": th[0], "a_band1": th[1], "a_band2": th[2], "b_logit_p0": th[3],
                             **{f"c_{j}": th[4 + c] for c, j in enumerate(included)}},
                   "mu": mu, "sd": sd, "train_origins": int(len(rows_tr)),
                   "train_first": A.iso(int(ts[rows_tr[0]])) if len(rows_tr) else None,
                   "train_last": A.iso(int(ts[rows_tr[-1]])) if len(rows_tr) else None,
                   "missing_share_train": {j: float(np.mean(~np.isfinite(F[j][rows_tr]))) for j in included},
                   **info}
        log(f"  T={T}h {q}: train origins {len(rows_tr)}, test origins {len(te)}, iters {info['iterations']}, "
            f"converged {info['converged']}")
    rows = np.concatenate(pred["rows"])
    return fits, rows, np.concatenate(pred["pc"]), {j: np.concatenate(v) for j, v in pred["drop"].items()}


FIT_STATE = {}


# ---------------------------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------------------------
def count_pos_episodes(yk, step_ok):
    """runs of y = 1 over consecutive grid origins; step_ok[i] = origin i follows origin i-1 on the grid."""
    pos = yk == 1
    start = pos.copy()
    start[1:] = pos[1:] & ~(pos[:-1] & step_ok[1:])
    return int(start.sum())


def dm_one_sided(d, L):
    r = A6.dm_test(np.asarray(d, float), L)
    if r is None or r.get("dm_hln") is None:
        return {"n": len(d), "lag": L, "mean_diff": float(np.mean(d)) if len(d) else None, "dm_hln": None,
                "p_one_sided": None}
    p1 = float(student_t.cdf(r["dm_hln"], r["n"] - 1))
    return {"n": r["n"], "lag": L, "mean_diff": r["mean_diff"], "dm_hln": r["dm_hln"], "p_one_sided": p1}


def ratio_cells(P, Y, reg, grid_step_ok, levels_mask, regimes=(0, 2)):
    """per (level, regime) R and n_ep over rows (n, K)."""
    out = {}
    for k in range(K):
        if not levels_mask[k]:
            continue
        for g in regimes:
            m = (reg == g) & np.isfinite(Y[:, k])
            if not m.any():
                continue
            yk = Y[m, k]
            idx = np.where(m)[0]
            step = np.zeros(len(idx), bool)
            step[1:] = np.diff(idx) == 1
            step[1:] &= grid_step_ok[idx[1:]]
            out[(k, g)] = {"n_ep": count_pos_episodes(yk, step), "sum_y": float(yk.sum()),
                           "sum_p": {r: float(P[r][m, k].sum()) for r in P}}
    return out


def deep_median(cells, rungs):
    vals = {r: [] for r in rungs}
    used = 0
    for (k, g), c in cells.items():
        if BANDS[k] != DEEP_BAND or c["n_ep"] < CHECK_NEP or c["sum_y"] <= 0:
            continue
        Rs = {r: c["sum_p"][r] / c["sum_y"] for r in rungs}
        if any(not (R > 0 and math.isfinite(R)) for R in Rs.values()):
            continue
        used += 1
        for r in rungs:
            vals[r].append(abs(math.log(Rs[r])))
    return {"cells": used, "median_abs_lnR": {r: (float(np.median(v)) if v else None) for r, v in vals.items()}}


def brier_rows(P, Y, mask2):
    return float(np.mean((P[mask2] - Y[mask2]) ** 2)) if mask2.any() else None


def score_T(T, TL, grid, ts, Y, reg, P, drop, cell_ok, log=print):
    """P: {'pc','p0','pa'} (n, K) on the predicted rows (time order)."""
    n = len(ts)
    win_q2 = (ts + T * STEP > Q2_START) & (ts < Q2_END)
    valid_o = ~win_q2 & (ts <= DEV_LAST_ORIGIN)
    fin = np.isfinite(Y)
    lvl = cell_ok[None, :] & fin
    V = valid_o[:, None] & lvl
    grid_step = 1 if grid == "hourly" else 24
    step_ok = np.zeros(n, bool)
    step_ok[1:] = np.diff(ts) == grid_step * STEP
    res = {"T": TL, "grid": grid, "origins_predicted": int(n), "origins_validated": int(valid_o.sum()),
           "rows_validated": int(V.sum()), "cells_scored": [float(LEVELS[k]) for k in range(K) if cell_ok[k]],
           "cells_reported_only": [float(LEVELS[k]) for k in range(K) if not cell_ok[k]]}
    if not V.any():
        res["pass"] = False
        res["reason"] = "no validated rows"
        return res
    L = (T - 1) if grid == "hourly" else (T // 24 - 1)
    o_ok = V.any(axis=1)
    se = {r: np.where(V, (P[r] - np.nan_to_num(Y)) ** 2, 0.0) for r in P}
    cnt = V.sum(axis=1)
    per_o = {r: se[r][o_ok].sum(axis=1) / cnt[o_ok] for r in P}
    dm = {cmp: dm_one_sided(per_o["pc"] - per_o[cmp], L) for cmp in ("p0", "pa")}
    sy = float(np.nan_to_num(Y)[V].sum())
    R = {r: (float(P[r][V].sum()) / sy if sy > 0 else None) for r in P}
    cells = ratio_cells({r: np.where(valid_o[:, None], P[r], np.nan) for r in P},
                        np.where(valid_o[:, None], Y, np.nan), reg, step_ok, cell_ok)
    deep = deep_median(cells, ("pc", "p0", "pa"))
    br = {r: brier_rows(P[r], Y, V) for r in P}
    dm_ok = all(dm[c]["p_one_sided"] is not None and dm[c]["p_one_sided"] < ALPHA_DEV and dm[c]["mean_diff"] < 0
                for c in dm)
    R_ok = R["pc"] is not None and R_BAND[0] <= R["pc"] <= R_BAND[1]
    m_c, m_0 = deep["median_abs_lnR"]["pc"], deep["median_abs_lnR"]["p0"]
    deep_testable = deep["cells"] > 0 and m_c is not None and m_0 is not None
    deep_ok = (m_c - m_0 <= DEEP_TOL) if deep_testable else True
    res.update({"dm_lag": L, "alpha": ALPHA_DEV, "dm": dm, "brier": br,
                "bss_vs_p0": 1.0 - br["pc"] / br["p0"], "bss_vs_a": 1.0 - br["pc"] / br["pa"],
                "bss_p0_vs_a": 1.0 - br["p0"] / br["pa"], "pooled_R": R, "deep": deep,
                "deep_testable": deep_testable,
                "checks": {"dm_both": dm_ok, "R_in_band": R_ok, "deep_ok": deep_ok},
                "pass": bool(dm_ok and R_ok and deep_ok)})
    # reported only
    res["corp"] = {r: A6.corp(P[r][V], Y[V]) for r in P}
    res["feature_drop_bss"] = {j: 1.0 - br["pc"] / brier_rows(drop[j], Y, V) for j in drop}
    yrs = {}
    yr = np.array([datetime.fromtimestamp(int(t), tz=timezone.utc).year for t in ts])
    for y_ in sorted(set(yr[valid_o])):
        m = V & (yr == y_)[:, None]
        b = {r: brier_rows(P[r], Y, m) for r in P}
        yrs[str(y_)] = {"rows": int(m.sum()), "bss_vs_p0": 1.0 - b["pc"] / b["p0"], "bss_vs_a": 1.0 - b["pc"] / b["pa"]}
    res["per_year"] = yrs
    Q2 = win_q2[:, None] & lvl
    if Q2.any():
        b = {r: brier_rows(P[r], Y, Q2) for r in P}
        sy2 = float(np.nan_to_num(Y)[Q2].sum())
        res["q2_2026_reported_only"] = {"rows": int(Q2.sum()), "brier": b, "bss_vs_p0": 1.0 - b["pc"] / b["p0"],
                                        "bss_vs_a": 1.0 - b["pc"] / b["pa"],
                                        "R_pc": float(P["pc"][Q2].sum()) / sy2 if sy2 > 0 else None}
    # all cells incl. reported-only cells, reported
    Vall = valid_o[:, None] & fin
    res["all_cells_reported"] = {"rows": int(Vall.sum()),
                                 "brier": {r: brier_rows(P[r], Y, Vall) for r in P}}
    # daily d for the e-process design (00:00Z origins only)
    m00 = (ts % DAY == 0) & o_ok
    if m00.any():
        idx00 = np.where(m00[o_ok])[0]
        d00 = (per_o["p0"] - per_o["pc"])[idx00]
        days = np.array([np.datetime64(A.iso(int(t))[:10], "D") for t in ts[o_ok][idx00]])
        res["_daily"] = (days, d00)
    log(f"  {TL}: pass={res['pass']} dm p0 p={dm['p0']['p_one_sided']} a p={dm['pa']['p_one_sided']} "
        f"R={R['pc']} deep={deep['median_abs_lnR']}")
    return res


# ---------------------------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------------------------
def frozen_config(datasets, acq, created=None):
    counts = json.load(open(os.path.join(acq, ACQ_FILES["counts"])))
    included = list(FEATURE_REQUIRED[:3]) + \
        (["hl_fund"] if counts.get("hyperliquid", {}).get("enters") else []) + \
        (["pm_dip"] if counts.get("polymarket", {}).get("enters") else []) + ["r105_delta"]
    inputs = {k: {"path": v, "sha256": sha256_file(os.path.join(datasets, v))} for k, v in INPUT_FILES.items()}
    for k, v in ACQ_FILES.items():
        p = os.path.join(acq, v)
        if k.startswith("hyperliquid") and "hl_fund" not in included:
            continue
        if k.startswith("polymarket") and "pm_dip" not in included:
            continue
        inputs[k] = {"path": f"acq/{v}", "sha256": sha256_file(p)}
    starts = feature_starts(acq, datasets, included)
    cfg = {"schema": "q26-r112/frozen-config/1", "created_utc": created or now_iso(), "prereg": PREREG,
           "code": {"repo": "The-Membrane/membrane-app", "sha": git_sha(),
                    "path": "scripts/research/history-forecasts/r112_combine.py",
                    "sha256": sha256_file(os.path.abspath(__file__)), "clean": git_clean()},
           "inputs": inputs, "counts": counts, "included_features": included,
           "feature_first_times": {k: A.iso(int(v)) for k, v in starts.items()},
           "training_start": A.iso(int(max(starts.values()))),
           "first_scored_quarter": first_scored_quarter(starts), "last_fold": LAST_FOLD,
           "constants": {"horizons": [h[1] for h in HORIZONS], "levels": list(LEVELS), "bands": BANDS.tolist(),
                         "ridge": RIDGE, "p_clip": P_CLIP, "pm_clip": PM_CLIP, "min_pos_episodes": MIN_POS_EP,
                         "check_nep": CHECK_NEP, "deep_tol": DEEP_TOL, "alpha_dev_one_sided": ALPHA_DEV,
                         "alpha_blind": ALPHA_BLIND, "R_band": list(R_BAND), "r105": [R105_W_DAYS, R105_KAPPA],
                         "dev_last_origin": A.iso(DEV_LAST_ORIGIN), "q2_reported_only": [A.iso(Q2_START),
                                                                                          A.iso(Q2_END)],
                         "pm_stale_h": PM_STALE_H, "feature_min_days": FEATURE_MIN_DAYS},
           "seeds": {"null_false_pass": NULL_SEED, "null_reps": NULL_REPS, "null_block_days": NULL_BLOCK},
           "decisions": DECISIONS,
           "blind": {"start": "first 00:00Z live issue strictly after created_utc",
                     "horizons_from_log": ["6h", "1d", "3d"], "horizons_after_the_fact": ["1h", "3h", "12h"],
                     "p0": "6h/1d/3d: logged p_displayed. 1h/3h/12h: (fH) refit at asof on origins t + T <= asof "
                           "from the live round store (A6 recipe, as the live issuer refits)",
                     "features": "as of asof only: Binance funding (fapi or monthly file), Deribit DVOL candle "
                                 "opening at asof - 1h, Hyperliquid fundingHistory, Polymarket CLOB history, R10.5 "
                                 "delta from resolved forward rows of the same T",
                     "coefficients": "frozen-r112-coefs.json, fold 2026Q3 per T",
                     "test": "R11.3c aGRAPA e-process on d_t = Brier(p0) - Brier(p_c), alpha 0.025/6; plus "
                             "median |ln R| of p_c <= that of p0 with >= 30 resolved issue days",
                     "truth": "HISTORY_TOUCH_LIVE L.4 Chainlink round store; rows touched before issue excluded"}}
    return cfg


def cmd_freeze(a):
    path = os.path.join(a.out, "frozen-r112-config.json")
    if os.path.exists(path):
        raise SystemExit("STOP: frozen config exists")
    os.makedirs(a.out, exist_ok=True)
    cfg = frozen_config(a.datasets, a.acq)
    if not cfg["code"]["clean"]:
        raise SystemExit("STOP: code tree not clean")
    h = write_json(path, cfg)
    print(json.dumps({"frozen_config_sha256": h, "created_utc": cfg["created_utc"],
                      "included": cfg["included_features"], "first_scored_quarter": cfg["first_scored_quarter"],
                      "training_start": cfg["training_start"]}, indent=1))


def cmd_run(a):
    t_start = time.time()
    logf = open(os.path.join(a.out, "run-log.txt"), "a")

    def log(s):
        line = f"{now_iso()} {s}"
        print(line, flush=True)
        logf.write(line + "\n")
        logf.flush()

    cpath = os.path.join(a.out, "frozen-r112-config.json")
    cfg = json.load(open(cpath))
    want = open(cpath + ".sha256").read().split()[0]
    if sha256_file(cpath) != want:
        raise SystemExit("STOP: frozen config hash mismatch")
    if cfg["code"]["sha"] != git_sha() or not git_clean():
        raise SystemExit("STOP: code sha differs from the frozen config or tree not clean")
    for k, v in cfg["inputs"].items():
        p = os.path.join(a.acq, v["path"][4:]) if v["path"].startswith("acq/") else os.path.join(a.datasets, v["path"])
        if sha256_file(p) != v["sha256"]:
            raise SystemExit(f"STOP: input {k} sha256 differs")
    for p in ("results-r112.json", "frozen-r112-coefs.json"):
        if os.path.exists(os.path.join(a.out, p)):
            raise SystemExit(f"STOP: {p} exists; one run")
    log(f"run start; config sha256 {want}; code {cfg['code']['sha']}")
    included = cfg["included_features"]
    FIT_STATE["train_start"] = A.utc(cfg["training_start"])
    q_first = cfg["first_scored_quarter"]
    ser, oser = build_series(a.datasets)
    base = build_base(ser, oser, log)
    a6check = verify_a6(base, os.path.join(a.datasets, INPUT_FILES["a6_pred_eth"]), log)
    cache, per_T = {}, {}
    for T, TL, grid in HORIZONS:
        pos, ts, F = build_features(base, T, grid, included, a.datasets, a.acq, cache)
        Y = base[T]["y"][pos]
        # positive episodes per level over all p0 rows of the T grid (R112-13)
        fin0 = np.all(np.isfinite(Y), axis=1)
        tsf = ts[fin0]
        step_ok = np.zeros(len(tsf), bool)
        step_ok[1:] = np.diff(tsf) == (STEP if grid == "hourly" else DAY)
        n_ep = [count_pos_episodes(Y[fin0, k], step_ok) for k in range(K)]
        cell_ok = np.array([e >= MIN_POS_EP for e in n_ep])
        fits, rows, pc, drop = walk_forward(base, T, pos, ts, F, included, q_first, log)
        feat_cov = {j: float(np.mean(np.isfinite(F[j][rows]))) for j in included}
        per_T[TL] = {"T": T, "grid": grid, "pos": pos, "ts": ts, "Y": Y, "rows": rows, "pc": pc, "drop": drop,
                     "fits": fits, "n_ep": n_ep, "cell_ok": cell_ok, "feat_cov_test": feat_cov}
    # freeze the coefficients before any score
    coefs = {"schema": "q26-r112/coefs/1", "created_utc": now_iso(), "config_sha256": want,
             "included_features": included, "first_scored_quarter": q_first,
             "forward_fold": LAST_FOLD,
             "forward": {TL: d["fits"][LAST_FOLD] for TL, d in per_T.items()},
             "all_folds": {TL: d["fits"] for TL, d in per_T.items()},
             "positive_episodes_dev": {TL: dict(zip([repr(k) for k in LEVELS], d["n_ep"])) for TL, d in per_T.items()},
             "cells_scored": {TL: [float(LEVELS[k]) for k in range(K) if d["cell_ok"][k]] for TL, d in per_T.items()}}
    hc = write_json(os.path.join(a.out, "frozen-r112-coefs.json"), coefs)
    log(f"coefficients frozen sha256 {hc} (before any score)")
    # score
    results = {"schema": "q26-r112/results/1", "config_sha256": want, "coefs_sha256": hc, "a6_check": a6check,
               "included_features": included, "first_scored_quarter": q_first, "horizons": {}}
    daily = {}
    pred_rows = []
    for TL, d in per_T.items():
        T, grid, rows = d["T"], d["grid"], d["rows"]
        ts = d["ts"][rows]
        Y = d["Y"][rows]
        P = {"pc": d["pc"], "p0": base[T]["p0"][d["pos"][rows]], "pa": base[T]["pa"][d["pos"][rows]]}
        reg = base["regime"][d["pos"][rows]]
        r = score_T(T, TL, grid, ts, Y, reg, P, d["drop"], d["cell_ok"], log)
        if "_daily" in r:
            daily[TL] = r.pop("_daily")
        r["feature_coverage_test"] = d["feat_cov_test"]
        r["positive_episodes_dev"] = d["n_ep"]
        results["horizons"][TL] = r
        pred_rows.append((TL, ts, Y, P))
    # reported only: false-pass rate of the blind e-process on dev daily d (block sign flips)
    try:
        import r113_controller as R113
        fp = {}
        for TL, (days, d00) in daily.items():
            if len(d00) >= 60:
                fp[TL] = R113.null_false_pass(days, d00, "3d" if TL == "3d" else TL, alpha=ALPHA_BLIND,
                                              reps=NULL_REPS, seed=NULL_SEED, block=NULL_BLOCK)
                fp[TL]["dev_eprocess"] = R113.eprocess_decision(days, d00, "3d" if TL == "3d" else TL,
                                                                alpha=ALPHA_BLIND)
        results["blind_eprocess_null_check_reported_only"] = fp
    except Exception as e:      # reported only; logged
        results["blind_eprocess_null_check_reported_only"] = {"error": repr(e)}
    results["verdicts"] = {TL: results["horizons"][TL]["pass"] for TL in results["horizons"]}
    results["runtime_s"] = time.time() - t_start
    results["finished_utc"] = now_iso()
    write_json(os.path.join(a.out, "results-r112.json"), results)
    # per-origin predictions (validated and reported rows)
    pp = os.path.join(a.out, "predictions-r112.csv.gz")
    with gzip.open(pp, "wt", newline="") as f:
        w = csv.writer(f)
        w.writerow(["T", "t0", "k", "y", "p_c", "p0", "p_a"])
        for TL, ts, Y, P in pred_rows:
            for i in range(len(ts)):
                t0 = A.iso(int(ts[i]))
                for k in range(K):
                    if np.isfinite(Y[i, k]):
                        w.writerow([TL, t0, LEVELS[k], int(Y[i, k]), f"{P['pc'][i, k]:.10g}",
                                    f"{P['p0'][i, k]:.10g}", f"{P['pa'][i, k]:.10g}"])
    log(f"verdicts {results['verdicts']}; done in {results['runtime_s']:.0f}s")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=("freeze", "run"))
    ap.add_argument("--datasets", required=True)
    ap.add_argument("--acq", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    {"freeze": cmd_freeze, "run": cmd_run}[a.cmd](a)


if __name__ == "__main__":
    main()
