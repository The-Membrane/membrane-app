#!/usr/bin/env python3
"""Tests for b4_depositor.py and b4_acquire_blind5.py.

Synthetic tests read no dataset and score nothing:
  python3 -m unittest scripts/research/history-forecasts/test_b4_depositor.py -v
Data tests (development data only, never B-5) run with B4_DATA_TESTS=1 and the datasets checkout next to the repo
(or MEMBRANE_DATASETS_DIR): v2 through the B4 fit path equals the published B3 v2 predictions of one fold, and the
v4a history features at real rows ignore every label resolved after t0. With B4_OUT=<dev run dir> the recorded
check 'v2 reproduces B3 pooled Brier exactly in every cell' is asserted on results-dev.json.
"""
import json
import math
import os
import sys
import tempfile
import unittest
import warnings

import numpy as np
from scipy.special import expit

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import b4_depositor as F  # noqa: E402
import b4_acquire_blind5 as A5  # noqa: E402
import b3_segments as S  # noqa: E402
import bg_gradient as G  # noqa: E402

warnings.filterwarnings("ignore", category=FutureWarning)
M = G.MICRO
DAY = 86400
HERE = os.path.dirname(os.path.abspath(__file__))
DDIR = os.environ.get("MEMBRANE_DATASETS_DIR") or os.path.join(HERE, "..", "..", "..", "..", "membrane-datasets")


class TestStressAndTags(unittest.TestCase):
    def test_stress_overlap_positive_length(self):
        s0, s1 = F.STRESS_START, F.STRESS_END
        T0 = np.array([s0 - DAY, s0 - DAY + 1, s0, s1 - 1, s1, s0 - 7 * DAY, s0 - 7 * DAY + DAY])
        got = F.stress_overlap(T0, DAY)
        self.assertEqual(list(got), [False, True, True, True, False, False, False])
        self.assertEqual(list(F.stress_overlap(T0[5:], 7 * DAY)), [False, True])
        self.assertEqual(F.STRESS_END - F.STRESS_START, 7 * DAY)
        from datetime import datetime, timezone
        self.assertEqual(datetime.fromtimestamp(s0, timezone.utc).isoformat(), "2026-04-18T00:00:00+00:00")

    def test_cash_blocked(self):
        cmat = np.array([[100, 100, 40, 100, -1], [100, 100, 100, 100, 100]], dtype=np.int64) * M
        t = np.array([0, 0, 1, 3, 0])
        bal = np.array([100, 100, 100, 100, 100], dtype=np.int64) * M
        ridx = np.array([0, 0, 0, 0, 1])
        cash0 = cmat[ridx, t]
        # 24 h: snapshot d + 1 only
        self.assertEqual(list(F.cash_blocked_flags(t, bal, cash0, (cmat, ridx), DAY, x=50)),
                         [False, False, True, False, False])
        # 48 h: d + 1, d + 2 (row 0 sees day 2 cash 40 < 50); row 3 sees day 4 = missing
        self.assertEqual(list(F.cash_blocked_flags(t, bal, cash0, (cmat, ridx), 2 * DAY, x=50)),
                         [True, True, True, False, False])
        # x = 25: 40 >= 25 -> not blocked
        self.assertFalse(F.cash_blocked_flags(t, bal, cash0, (cmat, ridx), 2 * DAY, x=25).any())
        # 1 h and 6 h: no daily snapshot inside the window
        self.assertFalse(F.cash_blocked_flags(t, bal, cash0, (cmat, ridx), 6 * 3600, x=90).any())
        # y_all: 10 cash < 9 avail; avail = min(bal, cash0) = 100 -> 40 blocked
        self.assertEqual(list(F.cash_blocked_flags(t, bal, cash0, (cmat, ridx), 2 * DAY, x=None)),
                         [True, True, True, False, False])

    def test_borrow_flags(self):
        by = {"0xa": np.array([1000, 5000]), "0xc": np.array([10])}
        keys = F.borrow_index(by, ["0xa", "0xb", "0xc"])
        T0 = np.array([999, 1000, 4000, 1000, 5])
        got = F.borrow_flags(np.array([0, 0, 0, 1, 2]), T0, 1000, keys)
        # (999, 1999] holds 1000; (1000, 2000] holds nothing; (4000, 5000] holds 5000; 0xb never; (5, 1005] holds 10
        self.assertEqual(list(got), [True, False, True, False, True])
        self.assertFalse(F.borrow_flags(np.array([1]), np.array([0]), 10, F.borrow_index({}, ["0xb"])).any())


