#!/usr/bin/env python3
"""Tests for b6_cash.py (Q26 round 8 R8.2, cash-exit target).

Synthetic tests read no dataset and score nothing:
  python3 -m unittest scripts/research/history-forecasts/test_b6_cash.py -v
With B6_OUT=<run dir> the recorded checks of results-b6.json are asserted (B4 and B5 reproduction, count sanity).
With B6_DATA_TESTS=1 a real-data look-ahead test runs on USDC (withdrawals and debt events after a cut never change
y_cash of windows that end by the cut, nor the v4ac history features of origins at or before it).
"""
import json
import os
import sys
import unittest
import warnings

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import b6_cash as C6  # noqa: E402
import bg_gradient as G  # noqa: E402
import test_b5_econ as T5  # noqa: E402

warnings.filterwarnings("ignore", category=FutureWarning)
M = G.MICRO
DAY = 86400
HERE = os.path.dirname(os.path.abspath(__file__))
DDIR = os.environ.get("MEMBRANE_DATASETS_DIR") or os.path.join(HERE, "..", "..", "..", "..", "membrane-datasets")
EMPTY = {"unit": np.zeros(0, np.int64), "ts": np.zeros(0, np.int64), "usd": np.zeros(0, np.int64)}


def synth_cash(seed, n_units=3, D=6):
    """B5 synthetic world plus withdrawals: a random subset of the negative aToken events (amount = -delta, or a
    random larger gross amount, as when a same-block deposit offsets part of it)."""
    T, A, Av, paths, debt, (unit, ts, delta) = T5.synth(n_units=n_units, D=D, seed=seed)
    rng = np.random.default_rng(seed + 100)
    neg = np.nonzero(delta < 0)[0]
    pick = neg[rng.random(len(neg)) < 0.7]
    amt = -delta[pick] + (rng.random(len(pick)) < 0.2) * rng.integers(1, 20, len(pick)) * M
    wd = C6.withdrawal_table(unit[pick], ts[pick], amt, np.array(["burn"] * len(pick)))
    return T, A, Av, paths, debt, wd


def brute_cash(T, A, paths, debt, wd, u, d, hsec, x):
    """Reference y_cash: max over event times t in (t0, t0 + h] of W(t0, t] + max(0, N(t) - N(t0))."""
    T0 = int(T[d])
    bal0 = int(A[u, d])

    def cum(tab, t0, t1):
        m = (tab["unit"] == u) & (tab["ts"] > t0) & (tab["ts"] <= t1)
        return int(tab["usd"][m].sum())
    times = set(int(t) for t in paths["ts"][paths["unit"] == u]) | set(int(t) for t in debt["ts"][debt["unit"] == u])
    times = sorted(t for t in times if T0 < t <= T0 + hsec)
    best = None
    for t in times:
        q = cum(wd, T0, t) + max(0, cum(debt, T0, t))
        best = q if best is None else max(best, q)
    return best is not None and 100 * best >= x * bal0


