#!/usr/bin/env python3
"""Unit tests for a5_touch.py on synthetic data only (no dataset read, no score).

  python3 -m unittest scripts/research/history-forecasts/test_a5_touch.py -v
"""
import math
import os
import sys
import tempfile
import unittest
import warnings

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import a5_touch as M  # noqa: E402
import a3_touch as M3  # noqa: E402
import a_touch as A  # noqa: E402

warnings.filterwarnings("ignore")


def walk(n, seed=1, vol=0.01, nulls=()):
    rng = np.random.default_rng(seed)
    r = rng.normal(0, vol, n) * (1 + 2 * (np.sin(np.arange(n) / 700.0) > 0.3))
    c = 100 * np.exp(np.cumsum(r))
    lo = c * np.exp(-np.abs(rng.normal(0, vol / 2, n)))
    for j in nulls:
        c[j] = np.nan
        lo[j] = np.nan
    return c, lo


def ser_of(c, lo, levels=(-0.02, -0.05, -0.07, -0.10, -0.20, -0.30), asset="ETH"):
    return M3.S3("syn", asset, "syn", c, lo, levels, M3.BASE_DEV, M3.BASE_DEV)


class TestFbL(unittest.TestCase):
    def setUp(self):
        n = 24 * 500
        c, lo = walk(n, seed=5, nulls=(7000,))
        self.s = ser_of(c, lo)
        self.T = 24
        self.P5 = M.Prep5(self.s, self.T)

    def test_bands(self):
        self.assertEqual(self.P5.bands.tolist(), [0, 0, 1, 1, 2, 2])
        self.assertEqual(M.band_of("stETH", A.LEVELS["stETH"]).tolist(), [0, 0, 0, 0])

    def test_per_band_brier_bookkeeping_and_choice(self):
        s, P5, T = self.s, self.P5, self.T
        P = P5.P
        y = s.labels(T)
        lab = np.isfinite(y[:, 0])
        sc = math.sqrt(T / 8760)
        qs = 24 * 480
        ch = P5.choose(qs)
        ev = np.where(np.diff(np.concatenate([[0], P5.cumE])) > 0)[0]
        ev = ev[ev + T <= qs]
        self.assertEqual(ch[0][1]["n_eval"], len(ev))
        b = 0.5
        sig = s.sigma_beta(b)
        for t in ev[::200][:3]:
            src = [u for u in range(0, t - T + 1) if lab[u] and np.isfinite(sig[u])]
            z = np.sort([math.log(s.wmin(T)[u] / s.spot[u]) / (sig[u] * sc) for u in src])
            p = np.searchsorted(z, np.log1p(np.array(s.levels)) / (sig[t] * sc), side="right") / len(z)
            for bb in range(3):
                cols = P5.bands == bb
                want = float(np.sum((p[cols] - y[t][cols]) ** 2))
                self.assertAlmostEqual(want, P5.cumSE[(b, bb)][t] - P5.cumSE[(b, bb)][t - 1], places=12)
        for bb in range(3):
            beta, info = ch[bb]
            self.assertEqual(beta, M3.pick_beta(info["brier"]))
        del P

    def test_fbL_uses_each_bands_beta(self):
        s, P5, T = self.s, self.P5, self.T
        qs = 24 * 480
        te = np.array([qs, qs + 6])
        o = M.predict5(s, P5, T, qs, te)
        for bb, (b, _) in P5.choose(qs).items():
            fb = M3.predict3(s, P5.P, T, qs, te, b)["raw"]["fb"]
            cols = P5.bands == bb
            np.testing.assert_allclose(o["raw"]["fbL"][:, cols], fb[:, cols], atol=1e-15)
        np.testing.assert_allclose(o["raw"]["f"], M3.predict3(s, P5.P, T, qs, te, 1.0)["raw"]["f"])

    def test_identity_resample_reproduces_fbL(self):
        s, P5, T = self.s, self.P5, self.T
        qs = 24 * 480
        te = np.array([qs])
        days, _, _ = M.M4.fold_days(s, P5.P.lab_ok, T, qs)
        smp = M.band_samples_fbL(s, P5, qs, te, np.ones((2, len(days))))
        o = M.predict5(s, P5, T, qs, te)
        np.testing.assert_allclose(smp[1], o["raw"]["fbL"], atol=1e-12)

    def test_no_evaluation_origin_gives_half(self):
        c, lo = walk(24 * 200, seed=9)
        s = ser_of(c, lo)
        P5 = M.Prep5(s, 24)
        ch = P5.choose(24 * 150)
        self.assertTrue(all(v[0] == 0.5 and v[1]["n_eval"] == 0 for v in ch.values()))


