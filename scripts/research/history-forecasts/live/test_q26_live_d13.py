#!/usr/bin/env python3
"""Synthetic tests of the D13 live block (membrane-board design/HISTORY_TOUCH_LIVE.md D13). No network.

  python3 -m pytest -q live/test_q26_live_d13.py
"""
import json
import math
import os
import random
import sys
import tempfile
import types
import urllib.parse

import numpy as np
import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import d13_twap as TW  # noqa: E402
import q26_live_d12 as L12  # noqa: E402
import q26_live_d13 as L  # noqa: E402

H, DAY = 3600, 86400


# ---------------------------------------------------------------------------------------------------------------------
# the TWAP rule
# ---------------------------------------------------------------------------------------------------------------------
def _walk(n, seed, gap=0.002, start=100.0):
    rnd = random.Random(seed)
    c, out = start, []
    for _ in range(n):
        c *= math.exp(rnd.gauss(0, 0.001))
        out.append(None if rnd.random() < gap else c)
    return out


def test_minute_G_is_the_fsum_window_mean():
    cl = _walk(6000, 1, gap=0.05)
    lc = TW.ln_closes(cl)
    G = TW.minute_G(lc)
    for m in range(len(cl)):
        w = [x for x in lc[max(0, m - 59):m + 1] if x is not None]
        want = math.exp(math.fsum(w) / len(w)) if (m >= 59 and len(w) >= 50) else None
        assert G[m] == want


def test_hour_bars_null_rule_and_rounding():
    cl = _walk(60 * 30, 2, gap=0.0)
    cl[60 * 5 + 7] = None                            # one missing minute: G stays defined (59 of 60)
    for j in range(60 * 9 + 3, 60 * 9 + 15):         # 12 missing minutes: some G undefined in hours 9 and 10
        cl[j] = None
    lo, hi, cl_ = TW.bars_from_closes(cl)
    assert lo[0] is None                             # hour 0 has no full look-back
    assert lo[5] is not None and lo[9] is None and hi[9] is None
    G = TW.minute_G(TW.ln_closes(cl))
    assert lo[3] == TW.round10(min(G[180:240])) and cl_[3] == TW.round10(G[239])
    assert all(v is None or v == float(f"{v:.10g}") for v in lo + hi + cl_)


def test_minutes_closing_after_the_hour_do_not_enter_its_bar():
    cl = _walk(60 * 6, 3, gap=0.0)
    a = TW.bars_from_closes(cl)
    cl2 = cl[:240] + [v * 5 for v in cl[240:]]
    b = TW.bars_from_closes(cl2)
    assert [x[:4] for x in a] == [x[:4] for x in b]


# ---------------------------------------------------------------------------------------------------------------------
# target (b) and the anchor flag
# ---------------------------------------------------------------------------------------------------------------------
def test_label_b_strict_null_rule_and_spot_label_form():
    rng = np.random.default_rng(4)
    for _ in range(200):
        T = int(rng.choice(L.TS))
        low = 100 * np.exp(np.cumsum(rng.normal(0, 0.01, T)))
        S = 100.0
        assert L.label_b(low, S, T) == L12.label_from_lows(low, S, T)
    low = np.full(24, 99.0)
    low[5] = np.nan
    assert L.label_b(low, 100.0, 24) is None          # one null hour censors (D12 tolerates it at 1 d)
    assert L.label_b(low[:10], 100.0, 24) is None


def test_anchor_commit_follows_oracle_sol():
    assert L.anchor_commit(100.0, 104.0) == 104.0
    assert L.anchor_commit(100.0, 120.0) == pytest.approx(105.0)
    assert L.anchor_commit(100.0, 80.0) == pytest.approx(95.0)
    assert L.anchor_commit(100.0, 100 / 1.05) == pytest.approx(100 / 1.05)      # deviation exactly 5%: re-anchors


