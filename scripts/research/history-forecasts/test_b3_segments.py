#!/usr/bin/env python3
"""Unit tests for b3_segments.py on synthetic data only (no dataset read, no score).

  python3 -m unittest scripts/research/history-forecasts/test_b3_segments.py -v
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
import b3_segments as S  # noqa: E402
import bg_gradient as G  # noqa: E402

warnings.filterwarnings("ignore", category=FutureWarning)
M = G.MICRO


class TestSegments(unittest.TestCase):
    def test_bands_exact(self):
        b = [1_000_000 * M, 10_000_000 * M - 1, 10_000_000 * M, 50_000_000 * M - 1, 50_000_000 * M, 10 ** 18]
        self.assertEqual(list(S.band_of(b)), [0, 0, 1, 1, 2, 2])
        self.assertEqual(list(S.segment_of([0, 0, 0, 1, 1, 1], [0, 1, 2, 0, 1, 2])), [0, 1, 2, 3, 4, 5])
        self.assertEqual(S.SEG_IDS, ("w1", "w2", "w3", "c1", "c2", "c3"))

    def test_code_kind(self):
        self.assertEqual(S.code_kind("0x"), (False, False))
        self.assertEqual(S.code_kind("0xef0100" + "ab" * 20), (False, True))      # 7702 -> wallet
        self.assertEqual(S.code_kind("0x6080604052"), (True, False))
        self.assertEqual(S.code_kind("0xef0100" + "ab" * 21), (True, False))      # not a designator length


class TestCrossVenue(unittest.TestCase):
    def test_pair_series_and_price_fill(self):
        s = S.pair_series([2, 5], [10.0, 4.0], 8)
        self.assertEqual(list(s), [0, 0, 10, 10, 10, 4, 4, 4])
        p = S.ffill_price([np.nan, 1.0, np.nan, 1.2, np.nan])
        self.assertEqual(list(p), [1.0, 1.0, 1.0, 1.2, 1.2])

    def test_contrib_flow_drop_count_and_asof(self):
        D = 20
        n = D + 2
        S_ = np.zeros(n)
        S_[0:10] = 1_000_000 * 1e6          # 1M tokens (6 dec) until day 9
        S_[10:] = 850_000 * 1e6             # -15% at day 10
        S_[D:] = 850_000 * 1e6
        S_[D + 1] = 700_000 * 1e6
        price = np.full(n, 1.0)
        V, FL, DR, CNT = S.xv_pair_contrib(S_, price, 6, D)
        self.assertAlmostEqual(V[0], 1_000_000.0)
        self.assertAlmostEqual(FL[10], -150_000.0)             # shares(10) - shares(3)
        self.assertAlmostEqual(FL[16], -150_000.0)
        self.assertAlmostEqual(FL[17], 0.0)                    # shares(17) - shares(10)
        self.assertTrue(DR[10] and DR[16])                     # base d-7 = 1M, min over d-6..d = 850k
        self.assertFalse(DR[17])                               # base 850k, no further drop
        self.assertFalse(DR[9])
        self.assertTrue(CNT[:D].all())
        # asof: base = last daily snapshot (D - 1 = 850k), window {asof_b1, asof}: 700k <= 0.9 * 850k
        self.assertAlmostEqual(FL[D + 1], -150_000.0)
        self.assertTrue(DR[D + 1])
        self.assertFalse(DR[D])                                # asof_b1 carries no 7-day items

    def test_value_drop_counts_a_price_loss(self):
        D = 15
        n = D + 2
        S_ = np.full(n, 5e11)
        price = np.ones(n)
        price[12:] = 0.85                                      # a vault loss, no share change
        V, FL, DR, CNT = S.xv_pair_contrib(S_, price, 6, D)
        self.assertTrue(DR[12])
        self.assertAlmostEqual(FL[12], 0.0)                    # net flow ignores the price move

    def test_b3_features_and_unknown_addresses(self):
        X = S.XV()
        D = 10
        X.addrs = ["0xa"]
        X.aidx = {"0xa": 0}
        X.OV = np.full((1, D + 2), 3e6)
        X.FL = np.full((1, D + 2), -1e6)
        X.DR = np.ones((1, D + 2), bool)
        X.CNT = np.full((1, D + 2), 2, dtype=np.int16)
        X.flags = {"0xa": {"contract": False}, "0xb": {"contract": True}}
        rows = {"t": np.array([3, 4, 5]), "bal": np.array([2 * 10 ** 12, 20 * 10 ** 12, 60 * 10 ** 12]),
                "unit": np.array([0, 1, 2]), "unit_addr": ["0xa", "0xb", "0xc"], "n_units": 3,
                "X": np.zeros((3, 13))}
        cu = np.array([0, 1, 0], dtype=np.int8)
        X3, band, seg = S.b3_features(rows, X, cu)
        self.assertEqual(X3.shape, (3, 22))
        self.assertEqual(list(band), [0, 1, 2])
        self.assertEqual(list(seg), [0, 4, 2])
        f = dict(zip(S.XV_FEATURES, X3[0, 13:]))
        self.assertAlmostEqual(f["log1p_xv_usd"], math.log1p(3e6))
        self.assertAlmostEqual(f["xv_share"], 3e6 / 5e6)
        self.assertAlmostEqual(f["xv_flow7_over_bal"], -0.5)
        self.assertEqual((f["xv_drop10_7d"], f["xv_venues_100k"], f["xv_known"]), (1.0, 2.0, 1.0))
        g = dict(zip(S.XV_FEATURES, X3[1, 13:]))                # in the universe, no paths
        self.assertEqual((g["log1p_xv_usd"], g["xv_known"], g["is_contract"], g["band_10_50m"]), (0.0, 1.0, 1.0, 1.0))
        h = dict(zip(S.XV_FEATURES, X3[2, 13:]))                # outside the universe
        self.assertEqual((h["xv_known"], h["log1p_xv_usd"], h["band_50m_plus"]), (0.0, 0.0, 1.0))
        self.assertEqual(S.FEATURES_V3[:13], G.FEATURES_V2)


class TestRecalibration(unittest.TestCase):
    def test_theta_segments_m50(self):
        y = np.array([1, 0, 0, 1, 1, 0, 0, 0], float)
        p = np.array([.1, .2, .1, .3, .2, .1, .1, .1])
        seg = np.array([0, 0, 0, 3, 3, 3, 5, 5])
        th, O, E = S.theta_segments(y, p, seg)
        self.assertAlmostEqual(th[0], (1 + 50) / (0.4 + 50))
        self.assertAlmostEqual(th[3], (2 + 50) / (0.6 + 50))
        self.assertAlmostEqual(th[1], 1.0)                      # empty segment
        self.assertAlmostEqual(th[5], 50 / 50.2)

    def test_odds_multiplier_after_unit_theta(self):
        p0 = np.array([0.02, 0.3])
        th_i, th_s = np.array([1.5, 0.5]), np.array([2.0, 0.8])
        p = S.odds_mult(S.odds_mult(p0, th_i), th_s)
        np.testing.assert_allclose(logit(p), logit(p0) + np.log(th_i) + np.log(th_s))


class TestShipping(unittest.TestCase):
    def F(self, **kw):
        f = {"v2": {"pop": True, "own": True}, "v3": {"pop": True, "own": True, "v2": False, "v2_span": True},
             "v3s": {"pop": True, "own": True, "v2": False, "v2_span": True}}
        for k, v in kw.items():
            r, key = k.split("__")
            f[r][key] = v
        return f

    def test_v2_ships_when_alone_eligible(self):
        rung, el = S.ship_rung(self.F(), {"v2": "HIGH", "v3": "HIGH", "v3s": "MEDIUM"},
                               {"v2": 0.05, "v3": 0.06, "v3s": 0.07})
        self.assertEqual((rung, el), ("v2", ["v2"]))          # ties without more HIGH are not eligible

    def test_v3_beats_v2(self):
        rung, el = S.ship_rung(self.F(v3__v2=True, v3__v2_span=False), {"v2": "HIGH", "v3": "HIGH", "v3s": "LOW"},
                               {"v2": 0.05, "v3": 0.06, "v3s": 0.07})
        self.assertEqual(rung, "v3")
        rung, _ = S.ship_rung(self.F(v3__v2=True, v3__v2_span=False), {"v2": "HIGH", "v3": "MEDIUM", "v3s": "LOW"},
                              {"v2": 0.05, "v3": 0.06, "v3s": 0.07})
        self.assertEqual(rung, "v2")                           # most HIGH first

    def test_tie_with_more_high(self):
        rung, el = S.ship_rung(self.F(), {"v2": "MEDIUM", "v3": "MEDIUM", "v3s": "HIGH"},
                               {"v2": 0.05, "v3": 0.06, "v3s": 0.01})
        self.assertEqual((rung, el), ("v3s", ["v2", "v3s"]))

    def test_equal_label_higher_bss_and_simpler_tie(self):
        f = self.F(v3__v2=True, v3__v2_span=False)
        self.assertEqual(S.ship_rung(f, {"v2": "MEDIUM", "v3": "MEDIUM", "v3s": "LOW"},
                                     {"v2": 0.05, "v3": 0.06, "v3s": 0})[0], "v3")
        self.assertEqual(S.ship_rung(f, {"v2": "MEDIUM", "v3": "MEDIUM", "v3s": "LOW"},
                                     {"v2": 0.06, "v3": 0.06, "v3s": 0})[0], "v2")

    def test_nothing_beats_pop_and_own(self):
        f = self.F(v2__own=False, v3__own=False, v3s__own=False, v3__v2=True, v3__v2_span=False)
        self.assertEqual(S.ship_rung(f, {"v2": "LOW", "v3": "HIGH", "v3s": "LOW"},
                                     {"v2": 0.0, "v3": 0.1, "v3s": 0.0})[0], None)
        f = self.F(v2__pop=False)                             # v3 beats pop/own but ties v2 without more HIGH
        self.assertEqual(S.ship_rung(f, {"v2": "LOW", "v3": "LOW", "v3s": "LOW"},
                                     {"v2": -0.01, "v3": 0.01, "v3s": 0.01})[0], None)


class TestHoldoutRule(unittest.TestCase):
    def test_rule(self):
        self.assertEqual(S.holdout_rule("HIGH", {"DAI": (60, 1.1), "USDe": (80, 0.9)}, (140, 1.0)),
                         ("HIGH", "confirmed"))
        self.assertEqual(S.holdout_rule("HIGH", {"DAI": (60, 1.6), "USDe": (80, 0.9)}, (140, 1.2)),
                         ("MEDIUM", "failed transfer"))
        self.assertEqual(S.holdout_rule("HIGH", {"DAI": (40, 3.0), "USDe": (80, 0.9)}, (120, 1.2)),
                         ("HIGH", "confirmed"))                # DAI below 50 episodes is not judged
        self.assertEqual(S.holdout_rule("HIGH", {"DAI": (10, 1.0), "USDe": (20, 1.0)}, (30, 1.0)),
                         ("MEDIUM", "unconfirmed"))
        self.assertEqual(S.holdout_rule("HIGH", {"DAI": (60, 1.0), "USDe": (60, 1.0)}, (120, 1.55)),
                         ("MEDIUM", "failed transfer"))
        self.assertEqual(S.holdout_rule("MEDIUM", {"DAI": (60, 9.0), "USDe": (60, 1.0)}, (120, 5.0)),
                         ("MEDIUM", None))


class TestMisc(unittest.TestCase):
    def test_bh(self):
        p = [0.001, 0.008, 0.039, 0.041, 0.042, 0.06, 0.074, 0.205, 0.212, 0.216, None]
        rej = S.bh_reject(p, 0.05)
        self.assertEqual(list(rej[:3]), [True, True, False])
        self.assertFalse(rej[-1])
        self.assertEqual(int(S.bh_reject([0.5, 0.6]).sum()), 0)

    def test_rv7_from_rounds(self):
        H0 = 1_800_000_000 - 1_800_000_000 % 3600
        rng = np.random.default_rng(2)
        ua = np.sort(rng.integers(H0 - 200 * 3600, H0 + 3600, 900))
        ans = 2000 * np.exp(np.cumsum(rng.normal(0, 0.003, 900)))
        rv, c = S.rv7_from_rounds(ua, ans, H0)
        hours = H0 - 3600 * np.arange(168, -1, -1)
        ref = np.array([ans[np.nonzero(ua <= h)[0][-1]] for h in hours])
        np.testing.assert_allclose(c, ref)
        self.assertAlmostEqual(rv, math.sqrt(8760 * np.mean(np.diff(np.log(ref)) ** 2)))

    def test_composite_fix(self):
        g = np.array([[0.2, 0.1, 0.3, 0.05, 0.01]] * G.NH) * np.linspace(1, 2, G.NH)[:, None]
        cap = np.array([False, False, False, True, True])
        f = S.composite_fix(g, cap)
        self.assertTrue(np.isnan(f[:, 3:]).all())
        np.testing.assert_allclose(f[:, :3], A.monotone_fix(g[:, :3]))

    def test_set_order(self):
        o = S.set_order()
        self.assertEqual(len(o), 25 * 6 + 5 * 6 + 25 + 5)
        self.assertEqual(o[:7], [(0, 0), (0, 1), (0, 2), (0, 3), (0, 4), (0, 5), (1, 0)])
        self.assertEqual(o[6 * 5], (int(G.XCELL[1, 0]), 0))      # h outer, then x, then segment
        self.assertEqual(o[150], (int(G.ACELL[0]), 0))
        self.assertEqual(o[180], (0, None))
        self.assertEqual(o[-1], (int(G.ACELL[4]), None))

    def test_pick_shipped_and_fix_grid(self):
        rows = {"seg": np.array([0, 3, 5])}
        cells = {c["id"]: {s: {"shipped": None} for s in S.SEG_IDS} for c in G.CELLS}
        cells["x10_1h"]["w1"]["shipped"] = "v3"
        cells["x10_1h"]["c1"]["shipped"] = "v3s"
        frozen = {"cells": cells}
        F = {"v2": np.full((3, G.NC), 0.1), "v3": np.full((3, G.NC), 0.2), "v3s": np.full((3, G.NC), 0.3)}
        p, code = S.pick_shipped(rows, np.arange(3), F, frozen)
        self.assertEqual(list(p[:, 0]), [0.2, 0.3, 0.1])
        self.assertEqual(list(code[:, 0]), [1, 2, 10])           # 10 = v2 used where nothing ships
        cap = np.zeros((2, G.NC), bool)
        cap[0, G.XCELL[:, 4]] = True
        P = np.random.default_rng(1).random((2, G.NC))
        Fx = S.fix_grid(P, cap)
        self.assertTrue(np.isnan(Fx[0, G.XCELL[:, 4]]).all())
        np.testing.assert_allclose(Fx[1][G.XCELL], A.monotone_fix(P[1][G.XCELL]))
        np.testing.assert_allclose(Fx[:, G.ACELL], P[:, G.ACELL])


class TestScoreSet(unittest.TestCase):
    def test_small_set_has_no_draw_and_cannot_ship(self):
        rng = np.random.default_rng(4)
        n = 200
        Q = {"y": (rng.random(n) < 0.3).astype(float), "t": rng.integers(0, 20, n), "unit": rng.integers(0, 9, n),
             "reserve": rng.integers(0, 2, n), "fold": np.zeros(n, dtype=np.int16)}
        pr = {k: np.full(n, 0.3) for k in ("v2", "v3", "v3s", "own", "pop")}
        out = S.score_set(Q, pr, np.unique(Q["t"]), None, ["F"], ["USDC", "USDT"])
        f = S.flags_of(out)
        self.assertFalse(any(f[r]["pop"] for r in S.RUNGS))
        self.assertEqual(out["g7"]["v3"]["label"], "LOW")
        self.assertEqual(S.ship_rung(f, {r: "LOW" for r in S.RUNGS}, {r: 0.0 for r in S.RUNGS})[0], None)


class TestDepositLog(unittest.TestCase):
    def test_refuses_without_dry_run_and_guards_chain(self):
        import tempfile
        import b3_deposit_log as L
        with self.assertRaises(SystemExit):
            L.main(["--b3-out", "/nonexistent", "--out", "/nonexistent"])
        panel = {"USDC": [{"rank": 1, "address": "0x" + "ab" * 20, "segment": "w1", "balance_usd": 5e6, "cells": {
            "x10_24h": {"p": 0.1, "capped": False, "capped_text": None, "rung": "v2", "display": "model",
                        "label_final": "HIGH", "holdout_outcome": "confirmed", "history": "h"},
            "all_24h": {"p": None, "capped": False, "capped_text": None, "rung": None, "display": "history",
                        "label_final": "LOW", "holdout_outcome": None, "history": "h"}}}]}
        with tempfile.TemporaryDirectory() as d:
            iss = L.build_issue(panel, {"mode": "dry-run"}, "2026-10-14T05:00:00Z")
            self.assertEqual(iss["n_rows"], 2)
            self.assertEqual([r["status"] for r in iss["rows"]], ["pending", "history_only"])
            p1 = L.write_issue(d, iss, "2026-10-14T05:00:00Z")
            with self.assertRaises(SystemExit):
                L.write_issue(d, iss, "2026-10-14T06:00:00Z")          # same day
            p2 = L.write_issue(d, iss, "2026-10-15T05:00:00Z")
            import json
            j2 = json.load(open(p2))
            self.assertEqual(j2["prevFile"], os.path.basename(p1))
            self.assertEqual(j2["prevSha256"], L.sha256_bytes(open(p1, "rb").read()))
            with open(p1, "a") as f:
                f.write(" ")                                              # tamper with the chain
            with self.assertRaises(SystemExit):
                L.write_issue(d, iss, "2026-10-16T05:00:00Z")


if __name__ == "__main__":
    unittest.main()
