"""Q26 R11.10: (fH) at 1 h, 3 h and 12 h -- blind historical test on Kraken ETH/USD 2016-08..2017-03 (set P1).

membrane-board design/Q26_ROUND11_PREREG.md, Deviations D-R11.10a (registration), D-R11.10b.. (readings, result).

  python3 r1110_blind.py power   --datasets DS --out OUT
        development power only: (fH), (f), (a) at 1 h, 3 h, 12 h on the ETH dev span (already seen); per-origin
        Brier differences; days to 80% power at the dev effect. Reads no blind data.
  python3 r1110_blind.py acquire --acq ACQ
        outcome-blind builder: Kraken public Trades (XETHZUSD) from the first trade to 2017-04-01T00:00Z ->
        trades csv.gz + hourly grid json + manifest. Prints counts only.
  python3 r1110_blind.py counts  --acq ACQ --out OUT
        counts-only check (null hours, labelled-origin counts by availability, HAR-defined counts). No label value,
        no price statistic, no forecast.
  python3 r1110_blind.py freeze  --datasets DS --acq ACQ --out OUT
        frozen-r1110-config.json (+ .sha256) with code sha, input sha256 values, readings, constants, UTC time.
  python3 r1110_blind.py run     --datasets DS --acq ACQ --out OUT
        verify the frozen config, fit and score ONCE -> results-r1110.json, predictions-r1110.csv.gz.

Recipe: A6 (fH) unchanged (HISTORY_TOUCH_PREREG_A6 A6.2, D-H1..D-H4), as extended in R11.2 (D-R11.2a): per (T, fold)
OLS of ln sigma_fut(t; T) on [1, ln D, ln W, ln M] over training origins t + T <= Q_start; sigma_fut(t; T) is the
realized vol of the T hourly log returns in (t, t + T]. (f) = the same FHS with sigma_hat (EWMA). (a) = expanding
frequency. Running minimum across levels (shallow -> deep) for every rung (R11.2 rule at 1 h, 3 h, 12 h).
No address is read or written.
"""
from __future__ import annotations

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import csv  # noqa: E402
import gzip  # noqa: E402
import json  # noqa: E402
import math  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402
import urllib.request  # noqa: E402
from datetime import datetime, timezone  # noqa: E402

import numpy as np  # noqa: E402
from scipy.stats import norm  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import a_touch as A  # noqa: E402
import a2_touch as M2  # noqa: E402
import a3_touch as M3  # noqa: E402
import a6_touch as A6  # noqa: E402
import r112_combine as R112  # noqa: E402

PREREG = {"repo": "triccs/membrane-board", "path": "design/Q26_ROUND11_PREREG.md", "item": "R11.10",
          "deviations": "D-R11.10a.."}
STEP, DAY = 3600, 86400
HORIZONS = (1, 3, 12)
TL = {1: "1h", 3: "3h", 12: "12h"}
LEVELS = tuple(A.LEVELS["ETH"])
K = len(LEVELS)
# scored cells = the R11.2 dev cell lists (>= 30 positive dev episodes, frozen-r112-coefs.json), fixed before P1
CELLS = {1: (-0.02, -0.03, -0.05), 3: (-0.02, -0.03, -0.05, -0.07, -0.10),
         12: (-0.02, -0.03, -0.05, -0.07, -0.10, -0.15)}
ALPHA = 0.05 / 3
POWER = 0.80
R_BAND = (0.8, 1.25)
RUNGS = ("fH", "f", "a")

# P1
KRAKEN_PAIR = "XETHZUSD"
KRAKEN_URL = "https://api.kraken.com/0/public/Trades?pair={pair}&since={since}"
P1_END = A.utc("2017-04-01T00:00:00Z")          # last outcome window ends here; no trade at or after is kept
WARMUP_DAYS = 365
ACQ = {"trades": "kraken-xethzusd-trades.csv.gz", "grid": "kraken-xethzusd-1h.json",
       "manifest": "manifest-acquire.json", "counts": "counts-r1110.json"}

# dev (power only)
DEV_LAST_ORIGIN = R112.DEV_LAST_ORIGIN
Q2_START, Q2_END = R112.Q2_START, R112.Q2_END

