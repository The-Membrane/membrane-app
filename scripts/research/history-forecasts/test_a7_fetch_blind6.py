"""Unit tests for a7_fetch_blind6.py: the R7.4 selection rule (every rank, first kline before 2023-01-01, fallback
cutoff 2023-07-01 below 20 pairs) and the exclusions (every pair used in A2-A6).

Run: python3 -m unittest scripts/research/history-forecasts/test_a7_fetch_blind6.py
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import a7_fetch_blind6 as B  # noqa: E402
import a2_fetch_final_blind as F  # noqa: E402

OLD = 1546300800      # 2019-01-01
MID = 1680000000      # 2023-03-28 (after the registered cutoff, before the fallback)
NEW = 1700000000      # 2023-11-14 (after both)


def ranked_of(n):
    return [{"symbol": f"T{i}USDT", "baseAsset": f"T{i}", "quoteVolume": str(10000 - i), "rank": i}
            for i in range(1, n + 1)]


class TestExclusions(unittest.TestCase):
    def test_reasons(self):
        bases = {"ETHUP", "ETHDOWN"}
        self.assertEqual(B.exclusion_reason("KSM", bases), "already used (blind-5 42)")
        self.assertEqual(B.exclusion_reason("1INCH", bases), "already used (blind-5 42)")
        self.assertEqual(B.exclusion_reason("SAND", bases), "already used (blind-4 42)")
        self.assertEqual(B.exclusion_reason("ALGO", bases), "already used (blind-3 23)")
        self.assertEqual(B.exclusion_reason("DOT", bases), "already used (A3 ten)")
        self.assertEqual(B.exclusion_reason("AVAX", bases), "already used (A2 eight)")
        self.assertEqual(B.exclusion_reason("ETH", bases), "already used (ETH/BTC)")
        self.assertEqual(B.exclusion_reason("FDUSD", bases), "stablecoin/fiat/pegged")
        self.assertEqual(B.exclusion_reason("WBTC", bases), "wrapped/staked")
        self.assertEqual(B.exclusion_reason("ETHUP", bases), "leveraged token")
        self.assertEqual(B.exclusion_reason("TSLAB", bases), "tokenized stock")
        for crypto in ("TRB", "DGB", "ARB", "IOTA"):
            self.assertIsNone(B.exclusion_reason(crypto, bases))

    def test_used_sets(self):
        self.assertEqual(len(B.BLIND5_42), 42)
        self.assertEqual(len(B.USED), 6)
        n_used = sum(len(v) for v in B.USED.values())
        self.assertEqual(n_used, 2 + 8 + 10 + 23 + 42 + 42)
        self.assertEqual(len(set().union(*B.USED.values())), n_used)   # no base listed twice

    def test_blind5_list_matches_published_selection(self):
        p = F.datasets_dir() / "blind5-prices" / "binance-selection.json"
        if not p.exists():
            self.skipTest("membrane-datasets not checked out")
        import json
        kept = {k["baseAsset"] for k in json.loads(p.read_text())["kept"]}
        self.assertEqual(kept, B.BLIND5_42)


class TestSelect(unittest.TestCase):
    def test_every_rank_registered_cutoff(self):
        ranked = ranked_of(60)
        ranked[0]["baseAsset"] = "KSM"    # used, early -> binding
        ranked[1]["baseAsset"] = "AAPLB"  # tokenized stock, late -> not binding
        probed = []

        def first_open(sym):
            probed.append(sym)
            return (NEW if sym in ("T2USDT", "T3USDT") else MID if sym == "T4USDT" else OLD), "[]"
        table, kept, rule = B.select(ranked, set(), first_open)
        self.assertEqual(len(probed), 60)
        self.assertEqual([r["rank"] for r in table], list(range(1, 61)))
        self.assertTrue(table[0]["exclusionBinding"])
        self.assertFalse(table[1]["exclusionBinding"])
        self.assertFalse(table[3]["keep"])                 # 2023-03 listing is after the registered cutoff
        self.assertEqual(len(kept), 56)
        self.assertEqual(kept[0]["rank"], 5)
        self.assertFalse(rule["cutoff_moved"])
        self.assertEqual(rule["cutoff_used"], "2023-01-01T00:00:00Z")

    def test_cutoff_moves_below_20(self):
        ranked = ranked_of(100)
        old = {f"T{i}USDT" for i in range(1, 11)}       # 10 before 2023-01-01
        mid = {f"T{i}USDT" for i in range(50, 55)}      # 5 in 2023H1

        def first_open(sym):
            return (OLD if sym in old else MID if sym in mid else NEW), "[]"
        table, kept, rule = B.select(ranked, set(), first_open)
        self.assertTrue(rule["cutoff_moved"])
        self.assertEqual(rule["kept_under_registered_cutoff"], 10)
        self.assertEqual(rule["cutoff_used"], "2023-07-01T00:00:00Z")
        self.assertEqual(len(kept), 15)                 # moved once; every pair under the new cutoff is used

    def test_exactly_20_does_not_move(self):
        ranked = ranked_of(40)

        def first_open(sym):
            return (OLD if int(sym[1:-4]) <= 20 else MID), "[]"
        _, kept, rule = B.select(ranked, set(), first_open)
        self.assertFalse(rule["cutoff_moved"])
        self.assertEqual(len(kept), 20)

    def test_cutoff_boundary(self):
        ranked = ranked_of(1)
        _, kept, rule = B.select(ranked, set(), lambda s: (B.CUTOFF_FALLBACK, "[]"))
        self.assertEqual(kept, [])                      # "before" is strict under both cutoffs
        self.assertTrue(rule["cutoff_moved"])
        _, kept, rule = B.select(ranked, set(), lambda s: (B.CUTOFF, "[]"))
        self.assertEqual(len(kept), 1)                  # not before 2023-01-01; kept only after the move
        self.assertEqual(rule["kept_under_registered_cutoff"], 0)

if __name__ == "__main__":
    unittest.main()
