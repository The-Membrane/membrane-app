"""Unit tests for a8_touch.py (Q26 R8.3): the deep-only low-regime floor, the monotone fix after it (fHD == fH outside
(low, deep)), (a)/(f)/(fH)/(fHF) equal A6/A7's exactly, no look-ahead (incl. the regime), the verdict rule and the
blind-7 gate.

Run: python3 -m unittest scripts/research/history-forecasts/test_a8_touch.py
"""

import json
import os
import sys
import tempfile
import unittest
import warnings

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import a8_touch as M  # noqa: E402
import a7_touch as M7  # noqa: E402
import a6_touch as M6  # noqa: E402
import a3_touch as M3  # noqa: E402
import a_touch as A  # noqa: E402
from test_a6_touch import walk, ser6  # noqa: E402

warnings.filterwarnings("ignore")


class TestRungMath(unittest.TestCase):
    def test_deep_mask(self):
        np.testing.assert_array_equal(M.deep_mask((-0.02, -0.15, -0.2, -0.25, -0.30, -0.40)),
                                      [False, False, True, True, True, True])
        self.assertEqual(tuple(float(k) for k in M.DEEP), (-0.2, -0.25, -0.3, -0.4))
        np.testing.assert_array_equal(M.deep_mask(M.LADDER), [k in M.DEEP for k in M.LADDER])
        self.assertEqual(M.REGIMES[M.LOW], "low")

    def test_floor_only_low_deep(self):
        pH = np.array([[0.30, 0.10, 0.01], [0.30, 0.10, 0.01], [0.30, 0.10, 0.01]])
        pa = np.array([[0.80, 0.40, 0.04], [0.80, 0.40, 0.04], [0.80, 0.40, np.nan]])
        low = np.array([True, False, True])
        deep = np.array([False, True, True])
        out = M.floor_fHD(pH, pa, low, deep)
        np.testing.assert_allclose(out, [[0.30, 0.30, 0.03], [0.30, 0.10, 0.01], [0.30, 0.30, 0.01]])
        rng = np.random.default_rng(5)
        h, a = rng.random((40, 6)), rng.random((40, 6))
        lo, dp = rng.random(40) < 0.5, np.array([0, 0, 0, 1, 1, 1], bool)
        f = M.floor_fHD(h, a, lo, dp)
        cell = lo[:, None] & dp[None, :]
        np.testing.assert_array_equal(f[~cell], h[~cell])
        np.testing.assert_array_equal(f[cell], np.fmax(h, 0.75 * a)[cell])
        # equals fHF on the (low, deep) cells
        np.testing.assert_array_equal(f[cell], M7.floor_fHF(h, a)[cell])
        # 3-D grids (n, T, K)
        h3, a3 = rng.random((40, 3, 6)), rng.random((40, 3, 6))
        f3 = M.floor_fHD(h3, a3, lo, dp)
        for t in range(3):
            np.testing.assert_array_equal(f3[:, t], M.floor_fHD(h3[:, t], a3[:, t], lo, dp))

    def test_fix_after_floor_leaves_outside_unchanged(self):
        rng = np.random.default_rng(7)
        for _ in range(20):
            raw = np.sort(rng.random((30, 4, 6)), axis=-1)[..., ::-1]     # arbitrary raw grids
            a = rng.random((30, 4, 6))
            lo = rng.random(30) < 0.5
            dp = np.array([0, 0, 0, 0, 1, 1], bool)
            fH = A.monotone_fix(raw)
            fD = A.monotone_fix(M.floor_fHD(raw, a, lo, dp))
            outside = ~np.broadcast_to(lo[:, None, None] & dp[None, None, :], fH.shape)
            np.testing.assert_array_equal(fD[outside], fH[outside])
            self.assertTrue(np.all(fD >= fH))
            self.assertTrue(np.all(np.diff(fD, axis=-1) <= 0) and np.all(np.diff(fD, axis=-2) >= 0))
            # a raised deep value never exceeds the shallowest non-deep value of its row and T (-10% here)
            self.assertTrue(np.all(fD[..., 4:] <= fD[..., 3:4] + 0.0))


