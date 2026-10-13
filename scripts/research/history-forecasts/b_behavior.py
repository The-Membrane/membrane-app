#!/usr/bin/env python3
"""Q26 workstream B analysis: B1 history, B2 per-address withdrawal hazard, B5 venue aggregation.

Implements membrane-board `design/DEPOSITOR_BEHAVIOR_PREREG.md` sections B.2-B.6 (registered at
membrane-board commit 7a5f8a6, file sha256 e1f9860f...4451) as registered. Every constant below
comes from that file. Changing one is a deviation. Inputs: membrane-datasets `depositor-balances/`
(frozen at 2ca6d16) plus the price, rate-spike and lender-retention files named in INPUTS.

Phases (run in this order, fresh --out to reproduce):
  python3 b_behavior.py --datasets DIR --out DIR --phase dryrun    rows, units, feature coverage per fold
  python3 b_behavior.py --datasets DIR --out DIR --phase run       B1 + B2 fit/score ONCE + B5 -> results.json ...
  python3 b_behavior.py --datasets DIR --out DIR --phase deviation corrected corroboration (DEVIATIONS) -> deviations.json
  python3 b_behavior.py --datasets DIR --out DIR --phase manifest  sha256 of every output -> manifest.json
The dry run computes no exit, episode response, rate or score. The run phase refuses to overwrite an
existing results.json (scored once).

Addresses are public on-chain data. This code attaches no identity, label or name to any address.
Light models only (sklearn logistic + empirical-Bayes shrinkage).
"""
import argparse
import csv
import gzip
import hashlib
import json
import math
import os
import platform
import re
import subprocess
import sys
import time
import warnings
from datetime import datetime, timezone

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from b_acquire import keccak256  # noqa: E402  (pure-python keccak for EIP-55 checksums)

# ---------------------------------------------------------------------------------------------
# Registered constants (prereg B.2-B.5)
# ---------------------------------------------------------------------------------------------
PREREG = {
    "repo": "membrane-board",
    "path": "design/DEPOSITOR_BEHAVIOR_PREREG.md",
    "commit": "7a5f8a6",
    "sha256": "e1f9860f2023818f0aff62ed7a5fbbc8095bd29354d62ad94e10be39ed384451",
}
DATASETS_COMMIT = "2ca6d16"
_DB = "depositor-balances/"
INPUTS = {  # relative path in membrane-datasets -> sha256 (depositor-balances ones also checked vs PROVENANCE)
    "blocks": (_DB + "blocks.csv", "c59020cf9c734416936e75de7182ab4aa116625b0bd7727048fe25cd883e313e"),
    "daily_USDC": (_DB + "daily-balances-usdc.csv.gz",
                   "145bc8abb5ec611f112e29316feff80a0f0975bcbb54a4af6926d581119b0f9d"),
    "daily_USDT": (_DB + "daily-balances-usdt.csv.gz",
                   "23520c27f7570baa4f470dc199ce7c97b9681351fc7a3d85ca86631d0e5498ad"),
    "monthly_USDC": (_DB + "monthly-balances-usdc.csv.gz",
                     "f4b597388ddc017d9f3e1a8f4b1f82a4b043b5e209da544a337f102b4778c603"),
    "monthly_USDT": (_DB + "monthly-balances-usdt.csv.gz",
                     "8418a70e8b44e99366065d5d55316ad683554cb27e2acc51f13b7c36a32e1749"),
    "population": (_DB + "panel-population.csv",
                   "0728ea8d92b7c058ec081608e6c9c4db66ee2e2b932d29bb4d8dc7d358e96cad"),
    "reserve_state": (_DB + "reserve-state.csv",
                      "430532cd3cef4e6f6413b77279940a21fe9cfa7d8e381f49913e8bf56f3a4478"),
    "run_log": (_DB + "run-log.json", "564221ad42de4bc7820b5e8528af22457999968da9e41d27a710ca91291a4cdc"),
    "eth_price": ("price-history/eth-usd-1h.json",
                  "48b53d72351dbba6b05939a75660babc361678304747bf764d59e97d968bd26c"),
    "spikes": ("rate-spike-flows/spike_episodes_full.csv",
               "c83c65a78e8ac410f040c903d6ebcd509001ab85292fa28cde434520421929bf"),
    "lender_flows": ("lender-retention/lender_flows_raw.csv.gz",
                     "1d6bd8df903860311ccf534833d7ed0d76f29a8d6bbc218ede35a8e9324f7ac1"),
}

RESERVES = ("USDC", "USDT")
USD_RAW = 10 ** 6                       # 6 decimals; USDC and USDT counted at $1 (B.1)
MIN_BAL_RAW = 1_000_000 * USD_RAW       # $1,000,000 (B.2 exit, B.3 n, B.4 rows)
EXIT_FRACTION = (1, 2)                  # exit: min(bal) <= 1/2 * bal(d), tested as 2*min <= 1*bal (exact ints)
HORIZONS = (1, 3)                       # B.4 y24 = exit within 1 day, y72 = exit within 3 days
HNAME = {1: "24h", 3: "72h"}
B1_WINDOW = 2                           # B.3 k: min(bal(s+1), bal(s+2)) (>= 50% within 48 h)
E1_BAPR_PCT = 10.0                      # B.3 E1
E2_ABS_LOGRET = 0.08                    # B.3 E2
E3_THRESHOLD = "10"                     # B.3 E3: threshold-10 rows of spike_episodes_full.csv
MERGE_GAP_DAYS = 2                      # B.3: runs with gaps <= 2 days merge
ROW_START = "2023-02-09"                # B.4 first row day
EB_M = 3.0                              # B.4 m
LOGIT_KW = dict(penalty="l2", C=1.0, solver="lbfgs", max_iter=1000)  # B.4 step 1
FOLD_FIRST, FOLD_LAST = (2023, 4), (2026, 3)                         # B.4 rolling origin (12 folds)
BLOCK_DAYS = 30                         # B.4 moving block bootstrap
N_BOOT = 2000
SEED_BLOCK = 20261015
SEED_IID = 20261016
SEED_PB = 20261017                      # B.5 Poisson-binomial
PB_DRAWS = 1000
PB_PCT = 95.0
SEED_UNIT = 20261018                    # DECISION D20: unit-cluster bootstrap (reported only, no registered seed)
REL_BINS = 10
CONC_SHARE = 0.5                        # B.3 concentration flag
CORROB_SHARE = 0.5                      # B.2 corroboration
CORROB_LAST = "2026-03-23"
RV_HOURS = 168
RV_ANNUAL = 8760.0
FEATURES = ("util", "d_util", "bapr", "d_bapr", "rv7", "log10_bal", "log1p_age", "is_usdt")