class TestHistoryFeatures(unittest.TestCase):
    def brute(self, unit, t, flag, d_unit, d_t):
        n = sum(1 for u, tt, f in zip(unit, t, flag) if f and u == d_unit and d_t - 90 <= tt <= d_t - 1)
        prev = [tt for u, tt, f in zip(unit, t, flag) if f and u == d_unit and tt <= d_t - 1]
        days = min(d_t - max(prev), 365) if prev else 365
        return n, days

    def test_hist_counts_match_brute_force_and_window_edges(self):
        rng = np.random.default_rng(1)
        D, nu = 600, 4
        unit = np.repeat(np.arange(nu), D)
        t = np.tile(np.arange(D), nu)
        keep = rng.random(len(t)) < 0.7
        unit, t = unit[keep], t[keep]
        flag = rng.random(len(t)) < 0.05
        n, days = F.hist_counts(unit, t, flag, nu, D)
        for i in rng.choice(len(t), 300, replace=False):
            bn, bd = self.brute(unit, t, flag, unit[i], t[i])
            self.assertEqual(n[i], bn)
            self.assertEqual(days[i], bd)
        # edges: t' = d - 90 and d - 1 count; d - 91 and d do not
        u = np.zeros(5, dtype=int)
        tt = np.array([9, 10, 99, 100, 200])
        fl = np.array([True, True, True, True, False])
        n2, d2 = F.hist_counts(u, tt, fl, 1, 300)
        self.assertEqual(n2[3], 2)        # day 100: counts 10 (= 100 - 90) and 99, not 9 nor itself
        self.assertEqual(d2[3], 1.0)
        self.assertEqual(n2[4], 0)        # day 200: 100 is 100 days back
        self.assertEqual(d2[4], 100.0)
        self.assertEqual(d2[0], 365.0)    # none before

    def test_hist_counts_no_lookahead(self):
        """Flags at origins t' >= t (labels resolved after t0) never change the features at t."""
        rng = np.random.default_rng(2)
        D = 400
        unit = np.zeros(D, dtype=int)
        t = np.arange(D)
        flag = rng.random(D) < 0.1
        n, days = F.hist_counts(unit, t, flag, 1, D)
        for d in (50, 150, 399):
            fl2 = flag.copy()
            fl2[d:] = ~fl2[d:]
            n2, days2 = F.hist_counts(unit, t, fl2, 1, D)
            self.assertEqual(n[d], n2[d])
            self.assertEqual(days[d], days2[d])

    def test_maxdd_brute_and_no_lookahead(self):
        rng = np.random.default_rng(3)
        D = 300
        P = rng.uniform(1, 100, size=(2, D))
        P[0, 37] = np.nan
        unit = np.array([0, 0, 1, 1, 0])
        t = np.array([10, 200, 95, 299, 0])
        got = F.maxdd_rows(unit, t, P)
        for i in range(len(t)):
            w = P[unit[i], max(0, t[i] - 90):t[i] + 1]
            w = w[np.isfinite(w)]
            best = 0.0
            for j in range(len(w)):
                pk = w[:j + 1].max()
                best = max(best, (pk - w[j]) / pk)
            self.assertAlmostEqual(got[i], best, places=12)
            P2 = P.copy()
            P2[unit[i], t[i] + 1:] = 1e-9                      # future balances collapse
            self.assertAlmostEqual(F.maxdd_rows(unit[i:i + 1], t[i:i + 1], P2)[0], got[i], places=12)
        self.assertEqual(got[4], 0.0)                          # one point
        self.assertEqual(F.maxdd_matrix(np.array([[0.0, 0.0, np.nan]]))[0], 0.0)   # no positive peak

    def test_panel_hist_at_matches_rows(self):
        T = np.arange(200) * DAY + 1_700_000_000
        flags = [5, 100, 150, 190]
        n, days = F.hist_at(T, flags, int(T[199]))           # at a daily origin: the row rule
        self.assertEqual(n, 2)                               # window days 109..198 holds 150 and 190
        self.assertEqual(days, 9.0)
        fl = np.zeros(200, bool)
        fl[flags] = True
        n3, d3 = F.hist_counts(np.zeros(200, int), np.arange(200), fl, 1, 200)
        self.assertEqual((n3[199], d3[199]), (n, days))
        self.assertEqual(F.maxdd_at(T, np.r_[np.full(199, 10.0), 5.0], np.ones(200, bool), int(T[199]), 5.0), 0.5)


