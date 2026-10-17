#!/usr/bin/env python3
"""Tests for r9_correct.py (Q26 R9.1 inputs): detector thresholds, mint consumption, transfer stop, look-ahead
helpers, time weighting and lock-spell merging."""
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import r9_correct as r  # noqa: E402

M = r.MICRO
SUP = 2_000_000_000 * M          # $2B supply -> 0.5% = $10M


def burn(i, unit, usd, ts):
    return {"key": (100 + i, 0, 0), "unit": unit, "w": int(usd * M), "ts": ts, "i": i}


def mint(i, usd, ts, ref):
    return ((100 + i, 0, 0), ts, "M", int(usd * M), ref)


class TestDetector(unittest.TestCase):
    def test_basic_round_trip(self):
        b = [burn(0, "A", 143e6, 1000)]
        ue = {"A": [mint(1, 143e6, 1000 + 2400, "m1")]}
        q = r.detect_qrt(b, ue, lambda _: SUP)
        self.assertEqual(len(q), 1)
        self.assertEqual(q[0]["neutral"], int(143e6 * M))
        self.assertEqual(q[0]["done_ts"], 3400)

    def test_thresholds(self):
        ue = {"A": [mint(1, 9e6, 1100, "m1")]}
        self.assertEqual(r.detect_qrt([burn(0, "A", 9e6, 1000)], ue, lambda _: SUP), [])
        ue = {"A": [mint(1, 20e6, 1100, "m1")]}
        # $20M < 0.5% of $5B
        self.assertEqual(r.detect_qrt([burn(0, "A", 20e6, 1000)], ue, lambda _: 5_000_000_000 * M), [])

    def test_window_and_fill(self):
        ue = {"A": [mint(1, 100e6, 1000 + 7201, "m1")]}
        self.assertEqual(r.detect_qrt([burn(0, "A", 100e6, 1000)], ue, lambda _: SUP), [])
        ue = {"A": [mint(1, 94e6, 1500, "m1")]}
        self.assertEqual(r.detect_qrt([burn(0, "A", 100e6, 1000)], ue, lambda _: SUP), [])
        ue = {"A": [mint(1, 50e6, 1500, "m1"), mint(2, 46e6, 1600, "m2")]}
        q = r.detect_qrt([burn(0, "A", 100e6, 1000)], ue, lambda _: SUP)
        self.assertEqual(q[0]["neutral"], int(96e6 * M))

    def test_transfer_stops(self):
        ue = {"A": [((101, 0, 0), 1100, "T", 0, "t1"), mint(2, 100e6, 1200, "m2")]}
        self.assertEqual(r.detect_qrt([burn(0, "A", 100e6, 1000)], ue, lambda _: SUP), [])

    def test_mint_consumed_once(self):
        b = [burn(0, "A", 70e6, 1000), burn(1, "A", 70e6, 1010)]
        ue = {"A": [mint(2, 140e6, 1500, "m")]}
        q = r.detect_qrt(b, ue, lambda _: SUP)
        self.assertEqual(len(q), 2)
        self.assertEqual(sum(x["neutral"] for x in q), int(140e6 * M))
        b = [burn(0, "A", 70e6, 1000), burn(1, "A", 70e6, 1010)]
        ue = {"A": [mint(2, 70e6, 1500, "m")]}
        self.assertEqual(len(r.detect_qrt(b, ue, lambda _: SUP)), 1)

    def test_mint_before_burn_ignored(self):
        ue = {"A": [((99, 0, 0), 900, "M", int(100e6 * M), "m0")]}
        self.assertEqual(r.detect_qrt([burn(0, "A", 100e6, 1000)], ue, lambda _: SUP), [])


class TestHelpers(unittest.TestCase):
    def test_window_segments(self):
        ts = np.array([0, 50, 100, 150])
        idx, dur = r.window_segments(ts, 25, 125)
        self.assertEqual(list(idx), [0, 1, 2])
        self.assertEqual(list(dur), [25.0, 50.0, 25.0])

    def test_tw_median(self):
        self.assertEqual(r.tw_median(np.array([1.0, 5.0, 3.0]), np.array([10.0, 1.0, 1.0])), 1.0)

    def test_spells_merge(self):
        ts = np.array([0, 100, 200, 1000, 1100, 5000])
        below = np.array([True, False, True, False, True, False])
        sp = r.runs_below(ts, below, 6000, 900)
        # [0,100) below; gap 100..200 merged; [200,1000) below; gap 1000..1100 merged; [1100,5000) below
        self.assertEqual(sp, [[0, 5000, 100 + 800 + 3900]])
        sp = r.runs_below(ts, below, 6000, 50)
        self.assertEqual(len(sp), 3)

    def test_ray(self):
        idx = 11 * 10 ** 26
        self.assertEqual(r.ray_mul(r.ray_div(1_000_000, idx), idx), 1_000_000)


if __name__ == "__main__":
    unittest.main()
