#!/usr/bin/env python3
"""Q26 R11.11: revised 24 h daily-minimum pool cash model, developed on burned data, then one blind test on C1.

membrane-board design/Q26_ROUND11_PREREG.md D-R11.11a (candidates, development data and selection rule, fixed before
the development run); parent design/Q26_ROUND10_PREREG.md D-R10.4-Bd. Process: R11 binding rules 1-10, D-R11.3e
(power stated, UTC start/end in run logs), D-R11.9a (blind historical set first).

Candidates (D-R11.11a, no others):
  M0 (reference)  R10.4 step 1 as registered (r104_cash.run_variant on neutralised endpoints, t0 + 60 min live rule).
  M1              raw endpoints: no round-trip neutralisation (Q = R = 0) in flows, dip endpoints or path start.
  M2              M0's flows and endpoints; the dip splits into a base part (from the ex-round-trip intraday path) and
                  a round-trip part, and the round-trip part is weighted by pool-level round-trip activity w(t0)
                  (1 while a round trip completed in the last 7 days, then half-life 7 days, 0 if none ever).
Development data (grade C): Core USDC (R10.4 inputs and 24 h scoring origins) and C2 Core PYUSD, USDS, RLUSD
(R10.4-B inputs, wrapper and origins). Selection: pooled supply-scaled skill vs the empirical baseline over all
market-origins; M2 only if it beats M1 by >= 1.0 pp, else M1.

Frozen code imported unchanged: r104_cash.py (7b6ca7aa), r104b_c2.py (6b6ef6be), r115_depositor_cash.emp_baseline,
dm_hln, pinball3, r9_correct.run_qrt.

  python3 r1111_cash.py dev --datasets <membrane-datasets> --out <dir> --code-sha <sha>
No address is held in any output (units are salted hashes in memory only; every output is checked).
"""
import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import gzip  # noqa: E402
import json  # noqa: E402
import re  # noqa: E402
import secrets  # noqa: E402
import subprocess  # noqa: E402
import sys  # noqa: E402
from datetime import datetime, timezone  # noqa: E402

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import r104_cash as R4  # noqa: E402
import r104b_c2 as RB  # noqa: E402
import r115_depositor_cash as R5  # noqa: E402
import r9_correct as R9  # noqa: E402

SCHEMA_DEV = "q26-r11/r1111-dev/1"
MICRO = 10 ** 6
DAY = 86400
QS = (0.05, 0.25, 0.50)
H24 = 1
ACT_WINDOW_D = 7.0          # M2: w = 1 while the last completed round trip is at most 7 days old
ACT_HALFLIFE_D = 7.0        # M2: then w halves every 7 days
SELECT_MARGIN = 0.010       # M2 is chosen only if its pooled skill beats M1's by >= 1.0 pp
ADDR_RE = re.compile(r"0x[0-9a-fA-F]{40}")
CORE_CASH_DIR = "aave-pool-cash"

DEV_DECISIONS = [
    "DEV-1 Candidates (D-R11.11a): M0 reference (not selectable) = R10.4 step 1; M1 = raw endpoints (Q = R = 0); "
    "M2 = neutralised flows and endpoints with the dip split into base b_i (ex-round-trip path minimum) and round-trip "
    "part r_i (b_i + r_i = M0's dip), path dip = b + w(t0) r; w = 1 if the last round trip completed by t0 + 60 min "
    "is <= 7 days old, else 0.5^((age - 7)/7), 0 if none; last training day uses round trips complete by t0 + 60 min.",
    "DEV-2 Data: Core USDC (R10.4 inputs, G1, 24 h scoring origins 2024-01-01..2026-10-12 minus 2026Q2) and C2 "
    "(r104b_c2 wrapper unchanged, B-14 non-finite days to NaN, origins series start + 180 d .. 2026-10-07 minus "
    "2026Q2). Paired scoring: an origin scores only if every candidate, the empirical baseline, no-change and the "
    "truth exist.",
    "DEV-3 Selection: pooled supply-scaled skill vs empirical = 1 - sum(L/S) / sum(L_emp/S) over all market-origins; "
    "M2 chosen iff skill(M2) - skill(M1) >= 0.010, else M1. Everything else is reported only.",
]


