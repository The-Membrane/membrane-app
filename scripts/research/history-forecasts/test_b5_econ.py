#!/usr/bin/env python3
"""Tests for b5_econ.py (Q26 round 7 R7.3, economic-exit target).

Synthetic tests read no dataset and score nothing:
  python3 -m unittest scripts/research/history-forecasts/test_b5_econ.py -v
With B5_OUT=<run dir> the recorded checks of results-b5.json are asserted (B4 reproduction: v2, v4a and v4b on the
old target equal B4's pooled Brier exactly and the published USDC predictions; label sanity).
With B5_DATA_TESTS=1 and B5_DEBT_DIR=<debt dir> a real-data look-ahead test runs on USDC (debt events after a cut
never change y_econ of windows that end by the cut, nor the v4ae features of origins at or before it).
"""
import json
import os
import sys
import unittest
import warnings

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import b5_econ as E  # noqa: E402
import bg_gradient as G  # noqa: E402

warnings.filterwarnings("ignore", category=FutureWarning)
M = G.MICRO
DAY = 86400
HERE = os.path.dirname(os.path.abspath(__file__))
DDIR = os.environ.get("MEMBRANE_DATASETS_DIR") or os.path.join(HERE, "..", "..", "..", "..", "membrane-datasets")


def synth(n_units=3, D=6, seed=0, n_ev=40, n_debt=30):
    """Random anchors (consistent with events), aToken events and debt flows on a daily grid."""
    rng = np.random.default_rng(seed)
    T = np.arange(D, dtype=np.int64) * DAY + 1_700_000_000
    ev = []
    for u in range(n_units):
        grid = np.arange(T[0] + 1, T[-1] + DAY)
        grid = grid[(grid - T[0]) % DAY != 0]                       # no event exactly at an anchor time
        ts = np.sort(rng.choice(grid, n_ev, replace=False))
        for t in ts:
            ev.append((u, int(t), int(rng.integers(-40, 30)) * M))
    ev.sort()
    A = np.zeros((n_units, D), dtype=np.int64)
    for u in range(n_units):
        b = 200 * M
        for d in range(D):
            A[u, d] = b
            b += sum(x for uu, t, x in ev if uu == u and T[d] < t <= T[d] + DAY)
    Av = np.ones((n_units, D), bool)
    unit = np.array([e[0] for e in ev])
    ts = np.array([e[1] for e in ev])
    delta = np.array([e[2] for e in ev], dtype=np.int64)
    paths = G.build_paths(unit, ts, delta, A, Av, T)
    dts = np.sort(rng.choice(np.arange(T[0] + 1, T[-1] + DAY), n_debt, replace=False))
    du = rng.integers(0, n_units, n_debt)
    dusd = rng.integers(-30, 50, n_debt) * M
    o = np.lexsort((dts, du))
    debt = {"unit": du[o].astype(np.int64), "ts": dts[o].astype(np.int64), "usd": dusd[o].astype(np.int64)}
    return T, A, Av, paths, debt, (unit, ts, delta)


def brute(T, A, paths, debt, u, d, hsec, x):
    """Reference y_econ: Q(t) = bal0 - bal(t) + N(t) - N(t0) over event times t in (t0, t0 + h]."""
    T0 = int(T[d])
    bal0 = int(A[u, d])
    Av = np.ones_like(A, bool)

    def N(t):
        m = (debt["unit"] == u) & (debt["ts"] <= t)
        return int(debt["usd"][m].sum())
    times = set(int(t) for t in paths["ts"][(paths["unit"] == u)]) | set(int(t) for t in debt["ts"][debt["unit"] == u])
    times = sorted(t for t in times if T0 < t <= T0 + hsec)
    best = None
    for t in times:
        q = bal0 - G.bal_at(paths, A, Av, T, u, t) + N(t) - N(T0)
        best = q if best is None else max(best, q)
    return best is not None and 100 * best >= x * bal0


