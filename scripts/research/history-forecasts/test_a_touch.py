#!/usr/bin/env python3
"""Unit tests for a_touch.py on synthetic data only (no dataset read, no score).

  python3 -m unittest scripts/research/history-forecasts/test_a_touch.py -v
"""
import math
import os
import sys
import unittest
import warnings

import numpy as np
from scipy.stats import binom

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import a_touch as A  # noqa: E402

warnings.filterwarnings("ignore", category=FutureWarning, message=".*penalty.*")


class FakeSeries:
    """Duck-typed Series with hand-set labels and features."""

    def __init__(self, labels_by_T, feat, levels, sigma=None):
        self._lab = labels_by_T
        self.feat = feat
        self.feat_ok = np.all(np.isfinite(feat), axis=1)
        self.levels = tuple(levels)
        self.sigma_dvol = sigma
        self.key = "fake"
        self.n_orig = feat.shape[0]

    def labels(self, T_h):
        return self._lab[T_h]


def norm_cdf(x):
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


class TestLabels(unittest.TestCase):
    def setUp(self):
        n = 60
        self.close = np.full(n, 100.0)
        self.low = np.full(n, 100.0)
        self.j = 30
        self.low[self.j] = 85.0   # one dip inside hour j (opening at START + 3600*j)

    def test_spot_is_close_of_hour_opening_t_minus_1h(self):
        c = np.arange(1.0, 11.0)
        s = A.spot_series(c)
        self.assertTrue(np.isnan(s[0]))
        for i in range(1, 11):
            self.assertEqual(s[i], c[i - 1])

    def test_label_window_is_hours_opening_in_t_to_t_plus_T_minus_1h(self):
        T_h = 6
        y = A.make_labels(A.spot_series(self.close), A.window_min(self.low, T_h), (-0.10,))[:, 0]
        j = self.j
        # origin i covers hours i .. i+5: touched iff j in that range
        for i in range(1, 50):
            want = 1.0 if i <= j <= i + T_h - 1 else 0.0
            self.assertEqual(y[i], want, f"origin {i}")
        self.assertEqual(y[j], 1.0)            # the hour opening AT t is inside (t, t+T]
        self.assertEqual(y[j + 1], 0.0)        # dip before t is not counted
        self.assertEqual(y[j - T_h + 1], 1.0)  # hour opening at t+T-1h is inside
        self.assertEqual(y[j - T_h], 0.0)      # hour opening at t+T is outside

    def test_level_threshold_inclusive(self):
        low = self.low.copy()
        low[self.j] = 90.0  # exactly S*(1-0.10)
        y = A.make_labels(A.spot_series(self.close), A.window_min(low, 6), (-0.10, -0.11))
        self.assertEqual(y[self.j, 0], 1.0)
        self.assertEqual(y[self.j, 1], 0.0)

    def test_null_in_window_drops_label(self):
        T_h = 6
        low = self.low.copy()
        i = 10
        low[i + T_h - 1] = np.nan
        y = A.make_labels(A.spot_series(self.close), A.window_min(low, T_h), (-0.10,))[:, 0]
        for o in range(i, i + T_h):
            self.assertTrue(np.isnan(y[o]), o)
        self.assertFalse(np.isnan(y[i - 1]))
        self.assertFalse(np.isnan(y[i + T_h]))
        close = self.close.copy()
        close[20] = np.nan  # S(t_21) undefined
        y2 = A.make_labels(A.spot_series(close), A.window_min(self.low, T_h), (-0.10,))[:, 0]
        self.assertTrue(np.isnan(y2[21]))
        self.assertFalse(np.isnan(y2[20]))

    def test_window_past_grid_end_has_no_label(self):
        T_h = 6
        n = len(self.low)
        y = A.make_labels(A.spot_series(self.close), A.window_min(self.low, T_h), (-0.10,))[:, 0]
        self.assertFalse(np.isnan(y[n - T_h]))      # t + T = DATA_END
        self.assertTrue(np.isnan(y[n - T_h + 1]))   # t + T > DATA_END
        self.assertEqual(len(y), n + 1)

    def test_coverage_mask(self):
        n = 3000
        close = np.full(n, 100.0)
        s = A.Series("BTC", "oracle", close, close.copy(), A.START_TS + 3600 * 50, levels=(-0.1,))
        self.assertTrue(np.all(np.isnan(s.close[:50])))
        self.assertTrue(np.isnan(s.spot[50]))
        self.assertEqual(s.spot[51], 100.0)