# ---------------------------------------------------------------------------------------------
# model pieces (pure, tested)
# ---------------------------------------------------------------------------------------------
def activity_w(done_ts, t0, window_d=ACT_WINDOW_D, halflife_d=ACT_HALFLIFE_D, lookahead_s=R4.LOOKAHEAD_S):
    """pool-level round-trip activity at t0 from sorted completion times (live rule: complete by t0 + 60 min)."""
    k = int(np.searchsorted(done_ts, t0 + lookahead_s, side="right"))
    if k == 0:
        return 0.0
    age = max(0.0, (t0 - float(done_ts[k - 1])) / DAY)
    if age <= window_d:
        return 1.0
    return float(0.5 ** ((age - window_d) / halflife_d))


def rt_done_times(legs, drts):
    """completion ts of every QRT (last redeposit leg) and debt-side round trip, sorted."""
    d = []
    if len(legs):
        r = legs[legs["leg"] == "redeposit"]
        d += [int(x) for x in r.groupby("qrt_id")["ts"].max().values]
    d += [int(x["done_ts"]) for x in drts]
    return np.array(sorted(d), dtype=np.int64)


def ex_path(cts, cval, legs, drts, visible_by=None):
    """per-transaction cash plus the round-trip amount outstanding at that ts (QRTs + debt-side), float."""
    q = R4.qrt_outstanding(legs, cts, visible_by=visible_by).astype(float) if len(legs) else np.zeros(len(cts))
    r = R4.drt_outstanding(drts, cts, visible_by=visible_by, key="ts").astype(float) if drts else np.zeros(len(cts))
    return cval.astype(float) + q + r


def ex_minima(t, cts, cval, legs, drts, end_ts):
    """exmin_i over (t_i, t_i + 1 d] of the ex-round-trip path, full (every round trip) and live (only round trips
    complete by t_{i+1} + 60 min, used for the last training day before origin i + 1)."""
    n = len(t)
    full_p = ex_path(cts, cval, legs, drts)
    day_of = np.searchsorted(t, cts, side="left") - 1          # tx at ts in (t_i, t_{i+1}] -> day i
    vis = np.where((day_of >= 0) & (day_of + 1 < n), t[np.clip(day_of + 1, 0, n - 1)] + R4.LOOKAHEAD_S,
                   np.iinfo(np.int64).max)
    live_p = ex_path(cts, cval, legs, drts, visible_by=vis)
    # start states at t_i (state just after t_i, round trips outstanding at t_i)
    st_full = ex_path_at(t, cts, cval, legs, drts, None)
    st_live = ex_path_at(t, cts, cval, legs, drts, np.append(t[1:] + R4.LOOKAHEAD_S, np.iinfo(np.int64).max))
    mf = np.full(n, np.nan)
    ml = np.full(n, np.nan)
    for i in range(n):
        if t[i] + DAY > end_ts:
            continue
        i0 = int(np.searchsorted(cts, t[i], side="right"))
        i1 = int(np.searchsorted(cts, t[i] + DAY, side="right"))
        mf[i] = min(st_full[i], full_p[i0:i1].min()) if i1 > i0 else st_full[i]
        ml[i] = min(st_live[i], live_p[i0:i1].min()) if i1 > i0 else st_live[i]
    return mf, ml


def ex_path_at(t, cts, cval, legs, drts, visible_by):
    cash = np.array([R4.state_at(cts, cval, int(x)) for x in t], dtype=float)
    q = R4.qrt_outstanding(legs, t, visible_by=visible_by).astype(float) if len(legs) else np.zeros(len(t))
    r = R4.drt_outstanding(drts, t, visible_by=visible_by, key="ts").astype(float) if drts else np.zeros(len(t))
    return cash + q + r


def dip_split(CX, SX, dmin, exmin):
    """base b_i and round-trip part r_i of M0's dip; b + r = max(0, min(CX_i, CX_{i+1}) - dmin_i) / SX_i."""
    with np.errstate(divide="ignore", invalid="ignore"):
        lo = np.minimum(CX[:-1], CX[1:])
        tot = np.maximum(0.0, lo - dmin[:-1]) / SX[:-1]
        b = np.maximum(0.0, lo - exmin[:-1]) / SX[:-1]
        b = np.minimum(b, tot)
    return b, tot - b


