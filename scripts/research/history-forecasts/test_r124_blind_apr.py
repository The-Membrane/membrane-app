#!/usr/bin/env python3
"""Unit tests for r124_blind_apr.py and r124_acquire.py on synthetic data only (no market read, no score).

  python3 -m unittest scripts/research/history-forecasts/test_r124_blind_apr.py -v
"""
import gzip
import json
import os
import sys
import tempfile
import unittest

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import r114_apr_combo as C  # noqa: E402
import r124_acquire as A4  # noqa: E402
import r124_blind_apr as M  # noqa: E402
from test_r118_blind_apr import RAY, synth_daily  # noqa: E402


def write_inputs(d, markets):
    info, starts = {}, {}
    for i, (m, dec) in enumerate(markets.items()):
        D = synth_daily(n=900, seed=11 + i)
        scale = 10 ** (dec - 6)
        for c in ("variable_debt_raw", "cash_balance_raw"):
            D[c] = (D[c].astype(float).astype(np.int64).astype(object) * scale).astype(str)
        with gzip.open(os.path.join(d, f"daily-{m}.csv.gz"), "wt") as f:
            D.to_csv(f, index=False)
        info[m] = {"version": 3, "chain": "synthetic", "symbol": "USDC", "decimals": dec}
        starts[m] = D["date"].iloc[0]
    json.dump(info, open(os.path.join(d, "reserves-r124.json"), "w"))
    json.dump({"r103_start": starts}, open(os.path.join(d, "readings-r124.json"), "w"))
    json.dump({"markets": {}}, open(os.path.join(d, "acquire-counts.json"), "w"))


class T(unittest.TestCase):
    def test_e90_window_and_abstain(self):
        idx = pd.date_range("2024-01-01", periods=200, freq="D", tz="UTC")
        st = pd.DataFrame({"apr": np.linspace(0.03, 0.05, 200)}, index=idx)
        q, n = M.empirical_short(st, idx[60])
        self.assertIsNone(q)                       # only 54 seven-day changes inside the window
        q, n = M.empirical_short(st, idx[150])
        self.assertEqual(n, 90)
        ch = (st["apr"] - st["apr"].shift(7)).iloc[61:151].to_numpy()
        self.assertTrue(np.allclose(q, st["apr"].iloc[150] + np.quantile(ch, M.QS)))

    def test_e730_is_r114_unchanged(self):
        self.assertEqual((C.EMP_TRAIN_D, C.EMP_MIN_ROWS), (730, 365))

    def test_bank_of_uses_fold_start(self):
        folds = [{"start": "2023-01-01", "n_trajectories": 258}, {"start": "2023-07-01", "n_trajectories": 439},
                 {"start": "2024-01-01", "n_trajectories": 623}]
        self.assertIsNone(M.bank_of(folds, "2022-12-31"))
        self.assertEqual(M.bank_of(folds, "2023-06-30"), 258)
        self.assertEqual(M.bank_of(folds, "2023-07-01"), 439)
        self.assertEqual(M.bank_of(folds, "2025-05-05"), 623)

    def test_alpha_and_nu_grid(self):
        self.assertAlmostEqual(M.ALPHA, 0.025 / 3)
        self.assertEqual(M.CONFIRMATORY, ["C3", "EMP", "E90"])
        g = M.nu_grid(237)
        self.assertIn(4, g)
        self.assertIn(24, g)
        self.assertEqual(M.ewc_nu(np.r_[np.ones(10), -np.ones(10)], 4)["nu"], 4)

    def test_rate_on_curve_and_symbol_decode(self):
        o, b, s1, s2 = int(0.9 * RAY), 0, int(0.04 * RAY), int(0.6 * RAY)
        d = {"curve": [str(o), str(b), str(s1), str(s2)], "vdebt": "50", "sdebt": "0", "cash": "50",
             "virtual": None, "rate_ray": str(int(0.04 * 0.5 / 0.9 * RAY))}
        self.assertTrue(A4.rate_on_curve(d))
        d["rate_ray"] = str(int(0.05 * RAY))
        self.assertFalse(A4.rate_on_curve(d))
        h = "0x" + (32).to_bytes(32, "big").hex() + (4).to_bytes(32, "big").hex() + b"USDC".ljust(32, b"\0").hex()
        self.assertEqual(A4.decode_string(h), "USDC")
        self.assertEqual(len(A4.B11), 42)

    def test_freeze_and_run_end_to_end_synthetic(self):
        with tempfile.TemporaryDirectory() as d:
            inp, out = os.path.join(d, "in"), os.path.join(d, "out")
            os.makedirs(inp)
            write_inputs(inp, {"syn-a": 6, "syn-b": 18})
            real = M.R.git_sha
            M.R.git_sha = lambda: ("0" * 40, False)
            try:
                M.cmd_freeze(inp, out)
                M.cmd_run(inp, out)
                with self.assertRaises(SystemExit):           # one run only
                    M.cmd_run(inp, out)
            finally:
                M.R.git_sha = real
            res = json.load(open(os.path.join(out, "results-r124.json")))
            self.assertIn(res["verdict"], ("PASS", "FAIL"))
            self.assertEqual(sorted(res["primary"]), sorted(M.CONFIRMATORY + M.REPORTED))
            cols = pd.read_csv(os.path.join(out, "losses-r124.csv.gz"), nrows=1).columns
            self.assertFalse(any(c.startswith(("L_C3_", "L_M2_")) for c in cols))   # no per-quantile C3/M2 loss
            self.assertNotIn("y", cols)
            # decimals: the 18-decimal synthetic market has the same debt in tokens as a 6-decimal one
            self.assertEqual(res["reported_only"]["per_reserve"]["syn-b"]["evaluable"],
                             res["reported_only"]["per_reserve"]["syn-a"]["evaluable"])


if __name__ == "__main__":
    unittest.main()
