#!/usr/bin/env python3
"""Synthetic tests of the D12 live block (membrane-board design/HISTORY_TOUCH_LIVE.md D12). No network.

  python3 -m pytest -q live/test_q26_live_d12.py
"""
import gzip
import json
import math
import os
import sys
import tempfile
import types
import urllib.parse

import numpy as np
import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import q26_live_d12 as L  # noqa: E402
import d12_oc as OC  # noqa: E402

H, DAY = 3600, 86400


# ---------------------------------------------------------------------------------------------------------------------
# the monitor
# ---------------------------------------------------------------------------------------------------------------------
def _rand_day(rng, n, scale):
    p = rng.uniform(0, 0.2, n)
    y = (rng.random(n) < p * scale).astype(int)
    return p, y


def test_bet_is_predictable_and_never_ruins():
    rng = np.random.default_rng(1)
    st = L.new_group_state(72)
    hist = {"A": [], "B": []}
    for di in range(400):
        p, y = _rand_day(rng, 18, rng.uniform(0.3, 3))
        rows = [([0] * 4 + [pp] + [0] * 3, [0] * 4 + [yy] + [0] * 3, [0.1] * 8, [0.1] * 8) for pp, yy in zip(p, y)]
        ds = L.day_sums(rows, 4)
        assert -ds["XA"] <= ds["BA"] + 1e-12 and -ds["XB"] <= ds["BB"] + 1e-12
        lamA = L.plugin_lambda(hist["A"], 1.0, ds["BA"])
        lamB = L.plugin_lambda(hist["B"], 1.0, ds["BB"])
        assert 1 + lamA * ds["XA"] >= 1 - L.CAP_FRAC - 1e-12
        assert 1 + lamB * ds["XB"] >= 1 - L.CAP_FRAC - 1e-12
        st, bets, _ = L.monitor_step(st, ds, di, hist, {"A": 1.0, "B": 1.0}, "d")
        assert bets["lamA"] == lamA and bets["lamB"] == lamB      # the bet does not see the day's outcome
        hist["A"].append(ds["XA"])
        hist["B"].append(ds["XB"])
        assert all(math.isfinite(x) for x in st["logKA"] + st["logKB"])


def test_censored_rows_add_zero_and_keep_the_bound():
    rows = [([0.1] * 8, None, [0.1] * 8, [0.1] * 8), ([0.2] * 8, [1] * 8, [0.1] * 8, [0.1] * 8)]
    ds = L.day_sums(rows, 4)
    assert ds["nIssued"] == 2 and ds["nLabelled"] == 1
    assert ds["sumP"] == pytest.approx(0.2) and ds["sumY"] == 1
    assert ds["BB"] == pytest.approx((0.1 + 0.2) / 0.8)


def _sequential_first(n, P, Y, T, v0):
    """The live monitor_step day by day on one path of daily sums (every issued row labelled)."""
    st = L.new_group_state(T)
    hist = []
    h = L.h_of(T)
    for s in range(len(P)):
        if n[s] == 0:
            continue
        ds = {"nIssued": n[s], "nLabelled": n[s], "sumP": P[s], "sumY": Y[s], "XA": P[s] / 1.25 - Y[s],
              "XB": Y[s] - P[s] / 0.8, "BA": n[s] - P[s] / 1.25, "BB": P[s] / 0.8, "bsP": 0.0, "bsA": 0.0, "bsE": 0.0}
        hh = [x for x in hist if x[0] <= s - h]
        st, _, _ = L.monitor_step(st, ds, s, {"A": [x[1] for x in hh], "B": [x[2] for x in hh]}, v0, "d")
        hist.append((s, ds["XA"], ds["XB"]))
        if st["downgraded"]:
            return s + h
    return -1


@pytest.mark.parametrize("T", [6, 24, 72, 168])
def test_vectorised_oc_equals_live_monitor(T):
    rng = np.random.default_rng(T)
    paths, N = 6, 500
    n = rng.integers(0, 4, (paths, N)).astype(float)
    P = n * rng.uniform(0.02, 0.2, (paths, N))
    scale = np.array([0.3, 0.5, 1.0, 1.0, 2.5, 4.0])[:, None]
    Y = np.minimum(n, rng.binomial(n.astype(int), np.clip(P / np.maximum(n, 1) * scale, 0, 1)))
    v0 = {"A": 0.05, "B": 0.05}
    f = OC.run_paths(n, P, Y, L.h_of(T), v0["A"], v0["B"])
    for q in range(paths):
        assert f[q] == _sequential_first(n[q], P[q], Y[q], T, v0)
    assert (f >= 0).any()                                   # some path downgrades (miscalibrated ones)


