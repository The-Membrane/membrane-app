"""Unit tests for g_acquire_events.py: topic0 / ABI decode, range splitting and resume, G.2 delta
formulas on a simulated scaled-balance token, gate math, balance maxima, partitioned writes.

Run: python3 -m unittest scripts/research/history-forecasts/test_g_acquire_events.py
"""

import gzip
import json
import random
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import g_acquire_events as G  # noqa: E402

RAY = G.RAY
ZERO = "0x" + "00" * 20
TOKEN = "0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c"


def addr(i: int) -> str:
    return "0x" + f"{i:040x}"


def pad(a: str) -> str:
    return "0x" + "00" * 12 + a[2:]


def words(*ns) -> str:
    return "0x" + "".join(f"{n:064x}" for n in ns)


def log_of(typ, a1, a2, *ws):
    return {"topics": [G.TOPIC_OF[typ], pad(a1), pad(a2)], "data": words(*ws), "type": typ}


# ---------------------------------------------------------------------------------------------
# A scaled-balance token that emits events the way the aToken source does
# ---------------------------------------------------------------------------------------------


class SimAToken:
    def __init__(self):
        self.scaled = {}
        self.last = {}
        self.logs = []

    def _bi(self, u, index):
        sb = self.scaled.get(u, 0)
        return G.ray_mul(sb, index) - G.ray_mul(sb, self.last.get(u, 0))

    def mint(self, caller, on_behalf, amount, index):
        bi = self._bi(on_behalf, index)
        self.last[on_behalf] = index
        self.scaled[on_behalf] = self.scaled.get(on_behalf, 0) + G.ray_div(amount, index)
        self.logs.append(log_of("Transfer", ZERO, on_behalf, amount + bi))
        self.logs.append(log_of("Mint", caller, on_behalf, amount + bi, bi, index))

    def burn(self, user, target, amount, index):
        bi = self._bi(user, index)
        self.last[user] = index
        self.scaled[user] -= G.ray_div(amount, index)
        if bi > amount:
            self.logs.append(log_of("Transfer", ZERO, user, bi - amount))
            self.logs.append(log_of("Mint", user, user, bi - amount, bi, index))
        else:
            self.logs.append(log_of("Transfer", user, ZERO, amount - bi))
            self.logs.append(log_of("Burn", user, target, amount - bi, bi, index))

    def transfer(self, caller, s, r, amount, index):
        sbi, rbi = self._bi(s, index), self._bi(r, index)
        self.last[s] = self.last[r] = index
        sc = G.ray_div(amount, index)
        self.scaled[s] = self.scaled.get(s, 0) - sc
        self.scaled[r] = self.scaled.get(r, 0) + sc
        if sbi > 0:
            self.logs.append(log_of("Transfer", ZERO, s, sbi))
            self.logs.append(log_of("Mint", caller, s, sbi, sbi, index))
        if s != r and rbi > 0:
            self.logs.append(log_of("Transfer", ZERO, r, rbi))
            self.logs.append(log_of("Mint", caller, r, rbi, rbi, index))
        self.logs.append(log_of("Transfer", s, r, amount))
        self.logs.append(log_of("BalanceTransfer", s, r, sc, index))

    def balance(self, u, index):
        return G.ray_mul(self.scaled.get(u, 0), index)


def apply_g2(logs):
    """Sum of G.2 deltas and scaled reconstruction per address."""
    bal, sc = {}, {}
    for lg in logs:
        ev = G.decode_log(lg["topics"], lg["data"])
        if ev is None:
            continue
        for a, d, s in ev["deltas"]:
            bal[a] = bal.get(a, 0) + d
            sc[a] = sc.get(a, 0) + s
    return bal, sc


class TestSignatures(unittest.TestCase):
    def test_topic0(self):
        self.assertEqual(G.TOPIC_OF["Mint"], "0x458f5fa412d0f69b08dd84872b0215675cc67bc1d5b6fd93300a1c3878b86196")
        self.assertEqual(G.TOPIC_OF["Burn"], "0x4cf25bc1d991c17529c25213d3cc0cda295eeaad5f13f361969b12ea48015f90")
        self.assertEqual(G.TOPIC_OF["BalanceTransfer"],
                         "0x4beccb90f994c31aced7a23b5611020728a23d8ec5cddd1a3e9d97b96fda8666")
        self.assertEqual(G.TOPIC_OF["Transfer"], "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef")
        c = G.check_signatures()
        self.assertTrue(c["ok"])
        self.assertTrue(c["nist_sha3_differs"])