class TestSyntheticRungs(unittest.TestCase):
    T = 24
    qs = 24 * 480                                          # the synthetic walk is in the low regime ~day 480-555

    def build(self, cut=None, seed=11):
        c, lo, hi = walk(24 * 640, seed=seed, nulls=(9000,))
        if cut is not None:
            rng = np.random.default_rng(99)
            f = np.exp(rng.normal(0, 0.05, len(c) - cut))
            c, lo, hi = c.copy(), lo.copy(), hi.copy()
            c[cut:] *= f
            lo[cut:] *= f * 0.97
            hi[cut:] *= f * 1.04
        return ser6(c, lo, hi)

    def low_te(self, s, n=4):
        lows = np.where(s.regime[self.qs:self.qs + 24 * 60] == M.LOW)[0] + self.qs
        others = np.where(s.regime[self.qs:self.qs + 24 * 60] != M.LOW)[0] + self.qs
        return np.sort(np.concatenate([lows[:n], others[:n]]))

    def test_synthetic_has_low_and_other_regimes(self):
        s = self.build()
        te = self.low_te(s)
        g = s.regime[te]
        self.assertTrue((g == M.LOW).any() and (g != M.LOW).any())

    def test_a_f_fH_fHF_equal_a6_a7_exactly(self):
        s = self.build()
        te = self.low_te(s)
        for T_h in (6, 24, 168):
            o6 = M6.fold_predict6(s, M6.Prep6(s, T_h), T_h, self.qs, te)
            o7 = M7.predict7(s, M6.Prep6(s, T_h, with_fbL=False), T_h, self.qs, te)
            o8 = M.predict8(s, M6.Prep6(s, T_h, with_fbL=False), T_h, self.qs, te)
            for r in ("a", "f", "fH"):
                np.testing.assert_array_equal(o8["raw"][r], o6["raw"][r], err_msg=f"{r} T={T_h}")
            np.testing.assert_array_equal(o8["raw"]["fHF"], o7["raw"]["fHF"])
            low = s.regime[te] == M.LOW
            exp = np.where(low[:, None] & M.deep_mask(s.levels)[None, :],
                           np.fmax(o6["raw"]["fH"], 0.75 * o6["raw"]["a"]), o6["raw"]["fH"])
            np.testing.assert_array_equal(o8["raw"]["fHD"], exp)
            self.assertEqual(o8["fit"]["low_rows"], int(low.sum()))

    def test_regime_override_controls_cells(self):
        s = self.build()
        te = np.array([self.qs, self.qs + 6, self.qs + 30])
        s.regime = s.regime.copy()
        s.regime[te] = np.array([0, 1, -1], np.int8)                 # low, mid, undefined
        o = M.predict8(s, M6.Prep6(s, self.T, with_fbL=False), self.T, self.qs, te)
        np.testing.assert_array_equal(o["raw"]["fHD"][1:], o["raw"]["fH"][1:])
        dm = M.deep_mask(s.levels)
        np.testing.assert_array_equal(o["raw"]["fHD"][0, ~dm], o["raw"]["fH"][0, ~dm])
        np.testing.assert_array_equal(o["raw"]["fHD"][0, dm], np.fmax(o["raw"]["fH"], 0.75 * o["raw"]["a"])[0, dm])

    def test_no_look_ahead(self):
        s0 = self.build()
        te = self.low_te(s0)

        def fit(s):
            return M.predict8(s, M6.Prep6(s, self.T, with_fbL=False), self.T, self.qs, te)
        o0 = fit(s0)
        s1 = self.build(cut=self.qs)                       # data at/after Q_start changed
        o1 = fit(s1)
        np.testing.assert_array_equal(o0["fit"]["har"], o1["fit"]["har"])
        np.testing.assert_array_equal(o0["raw"]["a"], o1["raw"]["a"])        # (a) is the training frequency only
        i0 = int(np.where(te == te[0])[0][0])
        self.assertEqual(s0.regime[te[0]], s1.regime[te[0]])
        for r in M.CANDIDATES:
            np.testing.assert_array_equal(o0["raw"][r][i0], o1["raw"][r][i0])
        s2 = self.build(cut=int(te[-1]))                   # data after the last test origin changed
        np.testing.assert_array_equal(s0.regime[te], s2.regime[te])         # the regime uses closes before t0 only
        o2 = fit(s2)
        for r in M.CANDIDATES:
            np.testing.assert_array_equal(o0["raw"][r], o2["raw"][r])

    def test_assemble_matches_a7_and_floor_stats(self):
        s = self.build()
        folds = [{"name": "F1", "qs_i": self.qs, "qe_i": self.qs + 24 * 40}]
        per8, per7 = {}, {}
        for T_h in M.HORIZONS_H:
            per8[T_h] = M.fold_loop8(s, M6.Prep6(s, T_h, with_fbL=False), T_h, folds)
            per7[T_h] = M7.fold_loop7(s, M6.Prep6(s, T_h, with_fbL=False), T_h, folds)
        R8, har = M.assemble8(s, folds, per8)
        R7, _ = M7.assemble7(s, folds, per7)
        for c in ("t0_i", "T_h", "k_i", "y", "regime", "p_a", "p_f", "p_fH", "p_fHF"):
            np.testing.assert_array_equal(R8[c], R7[c], err_msg=c)
        dm = M.deep_mask(s.levels)[R8["k_i"]]
        cell = (R8["regime"] == M.LOW) & dm
        self.assertTrue(cell.any())
        np.testing.assert_array_equal(R8["p_fHD"][~cell], R8["p_fH"][~cell])
        self.assertTrue(np.all(R8["p_fHD"] >= R8["p_fH"]))
        self.assertTrue(np.any(R8["p_fHD"] > R8["p_fH"]))             # the floor binds somewhere (non-trivial test)
        self.assertTrue(np.all(R8["p_fHD"] <= R8["p_fHF"] + 1e-15))
        fl = M.floor_stats(R8)
        self.assertEqual(set(fl), set(M.T_LABEL.values()))
        red = M.reduce8(R8)
        self.assertIn("fHD_vs_fH", red[24]["comp"])
        pr = M.pooled8({"x": red}, ["x"], 24)
        np.testing.assert_array_equal(pr["comp"]["fHD_vs_fH"]["pooled"][0], red[24]["comp"]["fHD_vs_fH"]["pooled"][0])
        self.assertEqual(len(har), len(M.HORIZONS_H))

    def test_scoring_pipeline_smoke(self):
        s = self.build()
        q0 = 24 * 400
        folds = [{"name": f"F{i}", "qs_i": q0 + 24 * 60 * i, "qe_i": q0 + 24 * 60 * (i + 1)} for i in range(3)]
        per8 = {T_h: M.fold_loop8(s, M6.Prep6(s, T_h, with_fbL=False), T_h, folds) for T_h in M.HORIZONS_H}
        R, _ = M.assemble8(s, folds, per8)
        res, boot = M.score_dev(R, np.random.default_rng(1))
        deep, preview, fl, summary = M.dev_tables(R, res)
        self.assertIn("fHD_vs_fH", res["1d"]["comparisons"])
        self.assertIn("regime_low", res["1d"]["corp"]["fHD"])
        # adding rungs/comparisons leaves the shared draws: A7's comparisons are identical under the same seed
        per7 = {T_h: M7.fold_loop7(s, M6.Prep6(s, T_h, with_fbL=False), T_h, folds) for T_h in M.HORIZONS_H}
        R7, _ = M7.assemble7(s, folds, per7)
        R7["levels"] = list(s.levels)
        res7, _ = M7.score_dev(R7, np.random.default_rng(1))
        for TL in res7:
            for c in M.A7_COMPARISONS:
                self.assertEqual(A._clean(res[TL]["comparisons"][c]), A._clean(res7[TL]["comparisons"][c]))
        M._SER.clear()
        M._SER.update({"syn": s, "__folds__": {"syn": folds}})
        out = M.series_task("syn")
        pooled = M.pooled_block({"syn": out["reduced"]}, ["syn"], np.random.default_rng(2))
        v = M.verdict8(pooled)
        self.assertIn(v["verdict"], ("PASS", "FAIL"))
        with tempfile.TemporaryDirectory() as d:
            A.write_json(os.path.join(d, "x.json"), {"res": res, "boot": boot, "deep": deep, "preview": preview,
                                                     "fl": fl, "summary": summary, "pooled": pooled, "v": v})


