#!/usr/bin/env python3
"""Synthetic tests of the D11 live block (membrane-board design/HISTORY_TOUCH_LIVE.md D11). No network, no torch.

  python3 -m pytest -q live/test_q26_live_d11.py
"""
import gzip
import json
import math
import os
import sys
import tempfile
import types

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import q26_live_d11 as L  # noqa: E402

H = 3600
T0 = L.C.A.utc("2026-10-24T00:00:00Z")


def test_grapa_bet_is_predictable_and_never_ruins():
    rng = np.random.default_rng(1)
    st = {"n": 0, "s1": 0.0, "s2": 0.0, "logK": 0.0}
    for _ in range(2000):
        B = float(rng.uniform(0.005, 0.05))
        d = float(rng.uniform(-B, B))
        before = dict(st)
        st, lam = L.grapa_step(st, d, B, 0.5 * L.DEV_MU[3], L.DEV_V0[3])
        # the bet depends only on the state before the day and on B
        _, lam2 = L.grapa_step(before, -d, B, 0.5 * L.DEV_MU[3], L.DEV_V0[3])
        assert lam == lam2
        assert 0 <= lam <= L.CAP_FRAC / B + 1e-15
        assert 1 + lam * d >= 0.5 - 1e-12
        assert math.isfinite(st["logK"])


def test_harm_process_starts_with_no_bet():
    st = {"n": 0, "s1": 0.0, "s2": 0.0, "logK": 0.0}
    _, lam = L.grapa_step(st, 0.01, 0.02, 0.0, L.DEV_V0[3])
    assert lam == 0.0


def _ident_maps():
    return {c: {"fH": (0.0, 1.0, 0, 0, "identity"), "D": (0.0, 1.0, 0, 0, "identity")} for c in L.CELLS}


def test_day_delta_bounds_hold_and_censored_rows_add_zero():
    rng = np.random.default_rng(2)
    maps = _ident_maps()
    for _ in range(200):
        rows = []
        for _ in range(30):
            pH = np.sort(rng.uniform(0.001, 0.3, 4))[::-1]
            pD = np.sort(rng.uniform(0.001, 0.3, 4))[::-1]
            y = None if rng.random() < 0.1 else [int(v) for v in (rng.random(4) < pH)]
            if y is not None:                       # touch at a deeper level implies the shallower ones
                y = list(np.maximum.accumulate(np.array(y)[::-1])[::-1])
            rows.append((list(pH), list(pD), y))
        r = L.day_delta(rows, maps, 3, L.D8_LV[3])
        assert r["L"] - 1e-12 <= r["delta"] <= r["U"] + 1e-12
        assert r["B"] >= max(-r["L"], r["U"]) - 1e-15
        assert r["N"] == 30 * 4
        cens = [(a, b, None) for a, b, _ in rows]
        assert L.day_delta(cens, maps, 3, L.D8_LV[3])["delta"] == 0.0


def test_day_delta_uses_only_d8_levels_at_1h():
    maps = _ident_maps()
    rows = [([0.1, 0.05, 0.01], [0.1, 0.05, 0.5], [0, 0, 0])]   # a wild -5% D value must not count at 1 h
    r = L.day_delta(rows, maps, 1, L.D8_LV[1])
    assert r["N"] == 2 and r["delta"] == 0.0


def test_extend_grid_store_never_overrides_dev_and_marks_gaps():
    st = T0 - 10 * H
    cols = {c: np.arange(5, dtype=float) + 1 for c in ("close", "low", "high")}
    vol = np.ones(5)
    rows = [[str((st + 3 * H) * 1000), "9", "9", "9", "9", "9", "0"],          # inside the dev grid: ignored
            [str((st + 6 * H) * 1000), "1", "7", "6", "6.5", "2", "0"],
            [str((st + 9 * H) * 1000), "1", "8", "7", "7.5", "3", "0"],
            [str((st + 10 * H) * 1000), "1", "9", "8", "8.5", "4", "0"]]       # opens at the origin: never read
    g, v = L.extend_grid(st, cols, vol, rows, T0)
    assert len(g["close"]) == 10
    assert g["close"][3] == 4.0
    assert np.isnan(g["close"][5]) and g["close"][6] == 6.5 and np.isnan(g["close"][7]) and g["close"][9] == 7.5
    assert v[9] == 3.0


def _store(tmp, sym, rows):
    p = L.store_path(tmp, sym)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "wb") as f:
        f.write(L.C.gz_member(L.KLINE_HEADER, rows))


def test_labels_follow_the_development_rule():
    with tempfile.TemporaryDirectory() as tmp:
        S = 100.0
        lows = [99.5, 99.0, 97.9, 99.0] + [99.0] * 8          # -2.1% in hour 3 (inside 3 h and 12 h)
        rows = [[str((T0 + j * H) * 1000), "1", "1", str(lo), "1", "1", "0"] for j, lo in enumerate(lows)]
        _store(tmp, "XUSDT", rows)
        e = {"symbol": "XUSDT"}
        assert L.labels_for(e, tmp, T0, S, {"XUSDT": T0 + 11 * H}) is None        # not yet fetched through t + 12 h
        lab = L.labels_for(e, tmp, T0, S, {"XUSDT": T0 + 13 * H})
        assert lab[1] == [0, 0, 0]
        assert lab[3] == [1, 0, 0, 0]
        assert lab[12] == [1, 0, 0, 0, 0]