def test_threshold_and_subsequences():
    assert L.h_of(6) == L.h_of(12) == L.h_of(24) == 1
    assert L.h_of(72) == 3 and L.h_of(168) == 7
    assert L.new_group_state(168)["threshold"] == pytest.approx(7 / 0.05)


def test_label_rule_matches_the_spot_label():
    low = np.array([100, 99, 95, 89.9, 101.0])
    assert L.label_from_lows(low, 100.0, 4) == [1, 1, 1, 1, 1, 0, 0, 0]
    assert L.label_from_lows(np.array([100, 99, 98, 97.0]), 100.0, 4) == [1, 1, 0, 0, 0, 0, 0, 0]
    assert L.label_from_lows(np.full(6, np.nan), 100.0, 6) is None


# ---------------------------------------------------------------------------------------------------------------------
# end to end on synthetic grids and a fake Binance endpoint
# ---------------------------------------------------------------------------------------------------------------------
def _grid(seed, st, n):
    rng = np.random.default_rng(seed)
    r = rng.standard_t(4, n) * 0.006
    c = 100 * np.exp(np.cumsum(r))
    lo = c * np.exp(-np.abs(rng.normal(0, 0.004, n)))
    hi = c * np.exp(np.abs(rng.normal(0, 0.004, n)))
    return {"startTs": st, "columns": {"close": list(c), "low": list(lo), "high": list(hi), "volume": [1.0] * n}}


class World:
    def __init__(self, tmp, first_origin):
        self.ds = os.path.join(tmp, "ds")
        self.out = os.path.join(tmp, "out")
        os.makedirs(os.path.join(self.ds, "g"))
        st = first_origin - 560 * DAY
        self.dev_end = first_origin - 3 * DAY                 # the development grid ends 3 days before the origin
        n_dev = (self.dev_end - st) // H
        n_all = (first_origin + 40 * DAY - st) // H
        self.full = {}
        series = []
        for j, (sym, g) in enumerate((("ETHUSDT", "ETHBTC"), ("AAAUSDT", "LARGE"))):
            G = _grid(10 + j, st, n_all)
            self.full[sym] = G
            dev = {"startTs": st, "columns": {k: v[:n_dev] for k, v in G["columns"].items()}}
            p = os.path.join("g", sym + ".json")
            raw = json.dumps(dev).encode()
            open(os.path.join(self.ds, p), "wb").write(raw)
            series.append({"key": f"t:{sym}", "symbol": sym, "group": g, "path": p,
                           "sha256": L.C.sha256_bytes(raw), "startTs": st, "devEndOpen": self.dev_end - H})
        gk = [L.gkey(T, k, g) for (T, k) in L.CELLS for g in L.GROUPS]
        ck = gk + [L.gkey(T, k, g) for T in L.TS for k in L.POOL_LV for g in L.GROUPS]
        self.U = {"series": series, "climatology": {x: 0.05 for x in ck},
                  "v0": {u[0]: {"A": 0.05, "B": 0.05} for u in L.monitor_units()}, "goldenSha256": "x"}
        self.now = first_origin

    def http_get(self, url):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
        G = self.full[q["symbol"][0]]
        st = G["startTs"]
        out = []
        o = int(q["startTime"][0]) // 1000
        while len(out) < int(q["limit"][0]) and o + H <= self.now + H:
            j = (o - st) // H
            if j >= len(G["columns"]["close"]):
                break
            c = G["columns"]
            out.append([o * 1000, "0", str(c["high"][j]), str(c["low"][j]), str(c["close"][j]), "1", (o + H) * 1000 - 1])
            o += H
        return json.dumps(out).encode()


def _args(w):
    return types.SimpleNamespace(datasets=w.ds, out=w.out, workers=1, code={"commit": "test"})


