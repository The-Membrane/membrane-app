#!/usr/bin/env python3
"""Q26 R10.4-B: blind historical confirmation of R10.4 step 1 (24 h daily-minimum pool cash) on blind set C2,
Aave V3 Ethereum Core PYUSD, USDS and RLUSD.

membrane-board design/Q26_ROUND10_PREREG.md D-R10.4-Ba (readings, fixed before any outcome), mapping
design/Q26_ROUND11_PREREG.md D-R11.9a (addendum: C2 is the blind step of R10.4 step 1), inventory
design/q26-blind-set-inventory-2026-10-17.md set C2. Process: R11 binding rules 1-10 and D-R11.3e rule 2.

Frozen R10.4 code (membrane-app 7b6ca7aa, r104_cash.py, unchanged) is imported and applied per market:
window_min, state_at, qrt_outstanding, detect_drt, drt_outstanding, make_flows, run_variant (har_fit,
forecast_origin, path_minima). Only market identifiers and decimals change (amounts in 1e-6-token units, so every
frozen USD threshold keeps its value at $1 per token). The R9.1(b) QRT detector (r9_correct.run_qrt, unchanged)
supplies the aToken round trips per market. Step 1 only: the carry-spread driver is excluded.

Comparators: the empirical baseline (trailing-730-day linear quantiles of min-cash / cash(t0) applied to cash(t0),
D-R10.4c; r115_depositor_cash.emp_baseline, unchanged) is primary; no-change (R10.4) is secondary.
Tests: one-sided DM with Newey-West lag 7 and the HLN factor (r115_depositor_cash.dm_hln, unchanged). Per market
alpha 0.025/3; pooled (headline) on supply-scaled loss differences summed per date over markets (market-clustered,
Driscoll-Kraay form), alpha 0.025.

Phases:
  --inputs-only   load and gate inputs, print counts only (no forecast, no outcome, no score), stop
  --freeze-only   write frozen-r104b.json (code, input sha256, readings, constants, created_utc), hash it, stop
  (default)       ONE run from the frozen config (refuses if code, inputs or readings differ, or if a run started)
No address is held in any output (units are salted hashes in memory only; every output is checked).
"""
import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import gzip  # noqa: E402
import hashlib  # noqa: E402
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
import r115_depositor_cash as R5  # noqa: E402
import r9_correct as R9  # noqa: E402

PREREG = {"repo": "triccs/membrane-board", "path": "design/Q26_ROUND10_PREREG.md", "item": "R10.4-B (blind set C2)",
          "readings": "D-R10.4-Ba", "mapping": "design/Q26_ROUND11_PREREG.md D-R11.9a"}
SCHEMA = "q26-r10/r104b-c2/1"
R104_SHA = "7b6ca7aa"
MICRO = 10 ** 6
RAY = 10 ** 27
DAY = 86400
QS = (0.05, 0.25, 0.50)
H24 = 1
END_BLOCK = 26186746
END_TS = 1791932759                       # block 26186746 timestamp, 2026-10-13T23:05:59Z (depositor-blind5 asof)
LAST_ORIGIN = "2026-10-07"                # last daily reserve-state snapshot (supply endpoint)
WARMUP_DAYS = 180
Q2 = ("2026-04-01", "2026-07-01")
ALPHA_POOLED = 0.025
ALPHA_MARKET = 0.025 / 3
NC_SKILL_MIN = 0.10                        # the R10.4 step-1 rule, secondary condition
ADDR_RE = re.compile(r"0x[0-9a-fA-F]{40}")

# market -> (blind5 dir, reserve label, file stem, underlying (Core Pool reserve key), decimals, aToken deploy block)
MARKETS = {
    "PYUSD": ("Core_PYUSD", "core_pyusd", "0x6c3ea9036406852006290770bedfcaba0e23a0e8", 6, 19211968),
    "USDS": ("Core_USDS", "core_usds", "0xdc035d45d973e3ec169d2276ddab16f1e407384f", 18, 20879386),
    "RLUSD": ("Core_RLUSD", "core_rlusd", "0x8292bb45bf1ee4d140127049757c2e0ff06317ed", 18, 22319334),
}
C2_DIR = "aave-pool-cash-c2"
B5_DIR = "depositor-blind5"

