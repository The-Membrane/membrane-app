#!/usr/bin/env python3
"""Tests for the Q26 per-deposit live log (DEPOSITOR_LIVE.md).

  python3 -m unittest scripts/research/history-forecasts/live_deposit/test_q26_dep.py -v

Synthetic tests (no network, no dataset read): decoding, stores, reconstruction, truth, the full issue path on a
synthetic chain (hash chain, refusal guards, no input after asof), scoring on a synthetic path, eth_getLogs splitting
and fallback.

Real-data tests (Q26_DATASETS=<membrane-datasets>, ~4 min, ~2 GB): the registered frozen sha256 values equal the
PROVENANCE tables / run manifests; live decoding equals the frozen decoded events; per-log deltas equal
bg_gradient.load_events; the event-path reconstruction equals extended-universe recon_balance_asof_raw; and the
KEY CHECK: at the B3 anchor block 26,186,746 the issuer's v2 / v3 / v3s p for the B3 panel units equal
results.json panel_preholdout and results-holdout.json panel_final to 1e-9 (features exactly), and its D1 display
equals panel-d1.csv. Network check (also Q26_NETWORK=1): logs fetched now over a frozen block range decode to the
frozen rows.
"""
import csv
import gzip
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
import warnings
from unittest import mock

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import q26_dep_common as D  # noqa: E402
import q26_dep_issue as I  # noqa: E402
import q26_dep_score as SC  # noqa: E402

G, S, C, GE, XA = D.G, D.S, D.C, D.GE, D.XA
warnings.filterwarnings("ignore")
QUIET = lambda *a, **k: None  # noqa: E731
RAY = 10 ** 27
MICRO = G.MICRO
B0, TS0 = D.FROZEN_ASOF_BLOCK, D.FROZEN_ASOF_TS
A1, A2, A3, A4, A5 = ("0x" + c * 40 for c in "abcde")
USDC_AT, USDT_AT = D.ATOKEN["USDC"], D.ATOKEN["USDT"]
TOK = "0x" + "12" * 20


def pad(a):
    return "0x" + "0" * 24 + a[2:]


def word(v):
    return format(v, "064x")


def ts_of(b):
    return TS0 + 12 * (b - B0)


def block_at(ts):
    """Largest block with ts(b) < ts on the synthetic chain."""
    return B0 + (ts - TS0 - 1) // 12


def atoken_log(kind, block, li, a, b=None, value=0, bi=0, index=RAY, reserve="USDC"):
    at = D.ATOKEN[reserve]
    if kind == "Mint":
        topics, data = [GE.TOPIC_OF["Mint"], pad(b or a), pad(a)], word(value) + word(bi) + word(index)
    elif kind == "Burn":
        topics, data = [GE.TOPIC_OF["Burn"], pad(a), pad(b or a)], word(value) + word(bi) + word(index)
    else:
        topics, data = [GE.TOPIC_OF["BalanceTransfer"], pad(a), pad(b)], word(value) + word(index)
    return {"address": at, "block": block, "log_index": li, "tx_index": 0, "tx": "0x" + format(block * 1000 + li, "064x"),
            "topics": topics, "data": "0x" + data, "ts": ts_of(block), "block_hash": "0x" + "00" * 32}


def xv_transfer(block, li, frm, to, value):
    return {"address": TOK, "block": block, "log_index": li, "tx_index": 0, "tx": "0x" + format(block * 1000 + li, "064x"),
            "topics": [XA.T["Transfer"], pad(frm), pad(to)], "data": "0x" + word(value), "ts": ts_of(block),
            "block_hash": "0x" + "00" * 32}


class FakeLogs:
    def __init__(self, logs):
        self.logs = logs
        self.calls = []

    def get_logs(self, addresses, topics, lo, hi):
        self.calls.append((tuple(addresses), lo, hi))
        aset = {a.lower() for a in addresses}
        tset = {t.lower() for t in topics}
        return [dict(lg) for lg in self.logs if lg["address"] in aset and lo <= lg["block"] <= hi
                and lg["topics"][0] in tset]

    def stats(self):
        return {"fake": True, "calls": len(self.calls)}


class FakeRpc:
    def __init__(self, clock):
        self.clock = clock

    def stats(self):
        return {"fake": True}


def write_gz_csv(path, header, rows):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(header)
    for r in rows:
        w.writerow(r)
    with open(path, "wb") as f:
        f.write(gzip.compress(buf.getvalue().encode(), mtime=0))


def fake_frozen(rng_seed=1):
    """A small frozen model with the B3 structure: 25 x cells, v2 (13 features) / v3 (22), theta_i for 3 units."""
    rng = np.random.default_rng(rng_seed)
    F = D.Frozen()
    F.asof_params, F.theta, F.own, F.pop, F.table = {}, {}, {}, {}, {}
    F.unit = {("USDC", A1): 0, ("USDC", A2): 1, ("USDC", A3): 2}
    F.n_units = 3
    for c in D.X_CELLS:
        base = -6.0 + 0.4 * c["hi"] - 0.3 * c["xi"]
        for ver, nf in (("v2", 13), ("v3", 22)):
            F.asof_params[c["id"] + ":" + ver] = {
                "params": {"mu": [0.0] * nf, "sd": [1.0] * nf, "coef": list(rng.normal(0, 0.05, nf)),
                           "intercept": base},
                "const_p0": None, "pop": 0.01, "theta_seg": [1.1, 1.0, 0.9, 1.2, 1.0, 1.0],
                "seg_pop": [0.01 + 0.001 * k for k in range(6)]}
            F.theta[(c["id"], ver)] = np.array([1.5, 0.8, 1.0])
        F.own[c["id"]] = np.array([0.02, 0.0, 0.01])
        F.pop[c["id"]] = 0.01
        for si, s in enumerate(S.SEG_IDS):
            rung = {"w1": "v2", "w2": "v3s", "c1": "v3"}.get(s)
            F.table[(c["id"], s)] = {"rung": rung, "label": "LOW", "label_final": "LOW", "label_preholdout": "LOW",
                                     "display_reason": "", "seg_pop": 0.01 + 0.001 * si}
    F.first_big_ts = {0: TS0 - 100 * D.DAY, 1: TS0 - 10 * D.DAY}
    F.flags = {A1: {"contract": False, "eip7702": False, "adapter": False},
               A2: {"contract": True, "eip7702": False, "adapter": False},
               A3: {"contract": False, "eip7702": False, "adapter": False}}
    F.theta_seg_check = 0.0
    return F