def test_labels_censor_a_window_with_too_many_missing_hours():
    with tempfile.TemporaryDirectory() as tmp:
        rows = [[str((T0 + j * H) * 1000), "1", "1", "99", "1", "1", "0"] for j in (0, 5, 6, 7, 8, 9, 10, 11)]
        _store(tmp, "XUSDT", rows)
        lab = L.labels_for({"symbol": "XUSDT"}, tmp, T0, 100.0, {"XUSDT": T0 + 13 * H})
        assert lab[1] is not None
        assert lab[3] is None                      # 2 of 3 hours missing


def test_store_bootstrap_after_dev_grid_and_skips_open_kline():
    with tempfile.TemporaryDirectory() as tmp:
        dev_end = T0 - 5 * H
        now = T0 + 30 * 60

        def get(url):
            assert f"startTime={(dev_end + H) * 1000}" in url
            ks = []
            for j in range(1, 7):
                o = dev_end + j * H
                ks.append([o * 1000, "1", "2", "0.5", "1.5", "10", (o + H) * 1000 - 1, "0", 1, "0", "0", "0"])
            return json.dumps(ks).encode()
        r = L.update_store(tmp, {"symbol": "XUSDT", "devEndOpen": dev_end}, http_get=get, clock=lambda: now)
        rows = L.read_store(L.store_path(tmp, "XUSDT"))
        assert r["appended"] == 4                  # opens T0-4h..T0-1h; the T0 kline is still open at T0 + 30 min
        assert int(rows[-1][0]) // 1000 == T0 - H


def test_platt_maps_ignore_rows_on_or_after_the_origin():
    with tempfile.TemporaryDirectory() as tmp:
        rng = np.random.default_rng(3)
        arrs = {}
        for (T, k) in L.CELLS:
            nm = L.cell_name(T, k).replace(" ", "_")
            n = 3000
            ts = T0 - L.DAY * rng.integers(1, 700, n)
            p = rng.uniform(0.01, 0.2, n)
            arrs[f"{nm}_ts"] = ts.astype(np.int64)
            arrs[f"{nm}_fH"] = p.astype(np.float32)
            arrs[f"{nm}_D"] = p
            arrs[f"{nm}_y"] = (rng.random(n) < 1.3 * p).astype(np.int8)
        fn = os.path.join(tmp, "devcal.npz")
        np.savez_compressed(fn, **arrs)
        pool = L.CalPool(fn)
        m1 = pool.maps(T0)
        for _ in range(500):
            pool.add(T0, 3, -0.02, 0.01, 0.9, 1)    # same-day rows: outcome not resolved before the origin
        m2 = pool.maps(T0)
        assert m1[(3, -0.02)]["D"] == m2[(3, -0.02)]["D"]
        assert m1[(3, -0.02)]["D"][4] == "platt"


def test_ledger_chain_detects_tampering():
    with tempfile.TemporaryDirectory() as tmp:
        p = L.ledger_path(tmp)
        os.makedirs(os.path.dirname(p))
        prev = L.C.ZERO_SHA
        lines = []
        for j in range(3):
            raw = (json.dumps({"j": j, "prevSha256": prev}, separators=(",", ":")) + "\n").encode()
            lines.append(raw)
            prev = L.C.sha256_bytes(raw)
        open(p, "wb").write(b"".join(lines))
        led, _ = L.read_ledger(tmp)
        assert len(led) == 3
        open(p, "wb").write(lines[0] + lines[2])
        try:
            L.read_ledger(tmp)
            raise AssertionError("tampering not detected")
        except SystemExit as e:
            assert "STOP" in str(e)


def test_issue_guards():
    calls = {"compute": 0}
    saved = (L.check_universe, L.ensure_ci_replay, L.update_all, L.compute_origin)
    try:
        L.check_universe = lambda U, d: None
        L.ensure_ci_replay = lambda a, U, log=print: None
        L.update_all = lambda *x, **k: ({}, [])

        def comp(*x, **k):
            calls["compute"] += 1
            raise AssertionError("must not compute")
        L.compute_origin = comp
        with tempfile.TemporaryDirectory() as tmp:
            a = types.SimpleNamespace(datasets=tmp, out=tmp, workers=1, code={})
            msgs = []
            L.issue(a, {"series": []}, log=msgs.append, clock=lambda: L.FIRST_ORIGIN - 3600)
            assert "before the first origin" in msgs[-1]
            L.issue(a, {"series": []}, log=msgs.append, clock=lambda: L.FIRST_ORIGIN + 23 * 3600 + 5)
            assert "23 h or more" in msgs[-1]
            d = L.issue_dir(L.C.live_dir(tmp))
            os.makedirs(d)
            open(os.path.join(d, L.C.utc_date(L.FIRST_ORIGIN) + ".json.gz"), "wb").write(gzip.compress(b"{}"))
            L.issue(a, {"series": []}, log=msgs.append, clock=lambda: L.FIRST_ORIGIN + 1000)
            assert "already issued" in msgs[-1]
        assert calls["compute"] == 0
    finally:
        L.check_universe, L.ensure_ci_replay, L.update_all, L.compute_origin = saved


def test_universe_shape():
    U = L.load_universe()
    tests = [e for e in U["series"] if e["role"] == "test"]
    desc = [e["symbol"] for e in U["series"] if e["role"] == "descriptive"]
    assert len(tests) == 273 and sorted(desc) == ["BTCUSDT", "ETHUSDT"]
    syms = [e["symbol"] for e in U["series"]]
    assert len(set(syms)) == len(syms)
    for e in tests:
        assert e["symbol"].endswith("USDT") and e["symbol"] not in ("ETHUSDT", "BTCUSDT", "JUPUSDT")


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
