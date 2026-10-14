#!/usr/bin/env python3
"""Unit tests for bg_gradient.py on synthetic data only (no dataset read, no score).

  python3 -m unittest scripts/research/history-forecasts/test_bg_gradient.py -v
"""
import math
import os
import sys
import unittest
import warnings

import numpy as np
from scipy.special import expit, logit

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import a_touch as A  # noqa: E402
import b_behavior as B  # noqa: E402
import bg_gradient as G  # noqa: E402

warnings.filterwarnings("ignore", category=FutureWarning)

M = G.MICRO
USD1M = 1_000_000 * M
DAY = G.DAY
T0 = 1_700_006_400 - (1_700_006_400 % DAY)       # a 00:00Z


def make_ctx(n_days):
    c = G.Ctx()
    c.T = np.array([T0 + i * DAY for i in range(n_days)], dtype=np.int64)
    c.days = [G.ts_date(t) for t in c.T]
    c.D = n_days
    c.day_index = {s: i for i, s in enumerate(c.days)}
    c.eth = np.full(n_days, 2000.0)
    c.eth_prev = np.full(n_days, 2000.0)
    c.rv7 = np.full(n_days, 0.5)
    c.folds = []
    return c


def make_reserve(ctx, anchors, events, cash, supply=None, scale=1, name="USDC", is_usdt=0.0, last_ts=None):
    """anchors: (n_units, D) exact ints; events: list of (unit, ts, log_index, delta) with block = ts // 12."""
    R = G.Res()
    R.name, R.scale, R.is_usdt = name, scale, is_usdt
    n, D = len(anchors), ctx.D
    R.n = n
    R.addrs = [f"0x{i:040x}" for i in range(n)]
    R.meta = {a: {"in_P_r": True, "new": False} for a in R.addrs}
    A_ex = np.zeros((n, D + 2), dtype=np.int64 if scale == 1 else object)
    for i in range(n):
        for j in range(D):
            A_ex[i, j] = anchors[i][j]
    R.A_exact = A_ex
    R.A = G.to_micro(A_ex, scale)
    R.Av = np.ones((n, D + 2), bool)
    ev = sorted(events, key=lambda e: (e[0], e[1], e[2]))
    u = np.array([e[0] for e in ev], dtype=np.int64)
    ts = np.array([e[1] for e in ev], dtype=np.int64)
    li = np.array([e[2] for e in ev], dtype=np.int64)
    blk = ts // 12
    delta = np.array([e[3] for e in ev], dtype=np.int64 if scale == 1 else object)
    lkey = (u << 41) | (blk << 16) | li
    ls, ld = G.aggregate_sorted(lkey, delta)
    R.logs = {"unit": u[ls], "block": blk[ls], "ts": ts[ls], "delta": ld,
              "delta_f": ld.astype(float) if scale == 1 else np.array([float(x) for x in ld]) / scale}
    bkey = (u << 25) | blk
    bs, bd = G.aggregate_sorted(bkey, delta)
    R.blocks = {"unit": u[bs], "block": blk[bs], "ts": ts[bs], "delta": bd}
    R.last_ts = last_ts if last_ts is not None else int(ctx.T[-1] + 7 * DAY)
    R.paths = G.build_paths(R.blocks["unit"], R.blocks["ts"], R.blocks["delta"], R.A_exact[:, :D], R.Av[:, :D],
                            ctx.T, scale)
    R.widx = G.WindowIndex(R.paths)
    R.fb = G.own_flow_buckets(R.logs["unit"], R.logs["ts"], R.logs["delta_f"], n, ctx.T)
    st = {k: np.full(D + 2, np.nan) for k in ("listed", "util", "bapr", "sapr", "supply_f", "cash_f")}
    st["listed"][:] = 1.0
    st["util"][:] = 0.8
    st["bapr"][:] = 5.0
    st["cash"] = np.array(list(cash) + [cash[-1]] * 2, dtype=np.int64)
    sup = supply if supply is not None else [10 ** 9 * M] * D
    st["supply"] = np.array(list(sup) + [sup[-1]] * 2, dtype=np.int64)
    R.state = st
    return R


