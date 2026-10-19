"""Synthetic tests for q26cache (no network, no real addresses).

Run: python3 -m unittest scripts/research/history-forecasts/test_q26cache.py
"""
import gzip
import hashlib
import json
import os
import sys
import tempfile
import threading
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import q26cache as q  # noqa: E402

INVENTORY = """# synthetic inventory

## 1. Prices
| Id | Set | Source | Grade | Use |
|---|---|---|---|---|
| P2 | other venues | REST | **C in effect** | Source-robustness check only, never a blind test |
| P3 | blind8 | klines | A | Blind-test-only |
| D1 | **Aave V2 Ethereum USDC** exits | logs | A | Blind-test-only |

## 12. Addendum (R12.7, owner ruling 10): Gate sets
| Id | Set | Source | Grade | Use |
|---|---|---|---|---|
| B14a | Gate half A | gatedata | A | Blind-test-only. Reserve |
| B14b | Gate half B | gatedata | A | Blind-test-only. Held back behind B14a |

- **Update:** **B14b is reassigned as the confirmatory set for R13.5** (frozen library). **B14a stays reserved and unread**.

## 15. Addendum (R12.9, owner ruling 10): non-ETH sets
| set | content | source | grade | use |
|---|---|---|---|---|
| B17a | 3 tokens (AAA BBB CCC); pools | logs | **A** | **Confirmatory set for R12.9** |
| B17b | 3 tokens (DDD EEE FFF); pools | logs | A | Reserve for a revised R12.9 model. Not acquired or read in R12.9 |

## 16. Addendum (R13.4 library, owner ruling 10)
| Id | Set | Source | Grade | Use |
|---|---|---|---|---|
| FX-A | FX pairs: EURUSD USDJPY | HistData | A | **Confirm**: FX class |
| FX-B | FX pairs: GBPUSD NZDUSD | HistData | A | Held back |
| IDX-A | index CFDs (SPX UKX JPX), outcome windows 2018-01-01..2021-12-31 | same | A | **Confirm**: index class |
| IDX-B | same, 2022-01-01..2026-09-30 | same | A | Held back |
| EQ-A | B3 equities | COTAHIST | A | **Confirm**: R13.4 collapse test |
| EQ-B | B3 equities | COTAHIST | A | Held back |

## 11. Simulator (curator simulator, owner ruling 10)
| Id | Set | Role | Grade | Needs |
|---|---|---|---|---|
| **SV1** | Aave V3 **Base** native USDC | **Confirm** for the Aave slice | B | disclose |
| **L1-P** Aave V3 Polygon debt | **Confirmation** for R11.1-v4 (consumed when scored) | A | note |

- Locked now: SV1. No synthetic path may come from them.
- **Update:** B17a acquired and scored once by R12.9. **B17a is now grade C for the alert**.
"""

SEL_B14 = {"B14a": ["ALPHA", "BRAVO"], "B14b": ["CHARLIE"]}


def make_guard(tmp, with_datasets=True):
    ds = os.path.join(tmp, "datasets")
    if with_datasets:
        os.makedirs(os.path.join(ds, "b14-gate-prices"), exist_ok=True)
        with open(os.path.join(ds, "b14-gate-prices", "selection-b14.json"), "w") as f:
            json.dump(SEL_B14, f)
    return q.BlindGuard(inventory_text=INVENTORY, datasets_dir=ds if with_datasets else tmp + "/none")


class TestInventoryParse(unittest.TestCase):
    def setUp(self):
        self.sets = q.parse_inventory(INVENTORY)

    def test_status_and_owners(self):
        s = self.sets
        self.assertEqual(s["P2"]["status"], "open")
        self.assertEqual(s["B14a"]["owners"], set())
        self.assertEqual(s["B14b"]["owners"], {"R13.5"})
        self.assertEqual(s["B17b"]["owners"], set())          # "revised R12.9" / "not read in R12.9" are not owners
        self.assertEqual(s["FX-A"]["owners"], {"R13.4"})       # bare Confirm inherits the heading item
        self.assertEqual(s["FX-B"]["owners"], set())
        self.assertEqual(s["EQ-A"]["owners"], {"R13.4"})
        self.assertEqual(s["L1-P"]["owners"], {"R11.1-v4"})
        self.assertEqual(s["SV1"]["owners"], set())            # no registered item yet
        self.assertEqual(s["SV1"]["status"], "protected")

    def test_released(self):
        self.assertTrue(self.sets["B17a"]["released"])         # "is now grade C"
        self.assertTrue(self.sets["P3"]["released"])           # RELEASED_BY_BOARD
        self.assertFalse(self.sets["B14b"]["released"])


