"""Synthetic tests for r105_recal.py (Q26 R10.5). No real data."""
import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import r105_recal as M  # noqa: E402


def test_recal_identity_when_calibrated_or_empty():
    p = np.array([0.1, 0.5, 0.9])
    assert np.allclose(M.recal(p, 0, 0, 10), p)          # empty window: R = 1, lambda = 0
    assert np.allclose(M.recal(p, 7, 7, 10), p)          # R = 1


def test_recal_direction_and_shrink():
    p = np.array([0.2])
    over = M.recal(p, 39, 9, 10)                         # R = 4, lambda = 0.47: lower
    under = M.recal(p, 9, 39, 10)                        # R = 0.25: higher
    assert over[0] < 0.2 < under[0]
    lam = 9 / 19
    assert np.isclose(M.logit(over)[0], M.logit(p)[0] - lam * np.log(4.0))
    assert M.recal(p, 39, 9, 5)[0] < M.recal(p, 39, 9, 20)[0]


def test_recal_edges():
    assert M.recal(np.array([0.0]), 10, 1, 5)[0] == 0.0
    assert M.recal(np.array([1.0]), 1, 10, 5)[0] == 1.0


def test_window_sums_asof():
    res = np.array([0.0, 24.0, 48.0, 72.0])
    p = np.array([1.0, 2.0, 3.0, 4.0])
    y = np.array([0, 1, 0, 1])
    sp, sy = M.window_sums(res, p, y, np.array([48.0, 47.9, 100.0]), 2)
    # t=48: (0, 48] -> rows 24, 48; t=47.9: (-0.1, 47.9] -> 0, 24; t=100: (52, 100] -> 72
    assert list(sp) == [5.0, 3.0, 4.0]
    assert list(sy) == [1.0, 1.0, 1.0]


def test_apply_cell_no_lookahead_and_monotone():
    rng = np.random.default_rng(0)
    days = np.arange(200) * 24.0
    ks = [-0.02, -0.05, -0.1]
    t = np.repeat(days, 3)
    k = np.tile(ks, 200)
    p = np.tile([0.4, 0.2, 0.05], 200)
    y = (rng.random(600) < p / 2).astype(int)
    T_h = 72
    out = M.apply_cell(t, k, p, y, T_h, 30, 10)
    # monotone across levels at every issue
    o = out.reshape(200, 3)
    assert np.all(np.diff(o, axis=1) <= 1e-15)
    # changing outcomes of rows not yet resolved at day 100 leaves day-100 p' unchanged
    y2 = y.copy()
    late = t + T_h > 100 * 24.0
    y2[late] = 1 - y2[late]
    out2 = M.apply_cell(t, k, p, y2, T_h, 30, 10)
    m = t == 100 * 24.0
    assert np.allclose(out[m], out2[m])
    # over-forecast history pulls p' below p
    assert out[t > 60 * 24].mean() < p[t > 60 * 24].mean()


def test_live_recal_and_pass_shape():
    outs = []
    base = 1_800_000_000
    rng = np.random.default_rng(1)
    for d in range(100):
        for kk, pp in [(-0.02, 0.3), (-0.05, 0.1)]:
            outs.append({"status": "resolved", "displayed": "fH", "p": {"fH": pp, "a": 0.5}, "date": f"D{d:03d}",
                         "asset": "ETH", "T": "1d", "T_h": 24, "k": kk, "y": int(rng.random() < pp / 3),
                         "asof": base + 86400 * d, "issuedAt": base + 86400 * d + 1000})
    outs.append({"status": "excluded_touched_before_issue", "displayed": "fH", "p": {"fH": 0.3}})
    outs.append({"status": "resolved", "p": {"f": 0.3}, "date": "x", "asset": "ETH", "T": "1d", "T_h": 24, "k": -0.02,
                 "y": 0, "asof": base, "issuedAt": base})      # no displayed rung: ignored
    rr = M.live_recal(outs, 30, 10)
    assert len(rr) == 200
    first = [r for r in rr if r["date"] == "D000"]
    assert all(np.isclose(r["p_recal"], r["p"]) for r in first)   # nothing resolved before the first issue
    res = M.live_pass(rr)
    assert res["1d"]["resolvedIssueDays"] == 100 and res["1d"]["tested"]
    assert "pass" in res["1d"]
    assert res["6h"]["tested"] is False


def test_guard():
    with pytest.raises(SystemExit):
        M.guard('{"a": "0x' + "ab" * 20 + '"}')


def test_pipeline_synthetic(tmp_path, monkeypatch):
    import json
    import pandas as pd
    ds = tmp_path / "ds"
    a6 = ds / M.A6_DIR
    a6.mkdir(parents=True)
    disp = {a: {T: ("a" if a == "stETH" else "fH") for T in M.HORIZONS} for a in M.ASSETS}
    (a6 / "display-a6.json").write_text(json.dumps({"displayed": disp}))
    rng = np.random.default_rng(2)
    t0 = pd.date_range("2022-01-01", "2026-09-01", freq="6h", tz="UTC")
    for a in M.ASSETS:
        ks = [-0.005, -0.01, -0.02, -0.05] if a == "stETH" else [-0.02, -0.05, -0.1]
        rows = []
        for T in M.HORIZONS:
            for t in t0[::4][:: (1 if T in ("6h", "1d") else 1)]:
                for j, k in enumerate(ks):
                    p = 0.3 / (j + 1)
                    rows.append({"series": a, "t0": t.strftime("%Y-%m-%dT%H:%M:%SZ"), "T": T, "k": k,
                                 "y": int(rng.random() < p * 0.7), "regime": "mid", "p_a": p, "p_fH": p})
        pd.DataFrame(rows).to_csv(a6 / f"predictions-dev-{a}.csv.gz", index=False)
    monkeypatch.setattr(M, "DATASETS", str(ds))
    monkeypatch.setattr(M, "DISPLAY_SHA256", M.sha256_file(str(a6 / "display-a6.json")))
    monkeypatch.setattr(M, "git_sha", lambda: ("f" * 40, False))
    monkeypatch.setattr(M, "BOOT_REPS", 50)
    out = tmp_path / "out"
    M.cmd_freeze(str(out))
    M.cmd_run(str(out))
    fr = json.loads((out / "frozen-r105.json").read_text())
    assert fr["selected"]["W_days"] in M.W_GRID
    res = json.loads((out / "results-dev.json").read_text())
    assert set(res["perHorizon"]) == set(M.HORIZONS)
    assert res["perHorizon"]["1d"]["bss"] > 0          # constant over-forecast is corrected