class TestDecode(unittest.TestCase):
    def test_types_and_deltas(self):
        idx = 11 * RAY // 10
        ev = G.decode_log(**{k: v for k, v in log_of("Mint", addr(1), addr(2), 1_000_500, 500, idx).items() if k != "type"})
        self.assertEqual((ev["type"], ev["party1"], ev["party2"]), ("Mint", addr(2), addr(1)))
        self.assertEqual(ev["deltas"][0][:2], (addr(2), 1_000_000))
        ev = G.decode_log(**{k: v for k, v in log_of("Burn", addr(3), addr(4), 999_000, 1_000, idx).items() if k != "type"})
        self.assertEqual(ev["deltas"][0][:2], (addr(3), -1_000_000))
        self.assertEqual(ev["party2"], addr(4))
        ev = G.decode_log(**{k: v for k, v in log_of("BalanceTransfer", addr(5), addr(6), 1_000_000, idx).items()
                             if k != "type"})
        self.assertEqual([x[:2] for x in ev["deltas"]], [(addr(5), -1_100_000), (addr(6), 1_100_000)])
        self.assertEqual([x[2] for x in ev["deltas"]], [-1_000_000, 1_000_000])
        ev = G.decode_log(**{k: v for k, v in log_of("Transfer", addr(5), addr(6), 7).items() if k != "type"})
        self.assertEqual(ev["deltas"], [])
        self.assertIsNone(G.decode_log([G.TOPIC_OF["Approval"], pad(addr(1)), pad(addr(2))], words(5)))
        self.assertIsNone(G.decode_log(["0x" + "ab" * 32], "0x"))

    def test_bad_layouts(self):
        with self.assertRaises(G.DecodeError):
            G.decode_log([G.TOPIC_OF["Mint"], pad(addr(1))], words(1, 2, 3))
        with self.assertRaises(G.DecodeError):
            G.decode_log([G.TOPIC_OF["Mint"], pad(addr(1)), pad(addr(2))], words(1, 2))
        with self.assertRaises(G.DecodeError):
            G.decode_log([G.TOPIC_OF["Transfer"], "0x" + "11" * 32, pad(addr(2))], words(1))

    def test_burn_below_interest_emits_mint(self):
        t = SimAToken()
        i0, i1 = RAY, RAY * 2  # large jump so interest exceeds the withdrawal
        t.mint(addr(9), addr(1), 1_000_000, i0)
        t.burn(addr(1), addr(1), 100_000, i1)
        types = [lg["type"] for lg in t.logs]
        self.assertEqual(types[-1], "Mint")  # balanceIncrease > amount branch
        bal, sc = apply_g2(t.logs)
        self.assertEqual(bal[addr(1)], 1_000_000 - 100_000)
        self.assertEqual(sc[addr(1)], t.scaled[addr(1)])


class TestFormulasOnSimulation(unittest.TestCase):
    def _run(self, rate_per_step):
        rng = random.Random(7)
        t = SimAToken()
        users = [addr(i) for i in range(1, 9)]
        index = RAY
        snaps = []
        for step in range(400):
            index = index + index * rate_per_step // 10**9
            op = rng.random()
            u = rng.choice(users)
            if op < 0.4 or not t.scaled.get(u):
                t.mint(addr(99), u, rng.randint(1, 10**12), index)
            elif op < 0.7:
                amt = rng.randint(1, max(1, t.balance(u, index)))
                t.burn(u, u, amt, index)
            else:
                v = rng.choice(users)
                amt = rng.randint(0, max(0, t.balance(u, index)))
                t.transfer(addr(98), u, v, amt, index)
            if step % 50 == 49:
                snaps.append((len(t.logs), index, {x: t.balance(x, index) for x in users}))
        return t, snaps

    def test_constant_index_exact(self):
        t, snaps = self._run(0)
        for (n0, i0, b0), (n1, i1, b1) in zip(snaps, snaps[1:]):
            bal, _ = apply_g2(t.logs[n0:n1])
            for u in b0:
                self.assertLessEqual(abs((b1[u] - b0[u]) - bal.get(u, 0)), 50)  # rounding only

    def test_interest_is_the_only_residual(self):
        t, snaps = self._run(20)  # 2e-8 per step
        bal, sc = apply_g2(t.logs)
        for u, s in t.scaled.items():
            self.assertEqual(sc.get(u, 0), s)  # scaled reconstruction is exact
        for (n0, i0, b0), (n1, i1, b1) in zip(snaps, snaps[1:]):
            d, s = apply_g2(t.logs[n0:n1])
            for u in b0:
                pred = G.ray_mul(G.ray_div(b0[u], i0) + s.get(u, 0), i1)
                self.assertLessEqual(abs(b1[u] - pred), 100)
                self.assertTrue(G.gate_tolerance_pass([b0[u]], [b1[u]], [(b1[u] - b0[u]) - d.get(u, 0)])[0])