class TestEconLabel(unittest.TestCase):
    def test_matches_brute_force(self):
        for seed in range(6):
            T, A, Av, paths, debt, _ = synth(seed=seed)
            ei = E.EconIndex(paths, debt, A, Av, T)
            for hs in (3600, 6 * 3600, DAY, 2 * DAY):
                for u in range(A.shape[0]):
                    for d in range(A.shape[1]):
                        ys, has, ninv = ei.label([u], [T[d]], hs, [A[u, d]], G.SIZES)
                        for x in G.SIZES:
                            self.assertEqual(bool(ys[x][0]), brute(T, A, paths, debt, u, d, hs, x),
                                             (seed, hs, u, d, x))

    def test_no_debt_equals_old_target(self):
        for seed in range(4):
            T, A, Av, paths, _, _ = synth(seed=seed)
            empty = {"unit": np.zeros(0, np.int64), "ts": np.zeros(0, np.int64), "usd": np.zeros(0, np.int64)}
            ei = E.EconIndex(paths, empty, A, Av, T)
            widx = G.WindowIndex(paths)
            u, d = np.meshgrid(np.arange(A.shape[0]), np.arange(A.shape[1]), indexing="ij")
            u, d = u.ravel(), d.ravel()
            for hs in G.HSEC:
                mn, has, ninv = widx.query(u, T[d], T[d] + hs)
                ys, _, _ = ei.label(u, T[d], hs, A[u, d], G.SIZES)
                for x in G.SIZES:
                    old = G.label_x(A[u, d], np.where(has, mn, A[u, d]), has & (ninv == 0), x)
                    self.assertTrue((old == ys[x]).all(), (seed, hs, x))

    def test_cases(self):
        T = np.arange(4, dtype=np.int64) * DAY
        A = np.full((1, 4), 100 * M, dtype=np.int64)
        Av = np.ones((1, 4), bool)
        nopath = G.build_paths(np.zeros(0, np.int64), np.zeros(0, np.int64), np.zeros(0, np.int64), A, Av, T)

        def lab(debt_ts, debt_usd, h=DAY, x=50, paths=nopath, d=0, Avv=Av):
            debt = {"unit": np.zeros(len(debt_ts), np.int64), "ts": np.array(debt_ts, np.int64),
                    "usd": np.array(debt_usd, np.int64) * M}
            ys, has, ninv = E.EconIndex(paths, debt, A, Avv, T).label([0], [T[d]], h, [A[0, d]], [x])
            return bool(ys[x][0]), int(ninv[0])
        self.assertEqual(lab([100], [50]), (True, 0))                 # borrowing half the balance is an exit
        self.assertEqual(lab([100], [49]), (False, 0))
        self.assertEqual(lab([100, 200], [30, 20]), (True, 0))        # cumulative
        self.assertEqual(lab([100, 200], [60, -60]), (True, 0))       # reaches at 100, repaid later: still reached
        self.assertEqual(lab([100, 200], [-60, 100]), (False, 0))     # repaying old debt first offsets (B5-3)
        self.assertEqual(lab([0], [80]), (False, 0))                  # at t0 exactly: before the window
        self.assertEqual(lab([DAY], [80]), (True, 0))                 # at t0 + h exactly: inside
        self.assertEqual(lab([DAY + 1], [80]), (False, 0))            # after t0 + h: never enters
        self.assertEqual(lab([DAY + 1], [80], h=2 * DAY), (True, 0))
        # fall 30 by an aToken event + borrow 20 -> 50%
        p = G.build_paths(np.array([0]), np.array([500]), np.array([-30 * M]), A, Av, T)
        self.assertEqual(lab([600], [20], paths=p), (True, 0))
        self.assertEqual(lab([400], [20], paths=p), (True, 0))        # order inside the window does not matter
        self.assertEqual(lab([600], [19], paths=p), (False, 0))
        # a debt time on a day with an invalid anchor is an invalid point
        Av2 = Av.copy()
        Av2[0, 1] = False
        self.assertEqual(lab([DAY + 100], [80], h=2 * DAY, Avv=Av2)[1], 1)

    def test_future_debt_never_enters(self):
        T, A, Av, paths, debt, _ = synth(seed=11)
        cut = int(T[2])
        keep = debt["ts"] <= cut + DAY
        debt2 = {k: v[keep] for k, v in debt.items()}
        extra_ts = np.arange(cut + DAY + 1, cut + DAY + 50)
        debt3 = {"unit": np.r_[debt2["unit"], np.zeros(len(extra_ts), np.int64)],
                 "ts": np.r_[debt2["ts"], extra_ts], "usd": np.r_[debt2["usd"], np.full(len(extra_ts), 10 ** 6 * M)]}
        o = np.lexsort((debt3["ts"], debt3["unit"]))
        debt3 = {k: v[o] for k, v in debt3.items()}
        e2, e3 = E.EconIndex(paths, debt2, A, Av, T), E.EconIndex(paths, debt3, A, Av, T)
        for u in range(A.shape[0]):
            for d in range(3):
                for hs in G.HSEC:
                    if T[d] + hs > cut + DAY:
                        continue
                    a = e2.label([u], [T[d]], hs, [A[u, d]], G.SIZES)[0]
                    b = e3.label([u], [T[d]], hs, [A[u, d]], G.SIZES)[0]
                    for x in G.SIZES:
                        self.assertEqual(bool(a[x][0]), bool(b[x][0]))


