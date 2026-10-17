#!/usr/bin/env python3
"""Q26 round 9, R9.1(d) item 3: B6c, the cash-exit rung v4ac refit on snapshot-bias-corrected inputs (Aave V3 Core USDC).

Implements membrane-board `design/Q26_ROUND9_PREREG.md` R9.1(d)3 (registered at board commit 691cb27) with its
Deviations D1-D3 and the B6c run readings fixed in Deviation D4 before this code computed any corrected label, fit or
score. Everything else is B6 (`b6_cash.py` at 80e83a01), B5 and B4, imported unchanged.

Corrected inputs (D4):
  * pool features from the R9.1(a) W24 time-weighted pool state (`w24-pool-usdc.csv`, run-dfdd3ad8): util and its
    1-day change from w24_mean_util, log(cash / bal) from w24_mean_cash, share of supply from w24_mean_supply, and
    the cash_blocked flag from w24_mean_cash; borrow APR and its 1-day change from the W24 mean variable borrow rate
    that L1c built from the same RDU logs (`panel-l1c.csv.gz`, l1c-run-7ce423b5, sha256 pinned).
  * the R9.1(b) same-address round trips (QRTs, `qrt-legs-usdc.csv.gz`, joined to depositor-events on event key)
    neutralised in the unit's aToken path, daily anchors, own-flow logs and y_cash withdrawals: the withdraw leg loses
    its neutralised amount and each redeposit leg loses its own share. Feature-time anchors count a QRT only when its
    last redeposit leg is at or before t0 + 60 min (R9.1(b) look-ahead rule); labels neutralise every QRT whose
    withdraw leg falls in (t0, t0 + h].
  * y_cash, y_econ and y_old all recomputed on the neutralised paths; v4ac (and its v2 own / pop baselines) refit
    once per B3 fold x cell on the corrected y_cash; B4 and v4ae are NOT refit (R9.1(d)4): their published B6
    predictions are joined by (unit, date) and scored on the corrected labels, as is the uncorrected B6 v4ac.

Phases (one fresh --out):
  --phase run       ONCE: gate G0 (this code with neutralisation and W24 switched off reproduces the published B6
                    labels exactly), corrected inputs, v4ac fits, scoring, (e) budgets, D3 debt-crossing counts,
                    2026Q3 with and without the drain-role unit -> results-b6c.json, labels-b6c.csv,
                    predictions-b6c-*.csv.gz, asof-fits-b6c.json (refuses overwrite; refuses a dirty tree)
  --phase freeze    frozen-b6c.json + freeze-record.json (sha256)
  --phase manifest  sha256 of every output

No address is written to any output: units are published as their integer index in the sorted USDC universe (as B6),
QRT units by role. The run refuses to write a file holding a 0x + 40-hex string.
"""
import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import json  # noqa: E402
import math  # noqa: E402
import re  # noqa: E402
import subprocess  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402
from datetime import datetime, timezone  # noqa: E402

import numpy as np  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import b_behavior as B  # noqa: E402
import bg_gradient as G  # noqa: E402
import b3_segments as S  # noqa: E402
import b4_depositor as F  # noqa: E402
import b5_econ as E5  # noqa: E402
import b6_cash as B6  # noqa: E402

PREREG = {"repo": "triccs/membrane-board", "path": "design/Q26_ROUND9_PREREG.md", "section": "R9.1(d)3 (B6c)",
          "commit": "691cb27", "deviations": "D1, D2, D3, D4 (B6c readings, fixed before the run)",
          "parents": {"B6": "design/Q26_ROUND8_PREREG.md R8.2, D11, D12 (membrane-app b6_cash.py 80e83a01)"}}
R9_RUN = "history-forecasts/r9/run-dfdd3ad8/"
R9_SHA = {"w24-pool-usdc.csv": "b3cbe460e38ac62f6abfc4b3521ae26328f9aa7ea9ec81c2357f56540f991912",
          "qrt-legs-usdc.csv.gz": "f3da86020fbd5dd4841e816c66611d3bb31a65a9812d5c18bf87f96d5dc5bd8e",
          "qrt-usdc.csv": "d94d8e78484a66a823388b007432cbf7043334a99ec3bcb41e60774719033f8b"}
L1C_PANEL = "history-forecasts/r9/l1c-run-7ce423b5/panel-l1c.csv.gz"     # W24 mean variable borrow rate (L1c)
L1C_PANEL_SHA = "6d19cc71c06f6af7a269eff12352cba47154a600521b000367836e7b02c4572d"
B6_RUN = "history-forecasts/b6/run-80e83a01/"
B6_FROZEN_SHA = "fef356c1542ea867a8b99d09c6b100f792c92699c95e9755efb892141f7bf232"
LOOKAHEAD_S = 3600                                  # R9.1(b) feature look-ahead: redeposit leg <= t0 + 60 min
CUT_PRIMARY = "2026-01-22"                          # D3 pre-drain cutoff (primary)
CUT_JULY = "2026-07-01"                             # pre-July (reported beside)
DRAIN_R_FROM = "2026-07-09"                         # R8 D12 correction 5 period start
FLIP_BUDGET = 0.005                                 # (e) label flips <= 0.5% of row x cell labels
MODEL_DBSS, MODEL_DLNR = 0.02, 0.2                  # (e) model change outside the drain
NONINF_LO = -0.002                                  # R9.1(d)3 non-inferiority bound
DEBT_MIN_USD = 20_000_000                           # D3 debt-side crossing: borrow >= $20M
DEBT_WINDOW_S = 2 * 3600                            # repaid within 2 h
DEBT_FILL = 0.95                                    # repaid = repays reach 95% of the borrow (the QRT fill rule)
SEED_B6 = B6.SEED_B6                                # default_rng(20261100), as B6
SEED_Q3 = 20261117                                  # 2026Q3 with / without the drain-role unit (fresh stream)
SCORE_RUNGS = ("v4ac", "v4ae", "b4", "b6")
COMP_C = B6.COMP_C + (("v4ac_vs_b6", "v4ac", "b6"), ("b6_vs_b4", "b6", "b4"), ("b6_vs_v4ae", "b6", "v4ae"))
COMP_Q3 = (("v4ac_vs_b4", "v4ac", "b4"), ("v4ac_vs_v4ae", "v4ac", "v4ae"), ("v4ac_vs_b6", "v4ac", "b6"),
           ("b6_vs_b4", "b6", "b4"))
ADDR_RE = re.compile(r"0x[0-9a-fA-F]{40}(?![0-9a-fA-F])")