class TestCashLabel(unittest.TestCase):
    def test_matches_brute_force(self):
        for seed in range(6):
            T, A, Av, paths, debt, wd = synth_cash(seed)
            ci = C6.CashIndex(paths, debt, wd, A, Av, T)
            for hs in (3600, 6 * 3600, DAY, 2 * DAY):
                for u in range(A.shape[0]):
                    for d in range(A.shape[1]):
                        ys, has, ninv = ci.label([u], [T[d]], hs, [A[u, d]], G.SIZES)
                        for x in G.SIZES:
                            self.assertEqual(bool(ys[x][0]), brute_cash(T, A, paths, debt, wd, u, d, hs, x),
                                             (seed, hs, u, d, x))

    def test_cases(self):
        T = np.arange(4, dtype=np.int64) * DAY
        A = np.full((1, 4), 100 * M, dtype=np.int64)
        Av = np.ones((1, 4), bool)
        # aToken path: -30 at t=500 (a withdrawal), +40 at t=700, -20 at t=900 (a transfer out, not a withdrawal)
        p = G.build_paths(np.array([0, 0, 0]), np.array([500, 700, 900]), np.array([-30, 40, -20]) * M, A, Av, T)

        def lab(w_ts, w_usd, d_ts=(), d_usd=(), x=50, h=DAY, paths=p):
            wd = C6.withdrawal_table(np.zeros(len(w_ts), np.int64), np.array(w_ts, np.int64),
                                     np.array(w_usd, np.int64) * M, np.array(["burn"] * len(w_ts)))
            debt = {"unit": np.zeros(len(d_ts), np.int64), "ts": np.array(d_ts, np.int64),
                    "usd": np.array(d_usd, np.int64) * M}
            ys, _, _ = C6.CashIndex(paths, debt, wd, A, Av, T).label([0], [0], h, [A[0, 0]], [x])
            return bool(ys[x][0])
        self.assertFalse(lab([500], [30]))                       # 30% withdrawn
        self.assertTrue(lab([500], [30], x=25))
        self.assertTrue(lab([500], [30], [600], [20]))           # 30 withdrawn + 20 new debt = 50%
        self.assertTrue(lab([500], [30], [600, 800], [20, -20]))  # reached at 600, repaid later: still reached
        self.assertFalse(lab([500], [30], [400, 600], [-20, 20]))  # repaying old debt first: net 0 new debt
        self.assertTrue(lab([500], [30], [400, 600], [-20, 40]))  # net new debt 20 after the repayment
        self.assertFalse(lab([500], [30], [400], [-80]))         # repayment never offsets withdrawals (floor 0)
        self.assertFalse(lab([], [], [], [], x=10))              # transfer out (-20 at 900) is not a cash exit
        self.assertTrue(lab([500], [60]))                        # gross withdrawal counted (redeposit at 700 ignored)
        self.assertFalse(lab([500], [60], h=400))                # window ends before 500
        self.assertTrue(lab([500], [60], h=500))                 # t0 + h exactly: inside

    def test_no_debt_reduces_to_withdrawals(self):
        T, A, Av, paths, _, wd = synth_cash(3)
        ci = C6.CashIndex(paths, EMPTY, wd, A, Av, T)
        for u in range(A.shape[0]):
            for d in range(A.shape[1]):
                for hs in G.HSEC:
                    ys, _, ninv = ci.label([u], [T[d]], hs, [A[u, d]], G.SIZES)
                    m = (wd["unit"] == u) & (wd["ts"] > T[d]) & (wd["ts"] <= T[d] + hs)
                    w = int(wd["usd"][m].sum())
                    if A[u, d] <= 0:                                # rows need bal(t0) >= $1M
                        continue
                    for x in G.SIZES:
                        self.assertEqual(bool(ys[x][0]), 100 * w >= x * int(A[u, d]) and ninv[0] == 0)

    def test_cash_never_below_floored_part_of_econ(self):
        """With withdrawals = every aToken decrease and no transfers or deposits, y_cash >= y_econ."""
        T = np.arange(5, dtype=np.int64) * DAY
        rng = np.random.default_rng(7)
        ts = np.sort(rng.choice(np.arange(1, 4 * DAY), 30, replace=False))
        delta = -rng.integers(1, 6, 30) * M
        A = np.zeros((1, 5), np.int64)
        b = 200 * M
        for d in range(5):
            A[0, d] = b
            b += int(delta[(ts > T[d]) & (ts <= T[d] + DAY)].sum())
        Av = np.ones((1, 5), bool)
        paths = G.build_paths(np.zeros(30, np.int64), ts, delta, A, Av, T)
        wd = C6.withdrawal_table(np.zeros(30, np.int64), ts, -delta, np.array(["burn"] * 30))
        dts = np.sort(rng.choice(np.arange(1, 4 * DAY), 10, replace=False))
        debt = {"unit": np.zeros(10, np.int64), "ts": dts, "usd": rng.integers(-20, 30, 10) * M}
        import b5_econ as E5
        ce, ee = C6.CashIndex(paths, debt, wd, A, Av, T), E5.EconIndex(paths, debt, A, Av, T)
        for d in range(4):
            for hs in G.HSEC:
                yc = ce.label([0], [T[d]], hs, [A[0, d]], G.SIZES)[0]
                ye = ee.label([0], [T[d]], hs, [A[0, d]], G.SIZES)[0]
                for x in G.SIZES:
                    self.assertGreaterEqual(int(yc[x][0]), int(ye[x][0]))

    def test_withdrawal_must_be_path_time(self):
        T, A, Av, paths, debt, _ = synth_cash(1)
        bad = {"unit": np.array([0], np.int64), "ts": np.array([int(T[0]) + 7], np.int64),
               "usd": np.array([M], np.int64)}
        if (paths["ts"][paths["unit"] == 0] == bad["ts"][0]).any():
            self.skipTest("synthetic collision")
        with self.assertRaises(ValueError):
            C6.CashIndex(paths, debt, bad, A, Av, T)