DECISIONS = [
    "B-1 Frozen code: r104_cash.py at membrane-app 7b6ca7aa, imported unchanged (sha256 checked against the R10.4 "
    "freeze). Per market it rebuilds the R10.4 series: raw cash path (R104-1), endpoints (R104-2), round trips in "
    "the flow history only (R104-3, R104-4 t0 + 60 min live rule), dip (R104-5), HAR (R104-6), deterministic joint "
    "blocks from the trailing 730 days (R104-7). Step 1 only; the carry-spread driver (step 2) is excluded and not "
    "computed. 7 d is not run (D-R10.4c: nothing relies on R10.4 7 d skill).",
    "B-2 Units: every amount is converted to 1e-6-token units (PYUSD 6 decimals: unchanged; USDS, RLUSD 18 "
    "decimals: divided by 1e12). Cash states are floored after the exact integer sum, never per transfer. Each "
    "token counts $1 (B5-1 oracle check [0.98, 1.02]), so every frozen USD constant (DRT $20M, QRT $10M, 0.5%) is "
    "applied unchanged.",
    "B-3 Truth: raw cash = underlying Transfers into minus out of the aToken from its deployment block (offset 0, "
    "R9 V1 / R104-1), per transaction (block, tx_index), from aave-pool-cash-c2. Window minimum over (t0, t0 + 24 h] "
    "by R4.window_min. Data end = block 26186746 (2026-10-13T23:05:59Z) for every market.",
    "B-4 Endpoints (market reading): day i's endpoint is the state after every transaction with ts < t_i. Supply = "
    "depositor-blind5 reserve-state.csv totalSupply at the daily snapshot (archive read at the last block before "
    "00:00Z; R10.4 used the R9 scaledSupply x normalizedIncome reconstruction, which R9 V1 matched to reserve-state "
    "totalSupply within 1e-4). Cash endpoint = the rebuilt Transfer path. Gate G1 per market: the rebuilt cash "
    "equals reserve-state cash exactly (raw units) at every series day, else the run stops. D := S - cash.",
    "B-5 Series and origins per market: daily days from the first snapshot after the aToken deployment block to "
    "2026-10-07 (the last daily snapshot; later origins have no supply endpoint and are not forecast). No ramp days "
    "are trimmed (R10.4's series also began days after aUSDC deployment). Scoring origins: 00:00Z from series start "
    "+ 180 days to 2026-10-07 with t0 + 24 h <= data end; origins whose window meets [2026-04-01, 2026-07-01) are "
    "reported only (rule 6). An origin scores only when the model, the empirical baseline and no-change all exist "
    "and the truth is finite (paired); missing forecasts are counted.",
    "B-6 aToken round trips per market (market reading): the R9.1(b) detector r9_correct.run_qrt unchanged on the "
    "market's depositor-blind5 Mint/Burn/BalanceTransfer events (party1 = onBehalfOf / owner, salted hash in "
    "memory), thresholds w >= $10M and w >= 0.5% of supply at the end of the previous transaction, 2 h window, 95% "
    "fill. Supply for that threshold = event-reconstructed scaled supply (sum of rayDiv(delta1, event index)) x the "
    "latest Mint/Burn index at or before the transaction (R9 used the RDU normalizedIncome; the difference is "
    "interest since the last event). Legs enter R4.qrt_outstanding compared by ts (R104-2).",
    "B-7 Debt-side round trips per market: R104-3(b) by R4.detect_drt unchanged on the Core Pool Borrow and Repay "
    "logs of the R10.4 file list (aave-pool-borrows 2023-2026, aave-pool-debt repays 2023-2026) filtered to the "
    "market's underlying, Repay useATokens = 0; >= $20M, 2 h, 95%.",
    "B-8 Comparators: primary = empirical baseline, r115_depositor_cash.emp_baseline unchanged: ratio_i = raw "
    "minimum over (t_i, t_i + 24 h] / raw cash(t_i), i in [t0 - 730 d, t0 - 1 d], linear quantiles x raw cash(t0); "
    "secondary = no-change (every quantile = raw minimum over (t0 - 24 h, t0]).",
    "B-9 Loss: per origin the mean pinball over q05, q25, q50 in USD.",
    "B-10 Per-market PASS iff (i) one-sided DM (r115 dm_hln: Newey-West Bartlett lag 7, HLN h = 8, Student t T - 1 "
    "df) on d = L_model - L_empirical in date order gives p < 0.025/3 (Bonferroni over 3 markets) and (ii) skill "
    "vs no-change 1 - mean L_model / mean L_nochange >= 10% (the R10.4 step-1 rule).",
    "B-11 Pooled PASS (headline) iff (i) the market-clustered DM on supply-scaled differences gives p < 0.025: "
    "e = (L_model - L_empirical) / S(t0) per market-origin (S = reserve-state totalSupply at the t0 anchor, known at "
    "t0); D_t = sum over markets scoring on date t; dm_hln on the date-ordered D_t (Driscoll-Kraay form: robust to "
    "any same-date cross-market correlation and to serial correlation up to lag 7); and (ii) pooled supply-scaled "
    "skill vs no-change 1 - sum(L_model/S) / sum(L_nochange/S) >= 10%. Pooled skill vs empirical = 1 - "
    "sum(L_model/S) / sum(L_empirical/S).",
    "B-12 Reported only, deciding nothing: per-quantile pinball and hit rates per comparator, skill by year, USD "
    "skill vs empirical per market, supply-scaled skill per market, DM vs no-change, effective N (T x var / "
    "Newey-West long-run variance of d), the within-market-only pooled variance variant, a step-1 sensitivity with "
    "raw endpoints, round-trip counts, 2026Q2 origins.",
    "B-14 (D-R10.4-Bb, after the first run stopped before any score) Undefined flow days: a supply or debt "
    "log-change or dip that is not finite (debt is exactly 0 on the first 1-2 series days of each market, before "
    "borrowing starts, so log(D1/D0) is infinite) is set to NaN before the frozen code runs. The frozen HAR and "
    "block code already treat NaN as a missing day; an infinite value instead poisons every later HAR component. "
    "Equivalent to starting the flow history at the first day with positive debt. Scoring origins are unchanged.",
    "B-13 Order: inputs-only counts, then frozen-r104b.json (code sha, input sha256, readings, constants, "
    "created_utc) written, hashed and committed to membrane-datasets before any forecast; one run from a clean "
    "detached worktree at the frozen sha; the run refuses if anything differs or a run already started; the run log "
    "records UTC start and end. Outputs history-forecasts/r11/r104b-c2-run-<sha>/. The set is used once.",
]


