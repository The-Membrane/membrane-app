"""Unit tests for q26_collectors.py on synthetic responses: file layout, no overwrite, no address in output,
independent source failure, liquidation binning and Polymarket parsing. No network.

Run: python3 -m unittest scripts/research/history-forecasts/collectors/test_q26_collectors.py
"""

import gzip
import hashlib
import json
import re
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import q26_collectors as Q  # noqa: E402

NOW = datetime(2026, 10, 17, 6, 23, 41, tzinfo=timezone.utc)
ADDR = re.compile(r"0x[0-9a-fA-F]{40}(?![0-9a-fA-F])")
A1, A2, A3 = "0x" + "11" * 20, "0x" + "ab" * 20, "0x" + "Cd" * 20
FAST = {"deribit": {"rate": 0, "workers": 2}, "hyperliquid": {"rate": 0, "workers": 2}}


def gamma_event(eid, title, slug, start, end, markets, series="ethereum-hit-price-daily"):
    return {"id": eid, "title": title, "slug": slug, "seriesSlug": series, "startDate": start, "endDate": end,
            "active": True, "closed": False, "volume": "100", "liquidity": "50", "openInterest": "10",
            "resolutionSource": "https://example.invalid/", "markets": markets}


def gamma_market(mid, q, tok, closed=False, group="↑ 2,750"):
    return {"id": mid, "question": q, "conditionId": "0x" + "9" * 64, "slug": f"m-{mid}",
            "outcomes": "[\"Yes\", \"No\"]", "outcomePrices": "[\"0.1\", \"0.9\"]",
            "clobTokenIds": json.dumps([tok, tok + "0"]), "bestBid": 0.09, "bestAsk": 0.11,
            "lastTradePrice": 0.1, "volumeNum": 15, "liquidityNum": 9, "active": True, "closed": closed,
            "acceptingOrders": not closed, "groupItemTitle": group, "submitted_by": A1, "resolvedBy": A2,
            "marketMakerAddress": A3, "description": f"resolves by {A1}"}


ETH_EVENTS = [
    gamma_event("1", "What price will Ethereum hit on October 17?", "what-price-will-ethereum-hit-on-october-17-2026",
                "2026-10-17T04:00:00Z", "2026-10-18T04:00:00Z",
                [gamma_market("11", "Will Ethereum reach $2,750 on October 17?", "111"),
                 gamma_market("12", "Will Ethereum dip to $2,100 on October 17?", "121", group="↓ 2,100"),
                 gamma_market("13", "Will Ethereum reach $2,450 on October 17?", "131", closed=True)]),
    gamma_event("2", "What price will Ethereum hit in 2026?", "what-price-will-ethereum-hit-before-2027",
                "2026-01-01T05:00:00Z", "2027-01-01T05:00:00Z",
                [gamma_market("21", "Will Ethereum reach $10k by December 31, 2026?", "211")],
                series="ethereum-hit-price-monthly"),
    gamma_event("3", "What price will ETH/BTC hit October 12-18?", "what-price-will-ethbtc-hit-october-12-18-2026",
                "2026-10-12T04:00:00Z", "2026-10-19T04:00:00Z", [gamma_market("31", "Will ETH/BTC reach 0.05?", "311")]),
]
BTC_EVENTS = [
    gamma_event("4", "What price will Bitcoin hit October 12-18?", "what-price-will-bitcoin-hit-october-12-18-2026",
                "2026-10-12T04:00:00Z", "2026-10-19T04:00:00Z",
                [gamma_market("41", "Will Bitcoin reach $150,000 October 12-18?", "411")],
                series="bitcoin-hit-price-weekly"),
    ETH_EVENTS[0],  # the same event can come back under both tags
]

OPTS = ["ETH-18OCT26-2000-C", "ETH-27NOV26-3100-P"]


