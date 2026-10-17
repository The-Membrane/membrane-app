"""Synthetic tests for r111_replay (no real data)."""
import os
import sys
import types

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import r10_mechanics as M  # noqa: E402
import r111_replay as Q  # noqa: E402


def _day(v33):
    d = types.SimpleNamespace()
    d.v33 = v33
    d.fee = np.array([0.1, 0.1, 0.1])
    return d


def test_liquidate_matches_r101():
    rng = np.random.default_rng(1)
    for trial in range(300):
        R = 3
        SA = rng.uniform(0, 5000, (1, R))
        SV = rng.uniform(0, 4000, (1, R))
        SS = np.zeros((1, R))
        LT = np.array([[0.8, 0.85, 0.0]])
        LB = np.array([[1.05, 1.07, 1.1]])
        px = rng.uniform(0.5, 2, R)
        inc, vix = np.ones(R), np.ones(R)
        day = _day(bool(trial % 2))
        a = (SA.copy(), SV.copy(), SS.copy())
        b = (SA.copy(), SV.copy(), SS.copy())
        u1, all1, c1 = M.liquidate_account(0, *a, LT, LB, day, px, inc, vix, 1000.0, 0)
        calls, _ = Q.liquidate_v(0, *b, LT, LB, day, px, inc, vix, M.GAS_ETH * 1000.0, 0)
        assert c1 == len(calls)
        assert abs(u1 - sum(c[0] for c in calls if c[2]["usdc"])) < 1e-9
        assert abs(all1 - sum(c[0] for c in calls)) < 1e-9
        for x, y in zip(a, b):
            assert np.allclose(x, y)


def test_pair_choice_prefers_profitable_pair():
    SA = np.array([[1000.0, 0.0]])
    SV = np.array([[0.0, 950.0]])
    SS = np.zeros((1, 2))
    LT = np.array([[0.9, 0.0]])
    LB = np.array([[1.10, 1.0]])
    day = _day(False)
    calls, _ = Q.liquidate_v(0, SA, SV, SS, LT, LB, day, np.ones(2), np.ones(2), np.ones(2), 1.0, 1, pair_choice=True)
    assert calls and calls[0][1] == 1 and calls[0][2]["usdc"]


def test_gate_stats_baselines():
    days = [f"2025-01-{i:02d}" for i in range(1, 21)]
    allr = {f"2024-12-{i:02d}": 0.0 for i in range(20, 32)}
    real = {d: (1000.0 if i % 3 == 0 else 0.0) for i, d in enumerate(days)}
    allr.update(real)
    sim = dict(real)
    g = Q.gate_stats(days, sim, real, allr)
    assert g["H"] == 1.0 and g["F"] == 0.0 and g["J"] == 1.0
    assert g["S"] > 0.99
    assert g["J_E"] < 1.0


def test_basefee_by_hour(tmp_path):
    import r10_acquire as A
    work, diag = tmp_path / "w", tmp_path / "d"
    (diag / "feehist-parts").mkdir(parents=True)
    work.mkdir()
    A.jdump(str(diag / "feehist-parts" / "100.json.gz"), {"start": 100, "base": [10] * 300})
    A.jdump(str(diag / "feehist-parts" / "400.json.gz"), {"start": 400, "base": [30] * 300})
    A.jdump(str(work / "rdu-block-ts.json.gz"), {"block": [100, 700], "ts": [0, 7200]})
    b = Q.basefee_by_hour(str(work), str(diag))
    assert b[0] == 10.0 and b[3600] == 30.0