def forecast_m2(F, Flive, dmin, exmin_live, b, r, done_ts, t, cash_t0, idx, w_override=None):
    """M2 forecasts at origin indices idx (24 h). F/Flive = (B-14 cleaned) make_flows tuples, neutralised."""
    SX, CX, DX, xS, xD, _ = F
    out = {}
    for n in idx:
        n = int(n)
        w = activity_w(done_ts, int(t[n])) if w_override is None else w_override
        xs, xd = xS[:n].copy(), xD[:n].copy()
        dd = b[:n] + w * r[:n]
        sl, cl, dl = Flive[0][n], Flive[1][n], Flive[2][n]
        with np.errstate(divide="ignore", invalid="ignore"):
            xs[n - 1] = np.log(sl / SX[n - 1])
            xd[n - 1] = np.log(dl / DX[n - 1])
            lo = min(CX[n - 1], cl)
            tot = max(0.0, lo - dmin[n - 1]) / SX[n - 1]
            bl = min(max(0.0, lo - exmin_live[n - 1]) / SX[n - 1], tot)
        dd[n - 1] = bl + w * (tot - bl)
        fix = [np.where(np.isfinite(a), a, np.nan) for a in (xs, xd, dd)]
        fo = R4.forecast_origin(n, H24, np.append(fix[0], np.nan), np.append(fix[1], np.nan),
                                np.append(fix[2], np.nan), sl, dl, cash_t0[n], spread=None)
        if fo is not None:
            fo["w"] = w
        out[n] = fo
    return out


def run_m0_m1(P, idx):
    sets = {"24h": {"score": np.asarray(idx, dtype=int), "q2": np.array([], dtype=int)},
            "7d": {"score": np.array([], dtype=int), "q2": np.array([], dtype=int)}}
    full = RB.finite_flows(R4.make_flows(P["S_snap"], P["C_end"], P["dmin"], P["Q_full"], P["R_full"]))
    live = RB.finite_flows(R4.make_flows(P["S_snap"], P["C_end"], P["dmin"], P["Q_live"], P["R_live"]))
    raw = RB.finite_flows(R4.make_flows(P["S_snap"], P["C_end"], P["dmin"], np.zeros(len(P["t"])),
                                        np.zeros(len(P["t"]))))
    m0 = R4.run_variant(full, live, P["dmin"], P["cash_t0"], sets, None, False)["24h"]
    m1 = R4.run_variant(raw, None, P["dmin"], P["cash_t0"], sets, None, False)["24h"]
    return m0, m1, full, live


def run_m2(P, idx, full, live, w_override=None):
    b, r = dip_split(full[1], full[0], P["dmin"], P["exmin_full"])
    return forecast_m2(full, live, P["dmin"], P["exmin_live"], b, r, P["done_ts"], P["t"], P["cash_t0"], idx,
                       w_override=w_override)


