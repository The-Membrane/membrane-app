#!/usr/bin/env python3
"""Tests for sim1 (Q26 curator simulator slice 1, research build).

  python3 -m unittest scripts/research/history-forecasts/test_sim1.py -v

Offline and synthetic: the vectorised R11.1-v3 call rule, the exact curve, the oracle emulator, the (fH) joint path
generator, the forward liquidation engine, the flow-block double-count guard, the vault metrics, the confidence
classes (weakest link, q99 rule, filter) and the report's address guard. No network, no reserved data.
"""
import os
import sys
import types
import unittest

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import r103_curve_apr as R103  # noqa: E402
import r111v3_engine as RV3  # noqa: E402
from sim1 import classes as CL  # noqa: E402
from sim1 import engine as EN  # noqa: E402
from sim1 import flows as FL  # noqa: E402
from sim1 import liq as LQ  # noqa: E402
from sim1 import paths as PA  # noqa: E402
from sim1 import report as RP  # noqa: E402


class TestCallRule(unittest.TestCase):
    def test_m_call_vec_equals_r111v3(self):
        rng = np.random.default_rng(1)
        day = types.SimpleNamespace(v33=True, fee=np.array([0.1, 0.2]))
        for _ in range(3000):
            coll = rng.uniform(0, 20000, 2) * rng.choice([0.01, 1, 50], 2)
            debt = rng.uniform(0, 20000, 2) * rng.choice([0.01, 1, 50], 2)
            td = debt.sum()
            hf = rng.uniform(0.5, 1.0)
            lb = np.array([1.05, 1.075])
            j, k = int(np.argmax(debt)), int(np.argmax(coll))
            r0, s0, _, p0, _, _ = RV3.M_call(j, k, td, hf, coll, debt, lb, day, 1.5)
            r1, s1, _, p1 = LQ.m_call_vec(np.array([td]), np.array([hf]), np.array([coll[k]]),
                                          np.array([debt[j]]), np.array([lb[k]]), np.array([day.fee[k]]), 1.5)
            self.assertAlmostEqual(r0, r1[0], places=6)
            self.assertAlmostEqual(s0, s1[0], places=6)
            self.assertAlmostEqual(p0, p1[0], places=6)


class TestCurve(unittest.TestCase):
    def test_matches_r103_and_kink(self):
        cr = {"optimal": int(0.92e27), "base": 0, "slope1": int(0.055e27), "slope2": int(0.35e27)}
        u = np.linspace(0, 1, 101)
        a = EN.curve_apr(u, cr)
        b = R103.curve_apr(u, 0.0, 0.055, 0.35, 0.92)
        self.assertTrue(np.allclose(a, b))
        self.assertAlmostEqual(float(EN.curve_apr(0.92, cr)), 0.055, places=12)


class TestOracle(unittest.TestCase):
    def test_deviation_and_heartbeat(self):
        close = np.array([[1.0, 1.001, 1.002, 0.99, 0.99]])
        low = np.array([[1.0, 1.0, 1.0, 0.985, 0.99]])
        o = PA.oracle_path(close, low, 0.005, 3 * 3600)
        self.assertEqual(o[0, 0], 1.0)            # 0 % move: no update
        self.assertEqual(o[0, 3], 1.0)            # 0.2 % close: below the 0.5 % threshold
        self.assertAlmostEqual(o[0, 4], 0.985)    # hour-3 low moves 1.5 %: update
        self.assertAlmostEqual(o[0, 5], 0.99)     # close 0.5 % above the low: update
        o2 = PA.oracle_path(np.array([[1.0, 1.001, 1.002, 1.003]]), np.array([[1.0, 1.0, 1.0, 1.0]]), 0.005, 3 * 3600)
        self.assertAlmostEqual(o2[0, 5], 1.003)   # heartbeat (3 h) forces an update at the third close


def synth_bars(n, seed, vol=0.01):
    rng = np.random.default_rng(seed)
    r = rng.normal(0, vol, n)
    close = 2000 * np.exp(np.cumsum(r))
    high = close * np.exp(np.abs(rng.normal(0, vol / 2, n)))
    low = close * np.exp(-np.abs(rng.normal(0, vol / 2, n)))
    ts = 1_600_000_000 - 1_600_000_000 % 86400 + 3600 * np.arange(n)
    return {"ts": ts.astype(np.int64), "high": high, "low": low, "close": close}


