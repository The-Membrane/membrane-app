#!/usr/bin/env python3
"""Synthetic tests for the Q26 round 7 helpers (r7_live.py, r7_refill.py).

  python3 -m unittest scripts/research/history-forecasts/test_r7_live.py -v
"""
import json
import math
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import r7_live as R7  # noqa: E402
import r7_refill as RF  # noqa: E402


def days(n, start="2026-10-14", step=1):
    d0 = datetime.strptime(start, "%Y-%m-%d")
    return [(d0 + timedelta(days=step * i)).strftime("%Y-%m-%d") for i in range(n)]


def ts(iso):
    return int(datetime.strptime(iso, "%Y-%m-%dT%H:%M").replace(tzinfo=timezone.utc).timestamp())


class TestStatistic(unittest.TestCase):
    def test_lag_and_min_days(self):
        self.assertEqual([R7.nw_lag(h) for h in (1, 6, 24, 48, 72, 168, 720)], [0, 0, 0, 1, 2, 6, 29])
        self.assertEqual([R7.min_days(h) for h in (6, 24, 48, 168, 720)], [30, 30, 60, 210, 900])

    def test_nw_variance_by_hand(self):
        d = np.array([1.0, -0.5, 2.0, 0.0, -1.0])
        self.assertAlmostEqual(R7.nw_variance(d, 0), 1 + 0.25 + 4 + 0 + 1)
        g1 = 1 * -0.5 + -0.5 * 2 + 2 * 0 + 0 * -1
        g2 = 1 * 2 + -0.5 * 0 + 2 * -1
        self.assertAlmostEqual(R7.nw_variance(d, 1), 6.25 + 2 * 0.5 * g1)
        self.assertAlmostEqual(R7.nw_variance(d, 2), 6.25 + 2 * (2 / 3) * g1 + 2 * (1 / 3) * g2)
        self.assertAlmostEqual(R7.nw_variance(d, 10), R7.nw_variance(d, 10))    # lag beyond length is safe

    def test_z_daily_sums_and_missing_days(self):
        # two rows per day for 40 days; one missing day in the middle contributes d = 0
        ds = days(41)
        ds = ds[:20] + ds[21:]
        dates, y, p = [], [], []
        for i, d in enumerate(ds):
            for j in range(2):
                dates.append(d)
                y.append(1 if (i + j) % 3 == 0 else 0)
                p.append(0.2)
        L = R7.light("u", dates, y, p, 6)
        o = np.array(y, float).reshape(-1, 2).sum(1)
        e = np.full(40, 0.4)
        dd = np.insert(o - e, 20, 0.0)
        self.assertEqual(L["nDays"], 40)
        self.assertAlmostEqual(L["O"], o.sum())
        self.assertAlmostEqual(L["E"], 16.0)
        self.assertAlmostEqual(L["nwVar"], float(dd @ dd))
        self.assertAlmostEqual(L["z"], (o.sum() - 16) / math.sqrt(dd @ dd))
        L7 = R7.light("u", dates, y, p, 168)                               # lag 6 on the calendar grid
        self.assertAlmostEqual(L7["nwVar"], R7.nw_variance(dd, 6))
        self.assertEqual(L7["band"], R7.INSUFFICIENT)                      # 40 < 210 days

    def test_calibrated_overlap_size(self):
        """Overlapping 7-day windows of a daily Bernoulli process, calibrated p: |z| >= 2 in roughly 5-15% of runs
        with the registered Bartlett lag (Bartlett weights under-count a full 6-day overlap), far more without it."""
        rng = np.random.default_rng(1)
        hit_nw = hit_0 = 0
        R = 400
        for _ in range(R):
            ev = rng.random(400 + 7) < 0.02
            y = np.array([ev[t:t + 7].any() for t in range(400)], float)
            p = np.full(400, 1 - 0.98 ** 7)
            d = y - p
            z_nw = d.sum() / math.sqrt(R7.nw_variance(d, 6))
            z_0 = d.sum() / math.sqrt(R7.nw_variance(d, 0))
            hit_nw += abs(z_nw) >= 2
            hit_0 += abs(z_0) >= 2
        self.assertLess(hit_nw / R, 0.15)
        self.assertGreater(hit_0 / R, 2 * hit_nw / R)


