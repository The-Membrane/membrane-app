"""Unit tests for a4_fetch_blind3.py: the rank-41-120 selection rule and the shared pacer.

Run: python3 -m unittest scripts/research/history-forecasts/test_a4_fetch_blind3.py
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import a4_fetch_blind3 as A  # noqa: E402
import a2_fetch_final_blind as F  # noqa: E402

OLD, NEW = 1546300800, 1700000000  # 2019-01-01 (before the cutoff), 2023-11-14 (after)


class TestExclusions(unittest.TestCase):
    def test_reasons(self):
        bases = {"BTCUP", "BTCDOWN"}
        self.assertEqual(A.exclusion_reason("NEAR", bases), "already used (A3 ten)")
        self.assertEqual(A.exclusion_reason("LINK", bases), "already used (A2 eight)")
        self.assertEqual(A.exclusion_reason("BTC", bases), "already used (ETH/BTC)")
        self.assertEqual(A.exclusion_reason("USD1", bases), "stablecoin/fiat/pegged")
        self.assertEqual(A.exclusion_reason("PAXG", bases), "stablecoin/fiat/pegged")
        self.assertEqual(A.exclusion_reason("WBETH", bases), "wrapped/staked")
        self.assertEqual(A.exclusion_reason("BTCUP", bases), "leveraged token")
        self.assertEqual(A.exclusion_reason("SOXLB", bases), "tokenized stock")
        self.assertEqual(A.exclusion_reason("NVDAB", bases), "tokenized stock")
        self.assertIsNone(A.exclusion_reason("ARB", bases))  # a B suffix alone is not a stock
        self.assertIsNone(A.exclusion_reason("ATOM", bases))


class TestSelect(unittest.TestCase):
    def test_window_exclusions_and_first_kline(self):
        ranked = [{"symbol": f"T{i}USDT", "baseAsset": f"T{i}", "quoteVolume": str(1000 - i), "rank": i}
                  for i in range(1, 131)]
        ranked[40]["baseAsset"] = "USDC"   # rank 41: excluded (binding: first kline is early)
        ranked[41]["baseAsset"] = "DOT"    # rank 42: already used
        probed = []

        def first_open(sym):
            probed.append(sym)
            return (NEW if sym == "T43USDT" else OLD), "[]"
        table, kept = A.select(ranked, set(), first_open)
        self.assertEqual([r["rank"] for r in table], list(range(41, 121)))
        self.assertEqual(table[0]["excluded"], "stablecoin/fiat/pegged")
        self.assertEqual(table[1]["excluded"], "already used (A3 ten)")
        self.assertIn("T41USDT", probed)       # every rank in the window is probed
        self.assertNotIn("T121USDT", probed)
        self.assertTrue(table[0]["exclusionBinding"])   # early first kline, removed only by the exclusion
        self.assertFalse(table[2]["keep"])  # first kline after 2022-01-01
        self.assertFalse(table[2]["exclusionBinding"])
        self.assertEqual(len(kept), 80 - 3)
        self.assertEqual(kept[0]["rank"], 44)
        self.assertEqual(kept[0]["firstKlineOpen"], F.iso_utc(OLD))


class FakeClock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t

    def sleep(self, s):
        self.t += s


class TestSharedHttp(unittest.TestCase):
    def make(self, responses):
        clk, starts = FakeClock(), []

        def opener(url):
            starts.append(clk.t)
            return responses.pop(0)
        h = A.SharedHttp("binance", 0.3, opener=opener, sleep=clk.sleep, clock=clk)
        return h, starts

    def test_pacing_and_counts(self):
        h, starts = self.make([(200, b"[]", {"x-mbx-used-weight-1m": "7"})] * 3)
        for _ in range(3):
            h.get("u")
        self.assertEqual([round(x, 6) for x in starts], [0.0, 0.3, 0.6])
        st = h.stats()
        self.assertEqual((st["requests"], st["retries"], st["max_used_weight_1m"]), (3, 0, 7))

    def test_429_pauses_then_retries(self):
        h, starts = self.make([(429, b"", {}), (200, b"[]", {}), (200, b"[]", {})])
        h.get("u")
        h.get("v")
        self.assertGreaterEqual(starts[1], 60.0)
        self.assertGreaterEqual(starts[2] - starts[1], 0.3 - 1e-9)
        st = h.stats()
        self.assertEqual((st["requests"], st["retries"], st["status_counts"]), (3, 1, {"429": 1, "200": 2}))

    def test_stops_after_five_retries(self):
        h, starts = self.make([(429, b"", {})] * 6)
        with self.assertRaises(F.FetchStop):
            h.get("u")
        self.assertEqual(len(starts), 6)


if __name__ == "__main__":
    unittest.main()
