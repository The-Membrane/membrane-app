#!/usr/bin/env python3
"""Unit tests for b_behavior.py on synthetic data only (no dataset read, no score).

  python3 -m unittest scripts/research/history-forecasts/test_b_behavior.py -v
"""
import math
import os
import sys
import unittest
import warnings

import numpy as np
from scipy.special import expit, logit

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import b_behavior as B  # noqa: E402

warnings.filterwarnings("ignore", category=FutureWarning)

M = B.USD_RAW  # 1 USD in raw units


class TestExitDefinition(unittest.TestCase):
    def test_exactly_half_is_an_exit(self):
        self.assertTrue(B.is_exit(2_000_000 * M, 1_000_000 * M))
        self.assertFalse(B.is_exit(2_000_000 * M, 1_000_000 * M + 1))

    def test_requires_one_million(self):
        self.assertTrue(B.is_exit(1_000_000 * M, 500_000 * M))
        self.assertFalse(B.is_exit(1_000_000 * M - 1, 0))

    def test_odd_raw_balance_exact(self):
        # bal = 2,000,001 raw-millions + 1 raw: half is not an integer; min = floor(half) is an exit, +1 is not
        bal = 2_000_000 * M + 1
        self.assertTrue(B.is_exit(bal, bal // 2))
        self.assertFalse(B.is_exit(bal, bal // 2 + 1))

    def test_window_min_over_h_days_and_end_of_data(self):
        raw = np.array([[10, 9, 8, 3, 7, 6]], dtype=np.int64) * M * 1_000_000
        valid = np.ones_like(raw, dtype=bool)
        m1, ok1 = B.window_min(raw, valid, 1)
        m3, ok3 = B.window_min(raw, valid, 3)
        self.assertEqual(list(m1[0, :5] // (M * 1_000_000)), [9, 8, 3, 7, 6])
        self.assertEqual(list(ok1[0]), [True] * 5 + [False])
        self.assertEqual(list(m3[0, :3] // (M * 1_000_000)), [3, 3, 3])
        self.assertEqual(list(ok3[0]), [True] * 3 + [False] * 3)
        # exit within 3 days at t=0: min(9,8,3)=3 <= 5 -> exit; within 1 day: 9 > 5 -> no exit
        self.assertTrue(B.is_exit(raw[0, 0], m3[0, 0]))
        self.assertFalse(B.is_exit(raw[0, 0], m1[0, 0]))
        # t=1 (bal 9): 72 h min(8,3,7)=3 <= 4.5 -> exit; t=2 (bal 8): 24 h 3 <= 4 -> exit
        self.assertTrue(B.is_exit(raw[0, 1], m3[0, 1]))
        self.assertTrue(B.is_exit(raw[0, 2], m1[0, 2]))

    def test_window_with_invalid_entry_unresolved(self):
        raw = np.array([[5, 5, 5, 5]], dtype=np.int64) * M * 1_000_000
        valid = np.array([[True, True, False, True]])
        _, ok = B.window_min(raw, valid, 3)
        self.assertFalse(ok[0, 0])
        _, ok1 = B.window_min(raw, valid, 1)
        self.assertEqual(list(ok1[0]), [True, False, True, False])


class TestEpisodes(unittest.TestCase):
    def test_merge_gap_two_days(self):
        self.assertEqual(B.merge_episodes([0, 1, 4, 8, 9, 13]), [(0, 4, 3), (8, 9, 2), (13, 13, 1)])
        self.assertEqual(B.merge_episodes([0, 3]), [(0, 3, 2)])     # 2 non-stress days -> merge
        self.assertEqual(B.merge_episodes([0, 4]), [(0, 0, 1), (4, 4, 1)])  # 3 -> split
        self.assertEqual(B.merge_episodes([5, 5, 2]), [(2, 5, 2)])
        self.assertEqual(B.merge_episodes([]), [])

    def test_e2_return_definition(self):
        eth_prev = np.array([100.0, 100.0, 100.0, 100.0, 100.0])
        eth = np.array([100 * math.exp(0.0801), 100 * math.exp(-0.0801), 100 * math.exp(0.0799),
                        100 * math.exp(-0.0799), np.nan])
        lr = B.e2_logret(eth, eth_prev)
        self.assertAlmostEqual(lr[0], 0.0801, places=12)
        self.assertAlmostEqual(lr[1], 0.0801, places=12)
        days = [f"2024-01-0{i + 1}" for i in range(5)]
        state = {"bapr": np.array([9.99, 10.0, 12.0, np.nan, 3.0, 99.0])}  # length D + 1 (asof last)
        sd = B.stress_days(state, eth, eth_prev, days, ["2024-01-05", "2023-12-31"])
        self.assertEqual(sd["E2"], [0, 1])          # |ln| >= 0.08 both signs; nan day not stress
        self.assertEqual(sd["E1"], [1, 2])          # bAPR >= 10 on daily snapshots only (asof excluded)
        self.assertEqual(sd["E3"], [4])             # onsets outside the daily range dropped

    def test_episode_response(self):
        raw = np.array([2_000_000, 1_500_000, 1_000_000, 0, 999_999, 0, 0], dtype=np.int64) * M
        valid = np.ones(7, bool)
        self.assertEqual(B.episode_response(raw, valid, 0, 6), (True, True, True))
        raw2 = raw.copy()
        raw2[2] += 1
        self.assertEqual(B.episode_response(raw2, valid, 0, 6), (True, True, False))
        self.assertEqual(B.episode_response(raw, valid, 4, 6), (False, False, False))   # bal(s) < $1M
        self.assertEqual(B.episode_response(raw, valid, 0, 1), (True, False, False))    # s + 2 past data end
        v2 = valid.copy()
        v2[1] = False
        self.assertEqual(B.episode_response(raw, v2, 0, 6), (True, False, False))

    def test_trigger_lowest_util_among_e1_e2_exits(self):
        rows = [
            {"type": "E1", "counted": True, "exit": True, "util_s": 0.80, "start": "2024-01-01"},
            {"type": "E2", "counted": True, "exit": True, "util_s": 0.70, "start": "2024-02-01"},
            {"type": "E3", "counted": True, "exit": True, "util_s": 0.50, "start": "2024-03-01"},
            {"type": "E1", "counted": True, "exit": False, "util_s": 0.60, "start": "2024-04-01"},
            {"type": "E2", "counted": False, "exit": False, "util_s": 0.40, "start": "2024-05-01"},
        ]
        best, text = B.exit_trigger(rows)
        self.assertEqual(best["util_s"], 0.70)
        self.assertEqual(best["type"], "E2")
        none = [dict(r, exit=False) for r in rows]
        best, text = B.exit_trigger(none)
        self.assertIsNone(best)
        self.assertEqual(text, "no exit in 3 episodes")


class TestIfItLeft(unittest.TestCase):
    curve = {"opt": 0.94, "base": 0.0, "slope1": 0.044, "slope2": 0.10}

    def test_kinked_curve(self):
        c = self.curve
        self.assertAlmostEqual(B.borrow_rate_curve(0.47, c["opt"], c["base"], c["slope1"], c["slope2"]), 0.022)
        self.assertAlmostEqual(B.borrow_rate_curve(0.94, c["opt"], c["base"], c["slope1"], c["slope2"]), 0.044)
        self.assertAlmostEqual(B.borrow_rate_curve(0.97, c["opt"], c["base"], c["slope1"], c["slope2"]), 0.094)
        self.assertAlmostEqual(B.borrow_rate_curve(0.5, 0.8, 0.01, 0.04, 0.6), 0.01 + 0.04 * 0.5 / 0.8)

    def test_bal_larger_than_cash(self):
        out = B.if_it_left(100.0, 60.0, 1000.0, 900.0, self.curve, 0.10)
        self.assertEqual(out["x"], 60.0)
        self.assertEqual(out["supply_after"], 940.0)
        self.assertEqual(out["cash_after"], 0.0)
        u = 900.0 / 940.0
        self.assertAlmostEqual(out["util_after"], u)
        b = 0.044 + 0.10 * (u - 0.94) / 0.06
        self.assertAlmostEqual(out["bapr_after_pct"], 100 * b)
        self.assertAlmostEqual(out["sapr_after_pct"], 100 * b * u * 0.9)
        self.assertEqual(out["stuck"], 40.0)

    def test_bal_smaller_than_cash(self):
        out = B.if_it_left(20.0, 60.0, 1000.0, 500.0, self.curve, 0.10)
        self.assertEqual(out["x"], 20.0)
        self.assertEqual(out["stuck"], 0.0)
        u = 500.0 / 980.0
        self.assertAlmostEqual(out["bapr_after_pct"], 100 * 0.044 * u / 0.94)


class TestFoldsAndPurge(unittest.TestCase):
    def test_purge(self):
        t = np.array([96, 97, 98, 99, 100, 101])
        self.assertEqual(list(B.train_mask(t, 3, 100)), [True, True, False, False, False, False])
        self.assertEqual(list(B.train_mask(t, 1, 100)), [True, True, True, True, False, False])
        self.assertEqual(list(B.test_mask(t, 99, 101)), [False, False, False, True, True, False])

    def test_fold_list(self):
        f = B.fold_list()
        self.assertEqual(len(f), 12)
        self.assertEqual(f[0], ("2023Q4", "2023-10-01", "2024-01-01"))
        self.assertEqual(f[-1], ("2026Q3", "2026-07-01", "2026-10-01"))


class TestPooling(unittest.TestCase):
    def test_eb_theta(self):
        self.assertAlmostEqual(float(B.eb_theta(2, 1)), 5 / 4)
        self.assertAlmostEqual(float(B.eb_theta(0, 0)), 1.0)
        self.assertAlmostEqual(float(B.eb_theta(0, 7)), 3 / 10)

    def test_own_rate_fallback(self):
        o = B.own_rate(np.array([1, 0, 0]), np.array([4, 5, 0]), 0.07)
        self.assertEqual(list(o), [0.25, 0.0, 0.07])

    def test_fit_unit_model_theta_and_prediction(self):
        rng = np.random.default_rng(0)
        n = 4000
        X = rng.normal(size=(n, 8))
        X[:, 7] = (rng.random(n) < 0.5).astype(float)
        z = -3 + 0.8 * X[:, 0]
        y = (rng.random(n) < expit(z)).astype(np.int8)
        unit = rng.integers(0, 50, size=n)       # units 0..49 have rows; unit 50 has none
        bal = np.full(n, 4_000_000 * M, dtype=np.int64)
        mn = np.where(y == 1, 1_000_000 * M, 4_000_000 * M).astype(np.int64)
        rows = {"X": X, "y1": y, "unit": unit, "bal_raw": bal, "min1": mn}
        tr = np.ones(n, bool)
        model = B.fit_unit_model(rows, tr, 1, 51)
        p0 = expit(B.decision(model["fit"], X))
        O = np.bincount(unit, weights=y, minlength=51)
        E = np.bincount(unit, weights=p0, minlength=51)
        np.testing.assert_allclose(model["theta"], (O + 3) / (E + 3))
        self.assertEqual(model["theta"][50], 1.0)
        self.assertAlmostEqual(model["pop"], y.mean())
        self.assertEqual(model["own"][50], model["pop"])
        self.assertAlmostEqual(model["fbar"], 0.75)
        Xt = X[:5]
        ut = np.array([3, 50, 7, 7, 0])
        pm, pp0, po, ppop = B.predict_unit_model(model, Xt, ut)
        np.testing.assert_allclose(logit(pm), logit(pp0) + np.log(model["theta"][ut]), rtol=1e-9, atol=1e-9)
        self.assertAlmostEqual(pm[1], pp0[1])
        np.testing.assert_allclose(po, model["own"][ut])
        np.testing.assert_allclose(ppop, model["pop"])
        # standardization uses the training mean and population std
        np.testing.assert_allclose(model["fit"]["mu"], X.mean(0))
        np.testing.assert_allclose(model["fit"]["sd"], X.std(0))


class TestBootstrap(unittest.TestCase):
    def test_shape_and_blocks(self):
        rng = np.random.default_rng(1)
        idx = B.block_bootstrap_indices(rng, 95, 30, 2000)
        self.assertEqual(idx.shape, (2000, 95))
        self.assertTrue(idx.min() >= 0 and idx.max() <= 94)
        # first block of every replicate is 30 consecutive days starting in 0..65
        d = np.diff(idx[:, :30], axis=1)
        self.assertTrue((d == 1).all())
        self.assertTrue(idx[:, 0].max() <= 65)
        # 4 blocks drawn, the last truncated to 5 days
        self.assertTrue((np.diff(idx[:, 90:95], axis=1) == 1).all())

    def test_draw_order_24h_then_72h(self):
        got = B.draw_days({1: 100, 3: 97})
        rb, ri = np.random.default_rng(20261015), np.random.default_rng(20261016)
        b24 = B.block_bootstrap_indices(rb, 100, 30, 2000)
        b72 = B.block_bootstrap_indices(rb, 97, 30, 2000)
        i24 = B.block_bootstrap_indices(ri, 100, 1, 2000)
        i72 = B.block_bootstrap_indices(ri, 97, 1, 2000)
        np.testing.assert_array_equal(got[1][0], b24)
        np.testing.assert_array_equal(got[3][0], b72)
        np.testing.assert_array_equal(got[1][1], i24)
        np.testing.assert_array_equal(got[3][1], i72)
        # the 24 h block draw is one integers call of shape (2000, ceil(100/30))
        r = np.random.default_rng(20261015)
        starts = r.integers(0, 71, size=(2000, 4))
        np.testing.assert_array_equal(got[1][0][:, 0], starts[:, 0])
        np.testing.assert_array_equal(got[1][0][:, 30], starts[:, 1])

    def test_bss_stats(self):
        rng = np.random.default_rng(2)
        nd = 60
        pos = np.repeat(np.arange(nd), 5)
        y = (rng.random(len(pos)) < 0.2).astype(float)
        pb = np.full(len(y), 0.2)
        cb = B.replicate_counts(B.block_bootstrap_indices(rng, nd, 30, 200), nd)
        ci = B.replicate_counts(B.block_bootstrap_indices(rng, nd, 1, 200), nd)
        s = B.bss_stats(pos, nd, y, pb, y, cb, ci)
        self.assertAlmostEqual(s["bss"], 1.0)
        self.assertTrue(s["ci_above_0"])
        s0 = B.bss_stats(pos, nd, pb, pb, y, cb, ci)
        self.assertAlmostEqual(s0["bss"], 0.0)
        self.assertFalse(s0["ci_above_0"])


class TestMisc(unittest.TestCase):
    def test_checksum(self):
        self.assertEqual(B.to_checksum("0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2"),
                         "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2")
        self.assertEqual(B.trunc("0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2"), "0x8787…A4E2")

    def test_eth_and_rv7_indexing(self):
        start = 1_000_000 * 3600
        o = np.exp(np.arange(400) * 0.01)          # constant 1% hourly log return
        T = start + 3600 * 200
        self.assertAlmostEqual(B.eth_at(start, o, T), o[199])
        self.assertAlmostEqual(B.rv7_at(start, o, T), math.sqrt(8760 * 1e-4))
        o2 = o.copy()
        o2[199 - 168] = np.nan                     # first close of the 169 used
        self.assertTrue(np.isnan(B.rv7_at(start, o2, T)))
        o3 = o.copy()
        o3[199 - 169] = np.nan                     # outside the window
        self.assertFalse(np.isnan(B.rv7_at(start, o3, T)))

    def test_pb_exceed(self):
        rng = np.random.default_rng(3)
        q, e = B.pb_exceed(rng, np.zeros(4), np.ones(4), 1.0)
        self.assertEqual(q, 0.0)
        self.assertTrue(e)
        q, e = B.pb_exceed(rng, np.ones(4), np.array([1.0, 2.0, 3.0, 4.0]), 10.0)
        self.assertEqual(q, 10.0)
        self.assertFalse(e)

    def test_reliability_equal_mass(self):
        p = np.linspace(0, 1, 105)
        rel = B.reliability(p, (p > 0.5).astype(float))
        self.assertEqual(len(rel), 10)
        self.assertEqual(sum(r["n"] for r in rel), 105)
        self.assertTrue(max(r["n"] for r in rel) - min(r["n"] for r in rel) <= 1)


def make_synthetic(seed=7, n_addr=40):
    """A fake Data object in the loader's layout (2023-02-01..2026-10-07 + asof), no dataset read."""
    rng = np.random.default_rng(seed)
    d = B.Data()
    t_first = B.day_ts("2023-02-01")
    d.D = B.day_ts("2026-10-07") // 86400 - t_first // 86400 + 1
    D = d.D
    d.T = np.array([t_first + 86400 * i for i in range(D)], dtype=np.int64)
    d.days = [B.ts_date(t) for t in d.T]
    d.day_index = {s: i for i, s in enumerate(d.days)}
    d.blocks = list(range(D))
    d.asof = {"block": 1, "block_ts": int(d.T[-1]) + 6 * 86400 + 3600, "block_utc": "x"}
    d.state, d.curve_abi, d.res, d.population, d.monthly = {}, {}, {}, {}, {}
    for ri, r in enumerate(B.RESERVES):
        listed = np.ones(D + 1)
        if r == "USDT":
            listed[:13] = 0
        util = np.clip(0.8 + 0.1 * np.sin(np.arange(D + 1) / 40) + rng.normal(0, 0.01, D + 1), 0.3, 0.99)
        bapr = np.where(util < 0.9, 4.0 * util / 0.9, 4.0 + 60 * (util - 0.9))
        supply = np.full(D + 1, 1e9)
        st = {"listed": listed, "supply": supply, "debt": util * supply, "cash": (1 - util) * supply,
              "util": util, "bapr": bapr, "sapr": bapr * util * 0.9, "rf": np.full(D + 1, 0.1),
              "opt": np.full(D + 1, 0.9), "base": np.zeros(D + 1), "slope1": np.full(D + 1, 0.04),
              "slope2": np.full(D + 1, 0.6), "has_curve": listed.copy()}
        for k in st:
            if k not in ("listed",):
                st[k] = np.where(listed == 1, st[k], np.nan) if k != "has_curve" else np.where(listed == 1, 1.0, 0.0)
        d.state[r] = st
        d.curve_abi[r] = ["v1" if l else "not_listed" for l in listed]
        addrs = sorted(f"0x{rng.integers(0, 2**63):016x}{'0' * 24}"[:42] for _ in range(n_addr))
        raw = np.zeros((n_addr, D + 1), dtype=np.int64)
        valid = np.ones((n_addr, D + 1), bool)
        for i in range(n_addr):
            b = rng.uniform(0.5e6, 3e7)
            for t in range(D + 1):
                u = rng.random()
                if u < 0.03 + 0.05 * (util[t] > 0.88):
                    b *= rng.uniform(0.0, 0.45)
                elif u < 0.10:
                    b += rng.uniform(1e6, 2e7)
                raw[i, t] = int(b * B.USD_RAW)
        if r == "USDT":
            valid[:, :13] = False
            raw[:, :13] = 0
        d.res[r] = {"addrs": addrs, "raw": raw, "valid": valid, "status_counts": {"": 1},
                    "aidx": {a: i for i, a in enumerate(addrs)}}
        mx = {a: int(raw[i, ::30].max()) for i, a in enumerate(addrs)}
        d.population[r] = {a: {"rule": "balance", "max_monthly_raw": mx[a]} for a in addrs}
        d.monthly[r] = {"max": mx, "n_snapshots": 45, "status_counts": {"ok": 1}}
    d.eth_start = int(d.T[0]) - 400 * 3600
    n_h = 400 + 24 * (D - 1) + 2
    d.oracle = 2000 * np.exp(np.cumsum(rng.normal(0, 0.012, n_h)))
    d.eth = np.array([B.eth_at(d.eth_start, d.oracle, int(T)) for T in d.T])
    d.eth_prev = np.array([B.eth_at(d.eth_start, d.oracle, int(T) - 86400) for T in d.T])
    d.rv7 = np.array([B.rv7_at(d.eth_start, d.oracle, int(T)) for T in d.T])
    d.spike_onsets = ["2023-03-11", "2024-10-08"]
    d.load_s = 0.0
    return d


class TestEndToEndSynthetic(unittest.TestCase):
    def test_dryrun_then_run_once(self):
        import json
        import tempfile
        d = make_synthetic()
        wd = {}
        with tempfile.TemporaryDirectory() as out:
            dr = B.dryrun_on(d, {"x": "y"}, out, 0.0, log=lambda *a: None)
            txt = json.dumps({k: v for k, v in dr.items() if k != "note"}).lower()
            for banned in ("exit", "brier", "bss", "auc", "y_mean", "pop_rate", "f_bar"):
                self.assertNotIn(banned, txt)    # the dry run carries no outcome
            self.assertEqual(len(dr["folds"]), 12)
            res = B.run_on(d, wd, {"x": "y"}, out, 0.0, log=lambda *a: None)
            for f in ("results.json", "predictions-test.csv.gz", "b1-top-depositors.csv", "b1-episodes.csv",
                      "venue-view.json"):
                self.assertTrue(os.path.exists(os.path.join(out, f)), f)
            self.assertIn(res["b2"]["verdict"], ("PASS", "FAIL"))
            self.assertEqual(len(res["b1"]["top20"]["USDC"]), 20)
            for h in ("24h", "72h"):
                H = res["b2"]["horizons"][h]
                self.assertEqual(len(H["per_fold"]), 12)
                self.assertIsNotNone(H["bss"]["model_vs_own"]["ci95"])
            with self.assertRaises(SystemExit):
                B.run_on(d, wd, {"x": "y"}, out, 0.0, log=lambda *a: None)
            B.phase_manifest(out, log=lambda *a: None)
            self.assertTrue(os.path.exists(os.path.join(out, "manifest.json")))


if __name__ == "__main__":
    unittest.main()
