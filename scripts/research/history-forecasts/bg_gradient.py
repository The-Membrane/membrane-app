#!/usr/bin/env python3
"""Q26 workstream B-gradient: per-deposit withdrawal forecasts over size x time on exact intraday balance paths.

Implements membrane-board `design/DEPOSITOR_BEHAVIOR_PREREG_B2.md` sections G.2-G.9 (registered at membrane-board
commit 5e45406, file sha256 821343da...d020) with its deviations D1 (f4e66b2: numbers everywhere beside labels,
the "takes all available" target y_all, holdout reserves for blind confirmation) and D2 (567955a: gate tolerance
base; the gate itself was run by the builder). Parent design: `design/DEPOSITOR_BEHAVIOR_PREREG.md` (B).
Every constant below comes from those files; where they are silent the choice is listed in DECISIONS.

Inputs (membrane-datasets, sha256 checked against each PROVENANCE table, STOP on mismatch):
  depositor-balances/ (2ca6d16)  P_r daily 00:00Z anchors, reserve state (cash, supply, debt, rates), blocks
  depositor-events/   (95e0e27)  decoded aToken events (G.2 deltas), extended universe, new-address anchors,
                                 holdouts/{DAI,GHO,USDe} with their own anchors and reserve state
  price-history/eth-usd-1h.json, rate-spike-flows/spike_episodes_full.csv (same files as B)

Phases (run in this order with one fresh --out):
  python3 bg_gradient.py --datasets DIR --out DIR --phase dryrun          rows, units, caps, coverage; no outcome
  python3 bg_gradient.py --datasets DIR --out DIR --phase run             USDC/USDT fit + score ONCE -> results.json
  python3 bg_gradient.py --datasets DIR --out DIR --phase freeze          shipped model per cell -> shipped-models.json
  python3 bg_gradient.py --datasets DIR --out DIR --phase dryrun-holdout  holdout rows and caps; no outcome
  python3 bg_gradient.py --datasets DIR --out DIR --phase blind           holdout blind check ONCE -> results-blind.json
  python3 bg_gradient.py --datasets DIR --out DIR --phase manifest        sha256 of every output
--workers N (default 4) sets the fit processes of the run phase (fork; BLAS pinned to one thread for determinism).
The run and blind phases refuse to overwrite their results. The blind phase refuses unless the frozen
shipped-models.json exists and matches the sha256 recorded by the freeze phase.

Addresses are public on-chain data. This code attaches no identity, label or name to any address.
Light models only (sklearn logistic + empirical-Bayes shrinkage).
"""
import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import csv  # noqa: E402
import gzip  # noqa: E402
import json  # noqa: E402
import math  # noqa: E402
import re  # noqa: E402
import subprocess  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402
from datetime import datetime, timezone  # noqa: E402

import numpy as np  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import b_behavior as B  # noqa: E402  (reused: logistic fit, EB theta, own rate, block bootstrap, episodes, ETH)

# ---------------------------------------------------------------------------------------------
# Registered constants (prereg G.1-G.9, D1, D2)
# ---------------------------------------------------------------------------------------------
PREREG = {
    "repo": "membrane-board",
    "path": "design/DEPOSITOR_BEHAVIOR_PREREG_B2.md",
    "registered_commit": "5e45406",
    "registered_sha256": "821343da743bd91138d055321418961f8b2342b00cbd492f3a71b9b31c7ad020",
    "deviations": {"D1": "f4e66b2", "D2": "567955a"},
    "file_sha256_with_D1_D2": "4fd8456644e1b13858c7b6fc9b8b3934107c37f70375d7ed090ba39345b6a6a9",
    "parent": "design/DEPOSITOR_BEHAVIOR_PREREG.md (B, 7a5f8a6)",
}
DATASETS = {"depositor-balances": "2ca6d16", "depositor-events": "95e0e27"}
DB, DE = "depositor-balances/", "depositor-events/"
HO = DE + "holdouts/"
PROVENANCE_SHA = {  # the PROVENANCE.md files themselves (they pin every file's sha256)
    DB: "f2cc70a2daa0ced4123f9bccaa3c4803099b6d9f5a7d3a263b0448b86e3c2155",
    DE: "6140703a3fe72818e1eab35a803454b26610291a83cad4d08d030746f5d8b8ef",
    HO: "fc58a5505d875a5086426e035a667c9a01bbda7600f293640690029d78a53baa",
}
OTHER_INPUTS = {
    "price-history/eth-usd-1h.json": "48b53d72351dbba6b05939a75660babc361678304747bf764d59e97d968bd26c",
    "rate-spike-flows/spike_episodes_full.csv": "c83c65a78e8ac410f040c903d6ebcd509001ab85292fa28cde434520421929bf",
}
DB_FILES = ("blocks.csv", "daily-balances-usdc.csv.gz", "daily-balances-usdt.csv.gz", "panel-population.csv",
            "reserve-state.csv")

MAIN_RESERVES = ("USDC", "USDT")
HOLDOUT_RESERVES = ("DAI", "GHO", "USDe")
SIZES = (10, 25, 50, 75, 90)                         # G.3 x in percent (exact integer tests)
HORIZONS = (("1h", 3600), ("6h", 6 * 3600), ("24h", 86400), ("48h", 2 * 86400), ("7d", 7 * 86400))  # G.3 h
HNAMES = tuple(h for h, _ in HORIZONS)
HSEC = tuple(s for _, s in HORIZONS)
NX, NH = len(SIZES), len(HORIZONS)
YALL_NUM, YALL_DEN = 9, 10                           # D1: drop >= 0.9 * avail
MICRO = 10 ** 6                                      # 1 token = 1e6 micro-units (6-decimal raw = micro)
MIN_BAL = 1_000_000 * MICRO                          # G.3 origin needs bal(t0) >= $1,000,000
DAY = 86400
PAD_DAYS = 40                                        # feature buckets start 40 days before the first snapshot
DAYS_SINCE_NONE = 365.0                              # G.4: 365 if no balance-decreasing event
EB_M = 3.0                                           # G.5 m
N_BOOT = 2000                                        # G.6
BLOCK_DAYS = 30
SEED_BLOCK = 20261022
SEED_UNIT = 20261023
REL_BINS = 10
# G.7 confidence rule
HIGH_NEP, HIGH_R, HIGH_CI, HIGH_DEC, HIGH_COV, HIGH_RES = 200, (0.8, 1.25), (0.67, 1.5), (0.5, 2.0), 0.85, (0.67, 1.5)
MED_NEP, MED_R, MED_COV = 50, (0.67, 1.5), 0.70
FOLD_MIN_EXITS, FOLD_R = 20, (0.67, 1.5)
STALE_FOLDS, STALE_R, STALE_EXITS = 4, (0.5, 2.0), 20
# D1 blind confirmation
BLIND_NEP, BLIND_R = 50, (0.67, 1.5)

FEATURES_V1 = B.FEATURES                             # util, d_util, bapr, d_bapr, rv7, log10_bal, log1p_age, is_usdt
FEATURES_V2 = FEATURES_V1 + ("log_cash_over_bal", "share_of_supply", "own_flow7_over_bal", "log1p_dec_count30",
                             "log1p_days_since_dec")
NF = {"v1": len(FEATURES_V1), "v2": len(FEATURES_V2)}
VERSIONS = ("v1", "v2")


def _cells():
    """G.6 draw order: h short -> long, then x small -> large (25 x cells); then the D1 y_all cells, h short ->
    long (after every x cell, so the 25 registered draws keep their registered stream positions)."""
    out = []
    for hi, h in enumerate(HNAMES):
        for xi, x in enumerate(SIZES):
            out.append({"id": f"x{x}_{h}", "kind": "x", "x": x, "xi": xi, "hi": hi, "h": h})
    for hi, h in enumerate(HNAMES):
        out.append({"id": f"all_{h}", "kind": "all", "x": None, "xi": None, "hi": hi, "h": h})
    return out


CELLS = _cells()
NC = len(CELLS)
XCELL = np.array([[hi * NX + xi for xi in range(NX)] for hi in range(NH)])   # (NH, NX) -> cell index
ACELL = np.array([NH * NX + hi for hi in range(NH)])                          # y_all cell index per horizon

DECISIONS = [
    "G1 units: every balance, cash and supply is held in micro-token units (1e-6 token = 1 raw unit of a 6-decimal "
    "token). 18-decimal holdout paths are computed in exact integers in raw units and floored to micro-units "
    "after (error < 1e-6 token). One token counts as $1 (USDC/USDT as in B.1; holdouts are USD-pegged by their "
    "selection rule). util = variableDebt / totalSupply (exact ints), bAPR = variableBorrowRate_ray / 1e25 (%).",
    "G2 path (G.2): events = Mint/Burn/BalanceTransfer rows of the decoded files; each row gives delta1 to party1 "
    "and, for BalanceTransfer, delta2 to party2, as stored. The deltas of one address in one block are summed (one "
    "event time = one block timestamp; post-merge blocks are 12 s apart, so ts identifies the block). bal(t) at an "
    "event time t = anchor at the last daily snapshot d with T_d <= t (the anchor is the balance at the last block "
    "with ts < T_d, so every event with ts >= T_d is after it) + the deltas of blocks with T_d <= ts <= t. Events "
    "after the last daily snapshot (2026-10-07) add to that anchor; the asof anchors are not 00:00Z snapshots and "
    "are not path anchors. Intraday interest is ignored (G.2).",
    "G3 window min (G.3): y(x, h) = 1 iff there is >= 1 event time in (t0, t0 + h] and the minimum of bal(t) over "
    "those event times <= (1 - x) bal(t0), tested in integers as 100 * min <= (100 - x) * bal(t0). A window with "
    "no event time has no drop (y = 0). Values at the intermediate 00:00Z anchors are not event times and are not "
    "evaluated. Within one block only the block's net change counts (intra-block intermediate balances are not "
    "seen).",
    "G4 resolution: a (row, h) is labelled iff t0 + h <= the reserve's last event block time (the largest ts in its "
    "decoded event files, all types) and every path value in the window uses a valid anchor (status ok). Rows also "
    "need ETH(d) and RV7(d) (B D4) and every v2 feature defined; a row with any undefined feature is dropped from "
    "every model and baseline (same rows for v1, v2, own and pop). Origins are every daily snapshot meeting this "
    "(no extra start date; B's 2023-02-09 start was a B.4 rule, not a feature).",
    "G5 liquidity cap (G.3): cell (row, x) is capped iff x * bal(t0) > 100 * cash(t0) (exact ints, cash = "
    "underlying.balanceOf(aToken) at the same snapshot). The cap is the same for every h. Capped cells are out of "
    "every fit, baseline, score and label; their count and realized y rate are reported (test rows and all "
    "labelled rows).",
    "G6 y_all (D1): avail = min(bal(t0), cash(t0)); y_all(h) = 1 iff an event time exists in (t0, t0 + h] and "
    "10 * (bal(t0) - min bal) >= 9 * avail (exact ints). Never capped. Constrained rows: cash(t0) < bal(t0). "
    "y_all cells get the G.5 model class (v1, v2 logistic + EB) and baselines; the monotone fix is not applied to "
    "them (G.5 defines the fix across the x by h gradient, which y_all is not part of).",
    "G7 features (G.4): v1 = the B features exactly as b_behavior.build_rows (age = days since the unit's first "
    "daily anchor >= $1M; is_usdt = 1 only for USDT, 0 for USDC and every holdout). v2 adds ln(cash / bal), "
    "bal / totalSupply, (sum of the unit's deltas with T0 - 7 d <= ts < T0) / bal(t0), log1p(number of the unit's "
    "balance-decreasing logs with T0 - 30 d <= ts < T0), log1p(fractional days from the unit's last "
    "balance-decreasing log with ts < T0 to T0), 365 if it has none ever (no cap at 365). A balance-decreasing log "
    "= a log whose summed delta for the unit is < 0 (a self-transfer nets to 0). Events strictly before T0 = blocks "
    "at or before the anchor block.",
    "G8 model (G.5): per fold x cell x version, LogisticRegression(penalty='l2', C=1.0, solver='lbfgs', "
    "max_iter=1000) on features standardized by the training mean and std (ddof 0, zero std -> 1), via "
    "b_behavior.fit_population. E_i = sum of in-sample p0 over unit i's training rows of that cell, O_i its training "
    "y; theta_i = (O_i + 3) / (E_i + 3); a unit without training rows has theta = 1; p = expit(logit p0 + ln theta). "
    "A training set holding one class (never expected) predicts p0 = its training rate and is counted.",
    "G9 baselines (G.5): own = the unit's training y fraction in that cell (uncapped training rows), population rate "
    "when it has none; pop = the training y fraction of the cell over all units. Neither is monotone-fixed (the fix "
    "is defined for the model ladder).",
    "G10 monotone fix (G.5, A's 2-D rule a_touch.monotone_fix): per test row and per version over the 5 x 5 grid, "
    "q[h][x] = min(p[h][x'], x' <= x over uncapped x'), p'[h][x] = max(q[h'][x], h' <= h); capped cells are left out "
    "(their x is a suffix, so they never enter an uncapped cell) and read 'capped'. Applied before scoring, to "
    "every test row with features (labels not needed), in the dev run, the blind run and the panel.",
    "G11 folds (G.6): test quarters 2023Q4..2026Q3 (b_behavior.fold_list). Training rows of cell (x, h): T0 + h <= "
    "Q_start (seconds), labelled, uncapped. Test rows: Q_start <= t0 < Q_end, labelled, uncapped. One fit per fold "
    "x cell x version, pooled over USDC and USDT.",
    "G12 bootstrap (G.6): per cell the day set = sorted unique test dates of that cell's scored rows. One "
    "default_rng(20261022) stream, moving blocks of 30 days, non-circular, ceil(N/30) starts per replicate in one "
    "rng.integers(0, N - 29, size=(2000, ceil(N/30))) call, truncated to N (b_behavior.block_bootstrap_indices). "
    "Cell order: the 25 x cells with h short -> long outer and x small -> large inner, then the 5 y_all cells h "
    "short -> long. Every comparison and R of a cell reuse that cell's draw; per reserve and the y_all constrained / "
    "unconstrained splits reuse it restricted to their rows. CI = numpy percentile [2.5, 97.5] of finite "
    "replicates; 'above 0' = lower bound > 0 (strict). Unit-cluster bootstrap (reported only): default_rng(20261023), "
    "units resampled with replacement, same cell order.",
    "G13 G.7: n_ep = maximal runs of consecutive origin days with y = 1 among one unit's scored test rows (a day "
    "that is not a scored row breaks the run). R = sum p / sum y (sum y = 0 -> +inf). R_low / R_high = R in the first "
    "/ last of 10 groups of the scored rows sorted by p (stable mergesort, numpy.array_split). Fold exits = scored "
    "test rows with y = 1; a fold qualifies with >= 20; cov = covered / qualifying, undefined (fails HIGH and "
    "MEDIUM) with none. Per reserve: R over that reserve's scored rows. STALE: the last 4 folds (2025Q4..2026Q3) "
    "pooled, sum y >= 20 and R outside [0.5, 2.0]. Bounds are inclusive.",
    "G14 G.8 shown model: v1 if v2 fails vs v1 (BSS v2 vs v1 CI lower bound <= 0) AND v1 beats own and pop (CIs > 0); "
    "otherwise v2. The cell's label is the G.7 label of the shown model. Shippable: label HIGH and (shown v2: v2 "
    "beats own, pop and v1) or (shown v1: the condition above). Under D1 every cell shows the shown model's number "
    "beside its label; MEDIUM / LOW cells also show the unit's history count.",
    "G15 blind confirmation (D1): the frozen fold models (fit on USDC/USDT training rows only, rolling origin) "
    "predict each holdout test row; holdout units have no training rows, so theta = 1 and own = pop. Same folds and "
    "quarters, same cap and labels (holdout cash). A HIGH cell stays HIGH iff the pooled holdouts give n_ep >= 50 "
    "and 0.67 <= R <= 1.5; n_ep < 50 -> 'unconfirmed', otherwise 'failed blind'; both -> MEDIUM. Non-HIGH labels "
    "are unchanged. Every cell is also reported (R, n_ep pooled and per holdout reserve).",
    "G16 G.9 history: stress episodes per reserve exactly as B.3 (E1 bAPR >= 10%, E2 |ln ETH(d)/ETH(d-1)| >= 0.08, "
    "E3 threshold-10 onsets; per type, gaps <= 2 days merge; s = first day; b_behavior.stress_days / "
    "merge_episodes). Per unit, type and cell: n = episodes with bal(s) >= $1M, labelled and uncapped at s; k = those "
    "with y = 1. All days: every labelled, uncapped origin day with bal >= $1M (features not required). Ordinary "
    "days: those not inside any E1/E2/E3 episode [start, end] of the reserve. 'Differs' = two-sided Fisher exact "
    "p < 0.05 of (k, n - k) episodes vs ordinary days; a stress claim is made only then. Counts only, no rates.",
    "G17 units for b1-gradient.csv: top 20 per reserve by the maximum valid daily 00:00Z anchor over the extended "
    "universe (ties by address), plus the top 10 by the asof anchor (block 26,180,400).",
    "G18 panel (current day): the 10 largest asof anchors (block 26,180,400) per reserve. Models: per cell and "
    "version, a refit on every labelled, uncapped row with features (T0 + h <= last event time). Feature row at "
    "asof as B D24 (util / bAPR from the asof state, deltas = asof minus the 2026-10-07 snapshot, RV7 from the last "
    "168 hourly returns of the price file, stale), cash / supply from the asof state, age in fractional days, own "
    "flows from events in blocks <= the asof block with ts >= asof ts - 7 d / - 30 d. Cap: x * bal > 100 * cash at "
    "asof. Both version grids are monotone-fixed, then the shown model is taken per cell.",
    "G19 outputs never carry an exit rate in the dry runs. Predictions are written per horizon with a unit index; "
    "units.csv maps the index to address and reserve.",
]