DECISIONS = [
    "B6c-1 everything D4 does not change is B6 (b6_cash.py at 80e83a01): rows, B3 folds, the v4a specification, "
    "the shared B4 fitter, the 2-D monotone fix without mask, B4.3 bootstrap (default_rng(20261100), 30-day blocks, "
    "2,000 replicates, B5 set order), the B6-6 preferred-rung rule, G.7 labels, the stress window.",
    "B6c-2 pool features (D4): util[d] = w24_mean_util, d_util = w24_mean_util[d] - w24_mean_util[d - 1], "
    "log_cash_over_bal = log(w24_mean_cash / bal), share_of_supply = bal / w24_mean_supply, cash_blocked = "
    "x * bal(t0) > w24_mean_cash (raw W24 of R9.1(a), run-dfdd3ad8); bapr = 100 x the W24 mean variable borrow "
    "rate of panel-l1c.csv.gz (L1c, 7ce423b5; same RDU logs), d_bapr its 1-day change. Origins without a W24 row "
    "(2023-02-01, and 2026-10-07 for bapr) have undefined features.",
    "B6c-3 QRT neutralisation (D4): each QRT of qrt-legs-usdc.csv.gz is joined on (block, log_index) to the "
    "depositor-events row (Burn owner = party1, Mint onBehalfOf = party1, D1); the withdraw leg's balance change "
    "gains the QRT's neutralised amount and each redeposit leg's change loses its neutral_raw; the per-block path, "
    "the per-log own-flow table and the y_cash withdrawal (Burn amount - neutralised amount) change accordingly. "
    "Label-view daily anchors add the amount still outstanding at the snapshot block (paths, y_old, y_econ, y_cash "
    "paths). Feature-view anchors (row bal(t0), the $1M row rule, segments, maxdd90, log10 bal, cash/bal, share) "
    "add it only for QRTs whose last redeposit leg ts <= T[d] + 3,600 s.",
    "B6c-4 label rule (D4): a QRT is neutralised in the label of a window (t0, t0 + h] iff its withdraw leg is in "
    "the window, wherever its redeposit legs fall (a QRT completes within 2 h by definition). Redeposit Mints never "
    "enter y_cash.",
    "B6c-5 comparators (D4, R9.1(d)4): b4, v4ae and the uncorrected B6 v4ac ('b6') are the published B6 "
    "predictions (run-80e83a01) joined by (unit, date). All comparisons and the pass rule use the common rows (B6c "
    "test rows, resolved, that have a B6 prediction in that horizon) with y = corrected y_cash. B6c-only rows are "
    "reported separately.",
    "B6c-6 pass rule (D4): B6c replaces B6 iff, on corrected labels, BSS(v4ac B6c vs v4ac B6) has a 95% CI lower "
    "bound > -0.002 in every pooled (h, x) cell (5 horizons x 5 sizes) of the B6-order bootstrap.",
    "B6c-7 debt crossings (D3, D4): a variable Borrow (onBehalfOf = unit, any Core reserve) >= $20M at the daily "
    "oracle price, whose same-unit repays within 2 h reach 95% of it, with a 00:00Z boundary between the borrow and "
    "the completing repay. A row x cell is affected iff such a borrow is in (t0, t0 + h]. Primary keeps them; the "
    "sensitivity drops them.",
    "B6c-8 (e) budgets: flips = corrected vs published B6 labels on common rows x x cells, for y_cash (B6c), y_old "
    "(B4) and y_econ (B5); pre-2026-01-22 (primary), pre-2026-07-01 (beside), all dates without the drain-role unit; "
    "flagged above 0.5%. Model change outside the drain: per pooled cell on pre-cutoff origins, BSS(v4ac B6c vs B6) "
    "and ln R(B6c) - ln R(B6), flagged at |dBSS| > 0.02 or |d ln R| > 0.2.",
    "B6c-9 drain-role unit = the universe unit that owns the role 'drain-role' QRT legs; reported by role only. "
    "2026Q3 fold: pooled cells with and without it, default_rng(20261117), same block bootstrap.",
]


def code_meta():
    here = os.path.dirname(os.path.abspath(__file__))

    def git(*a):
        try:
            return subprocess.run(["git", "-C", here, *a], capture_output=True, text=True,
                                  timeout=30).stdout.strip() or None
        except Exception:
            return None
    me = os.path.basename(__file__)
    deps = ("b6_cash.py", "b5_econ.py", "b4_depositor.py", "bg_gradient.py", "b3_segments.py", "b_behavior.py")
    return {"git_head": git("rev-parse", "HEAD"), "last_commit_b6c_cash": git("log", "-1", "--format=%H", "--", me),
            "b6c_cash_sha256": B.sha256_file(os.path.abspath(__file__)),
            "tree_dirty": bool(git("status", "--porcelain", "--", me, *deps)),
            "deps_sha256": {d: B.sha256_file(os.path.join(here, d)) for d in deps},
            "python": sys.version.split()[0], "numpy": np.__version__,
            "sklearn": __import__("sklearn").__version__, "scipy": __import__("scipy").__version__}


# ---------------------------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------------------------
def load_r9(datasets_dir):
    import pandas as pd
    run = os.path.join(datasets_dir, R9_RUN)
    shas = {}
    for fn, want in R9_SHA.items():
        got = B.sha256_file(os.path.join(run, fn))
        if got != want:
            raise SystemExit(f"STOP: {R9_RUN}{fn} sha256 {got} != registered {want}")
        shas[R9_RUN + fn] = got
    legs = pd.read_csv(os.path.join(run, "qrt-legs-usdc.csv.gz"), dtype=str, keep_default_na=False)
    w24 = pd.read_csv(os.path.join(run, "w24-pool-usdc.csv"))
    pp = os.path.join(datasets_dir, L1C_PANEL)
    got = B.sha256_file(pp)
    if got != L1C_PANEL_SHA:
        raise SystemExit(f"STOP: {L1C_PANEL} sha256 {got} != {L1C_PANEL_SHA}")
    shas[L1C_PANEL] = got
    panel = pd.read_csv(pp, usecols=["origin", "t0", "borrow_apr"])
    w24 = w24.merge(panel[["origin", "borrow_apr"]], on="origin", how="left")
    return legs, w24, shas


def verify_b6_run(datasets_dir):
    run = os.path.join(datasets_dir, B6_RUN)
    man = json.load(open(os.path.join(run, "manifest.json")))
    out = {}
    for fn in ["frozen-b6.json", "results-b6.json"] + [f"predictions-b6-{h}-USDC.csv.gz" for h in G.HNAMES]:
        got = B.sha256_file(os.path.join(run, fn))
        if man["files"][fn]["sha256"] != got:
            raise SystemExit(f"STOP: {B6_RUN}{fn} sha256 {got} != its manifest")
        out[B6_RUN + fn] = got
    if out[B6_RUN + "frozen-b6.json"] != B6_FROZEN_SHA:
        raise SystemExit("STOP: frozen-b6.json is not the B6 freeze")
    return out


def map_legs(datasets_dir, legs, addrs):
    """Join QRT legs to depositor-events on (block, log_index) -> per-leg universe unit index (or -1). Checks the
    event type, that both legs of a QRT belong to one address, and returns per-QRT records. No address leaves."""
    import pandas as pd
    sp = G.reserve_spec(datasets_dir, "USDC")
    lb = legs["block"].astype(np.int64).to_numpy()
    want = set(lb.tolist())
    parts = []
    for p in sp["events"]:
        df = pd.read_csv(p, usecols=["block", "log_index", "type", "party1", "tx_hash"], dtype=str,
                         keep_default_na=False)
        b = pd.to_numeric(df["block"]).to_numpy(np.int64)
        parts.append(df[np.isin(b, list(want))])
    ev = pd.concat(parts, ignore_index=True)
    ev["k"] = ev["block"] + ":" + ev["log_index"]
    ev = ev.drop_duplicates("k").set_index("k")
    keys = legs["block"] + ":" + legs["log_index"]
    if not keys.isin(ev.index).all():
        raise SystemExit(f"STOP: {int((~keys.isin(ev.index)).sum())} QRT legs not found in depositor-events")
    e = ev.loc[keys.to_numpy()]
    if not (e["type"].to_numpy() == legs["event_type"].to_numpy()).all():
        raise SystemExit("STOP: a QRT leg's event type differs from depositor-events")
    if not (e["tx_hash"].str.lower().to_numpy() == legs["tx_hash"].str.lower().to_numpy()).all():
        raise SystemExit("STOP: a QRT leg's tx hash differs from depositor-events")
    a = e["party1"].str.lower().to_numpy()
    aarr = np.array(addrs)
    ui = np.minimum(np.searchsorted(aarr, a), len(aarr) - 1)
    unit = np.where(aarr[ui] == a, ui, -1).astype(np.int64)
    qid = legs["qrt_id"].to_numpy()
    per = {}
    for q, u, role in zip(qid, unit, legs["unit"].to_numpy()):
        per.setdefault(q, set()).add((int(u), role))
    if any(len(v) != 1 for v in per.values()):
        raise SystemExit("STOP: the legs of a QRT map to more than one address")
    qrts = []
    for q, g in legs.assign(_u=unit).groupby("qrt_id", sort=True):
        w = g[g["leg"] == "withdraw"]
        r = g[g["leg"] == "redeposit"]
        if len(w) != 1 or len(r) < 1:
            raise SystemExit(f"STOP: QRT {q} needs one withdraw leg and >= 1 redeposit leg")
        neutral = int(w["neutral_raw"].iloc[0])
        rl = [(int(b), int(li), int(t), int(nv)) for b, li, t, nv in
              zip(r["block"], r["log_index"], r["ts"], r["neutral_raw"])]
        if sum(x[3] for x in rl) != neutral:
            raise SystemExit(f"STOP: QRT {q} redeposit legs do not sum to its neutralised amount")
        if neutral > int(w["event_amount_raw"].iloc[0]):
            raise SystemExit(f"STOP: QRT {q} neutralised amount exceeds its withdraw leg")
        qrts.append({"qrt": q, "role": w["unit"].iloc[0], "unit": int(w["_u"].iloc[0]),
                     "w_block": int(w["block"].iloc[0]), "w_log": int(w["log_index"].iloc[0]),
                     "w_ts": int(w["ts"].iloc[0]), "neutral": neutral, "redeposit": sorted(rl),
                     "done_ts": max(x[2] for x in rl)})
    roles = {}
    for q in qrts:
        roles.setdefault(q["role"], set()).add(q["unit"])
    if any(len(v) != 1 for v in roles.values()):
        raise SystemExit("STOP: a QRT role maps to more than one universe unit")
    role_unit = {k: next(iter(v)) for k, v in roles.items()}
    return qrts, role_unit


