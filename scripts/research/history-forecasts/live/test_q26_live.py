#!/usr/bin/env python3
"""Synthetic tests for the Q26 live forecast log (no network, no dataset read).

  python3 -m unittest scripts/research/history-forecasts/live/test_q26_live.py -v

Optional real-data check (reads membrane-datasets, ~1 min): Q26_DATASETS=<membrane-datasets> runs
test_refit_at_data_end_matches_a3_dev (the live refit at asof = DATA_END equals results-dev.json p_data_end).
With also Q26_A5_OUT=<A5 dev output dir>: the A5 part at asof = DATA_END equals the A5 results-dev.json fbL.
Optional scratch-copy check: Q26_LIVE_DIR=<membrane-datasets>/forecasts/q26-touch-live copies that directory to a
temporary root (the real directory is only read, and checked unchanged) and issues one model-A5 day after its last
issue file, then scores the mixed A3/A5 rows.
"""
import gzip
import hashlib
import json
import os
import shutil
import sys
import tempfile
import unittest
import urllib.error
import warnings
from unittest import mock

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import q26_live_common as C  # noqa: E402
import q26_live_issue as I  # noqa: E402
import q26_live_score as SC  # noqa: E402

warnings.filterwarnings("ignore")
R = C.Round
U = C.A.utc
QUIET = lambda *a, **k: None  # noqa: E731


# ---------------------------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------------------------
def enc_round(rid, answer, ts):
    w = [rid, answer & ((1 << 256) - 1), ts, ts, rid]
    return "0x" + "".join(format(x, "064x") for x in w)


class FakeChain:
    """Chainlink proxies with phases. phases[proxy] = {phase: [(answer, updatedAt), ...]} (agg ids 1..n)."""

    def __init__(self):
        self.block_ts = 0
        self.feeds = {}
        self.aggs = {}
        self.requests = []

    def add(self, proxy, phases):
        self.feeds[proxy.lower()] = phases
        for ph in phases:
            addr = "0x" + format(0xA000 + len(self.aggs) + 1, "040x")
            self.aggs[addr] = (proxy.lower(), ph)

    def visible(self, proxy, phase):
        return [(i + 1, a, t) for i, (a, t) in enumerate(self.feeds[proxy].get(phase, [])) if t <= self.block_ts]

    def latest(self, proxy):
        for ph in sorted(self.feeds[proxy], reverse=True):
            v = self.visible(proxy, ph)
            if v:
                return ph, v[-1]
        raise AssertionError("no visible round")

    def handle(self, q):
        out = {"jsonrpc": "2.0", "id": q["id"]}
        if q["method"] == "eth_getBlockByNumber":
            out["result"] = {"number": hex(1000), "timestamp": hex(self.block_ts)}
            return out
        to, data = q["params"][0]["to"].lower(), q["params"][0]["data"][2:]
        sel, arg = data[:8], (int(data[8:], 16) if len(data) > 8 else None)
        if to in self.aggs:
            proxy, ph = self.aggs[to]
            agg, a, t = self.visible(proxy, ph)[-1]
            out["result"] = enc_round(agg, a, t)
        elif sel == C.SEL_LATEST:
            ph, (agg, a, t) = self.latest(to)
            out["result"] = enc_round((ph << 64) | agg, a, t)
        elif sel == C.SEL_GET:
            ph, agg = arg >> 64, arg & C.AGG_MASK
            v = {i: (a, t) for i, a, t in self.visible(to, ph)}
            out["result"] = enc_round(arg, *v[agg]) if agg in v else "0x" + "0" * 320
        elif sel == C.SEL_PHASE_AGG:
            addr = next((ad for ad, (p, ph) in self.aggs.items() if p == to and ph == arg), "0x" + "0" * 40)
            out["result"] = "0x" + "0" * 24 + addr[2:]
        else:
            raise AssertionError(sel)
        return out

    def post(self, url, body, timeout):
        req = json.loads(body)
        reqs = [req] if isinstance(req, dict) else req
        self.requests.append((url, len(reqs)))
        if "drpc" in url and len(reqs) > 3:
            raise urllib.error.HTTPError(url, 500, "batch too large", {}, None)
        res = [self.handle(q) for q in reqs]
        return json.dumps(res[0] if isinstance(req, dict) else res).encode()