# ---------------------------------------------------------------------------------------------
# Ranges, client, store, resume
# ---------------------------------------------------------------------------------------------


def make_log(block, li, tx=None, topics=None, data="0x" + "00" * 32, ts=None):
    return {"address": TOKEN, "blockNumber": hex(block), "logIndex": hex(li), "transactionIndex": "0x0",
            "transactionHash": tx or "0x" + f"{block:032x}{li:032x}", "blockHash": "0x" + f"{block:064x}",
            "blockTimestamp": hex(ts if ts is not None else 1_600_000_000 + 12 * block),
            "topics": topics or [G.TOPIC_OF["Transfer"], pad(addr(1)), pad(addr(2))], "data": data, "removed": False}


class FakeChain:
    """Logs at every 7th block; responses over `max_logs` logs fail like a size limit."""

    def __init__(self, max_logs=300, fail_ranges=(), rate_limit_times=0):
        self.max_logs = max_logs
        self.fail_ranges = set(fail_ranges)
        self.rate_limit_times = rate_limit_times
        self.calls = []

    def logs(self, lo, hi):
        return [make_log(b, 0) for b in range(lo, hi + 1) if b % 7 == 0]

    def post(self, payload):
        req = json.loads(payload)
        p = req["params"][0]
        lo, hi = int(p["fromBlock"], 16), int(p["toBlock"], 16)
        self.calls.append((lo, hi))
        if self.rate_limit_times > 0:
            self.rate_limit_times -= 1
            return 429, b"Too Many Requests"
        if (lo, hi) in self.fail_ranges:
            return 200, json.dumps({"jsonrpc": "2.0", "id": req["id"],
                                    "error": {"code": -32603, "message": "service temporarily unavailable"}}).encode()
        lg = self.logs(lo, hi)
        if len(lg) > self.max_logs:
            return 200, json.dumps({"jsonrpc": "2.0", "id": req["id"],
                                    "error": {"code": -32602, "message": "Log response size exceeded."}}).encode()
        return 200, json.dumps({"jsonrpc": "2.0", "id": req["id"], "result": lg}).encode()


def client_for(chain, **kw):
    return G.LogsClient(post=chain.post, interval=0, retry_wait=0, sleep=lambda s: None, **kw)