def test_issue_and_score_end_to_end(monkeypatch):
    fo = L.C.A.utc("2026-03-02T00:00:00Z")
    with tempfile.TemporaryDirectory() as tmp:
        w = World(tmp, fo)
        monkeypatch.setattr(L, "FIRST_ORIGIN", fo)
        monkeypatch.setattr(L, "ensure_ci_replay", lambda a, U, log=print: {"pass": True})
        clock = lambda: w.now   # noqa: E731
        a = _args(w)
        log = []
        for d in range(12):
            w.now = fo + d * DAY + 17 * 60
            assert L.issue(a, w.U, log=log.append, clock=clock, http_get=w.http_get, ) == 0
            w.now = fo + d * DAY + 47 * 60
            L.score(a, w.U, log=log.append, clock=clock, http_get=w.http_get)
        ldir = L.C.live_dir(w.out)
        names = L.list_issues(ldir)
        assert len(names) == 12 and L.verify_issue_chain(ldir)
        doc, _ = L.read_issue(ldir, names[0])
        assert doc["nIssued"] == 2 and all(not r["censorAll"] for r in doc["series"])
        # a second issue on the same day refuses (no rewrite), and a backwards clock stops
        w.now = fo + 11 * DAY + 3 * H
        L.issue(a, w.U, log=log.append, clock=clock, http_get=w.http_get)
        assert log[-1] == "d12 issue: none (origin already issued)"
        led, _ = L.read_ledger(ldir)
        per_T = {}
        for x in led:
            per_T.setdefault(x["T"], []).append(x["date"])
        assert len(per_T["6h"]) == 11 and len(per_T["1d"]) == 11 and len(per_T["3d"]) == 9 and len(per_T["7d"]) == 5
        for v in per_T.values():
            assert v == sorted(v)
        # outcome y equals the label on the full synthetic grid
        outs = L.read_outcomes(ldir)
        x = [x for x in led if x["T"] == "1d"][3]
        o = outs[x["outcomeSha256"]]
        for r in o["series"]:
            G = w.full[r["symbol"]]
            j0 = (x["origin"] - G["startTs"]) // H
            S = G["columns"]["close"][j0 - 1]
            assert r["y"] == L.label_from_lows(np.array(G["columns"]["low"][j0:j0 + 24]), S, 24)
        cls = json.load(open(os.path.join(ldir, "d12", "classes.json")))
        assert len(cls["monitors"]) == 26 and len(cls["cells"]) == 2 * (5 * 5 + 3)
        assert set(c["class"] for c in cls["cells"].values()) <= {L.CLASS_WARN, L.CLASS_DOWN, L.CLASS_RECAL,
                                                                  L.CLASS_HC, "CALIBRATED", "DO NOT SHOW"}
        json.load(open(os.path.join(ldir, "d12", "summary.json")))
        # rescoring changes no ledger byte
        before = open(L.ledger_path(ldir), "rb").read()
        L.score(a, w.U, log=log.append, clock=clock, http_get=w.http_get)
        assert open(L.ledger_path(ldir), "rb").read() == before


def test_no_lookahead_on_the_issue(monkeypatch):
    """Changing every store kline at or after the origin leaves the issued rows unchanged."""
    fo = L.C.A.utc("2026-03-02T00:00:00Z")
    rows = []
    for garble in (False, True):
        with tempfile.TemporaryDirectory() as tmp:
            w = World(tmp, fo)
            if garble:
                for G in w.full.values():
                    st = G["startTs"]
                    j0 = (fo - st) // H
                    for c in ("close", "low", "high"):
                        G["columns"][c][j0:] = [v * 3 for v in G["columns"][c][j0:]]
            monkeypatch.setattr(L, "FIRST_ORIGIN", fo)
            monkeypatch.setattr(L, "ensure_ci_replay", lambda a, U, log=print: {"pass": True})
            w.now = fo + 5 * H
            L.issue(_args(w), w.U, log=lambda *x: None, clock=lambda: w.now, http_get=w.http_get)
            doc, _ = L.read_issue(L.C.live_dir(w.out), L.list_issues(L.C.live_dir(w.out))[0])
            rows.append([{k: r[k] for k in ("S", "fH", "f", "a")} for r in doc["series"]])
    assert rows[0] == rows[1]