class TestFrailty(unittest.TestCase):
    def test_nb_recovers_known_m(self):
        for m_true, seed in ((5.0, 11), (1.0, 12), (20.0, 13)):
            rng = np.random.default_rng(seed)
            n = 40_000
            E = rng.uniform(0.5, 6.0, n)
            theta = rng.gamma(m_true, 1.0 / m_true, n)
            O = rng.poisson(theta * E)
            m, lls, nu = F.select_m(O, E)
            self.assertEqual(m, m_true, msg=f"m_true {m_true}: got {m} lls {lls}")
            self.assertEqual(nu, n)

    def test_nb_loglik_matches_scipy_nbinom(self):
        from scipy.stats import nbinom
        from scipy.special import gammaln
        O = np.array([0, 1, 4, 2])
        E = np.array([0.3, 1.2, 2.5, 0.9])
        for m in (0.5, 3.0, 20.0):
            ref = float(np.sum(nbinom.logpmf(O, m, m / (m + E)) + gammaln(O + 1)))
            self.assertAlmostEqual(F.nb_loglik(O, E, m), ref, places=9)

    def test_select_m_ties_and_empty(self):
        self.assertEqual(F.select_m(np.zeros(3), np.zeros(3))[0], 3.0)
        orig = F.nb_loglik
        try:
            F.nb_loglik = lambda O, E, m: 0.0                    # every grid value ties
            self.assertEqual(F.select_m(np.ones(2), np.ones(2))[0], 3.0)
            F.nb_loglik = lambda O, E, m: 0.0 if m in (1.0, 5.0) else -1.0   # equidistant: log distance -> 5
            self.assertEqual(F.select_m(np.ones(2), np.ones(2))[0], 5.0)
            F.nb_loglik = lambda O, E, m: 0.0 if m in (0.5, 20.0) else -1.0
            self.assertEqual(F.select_m(np.ones(2), np.ones(2))[0], 0.5)
        finally:
            F.nb_loglik = orig
        # no exits at all: P(O = 0) = (m / (m + E))^m falls with m, so the smallest grid value wins
        self.assertEqual(F.select_m(np.zeros(50), np.full(50, 2.0))[0], 0.25)

    def test_discount_and_theta(self):
        w = F.discount_weights([0, 180 * DAY, 360 * DAY], 360 * DAY)
        self.assertTrue(np.allclose(w, [0.25, 0.5, 1.0]))
        self.assertTrue(np.allclose(F.theta_v4b([0, 2], [0, 1], np.array([3.0, 1.0])), [1.0, 1.5]))

    def test_m_by_segment_uses_unit_segment_sums(self):
        rng = np.random.default_rng(5)
        n = 30_000
        unit = rng.integers(0, 3000, n)
        seg = (unit % 2).astype(np.int8)                         # units stay in one segment
        p0 = np.full(n, 0.1)
        th_u = np.where(np.arange(3000) % 2 == 0, rng.gamma(1.0, 1.0, 3000), rng.gamma(50.0, 1 / 50.0, 3000))
        y = (rng.random(n) < np.clip(p0 * th_u[unit], 0, 1)).astype(float)
        m, info = F.m_by_segment(unit, seg, np.ones(n), y, p0, 3000, nseg=6)
        self.assertLessEqual(m[0], 2.0)                          # heterogeneous segment: small m
        self.assertGreaterEqual(m[1], 10.0)                      # homogeneous segment: large m
        self.assertEqual(list(m[2:]), [3.0] * 4)                 # no units -> 3