def test_anchor_flag_known_answers():
    n = 200
    close = np.full(n, 100.0)
    low = np.full(n, 100.0)
    i = 100
    # a 10% step drop inside one hour: the anchor (100) cannot follow -> the -7% crossing is flagged
    close2, low2 = close.copy(), low.copy()
    close2[i + 3:] = 90.0
    low2[i + 3:] = 90.0
    f = L.anchor_flags(close2, low2, i, 24, 100.0)
    j7, j3, j15 = L.L8.index(-0.07), L.L8.index(-0.03), L.L8.index(-0.15)
    assert f[j7] == 1                                  # (100 - 93) / 93 = 7.5% > 5%
    assert f[j3] == 0                                  # (100 - 97) / 97 = 3.1%
    assert f[j15] == 0                                 # no crossing
    # a slow drift of -1% per hour: the anchor follows; no crossing is flagged
    close3 = 100 * 0.99 ** np.maximum(0, np.arange(n) - i + 1)
    f = L.anchor_flags(close3, close3.copy(), i, 168, 100.0)
    assert sum(f) == 0 and close3[i + 30] < 80
    # the 600 s rule (owner spec): the anchor follows 5% per 10 minutes, so a 10% drop spread over one hour is followed
    g10 = np.full((n, 6), 100.0)
    for q in range(6):
        g10[i + 3, q] = 100 * (1 - 0.1 * (q + 1) / 6)
    g10[i + 4:] = 90.0
    low4 = np.full(n, 100.0)
    low4[i + 3:] = 90.0
    j9 = L.L8.index(-0.10)
    assert L.anchor_flags10(g10, low4, i, 24, 100.0)[j7] == 0        # anchor 93.33 at the 91.67 point: 0.4%
    close4 = np.full(n, 100.0)
    close4[i + 3:] = 90.0
    assert L.anchor_flags(close4, low4, i, 24, 100.0)[j7] == 1        # as coded (hourly): anchor 100, 7.5%
    # a 10% gap inside one 10-minute step cannot be followed: flagged under both rules
    g10b = np.full((n, 6), 100.0)
    g10b[i + 3:] = 90.0
    assert L.anchor_flags10(g10b, low2, i, 24, 100.0)[j7] == 1
    assert L.anchor_flags(close2, low2, i, 24, 100.0)[j7] == 1
    assert L.anchor_flags10(g10b, low2, i, 24, 100.0)[j9] == 1      # (100 - 90) / 90 = 11%
    # the flag never touches a probability: it is a separate output of the label step
    assert L.label_b(low2[i:i + 24], 100.0, 24)[j7] == 1


