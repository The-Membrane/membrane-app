"""Unit tests for a6_fetch_blind5.py: the rank-241-400 selection rule, its 40-rank extension and the exclusions.

Run: python3 -m unittest scripts/research/history-forecasts/test_a6_fetch_blind5.py
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import a6_fetch_blind5 as B  # noqa: E402
import a2_fetch_final_blind as F  # noqa: E402

OLD, NEW = 1546300800, 1700000000  # 2019-01-01 (before the cutoff), 2023-11-14 (after)


def ranked_of(n):
    return [{"symbol": f"T{i}USDT", "baseAsset": f"T{i}", "quoteVolume": str(10000 - i), "rank": i}
            for i in range(1, n + 1)]


class TestExclusions(unittest.TestCase):
    def test_reasons(self):
        bases = {"ETHUP", "ETHDOWN"}
        self.assertEqual(B.exclusion_reason("SAND", bases), "already used (blind-4 42)")
        self.assertEqual(B.exclusion_reason("CKB", bases), "already used (blind-4 42)")
        self.assertEqual(B.exclusion_reason("ALGO", bases), "already used (blind-3 23)")
        self.assertEqual(B.exclusion_reason("DOT", bases), "already used (A3 ten)")
        self.assertEqual(B.exclusion_reason("AVAX", bases), "already used (A2 eight)")
        self.assertEqual(B.exclusion_reason("BTC", bases), "already used (ETH/BTC)")
        self.assertEqual(B.exclusion_reason("FDUSD", bases), "stablecoin/fiat/pegged")
        self.assertEqual(B.exclusion_reason("WBTC", bases), "wrapped/staked")
        self.assertEqual(B.exclusion_reason("ETHUP", bases), "leveraged token")
        self.assertEqual(B.exclusion_reason("TSLAB", bases), "tokenized stock")
        for crypto in ("TRB", "DGB", "ARB", "IOTA"):
            self.assertIsNone(B.exclusion_reason(crypto, bases))

    def test_used_sets(self):
        self.assertEqual(len(B.BLIND4_42), 42)
        self.assertEqual(len(B.USED), 5)
        self.assertEqual(len(B.USED["blind-3 23"]), 23)
        self.assertTrue(B.TOKENIZED_STOCKS >= {"TSLAB", "NVDAB", "SPYB"})


class TestSelect(unittest.TestCase):
    def test_window_without_extension(self):
        ranked = ranked_of(500)
        ranked[240]["baseAsset"] = "SAND"   # rank 241: used, early -> binding
        ranked[241]["baseAsset"] = "AAPLB"  # rank 242: tokenized stock, listed late -> not binding
        probed = []

        def first_open(sym):
            probed.append(sym)
            return (NEW if sym in ("T242USDT", "T243USDT") else OLD), "[]"
        table, kept, w = B.select(ranked, set(), first_open)
        self.assertEqual([r["rank"] for r in table], list(range(241, 401)))
        self.assertEqual(len(probed), 160)
        self.assertTrue(table[0]["exclusionBinding"])
        self.assertEqual(table[1]["excluded"], "tokenized stock")
        self.assertFalse(table[1]["exclusionBinding"])
        self.assertFalse(table[2]["keep"])
        self.assertEqual(len(kept), 160 - 3)
        self.assertEqual(kept[0]["rank"], 244)
        self.assertEqual(kept[0]["firstKlineOpen"], F.iso_utc(OLD))
        self.assertEqual((w["final"], w["extension_steps"], w["ranking_ended"]), ([241, 400], 0, False))

    def test_extension_in_whole_steps_of_40(self):
        ranked = ranked_of(700)
        old = {f"T{i}USDT" for i in (250, 260, 300, 390, 405, 410, 420, 430, 441, 442)} | \
            {f"T{i}USDT" for i in range(460, 480)}

        def first_open(sym):
            return (OLD if sym in old else NEW), "[]"
        table, kept, w = B.select(ranked, set(), first_open)
        # 241-400: 4 kept; 241-440: 8; 241-480: 30 -> stop at 480, keep all inside it
        self.assertEqual(w["final"], [241, 480])
        self.assertEqual(w["extension_steps"], 2)
        self.assertEqual(len(kept), 30)
        self.assertEqual([r["rank"] for r in table], list(range(241, 481)))

    def test_ranking_ends(self):
        ranked = ranked_of(430)

        def first_open(sym):
            return (OLD if sym in ("T300USDT",) else NEW), "[]"
        table, kept, w = B.select(ranked, set(), first_open)
        self.assertEqual(w["final"], [241, 430])
        self.assertTrue(w["ranking_ended"])
        self.assertEqual(len(kept), 1)


if __name__ == "__main__":
    unittest.main()
