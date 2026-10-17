#!/usr/bin/env python3
"""Tests for the Q26 R8.1 go-live gate simulator (r8_gate.py).

  python3 -m unittest scripts/research/history-forecasts/test_r8_gate.py -v
"""
import math
import os
import sys
import unittest

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import r8_gate as G  # noqa: E402


def calib_z(d):
    s = d.sum(1)
    return s.mean() / (s.std(ddof=1) / math.sqrt(len(s)))


class TestSimulators(unittest.TestCase):
    def test_deposit_calibrated_and_shapes(self):
        rng = np.random.default_rng(11)
        for H, N, K, pw, reg, como in ((1, 10, 1, 0.25, False, False), (2, 10, 25, 0.05, True, False),
                                       (7, 10, 25, 0.25, True, True)):
            d, E = G.dep_point_runs(H, N, K, pw, reg, como, 600, rng, batch=250)
            self.assertEqual(d.shape, (600, N * H))
            self.assertEqual(E.shape, (600,))
            self.assertLess(abs(calib_z(d)), 4.0)
            if not reg:
                self.assertTrue(np.allclose(E, E[0]))                  # constant hazard: E is deterministic

    def test_deposit_comonotone_nested(self):
        rng = np.random.default_rng(12)
        d, E = G.dep_point_runs(1, 10, 25, 0.25, False, True, 50, rng)
        # with one uniform per day, the daily outcome count takes at most K + 1 values and orders by hazard
        p = 0.25 * np.geomspace(0.25, 4.0, 25) / np.geomspace(0.25, 4.0, 25).mean()
        O = d + np.minimum(0.95, p).sum()
        self.assertTrue(np.allclose(O, np.round(O)))

    def test_touch_calibrated(self):
        rng = np.random.default_rng(13)
        for T, N in ((24, 10), (168, 3)):
            u = G.touch_point_runs(T, N, 0.008, 300, rng)
            self.assertEqual(set(u), set(G.TOUCH_SINGLE) | {"pooled"})
            for k in (-0.02, -0.05, "pooled"):
                d, E = u[k]
                self.assertEqual(d.shape, (300, N * math.ceil(T / 24)))
                self.assertLess(abs(calib_z(d)), 4.0)

    def test_touch_bridge_minimum_below_endpoints(self):
        rng = np.random.default_rng(14)
        dx = rng.normal(0, 0.01, 10000)
        U = rng.random(10000)
        m = 0.5 * (dx - np.sqrt(dx * dx - 2e-4 * np.log(U)))
        self.assertTrue(np.all(m <= np.minimum(0, dx) + 1e-15))


class TestRatesAndVerdict(unittest.TestCase):
    def test_rates_counts_only_shown(self):
        d = np.array([[1.0, 1.0, 1.0, 1.0, 1.0], [1.0, 1.0, 1.0, 1.0, 1.0]])   # z = 2.24 in both runs
        E = np.array([10.0, 4.99])                                       # the second run shows no light
        r = G.rates(d, E, 24)
        self.assertEqual((r["runs"], r["shown"], r["hit2"], r["hit3"]), (2, 1, 1, 0))

    def test_rates_z(self):
        d = np.array([[3.0, 3.0, 0.0, 0.0]])
        r = G.rates(d, np.array([10.0]), 24)                             # lag 0: z = 6 / sqrt(18) = 1.41
        self.assertEqual(r["hit2"], 0)
        r = G.rates(d, np.array([10.0]), 48)                             # lag 1 HH: var 18 + 2 * 9 = 36 -> z 1
        self.assertEqual(r["hit2"], 0)
        d = np.array([[3.0, 0.0, 0.0, 0.0]])
        self.assertEqual(G.rates(d, np.array([10.0]), 24)["hit2"], 0)   # z = 1
        d = np.array([[1.0, 1.0, 1.0, 1.0, 1.0]])
        self.assertEqual(G.rates(d, np.array([10.0]), 24)["hit2"], 1)   # z = 5 / sqrt(5) = 2.24

    def test_verdict(self):
        res = {"deposit": {"24h": {"10": {"rate2": 0.05}, "30": {"rate2": 0.03}, "90": {"rate2": 0.2}}},
               "touch": {"720h": {"10": {"rate2": 0.07}, "30": {"rate2": 0.069}}}}
        self.assertTrue(G.verdict(res)["pass"])                           # N = 90 decides nothing; edges inclusive
        res["touch"]["720h"]["10"]["rate2"] = 0.0701
        g = G.verdict(res)
        self.assertFalse(g["pass"])
        self.assertEqual([r["inBand"] for r in g["rows"]], [True, True, False, True])

    def test_run_smoke(self):
        res = G.run(30, log=lambda *a: None, windows=(10,), dep_h=(48,), touch_h=(72,))
        self.assertIn("48h", res["deposit"])
        self.assertIn("72h", res["touch"])
        r = res["deposit"]["48h"]["10"]
        self.assertEqual(r["lag"], 1)
        self.assertEqual(r["issueDays"], 20)
        self.assertEqual(len(r["designPoints"]), 12)
        self.assertEqual(len(res["touch"]["72h"]["10"]["designPoints"]), 10)


if __name__ == "__main__":
    unittest.main()