class FakeBinance:
    def __init__(self, clock, missing=()):
        self.clock, self.missing = clock, set(missing)

    def get(self, url):
        q = dict(p.split("=") for p in url.split("?", 1)[1].split("&"))
        start = int(q["startTime"])
        now_ms = int(self.clock() * 1000)
        out, o = [], start
        while o <= now_ms and len(out) < int(q["limit"]):
            if o // 1000 not in self.missing:
                px = 100.0 + (o // 3_600_000) % 7
                out.append([o, str(px), str(px + 1), str(px - 1), str(px + 0.5), "1.0", o + 3_599_999, "0", 1,
                            "0", "0", "0"])
            o += 3_600_000
        return json.dumps(out).encode()


class Clock:
    def __init__(self, t):
        self.t = t

    def __call__(self):
        return self.t


def series(t0, t1, step, base, amp=0.0):
    out, t, i = [], t0, 0
    while t <= t1:
        out.append((int(base * (1 + amp * ((i % 5) - 2))), t))
        t += step
        i += 1
    return out


def make_chain(t_end):
    ch = FakeChain()
    t0 = C.BOOTSTRAP_TS - 5 * C.HOUR
    split = C.BOOTSTRAP_TS + 30 * C.HOUR          # ETH/USD changes phase after 30 h
    eth = series(t0, t_end, 1000, 2500 * 10 ** 8, 0.001)
    ch.add(C.FEEDS["ETH"][0], {6: [x for x in eth if x[1] < split], 7: [x for x in eth if x[1] >= split]})
    ch.add(C.FEEDS["BTC"][0], {4: series(t0, t_end, 2700, 90000 * 10 ** 8, 0.001)})
    ch.add(C.FEEDS["stETH"][0], {2: series(t0 - 2 * C.DAY, t_end, C.DAY, 10 ** 18, 0.0)})
    return ch


def fake_frozen():
    lab = {"pooled": "LOW", "low": {"after": "MEDIUM", "dev": "MEDIUM", "outcome": "not HIGH", "n_ep": 12},
           "mid": {"after": "LOW", "dev": "LOW", "outcome": "not HIGH", "n_ep": 9}, "high": None}
    return {"shipped": {a: {C.T_LABEL[T]: ("f" if a != "stETH" else "a") for T in C.HORIZONS_H} for a in C.ASSETS},
            "labels": {a: {C.T_LABEL[T]: {r: {repr(float(k)): lab for k in C.LEVELS[a]} for r in C.RUNGS}
                           for T in C.HORIZONS_H} for a in C.ASSETS}}


def fake_forecaster(seen):
    def f(datasets, rounds, asof, log=print):
        out = {}
        for a in C.ASSETS:
            assert all(r.updated_at <= asof for r in rounds[a]), "the model saw a price after asof"
            seen.append(max(r.updated_at for r in rounds[a]))
            K = len(C.LEVELS[a])
            g = np.tile(np.linspace(0.5, 0.05, K), (6, 1)) * np.linspace(0.4, 1.0, 6)[:, None]
            s = C.price(C.answer_in_force(C.sort_rounds(rounds[a]), asof), a)
            out[a] = {"raw": {r: g.copy() for r in C.RUNGS}, "fixed": {r: C.A.monotone_fix(g[None])[0] for r in C.RUNGS},
                      "betas": {C.T_LABEL[T]: {"beta": 0.5, "n_eval": 1, "rule": "x"} for T in C.HORIZONS_H},
                      "n_train": {}, "regime": "low", "rv_pct": 0.1, "sigma_hat": 0.5, "sigma_ref": 0.6,
                      "spot_series": s}
        return out
    return f


# ---------------------------------------------------------------------------------------------
# Model A5 fakes
# ---------------------------------------------------------------------------------------------
A5_SHIP = {"ETH": {"6h": "fbL", "1d": "f", "3d": "f", "7d": "fbL", "14d": "f", "30d": "a"},
           "BTC": {"6h": "f", "1d": "fbL", "3d": "f", "7d": "f", "14d": "f", "30d": "f"},
           "stETH": {"6h": "a", "1d": "f", "3d": "fbL", "7d": "f", "14d": "a", "30d": "a"}}


def fake_frozen_a5():
    def g(lab):
        return {"after": lab, "dev": lab, "outcome": "not HIGH", "n_ep": 14, "basis": "held in 2 of 3 checks",
                "per_source_rule": "held"}
    lab = {"pooled": "MEDIUM", "low": g("HIGH"), "mid": g("MEDIUM"), "high": g("LOW")}
    return {"shipped": A5_SHIP,
            "labels": {a: {C.T_LABEL[T]: {r: {repr(float(k)): lab for k in C.LEVELS[a]} for r in ("a", "f", "fbL")}
                           for T in C.HORIZONS_H} for a in C.ASSETS}}


def write_frozen_a5(d, doc=None):
    path = os.path.join(d, "frozen-a5.json")
    raw = json.dumps(doc or fake_frozen_a5()).encode()
    with open(path, "wb") as f:
        f.write(raw)
    return path, hashlib.sha256(raw).hexdigest()


def fake_a5_forecaster(seen):
    base = fake_forecaster(seen)

    def f(datasets, rounds, asof, log=print):
        out = base(datasets, rounds, asof, log=log)
        for a in C.ASSETS:
            fa = out[a]
            gl = np.clip(fa["raw"]["f"] * 1.1, 0, 1)
            fa["raw"]["fbL"], fa["fixed"]["fbL"] = gl, C.A.monotone_fix(gl[None])[0]
            fa["betas_fbL"] = {C.T_LABEL[T]: {"0": {"beta": 1.0, "n_eval": 9}} for T in C.HORIZONS_H}
            p = np.array([fa["fixed"][A5_SHIP[a][C.T_LABEL[T]]][ti] for ti, T in enumerate(C.HORIZONS_H)])
            fa["range_lo"], fa["range_hi"] = np.clip(p - 0.05, 0, 1), np.clip(p + 0.05, 0, 1)
            fa["range_days"] = {C.T_LABEL[T]: 100 for T in C.HORIZONS_H}
        return out
    return f


class LiveEnv:
    """A temporary output root with fake chain, Binance, clock and frozen inputs."""

    def __init__(self, t_start):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        self.clock = Clock(t_start)
        self.chain = make_chain(t_start + 40 * C.DAY)
        self.binance = FakeBinance(self.clock)
        self.seen = []
        self.patches = [mock.patch.object(C, "verify_frozen_inputs", lambda d: {"x": {"sha256": "0" * 64}}),
                        mock.patch.object(C, "load_frozen_a3", lambda d: fake_frozen())]
        for p in self.patches:
            p.start()

    def rpc(self):
        self.chain.block_ts = int(self.clock())
        return C.RpcClient(post=self.chain.post, sleep=lambda s: None)

    def issue(self, **kw):
        kw.setdefault("forecaster", fake_forecaster(self.seen))
        return I.issue(self.root, "unused", self.rpc(), http_get=self.binance.get, clock=self.clock,
                       code={"commit": "test"}, log=QUIET, **kw)

    def score(self):
        return SC.score(self.root, self.rpc(), http_get=self.binance.get, clock=self.clock, code={}, log=QUIET)

    def close(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()


# ---------------------------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------------------------
class TestStores(unittest.TestCase):
    def test_round_store_append_prefix_and_read(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "rounds", "eth-usd.csv.gz")
            a = [R((1 << 64) | 1, 100, 10), R((1 << 64) | 2, 101, 20)]
            C.append_rounds(p, a, [])
            with open(p, "rb") as f:
                first = f.read()
            b = [R((1 << 64) | 3, 99, 20), R((2 << 64) | 1, 98, 30)]
            C.append_rounds(p, b, C.read_round_store(p))
            with open(p, "rb") as f:
                data = f.read()
            self.assertTrue(data.startswith(first))                       # append-only bytes
            self.assertEqual(C.read_round_store(p), a + b)
            self.assertEqual(gzip.decompress(data).decode().count("roundId"), 1)
            with self.assertRaises(SystemExit):
                C.append_rounds(p, [R((1 << 64) | 9, 1, 40)], C.read_round_store(p))   # id not increasing
            with self.assertRaises(SystemExit):
                C.append_rounds(p, [R((2 << 64) | 2, 1, 29)], C.read_round_store(p))   # time backwards

    def test_hourly_close_low(self):
        h0 = U("2026-10-06T03:00:00Z")
        rs = [R(1, 100 * 10 ** 8, h0 - 600), R(2, 95 * 10 ** 8, h0 + 600), R(3, 97 * 10 ** 8, h0 + 3600),
              R(4, 99 * 10 ** 8, h0 + 3600 + 1), R(5, 90 * 10 ** 8, h0 + 3 * 3600)]
        close, low = C.hourly_close_low(rs, "ETH", h0, h0 + 3 * 3600)
        # hour 0: in force 100, rounds 95 and 97 (97 printed exactly at the hour end -> this hour)
        self.assertEqual(close.tolist(), [97.0, 99.0, 90.0])
        self.assertEqual(low.tolist(), [95.0, 97.0, 90.0])
        c2, l2 = C.hourly_close_low(rs, "ETH", h0 - 7200, h0 - 3600)    # no round in force yet -> NaN
        self.assertTrue(np.isnan(c2[0]) and np.isnan(l2[0]))

    def test_asof_floor_and_spot_in_force(self):
        t = U("2026-10-14T00:17:42Z")
        self.assertEqual(C.floor_hour(t), U("2026-10-14T00:00:00Z"))
        self.assertEqual(C.utc_date(t), "2026-10-14")
        asof = C.floor_hour(t)
        rs = [R(1, 1, asof - 50), R(2, 2, asof), R(3, 3, asof + 1)]
        self.assertEqual(C.answer_in_force(rs, asof).answer, 2)            # printed AT asof is in force
        self.assertEqual(C.answer_in_force(rs, asof - 51), None)

    def test_feed_bootstrap_and_append_across_phase(self):
        env = LiveEnv(C.BOOTSTRAP_TS + 20 * C.HOUR)
        try:
            ldir = C.live_dir(env.root)
            rpc = env.rpc()
            e = C.update_round_store(rpc, ldir, "ETH", rpc.head(), clock=env.clock)
            rs = C.read_round_store(C.round_store_path(ldir, "ETH"))
            self.assertEqual(e["mode"], "bootstrap")
            self.assertLessEqual(rs[0].updated_at, C.BOOTSTRAP_TS)
            self.assertGreater(rs[1].updated_at, C.BOOTSTRAP_TS)
            self.assertEqual(rs[-1].updated_at, max(t for _, t in env.chain.feeds[C.FEEDS["ETH"][0].lower()][6]
                                                    if t <= env.clock()))
            env.clock.t += 30 * C.HOUR                                        # crosses the phase 6 -> 7 change
            rpc = env.rpc()
            e2 = C.update_round_store(rpc, ldir, "ETH", rpc.head(), clock=env.clock)
            rs2 = C.read_round_store(C.round_store_path(ldir, "ETH"))
            self.assertEqual(rs2[:len(rs)], rs)
            self.assertEqual({r.phase for r in rs2}, {6, 7})
            want = [(6, i) for i in range(rs[0].agg, len(env.chain.feeds[C.FEEDS["ETH"][0].lower()][6]) + 1)]
            self.assertEqual([(r.phase, r.agg) for r in rs2 if r.phase == 6], want)    # contiguous, nothing lost
            self.assertEqual(e2["appended"], len(rs2) - len(rs))
            self.assertEqual(C.round_coverage(ldir, "ETH", rs2), int(env.clock()))
            self.assertTrue(any(n <= 3 for u, n in env.chain.requests if "drpc" in u))
            self.assertFalse(any(n > 3 for u, n in env.chain.requests if "drpc" in u))
        finally:
            env.close()

    def test_rpc_fallback_to_second_provider(self):
        ch = make_chain(C.BOOTSTRAP_TS + C.DAY)
        ch.block_ts = C.BOOTSTRAP_TS + C.HOUR

        def post(url, body, timeout):
            if "drpc" in url:
                raise urllib.error.URLError("down")
            return ch.post(url, body, timeout)
        rpc = C.RpcClient(post=post, sleep=lambda s: None)
        self.assertEqual(rpc.head(), (1000, ch.block_ts))
        self.assertEqual(rpc.switches, 1)
        self.assertIn("https://rpc.mevblocker.io", rpc.stats()["used"])
        with self.assertRaises(ValueError):
            C.RpcClient(urls=("https://example.org/v2/0123456789abcdef0123456789",))

    def test_binance_store_closed_klines_only(self):
        with tempfile.TemporaryDirectory() as d:
            clock = Clock(C.BOOTSTRAP_TS + 5 * C.HOUR + 120)
            fb = FakeBinance(clock)
            e = C.update_binance_store(d, "ETHUSDT", http_get=fb.get, clock=clock)
            rows = C.read_binance_store(C.binance_store_path(d, "ETHUSDT"))
            self.assertEqual(int(rows[0][0]) // 1000, C.BOOTSTRAP_TS)
            self.assertEqual(int(rows[-1][0]) // 1000, C.BOOTSTRAP_TS + 4 * C.HOUR)   # the open 5th hour is skipped
            self.assertEqual(e["appended"], 5)
            clock.t += 3 * C.HOUR
            C.update_binance_store(d, "ETHUSDT", http_get=fb.get, clock=clock)
            rows2 = C.read_binance_store(C.binance_store_path(d, "ETHUSDT"))
            self.assertEqual(rows2[:5], rows)
            self.assertEqual(len(rows2), 8)


class TestIssue(unittest.TestCase):
    def setUp(self):
        self.env = LiveEnv(U("2026-10-14T00:17:30Z"))

    def tearDown(self):
        self.env.close()

    def test_issue_rows_chain_and_no_price_after_asof(self):
        path, doc, sha = self.env.issue()
        asof = U("2026-10-14T00:00:00Z")
        self.assertEqual(doc["asof"], asof)
        self.assertEqual(doc["issuedAt"], U("2026-10-14T00:17:30Z"))
        self.assertEqual(doc["prevSha256"], C.ZERO_SHA)
        self.assertEqual(doc["nRows"], 2 * 6 * 10 + 6 * 4)
        self.assertTrue(all(t <= asof for t in self.env.seen))
        with open(path, "rb") as f:
            raw = f.read()
        self.assertEqual(json.loads(raw), json.loads(json.dumps(C.clean(doc))))
        ldir = C.live_dir(self.env.root)
        rs = C.read_round_store(C.round_store_path(ldir, "ETH"))
        self.assertTrue(any(r.updated_at > asof for r in rs))             # the store holds rounds after asof ...
        s = C.price(C.answer_in_force(rs, asof), "ETH")
        row = next(r for r in doc["rows"] if r["asset"] == "ETH" and r["T"] == "7d" and r["k"] == -0.05)
        self.assertEqual(row["S"], s)                                      # ... but spot is the answer at asof
        self.assertAlmostEqual(row["L"], s * 0.95)
        self.assertEqual(row["resolvesAt"], asof + 168 * 3600)
        self.assertEqual(row["shipped"], "f")
        self.assertEqual(row["p_shipped"], row["p"]["f"])
        self.assertEqual(row["frozen_label"]["label"], "MEDIUM")
        self.assertEqual(row["issuedAt"], doc["issuedAt"])
        # second day links to the first by sha256
        self.env.clock.t += C.DAY
        path2, doc2, _ = self.env.issue()
        self.assertEqual(doc2["prevSha256"], sha)
        self.assertEqual(doc2["prevFile"], "2026-10-14.json")
        self.assertEqual(C.verify_chain(C.issues_dir(ldir)), [])
        with open(path, "ab") as f:                                        # tamper with day 1
            f.write(b" ")
        self.assertTrue(C.verify_chain(C.issues_dir(ldir)))

    def test_refusal_guards(self):
        self.env.issue()
        idir = C.issues_dir(C.live_dir(self.env.root))
        with self.assertRaises(SystemExit):                                # same-day file exists
            self.env.clock.t += 3600
            self.env.issue()
        self.env.clock.t += C.DAY
        with open(os.path.join(idir, "2026-10-20.json"), "w") as f:         # a later file exists
            f.write("{}")
        with self.assertRaises(SystemExit):
            self.env.issue()
        os.remove(os.path.join(idir, "2026-10-20.json"))
        self.env.clock.t -= 3 * C.DAY                                      # clock went backwards
        with self.assertRaises(SystemExit):
            self.env.issue()
        self.env.clock.t += 3 * C.DAY
        p1 = os.path.join(idir, "2026-10-14.json")
        with open(p1) as f:
            d = json.load(f)
        with open(p1, "w") as f:                                           # broken chain
            f.write(json.dumps(d))
        with self.assertRaises(SystemExit):
            self.env.issue()

    def test_store_clock_guard(self):
        self.env.issue()
        ldir = C.live_dir(self.env.root)
        rs = C.read_round_store(C.round_store_path(ldir, "BTC"))
        with self.assertRaises(SystemExit):
            C.check_store_clock(ldir, rs[-1].updated_at - 1)


class TestScoring(unittest.TestCase):
    def row(self, asof, T_h=6, k=-0.05, S=100.0, issued=None):
        return {"date": C.utc_date(asof), "asset": "ETH", "T": C.T_LABEL[T_h], "T_h": T_h, "k": k, "asof": asof,
                "issuedAt": issued or asof + 1000, "resolvesAt": asof + T_h * 3600, "S": S, "L": S * (1 + k),
                "regime": "low", "shipped": "f", "p": {"a": 0.2, "f": 0.3, "fb": 0.25}, "frozen_label": {}}

    def rounds(self, asof, extra):
        base = [R((1 << 64) | 1, 100 * 10 ** 8, asof - 100)]
        return base + [R((1 << 64) | (i + 2), int(p * 10 ** 8), t) for i, (p, t) in enumerate(extra)]

    def test_resolution_timing(self):
        asof = U("2026-10-14T00:00:00Z")
        row = self.row(asof)
        rs = self.rounds(asof, [(99, asof + 3600)])
        end = asof + 6 * 3600
        self.assertIsNone(C.resolve_row(row, rs, {}, end + 1000, end + 899)[0])          # < 15 min after
        self.assertIsNone(C.resolve_row(row, rs, {}, end - 1, end + 900)[0])             # store not covering
        out, _ = C.resolve_row(row, rs, {}, end, end + 900)
        self.assertEqual(out["status"], "resolved")
        self.assertEqual(out["y"], 0)

    def test_truth_in_force_and_window_bounds(self):
        asof = U("2026-10-14T00:00:00Z")
        end = asof + 6 * 3600
        row = self.row(asof)
        hit_end = self.rounds(asof, [(99, asof + 7200), (95, end)])            # exactly at asof + T: counts
        out, _ = C.resolve_row(row, hit_end, {}, end + 5000, end + 5000)
        self.assertEqual((out["status"], out["y"]), ("resolved", 1))
        self.assertEqual(out["brier"]["f"], (0.3 - 1) ** 2)
        after = self.rounds(asof, [(99, asof + 7200), (95, end + 1)])          # after the window: does not
        out, _ = C.resolve_row(row, after, {}, end + 5000, end + 5000)
        self.assertEqual((out["status"], out["y"]), ("resolved", 0))
        self.assertEqual(out["truth"]["inForceAtAsof"]["price"], 100.0)
        self.assertTrue(out["truth"]["spotMatchesIssue"])
        # the in-force answer is part of the minimum
        row2 = self.row(asof, k=0.0)
        out, _ = C.resolve_row(row2, self.rounds(asof, [(101, asof + 60)]), {}, end, end + 900)
        self.assertEqual(out["y"], 1)

    def test_excluded_touched_before_issue(self):
        asof = U("2026-10-14T00:00:00Z")
        end = asof + 6 * 3600
        row = self.row(asof, issued=asof + 1000)
        rs = self.rounds(asof, [(94, asof + 1000)])                             # touched at issuedAt itself
        out, _ = C.resolve_row(row, rs, {}, end, end + 900)
        self.assertEqual(out["status"], "excluded_touched_before_issue")
        self.assertNotIn("brier", out)
        rs = self.rounds(asof, [(99, asof + 1000), (94, asof + 1001)])          # touched after issue -> scored
        out, _ = C.resolve_row(row, rs, {}, end, end + 900)
        self.assertEqual((out["status"], out["y"]), ("resolved", 1))

    def test_gaps(self):
        asof = U("2026-10-14T00:00:00Z")
        end = asof + 24 * 3600
        row = self.row(asof, T_h=24)
        ok = [R((1 << 64) | 1, 100 * 10 ** 8, asof - 100), R((1 << 64) | 2, 99 * 10 ** 8, asof + 3600),
              R((1 << 64) | 4, 99 * 10 ** 8, asof + 3600 + 7200)]                 # id 3 missing: span 2 h
        self.assertEqual(C.resolve_row(row, ok, {}, end, end + 900)[0]["status"], "resolved")
        bad = ok[:2] + [R((1 << 64) | 4, 99 * 10 ** 8, asof + 3600 + 7201)]       # span 2 h + 1 s
        out, _ = C.resolve_row(row, bad, {}, end, end + 900)
        self.assertEqual((out["status"], out["reason"]), ("unresolved", "round store gap > 2 h"))
        sparse = [R((1 << 64) | 1, 100 * 10 ** 8, asof - 100), R((1 << 64) | 2, 100 * 10 ** 8, asof + 20 * 3600)]
        out, _ = C.resolve_row(row, sparse, {}, end, end + 900)                   # 24 h heartbeat, contiguous ids
        self.assertEqual(out["status"], "resolved")
        self.assertEqual(out["truth"]["maxRoundSpacingSeconds"], 20 * 3600 + 0)
        phase = ok[:2] + [R((2 << 64) | 1, 99 * 10 ** 8, asof + 5 * 3600)]        # new phase from agg 1: no gap
        self.assertEqual(C.resolve_row(row, phase, {}, end, end + 900)[0]["status"], "resolved")
        # secondary truth (Binance): a run of 3 missing hours > 2 h
        kl = {asof + j * 3600: (100.0 - (j == 5) * 6, 100.0) for j in range(-1, 24) if j not in (10, 11, 12)}
        out, _ = C.resolve_row(row, ok, kl, end, end + 900)
        self.assertEqual(out["secondary"]["status"], "unresolved")
        self.assertEqual(out["secondary"]["maxGapSeconds"], 3 * 3600)
        kl2 = {asof + j * 3600: (100.0 - (j == 5) * 6, 100.0) for j in range(-1, 24) if j not in (10, 11)}
        out, _ = C.resolve_row(row, ok, kl2, end, end + 900)
        self.assertEqual((out["secondary"]["status"], out["secondary"]["y"]), ("resolved", 1))
        self.assertEqual(out["secondary"]["y_own_spot"], 1)

    def test_summary_math(self):
        d = ["2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17"]
        pf = [0.8, 0.6, 0.2, 0.9]
        y = [1, 1, 0, 1]
        rows = [{"date": d[i], "y": y[i], "p": {"a": 0.5, "f": pf[i], "fb": 0.5}} for i in range(4)]
        st = C.cell_stats(rows, "f")
        self.assertEqual(st["n"], 4)
        self.assertEqual(st["n_ep"], 2)
        self.assertAlmostEqual(st["brier"], 0.0625)
        self.assertAlmostEqual(st["bss_vs_a"], 0.75)
        self.assertAlmostEqual(st["R"], 2.5 / 3)
        self.assertEqual(C.cell_stats(rows, "a")["bss_vs_a"], 0.0)
        self.assertEqual(C.count_episodes(["2026-10-14", "2026-10-16"], [1, 1]), 2)   # a missing day breaks a run
        self.assertEqual(C.count_episodes(["2026-10-15", "2026-10-14"], [1, 1]), 1)
        zero = [{"date": x, "y": 0, "p": {"a": 0.1, "f": 0.2, "fb": 0.0}} for x in d]
        self.assertEqual(C.cell_stats(zero, "f")["R"], "inf")
        self.assertIsNone(C.cell_stats(zero, "fb")["R"])
        self.assertTrue(C.r_inside(1.0, 0.67, 1.5) and not C.r_inside("inf", 0.67, 1.5))

    def test_dumps_with_rows_is_json(self):
        doc = {"a": 1, "b": {"c": [1, 2]}, "rows": [{"x": 1.5, "y": None}, {"x": float("nan")}]}
        back = json.loads(C.dumps_with_rows(doc))
        self.assertEqual(back["rows"], [{"x": 1.5, "y": None}, {"x": None}])
        self.assertEqual(back["b"], {"c": [1, 2]})


def outcome_lines(sdir):
    n = 0
    for name in os.listdir(sdir):
        if name.startswith("outcomes"):
            with open(os.path.join(sdir, name)) as f:
                n += sum(1 for _ in f)
    return n


class TestEndToEnd(unittest.TestCase):
    def test_issue_then_score_append_only(self):
        env = LiveEnv(U("2026-10-14T00:17:30Z"))
        try:
            env.issue()
            doc, new = env.score()
            self.assertEqual(new, [])                                          # nothing due yet
            self.assertEqual(doc["nPending"], 144)
            env.clock.t = U("2026-10-15T00:47:10Z")
            env.issue()
            doc, new = env.score()
            st = {o["T"] for o in new}
            self.assertEqual(st, {"6h", "1d"})                                 # 6h and 1d of day 1 are due
            self.assertEqual(len(new), 2 * (2 * 10 + 4))
            self.assertTrue(all(o["status"] in ("resolved", "excluded_touched_before_issue") for o in new))
            sdir = os.path.join(C.live_dir(env.root), "scores")
            n_lines = outcome_lines(sdir)
            doc2, new2 = env.score()                                           # rerun: nothing appended twice
            self.assertEqual(new2, [])
            self.assertEqual(n_lines, outcome_lines(sdir))
            self.assertEqual(doc2["counts"]["ETH"]["1d"]["resolved"] + doc2["counts"]["ETH"]["1d"][
                "excluded_touched_before_issue"], 10)
            self.assertEqual(doc2["resolvedIssueDaysPerHorizon"]["1d"], 1)
            lc = doc2["liveCheck"]["ETH"]["1d"]
            self.assertTrue(all(v["low"]["applied"] is False for v in lc.values()))
            self.assertEqual(SC.load_outcomes(sdir)[0]["fileSha256"],
                             doc2["issueFiles"][0]["sha256"])
        finally:
            env.close()


class TestModelA5(unittest.TestCase):
    """The issuer with --frozen-a5: schema 2 + model field, chain continuity from an A3 file, mixed scoring."""

    def setUp(self):
        self.env = LiveEnv(U("2026-10-14T00:17:30Z"))
        self.fz = write_frozen_a5(self.env.root)

    def tearDown(self):
        self.env.close()

    def issue_a5(self, **kw):
        return self.env.issue(forecaster=fake_a5_forecaster(self.env.seen), frozen_a5=self.fz, **kw)

    def test_a5_issue_after_a3_issue(self):
        _, doc1, sha1 = self.env.issue()                                   # model A3 (schema 1, no model field)
        self.assertEqual(doc1["schema"], I.SCHEMA)
        self.assertNotIn("model", doc1)
        self.assertTrue(all("model" not in r and "fbL" not in r["p"] for r in doc1["rows"]))
        self.env.clock.t += C.DAY
        path2, doc2, sha2 = self.issue_a5()
        self.assertEqual(doc2["schema"], "q26-touch-live/issue/2")
        self.assertEqual(list(doc2)[:2], ["schema", "model"])
        self.assertEqual(doc2["model"], "A5")
        self.assertEqual((doc2["prevFile"], doc2["prevSha256"]), ("2026-10-14.json", sha1))
        self.assertEqual(C.verify_chain(C.issues_dir(C.live_dir(self.env.root))), [])
        self.assertEqual(doc2["rungs"], ["a", "f", "fb", "fbL"])
        self.assertEqual(doc2["shipped"], A5_SHIP)
        self.assertEqual(doc2["shippedA3"], fake_frozen()["shipped"])
        self.assertEqual(doc2["inputs"]["frozenA5"], {"path": self.fz[0], "sha256": self.fz[1]})
        self.assertEqual(doc2["nRows"], 144)
        self.assertEqual(list(doc2)[-2:], ["nRows", "rows"])
        with open(path2, "rb") as f:
            self.assertEqual(json.loads(f.read()), json.loads(json.dumps(C.clean(doc2))))
        for r in doc2["rows"]:
            ship = A5_SHIP[r["asset"]][r["T"]]
            self.assertEqual(r["model"], "A5")
            self.assertEqual(r["shipped"], ship)
            self.assertEqual(r["p_shipped"], r["p"][ship])
            self.assertEqual(set(r["p"]), {"a", "f", "fb", "fbL"})
            er = r["estimateRange"]
            self.assertEqual((er["wording"], er["rung"]), ("estimate range", ship))
            self.assertTrue(er["lo"] <= r["p_shipped"] <= er["hi"])
            self.assertEqual(r["a3"]["shipped"], fake_frozen()["shipped"][r["asset"]][r["T"]])
            self.assertEqual(r["a3"]["p_shipped"], r["p"][r["a3"]["shipped"]])
            self.assertEqual(r["a3"]["frozen_label"]["label"], "MEDIUM")         # the A3 label (regime low)
            self.assertEqual(r["frozen_label"]["label"], "HIGH")                 # the A5 label (regime low)
            self.assertEqual(r["frozen_label"]["basis"], "held in 2 of 3 checks")
            self.assertTrue(r["frozen_label"]["basisSource"].startswith("frozen-a5"))
        r1 = next(r for r in doc1["rows"] if r["asset"] == "BTC" and r["T"] == "3d" and r["k"] == -0.1)
        r2 = next(r for r in doc2["rows"] if r["asset"] == "BTC" and r["T"] == "3d" and r["k"] == -0.1)
        self.assertEqual({k: r1["p"][k] for k in C.RUNGS}, {k: r2["p"][k] for k in C.RUNGS})   # A3 rungs unchanged

    def test_a5_refuses_wrong_sha_and_basis_mismatch(self):
        with self.assertRaises(SystemExit):
            self.env.issue(forecaster=fake_a5_forecaster(self.env.seen), frozen_a5=(self.fz[0], "0" * 64))
        idir = C.issues_dir(C.live_dir(self.env.root))
        self.assertEqual(C.list_issue_files(idir), [])                      # nothing written
        with self.assertRaises(SystemExit):
            self.env.issue(basis_final=("x", "0" * 64))                     # basis without the A5 freeze
        hdr = "asset,T,k,rung,regime,shipped,label,basis,blind4_R,blind4_n_ep\n"
        bad = hdr + "ETH,6h,-0.02,fbL,low,1,LOW,held in 3 of 4 checks,1.0,20\n"
        bp = os.path.join(self.env.root, "basis-final.csv")
        with open(bp, "w") as f:
            f.write(bad)
        with open(bp, "rb") as f:
            bsha = hashlib.sha256(f.read()).hexdigest()
        with self.assertRaises(SystemExit):                                 # label differs from the freeze
            self.issue_a5(basis_final=(bp, bsha))
        self.assertEqual(C.list_issue_files(idir), [])

    def test_a5_basis_final(self):
        lines = ["asset,T,k,rung,regime,shipped,label,basis,blind4_R,blind4_n_ep"]
        for a in C.ASSETS:
            for T in C.HORIZONS_H:
                for k in C.LEVELS[a]:
                    for g, lab in (("low", "HIGH"), ("mid", "MEDIUM"), ("high", "LOW")):
                        lines.append(f"{a},{C.T_LABEL[T]},{k},{A5_SHIP[a][C.T_LABEL[T]]},{g},1,{lab},"
                                     "held in 3 of 4 checks,1.0,20")
        bp = os.path.join(self.env.root, "basis-final.csv")
        with open(bp, "w") as f:
            f.write("\n".join(lines) + "\n")
        with open(bp, "rb") as f:
            bsha = hashlib.sha256(f.read()).hexdigest()
        _, doc, _ = self.issue_a5(basis_final=(bp, bsha))
        self.assertEqual(doc["inputs"]["basisFinal"], {"path": bp, "sha256": bsha})
        self.assertTrue(all(r["frozen_label"]["basis"] == "held in 3 of 4 checks" for r in doc["rows"]))
        self.assertTrue(all(r["frozen_label"]["basisSource"].startswith("basis-final") for r in doc["rows"]))

    def test_mixed_scoring(self):
        self.env.issue()                                                    # day 1: model A3
        self.env.clock.t = U("2026-10-15T00:17:30Z")
        self.issue_a5()                                                     # day 2: model A5
        self.env.clock.t = U("2026-10-16T00:17:30Z")
        self.issue_a5()                                                     # day 3: model A5
        self.env.clock.t = U("2026-10-16T00:47:10Z")
        summ, new = self.env.score()
        old = [o for o in new if o["date"] == "2026-10-14"]
        a5 = [o for o in new if o["date"] == "2026-10-15"]
        self.assertTrue(old and a5)
        for o in old:
            self.assertNotIn("model", o)
            self.assertNotIn("estimateRange", o)
            if o["status"] == "resolved":
                self.assertEqual(set(o["brier"]), {"a", "f", "fb"})
        for o in a5:
            self.assertEqual(o["model"], "A5")
            self.assertEqual(o["shipped"], A5_SHIP[o["asset"]][o["T"]])
            self.assertIn("lo", o["estimateRange"])
            self.assertIn("shipped", o["a3"])
            if o["status"] == "resolved":
                self.assertEqual(set(o["brier"]), {"a", "f", "fb", "fbL"})
        c = summ["cells"]["ETH"]["6h"]["-0.02"]["pooled"]
        self.assertEqual(c["fbL"]["n"], sum(o["status"] == "resolved" and o["asset"] == "ETH" and o["T"] == "6h"
                                            and o["k"] == -0.02 for o in a5))           # fbL: A5 rows only
        self.assertEqual(c["f"]["n"], c["fbL"]["n"] + sum(o["status"] == "resolved" and o["asset"] == "ETH" and
                                                          o["T"] == "6h" and o["k"] == -0.02 for o in old))
        lc = summ["liveCheck"]["ETH"]["6h"]["-0.02"]["low"]
        self.assertEqual((lc["rung"], lc["model"]), ("fbL", "A5"))          # the current (A5) shipped rung
        self.assertEqual(lc["n"], c["fbL"]["n"])
        lc2 = summ["liveCheck"]["BTC"]["6h"]["-0.02"]["low"]
        self.assertEqual((lc2["rung"], lc2["model"]), ("f", "A5"))
        self.assertEqual(lc2["n"], summ["cells"]["BTC"]["6h"]["-0.02"]["pooled"]["f"]["n"])   # f over both models


def _tree_sha(d):
    out = {}
    for root, _, files in os.walk(d):
        for n in files:
            p = os.path.join(root, n)
            with open(p, "rb") as f:
                out[os.path.relpath(p, d)] = hashlib.sha256(f.read()).hexdigest()
    return out


@unittest.skipUnless(os.environ.get("Q26_LIVE_DIR"), "set Q26_LIVE_DIR=<.../forecasts/q26-touch-live> to run")
class TestModelA5ScratchCopy(unittest.TestCase):
    """One model-A5 issue on a scratch copy of the real live directory, then mixed scoring. The store update is
    replaced by synthetic hourly rounds (same answer as the last stored round) up to the injected clock."""

    def synthetic_update(self, ldir, clock):
        def upd(ldir_, rpc, http_get=None, clock=clock, log=print):
            now = int(clock())
            for a in C.ASSETS:
                path = C.round_store_path(ldir_, a)
                rs = C.read_round_store(path)
                last = rs[-1]
                new = [C.Round(last.round_id + j, last.answer, last.updated_at + j * C.HOUR)
                       for j in range(1, (now - last.updated_at) // C.HOUR + 1)]
                C.append_rounds(path, new, rs)
                C.append_fetch_log(os.path.join(ldir_, C.ROUNDS_SUB, "fetch-log.jsonl"),
                                   {"kind": "chainlink", "asset": a, "mode": "synthetic-test", "coveredThrough": now,
                                    "fetchedAt": now, "appended": len(new)})
            return {"rpc": None}, {}
        return upd

    def test_scratch_issue_and_score(self):
        real = os.environ["Q26_LIVE_DIR"]
        before = _tree_sha(real)
        files = C.list_issue_files(os.path.join(real, C.ISSUES_SUB))
        self.assertTrue(files)
        last_date, last_name = files[-1]
        with open(os.path.join(real, C.ISSUES_SUB, last_name), "rb") as f:
            last_raw = f.read()
        last_doc = json.loads(last_raw)
        with tempfile.TemporaryDirectory() as tmp:
            ldir = os.path.join(tmp, C.LIVE_REL)
            shutil.copytree(real, ldir)
            fz = write_frozen_a5(tmp)
            clock = Clock(C.floor_hour(int(last_doc["issuedAt"])) // C.DAY * C.DAY + C.DAY + 1050)   # next day 00:17:30
            ds = os.environ.get("Q26_DATASETS")
            patches = [mock.patch.object(C, "update_all_stores", self.synthetic_update(ldir, clock))]
            if not ds:
                patches += [mock.patch.object(C, "verify_frozen_inputs", lambda d: {"x": {"sha256": "0" * 64}}),
                            mock.patch.object(C, "load_frozen_a3", lambda d: fake_frozen())]
            for p in patches:
                p.start()
            try:
                seen = []
                path, doc, sha = I.issue(tmp, ds or "unused", None, clock=clock, forecaster=fake_a5_forecaster(seen),
                                         code={"commit": "test"}, log=QUIET, frozen_a5=fz)
                self.assertEqual((doc["schema"], doc["model"]), ("q26-touch-live/issue/2", "A5"))
                self.assertEqual(doc["prevFile"], last_name)
                self.assertEqual(doc["prevSha256"], hashlib.sha256(last_raw).hexdigest())
                self.assertEqual(C.verify_chain(C.issues_dir(ldir)), [])
                self.assertEqual(doc["nRows"], last_doc["nRows"])
                if ds:   # the last real file may be model A3 (shipped) or model A5+ (shippedA3)
                    self.assertEqual(doc["shippedA3"], last_doc.get("shippedA3", last_doc["shipped"]))
                clock.t += C.DAY + 1800                                     # next day 00:47:30: day-2 6h/1d due
                summ, new = SC.score(tmp, None, clock=clock, code={}, log=QUIET)
                kinds = {o.get("model", "A3") for o in new}
                self.assertEqual(kinds, {"A3", "A5"})
                self.assertTrue(all(set(o["brier"]) == {"a", "f", "fb", "fbL"} for o in new
                                    if o.get("model") == "A5" and o["status"] == "resolved"))
                self.assertTrue(all("fbL" not in o.get("brier", {}) for o in new if "model" not in o))
            finally:
                for p in patches:
                    p.stop()
        self.assertEqual(_tree_sha(real), before)                           # the real directory is unchanged


@unittest.skipUnless(os.environ.get("Q26_DATASETS"), "set Q26_DATASETS=<membrane-datasets> for the real-data check")
class TestRealData(unittest.TestCase):
    def test_refit_at_data_end_matches_a3_dev(self):
        ds = os.environ["Q26_DATASETS"]
        C.verify_frozen_inputs(ds)
        with open(os.path.join(ds, "history-forecasts/a3/run-a99eff8/results-dev.json")) as f:
            dev = json.load(f)
        D = C.M2.build_dev_series(ds)
        for a in C.ASSETS:
            g, go = D[f"long:{a}"], D[f"oracle:{a}"]
            sl = C.A3.S3(g.name, a, g.truth, g.close, g.low, g.levels, C.A3.BASE_DEV, C.A3.BASE_DEV + 3600 * g.start_i)
            so = sl if go is g else C.A3.S3(go.name, a, go.truth, go.close, go.low, go.levels, C.A3.BASE_DEV,
                                            C.A3.BASE_DEV + 3600 * go.start_i)
            fc = C.forecast_series(sl, so, C.DATA_END)
            for ti, T in enumerate(C.HORIZONS_H):
                ref = dev["per_asset"][a][C.T_LABEL[T]]
                self.assertEqual(fc["betas"][C.T_LABEL[T]]["beta"], ref["beta_data_end"])
                for r in C.RUNGS:
                    np.testing.assert_array_equal(fc["fixed"][r][ti], np.array(ref["p_data_end"][r]))


    @unittest.skipUnless(os.environ.get("Q26_A5_OUT"), "set Q26_A5_OUT=<A5 dev output dir> for the A5 check")
    def test_a5_at_data_end_matches_a5_dev(self):
        import q26_live_a5 as Q5
        ds, out = os.environ["Q26_DATASETS"], os.environ["Q26_A5_OUT"]
        with open(os.path.join(out, "results-dev.json")) as f:
            dev = json.load(f)
        with open(os.path.join(out, "frozen-a5.json")) as f:
            fz = json.load(f)
        D = C.M2.build_dev_series(ds)
        rng = np.random.default_rng([Q5.RANGE_SEED, C.DATA_END])
        for a in C.ASSETS:
            g, go = D[f"long:{a}"], D[f"oracle:{a}"]
            sl = C.A3.S3(g.name, a, g.truth, g.close, g.low, g.levels, C.A3.BASE_DEV, C.A3.BASE_DEV + 3600 * g.start_i)
            so = sl if go is g else C.A3.S3(go.name, a, go.truth, go.close, go.low, go.levels, C.A3.BASE_DEV,
                                            C.A3.BASE_DEV + 3600 * go.start_i)
            fc = Q5.a5_extend(C.forecast_series(sl, so, C.DATA_END), sl, so, C.DATA_END, fz["shipped"][a], rng)
            for ti, T in enumerate(C.HORIZONS_H):
                ref = dev["per_asset"][a][C.T_LABEL[T]]
                np.testing.assert_array_equal(fc["fixed"]["fbL"][ti], np.array(ref["p_data_end"]["fbL"]))
                self.assertEqual({k: v["beta"] for k, v in fc["betas_fbL"][C.T_LABEL[T]].items()},
                                 {str(k): v for k, v in ref["betas_data_end"].items()})
                for r in ("a", "f"):
                    np.testing.assert_array_equal(fc["fixed"][r][ti], np.array(ref["p_data_end"][r]))
            lo, hi = fc["range_lo"], fc["range_hi"]
            p = np.array([fc["fixed"][fz["shipped"][a][C.T_LABEL[T]]][ti] for ti, T in enumerate(C.HORIZONS_H)])
            self.assertTrue(np.all(lo <= p) and np.all(p <= hi))
            np.testing.assert_allclose(p, np.array(fz["range_data_end"][a]["p"]))


if __name__ == "__main__":
    unittest.main()