class TestR8Kernel(unittest.TestCase):
    def test_hh_by_hand_and_fallback(self):
        d = np.array([1.0, -0.5, 2.0, 0.0, -1.0])
        g1 = 1 * -0.5 + -0.5 * 2 + 2 * 0 + 0 * -1
        g2 = 1 * 2 + -0.5 * 0 + 2 * -1
        self.assertAlmostEqual(R7.hh_variance(d, 0), 6.25)
        self.assertAlmostEqual(R7.hh_variance(d, 1), 6.25 + 2 * g1)
        self.assertAlmostEqual(R7.hh_variance(d, 2), 6.25 + 2 * g1 + 2 * g2)
        v, fb = R7.lr_variance_v2(d, 2)
        self.assertFalse(fb)
        self.assertAlmostEqual(v, 6.25 + 2 * g1 + 2 * g2)
        a = np.array([1.0, -1.0, 1.0, -1.0])                               # HH at lag 1 = 4 - 6 < 0
        self.assertLess(R7.hh_variance(a, 1), 0)
        v, fb = R7.lr_variance_v2(a, 1)
        self.assertTrue(fb)
        self.assertAlmostEqual(v, R7.nw_variance(a, 1))
        self.assertIsInstance(v, float)

    def test_vectorized_matches_scalar(self):
        rng = np.random.default_rng(7)
        D = rng.normal(size=(6, 40))
        for lag in (0, 1, 6, 29):
            vb = R7.bartlett_variance(D, lag)
            vh = R7.hh_variance(D, lag)
            v2, fb = R7.lr_variance_v2(D, lag)
            for i in range(6):
                self.assertAlmostEqual(vb[i], R7.nw_variance(D[i], lag))
                self.assertAlmostEqual(vh[i], R7.hh_variance(D[i], lag))
                self.assertAlmostEqual(v2[i], vh[i] if vh[i] > 0 else vb[i])
                self.assertEqual(bool(fb[i]), bool(vh[i] <= 0))


class TestR8bTier(unittest.TestCase):
    def test_edges(self):
        f = R7.evidence_tier_v2
        self.assertEqual(f(20, 10, 30), "full")
        self.assertEqual(f(20, 9.99, 30), "provisional")               # O + E < 30
        self.assertEqual(f(19.99, 50, 30), "provisional")              # E < 20
        self.assertEqual(f(30, 30, 29), "provisional")                 # < 30 windows
        self.assertEqual(f(10, 0, 20), "provisional")
        self.assertIsNone(f(9.99, 50, 40))
        self.assertIsNone(f(15, 50, 19))
        self.assertEqual(list(f([20, 10, 5], [10, 0, 0], [30, 20, 40])), [2, 1, 0])


