#!/usr/bin/env python3
"""Synthetic tests for r104_cash.py (Q26 R10.4): window minima, round-trip outstanding amounts and look-ahead,
debt-side round-trip detection, HAR standardization, path minima, funding window, pinball and bootstrap."""
import os
import sys
import unittest

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import r104_cash as r  # noqa: E402

M = r.MICRO


class TestHelpers(unittest.TestCase):
    def test_window_min_includes_value_after_start(self):
        ts = np.array([10, 20, 30, 40])
        v = np.array([100, 50, 80, 30])
        self.assertEqual(r.window_min(ts, v, 100, 10, 35), 50)   # states at 20, 30; start value 100
        self.assertEqual(r.window_min(ts, v, 80, 30, 35), 80)    # no state in (30, 35]
        self.assertEqual(r.window_min(ts, v, 80, 30, 40), 30)

    def test_state_at(self):
        ts = np.array([10, 20])
        v = np.array([5, 7])
        self.assertEqual(r.state_at(ts, v, 9), 0)
        self.assertEqual(r.state_at(ts, v, 20), 7)

    def test_tw_mean(self):
        ts = np.array([0, 50])
        v = np.array([1.0, 3.0])
        self.assertAlmostEqual(r.tw_mean_step(ts, v, 0.0, 100.0), 2.0)
        self.assertTrue(np.isnan(r.tw_mean_step(ts, v, -10.0, 100.0)))

    def test_pinball(self):
        self.assertAlmostEqual(float(r.pinball(10.0, 8.0, 0.05)), 0.1)
        self.assertAlmostEqual(float(r.pinball(8.0, 10.0, 0.05)), 1.9)


