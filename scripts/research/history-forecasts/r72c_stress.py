#!/usr/bin/env python3
"""Q26 round 9 R9.1(d)2 R7.2c top-holder stress with corrected inputs (Aave V3 Core USDC; reported, deciding nothing).

membrane-board design/Q26_ROUND9_PREREG.md @4d46a7e (R9.1(d)2 with Deviations D1-D3), R7.2 definitions from
design/Q26_ROUND7_PREREG.md.

  python3 r72c_stress.py --datasets <membrane-datasets> --r9 <history-forecasts/r9/run-dfdd3ad8> --out <dir>

Per 00:00Z origin 2023-02-02 .. 2026-10-13, four variants of the R7.2 stress block (r7_live.stress_block, unchanged):
  U   uncorrected: holders ranked by point balance at t0 (state after the last event with ts < t0, the daily
      snapshot definition), cash and supply = the snapshot point values;
  A   time-weighted only: holders ranked by raw W24 = (t0 - 24 h, t0] time-weighted mean balance, cash = W24
      time-weighted median cash, supply = W24 mean supply (R9.1(a));
  C   corrected (registered): holders ranked by QRT-neutralised W24 mean balance (R9.1(b), look-ahead: a QRT
      counts iff its redeposit leg completes <= t0 + 60 min), cash = W24 median cash, supply = W24 mean supply;
  Cp  C holders with the point cash at t0 beside it (registered "point cash at asof shown beside it").
The refill regression (r7_refill.py) is re-estimated once with the QRT withdraw-leg neutralised amounts removed
from the hourly withdrawals (the R9.1 D2 refill condition is met: 22.4% >= 1%). The frozen live pin
(history-forecasts/r7/r7-refill-usdc.json, sha256 cb13e6b7...) is not touched; hours-to-cover are reported under
the old and the new betas. Addresses are used in memory only (integer codes); nothing written names one.
"""
import argparse
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import r7_live as R7          # noqa: E402
import r7_refill as RF        # noqa: E402

PREREG = {"repo": "triccs/membrane-board", "path": "design/Q26_ROUND9_PREREG.md", "commit": "4d46a7e",
          "item": "R9.1(d)2 R7.2c top-holder stress (reported, deciding nothing)"}
SCHEMA = "q26-r9/r72c/1"
MICRO = 10 ** 6
RAY = 10 ** 27
DAY = 86400
LOOKAHEAD_S = 3600
MIN_HOLDER_RAW = 1_000_000 * MICRO
EVENTS = [f"depositor-events/events-usdc-{y}.csv.gz" for y in (2023, 2024, 2025, 2026)]
UNIVERSE = "depositor-events/extended-universe.csv"
FLAGS = "cross-venue/address-flags.csv"
DAILY = "depositor-balances/daily-balances-usdc.csv.gz"
OLD_REFILL = "history-forecasts/r7/r7-refill-usdc.json"
OLD_REFILL_SHA = "cb13e6b79b31343af83a4352f29573ba8f5a452c532a8e7b60942db4125a5f61"
R9_SHA = {"qrt-legs-usdc.csv.gz": "f3da86020fbd5dd4841e816c66611d3bb31a65a9812d5c18bf87f96d5dc5bd8e",
          "qrt-usdc.csv": "d94d8e78484a66a823388b007432cbf7043334a99ec3bcb41e60774719033f8b",
          "w24-pool-usdc.csv": "b3cbe460e38ac62f6abfc4b3521ae26328f9aa7ea9ec81c2357f56540f991912"}
CUT_PRIMARY = "2026-01-22"      # D3: pre-drain cutoff (primary)
CUT_JULY = "2026-07-01"         # registered pre-July version, reported beside
SCEN = ("S2", "S5", "S10", "class run-off")
VARIANTS = ("U", "A", "C", "Cp")
BUDGET_QRT_SHARE, BUDGET_QRT_DAYS = 0.005, 0.01
BUDGET_TW_MONTH_MEDIAN = 0.02
ADDR_RE = re.compile(r"0x[0-9a-fA-F]{40}(?![0-9a-fA-F])")