class TestGatingAndBands(unittest.TestCase):
    def test_evidence_gating(self):
        ds = days(30)
        L = R7.light("u", ds, [0] * 30, [0.1] * 30, 24)                   # E = 3 < 5
        self.assertFalse(L["evidence"])
        self.assertEqual(L["band"], R7.INSUFFICIENT)
        self.assertIsNone(L["z"])
        self.assertIsNotNone(L["zRaw"])
        L = R7.light("u", ds, [0] * 30, [0.2] * 30, 24)                   # E = 6, 30 days -> shows
        self.assertTrue(L["evidence"])
        self.assertEqual(L["band"], "red")                                 # z = -6 / sqrt(30 * 0.04) = -5.5
        L = R7.light("u", ds[:29], [0] * 29, [0.2] * 29, 24)               # 29 days < 30
        self.assertEqual(L["band"], R7.INSUFFICIENT)
        L = R7.light("u", ds, [0] * 30, [0.2] * 30, 48)                    # 48 h needs 60 days
        self.assertEqual(L["band"], R7.INSUFFICIENT)
        self.assertEqual(R7.light("u", [], [], [], 6)["band"], R7.INSUFFICIENT)

    def test_band_edges(self):
        for z, b in ((0.0, "green"), (1.999, "green"), (2.0, "amber"), (-2.5, "amber"), (2.999, "amber"),
                     (3.0, "red"), (-3.0, "red"), (None, R7.INSUFFICIENT)):
            self.assertEqual(R7.band_of(z), b)

    def test_band_transitions_as_evidence_accrues(self):
        """A cell under-forecast by half moves insufficient -> green/amber -> red as days accrue."""
        rng = np.random.default_rng(3)
        ds = days(400)
        y = (rng.random(400) < 0.3).astype(float)
        p = np.full(400, 0.15)
        seen = [R7.light("u", ds[:n], y[:n], p[:n], 24)["band"] for n in (10, 30, 60, 400)]
        self.assertEqual(seen[0], R7.INSUFFICIENT)
        self.assertEqual(seen[-1], "red")
        order = {R7.INSUFFICIENT: 0, "green": 1, "amber": 2, "red": 3}
        self.assertEqual(seen, sorted(seen, key=order.get))

    def test_comparison_rows(self):
        ds = days(10)
        y = [1, 0, 0, 1, 0, 0, 0, 1, 0, 0]
        p = [0.8, 0.1, 0.1, 0.7, 0.2, 0.1, 0.1, 0.6, 0.2, 0.1]
        pa = [0.3] * 10
        pprev = [0.5] * 5 + [float("nan")] * 5
        L = R7.light("u", ds, y, p, 6, refs={"bss_vs_a": pa, "bss_vs_prev": pprev})
        b = np.mean((np.array(p) - y) ** 2)
        self.assertAlmostEqual(L["comparison"]["bss_vs_a"]["bss"], 1 - b / np.mean((np.array(pa) - y) ** 2))
        self.assertEqual(L["comparison"]["bss_vs_prev"]["n"], 5)
        self.assertFalse(L["comparison"]["decides"])

    def test_early_warning(self):
        ds = days(7)
        L6 = R7.light("u", ds[:6], [1, 0, 0, 0, 0, 0], [0.2] * 6, 24)
        self.assertNotIn("earlyWarning", L6)
        L = R7.light("u", ds, [1, 0, 0, 1, 0, 0, 0], [0.2] * 7, 24)
        ew = L["earlyWarning"]
        self.assertAlmostEqual(ew["R"], 1.4 / 2)
        lo, hi = ew["ci95"]
        self.assertTrue(lo <= ew["R"] <= (hi if hi != "inf" else math.inf))
        self.assertEqual(R7.light("u", ds, [1, 0, 0, 1, 0, 0, 0], [0.2] * 7, 24)["earlyWarning"], ew)  # seeded
        self.assertFalse(ew["decides"])
        Lz = R7.light("u", ds, [0] * 7, [0.2] * 7, 24)
        self.assertEqual(Lz["earlyWarning"]["R"], "inf")
        self.assertEqual(Lz["earlyWarning"]["ci95"], ["inf", "inf"])


