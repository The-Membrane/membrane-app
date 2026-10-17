#!/usr/bin/env python3
"""Synthetic tests for Q26 R8.4 (l1_pool_risk.py, l1_acquire_cash.py).

  python3 -m unittest scripts/research/history-forecasts/test_l1_pool_risk.py -v
"""
import json
import os
import sys
import tempfile
import unittest

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import l1_pool_risk as L  # noqa: E402
import l1_acquire_cash as A  # noqa: E402

D0 = L.day_ts("2023-02-01")


def rs_frame(n=4, cash=1_000 * 10 ** 6, supply=10_000 * 10 ** 6):
    rows = []
    for i in range(n):
        rows.append({"snapshot": L.ts_day(D0 + 86400 * i), "block": 100 * (i + 1), "block_ts": D0 + 86400 * i - 1,
                     "supply": supply, "cash": cash, "vdebt": supply - cash, "liq_rate": 0.02, "vb_rate": 0.04})
    return pd.DataFrame(rows)


def part(rows):
    return pd.DataFrame([{"block": b, "ts": t, "tx_index": tx, "log_index": li, "dcash": dc, "dsupply": ds,
                          "liq_rate": lr, "vb_rate": np.nan} for b, t, tx, li, dc, ds, lr in rows]).astype(
        {"dcash": np.int64, "dsupply": np.int64})


class TestTimeline(unittest.TestCase):
    def test_cash_exact_and_intra_tx(self):
        rs = rs_frame(2)
        # snapshot 0 block 100 cash 1000 USD; tx at block 150: flash-loan out 990 then back in 990 (one tx);
        # tx at block 160 withdraw 400 (cash 600 USD, supply -400). snapshot 1 block 200 must read 600 USD cash.
        rs.loc[1, "cash"] = 600 * 10 ** 6
        rs.loc[1, "supply"] = 9_600 * 10 ** 6
        p = part([(150, D0 + 10, 1, 0, -990 * 10 ** 6, 0, np.nan), (150, D0 + 10, 1, 1, 990 * 10 ** 6, 0, np.nan),
                  (160, D0 + 20, 2, 0, -400 * 10 ** 6, -400 * 10 ** 6, 0.03)])
        tl, chk = L.tx_timeline([p], rs, 10 ** 9)
        self.assertEqual(chk["cashMismatches"], 0)
        self.assertEqual(len(tl), 2)                       # flash-loan legs collapse into one tx state
        self.assertAlmostEqual(tl["cash"].iloc[0], 1000.0)  # the intra-tx 10 USD state is not an event time
        self.assertAlmostEqual(tl["cash"].iloc[1], 600.0)
        self.assertAlmostEqual(tl["supply"].iloc[1], 9600.0)

    def test_cash_mismatch_detected(self):
        rs = rs_frame(2)
        p = part([(150, D0 + 10, 1, 0, -5, 0, np.nan)])
        _, chk = L.tx_timeline([p], rs, 10 ** 9)
        self.assertEqual(chk["cashMismatches"], 1)

    def test_supply_reanchors_each_snapshot(self):
        rs = rs_frame(3)
        rs.loc[1, "supply"] = 20_000 * 10 ** 6          # snapshot 1 jumps (e.g. accrual); later tx anchor there
        rs.loc[2, "supply"] = 20_000 * 10 ** 6 + 5 * 10 ** 6
        p = part([(150, D0 + 10, 1, 0, 0, 7 * 10 ** 6, np.nan), (250, D0 + 86400 + 10, 1, 0, 0, 5 * 10 ** 6, np.nan)])
        tl, _ = L.tx_timeline([p], rs, 10 ** 9)
        self.assertAlmostEqual(tl["supply"].iloc[0], 10_007.0)
        self.assertAlmostEqual(tl["supply"].iloc[1], 20_005.0)


