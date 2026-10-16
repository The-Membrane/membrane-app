#!/usr/bin/env python3
"""Tests for the model-A6 live extension (q26_live_a6.py; HISTORY_TOUCH_PREREG_A6.md A6.5).

  python3 -m unittest scripts/research/history-forecasts/live/test_q26_live_a6.py -v

Synthetic tests need no network and no dataset. Optional real-data checks:
  Q26_DATASETS=<membrane-datasets>  live-span highs/closes/lows unchanged by rounds after asof (perturbation, on the
                                    real round store), and the frozen-span high equals the A6 dev high
  + Q26_A6_OUT=<A6 dev output dir>  the A6 rungs at asof = DATA_END equal results-dev.json p_data_end and the A6
                                    shipped p equal frozen-a6.json range_data_end p (~7 min). Bit-for-bit equality
                                    needs one BLAS thread (as the issuer sets): run this module first or alone, or
                                    export OMP_NUM_THREADS=OPENBLAS_NUM_THREADS=MKL_NUM_THREADS=1.
"""
import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import copy  # noqa: E402
import hashlib  # noqa: E402
import json  # noqa: E402
import sys  # noqa: E402
import unittest  # noqa: E402
import warnings  # noqa: E402

import numpy as np  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import q26_live_common as C  # noqa: E402
import q26_live_a6 as Q6  # noqa: E402
import test_q26_live as TL  # noqa: E402

warnings.filterwarnings("ignore")
U = C.A.utc

A6_SHIP = {"ETH": {"6h": "fH", "1d": "f", "3d": "fHb", "7d": "fbL", "14d": "fbL", "30d": "fh"},
           "BTC": {"6h": "fHb", "1d": "fH", "3d": "fH", "7d": "fH", "14d": "fH", "30d": "a"},
           "stETH": {"6h": "fHb", "1d": "a", "3d": "a", "7d": "a", "14d": "a", "30d": "a"}}


def fake_frozen_a6():
    def g(lab):
        return {"after": lab, "dev": lab, "outcome": "not HIGH", "n_ep": 21, "basis": "held in 4 of 4 checks",
                "per_source_rule": "held", "seed_sensitive": False}
    lab = {"pooled": "HIGH", "low": g("MEDIUM"), "mid": g("HIGH"), "high": g("LOW")}
    return {"shipped": A6_SHIP,
            "labels": {a: {C.T_LABEL[T]: {r: {repr(float(k)): lab for k in C.LEVELS[a]}
                                          for r in ("a", "f", "fbL", "fh", "fH", "fHb")}
                           for T in C.HORIZONS_H} for a in C.ASSETS}}


def write_json(d, name, doc):
    path = os.path.join(d, name)
    raw = json.dumps(doc).encode()
    with open(path, "wb") as f:
        f.write(raw)
    return path, hashlib.sha256(raw).hexdigest()


def fake_a6_forecaster(seen):
    base = TL.fake_a5_forecaster(seen)

    def f(datasets, rounds, asof, log=print):
        out = base(datasets, rounds, asof, log=log)
        for a in C.ASSETS:
            fa = out[a]
            fa["raw6"], fa["fixed6"] = {}, {}
            for j, r in enumerate(Q6.A6_RUNGS):
                g = np.clip(fa["raw"]["f"] * (0.9 + 0.05 * j), 0, 1)
                fa["raw6"][r], fa["fixed6"][r] = g, C.A.monotone_fix(g[None])[0]
            fa["fits6"] = {C.T_LABEL[T]: {"w_fh": 1.1, "har": [0.1, 0.2, 0.3, 0.1], "maps_fHb": {}} for T in C.HORIZONS_H}
            allf = dict(fa["fixed"], **fa["fixed6"])
            p = np.array([allf[A6_SHIP[a][C.T_LABEL[T]]][ti] for ti, T in enumerate(C.HORIZONS_H)])
            fa["range6_lo"], fa["range6_hi"] = np.clip(p - 0.04, 0, 1), np.clip(p + 0.04, 0, 1)
            fa["range6_days"] = {C.T_LABEL[T]: 100 for T in C.HORIZONS_H}
            fa["har_now"] = [0.1, 0.1, 0.1]
        return out
    return f