def test_late_store_keeps_the_series_censored(monkeypatch):
    fo = L.C.A.utc("2026-03-02T00:00:00Z")
    with tempfile.TemporaryDirectory() as tmp:
        w = World(tmp, fo)
        monkeypatch.setattr(L, "FIRST_ORIGIN", fo)
        monkeypatch.setattr(L, "ensure_ci_replay", lambda a, U, log=print: {"pass": True})

        def broken(url):
            raise OSError("down")
        w.now = fo + 5 * H
        L.issue(_args(w), w.U, log=lambda *x: None, clock=lambda: w.now, http_get=broken)
        doc, _ = L.read_issue(L.C.live_dir(w.out), L.list_issues(L.C.live_dir(w.out))[0])
        # the development grid ends 3 days before the origin, so the series cannot be computed without the store:
        # it is not issued for that origin-time reason; a series whose rows exist but whose store is late is censored
        assert all((not r["issued"]) or r["censorAll"] for r in doc["series"])


def test_orphan_outcome_line_is_ignored(monkeypatch):
    fo = L.C.A.utc("2026-03-02T00:00:00Z")
    with tempfile.TemporaryDirectory() as tmp:
        w = World(tmp, fo)
        monkeypatch.setattr(L, "FIRST_ORIGIN", fo)
        monkeypatch.setattr(L, "ensure_ci_replay", lambda a, U, log=print: {"pass": True})
        a = _args(w)
        w.now = fo + 17 * 60
        L.issue(a, w.U, log=lambda *x: None, clock=lambda: w.now, http_get=w.http_get)
        ldir = L.C.live_dir(w.out)
        p = L.outcomes_path(ldir, fo)
        L.C.append_bytes(p, b'{"date":"x","origin":0,"T":"6h","series":[]}\n')     # crash leftover
        w.now = fo + DAY + 47 * 60
        L.score(a, w.U, log=lambda *x: None, clock=lambda: w.now, http_get=w.http_get)
        led, _ = L.read_ledger(ldir)
        assert len(led) >= 3 and all(x["outcomeSha256"] in L.read_outcomes(ldir) for x in led)


def test_ledger_chain_break_stops(monkeypatch):
    fo = L.C.A.utc("2026-03-02T00:00:00Z")
    with tempfile.TemporaryDirectory() as tmp:
        w = World(tmp, fo)
        monkeypatch.setattr(L, "FIRST_ORIGIN", fo)
        monkeypatch.setattr(L, "ensure_ci_replay", lambda a, U, log=print: {"pass": True})
        a = _args(w)
        w.now = fo + 17 * 60
        L.issue(a, w.U, log=lambda *x: None, clock=lambda: w.now, http_get=w.http_get)
        w.now = fo + DAY + 47 * 60
        L.score(a, w.U, log=lambda *x: None, clock=lambda: w.now, http_get=w.http_get)
        lp = L.ledger_path(L.C.live_dir(w.out))
        lines = open(lp, "rb").read().splitlines(keepends=True)
        open(lp, "wb").write(b"".join(lines[1:]))
        with pytest.raises(SystemExit):
            L.read_ledger(L.C.live_dir(w.out))


def test_universe_and_golden_files_are_consistent():
    U = L.load_universe()
    assert len(U["series"]) == 20
    assert [e["symbol"] for e in U["series"] if e["group"] == "ETHBTC"] == ["ETHUSDT", "BTCUSDT"]
    assert L.C.sha256_file(L.golden_path()) == U["goldenSha256"]
    G = json.load(open(L.golden_path()))
    assert sum(len(v) for o in G["rows"].values() for v in o.values()) == 300
    for gk, T, js, g in L.monitor_units():
        assert U["v0"][gk]["A"] > 0 and U["v0"][gk]["B"] > 0
        for j in js:
            assert 0 < U["climatology"][L.gkey(T, L.L8[j], g)] < 1


# ---------------------------------------------------------------------------------------------------------------------
# D12-A2
# ---------------------------------------------------------------------------------------------------------------------
def test_pooled_day_sums_run_over_rows_and_levels():
    rows = [([0.3, 0.2, 0.1, 0.05, 0.02, 0.01, 0.0, 0.0], [1, 1, 0, 0, 0, 0, 0, 0], [0.1] * 8, [0.1] * 8),
            ([0.3, 0.2, 0.1, 0.05, 0.02, 0.01, 0.0, 0.0], None, [0.1] * 8, [0.1] * 8)]
    ds = L.day_sums(rows, list(L.POOL_J))
    assert ds["sumP"] == pytest.approx(0.67) and ds["sumY"] == 2 and ds["nLabelled"] == 1
    assert ds["BB"] == pytest.approx(2 * 0.67 / 0.8) and ds["BA"] == pytest.approx(2 * (5 - 0.67 / 1.25))
    assert -ds["XA"] <= ds["BA"] and -ds["XB"] <= ds["BB"]


