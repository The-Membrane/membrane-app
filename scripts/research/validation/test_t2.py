#!/usr/bin/env python3
"""Synthetic tests for t2_curator_warnings.py (T2 of VALIDATION_PREREG.md @506e7c5).

    python3 -I scripts/research/validation/test_t2.py
"""
import os, sys, unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import t2_curator_warnings as t2  # noqa: E402

H, D = t2.HOUR, t2.DAY
T0 = 1_000 * D  # synthetic T0


def hourly(start, end, fire_ranges, observed_ranges=None):
    """Hourly points in [start, end); cond true inside any fire range [a, b)."""
    T = list(range(start, end, H))
    E = [t + H for t in T]
    C = [any(a <= t < b for a, b in fire_ranges) for t in T]
    O = [True] * len(T) if observed_ranges is None else [any(a <= t < b for a, b in observed_ranges) for t in T]
    return T, E, O, C


class Episodes(unittest.TestCase):
    def test_merge_under_7_days(self):
        runs = [[0, D], [D + 6 * D + D - 1, 9 * D]]  # gap just under 7 d
        self.assertEqual(t2.merge_episodes(runs), [[0, 9 * D]])

    def test_no_merge_at_7_days(self):
        runs = [[0, D], [8 * D, 9 * D]]  # gap exactly 7 d -> separate
        self.assertEqual(len(t2.merge_episodes(runs)), 2)

    def test_runs_touching_intervals(self):
        T = [0, H, 2 * H, 5 * H]
        E = [H, 2 * H, 3 * H, 6 * H]
        self.assertEqual(t2.to_runs(T, E, [True, True, False, True]), [[0, 2 * H], [5 * H, 6 * H]])

    def test_merge_through_evaluate(self):
        start = T0 - 200 * D
        fires = [(T0 - 40 * D, T0 - 39 * D), (T0 - 34 * D, T0 - 33 * D), (T0 - 20 * D, T0 - 19 * D)]
        r = t2.evaluate(*hourly(start, T0, fires), 1, T0)
        # first two runs are 5 d apart -> merge; third is 13 d later -> separate
        self.assertEqual(len(r["episodes"]), 2)
        self.assertEqual(r["episodes"][0]["start"], t2.iso(T0 - 40 * D))
        self.assertEqual(r["episodes"][0]["end"], t2.iso(T0 - 33 * D))


class Persistence(unittest.TestCase):
    def test_24_points_needed(self):
        T, E, O, C = hourly(0, 100 * H, [(10 * H, 33 * H)])  # 23 hours true
        self.assertFalse(any(t2.persist(T, E, O, C, 24)))
        T, E, O, C = hourly(0, 100 * H, [(10 * H, 34 * H)])  # 24 hours true
        f = t2.persist(T, E, O, C, 24)
        self.assertEqual([T[i] for i, x in enumerate(f) if x], [33 * H])  # fires at the 24th point only

    def test_gap_breaks_run(self):
        T, E, O, C = hourly(0, 100 * H, [(0, 100 * H)], observed_ranges=[(0, 20 * H), (21 * H, 100 * H)])
        f = t2.persist(T, E, O, C, 24)
        self.assertEqual(T[f.index(True)], 21 * H + 23 * H)

    def test_unobserved_jump_breaks_run(self):
        # daily points with a missing day: E capped by the hold, next point not contiguous
        T = [0, D, 2 * D, 4 * D, 5 * D]
        E = t2.ends_with_hold(T, t2.HOLD_DAILY)
        f = t2.persist(T, E, [True] * 5, [True] * 5, 3)
        self.assertEqual(f, [False, False, True, False, False])