class TestShipping(unittest.TestCase):
    def fl(self, v2=(True, True), a=(True, True, False), b=(True, True, False)):
        return {"v2": {"pop": v2[0], "own": v2[1]}, "v4a": {"pop": a[0], "own": a[1], "v2": a[2]},
                "v4b": {"pop": b[0], "own": b[1], "v2": b[2]}}

    def test_tie_keeps_v2(self):
        lab = {"v2": "MEDIUM", "v4a": "HIGH", "v4b": "HIGH"}
        bss = {"v2": 0.01, "v4a": 0.02, "v4b": 0.03}
        self.assertEqual(F.ship_rung_b4(self.fl(), lab, bss), ("v2", ["v2"]))     # CI vs v2 spans 0: no tie route

    def test_new_rung_ships_when_it_beats_v2(self):
        lab = {"v2": "MEDIUM", "v4a": "HIGH", "v4b": "MEDIUM"}
        bss = {"v2": 0.01, "v4a": 0.02, "v4b": 0.03}
        self.assertEqual(F.ship_rung_b4(self.fl(a=(True, True, True), b=(True, True, True)), lab, bss),
                         ("v4a", ["v2", "v4a", "v4b"]))
        lab = {"v2": "MEDIUM", "v4a": "MEDIUM", "v4b": "MEDIUM"}
        self.assertEqual(F.ship_rung_b4(self.fl(a=(True, True, True), b=(True, True, True)), lab, bss)[0], "v4b")
        bss = {"v2": 0.03, "v4a": 0.03, "v4b": 0.03}                              # full tie -> simpler
        self.assertEqual(F.ship_rung_b4(self.fl(a=(True, True, True), b=(True, True, True)), lab, bss)[0], "v2")

    def test_no_rung_beats_population(self):
        f = self.fl(v2=(False, True), a=(False, True, True), b=(True, False, False))
        self.assertEqual(F.ship_rung_b4(f, {"v2": "LOW", "v4a": "LOW", "v4b": "LOW"},
                                        {"v2": 0.0, "v4a": 0.0, "v4b": 0.0})[0], None)

    def test_b5_label_rule(self):
        self.assertEqual(F.b5_label_rule("MEDIUM", {}, (0, None)), ("MEDIUM", None))
        self.assertEqual(F.b5_label_rule("HIGH", {"a": (60, 1.1), "b": (10, 3.0)}, (70, 1.2)), ("HIGH", "confirmed"))
        self.assertEqual(F.b5_label_rule("HIGH", {"a": (60, 1.6)}, (70, 1.2)), ("MEDIUM", "failed transfer"))
        self.assertEqual(F.b5_label_rule("HIGH", {"a": (20, 1.0)}, (40, 1.0)), ("MEDIUM", "unconfirmed"))

    def test_b5_verdict(self):
        cells = [(30, 2.0, 1.2), (25, 0.5, 0.8), (5, 9.0, 1.0)]
        v = F.b5_verdict(cells, "v4a", [-0.001, 0.0, 0.01])
        self.assertEqual((v["i"], v["ii"], v["verdict"], v["n_cells_i"]), (True, True, "pass", 2))
        self.assertEqual(F.b5_verdict(cells, "v4a", [-0.003, 0.0, 0.01])["verdict"], "fail")
        self.assertEqual(F.b5_verdict([(5, 1.0, 1.0)], "v4b", [0.0])["verdict"], "not testable")


