#!/usr/bin/env python3
"""Unit tests for a3_touch.py on synthetic data only (no dataset read, no score).

  python3 -m unittest scripts/research/history-forecasts/test_a3_touch.py -v
"""
import gzip
import json
import math
import os
import sys
import tempfile
import unittest
import warnings

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import a3_touch as M  # noqa: E402
import a_touch as A  # noqa: E402

warnings.filterwarnings("ignore")


def walk(n, seed=1, vol=0.01, nulls=()):
    rng = np.random.default_rng(seed)
    r = rng.normal(0, vol, n) * (1 + 2 * (np.sin(np.arange(n) / 700.0) > 0.3))
    c = 100 * np.exp(np.cumsum(r))
    lo = c * np.exp(-np.abs(rng.normal(0, vol / 2, n)))
    for j in nulls:
        c[j] = np.nan
        lo[j] = np.nan
    return c, lo


def ser_of(c, lo, levels=(-0.02, -0.05, -0.10)):
    return M.S3("syn", "SYN", "syn", c, lo, levels, M.BASE_DEV, M.BASE_DEV)


class TestNullRule(unittest.TestCase):
    def test_thresholds(self):
        self.assertEqual([M.max_nulls(T) for T in M.HORIZONS_H], [0, 1, 3, 8, 16, 36])

    def test_window_min_from_non_null_hours_up_to_5pct(self):
        low = np.full(100, 100.0)
        low[50] = 80.0
        low[51] = np.nan                       # one null in a 24 h window: allowed
        w = M.window_min_null_rule(low, 24)
        self.assertEqual(w[40], 80.0)          # window 40..63 holds the dip and one null
        self.assertEqual(w[51], 100.0)         # window 51..74: one null, min of the rest
        low2 = low.copy()
        low2[52] = np.nan                      # two nulls in 24 h: no label
        w2 = M.window_min_null_rule(low2, 24)
        self.assertTrue(np.isnan(w2[40]))
        self.assertEqual(w2[53], 100.0)        # window 53..76 has no null
        w6 = M.window_min_null_rule(low, 6)    # 6 h allows no null
        self.assertTrue(np.isnan(w6[47]) and w6[44] == 100.0 and np.isnan(w6[50]))
        self.assertTrue(np.all(np.isnan(w[100 - 24 + 1:])))   # windows past the grid end

    def test_equals_a_rule_without_internal_nulls(self):
        c, lo = walk(3000, seed=2)
        lo[:200] = np.nan                      # leading nulls (pre-coverage) behave like A's
        c[:200] = np.nan
        for T in M.HORIZONS_H:
            a = A.window_min(lo, T)
            b = M.window_min_null_rule(lo, T)
            sp = A.spot_series(c)
            ok = np.isfinite(sp)
            np.testing.assert_array_equal(np.isfinite(a) & ok, np.isfinite(b) & ok)
            np.testing.assert_array_equal(a[np.isfinite(a) & ok], b[np.isfinite(a) & ok])