class TestRoundTrips(unittest.TestCase):
    def legs(self):
        return pd.DataFrame([
            {"qrt_id": "q1", "leg": "withdraw", "block": 100, "ts": 1000, "neutral_raw": str(50 * M)},
            {"qrt_id": "q1", "leg": "redeposit", "block": 110, "ts": 1500, "neutral_raw": str(20 * M)},
            {"qrt_id": "q1", "leg": "redeposit", "block": 120, "ts": 5000, "neutral_raw": str(30 * M)},
        ])

    def test_qrt_outstanding(self):
        anchors = np.array([99, 100, 105, 110, 119, 120, 130])
        out = r.qrt_outstanding(self.legs(), anchors)
        self.assertEqual([int(x) for x in out], [0, 50 * M, 50 * M, 30 * M, 30 * M, 0, 0])

    def test_qrt_lookahead(self):
        anchors = np.array([105, 115])
        vis = np.array([4999, 5000])
        out = r.qrt_outstanding(self.legs(), anchors, visible_by=vis)
        self.assertEqual([int(x) for x in out], [0, 30 * M])

    def test_detect_drt(self):
        b = pd.DataFrame([
            {"block": 100, "log_index": 1, "ts": 1000, "unit": "A", "amount": 100 * M * 1_000_000 // 1_000_000 * 1},
        ])
        b.loc[0, "amount"] = 100_000_000 * M
        b = pd.concat([b, pd.DataFrame([{"block": 200, "log_index": 1, "ts": 2000, "unit": "B",
                                          "amount": 10_000_000 * M}])], ignore_index=True)   # too small
        rp = pd.DataFrame([
            {"block": 101, "log_index": 0, "ts": 1100, "unit": "A", "amount": 40_000_000 * M},
            {"block": 102, "log_index": 0, "ts": 1200, "unit": "C", "amount": 90_000_000 * M},   # other unit
            {"block": 103, "log_index": 0, "ts": 8000, "unit": "A", "amount": 60_000_000 * M},   # 2 h + 1000 s: ok
            {"block": 201, "log_index": 0, "ts": 2100, "unit": "B", "amount": 10_000_000 * M},
        ])
        d = r.detect_drt(b, rp)
        self.assertEqual(len(d), 1)
        self.assertEqual(d[0]["done_block"], 103)
        self.assertEqual(d[0]["neutral"], 100_000_000 * M)
        out = r.drt_outstanding(d, np.array([100, 101, 102, 103]))
        self.assertEqual([int(x) for x in out], [100_000_000 * M, 60_000_000 * M, 60_000_000 * M, 0])
        out = r.drt_outstanding(d, np.array([101]), visible_by=np.array([7999]))
        self.assertEqual(int(out[0]), 0)
        out = r.drt_outstanding(d, np.array([999, 1000, 1150, 7999, 8000]), key="ts")
        self.assertEqual([int(x) for x in out], [0, 100_000_000 * M, 60_000_000 * M, 60_000_000 * M, 0])

    def test_drt_window_and_fill(self):
        b = pd.DataFrame([{"block": 100, "log_index": 1, "ts": 1000, "unit": "A", "amount": 100_000_000 * M}])
        rp = pd.DataFrame([{"block": 101, "log_index": 0, "ts": 1000 + 7201, "unit": "A",
                            "amount": 100_000_000 * M}])
        self.assertEqual(r.detect_drt(b, rp), [])
        rp = pd.DataFrame([{"block": 101, "log_index": 0, "ts": 1100, "unit": "A", "amount": 94_000_000 * M}])
        self.assertEqual(r.detect_drt(b, rp), [])
        rp = pd.DataFrame([{"block": 100, "log_index": 0, "ts": 1000, "unit": "A", "amount": 100_000_000 * M}])
        self.assertEqual(r.detect_drt(b, rp), [])     # repay before the borrow in the same block


class TestModel(unittest.TestCase):
    def test_har_recovers_scale(self):
        rng = np.random.default_rng(1)
        sig = np.where(np.arange(800) < 400, 0.01, 0.04)
        x = rng.standard_normal(800) * sig
        c, s, n = r.har_fit(x, 30, 799)
        self.assertIsNotNone(c)
        z = x / s[:800]
        self.assertLess(abs(np.std(z[100:390]) / np.std(z[450:790]) - 1), 0.35)

    def test_path_minima_deterministic(self):
        zS = np.zeros((2, 2))
        zD = np.zeros((2, 2))
        dip = np.array([[0.0, 0.0], [0.1, 0.0]])
        pm = r.path_minima(100.0, 60.0, zS, zD, dip, 0.01, 0.01, 1e9, 2)
        self.assertAlmostEqual(pm[0], 40.0)
        self.assertAlmostEqual(pm[1], 30.0)
        pm = r.path_minima(100.0, 60.0, zS, zD, dip, 0.01, 0.01, 35.0, 2)
        self.assertAlmostEqual(pm[0], 35.0)

    def test_path_debt_growth(self):
        zS = np.zeros((1, 1))
        zD = np.ones((1, 1))
        pm = r.path_minima(100.0, 50.0, zS, zD, np.zeros((1, 1)), 0.0, np.log(1.2), 1e9, 1)
        self.assertAlmostEqual(pm[0], 40.0)

    def test_forecast_origin_and_shift(self):
        rng = np.random.default_rng(2)
        n = 500
        xS = np.append(rng.standard_normal(n) * 0.01, np.nan)
        sp = np.append(rng.standard_normal(n), 2.0)
        xD = np.append(0.01 * (rng.standard_normal(n) * 0.5 + 0.8 * sp[:n]), np.nan)
        dip = np.append(np.zeros(n), np.nan)
        fo = r.forecast_origin(n, 7, xS, xD, dip, 1e9, 6e8, 1e12, spread=sp)
        self.assertIsNotNone(fo)
        self.assertGreater(fo["beta"], 0.5)
        self.assertTrue((fo["q2"] <= fo["q1"] + 1e-6).all())     # positive spread -> more debt -> less cash
        self.assertTrue(np.all(np.diff(fo["q1"]) >= 0))
        sp2 = sp.copy()
        sp2[n] = np.nan
        fo2 = r.forecast_origin(n, 7, xS, xD, dip, 1e9, 6e8, 1e12, spread=sp2)
        self.assertIsNone(fo2["beta"])
        self.assertTrue(np.allclose(fo2["q2"], fo2["q1"]))

    def test_funding_window(self):
        t = np.arange(0, 30 * 86400, 8 * 3600)
        rate = np.full(len(t), 0.0001)
        ih = np.full(len(t), 8)
        v = r.funding_7d(t, rate, ih, 10 * 86400)
        self.assertAlmostEqual(v, 21 * 0.0001 * 365 / 7)
        self.assertTrue(np.isnan(r.funding_7d(t, rate, ih, 3 * 86400)))
        self.assertTrue(np.isnan(r.funding_7d(t, rate, ih, 31 * 86400)))

    def test_boot_ci(self):
        rng = np.random.default_rng(0)
        la = np.ones(200) * 0.8
        lb = np.ones(200)
        lo, hi = r.boot_ratio_ci(la, lb, rng, reps=50)
        self.assertAlmostEqual(lo, 0.2)
        self.assertAlmostEqual(hi, 0.2)


class TestEndToEnd(unittest.TestCase):
    def test_pipeline_synthetic(self):
        rng = np.random.default_rng(5)
        T = 900
        S = 1e15 * np.exp(np.cumsum(rng.standard_normal(T) * 0.01))
        D = 0.7 * S * np.exp(rng.standard_normal(T) * 0.005)
        C = S - D
        dmin = np.minimum(C, np.roll(C, -1)) - 0.01 * S * rng.random(T)
        dmin[-1] = np.nan
        Q = np.zeros(T)
        R = np.zeros(T)
        Q[700] = 0.05 * S[700]                      # a round trip outstanding at one anchor
        cash_t0 = C - Q
        origins = [f"2024-{1 + (i // 28) % 12:02d}-{1 + i % 28:02d}" for i in range(T)]
        sets = {"24h": {"score": np.arange(400, 880), "q2": np.arange(880, 890)},
                "7d": {"score": np.arange(400, 880), "q2": np.arange(880, 890)}}
        spread = rng.standard_normal(T)
        full = r.make_flows(S, C + 0, dmin, Q, R)
        self.assertAlmostEqual(full[1][700], C[700] + Q[700])
        self.assertAlmostEqual(full[2][700], D[700])               # aToken round trip leaves debt unchanged
        live = r.make_flows(S, C, dmin, np.zeros(T), R)
        fc = r.run_variant(full, live, dmin, cash_t0, sets, spread, True)
        raw = r.run_variant(r.make_flows(S, C, dmin, np.zeros(T), R), None, dmin, cash_t0, sets, spread, False)
        per_h, rows = r.score_all(dmin, sets, fc, raw, S, origins, spread, Q, R, np.random.default_rng(0),
                                  say=lambda *a: None)
        for h in ("24h", "7d"):
            self.assertEqual(per_h[h]["n_scoring"], 480)
            self.assertTrue(np.isfinite(per_h[h]["step1_skill"]))
            self.assertEqual(per_h[h]["q2_reported"]["n"], 10)
        self.assertGreater(len(rows), 900)


if __name__ == "__main__":
    unittest.main()
