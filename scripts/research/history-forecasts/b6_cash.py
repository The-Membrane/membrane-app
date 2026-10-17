#!/usr/bin/env python3
"""Q26 workstream B6 (round 8, R8.2): the cash-exit target y_cash on Aave V3 Core USDC.

Implements membrane-board `design/Q26_ROUND8_PREREG.md` section R8.2 (registered at board commit 91a3eba), with
the parents R7.3 (B5), its deviations D3 and D5 (`design/Q26_ROUND7_PREREG.md`), B4 (D1, D2) and B3. B4 and B5
code is imported unchanged (rows, intraday paths, folds, the v4a specification and fits, the y_econ labels, debt
flows, oracle prices, G.7 labels, the monotone fix, segments, the B4.3 comparison form). Every B6 choice the prereg
leaves open is listed in DECISIONS.

y_cash(x, h) = 1 iff, at some event time t in (t0, t0 + h], the unit's aToken withdrawals W(t0, t] (Burn events
and withdrawals logged as Mint, see B6-3; aToken transfers to other holders are not withdrawals) plus
max(0, new variable borrows - repays)(t0, t] on any Core reserve (onBehalfOf / user = the unit, USD at the daily
Aave oracle price) reach x * bal(t0). Rows with x * bal(t0) > cash(t0) are kept and flagged cash_blocked.

Phases (scoring phases write to one fresh --out):
  --phase run       ONCE: y_cash labels (+ y_econ, y_old); B4 reference fits (USDC + USDT, old target, B4 exactly)
                    scored on y_cash; v4ae fits (y_econ, B5 exactly) scored on y_cash; v4ac fits (y_cash) per B3
                    fold x cell; B4.3 comparisons; exits added / dropped vs y_old and y_econ; stress window
                    -> results-b6.json, labels-b6.csv, predictions-b6-*.csv.gz, asof-fits-b6.json (refuses
                    overwrite; refuses to run from a dirty b6_cash.py)
  --phase freeze    frozen-b6.json + freeze-record.json (sha256)
  --phase manifest  sha256 of every output

No blind phase: all USDC history has been read; the blind test is the live log (R8.2).
Addresses are public on-chain data. This code attaches no identity, label or name to any address.
"""
import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import json  # noqa: E402
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

PREREG = {
    "repo": "membrane-board", "path": "design/Q26_ROUND8_PREREG.md", "section": "R8.2", "commit": "91a3eba",
    "parents": {"R7.3 (B5)": "design/Q26_ROUND7_PREREG.md (D3, D5)",
                "B4": "design/DEPOSITOR_BEHAVIOR_PREREG_B4.md (019adca; D1, D2)",
                "B3": "design/DEPOSITOR_BEHAVIOR_PREREG_B3.md (cac7aeb; D1)"},
}
DEBT_DIR = "aave-pool-debt/"                     # B5 debt events + prices, published at membrane-datasets 762912f
B5_RUN = "history-forecasts/b5/run-0bc171f5/"
B5_FROZEN_SHA = "f7955372"                       # prefix of frozen-b5.json sha256 (R7 D3)
AUSDC = "0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c"
SEED_B6 = F.SEED_B4                              # B4.3 bootstrap seed default_rng(20261100)
RUNGS_C = ("v4ac",)
SCORE_RUNGS = ("v4ac", "v4ae", "b4")
DEC_LIVE = 365.0