class TestWeekly(unittest.TestCase):
    def lights(self, band):
        return {"A|1d|pooled": {"band": band, "z": 3.5 if band == "red" else 0.5},
                "B|1d|pooled": {"band": "green", "z": 0.1}}

    def test_monday_only_once(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "scores", R7.WEEKLY_FILE)
            st, app, recs = R7.run_weekly(p, self.lights("red"), ts("2026-10-20T00:47"))   # Tuesday
            self.assertFalse(app)
            self.assertFalse(os.path.exists(p))
            st, app, recs = R7.run_weekly(p, self.lights("red"), ts("2026-10-19T00:47"))   # Monday
            self.assertTrue(app)
            st, app, recs = R7.run_weekly(p, self.lights("green"), ts("2026-10-19T09:00"))  # same Monday
            self.assertFalse(app)
            self.assertEqual(len(R7.read_weekly(p)), 1)
            self.assertEqual(R7.read_weekly(p)[0]["bands"]["A|1d|pooled"], "red")

    def test_red_red_is_stale_and_latches(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, R7.WEEKLY_FILE)
            seq = [("2026-10-19", "red"), ("2026-10-26", "green"), ("2026-11-02", "red"), ("2026-11-09", "red"),
                   ("2026-11-16", "green")]
            states = []
            for day, band in seq:
                st, app, _ = R7.run_weekly(p, self.lights(band), ts(day + "T00:47"))
                self.assertTrue(app)
                states.append(st["A|1d|pooled"]["stale"])
            self.assertEqual(states, [False, False, False, True, True])    # latched after a green week
            self.assertEqual(st["A|1d|pooled"]["staleSince"], "2026-11-09")
            self.assertFalse(st["B|1d|pooled"]["stale"])
            L = self.lights("green")
            note = R7.apply_actions(L, st)
            self.assertEqual(L["A|1d|pooled"]["labelAnnotation"], "STALE")
            self.assertTrue(L["A|1d|pooled"]["modelReview"])
            self.assertIsNone(L["B|1d|pooled"]["labelAnnotation"])
            self.assertEqual([n["unit"] for n in note], ["A|1d|pooled"])

    def test_missed_monday_and_insufficient(self):
        recs = [{"date": "2026-10-19", "computedAt": 1, "bands": {"u": "red"}},
                {"date": "2026-11-02", "computedAt": 2, "bands": {"u": "red"}}]          # 10-26 had no run
        self.assertTrue(R7.stale_state(recs)["u"]["stale"])
        recs[1]["bands"]["u"] = R7.INSUFFICIENT
        self.assertFalse(R7.stale_state(recs)["u"]["stale"])

    def test_amber_and_red_annotation(self):
        L = {"a": {"band": "amber"}, "r": {"band": "red"}, "g": {"band": "green"}, "i": {"band": R7.INSUFFICIENT}}
        note = R7.apply_actions(L, {})
        self.assertEqual(L["a"]["labelAnnotation"], "live: amber")
        self.assertEqual(L["r"]["labelAnnotation"], "live: amber")
        self.assertFalse(L["r"]["stale"])
        self.assertIsNone(L["g"]["labelAnnotation"])
        self.assertIsNone(L["i"]["labelAnnotation"])
        self.assertEqual(sorted(n["unit"] for n in note), ["a", "r"])


M = 10 ** 6
REFILL = {"beta": {"3h": 0.1, "24h": 0.3, "72h": 0.5}, "_file": "r.json", "_sha256": "0" * 64}


