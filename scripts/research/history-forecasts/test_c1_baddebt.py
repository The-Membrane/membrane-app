#!/usr/bin/env python3
"""Tests for c1_baddebt (Q26 R8.5 thin curator bad-debt simulator).

  python3 -m unittest scripts/research/history-forecasts/test_c1_baddebt.py -v

Offline: synthetic checks of the Aave V3 liquidation math, depth curves, impairment, reweighting and the
engine, plus the recorded real LiquidationCall spot checks in c1_baddebt/fixtures/liquidations.json
(recomputed here from the recorded on-chain inputs; no network).
"""
import json
import os
import sys
import unittest

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from c1_baddebt import depth as DP  # noqa: E402
from c1_baddebt import liq as LQ  # noqa: E402
from c1_baddebt import paths as PA  # noqa: E402
from c1_baddebt import sim as S  # noqa: E402

FIXTURE = os.path.join(HERE, "c1_baddebt", "fixtures", "liquidations.json")


class TestLiquidationMath(unittest.TestCase):
    def test_percent_math_rounds_half_up(self):
        self.assertEqual(LQ.percent_mul(10_001, 5_000), 5_001)   # 5000.5 -> 5001
        self.assertEqual(LQ.percent_mul(10_000, 10_500), 10_500)
        self.assertEqual(LQ.percent_div(10_500, 10_500), 10_000)
        self.assertEqual(LQ.percent_mul(0, 123), 0)

    def test_collateral_no_cap(self):
        # repay 1,000 USDC at $1, WETH at $2,000, bonus 5 %, protocol fee 10 % of the bonus
        coll, debt, fee = LQ.collateral_to_liquidate(1_000 * 10**6, 10**8, 10**6, 2_000 * 10**8, 10**18,
                                                     10_500, 1_000, 10 * 10**18)
        base = 5 * 10**17                       # 0.5 WETH
        mx = base * 10_500 // 10_000            # 0.525 WETH
        bonus = mx - LQ.percent_div(mx, 10_500)
        f = LQ.percent_mul(bonus, 1_000)
        self.assertEqual((coll, debt, fee), (mx - f, 1_000 * 10**6, f))
        self.assertAlmostEqual(coll / 1e18, 0.5225, places=9)

    def test_collateral_capped_by_balance(self):
        coll, debt, fee = LQ.collateral_to_liquidate(1_000 * 10**6, 10**8, 10**6, 2_000 * 10**8, 10**18,
                                                     10_500, 0, 10**17)
        self.assertEqual(coll, 10**17)
        self.assertEqual(debt, LQ.percent_div(200 * 10**6, 10_500))  # 0.1 WETH = $200, / 1.05

    def test_close_factor_branches(self):
        # $10k USDC debt, $12k collateral, total debt $10k: HF 0.97 -> 50 % of total debt
        args = (10_000 * 10**6, 10**8, 10**6, 6 * 10**18, 2_000 * 10**8, 10**18, 10_000 * 10**8)
        self.assertEqual(LQ.max_liquidatable_debt(*args, int(0.97e18)), 5_000 * 10**6)
        self.assertEqual(LQ.max_liquidatable_debt(*args, int(0.95e18)), 10_000 * 10**6)   # at threshold -> 100 %
        small = (1_500 * 10**6, 10**8, 10**6, 6 * 10**18, 2_000 * 10**8, 10**18, 1_500 * 10**8)
        self.assertEqual(LQ.max_liquidatable_debt(*small, int(0.99e18)), 1_500 * 10**6)  # debt < $2k -> 100 %

    def test_dust_rule(self):
        with self.assertRaises(ValueError):   # leaves $500 of USDC debt
            LQ.liquidate_exact(2_500 * 10**6, 3_000 * 10**6, 10**8, 6, 10 * 10**18, 2_000 * 10**8, 18, 10_500, 1_000,
                               3_000 * 10**8, int(0.9e18))
        r = LQ.liquidate_exact(3_000 * 10**6, 3_000 * 10**6, 10**8, 6, 10 * 10**18, 2_000 * 10**8, 18, 10_500, 1_000,
                               3_000 * 10**8, int(0.9e18))
        self.assertEqual(r["debt_repaid"], 3_000 * 10**6)
        with self.assertRaises(ValueError):
            LQ.liquidate_exact(1, 3_000 * 10**6, 10**8, 6, 10**18, 2_000 * 10**8, 18, 10_500, 0, 3_000 * 10**8, 10**18)

    def test_emode_bonus(self):
        em = {"3": {"lt": 9_500, "lb": 10_100, "collateral_bitmap": 1 << 28}}
        self.assertEqual(LQ.effective_bonus(10_700, 28, 3, em), 10_100)
        self.assertEqual(LQ.effective_bonus(10_500, 0, 3, em), 10_500)
        self.assertEqual(LQ.effective_lt(8_000, 28, 0, em), 8_000)

    def test_float_matches_exact(self):
        to_liq, fee, repay, seized = LQ.seize_float(np, np.array([1_000.0]), np.array([10.0]), np.array([2_000.0]),
                                                    1.05, 0.10)
        self.assertAlmostEqual(float(to_liq[0]), 0.5225, places=9)
        self.assertAlmostEqual(float(repay[0]), 1_000.0)


