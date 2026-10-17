"""Unit tests for a8_fetch_blind7.py: the R8.3 selection rule (every rank, first kline before 2024-01-01, no fallback:
fewer than 20 pairs -> stop before any fetch) and the exclusions (every pair used in A2-A7).

Run: python3 -m unittest scripts/research/history-forecasts/test_a8_fetch_blind7.py
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import a8_fetch_blind7 as B  # noqa: E402
import a2_fetch_final_blind as F  # noqa: E402

OLD = 1546300800      # 2019-01-01
Y2023 = 1690000000    # 2023-07-22 (before the 2024-01-01 cutoff)
NEW = 1710000000      # 2024-03-09 (after it)


def ranked_of(n):
    return [{"symbol": f"T{i}USDT", "baseAsset": f"T{i}", "quoteVolume": str(10000 - i), "rank": i}
            for i in range(1, n + 1)]


class TestExclusions(unittest.TestCase):
    def test_reasons(self):
        bases = {"ETHUP", "ETHDOWN"}
        self.assertEqual(B.exclusion_reason("LUNC", bases), "already used (blind-6 61)")
        self.assertEqual(B.exclusion_reason("APT", bases), "already used (blind-6 61)")
        self.assertEqual(B.exclusion_reason("KSM", bases), "already used (blind-5 42)")
        self.assertEqual(B.exclusion_reason("SAND", bases), "already used (blind-4 42)")
        self.assertEqual(B.exclusion_reason("ALGO", bases), "already used (blind-3 23)")
        self.assertEqual(B.exclusion_reason("DOT", bases), "already used (A3 ten)")
        self.assertEqual(B.exclusion_reason("AVAX", bases), "already used (A2 eight)")
        self.assertEqual(B.exclusion_reason("ETH", bases), "already used (ETH/BTC)")
        self.assertEqual(B.exclusion_reason("FDUSD", bases), "stablecoin/fiat/pegged")
        self.assertEqual(B.exclusion_reason("WBTC", bases), "wrapped/staked")
        self.assertEqual(B.exclusion_reason("ETHUP", bases), "leveraged token")
        self.assertEqual(B.exclusion_reason("TSLAB", bases), "tokenized stock")
        for crypto in ("ARB", "SUI", "PEPE", "TIA"):
            self.assertIsNone(B.exclusion_reason(crypto, bases))

    def test_used_sets(self):
        self.assertEqual(len(B.BLIND6_61), 61)
        self.assertEqual(len(B.USED), 7)
        n_used = sum(len(v) for v in B.USED.values())
        self.assertEqual(n_used, 2 + 8 + 10 + 23 + 42 + 42 + 61)
        self.assertEqual(len(set().union(*B.USED.values())), n_used)   # no base listed twice

    def test_blind6_list_matches_published_selection(self):
        p = F.datasets_dir() / "blind6-prices" / "binance-selection.json"
        if not p.exists():
            self.skipTest("membrane-datasets not checked out")
        kept = {k["baseAsset"] for k in json.loads(p.read_text())["kept"]}
        self.assertEqual(kept, B.BLIND6_61)

    def test_prereg_pin(self):
        self.assertEqual(B.PREREG["section"], "R8.3")
        self.assertEqual(B.PREREG["commit"], "91a3eba")
        p = Path(__file__).resolve().parents[4] / "membrane-board" / "design" / "Q26_ROUND8_PREREG.md"
        if not p.exists():
            self.skipTest("membrane-board not checked out beside membrane-app")
        import subprocess
        try:
            blob = subprocess.check_output(["git", "-C", str(p.parent.parent), "show",
                                            "91a3eba:design/Q26_ROUND8_PREREG.md"])
        except Exception:
            self.skipTest("commit 91a3eba not available")
        import hashlib
        self.assertEqual(hashlib.sha256(blob).hexdigest(), B.PREREG["sha256"])


class TestSelect(unittest.TestCase):
    def test_every_rank_cutoff_2024(self):
        ranked = ranked_of(60)
        ranked[0]["baseAsset"] = "LUNC"   # used, early -> binding
        ranked[1]["baseAsset"] = "AAPLB"  # tokenized stock, late -> not binding
        probed = []

        def first_open(sym):
            probed.append(sym)
            return (NEW if sym in ("T2USDT", "T3USDT") else Y2023 if sym == "T4USDT" else OLD), "[]"
        table, kept, rule = B.select(ranked, set(), first_open)
        self.assertEqual(len(probed), 60)
        self.assertEqual([r["rank"] for r in table], list(range(1, 61)))
        self.assertTrue(table[0]["exclusionBinding"])
        self.assertFalse(table[1]["exclusionBinding"])
        self.assertTrue(table[3]["keep"])                  # a 2023 listing is kept under R8.3
        self.assertEqual(len(kept), 57)
        self.assertEqual(kept[0]["rank"], 4)
        self.assertTrue(rule["enough"])
        self.assertFalse(rule["cutoff_moved"])
        self.assertEqual(rule["cutoff_used"], "2024-01-01T00:00:00Z")

    def test_no_fallback_below_20(self):
        ranked = ranked_of(100)
        old = {f"T{i}USDT" for i in range(1, 20)}       # 19 before 2024-01-01
        _, kept, rule = B.select(ranked, set(), lambda s: ((OLD if s in old else NEW), "[]"))
        self.assertEqual(len(kept), 19)
        self.assertFalse(rule["enough"])
        self.assertFalse(rule["cutoff_moved"])
        self.assertEqual(rule["cutoff_used"], "2024-01-01T00:00:00Z")

    def test_exactly_20_is_enough(self):
        _, kept, rule = B.select(ranked_of(40), set(), lambda s: ((OLD if int(s[1:-4]) <= 20 else NEW), "[]"))
        self.assertTrue(rule["enough"])
        self.assertEqual(len(kept), 20)

    def test_cutoff_boundary_strict(self):
        _, kept, _ = B.select(ranked_of(1), set(), lambda s: (B.CUTOFF, "[]"))
        self.assertEqual(kept, [])
        _, kept, _ = B.select(ranked_of(1), set(), lambda s: (B.CUTOFF - 3600, "[]"))
        self.assertEqual(len(kept), 1)

    def test_main_stops_before_fetch_when_too_few(self):
        with tempfile.TemporaryDirectory() as d:
            sel = {"cutoffRule": {"enough": False, "kept": 5}, "kept": []}
            Path(d, "selection.json").write_text(json.dumps(sel))
            called = []
            orig = B.A.phase_fetch
            B.A.phase_fetch = lambda *a, **k: called.append(1)
            try:
                rc = B.main(["--work-dir", d, "--out-dir", str(Path(d, "out")), "--phases", "select,fetch"])
            finally:
                B.A.phase_fetch = orig
            self.assertEqual(rc, 3)
            self.assertEqual(called, [])
            self.assertTrue(json.loads(Path(d, "run-log.json").read_text())["sessions"][0]["stopped"])


if __name__ == "__main__":
    unittest.main()
