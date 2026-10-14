#!/usr/bin/env python3
"""Unit tests for a4_touch.py on synthetic data only (no dataset read, no score).

  python3 -m unittest scripts/research/history-forecasts/test_a4_touch.py -v
"""
import math
import os
import sys
import tempfile
import unittest
import warnings

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import a4_touch as M  # noqa: E402
import a3_touch as M3  # noqa: E402
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


def ser_of(c, lo, levels=(-0.02, -0.05, -0.10, -0.20), asset="ETH"):
    return M3.S3("syn", asset, "syn", c, lo, levels, M3.BASE_DEV, M3.BASE_DEV)


class TestBandsAndOdds(unittest.TestCase):
    def test_level_bands(self):
        self.assertEqual(M.band_of("ETH", A.LEVELS["ETH"]).tolist(), [0, 0, 0, 1, 1, 1, 2, 2, 2, 2])
        self.assertEqual(M.band_of("stETH", A.LEVELS["stETH"]).tolist(), [0, 0, 0, 0])

    def test_odds_multiplier(self):
        p = np.array([0.0, 0.2, 0.5, 1.0])
        q = M.odds_mult(p, 1.5)
        self.assertEqual(q[0], 0.0)
        self.assertEqual(q[3], 1.0)
        self.assertAlmostEqual(q[1] / (1 - q[1]), 1.5 * 0.25)
        np.testing.assert_allclose(M.odds_mult(p, 1.0), p)


class TestFc(unittest.TestCase):
    def setUp(self):
        n = 24 * 520
        c, lo = walk(n, seed=5, nulls=(7000,))
        self.s = ser_of(c, lo)
        self.T = 24
        self.P4 = M.Prep4(self.s, self.T)

    def test_theta_counts_as_of_rows_by_regime_and_band(self):
        s, P4, T = self.s, self.P4, self.T
        qs = 24 * 500
        th = P4.theta(qs)
        P = P4.P
        y = s.labels(T)
        lab = np.isfinite(y[:, 0])
        first = int(np.where(lab)[0][0])
        sc = math.sqrt(T / 8760)
        # brute force on regime 1, band 0 and the all-regime band 2
        O = {(1, 0): 0.0, (-9, 2): 0.0}
        E = {(1, 0): 0.0, (-9, 2): 0.0}
        cand = [t for t in range(first + 365 * 24, qs - T + 1) if lab[t] and np.isfinite(s.sigma[t])]
        for t in cand[::37]:
            src = [u for u in range(0, t - T + 1) if lab[u] and np.isfinite(s.sigma[u])]
            if not src:
                continue
            z = np.array([math.log(s.wmin(T)[u] / s.spot[u]) / (s.sigma[u] * sc) for u in src])
            p = np.array([np.mean(z <= math.log(1 + k) / (s.sigma[t] * sc)) for k in s.levels])
            self.assertTrue(P4.ev[t])
            np.testing.assert_allclose(P4.E_t[t], [p[P4.bands == b].sum() for b in range(P4.nb)], atol=1e-12)
            np.testing.assert_allclose(P4.O_t[t], [y[t][P4.bands == b].sum() for b in range(P4.nb)], atol=0)
        # theta definition
        for g in (0, 1, 2, -9):
            for b in range(P4.nb):
                self.assertAlmostEqual(th[g]["theta"][b], (th[g]["O"][b] + 20) / (th[g]["E"][b] + 20))
        # cumulative sums are over rows with t + T <= Q_start only
        lim = qs - T
        m = P4.ev & (np.arange(len(P4.ev)) <= lim) & (P4.reg == 1)
        self.assertAlmostEqual(th[1]["O"][0], float(P4.O_t[m, 0].sum()))
        self.assertFalse(P4.ev[first + 365 * 24 - 1])
        del P, O, E

    def test_fc_prediction_applies_row_regime_theta_per_band(self):
        s, P4, T = self.s, self.P4, self.T
        qs = 24 * 500
        te = np.array([qs, qs + 6, qs + 12])
        o = M.predict4(s, P4, T, qs, te)
        th = P4.theta(qs)
        for r, t0 in enumerate(te):
            g = int(s.regime[t0])
            gk = g if g in (0, 1, 2) else -9
            for j in range(P4.K):
                want = M.odds_mult(o["raw"]["f"][r, j], th[gk]["theta"][P4.bands[j]])
                self.assertAlmostEqual(o["raw"]["fc"][r, j], want, places=14)
        o2 = M.predict4(s, P4, T, qs, te, te_regime=[-1, -1, -1])
        np.testing.assert_allclose(o2["raw"]["fc"][0], M.odds_mult(o["raw"]["f"][0],
                                                                   np.asarray(th[-9]["theta"])[P4.bands]))


