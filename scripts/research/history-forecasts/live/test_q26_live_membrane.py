#!/usr/bin/env python3
"""Tests for the D10 fifth deep target, Membrane's oracle (q26_live_membrane.py; HISTORY_TOUCH_LIVE.md D10).

  python3 -m unittest scripts/research/history-forecasts/live/test_q26_live_membrane.py -v

Synthetic only: no network, no dataset.
"""
import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import json  # noqa: E402
import sys  # noqa: E402
import tempfile  # noqa: E402
import unittest  # noqa: E402
import warnings  # noqa: E402
from unittest import mock  # noqa: E402

import numpy as np  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))
import q26_live_common as C  # noqa: E402
import q26_live_deep as QD  # noqa: E402
import q26_live_membrane as QM  # noqa: E402
import r128_oracle as R128  # noqa: E402
import test_q26_live_deep as TD  # noqa: E402

warnings.filterwarnings("ignore")
U = C.A.utc
H = C.HOUR
ETH_TICK = 200000            # WETH/USDC-style pool (USDC token0, 6 dec; WETH token1, 18 dec): about 2,061 USDC per WETH


def eth_price(tick):
    return float(QM.hop_price(tick, False, 6, 18))


class TestArithmetic(unittest.TestCase):
    def test_mean_tick_matches_solidity_rule(self):
        for d in (0, 1, 3599, 3600, 7_200_001, -1, -3599, -3600, -3601, -720_000_000, -720_000_001):
            self.assertEqual(QM.mean_tick(d), R128.mean_tick_floor(d, 3600), d)

    def test_median(self):
        for v in ([3.0], [1.0, 2.0], [5.0, 1.0, 3.0], [4.0, 1.0, 3.0, 2.0], [1.0, float("nan"), 3.0]):
            self.assertEqual(QM.median_solidity(v), R128.median_solidity([x for x in v if x == x]))

    def test_pool_ticks_vs_r128(self):
        rng = np.random.default_rng(5)
        t0 = 1_700_000_000
        bts = t0 + np.cumsum(rng.integers(12, 400, 300))
        tk = rng.integers(-500, 500, 300) + 190000
        pt = QM.PoolTicks(np.concatenate([[t0], bts]), np.concatenate([[190000], tk]))
        tau = np.arange(t0 + 3600, int(bts[-1]), 97)
        mine, ok = pt.mean_tick(tau)
        self.assertTrue(ok.all())
        c1 = R128.tick_cumulative(bts, tk, 190000, t0, tau)
        c0 = R128.tick_cumulative(bts, tk, 190000, t0, tau - 3600)
        self.assertTrue(np.array_equal(mine, np.array([R128.mean_tick_floor(int(x), 3600) for x in c1 - c0])))
        _, ok = pt.mean_tick(np.array([t0 + 3599]))          # window starts before the first known tick
        self.assertFalse(ok[0])

    def test_hop_orientation_and_btc_two_hop(self):
        self.assertAlmostEqual(eth_price(ETH_TICK), 1.0001 ** -ETH_TICK * 1e12)
        # WETH/USDT pool: WETH token0 (18), USDT token1 (6): price = 1.0001^tick * 1e12
        self.assertAlmostEqual(float(QM.hop_price(-200000, True, 18, 6)), 1.0001 ** -200000 * 1e12)
        t0 = U("2026-10-19T00:00:00Z")
        pools = {k: QM.PoolTicks([t0], [0]) for k in QM.POOL_KEYS}
        pools["WBTC/WETH 0.05%"] = QM.PoolTicks([t0], [260000])        # WETH per WBTC = 1.0001^260000 * 1e-10
        pools["WETH/USDC 0.05%"] = QM.PoolTicks([t0], [ETH_TICK])
        tau = np.array([t0 + 7200])
        _, n, _, P = QM.oracle_path("BTC", pools, {"USDC": [(t0, 1.0)], "USDT": [(t0, 1.0)]}, tau)
        self.assertEqual(int(n[0]), 3)
        exp = (1.0001 ** 260000 * 1e-10) * eth_price(ETH_TICK)
        self.assertAlmostEqual(P[2, 0] / exp, 1.0, places=12)

    def test_median_drops_undefined_routes_and_quote_normalisation(self):
        t0 = U("2026-10-19T00:00:00Z")
        pools = {"WETH/USDC 0.05%": QM.PoolTicks([t0], [ETH_TICK]), "WETH/USDC 0.30%": QM.PoolTicks([t0], [ETH_TICK + 10]),
                 "WETH/USDT 0.05%": QM.PoolTicks([t0], [-ETH_TICK]), "WETH/USDT 0.30%": QM.PoolTicks([t0 + 4000], [-ETH_TICK]),
                 "DAI/WETH 0.05%": QM.PoolTicks([t0], [ETH_TICK - 276324])}   # DAI 18 dec: same USD price
        q = {"USDC": [(t0, 1.0)], "USDT": [(t0, 0.99)], "DAI": [(t0, 1.0)]}
        med, n, unp, P = QM.oracle_path("ETH", pools, q, np.array([t0 + 3600, t0 + 8000]))
        self.assertEqual(list(n), [4, 5])                                  # WETH-USDT-3000 has no window at t0 + 1 h
        self.assertAlmostEqual(P[2, 0] / eth_price(ETH_TICK), 0.99, places=9)
        fin = sorted(P[np.isfinite(P[:, 0]), 0])
        self.assertAlmostEqual(med[0], 0.5 * (fin[1] + fin[2]), places=9)     # even n: mean of the middle two
        self.assertAlmostEqual(med[1], sorted(P[:, 1])[2], places=9)
        self.assertEqual(list(unp), [0, 0])
        _, _, unp2, P2 = QM.oracle_path("ETH", pools, {"USDC": [(t0, 1.0)]}, np.array([t0 + 8000]))
        self.assertEqual(int(unp2[0]), 3)                                  # USDT x2 and DAI unpriced: raw price kept
        self.assertAlmostEqual(P2[2, 0] / eth_price(ETH_TICK), 1.0, places=9)

    def test_anchor_gate(self):
        tau = np.arange(0, 6 * 3600, 60)
        med = np.where(tau < 3600 + 600, 100.0, 89.0)                    # an 11% drop
        anchor, served, dev = QM.anchor_gate(med, tau)
        self.assertTrue(served[tau < 4200].all())
        self.assertFalse(served[(tau >= 4200) & (tau < 7200)].any())       # gated until the next allowed commit
        self.assertAlmostEqual(anchor[tau == 3600][0], 100.0)
        self.assertAlmostEqual(anchor[tau == 7200][0], 95.0)               # one 5% step per hour
        self.assertAlmostEqual(anchor[tau == 10800][0], 90.25)
        self.assertTrue(served[tau == 10800][0])                           # 89 vs 90.25: within 5% ((hi-lo)/lo)
        self.assertAlmostEqual(QM.deviation(95.0, 100.0), 5 / 95)


