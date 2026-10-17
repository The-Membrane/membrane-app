"""Unit tests for a7_touch.py (Q26 R7.4): floor math, monotone fix after the floor, (a)/(f)/(fH) equal A6's exactly,
no look-ahead, the verdict rule and the blind-6 gate.

Run: python3 -m unittest scripts/research/history-forecasts/test_a7_touch.py
"""

import json
import os
import sys
import tempfile
import unittest
import warnings

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import a7_touch as M  # noqa: E402
import a6_touch as M6  # noqa: E402
import a3_touch as M3  # noqa: E402
import a_touch as A  # noqa: E402
from test_a6_touch import walk, ser6  # noqa: E402

warnings.filterwarnings("ignore")


class TestFloorMath(unittest.TestCase):
    def test_floor_values(self):
        pH = np.array([[0.30, 0.10, 0.01], [0.05, 0.02, 0.0]])
        pa = np.array([[0.20, 0.20, 0.04], [0.40, np.nan, 0.0]])
        out = M.floor_fHF(pH, pa)
        np.testing.assert_allclose(out, [[0.30, 0.15, 0.03], [0.30, 0.02, 0.0]])
        self.assertEqual(M.FLOOR, 0.75)
        # never below fH, never below 0.75 a, equal to one of them
        rng = np.random.default_rng(3)
        a, h = rng.random((50, 6)), rng.random((50, 6))
        f = M.floor_fHF(h, a)
        self.assertTrue(np.all(f >= h) and np.all(f >= 0.75 * a))
        self.assertTrue(np.all((f == h) | (f == 0.75 * a)))

    def test_monotone_fix_after_floor(self):
        # raw grid (n=1, T=2, K=3): the floor can break monotonicity in k; the fix restores it
        pH = np.array([[[0.20, 0.05, 0.01], [0.30, 0.10, 0.02]]])
        pa = np.array([[[0.10, 0.12, 0.02], [0.10, 0.10, 0.01]]])
        raw = M.floor_fHF(pH, pa)                           # [0.2, 0.09, 0.015], [0.3, 0.1, 0.02]
        fixed = A.monotone_fix(raw)
        self.assertTrue(np.all(np.diff(fixed, axis=-1) <= 0) and np.all(np.diff(fixed, axis=-2) >= 0))
        np.testing.assert_allclose(fixed, [[[0.20, 0.09, 0.015], [0.30, 0.10, 0.02]]])
        # when the floor never binds, fHF == fH exactly (after the fix too)
        pa0 = pH / 2
        np.testing.assert_array_equal(A.monotone_fix(M.floor_fHF(pH, pa0)), A.monotone_fix(pH))