# ---------------------------------------------------------------------------------------------
# pure helpers (tested)
# ---------------------------------------------------------------------------------------------
def to_micro(raw, dec):
    """exact integer raw token units -> 1e-6-token units, floored toward zero."""
    k = 10 ** (dec - 6)
    raw = int(raw)
    return raw // k if raw >= 0 else -((-raw) // k)


def cash_path(tin, tout, dec):
    """tin/tout: DataFrames (block, ts, tx_index, amount_raw str). Per tx (block, tx_index) net change; exact integer
    cumulative sum from 0, then floored to micro units. Returns DataFrame (block, ts, cash_raw (object), cash
    (int64 micro))."""
    parts = []
    for df, sign in ((tin, 1), (tout, -1)):
        parts.append(pd.DataFrame({"block": df["block"].astype(np.int64).values,
                                   "ts": df["ts"].astype(np.int64).values,
                                   "tx_index": df["tx_index"].astype(np.int64).values,
                                   "d": [sign * int(x) for x in df["amount_raw"]]}))
    lg = pd.concat(parts, ignore_index=True)
    lg = lg[lg["block"] <= END_BLOCK]
    key = lg["block"].to_numpy(np.int64) * 100_000 + lg["tx_index"].to_numpy(np.int64)
    lg = lg.assign(key=key).sort_values("key", kind="mergesort")
    rows = []
    cur_key, cur_b, cur_t, acc = None, None, None, 0
    for k_, b, t, d in zip(lg["key"].values, lg["block"].values, lg["ts"].values, lg["d"].values):
        if k_ != cur_key:
            if cur_key is not None:
                rows.append((cur_b, cur_t, acc))
            cur_key, cur_b, cur_t, acc = k_, int(b), int(t), 0
        acc += int(d)
    if cur_key is not None:
        rows.append((cur_b, cur_t, acc))
    cum, c = [], 0
    for r in rows:
        c += r[2]
        cum.append(c)
    return pd.DataFrame({"block": [r[0] for r in rows], "ts": [r[1] for r in rows],
                         "cash_raw": pd.Series(cum, dtype=object),
                         "cash": np.array([to_micro(x, dec) for x in cum], dtype=np.int64)})


def supply_timeline(ev, dec):
    """ev: decoded events sorted (block, tx_index, log_index) with type, delta1_raw (raw str), index_ray. Returns the
    tl frame run_qrt needs: key (block*100000 + tx_index) and supply_raw_f (micro units, float) after each tx =
    event-reconstructed scaled supply x the latest Mint/Burn index (B-6)."""
    mb = ev[ev["type"].isin(["Mint", "Burn"]) & ev["delta1_raw"].notna() & ev["index_ray"].notna()]
    keys, sup = [], []
    scaled, last_idx = 0, None
    cur = None
    for b, tx, d, ix in zip(mb["block"].values, mb["tx_index"].values, mb["delta1_raw"].values, mb["index_ray"].values):
        k = int(b) * 100_000 + int(tx)
        d, ix = int(d), int(ix)
        s = R9.ray_div(abs(d), ix)
        scaled += s if d >= 0 else -s
        last_idx = ix
        val = scaled * last_idx / RAY / 10 ** (dec - 6)
        if k == cur:
            sup[-1] = val
        else:
            keys.append(k)
            sup.append(val)
            cur = k
    return pd.DataFrame({"key": np.array(keys, dtype=np.int64), "supply_raw_f": np.array(sup, float)})


def qrt_legs(qrts):
    """R9 QRT dicts -> legs frame (qrt_id, leg, ts, neutral_raw, block=ts) for R4.qrt_outstanding by ts."""
    rows = []
    for n, q in enumerate(sorted(qrts, key=lambda q: q["burn"]["key"])):
        qid = f"q{n + 1:05d}"
        rows.append({"qrt_id": qid, "leg": "withdraw", "ts": int(q["burn"]["ts"]), "neutral_raw": int(q["neutral"])})
        for _, take, ts, _ in q["legs"]:
            rows.append({"qrt_id": qid, "leg": "redeposit", "ts": int(ts), "neutral_raw": int(take)})
    df = pd.DataFrame(rows, columns=["qrt_id", "leg", "ts", "neutral_raw"])
    return df.assign(block=df["ts"])


def finite_flows(F):
    """B-14: non-finite log-changes and dips -> NaN (the frozen code's missing-day value)."""
    SX, CX, DX, xS, xD, dp = F
    fix = [np.where(np.isfinite(a), a, np.nan) for a in (xS, xD, dp)]
    return (SX, CX, DX, fix[0], fix[1], fix[2])


def nw_lrv(d, lag=R5.NW_LAG):
    d = np.asarray(d, float)
    T = len(d)
    e = d - d.mean()
    lrv = float(e @ e) / T
    for k in range(1, lag + 1):
        lrv += 2 * (1 - k / (lag + 1)) * float(e[k:] @ e[:-k]) / T
    return lrv