def write_store(ldir, tick_rows, quote_rows, cov_ts, cov_blk=10 ** 6):
    P = QM.store_paths(ldir)
    os.makedirs(os.path.dirname(P["ticks"]), exist_ok=True)
    with open(P["ticks"], "wb") as f:
        f.write(C.gz_member(QM.TICK_HEADER, [[str(v) for v in r] for r in tick_rows]))
    with open(P["quotes"], "wb") as f:
        f.write(C.gz_member(QM.QUOTE_HEADER, [[str(v) for v in r] for r in quote_rows]))
    C.append_fetch_log(P["log"], {"toBlock": cov_blk, "toBlockTimestamp": cov_ts})


def flat_store(ldir, start, cov, dip=None):
    """All pools flat at the ETH tick (USD 2,061) / BTC ticks; dip = (from, to, tick offset) on every ETH pool."""
    base = {"WETH/USDC 0.05%": ETH_TICK, "WETH/USDC 0.30%": ETH_TICK, "WETH/USDT 0.05%": -ETH_TICK,
            "WETH/USDT 0.30%": -ETH_TICK, "DAI/WETH 0.05%": ETH_TICK - 276324, "WBTC/USDC 0.30%": 60000,
            "WBTC/USDT 0.30%": 60000, "WBTC/WETH 0.05%": 260000}
    rows = [(k, 1, start, base[k], "seed") for k in QM.POOL_KEYS]
    if dip:
        a, b, off = dip
        for blk, ts, o in ((2, a, off), (3, b, 0)):
            for k in ("WETH/USDC 0.05%", "WETH/USDC 0.30%", "DAI/WETH 0.05%"):
                rows.append((k, blk, ts, base[k] + o, "swap"))
            for k in ("WETH/USDT 0.05%", "WETH/USDT 0.30%"):
                rows.append((k, blk, ts, base[k] - o, "swap"))
    rows.sort(key=lambda r: (r[1], QM.POOL_KEYS.index(r[0])))
    q = [(f, 1, start - 100, -1, "0xagg" + f.lower(), 10, 100000000, start - 100, "seed") for f in QM.QUOTE_FEEDS]
    write_store(ldir, rows, q, cov)


