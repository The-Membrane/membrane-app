#!/usr/bin/env python3
"""T4 - Do borrowers react to rate spikes? (descriptive; decides whether M2 moves up)

Implements the preregistration `design/VALIDATION_PREREG.md` in triccs/membrane-board at
commit 506e7c5: section "## 0. Rules for every test" and section "## T4" (T4.1 data,
T4.2 positions and exits, T4.3 windows, T4.4 outputs and sensitivities). One run of the
primary computation plus one run of each preregistered sensitivity. No pass line.

Inputs (T4.1, sha256 checked before anything is computed; a mismatch stops the run):
  borrow-repay-churn/borrow_events.csv.gz, borrow-repay-churn/repay_events.csv.gz,
  rate-spike-flows/reserve_history_daily.csv
Excluded by the prereg and never opened here: borrow_repay_churn_exits.csv,
borrow_repay_churn_by_episode.csv, borrow_repay_churn_summary.txt,
spike_episodes_full.csv, spike_episode_summary.csv.

Outputs (in --out): results.json, episodes.csv, daily.csv, PROVENANCE.md.

Usage:
  python3 t4_rate_spike_churn.py --datasets /path/to/membrane-datasets \
      --out /path/to/membrane-datasets/validation/t4

stdlib + numpy only.
"""
import argparse
import bisect
import csv
import datetime as dt
import gzip
import hashlib
import json
import math
import os
import subprocess
import sys
from decimal import Decimal

import numpy as np

# --------------------------------------------------------------------------- constants
PREREG = "triccs/membrane-board design/VALIDATION_PREREG.md @ 506e7c5, section '## T4'"
INPUTS = {
    "borrow_events": ("borrow-repay-churn/borrow_events.csv.gz",
                      "2db3ff80eb62a16d99cb9a4d2a4c322262eb02c0983e9a836cfcd6eb0bde19e7"),
    "repay_events": ("borrow-repay-churn/repay_events.csv.gz",
                     "1d1d95fda66303b591383074b7c681b0f23864940b6b62956cbaa13b78727f1d"),
    "reserve_history_daily": ("rate-spike-flows/reserve_history_daily.csv",
                              "987d87fa0861e8f942e37cb3ebccaf936ec4eed5b000307ac5e6ca20a227dfe4"),
}
RESERVES = ("USDC", "USDT")
MICRO = 10 ** 6                       # USDC/USDT native decimals
FLOOR_PRIMARY = 1_000                 # T4.2 open / pre-repay threshold (native units)
FLOOR_SENS = 10_000                   # T4.4 sensitivity
EXIT_ABS_RESIDUAL = 50                # T4.2 max(50, 1% of pre-repay B)
EXIT_REL_RESIDUAL_DEN = 100           # 1% = 1/100
SPIKE_APY = 0.10                      # T4.3
BUFFER_DAYS = 7                       # T4.3 +/-7
EPISODE_MAX_GAP = 2                   # T4.3 gaps <= 2 days merged
RETURN_DAYS = 90                      # T4.2
APR_WINDOW_DAYS = 90                  # T4.4 item 4
RESERVE_FACTOR = 0.10                 # T4.4 item 4, modelled
N_BOOT = 2000
SEED = 20261012
BLOCK_LEN = 30
WARMUP_START = dt.date(2023, 1, 27)
ANALYSIS_START = dt.date(2023, 3, 1)
ANALYSIS_END = dt.date(2026, 3, 23)
DEPEG_DAY = dt.date(2023, 3, 11)
EPOCH = dt.date(1970, 1, 1)
DAY_S = 86400
BORROW, REPAY = 0, 1                  # tie-break rank: borrow before repay (never needed, see decisions)


def dnum(d):
    """date -> epoch day number"""
    return (d - EPOCH).days


def dstr(n):
    return (EPOCH + dt.timedelta(days=int(n))).isoformat()


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# --------------------------------------------------------------------------- parsing
def parse_id(event_id):
    """`block:txIndex:txhash:logIdx:logIdx2` -> (block, txIndex, txhash, logIdx, logIdx2).

    The chain-order log index is the 4th field (logIdx). See decisions in main()."""
    p = event_id.split(":")
    if len(p) != 5:
        raise ValueError("unexpected id format: %r" % event_id)
    return int(p[0]), int(p[1]), p[2], int(p[3]), int(p[4])


def to_micro(amount_str):
    """Exact native amount -> integer micro-units. Raises if not representable at 6 dp."""
    d = Decimal(amount_str) * MICRO
    i = int(d)
    if d != i:
        raise ValueError("amount not exact at 6 decimals: %r" % amount_str)
    return i


def chain_key(ev):
    """Sort key for chain order: (block, logIdx), then borrow-before-repay, then logIdx2, then id."""
    return (ev["block"], ev["log"], ev["kind"], ev["log2"], ev["id"])


def load_events(paths):
    """Read borrow + repay CSV(.gz) files -> list of event dicts sorted in chain order."""
    evs = []
    for path, kind in paths:
        opener = gzip.open if path.endswith(".gz") else open
        with opener(path, "rt", newline="") as f:
            for row in csv.DictReader(f):
                block, txi, txh, log, log2 = parse_id(row["id"])
                ts = int(row["timestamp"])
                evs.append({
                    "id": row["id"], "block": block, "tx": txi, "txhash": txh, "log": log, "log2": log2,
                    "ts": ts, "day": ts // DAY_S, "user": row["user"].lower(), "reserve": row["reserve"],
                    "amt": to_micro(row["amount_native"]), "kind": BORROW if kind == "borrow" else REPAY,
                })
    evs.sort(key=chain_key)
    return evs


