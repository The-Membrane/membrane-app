"""Synthetic unit tests for r10_mechanics (no real outcome is read)."""
import datetime as dt
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import r10_mechanics as M  # noqa: E402

RAY = M.RAY


def row(v1=None, v2=None, vdebt=80, cash=20, sdebt=0, unbacked=0, rf=1000, virtual=None):
    return {"vDebtTotal": str(vdebt * 10**6), "sDebtTotal": str(sdebt * 10**6), "avgStableRate": "0",
            "unbacked": str(unbacked), "config": str(rf << 64), "virtualBalance": virtual, "cashBalance": str(cash * 10**6),
            "curve_v1": v1, "curve_v2": v2}


CURVE = [str(9 * RAY // 10), "0", str(4 * RAY // 100), str(6 * RAY // 10)]


def test_below_kink():
    b, s, era = M.model_rates(row(v1=CURVE))
    # U = 0.8 -> 0.04 * 0.8 / 0.9
    assert abs(b / RAY - 0.04 * 0.8 / 0.9) < 1e-15
    assert abs(s / RAY - b / RAY * 0.8 * 0.9) < 1e-12
    assert era == "v1-balance"


def test_above_kink_v2_virtual():
    b, s, era = M.model_rates(row(v2=CURVE, vdebt=95, cash=999, virtual=str(5 * 10**6)))
    assert abs(b / RAY - (0.04 + 0.6 * 0.05 / 0.1)) < 1e-12
    assert era == "v2-virtual"


def test_counts_episodes():
    days = [(dt.date(2024, 1, 1) + dt.timedelta(days=i)).isoformat() for i in range(10)]
    y = np.array([0, 3e6, 3e6, 0, 0, 0, 0, 3e6, 0, 0], float)
    c = M.counts(days, y)
    r = c["windows"]["24h"][str(2_500_000)]["all"]
    assert r["positive"] == 3 and r["episodes"] == 2


class FakeDay:
    v33 = False
    fee = np.zeros(2)


def test_liquidation_pre33():
    # collateral 100 at $1 (LT 0.8, LB 1.05), USDC debt 90 -> HF 0.889 <= 0.95 -> 100%: repay 90, seize 94.5, gas $1
    SA = np.array([[100.0, 0.0]])
    SV = np.array([[0.0, 90.0]])
    SS = np.zeros((1, 2))
    LT = np.array([[0.8, 0.0]])
    LB = np.array([[1.05, 1.0]])
    px, inc, vix = np.ones(2), np.ones(2), np.ones(2)
    u, a, c = M.liquidate_account(0, SA, SV, SS, LT, LB, FakeDay(), px, inc, vix, 100.0, 1)
    assert c == 1 and abs(u - 90) < 1e-9 and u == a and abs(SA[0, 0] - 5.5) < 1e-9
    # with gas $10 the call is unprofitable
    SA[0, 0], SV[0, 1] = 100.0, 90.0
    u, a, c = M.liquidate_account(0, SA, SV, SS, LT, LB, FakeDay(), px, inc, vix, 1000.0, 1)
    assert c == 0 and u == 0