DECISIONS = [
    "B6-1 everything R8.2 does not change is B5 (b5_econ.py at 0bc171f5, frozen-b5.json sha256 f7955372...) and B4 "
    "(b4_depositor.py, shipped freeze cc8680c4...), imported unchanged: rows (daily 00:00Z USDC origins with bal >= "
    "$1M), intraday paths, B3 folds 2023Q4..2026Q3 with the t0 + h purge, the v4a specification (11 v2 features + 3 "
    "history features, logistic + unit EB m = 3), segments, G.7, the B4.3 bootstrap (default_rng(20261100), block "
    "30 d, 2,000 replicates, set order x cells (h, x, segment) then pooled (h, x)), the debt flows (Borrow "
    "onBehalfOf = unit, interestRateMode 2, Repay user = unit, any Core reserve), oracle USD values and the price "
    "fill (B5-4, B5-5), the stress window (B5-11) and cash_blocked = x * bal(t0) > cash(t0) (B5-7).",
    "B6-2 y_cash path: Q(t) = W(t0, t] + max(0, N(t) - N(t0)), N = cumulative net variable debt flow (Borrow +, "
    "Repay -) in micro-USD, W = cumulative aToken withdrawals in micro-USD (aUSDC raw units = USD, as bal). y_cash = "
    "1 iff max over the merged event times t in (t0, t0 + h] (aToken path times and debt times, the B5-3 merge) of "
    "Q(t) >= x * bal(t0) ('reach': a later repayment does not undo it). Computed exactly as "
    "[W(t0 + h) - W(t0) >= x bal0] or [max_t (W + N)(t) - (W + N)(t0) >= x bal0], W being non-decreasing. "
    "Resolved = the B5 resolved set (G.3 resolved, no invalid merged point, t0 + h <= asof); checked equal.",
    "B6-3 withdrawals: decoded aUSDC events of the unit (party1) with a G.2 balance decrease from a withdraw-type "
    "burn: Burn events (amount = value + balanceIncrease = -delta1) and Mint events with delta1 < 0 (Aave V3 logs a "
    "withdrawal smaller than the accrued interest as a Mint of balanceIncrease - amount; amount = -delta1). "
    "BalanceTransfer (transfers to other holders, incl. liquidations with receiveAToken) is not a withdrawal. A Burn "
    "whose target is the aUSDC contract itself (repayWithATokens: no underlying leaves the pool) is not a "
    "withdrawal; its Repay still enters N. Liquidation burns paying the liquidator in USDC count (cash leaves). "
    "Withdrawals within one block are summed gross (a same-block deposit does not offset). Sensitivity counts "
    "(reported, deciding nothing): labels with the repayWithATokens burns counted, and with Burn events only.",
    "B6-4 rung (v4ac): the v4a specification refit on y_cash, USDC rows only, B3 folds, one fit per fold x cell, "
    "via the shared B4 fitter (which also fits v2 on the same rows: its own and pop rates on y_cash are the B4.3 "
    "baselines; v2c and v4bc are by-products, not candidates). Training rows t0 + h <= Q_start, resolved, features "
    "defined, cash_blocked included. History features count prior origins t' with y_cash(x, 24 h; t') = 1 (t' + "
    "24 h <= t0); maxdd90 unchanged. Monotone fix: the 2-D fix over all 25 size cells, no mask (B5-9).",
    "B6-5 comparators scored on y_cash: (b4) the B4 shipped rung per (cell, segment) refit exactly as B4 (USDC + "
    "USDT, old target), population-rate history where B4 ships none (B5-9); reproduction: pooled Brier equals B4 "
    "results-dev.json exactly and the USDC predictions equal the published files. (v4ae) the B5 v4ae fits refit "
    "exactly as B5 (y_econ); reproduction: y_econ labels equal and v4ae predictions equal the published "
    "predictions-b5 files (6 significant digits). A failed reproduction stops the run before any score is written.",
    "B6-6 comparisons (B4.3 form) per (cell, segment) on USDC test rows, y = y_cash: v4ac vs pop and own (y_cash "
    "training rates), v4ac vs b4, v4ac vs v4ae, v4ae vs b4, v4ae vs pop, b4 vs pop and own. One default_rng(20261100) "
    "stream in the B5 set order; < 30 test days -> no CI. Preferred rung (a tie keeps the simpler rung; simplicity "
    "order b4 < v4ae < v4ac, b4 being the incumbent and v4ae the earlier build): start at b4; v4ae replaces it if "
    "v4ae vs b4 has a CI above 0; v4ac replaces the current rung if it beats pop and own with CIs above 0 and beats "
    "the current rung with a CI above 0. Labels G.7 per (cell, segment). No pass line (R8.2: none before 90 "
    "resolved live issue days per horizon); every result is a development reading.",
    "B6-7 added / dropped exits: per x cell on test rows resolved for y_cash (= resolved for y_econ), y_cash vs "
    "y_old (G.3 aToken balance fall) and y_cash vs y_econ (B5), all rows, stress rows, cash_blocked and not. "
    "Stress capture = R (sum p / sum y_cash) of each rung on stress rows.",
    "B6-8 freeze: frozen-b6.json holds per fold x cell the v4ac params (with the v2 own / pop baseline), the asof "
    "fits (all resolved USDC rows) with per-unit theta and the y_cash(x, 24 h) exit origin days of the last 365 "
    "days, the preferred rung and labels per (cell, segment); its sha256 in freeze-record.json.",
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
    return {"git_head": git("rev-parse", "HEAD"), "last_commit_b6_cash": git("log", "-1", "--format=%H", "--", me),
            "b6_cash_sha256": B.sha256_file(os.path.abspath(__file__)),
            "b6_cash_dirty": bool(git("status", "--porcelain", "--", me)),
            "b5_econ_sha256": B.sha256_file(os.path.join(here, "b5_econ.py")),
            "b4_depositor_sha256": B.sha256_file(os.path.join(here, "b4_depositor.py")),
            "bg_gradient_sha256": B.sha256_file(os.path.join(here, "bg_gradient.py")),
            "python": sys.version.split()[0], "numpy": np.__version__,
            "sklearn": __import__("sklearn").__version__, "scipy": __import__("scipy").__version__}


# ---------------------------------------------------------------------------------------------
# Withdrawals (B6-3)
# ---------------------------------------------------------------------------------------------
def classify_withdrawals(typ, party1, party2, delta1, atoken=AUSDC):
    """Per decoded balance row -> (amount >= 0 as Python int, kind) with kind in {'burn', 'mint_neg',
    'burn_atoken_repay', ''}. amount is the withdrawn underlying (-delta1) for withdraw-type rows, else 0."""
    d = int(delta1)
    if typ == "Burn":
        if d > 0:
            raise ValueError("Burn with a positive G.2 change")
        return -d, ("burn_atoken_repay" if party2.lower() == atoken else "burn")
    if typ == "Mint" and d < 0:
        return -d, "mint_neg"
    return 0, ""


def withdrawal_table(unit, ts, amount, kind, include=("burn", "mint_neg")):
    """Aggregate withdraw rows to per (unit, ts) micro-USD sums, sorted by key; rows of other kinds dropped."""
    unit = np.asarray(unit, dtype=np.int64)
    ts = np.asarray(ts, dtype=np.int64)
    amount = np.asarray(amount, dtype=np.int64)
    m = np.isin(np.asarray(kind), list(include)) & (amount > 0)
    k = (unit[m] << 32) | ts[m]
    o = np.argsort(k, kind="stable")
    k, a = k[o], amount[m][o]
    st, s = G.aggregate_sorted(k, a)
    kk = k[st]
    return {"unit": (kk >> 32).astype(np.int64), "ts": (kk & ((1 << 32) - 1)).astype(np.int64),
            "usd": np.asarray(s, dtype=np.int64)}


def load_withdrawal_rows(datasets_dir, addrs, T0_first):
    """Withdraw-type rows of the USDC universe from the decoded depositor-events files (sha256 pinned through
    bg_gradient.verify_inputs). -> dict(unit, ts, amount, kind) and counts."""
    import pandas as pd
    sp = G.reserve_spec(datasets_dir, "USDC")
    aarr = np.array(addrs)
    cols = ["ts", "type", "party1", "party2", "delta1_raw"]
    U, TS, AM, K = [], [], [], []
    info = {"files": [os.path.basename(p) for p in sp["events"]], "by_kind": {}, "usd_by_kind": {}}
    for p in sp["events"]:
        df = pd.read_csv(p, usecols=cols, dtype=str, keep_default_na=False)
        df = df[(df["delta1_raw"] != "") & df["type"].isin(["Burn", "Mint"])]
        a = df["party1"].str.lower().to_numpy()
        ui = np.minimum(np.searchsorted(aarr, a), len(aarr) - 1)
        inu = aarr[ui] == a
        df, ui = df[inu], ui[inu]
        ts = pd.to_numeric(df["ts"]).to_numpy(np.int64)
        for u, t, ty, p1, p2, d in zip(ui, ts, df["type"].to_numpy(), df["party1"].to_numpy(),
                                       df["party2"].to_numpy(), df["delta1_raw"].to_numpy()):
            amt, kind = classify_withdrawals(ty, p1, p2, d)
            if not kind or t <= T0_first:
                continue
            U.append(u)
            TS.append(t)
            AM.append(amt)
            K.append(kind)
            info["by_kind"][kind] = info["by_kind"].get(kind, 0) + 1
            info["usd_by_kind"][kind] = info["usd_by_kind"].get(kind, 0.0) + amt / G.MICRO
    if max(AM, default=0) >= 1 << 62:
        raise SystemExit("STOP: a withdrawal amount exceeds int64")
    return {"unit": np.array(U, np.int64), "ts": np.array(TS, np.int64), "amount": np.array(AM, np.int64),
            "kind": np.array(K)}, info


# ---------------------------------------------------------------------------------------------
# y_cash (B6-2), unit-tested on synthetic paths
# ---------------------------------------------------------------------------------------------
def _cum_at(keys, cum, u, t):
    u = np.asarray(u, dtype=np.int64)
    t = np.asarray(t, dtype=np.int64)
    hi = np.searchsorted(keys, (u << 32) | t, side="right")
    lo = np.searchsorted(keys, u << 32, side="left")
    return cum[hi] - cum[lo]


class CashIndex:
    """Merged per-unit series (B5-3 merge of aToken path times and debt times) of S(t) = W(t) + N(t), with the
    validity of EconIndex; range-maximum of S via bg_gradient.WindowIndex on -S."""

    def __init__(self, paths, debt, wd, A, Av, T):
        T = np.asarray(T, dtype=np.int64)
        D = len(T)
        pk = (paths["unit"].astype(np.int64) << 32) | paths["ts"].astype(np.int64)
        dk = (debt["unit"].astype(np.int64) << 32) | debt["ts"].astype(np.int64)
        wk = (wd["unit"].astype(np.int64) << 32) | wd["ts"].astype(np.int64)
        for name, k in (("debt", dk), ("withdrawal", wk)):
            if len(k) > 1 and np.any(np.diff(k) <= 0):
                raise ValueError(f"{name} keys must be strictly increasing")
        if not np.isin(wk, pk).all():
            raise ValueError("a withdrawal time is not an aToken path time")
        self.dk, self.wk = dk, wk
        self.dcum = np.r_[0, np.cumsum(debt["usd"].astype(np.int64))]
        self.wcum = np.r_[0, np.cumsum(wd["usd"].astype(np.int64))]
        mk = np.union1d(pk, dk)
        mu = mk >> 32
        mts = mk & ((1 << 32) - 1)
        mday = np.minimum(np.searchsorted(T, mts, side="right") - 1, D - 1)
        if (mday < 0).any():
            raise ValueError("an event before the first snapshot")
        j = np.searchsorted(pk, mk, side="right") - 1
        jj = np.maximum(j, 0)
        if len(pk):
            same = (j >= 0) & (paths["unit"][jj] == mu) & (paths["pday"][jj] == mday)
            valid = np.where(same, paths["valid"][jj], Av[mu, mday]).astype(bool)
        else:
            valid = Av[mu, mday].astype(bool)
        Sv = self.W(mu, mts) + self.N(mu, mts)
        self.series = {"unit": mu, "ts": mts, "v": -Sv, "valid": valid}
        self.widx = G.WindowIndex(self.series)

    def N(self, u, t):
        return _cum_at(self.dk, self.dcum, u, t)

    def W(self, u, t):
        return _cum_at(self.wk, self.wcum, u, t)

    def label(self, u, T0, hsec, bal0, x):
        """-> (y_cash per x, has, ninv)."""
        u = np.asarray(u, dtype=np.int64)
        T0 = np.asarray(T0, dtype=np.int64)
        bal0 = np.asarray(bal0, dtype=np.int64)
        mn, has, ninv = self.widx.query(u, T0, T0 + hsec)
        S0 = self.W(u, T0) + self.N(u, T0)
        smax = np.where(has, -mn, S0)
        dW = self.W(u, T0 + hsec) - self.W(u, T0)
        out = {}
        for xx in np.atleast_1d(x):
            thr = int(xx) * bal0
            out[int(xx)] = has & (ninv == 0) & ((100 * dW >= thr) | (100 * (smax - S0) >= thr))
        return out, has, ninv


def cash_labels(R, debt, wd, T, rows_u, rows_d, rows_bal, res_old):
    """Y_cash (n, NC) int8 (x cells only) and RES_c (n, NH) for USDC rows (local unit ids)."""
    T = np.asarray(T, dtype=np.int64)
    D = len(T)
    ci_ = CashIndex(R.paths, debt, wd, R.A[:, :D], R.Av[:, :D], T)
    n = len(rows_u)
    T0 = T[rows_d]
    Y = np.zeros((n, G.NC), dtype=np.int8)
    RESc = np.zeros((n, G.NH), dtype=bool)
    for hi, hs in enumerate(G.HSEC):
        ys, has, ninv = ci_.label(rows_u, T0, hs, rows_bal, G.SIZES)
        RESc[:, hi] = res_old[:, hi] & (ninv == 0) & (T0 + hs <= S.LIVE_ASOF_TS)
        for xi, x in enumerate(G.SIZES):
            Y[:, G.XCELL[hi, xi]] = ys[x]
    return Y, RESc


# ---------------------------------------------------------------------------------------------
# Preferred rung, scoring
# ---------------------------------------------------------------------------------------------
def preferred_rung(flags):
    """B6-6: start at b4; v4ae if it beats b4; v4ac if it beats pop and own and the current rung (CIs above 0)."""
    cur = "b4"
    if flags["v4ae_vs_b4"]:
        cur = "v4ae"
    if flags["v4ac_vs_pop"] and flags["v4ac_vs_own"] and flags[f"v4ac_vs_{cur}"]:
        cur = "v4ac"
    return cur


COMP_C = (("v4ac_vs_pop", "v4ac", "pop"), ("v4ac_vs_own", "v4ac", "own"), ("v4ac_vs_b4", "v4ac", "b4"),
          ("v4ac_vs_v4ae", "v4ac", "v4ae"), ("v4ae_vs_b4", "v4ae", "b4"), ("v4ae_vs_pop", "v4ae", "pop"),
          ("b4_vs_pop", "b4", "pop"), ("b4_vs_own", "b4", "own"))
FLAG_KEYS = ("v4ac_vs_pop", "v4ac_vs_own", "v4ac_vs_b4", "v4ac_vs_v4ae", "v4ae_vs_b4")


def score_b6(ctx, C, PR, log=print):
    fold_names = [f[0] for f in ctx.folds]
    test = (C["fold"] >= 0) & C["feat_ok"]
    rng = np.random.default_rng(SEED_B6)
    cells, pooled = {}, {}
    for ci, s in E5.set_order_x():
        c = G.CELLS[ci]
        hi = c["hi"]
        m = test & C["RES"][:, hi]
        if s is not None:
            m &= C["seg"] == s
        idx = np.nonzero(m)[0]
        dd = np.unique(C["t"][idx])
        nd = len(dd)
        cb = B.replicate_counts(B.block_bootstrap_indices(rng, nd, G.BLOCK_DAYS, G.N_BOOT), nd) \
            if nd >= G.BLOCK_DAYS else None
        Q = {"y": C["Y"][idx, ci].astype(float), "t": C["t"][idx], "unit": C["unit"][idx],
             "reserve": np.zeros(len(idx), np.int8), "fold": C["fold"][idx]}
        pr = {k: PR[k][idx, ci] for k in ("v4ac", "v4ae", "b4", "own", "pop")}
        if any(np.isnan(v).any() for v in pr.values()):
            raise SystemExit(f"STOP: missing prediction in {c['id']} segment {s}")
        Sx, pos = F.score_set(Q, pr, dd, cb, fold_names, ["USDC"], rungs=SCORE_RUNGS, comps=COMP_C)
        stress = F.stress_overlap(C["T0"][idx], G.HSEC[hi])
        cbk = C["CAPOLD"][idx, ci]
        yold = C["YOLD"][idx, ci].astype(float)
        yec = C["YECON"][idx, ci].astype(float)
        Sx["no_stress"] = F.restricted(pos, nd, pr, Q["y"], ~stress, cb, comps=COMP_C, rungs=SCORE_RUNGS)
        Sx["stress_only"] = {"rows": int(stress.sum()), "exits": int(Q["y"][stress].sum()),
                             "exits_old": int(yold[stress].sum()), "exits_econ": int(yec[stress].sum()),
                             "R_capture": {r: G.ratio_R(pr[r][stress].sum(), Q["y"][stress].sum())
                                           for r in SCORE_RUNGS}}
        Sx["not_cash_blocked"] = F.restricted(pos, nd, pr, Q["y"], ~cbk, cb, comps=COMP_C, rungs=SCORE_RUNGS)
        Sx["cash_blocked"] = {"rows": int(cbk.sum()), "exits": int(Q["y"][cbk].sum()),
                              "R": {r: G.ratio_R(pr[r][cbk].sum(), Q["y"][cbk].sum()) for r in SCORE_RUNGS}}
        Sx["exits_old_target"] = int(yold.sum())
        Sx["exits_econ_target"] = int(yec.sum())
        Sx["added_vs_old"] = int(((Q["y"] == 1) & (yold == 0)).sum())
        Sx["dropped_vs_old"] = int(((Q["y"] == 0) & (yold == 1)).sum())
        Sx["added_vs_econ"] = int(((Q["y"] == 1) & (yec == 0)).sum())
        Sx["dropped_vs_econ"] = int(((Q["y"] == 0) & (yec == 1)).sum())
        fl = {k: bool(Sx["bss"][k]["ci_above_0"]) for k in FLAG_KEYS}
        Sx["flags"] = fl
        Sx["preferred"] = preferred_rung(fl)
        Sx["label"] = Sx["g7"][Sx["preferred"]]["label"]
        if s is None:
            pooled[c["id"]] = Sx
            continue
        cells.setdefault(c["id"], {})[S.SEG_IDS[s]] = Sx
        log(f"  {c['id']} {S.SEG_IDS[s]}: rows {Sx['n']['rows']} n_ep {Sx['n']['n_ep']} +old {Sx['added_vs_old']} "
            f"-old {Sx['dropped_vs_old']} -> {Sx['preferred']} {Sx['label']}")
    return cells, pooled


def exit_counts_b6(C, mask_base):
    out = {}
    for ci in range(G.NX * G.NH):
        c = G.CELLS[ci]
        m = mask_base & C["RES"][:, c["hi"]]
        st = m & F.stress_overlap(C["T0"], G.HSEC[c["hi"]])
        rec = {}
        for name, mm in (("all", m), ("stress", st), ("cash_blocked", m & C["CAPOLD"][:, ci]),
                         ("not_cash_blocked", m & ~C["CAPOLD"][:, ci])):
            yc, yo, ye = C["Y"][mm, ci] == 1, C["YOLD"][mm, ci] == 1, C["YECON"][mm, ci] == 1
            rec[name] = {"rows": int(mm.sum()), "y_old": int(yo.sum()), "y_econ": int(ye.sum()),
                         "y_cash": int(yc.sum()),
                         "added_vs_old": int((yc & ~yo).sum()), "dropped_vs_old": int((yo & ~yc).sum()),
                         "added_vs_econ": int((yc & ~ye).sum()), "dropped_vs_econ": int((ye & ~yc).sum()),
                         "n_ep_cash": G.n_episodes(C["unit"][mm], C["t"][mm], yc)}
        out[c["id"]] = rec
    return out


def sum_counts_b6(ec):
    f = ("rows", "y_old", "y_econ", "y_cash", "added_vs_old", "dropped_vs_old", "added_vs_econ", "dropped_vs_econ")
    return {k: {x: int(sum(ec[c][k][x] for c in ec)) for x in f}
            for k in ("all", "stress", "cash_blocked", "not_cash_blocked")}


# ---------------------------------------------------------------------------------------------
# Reproduction of B5 (B6-5)
# ---------------------------------------------------------------------------------------------
B5_FILES = ("results-b5.json", "frozen-b5.json", "freeze-record.json") + tuple(
    f"predictions-b5-{h}-USDC.csv.gz" for h in G.HNAMES)


def verify_b5_run(datasets_dir):
    run = os.path.join(datasets_dir, B5_RUN)
    man = json.load(open(os.path.join(run, "manifest.json")))
    out = {B5_RUN + "manifest.json": B.sha256_file(os.path.join(run, "manifest.json"))}
    for fn in B5_FILES:
        got = B.sha256_file(os.path.join(run, fn))
        if man["files"][fn]["sha256"] != got:
            raise SystemExit(f"STOP: {B5_RUN}{fn} sha256 {got} != its manifest")
        out[B5_RUN + fn] = got
    if not out[B5_RUN + "frozen-b5.json"].startswith(B5_FROZEN_SHA):
        raise SystemExit("STOP: frozen-b5.json is not the B5 freeze")
    return out


def b5_reproduction(datasets_dir, ctx, C, v4ae, log=print):
    """y_econ labels, cash_blocked flags and v4ae predictions vs the published predictions-b5 files."""
    import pandas as pd
    run = os.path.join(datasets_dir, B5_RUN)
    test = (C["fold"] >= 0) & C["feat_ok"]
    out = {}
    for hi, h in enumerate(G.HNAMES):
        df = pd.read_csv(os.path.join(run, f"predictions-b5-{h}-USDC.csv.gz"))
        m = np.nonzero(test & C["RES"][:, hi])[0]
        m = m[np.lexsort((C["t"][m], C["unit"][m]))]
        days = np.array(ctx.days)[C["t"][m]]
        if len(m) != len(df) or not (C["unit"][m] == df["unit"].to_numpy()).all() or \
                not (days == df["date"].to_numpy()).all():
            out[h] = {"equal": False, "note": "row set differs", "rows": int(len(m)), "rows_b5": int(len(df))}
            continue
        nlab, npred, ncmp = 0, 0, 0
        for ci in G.XCELL[hi]:
            cid = G.CELLS[ci]["id"]
            nlab += int((C["YECON"][m, ci] != df[f"yecon_{cid}"].to_numpy()).sum())
            nlab += int((C["YOLD"][m, ci] != df[f"y_{cid}"].to_numpy()).sum())
            nlab += int((C["CAPOLD"][m, ci].astype(int) != df[f"cash_blocked_{cid}"].to_numpy()).sum())
            npred += int((~E5.same_6g(v4ae[m, ci], df[f"v4ae_{cid}"].to_numpy(float))).sum())
            ncmp += len(m)
        out[h] = {"equal": nlab == 0 and npred == 0, "rows": int(len(m)), "label_mismatches": nlab,
                  "v4ae_mismatches": npred, "values_compared": ncmp}
        log(f"  B5 reproduction {h}: {out[h]}")
    out["all_equal"] = all(v["equal"] for v in out.values())
    return out


# ---------------------------------------------------------------------------------------------
# Run (once)
# ---------------------------------------------------------------------------------------------
def build_cash(datasets_dir, ctx, res, rows, log=print):
    """E (B5 econ rows) and C (the same rows with Y = y_cash, F4 = y_cash history), plus info."""
    debt_dir = os.path.join(datasets_dir, DEBT_DIR)
    E, debt, dinfo, dshas = E5.build_econ(datasets_dir, debt_dir, ctx, res, rows, log)
    R = res[0]
    T = np.asarray(ctx.T, dtype=np.int64)
    wr, winfo = load_withdrawal_rows(datasets_dir, R.addrs, int(T[0]))
    wd = withdrawal_table(wr["unit"], wr["ts"], wr["amount"], wr["kind"])
    args = (E["unit"], E["t"], E["bal"], E["RESOLD"])
    Yc, RESc = cash_labels(R, debt, wd, T, *args)
    if not np.array_equal(RESc, E["RES"]):
        raise SystemExit("STOP: y_cash resolved set differs from y_econ's (B6-2)")
    sens = {}
    for name, inc in (("with_atoken_repay_burns", ("burn", "mint_neg", "burn_atoken_repay")),
                      ("burn_only", ("burn",))):
        Y2, _ = cash_labels(R, debt, withdrawal_table(wr["unit"], wr["ts"], wr["amount"], wr["kind"], inc), T,
                            *args)
        test = (E["fold"] >= 0) & E["feat_ok"]
        rec = {}
        for ci in G.XCELL.ravel():
            mm = test & RESc[:, G.CELLS[ci]["hi"]]
            rec[G.CELLS[ci]["id"]] = {"added": int(((Y2[mm, ci] == 1) & (Yc[mm, ci] == 0)).sum()),
                                      "dropped": int(((Y2[mm, ci] == 0) & (Yc[mm, ci] == 1)).sum())}
        sens[name] = {"by_cell": rec, "added": sum(v["added"] for v in rec.values()),
                      "dropped": sum(v["dropped"] for v in rec.values())}
    winfo["unit_ts_points"] = int(len(wd["ts"]))
    winfo["units_with_withdrawals"] = int(len(np.unique(wd["unit"])))
    C = dict(E)
    C["Y"] = Yc
    C["YECON"] = E["Y"]
    mdd = rows["F4"]["x10"][E["sel"], 1]
    C["F4"] = E5.econ_hist_features(C["unit"], C["t"], Yc, RESc, mdd, rows["n_units"], ctx.D)
    return E, C, {"debt": dinfo, "withdrawals": winfo, "sensitivity_test_rows": sens}, dshas


def phase_run(datasets_dir, out_dir, workers=3, log=print, allow_dirty=False):
    rp = os.path.join(out_dir, "results-b6.json")
    if os.path.exists(rp):
        raise SystemExit(f"STOP: {rp} exists; the B6 run happens once and never overwrites.")
    meta = code_meta()
    if meta["b6_cash_dirty"] and not allow_dirty:
        raise SystemExit("STOP: b6_cash.py has uncommitted changes; commit the code before the run.")
    t_start = time.time()
    os.makedirs(out_dir, exist_ok=True)
    shas = F.verify_inputs(datasets_dir, holdouts=False)
    shas.update(E5.verify_b4_run(datasets_dir))
    shas.update(verify_b5_run(datasets_dir))
    shipped4 = json.load(open(os.path.join(datasets_dir, E5.B4_RUN, "shipped-b4.json")))["cells"]
    ctx, res, rows = F.build_main_b4(datasets_dir, labels=True, log=log)
    log("y_econ and y_cash labels ...")
    E, C, info, dshas = build_cash(datasets_dir, ctx, res, rows, log)
    shas.update(dshas)
    xc = [int(c) for c in G.XCELL.ravel()]
    # --- B4 reference (USDC + USDT, old target, B4 exactly)
    tasks = [("fold", fi, ci) for fi in range(len(ctx.folds)) for ci in xc]
    log(f"B4 reference fits: {len(tasks)} tasks ...")
    fits4, test4 = F.run_fits(ctx, rows, tasks, np.zeros(0, np.int64), S.LIVE_ASOF_TS, workers=workers, log=log)
    PR4, fp4, _, _ = F.assemble(rows, fits4, test4)
    PR4m = G.apply_fix(PR4, rows, versions=F.RUNGS)
    log("B4 reproduction check ...")
    repro4 = E5.b4_reproduction(datasets_dir, rows, PR4m, log)
    if not repro4["all_equal"]:
        raise SystemExit("STOP: B4 reproduction failed; nothing scored.")
    sel = E["sel"]
    n = len(sel)
    seg = C["seg"]
    PR = {k: np.full((n, G.NC), np.nan) for k in ("v4ac", "v4ae", "b4", "own", "pop")}
    raw4 = {r: E5.fix_nomask(PR4[r][sel]) for r in F.RUNGS}
    for ci in xc:
        cid = G.CELLS[ci]["id"]
        for s in range(S.NSEG):
            sh = shipped4[cid][S.SEG_IDS[s]]["shipped"]
            m = seg == s
            if sh:
                PR["b4"][m, ci] = raw4[sh][m, ci]
            else:
                for fi in range(len(ctx.folds)):
                    mm = m & (C["fold"] == fi)
                    v = fp4[fi][cid]["v2"]["seg_pop"][s]
                    PR["b4"][mm, ci] = v if np.isfinite(v) else fp4[fi][cid]["v2"]["pop"]
    del PR4, PR4m, raw4, fits4
    usdc_units = np.arange(len(res[0].addrs), dtype=np.int64)
    # --- v4ae (B5 exactly, y_econ)
    tasks = [("fold", fi, ci) for fi in range(len(ctx.folds)) for ci in xc]
    log(f"v4ae fits (y_econ): {len(tasks)} tasks ...")
    fitsE, testE = F.run_fits(ctx, E, tasks, usdc_units, S.LIVE_ASOF_TS, workers=workers, log=log)
    PRE, _, _, _ = F.assemble(E, fitsE, testE)
    PR["v4ae"] = E5.fix_nomask(PRE["v4a"])
    del PRE, fitsE
    log("B5 reproduction check ...")
    repro5 = b5_reproduction(datasets_dir, ctx, C, PR["v4ae"], log)
    if not repro5["all_equal"]:
        raise SystemExit("STOP: B5 reproduction failed; nothing scored.")
    # --- v4ac (y_cash)
    tasks = [("fold", fi, ci) for fi in range(len(ctx.folds)) for ci in xc] + [("asof", -1, ci) for ci in xc]
    log(f"v4ac fits (y_cash): {len(tasks)} tasks ...")
    fitsC, testC = F.run_fits(ctx, C, tasks, usdc_units, S.LIVE_ASOF_TS, workers=workers, log=log)
    ffC = [f for f in fitsC if f["kind"] == "fold"]
    afC = sorted([f for f in fitsC if f["kind"] == "asof"], key=lambda f: f["ci"])
    PRC, fpC, finfoC, _ = F.assemble(C, ffC, testC)
    PR["v4ac"] = E5.fix_nomask(PRC["v4a"])
    PR["own"], PR["pop"] = PRC["own"], PRC["pop"]
    log("scoring ...")
    cells, pooled = score_b6(ctx, C, PR, log)
    test = (C["fold"] >= 0) & C["feat_ok"]
    counts_test = exit_counts_b6(C, test)
    counts_all = exit_counts_b6(C, C["feat_ok"])
    lab = []
    for ci in xc:
        cid = G.CELLS[ci]["id"]
        for s in S.SEG_IDS:
            Sx = cells[cid][s]
            b = Sx["bss"]
            lab.append([cid, s, Sx["preferred"], Sx["label"], Sx["n"]["rows"], Sx["n"]["n_ep"],
                        Sx["added_vs_old"], Sx["dropped_vs_old"], Sx["added_vs_econ"], Sx["dropped_vs_econ"],
                        Sx["g7"]["v4ac"]["R"], Sx["g7"]["v4ae"]["R"], Sx["g7"]["b4"]["R"],
                        Sx["no_stress"]["R"]["v4ac"], Sx["no_stress"]["R"]["v4ae"], Sx["no_stress"]["R"]["b4"],
                        b["v4ac_vs_pop"]["bss"], b["v4ac_vs_b4"]["bss"], b["v4ac_vs_v4ae"]["bss"],
                        b["v4ae_vs_b4"]["bss"], shipped4[cid][s]["shipped"] or "pop",
                        Sx["g7"]["v4ac"]["label"], Sx["g7"]["v4ae"]["label"], Sx["g7"]["b4"]["label"]])
    G.write_csv(os.path.join(out_dir, "labels-b6.csv"),
                ["cell", "segment", "preferred", "label", "rows", "n_ep", "added_vs_old", "dropped_vs_old",
                 "added_vs_econ", "dropped_vs_econ", "R_v4ac", "R_v4ae", "R_b4", "R_v4ac_no_stress",
                 "R_v4ae_no_stress", "R_b4_no_stress", "bss_v4ac_vs_pop", "bss_v4ac_vs_b4", "bss_v4ac_vs_v4ae",
                 "bss_v4ae_vs_b4", "b4_shipped", "label_v4ac", "label_v4ae", "label_b4"], lab)
    pred = write_predictions_b6(out_dir, ctx, C, PR)
    labc = {r: {s: G._count([cells[G.CELLS[ci]["id"]][s]["g7"][r]["label"] for ci in xc]) for s in S.SEG_IDS}
            for r in SCORE_RUNGS}
    prefc = {s: G._count([cells[G.CELLS[ci]["id"]][s]["preferred"] for ci in xc]) for s in S.SEG_IDS}
    summary = {
        "phase": "run (development; no blind phase, R8.2)", "prereg": PREREG, "inputs_sha256": shas,
        "code": meta, "decisions": DECISIONS, "info": info,
        "features": {"v4ac": F.FEATURES_V4A + ("(history counts y_cash, B6-4)",)},
        "segments": dict(zip(S.SEG_IDS, S.SEG_NAMES)), "b4_reproduction": repro4, "b5_reproduction": repro5,
        "exit_counts_test": counts_test, "exit_counts_test_total": sum_counts_b6(counts_test),
        "exit_counts_all_rows": counts_all, "exit_counts_all_rows_total": sum_counts_b6(counts_all),
        "cells": cells, "pooled": pooled, "label_counts": labc, "preferred_counts": prefc,
        "fold_params": fpC, "fold_fits": finfoC,
        "asof_params": {G.CELLS[f["ci"]]["id"]: {k: f[k] for k in ("v2", "v4a")} for f in afC},
        "prediction_files": [os.path.basename(p) for p in pred],
        "single_class_fits": sum(int(f["v4a"]["info"]["single_class"]) for f in fitsC),
        "convergence_warnings": sum(int(f["v4a"]["info"].get("n_convergence_warnings", 0)) for f in fitsC),
        "runtime_s": time.time() - t_start, "finished_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    B.write_json(rp, summary, refuse_overwrite=True)
    asof = build_asof_record(ctx, C, afC, usdc_units, res[0].addrs)
    B.write_json(os.path.join(out_dir, "asof-fits-b6.json"), asof, refuse_overwrite=True)
    log(f"run: {rp} ({summary['runtime_s']:.0f} s)")
    return summary


def build_asof_record(ctx, C, afC, units, addrs):
    th = {G.CELLS[f["ci"]]["id"]: {"theta_v4ac": [round(v, 10) for v in f["panel"]["theta_v4a"]],
                                   "theta_v2_baseline": [round(v, 10) for v in f["panel"]["theta_v2"]]}
          for f in afC}
    hist = {}
    last = int(C["t"].max())
    for xi, x in enumerate(G.SIZES):
        ci = int(G.XCELL[2, xi])
        m = C["RES"][:, 2] & (C["Y"][:, ci] == 1) & (C["t"] >= last - int(DEC_LIVE))
        d = {}
        for u, t in zip(C["unit"][m], C["t"][m]):
            d.setdefault(int(u), []).append(ctx.days[int(t)])
        hist[f"x{x}"] = {addrs[u]: v for u, v in sorted(d.items())}
    return {"asof_ts": S.LIVE_ASOF_TS, "asof_block": S.LIVE_ASOF_BLOCK, "units": [addrs[u] for u in units],
            "params": {G.CELLS[f["ci"]]["id"]: {k: f[k] for k in ("v2", "v4a")} for f in afC},
            "theta": th, "cash_exit_origin_days_24h": hist,
            "note": "addresses are public on-chain data; no identity is attached"}


def write_predictions_b6(out_dir, ctx, C, PR, max_bytes=45_000_000):
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
                "stress": F.stress_overlap(C["T0"][m], G.HSEC[hi]).astype(np.int8)}
        for c in cis:
            cid = G.CELLS[c]["id"]
            cols[f"cash_blocked_{cid}"] = C["CAPOLD"][m, c].astype(np.int8)
            cols[f"y_{cid}"] = C["YOLD"][m, c]
            cols[f"yecon_{cid}"] = C["YECON"][m, c]
            cols[f"ycash_{cid}"] = C["Y"][m, c]
        for k in ("v4ac", "v4ae", "b4", "own", "pop"):
            for c in cis:
                cols[f"{k}_{G.CELLS[c]['id']}"] = PR[k][m, c]
        p = os.path.join(out_dir, f"predictions-b6-{h}-USDC.csv.gz")
        pd.DataFrame(cols).to_csv(p, index=False, float_format="%.6g",
                                  compression={"method": "gzip", "compresslevel": 9})
        if os.path.getsize(p) > max_bytes:
            raise SystemExit(f"STOP: {p} > {max_bytes} bytes")
        written.append(p)
    return written


def phase_freeze(out_dir, log=print):
    rp = os.path.join(out_dir, "results-b6.json")
    ap = os.path.join(out_dir, "asof-fits-b6.json")
    fp = os.path.join(out_dir, "frozen-b6.json")
    fr = os.path.join(out_dir, "freeze-record.json")
    if not os.path.exists(rp):
        raise SystemExit("STOP: no results-b6.json.")
    if os.path.exists(fp) or os.path.exists(fr):
        raise SystemExit("STOP: the freeze exists; it is written once.")
    r = json.load(open(rp))
    a = json.load(open(ap))
    cells = {cid: {s: {"preferred": v["preferred"], "label": v["label"], "flags": v["flags"],
                       "labels_by_rung": {k: v["g7"][k]["label"] for k in SCORE_RUNGS},
                       "dev_R_by_rung": {k: v["g7"][k]["R"] for k in SCORE_RUNGS}, "dev_n_ep": v["n"]["n_ep"]}
                   for s, v in sv.items()} for cid, sv in r["cells"].items()}
    frozen = {"prereg": PREREG, "results_b6_sha256": B.sha256_file(rp), "asof_fits_b6_sha256": B.sha256_file(ap),
              "features": r["features"], "cells": cells, "fold_params": r["fold_params"], "asof": a,
              "folds": [f for f in B.fold_list()], "segments": r["segments"], "decisions": DECISIONS,
              "frozen_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "code": code_meta()}
    B.write_json(fp, frozen, refuse_overwrite=True)
    rec = {"frozen_b6_sha256": B.sha256_file(fp), "results_b6_sha256": frozen["results_b6_sha256"],
           "asof_fits_b6_sha256": frozen["asof_fits_b6_sha256"], "frozen_utc": frozen["frozen_utc"]}
    B.write_json(fr, rec, refuse_overwrite=True)
    log(f"freeze: frozen-b6.json sha256 {rec['frozen_b6_sha256']}")
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