DECISIONS = {
    "R1110-1": "Rungs per (T, fold), T in {1, 3, 12} h: (fH) = A6 D-H4 with the (f) fallback for rows without "
               "sigma_H; (f) = FHS with sigma_hat (beta 1); (a) = expanding frequency to Q_start - T. FHS and HAR "
               "training origins: labelled, t + T <= Q_start. Running minimum across levels for each rung.",
    "R1110-2": "Horizon-matched scale at 1 h, 3 h, 12 h: the HAR target is ln sigma_fut(t; T) over the T hourly "
               "returns in (t, t + T] (A6 D-H3; null returns allowed: floor(0.05 T) = 0, so none), annualised x8760; "
               "the FHS z = ln(wmin/spot) / (sigma_H(t; T) sqrt(T/8760)) at training and test origins.",
    "R1110-3": "P1 grid: Kraken XETHZUSD public trades, hour h = [t, t + 1 h): close = last trade price, high/low = "
               "max/min trade price, open = first. An hour with no trade is a null hour (close, high, low null). "
               "No forward fill and no outlier filter: printed trades are truth (A6 D2 wick rule). Grid from the hour "
               "of the first trade to the hour opening 2017-03-31T23:00Z.",
    "R1110-4": "Thin trading: the A3.1 null-hour rule unchanged. Labels need 0 null hours in the window at 1 h, 3 h "
               "and 12 h; sigma_fut needs 0 null returns; HAR windows allow 1, 8, 36 null hours; sigma_hat (EWMA) "
               "skips null returns and needs 1,440 valid returns; RV30 needs >= 95% non-null returns. A row with an "
               "undefined label, or a rung that is not finite, drops for all rungs.",
    "R1110-5": "Folds: F1 = [first 00:00Z >= first-trade hour + 365 d, 2016-10-01), 2016Q4, 2017Q1. Test origins "
               "every hour; validated when t + T <= 2017-04-01T00:00Z, the label is defined and all three rungs are "
               "finite. Training expanding from the grid start.",
    "R1110-6": "Pass at T: one-sided DM (Newey-West Bartlett lag T - 1 on hourly origins, HLN h = lag + 1, t with "
               "n - 1 df) on d_t = mean over the scored cells of (p_fH - y)^2 - (p_cmp - y)^2, p < 0.05/3 vs (f) AND "
               "vs (a), with mean d < 0; AND pooled R = sum p_fH / sum y over the scored rows in [0.8, 1.25].",
    "R1110-7": "Scored cells = the R11.2 dev cell lists (1 h: -2..-5%, 3 h: -2..-10%, 12 h: -2..-15%). All ten "
               "levels are reported beside, deciding nothing.",
    "R1110-8": "Reported only: BSS vs (f) and (a), Brier, per-fold (quarter) results, per regime, per level R, "
               "CORP MCB/DSC, positive-episode counts, all-level DM.",
}


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def write_json(path, obj):
    return R112.write_json(path, obj)


# ---------------------------------------------------------------------------------------------
# Rungs
# ---------------------------------------------------------------------------------------------
def fold_rungs(ser, P6, Pa, T, qs_i, te):
    """(fH) with the (f) fallback, (f), (a) for one fold (same code path as R112.fold_raw, plus (f))."""
    P = P6.P
    lim = qs_i - T
    tr = P6.i <= lim
    coef, info = P6.har_coef(qs_i)
    sH = P6.sigma_H(coef)
    zH, vH = P6.z_of(sH)
    sH_te = P6.sigma_H(coef, P6.X[te], P6.okX[te])
    pH = M2.fhs_predict(zH[vH & tr], P.thresholds(sH_te))
    pf = M2.fhs_predict(P.z[1.0][P.valid[1.0] & tr], P.thresholds(ser.sigma[te]))
    fb = ~np.all(np.isfinite(pH), axis=1)
    pH[fb] = pf[fb]
    pa = np.tile(Pa.freq_upto(lim), (len(te), 1))
    fit = {"har": None if coef is None else coef.tolist(), "har_info": info, "fH_fallback_rows": int(fb.sum()),
           "n_fhs_fH": int((vH & tr).sum()), "n_fhs_f": int((P.valid[1.0] & tr).sum())}
    return {"fH": pH, "f": pf, "a": pa}, fit