def pooled_dk(dates_by_market, e_by_market):
    """per-date sums over markets of the scaled differences, date ordered -> (dates, D_t, n per date)."""
    allp = {}
    for m in dates_by_market:
        for dt, v in zip(dates_by_market[m], e_by_market[m]):
            s, c = allp.get(dt, (0.0, 0))
            allp[dt] = (s + float(v), c + 1)
    ds = sorted(allp)
    return ds, np.array([allp[x][0] for x in ds]), np.array([allp[x][1] for x in ds])


def pass_market(p_emp, skill_nc):
    return bool(np.isfinite(p_emp) and p_emp < ALPHA_MARKET and skill_nc >= NC_SKILL_MIN)


def pass_pooled(p_dk, skill_nc_pooled):
    return bool(np.isfinite(p_dk) and p_dk < ALPHA_POOLED and skill_nc_pooled >= NC_SKILL_MIN)


# ---------------------------------------------------------------------------------------------
# inputs
# ---------------------------------------------------------------------------------------------
def code_meta():
    here = os.path.dirname(os.path.abspath(__file__))

    def git(*a):
        try:
            return subprocess.run(["git", "-C", here, *a], capture_output=True, text=True,
                                  timeout=30).stdout.strip() or None
        except Exception:
            return None
    me = os.path.basename(__file__)
    deps = ("r104_cash.py", "r115_depositor_cash.py", "r9_correct.py", "a_touch.py")
    r104_frozen = git("show", f"{R104_SHA}:scripts/research/history-forecasts/r104_cash.py")
    r104_now = open(os.path.join(here, "r104_cash.py")).read()
    return {"git_head": git("rev-parse", "HEAD"), "tree_dirty": bool(git("status", "--porcelain", "--", me, *deps)),
            "sha256": {d: R4.sha256_file(os.path.join(here, d)) for d in (me,) + deps},
            "r104_cash_equals_7b6ca7aa": bool(r104_frozen is not None and r104_frozen.strip() == r104_now.strip()),
            "python": sys.version.split()[0], "numpy": np.__version__, "pandas": pd.__version__}


def input_files(datasets):
    fs = []
    for m, (bdir, stem, _, _, _) in MARKETS.items():
        fs += [f"{C2_DIR}/raw-transfers-{stem}-in.csv.gz", f"{C2_DIR}/raw-transfers-{stem}-out.csv.gz",
               f"{B5_DIR}/{bdir}/reserve-state.csv"]
        fs += sorted(f"{B5_DIR}/{bdir}/{f}" for f in os.listdir(os.path.join(datasets, B5_DIR, bdir))
                     if f.startswith(f"events-{stem}-"))
    fs += R4.BORROWS + R4.REPAYS
    return fs


def check_provenance(datasets, shas):
    """every C2 and blind5 input must be listed with its sha256 in its directory's PROVENANCE.md."""
    provs = {d: open(os.path.join(datasets, d, "PROVENANCE.md")).read() for d in (C2_DIR, B5_DIR)}
    for rel, h in shas.items():
        d = rel.split("/")[0]
        if d in provs and h not in provs[d]:
            raise SystemExit(f"STOP: {rel} sha256 not in {d}/PROVENANCE.md")


def load_borrow_repay_all(datasets, salt):
    def h(a):
        return hashlib.sha256((salt + str(a).lower()).encode()).hexdigest()[:16]
    bs, rs = [], []
    for rel in R4.BORROWS:
        b = pd.read_csv(os.path.join(datasets, rel), usecols=["block", "ts", "log_index", "reserve", "onBehalfOf",
                                                              "amount_raw"],
                        dtype={"amount_raw": str, "reserve": str, "onBehalfOf": str})
        b["reserve"] = b["reserve"].str.lower()
        bs.append(b)
    for rel in R4.REPAYS:
        r = pd.read_csv(os.path.join(datasets, rel), usecols=["block", "ts", "log_index", "reserve", "user",
                                                              "amount_raw", "useATokens"],
                        dtype={"amount_raw": str, "reserve": str, "user": str, "useATokens": str})
        r["reserve"] = r["reserve"].str.lower()
        rs.append(r[r["useATokens"].str.lower().isin(["0", "false"])])
    B = pd.concat(bs, ignore_index=True)
    Rr = pd.concat(rs, ignore_index=True)
    out = {}
    for m, (_, _, asset, dec, _) in MARKETS.items():
        b = B[B["reserve"] == asset]
        r = Rr[Rr["reserve"] == asset]
        out[m] = (pd.DataFrame({"block": b["block"].astype(np.int64).values,
                                "log_index": b["log_index"].astype(np.int64).values,
                                "ts": b["ts"].astype(np.int64).values, "unit": [h(a) for a in b["onBehalfOf"]],
                                "amount": [to_micro(x, dec) for x in b["amount_raw"]]}),
                  pd.DataFrame({"block": r["block"].astype(np.int64).values,
                                "log_index": r["log_index"].astype(np.int64).values,
                                "ts": r["ts"].astype(np.int64).values, "unit": [h(a) for a in r["user"]],
                                "amount": [to_micro(x, dec) for x in r["amount_raw"]]}))
    return out