DECISIONS = [
    "D1 units: balances are raw base units (6 decimals) / 1e6 = USD. util = variableDebt / totalSupply (raw ints, "
    "true division). bAPR = variableBorrowRate_ray / 1e25 (%), sAPR = liquidityRate_ray / 1e25 (%). RF = RF_bps / "
    "1e4. Curve optimal/base/slope1/slope2 = ray / 1e27 (fractions). A reserve row with listed = 0 (USDT before "
    "2023-02-14) has every reserve quantity undefined.",
    "D2 days: daily snapshot t = 0..1344 (2023-02-01..2026-10-07), verified contiguous, so d + j = snapshot t + j. "
    "The asof snapshot (block 26,180,400) is not a daily snapshot: it never enters labels, episodes or B2 rows. It "
    "is used only for the venue view, the concentration flag and the B5 asof numbers.",
    "D3 exit test in exact integers: exit within h at t iff raw(t) >= 1e12 and 2 * min(raw(t+1..t+h)) <= raw(t). "
    "A window holding any non-ok balance (status empty/fail) is unresolved; the count is reported.",
    "D4 ETH(d) = oracle[i-1], i = (T_d - startTs) / 3600 (the hour opening at d - 1h). RV7(d) = sqrt(8760 * "
    "mean(r_j^2)), r_j = ln(oracle[j] / oracle[j-1]), j = i-168..i-1 (169 closes, the last is ETH(d)); a null "
    "close -> undefined.",
    "D5 episodes are built per type: E1, E2 and E3 stress days are merged separately into E1, E2 and E3 episodes "
    "(B.3 counts n and k 'per top address and episode type' and the trigger uses 'E1 or E2 episodes'). No "
    "union-of-rules episode list is built.",
    "D6 merge: two stress days of the same type join one episode when the number of non-stress calendar days "
    "between them is <= 2 (dates differ by <= 3). s = the first stress day; end = the last stress day.",
    "D7 E1 and E2 are evaluated on daily snapshots 2023-02-01..2026-10-07. E1 uses the reserve's own bAPR(d) "
    "(undefined while not listed). E2 = |ln(ETH(d) / ETH(d-1))| >= 0.08 with ETH(d-1) = ETH at T_d - 1 day; it is "
    "the same day list for both reserves and is undefined on 2026-10-07 (the price file's last hour opens "
    "2026-10-06T02:00Z). E3 = the 7 threshold-10 onset dates, both reserves; dates outside the daily range would "
    "be dropped (none are).",
    "D8 B1 response: n counts episodes with a valid bal(s) >= $1M and a resolved 48 h window (s + 2 <= "
    "2026-10-07, both balances ok); k = those with 2 * min(raw(s+1), raw(s+2)) <= raw(s). Episodes left "
    "unresolved by the data end are listed and excluded from n.",
    "D9 exit trigger = the lowest util(s) over the address's counted E1 and E2 episodes with an exit (an E1 and "
    "an E2 episode starting the same day count once per type). With none it reads 'no exit in n episodes', "
    "n = n(E1) + n(E2).",
    "D10 top-20: maximum over the 45 monthly snapshots of status-ok balances in monthly-balances (an address "
    "absent at a snapshot reads 0), cross-checked against panel-population max_monthly_balance_raw (must be "
    "equal). Ties break by address ascending.",
    "D11 concentration flag: the top-1 holder is the P_r address with the largest asof balance (only P_r has asof "
    "balances). Its trigger is computed as in B1, also when it is outside the top-20.",
    "D12 if it left: each top address alone (not cumulative). Curve, RF, supply, cash and debt from the asof "
    "reserve-state row. util' is not capped; supply' <= 0 -> undefined. sAPR' = bAPR' * util' * (1 - RF).",
    "D13 B2 candidate rows with an undefined feature are dropped (dry run reports the count). Only possible on "
    "USDT's first listed day, where util(d-1) and bAPR(d-1) are undefined.",
    "D14 features: util as a fraction, bAPR in %, deltas are one-snapshot differences, RV7 as an annualized "
    "fraction, log10 of the USD balance, natural log(1 + age), age = t - t0 in whole days (t0 = the unit's first "
    "daily snapshot with raw >= 1e12), is_usdt 0/1. Standardized by the training mean and population std "
    "(ddof 0); a zero std is replaced by 1.",
    "D15 logistic exactly as registered: LogisticRegression(penalty='l2', C=1.0, solver='lbfgs', max_iter=1000), "
    "intercept default (on, unpenalized by lbfgs), unweighted. The penalty='l2' FutureWarning is suppressed; "
    "ConvergenceWarnings are counted. logit p0 = decision_function (exact); p = expit(logit p0 + ln theta).",
    "D16 one fit per fold and horizon, pooled over both reserves (is_usdt is a feature). The training set "
    "differs by horizon through the purge d + h <= Q_start.",
    "D17 E_i = sum of the in-sample p0 over unit i's training rows from the same fit; O_i = its training exits. "
    "theta_i = (O_i + 3) / (E_i + 3); a unit with no training rows has theta = 1.",
    "D18 bootstrap: the day set of a horizon = sorted unique test dates pooled over folds and reserves. Block "
    "starts = rng.integers(0, N - 30 + 1, size=(2000, ceil(N/30))) in one call per horizon, blocks concatenated "
    "and truncated to N. Day-level i.i.d. draws = rng.integers(0, N, size=(2000, N)). Order within each "
    "generator: 24 h, then 72 h. Every comparison at a horizon reuses that horizon's draws. CI = numpy.percentile "
    "of finite replicates at [2.5, 97.5] (linear); 'entirely above 0' = lower bound > 0 (strict). Var_iid and "
    "Var_block with ddof = 1.",
    "D19 per-reserve CIs reuse the horizon's day draws restricted to that reserve's rows. Per-fold numbers are "
    "point estimates.",
    "D20 unit-cluster bootstrap (reported only): default_rng(20261018), test units resampled with replacement "
    "rng.integers(0, n_units, size=(2000, n_units)), 24 h then 72 h.",
    "D21 reliability: test rows sorted by p (stable mergesort) and split into 10 near-equal groups "
    "(numpy.array_split). AUC = sklearn roc_auc_score.",
    "D22 corroboration: event_type 'withdraw' rows of the same address and reserve with datetime_utc in "
    "(T_d, T_(d+h)] (UTC), amount_usd summed; corroborated iff sum >= 0.5 * (bal(d) - min bal(d+1..d+h)). Only "
    "exits with d + h <= 2026-03-23. Reported over every B2 row exit and over test-row exits.",
    "D23 B5: f_bar per fold and horizon = mean of 1 - min/bal(d) over that fit's training exits pooled over both "
    "reserves. Predicted exit USD for (reserve, day) = sum p_model * f_bar * bal(d) over its test rows. Realized "
    "= sum over its test-row exits of bal(d) - min bal(d+1..d+h). Ratio of sums = predicted / realized. Spearman "
    "across test days per reserve and horizon (also on the two-reserve daily total). Poisson-binomial: per "
    "(horizon, reserve, day) one rng.random((1000, n_rows)) < p draw, USD = draws @ (f_bar * bal); order 24 h -> "
    "72 h, USDC -> USDT, days ascending; q95 = numpy.percentile(., 95) (linear); exceedance = realized > q95.",
    "D24 B5 asof: a refit on every labelled row (d + h <= 2026-10-07) per horizon gives p0, theta and f_bar. The "
    "asof feature row: util and bAPR from the asof state; d_util and d_bAPR = asof minus the 2026-10-07 snapshot "
    "(a 6.08-day difference, not one day); RV7 from the last 168 hourly returns in the price file (ending "
    "2026-10-06T03:00Z, stale); log10 asof balance; age in fractional days to asof. Units with asof balance >= "
    "$1M. Capacity drop x = min(expected exit USD, cash), then the B.3 if-it-left math. Computed always; "
    "display only if B2 passes.",
    "D25 own-rate baseline: unit training exit fraction (0 allowed); a unit with no training rows takes the "
    "population rate of that fit.",
    "D26 the population-logistic-only predictor is p0 = expit(logit p0) on the test rows of the same fit.",
]

# ---------------------------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------------------------
DAY = 86400


