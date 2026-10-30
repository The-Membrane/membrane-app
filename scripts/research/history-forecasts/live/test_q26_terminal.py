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


def test_carry_gap_pair_loop_rising_and_falling():
    m = _market(WETH=2000, weETH=2100, USDC=1)
    det = _det(weETH=(10, 0), WETH=(0, 8))                       # HF 1.05
    old = {"0x01": int(2000e8), "0x02": int(2100e8 / math.exp(0.03 * 30 / 365))}   # weETH/WETH grew 3 %/yr
    up = T.carry_metrics(m, det, old, {}, {"0x01": 0.02})
    assert up["carryGapPerYear"] == pytest.approx(-0.01, abs=1e-4) and up["daysToHf1AtCurrentRates"] is None
    dn = T.carry_metrics(m, det, old, {}, {"0x01": 0.05})
    assert dn["carryGapPerYear"] == pytest.approx(0.02, abs=1e-4)
    assert dn["daysToHf1AtCurrentRates"] == pytest.approx(math.log(1.05) / 0.02 * 365, rel=1e-2)


def test_layered_map_routes_each_position_to_its_layer():
    m = _market(WETH=2000, weETH=2100, USDC=1)
    dets = [_det(WETH=(10, 0), USDC=(0, 15000)),       # price, 6.25 %
            _det(weETH=(10, 0), WETH=(0, 8)),          # pair, 4.76 %
            _det(USDC=(1000, 780)),                    # stable, 2.5 %
            _det(WETH=(10, 0), USDC=(0, 1000))]        # price, far: not banded
    old = {"0x01": int(2000e8), "0x02": int(2100e8)}
    lm = T.layered_map(m, dets, (old, {}, {"0x01": 0.05}))
    assert lm["layers"]["price"]["WETH"]["n"] == [0, 0, 0, 0, 1]
    assert lm["layers"]["pair"]["weETH"]["n"] == [0, 0, 0, 1, 0]
    assert lm["layers"]["stable"]["stable-only"]["n"] == [0, 0, 1, 0, 0]
    assert lm["totalUsd"] == {"price": 15000, "pair": 16000, "stable": 780}
    assert lm["pairCarryUsd"]["le30d"] == 0 and lm["pairCarryUsd"]["90to365d"] == 16000   # ln(1.05)/0.05 = 356 d


def test_oracle_rows_kind_gap_and_age():
    m = _market(WETH=2000, weETH=2100, USDC=1)
    rows = T.oracle_rows(m, {}, {"0x01": "ETH / USD", "0x02": "Capped weETH / eETH(ETH) / USD", "0x03": "Capped USDT/USD"},
                         {"0x01": 900}, {"ETHUSDT": 2010.0}, 1000)
    by = {r["symbol"]: r for r in rows}
    assert by["WETH"]["kind"] == "market feed" and by["WETH"]["ageS"] == 100
    assert by["WETH"]["gapPct"] == pytest.approx(2000 / 2010 - 1, abs=1e-5)
    assert by["weETH"]["kind"] == "exchange-rate (capped)"
    assert by["USDC"]["kind"] == "capped peg" and by["USDC"]["gapPct"] is None


def test_exit_rows_utilization_and_cap():
    m = _market(WETH=2000, weETH=2100, USDC=1)
    rows = T.exit_rows(m, {"0x03": 1000 * 10 ** 6, "0x01": 10 ** 18}, {"0x03": 100 * 10 ** 6, "0x01": 2 * 10 ** 18},
                       {"0x03": 0.04}, {"0x03": 0.05})
    by = {r["symbol"]: r for r in rows}
    assert by["USDC"]["withdrawableUsd"] == 100 and by["USDC"]["utilization"] == pytest.approx(0.9)
    assert by["WETH"]["withdrawableUsd"] == 2000      # capped at supplied (donations above supply)


def test_rate_headroom_weth_shape():
    p = (0.92, 0.0, 0.022, 0.60)                      # steep synthetic slope2 (live WETH 2026-10-29: 0.06)
    assert T.util_for_rate(0.0194, *p) == pytest.approx(0.92 * 0.0194 / 0.022)
    assert T.util_for_rate(0.0231, *p) == pytest.approx(0.92 + 0.0011 * 0.08 / 0.60)
    h = T.rate_headroom(1000.0, 0.0194, p, 0.0231)
    total = 1000 / (0.92 * 0.0194 / 0.022)
    assert h["withdrawalsToTarget"] == pytest.approx(total - 1000 / h["utilAtTarget"], abs=0.01)
    assert h["newBorrowsToTarget"] == pytest.approx(h["utilAtTarget"] * total - 1000, abs=0.01)
    assert h["rateAt95"] == pytest.approx(0.022 + 0.60 * 0.03 / 0.08)


def test_history_breaches_counts_and_worst():
    day = 86400 * 1000
    bars = [(i * day, 100.0, 99.0) for i in range(20)]
    bars[10] = (10 * day, 90.0, 85.0)                 # one crash day: low 15 % under the prior close
    h = T.history_breaches(bars, 0.10, windows=(1, 7))
    assert h["1d"]["windows"] == 19 and h["1d"]["breaches"] == 1
    assert h["7d"]["breaches"] == 7                   # every 7 d window starting days 3..9 contains day 10
    assert h["1d"]["worst"][0]["drop"] == pytest.approx(0.15)


def test_layers_doc_keeps_complete_scans_only_and_drops_counts():
    ok = {"schema": "q26-terminal/layered/1", "chain": "base", "block": 1, "readAt": "x", "borrowers": 5, "read": 5,
          "near": 2, "detailed": 2, "layers": {}, "totalUsd": {"price": 10}, "kind": "measured", "source": "s"}
    big = dict(ok, chain="ethereum", totalUsd={"price": 99})
    partial = dict(ok, chain="bnb", read=4)
    d = T.layers_doc([ok, None, partial, big, {"schema": "other"}])
    assert [c["chain"] for c in d["chains"]] == ["base", "ethereum"]   # input order kept
    assert "read" not in d["chains"][0] and "detailed" not in d["chains"][0]
    assert d["schema"] == "q26-terminal/layers-doc/1" and "2 chains" in d["source"]