# ---------------------------------------------------------------------------------------------
# Neutralisation (B6c-3), unit-tested on synthetic tables
# ---------------------------------------------------------------------------------------------
def leg_adjustments(qrts):
    """-> arrays (unit, block, log, adj) of balance-change adjustments: +neutral on the withdraw leg, -neutral_raw
    on each redeposit leg (QRTs whose unit is outside the universe are skipped)."""
    U, Bk, L, A = [], [], [], []
    for q in qrts:
        if q["unit"] < 0:
            continue
        U.append(q["unit"])
        Bk.append(q["w_block"])
        L.append(q["w_log"])
        A.append(q["neutral"])
        for b, li, _, nv in q["redeposit"]:
            U.append(q["unit"])
            Bk.append(b)
            L.append(li)
            A.append(-nv)
    return (np.array(U, np.int64), np.array(Bk, np.int64), np.array(L, np.int64), np.array(A, np.int64))


def apply_block_adjust(tab_unit, tab_block, tab_delta, adj):
    """tab sorted by (unit, block); adds each adjustment to the first entry of its (unit, block). Returns a new
    delta array (exact ints) and the number applied."""
    au, ab, _, aa = adj
    key = (np.asarray(tab_unit, np.int64) << 25) | np.asarray(tab_block, np.int64)
    if len(key) > 1 and np.any(np.diff(key) < 0):
        raise ValueError("table must be sorted by (unit, block)")
    q = (au << 25) | ab
    i = np.searchsorted(key, q, side="left")
    ok = (i < len(key)) & (key[np.minimum(i, len(key) - 1)] == q)
    if not ok.all():
        raise SystemExit(f"STOP: {int((~ok).sum())} QRT legs have no (unit, block) entry in the event table")
    d = np.array(tab_delta, copy=True)
    for ii, a in zip(i, aa):
        d[ii] += int(a)
    return d, int(len(i))


def anchor_adjust(qrts, blocks, T, lookahead=LOOKAHEAD_S):
    """Outstanding neutralised amount at each daily snapshot block. -> (label {(u, d): amt}, feature {(u, d): amt},
    straddle info). Label view counts every QRT; feature view only those whose last redeposit leg ts <= T[d] +
    lookahead."""
    blocks = np.asarray(blocks, dtype=np.int64)
    T = np.asarray(T, dtype=np.int64)
    lab, feat = {}, {}
    straddle = {"snapshots_outstanding": 0, "not_visible_at_feature_time": 0}
    for q in qrts:
        if q["unit"] < 0:
            continue
        d = int(np.searchsorted(blocks, q["w_block"], side="left"))
        while d < len(blocks):
            out = q["neutral"] - sum(nv for b, _, _, nv in q["redeposit"] if b <= blocks[d])
            if out <= 0:
                break
            k = (q["unit"], d)
            lab[k] = lab.get(k, 0) + out
            straddle["snapshots_outstanding"] += 1
            if q["done_ts"] <= T[d] + lookahead:
                feat[k] = feat.get(k, 0) + out
            else:
                straddle["not_visible_at_feature_time"] += 1
            d += 1
    return lab, feat, straddle


def adjusted_anchors(A, adj):
    A2 = np.array(A, copy=True)
    for (u, d), v in adj.items():
        A2[u, d] = A2[u, d] + v
    return A2


def neutral_withdrawals(wr_key_block, wr_key_log, wr_unit, wr_amount, wr_kind, qrts):
    """y_cash withdraw rows: Burn withdraw legs lose their neutralised amount. -> new amounts, applied count."""
    m = {(q["w_block"], q["w_log"]): (q["unit"], q["neutral"]) for q in qrts if q["unit"] >= 0}
    amt = np.array(wr_amount, dtype=np.int64, copy=True)
    hit = 0
    for i, (b, li) in enumerate(zip(wr_key_block, wr_key_log)):
        v = m.get((int(b), int(li)))
        if v is None:
            continue
        if wr_kind[i] != "burn" or int(wr_unit[i]) != v[0] or amt[i] < v[1]:
            raise SystemExit("STOP: a QRT withdraw leg is not a burn of its unit with amount >= neutralised")
        amt[i] -= v[1]
        hit += 1
    if hit != len(m):
        raise SystemExit(f"STOP: {len(m) - hit} QRT withdraw legs not found among the withdrawal rows")
    return amt, hit


def load_withdrawal_rows_keyed(datasets_dir, addrs, T0_first):
    """B6.load_withdrawal_rows with the event key kept (block, log_index)."""
    import pandas as pd
    sp = G.reserve_spec(datasets_dir, "USDC")
    aarr = np.array(addrs)
    cols = ["block", "log_index", "ts", "type", "party1", "party2", "delta1_raw"]
    U, TS, AM, K, BL, LI = [], [], [], [], [], []
    for p in sp["events"]:
        df = pd.read_csv(p, usecols=cols, dtype=str, keep_default_na=False)
        df = df[(df["delta1_raw"] != "") & df["type"].isin(["Burn", "Mint"])]
        a = df["party1"].str.lower().to_numpy()
        ui = np.minimum(np.searchsorted(aarr, a), len(aarr) - 1)
        inu = aarr[ui] == a
        df, ui = df[inu], ui[inu]
        ts = pd.to_numeric(df["ts"]).to_numpy(np.int64)
        for u, t, ty, p1, p2, d, b, li in zip(ui, ts, df["type"].to_numpy(), df["party1"].to_numpy(),
                                              df["party2"].to_numpy(), df["delta1_raw"].to_numpy(),
                                              df["block"].to_numpy(), df["log_index"].to_numpy()):
            amt, kind = B6.classify_withdrawals(ty, p1, p2, d)
            if not kind or t <= T0_first:
                continue
            U.append(u)
            TS.append(t)
            AM.append(amt)
            K.append(kind)
            BL.append(int(b))
            LI.append(int(li))
    return {"unit": np.array(U, np.int64), "ts": np.array(TS, np.int64), "amount": np.array(AM, np.int64),
            "kind": np.array(K), "block": np.array(BL, np.int64), "log": np.array(LI, np.int64)}


def patch_pool(ctx, R, w24):
    """B6c-2: replace util, cash and supply at the daily slots with the W24 values (micro-units for cash, supply)."""
    D = ctx.D
    st = {k: np.array(v, copy=True) for k, v in R.state.items()}
    idx = np.array([ctx.day_index.get(s, -1) for s in w24["origin"]])
    beyond = w24["origin"].to_numpy()[idx < 0]
    if len(beyond) and beyond.min() <= ctx.days[-1]:
        raise SystemExit("STOP: a W24 origin inside the snapshot range is not a snapshot day")
    w24 = w24[idx >= 0]
    idx = idx[idx >= 0]
    if not (np.asarray(ctx.T)[idx] == w24["t0"].to_numpy(np.int64)).all():
        raise SystemExit("STOP: W24 t0 differs from the snapshot T")
    st["util"][:D] = np.nan
    st["bapr"][:D] = np.nan
    st["cash"][:D] = -1
    st["supply"][:D] = -1
    st["util"][idx] = w24["w24_mean_util"].to_numpy(float)
    st["bapr"][idx] = 100.0 * w24["borrow_apr"].to_numpy(float)          # percent, as the snapshot bapr
    st["cash"][idx] = np.round(w24["w24_mean_cash"].to_numpy(float) * G.MICRO).astype(np.int64)
    st["supply"][idx] = np.round(w24["w24_mean_supply"].to_numpy(float) * G.MICRO).astype(np.int64)
    snap_gap = np.nanmedian(np.abs(np.asarray(R.state["util"])[idx] - st["util"][idx]))
    bapr_gap = np.nanmedian(np.abs(np.asarray(R.state["bapr"])[idx] - st["bapr"][idx]))
    R.state = st
    return {"w24_days": int(len(idx)), "days_without_w24": int(D - len(idx)), "w24_rows_after_last_snapshot": int(len(beyond)),
            "median_abs_util_gap_vs_snapshot": float(snap_gap), "median_abs_bapr_pct_gap_vs_snapshot": float(bapr_gap),
            "days_without_w24_bapr": int(D - np.isfinite(st["bapr"][:D]).sum())}


