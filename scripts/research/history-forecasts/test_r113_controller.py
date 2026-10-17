"""Synthetic tests for r113_controller.py (Q26 R11.3). No real data."""
import json
import os
import sys

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import r113_controller as M  # noqa: E402


def _cell(n_days=300, p=(0.4, 0.2, 0.05), scale=0.5, seed=0):
    rng = np.random.default_rng(seed)
    nK = len(p)
    day = np.repeat(np.arange(n_days), nK)
    kpos = np.tile(np.arange(nK), n_days)
    pp = np.tile(p, n_days)
    y = (rng.random(len(pp)) < pp * scale).astype(float)
    return day, kpos, pp, y, nK


def test_identity_at_zero_gain_and_first_day():
    day, kpos, p, y, nK = _cell()
    out, D = M.simulate_cell(day, kpos, p, y, nK, np.zeros(nK, int), 24, [(0.0, 30), (0.1, 30)])
    assert np.allclose(out[0], p)                                  # g = 0: p' = p
    assert np.allclose(out[1][day == 0], p[day == 0])              # nothing resolved before day 0
    assert np.all(D[0] == 0)


def test_direction_clip_and_monotone():
    day, kpos, p, y, nK = _cell(scale=0.3)
    out, D = M.simulate_cell(day, kpos, p, y, nK, np.zeros(nK, int), 24, [(0.2, 30)])
    assert out[0][day > 100].mean() < p[day > 100].mean()          # over-forecast is pulled down
    assert D.min() >= -1 and D.max() <= 1
    o = out[0].reshape(-1, nK)
    assert np.all(np.diff(o, axis=1) <= 1e-15)


def test_update_equation_exact():
    # one level, T = 1 d: delta_1 = (1 - rho) * 0 + g * (y0 - p0) / max(p0 (1 - p0), 1)
    day = np.array([0, 1, 2])
    kpos = np.zeros(3, int)
    p = np.array([0.3, 0.3, 0.3])
    y = np.array([1.0, 0.0, 0.0])
    out, D = M.simulate_cell(day, kpos, p, y, 1, np.zeros(1, int), 24, [(0.1, 30)])
    d1 = 0.1 * (1 - 0.3) / 1.0
    assert np.isclose(D[0, 1, 0], d1)
    assert np.isclose(out[0][1], M.expit(M.logit(0.3) + d1))
    p1 = out[0][1]
    d2 = (1 - 1 / 30) * d1 + 0.1 * (0 - p1) / 1.0
    assert np.isclose(D[0, 2, 0], d2)


def test_no_lookahead_3d():
    day, kpos, p, y, nK = _cell(seed=3)
    T_h = 72
    out, _ = M.simulate_cell(day, kpos, p, y, nK, np.array([0, 0, 1]), T_h, [(0.2, 90)])
    y2 = y.copy()
    late = day * 24 + T_h > 100 * 24                              # unresolved at the day-100 issue
    y2[late] = 1 - y2[late]
    out2, _ = M.simulate_cell(day, kpos, p, y2, nK, np.array([0, 0, 1]), T_h, [(0.2, 90)])
    m = day <= 100
    assert np.allclose(out[0][m], out2[0][m])


def test_bands():
    assert list(M.band_of("ETH", [-0.02, -0.07, -0.2, -0.4])) == [0, 1, 2, 2]
    assert list(M.band_of("stETH", [-0.005, -0.05])) == [0, 0]


def test_hac_known():
    rng = np.random.default_rng(1)
    r = M.hac_test(rng.normal(1.0, 1.0, 400))
    assert r["p_one_sided"] < 1e-6
    r = M.hac_test(rng.normal(-0.5, 1.0, 400))
    assert r["p_one_sided"] > 0.99


