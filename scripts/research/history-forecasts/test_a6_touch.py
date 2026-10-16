#!/usr/bin/env python3
"""Unit tests for a6_touch.py on synthetic data only (no dataset read, no score).

  python3 -m unittest scripts/research/history-forecasts/test_a6_touch.py -v
"""
import json
import math
import os
import sys
import tempfile
import unittest
import warnings

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import a6_touch as M  # noqa: E402
import a3_touch as M3  # noqa: E402
import a_touch as A  # noqa: E402

warnings.filterwarnings("ignore")
LEVELS6 = (-0.02, -0.05, -0.07, -0.10, -0.20, -0.30)


def walk(n, seed=1, vol=0.01, nulls=()):
    rng = np.random.default_rng(seed)
    r = rng.normal(0, vol, n) * (1 + 2 * (np.sin(np.arange(n) / 700.0) > 0.3))
    c = 100 * np.exp(np.cumsum(r))
    lo = c * np.exp(-np.abs(rng.normal(0, vol / 2, n)))
    hi = c * np.exp(np.abs(rng.normal(0, vol / 2, n)))
    for j in nulls:
        c[j] = lo[j] = hi[j] = np.nan
    return c, lo, hi


def ser6(c, lo, hi, levels=LEVELS6, asset="ETH"):
    s = M3.S3("syn", asset, "syn", c, lo, levels, M3.BASE_DEV, M3.BASE_DEV)
    M.attach_high(s, hi)
    return s


class TestFeatures(unittest.TestCase):
    def test_parkinson_and_null_rule(self):
        hi = np.array([2.0, 1.0, np.nan, 1.5, 0.9])
        lo = np.array([1.0, 1.0, 1.0, 1.0, 1.0])
        v = M.parkinson_v(hi, lo)
        self.assertAlmostEqual(v[0], math.log(2.0) ** 2 / (4 * math.log(2.0)))
        self.assertEqual(v[1], 0.0)
        self.assertTrue(np.isnan(v[2]) and np.isnan(v[4]))
        x = np.arange(60, dtype=float)
        x[30] = np.nan
        m = M.window_mean_null_rule(x, 24, 0)       # floor(0.05*24) = 1 null allowed
        self.assertTrue(np.all(np.isnan(m[:24])))
        self.assertAlmostEqual(m[24], np.mean(np.arange(24)))
        self.assertAlmostEqual(m[40], np.nanmean(x[16:40]))
        x[31] = np.nan                               # two nulls in the window -> undefined
        m = M.window_mean_null_rule(x, 24, 0)
        self.assertTrue(np.isnan(m[40]))
        self.assertTrue(np.isnan(M.window_mean_null_rule(np.ones(60), 24, 5)[28]))   # starts before the first close

    def test_sigma_fut_direct(self):
        c, _, _ = walk(3000, seed=3, nulls=(1500,))
        T = 24
        sf = M.sigma_fut(c, T, 0)
        for i in (100, 1490, 1480, 2900):
            r = [math.log(c[j] / c[j - 1]) for j in range(i, i + T) if np.isfinite(c[j]) and np.isfinite(c[j - 1])]
            nulls = T - len(r)
            if nulls <= 1:
                self.assertAlmostEqual(sf[i], math.sqrt(8760 * np.mean(np.square(r))), places=12)
            else:
                self.assertTrue(np.isnan(sf[i]))
        self.assertTrue(np.isnan(sf[3000 - T + 1]))   # window past the grid
        self.assertFalse(np.isnan(sf[3000 - T]))
        flat = np.ones(100)
        self.assertTrue(np.all(np.isnan(M.sigma_fut(flat, 6, 0))))   # zero realized vol -> undefined