class TestRealLiquidations(unittest.TestCase):
    """Five or more real Core LiquidationCall events (ETH-family collateral, USDC debt), recorded inputs."""

    @classmethod
    def setUpClass(cls):
        if not os.path.exists(FIXTURE):
            raise unittest.SkipTest("fixture not recorded")
        cls.rows = json.load(open(FIXTURE))["rows"]

    def test_at_least_five_and_every_recorded_attempt_matches(self):
        ok = [r for r in self.rows if r["match"]]
        self.assertGreaterEqual(len(ok), 5)
        self.assertEqual(len(ok), len(self.rows), "a recorded spot check did not match")

    def test_recompute(self):
        exact = 0
        for r in self.rows:
            coll, debt, fee = LQ.collateral_to_liquidate(r["debt_to_cover"], r["usdc_price"], 10**6, r["coll_price"],
                                                         10**18, r["lb"], r["protocol_fee"],
                                                         r["user_coll_balance_exec"], rounding=r["rounding"])
            with self.subTest(block=r["block"], asset=r["asset"]):
                if r["capped"]:
                    self.assertLessEqual(abs(coll - r["event_collateral"]), 1)
                    self.assertLessEqual(abs(debt - r["debt_to_cover"]), 1)
                else:
                    self.assertEqual(coll, r["event_collateral"])
                    self.assertEqual(debt, r["debt_to_cover"])
                    exact += 1
                if r["hf_prev"] < 10**18:   # HF >= 1 at block - 1 means an oracle update earlier in the block
                    self.assertLessEqual(r["debt_to_cover"], r["max_liquidatable_prev"])
        self.assertGreaterEqual(exact, 5)
        self.assertEqual({r["rounding"] for r in self.rows if not r["capped"]}, {"half_up", "directional"})


def full_range_pool(L, sqrtp, fee=500, base_is_token1=True):
    t0, t1 = ("0xusdc", "0xweth") if base_is_token1 else ("0xweth", "0xusdc")
    return {"sqrtPriceX96": int(sqrtp * 2**96), "tick": int(np.floor(np.log(sqrtp**2) / np.log(1.0001))),
            "liquidity": L, "ticks": {}, "token0": t0, "token1": t1, "fee": fee}