def patch_usdc(ctx, R, qrts):
    """B6c-3 on the loaded USDC reserve: per-block and per-log deltas, label- and feature-view anchors, paths."""
    D = ctx.D
    gate_raw = G.path_gate_check(ctx, R)
    adj = leg_adjustments(qrts)
    bd, nb = apply_block_adjust(R.blocks["unit"], R.blocks["block"], R.blocks["delta"], adj)
    R.blocks = dict(R.blocks, delta=bd)
    ld, nl = apply_block_adjust(R.logs["unit"], R.logs["block"], R.logs["delta"], adj)
    R.logs = dict(R.logs, delta=ld, delta_f=ld.astype(float) / R.scale)
    lab, feat, strad = anchor_adjust(qrts, ctx.blocks, ctx.T)
    if R.scale != 1:
        raise SystemExit("STOP: USDC expected at scale 1")
    R.A_label = adjusted_anchors(R.A_exact, lab)
    R.A_feature = adjusted_anchors(R.A_exact, feat)
    R.paths = G.build_paths(R.blocks["unit"], R.blocks["ts"], R.blocks["delta"], R.A_label[:, :D], R.Av[:, :D],
                            ctx.T, R.scale)
    R.widx = G.WindowIndex(R.paths)
    R.fb = G.own_flow_buckets(R.logs["unit"], R.logs["ts"], R.logs["delta_f"], R.n, ctx.T)
    R.A = R.A_label
    gate_new = G.path_gate_check(ctx, R)
    if gate_new["share_pass_d2"] < gate_raw["share_pass_d2"] or gate_new["pairs"] != gate_raw["pairs"]:
        raise SystemExit(f"STOP: neutralised paths fail the G.2 path gate more often than raw: {gate_new} vs {gate_raw}")
    R.A_exact = R.A_feature
    R.A = R.A_feature
    return {"path_gate_raw": gate_raw, "path_gate_neutralised": gate_new, "legs_applied_blocks": nb, "legs_applied_logs": nl, "anchor_cells_label": len(lab),
            "anchor_cells_feature": len(feat), "anchor_usd_label": sum(lab.values()) / G.MICRO,
            "anchor_usd_feature": sum(feat.values()) / G.MICRO, **strad}


# ---------------------------------------------------------------------------------------------
# Rows, labels
# ---------------------------------------------------------------------------------------------
def build_c(datasets_dir, ctx, res, qrts=None, log=print):
    """B6 rows and labels on the given reserves. With qrts the USDC reserve must already be patched (feature-view
    anchors in R.A); the label-view anchors are swapped in for the econ / cash indices."""
    rows = G.build_rows(ctx, res, compute_labels=True)
    F.add_segments(rows, S.load_flags(datasets_dir))
    F.v4a_features(rows, res, ctx.D)
    R = res[0]
    if qrts is not None:
        R.A = R.A_label
    debt_dir = os.path.join(datasets_dir, B6.DEBT_DIR)
    E, debt, dinfo, dshas = E5.build_econ(datasets_dir, debt_dir, ctx, res, rows, log)
    T = np.asarray(ctx.T, dtype=np.int64)
    wr = load_withdrawal_rows_keyed(datasets_dir, R.addrs, int(T[0]))
    winfo = {"rows": int(len(wr["ts"]))}
    if qrts is not None:
        wr["amount"], winfo["qrt_withdraw_legs_neutralised"] = neutral_withdrawals(
            wr["block"], wr["log"], wr["unit"], wr["amount"], wr["kind"], qrts)
        R.A = R.A_feature
    wd = B6.withdrawal_table(wr["unit"], wr["ts"], wr["amount"], wr["kind"])
    args = (E["unit"], E["t"], E["bal"], E["RESOLD"])
    Yc, RESc = B6.cash_labels(R, debt, wd, T, *args)
    if not np.array_equal(RESc, E["RES"]):
        raise SystemExit("STOP: y_cash resolved set differs from y_econ's (B6-2)")
    C = dict(E)
    C["Y"] = Yc
    C["YECON"] = E["Y"]
    mdd = rows["F4"]["x10"][E["sel"], 1]
    C["F4"] = E5.econ_hist_features(C["unit"], C["t"], Yc, RESc, mdd, rows["n_units"], ctx.D)
    winfo["unit_ts_points"] = int(len(wd["ts"]))
    return C, {"debt": dinfo, "withdrawals": winfo}, dshas


def load_b6_predictions(datasets_dir, ctx, C):
    """Published B6 test rows joined to C by (unit, date). -> has (n, NH), PR {b6, b4, v4ae} (n, NC), L {ycash,
    yecon, y, cb} (n, NC) int8 (-1 where absent)."""
    import pandas as pd
    run = os.path.join(datasets_dir, B6_RUN)
    n = len(C["t"])
    D = ctx.D
    key = C["unit"].astype(np.int64) * D + C["t"]
    o = np.argsort(key)
    ks = key[o]
    has = np.zeros((n, G.NH), bool)
    PR = {k: np.full((n, G.NC), np.nan) for k in ("b6", "b4", "v4ae")}
    L = {k: np.full((n, G.NC), -1, np.int8) for k in ("ycash", "yecon", "y", "cb")}
    missing = {}
    for hi, h in enumerate(G.HNAMES):
        df = pd.read_csv(os.path.join(run, f"predictions-b6-{h}-USDC.csv.gz"))
        dk = df["unit"].to_numpy(np.int64) * D + df["date"].map(ctx.day_index).to_numpy(np.int64)
        j = np.searchsorted(ks, dk)
        ok = (j < n) & (ks[np.minimum(j, n - 1)] == dk)
        missing[h] = int((~ok).sum())
        rows = o[j[ok]]
        has[rows, hi] = True
        for ci in G.XCELL[hi]:
            cid = G.CELLS[ci]["id"]
            PR["b6"][rows, ci] = df[f"v4ac_{cid}"].to_numpy(float)[ok]
            PR["b4"][rows, ci] = df[f"b4_{cid}"].to_numpy(float)[ok]
            PR["v4ae"][rows, ci] = df[f"v4ae_{cid}"].to_numpy(float)[ok]
            L["ycash"][rows, ci] = df[f"ycash_{cid}"].to_numpy()[ok]
            L["yecon"][rows, ci] = df[f"yecon_{cid}"].to_numpy()[ok]
            L["y"][rows, ci] = df[f"y_{cid}"].to_numpy()[ok]
            L["cb"][rows, ci] = df[f"cash_blocked_{cid}"].to_numpy()[ok]
    return has, PR, L, missing


def g0_reproduction(C, has, L):
    """G0: with neutralisation and W24 off, this code's labels equal the published B6 labels on every B6 row."""
    test = (C["fold"] >= 0) & C["feat_ok"]
    out = {}
    for hi, h in enumerate(G.HNAMES):
        rows_c = test & C["RES"][:, hi]
        n_b6_not_c = int((has[:, hi] & ~rows_c).sum())
        n_c_not_b6 = int((rows_c & ~has[:, hi]).sum())
        m = has[:, hi]
        mm = 0
        for ci in G.XCELL[hi]:
            mm += int((C["Y"][m, ci] != L["ycash"][m, ci]).sum())
            mm += int((C["YECON"][m, ci] != L["yecon"][m, ci]).sum())
            mm += int((C["YOLD"][m, ci] != L["y"][m, ci]).sum())
            mm += int((C["CAPOLD"][m, ci].astype(np.int8) != L["cb"][m, ci]).sum())
        out[h] = {"rows_b6": int(m.sum()), "b6_rows_not_in_c": n_b6_not_c, "c_rows_not_in_b6": n_c_not_b6,
                  "label_mismatches": mm, "equal": mm == 0 and n_b6_not_c == 0 and n_c_not_b6 == 0}
    out["all_equal"] = all(v["equal"] for v in out.values() if isinstance(v, dict))
    return out