def load_events(datasets, bdir, stem, dec, salt):
    cols = ["block", "ts", "tx_index", "log_index", "type", "party1", "delta1_raw", "index_ray"]
    out = []
    d = os.path.join(datasets, B5_DIR, bdir)
    for f in sorted(x for x in os.listdir(d) if x.startswith(f"events-{stem}-")):
        ch = pd.read_csv(os.path.join(d, f), usecols=cols, dtype={"delta1_raw": str, "index_ray": str, "party1": str})
        ch = ch[ch["type"].isin(["Mint", "Burn", "BalanceTransfer"])].copy()
        ch["unit"] = [hashlib.sha256((salt + a.lower()).encode()).hexdigest()[:16] for a in ch["party1"]]
        ch = ch.drop(columns=["party1"])
        out.append(ch)
    ev = pd.concat(out, ignore_index=True)
    ev = ev[ev["block"] <= END_BLOCK]
    ev = ev.sort_values(["block", "tx_index", "log_index"], kind="mergesort").reset_index(drop=True)
    return ev


def load_market(datasets, m, salt, drt_inputs, say):
    bdir, stem, asset, dec, dep = MARKETS[m]
    rs = pd.read_csv(os.path.join(datasets, B5_DIR, bdir, "reserve-state.csv"), dtype=str)
    rs = rs[rs["snapshot"].str.match(r"^\d{4}-\d{2}-\d{2}$")]
    rs = rs[rs["block"].astype(np.int64) > dep]
    rs = rs[rs["snapshot"] <= LAST_ORIGIN].sort_values("snapshot").reset_index(drop=True)
    origins = rs["snapshot"].tolist()
    t = np.array([R4.day_ts(d) for d in origins], dtype=np.int64)
    if not (np.diff(t) == DAY).all():
        raise SystemExit(f"STOP: {m} snapshots not consecutive days")
    if (rs["totalSupply_status"] != "ok").any() or (rs["cash_status"] != "ok").any():
        raise SystemExit(f"STOP: {m} reserve-state status not ok")
    if not (rs["block_ts"].astype(np.int64).values < t).all():
        raise SystemExit(f"STOP: {m} snapshot block not before 00:00Z")
    anc = t - 1
    S_snap = np.array([to_micro(x, dec) for x in rs["totalSupply"]], dtype=float)
    C_snap_raw = [int(x) for x in rs["cash"]]
    tin = pd.read_csv(os.path.join(datasets, C2_DIR, f"raw-transfers-{stem}-in.csv.gz"), dtype={"amount_raw": str})
    tout = pd.read_csv(os.path.join(datasets, C2_DIR, f"raw-transfers-{stem}-out.csv.gz"), dtype={"amount_raw": str})
    tl = cash_path(tin, tout, dec)
    cts = tl["ts"].to_numpy(np.int64)
    cval = tl["cash"].to_numpy(np.int64)
    craw = tl["cash_raw"].tolist()
    k = np.searchsorted(cts, anc, side="right") - 1
    g1 = sum(1 for j in range(len(anc)) if (craw[k[j]] if k[j] >= 0 else 0) != C_snap_raw[j])
    say(m, "G1 mismatches", g1, "of", len(anc))
    if g1:
        raise SystemExit(f"STOP: G1 failed for {m}")
    C_end = np.array([cval[x] if x >= 0 else 0 for x in k], dtype=float)
    cash_t0 = np.array([R4.state_at(cts, cval, int(x)) for x in t], dtype=float)
    dmin = np.full(len(t), np.nan)
    for i, x in enumerate(t):
        if x + DAY <= END_TS:
            dmin[i] = R4.window_min(cts, cval, int(cash_t0[i]), int(x), int(x) + DAY)
    # round trips
    ev = load_events(datasets, bdir, stem, dec, salt)
    ev["delta1_raw"] = [None if not isinstance(x, str) else str(to_micro(x, dec)) for x in ev["delta1_raw"]]
    ev_raw = load_events(datasets, bdir, stem, dec, salt)          # raw deltas for the exact scaled supply
    stl = supply_timeline(ev_raw, dec)
    del ev_raw
    qrts, _ = R9.run_qrt(ev, stl)
    legs = qrt_legs(qrts)
    vis = t + R4.LOOKAHEAD_S
    Q_full = R4.qrt_outstanding(legs, anc).astype(float)
    Q_live = R4.qrt_outstanding(legs, anc, visible_by=vis).astype(float)
    bo, re_ = drt_inputs[m]
    drts = R4.detect_drt(bo, re_)
    R_full = R4.drt_outstanding(drts, anc, key="ts").astype(float)
    R_live = R4.drt_outstanding(drts, anc, visible_by=vis, key="ts").astype(float)
    # scoring sets
    q2a, q2b = R4.day_ts(Q2[0]), R4.day_ts(Q2[1])
    first = t >= t[0] + WARMUP_DAYS * DAY
    res = t + DAY <= END_TS
    inq2 = (t + DAY > q2a) & (t < q2b)
    sets = {"24h": {"score": np.where(first & res & ~inq2)[0], "q2": np.where(first & res & inq2)[0]},
            "7d": {"score": np.array([], dtype=int), "q2": np.array([], dtype=int)}}
    counts = {"series_days": len(t), "first_day": origins[0], "last_day": origins[-1],
              "first_scoring_origin": origins[int(sets["24h"]["score"][0])] if len(sets["24h"]["score"]) else None,
              "scoring_origins_available": int(len(sets["24h"]["score"])), "q2_origins": int(len(sets["24h"]["q2"])),
              "cash_tx_states": int(len(tl)), "g1_mismatches": g1,
              "qrt_detected": len(qrts), "qrt_outstanding_anchors_full": int((Q_full > 0).sum()),
              "qrt_outstanding_anchors_live": int((Q_live > 0).sum()),
              "drt_detected": len(drts), "drt_outstanding_anchors_full": int((R_full > 0).sum()),
              "drt_outstanding_anchors_live": int((R_live > 0).sum())}
    return {"origins": origins, "t": t, "anc": anc, "S_snap": S_snap, "C_end": C_end, "cash_t0": cash_t0,
            "dmin": dmin, "Q_full": Q_full, "Q_live": Q_live, "R_full": R_full, "R_live": R_live, "sets": sets,
            "counts": counts}


