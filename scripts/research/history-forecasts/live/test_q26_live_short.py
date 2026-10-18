#!/usr/bin/env python3
"""Tests for the D8 short-horizon block (q26_live_short.py; HISTORY_TOUCH_LIVE.md D8).

  python3 -m unittest scripts/research/history-forecasts/live/test_q26_live_short.py -v

Synthetic tests need no network and no dataset. Optional real-data checks:
  Q26_DATASETS=<root with price-history/, deribit-dvol/, binance-klines/, history-forecasts/, forecasts/q26-touch-live/>
      short rows do not change when every price after the origin is replaced or the series is cut at the origin;
  + Q26_OLD_CODE=<scripts/research/history-forecasts at the previous pin>   bit-identical replay of the LAST issue
      file (replay_issue.py) with the previous pin and with this code + --short-fh in the same environment: every row
      line and every field except modelSeconds identical, only `short` and `shortRows` added; vs the stored file every
      number within 1e-6 absolute (the iterative (fHb) map moves by ~4e-8; p by ~4e-11) (~7 min, two processes of
      ~1 GB; stores cut to the byte lengths the issue recorded).
"""
import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import hashlib  # noqa: E402
import json  # noqa: E402
import shutil  # noqa: E402
import sys  # noqa: E402
import tempfile  # noqa: E402
import unittest  # noqa: E402
import warnings  # noqa: E402
from unittest import mock  # noqa: E402

import numpy as np  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import q26_live_common as C  # noqa: E402
import q26_live_short as QS  # noqa: E402
import test_q26_live as TL  # noqa: E402
import test_q26_live_a6 as T6  # noqa: E402

warnings.filterwarnings("ignore")
U = C.A.utc
H = C.HOUR


def fake_short_forecaster(calls):
    def f(datasets, rounds, asof, origins, log=print):
        calls.append((asof, list(origins), {a: max((r.updated_at for r in rs), default=None)
                                            for a, rs in rounds.items()}))
        out = {}
        for a in C.ASSETS:
            rs = C.sort_rounds(rounds[a])
            spot = [C.price(C.answer_in_force(rs, t), a) for t in origins]
            T = {}
            for Th in QS.HORIZONS:
                K = len(C.LEVELS[a])
                base = np.linspace(0.4, 0.05, K)[None, :] * (Th / 12.0) ** 0.5
                g = np.repeat(base, len(origins), axis=0)
                T[Th] = {"P": {"fH": g, "f": g * 0.9, "a": g * 1.1}, "fallback": np.zeros(len(origins), bool),
                         "fit": {"har": [0.0, 1.0, 0.0, 0.0], "fH_fallback_rows": 0}}
            out[a] = {"spot_series": spot, "regime": ["mid"] * len(origins), "T": T}
        return out
    return f


class TestOrigins(unittest.TestCase):
    def test_batch_rule(self):
        with mock.patch.object(QS, "FIRST_ORIGIN", U("2026-10-18T04:00:00Z")):
            self.assertEqual(QS.batch_origins(U("2026-10-18T03:00:00Z"), None), [])
            self.assertEqual(QS.batch_origins(U("2026-10-18T05:00:00Z"), None),
                             [U("2026-10-18T04:00:00Z"), U("2026-10-18T05:00:00Z")])
            o = QS.batch_origins(U("2026-10-20T00:00:00Z"), U("2026-10-19T00:00:00Z"))
            self.assertEqual((len(o), o[0], o[-1]), (24, U("2026-10-19T01:00:00Z"), U("2026-10-20T00:00:00Z")))
            o = QS.batch_origins(U("2026-10-22T00:00:00Z"), U("2026-10-19T00:00:00Z"))    # missed days: no backfill
            self.assertEqual((len(o), o[0]), (24, U("2026-10-21T01:00:00Z")))
            o = QS.batch_origins(U("2026-10-19T08:00:00Z"), U("2026-10-19T00:00:00Z"))    # overlap: each once
            self.assertEqual((len(o), o[0]), (8, U("2026-10-19T01:00:00Z")))

    def test_levels_are_the_validated_shallow_region(self):
        self.assertEqual(QS.SHORT_LEVELS["ETH"], {1: (-0.02, -0.03), 3: (-0.02, -0.03, -0.05, -0.07),
                                                  12: (-0.02, -0.03, -0.05, -0.07, -0.10)})
        self.assertEqual(QS.SHORT_LEVELS["BTC"], QS.SHORT_LEVELS["ETH"])
        self.assertEqual(QS.SHORT_LEVELS["stETH"], {1: (-0.005, -0.01, -0.02), 3: (-0.005, -0.01, -0.02, -0.05),
                                                    12: (-0.005, -0.01, -0.02, -0.05)})