class TestRanges(unittest.TestCase):
    def test_split_range(self):
        self.assertEqual(G.split_range(0, 49_999), ((0, 24_999), (25_000, 49_999)))
        self.assertEqual(G.split_range(0, 1_561), ((0, 999), (1_000, 1_561)))
        self.assertIsNone(G.split_range(0, 999))
        self.assertIsNone(G.split_range(5, 5))
        self.assertEqual(G.split_range(0, 1_000), ((0, 999), (1_000, 1_000)))

    def test_top_ranges_and_uncovered(self):
        self.assertEqual(G.top_ranges(10, 120_009), [(10, 50_009), (50_010, 100_009), (100_010, 120_009)])
        self.assertEqual(G.uncovered(0, 100, [(0, 10), (20, 30), (95, 200)]), [(11, 19), (31, 94)])
        self.assertEqual(G.uncovered(0, 100, []), [(0, 100)])
        self.assertEqual(G.uncovered(0, 100, [(0, 100)]), [])

    def test_fetch_with_splits_covers_everything(self):
        chain = FakeChain(max_logs=900)
        with tempfile.TemporaryDirectory() as d:
            store = G.LogStore(Path(d))
            c = client_for(chain)
            st = G.fetch_logs(store, c, "USDC", TOKEN, 3, 120_000)
            got = [(x["block"], x["log_index"]) for x in store.iter_reserve("USDC")]
            want = [(b, 0) for b in range(3, 120_001) if b % 7 == 0]
            self.assertEqual(got, want)
            self.assertGreater(st["splits"], 0)
            self.assertEqual(c.counts["splits"], st["splits"])
            for lo, hi in chain.calls:
                self.assertLessEqual(hi - lo + 1, G.RANGE_MAX)
            self.assertEqual(store.done("USDC")[0][0], 3)

    def test_error_at_minimum_stops(self):
        chain = FakeChain(max_logs=10)  # 1,000 blocks hold ~143 logs > 10
        with tempfile.TemporaryDirectory() as d:
            store = G.LogStore(Path(d))
            with self.assertRaises(G.B.TerminalError):
                G.fetch_logs(store, client_for(chain), "USDC", TOKEN, 0, 60_000)
            self.assertTrue(any(hi - lo + 1 == G.RANGE_MIN for lo, hi in chain.calls))

    def test_service_unavailable_splits(self):
        chain = FakeChain(max_logs=10**6, fail_ranges=[(0, 49_999)])
        with tempfile.TemporaryDirectory() as d:
            store = G.LogStore(Path(d))
            G.fetch_logs(store, client_for(chain), "USDC", TOKEN, 0, 49_999)
            self.assertEqual(store.done("USDC"), [(0, 24_999), (25_000, 49_999)])

    def test_rate_limit_retries_then_stops(self):
        chain = FakeChain(rate_limit_times=3)
        c = client_for(chain)
        self.assertEqual(len(c.get_logs(TOKEN, 0, 100)), len(chain.logs(0, 100)))
        self.assertEqual(c.counts["rate_limit_retries"], 3)
        chain = FakeChain(rate_limit_times=6)
        c = client_for(chain)
        with self.assertRaises(G.B.TerminalError):
            c.get_logs(TOKEN, 0, 100)
        self.assertEqual(len(chain.calls), 6)  # 1 + 5 retries

    def test_classification(self):
        self.assertTrue(G.is_rate_limit(429, None))
        self.assertTrue(G.is_rate_limit(200, {"code": -32005, "message": "Rate limit exceeded"}))
        self.assertFalse(G.is_rate_limit(200, {"code": -32602, "message": "Log response size exceeded"}))
        self.assertFalse(G.is_rate_limit(200, {"code": -32603, "message": "service temporarily unavailable"}))

        def boom(payload):
            raise ConnectionResetError("reset")
        with self.assertRaises(G.RangeError):
            G.LogsClient(post=boom, interval=0).get_logs(TOKEN, 0, 10)

    def test_validation(self):
        good = [make_log(5, 0)]
        self.assertEqual(len(G.validate_logs(good, TOKEN, 0, 10)), 1)
        with self.assertRaises(G.RangeError):
            G.validate_logs([dict(good[0], address=addr(7))], TOKEN, 0, 10)
        with self.assertRaises(G.RangeError):
            G.validate_logs(good, TOKEN, 6, 10)
        with self.assertRaises(G.RangeError):
            G.validate_logs(good + good, TOKEN, 0, 10)
        with self.assertRaises(G.RangeError):
            G.validate_logs([make_log(1, i) for i in range(G.CAP_SUSPECT)], TOKEN, 0, 10)
        out = G.validate_logs([make_log(5, 3), make_log(5, 1), make_log(4, 9)], TOKEN, 0, 10)
        self.assertEqual([(x["block"], x["log_index"]) for x in out], [(4, 9), (5, 1), (5, 3)])

    def test_resume_after_interrupt(self):
        chain = FakeChain(max_logs=900)
        n = [0]

        def flaky(payload):
            n[0] += 1
            if n[0] == 9:
                raise KeyboardInterrupt  # crash mid-run
            return chain.post(payload)

        with tempfile.TemporaryDirectory() as d:
            store = G.LogStore(Path(d))
            with self.assertRaises(KeyboardInterrupt):
                G.fetch_logs(store, G.LogsClient(post=flaky, interval=0), "USDT", TOKEN, 0, 150_000)
            done_before = store.done("USDT")
            self.assertTrue(done_before)
            # a torn index line is tolerated
            with open(Path(d) / "index.jsonl", "a") as f:
                f.write('{"k": ["USDT", 1')
            store2 = G.LogStore(Path(d))
            chain.calls.clear()
            G.fetch_logs(store2, client_for(chain), "USDT", TOKEN, 0, 150_000)
            got = [x["block"] for x in store2.iter_reserve("USDT")]
            self.assertEqual(got, [b for b in range(0, 150_001) if b % 7 == 0])
            for lo, hi in chain.calls:  # nothing already stored is fetched again
                for a, b in done_before:
                    self.assertTrue(hi < a or lo > b)


