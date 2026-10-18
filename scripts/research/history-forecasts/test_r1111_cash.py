#!/usr/bin/env python3
"""Synthetic tests for r1111_cash.py (no real data, no outcome)."""
import os
import sys
import unittest

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import r1111_cash as M  # noqa: E402
import r104_cash as R4  # noqa: E402
import r104b_c2 as RB  # noqa: E402

DAY = 86400


class TestActivity(unittest.TestCase):
    def test_w(self):
        d = np.array([10 * DAY], dtype=np.int64)
        self.assertEqual(M.activity_w(np.array([], dtype=np.int64), 20 * DAY), 0.0)
        self.assertEqual(M.activity_w(d, 10 * DAY + 3 * DAY), 1.0)
        self.assertAlmostEqual(M.activity_w(d, 10 * DAY + 14 * DAY), 0.5)
        self.assertAlmostEqual(M.activity_w(d, 10 * DAY + 21 * DAY), 0.25)
        # live rule: a round trip completing within 60 min after t0 counts, later does not
        self.assertEqual(M.activity_w(d, 10 * DAY - 1800), 1.0)
        self.assertEqual(M.activity_w(d, 10 * DAY - 7200), 0.0)


class TestDipSplit(unittest.TestCase):
    def test_sum(self):
        CX = np.array([100., 110., 90.])
        SX = np.array([200., 210., 190.])
        dmin = np.array([50., 80., np.nan])
        exm = np.array([95., 85., np.nan])
        b, r = M.dip_split(CX, SX, dmin, exm)
        tot = np.maximum(0, np.minimum(CX[:-1], CX[1:]) - dmin[:-1]) / SX[:-1]
        np.testing.assert_allclose(b + r, tot)
        self.assertTrue((r >= 0).all() and (b >= 0).all())
        self.assertAlmostEqual(b[0], 5 / 200)


class TestExPath(unittest.TestCase):
    def test_outstanding_added(self):
        cts = np.array([100, 200, 300, 400], dtype=np.int64)
        cval = np.array([1000, 400, 1000, 1000], dtype=np.int64)        # withdraw 600 at 200, redeposit at 300
        legs = pd.DataFrame({"qrt_id": ["q1", "q1"], "leg": ["withdraw", "redeposit"], "ts": [200, 300],
                             "neutral_raw": [600, 600]})
        legs = legs.assign(block=legs["ts"])
        ex = M.ex_path(cts, cval, legs, [])
        np.testing.assert_allclose(ex, [1000, 1000, 1000, 1000])
        ex2 = M.ex_path(cts, cval, legs, [], visible_by=np.array([0, 0, 0, 0]))
        np.testing.assert_allclose(ex2, cval)
        self.assertEqual(M.rt_done_times(legs, []).tolist(), [300])


class TestM2EqualsM0(unittest.TestCase):
    def test_w1(self):
        rng = np.random.default_rng(0)
        n = 400
        t = np.arange(n, dtype=np.int64) * DAY + 10 * DAY
        S = 1e9 * np.exp(np.cumsum(rng.normal(0, 0.02, n)))
        C = S * (0.2 + 0.05 * rng.random(n))
        dmin = C * (0.9 + 0.05 * rng.random(n))
        Q = np.where(rng.random(n) < 0.1, 1e7, 0.0)
        R = np.zeros(n)
        F = R4.make_flows(S, C, dmin, Q, R)
        Fl = R4.make_flows(S, C, dmin, Q * 0.5, R)
        cash_t0 = C.copy()
        P = {"S_snap": S, "C_end": C, "dmin": dmin, "Q_full": Q, "Q_live": Q * 0.5, "R_full": R, "R_live": R,
             "t": t, "cash_t0": cash_t0, "exmin_full": np.minimum(dmin + 1e6, C + Q),
             "exmin_live": np.minimum(dmin + 2e6, C + Q), "done_ts": np.array([], dtype=np.int64)}
        idx = np.arange(300, 320)
        m0, m1, full, live = M.run_m0_m1(P, idx)
        m2 = M.run_m2(P, idx, full, live, w_override=1.0)
        for k in idx:
            np.testing.assert_allclose(m2[k]["q1"], m0[k]["q1"], rtol=1e-12)
        m2w0 = M.run_m2(P, idx, full, live)            # no round trip ever: w = 0
        self.assertEqual(m2w0[int(idx[0])]["w"], 0.0)


class TestSelect(unittest.TestCase):
    def test_margin(self):
        self.assertEqual(M.select(0.05, 0.059), "M1")
        self.assertEqual(M.select(0.05, 0.060), "M2")
        self.assertEqual(M.select(0.05, 0.02), "M1")


class TestC1(unittest.TestCase):
    def synth(self):
        rng = np.random.default_rng(1)
        n = 420
        t = np.arange(n, dtype=np.int64) * DAY + 19000 * DAY
        S = 1e9 * np.exp(np.cumsum(rng.normal(0, 0.02, n)))
        C = S * (0.2 + 0.05 * rng.random(n))
        dmin = C * (0.9 + 0.05 * rng.random(n))
        P = {"origins": [str(x) for x in range(n)], "t": t, "S_snap": S, "C_end": C, "cash_t0": C.copy(),
             "dmin": dmin, "Q_full": np.zeros(n), "Q_live": np.zeros(n), "R_full": np.zeros(n), "R_live": np.zeros(n),
             "score": np.arange(300, 400), "q2": np.arange(400, n - 1)}
        P["origins"] = [f"2025-{1 + (i % 12):02d}-01" for i in range(n)]
        return P

    def test_m1_equals_dev_m1(self):
        P = self.synth()
        idx = np.arange(300, 310)
        _, m1, _, _ = M.run_m0_m1(P, idx)
        f = M.forecast_m1(P, idx)
        for k in idx:
            np.testing.assert_array_equal(f[k]["q1"], m1[k]["q1"])

    def test_score_runs(self):
        P = self.synth()
        fc = M.forecast_m1(P, np.concatenate([P["score"], P["q2"]]))
        res, rows = M.c1_score(P, fc)
        self.assertEqual(res["n_scoring"], 100)
        self.assertIn("R_model", res["per_quantile"]["0.05"])
        self.assertEqual(len(rows), 100)

    def test_cash_path_exact(self):
        tin = pd.DataFrame({"block": [5, 5, 7], "ts": [50, 50, 70], "tx_index": [2, 2, 0],
                            "amount_raw": ["7", "3", "100"]})
        tout = pd.DataFrame({"block": [5], "ts": [50], "tx_index": [2], "amount_raw": ["4"]})
        tl = M.cash_path_exact(tin, tout)
        self.assertEqual(tl["cash"].tolist(), [6, 106])
        self.assertEqual(tl["ts"].tolist(), [50, 70])


if __name__ == "__main__":
    unittest.main()