class TestLabels(unittest.TestCase):
    def tl(self, rows):
        return pd.DataFrame(rows, columns=["ts", "ratio", "liq_rate"])

    def test_lock_window_bounds(self):
        hs = L.HORIZONS["24h"]
        panel = pd.DataFrame({"t0": [D0, D0 + 86400], "r0": [0.02, 0.02]})
        # lock exactly at t0 of day 0 (excluded: window is open at t0) and exactly at t0 + 24h (included)
        tl = self.tl([(D0, 0.001, np.nan), (D0 + 100, 0.2, np.nan), (D0 + hs, 0.004, np.nan),
                      (D0 + 86400 + 50, 0.2, np.nan), (D0 + 9 * 86400, 0.2, np.nan)])
        y = L.labels(panel, tl, end_ts=D0 + 10 * 86400)
        self.assertEqual(y["LOCK_24h"].tolist(), [1.0, 0.0])

    def test_lock_needs_strictly_below(self):
        panel = pd.DataFrame({"t0": [D0], "r0": [0.02]})
        tl = self.tl([(D0 + 5, 0.005, np.nan)])
        self.assertEqual(L.labels(panel, tl, end_ts=D0 + 10 * 86400)["LOCK_24h"].iloc[0], 0.0)

    def test_spike_both_conditions(self):
        panel = pd.DataFrame({"t0": [D0, D0, D0], "r0": [0.02, 0.05, 0.001]})
        tl = self.tl([(D0 + 5, 0.2, 0.05), (D0 + 6, 0.2, np.nan)])
        y = L.labels(panel, tl, end_ts=D0 + 10 * 86400)["SPIKE_24h"].tolist()
        # 0.05 >= 2*0.02 and >= 0.02+0.03 -> 1; r0 0.05 -> no; r0 0.001: 0.05 >= 0.002 and >= 0.031 -> 1
        self.assertEqual(y, [1.0, 0.0, 1.0])
        panel = pd.DataFrame({"t0": [D0], "r0": [0.01]})
        tl = self.tl([(D0 + 5, 0.2, 0.039)])   # 2x yes, +3 pp no
        self.assertEqual(L.labels(panel, tl, end_ts=D0 + 10 * 86400)["SPIKE_24h"].iloc[0], 0.0)

    def test_uncovered_window_is_nan(self):
        panel = pd.DataFrame({"t0": [D0], "r0": [0.02]})
        tl = self.tl([(D0 + 5, 0.2, 0.02)])
        y = L.labels(panel, tl, end_ts=D0 + 3 * 86400)
        self.assertEqual(y["LOCK_24h"].iloc[0], 0.0)
        self.assertTrue(np.isnan(y["LOCK_7d"].iloc[0]))

    def test_spells_merge(self):
        tl = pd.DataFrame({"ts": [0, 10, 20, 3600, 3700, 200000, 200100],
                           "ratio": [0.1, 0.001, 0.1, 0.001, 0.1, 0.001, 0.1]})
        sp = L.lock_spells(tl)
        self.assertEqual(sp, [[10, 3700], [200000, 200100]])

    def test_episodes(self):
        e = L.episodes(["2024-01-01", "2024-01-02", "2024-01-04"])
        self.assertEqual(e, [("2024-01-01", "2024-01-02"), ("2024-01-04", "2024-01-04")])