# ---------------------------------------------------------------------------------------------
# Gate math
# ---------------------------------------------------------------------------------------------


class TestGate(unittest.TestCase):
    def test_tolerance(self):
        P = G.gate_tolerance_pass
        self.assertTrue(P([0], [0], [10_000_000])[0])            # $10 floor
        self.assertFalse(P([0], [0], [10_000_001])[0])
        self.assertTrue(P([20_000 * 10**6], [0], [20_000_000])[0])  # 0.1% of the larger anchor ($20)
        self.assertFalse(P([20_000 * 10**6], [0], [20_000_001])[0])
        self.assertTrue(P([0], [20_000 * 10**6], [-20_000_000])[0])
        self.assertEqual(int(G.gate_tolerance([5 * 10**12], [1])[0]), 5 * 10**9)

    def test_pair_index(self):
        blocks = [100, 200, 300]
        self.assertEqual(G.pair_index(blocks, [100, 101, 200, 201, 300, 301, 50]).tolist(), [-1, 0, 0, 1, 1, 2, -1])

    def test_gate_pairs_and_summary(self):
        blocks = [100, 200, 300, 400]
        A = np.array([[0, 5 * 10**9, 5 * 10**9, 0],
                      [10**12, 10**12, 10**12, 10**12 + 5 * 10**8]], dtype=np.int64)
        valid = np.ones_like(A, dtype=bool)
        valid[1, 3] = False
        ev_addr = [0, 0, 1]
        ev_block = [150, 400, 250]
        ev_delta = [5 * 10**9, -5 * 10**9, 7 * 10**9]   # address 1 has a $7,000 event the anchors do not show
        g = G.gate_pairs(A, valid, blocks, ev_addr, ev_block, ev_delta)
        self.assertEqual(len(g["pass"]), 5)
        by = {(int(a), int(p)): (bool(ok), int(n)) for a, p, ok, n in zip(g["addr"], g["p"], g["pass"], g["n_ev"])}
        self.assertEqual(by[(0, 0)], (True, 1))
        self.assertEqual(by[(0, 1)], (True, 0))
        self.assertEqual(by[(0, 2)], (True, 1))
        self.assertEqual(by[(1, 1)], (False, 1))
        self.assertNotIn((1, 2), by)
        s = G.gate_summary(g)
        self.assertEqual((s["n_pairs"], s["n_pass"], s["n_pairs_with_event"], s["n_pass_with_event"]), (5, 4, 3, 2))
        self.assertFalse(s["passes"])

    def test_summary_needs_both_shares(self):
        n = 1000
        g = {"pass": np.ones(n, dtype=bool), "n_ev": np.zeros(n, dtype=np.int64)}
        g["n_ev"][:50] = 1
        g["pass"][:2] = False      # 2 of 50 event pairs fail: 96% < 99% though 99.8% overall
        s = G.gate_summary(g)
        self.assertGreaterEqual(s["share_pass"], 0.99)
        self.assertFalse(s["passes"])
        g["pass"][:2] = True
        self.assertTrue(G.gate_summary(g)["passes"])

    def test_intraday_peak(self):
        blocks = [100, 200]
        A = np.zeros((1, 2), dtype=np.int64)  # round trip inside the day: in $10M, out $10M + $1,100
        ev = [10**13, -(10**13 + 1_100 * 10**6)]
        g = G.gate_pairs(A, np.ones_like(A, dtype=bool), blocks, [0, 0], [120, 180], ev)
        self.assertFalse(g["pass"][0])                 # registered rule: tolerance $10 on zero anchors
        self.assertEqual(int(g["peak"][0]), 10**13)
        self.assertEqual(int(g["tol_d2"][0]), 10**10)  # D2: 0.1% of the $10M intraday peak
        self.assertTrue(g["pass_d2"][0])

    def test_d2_peak_per_pair_and_order(self):
        blocks = [100, 200, 300]
        A = np.array([[5 * 10**12, 0, 0], [0, 0, 0]], dtype=np.int64)
        # address 0: pair 0 withdraws all; pair 1 a round trip that peaks at $20M; address 1: in then out
        ev_addr = [0, 1, 0, 0, 1]
        ev_block = [150, 160, 210, 220, 170]
        ev = [-5 * 10**12, 3 * 10**12, 2 * 10**13, -(2 * 10**13 + 15_000 * 10**6), -3 * 10**12]
        g = G.gate_pairs(A, np.ones_like(A, dtype=bool), blocks, ev_addr, ev_block, ev)
        by = {(int(a), int(p)): i for i, (a, p) in enumerate(zip(g["addr"], g["p"]))}
        self.assertEqual(int(g["peak"][by[(0, 0)]]), 5 * 10**12)
        self.assertEqual(int(g["peak"][by[(0, 1)]]), 2 * 10**13)
        self.assertEqual(int(g["peak"][by[(1, 0)]]), 3 * 10**12)
        self.assertFalse(g["pass"][by[(0, 1)]])
        self.assertTrue(g["pass_d2"][by[(0, 1)]])
        self.assertTrue(all(g["pass_d2"][g["pass"]]))  # D2 never fails a pair the registered rule passes
        s = G.gate_summary(g, "pass_d2")
        self.assertEqual(s["n_pass"], s["n_pairs"])

    def test_interest_diagnostic(self):
        blocks = [100, 200]
        A = np.array([[10**12, 10**12 + 10**9]], dtype=np.int64)  # +0.1% with no event
        g = G.gate_pairs(A, np.ones_like(A, dtype=bool), blocks, [], [], [], ev_scaled=[], income=[1.0, 1.001])
        self.assertLess(abs(g["res_interest"][0]), 1.0)

    def test_normalized_income(self):
        li = 105 * RAY // 100
        rate = 5 * RAY // 100
        self.assertEqual(G.normalized_income(li, rate, 1000, 1000), li)
        got = G.normalized_income(li, rate, 0, G.SECONDS_PER_YEAR)
        self.assertEqual(got, G.ray_mul(RAY + rate, li))