class TestNoLookAhead(unittest.TestCase):
    def test_future_events_never_enter(self):
        T, A, Av, paths, debt, wd = synth_cash(11)
        cut = int(T[2]) + DAY
        keep_d, keep_w = debt["ts"] <= cut, wd["ts"] <= cut
        base = C6.CashIndex(paths, {k: v[keep_d] for k, v in debt.items()},
                            {k: v[keep_w] for k, v in wd.items()}, A, Av, T)
        rng = np.random.default_rng(5)
        d3 = {k: v.copy() for k, v in debt.items()}
        d3["usd"][~keep_d] = rng.integers(-10 ** 6, 10 ** 6, int((~keep_d).sum())) * M
        w3 = {k: v.copy() for k, v in wd.items()}
        w3["usd"][~keep_w] = rng.integers(1, 10 ** 6, int((~keep_w).sum())) * M
        full = C6.CashIndex(paths, d3, w3, A, Av, T)
        for u in range(A.shape[0]):
            for d in range(A.shape[1]):
                for hs in G.HSEC:
                    if T[d] + hs > cut:
                        continue
                    a = base.label([u], [T[d]], hs, [A[u, d]], G.SIZES)[0]
                    b = full.label([u], [T[d]], hs, [A[u, d]], G.SIZES)[0]
                    for x in G.SIZES:
                        self.assertEqual(bool(a[x][0]), bool(b[x][0]))


class TestPieces(unittest.TestCase):
    def test_classify(self):
        a = C6.AUSDC
        self.assertEqual(C6.classify_withdrawals("Burn", "0x1", "0x2", "-500"), (500, "burn"))
        self.assertEqual(C6.classify_withdrawals("Burn", "0x1", a.upper().replace("0X", "0x"), "-5"),
                         (5, "burn_atoken_repay"))
        self.assertEqual(C6.classify_withdrawals("Mint", "0x1", "0x1", "-7"), (7, "mint_neg"))
        self.assertEqual(C6.classify_withdrawals("Mint", "0x1", "0x1", "9"), (0, ""))
        self.assertEqual(C6.classify_withdrawals("BalanceTransfer", "0x1", "0x2", "-9"), (0, ""))
        with self.assertRaises(ValueError):
            C6.classify_withdrawals("Burn", "0x1", "0x2", "3")

    def test_withdrawal_table(self):
        w = C6.withdrawal_table([1, 0, 1, 1], [50, 10, 50, 60], [3, 4, 5, 6],
                                np.array(["burn", "burn", "mint_neg", "burn_atoken_repay"]))
        self.assertEqual(w["unit"].tolist(), [0, 1])
        self.assertEqual(w["ts"].tolist(), [10, 50])
        self.assertEqual(w["usd"].tolist(), [4, 8])
        w2 = C6.withdrawal_table([1], [60], [6], np.array(["burn_atoken_repay"]),
                                 include=("burn", "burn_atoken_repay"))
        self.assertEqual(w2["usd"].tolist(), [6])

    def test_preferred_rung(self):
        f = dict.fromkeys(C6.FLAG_KEYS, False)
        self.assertEqual(C6.preferred_rung(f), "b4")
        f.update(v4ac_vs_pop=True, v4ac_vs_own=True, v4ac_vs_b4=True)
        self.assertEqual(C6.preferred_rung(f), "v4ac")
        f["v4ae_vs_b4"] = True                                     # v4ae beats b4: v4ac must beat v4ae
        self.assertEqual(C6.preferred_rung(f), "v4ae")
        f["v4ac_vs_v4ae"] = True
        self.assertEqual(C6.preferred_rung(f), "v4ac")
        f["v4ac_vs_own"] = False                                   # not eligible
        self.assertEqual(C6.preferred_rung(f), "v4ae")


