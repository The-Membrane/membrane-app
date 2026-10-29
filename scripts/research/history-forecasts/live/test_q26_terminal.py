"""Tests for live/q26_terminal.py (Q26-TERMINAL prototype). Synthetic data, no network.
Run: python3 -m pytest -q live/test_q26_terminal.py"""
from __future__ import annotations

import math
import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import q26_terminal as T  # noqa: E402

HOUR = 3600


def _market(**px):
    """Reserves WETH, weETH, USDC with LT 80 % (config bits 16..31), 18/18/6 decimals, prices base 1e8."""
    spec = {"WETH": ("0x01", 18, 0), "weETH": ("0x02", 18, 1), "USDC": ("0x03", 6, 2)}
    R = {}
    for sym, (a, dec, rid) in spec.items():
        R[a] = {"config": 8000 << 16, "id": rid, "aToken": "0xa", "sDebt": "0x0", "vDebt": "0xd",
                "price": int(px[sym] * 1e8), "dec": dec, "symbol": sym}
    return {"block": 1, "oracle": "0x0", "assets": list(R), "reserves": R, "emode": {}, "meta": {}}


def _det(**bal):
    """bal: symbol -> (collateral units, debt units)."""
    addr = {"WETH": ("0x01", 18), "weETH": ("0x02", 18), "USDC": ("0x03", 6)}
    return {"emode": 0, "bal": {addr[s][0]: [int(c * 10 ** addr[s][1]), int(d * 10 ** addr[s][1])]
                                for s, (c, d) in bal.items()}}


def _row(c, chains):
    return {"c": c, "chains": chains}


def _ch(status="ok", weth=(0, 0, 0, 0, 0)):
    return {"status": status, "bands": {"oracle": {"WETH": {"debtUsd": list(weth), "n": [1 if x else 0 for x in weth]}}}}


def test_price_position_distance_and_liquidation_price():
    m = _market(WETH=2000, weETH=2100, USDC=1)
    # 10 WETH collateral x 0.8 LT x 2000 = 16000 cLT; debt 15000 USDC -> HF 1.0667, k* = -1/16
    x = T.xray_metrics(m, _det(WETH=(10, 0), USDC=(0, 15000)), vol=0.02)
    assert x["riskType"] == "price"
    assert x["distance"] == pytest.approx(0.0625, abs=1e-5)
    assert x["liquidationPrice"] == pytest.approx(1875.0, abs=1e-3)
    assert x["band"] == "5-10%"
    assert x["distanceInDailySigma"] == pytest.approx(math.log(1 / 0.9375) / 0.02, abs=0.01)


def test_pair_position_uses_collateral_only_distance_and_no_price_line():
    m = _market(WETH=2000, weETH=2100, USDC=1)
    # 10 weETH (16800 cLT) vs 8 WETH debt (16000): HF 1.05; k* = (16000-16800)/(16800-16000) = -1 -> no price line
    x = T.xray_metrics(m, _det(weETH=(10, 0), WETH=(0, 8)), vol=0.02)
    assert x["riskType"] == "pair"
    assert x["distanceJointPrice"] is None
    assert x["distance"] == pytest.approx(1 - 1 / 1.05, abs=1e-5)
    assert x["band"] == "3.5-5%"
    assert "liquidationPrice" not in x and "distanceInDailySigma" not in x and "sameBand" not in x


def test_stable_only_position():
    m = _market(WETH=2000, weETH=2100, USDC=1)
    x = T.xray_metrics(m, _det(USDC=(1000, 780)))
    assert x["riskType"] == "stable"
    assert x["distance"] == pytest.approx(1 - 780 / 800, abs=1e-5)


def test_liqmap_sums_ok_chains_and_delta_ignores_stale_chain():
    rows = [_row(0, {"a": _ch(weth=(0, 0, 0, 0, 100)), "b": _ch(weth=(0, 0, 0, 0, 1000))}),
            _row(24 * HOUR, {"a": _ch(weth=(0, 0, 0, 10, 150)), "b": _ch("stale")})]
    lm = T.liqmap(rows)
    assert lm["chainsOk"] == ["a"] and lm["chainsStale"] == ["b"]
    assert lm["compareChains"] == ["a"]
    assert lm["assets"]["WETH"]["debtUsd"] == [0, 0, 0, 10, 150]
    assert lm["assets"]["WETH"]["deltaUsd"] == [0, 0, 0, 10, 50]     # not -950: stale chain b is left out


def test_liqmap_without_24h_history_has_no_delta():
    lm = T.liqmap([_row(0, {"a": _ch(weth=(0, 0, 0, 0, 5))})])
    assert lm["compareTo"] is None and lm["assets"]["WETH"]["deltaUsd"] is None


def test_ewma_vol_needs_20_returns():
    assert T.ewma_daily_vol([1.0] * 10) is None
    closes = [100 * (1.01 if i % 2 else 0.99) ** 0 * (1.01 ** (i % 2)) for i in range(60)]
    v = T.ewma_daily_vol(closes)
    assert v == pytest.approx(math.log(1.01), rel=1e-6)


def test_stable_collateral_covering_debt_is_stable_not_price():
    m = _market(WETH=2000, weETH=2100, USDC=1)
    # 1000 USDC x 0.8 = 800 cLT vs 700 USDC debt, plus 0.001 WETH: no common price drop reaches HF 1
    x = T.xray_metrics(m, _det(USDC=(1000, 700), WETH=(0.001, 0)))
    assert x["riskType"] == "stable" and x["distanceJointPrice"] is None
    assert x["distance"] == pytest.approx(1 - 700 / 801.6, abs=1e-5)