class TestStress(unittest.TestCase):
    def units(self):
        # balance $, contract
        return [(int(b * M), c) for b, c in ((300e6, 0), (120e6, 1), (60e6, 0), (40e6, 0), (20e6, 1), (12e6, 0),
                                             (8e6, 0), (5e6, 0), (3e6, 1), (2e6, 0), (1.5e6, 0))]

    def test_math(self):
        cash, supply = 250e6, 1000e6
        s = R7.stress_block(self.units(), int(cash * M), int(supply * M), REFILL)
        sc = {x["scenario"]: x for x in s["scenarios"]}
        self.assertAlmostEqual(sc["S2"]["withdrawalUSD"], 420e6)
        self.assertAlmostEqual(sc["S2"]["shortfallUSD"], 170e6)
        self.assertAlmostEqual(sc["S2"]["shortfallShareOfSupply"], 0.17)
        self.assertEqual(sc["S2"]["nContracts"], 1)
        self.assertAlmostEqual(sc["S5"]["withdrawalUSD"], 540e6)
        self.assertAlmostEqual(sc["S10"]["withdrawalUSD"], 570e6)
        # S2: need = 170/420 = 0.40476 in (0.3, 0.5] -> 24 + 48 * (0.40476 - 0.3) / 0.2
        self.assertAlmostEqual(sc["S2"]["hoursUntilCashNonNegative"], 24 + 48 * (170 / 420 - 0.3) / 0.2)
        # S10: need = 320/570 = 0.561 > 0.5 -> not reached
        self.assertIsNone(sc["S10"]["hoursUntilCashNonNegative"])
        self.assertFalse(sc["S10"]["reachedBy72h"])
        # class run-off: wallets 1-10M: 8+5+2+1.5 = 16.5 -> 1.65; 10-50M: 40+12 -> 13; >=50M: 300+60 -> 144;
        # contracts 120+20+3 = 143 -> 143
        ro = sc["class run-off"]
        self.assertAlmostEqual(ro["withdrawalUSD"], 1.65e6 + 13e6 + 144e6 + 143e6)
        self.assertEqual([c["nHolders"] for c in ro["classes"]], [4, 2, 2, 3])
        self.assertAlmostEqual(ro["shortfallUSD"], ro["withdrawalUSD"] - cash)
        # S2 with a large cash -> no shortfall, 0 h
        s2 = R7.stress_block(self.units(), int(500e6 * M), int(supply * M), REFILL)
        self.assertEqual(s2["scenarios"][0]["hoursUntilCashNonNegative"], 0.0)
        # first knot: need 0.05 -> 1.5 h
        s3 = R7.stress_block([(int(100e6 * M), 0), (int(100e6 * M), 0)], int(190e6 * M), int(supply * M), REFILL)
        self.assertAlmostEqual(s3["scenarios"][0]["hoursUntilCashNonNegative"], 3 * 0.05 / 0.1)
        self.assertFalse(s["decides"])

    def test_negative_beta_floored_and_monotone(self):
        rf = {"beta": {"3h": -0.1, "24h": 0.2, "72h": 0.1}}
        s = R7.stress_block([(int(100e6 * M), 0), (int(100e6 * M), 0)], int(170e6 * M), int(1e9 * M), rf)
        # need 0.15: knots 0, 0, 0.2, 0.2 -> 3 + 21 * 0.75
        self.assertAlmostEqual(s["scenarios"][0]["hoursUntilCashNonNegative"], 3 + 21 * 0.75)

    def test_no_address(self):
        s = R7.stress_block(self.units(), int(250e6 * M), int(1e9 * M), REFILL)
        txt = json.dumps(s)
        self.assertNotIn("0x", txt)
        self.assertNotIn("address", txt.lower())
        self.assertEqual([t["rank"] for t in s["topHolders"]], list(range(1, 11)))


class TestRefill(unittest.TestCase):
    def test_estimate_recovers_beta(self):
        rng = np.random.default_rng(5)
        n = 5000
        W = rng.exponential(1e6, n + 100) * (rng.random(n + 100) < 0.3)
        R = rng.exponential(2e5, n + 100)
        for lag, frac in ((1, 0.05), (2, 0.05), (10, 0.1), (40, 0.1)):            # response spread over hours
            R[lag:] += frac * W[:-lag]
        est = RF.estimate(W, R, n)
        self.assertAlmostEqual(est["3h"]["beta"], 0.10, delta=0.02)
        self.assertAlmostEqual(est["24h"]["beta"], 0.20, delta=0.03)
        self.assertAlmostEqual(est["72h"]["beta"], 0.30, delta=0.04)
        self.assertEqual(est["72h"]["nwLag"], 72)


if __name__ == "__main__":
    unittest.main()