class TestBandSamples(unittest.TestCase):
    def test_identity_resample_reproduces_point_forecasts(self):
        n = 24 * 520
        c, lo = walk(n, seed=6)
        s = ser_of(c, lo)
        T = 24
        P4 = M.Prep4(s, T)
        qs = 24 * 500
        te = np.array([qs, qs + 6])
        days, pos, tr = M.fold_days(s, P4.P.lab_ok, T, qs)
        ones = np.ones((3, len(days)))
        o = M.predict4(s, P4, T, qs, te)
        for rung, fc in (("f", False), ("fc", True)):
            smp = M.band_samples_f(s, P4, qs, te, ones, fc=fc)
            for b in range(3):
                np.testing.assert_allclose(smp[b], o["raw"][rung], atol=1e-12)
        sa = M.band_samples_a(s, P4.P, qs, len(te), ones)
        np.testing.assert_allclose(sa[0], o["raw"]["a"], atol=1e-12)

    def test_weighted_resample_equals_manual_weighting(self):
        n = 24 * 520
        c, lo = walk(n, seed=7)
        s = ser_of(c, lo)
        T = 6
        P4 = M.Prep4(s, T)
        qs = 24 * 500
        te = np.array([qs])
        days, pos, tr = M.fold_days(s, P4.P.lab_ok, T, qs)
        rng = np.random.default_rng(1)
        idx = A.block_bootstrap_indices(rng, len(days), A.block_length(T), 4)
        cnt = A.replicate_counts(idx, len(days))
        smp = M.band_samples_f(s, P4, qs, te, cnt)
        P = P4.P
        i = np.arange(len(P.lab_ok))
        trf = P.valid[1.0] & (i <= qs - T)
        w = cnt[2][pos[trf]]
        z = P.z[1.0][trf]
        thr = P.thresholds(s.sigma[te])[0]
        for j in range(P4.K):
            self.assertAlmostEqual(smp[2, 0, j], float(np.sum(w * (z <= thr[j])) / np.sum(w)), places=12)
        sa = M.band_samples_a(s, P, qs, 1, cnt)
        wa = cnt[1][pos[tr]]
        np.testing.assert_allclose(sa[1, 0], (wa[:, None] * P.Y[tr]).sum(0) / wa.sum(), atol=1e-12)


class TestChecksBasisShipping(unittest.TestCase):
    def test_label_after_checks(self):
        ok, few, bad = {"R": 1.1, "n_ep": 30}, {"R": 1.0, "n_ep": 9}, {"R": 0.6, "n_ep": 24}
        L = M.label_after_checks
        self.assertEqual(L("ETH", "HIGH", ok, ok, True), ("HIGH", "passed checks"))
        self.assertEqual(L("ETH", "HIGH", bad, ok, True), ("MEDIUM", "failed asset-matched"))
        self.assertEqual(L("ETH", "HIGH", few, ok, True), ("MEDIUM", "unconfirmed asset-matched"))
        self.assertEqual(L("BTC", "HIGH", ok, bad, True), ("MEDIUM", "failed generic"))
        self.assertEqual(L("BTC", "HIGH", few, bad, True), ("MEDIUM", "failed generic"))
        self.assertEqual(L("stETH", "HIGH", None, ok, True), ("HIGH", "passed checks"))
        self.assertEqual(L("stETH", "HIGH", None, ok, False), ("MEDIUM", "unconfirmed (level not on the holdout ladder)"))
        self.assertEqual(L("ETH", "LOW", bad, bad, True), ("LOW", "not HIGH"))

    def test_basis_string(self):
        s, det, k, n = M.basis({"n_ep": 24}, "HIGH", [("asset-matched", "not held"), ("generic", "held")])
        self.assertEqual(s, "held in 2 of 3 checks")
        s, det, k, n = M.basis({"n_ep": 5}, "insufficient", [("generic", "held")])
        self.assertEqual(s, "held in 1 of 1 checks")
        s, _, _, _ = M.basis({"n_ep": 40}, "STALE", [("asset-matched", "n/a"), ("generic", "n/a")])
        self.assertEqual(s, "held in 0 of 1 checks")
        self.assertEqual(M.check_state({"R": 1.6, "n_ep": 10}), "not held")
        self.assertEqual(M.check_state({"R": 1.0, "n_ep": 9}), "n/a")
        self.assertEqual(M.check_state(None), "n/a")

    def test_ship_choice_tie_order_and_dominance(self):
        S = M.ship_choice
        nh, nm = {"a": 9, "f": 5, "fc": 5}, {"a": 0, "f": 2, "fc": 2}
        r, info = S(["a", "f", "fc"], {("f", "a"): True, ("fc", "a"): True}, nh, nm,
                    {"a": 0.0, "f": 0.05, "fc": 0.05})
        self.assertEqual((r, info["removed_by_dominance"]), ("f", ["a"]))
        r, _ = S(["a", "f", "fc"], {("f", "a"): True, ("fc", "a"): True, ("fc", "f"): True}, nh, nm,
                 {"a": 0.0, "f": 0.05, "fc": 0.06})
        self.assertEqual(r, "fc")
        r, _ = S(["a"], {}, nh, nm, {"a": 0.0})
        self.assertEqual(r, "a")

    def test_pools(self):
        self.assertEqual(len(M.GENERIC), 18)
        self.assertEqual(M.ASSET_MATCHED["ETH"], ("bspan:ETH", "locked:coinbase-eth-usd"))
        self.assertEqual(len(M.ASSET_MATCHED["BTC"]), 3)
        self.assertNotIn("long:ETH", M.ASSET_MATCHED["ETH"])


class TestBlind3Gate(unittest.TestCase):
    def test_refuses_without_freeze_commit_and_twice(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(SystemExit):
                M.run_blind3("/nonexistent", d, {}, "abc", workers=1, log=lambda *a: None)
            open(os.path.join(d, "blind3-run.started"), "w").write("x")
            with self.assertRaises(SystemExit) as cm:
                M.run_blind3("/nonexistent", d, {}, "abc", workers=1, log=lambda *a: None)
            self.assertIn("once", str(cm.exception))

    def test_refuses_without_commit(self):
        with tempfile.TemporaryDirectory() as d:
            for f in ("frozen-a4.json", "results-dev.json"):
                open(os.path.join(d, f), "w").write("{}")
            with self.assertRaises(SystemExit) as cm:
                M.run_blind3("/nonexistent", d, {}, None, workers=1, log=lambda *a: None)
            self.assertIn("blind3-commit", str(cm.exception))
            self.assertFalse(os.path.exists(os.path.join(d, "blind3-run.started")))


if __name__ == "__main__":
    unittest.main()