class TestRegressions(unittest.TestCase):
    def setUp(self):
        c, lo, hi = walk(24 * 600, seed=7)
        self.s = ser6(c, lo, hi)
        self.T = 24
        self.qs = 24 * 560

    def test_w_recovers_known_slope_and_clips(self):
        s, T = self.s, self.T
        rng = np.random.default_rng(1)
        x = np.log(s.sigma) - np.log(s.sigma_ref)
        for w_true, want in ((0.6, 0.6), (1.1, 1.1), (1.6, 1.25), (-0.4, 0.0)):
            s._sfut = {T: np.exp(np.log(s.sigma_ref) + w_true * x + rng.normal(0, 0.002, len(x)))}
            P6 = M.Prep6(s, T, with_fbL=False)
            w, info = P6.fh_w(self.qs)
            self.assertAlmostEqual(w, want, delta=0.01)
            if 0 <= w_true <= 1.25:
                lim = self.qs - T
                ok = P6.okh[:lim + 1]
                xx, yy = x[:lim + 1][ok], (np.log(s._sfut[T]) - np.log(s.sigma_ref))[:lim + 1][ok]
                self.assertAlmostEqual(info["w_raw"], float(xx @ yy / (xx @ xx)), places=10)
        s._sfut = {}

    def test_har_ols_on_synthetic(self):
        s, T = self.s, self.T
        rng = np.random.default_rng(2)
        L = np.log(M.har_of(s))
        true = np.array([0.3, 0.5, 0.3, 0.1])
        lf = true[0] + L @ true[1:] + rng.normal(0, 0.01, len(L))
        s._sfut = {T: np.exp(lf)}
        P6 = M.Prep6(s, T, with_fbL=False)
        coef, info = P6.har_coef(self.qs)
        np.testing.assert_allclose(coef, true, atol=0.02)
        lim = self.qs - T
        ok = P6.okH[:lim + 1]
        X = np.column_stack([np.ones(ok.sum()), L[:lim + 1][ok]])
        ref = np.linalg.lstsq(X, lf[:lim + 1][ok], rcond=None)[0]
        np.testing.assert_allclose(coef, ref, rtol=1e-8, atol=1e-10)
        self.assertEqual(info["n_reg"], int(ok.sum()))
        s._sfut = {}


class TestBetaMap(unittest.TestCase):
    def test_identity_when_calibrated(self):
        rng = np.random.default_rng(4)
        n = 400000
        p = rng.uniform(0.002, 0.6, n)
        v = rng.normal(0, 0.4, n)
        y = (rng.random(n) < p).astype(float)
        th, info = M.fit_ridge_logistic(M.map_design(p[:, None], v[:, None]), y)
        self.assertTrue(info["converged"])
        np.testing.assert_allclose(th, M.IDENTITY, atol=0.06)
        th0, info0 = M.fit_ridge_logistic(np.zeros((0, 4)), np.zeros(0))
        np.testing.assert_array_equal(th0, M.IDENTITY)
        q = M.apply_map(M.IDENTITY, p[:5, None], v[:5])
        np.testing.assert_allclose(q[:, 0], p[:5], rtol=1e-12)

    def test_recovers_a_miscalibration_and_batch_equals_single(self):
        rng = np.random.default_rng(5)
        n = 20000
        p = rng.uniform(0.01, 0.5, n)
        v = rng.normal(0, 0.5, n)
        true = np.array([-0.3, 0.8, 1.2, 0.5])
        X = M.map_design(p[:, None], v[:, None])
        y = (rng.random(n) < 1 / (1 + np.exp(-(X @ true)))).astype(float)
        th, _ = M.fit_ridge_logistic(X, y)
        np.testing.assert_allclose(th, true, atol=0.25)
        W = rng.integers(0, 3, (3, n)).astype(float)
        Tb = M.fit_ridge_logistic_batch(X, y, W, np.tile(M.IDENTITY, (3, 1)))
        for r in range(3):
            ts, _ = M.fit_ridge_logistic(X, y, w=W[r])
            np.testing.assert_allclose(Tb[r], ts, atol=1e-7)