class TestSyntheticRungs(unittest.TestCase):
    T = 24
    qs = 24 * 560

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

    def test_a_f_fH_equal_a6_exactly(self):
        s = self.build()
        te = np.array([self.qs, self.qs + 6, self.qs + 30, self.qs + 300])
        for T_h in (6, 24, 168):
            o6 = M6.fold_predict6(s, M6.Prep6(s, T_h), T_h, self.qs, te)
            o7 = M.predict7(s, M6.Prep6(s, T_h, with_fbL=False), T_h, self.qs, te)
            for r in ("a", "f", "fH"):
                np.testing.assert_array_equal(o7["raw"][r], o6["raw"][r], err_msg=f"{r} T={T_h}")
            self.assertEqual(o7["fit"]["har"], o6["fit"]["har"])
            np.testing.assert_array_equal(o7["raw"]["fHF"], np.fmax(o6["raw"]["fH"], 0.75 * o6["raw"]["a"]))
        # with an external (a) source (the dev oracle series), as A6 dev_task
        Pa = M3.Prep3(self.build(seed=12), self.T, beta_select=False)
        o6 = M6.fold_predict6(s, M6.Prep6(s, self.T), self.T, self.qs, te, P_a=Pa)
        o7 = M.predict7(s, M6.Prep6(s, self.T, with_fbL=False), self.T, self.qs, te, P_a=Pa)
        for r in ("a", "f", "fH"):
            np.testing.assert_array_equal(o7["raw"][r], o6["raw"][r])

    def test_fH_fallback_matches_a6(self):
        s = self.build()
        te = np.array([self.qs, self.qs + 6])
        P6a, P6b = M6.Prep6(s, self.T), M6.Prep6(s, self.T, with_fbL=False)
        for P in (P6a, P6b):
            P.okX = P.okX.copy()
            P.okX[te[1]] = False
        o6 = M6.fold_predict6(s, P6a, self.T, self.qs, te)
        o7 = M.predict7(s, P6b, self.T, self.qs, te)
        np.testing.assert_array_equal(o7["raw"]["fH"], o6["raw"]["fH"])
        np.testing.assert_array_equal(o7["raw"]["fH"][1], o7["raw"]["f"][1])
        self.assertEqual(o7["fit"]["fH_fallback_rows"], 1)

    def test_no_look_ahead(self):
        te = np.array([self.qs, self.qs + 6, self.qs + 30])

        def fit(s):
            return M.predict7(s, M6.Prep6(s, self.T, with_fbL=False), self.T, self.qs, te)
        o0 = fit(self.build())
        o1 = fit(self.build(cut=self.qs))                  # data at/after Q_start changed
        np.testing.assert_array_equal(o0["fit"]["har"], o1["fit"]["har"])
        for r in M.CANDIDATES:
            np.testing.assert_array_equal(o0["raw"][r][0], o1["raw"][r][0])
            np.testing.assert_array_equal(o0["raw"]["a"], o1["raw"]["a"])    # (a) is the training frequency only
        o2 = fit(self.build(cut=int(te[-1])))               # data after the last test origin changed
        for r in M.CANDIDATES:
            np.testing.assert_array_equal(o0["raw"][r], o2["raw"][r])

    def test_assemble_matches_a6_and_floor_stats(self):
        s = self.build()
        folds = [{"name": "F1", "qs_i": self.qs, "qe_i": self.qs + 24 * 20}]
        per7, per6 = {}, {}
        for T_h in M.HORIZONS_H:
            per7[T_h] = M.fold_loop7(s, M6.Prep6(s, T_h, with_fbL=False), T_h, folds)
            per6[T_h] = M6.fold_loop(s, M6.Prep6(s, T_h), T_h, folds)
        R7, har = M.assemble7(s, folds, per7)
        R6, _, _ = M6.assemble6(s, folds, per6)
        for c in ("t0_i", "T_h", "k_i", "y", "regime", "p_a", "p_f", "p_fH"):
            np.testing.assert_array_equal(R7[c], R6[c], err_msg=c)
        self.assertTrue(np.all(R7["p_fHF"] >= R7["p_fH"] - 1e-15))
        self.assertTrue(np.all(R7["p_fHF"] >= 0.75 * R7["p_a"] - 1e-12))
        fl = M.floor_stats(R7)
        self.assertEqual(set(fl), set(M.T_LABEL.values()))
        red = M.reduce7(R7)
        self.assertIn("fHF_vs_fH", red[24]["comp"])
        pr = M.pooled7({"x": red}, ["x"], 24)
        np.testing.assert_array_equal(pr["comp"]["fHF_vs_fH"]["pooled"][0], red[24]["comp"]["fHF_vs_fH"]["pooled"][0])
        self.assertEqual(len(har), len(M.HORIZONS_H))


