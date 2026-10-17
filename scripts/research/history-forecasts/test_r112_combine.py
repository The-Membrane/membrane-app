"""Synthetic tests for r112_combine.py (no real outcome is read)."""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import r112_combine as R  # noqa: E402


def test_fit_ridge_identity_when_p0_calibrated():
    rng = np.random.default_rng(1)
    n = 40000
    lp0 = rng.normal(-2.0, 1.0, n)
    y = (rng.random(n) < 1.0 / (1.0 + np.exp(-lp0))).astype(float)
    z = rng.normal(size=(n, 1))
    X = R.design(lp0, z, np.arange(n) % 3)
    th, info = R.fit_ridge(X, y, 1)
    assert info["converged"]
    assert abs(th[3] - 1.0) < 0.05 and abs(th[4]) < 0.05 and abs(th[0]) < 0.1


def test_fit_ridge_recovers_signal():
    rng = np.random.default_rng(2)
    n = 60000
    lp0 = rng.normal(-2.0, 1.0, n)
    z = rng.normal(size=(n, 1))
    eta = -0.3 + 0.8 * lp0 + 0.5 * z[:, 0]
    y = (rng.random(n) < 1.0 / (1.0 + np.exp(-eta))).astype(float)
    th, info = R.fit_ridge(R.design(lp0, z, np.arange(n) % 3), y, 1)
    assert abs(th[3] - 0.8) < 0.06 and abs(th[4] - 0.5) < 0.06


def test_predict_monotone_across_levels():
    n = 5
    lp0 = np.tile(np.linspace(0.0, -6.0, R.K), (n, 1))
    Z = np.random.default_rng(3).normal(size=(n, R.K, 2))
    th = np.array([0.5, -0.2, 0.3, 1.1, 0.4, -0.7])
    p = R.predict(th, lp0, Z)
    assert np.all(np.diff(p, axis=1) <= 1e-15)


def test_last_before_is_strict():
    tt = np.array([10.0, 20.0, 30.0])
    vv = np.array([1.0, 2.0, 3.0])
    out = R.last_before(tt, vv, np.array([5.0, 10.0, 10.5, 30.0, 31.0]))
    assert np.isnan(out[0]) and np.isnan(out[1])
    assert out[2] == 1.0 and out[3] == 2.0 and out[4] == 3.0


def test_pm_feature_nearest_dip_and_staleness():
    S = 3600
    mk = {"m1": {"event": "e", "strike": 1800.0, "start": 0, "end": 100 * S, "t": np.array([5 * S, 9 * S], float),
                 "p": np.array([0.2, 0.3])},
          "m2": {"event": "e", "strike": 1500.0, "start": 0, "end": 100 * S, "t": np.array([9 * S], float),
                 "p": np.array([0.05])},
          "m3": {"event": "e", "strike": 2100.0, "start": 0, "end": 100 * S, "t": np.array([9 * S], float),
                 "p": np.array([0.9])}}
    ev = {"e": {"end": 100 * S, "markets": ["m1", "m2", "m3"]}}
    out = R.pm_feature(mk, ev, np.array([10 * S, 20 * S]), np.array([2000.0, 2000.0]), 1)
    lv = np.asarray(R.LEVELS)
    # -10% -> 1800 (m1, price at 9h = 0.3); -25% -> 1500 (m2); strike 2100 above spot never used
    assert abs(out[0, list(lv).index(-0.10)] - R.logit(0.3, R.PM_CLIP)) < 1e-12
    assert abs(out[0, list(lv).index(-0.25)] - R.logit(0.05, R.PM_CLIP)) < 1e-12
    assert np.all(np.isnan(out[1]))          # last prints 11 h old -> stale


def test_r105_delta_empty_window_zero_and_sign():
    ts = np.arange(0, 400 * 86400, 3600, dtype=np.int64)
    n = len(ts)
    p0 = np.full((n, R.K), 0.2)
    y = np.zeros((n, R.K))
    base = {"ts": ts, 24: {"p0": p0, "y": y}}
    d = R.r105_delta(base, 24, np.array([0, 200 * 86400], dtype=np.int64))
    assert d[0] == 0.0
    assert d[1] == 0.0                        # no events -> lambda 0
    y[:, 0] = 1.0                             # under-forecast at -2%: sum y > sum p for that level only
    base[24]["y"] = y
    d = R.r105_delta(base, 24, np.array([200 * 86400], dtype=np.int64))
    assert np.isfinite(d[0])


def test_count_pos_episodes():
    y = np.array([0, 1, 1, 0, 1, 1, 1], float)
    ok = np.array([False, True, True, True, True, False, True])
    assert R.count_pos_episodes(y, ok) == 3


def test_fit_ridge_finite_when_a_band_has_no_positive():
    rng = np.random.default_rng(4)
    n = 30000
    bands = np.arange(n) % 3
    lp0 = rng.normal(-3.0, 1.0, n)
    y = (rng.random(n) < 1.0 / (1.0 + np.exp(-lp0))).astype(float)
    y[bands == 2] = 0.0
    th, info = R.fit_ridge(R.design(lp0, rng.normal(size=(n, 1)), bands), y, 1)
    assert info["converged"] and np.all(np.isfinite(th)) and th[2] < th[0]