class TestFeatures(unittest.TestCase):
    def test_rv7_no_lookahead(self):
        ts = D0 + 3600 * np.arange(400)
        rng = np.random.default_rng(1)
        px = 1000 * np.exp(np.cumsum(rng.normal(0, 0.01, 400)))
        t0 = int(ts[300])
        v = L.eth_rv7(ts, px, t0)
        px2 = px.copy()
        px2[300:] *= 3.0                                  # bars stamped >= t0 change
        self.assertEqual(v, L.eth_rv7(ts, px2, t0))
        px3 = px.copy()
        px3[299] *= 3.0                                   # bar stamped t0 - 1 h is used
        self.assertNotEqual(v, L.eth_rv7(ts, px3, t0))
        r = np.diff(np.log(px[299 - 168:300]))
        self.assertAlmostEqual(v, float(np.sqrt((r * r).sum())))

    def test_feature_row_uses_only_t0_and_previous_day(self):
        rs = rs_frame(3)
        rs["vb_rate"] = [0.04, 0.05, 0.09]
        ts = D0 - 400 * 3600 + 3600 * np.arange(1000)
        px = np.full(1000, 1000.0)
        f = L.features(rs, {s: 5_000.0 for s in rs["snapshot"]}, ts, px)
        self.assertTrue(np.isnan(f["d_borrow_apr"].iloc[0]))
        self.assertAlmostEqual(f["d_borrow_apr"].iloc[1], 0.01)
        self.assertAlmostEqual(f["util"].iloc[0], 0.9)
        self.assertAlmostEqual(f["cash_supply"].iloc[0], 0.1)
        self.assertAlmostEqual(f["top10_share"].iloc[0], 0.5)
        self.assertAlmostEqual(f["s10_shortfall_cash"].iloc[0], 4.0)
        self.assertEqual(f["eth_rv7"].iloc[0], 0.0)


class TestModel(unittest.TestCase):
    def test_ridge_matches_sklearn_c1(self):
        try:
            from sklearn.linear_model import LogisticRegression
        except ImportError:
            self.skipTest("no sklearn")
        rng = np.random.default_rng(3)
        X = rng.normal(size=(500, 4))
        y = (rng.random(500) < 1 / (1 + np.exp(-(X @ [1.0, -2.0, 0.5, 0.0] - 1)))).astype(float)
        w = L.ridge_logit(X, y, lam=1.0)
        sk = LogisticRegression(C=1.0, tol=1e-12, max_iter=10000).fit(X, y)
        np.testing.assert_allclose(w[0], sk.intercept_[0], atol=1e-5)
        np.testing.assert_allclose(w[1:], sk.coef_[0], atol=1e-5)

    def synth_panel(self, n_days=900, seed=5):
        rng = np.random.default_rng(seed)
        t0 = D0 + 86400 * np.arange(n_days)
        X = rng.normal(size=(n_days, len(L.FEATURES)))
        y = (rng.random(n_days) < 1 / (1 + np.exp(-(2 * X[:, 0] - 2)))).astype(float)
        P = pd.DataFrame(X, columns=list(L.FEATURES))
        P["t0"] = t0
        P["snapshot"] = [L.ts_day(t) for t in t0]
        P["y"] = y
        return P

    def test_folds_no_lookahead(self):
        P = self.synth_panel()
        hs = L.HORIZONS["7d"]
        fits, pred = L.fit_folds(P, "y", hs)
        self.assertEqual(fits[0]["quarter"], "2024Q1")
        for f in fits:
            qs = L.day_ts(f["testStart"])
            self.assertLessEqual(L.day_ts(f["lastTrainOrigin"]) + hs, qs)
        # perturbing every row whose label is unresolved at a fold's start leaves that fold's predictions intact
        for f in fits[:3]:
            qs = L.day_ts(f["testStart"])
            Q = P.copy()
            fut = Q["t0"] + hs > qs
            Q.loc[fut, "y"] = 1.0 - Q.loc[fut, "y"]
            te = (Q["t0"] >= qs) & (Q["t0"] < qs + 80 * 86400)
            Q.loc[fut & ~te, list(L.FEATURES)] = 99.0
            _, pred2 = L.fit_folds(Q, "y", hs)
            a = pred[pred["quarter"] == f["quarter"]]["p"].to_numpy()
            b = pred2[pred2["quarter"] == f["quarter"]]["p"].to_numpy()
            np.testing.assert_allclose(a[:80], b[:80], atol=1e-12)

    def test_train_mask_boundary(self):
        qs = L.quarter_start(2024, 1)
        self.assertTrue(L.train_mask(qs - 86400, 86400, qs))
        self.assertFalse(L.train_mask(qs - 86400 + 1, 86400, qs))

    def test_degenerate_fold_predicts_base_rate(self):
        P = self.synth_panel()
        P["y"] = 0.0
        P.loc[P.index[-5:], "y"] = 1.0
        fits, pred = L.fit_folds(P, "y", 86400)
        self.assertTrue(fits[0]["degenerate"])
        self.assertTrue((pred[pred["quarter"] == "2024Q1"]["p"] == 0.0).all())

    def test_scaler_clips_to_training(self):
        X = np.arange(100, dtype=float)[:, None]
        s = L.fit_scaler(X)
        z = L.apply_scaler(np.array([[1e9]]), s)
        self.assertAlmostEqual(z[0, 0], (s["hi"][0] - s["mu"][0]) / s["sd"][0])