class TestDepth(unittest.TestCase):
    def test_constant_liquidity_closed_form(self):
        # USDC token0 (6 dec), WETH token1 (18 dec), ETH = $2,000
        dec = {"0xusdc": 6, "0xweth": 18}
        sq = np.sqrt(5e8)                    # s^2 = token1 raw per token0 raw = 5e14 / 1e6
        st = full_range_pool(10**18, sq, fee=0)
        cv = DP.Curve([st], "0xweth", dec)
        self.assertAlmostEqual(cv.mid, 2000.0, delta=0.01)
        # closed form: selling q base in a constant-L pool, out = L*(1/s0 - 1/s1), s1 = s0 + q_raw/L
        s0 = st["sqrtPriceX96"] / 2**96
        q = 100.0
        s1 = s0 + q * 1e18 / 10**18
        out = 10**18 * (1 / s0 - 1 / s1) / 1e6
        expect = q - out / cv.mid
        self.assertAlmostEqual(float(cv.shortfall(q)), expect, delta=expect * 0.01)
        self.assertAlmostEqual(float(cv.shortfall_phi(q, 1.0)), float(cv.shortfall(q)))
        self.assertGreater(float(cv.shortfall_phi(q, 0.5)), float(cv.shortfall(q)))

    def test_impairment_and_recovery(self):
        c = np.ones((1, 200))
        c[0, 10:] = 0.85            # -15 % at hour 10
        phi = DP.depth_factor(c)
        self.assertEqual(phi[0, 9], 1.0)
        self.assertEqual(phi[0, 10], 0.5)
        self.assertEqual(phi[0, 33], 0.5)          # the trailing 24 h window still holds hour 9 (close 1.0)
        self.assertLess(phi[0, 34], 0.51)          # recovery starts
        self.assertAlmostEqual(phi[0, 33 + 36], 0.75)
        self.assertEqual(phi[0, 33 + 72], 1.0)


class TestPaths(unittest.TestCase):
    def test_reweight_hits_targets(self):
        rng = np.random.default_rng(1)
        pm = 1 - rng.exponential(0.06, 20_000)
        lv = [-0.02, -0.05, -0.1, -0.2, -0.3, -0.4]
        tg = [0.7, 0.45, 0.2, 0.05, 0.01, 0.002]
        w, info = PA.reweight(pm, lv, tg)
        for k, t in zip(lv, tg):
            self.assertAlmostEqual(float(w[pm <= 1 + k].sum()), t, places=9)
        self.assertAlmostEqual(w.sum(), 1.0)

    def test_empty_bin_mass_moves_shallower(self):
        pm = np.array([0.99, 0.97, 0.95, 0.85])
        w, info = PA.reweight(pm, [-0.02, -0.1, -0.3], [0.5, 0.2, 0.05])
        self.assertTrue(info["moved_mass"])
        self.assertAlmostEqual(w.sum(), 1.0)

    def test_bootstrap_shapes(self):
        c = np.linspace(100, 200, 1000)
        b = PA.bootstrap(c, c * 0.99, 50, np.random.default_rng(0), H=24)
        self.assertEqual(b["close"].shape, (50, 25))
        self.assertTrue(np.all(b["close"][:, 0] == 1.0))


def one_position(units=10.0, price=2000.0, du=15_000.0, lt=0.83, lb=1.05):
    coll = [{"asset": "WETH", "units": units, "price": price, "lt": lt, "lb": lb, "fee": 0.1}]
    se = units * price * lt
    return {"addr": "x", "coll": coll, "du": du, "e_debt": 0.0, "c_o": 0.0, "s_o": 0.0, "d_o": 0.0,
            "hf_model": se / du, "hf_chain": se / du, "m_liq": du / se, "debt_total": du, "coll_total": units * price}


class FlatCurve:
    def __init__(self, frac):
        self.frac = frac

    def shortfall_phi(self, q, phi):
        return self.frac * np.asarray(q) / phi