class WarnedWindow(unittest.TestCase):
    def ev(self, a, b, start=None):
        start = T0 - 300 * D if start is None else start
        return t2.evaluate(*hourly(start, T0, [(a, b)]), 1, T0)

    def test_warned_inside(self):
        r = self.ev(T0 - 30 * D, T0 - 29 * D)
        self.assertTrue(r["warned9d"]); self.assertAlmostEqual(r["leadDays"], 30.0)
        self.assertEqual(r["calmEpisodeStarts"], 0)

    def test_starts_exactly_at_T0_minus_9d(self):
        r = self.ev(T0 - 9 * D, T0 - 8 * D)
        self.assertTrue(r["warned9d"]); self.assertAlmostEqual(r["leadDays"], 9.0)

    def test_late_fire(self):
        r = self.ev(T0 - 9 * D + H, T0 - 8 * D)
        self.assertFalse(r["warned9d"]); self.assertEqual(r["status"], "fired < 9 days before T0")
        self.assertAlmostEqual(r["leadDays"], 9 - 1 / 24, places=3)  # leadDays is rounded to 3 places

    def test_ends_exactly_at_window_start(self):
        r = self.ev(T0 - 70 * D, T0 - 60 * D)  # [s, e) with e == T0 - 60d: no intersection
        self.assertFalse(r["warned9d"]); self.assertIsNone(r["leadDays"]); self.assertEqual(r["status"], "did not fire")
        self.assertEqual(r["calmEpisodeStarts"], 1)

    def test_episode_from_calm_into_window(self):
        r = self.ev(T0 - 70 * D, T0 - 50 * D)
        self.assertTrue(r["warned9d"])
        self.assertAlmostEqual(r["leadDays"], 70.0)  # true start kept
        self.assertEqual(r["calmEpisodeStarts"], 1)  # and counted as a calm fire

    def test_post_T0_data_ignored(self):
        T, E, O, C = hourly(T0 - 100 * D, T0 + 10 * D, [(T0 + D, T0 + 2 * D)])
        r = t2.evaluate(T, E, O, C, 1, T0)
        self.assertEqual(r["episodes"], []); self.assertEqual(r["status"], "did not fire")


class CalmRate(unittest.TestCase):
    def test_ffr_two_per_half_year(self):
        start = T0 - 60 * D - int(2 * t2.QUARTER_DAYS * D)  # exactly 2 quarters of calm
        fires = [(start + 10 * D, start + 11 * D), (start + 100 * D, start + 101 * D)]
        r = t2.evaluate(*hourly(start, T0, fires), 1, T0)
        self.assertAlmostEqual(r["calmDays"], 2 * t2.QUARTER_DAYS, places=3)
        self.assertEqual(r["calmEpisodeStarts"], 2)
        self.assertAlmostEqual(r["falseFireRatePerQuarter"], 1.0, places=4)
        self.assertTrue(r["measurable"]); self.assertTrue(r["ffrOk"])

    def test_ffr_too_high(self):
        start = T0 - 60 * D - int(2 * t2.QUARTER_DAYS * D)
        fires = [(start + 10 * D, start + 11 * D), (start + 50 * D, start + 51 * D), (start + 100 * D, start + 101 * D)]
        r = t2.evaluate(*hourly(start, T0, fires), 1, T0)
        self.assertAlmostEqual(r["falseFireRatePerQuarter"], 1.5, places=4)
        self.assertFalse(r["ffrOk"])

    def test_not_measurable_under_28_days(self):
        r = t2.evaluate(*hourly(T0 - 60 * D - 27 * D, T0, []), 1, T0)
        self.assertAlmostEqual(r["calmDays"], 27.0); self.assertFalse(r["measurable"]); self.assertFalse(r["ffrOk"])
        r = t2.evaluate(*hourly(T0 - 60 * D - 28 * D, T0, []), 1, T0)
        self.assertTrue(r["measurable"]); self.assertEqual(r["falseFireRatePerQuarter"], 0.0)

    def test_unobserved_time_not_calm(self):
        start = T0 - 200 * D
        r = t2.evaluate(*hourly(start, T0, [], observed_ranges=[(start, start + 30 * D)]), 1, T0)
        self.assertAlmostEqual(r["calmDays"], 30.0)