def strip_short(doc):
    return {k: v for k, v in doc.items() if k not in ("short", "shortRows")}


def row_lines(raw, key='"rows": ['):
    s = raw.decode()
    i = s.index(key)
    j = s.index("\n ]", i)
    return s[i:j]


class TestIssueShort(unittest.TestCase):
    def setUp(self):
        self.p = mock.patch.object(QS, "FIRST_ORIGIN", U("2026-10-13T00:00:00Z"))
        self.p.start()
        self.envs = []

    def tearDown(self):
        for e in self.envs:
            e.close()
        self.p.stop()

    def env(self):
        e = TL.LiveEnv(U("2026-10-14T00:17:30Z"))
        self.envs.append(e)
        e.fz5 = TL.write_frozen_a5(e.root)
        e.fz6 = T6.write_json(e.root, "frozen-a6.json", T6.fake_frozen_a6())
        return e

    def issue(self, e, short, calls=None):
        kw = dict(forecaster=T6.fake_a6_forecaster(e.seen), frozen_a5=e.fz5, frozen_a6=e.fz6)
        if short:
            kw.update(short_fh=True, short_forecaster=fake_short_forecaster(calls if calls is not None else []))
        return e.issue(**kw)

    def test_short_block_old_fields_identical_and_chain(self):
        e1, e2 = self.env(), self.env()
        calls = []
        p1, d1, sha1 = self.issue(e1, True, calls)
        p0, d0, _ = self.issue(e2, False)
        with open(p1, "rb") as f:
            raw1 = f.read().replace(e1.root.encode(), b"ROOT")
        with open(p0, "rb") as f:
            raw0 = f.read().replace(e2.root.encode(), b"ROOT")
        self.assertEqual(json.loads(raw1), json.loads(json.dumps(C.clean(d1)).replace(e1.root, "ROOT")))  # as returned
        self.assertEqual(strip_short(json.loads(raw1)), json.loads(raw0))            # every other field identical
        self.assertEqual(row_lines(raw1), row_lines(raw0))                           # rows byte-identical
        keys = list(d1)
        self.assertEqual(keys[-4:], ["short", "nRows", "rows", "shortRows"])
        self.assertEqual([k for k in keys if k not in ("short", "shortRows")], list(d0))
        sh = d1["short"]
        asof = d1["asof"]
        self.assertEqual(sh["origins"], list(range(asof - 23 * H, asof + 1, H)))
        self.assertEqual((sh["lastOrigin"], sh["prevLastOrigin"], sh["display"]), (asof, None, "none (log only)"))
        n_per_origin = sum(len(QS.SHORT_LEVELS[a][T]) for a in C.ASSETS for T in QS.HORIZONS)
        self.assertEqual(len(d1["shortRows"]), 24 * n_per_origin)
        self.assertEqual(sh["nShortRows"], len(d1["shortRows"]))
        self.assertTrue(all(m <= asof for m in calls[0][2].values()))               # no price after asof
        for r in d1["shortRows"]:
            self.assertEqual(r["resolvesAt"], r["origin"] + r["T_h"] * H)
            self.assertAlmostEqual(r["L"], r["S"] * (1 + r["k"]))
            self.assertIn(r["k"], QS.SHORT_LEVELS[r["asset"]][r["T_h"]])
            self.assertEqual(set(r["p"]), {"fH", "f", "a"})
        # next day: origins continue after lastOrigin; hash chain intact; nothing re-issued
        e1.clock.t += C.DAY
        p2, d2, _ = self.issue(e1, True, calls)
        self.assertEqual(d2["prevSha256"], sha1)
        self.assertEqual(d2["short"]["prevLastOrigin"], asof)
        self.assertEqual(d2["short"]["origins"][0], asof + H)
        self.assertEqual(d2["short"]["origins"][-1], d2["asof"])
        self.assertEqual(C.verify_chain(C.issues_dir(C.live_dir(e1.root))), [])

    def test_before_first_origin_empty_block(self):
        e = self.env()
        with mock.patch.object(QS, "FIRST_ORIGIN", U("2026-10-20T00:00:00Z")):
            p, d, _ = self.issue(e, True)
        self.assertEqual((d["short"]["nOrigins"], d["shortRows"]), (0, []))
        with open(p, "rb") as f:
            self.assertEqual(json.loads(f.read())["shortRows"], [])

    def test_scoring_short(self):
        e = self.env()
        _, d, _ = self.issue(e, True)
        e.clock.t += 2 * C.DAY
        summ, _ = e.score()
        sdir = os.path.join(C.live_dir(e.root), C.SCORES_SUB)
        names = sorted(os.listdir(sdir))
        self.assertTrue(any(n.startswith("short-outcomes-") for n in names))
        sh = summ["short"]
        self.assertEqual(sh["nRows"], len(d["shortRows"]))
        self.assertEqual(sh["nOutcomes"], len(d["shortRows"]))
        self.assertGreater(sh["nResolved"], 0)
        cell = sh["cells"]["ETH"]["1h"]
        self.assertEqual(set(cell["perLevel"]), {repr(-0.02), repr(-0.03)})
        self.assertTrue(cell["perMonth"])
        self.assertIn("hac_p", cell["tests"]["vs_f"])
        self.assertFalse(cell["verdict"]["applied"])
        n1 = sh["nOutcomes"]
        e.clock.t += C.DAY
        summ2, _ = e.score()                                                       # append-only, no duplicates
        self.assertEqual(summ2["short"]["nOutcomes"], n1)
        # the main outcomes never include short rows
        for n in names:
            if C.OUTCOME_FILE_RE.match(n):
                with open(os.path.join(sdir, n)) as f:
                    self.assertTrue(all("origin" not in json.loads(ln) for ln in f if ln.strip()))

    def test_summary_without_short_rows_has_no_short_key(self):
        e = self.env()
        self.issue(e, False)
        e.clock.t += 2 * C.DAY
        summ, _ = e.score()
        self.assertNotIn("short", summ)