def build_rungs(ser, oser, folds):
    out = {}
    for T in HORIZONS:
        P6 = A6.Prep6(ser, T, with_fbL=False)
        Pa = P6.P if oser is ser else M3.Prep3(oser, T, beta_select=False)
        te_all, fo, raw, fits = [], [], {r: [] for r in RUNGS}, {}
        for f in folds:
            te = np.arange(f["qs_i"], min(f["qe_i"], ser.n_orig))
            p, fit = fold_rungs(ser, P6, Pa, T, f["qs_i"], te)
            for r in RUNGS:
                raw[r].append(p[r])
            te_all.append(te)
            fo.append(np.full(len(te), len(fits)))
            fits[f["name"]] = fit
        te_all = np.concatenate(te_all)
        P = {r: np.minimum.accumulate(np.concatenate(raw[r]), axis=1) for r in RUNGS}
        out[T] = {"te": te_all, "fold": np.concatenate(fo), "fold_names": [f["name"] for f in folds],
                  "ts": ser.base_ts + STEP * te_all, "Y": ser.labels(T)[te_all], "P": P,
                  "regime": ser.regime[te_all], "fits": fits}
    return out


# ---------------------------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------------------------
def dm1(d, L):
    return R112.dm_one_sided(d, L)


def per_origin(P, Y, V):
    cnt = V.sum(axis=1)
    o = cnt > 0
    se = {r: np.where(V, (P[r] - np.nan_to_num(Y)) ** 2, 0.0) for r in P}
    return o, {r: se[r][o].sum(axis=1) / cnt[o] for r in P}


def days_to_power(d, L, alpha=ALPHA, power=POWER, per_day=24):
    """origin-days for a one-sided HAC z test to reach `power` at the observed mean (normal approximation)."""
    d = np.asarray(d, float)
    mu = float(d.mean())
    lrv = A6.nw_lrv(d - mu, L)
    if not (lrv > 0) or mu >= 0:
        return {"mean_diff": mu, "lrv": lrv, "n_origins": None, "days": None, "note": "no gain at the dev effect"}
    z = norm.ppf(1 - alpha) + norm.ppf(power)
    n = z * z * lrv / (mu * mu)
    return {"mean_diff": mu, "lrv": lrv, "sd_iid": float(d.std()), "n_origins": float(n), "days": float(n / per_day),
            "z_sum": float(z)}


def count_pos_episodes(yk, step_ok):
    return R112.count_pos_episodes(yk, step_ok)


