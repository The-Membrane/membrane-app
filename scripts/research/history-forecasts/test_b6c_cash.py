#!/usr/bin/env python3
"""Synthetic tests for b6c_cash.py (Q26 R9.1(d)3, B6c). They read no dataset and score nothing:
  python3 -m unittest scripts/research/history-forecasts/test_b6c_cash.py -v
"""
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import b6c_cash as C  # noqa: E402
import bg_gradient as G  # noqa: E402

DAY = 86400
M = G.MICRO


def qrt(unit, wb, wts, neutral, legs, wlog=1):
    return {"qrt": "q", "role": "r", "unit": unit, "w_block": wb, "w_log": wlog, "w_ts": wts, "neutral": neutral,
            "redeposit": sorted(legs), "done_ts": max(x[2] for x in legs)}


class TestNeutralisation(unittest.TestCase):
    def setUp(self):
        # snapshots at blocks 100, 200, 300 (T = 1000 + d * DAY, the block just before T)
        self.blocks = np.array([100, 200, 300])
        self.T = np.array([1000, 1000 + DAY, 1000 + 2 * DAY])

    def test_anchor_outstanding_and_lookahead(self):
        # unit 0: withdraw at block 190 (before snapshot 1), redeposit at block 205 (ts T1 + 600) -> visible
        # unit 1: withdraw at block 195, redeposit at block 230 (ts T1 + 7000 > T1 + 3600) -> label only
        q = [qrt(0, 190, self.T[1] - 900, 50 * M, [(205, 3, int(self.T[1]) + 600, 50 * M)]),
             qrt(1, 195, self.T[1] - 300, 40 * M, [(230, 3, int(self.T[1]) + 7000, 40 * M)])]
        lab, feat, st = C.anchor_adjust(q, self.blocks, self.T)
        self.assertEqual(lab, {(0, 1): 50 * M, (1, 1): 40 * M})
        self.assertEqual(feat, {(0, 1): 50 * M})
        self.assertEqual(st["not_visible_at_feature_time"], 1)

    def test_partial_redeposit_at_snapshot(self):
        q = [qrt(0, 150, 0, 30 * M, [(160, 2, 10, 10 * M), (250, 2, 20, 20 * M)])]
        lab, _, _ = C.anchor_adjust(q, self.blocks, self.T, lookahead=10 ** 9)
        self.assertEqual(lab, {(0, 1): 20 * M})

    def test_no_outstanding_within_day(self):
        q = [qrt(0, 120, 0, 30 * M, [(130, 2, 10, 30 * M)])]
        lab, feat, _ = C.anchor_adjust(q, self.blocks, self.T)
        self.assertEqual(lab, {})
        self.assertEqual(feat, {})

    def test_block_adjust_and_path_consistency(self):
        # unit 0 per-block deltas: day 0: +100 at b110; withdraw -60 at b190; day 1: redeposit +60 at b205
        unit = np.array([0, 0, 0])
        block = np.array([110, 190, 205])
        ts = np.array([1100, int(self.T[1]) - 900, int(self.T[1]) + 600])
        delta = np.array([100, -60, 60], dtype=np.int64) * M
        q = [qrt(0, 190, int(ts[1]), 60 * M, [(205, 3, int(ts[2]), 60 * M)])]
        adj = C.leg_adjustments(q)
        d2, n = C.apply_block_adjust(unit, block, delta, adj)
        self.assertEqual(n, 2)
        self.assertEqual(d2.tolist(), [100 * M, 0, 0])
        A = np.array([[0, 40 * M, 100 * M]], dtype=np.int64)        # raw anchors (withdraw outstanding at d = 1)
        lab, _, _ = C.anchor_adjust(q, self.blocks, self.T)
        A2 = C.adjusted_anchors(A, lab)
        self.assertEqual(A2.tolist(), [[0, 100 * M, 100 * M]])
        Av = np.ones_like(A, bool)
        p = G.build_paths(unit, ts, d2, A2, Av, self.T)
        self.assertEqual(p["v"].tolist(), [100 * M, 100 * M, 100 * M])
        self.assertEqual(int(A[0, 0]), 0)                           # input untouched

    def test_block_adjust_missing_entry_stops(self):
        adj = (np.array([0]), np.array([999]), np.array([1]), np.array([5]))
        with self.assertRaises(SystemExit):
            C.apply_block_adjust(np.array([0]), np.array([100]), np.array([1]), adj)

    def test_neutral_withdrawals(self):
        q = [qrt(2, 190, 0, 60 * M, [(205, 3, 10, 60 * M)], wlog=7)]
        amt, hit = C.neutral_withdrawals(np.array([190, 191]), np.array([7, 7]), np.array([2, 2]),
                                         np.array([70 * M, 5 * M]), np.array(["burn", "burn"]), q)
        self.assertEqual(hit, 1)
        self.assertEqual(amt.tolist(), [10 * M, 5 * M])
        with self.assertRaises(SystemExit):     # wrong unit
            C.neutral_withdrawals(np.array([190]), np.array([7]), np.array([3]), np.array([70 * M]),
                                  np.array(["burn"]), q)
        with self.assertRaises(SystemExit):     # leg missing
            C.neutral_withdrawals(np.array([191]), np.array([7]), np.array([2]), np.array([70 * M]),
                                  np.array(["burn"]), q)


class TestCrossings(unittest.TestCase):
    def test_find_and_mask(self):
        mid = 10 * DAY
        bu = np.array([0, 0, 1, 1])
        bt = np.array([mid - 1500, mid - 30000, mid - 600, mid - 600])
        bv = np.array([30, 30, 30, 10]) * 10 ** 6 * M
        ru = np.array([0, 0, 1, 1])
        rt = np.array([mid + 900, mid - 29000, mid + 9000, mid + 100])
        rv = np.array([29, 30, 30, 10]) * 10 ** 6 * M
        cu, ct = C.find_crossings(bu, bt, bv, ru, rt, rv)
        # unit 0 first borrow: repaid 29/30 >= 95% after midnight within 2 h -> crossing
        # unit 0 second: repaid same day -> no; unit 1 $30M: repay after 2 h -> no; $10M below threshold
        self.assertEqual(cu.tolist(), [0])
        self.assertEqual(ct.tolist(), [mid - 1500])
        m = C.crossing_mask(cu, ct, np.array([0, 0, 1]), np.array([mid - DAY, mid, mid - DAY]), DAY)
        self.assertEqual(m.tolist(), [True, False, False])


class TestRedact(unittest.TestCase):
    def test_redact_keys(self):
        a = "0x" + "ab" * 20
        o = {"x": {a: 3, "y": [{a.upper().replace("0X", "0x"): 1}]}, "h": "0x" + "cd" * 32}
        r = C.redact_keys(o)
        self.assertEqual(r, {"x": {"asset-01": 3, "y": [{"asset-01": 1}]}, "h": "0x" + "cd" * 32})


if __name__ == "__main__":
    unittest.main()
