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
import hashlib
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
    """Log provider of the synthetic chain; `drop` = (block, log index) pairs it silently leaves out (partial result
    without an error, as the reviewer saw on the public RPCs)."""

    def __init__(self, logs):
        self.logs = logs
        self.drop = set()
        self.calls = []

    def get_logs(self, addresses, topics, lo, hi):
        self.calls.append((tuple(addresses), lo, hi))
        aset = {a.lower() for a in addresses}
        tset = {t.lower() for t in topics}
        return sorted([dict(lg) for lg in self.logs if lg["address"] in aset and lo <= lg["block"] <= hi
                       and lg["topics"][0] in tset and (lg["block"], lg["log_index"]) not in self.drop],
                      key=lambda lg: (lg["block"], lg["log_index"]))

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


def fake_frozen_b4(rng_seed=2):
    """fake_frozen() plus a B4 part with the structure load_frozen_b4 returns."""
    F = fake_frozen()
    rng = np.random.default_rng(rng_seed)
    Dd = 60
    Tf = np.array([(TS0 // 86400 - 6 - Dd + 1 + k) * 86400 for k in range(Dd)], dtype=np.int64)  # ends 10-07
    anchors = np.full((3, Dd), np.nan)
    anchors[0] = 4_500_000 * MICRO
    anchors[0, 40] = 3_000_000 * MICRO                                   # a frozen drawdown for A1
    anchors[1, 30:] = 2_000_000 * MICRO
    anchors[2] = 950_000 * MICRO
    b4 = {"params": {}, "theta4": {}, "Od": {}, "Ed": {}, "mseg": {}, "table": {}, "T": Tf, "anchors": anchors,
          "flags": {xk: {0: np.array([45, 50])} for xk in D.B4_XK}, "check": {"m_seg_equal": True},
          "inputs": {"shipped_meta": {"path": "fake", "sha256": "0" * 64}, "labels_meta": {"path": "fake"}}}
    for c in D.X_CELLS:
        base = -5.5 + 0.4 * c["hi"] - 0.3 * c["xi"]
        b4["params"][c["id"]] = {"params": {"mu": [0.0] * 14, "sd": [1.0] * 14, "coef": list(rng.normal(0, 0.05, 14)),
                                            "intercept": base}, "const_p0": None}
        b4["theta4"][c["id"]] = np.array([1.3, 0.9, 1.0])
        b4["Od"][c["id"]] = np.array([2.0, 0.5, 0.0])
        b4["Ed"][c["id"]] = np.array([1.0, 0.8, 0.0])
        b4["mseg"][c["id"]] = np.array([50.0, 50.0, 50.0, 2.0, 50.0, 1.0])
        for si, sid in enumerate(S.SEG_IDS):
            rung = {"w1": "v4a", "c1": "v4b", "w2": "v2"}.get(sid)
            b4["table"][(c["id"], sid)] = {"rung": rung, "label": "MEDIUM" if rung else "LOW", "label_dev": "LOW",
                                           "holdout_outcome": None, "seg_pop": 0.01 + 0.001 * si, "b3_rung": None}
    F.b4 = b4
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

    def __init__(self, live_logs, xv_logs=(), rounds_after=(), mismatch=(), extra_frozen=()):
        self.root = tempfile.mkdtemp(prefix="q26dep-")
        self.ds = os.path.join(self.root, "datasets")
        self.out = os.path.join(self.root, "out")
        F0 = B0 - 60500                                                    # 2026-10-05 (before the daily gap)
        frozen_rows = [
            ["USDC", F0, ts_of(F0), "0x01", 0, 1, "Mint", A1, A1, 5_000_000 * MICRO, 0, RAY, 5_000_000 * MICRO, ""],
            ["USDC", F0 + 100, ts_of(F0 + 100), "0x02", 0, 1, "Mint", A2, A2, 2_000_000 * MICRO, 0, RAY,
             2_000_000 * MICRO, ""],
            ["USDC", F0 + 200, ts_of(F0 + 200), "0x03", 0, 1, "Mint", A3, A3, 950_000 * MICRO, 0, RAY,
             950_000 * MICRO, ""],
            ["USDC", F0 + 300, ts_of(F0 + 300), "0x04", 0, 1, "Burn", A1, A1, 500_000 * MICRO, 0, RAY,
             -500_000 * MICRO, ""],
        ] + [list(r) for r in extra_frozen]
        frozen_rows.sort(key=lambda r: (r[1], r[5]))
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

    def frozen_sum(self):
        it = D.iter_gz_csv(os.path.join(self.ds, G.DE, "events-usdc-2026.csv.gz"))
        return D.rows_scaled_sum(it, next(it))

    def chain_scaled(self, rpc, block):
        """aToken.scaledTotalSupply() of the synthetic chain: every true log (dropped ones included)."""
        rows = [D.decode_atoken_log(lg) for lg in self.logs.logs if lg["address"] in D.RESERVE_OF_ATOKEN
                and lg["block"] <= block]
        live = D.rows_scaled_sum(iter(rows), D.EV_COLS)
        return {r: self.anchor_chain[r] + live[r] for r in D.RESERVES}

    def common_patches(self, now):
        head = (block_at(now) + 1, ts_of(block_at(now) + 1))
        F = self.frozen_sum()
        offset = {"USDC": -7, "USDT": 0}
        self.anchor_chain = {r: F[r] - offset[r] for r in D.RESERVES}
        return [
            mock.patch.object(D, "verify_frozen_inputs", lambda ds: {"fake": {"sha256": "0" * 64}}),
            mock.patch.object(D, "head_block", lambda rpc: head),
            mock.patch.object(D, "find_block_before", lambda rpc, T, h: (block_at(T), ts_of(block_at(T)),
                                                                          ts_of(block_at(T) + 1))),
            mock.patch.object(D, "get_block", lambda rpc, b: {"number": b, "ts": ts_of(b), "hash": "0x" + "ab" * 32}),
            mock.patch.object(D, "read_scaled_supply", self.chain_scaled),
            mock.patch.object(D, "CHAIN_SCALED_AT_ANCHOR", dict(self.anchor_chain)),
            mock.patch.object(D, "ANCHOR_SCALED_OFFSET", offset),
            mock.patch.object(SC, "frozen_event_inputs", lambda ds: {"fake": True}),
        ]

    def patches(self, now):
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
        return self.common_patches(now) + [
            mock.patch.object(D, "read_reserve_state", lambda rpc, b: STATE if b > block_at(now) - 3000 else STATE24),
            mock.patch.object(D, "read_balances", balances),
            mock.patch.object(D, "read_codes", lambda rpc, addrs, b: {a: {"is_contract": False, "eip7702": False,
                                                                          "code_bytes": 0, "prefix": "0x"} for a in addrs}),
            mock.patch.object(D, "load_xv_frozen", lambda ds, log=print: X),
            mock.patch.object(D, "xv_pools", lambda X_, rpc, b: {}),
            mock.patch.object(D, "xv_price_rows", xv_prices),
            mock.patch.object(D, "build_event_tables", build),
            mock.patch.object(D, "load_b4_inputs", lambda ds, *a: {"fake": True}),
            mock.patch.object(D, "read_incomes", lambda rpc, b: {"USDC": RAY, "USDT": RAY}),
        ]

    def issue(self, now, frozen=None, b4=False):
        ps = self.patches(now)
        for p in ps:
            p.start()
        try:
            return I.issue(self.out, self.ds, FakeRpc(now), self.logs, clock=lambda: now, log=QUIET,
                           frozen=frozen or (fake_frozen_b4() if b4 else fake_frozen()),
                           model_b4=("s.json", "0" * 64, "l.csv", "0" * 64) if b4 else None)
        finally:
            for p in reversed(ps):
                p.stop()

    def score(self, now):
        ps = self.common_patches(now)
        for p in ps:
            p.start()
        try:
            return SC.score(self.out, self.ds, FakeRpc(now), self.logs, clock=lambda: now, log=QUIET)
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
                if q["method"] == "eth_blockNumber":
                    out.append({"jsonrpc": "2.0", "id": q["id"], "result": hex(10 ** 8)})
                    continue
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

    def test_provider_behind_target_is_not_used(self):
        """DL-17: a provider whose own eth_blockNumber is below the range end is skipped (fallback, else STOP)."""
        seen = []

        def post(url, body, timeout):
            q = json.loads(body)
            reqs = q if isinstance(q, list) else [q]
            out = []
            for r in reqs:
                seen.append((url, r["method"]))
                if r["method"] == "eth_blockNumber":
                    out.append({"jsonrpc": "2.0", "id": r["id"], "result": hex(1000 if "mevblocker" in url else 5000)})
                else:
                    lo = int(r["params"][0]["fromBlock"], 16)
                    out.append({"jsonrpc": "2.0", "id": r["id"], "result": [self._log(lo, 0)]})
            return json.dumps(out if isinstance(q, list) else out[0]).encode()
        lc = D.LogsClient(post=post, sleep=lambda s: None)
        got = lc.get_logs([USDC_AT], D.EV_TOPICS, 1500, 1699)
        self.assertEqual(lc.cur, 1)
        self.assertFalse(any(m == "eth_getLogs" for u, m in seen if "mevblocker" in u))
        self.assertEqual([g["block"] for g in got], [1500, 1600])
        with self.assertRaises(C.RpcError):
            D.LogsClient(post=post, sleep=lambda s: None).get_logs([USDC_AT], D.EV_TOPICS, 4000, 6000)


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

    def test_missing_log_stops_issue_before_any_write(self):
        """DL-16: one log missing from the provider's answer (no error) stops the issue before any write, on the
        append path and on the in-memory path up to asof."""
        w = self.w
        w.logs.drop = {(B0 + 200, 5)}                                  # A3's 100k mint, before asof
        with self.assertRaises(SystemExit) as cm:
            w.issue(NOW)
        self.assertIn("incomplete", str(cm.exception))
        self.assertEqual(snapshot_tree(w.out) if os.path.exists(w.out) else {}, {})
        # gap path: issued 7 minutes after H, the store ends before asof; a log in (store end, asof] goes missing
        wg = World(base_live_logs() + [atoken_log("Mint", ASOF - 10, 1, A2, value=10 * MICRO)], base_xv_logs(),
                   rounds_after=[[(1 << 64) | 201, 999_000_000_000, H + 60]], mismatch={A2})
        try:
            wg.logs.drop = {(ASOF - 10, 1)}
            with self.assertRaises(SystemExit) as cm:
                wg.issue(H + 420)
            self.assertIn("up to asof", str(cm.exception))
            self.assertEqual(snapshot_tree(wg.out) if os.path.exists(wg.out) else {}, {})
            wg.logs.drop = set()
            _, doc, _ = wg.issue(H + 420)
            ck = doc["inputs"]["eventStore"]["scaledSupplyCheckAtAsof"]
            self.assertEqual({r: v["residual"] for r, v in ck["reserves"].items()}, {"USDC": 0, "USDT": 0})
            self.assertEqual(doc["inputs"]["eventStore"]["frozenAnchorOffset"], {"USDC": -7, "USDT": 0})
        finally:
            wg.cleanup()

    def test_missing_log_stops_scorer_before_any_write(self):
        w = self.w
        w.issue(NOW)
        late = atoken_log("Burn", block_at(H + 3000), 4, A3, value=10_000 * MICRO)
        w.logs.logs.append(late)
        w.logs.drop = {(late["block"], late["log_index"])}
        before = snapshot_tree(w.out)
        with self.assertRaises(SystemExit) as cm:
            w.score(H + 2 * 3600)
        self.assertIn("incomplete", str(cm.exception))
        self.assertEqual(snapshot_tree(w.out), before)                 # nothing appended, nothing scored
        w.logs.drop = set()
        doc, new = w.score(H + 2 * 3600)
        self.assertTrue(new)
        e = D.read_jsonl(os.path.join(w.ldir(), D.EVENTS_SUB, "fetch-log.jsonl"))[-1]
        self.assertEqual({r: v["residual"] for r, v in e["scaledSupplyCheck"]["reserves"].items()},
                         {"USDC": 0, "USDT": 0})

    def test_write_failure_rolls_back_the_append(self):
        """DL-18: a failure while appending restores every store file to its previous bytes."""
        w = self.w
        w.issue(NOW)
        w.logs.logs.append(atoken_log("Mint", block_at(H + 3000), 4, A3, value=10 * MICRO))
        before = snapshot_tree(w.out)
        real = D.append_jsonl

        def boom(path, entry):
            if path.endswith(os.path.join(D.EVENTS_SUB, "fetch-log.jsonl")):
                raise OSError("disk full")
            return real(path, entry)
        with mock.patch.object(D, "append_jsonl", boom):
            with self.assertRaises(OSError):
                w.score(H + 2 * 3600)
        self.assertEqual(snapshot_tree(w.out), before)

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


def b4_logs(post_amount=3_000_000 * MICRO):
    """base_live_logs plus a live 24 h drop of A2 on 2026-10-14 (a live origin for n_x90)."""
    d14 = (TS0 // 86400 + 1) * 86400                                   # 2026-10-14T00:00Z
    return base_live_logs(post_amount) + [atoken_log("Burn", block_at(d14 + 43200), 2, A2, value=1_000_000 * MICRO)]


class TestModelB4(unittest.TestCase):
    def setUp(self):
        self.w3 = World(b4_logs(), base_xv_logs(), rounds_after=[[(1 << 64) | 201, 999_000_000_000, H + 60]],
                        mismatch={A2})
        self.w4 = World(b4_logs(), base_xv_logs(), rounds_after=[[(1 << 64) | 201, 999_000_000_000, H + 60]],
                        mismatch={A2})

    def tearDown(self):
        self.w3.cleanup()
        self.w4.cleanup()

    def read_csv(self, path):
        import pandas as pd
        return pd.read_csv(path, dtype=str, keep_default_na=False)

    def test_b4_issue_keeps_b3_columns_and_adds_b4(self):
        _, d3, rows3 = self.w3.issue(NOW)
        _, d4, rows4 = self.w4.issue(NOW, b4=True)
        n3 = len(D.CSV_HEADER)
        self.assertEqual([r[:n3] for r in rows4], rows3)                   # B3 columns byte-identical
        self.assertEqual((d4["schema"], d4["model"]), (I.SCHEMA_B4, "B4"))
        self.assertNotIn("model", d3)
        idir = D.issues_dir(self.w4.ldir())
        df = self.read_csv(os.path.join(idir, d4["csvFile"]))
        self.assertEqual(list(df.columns), D.CSV_HEADER_B4)
        self.assertEqual(D.verify_chain(idir), [])
        self.assertEqual(d4["inputs"]["dailyStore"]["daysUsed"], [f"2026-10-{k:02d}" for k in range(8, 16)])
        self.assertEqual(d4["inputs"]["dailyStore"]["gapDays"], [f"2026-10-{k:02d}" for k in range(8, 14)])
        r2 = df[df.address == A2].iloc[0]
        # A2: live origin 2026-10-14 (2M) fell to 1M within 24 h -> one prior x10..x50 exit; 10-15 not yet labelled
        self.assertEqual([r2[f"b4_log1p_n_x90_x{x}"] for x in G.SIZES], [D.fmt_f(np.log1p(1))] * 3 + ["0"] * 2)
        days = (d4["asof"]["ts"] - (TS0 // 86400 + 1) * 86400) / 86400
        self.assertEqual(r2["b4_log1p_days_x10"], D.fmt_f(np.log1p(days)))
        self.assertEqual(float(r2["b4_maxdd90"]), 0.5)
        self.assertEqual((r2["b4_live_days"], r2["b4_live_origins"]), ("8", "7"))       # 10-08..10-14 labelled
        r1 = df[df.address == A1].iloc[0]                                 # frozen flags at days 45, 50; frozen drawdown
        self.assertEqual(r1["b4_log1p_n_x90_x10"], D.fmt_f(np.log1p(2)))
        self.assertAlmostEqual(float(r1["b4_maxdd90"]), 1 - 3 / 4.5, places=9)
        self.assertEqual((r1["segment"], r1["x10_24h_rung4"], r1["x10_24h_label4"]), ("w1", "v4a", "MEDIUM"))
        self.assertEqual(r1["x10_24h_ps4"], r1["x10_24h_v4a"])
        r4 = df[df.address == A4].iloc[0]                                 # new unit: theta 1, live data only
        self.assertEqual(r4["new_unit"], "1")
        F = fake_frozen_b4()
        f4 = D.b4_features_at(F.b4, None, [], 3_000_000 * MICRO, d4["asof"]["ts"])
        x3 = [float(r4[k]) for k in D.FEAT_COLS[:13]]
        g4 = D.forecast_grid_b4(F, x3, f4, None, 0, 3_000_000 * MICRO, 400_000_000 * MICRO,
                                np.full((G.NH, G.NX), 0.01))
        self.assertEqual(r4["x10_24h_v4a"], D.fmt_p(g4["fixed"]["v4a"][2, 0]))
        for rg in ("v4a", "v4b"):
            g = np.array([[float(r1[f"x{x}_{h}_{rg}"]) for x in G.SIZES] for h in G.HNAMES])
            self.assertTrue((np.diff(g, axis=1) <= 1e-12).all() and (np.diff(g, axis=0) >= -1e-12).all())
        self.assertTrue(os.path.exists(os.path.join(self.w4.ldir(), D.DAILY_SUB, "snapshots.csv.gz")))

    def test_gap_fill_adds_the_missed_origin(self):
        """DL-25: a 24 h drop on 2026-10-10 (frozen events, between the last frozen anchor and the first live day)
        counts as a prior origin with the fill and not without it; maxdd90 cannot fall; the B3 columns stay."""
        d10 = (TS0 // 86400 - 3) * 86400                                  # 2026-10-10T00:00Z
        b1, b2 = block_at(d10 + 43200), block_at(d10 + 64800)
        gap = [["USDC", b1, ts_of(b1), "0x0a", 0, 1, "Burn", A1, A1, 1_000_000 * MICRO, 0, RAY, -1_000_000 * MICRO, ""],
               ["USDC", b2, ts_of(b2), "0x0b", 0, 1, "Mint", A1, A1, 1_000_000 * MICRO, 0, RAY, 1_000_000 * MICRO, ""]]
        wa = World(b4_logs(), base_xv_logs(), rounds_after=[[(1 << 64) | 201, 999_000_000_000, H + 60]], mismatch={A2},
                   extra_frozen=gap)
        wb = World(b4_logs(), base_xv_logs(), rounds_after=[[(1 << 64) | 201, 999_000_000_000, H + 60]], mismatch={A2},
                   extra_frozen=gap)
        try:
            with mock.patch.object(I.D, "LIVE_DAILY_FIRST", "2026-10-14"):
                _, da, rows_a = wa.issue(NOW, b4=True)
                ps = wb.patches(NOW)
                for p_ in ps:
                    p_.start()
                try:
                    _, db, rows_b = I.issue(wb.out, wb.ds, FakeRpc(NOW), wb.logs, clock=lambda: NOW, log=QUIET,
                                            frozen=fake_frozen_b4(), model_b4=("s", "0", "l", "0"), gap_fill=False)
                finally:
                    for p_ in reversed(ps):
                        p_.stop()
            n3 = len(D.CSV_HEADER)
            self.assertEqual([r[:n3] for r in rows_a], [r[:n3] for r in rows_b])
            self.assertEqual(db["inputs"]["dailyStore"]["gapDays"], [])
            hb = D.CSV_HEADER_B4
            ra = dict(zip(hb, [r for r in rows_a if r[1] == A1][0]))
            rb = dict(zip(hb, [r for r in rows_b if r[1] == A1][0]))
            self.assertEqual(ra["b4_log1p_n_x90_x10"], D.fmt_f(np.log1p(3)))   # frozen days 45, 50 + 2026-10-10
            self.assertEqual(rb["b4_log1p_n_x90_x10"], D.fmt_f(np.log1p(2)))
            self.assertEqual(ra["b4_log1p_n_x90_x25"], rb["b4_log1p_n_x90_x25"])  # a 22% drop: x10 only
            self.assertEqual(ra["b4_log1p_days_x10"], D.fmt_f(np.log1p((da["asof"]["ts"] - d10) / 86400)))
            self.assertGreaterEqual(float(ra["b4_maxdd90"]), float(rb["b4_maxdd90"]))
            self.assertNotEqual(ra["x10_24h_v4a"], rb["x10_24h_v4a"])
        finally:
            wa.cleanup()
            wb.cleanup()

    def test_b4_table_uses_label_display(self):
        shp = {"cells": {"x10_1h": {s: {"shipped": "v2", "label_final": "MEDIUM", "label_dev": "MEDIUM",
                                        "holdout_outcome": None} for s in S.SEG_IDS}},
               "asof_params": {"x10_1h": {"v2": {"seg_pop": [0.01] * 6}}}}
        labs = {("x10_1h", s): {"shipped": "v2", "label_final": "MEDIUM", "b3_shipped": "", "label_display":
                                "LOW" if s == "w2" else "MEDIUM", "display_reason": "failed B-5 transfer" if s == "w2"
                                else ""} for s in S.SEG_IDS}
        t = D.b4_table(shp, labs, "x10_1h")
        self.assertEqual((t[("x10_1h", "w2")]["label"], t[("x10_1h", "w2")]["label_final"]), ("LOW", "MEDIUM"))
        self.assertEqual(t[("x10_1h", "w1")]["label"], "MEDIUM")
        for v in labs.values():
            v.pop("label_display")
        self.assertEqual(D.b4_table(shp, labs, "x10_1h")[("x10_1h", "w2")]["label"], "MEDIUM")

    def test_b4_no_input_after_asof(self):
        """Perturbing every input after asof leaves the B4 issue identical (B4 features included)."""
        w5 = World([lg if lg["block"] <= ASOF else dict(lg, data="0x" + word(1_234_567 * MICRO) + word(0) + word(RAY))
                    for lg in b4_logs()] + [atoken_log("Burn", ASOF + 2, 9, A1, value=4_000_000 * MICRO)],
                   base_xv_logs(post=1_999_000 * MICRO),
                   rounds_after=[[(1 << 64) | 201, 1, H], [(1 << 64) | 202, 5, H + 9]], mismatch={A2})
        try:
            _, _, rows4 = self.w4.issue(NOW, b4=True)
            _, _, rows5 = w5.issue(NOW, b4=True)
            self.assertEqual(rows4, rows5)
        finally:
            w5.cleanup()
        w6 = World(b4_logs() + [atoken_log("Burn", block_at((TS0 // 86400 + 1) * 86400 + 3600), 7, A1,
                                           value=1_000_000 * MICRO)], base_xv_logs(),
                   rounds_after=[[(1 << 64) | 201, 999_000_000_000, H + 60]], mismatch={A2})
        try:                                                              # power: a pre-asof live drop changes B4
            _, _, rows6 = w6.issue(NOW, b4=True)
            i1 = [r[1] for r in rows4].index(A1)
            n3 = len(D.CSV_HEADER)
            self.assertNotEqual(rows4[i1][n3:], rows6[i1][n3:])
        finally:
            w6.cleanup()

    def test_chain_runs_through_the_model_change(self):
        """A B3 issue, then a B4 issue the next day: the chain links, the scorer handles both schemas."""
        w = self.w4
        _, d1, _ = w.issue(NOW)
        _, d2, _ = w.issue(NOW + D.DAY, b4=True)
        idir = D.issues_dir(w.ldir())
        self.assertEqual(D.verify_chain(idir), [])
        self.assertEqual(d2["prevSha256"], D.sha256_file(os.path.join(idir, d1["date"] + ".json")))
        self.assertEqual((d1.get("model"), d2["model"]), (None, "B4"))
        doc, new = w.score(H + D.DAY + 2 * 3600)
        self.assertEqual(doc["liveCheckModel"], "B4")
        self.assertEqual(doc["resolvedB4IssueDaysPerHorizon"]["1h"], 1)
        self.assertEqual(doc["resolvedIssueDaysPerHorizon"]["1h"], 2)
        cs = doc["cells"]["x10_1h"]["w1"]
        self.assertGreater(cs["ps"]["n"], cs["ps4"]["n"])                 # B3 rungs over both days, B4 over day 2

    def test_scorer_switches_live_check_to_b4(self):
        w = self.w4
        w.issue(NOW, b4=True)
        doc, new = w.score(H + 2 * 3600)
        self.assertEqual(doc["liveCheckModel"], "B4")
        self.assertEqual(doc["liveCheck"]["x10_1h"]["w1"]["rung"], "v4a")
        self.assertEqual(doc["liveCheckB3"]["x10_1h"]["w1"]["rung"], "v2")
        cs = doc["cells"]["x10_1h"]["w1"]
        self.assertEqual(cs["ps4"]["n"], cs["ps"]["n"])
        self.assertIsNotNone(cs["v4b"])
        self.assertEqual(doc["resolvedB4IssueDaysPerHorizon"]["1h"], 1)


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
B4_SHIPPED_SHA = "cc8680c42d3f00ef7f08d84850406153fa082772daf22a3b1d90113aae1bbadf"
# DL-25 gap days: (last block with ts < 00:00Z, its ts, getReserveNormalizedIncome USDC, USDT), read once 2026-10-16
GAP_DAYS = {
    "2026-10-08": (26143955, 1791417599, 1188661172086314648563100430, 1178267553760494198496066548),
    "2026-10-09": (26151122, 1791503999, 1188817812254442089750809885, 1178391106413357554523129678),
    "2026-10-10": (26158300, 1791590399, 1188957520480556031865977926, 1178508136767989009643440109),
    "2026-10-11": (26165481, 1791676799, 1189098148242793538309743679, 1178620947936644409696558030),
    "2026-10-12": (26172657, 1791763199, 1189238843095419522947336435, 1178733282286136370395808554),
    "2026-10-13": (26179841, 1791849599, 1189378042565024009501011224, 1178844119282298430359540511),
}
LABELS_D2_SHA = "140a0d28a276c3b45d6279c6b9ff802b68639363084c89cf31808e6a60e7bd0f"


def gap_days():
    return [{"date": d, "block": v[0], "ts": v[1], "T": D.day_ts(d), "income": {"USDC": v[2], "USDT": v[3]}}
            for d, v in sorted(GAP_DAYS.items())]


def hand_daily(paths, addr, block, income, T, x):
    """Independent of the event tables: scan the decoded events for one address; balance at `block` =
    rayMul(sum of scaled changes, income); y(x, 24 h) from the G.2 changes of the blocks after it."""
    sc, deltas = 0, []
    for p_ in paths:
        it = D.iter_gz_csv(p_)
        hdr = next(it)
        ix = {h: i for i, h in enumerate(hdr)}
        for r in it:
            if r[ix["delta1_raw"]] == "" or (r[ix["party1"]] != addr and r[ix["party2"]] != addr):
                continue
            b, ts = int(r[ix["block"]]), int(r[ix["ts"]])
            for party, dk in (("party1", "delta1_raw"), ("party2", "delta2_raw")):
                if r[ix[party]] != addr or r[ix[dk]] == "":
                    continue
                d = int(r[ix[dk]])
                if r[ix["type"]] == "BalanceTransfer":
                    s_ = int(r[ix["value_raw"]]) * (1 if party == "party2" else -1)
                else:
                    s_ = GE.signed_ray_div(d, int(r[ix["index_ray"]]))
                if b <= block:
                    sc += s_
                else:
                    deltas.append((b, ts, d))
    bal = GE.ray_mul(sc, income)
    deltas.sort()
    run, mn, has = bal, bal, False
    blocks = {}
    for b, ts, d in deltas:
        blocks.setdefault((b, ts), 0)
        blocks[(b, ts)] += d
    for (b, ts), d in sorted(blocks.items()):
        if ts > T + 86400:
            break
        run += d
        if ts > T:
            mn, has = min(mn, run), True
    return bal, bool(has and 100 * mn <= (100 - x) * bal)
B4_LABELS_SHA = "e001e7e7d523008b4db691934475f301cfa4ed6ece273a144bee54955e7206db"


@unittest.skipUnless(DS, "set Q26_DATASETS=<membrane-datasets> for the real-data checks")
class TestRealData(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.tables = D.build_event_tables(DS, cls.tmp, D.FROZEN_ASOF_BLOCK, log=QUIET)
        cls.b4in = D.load_b4_inputs(DS, D.B4_RUN_REL + "shipped-b4.json", B4_SHIPPED_SHA,
                                    D.B4_RUN_REL + "labels-dev.csv", B4_LABELS_SHA)
        cls.F = D.load_frozen(DS, log=QUIET, b4=cls.b4in)

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

    def test_frozen_anchor_scaled_offset(self):
        """DL-16: the frozen events give the recorded anchor offset; the full tables agree with the fast sum."""
        F = D.frozen_scaled_sums(DS)
        self.assertEqual(D.check_frozen_offset(F), D.ANCHOR_SCALED_OFFSET)
        self.assertEqual({r: sum(self.tables[r].scaled.values()) for r in D.RESERVES}, F)

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
        F = self.F
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


    def test_model_b4_reproduces_b4_panel_preview(self):
        """KEY CHECK (B4.5): at the B4 anchor the issuer's v4a / v4b p for the panel-preview units equal results-dev
        panel_preview (1e-9; features exactly), the B4 display equals panel-preview.csv, and the B3 columns are
        unchanged by the B4 part."""
        run = os.path.join(DS, D.RUN_REL)
        b4run = os.path.join(DS, D.B4_RUN_REL)
        man = json.load(open(os.path.join(b4run, "manifest.json")))
        for fn in ("results-dev.json", "panel-preview.csv", "shipped-b4.json", "labels-dev.csv"):
            self.assertEqual(D.sha256_file(os.path.join(b4run, fn)), man["files"][fn]["sha256"])
        rd = json.load(open(os.path.join(b4run, "results-dev.json")))
        live = json.load(open(os.path.join(run, "live-inputs.json")))
        F = self.F
        self.assertTrue(F.b4["check"]["m_seg_equal"])
        X = D.load_xv_frozen(DS, log=QUIET)
        xvf, _ = D.xv_features(X, None, D.FROZEN_ASOF_BLOCK, D.FROZEN_ASOF_TS)
        rounds, _ = D.eth_rounds_upto(DS, None, D.FROZEN_ASOF_BLOCK, D.FROZEN_ASOF_TS)
        rv7, _ = D.rv7_at_asof(rounds, D.FROZEN_ASOF_TS)
        self.assertEqual(rv7, rd["panel_inputs"]["rv7"])
        st = {r: live["asof"]["state"][r] for r in D.RESERVES}
        st24 = {r: live["minus24h"]["state"][r] for r in D.RESERVES}
        recon = {(r["reserve"], r["address"].lower()): int(r["recon_balance_asof_raw"])
                 for r in csv.DictReader(open(os.path.join(DS, G.DE, "extended-universe.csv")))}
        units, rank = [], {}
        for R in D.RESERVES:
            for u in rd["panel_preview"][R]:
                a = u["address"].lower()
                bal = int(round(u["balance_usd"] * MICRO))
                units.append((R, a, recon[(R, a)], bal, {"USDC": 0, "USDT": 0}))
                rank[(R, a)] = u
        rows4, det4, _ = I.compute_rows(F, self.tables, st, st24, rv7, units, {}, {}, True, xvf, D.FROZEN_ASOF_BLOCK,
                                        D.FROZEN_ASOF_TS, "2026-10-13", b4days=[])
        rows3, _, _ = I.compute_rows(F, self.tables, st, st24, rv7, units, {}, {}, True, xvf, D.FROZEN_ASOF_BLOCK,
                                     D.FROZEN_ASOF_TS, "2026-10-13")
        self.assertEqual([r[:len(D.CSV_HEADER)] for r in rows4], rows3)
        pv = {(r["reserve"], int(r["rank"]), r["cell"]): r for r in csv.DictReader(open(os.path.join(
            b4run, "panel-preview.csv")))}
        worst, n = 0.0, 0
        self.assertEqual(len(det4), 20)
        for d in det4:
            u = rank[(d["reserve"], d["address"])]
            self.assertEqual(d["segment"], u["segment"])
            np.testing.assert_array_equal(np.array(d["x3"][:13]), np.array([u["features_v2"][k] for k in G.FEATURES_V2]))
            for xk in D.B4_XK:
                fv = u["features_v4a"][xk]
                self.assertEqual(d["f4"][xk], [fv["log1p_n_x90"], fv["maxdd90"], fv["log1p_days_since_x"]])
            g4 = d["grid4"]
            for c in D.X_CELLS:
                hi, xi = c["hi"], c["xi"]
                cv = u["cells"][c["id"]]
                for rg in D.B4_RUNGS:
                    v = cv["rung_values"][rg]
                    w_ = g4["fixed"][rg][hi, xi]
                    if v is None:
                        self.assertFalse(np.isfinite(w_))
                    else:
                        worst = max(worst, abs(v - w_))
                        n += 1
                dv = g4["disp"][hi, xi]
                self.assertEqual("capped" if not np.isfinite(dv) else G.fmt(dv),
                                 pv[(d["reserve"], u["rank"], c["id"])]["number"])
                self.assertEqual(F.b4["table"][(c["id"], d["segment"])]["label"],
                                 pv[(d["reserve"], u["rank"], c["id"])]["label"])
                if cv["p"] is not None:
                    self.assertLess(abs(cv["p"] - dv), 1e-9)
        self.assertLess(worst, 1e-9)
        self.assertGreater(n, 20 * 3 * 20)


    def test_gap_fill_at_the_anchor(self):
        """DL-25 at the B4 anchor (asof 2026-10-13T23:05Z): the 2026-10-08..10-13 daily balances add exactly the
        missed 24 h origins to n_x90, never lower maxdd90, and the affected units' v4a changes; 3 units are checked
        against the decoded events by hand."""
        F = self.F
        recon = [(r["reserve"], r["address"].lower(), int(r["recon_balance_asof_raw"]))
                 for r in csv.DictReader(open(os.path.join(DS, G.DE, "extended-universe.csv")))
                 if int(r["recon_balance_asof_raw"]) >= G.MIN_BAL]
        days = gap_days()
        affected = []
        for r, a, bal in recon:
            gu = F.unit[(r, a)]
            live = D.live_daily_unit(self.tables[r], r, a, days, D.FROZEN_ASOF_TS)
            fw = D.b4_features_at(F.b4, gu, live, bal, D.FROZEN_ASOF_TS)
            fo = D.b4_features_at(F.b4, gu, [], bal, D.FROZEN_ASOF_TS)
            self.assertGreaterEqual(fw["x10"][1], fo["x10"][1])
            for xk in D.B4_XK:
                n_new = sum(1 for d in live if d["flags"].get(xk))
                self.assertAlmostEqual(np.expm1(fw[xk][0]) - np.expm1(fo[xk][0]), n_new, places=9)
            if any(d["flags"].get("x10") for d in live):
                affected.append((r, a, gu, live, fw, fo, bal))
        self.assertGreater(len(affected), 5)
        print(f"\n  gap fill at the anchor: {len(affected)} of {len(recon)} units gain a 24 h >= 10% origin")
        paths = D.frozen_event_paths(DS)
        for r, a, gu, live, fw, fo, bal in affected[:3]:
            d = next(x for x in live if x["flags"].get("x10"))
            day = next(g for g in days if g["T"] == d["T"])
            hb, hy = hand_daily([p_ for p_ in paths if f"-{r.lower()}-" in p_], a, day["block"], day["income"][r],
                                day["T"], 10)
            self.assertEqual((hb, hy), (d["bal"], True))
            x2 = [0.0] * 13
            seg = 0
            g_w = D.forecast_grid_b4(F, x2, fw, gu, seg, bal, 10 ** 15, np.full((G.NH, G.NX), 0.01))
            g_o = D.forecast_grid_b4(F, x2, fo, gu, seg, bal, 10 ** 15, np.full((G.NH, G.NX), 0.01))
            self.assertFalse(np.array_equal(g_w["raw"]["v4a"], g_o["raw"]["v4a"]))
            print(f"  {r} {a[:10]}..: {day['date']} balance {d['bal'] / 1e6:,.2f} -> log1p n_x90 {fo['x10'][0]:.4f} -> "
                  f"{fw['x10'][0]:.4f}, days {np.expm1(fo['x10'][2]):.2f} -> {np.expm1(fw['x10'][2]):.2f}")

    def test_labels_b4_d2_build(self):
        import importlib
        sys.path.insert(0, os.path.dirname(HERE))
        L = importlib.import_module("b4_labels_d2")
        data, info = L.build(os.path.join(DS, D.B4_RUN_REL))
        self.assertEqual(hashlib.sha256(data).hexdigest(), LABELS_D2_SHA)
        self.assertEqual(sorted(info["failed"]), sorted(L.FAILED))
        self.assertEqual(len(info["c3_no_blind"]), 5)
        rows = list(csv.DictReader(io.StringIO(data.decode())))
        shp = json.load(open(os.path.join(DS, D.B4_RUN_REL, "shipped-b4.json")))
        labs = {(r_["cell"], r_["segment"]): r_ for r_ in rows}
        t = D.b4_table(shp, labs, "x50_6h")
        self.assertEqual((t[("x50_6h", "w2")]["label"], t[("x50_6h", "w2")]["display_reason"]),
                         ("LOW", "failed B-5 transfer"))


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

    def test_chain_scaled_supply_at_anchor(self):
        self.assertEqual(D.read_scaled_supply(D.make_rpc(), D.FROZEN_ASOF_BLOCK), D.CHAIN_SCALED_AT_ANCHOR)

    @unittest.skipUnless(os.environ.get("Q26_SCRATCH_LIVE_DIR"), "set Q26_SCRATCH_LIVE_DIR=<.../q26-deposit-live>")
    def test_scratch_store_end_passes_completeness(self):
        ldir = os.environ["Q26_SCRATCH_LIVE_DIR"]
        st = D.event_store_status(ldir)
        F = D.frozen_scaled_sums(DS)
        ck = D.supply_check(D.make_rpc(), st["coveredBlock"], F, D.store_scaled_sums(ldir), "the scratch store")
        for v in ck["reserves"].values():
            self.assertLessEqual(abs(v["residual"]), D.SUPPLY_TOL)


if __name__ == "__main__":
    unittest.main()