class TestTruth(unittest.TestCase):
    t = U("2026-10-20T00:00:00Z")

    def row(self, k=-0.15, T_h=12, asset="ETH", t=None):
        return {"origin": t or self.t, "T_h": T_h, "k": k, "asset": asset, "S": 2061.0}

    def test_dip_touch_and_flags(self):
        t = self.t
        with tempfile.TemporaryDirectory() as d:
            # a 30-minute move of +1700 ticks (price -15.6%) at t + 2 h: the 1 h geometric TWAP falls only ~8%
            flat_store(d, t - 6 * H, t + 13 * H, dip=(t + 2 * H, t + 2 * H + 1800, 1700))
            ctx = QM.build_ctx(d)
            st, i = QM.truth_membrane(ctx, self.row(-0.15))
            self.assertEqual((st, i["y"]), ("resolved", 0))
            self.assertAlmostEqual(i["min"] / i["S_o"], 1.0001 ** -850, places=6)   # half the window at -1700 ticks
            st, i = QM.truth_membrane(ctx, self.row(-0.05))
            self.assertEqual((st, i["y"]), ("resolved", 1))
            self.assertEqual((i["minRoutes"], i["routes"], i["minutesRoutesDropped"]), (5, 5, 0))
            self.assertEqual(i["nMinutes"], 12 * 60)
            self.assertGreater(i["gatedMinutes"], 0)        # the TWAP falls ~8% within an anchor hour: gated (flag only)
            self.assertFalse(i["anchorDevOverCbTrip"])
            st, i = QM.truth_membrane(ctx, self.row(-0.15, asset="BTC"))
            self.assertEqual((st, i["y"], i["routes"]), ("resolved", 0, 3))

    def test_large_dip_is_gated(self):
        t = self.t
        with tempfile.TemporaryDirectory() as d:
            flat_store(d, t - 6 * H, t + 13 * H, dip=(t + 2 * H, t + 5 * H, 2500))   # -22% for 3 h
            st, i = QM.truth_membrane(QM.build_ctx(d), self.row(-0.20))
            self.assertEqual((st, i["y"]), ("resolved", 1))
            self.assertGreater(i["gatedMinutes"], 0)
            self.assertTrue(i["anchorDevOverCbTrip"])

    def test_pending_not_applicable_unresolved(self):
        t = self.t
        with tempfile.TemporaryDirectory() as d:
            flat_store(d, t - 6 * H, t + 11 * H)
            ctx = QM.build_ctx(d)
            self.assertEqual(QM.truth_membrane(ctx, self.row())[0], "pending")
            self.assertEqual(QM.truth_membrane(ctx, self.row(t=QM.FIRST_ORIGIN - H))[0], "not_applicable")
        with tempfile.TemporaryDirectory() as d:
            flat_store(d, t - 1800, t + 13 * H)                            # store starts after t - 1 h
            self.assertEqual(QM.truth_membrane(QM.build_ctx(d), self.row())[0], "unresolved")