class TestReducedStats(unittest.TestCase):
    def make_R(self, seed, n_days=400):
        rng = np.random.default_rng(seed)
        rows = []
        t0 = 2 + 6 * np.arange(n_days * 4)
        R = {k: [] for k in ("t0_i", "fold_i", "T_h", "k_i", "k", "y", "regime")}
        R.update({f"p_{r}": [] for r in M.RUNGS})
        for T_h in M.HORIZONS_H:
            for j, k in enumerate(M.LADDER):
                y = (rng.random(len(t0)) < 0.1).astype(float)
                R["t0_i"].append(t0)
                R["fold_i"].append(t0 // (6 * 360))
                R["T_h"].append(np.full(len(t0), T_h))
                R["k_i"].append(np.full(len(t0), j))
                R["k"].append(np.full(len(t0), k))
                R["y"].append(y)
                R["regime"].append(rng.integers(-1, 3, len(t0)))
                for r in M.RUNGS:
                    p = np.clip(0.1 + rng.normal(0, 0.03, len(t0)), 0, 1)
                    if r == "r30":
                        p[rng.random(len(t0)) < 0.05] = np.nan
                    R[f"p_{r}"].append(p)
        R = {k: np.concatenate(v) for k, v in R.items()}
        R["regime"] = R["regime"].astype(np.int8)
        R["day"] = (M3.BASE_DEV + 3600 * R["t0_i"]) // 86400 + seed * 3
        R["fold_names"] = [f"F{i}" for i in range(int(R["fold_i"].max()) + 1)]
        R["levels"] = list(M.LADDER)
        R["base_ts"] = M3.BASE_DEV
        del rows
        return R

    def test_bss_from_sums_equals_row_level(self):
        R = self.make_R(1)
        red = M.reduce_series(R)
        T_h = 168
        m = R["T_h"] == T_h
        sel = M3.select(R, m)
        days = np.unique(sel["day"])
        pos = np.searchsorted(days, sel["day"])
        cnt = A.replicate_counts(A.block_bootstrap_indices(np.random.default_rng(3), len(days), 30, 300), len(days))
        row = M3.comparisons(sel, pos, len(days), cnt, M.COMPARISONS)
        cmp_, byreg = M.series_comparisons(red[T_h], cnt)
        for c in ("fbL_vs_f", "r30_vs_a"):
            self.assertAlmostEqual(row[c]["bss"], cmp_[c]["bss"], places=12)
            np.testing.assert_allclose(row[c]["ci95"], cmp_[c]["ci95"], atol=1e-12)
        rowreg = M3.comparisons(sel, pos, len(days), cnt, M.COMPARISONS, mask=sel["regime"] == 1)
        self.assertAlmostEqual(rowreg["fbL_vs_a"]["bss"], byreg["mid"]["fbL_vs_a"]["bss"], places=12)
        st = red[T_h]["cells"][repr(float(M.LADDER[2]))]["f"]["low"]
        mk = (sel["k_i"] == 2) & (sel["regime"] == 0)
        self.assertAlmostEqual(st["sum_p"], float(sel["p_f"][mk].sum()))
        self.assertEqual(st["n_ep"], M.M2.count_touch_episodes(sel["t0_i"][mk], sel["y"][mk]))

    def test_pooled_reduced_sums_series(self):
        R1, R2 = self.make_R(1), self.make_R(2)
        reds = {"x": M.reduce_series(R1), "z": M.reduce_series(R2)}
        pr = M.pooled_reduced(reds, ["x", "z"], 24)
        self.assertEqual(len(pr["days"]), len(np.unique(np.concatenate([R1["day"], R2["day"]]))))
        kk = repr(float(M.LADDER[0]))
        a = reds["x"][24]["cells"][kk]["fbL"]["high"]
        b = reds["z"][24]["cells"][kk]["fbL"]["high"]
        c = pr["cells"][kk]["fbL"]["high"]
        self.assertAlmostEqual(c["sum_y"], a["sum_y"] + b["sum_y"])
        self.assertEqual(c["n_ep"], a["n_ep"] + b["n_ep"])
        se_m = pr["comp"]["f_vs_a"]["pooled"][0]
        self.assertAlmostEqual(se_m.sum(), reds["x"][24]["comp"]["f_vs_a"]["pooled"][0].sum() +
                               reds["z"][24]["comp"]["f_vs_a"]["pooled"][0].sum())


class TestRules(unittest.TestCase):
    def test_per_source_rule(self):
        ok, bad, few = {"R": 1.0, "n_ep": 30}, {"R": 0.6, "n_ep": 24}, {"R": 0.2, "n_ep": 9}
        st, used = M.per_source_rule(ok, [("bspan:ETH", ok), ("locked:coinbase-eth-usd", few)])
        self.assertEqual((st, len(used)), ("held", 2))
        st, used = M.per_source_rule(ok, [("bspan:ETH", {"R": 1.32, "n_ep": 47}), ("locked:coinbase-eth-usd", bad)])
        self.assertEqual(st, "sources disagree")
        self.assertFalse(used[-1]["inside"])
        st, _ = M.per_source_rule({"R": 1.6, "n_ep": 12}, [])
        self.assertEqual(st, "sources disagree")

    def test_label_after(self):
        ok, bad = {"R": 1.1, "n_ep": 30}, {"R": 0.6, "n_ep": 24}
        L = M.label_after
        self.assertEqual(L("ETH", "HIGH", "held", ok, ok, True), ("HIGH", "passed checks"))
        self.assertEqual(L("ETH", "HIGH", "sources disagree", ok, ok, True), ("MEDIUM", "sources disagree"))
        self.assertEqual(L("BTC", "HIGH", "held", bad, ok, True), ("MEDIUM", "failed asset-matched"))
        self.assertEqual(L("BTC", "HIGH", "held", ok, bad, True), ("MEDIUM", "failed generic"))
        self.assertEqual(L("stETH", "HIGH", "n/a", None, ok, True), ("HIGH", "passed checks"))
        self.assertEqual(L("ETH", "MEDIUM", "sources disagree", bad, bad, True), ("MEDIUM", "not HIGH"))

    def test_ship_choice_tie_order(self):
        r, info = M.ship_choice(["a", "f", "fbL"], {("f", "a"): True, ("fbL", "a"): True},
                                {"a": 9, "f": 5, "fbL": 5}, {"a": 0, "f": 2, "fbL": 2}, {"a": 0, "f": .05, "fbL": .05})
        self.assertEqual((r, info["removed_by_dominance"]), ("f", ["a"]))
        r, _ = M.ship_choice(["a", "f", "fbL"], {("fbL", "f"): True, ("f", "a"): True, ("fbL", "a"): True},
                             {"a": 0, "f": 5, "fbL": 4}, {"a": 0, "f": 0, "fbL": 0}, {"a": 0, "f": .05, "fbL": .06})
        self.assertEqual(r, "fbL")

    def test_method_verdict(self):
        def lv(Rf, Rb, n=20):
            return {repr(float(k)): {"f": {"low": {"R": Rf, "n_ep": n}, "high": {"R": 1 / Rf, "n_ep": n}},
                                     "fbL": {"low": {"R": Rb, "n_ep": n}, "high": {"R": 1 / Rb, "n_ep": n}}}
                    for k in M.LADDER}
        pooled = {TL: {"levels": lv(0.6, 0.9)} for TL in M.T_LABEL.values()}
        good = {TL: {"fbL_vs_f": {"ci95": [-0.001, 0.003]}} for TL in M.T_LABEL.values()}
        v = M.method_verdict(pooled, good)
        self.assertEqual(v["verdict"], "PASS")
        self.assertEqual(v["deep_cells"], 6 * 4 * 2)
        bad = dict(good)
        bad["7d"] = {"fbL_vs_f": {"ci95": [-0.003, 0.001]}}
        self.assertEqual(M.method_verdict(pooled, bad)["verdict"], "FAIL")
        pooled2 = {TL: {"levels": lv(0.9, 0.6)} for TL in M.T_LABEL.values()}
        self.assertEqual(M.method_verdict(pooled2, good)["verdict"], "FAIL")
        pooled3 = {TL: {"levels": lv(0.6, 0.9, n=9)} for TL in M.T_LABEL.values()}
        self.assertEqual(M.method_verdict(pooled3, good)["deep_cells"], 0)


class TestBlind4Gate(unittest.TestCase):
    def test_refuses_without_freeze_commit_and_twice(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(SystemExit):
                M.run_blind4("/nonexistent", d, {}, "abc", workers=1, log=lambda *a: None)
            for f in ("frozen-a5.json", "results-dev.json"):
                with open(os.path.join(d, f), "w") as fh:
                    fh.write("{}")
            with self.assertRaises(SystemExit) as cm:
                M.run_blind4("/nonexistent", d, {}, None, workers=1, log=lambda *a: None)
            self.assertIn("blind4-commit", str(cm.exception))
            with open(os.path.join(d, "blind4-run.started"), "w") as fh:
                fh.write("x")
            with self.assertRaises(SystemExit) as cm:
                M.run_blind4("/nonexistent", d, {}, "abc", workers=1, log=lambda *a: None)
            self.assertIn("once", str(cm.exception))


if __name__ == "__main__":
    unittest.main()