class TestCorpAndStats(unittest.TestCase):
    def test_corp_sums_to_brier(self):
        rng = np.random.default_rng(6)
        p = np.round(rng.beta(1, 8, 5000), 3)
        y = (rng.random(5000) < np.clip(p * 1.3, 0, 1)).astype(float)
        c = M.corp(p, y)
        self.assertAlmostEqual(c["MCB"] - c["DSC"] + c["UNC"], c["brier"], places=12)
        self.assertAlmostEqual(c["brier"], float(np.mean((p - y) ** 2)), places=12)
        self.assertGreaterEqual(c["MCB"], -1e-15)
        self.assertGreaterEqual(c["DSC"], -1e-15)
        from sklearn.isotonic import IsotonicRegression
        o = np.argsort(p, kind="mergesort")
        u, st, cnt = np.unique(p[o], return_index=True, return_counts=True)
        sy = np.add.reduceat(y[o], st)
        ours = M.pav(sy / cnt, cnt)
        ref = IsotonicRegression().fit(u, sy / cnt, sample_weight=cnt).predict(u)
        np.testing.assert_allclose(ours, ref, atol=1e-12)

    def test_dm_hln(self):
        rng = np.random.default_rng(7)
        d = rng.normal(0.0, 1.0, 4000)
        r = M.dm_test(d, 0)
        self.assertAlmostEqual(r["dm"], d.mean() / math.sqrt(np.var(d) / len(d)), places=10)
        self.assertGreater(r["p_value"], 0.01)
        r2 = M.dm_test(d - 0.2, 3)
        self.assertLess(r2["p_value"], 1e-6)
        n, h = 4000, 4
        self.assertAlmostEqual(r2["dm_hln"] / r2["dm"], math.sqrt((n + 1 - 2 * h + h * (h - 1) / n) / n), places=12)
        self.assertEqual(M.dm_lags(6), {"primary": 0, "literal": 5})
        self.assertEqual(M.dm_lags(720)["primary"], 119)

    def test_ppw_and_stationary_bootstrap(self):
        rng = np.random.default_rng(8)
        iid = rng.normal(size=3000)
        ar = np.zeros(3000)
        e = rng.normal(size=3000)
        for i in range(1, 3000):
            ar[i] = 0.9 * ar[i - 1] + e[i]
        b_iid, b_ar = M.ppw_block_length(iid), M.ppw_block_length(ar)
        self.assertLess(b_iid, 5)
        self.assertGreater(b_ar, 3 * b_iid)
        cnt = M.stationary_counts(np.random.default_rng(1), 500, 10.0, n_rep=50)
        np.testing.assert_array_equal(cnt.sum(axis=1), np.full(50, 500.0))

    def test_replay_counts_equal_sequential_draws(self):
        rng = np.random.default_rng(M.SEED_BAND)
        rng.integers(0, 10, 7)
        import copy
        state = copy.deepcopy(rng.bit_generator.state)
        nds = [400, 420, 450]
        want = [A.replicate_counts(A.block_bootstrap_indices(rng, nd, A.block_length(72), M.N_BAND_REP), nd)
                for nd in nds]
        got = list(M.replay_counts(state, nds, 72))
        for a_, b_ in zip(want, got):
            np.testing.assert_array_equal(a_, b_)