class TestFoldsAndPurge(unittest.TestCase):
    def test_training_purge(self):
        lab_ok = np.ones(500, dtype=bool)
        tr = A.train_origins(lab_ok, 300, 24)
        self.assertEqual(tr.max(), 276)
        self.assertTrue(np.all(tr + 24 <= 300))
        lab_ok[100] = False
        self.assertNotIn(100, A.train_origins(lab_ok, 300, 24))

    def test_test_origins_every_6h(self):
        te = A.test_origins(103, 200, 1000)
        self.assertTrue(np.all(te % 6 == 0))
        self.assertEqual(te[0], 108)
        hours = {((A.START_TS + 3600 * int(i)) // 3600) % 24 for i in te}
        self.assertEqual(hours, {0, 6, 12, 18})

    def test_fold_spans(self):
        self.assertEqual(len(A.folds_for("ETH")), 23)
        self.assertEqual(len(A.folds_for("stETH")), 16)
        self.assertEqual(len(A.d_fold_names("BTC")), 18)
        self.assertEqual(A.d_fold_names("stETH"), set())
        f = A.folds_for("ETH")
        self.assertEqual(A.iso(f[0]["qs_ts"]), "2021-01-01T00:00:00Z")
        self.assertEqual(A.iso(f[-1]["qe_ts"]), "2026-10-01T00:00:00Z")
        self.assertEqual(A.folds_for("stETH")[0]["name"], "2022Q4")

    def test_block_lengths(self):
        self.assertEqual([A.block_length(T) for T in A.HORIZONS_H], [30, 30, 30, 30, 30, 60])


class TestRungs(unittest.TestCase):
    def test_recency_weights(self):
        qs = 10000
        w = A.recency_weights(np.array([qs, qs - 365 * 24, qs - 730 * 24]), qs, 365.0)
        np.testing.assert_allclose(w, [1.0, 0.5, 0.25])

    def test_freq_b_and_intercept_only_logistic_equals_b(self):
        rng = np.random.default_rng(1)
        n = 3000
        tr = np.arange(n)
        y = (rng.random(n) < np.linspace(0.05, 0.4, n)).astype(float)
        w = A.recency_weights(tr, n + 24, 30.0)
        p_b = A.freq_b(y[:, None], w)[0]
        self.assertAlmostEqual(p_b, float(np.sum(w * y) / np.sum(w)), places=12)
        self.assertNotAlmostEqual(p_b, y.mean(), places=3)  # weighting matters here
        X = np.zeros((n, 3))  # zero-information features -> zero coefficients
        fit = A.fit_logistic(X, y, w)
        np.testing.assert_allclose(fit["coef"], 0.0, atol=1e-10)
        p = A.predict_logistic(fit, np.zeros((1, 3)))[0]
        self.assertAlmostEqual(p, p_b, delta=1e-4)

    def test_fit_predict_fold_constant_features_c_equals_b(self):
        rng = np.random.default_rng(2)
        n = 4000
        T_h = 6
        lab = np.full((n + 1, 2), np.nan)
        # alternating blocks give many episodes of both labels
        base = (np.sin(np.arange(n + 1) / 15.0) > 0.3).astype(float)
        lab[:n - T_h + 1, 0] = base[:n - T_h + 1]
        lab[:n - T_h + 1, 1] = base[:n - T_h + 1] * (rng.random(n - T_h + 1) < 0.5)
        feat = np.ones((n + 1, 3))
        ser = FakeSeries({T_h: lab}, feat, (-0.02, -0.05))
        qs = 3000
        te = np.arange(qs, qs + 60, 6)
        o = A.fit_predict_fold(ser, T_h, qs, te, in_d=False)
        tr = np.arange(0, qs - T_h + 1)
        self.assertEqual(o["n_train_ab"], len(tr))
        np.testing.assert_allclose(o["raw"]["a"][0], lab[tr].mean(axis=0))
        w = 0.5 ** ((qs - tr) / (365 * 24.0))
        np.testing.assert_allclose(o["raw"]["b"][0], (w[:, None] * lab[tr]).sum(0) / w.sum())
        self.assertFalse(o["c_cell_fb"].any())
        np.testing.assert_allclose(o["raw"]["c"], o["raw"]["b"], atol=1e-4)

    def test_feature_undefined_test_row_takes_b(self):
        n = 4000
        T_h = 6
        lab = np.full((n + 1, 1), np.nan)
        lab[:n - T_h + 1, 0] = (np.sin(np.arange(n - T_h + 1) / 10.0) > 0).astype(float)
        rng = np.random.default_rng(3)
        feat = rng.normal(size=(n + 1, 3))
        feat[3006, 1] = np.nan
        ser = FakeSeries({T_h: lab}, feat, (-0.02,))
        te = np.array([3000, 3006, 3012])
        o = A.fit_predict_fold(ser, T_h, 3000, te, in_d=False)
        self.assertEqual(o["raw"]["c"][1, 0], o["raw"]["b"][1, 0])
        self.assertTrue(o["c_row_fb"][1])
        self.assertFalse(o["c_row_fb"][0])

    def test_episode_counts_and_fallback(self):
        self.assertEqual(A.count_episodes(np.arange(10), np.array([1, 1, 0, 1, 0, 1, 0, 1, 0, 1])), (5, 4))
        self.assertEqual(A.count_episodes(np.array([0, 1, 3, 4]), np.array([1, 1, 1, 1])), (2, 0))  # gap breaks
        self.assertEqual(A.count_episodes(np.array([], dtype=int), np.array([])), (0, 0))
        # a fold whose training rows hold 4 positive episodes falls back to (b)
        n, T_h = 3000, 6
        lab = np.zeros((n + 1, 1))
        lab[n - T_h + 1:] = np.nan
        for s in (100, 400, 700, 1000):
            lab[s:s + 20, 0] = 1.0
        rng = np.random.default_rng(4)
        ser = FakeSeries({T_h: lab}, rng.normal(size=(n + 1, 3)), (-0.05,))
        o = A.fit_predict_fold(ser, T_h, 2000, np.array([2000, 2006]), in_d=False)
        self.assertTrue(o["c_cell_fb"][0])
        np.testing.assert_array_equal(o["raw"]["c"], o["raw"]["b"])
        lab[1300:1320, 0] = 1.0  # 5th episode -> fit
        o = A.fit_predict_fold(ser, T_h, 2000, np.array([2000, 2006]), in_d=False)
        self.assertFalse(o["c_cell_fb"][0])

    def test_d_falls_back_to_c(self):
        n, T_h = 3000, 6
        lab = np.zeros((n + 1, 1))
        lab[n - T_h + 1:] = np.nan
        for s in (100, 400, 700, 1000, 1300):
            lab[s:s + 20, 0] = 1.0
        rng = np.random.default_rng(5)
        sigma = np.full(n + 1, np.nan)
        sigma[1250:] = 0.6  # DVOL only from 1250 -> d has 2 positive episodes -> fallback to c
        ser = FakeSeries({T_h: lab}, rng.normal(size=(n + 1, 3)), (-0.05,), sigma=sigma)
        o = A.fit_predict_fold(ser, T_h, 2000, np.array([2000, 2006]), in_d=True)
        self.assertFalse(o["c_cell_fb"][0])
        self.assertTrue(o["d_cell_fb"][0])
        np.testing.assert_array_equal(o["raw"]["d"], o["raw"]["c"])

    def test_touch_prob_and_dvol_feature(self):
        p = A.touch_prob(-0.10, 0.5, 30.0)
        self.assertAlmostEqual(float(p), min(1, 2 * norm_cdf(math.log(0.9) / (0.5 * math.sqrt(30 / 365)))), places=12)
        x = A.dvol_feature(np.array([0.5]), -0.10, 30.0)[0]
        self.assertAlmostEqual(x, math.log(p / (1 - p)), places=10)
        x_lo = A.dvol_feature(np.array([0.01]), -0.40, 0.25)[0]
        self.assertAlmostEqual(x_lo, math.log(1e-4 / (1 - 1e-4)), places=10)


class TestFeatures(unittest.TestCase):
    def setUp(self):
        rng = np.random.default_rng(7)
        self.close = 100 * np.exp(np.cumsum(rng.normal(0, 0.01, 6000)))

    def test_rv30_formula_and_causality(self):
        c = self.close
        rv = A.rv30_series(c)
        i = 3000
        r = np.log(c[i - 720:i] / c[i - 721:i - 1])
        self.assertAlmostEqual(rv[i], math.sqrt(8760 * np.mean(r ** 2)), places=10)
        self.assertTrue(np.isnan(rv[720]))
        self.assertTrue(np.isfinite(rv[721]))
        c2 = c.copy()
        c2[i:] *= 1.5  # prices after t (hour opening at t closes at t+1h) must not matter
        self.assertEqual(A.rv30_series(c2)[i], rv[i])
        c3 = c.copy()
        c3[i - 721] = np.nan
        self.assertTrue(np.isnan(A.rv30_series(c3)[i]))

    def _brute_pct(self, rv, i, window, min_past):
        if not np.isfinite(rv[i]):
            return np.nan
        past = rv[max(0, i - window):i]
        past = past[np.isfinite(past)]
        if len(past) < min_past:
            return np.nan
        return np.mean(past <= rv[i])

    def test_rv_pct_small_windows_vs_brute_force(self):
        rng = np.random.default_rng(8)
        rv = rng.random(600)
        rv[rng.random(600) < 0.1] = np.nan
        rv[300:305] = rv[299]  # ties
        got = A.rv_pct_series(rv, window=100, min_past=20)
        for i in range(600):
            want = self._brute_pct(rv, i, 100, 20)
            if np.isnan(want):
                self.assertTrue(np.isnan(got[i]), i)
            else:
                self.assertAlmostEqual(got[i], want, places=12, msg=str(i))

    def test_rv_pct_registered_window_and_min_past(self):
        rng = np.random.default_rng(9)
        n = 21000
        rv = rng.random(n)
        rv[:500] = np.nan
        got = A.rv_pct_series(rv)
        # needs >= 2160 defined past values: first defined at origin 500 + 2160
        self.assertTrue(np.isnan(got[500 + 2159]))
        self.assertTrue(np.isfinite(got[500 + 2160]))
        for i in (2660, 9000, 17519, 17520, 17521, 18030, 20999):
            self.assertAlmostEqual(got[i], self._brute_pct(rv, i, 17520, 2160), places=12)
        # only [t - 730 d, t) matters: change values at i and later, or before i - 17520
        i = 19000
        rv2 = rv.copy()
        rv2[i + 1:] = 0.0
        rv2[:i - 17520] = 0.0
        self.assertEqual(A.rv_pct_series(rv2)[i], got[i])
        rv3 = rv.copy()
        rv3[i - 17520] = 2.0  # inside the window (oldest value) -> denominator unchanged, count may change
        self.assertAlmostEqual(A.rv_pct_series(rv3)[i], self._brute_pct(rv3, i, 17520, 2160), places=12)

    def test_trend90_dd90_causality(self):
        c = self.close
        trend, dd = A.trend_dd_series(c)
        i = 4000
        self.assertAlmostEqual(trend[i], math.log(c[i - 1] / c[i - 1 - 2160]), places=12)
        self.assertAlmostEqual(dd[i], c[i - 1] / c[i - 2160:i].max() - 1, places=12)
        c2 = c.copy()
        c2[i:] = 1e6  # future
        t2, d2 = A.trend_dd_series(c2)
        self.assertEqual(t2[i], trend[i])
        self.assertEqual(d2[i], dd[i])
        c3 = c.copy()
        c3[i - 1 - 2160] = 1e6  # price at exactly t - 90 d: in trend, outside (t-90d, t]
        t3, d3 = A.trend_dd_series(c3)
        self.assertEqual(d3[i], dd[i])
        self.assertNotEqual(t3[i], trend[i])
        c4 = c.copy()
        c4[i - 2160] = 1e6  # price at t - 90 d + 1 h: inside the dd window
        _, d4 = A.trend_dd_series(c4)
        self.assertAlmostEqual(d4[i], c[i - 1] / 1e6 - 1, places=12)
        self.assertTrue(np.isnan(trend[2160]))
        self.assertTrue(np.isfinite(trend[2161]))
        self.assertTrue(np.isnan(dd[2159]))
        self.assertTrue(np.isfinite(dd[2160]))

    def test_ref_daily_sigma_matches_q25_estimator(self):
        c = self.close
        i = 5000
        P = [c[i - 1 - 24 * j] for j in range(31)]
        r = [math.log(P[j] / P[j + 1]) for j in range(30)]
        m = math.fsum(r) / 30
        want = math.sqrt(math.fsum((x - m) ** 2 for x in r) / 29 * 365)
        got = A.ref_daily_sigma(c, np.array([i, 10]), 30)
        self.assertAlmostEqual(got[0], want, places=12)
        self.assertTrue(np.isnan(got[1]))


class TestMonotone(unittest.TestCase):
    def test_hand_example(self):
        P = np.array([[0.5, 0.6, 0.2],     # T short
                      [0.4, 0.45, 0.3]])   # T long
        F = A.monotone_fix(P)
        # q: running min across depth -> [[.5,.5,.2],[.4,.4,.3]]; then running max across horizon
        np.testing.assert_allclose(F, [[0.5, 0.5, 0.2], [0.5, 0.5, 0.3]])

    def test_properties_random(self):
        rng = np.random.default_rng(10)
        P = rng.random((200, 6, 10))
        F = A.monotone_fix(P)
        self.assertTrue(np.all(np.diff(F, axis=-1) <= 0))  # non-increasing in depth
        self.assertTrue(np.all(np.diff(F, axis=-2) >= 0))  # non-decreasing in horizon
        M = np.sort(rng.random((5, 6, 10)), axis=-1)[..., ::-1]
        M = np.sort(M, axis=-2)
        np.testing.assert_array_equal(A.monotone_fix(M), M)  # already monotone -> unchanged


class TestBootstrap(unittest.TestCase):
    def test_block_shape_noncircular(self):
        rng = np.random.default_rng(11)
        N, b, R = 95, 30, 400
        idx = A.block_bootstrap_indices(rng, N, b, R)
        self.assertEqual(idx.shape, (R, N))
        self.assertGreaterEqual(idx.min(), 0)
        self.assertLessEqual(idx.max(), N - 1)          # non-circular: never wraps
        nb = math.ceil(N / b)
        for blk in range(nb):
            seg = idx[:, blk * b:min((blk + 1) * b, N)]
            self.assertTrue(np.all(np.diff(seg, axis=1) == 1))
            self.assertTrue(np.all(seg[:, 0] <= N - b))
        # reproduces one rng.integers(0, N-b+1, size=(R, ceil(N/b))) draw
        starts = np.random.default_rng(11).integers(0, N - b + 1, size=(R, nb))
        np.testing.assert_array_equal(idx[:, 0], starts[:, 0])
        np.testing.assert_array_equal(idx[:, -1], starts[:, -1] + (N - 1 - (nb - 1) * b))
        with self.assertRaises(ValueError):
            A.block_bootstrap_indices(rng, 20, 30, 5)

    def test_shared_draws_registered_order(self):
        sets = {}
        rng = np.random.default_rng(12)
        keys = [(a, T, s) for a in ("stETH", "BTC", "ETH") for T in A.HORIZONS_H for s in ("d", "full")
                if not (a == "stETH" and s == "d")]
        for k in keys:
            sets[k] = np.arange(70 + int(rng.integers(0, 30)))
        order = A.draw_order(sets)
        want = [(a, T, s) for a in ("ETH", "BTC", "stETH") for T in A.HORIZONS_H for s in ("full", "d")
                if (a, T, s) in sets]
        self.assertEqual(order, want)
        drawn = list(A.draw_all(sets, n_rep=50))
        rb, ri = np.random.default_rng(A.SEED_BLOCK), np.random.default_rng(A.SEED_IID)
        for (key, ib, ii), k in zip(drawn, want):
            self.assertEqual(key, k)
            n = len(sets[k])
            np.testing.assert_array_equal(ib, A.block_bootstrap_indices(rb, n, A.block_length(k[1]), 50))
            np.testing.assert_array_equal(ii, A.block_bootstrap_indices(ri, n, 1, 50))
        self.assertTrue(np.array_equal(drawn[0][1], list(A.draw_all(sets, n_rep=50))[0][1]))

    def test_bss_stats_each_day_carries_its_rows(self):
        rng = np.random.default_rng(13)
        n_days = 120
        day = np.repeat(np.arange(n_days), 8)
        y = (rng.random(len(day)) < 0.3).astype(float)
        pm = np.clip(y * 0.5 + 0.2 + rng.normal(0, 0.05, len(y)), 0, 1)
        pb = np.full(len(y), 0.3)
        idx = A.block_bootstrap_indices(np.random.default_rng(1), n_days, 30, 300)
        idi = A.block_bootstrap_indices(np.random.default_rng(2), n_days, 1, 300)
        cb, ci = A.replicate_counts(idx, n_days), A.replicate_counts(idi, n_days)
        out = A.bss_stats(day, n_days, pm, pb, y, cb, ci)
        self.assertAlmostEqual(out["bss"], 1 - np.mean((pm - y) ** 2) / np.mean((pb - y) ** 2), places=12)
        # replicate 0 by hand
        d0 = idx[0]
        sel = np.concatenate([np.where(day == d)[0] for d in d0])
        r0 = 1 - np.sum((pm[sel] - y[sel]) ** 2) / np.sum((pb[sel] - y[sel]) ** 2)
        reps = 1 - (cb @ np.bincount(day, (pm - y) ** 2)) / (cb @ np.bincount(day, (pb - y) ** 2))
        self.assertAlmostEqual(reps[0], r0, places=12)
        lo, hi = np.percentile(reps, [2.5, 97.5])
        self.assertAlmostEqual(out["ci95"][0], lo, places=12)
        self.assertAlmostEqual(out["n_eff_boot"], n_days * out["var_iid"] / out["var_block"], places=9)


class TestCalibration(unittest.TestCase):
    def test_ece_equal_width(self):
        p = np.array([0.05, 0.15, 0.95, 1.0])
        y = np.array([0, 1, 1, 1.0])
        ece, tab = A.ece_equal_width(p, y)
        self.assertAlmostEqual(ece, 0.25 * 0.05 + 0.25 * 0.85 + 0.5 * 0.025, places=12)
        self.assertEqual(tab[9]["n"], 2)  # p = 1.0 lands in the closed last bin

    def test_ece_equal_mass(self):
        p = np.array([0.95, 0.05, 1.0, 0.15])
        y = np.array([1, 0, 1, 1.0])
        ece, tab = A.ece_equal_mass(p, y, nbins=2)
        self.assertAlmostEqual(ece, 0.5 * abs(0.5 - 0.1) + 0.5 * abs(1 - 0.975), places=12)
        ece10, tab10 = A.ece_equal_mass(np.linspace(0, 1, 100), np.zeros(100))
        self.assertEqual([t["n"] for t in tab10], [10] * 10)

    def test_binomial_band_and_coverage(self):
        lo, hi = A.binom_band(10, 0.3)
        self.assertEqual((lo, hi), (binom.ppf(0.025, 10, 0.3) / 10, binom.ppf(0.975, 10, 0.3) / 10))
        self.assertEqual((lo, hi), (0.0, 0.6))
        self.assertGreaterEqual(binom.cdf(6, 10, 0.3), 0.975)
        self.assertLess(binom.cdf(5, 10, 0.3), 0.975)
        self.assertEqual(A.coverage_nw(28, 168), 1)
        self.assertEqual(A.coverage_nw(3, 168), 1)
        self.assertEqual(A.coverage_nw(100, 6), 100)
        self.assertEqual(A.coverage_nw(100, 24), 25)
        self.assertEqual(A.coverage_nw(364, 720), 3)
        # ends included
        y = np.array([1] * 6 + [0] * 4, float)
        c = A.coverage_cell(y, np.full(10, 0.3), 6)
        self.assertTrue(c["covered"])
        y = np.array([1] * 7 + [0] * 3, float)
        self.assertFalse(A.coverage_cell(y, np.full(10, 0.3), 6)["covered"])
        c = A.coverage_cell(np.zeros(10), np.zeros(10), 6)
        self.assertTrue(c["covered"])
        self.assertAlmostEqual(A.n_windows(400, 168), 400 * 6 / 168)
        self.assertAlmostEqual(A.n_windows(400, 6), 400)

    def test_confidence_labels(self):
        L = A.confidence_label
        self.assertEqual(L(0.95, 0.9, 0.01, 60), "HIGH")
        self.assertEqual(L(0.90, 0.6, 0.02, 50), "HIGH")
        self.assertEqual(L(0.95, 0.9, 0.01, 49.9), "MEDIUM")
        self.assertEqual(L(0.95, 0.9, 0.03, 60), "MEDIUM")
        self.assertEqual(L(0.80, 0.9, 0.01, 60), "MEDIUM")
        self.assertEqual(L(0.75, 0.9, 0.05, 60), "MEDIUM")
        self.assertEqual(L(0.74, 0.9, 0.01, 60), "LOW")
        self.assertEqual(L(0.95, 0.9, 0.051, 60), "LOW")
        self.assertEqual(L(1.0, 0.59, 0.0, 999), "STALE")
        self.assertEqual(L(0.5, 0.5, 0.5, 1), "STALE")

    def test_shipped_rung(self):
        S = A.shipped_rung
        self.assertEqual(S({"b_vs_a": False, "c_vs_b": True, "d_vs_c": True}, True), "a")
        self.assertEqual(S({"b_vs_a": True, "c_vs_b": False, "d_vs_c": True}, True), "b")
        self.assertEqual(S({"b_vs_a": True, "c_vs_b": True, "d_vs_c": False}, True), "c")
        self.assertEqual(S({"b_vs_a": True, "c_vs_b": True, "d_vs_c": True}, True), "d")
        self.assertEqual(S({"b_vs_a": True, "c_vs_b": True}, False), "c")


class TestAction(unittest.TestCase):
    levels = (-0.02, -0.03, -0.05, -0.07, -0.10, -0.15, -0.20, -0.25, -0.30, -0.40)
    probs = (0.90, 0.80, 0.60, 0.45, 0.30, 0.15, 0.08, 0.04, 0.02, 0.005)

    def lg(self, p):
        return math.log(p / (1 - p))

    def test_interp_in_logit_and_log1p_k(self):
        p, st = A.p_at_distance(self.levels, self.probs, -0.25)
        self.assertEqual(st, "ok")
        self.assertAlmostEqual(p, 0.04, places=12)
        y = math.exp(0.5 * (math.log(0.80) + math.log(0.75))) - 1  # midpoint in ln(1+k) of -20%/-25%
        p, _ = A.p_at_distance(self.levels, self.probs, y)
        want = 1 / (1 + math.exp(-0.5 * (self.lg(0.08) + self.lg(0.04))))
        self.assertAlmostEqual(p, want, places=12)
        self.assertEqual(A.p_at_distance(self.levels, self.probs, -0.45)[1], "deeper_than_grid")
        self.assertEqual(A.p_at_distance(self.levels, self.probs, -0.01)[1], "shallower_than_grid")

    def test_reverse_solve_round_trip(self):
        for Z in (0.10, 0.05, 0.01):
            ys, st = A.solve_distance(self.levels, self.probs, Z)
            self.assertEqual(st, "ok")
            p, _ = A.p_at_distance(self.levels, self.probs, ys)
            self.assertAlmostEqual(p, Z, places=10)
        ys, _ = A.solve_distance(self.levels, self.probs, 0.04)
        self.assertAlmostEqual(ys, -0.25, places=12)
        self.assertEqual(A.solve_distance(self.levels, self.probs, 0.95)[1], "shallower_than_grid")
        self.assertEqual(A.solve_distance(self.levels, self.probs, 0.001)[1], "deeper_than_grid")

    def test_repay_rounding_and_floor_toward_risk(self):
        D, C, LT, S = 24900.0, 10.0, 0.83, 4000.0  # line at -25%
        self.assertAlmostEqual(D / (C * LT) / S - 1, -0.25, places=12)
        X, raw = A.repay_amount(D, C, LT, S, -0.30)
        self.assertAlmostEqual(raw, 1660.0, places=6)
        self.assertEqual(X, 1660)
        X, raw = A.repay_amount(D, C, LT, S, -0.301)
        self.assertAlmostEqual(raw, 1693.2, places=6)
        self.assertEqual(X, 1700)
        self.assertEqual(A.floor_pct_toward_risk(-0.276), 27)
        self.assertEqual(A.floor_pct_toward_risk(-0.25), 25)
        self.assertEqual(A.floor_pct_toward_risk(-0.2499999999999), 25)
        self.assertEqual(A.floor_pct_toward_risk(-0.3012), 30)
        probs = list(self.probs)
        rows = A.action_rows(self.levels, probs, D, C, LT, S, targets=(0.02, 0.5, 0.001))
        self.assertEqual(rows[0]["repay"], 1660)
        self.assertEqual(rows[0]["text"], "Repay $1,660 \u2192 line at \u221230% \u2192 7d 2%")
        self.assertEqual(rows[1]["text"], "no repay needed")   # p(-25%) already below 50%
        self.assertEqual(rows[2]["status"], "deeper_than_grid")


if __name__ == "__main__":
    unittest.main()