# ---------------------------------------------------------------------------------------------
# market loaders (development: Core USDC and C2)
# ---------------------------------------------------------------------------------------------
def load_core_usdc(datasets, salt, say):
    w = pd.read_csv(os.path.join(datasets, R4.W24))
    origins = w["origin"].tolist()
    t = np.array([R4.day_ts(d) for d in origins], dtype=np.int64)
    if not (np.diff(t) == DAY).all():
        raise SystemExit("STOP: origins not consecutive days")
    anc = t - 1
    S_snap = w["snap_supply"].to_numpy(float) * MICRO
    C_snap = w["snap_cash"].to_numpy(float) * MICRO
    tl = R4.load_cash_path(os.path.join(datasets, CORE_CASH_DIR))
    cts = tl["ts"].to_numpy(np.int64)
    cval = tl["cash"].to_numpy(np.int64)
    end_ts = int(cts.max())
    k = np.searchsorted(cts, anc, side="right") - 1
    cash_anchor = cval[k]
    g1 = int(np.sum(np.abs(cash_anchor - np.round(C_snap)) > 1))
    say("CoreUSDC G1 mismatches", g1, "of", len(anc))
    if g1:
        raise SystemExit("STOP: G1 failed (Core USDC)")
    C_end = cash_anchor.astype(float)
    cash_t0 = np.array([R4.state_at(cts, cval, int(x)) for x in t], dtype=float)
    dmin = np.full(len(t), np.nan)
    for i, x in enumerate(t):
        if x + DAY <= end_ts:
            dmin[i] = R4.window_min(cts, cval, int(cash_t0[i]), int(x), int(x) + DAY)
    legs = pd.read_csv(os.path.join(datasets, R4.QRT_LEGS), dtype={"neutral_raw": str, "event_amount_raw": str})
    legs = legs[["qrt_id", "leg", "ts", "neutral_raw"]].assign(block=legs["ts"])
    vis = t + R4.LOOKAHEAD_S
    Q_full = R4.qrt_outstanding(legs, anc).astype(float)
    Q_live = R4.qrt_outstanding(legs, anc, visible_by=vis).astype(float)
    bo, re_ = R4.load_borrow_repay(datasets, salt)
    drts = R4.detect_drt(bo, re_)
    R_full = R4.drt_outstanding(drts, anc, key="ts").astype(float)
    R_live = R4.drt_outstanding(drts, anc, visible_by=vis, key="ts").astype(float)
    q2a, q2b = R4.day_ts(R4.Q2[0]), R4.day_ts(R4.Q2[1])
    res = t + DAY <= end_ts
    inq2 = (t + DAY > q2a) & (t < q2b)
    first = t >= R4.day_ts(R4.SCORE_FIRST)
    P = {"origins": origins, "t": t, "anc": anc, "S_snap": S_snap, "C_end": C_end, "cash_t0": cash_t0, "dmin": dmin,
         "Q_full": Q_full, "Q_live": Q_live, "R_full": R_full, "R_live": R_live,
         "score": np.where(first & res & ~inq2)[0], "q2": np.where(first & res & inq2)[0],
         "cts": cts, "cval": cval, "legs": legs, "drts": drts, "end_ts": end_ts}
    return P


def load_c2(datasets, m, salt, drt_inputs, say):
    """R10.4-B load_market (unchanged call) plus the per-transaction path and round trips M2 needs."""
    P = RB.load_market(datasets, m, salt, drt_inputs, say)
    bdir, stem, asset, dec, dep = RB.MARKETS[m]
    tin = pd.read_csv(os.path.join(datasets, RB.C2_DIR, f"raw-transfers-{stem}-in.csv.gz"), dtype={"amount_raw": str})
    tout = pd.read_csv(os.path.join(datasets, RB.C2_DIR, f"raw-transfers-{stem}-out.csv.gz"),
                       dtype={"amount_raw": str})
    tl = RB.cash_path(tin, tout, dec)
    ev = RB.load_events(datasets, bdir, stem, dec, salt)
    ev["delta1_raw"] = [None if not isinstance(x, str) else str(RB.to_micro(x, dec)) for x in ev["delta1_raw"]]
    ev_raw = RB.load_events(datasets, bdir, stem, dec, salt)
    stl = RB.supply_timeline(ev_raw, dec)
    del ev_raw
    qrts, _ = R9.run_qrt(ev, stl)
    legs = RB.qrt_legs(qrts)
    bo, re_ = drt_inputs[m]
    drts = R4.detect_drt(bo, re_)
    # consistency with load_market's round-trip arrays
    if not np.array_equal(R4.qrt_outstanding(legs, P["anc"]).astype(float), P["Q_full"]):
        raise SystemExit(f"STOP: {m} QRT rebuild differs from load_market")
    P.update({"score": P["sets"]["24h"]["score"], "q2": P["sets"]["24h"]["q2"],
              "cts": tl["ts"].to_numpy(np.int64), "cval": tl["cash"].to_numpy(np.int64), "legs": legs,
              "drts": drts, "end_ts": RB.END_TS})
    return P


def add_m2_inputs(P):
    P["exmin_full"], P["exmin_live"] = ex_minima(P["t"], P["cts"], P["cval"], P["legs"], P["drts"], P["end_ts"])
    P["done_ts"] = rt_done_times(P["legs"], P["drts"])
    return P