def score_T(T, B, valid_o, log=print):
    P, Y, ts, reg = B["P"], B["Y"], B["ts"], B["regime"]
    fin = np.isfinite(Y) & np.all(np.stack([np.isfinite(P[r]) for r in RUNGS]), axis=0)
    valid_o = valid_o & np.all(fin, axis=1)
    cell = np.array([k in CELLS[T] for k in LEVELS])
    V = valid_o[:, None] & cell[None, :]
    Vall = valid_o[:, None] & np.ones(K, bool)[None, :]
    L = T - 1
    res = {"T": TL[T], "dm_lag": L, "alpha_one_sided": ALPHA, "cells_scored": list(CELLS[T]),
           "origins_validated": int(valid_o.sum()), "rows_scored": int(V.sum())}
    if not V.any():
        res.update(pass_=False, reason="no validated rows")
        return res
    o, po = per_origin(P, Y, V)
    dm = {c: dm1(po["fH"] - po[c], L) for c in ("f", "a")}
    br = {r: float(np.mean((P[r][V] - Y[V]) ** 2)) for r in RUNGS}
    sy = float(Y[V].sum())
    R = {r: (float(P[r][V].sum()) / sy if sy > 0 else None) for r in RUNGS}
    dm_ok = all(dm[c]["p_one_sided"] is not None and dm[c]["p_one_sided"] < ALPHA and dm[c]["mean_diff"] < 0
                for c in dm)
    R_ok = R["fH"] is not None and R_BAND[0] <= R["fH"] <= R_BAND[1]
    res.update({"dm": dm, "brier": br, "bss_vs_f": 1 - br["fH"] / br["f"], "bss_vs_a": 1 - br["fH"] / br["a"],
                "bss_f_vs_a": 1 - br["f"] / br["a"], "pooled_R": R, "sum_y": sy,
                "checks": {"dm_vs_f": dm["f"]["p_one_sided"] is not None and dm["f"]["p_one_sided"] < ALPHA
                           and dm["f"]["mean_diff"] < 0,
                           "dm_vs_a": dm["a"]["p_one_sided"] is not None and dm["a"]["p_one_sided"] < ALPHA
                           and dm["a"]["mean_diff"] < 0, "R_in_band": R_ok},
                "pass": bool(dm_ok and R_ok)})
    res["power_at_this_effect"] = {c: days_to_power(po["fH"] - po[c], L) for c in ("f", "a")}
    # reported only
    res["corp"] = {r: A6.corp(P[r][V], Y[V]) for r in RUNGS}
    per_fold = {}
    for fi, name in enumerate(B["fold_names"]):
        m = V & (B["fold"] == fi)[:, None]
        if not m.any():
            per_fold[name] = {"rows": 0}
            continue
        b = {r: float(np.mean((P[r][m] - Y[m]) ** 2)) for r in RUNGS}
        oo, pp = per_origin(P, Y, m)
        s = float(Y[m].sum())
        per_fold[name] = {"origins": int(oo.sum()), "rows": int(m.sum()), "brier": b,
                          "bss_vs_f": 1 - b["fH"] / b["f"], "bss_vs_a": 1 - b["fH"] / b["a"],
                          "R": {r: (float(P[r][m].sum()) / s if s > 0 else None) for r in RUNGS},
                          "dm": {c: dm1(pp["fH"] - pp[c], L) for c in ("f", "a")}}
    res["per_fold"] = per_fold
    per_reg = {}
    for g, name in enumerate(M3.REGIMES):
        m = V & (reg == g)[:, None]
        if m.any():
            b = {r: float(np.mean((P[r][m] - Y[m]) ** 2)) for r in RUNGS}
            s = float(Y[m].sum())
            per_reg[name] = {"rows": int(m.sum()), "bss_vs_f": 1 - b["fH"] / b["f"], "bss_vs_a": 1 - b["fH"] / b["a"],
                             "R": {r: (float(P[r][m].sum()) / s if s > 0 else None) for r in RUNGS}}
    res["per_regime"] = per_reg
    step_ok = np.zeros(len(ts), bool)
    step_ok[1:] = np.diff(ts) == STEP
    lv = {}
    for k in range(K):
        m = Vall[:, k]
        if not m.any():
            continue
        idx = np.where(m)[0]
        so = np.zeros(len(idx), bool)
        so[1:] = (np.diff(idx) == 1) & step_ok[idx[1:]]
        s = float(Y[m, k].sum())
        lv[repr(LEVELS[k])] = {"rows": int(m.sum()), "n_ep": count_pos_episodes(Y[m, k], so), "sum_y": s,
                               "R": {r: (float(P[r][m, k].sum()) / s if s > 0 else None) for r in RUNGS},
                               "brier": {r: float(np.mean((P[r][m, k] - Y[m, k]) ** 2)) for r in RUNGS},
                               "scored": bool(cell[k])}
    res["per_level"] = lv
    oa, pa_ = per_origin(P, Y, Vall)
    ba = {r: float(np.mean((P[r][Vall] - Y[Vall]) ** 2)) for r in RUNGS}
    res["all_levels_reported"] = {"rows": int(Vall.sum()), "brier": ba, "bss_vs_f": 1 - ba["fH"] / ba["f"],
                                  "bss_vs_a": 1 - ba["fH"] / ba["a"],
                                  "dm": {c: dm1(pa_["fH"] - pa_[c], L) for c in ("f", "a")}}
    log(f"  {TL[T]}: pass={res['pass']} BSS vs f {res['bss_vs_f']:+.4f} p={dm['f']['p_one_sided']:.4g}; "
        f"vs a {res['bss_vs_a']:+.4f} p={dm['a']['p_one_sided']:.4g}; R={R['fH']:.3f}")
    return res