def test_default_classes_and_downgrade_semantics():
    st = L.initial_state()
    assert st[L.gkey(24, -0.20, "ETHBTC")]["class"] == L.CLASS_HC
    assert st[L.gkey(12, -0.10, "ETHBTC")]["class"] == L.CLASS_RECAL
    assert st[L.gkey(72, -0.20, "ETHBTC")]["class"] == "DO NOT SHOW"
    assert st[L.gkey(168, -0.20, "ETHBTC")]["class"] == "CALIBRATED"
    assert st[L.gkey(24, -0.10, "LARGE")]["class"] == L.CLASS_WARN
    assert len(st) == 16 + 10
    eff = L.effective_classes(st)
    assert eff["ETHBTC 1d -20%"] == L.CLASS_HC and eff["LARGE 6h -2%"] == L.CLASS_RECAL
    # the pooled monitor fires: every pooled level of that horizon and group that is a warning becomes CALIBRATED
    st[L.pkey(72, "LARGE")]["downgraded"] = True
    st[L.pkey(72, "LARGE")]["downgradedAt"] = "2027-01-01"
    eff = L.effective_classes(st)
    for k in (-2, -3, -5, -7, -10):
        assert eff[f"LARGE 3d {k}%"] == "CALIBRATED"
    assert eff["LARGE 3d -20%"] == L.CLASS_WARN and eff["ETHBTC 3d -10%"] == L.CLASS_WARN
    # a non-warning default keeps its class when its monitor fires
    st[L.gkey(24, -0.20, "ETHBTC")]["downgraded"] = True
    assert L.effective_classes(st)["ETHBTC 1d -20%"] == L.CLASS_HC


def test_monitor_flag_on_non_warning_class_keeps_class():
    st = L.new_group_state(24, L.CLASS_RECAL)
    hist = {"A": [], "B": []}
    for di in range(400):                      # forecasts 0.2, never a touch: strong over-forecast
        rows = [([0.2] * 8, [0] * 8, [0.1] * 8, [0.1] * 8) for _ in range(18)]
        ds = L.day_sums(rows, 4)
        st, _, _ = L.monitor_step(st, ds, di, hist, {"A": 1.0, "B": 1.0}, f"d{di:04d}")
        hist["A"].append(ds["XA"])
        hist["B"].append(ds["XB"])
        if st["downgraded"]:
            break
    assert st["downgraded"] and st["class"] == L.CLASS_RECAL and st["lastObserved"] == st["downgradedAt"]


def test_classes_json_last_dates_use_the_max(monkeypatch):
    fo = L.C.A.utc("2026-03-02T00:00:00Z")
    with tempfile.TemporaryDirectory() as tmp:
        w = World(tmp, fo)
        monkeypatch.setattr(L, "FIRST_ORIGIN", fo)
        monkeypatch.setattr(L, "ensure_ci_replay", lambda a, U, log=print: {"pass": True})
        a = _args(w)
        for d in range(9):
            w.now = fo + d * DAY + 17 * 60
            L.issue(a, w.U, log=lambda *x: None, clock=lambda: w.now, http_get=w.http_get)
            w.now = fo + d * DAY + 47 * 60
            L.score(a, w.U, log=lambda *x: None, clock=lambda: w.now, http_get=w.http_get)
        cls = json.load(open(os.path.join(L.C.live_dir(w.out), "d12", "classes.json")))
        assert cls["lastLedgerDate"] == max(cls["lastLedgerDateByHorizon"].values()) == "2026-03-09"
        assert cls["lastLedgerDateByHorizon"]["7d"] == "2026-03-03"
        assert len(cls["monitors"]) == 26
        c = cls["cells"]["ETHBTC 6h -5%"]
        assert c["lastObserved"] == "2026-03-09" and c["monitors"] == [L.pkey(6, "ETHBTC")]
        assert cls["cells"]["ETHBTC 1d -20%"]["class"] == L.CLASS_HC