# ---------------------------------------------------------------------------------------------
# Debt-side crossings (D3, B6c-7)
# ---------------------------------------------------------------------------------------------
def find_crossings(b_unit, b_ts, b_usd, r_unit, r_ts, r_usd, min_usd=DEBT_MIN_USD * G.MICRO,
                   window=DEBT_WINDOW_S, fill=DEBT_FILL):
    """-> (unit, borrow ts) of borrows >= min_usd whose same-unit repays in [ts, ts + window] reach fill x the
    borrow, with a 00:00Z boundary in (borrow ts, completion ts]. Amounts in micro-USD."""
    ro = np.lexsort((r_ts, r_unit))
    ru, rt, rv = np.asarray(r_unit)[ro], np.asarray(r_ts)[ro], np.asarray(r_usd)[ro]
    rk = (ru.astype(np.int64) << 32) | rt.astype(np.int64)
    out_u, out_t = [], []
    for u, t, v in zip(b_unit, b_ts, b_usd):
        if v < min_usd:
            continue
        lo = np.searchsorted(rk, (int(u) << 32) | int(t), side="left")
        hi = np.searchsorted(rk, (int(u) << 32) | int(t + window), side="right")
        if hi <= lo:
            continue
        cs = np.cumsum(rv[lo:hi])
        j = np.nonzero(cs * 100 >= int(fill * 100) * v)[0]
        if not len(j):
            continue
        tc = int(rt[lo + j[0]])
        if tc // 86400 > int(t) // 86400:
            out_u.append(int(u))
            out_t.append(int(t))
    o = np.lexsort((out_t, out_u))
    return np.array(out_u, np.int64)[o], np.array(out_t, np.int64)[o]


def crossing_mask(cu, ct, rows_u, T0, hsec):
    """Rows whose window (t0, t0 + h] holds a crossing borrow of their unit."""
    k = (cu.astype(np.int64) << 32) | ct.astype(np.int64)
    u = np.asarray(rows_u, np.int64)
    lo = np.searchsorted(k, (u << 32) | np.asarray(T0, np.int64), side="right")
    hi = np.searchsorted(k, (u << 32) | (np.asarray(T0, np.int64) + hsec), side="right")
    return hi > lo


def debt_crossings(datasets_dir, ctx, addrs):
    bor, rep, _ = E5.load_debt_frames(datasets_dir, os.path.join(datasets_dir, B6.DEBT_DIR))
    T = np.asarray(ctx.T, dtype=np.int64)
    prices, dec, _, _ = E5.load_prices(os.path.join(datasets_dir, B6.DEBT_DIR), T, ctx.days)
    aarr = np.array(addrs)

    def usd(df, var_only):
        ui = np.minimum(np.searchsorted(aarr, df["who"].to_numpy()), len(aarr) - 1)
        m = (aarr[ui] == df["who"].to_numpy()) & (df["ts"].to_numpy() > int(T[0]))
        if var_only:
            m &= df["mode"].to_numpy() == E5.VARIABLE_MODE
        sub = df[m]
        pday = np.minimum(np.searchsorted(T, sub["ts"].to_numpy(), side="right") - 1, len(T) - 1)
        v = np.array([E5.usd_micro(a, prices[r][d], dec[r]) for r, a, d in
                      zip(sub["reserve"].to_numpy(), sub["amount_raw"].to_numpy(), pday)], dtype=np.int64)
        return ui[m], sub["ts"].to_numpy(np.int64), v
    bu, bt, bv = usd(bor, True)
    ru, rt, rv = usd(rep, False)
    cu, ct = find_crossings(bu, bt, bv, ru, rt, rv)
    return cu, ct


# ---------------------------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------------------------
def score_b6c(ctx, C, PR, common, extra_keeps, log=print):
    """B6 score_b6 on the common rows with the extra rung 'b6'. extra_keeps: {name: (n, NC) bool} restrictions
    reported on pooled sets."""
    fold_names = [f[0] for f in ctx.folds]
    test = (C["fold"] >= 0) & C["feat_ok"]
    rng = np.random.default_rng(SEED_B6)
    cells, pooled = {}, {}
    for ci, s in E5.set_order_x():
        c = G.CELLS[ci]
        hi = c["hi"]
        m = test & C["RES"][:, hi] & common[:, hi]
        if s is not None:
            m &= C["seg"] == s
        idx = np.nonzero(m)[0]
        dd = np.unique(C["t"][idx])
        nd = len(dd)
        cb = B.replicate_counts(B.block_bootstrap_indices(rng, nd, G.BLOCK_DAYS, G.N_BOOT), nd) \
            if nd >= G.BLOCK_DAYS else None
        Q = {"y": C["Y"][idx, ci].astype(float), "t": C["t"][idx], "unit": C["unit"][idx],
             "reserve": np.zeros(len(idx), np.int8), "fold": C["fold"][idx]}
        pr = {k: PR[k][idx, ci] for k in ("v4ac", "v4ae", "b4", "own", "pop", "b6")}
        if any(np.isnan(v).any() for v in pr.values()):
            raise SystemExit(f"STOP: missing prediction in {c['id']} segment {s}")
        Sx, pos = F.score_set(Q, pr, dd, cb, fold_names, ["USDC"], rungs=SCORE_RUNGS, comps=COMP_C)
        stress = F.stress_overlap(C["T0"][idx], G.HSEC[hi])
        cbk = C["CAPOLD"][idx, ci]
        Sx["no_stress"] = F.restricted(pos, nd, pr, Q["y"], ~stress, cb, comps=COMP_C, rungs=SCORE_RUNGS)
        Sx["not_cash_blocked"] = F.restricted(pos, nd, pr, Q["y"], ~cbk, cb, comps=COMP_C, rungs=SCORE_RUNGS)
        Sx["cash_blocked"] = {"rows": int(cbk.sum()), "exits": int(Q["y"][cbk].sum()),
                              "R": {r: G.ratio_R(pr[r][cbk].sum(), Q["y"][cbk].sum()) for r in SCORE_RUNGS}}
        Sx["stress_only"] = {"rows": int(stress.sum()), "exits": int(Q["y"][stress].sum()),
                             "R_capture": {r: G.ratio_R(pr[r][stress].sum(), Q["y"][stress].sum())
                                           for r in SCORE_RUNGS}}
        fl = {k: bool(Sx["bss"][k]["ci_above_0"]) for k in B6.FLAG_KEYS}
        Sx["flags"] = fl
        Sx["preferred"] = B6.preferred_rung(fl)
        Sx["label"] = Sx["g7"][Sx["preferred"]]["label"]
        if s is None:
            for name, K in extra_keeps.items():
                keep = K[idx, ci]
                Sx[name] = F.restricted(pos, nd, pr, Q["y"], keep, cb, comps=COMP_C, rungs=SCORE_RUNGS)
            pooled[c["id"]] = Sx
            continue
        cells.setdefault(c["id"], {})[S.SEG_IDS[s]] = Sx
        log(f"  {c['id']} {S.SEG_IDS[s]}: rows {Sx['n']['rows']} -> {Sx['preferred']} {Sx['label']}")
    return cells, pooled


def pass_verdict(pooled):
    out, ok = {}, True
    for hi, h in enumerate(G.HNAMES):
        for xi in range(G.NX):
            cid = G.CELLS[int(G.XCELL[hi, xi])]["id"]
            b = pooled[cid]["bss"]["v4ac_vs_b6"]
            lo = b["ci95"][0] if b.get("ci95") else None
            good = lo is not None and lo > NONINF_LO
            ok &= good
            out[cid] = {"bss": b["bss"], "ci95": b.get("ci95"), "pass": good}
    by_h = {h: all(out[G.CELLS[int(G.XCELL[hi, xi])]["id"]]["pass"] for xi in range(G.NX))
            for hi, h in enumerate(G.HNAMES)}
    return {"rule": "BSS(v4ac B6c vs v4ac B6) 95% CI lower bound > -0.002 in every pooled (h, x) cell",
            "cells": out, "by_horizon": by_h, "PASS": bool(ok)}