def fake_xv():
    X = D.XvFrozen()
    X.tokens = [{"address": TOK, "symbol": "vUSD", "family": "Other-4626", "kind": "erc4626", "dec": 6,
                 "underlying": "0x" + "34" * 20, "udec": 6, "deploy_exact": 0}]
    X.tok = {TOK: X.tokens[0]}
    X.snaps = [("2026-10-05", B0 - 8 * 7200, TS0 - 8 * D.DAY), ("asof", B0, TS0)]
    X.sidx = {s[0]: j for j, s in enumerate(X.snaps)}
    X.price = {TOK: np.array([1.0, 1.0])}
    X.S = {(TOK, A1): np.array([0.0, 2e12])}
    X.S0 = {(TOK, A1): 2_000_000_000_000}
    X.flags = fake_frozen().flags
    X.nested, X.adapters = set(), set()
    return X


STATE = {r: {"util": 0.9, "bapr_pct": 5.0, "cash": str(400_000_000 * MICRO), "totalSupply": str(3_000_000_000 * MICRO),
             "normalizedIncome": str(RAY), "variableDebtToken": "0x" + ("71" if r == "USDC" else "72") * 20,
             "variableBorrowRate_ray": "0", "liquidityRate_ray": "0", "variableDebt": "0", "sapr_pct": 0.0}
         for r in D.RESERVES}
STATE24 = {r: dict(STATE[r], util=0.89, bapr_pct=4.9) for r in D.RESERVES}


class World:
    """A synthetic chain + datasets + live root. Frozen events before B0; live logs after it."""

    def __init__(self, live_logs, xv_logs=(), rounds_after=(), mismatch=()):
        self.root = tempfile.mkdtemp(prefix="q26dep-")
        self.ds = os.path.join(self.root, "datasets")
        self.out = os.path.join(self.root, "out")
        frozen_rows = [
            ["USDC", B0 - 500, ts_of(B0 - 500), "0x01", 0, 1, "Mint", A1, A1, 5_000_000 * MICRO, 0, RAY,
             5_000_000 * MICRO, ""],
            ["USDC", B0 - 400, ts_of(B0 - 400), "0x02", 0, 1, "Mint", A2, A2, 2_000_000 * MICRO, 0, RAY,
             2_000_000 * MICRO, ""],
            ["USDC", B0 - 300, ts_of(B0 - 300), "0x03", 0, 1, "Mint", A3, A3, 950_000 * MICRO, 0, RAY,
             950_000 * MICRO, ""],
            ["USDC", B0 - 200, ts_of(B0 - 200), "0x04", 0, 1, "Burn", A1, A1, 500_000 * MICRO, 0, RAY,
             -500_000 * MICRO, ""],
        ]
        write_gz_csv(os.path.join(self.ds, G.DE, "events-usdc-2026.csv.gz"), D.EV_COLS, frozen_rows)
        write_gz_csv(os.path.join(self.ds, G.DE, "events-usdt-2026.csv.gz"), D.EV_COLS, [])
        rr = [[str((1 << 64) | (k + 1)), str(300_000_000_000 + 1_000_000_000 * ((k * 7) % 5)), str(TS0 - 200 * 3600 + 3600 * k)]
              for k in range(200)] + [list(map(str, r)) for r in rounds_after]
        write_gz_csv(os.path.join(self.ds, D.TOUCH_ROUNDS_REL), C.ROUND_HEADER, rr)
        os.makedirs(os.path.join(self.ds, D.TOUCH_LIVE_REL, "rounds"), exist_ok=True)
        with open(os.path.join(self.ds, D.TOUCH_LIVE_REL, "rounds", "fetch-log.jsonl"), "w") as f:
            f.write(json.dumps({"kind": "chainlink", "asset": "ETH", "coveredThrough": TS0 + 400 * D.DAY}) + "\n")
        self.logs = FakeLogs(list(live_logs) + list(xv_logs))
        self.mismatch = set(mismatch)

    def patches(self, now):
        head = (block_at(now) + 1, ts_of(block_at(now) + 1))
        X = fake_xv()

        def balances(rpc, block, pairs, debt_tokens):
            out = {}
            tabs = self._tables
            for r, a in pairs:
                pb = tabs[r].path_balance(a, RAY)
                out[(r, a)] = (pb + (5 * MICRO * 1000 if a in self.mismatch else 0),
                               {"USDC": 7 * MICRO, "USDT": 9 * MICRO})
            return out

        real_build = D.build_event_tables

        def build(datasets, ldir, upto, extra_rows=None, log=print):
            self._tables = real_build(datasets, ldir, upto, extra_rows=extra_rows, log=log)
            return self._tables

        def xv_prices(X_, rpc, block, label, pools):
            return [[label, block, TOK, "vUSD", "erc4626", "convertToAssets(probe)", 10 ** 12, 10 ** 12, "ok"]]
        return [
            mock.patch.object(D, "verify_frozen_inputs", lambda ds: {"fake": {"sha256": "0" * 64}}),
            mock.patch.object(D, "head_block", lambda rpc: head),
            mock.patch.object(D, "find_block_before", lambda rpc, T, h: (block_at(T), ts_of(block_at(T)),
                                                                          ts_of(block_at(T) + 1))),
            mock.patch.object(D, "get_block", lambda rpc, b: {"number": b, "ts": ts_of(b), "hash": "0x" + "ab" * 32}),
            mock.patch.object(D, "read_reserve_state", lambda rpc, b: STATE if b > block_at(now) - 3000 else STATE24),
            mock.patch.object(D, "read_balances", balances),
            mock.patch.object(D, "read_codes", lambda rpc, addrs, b: {a: {"is_contract": False, "eip7702": False,
                                                                          "code_bytes": 0, "prefix": "0x"} for a in addrs}),
            mock.patch.object(D, "load_xv_frozen", lambda ds, log=print: X),
            mock.patch.object(D, "xv_pools", lambda X_, rpc, b: {}),
            mock.patch.object(D, "xv_price_rows", xv_prices),
            mock.patch.object(D, "build_event_tables", build),
        ]

    def issue(self, now, frozen=None):
        ps = self.patches(now)
        for p in ps:
            p.start()
        try:
            return I.issue(self.out, self.ds, FakeRpc(now), self.logs, clock=lambda: now, log=QUIET,
                           frozen=frozen or fake_frozen())
        finally:
            for p in reversed(ps):
                p.stop()

    def score(self, now):
        ps = self.patches(now)[:4]
        for p in ps:
            p.start()
        try:
            return SC.score(self.out, FakeRpc(now), self.logs, clock=lambda: now, log=QUIET)
        finally:
            for p in reversed(ps):
                p.stop()

    def ldir(self):
        return D.live_dir(self.out)

    def cleanup(self):
        shutil.rmtree(self.root, ignore_errors=True)


