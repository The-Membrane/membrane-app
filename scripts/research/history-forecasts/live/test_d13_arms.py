#!/usr/bin/env python3
"""Synthetic tests of the D13-A1 input arms (membrane-board design/HISTORY_TOUCH_LIVE.md D13-A1). No network.

  python3 -m pytest -q live/test_d13_arms.py
"""
import json
import os
import sys
import tempfile
import types

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import d13_arms as AR  # noqa: E402
import q26_live_common as C  # noqa: E402
import q26_live_d13 as L  # noqa: E402
import test_q26_live_d13 as T13  # noqa: E402

H, DAY = 3600, 86400


def test_js_round2_matches_math_round():
    assert AR.js_round2(2713.7) == 2713.7 and AR.js_round2(64123.456) == 64123.46
    assert AR.js_round2(1.005) == 1.0                         # 1.005 * 100 = 100.49999999999999 (JS gives 1)
    assert AR.js_round2(0.125) == 0.13                        # ties toward +infinity (JS Math.round)
    assert AR.js_round2(-0.125) == -0.12
    assert AR.js_round2(float("nan")) is None


def test_c_columns_price_history_rule():
    R = C.Round
    h0 = 1_800_000_000 - 1_800_000_000 % H
    rounds = [R(1, 100_00000000, h0 - 100),                   # in force at h0 (pre hour)
              R(2, 101_00000000, h0 + 10),                    # hour 0: low includes 100 (in force at the start)
              R(3, 99_50000000, h0 + 20),
              R(4, 102_00000000, h0 + 3 * H + 5)]             # hours 1, 2 forward filled; hour 3 new round
    cl, lo, hi = AR.c_columns(rounds, "ETH", h0, 5)
    assert list(cl) == [99.5, 99.5, 99.5, 102.0, 102.0]
    assert list(lo) == [99.5, 99.5, 99.5, 99.5, 102.0]
    assert list(hi) == [101.0, 99.5, 99.5, 102.0, 102.0]
    cl, lo, hi = AR.c_columns(rounds[:1], "ETH", h0, 60)    # stale after 48 h: null, not flat
    assert np.isfinite(cl[47]) and not np.isfinite(cl[48])


def test_v_twap_constant_tick():
    P = AR.V_POOLS["ETHUSDT"]
    tick = 196_000
    tc = np.array([[1e12 + tick * (36_000 - 600 * q) for q in range(13)]], float)
    tw = AR.v_twap(tc, P)
    want = 10.0 ** 12 / 1.0001 ** tick
    assert np.allclose(tw[0], want, rtol=1e-12)
    P2 = AR.V_POOLS["BTCUSDT"]
    tc2 = np.array([[5e11 + 70_000 * (36_000 - 600 * q) for q in range(13)]], float)
    assert np.allclose(AR.v_twap(tc2, P2)[0], 1.0001 ** 70_000 * 100.0, rtol=1e-12)