def ordering_diagnostics(evs):
    """Ties on (block, logIdx) and whether timestamps are monotone in chain order."""
    ties_bb = ties_br = ties_rr = 0
    tie_ids = []
    for a, b in zip(evs, evs[1:]):
        if (a["block"], a["log"]) == (b["block"], b["log"]):
            kinds = {a["kind"], b["kind"]}
            if kinds == {BORROW}:
                ties_bb += 1
            elif kinds == {REPAY}:
                ties_rr += 1
            else:
                ties_br += 1
            tie_ids.append([a["id"], b["id"]])
    nonmono_ts = sum(1 for a, b in zip(evs, evs[1:]) if b["ts"] < a["ts"])
    log_ne_log2 = sum(1 for e in evs if e["log"] != e["log2"])
    return {"ties_borrow_borrow": ties_bb, "ties_borrow_repay": ties_br, "ties_repay_repay": ties_rr,
            "tie_id_pairs": tie_ids, "timestamp_inversions_in_chain_order": nonmono_ts,
            "rows_where_logIdx_ne_logIdx2": log_ne_log2}


def load_rates(path):
    """-> {reserve: {epoch_day: apr_pct}} from variable_borrow_pct (nominal APR, %)."""
    out = {r: {} for r in RESERVES}
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            if row["symbol"] not in out:
                continue
            d = dnum(dt.date.fromisoformat(row["date"]))
            if d in out[row["symbol"]]:
                raise ValueError("duplicate rate row %s %s" % (row["symbol"], row["date"]))
            out[row["symbol"]][d] = float(row["variable_borrow_pct"])
    return out


# --------------------------------------------------------------------------- T4.3 windows
def apy_from_apr(apr_pct):
    """T4.1: APY = exp(APR/100) - 1 (per-second compounding)."""
    return math.exp(apr_pct / 100.0) - 1.0


def classify_days(apr_by_day):
    """T4.3. apr_by_day: {epoch_day: apr_pct} for one reserve.

    Spike day d: max(APY(d-1), APY(d)) >= 10%.  Days with no snapshot are never classified.
    Base day d: APY(d-1) < 10% and APY(d) < 10% and no spike day within [d-7, d+7].
    Everything else with a snapshot is 'buffer' (counts in neither).
    Returns {epoch_day: 'spike' | 'base' | 'buffer'}."""
    apy = {d: apy_from_apr(a) for d, a in apr_by_day.items()}
    spike = set()
    for d, y in apy.items():
        vals = [y] + ([apy[d - 1]] if (d - 1) in apy else [])
        if max(vals) >= SPIKE_APY:                                        # <- spike rule
            spike.add(d)
    cls = {}
    for d in apy:
        if d in spike:
            cls[d] = "spike"
            continue
        both_below = apy[d] < SPIKE_APY and apy.get(d - 1, 0.0) < SPIKE_APY
        near_spike = any((d + k) in spike for k in range(-BUFFER_DAYS, BUFFER_DAYS + 1))
        cls[d] = "base" if (both_below and not near_spike) else "buffer"   # <- base rule
    return cls


def build_episodes(spike_days):
    """T4.3: consecutive spike days, merging when the number of non-spike days between two
    successive spike days is <= 2 (i.e. d2 - d1 - 1 <= 2). Returns list of sorted day lists."""
    eps = []
    for d in sorted(spike_days):
        if eps and (d - eps[-1][-1] - 1) <= EPISODE_MAX_GAP:
            eps[-1].append(d)
        else:
            eps.append([d])
    return eps


# --------------------------------------------------------------------------- T4.2 replay
def is_full_exit(pre, post, floor_micro):
    """T4.2 full exit: repay takes B from >= floor to <= max(50, 1% of pre-repay B). Integer micro-units."""
    if pre < floor_micro:
        return False
    # post <= max(50, pre/100)  <=>  100*post <= max(100*50, pre)    (exact in integers)
    return EXIT_REL_RESIDUAL_DEN * post <= max(EXIT_REL_RESIDUAL_DEN * EXIT_ABS_RESIDUAL * MICRO, pre)


def replay(evs, floor, first_day, last_day, count_from_day=None):
    """Replay B <- max(0, B + borrow - repay) per (user, reserve) in chain order.

    Returns (daily, exits, ever_open):
      daily[(reserve, day)] for first_day..last_day: open (count with B >= floor at 00:00Z),
        open_usd (micro, sum of B of those), and exit tallies filled in by attach_returns().
      exits: list of dicts (reserve, user, day, ts, seq, pre, post, sod_open) for every full exit
        on any day <= last_day.
      ever_open: set of positions open at 00:00Z on at least one day in [count_from_day, last_day]."""
    floor_micro = floor * MICRO
    lo = first_day if count_from_day is None else count_from_day
    bal = {}                      # (user, reserve) -> B (micro)
    sod_bal = {}                  # (user, reserve) -> (day, B at 00:00Z of that day)
    last_touch = {}               # (user, reserve) -> last event day
    ever_open = set()
    open_n = {r: 0 for r in RESERVES}
    open_sum = {r: 0 for r in RESERVES}
    daily = {}
    exits = []

    def snapshot(day):
        for r in RESERVES:
            daily[(r, day)] = {"open": open_n[r], "open_usd_micro": open_sum[r]}

    cur = first_day
    snapshot(cur)
    for seq, e in enumerate(evs):
        if e["reserve"] not in open_n:
            continue
        while cur < e["day"] and cur < last_day:
            cur += 1
            snapshot(cur)                                  # B at 00:00Z = after all events with ts < day start
        key = (e["user"], e["reserve"])
        pre = bal.get(key, 0)
        s = sod_bal.get(key)
        if s is None or s[0] != e["day"]:
            sod_bal[key] = (e["day"], pre)                 # first touch of the day -> balance at 00:00Z
            lt = last_touch.get(key)
            # balance `pre` held at 00:00Z on days lt+1 .. e.day
            if lt is not None and pre >= floor_micro and lt + 1 <= last_day and e["day"] >= lo:
                ever_open.add(key)
            last_touch[key] = e["day"]
        if e["kind"] == BORROW:
            post = pre + e["amt"]
        else:
            post = max(0, pre - e["amt"])                  # clip absorbs repaid interest
        bal[key] = post
        r = e["reserve"]
        if pre >= floor_micro:
            open_n[r] -= 1
            open_sum[r] -= pre
        if post >= floor_micro:
            open_n[r] += 1
            open_sum[r] += post
        if e["kind"] == REPAY and e["day"] <= last_day and is_full_exit(pre, post, floor_micro):  # <- exit
            exits.append({"reserve": r, "user": e["user"], "day": e["day"], "ts": e["ts"], "seq": seq,
                          "pre": pre, "post": post, "id": e["id"],
                          "sod_open": sod_bal[key][1] >= floor_micro})
    while cur < last_day:
        cur += 1
        snapshot(cur)
    for key, b in bal.items():
        if b >= floor_micro and last_touch[key] + 1 <= last_day:
            ever_open.add(key)                             # held from last touch onwards
    return daily, exits, ever_open