class TestVerdict(unittest.TestCase):
    def pooled(self, RH, RF, lo, n=20):
        lv = {repr(float(k)): {"fH": {g: {"R": RH, "n_ep": n} for g in M.REGIMES},
                               "fHF": {g: {"R": RF, "n_ep": n} for g in M.REGIMES}} for k in M.DEEP}
        return {M.T_LABEL[T]: {"levels": lv, "comparisons": {"fHF_vs_fH": {"ci95": [lo, 0.01]}}}
                for T in M.HORIZONS_H}

    def test_pass_and_fail(self):
        self.assertEqual(M.verdict7(self.pooled(0.6, 0.9, -0.001))["verdict"], "PASS")
        self.assertEqual(M.verdict7(self.pooled(0.6, 0.9, -0.003))["verdict"], "FAIL")   # Brier part
        self.assertEqual(M.verdict7(self.pooled(0.9, 0.6, 0.001))["verdict"], "FAIL")    # deep R part
        v = M.verdict7(self.pooled(0.6, 0.9, 0.0, n=5))                                   # too few episodes
        self.assertEqual((v["low_deep_cells"], v["verdict"]), (0, "FAIL"))


class TestBlind6Gate(unittest.TestCase):
    def setup_dir(self, d, dev_sha=None):
        with open(os.path.join(d, "frozen-a7.json"), "w") as fh:
            fh.write("{}")
        sha = A.sha256_file(os.path.join(d, "frozen-a7.json"))
        with open(os.path.join(d, "frozen-a7.json.sha256"), "w") as fh:
            fh.write(f"{sha}  frozen-a7.json\n")
        with open(os.path.join(d, "results-dev-a7.json"), "w") as fh:
            json.dump({"frozen_file": {"sha256": dev_sha or sha}}, fh)
        return sha

    def run6(self, d, commit, fsha):
        return M.run_blind6("/nonexistent", d, commit, fsha, workers=1, log=lambda *a: None, require_clean=False)

    def test_refusals(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(SystemExit) as cm:
                self.run6(d, "abc", "x")
            self.assertIn("must exist", str(cm.exception))
            sha = self.setup_dir(d)
            with self.assertRaises(SystemExit) as cm:
                self.run6(d, None, sha)
            self.assertIn("blind6-commit", str(cm.exception))
            with self.assertRaises(SystemExit) as cm:
                self.run6(d, "abc", None)
            self.assertIn("frozen-sha256", str(cm.exception))
            with self.assertRaises(SystemExit) as cm:
                self.run6(d, "abc", "0" * 64)
            self.assertIn("sha256", str(cm.exception))
            with open(os.path.join(d, "blind6-run.started"), "w") as fh:
                fh.write("x")
            with self.assertRaises(SystemExit) as cm:
                self.run6(d, "abc", sha)
            self.assertIn("once", str(cm.exception))
            self.assertFalse(os.path.exists(os.path.join(d, "results-blind6.json")))

    def test_dev_record_mismatch_refuses(self):
        with tempfile.TemporaryDirectory() as d:
            sha = self.setup_dir(d, dev_sha="1" * 64)
            with self.assertRaises(SystemExit) as cm:
                self.run6(d, "abc", sha)
            self.assertIn("sha256", str(cm.exception))

    def test_marker_written_before_reading_and_second_run_refused(self):
        with tempfile.TemporaryDirectory() as d:
            sha = self.setup_dir(d)
            with self.assertRaises(SystemExit):                      # no datasets: fails after the marker
                self.run6(d, "deadbeef", sha)
            self.assertTrue(os.path.exists(os.path.join(d, "blind6-run.started")))
            with self.assertRaises(SystemExit) as cm:
                self.run6(d, "deadbeef", sha)
            self.assertIn("once", str(cm.exception))

    def test_main_refuses_before_reading_inputs(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(SystemExit) as cm:
                M.main(["--datasets", "/nonexistent", "--out", d, "--phase", "blind6"])
            self.assertIn("must exist", str(cm.exception))

    def test_dev_refuses_twice(self):
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "frozen-a7.json"), "w") as fh:
                fh.write("{}")
            with self.assertRaises(SystemExit) as cm:
                M.run_dev("/nonexistent", d, {}, workers=1, log=lambda *a: None, require_clean=False)
            self.assertIn("scored once", str(cm.exception))


if __name__ == "__main__":
    unittest.main()
