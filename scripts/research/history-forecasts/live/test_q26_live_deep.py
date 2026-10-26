#!/usr/bin/env python3
"""Tests for the D9 deep-level block (q26_live_deep.py; HISTORY_TOUCH_LIVE.md D9).

  python3 -m unittest scripts/research/history-forecasts/live/test_q26_live_deep.py -v

Synthetic tests need no network and no dataset. Optional real-data checks:
  Q26_DATASETS=<root with price-history/, deribit-dvol/, binance-klines/, history-forecasts/, forecasts/q26-touch-live/>
      (e) constants equal the frozen R12 file; deep rows do not change when every price after the origin is replaced
      or the series is cut at a middle origin.
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
import q26_live_common as C  # noqa: E402
import q26_live_deep as QD  # noqa: E402
import test_q26_live as TL  # noqa: E402
import test_q26_live_a6 as T6  # noqa: E402
import test_q26_live_short as TS  # noqa: E402

warnings.filterwarnings("ignore")
U = C.A.utc
H = C.HOUR


def fake_deep_forecaster(calls):
    def f(datasets, rounds, asof, origins, log=print):
        calls.append((asof, list(origins), {a: max((r.updated_at for r in rs), default=None)
                                            for a, rs in rounds.items()}))
        out = {}
        for a in QD.ASSETS:
            rs = C.sort_rounds(rounds[a])
            spot = [C.price(C.answer_in_force(rs, t), a) for t in origins]
            T = {}
            for Th in QD.HORIZONS:
                K = len(C.LEVELS[a])
                base = np.linspace(0.4, 0.001, K)[None, :] * (Th / 72.0) ** 0.5
                g = np.repeat(base, len(origins), axis=0)
                T[Th] = {"P": {"fH": g, "f": g * 0.9, "a": g * 1.1}, "fallback": np.zeros(len(origins), bool),
                         "fit": {"har": [0.0, 1.0, 0.0, 0.0], "fH_fallback_rows": 0}}
            out[a] = {"spot_series": spot, "regime": ["mid"] * len(origins), "T": T}
        return out
    return f


def write_m1(ldir, pair, t0, t1, price_fn, missing=()):
    rows = []
    for o in range(t0, t1, 60):
        if o in missing:
            continue
        px = price_fn(o)
        rows.append([str(o * 1000), str(px), str(px), str(px), str(px), "1", str(o * 1000 + 59999)])
    p = QD.m1_store_path(ldir, pair)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "wb") as f:
        f.write(C.gz_member(C.KLINE_HEADER, rows))


def write_logs(ldir, asset, logs, cov_ts, cov_blk=10 ** 6):
    p = QD.logs_store_path(ldir, asset)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "wb") as f:
        f.write(C.gz_member(QD.LOG_HEADER, [[str(v) for v in x] for x in logs]))
    C.append_fetch_log(os.path.join(ldir, QD.LOGS_SUB, "fetch-log.jsonl"),
                       {"asset": asset, "toBlock": cov_blk, "toBlockTimestamp": cov_ts})


class TestOriginsLevels(unittest.TestCase):
    def test_batch_rule(self):
        with mock.patch.object(QD, "FIRST_ORIGIN", U("2026-10-18T18:00:00Z")):
            self.assertEqual(QD.batch_origins(U("2026-10-18T17:00:00Z"), None), [])
            o = QD.batch_origins(U("2026-10-19T04:00:00Z"), None)
            self.assertEqual((len(o), o[0], o[-1]), (11, U("2026-10-18T18:00:00Z"), U("2026-10-19T04:00:00Z")))
            o = QD.batch_origins(U("2026-10-22T00:00:00Z"), U("2026-10-19T04:00:00Z"))    # no backfill
            self.assertEqual((len(o), o[0]), (24, U("2026-10-21T01:00:00Z")))

    def test_levels_and_e(self):
        self.assertEqual(QD.LEVELS, (-0.15, -0.20, -0.25))
        for a in QD.ASSETS:
            for k in QD.LEVELS:
                self.assertIn(k, C.LEVELS[a])
        for T in QD.HORIZONS:
            e = [QD.E_CONST[T][k] for k in QD.LEVELS]
            self.assertEqual(e, sorted(e, reverse=True))
        self.assertEqual(set(QD.EVIDENCE_DAYS), set(QD.TARGETS))
        self.assertTrue(all(v > 365 for t in QD.TARGETS for v in QD.EVIDENCE_DAYS[t].values()))


class TestTruth(unittest.TestCase):
    t = U("2026-10-20T00:00:00Z")

    def kidx(self, lows, closes, spot=100.0):
        k = {self.t - H: (spot - 1, spot)}
        for j, (lo, c) in enumerate(zip(lows, closes)):
            k[self.t + j * H] = (lo, c)
        return k

    def test_exchange_low_vs_close(self):
        lows, closes = [99, 84, 99] + [99] * 9, [100, 90, 100] + [100] * 9     # a wick to -16%, closes stay above
        k = self.kidx(lows, closes)
        st, i = QD.truth_exchange(k, max(k), self.t, 12, -0.15, 0)
        self.assertEqual((st, i["y"], i["S_x"]), ("resolved", 1, 100.0))
        st, i = QD.truth_exchange(k, max(k), self.t, 12, -0.15, 1)
        self.assertEqual((st, i["y"]), ("resolved", 0))
        st, _ = QD.truth_exchange(k, self.t + 5 * H, self.t, 12, -0.15, 0)                  # store not yet covering
        self.assertEqual(st, "pending")
        k2 = dict(k)
        for j in (3, 4, 5):
            del k2[self.t + j * H]
        self.assertEqual(QD.truth_exchange(k2, max(k), self.t, 12, -0.15, 0)[0], "unresolved")  # 3 missing hours
        del k2[self.t - H]
        self.assertEqual(QD.truth_exchange(k2, max(k), self.t, 12, -0.15, 0)[1]["reason"][:16], "no exchange spot")

    def test_twap(self):
        t, end = self.t, self.t + 12 * H
        # a 30-minute dip to 80 (-20%) at t + 2 h: 1 m closes touch, the 60-min TWAP reaches only ~90 (-10%)
        m1 = {o: (80.0 if t + 2 * H <= o < t + 2 * H + 1800 else 100.0) for o in range(t - 3600, end, 60)}
        mn, gap, und = QD.twap_min(m1, t, end)
        self.assertAlmostEqual(mn, 90.0)
        self.assertEqual((gap, und), (0, 0))
        k = self.kidx([99] * 12, [100] * 12)
        st, i = QD.truth_twap(m1, end, k, t, 12, -0.15)
        self.assertEqual((st, i["y"]), ("resolved", 0))
        st, i = QD.truth_twap(m1, end, k, t, 12, -0.05)
        self.assertEqual((st, i["y"]), ("resolved", 1))
        self.assertEqual(QD.truth_twap(m1, end - 60, k, t, 12, -0.15)[0], "pending")
        # TWAP at tau uses only minutes before tau: a dip opening exactly at end is never seen
        m2 = dict(m1)
        for o in range(end - 60, end + 3600, 60):
            m2[o] = 1.0
        self.assertAlmostEqual(QD.twap_min(m2, t, end)[0], 90.0)
        m3 = {o: v for o, v in m1.items() if not (t + 5 * H <= o < t + 7 * H + 60)}            # 121 min missing
        self.assertEqual(QD.truth_twap(m3, end, k, t, 12, -0.15)[0], "unresolved")

    def test_oracle(self):
        t = self.t
        agg = "0xabc"
        logs = [(1, t - 1800, 0, agg, 10, 100 * 10 ** 8, t - 1800), (2, t + 600, 0, agg, 11, 95 * 10 ** 8, t + 600),
                (3, t + 3 * H, 0, agg, 12, 84 * 10 ** 8, t + 3 * H), (4, t + 12 * H, 0, agg, 13, 100 * 10 ** 8, 0),
                (5, t + 12 * H + 1, 0, agg, 14, 1 * 10 ** 8, 0)]
        st, i = QD.truth_oracle(logs, t + 13 * H, t, 12, 85.0, 100.0, "ETH")
        self.assertEqual((st, i["y"], i["nLogs"], i["spotMatchesRow"]), ("resolved", 1, 4, True))
        st, i = QD.truth_oracle(logs, t + 13 * H, t, 12, 80.0, 100.0, "ETH")                 # after end not used
        self.assertEqual((st, i["y"]), ("resolved", 0))
        self.assertEqual(QD.truth_oracle(logs, t + 11 * H, t, 12, 85.0, 100.0, "ETH")[0], "pending")
        gap = [logs[0], (2, t + 3 * H, 0, agg, 13, 99 * 10 ** 8, 0)]                          # ids 10 -> 13 over 3.5 h
        self.assertEqual(QD.truth_oracle(gap, t + 13 * H, t, 12, 85.0, 100.0, "ETH")[0], "unresolved")
        newagg = [logs[0], (2, t + 3 * H, 0, "0xdef", 1, 99 * 10 ** 8, 0)]                    # aggregator change
        self.assertEqual(QD.truth_oracle(newagg, t + 13 * H, t, 12, 85.0, 100.0, "ETH")[0], "resolved")
        self.assertEqual(QD.truth_oracle(logs[1:], t + 13 * H, t, 12, 85.0, 100.0, "ETH")[0], "unresolved")


class FakeLogChain:
    """eth_getBlockByNumber (finalized / hex), eth_call aggregator(), eth_getLogs over a synthetic block range
    (block b has timestamp T0 + 12 b)."""

    def __init__(self, t0, head_blk, logs, agg="0x" + "ab" * 20, with_ts=True, max_range=None):
        self.t0, self.head, self.logs, self.agg, self.with_ts, self.max_range = t0, head_blk, logs, agg, with_ts, max_range
        self.calls = []

    def ts(self, b):
        return self.t0 + 12 * b

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
                res = "0x" + "00" * 12 + self.agg[2:]
            elif m == "eth_getLogs":
                f = p[0]
                lo, hi = int(f["fromBlock"], 16), int(f["toBlock"], 16)
                if self.max_range and hi - lo + 1 > self.max_range:
                    out.append({"jsonrpc": "2.0", "id": q["id"], "error": {"code": 35, "message": "range too big"}})
                    continue
                res = []
                for (b, li, rid, ans) in self.logs:
                    if lo <= b <= hi:
                        lg = {"blockNumber": hex(b), "logIndex": hex(li), "address": self.agg, "removed": False,
                              "topics": [QD.TOPIC_ANSWER_UPDATED, "0x" + format(ans % (1 << 256), "064x"),
                                         "0x" + format(rid, "064x")], "data": "0x" + format(self.ts(b), "064x")}
                        if self.with_ts:
                            lg["blockTimestamp"] = hex(self.ts(b))
                        res.append(lg)
            else:
                raise AssertionError(m)
            out.append({"jsonrpc": "2.0", "id": q["id"], "result": res})
        return json.dumps(out[0] if single else out).encode()


class TestStoresDeep(unittest.TestCase):
    def test_logs_store_bootstrap_append(self):
        t0 = QD.STORE_START - 12 * 1000                 # block 1000 is STORE_START
        logs = [(990, 0, 5, 100), (1001, 3, 6, 101), (1500, 1, 7, -5), (2600, 0, 8, 102)]
        for with_ts in (True, False):
            ch = FakeLogChain(t0, 2000, logs, with_ts=with_ts, max_range=600)
            rpc = C.RpcClient(urls=QD.LOG_RPC_URLS, post=ch.post, sleep=lambda s: None, max_batch=QD.LOG_RPC_BATCH)
            with tempfile.TemporaryDirectory() as d:
                e = QD.update_logs_store(rpc, d, "ETH", clock=lambda: 0)
                self.assertEqual((e["mode"], e["fromBlock"], e["toBlock"], e["appended"]), ("bootstrap", 1000, 2000, 2))
                st = QD.read_logs_store(QD.logs_store_path(d, "ETH"))
                self.assertEqual([(x[0], x[4], x[5]) for x in st], [(1001, 6, 101), (1500, 7, -5)])
                self.assertEqual(st[0][1], ch.ts(1001))
                self.assertEqual(QD.logs_coverage(d, "ETH"), (2000, ch.ts(2000)))
                ch.head = 3000
                e = QD.update_logs_store(rpc, d, "ETH", clock=lambda: 0)
                self.assertEqual((e["mode"], e["fromBlock"], e["appended"]), ("append", 2001, 1))
                self.assertEqual(len(QD.read_logs_store(QD.logs_store_path(d, "ETH"))), 3)

    def test_m1_store(self):
        clock = TL.Clock(QD.STORE_START + 3 * H + 30)

        def get(url):
            q = dict(p.split("=") for p in url.split("?", 1)[1].split("&"))
            self.assertEqual(q["interval"], "1m")
            o, out = int(q["startTime"]), []
            while o <= clock() * 1000 and len(out) < int(q["limit"]):
                out.append([o, "1", "1", "1", "1", "1", o + 59999, "0", 1, "0", "0", "0"])
                o += 60000
            return json.dumps(out).encode()
        with tempfile.TemporaryDirectory() as d:
            e = QD.update_m1_store(d, "ETHUSDT", http_get=get, clock=clock)
            self.assertEqual(e["appended"], 180)                         # closed minutes only
            clock.t += 3600
            e = QD.update_m1_store(d, "ETHUSDT", http_get=get, clock=clock)
            self.assertEqual((e["appended"], e["storeKlines"]), (60, 240))
            rows = QD.read_m1_store(QD.m1_store_path(d, "ETHUSDT"))
            self.assertEqual(int(rows[0][0]) // 1000, QD.STORE_START)


class TestIssueDeep(unittest.TestCase):
    def setUp(self):
        self.ps = [mock.patch.object(QD, "FIRST_ORIGIN", U("2026-10-13T00:00:00Z")),
                   mock.patch.object(QD, "STORE_START", U("2026-10-12T21:00:00Z")),
                   mock.patch.object(TS.QS, "FIRST_ORIGIN", U("2026-10-13T00:00:00Z"))]
        for p in self.ps:
            p.start()
        self.envs = []

    def tearDown(self):
        for e in self.envs:
            e.close()
        for p in self.ps:
            p.stop()

    def env(self):
        e = TL.LiveEnv(U("2026-10-14T00:17:30Z"))
        self.envs.append(e)
        e.fz5 = TL.write_frozen_a5(e.root)
        e.fz6 = T6.write_json(e.root, "frozen-a6.json", T6.fake_frozen_a6())
        return e

    def issue(self, e, short, deep, calls=None):
        kw = dict(forecaster=T6.fake_a6_forecaster(e.seen), frozen_a5=e.fz5, frozen_a6=e.fz6)
        if short:
            kw.update(short_fh=True, short_forecaster=TS.fake_short_forecaster([]))
        if deep:
            kw.update(deep_fh=True, deep_forecaster=fake_deep_forecaster(calls if calls is not None else []))
        return e.issue(**kw)

    def test_deep_block_other_fields_identical(self):
        for short in (False, True):
            e1, e0 = self.env(), self.env()
            calls = []
            p1, d1, sha1 = self.issue(e1, short, True, calls)
            p0, d0, _ = self.issue(e0, short, False)
            with open(p1, "rb") as f:
                raw1 = f.read().replace(e1.root.encode(), b"ROOT")
            with open(p0, "rb") as f:
                raw0 = f.read().replace(e0.root.encode(), b"ROOT")
            j1 = json.loads(raw1)
            self.assertEqual(j1, json.loads(json.dumps(C.clean(d1)).replace(e1.root, "ROOT")))
            j1s = {k: v for k, v in j1.items() if k not in ("deep", "deepRows")}
            self.assertEqual(j1s, json.loads(raw0))
            # every daily row line and every short row line byte-identical
            lines1 = [ln for ln in raw1.split(b"\n") if ln.startswith(b"  {")]
            lines0 = [ln for ln in raw0.split(b"\n") if ln.startswith(b"  {")]
            self.assertEqual(lines1[:len(lines0)], lines0)
            keys = list(d1)
            tail = ["deep", "nRows", "rows"] + (["shortRows"] if short else []) + ["deepRows"]
            self.assertEqual(keys[-len(tail):], tail)
            dp = d1["deep"]
            asof = d1["asof"]
            self.assertEqual(dp["origins"], list(range(asof - 23 * H, asof + 1, H)))
            self.assertEqual(len(d1["deepRows"]), 24 * len(QD.ASSETS) * len(QD.HORIZONS) * len(QD.LEVELS))
            self.assertEqual(dp["nDeepRows"], len(d1["deepRows"]))
            self.assertTrue(all(m <= asof for m in calls[0][2].values()))
            for r in d1["deepRows"]:
                self.assertEqual(set(r["p"]), set(QD.RUNGS))
                self.assertEqual(r["p"]["e"], QD.E_CONST[r["T_h"]][r["k"]])
                self.assertEqual(r["confirm"], r["k"] != -0.25)
                self.assertAlmostEqual(r["L"], r["S"] * (1 + r["k"]))
            e1.clock.t += C.DAY
            _, d2, _ = self.issue(e1, short, True, calls)
            self.assertEqual(d2["prevSha256"], sha1)
            self.assertEqual(d2["deep"]["origins"][0], asof + H)
            self.assertEqual(C.verify_chain(C.issues_dir(C.live_dir(e1.root))), [])

    def test_scoring_deep(self):
        e = self.env()
        _, d, _ = self.issue(e, True, True)
        ldir = C.live_dir(e.root)
        orig = QD.update_deep_stores

        def fake_stores(ldir_, http_get=None, logs_rpc=None, clock=None, log=print):
            now = int(clock())
            for a, pair in C.BINANCE_PAIRS.items():
                write_m1(ldir_, pair, QD.STORE_START, now - 120, lambda o: 100.0 + (o // 3600) % 7 + 0.5)
            for a in QD.ASSETS:
                rnd = C.read_round_store(C.round_store_path(ldir_, a))
                logs = [(i + 1, r.updated_at, 0, "0xagg", r.agg, r.answer, r.updated_at)
                        for i, r in enumerate(C.sort_rounds(rnd)) if r.updated_at >= QD.STORE_START - 2 * H]
                write_logs(ldir_, a, logs, now - 60)
            return {"binance1m": {}, "oracleLogs": {}, "rpc": None}, {}
        with mock.patch.object(QD, "update_deep_stores", fake_stores):
            e.clock.t += 4 * C.DAY
            summ, _ = TS_score(e)
            dp = summ["deep"]
            self.assertEqual(dp["nRows"], len(d["deepRows"]))
            self.assertEqual(dp["nOutcomes"], len(d["deepRows"]))
            o = [json.loads(ln) for n in sorted(os.listdir(os.path.join(ldir, C.SCORES_SUB)))
                 if n.startswith("deep-outcomes-") for ln in open(os.path.join(ldir, C.SCORES_SUB, n))]
            st = {t: {x["targets"][t]["status"] for x in o} for t in QD.TARGETS}
            self.assertEqual(st, {t: {"resolved"} for t in QD.TARGETS}, st)
            self.assertTrue(all(x["targets"]["oracle"]["spotMatchesRow"] for x in o))
            cell = dp["cells"]["ETH"]["12h"]["oracle"]
            self.assertEqual(set(cell["perLevel"]), {repr(k) for k in QD.LEVELS})
            self.assertEqual(set(cell["tests"]), {"vs_f", "vs_a", "vs_e"})
            self.assertFalse(cell["verdict"]["applied"])
            n1 = dp["nOutcomes"]
            e.clock.t += C.DAY
            summ2, _ = TS_score(e)
            self.assertEqual(summ2["deep"]["nOutcomes"], n1)                    # append-only, no duplicates
        self.assertIs(QD.update_deep_stores, orig)

    def test_pending_then_give_up(self):
        e = self.env()
        _, d, _ = self.issue(e, False, True)

        def no_stores(ldir_, **kw):
            return {"binance1m": {}, "oracleLogs": {}, "rpc": None}, {"x": "down"}
        with mock.patch.object(QD, "update_deep_stores", no_stores):
            e.clock.t += 2 * C.DAY
            summ, _ = TS_score(e)
            self.assertEqual(summ["deep"]["nOutcomes"], 0)                      # m1 / logs stores missing: pending
            self.assertEqual(summ["deep"]["storeUpdateErrors"], {"x": "down"})
            e.clock.t += 5 * C.DAY
            summ, _ = TS_score(e)
            self.assertEqual(summ["deep"]["nOutcomes"], len(d["deepRows"]))     # given up after 3 days
            o = [json.loads(ln) for n in sorted(os.listdir(os.path.join(C.live_dir(e.root), C.SCORES_SUB)))
                 if n.startswith("deep-outcomes-")
                 for ln in open(os.path.join(C.live_dir(e.root), C.SCORES_SUB, n))]
            self.assertTrue(all(x["targets"]["twap"]["status"] == "unresolved" for x in o))
            self.assertTrue(all(x["targets"]["xlow"]["status"] == "resolved" for x in o))

    def test_score_without_flag_unchanged(self):
        e = self.env()
        self.issue(e, False, True)
        e.clock.t += 2 * C.DAY
        summ, _ = e.score()
        self.assertNotIn("deep", summ)


def TS_score(e):
    import q26_live_score as SC
    return SC.score(e.root, e.rpc(), http_get=e.binance.get, clock=e.clock, code={}, log=TL.QUIET, deep_fh=True)


class TestStats(unittest.TestCase):
    def test_hac(self):
        rng = np.random.default_rng(2)
        d = -0.002 + 0.01 * rng.standard_normal(24 * 200)
        self.assertLess(QD.hac_p(d, 48), 0.01)
        self.assertGreater(QD.hac_p(-d, 48), 0.9)


@unittest.skipUnless(os.environ.get("Q26_DATASETS"), "set Q26_DATASETS for the real-data checks")
class TestRealDataDeep(unittest.TestCase):
    def setUp(self):
        self.ds = os.environ["Q26_DATASETS"]
        ldir = os.path.join(self.ds, C.LIVE_REL)
        self.rounds = {a: C.read_round_store(C.round_store_path(ldir, a)) for a in C.ASSETS}
        self.asof = C.floor_hour(min(rs[-1].updated_at for rs in self.rounds.values()))

    def test_e_constants_match_frozen_files(self):
        p = os.path.join(self.ds, QD.E_SOURCE["file"])
        self.assertEqual(C.sha256_file(p), QD.E_SOURCE["sha256"])
        with open(p) as f:
            e = json.load(f)["e"]
        for T in QD.HORIZONS:
            for k in QD.LEVELS:
                self.assertEqual(e[QD.TL[T]][repr(k)], QD.E_CONST[T][k])
        p2 = os.path.join(self.ds, QD.E_SOURCE["frozenConfig"])
        self.assertEqual(C.sha256_file(p2), QD.E_SOURCE["frozenConfigSha256"])

    def run_deep(self, rounds, asof, origins):
        up = {a: [r for r in rs if r.updated_at <= asof] for a, rs in rounds.items()}
        fc = QD.deep_forecasts(self.ds, up, asof, origins, log=lambda *a: None)
        return QD.deep_rows(fc, up, origins, asof + 999)

    def test_no_look_ahead(self):
        origins = list(range(self.asof - 23 * H, self.asof + 1, H))
        base = self.run_deep(self.rounds, self.asof, origins)
        self.assertEqual(len(base), 24 * 2 * 3 * 3)
        self.assertTrue(all(0 <= r["p"][x] <= 1 for r in base for x in QD.RUNGS))
        pert = {}
        for a, rs in self.rounds.items():
            keep = [r for r in rs if r.updated_at <= self.asof]
            last = keep[-1]
            pert[a] = keep + [C.Round(last.round_id + 1 + j, last.answer // 2, self.asof + 1 + 300 * j)
                              for j in range(30)]
        self.assertEqual(self.run_deep(pert, self.asof, origins), base)
        cut = origins[11]
        part = self.run_deep(self.rounds, cut, origins[:12])
        self.assertEqual([dict(r, issuedAt=0) for r in part],
                         [dict(r, issuedAt=0) for r in base if r["origin"] <= cut])


if __name__ == "__main__":
    unittest.main()


class PooledEpisodeCount(unittest.TestCase):
    """2026-10-26 fix: pooled rows at one origin count once; runs need distinct origins one hour apart."""

    def test_pooled_levels_count_once(self):
        import q26_live_short as QS
        H = C.HOUR
        for M in (QD, QS):
            self.assertEqual(M._pos_episodes([0, 0, 0, H, H, H], [1, 1, 1, 1, 1, 1]), 1)
            self.assertEqual(M._pos_episodes([0, 0, 2 * H], [1, 0, 1]), 2)
            self.assertEqual(M._pos_episodes([0, H, 2 * H], [1, 0, 1]), 2)