class TestEngine(unittest.TestCase):
    def setUp(self):
        H = 24
        self.close = np.ones((2, H + 1))
        self.close[0, 5:] = 0.8      # path 0: -20 % at hour 5 (HF 0.885 -> liquidatable)
        self.low = self.close.copy()
        self.phi = np.ones((2, H + 1))

    def test_liquidates_with_deep_depth(self):
        p = one_position()
        r = S.run([p], self.close, self.low, self.phi, {"ETH": FlatCurve(0.001)}, 2000.0, 1.0, {"24h": 24})["24h"]
        self.assertGreater(r["volume"][0], 0)
        self.assertEqual(r["volume"][1], 0)
        self.assertEqual(r["bad_debt"][0], 0)

    def test_no_liquidator_when_slippage_exceeds_bonus(self):
        p = one_position()
        r = S.run([p], self.close, self.low, self.phi, {"ETH": FlatCurve(0.2)}, 2000.0, 1.0, {"24h": 24})["24h"]
        self.assertEqual(r["volume"][0], 0)
        # underwater only if collateral < debt: 10 * 1600 = 16,000 > 15,000 -> no bad debt
        self.assertEqual(r["bad_debt"][0], 0)

    def test_crash_books_bad_debt_once(self):
        p = one_position(du=15_500.0)
        c = self.close.copy()
        c[0, 5:] = 0.5               # collateral $10k vs debt $15.5k
        r = S.run([p], c, c, self.phi, {"ETH": FlatCurve(0.001)}, 2000.0, 1.0, {"24h": 24})["24h"]
        # liquidators seize everything: deficit = debt left after the seize
        self.assertGreater(r["bad_debt"][0], 0)
        self.assertAlmostEqual(r["bad_debt"][0], r["deficit"][0])
        self.assertAlmostEqual(r["bad_debt"][0] + r["volume"][0], 15_500.0, delta=1e-6)

    def test_positions_from_snapshot(self):
        snap = {"reserves": {
            "WETH": {"price": 2000 * 10**8, "decimals": 18, "id": 0, "lt": 8300, "lb": 10500, "protocol_fee": 1000},
            "wstETH": {"price": 2400 * 10**8, "decimals": 18, "id": 1, "lt": 8100, "lb": 10600, "protocol_fee": 1000},
            "weETH": {"price": 2100 * 10**8, "decimals": 18, "id": 28, "lt": 8000, "lb": 10700, "protocol_fee": 1000},
            "rsETH": {"price": 2100 * 10**8, "decimals": 18, "id": 36, "lt": 7500, "lb": 10750, "protocol_fee": 1000},
            "USDC": {"price": 10**8, "decimals": 6, "id": 3, "lt": 7800, "lb": 10450, "protocol_fee": 2000}},
            "emode": {}, "accounts": {"0xa": {
                "a_WETH": 10**19, "a_wstETH": 0, "a_weETH": 0, "a_rsETH": 0, "d_WETH": 0, "d_wstETH": 0, "d_weETH": 0,
                "d_rsETH": 0, "d_USDC": 10_000 * 10**6, "emode": 0, "config": (1 << 1) | (1 << 6),
                "totalCollateralBase": 25_000 * 10**8, "totalDebtBase": 10_000 * 10**8,
                "currentLiquidationThreshold": 8240, "healthFactor": int(2.06e18)}}}
        # $20k WETH (LT 83 %) + $5k other collateral (LT 78 %): avg LT = (16,600 + 3,900) / 25,000 = 0.82
        snap["accounts"]["0xa"]["currentLiquidationThreshold"] = 8200
        pos, sk = S.positions_from_snapshot(snap)
        self.assertEqual(len(pos), 1)
        p = pos[0]
        self.assertAlmostEqual(p["c_o"], 5_000.0)
        self.assertAlmostEqual(p["s_o"], 3_900.0)
        self.assertAlmostEqual(p["hf_model"], 2.05)
        self.assertAlmostEqual(p["m_liq"], (10_000 - 3_900) / 16_600)


if __name__ == "__main__":
    unittest.main()
