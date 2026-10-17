#!/usr/bin/env python3
"""Q26 round 7 in the per-deposit live log (synthetic; no network): R7.2 stress block in the issuer, R7.1 lights in
the scorer.

  python3 -m unittest scripts/research/history-forecasts/live_deposit/test_r7_dep.py -v
"""
import hashlib
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import q26_dep_common as D  # noqa: E402
import q26_dep_issue as I  # noqa: E402
import r7_live as R7  # noqa: E402
from test_q26_dep import (A1, A2, A3, A4, A5, ASOF, H, MICRO, NOW, QUIET, FakeRpc, World, atoken_log,  # noqa: E402
                          base_live_logs, base_xv_logs, fake_frozen, snapshot_tree, word, RAY)

REL = "history-forecasts/r7/r7-refill-usdc.json"


def write_refill(ds, data_end=1_751_500_000, beta=(0.1, 0.3, 0.5)):
    doc = {"schema": "q26-r7/refill/1", "reserve": "USDC", "dataEndTs": data_end, "dataEndIso": "x",
           "beta": {"3h": beta[0], "24h": beta[1], "72h": beta[2]}}
    raw = json.dumps(doc).encode()
    p = os.path.join(ds, REL)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "wb") as f:
        f.write(raw)
    return hashlib.sha256(raw).hexdigest()


def issue_with_stress(w, sha, now=NOW):
    ps = w.patches(now)
    for p in ps:
        p.start()
    try:
        return I.issue(w.out, w.ds, FakeRpc(now), w.logs, clock=lambda: now, log=QUIET, frozen=fake_frozen(),
                       stress_refill=(REL, sha))
    finally:
        for p in reversed(ps):
            p.stop()


def world(post_logs=None):
    return World(post_logs or base_live_logs(), base_xv_logs(),
                 rounds_after=[[(1 << 64) | 201, 999_000_000_000, H + 60]], mismatch={A2})


class TestStressInIssuer(unittest.TestCase):
    def test_block_math_and_no_address(self):
        w = world()
        try:
            sha = write_refill(w.ds)
            _, doc, rows = issue_with_stress(w, sha)
            s = doc["stressR72"]
            bals = sorted((int(r[7]) for r in rows if r[0] == "USDC"), reverse=True)
            self.assertEqual(s["nHolders"], len(bals))
            sc = {x["scenario"]: x for x in s["scenarios"]}
            self.assertAlmostEqual(sc["S2"]["withdrawalUSD"], sum(bals[:2]) / MICRO)
            self.assertAlmostEqual(sc["S10"]["withdrawalUSD"], sum(bals[:10]) / MICRO)
            self.assertEqual(s["cashUSD"], 400_000_000)
            self.assertAlmostEqual(sc["S2"]["shortfallUSD"], sum(bals[:2]) / MICRO - 400e6)
            self.assertAlmostEqual(sc["S2"]["shortfallShareOfSupply"], (sum(bals[:2]) / MICRO - 400e6) / 3e9)
            self.assertEqual(sc["S2"]["hoursUntilCashNonNegative"], 0.0)          # cash covers small holders
            self.assertEqual(doc["inputs"]["refillR72"]["sha256"], sha)
            self.assertEqual(list(doc)[-1], "nRows")
            txt = json.dumps(s).lower()
            for a in (A1, A2, A3, A4, A5):
                self.assertNotIn(a[2:12], txt)
            self.assertNotIn("0x", txt)
            self.assertEqual(D.verify_chain(D.issues_dir(w.ldir())), [])
        finally:
            w.cleanup()

    def test_without_flag_unchanged(self):
        w1, w2 = world(), world()
        try:
            sha = write_refill(w2.ds)
            _, d1, rows1 = w1.issue(NOW)
            _, d2, rows2 = issue_with_stress(w2, sha)
            self.assertNotIn("stressR72", d1)
            self.assertEqual(rows1, rows2)                                          # the CSV is unchanged
        finally:
            w1.cleanup()
            w2.cleanup()

    def test_no_look_ahead(self):
        """Perturbing every aToken log after asof leaves the stress block identical; a pre-asof change moves it."""
        w1 = world()
        w2 = world([lg if lg["block"] <= ASOF else dict(lg, data="0x" + word(2_345_678 * MICRO) + word(0) + word(RAY))
                    for lg in base_live_logs()] + [atoken_log("Burn", ASOF + 2, 9, A3, value=900_000 * MICRO)])
        w3 = world(base_live_logs() + [atoken_log("Burn", ASOF - 5, 9, A1, value=100_000 * MICRO)])
        try:
            blocks = []
            for w in (w1, w2, w3):
                sha = write_refill(w.ds)
                blocks.append(issue_with_stress(w, sha)[1]["stressR72"])
            self.assertEqual(blocks[0], blocks[1])
            self.assertNotEqual(blocks[0], blocks[2])
        finally:
            for w in (w1, w2, w3):
                w.cleanup()

    def test_refusals_before_any_write(self):
        w = world()
        try:
            sha = write_refill(w.ds, data_end=10 ** 10)                             # refill data after asof
            before = snapshot_tree(w.out)
            with self.assertRaises(SystemExit) as cm:
                issue_with_stress(w, sha)
            self.assertIn("after asof", str(cm.exception))
            self.assertEqual(snapshot_tree(w.out), before)                          # nothing written
            sha = write_refill(w.ds)
            with self.assertRaises(SystemExit) as cm:
                issue_with_stress(w, "f" * 64)
            self.assertIn("sha256 mismatch", str(cm.exception))
            self.assertEqual(snapshot_tree(w.out), before)
            with self.assertRaises(SystemExit):
                I.main(["--datasets", w.ds, "--out", w.out, "--stress-refill", REL])
        finally:
            w.cleanup()


class TestLightsInScorer(unittest.TestCase):
    def test_score_has_lights(self):
        w = world()
        try:
            w.issue(NOW)
            doc, _ = w.score(H + 2 * 3600)
            tl = doc["trafficLights"]
            self.assertEqual(doc["staleRule"], R7.STALE_RULE)
            L = tl["lights"]["USDC|x10_1h|w1"]
            self.assertEqual(L["rung"], "disp")
            self.assertEqual(L["n"], 3)                                              # A1, A3, A4 (A2 mismatch)
            self.assertEqual(L["O"], 1.0)
            self.assertEqual(L["band"], R7.INSUFFICIENT)
            self.assertIn("bss_vs_previousModelB3", L["comparison"])
            self.assertIn("USDC|1h|pooled", tl["lights"])
            json.dumps(doc, allow_nan=False)
        finally:
            w.cleanup()


if __name__ == "__main__":
    unittest.main()