# ---------------------------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------------------------
sha256_file = B.sha256_file
_clean = B._clean
write_json = B.write_json
trunc = B.trunc
to_checksum = B.to_checksum


def ts_date(ts):
    return datetime.fromtimestamp(int(ts), timezone.utc).strftime("%Y-%m-%d")


def code_meta():
    here = os.path.dirname(os.path.abspath(__file__))

    def git(*a):
        try:
            return subprocess.run(["git", "-C", here, *a], capture_output=True, text=True,
                                  timeout=30).stdout.strip() or None
        except Exception:
            return None
    me = os.path.abspath(__file__)
    bb = os.path.join(here, "b_behavior.py")
    return {
        "git_head": git("rev-parse", "HEAD"),
        "last_commit_bg_gradient": git("log", "-1", "--format=%H", "--", os.path.basename(me)),
        "bg_gradient_sha256": sha256_file(me),
        "bg_gradient_dirty": bool(git("status", "--porcelain", "--", os.path.basename(me))),
        "b_behavior_sha256": sha256_file(bb),
        "python": sys.version.split()[0],
        "numpy": np.__version__,
        "sklearn": __import__("sklearn").__version__,
        "scipy": __import__("scipy").__version__,
        "pandas": __import__("pandas").__version__,
    }


def prov_table(datasets_dir, sub):
    p = os.path.join(datasets_dir, sub, "PROVENANCE.md")
    got = sha256_file(p)
    if got != PROVENANCE_SHA[sub]:
        raise SystemExit(f"STOP: {sub}PROVENANCE.md sha256 {got} != {PROVENANCE_SHA[sub]}")
    txt = open(p).read()
    return dict(re.findall(r"\|\s*`([^`]+)`\s*\|\s*\d+\s*\|\s*`([0-9a-f]{64})`\s*\|", txt))


def verify_inputs(datasets_dir, holdouts=False):
    """sha256 of every file read, against its PROVENANCE table (PROVENANCE files pinned). STOP on mismatch."""
    out = {}
    tdb = prov_table(datasets_dir, DB)
    for fn in DB_FILES:
        got = sha256_file(os.path.join(datasets_dir, DB, fn))
        if tdb.get(fn) != got:
            raise SystemExit(f"STOP: sha256 mismatch for {DB}{fn}: {got} != {tdb.get(fn)}")
        out[DB + fn] = got
    tde = prov_table(datasets_dir, DE)
    for fn, want in sorted(tde.items()):
        if fn.startswith("raw-logs") or fn.startswith("block-timestamps") or fn == "run-log.json":
            continue  # not read by this analysis (decoded events carry ts)
        got = sha256_file(os.path.join(datasets_dir, DE, fn))
        if got != want:
            raise SystemExit(f"STOP: sha256 mismatch for {DE}{fn}: {got} != {want}")
        out[DE + fn] = got
    for rel, want in OTHER_INPUTS.items():
        got = sha256_file(os.path.join(datasets_dir, rel))
        if got != want:
            raise SystemExit(f"STOP: sha256 mismatch for {rel}: {got} != {want}")
        out[rel] = got
    if holdouts:
        tho = prov_table(datasets_dir, HO)
        for fn, want in sorted(tho.items()):
            if "raw-logs" in fn or "block-timestamps" in fn or fn == "run-log.json":
                continue
            got = sha256_file(os.path.join(datasets_dir, HO, fn))
            if got != want:
                raise SystemExit(f"STOP: sha256 mismatch for {HO}{fn}: {got} != {want}")
            out[HO + fn] = got
    for sub, s in PROVENANCE_SHA.items():
        if sub != HO or holdouts:
            out[sub + "PROVENANCE.md"] = s
    return out


# ---------------------------------------------------------------------------------------------
# Core definitions (unit-tested on synthetic data)
# ---------------------------------------------------------------------------------------------
I64MAX = np.iinfo(np.int64).max


def to_micro(vals, scale):
    """Exact ints (int64 or Python-int object array) -> int64 micro-units (floor division by scale)."""
    if scale == 1:
        return np.asarray(vals, dtype=np.int64)
    a = np.asarray(vals, dtype=object) // scale
    return a.astype(np.int64)


def group_starts(keys):
    keys = np.asarray(keys)
    if len(keys) == 0:
        return np.zeros(0, dtype=np.int64)
    return np.nonzero(np.r_[True, keys[1:] != keys[:-1]])[0]


def aggregate_sorted(keys, vals):
    """keys sorted; returns (start index of each group, summed vals per group). Works on object arrays."""
    st = group_starts(keys)
    if len(st) == 0:
        return st, vals[:0]
    return st, np.add.reduceat(vals, st)


def build_paths(unit, ts, delta, A_exact, Av, T, scale=1):
    """G.2 path at event times. Inputs: one entry per (unit, block) sorted by (unit, ts), delta = the block's summed
    change (exact ints). A_exact[u, d] = anchor at daily snapshot d (exact ints), Av its validity, T[d] the 00:00Z
    time. Returns dict(unit, ts, v (int64 micro), valid, pday) for event times at or after T[0]."""
    unit = np.asarray(unit, dtype=np.int64)
    ts = np.asarray(ts, dtype=np.int64)
    D = len(T)
    pday = np.searchsorted(np.asarray(T, dtype=np.int64), ts, side="right") - 1
    pday = np.minimum(pday, D - 1)
    keep = pday >= 0
    unit, ts, pday = unit[keep], ts[keep], pday[keep]
    delta = np.asarray(delta)[keep]
    n = len(unit)
    if n == 0:
        z = np.zeros(0, dtype=np.int64)
        return {"unit": z, "ts": z, "v": z, "valid": np.zeros(0, bool), "pday": z}
    newg = np.r_[True, (unit[1:] != unit[:-1]) | (pday[1:] != pday[:-1])]
    cs = np.cumsum(delta)
    gs = np.maximum.accumulate(np.where(newg, np.arange(n), 0))
    within = cs - (cs[gs] - delta[gs])
    v_exact = A_exact[unit, pday] + within
    return {"unit": unit, "ts": ts, "v": to_micro(v_exact, scale), "valid": Av[unit, pday].astype(bool),
            "pday": pday}


def bal_at(paths, A, Av, T, u, t):
    """Reference (slow) G.2 bal(t) for unit u: anchor at the last T_d <= t plus the deltas after it up to t.
    Uses the path table: the last event value of day d at or before t, else the anchor."""
    D = len(T)
    d = int(np.searchsorted(T, t, side="right")) - 1
    d = min(d, D - 1)
    if d < 0:
        return None
    m = (paths["unit"] == u) & (paths["pday"] == d) & (paths["ts"] <= t)
    if m.any():
        return int(paths["v"][np.nonzero(m)[0][-1]])
    return int(A[u, d]) if Av[u, d] else None


class WindowIndex:
    """Range-minimum over event-time path values, grouped by unit (key = unit << 32 | ts)."""

    def __init__(self, paths):
        self.key = (paths["unit"].astype(np.int64) << 32) | paths["ts"].astype(np.int64)
        if len(self.key) > 1 and np.any(np.diff(self.key) <= 0):
            raise ValueError("path keys must be strictly increasing (one entry per unit and block)")
        self.inv_cum = np.r_[0, np.cumsum(~paths["valid"])].astype(np.int64)
        self.levels = [np.where(paths["valid"], paths["v"], I64MAX).astype(np.int64)]

    def _ensure(self, k):
        while len(self.levels) <= k:
            prev = self.levels[-1]
            half = 1 << (len(self.levels) - 1)
            self.levels.append(np.minimum(prev[:-half], prev[half:]) if len(prev) > half else prev[:0])

    def query(self, u, t_lo, t_hi):
        """Events of unit u with t_lo < ts <= t_hi: (min value, has_event, n_invalid). min = I64MAX if none."""
        u = np.asarray(u, dtype=np.int64)
        qlo = (u << 32) | np.asarray(t_lo, dtype=np.int64)
        qhi = (u << 32) | np.asarray(t_hi, dtype=np.int64)
        lo = np.searchsorted(self.key, qlo, side="right")
        hi = np.searchsorted(self.key, qhi, side="right")
        n = hi - lo
        has = n > 0
        mn = np.full(len(u), I64MAX, dtype=np.int64)
        if has.any():
            idx = np.nonzero(has)[0]
            k = np.floor(np.log2(n[idx])).astype(np.int64)
            # guard against float rounding at exact powers of two
            k = np.where((1 << (k + 1)) <= n[idx], k + 1, k)
            k = np.where((1 << k) > n[idx], k - 1, k)
            self._ensure(int(k.max()))
            for kk in np.unique(k):
                s = idx[k == kk]
                L = self.levels[kk]
                mn[s] = np.minimum(L[lo[s]], L[hi[s] - (1 << int(kk))])
        ninv = self.inv_cum[hi] - self.inv_cum[lo]
        return mn, has, ninv


def label_x(bal, mn, has, x):
    """G.3: y(x, h) = 1 iff an event exists and min <= (1 - x) bal(t0); exact: 100 * min <= (100 - x) * bal."""
    bal = np.asarray(bal, dtype=np.int64)
    has = np.asarray(has, dtype=bool)
    mn = np.where(has, np.asarray(mn, dtype=np.int64), bal)
    return has & (mn * 100 <= (100 - x) * bal)


def capped(bal, cash, x):
    """G.3 liquidity cap: x * bal(t0) > cash(t0) -> exact 100 * ... form."""
    return np.asarray(bal, dtype=np.int64) * x > np.asarray(cash, dtype=np.int64) * 100


