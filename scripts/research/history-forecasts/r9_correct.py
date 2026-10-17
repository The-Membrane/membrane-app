#!/usr/bin/env python3
"""Q26 round 9 R9.1(a,b,c) snapshot-bias correction inputs and their pre-use gates (Aave V3 Core USDC).

membrane-board design/Q26_ROUND9_PREREG.md @691cb27, items R9.1(a), (b), (c) and the input-level checks of (d)/(e).

  python3 r9_correct.py --datasets <membrane-datasets> --cash <dir with the 3 aave-pool-cash files> --out <dir>

Builds, from event logs only:
  (a) the exact tx-level cash path and the scaledSupply x liquidityIndex supply path; W24 = (t0 - 24 h, t0]
      time-weighted pool state per 00:00Z origin; gate V1 against every reserve-state snapshot.
  (b) the same-address round-trip (QRT) detector with the registered thresholds; ex-QRT cash/supply W24 features
      under the look-ahead rule; gate V2 (drain-role wallet flagged on >= 90% of days 2026-07-01 .. 2026-10-13).
  (c) lock spells (gaps < 15 min merged, locked time = time below), LOCK6/LOCK1/3/12 and SPIKE6 labels.
  (d)/(e) input-level checks: label-day share Aug-Oct 2026, April 2026 lock kept, pre-July ex-QRT neutrality,
      W24-vs-snapshot gap by month, expected direction after 2026-07-01, refill re-estimation condition.

No fit, score or outcome is computed. No address is written to any output: addresses are replaced by a salted
hash on load (the salt is random per run and never written), and outputs name units by role
("drain-role", "other-NN"). QRT legs are published by event key (block, tx_index, log_index, tx_hash) so the
B6c label step can reuse them.
"""
import argparse
import bisect
import gzip
import hashlib
import json
import os
import secrets
import sys
from collections import defaultdict
from datetime import datetime, timezone

import numpy as np
import pandas as pd

PREREG = {"repo": "triccs/membrane-board", "path": "design/Q26_ROUND9_PREREG.md", "commit": "691cb27",
          "item": "R9.1(a,b,c) inputs and pre-use gates"}
SCHEMA = "q26-r9/r91/1"
MICRO = 10 ** 6
RAY = 10 ** 27
YEAR = 365 * 86400
LOCK_FRAC = 0.005
MERGE_GAP_S = 15 * 60
LOCK_MIN_H = 6
LOCK_SENS_H = (1, 3, 12)
SPIKE_MULT, SPIKE_ADD, SPIKE_MIN_S = 2.0, 0.03, 3600
QRT_MIN_USD = 10_000_000
QRT_MIN_FRAC = 0.005
QRT_WINDOW_S = 2 * 3600
QRT_FILL = 0.95
QRT_CAP = 1.05
LOOKAHEAD_S = 3600
HORIZONS = {"24h": 86400, "7d": 7 * 86400}
FIRST_ORIGIN = "2023-02-02"
LAST_ORIGIN = "2026-10-13"
DRAIN_WIN = ("2026-07-01", "2026-10-13")
DEV_WIN = ("2023-02-01", "2026-07-01")         # 2023-02 .. 2026-06 inclusive
APRIL_ORIGINS = ("2026-04-18", "2026-04-19", "2026-04-20")
AUG_WIN = ("2026-08-01", "2026-10-13")
DEPLOY_BLOCK = 16496802

RESERVE_STATE = "depositor-balances/reserve-state.csv"
EVENTS = [f"depositor-events/events-usdc-{y}.csv.gz" for y in (2023, 2024, 2025, 2026)]
L1_PANEL = "history-forecasts/l1/run-9b091355/panel-l1.csv.gz"
CASH_FILES = ("raw-logs-usdc-in.csv.gz", "raw-logs-usdc-out.csv.gz", "raw-logs-rdu.csv.gz")
CASH_SHA = {"raw-logs-rdu.csv.gz": "de5eceb0965d71dd705a66b41864f796df62115d5e7728d65f0db84a99595f19",
            "raw-logs-usdc-in.csv.gz": "bdadb6a357f2495e99c9a8f7e51f47af8f7ae8c846521d9dd5185e057c2ff830",
            "raw-logs-usdc-out.csv.gz": "074d31612d4107aec246fc8b65090ed0c2f9a4a86ac474d8f83bedb124d6afc8"}