class FakeChain:
    """Blocks b at T0 + 12 b. eth_call: slot0, latestRoundData, aggregator, observe; eth_getLogs: swaps and answers."""

    def __init__(self, t0, head, swaps, answers):
        self.t0, self.head, self.swaps, self.answers = t0, head, swaps, answers
        self.calls = []

    def ts(self, b):
        return self.t0 + 12 * b

    @staticmethod
    def agg(proxy):
        return "0x" + proxy.lower()[2:][::-1]

    def post(self, url, body, timeout):
        reqs = json.loads(body)
        single = isinstance(reqs, dict)
        out = []
        for q in ([reqs] if single else reqs):
            m, p = q["method"], q["params"]
            self.calls.append(m)
            if m == "eth_getBlockByNumber":
                b = self.head if p[0] in ("finalized", "latest") else int(p[0], 16)
                res = {"number": hex(b), "timestamp": hex(self.ts(b))}
            elif m == "eth_call":
                to, data = p[0]["to"].lower(), p[0]["data"][2:]
                sel = data[:8]
                if sel == QM.SEL_SLOT0:
                    res = "0x" + format(1, "064x") + format(ETH_TICK % (1 << 256), "064x") + "00" * 32 * 5
                elif sel == QD.SEL_AGGREGATOR:
                    res = "0x" + "00" * 12 + self.agg(to)[2:]
                elif sel == QM.SEL_LATEST:
                    res = "0x" + format((1 << 64) | 7, "064x") + format(100000000, "064x") + format(0, "064x") + \
                          format(self.ts(self.head) - 500, "064x") + format(7, "064x")
                elif sel == QM.SEL_OBSERVE:
                    res = C.REVERTED
                else:
                    raise AssertionError(sel)
                if res is C.REVERTED:
                    out.append({"jsonrpc": "2.0", "id": q["id"], "error": {"code": 3, "message": "execution reverted"}})
                    continue
            elif m == "eth_getLogs":
                f = p[0]
                lo, hi = int(f["fromBlock"], 16), int(f["toBlock"], 16)
                res = []
                if f["topics"][0] == QM.TOPIC_SWAP:
                    for (b, li, pool, tick) in self.swaps:
                        if lo <= b <= hi:
                            data = "0x" + "00" * 32 * 4 + format(tick % (1 << 256), "064x")
                            res.append({"blockNumber": hex(b), "logIndex": hex(li), "address": pool, "removed": False,
                                        "blockTimestamp": hex(self.ts(b)), "topics": [QM.TOPIC_SWAP], "data": data})
                else:
                    for (b, li, rid, ans, proxy) in self.answers:
                        if lo <= b <= hi and self.agg(proxy) in [a.lower() for a in f["address"]]:
                            res.append({"blockNumber": hex(b), "logIndex": hex(li), "address": self.agg(proxy),
                                        "removed": False, "topics": [QD.TOPIC_ANSWER_UPDATED,
                                                                     "0x" + format(ans, "064x"), "0x" + format(rid, "064x")],
                                        "data": "0x" + format(self.ts(b), "064x")})
            else:
                raise AssertionError(m)
            out.append({"jsonrpc": "2.0", "id": q["id"], "result": res})
        return json.dumps(out[0] if single else out).encode()


