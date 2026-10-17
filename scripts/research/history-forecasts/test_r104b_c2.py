#!/usr/bin/env python3
"""Synthetic tests for r104b_c2.py and r104b_acquire_c2.py (no real data, no outcome)."""
import os
import sys
import unittest

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import r104b_acquire_c2 as A  # noqa: E402
import r104b_c2 as B  # noqa: E402
import r104_cash as R4  # noqa: E402

RAY = 10 ** 27


class TestUnits(unittest.TestCase):
    def test_to_micro(self):
        self.assertEqual(B.to_micro(123456789, 6), 123456789)
        self.assertEqual(B.to_micro(10 ** 18 + 999_999_999_999, 18), 10 ** 6)
        self.assertEqual(B.to_micro(-(10 ** 18 + 1), 18), -(10 ** 6))

    def test_cash_path_exact_then_floor(self):
        # three transfers of 0.6e-6 tokens (18 dec) in different txs: per-transfer floor would give 0, path floor 1
        tin = pd.DataFrame({"block": [10, 11, 12], "ts": [100, 110, 120], "tx_index": [0, 0, 0],
                            "amount_raw": [str(600_000_000_000)] * 3})
        tout = pd.DataFrame({"block": [12], "ts": [120], "tx_index": [1], "amount_raw": [str(10 ** 12)]})
        tl = B.cash_path(tin, tout, 18)
        self.assertEqual(tl["cash_raw"].tolist(), [600_000_000_000, 1_200_000_000_000, 1_800_000_000_000,
                                                    800_000_000_000])
        self.assertEqual(tl["cash"].tolist(), [0, 1, 1, 0])

    def test_cash_path_groups_tx(self):
        tin = pd.DataFrame({"block": [5, 5], "ts": [50, 50], "tx_index": [2, 2], "amount_raw": ["7", "3"]})
        tout = pd.DataFrame({"block": [5], "ts": [50], "tx_index": [2], "amount_raw": ["4"]})
        tl = B.cash_path(tin, tout, 6)
        self.assertEqual(len(tl), 1)
        self.assertEqual(int(tl["cash"].iloc[0]), 6)


class TestRoundTrips(unittest.TestCase):
    def test_supply_timeline(self):
        ev = pd.DataFrame({"block": [1, 1, 2], "tx_index": [0, 0, 0], "log_index": [0, 1, 0],
                           "type": ["Mint", "Mint", "Burn"],
                           "delta1_raw": [str(10 ** 18 * 100), str(10 ** 18 * 50), str(-10 ** 18 * 30)],
                           "index_ray": [str(RAY), str(RAY), str(2 * RAY)]})
        tl = B.supply_timeline(ev, 18)
        self.assertEqual(len(tl), 2)
        self.assertAlmostEqual(tl["supply_raw_f"].iloc[0], 150e6)
        # scaled 150 - 15 = 135 at index 2 -> 270
        self.assertAlmostEqual(tl["supply_raw_f"].iloc[1], 270e6)

    def test_qrt_legs_and_outstanding(self):
        q = {"burn": {"key": (1, 0, 0), "ts": 1000}, "neutral": 50, "legs": [(0, 30, 1500, None), (1, 20, 2000, None)]}
        legs = B.qrt_legs([q])
        self.assertEqual(legs["leg"].tolist(), ["withdraw", "redeposit", "redeposit"])
        anchors = np.array([999, 1000, 1600, 2000])
        out = R4.qrt_outstanding(legs, anchors)
        self.assertEqual([int(x) for x in out], [0, 50, 20, 0])


class TestPooled(unittest.TestCase):
    def test_pooled_dk_sums_by_date(self):
        ds, D, c = B.pooled_dk({"a": ["2025-01-01", "2025-01-02"], "b": ["2025-01-02"]},
                               {"a": np.array([1.0, 2.0]), "b": np.array([5.0])})
        self.assertEqual(ds, ["2025-01-01", "2025-01-02"])
        self.assertEqual(D.tolist(), [1.0, 7.0])
        self.assertEqual(c.tolist(), [1, 2])

    def test_pass_rules(self):
        self.assertTrue(B.pass_market(0.001, 0.2))
        self.assertFalse(B.pass_market(0.01, 0.2))         # 0.01 > 0.025/3
        self.assertFalse(B.pass_market(0.001, 0.05))       # no-change rule
        self.assertTrue(B.pass_pooled(0.02, 0.11))
        self.assertFalse(B.pass_pooled(0.03, 0.5))
        self.assertFalse(B.pass_pooled(float("nan"), 0.5))

    def test_nw_lrv_iid(self):
        rng = np.random.default_rng(1)
        d = rng.normal(size=20000)
        self.assertAlmostEqual(B.nw_lrv(d), 1.0, delta=0.08)


class TestFiniteFlows(unittest.TestCase):
    def test_zero_debt_start_does_not_poison_har(self):
        rng = np.random.default_rng(3)
        T = 300
        S = 1e14 * np.exp(np.cumsum(rng.normal(0, 0.01, T)))
        C = S * (0.2 + 0.05 * rng.random(T))
        C[:2] = S[:2]                         # debt exactly 0 on the first two days
        Z = np.zeros(T)
        F = R4.make_flows(S, C, C * 0.95, Z, Z)
        self.assertFalse(np.isfinite(F[4][:2]).any())
        c_bad, _, _ = R4.har_fit(F[4], 200, 250)
        self.assertIsNone(c_bad)                                 # the failure mode: no finite HAR row
        G = B.finite_flows(F)
        _, sig_ok, _ = R4.har_fit(G[4], 200, 250)
        self.assertTrue(np.isfinite(sig_ok[250:]).all())


class TestAcquire(unittest.TestCase):
    def test_streams_and_slim(self):
        s = A.streams()
        self.assertEqual(len(s), 6)
        spec, dep = s["core_usds-out"]
        self.assertEqual(spec["topics"][0], A.L1.T_TRANSFER)
        row = {"topic0": A.L1.T_TRANSFER, "block": 1, "ts": 2, "tx_index": 3, "log_index": 4,
               "data": "0x" + hex(12345)[2:].rjust(64, "0")}
        out = A.slim([row])
        self.assertEqual(out[0]["amount_raw"], "12345")
        self.assertEqual(set(out[0]), set(A.FIELDS))


class TestEndToEndSynthetic(unittest.TestCase):
    def test_frozen_model_runs_on_synthetic_market(self):
        rng = np.random.default_rng(7)
        T = 400
        S = 1e14 * np.exp(np.cumsum(rng.normal(0, 0.01, T)))
        C = S * (0.2 + 0.05 * rng.random(T))
        dmin = C * 0.95
        Z = np.zeros(T)
        F = R4.make_flows(S, C, dmin, Z, Z)
        sets = {"24h": {"score": np.array([300, 301]), "q2": np.array([], int)},
                "7d": {"score": np.array([], int), "q2": np.array([], int)}}
        fc = R4.run_variant(F, None, dmin, C, sets, None, False)
        self.assertEqual(sorted(fc["24h"]), [300, 301])
        self.assertEqual(len(fc["24h"][300]["q1"]), 3)
        self.assertEqual(fc["7d"], {})


if __name__ == "__main__":
    unittest.main()
