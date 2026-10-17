#!/usr/bin/env python3
"""Unit tests for r118_blind_apr.py on synthetic data only (no market read, no score).

  python3 -m unittest scripts/research/history-forecasts/test_r118_blind_apr.py -v
"""
import math
import os
import sys
import unittest

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import r118_blind_apr as M  # noqa: E402
import r114_apr_combo as C  # noqa: E402

RAY = 10 ** 27


def synth_daily(n=900, seed=5):
    """A synthetic market: fixed kinked curve, usage random walk in logit space, stored rate on the curve."""
    rng = np.random.default_rng(seed)
    dates = pd.date_range("2022-01-01", periods=n, freq="D", tz="UTC")
    x = np.cumsum(rng.normal(0, 0.05, n)) + 1.0
    U = 1 / (1 + np.exp(-x))
    opt, base, s1, s2 = 0.9, 0.0, 0.04, 0.6
    rate = np.where(U <= opt, base + s1 * U / opt, base + s1 + s2 * (U - opt) / (1 - opt))
    debt = 5e12 * U
    cash = 5e12 * (1 - U)
    rows = []
    for i, d in enumerate(dates):
        rows.append({"date": d.strftime("%Y-%m-%d"), "block": 1000 + i,
                     "block_ts": int(d.timestamp()) - 5, "rate_ray": str(int(rate[i] * RAY)),
                     "variable_debt_raw": str(int(debt[i])), "stable_debt_raw": "0",
                     "cash_balance_raw": str(int(cash[i])), "virtual_balance_raw": "",
                     "optimal_usage_ray": str(int(opt * RAY)), "base_rate_ray": str(int(base * RAY)),
                     "slope1_ray": str(int(s1 * RAY)), "slope2_ray": str(int(s2 * RAY))})
    return pd.DataFrame(rows)


class T(unittest.TestCase):
    def test_f_floor(self):
        self.assertEqual(M.f_floor(0.0), 0.5)
        self.assertEqual(M.f_floor(7.0), 0.5)
        self.assertAlmostEqual(M.f_floor(14.0), 0.25)
        self.assertEqual(M.f_floor(21.0), 0.0)
        self.assertEqual(M.f_floor(math.inf), 0.0)

    def test_s_days_strictly_before(self):
        t0 = 10 * 86400
        self.assertEqual(M.s_days(t0, []), math.inf)
        self.assertEqual(M.s_days(t0, [t0]), math.inf)          # a change at t0 is not before t0
        self.assertAlmostEqual(M.s_days(t0, [t0 - 3 * 86400, t0 - 86400]), 1.0)

    def test_m3_equals_m2_without_floor(self):
        rng = np.random.default_rng(1)
        Qc = np.sort(rng.normal(0.05, 0.01, (20, 5)), 1)
        Qr = np.sort(rng.normal(0.05, 0.01, (20, 5)), 1)
        wa = rng.uniform(0, 1, (20, 5))
        q3, wr = M.m3_quantiles(Qc, Qr, wa, [math.inf] * 20)
        q2 = np.sort(wa * Qc + (1 - wa) * Qr, 1)
        self.assertTrue(np.allclose(q3, q2))
        q3b, wrb = M.m3_quantiles(Qc, Qr, np.ones((20, 5)), [1.0] * 20)
        self.assertTrue(np.allclose(wrb, 0.5))

    def test_ewc_null_size_and_power(self):
        rng = np.random.default_rng(7)
        rej = sum(M.ewc_test(rng.normal(0, 1, 150))["p"] < 0.0125 for _ in range(2000))
        self.assertLess(rej / 2000, 0.03)
        self.assertLess(M.ewc_test(rng.normal(-1, 1, 150))["p"], 1e-3)

    def test_weekly_means_drop_short_weeks(self):
        d = pd.date_range("2024-01-07", periods=10, freq="D", tz="UTC")   # Sunday start: 7 + 3 days
        w, dropped = M.weekly_means(d, np.arange(10.0))
        self.assertEqual(len(w), 1)
        self.assertEqual(dropped, 1)
        self.assertAlmostEqual(w[0], 3.0)

    def test_cluster_t(self):
        r = M.cluster_t([-1.0, -2.0, -1.5, -1.2])
        self.assertEqual(r["df"], 3)
        self.assertLess(r["p"], 0.01)

    def test_c3_on_synthetic_market(self):
        kernel, coord, _ = M.load_q33()
        D = synth_daily()
        out, info = M.c3_forecasts(D, kernel, coord)
        self.assertIsNotNone(info["first_fold"])
        got = [v for v in out.values() if v[0] is not None]
        self.assertGreater(len(got), 100)
        for q, _ in got[:50]:
            self.assertTrue(all(a <= b for a, b in zip(q, q[1:])))

    def test_r103_on_synthetic_market(self):
        D = synth_daily()
        st = M.R.daily_state(M.h_frame(D))
        rq = M.r103_forecasts(st, st.index[0])
        self.assertGreater(len(rq), 300)
        q = next(iter(rq.values()))
        self.assertTrue(np.all(np.diff(q) >= 0))
        # served to day d: the read on date d-1 is the state at d
        self.assertEqual(st.index[0], pd.Timestamp(D["date"].iloc[0], tz="UTC"))

    def test_emp_and_m2_import_unchanged(self):
        self.assertEqual(C.ETAS, [0.0, 50.0, 200.0, 1000.0])
        self.assertEqual(C.WEIGHT_WINDOW_D, 90)


if __name__ == "__main__":
    unittest.main()