def flip_budgets(C, L, common, day_ts, drain_unit, role_of_unit):
    """(e) label flips per target on common rows x x cells."""
    test = (C["fold"] >= 0) & C["feat_ok"]
    cut1, cut2 = day_ts(CUT_PRIMARY), day_ts(CUT_JULY)
    targets = {"y_cash (B6c)": ("Y", "ycash"), "y_old (B4)": ("YOLD", "y"), "y_econ (B5)": ("YECON", "yecon")}
    subsets = {"pre_2026-01-22 (primary)": lambda T0, u: T0 < cut1, "pre_2026-07-01": lambda T0, u: T0 < cut2,
               "all_dates_without_drain_unit": lambda T0, u: u != drain_unit, "all_dates": lambda T0, u: u >= 0}
    out = {}
    for tname, (ck, lk) in targets.items():
        rec = {}
        for sname, f in subsets.items():
            tot = flips = 0
            by_role = {}
            by_cell = {}
            for ci in G.XCELL.ravel():
                hi = G.CELLS[ci]["hi"]
                m = test & C["RES"][:, hi] & common[:, hi] & f(C["T0"], C["unit"])
                fl = m & (C[ck][:, ci] != L[lk][:, ci])
                tot += int(m.sum())
                flips += int(fl.sum())
                by_cell[G.CELLS[ci]["id"]] = int(fl.sum())
                for u in np.unique(C["unit"][fl]):
                    r = role_of_unit.get(int(u), "no-QRT unit")
                    by_role[r] = by_role.get(r, 0) + int((fl & (C["unit"] == u)).sum())
            share = flips / tot if tot else None
            rec[sname] = {"row_cells": tot, "flips": flips, "share": share,
                          "flag": bool(share is not None and share > FLIP_BUDGET), "flips_by_unit_role": by_role,
                          "flips_by_cell": by_cell}
        out[tname] = rec
    return out


def restricted_pooled(ctx, C, PR, mask_rows, rng, comps, rungs):
    """Pooled (h, x) cells on rows mask_rows (n,) & common & test & resolved, own bootstrap stream rng."""
    test = (C["fold"] >= 0) & C["feat_ok"]
    out = {}
    for hi in range(G.NH):
        for xi in range(G.NX):
            ci = int(G.XCELL[hi, xi])
            m = test & C["RES"][:, hi] & mask_rows[:, hi]
            idx = np.nonzero(m)[0]
            dd = np.unique(C["t"][idx])
            nd = len(dd)
            cb = B.replicate_counts(B.block_bootstrap_indices(rng, nd, G.BLOCK_DAYS, G.N_BOOT), nd) \
                if nd >= G.BLOCK_DAYS else None
            y = C["Y"][idx, ci].astype(float)
            pos = np.searchsorted(dd, C["t"][idx])
            need = set(rungs) | {a for _, a, _ in comps} | {b for _, _, b in comps}
            pr = {k: PR[k][idx, ci] for k in need}
            out[G.CELLS[ci]["id"]] = F.restricted(pos, nd, pr, y, np.ones(len(idx), bool), cb, comps=comps,
                                                  rungs=rungs)
    return out


def model_change(pooled_pre):
    out = {}
    for cid, v in pooled_pre.items():
        b = v["bss"]["v4ac_vs_b6"]["bss"]
        r1, r0 = v["R"]["v4ac"], v["R"]["b6"]
        fin = r1 is not None and r0 is not None and all(math.isfinite(v) and v > 0 for v in (r1, r0))
        dl = math.log(r1 / r0) if fin else None
        out[cid] = {"dBSS": b, "dlnR": dl, "R_b6c": r1, "R_b6": r0,
                    "flag": bool((b is not None and abs(b) > MODEL_DBSS) or (dl is not None and abs(dl) > MODEL_DLNR))}
    return {"cells": out, "n_flagged": sum(int(v["flag"]) for v in out.values())}


def exits_vs_b6(C, L, common, drain_unit):
    """Exits added / dropped by corrected y_cash vs B6 y_cash, by segment, with / without the drain-role unit and
    the 2026-04-18..25 window (summed over x cells; per horizon)."""
    test = (C["fold"] >= 0) & C["feat_ok"]
    out = {}
    for hi, h in enumerate(G.HNAMES):
        st = F.stress_overlap(C["T0"], G.HSEC[hi])
        rec = {}
        for sname, keep in (("all", np.ones(len(C["t"]), bool)), ("without_drain_unit", C["unit"] != drain_unit),
                            ("without_2026-04-18..25", ~st),
                            ("without_both", (C["unit"] != drain_unit) & ~st)):
            seg = {}
            for s in range(S.NSEG):
                m = test & C["RES"][:, hi] & common[:, hi] & keep & (C["seg"] == s)
                a = d = e6 = ec = 0
                for ci in G.XCELL[hi]:
                    y1, y0 = C["Y"][m, ci] == 1, L["ycash"][m, ci] == 1
                    a += int((y1 & ~y0).sum())
                    d += int((y0 & ~y1).sum())
                    e6 += int(y0.sum())
                    ec += int(y1.sum())
                seg[S.SEG_IDS[s]] = {"exits_b6": e6, "exits_b6c": ec, "added": a, "dropped": d}
            rec[sname] = seg
        out[h] = rec
    return out


def r_by_period(C, PR, common, day_ts, drain_unit):
    """R per rung, pooled cells, without the drain-role unit, by period (R8 D12 correction 5 follow-up)."""
    test = (C["fold"] >= 0) & C["feat_ok"]
    c1, c2 = day_ts(CUT_PRIMARY), day_ts(DRAIN_R_FROM)
    per = {"before_2026-01-22": (C["T0"] < c1), "2026-01-22_to_07-08": (C["T0"] >= c1) & (C["T0"] < c2),
           "from_2026-07-09": C["T0"] >= c2}
    out = {}
    for ci in G.XCELL.ravel():
        hi = G.CELLS[ci]["hi"]
        rec = {}
        for pn, pm in per.items():
            m = test & C["RES"][:, hi] & common[:, hi] & pm & (C["unit"] != drain_unit)
            y = C["Y"][m, ci]
            rec[pn] = {"rows": int(m.sum()), "exits": int(y.sum()),
                       "R": {r: G.ratio_R(PR[r][m, ci].sum(), y.sum()) for r in SCORE_RUNGS}}
        out[G.CELLS[ci]["id"]] = rec
    return out


def only_rows_report(C, PR, common):
    test = (C["fold"] >= 0) & C["feat_ok"]
    out = {}
    for ci in G.XCELL.ravel():
        hi = G.CELLS[ci]["hi"]
        m = test & C["RES"][:, hi] & ~common[:, hi]
        y = C["Y"][m, ci]
        out[G.CELLS[ci]["id"]] = {"rows": int(m.sum()), "exits": int(y.sum()),
                                  "R_v4ac": G.ratio_R(PR["v4ac"][m, ci].sum(), y.sum())}
    return out


# ---------------------------------------------------------------------------------------------
# Outputs
# ---------------------------------------------------------------------------------------------
def guard_no_address(path):
    import gzip
    op = gzip.open if path.endswith(".gz") else open
    with op(path, "rt") as f:
        for line in f:
            if ADDR_RE.search(line):
                raise SystemExit(f"STOP: {path} holds a 0x+40-hex string")