class TestPaths(unittest.TestCase):
    def test_joint_paths_shape_and_calendar(self):
        n = 24 * 400
        e, b = synth_bars(n, 2), synth_bars(n, 3)
        t0 = int(e["ts"][-1]) + 3600
        rng = np.random.default_rng(0)
        P = PA.make_paths(e, b, 24, int(e["ts"][0]) + 60 * 86400, t0, 500, rng)
        for k in ("eth", "btc"):
            self.assertEqual(P[k]["close"].shape, (500, 25))
            self.assertTrue(np.allclose(P[k]["close"][:, 0], 1.0))
            self.assertTrue((P[k]["low"] <= P[k]["close"] + 1e-12).all())
        self.assertTrue((P["day_ts"] % 86400 == 0).all())
        # constant volatility: sigma ratios near 1, so a path's ETH return equals the window's own return
        i = int(np.searchsorted(e["ts"], P["day_ts"][0]))
        raw = e["close"][i + 23] / e["close"][i - 1]
        self.assertAlmostEqual(np.log(P["eth"]["close"][0, -1]), np.log(raw) * P["eth"]["sigma_now"]
                               / PA.har_fit(e, 24)["sigma_H"][i], places=6)


def one_account(VE=10000.0, DU=7000.0, ltE=0.8, lbE=1.05):
    z = np.zeros(1)
    return {"VE": np.array([VE]), "VB": z.copy(), "VO": z.copy(), "ltE": np.array([ltE]), "ltB": z.copy(),
            "ltO": z.copy(), "lbE": np.array([lbE]), "lbB": np.ones(1), "lbO": np.ones(1) * 1.05,
            "feeE": np.array([0.1]), "feeB": z.copy(), "feeO": z.copy(), "DU": np.array([DU]), "DE": z.copy(),
            "DB": z.copy(), "DO": z.copy(), "hf_chain": np.array([ltE * VE / DU]), "hf_model": np.array([ltE * VE / DU]),
            "n": 1, "dominant": np.array([0])}


class TestLiquidations(unittest.TestCase):
    def setUp(self):
        self.T = 3
        self.close = np.array([[1.0, 1.0, 0.8, 0.8], [1.0, 1.0, 1.0, 1.0], [1.0, 0.5, 0.5, 0.5]])
        self.o = np.repeat(self.close[:, 1:], 2, axis=1)

    def _sim(self, P, gas=0.0):
        n = self.close.shape[0]
        ones = np.ones((n, 2 * self.T))
        return LQ.run(P, np.array([0]), self.o, ones, self.close, np.ones_like(self.close), {"E": None, "B": None},
                      {"E": 2000.0, "B": 60000.0}, np.ones_like(self.close), gas, 6.43)

    def test_drop_triggers_calls_and_repay(self):
        L = self._sim(one_account())
        self.assertGreater(L["usdc_repay"][0].sum(), 0)        # 20 % drop: HF 0.914 -> liquidated
        self.assertEqual(L["usdc_repay"][1].sum(), 0)          # flat path: nothing
        self.assertEqual(L["n_calls"][1], 0)

    def test_deficit_when_collateral_exhausted(self):
        L = self._sim(one_account())
        # 50 % drop: collateral 5,000 < debt 7,000; the call seizes everything, the rest is a deficit
        self.assertGreater(L["usdc_deficit"][2], 0)
        self.assertAlmostEqual(L["usdc_deficit"][2] + L["usdc_repay"][2].sum(), 7000.0, places=6)

    def test_unprofitable_means_no_call_and_underwater_booked(self):
        L = self._sim(one_account(), gas=1e9)
        self.assertEqual(L["n_calls"].sum(), 0)
        self.assertAlmostEqual(L["bd_underwater"][2], 7000.0 - 5000.0, places=6)

    def test_candidates_corner_screen(self):
        P = one_account()
        self.assertEqual(len(LQ.candidates(P, 0.9, 1.1, 1.0, 1.0)), 0)   # HF 1.143 at 0.9 x 10,000 * 0.8 / 7,000 > 1
        self.assertEqual(len(LQ.candidates(P, 0.8, 1.1, 1.0, 1.0)), 1)


class TestFlows(unittest.TestCase):
    def test_double_count_guard(self):
        t0 = 1_700_006_400 - 1_700_006_400 % 86400
        hours = np.arange(t0, t0 + 2 * 86400 + 1, 3600)
        cts = np.array([t0 - 10, t0 + 100, t0 + 3700])
        cval = np.array([1000, 1500, 1200])          # +500 in hour 0 (of which 300 is a liquidation repay), -300 hour 1
        M = {"cts": cts, "cval": cval, "t": np.array([t0, t0 + 86400, t0 + 2 * 86400]),
             "S_snap": np.array([10000.0, 10000.0, 10000.0]), "C_end": np.array([1000.0, 1200.0, 1200.0])}
        liq = np.zeros(len(hours) - 1)
        liq[0] = 300
        HB = FL.hourly_blocks(M, int(t0), int(t0 + 2 * 86400), liq)
        fb = FL.flow_blocks(M, HB, np.array([0]), 24)
        self.assertAlmostEqual(fb["f_cash"][0, 0], (500 - 300) / 10000.0)
        self.assertAlmostEqual(fb["f_cash"][0, 1], -300 / 10000.0)
        self.assertTrue((fb["dip"] <= 0).all())
        # debt D = S - C: 9000 -> 8800 plus the 300 repay added back: growth (8800 + 300 - 9000) / 9000 over 24 h
        g = (1 + fb["g_debt"][0, :24]).prod() - 1
        self.assertAlmostEqual(g, 100 / 9000.0, places=10)