def day_ts(s):
    return int(datetime.strptime(s, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp())


def ts_date(ts):
    return datetime.fromtimestamp(int(ts), timezone.utc).strftime("%Y-%m-%d")


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def to_checksum(addr):
    """EIP-55 checksum address."""
    a = addr.lower()[2:] if addr.lower().startswith("0x") else addr.lower()
    hx = keccak256(a.encode()).hex()
    return "0x" + "".join(c.upper() if c.isalpha() and int(hx[i], 16) >= 8 else c for i, c in enumerate(a))


def trunc(addr):
    cs = to_checksum(addr)
    return f"{cs[:6]}…{cs[-4:]}"


def quarter_start(y, q):
    return f"{y:04d}-{3 * (q - 1) + 1:02d}-01"


def fold_list():
    out = []
    y, q = FOLD_FIRST
    while (y, q) <= FOLD_LAST:
        ny, nq = (y, q + 1) if q < 4 else (y + 1, 1)
        out.append((f"{y}Q{q}", quarter_start(y, q), quarter_start(ny, nq)))
        y, q = ny, nq
    return out


def _clean(o):
    if isinstance(o, dict):
        return {str(k): _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if isinstance(o, np.ndarray):
        return _clean(o.tolist())
    if isinstance(o, np.bool_):
        return bool(o)
    if isinstance(o, np.integer):
        return int(o)
    if isinstance(o, np.floating):
        o = float(o)
    if isinstance(o, float) and not math.isfinite(o):
        return None
    return o


def write_json(path, obj, refuse_overwrite=False):
    if refuse_overwrite and os.path.exists(path):
        raise SystemExit(f"STOP: {path} exists; refusing to overwrite.")
    with open(path, "w") as f:
        json.dump(_clean(obj), f, indent=1, allow_nan=False, ensure_ascii=False)
        f.write("\n")


def code_meta():
    here = os.path.dirname(os.path.abspath(__file__))

    def git(*a):
        try:
            return subprocess.run(["git", "-C", here, *a], capture_output=True, text=True,
                                  timeout=30).stdout.strip() or None
        except Exception:
            return None
    me = os.path.abspath(__file__)
    return {
        "git_head": git("rev-parse", "HEAD"),
        "last_commit_b_behavior": git("log", "-1", "--format=%H", "--", os.path.basename(me)),
        "b_behavior_sha256": sha256_file(me),
        "b_behavior_dirty": bool(git("status", "--porcelain", "--", os.path.basename(me))),
        "python": platform.python_version(),
        "numpy": np.__version__,
        "sklearn": __import__("sklearn").__version__,
        "scipy": __import__("scipy").__version__,
    }


# ---------------------------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------------------------
def verify_inputs(datasets_dir):
    """sha256 of every input vs INPUTS and, for depositor-balances, vs the PROVENANCE table. STOP on mismatch."""
    prov = open(os.path.join(datasets_dir, _DB, "PROVENANCE.md")).read()
    table = dict(re.findall(r"\|\s*`([^`]+)`\s*\|\s*\d+\s*\|\s*`([0-9a-f]{64})`\s*\|", prov))
    out = {}
    for key, (rel, want) in INPUTS.items():
        got = sha256_file(os.path.join(datasets_dir, rel))
        if got != want:
            raise SystemExit(f"STOP: sha256 mismatch for {rel}: {got} != {want}")
        if rel.startswith(_DB):
            pv = table.get(rel[len(_DB):])
            if pv != want:
                raise SystemExit(f"STOP: PROVENANCE sha256 for {rel} is {pv}, expected {want}")
        out[rel] = got
    return out


def load_blocks(path):
    days, T, blk = [], [], []
    asof = None
    with open(path) as f:
        for r in csv.DictReader(f):
            if r["kind"] == "daily":
                days.append(r["snapshot"])
                T.append(int(r["T"]))
                blk.append(int(r["block"]))
            elif r["kind"] == "asof":
                asof = {"block": int(r["block"]), "block_ts": int(r["block_ts"]), "block_utc": r["block_utc"]}
    for i in range(1, len(days)):
        if T[i] - T[i - 1] != DAY or day_ts(days[i]) != T[i]:
            raise SystemExit(f"STOP: daily snapshots not contiguous at {days[i]}")
    return days, np.array(T, dtype=np.int64), blk, asof


def load_reserve_state(path, day_index, D):
    """Per reserve arrays of length D + 1 (daily snapshots, then asof at index D)."""
    keys = ("listed", "supply", "cash", "debt", "util", "bapr", "sapr", "rf", "opt", "base", "slope1", "slope2",
            "has_curve")
    st = {r: {k: np.full(D + 1, np.nan) for k in keys} for r in RESERVES}
    abi = {r: [None] * (D + 1) for r in RESERVES}
    seen = {r: np.zeros(D + 1, bool) for r in RESERVES}
    with open(path) as f:
        for row in csv.DictReader(f):
            r = row["reserve"]
            j = D if row["snapshot"] == "asof" else day_index[row["snapshot"]]
            seen[r][j] = True
            s = st[r]
            listed = row["listed"] == "1"
            s["listed"][j] = 1.0 if listed else 0.0
            abi[r][j] = row["curve_abi"]
            if not listed:
                s["has_curve"][j] = 0.0
                continue
            sup, cash, debt = int(row["totalSupply"]), int(row["cash"]), int(row["variableDebt"])
            s["supply"][j] = sup / USD_RAW
            s["cash"][j] = cash / USD_RAW
            s["debt"][j] = debt / USD_RAW
            s["util"][j] = debt / sup if sup > 0 else np.nan
            s["bapr"][j] = int(row["variableBorrowRate_ray"]) / 10 ** 25
            s["sapr"][j] = int(row["liquidityRate_ray"]) / 10 ** 25
            s["rf"][j] = int(row["RF_bps"]) / 1e4
            if row["curve_abi"] in ("v1", "v2") and row["optimal"] != "":
                s["opt"][j] = int(row["optimal"]) / 10 ** 27
                s["base"][j] = int(row["base"]) / 10 ** 27
                s["slope1"][j] = int(row["slope1"]) / 10 ** 27
                s["slope2"][j] = int(row["slope2"]) / 10 ** 27
                s["has_curve"][j] = 1.0
            else:
                s["has_curve"][j] = 0.0
    for r in RESERVES:
        if not seen[r].all():
            raise SystemExit(f"STOP: reserve-state missing snapshots for {r}")
    return st, abi


def load_daily_balances(path, day_index, D):
    """Long (snapshot,address,balance_raw,status) -> addresses (sorted, lowercase), raw int64 and ok mask of shape
    (n_addr, D + 1); column D = asof."""
    import pandas as pd
    df = pd.read_csv(path, dtype=str, keep_default_na=False)
    addrs, codes = np.unique(df["address"].str.lower().to_numpy(), return_inverse=True)
    col_map = dict(day_index)
    col_map["asof"] = D
    cols = df["snapshot"].map(col_map)
    if cols.isna().any():
        raise SystemExit("STOP: unknown snapshot label in daily balances")
    cols = cols.to_numpy(dtype=np.int64)
    status = df["status"].to_numpy()
    ok = (status == "") | (status == "ok")
    braw = df["balance_raw"].to_numpy()
    ok &= braw != ""
    vals = np.zeros(len(df), dtype=np.int64)
    num = pd.to_numeric(pd.Series(braw[ok]))
    if num.dtype != np.int64:
        raise SystemExit(f"STOP: balance_raw parsed as {num.dtype}, expected int64")
    vals[ok] = num.to_numpy(dtype=np.int64)
    n = len(addrs)
    raw = np.zeros((n, D + 1), dtype=np.int64)
    valid = np.zeros((n, D + 1), dtype=bool)
    filled = np.zeros((n, D + 1), dtype=np.int32)
    np.add.at(filled, (codes, cols), 1)
    if not (filled == 1).all():
        raise SystemExit("STOP: daily balances are not exactly one row per (address, snapshot)")
    raw[codes, cols] = vals
    valid[codes, cols] = ok
    st_counts = {str(k): int(v) for k, v in zip(*np.unique(status, return_counts=True))}
    return list(addrs), raw, valid, st_counts


def load_monthly_max(path):
    import pandas as pd
    df = pd.read_csv(path, dtype=str, keep_default_na=False)
    okm = df["status"] == "ok"
    sub = df[okm]
    vals = pd.to_numeric(sub["balance_raw"]).astype(np.int64)
    mx = vals.groupby(sub["address"].str.lower()).max()
    return {a: int(v) for a, v in mx.items()}, int(df["snapshot"].nunique()), \
        {str(k): int(v) for k, v in df["status"].value_counts().items()}


def load_population(path):
    pop = {r: {} for r in RESERVES}
    with open(path) as f:
        for r in csv.DictReader(f):
            pop[r["reserve"]][r["address"].lower()] = {"rule": r["rule"],
                                                       "max_monthly_raw": int(r["max_monthly_balance_raw"])}
    return pop


def load_eth(path):
    d = json.load(open(path))
    o = np.array([np.nan if v is None else float(v) for v in d["columns"]["oracle"]], dtype=float)
    return int(d["startTs"]), int(d["stepSeconds"]), o


def eth_at(start, o, T):
    """ETH(T) = oracle of the hour opening at T - 1h."""
    if (T - start) % 3600:
        return np.nan
    i = (T - start) // 3600 - 1
    return float(o[i]) if 0 <= i < len(o) else np.nan


def rv7_at(start, o, T):
    """sqrt(8760 * mean(r^2)) over the 168 hourly log returns ending at T (closes oracle[i-169..i-1])."""
    if (T - start) % 3600:
        return np.nan
    i = (T - start) // 3600
    if i - RV_HOURS - 1 < 0 or i - 1 >= len(o):
        return np.nan
    c = o[i - RV_HOURS - 1:i]
    if not np.all(np.isfinite(c)):
        return np.nan
    r = np.diff(np.log(c))
    return float(math.sqrt(RV_ANNUAL * float(np.mean(r * r))))


def load_spike_onsets(path):
    with open(path) as f:
        return sorted({r["onset_date"] for r in csv.DictReader(f) if r["threshold"].strip() == E3_THRESHOLD})


def load_withdrawals(path):
    """(reserve, address) -> (sorted unix ts array, cumulative amount_usd with a leading 0)."""
    import pandas as pd
    df = pd.read_csv(path, dtype={"event_type": str, "datetime_utc": str, "reserve": str, "user_id": str,
                                  "amount_usd": float})
    df = df[df["event_type"] == "withdraw"]
    # DEVIATION 1 (post-score fix): pandas >= 3 parses to datetime64[us], so astype("int64") // 1e9 was not
    # unix seconds. Seconds are now taken as (t - epoch) // 1 s, independent of the datetime resolution.
    dtt = pd.to_datetime(df["datetime_utc"], format="%Y-%m-%d %H:%M:%S", utc=True)
    ts = ((dtt - pd.Timestamp("1970-01-01", tz="UTC")) // pd.Timedelta(seconds=1)).to_numpy(np.int64)
    df = df.assign(ts=ts, addr=df["user_id"].str.lower())
    out = {}
    for (r, a), g in df.groupby(["reserve", "addr"], sort=False):
        g = g.sort_values("ts", kind="mergesort")
        out[(r, a)] = (g["ts"].to_numpy(np.int64), np.concatenate([[0.0], np.cumsum(g["amount_usd"].to_numpy())]))
    return out


def withdraw_sum(wd, reserve, addr, t_lo, t_hi):
    """Sum of withdraw amount_usd with t_lo < ts <= t_hi."""
    v = wd.get((reserve, addr))
    if v is None:
        return 0.0
    ts, cs = v
    return float(cs[np.searchsorted(ts, t_hi, side="right")] - cs[np.searchsorted(ts, t_lo, side="right")])


class Data:
    pass


def load_all(datasets_dir, with_monthly=True):
    t0 = time.time()
    p = lambda k: os.path.join(datasets_dir, INPUTS[k][0])  # noqa: E731
    d = Data()
    d.days, d.T, d.blocks, d.asof = load_blocks(p("blocks"))
    d.D = len(d.days)
    d.day_index = {s: i for i, s in enumerate(d.days)}
    d.state, d.curve_abi = load_reserve_state(p("reserve_state"), d.day_index, d.D)
    d.res = {}
    for r in RESERVES:
        addrs, raw, valid, stc = load_daily_balances(p(f"daily_{r}"), d.day_index, d.D)
        d.res[r] = {"addrs": addrs, "raw": raw, "valid": valid, "status_counts": stc,
                    "aidx": {a: i for i, a in enumerate(addrs)}}
    d.population = load_population(p("population"))
    for r in RESERVES:
        if set(d.population[r]) != set(d.res[r]["addrs"]):
            raise SystemExit(f"STOP: daily-balance addresses differ from panel-population for {r}")
    if with_monthly:
        d.monthly = {}
        for r in RESERVES:
            mx, nsnap, stc = load_monthly_max(p(f"monthly_{r}"))
            d.monthly[r] = {"max": mx, "n_snapshots": nsnap, "status_counts": stc}
    d.eth_start, _, d.oracle = load_eth(p("eth_price"))
    d.eth = np.array([eth_at(d.eth_start, d.oracle, int(T)) for T in d.T])
    d.eth_prev = np.array([eth_at(d.eth_start, d.oracle, int(T) - DAY) for T in d.T])
    d.rv7 = np.array([rv7_at(d.eth_start, d.oracle, int(T)) for T in d.T])
    d.spike_onsets = load_spike_onsets(p("spikes"))
    d.load_s = time.time() - t0
    return d


# ---------------------------------------------------------------------------------------------
# Core definitions (unit-tested on synthetic data)
# ---------------------------------------------------------------------------------------------
def is_exit(bal_raw, min_raw):
    """B.2 exit: bal(d) >= $1M and min(bal(d+1..d+h)) <= 0.5 * bal(d), exact in integer base units."""
    bal_raw = np.asarray(bal_raw, dtype=np.int64)
    min_raw = np.asarray(min_raw, dtype=np.int64)
    num, den = EXIT_FRACTION
    return (bal_raw >= MIN_BAL_RAW) & (den * min_raw <= num * bal_raw)


def window_min(raw, valid, h):
    """For each column t with t + h <= D - 1: min(raw[:, t+1..t+h]) and whether all h entries are ok.
    Columns t > D - 1 - h get min = -1 and ok = False (window past the data)."""
    n, D = raw.shape
    mins = np.full((n, D), -1, dtype=np.int64)
    oks = np.zeros((n, D), dtype=bool)
    L = D - h
    if L <= 0:
        return mins, oks
    m = raw[:, 1:L + 1].copy()
    v = valid[:, 1:L + 1].copy()
    for j in range(2, h + 1):
        m = np.minimum(m, raw[:, j:L + j])
        v &= valid[:, j:L + j]
    mins[:, :L] = m
    oks[:, :L] = v
    return mins, oks


def e2_logret(eth_d, eth_prev):
    return np.abs(np.log(np.asarray(eth_d, float) / np.asarray(eth_prev, float)))


def stress_days(state_r, eth, eth_prev, days, spike_onsets):
    """Per type, sorted daily indices that are stress days (B.3)."""
    with np.errstate(invalid="ignore", divide="ignore"):
        e1 = np.nonzero(np.nan_to_num(state_r["bapr"][:len(days)], nan=-np.inf) >= E1_BAPR_PCT)[0]
        lr = e2_logret(eth, eth_prev)
        e2 = np.nonzero(np.nan_to_num(lr, nan=-np.inf) >= E2_ABS_LOGRET)[0]
    di = {s: i for i, s in enumerate(days)}
    e3 = np.array(sorted(di[s] for s in spike_onsets if s in di), dtype=np.int64)
    return {"E1": [int(x) for x in e1], "E2": [int(x) for x in e2], "E3": [int(x) for x in e3]}


def merge_episodes(stress_idx, gap=MERGE_GAP_DAYS):
    """Sorted stress-day indices -> [(start, end, n_stress_days)]. Two stress days join one episode when the
    number of non-stress days between them is <= gap (B.3, D6)."""
    eps = []
    for t in sorted(set(int(x) for x in stress_idx)):
        if eps and t - eps[-1][1] - 1 <= gap:
            eps[-1][1] = t
            eps[-1][2] += 1
        else:
            eps.append([t, t, 1])
    return [tuple(e) for e in eps]


def episode_response(raw_row, valid_row, s, last_t):
    """B.3 per episode start s: (eligible, resolved, exit). eligible = ok bal(s) >= $1M; resolved = s + 2 <=
    last_t with ok balances; exit = 2 * min(bal(s+1), bal(s+2)) <= bal(s)."""
    eligible = bool(valid_row[s] and raw_row[s] >= MIN_BAL_RAW)
    if not eligible:
        return False, False, False
    if s + B1_WINDOW > last_t or not all(valid_row[s + j] for j in range(1, B1_WINDOW + 1)):
        return True, False, False
    mn = min(int(raw_row[s + j]) for j in range(1, B1_WINDOW + 1))
    return True, True, bool(is_exit(raw_row[s], mn))


def exit_trigger(ep_rows):
    """B.3 trigger: lowest util(s) among counted E1/E2 episodes with an exit. ep_rows: dicts with keys type,
    counted, exit, util_s, start."""
    counted = [e for e in ep_rows if e["type"] in ("E1", "E2") and e["counted"]]
    exits = [e for e in counted if e["exit"]]
    if not exits:
        return None, f"no exit in {len(counted)} episodes"
    best = min(exits, key=lambda e: (e["util_s"], e["start"], e["type"]))
    return best, f"exit trigger util {100 * best['util_s']:.2f}% ({best['type']} episode starting {best['start']})"


def borrow_rate_curve(u, opt, base, s1, s2):
    """Aave kinked curve, all as fractions."""
    if not math.isfinite(u):
        return float("nan")
    if u <= opt:
        return base + s1 * u / opt
    return base + s1 + s2 * (u - opt) / (1.0 - opt)


def if_it_left(bal, cash, supply, debt, curve, rf):
    """B.3 'if it left': x = min(bal, cash); supply' = supply - x; cash' = cash - x; util' = debt / supply';
    bAPR' from the curve; sAPR' = bAPR' * util' * (1 - RF). APRs in %."""
    x = min(bal, cash)
    supply2 = supply - x
    cash2 = cash - x
    util2 = debt / supply2 if supply2 > 0 else float("nan")
    b = borrow_rate_curve(util2, curve["opt"], curve["base"], curve["slope1"], curve["slope2"])
    s = b * util2 * (1.0 - rf)
    return {"x": x, "supply_after": supply2, "cash_after": cash2, "util_after": util2,
            "bapr_after_pct": 100.0 * b, "sapr_after_pct": 100.0 * s, "stuck": bal - x}


def train_mask(t, h, qs):
    """B.4 label purge: training rows have d + h <= Q_start."""
    return np.asarray(t) + h <= qs


def test_mask(t, qs, qe):
    t = np.asarray(t)
    return (t >= qs) & (t < qe)


def eb_theta(O, E, m=EB_M):
    """B.4 gamma-Poisson partial pooling: theta = (O + m) / (E + m); O = E = 0 gives 1."""
    return (np.asarray(O, float) + m) / (np.asarray(E, float) + m)


def own_rate(O, n, pop):
    """Unit training exit fraction; units with no training rows take the population rate."""
    O = np.asarray(O, float)
    n = np.asarray(n, float)
    return np.where(n > 0, O / np.maximum(n, 1.0), pop)


def block_bootstrap_indices(rng, n_days, block, n_rep):
    """Moving block bootstrap, non-circular: starts uniform on 0..n_days-block, ceil(n_days/block) blocks per
    replicate (one rng.integers call of shape (n_rep, n_blocks)), concatenated and truncated to n_days."""
    if n_days < block:
        raise ValueError(f"n_days={n_days} < block={block}")
    n_blocks = math.ceil(n_days / block)
    starts = rng.integers(0, n_days - block + 1, size=(n_rep, n_blocks))
    idx = (starts[:, :, None] + np.arange(block)[None, None, :]).reshape(n_rep, n_blocks * block)
    return idx[:, :n_days]


def replicate_counts(idx, n):
    n_rep = idx.shape[0]
    flat = (idx + np.arange(n_rep)[:, None] * n).ravel()
    return np.bincount(flat, minlength=n_rep * n).reshape(n_rep, n).astype(float)


def draw_days(n_days_by_h, n_rep=N_BOOT, block=BLOCK_DAYS, seed_block=SEED_BLOCK, seed_iid=SEED_IID):
    """Registered draw order: 24 h then 72 h from one block generator and one i.i.d. generator."""
    rb, ri = np.random.default_rng(seed_block), np.random.default_rng(seed_iid)
    out = {}
    for h in HORIZONS:
        n = n_days_by_h[h]
        out[h] = (block_bootstrap_indices(rb, n, block, n_rep), block_bootstrap_indices(ri, n, 1, n_rep))
    return out


def bss_stats(day_pos, n_days, p_m, p_b, y, counts_blk, counts_iid):
    """Point BSS = 1 - B_m / B_b; 95% percentile CI over block replicates; n_eff_boot = N * Var_iid / Var_block."""
    p_m, p_b, y = (np.asarray(v, float) for v in (p_m, p_b, y))
    se_m = np.bincount(day_pos, weights=(p_m - y) ** 2, minlength=n_days)
    se_b = np.bincount(day_pos, weights=(p_b - y) ** 2, minlength=n_days)
    n = len(y)
    out = {"n_rows": int(n), "brier_model": float(se_m.sum() / n) if n else None,
           "brier_base": float(se_b.sum() / n) if n else None,
           "bss": float(1.0 - se_m.sum() / se_b.sum()) if se_b.sum() > 0 else None}
    with np.errstate(divide="ignore", invalid="ignore"):
        reps = 1.0 - (counts_blk @ se_m) / (counts_blk @ se_b)
        reps_i = 1.0 - (counts_iid @ se_m) / (counts_iid @ se_b)
    fin, fin_i = np.isfinite(reps), np.isfinite(reps_i)
    out["n_nonfinite_reps"] = int((~fin).sum())
    if fin.sum() > 1:
        lo, hi = np.percentile(reps[fin], [2.5, 97.5])
        vb = float(np.var(reps[fin], ddof=1))
        vi = float(np.var(reps_i[fin_i], ddof=1)) if fin_i.sum() > 1 else None
        out.update(ci95=[float(lo), float(hi)], ci_above_0=bool(lo > 0), ci_below_0=bool(hi < 0),
                   var_block=vb, var_iid=vi,
                   n_eff_boot=float(n_days * vi / vb) if (vi is not None and vb > 0) else None)
    else:
        out.update(ci95=None, ci_above_0=False, ci_below_0=False, var_block=None, var_iid=None, n_eff_boot=None)
    return out


def reliability(p, y, nbins=REL_BINS):
    p = np.asarray(p, float)
    y = np.asarray(y, float)
    order = np.argsort(p, kind="mergesort")
    out = []
    for g in np.array_split(order, nbins):
        if len(g):
            out.append({"n": int(len(g)), "p_mean": float(p[g].mean()), "y_mean": float(y[g].mean()),
                        "p_min": float(p[g].min()), "p_max": float(p[g].max())})
    return out


def auc(y, p):
    from sklearn.metrics import roc_auc_score
    y = np.asarray(y)
    if y.min() == y.max():
        return None
    return float(roc_auc_score(y, p))


def pb_exceed(rng, p, w, realized, n_draws=PB_DRAWS, pct=PB_PCT):
    """One Poisson-binomial simulation for a day: draws (n_draws, n) < p, USD = draws @ w; returns (q, exceed)."""
    u = rng.random((n_draws, len(p)))
    usd = (u < np.asarray(p)[None, :]).astype(float) @ np.asarray(w, float)
    q = float(np.percentile(usd, pct))
    return q, bool(realized > q)


# ---------------------------------------------------------------------------------------------
# B2 rows and features
# ---------------------------------------------------------------------------------------------
def first_big_day(raw, valid, D):
    big = valid[:, :D] & (raw[:, :D] >= MIN_BAL_RAW)
    return np.where(big.any(axis=1), big.argmax(axis=1), -1)


def build_rows(d):
    """Every candidate row (unit, d) of B.4 with features, labels and the drop data. Returns dict of arrays;
    'feat_ok' marks rows whose features are all defined (D13)."""
    D = d.D
    t_start = d.day_index[ROW_START]
    t_last = D - 1 - max(HORIZONS)
    tmask = np.zeros(D, bool)
    tmask[t_start:t_last + 1] = True
    tmask &= np.isfinite(d.eth)
    parts = []
    base = 0
    d.unit_base = {}
    for ri, r in enumerate(RESERVES):
        R = d.res[r]
        raw, valid = R["raw"][:, :D], R["valid"][:, :D]
        st = d.state[r]
        util, bapr = st["util"][:D], st["bapr"][:D]
        cand = valid & (raw >= MIN_BAL_RAW) & tmask[None, :]
        a, t = np.nonzero(cand)
        t0 = first_big_day(R["raw"], R["valid"], D)
        bal = raw[a, t]
        X = np.column_stack([
            util[t], util[t] - util[t - 1], bapr[t], bapr[t] - bapr[t - 1], d.rv7[t],
            np.log10(bal / USD_RAW), np.log1p((t - t0[a]).astype(float)), np.full(len(t), float(ri)),
        ])
        part = {"unit": base + a, "reserve": np.full(len(t), ri, np.int8), "a": a, "t": t, "bal_raw": bal, "X": X}
        for h in HORIZONS:
            mins, oks = window_min(raw, valid, h)
            mn, ok = mins[a, t], oks[a, t]
            part[f"min{h}"] = mn
            part[f"res{h}"] = ok
            part[f"y{h}"] = (is_exit(bal, mn) & ok).astype(np.int8)
        d.unit_base[r] = base
        base += len(R["addrs"])
        parts.append(part)
    rows = {k: np.concatenate([p[k] for p in parts]) for k in parts[0]}
    rows["feat_ok"] = np.all(np.isfinite(rows["X"]), axis=1)
    d.n_units_total = base
    d.unit_addr = [a for r in RESERVES for a in d.res[r]["addrs"]]
    d.unit_res = [r for r in RESERVES for _ in d.res[r]["addrs"]]
    return rows


def unit_name(d, u):
    return d.unit_addr[u], d.unit_res[u]


# ---------------------------------------------------------------------------------------------
# B2 fit
# ---------------------------------------------------------------------------------------------
def fit_population(X, y):
    from sklearn.exceptions import ConvergenceWarning
    from sklearn.linear_model import LogisticRegression
    mu = X.mean(axis=0)
    sd = X.std(axis=0)
    sd = np.where(sd > 0, sd, 1.0)
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter("always")
        warnings.filterwarnings("ignore", category=FutureWarning)
        clf = LogisticRegression(**LOGIT_KW).fit((X - mu) / sd, y)
    nconv = sum(1 for x in w if issubclass(x.category, ConvergenceWarning))
    return {"mu": mu, "sd": sd, "clf": clf, "n_convergence_warnings": nconv}


def decision(fit, X):
    return fit["clf"].decision_function((X - fit["mu"]) / fit["sd"])


def fit_unit_model(rows, tr, h, n_units):
    """Population logistic + EB theta + baselines + f_bar on training rows tr (boolean mask)."""
    from scipy.special import expit
    X, y, u = rows["X"][tr], rows[f"y{h}"][tr].astype(float), rows["unit"][tr]
    if y.min() == y.max():
        raise SystemExit("STOP: a training set holds a single class")
    fit = fit_population(X, y)
    p0 = expit(decision(fit, X))
    O = np.bincount(u, weights=y, minlength=n_units)
    E = np.bincount(u, weights=p0, minlength=n_units)
    n = np.bincount(u, minlength=n_units)
    theta = eb_theta(O, E)
    pop = float(y.mean())
    own = own_rate(O, n, pop)
    bal = rows["bal_raw"][tr]
    mn = rows[f"min{h}"][tr]
    ex = y == 1
    fbar = float(np.mean(1.0 - mn[ex] / bal[ex])) if ex.any() else float("nan")
    info = {"n_train_rows": int(len(y)), "n_train_units": int((n > 0).sum()), "n_train_exits": int(y.sum()),
            "pop_rate": pop, "f_bar": fbar, "coef_std": fit["clf"].coef_[0].tolist(),
            "intercept": float(fit["clf"].intercept_[0]), "mu": fit["mu"].tolist(), "sd": fit["sd"].tolist(),
            "n_iter": int(np.max(fit["clf"].n_iter_)), "n_convergence_warnings": fit["n_convergence_warnings"],
            "sum_E_minus_O": float(E.sum() - O.sum())}
    return {"fit": fit, "theta": theta, "own": own, "pop": pop, "fbar": fbar, "n_train": n, "info": info}


def predict_unit_model(model, X, u):
    from scipy.special import expit
    z = decision(model["fit"], X)
    return expit(z + np.log(model["theta"][u])), expit(z), model["own"][u], np.full(len(u), model["pop"])


# ---------------------------------------------------------------------------------------------
# Dry run
# ---------------------------------------------------------------------------------------------
def phase_dryrun(datasets_dir, out_dir, log=print):
    t0 = time.time()
    shas = verify_inputs(datasets_dir)
    d = load_all(datasets_dir, with_monthly=False)
    return dryrun_on(d, shas, out_dir, t0, log)


def dryrun_on(d, shas, out_dir, t0, log=print):
    rows = build_rows(d)
    ok = rows["feat_ok"]
    folds = fold_list()
    out = {"phase": "dryrun", "note": "rows, units and feature coverage only; no exit counts, no rates, no score",
           "prereg": PREREG, "inputs_sha256": shas, "code": code_meta(),
           "days": {"first": d.days[0], "last": d.days[-1], "n": d.D, "asof": d.asof},
           "panel_population": {r: len(d.res[r]["addrs"]) for r in RESERVES},
           "daily_status_counts": {r: d.res[r]["status_counts"] for r in RESERVES},
           "candidate_rows": int(len(ok)), "rows_kept": int(ok.sum()), "rows_dropped_undefined_feature": int((~ok).sum()),
           "dropped_by_feature": {f: int((~np.isfinite(rows["X"][:, j])).sum()) for j, f in enumerate(FEATURES)},
           "unresolved_labels": {HNAME[h]: int((~rows[f"res{h}"][ok]).sum()) for h in HORIZONS},
           "units_with_rows": {r: int(len(np.unique(rows["unit"][ok & (rows["reserve"] == i)])))
                               for i, r in enumerate(RESERVES)},
           "row_day_range": [d.days[int(rows["t"][ok].min())], d.days[int(rows["t"][ok].max())]],
           "curve_days_missing_while_listed": {
               r: int(((d.state[r]["listed"] == 1) & (d.state[r]["has_curve"] != 1)).sum()) for r in RESERVES},
           "folds": []}
    for name, qs_s, qe_s in folds:
        qs, qe = d.day_index[qs_s], d.day_index[qe_s]
        fo = {"fold": name, "q_start": qs_s, "q_end": qe_s}
        te_c = test_mask(rows["t"], qs, qe)
        fo["feature_coverage_test"] = {f: float(np.isfinite(rows["X"][te_c, j]).mean()) if te_c.any() else None
                                       for j, f in enumerate(FEATURES)}
        for h in HORIZONS:
            tr = train_mask(rows["t"], h, qs) & ok & rows[f"res{h}"]
            te = te_c & ok & rows[f"res{h}"]
            tr_c = train_mask(rows["t"], h, qs)
            fo[HNAME[h]] = {
                "train_rows": int(tr.sum()), "train_units": int(len(np.unique(rows["unit"][tr]))),
                "test_rows": int(te.sum()), "test_units": int(len(np.unique(rows["unit"][te]))),
                "test_days": int(len(np.unique(rows["t"][te]))),
                "test_units_without_train_rows": int(len(np.setdiff1d(np.unique(rows["unit"][te]),
                                                                      np.unique(rows["unit"][tr])))),
                "by_reserve": {r: {"train_rows": int((tr & (rows["reserve"] == i)).sum()),
                                   "test_rows": int((te & (rows["reserve"] == i)).sum())}
                               for i, r in enumerate(RESERVES)},
                "feature_coverage_train": {f: float(np.isfinite(rows["X"][tr_c, j]).mean()) if tr_c.any() else None
                                           for j, f in enumerate(FEATURES)},
            }
        out["folds"].append(fo)
    out["runtime_s"] = time.time() - t0
    write_json(os.path.join(out_dir, "dryrun.json"), out)
    log(f"dryrun: {out['rows_kept']} rows kept of {out['candidate_rows']} -> {out_dir}/dryrun.json")
    return out


# ---------------------------------------------------------------------------------------------
# B1
# ---------------------------------------------------------------------------------------------
TYPE_PHRASE = {
    "E1": "when borrow APR ≥ 10%",
    "E2": "when ETH moved ≥ 8% in a day (|ln ETH(d)/ETH(d-1)| ≥ 0.08)",
    "E3": "at a 10% rate-spike onset (rate-spike-flows threshold 10)",
}


def b1_episodes(d):
    out = {}
    for r in RESERVES:
        sd = stress_days(d.state[r], d.eth, d.eth_prev, d.days, d.spike_onsets)
        st = d.state[r]
        out[r] = {}
        for ty in ("E1", "E2", "E3"):
            eps = []
            for s, e, n in merge_episodes(sd[ty]):
                eps.append({"type": ty, "start": d.days[s], "end": d.days[e], "s": s, "n_stress_days": n,
                            "bapr_s_pct": st["bapr"][s], "sapr_s_pct": st["sapr"][s], "util_s": st["util"][s]})
            out[r][ty] = eps
        out[r]["_n_stress_days"] = {ty: len(sd[ty]) for ty in sd}
    return out


def b1_address(d, r, addr, eps_r):
    R = d.res[r]
    i = R["aidx"][addr]
    raw, valid = R["raw"][i], R["valid"][i]
    last_t = d.D - 1
    rows, per_type = [], {}
    for ty in ("E1", "E2", "E3"):
        n = k = unres = 0
        dates, exit_dates, detail = [], [], []
        for ep in eps_r[ty]:
            el, res, ex = episode_response(raw, valid, ep["s"], last_t)
            if el and not res:
                unres += 1
            counted = el and res
            row = {"type": ty, "start": ep["start"], "counted": counted, "exit": bool(ex and counted),
                   "util_s": ep["util_s"], "bapr_s_pct": ep["bapr_s_pct"], "sapr_s_pct": ep["sapr_s_pct"],
                   "bal_s": raw[ep["s"]] / USD_RAW if valid[ep["s"]] else None}
            if counted:
                n += 1
                k += int(ex)
                dates.append(ep["start"])
                if ex:
                    exit_dates.append(ep["start"])
                b1 = raw[ep["s"] + 1] / USD_RAW
                b2 = raw[ep["s"] + 2] / USD_RAW
                detail.append({**{kk: row[kk] for kk in ("start", "exit", "util_s", "bapr_s_pct", "sapr_s_pct",
                                                          "bal_s")}, "bal_s1": b1, "bal_s2": b2})
            rows.append(row)
        per_type[ty] = {"n": n, "k": k, "unresolved": unres, "episode_dates": dates, "exit_dates": exit_dates,
                        "episodes": detail,
                        "statement": f"withdrew ≥ 50% within 48 h in {k} of {n} episodes {TYPE_PHRASE[ty]}"
                                     + (f" (exits: {', '.join(exit_dates)})" if exit_dates else "")}
    trig, text = exit_trigger(rows)
    return per_type, trig, text


def venue_state(d, r):
    s = d.state[r]
    j = d.D
    curve = {k: float(s[k][j]) for k in ("opt", "base", "slope1", "slope2")}
    return {"util": float(s["util"][j]), "bapr_pct": float(s["bapr"][j]), "sapr_pct": float(s["sapr"][j]),
            "cash": float(s["cash"][j]), "supply": float(s["supply"][j]), "debt": float(s["debt"][j]),
            "rf": float(s["rf"][j]), "curve": curve, "curve_abi": d.curve_abi[r][j],
            "bapr_from_curve_at_util_pct": 100.0 * borrow_rate_curve(float(s["util"][j]), **{
                "opt": curve["opt"], "base": curve["base"], "s1": curve["slope1"], "s2": curve["slope2"]})}


def run_b1(d, log=print):
    eps = b1_episodes(d)
    res = {"episodes": {}, "top20": {}, "venue_view": {}, "concentration": {}, "top20_check": {}}
    top_rows_csv = []
    venue = {"asof": d.asof, "reserves": {}}
    for r in RESERVES:
        res["episodes"][r] = {ty: [{k: v for k, v in e.items() if k != "s"} for e in eps[r][ty]]
                              for ty in ("E1", "E2", "E3")}
        res["episodes"][r]["n_stress_days"] = eps[r]["_n_stress_days"]
        mx = d.monthly[r]["max"]
        cand = sorted(d.res[r]["addrs"], key=lambda a: (-mx.get(a, 0), a))
        top = cand[:20]
        mism = [a for a in d.res[r]["addrs"] if mx.get(a, 0) != d.population[r][a]["max_monthly_raw"]]
        res["top20_check"][r] = {"monthly_vs_population_mismatches": len(mism),
                                 "n_monthly_snapshots": d.monthly[r]["n_snapshots"],
                                 "monthly_status_counts": d.monthly[r]["status_counts"],
                                 "rank20_max_usd": mx.get(top[-1], 0) / USD_RAW,
                                 "rank21_max_usd": mx.get(cand[20], 0) / USD_RAW if len(cand) > 20 else None}
        vs = venue_state(d, r)
        R = d.res[r]
        asof_bal = R["raw"][:, d.D] / USD_RAW
        asof_ok = R["valid"][:, d.D]
        table = []
        for rank, a in enumerate(top, 1):
            per_type, trig, text = b1_address(d, r, a, eps[r])
            i = R["aidx"][a]
            bal = float(asof_bal[i]) if asof_ok[i] else float("nan")
            left = if_it_left(bal, vs["cash"], vs["supply"], vs["debt"], vs["curve"], vs["rf"])
            row = {"rank": rank, "address": to_checksum(a), "address_short": trunc(a),
                   "max_monthly_balance_usd": mx.get(a, 0) / USD_RAW, "rule": d.population[r][a]["rule"],
                   "per_type": per_type,
                   "exit_trigger": None if trig is None else {"util": trig["util_s"], "type": trig["type"],
                                                              "start": trig["start"]},
                   "exit_trigger_text": text,
                   "asof_balance_usd": bal, "asof_share_of_supply": bal / vs["supply"],
                   "util_ge_trigger": None if trig is None else bool(vs["util"] >= trig["util_s"]),
                   "if_it_left": left}
            table.append(row)
            top_rows_csv.append([r, rank, row["address"], row["max_monthly_balance_usd"], bal,
                                 row["asof_share_of_supply"],
                                 *[per_type[t][x] for t in ("E1", "E2", "E3") for x in ("n", "k")],
                                 "" if trig is None else trig["util_s"], "" if trig is None else trig["type"],
                                 "" if trig is None else trig["start"], text,
                                 "" if trig is None else row["util_ge_trigger"],
                                 left["x"], left["util_after"], left["bapr_after_pct"], left["sapr_after_pct"],
                                 left["stuck"]])
        res["top20"][r] = table
        # concentration flag (top-1 asof holder in P_r)
        bal_for_rank = np.where(asof_ok, asof_bal, -np.inf)
        order = sorted(range(len(R["addrs"])), key=lambda i: (-bal_for_rank[i], R["addrs"][i]))
        i1 = order[0]
        a1 = R["addrs"][i1]
        _, trig1, text1 = b1_address(d, r, a1, eps[r])
        share1 = float(asof_bal[i1]) / vs["supply"]
        flag = share1 >= CONC_SHARE
        timed = bool(flag and trig1 is not None and vs["util"] >= trig1["util_s"])
        res["concentration"][r] = {
            "top1_address": to_checksum(a1), "top1_address_short": trunc(a1), "top1_in_top20": a1 in top,
            "top1_balance_usd": float(asof_bal[i1]), "top1_share": share1, "flag": bool(flag),
            "top1_exit_trigger": None if trig1 is None else trig1["util_s"], "top1_exit_trigger_text": text1,
            "util_now": vs["util"], "timed_warning": timed,
            "statement": (f"concentration flag {'ON' if flag else 'off'} (top-1 share {100 * share1:.1f}% "
                          f"{'>=' if flag else '<'} 50%); timed warning {'FIRES' if timed else 'does not fire'}")}
        venue["reserves"][r] = {**vs, "top20": [
            {"rank": t["rank"], "address": t["address"], "address_short": t["address_short"],
             "balance_usd": t["asof_balance_usd"], "share_of_supply": t["asof_share_of_supply"],
             "exit_trigger": t["exit_trigger"], "exit_trigger_text": t["exit_trigger_text"],
             "util_ge_trigger": t["util_ge_trigger"], "if_it_left": t["if_it_left"]} for t in table],
            "concentration": res["concentration"][r]}
    res["venue_view"] = venue
    return res, top_rows_csv, eps


# ---------------------------------------------------------------------------------------------
# B2 + B5 run
# ---------------------------------------------------------------------------------------------
def run_b2(d, rows, log=print):
    ok = rows["feat_ok"]
    folds = fold_list()
    n_units = d.n_units_total
    preds = {h: [] for h in HORIZONS}
    fold_info = {h: [] for h in HORIZONS}
    for name, qs_s, qe_s in folds:
        qs, qe = d.day_index[qs_s], d.day_index[qe_s]
        for h in HORIZONS:
            tr = train_mask(rows["t"], h, qs) & ok & rows[f"res{h}"]
            te = test_mask(rows["t"], qs, qe) & ok & rows[f"res{h}"]
            model = fit_unit_model(rows, tr, h, n_units)
            idx = np.nonzero(te)[0]
            pm, p0, po, pp = predict_unit_model(model, rows["X"][idx], rows["unit"][idx])
            preds[h].append({"idx": idx, "p_model": pm, "p_pop_logit": p0, "p_own": po, "p_pop": pp,
                             "fold": name, "fbar": model["fbar"],
                             "has_train": model["n_train"][rows["unit"][idx]] > 0})
            fold_info[h].append({"fold": name, **model["info"]})
            log(f"  fit {name} {HNAME[h]}: {model['info']['n_train_rows']} train rows, {len(idx)} test rows")
    P = {}
    for h in HORIZONS:
        cat = lambda k: np.concatenate([x[k] for x in preds[h]])  # noqa: E731
        idx = cat("idx")
        P[h] = {"idx": idx, "p_model": cat("p_model"), "p_pop_logit": cat("p_pop_logit"), "p_own": cat("p_own"),
                "p_pop": cat("p_pop"), "has_train": cat("has_train"),
                "fold": np.concatenate([[x["fold"]] * len(x["idx"]) for x in preds[h]]),
                "fbar": np.concatenate([np.full(len(x["idx"]), x["fbar"]) for x in preds[h]]),
                "y": rows[f"y{h}"][idx].astype(float), "t": rows["t"][idx], "unit": rows["unit"][idx],
                "reserve": rows["reserve"][idx]}
    return P, fold_info


COMPARISONS = (("model_vs_own", "p_model", "p_own"), ("model_vs_pop", "p_model", "p_pop"),
               ("pop_logit_vs_own", "p_pop_logit", "p_own"), ("pop_logit_vs_pop", "p_pop_logit", "p_pop"),
               ("model_vs_pop_logit", "p_model", "p_pop_logit"))
DECIDING = ("model_vs_own", "model_vs_pop")


def score_b2(d, rows, P, fold_info, wd, log=print):
    days_by_h = {h: np.unique(P[h]["t"]) for h in HORIZONS}
    draws = draw_days({h: len(days_by_h[h]) for h in HORIZONS})
    out = {"horizons": {}}
    cells = {}
    rng_u = np.random.default_rng(SEED_UNIT)
    for h in HORIZONS:
        Q = P[h]
        days = days_by_h[h]
        pos = np.searchsorted(days, Q["t"])
        nd = len(days)
        blk, iid = draws[h]
        cb, ci = replicate_counts(blk, nd), replicate_counts(iid, nd)
        H = {"n": {"rows": int(len(Q["y"])), "days": int(nd), "units": int(len(np.unique(Q["unit"]))),
                   "exits": int(Q["y"].sum()), "units_without_train_rows": int(len(np.unique(Q["unit"][~Q["has_train"]]))),
                   "rows_without_train_rows": int((~Q["has_train"]).sum())},
             "brier": {k: float(np.mean((Q[k] - Q["y"]) ** 2)) for k in ("p_model", "p_own", "p_pop", "p_pop_logit")},
             "bss": {}}
        for cname, a, b in COMPARISONS:
            H["bss"][cname] = bss_stats(pos, nd, Q[a], Q[b], Q["y"], cb, ci)
        H["n"]["n_eff_boot"] = {c: H["bss"][c]["n_eff_boot"] for c in H["bss"]}
        for c in DECIDING:
            cells[(c, h)] = H["bss"][c]["ci_above_0"]
        # per reserve (reuses the horizon's draws)
        H["per_reserve"] = {}
        for ri, r in enumerate(RESERVES):
            m = Q["reserve"] == ri
            H["per_reserve"][r] = {"n_rows": int(m.sum()), "n_units": int(len(np.unique(Q["unit"][m]))),
                                   "n_exits": int(Q["y"][m].sum()),
                                   "n_days": int(len(np.unique(Q["t"][m]))),
                                   "brier": {k: float(np.mean((Q[k][m] - Q["y"][m]) ** 2))
                                             for k in ("p_model", "p_own", "p_pop", "p_pop_logit")},
                                   "bss": {c: bss_stats(pos[m], nd, Q[a][m], Q[b][m], Q["y"][m], cb, ci)
                                           for c, a, b in COMPARISONS}}
        # per fold (point)
        H["per_fold"] = []
        for fi in fold_info[h]:
            m = Q["fold"] == fi["fold"]
            br = {k: float(np.mean((Q[k][m] - Q["y"][m]) ** 2)) for k in ("p_model", "p_own", "p_pop", "p_pop_logit")}
            H["per_fold"].append({
                "fold": fi["fold"], "n_rows": int(m.sum()), "n_units": int(len(np.unique(Q["unit"][m]))),
                "n_exits": int(Q["y"][m].sum()), "n_days": int(len(np.unique(Q["t"][m]))), "brier": br,
                "bss": {c: (1 - br[a] / br[b]) if br[b] > 0 else None for c, a, b in COMPARISONS},
                "fit": fi})
        H["auc"] = {k: auc(Q["y"], Q[k]) for k in ("p_model", "p_pop_logit", "p_own")}
        H["reliability"] = {k: reliability(Q[k], Q["y"]) for k in ("p_model", "p_pop_logit")}
        # unit-cluster bootstrap (reported only)
        units, upos = np.unique(Q["unit"], return_inverse=True)
        nu = len(units)
        uidx = rng_u.integers(0, nu, size=(N_BOOT, nu))
        cu = replicate_counts(uidx, nu)
        H["unit_cluster"] = {}
        for cname, a, b in COMPARISONS:
            se_m = np.bincount(upos, weights=(Q[a] - Q["y"]) ** 2, minlength=nu)
            se_b = np.bincount(upos, weights=(Q[b] - Q["y"]) ** 2, minlength=nu)
            with np.errstate(divide="ignore", invalid="ignore"):
                reps = 1.0 - (cu @ se_m) / (cu @ se_b)
            fin = np.isfinite(reps)
            lo, hi = np.percentile(reps[fin], [2.5, 97.5])
            H["unit_cluster"][cname] = {"ci95": [float(lo), float(hi)], "n_units": int(nu),
                                        "n_nonfinite": int((~fin).sum())}
        # corroboration
        H["corroboration"] = corroboration(d, rows, h, Q["idx"], wd)
        out["horizons"][HNAME[h]] = H
    failing = [f"{c} {HNAME[h]}" for (c, h), v in cells.items() if not v]
    out["cells"] = {f"{c} {HNAME[h]}": v for (c, h), v in cells.items()}
    out["verdict"] = "PASS" if not failing else "FAIL"
    out["failing_cells"] = failing
    out["pass_rule"] = ("PASS iff the 95% block-bootstrap CI of BSS lies entirely above 0 against BOTH baselines "
                        "(own rate, population rate) at BOTH horizons")
    return out


def corroboration(d, rows, h, test_idx, wd):
    last = d.day_index[CORROB_LAST]
    ok = rows["feat_ok"] & rows[f"res{h}"]
    ex = np.nonzero(ok & (rows[f"y{h}"] == 1) & (rows["t"] + h <= last))[0]
    tset = set(int(i) for i in test_idx)
    n_all = c_all = n_te = c_te = 0
    for i in ex:
        addr, r = unit_name(d, int(rows["unit"][i]))
        t = int(rows["t"][i])
        drop = (int(rows["bal_raw"][i]) - int(rows[f"min{h}"][i])) / USD_RAW
        w = withdraw_sum(wd, r, addr, int(d.T[t]), int(d.T[t + h]))
        c = w >= CORROB_SHARE * drop
        n_all += 1
        c_all += int(c)
        if int(i) in tset:
            n_te += 1
            c_te += int(c)
    return {"all_rows": {"n_exits": n_all, "n_corroborated": c_all, "share": c_all / n_all if n_all else None},
            "test_rows": {"n_exits": n_te, "n_corroborated": c_te, "share": c_te / n_te if n_te else None},
            "window": f"exits with d + h <= {CORROB_LAST}"}


def run_b5(d, rows, P, b2_verdict, log=print):
    from scipy.stats import spearmanr
    rng = np.random.default_rng(SEED_PB)
    out = {"backtest": {}, "asof": {}}
    for h in HORIZONS:
        Q = P[h]
        bal = rows["bal_raw"][Q["idx"]] / USD_RAW
        drop = (rows["bal_raw"][Q["idx"]] - rows[f"min{h}"][Q["idx"]]) / USD_RAW
        realized_row = np.where(Q["y"] == 1, drop, 0.0)
        w = Q["fbar"] * bal
        pred_row = Q["p_model"] * w
        H = {}
        tot = {}
        for ri, r in enumerate(RESERVES):
            m = np.nonzero(Q["reserve"] == ri)[0]
            order = m[np.argsort(Q["t"][m], kind="mergesort")]
            tt = Q["t"][order]
            days, starts = np.unique(tt, return_index=True)
            ends = np.append(starts[1:], len(tt))
            pred_d, real_d, q_d, exc = [], [], [], 0
            for dd, s0, s1 in zip(days, starts, ends):
                sel = order[s0:s1]
                pr, rl = float(pred_row[sel].sum()), float(realized_row[sel].sum())
                q, e = pb_exceed(rng, Q["p_model"][sel], w[sel], rl)
                pred_d.append(pr)
                real_d.append(rl)
                q_d.append(q)
                exc += int(e)
                tot.setdefault(int(dd), [0.0, 0.0])
                tot[int(dd)][0] += pr
                tot[int(dd)][1] += rl
            pred_d, real_d = np.array(pred_d), np.array(real_d)
            rho = spearmanr(pred_d, real_d)
            H[r] = {"n_days": int(len(days)), "sum_predicted_usd": float(pred_d.sum()),
                    "sum_realized_usd": float(real_d.sum()),
                    "ratio_pred_over_realized": float(pred_d.sum() / real_d.sum()) if real_d.sum() > 0 else None,
                    "spearman_rho": float(rho.statistic), "spearman_p": float(rho.pvalue),
                    "exceedances_over_q95": exc, "expected_exceedances_at_5pct": 0.05 * len(days),
                    "days_with_realized_exit": int((real_d > 0).sum())}
        tk = sorted(tot)
        tp = np.array([tot[k][0] for k in tk])
        tr_ = np.array([tot[k][1] for k in tk])
        rho = spearmanr(tp, tr_)
        H["both"] = {"n_days": len(tk), "sum_predicted_usd": float(tp.sum()), "sum_realized_usd": float(tr_.sum()),
                     "ratio_pred_over_realized": float(tp.sum() / tr_.sum()) if tr_.sum() > 0 else None,
                     "spearman_rho": float(rho.statistic), "spearman_p": float(rho.pvalue)}
        out["backtest"][HNAME[h]] = H
    out["asof"] = b5_asof(d, rows, b2_verdict)
    return out


def asof_features(d):
    """D24 feature rows at asof for units with asof balance >= $1M. Returns (units, X, bal_usd, reserve)."""
    units, X, bals, res_ = [], [], [], []
    rv_last = rv7_at(d.eth_start, d.oracle, d.eth_start + 3600 * len(d.oracle))
    for ri, r in enumerate(RESERVES):
        R = d.res[r]
        st = d.state[r]
        j, jl = d.D, d.D - 1
        raw = R["raw"][:, j]
        okk = R["valid"][:, j] & (raw >= MIN_BAL_RAW)
        t0 = first_big_day(R["raw"], R["valid"], d.D)
        for a in np.nonzero(okk)[0]:
            age = (d.asof["block_ts"] - int(d.T[t0[a]])) / DAY if t0[a] >= 0 else 0.0
            X.append([st["util"][j], st["util"][j] - st["util"][jl], st["bapr"][j], st["bapr"][j] - st["bapr"][jl],
                      rv_last, math.log10(raw[a] / USD_RAW), math.log1p(age), float(ri)])
            units.append(d.unit_base[r] + a)
            bals.append(raw[a] / USD_RAW)
            res_.append(ri)
    return np.array(units, dtype=np.int64), np.array(X, float), np.array(bals), np.array(res_), rv_last


def b5_asof(d, rows, b2_verdict):
    units, X, bals, rs, rv_last = asof_features(d)
    ok = rows["feat_ok"]
    out = {"display": b2_verdict == "PASS",
           "note": "computed always; shown only if B2 passes (B.5). Feature row per D24 (stale RV7, 6-day deltas).",
           "rv7_used": rv_last, "horizons": {}}
    for h in HORIZONS:
        tr = ok & rows[f"res{h}"] & (rows["t"] + h <= d.D - 1)
        model = fit_unit_model(rows, tr, h, d.n_units_total)
        pm, p0, _, _ = predict_unit_model(model, X, units)
        H = {"fit": model["info"], "reserves": {}}
        for ri, r in enumerate(RESERVES):
            m = rs == ri
            vs = venue_state(d, r)
            E = float(np.sum(pm[m] * model["fbar"] * bals[m]))
            after = if_it_left(E, vs["cash"], vs["supply"], vs["debt"], vs["curve"], vs["rf"])
            H["reserves"][r] = {"n_units": int(m.sum()), "expected_exit_usd": E,
                                "expected_exit_usd_pop_logit_only": float(np.sum(p0[m] * model["fbar"] * bals[m])),
                                "mean_p_model": float(pm[m].mean()) if m.any() else None,
                                "util_before": vs["util"], "bapr_before_pct": vs["bapr_pct"],
                                "sapr_before_pct": vs["sapr_pct"], "after": after}
        out["horizons"][HNAME[h]] = H
    return out


# ---------------------------------------------------------------------------------------------
# Run phase
# ---------------------------------------------------------------------------------------------
def write_predictions(path, d, rows, P):
    lines = ["unit,reserve,d,h,y,p_model,p_own,p_pop,p_pop_logit,fold"]
    for h in HORIZONS:
        Q = P[h]
        order = np.lexsort((Q["t"], Q["unit"]))
        for i in order:
            addr, r = unit_name(d, int(Q["unit"][i]))
            lines.append(f"{addr},{r},{d.days[int(Q['t'][i])]},{HNAME[h]},{int(Q['y'][i])},{Q['p_model'][i]:.10g},"
                         f"{Q['p_own'][i]:.10g},{Q['p_pop'][i]:.10g},{Q['p_pop_logit'][i]:.10g},{Q['fold'][i]}")
    with gzip.open(path, "wt", compresslevel=9) as f:
        f.write("\n".join(lines) + "\n")


def write_csv(path, header, rows_):
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(header)
        for r in rows_:
            w.writerow(["" if (isinstance(x, float) and not math.isfinite(x)) else x for x in r])


def phase_run(datasets_dir, out_dir, log=print):
    results_path = os.path.join(out_dir, "results.json")
    if os.path.exists(results_path):
        raise SystemExit(f"STOP: {results_path} exists; the score phase runs once and never overwrites.")
    if not os.path.exists(os.path.join(out_dir, "dryrun.json")):
        raise SystemExit("STOP: run the dry run first.")
    t0 = time.time()
    shas = verify_inputs(datasets_dir)
    d = load_all(datasets_dir, with_monthly=True)
    wd = load_withdrawals(os.path.join(datasets_dir, INPUTS["lender_flows"][0]))
    return run_on(d, wd, shas, out_dir, t0, log)


def run_on(d, wd, shas, out_dir, t0, log=print):
    results_path = os.path.join(out_dir, "results.json")
    if os.path.exists(results_path):
        raise SystemExit(f"STOP: {results_path} exists; the score phase runs once and never overwrites.")
    rows = build_rows(d)
    log("B1 history ...")
    b1, top_csv, eps = run_b1(d, log)
    log("B2 fits ...")
    P, fold_info = run_b2(d, rows, log)
    log("B2 scoring ...")
    b2 = score_b2(d, rows, P, fold_info, wd, log)
    log("B5 ...")
    b5 = run_b5(d, rows, P, b2["verdict"], log)
    # outputs
    write_predictions(os.path.join(out_dir, "predictions-test.csv.gz"), d, rows, P)
    write_csv(os.path.join(out_dir, "b1-top-depositors.csv"),
              ["reserve", "rank", "address", "max_monthly_balance_usd", "asof_balance_usd", "asof_share_of_supply",
               "n_E1", "k_E1", "n_E2", "k_E2", "n_E3", "k_E3", "exit_trigger_util", "exit_trigger_type",
               "exit_trigger_start", "exit_trigger_text", "util_ge_trigger", "if_left_x_usd", "if_left_util",
               "if_left_bapr_pct", "if_left_sapr_pct", "if_left_stuck_usd"], top_csv)
    ep_rows = []
    for r in RESERVES:
        for ty in ("E1", "E2", "E3"):
            for no, e in enumerate(eps[r][ty], 1):
                ep_rows.append([r, ty, no, e["start"], e["end"], e["n_stress_days"], e["bapr_s_pct"], e["sapr_s_pct"],
                                e["util_s"]])
    write_csv(os.path.join(out_dir, "b1-episodes.csv"),
              ["reserve", "type", "episode_no", "start", "end", "n_stress_days", "bapr_s_pct", "sapr_s_pct", "util_s"],
              ep_rows)
    write_json(os.path.join(out_dir, "venue-view.json"), b1["venue_view"])
    summary = {
        "prereg": PREREG, "datasets_commit": DATASETS_COMMIT, "inputs_sha256": shas, "code": code_meta(),
        "decisions": DECISIONS, "deviations": DEVIATIONS,
        "days": {"first": d.days[0], "last": d.days[-1], "n": d.D, "asof": d.asof},
        "rows": {"candidate": int(len(rows["t"])), "kept": int(rows["feat_ok"].sum())},
        "curve_days_missing_while_listed": {
            r: int(((d.state[r]["listed"] == 1) & (d.state[r]["has_curve"] != 1)).sum()) for r in RESERVES},
        "dryrun_sha256": (sha256_file(os.path.join(out_dir, "dryrun.json"))
                          if os.path.exists(os.path.join(out_dir, "dryrun.json")) else None),
        "b1": b1, "b2": b2, "b5": b5,
        "runtime_s": time.time() - t0, "load_s": d.load_s,
        "finished_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    write_json(results_path, summary, refuse_overwrite=True)
    log(f"run: results written -> {results_path} ({summary['runtime_s']:.0f} s)")
    return summary


def phase_manifest(out_dir, log=print):
    files = {}
    for fn in sorted(os.listdir(out_dir)):
        p = os.path.join(out_dir, fn)
        if fn == "manifest.json" or not os.path.isfile(p):
            continue
        files[fn] = {"bytes": os.path.getsize(p), "sha256": sha256_file(p)}
    with open(os.path.join(out_dir, "results.json")) as f:
        res = json.load(f)
    man = {"files": files, "code": res.get("code"), "prereg": PREREG, "datasets_commit": DATASETS_COMMIT,
           "inputs_sha256": res.get("inputs_sha256"), "runtime_s": res.get("runtime_s"),
           "manifest_code": code_meta(),
           "written_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    write_json(os.path.join(out_dir, "manifest.json"), man)
    log(f"manifest: {len(files)} files")
    return man


DEVIATIONS = [
    {
        "id": 1,
        "date": "2026-10-13",
        "found": "after the single scored run (results.json from code 786837e, kept unchanged)",
        "what": "B2 corroboration share (B.2, reported, never deciding) read 0.0 at both horizons. load_withdrawals "
                "converted datetime_utc to unix seconds with astype('int64') // 1e9, but pandas 3 parses to "
                "datetime64[us], so every withdraw timestamp was 1000x too small and no event fell in any "
                "(T_d, T_(d+h)] window.",
        "fix": "seconds = (t - 1970-01-01Z) // 1 s (resolution-independent); unit test added. Only the "
               "corroboration share is recomputed (phase 'deviation'), written to deviations.json. No fit, "
               "prediction, Brier, BSS, CI, verdict, B1 or B5 number changes: none of them read withdrawals.",
    },
]


def phase_deviation(datasets_dir, out_dir, log=print):
    """Recompute only the corroboration share with the fixed loader (DEVIATIONS 1). results.json is untouched."""
    res_path = os.path.join(out_dir, "results.json")
    with open(res_path) as f:
        res = json.load(f)
    shas = verify_inputs(datasets_dir)
    d = load_all(datasets_dir, with_monthly=False)
    rows = build_rows(d)
    wd = load_withdrawals(os.path.join(datasets_dir, INPUTS["lender_flows"][0]))
    folds = fold_list()
    q0, q1 = d.day_index[folds[0][1]], d.day_index[folds[-1][2]]
    out = {"deviations": DEVIATIONS, "results_json_sha256": sha256_file(res_path), "inputs_sha256": shas,
           "code": code_meta(), "corroboration_corrected": {}, "corroboration_in_results_json": {}}
    for h in HORIZONS:
        te = np.nonzero(rows["feat_ok"] & rows[f"res{h}"] & (rows["t"] >= q0) & (rows["t"] < q1))[0]
        out["corroboration_corrected"][HNAME[h]] = corroboration(d, rows, h, te, wd)
        out["corroboration_in_results_json"][HNAME[h]] = res["b2"]["horizons"][HNAME[h]]["corroboration"]
    write_json(os.path.join(out_dir, "deviations.json"), out)
    log(f"deviation: corrected corroboration -> {out_dir}/deviations.json")
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--datasets", required=False, help="membrane-datasets checkout")
    ap.add_argument("--out", required=True)
    ap.add_argument("--phase", choices=("dryrun", "run", "deviation", "manifest"), required=True)
    a = ap.parse_args(argv)
    os.makedirs(a.out, exist_ok=True)
    if a.phase == "dryrun":
        phase_dryrun(a.datasets, a.out)
    elif a.phase == "run":
        phase_run(a.datasets, a.out)
    elif a.phase == "deviation":
        phase_deviation(a.datasets, a.out)
    else:
        phase_manifest(a.out)


if __name__ == "__main__":
    main()