class TestSigmaRefAndBeta(unittest.TestCase):
    def test_expanding_median(self):
        x = np.array([np.nan, 3.0, np.nan, 1.0, 2.0, 10.0, np.nan, 4.0])
        m = M.expanding_median(x)
        want = [np.nan, np.nan, 3.0, 3.0, 2.0, 2.0, 2.5, 2.5]
        for i, w in enumerate(want):
            if np.isnan(w):
                self.assertTrue(np.isnan(m[i]))
            else:
                self.assertAlmostEqual(m[i], w)
        rng = np.random.default_rng(0)
        y = rng.normal(size=500)
        y[rng.random(500) < 0.1] = np.nan
        m2 = M.expanding_median(y)
        for i in (5, 77, 300, 499):
            v = y[:i][np.isfinite(y[:i])]
            self.assertAlmostEqual(m2[i], float(np.median(v)), places=14)

    def test_sigma_beta(self):
        c, lo = walk(2600, seed=3)
        s = ser_of(c, lo)
        np.testing.assert_array_equal(s.sigma_beta(1.0), s.sigma)
        np.testing.assert_array_equal(s.sigma_beta(0.0), s.sigma_ref)
        i = 2000
        self.assertAlmostEqual(s.sigma_beta(0.25)[i], s.sigma[i] ** 0.25 * s.sigma_ref[i] ** 0.75, places=14)
        self.assertTrue(np.isnan(s.sigma_ref[1441]) and np.isfinite(s.sigma_ref[1442]))

    def test_pick_beta_ties(self):
        self.assertEqual(M.pick_beta({0.0: 0.2, 0.25: 0.1, 0.5: 0.3, 0.75: 0.4, 1.0: 0.5}), 0.25)
        self.assertEqual(M.pick_beta({0.0: 0.1, 0.25: 0.2, 0.5: 0.1 + 5e-13, 0.75: 0.4, 1.0: 0.5}), 0.5)
        self.assertEqual(M.pick_beta({0.0: 0.3, 0.25: 0.1, 0.5: 0.3, 0.75: 0.1, 1.0: 0.5}), 0.25)
        self.assertEqual(M.pick_beta({0.0: 0.1, 0.25: 0.3, 0.5: 0.3, 0.75: 0.3, 1.0: 0.1}), 0.0)

    def test_beta_choice_is_as_of_brier_with_inner_purge_over_origins_after_365d(self):
        n = 24 * 500
        c, lo = walk(n, seed=5, nulls=(9000,))
        s = ser_of(c, lo)
        T = 24
        P = M.Prep3(s, T)
        qs = 24 * 470
        beta, info = P.choose_beta(qs)
        y = s.labels(T)
        lab = np.isfinite(y[:, 0])
        first = int(np.where(lab)[0][0])
        ev = [t for t in range(first + 365 * 24, qs - T + 1, 97) if lab[t] and np.isfinite(s.sigma[t])
              and np.isfinite(s.sigma_ref[t])]
        self.assertEqual(info["n_eval"], int(P.cumE[qs - T]))
        self.assertTrue(all(P.eval_mask[t] for t in ev))
        self.assertFalse(P.eval_mask[first + 365 * 24 - 1])
        best = min(info["brier"].values())
        self.assertEqual(info["brier"][beta], best)

    def test_beta_brier_bookkeeping_equals_direct_mean(self):
        n = 24 * 450
        c, lo = walk(n, seed=8)
        s = ser_of(c, lo)
        T = 6
        P = M.Prep3(s, T)
        y = s.labels(T)
        lab = np.isfinite(y[:, 0])
        sc = math.sqrt(T / 8760)
        qs = 24 * 420
        _, info = P.choose_beta(qs)
        ev = np.where(P.eval_mask & (np.arange(len(lab)) + T <= qs))[0]
        b = 0.75
        sig = s.sigma_beta(b)
        tot = 0.0
        for t in ev[::50]:
            src = [u for u in range(0, t - T + 1) if lab[u] and np.isfinite(sig[u])]
            z = np.sort([math.log(s.wmin(T)[u] / s.spot[u]) / (sig[u] * sc) for u in src])
            p = np.searchsorted(z, np.log1p(np.array(s.levels)) / (sig[t] * sc), side="right") / len(z)
            se = float(np.sum((p - y[t]) ** 2))
            self.assertAlmostEqual(se, P.cumSE[b][t] - P.cumSE[b][t - 1], places=12)
            tot += se
        self.assertEqual(info["n_eval"], len(ev))

    def test_no_evaluation_origin_gives_half(self):
        c, lo = walk(24 * 200, seed=9)
        s = ser_of(c, lo)
        P = M.Prep3(s, 24)
        b, info = P.choose_beta(24 * 150)
        self.assertEqual((b, info["n_eval"]), (0.5, 0))

    def test_fold_prediction_beta_one_equals_f(self):
        c, lo = walk(24 * 200, seed=10)
        s = ser_of(c, lo)
        P = M.Prep3(s, 24, beta_select=False)
        te = np.array([24 * 190, 24 * 190 + 6])
        o = M.predict3(s, P, 24, 24 * 190, te, 1.0)
        np.testing.assert_array_equal(o["raw"]["f"], o["raw"]["fb"])
        o2 = M.predict3(s, P, 24, 24 * 190, te, 0.0)
        y = s.labels(24)
        sc = math.sqrt(24 / 8760)
        src = [u for u in range(0, 24 * 190 - 24 + 1) if np.isfinite(y[u, 0]) and np.isfinite(s.sigma_ref[u])]
        z = np.array([math.log(s.wmin(24)[u] / s.spot[u]) / (s.sigma_ref[u] * sc) for u in src])
        for j, k in enumerate(s.levels):
            self.assertAlmostEqual(o2["raw"]["fb"][0, j], float(np.mean(z <= math.log(1 + k) / (s.sigma_ref[te[0]] * sc))),
                                   places=14)


