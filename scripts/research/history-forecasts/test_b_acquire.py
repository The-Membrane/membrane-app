"""Unit tests for b_acquire.py: keccak, ABI encode/decode, block search, chunking, resume.

Run: python3 -m unittest scripts/research/history-forecasts/test_b_acquire.py
"""

import hashlib
import json
import random
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import b_acquire as B  # noqa: E402


# ---------------------------------------------------------------------------------------------
# helpers: the inverse encoders a node would produce
# ---------------------------------------------------------------------------------------------


def w(n):
    return n.to_bytes(32, "big")


def encode_result(results):
    """ABI-encode Result[] = (bool, bytes)[] as returned by aggregate3."""
    tails = []
    for ok, data in results:
        pad = (-len(data)) % 32
        tails.append(w(1 if ok else 0) + w(64) + w(len(data)) + data + b"\x00" * pad)
    offs, off = [], 32 * len(results)
    for t in tails:
        offs.append(off)
        off += len(t)
    return w(32) + w(len(results)) + b"".join(w(o) for o in offs) + b"".join(tails)


def decode_calldata(data):
    """Inverse of encode_aggregate3: returns [(target, allowFailure, callData)]."""
    assert data[:4] == B.SEL["aggregate3"]
    body = data[4:]
    g = lambda p: int.from_bytes(body[p:p + 32], "big")  # noqa: E731
    arr = g(0)
    n = g(arr)
    base = arr + 32
    out = []
    for i in range(n):
        t = base + g(base + 32 * i)
        target = "0x" + body[t + 12:t + 32].hex()
        allow = g(t + 32)
        d = t + g(t + 64)
        ln = g(d)
        out.append((target, allow, body[d + 32:d + 32 + ln]))
    return out


class FakeChain:
    """Answers eth_call(aggregate3) and eth_getBlockByNumber for a synthetic chain."""

    def __init__(self, unlisted_usdt_before=0):
        self.unlisted_usdt_before = unlisted_usdt_before
        self.vdt = {"USDC": "0x" + "11" * 20, "USDT": "0x" + "22" * 20}
        self.strat_v1 = "0x" + "33" * 20
        self.strat_v2 = "0x" + "44" * 20

    @staticmethod
    def balance(addr, block):
        h = int(hashlib.sha256(f"{addr}{block}".encode()).hexdigest(), 16)
        return 0 if h % 3 == 0 else h % (5 * 10**12)

    def strategy(self, block):
        return self.strat_v1 if block < 1500 else self.strat_v2

    def sub(self, block, target, data):
        sel, args = data[:4], data[4:]
        target = target.lower()
        res = {B.norm_address(v["asset"]): r for r, v in B.RESERVES.items()}
        atok = {B.norm_address(v["atoken"]): r for r, v in B.RESERVES.items()}
        if target == B.norm_address(B.POOL) and sel == B.SEL["getReserveData"]:
            r = res["0x" + args[12:32].hex()]
            if r == "USDT" and block < self.unlisted_usdt_before:
                return True, b"\x00" * 480
            words = [0] * 15
            words[0] = (1000 << 64) | (1 << 63) | (0xFFFF << 80)
            words[2] = 3 * 10**25 + block
            words[4] = 4 * 10**25 + block
            words[6] = 1_700_000_000 + block
            words[8] = int(B.RESERVES[r]["atoken"], 16)
            words[10] = int(self.vdt[r], 16)
            words[11] = int(self.strategy(block), 16)
            return True, b"".join(w(x) for x in words)
        if target in atok and sel == B.SEL["balanceOf"]:
            if atok[target] == "USDT" and block < self.unlisted_usdt_before:
                return True, b""  # no code yet
            return True, w(self.balance("0x" + args[12:32].hex(), block))
        if target in atok and sel == B.SEL["totalSupply"]:
            return True, w(10**15 + block)
        if target in res and sel == B.SEL["balanceOf"]:
            return True, w(10**14 + block)
        if target in self.vdt.values() and sel == B.SEL["totalSupply"]:
            return True, w(9 * 10**14 + block)
        if target == self.strat_v1 and sel in [B.SEL[n] for n in B.V1_CURVE]:
            i = [B.SEL[n] for n in B.V1_CURVE].index(sel)
            return True, w([9 * 10**26, 0, 4 * 10**25, 6 * 10**26][i])
        if target == self.strat_v2 and sel == B.SEL["getInterestRateData"]:
            return True, w(94 * 10**25) + w(0) + w(44 * 10**24) + w(10**26)
        return False, b""