# ---------------------------------------------------------------------------------------------
# power (development data only)
# ---------------------------------------------------------------------------------------------
def cmd_power(a):
    t0 = time.time()
    ser, oser = R112.build_series(a.datasets)
    folds = M3.dev_folds(ser)
    B = build_rungs(ser, oser, folds)
    out = {"schema": "q26-r1110/power-dev/1", "created_utc": now_iso(), "code_sha": R112.git_sha(),
           "clean": R112.git_clean(), "note": "development data only (ETH Chainlink dev span, already seen)",
           "alpha_one_sided": ALPHA, "power": POWER, "horizons": {}}
    for T in HORIZONS:
        b = B[T]
        ts = b["ts"]
        win_q2 = (ts + T * STEP > Q2_START) & (ts < Q2_END)
        base_ok = ~win_q2 & (ts <= DEV_LAST_ORIGIN)
        yr = np.array([int(A.iso(int(t))[:4]) for t in ts])
        spans = {"dev_2021Q1_2026Q3": base_ok, "dev_2026Q1_Q3": base_ok & (yr == 2026)}
        hz = {}
        for nm, vo in spans.items():
            fin = np.isfinite(b["Y"]) & np.all(np.stack([np.isfinite(b["P"][r]) for r in RUNGS]), axis=0)
            vo = vo & np.all(fin, axis=1)
            cell = np.array([k in CELLS[T] for k in LEVELS])
            V = vo[:, None] & cell[None, :]
            o, po = per_origin(b["P"], b["Y"], V)
            br = {r: float(np.mean((b["P"][r][V] - b["Y"][V]) ** 2)) for r in RUNGS}
            sy = float(b["Y"][V].sum())
            hz[nm] = {"origins": int(o.sum()), "bss_vs_f": 1 - br["fH"] / br["f"], "bss_vs_a": 1 - br["fH"] / br["a"],
                      "R_fH": float(b["P"]["fH"][V].sum()) / sy,
                      "dm": {c: dm1(po["fH"] - po[c], T - 1) for c in ("f", "a")},
                      "days_to_80pct_power": {c: days_to_power(po["fH"] - po[c], T - 1) for c in ("f", "a")}}
        out["horizons"][TL[T]] = hz
        print(TL[T], json.dumps({nm: {"origins": v["origins"], "bss_vs_f": round(v["bss_vs_f"], 4),
                                      "bss_vs_a": round(v["bss_vs_a"], 4), "R": round(v["R_fH"], 3),
                                      "days_f": v["days_to_80pct_power"]["f"]["days"],
                                      "days_a": v["days_to_80pct_power"]["a"]["days"]} for nm, v in hz.items()}))
    out["runtime_s"] = time.time() - t0
    os.makedirs(a.out, exist_ok=True)
    print("power-dev sha256", write_json(os.path.join(a.out, "power-dev-r1110.json"), out))


# ---------------------------------------------------------------------------------------------
# acquire (outcome-blind; prints counts only)
# ---------------------------------------------------------------------------------------------
def http_json(url, tries=8):
    last = None
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "membrane-research/1.0"})
            with urllib.request.urlopen(req, timeout=60) as r:
                d = json.loads(r.read())
            if d.get("error"):
                last = d["error"]
                time.sleep(2.0 * (k + 1))
                continue
            return d
        except Exception as e:      # retried
            last = repr(e)
            time.sleep(2.0 * (k + 1))
    raise SystemExit(f"STOP: request failed after {tries} tries: {last}")