class TestRegime(unittest.TestCase):
    def test_rv30_equals_a_without_nulls_and_tolerates_5pct(self):
        c, _ = walk(3000, seed=4)
        np.testing.assert_allclose(M.rv30_tolerant(c), A.rv30_series(c), rtol=0, atol=0, equal_nan=True)
        c4 = c.copy()
        c4[:300] = np.nan                      # a series start (leading nulls) behaves exactly like A
        np.testing.assert_allclose(M.rv30_tolerant(c4), A.rv30_series(c4), rtol=0, atol=0, equal_nan=True)
        c2 = c.copy()
        c2[2500] = np.nan                      # two null returns in the window: still defined, mean over 718
        rv = M.rv30_tolerant(c2)
        r = np.log(c2[1:] / c2[:-1])
        w = r[2600 - 720:2600]
        self.assertAlmostEqual(rv[2601 - 0], rv[2601])
        i = 2700
        ww = r[i - 720 - 1:i - 1]
        self.assertAlmostEqual(rv[i], math.sqrt(8760 * np.nansum(ww ** 2) / np.isfinite(ww).sum()), places=12)
        self.assertTrue(np.isnan(A.rv30_series(c2)[i]))
        c3 = c.copy()
        c3[2400:2440] = np.nan                 # 41 null returns > 36: undefined
        self.assertTrue(np.isnan(M.rv30_tolerant(c3)[2700]))
        del w

    def test_terciles(self):
        g = M.regime_of(np.array([0.0, 0.3333, 1 / 3, 0.66, 2 / 3, 1.0, np.nan]))
        self.assertEqual(g.tolist(), [0, 0, 1, 1, 2, 2, -1])


class TestLabelsAndChecks(unittest.TestCase):
    def test_level_stats_by_regime_uses_regime_rows_only(self):
        rng = np.random.default_rng(3)
        n = 12 * 360
        t0 = 2 + 6 * np.arange(n)
        y = (rng.random(n) < 0.1).astype(float)
        reg = np.repeat(np.array([0, 1, 2, -1] * 3, np.int8), 360)
        sel = {"t0_i": t0, "fold_i": np.repeat(np.arange(12), 360), "k_i": np.zeros(n, int), "y": y,
               "regime": reg, "levels": [-0.05], "p_a": np.full(n, 0.1)}
        day = t0 // 24
        days = np.unique(day)
        pos = np.searchsorted(days, day)
        cnt = A.replicate_counts(A.block_bootstrap_indices(np.random.default_rng(1), len(days), 30, 200), len(days))
        out = M.level_stats_by_regime(sel, pos, len(days), cnt, 24, set(range(8, 12)), ("a",))
        d = out["-0.05"]["a"]
        m = reg == 1
        self.assertEqual(d["mid"]["n_rows"], int(m.sum()))
        self.assertAlmostEqual(d["mid"]["R"], 0.1 * m.sum() / y[m].sum())
        self.assertEqual(d["pooled"]["n_rows"], n)
        self.assertEqual(d["low"]["n_cells"], 3)

    def test_devblind_and_final_outcomes(self):
        ok, few, bad = {"R": 1.2, "n_ep": 15}, {"R": 1.0, "n_ep": 9}, {"R": 1.6, "n_ep": 40}
        F = M.devblind_outcome
        self.assertEqual(F("ETH", "-0.1", "HIGH", ok, ok, True), ("HIGH", "passed dev-blind"))
        self.assertEqual(F("ETH", "-0.1", "HIGH", few, ok, True), ("MEDIUM", "unconfirmed dev-blind"))
        self.assertEqual(F("BTC", "-0.1", "HIGH", ok, bad, True), ("MEDIUM", "failed dev-blind"))
        self.assertEqual(F("BTC", "-0.1", "HIGH", few, bad, True), ("MEDIUM", "failed dev-blind"))
        self.assertEqual(F("ETH", "-0.1", "MEDIUM", bad, bad, True), ("MEDIUM", "not HIGH"))
        self.assertEqual(F("stETH", "-0.02", "HIGH", None, ok, True), ("HIGH", "passed dev-blind"))
        self.assertEqual(F("stETH", "-0.005", "HIGH", None, None, False),
                         ("MEDIUM", "unconfirmed (level not on the holdout ladder)"))
        G = M.final_outcome
        self.assertEqual(G("HIGH", ok), ("HIGH", "confirmed final"))
        self.assertEqual(G("HIGH", few), ("MEDIUM", "unconfirmed final"))
        self.assertEqual(G("HIGH", bad), ("MEDIUM", "failed final"))
        self.assertEqual(G("HIGH", {"R": float("inf"), "n_ep": 12}), ("MEDIUM", "failed final"))
        self.assertEqual(G("LOW", bad), ("LOW", "not HIGH"))
        self.assertEqual(G("HIGH", ok, on_ladder=False), ("MEDIUM", "unconfirmed final"))