# ---------------------------------------------------------------------------------------------
# scoring
# ---------------------------------------------------------------------------------------------
def score_market(P, fc, fc_raw):
    dmin, cash_t0, S, origins = P["dmin"], P["cash_t0"], P["S_snap"], P["origins"]
    T = len(dmin)
    ratio = np.full(T, np.nan)
    with np.errstate(divide="ignore", invalid="ignore"):
        ok = np.isfinite(dmin) & (cash_t0 > 0)
        ratio[ok] = dmin[ok] / cash_t0[ok]

    def build(idx):
        rows, miss = [], {"model": 0, "emp": 0, "truth_or_nc": 0}
        for n in idx:
            n = int(n)
            fo = fc["24h"].get(n)
            em = R5.emp_baseline(ratio, cash_t0, n, H24)
            y, nc = dmin[n], dmin[n - 1] if n >= 1 else np.nan
            if fo is None:
                miss["model"] += 1
                continue
            if em is None:
                miss["emp"] += 1
                continue
            if not (np.isfinite(y) and np.isfinite(nc)):
                miss["truth_or_nc"] += 1
                continue
            fr = fc_raw["24h"].get(n)
            rows.append({"n": n, "origin": origins[n], "y": y, "nc": nc, "cash_t0": cash_t0[n], "S": S[n],
                         "m": np.asarray(fo["q1"], float), "e": np.asarray(em, float),
                         "r": None if fr is None else np.asarray(fr["q1"], float), "n_paths": fo["n_paths"]})
        return rows, miss

    def losses(rows):
        y = np.array([r["y"] for r in rows])
        M = np.array([r["m"] for r in rows])
        E = np.array([r["e"] for r in rows])
        NC = np.repeat(np.array([r["nc"] for r in rows])[:, None], 3, axis=1)
        return y, M, E, NC, R5.pinball3(y, M) / MICRO, R5.pinball3(y, E) / MICRO, R5.pinball3(y, NC) / MICRO

    rows, miss = build(P["sets"]["24h"]["score"])
    if not rows:
        raise SystemExit(f"STOP: no scorable origins (missing {miss})")
    y, M, E, NC, Lm, Le, Ln = losses(rows)
    Sx = np.array([r["S"] for r in rows]) / MICRO
    d = Lm - Le
    st_e, p_e = R5.dm_hln(d)
    st_n, p_n = R5.dm_hln(Lm - Ln)
    skill_e = 1 - Lm.mean() / Le.mean()
    skill_n = 1 - Lm.mean() / Ln.mean()
    lrv = nw_lrv(d)
    per_q = {}
    for j, q in enumerate(QS):
        per_q[str(q)] = {"pinball_model_usd": float(np.mean(R4.pinball(y, M[:, j], q)) / MICRO),
                         "pinball_empirical_usd": float(np.mean(R4.pinball(y, E[:, j], q)) / MICRO),
                         "pinball_nochange_usd": float(np.mean(R4.pinball(y, NC[:, j], q)) / MICRO),
                         "hit_model": float(np.mean(y < M[:, j])), "hit_empirical": float(np.mean(y < E[:, j])),
                         "hit_nochange": float(np.mean(y < NC[:, j]))}
    years = {}
    for yy in ("2024", "2025", "2026"):
        mk = np.array([r["origin"].startswith(yy) for r in rows])
        if mk.sum():
            years[yy] = {"n": int(mk.sum()), "skill_vs_empirical": float(1 - Lm[mk].mean() / Le[mk].mean()),
                         "skill_vs_nochange": float(1 - Lm[mk].mean() / Ln[mk].mean())}
    rr = [r for r in rows if r["r"] is not None]
    if rr:
        yr = np.array([r["y"] for r in rr])
        Lr = R5.pinball3(yr, np.array([r["r"] for r in rr])) / MICRO
        Ler = R5.pinball3(yr, np.array([r["e"] for r in rr])) / MICRO
        Lnr = R5.pinball3(yr, np.repeat(np.array([r["nc"] for r in rr])[:, None], 3, axis=1)) / MICRO
        sens = {"n": len(rr), "skill_vs_empirical": float(1 - Lr.mean() / Ler.mean()),
                "skill_vs_nochange": float(1 - Lr.mean() / Lnr.mean())}
    else:
        sens = None
    q2rows, q2miss = build(P["sets"]["24h"]["q2"])
    if q2rows:
        _, _, _, _, Lmq, Leq, Lnq = losses(q2rows)
        q2 = {"n": len(q2rows), "skill_vs_empirical": float(1 - Lmq.mean() / Leq.mean()),
              "skill_vs_nochange": float(1 - Lmq.mean() / Lnq.mean())}
    else:
        q2 = {"n": 0}
    res = {"n_scoring": len(rows), "missing": miss, "first": rows[0]["origin"], "last": rows[-1]["origin"],
           "mean_pinball_model_usd": float(Lm.mean()), "mean_pinball_empirical_usd": float(Le.mean()),
           "mean_pinball_nochange_usd": float(Ln.mean()),
           "skill_vs_empirical": float(skill_e), "dm_vs_empirical": {"stat": st_e, "p": p_e},
           "skill_vs_nochange": float(skill_n), "dm_vs_nochange": {"stat": st_n, "p": p_n},
           "alpha": ALPHA_MARKET, "PASS": pass_market(p_e, skill_n),
           "effective_n": float(len(d) * d.var() / lrv) if lrv > 0 else None,
           "skill_supply_scaled_vs_empirical": float(1 - (Lm / Sx).mean() / (Le / Sx).mean()),
           "skill_supply_scaled_vs_nochange": float(1 - (Lm / Sx).mean() / (Ln / Sx).mean()),
           "per_quantile": per_q, "by_year": years, "sensitivity_raw_endpoints": sens, "q2_reported": q2,
           "q2_missing": q2miss, "n_paths_median": float(np.median([r["n_paths"] for r in rows]))}
    pooled_in = {"dates": [r["origin"] for r in rows], "e_emp": d / Sx, "Lm_s": Lm / Sx, "Le_s": Le / Sx,
                 "Ln_s": Ln / Sx}
    out_rows = [{"market": None, "origin": r["origin"], "y_min_cash_usd": r["y"] / MICRO,
                 "cash_t0_usd": r["cash_t0"] / MICRO, "supply_t0_usd": r["S"] / MICRO,
                 "model_q05": r["m"][0] / MICRO, "model_q25": r["m"][1] / MICRO, "model_q50": r["m"][2] / MICRO,
                 "emp_q05": r["e"][0] / MICRO, "emp_q25": r["e"][1] / MICRO, "emp_q50": r["e"][2] / MICRO,
                 "nochange_usd": r["nc"] / MICRO, "loss_model_usd": float(a), "loss_emp_usd": float(b),
                 "loss_nochange_usd": float(c)} for r, a, b, c in zip(rows, Lm, Le, Ln)]
    return res, pooled_in, out_rows