class TestRungsAndLookAhead(unittest.TestCase):
    T = 24
    qs = 24 * 560

    def build(self, cut=None, seed=11):
        c, lo, hi = walk(24 * 640, seed=seed, nulls=(9000,))
        if cut is not None:
            rng = np.random.default_rng(99)
            f = np.exp(rng.normal(0, 0.05, len(c) - cut))
            c, lo, hi = c.copy(), lo.copy(), hi.copy()
            c[cut:] *= f
            lo[cut:] *= f * 0.97
            hi[cut:] *= f * 1.04
        return ser6(c, lo, hi)

    def fit(self, s, te):
        P6 = M.Prep6(s, self.T)
        o = M.fold_predict6(s, P6, self.T, self.qs, te)
        return o, P6

    def test_no_look_ahead(self):
        te = np.array([self.qs, self.qs + 6, self.qs + 30])
        o0, _ = self.fit(self.build(), te)
        # post-Q_start data changed: every fitted quantity identical
        o1, _ = self.fit(self.build(cut=self.qs), te)
        self.assertEqual(o0["fit"]["w"], o1["fit"]["w"])
        np.testing.assert_array_equal(o0["fit"]["har"], o1["fit"]["har"])
        for bb in o0["fit"]["maps"]:
            np.testing.assert_array_equal(o0["fit"]["maps"][bb][0], o1["fit"]["maps"][bb][0])
        self.assertEqual({b: v[0] for b, v in o0["betas"].items()}, {b: v[0] for b, v in o1["betas"].items()})
        # the forecast at the first test origin (Q_start) uses nothing at or after it
        for r in M.CANDIDATES:
            np.testing.assert_array_equal(o0["raw"][r][0], o1["raw"][r][0])
        # post-origin data changed (after the last test origin): forecasts at every test origin identical
        o2, _ = self.fit(self.build(cut=int(te[-1])), te)
        for r in M.CANDIDATES:
            np.testing.assert_array_equal(o0["raw"][r], o2["raw"][r])
        self.assertTrue(o0["fit"]["maps"][0][1]["n_rows"] > 0)

    def test_fh_w1_is_f_and_fH_fallback(self):
        s = self.build()
        te = np.array([self.qs, self.qs + 6])
        P6 = M.Prep6(s, self.T)
        P6.fh_w = lambda qs: (1.0, {"n_reg": 1, "w_raw": 1.0, "rule": "test"})
        o = M.fold_predict6(s, P6, self.T, self.qs, te)
        np.testing.assert_array_equal(o["raw"]["fh"], o["raw"]["f"])
        P6 = M.Prep6(s, self.T)
        P6.okX = P6.okX.copy()
        P6.okX[te[1]] = False                         # an undefined component at the second test origin
        o = M.fold_predict6(s, P6, self.T, self.qs, te)
        np.testing.assert_array_equal(o["raw"]["fH"][1], o["raw"]["f"][1])
        self.assertEqual(o["fit"]["fH_fallback_rows"], 1)

    def test_identity_resample_reproduces_point_forecasts(self):
        s = self.build()
        te = np.array([self.qs, self.qs + 12])
        P6 = M.Prep6(s, self.T)
        o = M.fold_predict6(s, P6, self.T, self.qs, te)
        days, _, _ = M.M4.fold_days(s, P6.P.lab_ok, self.T, self.qs)
        cnt = np.ones((2, len(days)))
        for r in ("f", "fbL", "fh", "fH", "fHb"):
            smp = M.range_samples(s, P6, r, self.qs, te, cnt, s.sigma[te], s.sigma_ref[te], P6.X[te], P6.okX[te])
            np.testing.assert_allclose(smp[1], o["raw"][r], atol=1e-6, err_msg=r)

    def test_assemble_monotone_and_rows(self):
        s = self.build()
        folds = [{"name": "F1", "qs_i": self.qs, "qe_i": self.qs + 24 * 20}]
        per_T = {}
        for T_h in M.HORIZONS_H:
            P6 = M.Prep6(s, T_h)
            per_T[T_h] = M.fold_loop(s, P6, T_h, folds)
        R, tables, _ = M.assemble6(s, folds, per_T)
        self.assertEqual(len(tables["w"]), len(M.HORIZONS_H))
        for r in M.CANDIDATES:
            self.assertTrue(np.all(np.isfinite(R[f"p_{r}"])))
        red = M.reduce_series(R)
        self.assertIn("fHb_vs_f", red[24]["dm"])


class TestLiveRounds(unittest.TestCase):
    def test_hourly_from_rounds(self):
        base = 1_800_000_000 - 1_800_000_000 % 3600
        rounds = [{"roundId": 1, "answer": 100, "updatedAt": base - 10},
                  {"roundId": 2, "answer": 120, "updatedAt": base + 100},
                  {"roundId": 3, "answer": 90, "updatedAt": base + 3600},       # exactly at the first hour end
                  {"roundId": 4, "answer": 95, "updatedAt": base + 3600 + 50}]
        c, h, lo = M.hourly_from_rounds(rounds, np.array([base + 3600, base + 7200, base + 10800]), 0)
        np.testing.assert_array_equal(c, [90, 95, 95])
        np.testing.assert_array_equal(h, [120, 95, 95])     # hour 1: in force 100, prints 120, 90
        np.testing.assert_array_equal(lo, [90, 90, 95])     # hour 2: in force 90, print 95; hour 3: flat