class TestUnitsAndHoldouts(unittest.TestCase):
    def test_units(self):
        self.assertEqual(G.to_units(123_456_789, 6), 123_456_789)
        self.assertEqual(G.to_units(1_234_567_890_123_456_789, 18), 1_234_568)  # 1.23456789 tokens, rounded
        self.assertEqual(G.to_units(1_500_000_000_000, 18), 2)                   # half rounds away from zero
        self.assertEqual(G.to_units(-1_500_000_000_000, 18), -2)
        self.assertEqual(G.to_units(5, 2), 50_000)
        self.assertEqual(G.from_units(7, 18), 7 * 10**12)
        rows = [["d1", addr(1), 10**9 * 10**18, ""], ["d2", addr(1), 2 * 10**9 * 10**18, ""]]
        addrs, A, valid = G.load_anchor_matrix(rows, ["d1", "d2"], decimals=18)
        self.assertEqual(A.tolist(), [[10**15, 2 * 10**15]])   # $1B and $2B in 1e-6 units fit int64

    def test_abi_helpers(self):
        arr = (32).to_bytes(32, "big") + (2).to_bytes(32, "big") + bytes(12) + bytes.fromhex("11" * 20) + \
            bytes(12) + bytes.fromhex("22" * 20)
        self.assertEqual(G.decode_address_array(arr), ["0x" + "11" * 20, "0x" + "22" * 20])
        s = b"USDe"
        enc = (32).to_bytes(32, "big") + len(s).to_bytes(32, "big") + s + bytes(32 - len(s))
        self.assertEqual(G.decode_symbol(True, enc), "USDe")
        self.assertEqual(G.decode_symbol(True, b"MKR" + bytes(29)), "MKR")
        self.assertEqual(G.decode_symbol(False, b""), "")

    def test_peg_and_selection(self):
        self.assertTrue(G.peg_ok([1.0, 0.999, 1.004]))
        self.assertFalse(G.peg_ok([1.0, None]))
        self.assertFalse(G.peg_ok([1.0, 1.05]))   # yield-bearing share drifting above $1
        self.assertFalse(G.peg_ok([]))
        asof_ts = 1_800_000_000
        base = {"price_asof_usd": 1.0, "monthly_prices": [1.0] * 12, "supply_usd": 6e7, "listing_ts": asof_ts - 400 * 86400}
        cands = [dict(base, asset="0xa"), dict(base, asset="0xb", supply_usd=4e7),
                 dict(base, asset="0xc", listing_ts=asof_ts - 300 * 86400), dict(base, asset="0xd", monthly_prices=[1.0, 0.97]),
                 dict(base, asset="0xusdc"), dict(base, asset="0xe", price_asof_usd=1.21)]
        out = {c["asset"]: c for c in G.select_holdouts(cands, asof_ts, {"0xusdc"})}
        self.assertEqual([a for a, c in out.items() if c["selected"]], ["0xa"])
        self.assertIn("supply", out["0xb"]["reason"])
        self.assertIn("365", out["0xc"]["reason"])
        self.assertIn("pegged", out["0xd"]["reason"])
        self.assertIn("USDC", out["0xusdc"]["reason"])
        self.assertEqual(G.safe_name("USD₮0"), "USD_0")