class TestGuard(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.g = make_guard(self.tmp)

    def test_shared_data_passes(self):
        self.assertIsNone(self.g.check(q.Key("binance", "klines-1h", "XYZUSDT", "2024-01")))
        self.assertIsNone(self.g.check(q.Key("gate", "trades", "ZULU_USDT", "2024-01")))
        self.assertIsNone(self.g.check(q.Key("rpc", "logs:t0", "feed", "1-2", chain="ethereum")))

    def test_reserved_refused_without_owner(self):
        for sym in ("ALPHA_USDT", "ALPHAUSDT", "alpha-usdt"):
            with self.assertRaises(q.BlindSetError):
                self.g.check(q.Key("gate", "trades", sym, "2024-01"))
        with self.assertRaises(q.BlindSetError):          # owner of another set does not help
            self.g.check(q.Key("gate", "trades", "ALPHA_USDT", "2024-01"), owner="R13.5")

    def test_owner_allowed(self):
        self.assertEqual(self.g.check(q.Key("gate", "trades", "CHARLIE_USDT", "2024-01"), owner="R13.5"), "B14b")
        with self.assertRaises(q.BlindSetError):
            self.g.check(q.Key("gate", "trades", "CHARLIE_USDT", "2024-01"), owner="R13.4")

    def test_released_set_is_shared(self):
        self.assertIsNone(self.g.check(q.Key("rpc", "uniswap-v3-swap-logs", "AAA", "1-2", chain="ethereum")))
        with self.assertRaises(q.BlindSetError):
            self.g.check(q.Key("rpc", "uniswap-v3-swap-logs", "DDD", "1-2", chain="ethereum"))

    def test_fx_idx_and_bundles(self):
        with self.assertRaises(q.BlindSetError):
            self.g.check(q.Key("histdata", "m1", "GBPUSD", "2019"))
        self.assertEqual(self.g.check(q.Key("histdata", "m1", "EURUSD", "2019"), owner="R13.4"), "FX-A")
        self.assertIsNone(self.g.check(q.Key("histdata", "m1", "SPXUSD", "2015")))       # dev window
        with self.assertRaises(q.BlindSetError):
            self.g.check(q.Key("histdata", "m1", "SPXUSD", "2023"))                       # IDX-B window
        with self.assertRaises(q.BlindSetError):                                         # yearly file bundles B too
            self.g.check(q.Key("b3", "cotahist-yearly", "COTAHIST_A2010", "2010"), owner="R13.4")

    def test_protocol_sets_and_tags(self):
        with self.assertRaises(q.BlindSetError):
            self.g.check(q.Key("rpc", "aave-v3-pool-logs", "USDC", "1-2", chain="base"))
        self.assertIsNone(self.g.check(q.Key("rpc", "aave-v3-pool-logs", "USDC", "1-2", chain="ethereum")))
        self.assertEqual(self.g.check(q.Key("rpc", "aave-v3-pool-logs", "debt", "1-2", chain="polygon"),
                                      owner="R11.1-v4"), "L1-P")
        with self.assertRaises(q.BlindSetError):           # tag-only set: caller declares it
            self.g.check(q.Key("rpc", "atoken-logs", "x", "1-2", chain="ethereum"), blind_set="D1")

    def test_missing_selection_fails_closed(self):
        g = make_guard(tempfile.mkdtemp(), with_datasets=False)
        with self.assertRaises(q.BlindSetError):
            g.check(q.Key("gate", "trades", "ZULU_USDT", "2024-01"))

    def test_missing_inventory_fails_closed(self):
        with mock.patch.dict(os.environ, {"Q26_BLIND_INVENTORY": "/nonexistent/inv.md"}):
            with self.assertRaises(q.BlindSetError):
                q.BlindGuard()


class TestCache(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.root = os.path.join(self.tmp, "cache")
        self.c = q.Cache(root=self.root, guard=make_guard(self.tmp), max_bytes=10_000_000)

    def test_get_or_fetch_once(self):
        calls = []
        k = q.Key("binance", "klines", "XYZUSDT", "2024-01")

        def fetch():
            calls.append(1)
            return b"payload-1"
        self.assertEqual(self.c.get_or_fetch(k, fetch, source_url="https://example.org/f.zip"), b"payload-1")
        self.assertEqual(self.c.get_or_fetch(k, fetch), b"payload-1")
        self.assertEqual(len(calls), 1)
        man = self.c.manifest(k)
        self.assertEqual(man["sha256"], hashlib.sha256(b"payload-1").hexdigest())
        self.assertEqual(man["source_url"], "https://example.org/f.zip")
        self.assertTrue(man["fetched_utc"].endswith("Z"))

    def test_published_checksum(self):
        k = q.Key("binance", "klines", "XYZUSDT", "2024-02")
        good = hashlib.sha256(b"abc").hexdigest()
        self.assertEqual(self.c.get_or_fetch(k, lambda: b"abc", published_sha256=good), b"abc")
        self.assertEqual(self.c.manifest(k)["published_sha256"], good)
        k2 = q.Key("binance", "klines", "XYZUSDT", "2024-03")
        with self.assertRaises(q.CacheIntegrityError):
            self.c.get_or_fetch(k2, lambda: b"abc", published_sha256="0" * 64)
        self.assertIsNone(self.c.get(k2))

    def test_content_addressed_dedup_and_corruption(self):
        k1 = q.Key("okx", "candles", "A-USDT", "2024-01")
        k2 = q.Key("bybit", "kline", "AUSDT", "2024-01")
        self.c.put(k1, b"same")
        self.c.put(k2, b"same")
        blobs = [f for _, _, fs in os.walk(os.path.join(self.root, "blobs")) for f in fs if f.endswith(".gz")]
        self.assertEqual(len(blobs), 1)
        bp = self.c._blob(self.root, hashlib.sha256(b"same").hexdigest())
        with open(bp, "wb") as f:
            f.write(gzip.compress(b"tampered"))
        self.assertIsNone(self.c.get(k1))                   # sha mismatch -> miss, entry dropped

    def test_refused_key_is_not_fetched(self):
        calls = []
        k = q.Key("gate", "trades", "ALPHA_USDT", "2024-01")
        with self.assertRaises(q.BlindSetError):
            self.c.get_or_fetch(k, lambda: calls.append(1) or b"x")
        self.assertEqual(calls, [])
        self.assertFalse(os.path.exists(os.path.join(self.root, "entries")) and
                         any(os.scandir(os.path.join(self.root, "entries"))))

    def test_owned_data_goes_to_locked_root(self):
        k = q.Key("gate", "trades", "CHARLIE_USDT", "2024-01")
        self.c.get_or_fetch(k, lambda: b"blind-bytes", owner="R13.5")
        self.assertTrue(os.path.isdir(self.root + "-locked/B14b/blobs"))
        self.assertFalse(os.path.exists(os.path.join(self.root, "entries")))
        self.assertEqual(self.c.get(k, owner="R13.5"), b"blind-bytes")
        with self.assertRaises(q.BlindSetError):
            self.c.get(k)

    def test_lru_eviction(self):
        c = q.Cache(root=os.path.join(self.tmp, "small"), guard=make_guard(self.tmp), max_bytes=6000)
        keys = [q.Key("binance", "klines", f"S{i}USDT", "2024-01") for i in range(6)]
        for i, k in enumerate(keys):
            c.put(k, os.urandom(1500))
            if i >= 1:
                c.get(keys[0])                              # keep key 0 hot
        self.assertLessEqual(c.usage(), 6000)
        self.assertIsNotNone(c.get(keys[0]))
        self.assertIsNone(c.get(keys[1]))
        self.assertGreater(c.stats["evicted"], 0)

    def test_json_and_concurrency(self):
        k = q.Key("rpc", "logs:t", "c", "0-9", chain="ethereum")
        errs = []

        def w():
            try:
                self.assertEqual(self.c.get_or_fetch_json(k, lambda: [{"a": 1}]), [{"a": 1}])
            except Exception as e:  # noqa: BLE001
                errs.append(e)
        ts = [threading.Thread(target=w) for _ in range(8)]
        [t.start() for t in ts]
        [t.join() for t in ts]
        self.assertEqual(errs, [])


class TestCachedLogs(unittest.TestCase):
    def test_windows_and_finality(self):
        tmp = tempfile.mkdtemp()
        c = q.Cache(root=os.path.join(tmp, "c"), guard=make_guard(tmp))
        chain_logs = [{"blockNumber": hex(b), "logIndex": "0x0", "data": "0x"} for b in range(0, 300, 7)]
        calls = []

        def fetch(a, b):
            calls.append((a, b))
            return [x for x in chain_logs if a <= int(x["blockNumber"], 16) <= b]
        out = q.cached_get_logs(c, "ethereum", "feed", "0xT", 5, 250, fetch, chunk=100, finalized_block=199)
        self.assertEqual(out, [x for x in chain_logs if 5 <= int(x["blockNumber"], 16) <= 250])
        self.assertEqual(calls, [(5, 99), (100, 199), (200, 250)])
        calls.clear()
        out2 = q.cached_get_logs(c, "ethereum", "feed", "0xT", 5, 250, fetch, chunk=100, finalized_block=199)
        self.assertEqual(out2, out)
        self.assertEqual(calls, [(200, 250)])               # unfinalized window is never cached


class TestBlockTimestamps(unittest.TestCase):
    def test_never_zero(self):
        bt = q.BlockTimestamps(tempfile.mkdtemp())
        self.assertEqual(bt.get_or_fetch("eth", 10, lambda b: {"timestamp": hex(1_600_000_000)}), 1_600_000_000)
        self.assertEqual(bt.get("ethereum", 10), 1_600_000_000)    # alias normalised
        with self.assertRaises(AssertionError):
            bt.get_or_fetch("ethereum", 11, lambda b: {"timestamp": "0x0"})
        with self.assertRaises(AssertionError):
            bt.get_or_fetch("ethereum", 12, lambda b: {})
        with self.assertRaises(AssertionError):
            bt.get_or_fetch("ethereum", 13, lambda b: None)
        self.assertIsNone(bt.get("ethereum", 11))

    def test_fill_logs(self):
        bt = q.BlockTimestamps(tempfile.mkdtemp())
        logs = [{"blockNumber": "0x5", "blockTimestamp": "0x10"}, {"blockNumber": "0x6"},
                {"blockNumber": "0x7", "blockTimestamp": "0x0"}]
        bt.fill_logs("arbitrum", logs, lambda b: {"timestamp": hex(100 + b)})
        self.assertEqual([x["blockTimestamp"] for x in logs], ["0x10", hex(106), hex(107)])
        with self.assertRaises(AssertionError):
            bt.fill_logs("arbitrum", [{"blockNumber": "0x8"}], lambda b: {"timestamp": None})


class TestRedaction(unittest.TestCase):
    def test_env_url_never_shown(self):
        secret = "https://eth-mainnet.example.com/v2/Zz9KkQ8xYyW7vVu6TtS5rR4"
        with mock.patch.dict(os.environ, {"Q26_ETH_RPC_URL": secret}):
            eps = q.rpc_endpoints("eth", ["https://keyless.example.org"])
            self.assertEqual(eps, [secret, "https://keyless.example.org"])
            self.assertEqual(q.redact(secret), "env:Q26_ETH_RPC_URL")
        self.assertEqual(q.rpc_endpoints("ethereum", ["https://k.example.org"]), ["https://k.example.org"])

    def test_routing_state_vs_logs(self):
        secret = "https://eth-mainnet.example.com/v2/Zz9KkQ8xYyW7vVu6TtS5rR4"
        keyless = ["https://keyless.example.org"]
        with mock.patch.dict(os.environ, {"Q26_ETH_RPC_URL": secret}):
            self.assertEqual(q.endpoints_for("ethereum", "eth_getLogs", keyless), keyless)
            for m in ("eth_call", "eth_getBalance", "eth_getBlockByNumber", "eth_blockNumber"):
                self.assertEqual(q.endpoints_for("ethereum", m, keyless)[0], secret)
            self.assertEqual(q.rpc_endpoints("ethereum", keyless, kind="logs"), keyless)
            self.assertEqual(q.provider_log_endpoints("ethereum"), [secret])
            self.assertEqual(q.endpoints_for("arbitrum", "eth_call", keyless), keyless)   # not enabled
        with self.assertRaises(ValueError):
            q.rpc_endpoints("ethereum", keyless, kind="other")

    def test_key_like_parts(self):
        self.assertNotIn("Zz9KkQ8xYyW7vVu6TtS5rR4", q.redact("https://x.example.com/v2/Zz9KkQ8xYyW7vVu6TtS5rR4"))
        self.assertNotIn("abc123secretvalue", q.redact("https://x.example.com/rpc?apikey=abc123secretvalue&n=1"))
        self.assertNotIn("pw", q.redact("https://user:pw@x.example.com/rpc"))
        self.assertEqual(q.redact("https://rpc.example.org"), "https://rpc.example.org")
        self.assertEqual(q.redact("https://data.example.org/data/spot/monthly/klines/ABCUSDT/1h/f.zip"),
                         "https://data.example.org/data/spot/monthly/klines/ABCUSDT/1h/f.zip")

    def test_manifest_stores_redacted(self):
        tmp = tempfile.mkdtemp()
        c = q.Cache(root=os.path.join(tmp, "c"), guard=make_guard(tmp))
        secret = "https://node.example.com/Zz9KkQ8xYyW7vVu6TtS5rR4"
        with mock.patch.dict(os.environ, {"Q26_ARB_RPC_URL": secret}):
            c.put(q.Key("rpc", "logs:t", "c", "1-2", chain="arbitrum"), b"[]", source_url=secret)
        for dp, _, fs in os.walk(tmp):
            for fn in fs:
                with open(os.path.join(dp, fn), "rb") as f:
                    self.assertNotIn(b"Zz9KkQ8xYyW7vVu6TtS5rR4", f.read())


if __name__ == "__main__":
    unittest.main()