class FakeRpc(B.Rpc):
    def __init__(self, chain, fail_after=None):
        super().__init__("fake://", None, interval=0.0, retry_wait=0, sleep=lambda s: None)
        self.chain = chain
        self.fail_after = fail_after
        self.n_calls = 0

    def call(self, method, params, phase, tag="", validate=None):
        with self.lock:
            self.n_calls += 1
            if self.fail_after is not None and self.n_calls > self.fail_after:
                self.stop.set()
                raise B.TerminalError("simulated stop")
            self.counts["http_requests"] += 1
        if method == "eth_call":
            block = int(params[1], 16)
            data = bytes.fromhex(params[0]["data"][2:])
            if data[:4] != B.SEL["aggregate3"]:  # direct call
                ok, ret = self.chain.sub(block, params[0]["to"], data)
                out = "0x" + ret.hex()
                if validate:
                    validate(out)
                return out
            calls = decode_calldata(data)
            out = "0x" + encode_result([self.chain.sub(block, t, d) for t, _, d in calls]).hex()
            if validate:
                validate(out)
            return out
        raise NotImplementedError(method)


# ---------------------------------------------------------------------------------------------
# tests
# ---------------------------------------------------------------------------------------------


class TestKeccak(unittest.TestCase):
    def test_vectors(self):
        self.assertEqual(B.keccak256(b"").hex(), "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470")
        self.assertEqual(B.keccak256(b"abc").hex(), "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45")

    def test_known_selectors(self):
        self.assertEqual(B.SEL["balanceOf"].hex(), "70a08231")
        self.assertEqual(B.SEL["totalSupply"].hex(), "18160ddd")
        self.assertEqual(B.SEL["decimals"].hex(), "313ce567")
        self.assertEqual(B.SEL["aggregate3"].hex(), "82ad56cb")
        self.assertEqual(B.SEL["getReserveData"].hex(), "35ea6a75")
        self.assertEqual(B.selector("transfer(address,uint256)").hex(), "a9059cbb")

    def test_permutation_multiblock_against_nist_sha3(self):
        # Same sponge with the SHA3 domain byte (0x06) must equal hashlib.sha3_256 at every
        # length around the 136-byte rate boundary: this checks permutation and absorption.
        def sha3_with_same_sponge(data):
            rate = 136
            msg = bytearray(data) + b"\x06"
            while len(msg) % rate:
                msg += b"\x00"
            msg[-1] |= 0x80
            a = [[0] * 5 for _ in range(5)]
            for off in range(0, len(msg), rate):
                blk = msg[off:off + rate]
                for i in range(rate // 8):
                    a[i % 5][i // 5] ^= int.from_bytes(blk[8 * i:8 * i + 8], "little")
                a = B._keccak_f1600(a)
            return b"".join(a[i % 5][i // 5].to_bytes(8, "little") for i in range(4))

        for n in (0, 1, 55, 135, 136, 137, 271, 272, 273, 500):
            data = bytes((i * 7 + 3) % 256 for i in range(n))
            self.assertEqual(sha3_with_same_sponge(data), hashlib.sha3_256(data).digest(), n)


class TestAbi(unittest.TestCase):
    def test_aggregate3_roundtrip(self):
        calls = [(B.RESERVES["USDC"]["atoken"], B.call_data("balanceOf", "0x" + "ab" * 20)),
                 (B.POOL, B.call_data("getReserveData", B.RESERVES["USDT"]["asset"])),
                 (B.MULTICALL3, b"\x01\x02\x03")]  # non-multiple-of-32 data
        enc = B.encode_aggregate3(calls)
        dec = decode_calldata(enc)
        self.assertEqual(len(dec), 3)
        for (t, d), (t2, allow, d2) in zip(calls, dec):
            self.assertEqual(B.norm_address(t), t2)
            self.assertEqual(allow, 1)
            self.assertEqual(d, d2)
        self.assertEqual(len(enc[4:]) % 32, 0)

    def test_aggregate3_single_call_exact_bytes(self):
        enc = B.encode_aggregate3([("0x" + "00" * 19 + "01", b"\xaa\xbb\xcc\xdd")]).hex()
        expect = ("82ad56cb"
                  + w(32).hex() + w(1).hex() + w(32).hex()          # array offset, length, offset of tuple 0
                  + w(1).hex() + w(1).hex() + w(96).hex()            # target, allowFailure, bytes offset
                  + w(4).hex() + "aabbccdd" + "00" * 28)             # bytes length + padded data
        self.assertEqual(enc, expect)

    def test_result_decode(self):
        res = [(True, w(123)), (False, b""), (True, b""), (True, b"\x01" * 40)]
        raw = encode_result(res)
        self.assertEqual(B.decode_aggregate3_result(raw, 4), res)
        with self.assertRaises(B.DecodeError):
            B.decode_aggregate3_result(raw, 5)
        with self.assertRaises(B.DecodeError):
            B.decode_aggregate3_result(raw[:-40], 4)

    def test_balance_entry(self):
        self.assertEqual(B.balance_entry(True, w(7)), 7)
        self.assertEqual(B.balance_entry(False, b""), "fail")
        self.assertEqual(B.balance_entry(True, b""), "empty")
        self.assertEqual(B.balance_entry(True, b"\x00" * 31), "badlen:31")

    def test_reserve_factor_bits(self):
        cfg = (1 << 63) | (1234 << 64) | (0xFFFF << 80) | 0xDEADBEEF
        self.assertEqual(B.reserve_factor_bps(cfg), 1234)
        self.assertEqual(B.reserve_factor_bps(0), 0)

    def test_decode_reserve_data(self):
        chain = FakeChain()
        ok, ret = chain.sub(2000, B.POOL, B.call_data("getReserveData", B.RESERVES["USDC"]["asset"]))
        rd = B.decode_reserve_data(ok, ret)
        self.assertEqual(rd["status"], "ok")
        self.assertTrue(rd["listed"])
        self.assertEqual(rd["aTokenAddress"], B.norm_address(B.RESERVES["USDC"]["atoken"]))
        self.assertEqual(rd["interestRateStrategyAddress"], chain.strat_v2)
        self.assertEqual(B.reserve_factor_bps(rd["configuration"]), 1000)
        self.assertEqual(B.decode_reserve_data(True, b"\x00" * 480)["listed"], False)
        self.assertEqual(B.decode_reserve_data(True, b"\x00" * 512)["status"], "words:16")
        self.assertEqual(B.decode_reserve_data(False, b"")["status"], "fail")

    def test_decode_curve(self):
        v1 = [(True, w(x).hex()) for x in (9 * 10**26, 0, 4 * 10**25, 6 * 10**26)]
        v1_fail = [(False, "")] * 4
        v2 = (True, (w(94 * 10**25) + w(0) + w(44 * 10**24) + w(10**26)).hex())
        self.assertEqual(B.decode_curve(v1, (False, ""))["abi"], "v1")
        c = B.decode_curve(v1_fail, v2)
        self.assertEqual(c["abi"], "v2")
        self.assertEqual(c["main"], [94 * 10**25, 0, 44 * 10**24, 10**26])
        self.assertEqual(B.decode_curve(v1_fail, (False, ""))["abi"], "none")
        self.assertEqual(B.decode_curve(v1_fail, (True, ""))["abi"], "none")
        self.assertEqual(B.decode_curve(v1, v2)["abi"], "both")


class TestBlockSearch(unittest.TestCase):
    def make_chain(self, n, seed, post_merge=True):
        rng = random.Random(seed)
        ts, t = [], 1_600_000_011
        for _ in range(n):
            ts.append(t)
            if post_merge:
                t += 12 * (1 if rng.random() < 0.97 else rng.choice((2, 3)))
            else:
                t += rng.randint(1, 30)
        return ts

    def brute(self, ts, T):
        return max(b for b, x in enumerate(ts) if x < T)

    def check(self, ts, Ts, guess_err, seed=0):
        rng = random.Random(seed)
        fetches = []
        for T in Ts:
            calls = []
            get = lambda b: (calls.append(b), ts[b])[1]  # noqa: E731
            ans = self.brute(ts, T)
            guess = max(0, min(len(ts) - 1, ans + rng.randint(-guess_err, guess_err)))
            b, bts, nts = B.find_block_before(T, get, guess, head=len(ts) - 1)
            self.assertEqual(b, ans)
            self.assertTrue(bts < T <= nts)
            self.assertEqual((bts, nts), (ts[b], ts[b + 1]))
            fetches.append(len(set(calls)))
        return fetches

    def test_post_merge_good_guess(self):
        ts = self.make_chain(20000, 1)
        Ts = [ts[0] + 86400 * k for k in range(1, 2)] + random.Random(2).sample(range(ts[10] + 1, ts[-10]), 300)
        f = self.check(ts, Ts, guess_err=15)
        self.assertLessEqual(sum(f) / len(f), 4.5)

    def test_post_merge_bad_guess(self):
        ts = self.make_chain(20000, 3)
        Ts = random.Random(4).sample(range(ts[10] + 1, ts[-10]), 100)
        self.check(ts, Ts, guess_err=8000)

    def test_irregular_gaps(self):
        ts = self.make_chain(5000, 5, post_merge=False)
        Ts = random.Random(6).sample(range(ts[10] + 1, ts[-10]), 200)
        self.check(ts, Ts, guess_err=500)

    def test_T_equal_block_ts(self):
        ts = self.make_chain(3000, 7)
        for b in (100, 1500, 2900):
            got, bts, nts = B.find_block_before(ts[b], lambda x: ts[x], b + 3, head=len(ts) - 1)
            self.assertEqual(got, b - 1)
            self.assertEqual(nts, ts[b])

    def test_with_lo_seed(self):
        ts = self.make_chain(30000, 8)
        T = ts[20000] + 5
        b, _, _ = B.find_block_before(T, lambda x: ts[x], 19990, lo=12000, head=len(ts) - 1)
        self.assertEqual(b, 20000)
        with self.assertRaises(B.BlockSearchError):
            B.find_block_before(ts[100], lambda x: ts[x], 50, lo=200)

    def test_dates(self):
        d = B.daily_dates()
        self.assertEqual((d[0].isoformat(), d[-1].isoformat(), len(d)), ("2023-02-01", "2026-10-07", 1345))
        m = B.monthly_dates()
        self.assertEqual((m[0].isoformat(), m[-1].isoformat(), len(m)), ("2023-02-01", "2026-10-01", 45))
        self.assertEqual(B.utc_ts(d[0]), 1675209600)


class TestChunking(unittest.TestCase):
    def test_chunk(self):
        x = list(range(2501))
        c = B.chunk(x)
        self.assertEqual([len(i) for i in c], [1000, 1000, 501])
        self.assertEqual(sum(c, []), x)

    def test_daily_layout(self):
        spans, dep = B.daily_layout(6, 5010)
        self.assertEqual(spans[-1], (5000, 5016))
        self.assertEqual(dep, 5)
        spans, dep = B.daily_layout(6, 994)  # exactly one full chunk
        self.assertEqual((spans, dep), ([(0, 1000)], 1))
        spans, dep = B.daily_layout(6, 1984)  # last chunk 990 -> no room for 12
        self.assertEqual((len(spans), dep), (2, 2))
        spans, dep = B.daily_layout(6, 1982)  # last chunk 988 -> room
        self.assertEqual((len(spans), dep), (2, 1))
        for s, e in spans:
            self.assertLessEqual(e - s, 1000)


class TestStoreAndResume(unittest.TestCase):
    def test_torn_line(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "s.jsonl"
            st = B.JsonlStore(p)
            st.put(("a", 1), {"v": [1, 2]})
            with open(p, "a") as f:
                f.write('{"k": ["a", 2], "v": [3')  # crash mid-write
            st2 = B.JsonlStore(p)
            self.assertTrue(st2.has(("a", 1)))
            self.assertFalse(st2.has(("a", 2)))
            st2.put(("a", 2), {"v": [3]})
            self.assertEqual(B.JsonlStore(p).get(("a", 2))["v"], [3])

    def _ctx(self, d, rpc):
        ctx = B.Ctx(Path(d) / "work", Path(d) / "out", rpc, workers=4)
        for i, day in enumerate(B.daily_dates()):
            if not ctx.blocks.has(day.isoformat()):
                ctx.blocks.put(day.isoformat(), {"T": B.utc_ts(day), "block": 1000 + i, "block_ts": B.utc_ts(day) - 1,
                                                 "next_ts": B.utc_ts(day) + 11})
        ctx.state["asof"] = {"block": 5000, "ts": 1_791_000_000, "hash": "0x00"}
        return ctx

    def test_monthly_resume(self):
        chain = FakeChain()
        rng = random.Random(1)
        U = {r: sorted({"0x" + "%040x" % rng.getrandbits(160) for _ in range(n)}) for r, n in (("USDC", 2100), ("USDT", 1000))}
        n_tasks = 45 * (3 + 1)
        with tempfile.TemporaryDirectory() as d:
            rpc1 = FakeRpc(chain, fail_after=37)
            ctx1 = self._ctx(d, rpc1)
            with self.assertRaises(B.TerminalError):
                B.phase_monthly(ctx1, U)
            done1 = len(B.JsonlStore(Path(d) / "work" / "monthly.jsonl").data)
            self.assertGreater(done1, 0)
            self.assertLess(done1, n_tasks)
            rpc2 = FakeRpc(chain)
            ctx2 = self._ctx(d, rpc2)
            B.phase_monthly(ctx2, U)
            self.assertEqual(rpc2.n_calls, n_tasks - done1)  # nothing redone
            rows = list(B.monthly_table(ctx2, U))
            self.assertEqual(len(rows), 45 * 3100)
            for label, block, r, a, v in rows[::97]:
                self.assertEqual(v, chain.balance(a, block))

    def test_daily_resume_and_assembly(self):
        chain = FakeChain(unlisted_usdt_before=1010)
        rng = random.Random(2)
        pop = {}
        for r, n in (("USDC", 700), ("USDT", 500)):
            addrs = sorted({"0x" + "%040x" % rng.getrandbits(160) for _ in range(n)})
            pop[r] = {"rows": [[a, "balance", None] for a in addrs]}
        with tempfile.TemporaryDirectory() as d:
            rpc1 = FakeRpc(chain, fail_after=101)
            ctx1 = self._ctx(d, rpc1)
            with self.assertRaises(B.TerminalError):
                B.phase_daily(ctx1, pop)
            done1 = len(B.JsonlStore(Path(d) / "work" / "daily.jsonl").data)
            rpc2 = FakeRpc(chain)
            ctx2 = self._ctx(d, rpc2)
            B.phase_daily(ctx2, pop)
            n_snap = len(B.daily_dates()) + 1
            self.assertEqual(done1 + rpc2.n_calls, n_snap * 2)  # 1206 + 12 calls -> 2 chunks per block
            recs = B.daily_records(ctx2, pop)
            self.assertEqual(len(recs), n_snap)
            rows = B.reserve_state_rows(ctx2, recs)
            by = {(x["snapshot"], x["reserve"]): x for x in rows}
            first = B.daily_dates()[0].isoformat()
            late = B.daily_dates()[600].isoformat()
            self.assertEqual(by[(first, "USDT")]["listed"], 0)
            self.assertEqual(by[(first, "USDT")]["curve_abi"], "not_listed")
            self.assertEqual(recs[first]["bal"][("USDT", pop["USDT"]["rows"][0][0])], "empty")
            self.assertEqual(by[(first, "USDC")]["curve_abi"], "v1")
            self.assertEqual(by[(first, "USDC")]["slope1"], 4 * 10**25)
            self.assertEqual(by[(late, "USDC")]["curve_abi"], "v2")
            self.assertEqual(by[(late, "USDC")]["optimal"], 94 * 10**25)
            self.assertEqual(by[(late, "USDC")]["RF_bps"], 1000)
            blk = recs[late]["block"]
            self.assertEqual(by[(late, "USDT")]["variableDebt"], 9 * 10**14 + blk)
            self.assertEqual(by[(late, "USDT")]["cash"], 10**14 + blk)
            self.assertEqual(by[(late, "USDT")]["totalSupply"], 10**15 + blk)
            a = pop["USDC"]["rows"][123][0]
            self.assertEqual(recs[late]["bal"][("USDC", a)], chain.balance(a, blk))
            self.assertEqual(by[("asof", "USDC")]["block"], 5000)


class TestEndToEndWrite(unittest.TestCase):
    def test_population_validate_write(self):
        import pandas as pd
        rng = random.Random(3)
        U = {r: sorted({"0x" + "%040x" % rng.getrandbits(160) for _ in range(60)}) for r in B.RESERVE_ORDER}
        big = set(U["USDC"][10:15]) | set(U["USDT"][20:23])

        class SelChain(FakeChain):
            def balance(self, addr, block):  # only `big` addresses ever reach $1M, and only at some blocks
                v = FakeChain.balance(addr, block)
                return v % (10**12 - 1) if addr not in big or block % 2 else 10**12 + v

        chain = SelChain(unlisted_usdt_before=1010)
        flows = pd.DataFrame([
            {"event_type": "supply", "reserve": "USDC", "user_id": U["USDC"][0], "amount_usd": 1_000_000.0},
            {"event_type": "supply", "reserve": "USDC", "user_id": U["USDC"][1], "amount_usd": 999_999.99},
            {"event_type": "withdraw", "reserve": "USDT", "user_id": U["USDT"][2], "amount_usd": 5_000_000.0},
        ])
        with tempfile.TemporaryDirectory() as d:
            rpc = FakeRpc(chain)
            ctx = TestStoreAndResume._ctx(None, d, rpc)
            ctx._U = U
            B.phase_monthly(ctx, U)
            pop = B.phase_population(ctx, U, flows)
            exp_bal = {r: {a for (_, blk, rr, a, v) in B.monthly_table(ctx, U) if rr == r and isinstance(v, int)
                           and v >= B.THRESHOLD_RAW} for r in B.RESERVE_ORDER}
            got = {r: {row[0] for row in pop[r]["rows"]} for r in B.RESERVE_ORDER}
            self.assertEqual(exp_bal["USDC"], set(U["USDC"][10:15]))
            self.assertEqual(got["USDC"], exp_bal["USDC"] | {U["USDC"][0]})  # $999,999.99 does not qualify
            self.assertEqual(got["USDT"], exp_bal["USDT"])  # withdraw events never qualify
            self.assertEqual(pop["USDC"]["n_event_only"], 1)
            B.phase_daily(ctx, pop)
            recs = B.daily_records(ctx, pop)
            rs_rows = B.reserve_state_rows(ctx, recs)
            ddir = Path(d) / "ds"
            (ddir / "rate-spike-flows").mkdir(parents=True)
            hist = ["date,datetime_utc,symbol,total_liquidity_raw,total_debt_raw,utilization_pct,liquidity_rate_pct,variable_borrow_pct"]
            for i, day in enumerate(B.daily_dates()[1:30]):
                prev = (day - B.dt.timedelta(days=1)).isoformat()
                hist.append(f"{prev},{prev} 23:00:00,USDC,{(10**15 + 1000 + i + 1) / 1e6 * 1.001},0,0,0,0")
            (ddir / B.RESERVE_HISTORY_REL).write_text("\n".join(hist) + "\n")
            val = B.phase_validate(ctx, pop, recs, rs_rows, ddir)
            self.assertEqual(val["a"]["n"], 20)
            self.assertEqual(val["a"]["n_equal"], 20)
            self.assertEqual(val["b"]["USDC"]["n_days"], 29)
            self.assertAlmostEqual(val["b"]["USDC"]["median_abs_rel_diff"], 0.001 / 1.001, places=6)
            self.assertGreater(val["d"]["USDT"]["by_curve_abi"]["not_listed"], 0)
            ctx.state["sessions"] = [{"start_utc": "x", "end_utc": "y", "code": {"sha": "abc", "branch": "b", "path": "p"},
                                      "counts": rpc.counts}]
            meta = B.build_run_meta(ctx, ctx.work)
            files = B.phase_write(ctx, U, pop, recs, rs_rows, val, meta)
            md = B.provenance_md(meta, files, val, pop)
            self.assertIn("daily-balances-usdc.csv.gz", md)
            for name in ("blocks.csv", "monthly-balances-usdc.csv.gz", "monthly-balances-usdt.csv.gz", "panel-population.csv",
                         "daily-balances-usdc.csv.gz", "daily-balances-usdt.csv.gz", "reserve-state.csv", "run-log.json"):
                self.assertIn(name, files)
            dbal = pd.read_csv(Path(d) / "out" / "daily-balances-usdc.csv.gz", dtype={"balance_raw": "Int64"})
            self.assertEqual(len(dbal), len(pop["USDC"]["rows"]) * (len(B.daily_dates()) + 1))
            row = dbal.iloc[5]
            blk = recs[row["snapshot"]]["block"]
            self.assertEqual(int(row["balance_raw"]), chain.balance(row["address"], blk))
            mb = pd.read_csv(Path(d) / "out" / "monthly-balances-usdt.csv.gz")
            self.assertTrue((mb["status"] == "empty").any() or (mb["balance_raw"].notna()).all())
            rsdf = pd.read_csv(Path(d) / "out" / "reserve-state.csv")
            self.assertEqual(len(rsdf), 2 * (len(B.daily_dates()) + 1))
            bl = pd.read_csv(Path(d) / "out" / "blocks.csv")
            self.assertTrue((bl.loc[bl["kind"] == "daily", "proof"] == "ok").all())


class TestRpcPolicy(unittest.TestCase):
    def test_retry_then_success_and_stop(self):
        sleeps = []
        rpc = B.Rpc("fake://", None, interval=0.0, retry_wait=30, sleep=sleeps.append)
        seq = [B.RateLimited("HTTP 429"), B.Transient("timeout"), {"jsonrpc": "2.0", "id": 1, "result": "0x1"}]

        def post(payload, it=iter(seq)):
            x = next(it)
            if isinstance(x, Exception):
                raise x
            return x
        rpc._post = post
        pauses = []
        rpc.pacer.pause = pauses.append  # the global 30 s pause on rate limit (real time otherwise)
        self.assertEqual(rpc.call("eth_blockNumber", [], "t"), "0x1")
        self.assertEqual(sleeps, [30, 30])
        self.assertEqual(pauses, [30])  # only the rate-limit retry pauses every worker
        self.assertEqual((rpc.counts["retries"], rpc.counts["rate_limit_retries"], rpc.counts["http_requests"]), (2, 1, 3))

        sleeps.clear()
        rpc2 = B.Rpc("fake://", None, interval=0.0, retry_wait=30, sleep=sleeps.append)
        payloads = []

        def always429(payload):
            payloads.append(payload)
            raise B.RateLimited("HTTP 429")
        rpc2._post = always429
        rpc2.pacer.pause = lambda sec: None
        with self.assertRaises(B.TerminalError):
            rpc2.call("eth_call", [], "t")
        self.assertEqual(len(sleeps), 5)
        self.assertEqual(len(payloads), 6)
        self.assertEqual(len(set(payloads)), 1)  # the same request each time
        self.assertTrue(rpc2.stop.is_set())

    def test_rpc_error_classes(self):
        self.assertIs(B.classify_rpc_error({"code": 429, "message": "x"}), B.RateLimited)
        self.assertIs(B.classify_rpc_error({"code": -32000, "message": "Too many requests"}), B.RateLimited)
        self.assertIs(B.classify_rpc_error({"code": -32000, "message": "execution reverted"}), B.Fatal)
        self.assertIs(B.classify_rpc_error({"code": -32000, "message": "request timed out"}), B.Transient)
        self.assertIs(B.classify_rpc_error({"code": -32602, "message": "invalid argument"}), B.Fatal)

    def test_pacer(self):
        p = B.Pacer(0.02)
        t0 = time.monotonic()
        ths = [threading.Thread(target=lambda: [p.wait() for _ in range(3)]) for _ in range(4)]
        [t.start() for t in ths]
        [t.join() for t in ths]
        self.assertGreaterEqual(time.monotonic() - t0, 0.02 * 11 - 0.005)


if __name__ == "__main__":
    unittest.main()