A5_FIELDS_ROW = ("asset", "T", "T_h", "k", "S", "L", "asof", "issuedAt", "resolvesAt", "regime", "beta_fb", "a3",
                 "betas_fbL", "date")


def a5_view(r, from_a6):
    """The A3/A5 content of a row; for an A6 row the A5 shipped fields are read from r['a5']."""
    v = {k: r[k] for k in A5_FIELDS_ROW}
    v["p"] = {k: r["p"][k] for k in ("a", "f", "fb", "fbL")}
    v["p_raw"] = {k: r["p_raw"][k] for k in ("a", "f", "fb", "fbL")}
    src = r["a5"] if from_a6 else r
    for k in ("shipped", "p_shipped", "estimateRange", "frozen_label"):
        v[k] = src[k]
    return json.dumps(C.clean(v), sort_keys=True)


class TestModelA6(unittest.TestCase):
    def setUp(self):
        self.env = TL.LiveEnv(U("2026-10-14T00:17:30Z"))
        self.fz5 = TL.write_frozen_a5(self.env.root)
        self.fz6 = write_json(self.env.root, "frozen-a6.json", fake_frozen_a6())

    def tearDown(self):
        self.env.close()

    def issue_a5(self, env=None, **kw):
        env = env or self.env
        return env.issue(forecaster=TL.fake_a5_forecaster(env.seen), frozen_a5=self.fz5, **kw)

    def issue_a6(self, env=None, **kw):
        env = env or self.env
        return env.issue(forecaster=fake_a6_forecaster(env.seen), frozen_a5=self.fz5, frozen_a6=self.fz6, **kw)

    def test_a6_issue_after_a5_issue_and_a5_fields_identical(self):
        _, doc1, sha1 = self.issue_a5()
        self.env.clock.t += C.DAY
        path2, doc2, sha2 = self.issue_a6()
        self.assertEqual((doc2["schema"], doc2["model"]), ("q26-touch-live/issue/3", "A6"))
        self.assertEqual(list(doc2)[:2], ["schema", "model"])
        self.assertEqual((doc2["prevFile"], doc2["prevSha256"]), ("2026-10-14.json", sha1))
        self.assertEqual(C.verify_chain(C.issues_dir(C.live_dir(self.env.root))), [])
        self.assertEqual(doc2["rungs"], ["a", "f", "fb", "fbL", "fh", "fH", "fHb"])
        self.assertEqual(doc2["shipped"], A6_SHIP)
        self.assertEqual(doc2["shippedA5"], TL.A5_SHIP)
        self.assertEqual(doc2["shippedA3"], TL.fake_frozen()["shipped"])
        self.assertEqual(doc2["inputs"]["frozenA6"], {"path": self.fz6[0], "sha256": self.fz6[1]})
        self.assertEqual(doc2["inputs"]["frozenA5"], {"path": self.fz5[0], "sha256": self.fz5[1]})
        self.assertIn("modelA6", doc2["prereg"])
        with open(path2, "rb") as f:
            self.assertEqual(json.loads(f.read()), json.loads(json.dumps(C.clean(doc2))))
        for r in doc2["rows"]:
            ship = A6_SHIP[r["asset"]][r["T"]]
            self.assertEqual((r["model"], r["shipped"]), ("A6", ship))
            self.assertEqual(r["p_shipped"], r["p"][ship])
            self.assertEqual(set(r["p"]), {"a", "f", "fb", "fbL", "fh", "fH", "fHb"})
            self.assertEqual(r["estimateRange"]["rung"], ship)
            self.assertTrue(r["estimateRange"]["lo"] <= r["p_shipped"] <= r["estimateRange"]["hi"])
            self.assertEqual(r["frozen_label"]["label"], "MEDIUM")                # A6 label, regime low
            self.assertTrue(r["frozen_label"]["basisSource"].startswith("frozen-a6"))
            self.assertEqual(r["a5"]["shipped"], TL.A5_SHIP[r["asset"]][r["T"]])
            self.assertEqual(r["a5"]["frozen_label"]["label"], "HIGH")             # A5 label, regime low
            self.assertEqual(r["a3"]["frozen_label"]["label"], "MEDIUM")           # A3 label, regime low
        # an A5-mode run at the same asof (fresh store, same clock): every A3/A5 field byte-identical
        env2 = TL.LiveEnv(U("2026-10-14T00:17:30Z"))
        try:
            env2.clock.t += C.DAY
            _, d5, _ = env2.issue(forecaster=TL.fake_a5_forecaster(env2.seen), frozen_a5=self.fz5)
        finally:
            env2.close()
        self.assertEqual(len(d5["rows"]), len(doc2["rows"]))
        for r5, r6 in zip(d5["rows"], doc2["rows"]):
            self.assertEqual(a5_view(r5, False), a5_view(r6, True))

    def test_refusals(self):
        idir = C.issues_dir(C.live_dir(self.env.root))
        with self.assertRaises(SystemExit):                                  # A6 without the A5 inputs
            self.env.issue(forecaster=fake_a6_forecaster(self.env.seen), frozen_a6=self.fz6)
        with self.assertRaises(SystemExit):                                  # wrong sha256
            self.env.issue(forecaster=fake_a6_forecaster(self.env.seen), frozen_a5=self.fz5,
                           frozen_a6=(self.fz6[0], "0" * 64))
        with self.assertRaises(SystemExit):                                  # A6 basis without the A6 freeze
            self.issue_a5(basis_final_a6=("x", "0" * 64))
        bad = copy.deepcopy(fake_frozen_a6())
        bad["shipped"]["ETH"]["6h"] = "fc"
        p, s = write_json(self.env.root, "bad-a6.json", bad)
        with self.assertRaises(SystemExit):
            self.env.issue(forecaster=fake_a6_forecaster(self.env.seen), frozen_a5=self.fz5, frozen_a6=(p, s))
        self.assertEqual(C.list_issue_files(idir), [])
        for argv in (["--frozen-a6", "x"], ["--frozen-a6", "x", "--frozen-a6-sha256", "y"],
                     ["--frozen-a5", "x", "--frozen-a5-sha256", "y", "--basis-final-a6", "z",
                      "--basis-final-a6-sha256", "w"]):
            with self.assertRaises(SystemExit):
                TL.I.main(["--datasets", "x", "--out", self.env.root] + argv)

    def test_basis_final_a6(self):
        lines = ["asset,T,k,rung,regime,shipped,label,basis,blind5_R,blind5_n_ep"]
        for a in C.ASSETS:
            for T in C.HORIZONS_H:
                for k in C.LEVELS[a]:
                    for g, lab in (("low", "MEDIUM"), ("mid", "HIGH"), ("high", "LOW")):
                        lines.append(f"{a},{C.T_LABEL[T]},{k},{A6_SHIP[a][C.T_LABEL[T]]},{g},1,{lab},"
                                     "held in 5 of 5 checks,1.0,20")
        bp = os.path.join(self.env.root, "basis-final-a6.csv")
        with open(bp, "w") as f:
            f.write("\n".join(lines) + "\n")
        with open(bp, "rb") as f:
            bsha = hashlib.sha256(f.read()).hexdigest()
        _, doc, _ = self.issue_a6(basis_final_a6=(bp, bsha))
        self.assertEqual(doc["inputs"]["basisFinalA6"], {"path": bp, "sha256": bsha})
        self.assertTrue(all(r["frozen_label"]["basis"] == "held in 5 of 5 checks" for r in doc["rows"]))
        self.assertTrue(all(r["a5"]["frozen_label"]["basis"] == "held in 2 of 3 checks" for r in doc["rows"]))

    def test_mixed_scoring_a3_a5_a6(self):
        self.env.issue()                                                     # day 1: model A3
        self.env.clock.t = U("2026-10-15T00:17:30Z")
        self.issue_a5()                                                      # day 2: model A5
        self.env.clock.t = U("2026-10-16T00:17:30Z")
        self.issue_a6()                                                      # day 3: model A6
        self.env.clock.t = U("2026-10-17T00:17:30Z")
        self.issue_a6()                                                      # day 4: model A6
        self.env.clock.t = U("2026-10-17T00:47:10Z")
        summ, new = self.env.score()
        by = {m: [o for o in new if o.get("model", "A3") == m] for m in ("A3", "A5", "A6")}
        self.assertTrue(all(by.values()))
        for o in by["A6"]:
            self.assertEqual(o["shipped"], A6_SHIP[o["asset"]][o["T"]])
            self.assertEqual(o["a5"]["shipped"], TL.A5_SHIP[o["asset"]][o["T"]])
            self.assertIn("shipped", o["a3"])
            if o["status"] == "resolved":
                self.assertEqual(set(o["brier"]), {"a", "f", "fb", "fbL", "fh", "fH", "fHb"})
        for o in by["A5"]:
            self.assertNotIn("a5", o)
            if o["status"] == "resolved":
                self.assertEqual(set(o["brier"]), {"a", "f", "fb", "fbL"})
        for o in by["A3"]:
            if o["status"] == "resolved":
                self.assertEqual(set(o["brier"]), {"a", "f", "fb"})
        c = summ["cells"]["ETH"]["6h"]["-0.02"]["pooled"]
        n6 = sum(o["status"] == "resolved" and o["asset"] == "ETH" and o["T"] == "6h" and o["k"] == -0.02
                 for o in by["A6"])
        self.assertEqual(c["fH"]["n"], n6)                                   # A6 rungs: A6 rows only
        lc = summ["liveCheck"]["ETH"]["6h"]["-0.02"]["low"]
        self.assertEqual((lc["rung"], lc["model"]), ("fH", "A6"))            # the A6 shipped rung decides
        self.assertEqual(lc["n"], n6)
        self.assertEqual(lc["previousModelA5"]["rung"], "fbL")               # the A5 shipped rung, still scored
        self.assertEqual(lc["previousModelA5"]["n"], c["fbL"]["n"])
        st = summ["liveStale"]["ETH"]["6h"]["-0.02"]["low"]
        self.assertEqual(st["rung"], "fH")