def cmd_acquire(a):
    os.makedirs(a.acq, exist_ok=True)
    t_start = now_iso()
    since = 0
    trades = []
    pages = 0
    seen = set()
    while True:
        d = http_json(KRAKEN_URL.format(pair=KRAKEN_PAIR, since=since))
        rows = d["result"][KRAKEN_PAIR]
        nxt = int(d["result"]["last"])
        pages += 1
        stop = False
        for r in rows:
            tsec = float(r[2])
            if tsec >= P1_END:
                stop = True
                break
            tid = int(r[6]) if len(r) > 6 else None
            key = tid if tid is not None else (r[2], r[0], r[1])
            if key in seen:
                continue
            seen.add(key)
            trades.append((tsec, r[0], r[1], tid))
        if pages % 100 == 0:
            print(f"pages {pages}, trades {len(trades)}", flush=True)
        if stop or not rows or nxt == since:
            break
        since = nxt
        time.sleep(1.1)
    trades.sort(key=lambda x: (x[0], x[3] if x[3] is not None else 0))
    tp = os.path.join(a.acq, ACQ["trades"])
    with gzip.open(tp, "wt", newline="") as f:
        w = csv.writer(f)
        w.writerow(["time", "price", "volume", "trade_id"])
        for t, p, v, tid in trades:
            w.writerow([f"{t:.6f}", p, v, "" if tid is None else tid])
    # hourly grid
    t_first = int(trades[0][0]) // STEP * STEP
    n = (P1_END - t_first) // STEP
    o, h, l, c, vol, cnt = (np.full(n, np.nan) for _ in range(6))
    vol[:] = 0.0
    cnt[:] = 0
    for t, p, v, _ in trades:
        i = (int(t) - t_first) // STEP
        p, v = float(p), float(v)
        if cnt[i] == 0:
            o[i] = h[i] = l[i] = p
        else:
            h[i] = max(h[i], p)
            l[i] = min(l[i], p)
        c[i] = p
        vol[i] += v
        cnt[i] += 1

    def col(x):
        return [None if not np.isfinite(v) else float(v) for v in x]
    grid = {"schema": "q26-r1110/kraken-hourly/1", "source": "Kraken public REST /0/public/Trades pair XETHZUSD",
            "startTs": t_first, "stepSeconds": STEP, "count": int(n), "endTs": P1_END,
            "rule": DECISIONS["R1110-3"],
            "columns": {"open": col(o), "high": col(h), "low": col(l), "close": col(c),
                        "volume": [float(v) for v in vol], "trades": [int(v) for v in cnt]}}
    gp = os.path.join(a.acq, ACQ["grid"])
    with open(gp, "w") as f:
        json.dump(grid, f)
    man = {"schema": "q26-r1110/acquire/1", "started_utc": t_start, "finished_utc": now_iso(),
           "code_sha": R112.git_sha(), "pair": KRAKEN_PAIR, "pages": pages, "trades": len(trades),
           "first_trade_utc": A.iso(int(trades[0][0])), "last_trade_utc": A.iso(int(trades[-1][0])),
           "grid_start_utc": A.iso(t_first), "grid_hours": int(n), "end_exclusive_utc": A.iso(P1_END),
           "files": {k: {"path": ACQ[k], "sha256": R112.sha256_file(os.path.join(a.acq, ACQ[k]))}
                     for k in ("trades", "grid")},
           "checksums_published_by_source": False, "status": "LOCKED for R11.10 (D-R11.10a)"}
    write_json(os.path.join(a.acq, ACQ["manifest"]), man)
    print(json.dumps({k: man[k] for k in ("pages", "trades", "first_trade_utc", "last_trade_utc", "grid_hours")}))


# ---------------------------------------------------------------------------------------------
# P1 series and folds
# ---------------------------------------------------------------------------------------------
def load_p1(acq):
    g = json.load(open(os.path.join(acq, ACQ["grid"])))
    st = int(g["startTs"])
    cols = {k: np.array([np.nan if v is None else float(v) for v in g["columns"][k]], float)
            for k in ("close", "low", "high")}
    ser = M3.S3("kraken:ETHUSD", "ETH", "kraken", cols["close"], cols["low"], LEVELS, st, st)
    A6.attach_high(ser, cols["high"])
    return ser, g