class TestVerdict(unittest.TestCase):
    def pooled(self, RH, RD, lo, n=20, lo_by_T=None):
        lv = {repr(float(k)): {"fH": {g: {"R": RH, "n_ep": n} for g in M.REGIMES},
                               "fHD": {g: {"R": RD, "n_ep": n} for g in M.REGIMES}} for k in M.DEEP}
        return {M.T_LABEL[T]: {"levels": lv, "comparisons": {"fHD_vs_fH": {"ci95": [(lo_by_T or {}).get(T, lo), 0.01]}}}
                for T in M.HORIZONS_H}

    def test_pass_and_fail(self):
        self.assertEqual(M.verdict8(self.pooled(0.6, 0.9, -0.001))["verdict"], "PASS")
        self.assertEqual(M.verdict8(self.pooled(0.6, 0.9, -0.003))["verdict"], "FAIL")    # Brier part
        self.assertEqual(M.verdict8(self.pooled(0.9, 0.6, 0.001))["verdict"], "FAIL")     # deep R part
        self.assertEqual(M.verdict8(self.pooled(0.6, 0.6, 0.001))["verdict"], "FAIL")     # tie is not smaller
        self.assertEqual(M.verdict8(self.pooled(0.6, 0.9, 0.0, lo_by_T={168: -0.0021}))["verdict"], "FAIL")  # 7d
        # outside the verdict T (1h, 30d) a low CI bound does not matter
        self.assertEqual(M.verdict8(self.pooled(0.6, 0.9, 0.0, lo_by_T={1: -0.5, 720: -0.5}))["verdict"], "PASS")
        v = M.verdict8(self.pooled(0.6, 0.9, 0.0, n=5))                                    # too few episodes
        self.assertEqual((v["low_deep_cells"], v["verdict"]), (0, "FAIL"))