def score_pooled(pin):
    dates = {m: v["dates"] for m, v in pin.items()}
    ds, D, cnt = pooled_dk(dates, {m: v["e_emp"] for m, v in pin.items()})
    st, p = R5.dm_hln(D)
    Lm = np.concatenate([v["Lm_s"] for v in pin.values()])
    Le = np.concatenate([v["Le_s"] for v in pin.values()])
    Ln = np.concatenate([v["Ln_s"] for v in pin.values()])
    sk_e = 1 - Lm.sum() / Le.sum()
    sk_n = 1 - Lm.sum() / Ln.sum()
    # reported only: within-market-only variance (ignores cross-market covariance)
    N = len(Lm)
    var_w = sum(nw_lrv(v["e_emp"]) * len(v["e_emp"]) for v in pin.values()) / N ** 2
    mu = float(np.concatenate([v["e_emp"] for v in pin.values()]).mean())
    return {"n_market_origins": int(N), "n_dates": len(ds), "markets_per_date": {str(k): int((cnt == k).sum())
                                                                                 for k in (1, 2, 3)},
            "skill_vs_empirical_supply_scaled": float(sk_e), "skill_vs_nochange_supply_scaled": float(sk_n),
            "dm_dk_vs_empirical": {"stat": st, "p": p}, "alpha": ALPHA_POOLED, "PASS": pass_pooled(p, sk_n),
            "reported_within_market_variance_z": float(mu / np.sqrt(var_w)) if var_w > 0 else None,
            "mean_scaled_difference": mu}


def guard_file(path):
    txt = gzip.open(path, "rt").read() if path.endswith(".gz") else open(path).read()
    if ADDR_RE.search(txt):
        raise SystemExit(f"STOP: address-like string in {path}")