def write_predictions_b6c(out_dir, ctx, C, PR, common, xmask, max_bytes=45_000_000):
    import pandas as pd
    test = (C["fold"] >= 0) & C["feat_ok"]
    fold_names = np.array([f[0] for f in ctx.folds])
    days = np.array(ctx.days)
    written = []
    for hi, h in enumerate(G.HNAMES):
        cis = [int(c) for c in G.XCELL[hi]]
        m = np.nonzero(test & C["RES"][:, hi])[0]
        m = m[np.lexsort((C["t"][m], C["unit"][m]))]
        cols = {"unit": C["unit"][m], "date": days[C["t"][m]], "fold": fold_names[C["fold"][m]],
                "segment": np.array(S.SEG_IDS)[C["seg"][m]],
                "stress": F.stress_overlap(C["T0"][m], G.HSEC[hi]).astype(np.int8),
                "in_b6": common[m, hi].astype(np.int8)}
        for c in cis:
            cid = G.CELLS[c]["id"]
            cols[f"cash_blocked_{cid}"] = C["CAPOLD"][m, c].astype(np.int8)
            cols[f"debt_cross_{cid}"] = xmask[m, c].astype(np.int8)
            cols[f"y_{cid}"] = C["YOLD"][m, c]
            cols[f"yecon_{cid}"] = C["YECON"][m, c]
            cols[f"ycash_{cid}"] = C["Y"][m, c]
        for k in ("v4ac", "own", "pop", "b6", "b4", "v4ae"):
            for c in cis:
                cols[f"{k}_{G.CELLS[c]['id']}"] = PR[k][m, c]
        p = os.path.join(out_dir, f"predictions-b6c-{h}-USDC.csv.gz")
        pd.DataFrame(cols).to_csv(p, index=False, float_format="%.6g",
                                  compression={"method": "gzip", "compresslevel": 9})
        if os.path.getsize(p) > max_bytes:
            raise SystemExit(f"STOP: {p} > {max_bytes} bytes")
        written.append(p)
    return written


def build_asof_record(ctx, C, afC, units):
    th = {G.CELLS[f["ci"]]["id"]: {"theta_v4ac": [round(v, 10) for v in f["panel"]["theta_v4a"]],
                                   "theta_v2_baseline": [round(v, 10) for v in f["panel"]["theta_v2"]]}
          for f in afC}
    hist = {}
    last = int(C["t"].max())
    for xi, x in enumerate(G.SIZES):
        ci = int(G.XCELL[2, xi])
        m = C["RES"][:, 2] & (C["Y"][:, ci] == 1) & (C["t"] >= last - int(B6.DEC_LIVE))
        d = {}
        for u, t in zip(C["unit"][m], C["t"][m]):
            d.setdefault(int(u), []).append(ctx.days[int(t)])
        hist[f"x{x}"] = {str(u): v for u, v in sorted(d.items())}
    return {"asof_ts": S.LIVE_ASOF_TS, "asof_block": S.LIVE_ASOF_BLOCK,
            "units": "integer index into the sorted USDC extended universe (depositor-events/extended-universe.csv)",
            "n_units": int(len(units)),
            "params": {G.CELLS[f["ci"]]["id"]: {k: f[k] for k in ("v2", "v4a")} for f in afC},
            "theta": th, "cash_exit_origin_days_24h": hist,
            "note": "no address is stored; QRT-neutralised y_cash (R9.1(b)), W24 pool features (R9.1(a))"}


