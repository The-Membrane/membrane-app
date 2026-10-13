#!/usr/bin/env python3
"""Offline tests for the T5 live-logging scripts (chainlink.py, m1_issue.py, m1_score.py,
deribit_chain_snapshot.py). Every RPC and HTTP call is mocked; nothing touches the network.

Run:  python3 scripts/research/validation/test_t5.py      (or python3 -m pytest that file)
"""
import bisect
import contextlib
import gzip
import io
import json
import math
import os
import sys
import tempfile
import unittest
import urllib.error
import urllib.parse
from datetime import datetime, timezone

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import chainlink as cl  # noqa: E402
import deribit_chain_snapshot as snap  # noqa: E402
import m1_issue  # noqa: E402
import m1_score  # noqa: E402
import t1_touch as t1  # noqa: E402
from t5_common import DAY, HOUR, ZERO_SHA, sha256_bytes, sha256_file, verify_chain  # noqa: E402

MASK = (1 << 64) - 1


def utc(s):
    return int(datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp())


def quiet(*_a, **_k):
    pass


# ---------------------------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------------------------
def make_rounds(t_start, t_end, seed, p0):
    """Synthetic Chainlink rounds: [(answer_int, updatedAt)] with strictly increasing updatedAt."""
    rng = np.random.default_rng(seed)
    t, price, out = t_start, p0, Rounds()
    while t < t_end:
        t += int(rng.integers(300, 3600))
        price *= math.exp(rng.normal(0, 0.008))
        out.append((int(round(price * 1e8)), t))
    out.ups = [r[1] for r in out]
    return out


class Rounds(list):
    ups = None


def split_phases(rounds, switch_ts, first_phase=3):
    a = [r for r in rounds if r[1] < switch_ts]
    b = [r for r in rounds if r[1] >= switch_ts]
    return {first_phase: a, first_phase + 1: b}


def brute_answer_at(rounds, ts):
    """Reference: the round with the largest updatedAt <= ts (rounds sorted by updatedAt), or None."""
    ups = getattr(rounds, "ups", None) or [r[1] for r in rounds]
    i = bisect.bisect_right(ups, ts)
    return rounds[i - 1] if i else None


def word(v):
    return format(v % (1 << 256), "064x")


class FakeChain:
    """JSON-RPC eth_call emulation of Chainlink proxies with phases (OCR semantics: a round that does
    not exist yet returns zeros; an unknown phase reverts). `now` hides rounds written after it."""

    def __init__(self, feeds, now):
        self.now = now
        self.proxies = {}
        self.aggs = {}
        n = 1
        self.ups = {}
        for addr, phases in feeds.items():
            agg_addrs = {}
            for p in phases:
                self.ups[id(phases[p])] = [r[1] for r in phases[p]]
                a = "0x" + format(0xA000 + n, "040x")
                n += 1
                agg_addrs[p] = a
                self.aggs[a] = (addr.lower(), p)
            self.proxies[addr.lower()] = {"phases": phases, "aggs": agg_addrs}
        self.seen_urls = set()
        self.fail_urls = set()       # providers that answer HTTP 500
        self.max_batch = {}          # url -> largest batch accepted
        self.n_calls = 0

    def _visible(self, rounds):
        return rounds[:bisect.bisect_right(self.ups[id(rounds)], self.now)]

    def _enc_round(self, rid, ans, upd):
        return "0x" + word(rid) + word(ans) + word(upd) + word(upd) + word(rid)

    def _handle(self, to, data):
        self.n_calls += 1
        to = to.lower()
        sel, arg = data[2:10], data[10:]
        if to in self.proxies:
            px = self.proxies[to]
            phases = px["phases"]
            cur = max(phases)
            if sel == cl.SEL_LATEST_ROUND_DATA:
                vis = self._visible(phases[cur])
                ans, upd = vis[-1]
                return {"result": self._enc_round((cur << 64) | len(vis), ans, upd)}
            if sel == cl.SEL_GET_ROUND_DATA:
                rid = int(arg, 16)
                p, a = rid >> 64, rid & MASK
                if p not in phases:
                    return {"error": {"code": 3, "message": "execution reverted"}}
                vis = self._visible(phases[p])
                if a == 0 or a > len(vis):
                    return {"result": self._enc_round(rid, 0, 0)}
                ans, upd = vis[a - 1]
                return {"result": self._enc_round(rid, ans, upd)}
            if sel == cl.SEL_PHASE_AGGREGATORS:
                p = int(arg, 16)
                addr = px["aggs"].get(p)
                return {"result": "0x" + word(int(addr, 16) if addr else 0)}
        if to in self.aggs and sel == cl.SEL_LATEST_ROUND_DATA:
            proxy, p = self.aggs[to]
            vis = self._visible(self.proxies[proxy]["phases"][p])
            ans, upd = vis[-1]
            return {"result": self._enc_round(len(vis), ans, upd)}
        return {"error": {"code": 3, "message": "execution reverted"}}

    def post(self, url, body, timeout):
        self.seen_urls.add(url)
        if url in self.fail_urls:
            raise urllib.error.URLError(f"connection to {url} refused")
        req = json.loads(body)
        reqs = req if isinstance(req, list) else [req]
        if len(reqs) > self.max_batch.get(url, 10 ** 9):
            raise urllib.error.HTTPError(url, 500, "Internal Server Error", {}, None)
        out = []
        for q in reqs:
            r = self._handle(q["params"][0]["to"], q["params"][0]["data"])
            out.append({"jsonrpc": "2.0", "id": q["id"], **r})
        return json.dumps(out if isinstance(req, list) else out[0]).encode()