class Fake:
    """Synthetic transport: routes by URL; `fail` maps a URL substring to an HTTP status."""

    def __init__(self, fail=None, leak_question=False):
        self.fail = fail or {}
        self.leak_question = leak_question
        self.calls = []

    def __call__(self, method, url, body, headers):
        self.calls.append((method, url))
        for frag, status in self.fail.items():
            if frag in url or (body and frag.encode() in body):
                return status, b"{\"error\":\"synthetic\"}"
        payload = json.loads(body) if body else None
        return 200, json.dumps(self.route(url, payload)).encode()

    def route(self, url, payload):
        if url.startswith(Q.GAMMA):
            if "offset=0" not in url:
                return []
            evs = json.loads(json.dumps(ETH_EVENTS if "tag_slug=ethereum" in url else BTC_EVENTS))
            if self.leak_question:
                for e in evs:
                    if e["id"] == "1":
                        e["markets"][0]["question"] = f"Will {A1} reach $1?"
            return evs
        if url == f"{Q.CLOB}/books":
            return [{"asset_id": p["token_id"], "market": "0x" + "9" * 64, "hash": "ab" * 20, "timestamp": "1792200000000",
                     "bids": [{"price": "0.08", "size": "10"}, {"price": "0.09", "size": "5"}],
                     "asks": [{"price": "0.99", "size": "1"}, {"price": "0.11", "size": "7"}],
                     "last_trade_price": "0.1"} for p in payload]
        if "get_book_summary_by_currency" in url:
            return {"result": [{"instrument_name": n, "mark_iv": 50.0, "bid_price": 0.1, "ask_price": 0.12,
                                "mark_price": 0.11, "underlying_price": 2400.0, "underlying_index": "ETH-18OCT26",
                                "open_interest": 3.0, "volume": 1.0, "creation_timestamp": 1} for n in OPTS]}
        if "ticker?instrument_name=ETH-PERPETUAL" in url:
            return {"result": {"timestamp": 2, "index_price": 2400, "mark_price": 2401, "current_funding": 1e-5,
                               "funding_8h": 2e-5, "open_interest": 9}}
        if "ticker?instrument_name=" in url:
            return {"result": {"bid_iv": 45.0, "ask_iv": 55.0, "best_bid_amount": 3, "best_ask_amount": 4,
                               "greeks": {"delta": 0.5, "gamma": 0.001, "vega": 1, "theta": -1}, "timestamp": 3}}
        if "get_volatility_index_data" in url:
            return {"result": {"data": [[1, 50, 51, 49, 50.5]]}}
        if url == Q.LIDO_WQ:
            return {"requestInfo": {"finalizationIn": 1000, "finalizationAt": "2026-10-19T00:00:00Z",
                                    "type": "validatorBalances"}, "status": "calculated"}
        if url in (Q.LIDO_APR_LAST, Q.LIDO_APR_SMA):
            meta = {"symbol": "stETH", "address": A2, "chainId": 1}
            if url == Q.LIDO_APR_LAST:
                return {"data": {"timeUnix": 1, "apr": 2.2}, "meta": meta}
            return {"data": {"aprs": [{"timeUnix": 1, "apr": 2.2}], "smaApr": 2.2}, "meta": meta}
        if url.startswith("https://prices.curve.finance/"):
            return {"name": "Curve.fi ETH/stETH", "address": Q.CURVE_STETH_POOL, "lp_token_address": A3,
                    "balances": [1.0, 2.0], "balances_usd": [3.0, 4.0], "tvl_usd": 7.0,
                    "coins": [{"symbol": "ETH", "address": A1}, {"symbol": "stETH", "address": A2}]}
        if url == Q.HL_INFO and payload["type"] == "metaAndAssetCtxs":
            return [{"universe": [{"name": "BTC"}, {"name": "ETH"}]},
                    [{"markPx": "60000"}, {"markPx": "2000", "openInterest": "100", "funding": "0.00001"}]]
        if url == Q.HL_INFO and payload["type"] == "predictedFundings":
            return [["ETH", [["HlPerp", {"fundingRate": "0.00001"}]]]]
        if url == Q.HL_LEADERBOARD:
            return {"leaderboardRows": [
                {"ethAddress": a, "accountValue": str(v), "windowPerformances": [["day", {"vlm": "1"}], ["month", {"vlm": "2"}]]}
                for a, v in ((A1, 3), (A2, 2), (A3, 1))]}
        if url == Q.HL_INFO and payload["type"] == "clearinghouseState":
            pos = {A1: [("ETH", "10", "1900"), ("BTC", "1", "50000")],   # long, liq -5%  -> bin -5
                   A2: [("ETH", "-4", "2030.5")],                         # short, liq +1.5% -> bin 1
                   A3: [("ETH", "2", None)]}[payload["user"]]             # long, no liq px
            return {"assetPositions": [{"position": {"coin": c, "szi": s, "liquidationPx": l}} for c, s, l in pos],
                    "marginSummary": {}, "user": payload["user"]}
        raise AssertionError(f"unrouted {url} {payload}")


def run(root, fake=None, sources=None):
    http = Q.Http(transport=fake or Fake(), sleep=lambda s: None)
    return Q.run(root, sources or Q.ALL_SOURCES, now=NOW, app_commit="deadbeef", http=http, opts=FAST,
                 parallel=False)


def read(root, rel):
    return json.loads(gzip.decompress((root / rel).read_bytes()))