def test_agrapa_predictable_and_capped():
    d = np.array([0.5, 0.5, 0.5, -1.0])
    K = M.agrapa_wealth(d)
    assert K[0] == 1.0                                             # lambda_1 = 0
    # lambda_2 from mu_1 = 0.25, s2_1 = (1 + 0.0625) / 2
    mu1, s21 = 0.25, (1 + 0.25 ** 2) / 2
    lam2 = min(mu1 / (s21 + mu1 ** 2), 0.5)
    assert np.isclose(K[1], 1 + lam2 * 0.5)
    assert np.all(K > 0)
    assert np.all(M.agrapa_wealth(-np.abs(np.random.default_rng(0).random(200))) == 1.0)   # never bets on losses


def test_agrapa_grows_on_strong_signal():
    rng = np.random.default_rng(2)
    d = np.clip(rng.normal(0.3, 0.2, 400), -1, 1)
    assert M.agrapa_wealth(d)[-1] > 1 / M.ALPHA_LIVE


def test_eprocess_3d_subsequences():
    days = pd.date_range("2027-01-01", periods=9, freq="D").strftime("%Y-%m-%d").tolist()
    d = np.full(9, 0.4)
    K = M.eprocess_path(days, d, "3d")
    # each subsequence bets 0 on its first issue, so the statistic is 1/3 for the first three days
    assert np.allclose(K[:3], 1.0 / 3)
    assert K[-1] > 1.0
    K1 = M.agrapa_wealth(d[::3])
    assert np.isclose(K[-1], K1[-1] / 3)                             # max3: max_r K^r / 3
    Km = M.eprocess_path(days, d, "3d", combine="mean")
    assert np.isclose(Km[-1], K1[-1])                                # withdrawn mean, kept for the record


def test_max3_valid_on_overlapping_true_null():
    # overlapping 3-day outcomes under a true null: d_t = mean of shocks revealed after issue t (days t+1..t+3)
    rng = np.random.default_rng(7)
    days = pd.date_range("2027-01-01", periods=730, freq="D").strftime("%Y-%m-%d").tolist()
    hits = 0
    reps = 300
    for _ in range(reps):
        e = rng.choice([-0.9, 0.9], size=733)
        d = (e[1:731] + e[2:732] + e[3:733]) / 3
        hits += M.eprocess_decision(days, d, "3d", alpha=0.05)["crossed"]
    assert hits / reps <= 0.05 + 3 * np.sqrt(0.05 * 0.95 / reps)


def test_null_false_pass_small_on_weak_signal():
    rng = np.random.default_rng(5)
    days = pd.date_range("2022-01-01", periods=1500, freq="D")
    d = rng.normal(0.0005, 0.01, 1500)
    r = M.null_false_pass(days, d, "1d", reps=200)
    assert r["false_pass_rate"] <= M.ALPHA_LIVE
    r3 = M.null_false_pass(days, d, "3d", reps=50)
    assert r3["window_days"] == 730


def test_live_controller_and_eprocess():
    base = 1_800_000_000
    rng = np.random.default_rng(1)
    outs = []
    for dd in range(60):
        date = (pd.Timestamp("2026-10-17") + pd.Timedelta(days=dd)).strftime("%Y-%m-%d")
        for kk, pp in [(-0.02, 0.3), (-0.07, 0.1), (-0.2, 0.02)]:
            outs.append({"status": "resolved", "displayed": "fH", "p": {"fH": pp, "a": 0.5}, "date": date,
                         "asset": "ETH", "T": "1d", "T_h": 24, "k": kk, "y": int(rng.random() < pp / 3),
                         "asof": base + 86400 * dd, "issuedAt": base + 86400 * dd + 1000})
    outs.append(dict(outs[0]))                                         # duplicate row is dropped
    outs.append({"status": "excluded_touched_before_issue", "displayed": "fH", "p": {"fH": 0.3}})
    df = M.live_controller(outs, 0.1, 90)
    assert len(df) == 180
    first = df[df["day"] == df["day"].min()]
    assert np.allclose(first["p_new"], first["p"])
    res = M.live_eprocess(df, ["6h", "1d"])
    assert res["1d"]["n_days"] == 60 and res["1d"]["status"] in ("running", "pass")
    assert res["6h"]["n_days"] == 0


