#!/usr/bin/env python3
"""Unit tests for a2_touch.py on synthetic data only (no dataset read, no score).

  python3 -m unittest scripts/research/history-forecasts/test_a2_touch.py -v
"""
import math
import os
import sys
import unittest
import warnings

import numpy as np
from scipy.special import ndtr
from scipy.stats import binom

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import a2_touch as M  # noqa: E402
import a_touch as A  # noqa: E402

warnings.filterwarnings("ignore", category=FutureWarning, message=".*penalty.*")


def random_walk(n, seed=1, vol=0.01, null_at=()):
    rng = np.random.default_rng(seed)
    r = rng.normal(0, vol, n) * (1 + 2 * (np.arange(n) > n // 2))   # a volatility regime change
    close = 100 * np.exp(np.cumsum(r))
    low = close * np.exp(-np.abs(rng.normal(0, vol / 2, n)))
    for j in null_at:
        close[j] = np.nan
        low[j] = np.nan
    return close, low


def make_ser(close, low, levels=(-0.02, -0.05, -0.10), dvol=None):
    return M.GSeries("syn", "SYN", "syn", close, low, levels, M.BASE_TS, dvol=dvol)


class TestSigmaHat(unittest.TestCase):
    def test_constant_abs_return_gives_c_sqrt_8760_after_1440_returns(self):
        c = 0.004
        n = 2000
        sgn = np.where(np.arange(n) % 3 == 0, 1.0, -1.0)
        close = 100 * np.exp(np.cumsum(c * sgn))
        s = M.ewma_sigma(close)
        self.assertEqual(len(s), n + 1)
        # origin i uses returns r_1..r_{i-1}: i - 1 returns -> defined iff i - 1 >= 1440
        self.assertTrue(np.all(np.isnan(s[:1441])))
        self.assertTrue(np.all(np.isfinite(s[1441:])))
        np.testing.assert_allclose(s[1441:], c * math.sqrt(8760), rtol=1e-9)

    def test_recursive_equals_direct_weights_half_life_336_with_nulls_skipped(self):
        close, _ = random_walk(1800, seed=3, null_at=(100, 101, 900, 1700))
        s = M.ewma_sigma(close)
        for i in (1446, 1450, 1500, 1701, 1702, 1750, 1800):
            self.assertAlmostEqual(s[i], M.ewma_sigma_direct(close, i), places=12)
        # 4 null closes remove 6 returns (100,101,102 | 900,901 | 1700,1701 -> 7 returns): warm-up counts valid ones
        r = np.log(close[1:] / close[:-1])
        cnt = np.concatenate([[0], np.cumsum(np.isfinite(r))])   # cnt[m] = valid returns among r_1..r_m
        first = int(np.argmax(cnt >= 1440))                       # first hour m with 1440 valid returns
        self.assertTrue(np.isnan(s[first]))                       # origin first uses r up to m = first - 1
        self.assertTrue(np.isfinite(s[first + 1]))

    def test_weight_at_lag_336_is_half_of_lag_0(self):
        n = 1600
        base = np.full(n, 100.0)
        x = 0.05
        a = base.copy()
        a[n - 1:] = 100 * math.exp(x)                    # one return at lag 0 for origin n
        b = base.copy()
        b[n - 1 - 336:] = 100 * math.exp(x)              # one return at lag 336
        sa, sb = M.ewma_sigma(a)[n], M.ewma_sigma(b)[n]
        self.assertAlmostEqual((sb / sa) ** 2, 0.5, places=12)

    def test_null_return_drops_its_weight(self):
        n = 1600
        close = np.full(n, 100.0)
        close[-1] = 100 * math.exp(0.02)           # last return (lag 0 at origin n) = 0.02
        cl2 = close.copy()
        cl2[n - 5] = np.nan                        # removes returns at lags 3 and 4 (both zero)
        lam = 0.5 ** (1 / 336)
        num = 0.02 ** 2
        den_full = sum(lam ** j for j in range(n - 1))
        den_null = den_full - lam ** 3 - lam ** 4
        self.assertAlmostEqual(M.ewma_sigma(close)[n], math.sqrt(8760 * num / den_full), places=12)
        self.assertAlmostEqual(M.ewma_sigma(cl2)[n], math.sqrt(8760 * num / den_null), places=12)


class TestFHS(unittest.TestCase):
    def setUp(self):
        close, low = random_walk(2600, seed=7, null_at=(2000,))
        self.ser = make_ser(close, low)
        self.T = 6
        self.P = M.PrepT(self.ser, self.T, asof=True)

    def brute_pf(self, qs, t0, k):
        ser, T = self.ser, self.T
        y = ser.labels(T)
        sc = math.sqrt(T / 8760)
        zs = []
        for i in range(ser.n_orig):
            if i + T <= qs and np.isfinite(y[i, 0]) and np.isfinite(ser.sigma[i]):
                zs.append(math.log(ser.wmin(T)[i] / ser.spot[i]) / (ser.sigma[i] * sc))
        u = math.log(1 + k) / (ser.sigma[t0] * sc)
        return sum(z <= u for z in zs) / len(zs), len(zs)

    def test_fold_fhs_equals_brute_force_with_label_purge(self):
        qs = 2400
        te = np.array([2400, 2406, 2500])
        o = M.predict_fold(self.ser, self.P, self.T, qs, te, False, ("f",))
        for r, t0 in enumerate(te):
            for j, k in enumerate(self.ser.levels):
                pf, n = self.brute_pf(qs, t0, k)
                self.assertAlmostEqual(o["raw"]["f"][r, j], pf, places=14)
        self.assertEqual(o["n_train_f"], n)
        # purge: the origin qs - T is in, qs - T + 1 is out
        o2 = M.predict_fold(self.ser, self.P, self.T, qs + 1, te, False, ("f",))
        self.assertEqual(o2["n_train_f"], n + 1)

    def test_fhs_equals_plain_frequency_when_vol_is_constant(self):
        c = 0.003
        n = 2600
        rng = np.random.default_rng(5)
        close = 100 * np.exp(np.cumsum(c * rng.choice([-1.0, 1.0], n)))
        ser = make_ser(close, close.copy(), levels=(-0.004, -0.01, -0.02))
        P = M.PrepT(ser, 24, asof=False)
        sig = ser.sigma[1500:]
        np.testing.assert_allclose(sig[np.isfinite(sig)], c * math.sqrt(8760), rtol=1e-9)
        o = M.predict_fold(ser, P, 24, 2400, np.array([2400, 2424]), False, ("f",))
        # z <= u  <=>  depth <= ln(1+k) when sigma is the same everywhere; (a) counts the same set where sigma exists
        y = ser.labels(24)
        i = np.arange(ser.n_orig)
        tr = np.isfinite(y[:, 0]) & np.isfinite(ser.sigma) & (i + 24 <= 2400)
        np.testing.assert_allclose(o["raw"]["f"][0], y[tr].mean(axis=0), atol=1e-12)

    def test_fd_uses_dvol_candle_opening_t_minus_1h_at_train_and_forecast(self):
        close, low = random_walk(2600, seed=11)
        dv = np.full(2601, np.nan)
        dv[300:] = 40 + 20 * np.sin(np.arange(2301) / 50.0)
        ser = make_ser(close, low, dvol=dv)
        self.assertTrue(np.isnan(ser.sigma_dvol[300]))
        self.assertAlmostEqual(ser.sigma_dvol[301], dv[300] / 100)
        self.assertAlmostEqual(ser.sigma_dvol[1000], dv[999] / 100)
        T = 24
        P = M.PrepT(ser, T, asof=True, with_fd=True)
        qs, te = 2400, np.array([2400, 2500])
        o = M.predict_fold(ser, P, T, qs, te, True, ("f", "fd"))
        y = ser.labels(T)
        sc = math.sqrt(T / 8760)
        zs = [math.log(ser.wmin(T)[i] / ser.spot[i]) / (dv[i - 1] / 100 * sc) for i in range(301, qs - T + 1)
              if np.isfinite(y[i, 0])]
        for r, t0 in enumerate(te):
            for j, k in enumerate(ser.levels):
                u = math.log(1 + k) / (dv[t0 - 1] / 100 * sc)
                self.assertAlmostEqual(o["raw"]["fd"][r, j], sum(z <= u for z in zs) / len(zs), places=14)
        self.assertEqual(o["n_train_fd"], len(zs))


class TestSplice(unittest.TestCase):
    def test_registered_splice_points_D2(self):
        self.assertEqual(A.iso(M.SPLICE_TS["ETH"]), "2020-04-08T21:00:00Z")
        self.assertEqual(A.iso(M.SPLICE_TS["BTC"]), "2020-01-01T00:00:00Z")   # D2
        self.assertEqual(A.iso(M.BASE_TS), "2017-08-17T04:00:00Z")
        self.assertEqual(M.OFF_A, 20804)
        self.assertEqual(M.gi(M.SPLICE_TS["ETH"]), 20804 + 98 * 24 + 21)

    def test_splice_takes_binance_before_and_oracle_from_the_splice_hour(self):
        n = 50
        bc, bl = np.arange(n) + 1000.0, np.arange(n) + 900.0
        oc, ol = np.arange(n) + 2000.0, np.arange(n) + 1900.0
        oc[:30] = np.nan
        ol[:30] = np.nan
        oc[12] = 5.0                       # a pre-splice oracle value (like ETH's pre-coverage island) is replaced
        c, lo = M.splice(bc, bl, oc, ol, splice_i=30, first_i=4)
        self.assertTrue(np.all(np.isnan(c[:4])) and np.all(np.isnan(lo[:4])))
        np.testing.assert_array_equal(c[4:30], bc[4:30])
        np.testing.assert_array_equal(lo[4:30], bl[4:30])
        np.testing.assert_array_equal(c[30:], oc[30:])
        np.testing.assert_array_equal(lo[30:], ol[30:])

    def test_label_window_straddling_the_splice_mixes_hourly_sources(self):
        n = 60
        bc = np.full(n, 100.0)
        bl = np.full(n, 99.0)
        oc = np.full(n, 100.0)
        ol = np.full(n, 99.5)
        bl[28] = 80.0                       # a Binance wick before the splice
        ol[33] = 85.0                       # an oracle dip after the splice
        c, lo = M.splice(bc, bl, oc, ol, splice_i=30, first_i=0)
        ser = make_ser(c, lo, levels=(-0.10, -0.18))
        y = ser.labels(6)
        self.assertEqual(y[27, 1], 1.0)     # window 27..32 holds the Binance wick at 28 (80 <= 82)
        self.assertEqual(y[29, 0], 1.0)     # window 29..34: oracle 85 <= 90
        self.assertEqual(y[29, 1], 0.0)     # 85 > 82; the Binance wick at 28 is outside
        self.assertEqual(ser.spot[30], 100.0)


class TestStacking(unittest.TestCase):
    def setUp(self):
        close, low = random_walk(2400, seed=21, null_at=(1900,))
        self.ser = make_ser(close, low)
        self.T = 24
        self.P = M.PrepT(self.ser, self.T, asof=True)

    def test_inner_purge_asof_a_and_f_use_origins_with_t_prime_plus_T_le_t(self):
        ser, T, P = self.ser, self.T, self.P
        y = ser.labels(T)
        sc = math.sqrt(T / 8760)
        for t in (1600, 1700, 1955, 2300):
            lab = [i for i in range(ser.n_orig) if i + T <= t and np.isfinite(y[i, 0])]
            np.testing.assert_allclose(P.asof["a"][t], y[lab].mean(axis=0), atol=1e-15)
            zs = [math.log(ser.wmin(T)[i] / ser.spot[i]) / (ser.sigma[i] * sc) for i in lab if np.isfinite(ser.sigma[i])]
            for j, k in enumerate(ser.levels):
                u = math.log(1 + k) / (ser.sigma[t] * sc)
                self.assertAlmostEqual(P.asof["f"][t, j], sum(z <= u for z in zs) / len(zs), places=14)
        # the as-of value at origin qs equals the fold prediction at t0 = qs (same training set)
        qs = 2016
        o = M.predict_fold(ser, P, T, qs, np.array([qs]), False, ("f",))
        np.testing.assert_allclose(o["raw"]["a"][0], P.asof["a"][qs], atol=1e-15)
        np.testing.assert_allclose(o["raw"]["f"][0], P.asof["f"][qs], atol=1e-15)

    def test_training_rows_are_purged_and_need_every_feature(self):
        P, T = self.P, self.T
        qs = 2016
        X, y, w, n_or, tr = M.stack_training(P, qs, ("a", "f", "r30"))
        self.assertTrue(np.all(tr + T <= qs))
        self.assertEqual(X.shape, (n_or * 3, 3))
        for f in ("a", "f", "r30"):
            self.assertTrue(np.all(np.isfinite(P.asof[f][tr])))
        # origins near the null close have no RV30 or no label -> excluded
        self.assertFalse(np.isin(1900, tr))
        # recency weights 0.5^((Q_start - t)/365 d) (before the mean-1 rescale)
        np.testing.assert_allclose(w[::3], 0.5 ** ((qs - tr) / (365 * 24.0)))
        np.testing.assert_allclose(X[:, 0], M.clip_logit(P.asof["a"][tr]).ravel())

    def test_pooled_logistic_matches_manual_sklearn_fit_and_prediction(self):
        from sklearn.linear_model import LogisticRegression
        warnings.filterwarnings("ignore", category=FutureWarning, message=".*penalty.*")
        ser, P, T = self.ser, self.P, self.T
        qs = 2016
        te = np.array([2016, 2022, 2100])
        o = M.predict_fold(ser, P, T, qs, te, False, ("f", "s", "r30"))
        X, y, w, n_or, tr = M.stack_training(P, qs, ("a", "f", "r30"))
        mu, sd = X.mean(0), X.std(0)
        m = LogisticRegression(penalty="l2", C=1.0, solver="lbfgs", max_iter=1000)
        m.fit((X - mu) / sd, y, sample_weight=w / w.mean())
        Xt = np.stack([M.clip_logit(o["raw"]["a"]).ravel(), M.clip_logit(o["raw"]["f"]).ravel(),
                       M.clip_logit(o["raw"]["r30"]).ravel()], axis=1)
        p = m.predict_proba((Xt - mu) / sd)[:, 1].reshape(len(te), -1)
        np.testing.assert_allclose(o["raw"]["s"], p, atol=1e-12)
        self.assertEqual(o["fits"][0]["n_rows"], len(y))
        self.assertEqual(len(o["fits"][0]["coef"]), 3)       # one model pooled over the 3 levels

    def test_s_falls_back_to_f_when_rv30_is_undefined_at_t0(self):
        ser, P, T = self.ser, self.P, self.T
        te = np.array([1901 + 24 * 3, 2100])   # first origin's RV30 window hits the null close at 1900
        o = M.predict_fold(ser, P, T, 1872, te, False, ("f", "s", "r30"))
        self.assertTrue(np.all(np.isnan(o["raw"]["r30"][0])))
        self.assertTrue(o["flags"]["s_row_fb"][0] and not o["flags"]["s_row_fb"][1])
        np.testing.assert_array_equal(o["raw"]["s"][0], o["raw"]["f"][0])


class TestReferenceFormula(unittest.TestCase):
    def test_r30_r90_q25_estimator(self):
        close, _ = random_walk(24 * 100, seed=4)
        i = 24 * 95
        for nd in (30, 90):
            P = np.array([close[i - 1 - 24 * j] for j in range(nd + 1)])
            r = np.log(P[:-1] / P[1:])
            sig = math.sqrt(np.var(r, ddof=1) * 365)
            self.assertAlmostEqual(A.ref_daily_sigma(close, np.array([i]), nd)[0], sig, places=12)
            for k, Td in ((-0.05, 7.0), (-0.20, 0.25)):
                want = min(1.0, 2 * ndtr(math.log(1 + k) / (sig * math.sqrt(Td / 365))))
                self.assertAlmostEqual(float(A.touch_prob(k, np.array([sig]), Td)[0]), want, places=14)
        c2 = close.copy()
        c2[i - 1 - 24 * 7] = np.nan
        self.assertTrue(np.isnan(A.ref_daily_sigma(c2, np.array([i]), 30)[0]))


class TestConfidenceRule(unittest.TestCase):
    def test_episodes_are_runs_of_consecutive_issue_times(self):
        t = np.array([0, 6, 12, 18, 24, 30, 42, 48, 54]) + 2
        y = np.array([1, 1, 0, 1, 1, 1, 1, 1, 0])
        # runs: {0,6}, {18,24,30}, {42,48} (36 missing breaks the run)
        self.assertEqual(M.count_touch_episodes(t, y), 3)
        self.assertEqual(M.count_touch_episodes(t[::-1], y[::-1]), 3)
        self.assertEqual(M.count_touch_episodes(np.array([]), np.array([])), 0)

    def test_ratio_and_bootstrap_ci_with_inf_replicates(self):
        rng = np.random.default_rng(0)
        n_days = 60
        day = np.repeat(np.arange(n_days), 4)
        y = np.zeros(len(day))
        y[day == 5] = 1.0                                  # touches only on day 5
        p = np.full(len(day), 0.02)
        idx = A.block_bootstrap_indices(rng, n_days, 30, 500)
        cnt = A.replicate_counts(idx, n_days)
        R, ci = M.ratio_ci(day, n_days, p, y, cnt)
        self.assertAlmostEqual(R, p.sum() / y.sum())
        self.assertEqual(ci[1], float("inf"))             # some replicates miss day 5
        R0, _ = M.ratio_ci(day, n_days, p, np.zeros(len(day)), cnt)
        self.assertEqual(R0, float("inf"))

    def test_informative_cells_and_coverage(self):
        T = 24
        f = np.repeat([0, 1, 2], 360)        # 3 folds x 360 rows (n_w = 90 each)
        p = np.concatenate([np.full(360, 0.001), np.full(360, 0.05), np.full(360, 0.05)])
        y = np.zeros(1080)
        y[360:378] = 1                       # fold 1: ybar 0.05
        y[720:900] = 1                       # fold 2: ybar 0.5 -> outside the band
        cells = M.fold_cells(f, p, y, T)
        self.assertEqual([c["informative"] for c in cells], [False, True, True])   # 0.001 < 1/90, no touch
        self.assertEqual([c["covered"] for c in cells], [True, True, False])
        cov, n = M.cov_inf_of(cells)
        self.assertEqual((cov, n), (0.5, 2))
        lo, hi = binom.ppf(0.025, 90, 0.05) / 90, binom.ppf(0.975, 90, 0.05) / 90
        self.assertTrue(lo <= 0.05 <= hi and not (lo <= 0.5 <= hi))

    def test_label_thresholds(self):
        L = M.label_v2
        self.assertEqual(L(20, 1.0, [0.67, 1.5], 0.85, 8, False), "HIGH")
        self.assertEqual(L(19, 1.0, [0.9, 1.1], 0.9, 10, False), "MEDIUM")
        self.assertEqual(L(25, 1.26, [0.9, 1.4], 0.9, 10, False), "MEDIUM")
        self.assertEqual(L(25, 1.0, [0.66, 1.4], 0.9, 10, False), "MEDIUM")
        self.assertEqual(L(25, 1.0, [0.7, 1.51], 0.9, 10, False), "MEDIUM")
        self.assertEqual(L(25, 1.0, [0.7, 1.4], 0.84, 10, False), "MEDIUM")
        self.assertEqual(L(25, 1.0, [0.7, 1.4], 0.9, 7, False), "MEDIUM")
        self.assertEqual(L(10, 0.67, None, 0.70, 3, False), "MEDIUM")
        self.assertEqual(L(10, 1.51, None, 0.9, 3, False), "LOW")
        self.assertEqual(L(10, 1.0, None, 0.69, 3, False), "LOW")
        self.assertEqual(L(10, 1.0, None, None, 0, False), "LOW")
        self.assertEqual(L(9, 1.0, [0.9, 1.1], 1.0, 20, False), "insufficient")
        self.assertEqual(L(0, float("inf"), None, None, 0, False), "insufficient")
        self.assertEqual(L(30, 1.0, [0.9, 1.1], 1.0, 20, True), "STALE")

    def test_stale(self):
        self.assertTrue(M.stale_v2(2.1, 5, 1.0, 4)[0])
        self.assertTrue(M.stale_v2(0.49, 5, 1.0, 4)[0])
        self.assertFalse(M.stale_v2(2.1, 4, 1.0, 4)[0])
        self.assertFalse(M.stale_v2(2.0, 9, 1.0, 4)[0])
        self.assertTrue(M.stale_v2(1.0, 9, 0.25, 4)[0])
        self.assertFalse(M.stale_v2(1.0, 9, 0.25, 3)[0])
        self.assertFalse(M.stale_v2(None, 0, None, 0)[0])

    def test_level_stats_end_to_end_on_a_calibrated_synthetic_cell(self):
        rng = np.random.default_rng(9)
        T = 24
        n_folds, per = 12, 360
        t0 = 2 + 6 * np.arange(n_folds * per)
        fold = np.repeat(np.arange(n_folds), per)
        # touch spells: 4-row runs starting with prob 0.03 -> ~0.1 touch rate
        y = np.zeros(len(t0))
        for s in np.where(rng.random(len(t0)) < 0.03)[0]:
            y[s:s + 4] = 1
        p = np.full(len(t0), y.mean())
        day = t0 // 24
        days = np.unique(day)
        pos = np.searchsorted(days, day)
        cnt = A.replicate_counts(A.block_bootstrap_indices(np.random.default_rng(1), len(days), 30, 400), len(days))
        st = M.level_stats(t0, fold, pos, len(days), p, y, cnt, T, set(range(8, 12)))
        self.assertAlmostEqual(st["R"], 1.0, places=12)
        self.assertEqual(st["n_ep"], M.count_touch_episodes(t0, y))
        self.assertGreaterEqual(st["n_ep"], 20)
        self.assertEqual(st["n_cells"], 12)
        self.assertIn(st["label"], ("HIGH", "MEDIUM"))
        # far over-forecast -> LOW; over-forecast in the last 4 folds only -> STALE
        st2 = M.level_stats(t0, fold, pos, len(days), p * 3, y, cnt, T, set(range(8, 12)))
        self.assertEqual(st2["label"], "STALE")
        p3 = np.where(fold >= 8, p * 3, p)
        st3 = M.level_stats(t0, fold, pos, len(days), p3, y, cnt, T, set(range(8, 12)))
        self.assertEqual(st3["label"], "STALE")
        self.assertTrue(st3["recent"]["R_outside"])


class TestBlindConfirmation(unittest.TestCase):
    def test_outcomes(self):
        ok = {"R": 1.1, "n_ep": 12}
        few = {"R": 1.0, "n_ep": 9}
        bad = {"R": 1.6, "n_ep": 30}
        C = M.confirm_high
        self.assertEqual(C("ETH", "a", "HIGH", ok, ok), ("HIGH", "confirmed"))
        self.assertEqual(C("ETH", "a_long", "HIGH", ok, ok), ("HIGH", "confirmed"))
        self.assertEqual(C("BTC", "f", "HIGH", few, ok), ("MEDIUM", "unconfirmed"))
        self.assertEqual(C("BTC", "f", "HIGH", ok, few), ("MEDIUM", "unconfirmed"))
        self.assertEqual(C("ETH", "s", "HIGH", ok, bad), ("MEDIUM", "failed blind"))
        self.assertEqual(C("ETH", "s", "HIGH", few, bad), ("MEDIUM", "failed blind"))
        self.assertEqual(C("ETH", "r90", "HIGH", {"R": 0.67, "n_ep": 10}, {"R": 1.5, "n_ep": 10}),
                         ("HIGH", "confirmed"))
        self.assertEqual(C("ETH", "s_d", "HIGH", ok, ok), ("MEDIUM", "unconfirmed (rung not scored blind)"))
        self.assertEqual(C("ETH", "d", "HIGH", ok, ok), ("MEDIUM", "unconfirmed (rung not scored blind)"))
        self.assertEqual(C("stETH", "a", "HIGH", None, None), ("MEDIUM", "capped: no blind set"))
        self.assertEqual(C("stETH", "a", "MEDIUM", None, None), ("MEDIUM", "not HIGH"))
        self.assertEqual(C("ETH", "a", "LOW", bad, bad), ("LOW", "not HIGH"))
        self.assertEqual(C("ETH", "a", "HIGH", None, ok), ("MEDIUM", "unconfirmed"))

    def test_holdout_first_test_quarter(self):
        firsts = {"BNBUSDT": ("2017-11-06T03:00:00Z", "2019Q1"), "XRPUSDT": ("2018-05-04T08:00:00Z", "2019Q3"),
                  "ADAUSDT": ("2018-04-17T04:00:00Z", "2019Q3"), "LTCUSDT": ("2017-12-13T03:00:00Z", "2019Q1"),
                  "LINKUSDT": ("2019-01-16T10:00:00Z", "2020Q2"), "DOGEUSDT": ("2019-07-05T12:00:00Z", "2020Q4"),
                  "SOLUSDT": ("2020-08-11T06:00:00Z", "2021Q4"), "AVAXUSDT": ("2020-09-22T06:00:00Z", "2021Q4")}
        for p, (ts, q) in firsts.items():
            y, qq = M.holdout_first_quarter(A.utc(ts))
            self.assertEqual(f"{y}Q{qq}", q, p)
        self.assertEqual([f["name"] for f in M.quarters(*M.BSPAN_SPAN)][0], "2018Q4")
        self.assertEqual(len(M.quarters(*M.BSPAN_SPAN)), 9)

    def test_issue_times_are_00_06_12_18Z_on_the_common_grid(self):
        m = M.issue_mask(48)
        hrs = [(M.BASE_TS + 3600 * i) % 86400 // 3600 for i in np.where(m)[0]]
        self.assertEqual(sorted(set(hrs)), [0, 6, 12, 18])
        self.assertEqual(int(m.sum()), 8)


class TestShipping(unittest.TestCase):
    def test_choice(self):
        ch = M.choose_shipped
        bss = {"a": 0.0, "f": 0.02, "s": 0.04, "a_long": 0.01, "d": 0.05}
        r, why, lit = ch(["a", "f", "s"], {"a": 3, "f": 5, "s": 4}, {"a": 0, "f": 0, "s": 3}, bss, "a")
        self.assertEqual(r, "f")
        # tie in labels with (a): keeps (a), although the literal BSS key would pick s
        r, why, lit = ch(["a", "f", "s"], {"a": 4, "f": 4, "s": 4}, {"a": 2, "f": 2, "s": 2}, bss, "a")
        self.assertEqual((r, lit), ("a", "s"))
        # MEDIUM count breaks a HIGH tie
        r, _, _ = ch(["a", "f"], {"a": 4, "f": 4}, {"a": 2, "f": 3}, bss, "a")
        self.assertEqual(r, "f")
        # incumbent (A shipped d) ties with a challenger -> incumbent
        r, _, _ = ch(["a", "d", "s"], {"a": 1, "d": 4, "s": 4}, {"a": 0, "d": 2, "s": 2}, bss, "d")
        self.assertEqual(r, "d")
        # (a) ties the incumbent -> (a) (the lower rung)
        r, _, _ = ch(["a", "d"], {"a": 4, "d": 4}, {"a": 2, "d": 2}, bss, "d")
        self.assertEqual(r, "a")
        # only challengers tie at the top -> higher BSS vs (a)
        r, _, _ = ch(["a", "a_long", "f", "s"], {"a": 1, "a_long": 2, "f": 5, "s": 5},
                     {"a": 0, "a_long": 0, "f": 1, "s": 1}, bss, "a")
        self.assertEqual(r, "s")
        r, _, _ = ch(["a"], {"a": 0}, {"a": 0}, bss, "a")
        self.assertEqual(r, "a")


class TestAssemble(unittest.TestCase):
    def test_monotone_fix_and_row_flattening(self):
        close, low = random_walk(4000, seed=31)
        ser = make_ser(close, low)
        imask = M.issue_mask(ser.n_orig)
        folds = [{"name": "F1", "qs_i": 3000, "qe_i": 3300}, {"name": "F2", "qs_i": 3300, "qe_i": 3600}]
        per_T = {}
        for T in M.HORIZONS_H:
            P = M.PrepT(ser, T, asof=True)
            res = []
            for f in folds:
                te = M.test_issue_times(f["qs_i"], f["qe_i"], ser.n_orig, imask)
                o = M.predict_fold(ser, P, T, f["qs_i"], te, False, ("f", "s", "r30", "r90"))
                o["fold"], o["te"] = f["name"], te
                res.append(o)
            per_T[T] = res
        R, fits, de = M.assemble(ser, folds, per_T, ("a", "f", "s", "r30", "r90"))
        K = len(ser.levels)
        # rows exist only for labelled (t0, T); every rung grid is non-increasing in depth
        for r in ("a", "f", "s"):
            p = R[f"p_{r}"]
            for T in M.HORIZONS_H:
                m = R["T_h"] == T
                g = p[m].reshape(K, -1)          # rows are level-major within a horizon
                self.assertTrue(np.all(np.diff(g, axis=0) <= 1e-15))
        # non-decreasing in horizon at a fixed (t0, level)
        t_last = R["t0_i"][R["T_h"] == 720].min()
        vals = [R["p_s"][(R["t0_i"] == t_last) & (R["T_h"] == T) & (R["k_i"] == 0)][0] for T in M.HORIZONS_H]
        self.assertTrue(np.all(np.diff(vals) >= -1e-15))
        self.assertEqual(len(np.unique(R["fold_i"])), 2)
        self.assertTrue(np.all(np.isfinite(ser.labels(6)[R["t0_i"][R["T_h"] == 6], 0])))


if __name__ == "__main__":
    unittest.main()