class TestShipping(unittest.TestCase):
    def test_dominance_and_choice(self):
        S = M.ship_choice
        nh = {"a": 5, "f": 3, "fb": 3}
        nm = {"a": 0, "f": 1, "fb": 1}
        bss = {"a": 0.0, "f": 0.05, "fb": 0.06}
        # f eligible and beats a: a removed by dominance even though a has more HIGH labels
        r, info = S(["a", "f"], {("f", "a"): True}, nh, nm, bss)
        self.assertEqual((r, info["removed_by_dominance"]), ("f", ["a"]))
        # f and fb both eligible, fb beats f -> fb
        r, _ = S(["a", "f", "fb"], {("f", "a"): True, ("fb", "a"): True, ("fb", "f"): True}, nh, nm, bss)
        self.assertEqual(r, "fb")
        # neither dominates the other: labels then BSS; an exact tie keeps the simpler rung
        r, _ = S(["a", "f", "fb"], {("f", "a"): True, ("fb", "a"): True}, nh, nm, bss)
        self.assertEqual(r, "fb")
        r, _ = S(["a", "f", "fb"], {("f", "a"): True, ("fb", "a"): True}, nh, nm, {"a": 0, "f": 0.05, "fb": 0.05})
        self.assertEqual(r, "f")
        r, _ = S(["a", "f", "fb"], {("f", "a"): True, ("fb", "a"): True}, {"a": 0, "f": 4, "fb": 3}, nm, bss)
        self.assertEqual(r, "f")
        r, _ = S(["a"], {}, nh, nm, bss)
        self.assertEqual(r, "a")

    def test_locked_fold_windows_D1(self):
        sp = M.locked_fold_span(A.utc("2011-08-18T12:00:00Z"), (2012, 4), (2016, 3))
        self.assertEqual(sp, ((2012, 4), (2016, 3)))
        self.assertEqual(M.locked_fold_span(A.utc("2015-07-20T23:00:00Z"), (2016, 4), (2018, 3))[0], (2016, 4))
        self.assertEqual(M.locked_fold_span(A.utc("2016-05-18T00:00:00Z"), (2017, 3), (2018, 3))[0], (2017, 3))
        self.assertEqual(M.locked_fold_span(A.utc("2020-10-15T00:00:00Z"), None, (2026, 3))[0], (2022, 1))
        ids = [s[0] for s in M.LOCKED_SERIES]
        self.assertEqual(len(ids), 13)
        self.assertEqual(ids[:3], ["bitstamp-btc-usd", "coinbase-btc-usd", "coinbase-eth-usd"])


class TestLockedLoader(unittest.TestCase):
    def test_load_grid_in_fetcher_format_json_and_gz(self):
        st = M.DATA_END - 3600 * 50
        cols = {c: [1.5] * 50 for c in ("open", "high", "low", "close", "volume")}
        cols["low"][3] = None
        cols["close"][3] = None
        body = (json.dumps({"asset": "X/USD", "source": "s", "startTs": st, "stepSeconds": 3600, "count": 50,
                            "columns": cols, "fetchedAt": "x"}) + "\n").encode()
        with tempfile.TemporaryDirectory() as d:
            p1 = os.path.join(d, "a-1h.json")
            open(p1, "wb").write(body)
            p2 = os.path.join(d, "b-1h.json.gz")
            open(p2, "wb").write(gzip.compress(body, mtime=0))
            for p in (p1, p2):
                s, c = M.load_locked_grid(p)
                self.assertEqual(s, st)
                self.assertTrue(np.isnan(c["low"][3]) and c["close"][0] == 1.5)

    def test_locked_phase_refuses_without_freeze_and_twice(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(SystemExit):
                M.run_locked("/nonexistent", d, {}, workers=1, log=lambda *a: None)
            open(os.path.join(d, "locked-run.started"), "w").write("x")
            with self.assertRaises(SystemExit) as cm:
                M.run_locked("/nonexistent", d, {}, workers=1, log=lambda *a: None)
            self.assertIn("once", str(cm.exception))


if __name__ == "__main__":
    unittest.main()