def borrow_index(evs):
    """(user, reserve) -> (sorted chain seqs of borrows, matching timestamps)."""
    idx = {}
    for seq, e in enumerate(evs):
        if e["kind"] == BORROW:
            s, t = idx.setdefault((e["user"], e["reserve"]), ([], []))
            s.append(seq)
            t.append(e["ts"])
    return idx


def returned(exit_rec, bidx):
    """T4.2 return: any borrow by the same user in the same reserve strictly after the exit in
    chain order with timestamp <= exit ts + 90 days (inclusive)."""
    seqs, tss = bidx.get((exit_rec["user"], exit_rec["reserve"]), ([], []))
    i = bisect.bisect_right(seqs, exit_rec["seq"])                     # first borrow after the exit
    return i < len(seqs) and tss[i] <= exit_rec["ts"] + RETURN_DAYS * DAY_S   # <- return check


def attach_returns(daily, exits, bidx):
    for v in daily.values():
        v.update(exits=0, exits_sod_open=0, nonret_exits=0, nonret_usd_micro=0, ret_exits=0)
    for x in exits:
        x["returned"] = returned(x, bidx)
        v = daily.get((x["reserve"], x["day"]))
        if v is None:
            continue
        v["exits"] += 1
        v["exits_sod_open"] += int(x["sod_open"])
        if x["returned"]:
            v["ret_exits"] += 1
        else:
            v["nonret_exits"] += 1
            v["nonret_usd_micro"] += x["pre"]               # debt that left = pre-exit B


# --------------------------------------------------------------------------- T4.4 outputs
def stats(base, eps):
    """base: dict of summed base-day totals (exits, open, nonret_usd, open_usd).
    eps: dict of per-episode arrays (exits, open, nonret_usd, open_usd, apr_frac)."""
    h_base = base["exits"] / base["open"] if base["open"] > 0 else float("nan")
    u_base = base["nonret_usd"] / base["open_usd"] if base["open_usd"] > 0 else float("nan")
    e_ex, e_op = float(eps["exits"].sum()), float(eps["open"].sum())
    e_nr, e_ou = float(eps["nonret_usd"].sum()), float(eps["open_usd"].sum())
    h_spike = e_ex / e_op if e_op > 0 else float("nan")
    ratio = h_spike / h_base if h_base > 0 else float("nan")
    excess_exits = e_ex - h_base * e_op
    excess_usd = e_nr - u_base * e_ou
    interest = float(((eps["nonret_usd"] - u_base * eps["open_usd"]) * eps["apr_frac"]).sum())
    return {"h_spike": h_spike, "h_base": h_base, "hazard_ratio": ratio,
            "excess_full_exits": excess_exits, "u_base": u_base,
            "gross_nonret_usd_spike": e_nr, "excess_nonret_usd": excess_usd,
            "annualized_interest_lost_usd_per_yr": interest,
            "protocol_share_rf10_modelled_usd_per_yr": RESERVE_FACTOR * interest}


STAT_KEYS = ["h_spike", "h_base", "hazard_ratio", "excess_full_exits", "u_base", "gross_nonret_usd_spike",
             "excess_nonret_usd", "annualized_interest_lost_usd_per_yr", "protocol_share_rf10_modelled_usd_per_yr"]
SUM_KEYS = ["exits", "open", "nonret_usd", "open_usd"]


def take(arrs, idx):
    return {k: v[idx] for k, v in arrs.items()}


def cat(a, b):
    return {k: np.concatenate([a[k], b[k]]) for k in a}