def p1_folds(ser):
    first_ts = ser.base_ts
    f1 = ((first_ts + WARMUP_DAYS * DAY + DAY - 1) // DAY) * DAY
    bounds = [("F1-2016Q3p", f1, A.utc("2016-10-01T00:00:00Z")),
              ("2016Q4", A.utc("2016-10-01T00:00:00Z"), A.utc("2017-01-01T00:00:00Z")),
              ("2017Q1", A.utc("2017-01-01T00:00:00Z"), P1_END)]
    return [{"name": n, "qs_ts": s, "qe_ts": e, "qs_i": ser.gi(s), "qe_i": ser.gi(e)} for n, s, e in bounds]


def cmd_counts(a):
    ser, g = load_p1(a.acq)
    folds = p1_folds(ser)
    cnt = np.array(g["columns"]["trades"])
    null = ~np.isfinite(ser.close)
    out = {"schema": "q26-r1110/counts/1", "created_utc": now_iso(), "note": "counts only: no label value, no price "
           "statistic, no forecast", "grid_start_utc": A.iso(ser.base_ts), "grid_hours": int(ser.N),
           "folds": [{"name": f["name"], "start": A.iso(f["qs_ts"]), "end": A.iso(f["qe_ts"])} for f in folds],
           "null_hours_by_quarter": {}, "by_T": {}}
    hrs = ser.base_ts + STEP * np.arange(ser.N)
    qn = np.array([R112.quarter_of(int(t)) for t in hrs])
    for q in sorted(set(qn)):
        m = qn == q
        out["null_hours_by_quarter"][q] = {"hours": int(m.sum()), "null": int(null[m].sum()),
                                           "median_trades_per_hour": float(np.median(cnt[m]))}
    for T in HORIZONS:
        P6 = A6.Prep6(ser, T, with_fbL=False)
        lab_ok = P6.P.lab_ok
        n = len(lab_ok)
        idx = np.arange(n)
        ts = ser.base_ts + STEP * idx
        row = {}
        for f in folds:
            te = (idx >= f["qs_i"]) & (idx < min(f["qe_i"], n)) & (ts + T * STEP <= P1_END)
            row[f["name"]] = {"origins": int(te.sum()), "label_defined": int((te & lab_ok).sum()),
                              "har_defined": int((te & P6.okX).sum()),
                              "sigma_hat_defined": int((te & np.isfinite(ser.sigma[:n])).sum()),
                              "har_regression_origins_before_fold": int(P6.cum_nH[min(f["qs_i"] - T, n - 1)]),
                              "fhs_f_origins_before_fold": int((P6.P.valid[1.0] & (idx <= f["qs_i"] - T)).sum())}
        out["by_T"][TL[T]] = row
    os.makedirs(a.out, exist_ok=True)
    h = write_json(os.path.join(a.out, ACQ["counts"]), out)
    print(json.dumps(out, indent=1))
    print("counts sha256", h)


# ---------------------------------------------------------------------------------------------
# freeze and run
# ---------------------------------------------------------------------------------------------
def cmd_freeze(a):
    path = os.path.join(a.out, "frozen-r1110-config.json")
    if os.path.exists(path):
        raise SystemExit("STOP: frozen config exists")
    if not R112.git_clean():
        raise SystemExit("STOP: code tree not clean")
    man = json.load(open(os.path.join(a.acq, ACQ["manifest"])))
    inputs = {k: {"path": f"acq/{ACQ[k]}", "sha256": R112.sha256_file(os.path.join(a.acq, ACQ[k]))}
              for k in ("trades", "grid", "manifest", "counts")}
    pw = os.path.join(a.out, "power-dev-r1110.json")
    cfg = {"schema": "q26-r1110/frozen-config/1", "created_utc": now_iso(), "prereg": PREREG,
           "code": {"repo": "The-Membrane/membrane-app", "sha": R112.git_sha(),
                    "path": "scripts/research/history-forecasts/r1110_blind.py",
                    "sha256": R112.sha256_file(os.path.abspath(__file__)), "clean": R112.git_clean()},
           "inputs": inputs, "power_dev_sha256": R112.sha256_file(pw) if os.path.exists(pw) else None,
           "acquire": {k: man[k] for k in ("pages", "trades", "first_trade_utc", "last_trade_utc", "grid_hours")},
           "constants": {"horizons_h": list(HORIZONS), "levels": list(LEVELS),
                         "cells_scored": {TL[T]: list(v) for T, v in CELLS.items()}, "alpha_one_sided": ALPHA,
                         "R_band": list(R_BAND), "dm_lag": "T - 1", "p1_end": A.iso(P1_END),
                         "warmup_days": WARMUP_DAYS, "null_frac": M3.NULL_FRAC, "har_windows": list(A6.HAR_WINDOWS)},
           "seeds": None, "decisions": DECISIONS}
    h = write_json(path, cfg)
    print(json.dumps({"frozen_config_sha256": h, "created_utc": cfg["created_utc"], "code": cfg["code"]["sha"]}))


def cmd_run(a):
    t_start = time.time()
    logf = open(os.path.join(a.out, "run-log.txt"), "a")

    def log(s):
        line = f"{now_iso()} {s}"
        print(line, flush=True)
        logf.write(line + "\n")
        logf.flush()

    cpath = os.path.join(a.out, "frozen-r1110-config.json")
    cfg = json.load(open(cpath))
    want = open(cpath + ".sha256").read().split()[0]
    if R112.sha256_file(cpath) != want:
        raise SystemExit("STOP: frozen config hash mismatch")
    if cfg["code"]["sha"] != R112.git_sha() or not R112.git_clean():
        raise SystemExit("STOP: code sha differs from the frozen config or tree not clean")
    for k, v in cfg["inputs"].items():
        if R112.sha256_file(os.path.join(a.acq, v["path"][4:])) != v["sha256"]:
            raise SystemExit(f"STOP: input {k} sha256 differs")
    rp = os.path.join(a.out, "results-r1110.json")
    marker = os.path.join(a.out, "run-started.json")
    if os.path.exists(rp) or os.path.exists(marker):
        raise SystemExit("STOP: one run only")
    write_json(marker, {"started_utc": now_iso(), "config_sha256": want})
    log(f"run start; config sha256 {want}; code {cfg['code']['sha']}")
    ser, _ = load_p1(a.acq)
    folds = p1_folds(ser)
    B = build_rungs(ser, ser, folds)
    results = {"schema": "q26-r1110/results/1", "started_utc": json.load(open(marker))["started_utc"],
               "config_sha256": want, "code_sha": cfg["code"]["sha"], "folds": [f["name"] for f in folds],
               "fits": {TL[T]: B[T]["fits"] for T in HORIZONS}, "horizons": {}}
    pred = []
    for T in HORIZONS:
        b = B[T]
        valid_o = b["ts"] + T * STEP <= P1_END
        r = score_T(T, b, valid_o, log)
        results["horizons"][TL[T]] = r
        pred.append((T, b, valid_o))
    results["verdicts"] = {TL[T]: results["horizons"][TL[T]]["pass"] for T in HORIZONS}
    results["finished_utc"] = now_iso()
    results["runtime_s"] = time.time() - t_start
    write_json(rp, results)
    pp = os.path.join(a.out, "predictions-r1110.csv.gz")
    with gzip.open(pp, "wt", newline="") as f:
        w = csv.writer(f)
        w.writerow(["T", "t0", "fold", "k", "y", "p_fH", "p_f", "p_a"])
        for T, b, vo in pred:
            for i in np.where(vo)[0]:
                t0 = A.iso(int(b["ts"][i]))
                for k in range(K):
                    if np.isfinite(b["Y"][i, k]):
                        w.writerow([TL[T], t0, b["fold_names"][b["fold"][i]], LEVELS[k], int(b["Y"][i, k]),
                                    *(f"{b['P'][r][i, k]:.10g}" for r in RUNGS)])
    log(f"verdicts {results['verdicts']}; done in {results['runtime_s']:.0f}s")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=("power", "acquire", "counts", "freeze", "run"))
    ap.add_argument("--datasets")
    ap.add_argument("--acq")
    ap.add_argument("--out")
    a = ap.parse_args()
    {"power": cmd_power, "acquire": cmd_acquire, "counts": cmd_counts, "freeze": cmd_freeze, "run": cmd_run}[a.cmd](a)


if __name__ == "__main__":
    main()
