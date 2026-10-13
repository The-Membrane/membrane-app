#!/usr/bin/env python3
"""Tests for t1_touch.py on SYNTHETIC data only (no real test-period scores).

Run:  python3 scripts/research/validation/test_t1.py      (or python3 -m pytest that file)
"""
import csv
import gzip
import itertools
import json
import math
import os
import sys
import tempfile
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import t1_touch as t1  # noqa: E402


def isotonic_minmax(y, w):
    """Brute force isotonic regression: f_i = max_{s<=i} min_{t>=i} wavg(y[s..t]) (Barlow et al.)."""
    n = len(y)
    out = np.empty(n)
    for i in range(n):
        best = -np.inf
        for s in range(i + 1):
            worst = np.inf
            for t in range(i, n):
                ww = sum(w[s:t + 1])
                worst = min(worst, sum(y[j] * w[j] for j in range(s, t + 1)) / ww)
            best = max(best, worst)
        out[i] = best
    return out


class TestPAVA(unittest.TestCase):
    def test_matches_bruteforce_weighted(self):
        rng = np.random.default_rng(1)
        for _ in range(300):
            n = int(rng.integers(1, 10))
            y = rng.normal(size=n).round(2)
            w = rng.integers(1, 5, size=n).astype(float)
            np.testing.assert_allclose(t1.pava(y, w), isotonic_minmax(y, w), atol=1e-12)

    def test_matches_bruteforce_binary_unit(self):
        for n in range(1, 9):
            for bits in itertools.product([0.0, 1.0], repeat=n):
                y = np.array(bits)
                w = np.ones(n)
                np.testing.assert_allclose(t1.pava(y, w), isotonic_minmax(y, w), atol=1e-12)

    def test_is_optimal_vs_random_monotone(self):
        rng = np.random.default_rng(2)
        y = rng.integers(0, 2, size=12).astype(float)
        w = np.ones(12)
        f = t1.pava(y, w)
        self.assertTrue(np.all(np.diff(f) >= -1e-15))
        sse = np.sum((f - y) ** 2)
        for _ in range(2000):
            g = np.sort(rng.uniform(0, 1, size=12))
            self.assertLessEqual(sse, np.sum((g - y) ** 2) + 1e-12)

    def test_fit_isotonic_aggregates_ties(self):
        x = np.array([0.0, 0.0, 0.0, 0.1, 0.1, 0.2, 0.3, 0.3, 0.5])
        y = np.array([0, 1, 0, 1, 1, 0, 0, 1, 1], dtype=float)
        m = t1.fit_isotonic(x, y)
        self.assertEqual(m["x"], [0.0, 0.1, 0.2, 0.3, 0.5])
        self.assertEqual(m["n_rows"], 9)
        self.assertEqual(m["n_tied_rows"], 4)
        ux, my, cnt = t1.aggregate_ties(x, y)
        np.testing.assert_allclose(m["y"], isotonic_minmax(list(my), list(cnt)), atol=1e-12)
        # weighted mean preserved
        self.assertAlmostEqual(float(np.dot(m["y"], cnt)), float(y.sum()), places=12)
        # x-order of the input does not matter
        perm = np.random.default_rng(3).permutation(len(x))
        self.assertEqual(t1.fit_isotonic(x[perm], y[perm])["y"], m["y"])

    def test_apply_map_interp_and_ends(self):
        m = {"x": [0.1, 0.2, 0.4], "y": [0.05, 0.25, 0.25]}
        p = t1.apply_map(m, np.array([0.0, 0.1, 0.15, 0.3, 0.9]))
        np.testing.assert_allclose(p, [0.05, 0.05, 0.15, 0.25, 0.25])
        m2 = {"x": [0.0, 1.0], "y": [-0.2, 1.3]}
        np.testing.assert_allclose(t1.apply_map(m2, np.array([0.0, 1.0])), [0.0, 1.0])