class TestHighs(unittest.TestCase):
    def test_hourly_high_window_and_no_price_after_asof(self):
        t0 = C.DATA_END - C.HOUR
        rs = [C.Round(1, 100 * 10 ** 8, t0 - 10), C.Round(2, 120 * 10 ** 8, t0 + 100),
              C.Round(3, 90 * 10 ** 8, t0 + 3600), C.Round(4, 95 * 10 ** 8, t0 + 3650)]
        h = Q6.hourly_high(rs, "ETH", t0, t0 + 3 * C.HOUR)
        np.testing.assert_array_equal(h, [120.0, 95.0, 95.0])
        c, lo = C.hourly_close_low(rs, "ETH", t0, t0 + 3 * C.HOUR)
        np.testing.assert_array_equal(c, [90.0, 95.0, 95.0])
        np.testing.assert_array_equal(lo, [90.0, 90.0, 95.0])
        asof = t0 + 3 * C.HOUR
        later = rs + [C.Round(5, 500 * 10 ** 8, asof + 1), C.Round(6, 1 * 10 ** 8, asof + 7200)]
        upto = [r for r in later if r.updated_at <= asof]
        np.testing.assert_array_equal(Q6.hourly_high(upto, "ETH", t0, asof), h)

    def test_round_at_hour_end_counts_in_that_hour(self):
        t0 = C.DATA_END
        rs = [C.Round(1, 100, t0 - 5), C.Round(2, 150, t0 + C.HOUR)]
        self.assertEqual(Q6.hourly_high(rs, "stETH", t0, t0 + C.HOUR)[0], 150 / 10 ** 18)