DECISIONS = [
    "R72c-1 balances: per address the scaled aUSDC balance is rebuilt from every Mint/Burn (sign(delta1_raw) x "
    "rayDiv(|delta1_raw|, index)) and BalanceTransfer (scaled value_raw moved from party1 to party2) from "
    "deployment; USD balance = scaled x the index of the last Mint/Burn event with ts < t0 (the index moves < 1e-5 "
    "between events at this volume). Check VB: point balances equal the daily snapshot balanceOf of every P_r "
    "address on 6 fixed snapshot dates within 1e-5 relative or $1.",
    "R72c-2 universe = addresses that reach $1M by events (extended-universe.csv); per origin and variant the "
    "holders are those with balance >= $1M in that variant (R7.2-1). Holder type = address-flags.csv is_contract "
    "(the live issuer source; full coverage of the universe).",
    "R72c-3 W24 mean balance = time-weighted mean of the scaled balance over (t0 - 24 h, t0] (state in force at "
    "t0 - 24 h starts the window; only ts <= t0 enters), times the index at t0. QRT neutralisation (C) adds to the "
    "withdraw-leg owner's path +neutral at the Burn ts and -neutral of each redeposit leg at its Mint ts (from "
    "qrt-legs-usdc.csv.gz, joined to depositor-events by (block, tx_index, log_index)), only for QRTs whose "
    "completion ts <= t0 + 60 min.",
    "R72c-4 cash and supply: U = snapshot point cash and supply (w24-pool snap_*); A and C = W24 time-weighted "
    "median cash (w24_median_cash, R9.1(a), raw cash as registered) and W24 mean supply; Cp = C holders with the "
    "snapshot point cash and supply. Ex-QRT median cash (w24x_median_cash) is reported as a sensitivity only.",
    "R72c-5 refill re-estimate: r7_refill.py unchanged (window, repays, same-tx exclusion, OLS, NW lag) except the "
    "hourly withdrawals W_t lose each QRT withdraw leg's neutralised amount (all QRTs, no look-ahead: a fit on "
    "history). Check VR: the unmodified W reproduces the frozen betas exactly. The new file is written beside the "
    "outputs and is NOT pinned.",
    "R72c-6 (e) budget for the corrected - uncorrected shortfall difference (registered: days before the cutoff "
    "must meet the (e) budget; D3 cutoff 2026-01-22 primary, 2026-07-01 beside). The difference C - U splits into "
    "the time-weighting part A - U and the QRT part C - A. QRT part: the pre-drain neutrality budget, "
    "|C - A| / W24 supply > 0.5% on <= 1% of pre-cutoff days, per scenario. Time-weighting part: the pool-input "
    "budget, reported by month, a pre-cutoff month flagged iff its median |A - U| / W24 supply > 2%. The total "
    "C - U is reported per day. Off-drain view: the QRT part with the drain-role unit's QRTs left un-neutralised "
    "is reported beside it.",
    "R72c-7 old vs new pin: hours until cash >= 0 under the frozen betas and the re-estimated betas, for C and U, "
    "per day; summary at the last origin and by period. Shortfalls do not depend on the refill file.",
]