class TestMaxima(unittest.TestCase):
    def test_balance_maxima(self):
        d = G.Decoded()
        a, b = d.aid(addr(1)), d.aid(addr(2))
        idx = [RAY, RAY, RAY * 11 // 10, RAY * 12 // 10]
        rows = [  # (addr, block, log, sub, scaled, index)
            (a, 10, 0, 0, 2 * 10**12, idx[0]),    # $2M in
            (a, 10, 1, 0, -2 * 10**12, idx[1]),   # out in the same tx: intra-tx peak $2M
            (b, 20, 0, 0, 9 * 10**11, idx[2]),    # $0.99M at index 1.1
        ]
        d.addr = np.array([r[0] for r in rows])
        d.block = np.array([r[1] for r in rows])
        d.log_index = np.array([r[2] for r in rows])
        d.sub = np.array([r[3] for r in rows])
        d.scaled = np.array([r[4] for r in rows], dtype=np.int64)
        d.index = np.array([r[5] for r in rows], dtype=object)
        d.index_f = np.array([r[5] / RAY for r in rows])
        best, blk, final = G.balance_maxima(d, 100, idx[3])
        self.assertAlmostEqual(best[a], 2e12, delta=2)
        self.assertEqual(int(blk[a]), 10)
        self.assertAlmostEqual(best[b], 9e11 * 1.2, delta=2)   # grows with the index to asof: $1.08M
        self.assertEqual(int(blk[b]), 100)
        self.assertEqual(final.tolist(), [0, 9 * 10**11])


class TestAnchorsAndWrite(unittest.TestCase):
    def test_load_anchor_matrix_rows(self):
        rows = [["d1", addr(1), 5, ""], ["d2", addr(1), "", "fail"], ["d1", addr(2), 0, ""], ["asof", addr(2), 9, ""]]
        addrs, A, valid = G.load_anchor_matrix(rows, ["d1", "d2"])
        self.assertEqual(addrs, [addr(1), addr(2)])
        self.assertEqual(A.tolist(), [[5, 0], [0, 0]])
        self.assertEqual(valid.tolist(), [[True, False], [True, False]])

    def test_write_partitioned_refines(self):
        old = G.OUT_FILE_MAX_BYTES
        try:
            G.OUT_FILE_MAX_BYTES = 120_000
            rng = random.Random(1)
            rows = [[1_672_531_200 + i * 3_000, "%064x" % rng.getrandbits(256)] for i in range(12_000)]
            with tempfile.TemporaryDirectory() as d:
                names = G.write_partitioned(Path(d), "x", ["ts", "h"], lambda: iter(rows), lambda r: r[0])
                self.assertTrue(all("q" in n or "-" in n[2:] for n in names))
                back = []
                for n in sorted(names):
                    with gzip.open(Path(d) / n, "rt") as f:
                        back += [line.rstrip("\n").split(",") for line in list(f)[1:]]
                self.assertEqual(len(back), len(rows))
                self.assertEqual(sorted(p.name for p in Path(d).iterdir()), sorted(names))
                for n in names:
                    self.assertLessEqual((Path(d) / n).stat().st_size, G.OUT_FILE_MAX_BYTES)
        finally:
            G.OUT_FILE_MAX_BYTES = old

    def test_find_deploy_block(self):
        self.assertEqual(G.find_deploy_block(lambda b: b >= 777, 0, 10_000), 777)
        with self.assertRaises(G.B.TerminalError):
            G.find_deploy_block(lambda b: True, 0, 10)


if __name__ == "__main__":
    unittest.main()