@unittest.skipUnless(os.environ.get("Q26_LIVE_DIR"), "set Q26_LIVE_DIR=<.../forecasts/q26-touch-live> to run")
class TestModelA6ScratchCopy(unittest.TestCase):
    """One model-A6 issue (fake forecaster) on a scratch copy of the real live directory after its last issue file,
    then mixed A3/A5/A6 scoring; the real directory is only read (checked unchanged)."""

    def test_scratch_issue_and_score(self):
        import shutil
        import tempfile
        from unittest import mock
        real = os.environ["Q26_LIVE_DIR"]
        before = TL._tree_sha(real)
        files = C.list_issue_files(os.path.join(real, C.ISSUES_SUB))
        last_name = files[-1][1]
        with open(os.path.join(real, C.ISSUES_SUB, last_name), "rb") as f:
            last_raw = f.read()
        last_doc = json.loads(last_raw)
        with tempfile.TemporaryDirectory() as tmp:
            ldir = os.path.join(tmp, C.LIVE_REL)
            shutil.copytree(real, ldir)
            fz5 = TL.write_frozen_a5(tmp)
            fz6 = write_json(tmp, "frozen-a6.json", fake_frozen_a6())
            clock = TL.Clock(C.floor_hour(int(last_doc["issuedAt"])) // C.DAY * C.DAY + C.DAY + 1050)
            upd = TL.TestModelA5ScratchCopy.synthetic_update(None, ldir, clock)
            patches = [mock.patch.object(C, "update_all_stores", upd),
                       mock.patch.object(C, "verify_frozen_inputs", lambda d: {"x": {"sha256": "0" * 64}}),
                       mock.patch.object(C, "load_frozen_a3", lambda d: TL.fake_frozen())]
            for p in patches:
                p.start()
            try:
                _, doc, _ = TL.I.issue(tmp, "unused", None, clock=clock, forecaster=fake_a6_forecaster([]),
                                       code={"commit": "test"}, log=TL.QUIET, frozen_a5=fz5, frozen_a6=fz6)
                self.assertEqual((doc["schema"], doc["model"]), ("q26-touch-live/issue/3", "A6"))
                self.assertEqual(doc["prevSha256"], hashlib.sha256(last_raw).hexdigest())
                self.assertEqual(C.verify_chain(C.issues_dir(ldir)), [])
                clock.t += C.DAY + 1800
                summ, new = TL.SC.score(tmp, None, clock=clock, code={}, log=TL.QUIET)
                kinds = {o.get("model", "A3") for o in new}
                self.assertIn("A6", kinds)
                self.assertTrue(all(set(o["brier"]) == {"a", "f", "fb", "fbL", "fh", "fH", "fHb"} for o in new
                                    if o.get("model") == "A6" and o["status"] == "resolved"))
            finally:
                for p in patches:
                    p.stop()
        self.assertEqual(TL._tree_sha(real), before)


@unittest.skipUnless(os.environ.get("Q26_DATASETS"), "set Q26_DATASETS=<membrane-datasets> for the real-data check")
class TestRealDataA6(unittest.TestCase):
    def test_live_series_unchanged_by_rounds_after_asof(self):
        ds = os.environ["Q26_DATASETS"]
        ldir = os.path.join(ds, C.LIVE_REL)
        rounds = {a: C.read_round_store(C.round_store_path(ldir, a)) for a in C.ASSETS}
        asof = C.floor_hour(min(rs[-1].updated_at for rs in rounds.values())) - 6 * C.HOUR
        S1 = C.build_live_series(ds, rounds, asof)
        Q6.attach_live_highs(ds, S1, rounds, asof)
        pert = {}
        for a, rs in rounds.items():
            keep = [r for r in rs if r.updated_at <= asof]
            last = keep[-1]
            fut = [C.Round(last.round_id + 1000 + j, last.answer * (3 if j % 2 else 1) // 2, asof + 1 + 600 * j)
                   for j in range(40)]
            pert[a] = keep + fut                                             # every price after asof replaced
        S2 = C.build_live_series(ds, pert, asof)
        Q6.attach_live_highs(ds, S2, pert, asof)
        for a in C.ASSETS:
            for side in ("long", "oracle"):
                s1, s2 = S1[a][side], S2[a][side]
                for attr in ("close", "low", "sigma", "sigma_ref", "regime"):
                    np.testing.assert_array_equal(getattr(s1, attr), getattr(s2, attr))
            np.testing.assert_array_equal(S1[a]["long"].high, S2[a]["long"].high)
            np.testing.assert_array_equal(Q6.M6.har_of(S1[a]["long"]), Q6.M6.har_of(S2[a]["long"]))
        # the frozen-span high equals the A6 dev high
        D = Q6.M6.M3.build_dev(ds)
        Q6.M6.attach_highs_dev(ds, D)
        for a in C.ASSETS:
            n = D[f"long:{a}"].N
            np.testing.assert_array_equal(S1[a]["long"].high[:n], D[f"long:{a}"].high)

    @unittest.skipUnless(os.environ.get("Q26_A6_OUT"), "set Q26_A6_OUT=<A6 dev output dir> for the DATA_END check")
    def test_a6_at_data_end_matches_a6_dev(self):
        import q26_live_a5 as Q5
        ds, out = os.environ["Q26_DATASETS"], os.environ["Q26_A6_OUT"]
        with open(os.path.join(out, "results-dev.json")) as f:
            dev = json.load(f)
        with open(os.path.join(out, "frozen-a6.json")) as f:
            fz6 = json.load(f)
        with open(os.path.join(ds, "history-forecasts/a5/run-c6d70b36/frozen-a5.json")) as f:
            fz5 = json.load(f)
        empty = {a: [C.Round(1, 1, C.DATA_END - 10)] for a in C.ASSETS}
        S = C.build_live_series(ds, empty, C.DATA_END)
        Q6.attach_live_highs(ds, S, empty, C.DATA_END)
        rng = np.random.default_rng([Q5.RANGE_SEED, C.DATA_END])
        rng6 = np.random.default_rng([Q6.RANGE_SEED, C.DATA_END, Q6.RANGE_STREAM])
        for a in C.ASSETS:
            sl, so = S[a]["long"], S[a]["oracle"]
            f5 = Q5.a5_extend(C.forecast_series(sl, so, C.DATA_END), sl, so, C.DATA_END, fz5["shipped"][a], rng)
            f6 = Q6.a6_extend(f5, sl, so, C.DATA_END, fz6["shipped"][a], rng6)
            allf = dict(f6["fixed"], **f6["fixed6"])
            for ti, T in enumerate(C.HORIZONS_H):
                ref = dev["per_asset"][a][C.T_LABEL[T]]["p_data_end"]
                for r in ("fh", "fH", "fHb", "a", "f", "fbL"):
                    np.testing.assert_array_equal(allf[r][ti], np.array(ref[r]), err_msg=f"{a} {T} {r}")
                ft = dev["per_asset"][a][C.T_LABEL[T]]["fits_data_end"]
                self.assertEqual(f6["fits6"][C.T_LABEL[T]]["w_fh"], ft["w"])
                self.assertEqual(f6["fits6"][C.T_LABEL[T]]["har"], ft["har"])
            p = np.array([allf[fz6["shipped"][a][C.T_LABEL[T]]][ti] for ti, T in enumerate(C.HORIZONS_H)])
            np.testing.assert_array_equal(p, np.array(fz6["range_data_end"][a]["p"]))
            self.assertTrue(np.all(f6["range6_lo"] <= p) and np.all(p <= f6["range6_hi"]))


if __name__ == "__main__":
    unittest.main()
