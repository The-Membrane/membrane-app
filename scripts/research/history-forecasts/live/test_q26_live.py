#!/usr/bin/env python3
"""Synthetic tests for the Q26 live forecast log (no network, no dataset read).

  python3 -m unittest scripts/research/history-forecasts/live/test_q26_live.py -v

Optional real-data check (reads membrane-datasets, ~1 min): Q26_DATASETS=<membrane-datasets> runs
test_refit_at_data_end_matches_a3_dev (the live refit at asof = DATA_END equals results-dev.json p_data_end).
"""
import gzip
import json
import os
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

    def issue(self):
        return I.issue(self.root, "unused", self.rpc(), http_get=self.binance.get, clock=self.clock,
                       forecaster=fake_forecaster(self.seen), code={"commit": "test"}, log=QUIET)

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


if __name__ == "__main__":
    unittest.main()
