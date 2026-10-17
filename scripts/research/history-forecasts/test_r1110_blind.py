"""Synthetic tests for r1110_blind.py (no real data)."""
import numpy as np

import a_touch as A
import a3_touch as M3
import r1110_blind as R


def _ser(n=24 * 600, seed=1):
    rng = np.random.default_rng(seed)
    st = A.utc("2015-08-07T14:00:00Z")
    c = 3.0 * np.exp(np.cumsum(rng.normal(0, 0.01, n)))
    lo = c * np.exp(-np.abs(rng.normal(0, 0.004, n)))
    hi = c * np.exp(np.abs(rng.normal(0, 0.004, n)))
    c[100:110] = np.nan
    lo[100:110] = np.nan
    hi[100:110] = np.nan
    ser = M3.S3("syn", "ETH", "syn", c, lo, R.LEVELS, st, st)
    R.A6.attach_high(ser, hi)
    return ser


def test_folds():
    ser = _ser()
    f = R.p1_folds(ser)
    assert A.iso(f[0]["qs_ts"]) == "2016-08-07T00:00:00Z"
    assert [x["name"] for x in f] == ["F1-2016Q3p", "2016Q4", "2017Q1"]
    assert f[-1]["qe_ts"] == R.P1_END


def test_rungs_and_score():
    ser = _ser()
    folds = R.p1_folds(ser)
    B = R.build_rungs(ser, ser, folds)
    for T in R.HORIZONS:
        P = B[T]["P"]
        for r in R.RUNGS:
            x = P[r][np.all(np.isfinite(P[r]), axis=1)]
            assert np.all(np.diff(x, axis=1) <= 1e-15)          # running minimum across levels
        res = R.score_T(T, B[T], B[T]["ts"] + T * 3600 <= R.P1_END, log=lambda s: None)
        assert res["dm_lag"] == T - 1 and "pass" in res


def test_days_to_power():
    rng = np.random.default_rng(3)
    d = rng.normal(-0.001, 0.01, 10000)
    out = R.days_to_power(d, 0)
    z = R.norm.ppf(1 - R.ALPHA) + R.norm.ppf(0.8)
    assert abs(out["n_origins"] - z * z * d.var() / d.mean() ** 2) / out["n_origins"] < 1e-6
    assert R.days_to_power(-d, 0)["days"] is None


if __name__ == "__main__":
    test_folds()
    test_rungs_and_score()
    test_days_to_power()
    print("ok")