DECISIONS = [
    "R9-1 cash(t): exact integer USDC.balanceOf(aUSDC) path = sum of USDC Transfers into aUSDC minus out "
    "(aave-pool-cash), anchored so that it equals reserve-state cash at the first snapshot (2023-02-01), as L1. "
    "The anchor offset against a zero balance at aUSDC deployment is reported.",
    "R9-2 supply(t) = scaledSupply(t) x normalizedIncome(t). scaledSupply starts at 0 at aUSDC deployment and "
    "changes at every aUSDC Mint by +rayDiv(value - balanceIncrease, index) and at every Burn by "
    "-rayDiv(value + balanceIncrease, index) (Aave V3 rule; = sign(delta1_raw) x rayDiv(|delta1_raw|, index); "
    "treasury mints included; BalanceTransfer is scaled-neutral). normalizedIncome = rayMul(RAY + rate x dt / "
    "YEAR, liquidityIndex) from the last ReserveDataUpdated (liquidityRate, liquidityIndex, its block ts). The V1 "
    "check uses exact integer arithmetic at each snapshot block; the time path uses floats.",
    "R9-3 states are end-of-transaction (all logs of a tx applied together; ordering block, tx index, log index). "
    "Time weighting treats each state as constant from its block ts to the next distinct ts; for W24 = "
    "(t0 - 24 h, t0] the state in force at t0 - 24 h starts the window and only data with ts <= t0 enters.",
    "R9-4 W24 per origin: time-weighted mean of cash, cash/supply, U = 1 - cash/supply, supply and supply APR "
    "(liquidityRate / 1e27); time-weighted median of cash/supply and of cash; time fraction with cash/supply < "
    "0.5%. Snapshot comparison value = the state after the last transaction with ts < t0 (the reserve-state "
    "snapshot definition; V1 proves equality at every snapshot block).",
    "R9-5 Mint onBehalfOf: the prereg data list says Mint party2 = onBehalfOf; the depositor-events files (G.2 "
    "decoder, PROVENANCE) store onBehalfOf in party1 (party2 = caller). The detector uses onBehalfOf, i.e. party1. "
    "Burn owner = party1 (from); BalanceTransfer out of A = party1 = A. Logged as Deviation D1.",
    "R9-6 QRT withdraw leg: a Burn whose owner A withdraws w = value + balanceIncrease (= -delta1_raw) with "
    "w >= $10M and w >= 0.5% of supply at the end of the previous transaction. Redeposit leg: Mints onBehalfOf A "
    "with value - balanceIncrease > 0, strictly after the Burn (block, tx, log order), ts <= Burn ts + 2 h, summed "
    "in time order until the sum reaches w, stopping at the first BalanceTransfer out of A. Qualifies iff the sum "
    "reaches >= 95% of w. Neutralised = min(w, sum). Burns are processed in time order and each Mint amount is "
    "consumed once (a Mint can be split across consecutive QRTs, never counted twice).",
    "R9-7 QRT completion ts = the ts of the last Mint consumed. Feature rule: a QRT counts for origin t0 iff "
    "completion ts <= t0 + 60 min. Ex-QRT path: cashX = cash + outstanding(t), supplyX = supply + outstanding(t), "
    "where outstanding jumps by the neutralised amount at the Burn's tx and falls by each consumed Mint portion at "
    "its tx (both legs removed from the pool path, as from A's path).",
    "R9-8 drain-role wallet = the hashed unit with the most distinct UTC days carrying a QRT withdraw leg in "
    "2026-07-01 .. 2026-10-13. V2: a day is flagged iff the drain-role unit has a QRT whose withdraw leg falls on "
    "that UTC day; denominator = all 105 days in the range. Other units are named other-NN by total neutralised "
    "volume. Unit ids are stable within this run only; downstream joins use the leg event keys.",
    "R9-9 lock spell: maximal interval with raw cash/supply < 0.5%, gaps shorter than 15 min merged; locked "
    "time = time below the threshold. LOCKk(h) = 1 iff a spell with locked time >= k h intersects (t0, t0 + h] "
    "(spell start < t0 + h and spell end > t0). Origin `open6` = no spell with locked time >= 6 h has start <= t0 "
    "< end. Labels need t0 + h <= the data end (asof block ts).",
    "R9-10 SPIKE6(h): m = W24 time-weighted mean supply APR; SPIKE6 = 1 iff liquidityRate >= 2 m and >= m + 0.03 "
    "holds continuously for >= 1 h within (t0, t0 + h] (runs clipped to the window).",
    "R9-11 checks: (e) pool-input gap = W24 mean cash/supply - snapshot cash/supply, median and P95 (signed and "
    "absolute) by month; a pre-July-2026 month is flagged iff the median absolute gap > 0.02. Pre-drain ex-QRT "
    "neutrality: share of origins before 2026-07-01 with |W24 mean cashX - W24 mean cash| / W24 mean supply > "
    "0.005 must be <= 1%. Expected direction: on origins 2026-07-01 .. 2026-10-13, W24 mean cashX/supplyX > "
    "snapshot cash/supply on >= 90% (primary; the raw W24 mean is reported beside it). (d)1 label checks: LOCK6 "
    "24 h label days 2026-08-01 .. 2026-10-13 <= 5%; each April origin 2026-04-18..20 with uncorrected L1 "
    "LOCK_24h = 1 keeps LOCK6_24h = 1. Refill condition: QRT neutralised volume / all Burn withdrawal volume in "
    "2023-02 .. 2026-06 >= 1% means R7.2c re-estimates the refill regression.",
]