def snapshot_tree(root):
    out = {}
    for dp, _, fs in os.walk(root):
        for f in fs:
            p = os.path.join(dp, f)
            out[os.path.relpath(p, root)] = D.sha256_file(p)
    return out


# The synthetic day: issuedAt = TS0 + 2 days + 40 min; H = the hour before.
NOW = (TS0 + 2 * D.DAY) // 3600 * 3600 + 2400
H = NOW - NOW % 3600
ASOF = block_at(H)


def base_live_logs(post_amount=3_000_000 * MICRO):
    return [
        atoken_log("Mint", B0 + 100, 3, A4, value=3_000_000 * MICRO),                     # new unit before asof
        atoken_log("Mint", B0 + 200, 5, A3, value=100_000 * MICRO),                       # A3 crosses $1M
        atoken_log("BalanceTransfer", B0 + 300, 2, A5, A5, value=10 * MICRO),            # self-transfer nets 0
        atoken_log("Burn", ASOF + 20, 1, A1, value=post_amount),                          # after asof
        atoken_log("Mint", ASOF + 40, 1, A2, value=post_amount // 3),                     # after asof
    ]


def base_xv_logs(post=500_000 * MICRO):
    return [xv_transfer(B0 + 150, 1, A1, "0x" + "99" * 20, 1_000_000 * MICRO),            # before asof: A1 sends 1M
            xv_transfer(ASOF + 30, 1, A1, "0x" + "99" * 20, post)]                         # after asof


# ---------------------------------------------------------------------------------------------
# Synthetic unit tests
# ---------------------------------------------------------------------------------------------
class TestDecode(unittest.TestCase):
    def test_atoken_rows_follow_g2(self):
        m = D.decode_atoken_log(atoken_log("Mint", 10, 1, A1, A2, value=1000, bi=7, index=2 * RAY))
        self.assertEqual(m[6:9], ["Mint", A1, A2])
        self.assertEqual((m[9], m[10], m[11], m[12], m[13]), (1000, 7, 2 * RAY, 993, ""))
        b = D.decode_atoken_log(atoken_log("Burn", 10, 2, A1, A2, value=1000, bi=7, index=2 * RAY))
        self.assertEqual((b[12], b[13]), (-1007, ""))
        t = D.decode_atoken_log(atoken_log("BalanceTransfer", 10, 3, A1, A2, value=1000, index=2 * RAY))
        self.assertEqual((t[9], t[10], t[12], t[13]), (1000, "", -2000, 2000))
        with self.assertRaises(SystemExit):
            D.decode_atoken_log(dict(atoken_log("Mint", 10, 1, A1), address=TOK))

    def test_scaled_balances_and_logs(self):
        T = {r: D.Reserve(r) for r in D.RESERVES}
        rows = [D.decode_atoken_log(lg) for lg in (
            atoken_log("Mint", 10, 1, A1, value=1_000_000, index=RAY),
            atoken_log("Mint", 11, 1, A1, value=2_000_000, bi=500, index=2 * RAY),
            atoken_log("BalanceTransfer", 12, 4, A1, A1, value=300, index=2 * RAY),
            atoken_log("BalanceTransfer", 12, 5, A1, A2, value=1000, index=2 * RAY),
            atoken_log("Burn", 13, 1, A1, value=999, bi=1, index=2 * RAY))]
        D.scan_rows(iter([[str(x) for x in r] for r in rows]), D.EV_COLS, T)
        U = T["USDC"].finalize()
        s = 1_000_000 + GE.signed_ray_div(1_999_500, 2 * RAY) - 1000 - GE.ray_div(1000, 2 * RAY)
        self.assertEqual(U.scaled[U.amap[A1]], s)
        self.assertEqual(U.path_balance(A1, 2 * RAY), GE.ray_mul(s, 2 * RAY))
        lg = U.logs_of(A1)
        self.assertEqual(list(lg["delta"]), [1_000_000, 1_999_500, 0, -2000, -1000])   # self-transfer nets 0
        bl = U.blocks_of(A1)
        self.assertEqual(list(bl["delta"]), [1_000_000, 1_999_500, -2000, -1000])
        self.assertEqual(U.scaled[U.amap[A2]], 1000)

    def test_anchor_tolerance_is_d2(self):
        self.assertTrue(D.anchor_ok(1_000_000 * MICRO, 1_000_000 * MICRO + 1000 * MICRO)[0])
        self.assertFalse(D.anchor_ok(1_000_000 * MICRO, 1_000_000 * MICRO + 1002 * MICRO)[0])
        self.assertTrue(D.anchor_ok(2 * MICRO, 12 * MICRO)[0])                     # $10 floor
        self.assertFalse(D.anchor_ok(2 * MICRO, 12 * MICRO + 1)[0])


class TestTruth(unittest.TestCase):
    def test_window_and_threshold(self):
        bal = 1_000_000 * MICRO
        Hh = 1_000_000
        blocks = {"block": np.array([99, 101, 102, 103]), "ts": np.array([Hh - 5, Hh, Hh + 10, Hh + 4000]),
                  "delta": np.array([-bal, -bal // 10, -bal // 10, bal // 2])}
        mn, has, n = D.truth_unit(blocks, bal, 100, Hh, 3600)
        # block 99 is at or before asof (ignored); ts == H counts in the path but not in the window min
        self.assertEqual((mn, has, n), (bal - bal // 5, True, 1))
        self.assertEqual(int(G.label_x(np.array([bal]), np.array([mn]), np.array([has]), 10)[0]), 1)
        self.assertEqual(int(G.label_x(np.array([bal]), np.array([mn]), np.array([has]), 25)[0]), 0)
        self.assertEqual(int(G.label_x(np.array([bal]), np.array([bal - bal // 4]), np.array([True]), 25)[0]), 1)
        mn2, has2, _ = D.truth_unit(blocks, bal, 103, Hh, 3600)
        self.assertEqual((mn2, has2), (bal, False))

    def test_episodes(self):
        u = ["a", "a", "a", "b", "a"]
        d = ["2026-10-01", "2026-10-02", "2026-10-04", "2026-10-02", "2026-10-05"]
        self.assertEqual(D.count_episodes_units(u, d, [1, 1, 1, 1, 1]), 3)
        self.assertEqual(D.count_episodes_units(u, d, [0, 1, 0, 1, 1]), 3)
        self.assertEqual(D.count_episodes_units(u, d, [0, 0, 0, 0, 0]), 0)


class TestXvRule(unittest.TestCase):
    def test_base_closest_to_7d_and_window(self):
        X = fake_xv()
        X.snaps = [("d1", B0 - 9 * 7200, TS0 - 9 * D.DAY), ("d2", B0 - 7 * 7200 - 100, TS0 - 7 * D.DAY - 1200),
                   ("asof", B0, TS0)]
        X.price = {TOK: np.array([1.0, 1.0, 1.0])}
        X.S = {(TOK, A1): np.array([1e12, 1e12, 0.85e12])}
        X.S0 = {(TOK, A1): 850_000_000_000}
        out, rule = D.xv_features(X, None, B0, TS0)
        self.assertEqual(rule["base"]["snapshot"], "d2")
        self.assertEqual([w["snapshot"] for w in rule["window"]], ["asof"])
        ov, fl, dr, cnt = out[A1]
        self.assertAlmostEqual(ov, 850_000.0)
        self.assertAlmostEqual(fl, -150_000.0)
        self.assertTrue(dr)
        self.assertEqual(cnt, 1)
        # live asof: snapshots after asof are never used; post-asof deltas are ignored
        live = {"snaps": [("2026-10-20", B0 + 9000, TS0 + 9000 * 12)], "prices": {"2026-10-20": {TOK: 5.0}},
                "deltas": {(TOK, A1): [(B0 + 10, -10 ** 11), (B0 + 5000, -9 * 10 ** 11)]}}
        out2, rule2 = D.xv_features(X, live, B0 + 100, TS0 + 1200, asof_prices={TOK: 1.0})
        self.assertEqual(rule2["window"][-1]["snapshot"], "asof-live")
        self.assertAlmostEqual(out2[A1][0], 750_000.0)


class TestLogsClient(unittest.TestCase):
    def _log(self, b, li, a=None):
        return {"address": a or USDC_AT, "blockNumber": hex(b), "logIndex": hex(li), "transactionIndex": "0x0",
                "transactionHash": "0x" + "00" * 32, "topics": [D.EV_TOPICS[0], pad(A1), pad(A1)],
                "data": "0x" + word(1) + word(0) + word(RAY), "blockTimestamp": hex(ts_of(b))}

    def test_split_on_cap_then_fallback(self):
        calls = []

        def post(url, body, timeout):
            req = json.loads(body)
            reqs = req if isinstance(req, list) else [req]
            calls.append((url, len(reqs)))
            out = []
            for q in reqs:
                p = q["params"][0]
                lo, hi = int(p["fromBlock"], 16), int(p["toBlock"], 16)
                if "mevblocker" in url:
                    if hi - lo + 1 > 5000:
                        out.append({"jsonrpc": "2.0", "id": q["id"], "result": [self._log(lo, i) for i in range(10000)]})
                    elif hi >= 30_000:
                        out.append({"jsonrpc": "2.0", "id": q["id"], "error": {"code": -32000, "message": "down"}})
                    else:
                        out.append({"jsonrpc": "2.0", "id": q["id"], "result": [self._log(lo, 1)]})
                else:
                    out.append({"jsonrpc": "2.0", "id": q["id"], "result": [self._log(lo, 2)]})
            return json.dumps(out if isinstance(req, list) else out[0]).encode()
        lc = D.LogsClient(post=post, sleep=lambda s: None)
        got = lc.get_logs([USDC_AT], D.EV_TOPICS, 20_000, 30_399)
        self.assertTrue(any(n > 1 for u, n in calls if "drpc" in u))               # drpc batches of <= 3
        self.assertTrue(all(n <= 3 for u, n in calls if "drpc" in u))
        self.assertEqual(lc.cur, 1)
        blocks = sorted({g["block"] for g in got})
        self.assertEqual(blocks[0], 20_000)
        self.assertIn(30_000, blocks)                                               # covered by drpc
        self.assertEqual(sum(1 for g in got if 30_000 <= g["block"] <= 30_399), 4)  # 100-block pieces
        with self.assertRaises(D.RangeError):
            D.LogsClient.validate([self._log(5, 1, a=TOK)], [USDC_AT], D.EV_TOPICS, 0, 10)


# ---------------------------------------------------------------------------------------------
# Synthetic issue -> score (full issue path)
# ---------------------------------------------------------------------------------------------
class TestIssueAndScore(unittest.TestCase):
    def setUp(self):
        self.w = World(base_live_logs(), base_xv_logs(),
                       rounds_after=[[(1 << 64) | 201, 999_000_000_000, H + 60]], mismatch={A2})

    def tearDown(self):
        self.w.cleanup()

    def read_csv(self, path):
        import pandas as pd
        return pd.read_csv(path, dtype=str, keep_default_na=False)

    def test_issue_files_chain_guards_and_scoring(self):
        w = self.w
        jpath, doc, rows = w.issue(NOW)
        ldir = w.ldir()
        idir = D.issues_dir(ldir)
        df = self.read_csv(os.path.join(idir, doc["csvFile"]))
        self.assertEqual(list(df.columns), D.CSV_HEADER)
        self.assertEqual(sorted(df["address"]), sorted([A1, A2, A3, A4]))          # A5 below $1M
        st = dict(zip(df["address"], df["status"]))
        self.assertEqual(st[A2], "anchor_mismatch")
        self.assertEqual(st[A1], "ok")
        nu = dict(zip(df["address"], df["new_unit"]))
        self.assertEqual((nu[A4], nu[A1]), ("1", "0"))
        src = dict(zip(df["address"], df["age_source"]))
        self.assertTrue(src[A1].startswith("frozen"))
        self.assertTrue(src[A3].startswith("first live issue"))
        self.assertEqual(dict(zip(df["address"], df["xv_status"]))[A4], "untracked_address")
        self.assertEqual(df.loc[df.address == A1, "vdebt_same_raw"].iloc[0], str(7 * MICRO))
        self.assertEqual(df.loc[df.address == A1, "vdebt_other_raw"].iloc[0], str(9 * MICRO))
        self.assertEqual(doc["asof"]["block"], ASOF)
        self.assertEqual(doc["prevSha256"], D.ZERO_SHA)
        self.assertEqual(D.verify_chain(idir), [])
        self.assertTrue(os.path.exists(os.path.join(ldir, D.UNITS_SUB, "first-seen.csv.gz")))
        self.assertTrue(os.path.exists(os.path.join(ldir, D.CODES_SUB, "holder-codes.csv.gz")))
        # monotone: p non-increasing in x, non-decreasing in h (per rung), display within [0, 1]
        r1 = df[df.address == A1].iloc[0]
        self.assertEqual((r1["segment"], r1["x10_24h_rung"], r1["x10_24h_label"]), ("w1", "v2", "LOW"))
        self.assertEqual(r1["x10_24h_ps"], r1["x10_24h_v2"])
        r2 = df[df.address == A2].iloc[0]
        self.assertEqual((r2["segment"], r2["x10_24h_rung"]), ("c1", "v3"))
        self.assertEqual(df[df.address == A3].iloc[0]["x10_24h_rung"], "v2")
        for rg in ("v2", "v3", "v3s"):
            g = np.array([[float(r1[f"x{x}_{h}_{rg}"]) for x in G.SIZES] for h in G.HNAMES])
            self.assertTrue((np.diff(g, axis=1) <= 1e-12).all() and (np.diff(g, axis=0) >= -1e-12).all())
        # guards: same day refuses before any write
        before = snapshot_tree(w.out)
        with self.assertRaises(SystemExit) as cm:
            w.issue(NOW + 600)
        self.assertIn("dated", str(cm.exception))
        self.assertEqual(snapshot_tree(w.out), before)
        # clock backwards: a later day whose clock is before the last issue
        with mock.patch.object(D, "utc_date", lambda ts: "2099-01-01"):
            with self.assertRaises(SystemExit) as cm:
                w.issue(NOW - 10)
        self.assertIn("clock", str(cm.exception))
        self.assertEqual(snapshot_tree(w.out), before)
        # scoring: 1 h rows resolve once the store covers H + 1 h; 24 h rows stay pending
        doc_s, new = w.score(H + 2 * 3600)
        res = {(o["address"], o["h"]): o for o in new}
        self.assertEqual(res[(A1, "1h")]["status"], "resolved")
        # A1: bal 4.5M at asof; burns 3M after asof -> 66.7% drop
        self.assertEqual([res[(A1, "1h")][f"y_x{x}"] for x in G.SIZES], [1, 1, 1, 0, 0])
        self.assertEqual(res[(A2, "1h")]["status"], "anchor_mismatch")
        self.assertNotIn("y_x10", res[(A2, "1h")])
        self.assertEqual([res[(A3, "1h")][f"y_x{x}"] for x in G.SIZES], [0] * 5)
        self.assertNotIn((A1, "24h"), res)
        self.assertEqual(doc_s["pendingByHorizon"]["24h"], 4)
        # append-only: a second run adds nothing new for resolved rows
        outs = sorted(f for f in os.listdir(os.path.join(ldir, "scores")) if f.startswith("outcomes"))
        size = os.path.getsize(os.path.join(ldir, "scores", outs[0]))
        _, new2 = w.score(H + 2 * 3600 + 60)
        self.assertEqual(new2, [])
        self.assertEqual(os.path.getsize(os.path.join(ldir, "scores", outs[0])), size)
        cs = doc_s["cells"]["x10_1h"]
        self.assertEqual(cs["w1"]["ps"]["n"], 3)                                   # A1, A3, A4; A2 never scored
        self.assertEqual(cs["w1"]["ps"]["sum_y"], 1.0)
        self.assertFalse(doc_s["liveCheck"]["x10_1h"]["w1"]["applied"])
        # tampering with the CSV breaks the chain
        cpath = os.path.join(idir, doc["csvFile"])
        with open(cpath, "ab") as f:
            f.write(b"\x00")
        self.assertTrue(D.verify_chain(idir))
        with self.assertRaises(SystemExit):
            w.score(H + 3 * 3600)

    def test_no_input_after_asof(self):
        """Perturbing every input after asof (aToken events, rounds, cross-venue logs) leaves the issue identical."""
        w2 = World([lg if lg["block"] <= ASOF else dict(lg, data="0x" + word(1_234_567 * MICRO) + word(0) + word(RAY))
                    for lg in base_live_logs()] + [atoken_log("Burn", ASOF + 2, 9, A3, value=900_000 * MICRO)],
                   base_xv_logs(post=1_999_000 * MICRO) + [xv_transfer(ASOF + 1, 3, A1, "0x" + "98" * 20, 10 ** 12)],
                   rounds_after=[[(1 << 64) | 201, 1, H], [(1 << 64) | 202, 5, H + 9]], mismatch={A2})
        try:
            _, d1, rows1 = self.w.issue(NOW)
            _, d2, rows2 = w2.issue(NOW)
            self.assertEqual(rows1, rows2)
            self.assertEqual(d1["rv7"], d2["rv7"])
        finally:
            w2.cleanup()
        # power check: a change before asof does change the issue
        w3 = World(base_live_logs() + [atoken_log("Burn", ASOF - 5, 9, A1, value=100_000 * MICRO)], base_xv_logs(),
                   rounds_after=[[(1 << 64) | 201, 999_000_000_000, H + 60]], mismatch={A2})
        try:
            _, _, rows3 = w3.issue(NOW)
            self.assertNotEqual(rows1, rows3)
        finally:
            w3.cleanup()

    def test_second_day_links_and_gap_path(self):
        """Day 2 links to day 1 (prevSha256, first-seen age); an issue 7 minutes after H (store end < asof, gap
        logs read in memory) gives the same rows as one whose store already covers asof."""
        w = self.w
        _, d1, rows1 = w.issue(NOW)
        _, d2, _ = w.issue(NOW + D.DAY)
        idir = D.issues_dir(w.ldir())
        self.assertEqual(d2["prevSha256"], D.sha256_file(os.path.join(idir, d1["date"] + ".json")))
        self.assertEqual(d2["prevFile"], d1["date"] + ".json")
        self.assertEqual(D.verify_chain(idir), [])
        df2 = self.read_csv(os.path.join(idir, d2["csvFile"]))
        self.assertEqual(float(df2.loc[df2.address == A3, "age_days"].iloc[0]), 1.0)
        self.assertTrue(df2.loc[df2.address == A3, "age_source"].iloc[0].startswith("first live issue 20"))
        w2 = World(base_live_logs(), base_xv_logs(), rounds_after=[[(1 << 64) | 201, 999_000_000_000, H + 60]],
                   mismatch={A2})
        try:
            _, dg, rowsg = w2.issue(H + 420)
            self.assertGreater(dg["inputs"]["eventStore"]["gapLogs"], -1)
            self.assertLess(dg["inputs"]["eventStore"]["status"]["coveredBlock"], ASOF)
            self.assertEqual(rows1, rowsg)
        finally:
            w2.cleanup()

    def test_xv_failure_gives_inputs_unavailable(self):
        w = self.w

        def boom(*a, **k):
            raise C.RpcError("prices down")
        with mock.patch.object(I.D, "xv_read_store", boom):
            _, doc, _ = w.issue(NOW)
        df = self.read_csv(os.path.join(D.issues_dir(w.ldir()), doc["csvFile"]))
        self.assertEqual(set(df["xv_status"]), {"inputs_unavailable"})
        self.assertEqual(set(df["x10_24h_v3"]), {""})
        self.assertNotIn("", set(df["x10_24h_v2"]))
        self.assertEqual(doc["inputs"]["crossVenue"]["status"], "inputs_unavailable")

    def test_event_store_contiguity_and_partial_write(self):
        w = self.w
        w.issue(NOW)
        ldir = w.ldir()
        st = D.event_store_status(ldir)
        self.assertGreater(st["coveredBlock"], ASOF)
        D.append_gz_rows(os.path.join(ldir, D.EVENTS_SUB, "events-2099-01.csv.gz"), D.EV_COLS,
                         [["USDC", st["coveredBlock"] + 5, 1, "0x", 0, 0, "Mint", A1, A1, 1, 0, RAY, 1, ""]])
        with self.assertRaises(SystemExit):
            D.check_store_rows_within_coverage(ldir)
        os.remove(os.path.join(ldir, D.EVENTS_SUB, "events-2099-01.csv.gz"))
        D.append_jsonl(os.path.join(ldir, D.EVENTS_SUB, "fetch-log.jsonl"),
                       {"fromBlock": st["coveredBlock"] + 7, "toBlock": st["coveredBlock"] + 9, "toBlockTs": 1,
                        "fetchedAt": 1})
        with self.assertRaises(SystemExit):
            D.event_store_status(ldir)


class TestFrozenInputGuard(unittest.TestCase):
    def test_sha_mismatch_refuses(self):
        root = tempfile.mkdtemp()
        try:
            for rel in D.FROZEN_INPUTS:
                p = os.path.join(root, rel)
                os.makedirs(os.path.dirname(p), exist_ok=True)
                open(p, "w").write("x")
            with self.assertRaises(SystemExit) as cm:
                D.verify_frozen_inputs(root)
            self.assertIn("sha256 mismatch", str(cm.exception))
        finally:
            shutil.rmtree(root)


# ---------------------------------------------------------------------------------------------
# Real data (Q26_DATASETS)
# ---------------------------------------------------------------------------------------------
DS = os.environ.get("Q26_DATASETS")
INCOME_AT_ANCHOR = {"USDC": 1189499413684287881114549779, "USDT": 1178946273441814945326923375}  # read at 26,186,746


@unittest.skipUnless(DS, "set Q26_DATASETS=<membrane-datasets> for the real-data checks")
class TestRealData(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.tables = D.build_event_tables(DS, cls.tmp, D.FROZEN_ASOF_BLOCK, log=QUIET)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_registered_frozen_sha256_match_provenance(self):
        D.verify_frozen_inputs(DS)
        for sub in (G.DB, G.DE):
            tab = G.prov_table(DS, sub)
            for rel, sha in D.FROZEN_INPUTS.items():
                if rel.startswith(sub) and not rel.endswith("PROVENANCE.md"):
                    self.assertEqual(tab[rel[len(sub):]], sha, rel)
        cv = S.verify_cv(DS)
        for rel, sha in D.FROZEN_INPUTS.items():
            if rel.startswith(S.CV):
                self.assertEqual(cv[rel], sha, rel)
        run = os.path.join(DS, D.RUN_REL)
        man = json.load(open(os.path.join(run, "manifest.json")))
        mand1 = json.load(open(os.path.join(run, "manifest-d1.json")))
        for fn in ("results.json", "shipped-b3.json", "labels.csv"):
            self.assertEqual(man["files"][fn]["sha256"], D.FROZEN_INPUTS[D.RUN_REL + fn])
        self.assertEqual(mand1["files"]["labels-d1.csv"]["sha256"], D.FROZEN_INPUTS[D.RUN_REL + "labels-d1.csv"])
        for rel, sha in G.OTHER_INPUTS.items():
            self.assertEqual(D.FROZEN_INPUTS[rel], sha)

    def test_live_decoder_equals_frozen_decoded_events(self):
        raw = os.path.join(DS, G.DE, "raw-logs-usdc-2026.csv.gz")
        dec = os.path.join(DS, G.DE, "events-usdc-2026.csv.gz")
        want = {}
        it = D.iter_gz_csv(dec)
        next(it)
        for k, row in enumerate(it):
            if row[6] in D.EV_TYPES:
                want[(int(row[1]), int(row[5]))] = row
            if k > 400_000:
                break
        n = 0
        it = D.iter_gz_csv(raw)
        hdr = next(it)
        ix = {h: i for i, h in enumerate(hdr)}
        for row in it:
            key = (int(row[ix["block"]]), int(row[ix["log_index"]]))
            if key not in want:
                continue
            topics = [row[ix[f"topic{j}"]] for j in range(4) if row[ix[f"topic{j}"]]]
            lg = {"address": row[ix["address"]], "block": key[0], "log_index": key[1],
                  "tx_index": int(row[ix["tx_index"]]), "tx": row[ix["tx_hash"]], "topics": topics,
                  "data": row[ix["data"]], "ts": int(want[key][2])}
            got = [str(x) for x in D.decode_atoken_log(lg)]
            self.assertEqual(got, want[key])
            n += 1
            if n >= 50_000:
                break
        self.assertGreater(n, 10_000)

    def test_log_deltas_equal_bg_gradient(self):
        sp = G.reserve_spec(DS, "USDT")
        addrs, _ = G.load_universe(sp["universe"], "USDT")
        logs, _, _, _ = G.load_events(sp["events"], addrs, 1)
        T = self.tables["USDT"]
        for u in range(0, len(addrs), 7):
            m = logs["unit"] == u
            mine = T.logs_of(addrs[u])
            np.testing.assert_array_equal(mine["block"], logs["block"][m])
            np.testing.assert_array_equal(mine["ts"], logs["ts"][m])
            np.testing.assert_array_equal(mine["delta"], logs["delta"][m])

    def test_path_equals_frozen_reconstruction(self):
        n = 0
        for r in csv.DictReader(open(os.path.join(DS, G.DE, "extended-universe.csv"))):
            pb = self.tables[r["reserve"]].path_balance(r["address"].lower(), INCOME_AT_ANCHOR[r["reserve"]])
            self.assertEqual(pb, int(r["recon_balance_asof_raw"]))
            n += 1
        self.assertEqual(n, 7263)

    def test_frozen_model_reproduces_b3_panel(self):
        """KEY CHECK: the issuer at the B3 anchor block reproduces the B3 panel p (results.json, results-holdout.json)."""
        run = os.path.join(DS, D.RUN_REL)
        res = json.load(open(os.path.join(run, "results.json")))
        hold = json.load(open(os.path.join(run, "results-holdout.json")))
        live = json.load(open(os.path.join(run, "live-inputs.json")))
        man = json.load(open(os.path.join(run, "manifest.json")))
        for fn in ("results-holdout.json", "live-inputs.json"):
            self.assertEqual(D.sha256_file(os.path.join(run, fn)), man["files"][fn]["sha256"])
        F = D.load_frozen(DS, log=QUIET)
        self.assertLess(F.theta_seg_check, 1e-9)
        X = D.load_xv_frozen(DS, log=QUIET)
        xvf, rule = D.xv_features(X, None, D.FROZEN_ASOF_BLOCK, D.FROZEN_ASOF_TS)
        self.assertEqual((rule["base"]["snapshot"], [w["snapshot"] for w in rule["window"]]),
                         ("2026-10-07", ["asof_b1", "asof"]))
        rounds, _ = D.eth_rounds_upto(DS, None, D.FROZEN_ASOF_BLOCK, D.FROZEN_ASOF_TS)
        rv7, _ = D.rv7_at_asof(rounds, D.FROZEN_ASOF_TS)
        self.assertEqual(rv7, res["panel_inputs"]["rv7"])
        st = {r: live["asof"]["state"][r] for r in D.RESERVES}
        st24 = {r: live["minus24h"]["state"][r] for r in D.RESERVES}
        units = []
        recon = {(r["reserve"], r["address"].lower()): int(r["recon_balance_asof_raw"])
                 for r in csv.DictReader(open(os.path.join(DS, G.DE, "extended-universe.csv")))}
        for R in D.RESERVES:
            for u in res["panel_preholdout"][R]:
                a = u["address"].lower()
                bal = int(round(u["balance_usd"] * MICRO))
                if u["balance_source"] == "recon":
                    self.assertEqual(bal, recon[(R, a)])
                units.append((R, a, recon[(R, a)], bal, {"USDC": 0, "USDT": 0}))
        rows, detail, _ = I.compute_rows(F, self.tables, st, st24, rv7, units, {}, {}, True, xvf,
                                         D.FROZEN_ASOF_BLOCK, D.FROZEN_ASOF_TS, "2026-10-13")
        pre = {(R, u["address"].lower()): u for R in D.RESERVES for u in res["panel_preholdout"][R]}
        fin = {(R, u["address"].lower()): u for R in D.RESERVES for u in hold["panel_final"][R]}
        d1 = {(r["reserve"], r["address"].lower(), r["cell"]): r["number"]
              for r in csv.DictReader(open(os.path.join(run, "panel-d1.csv")))}
        worst, n = 0.0, 0
        self.assertEqual(len(detail), 20)
        for d in detail:
            k = (d["reserve"], d["address"])
            self.assertEqual(d["segment"], pre[k]["segment"])
            self.assertEqual(d["status"], "ok")
            np.testing.assert_array_equal(np.array(d["x3"]), np.array([pre[k]["features"][f] for f in S.FEATURES_V3]))
            g = d["grid"]
            comp_old = np.full((G.NH, G.NX), np.nan)
            for c in D.X_CELLS:
                hi, xi = c["hi"], c["xi"]
                for src in (pre[k], fin[k]):
                    for rg in D.RUNGS:
                        v = src["cells"][c["id"]]["rung_values"][rg]
                        w_ = g["fixed"][rg][hi, xi]
                        if v is None:
                            self.assertFalse(np.isfinite(w_))
                        else:
                            worst = max(worst, abs(v - w_))
                            n += 1
                dv = g["disp"][hi, xi]
                self.assertEqual("capped" if not np.isfinite(dv) else G.fmt(dv), d1[(k[0], k[1], c["id"])])
                comp_old[hi, xi] = g["ps"][hi, xi]
            old = S.composite_fix(comp_old, g["capx"])                             # the registered (pre-D1) rule
            for c in D.X_CELLS:
                p = pre[k]["cells"][c["id"]]["p"]
                if p is not None:
                    self.assertLess(abs(old[c["hi"], c["xi"]] - p), 1e-9)
        self.assertLess(worst, 1e-9)
        self.assertGreater(n, 2 * 20 * 3 * 20)


@unittest.skipUnless(DS and os.environ.get("Q26_NETWORK"), "set Q26_DATASETS and Q26_NETWORK=1 for the network check")
class TestNetwork(unittest.TestCase):
    def test_fetched_logs_decode_to_frozen_rows(self):
        lo, hi = D.FROZEN_ASOF_BLOCK - 600, D.FROZEN_ASOF_BLOCK
        rows = D.fetch_event_rows(D.LogsClient(), D.make_rpc(), lo, hi)
        want = []
        for r in ("usdc", "usdt"):
            it = D.iter_gz_csv(os.path.join(DS, G.DE, f"events-{r}-2026.csv.gz"))
            next(it)
            want += [row for row in it if lo <= int(row[1]) <= hi and row[6] in D.EV_TYPES]
        key = lambda x: (int(x[1]), int(x[5]))  # noqa: E731
        self.assertEqual(sorted([[str(v) for v in r] for r in rows], key=key), sorted(want, key=key))
        self.assertGreater(len(rows), 10)


if __name__ == "__main__":
    unittest.main()