class TestBlind5Gate(unittest.TestCase):
    def test_refusals_and_start_marker(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(SystemExit):
                F.blind5_gate(d, None, "ab", DDIR, verify_git=False)
            with self.assertRaises(SystemExit):
                F.blind5_gate(d, "abc123", None, DDIR, verify_git=False)
            with self.assertRaises(SystemExit):                     # no frozen file yet
                F.blind5_gate(d, "abc123", "00", DDIR, verify_git=False)
            F.write_json(os.path.join(d, "results-dev.json"), {"x": 1})
            F.write_json(os.path.join(d, "shipped-b4.json"), {"cells": {}})
            sh = F.sha256_file(os.path.join(d, "shipped-b4.json"))
            F.write_json(os.path.join(d, "freeze-record.json"), {"shipped_b4_sha256": sh, "results_dev_sha256":
                                                                 F.sha256_file(os.path.join(d, "results-dev.json"))})
            with self.assertRaises(SystemExit):                     # wrong frozen sha
                F.blind5_gate(d, "abc123", "0" * 64, DDIR, verify_git=False)
            rec = F.blind5_gate(d, "abc123", sh, DDIR, verify_git=False)
            self.assertEqual(rec["shipped_b4_sha256"], sh)
            with open(os.path.join(d, "blind5-started.json"), "w") as fh:
                fh.write("{}")
            with self.assertRaises(SystemExit):                     # second run refused
                F.blind5_gate(d, "abc123", sh, DDIR, verify_git=False)
            os.remove(os.path.join(d, "blind5-started.json"))
            F.write_json(os.path.join(d, "results-dev.json"), {"x": 2})
            with self.assertRaises(SystemExit):                     # results changed after the freeze
                F.blind5_gate(d, "abc123", sh, DDIR, verify_git=False)

    def test_phase_blind5_refuses_without_commit(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(SystemExit):
                F.phase_blind5(DDIR, d, None, None)
            self.assertFalse(os.path.exists(os.path.join(d, "blind5-started.json")))


class TestAcquireRules(unittest.TestCase):
    def test_classify(self):
        self.assertEqual(A5.classify("USDC", 1.0)[0], True)
        self.assertEqual(A5.classify("PYUSD", 0.9998)[0], True)
        self.assertEqual(A5.classify("USDS", 1.03)[0], False)                  # out of the price band
        for s, p in (("sUSDe", 1.25), ("PT-sUSDE-31JUL2025", 0.99), ("eUSDe", 0.9987), ("EURC", 1.16),
                     ("WETH", 4000.0), ("syrupUSDT", 1.14)):
            self.assertFalse(A5.classify(s, p)[0], s)
        self.assertEqual(A5.reserve_name("Prime", "USDC"), "Prime_USDC")

    def test_count_units_balances_only(self):
        labels = {f"2024-01-{d:02d}" for d in range(1, 32)}
        rows = [[f"2024-01-{d:02d}", "0xa", 10 ** 12, ""] for d in range(1, 31)]             # 30 days at $1M
        rows += [[f"2024-01-{d:02d}", "0xb", 10 ** 12 - 1, ""] for d in range(1, 32)]        # never reaches
        rows += [["asof", "0xc", 10 ** 15, ""], ["2024-01-01", "0xc", "", "fail"]]
        rows += [[f"2024-01-{d:02d}", "0xd", 10 ** 24, ""] for d in range(1, 30)]            # 29 days (18 dec)
        days6 = A5.count_units(rows[:63], 6, labels)
        self.assertEqual(days6, {"0xa": 30, "0xb": 0, "0xc": 0})
        self.assertEqual(A5.units_qualifying(days6), 1)
        days18 = A5.count_units(rows[63:], 18, labels)
        self.assertEqual(days18["0xd"], 29)
        self.assertEqual(A5.floor_micro(10 ** 24 - 1, 18), 10 ** 12 - 1)                      # floored, as G
        self.assertTrue(A5.b5_selected(20) and not A5.b5_selected(19))


class TestV2PathIsB3(unittest.TestCase):
    def test_fit_one_v2_equals_bg_fit(self):
        rng = np.random.default_rng(7)
        n, nu = 4000, 60
        X = rng.normal(size=(n, 13))
        unit = rng.integers(0, nu, n)
        y = (rng.random(n) < expit(-2 + X[:, 0])).astype(np.int8)
        rows = {"Y": y[:, None], "unit": unit, "T0": np.arange(n) * 100, "seg": (unit % 6).astype(np.int8)}
        X4 = np.column_stack([X[:, :11], rng.normal(size=(n, 3))])
        tri = np.arange(3000)
        f = F.fit_one(rows, X, X4, tri, 0, 300_000, nu)
        ref = G.fit_cell_model(X[tri], y[tri].astype(float), unit[tri], nu)
        self.assertEqual(f["m2"]["params"], ref["params"])
        self.assertTrue(np.array_equal(f["m2"]["theta"], ref["theta"]))
        te = np.arange(3000, n)
        p2, p4a, p4b = F.predict_rungs(f, X, X4, te, unit[te], rows["seg"][te])
        pr, _ = G.predict_p(ref["params"], ref["const_p0"], X[te], ref["theta"][unit[te]])
        self.assertTrue(np.array_equal(p2, pr))
        self.assertTrue(np.all((p4b > 0) & (p4b < 1)))


@unittest.skipUnless(os.environ.get("B4_DATA_TESTS") == "1" and os.path.isdir(DDIR), "data tests off")
class TestDevData(unittest.TestCase):
    """Development data only (USDC/USDT); no B-5 file is read."""

    @classmethod
    def setUpClass(cls):
        cls.ctx, cls.res, cls.rows = F.build_main_b4(DDIR, labels=True, log=lambda *a: None)

    def test_v4a_features_ignore_labels_after_t0(self):
        rows = self.rows
        rng = np.random.default_rng(9)
        D = self.ctx.D
        for xk in ("x25", "all"):
            ci = F.xcell24(xk)
            flag = rows["RES"][:, 2] & (rows["Y"][:, ci] == 1)
            for i in rng.choice(np.nonzero(rows["fold"] >= 0)[0], 200, replace=False):
                u = rows["unit"][i]
                fl2 = flag.copy()
                late = (rows["unit"] == u) & (rows["T0"] + 86400 > rows["T0"][i])   # windows ending after t0
                fl2[late] = ~fl2[late]
                sel = np.nonzero(rows["unit"] == u)[0]
                nA, dA = F.hist_counts(np.zeros(len(sel), int), rows["t"][sel], flag[sel], 1, D)
                nB, dB = F.hist_counts(np.zeros(len(sel), int), rows["t"][sel], fl2[sel], 1, D)
                k = int(np.nonzero(sel == i)[0][0])
                self.assertEqual((nA[k], dA[k]), (nB[k], dB[k]))
                self.assertAlmostEqual(math.log1p(nA[k]), rows["F4"][xk][i, 0], places=12)
                self.assertAlmostEqual(math.log1p(dA[k]), rows["F4"][xk][i, 2], places=12)

    def test_v2_equals_b3_published_fold(self):
        import pandas as pd
        fi = [f[0] for f in self.ctx.folds].index("2026Q2")
        tasks = [("fold", fi, ci) for ci in range(G.NC)]
        fits, test_idx = F.run_fits(self.ctx, self.rows, tasks, np.zeros(0, dtype=np.int64), S.LIVE_ASOF_TS,
                                    workers=3, log=lambda *a: None)
        n = len(self.rows["t"])
        PR = {k: np.full((n, G.NC), np.nan) for k in ("v2", "v4a", "v4b", "own", "pop")}
        for r in fits:
            te = test_idx[r["fi"]]
            PR["v2"][te, r["ci"]], PR["v4a"][te, r["ci"]], PR["v4b"][te, r["ci"]] = r["p"]
        PR = G.apply_fix(PR, self.rows, versions=("v2",))
        days = np.array(self.ctx.days)
        for h, cid in (("24h", "x25_24h"), ("7d", "all_7d"), ("1h", "x90_1h")):
            ci = [c["id"] for c in G.CELLS].index(cid)
            df = pd.concat([pd.read_csv(os.path.join(DDIR, F.B3_RUN, f"predictions-test-{h}-{r}.csv.gz"),
                                        usecols=["unit", "date", "fold", f"v2_{cid}"]) for r in G.MAIN_RESERVES])
            df = df[(df["fold"] == "2026Q2") & df[f"v2_{cid}"].notna()]
            te = test_idx[fi]
            key = {(int(u), d): k for k, (u, d) in enumerate(zip(self.rows["unit"][te], days[self.rows["t"][te]]))}
            mine = np.array([PR["v2"][te[key[(int(u), d)]], ci] for u, d in zip(df["unit"], df["date"])])
            pub = df[f"v2_{cid}"].to_numpy(float)
            self.assertTrue(np.all(np.abs(mine - pub) <= 5e-6 * np.abs(pub) + 1e-12), cid)


@unittest.skipUnless(os.environ.get("B4_OUT"), "B4_OUT not set")
class TestDevRunRecord(unittest.TestCase):
    def test_v2_reproduces_b3_brier_in_every_pooled_cell(self):
        res = json.load(open(os.path.join(os.environ["B4_OUT"], "results-dev.json")))
        chk = res["v2_equals_b3_check"]
        self.assertEqual(len(chk["cells"]), G.NC)
        for cid, v in chk["cells"].items():
            self.assertEqual(v["b4_v2"], v["b3_v2"], cid)
            self.assertEqual(v["rows_b4"], v["rows_b3"], cid)
        self.assertTrue(chk["all_equal"])


if __name__ == "__main__":
    unittest.main()


def fake_rows(rng, n_units=40, D=900, reserves=("USDC", "USDT"), folds=12):
    """Synthetic rows with the bg_gradient row layout (labels random)."""
    unit = np.repeat(np.arange(n_units), D)
    t = np.tile(np.arange(D), n_units)
    keep = rng.random(len(t)) < 0.6
    unit, t = unit[keep], t[keep]
    n = len(t)
    T = 1_690_000_000 + np.arange(D) * DAY
    rows = {"unit": unit, "t": t, "T0": T[t], "bal": rng.integers(1, 80, n) * 1_000_000 * M,
            "reserve": (unit % len(reserves)).astype(np.int8), "feat_ok": np.ones(n, bool),
            "RES": np.ones((n, G.NH), bool), "CAP": np.zeros((n, G.NC), bool), "X": rng.normal(size=(n, 13)),
            "n_units": n_units, "reserve_names": list(reserves)}
    rows["CAP"][:, G.XCELL[:, 4]] = (rng.random(n) < 0.1)[:, None]
    base = rng.random(n)
    Y = np.zeros((n, G.NC), dtype=np.int8)
    for hi in range(G.NH):
        for xi in range(G.NX):
            Y[:, G.XCELL[hi, xi]] = base < 0.02 * (hi + 1) / (xi + 1)
        Y[:, G.ACELL[hi]] = base < 0.01 * (hi + 1)
    rows["Y"] = Y
    rows["seg"] = (unit % 6).astype(np.int8)
    rows["contract_unit"] = (np.arange(n_units) % 2).astype(np.int8)
    q = np.linspace(150, D, folds + 1).astype(int)
    rows["fold"] = np.full(n, -1, dtype=np.int16)
    fl = []
    for fi in range(folds):
        rows["fold"][(t >= q[fi]) & (t < q[fi + 1])] = fi
        fl.append((f"F{fi}", int(q[fi]), int(q[fi + 1])))

    class C:
        pass
    ctx = C()
    ctx.folds, ctx.T, ctx.D = fl, T, D
    return ctx, rows


class TestPipelineSynthetic(unittest.TestCase):
    def test_score_ship_holdout_freeze(self):
        rng = np.random.default_rng(21)
        ctx, rows = fake_rows(rng)
        n = len(rows["t"])
        test = rows["fold"] >= 0
        PR = {}
        for k in ("v2", "v4a", "v4b", "own", "pop"):
            P = np.full((n, G.NC), np.nan)
            P[test] = np.clip(rows["Y"][test] * 0.3 + rng.uniform(0.005, 0.05, (test.sum(), G.NC)), 0, 0.99)
            PR[k] = P
        PR = G.apply_fix(PR, rows, versions=F.RUNGS)
        cells, pooled = F.score_b4(ctx, rows, PR, log=lambda *a: None)
        self.assertEqual(set(cells), {c["id"] for c in G.CELLS})
        self.assertEqual(len(pooled), G.NC)
        for cid, d in cells.items():
            for s, v in d.items():
                self.assertIn(v["label"], ("HIGH", "MEDIUM", "LOW", "STALE"))
                self.assertIn(v["shipped"], (None, "v2", "v4a", "v4b"))
                self.assertIn("no_stress", v)
        # holdout rule on fake holdout rows with fake frozen params
        hctx, hrows = fake_rows(np.random.default_rng(22), reserves=("DAI", "GHO", "USDe"))
        hrows["F4"] = {xk: rng.normal(size=(len(hrows["t"]), 3)) for xk in F.XKEYS}
        par = {"mu": [0.0] * 13, "sd": [1.0] * 13, "coef": [0.1] * 13, "intercept": -3.0}
        par4 = {"mu": [0.0] * 14, "sd": [1.0] * 14, "coef": [0.1] * 14, "intercept": -3.0}
        fp = {fi: {c["id"]: {"v2": {"params": par, "const_p0": None, "pop": 0.02, "seg_pop": [0.02] * 6},
                             "v4a": {"params": par4, "const_p0": None}, "v4b": {"m_seg": [3.0] * 6}}
                   for c in G.CELLS} for fi in range(12)}
        hold = F.holdout_check(hctx, hrows, fp, cells)
        for cid in hold:
            for s, v in hold[cid].items():
                self.assertIn(v["label_final"], ("HIGH", "MEDIUM", "LOW", "STALE"))
                if v["label_dev"] != "HIGH":
                    self.assertEqual(v["label_final"], v["label_dev"])
        self.assertEqual(set(F.label_counts(cells, "label")), set(F.SEG_IDS))
