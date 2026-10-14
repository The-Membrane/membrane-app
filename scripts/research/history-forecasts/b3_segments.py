#!/usr/bin/env python3
"""Q26 workstream B3: segment-conditional confidence, cross-venue features, segment recalibration, a per-reserve
holdout rule, a blind test of the pooling term, and live panel inputs.

Implements membrane-board `design/DEPOSITOR_BEHAVIOR_PREREG_B3.md` (registered at commit cac7aeb, sha256
07113b5c...bb18) on top of the B-gradient design (`DEPOSITOR_BEHAVIOR_PREREG_B2.md`, D1-D3), whose code
(bg_gradient.py, scored at c41c0fa6) is imported unchanged: rows, intraday labels, cap, y_all, folds, the
v2 model, G.7 labels and the monotone fix all come from it. Every B3 constant below comes from the B3 file;
where it is silent the choice is listed in DECISIONS.

Phases (one fresh --out, in this order):
  --phase codes           eth_getCode at block 26,186,746 for holdout addresses missing from address-flags.csv
  --phase live-inputs     USDC/USDT reserve state at block 26,186,746 and at the block 24 h before (recorded)
  --phase dryrun          rows, segments, cross-venue coverage per fold; no outcome
  --phase run             USDC/USDT fit + score ONCE -> results.json (refuses overwrite)
  --phase freeze          shipped rung + label per (cell, segment) -> shipped-b3.json (+ sha256 record)
  --phase dryrun-holdout  holdout rows and segments; no outcome
  --phase holdout         per-reserve holdout rule + pooling-term test ONCE -> results-holdout.json
  --phase manifest        sha256 of every output
--workers N (default 2) sets the fit processes (fork; BLAS pinned to one thread).

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
from decimal import Decimal, getcontext  # noqa: E402

import numpy as np  # noqa: E402

getcontext().prec = 60

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import b_behavior as B  # noqa: E402
import bg_gradient as G  # noqa: E402

# ---------------------------------------------------------------------------------------------
# Registered constants (B3.1-B3.9)
# ---------------------------------------------------------------------------------------------
PREREG = {
    "repo": "membrane-board", "path": "design/DEPOSITOR_BEHAVIOR_PREREG_B3.md", "commit": "cac7aeb",
    "sha256": "07113b5ce40e93fcdcc6983dfafb70b4a7af6224c6ebf67e755893a94ab8bb18",
    "parents": {"B": "design/DEPOSITOR_BEHAVIOR_PREREG.md", "B-gradient": "design/DEPOSITOR_BEHAVIOR_PREREG_B2.md "
                "(5e45406; D1 f4e66b2, D2 567955a, D3 display)", "bg_gradient_scored_commit": "c41c0fa6"},
}
DATASETS = dict(G.DATASETS, **{"cross-venue": "d4aff1b"})
CV = "cross-venue/"
CV_PROV_SHA = "b568977e7b3d26ba28f0deefe0d35c13629a11ecaa3aa020fc91b9c1458170df"  # cross-venue/PROVENANCE.md (pins every file sha256)
CV_FILES = ("selected-tokens.csv", "share-paths-daily.csv.gz", "share-price-daily.csv.gz", "nesting.csv",
            "address-flags.csv")
ROUNDS_REL = "forecasts/q26-touch-live/rounds/eth-usd.csv.gz"

SEED_B3 = 20261050                        # B3.4
SEED_POOLTEST = 20261051                  # DECISION (pooling-term CIs; reported only, no registered seed)
M_UNIT = 3.0                              # G.5 unit theta
M_SEG = 50.0                              # B3.3 segment recalibration
BAND_EDGES_MICRO = (10_000_000 * G.MICRO, 50_000_000 * G.MICRO)   # B3.2 $1-10M | $10-50M | >= $50M
SEG_NAMES = ("wallet $1-10M", "wallet $10-50M", "wallet >=$50M", "contract $1-10M", "contract $10-50M",
             "contract >=$50M")
SEG_IDS = ("w1", "w2", "w3", "c1", "c2", "c3")
NSEG = len(SEG_NAMES)
XV_VENUE_MIN_USD = 100_000.0              # B3.3 count of other venues held > $100k
XV_DROP_KEEP = 0.9                        # B3.3 fell >= 10%
FREQ_OWN = 0.2                            # B3.8 frequent movers: training own-rate >= 0.2
BH_Q = 0.05                               # B3.8 Benjamini-Hochberg
LIVE_ASOF_BLOCK = 26186746                # B3.7 latest anchor
LIVE_ASOF_TS = 1791932759                 # 2026-10-13T23:05:59Z (depositor-events PROVENANCE)
HOLDOUT_RULE = ("DAI", "USDe")            # B3.6 (GHO reported only)
POOLTEST_FIRST = "2024Q4"                 # B3.6 folds 2024Q4 -> 2026Q3
RUNGS = ("v2", "v3", "v3s")              # simpler first (B3.4 tie keeps the simpler rung)
XV_FEATURES = ("is_contract", "band_10_50m", "band_50m_plus", "log1p_xv_usd", "xv_share", "xv_flow7_over_bal",
               "xv_drop10_7d", "xv_venues_100k", "xv_known")
FEATURES_V3 = G.FEATURES_V2 + XV_FEATURES
NF3 = {"v2": len(G.FEATURES_V2), "v3": len(FEATURES_V3)}
LABEL_RANK = {"HIGH": 3, "MEDIUM": 2, "LOW": 1, "STALE": 0}

DECISIONS = [
    "B3-1 everything not changed by B3 is bg_gradient.py at c41c0fa6 imported unchanged: rows (bal >= $1M at a "
    "daily 00:00Z anchor, features defined), intraday labels, liquidity cap, y_all, folds 2023Q4..2026Q3 with the "
    "t0 + h purge, the v2 model (13 features, logistic + unit EB m = 3), G.7 statistics and thresholds, the "
    "masked monotone fix (applied per rung to every test row before scoring), and bg DECISIONS G1-G13.",
    "B3-2 holder type: contract = address-flags.csv is_contract = 1 (code at block 26,186,746 that is not an "
    "EIP-7702 designator); wallet = is_contract = 0 (no code or a 7702 delegation). Holdout addresses missing from "
    "the file: one eth_getCode at block 26,186,746 on eth.drpc.org (phase codes, recorded in holdout-codes.json); "
    "code starting 0xef0100 with 23 bytes = 7702 delegation = wallet.",
    "B3-3 band at t0 from the exact anchor: [$1M, $10M), [$10M, $50M), >= $50M (micro-unit integers). segment = "
    "3 * is_contract + band (w1 w2 w3 c1 c2 c3).",
    "B3-4 cross-venue universe = the addresses of address-flags.csv (the 6,078 USDC/USDT universe addresses); "
    "xv_known = 1 for them, 0 otherwise (then every xv feature reads 0). Nested wrappers: a selected token that is "
    "a holder of type selected_token in nesting.csv (it holds another roster token) is excluded from every sum; "
    "no Morpho V2 adapter is a universe address, so none is excluded as a holder.",
    "B3-5 cross-venue value of a (token, address) at snapshot j = share balance (share-paths change points, held "
    "until the next row, 0 before the first) x price_num / price_den / 10^udec (USD); a missing or failed price "
    "takes the last ok price before it. Comet uses the same share path (principal) x index (the PROVENANCE "
    "approximation, gate 100%); comet-balances-daily.csv.gz is not read. Snapshot d (block before T_d) is "
    "strictly before t0 = T_d.",
    "B3-6 v3 features at t0 = T_d: log1p(sum of other-venue USD at d); xv_share = other / (other + bal(t0)) with "
    "bal(t0) the unit's own Aave Core balance (the unit is per reserve); xv_flow7 = sum over tokens of (shares(d) "
    "- shares(d-7)) x price(d) / 10^udec, divided by bal(t0) in USD (share changes = net flow, interest excluded); "
    "xv_drop10_7d = 1 iff some token's USD value V has V(d-7) > 0 and min(V(d-6..d)) <= 0.9 V(d-7) (value-based, "
    "so a vault loss counts); xv_venues_100k = number of selected (non-nested) tokens with V(d) > $100,000; "
    "is_contract; band indicators 10-50M and >= 50M. Before d = 7 the 7-day items read 0.",
    "B3-7 v3s: per fold and cell, theta_seg = (O + 50) / (E + 50) over the v3 training rows of each segment, O = "
    "their y, E = the sum of in-sample v3 probabilities after the unit theta; test p = odds(p_v3) x theta_seg (an "
    "odds multiplier after the unit theta), then the monotone fix. v3s shares v3's logistic fit and unit thetas.",
    "B3-8 comparisons (B3.4): per (cell, segment) on that segment's scored test rows, BSS of v2, v3, v3s vs pop and "
    "own, and of v3, v3s vs v2. One default_rng(20261050) stream; day-block draws (b_behavior.block_bootstrap_"
    "indices, block 30, 2,000 replicates) per (cell, segment) in the order h, x, segment for the 25 x cells; then "
    "the y_all cells (h, segment); then the pooled-over-segments sets (x cells h, x; then y_all h). A set with "
    "fewer than 30 test days gets no draw (no CI; it cannot be eligible or HIGH).",
    "B3-9 shipping (B3.4): eligible v2 iff it beats pop and own (CI lower bounds > 0) on the segment; eligible v3 "
    "(v3s) iff BSS vs v2 has a CI above 0, or the CI spans 0 and its label is HIGH while v2's is not. Ship = the "
    "eligible rung with the best label at that (cell, segment) (HIGH > MEDIUM > LOW > STALE), then the higher BSS "
    "vs pop, a tie keeps the simpler rung (v2 < v3 < v3s). No rung beating pop and own, or no eligible rung -> "
    "'population-rate history', label LOW. The (cell, segment) label = the shipped rung's label.",
    "B3-10 labels (B3.5): bg g7_block per rung per (cell, segment) on the segment's scored test rows (n_ep, R and "
    "its CI from the (cell, segment) draw, R deciles, fold coverage, per-reserve R, STALE). The pooled label uses "
    "the pooled draw; reported only.",
    "B3-11 holdout rule (B3.6): the frozen shipped rung per (cell, segment) predicts every holdout test row (fold "
    "models fit on USDC/USDT only, theta_i = 1, v3s with its frozen theta_seg), rung grids monotone-fixed, then the "
    "rung of the row's segment taken. A HIGH (cell, segment) stays HIGH iff DAI and USDe each, when n_ep >= 50 in "
    "that segment, have 0.67 <= R <= 1.5, and the DAI + USDe pool has n_ep >= 50 and 0.67 <= R <= 1.5. Any of "
    "these with enough episodes out of range -> MEDIUM 'failed transfer'; else pool n_ep < 50 -> MEDIUM "
    "'unconfirmed'. GHO is reported only.",
    "B3-12 pooling-term test (B3.6, reported only): DAI and USDe, folds 2024Q4..2026Q3. p0' = the frozen fold model "
    "of the (cell, segment)'s shipped rung (v2 where none ships) with theta = 1 (v3s keeps theta_seg). theta_i = "
    "(O_i + 3) / (E_i + 3) from the unit's holdout training rows of that reserve (t0 + h <= Q_start, labelled, "
    "uncapped, features defined) with E_i = sum of the same fold model's raw p0'. Both variants are monotone-fixed "
    "per rung grid. Baselines: pop = that reserve's training y rate in the cell, own = the unit's training rate "
    "(pop when none). BSS point estimates with day-block CIs from default_rng(20261051) (order cell, then DAI, "
    "USDe, pooled).",
    "B3-13 panel (B3.7): top 10 units per reserve by balance at block 26,186,746 (the asof_events anchor where the "
    "address has one, else the exact event reconstruction recon_balance_asof_raw). util, bAPR, cash, supply at "
    "26,186,746 and the true 1-day deltas against the last block with ts <= asof ts - 86,400 come from the "
    "live-inputs phase (eth.drpc.org, recorded). RV7 at asof = sqrt(8760 * mean(r^2)) over the 168 hourly log "
    "returns of the Chainlink ETH/USD answer in force at each hour end H0 - 168 h .. H0, H0 = asof floored to the "
    "hour (round store, rounds with updatedAt <= H). Own flows from every event in blocks <= 26,186,746. "
    "Cross-venue items at the asof snapshot, the 7-day base = the 2026-10-07 snapshot (the last daily one; 6.96 "
    "days before), the drop window = {asof_b1, asof}. Models = per cell and rung a refit on every labelled, "
    "uncapped row (theta_seg from the same refit). Each rung grid is monotone-fixed, the shipped rung of the "
    "unit's segment is taken per cell (population rate of that segment's refit rows where none ships, label LOW), "
    "then the composite 2-D fix (D3) with capped cells left out. Capped: 'capped now: cash covers at most N% of "
    "this balance' (N = 100 cash / bal, one decimal). y_all is shown as history only (k of n days).",
    "B3-14 B3.8: frequent movers = test rows whose unit's training own rate in that fold and cell is >= 0.2; BSS "
    "without them reuses each set's draw restricted to the remaining rows. 7 d R per segment and per recent fold "
    "(2025Q4..2026Q3). y_all constrained rows (cash < bal) per rung, restricted pooled draw. B1 k-of-n for the "
    "panel units (bg g9_unit) with Benjamini-Hochberg at 0.05 over every stress-vs-ordinary Fisher p of those "
    "units.",
    "B3-15 the live-inputs and codes phases read chain state only (no outcome) and refuse to overwrite. The "
    "asof reserve state (not in the datasets for USDC/USDT) is read with the 24-h-before state, both recorded.",
]

# ---------------------------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------------------------
sha256_file = B.sha256_file
write_json = B.write_json
to_checksum = B.to_checksum
trunc = B.trunc
ratio_R = G.ratio_R


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
        "last_commit_b3_segments": git("log", "-1", "--format=%H", "--", os.path.basename(me)),
        "b3_segments_sha256": sha256_file(me),
        "b3_segments_dirty": bool(git("status", "--porcelain", "--", os.path.basename(me))),
        "bg_gradient_sha256": sha256_file(os.path.join(here, "bg_gradient.py")),
        "bg_gradient_last_commit": git("log", "-1", "--format=%H", "--", "bg_gradient.py"),
        "b_behavior_sha256": sha256_file(os.path.join(here, "b_behavior.py")),
        "python": sys.version.split()[0], "numpy": np.__version__,
        "sklearn": __import__("sklearn").__version__, "scipy": __import__("scipy").__version__,
        "pandas": __import__("pandas").__version__,
    }


def verify_cv(datasets_dir):
    p = os.path.join(datasets_dir, CV, "PROVENANCE.md")
    txt = open(p).read()
    table = dict(re.findall(r"\|\s*`([^`]+)`\s*\|\s*\d+\s*\|\s*`([0-9a-f]{64})`\s*\|", txt))
    out = {CV + "PROVENANCE.md": sha256_file(p)}
    if out[CV + "PROVENANCE.md"] != CV_PROV_SHA:
        raise SystemExit(f"STOP: {CV}PROVENANCE.md sha256 {out[CV + 'PROVENANCE.md']} != {CV_PROV_SHA}")
    for fn in CV_FILES:
        got = sha256_file(os.path.join(datasets_dir, CV, fn))
        if table.get(fn) != got:
            raise SystemExit(f"STOP: sha256 mismatch for {CV}{fn}: {got} != {table.get(fn)}")
        out[CV + fn] = got
    return out


def verify_inputs(datasets_dir, holdouts=False):
    out = G.verify_inputs(datasets_dir, holdouts=holdouts)
    out.update(verify_cv(datasets_dir))
    return out


# ---------------------------------------------------------------------------------------------
# Core definitions (unit-tested on synthetic data)
# ---------------------------------------------------------------------------------------------
def band_of(bal_micro):
    """B3.2: 0 = [$1M, $10M), 1 = [$10M, $50M), 2 = >= $50M (exact micro-unit integers)."""
    b = np.asarray(bal_micro, dtype=np.int64)
    return (b >= BAND_EDGES_MICRO[0]).astype(np.int8) + (b >= BAND_EDGES_MICRO[1]).astype(np.int8)


def segment_of(is_contract, band):
    return (3 * np.asarray(is_contract, dtype=np.int8) + np.asarray(band, dtype=np.int8)).astype(np.int8)


def code_kind(code_hex):
    """eth_getCode result -> (is_contract, eip7702). A 7702 designator (0xef0100 + 20-byte address) is a wallet."""
    c = (code_hex or "0x").lower()
    body = c[2:] if c.startswith("0x") else c
    if body == "":
        return False, False
    if body.startswith("ef0100") and len(body) == 46:
        return False, True
    return True, False


def odds_mult(p, k):
    p = np.asarray(p, float)
    k = np.asarray(k, float)
    return p * k / (1.0 - p + p * k)


def theta_segments(y, p_ins, seg, m=M_SEG, nseg=NSEG):
    """B3.3 v3s: theta_seg = (O + m) / (E + m) per segment over training rows."""
    O = np.bincount(np.asarray(seg, dtype=np.int64), weights=np.asarray(y, float), minlength=nseg)
    E = np.bincount(np.asarray(seg, dtype=np.int64), weights=np.asarray(p_ins, float), minlength=nseg)
    return (O + m) / (E + m), O, E


def pair_series(idx, shares, n_snap):
    """Change points (snapshot index, shares) sorted by index -> shares at every snapshot (0 before the first)."""
    idx = np.asarray(idx, dtype=np.int64)
    shares = np.asarray(shares, float)
    pos = np.searchsorted(idx, np.arange(n_snap), side="right") - 1
    return np.where(pos >= 0, shares[np.maximum(pos, 0)], 0.0)


def ffill_price(price):
    """Missing (NaN) prices take the last valid price before them; leading NaNs take the first valid one."""
    p = np.asarray(price, float).copy()
    ok = np.isfinite(p)
    if not ok.any():
        return p
    last = np.where(ok, np.arange(len(p)), -1)
    last = np.maximum.accumulate(last)
    first = int(np.argmax(ok))
    last = np.where(last < 0, first, last)
    return p[last]


def xv_pair_contrib(S, price, udec, D):
    """Per (token, address) contributions over snapshots 0..D+1 (daily 0..D-1, asof_b1 = D, asof = D+1):
    value V (USD), 7-day flow (USD), 7-day >= 10% drop flag, venue > $100k flag."""
    scale = 10.0 ** udec
    V = S * price / scale
    n = len(S)
    FL = np.zeros(n)
    DR = np.zeros(n, dtype=bool)
    if D > 7:
        FL[7:D] = (S[7:D] - S[0:D - 7]) * price[7:D] / scale
        from numpy.lib.stride_tricks import sliding_window_view
        mins = sliding_window_view(V[1:D], 7).min(axis=1)          # min V(d-6..d) for d = 7..D-1
        base = V[0:D - 7]
        DR[7:D] = (base > 0) & (mins <= XV_DROP_KEEP * base)
    if n >= D + 2 and D >= 1:                                       # asof: base = the last daily snapshot
        FL[D + 1] = (S[D + 1] - S[D - 1]) * price[D + 1] / scale
        base = V[D - 1]
        DR[D + 1] = (base > 0) and (min(V[D], V[D + 1]) <= XV_DROP_KEEP * base)
    CNT = V > XV_VENUE_MIN_USD
    return V, FL, DR, CNT


def bh_reject(pvals, q=BH_Q):
    """Benjamini-Hochberg step-up: boolean reject mask for the given p-values (None/NaN never rejected)."""
    p = np.array([np.nan if v is None else float(v) for v in pvals], float)
    ok = np.isfinite(p)
    m = int(ok.sum())
    rej = np.zeros(len(p), bool)
    if m == 0:
        return rej
    idx = np.nonzero(ok)[0]
    order = idx[np.argsort(p[idx], kind="mergesort")]
    thresh = q * np.arange(1, m + 1) / m
    below = p[order] <= thresh
    if below.any():
        k = int(np.nonzero(below)[0].max())
        rej[order[:k + 1]] = True
    return rej


def rv7_from_rounds(updated_at, answer, H0):
    """sqrt(8760 * mean(r^2)) over the 168 hourly log returns of the answer in force at H0 - 168 h .. H0."""
    ua = np.asarray(updated_at, dtype=np.int64)
    ans = np.asarray(answer, float)
    o = np.argsort(ua, kind="mergesort")
    ua, ans = ua[o], ans[o]
    hours = H0 - 3600 * np.arange(168, -1, -1)
    pos = np.searchsorted(ua, hours, side="right") - 1
    if (pos < 0).any():
        raise SystemExit("STOP: round store does not cover H0 - 168 h")
    c = ans[pos]
    r = np.diff(np.log(c))
    return float(math.sqrt(8760.0 * float(np.mean(r * r)))), c


def ship_rung(flags, labels, bss_pop):
    """B3.4 (B3-9). flags[r] = {'pop': ci_above_0, 'own': ..., 'v2': ci_above_0 vs v2, 'v2_span': CI spans 0};
    labels[r] in HIGH/MEDIUM/LOW/STALE; bss_pop[r] point BSS vs pop. Returns (rung or None, eligible list)."""
    elig = []
    if flags["v2"]["pop"] and flags["v2"]["own"]:
        elig.append("v2")
    for r in ("v3", "v3s"):
        f = flags[r]
        if f["v2"] or (f["v2_span"] and labels[r] == "HIGH" and labels["v2"] != "HIGH"):
            elig.append(r)
    any_beats = any(flags[r]["pop"] and flags[r]["own"] for r in RUNGS)
    if not any_beats or not elig:
        return None, elig
    best = None
    for r in RUNGS:                      # simpler first; strict improvement needed to displace
        if r not in elig:
            continue
        key = (LABEL_RANK[labels[r]], -np.inf if bss_pop[r] is None else bss_pop[r])
        if best is None or key > best[0]:
            best = (key, r)
    return best[1], elig


def holdout_rule(label, per_reserve, pool):
    """B3.6 (B3-11): per_reserve {name: (n_ep, R)} for DAI/USDe; pool (n_ep, R). Returns (final label, outcome)."""
    if label != "HIGH":
        return label, None
    bad = False
    for name, (n_ep, R) in per_reserve.items():
        if n_ep >= G.BLIND_NEP and not G._within(R, G.BLIND_R):
            bad = True
    if pool[0] >= G.BLIND_NEP and not G._within(pool[1], G.BLIND_R):
        bad = True
    if bad:
        return "MEDIUM", "failed transfer"
    if pool[0] < G.BLIND_NEP:
        return "MEDIUM", "unconfirmed"
    return "HIGH", "confirmed"


def composite_fix(grid_x, capx):
    """D3: the displayed x grid (NH, NX) of one unit gets the 2-D fix again, capped cells left out."""
    return G.monotone_fix_masked(np.asarray(grid_x, float)[None], np.asarray(capx, bool)[None])[0]


# ---------------------------------------------------------------------------------------------
# Loading: holder type, cross-venue
# ---------------------------------------------------------------------------------------------
def load_flags(datasets_dir):
    out = {}
    with open(os.path.join(datasets_dir, CV, "address-flags.csv")) as f:
        for r in csv.DictReader(f):
            out[r["address"].lower()] = {"contract": r["is_contract"] == "1", "eip7702": r["eip7702_delegated"] == "1",
                                         "adapter": r["morpho_v2_adapter_of"] != ""}
    return out


def load_holdout_codes(out_dir):
    p = os.path.join(out_dir, "holdout-codes.json")
    if not os.path.exists(p):
        return None, None
    d = json.load(open(p))
    return {a: {"contract": v["is_contract"], "eip7702": v["eip7702"], "adapter": False}
            for a, v in d["codes"].items()}, sha256_file(p)


class XV:
    pass


def load_xv(datasets_dir, ctx, log=print):
    """Cross-venue per-address arrays over snapshots 0..D+1 (B3-4..B3-6)."""
    import pandas as pd
    D = ctx.D
    nsnap = D + 2
    toks = pd.read_csv(os.path.join(datasets_dir, CV, "selected-tokens.csv"), dtype=str)
    meta = {r["address"].lower(): {"udec": int(r["udec"]), "family": r["family"], "symbol": r["symbol"],
                                   "kind": r["kind"]} for _, r in toks.iterrows()}
    nest = pd.read_csv(os.path.join(datasets_dir, CV, "nesting.csv"), dtype=str)
    nested = sorted({h.lower() for h, k in zip(nest["holder"], nest["holder_kind"]) if k == "selected_token"})
    adapters = sorted({h.lower() for h, k in zip(nest["holder"], nest["holder_kind"]) if k == "morpho_v2_adapter"})
    snap_index = dict(ctx.day_index)
    snap_index["asof_b1"] = D
    snap_index["asof"] = D + 1
    pr = pd.read_csv(os.path.join(datasets_dir, CV, "share-price-daily.csv.gz"), dtype=str, keep_default_na=False)
    pr = pr[pr["snapshot"].isin(snap_index.keys())]
    price = {}
    n_fail = 0
    for tok, g in pr.groupby(pr["token"].str.lower()):
        arr = np.full(nsnap, np.nan)
        for s, num, den, st in zip(g["snapshot"], g["price_num"], g["price_den"], g["status"]):
            if st == "ok" and num != "" and den != "" and Decimal(den) != 0:
                arr[snap_index[s]] = float(Decimal(num) / Decimal(den))   # Comet num/den may carry decimals
            else:
                n_fail += 1
        price[tok] = ffill_price(arr)
    sp = pd.read_csv(os.path.join(datasets_dir, CV, "share-paths-daily.csv.gz"), dtype=str, keep_default_na=False)
    sp["j"] = sp["snapshot"].map(snap_index)
    if sp["j"].isna().any():
        raise SystemExit("STOP: unknown snapshot in share-paths-daily")
    sp["tok"] = sp["token"].str.lower()
    sp["addr"] = sp["address"].str.lower()
    keep = ~sp["tok"].isin(nested) & ~sp["addr"].isin(adapters)
    n_nested_rows = int((~keep).sum())
    sp = sp[keep]
    addrs = sorted(sp["addr"].unique())
    aidx = {a: i for i, a in enumerate(addrs)}
    n = len(addrs)
    X = XV()
    X.OV = np.zeros((n, nsnap))
    X.FL = np.zeros((n, nsnap))
    X.DR = np.zeros((n, nsnap), dtype=bool)
    X.CNT = np.zeros((n, nsnap), dtype=np.int16)
    n_pairs = 0
    for (tok, a), g in sp.groupby(["tok", "addr"], sort=True):
        g = g.sort_values("j", kind="mergesort")
        S = pair_series(g["j"].to_numpy(np.int64), np.array([float(int(x)) for x in g["shares_raw"]]), nsnap)
        if tok not in price:
            raise SystemExit(f"STOP: no price for token {tok}")
        V, FL, DR, CNT = xv_pair_contrib(S, price[tok], meta[tok]["udec"], D)
        i = aidx[a]
        X.OV[i] += V
        X.FL[i] += FL
        X.DR[i] |= DR
        X.CNT[i] += CNT.astype(np.int16)
        n_pairs += 1
    X.addrs = addrs
    X.aidx = aidx
    X.flags = load_flags(datasets_dir)
    X.info = {"tokens_selected": len(meta), "nested_tokens_excluded": [meta.get(t, {}).get("symbol", t) for t in nested],
              "nested_share_path_rows_dropped": n_nested_rows, "adapters_in_nesting": len(adapters),
              "adapters_in_universe": sum(1 for a in adapters if a in X.flags),
              "pairs": n_pairs, "addresses_with_paths": n, "price_rows_not_ok": n_fail,
              "universe_addresses": len(X.flags)}
    log(f"  cross-venue: {n_pairs} pairs, {n} addresses, nested tokens excluded {X.info['nested_tokens_excluded']}")
    return X


def unit_contract(rows, flags_main, flags_extra=None):
    out = np.zeros(rows["n_units"], dtype=np.int8)
    missing = []
    for u, a in enumerate(rows["unit_addr"]):
        f = flags_main.get(a) or (flags_extra or {}).get(a)
        if f is None:
            missing.append(a)
            continue
        out[u] = 1 if f["contract"] else 0
    return out, missing


def b3_features(rows, X, contract_unit, j=None):
    """Append the 9 B3.3 features to rows['X'] -> X3 (n, 22); also band and segment per row."""
    n = len(rows["t"])
    jj = rows["t"] if j is None else np.full(n, j)
    bal = rows["bal"]
    band = band_of(bal)
    cu = contract_unit[rows["unit"]]
    seg = segment_of(cu, band)
    ai = np.array([X.aidx.get(rows["unit_addr"][u], -1) for u in range(rows["n_units"])], dtype=np.int64)[rows["unit"]]
    known = np.array([1.0 if rows["unit_addr"][u] in X.flags else 0.0 for u in range(rows["n_units"])])[rows["unit"]]
    has = ai >= 0
    aa = np.maximum(ai, 0)
    ov = np.where(has, X.OV[aa, jj], 0.0)
    fl = np.where(has, X.FL[aa, jj], 0.0)
    dr = np.where(has, X.DR[aa, jj], False).astype(float)
    cnt = np.where(has, X.CNT[aa, jj], 0).astype(float)
    balu = bal.astype(float) / G.MICRO
    X3 = np.column_stack([rows["X"], cu.astype(float), (band == 1).astype(float), (band == 2).astype(float),
                          np.log1p(ov), ov / (ov + balu), fl / balu, dr, cnt, known])
    return X3, band, seg


# ---------------------------------------------------------------------------------------------
# Fits
# ---------------------------------------------------------------------------------------------
_G3 = {}


def _fit_task(task):
    kind, fi, ci, ver = task
    rows = _G3["rows"]
    X = rows["X3"][:, :NF3[ver]]
    c = G.CELLS[ci]
    hi = c["hi"]
    if kind == "fold":
        Tqs = int(_G3["T"][_G3["folds"][fi][1]])
        tr = G.train_mask_cell(rows["T0"], G.HSEC[hi], Tqs, rows["RES"][:, hi], rows["CAP"][:, ci], rows["feat_ok"])
    else:
        tr = rows["RES"][:, hi] & ~rows["CAP"][:, ci] & rows["feat_ok"]
    tri = np.nonzero(tr)[0]
    y = rows["Y"][tri, ci].astype(float)
    m = G.fit_cell_model(X[tri], y, rows["unit"][tri], rows["n_units"])
    p_ins, _ = G.predict_p(m["params"], m["const_p0"], X[tri], m["theta"][rows["unit"][tri]])
    tseg, O_s, E_s = theta_segments(y, p_ins, rows["seg"][tri])
    seg_pop = np.where(np.bincount(rows["seg"][tri], minlength=NSEG) > 0,
                       O_s / np.maximum(np.bincount(rows["seg"][tri], minlength=NSEG), 1), np.nan)
    info = dict(m["info"], n_train_exits=int(y.sum()), pop_rate=m["pop"], seg_O=O_s.tolist(), seg_E=E_s.tolist())
    res = {"kind": kind, "fi": fi, "ci": ci, "ver": ver, "params": m["params"], "const_p0": m["const_p0"],
           "pop": m["pop"], "theta_seg": tseg.tolist(), "seg_pop": seg_pop.tolist(), "info": info}
    if kind == "fold":
        te = _G3["test_idx"][fi]
        p, p0 = G.predict_p(m["params"], m["const_p0"], X[te], m["theta"][rows["unit"][te]])
        res.update(p=p, own=m["own"][rows["unit"][te]])
        if ver == "v3":
            res["p_s"] = odds_mult(p, tseg[rows["seg"][te]])
    else:
        sel = _G3["panel_units"]
        res.update(theta_panel=m["theta"][sel].tolist())
    return res


def run_fits(ctx, rows, tasks, panel_units, workers=2, log=print):
    import multiprocessing as mp
    _G3.clear()
    _G3.update(rows=rows, T=ctx.T, folds=ctx.folds, panel_units=panel_units,
               test_idx=[np.nonzero((rows["fold"] == fi) & rows["feat_ok"])[0] for fi in range(len(ctx.folds))])
    out = []
    t0 = time.time()
    if workers <= 1:
        for tk in tasks:
            out.append(_fit_task(tk))
    else:
        with mp.get_context("fork").Pool(workers) as pool:
            for i, r in enumerate(pool.imap_unordered(_fit_task, tasks, chunksize=1)):
                out.append(r)
                if (i + 1) % 60 == 0:
                    log(f"    {i + 1}/{len(tasks)} fits ({time.time() - t0:.0f} s)")
    return out, _G3["test_idx"]


def assemble(rows, fits, test_idx):
    n = len(rows["t"])
    PR = {k: np.full((n, G.NC), np.nan) for k in ("v2", "v3", "v3s", "own", "pop")}
    params = {}
    finfo = {}
    for r in fits:
        fi, ci, ver = r["fi"], r["ci"], r["ver"]
        te = test_idx[fi]
        PR[ver][te, ci] = r["p"]
        if ver == "v3":
            PR["v3s"][te, ci] = r["p_s"]
        else:
            PR["own"][te, ci] = r["own"]
            PR["pop"][te, ci] = r["pop"]
        cid = G.CELLS[ci]["id"]
        params.setdefault(fi, {}).setdefault(cid, {})[ver] = {"params": r["params"], "const_p0": r["const_p0"],
                                                             "pop": r["pop"], "theta_seg": r["theta_seg"]}
        finfo.setdefault(cid, {}).setdefault(fi, {})[ver] = r["info"]
    return PR, params, finfo


def fix_rungs(PR, rows, rungs=RUNGS):
    return G.apply_fix(PR, rows, versions=rungs)


# ---------------------------------------------------------------------------------------------
# Scoring per (cell, segment)
# ---------------------------------------------------------------------------------------------
COMP3 = (("v2_vs_pop", "v2", "pop"), ("v2_vs_own", "v2", "own"), ("v3_vs_pop", "v3", "pop"),
         ("v3_vs_own", "v3", "own"), ("v3_vs_v2", "v3", "v2"), ("v3s_vs_pop", "v3s", "pop"),
         ("v3s_vs_own", "v3s", "own"), ("v3s_vs_v2", "v3s", "v2"))
_EMPTY_BSS = {"bss": None, "ci95": None, "ci_above_0": False, "ci_below_0": False}


def set_order():
    """B3-8 draw order: x cells (h, x, segment); y_all cells (h, segment); pooled x (h, x); pooled y_all (h)."""
    order = []
    for hi in range(G.NH):
        for xi in range(G.NX):
            for s in range(NSEG):
                order.append((int(G.XCELL[hi, xi]), s))
    for hi in range(G.NH):
        for s in range(NSEG):
            order.append((int(G.ACELL[hi]), s))
    for hi in range(G.NH):
        for xi in range(G.NX):
            order.append((int(G.XCELL[hi, xi]), None))
    for hi in range(G.NH):
        order.append((int(G.ACELL[hi]), None))
    return order


def score_set(Q, pr, dd, cb, fold_names, reserve_names):
    """BSS comparisons and per-rung G.7 for one (cell, segment-or-pooled) set."""
    y = Q["y"]
    nd = len(dd)
    pos = np.searchsorted(dd, Q["t"])
    out = {"n": {"rows": int(len(y)), "days": int(nd), "units": int(len(np.unique(Q["unit"]))), "exits": int(y.sum()),
                 "n_ep": G.n_episodes(Q["unit"], Q["t"], y)},
           "brier": {k: float(np.mean((pr[k] - y) ** 2)) if len(y) else None for k in pr}, "bss": {}, "g7": {}}
    for cname, a, b in COMP3:
        if cb is None:
            o = dict(_EMPTY_BSS)
            sb = float(np.sum((pr[b] - y) ** 2))
            o["bss"] = float(1 - np.sum((pr[a] - y) ** 2) / sb) if sb > 0 else None
            out["bss"][cname] = o
        else:
            out["bss"][cname] = G.bss_ci(pos, nd, pr[a], pr[b], y, cb)
    for r in RUNGS:
        if cb is None or len(y) == 0:
            out["g7"][r] = {"label": "LOW", "n_ep": out["n"]["n_ep"], "R": ratio_R(pr[r].sum(), y.sum()),
                            "R_ci95": None, "note": "fewer than 30 test days: no draw"}
        else:
            out["g7"][r] = G.g7_block(Q, pr[r], pos, nd, cb, fold_names, reserve_names)
    return out


def flags_of(S):
    f = {}
    for r in RUNGS:
        b = S["bss"]
        f[r] = {"pop": bool(b[f"{r}_vs_pop"]["ci_above_0"]), "own": bool(b[f"{r}_vs_own"]["ci_above_0"])}
        if r != "v2":
            ci = b[f"{r}_vs_v2"]["ci95"]
            f[r]["v2"] = bool(b[f"{r}_vs_v2"]["ci_above_0"])
            f[r]["v2_span"] = bool(ci is not None and ci[0] <= 0 <= ci[1])
    return f


def score_b3(ctx, rows, PR, log=print):
    fold_names = [f[0] for f in ctx.folds]
    rn = rows["reserve_names"]
    test = (rows["fold"] >= 0) & rows["feat_ok"]
    order = set_order()
    sets = []
    for ci, s in order:
        hi = G.CELLS[ci]["hi"]
        m = test & rows["RES"][:, hi] & ~rows["CAP"][:, ci]
        if s is not None:
            m &= rows["seg"] == s
        idx = np.nonzero(m)[0]
        sets.append((ci, s, idx, np.unique(rows["t"][idx])))
    rng = np.random.default_rng(SEED_B3)
    cells = {}
    pooled = {}
    recent = set(range(len(fold_names) - G.STALE_FOLDS, len(fold_names)))
    for ci, s, idx, dd in sets:
        c = G.CELLS[ci]
        nd = len(dd)
        cb = B.replicate_counts(B.block_bootstrap_indices(rng, nd, G.BLOCK_DAYS, G.N_BOOT), nd) \
            if nd >= G.BLOCK_DAYS else None
        Q = {"y": rows["Y"][idx, ci].astype(float), "t": rows["t"][idx], "unit": rows["unit"][idx],
             "reserve": rows["reserve"][idx], "fold": rows["fold"][idx]}
        pr = {k: PR[k][idx, ci] for k in ("v2", "v3", "v3s", "own", "pop")}
        if any(np.isnan(v).any() for v in pr.values()):
            raise SystemExit(f"STOP: missing prediction in {c['id']} segment {s}")
        S = score_set(Q, pr, dd, cb, fold_names, rn)
        # B3.8 frequent movers excluded (restricted draw)
        keep = pr["own"] < FREQ_OWN
        pos = np.searchsorted(dd, Q["t"])
        S["no_frequent_movers"] = {"rows": int(keep.sum()), "exits": int(Q["y"][keep].sum()), "bss": {
            cname: (G.bss_ci(pos[keep], nd, pr[a][keep], pr[b][keep], Q["y"][keep], cb) if cb is not None else None)
            for cname, a, b in COMP3}, "R": {r: ratio_R(pr[r][keep].sum(), Q["y"][keep].sum()) for r in RUNGS}}
        # B3.8 7 d R per recent fold
        if c["h"] == "7d":
            S["recent_fold_R"] = {fold_names[f]: {r: ratio_R(pr[r][Q["fold"] == f].sum(), Q["y"][Q["fold"] == f].sum())
                                                  for r in RUNGS} | {"exits": int(Q["y"][Q["fold"] == f].sum())}
                                  for f in sorted(recent)}
        # B3.8 y_all constrained rows (pooled sets)
        if c["kind"] == "all" and s is None:
            con = rows["constrained"][idx]
            S["constrained"] = {"rows": int(con.sum()), "exits": int(Q["y"][con].sum()),
                                "n_ep": G.n_episodes(Q["unit"][con], Q["t"][con], Q["y"][con]),
                                "bss": {cname: G.bss_ci(pos[con], nd, pr[a][con], pr[b][con], Q["y"][con], cb)
                                        for cname, a, b in COMP3},
                                "R": {r: ratio_R(pr[r][con].sum(), Q["y"][con].sum()) for r in RUNGS},
                                "R_ci95": {r: G.r_ci(pos[con], nd, pr[r][con], Q["y"][con], cb)[0] for r in RUNGS}}
        if s is None:
            pooled[c["id"]] = S
            log(f"  pooled {c['id']}: " + " ".join(f"{r} {S['g7'][r]['label']}" for r in RUNGS))
            continue
        fl = flags_of(S)
        labels = {r: S["g7"][r]["label"] for r in RUNGS}
        bss_pop = {r: S["bss"][f"{r}_vs_pop"]["bss"] for r in RUNGS}
        rung, elig = ship_rung(fl, labels, bss_pop)
        S["flags"] = fl
        S["eligible"] = elig
        S["shipped"] = rung
        S["label"] = labels[rung] if rung else "LOW"
        S["display"] = "model" if rung else "population-rate history"
        cells.setdefault(c["id"], {})[SEG_IDS[s]] = S
        log(f"  {c['id']} {SEG_IDS[s]}: rows {S['n']['rows']} n_ep {S['n']['n_ep']} -> {rung} {S['label']}")
    return cells, pooled


# ---------------------------------------------------------------------------------------------
# Live inputs (RPC; recorded) and panel
# ---------------------------------------------------------------------------------------------
def read_reserve_state_rpc(rpc, block, phase):
    import b_acquire as BA
    calls = []
    for r in BA.RESERVE_ORDER:
        a = BA.RESERVES[r]
        calls += [(BA.POOL, BA.call_data("getReserveData", a["asset"])), (a["atoken"], BA.call_data("totalSupply")),
                  (a["asset"], BA.call_data("balanceOf", a["atoken"]))]
    res = rpc.multicall(calls, block, phase, tag=f"state {block}")
    out = {}
    for k, r in enumerate(BA.RESERVE_ORDER):
        rd = BA.decode_reserve_data(*res[3 * k])
        if rd["status"] != "ok":
            raise SystemExit(f"STOP: getReserveData {r} at {block}: {rd['status']}")
        out[r] = {"variableBorrowRate_ray": rd["currentVariableBorrowRate"], "liquidityRate_ray": rd["currentLiquidityRate"],
                  "variableDebtToken": rd["variableDebtTokenAddress"], "totalSupply": BA.decode_uint(res[3 * k + 1][1]),
                  "cash": BA.decode_uint(res[3 * k + 2][1])}
    calls2 = [(out[r]["variableDebtToken"], BA.call_data("totalSupply")) for r in BA.RESERVE_ORDER]
    res2 = rpc.multicall(calls2, block, phase, tag=f"debt {block}")
    for k, r in enumerate(BA.RESERVE_ORDER):
        out[r]["variableDebt"] = BA.decode_uint(res2[k][1])
        s = out[r]
        s["util"] = s["variableDebt"] / s["totalSupply"]
        s["bapr_pct"] = s["variableBorrowRate_ray"] / 10 ** 25
        s["sapr_pct"] = s["liquidityRate_ray"] / 10 ** 25
        for k2 in ("variableBorrowRate_ray", "liquidityRate_ray", "totalSupply", "cash", "variableDebt"):
            s[k2] = str(s[k2])
    return out


def phase_live_inputs(out_dir, log=print):
    import b_acquire as BA
    p = os.path.join(out_dir, "live-inputs.json")
    if os.path.exists(p):
        raise SystemExit(f"STOP: {p} exists (read once).")
    rpc = BA.Rpc(BA.RPC_URL, os.path.join(out_dir, "live-inputs-rpc-events.jsonl"))
    blk = rpc.block_obj(LIVE_ASOF_BLOCK, "live")
    ts = int(blk["timestamp"], 16)
    if ts != LIVE_ASOF_TS:
        raise SystemExit(f"STOP: asof block ts {ts} != {LIVE_ASOF_TS}")
    T = LIVE_ASOF_TS - 86400 + 1                                   # largest block with ts <= asof - 24 h
    b24, ts24, tsn = BA.find_block_before(T, lambda b: rpc.block_ts(b, "live"), LIVE_ASOF_BLOCK - 7200,
                                          head=LIVE_ASOF_BLOCK)
    out = {"rpc": BA.RPC_URL, "user_agent": BA.USER_AGENT,
           "asof": {"block": LIVE_ASOF_BLOCK, "ts": ts, "hash": blk["hash"],
                    "state": read_reserve_state_rpc(rpc, LIVE_ASOF_BLOCK, "live")},
           "minus24h": {"block": b24, "ts": ts24, "next_ts": tsn, "rule": "largest block with ts <= asof ts - 86400",
                        "state": read_reserve_state_rpc(rpc, b24, "live")},
           "rpc_counts": rpc.counts, "read_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "code": code_meta()}
    write_json(p, out, refuse_overwrite=True)
    log(f"live-inputs: asof {LIVE_ASOF_BLOCK}, minus24h {b24} ({ts24}) -> {p}")
    return out


def phase_codes(datasets_dir, out_dir, log=print):
    import b_acquire as BA
    p = os.path.join(out_dir, "holdout-codes.json")
    if os.path.exists(p):
        raise SystemExit(f"STOP: {p} exists (read once).")
    flags = load_flags(datasets_dir)
    need = set()
    for r in G.HOLDOUT_RESERVES:
        with open(os.path.join(datasets_dir, G.HO, r, "extended-universe.csv")) as f:
            for row in csv.DictReader(f):
                a = row["address"].lower()
                if a not in flags:
                    need.add(a)
    need = sorted(need)
    rpc = BA.Rpc(BA.RPC_URL, os.path.join(out_dir, "holdout-codes-rpc-events.jsonl"))
    codes = {}
    t0 = time.time()
    for i, a in enumerate(need):
        def v(res):
            if not isinstance(res, str) or not res.startswith("0x"):
                raise BA.DecodeError("bad code")
        code = rpc.call("eth_getCode", [a, hex(LIVE_ASOF_BLOCK)], "codes", tag=a, validate=v)
        ic, e7 = code_kind(code)
        codes[a] = {"is_contract": ic, "eip7702": e7, "code_bytes": (len(code) - 2) // 2, "prefix": code[:8]}
        if (i + 1) % 100 == 0:
            log(f"  codes {i + 1}/{len(need)} ({time.time() - t0:.0f} s)")
    out = {"block": LIVE_ASOF_BLOCK, "rpc": BA.RPC_URL, "n": len(codes), "codes": codes, "rpc_counts": rpc.counts,
           "read_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "code": code_meta(),
           "counts": {"contract": sum(v["is_contract"] for v in codes.values()),
                      "eip7702": sum(v["eip7702"] for v in codes.values())}}
    write_json(p, out, refuse_overwrite=True)
    log(f"codes: {len(codes)} addresses -> {p}")
    return out


def load_rounds(datasets_dir):
    import pandas as pd
    p = os.path.join(datasets_dir, ROUNDS_REL)
    df = pd.read_csv(p, dtype=str)
    df = df[df["roundId"] != "roundId"]
    return df["updatedAt"].astype(np.int64).to_numpy(), df["answer"].astype(float).to_numpy(), sha256_file(p)


def live_balances(datasets_dir, R):
    """Balance at block 26,186,746: the asof_events anchor where present, else recon_balance_asof_raw."""
    recon = {}
    with open(os.path.join(datasets_dir, G.DE, "extended-universe.csv")) as f:
        for r in csv.DictReader(f):
            if r["reserve"] == R.name:
                recon[r["address"].lower()] = int(r["recon_balance_asof_raw"])
    D = R.A.shape[1] - 2
    out, src, diffs = np.zeros(R.n, dtype=np.int64), [], []
    for u, a in enumerate(R.addrs):
        if R.filled[u, D + 1] and R.Av[u, D + 1]:
            out[u] = int(R.A[u, D + 1])
            src.append("anchor")
            diffs.append(abs(int(R.A[u, D + 1]) - recon[a]))
        else:
            out[u] = recon[a]
            src.append("recon")
    return out, src, (max(diffs) if diffs else None)


def panel_compute(ctx, res, rows, X, contract_unit, live, rv7, asof_fits, cells_ship, g9_all, log=print):
    """B3.7 current-day panel (numbers per (x, h) with the shipped rung of the unit's segment)."""
    D = ctx.D
    out = {}
    pk = 0
    ap = {}
    for f in asof_fits:
        ap.setdefault(G.CELLS[f["ci"]]["id"], {})[f["ver"]] = f
    for ri, R in enumerate(res):
        units = _G3_panel[R.name]
        st, s24 = live["asof"]["state"][R.name], live["minus24h"]["state"][R.name]
        util, bapr = st["util"], st["bapr_pct"]
        cash, sup = int(st["cash"]), int(st["totalSupply"])
        t0b = G.first_big_day(R.A, R.Av, D)
        lst = []
        for k, u in enumerate(units):
            bal = int(_G3_panel_bal[R.name][k])
            m = R.logs["unit"] == u
            f7, dc, ds = G.own_flow_at(R.logs["ts"][m], R.logs["delta_f"][m], R.logs["block"][m], LIVE_ASOF_TS,
                                       LIVE_ASOF_BLOCK)
            age = (LIVE_ASOF_TS - int(ctx.T[t0b[u]])) / G.DAY if t0b[u] >= 0 else 0.0
            x2 = [util, util - s24["util"], bapr, bapr - s24["bapr_pct"], rv7, math.log10(bal / G.MICRO),
                  math.log1p(age), R.is_usdt, math.log(cash / bal), bal / sup, f7 / bal, math.log1p(dc),
                  math.log1p(ds)]
            gu = rows["unit_base"][R.name] + u
            a = R.addrs[u]
            cu = int(contract_unit[gu])
            band = int(band_of([bal])[0])
            seg = int(segment_of([cu], [band])[0])
            ai = X.aidx.get(a, -1)
            if ai >= 0:
                ov, fl, dr, cnt = X.OV[ai, D + 1], X.FL[ai, D + 1], float(X.DR[ai, D + 1]), float(X.CNT[ai, D + 1])
            else:
                ov = fl = dr = cnt = 0.0
            balu = bal / G.MICRO
            x3 = x2 + [cu, float(band == 1), float(band == 2), math.log1p(ov), ov / (ov + balu), fl / balu, dr, cnt,
                       1.0 if a in X.flags else 0.0]
            xr = np.array(x3, float)[None]
            grid = {r: np.full(G.NC, np.nan) for r in RUNGS}
            for ci, c in enumerate(G.CELLS):
                for ver in ("v2", "v3"):
                    f = ap[c["id"]][ver]
                    th = np.array([f["theta_panel"][pk + k]])
                    p, _ = G.predict_p(f["params"], f["const_p0"], xr[:, :NF3[ver]], th)
                    grid[ver][ci] = p[0]
                    if ver == "v3":
                        grid["v3s"][ci] = odds_mult(p, f["theta_seg"][seg])[0]
            capx = np.array([x * bal > 100 * cash for x in G.SIZES])
            for r in RUNGS:
                grid[r][G.XCELL] = G.monotone_fix_masked(grid[r][G.XCELL][None], capx[None])[0]
            comp = np.full(G.NC, np.nan)
            shown = {}
            for ci, c in enumerate(G.CELLS):
                sh = cells_ship.get(c["id"], {}).get(SEG_IDS[seg], {}).get("shipped")
                shown[c["id"]] = sh
                if sh:
                    comp[ci] = grid[sh][ci]
                else:
                    comp[ci] = ap[c["id"]]["v2"]["seg_pop"][seg]
            comp[G.XCELL] = composite_fix(comp[G.XCELL], capx)
            hist = {rec["cell"]: rec for rec in g9_all.get(f"{R.name}:{a}", []) if rec["type"] == "all"}
            cv = {}
            for ci, c in enumerate(G.CELLS):
                cp = c["kind"] == "x" and bool(capx[c["xi"]])
                h = hist.get(c["id"])
                cv[c["id"]] = {
                    "p": None if cp or c["kind"] == "all" else float(comp[ci]),
                    "p_model_y_all": float(comp[ci]) if c["kind"] == "all" else None,
                    "capped": cp, "capped_text": f"capped now: cash covers at most {100 * cash / bal:.1f}% of this "
                                                 f"balance" if cp else None,
                    "rung": shown[c["id"]], "display": "history" if c["kind"] == "all" else (
                        "model" if shown[c["id"]] else "population-rate history"),
                    "history": G.g9_statement(c, h) if h else None, "history_k": h["k"] if h else None,
                    "history_n": h["n"] if h else None,
                    "rung_values": {r: (None if cp else float(grid[r][ci])) for r in RUNGS}}
            lst.append({"rank": k + 1, "address": to_checksum(a), "address_short": trunc(a), "unit": int(gu),
                        "balance_usd": bal / G.MICRO, "balance_source": _G3_panel_src[R.name][k],
                        "segment": SEG_IDS[seg], "segment_name": SEG_NAMES[seg], "share_of_supply": bal / sup,
                        "cash_usd": cash / G.MICRO, "features": dict(zip(FEATURES_V3, x3)), "cells": cv})
        pk += len(units)
        out[R.name] = lst
    return out


_G3_panel, _G3_panel_bal, _G3_panel_src = {}, {}, {}


# ---------------------------------------------------------------------------------------------
# Writers
# ---------------------------------------------------------------------------------------------
def write_predictions(out_dir, ctx, rows, PR, prefix, keys, max_bytes=45_000_000):
    import pandas as pd
    test = (rows["fold"] >= 0) & rows["feat_ok"]
    fold_names = np.array([f[0] for f in ctx.folds])
    days = np.array(ctx.days)
    written = []
    for hi, h in enumerate(G.HNAMES):
        cis = list(G.XCELL[hi]) + [int(G.ACELL[hi])]
        m = np.nonzero(test & rows["RES"][:, hi])[0]
        m = m[np.lexsort((rows["t"][m], rows["unit"][m]))]

        def frame(idx):
            cols = {"unit": rows["unit"][idx], "date": days[rows["t"][idx]], "fold": fold_names[rows["fold"][idx]],
                    "segment": np.array(SEG_IDS)[rows["seg"][idx]]}
            for c in cis[:G.NX]:
                cols[f"cap_{G.CELLS[c]['id']}"] = rows["CAP"][idx, c].astype(np.int8)
            for c in cis:
                cols[f"y_{G.CELLS[c]['id']}"] = rows["Y"][idx, c]
            for k in keys:
                for c in cis:
                    v = PR[k][idx, c].copy()
                    if c in cis[:G.NX]:
                        v[rows["CAP"][idx, c]] = np.nan
                    cols[f"{k}_{G.CELLS[c]['id']}"] = v
            return pd.DataFrame(cols)

        p = os.path.join(out_dir, f"{prefix}-{h}.csv.gz")
        frame(m).to_csv(p, index=False, float_format="%.6g", compression={"method": "gzip", "compresslevel": 9})
        if os.path.getsize(p) <= max_bytes:
            written.append(p)
            continue
        os.remove(p)
        for ri, r in enumerate(rows["reserve_names"]):
            pr_ = os.path.join(out_dir, f"{prefix}-{h}-{r}.csv.gz")
            frame(m[rows["reserve"][m] == ri]).to_csv(pr_, index=False, float_format="%.6g",
                                                      compression={"method": "gzip", "compresslevel": 9})
            written.append(pr_)
    return written


# ---------------------------------------------------------------------------------------------
# Phases
# ---------------------------------------------------------------------------------------------
def build_main(datasets_dir, out_dir, compute_labels, log=print):
    ctx, res = G.load_main(datasets_dir, log)
    rows = G.build_rows(ctx, res, compute_labels=compute_labels)
    X = load_xv(datasets_dir, ctx, log)
    cu, missing = unit_contract(rows, X.flags)
    if missing:
        raise SystemExit(f"STOP: {len(missing)} USDC/USDT universe addresses missing from address-flags.csv")
    rows["X3"], rows["band"], rows["seg"] = b3_features(rows, X, cu)
    rows["contract_unit"] = cu
    return ctx, res, rows, X


def dry_counts(ctx, rows, label):
    ok = rows["feat_ok"]
    test = ok & (rows["fold"] >= 0)
    out = {"note": f"{label}: rows, segments, cross-venue coverage; no exit counts, no rates, no score",
           "rows_kept": int(ok.sum()), "test_rows": int(test.sum()),
           "segments_kept_rows": {SEG_IDS[s]: int((ok & (rows["seg"] == s)).sum()) for s in range(NSEG)},
           "segments_test_rows": {SEG_IDS[s]: int((test & (rows["seg"] == s)).sum()) for s in range(NSEG)},
           "segment_units": {SEG_IDS[s]: int(len(np.unique(rows["unit"][ok & (rows["seg"] == s)]))) for s in range(NSEG)},
           "contract_units_with_rows": int(rows["contract_unit"][np.unique(rows["unit"][ok])].sum()),
           "xv_known_rows": int((ok & (rows["X3"][:, -1] == 1)).sum()),
           "xv_holding_rows": int((ok & (rows["X3"][:, 16] > 0)).sum()),
           "xv_feature_summary": {f: {"mean": float(np.mean(rows["X3"][ok, 13 + j])),
                                      "nonzero_share": float(np.mean(rows["X3"][ok, 13 + j] != 0))}
                                  for j, f in enumerate(XV_FEATURES)},
           "per_fold": []}
    for fi, (fn, qs, qe) in enumerate(ctx.folds):
        te = ok & (rows["fold"] == fi)
        cell = {}
        for s in range(NSEG):
            m = te & (rows["seg"] == s)
            cell[SEG_IDS[s]] = {"test_rows": int(m.sum()), "test_days": int(len(np.unique(rows["t"][m]))),
                                "test_units": int(len(np.unique(rows["unit"][m])))}
        out["per_fold"].append({"fold": fn, "segments": cell,
                                "xv_holding_share_test": float(np.mean(rows["X3"][te, 16] > 0)) if te.any() else None})
    return out


def phase_dryrun(datasets_dir, out_dir, log=print):
    t0 = time.time()
    shas = verify_inputs(datasets_dir)
    ctx, res, rows, X = build_main(datasets_dir, out_dir, False, log)
    out = {"phase": "dryrun", "prereg": PREREG, "inputs_sha256": shas, "code": code_meta(), "xv": X.info}
    out.update(dry_counts(ctx, rows, "dry run"))
    out["test_days_per_x24h_segment"] = {}
    for s in range(NSEG):
        ci = int(G.XCELL[2, 2])
        m = rows["feat_ok"] & (rows["fold"] >= 0) & rows["RES"][:, 2] & ~rows["CAP"][:, ci] & (rows["seg"] == s)
        out["test_days_per_x24h_segment"][SEG_IDS[s]] = int(len(np.unique(rows["t"][m])))
    out["runtime_s"] = time.time() - t0
    write_json(os.path.join(out_dir, "dryrun.json"), out)
    log(f"dryrun: {out['rows_kept']} rows; segments {out['segments_test_rows']}")
    return out


def phase_run(datasets_dir, out_dir, workers=2, log=print):
    rp = os.path.join(out_dir, "results.json")
    if os.path.exists(rp):
        raise SystemExit(f"STOP: {rp} exists; the score phase runs once and never overwrites.")
    for need in ("dryrun.json", "live-inputs.json"):
        if not os.path.exists(os.path.join(out_dir, need)):
            raise SystemExit(f"STOP: {need} missing; run its phase first.")
    t_start = time.time()
    shas = verify_inputs(datasets_dir)
    live = json.load(open(os.path.join(out_dir, "live-inputs.json")))
    ctx, res, rows, X = build_main(datasets_dir, out_dir, True, log)
    ua, ans, rsha = load_rounds(datasets_dir)
    H0 = LIVE_ASOF_TS - LIVE_ASOF_TS % 3600
    rv7, closes = rv7_from_rounds(ua[ua <= LIVE_ASOF_TS], ans[ua <= LIVE_ASOF_TS], H0)
    # panel units at block 26,186,746
    for R in res:
        bal, src, maxdiff = live_balances(datasets_dir, R)
        order = sorted(range(R.n), key=lambda i: (-int(bal[i]), R.addrs[i]))[:10]
        _G3_panel[R.name] = order
        _G3_panel_bal[R.name] = [int(bal[i]) for i in order]
        _G3_panel_src[R.name] = [src[i] for i in order]
    panel_units = np.array([rows["unit_base"][r] + u for r in G.MAIN_RESERVES for u in _G3_panel[r]], dtype=np.int64)
    tasks = [("fold", fi, ci, v) for fi in range(len(ctx.folds)) for ci in range(G.NC) for v in ("v2", "v3")]
    tasks += [("asof", -1, ci, v) for ci in range(G.NC) for v in ("v2", "v3")]
    log(f"fits: {len(tasks)} with {workers} workers ...")
    fits, test_idx = run_fits(ctx, rows, tasks, panel_units, workers=workers, log=log)
    ff = [f for f in fits if f["kind"] == "fold"]
    af = [f for f in fits if f["kind"] == "asof"]
    PR, fparams, finfo = assemble(rows, ff, test_idx)
    PR = fix_rungs(PR, rows)
    log("scoring ...")
    cells, pooled = score_b3(ctx, rows, PR, log)
    # sanity: v2 is the scored B-gradient v2 (pooled-set Brier vs history-forecasts/bg results.json)
    bgp = os.path.join(datasets_dir, "history-forecasts/bg/run-c41c0fa6/results.json")
    v2_check = None
    if os.path.exists(bgp):
        bgr = json.load(open(bgp))
        v2_check = {cid: {"b3_pooled_v2": pooled[cid]["brier"]["v2"], "bg_v2": bgr["cells"][cid]["brier"]["v2"],
                          "rows_b3": pooled[cid]["n"]["rows"], "rows_bg": bgr["cells"][cid]["n"]["rows"]}
                    for cid in pooled}
    # B1 history for the panel units with BH
    log("history + panel ...")
    order = np.argsort(rows["unit"], kind="mergesort")
    us, st_ = np.unique(rows["unit"][order], return_index=True)
    rowmap = {int(u): order[st_[k]:(st_[k + 1] if k + 1 < len(st_) else len(order))] for k, u in enumerate(us)}
    g9, g9_csv, pvals, prefs = {}, [], [], []
    for R in res:
        eps, in_ep, _ = G.episodes_by_reserve(ctx, R)
        for k, u in enumerate(_G3_panel[R.name]):
            gu = rows["unit_base"][R.name] + u
            recs = G.g9_unit(ctx, rows, rowmap, gu, eps, in_ep)
            g9[f"{R.name}:{R.addrs[u]}"] = recs
            for rec in recs:
                if rec["fisher_p"] is not None:
                    pvals.append(rec["fisher_p"])
                    prefs.append((R.name, R.addrs[u], rec))
    rej = bh_reject(pvals)
    for (r, a, rec), rj in zip(prefs, rej):
        rec["bh_reject"] = bool(rj)
    for key, recs in g9.items():
        r, a = key.split(":")
        for rec in recs:
            c = G.CELLS[[cc["id"] for cc in G.CELLS].index(rec["cell"])]
            g9_csv.append([r, to_checksum(a), rec["type"], c["x"] if c["kind"] == "x" else "all", c["h"], rec["k"],
                           rec["n"], rec["n_capped"], rec["n_unlabelled"], rec["first"] or "", rec["last"] or "",
                           ";".join(rec["counted_dates"] or []), ";".join(rec["exit_dates"]),
                           "" if rec["fisher_p"] is None else rec["fisher_p"], rec.get("bh_reject", ""),
                           G.g9_statement(c, rec)])
    panel = panel_compute(ctx, res, rows, X, rows["contract_unit"], live, rv7, af, cells, g9, log)
    log("writing ...")
    pred = write_predictions(out_dir, ctx, rows, PR, "predictions-test", ("v2", "v3", "v3s", "own", "pop"))
    G.write_units(os.path.join(out_dir, "units.csv"), rows)
    G.write_csv(os.path.join(out_dir, "b1-panel-history.csv"),
                ["reserve", "address", "type", "size", "horizon", "k", "n", "n_capped", "n_unlabelled", "first",
                 "last", "counted_dates", "exit_dates", "fisher_p_vs_ordinary", "bh_reject_q05", "statement"], g9_csv)
    lab = []
    for c in G.CELLS:
        for s in SEG_IDS:
            S = cells[c["id"]][s]
            lab.append([c["id"], s, S["shipped"] or "", S["label"], S["n"]["rows"], S["n"]["n_ep"],
                        S["g7"][S["shipped"]]["R"] if S["shipped"] else None,
                        S["bss"]["v2_vs_pop"]["bss"], S["bss"]["v3_vs_v2"]["bss"], S["bss"]["v3s_vs_v2"]["bss"]])
    G.write_csv(os.path.join(out_dir, "labels-preholdout.csv"),
                ["cell", "segment", "shipped", "label", "rows", "n_ep", "R_shipped", "bss_v2_vs_pop", "bss_v3_vs_v2",
                 "bss_v3s_vs_v2"], lab)
    summary = {
        "prereg": PREREG, "datasets": DATASETS, "inputs_sha256": shas, "rounds_sha256": rsha,
        "live_inputs_sha256": sha256_file(os.path.join(out_dir, "live-inputs.json")),
        "dryrun_sha256": sha256_file(os.path.join(out_dir, "dryrun.json")), "code": code_meta(),
        "decisions": DECISIONS, "deviations": DEVIATIONS, "features": {"v2": G.FEATURES_V2, "v3": FEATURES_V3},
        "segments": dict(zip(SEG_IDS, SEG_NAMES)), "xv": X.info, "cells": cells, "pooled": pooled,
        "fold_params": fparams, "fold_fits": finfo,
        "asof_params": {G.CELLS[f["ci"]]["id"] + ":" + f["ver"]: {"params": f["params"], "const_p0": f["const_p0"],
                                                                  "pop": f["pop"], "theta_seg": f["theta_seg"],
                                                                  "seg_pop": f["seg_pop"], "info": f["info"]}
                        for f in af},
        "panel_preholdout": panel, "panel_inputs": {"rv7": rv7, "H0": H0, "rv7_closes_first_last": [closes[0], closes[-1]],
                                                    "live": {k: live[k] for k in ("asof", "minus24h")}},
        "b1_panel_bh": {"n_tests": len(pvals), "n_reject": int(rej.sum())}, "v2_equals_bg_check": v2_check,
        "prediction_files": [os.path.basename(p) for p in pred],
        "single_class_fits": sum(1 for f in fits if f["info"]["single_class"]),
        "convergence_warnings": sum(int(f["info"].get("n_convergence_warnings", 0)) for f in fits),
        "runtime_s": time.time() - t_start, "finished_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    write_json(rp, summary, refuse_overwrite=True)
    log(f"run: results -> {rp} ({summary['runtime_s']:.0f} s)")
    return summary


def phase_freeze(out_dir, log=print):
    rp = os.path.join(out_dir, "results.json")
    sp = os.path.join(out_dir, "shipped-b3.json")
    fr = os.path.join(out_dir, "freeze-record.json")
    if not os.path.exists(rp):
        raise SystemExit("STOP: no results.json.")
    if os.path.exists(sp) or os.path.exists(fr):
        raise SystemExit("STOP: the freeze runs once.")
    res = json.load(open(rp))
    cells = {cid: {s: {"shipped": v["shipped"], "label": v["label"], "eligible": v["eligible"],
                       "labels_by_rung": {r: v["g7"][r]["label"] for r in RUNGS}}
                   for s, v in d.items()} for cid, d in res["cells"].items()}
    frozen = {"results_sha256": sha256_file(rp), "prereg": PREREG, "features": res["features"], "cells": cells,
              "fold_params": res["fold_params"], "asof_params": res["asof_params"],
              "folds": [f[0] for f in B.fold_list()], "segments": res["segments"],
              "frozen_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "code": code_meta()}
    write_json(sp, frozen, refuse_overwrite=True)
    rec = {"shipped_b3_sha256": sha256_file(sp), "results_sha256": frozen["results_sha256"],
           "frozen_utc": frozen["frozen_utc"]}
    write_json(fr, rec, refuse_overwrite=True)
    log(f"freeze: shipped-b3.json sha256 {rec['shipped_b3_sha256']}")
    return rec


def build_holdouts(datasets_dir, out_dir, compute_labels, log=print):
    ctx, res = G.load_holdouts(datasets_dir, log)
    rows = G.build_rows(ctx, res, compute_labels=compute_labels)
    X = load_xv(datasets_dir, ctx, log)
    extra, csha = load_holdout_codes(out_dir)
    if extra is None:
        raise SystemExit("STOP: holdout-codes.json missing; run --phase codes first.")
    cu, missing = unit_contract(rows, X.flags, extra)
    if missing:
        raise SystemExit(f"STOP: {len(missing)} holdout addresses without a code flag")
    rows["X3"], rows["band"], rows["seg"] = b3_features(rows, X, cu)
    rows["contract_unit"] = cu
    return ctx, res, rows, X, csha


def phase_dryrun_holdout(datasets_dir, out_dir, log=print):
    t0 = time.time()
    shas = verify_inputs(datasets_dir, holdouts=True)
    ctx, res, rows, X, csha = build_holdouts(datasets_dir, out_dir, False, log)
    out = {"phase": "dryrun-holdout", "prereg": PREREG, "inputs_sha256": shas, "holdout_codes_sha256": csha,
           "code": code_meta()}
    out.update(dry_counts(ctx, rows, "holdout dry run"))
    out["per_reserve_segments_test"] = {r: {SEG_IDS[s]: int(((rows["fold"] >= 0) & rows["feat_ok"] & (rows["seg"] == s)
                                                             & (rows["reserve"] == ri)).sum()) for s in range(NSEG)}
                                        for ri, r in enumerate(rows["reserve_names"])}
    out["runtime_s"] = time.time() - t0
    write_json(os.path.join(out_dir, "dryrun-holdout.json"), out)
    log(f"dryrun-holdout: {out['per_reserve_segments_test']}")
    return out


def predict_frozen(rows, frozen, fi, idx):
    """Raw rung predictions (n_idx, NC) for rows idx from the frozen fold-fi models with theta_i = 1."""
    out = {r: np.full((len(idx), G.NC), np.nan) for r in RUNGS}
    th = np.ones(len(idx))
    for ci, c in enumerate(G.CELLS):
        fp = frozen["fold_params"][str(fi)][c["id"]]
        for ver in ("v2", "v3"):
            p, _ = G.predict_p(fp[ver]["params"], fp[ver]["const_p0"], rows["X3"][idx, :NF3[ver]], th)
            out[ver][:, ci] = p
            if ver == "v3":
                out["v3s"][:, ci] = odds_mult(p, np.asarray(fp["v3"]["theta_seg"])[rows["seg"][idx]])
    return out


def fix_grid(P, cap_rows):
    """Per-rung monotone fix of an (n, NC) prediction array; capped x cells NaN; y_all untouched."""
    out = P.copy()
    out[:, G.XCELL] = G.monotone_fix_masked(P[:, G.XCELL], cap_rows[:, G.XCELL[0]])
    return out


def pick_shipped(rows, idx, F, frozen):
    """Per row and cell, the frozen shipped rung of the row's segment (v2 where none ships) -> (p, rung codes)."""
    n = len(idx)
    p = np.full((n, G.NC), np.nan)
    code = np.zeros((n, G.NC), dtype=np.int8)
    seg = rows["seg"][idx]
    for ci, c in enumerate(G.CELLS):
        for s in range(NSEG):
            sh = frozen["cells"][c["id"]][SEG_IDS[s]]["shipped"]
            r = sh or "v2"
            m = seg == s
            p[m, ci] = F[r][m, ci]
            code[m, ci] = RUNGS.index(r) + (0 if sh else 10)
    return p, code


def phase_holdout(datasets_dir, out_dir, log=print):
    sp = os.path.join(out_dir, "shipped-b3.json")
    fr = os.path.join(out_dir, "freeze-record.json")
    hp = os.path.join(out_dir, "results-holdout.json")
    if not (os.path.exists(sp) and os.path.exists(fr)):
        raise SystemExit("STOP: the frozen shipped-b3.json (and freeze-record.json) must exist first.")
    if os.path.exists(hp):
        raise SystemExit(f"STOP: {hp} exists; the holdout phase runs once.")
    rec = json.load(open(fr))
    if sha256_file(sp) != rec["shipped_b3_sha256"]:
        raise SystemExit("STOP: shipped-b3.json differs from the freeze record.")
    if sha256_file(os.path.join(out_dir, "results.json")) != rec["results_sha256"]:
        raise SystemExit("STOP: results.json changed after the freeze.")
    t0 = time.time()
    frozen = json.load(open(sp))
    shas = verify_inputs(datasets_dir, holdouts=True)
    ctx, res, rows, X, csha = build_holdouts(datasets_dir, out_dir, True, log)
    fold_names = [f[0] for f in ctx.folds]
    rn = rows["reserve_names"]
    n = len(rows["t"])
    # ---- blind transfer check (theta_i = 1)
    P = np.full((n, G.NC), np.nan)
    RC = np.zeros((n, G.NC), dtype=np.int8)
    for fi in range(len(fold_names)):
        te = np.nonzero((rows["fold"] == fi) & rows["feat_ok"])[0]
        if not len(te):
            continue
        raw = predict_frozen(rows, frozen, fi, te)
        Fx = {r: fix_grid(raw[r], rows["CAP"][te]) for r in RUNGS}
        P[te], RC[te] = pick_shipped(rows, te, Fx, frozen)
    test = (rows["fold"] >= 0) & rows["feat_ok"]
    cells_out, lab = {}, []
    for ci, c in enumerate(G.CELLS):
        for s in range(NSEG):
            fz = frozen["cells"][c["id"]][SEG_IDS[s]]
            m = test & rows["RES"][:, c["hi"]] & ~rows["CAP"][:, ci] & (rows["seg"] == s)
            stats = {}
            for name, mm in [(r, m & (rows["reserve"] == ri)) for ri, r in enumerate(rn)] + \
                            [("pool_DAI_USDe", m & np.isin(rows["reserve"], [rn.index(x) for x in HOLDOUT_RULE]))]:
                y = rows["Y"][mm, ci].astype(float)
                p = P[mm, ci]
                stats[name] = {"rows": int(mm.sum()), "sum_y": int(y.sum()), "sum_p": float(p.sum()),
                               "R": ratio_R(p.sum(), y.sum()), "n_ep": G.n_episodes(rows["unit"][mm], rows["t"][mm], y)}
            final, outcome = holdout_rule(fz["label"], {r: (stats[r]["n_ep"], stats[r]["R"]) for r in HOLDOUT_RULE},
                                          (stats["pool_DAI_USDe"]["n_ep"], stats["pool_DAI_USDe"]["R"]))
            cells_out.setdefault(c["id"], {})[SEG_IDS[s]] = {"shipped": fz["shipped"], "rung_used": fz["shipped"] or "v2",
                                                             "label_preholdout": fz["label"], "stats": stats,
                                                             "outcome": outcome, "label_final": final}
            lab.append([c["id"], SEG_IDS[s], fz["shipped"] or "", fz["label"], outcome or "", final,
                        stats["DAI"]["n_ep"], stats["DAI"]["R"], stats["USDe"]["n_ep"], stats["USDe"]["R"],
                        stats["pool_DAI_USDe"]["n_ep"], stats["pool_DAI_USDe"]["R"], stats["GHO"]["n_ep"]])
    G.write_csv(os.path.join(out_dir, "labels.csv"),
                ["cell", "segment", "shipped", "label_preholdout", "holdout_outcome", "label_final", "DAI_n_ep", "DAI_R",
                 "USDe_n_ep", "USDe_R", "pool_n_ep", "pool_R", "GHO_n_ep"], lab)
    # ---- pooling-term test (reported only)
    log("pooling-term test ...")
    pt = pooling_test(ctx, rows, frozen, log)
    # ---- final panel
    resm = json.load(open(os.path.join(out_dir, "results.json")))
    panel, prow = {}, []
    for r, lst in resm["panel_preholdout"].items():
        panel[r] = []
        for u in lst:
            cl = {}
            for cid, cv in u["cells"].items():
                cv = dict(cv)
                fin = cells_out[cid][u["segment"]]
                cv["label_final"] = fin["label_final"]
                cv["holdout_outcome"] = fin["outcome"]
                cl[cid] = cv
                c = G.CELLS[[cc["id"] for cc in G.CELLS].index(cid)]
                num = ("capped" if cv["capped"] else ("" if cv["p"] is None else G.fmt(cv["p"])))
                prow.append([r, u["rank"], u["address"], u["segment"], u["balance_usd"], cid,
                             c["x"] if c["x"] else "all", c["h"], num, cv["capped_text"] or "", cv["label_final"],
                             cv["holdout_outcome"] or "", cv["rung"] or "", cv["display"],
                             cv["history"] if (cv["label_final"] != "HIGH" or c["kind"] == "all") else ""])
            panel[r].append(dict(u, cells=cl))
    G.write_csv(os.path.join(out_dir, "panel.csv"),
                ["reserve", "rank", "address", "segment", "balance_usd", "cell", "size", "horizon", "number",
                 "capped_text", "label", "holdout_outcome", "rung", "display", "history"], prow)
    cnt = lambda key: {s: G._count([cells_out[c["id"]][s][key] for c in G.CELLS]) for s in SEG_IDS}  # noqa: E731
    out = {"phase": "holdout", "prereg": PREREG, "inputs_sha256": shas, "holdout_codes_sha256": csha,
           "frozen_sha256": rec["shipped_b3_sha256"], "results_sha256": rec["results_sha256"], "code": code_meta(),
           "decisions": DECISIONS, "deviations": DEVIATIONS, "holdout_rows": dry_counts(ctx, rows, "holdout rows"),
           "cells": cells_out, "label_counts": {"preholdout": cnt("label_preholdout"), "final": cnt("label_final")},
           "pooling_term_test": pt, "panel_final": panel, "runtime_s": time.time() - t0,
           "finished_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    write_json(hp, out, refuse_overwrite=True)
    log(f"holdout: results-holdout.json ({out['runtime_s']:.0f} s)")
    return out


def pooling_test(ctx, rows, frozen, log=print):
    """B3.6 pooling-term test (B3-12), reported only."""
    fold_names = [f[0] for f in ctx.folds]
    rn = rows["reserve_names"]
    f0 = fold_names.index(POOLTEST_FIRST)
    nunits = rows["n_units"]
    n = len(rows["t"])
    P1 = np.full((n, G.NC), np.nan)      # theta = 1
    PT = np.full((n, G.NC), np.nan)      # theta_i from the unit's holdout training rows
    POP = np.full((n, G.NC), np.nan)
    OWN = np.full((n, G.NC), np.nan)
    for fi in range(f0, len(fold_names)):
        Tqs = int(ctx.T[ctx.folds[fi][1]])
        for ri, r in enumerate(rn):
            if r not in HOLDOUT_RULE:
                continue
            inr = (rows["reserve"] == ri) & rows["feat_ok"]
            te = np.nonzero(inr & (rows["fold"] == fi))[0]
            if not len(te):
                continue
            pre = np.nonzero(inr & (rows["T0"] < Tqs))[0]
            raw_pre = predict_frozen(rows, frozen, fi, pre)
            raw_te = predict_frozen(rows, frozen, fi, te)
            sel_pre, _ = pick_shipped(rows, pre, raw_pre, frozen)       # raw p0' of the row's rung
            sel_te_raw = {rg: raw_te[rg] for rg in RUNGS}
            theta = np.ones((len(te), G.NC))
            for ci, c in enumerate(G.CELLS):
                hi = c["hi"]
                trm = (rows["T0"][pre] + G.HSEC[hi] <= Tqs) & rows["RES"][pre, hi] & ~rows["CAP"][pre, ci]
                tri = pre[trm]
                y = rows["Y"][tri, ci].astype(float)
                O = np.bincount(rows["unit"][tri], weights=y, minlength=nunits)
                E = np.bincount(rows["unit"][tri], weights=sel_pre[trm, ci], minlength=nunits)
                nn = np.bincount(rows["unit"][tri], minlength=nunits)
                th = G.eb_theta(O, E)
                theta[:, ci] = th[rows["unit"][te]]
                pop = float(y.mean()) if len(y) else np.nan
                POP[te, ci] = pop
                OWN[te, ci] = G.own_rate(O, nn, pop)[rows["unit"][te]]
            F1 = {rg: fix_grid(sel_te_raw[rg], rows["CAP"][te]) for rg in RUNGS}
            FT = {rg: fix_grid(odds_mult(sel_te_raw[rg], theta), rows["CAP"][te]) for rg in RUNGS}
            P1[te], _ = pick_shipped(rows, te, F1, frozen)
            PT[te], _ = pick_shipped(rows, te, FT, frozen)
    rng = np.random.default_rng(SEED_POOLTEST)
    out = {}
    test = rows["feat_ok"] & (rows["fold"] >= f0)
    for ci, c in enumerate(G.CELLS):
        base = test & rows["RES"][:, c["hi"]] & ~rows["CAP"][:, ci] & np.isfinite(PT[:, ci])
        out[c["id"]] = {}
        for name, m in [(r, base & (rows["reserve"] == rn.index(r))) for r in HOLDOUT_RULE] + [("pooled", base)]:
            idx = np.nonzero(m)[0]
            dd = np.unique(rows["t"][idx])
            nd = len(dd)
            y = rows["Y"][idx, ci].astype(float)
            pos = np.searchsorted(dd, rows["t"][idx])
            cb = B.replicate_counts(B.block_bootstrap_indices(rng, nd, G.BLOCK_DAYS, G.N_BOOT), nd) \
                if nd >= G.BLOCK_DAYS else None
            o = {"rows": int(len(idx)), "exits": int(y.sum()), "n_ep": G.n_episodes(rows["unit"][idx], rows["t"][idx], y),
                 "R_theta": ratio_R(PT[idx, ci].sum(), y.sum()), "R_theta1": ratio_R(P1[idx, ci].sum(), y.sum())}
            for cname, a, b in (("theta_vs_theta1", PT, P1), ("theta_vs_pop", PT, POP), ("theta_vs_own", PT, OWN),
                                ("theta1_vs_pop", P1, POP)):
                if cb is None:
                    sb = float(np.sum((b[idx, ci] - y) ** 2))
                    o[cname] = {"bss": float(1 - np.sum((a[idx, ci] - y) ** 2) / sb) if sb > 0 else None, "ci95": None}
                else:
                    bb = G.bss_ci(pos, nd, a[idx, ci], b[idx, ci], y, cb)
                    o[cname] = {"bss": bb["bss"], "ci95": bb["ci95"], "ci_above_0": bb["ci_above_0"],
                                "ci_below_0": bb["ci_below_0"]}
            out[c["id"]][name] = o
    return out


def phase_manifest(out_dir, log=print):
    files = {}
    for fn in sorted(os.listdir(out_dir)):
        p = os.path.join(out_dir, fn)
        if fn == "manifest.json" or not os.path.isfile(p):
            continue
        files[fn] = {"bytes": os.path.getsize(p), "sha256": sha256_file(p)}
    big = [f for f, v in files.items() if v["bytes"] >= 50_000_000]
    if big:
        raise SystemExit(f"STOP: files >= 50 MB: {big}")
    res = json.load(open(os.path.join(out_dir, "results.json")))
    man = {"files": files, "code": res.get("code"), "prereg": PREREG, "datasets": DATASETS,
           "inputs_sha256": res.get("inputs_sha256"), "runtime_s_run": res.get("runtime_s"),
           "manifest_code": code_meta(), "written_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    write_json(os.path.join(out_dir, "manifest.json"), man)
    log(f"manifest: {len(files)} files")
    return man


DEVIATIONS = []


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--datasets")
    ap.add_argument("--out", required=True)
    ap.add_argument("--phase", required=True, choices=("codes", "live-inputs", "dryrun", "run", "freeze",
                                                       "dryrun-holdout", "holdout", "manifest"))
    ap.add_argument("--workers", type=int, default=2)
    a = ap.parse_args(argv)
    os.makedirs(a.out, exist_ok=True)
    if a.phase == "codes":
        phase_codes(a.datasets, a.out)
    elif a.phase == "live-inputs":
        phase_live_inputs(a.out)
    elif a.phase == "dryrun":
        phase_dryrun(a.datasets, a.out)
    elif a.phase == "run":
        phase_run(a.datasets, a.out, workers=a.workers)
    elif a.phase == "freeze":
        phase_freeze(a.out)
    elif a.phase == "dryrun-holdout":
        phase_dryrun_holdout(a.datasets, a.out)
    elif a.phase == "holdout":
        phase_holdout(a.datasets, a.out)
    else:
        phase_manifest(a.out)


if __name__ == "__main__":
    main()