@unittest.skipUnless(os.environ.get("B6_OUT"), "B6_OUT not set")
class TestRecordedRun(unittest.TestCase):
    def test_recorded(self):
        r = json.load(open(os.path.join(os.environ["B6_OUT"], "results-b6.json")))
        self.assertTrue(r["b4_reproduction"]["all_equal"])
        self.assertTrue(r["b5_reproduction"]["all_equal"])
        self.assertFalse(r["code"]["b6_cash_dirty"])
        for cid, rec in r["exit_counts_test"].items():
            a = rec["all"]
            self.assertEqual(a["y_cash"] - a["y_old"], a["added_vs_old"] - a["dropped_vs_old"], cid)
            self.assertEqual(a["y_cash"] - a["y_econ"], a["added_vs_econ"] - a["dropped_vs_econ"], cid)


@unittest.skipUnless(os.environ.get("B6_DATA_TESTS") == "1", "data tests off")
class TestRealLookAhead(unittest.TestCase):
    def test_events_after_cut_never_enter(self):
        import b4_depositor as F
        import b5_econ as E5
        ctx, res, rows = F.build_main_b4(DDIR, labels=True, log=lambda *a: None)
        R = res[0]
        T = np.asarray(ctx.T, np.int64)
        ddir = os.path.join(DDIR, C6.DEBT_DIR)
        bor, rep, _ = E5.load_debt_frames(DDIR, ddir)
        prices, dec, _, _ = E5.load_prices(ddir, ctx.T, ctx.days)
        debt, _ = E5.debt_flows(bor, rep, R.addrs, T, prices, dec)
        wr, _ = C6.load_withdrawal_rows(DDIR, R.addrs, int(T[0]))
        wd = C6.withdrawal_table(wr["unit"], wr["ts"], wr["amount"], wr["kind"])
        sel = np.nonzero(rows["reserve"] == 0)[0]
        args = (rows["unit"][sel], rows["t"][sel], rows["bal"][sel], rows["RES"][sel])
        Y0, R0 = C6.cash_labels(R, debt, wd, T, *args)
        cut_day = ctx.day_index["2025-06-01"]
        cut = int(T[cut_day])
        rng = np.random.default_rng(1)
        d3 = {k: v.copy() for k, v in debt.items()}
        late = d3["ts"] > cut
        d3["usd"][late] = rng.integers(-10 ** 15, 10 ** 15, int(late.sum()))
        w3 = {k: v.copy() for k, v in wd.items()}
        late = w3["ts"] > cut
        w3["usd"][late] = rng.integers(1, 10 ** 15, int(late.sum()))
        Y1, R1 = C6.cash_labels(R, d3, w3, T, *args)
        T0 = rows["T0"][sel]
        for hi, hs in enumerate(G.HSEC):
            m = T0 + hs <= cut
            for xi in range(G.NX):
                ci = G.XCELL[hi, xi]
                self.assertTrue(np.array_equal(Y0[m, ci], Y1[m, ci]))
        mdd = rows["F4"]["x10"][sel, 1]
        F0 = E5.econ_hist_features(rows["unit"][sel], rows["t"][sel], Y0, R0, mdd, rows["n_units"], ctx.D)
        F1 = E5.econ_hist_features(rows["unit"][sel], rows["t"][sel], Y1, R1, mdd, rows["n_units"], ctx.D)
        m = rows["t"][sel] <= cut_day
        for k in F0:
            self.assertTrue(np.array_equal(F0[k][m], F1[k][m]), k)


if __name__ == "__main__":
    unittest.main()