class TestBlind5Gate(unittest.TestCase):
    def test_refuses_without_freeze_commit_sha_and_twice(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(SystemExit) as cm:
                M.run_blind5("/nonexistent", d, {}, "abc", workers=1, log=lambda *a: None, require_clean=False)
            self.assertIn("must exist", str(cm.exception))
            with open(os.path.join(d, "frozen-a6.json"), "w") as fh:
                fh.write("{}")
            sha = A.sha256_file(os.path.join(d, "frozen-a6.json"))
            with open(os.path.join(d, "frozen-a6.json.sha256"), "w") as fh:
                fh.write(f"{sha}  frozen-a6.json\n")
            with open(os.path.join(d, "results-dev.json"), "w") as fh:
                json.dump({"frozen_file": {"sha256": "0" * 64}}, fh)
            with self.assertRaises(SystemExit) as cm:
                M.run_blind5("/nonexistent", d, {}, None, workers=1, log=lambda *a: None, require_clean=False)
            self.assertIn("blind5-commit", str(cm.exception))
            with self.assertRaises(SystemExit) as cm:
                M.run_blind5("/nonexistent", d, {}, "abc", workers=1, log=lambda *a: None, require_clean=False)
            self.assertIn("sha256", str(cm.exception))
            with open(os.path.join(d, "blind5-run.started"), "w") as fh:
                fh.write("x")
            with self.assertRaises(SystemExit) as cm:
                M.run_blind5("/nonexistent", d, {}, "abc", workers=1, log=lambda *a: None, require_clean=False)
            self.assertIn("once", str(cm.exception))
            self.assertFalse(os.path.exists(os.path.join(d, "results-blind5.json")))

    def test_main_refuses_before_reading_inputs(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(SystemExit) as cm:
                M.main(["--datasets", "/nonexistent", "--out", d, "--phase", "blind5"])
            self.assertIn("must exist", str(cm.exception))


class TestTables(unittest.TestCase):
    def test_deep_median_and_verdict(self):
        def lv(Rf, Rn, n=20):
            return {repr(float(k)): {r: {"low": {"R": (Rf if r in ("a", "f", "fbL") else Rn), "n_ep": n},
                                         "mid": {"R": 1.0, "n_ep": n},
                                         "high": {"R": 1 / (Rf if r in ("a", "f", "fbL") else Rn), "n_ep": n}}
                                     for r in M.CANDIDATES} for k in M.LADDER}
        tab = M.deep_median_table({TL: lv(0.6, 0.9) for TL in M.T_LABEL.values()})
        self.assertEqual(tab["low+high"]["cells"], 6 * 4 * 2)
        self.assertLess(tab["low"]["median_abs_lnR"]["fH"], tab["low"]["median_abs_lnR"]["f"])
        pooled = {TL: {"levels": lv(0.6, 0.9), "comparisons": {"fH_vs_f": {"ci95": [-0.001, 0.002]}}}
                  for TL in M.T_LABEL.values()}
        self.assertEqual(M.method_verdict(pooled, "fH")["verdict"], "PASS")
        pooled["7d"]["comparisons"]["fH_vs_f"]["ci95"] = [-0.003, 0.001]
        self.assertEqual(M.method_verdict(pooled, "fH")["verdict"], "FAIL")

    def test_ship_choice_tie_order(self):
        r, info = M.ship_choice(["a", "f", "fH"], {("f", "a"): True}, {"a": 0, "f": 3, "fH": 3},
                                {"a": 0, "f": 1, "fH": 1}, {"a": 0, "f": .02, "fH": .02})
        self.assertEqual((r, info["removed_by_dominance"]), ("f", ["a"]))


if __name__ == "__main__":
    unittest.main()