class TestHistoryNoLookAhead(unittest.TestCase):
    def test_features_ignore_labels_resolved_after_t0(self):
        rng = np.random.default_rng(3)
        n_units, D = 4, 200
        unit = np.repeat(np.arange(n_units), D)
        t = np.tile(np.arange(D), n_units)
        Ye = (rng.random((len(t), G.NC)) < 0.1).astype(np.int8)
        RESe = np.ones((len(t), G.NH), bool)
        mdd = rng.random(len(t))
        F0 = E.econ_hist_features(unit, t, Ye, RESe, mdd, n_units, D)
        d = 120
        Y2 = Ye.copy()
        Y2[t >= d] = 1 - Y2[t >= d]                                  # every label of origins >= d flipped
        F1 = E.econ_hist_features(unit, t, Y2, RESe, mdd, n_units, D)
        m = t <= d
        for k in F0:
            self.assertTrue(np.array_equal(F0[k][m], F1[k][m]), k)
        self.assertFalse(np.array_equal(F0["x10"][t > d + 1], F1["x10"][t > d + 1]))


class TestPricesAndPieces(unittest.TestCase):
    def test_usd_micro(self):
        # 1.5 WETH at $2,500.12345678 -> $3,750.18518517 -> micro floor
        self.assertEqual(E.usd_micro(15 * 10 ** 17, 250012345678, 18), 3_750_185_185)
        self.assertEqual(E.usd_micro(1_000_000, 100_000_000, 6), 1_000_000)          # 1 USDC at $1
        self.assertEqual(E.usd_micro(10 ** 8, 6_000_000_000_000, 8), 60_000 * M)     # 1 WBTC at $60,000

    def test_fill_prices(self):
        arr = np.array([-1, -1, 5, -1, 7, -1], dtype=object)
        out, n = E.fill_prices(arr)
        self.assertEqual(list(out), [5, 5, 5, 5, 7, 7])
        self.assertEqual(n, 4)

    def test_decode_repay(self):
        import g_acquire_events as GA
        topics = [GA.topic0(E.REPAY_SIG), "0x" + "0" * 24 + "7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0",
                  "0x" + "0" * 24 + "4ffad6ac852c0af0aa301376f4c5dea3a928b120",
                  "0x" + "0" * 24 + "4ffad6ac852c0af0aa301376f4c5dea3a928b120"]
        data = "0x" + format(1002828146054859564, "064x") + format(1, "064x")
        d = E.decode_repay(topics, data)
        self.assertEqual(d["amount_raw"], 1002828146054859564)
        self.assertEqual(d["useATokens"], 1)
        self.assertEqual(d["user"], "0x4ffad6ac852c0af0aa301376f4c5dea3a928b120")
        self.assertEqual(GA.topic0(E.REPAY_SIG), "0xa534c8dbe71f871f9f3530e97a74601fea17b426cae02e1c5aee42c96c784051")
        with self.assertRaises(ValueError):
            E.decode_repay(topics, data[:-64])

    def test_fix_nomask(self):
        rng = np.random.default_rng(0)
        P = rng.random((50, G.NC))
        Fx = E.fix_nomask(P)[:, G.XCELL]
        self.assertTrue((np.diff(Fx, axis=2) <= 1e-15).all())       # non-increasing in x
        self.assertTrue((np.diff(Fx, axis=1) >= -1e-15).all())      # non-decreasing in h
        self.assertTrue(np.isfinite(Fx).all())

    def test_same_6g(self):
        v = np.array([0.0123456789, 0.5, 1.23456e-5, 0.0])
        w = np.array([float("%.6g" % x) for x in v])
        self.assertTrue(E.same_6g(v, w).all())
        self.assertFalse(E.same_6g(v[:1] * 1.0001, w[:1]).any())

    def test_ship_rule(self):
        f = {"v2e": {"pop": True, "own": True}, "v4ae": {"pop": True, "own": True, "v2e": False}}
        lab = {"v2e": "MEDIUM", "v4ae": "HIGH"}
        self.assertEqual(E.ship_rung_b5(f, lab, {"v2e": 0.1, "v4ae": 0.2})[0], "v2e")   # tie keeps v2e
        f["v4ae"]["v2e"] = True
        self.assertEqual(E.ship_rung_b5(f, lab, {"v2e": 0.1, "v4ae": 0.2})[0], "v4ae")
        f2 = {"v2e": {"pop": False, "own": True}, "v4ae": {"pop": False, "own": True, "v2e": True}}
        self.assertEqual(E.ship_rung_b5(f2, lab, {"v2e": 0.1, "v4ae": 0.2})[0], None)
        f3 = {"v2e": {"pop": False, "own": True}, "v4ae": {"pop": True, "own": True, "v2e": True}}
        self.assertEqual(E.ship_rung_b5(f3, lab, {"v2e": 0.1, "v4ae": 0.2}), ("v4ae", ["v4ae"]))

    def test_set_order(self):
        o = E.set_order_x()
        self.assertEqual(len(o), 25 * 6 + 25)
        self.assertEqual(o[0], (0, 0))
        self.assertEqual(o[6], (1, 0))                                # x varies before h
        self.assertEqual(o[-1], (24, None))