# ---------------------------------------------------------------------------------------------------------------------
# a synthetic world: minute prices, development grids, a fake Binance endpoint (1 m and 1 h)
# ---------------------------------------------------------------------------------------------------------------------
class World:
    def __init__(self, tmp, first_origin, mp):
        self.ds = os.path.join(tmp, "ds")
        self.out = os.path.join(tmp, "out")
        os.makedirs(os.path.join(self.ds, "g"))
        self.st = st = first_origin - 560 * DAY
        self.grid_end = first_origin - 2 * DAY
        mp.setattr(L, "GRID_END", self.grid_end)
        mp.setattr(L, "STORE_START", self.grid_end - 3 * H)
        mp.setattr(L, "TAIL_START", self.grid_end - 26 * H)
        mp.setattr(L, "FIRST_ORIGIN", first_origin)
        mp.setattr(L12, "FIRST_ORIGIN", first_origin)
        self.t0 = st - H
        nmin = (first_origin + 30 * DAY - self.t0) // 60
        self.min = {}
        series = []
        for j, (sym, g) in enumerate((("ETHUSDT", "ETHBTC"), ("AAAUSDT", "LARGE"))):
            cl = _walk(nmin, 20 + j, gap=0.0005)
            self.min[sym] = cl
            lo, hi, c3 = TW.bars_from_closes(cl[:(self.grid_end - self.t0) // 60], 1, None)
            gp = os.path.join("g", f"III-{sym}.json")
            raw = json.dumps({"startTs": st, "columns": {"close": c3, "low": lo, "high": hi}}).encode()
            open(os.path.join(self.ds, gp), "wb").write(raw)
            kl = self.klines(sym, st, (self.grid_end - 2 * DAY - st) // H)
            kp = os.path.join("g", f"K-{sym}.json")
            kraw = json.dumps({"startTs": st, "columns": {"close": [k[2] for k in kl], "low": [k[1] for k in kl],
                                                          "high": [k[0] for k in kl]}}).encode()
            open(os.path.join(self.ds, kp), "wb").write(kraw)
            k0 = (L.TAIL_START - self.t0) // 60
            series.append({"key": f"t:{sym}", "symbol": sym, "group": g, "path": kp, "sha256": L.C.sha256_bytes(kraw),
                           "startTs": st, "devEndOpen": self.grid_end - 2 * DAY - H, "gridPath": gp,
                           "gridSha256": L.C.sha256_bytes(raw), "tailCloses": cl[k0:(self.grid_end - self.t0) // 60]})
        units = [u[0] for u in L.monitor_units()]
        cells = [L.gkey(T, k, g) for (T, k) in L.CELLS for g in L.GROUPS]
        self.U = {"series": series, "climatology": {x: 0.05 for x in cells},
                  "v0": {u: {"A": 0.05, "B": 0.05} for u in units}, "goldenSha256": "x",
                  "pathUnavailableDev": {x: {"share": 0.2} for x in cells},
                  "pathUnavailableDevHourly": {x: {"share": 0.3} for x in cells},
                  "ratioSums": {x: {"before2026Q4": [10.0, 5.0], "all": [10.0, 5.0]} for x in cells}}
        up = os.path.join(tmp, "u.json")
        json.dump(self.U, open(up, "w"))
        mp.setattr(L, "universe_path", lambda: up)
        self.now = first_origin

    def klines(self, sym, o, n):
        cl = self.min[sym]
        out = []
        for j in range(n):
            m0 = (o + j * H - self.t0) // 60
            w = [x for x in cl[m0:m0 + 60] if x is not None]
            out.append((max(w), min(w), w[-1]) if w else (None, None, None))
        return out

    def http_get(self, url):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
        sym, iv, lim = q["symbol"][0], q["interval"][0], int(q["limit"][0])
        o = int(q["startTime"][0]) // 1000
        step = 60 if iv == "1m" else H
        out = []
        cl = self.min[sym]
        while len(out) < lim and o + step <= self.now + step:
            if iv == "1m":
                m = (o - self.t0) // 60
                if m >= len(cl):
                    break
                if cl[m] is not None:
                    out.append([o * 1000, "0", "0", "0", repr(cl[m]), "1", (o + 60) * 1000 - 1])
            else:
                hi, lo, c = self.klines(sym, o, 1)[0]
                if c is not None:
                    out.append([o * 1000, "0", repr(hi), repr(lo), repr(c), "1", (o + H) * 1000 - 1])
            o += step
        return json.dumps(out).encode()


def _args(w):
    return types.SimpleNamespace(datasets=w.ds, out=w.out, workers=1, code={"commit": "test"})


def _d12_store(w, clock):
    ldir = L.C.live_dir(w.out)
    U12 = {"series": [dict(e) for e in w.U["series"]]}
    L12.update_all(ldir, U12, http_get=w.http_get, clock=clock, log=lambda *x: None, sleep=lambda s: None)


def test_store_bars_equal_full_recompute_and_splice(monkeypatch):
    fo = L.C.A.utc("2026-03-02T00:00:00Z")
    with tempfile.TemporaryDirectory() as tmp:
        w = World(tmp, fo, monkeypatch)
        w.now = fo + 5 * DAY
        ldir = L.C.live_dir(w.out)
        L.update_all(ldir, w.U, http_get=w.http_get, clock=lambda: w.now, log=lambda *x: None, sleep=lambda s: None)
        for e in w.U["series"]:
            sym = e["symbol"]
            st, cols, rows, g = L.series_grid(e, w.ds, ldir, fo + 3 * DAY)
            ok, det = L.splice_check(e, rows, cols, st)
            assert ok, det
            n = (fo + 3 * DAY - w.t0) // 60
            lo, hi, cl = TW.bars_from_closes(w.min[sym][:n], 1, None)
            want = np.array([np.nan if v is None else v for v in lo])
            assert np.array_equal(g["low"], want, equal_nan=True)
            # a tampered store minute before GRID_END fails the splice check
            bad = [list(r) for r in rows]
            bad[30][1] = repr(float(bad[30][1]) * 1.001)
            assert not L.splice_check(e, bad, cols, st)[0]


def test_issue_and_score_end_to_end(monkeypatch):
    fo = L.C.A.utc("2026-03-02T00:00:00Z")
    with tempfile.TemporaryDirectory() as tmp:
        w = World(tmp, fo, monkeypatch)
        monkeypatch.setattr(L, "ensure_ci_replay", lambda a, U, log=print: {"pass": True})
        clock = lambda: w.now   # noqa: E731
        a = _args(w)
        log = []
        for d in range(10):
            w.now = fo + d * DAY + 10 * 60
            _d12_store(w, clock)                                   # the d12 job runs first (its own block)
            w.now = fo + d * DAY + 17 * 60
            assert L.issue(a, w.U, log=log.append, clock=clock, http_get=w.http_get) == 0
            w.now = fo + d * DAY + 47 * 60
            L.score(a, w.U, log=log.append, clock=clock, http_get=w.http_get)
        ldir = L.C.live_dir(w.out)
        assert not os.path.exists(os.path.join(ldir, "d12", "issues"))        # D13 never writes the D12 block
        names = L.list_issues(ldir)
        assert len(names) == 10 and L.verify_issue_chain(ldir)
        doc, _ = L.read_issue(ldir, names[0])
        assert doc["nIssued"] == 2 and all(r["fHkline"] is not None for r in doc["series"])
        for r in doc["series"]:                                    # ratio arm: development sums give Y/P = 0.5
            want = L.f32(np.minimum.accumulate(np.minimum(1.0, np.array(r["fHkline"]["1d"], float) * 0.5)))
            assert r["fHratio"]["1d"] == want
        led, _ = L.read_ledger(ldir)
        per_T = {}
        for x in led:
            per_T.setdefault(x["T"], []).append(x["date"])
        assert len(per_T["6h"]) == 9 and len(per_T["3d"]) == 7 and len(per_T["7d"]) == 3
        outs = L.read_outcomes(ldir)
        x = [x for x in led if x["T"] == "1d"][2]
        o = outs[x["outcomeSha256"]]
        for r in o["series"]:
            cl = w.min[r["symbol"]]
            n = (x["origin"] + 24 * H - w.t0) // 60
            lo, hi, c3 = TW.bars_from_closes(cl[:n], 1, None)
            j0 = (x["origin"] - w.st) // H
            S = c3[j0 - 1]
            low = np.array([np.nan if v is None else v for v in lo[j0:j0 + 24]])
            assert r["y"] == L.label_b(low, S, 24)
            assert len(r["pathUnavailable"] or []) in (0, len(L.L8))
        cls = json.load(open(os.path.join(ldir, "d13", "classes.json")))
        assert len(cls["monitors"]) == 80 and len(cls["cells"]) == 70 and cls["surfaced"] is False
        assert cls["cells"]["LARGE 1d -10%"]["eventLabel"] == L.LABEL_LARGE
        assert cls["cells"]["ETHBTC 3d -20%"]["defaultSource"].startswith("current UI-map class")
        json.load(open(os.path.join(ldir, "d13", "summary.json")))
        before = open(L.ledger_path(ldir), "rb").read()
        L.score(a, w.U, log=log.append, clock=clock, http_get=w.http_get)
        assert open(L.ledger_path(ldir), "rb").read() == before


def test_no_lookahead_on_the_issue(monkeypatch):
    """Changing every 1 m close after the origin leaves the issued III rows unchanged."""
    fo = L.C.A.utc("2026-03-02T00:00:00Z")
    rows = []
    for garble in (False, True):
        with tempfile.TemporaryDirectory() as tmp:
            w = World(tmp, fo, monkeypatch)
            if garble:
                for sym, cl in w.min.items():
                    m0 = (fo - w.t0) // 60
                    w.min[sym] = cl[:m0] + [None if v is None else 3 * v for v in cl[m0:]]
            monkeypatch.setattr(L, "ensure_ci_replay", lambda a, U, log=print: {"pass": True})
            w.now = fo + 5 * H
            L.issue(_args(w), w.U, log=lambda *x: None, clock=lambda: w.now, http_get=w.http_get)
            doc, _ = L.read_issue(L.C.live_dir(w.out), L.list_issues(L.C.live_dir(w.out))[0])
            rows.append([{k: r[k] for k in ("S", "fH", "f", "a", "anchor")} for r in doc["series"]])
    assert rows[0] == rows[1]


def test_units_classes_and_downgrade_semantics():
    units = L.monitor_units()
    assert len(units) == 80 and len({u[0] for u in units}) == 80
    assert L.default_class("ETHBTC", 72, -0.20) == "CALIBRATED" and L.default_class("ETHBTC", 24, -0.15) == L.CLASS_WARN
    assert L.default_class("ETHBTC", 72, -0.15) == L.CLASS_RECAL and L.default_class("ETHBTC", 6, -0.10) == L.CLASS_HC
    assert L.default_class("LARGE", 6, -0.15) == L.CLASS_DNS and L.default_class("LARGE", 24, -0.20) == L.CLASS_WARN
    assert sum(v == L.CLASS_WARN for v in L.DEFAULT_CLASS.values()) == 54
    st = L.initial_state()
    st[L.pkey(24, "LARGE")]["downgraded"] = True
    eff = L.effective_classes(st)
    assert eff["LARGE 1d -10%"] == L.CLASS_DOWN and eff["LARGE 1d -15%"] == L.CLASS_WARN
    st[L.gkey(72, -0.20, "ETHBTC")]["downgraded"] = True
    assert L.effective_classes(st)["ETHBTC 3d -20%"] == "CALIBRATED"


def test_universe_and_golden_files_are_consistent():
    p = L.universe_path()
    if not os.path.exists(p):
        pytest.skip("universe not built")
    U = L.load_universe()
    assert L.C.sha256_file(L.golden_path()) == U["goldenSha256"]
    assert len(U["series"]) == 20 and set(U["v0"]) == {u[0] for u in L.monitor_units()}
    assert set(U["climatology"]) == {L.gkey(T, k, g) for (T, k) in L.CELLS for g in L.GROUPS}
    assert all(len(e["tailCloses"]) == (L.GRID_END - L.TAIL_START) // 60 for e in U["series"])
    assert all(e["gridPath"].startswith(L.GRID_DIR) for e in U["series"])