def mc_touch(k, sigma, T, n_paths=200_000, n_steps=64, seed=7):
    """Driftless BM in log price, exact barrier crossing via the Brownian-bridge probability per step.
    Returns (estimate, standard error)."""
    rng = np.random.default_rng(seed)
    tau = T / 365.0
    dt = tau / n_steps
    b = math.log(1.0 + k)
    x = np.zeros(n_paths)
    survive = np.ones(n_paths)
    for _ in range(n_steps):
        xn = x + sigma * math.sqrt(dt) * rng.standard_normal(n_paths)
        both_above = (x > b) & (xn > b)
        with np.errstate(over="ignore"):
            pc = np.where(both_above, np.exp(-2.0 * (x - b) * (xn - b) / (sigma ** 2 * dt)), 1.0)
        survive *= 1.0 - pc
        x = xn
    return 1.0 - survive.mean(), survive.std() / math.sqrt(n_paths)


class TestTouchFormula(unittest.TestCase):
    def test_vs_monte_carlo(self):
        for k, sigma, T in [(-0.05, 0.6, 7), (-0.10, 0.8, 30), (-0.20, 0.5, 14), (-0.05, 0.4, 1),
                            (-0.30, 0.9, 30)]:
            p = t1.touch_prob(k, sigma, T)
            est, se = mc_touch(k, sigma, T)
            self.assertLess(abs(est - p), 4 * se + 2e-3, (k, sigma, T, p, est, se))

    def test_closed_form_and_cap(self):
        # 2*Phi(ln(0.9)/(0.5*sqrt(30/365)))
        z = math.log(0.9) / (0.5 * math.sqrt(30 / 365))
        self.assertAlmostEqual(t1.touch_prob(-0.10, 0.5, 30), math.erfc(-z / math.sqrt(2)), places=12)
        self.assertEqual(t1.touch_prob(0.0, 0.5, 30), 1.0)  # 2*Phi(0) = 1, cap holds
        self.assertLessEqual(t1.touch_prob(-1e-15, 0.5, 30), 1.0)
        self.assertGreater(t1.touch_prob(-1e-15, 0.5, 30), 0.999999)
        # monotone in sigma, T, |k|
        self.assertLess(t1.touch_prob(-0.1, 0.4, 7), t1.touch_prob(-0.1, 0.6, 7))
        self.assertLess(t1.touch_prob(-0.1, 0.4, 7), t1.touch_prob(-0.1, 0.4, 14))
        self.assertLess(t1.touch_prob(-0.2, 0.4, 7), t1.touch_prob(-0.1, 0.4, 7))


class TestRealizedVol(unittest.TestCase):
    def test_hand_computation(self):
        # closes most recent first: P0=110, P1=100, P2=105, P3=100
        # r = [ln 1.1, -ln 1.05, ln 1.05], mean = ln(1.1)/3
        # sum of squared deviations = (2/3 a)^2 + (b + a/3)^2 + (b - a/3)^2 = 2a^2/3 + 2b^2 (a=ln1.1, b=ln1.05)
        # sample variance (n-1=2) = a^2/3 + b^2 ; sigma = sqrt(365 * that)
        a, b = math.log(1.1), math.log(1.05)
        want = math.sqrt(365.0 * (a * a / 3.0 + b * b))
        self.assertAlmostEqual(t1.realized_vol([110.0, 100.0, 105.0, 100.0]), want, places=12)
        self.assertAlmostEqual(want, 1.4050263126458045, places=12)

    def test_nulls(self):
        self.assertIsNone(t1.realized_vol([100.0, None, 101.0]))
        self.assertIsNone(t1.realized_vol([100.0, float("nan"), 101.0]))
        self.assertIsNone(t1.realized_vol([100.0]))


def synthetic_grid(n_days, oracle=100.0, low=99.0):
    n = n_days * 24
    return {"oracle": [oracle] * n, "oracleLow": [low] * n, "binanceLow": [low] * n}