class TestVault(unittest.TestCase):
    def test_pro_rata_and_lock(self):
        res = {"core": {"S0": 1000.0, "bad_debt_new": np.array([0.0, 100.0]), "min_cash": np.array([50.0, 5.0])},
               "arb": {"S0": 500.0, "bad_debt_new": np.array([10.0, 0.0]), "min_cash": np.array([500.0, 500.0])}}
        V = EN.vault_metrics(res, {"core": 100.0, "arb": 50.0}, 20.0)
        self.assertTrue(np.allclose(V["bad_debt"], [1.0, 10.0]))
        self.assertTrue(np.allclose(V["liquidity_loss"], [50.0, 95.0]))
        self.assertEqual(V["lock"]["core"].tolist(), [False, True])


class TestClasses(unittest.TestCase):
    def test_weakest_and_q99_and_checks(self):
        t = CL.load()
        self.assertEqual(CL.weakest(["P", "N", "X"]), "N")
        self.assertEqual(CL.output_class(t, "CQ2.min_cash_24h.arb")["class"], "P")
        self.assertIn("BLIND TEST", CL.output_class(t, "CQ2.min_cash_24h.arb")["labels"])
        self.assertEqual(CL.output_class(t, "CQ1.vault_bad_debt.q95")["class"], "S")
        self.assertEqual(CL.output_class(t, "CQ1.vault_bad_debt.q99")["class"], "S")
        self.assertEqual(CL.output_class(t, "CQ3.apr_now.arb", {"curvecheck_arb": False})["class"], "S")
        self.assertEqual(CL.output_class(t, "CQ3.apr_now.arb", {"curvecheck_arb": True})["class"], "P")
        self.assertEqual(CL.output_class(t, "CQ7.touch.deep20")["class"], "N")

    def test_filter(self):
        self.assertEqual(CL.parse_filter(None), ("P",))
        self.assertEqual(CL.parse_filter("s,p"), ("P", "S"))
        with self.assertRaises(ValueError):
            CL.parse_filter("Q")
        outs = [{"id": "a", "class": "P", "kind": "probability", "value": 1},
                {"id": "b", "class": "S", "kind": "scenario", "value": 2}]
        shown, held = CL.apply_filter(outs, ("P",))
        self.assertEqual([o["id"] for o in shown], ["a"])
        self.assertEqual(held, [{"id": "b", "class": "S", "kind": "scenario"}])
        wide, _ = CL.apply_filter(outs, ("P", "X", "N", "S"))
        self.assertEqual(wide[0]["value"], 1)                      # widening never changes a shown value

    def test_wording(self):
        self.assertEqual(CL.wording("P", "q95"), "1-in-20")
        self.assertEqual(CL.wording("S", "q95"), "scenario tail (95th of N paths)")
        self.assertNotIn("1-in", CL.wording("N", "q99"))


class TestRefilter(unittest.TestCase):
    def test_refilter_copies_values(self):
        full = {"confidence_filter": ["P", "X", "N", "S"], "questions": [
            {"id": "CQ1", "outputs": [{"id": "a", "class": "S", "kind": "scenario", "value": 3.0}], "withheld": []},
            {"id": "CQ2", "outputs": [{"id": "b", "class": "P", "kind": "probability", "value": 1.0}], "withheld": []}]}
        r = RP.refilter(full, ("P",))
        self.assertEqual(r["questions"][0]["outputs"], [])
        self.assertEqual(r["questions"][0]["withheld"], [{"id": "a", "class": "S", "kind": "scenario"}])
        self.assertEqual(r["questions"][1]["outputs"][0]["value"], 1.0)
        with self.assertRaises(SystemExit):
            RP.refilter(r, ("P", "S"))          # a filtered report cannot be widened (values are gone)


class TestGuard(unittest.TestCase):
    def test_address_regex(self):
        self.assertTrue(RP.ADDR_RE.search('{"x": "0x' + "ab" * 20 + '"}'))
        self.assertFalse(RP.ADDR_RE.search('{"sha": "' + "ab" * 32 + '"}'))


if __name__ == "__main__":
    unittest.main()