def label_all(bal, mn, has, cash):
    """D1: avail = min(bal, cash); y_all = 1 iff an event exists and bal - min >= 0.9 avail (10 drop >= 9 avail)."""
    bal = np.asarray(bal, dtype=np.int64)
    has = np.asarray(has, dtype=bool)
    mn = np.where(has, np.asarray(mn, dtype=np.int64), bal)
    avail = np.minimum(bal, np.asarray(cash, dtype=np.int64))
    return has & (YALL_DEN * (bal - mn) >= YALL_NUM * avail)


def own_flow_buckets(log_unit, log_ts, log_delta_f, n_units, T, pad=PAD_DAYS):
    """Per-unit daily buckets from Tbase = T[0] - pad days: cumulative flow CF and cumulative decreasing-log count CC
    (shape n_units x (nb + 1), CF[:, b] = sum over buckets < b), and the sorted keys of decreasing logs."""
    Tbase = int(T[0]) - pad * DAY
    nb = len(T) + pad + 1 + 30
    b = (np.asarray(log_ts, dtype=np.int64) - Tbase) // DAY
    if len(b) and b.min() < 0:
        raise SystemExit("STOP: events before the feature bucket base; increase PAD_DAYS")
    b = np.minimum(b, nb - 1)
    u = np.asarray(log_unit, dtype=np.int64)
    F = np.bincount(u * nb + b, weights=np.asarray(log_delta_f, float), minlength=n_units * nb).reshape(n_units, nb)
    dec = np.asarray(log_delta_f, float) < 0
    C = np.bincount(u[dec] * nb + b[dec], minlength=n_units * nb).reshape(n_units, nb).astype(np.int64)
    CF = np.zeros((n_units, nb + 1))
    CF[:, 1:] = np.cumsum(F, axis=1)
    CC = np.zeros((n_units, nb + 1), dtype=np.int64)
    CC[:, 1:] = np.cumsum(C, axis=1)
    dkey = np.sort((u[dec] << 32) | np.asarray(log_ts, dtype=np.int64)[dec])
    return {"CF": CF, "CC": CC, "dkey": dkey, "pad": pad}


def own_flow_features(fb, rows_u, rows_d, T):
    """G.4 own-flow features at daily origins (events strictly before T[d]): 7-day net flow (absolute), 30-day count
    of decreasing logs, fractional days since the last decreasing log (365 if none)."""
    rows_u = np.asarray(rows_u, dtype=np.int64)
    rows_d = np.asarray(rows_d, dtype=np.int64)
    b0 = rows_d + fb["pad"]
    flow7 = fb["CF"][rows_u, b0] - fb["CF"][rows_u, b0 - 7]
    dec30 = fb["CC"][rows_u, b0] - fb["CC"][rows_u, b0 - 30]
    T0 = np.asarray(T, dtype=np.int64)[rows_d]
    q = (rows_u << 32) | T0
    i = np.searchsorted(fb["dkey"], q, side="left") - 1
    ok = i >= 0
    ii = np.where(ok, i, 0)
    k = fb["dkey"][ii] if len(fb["dkey"]) else np.zeros(len(q), dtype=np.int64)
    ok &= (k >> 32) == rows_u
    days = np.where(ok, (T0 - (k & 0xFFFFFFFF)) / DAY, DAYS_SINCE_NONE)
    return flow7, dec30, days


def own_flow_at(ts, delta_f, block, t_ref, block_ref):
    """Reference G.4 own-flow features for one unit at an arbitrary origin: events with block <= block_ref (strictly
    before the origin's anchor); 7 d / 30 d windows ts >= t_ref - 7 d / 30 d."""
    ts = np.asarray(ts, dtype=np.int64)
    delta_f = np.asarray(delta_f, float)
    m = np.asarray(block, dtype=np.int64) <= block_ref
    flow7 = float(delta_f[m & (ts >= t_ref - 7 * DAY)].sum())
    dec = m & (delta_f < 0)
    dec30 = int((dec & (ts >= t_ref - 30 * DAY)).sum())
    days = (t_ref - int(ts[dec].max())) / DAY if dec.any() else DAYS_SINCE_NONE
    return flow7, dec30, days


def monotone_fix_masked(P, cap):
    """G.5 / A's 2-D rule with capped cells left out. P (n, NH, NX) h short->long, x small->large; cap (n, NX).
    q[h][x] = min(P[h][x'], uncapped x' <= x); P'[h][x] = max(q[h'][x], h' <= h). Capped -> NaN."""
    P = np.asarray(P, float)
    cap = np.asarray(cap, bool)
    Pm = np.where(cap[:, None, :], np.inf, P)
    q = np.minimum.accumulate(Pm, axis=2)
    out = np.maximum.accumulate(q, axis=1)
    return np.where(cap[:, None, :], np.nan, out)


eb_theta = B.eb_theta
own_rate = B.own_rate


def ratio_R(sp, sy):
    if sy > 0:
        return float(sp / sy)
    return float("inf") if sp > 0 else float("nan")


def n_episodes(unit, t, y):
    """G.7 exit episodes: maximal runs of consecutive origin days with y = 1 for one unit."""
    unit = np.asarray(unit, dtype=np.int64)
    t = np.asarray(t, dtype=np.int64)
    m = np.asarray(y) == 1
    if not m.any():
        return 0
    u, tt = unit[m], t[m]
    o = np.lexsort((tt, u))
    u, tt = u[o], tt[o]
    new = np.r_[True, (u[1:] != u[:-1]) | (tt[1:] - tt[:-1] != 1)]
    return int(new.sum())


def decile_R(p, y, nbins=REL_BINS):
    p = np.asarray(p, float)
    y = np.asarray(y, float)
    if len(p) < nbins:
        return None, None
    g = np.array_split(np.argsort(p, kind="mergesort"), nbins)
    return ratio_R(p[g[0]].sum(), y[g[0]].sum()), ratio_R(p[g[-1]].sum(), y[g[-1]].sum())


def _within(v, lo_hi):
    return v is not None and math.isfinite(v) and lo_hi[0] <= v <= lo_hi[1]


def label_g7(n_ep, R, R_ci, R_low, R_high, cov, reserve_R, stale):
    """G.7: returns (label, checks)."""
    ci_in = R_ci is not None and R_ci[0] is not None and R_ci[0] >= HIGH_CI[0] and R_ci[1] <= HIGH_CI[1]
    chk = {
        "n_ep_ge_200": n_ep >= HIGH_NEP,
        "R_in_0.8_1.25": _within(R, HIGH_R),
        "R_ci_in_0.67_1.5": bool(ci_in),
        "R_low_high_in_0.5_2": _within(R_low, HIGH_DEC) and _within(R_high, HIGH_DEC),
        "cov_ge_0.85": cov is not None and cov >= HIGH_COV,
        "each_reserve_R_in_0.67_1.5": bool(reserve_R) and all(_within(r, HIGH_RES) for r in reserve_R.values()),
        "n_ep_ge_50": n_ep >= MED_NEP,
        "R_in_0.67_1.5": _within(R, MED_R),
        "cov_ge_0.70": cov is not None and cov >= MED_COV,
        "stale": bool(stale),
    }
    if stale:
        return "STALE", chk
    if all(chk[k] for k in ("n_ep_ge_200", "R_in_0.8_1.25", "R_ci_in_0.67_1.5", "R_low_high_in_0.5_2", "cov_ge_0.85",
                            "each_reserve_R_in_0.67_1.5")):
        return "HIGH", chk
    if chk["n_ep_ge_50"] and chk["R_in_0.67_1.5"] and chk["cov_ge_0.70"]:
        return "MEDIUM", chk
    return "LOW", chk


def is_stale(R_recent, exits_recent):
    return exits_recent >= STALE_EXITS and not _within(R_recent, STALE_R)


def fold_coverage(R_by_fold, exits_by_fold):
    q = [f for f in R_by_fold if exits_by_fold[f] >= FOLD_MIN_EXITS]
    cov_n = sum(1 for f in q if _within(R_by_fold[f], FOLD_R))
    return (cov_n / len(q) if q else None), len(q), cov_n


def choose_shown(f):
    """G.8 (G14): f = dict of ci_above_0 flags v2_vs_own, v2_vs_pop, v2_vs_v1, v1_vs_own, v1_vs_pop."""
    if (not f["v2_vs_v1"]) and f["v1_vs_own"] and f["v1_vs_pop"]:
        return "v1"
    return "v2"


def shippable(shown, f, label):
    if label != "HIGH":
        return False
    if shown == "v2":
        return bool(f["v2_vs_own"] and f["v2_vs_pop"] and f["v2_vs_v1"])
    return bool((not f["v2_vs_v1"]) and f["v1_vs_own"] and f["v1_vs_pop"])


def blind_confirm(label, R_pool, n_ep_pool):
    """D1: a HIGH cell stays HIGH iff the pooled holdouts give n_ep >= 50 and 0.67 <= R <= 1.5."""
    if label != "HIGH":
        return label, None
    if n_ep_pool >= BLIND_NEP and _within(R_pool, BLIND_R):
        return "HIGH", "confirmed"
    if n_ep_pool < BLIND_NEP:
        return "MEDIUM", "unconfirmed"
    return "MEDIUM", "failed blind"


def train_mask_cell(T0, hsec, Tqs, res_h, cap_c, feat_ok):
    """G.6 purge: training rows have t0 + h <= Q_start; labelled, uncapped, features defined."""
    return (np.asarray(T0, dtype=np.int64) + hsec <= Tqs) & res_h & ~cap_c & feat_ok


def draw_cells(n_days_list, seed=SEED_BLOCK, n_rep=N_BOOT, block=BLOCK_DAYS):
    """Generator of block-bootstrap index draws in the registered cell order from one rng stream."""
    rng = np.random.default_rng(seed)
    for n in n_days_list:
        yield B.block_bootstrap_indices(rng, n, block, n_rep)


# ---------------------------------------------------------------------------------------------
# Model fit / predict (one fold x cell x version)
# ---------------------------------------------------------------------------------------------
def fit_cell_model(X, y, unit, n_units):
    from scipy.special import expit
    y = np.asarray(y, float)
    single = bool(len(y) == 0 or y.min() == y.max())
    if single:
        fit = None
        p0 = np.full(len(y), float(y[0]) if len(y) else 0.0)
    else:
        fit = B.fit_population(X, y)
        p0 = expit(B.decision(fit, X))
    O = np.bincount(unit, weights=y, minlength=n_units)
    E = np.bincount(unit, weights=p0, minlength=n_units)
    n = np.bincount(unit, minlength=n_units)
    theta = eb_theta(O, E)
    pop = float(y.mean()) if len(y) else float("nan")
    own = own_rate(O, n, pop)
    params = None
    info = {"n_train_rows": int(len(y)), "n_train_units": int((n > 0).sum()), "single_class": single}
    if fit is not None:
        params = {"mu": fit["mu"].tolist(), "sd": fit["sd"].tolist(), "coef": fit["clf"].coef_[0].tolist(),
                  "intercept": float(fit["clf"].intercept_[0])}
        info.update(n_iter=int(np.max(fit["clf"].n_iter_)), n_convergence_warnings=fit["n_convergence_warnings"])
    return {"fit": fit, "params": params, "theta": theta, "own": own, "pop": pop, "n_train": n, "info": info,
            "const_p0": None if fit is not None else (float(y[0]) if len(y) else 0.0)}


def z_from_params(params, X):
    mu, sd = np.asarray(params["mu"]), np.asarray(params["sd"])
    return ((X - mu) / sd) @ np.asarray(params["coef"]) + params["intercept"]


def predict_p(params, const_p0, X, theta_u):
    """logit p = logit p0 + ln theta (theta_u: per-row theta, 1 for units without training rows)."""
    from scipy.special import expit
    theta_u = np.asarray(theta_u, float)
    if params is None:
        p0 = np.full(len(X), const_p0)
        return p0 * theta_u / (1.0 - p0 + p0 * theta_u), p0
    z = z_from_params(params, X)
    return expit(z + np.log(theta_u)), expit(z)


# ---------------------------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------------------------
class Ctx:
    pass


def load_ctx(datasets_dir):
    c = Ctx()
    c.days, c.T, c.blocks, c.asof = B.load_blocks(os.path.join(datasets_dir, DB, "blocks.csv"))
    c.D = len(c.days)
    c.day_index = {s: i for i, s in enumerate(c.days)}
    c.eth_start, _, c.oracle = B.load_eth(os.path.join(datasets_dir, "price-history/eth-usd-1h.json"))
    c.eth = np.array([B.eth_at(c.eth_start, c.oracle, int(T)) for T in c.T])
    c.eth_prev = np.array([B.eth_at(c.eth_start, c.oracle, int(T) - DAY) for T in c.T])
    c.rv7 = np.array([B.rv7_at(c.eth_start, c.oracle, int(T)) for T in c.T])
    c.rv7_last = B.rv7_at(c.eth_start, c.oracle, c.eth_start + 3600 * len(c.oracle))
    c.spike_onsets = B.load_spike_onsets(os.path.join(datasets_dir, "rate-spike-flows/spike_episodes_full.csv"))
    c.folds = [(n, c.day_index[a], c.day_index[b]) for n, a, b in B.fold_list()]
    return c