class TestStats(unittest.TestCase):
    def test_hac_and_boot(self):
        rng = np.random.default_rng(1)
        ts = U("2026-10-19T00:00:00Z") + H * np.arange(24 * 120)
        d = -0.002 + 0.01 * rng.standard_normal(len(ts))
        self.assertLess(QS.hac_p(d), 0.01)
        self.assertLess(QS.week_boot_p(ts, d, B=2000), 0.01)
        self.assertGreater(QS.hac_p(-d), 0.9)
        self.assertGreater(QS.week_boot_p(ts, -d, B=2000), 0.9)

    def test_episodes(self):
        t = [0, H, 2 * H, 5 * H, 6 * H]
        self.assertEqual(QS._pos_episodes(t, [1, 1, 0, 1, 1]), 2)
        self.assertEqual(QS._pos_episodes(t, [1, 0, 1, 1, 0]), 3)          # 5H follows 2H after a gap


@unittest.skipUnless(os.environ.get("Q26_DATASETS"), "set Q26_DATASETS for the real-data checks")
class TestRealDataShort(unittest.TestCase):
    def setUp(self):
        self.ds = os.environ["Q26_DATASETS"]
        ldir = os.path.join(self.ds, C.LIVE_REL)
        self.rounds = {a: C.read_round_store(C.round_store_path(ldir, a)) for a in C.ASSETS}
        self.asof = C.floor_hour(min(rs[-1].updated_at for rs in self.rounds.values()))

    def run_short(self, rounds, asof, origins):
        up = {a: [r for r in rs if r.updated_at <= asof] for a, rs in rounds.items()}
        fc = QS.short_forecasts(self.ds, up, asof, origins, log=lambda *a: None)
        return QS.short_rows(fc, up, origins, asof + 999)

    def test_no_look_ahead(self):
        origins = list(range(self.asof - 23 * H, self.asof + 1, H))
        base = self.run_short(self.rounds, self.asof, origins)
        self.assertTrue(base)
        # (1) every price after asof replaced
        pert = {}
        for a, rs in self.rounds.items():
            keep = [r for r in rs if r.updated_at <= self.asof]
            last = keep[-1]
            pert[a] = keep + [C.Round(last.round_id + 1 + j, last.answer // 2, self.asof + 1 + 300 * j)
                              for j in range(30)]
        self.assertEqual(self.run_short(pert, self.asof, origins), base)
        # (2) the series cut at a middle origin gives the same rows for origins up to it (same batch fit)
        cut = origins[11]
        part = self.run_short(self.rounds, cut, origins[:12])
        self.assertEqual([dict(r, issuedAt=0) for r in part],
                         [dict(r, issuedAt=0) for r in base if r["origin"] <= cut])

    @unittest.skipUnless(os.environ.get("Q26_OLD_CODE"), "set Q26_OLD_CODE=<scripts/research/history-forecasts at the "
                         "previous pin> for the bit-identical replay (~7 min, two processes)")
    def test_replay_last_issue_bit_identical(self):
        """Replay the last issue with the previous pin and with this code (--short-fh) in the same environment:
        every row line and every top-level field except modelSeconds are byte-identical, only short/shortRows
        are added. Against the stored (runner-made) file every number agrees to 1e-6 absolute (the iterative
        (fHb) map fit moves by about 4e-8 across CPUs, p by about 4e-11) (OpenBLAS kernels
        differ across CPUs)."""
        import subprocess
        old_code = os.environ["Q26_OLD_CODE"]
        with tempfile.TemporaryDirectory() as tmp:
            outs = {"old": os.path.join(tmp, "old.json"), "new": os.path.join(tmp, "new.json")}
            procs = []
            for tag, code, extra in (("old", old_code, []), ("new", os.path.dirname(HERE), ["--short-fh"])):
                procs.append(subprocess.Popen([sys.executable, os.path.join(HERE, "replay_issue.py"), "--code-dir",
                                               code, "--datasets", self.ds, "--out", outs[tag], *extra],
                                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT))
            for pr in procs:
                out, _ = pr.communicate()
                self.assertEqual(pr.returncode, 0, out.decode()[-2000:])
            with open(outs["old"], "rb") as f:
                raw_old = f.read()
            with open(outs["new"], "rb") as f:
                raw_new = f.read()
        real = os.path.join(self.ds, C.LIVE_REL, C.ISSUES_SUB)
        with open(os.path.join(real, C.list_issue_files(real)[-1][1]), "rb") as f:
            raw_file = f.read()
        old, new = json.loads(raw_old), json.loads(raw_new)
        self.assertEqual(row_lines(raw_new), row_lines(raw_old))                     # rows bit-identical
        a, b = strip_short(new), dict(old)
        a.pop("modelSeconds"), b.pop("modelSeconds")
        self.assertEqual(a, b)
        self.assertEqual(set(new) - set(old), {"short", "shortRows"})
        stored = json.loads(raw_file)
        stored.pop("modelSeconds")
        keep = os.environ.get("Q26_REPLAY_KEEP")
        if keep:
            for tag, raw in (("old", raw_old), ("new", raw_new)):
                with open(os.path.join(keep, f"replay-{tag}.json"), "wb") as f:
                    f.write(raw)
        rel, ab = max_rel_diff(b, stored), max_rel_diff(b, stored, absolute=True)
        print(f"\nreplay: rows identical to the previous pin; vs the stored runner file max abs difference "
              f"{ab:.3g}, max relative {rel:.3g}", file=sys.stderr)
        self.assertLess(ab, 1e-6)                   # (fHb) map theta: iterative fit, ~4e-8 seen on 2026-10-17


def max_rel_diff(x, y, absolute=False):
    """Largest relative difference between two JSON trees of the same shape (AssertionError when shapes differ)."""
    if isinstance(x, dict):
        assert isinstance(y, dict) and set(x) == set(y), (sorted(set(x) ^ set(y)) if isinstance(y, dict) else y)
        return max([max_rel_diff(x[k], y[k], absolute) for k in x] or [0.0])
    if isinstance(x, list):
        assert isinstance(y, list) and len(x) == len(y)
        return max([max_rel_diff(u, v, absolute) for u, v in zip(x, y)] or [0.0])
    if isinstance(x, float) or isinstance(y, float):
        if x == y:
            return 0.0
        assert isinstance(x, (int, float)) and isinstance(y, (int, float)), (x, y)
        return abs(x - y) if absolute else abs(x - y) / max(abs(x), abs(y), 1e-300)
    assert x == y, (x, y)
    return 0.0

if __name__ == "__main__":
    unittest.main()