def test_scaled_bound():
    g = pd.DataFrame({"day": ["a"] * 4 + ["b"] * 2, "p": [0.3, 0.1, 0.9, 0.5, 0.2, 0.2],
                      "q": [0.2, 0.15, 0.8, 0.5, 0.2, 0.2], "y": [1, 0, 0, 1, 0, 1]})
    days, x = M.daily_scaled(g, "p", "q")
    assert list(days) == ["a", "b"] and x[1] == 0.0
    # any outcomes: |d| <= c
    for ys in np.array(np.meshgrid(*[[0, 1]] * 4)).T.reshape(-1, 4):
        gg = g.copy()
        gg.loc[:3, "y"] = ys
        _, xx = M.daily_scaled(gg, "p", "q")
        assert abs(xx[0]) <= 1 + 1e-12


def test_guard():
    with pytest.raises(SystemExit):
        M.guard('{"a": "0x' + "ab" * 20 + '"}')


def test_pipeline_synthetic(tmp_path, monkeypatch):
    ds = tmp_path / "ds"
    a6 = ds / M.A6_DIR
    a6.mkdir(parents=True)
    r5 = ds / M.R105_DIR
    r5.mkdir(parents=True)
    (r5 / "frozen-r105.json").write_text("{}")
    disp = {a: {T: ("a" if a == "stETH" else "fH") for T in M.HORIZONS} for a in M.ASSETS}
    (a6 / "display-a6.json").write_text(json.dumps({"displayed": disp}))
    rng = np.random.default_rng(2)
    t0 = pd.date_range("2021-01-01", "2026-09-30", freq="D", tz="UTC")
    for a in M.ASSETS:
        ks = [-0.005, -0.01, -0.02, -0.05] if a == "stETH" else [-0.02, -0.05, -0.1, -0.2]
        rows = []
        for T in M.HORIZONS:
            for t in t0:
                for j, k in enumerate(ks):
                    p = 0.3 / (j + 1)
                    rows.append({"series": a, "t0": t.strftime("%Y-%m-%dT%H:%M:%SZ"), "T": T, "k": k,
                                 "y": int(rng.random() < p * 0.6), "regime": "mid", "p_a": 0.25 / (j + 1),
                                 "p_fH": p})
        pd.DataFrame(rows).to_csv(a6 / f"predictions-dev-{a}.csv.gz", index=False)
    monkeypatch.setattr(M, "DATASETS", str(ds))
    monkeypatch.setattr(M, "DISPLAY_SHA256", M.sha256_file(str(a6 / "display-a6.json")))
    monkeypatch.setattr(M, "R105_SHA256", M.sha256_file(str(r5 / "frozen-r105.json")))
    monkeypatch.setattr(M, "git_sha", lambda: ("f" * 40, False))
    monkeypatch.setattr(M, "NULL_REPS", 20)
    monkeypatch.setattr(M.null_false_pass, "__defaults__",
                        (M.ALPHA_LIVE, 20, M.NULL_SEED, M.NULL_BLOCK, M.MAX_LIVE_DAYS, "max3"))
    out = tmp_path / "out"
    M.cmd_freeze(str(out))
    cfg = json.loads((out / "frozen-r113-config.json").read_text())
    assert cfg["createdUTC"].endswith("Z")
    M.cmd_run(str(out))
    fr = json.loads((out / "frozen-r113.json").read_text())
    assert fr["selected"]["gain"] in M.GAINS
    res = json.loads((out / "results-history.json").read_text())
    assert set(res["historyTest"]) == set(M.TESTED)
    assert res["historyTest"]["1d"]["bss_vs_static"] > 0               # constant over-forecast is corrected
    assert set(res["eprocessNull"]) == {"R10.5", "R11.3"}
    assert (out / "deltas-frozen.csv.gz").exists()