class TestStore(unittest.TestCase):
    def test_bootstrap_then_append(self):
        usdc = QM.POOLS["WETH/USDC 0.05%"]["address"]
        dai = QM.POOLS["DAI/WETH 0.05%"]["address"]
        swaps = [(1001, 0, usdc, ETH_TICK + 5), (1001, 4, usdc, ETH_TICK + 9), (1002, 1, dai, 1), (900, 0, usdc, 1)]
        ch = FakeChain(U("2026-10-18T00:00:00Z"), 1000, swaps, [(1003, 2, 8, 100010000, QM.QUOTE_FEEDS["USDC"][0])])
        rpc = C.RpcClient(urls=QM.RPC_URLS, post=ch.post, sleep=lambda s: None, max_batch=QM.RPC_BATCH)
        with tempfile.TemporaryDirectory() as d:
            e = QM.update_store(rpc, d, clock=lambda: 0)
            self.assertEqual((e["mode"], e["appendedTicks"], e["appendedQuotes"]), ("bootstrap", 8, 3))
            self.assertNotIn("eth_getLogs", ch.calls)                      # no history before the bootstrap block
            ch.head = 2000
            e = QM.update_store(rpc, d, clock=lambda: 0)
            self.assertEqual((e["mode"], e["fromBlock"], e["appendedTicks"], e["appendedQuotes"]),
                             ("append", 1001, 2, 1))
            tk = QM.read_ticks(QM.store_paths(d)["ticks"])
            self.assertEqual(tk["WETH/USDC 0.05%"], [(1000, ch.ts(1000), ETH_TICK), (1001, ch.ts(1001), ETH_TICK + 9)])
            self.assertEqual(QM.coverage(d), (2000, ch.ts(2000)))
            ctx = QM.build_ctx(d)
            self.assertEqual(ctx["quoteGaps"]["USDC"], 0)                  # seed round 7, then log round 8
            self.assertEqual(ctx["quotes"]["USDC"][-1], (ch.ts(1003), 1.0001))
            self.assertEqual(e["observeCheck"]["pools"], 0)                # observe reverted: check skipped


class TestScoreIntegration(unittest.TestCase):
    def test_fifth_target_in_outcomes_and_summary(self):
        t_first = U("2026-10-13T00:00:00Z")
        ps = [mock.patch.object(QD, "FIRST_ORIGIN", t_first), mock.patch.object(QD, "STORE_START", t_first - 3 * H),
              mock.patch.object(TD.TS.QS, "FIRST_ORIGIN", t_first), mock.patch.object(QM, "FIRST_ORIGIN", t_first + 12 * H)]
        for p in ps:
            p.start()
        try:
            tc = TD.TestIssueDeep()
            tc.envs = []
            e = tc.env()
            _, d, _ = tc.issue(e, False, True)

            def fake_stores(ldir_, http_get=None, logs_rpc=None, clock=None, log=print):
                return {"binance1m": {}, "oracleLogs": {}, "rpc": None}, {}

            def fake_membrane(ldir_, membrane_rpc=None, clock=None, log=print):
                flat_store(ldir_, t_first - 6 * H, int(clock()) - 60)
                return {"mode": "bootstrap"}, None, None
            with mock.patch.object(QD, "update_deep_stores", fake_stores), \
                    mock.patch.object(QD, "update_membrane_store", fake_membrane):
                e.clock.t += 7 * C.DAY
                import q26_live_score as SC
                summ, _ = SC.score(e.root, e.rpc(), http_get=e.binance.get, clock=e.clock, code={}, log=lambda *a: None,
                                   deep_fh=True, membrane=True)
            dp = summ["deep"]
            self.assertIn("membrane", dp["targets"])
            self.assertTrue(dp["membrane"]["reportOnly"])
            ldir = C.live_dir(e.root)
            o = [json.loads(ln) for n in sorted(os.listdir(os.path.join(ldir, C.SCORES_SUB)))
                 if n.startswith("deep-outcomes-") for ln in open(os.path.join(ldir, C.SCORES_SUB, n))]
            self.assertEqual(len(o), len(d["deepRows"]))
            st = {x["targets"]["membrane"]["status"] for x in o if x["origin"] < QM.FIRST_ORIGIN}
            self.assertEqual(st, {"not_applicable"})
            late = [x for x in o if x["origin"] >= QM.FIRST_ORIGIN]
            self.assertTrue(late and all(x["targets"]["membrane"]["status"] == "resolved" for x in late))
            self.assertTrue(all(x["targets"]["membrane"]["y"] == 0 for x in late))
            cell = dp["cells"]["ETH"]["12h"]["membrane"]
            self.assertTrue(cell["verdict"]["reportOnly"])
            self.assertFalse(cell["verdict"]["applied"])
            self.assertNotIn("reportOnly", dp["cells"]["ETH"]["12h"]["xlow"]["verdict"])
            for x in tc.envs:
                x.close()
        finally:
            for p in ps:
                p.stop()


if __name__ == "__main__":
    unittest.main()