class TestLayout(unittest.TestCase):
    def test_files_and_manifest(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            lines = run(root)
            want = {s: f"collectors/{s}/2026/10/17/0623.json.gz"
                    for s in ("polymarket-eth", "polymarket-btc", "deribit", "lido", "hyperliquid")}
            self.assertEqual({ln["source"]: ln["path"] for ln in lines}, want)
            self.assertTrue(all(ln["status"] == "ok" for ln in lines))
            man = (root / "collectors/manifest/2026/10/17.jsonl").read_text().splitlines()
            self.assertEqual(len(man), 5)
            for raw in man:
                m = json.loads(raw)
                blob = (root / m["path"]).read_bytes()
                self.assertEqual(m["sha256"], hashlib.sha256(blob).hexdigest())
                self.assertEqual(m["bytes"], len(blob))
                rec = json.loads(gzip.decompress(blob))
                self.assertEqual((rec["schema"], rec["slot"], rec["app_commit"]), (Q.SCHEMA, "2026-10-17T06:23Z", "deadbeef"))
                for r in rec["requests"]:
                    self.assertIn("endpoint", r)
                    if not r.get("sweep"):
                        self.assertEqual(r["http_status"], 200)
                        self.assertRegex(r["sha256"], r"^[0-9a-f]{64}$")
                        self.assertTrue(r["fetched_at"].endswith("Z"))
            all_files = sorted(p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file())
            self.assertEqual(all_files, sorted(list(want.values()) + ["collectors/manifest/2026/10/17.jsonl"]))

    def test_contents(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            run(root)
            eth = read(root, "collectors/polymarket-eth/2026/10/17/0623.json.gz")["data"]
            self.assertEqual([e["slug"] for e in eth["events"]],
                             ["what-price-will-ethereum-hit-on-october-17-2026", "what-price-will-ethereum-hit-before-2027"])
            self.assertEqual([e["window"] for e in eth["events"]], ["daily", "long"])
            m = {r["market_id"]: r for e in eth["events"] for r in e["markets"]}
            self.assertEqual((m["11"]["strike"], m["11"]["side"]), (2750.0, "reach"))
            self.assertEqual((m["12"]["strike"], m["12"]["side"]), (2100.0, "dip"))
            self.assertEqual(m["21"]["strike"], 10000.0)
            self.assertEqual((m["11"]["clob"]["best_bid"], m["11"]["clob"]["best_ask"]), (0.09, 0.11))
            self.assertIsNone(m["13"]["clob"])  # closed rung kept, not quoted
            self.assertTrue(m["13"]["closed"])
            btc = read(root, "collectors/polymarket-btc/2026/10/17/0623.json.gz")["data"]
            self.assertEqual([e["window"] for e in btc["events"]], ["weekly"])
            der = read(root, "collectors/deribit/2026/10/17/0623.json.gz")["data"]
            row = dict(zip(der["options"]["columns"], der["options"]["rows"][0]))
            self.assertEqual((row["instrument"], row["strike"], row["type"], row["bid_iv"], row["ask_iv"]),
                             ("ETH-18OCT26-2000-C", 2000.0, "C", 45.0, 55.0))
            self.assertEqual(der["perpetual"]["funding_8h"], 2e-5)
            lido = read(root, "collectors/lido/2026/10/17/0623.json.gz")["data"]
            self.assertEqual(lido["curve_steth_pool"]["coins"], ["ETH", "stETH"])
            self.assertEqual(lido["withdrawal_queue"]["finalization_in_ms"], 1000)

    def test_hyperliquid_histogram(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            run(root, sources=["hyperliquid"])
            h = read(root, "collectors/hyperliquid/2026/10/17/0623.json.gz")["data"]["liq_histogram"]
            self.assertEqual(h["bins"], {"-5": {"long_ntl": 20000.0, "long_n": 1, "short_ntl": 0.0, "short_n": 0},
                                         "1": {"long_ntl": 0.0, "long_n": 0, "short_ntl": 8000.0, "short_n": 1}})
            self.assertEqual(h["no_liquidation_px"]["long_ntl"], 4000.0)
            self.assertEqual((h["accounts_queried"], h["accounts_ok"], h["positions"]), (3, 3, 3))
            self.assertEqual((h["coverage_long"], h["coverage_short"]), (0.12, 0.04))


class TestNoOverwrite(unittest.TestCase):
    def test_second_run_same_slot(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            run(root, sources=["lido"])
            p = root / "collectors/lido/2026/10/17/0623.json.gz"
            before = p.read_bytes()
            lines = run(root, sources=["lido"])
            self.assertEqual(lines[0]["status"], "exists")
            self.assertIsNone(lines[0]["path"])
            self.assertEqual(p.read_bytes(), before)
            man = [json.loads(x) for x in (root / "collectors/manifest/2026/10/17.jsonl").read_text().splitlines()]
            self.assertEqual([m["status"] for m in man], ["ok", "exists"])

    def test_write_new_refuses(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "a" / "b.json.gz"
            Q.write_new(p, b"one")
            with self.assertRaises(FileExistsError):
                Q.write_new(p, b"two")
            self.assertEqual(p.read_bytes(), b"one")


class TestNoAddress(unittest.TestCase):
    def test_no_address_anywhere(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            fake = Fake()
            run(root, fake)
            self.assertTrue(any("clearinghouseState" in json.dumps(c) or c[1] == Q.HL_INFO for c in fake.calls))
            for p in root.rglob("*"):
                if p.is_file():
                    raw = p.read_bytes()
                    text = (gzip.decompress(raw) if p.suffix == ".gz" else raw).decode()
                    self.assertIsNone(ADDR.search(text), f"{p}: {ADDR.search(text)}")
                    self.assertNotIn(Q.CURVE_STETH_POOL[2:].lower(), text.lower())

    def test_guard_drops_a_leaking_record(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            lines = run(root, Fake(leak_question=True), sources=["polymarket"])
            st = {ln["source"]: ln for ln in lines}
            self.assertEqual(st["polymarket-eth"]["status"], "failed")
            self.assertIn("address", st["polymarket-eth"]["error"])
            self.assertFalse((root / "collectors/polymarket-eth").exists())
            self.assertEqual(st["polymarket-btc"]["status"], "ok")  # the leak is in an Ethereum event only
            self.assertTrue((root / st["polymarket-btc"]["path"]).exists())
            self.assertIsNone(ADDR.search((root / "collectors/manifest/2026/10/17.jsonl").read_text()))


class TestIndependentFailure(unittest.TestCase):
    def test_one_source_down(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            lines = run(root, Fake(fail={"get_book_summary_by_currency": 503}))
            st = {ln["source"]: ln for ln in lines}
            self.assertEqual(st["deribit"]["status"], "failed")
            self.assertIsNone(st["deribit"]["path"])
            self.assertEqual(st["deribit"]["http"][0]["status"], 503)
            self.assertFalse((root / "collectors/deribit").exists())
            for s in ("polymarket-eth", "polymarket-btc", "lido", "hyperliquid"):
                self.assertEqual(st[s]["status"], "ok", s)

    def test_optional_parts(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            lines = run(root, Fake(fail={Q.HL_LEADERBOARD: 404, Q.LIDO_WQ: 500, "clob.polymarket.com": 500}))
            st = {ln["source"]: ln for ln in lines}
            self.assertTrue(all(ln["status"] == "ok" for ln in lines))
            self.assertIsNone(read(root, st["hyperliquid"]["path"])["data"]["liq_histogram"])
            lido = read(root, st["lido"]["path"])
            self.assertIsNone(lido["data"]["withdrawal_queue"])
            self.assertEqual(lido["requests"][0]["attempts"], Q.RETRIES)
            eth = read(root, st["polymarket-eth"]["path"])["data"]
            self.assertEqual(eth["n_markets_with_clob"], 0)

    def test_network_error(self):
        def boom(method, url, body, headers):
            raise OSError("synthetic down")
        with tempfile.TemporaryDirectory() as d:
            lines = run(Path(d), boom, sources=["lido"])
            self.assertEqual(lines[0]["status"], "failed")
            self.assertEqual([h["status"] for h in lines[0]["http"]], [None] * 4)


class TestParsing(unittest.TestCase):
    def test_liq_bin(self):
        self.assertEqual(Q.liq_bin(2000, 2000), 0)
        self.assertEqual(Q.liq_bin(2019.99, 2000), 0)
        self.assertEqual(Q.liq_bin(2020, 2000), 1)
        self.assertEqual(Q.liq_bin(1999.99, 2000), -1)
        self.assertEqual(Q.liq_bin(1900, 2000), -5)

    def test_strike_side(self):
        self.assertEqual(Q.parse_strike("Will Bitcoin reach $150,000 by ...?"), 150000.0)
        self.assertEqual(Q.parse_strike("Will Ethereum reach $2.5k?"), 2500.0)
        self.assertIsNone(Q.parse_strike("no price"))
        self.assertEqual(Q.parse_side("Will Ethereum dip to $2,100?", None), "dip")
        self.assertEqual(Q.parse_side("Will Ethereum reach $2,750?", None), "reach")
        self.assertEqual(Q.parse_side("?", "↓ 2,100"), "dip")

    def test_window_fallback(self):
        self.assertEqual(Q.classify_window("ethereum-hit-price-weekly", "x"), "weekly")
        self.assertEqual(Q.classify_window(None, "what-price-will-ethereum-hit-on-october-17-2026"), "daily")
        self.assertEqual(Q.classify_window(None, "what-price-will-ethereum-hit-in-october-2026"), "monthly")
        self.assertEqual(Q.classify_window(None, "what-price-will-ethereum-hit-before-2027"), "long")


if __name__ == "__main__":
    unittest.main()