class TestBlind7Gate(unittest.TestCase):
    def setup_dir(self, d, dev_sha=None, code_sha="c" * 64):
        with open(os.path.join(d, "frozen-a8.json"), "w") as fh:
            json.dump({"code_sha256": code_sha}, fh)
        sha = A.sha256_file(os.path.join(d, "frozen-a8.json"))
        with open(os.path.join(d, "frozen-a8.json.sha256"), "w") as fh:
            fh.write(f"{sha}  frozen-a8.json\n")
        with open(os.path.join(d, "results-dev-a8.json"), "w") as fh:
            json.dump({"frozen_file": {"sha256": dev_sha or sha}}, fh)
        return sha

    def run7(self, d, commit, fsha, code_sha="c" * 64, note=None):
        return M.run_blind7("/nonexistent", d, commit, fsha, workers=1, log=lambda *a: None, require_clean=False,
                            code_sha=code_sha, code_change_note=note)

    def test_refusals(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(SystemExit) as cm:
                self.run7(d, "abc", "x")
            self.assertIn("must exist", str(cm.exception))
            sha = self.setup_dir(d)
            with self.assertRaises(SystemExit) as cm:
                self.run7(d, None, sha)
            self.assertIn("blind7-commit", str(cm.exception))
            with self.assertRaises(SystemExit) as cm:
                self.run7(d, "abc", None)
            self.assertIn("frozen-sha256", str(cm.exception))
            with self.assertRaises(SystemExit) as cm:
                self.run7(d, "abc", "0" * 64)
            self.assertIn("sha256", str(cm.exception))
            with self.assertRaises(SystemExit) as cm:
                self.run7(d, "abc", sha, code_sha="d" * 64)                 # code changed since the freeze
            self.assertIn("code-change-note", str(cm.exception))
            self.assertFalse(os.path.exists(os.path.join(d, "blind7-run.started")))
            with open(os.path.join(d, "blind7-run.started"), "w") as fh:
                fh.write("x")
            with self.assertRaises(SystemExit) as cm:
                self.run7(d, "abc", sha)
            self.assertIn("once", str(cm.exception))
            self.assertFalse(os.path.exists(os.path.join(d, "results-blind7.json")))

    def test_code_change_note_recorded(self):
        with tempfile.TemporaryDirectory() as d:
            sha = self.setup_dir(d)
            _, _, _, cc = M.blind7_gate(d, "abc", sha, "reporting-only addition", code_sha="d" * 64)
            self.assertEqual((cc["unchanged"], cc["code_change_note"]), (False, "reporting-only addition"))
            _, _, _, cc = M.blind7_gate(d, "abc", sha, None, code_sha="c" * 64)
            self.assertTrue(cc["unchanged"])

    def test_dev_record_mismatch_refuses(self):
        with tempfile.TemporaryDirectory() as d:
            sha = self.setup_dir(d, dev_sha="1" * 64)
            with self.assertRaises(SystemExit) as cm:
                self.run7(d, "abc", sha)
            self.assertIn("sha256", str(cm.exception))

    def test_marker_written_before_reading_and_second_run_refused(self):
        with tempfile.TemporaryDirectory() as d:
            sha = self.setup_dir(d)
            with self.assertRaises(BaseException):                     # no datasets: fails after the marker
                self.run7(d, "deadbeef", sha)
            with open(os.path.join(d, "blind7-run.started")) as fh:
                mk = json.loads(fh.read())
            self.assertEqual(mk["frozen_sha256"], sha)
            with self.assertRaises(SystemExit) as cm:
                self.run7(d, "deadbeef", sha)
            self.assertIn("once", str(cm.exception))

    def test_main_refuses_before_reading_inputs(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(SystemExit) as cm:
                M.main(["--datasets", "/nonexistent", "--out", d, "--phase", "blind7"])
            self.assertIn("must exist", str(cm.exception))

    def test_dev_refuses_twice(self):
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "frozen-a8.json"), "w") as fh:
                fh.write("{}")
            with self.assertRaises(SystemExit) as cm:
                M.run_dev("/nonexistent", d, {}, workers=1, log=lambda *a: None, require_clean=False)
            self.assertIn("scored once", str(cm.exception))


if __name__ == "__main__":
    unittest.main()