# ---------------------------------------------------------------------------------------------
# scoring
# ---------------------------------------------------------------------------------------------
def ratio_series(dmin, cash_t0):
    ratio = np.full(len(dmin), np.nan)
    ok = np.isfinite(dmin) & (cash_t0 > 0)
    ratio[ok] = dmin[ok] / cash_t0[ok]
    return ratio


def paired_rows(P, fcs, idx):
    """rows where every candidate in fcs, the empirical baseline, no-change and the truth exist."""
    ratio = ratio_series(P["dmin"], P["cash_t0"])
    rows, miss = [], {"model": 0, "emp": 0, "truth_or_nc": 0}
    for n in idx:
        n = int(n)
        if any(fc.get(n) is None for fc in fcs.values()):
            miss["model"] += 1
            continue
        em = R5.emp_baseline(ratio, P["cash_t0"], n, H24)
        if em is None:
            miss["emp"] += 1
            continue
        y, nc = P["dmin"][n], (P["dmin"][n - 1] if n >= 1 else np.nan)
        if not (np.isfinite(y) and np.isfinite(nc)):
            miss["truth_or_nc"] += 1
            continue
        rows.append({"n": n, "origin": P["origins"][n], "y": y, "nc": nc, "S": P["S_snap"][n],
                     "cash_t0": P["cash_t0"][n], "e": np.asarray(em, float),
                     "q": {k: np.asarray(fc[n]["q1"], float) for k, fc in fcs.items()},
                     "w": fcs.get("M2", {}).get(n, {}).get("w") if "M2" in fcs else None})
    return rows, miss


def losses(rows, key):
    y = np.array([r["y"] for r in rows])
    Q = np.array([r["e"] if key == "E" else (np.repeat(r["nc"], 3) if key == "NC" else r["q"][key])
                  for r in rows])
    return R5.pinball3(y, Q) / MICRO, y, Q


def market_summary(rows, models):
    out = {}
    Le, y, E = losses(rows, "E")
    Ln, _, _ = losses(rows, "NC")
    S = np.array([r["S"] for r in rows]) / MICRO
    for k in models:
        Lm, _, Q = losses(rows, k)
        d = Lm - Le
        st, p = R5.dm_hln(d)
        lrv = RB.nw_lrv(d)
        out[k] = {"n": len(rows), "mean_loss_usd": float(Lm.mean()), "mean_loss_emp_usd": float(Le.mean()),
                  "mean_loss_nc_usd": float(Ln.mean()),
                  "skill_vs_empirical": float(1 - Lm.mean() / Le.mean()),
                  "skill_vs_nochange": float(1 - Lm.mean() / Ln.mean()),
                  "skill_supply_scaled_vs_empirical": float(1 - (Lm / S).sum() / (Le / S).sum()),
                  "dm_vs_empirical_insample": {"stat": st, "p": p},
                  "rel_effect": float(Lm.mean() / Le.mean() - 1.0),
                  "rel_lrsd": float(np.sqrt(lrv) / Le.mean()) if lrv > 0 else None,
                  "hit": {str(q): float(np.mean(y < Q[:, j])) for j, q in enumerate(QS)},
                  "hit_emp": {str(q): float(np.mean(y < E[:, j])) for j, q in enumerate(QS)}}
        years = {}
        for yy in ("2024", "2025", "2026"):
            mk = np.array([r["origin"].startswith(yy) for r in rows])
            if mk.sum():
                years[yy] = {"n": int(mk.sum()), "skill_vs_empirical": float(1 - Lm[mk].mean() / Le[mk].mean())}
        out[k]["by_year"] = years
    return out


def pooled(rows_by_market, model):
    dates, e_by, Lm_s, Le_s, Ln_s = {}, {}, [], [], []
    for m, rows in rows_by_market.items():
        Lm, _, _ = losses(rows, model)
        Le, _, _ = losses(rows, "E")
        Ln, _, _ = losses(rows, "NC")
        S = np.array([r["S"] for r in rows]) / MICRO
        dates[m] = [r["origin"] for r in rows]
        e_by[m] = (Lm - Le) / S
        Lm_s.append(Lm / S)
        Le_s.append(Le / S)
        Ln_s.append(Ln / S)
    ds, D, _ = RB.pooled_dk(dates, e_by)
    st, p = R5.dm_hln(D)
    Lm_s, Le_s, Ln_s = np.concatenate(Lm_s), np.concatenate(Le_s), np.concatenate(Ln_s)
    return {"n_market_origins": int(len(Lm_s)), "n_dates": len(ds),
            "skill_supply_scaled_vs_empirical": float(1 - Lm_s.sum() / Le_s.sum()),
            "skill_supply_scaled_vs_nochange": float(1 - Lm_s.sum() / Ln_s.sum()),
            "dm_dk_vs_empirical_insample": {"stat": st, "p": p}}