# ---------------------------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--datasets", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--code-sha", required=True)
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--inputs-only", action="store_true")
    g.add_argument("--freeze-only", action="store_true")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    started = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    log = open(os.path.join(a.out, "run.log" if not (a.inputs_only or a.freeze_only) else "prep.log"), "a")

    def say(*m):
        s = " ".join(str(x) for x in m)
        print(s, flush=True)
        log.write(s + "\n")
        log.flush()

    say("START", "inputs-only" if a.inputs_only else "freeze-only" if a.freeze_only else "run", started)
    meta = code_meta()
    if not meta["r104_cash_equals_7b6ca7aa"]:
        raise SystemExit("STOP: r104_cash.py differs from 7b6ca7aa")
    shas = {rel: R4.sha256_file(os.path.join(a.datasets, rel)) for rel in input_files(a.datasets)}
    check_provenance(a.datasets, shas)
    fp = os.path.join(a.out, "frozen-r104b.json")
    marker = os.path.join(a.out, "run-started.json")

    if not (a.inputs_only or a.freeze_only):
        if os.path.exists(marker) or os.path.exists(os.path.join(a.out, "results-r104b.json")):
            raise SystemExit("STOP: a run already started (one run only)")
        if not os.path.exists(fp):
            raise SystemExit("STOP: no frozen config")
        fz = json.load(open(fp))
        if meta["tree_dirty"] or meta["git_head"] is None or not meta["git_head"].startswith(fz["code_sha"]):
            raise SystemExit("STOP: code is not the clean frozen sha")
        if fz["code_sha256"] != meta["sha256"] or fz["inputs_sha256"] != shas or fz["decisions"] != DECISIONS:
            raise SystemExit("STOP: code, inputs or readings differ from the frozen config")
        json.dump({"started_utc": started, "frozen_sha256": R4.sha256_file(fp)}, open(marker, "w"))

    salt = secrets.token_hex(32)
    say("load borrows / repays")
    drt_inputs = load_borrow_repay_all(a.datasets, salt)
    P = {}
    for m in MARKETS:
        say("load", m)
        P[m] = load_market(a.datasets, m, salt, drt_inputs, say)
        say(m, "counts", json.dumps(P[m]["counts"]))
    counts = {m: P[m]["counts"] for m in MARKETS}
    if a.inputs_only:
        say("inputs-only: stop (counts only; no forecast, outcome or score)")
        return
    if a.freeze_only:
        frozen = {"schema": SCHEMA, "prereg": PREREG, "code_sha": a.code_sha, "code_sha256": meta["sha256"],
                  "code_meta": meta, "r104_frozen_sha": R104_SHA, "inputs_sha256": shas, "decisions": DECISIONS,
                  "constants": {"QS": QS, "END_BLOCK": END_BLOCK, "END_TS": END_TS, "LAST_ORIGIN": LAST_ORIGIN,
                                "WARMUP_DAYS": WARMUP_DAYS, "Q2": Q2, "ALPHA_POOLED": ALPHA_POOLED,
                                "ALPHA_MARKET": ALPHA_MARKET, "NC_SKILL_MIN": NC_SKILL_MIN, "NW_LAG": R5.NW_LAG,
                                "HLN_H": R5.HLN_H, "TRAIL_DAYS": R4.TRAIL_DAYS,
                                "markets": {m: {"decimals": v[3], "deploy_block": v[4]} for m, v in MARKETS.items()}},
                  "input_counts": counts}
        frozen["created_utc"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        with open(fp, "w") as f:
            json.dump(frozen, f, indent=1, default=str)
        guard_file(fp)
        say("FROZEN frozen-r104b.json sha256", R4.sha256_file(fp), "created_utc", frozen["created_utc"])
        return

    results = {"schema": SCHEMA, "frozen_sha256": R4.sha256_file(fp), "code_sha": a.code_sha, "started_utc": started,
               "counts": counts, "per_market": {}}
    pin, rows_all = {}, []
    for m in MARKETS:
        Pm = P[m]
        full = finite_flows(R4.make_flows(Pm["S_snap"], Pm["C_end"], Pm["dmin"], Pm["Q_full"], Pm["R_full"]))
        live = finite_flows(R4.make_flows(Pm["S_snap"], Pm["C_end"], Pm["dmin"], Pm["Q_live"], Pm["R_live"]))
        raw = finite_flows(R4.make_flows(Pm["S_snap"], Pm["C_end"], Pm["dmin"], np.zeros(len(Pm["t"])),
                                         np.zeros(len(Pm["t"]))))
        say(m, "forecast")
        fc = R4.run_variant(full, live, Pm["dmin"], Pm["cash_t0"], Pm["sets"], None, False)
        fc_raw = R4.run_variant(raw, None, Pm["dmin"], Pm["cash_t0"], Pm["sets"], None, False)
        res, pin[m], rows = score_market(Pm, fc, fc_raw)
        for r in rows:
            r["market"] = m
        rows_all += rows
        results["per_market"][m] = res
        say(m, json.dumps({k: res[k] for k in ("n_scoring", "mean_pinball_model_usd", "mean_pinball_empirical_usd",
                                                "mean_pinball_nochange_usd", "skill_vs_empirical", "dm_vs_empirical",
                                                "skill_vs_nochange", "PASS")}))
    results["pooled"] = score_pooled(pin)
    say("pooled", json.dumps(results["pooled"]))
    results["finished_utc"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    rp = os.path.join(a.out, "results-r104b.json")
    with open(rp, "w") as f:
        json.dump(results, f, indent=1, default=str)
    fcp = os.path.join(a.out, "forecasts-r104b.csv.gz")
    pd.DataFrame(rows_all).to_csv(fcp, index=False, compression="gzip")
    guard_file(rp)
    guard_file(fcp)
    say("END", results["finished_utc"], "results sha256", R4.sha256_file(rp))


if __name__ == "__main__":
    main()
