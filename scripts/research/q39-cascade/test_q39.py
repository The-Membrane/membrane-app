"""Unit tests for the Q39 mechanism. Run: python3 -m pytest -q scripts/research/q39-cascade/test_q39.py
(or python3 test_q39.py)."""
from __future__ import annotations

import os
import subprocess
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import aave  # noqa: E402
import cascade as CS  # noqa: E402
import morpho  # noqa: E402
from callrule import m_call_vec  # noqa: E402

DT = np.dtype([(f, "f8") for f in aave.REC_FIELDS])


def rec(**kw):
    base = dict(user=0, VE=0, VB=0, VO=0, ltE=0, ltB=0, ltO=0, lbE=1, lbB=1, lbO=1.05, feeE=0, feeB=0, feeO=0,
                DE=0, DB=0, DO=0, DmaxO=0, hf=0)
    base.update(kw)
    num = base["ltE"] * base["VE"] + base["ltB"] * base["VB"] + base["ltO"] * base["VO"]
    base["hf"] = num / (base["DE"] + base["DB"] + base["DO"])
    return np.array([tuple(base[f] for f in aave.REC_FIELDS)], dtype=DT)


def test_callrule_pinned_source():
    """The vendored rule must equal research/history-forecasts sim1/liq.py at 0dcd888 (skipped if not fetchable)."""
    try:
        src = subprocess.check_output(["git", "show", "0dcd888:scripts/research/history-forecasts/sim1/liq.py"],
                                      cwd=HERE, stderr=subprocess.DEVNULL).decode()
    except subprocess.CalledProcessError:
        return
    mine = open(os.path.join(HERE, "callrule.py")).read()
    cut = lambda s: s[s.index("def m_call_vec"):s.index("return repay, seized, fee, profit")]
    assert cut(src) == cut(mine)


def test_ray_rules():
    idx = 1_05 * 10**25  # 1.05 ray
    amt = 1_000_000
    s = aave.ray_div(amt, idx)
    assert abs(aave.ray_mul(s, idx) - amt) <= 1
    # a burn smaller than accrued interest is emitted as a Mint with value < balanceIncrease
    assert aave.ray_div(abs(-500), idx) > 0


def test_lif():
    assert abs(morpho.lif(int(0.86e18)) - 1 / (0.3 * 0.86 + 0.7)) < 1e-12
    assert morpho.lif(int(0.5e18)) == 1.15


def test_close_factor_rule():
    # HF 0.97, both sides >= $2,000, debt > half of total: half closes
    r, s, f, _ = m_call_vec(np.array([10000.0]), np.array([0.97]), np.array([12000.0]), np.array([10000.0]),
                            np.array([1.05]), np.array([0.1]), 0.0)
    assert abs(r[0] - 5000) < 1e-9 and abs(s[0] - 5250) < 1e-9
    # HF <= 0.95: full
    r, s, f, _ = m_call_vec(np.array([10000.0]), np.array([0.94]), np.array([12000.0]), np.array([10000.0]),
                            np.array([1.05]), np.array([0.1]), 0.0)
    assert abs(r[0] - 10000) < 1e-9


def test_schedule_single_position():
    # $10,000 WETH at LT 0.8, $6,000 USDC debt: liquidation at g = 0.75 (HF = 8000 g / 6000)
    r = rec(VE=10000, ltE=0.8, lbE=1.05, feeE=0.1, DO=6000, DmaxO=6000)
    sc = CS.schedule(r, "aave")
    k_first = int(np.argmax(sc["E"] > 0))
    assert abs(CS.GRID[k_first] - 0.749) < 0.0015
    assert sc["E"][-1] > 0 and np.all(np.diff(sc["E"]) >= -1e-9)
    # already underwater accounts are excluded
    r2 = rec(VE=1000, ltE=0.8, DO=900, DmaxO=900)
    assert CS.schedule(r2, "aave")["E"][-1] == 0


def test_comet_absorb_all():
    r = rec(VE=10000, ltE=0.85, lbE=1.0, DO=8000, DmaxO=8000)
    sc = CS.schedule(r, "comet")
    k = int(np.argmax(sc["absE"] > 0))
    assert abs(CS.GRID[k] - 8000 / 8500) < 0.0015
    assert abs(sc["absD"][-1] - 8000) < 1e-6


def test_overshoot_and_lead():
    Q = np.linspace(0, 1e9, CS.NG)
    o0 = CS.overshoot(Q, 0.0, 0.03, 0.005)
    assert np.all(o0 == 0)
    o = CS.overshoot(Q, 1e-5, 0.03, 0.005)
    assert np.all(o <= 1e-12)
    assert CS.lead(np.zeros(CS.NG), 0.10) == 0.0
    c = CS.lead(o, 0.10)
    assert 0.0 <= c <= 0.10
    # a small impact below the print threshold adds nothing
    assert np.all(CS.overshoot(np.full(CS.NG, 1.0), 1e-6, 0.03, 0.005) == 0)


if __name__ == "__main__":
    for k, f in list(globals().items()):
        if k.startswith("test_"):
            f()
            print("ok", k)