def select(sk_m1, sk_m2, margin=SELECT_MARGIN):
    return "M2" if (sk_m2 - sk_m1) >= margin - 1e-12 else "M1"


def guard_file(path):
    txt = gzip.open(path, "rt").read() if path.endswith(".gz") else open(path).read()
    if ADDR_RE.search(txt):
        raise SystemExit(f"STOP: address-like string in {path}")


def git_meta():
    here = os.path.dirname(os.path.abspath(__file__))

    def git(*a):
        try:
            return subprocess.run(["git", "-C", here, *a], capture_output=True, text=True,
                                  timeout=30).stdout.strip() or None
        except Exception:
            return None
    deps = ("r1111_cash.py", "r104_cash.py", "r104b_c2.py", "r115_depositor_cash.py", "r9_correct.py", "a_touch.py")
    return {"git_head": git("rev-parse", "HEAD"), "tree_dirty": bool(git("status", "--porcelain", "--", *deps)),
            "sha256": {d: R4.sha256_file(os.path.join(here, d)) for d in deps},
            "r104_cash_equals_7b6ca7aa": subprocess.run(["git", "-C", here, "diff", "--quiet", "7b6ca7aa", "--",
                                                         "r104_cash.py"]).returncode == 0,
            "r104b_c2_equals_6b6ef6be": subprocess.run(["git", "-C", here, "diff", "--quiet", "6b6ef6be", "--",
                                                        "r104b_c2.py"]).returncode == 0,
            "python": sys.version.split()[0], "numpy": np.__version__, "pandas": pd.__version__}