def reserve_spec(datasets_dir, name):
    if name in MAIN_RESERVES:
        lo = name.lower()
        evs = sorted(os.path.join(datasets_dir, DE, f) for f in os.listdir(os.path.join(datasets_dir, DE))
                     if re.fullmatch(rf"events-{lo}-\d{{4}}\.csv\.gz", f))
        return {"name": name, "decimals": 6, "is_usdt": 1.0 if name == "USDT" else 0.0,
                "anchors": [os.path.join(datasets_dir, DB, f"daily-balances-{lo}.csv.gz"),
                            os.path.join(datasets_dir, DE, f"daily-balances-ext-{lo}.csv.gz")],
                "universe": os.path.join(datasets_dir, DE, "extended-universe.csv"),
                "events": evs, "state": os.path.join(datasets_dir, DB, "reserve-state.csv")}
    lo = name.lower()
    d = os.path.join(datasets_dir, HO, name)
    evs = sorted(os.path.join(d, f) for f in os.listdir(d) if re.fullmatch(rf"events-{lo}-\d{{4}}\.csv\.gz", f))
    dec = None
    with open(os.path.join(datasets_dir, HO, "holdout-candidates.csv")) as f:
        for r in csv.DictReader(f):
            if r["symbol"] == name and r["selected"] == "True":
                dec = int(r["decimals"])
    if dec is None:
        raise SystemExit(f"STOP: holdout {name} not selected in holdout-candidates.csv")
    return {"name": name, "decimals": dec, "is_usdt": 0.0, "anchors": [os.path.join(d, f"daily-balances-{lo}.csv.gz")],
            "universe": os.path.join(d, "extended-universe.csv"), "events": evs,
            "state": os.path.join(d, "reserve-state.csv")}


def load_state(path, name, day_index, D, scale):
    """Per-reserve arrays of length D + 2 (daily, asof, asof_events)."""
    n = D + 2
    st = {k: np.full(n, np.nan) for k in ("listed", "util", "bapr", "sapr", "supply_f", "cash_f")}
    st["cash"] = np.full(n, -1, dtype=np.int64)
    st["supply"] = np.full(n, -1, dtype=np.int64)
    seen = np.zeros(n, bool)
    with open(path) as f:
        for row in csv.DictReader(f):
            if row["reserve"] != name:
                continue
            s = row["snapshot"]
            j = D if s == "asof" else D + 1 if s == "asof_events" else day_index.get(s)
            if j is None:
                raise SystemExit(f"STOP: unknown snapshot {s} in {path}")
            seen[j] = True
            listed = row["listed"] == "1"
            st["listed"][j] = 1.0 if listed else 0.0
            if not listed:
                continue
            for k in ("totalSupply_status", "cash_status", "variableDebt_status"):
                if row.get(k, "ok") != "ok":
                    raise SystemExit(f"STOP: {k} = {row[k]} at {s} for {name}")
            sup, cash, debt = int(row["totalSupply"]), int(row["cash"]), int(row["variableDebt"])
            st["supply"][j] = sup // scale
            st["cash"][j] = cash // scale
            st["supply_f"][j] = sup / (scale * MICRO)
            st["cash_f"][j] = cash / (scale * MICRO)
            st["util"][j] = debt / sup if sup > 0 else np.nan
            st["bapr"][j] = int(row["variableBorrowRate_ray"]) / 10 ** 25
            st["sapr"][j] = int(row["liquidityRate_ray"]) / 10 ** 25
    if not seen[:D + 1].all():
        raise SystemExit(f"STOP: reserve state missing snapshots for {name}")
    return st


def load_universe(path, name):
    addrs, meta = [], {}
    with open(path) as f:
        for r in csv.DictReader(f):
            if r["reserve"] != name:
                continue
            a = r["address"].lower()
            addrs.append(a)
            meta[a] = {"in_P_r": r["in_P_r"] == "1", "new": r["new"] == "1"}
    addrs = sorted(set(addrs))
    return addrs, meta


def load_anchors(paths, addrs, day_index, D, scale):
    """Long anchor files -> A_exact (n, D + 2) (int64 or exact object), validity. Days before an address's first row
    in a file that starts at its first event day read 0 (no aToken before the first event); asof columns are
    invalid unless present."""
    import pandas as pd
    n = len(addrs)
    aarr = np.array(addrs)
    A = np.zeros((n, D + 2), dtype=np.int64 if scale == 1 else object)
    Av = np.ones((n, D + 2), dtype=bool)
    Av[:, D:] = False
    filled = np.zeros((n, D + 2), dtype=np.int16)
    status_counts = {}
    for p in paths:
        df = pd.read_csv(p, dtype=str, keep_default_na=False)
        a = df["address"].str.lower().to_numpy()
        ui = np.searchsorted(aarr, a)
        ui = np.minimum(ui, n - 1)
        if not (aarr[ui] == a).all():
            raise SystemExit(f"STOP: anchor file {p} holds an address outside the universe")
        cmap = dict(day_index)
        cmap["asof"] = D
        cmap["asof_events"] = D + 1
        cols = df["snapshot"].map(cmap)
        if cols.isna().any():
            raise SystemExit(f"STOP: unknown snapshot label in {p}")
        cols = cols.to_numpy(dtype=np.int64)
        status = df["status"].to_numpy()
        ok = ((status == "") | (status == "ok")) & (df["balance_raw"].to_numpy() != "")
        for k, v in zip(*np.unique(status, return_counts=True)):
            status_counts[str(k) or "ok"] = status_counts.get(str(k) or "ok", 0) + int(v)
        braw = df["balance_raw"].to_numpy()
        if scale == 1:
            vals = np.zeros(len(df), dtype=np.int64)
            num = pd.to_numeric(pd.Series(braw[ok]))
            if len(num) and num.dtype != np.int64:
                raise SystemExit(f"STOP: balance_raw parsed as {num.dtype}")
            vals[ok] = num.to_numpy(dtype=np.int64)
        else:
            vals = np.array([int(b) if o else 0 for b, o in zip(braw, ok)], dtype=object)
        np.add.at(filled, (ui, cols), 1)
        A[ui, cols] = vals
        Av[ui, cols] = ok
    if (filled > 1).any():
        raise SystemExit("STOP: anchors hold more than one row per (address, snapshot)")
    return A, Av, filled > 0, status_counts