class TestPath(unittest.TestCase):
    def setUp(self):
        self.ctx = make_ctx(5)
        T = self.ctx.T
        # unit 0: anchor 10M on day 0; events day 0 at +1h (-3M), +2h (+1M); day 1 anchor 8.2M (interest), +30m -8M
        self.anch = [[10 * USD1M, 8 * USD1M + 200_000 * M, 200_000 * M, 200_000 * M, 200_000 * M]]
        self.ev = [(0, int(T[0]) + 3600, 1, -3 * USD1M), (0, int(T[0]) + 7200, 1, 1 * USD1M),
                   (0, int(T[1]) + 1800, 5, -8 * USD1M),
                   (0, int(T[4]) + 3 * DAY, 2, 5 * USD1M)]   # after the last daily snapshot
        self.R = make_reserve(self.ctx, self.anch, self.ev, cash=[10 ** 9 * M] * 5)

    def test_bal_is_anchor_plus_deltas_since_last_snapshot(self):
        R, T = self.R, self.ctx.T
        P = R.paths
        self.assertEqual(list(P["v"]), [7 * USD1M, 8 * USD1M, 200_000 * M, 5_200_000 * M])
        # day 1 path restarts from the day-1 anchor (8.2M), not from the day-0 path end (8M)
        self.assertEqual(G.bal_at(P, R.A, R.Av, T, 0, int(T[1]) + 1800), 200_000 * M)
        self.assertEqual(G.bal_at(P, R.A, R.Av, T, 0, int(T[1]) + 1799), 8 * USD1M + 200_000 * M)
        self.assertEqual(G.bal_at(P, R.A, R.Av, T, 0, int(T[0]) + 3600), 7 * USD1M)
        self.assertEqual(G.bal_at(P, R.A, R.Av, T, 0, int(T[0])), 10 * USD1M)
        # after the last daily snapshot the last anchor carries every later event
        self.assertEqual(G.bal_at(P, R.A, R.Av, T, 0, int(T[4]) + 4 * DAY), 5_200_000 * M)
        self.assertEqual(list(P["pday"]), [0, 0, 1, 4])

    def test_same_block_events_net_to_one_event_time(self):
        ctx = make_ctx(2)
        t = int(ctx.T[0]) + 600
        ev = [(0, t, 1, -5 * USD1M), (0, t, 2, 5 * USD1M)]   # withdraw and redeposit in one block
        R = make_reserve(ctx, [[6 * USD1M, 6 * USD1M]], ev, cash=[10 ** 9 * M] * 2)
        self.assertEqual(len(R.paths["v"]), 1)
        self.assertEqual(int(R.paths["v"][0]), 6 * USD1M)
        self.assertEqual(len(R.logs["ts"]), 2)       # two logs for the features

    def test_eighteen_decimal_paths_are_exact_then_floored(self):
        ctx = make_ctx(2)
        S = 10 ** 12
        a0 = 3 * USD1M * S + 999_999_999_999       # 3M tokens + just under one micro-unit
        ev = [(0, int(ctx.T[0]) + 100, 1, -(10 ** 24) - 1), (0, int(ctx.T[0]) + 200, 1, 10 ** 24 + 1)]
        R = make_reserve(ctx, [[a0, a0]], ev, cash=[10 ** 9 * M] * 2, scale=S)
        self.assertEqual(int(R.A[0, 0]), 3 * USD1M)
        v = [(a0 - 10 ** 24 - 1) // S, a0 // S]
        self.assertEqual(list(R.paths["v"]), v)

    def test_window_index_matches_brute_force(self):
        rng = np.random.default_rng(1)
        n = 3000
        unit = np.sort(rng.integers(0, 7, n))
        ts = np.zeros(n, dtype=np.int64)
        for u in range(7):
            m = unit == u
            ts[m] = np.sort(rng.choice(10 ** 6, m.sum(), replace=False))
        v = rng.integers(-10 ** 9, 10 ** 9, n)
        valid = rng.random(n) > 0.02
        W = G.WindowIndex({"unit": unit, "ts": ts, "v": v, "valid": valid})
        qu = rng.integers(0, 7, 500)
        lo = rng.integers(0, 10 ** 6, 500)
        hi = lo + rng.integers(0, 3 * 10 ** 5, 500)
        mn, has, ninv = W.query(qu, lo, hi)
        for i in range(500):
            m = (unit == qu[i]) & (ts > lo[i]) & (ts <= hi[i])
            self.assertEqual(bool(has[i]), bool(m.any()))
            self.assertEqual(int(ninv[i]), int((m & ~valid).sum()))
            if (m & valid).any():
                self.assertEqual(int(mn[i]), int(v[m & valid].min()))

    def test_gate_replica_on_synthetic_path(self):
        g = G.path_gate_check(self.ctx, self.R)
        self.assertEqual(g["pairs"], 4)
        self.assertEqual(g["pairs_with_event"], 2)
        # day 0: 10 - 3 + 1 = 8 vs anchor 8.2 -> diff $200k > tol 0.1% of peak 10M ($10k): fails
        self.assertAlmostEqual(g["share_pass_d2"], 3 / 4)


class TestLabels(unittest.TestCase):
    def build(self, ev_offsets, bal0=10 * USD1M, cash=10 ** 9 * M, last_ts=None, n_days=10, anchors=None):
        ctx = make_ctx(n_days)
        T = ctx.T
        ev = [(0, int(T[0]) + off, i, d) for i, (off, d) in enumerate(ev_offsets)]
        if anchors is None:
            # anchors consistent with the events (no interest)
            anchors = []
            b = bal0
            for d in range(n_days):
                anchors.append(b)
                b += sum(dd for off, dd in ev_offsets if T[0] + off >= T[d] and T[0] + off < T[d] + DAY)
        R = make_reserve(ctx, [anchors], ev, cash=[cash] * n_days, last_ts=last_ts)
        rows = G.build_rows_reserve(ctx, R, 0)
        return ctx, R, rows

    def y(self, rows, x, h, r=0):
        hi = G.HNAMES.index(h)
        if x == "all":
            return int(rows["Y"][r, G.ACELL[hi]])
        return int(rows["Y"][r, G.XCELL[hi, G.SIZES.index(x)]])

    def test_gradient_over_sizes_and_horizons(self):
        # bal 10M at t0; -1.5M at +30m (15%), -3.5M more at +3h (50% total), -2.5M at +20h (75%),
        # -1.5M at +30h (90%), deposit back at +50h
        ev = [(1800, -1_500_000 * M), (3 * 3600, -3_500_000 * M), (20 * 3600, -2_500_000 * M),
              (30 * 3600, -1_500_000 * M), (50 * 3600, 9 * USD1M)]
        ctx, R, rows = self.build(ev)
        r0 = int(np.nonzero(rows["t"] == 0)[0][0])
        exp = {"1h": {10: 1, 25: 0, 50: 0, 75: 0, 90: 0}, "6h": {10: 1, 25: 1, 50: 1, 75: 0, 90: 0},
               "24h": {10: 1, 25: 1, 50: 1, 75: 1, 90: 0}, "48h": {10: 1, 25: 1, 50: 1, 75: 1, 90: 1},
               "7d": {10: 1, 25: 1, 50: 1, 75: 1, 90: 1}}
        for h, d in exp.items():
            for x, v in d.items():
                self.assertEqual(self.y(rows, x, h, r0), v, f"x={x} h={h}")

    def test_window_is_open_at_t0_closed_at_t0_plus_h(self):
        ctx, R, rows = self.build([(3600, -6 * USD1M)])
        r0 = int(np.nonzero(rows["t"] == 0)[0][0])
        self.assertEqual(self.y(rows, 50, "1h", r0), 1)     # event exactly at t0 + 1h is inside (t0, t0 + h]
        ctx, R, rows = self.build([(3601, -6 * USD1M)])
        r0 = int(np.nonzero(rows["t"] == 0)[0][0])
        self.assertEqual(self.y(rows, 50, "1h", r0), 0)
        self.assertEqual(self.y(rows, 50, "6h", r0), 1)

    def test_exact_size_boundary(self):
        # drop of exactly 25% is y(25) = 1; one micro-unit less is 0
        ctx, R, rows = self.build([(60, -2_500_000 * M)])
        r0 = int(np.nonzero(rows["t"] == 0)[0][0])
        self.assertEqual(self.y(rows, 25, "1h", r0), 1)
        ctx, R, rows = self.build([(60, -2_500_000 * M + 1)])
        r0 = int(np.nonzero(rows["t"] == 0)[0][0])
        self.assertEqual(self.y(rows, 25, "1h", r0), 0)
        self.assertEqual(self.y(rows, 10, "1h", r0), 1)

    def test_no_event_no_drop_and_intraday_round_trip_counts(self):
        ctx, R, rows = self.build([(7200, -9 * USD1M), (7212, 9 * USD1M)])
        r0 = int(np.nonzero(rows["t"] == 0)[0][0])
        self.assertEqual(self.y(rows, 90, "6h", r0), 1)      # intraday exit then return is seen on the path
        self.assertEqual(self.y(rows, 90, "1h", r0), 0)      # no event in (t0, t0 + 1h]
        r1 = int(np.nonzero(rows["t"] == 1)[0][0])
        self.assertEqual(int(rows["Y"][r1].sum()), 0)        # day 1: no event at all

    def test_unlabelled_past_last_event_time(self):
        ctx = make_ctx(10)
        last = int(ctx.T[3]) + 2 * DAY
        ctx, R, rows = self.build([], last_ts=last)
        r3 = int(np.nonzero(rows["t"] == 3)[0][0])
        self.assertTrue(rows["RES"][r3, G.HNAMES.index("48h")])
        self.assertFalse(rows["RES"][r3, G.HNAMES.index("7d")])

    def test_liquidity_cap_exact(self):
        bal = np.array([10 * USD1M] * 3)
        cash = np.array([5 * USD1M, 5 * USD1M - 1, 10 * USD1M])
        self.assertEqual(list(G.capped(bal, cash, 50)), [False, True, False])
        self.assertEqual(list(G.capped(bal, cash, 90)), [True, True, False])
        ctx, R, rows = self.build([(60, -6 * USD1M)], cash=3 * USD1M)
        r0 = int(np.nonzero(rows["t"] == 0)[0][0])
        capx = [bool(rows["CAP"][r0, G.XCELL[0, i]]) for i in range(G.NX)]
        self.assertEqual(capx, [False, False, True, True, True])      # 30% of 10M available
        self.assertFalse(rows["CAP"][r0, G.ACELL].any())               # y_all is never capped

    def test_y_all_uses_min_of_balance_and_cash(self):
        # cash 4M < bal 10M: avail 4M; a 3.6M drop = 90% of avail -> 1; 3.5M -> 0
        ctx, R, rows = self.build([(60, -3_600_000 * M)], cash=4 * USD1M)
        r0 = int(np.nonzero(rows["t"] == 0)[0][0])
        self.assertEqual(self.y(rows, "all", "1h", r0), 1)
        self.assertTrue(rows["constrained"][r0])
        ctx, R, rows = self.build([(60, -3_500_000 * M)], cash=4 * USD1M)
        r0 = int(np.nonzero(rows["t"] == 0)[0][0])
        self.assertEqual(self.y(rows, "all", "1h", r0), 0)
        # unconstrained: avail = bal; needs a 90% drop
        ctx, R, rows = self.build([(60, -9 * USD1M)])
        r0 = int(np.nonzero(rows["t"] == 0)[0][0])
        self.assertEqual(self.y(rows, "all", "1h", r0), 1)
        self.assertFalse(rows["constrained"][r0])
        self.assertTrue(G.label_all([10], [1], [True], [10])[0])
        self.assertFalse(G.label_all([10], [2], [True], [10])[0])

    def test_rows_need_one_million(self):
        ctx, R, rows = self.build([], bal0=USD1M - 1)
        self.assertEqual(len(rows["t"]), 0)


class TestFeatures(unittest.TestCase):
    def test_own_flow_strictly_before_t0_and_bucket_equals_reference(self):
        ctx = make_ctx(60)
        T = ctx.T
        rng = np.random.default_rng(3)
        ev = []
        for k in range(300):
            ts = int(T[0]) - 20 * DAY + int(rng.integers(0, 80 * DAY))
            ev.append((0, ts - ts % 12 + 11, k, int(rng.integers(-5, 6)) * M))
        ev.append((0, int(T[30]) - 1, 999, -7 * M))              # one second before T[30]: inside
        R = make_reserve(ctx, [[5 * USD1M] * 60], ev, cash=[10 ** 9 * M] * 60)
        d = np.arange(1, 60)
        f7, c30, ds = G.own_flow_features(R.fb, np.zeros(len(d), dtype=np.int64), d, T)
        for i, dd in enumerate(d):
            ref = G.own_flow_at(R.logs["ts"], R.logs["delta_f"], R.logs["block"], int(T[dd]), (int(T[dd]) - 1) // 12)
            self.assertAlmostEqual(f7[i], ref[0])
            self.assertEqual(int(c30[i]), ref[1])
            self.assertAlmostEqual(ds[i], ref[2])
        i30 = list(d).index(30)
        self.assertAlmostEqual(ds[i30], 1 / DAY)

    def test_event_at_or_after_t0_is_not_a_feature(self):
        ctx = make_ctx(10)
        T = ctx.T
        R = make_reserve(ctx, [[5 * USD1M] * 10], [(0, int(T[5]), 1, -3 * M), (0, int(T[5]) + 5, 2, -4 * M)],
                         cash=[10 ** 9 * M] * 10)
        f7, c30, ds = G.own_flow_features(R.fb, np.array([0]), np.array([5]), T)
        self.assertEqual((f7[0], int(c30[0]), ds[0]), (0.0, 0, G.DAYS_SINCE_NONE))
        f7, c30, ds = G.own_flow_features(R.fb, np.array([0]), np.array([6]), T)
        self.assertEqual((f7[0], int(c30[0])), (-7.0 * M, 2))

    def test_v1_v2_feature_sets(self):
        self.assertEqual(G.FEATURES_V2[:8], B.FEATURES)
        self.assertEqual(G.NF, {"v1": 8, "v2": 13})
        ctx = make_ctx(40)
        T = ctx.T
        R = make_reserve(ctx, [[5 * USD1M] * 40], [(0, int(T[3]) + 100, 1, -2 * USD1M), (0, int(T[3]) + 200, 2,
                         2 * USD1M)], cash=[20 * USD1M] * 40, supply=[100 * USD1M] * 40, is_usdt=1.0)
        rows = G.build_rows_reserve(ctx, R, 0)
        r = int(np.nonzero(rows["t"] == 10)[0][0])
        X = rows["X"][r]
        self.assertAlmostEqual(X[5], math.log10(5e6))
        self.assertEqual(X[7], 1.0)
        self.assertAlmostEqual(X[8], math.log(4.0))           # ln(cash / bal)
        self.assertAlmostEqual(X[9], 0.05)                    # bal / supply
        self.assertAlmostEqual(X[10], 0.0)                    # day-3 flows are out of the 7-day window at day 10
        self.assertAlmostEqual(X[11], math.log1p(1))          # one decreasing log in 30 days
        self.assertAlmostEqual(X[12], math.log1p((T[10] - (T[3] + 100 - (T[3] + 100) % 12 + (T[3] + 100) % 12)) / DAY))
        self.assertFalse(rows["feat_ok"][rows["t"] == 0].any())   # no util(d - 1) on the first snapshot


class TestMonotone(unittest.TestCase):
    def test_matches_a_rule_without_caps(self):
        rng = np.random.default_rng(5)
        P = rng.random((50, G.NH, G.NX))
        cap = np.zeros((50, G.NX), bool)
        np.testing.assert_allclose(G.monotone_fix_masked(P, cap), A.monotone_fix(P))

    def test_capped_cells_left_out(self):
        rng = np.random.default_rng(6)
        P = rng.random((40, G.NH, G.NX))
        cap = np.zeros((40, G.NX), bool)
        k = rng.integers(1, G.NX + 1, 40)              # first capped x index (NX = none capped)
        for i in range(40):
            cap[i, k[i]:] = True
        F = G.monotone_fix_masked(P, cap)
        for i in range(40):
            kk = k[i]
            self.assertTrue(np.isnan(F[i][:, kk:]).all())
            np.testing.assert_allclose(F[i][:, :kk], A.monotone_fix(P[i][:, :kk]))
            P2 = P[i].copy()
            P2[:, kk:] = -5.0                          # capped values never enter the fix
            np.testing.assert_allclose(G.monotone_fix_masked(P2[None], cap[i:i + 1])[0][:, :kk], F[i][:, :kk])
        Fv = F[~np.isnan(F)]
        self.assertTrue(np.all(np.isfinite(Fv)))
        # non-increasing in x, non-decreasing in h on uncapped cells
        for i in range(40):
            g = F[i][:, :k[i]]
            self.assertTrue(np.all(np.diff(g, axis=1) <= 1e-15))
            self.assertTrue(np.all(np.diff(g, axis=0) >= -1e-15))


class TestModel(unittest.TestCase):
    def test_eb_theta_per_unit_and_prediction(self):
        rng = np.random.default_rng(7)
        n = 4000
        X = rng.normal(size=(n, 3))
        unit = rng.integers(0, 20, n)
        y = (rng.random(n) < expit(-2 + X[:, 0] + 0.15 * unit)).astype(float)
        m = G.fit_cell_model(X, y, unit, 25)
        p0 = expit(B.decision(m["fit"], X))
        for u in (0, 7, 19):
            O, E = y[unit == u].sum(), p0[unit == u].sum()
            self.assertAlmostEqual(m["theta"][u], (O + 3) / (E + 3))
        self.assertEqual(m["theta"][22], 1.0)                 # no training rows
        self.assertAlmostEqual(m["own"][22], y.mean())        # own baseline falls back to population
        self.assertAlmostEqual(m["own"][7], y[unit == 7].mean())
        Xt = rng.normal(size=(5, 3))
        ut = np.array([0, 7, 19, 22, 3])
        p, q0 = G.predict_p(m["params"], m["const_p0"], Xt, m["theta"][ut])
        z = B.decision(m["fit"], Xt)
        np.testing.assert_allclose(q0, expit(z))
        np.testing.assert_allclose(p, expit(logit(expit(z)) + np.log(m["theta"][ut])), rtol=1e-10)

    def test_single_class_training_set(self):
        X = np.zeros((10, 2))
        m = G.fit_cell_model(X, np.zeros(10), np.zeros(10, dtype=np.int64), 2)
        self.assertTrue(m["info"]["single_class"])
        p, p0 = G.predict_p(m["params"], m["const_p0"], X[:3], np.ones(3))
        self.assertEqual(list(p), [0.0] * 3)

    def test_purge(self):
        Tq = T0 + 100 * DAY
        T0s = np.array([Tq - 7 * DAY, Tq - 7 * DAY + 1, Tq - DAY, Tq - 3600, Tq])
        res = np.ones(5, bool)
        cap = np.zeros(5, bool)
        ok = np.ones(5, bool)
        self.assertEqual(list(G.train_mask_cell(T0s, 7 * DAY, Tq, res, cap, ok)), [True, False, False, False, False])
        self.assertEqual(list(G.train_mask_cell(T0s, 3600, Tq, res, cap, ok)), [True, True, True, True, False])
        cap[0] = True
        self.assertFalse(G.train_mask_cell(T0s, 7 * DAY, Tq, res, cap, ok)[0])


class TestBootstrapOrder(unittest.TestCase):
    def test_cell_order(self):
        ids = [c["id"] for c in G.CELLS]
        self.assertEqual(ids[:6], ["x10_1h", "x25_1h", "x50_1h", "x75_1h", "x90_1h", "x10_6h"])
        self.assertEqual(ids[24], "x90_7d")
        self.assertEqual(ids[25:], ["all_1h", "all_6h", "all_24h", "all_48h", "all_7d"])
        self.assertEqual(G.XCELL[2, 3], ids.index("x75_24h"))
        self.assertEqual(G.ACELL[4], ids.index("all_7d"))

    def test_one_stream_in_cell_order(self):
        ns = [100, 95, 120, 64]
        got = list(G.draw_cells(ns, seed=G.SEED_BLOCK, n_rep=50))
        rng = np.random.default_rng(20261022)
        for n, g in zip(ns, got):
            np.testing.assert_array_equal(g, B.block_bootstrap_indices(rng, n, 30, 50))
        self.assertEqual(G.SEED_BLOCK, 20261022)
        self.assertEqual(G.SEED_UNIT, 20261023)


class TestConfidence(unittest.TestCase):
    def test_episodes(self):
        unit = np.array([1, 1, 1, 1, 2, 2, 1])
        t = np.array([3, 4, 5, 7, 4, 5, 8])
        y = np.array([1, 1, 0, 1, 1, 1, 1])
        self.assertEqual(G.n_episodes(unit, t, y), 3)       # u1: {3,4}, {7,8}; u2: {4,5}
        self.assertEqual(G.n_episodes(unit, t, np.zeros(7)), 0)

    def test_ratio_and_deciles(self):
        self.assertEqual(G.ratio_R(2.0, 0), float("inf"))
        self.assertTrue(math.isnan(G.ratio_R(0.0, 0)))
        p = np.linspace(0.01, 0.2, 100)
        y = np.zeros(100)
        y[[0, 95, 96]] = 1
        lo, hi = G.decile_R(p, y)
        self.assertAlmostEqual(lo, p[:10].sum() / 1)
        self.assertAlmostEqual(hi, p[90:].sum() / 2)

    def test_fold_coverage_and_stale(self):
        cov, nq, nc = G.fold_coverage({"a": 1.0, "b": 2.0, "c": 0.7, "d": 5.0}, {"a": 20, "b": 30, "c": 25, "d": 19})
        self.assertEqual((nq, nc), (3, 2))
        self.assertAlmostEqual(cov, 2 / 3)
        self.assertEqual(G.fold_coverage({"a": 1.0}, {"a": 3})[0], None)
        self.assertTrue(G.is_stale(2.1, 20))
        self.assertFalse(G.is_stale(2.1, 19))
        self.assertFalse(G.is_stale(0.5, 50))

    def test_label_rule(self):
        base = dict(n_ep=250, R=1.0, R_ci=[0.9, 1.1], R_low=0.8, R_high=1.2, cov=0.9,
                    reserve_R={"USDC": 1.0, "USDT": 1.2}, stale=False)
        self.assertEqual(G.label_g7(**base)[0], "HIGH")
        for k, v in (("n_ep", 199), ("R", 1.26), ("R_ci", [0.66, 1.1]), ("R_low", 0.49), ("cov", 0.84),
                     ("reserve_R", {"USDC": 1.0, "USDT": 1.51}), ("R_high", float("inf"))):
            self.assertEqual(G.label_g7(**dict(base, **{k: v}))[0], "MEDIUM", k)
        self.assertEqual(G.label_g7(**dict(base, n_ep=49))[0], "LOW")
        self.assertEqual(G.label_g7(**dict(base, R=1.6, R_ci=[1.5, 1.7]))[0], "LOW")
        self.assertEqual(G.label_g7(**dict(base, cov=0.69))[0], "LOW")
        self.assertEqual(G.label_g7(**dict(base, cov=None))[0], "LOW")
        self.assertEqual(G.label_g7(**dict(base, stale=True))[0], "STALE")
        self.assertEqual(G.label_g7(**dict(base, R=0.8, R_ci=[0.67, 1.5], R_low=0.5, R_high=2.0, cov=0.85))[0],
                         "HIGH")

    def test_shipping_rule(self):
        f = {"v2_vs_own": True, "v2_vs_pop": True, "v2_vs_v1": True, "v1_vs_own": True, "v1_vs_pop": True}
        self.assertEqual(G.choose_shown(f), "v2")
        self.assertTrue(G.shippable("v2", f, "HIGH"))
        self.assertFalse(G.shippable("v2", f, "MEDIUM"))
        f2 = dict(f, v2_vs_v1=False)
        self.assertEqual(G.choose_shown(f2), "v1")
        self.assertTrue(G.shippable("v1", f2, "HIGH"))
        f3 = dict(f2, v1_vs_pop=False)
        self.assertEqual(G.choose_shown(f3), "v2")
        self.assertFalse(G.shippable("v2", f3, "HIGH"))
        f4 = dict(f, v2_vs_own=False)                      # v2 beats v1 but not own: nothing ships, v2 shown
        self.assertEqual(G.choose_shown(f4), "v2")
        self.assertFalse(G.shippable("v2", f4, "HIGH"))

    def test_blind_confirmation(self):
        self.assertEqual(G.blind_confirm("HIGH", 1.0, 50), ("HIGH", "confirmed"))
        self.assertEqual(G.blind_confirm("HIGH", 1.0, 49), ("MEDIUM", "unconfirmed"))
        self.assertEqual(G.blind_confirm("HIGH", 1.51, 80), ("MEDIUM", "failed blind"))
        self.assertEqual(G.blind_confirm("HIGH", 0.67, 80), ("HIGH", "confirmed"))
        self.assertEqual(G.blind_confirm("MEDIUM", 9.0, 0), ("MEDIUM", None))
        self.assertEqual(G.blind_confirm("LOW", 1.0, 100), ("LOW", None))


class TestScoringEndToEnd(unittest.TestCase):
    """A tiny synthetic score: capped cells stay out of every score and are reported with their realized rate."""

    def test_capped_rows_excluded_and_reported(self):
        rng = np.random.default_rng(11)
        ctx = make_ctx(200)
        ctx.folds = [("F1", 100, 150), ("F2", 150, 199)]
        n = 6000
        rows = {"t": rng.integers(0, 199, n), "unit": rng.integers(0, 30, n), "reserve": rng.integers(0, 2, n).astype(
            np.int8)}
        rows["T0"] = ctx.T[rows["t"]]
        rows["fold"] = np.where(rows["t"] >= 150, 1, np.where(rows["t"] >= 100, 0, -1)).astype(np.int16)
        rows["feat_ok"] = np.ones(n, bool)
        rows["RES"] = np.ones((n, G.NH), bool)
        rows["CAP"] = np.zeros((n, G.NC), bool)
        rows["CAP"][:, G.XCELL[:, 4]] = (rows["unit"] < 5)[:, None]
        rows["Y"] = (rng.random((n, G.NC)) < 0.2).astype(np.int8)
        rows["Y"][rows["unit"] < 5, :] = 1                      # capped units always 'exit'
        rows["constrained"] = rows["unit"] % 2 == 0
        rows["reserve_names"] = ["USDC", "USDT"]
        PR = {k: np.where((rows["fold"] >= 0)[:, None], 0.2, np.nan) * np.ones((n, G.NC)) for k in
              ("v1", "v2", "own", "pop")}
        PR["v2"] = PR["v2"] + 0.0
        for k in ("v1", "v2"):
            PR[k][:, G.XCELL[:, 4]] = np.where(rows["CAP"][:, G.XCELL[:, 4]], np.nan, PR[k][:, G.XCELL[:, 4]])
        out = G.score_cells(ctx, rows, PR, log=lambda *a: None)
        H = out["x90_1h"]
        test = rows["fold"] >= 0
        self.assertEqual(H["n"]["rows"], int((test & (rows["unit"] >= 5)).sum()))
        capm = test & (rows["unit"] < 5)
        self.assertEqual(H["capped"]["test_rows"]["n"], int(capm.sum()))
        self.assertEqual(H["capped"]["test_rows"]["realized_rate"], 1.0)
        self.assertIn("constrained_split", out["all_7d"])
        self.assertEqual(out["all_7d"]["constrained_split"]["constrained"]["n_rows"],
                         int((test & rows["constrained"]).sum()))
        self.assertIn(H["label"], ("HIGH", "MEDIUM", "LOW", "STALE"))


class TestFixAndHistory(unittest.TestCase):
    def test_apply_fix_on_rows(self):
        rng = np.random.default_rng(12)
        n = 30
        rows = {"CAP": np.zeros((n, G.NC), bool)}
        rows["CAP"][:10][:, G.XCELL[:, 3:].ravel()] = True        # rows 0-9 capped from x = 75%
        PR = {v: rng.random((n, G.NC)) for v in ("v1", "v2")}
        PR["v2"][25:] = np.nan                                    # rows without predictions stay NaN
        out = G.apply_fix(PR, rows)
        F = out["v2"]
        self.assertTrue(np.isnan(F[:10][:, G.XCELL[:, 3:]]).all())
        np.testing.assert_allclose(F[10:25][:, G.XCELL], A.monotone_fix(PR["v2"][10:25][:, G.XCELL]))
        np.testing.assert_allclose(F[:25][:, G.ACELL], PR["v2"][:25][:, G.ACELL])   # y_all untouched
        self.assertTrue(np.isnan(F[25:]).all())
        np.testing.assert_allclose(out["v2_raw"][:25], PR["v2"][:25])

    def test_g9_counts_episodes_and_ordinary_days(self):
        ctx = make_ctx(30)
        T = ctx.T
        # exits (>= 50% within 24 h) at day 5 and day 20; balance restored by the next anchor
        ev = [(0, int(T[5]) + 3600, 1, -6 * USD1M), (0, int(T[5]) + 7200, 2, 6 * USD1M),
              (0, int(T[20]) + 3600, 3, -6 * USD1M), (0, int(T[20]) + 7200, 4, 6 * USD1M)]
        R = make_reserve(ctx, [[10 * USD1M] * 30], ev, cash=[10 ** 9 * M] * 30, last_ts=int(T[-1]) + 7 * DAY)
        rows = G.build_rows(ctx, [R])
        rowmap = {0: np.arange(len(rows["t"]))}
        eps = {"E1": [{"s": 5, "e": 6, "start": ctx.days[5]}, {"s": 12, "e": 12, "start": ctx.days[12]}],
               "E2": [], "E3": [{"s": 20, "e": 20, "start": ctx.days[20]}]}
        in_ep = np.zeros(30, bool)
        in_ep[[5, 6, 12, 20]] = True
        recs = G.g9_unit(ctx, rows, rowmap, 0, eps, in_ep)
        get = {(r["cell"], r["type"]): r for r in recs}
        e1 = get[("x50_24h", "E1")]
        self.assertEqual((e1["k"], e1["n"], e1["exit_dates"]), (1, 2, [ctx.days[5]]))
        e3 = get[("x50_24h", "E3")]
        self.assertEqual((e3["k"], e3["n"]), (1, 1))
        al = get[("x50_24h", "all")]
        self.assertEqual((al["k"], al["n"]), (2, 30))
        od = get[("x50_24h", "ordinary")]
        self.assertEqual((od["k"], od["n"]), (0, 26))
        self.assertIsNotNone(e1["fisher_p"])
        self.assertEqual(get[("x50_1h", "all")]["k"], 2)         # the drop lands exactly at t0 + 1h
        self.assertIn("on 2 of 30 days since", G.g9_statement(G.CELLS[G.XCELL[2, 2]], al))


if __name__ == "__main__":
    unittest.main()