# ---------------------------------------------------------------------------------------------
# development run
# ---------------------------------------------------------------------------------------------
def cmd_dev(a):
    os.makedirs(a.out, exist_ok=True)
    started = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    log = open(os.path.join(a.out, "run.log"), "a")

    def say(*m):
        s = " ".join(str(x) for x in m)
        print(s, flush=True)
        log.write(s + "\n")
        log.flush()

    say("START dev", started)
    meta = git_meta()
    say("code", json.dumps(meta))
    if not (meta["r104_cash_equals_7b6ca7aa"] and meta["r104b_c2_equals_6b6ef6be"]):
        raise SystemExit("STOP: frozen dependencies differ")
    if meta["tree_dirty"] or not (meta["git_head"] or "").startswith(a.code_sha):
        raise SystemExit("STOP: run from the clean committed sha")
    salt = secrets.token_hex(32)
    markets = {}
    say("load CoreUSDC")
    markets["CoreUSDC"] = add_m2_inputs(load_core_usdc(a.datasets, salt, say))
    drt_inputs = RB.load_borrow_repay_all(a.datasets, salt)
    for m in RB.MARKETS:
        say("load", m)
        markets[m] = add_m2_inputs(load_c2(a.datasets, m, salt, drt_inputs, say))
    results = {"schema": SCHEMA_DEV, "code_sha": a.code_sha, "code": meta, "started_utc": started,
               "decisions": DEV_DECISIONS, "per_market": {}, "q2_reported": {}, "counts": {}}
    rows_by, rows_q2, out_rows = {}, {}, []
    for m, P in markets.items():
        idx = np.concatenate([P["score"], P["q2"]])
        say(m, "forecast M0 M1")
        m0, m1, full, live = run_m0_m1(P, idx)
        say(m, "forecast M2")
        m2 = run_m2(P, idx, full, live)
        # self-check: M2 with w = 1 reproduces M0 (D-R11.11a)
        chk = run_m2(P, P["score"][:: max(1, len(P["score"]) // 15)], full, live, w_override=1.0)
        dev = max(float(np.max(np.abs(chk[n]["q1"] - m0[n]["q1"]) / max(1.0, P["S_snap"][n])))
                  for n in chk if chk[n] is not None and m0.get(n) is not None)
        say(m, "self-check M2(w=1) vs M0 max |dq|/S", dev)
        if dev > 1e-9:
            raise SystemExit(f"STOP: M2(w=1) != M0 for {m}")
        fcs = {"M0": m0, "M1": m1, "M2": m2}
        rows, miss = paired_rows(P, fcs, P["score"])
        rq, _ = paired_rows(P, fcs, P["q2"])
        rows_by[m], rows_q2[m] = rows, rq
        ws = np.array([r["w"] for r in rows])
        results["counts"][m] = {"scoring": len(rows), "missing": miss, "q2": len(rq),
                                "qrt": int(P["legs"]["qrt_id"].nunique()) if len(P["legs"]) else 0,
                                "drt": len(P["drts"]), "w_eq_1": int((ws >= 1.0).sum()),
                                "w_between": int(((ws > 0) & (ws < 1)).sum()), "w_eq_0": int((ws == 0).sum())}
        results["per_market"][m] = market_summary(rows, ("M0", "M1", "M2"))
        if rq:
            results["q2_reported"][m] = {k: v["skill_vs_empirical"] for k, v in
                                         market_summary(rq, ("M0", "M1", "M2")).items()}
        say(m, json.dumps({k: (v["n"], round(v["skill_vs_empirical"], 4), round(v["skill_supply_scaled_vs_empirical"],
                                                                                   4)) for k, v in
                           results["per_market"][m].items()}), json.dumps(results["counts"][m]))
        for r in rows:
            out_rows.append({"market": m, "origin": r["origin"], "y_usd": r["y"] / MICRO, "supply_usd": r["S"] / MICRO,
                             "cash_t0_usd": r["cash_t0"] / MICRO, "nochange_usd": r["nc"] / MICRO, "w": r["w"],
                             **{f"{k}_q{int(q * 100):02d}": r["q"][k][j] / MICRO for k in ("M0", "M1", "M2")
                                for j, q in enumerate(QS)},
                             **{f"emp_q{int(q * 100):02d}": r["e"][j] / MICRO for j, q in enumerate(QS)}})
    pool = {k: pooled(rows_by, k) for k in ("M0", "M1", "M2")}
    results["pooled"] = pool
    sk1 = pool["M1"]["skill_supply_scaled_vs_empirical"]
    sk2 = pool["M2"]["skill_supply_scaled_vs_empirical"]
    chosen = select(sk1, sk2)
    results["selection"] = {"criterion": "pooled supply-scaled skill vs empirical; M2 iff >= M1 + 1.0 pp",
                            "skill_M1": sk1, "skill_M2": sk2, "chosen": chosen}
    # power inputs for C1 (D-R11.11b): per-market relative effect and relative NW lag-7 long-run sd
    results["power_inputs"] = {m: {"rel_effect": results["per_market"][m][chosen]["rel_effect"],
                                   "rel_lrsd": results["per_market"][m][chosen]["rel_lrsd"],
                                   "n": results["per_market"][m][chosen]["n"]} for m in markets}
    say("pooled", json.dumps({k: (v["n_market_origins"], round(v["skill_supply_scaled_vs_empirical"], 4),
                                  v["dm_dk_vs_empirical_insample"]["p"]) for k, v in pool.items()}))
    say("SELECTED", chosen, "M1", sk1, "M2", sk2)
    results["finished_utc"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    rp = os.path.join(a.out, "dev-results-r1111.json")
    with open(rp, "w") as f:
        json.dump(results, f, indent=1, default=str)
    fp = os.path.join(a.out, "dev-forecasts-r1111.csv.gz")
    pd.DataFrame(out_rows).to_csv(fp, index=False, compression="gzip")
    guard_file(rp)
    guard_file(fp)
    guard_file(os.path.join(a.out, "run.log"))
    say("END dev", results["finished_utc"], "results sha256", R4.sha256_file(rp))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("dev")
    d.add_argument("--datasets", required=True)
    d.add_argument("--out", required=True)
    d.add_argument("--code-sha", required=True)
    a = ap.parse_args()
    if a.cmd == "dev":
        cmd_dev(a)


if __name__ == "__main__":
    main()
