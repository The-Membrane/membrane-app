"""Synthetic tests for r103_curve_apr.py (no real outcome is read)."""
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import r103_curve_apr as m  # noqa: E402


def test_curve_kink():
    base, s1, s2, opt = 0.0, 0.04, 0.6, 0.9
    assert abs(m.curve_apr(0.45, base, s1, s2, opt) - 0.02) < 1e-15
    assert abs(m.curve_apr(0.9, base, s1, s2, opt) - 0.04) < 1e-15
    assert abs(m.curve_apr(0.95, base, s1, s2, opt) - (0.04 + 0.3)) < 1e-12


def test_pinball_convention():
    assert m.pinball([1, 1, 1, 1, 1], 1.0) == 0.0
    # y above all quantiles by 1: mean of q
    assert abs(m.pinball([0, 0, 0, 0, 0], 1.0) - np.mean(m.QS)) < 1e-15


def test_har_regressors():
    rv = np.arange(40, dtype=float)
    X = m.har_X(rv, np.array([31]))
    assert X[0, 1] == 30 and X[0, 2] == np.mean(rv[24:31]) and X[0, 3] == np.mean(rv[1:31])


def _synthetic(n=900, seed=1):
    rng = np.random.default_rng(seed)
    x = np.cumsum(rng.normal(0, 0.05, n)) + 1.5
    U = m.expit(x)
    D = np.full(n, np.nan)
    D[1:] = np.diff(m.logit(U))
    dates = pd.date_range("2023-02-02", periods=n, freq="D", tz="UTC")
    return dates, U, D


def test_forecast_shapes_and_monotone():
    dates, U, D = _synthetic()
    q, info = m.forecast_origin(dates, D.copy(), 800, (0.0, 0.04, 0.6, 0.9), U[800])
    assert not info["abstain"] and info["n_paths"] == info["train_rows"] - 6
    assert info["train_rows"] == 730
    assert np.all(np.diff(q) >= 0)
    assert 0.0 <= q[0] <= q[-1] <= 0.64


def test_abstain_early():
    dates, U, D = _synthetic()
    q, info = m.forecast_origin(dates, D.copy(), 300, (0.0, 0.04, 0.6, 0.9), U[300])
    assert q is None and info["abstain"]


def test_no_future_leak():
    dates, U, D = _synthetic()
    q1, _ = m.forecast_origin(dates, D.copy(), 700, (0.0, 0.04, 0.6, 0.9), U[700])
    D2 = D.copy()
    D2[701:] = 9.0
    q2, _ = m.forecast_origin(dates, D2, 700, (0.0, 0.04, 0.6, 0.9), U[700])
    assert np.array_equal(q1, q2)


def test_zero_vol_gives_point():
    n = 800
    dates = pd.date_range("2023-02-02", periods=n, freq="D", tz="UTC")
    D = np.full(n, np.nan)
    D[1:] = 1e-6 * np.sign(np.sin(np.arange(1, n)))
    q, _ = m.forecast_origin(dates, D.copy(), 799, (0.0, 0.04, 0.6, 0.9), 0.5)
    assert np.allclose(q, 0.04 * 0.5 / 0.9, atol=1e-6)


def test_daily_state_last_read_before_midnight():
    h = pd.DataFrame({
        "hour_utc": ["2023-02-01T22:00Z", "2023-02-01T23:00Z", "2023-02-02T05:00Z"],
        "block": [1, 2, 3], "variable_debt_raw": [50, 60, 70], "stable_debt_raw": [0, 0, 0],
        "virtual_balance_raw": [np.nan, np.nan, np.nan], "cash_balance_raw": [50, 40, 30],
        "optimal_usage_ray": [9 * 10**26] * 3, "base_rate_ray": [0] * 3, "slope1_ray": [4 * 10**25] * 3,
        "slope2_ray": [6 * 10**26] * 3, "rd_variable_borrow_rate_ray": [10**25, 2 * 10**25, 3 * 10**25]})
    st = m.daily_state(h)
    d = pd.Timestamp("2023-02-02", tz="UTC")
    assert st.loc[d, "U"] == 0.6 and st.loc[d, "apr"] == 0.02
    assert st.loc[pd.Timestamp("2023-02-03", tz="UTC"), "U"] == 0.7


def test_guard():
    try:
        m.guard("x 0x" + "a" * 40)
    except SystemExit:
        return
    raise AssertionError


if __name__ == "__main__":
    for k, v in list(globals().items()):
        if k.startswith("test_"):
            v()
    print("ok")