def load_events(paths, addrs, scale):
    """Decoded events -> per (unit, block, log) rows sorted by (unit, block, log_index) with exact deltas."""
    import pandas as pd
    cols = ["block", "ts", "log_index", "type", "party1", "party2", "delta1_raw", "delta2_raw"]
    parts, last_ts, n_all, types = [], 0, 0, {}
    for p in paths:
        df = pd.read_csv(p, usecols=cols, dtype=str, keep_default_na=False)
        n_all += len(df)
        if len(df):
            last_ts = max(last_ts, int(pd.to_numeric(df["ts"]).max()))
        bal = df[df["delta1_raw"] != ""]
        for k, v in bal["type"].value_counts().items():
            types[k] = types.get(k, 0) + int(v)
        parts.append(bal)
    df = pd.concat(parts, ignore_index=True)
    bad = set(df["type"].unique()) - {"Mint", "Burn", "BalanceTransfer"}
    if bad:
        raise SystemExit(f"STOP: balance-changing rows of unexpected type {bad}")
    if ((df["type"] == "BalanceTransfer") != (df["delta2_raw"] != "")).any():
        raise SystemExit("STOP: delta2 present exactly on BalanceTransfer rows expected")
    one = pd.DataFrame({"block": df["block"], "ts": df["ts"], "log_index": df["log_index"],
                        "addr": df["party1"].str.lower(), "delta": df["delta1_raw"]})
    t = df[df["delta2_raw"] != ""]
    two = pd.DataFrame({"block": t["block"], "ts": t["ts"], "log_index": t["log_index"],
                        "addr": t["party2"].str.lower(), "delta": t["delta2_raw"]})
    ev = pd.concat([one, two], ignore_index=True)
    aarr = np.array(addrs)
    a = ev["addr"].to_numpy()
    ui = np.minimum(np.searchsorted(aarr, a), len(aarr) - 1)
    inu = aarr[ui] == a
    n_rows_all = len(ev)
    ev = ev[inu]
    ui = ui[inu]
    block = pd.to_numeric(ev["block"]).to_numpy(np.int64)
    ts = pd.to_numeric(ev["ts"]).to_numpy(np.int64)
    li = pd.to_numeric(ev["log_index"]).to_numpy(np.int64)
    if scale == 1:
        delta = pd.to_numeric(ev["delta"])
        if len(delta) and delta.dtype != np.int64:
            raise SystemExit(f"STOP: deltas parsed as {delta.dtype}")
        delta = delta.to_numpy(np.int64)
    else:
        delta = np.array([int(s) for s in ev["delta"].to_numpy()], dtype=object)
    if block.max() >= (1 << 25) or li.max() >= (1 << 16) or len(addrs) >= (1 << 22):
        raise SystemExit("STOP: key packing bounds exceeded")
    o = np.lexsort((li, block, ui))
    ui, block, ts, li, delta = ui[o], block[o], ts[o], li[o], delta[o]
    # per log (unit, block, log_index)
    lkey = (ui.astype(np.int64) << 41) | (block << 16) | li
    ls, ldelta = aggregate_sorted(lkey, delta)
    logs = {"unit": ui[ls], "block": block[ls], "ts": ts[ls], "delta": ldelta,
            "delta_f": (ldelta.astype(float) if scale == 1 else np.array([float(x) for x in ldelta]) / scale)}
    # per block (unit, block)
    bkey = (ui.astype(np.int64) << 25) | block
    bs, bdelta = aggregate_sorted(bkey, delta)
    blocks = {"unit": ui[bs], "block": block[bs], "ts": ts[bs], "delta": bdelta}
    if len(blocks["ts"]) > 1:
        k = (blocks["unit"].astype(np.int64) << 32) | blocks["ts"]
        if np.any(np.diff(k) <= 0):
            raise SystemExit("STOP: two blocks of one unit share a timestamp or are out of order")
    info = {"decoded_rows": int(n_all), "balance_rows_by_type": types, "party_rows": int(n_rows_all),
            "party_rows_in_universe": int(inu.sum()), "logs_in_universe": int(len(ls)),
            "blocks_in_universe": int(len(bs)), "last_event_ts": int(last_ts),
            "last_event_utc": datetime.fromtimestamp(last_ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    return logs, blocks, last_ts, info


class Res:
    pass


def load_reserve(ctx, datasets_dir, name, log=print):
    t0 = time.time()
    sp = reserve_spec(datasets_dir, name)
    R = Res()
    R.name = name
    R.scale = 10 ** (sp["decimals"] - 6)
    R.is_usdt = sp["is_usdt"]
    R.addrs, R.meta = load_universe(sp["universe"], name)
    R.n = len(R.addrs)
    D = ctx.D
    R.A_exact, R.Av, R.filled, R.anchor_status = load_anchors(sp["anchors"], R.addrs, ctx.day_index, D, R.scale)
    R.A = to_micro(R.A_exact, R.scale) if R.scale != 1 else R.A_exact
    if name in MAIN_RESERVES:
        # every P_r member has a row at every daily snapshot; every universe address has an asof anchor
        prm = np.array([R.meta[a]["in_P_r"] for a in R.addrs])
        if not R.filled[prm, :D + 1].all():
            raise SystemExit(f"STOP: P_r anchors incomplete for {name}")
    if not R.filled[:, D].all():
        raise SystemExit(f"STOP: asof anchors missing for {name}")
    R.state = load_state(sp["state"], name, ctx.day_index, D, R.scale)
    R.logs, R.blocks, R.last_ts, R.ev_info = load_events(sp["events"], R.addrs, R.scale)
    R.paths = build_paths(R.blocks["unit"], R.blocks["ts"], R.blocks["delta"], R.A_exact[:, :D], R.Av[:, :D],
                          ctx.T, R.scale)
    R.widx = WindowIndex(R.paths)
    R.fb = own_flow_buckets(R.logs["unit"], R.logs["ts"], R.logs["delta_f"], R.n, ctx.T)
    R.load_s = time.time() - t0
    log(f"  {name}: {R.n} units, {len(R.paths['v'])} path points, last event {R.ev_info['last_event_utc']} "
        f"({R.load_s:.0f} s)")
    return R


# ---------------------------------------------------------------------------------------------
# Rows, labels, features
# ---------------------------------------------------------------------------------------------
def first_big_day(A, Av, D):
    big = Av[:, :D] & (A[:, :D] >= MIN_BAL)
    return np.where(big.any(axis=1), big.argmax(axis=1), -1)


def build_rows_reserve(ctx, R, ri, compute_labels=True):
    D = ctx.D
    A, Av = R.A[:, :D], R.Av[:, :D]
    cand = Av & (A >= MIN_BAL)
    u, d = np.nonzero(cand)
    n = len(u)
    bal = A[u, d]
    T0 = ctx.T[d].astype(np.int64)
    st = R.state
    cash = st["cash"][d]
    out = {"u": u.astype(np.int64), "t": d.astype(np.int64), "T0": T0, "bal": bal, "cash": cash,
           "reserve": np.full(n, ri, np.int8)}
    MN = np.zeros((n, NH), dtype=np.int64)
    HAS = np.zeros((n, NH), dtype=bool)
    RESV = np.zeros((n, NH), dtype=bool)
    for hi, hs in enumerate(HSEC):
        mn, has, ninv = R.widx.query(u, T0, T0 + hs)
        MN[:, hi] = np.where(has & (ninv == 0), mn, bal)
        HAS[:, hi] = has & (ninv == 0)
        RESV[:, hi] = (T0 + hs <= R.last_ts) & (ninv == 0)
    out["MN"], out["HAS"], out["RES"] = MN, HAS, RESV
    CAP = np.zeros((n, NC), dtype=bool)
    for c in CELLS:
        if c["kind"] == "x":
            CAP[:, XCELL[c["hi"], c["xi"]]] = capped(bal, cash, c["x"]) & (cash >= 0)
    out["CAP"] = CAP
    out["constrained"] = cash < bal
    if compute_labels:
        Y = np.zeros((n, NC), dtype=np.int8)
        for ci, c in enumerate(CELLS):
            h = c["hi"]
            if c["kind"] == "x":
                Y[:, ci] = label_x(bal, MN[:, h], HAS[:, h], c["x"])
            else:
                Y[:, ci] = label_all(bal, MN[:, h], HAS[:, h], cash)
        out["Y"] = Y
    # features
    t0b = first_big_day(R.A, R.Av, D)
    util, bapr = st["util"], st["bapr"]
    dm1 = np.maximum(d - 1, 0)
    valid_prev = d >= 1
    with np.errstate(divide="ignore", invalid="ignore"):
        balu = bal / MICRO
        flow7, dec30, days = own_flow_features(R.fb, u, d, ctx.T)
        X = np.column_stack([
            util[d], np.where(valid_prev, util[d] - util[dm1], np.nan),
            bapr[d], np.where(valid_prev, bapr[d] - bapr[dm1], np.nan),
            np.where(np.isfinite(ctx.eth[d]), ctx.rv7[d], np.nan),
            np.log10(balu), np.log1p((d - t0b[u]).astype(float)), np.full(n, R.is_usdt),
            np.where(cash > 0, np.log(cash.astype(float) / bal.astype(float)), np.nan),
            np.where(st["supply"][d] > 0, bal.astype(float) / st["supply"][d].astype(float), np.nan),
            flow7 / bal.astype(float),
            np.log1p(dec30.astype(float)), np.log1p(days),
        ])
    out["X"] = X
    out["feat_ok"] = np.all(np.isfinite(X), axis=1) & (st["listed"][d] == 1)
    return out


def build_rows(ctx, reserves, compute_labels=True):
    parts, base = [], 0
    unit_addr, unit_res, unit_base = [], [], {}
    for ri, R in enumerate(reserves):
        p = build_rows_reserve(ctx, R, ri, compute_labels)
        p["unit"] = p["u"] + base
        unit_base[R.name] = base
        unit_addr += R.addrs
        unit_res += [R.name] * R.n
        base += R.n
        parts.append(p)
    rows = {k: np.concatenate([p[k] for p in parts]) for k in parts[0]}
    rows["n_units"] = base
    rows["unit_addr"] = unit_addr
    rows["unit_res"] = unit_res
    rows["unit_base"] = unit_base
    rows["reserve_names"] = [R.name for R in reserves]
    # fold of each row (-1 outside the test quarters)
    fold = np.full(len(rows["t"]), -1, dtype=np.int16)
    for fi, (_, qs, qe) in enumerate(ctx.folds):
        fold[(rows["t"] >= qs) & (rows["t"] < qe)] = fi
    rows["fold"] = fold
    return rows


def path_gate_check(ctx, R):
    """Replica of the G.2 gate on the path code (D2 tolerance): for (unit, d) with valid anchors on d and d + 1,
    |anchor(d) + sum of day-d deltas - anchor(d + 1)| <= max($10, 0.1% of max(anchor_d, anchor_d+1, intraday peak))."""
    D = ctx.D
    P = R.paths
    m = P["pday"] < D - 1
    u, d, v = P["unit"][m], P["pday"][m], P["v"][m]
    key = u * D + d
    st = group_starts(key)
    last = np.r_[st[1:], len(key)] - 1
    gk = key[st]
    peak = np.maximum.reduceat(v, st) if len(st) else v[:0]
    end = v[last]
    A, Av = R.A[:, :D], R.Av[:, :D]
    both = Av[:, :-1] & Av[:, 1:]
    endv = A[:, :-1].copy()
    pk = A[:, :-1].copy()
    has = np.zeros_like(both)
    gu, gd = gk // D, gk % D
    endv[gu, gd] = end
    pk[gu, gd] = np.maximum(pk[gu, gd], peak)
    has[gu, gd] = True
    diff = np.abs(endv - A[:, 1:])
    base = np.maximum(np.maximum(A[:, :-1], A[:, 1:]), pk)
    tol = np.maximum(10 * MICRO, base // 1000)
    ok = diff <= tol
    reg_tol = np.maximum(10 * MICRO, np.maximum(A[:, :-1], A[:, 1:]) // 1000)
    okr = diff <= reg_tol
    nb, ne = int(both.sum()), int((both & has).sum())
    return {"pairs": nb, "pairs_with_event": ne,
            "share_pass_d2": float((ok & both).sum() / nb) if nb else None,
            "share_pass_d2_with_event": float((ok & both & has).sum() / ne) if ne else None,
            "share_pass_registered": float((okr & both).sum() / nb) if nb else None,
            "share_pass_registered_with_event": float((okr & both & has).sum() / ne) if ne else None}


# ---------------------------------------------------------------------------------------------
# Fitting (multiprocessing over fold x cell x version; fork shares the row arrays)
# ---------------------------------------------------------------------------------------------
_G = {}


def _fit_task(task):
    kind, fi, ci, ver = task
    rows = _G["rows"]
    X = rows["X"][:, :NF[ver]]
    c = CELLS[ci]
    hi = c["hi"]
    if kind == "fold":
        Tqs = int(_G["T"][_G["folds"][fi][1]])
        tr = train_mask_cell(rows["T0"], HSEC[hi], Tqs, rows["RES"][:, hi], rows["CAP"][:, ci], rows["feat_ok"])
    else:  # asof refit on every labelled row (t0 + h <= last event time is part of RES)
        tr = rows["RES"][:, hi] & ~rows["CAP"][:, ci] & rows["feat_ok"]
    tri = np.nonzero(tr)[0]
    m = fit_cell_model(X[tri], rows["Y"][tri, ci], rows["unit"][tri], rows["n_units"])
    info = dict(m["info"], n_train_exits=int(rows["Y"][tri, ci].sum()), pop_rate=m["pop"])
    res = {"kind": kind, "fi": fi, "ci": ci, "ver": ver, "params": m["params"], "const_p0": m["const_p0"],
           "pop": m["pop"], "info": info}
    if kind == "fold":
        te = _G["test_idx"][fi]
        th = m["theta"][rows["unit"][te]]
        p, p0 = predict_p(m["params"], m["const_p0"], X[te], th)
        res.update(p=p, p0=p0, own=m["own"][rows["unit"][te]], has_train=m["n_train"][rows["unit"][te]] > 0)
    else:
        sel = _G["panel_units"]
        res.update(theta_panel=m["theta"][sel].tolist(), own_panel=m["own"][sel].tolist(),
                   n_train_panel=m["n_train"][sel].tolist())
    return res


def run_fits(ctx, rows, tasks, panel_units=None, workers=4, log=print):
    import multiprocessing as mp
    _G.clear()
    _G.update(rows=rows, T=ctx.T, folds=ctx.folds, panel_units=panel_units,
              test_idx=[np.nonzero((rows["fold"] == fi) & rows["feat_ok"])[0] for fi in range(len(ctx.folds))])
    out = []
    t0 = time.time()
    if workers <= 1:
        for i, tk in enumerate(tasks):
            out.append(_fit_task(tk))
    else:
        with mp.get_context("fork").Pool(workers) as pool:
            for i, r in enumerate(pool.imap_unordered(_fit_task, tasks, chunksize=1)):
                out.append(r)
                if (i + 1) % 60 == 0:
                    log(f"    {i + 1}/{len(tasks)} fits ({time.time() - t0:.0f} s)")
    return out, _G["test_idx"]


# ---------------------------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------------------------
def bss_ci(pos, nd, pm, pb, y, cb):
    se_m = np.bincount(pos, weights=(pm - y) ** 2, minlength=nd)
    se_b = np.bincount(pos, weights=(pb - y) ** 2, minlength=nd)
    n = len(y)
    out = {"n_rows": int(n), "brier_model": float(se_m.sum() / n) if n else None,
           "brier_base": float(se_b.sum() / n) if n else None,
           "bss": float(1.0 - se_m.sum() / se_b.sum()) if se_b.sum() > 0 else None}
    with np.errstate(divide="ignore", invalid="ignore"):
        reps = 1.0 - (cb @ se_m) / (cb @ se_b)
    fin = np.isfinite(reps)
    out["n_nonfinite_reps"] = int((~fin).sum())
    if fin.sum() > 1:
        lo, hi = np.percentile(reps[fin], [2.5, 97.5])
        out.update(ci95=[float(lo), float(hi)], ci_above_0=bool(lo > 0), ci_below_0=bool(hi < 0))
    else:
        out.update(ci95=None, ci_above_0=False, ci_below_0=False)
    return out


def r_ci(pos, nd, p, y, cb):
    """95% percentile CI of R = sum p / sum y over the block replicates. A replicate with sum y = 0 (and sum p > 0)
    is R = +inf and stays in the distribution (an upper bound of +inf fails every R bound); 0/0 replicates are
    dropped and counted."""
    sp = np.bincount(pos, weights=p, minlength=nd)
    sy = np.bincount(pos, weights=y, minlength=nd)
    with np.errstate(divide="ignore", invalid="ignore"):
        reps = (cb @ sp) / (cb @ sy)
    keep = ~np.isnan(reps)
    n_inf = int(np.isposinf(reps).sum())
    if keep.sum() > 1:
        r = np.where(np.isposinf(reps[keep]), 1e300, reps[keep])
        lo, hi = np.percentile(r, [2.5, 97.5])
        lo, hi = (float("inf") if v >= 1e299 else float(v) for v in (lo, hi))
        return [lo, hi], int((~keep).sum()) + n_inf
    return None, int((~keep).sum()) + n_inf


COMPARISONS = (("v2_vs_own", "v2", "own"), ("v2_vs_pop", "v2", "pop"), ("v2_vs_v1", "v2", "v1"),
               ("v1_vs_own", "v1", "own"), ("v1_vs_pop", "v1", "pop"))


def g7_block(Q, p, pos, nd, cb, fold_names, reserve_names):
    y = Q["y"]
    n_ep = n_episodes(Q["unit"], Q["t"], y)
    R = ratio_R(p.sum(), y.sum())
    ci, nonfin = r_ci(pos, nd, p, y, cb)
    R_low, R_high = decile_R(p, y)
    Rf, Ef = {}, {}
    for fi, fn in enumerate(fold_names):
        m = Q["fold"] == fi
        if m.any():
            Rf[fn] = ratio_R(p[m].sum(), y[m].sum())
            Ef[fn] = int(y[m].sum())
    cov, n_q, n_cov = fold_coverage(Rf, Ef)
    Rr = {}
    for ri, rn in enumerate(reserve_names):
        m = Q["reserve"] == ri
        if m.any():
            Rr[rn] = ratio_R(p[m].sum(), y[m].sum())
    rec = Q["fold"] >= len(fold_names) - STALE_FOLDS
    R_rec, E_rec = ratio_R(p[rec].sum(), y[rec].sum()), int(y[rec].sum())
    stale = is_stale(R_rec, E_rec)
    label, chk = label_g7(n_ep, R, ci, R_low, R_high, cov, Rr, stale)
    return {"label": label, "checks": chk, "n_ep": n_ep, "R": R, "R_ci95": ci, "R_nonfinite_reps": nonfin,
            "sum_p": float(p.sum()), "sum_y": int(y.sum()), "R_low": R_low, "R_high": R_high,
            "fold_R": Rf, "fold_exits": Ef, "cov": cov, "qualifying_folds": n_q, "covered_folds": n_cov,
            "reserve_R": Rr, "recent4": {"R": R_rec, "exits": E_rec}}


def score_cells(ctx, rows, PR, log=print):
    """PR[ver] (n_rows, NC) monotone-fixed test predictions; PR['own'], PR['pop'] baselines (NaN off test)."""
    fold_names = [f[0] for f in ctx.folds]
    rn = rows["reserve_names"]
    test = (rows["fold"] >= 0) & rows["feat_ok"]
    masks, days = [], []
    for ci, c in enumerate(CELLS):
        m = test & rows["RES"][:, c["hi"]] & ~rows["CAP"][:, ci]
        masks.append(np.nonzero(m)[0])
        days.append(np.unique(rows["t"][masks[-1]]))
    draws = draw_cells([len(d) for d in days])
    rng_u = np.random.default_rng(SEED_UNIT)
    out = {}
    for ci, c in enumerate(CELLS):
        idx = masks[ci]
        dd = days[ci]
        nd = len(dd)
        cb = B.replicate_counts(next(draws), nd)
        Q = {"y": rows["Y"][idx, ci].astype(float), "t": rows["t"][idx], "unit": rows["unit"][idx],
             "reserve": rows["reserve"][idx], "fold": rows["fold"][idx]}
        pr = {k: PR[k][idx, ci] for k in ("v1", "v2", "own", "pop")}
        if any(np.isnan(v).any() for v in pr.values()):
            raise SystemExit(f"STOP: missing prediction in cell {c['id']}")
        pos = np.searchsorted(dd, Q["t"])
        y = Q["y"]
        H = {"cell": c, "n": {"rows": int(len(idx)), "days": int(nd), "units": int(len(np.unique(Q["unit"]))),
                              "exits": int(y.sum())},
             "brier": {k: float(np.mean((pr[k] - y) ** 2)) for k in pr}, "bss": {}}
        for cname, a, b in COMPARISONS:
            H["bss"][cname] = bss_ci(pos, nd, pr[a], pr[b], y, cb)
        flags = {cname: H["bss"][cname]["ci_above_0"] for cname, _, _ in COMPARISONS}
        H["pass_flags"] = flags
        H["g7"] = {v: g7_block(Q, pr[v], pos, nd, cb, fold_names, rn) for v in VERSIONS}
        shown = choose_shown(flags)
        label = H["g7"][shown]["label"]
        H["shown_model"] = shown
        H["label"] = label
        H["shippable"] = shippable(shown, flags, label)
        # per reserve (reuses the cell draw)
        H["per_reserve"] = {}
        for ri, r in enumerate(rn):
            m = Q["reserve"] == ri
            H["per_reserve"][r] = {
                "n_rows": int(m.sum()), "n_exits": int(y[m].sum()), "n_units": int(len(np.unique(Q["unit"][m]))),
                "brier": {k: float(np.mean((pr[k][m] - y[m]) ** 2)) if m.any() else None for k in pr},
                "bss": {cname: bss_ci(pos[m], nd, pr[a][m], pr[b][m], y[m], cb) for cname, a, b in COMPARISONS},
                "R": {v: ratio_R(pr[v][m].sum(), y[m].sum()) for v in VERSIONS},
                "n_ep": n_episodes(Q["unit"][m], Q["t"][m], y[m])}
        # per fold (point)
        H["per_fold"] = []
        for fi, fn in enumerate(fold_names):
            m = Q["fold"] == fi
            br = {k: float(np.mean((pr[k][m] - y[m]) ** 2)) if m.any() else None for k in pr}
            H["per_fold"].append({"fold": fn, "n_rows": int(m.sum()), "n_exits": int(y[m].sum()), "brier": br,
                                  "bss": {cname: (1 - br[a] / br[b]) if (m.any() and br[b] > 0) else None
                                          for cname, a, b in COMPARISONS}})
        H["auc"] = {k: B.auc(y, pr[k]) for k in ("v2", "v1", "own")}
        H["reliability"] = {k: B.reliability(pr[k], y) for k in VERSIONS}
        # unit-cluster bootstrap (reported only)
        units, upos = np.unique(Q["unit"], return_inverse=True)
        nu = len(units)
        cu = B.replicate_counts(rng_u.integers(0, nu, size=(N_BOOT, nu)), nu)
        H["unit_cluster"] = {}
        for cname, a, b in COMPARISONS[:3]:
            se_m = np.bincount(upos, weights=(pr[a] - y) ** 2, minlength=nu)
            se_b = np.bincount(upos, weights=(pr[b] - y) ** 2, minlength=nu)
            with np.errstate(divide="ignore", invalid="ignore"):
                reps = 1.0 - (cu @ se_m) / (cu @ se_b)
            fin = np.isfinite(reps)
            H["unit_cluster"][cname] = {"ci95": [float(x) for x in np.percentile(reps[fin], [2.5, 97.5])]
                                        if fin.sum() > 1 else None, "n_units": int(nu),
                                        "n_nonfinite": int((~fin).sum())}
        # capped cells (x cells) / constrained split (y_all cells)
        lab_all = rows["feat_ok"] & rows["RES"][:, c["hi"]]
        if c["kind"] == "x":
            capm = rows["CAP"][:, ci]
            ct, ca = test & lab_all & capm, lab_all & capm
            H["capped"] = {"test_rows": {"n": int(ct.sum()), "realized_rate": float(rows["Y"][ct, ci].mean())
                                         if ct.any() else None, "n_y1": int(rows["Y"][ct, ci].sum())},
                           "all_labelled_rows": {"n": int(ca.sum()), "realized_rate": float(rows["Y"][ca, ci].mean())
                                                 if ca.any() else None, "n_y1": int(rows["Y"][ca, ci].sum())},
                           "by_reserve_test": {r: int((ct & (rows["reserve"] == ri)).sum()) for ri, r in enumerate(rn)}}
        else:
            con = rows["constrained"][idx]
            H["constrained_split"] = {}
            for nm, m in (("constrained", con), ("unconstrained", ~con)):
                g = {"n_rows": int(m.sum()), "n_exits": int(y[m].sum()),
                     "n_ep": n_episodes(Q["unit"][m], Q["t"][m], y[m]),
                     "brier": {k: float(np.mean((pr[k][m] - y[m]) ** 2)) if m.any() else None for k in pr},
                     "bss": {cname: bss_ci(pos[m], nd, pr[a][m], pr[b][m], y[m], cb) for cname, a, b in COMPARISONS},
                     "R": {v: ratio_R(pr[v][m].sum(), y[m].sum()) for v in VERSIONS},
                     "R_ci95": {v: r_ci(pos[m], nd, pr[v][m], y[m], cb)[0] for v in VERSIONS},
                     "realized_rate": float(y[m].mean()) if m.any() else None}
                H["constrained_split"][nm] = g
        out[c["id"]] = H
        log(f"  scored {c['id']}: rows {H['n']['rows']}, label {label} ({shown})")
    return out


# ---------------------------------------------------------------------------------------------
# G.9 history in gradient form
# ---------------------------------------------------------------------------------------------
def episodes_by_reserve(ctx, R):
    st = {"bapr": R.state["bapr"]}
    sd = B.stress_days(st, ctx.eth, ctx.eth_prev, ctx.days, ctx.spike_onsets)
    eps = {}
    for ty in ("E1", "E2", "E3"):
        eps[ty] = [{"type": ty, "s": s, "e": e, "start": ctx.days[s], "end": ctx.days[e], "n_stress_days": n}
                   for s, e, n in B.merge_episodes(sd[ty])]
    in_ep = np.zeros(ctx.D, bool)
    for ty in eps:
        for e in eps[ty]:
            in_ep[e["s"]:e["e"] + 1] = True
    return eps, in_ep, {ty: len(v) for ty, v in sd.items()}


def g9_unit(ctx, rows, rowmap, gu, eps, in_ep):
    """k-of-n table for one unit over all cells: E1/E2/E3 episodes, all days and ordinary days."""
    from scipy.stats import fisher_exact
    r_all = rowmap.get(gu, np.zeros(0, dtype=np.int64))
    t_all = rows["t"][r_all]
    out = []
    by_t = dict(zip(t_all.tolist(), r_all.tolist()))
    for ci, c in enumerate(CELLS):
        hi = c["hi"]
        ok = rows["RES"][r_all, hi] & ~rows["CAP"][r_all, ci]
        y = rows["Y"][r_all, ci]
        ordm = ok & ~in_ep[t_all]
        k_o, n_o = int(y[ordm].sum()), int(ordm.sum())
        allm = ok
        k_a, n_a = int(y[allm].sum()), int(allm.sum())
        first = ctx.days[int(t_all[allm].min())] if n_a else None
        last = ctx.days[int(t_all[allm].max())] if n_a else None
        exits_all = [ctx.days[int(t)] for t in t_all[allm & (y == 1)]]
        out.append({"cell": c["id"], "type": "all", "k": k_a, "n": n_a,
                    "n_capped": int((rows["RES"][r_all, hi] & rows["CAP"][r_all, ci]).sum()),
                    "n_unlabelled": int((~rows["RES"][r_all, hi]).sum()), "first": first, "last": last,
                    "exit_dates": exits_all, "counted_dates": None, "fisher_p": None, "differs": None})
        out.append({"cell": c["id"], "type": "ordinary", "k": k_o, "n": n_o,
                    "n_capped": int((rows["RES"][r_all, hi] & rows["CAP"][r_all, ci] & ~in_ep[t_all]).sum()),
                    "n_unlabelled": int((~rows["RES"][r_all, hi] & ~in_ep[t_all]).sum()),
                    "first": ctx.days[int(t_all[ordm].min())] if n_o else None,
                    "last": ctx.days[int(t_all[ordm].max())] if n_o else None,
                    "exit_dates": [ctx.days[int(t)] for t in t_all[ordm & (y == 1)]], "counted_dates": None,
                    "fisher_p": None, "differs": None})
        for ty in ("E1", "E2", "E3"):
            k = n = ncap = nunl = 0
            dates, exits = [], []
            for e in eps[ty]:
                ri = by_t.get(e["s"])
                if ri is None:
                    continue
                if not rows["RES"][ri, hi]:
                    nunl += 1
                    continue
                if rows["CAP"][ri, ci]:
                    ncap += 1
                    continue
                n += 1
                dates.append(e["start"])
                if rows["Y"][ri, ci] == 1:
                    k += 1
                    exits.append(e["start"])
            fp = differs = None
            if n > 0 and n_o > 0:
                fp = float(fisher_exact([[k, n - k], [k_o, n_o - k_o]]).pvalue)
                differs = bool(fp < 0.05)
            out.append({"cell": c["id"], "type": ty, "k": k, "n": n, "n_capped": ncap, "n_unlabelled": nunl,
                        "first": dates[0] if dates else None, "last": dates[-1] if dates else None,
                        "exit_dates": exits, "counted_dates": dates, "fisher_p": fp, "differs": differs})
    return out


def g9_statement(c, rec):
    what = (f"dropped ≥ {c['x']}% within {c['h']}" if c["kind"] == "x"
            else f"took ≥ 90% of what was available within {c['h']}")
    if rec["type"] in ("all", "ordinary"):
        days = "days" if rec["type"] == "all" else "ordinary days"
        return f"{what} on {rec['k']} of {rec['n']} {days} since {rec['first']}" if rec["n"] else f"no {days}"
    return f"{what} in {rec['k']} of {rec['n']} {rec['type']} episodes" + (
        f" (exits: {', '.join(rec['exit_dates'])})" if rec["exit_dates"] else "")


# ---------------------------------------------------------------------------------------------
# Panel (current day)
# ---------------------------------------------------------------------------------------------
def panel_features(ctx, R, ri_local, units_local):
    D = ctx.D
    j, jl = D, D - 1
    st = R.state
    t0b = first_big_day(R.A, R.Av, D)
    ats, ablk = ctx.asof["block_ts"], ctx.asof["block"]
    X, info = [], []
    for u in units_local:
        bal = int(R.A[u, D])
        m = R.logs["unit"] == u
        f7, dc, ds = own_flow_at(R.logs["ts"][m], R.logs["delta_f"][m], R.logs["block"][m], ats, ablk)
        age = (ats - int(ctx.T[t0b[u]])) / DAY if t0b[u] >= 0 else 0.0
        cash, sup = int(st["cash"][j]), int(st["supply"][j])
        X.append([st["util"][j], st["util"][j] - st["util"][jl], st["bapr"][j], st["bapr"][j] - st["bapr"][jl],
                  ctx.rv7_last, math.log10(bal / MICRO), math.log1p(age), R.is_usdt,
                  math.log(cash / bal), bal / sup, f7 / bal, math.log1p(dc), math.log1p(ds)])
        info.append({"bal": bal, "cash": cash, "supply": sup})
    return np.array(X, float), info


# ---------------------------------------------------------------------------------------------
# Output writers
# ---------------------------------------------------------------------------------------------
def write_csv(path, header, rows_):
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(header)
        for r in rows_:
            w.writerow(["" if (isinstance(x, float) and not math.isfinite(x)) else x for x in r])


def fmt(v):
    return "" if v is None or (isinstance(v, float) and not math.isfinite(v)) else f"{v:.6g}"


def write_predictions(out_dir, ctx, rows, PR, prefix="predictions-test", fixed_names=None, max_bytes=45_000_000):
    """One gz CSV per horizon over the labelled test rows with features (split per reserve when a file would
    exceed max_bytes). Columns: unit index (units.csv), date, fold, the cap flag of each x cell, y of each cell
    (x cells and y_all), then each prediction (monotone-fixed models, baselines) per cell; capped cells are empty."""
    import pandas as pd
    test = (rows["fold"] >= 0) & rows["feat_ok"]
    written = []
    fold_names = np.array([f[0] for f in ctx.folds])
    days = np.array(ctx.days)
    keys = fixed_names or ("v2", "v1", "own", "pop")
    for hi, h in enumerate(HNAMES):
        cis = list(XCELL[hi]) + [int(ACELL[hi])]
        m = np.nonzero(test & rows["RES"][:, hi])[0]
        m = m[np.lexsort((rows["t"][m], rows["unit"][m]))]

        def frame(idx):
            cols = {"unit": rows["unit"][idx], "date": days[rows["t"][idx]], "fold": fold_names[rows["fold"][idx]]}
            for c in cis[:NX]:
                cols[f"cap_{CELLS[c]['id']}"] = rows["CAP"][idx, c].astype(np.int8)
            for c in cis:
                cols[f"y_{CELLS[c]['id']}"] = rows["Y"][idx, c]
            for k in keys:
                for c in cis:
                    v = PR[k][idx, c].copy()
                    if c in cis[:NX]:
                        v[rows["CAP"][idx, c]] = np.nan
                    cols[f"{k}_{CELLS[c]['id']}"] = v
            return pd.DataFrame(cols)

        p = os.path.join(out_dir, f"{prefix}-{h}.csv.gz")
        frame(m).to_csv(p, index=False, float_format="%.6g", compression={"method": "gzip", "compresslevel": 9})
        if os.path.getsize(p) <= max_bytes:
            written.append(p)
            continue
        os.remove(p)
        for ri, r in enumerate(rows["reserve_names"]):
            pr = os.path.join(out_dir, f"{prefix}-{h}-{r}.csv.gz")
            frame(m[rows["reserve"][m] == ri]).to_csv(pr, index=False, float_format="%.6g",
                                                      compression={"method": "gzip", "compresslevel": 9})
            written.append(pr)
    return written


def write_units(path, rows):
    write_csv(path, ["unit", "reserve", "address"],
              [[i, rows["unit_res"][i], to_checksum(a)] for i, a in enumerate(rows["unit_addr"])])


# ---------------------------------------------------------------------------------------------
# Phases
# ---------------------------------------------------------------------------------------------
def load_main(datasets_dir, log=print):
    ctx = load_ctx(datasets_dir)
    res = [load_reserve(ctx, datasets_dir, r, log) for r in MAIN_RESERVES]
    return ctx, res


def dry_summary(ctx, reserves, rows, label):
    ok = rows["feat_ok"]
    fold_names = [f[0] for f in ctx.folds]
    out = {"note": f"{label}: rows, units, caps and feature coverage only; no exit counts, no rates, no score",
           "days": {"first": ctx.days[0], "last": ctx.days[-1], "n": ctx.D, "asof": ctx.asof},
           "reserves": {}, "candidate_rows": int(len(ok)), "rows_kept": int(ok.sum()),
           "rows_dropped_undefined_feature": int((~ok).sum()),
           "dropped_by_feature": {f: int((~np.isfinite(rows["X"][:, j])).sum()) for j, f in enumerate(FEATURES_V2)},
           "unlabelled_kept_rows": {h: int((ok & ~rows["RES"][:, hi]).sum()) for hi, h in enumerate(HNAMES)},
           "row_day_range": [ctx.days[int(rows["t"][ok].min())], ctx.days[int(rows["t"][ok].max())]] if ok.any()
           else None,
           "capped_cells": {}, "constrained_rows": {}, "folds": []}
    for ri, R in enumerate(reserves):
        m = ok & (rows["reserve"] == ri)
        out["reserves"][R.name] = {
            "units_universe": R.n, "units_P_r": int(sum(R.meta[a]["in_P_r"] for a in R.addrs)),
            "units_new": int(sum(R.meta[a]["new"] for a in R.addrs)), "anchor_status": R.anchor_status,
            "events": R.ev_info, "path_points": int(len(R.paths["v"])), "path_gate_replica": path_gate_check(ctx, R),
            "kept_rows": int(m.sum()), "units_with_rows": int(len(np.unique(rows["unit"][m]))),
            "scale_to_micro": R.scale, "listed_days": int(np.nansum(R.state["listed"][:ctx.D]))}
    test = ok & (rows["fold"] >= 0)
    for xi, x in enumerate(SIZES):
        ci = XCELL[0, xi]
        out["capped_cells"][f"x{x}"] = {
            "kept_rows": int((ok & rows["CAP"][:, ci]).sum()), "test_rows": int((test & rows["CAP"][:, ci]).sum()),
            "by_reserve_kept": {R.name: int((ok & rows["CAP"][:, ci] & (rows["reserve"] == ri)).sum())
                                for ri, R in enumerate(reserves)}}
    out["constrained_rows"] = {"kept_rows": int((ok & rows["constrained"]).sum()),
                               "test_rows": int((test & rows["constrained"]).sum())}
    for fi, (fn, qs, qe) in enumerate(ctx.folds):
        Tqs = int(ctx.T[qs])
        tem = (rows["fold"] == fi)
        fo = {"fold": fn, "q_start": ctx.days[qs], "q_end": ctx.days[qe] if qe < ctx.D else None,
              "feature_coverage_test": {f: float(np.isfinite(rows["X"][tem, j]).mean()) if tem.any() else None
                                        for j, f in enumerate(FEATURES_V2)},
              "cells": {}}
        trc = rows["T0"] + HSEC[0] <= Tqs
        fo["feature_coverage_train"] = {f: float(np.isfinite(rows["X"][trc, j]).mean()) if trc.any() else None
                                        for j, f in enumerate(FEATURES_V2)}
        for ci, c in enumerate(CELLS):
            hi = c["hi"]
            tr = train_mask_cell(rows["T0"], HSEC[hi], Tqs, rows["RES"][:, hi], rows["CAP"][:, ci], ok)
            te = tem & ok & rows["RES"][:, hi] & ~rows["CAP"][:, ci]
            fo["cells"][c["id"]] = {
                "train_rows": int(tr.sum()), "test_rows": int(te.sum()),
                "test_days": int(len(np.unique(rows["t"][te]))), "test_units": int(len(np.unique(rows["unit"][te]))),
                "test_units_without_train_rows": int(len(np.setdiff1d(np.unique(rows["unit"][te]),
                                                                      np.unique(rows["unit"][tr]))))}
        out["folds"].append(fo)
    return out


def phase_dryrun(datasets_dir, out_dir, log=print):
    t0 = time.time()
    shas = verify_inputs(datasets_dir)
    ctx, res = load_main(datasets_dir, log)
    rows = build_rows(ctx, res, compute_labels=False)
    out = {"phase": "dryrun", "prereg": PREREG, "datasets": DATASETS, "inputs_sha256": shas, "code": code_meta()}
    out.update(dry_summary(ctx, res, rows, "dry run"))
    out["runtime_s"] = time.time() - t0
    write_json(os.path.join(out_dir, "dryrun.json"), out)
    log(f"dryrun: {out['rows_kept']} rows kept of {out['candidate_rows']} -> {out_dir}/dryrun.json")
    return out


def assemble_predictions(rows, fits, test_idx, n_folds):
    n = len(rows["t"])
    PR = {k: np.full((n, NC), np.nan) for k in ("v1", "v2", "own", "pop", "v1_p0", "v2_p0")}
    fold_info = {}
    params = {}
    for r in fits:
        fi, ci, ver = r["fi"], r["ci"], r["ver"]
        te = test_idx[fi]
        PR[ver][te, ci] = r["p"]
        PR[ver + "_p0"][te, ci] = r["p0"]
        if ver == "v2":
            PR["own"][te, ci] = r["own"]
            PR["pop"][te, ci] = r["pop"]
        fold_info.setdefault(CELLS[ci]["id"], {}).setdefault(fi, {})[ver] = r["info"]
        params.setdefault(fi, {}).setdefault(CELLS[ci]["id"], {})[ver] = {"params": r["params"],
                                                                         "const_p0": r["const_p0"], "pop": r["pop"]}
    return PR, fold_info, params


def apply_fix(PR, rows, versions=VERSIONS):
    """Monotone fix per version on every row holding predictions; y_all cells untouched."""
    out = dict(PR)
    capx = rows["CAP"][:, XCELL[0]]
    for v in versions:
        P = PR[v]
        idx = np.nonzero(np.isfinite(P[:, XCELL]).all(axis=(1, 2)))[0]   # rows predicted in every x cell
        G = P[idx][:, XCELL]                                              # (n, NH, NX)
        Fx = monotone_fix_masked(G, capx[idx])
        Pn = P.copy()
        Pn[idx[:, None, None], XCELL[None, :, :]] = Fx
        out[v + "_raw"] = P
        out[v] = Pn
    return out


def phase_run(datasets_dir, out_dir, workers=4, log=print):
    results_path = os.path.join(out_dir, "results.json")
    if os.path.exists(results_path):
        raise SystemExit(f"STOP: {results_path} exists; the score phase runs once and never overwrites.")
    if not os.path.exists(os.path.join(out_dir, "dryrun.json")):
        raise SystemExit("STOP: run the dry run first.")
    t_start = time.time()
    shas = verify_inputs(datasets_dir)
    ctx, res = load_main(datasets_dir, log)
    rows = build_rows(ctx, res, compute_labels=True)
    log(f"rows: {len(rows['t'])} candidate, {int(rows['feat_ok'].sum())} kept")
    # panel units (current top 10 per reserve by asof anchor)
    panel = {}
    for ri, R in enumerate(res):
        ab = np.where(R.Av[:, ctx.D], R.A[:, ctx.D], -1)
        order = sorted(range(R.n), key=lambda i: (-int(ab[i]), R.addrs[i]))[:10]
        panel[R.name] = order
    panel_units = np.array([rows["unit_base"][r] + u for r in MAIN_RESERVES for u in panel[r]], dtype=np.int64)
    # fits
    tasks = [("fold", fi, ci, v) for fi in range(len(ctx.folds)) for ci in range(NC) for v in VERSIONS]
    tasks += [("asof", -1, ci, v) for ci in range(NC) for v in VERSIONS]
    log(f"fits: {len(tasks)} ...")
    fits, test_idx = run_fits(ctx, rows, tasks, panel_units=panel_units, workers=workers, log=log)
    fold_fits = [f for f in fits if f["kind"] == "fold"]
    asof_fits = [f for f in fits if f["kind"] == "asof"]
    PR, fold_info, fold_params = assemble_predictions(rows, fold_fits, test_idx, len(ctx.folds))
    PR = apply_fix(PR, rows)
    log("scoring ...")
    cells = score_cells(ctx, rows, PR, log)
    # G.9 history
    log("G.9 history ...")
    rowmap = {}
    order = np.argsort(rows["unit"], kind="mergesort")
    us, st_ = np.unique(rows["unit"][order], return_index=True)
    for k, u in enumerate(us):
        e = st_[k + 1] if k + 1 < len(st_) else len(order)
        rowmap[int(u)] = order[st_[k]:e]
    g9, g9_csv, ep_info = {}, [], {}
    for ri, R in enumerate(res):
        eps, in_ep, nsd = episodes_by_reserve(ctx, R)
        ep_info[R.name] = {"n_stress_days": nsd, "episodes": {ty: [{k: v for k, v in e.items() if k not in ("s", "e")}
                                                                   for e in eps[ty]] for ty in eps},
                           "ordinary_days": int((~in_ep).sum())}
        mx = np.where(R.Av[:, :ctx.D], R.A[:, :ctx.D], -1).max(axis=1)
        top20 = sorted(range(R.n), key=lambda i: (-int(mx[i]), R.addrs[i]))[:20]
        sel = list(dict.fromkeys(top20 + panel[R.name]))
        for u in sel:
            gu = rows["unit_base"][R.name] + u
            recs = g9_unit(ctx, rows, rowmap, gu, eps, in_ep)
            grp = "+".join(([f"top20_max#{top20.index(u) + 1}"] if u in top20 else []) +
                           ([f"top10_asof#{panel[R.name].index(u) + 1}"] if u in panel[R.name] else []))
            g9[f"{R.name}:{R.addrs[u]}"] = recs
            for rec in recs:
                c = CELLS[[cc["id"] for cc in CELLS].index(rec["cell"])]
                g9_csv.append([R.name, to_checksum(R.addrs[u]), grp, int(mx[u]) / MICRO, int(R.A[u, ctx.D]) / MICRO,
                               rec["type"], c["x"] if c["kind"] == "x" else "all", c["h"], rec["k"], rec["n"],
                               rec["n_capped"], rec["n_unlabelled"], rec["first"] or "", rec["last"] or "",
                               ";".join(rec["counted_dates"] or []), ";".join(rec["exit_dates"]),
                               "" if rec["fisher_p"] is None else rec["fisher_p"],
                               "" if rec["differs"] is None else rec["differs"], g9_statement(c, rec)])
    # panel numbers at asof
    log("panel ...")
    ap = {}
    for f in asof_fits:
        ap.setdefault(CELLS[f["ci"]]["id"], {})[f["ver"]] = f
    panel_out = {}
    pk = 0
    for ri, R in enumerate(res):
        units_l = panel[R.name]
        X, pinfo = panel_features(ctx, R, ri, units_l)
        grid = {v: np.full((len(units_l), NC), np.nan) for v in VERSIONS}
        for ci, c in enumerate(CELLS):
            for v in VERSIONS:
                f = ap[c["id"]][v]
                th = np.array(f["theta_panel"][pk:pk + len(units_l)])
                grid[v][:, ci], _ = predict_p(f["params"], f["const_p0"], X[:, :NF[v]], th)
        capx = np.array([[x * pi["bal"] > 100 * pi["cash"] for x in SIZES] for pi in pinfo])
        for v in VERSIONS:
            grid[v][:, XCELL] = monotone_fix_masked(grid[v][:, XCELL], capx)
        lst = []
        for k, u in enumerate(units_l):
            gu = rows["unit_base"][R.name] + u
            hist = {rec["cell"]: rec for rec in g9[f"{R.name}:{R.addrs[u]}"] if rec["type"] == "all"}
            cellv = {}
            for ci, c in enumerate(CELLS):
                shown = cells[c["id"]]["shown_model"]
                cp = c["kind"] == "x" and bool(capx[k, c["xi"]])
                cellv[c["id"]] = {"p": None if cp else float(grid[shown][k, ci]), "capped": cp,
                                  "capped_text": (f"capped: at most cash/balance = "
                                                  f"{pinfo[k]['cash'] / pinfo[k]['bal']:.1%} can leave now") if cp
                                  else None, "shown_model": shown, "label_preblind": cells[c["id"]]["label"],
                                  "history": g9_statement(c, hist[c["id"]]), "history_k": hist[c["id"]]["k"],
                                  "history_n": hist[c["id"]]["n"],
                                  "p_v1": None if cp else float(grid["v1"][k, ci]),
                                  "p_v2": None if cp else float(grid["v2"][k, ci])}
            lst.append({"rank": k + 1, "address": to_checksum(R.addrs[u]), "address_short": trunc(R.addrs[u]),
                        "unit": int(gu), "balance_usd": pinfo[k]["bal"] / MICRO,
                        "cash_usd": pinfo[k]["cash"] / MICRO, "share_of_supply": pinfo[k]["bal"] / pinfo[k]["supply"],
                        "features": dict(zip(FEATURES_V2, X[k].tolist())), "cells": cellv})
        pk += len(units_l)
        panel_out[R.name] = lst
    # outputs
    log("writing ...")
    pred_files = write_predictions(out_dir, ctx, rows, PR)
    write_units(os.path.join(out_dir, "units.csv"), rows)
    write_csv(os.path.join(out_dir, "b1-gradient.csv"),
              ["reserve", "address", "group", "max_daily_balance_usd", "asof_balance_usd", "type", "size", "horizon",
               "k", "n", "n_capped", "n_unlabelled", "first", "last", "counted_dates", "exit_dates",
               "fisher_p_vs_ordinary", "differs_from_ordinary", "statement"], g9_csv)
    write_csv(os.path.join(out_dir, "labels-preblind.csv"),
              ["cell", "kind", "size", "horizon", "shown_model", "label", "shippable", "n_ep", "R", "R_ci_lo",
               "R_ci_hi", "bss_v2_vs_own", "bss_v2_vs_pop", "bss_v2_vs_v1"],
              [[c["id"], c["kind"], c["x"] if c["x"] else "all", c["h"], cells[c["id"]]["shown_model"],
                cells[c["id"]]["label"], cells[c["id"]]["shippable"],
                cells[c["id"]]["g7"][cells[c["id"]]["shown_model"]]["n_ep"],
                cells[c["id"]]["g7"][cells[c["id"]]["shown_model"]]["R"],
                *(cells[c["id"]]["g7"][cells[c["id"]]["shown_model"]]["R_ci95"] or [None, None]),
                cells[c["id"]]["bss"]["v2_vs_own"]["bss"], cells[c["id"]]["bss"]["v2_vs_pop"]["bss"],
                cells[c["id"]]["bss"]["v2_vs_v1"]["bss"]] for c in CELLS])
    summary = {
        "prereg": PREREG, "datasets": DATASETS, "inputs_sha256": shas, "code": code_meta(), "decisions": DECISIONS,
        "deviations": DEVIATIONS, "cells_order": [c["id"] for c in CELLS],
        "features": {"v1": FEATURES_V1, "v2": FEATURES_V2},
        "days": {"first": ctx.days[0], "last": ctx.days[-1], "n": ctx.D, "asof": ctx.asof},
        "last_event": {R.name: R.ev_info["last_event_utc"] for R in res},
        "rows": {"candidate": int(len(rows["t"])), "kept": int(rows["feat_ok"].sum()),
                 "test_kept": int(((rows["fold"] >= 0) & rows["feat_ok"]).sum())},
        "dryrun_sha256": sha256_file(os.path.join(out_dir, "dryrun.json")),
        "cells": cells, "fold_fits": fold_info, "fold_params": fold_params,
        "asof_params": {cid: {v: {"params": f["params"], "const_p0": f["const_p0"], "pop": f["pop"],
                                  "info": f["info"]} for v, f in d.items()} for cid, d in ap.items()},
        "episodes": ep_info, "panel_preblind": panel_out, "prediction_files": [os.path.basename(p) for p in pred_files],
        "single_class_fits": sum(1 for f in fits if f["info"]["single_class"]),
        "convergence_warnings": sum(int(f["info"].get("n_convergence_warnings", 0)) for f in fits),
        "runtime_s": time.time() - t_start,
        "finished_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    write_json(results_path, summary, refuse_overwrite=True)
    log(f"run: results written -> {results_path} ({summary['runtime_s']:.0f} s)")
    return summary


def phase_freeze(out_dir, log=print):
    rp = os.path.join(out_dir, "results.json")
    sp = os.path.join(out_dir, "shipped-models.json")
    fr = os.path.join(out_dir, "freeze-record.json")
    if not os.path.exists(rp):
        raise SystemExit("STOP: no results.json; run the score phase first.")
    if os.path.exists(sp) or os.path.exists(fr):
        raise SystemExit("STOP: shipped-models.json exists; the freeze runs once.")
    res = json.load(open(rp))
    cells = {}
    for cid in res["cells_order"]:
        H = res["cells"][cid]
        cells[cid] = {"shown_model": H["shown_model"], "label_preblind": H["label"], "shippable_preblind":
                      H["shippable"], "pass_flags": H["pass_flags"],
                      "n_ep": H["g7"][H["shown_model"]]["n_ep"], "R": H["g7"][H["shown_model"]]["R"]}
    frozen = {"results_sha256": sha256_file(rp), "prereg": PREREG, "features": res["features"],
              "cells_order": res["cells_order"], "cells": cells, "fold_params": res["fold_params"],
              "folds": [f[0] for f in B.fold_list()], "asof_params": res["asof_params"],
              "rule": "shown model per cell (G14); fold models fit on USDC/USDT training rows only; holdout theta = 1",
              "frozen_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "code": code_meta()}
    write_json(sp, frozen, refuse_overwrite=True)
    rec = {"shipped_models_sha256": sha256_file(sp), "results_sha256": frozen["results_sha256"],
           "frozen_utc": frozen["frozen_utc"]}
    write_json(fr, rec, refuse_overwrite=True)
    log(f"freeze: shipped-models.json sha256 {rec['shipped_models_sha256']}")
    return rec


def load_holdouts(datasets_dir, log=print):
    ctx = load_ctx(datasets_dir)
    res = [load_reserve(ctx, datasets_dir, r, log) for r in HOLDOUT_RESERVES]
    return ctx, res


def phase_dryrun_holdout(datasets_dir, out_dir, log=print):
    t0 = time.time()
    shas = verify_inputs(datasets_dir, holdouts=True)
    ctx, res = load_holdouts(datasets_dir, log)
    rows = build_rows(ctx, res, compute_labels=False)
    out = {"phase": "dryrun-holdout", "prereg": PREREG, "inputs_sha256": shas, "code": code_meta()}
    out.update(dry_summary(ctx, res, rows, "holdout dry run"))
    out.pop("folds")  # no fit reads the holdouts
    out["test_rows_per_fold"] = {f[0]: int(((rows["fold"] == fi) & rows["feat_ok"]).sum())
                                 for fi, f in enumerate(ctx.folds)}
    out["runtime_s"] = time.time() - t0
    write_json(os.path.join(out_dir, "dryrun-holdout.json"), out)
    log(f"dryrun-holdout: {out['rows_kept']} rows kept of {out['candidate_rows']}")
    return out


def phase_blind(datasets_dir, out_dir, log=print):
    sp = os.path.join(out_dir, "shipped-models.json")
    fr = os.path.join(out_dir, "freeze-record.json")
    bp = os.path.join(out_dir, "results-blind.json")
    if not (os.path.exists(sp) and os.path.exists(fr)):
        raise SystemExit("STOP: the frozen shipped-models.json (and freeze-record.json) must exist first.")
    if os.path.exists(bp):
        raise SystemExit(f"STOP: {bp} exists; the blind check runs once and never overwrites.")
    rec = json.load(open(fr))
    if sha256_file(sp) != rec["shipped_models_sha256"]:
        raise SystemExit("STOP: shipped-models.json sha256 differs from the freeze record.")
    if sha256_file(os.path.join(out_dir, "results.json")) != rec["results_sha256"]:
        raise SystemExit("STOP: results.json changed after the freeze.")
    t0 = time.time()
    frozen = json.load(open(sp))
    shas = verify_inputs(datasets_dir, holdouts=True)
    ctx, res = load_holdouts(datasets_dir, log)
    rows = build_rows(ctx, res, compute_labels=True)
    fold_names = [f[0] for f in ctx.folds]
    n = len(rows["t"])
    PR = {k: np.full((n, NC), np.nan) for k in ("v1", "v2", "pop")}
    for fi, fn in enumerate(fold_names):
        te = np.nonzero((rows["fold"] == fi) & rows["feat_ok"])[0]
        if not len(te):
            continue
        for ci, c in enumerate(CELLS):
            fp = frozen["fold_params"][str(fi)][c["id"]]
            for v in VERSIONS:
                p, _ = predict_p(fp[v]["params"], fp[v]["const_p0"], rows["X"][te, :NF[v]], np.ones(len(te)))
                PR[v][te, ci] = p
            PR["pop"][te, ci] = fp["v2"]["pop"]
    PR = apply_fix(PR, rows)
    rn = rows["reserve_names"]
    test = (rows["fold"] >= 0) & rows["feat_ok"]
    cells_out, labels_rows = {}, []
    for ci, c in enumerate(CELLS):
        fz = frozen["cells"][c["id"]]
        shown = fz["shown_model"]
        m = np.nonzero(test & rows["RES"][:, c["hi"]] & ~rows["CAP"][:, ci])[0]
        y = rows["Y"][m, ci].astype(float)
        p = PR[shown][m, ci]
        ppop = PR["pop"][m, ci]
        pooled = {"n_rows": int(len(m)), "sum_y": int(y.sum()), "sum_p": float(p.sum()), "R": ratio_R(p.sum(), y.sum()),
                  "n_ep": n_episodes(rows["unit"][m], rows["t"][m], y),
                  "brier_shown": float(np.mean((p - y) ** 2)) if len(m) else None,
                  "brier_pop": float(np.mean((ppop - y) ** 2)) if len(m) else None}
        pooled["bss_shown_vs_pop"] = (1 - pooled["brier_shown"] / pooled["brier_pop"]) if (
            len(m) and pooled["brier_pop"] and pooled["brier_pop"] > 0) else None
        per = {}
        for ri, r in enumerate(rn):
            mm = rows["reserve"][m] == ri
            per[r] = {"n_rows": int(mm.sum()), "sum_y": int(y[mm].sum()), "sum_p": float(p[mm].sum()),
                      "R": ratio_R(p[mm].sum(), y[mm].sum()),
                      "n_ep": n_episodes(rows["unit"][m][mm], rows["t"][m][mm], y[mm])}
        other = "v1" if shown == "v2" else "v2"
        po = PR[other][m, ci]
        final, outcome = blind_confirm(fz["label_preblind"], pooled["R"], pooled["n_ep"])
        capinfo = None
        if c["kind"] == "x":
            cm = test & rows["RES"][:, c["hi"]] & rows["CAP"][:, ci]
            capinfo = {"n": int(cm.sum()), "realized_rate": float(rows["Y"][cm, ci].mean()) if cm.any() else None}
        cells_out[c["id"]] = {"shown_model": shown, "label_preblind": fz["label_preblind"], "pooled": pooled,
                              "per_reserve": per, "other_model": {"model": other, "R": ratio_R(po.sum(), y.sum())},
                              "blind_outcome": outcome, "label_final": final,
                              "shippable_final": bool(fz["shippable_preblind"] and final == "HIGH"),
                              "capped_holdout_test": capinfo}
        labels_rows.append([c["id"], c["kind"], c["x"] if c["x"] else "all", c["h"], shown, fz["label_preblind"],
                            outcome or "", final, cells_out[c["id"]]["shippable_final"], fz["n_ep"], fz["R"],
                            pooled["n_ep"], pooled["R"]])
        log(f"  blind {c['id']}: n_ep {pooled['n_ep']}, R {pooled['R']}, {fz['label_preblind']} -> {final}")
    write_csv(os.path.join(out_dir, "labels.csv"),
              ["cell", "kind", "size", "horizon", "shown_model", "label_preblind", "blind_outcome", "label_final",
               "shippable_final", "dev_n_ep", "dev_R", "holdout_n_ep", "holdout_R"], labels_rows)
    # final panel
    res_main = json.load(open(os.path.join(out_dir, "results.json")))
    prow = []
    panel_final = {}
    for r, lst in res_main["panel_preblind"].items():
        panel_final[r] = []
        for u in lst:
            cl = {}
            for cid, cv in u["cells"].items():
                cv = dict(cv)
                cv["label_final"] = cells_out[cid]["label_final"]
                cv["blind_outcome"] = cells_out[cid]["blind_outcome"]
                cl[cid] = cv
                c = CELLS[[cc["id"] for cc in CELLS].index(cid)]
                prow.append([r, u["rank"], u["address"], u["balance_usd"], u["share_of_supply"], cid,
                             c["x"] if c["x"] else "all", c["h"], "capped" if cv["capped"] else fmt(cv["p"]),
                             cv["capped_text"] or "", cv["label_final"], cv["blind_outcome"] or "",
                             cv["shown_model"], cv["history"] if cv["label_final"] in ("MEDIUM", "LOW", "STALE") else ""])
            panel_final[r].append(dict(u, cells=cl))
    write_csv(os.path.join(out_dir, "panel.csv"),
              ["reserve", "rank", "address", "balance_usd", "share_of_supply", "cell", "size", "horizon", "number",
               "capped_text", "label", "blind_outcome", "model", "history_count"], prow)
    write_predictions(out_dir, ctx, rows, PR, prefix="predictions-blind", fixed_names=("v2", "v1", "pop"))
    write_units(os.path.join(out_dir, "units-blind.csv"), rows)
    dry = dry_summary(ctx, res, rows, "holdout rows")
    dry.pop("folds")
    out = {"phase": "blind", "prereg": PREREG, "inputs_sha256": shas, "code": code_meta(),
           "frozen_sha256": rec["shipped_models_sha256"], "results_sha256": rec["results_sha256"],
           "decisions": DECISIONS, "deviations": DEVIATIONS, "holdouts": dry, "cells": cells_out,
           "label_counts": {"preblind": _count([v["label_preblind"] for v in cells_out.values()]),
                            "final": _count([v["label_final"] for v in cells_out.values()])},
           "panel_final": panel_final, "runtime_s": time.time() - t0,
           "finished_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    write_json(bp, out, refuse_overwrite=True)
    log(f"blind: results-blind.json written ({out['runtime_s']:.0f} s)")
    return out


def _count(v):
    out = {}
    for x in v:
        out[x] = out.get(x, 0) + 1
    return out


def phase_manifest(out_dir, log=print):
    files = {}
    for fn in sorted(os.listdir(out_dir)):
        p = os.path.join(out_dir, fn)
        if fn == "manifest.json" or not os.path.isfile(p):
            continue
        files[fn] = {"bytes": os.path.getsize(p), "sha256": sha256_file(p)}
    res = json.load(open(os.path.join(out_dir, "results.json")))
    man = {"files": files, "code": res.get("code"), "prereg": PREREG, "datasets": DATASETS,
           "inputs_sha256": res.get("inputs_sha256"), "runtime_s_run": res.get("runtime_s"),
           "manifest_code": code_meta(), "written_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    big = [f for f, v in files.items() if v["bytes"] >= 50_000_000]
    if big:
        raise SystemExit(f"STOP: files >= 50 MB: {big}")
    write_json(os.path.join(out_dir, "manifest.json"), man)
    log(f"manifest: {len(files)} files")
    return man


DEVIATIONS = []


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--datasets", help="membrane-datasets checkout")
    ap.add_argument("--out", required=True)
    ap.add_argument("--phase", required=True,
                    choices=("dryrun", "run", "freeze", "dryrun-holdout", "blind", "manifest"))
    ap.add_argument("--workers", type=int, default=4)
    a = ap.parse_args(argv)
    os.makedirs(a.out, exist_ok=True)
    if a.phase == "dryrun":
        phase_dryrun(a.datasets, a.out)
    elif a.phase == "run":
        phase_run(a.datasets, a.out, workers=a.workers)
    elif a.phase == "freeze":
        phase_freeze(a.out)
    elif a.phase == "dryrun-holdout":
        phase_dryrun_holdout(a.datasets, a.out)
    elif a.phase == "blind":
        phase_blind(a.datasets, a.out)
    else:
        phase_manifest(a.out)


if __name__ == "__main__":
    main()