def block_resample_idx(rng, n, L):
    """Moving-block, non-circular: ceil(n/L) blocks of L consecutive base days, starts uniform on [0, n-L]."""
    nb = -(-n // L)
    starts = rng.integers(0, n - L + 1, size=nb)
    return (starts[:, None] + np.arange(L)[None, :]).ravel()[:n]


def _draw(rng, k):
    """k cluster indices with replacement (empty when there are no episodes)."""
    return rng.integers(0, k, size=k) if k > 0 else np.empty(0, dtype=np.int64)


def bootstrap(base_series, ep_arrays, n_boot, seed):
    """Cluster bootstrap (T4.4 CI). Per replicate, rng draws in this order:
    USDC base blocks, USDT base blocks, USDC episodes, USDT episodes, pooled episodes."""
    rng = np.random.default_rng(seed)
    reps = {s: {k: np.empty(n_boot) for k in STAT_KEYS} for s in RESERVES + ("pooled",)}
    pooled_eps = cat(ep_arrays[RESERVES[0]], ep_arrays[RESERVES[1]])
    k_pool = len(pooled_eps["exits"])
    for b in range(n_boot):
        bsum = {}
        for r in RESERVES:
            idx = block_resample_idx(rng, len(base_series[r]["exits"]), BLOCK_LEN)
            bsum[r] = {k: float(base_series[r][k][idx].sum()) for k in SUM_KEYS}
        eidx = {r: _draw(rng, len(ep_arrays[r]["exits"])) for r in RESERVES}
        pidx = _draw(rng, k_pool)
        for r in RESERVES:
            st = stats(bsum[r], take(ep_arrays[r], eidx[r]))
            for k in STAT_KEYS:
                reps[r][k][b] = st[k]
        pbase = {k: bsum[RESERVES[0]][k] + bsum[RESERVES[1]][k] for k in SUM_KEYS}
        st = stats(pbase, take(pooled_eps, pidx))
        for k in STAT_KEYS:
            reps["pooled"][k][b] = st[k]
    return reps


def ci(x):
    x = np.asarray(x, dtype=float)
    fin = x[np.isfinite(x)]
    lo, hi = (np.percentile(fin, [2.5, 97.5]) if len(fin) else (float("nan"), float("nan")))
    return float(lo), float(hi), int(len(x) - len(fin))


def analyze(daily, cls, episodes, apr, drop_episode_ids=()):
    """Point estimates + bootstrap for one run. episodes: {reserve: [ {id, days}, ...]}."""
    a0, a1 = dnum(ANALYSIS_START), dnum(ANALYSIS_END)
    base_series, ep_arrays, ep_rows, fallback = {}, {}, [], []
    counts = {}
    for r in RESERVES:
        base_days = [d for d in range(a0, a1 + 1) if cls[r].get(d) == "base"]
        base_series[r] = {
            "exits": np.array([daily[(r, d)]["exits"] for d in base_days], dtype=float),
            "open": np.array([daily[(r, d)]["open"] for d in base_days], dtype=float),
            "nonret_usd": np.array([daily[(r, d)]["nonret_usd_micro"] / MICRO for d in base_days]),
            "open_usd": np.array([daily[(r, d)]["open_usd_micro"] / MICRO for d in base_days]),
        }
        all_base_apr = [apr[r][d] for d in base_days]
        reserve_median_apr = float(np.median(all_base_apr))
        rows = []
        for ep in episodes[r]:
            if ep["id"] in drop_episode_ids:
                continue
            days = ep["days"]
            end = days[-1]
            win = [apr[r][d] for d in range(end + 1, end + APR_WINDOW_DAYS + 1) if cls[r].get(d) == "base"]
            fb = len(win) == 0
            apr_med = reserve_median_apr if fb else float(np.median(win))
            if fb:
                fallback.append(ep["id"])
            rows.append({
                "reserve": r, "episode_id": ep["id"], "start": dstr(days[0]), "end": dstr(end),
                "n_spike_days": len(days), "span_days": end - days[0] + 1,
                "max_apy_pct": 100 * max(apy_from_apr(apr[r][d]) for d in days if d in apr[r]),
                "contains_2023_03_11": dnum(DEPEG_DAY) in days,
                "exits": sum(daily[(r, d)]["exits"] for d in days),
                "open": sum(daily[(r, d)]["open"] for d in days),
                "nonret_exits": sum(daily[(r, d)]["nonret_exits"] for d in days),
                "nonret_usd": sum(daily[(r, d)]["nonret_usd_micro"] for d in days) / MICRO,
                "open_usd": sum(daily[(r, d)]["open_usd_micro"] for d in days) / MICRO,
                "apr_median_pct_90d_after": apr_med, "n_base_days_in_apr_window": len(win),
                "apr_fallback_whole_period": fb,
            })
        ep_rows.extend(rows)
        ep_arrays[r] = {
            "exits": np.array([x["exits"] for x in rows], dtype=float),
            "open": np.array([x["open"] for x in rows], dtype=float),
            "nonret_usd": np.array([x["nonret_usd"] for x in rows]),
            "open_usd": np.array([x["open_usd"] for x in rows]),
            "apr_frac": np.array([x["apr_median_pct_90d_after"] / 100.0 for x in rows]),
        }
        n_spike = sum(x["n_spike_days"] for x in rows)
        counts[r] = {"n_spike_days": n_spike, "n_base_days": len(base_days), "n_episodes": len(rows),
                     "n_buffer_days": sum(1 for d in range(a0, a1 + 1) if cls[r].get(d) == "buffer"),
                     "n_spike_days_dropped": sum(len(ep["days"]) for ep in episodes[r] if ep["id"] in drop_episode_ids),
                     "reserve_median_base_day_apr_pct_whole_period": reserve_median_apr,
                     "sum_open_position_days_spike": float(ep_arrays[r]["open"].sum()),
                     "sum_open_position_days_base": float(base_series[r]["open"].sum()),
                     "sum_exits_spike": float(ep_arrays[r]["exits"].sum()),
                     "sum_exits_base": float(base_series[r]["exits"].sum()),
                     "sum_nonret_exits_spike": sum(x["nonret_exits"] for x in rows),
                     "sum_open_usd_spike": float(ep_arrays[r]["open_usd"].sum()),
                     "sum_open_usd_base": float(base_series[r]["open_usd"].sum()),
                     "sum_nonret_usd_base": float(base_series[r]["nonret_usd"].sum())}
    counts["pooled"] = {k: counts[RESERVES[0]][k] + counts[RESERVES[1]][k]
                        for k in counts[RESERVES[0]] if k != "reserve_median_base_day_apr_pct_whole_period"}

    def tot(series):
        return {k: float(series[k].sum()) for k in SUM_KEYS}

    point = {r: stats(tot(base_series[r]), ep_arrays[r]) for r in RESERVES}
    pbase = {k: tot(base_series[RESERVES[0]])[k] + tot(base_series[RESERVES[1]])[k] for k in SUM_KEYS}
    pooled_eps = cat(ep_arrays[RESERVES[0]], ep_arrays[RESERVES[1]])
    point["pooled"] = stats(pbase, pooled_eps)

    # per-episode excess (reserve baseline and pooled baseline) for episodes.csv
    for x in ep_rows:
        hb, ub = point[x["reserve"]]["h_base"], point[x["reserve"]]["u_base"]
        x["expected_exits_at_h_base"] = hb * x["open"]
        x["excess_exits"] = x["exits"] - hb * x["open"]
        x["expected_nonret_usd_at_u_base"] = ub * x["open_usd"]
        x["excess_nonret_usd"] = x["nonret_usd"] - ub * x["open_usd"]
        x["interest_lost_usd_per_yr"] = x["excess_nonret_usd"] * x["apr_median_pct_90d_after"] / 100.0
        x["protocol_share_rf10_modelled_usd_per_yr"] = RESERVE_FACTOR * x["interest_lost_usd_per_yr"]
        x["excess_nonret_usd_pooled_baseline"] = x["nonret_usd"] - point["pooled"]["u_base"] * x["open_usd"]
        x["interest_lost_usd_per_yr_pooled_baseline"] = (x["excess_nonret_usd_pooled_baseline"]
                                                         * x["apr_median_pct_90d_after"] / 100.0)

    reps = bootstrap(base_series, ep_arrays, N_BOOT, SEED)
    out = {}
    for s in RESERVES + ("pooled",):
        out[s] = {}
        for k in STAT_KEYS:
            lo, hi, nonfin = ci(reps[s][k])
            out[s][k] = {"point": point[s][k], "ci95_low": lo, "ci95_high": hi}
            if nonfin:
                out[s][k]["nonfinite_replicates"] = nonfin
        out[s]["counts"] = counts[s]
    out["pooled"]["alt_sum_of_reserve_figures_not_primary"] = {
        k: point[RESERVES[0]][k] + point[RESERVES[1]][k]
        for k in ("excess_full_exits", "gross_nonret_usd_spike", "excess_nonret_usd",
                  "annualized_interest_lost_usd_per_yr", "protocol_share_rf10_modelled_usd_per_yr")}
    out["apr_fallback_episodes"] = fallback
    return out, ep_rows


# --------------------------------------------------------------------------- main
DECISIONS = [
    "Log index = 4th colon field of `id` (block:txIndex:txhash:logIdx:logIdx2). 922 borrow rows have logIdx2 != logIdx; "
    "within blocks the 4th field orders consistently with txIndex (0 inversions) while the 5th does not (69), so the 4th is the chain log index.",
    "Chain-order sort key = (block, logIdx, kind [borrow before repay], logIdx2, id). No borrow/repay pair shares (block, logIdx), so the "
    "borrow-before-repay tie-break is never exercised; the only ties are 2 borrow/borrow pairs (see data_notes), whose order cannot change B.",
    "All 555,938 borrow and 418,424 repay rows are used as frozen; no de-duplication (the prereg fixes those counts and specifies none). "
    "Two borrow rows duplicate another row on (block, tx, logIdx, user, reserve, amount), differing only in logIdx2; they are kept.",
    "USD = native units (prereg T4.2: USDC, USDT ~ USD 1). The amount_usd column is not used. Amounts parsed exactly into integer micro-units (6 dp).",
    "Day = UTC calendar date of the block timestamp. Open at start of day d = B >= floor after all events with timestamp < d 00:00:00Z.",
    "Exits on day d = every repay on day d that meets the full-exit definition, whether or not the position was open at 00:00Z (the definition "
    "is event-based). Several full exits by one position on one day each count. daily.csv also shows the subset by positions open at 00:00Z (diagnostic only).",
    "Thresholds inclusive: pre-repay B >= floor; post-repay B <= max(50, 1% of pre-repay B), computed exactly in integers. The 50 residual is fixed in both floor runs; "
    "the 10,000 sensitivity changes the floor in both the open and the pre-repay-B tests.",
    "Return = a borrow (any amount) by the same (user, reserve) strictly after the exit in chain order (later block, or same block with higher logIdx, "
    "including later in the same tx) with timestamp <= exit timestamp + 90*86400 s.",
    "Non-returning USD of an exit = pre-repay B (prereg: 'the debt that left is the pre-exit B').",
    "APY = exp(variable_borrow_pct/100) - 1; spike threshold inclusive (>= 0.10). A reserve's first snapshot day (no d-1) uses APY(d) alone; "
    "this affects no analysis day. Days without a snapshot are never spike days (matters only for d+1..d+7 beyond 2026-03-23).",
    "Base-day buffer checks spike days in [d-7, d+7] using every classified day, including pre-analysis days (Feb 2023).",
    "Episodes are built from analysis-window spike days only. Two successive spike days are merged when the number of non-spike days between them is <= 2 "
    "(d2 - d1 <= 3). Gap days inside an episode are buffer days and contribute nothing to spike sums.",
    "Daily exit hazard ratio = h_spike / h_base. Excess figures per reserve use that reserve's own h_base / u_base.",
    "Pooled = T4.4 formulas applied to the union of both reserves' reserve-days (pooled h_base and u_base). Each episode keeps its own reserve's APR. "
    "The sum of the two per-reserve figures is also shown, labelled not primary.",
    "Interest uses APR (variable_borrow_pct/100), not APY: per episode, numpy median (mean of two middles for even n) of APR on base days in "
    "calendar days end+1..end+90. If none, the reserve's median APR over all analysis-window base days is used and the episode is flagged. "
    "Annualized interest lost = sum over episodes of excess_nonret_usd_e * APR_e (USD/yr); protocol share = 10% of that, modelled.",
    "Bootstrap: per replicate draws in order USDC base blocks, USDT base blocks, USDC episodes, USDT episodes, pooled episodes. Base blocks = 30 consecutive "
    "entries of the reserve's date-ordered base-day series (moving blocks, non-circular, starts uniform on [0, N-30], ceil(N/30) blocks, truncated to N). "
    "Pooled base = the two per-reserve base resamples of the same replicate. Episodes drawn K times with replacement (pooled: K_USDC + K_USDT from the union). "
    "Per-episode APR travels with the episode. 95% interval = numpy.percentile 2.5/97.5 (linear).",
    "Each sensitivity run uses a fresh numpy.random.default_rng(20261012).",
    "Sensitivity 'drop depeg episode': read literally, the USDC episode containing 2023-03-11 is removed from spike sums and episode resampling; its days "
    "do not become base days (base classification unchanged), so h_base / u_base are unchanged and USDT figures equal the primary. "
    "If no USDC episode contains 2023-03-11, nothing is dropped and no other episode is substituted (see depeg_sensitivity_note).",
    "episodes.csv max_apy_pct = max end-of-day APY over the episode's spike days (descriptive only).",
    "Analysis days for both reserves = 2023-03-01..2026-03-23. Exits after 2026-03-23 are not counted; events through 2026-07-23 are used for return checks.",
]


def episode_ids(cls):
    a0, a1 = dnum(ANALYSIS_START), dnum(ANALYSIS_END)
    out = {}
    for r in RESERVES:
        spike = [d for d in range(a0, a1 + 1) if cls[r].get(d) == "spike"]
        out[r] = [{"id": "%s-%02d" % (r, i + 1), "days": days} for i, days in enumerate(build_episodes(spike))]
    return out


def write_daily(path, runs, cls, apr, episodes):
    ep_of = {}
    for r in RESERVES:
        for ep in episodes[r]:
            for d in ep["days"]:
                ep_of[(r, d)] = ep["id"]
    a0, a1 = dnum(ANALYSIS_START), dnum(ANALYSIS_END)
    cols = ["floor", "reserve", "date", "apr_pct", "apy_pct", "class", "episode_id", "open_positions", "open_usd",
            "exits", "exits_by_positions_open_at_0000z", "returning_exits", "nonret_exits", "nonret_usd"]
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(cols)
        for floor, daily in runs:
            for r in RESERVES:
                for d in range(a0, a1 + 1):
                    v = daily[(r, d)]
                    w.writerow([floor, r, dstr(d), "%.4f" % apr[r][d], "%.6f" % (100 * apy_from_apr(apr[r][d])),
                                cls[r][d], ep_of.get((r, d), ""), v["open"], "%.6f" % (v["open_usd_micro"] / MICRO),
                                v["exits"], v["exits_sod_open"], v["ret_exits"], v["nonret_exits"],
                                "%.6f" % (v["nonret_usd_micro"] / MICRO)])


def write_episodes(path, runs):
    cols = ["run", "reserve", "episode_id", "start", "end", "n_spike_days", "span_days", "max_apy_pct",
            "contains_2023_03_11", "open", "open_usd", "exits", "expected_exits_at_h_base", "excess_exits",
            "nonret_exits", "nonret_usd", "expected_nonret_usd_at_u_base", "excess_nonret_usd",
            "apr_median_pct_90d_after", "n_base_days_in_apr_window", "apr_fallback_whole_period",
            "interest_lost_usd_per_yr", "protocol_share_rf10_modelled_usd_per_yr",
            "excess_nonret_usd_pooled_baseline", "interest_lost_usd_per_yr_pooled_baseline"]
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(cols)
        for run, rows in runs:
            for x in rows:
                w.writerow([run] + [("%.6f" % x[c]) if isinstance(x[c], float) else x[c] for c in cols[1:]])


def maybe_gzip(path):
    if os.path.getsize(path) > 50 * 1024 * 1024:
        with open(path, "rb") as fi, gzip.GzipFile(path + ".gz", "wb", compresslevel=9, mtime=0) as fo:
            fo.write(fi.read())
        os.remove(path)
        return path + ".gz"
    return path


def git_info(path):
    d = os.path.dirname(os.path.abspath(path))
    try:
        head = subprocess.run(["git", "-C", d, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
        branch = subprocess.run(["git", "-C", d, "rev-parse", "--abbrev-ref", "HEAD"], capture_output=True, text=True).stdout.strip()
        st = subprocess.run(["git", "-C", d, "status", "--porcelain", "--", os.path.abspath(path)],
                            capture_output=True, text=True).stdout.strip()
        return {"repo_head": head, "branch": branch, "file_status": st or "clean (committed)"}
    except Exception as ex:  # pragma: no cover
        return {"error": str(ex)}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--datasets", default=os.environ.get("MEMBRANE_DATASETS_DIR"), required=False)
    ap.add_argument("--out", required=True)
    args = ap.parse_args(argv)
    if not args.datasets:
        ap.error("--datasets or MEMBRANE_DATASETS_DIR required")
    run_ts = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")

    # T4.1: verify frozen inputs before computing anything
    input_sha = {}
    for name, (rel, want) in INPUTS.items():
        got = sha256_file(os.path.join(args.datasets, rel))
        input_sha[name] = {"path": rel, "sha256": got, "expected": want, "match": got == want}
        if got != want:
            sys.exit("STOP: sha256 mismatch for %s: got %s expected %s" % (rel, got, want))
    print("inputs verified", file=sys.stderr)

    apr = load_rates(os.path.join(args.datasets, INPUTS["reserve_history_daily"][0]))
    cls = {r: classify_days(apr[r]) for r in RESERVES}
    episodes = episode_ids(cls)
    evs = load_events([(os.path.join(args.datasets, INPUTS["borrow_events"][0]), "borrow"),
                       (os.path.join(args.datasets, INPUTS["repay_events"][0]), "repay")])
    diag = ordering_diagnostics(evs)
    if diag["timestamp_inversions_in_chain_order"]:
        sys.exit("STOP: chain order (block, logIdx) disagrees with timestamps; day assignment would be wrong")
    bidx = borrow_index(evs)
    first_day = dnum(WARMUP_START)
    if min(e["day"] for e in evs) < first_day:
        sys.exit("STOP: events before warm-up start")
    a0, a1 = dnum(ANALYSIS_START), dnum(ANALYSIS_END)

    runs = {}
    dailies = {}
    for floor in (FLOOR_PRIMARY, FLOOR_SENS):
        daily, exits, ever = replay(evs, floor, first_day, a1, count_from_day=a0)
        attach_returns(daily, exits, bidx)
        dailies[floor] = (daily, exits, ever)

    depeg = [ep["id"] for ep in episodes["USDC"] if dnum(DEPEG_DAY) in ep["days"]]
    print("running primary", file=sys.stderr)
    runs["primary"] = analyze(dailies[FLOOR_PRIMARY][0], cls, episodes, apr)
    print("running sensitivity: drop depeg episode %s" % depeg, file=sys.stderr)
    runs["sens_drop_usdc_episode_containing_2023_03_11"] = analyze(dailies[FLOOR_PRIMARY][0], cls, episodes, apr,
                                                                   drop_episode_ids=set(depeg))
    print("running sensitivity: floor 10,000", file=sys.stderr)
    runs["sens_floor_10000"] = analyze(dailies[FLOOR_SENS][0], cls, episodes, apr)

    # descriptive n counts
    def pos_counts(floor):
        daily, exits, ever = dailies[floor]
        ex_an = [x for x in exits if a0 <= x["day"] <= a1]
        return {"positions_total_user_reserve_pairs": len({(e["user"], e["reserve"]) for e in evs}),
                "full_exits_analysis_window": len(ex_an),
                "full_exits_analysis_window_by_positions_open_at_0000z": sum(1 for x in ex_an if x["sod_open"]),
                "nonreturning_exits_analysis_window": sum(1 for x in ex_an if not x["returned"]),
                "positions_with_any_exit_in_window": len({(x["user"], x["reserve"]) for x in ex_an}),
                "mean_open_positions_per_analysis_day": {
                    r: float(np.mean([daily[(r, d)]["open"] for d in range(a0, a1 + 1)])) for r in RESERVES}}

    open_ever = {f: len(dailies[f][2]) for f in (FLOOR_PRIMARY, FLOOR_SENS)}

    dup_rows = [p for p in diag["tie_id_pairs"]]
    dup_positions = set()
    id_to_ev = {e["id"]: e for e in evs}
    for a, b in dup_rows:
        dup_positions.add((id_to_ev[a]["user"], id_to_ev[a]["reserve"]))
    dup_exit_counts = {"%s/%s" % k: sum(1 for x in dailies[FLOOR_PRIMARY][1]
                                        if (x["user"], x["reserve"]) == k and a0 <= x["day"] <= a1)
                       for k in sorted(dup_positions)}

    os.makedirs(args.out, exist_ok=True)
    write_daily(os.path.join(args.out, "daily.csv"),
                [(FLOOR_PRIMARY, dailies[FLOOR_PRIMARY][0]), (FLOOR_SENS, dailies[FLOOR_SENS][0])],
                cls, apr, episodes)
    write_episodes(os.path.join(args.out, "episodes.csv"),
                   [("primary", runs["primary"][1]), ("sens_floor_10000", runs["sens_floor_10000"][1])])

    code_path = os.path.abspath(__file__)
    results = {
        "test": "T4 - Do borrowers react to rate spikes? (descriptive; no pass line)",
        "prereg": PREREG,
        "code_path": "The-Membrane/membrane-app scripts/research/validation/t4_rate_spike_churn.py",
        "code_local_path": code_path,
        "code_sha256": sha256_file(code_path),
        "code_git": git_info(code_path),
        "run_timestamp_utc": run_ts,
        "rng": {"generator": "numpy.random.default_rng", "seed": SEED, "n_boot": N_BOOT, "block_len_base_days": BLOCK_LEN,
                "numpy_version": np.__version__, "python_version": sys.version.split()[0]},
        "inputs": input_sha,
        "parameters": {"floor_primary": FLOOR_PRIMARY, "floor_sensitivity": FLOOR_SENS, "exit_residual": "max(50, 1% of pre-repay B)",
                       "spike_apy": SPIKE_APY, "buffer_days": BUFFER_DAYS, "episode_max_gap_days": EPISODE_MAX_GAP,
                       "return_days": RETURN_DAYS, "apr_window_days": APR_WINDOW_DAYS, "reserve_factor_modelled": RESERVE_FACTOR,
                       "warmup_start": WARMUP_START.isoformat(), "analysis_start": ANALYSIS_START.isoformat(),
                       "analysis_end": ANALYSIS_END.isoformat()},
        "units": {"h_spike/h_base": "full exits per open position-day", "u_base": "non-returning USD per open USD-day",
                  "excess_nonret_usd/gross_nonret_usd_spike": "USD (native units)",
                  "annualized_interest_lost_usd_per_yr": "USD per year, gross borrower interest",
                  "protocol_share_rf10_modelled_usd_per_yr": "USD per year at a MODELLED 10% reserve factor (RF history not in data)"},
        "episodes": {r: [{"id": ep["id"], "start": dstr(ep["days"][0]), "end": dstr(ep["days"][-1]),
                          "n_spike_days": len(ep["days"])} for ep in episodes[r]] for r in RESERVES},
        "depeg_episode_dropped_in_sensitivity": depeg,
        "results": {k: v[0] for k, v in runs.items()},
        "n": {"events_borrow": sum(1 for e in evs if e["kind"] == BORROW),
              "events_repay": sum(1 for e in evs if e["kind"] == REPAY),
              "floor_1000": dict(pos_counts(FLOOR_PRIMARY), positions_open_at_0000z_on_any_analysis_day=open_ever[FLOOR_PRIMARY]),
              "floor_10000": dict(pos_counts(FLOOR_SENS), positions_open_at_0000z_on_any_analysis_day=open_ever[FLOOR_SENS])},
        "data_notes": {"ordering": diag, "duplicate_borrow_positions_analysis_window_exits_floor_1000": dup_exit_counts,
                       "txs_with_borrow_and_repay_by_same_user_reserve": sum(
                           1 for _ in _same_tx_borrow_repay(evs))},
        "decisions": DECISIONS,
        "depeg_sensitivity_note": _depeg_note(depeg, cls, apr, episodes),
    }
    with open(os.path.join(args.out, "results.json"), "w") as f:
        json.dump(results, f, indent=2, sort_keys=False, default=_json_default)
        f.write("\n")

    outs = [maybe_gzip(os.path.join(args.out, n)) for n in ("results.json", "episodes.csv", "daily.csv")]
    write_provenance(args, outs, input_sha, results)
    print(json.dumps({k: {s: {m: v[0][s][m]["point"] for m in ("hazard_ratio", "excess_full_exits", "excess_nonret_usd",
                                                                   "annualized_interest_lost_usd_per_yr")}
                          for s in RESERVES + ("pooled",)} for k, v in runs.items()}, indent=1), file=sys.stderr)


def _depeg_note(depeg, cls, apr, episodes):
    d = dnum(DEPEG_DAY)
    holders = [ep["id"] for r in RESERVES for ep in episodes[r] if d in ep["days"]]
    return {"usdc_episode_dropped": depeg,
            "class_on_2023_03_11": {r: cls[r].get(d) for r in RESERVES},
            "apr_pct_2023_03_10_and_11": {r: [apr[r].get(d - 1), apr[r].get(d)] for r in RESERVES},
            "episodes_containing_2023_03_11_any_reserve": holders,
            "note": ("literal reading applied: no USDC episode contains 2023-03-11, so this sensitivity equals the primary; "
                     "the episode(s) containing that date are listed above and were NOT substituted (that would be a deviation)")
            if not depeg else "USDC episode dropped as preregistered"}


def _same_tx_borrow_repay(evs):
    seen = {}
    for e in evs:
        seen.setdefault((e["txhash"], e["user"], e["reserve"]), set()).add(e["kind"])
    for k, v in seen.items():
        if len(v) == 2:
            yield k


def _json_default(o):
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating,)):
        return float(o)
    if isinstance(o, set):
        return sorted(o)
    raise TypeError(type(o))


def write_provenance(args, outs, input_sha, results):
    path = os.path.join(args.out, "PROVENANCE.md")
    lines = [
        "# validation/t4 - provenance",
        "",
        "- **Test:** T4 - Do borrowers react to rate spikes? (descriptive; decides whether M2 moves up). No pass line.",
        "- **Prereg:** %s." % PREREG,
        "- **Builder:** `scripts/research/validation/t4_rate_spike_churn.py` in The-Membrane/membrane-app "
        "(branch `%s`, HEAD `%s`, file status at run: %s), script sha256 `%s`."
        % (results["code_git"].get("branch"), results["code_git"].get("repo_head"),
           results["code_git"].get("file_status"), results["code_sha256"]),
        "- **Run:** %s UTC, Python %s, numpy %s, `default_rng(%d)`, %d bootstrap replicates."
        % (results["run_timestamp_utc"], results["rng"]["python_version"], results["rng"]["numpy_version"], SEED, N_BOOT),
        "- **Command:** `python3 scripts/research/validation/t4_rate_spike_churn.py --datasets $MEMBRANE_DATASETS_DIR "
        "--out $MEMBRANE_DATASETS_DIR/validation/t4`",
        "- **Retrospective.** These are descriptive retrospective figures, not forecasts; no issue timestamp.",
        "",
        "## Inputs (triccs/membrane-datasets, verified before computing)",
        "",
        "| input | path | sha256 |",
        "|---|---|---|",
    ]
    for name, v in input_sha.items():
        lines.append("| %s | `%s` | `%s` |" % (name, v["path"], v["sha256"]))
    lines += ["", "Not read (excluded by the prereg): `borrow_repay_churn_exits.csv`, `borrow_repay_churn_by_episode.csv`, "
              "`borrow_repay_churn_summary.txt`, `spike_episodes_full.csv`, `spike_episode_summary.csv`.", "",
              "## Outputs", "", "| file | bytes | sha256 |", "|---|---:|---|"]
    for p in outs:
        lines.append("| `%s` | %d | `%s` |" % (os.path.basename(p), os.path.getsize(p), sha256_file(p)))
    lines += ["", "`daily.csv` holds one row per (floor, reserve, analysis day) for floors 1,000 (primary) and 10,000 (sensitivity). "
              "`episodes.csv` holds one row per spike episode for the primary run and the floor-10,000 run "
              "(the drop-depeg sensitivity is the primary minus the USDC episode containing 2023-03-11, if any; see "
              "`depeg_sensitivity_note` in results.json).", ""]
    with open(path, "w") as f:
        f.write("\n".join(lines))


if __name__ == "__main__":
    main()
