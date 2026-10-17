#!/usr/bin/env python3
"""Q26 round 7 R7.1 in the touch scorer (synthetic; no network).

  python3 -m unittest scripts/research/history-forecasts/live/test_r7_touch.py -v
"""
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import q26_live_common as C  # noqa: E402
import q26_live_score as SC  # noqa: E402
import r7_live as R7  # noqa: E402
from test_q26_live import LiveEnv, U  # noqa: E402


def outcome(date, k, y, p, displayed=None, shipped="f", a5=None, model="A6", T="1d"):
    o = {"date": date, "asset": "ETH", "T": T, "T_h": 24, "k": k, "issuedAt": 0, "status": "resolved", "y": y,
         "p": p, "shipped": shipped, "model": model, "regime": "mid"}
    if displayed:
        o["displayed"] = displayed
    if a5:
        o["a5"] = {"shipped": a5}
    return o


class TestTouchLights(unittest.TestCase):
    def test_units_rung_and_comparisons(self):
        rows = []
        for i in range(40):
            d = f"2026-{11 + i // 30:02d}-{1 + i % 30:02d}"
            for k in (-0.02, -0.05):
                rows.append(outcome(d, k, int(i % 4 == 0), {"a": 0.3, "f": 0.2, "fH": 0.25, "fbL": 0.4},
                                    displayed="fH", a5="fbL"))
        rows.append(outcome("2026-10-31", -0.02, 1, {"a": 0.3, "f": 0.2}, model="A5", shipped="f"))   # no fH p
        L = SC.traffic_lights(rows)
        u = L["ETH|1d|-0.02"]
        self.assertEqual(u["rung"], "fH")
        self.assertEqual(u["n"], 40)                                       # the A5 row carries no fH p
        self.assertAlmostEqual(u["E"], 40 * 0.25)
        self.assertIn(u["band"], R7.BANDS)
        self.assertEqual(u["comparison"]["bss_vs_previousModelA5"]["n"], 40)
        self.assertEqual(L["ETH|1d|pooled"]["n"], 80)
        self.assertAlmostEqual(L["ETH|1d|pooled"]["E"], 80 * 0.25)
        self.assertEqual(SC.prev_model_p(rows[-1]), 0.2)                    # A5 row: its own shipped rung

    def test_scorer_writes_lights_and_monday_record(self):
        env = LiveEnv(U("2026-10-14T00:17:30Z"))                          # a Wednesday
        try:
            sdir = os.path.join(C.live_dir(env.root), "scores")
            wpath = os.path.join(sdir, R7.WEEKLY_FILE)
            for day in range(14, 22):
                env.clock.t = U(f"2026-10-{day}T00:17:30Z")
                env.issue()
                env.clock.t = U(f"2026-10-{day}T00:47:10Z")
                doc, _ = env.score()
                self.assertIn("trafficLights", doc)
                self.assertEqual(doc["staleRule"], R7.STALE_RULE)
                if day < 19:
                    self.assertFalse(os.path.exists(wpath))
            recs = R7.read_weekly(wpath)
            self.assertEqual([r["date"] for r in recs], ["2026-10-19"])    # Monday only, once
            tl = doc["trafficLights"]
            self.assertIn("ETH|6h|pooled", tl["lights"])
            self.assertTrue(all(L["band"] == R7.INSUFFICIENT for L in tl["lights"].values()))   # < 30 days
            self.assertIn("earlyWarning", tl["lights"]["ETH|6h|pooled"])   # 6h rows of 7 issue days resolved
            json.dumps(doc, allow_nan=False)
        finally:
            env.close()


if __name__ == "__main__":
    unittest.main()