class TestAlignment(unittest.TestCase):
    def setUp(self):
        self.start = t1.START_TS
        self.t0 = self.start + 120 * t1.DAY
        self.cols = synthetic_grid(200)
        i = lambda ts: (ts - self.start) // 3600  # noqa: E731
        self.i = i
        # oracle close: wiggle every hour so RV > 0, then distinctive values around t0
        for h in range(len(self.cols["oracle"])):
            self.cols["oracle"][h] = 100.0 * math.exp(0.01 * math.sin(h))

    def grid(self):
        return t1.PriceGrid(self.start, 3600, self.cols)

    def test_spot_is_close_of_hour_opening_t0_minus_1h(self):
        self.cols["oracle"][self.i(self.t0 - 3600)] = 200.0
        self.cols["oracle"][self.i(self.t0)] = 300.0
        self.cols["oracle"][self.i(self.t0 - 7200)] = 400.0
        dvol = {self.t0 - 3600: 80.0, self.t0: 999.0, self.t0 - 7200: 1.0}
        f = t1.features_at(self.grid(), dvol, self.t0)
        self.assertEqual(f["S"], 200.0)
        self.assertEqual(f["DVOL"], 0.80)

    def test_rv_reads_daily_closes_at_t0_minus_1h_minus_k_days(self):
        rng = np.random.default_rng(5)
        # garbage everywhere, designed closes only at the registered hours
        for h in range(len(self.cols["oracle"])):
            self.cols["oracle"][h] = float(rng.uniform(1, 1e6))
        want30 = [100.0 * math.exp(0.02 * math.sin(3 * k)) for k in range(91)]
        for k, v in enumerate(want30):
            self.cols["oracle"][self.i(self.t0 - 3600 - k * t1.DAY)] = v
        f = t1.features_at(self.grid(), {}, self.t0)
        self.assertAlmostEqual(f["RV30"], t1.realized_vol(want30[:31]), places=14)
        self.assertAlmostEqual(f["RV90"], t1.realized_vol(want30[:91]), places=14)
        self.assertIsNone(f["DVOL"])
        # a null in the RV90-only part of the look-back kills RV90 but not RV30
        self.cols["oracle"][self.i(self.t0 - 3600 - 60 * t1.DAY)] = None
        f = t1.features_at(self.grid(), {}, self.t0)
        self.assertIsNotNone(f["RV30"])
        self.assertIsNone(f["RV90"])

    def test_truth_window_edges(self):
        for T in (1, 3, 7):
            a, b = t1.truth_window(self.t0, T)
            self.assertEqual(a, self.t0)
            self.assertEqual(b, self.t0 + T * t1.DAY - 3600)
            cases = [(self.t0, 94.0), (self.t0 + T * t1.DAY - 3600, 94.0),
                     (self.t0 - 3600, 99.0), (self.t0 + T * t1.DAY, 99.0)]
            for dip_at, want in cases:
                cols = synthetic_grid(200)
                cols["oracleLow"][self.i(dip_at)] = 94.0
                g = t1.PriceGrid(self.start, 3600, cols)
                self.assertEqual(g.window_min("oracleLow", a, b), want, (T, dip_at))
            cols = synthetic_grid(200)
            cols["oracleLow"][self.i(self.t0 + 5 * 3600)] = None
            g = t1.PriceGrid(self.start, 3600, cols)
            self.assertIsNone(g.window_min("oracleLow", a, b))

    def test_build_rows_known_touch(self):
        # dip to 89 at the hour opening t0 + 2 days + 5 h: S in [99.005, 101.0]
        self.cols["oracleLow"][self.i(self.t0 + 2 * t1.DAY + 5 * 3600)] = 89.0
        # null binanceLow inside the T>=7 windows only
        self.cols["binanceLow"][self.i(self.t0 + 4 * t1.DAY)] = None
        dv = {self.start + h * 3600: 60.0 for h in range(200 * 24)}
        grids = {"ETH": t1.PriceGrid(self.start, 3600, self.cols),
                 "BTC": t1.PriceGrid(self.start, 3600, synthetic_grid(200))}
        # BTC: constant price -> RV = 0 -> invalid sigma -> no BTC rows
        bounds = (self.t0, self.t0 + 31 * t1.DAY, self.t0 + 80 * t1.DAY)
        rows, acct = t1.build_rows(grids, {"ETH": dv, "BTC": dv}, "calib", bounds)
        self.assertTrue(all(r["asset"] == "ETH" for r in rows))
        self.assertTrue(all(r["kind"] == "retrospective" and "issuedAt" not in r for r in rows))
        r0 = {(r["T"], r["k"]): r for r in rows if r["asof"] == self.t0}
        self.assertEqual(len(r0), 25)
        for (T, k), r in r0.items():
            want = 1 if (T >= 3 and k in (-0.05, -0.10)) else 0
            self.assertEqual(r["y_oracle"], want, (T, k))
            self.assertEqual(r["y_binance"], None if T >= 7 else 0, (T, k))
            self.assertAlmostEqual(r["L"], r["S"] * (1 + k))
            self.assertEqual(r["sigma_DVOL"], 0.6)
            self.assertAlmostEqual(r["p_raw_DVOL"], t1.touch_prob(k, 0.6, T))
        # dip seen from later issue days: asof t0+2d sees it for every T; asof t0+3d never
        r2 = {(r["T"], r["k"]): r for r in rows if r["asof"] == self.t0 + 2 * t1.DAY}
        self.assertEqual(r2[(1, -0.10)]["y_oracle"], 1)
        r3 = [r for r in rows if r["asof"] == self.t0 + 3 * t1.DAY]
        self.assertTrue(all(r["y_oracle"] == 0 for r in r3))
        # label purge: every calib row ends by the split
        self.assertTrue(all(r["asof"] + r["T"] * t1.DAY <= bounds[1] for r in rows))
        self.assertEqual(max(r["asof"] for r in rows if r["T"] == 30), bounds[1] - 30 * t1.DAY)
        self.assertEqual(acct[1]["no_RV30"], acct[1]["candidates"] // 2)  # all BTC rows


class TestSplit(unittest.TestCase):
    def test_boundaries(self):
        D = t1.DAY
        cs, sp, te = t1.BOUNDS
        self.assertEqual(t1.split_of(cs, 1), "calib")
        self.assertIsNone(t1.split_of(cs - D, 1))
        self.assertEqual(t1.split_of(sp - 30 * D, 30), "calib")
        self.assertIsNone(t1.split_of(sp - 29 * D, 30))          # window crosses 2024-01-01 -> purged
        self.assertEqual(t1.split_of(sp - D, 1), "calib")
        self.assertEqual(t1.split_of(sp, 30), "test")
        self.assertEqual(t1.split_of(t1.utc("2026-09-06T00:00:00Z"), 30), "test")  # ends 10-06T00Z
        self.assertIsNone(t1.split_of(t1.utc("2026-09-07T00:00:00Z"), 30))
        self.assertEqual(t1.split_of(t1.utc("2026-10-05T00:00:00Z"), 1), "test")
        self.assertIsNone(t1.split_of(t1.utc("2026-10-06T00:00:00Z"), 1))
        self.assertEqual(te, 1791255600)
        self.assertEqual(cs, t1.utc("2021-03-25T00:00:00Z"))


class TestBootstrapAndMetrics(unittest.TestCase):
    def test_block_bootstrap_shapes(self):
        rng = np.random.default_rng(0)
        idx = t1.block_bootstrap_indices(rng, 100, 30, 2000)
        self.assertEqual(idx.shape, (2000, 100))
        self.assertGreaterEqual(idx.min(), 0)
        self.assertLessEqual(idx.max(), 99)
        # 4 blocks of 30, truncated to 100: contiguous runs inside each block
        blocks = [idx[:, 0:30], idx[:, 30:60], idx[:, 60:90], idx[:, 90:100]]
        for bl in blocks:
            self.assertTrue(np.all(np.diff(bl, axis=1) == 1))
            self.assertLessEqual(bl[:, 0].max(), 70)
        starts = np.concatenate([b[:, 0] for b in blocks])
        self.assertEqual(starts.min(), 0)
        self.assertEqual(starts.max(), 70)
        self.assertLess(abs(starts.mean() - 35.0), 1.0)  # uniform on 0..70
        counts = t1.replicate_counts(idx, 100)
        self.assertEqual(counts.shape, (2000, 100))
        self.assertTrue(np.all(counts.sum(axis=1) == 100))
        # determinism
        a = t1.block_bootstrap_indices(np.random.default_rng(9), 50, 30, 5)
        b = t1.block_bootstrap_indices(np.random.default_rng(9), 50, 30, 5)
        np.testing.assert_array_equal(a, b)
        with self.assertRaises(ValueError):
            t1.block_bootstrap_indices(rng, 20, 30, 5)

    def test_bss_ci(self):
        rng = np.random.default_rng(4)
        n_days, per = 120, 10
        day_idx = np.repeat(np.arange(n_days), per)
        y = (rng.uniform(size=n_days * per) < 0.2).astype(float)
        pm = np.clip(0.2 + 0.3 * (y - 0.2) + rng.normal(0, 0.05, size=y.size), 0, 1)
        pb = np.full(y.size, 0.2)
        counts = t1.replicate_counts(t1.block_bootstrap_indices(np.random.default_rng(1), n_days, 30, 500),
                                     n_days)
        r = t1.bss_ci(day_idx, n_days, pm, pb, y, counts)
        self.assertAlmostEqual(r["bss"], 1 - t1.brier(pm, y) / t1.brier(pb, y), places=12)
        self.assertTrue(r["ci95"][0] <= r["bss"] <= r["ci95"][1])
        self.assertTrue(r["ci_above_0"])
        same = t1.bss_ci(day_idx, n_days, pb, pb, y, counts)
        self.assertEqual(same["bss"], 0.0)
        self.assertEqual(same["ci95"], [0.0, 0.0])
        self.assertFalse(same["ci_above_0"])

    def test_ece_hand(self):
        p = np.array([0.05, 0.05, 0.95, 1.0])
        y = np.array([0.0, 1.0, 1.0, 1.0])
        e, tab = t1.ece_equal_width(p, y)
        self.assertAlmostEqual(e, 0.5 * 0.45 + 0.5 * 0.025, places=12)
        self.assertEqual(tab[9]["n"], 2)  # p = 1.0 lands in the closed last bin
        self.assertEqual(tab[0]["n"], 2)
        # bin edges: 0.1 goes to bin 1, 0.0999 to bin 0
        _, tab = t1.ece_equal_width(np.array([0.1, 0.0999, 0.3, 0.7]), np.zeros(4))
        self.assertEqual([r["n"] for r in tab], [1, 1, 0, 1, 0, 0, 0, 1, 0, 0])
        em, tabm = t1.ece_equal_mass(np.arange(20) / 20.0, np.r_[np.zeros(10), np.ones(10)])
        self.assertEqual([r["n"] for r in tabm], [2] * 10)
        want = np.mean([abs((0 if i < 5 else 1) - (2 * i + 0.5) / 20.0) for i in range(10)])
        self.assertAlmostEqual(em, want, places=12)


def synthetic_market(n_days, seed, vol=0.6, null_every=None):
    rng = np.random.default_rng(seed)
    n = n_days * 24
    sh = vol / math.sqrt(8760)
    logp = math.log(2000.0) + np.cumsum(rng.normal(0, sh, size=n))
    close = np.exp(logp)
    open_ = np.r_[close[0], close[:-1]]
    low = np.minimum(open_, close) * np.exp(-np.abs(rng.normal(0, sh * 0.5, size=n)))
    blow = low * (1 - 0.001 * rng.uniform(size=n))
    cols = {"oracle": close.tolist(), "oracleLow": low.tolist(), "binanceLow": blow.tolist()}
    if null_every:
        for h in range(5, n, null_every):
            cols["binanceLow"][h] = None
    return cols


class TestEndToEndSynthetic(unittest.TestCase):
    def test_fit_then_score(self):
        start = t1.START_TS
        cs = start + 100 * t1.DAY
        sp = cs + 150 * t1.DAY
        te = sp + 150 * t1.DAY + 3 * 3600
        n_days = 410
        grids = {"ETH": t1.PriceGrid(start, 3600, synthetic_market(n_days, 1, 0.7, null_every=997)),
                 "BTC": t1.PriceGrid(start, 3600, synthetic_market(n_days, 2, 0.5))}
        rng = np.random.default_rng(3)
        dvols = {a: {start + h * 3600: float(v + rng.normal(0, 2)) for h in range(n_days * 24)}
                 for a, v in (("ETH", 70.0), ("BTC", 50.0))}
        quiet = lambda *a, **k: None  # noqa: E731
        with tempfile.TemporaryDirectory() as d:
            fs = t1.run_fit(grids, dvols, d, bounds=(cs, sp, te), log=quiet)
            self.assertTrue(os.path.exists(os.path.join(d, "calibration-maps.json")))
            self.assertEqual(fs["calibration_maps"]["sha256"],
                             t1.sha256_file(os.path.join(d, "calibration-maps.json")))
            with self.assertRaises(SystemExit):
                t1.run_fit(grids, dvols, d, bounds=(cs, sp, te), log=quiet)
            res = t1.run_score(grids, dvols, d, bounds=(cs, sp, te), n_boot=60, log=quiet)
            with self.assertRaises(SystemExit):
                t1.run_score(grids, dvols, d, bounds=(cs, sp, te), n_boot=60, log=quiet)
            self.assertIn(res["verdict"]["verdict"], ("PASS", "FAIL"))
            self.assertEqual(len(res["verdict"]["A_per_horizon"]), 5)
            for f in ("results.json", "forecasts-test.csv.gz", "forecasts-calib.csv.gz", "PROVENANCE.md",
                      "reliability-test-equal-width.csv", "reliability-test-equal-mass.csv",
                      "fit-summary.json"):
                self.assertTrue(os.path.exists(os.path.join(d, f)), f)
            with open(os.path.join(d, "results.json")) as fh:
                json.load(fh)  # strict JSON
            maps = t1.load_maps(os.path.join(d, "calibration-maps.json"),
                                expected_sha256=fs["calibration_maps"]["sha256"])
            with gzip.open(os.path.join(d, "forecasts-test.csv.gz"), "rt") as fh:
                rows = list(csv.DictReader(fh))
            self.assertNotIn("issuedAt", rows[0])
            self.assertTrue(all(r["kind"] == "retrospective" for r in rows))
            self.assertEqual(len(rows), res["test_set"]["1"]["n_rows"] + res["test_set"]["3"]["n_rows"]
                             + res["test_set"]["7"]["n_rows"] + res["test_set"]["14"]["n_rows"]
                             + res["test_set"]["30"]["n_rows"])
            # the public issuer function reproduces the stored raw and calibrated probabilities
            for r in rows[::97]:
                out = t1.touch_forecast(r["asset"], float(r["S"]),
                                        {"DVOL": float(r["sigma_dvol"]), "RV30": float(r["sigma_rv30"]),
                                         "RV90": float(r["sigma_rv90"])},
                                        levels=[float(r["k"])], horizons=[int(r["T"])], maps=maps)
                got = {o["source"]: o for o in out}
                for src in t1.SOURCES:
                    self.assertEqual(got[src]["p_raw"], float(r["p_raw_" + src.lower()]))
                    self.assertEqual(got[src]["p_cal"], float(r["p_cal_" + src.lower()]))
                self.assertEqual(got["DVOL"]["L"], float(r["L"]))
            # deterministic gzip: same bytes on a rerun into a fresh dir
            with tempfile.TemporaryDirectory() as d2:
                t1.run_fit(grids, dvols, d2, bounds=(cs, sp, te), log=quiet)
                t1.run_score(grids, dvols, d2, bounds=(cs, sp, te), n_boot=60, log=quiet)
                for f in ("calibration-maps.json", "forecasts-test.csv.gz", "forecasts-calib.csv.gz"):
                    self.assertEqual(t1.sha256_file(os.path.join(d, f)), t1.sha256_file(os.path.join(d2, f)))
                with open(os.path.join(d2, "results.json")) as fh:
                    res2 = json.load(fh)
                self.assertEqual(json.dumps(res2["comparisons"]), json.dumps(t1._clean(res["comparisons"])))


if __name__ == "__main__":
    unittest.main(verbosity=2)