def sha256_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def day_ts(d):
    return int(datetime.strptime(d, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp())


def ts_day(t):
    return datetime.fromtimestamp(int(t), tz=timezone.utc).strftime("%Y-%m-%d")


def ts_iso(t):
    return datetime.fromtimestamp(int(t), tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def ray_div(a, b):
    return (a * RAY + b // 2) // b


def ray_mul(a, b):
    return (a * b + RAY // 2) // RAY


def word(data, i):
    return int(data[2 + 64 * i: 2 + 64 * (i + 1)], 16)


# ---------------------------------------------------------------------------------------------
# pure helpers (tested)
# ---------------------------------------------------------------------------------------------
def step_eval(ts, vals, t):
    """value of a right-continuous step function (ts sorted, unique) at time(s) t; NaN before the first step."""
    k = np.searchsorted(ts, t, side="right") - 1
    out = np.where(k >= 0, vals[np.clip(k, 0, None)], np.nan)
    return out


def window_segments(ts, a, b):
    """indices and durations of the steps covering (a, b]: (idx array, dur array)."""
    i0 = int(np.searchsorted(ts, a, side="right")) - 1
    i1 = int(np.searchsorted(ts, b, side="right"))
    idx = np.arange(max(i0, 0), i1)
    if len(idx) == 0:
        return idx, np.array([], float)
    starts = np.maximum(ts[idx].astype(float), a)
    ends = np.append(ts[idx[1:]].astype(float), b)
    ends = np.minimum(ends, b)
    return idx, np.maximum(ends - starts, 0.0)


def tw_median(v, w):
    o = np.argsort(v, kind="mergesort")
    v, w = v[o], w[o]
    c = np.cumsum(w)
    if c[-1] <= 0:
        return np.nan
    return float(v[int(np.searchsorted(c, 0.5 * c[-1], side="left"))])


def runs_below(ts, below, end_ts, merge_gap):
    """spells of a boolean step function: list of [start, end, locked_seconds] with gaps < merge_gap merged."""
    spells = []
    n = len(ts)
    i = 0
    while i < n:
        if below[i]:
            j = i
            while j + 1 < n and below[j + 1]:
                j += 1
            end = int(ts[j + 1]) if j + 1 < n else int(end_ts)
            dur = end - int(ts[i])
            if spells and int(ts[i]) - spells[-1][1] < merge_gap:
                spells[-1][1] = end
                spells[-1][2] += dur
            else:
                spells.append([int(ts[i]), end, dur])
            i = j + 1
        else:
            i += 1
    return spells


def detect_qrt(burns, unit_events, supply_before):
    """QRT detector (DECISIONS R9-6).

    burns: list of dicts sorted by order key: {key, unit, w (raw int), ts, ...}
    unit_events: unit -> list of (key, ts, kind, amount_raw, ref) sorted by key; kind 'M' (Mint onBehalfOf the
                 unit, amount > 0) or 'T' (BalanceTransfer out of the unit).
    supply_before: callable(burn) -> supply (raw) at the end of the previous transaction.
    Returns QRT dicts {burn, neutral, legs [(ref, take, ts, key)], done_ts}."""
    remaining = {}
    keys_by_unit = {}
    out = []
    for b in burns:
        w = b["w"]
        if w < QRT_MIN_USD * MICRO or w < QRT_MIN_FRAC * supply_before(b):
            continue
        evs = unit_events.get(b["unit"], [])
        keys = keys_by_unit.get(b["unit"])
        if keys is None:
            keys = [e[0] for e in evs]
            keys_by_unit[b["unit"]] = keys
        j = bisect.bisect_right(keys, b["key"])
        total, legs = 0, []
        while j < len(evs) and total < w:
            key, ts, kind, amt, ref = evs[j]
            if ts > b["ts"] + QRT_WINDOW_S or kind == "T":
                break
            avail = remaining.get(ref, amt)
            if avail > 0:
                take = min(avail, w - total)
                legs.append((ref, take, ts, key))
                total += take
            j += 1
        if legs and total >= QRT_FILL * w:
            for ref, take, _, _ in legs:
                amt = remaining.get(ref)
                if amt is None:
                    amt = next(e[3] for e in evs if e[4] == ref)
                remaining[ref] = amt - take
            out.append({"burn": b, "neutral": min(w, total), "legs": legs, "done_ts": legs[-1][2]})
    return out


# ---------------------------------------------------------------------------------------------
# inputs
# ---------------------------------------------------------------------------------------------
def load_reserve_state(datasets):
    rs = pd.read_csv(os.path.join(datasets, RESERVE_STATE), dtype=str)
    rs = rs[rs["reserve"] == "USDC"]
    out = pd.DataFrame({"snapshot": rs["snapshot"].values, "block": rs["block"].astype(np.int64).values,
                        "block_ts": rs["block_ts"].astype(np.int64).values,
                        "supply": [int(x) for x in rs["totalSupply"]], "cash": [int(x) for x in rs["cash"]],
                        "liq_index": [int(x) for x in rs["liquidityIndex"]],
                        "last_update": rs["lastUpdateTimestamp"].astype(np.int64).values})
    return out.sort_values("block").reset_index(drop=True)


def load_logs(cash_dir):
    parts = []
    for f, sign in ((CASH_FILES[0], 1), (CASH_FILES[1], -1)):
        r = pd.read_csv(os.path.join(cash_dir, f), usecols=["block", "ts", "tx_index", "log_index", "data"],
                        dtype={"data": str})
        parts.append(pd.DataFrame({"block": r["block"].astype(np.int64), "ts": r["ts"].astype(np.int64),
                                   "tx_index": r["tx_index"].astype(np.int64),
                                   "log_index": r["log_index"].astype(np.int64),
                                   "dcash": np.array([sign * int(d, 16) for d in r["data"]], dtype=np.int64),
                                   "dscaled": np.int64(0), "is_rdu": False}))
    r = pd.read_csv(os.path.join(cash_dir, CASH_FILES[2]), usecols=["block", "ts", "tx_index", "log_index", "data"],
                    dtype={"data": str})
    rdu = pd.DataFrame({"block": r["block"].astype(np.int64), "ts": r["ts"].astype(np.int64),
                        "tx_index": r["tx_index"].astype(np.int64), "log_index": r["log_index"].astype(np.int64),
                        "liq_rate_int": [word(d, 0) for d in r["data"]],
                        "liq_index_int": [word(d, 3) for d in r["data"]]})
    rdu = rdu.sort_values(["block", "tx_index", "log_index"], kind="mergesort").reset_index(drop=True)
    return parts, rdu


def load_events(datasets, salt):
    cols = ["block", "ts", "tx_hash", "tx_index", "log_index", "type", "party1", "delta1_raw", "index_ray"]
    out = []
    for rel in EVENTS:
        for ch in pd.read_csv(os.path.join(datasets, rel), usecols=cols, dtype={"delta1_raw": str, "index_ray": str,
                                                                               "party1": str, "tx_hash": str},
                              chunksize=1_000_000):
            ch = ch[ch["type"].isin(["Mint", "Burn", "BalanceTransfer"])].copy()
            ch["unit"] = [hashlib.sha256((salt + a.lower()).encode()).hexdigest()[:16] for a in ch["party1"]]
            ch = ch.drop(columns=["party1"])
            out.append(ch)
    ev = pd.concat(out, ignore_index=True)
    ev = ev.sort_values(["block", "tx_index", "log_index"], kind="mergesort").reset_index(drop=True)
    return ev


# ---------------------------------------------------------------------------------------------
# (a) timeline
# ---------------------------------------------------------------------------------------------
def build_timeline(parts, rdu, ev, rs, end_block):
    mb = ev[ev["type"].isin(["Mint", "Burn"]) & ev["delta1_raw"].notna()]
    dsc = []
    for d, ix in zip(mb["delta1_raw"], mb["index_ray"]):
        d = int(d)
        s = ray_div(abs(d), int(ix))
        dsc.append(s if d >= 0 else -s)
    sup_part = pd.DataFrame({"block": mb["block"].astype(np.int64).values, "ts": mb["ts"].astype(np.int64).values,
                             "tx_index": mb["tx_index"].astype(np.int64).values,
                             "log_index": mb["log_index"].astype(np.int64).values, "dcash": np.int64(0),
                             "dscaled": np.array(dsc, dtype=np.int64), "is_rdu": False})
    rdu_part = pd.DataFrame({"block": rdu["block"], "ts": rdu["ts"], "tx_index": rdu["tx_index"],
                             "log_index": rdu["log_index"], "dcash": np.int64(0), "dscaled": np.int64(0),
                             "is_rdu": True})
    lg = pd.concat(parts + [sup_part, rdu_part], ignore_index=True)
    lg = lg[lg["block"] <= end_block]
    lg = lg.sort_values(["block", "tx_index", "log_index"], kind="mergesort").reset_index(drop=True)
    key = lg["block"].to_numpy(np.int64) * 100_000 + lg["tx_index"].to_numpy(np.int64)
    g = lg.groupby(key, sort=True)
    tl = pd.DataFrame({"key": g["block"].first().index.values, "block": g["block"].first().values,
                       "ts": g["ts"].first().values, "dcash": g["dcash"].sum().values,
                       "dscaled": g["dscaled"].sum().values})
    tl["cash_cum"] = np.cumsum(tl["dcash"].to_numpy(np.int64))
    tl["scaled"] = np.cumsum(tl["dscaled"].to_numpy(np.int64))
    # rdu per tx: last in tx, forward filled
    rkey = rdu["block"].to_numpy(np.int64) * 100_000 + rdu["tx_index"].to_numpy(np.int64)
    rlast = rdu.assign(key=rkey).groupby("key", sort=True).last()
    pos = np.searchsorted(rlast.index.values, tl["key"].values, side="right") - 1
    if (pos < 0).any():
        first_ok = int(np.argmax(pos >= 0))
    else:
        first_ok = 0
    pc = np.clip(pos, 0, None)
    rate = np.array([x / RAY for x in rlast["liq_rate_int"].values])[pc]
    idx = np.array([x / RAY for x in rlast["liq_index_int"].values])[pc]
    rts = rlast["ts"].values[pc]
    ni = idx * (1.0 + rate * (tl["ts"].values - rts) / YEAR)
    ni[pos < 0] = 1.0
    rate[pos < 0] = np.nan
    tl["supply_raw_f"] = tl["scaled"].values * ni
    tl["liq_rate"] = rate
    # cash anchor at the first snapshot
    blocks = tl["block"].to_numpy(np.int64)
    k0 = int(np.searchsorted(blocks, int(rs["block"].iloc[0]), side="right")) - 1
    offset = int(rs["cash"].iloc[0]) - (int(tl["cash_cum"].iloc[k0]) if k0 >= 0 else 0)
    tl["cash_raw"] = tl["cash_cum"] + offset
    # V1 at every snapshot block <= end_block
    cash_mism, sup_err = [], []
    rkeys = rlast.index.values
    for _, r in rs.iterrows():
        if int(r["block"]) > end_block:
            continue
        k = int(np.searchsorted(blocks, int(r["block"]), side="right")) - 1
        rec_cash = offset + (int(tl["cash_cum"].iloc[k]) if k >= 0 else 0)
        if rec_cash != int(r["cash"]):
            cash_mism.append({"snapshot": r["snapshot"], "block": int(r["block"]), "recon": rec_cash,
                              "actual": int(r["cash"])})
        sc = int(tl["scaled"].iloc[k]) if k >= 0 else 0
        rk = int(np.searchsorted(rkeys, int(r["block"]) * 100_000 + 99_999, side="right")) - 1
        rrow = rlast.iloc[rk]
        dt = int(r["block_ts"]) - int(rrow["ts"])
        lin = RAY + int(rrow["liq_rate_int"]) * dt // YEAR
        nie = ray_mul(lin, int(rrow["liq_index_int"]))
        rec_sup = ray_mul(sc, nie)
        act = int(r["supply"])
        sup_err.append({"snapshot": r["snapshot"], "block": int(r["block"]), "recon": rec_sup, "actual": act,
                        "rel": (rec_sup - act) / act if act else 0.0,
                        "index_match": int(rrow["liq_index_int"]) == int(r["liq_index"])
                        and int(rrow["ts"]) == int(r["last_update"])})
    tl = tl.drop(columns=["dcash", "dscaled", "cash_cum"])
    return tl, {"cash_anchor_offset_vs_deploy_zero_raw": offset, "cash_mismatches": cash_mism,
                "supply": sup_err, "first_tx_with_rdu": first_ok}


def collapse_ts(tl):
    """last state per distinct ts -> arrays (for time weighting)."""
    last = tl.groupby("ts", sort=True).tail(1)
    return last.reset_index(drop=True)


# ---------------------------------------------------------------------------------------------
# (b) QRT
# ---------------------------------------------------------------------------------------------
def run_qrt(ev, tl):
    ev = ev.reset_index(drop=True)
    okey = list(zip(ev["block"].astype(int), ev["tx_index"].astype(int), ev["log_index"].astype(int)))
    d1 = ev["delta1_raw"]
    unit_events = defaultdict(list)
    burns = []
    types = ev["type"].values
    units = ev["unit"].values
    tss = ev["ts"].astype(int).values
    for i in range(len(ev)):
        t = types[i]
        if t == "Mint":
            if isinstance(d1.iat[i], str) and int(d1.iat[i]) > 0:
                unit_events[units[i]].append((okey[i], int(tss[i]), "M", int(d1.iat[i]), i))
        elif t == "BalanceTransfer":
            unit_events[units[i]].append((okey[i], int(tss[i]), "T", 0, i))
        elif t == "Burn" and isinstance(d1.iat[i], str):
            burns.append({"key": okey[i], "unit": units[i], "w": -int(d1.iat[i]), "ts": int(tss[i]), "i": i})
    tkeys = tl["key"].to_numpy(np.int64)
    sup = tl["supply_raw_f"].to_numpy(float)

    def supply_before(b):
        k = int(np.searchsorted(tkeys, b["key"][0] * 100_000 + b["key"][1], side="left")) - 1
        return sup[k] if k >= 0 else 0.0

    return detect_qrt(burns, unit_events, supply_before), ev


# ---------------------------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--datasets", required=True)
    ap.add_argument("--cash", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    started = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    for f, h in CASH_SHA.items():
        got = sha256_file(os.path.join(a.cash, f))
        if got != h:
            raise SystemExit(f"STOP: {f} sha256 {got} != {h}")
    end_block = 26186746
    salt = secrets.token_hex(32)          # never written
    rs = load_reserve_state(a.datasets)
    print("loading logs", flush=True)
    parts, rdu = load_logs(a.cash)
    ev = load_events(a.datasets, salt)
    end_ts = int(max(ev["ts"].max(), rdu["ts"].max()))
    print("timeline", flush=True)
    tl, v1raw = build_timeline(parts, rdu, ev, rs, end_block)
    end_ts = int(tl["ts"].max())
    del parts
    sup_rel = np.array([abs(x["rel"]) for x in v1raw["supply"]])
    v1 = {"cash_snapshots_checked": len(v1raw["supply"]), "cash_mismatches": len(v1raw["cash_mismatches"]),
          "cash_mismatch_first": v1raw["cash_mismatches"][:5],
          "cash_anchor_offset_vs_deploy_zero_raw": v1raw["cash_anchor_offset_vs_deploy_zero_raw"],
          "supply_snapshots_checked": int(len(sup_rel)), "supply_abs_rel_max": float(sup_rel.max()),
          "supply_abs_rel_median": float(np.median(sup_rel)),
          "supply_exact_matches": int(sum(1 for x in v1raw["supply"] if x["recon"] == x["actual"])),
          "supply_over_tolerance": [x for x in v1raw["supply"] if abs(x["rel"]) > 1e-4][:5],
          "rdu_index_matches_reserve_state": int(sum(1 for x in v1raw["supply"] if x["index_match"])),
          "tolerance_supply": 1e-4}
    v1["PASS"] = v1["cash_mismatches"] == 0 and v1["supply_abs_rel_max"] <= 1e-4
    print("V1", json.dumps({k: v1[k] for k in ("cash_mismatches", "supply_abs_rel_max", "PASS")}), flush=True)
    gates = {"schema": SCHEMA, "prereg": PREREG, "decisions": DECISIONS, "started": started, "V1": v1,
             "end_block": end_block, "end_ts": end_ts, "end_iso": ts_iso(end_ts)}
    if not v1["PASS"]:
        json.dump(gates, open(os.path.join(a.out, "gates-r9.json"), "w"), indent=1, default=str)
        raise SystemExit("STOP: V1 failed (R9.1 stops, reported)")

    # ---------- (b) QRT ----------
    print("qrt", flush=True)
    qrts, ev = run_qrt(ev, tl)
    # roles
    dw0, dw1 = day_ts(DRAIN_WIN[0]), day_ts(DRAIN_WIN[1]) + 86400
    days_by_unit = defaultdict(set)
    vol_by_unit = defaultdict(int)
    for q in qrts:
        b = q["burn"]
        vol_by_unit[b["unit"]] += q["neutral"]
        if dw0 <= b["ts"] < dw1:
            days_by_unit[b["unit"]].add(ts_day(b["ts"]))
    if not days_by_unit:
        drain_unit = None
    else:
        drain_unit = max(days_by_unit, key=lambda u: (len(days_by_unit[u]), vol_by_unit[u]))
    others = sorted([u for u in vol_by_unit if u != drain_unit], key=lambda u: -vol_by_unit[u])
    role = {u: f"other-{i + 1:02d}" for i, u in enumerate(others)}
    if drain_unit:
        role[drain_unit] = "drain-role"
    n_days = (dw1 - dw0) // 86400
    flagged = len(days_by_unit.get(drain_unit, set()))
    v2 = {"window": list(DRAIN_WIN), "days": int(n_days), "drain_role_flagged_days": int(flagged),
          "share": flagged / n_days, "threshold": 0.90,
          "drain_role_unflagged_days": sorted(set(ts_day(dw0 + 86400 * i) for i in range(n_days))
                                              - days_by_unit.get(drain_unit, set())),
          "units_with_qrt_days_in_window": int(len(days_by_unit))}
    v2["PASS"] = v2["share"] >= 0.90
    print("V2", json.dumps({k: v2[k] for k in ("drain_role_flagged_days", "days", "share", "PASS")}), flush=True)

    tx_hash = ev["tx_hash"].values
    qrows, lrows = [], []
    for n, q in enumerate(sorted(qrts, key=lambda q: q["burn"]["key"])):
        b = q["burn"]
        qid = f"q{n + 1:05d}"
        qrows.append({"qrt_id": qid, "unit": role[b["unit"]], "burn_day": ts_day(b["ts"]),
                      "burn_ts": b["ts"], "burn_iso": ts_iso(b["ts"]), "done_ts": q["done_ts"],
                      "done_iso": ts_iso(q["done_ts"]), "duration_s": q["done_ts"] - b["ts"],
                      "w_usd": b["w"] / MICRO, "neutral_usd": q["neutral"] / MICRO, "n_redeposit_legs": len(q["legs"])})
        lrows.append({"qrt_id": qid, "unit": role[b["unit"]], "leg": "withdraw", "event_type": "Burn",
                      "block": b["key"][0], "tx_index": b["key"][1], "log_index": b["key"][2],
                      "tx_hash": tx_hash[b["i"]], "ts": b["ts"], "event_amount_raw": b["w"],
                      "neutral_raw": q["neutral"]})
        for ref, take, ts, key in q["legs"]:
            lrows.append({"qrt_id": qid, "unit": role[b["unit"]], "leg": "redeposit", "event_type": "Mint",
                          "block": key[0], "tx_index": key[1], "log_index": key[2], "tx_hash": tx_hash[ref],
                          "ts": ts, "event_amount_raw": int(ev["delta1_raw"].iat[ref]), "neutral_raw": take})
    qdf = pd.DataFrame(qrows)
    ldf = pd.DataFrame(lrows)
    # trim the last redeposit leg so the neutralised sum equals min(w, sum): already enforced by take
    qdf["month"] = qdf["burn_day"].str[:7]
    by_month = qdf.groupby("month").agg(n=("qrt_id", "size"),
                                        n_drain=("unit", lambda s: int((s == "drain-role").sum())),
                                        neutral_usd=("neutral_usd", "sum")).reset_index()
    qdf["year"] = qdf["burn_day"].str[:4]
    pre = qdf[qdf["burn_day"] < DRAIN_WIN[0]]
    v2["pre_july_neutralised_usd_by_year"] = {y: float(v) for y, v in pre.groupby("year")["neutral_usd"].sum().items()}
    v2["pre_july_count_by_year"] = {y: int(v) for y, v in pre.groupby("year").size().items()}
    v2["pre_july_drain_role_count_by_year"] = {
        y: int(v) for y, v in pre[pre["unit"] == "drain-role"].groupby("year").size().items()}
    v2["drain_role_first_qrt_day"] = qdf.loc[qdf["unit"] == "drain-role", "burn_day"].min() if drain_unit else None
    # refill condition
    bmask = (ev["type"] == "Burn") & ev["delta1_raw"].notna()
    bd = ev.loc[bmask, ["ts", "delta1_raw"]]
    bd = bd[(bd["ts"] >= day_ts(DEV_WIN[0])) & (bd["ts"] < day_ts(DEV_WIN[1]))]
    burn_vol = float(sum(-int(x) for x in bd["delta1_raw"])) / MICRO
    qd = qdf[(qdf["burn_ts"] >= day_ts(DEV_WIN[0])) & (qdf["burn_ts"] < day_ts(DEV_WIN[1]))]
    refill = {"dev_window": ["2023-02", "2026-06"], "qrt_neutralised_usd": float(qd["neutral_usd"].sum()),
              "burn_withdrawal_usd": burn_vol}
    refill["share"] = refill["qrt_neutralised_usd"] / burn_vol
    refill["reestimate_refill"] = refill["share"] >= 0.01

    # ---------- (a) W24 features ----------
    print("w24", flush=True)
    c = collapse_ts(tl)
    T = c["ts"].to_numpy(np.int64)
    CASH = c["cash_raw"].to_numpy(float) / MICRO
    SUP = c["supply_raw_f"].to_numpy(float) / MICRO
    RATE = c["liq_rate"].to_numpy(float)
    RATIO = CASH / SUP
    # QRT outstanding steps (USD)
    qsteps = []
    for q in qrts:
        st = [(q["burn"]["ts"], q["neutral"] / MICRO)] + [(ts, -take / MICRO) for _, take, ts, _ in q["legs"]]
        qsteps.append((q["burn"]["ts"], q["done_ts"], st))
    qb = np.array([s[0] for s in qsteps]) if qsteps else np.array([], np.int64)
    qd_ = np.array([s[1] for s in qsteps]) if qsteps else np.array([], np.int64)

    origins = [ts_day(t) for t in range(day_ts(FIRST_ORIGIN), day_ts(LAST_ORIGIN) + 1, 86400)]
    frows = []
    for d in origins:
        t0 = day_ts(d)
        a0 = t0 - 86400
        idx, dur = window_segments(T, a0, t0)
        if len(idx) == 0 or dur.sum() <= 0:
            continue
        W = dur / dur.sum()
        cash_w, sup_w, ratio_w, rate_w = CASH[idx], SUP[idx], RATIO[idx], RATE[idx]
        kpt = int(np.searchsorted(T, t0, side="left")) - 1     # last state with ts < t0
        row = {"origin": d, "t0": t0,
               "snap_cash": CASH[kpt], "snap_supply": SUP[kpt], "snap_cash_supply": RATIO[kpt],
               "w24_mean_cash": float(W @ cash_w), "w24_median_cash": tw_median(cash_w, dur),
               "w24_mean_supply": float(W @ sup_w), "w24_mean_cash_supply": float(W @ ratio_w),
               "w24_median_cash_supply": tw_median(ratio_w, dur), "w24_mean_util": float(W @ (1 - ratio_w)),
               "w24_frac_below_0p5pct": float(W @ (ratio_w < LOCK_FRAC)),
               "w24_mean_supply_apr": float(np.nansum(W * rate_w) / W[~np.isnan(rate_w)].sum())
               if (~np.isnan(rate_w)).any() else np.nan}
        # ex-QRT: QRTs with done_ts <= t0 + 60 min overlapping the window
        sel = np.where((qb <= t0) & (qd_ > a0) & (qd_ <= t0 + LOOKAHEAD_S))[0] if len(qb) else []
        row["n_qrt_in_w24"] = int(len(sel))
        if len(sel):
            pts = []
            for s in sel:
                pts.extend(qsteps[s][2])
            pts.sort()
            pt = np.array([p[0] for p in pts], dtype=np.int64)
            pdl = np.cumsum([p[1] for p in pts])
            # QRTs whose burn precedes the window start contribute their outstanding at a0
            grid = np.unique(np.concatenate([np.maximum(T[idx], a0), pt[(pt > a0) & (pt <= t0)], [a0]]))
            grid = grid[(grid >= a0) & (grid < t0)]
            gdur = np.diff(np.append(grid, t0)).astype(float)
            kk = np.searchsorted(T, grid, side="right") - 1
            kq = np.searchsorted(pt, grid, side="right") - 1
            adj = np.where(kq >= 0, pdl[np.clip(kq, 0, None)], 0.0)
            cx = CASH[kk] + adj
            sx = SUP[kk] + adj
            rx = cx / sx
            GW = gdur / gdur.sum()
            row.update({"w24x_mean_cash": float(GW @ cx), "w24x_median_cash": tw_median(cx, gdur),
                        "w24x_mean_supply": float(GW @ sx), "w24x_mean_cash_supply": float(GW @ rx),
                        "w24x_median_cash_supply": tw_median(rx, gdur), "w24x_mean_util": float(GW @ (1 - rx)),
                        "w24x_frac_below_0p5pct": float(GW @ (rx < LOCK_FRAC)),
                        "max_outstanding_usd": float(adj.max())})
        else:
            for k in ("mean_cash", "median_cash", "mean_supply", "mean_cash_supply", "median_cash_supply",
                      "mean_util", "frac_below_0p5pct"):
                row["w24x_" + k] = row["w24_" + k]
            row["max_outstanding_usd"] = 0.0
        frows.append(row)
    F = pd.DataFrame(frows)

    # ---------- (c) labels ----------
    print("labels", flush=True)
    spells = runs_below(T, RATIO < LOCK_FRAC, end_ts, MERGE_GAP_S)
    sp = np.array(spells, dtype=np.int64) if spells else np.zeros((0, 3), np.int64)
    lrows2 = []
    for _, r in F.iterrows():
        t0 = int(r["t0"])
        lab = {"origin": r["origin"], "t0": t0}
        for hn, hs in HORIZONS.items():
            cov = t0 + hs <= end_ts
            for k in (LOCK_MIN_H,) + LOCK_SENS_H:
                if not cov:
                    lab[f"LOCK{k}_{hn}"] = np.nan
                    continue
                q = sp[(sp[:, 2] >= k * 3600) & (sp[:, 0] < t0 + hs) & (sp[:, 1] > t0)] if len(sp) else sp
                lab[f"LOCK{k}_{hn}"] = float(len(q) > 0)
            if not cov or np.isnan(r["w24_mean_supply_apr"]):
                lab[f"SPIKE6_{hn}"] = np.nan
                continue
            m = r["w24_mean_supply_apr"]
            idx, dur = window_segments(T, t0, t0 + hs)
            cond = (RATE[idx] >= SPIKE_MULT * m) & (RATE[idx] >= m + SPIKE_ADD)
            best, run = 0.0, 0.0
            for cnd, du in zip(cond, dur):
                run = run + du if cnd else 0.0
                best = max(best, run)
            lab[f"SPIKE6_{hn}"] = float(best >= SPIKE_MIN_S)
            lab[f"spike_longest_run_s_{hn}"] = best
        on = sp[(sp[:, 2] >= LOCK_MIN_H * 3600) & (sp[:, 0] <= t0) & (sp[:, 1] > t0)] if len(sp) else sp
        lab["open6"] = int(len(on) == 0)
        lrows2.append(lab)
    L = pd.DataFrame(lrows2)
    l1 = pd.read_csv(os.path.join(a.datasets, L1_PANEL), usecols=["snapshot", "t0", "LOCK_24h", "SPIKE_24h",
                                                                  "LOCK_7d", "SPIKE_7d"])
    l1 = l1.rename(columns={c_: "L1_" + c_ for c_ in ("LOCK_24h", "SPIKE_24h", "LOCK_7d", "SPIKE_7d")})
    L = L.merge(l1.drop(columns=["snapshot"]), on="t0", how="left")

    # ---------- checks ----------
    print("checks", flush=True)
    F["month"] = F["origin"].str[:7]
    F["gap"] = F["w24_mean_cash_supply"] - F["snap_cash_supply"]
    F["gapx"] = F["w24x_mean_cash_supply"] - F["snap_cash_supply"]
    gap_month = []
    for mth, g in F.groupby("month"):
        gap_month.append({"month": mth, "n": int(len(g)), "median_gap": float(g["gap"].median()),
                          "p95_gap": float(g["gap"].quantile(0.95)),
                          "median_abs_gap": float(g["gap"].abs().median()),
                          "p95_abs_gap": float(g["gap"].abs().quantile(0.95)),
                          "median_abs_gapx": float(g["gapx"].abs().median()),
                          "p95_abs_gapx": float(g["gapx"].abs().quantile(0.95))})
    gm = pd.DataFrame(gap_month)
    pre_flag = gm[(gm["month"] < "2026-07") & (gm["median_abs_gap"] > 0.02)]["month"].tolist()
    preF = F[F["origin"] < DRAIN_WIN[0]]
    dx = (preF["w24x_mean_cash"] - preF["w24_mean_cash"]).abs() / preF["w24_mean_supply"]
    neut = {"origins": int(len(preF)), "n_over_0p5pct": int((dx > 0.005).sum()),
            "share": float((dx > 0.005).mean()), "threshold": 0.01,
            "origins_over": preF.loc[dx > 0.005, "origin"].tolist()}
    neut["PASS"] = neut["share"] <= 0.01
    postF = F[(F["origin"] >= DRAIN_WIN[0]) & (F["origin"] <= DRAIN_WIN[1])]
    direction = {"origins": int(len(postF)),
                 "share_w24x_mean_gt_snapshot": float((postF["w24x_mean_cash_supply"] > postF["snap_cash_supply"]).mean()),
                 "share_w24_raw_mean_gt_snapshot": float((postF["w24_mean_cash_supply"] > postF["snap_cash_supply"]).mean()),
                 "threshold": 0.90}
    direction["PASS"] = direction["share_w24x_mean_gt_snapshot"] >= 0.90
    aug = L[(L["origin"] >= AUG_WIN[0]) & (L["origin"] <= AUG_WIN[1]) & L["LOCK6_24h"].notna()]
    lockdays = {"window": list(AUG_WIN), "origins_with_label": int(len(aug)),
                "lock6_24h_days": int(aug["LOCK6_24h"].sum()), "share": float(aug["LOCK6_24h"].mean()),
                "threshold": 0.05,
                "uncorrected_L1_lock_24h_days": int(aug["L1_LOCK_24h"].fillna(0).sum())}
    lockdays["PASS"] = lockdays["share"] <= 0.05
    apr = L[L["origin"].isin(APRIL_ORIGINS)][["origin", "LOCK6_24h", "L1_LOCK_24h", "LOCK6_7d", "L1_LOCK_7d"]]
    need = apr[apr["L1_LOCK_24h"] == 1]
    april = {"rows": apr.to_dict("records"), "PASS": bool(len(need) > 0 and (need["LOCK6_24h"] == 1).all())}
    sens = {}
    for k in (LOCK_MIN_H,) + LOCK_SENS_H:
        for hn in HORIZONS:
            col = f"LOCK{k}_{hn}"
            s = L[col].dropna()
            sens[col] = {"label_days": int(s.sum()), "origins": int(len(s)),
                         "label_days_by_year": {y: int(v) for y, v in
                                                L.dropna(subset=[col]).groupby(L["origin"].str[:4])[col].sum().items()}}
    for hn in HORIZONS:
        col = f"SPIKE6_{hn}"
        s = L[col].dropna()
        sens[col] = {"label_days": int(s.sum()), "origins": int(len(s)),
                     "label_days_by_year": {y: int(v) for y, v in
                                            L.dropna(subset=[col]).groupby(L["origin"].str[:4])[col].sum().items()}}
        sens["L1_" + col.replace("SPIKE6", "SPIKE")] = {"label_days": int(L["L1_" + col.replace("SPIKE6", "SPIKE")].fillna(0).sum())}
        sens["L1_LOCK_" + hn] = {"label_days": int(L["L1_LOCK_" + hn].fillna(0).sum())}
    sp_out = [{"start": ts_iso(s[0]), "end": ts_iso(s[1]), "locked_h": round(s[2] / 3600, 4),
               "span_h": round((s[1] - s[0]) / 3600, 4)} for s in spells]

    gates.update({
        "V2": v2,
        "qrt_summary": {"n_qrt": int(len(qdf)), "n_drain_role": int((qdf["unit"] == "drain-role").sum()),
                        "n_units": int(qdf["unit"].nunique()),
                        "neutral_usd_total": float(qdf["neutral_usd"].sum()),
                        "drain_role_median_w_usd": float(qdf.loc[qdf["unit"] == "drain-role", "w_usd"].median())
                        if drain_unit else None,
                        "drain_role_median_duration_min": float(
                            qdf.loc[qdf["unit"] == "drain-role", "duration_s"].median() / 60) if drain_unit else None,
                        "by_month": by_month.to_dict("records")},
        "refill_condition": refill,
        "e_pool_input_gap_by_month": gm.to_dict("records"),
        "e_pre_july_months_flagged_median_abs_gap_gt_2pct": pre_flag,
        "e_pre_drain_exqrt_neutrality": neut,
        "e_expected_direction": direction,
        "d1_lock6_label_days_aug_oct": lockdays,
        "d1_april_lock_kept": april,
        "label_counts": sens,
        "n_lock_spells": len(spells),
        "n_lock_spells_ge_6h": int(sum(1 for s in spells if s[2] >= 6 * 3600)),
        "origins": [F["origin"].iloc[0], F["origin"].iloc[-1]], "n_origins": int(len(F)),
    })
    gates["all_pre_use_gates_PASS"] = bool(v1["PASS"] and v2["PASS"])
    gates["input_checks_PASS"] = bool(neut["PASS"] and direction["PASS"] and lockdays["PASS"] and april["PASS"]
                                      and not pre_flag)
    gates["finished"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    F.drop(columns=["month", "gap", "gapx"]).to_csv(os.path.join(a.out, "w24-pool-usdc.csv"), index=False)
    L.to_csv(os.path.join(a.out, "labels-r9-usdc.csv"), index=False)
    qdf.drop(columns=["month", "year"]).to_csv(os.path.join(a.out, "qrt-usdc.csv"), index=False)
    with gzip.open(os.path.join(a.out, "qrt-legs-usdc.csv.gz"), "wt") as f:
        ldf.to_csv(f, index=False)
    json.dump(sp_out, open(os.path.join(a.out, "lock-spells-r9.json"), "w"), indent=1)
    json.dump(gates, open(os.path.join(a.out, "gates-r9.json"), "w"), indent=1, default=str)
    # no-address guard on every output
    import re
    pat = re.compile(r"0x[0-9a-fA-F]{40}(?![0-9a-fA-F])")
    for fn in os.listdir(a.out):
        p = os.path.join(a.out, fn)
        txt = gzip.open(p, "rt").read() if fn.endswith(".gz") else open(p).read()
        if pat.search(txt):
            raise SystemExit(f"STOP: address-like string in {fn}")
    print(json.dumps({"V1": v1["PASS"], "V2": v2["PASS"], "share": v2["share"], "input_checks": gates["input_checks_PASS"]}))


if __name__ == "__main__":
    main()