# ---------------------------------------------------------------------------------------------
# Run (once)
# ---------------------------------------------------------------------------------------------
def phase_run(datasets_dir, out_dir, workers=3, log=print, allow_dirty=False):
    rp = os.path.join(out_dir, "results-b6c.json")
    if os.path.exists(rp):
        raise SystemExit(f"STOP: {rp} exists; the B6c run happens once and never overwrites.")
    meta = code_meta()
    if meta["tree_dirty"] and not allow_dirty:
        raise SystemExit("STOP: uncommitted changes in b6c_cash.py or its imports; commit before the run.")
    t_start = time.time()
    os.makedirs(out_dir, exist_ok=True)
    shas = F.verify_inputs(datasets_dir, holdouts=False)
    shas.update(verify_b6_run(datasets_dir))
    legs, w24, r9s = load_r9(datasets_dir)
    shas.update(r9s)
    # --- G0: plumbing reproduction of the published B6 labels (no neutralisation, snapshot pool state)
    log("G0: B6 label reproduction ...")
    ctx, res = G.load_main(datasets_dir, log)
    C0, _, _ = build_c(datasets_dir, ctx, res, None, log)
    has0, _, L0, miss0 = load_b6_predictions(datasets_dir, ctx, C0)
    g0 = g0_reproduction(C0, has0, L0)
    g0["b6_rows_unmatched"] = miss0
    log(f"  G0: {g0}")
    if not g0["all_equal"]:
        raise SystemExit("STOP: G0 failed; this code does not reproduce the B6 labels. Nothing corrected or scored.")
    del C0, has0, L0
    # --- corrected inputs
    R = res[0]
    qrts, role_unit = map_legs(datasets_dir, legs, R.addrs)
    if "drain-role" not in role_unit or role_unit["drain-role"] < 0:
        raise SystemExit("STOP: the drain-role unit is not in the USDC universe")
    drain_unit = role_unit["drain-role"]
    role_of_unit = {u: r for r, u in role_unit.items() if u >= 0}
    info = {"qrts": len(qrts), "qrts_outside_universe": sum(int(q["unit"] < 0) for q in qrts),
            "qrt_roles_in_universe": sorted(role_of_unit.values())}
    info["pool"] = patch_pool(ctx, R, w24)
    info["neutralisation"] = patch_usdc(ctx, R, qrts)
    log(f"  corrected inputs: {info}")
    log("corrected rows and labels ...")
    C, linfo, dshas = build_c(datasets_dir, ctx, res, qrts, log)
    info.update(linfo)
    shas.update(dshas)
    has, PRb6, L, miss = load_b6_predictions(datasets_dir, ctx, C)
    info["b6_rows_not_in_b6c"] = miss
    n = len(C["t"])
    test = (C["fold"] >= 0) & C["feat_ok"]
    common = has & test[:, None] & C["RES"]
    # --- D3 debt crossings
    log("debt-side crossings ...")
    cu, ct = debt_crossings(datasets_dir, ctx, R.addrs)
    xmask = np.zeros((n, G.NC), bool)
    for ci in G.XCELL.ravel():
        xmask[:, ci] = crossing_mask(cu, ct, C["unit"], C["T0"], G.HSEC[G.CELLS[ci]["hi"]])
    dcross = {"borrows": int(len(cu)), "units": int(len(np.unique(cu))),
              "by_year": {str(y): int(v) for y, v in zip(*np.unique(
                  [int(G.ts_date(int(t))[:4]) for t in ct], return_counts=True))} if len(ct) else {},
              "row_cells_common": int(sum((xmask[:, ci] & common[:, G.CELLS[ci]["hi"]]).sum()
                                          for ci in G.XCELL.ravel())),
              "row_cells_common_with_ycash_1": int(sum((xmask[:, ci] & common[:, G.CELLS[ci]["hi"]]
                                                        & (C["Y"][:, ci] == 1)).sum() for ci in G.XCELL.ravel())),
              "row_cells_by_cell": {G.CELLS[ci]["id"]: int((xmask[:, ci] & common[:, G.CELLS[ci]["hi"]]).sum())
                                    for ci in G.XCELL.ravel()}}
    log(f"  debt crossings: {dcross['borrows']} borrows, {dcross['row_cells_common']} row x cells")
    # --- v4ac fits (one per fold x cell, + asof)
    xc = [int(c) for c in G.XCELL.ravel()]
    usdc_units = np.arange(len(R.addrs), dtype=np.int64)
    tasks = [("fold", fi, ci) for fi in range(len(ctx.folds)) for ci in xc] + [("asof", -1, ci) for ci in xc]
    log(f"v4ac fits (corrected y_cash): {len(tasks)} tasks ...")
    fitsC, testC = F.run_fits(ctx, C, tasks, usdc_units, S.LIVE_ASOF_TS, workers=workers, log=log)
    ffC = [f for f in fitsC if f["kind"] == "fold"]
    afC = sorted([f for f in fitsC if f["kind"] == "asof"], key=lambda f: f["ci"])
    PRC, fpC, finfoC, _ = F.assemble(C, ffC, testC)
    PR = {"v4ac": E5.fix_nomask(PRC["v4a"]), "own": PRC["own"], "pop": PRC["pop"], **PRb6}
    log("scoring ...")
    keeps = {"without_debt_crossings": ~xmask, "without_drain_unit": np.repeat((C["unit"] != drain_unit)[:, None],
                                                                               G.NC, axis=1)}
    cells, pooled = score_b6c(ctx, C, PR, common, keeps, log)
    verdict = pass_verdict(pooled)
    log(f"  PASS = {verdict['PASS']}")
    day_ts = B.day_ts
    budgets = flip_budgets(C, L, common, day_ts, drain_unit, role_of_unit)
    rng_pre = np.random.default_rng(SEED_Q3 + 1)
    pre = {}
    for name, cut in (("pre_2026-01-22 (primary)", CUT_PRIMARY), ("pre_2026-07-01", CUT_JULY)):
        mrows = common & (C["T0"] < day_ts(cut))[:, None]
        pre[name] = model_change(restricted_pooled(ctx, C, PR, mrows, rng_pre, COMP_C, SCORE_RUNGS))
    fold_names = [f[0] for f in ctx.folds]
    fq3 = fold_names.index("2026Q3")
    rng3 = np.random.default_rng(SEED_Q3)
    q3 = {"with_drain_unit": restricted_pooled(ctx, C, PR, common & (C["fold"] == fq3)[:, None], rng3, COMP_Q3,
                                               SCORE_RUNGS),
          "without_drain_unit": restricted_pooled(ctx, C, PR, common & ((C["fold"] == fq3) & (C["unit"] != drain_unit))[
              :, None], rng3, COMP_Q3, SCORE_RUNGS)}
    exv = exits_vs_b6(C, L, common, drain_unit)
    rper = r_by_period(C, PR, common, day_ts, drain_unit)
    only = only_rows_report(C, PR, common)
    counts_test = B6.exit_counts_b6(C, test)
    lab = []
    for ci in xc:
        cid = G.CELLS[ci]["id"]
        for s in S.SEG_IDS:
            Sx = cells[cid][s]
            b = Sx["bss"]
            lab.append([cid, s, Sx["preferred"], Sx["label"], Sx["n"]["rows"], Sx["n"]["n_ep"],
                        Sx["g7"]["v4ac"]["R"], Sx["g7"]["b6"]["R"], Sx["g7"]["v4ae"]["R"], Sx["g7"]["b4"]["R"],
                        b["v4ac_vs_b6"]["bss"], b["v4ac_vs_b4"]["bss"], b["v4ac_vs_v4ae"]["bss"],
                        b["v4ac_vs_pop"]["bss"], Sx["g7"]["v4ac"]["label"], Sx["g7"]["v4ae"]["label"],
                        Sx["g7"]["b4"]["label"]])
    G.write_csv(os.path.join(out_dir, "labels-b6c.csv"),
                ["cell", "segment", "preferred", "label", "rows", "n_ep", "R_v4ac", "R_b6", "R_v4ae", "R_b4",
                 "bss_v4ac_vs_b6", "bss_v4ac_vs_b4", "bss_v4ac_vs_v4ae", "bss_v4ac_vs_pop", "label_v4ac",
                 "label_v4ae", "label_b4"], lab)
    pred = write_predictions_b6c(out_dir, ctx, C, PR, common, xmask)
    prefc = {s: G._count([cells[G.CELLS[ci]["id"]][s]["preferred"] for ci in xc]) for s in S.SEG_IDS}
    pref_total = G._count([cells[G.CELLS[ci]["id"]][s]["preferred"] for ci in xc for s in S.SEG_IDS])
    summary = {
        "phase": "run (development; one fit per fold x cell; live log is the blind test)", "prereg": PREREG,
        "inputs_sha256": shas, "code": meta, "decisions": DECISIONS, "info": info, "g0_reproduction": g0,
        "pass_verdict": verdict, "budgets_e": {"label_flips": budgets, "model_change_outside_drain": pre},
        "debt_crossings_d3": dcross, "q3_2026_fold": q3, "exits_vs_b6": exv, "R_by_period_without_drain_unit": rper,
        "b6c_only_rows": only, "exit_counts_test": counts_test, "exit_counts_test_total": B6.sum_counts_b6(counts_test),
        "cells": cells, "pooled": pooled, "preferred_counts": prefc, "preferred_total": pref_total,
        "fold_params": fpC, "fold_fits": finfoC,
        "asof_params": {G.CELLS[f["ci"]]["id"]: {k: f[k] for k in ("v2", "v4a")} for f in afC},
        "prediction_files": [os.path.basename(p) for p in pred],
        "single_class_fits": sum(int(f["v4a"]["info"]["single_class"]) for f in fitsC),
        "convergence_warnings": sum(int(f["v4a"]["info"].get("n_convergence_warnings", 0)) for f in fitsC),
        "runtime_s": time.time() - t_start,
        "finished_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    B.write_json(rp, summary, refuse_overwrite=True)
    B.write_json(os.path.join(out_dir, "asof-fits-b6c.json"), build_asof_record(ctx, C, afC, usdc_units),
                 refuse_overwrite=True)
    for fn in os.listdir(out_dir):
        guard_no_address(os.path.join(out_dir, fn))
    log(f"run: {rp} ({summary['runtime_s']:.0f} s)")
    return summary


def phase_freeze(out_dir, log=print):
    rp = os.path.join(out_dir, "results-b6c.json")
    ap = os.path.join(out_dir, "asof-fits-b6c.json")
    fp = os.path.join(out_dir, "frozen-b6c.json")
    fr = os.path.join(out_dir, "freeze-record.json")
    if not os.path.exists(rp):
        raise SystemExit("STOP: no results-b6c.json.")
    if os.path.exists(fp) or os.path.exists(fr):
        raise SystemExit("STOP: the freeze exists; it is written once.")
    r = json.load(open(rp))
    a = json.load(open(ap))
    cells = {cid: {s: {"preferred": v["preferred"], "label": v["label"], "flags": v["flags"],
                       "labels_by_rung": {k: v["g7"][k]["label"] for k in SCORE_RUNGS},
                       "dev_R_by_rung": {k: v["g7"][k]["R"] for k in SCORE_RUNGS}, "dev_n_ep": v["n"]["n_ep"]}
                   for s, v in sv.items()} for cid, sv in r["cells"].items()}
    frozen = {"prereg": PREREG, "results_b6c_sha256": B.sha256_file(rp), "asof_fits_b6c_sha256": B.sha256_file(ap),
              "pass_verdict": r["pass_verdict"]["PASS"], "cells": cells, "fold_params": r["fold_params"], "asof": a,
              "folds": [f for f in B.fold_list()], "decisions": DECISIONS,
              "frozen_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "code": code_meta()}
    B.write_json(fp, frozen, refuse_overwrite=True)
    rec = {"frozen_b6c_sha256": B.sha256_file(fp), "results_b6c_sha256": frozen["results_b6c_sha256"],
           "asof_fits_b6c_sha256": frozen["asof_fits_b6c_sha256"], "frozen_utc": frozen["frozen_utc"]}
    B.write_json(fr, rec, refuse_overwrite=True)
    guard_no_address(fp)
    log(f"freeze: frozen-b6c.json sha256 {rec['frozen_b6c_sha256']}")
    return rec


def phase_manifest(out_dir, log=print):
    files = {}
    for n in sorted(os.listdir(out_dir)):
        p = os.path.join(out_dir, n)
        if os.path.isfile(p) and n != "manifest.json":
            files[n] = {"bytes": os.path.getsize(p), "sha256": B.sha256_file(p)}
    B.write_json(os.path.join(out_dir, "manifest.json"), {"files": files, "code": code_meta()})
    log(f"manifest: {len(files)} files")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--phase", required=True, choices=["run", "freeze", "manifest"])
    ap.add_argument("--datasets", default=os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                       "..", "..", "..", "..", "membrane-datasets"))
    ap.add_argument("--out", required=True)
    ap.add_argument("--workers", type=int, default=3)
    a = ap.parse_args(argv)
    ds = os.path.abspath(a.datasets)
    if a.phase == "run":
        return phase_run(ds, a.out, workers=a.workers)
    if a.phase == "freeze":
        return phase_freeze(a.out)
    return phase_manifest(a.out)


if __name__ == "__main__":
    main()
