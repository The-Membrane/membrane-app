"""Unit tests for a5_fetch_blind4.py: the rank-121-240 selection rule and its exclusions.

Run: python3 -m unittest scripts/research/history-forecasts/test_a5_fetch_blind4.py
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import a5_fetch_blind4 as B  # noqa: E402
import a2_fetch_final_blind as F  # noqa: E402

OLD, NEW = 1546300800, 1700000000  # 2019-01-01 (before the cutoff), 2023-11-14 (after)


class TestExclusions(unittest.TestCase):
    def test_reasons(self):
        bases = {"ETHUP", "ETHDOWN"}
        self.assertEqual(B.exclusion_reason("ALGO", bases), "already used (blind-3 23)")
        self.assertEqual(B.exclusion_reason("DOT", bases), "already used (A3 ten)")
        self.assertEqual(B.exclusion_reason("AVAX", bases), "already used (A2 eight)")
        self.assertEqual(B.exclusion_reason("ETH", bases), "already used (ETH/BTC)")
        self.assertEqual(B.exclusion_reason("TUSD", bases), "stablecoin/fiat/pegged")
        self.assertEqual(B.exclusion_reason("BETH", bases), "wrapped/staked")
        self.assertEqual(B.exclusion_reason("ETHDOWN", bases), "leveraged token")
        self.assertEqual(B.exclusion_reason("TSLAB", bases), "tokenized stock")
        self.assertEqual(B.exclusion_reason("NVDAB", bases), "tokenized stock")  # a4 list carried over
        for crypto in ("CKB", "TRB", "DGB", "ARB"):  # crypto bases ending in B are not stocks
            self.assertIsNone(B.exclusion_reason(crypto, bases))
        self.assertEqual(B.exclusion_reason("STX", bases), "already used (blind-3 23)")  # STXB is the stock

    def test_blind3_set_is_the_23(self):
        self.assertEqual(len(B.BLIND3_23), 23)
        self.assertEqual(len(B.USED), 4)


class TestSelect(unittest.TestCase):
    def test_window_binding_and_cutoff(self):
        ranked = [{"symbol": f"T{i}USDT", "baseAsset": f"T{i}", "quoteVolume": str(1000 - i), "rank": i}
                  for i in range(1, 251)]
        ranked[120]["baseAsset"] = "CRV"    # rank 121: already used, early -> binding
        ranked[121]["baseAsset"] = "AAPLB"  # rank 122: tokenized stock, listed late -> not binding
        probed = []

        def first_open(sym):
            probed.append(sym)
            return (NEW if sym in ("T122USDT", "T123USDT") else OLD), "[]"
        table, kept = B.select(ranked, set(), first_open)
        self.assertEqual([r["rank"] for r in table], list(range(121, 241)))
        self.assertEqual(len(probed), 120)
        self.assertTrue(table[0]["exclusionBinding"])
        self.assertEqual(table[1]["excluded"], "tokenized stock")
        self.assertFalse(table[1]["exclusionBinding"])
        self.assertFalse(table[2]["keep"])
        self.assertEqual(len(kept), 120 - 3)
        self.assertEqual(kept[0]["rank"], 124)
        self.assertEqual(kept[0]["firstKlineOpen"], F.iso_utc(OLD))


if __name__ == "__main__":
    unittest.main()