class FakeDeribit:
    """DVOL candles + option-chain endpoints. With ignore_end=True the DVOL endpoint returns every candle
    up to the CURRENT (still open) hour, as an API that ignored end_timestamp would."""

    def __init__(self, now, ignore_end=True, missing_open=None):
        self.now = now
        self.ignore_end = ignore_end
        self.missing_open = missing_open
        self.urls = []

    @staticmethod
    def close_for(asset, open_ts):
        return (45.0 if asset == "ETH" else 40.0) + (open_ts // HOUR % 50) / 10.0

    def __call__(self, url):
        self.urls.append(url)
        u = urllib.parse.urlparse(url)
        q = dict(urllib.parse.parse_qsl(u.query))
        if u.path.endswith("get_volatility_index_data"):
            start = int(q["start_timestamp"]) // 1000
            end = int(q["end_timestamp"]) // 1000
            cur_open = self.now - self.now % HOUR
            last = cur_open if self.ignore_end else min(end, cur_open)
            data = []
            t = start - start % HOUR
            while t <= last:
                if t != self.missing_open:
                    c = 999.0 if t == cur_open else self.close_for(q["currency"], t)
                    data.append([t * 1000, c, c, c, c])
                t += HOUR
            return json.dumps({"jsonrpc": "2.0", "result": {"data": data, "continuation": None}}).encode()
        if u.path.endswith("get_index_price"):
            return json.dumps({"jsonrpc": "2.0", "result": {"index_price": 2400.5}}).encode()
        return json.dumps({"jsonrpc": "2.0", "result": [{"instrument_name": "X-" + q.get("currency", "")}]}).encode()


def make_grid(rounds, start, last_open):
    """Price-history grid from the synthetic rounds, as the builder defines it: oracle = answer in force at
    hour END (rounded to cents); oracleLow = min of the round in force at hour start and the rounds inside."""
    n = (last_open - start) // HOUR + 1
    ups = [r[1] for r in rounds]
    oracle, low = [], []
    for i in range(n):
        h0 = start + i * HOUR
        h1 = h0 + HOUR
        i0 = bisect.bisect_right(ups, h0)   # rounds[i0-1] is in force at h0
        i1 = bisect.bisect_right(ups, h1)   # rounds[i0:i1] have updatedAt in (h0, h1]
        vals = [rounds[i0 - 1][0]] + [a for a, _ in rounds[i0:i1]]
        oracle.append(round(rounds[i1 - 1][0] / 1e8, 2))
        low.append(round(min(vals) / 1e8, 2))
    return t1.PriceGrid(start, HOUR, {"oracle": oracle, "oracleLow": low, "binanceLow": low})


IDENTITY_MAPS = {src: {T: {"x": [0.0, 1.0], "y": [0.0, 1.0]} for T in t1.HORIZONS} for src in t1.SOURCES}
CAL_META = {"status": "test identity maps", "sha256": "test", "t1Verdict": "FAIL"}


class World:
    """One synthetic world: rounds for ETH and BTC with a phase switch, a price grid that ends before asof."""

    def __init__(self, asof, hist_last_open, switch_ts, horizon_days=45):
        self.asof = asof
        t0 = asof - 130 * DAY
        t_end = asof + horizon_days * DAY
        self.rounds = {"ETH": make_rounds(t0, t_end, 1, 2500.0), "BTC": make_rounds(t0, t_end, 2, 80000.0)}
        self.phases = {a: split_phases(r, switch_ts) for a, r in self.rounds.items()}
        self.chain = FakeChain({cl.FEEDS[a]: self.phases[a] for a in ("ETH", "BTC")}, now=asof)
        start = asof - 125 * DAY
        self.grid_start = start
        self.grids = {a: make_grid(self.rounds[a], start, hist_last_open) for a in ("ETH", "BTC")}
        self.price_meta = {"test": True}

    def rpc(self, **kw):
        return cl.RpcClient(urls=cl.PUBLIC_RPCS, post=self.chain.post, sleep=lambda s: None, **kw)


# ---------------------------------------------------------------------------------------------
# Chainlink client
# ---------------------------------------------------------------------------------------------
class TestAnswerAt(unittest.TestCase):
    def setUp(self):
        self.t0 = utc("2026-01-01T00:00:00Z")
        self.rounds = make_rounds(self.t0, self.t0 + 20 * DAY, 7, 3000.0)
        self.switch = self.t0 + 9 * DAY + 1234
        self.phases = split_phases(self.rounds, self.switch, first_phase=5)
        self.now = self.t0 + 20 * DAY
        self.chain = FakeChain({cl.FEEDS["ETH"]: self.phases}, now=self.now)
        rpc = cl.RpcClient(urls=cl.PUBLIC_RPCS, post=self.chain.post, sleep=lambda s: None, max_calls=10 ** 6)
        self.feed = cl.Feed(rpc, cl.FEEDS["ETH"], clock=lambda: self.now)

    def _expect(self, ts):
        return brute_answer_at(self.rounds, ts)

    def test_matches_bruteforce_across_phase_boundary(self):
        rng = np.random.default_rng(3)
        first = self.rounds[0][1]
        ts_list = list(rng.integers(first, self.now, size=300))
        ts_list += [r[1] for r in self.rounds[::37]] + [r[1] - 1 for r in self.rounds[::41]]
        ts_list += [self.switch - 1, self.switch, self.phases[6][0][1], self.phases[6][0][1] - 1,
                    self.phases[5][-1][1], first, self.now]
        crossed = 0
        for ts in ts_list:
            exp = self._expect(int(ts))
            if exp is None:  # before the first round of the first phase
                with self.assertRaises(LookupError):
                    self.feed.answer_at(int(ts))
                continue
            r = self.feed.answer_at(int(ts))
            self.assertEqual((r.answer, r.updated_at), exp, msg=f"ts={ts}")
            phase = 5 if exp[1] < self.switch else 6
            self.assertEqual(r.phase, phase)
            crossed += r.phase == 5
        self.assertGreater(crossed, 50)

    def test_upper_hint_gives_same_answer(self):
        prev = None
        for k in range(15):
            ts = self.now - k * DAY - 777
            r = self.feed.answer_at(ts, upper=prev)
            self.assertEqual((r.answer, r.updated_at), self._expect(ts))
            prev = r

    def test_before_first_round_and_future(self):
        with self.assertRaises(LookupError):
            self.feed.answer_at(self.rounds[0][1] - 1)
        with self.assertRaises(ValueError):
            self.feed.answer_at(self.now + 10)

    def test_rounds_between_includes_in_force_round_and_spans_phases(self):
        t_a, t_b = self.switch - 2 * DAY + 17, self.switch + DAY
        got = self.feed.rounds_between(t_a, t_b)
        exp = [self._expect(t_a)] + [r for r in self.rounds if t_a < r[1] <= t_b]
        self.assertEqual([(r.answer, r.updated_at) for r in got], exp)
        self.assertEqual({r.phase for r in got}, {5, 6})


class TestWindowMin(unittest.TestCase):
    def R(self, i, ans, upd):
        return cl.Round((1 << 64) | i, ans, upd, upd, (1 << 64) | i)

    def test_in_force_round_at_start_counts(self):
        a, b = 1000, 2000
        rounds = [self.R(1, 50, 400), self.R(2, 10, 900),     # 10 is in force at a: it is the window min
                  self.R(3, 30, 1500), self.R(4, 20, 2000),   # 2000 == b: included
                  self.R(5, 1, 2001)]                         # after b: excluded
        m, used = cl.window_min(rounds, a, b)
        self.assertEqual(m.answer, 10)
        self.assertEqual([r.answer for r in used], [10, 30, 20])

    def test_round_exactly_at_start_is_in_force_not_inside(self):
        rounds = [self.R(1, 5, 500), self.R(2, 40, 1000), self.R(3, 35, 1600)]
        m, used = cl.window_min(rounds, 1000, 2000)
        self.assertEqual(m.answer, 35)
        self.assertEqual([r.answer for r in used], [40, 35])

    def test_no_in_force_round_is_unresolved(self):
        m, used = cl.window_min([self.R(1, 5, 1500)], 1000, 2000)
        self.assertIsNone(m)


class TestRpcClient(unittest.TestCase):
    def setUp(self):
        t0 = utc("2026-01-01T00:00:00Z")
        self.chain = FakeChain({cl.FEEDS["ETH"]: {1: make_rounds(t0, t0 + 3 * DAY, 9, 2000.0)}}, now=t0 + 3 * DAY)

    def test_fallback_to_next_provider(self):
        self.chain.fail_urls.add(cl.PUBLIC_RPCS[0])
        rpc = cl.RpcClient(urls=cl.PUBLIC_RPCS, post=self.chain.post, sleep=lambda s: None)
        r = cl.Feed(rpc, cl.FEEDS["ETH"]).latest_round_data()
        self.assertGreater(r.answer, 0)
        self.assertEqual(rpc.stats()["providerSwitches"], 1)
        self.assertIn(cl.PUBLIC_RPCS[1], self.chain.seen_urls)

    def test_batch_shrinks_for_providers_that_reject_large_batches(self):
        self.chain.max_batch[cl.PUBLIC_RPCS[0]] = 3
        rpc = cl.RpcClient(urls=cl.PUBLIC_RPCS, post=self.chain.post, sleep=lambda s: None, batch_size=50)
        feed = cl.Feed(rpc, cl.FEEDS["ETH"])
        ids = [(1 << 64) | i for i in range(1, 41)]
        got = feed.get_rounds(ids)
        self.assertTrue(all(g is not None for g in got))
        self.assertEqual([g.agg for g in got], list(range(1, 41)))
        self.assertEqual(rpc.stats()["providerSwitches"], 0)

    def test_budget(self):
        rpc = cl.RpcClient(urls=cl.PUBLIC_RPCS, post=self.chain.post, sleep=lambda s: None, max_calls=5)
        feed = cl.Feed(rpc, cl.FEEDS["ETH"])
        with self.assertRaises(cl.BudgetExceeded):
            feed.get_rounds([(1 << 64) | i for i in range(1, 20)])

    def test_keyed_urls_rejected(self):
        for bad in ("https://mainnet.infura.io/v3/0123456789abcdef0123456789abcdef",
                    "https://eth.example.org/?apikey=abc", "https://user:pw@eth.example.org",
                    "http://ethereum-rpc.publicnode.com"):
            with self.assertRaises(ValueError):
                cl.RpcClient(urls=(bad,))

    def test_errors_are_scrubbed_of_urls(self):
        for u in cl.PUBLIC_RPCS:
            self.chain.fail_urls.add(u)
        rpc = cl.RpcClient(urls=cl.PUBLIC_RPCS, post=self.chain.post, sleep=lambda s: None)
        with self.assertRaises(cl.RpcError) as ctx:
            rpc.eth_call(cl.FEEDS["ETH"], cl.SEL_LATEST_ROUND_DATA)
        for u in cl.PUBLIC_RPCS:
            self.assertNotIn(urllib.parse.urlparse(u).netloc, str(ctx.exception))


# ---------------------------------------------------------------------------------------------
# Issuer
# ---------------------------------------------------------------------------------------------
class IssuerBase(unittest.TestCase):
    ASOF = utc("2026-10-20T00:00:00Z")

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = self.tmp.name
        # history ends with the hour opening asof - 5d + 2h -> P_k from history for k >= 5, chain for k <= 4;
        # phase switch at asof - 3.5d -> the chain close k = 4 lies in the previous phase.
        self.hist_last_open = self.ASOF - 5 * DAY + 2 * HOUR
        self.w = World(self.ASOF, self.hist_last_open, self.ASOF - 3 * DAY - 12 * HOUR)

    def tearDown(self):
        self.tmp.cleanup()

    def run_issue(self, issued_at, deribit=None, grids=None):
        self.w.chain.now = issued_at
        rpc = self.w.rpc()
        deribit = deribit or FakeDeribit(issued_at)
        return m1_issue.issue(self.out, grids or self.w.grids, self.w.price_meta, IDENTITY_MAPS, CAL_META, rpc,
                              http_get=deribit, clock=lambda: issued_at, log=quiet,
                              code={"path": "test"})

    def day_dir(self):
        return os.path.join(self.out, "forecasts", "m1-live")


class TestIssuer(IssuerBase):
    def test_asof_flooring(self):
        path, doc, _ = self.run_issue(self.ASOF + 7 * 60 + 13)
        self.assertEqual(doc["asof"], self.ASOF)
        self.assertEqual(doc["issuedAt"], self.ASOF + 433)
        self.assertTrue(path.endswith("2026-10-20.json"))
        late = self.ASOF + DAY + 13 * HOUR + 59 * 60 + 59        # 2026-10-21T13:59:59Z
        _, doc2, _ = self.run_issue(late)
        self.assertEqual(doc2["asof"], self.ASOF + DAY + 13 * HOUR)
        self.assertEqual(doc2["date"], "2026-10-21")

    def test_settle_guard(self):
        with self.assertRaises(SystemExit):
            self.run_issue(self.ASOF + 30)
        self.assertFalse(os.path.exists(os.path.join(self.day_dir(), "2026-10-20.json")))

    def test_dvol_candle_is_last_closed_one(self):
        issued = self.ASOF + 7 * 60
        der = FakeDeribit(issued, ignore_end=True)   # returns the still-open candle at asof too (close 999)
        _, doc, _ = self.run_issue(issued, deribit=der)
        for a in ("ETH", "BTC"):
            dv = doc["inputs"][a]["DVOL"]
            self.assertEqual(dv["candleOpen"], "2026-10-19T23:00:00Z")
            self.assertEqual(dv["close"], FakeDeribit.close_for(a, self.ASOF - HOUR))
            self.assertNotEqual(dv["close"], 999.0)
            self.assertGreaterEqual(dv["discardedNewerRows"], 1)
            self.assertEqual(dv["params"]["end_timestamp"], (self.ASOF - HOUR) * 1000)
            self.assertAlmostEqual(doc["inputs"][a]["sigma"]["DVOL"], dv["close"] / 100)

    def test_dvol_candle_missing_refuses(self):
        issued = self.ASOF + 7 * 60
        with self.assertRaises(SystemExit):
            self.run_issue(issued, deribit=FakeDeribit(issued, missing_open=self.ASOF - HOUR))
        self.assertEqual(os.listdir(self.out), [])

    def test_rv_close_sourcing_switch(self):
        issued = self.ASOF + 9 * 60
        _, doc, _ = self.run_issue(issued)
        all_rounds = {a: self.w.rounds[a] for a in ("ETH", "BTC")}
        for a in ("ETH", "BTC"):
            closes = doc["inputs"][a]["rv"]["closes"]
            self.assertEqual(len(closes), 91)
            self.assertEqual([c["source"] for c in closes[:5]], ["chainlink"] * 5)
            self.assertEqual({c["source"] for c in closes[5:]}, {"price-history"})
            self.assertEqual(closes[5]["hourOpen"], t1.iso(self.ASOF - 5 * DAY - HOUR))
            for c in closes[:5]:
                exp = brute_answer_at(all_rounds[a], self.ASOF - c["k"] * DAY)
                self.assertEqual((c["answer"], c["updatedAt"]), exp)
                self.assertIn("roundId", c)
            self.assertEqual(closes[4]["phaseId"], 3)   # before the phase switch
            self.assertEqual(closes[0]["phaseId"], 4)
            for c in closes[5:]:
                self.assertEqual(c["price"], self.w.grids[a].value_at_open("oracle", self.ASOF - c["k"] * DAY - HOUR))
            sc = doc["inputs"][a]["rv"]["switchCheck"]
            self.assertEqual(sc["k"], 5)
            self.assertLessEqual(sc["absDiff"], 0.005 + 1e-9)
            prices = [c["price"] for c in closes]
            self.assertEqual(doc["inputs"][a]["sigma"]["RV30"], t1.realized_vol(prices[:31]))
            self.assertEqual(doc["inputs"][a]["sigma"]["RV90"], t1.realized_vol(prices))
            self.assertEqual(doc["inputs"][a]["rv"]["sourceCounts"], {"chainlink": 5, "price-history": 86})

    def test_spot_and_grid(self):
        issued = self.ASOF + 9 * 60
        _, doc, _ = self.run_issue(issued)
        self.assertEqual(doc["kind"], "live")
        self.assertEqual(doc["nRows"], 2 * 5 * 5)
        for a in ("ETH", "BTC"):
            # D2: S is the answer in force at asof; latestRoundData at issue is reference only
            exp_asof = brute_answer_at(self.w.rounds[a], self.ASOF)
            s = doc["inputs"][a]["S"]
            self.assertEqual((s["close"]["answer"], s["close"]["updatedAt"]), exp_asof)
            self.assertLessEqual(s["close"]["updatedAt"], self.ASOF)
            self.assertEqual(s["price"], doc["inputs"][a]["rv"]["closes"][0]["price"])
            exp = brute_answer_at(self.w.rounds[a], issued)
            ref = s["latestRoundDataAtIssue_referenceOnly"]
            self.assertEqual((ref["answer"], ref["updatedAt"]), exp)
            self.assertEqual(ref["updatedAfterAsof"], exp[1] > self.ASOF)
        for row in doc["grid"]:
            S = doc["inputs"][row["asset"]]["S"]["price"]
            self.assertEqual(row["S"], S)
            self.assertAlmostEqual(row["L"], S * (1 + row["k"]))
            self.assertEqual(row["resolvesAtTs"], self.ASOF + row["T"] * DAY)
            self.assertEqual(row["windowStart"], "2026-10-20T00:00:00Z")
            for src in t1.SOURCES:
                sig = doc["inputs"][row["asset"]]["sigma"][src]
                self.assertEqual(row["p_raw"][src], t1.touch_prob(row["k"], sig, row["T"]))
                self.assertAlmostEqual(row["p_cal"][src], row["p_raw"][src])  # identity maps

    def test_hash_chain_genesis_and_linking(self):
        p1, d1, sha1 = self.run_issue(self.ASOF + 7 * 60)
        self.assertEqual(d1["prevSha256"], ZERO_SHA)
        self.assertIsNone(d1["prevFile"])
        self.assertTrue(d1["selfSha256Excluded"])
        self.assertEqual(sha1, sha256_file(p1))
        # a skipped day: the next file links to the latest earlier file
        p3, d3, sha3 = self.run_issue(self.ASOF + 2 * DAY + 8 * 60)
        self.assertEqual(d3["prevFile"], "2026-10-20.json")
        self.assertEqual(d3["prevSha256"], sha256_file(p1))
        with open(os.path.join(self.day_dir(), "chain.jsonl")) as f:
            lines = [json.loads(x) for x in f]
        self.assertEqual([x["file"] for x in lines], ["2026-10-20.json", "2026-10-22.json"])
        self.assertEqual(lines[0]["sha256"], sha1)
        self.assertEqual(lines[1]["prevSha256"], sha1)
        self.assertEqual(lines[1]["sha256"], sha3)
        self.assertEqual(verify_chain(self.day_dir()), [])
        # tamper with the first file -> chain broken, next issue refuses
        with open(p1, "ab") as f:
            f.write(b" ")
        self.assertTrue(verify_chain(self.day_dir()))
        with self.assertRaises(SystemExit):
            self.run_issue(self.ASOF + 3 * DAY + 8 * 60)
        self.assertFalse(os.path.exists(os.path.join(self.day_dir(), "2026-10-23.json")))

    def test_refuse_overwrite_and_same_date(self):
        p1, _, sha1 = self.run_issue(self.ASOF + 7 * 60)
        with self.assertRaises(SystemExit):
            self.run_issue(self.ASOF + 5 * HOUR + 7 * 60)      # same UTC date, later hour
        self.assertEqual(sha256_file(p1), sha1)
        with open(os.path.join(self.day_dir(), "chain.jsonl")) as f:
            self.assertEqual(len(f.readlines()), 1)

    def test_refuse_when_later_file_exists(self):
        os.makedirs(self.day_dir())
        with open(os.path.join(self.day_dir(), "2026-10-25.json"), "w") as f:
            f.write("{}")
        with self.assertRaises(SystemExit):
            self.run_issue(self.ASOF + 7 * 60)

    def test_no_option_sets_issue_time(self):
        for opt in ("--issued-at", "--issuedAt", "--asof", "--now", "--time"):
            with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
                m1_issue.main(["--datasets", "x", "--out", "y", opt, "1"])


# ---------------------------------------------------------------------------------------------
# Scorer
# ---------------------------------------------------------------------------------------------
class TestScorer(IssuerBase):
    def score(self, now, grids=None, fail_all=False):
        self.w.chain.now = now
        if fail_all:
            self.w.chain.fail_urls.update(cl.PUBLIC_RPCS)
        rpc = self.w.rpc()
        return m1_score.score(self.out, grids or self.w.grids, self.w.price_meta, rpc, clock=lambda: now, log=quiet)

    def load(self, name):
        with open(os.path.join(self.day_dir(), "scores", name)) as f:
            return json.load(f)

    def test_nothing_resolves_yet(self):
        issued = self.ASOF + 7 * 60
        self.run_issue(issued)
        self.score(issued + 20 * 60)
        s = self.load("summary.json")
        self.assertIn("n >= 90", s["passLine"])
        for T in t1.HORIZONS:
            h = s["perHorizon"][str(T)]
            self.assertEqual(h["nIssueDaysResolved"], 0)
            self.assertEqual(h["nRowsPending"], 10)
            self.assertIsNone(h["bss"]["calDVOL_vs_calRV30"])
            self.assertFalse(h["passLine"]["applied"])

    def test_chain_truth_window_min_with_in_force_round(self):
        issued = self.ASOF + 7 * 60
        _, doc, _ = self.run_issue(issued)
        now = self.ASOF + 7 * DAY + RESOLVE_PAD
        self.score(now)
        rows = self.load("scores.json")["rows"]
        for r in rows:
            if r["T"] <= 7:
                self.assertEqual(r["status"], "resolved")
                self.assertEqual(r["truth"]["source"], "chainlink rounds")
                rr = self.w.rounds[r["asset"]]
                a, b = self.ASOF, self.ASOF + r["T"] * DAY
                vals = [brute_answer_at(rr, a)[0]] + [x[0] for x in rr if a < x[1] <= b]
                self.assertEqual(r["truth"]["min"], min(vals) / 1e8)
                self.assertEqual(r["truth"]["inForceAtStart"]["updatedAt"], brute_answer_at(rr, a)[1])
                self.assertEqual(r["y"], int(min(vals) / 1e8 <= r["L"]))
                self.assertAlmostEqual(r["brier"]["cal"]["DVOL"], (r["p_cal"]["DVOL"] - r["y"]) ** 2)
            else:
                self.assertEqual(r["status"], "pending")
        s = self.load("summary.json")
        self.assertEqual(s["perHorizon"]["1"]["nIssueDaysResolved"], 1)
        self.assertEqual(s["perHorizon"]["1"]["nRowsResolved"], 10)
        self.assertEqual(s["perHorizon"]["14"]["nRowsResolved"], 0)
        # a T=7 row is not scored before the finality margin has passed
        self.score(self.ASOF + 7 * DAY + 60)
        rows = self.load("scores.json")["rows"]
        self.assertTrue(all(r["status"] == "pending" for r in rows if r["T"] == 7))

    def test_price_history_truth_when_window_inside(self):
        issued = self.ASOF + 7 * 60
        self.run_issue(issued)
        full = {a: make_grid(self.w.rounds[a], self.w.grid_start, self.ASOF + 40 * DAY) for a in ("ETH", "BTC")}
        self.score(self.ASOF + 3 * DAY + RESOLVE_PAD, grids=full)
        for r in self.load("scores.json")["rows"]:
            if r["T"] <= 3:
                self.assertEqual(r["truth"]["source"], "price-history oracleLow")
                exp = full[r["asset"]].window_min("oracleLow", self.ASOF, self.ASOF + r["T"] * DAY - HOUR)
                self.assertEqual(r["truth"]["min"], exp)
                rr = self.w.rounds[r["asset"]]
                a, b = self.ASOF, self.ASOF + r["T"] * DAY
                chain_min = min([brute_answer_at(rr, a)[0]] + [x[0] for x in rr if a < x[1] <= b]) / 1e8
                self.assertAlmostEqual(r["truth"]["min"], chain_min, delta=0.0051)

    def test_unresolved_when_no_source(self):
        self.run_issue(self.ASOF + 7 * 60)
        self.score(self.ASOF + DAY + RESOLVE_PAD, fail_all=True)
        s = self.load("scores.json")
        t1rows = [r for r in s["rows"] if r["T"] == 1]
        self.assertTrue(all(r["status"] == "unresolved" for r in t1rows))
        self.assertTrue(all(r["y"] is None for r in t1rows))
        self.assertEqual(self.load("summary.json")["perHorizon"]["1"]["nRowsUnresolved"], 10)

    def test_idempotent(self):
        self.run_issue(self.ASOF + 7 * 60)
        now = self.ASOF + 3 * DAY + RESOLVE_PAD
        self.score(now)
        a = self.load("scores.json")
        self.score(now)
        b = self.load("scores.json")
        a.pop("rpc"), b.pop("rpc")
        self.assertEqual(a, b)

    def test_pre_issue_min_and_exclusion(self):
        # D5: a level touched in (asof, issuedAt] was knowable at issue; the row is excluded, never scored
        issued = self.ASOF + 40 * 60
        self.run_issue(issued)
        orig = m1_score.truth_chain
        def fake(rounds, row):
            t = orig(rounds, row)
            if t is not None:
                rr = self.w.rounds[row["asset"]]
                pre = [x[0] / 1e8 for x in rr if self.ASOF < x[1] <= issued]
                self.assertEqual(t["preIssueMin"], min(pre) if pre else None)
                if row["asset"] == "ETH" and row["T"] == 1 and row["k"] == -0.05:
                    t = dict(t, preIssueMin=row["L"] * 0.99)
            return t
        m1_score.truth_chain = fake
        try:
            self.score(self.ASOF + DAY + RESOLVE_PAD)
        finally:
            m1_score.truth_chain = orig
        rows = self.load("scores.json")["rows"]
        ex = [r for r in rows if r["status"] == "excluded_touched_before_issue"]
        self.assertEqual(len(ex), 1)
        self.assertIsNone(ex[0]["y"])
        h = self.load("summary.json")["perHorizon"]["1"]
        self.assertEqual(h["nRowsExcludedTouchedBeforeIssue"], 1)
        self.assertEqual(h["nRowsResolved"], 9)

    def test_scorer_refuses_broken_chain(self):
        p, _, _ = self.run_issue(self.ASOF + 7 * 60)
        with open(p, "ab") as f:
            f.write(b"\n")
        with self.assertRaises(SystemExit):
            self.score(self.ASOF + 2 * DAY)


RESOLVE_PAD = m1_score.RESOLVE_MARGIN + 60


# ---------------------------------------------------------------------------------------------
# Snapshot
# ---------------------------------------------------------------------------------------------
class TestSnapshot(unittest.TestCase):
    def test_layout_manifest_no_overwrite(self):
        with tempfile.TemporaryDirectory() as out:
            ts = utc("2026-10-20T00:07:05Z")
            der = FakeDeribit(ts)
            _, paths, rows = snap.snapshot(out, get=der, clock=lambda: ts, log=quiet)
            names = sorted(r[0] for r in rows)
            self.assertEqual(names, sorted(f"{e}_{a}_20261020T000705Z.json.gz" for a in ("ETH", "BTC")
                                           for e in ("book", "instruments", "index")))
            day = os.path.join(out, "deribit-chain", "2026-10-20")
            with open(os.path.join(day, "MANIFEST.md")) as f:
                man = f.read()
            for fname, n, sha in rows:
                p = os.path.join(day, fname)
                self.assertEqual(os.path.getsize(p), n)
                self.assertEqual(sha256_file(p), sha)
                self.assertIn(f"| `{fname}` | {n} | `{sha}` |", man)
            with open(os.path.join(day, "index_ETH_20261020T000705Z.json.gz"), "rb") as f:
                raw = gzip.decompress(f.read())
            self.assertEqual(json.loads(raw)["result"]["index_price"], 2400.5)
            self.assertTrue(any("kind=option" in u and "expired=false" in u for u in der.urls))
            with self.assertRaises(SystemExit):
                snap.snapshot(out, get=der, clock=lambda: ts, log=quiet)
            # a later snapshot the same day appends to the manifest
            snap.snapshot(out, get=der, clock=lambda: ts + 3600, log=quiet)
            with open(os.path.join(day, "MANIFEST.md")) as f:
                self.assertEqual(sum(line.startswith("| `") for line in f), 12)


# ---------------------------------------------------------------------------------------------
# No RPC URL in any output
# ---------------------------------------------------------------------------------------------
class TestNoRpcUrlInOutputs(IssuerBase):
    def test_scan_all_outputs(self):
        self.w.chain.fail_urls.add(cl.PUBLIC_RPCS[0])   # force a fallback so error text flows through
        issued = self.ASOF + 7 * 60
        self.run_issue(issued)
        snap.snapshot(self.out, get=FakeDeribit(issued), clock=lambda: issued, log=quiet)
        self.w.chain.now = self.ASOF + 2 * DAY
        rpc = self.w.rpc()
        m1_score.score(self.out, self.w.grids, self.w.price_meta, rpc, clock=lambda: self.ASOF + 2 * DAY, log=quiet)
        # and a run where every provider fails (errors recorded in chainErrors)
        self.w.chain.fail_urls.update(cl.PUBLIC_RPCS)
        rpc = self.w.rpc()
        m1_score.score(self.out, self.w.grids, self.w.price_meta, rpc, clock=lambda: self.ASOF + 2 * DAY + 60,
                       log=quiet)
        with open(os.path.join(self.day_dir(), "scores", "scores.json")) as f:
            self.assertTrue(json.load(f)["chainErrors"])
        needles = set()
        for u in cl.PUBLIC_RPCS:
            needles.add(u)
            host = urllib.parse.urlparse(u).netloc
            needles.add(host)
            needles.add(host.split(".")[-2] if host.count(".") >= 1 else host)
        n_files = 0
        for root, _, files in os.walk(self.out):
            for fn in files:
                p = os.path.join(root, fn)
                with open(p, "rb") as f:
                    data = f.read()
                if fn.endswith(".gz"):
                    data = gzip.decompress(data)
                text = data.decode("utf-8", "replace").lower()
                n_files += 1
                for nd in needles:
                    self.assertNotIn(nd.lower(), text, msg=f"{nd} found in {p}")
        self.assertGreaterEqual(n_files, 2 + 6 + 1 + 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
