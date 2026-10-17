#!/usr/bin/env python3
"""Synthetic tests for Q26 R9.1(d)1 L1c (l1c_pool_risk.py).

  python3 -m unittest scripts/research/history-forecasts/test_l1c_pool_risk.py -v
"""
import os
import sys
import unittest

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import l1c_pool_risk as C  # noqa: E402


class T(unittest.TestCase):
    def test_step_integral(self):
        I = C.step_integral([10, 20], [2.0, 5.0], [0, 10, 15, 20, 30])
        np.testing.assert_allclose(I, [0, 0, 10, 20, 70])

    def test_tw_mean_step(self):
        # state 1 from 0, 3 from 50; window (40, 60] -> (10*1 + 10*3)/20 = 2
        self.assertAlmostEqual(C.tw_mean_step(np.array([0, 50]), np.array([1.0, 3.0]), 40, 60), 2.0)

    def test_qrt_adjust(self):
        # +100 at 10, -60 at 30, -40 at 40; window (0, 100]: (20*100 + 10*40)/100 = 24
        self.assertAlmostEqual(C.qrt_window_adjust([(10, 100.0), (30, -60.0), (40, -40.0)], 0, 100), 24.0)
        # burn before the window: outstanding at a counts
        self.assertAlmostEqual(C.qrt_window_adjust([(-10, 100.0), (20, -100.0)], 0, 100), 20.0)

    def test_pass_rule(self):
        self.assertTrue(C.pass_rule([0.01, 0.3], 1.0))
        self.assertFalse(C.pass_rule([0.0, 0.3], 1.0))
        self.assertFalse(C.pass_rule([0.01, 0.3], 2.1))
        self.assertFalse(C.pass_rule([0.01, 0.3], None))
        self.assertFalse(C.pass_rule(None, 1.0))

    def test_budget(self):
        self.assertFalse(C.budget_flag(0.10, 0.11, 1.0, 1.1)["flag"])
        self.assertTrue(C.budget_flag(0.10, 0.13, 1.0, 1.0)["flag"])
        self.assertTrue(C.budget_flag(0.10, 0.10, 1.0, 1.3)["flag"])
        self.assertEqual(C.budget_flag(None, 0.1, 1.0, 1.0)["reason"], "not computable")
        self.assertTrue(C.budget_flag(0.1, 0.1, 0.0, 1.0)["flag"])

    def test_open_boot_restricts(self):
        n = 90
        pr = pd.DataFrame({"p": np.full(n, 0.1), "p_base": np.full(n, 0.2), "y": np.zeros(n),
                           "open6": np.r_[np.ones(60), np.zeros(30)].astype(int)})
        pr.loc[5, "y"] = 1
        b = C.open_boot(pr, B=50)
        self.assertIsNotNone(b["bssCI"])

    def test_holder_features_qrt(self):
        d = 86400
        t0s = np.array([2 * d, 3 * d])
        per = {"a": (np.array([0], np.int64), np.array([100e6])), "b": (np.array([0], np.int64), np.array([50e6]))}
        rdu = pd.DataFrame({"ts": [0], "vb": [0.0], "lr": [0.0], "li": [1.0]})
        # unit b withdraws 50 at 3d - 3600 and redeposits at 3d + 600: counts for t0 = 3d (done <= t0 + 60 min)
        per["b"] = (np.array([0, 3 * d - 3600, 3 * d + 600], np.int64), np.array([50e6, 0.0, 50e6]))
        q = [("b", 3 * d - 3600, 3 * d + 600, [(3 * d - 3600, 50e6), (3 * d + 600, -50e6)])]
        H = C.holder_features(per, rdu, t0s, q)
        self.assertAlmostEqual(H["top10x_w24"].iloc[1], 150.0, places=6)
        self.assertLess(H["top10_w24_raw"].iloc[1], 150.0)
        self.assertEqual(int(H["n_qrt_holder"].iloc[1]), 1)
        self.assertAlmostEqual(H["top10_point"].iloc[1], 100.0)


if __name__ == "__main__":
    unittest.main()
