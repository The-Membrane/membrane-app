"""Offline tests for proof_capture.py (no network).

  python -m unittest scripts/proof-capture/test_proof_capture.py

The Oct 10 2025 replay needs membrane-datasets (MEMBRANE_DATASETS_DIR, or ../membrane-datasets next to this repo);
it is skipped when the dataset is absent.
"""
import gzip
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import proof_capture as pc  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATASETS = os.environ.get("MEMBRANE_DATASETS_DIR") or os.path.join(os.path.dirname(REPO), "membrane-datasets")
OCT10 = os.path.join(DATASETS, "oct10-2025", "prices-1m.json")

WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"
USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
WBTC = "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599"


def oct10_rows(col):
    p = json.load(open(OCT10))
    out = []
    for i, (c, lo) in enumerate(zip(p["columns"][col], p["columns"][col + "Low"])):
        if c is None:
            continue
        ts_ms = (p["startTs"] + 60 * i) * 1000
        out.append([ts_ms, c, c, lo if lo is not None else c, c, 0.0])
    return out


def fake_get(series):
    """A stand-in for the Binance klines endpoint over in-memory rows."""
    def get(url):
        q = dict(kv.split("=") for kv in url.split("?", 1)[1].split("&"))
        rows = series.get(q["symbol"], [])
        s, e, n = int(q["startTime"]), int(q["endTime"]), int(q["limit"])
        return [[str(r[0])] + [str(v) for v in r[1:]] for r in rows if s <= r[0] <= e][:n]
    return get


def enc(*vals):
    return "0x" + b"".join(int(v).to_bytes(32, "big") for v in vals).hex()


def topic(a):
    return "0x" + "00" * 12 + a[2:]


class FakeRpc:
    """Answers exactly the calls capture_stage makes, from fixed state."""

    def __init__(self, head=(1000, 2_000_000_000), logs=None):
        self.head = head
        self._logs = logs or {}

    def block(self, tag):
        if tag == "latest":
            return self.head
        return tag, self.head[1] - (self.head[0] - tag) * 12

    def logs(self, address, topic0, lo, hi):
        return [lg for lg in self._logs.get((address, topic0), []) if lo <= int(lg["blockNumber"], 16) <= hi]

    def eth_call(self, to, data, block="latest"):
        sel = data[2:10]
        if sel == pc.SEL["decimals"]:
            return enc({WETH: 18, USDC: 6, WBTC: 8}.get(to, 18))
        if sel == pc.SEL["symbol"]:
            name = {WETH: "WETH", USDC: "USDC", WBTC: "WBTC"}.get(to, "X").encode()
            return "0x" + (32).to_bytes(32, "big").hex() + len(name).to_bytes(32, "big").hex() + name.ljust(32, b"\0").hex()
        if sel == pc.SEL["latestRoundData"]:
            return enc((1 << 64) | 5, 2_000 * 10 ** 8, 0, self.head[1], (1 << 64) | 5)
        if sel == pc.SEL["getRoundData"]:
            rid = int(data[10:], 16)
            return enc(rid, 2_000 * 10 ** 8, 0, self.head[1] - 86_400 * 2 * (5 - (rid & 0xFF)), rid)
        if sel == pc.SEL["idToMarketParams"]:
            return enc(int(USDC, 16), int(WBTC, 16), 0, 0, 86 * 10 ** 16)
        if sel == pc.SEL["getReserveData"]:
            return enc(*([0] * 8 + [int("0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c", 16)] + [0] * 6))
        if sel == pc.SEL["balanceOf"]:
            return enc(100 * 10 ** 6)
        if sel == pc.SEL["totalSupply"]:
            return enc(1_000 * 10 ** 6)
        raise ValueError("unexpected call " + sel)


class KeccakAndAbi(unittest.TestCase):
    def test_pinned(self):
        pc.self_test()

    def test_decode_aave(self):
        log = {"blockNumber": hex(990), "logIndex": "0x1", "transactionHash": "0xab",
               "topics": [pc.TOPIC["aave_liq"], topic(WETH), topic(USDC), topic("0x" + "11" * 20)],
               "data": enc(1_000 * 10 ** 6, 525 * 10 ** 15, int("0x" + "22" * 20, 16), 0)}
        d = pc.decode_aave_liq(log)
        self.assertEqual((d["collateral_asset"], d["debt_asset"], d["borrower"]), (WETH, USDC, "0x" + "11" * 20))
        self.assertEqual((d["debt_repaid_raw"], d["collateral_seized_raw"]), (str(10 ** 9), str(525 * 10 ** 15)))