def test_v_store_bars_and_splice(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        ldir = os.path.join(tmp, "live")
        sym = "ETHUSDT"
        rows = []
        for j in range(60):
            Hh = AR.V_STORE_START + j * H
            tick = 196_000 + (j % 7) * 3
            tc = [str(int(1e12) + tick * (Hh - 600 * q)) for q in range(13)]
            rows.append([str(Hh), "1", str(Hh + 5), "0"] + tc)
        rows[10][3] = "1"
        rows[10][4:] = [""] * 13
        p = AR.v_store_path(ldir, sym)
        C.append_bytes(p, C.gz_member(AR.V_HEADER, rows))
        cl, lo, hi = AR.v_store_bars(ldir, sym, AR.V_STORE_START + 59 * H)
        assert len(cl) == 60 and not np.isfinite(cl[10]) and np.isfinite(cl[11])
        want = float(f"{10.0 ** 12 / 1.0001 ** (196_000 + 3):.10g}")
        assert cl[1] == want and lo[1] == want and hi[1] == want
        # a grid with the same bars passes the splice check; one changed value fails it
        st = AR.V_STORE_START - 200 * H
        n = 300
        g = {c: np.full(n, np.nan) for c in ("close", "low", "high")}
        s0 = (AR.V_STORE_START - H - st) // H
        for c, v in (("close", cl), ("low", lo), ("high", hi)):
            g[c][s0:s0 + 60] = v
        gp = os.path.join(tmp, "g.json")
        json.dump({"startTs": st, "columns": {c: [None if not np.isfinite(x) else float(x) for x in g[c]]
                                              for c in g}}, open(gp, "w"))
        UA = {"arms": {"V": {"series": [{"symbol": sym, "key": "V:x", "gridPath": gp}]}}}
        monkeypatch.setattr(AR, "V_GRID_END", AR.V_STORE_START + 40 * H)
        ok, det = AR.splice_check("V", UA, tmp, ldir, sym)
        assert ok and det["valuesEqual"] == det["valuesCompared"] == 41 * 3
        g["close"][s0 + 5] *= 1.0000001
        json.dump({"startTs": st, "columns": {c: [None if not np.isfinite(x) else float(x) for x in g[c]]
                                              for c in g}}, open(gp, "w"))
        ok, _ = AR.splice_check("V", UA, tmp, ldir, sym)
        assert not ok


def test_arms_issue_and_score_follow_the_primary_truth(monkeypatch):
    """End to end on the synthetic D13 world: each arm issues its own chained file, and its outcome lines carry the
    primary's target-(b) labels; arm ledgers and classes are written beside the primary's, which stays unchanged."""
    fo = L.C.A.utc("2026-03-02T00:00:00Z")
    with tempfile.TemporaryDirectory() as tmp:
        w = T13.World(tmp, fo, monkeypatch)
        monkeypatch.setattr(L, "ensure_ci_replay", lambda a, U, log=print: {"pass": True})
        monkeypatch.setattr(AR, "run_arms", REAL_RUN_ARMS)
        monkeypatch.setattr(AR, "FIRST_ORIGIN", fo)
        e_eth = [e for e in w.U["series"] if e["symbol"] == "ETHUSDT"][0]
        UA = {"arms": {arm: {"series": [{"symbol": s, "key": f"{arm}:{s}", "gridPath": e_eth["gridPath"],
                                         "gridSha256": e_eth["gridSha256"]} for s in AR.SYMS],
                             "v0": {u[0]: {"A": 0.05, "B": 0.05} for u in AR.arm_units()},
                             "climatology": {L.gkey(T, k, "ETHBTC"): 0.05 for (T, k) in L.CELLS}} for arm in AR.ARMS},
              "goldenSha256": "x"}
        monkeypatch.setattr(AR, "load_universe", lambda: UA)
        monkeypatch.setattr(AR, "ensure_ci", lambda arm, a, UA, ldir, log=print: {"pass": True})
        monkeypatch.setattr(AR, "probe_status", lambda ldir, log=print, probe=None: {"pass": True})
        monkeypatch.setattr(AR, "splice_status", lambda arm, UA, ds, ldir: {s: {"pass": True} for s in AR.SYMS})
        monkeypatch.setattr(AR, "store_covers", lambda arm, ldir, sym, t: True)

        def grid(arm, UA_, datasets, ldir, sym, upto):        # the arm input = the primary's III path (ETHUSDT)
            st, cols, rows, g = L.series_grid(e_eth, datasets, ldir, upto)
            if arm == "V":
                g = {c: v * 1.001 for c, v in g.items()}
            return st, cols, g
        monkeypatch.setattr(AR, "arm_grid", grid)
        clock = lambda: w.now   # noqa: E731
        a = T13._args(w)
        log = []
        for d in range(5):
            w.now = fo + d * DAY + 10 * 60
            T13._d12_store(w, clock)
            w.now = fo + d * DAY + 17 * 60
            assert L.issue(a, w.U, log=log.append, clock=clock, http_get=w.http_get) == 0
            w.now = fo + d * DAY + 47 * 60
            L.score(a, w.U, log=log.append, clock=clock, http_get=w.http_get)
        ldir = L.C.live_dir(w.out)
        led13, _ = L.read_ledger(ldir)
        truth = AR.primary_truth(ldir)
        for arm in AR.ARMS:
            names = AR.list_issues(ldir, arm)
            assert len(names) == 5 and AR.verify_issue_chain(ldir, arm) != C.ZERO_SHA
            doc, _ = AR.read_issue(ldir, arm, names[0])
            assert doc["nIssued"] == 2 and doc["arm"] == arm
            led, _ = AR.read_ledger(ldir, arm)
            assert {(x["origin"], x["T"]) for x in led} == {(x["origin"], x["T"]) for x in led13}
            outs = AR.read_outcomes(ldir, arm)
            for x in led:
                o = outs[x["outcomeSha256"]]
                for r in o["series"]:
                    assert r["y"] == truth[(x["origin"], x["T"])].get(r["symbol"])
                assert set(x["groups"]) <= {u[0] for u in AR.arm_units()}
            cls = json.load(open(os.path.join(ldir, "d13", "arms", f"classes-{arm}.json")))
            assert cls["surfaced"] is False and len(cls["monitors"]) == 40 and len(cls["cells"]) == 35
        assert any(x.startswith("d13 arm C issue: 2 series issued") for x in log)
        before = open(AR.ledger_path(ldir, "C"), "rb").read()
        L.score(a, w.U, log=log.append, clock=clock, http_get=w.http_get)
        assert open(AR.ledger_path(ldir, "C"), "rb").read() == before


def test_arm_failure_never_changes_the_primary(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        a = types.SimpleNamespace(datasets=tmp, out=tmp, workers=1, code={"commit": "t"})
        monkeypatch.setattr(AR, "load_universe", lambda: {"arms": {}, "goldenSha256": "x"})
        log = []
        AR.run_arms("issue", a, log=log.append)                 # KeyError inside each arm: logged, not raised
        assert log == ["d13 arm C: error (KeyError)", "d13 arm V: error (KeyError)"]


REAL_RUN_ARMS = AR.run_arms
