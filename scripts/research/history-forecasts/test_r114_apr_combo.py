#!/usr/bin/env python3
"""Unit tests for r114_apr_combo.py on synthetic data only (no dataset read, no score).

  python3 -m unittest scripts/research/history-forecasts/test_r114_apr_combo.py -v
"""
import os
import sys
import unittest

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import r114_apr_combo as M  # noqa: E402


def synth(n=300, seed=3):
    rng = np.random.default_rng(seed)
    y = 0.05 + np.cumsum(rng.normal(0, 0.002, n))
    z = np.array([-1.645, -0.674, 0.0, 0.674, 1.645])
    good = y[:, None] + rng.normal(0, 0.001, (n, 1)) + 0.003 * z[None, :]
    bad = y[:, None] + 0.01 + 0.003 * z[None, :]
    return pd.date_range("2024-07-01", periods=n, freq="D", tz="UTC"), good, bad, y


class T(unittest.TestCase):
    def test_pinball(self):
        self.assertAlmostEqual(float(M.pin_tau(0.0, 1.0, 0.05)), 0.05)
        self.assertAlmostEqual(float(M.pin_tau(1.0, 0.0, 0.05)), 0.95)

    def test_m2_early_equal_and_learns(self):
        d, good, bad, y = synth()
        q, eta, wa, cross = M.m2_walk_forward(d, good, bad, y)
        # nothing resolved before day 7 + 30 -> equal weights
        self.assertTrue(np.allclose(wa[:37], 0.5))
        self.assertTrue((eta[:37] == 0).all())
        # later the good component dominates
        self.assertGreater(wa[-50:].mean(), 0.75)
        self.assertTrue((np.diff(q, axis=1) >= 0).all())

    def test_m2_no_lookahead(self):
        d, good, bad, y = synth()
        q1, *_ = M.m2_walk_forward(d, good, bad, y)
        y2 = y.copy()
        y2[200:] += 5.0   # perturb outcomes resolving after origin 207
        q2, *_ = M.m2_walk_forward(d, good, bad, y2)
        self.assertTrue(np.allclose(q1[:207], q2[:207]))

    def test_dm(self):
        rng = np.random.default_rng(1)
        r = M.dm_one_sided(rng.normal(-0.5, 1, 500))
        self.assertLess(r["p_one_sided"], 0.01)
        r = M.dm_one_sided(rng.normal(0.5, 1, 500))
        self.assertGreater(r["p_one_sided"], 0.99)

    def test_empirical(self):
        idx = pd.date_range("2023-01-01", periods=1000, freq="D", tz="UTC")
        st = pd.DataFrame({"apr": 0.05 + 0.0001 * np.arange(1000)}, index=idx)
        q, n = M.empirical_quantiles(st, idx[900])
        self.assertEqual(n, 730)
        self.assertTrue(np.allclose(q, st["apr"].iloc[900] + 0.0007))
        q, n = M.empirical_quantiles(st, idx[200])
        self.assertIsNone(q)


if __name__ == "__main__":
    unittest.main()