@unittest.skipUnless(os.environ.get("B5_OUT"), "B5_OUT not set")
class TestRecordedRun(unittest.TestCase):
    def test_b4_reproduction(self):
        r = json.load(open(os.path.join(os.environ["B5_OUT"], "results-b5.json")))
        rep = r["b4_reproduction"]
        self.assertTrue(rep["all_equal"])
        self.assertEqual(len(rep["brier"]), 25)
        for cid, v in rep["brier"].items():
            self.assertEqual(v["v2"], v["v2_b4"], cid)
        for h, v in rep["files"].items():
            self.assertTrue(v["equal"], h)
            self.assertGreater(v["values_compared"], 0)

    def test_added_exits_consistent(self):
        r = json.load(open(os.path.join(os.environ["B5_OUT"], "results-b5.json")))
        for cid, rec in r["exit_counts_test"].items():
            a = rec["all"]
            self.assertEqual(a["y_econ"] - a["y_old"], a["added"] - a["lost"], cid)


@unittest.skipUnless(os.environ.get("B5_DATA_TESTS") == "1" and os.environ.get("B5_DEBT_DIR"), "data tests off")
class TestRealLookAhead(unittest.TestCase):
    def test_debt_after_cut_never_enters(self):
        import b4_depositor as F
        ctx, res, rows = F.build_main_b4(DDIR, labels=True, log=lambda *a: None)
        R = res[0]
        bor, rep, _ = E.load_debt_frames(DDIR, os.environ["B5_DEBT_DIR"])
        prices, dec, _, _ = E.load_prices(os.environ["B5_DEBT_DIR"], ctx.T, ctx.days)
        debt, _ = E.debt_flows(bor, rep, R.addrs, np.asarray(ctx.T, np.int64), prices, dec)
        sel = np.nonzero(rows["reserve"] == 0)[0]
        args = (rows["unit"][sel], rows["t"][sel], rows["bal"][sel], rows["RES"][sel])
        Y0, R0, _ = E.econ_labels(R, debt, ctx.T, *args)
        cut_day = ctx.day_index["2025-06-01"]
        cut = int(ctx.T[cut_day])
        keep = debt["ts"] <= cut
        rng = np.random.default_rng(1)
        d2 = {k: v[keep] for k, v in debt.items()}
        d2["usd"] = d2["usd"].copy()
        late = {"unit": debt["unit"][~keep], "ts": debt["ts"][~keep],
                "usd": rng.integers(-10 ** 15, 10 ** 15, int((~keep).sum()))}
        d3 = {k: np.r_[d2[k], late[k]] for k in d2}
        o = np.lexsort((d3["ts"], d3["unit"]))
        d3 = {k: v[o] for k, v in d3.items()}
        Y1, R1, _ = E.econ_labels(R, d3, ctx.T, *args)
        T0 = rows["T0"][sel]
        for hi, hs in enumerate(G.HSEC):
            m = T0 + hs <= cut
            for xi in range(G.NX):
                ci = G.XCELL[hi, xi]
                self.assertTrue(np.array_equal(Y0[m, ci], Y1[m, ci]))
        mdd = rows["F4"]["x10"][sel, 1]
        F0 = E.econ_hist_features(rows["unit"][sel], rows["t"][sel], Y0, R0, mdd, rows["n_units"], ctx.D)
        F1 = E.econ_hist_features(rows["unit"][sel], rows["t"][sel], Y1, R1, mdd, rows["n_units"], ctx.D)
        m = rows["t"][sel] <= cut_day
        for k in F0:
            self.assertTrue(np.array_equal(F0[k][m], F1[k][m]), k)


if __name__ == "__main__":
    unittest.main()