def sha256_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def day_ts(d):
    return int(datetime.strptime(d, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp())


def ray_div(a, b):
    return (a * RAY + b // 2) // b


# ---------------------------------------------------------------------------------------------
# pure helpers (tested)
# ---------------------------------------------------------------------------------------------
def step_integral(ts, vals, grid):
    """For a right-continuous step function (ts sorted unique, value vals[k] on [ts[k], ts[k+1]); 0 before ts[0]),
    the integral from ts[0] (or -inf, value 0) to each grid point. Returns float array."""
    ts = np.asarray(ts, np.int64)
    vals = np.asarray(vals, float)
    grid = np.asarray(grid, np.int64)
    if not len(ts):
        return np.zeros(len(grid))
    seg = np.diff(ts).astype(float) * vals[:-1]
    cum = np.concatenate([[0.0], np.cumsum(seg)])          # integral up to ts[k]
    k = np.searchsorted(ts, grid, side="right") - 1
    out = np.zeros(len(grid))
    ok = k >= 0
    kk = k[ok]
    out[ok] = cum[kk] + vals[kk] * (grid[ok] - ts[kk]).astype(float)
    return out


def step_point(ts, vals, grid, strict=True):
    """value in force just before (strict) or at each grid point; 0 before the first step."""
    ts = np.asarray(ts, np.int64)
    if not len(ts):
        return np.zeros(len(grid))
    k = np.searchsorted(ts, np.asarray(grid, np.int64), side="left" if strict else "right") - 1
    return np.where(k >= 0, np.asarray(vals, float)[np.clip(k, 0, None)], 0.0)


def window_mean(ts, vals, t0s, width=DAY):
    t0s = np.asarray(t0s, np.int64)
    return (step_integral(ts, vals, t0s) - step_integral(ts, vals, t0s - width)) / float(width)


def qrt_window_integral(legs, a, b):
    """legs = [(ts, +/-amount)] of one QRT (withdraw +n, redeposits -portions); integral of the outstanding amount
    over (a, b]."""
    legs = sorted(legs)
    ts = np.array([t for t, _ in legs], np.int64)
    v = np.cumsum([x for _, x in legs]).astype(float)
    return float(step_integral(ts, v, [b])[0] - step_integral(ts, v, [a])[0])


def hourly_subtract(W, lo, legs_ts, legs_usd):
    """W minus amounts placed in their UTC hour bins from lo (out-of-range ignored). Returns a new array."""
    W2 = W.copy()
    ts = np.asarray(legs_ts, np.int64)
    k = (ts >= lo) & (ts < lo + 3600 * len(W))
    np.add.at(W2, (ts[k] - lo) // 3600, -np.asarray(legs_usd, float)[k])
    return W2


# ---------------------------------------------------------------------------------------------
# loading
# ---------------------------------------------------------------------------------------------
def load_events(datasets):
    cols = ["block", "ts", "tx_index", "log_index", "type", "party1", "party2", "value_raw", "delta1_raw",
            "index_ray"]
    out = []
    for rel in EVENTS:
        for ch in pd.read_csv(os.path.join(datasets, rel), usecols=cols,
                              dtype={"delta1_raw": str, "index_ray": str, "value_raw": str, "party1": str,
                                     "party2": str}, chunksize=1_000_000):
            ch = ch[ch["type"].isin(["Mint", "Burn", "BalanceTransfer"])].copy()
            ch["party1"] = ch["party1"].str.lower()
            ch["party2"] = ch["party2"].str.lower()
            out.append(ch)
    ev = pd.concat(out, ignore_index=True)
    return ev.sort_values(["block", "tx_index", "log_index"], kind="mergesort").reset_index(drop=True)


def scaled_moves(ev):
    """long table (addr, ts, ord, dscaled) of every scaled-balance move; ord = global event order."""
    mb = ev[ev["type"].isin(["Mint", "Burn"]) & ev["delta1_raw"].notna()]
    d = [int(x) for x in mb["delta1_raw"]]
    ix = [int(x) for x in mb["index_ray"]]
    ds = [ray_div(abs(a), b) * (1 if a >= 0 else -1) for a, b in zip(d, ix)]
    m1 = pd.DataFrame({"addr": mb["party1"].values, "ts": mb["ts"].astype(np.int64).values,
                       "ord": mb.index.values, "ds": np.array(ds, dtype=np.int64)})
    bt = ev[ev["type"] == "BalanceTransfer"]
    v = np.array([int(x) for x in bt["value_raw"]], dtype=np.int64)
    m2 = pd.DataFrame({"addr": bt["party1"].values, "ts": bt["ts"].astype(np.int64).values,
                       "ord": bt.index.values, "ds": -v})
    m3 = pd.DataFrame({"addr": bt["party2"].values, "ts": bt["ts"].astype(np.int64).values,
                       "ord": bt.index.values, "ds": v})
    mv = pd.concat([m1, m2, m3], ignore_index=True)
    return mv.sort_values(["addr", "ord"], kind="mergesort").reset_index(drop=True)


def index_path(ev):
    mb = ev[ev["type"].isin(["Mint", "Burn"]) & ev["index_ray"].notna()]
    t = mb["ts"].astype(np.int64).values
    ix = np.array([int(x) for x in mb["index_ray"]], dtype=object)
    # last index per ts
    df = pd.DataFrame({"ts": t, "ix": ix}).groupby("ts", sort=True)["ix"].last()
    return df.index.values.astype(np.int64), np.array([float(x) / RAY for x in df.values])


def per_address_paths(mv, addrs):
    """dict addr -> (ts unique sorted, scaled balance after the last event at that ts) for the given addresses."""
    sub = mv[mv["addr"].isin(addrs)]
    out = {}
    for a, g in sub.groupby("addr", sort=False):
        s = np.cumsum(g["ds"].to_numpy(np.int64))
        t = g["ts"].to_numpy(np.int64)
        last = np.r_[t[1:] != t[:-1], True]
        out[a] = (t[last], s[last].astype(float))
    return out


# ---------------------------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------------------------
def scen_vals(block):
    out = {}
    for s in block["scenarios"]:
        out[s["scenario"]] = (s["withdrawalUSD"], s["shortfallUSD"], s["hoursUntilCashNonNegative"],
                              s["reachedBy72h"])
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--datasets", required=True)
    ap.add_argument("--r9", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    started = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    if os.path.exists(a.out) and os.listdir(a.out):
        raise SystemExit(f"STOP: {a.out} not empty (run once)")
    os.makedirs(a.out, exist_ok=True)
    for f, h in R9_SHA.items():
        got = sha256_file(os.path.join(a.r9, f))
        if got != h:
            raise SystemExit(f"STOP: {f} sha256 {got} != {h}")
    if sha256_file(os.path.join(a.datasets, OLD_REFILL)) != OLD_REFILL_SHA:
        raise SystemExit("STOP: frozen refill file sha256 mismatch")
    old = json.load(open(os.path.join(a.datasets, OLD_REFILL)))
    for rel, h in old["inputs"].items():
        if sha256_file(os.path.join(a.datasets, rel)) != h:
            raise SystemExit(f"STOP: refill input {rel} changed")

    # ---------------- refill re-estimate ----------------
    print("refill", flush=True)
    lo, end = RF.START, RF.END
    hi = end + (max(RF.HOURS) + 1) * 3600
    W, wtx = RF.hourly_withdrawals(a.datasets, lo, hi)
    R, rmeta = RF.hourly_repays(a.datasets, lo, hi, wtx)
    n = (end - lo) // 3600
    est_old = RF.estimate(W, R, n)
    vr = {h: (est_old[h]["beta"], old["fit"][h]["beta"]) for h in est_old}
    vr_pass = all(abs(x - y) <= 1e-9 * max(1.0, abs(y)) for x, y in vr.values())
    if not vr_pass:
        raise SystemExit(f"STOP: VR failed, unmodified W does not reproduce the frozen betas {vr}")

    legs = pd.read_csv(os.path.join(a.r9, "qrt-legs-usdc.csv.gz"), dtype={"tx_hash": str})
    qrt = pd.read_csv(os.path.join(a.r9, "qrt-usdc.csv"))
    wl = legs[legs["leg"] == "withdraw"]
    W2 = hourly_subtract(W, lo, wl["ts"].to_numpy(np.int64), wl["neutral_raw"].astype(float).to_numpy() / MICRO)
    if (W2 < -1e-6).any():
        raise SystemExit("STOP: QRT removal makes an hourly withdrawal negative")
    est_new = RF.estimate(W2, R, n)
    in_dev = (wl["ts"] >= lo) & (wl["ts"] < end)
    refill_new = {
        "schema": "q26-r7/refill/1", "variant": "qrt-neutralised (R9.1(d)2 R7.2c re-estimate; NOT pinned)",
        "prereg": PREREG, "prereg_r7": old["prereg"], "reserve": "USDC", "market": "Aave V3 Ethereum Core",
        "originHours": old["originHours"], "dataEndTs": old["dataEndTs"], "dataEndIso": old["dataEndIso"],
        "method": old["method"] + "; W_t minus the neutralised amount of every R9.1(b) QRT withdraw leg in [t, t+1h)",
        "beta": {k: v["beta"] for k, v in est_new.items()}, "fit": est_new,
        "withdrawals": {"totalUSD": float(W2[:n].sum()), "hoursWithWithdrawal": int((W2[:n] > 1e-6).sum()),
                        "qrtRemovedUSD": float(wl.loc[in_dev, "neutral_raw"].astype(float).sum() / MICRO),
                        "qrtLegsRemoved": int(in_dev.sum()),
                        "qrtShareOfDevWithdrawals": float(wl.loc[in_dev, "neutral_raw"].astype(float).sum()
                                                          / MICRO / W[:n].sum())},
        "repays": rmeta, "inputs": dict(old["inputs"], **{
            "history-forecasts/r9/run-dfdd3ad8/qrt-legs-usdc.csv.gz": R9_SHA["qrt-legs-usdc.csv.gz"]}),
        "reproducesFrozen": {"file": OLD_REFILL, "sha256": OLD_REFILL_SHA, "betaUnmodifiedW": {h: v[0] for h, v
                                                                                                in vr.items()},
                             "pass": vr_pass},
        "code": {"file": "scripts/research/history-forecasts/r72c_stress.py",
                 "sha256": sha256_file(os.path.abspath(__file__))}}
    new_bytes = (json.dumps(refill_new, indent=1, sort_keys=True) + "\n").encode()
    with open(os.path.join(a.out, "r7-refill-usdc-qrtx.json"), "xb") as f:
        f.write(new_bytes)
    new_sha = hashlib.sha256(new_bytes).hexdigest()
    refill_old_obj = dict(old, _file=OLD_REFILL, _sha256=OLD_REFILL_SHA)
    refill_new_obj = dict(refill_new, _file="r7-refill-usdc-qrtx.json", _sha256=new_sha)
    print("refill old", {h: round(v["beta"], 4) for h, v in est_old.items()},
          "new", {h: round(v["beta"], 4) for h, v in est_new.items()}, flush=True)
    del W, W2, R

    # ---------------- balances ----------------
    print("events", flush=True)
    ev = load_events(a.datasets)
    key = ev.set_index(["block", "tx_index", "log_index"])
    wl_keys = list(zip(wl["block"], wl["tx_index"], wl["log_index"]))
    owners = key.loc[wl_keys, ["type", "party1"]]
    if (owners["type"] != "Burn").any():
        raise SystemExit("STOP: a QRT withdraw leg is not a Burn")
    leg_owner = dict(zip(wl["qrt_id"], owners["party1"].values))
    rl = legs[legs["leg"] == "redeposit"]
    rk = key.loc[list(zip(rl["block"], rl["tx_index"], rl["log_index"])), ["type", "party1"]]
    if (rk["type"] != "Mint").any() or (rk["party1"].values != rl["qrt_id"].map(leg_owner).values).any():
        raise SystemExit("STOP: a QRT redeposit leg is not a Mint onBehalfOf the withdraw-leg owner")
    del key
    unit_of_owner = {}
    for q, u in zip(wl["qrt_id"], wl["unit"]):
        o = leg_owner[q]
        if unit_of_owner.setdefault(o, u) != u:
            raise SystemExit("STOP: one owner maps to two unit roles")
    drain_owner = [o for o, u in unit_of_owner.items() if u == "drain-role"]
    if len(drain_owner) != 1:
        raise SystemExit("STOP: drain-role owner not unique")
    drain_owner = drain_owner[0]

    uni = pd.read_csv(os.path.join(a.datasets, UNIVERSE))
    uni = uni[(uni["reserve"] == "USDC") & (uni["reaches_1M_by_events"] == 1)]
    addrs = sorted(set(uni["address"].str.lower()) | set(unit_of_owner))
    flags = pd.read_csv(os.path.join(a.datasets, FLAGS))
    cflag = dict(zip(flags["address"].str.lower(), flags["is_contract"].astype(int)))
    missing = [x for x in addrs if x not in cflag]
    if missing:
        raise SystemExit(f"STOP: {len(missing)} universe addresses without a holder-type flag")

    mv = scaled_moves(ev)
    ix_ts, ix_val = index_path(ev)
    del ev
    paths = per_address_paths(mv, set(addrs))
    del mv

    w24 = pd.read_csv(os.path.join(a.r9, "w24-pool-usdc.csv"))
    origins = w24["origin"].tolist()
    t0s = w24["t0"].to_numpy(np.int64)
    idx_t0 = step_point(ix_ts, ix_val, t0s, strict=True)       # index of the last event with ts < t0
    A_ = len(addrs)
    point = np.zeros((A_, len(t0s)))
    meanw = np.zeros((A_, len(t0s)))
    for i, ad in enumerate(addrs):
        t, s = paths.get(ad, (np.array([], np.int64), np.array([])))
        point[i] = step_point(t, s, t0s, strict=True) * idx_t0
        meanw[i] = window_mean(t, s, t0s) * idx_t0
    point = np.maximum(point, 0.0)
    meanw = np.maximum(meanw, 0.0)

    # QRT add-backs (USD raw), look-ahead per origin
    add = np.zeros((A_, len(t0s)))
    add_off = np.zeros((A_, len(t0s)))                          # drain-role QRTs not neutralised
    aidx = {ad: i for i, ad in enumerate(addrs)}
    qdone = dict(zip(qrt["qrt_id"], qrt["done_ts"]))
    qlegs = {}
    for q, lg, t, v in zip(legs["qrt_id"], legs["leg"], legs["ts"], legs["neutral_raw"].astype(float)):
        qlegs.setdefault(q, []).append((int(t), v if lg == "withdraw" else -v))
    for q, lg in qlegs.items():
        o = leg_owner[q]
        tmin, tmax = min(t for t, _ in lg), max(t for t, _ in lg)
        for j in np.nonzero((t0s >= tmin) & (t0s - DAY <= tmax))[0]:
            if qdone[q] > t0s[j] + LOOKAHEAD_S:
                continue
            v = qrt_window_integral(lg, int(t0s[j]) - DAY, int(t0s[j])) / DAY
            add[aidx[o], j] += v
            if o != drain_owner:
                add_off[aidx[o], j] += v
    meanx = meanw + add
    meanx_off = meanw + add_off

    # check VB: point balances vs daily snapshots on fixed dates
    vb_dates = ["2023-06-01", "2024-03-01", "2024-11-15", "2025-06-01", "2026-03-10", "2026-10-07"]
    dsnap = []
    for ch in pd.read_csv(os.path.join(a.datasets, DAILY), dtype={"balance_raw": str, "address": str},
                          chunksize=2_000_000):
        dsnap.append(ch[ch["snapshot"].isin(vb_dates)])
    dsnap = pd.concat(dsnap)
    vb = {"n": 0, "fail": 0, "maxRel": 0.0}
    oi = {o: j for j, o in enumerate(origins)}
    for d, g in dsnap.groupby("snapshot"):
        j = oi[d]
        for ad, b in zip(g["address"].str.lower(), g["balance_raw"]):
            if ad not in aidx or not isinstance(b, str) or not b.isdigit():
                continue
            b = float(b)
            mine = point[aidx[ad], j]
            vb["n"] += 1
            err = abs(mine - b)
            rel = err / max(b, 1.0)
            if err > MICRO and rel > 1e-5:
                vb["fail"] += 1
            if b >= MIN_HOLDER_RAW:
                vb["maxRel"] = max(vb["maxRel"], rel)
    vb["PASS"] = vb["fail"] == 0
    print("VB", vb, flush=True)
    if not vb["PASS"]:
        raise SystemExit(f"STOP: VB failed {vb}")
    del dsnap

    # ---------------- stress per origin ----------------
    print("stress", flush=True)
    is_c = np.array([cflag[x] for x in addrs], int)
    drain_i = aidx[drain_owner]
    rows = []

    def units(bal_col):
        m = bal_col >= MIN_HOLDER_RAW
        return [(int(round(b)), int(c)) for b, c in zip(bal_col[m], is_c[m])]

    def rank_of(bal_col, i):
        if bal_col[i] < MIN_HOLDER_RAW:
            return None
        return int((bal_col > bal_col[i]).sum() + 1)

    for j, d in enumerate(origins):
        r = w24.iloc[j]
        cash_snap, sup_snap = int(round(r["snap_cash"] * MICRO)), int(round(r["snap_supply"] * MICRO))
        cash_w, sup_w = int(round(r["w24_median_cash"] * MICRO)), int(round(r["w24_mean_supply"] * MICRO))
        cash_wx = int(round(r["w24x_median_cash"] * MICRO))
        uU, uA, uC = units(point[:, j]), units(meanw[:, j]), units(meanx[:, j])
        uO = units(meanx_off[:, j])
        row = {"origin": d, "snap_cash": r["snap_cash"], "snap_supply": r["snap_supply"],
               "w24_median_cash": r["w24_median_cash"], "w24x_median_cash": r["w24x_median_cash"],
               "w24_mean_supply": r["w24_mean_supply"], "n_holders_U": len(uU), "n_holders_C": len(uC),
               "drain_rank_U": rank_of(point[:, j], drain_i), "drain_rank_C": rank_of(meanx[:, j], drain_i),
               "drain_point_usd": point[drain_i, j] / MICRO, "drain_w24x_usd": meanx[drain_i, j] / MICRO}
        blocks = {"U": (uU, cash_snap, sup_snap), "A": (uA, cash_w, sup_w), "C": (uC, cash_w, sup_w),
                  "Cp": (uC, cash_snap, sup_snap), "Cx": (uC, cash_wx, sup_w), "O": (uO, cash_w, sup_w)}
        for v, (u, c, s) in blocks.items():
            bo = scen_vals(R7.stress_block(u, c, s, refill_old_obj))
            bn = scen_vals(R7.stress_block(u, c, s, refill_new_obj))
            for k, sc in zip(("S2", "S5", "S10", "RO"), SCEN):
                w_, sf, ho, _ = bo[sc]
                row[f"{v}_{k}_w"] = w_
                row[f"{v}_{k}_sf"] = sf
                if v in ("U", "C", "Cp"):
                    row[f"{v}_{k}_h_old"] = ho
                    row[f"{v}_{k}_h_new"] = bn[sc][2]
        rows.append(row)
    df = pd.DataFrame(rows)

    # ---------------- checks ----------------
    sk = ("S2", "S5", "S10", "RO")
    supw = df["w24_mean_supply"]
    for k in sk:
        df[f"d_total_{k}"] = (df[f"C_{k}_sf"] - df[f"U_{k}_sf"]) / supw
        df[f"d_tw_{k}"] = (df[f"A_{k}_sf"] - df[f"U_{k}_sf"]) / supw
        df[f"d_qrt_{k}"] = (df[f"C_{k}_sf"] - df[f"A_{k}_sf"]) / supw
        df[f"d_qrt_off_{k}"] = (df[f"O_{k}_sf"] - df[f"A_{k}_sf"]) / supw
    df["month"] = df["origin"].str[:7]
    checks = {}
    for cut_name, cut in (("pre-2026-01-22 (primary, D3)", CUT_PRIMARY), ("pre-2026-07-01 (registered, beside)",
                                                                           CUT_JULY)):
        pre = df[df["origin"] < cut]
        c = {"nDays": int(len(pre)), "qrtPart": {}, "timeWeightingPart": {}, "total": {}}
        for k in sk:
            share = float((pre[f"d_qrt_{k}"].abs() > BUDGET_QRT_SHARE).mean())
            c["qrtPart"][k] = {"daysOver0.5pct": int((pre[f"d_qrt_{k}"].abs() > BUDGET_QRT_SHARE).sum()),
                               "share": share, "pass": share <= BUDGET_QRT_DAYS,
                               "offDrainDaysOver0.5pct": int((pre[f"d_qrt_off_{k}"].abs() > BUDGET_QRT_SHARE).sum())}
            mm = pre.groupby("month")[f"d_tw_{k}"].apply(lambda x: float(x.abs().median()))
            c["timeWeightingPart"][k] = {"monthsFlagged": {m: round(v, 4) for m, v in mm.items()
                                                           if v > BUDGET_TW_MONTH_MEDIAN},
                                         "maxMonthMedian": float(mm.max()), "pass": bool((mm <= BUDGET_TW_MONTH_MEDIAN).all())}
            c["total"][k] = {"medianAbs": float(pre[f"d_total_{k}"].abs().median()),
                             "p95Abs": float(pre[f"d_total_{k}"].abs().quantile(0.95)),
                             "medianSigned": float(pre[f"d_total_{k}"].median())}
        c["flag"] = not all(c["qrtPart"][k]["pass"] and c["timeWeightingPart"][k]["pass"] for k in sk)
        checks[cut_name] = c

    def period(lo_, hi_):
        p = df[(df["origin"] >= lo_) & (df["origin"] <= hi_)]
        out = {"nDays": int(len(p)), "drainInTop10_U": int((p["drain_rank_U"].fillna(99) <= 10).sum()),
               "drainInTop10_C": int((p["drain_rank_C"].fillna(99) <= 10).sum()),
               "drainInTop2_C": int((p["drain_rank_C"].fillna(99) <= 2).sum())}
        for k in sk:
            for v in ("U", "C", "Cp"):
                out[f"{v}_{k}_sf_median_share"] = float((p[f"{v}_{k}_sf"] / (p["snap_supply"] if v in ("U", "Cp")
                                                                             else p["w24_mean_supply"])).median())
            for v in ("U", "C"):
                ho, hn = p[f"{v}_{k}_h_old"], p[f"{v}_{k}_h_new"]
                pos = p[f"{v}_{k}_sf"] > 0
                out[f"{v}_{k}_h_old_median"] = float(ho[pos].median()) if ho[pos].notna().any() else None
                out[f"{v}_{k}_h_new_median"] = float(hn[pos].median()) if hn[pos].notna().any() else None
                out[f"{v}_{k}_unreached72_old"] = int((pos & ho.isna()).sum())
                out[f"{v}_{k}_unreached72_new"] = int((pos & hn.isna()).sum())
        return out

    last = df.iloc[-1]
    last_d = {"origin": last["origin"], "drain_rank_U": last["drain_rank_U"], "drain_rank_C": last["drain_rank_C"]}
    for v in ("U", "C", "Cp"):
        for k in sk:
            last_d[f"{v}_{k}"] = {"withdrawalUSD": float(last[f"{v}_{k}_w"]), "shortfallUSD": float(last[f"{v}_{k}_sf"]),
                                  "hoursOld": (None if pd.isna(last[f"{v}_{k}_h_old"]) else float(last[f"{v}_{k}_h_old"])),
                                  "hoursNew": (None if pd.isna(last[f"{v}_{k}_h_new"]) else float(last[f"{v}_{k}_h_new"]))}
    summary = {
        "schema": SCHEMA, "prereg": PREREG, "started": started,
        "finished": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "decides": False, "decisions": DECISIONS,
        "checks": {"VR_reproducesFrozenBetas": {"pass": vr_pass, "betas": {h: v for h, v in vr.items()}},
                   "VB_pointBalancesVsDailySnapshots": vb, "eBudget": checks,
                   "flag": any(c["flag"] for c in checks.values())},
        "refill": {"old": {"file": OLD_REFILL, "sha256": OLD_REFILL_SHA, "beta": old["beta"],
                           "r2": {h: old["fit"][h]["r2"] for h in old["fit"]}},
                   "new": {"file": "r7-refill-usdc-qrtx.json", "sha256": new_sha, "beta": refill_new["beta"],
                           "r2": {h: est_new[h]["r2"] for h in est_new},
                           "se_beta_nw": {h: est_new[h]["se_beta_nw"] for h in est_new}},
                   "qrtRemoved": refill_new["withdrawals"], "pinned": False},
        "lastOrigin": last_d,
        "periods": {"pre-2026-01-22": period("2023-02-02", "2026-01-21"),
                    "2026-01-22..2026-06-30": period("2026-01-22", "2026-06-30"),
                    "2026-07-01..2026-10-13": period("2026-07-01", "2026-10-13"),
                    "all": period("2023-02-02", "2026-10-13")},
        "inputs": {**{f"history-forecasts/r9/run-dfdd3ad8/{f}": h for f, h in R9_SHA.items()},
                   **{rel: sha256_file(os.path.join(a.datasets, rel)) for rel in EVENTS + [UNIVERSE, FLAGS, DAILY,
                                                                                         OLD_REFILL]}},
        "code": {"file": "scripts/research/history-forecasts/r72c_stress.py",
                 "sha256": sha256_file(os.path.abspath(__file__))},
    }
    keep = [c for c in df.columns if not c.startswith("O_") and not c.startswith("A_") or c.endswith("_sf")]
    csv_text = df[keep].to_csv(index=False, float_format="%.6f")
    js = json.dumps(summary, indent=1, sort_keys=True, default=lambda x: None if pd.isna(x) else float(x))
    for txt in (csv_text, js, new_bytes.decode()):
        if ADDR_RE.search(txt):
            raise SystemExit("STOP: an address-shaped string in an output")
    with open(os.path.join(a.out, "r72c-daily-usdc.csv"), "x") as f:
        f.write(csv_text)
    with open(os.path.join(a.out, "r72c-summary.json"), "x") as f:
        f.write(js + "\n")
    print(json.dumps({"flag": summary["checks"]["flag"], "refill_new": refill_new["beta"]}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
