"""Unit tests for a2_fetch_final_blind.py: parsers, grid, checks, holdout rule, retries, cache.

Run: python3 -m unittest scripts/research/history-forecasts/test_a2_fetch_final_blind.py
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import a2_fetch_final_blind as F  # noqa: E402

H = F.STEP
T0 = 1438423200  # 2015-08-01T10:00Z


def bs_body(rows):
    return json.dumps({"data": {"pair": "BTC/USD", "ohlc": [
        {"timestamp": str(t), "open": o, "high": h, "low": lo, "close": c, "volume": v} for t, o, h, lo, c, v in rows
    ]}}).encode()


class TestParsers(unittest.TestCase):
    def test_norm_num(self):
        self.assertEqual(F.norm_num("4261.48000000"), "4261.48")
        self.assertEqual(F.norm_num("0.00000000"), "0")
        self.assertEqual(F.norm_num("280"), "280")
        self.assertEqual(F.norm_num("1e-08"), "0.00000001")
        self.assertEqual(F.norm_num("1.5E+3"), "1500")
        for bad in ("", "abc", "NaN", "Infinity", 1.5, None):
            with self.assertRaises(ValueError):
                F.norm_num(bad)

    def test_bitstamp(self):
        rows = F.parse_bitstamp(bs_body([(T0, "4.58", "4.60", "4.50", "4.55", "0.00000000")]))
        self.assertEqual(rows, [(T0, "4.58", "4.6", "4.5", "4.55", "0")])
        with self.assertRaises(ValueError):
            F.parse_bitstamp(bs_body([(T0 + 1, "1", "1", "1", "1", "1")]))  # not on the hour
        with self.assertRaises(ValueError):
            F.parse_bitstamp(b'{"code": "x"}')

    def test_coinbase_reorders_columns_and_keeps_exact_text(self):
        body = b"[[1438426800, 277.82, 280, 280, 277.82, 101.31301086], [1438423200, 1.10, 1.30, 1.20, 1.25, 1e-05]]"
        rows = F.parse_coinbase(body)
        self.assertEqual(rows[0], (1438426800, "280", "280", "277.82", "277.82", "101.31301086"))
        self.assertEqual(rows[1], (1438423200, "1.2", "1.3", "1.1", "1.25", "0.00001"))

    def test_binance(self):
        t = T0 * 1000
        r = [t, "10.00", "12.50", "9.00", "11.00", "100.1", t + H * 1000 - 1, "0", 1, "0", "0", "0"]
        self.assertEqual(F.parse_binance(json.dumps([r]).encode()), [(T0, "10", "12.5", "9", "11", "100.1")])
        r[6] = t + H * 1000
        with self.assertRaises(ValueError):
            F.parse_binance(json.dumps([r]).encode())


class TestGrid(unittest.TestCase):
    def row(self, t, c="11"):
        return (t, "10", "12", "9", c, "5")

    def test_gaps_null_end_extension_and_drop_after_end(self):
        rows = [self.row(T0 + 3 * H), self.row(T0), self.row(T0 + H, "11.5"), self.row(T0 + 9 * H)]
        g = F.build_grid(rows, end_open=T0 + 5 * H)
        self.assertEqual(g["startTs"], T0)
        self.assertEqual(g["count"], 6)
        self.assertEqual(g["columns"]["close"], ["11", "11.5", None, "11", None, None])
        for c in F.COLUMNS:
            self.assertEqual([i for i, v in enumerate(g["columns"][c]) if v is None], [2, 4, 5])
        self.assertEqual(g["lastOpenTs"], T0 + 3 * H)

    def test_duplicates(self):
        g = F.build_grid([self.row(T0), self.row(T0), self.row(T0 + H)], end_open=T0 + H)
        self.assertEqual(g["duplicate_identical"], 1)
        self.assertEqual(g["rows"], 2)
        with self.assertRaises(ValueError):
            F.build_grid([self.row(T0), self.row(T0, "12")], end_open=T0)

    def test_serialize_round_trip(self):
        g = F.build_grid([self.row(T0), self.row(T0 + 2 * H)], end_open=T0 + 2 * H)
        d = json.loads(F.serialize_grid("BTC/USD", "src", g, "2026-10-13T00:00:00Z"))
        self.assertEqual(list(d), ["asset", "source", "startTs", "stepSeconds", "count", "columns", "fetchedAt"])
        self.assertEqual(d["columns"]["close"], [11, None, 11])
        self.assertEqual(d["stepSeconds"], 3600)

    def test_window_starts(self):
        self.assertEqual(F.window_starts(0, 2, end_open=4 * H), [0, 2 * H, 4 * H])
        self.assertEqual(F.window_starts(0, 2, end_open=5 * H), [0, 2 * H, 4 * H])


class TestChecks(unittest.TestCase):
    def test_value_checks_and_coverage(self):
        rows = [(T0, "10", "12", "10.5", "11", "1"),      # low > min(open, close)
                (T0 + H, "10", "10.5", "9", "11", "1"),   # high < max(open, close)
                (T0 + 2 * H, "7", "7", "7", "7", "0"),    # flat zero-volume (source fill)
                (T0 + 5 * H, "0", "1", "0", "1", "2")]    # non-positive prices
        g = F.build_grid(rows, end_open=T0 + 6 * H)
        v = F.value_checks(g)
        self.assertEqual(v["low_gt_min_open_close"], 1)
        self.assertEqual(v["high_lt_max_open_close"], 1)
        self.assertEqual(v["zero_volume_flat_hours"], 1)
        self.assertEqual(v["nonpositive_price_values"], 2)
        c = F.coverage(g)
        self.assertEqual((c["null_hours"], c["longest_gap_hours"], c["longest_gap_start"]),
                         (3, 2, F.iso_utc(T0 + 3 * H)))

    def test_rel_diff_stats(self):
        a = {"startTs": T0, "count": 4, "columns": {"close": ["101", "100", None, "98"]}}
        b = {"startTs": T0 + H, "count": 4, "columns": {"close": ["100", "100", "100", "100"]}}
        x = F.rel_diff_stats(a, b)
        self.assertEqual(x["hours_both_present"], 2)  # T0+H and T0+3H
        self.assertEqual(x["hours_reference_only"], 1)
        self.assertAlmostEqual(x["median_abs_rel_diff"], 0.0)
        self.assertAlmostEqual(x["p99_abs_rel_diff"], 0.02)
        self.assertEqual(x["hours_gt_1pct"], 1)
        y = F.rel_diff_stats(a, b, to_ts=T0 + 2 * H)
        self.assertEqual(y["hours_both_present"], 1)


class TestHoldoutRule(unittest.TestCase):
    def test_leveraged_needs_the_pair(self):
        bases = {"BTCUP", "BTCDOWN", "JUP", "ETHBULL", "ETHBEAR", "SYRUP"}
        self.assertTrue(F.leveraged("BTCUP", bases))
        self.assertTrue(F.leveraged("ETHBEAR", bases))
        self.assertFalse(F.leveraged("JUP", bases))
        self.assertFalse(F.leveraged("SYRUP", bases))

    def test_rank_and_exclusions(self):
        ei = {"symbols": [
            {"symbol": "AAAUSDT", "baseAsset": "AAA", "quoteAsset": "USDT", "status": "TRADING", "isSpotTradingAllowed": True},
            {"symbol": "USDCUSDT", "baseAsset": "USDC", "quoteAsset": "USDT", "status": "TRADING", "isSpotTradingAllowed": True},
            {"symbol": "BBBUSDT", "baseAsset": "BBB", "quoteAsset": "USDT", "status": "BREAK", "isSpotTradingAllowed": True},
            {"symbol": "CCCBTC", "baseAsset": "CCC", "quoteAsset": "BTC", "status": "TRADING", "isSpotTradingAllowed": True},
            {"symbol": "DDDUSDT", "baseAsset": "DDD", "quoteAsset": "USDT", "status": "TRADING", "isSpotTradingAllowed": True},
        ]}
        tk = [{"symbol": "AAAUSDT", "quoteVolume": "5.5"}, {"symbol": "USDCUSDT", "quoteVolume": "900"},
              {"symbol": "BBBUSDT", "quoteVolume": "1000"}, {"symbol": "DDDUSDT", "quoteVolume": "5.50"}]
        ranked, bases = F.rank_usdt_pairs(ei, tk)
        self.assertEqual([p["symbol"] for p in ranked], ["USDCUSDT", "AAAUSDT", "DDDUSDT"])  # tie -> symbol
        self.assertEqual(F.exclusion_reason("USDC", bases), "stablecoin/fiat/pegged")
        self.assertEqual(F.exclusion_reason("SOL", bases), "A2.2 holdout")
        self.assertEqual(F.exclusion_reason("WBTC", bases), "wrapped/staked")
        self.assertEqual(F.exclusion_reason("ETH", bases), "ETH/BTC")
        self.assertIsNone(F.exclusion_reason("AAA", bases))


class TestHttpAndCache(unittest.TestCase):
    def fake(self, responses):
        calls, sleeps = [], []

        def opener(url):
            calls.append(url)
            return responses.pop(0)
        h = F.Http("x", 0.0, opener=opener, sleep=sleeps.append, clock=lambda: 0.0)
        return h, calls, sleeps

    def test_retry_then_ok(self):
        h, calls, sleeps = self.fake([(429, b"", {}), (200, b"[]", {})])
        body, info = h.get("u")
        self.assertEqual((body, info["attempts"], h.retries), (b"[]", 2, 1))
        self.assertIn(60, sleeps)

    def test_stop_after_five_retries_and_on_4xx(self):
        h, calls, _ = self.fake([(429, b"", {})] * 6)
        with self.assertRaises(F.FetchStop):
            h.get("u")
        self.assertEqual(len(calls), 6)
        h, calls, _ = self.fake([(404, b"no", {})])
        with self.assertRaises(F.FetchStop):
            h.get("u")
        self.assertEqual(len(calls), 1)

    def test_cache_is_not_refetched_and_schema_stops(self):
        with tempfile.TemporaryDirectory() as d:
            work = Path(d)
            body = bs_body([(T0, "1", "1", "1", "1", "1")])
            h, calls, _ = self.fake([(200, body, {})])
            log = F.load_log(work)
            F.cached_get(work, h, log, "s", T0, "u", F.parse_bitstamp)
            b2, rec = F.cached_get(work, h, F.load_log(work), "s", T0, "u", F.parse_bitstamp)
            self.assertEqual((b2, len(calls), rec["rows"], rec["firstOpen"]), (body, 1, 1, T0))
            h, _, _ = self.fake([(200, b'{"data": {}}', {})])
            with self.assertRaises(F.FetchStop):
                F.cached_get(work, h, log, "s", T0 + H, "u", F.parse_bitstamp)


if __name__ == "__main__":
    unittest.main()
