"""Synthetic tests for r1110_p3 (no blind data)."""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import r1110_p3 as P  # noqa: E402


def test_to_sec_ms_and_us():
    assert P.to_sec(1704067200000) == 1704067200
    assert P.to_sec(1735689600000000) == 1735689600


def test_months_span():
    ms = list(P.months(P.A.utc("2024-11-05T00:00:00Z")))
    assert ms[0] == (2024, 11) and ms[-1] == (2026, 9) and len(ms) == 23


def test_pooled_hac_and_boot_detect_negative_mean():
    rng = np.random.default_rng(0)
    ts = np.repeat(P.A.utc("2025-01-06T00:00:00Z") + 3600 * np.arange(4000), 3)
    d = rng.normal(-0.05, 1.0, len(ts))
    h = P.pooled_hac(ts, d)
    b = P.boot_for(ts, d, 0)
    assert h["mean_diff"] < 0 and h["p_one_sided"] < 0.05
    assert b["p_one_sided"] < 0.05
    h0 = P.pooled_hac(ts, -d)
    assert h0["p_one_sided"] > 0.5


def test_boot_diff_sign():
    rng = np.random.default_rng(1)
    ts = P.A.utc("2025-01-06T00:00:00Z") + 3600 * np.arange(20000)
    grp = rng.random(len(ts)) < 0.1
    d = rng.normal(0, 1, len(ts)) - 0.5 * grp
    r = P.boot_diff(ts, d, grp, 0)
    assert r["diff"] < 0 and r["p_one_sided"] < 0.05


def test_selection_count():
    ds = os.environ.get("MEMBRANE_DATASETS", "/home/user/membrane-datasets")
    if not os.path.exists(os.path.join(ds, P.SEL_PATH)):
        return
    kept, excl, _ = P.select_pairs(ds)
    assert len(kept) == 56
    assert sorted(e["symbol"] for e in excl) == ["BNSOLUSDT", "EURIUSDT"]