class TestScoring(unittest.TestCase):
    def test_label_rule(self):
        self.assertEqual(L.label_for(10, 1.0, [0.01, 0.2]), "MEDIUM")
        self.assertEqual(L.label_for(9, 1.0, [0.01, 0.2]), "LOW")
        self.assertEqual(L.label_for(20, 1.6, [0.01, 0.2]), "LOW")
        self.assertEqual(L.label_for(20, 1.0, [-0.01, 0.2]), "LOW")
        self.assertNotIn("HIGH", [L.label_for(10 ** 6, 1.0, [0.9, 0.95])])

    def test_bss_and_R(self):
        y = np.array([0, 1, 0, 1.0])
        self.assertAlmostEqual(L.ratio_R(np.array([0.5] * 4), y), 1.0)
        self.assertAlmostEqual(L.bss(y, np.full(4, 0.5), y), 1.0)

    def test_score_refuses_wrong_sha(self):
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "frozen-l1.json"), "w") as f:
                json.dump({"outputs": {}}, f)
            with self.assertRaises(SystemExit):
                L.main(["score", "--datasets", d, "--cash", d, "--out", d, "--frozen-sha256", "0" * 64])


class TestAcquire(unittest.TestCase):
    def test_split_on_cap_and_topic_check(self):
        calls = []

        def post(payload):
            q = json.loads(payload)["params"][0]
            lo, hi = int(q["fromBlock"], 16), int(q["toBlock"], 16)
            calls.append((lo, hi))
            n = A.CAP if hi - lo > 1000 else 2
            res = [{"blockNumber": hex(lo), "blockTimestamp": hex(1), "transactionHash": "0xab",
                    "transactionIndex": "0x0", "logIndex": hex(i), "address": A.USDC, "data": "0x01",
                    "topics": [A.T_TRANSFER, "0x" + "0" * 64, A.pad(A.AUSDC)], "removed": False} for i in range(n)]
            return 200, json.dumps({"jsonrpc": "2.0", "id": 1, "result": res}).encode()
        c = A.Client(post=post, sleep=lambda s: None)
        out = A.fetch(c, A.STREAMS["usdc-in"], 0, 1999)
        self.assertGreater(c.counts["splits"], 0)
        self.assertTrue(all(r["topic2"] == A.pad(A.AUSDC) for r in out))

    def test_topic_mismatch_is_error(self):
        def post(payload):
            res = [{"blockNumber": "0x1", "blockTimestamp": "0x1", "transactionHash": "0xab",
                    "transactionIndex": "0x0", "logIndex": "0x0", "address": A.USDC, "data": "0x01",
                    "topics": [A.T_TRANSFER, "0x" + "0" * 64, "0x" + "1" * 64], "removed": False}]
            return 200, json.dumps({"result": res}).encode()
        c = A.Client(post=post, sleep=lambda s: None)
        with self.assertRaises(A.RangeError):
            c.get_logs(A.STREAMS["usdc-in"], 0, 10)


if __name__ == "__main__":
    unittest.main()