class Detectors(unittest.TestCase):
    def test_price_drop_threshold(self):
        rows = [[i * 60_000, 100, 100, 100, 100, 0] for i in range(200)]
        rows[-1] = [199 * 60_000, 100, 100, 94.0, 95, 0]
        self.assertIsNotNone(pc.detect_price_drop(rows, [{"minutes": 60, "drop": 0.05}]))
        self.assertIsNone(pc.detect_price_drop(rows, [{"minutes": 60, "drop": 0.07}]))

    def test_old_drop_is_not_recent(self):
        rows = [[i * 60_000, 100, 100, 100, 100, 0] for i in range(300)]
        rows[10] = [600_000, 100, 100, 80.0, 80, 0]
        self.assertIsNone(pc.detect_price_drop(rows, [{"minutes": 480, "drop": 0.05}]))

    def test_merge_and_cooldown(self):
        cap = {"merge_window_hours": 6, "cooldown_hours": 24}
        st = {"events": {}}
        e1 = pc.open_or_merge(st, [{"detector": "btc-drop"}], 1_000_000, cap)
        e2 = pc.open_or_merge(st, [{"detector": "eth-drop"}], 1_000_000 + 3600, cap)
        self.assertEqual(e1, e2)                      # one cascade, one event
        self.assertIsNone(pc.open_or_merge(st, [{"detector": "btc-drop"}], 1_000_000 + 7200, cap))  # cooldown

    @unittest.skipUnless(os.path.exists(OCT10), "membrane-datasets oct10-2025 not present")
    def test_oct10_replay_fires_and_quiet_morning(self):
        series = {"BTCUSDT": oct10_rows("btcSpot"), "ETHUSDT": oct10_rows("ethSpot")}
        cfg = json.load(open(os.path.join(pc.HERE, "detectors.json")))
        cfg["detectors"] = [d for d in cfg["detectors"] if d["symbol"] in series]
        start = json.load(open(OCT10))["startTs"]
        quiet = pc.run_detectors(cfg, start + 12 * 3600, get=fake_get(series))      # 12:00 UTC Oct 10
        self.assertEqual(quiet, [])
        hits = {f["detector"]: f for f in pc.run_detectors(cfg, start + 21 * 3600 + 30 * 60, get=fake_get(series))}
        self.assertIn("btc-drop", hits)                                               # 21:30 UTC, mid-cascade
        self.assertIn("eth-drop", hits)
        for f in hits.values():
            print(f"\n  oct10 {f['detector']}: -{f['drop']:.1%} in <= {f['window_minutes']} min")


class EndToEnd(unittest.TestCase):
    def test_stage_files_and_receipt(self):
        now = 2_000_000_000
        trig = now - 3600
        minute0 = (trig - 24 * 3600) // 60 * 60
        rows = [[(minute0 + 60 * i) * 1000, 2000.0, 2000.0, 2000.0, 2000.0, 0] for i in range(25 * 60 + 2)]
        series = {"BTCUSDT": [[r[0], 60_000.0, 60_000.0, 60_000.0, 60_000.0, 0] for r in rows], "ETHUSDT": rows,
                  "USDEUSDT": [], "USDCUSDT": []}
        aave = {"blockNumber": hex(990), "logIndex": "0x1", "transactionHash": "0xab",
                "topics": [pc.TOPIC["aave_liq"], topic(WETH), topic(USDC), topic("0x" + "11" * 20)],
                # 1,000 USDC repaid, 0.525 WETH seized at $2,000 = $1,050: cost $50 (5%)
                "data": enc(1_000 * 10 ** 6, 525 * 10 ** 15, int("0x" + "22" * 20, 16), 0)}
        morpho = {"blockNumber": hex(995), "logIndex": "0x2", "transactionHash": "0xcd",
                  "topics": [pc.TOPIC["morpho_liq"], "0x" + "33" * 32, topic("0x" + "44" * 20), topic("0x" + "55" * 20)],
                  # 6,000 USDC repaid, 0.104 WBTC seized at $60,000 = $6,240: cost $240 (4%)
                  "data": enc(6_000 * 10 ** 6, 1, 10_400_000, 0, 0)}
        cfg = json.load(open(os.path.join(pc.HERE, "detectors.json")))
        rpc = FakeRpc(head=(1000, now), logs={(cfg["capture"]["aave_pool"], pc.TOPIC["aave_liq"]): [aave],
                                             (cfg["capture"]["morpho_blue"], pc.TOPIC["morpho_liq"]): [morpho]})
        with tempfile.TemporaryDirectory() as out:
            os.makedirs(os.path.join(out, "proofs"))
            st = {"events": {"E": {"id": "E", "trigger_ts": trig, "triggers": [
                {"detector": "eth-drop", "kind": "price_drop", "symbol": "ETHUSDT", "drop": 0.1, "window_minutes": 60,
                 "threshold": 0.07, "peak": 2222.0, "trough": 2000.0, "detected_ts": trig}],
                "stages_done": [], "closed": False}}}
            json.dump(st, open(os.path.join(out, "proofs", "state.json"), "w"))
            pc.run(out, now, get=fake_get(series), rpc=rpc)
            sdir = os.path.join(out, "proofs", "E", "stage-00h")
            names = set(os.listdir(sdir))
            self.assertEqual(names, {"prices.json.gz", "chainlink.json.gz", "liquidations.json.gz", "venues.json",
                                     "receipt.json", "manifest.json"})
            r = json.load(open(os.path.join(sdir, "receipt.json")))
            a, m = r["liquidations"]["aave-v3"], r["liquidations"]["morpho-blue"]
            self.assertAlmostEqual(a["cost_usd"], 50.0, places=2)
            self.assertAlmostEqual(a["cost_pct_of_repaid"], 0.05, places=4)
            self.assertAlmostEqual(m["cost_usd"], 240.0, places=2)
            self.assertEqual(r["venues"]["aave-v3:USDC"]["utilization"], 0.9)
            self.assertEqual(json.load(open(os.path.join(sdir, "manifest.json")))["failed"], [])
            liq = json.loads(gzip.decompress(open(os.path.join(sdir, "liquidations.json.gz"), "rb").read()))
            self.assertEqual(len(liq["events"]), 2)
            cl = json.loads(gzip.decompress(open(os.path.join(sdir, "chainlink.json.gz"), "rb").read()))
            self.assertGreaterEqual(len(cl["rounds"]["ETH/USD"]), 2)
            self.assertIn("aave-v3", open(os.path.join(out, "proofs", "E", "receipt.md")).read())
            # the same stage is never taken twice; files are never rewritten
            pc.run(out, now + 60, get=fake_get(series), rpc=rpc)
            self.assertEqual(sorted(os.listdir(os.path.join(out, "proofs", "E"))),
                             ["PROVENANCE.md", "receipt.md", "stage-00h"])


if __name__ == "__main__":
    unittest.main()