class I2Reconstruction(unittest.TestCase):
    def test_replay_shares_and_condition(self):
        A, B_ = "0xaaa", "0xbbb"
        ev = [
            {"name": "Supply", "assets": "1000", "shares": "1000000000", "onBehalf": "0xs"},
            {"name": "Borrow", "assets": "300", "shares": "300000000", "onBehalf": A},
            {"name": "Borrow", "assets": "200", "shares": "200000000", "onBehalf": B_},
            {"name": "AccrueInterest", "interest": "50", "feeShares": "0"},
        ]
        m = t2.MarketReplay()
        for e in ev:
            m.apply(e)
        self.assertEqual((m.S, m.B, m.Bs), (1050, 550, 500000000))
        a, top = m.top1()
        self.assertEqual((a, top), (A, 300000000))
        # top share 60 %, debt = 0.6 x 550 = 330, free = 500 -> no fire
        self.assertFalse(t2.i2_condition(m.S, m.B, m.Bs, top))
        m.apply({"name": "Withdraw", "assets": "300", "shares": "1", "onBehalf": "0xs"})  # free = 200 < 330 -> fire
        self.assertTrue(t2.i2_condition(m.S, m.B, m.Bs, top))
        m.apply({"name": "Repay", "assets": "110", "shares": "100000000", "onBehalf": A})  # A: 200M of 400M = 50 %
        a, top = m.top1()
        self.assertEqual(m.Bs, 400000000)
        self.assertEqual(top, 200000000)
        self.assertTrue(2 * top >= m.Bs)  # exactly 50 % counts
        # liquidation with bad debt removes repaid + bad-debt shares from the borrower and the totals
        m.apply({"name": "Liquidate", "borrower": B_, "repaidAssets": "50", "repaidShares": "50000000",
                 "seizedAssets": "1", "badDebtAssets": "100", "badDebtShares": "150000000"})
        self.assertEqual(m.shares[B_], 0)
        self.assertEqual(m.Bs, 200000000)
        self.assertEqual(m.B, 440 - 50 - 100)
        self.assertEqual(m.S, 750 - 100)
        self.assertEqual(sum(m.shares.values()), m.Bs)

    def test_condition_edges(self):
        self.assertFalse(t2.i2_condition(100, 0, 0, 0))      # no borrow
        self.assertFalse(t2.i2_condition(100, 50, 100, 49))  # 49 % share
        self.assertTrue(t2.i2_condition(100, 90, 100, 50))   # 50 % share, debt 45 > free 10
        self.assertFalse(t2.i2_condition(200, 90, 100, 50))  # free 110 > debt 45

    def test_block_time_interp(self):
        rows = [{"block": 100, "ts": 1000}, {"block": 200, "ts": 2200}, {"block": 300, "ts": 3400}]
        f, info = t2.block_time_interp(rows)
        self.assertEqual(f(150), 1600)
        self.assertEqual(f(300), 3400)
        self.assertEqual(f(310), 3520)
        self.assertEqual(info["leaveOneOutMaxErrorMin"], 0.0)


class Hardcoded(unittest.TestCase):
    def test_fixed_price(self):
        f = t2.hardcoded_series([0], ["1"], True, False)
        self.assertTrue(f(-5))

    def test_unchanged_30_days_daily(self):
        T = [i * D for i in range(40)]
        V = ["1"] * 5 + ["2"] * 35
        f = t2.hardcoded_series(T, V, False, False)
        self.assertFalse(f(34 * D)); self.assertTrue(f(35 * D))

    def test_revert_breaks(self):
        T = [i * D for i in range(40)]
        V = ["2"] * 20 + [None] + ["2"] * 19
        f = t2.hardcoded_series(T, V, False, False)
        self.assertFalse(f(20 * D)); self.assertFalse(f(39 * D))

    def test_weekly_next_must_match(self):
        T = [i * 7 * D for i in range(8)]
        f2 = t2.hardcoded_series(T, ["1"] * 8, False, True)
        self.assertFalse(f2(29 * D))         # 29 d unchanged
        self.assertTrue(f2(30 * D))          # 30 d unchanged, next sample (35 d) identical
        self.assertTrue(f2(60 * D))          # after the last sample: no next sample to contradict

    def test_weekly_next_differs(self):
        T = [i * 7 * D for i in range(8)]
        V = ["1"] * 6 + ["2"] * 2
        f = t2.hardcoded_series(T, V, False, True)
        # at h in (35 d, 42 d) the latest sample is index 5 ("1") and the next (index 6) is "2": not known unchanged
        self.assertFalse(f(36 * D))


if __name__ == "__main__":
    unittest.main(verbosity=1)
