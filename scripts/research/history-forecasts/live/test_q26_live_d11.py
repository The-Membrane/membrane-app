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


def _score_world(tmp, n_ser=60, days=2):
    """A synthetic D11 world: n_ser test series issued on `days` daily origins from T0, stores, coverage, devcal."""
    ldir = L.C.live_dir(tmp)
    U = {"series": [{"symbol": f"S{j}USDT", "key": f"x:S{j}USDT", "role": "test"} for j in range(n_ser)]}
    rng = np.random.default_rng(5)
    prev = L.C.ZERO_SHA
    for d in range(days):
        t = T0 + d * L.DAY
        ser = []
        for e in U["series"]:
            fH = {L.TL[T]: list(np.sort(rng.uniform(0.001, 0.2, len(L.DEV_LV[T])))[::-1]) for T in L.HORIZONS}
            D = {k: list(np.minimum(1, np.array(v) * 1.1)) for k, v in fH.items()}
            ser.append({"symbol": e["symbol"], "key": e["key"], "role": "test", "issued": True, "S": 100.0,
                        "fH": fH, "D": D, "censorAll": False})
        raw = L.gz_json({"date": L.C.utc_date(t), "origin": t, "prevSha256": prev, "series": ser})
        p = os.path.join(L.issue_dir(ldir), L.C.utc_date(t) + ".json.gz")
        os.makedirs(os.path.dirname(p), exist_ok=True)
        open(p, "wb").write(raw)
        prev = L.C.sha256_bytes(raw)
    for e in U["series"]:
        rows = [[str((T0 + j * H) * 1000), "1", "1", str(100 * (1 - rng.uniform(0, 0.04))), "1", "1", "0"]
                for j in range(days * 24)]
        _store(ldir, e["symbol"], rows)
    cov = os.path.join(ldir, L.D11_SUB, "klines", "coverage.jsonl")
    open(cov, "w").write(json.dumps({"fetchedAt": 0, "covered": {e["symbol"]: T0 + days * L.DAY for e in U["series"]}})
                         + "\n")
    arrs = {}
    for (T, k) in L.CELLS:
        nm = L.cell_name(T, k).replace(" ", "_")
        n = 2000
        p_ = rng.uniform(0.01, 0.2, n)
        arrs[f"{nm}_ts"] = (T0 - L.DAY * rng.integers(1, 700, n)).astype(np.int64)
        arrs[f"{nm}_fH"] = p_.astype(np.float32)
        arrs[f"{nm}_D"] = p_
        arrs[f"{nm}_y"] = (rng.random(n) < p_).astype(np.int8)
    np.savez_compressed(os.path.join(tmp, "devcal.npz"), **arrs)
    a = types.SimpleNamespace(datasets=tmp, out=tmp, devcal="devcal.npz",
                              devcal_sha256=L.C.sha256_file(os.path.join(tmp, "devcal.npz")))
    return ldir, U, a


def test_crash_between_outcome_and_ledger_appends_is_recovered():
    saved = (L.ensure_ci_replay, L.update_all, L.C.append_bytes, L.CalPool.add)
    try:
        L.ensure_ci_replay = lambda a, U, log=print: None
        L.update_all = lambda *x, **k: ({}, [])
        with tempfile.TemporaryDirectory() as tmp:
            ldir, U, a = _score_world(tmp)
            orig = saved[2]

            def crashing(path, data):
                if path.endswith("ledger.jsonl"):
                    raise OSError("simulated crash")
                return orig(path, data)
            L.C.append_bytes = crashing
            now = lambda: T0 + 13 * H                    # only day 1 is due
            try:
                L.score(a, U, log=lambda *x: None, clock=now)
                raise AssertionError("crash not simulated")
            except OSError:
                pass
            L.C.append_bytes = orig
            op = L.outcomes_path(ldir, T0)
            orphan = open(op, "rb").read()
            assert orphan.count(b"\n") == 1 and not os.path.exists(L.ledger_path(ldir))
            # make the orphan differ from what the redo writes (as a crash mid-write or another code path might)
            o = json.loads(orphan)
            o["series"][0]["y"]["3h"] = [1, 1, 1, 1]
            open(op, "wb").write((json.dumps(o, separators=(",", ":")) + "\n").encode())
            L.score(a, U, log=lambda *x: None, clock=now)
            led, _ = L.read_ledger(ldir)
            assert len(led) == 1
            lines = open(op, "rb").read().splitlines(keepends=True)
            assert len(lines) == 2
            assert led[0]["outcomeSha256"] == L.C.sha256_bytes(lines[1]) != L.C.sha256_bytes(lines[0])
            seen = []
            L.CalPool.add = lambda self, origin, T, k, pH, pD, y: seen.append((origin, T, k, y))
            L.score(a, U, log=lambda *x: None, clock=lambda: T0 + L.DAY + 13 * H)   # day 2 rebuilds the pool
            led, _ = L.read_ledger(ldir)
            assert len(led) == 2
            day1_3h = [x for x in seen if x[0] == T0 and x[1] == 3]
            good = json.loads(lines[1])
            assert len(day1_3h) == sum(len(r["y"]["3h"]) for r in good["series"] if r["y"]["3h"] is not None)
            first = [x[3] for x in day1_3h[:4]]
            assert first == list(good["series"][0]["y"]["3h"])         # the ledgered line, not the orphan
    finally:
        L.ensure_ci_replay, L.update_all, L.C.append_bytes, L.CalPool.add = saved


def test_censor_all_series_counts_in_the_bound_and_pessimistic_delta():
    maps = _ident_maps()
    rows = [([0.2, 0.1, 0.05, 0.01], [0.1, 0.05, 0.02, 0.01], [0, 0, 0, 0]),
            ([0.2, 0.1, 0.05, 0.01], [0.3, 0.2, 0.1, 0.05], None)]           # second series censored
    r = L.day_delta(rows, maps, 3, L.D8_LV[3])
    full = L.day_delta(rows[:1], maps, 3, L.D8_LV[3])
    assert r["N"] == 8 and r["labelled"] == 4
    assert abs(r["delta"] - full["delta"] / 2) < 1e-15
    assert r["L"] <= r["deltaPess"] <= r["delta"]
