"""Unit tests for liqwarn/gen_table.py and liqwarn/router.py (python3 -m unittest test_router.py)."""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import gen_table as G  # noqa: E402
import router as RT  # noqa: E402

M = "−"
MINI_MAP = f"""# map

## Price-touch odds (P(min low within horizon ≤ level))

| Horizon | Levels | Assets | Class | Evidence | UI use |
|---|---|---|---|---|---|
| 1 h | to {M}3% | altcoins | **SKILL** | blind8 | Approach-zone alerts |
| 12 h | to {M}10% | altcoins | **SKILL** | blind8 | same |
| 1 h–12 h | smallest levels ({M}2/{M}3%) | altcoins | R13.1 recalibration **SKILL** (calibration fix) | B15a, only at 1 h {M}2/{M}3%, 12 h {M}2% (retro) | Apply only there |
| 1 h–12 h | {M}2…{M}10% | altcoins, strict walk-forward GRU residual on (fH) | **DO NOT SHOW** (research) | dev only | None |
| 6 h, 12 h | {M}3% (6 h), {M}2% (12 h) | altcoins | **SKILL** (provisional) | R16.2 linear pool lp | Research build only |
| 12 h–3 d | {M}15% and deeper | ETH, BTC | **HISTORY COUNT** | 2–3 events | History count |
| 1–12 h | same bands | ETH, BTC, stETH | **PENDING** | live log D8 | Labelled |
| 3 d | {M}15% | young altcoin listings aged about 85–364 days, reg2 decoder | **SKILL** (modest) | R13.5r | Far-zone odds |

## Borrower liquidation warnings, ETH/BTC and large caps (owner ruling 2026-10-24)

| Horizon | Level | Assets | Class | Evidence (development, seen rows) | UI use |
|---|---|---|---|---|---|
| 6 h–7 d | {M}10% | ETH, BTC, large caps | **CALIBRATED-WARN** | Raw (fH) | Borrower warning odds |
| 1 d–7 d | {M}20% | ETH, BTC, large caps | **CALIBRATED-WARN** | Raw (fH) | Borrower warning odds |
| within 3 d | {M}30% | ETH, BTC | **HISTORY COUNT** | 0–8 events | Count only |

## Oracle and liquidation-proximity

| Signal | Class | Evidence | UI use |
|---|---|---|---|
| TWAP "already through" alert, altcoins (KuCoin, 1/3/6 h) | **SKILL** (H1) / CALIBRATED | R12.7 | Imminent-zone alert |
| Same, ETH | **PENDING** | live log D10 | Labelled pending |
| Liquidation volume forecast | **SCENARIO** | R11.1-v4 | Scenario only |
"""

RELEASE = f"""
## Release grading (R19.3, 2026-10-24)

| Group | Horizon | Level | Class | Evidence | UI use |
|---|---|---|---|---|---|
| large caps | 3 d | {M}30% | **RECALIBRATE** | C1 frozen params sha256 abcd | Recalibrated warning odds |
| large caps | 7 d | {M}30% | **RECALIBRATE** (no validated fix) | C1 failed | None |
| ETH, BTC | 3 d | {M}30% | **CALIBRATED** (chained estimate) | R19.4 chained | Context |
"""


REAL_RELEASE = f"""
## Release grading under the correct+informative bar (2026-10-24)

| Group | T | Class by level (R; slope; BSS vs (a); BSS vs (e); AUC; pos) |
|---|---|---|
| ETH/BTC | 6h | CALIBRATED-WARN {M}2, {M}10%: R 0.86…0.92, pos 48…2295<br>HISTORY COUNT {M}15, {M}20, {M}30% (pos 0…8) |
| ETH/BTC | 3d | CALIBRATED-WARN {M}10%: R 0.93<br>DO NOT SHOW {M}20%: R 0.84<br>HISTORY COUNT {M}30% (pos 21) |
| Altcoins | 1h | RECALIBRATE {M}2, {M}5%: R 1.03…1.07; C3 repair in CV at {M}5% |
| Altcoins | 12h | RECALIBRATE {M}15%: R 1.1; C3 repair in CV at {M}15% |

- **Cells repaired in walk-forward CV:** altcoins 1 h {M}5%; 12 h {M}15%.
- **Out-of-sample transfer check:** the repair holds at **1 cell only**: altcoins 1 h {M}5%. More text.

**Live monitors needed.** D12 (in deployment) covers ETH/BTC and large caps at {M}10% 6 h–7 d and {M}20% 1 d–7 d. Other text.
"""


def table_of(md, live=""):
    rules, unparsed, live_ids = G.build(md, live)
    return {"schema": G.SCHEMA, "version": "test", "map_sha256": "x", "rules": rules, "unparsed": unparsed,
            "live_monitors_deployed": live_ids, "section_rank": G.SECTION_RANK}


class TestParsers(unittest.TestCase):
    def test_horizon(self):
        self.assertEqual(G.parse_horizon("1 h"), [[1, 1]])
        self.assertEqual(G.parse_horizon("12 h–3 d"), [[12, 72]])
        self.assertEqual(G.parse_horizon("1–12 h"), [[1, 12]])
        self.assertEqual(G.parse_horizon("within 12 h"), [[12, 12]])
        self.assertEqual(G.parse_horizon("6 h, 12 h"), [[6, 6], [12, 12]])
        self.assertEqual(G.parse_horizon("7 d–30 d"), [[168, 720]])
        self.assertEqual(G.parse_horizon("any"), [[0, G.INF_H]])
        self.assertIsNone(G.parse_horizon("sometimes"))

    def test_levels(self):
        self.assertEqual(G.parse_levels(f"to {M}3%"), {"kind": "range", "lo": -0.03, "hi": 0.0})
        self.assertEqual(G.parse_levels(f"{M}25% and deeper"), {"kind": "range", "lo": -1.0, "hi": -0.25})
        self.assertEqual(G.parse_levels(f"{M}15%, {M}20%"), {"kind": "set", "values": [-0.2, -0.15]})
        self.assertEqual(G.parse_levels(f"{M}2…{M}10%"), {"kind": "range", "lo": -0.10, "hi": -0.02})
        self.assertEqual(G.parse_levels(f"smallest levels ({M}2/{M}3%)"), {"kind": "set", "values": [-0.03, -0.02]})
        self.assertEqual(G.parse_levels("shallow–mid"), {"kind": "range", "lo": -0.10, "hi": 0.0})
        self.assertIsNone(G.parse_levels("whatever"))

    def test_assets_class(self):
        self.assertEqual(G.parse_assets("ETH, BTC, large caps"), ["btc_eth", "large"])
        self.assertEqual(G.parse_assets("young altcoin listings aged 85–364 days"), ["young"])
        self.assertEqual(G.parse_class("**CALIBRATED-WARN**"), "CALIBRATED-WARN")
        self.assertEqual(G.parse_class("CALIBRATED context"), "CALIBRATED")
        self.assertEqual(G.parse_class("**RECALIBRATE** (no validated fix)"), "RECALIBRATE")

    def test_explicit_cells(self):
        c = G.explicit_cells(f"B15a, only at 1 h {M}2/{M}3%, 12 h {M}2% (retro)")
        self.assertEqual(c, [[1, -0.02], [1, -0.03], [12, -0.02]])

    def test_deterministic(self):
        a, b = table_of(MINI_MAP), table_of(MINI_MAP)
        self.assertEqual(json.dumps(a, sort_keys=True), json.dumps(b, sort_keys=True))


class TestRouter(unittest.TestCase):
    def setUp(self):
        self.r = RT.Router(table_of(MINI_MAP, "### D8 — x\n### D10 — y\n"))

    def check_keys(self, o):
        for k in ("source", "class", "evidence", "monitor", "table_version", "rule_id"):
            self.assertIn(k, o)

    def test_borrower_warn(self):
        o = self.r.route("btc_eth", 24, -0.20)
        self.check_keys(o)
        self.assertEqual((o["source"], o["class"]), ("raw_fH", "CALIBRATED-WARN"))
        self.assertEqual(o["monitor"]["id"], "D12")
        self.assertTrue(o["monitor_missing"])          # D12 not deployed in this live doc

    def test_borrower_beats_touch_section(self):
        o = self.r.route("btc_eth", 24, -0.20)
        self.assertIn("touch-0-5", o["also_matching"])   # the HISTORY COUNT touch row matched but lost on rank

    def test_history_count_gap(self):
        o = self.r.route("btc_eth", 72, -0.30)
        self.assertEqual((o["source"], o["class"]), ("history_count", "HISTORY COUNT"))
        self.assertFalse(o["shows_number"])

    def test_no_rule_fallback(self):
        o = self.r.route("large", 72, -0.30)
        self.assertEqual((o["source"], o["class"], o["rule_id"]), ("history_count", "HISTORY COUNT", None))

    def test_gru_veto_never_routes(self):
        for h, k in ((1, -0.02), (12, -0.05), (12, -0.10)):
            o = self.r.route("alt", h, k)
            self.assertNotEqual(o["source"], "gru")
            self.assertIn("gru", o["vetoed_models"])

    def test_research_only_lp_never_routes(self):
        o = self.r.route("alt", 6, -0.03)
        self.assertNotEqual(o["source"], "linear_pool")

    def test_r131_overlay_only_at_its_cells(self):
        self.assertEqual(self.r.route("alt", 12, -0.02)["source"], "recal_r131")
        self.assertEqual(self.r.route("alt", 12, -0.03)["source"], "raw_fH")
        self.assertEqual(self.r.route("alt", 1, -0.03)["source"], "recal_r131")

    def test_oracle_context(self):
        o = self.r.route("alt", 3, -0.03, {"oracle_through": True})
        self.assertEqual((o["source"], o["class"]), ("imminent_oracle", "SKILL"))
        o = self.r.route("btc_eth", 3, -0.03, {"oracle_through": True})
        self.assertEqual((o["source"], o["class"], o["monitor"]["id"]), ("imminent_oracle", "PENDING", "D10"))
        self.assertEqual(o["monitor"]["status"], "deployed")

    def test_young_listing(self):
        o = self.r.route("alt", 72, -0.15, {"listing_age_days": 200})
        self.assertEqual(o["source"], "reg2_young")
        o = self.r.route("alt", 72, -0.15, {"listing_age_days": 30})       # too young: not reg2
        self.assertNotEqual(o["source"], "reg2_young")

    def test_pending_eth_short(self):
        o = self.r.route("btc_eth", 3, -0.03)
        self.assertEqual((o["class"], o["monitor"]["id"]), ("PENDING", "D8"))

    def test_bad_inputs(self):
        with self.assertRaises(ValueError):
            self.r.route("memecoin", 24, -0.1)
        with self.assertRaises(ValueError):
            self.r.route("alt", 24, 0.1)
        with self.assertRaises(ValueError):
            self.r.route("alt", 0, -0.1)


class TestReleaseGrading(unittest.TestCase):
    def setUp(self):
        self.r = RT.Router(table_of(MINI_MAP + RELEASE))

    def test_release_section_present_and_ranked_first(self):
        o = self.r.route("btc_eth", 72, -0.30)
        self.assertEqual((o["source"], o["class"], o["section"]), ("chain", "CALIBRATED", "release"))

    def test_validated_recal_slot(self):
        o = self.r.route("large", 72, -0.30)
        self.assertEqual((o["source"], o["class"]), ("recal_fH", "RECALIBRATE"))
        self.assertTrue(o["shows_number"])

    def test_unvalidated_recal_not_shown(self):
        o = self.r.route("large", 168, -0.30)
        self.assertEqual((o["source"], o["class"]), ("history_count", "RECALIBRATE"))
        self.assertFalse(o["shows_number"])


class TestRealReleaseFormat(unittest.TestCase):
    def setUp(self):
        self.r = RT.Router(table_of(MINI_MAP + REAL_RELEASE, "### D12 — monitor\n"))

    def test_d12_cell_warn_with_monitor(self):
        o = self.r.route("btc_eth", 6, -0.10)
        self.assertEqual((o["source"], o["class"], o["monitor"]["id"], o["monitor"]["status"]),
                         ("raw_fH", "CALIBRATED-WARN", "D12", "deployed"))
        self.assertEqual(o["display_class"], "CALIBRATED-WARN")

    def test_warn_without_monitor_is_context(self):
        o = self.r.route("btc_eth", 6, -0.02)
        self.assertEqual(o["class"], "CALIBRATED-WARN")
        self.assertTrue(o["monitor_missing"])
        self.assertTrue(o["display_class"].startswith("CALIBRATED (labelled context"))

    def test_release_overrides_borrower_table(self):
        o = self.r.route("btc_eth", 72, -0.20)            # borrower table said CALIBRATED-WARN (1 d-7 d -20%)
        self.assertEqual((o["source"], o["class"], o["section"]), ("history_count", "DO NOT SHOW", "release"))
        o = self.r.route("btc_eth", 72, -0.30)
        self.assertEqual(o["class"], "HISTORY COUNT")

    def test_recal_transfer_confirmed_vs_cv_only_vs_none(self):
        o = self.r.route("alt", 1, -0.05)
        self.assertEqual((o["source"], o["class"], o["shows_number"]), ("recal_fH", "RECALIBRATE", True))
        o = self.r.route("alt", 12, -0.15)
        self.assertEqual((o["source"], o["class"]), ("recal_fH", "CALIBRATED"))
        o = self.r.route("alt", 1, -0.02)
        self.assertEqual((o["source"], o["class"], o["shows_number"]), ("history_count", "RECALIBRATE", False))


class TestGeneratedTable(unittest.TestCase):
    def test_file_roundtrip(self):
        with tempfile.TemporaryDirectory() as d:
            mp = os.path.join(d, "map.md")
            with open(mp, "w") as f:
                f.write(MINI_MAP)
            out = os.path.join(d, "t.json")
            sys.argv = ["gen_table.py", "--map", mp, "--out", out]
            G.main()
            with open(out) as f:
                t = json.load(f)
            self.assertEqual(t["schema"], G.SCHEMA)
            self.assertFalse(t["release_grading_present"])
            r = RT.Router(out)
            self.assertEqual(r.route("btc_eth", 24, -0.2)["table_version"], t["version"])

    def test_committed_table_loads(self):
        p = os.path.join(HERE, "routing-table.json")
        if os.path.exists(p):
            r = RT.Router(p)
            o = r.route("btc_eth", 24, -0.20)
            self.assertIn(o["class"], RT.CLASS_ORDER)


def d12_classes(downgraded=()):
    """A classes.json shaped like q26_live_d12.write_summary (D12-A2): ETH/BTC and large caps at 6 h and 3 d."""
    cells = {}
    for g in ("ETHBTC", "LARGE"):
        for T, tl in ((6, "6h"), (72, "3d")):
            for k in (-0.02, -0.10, -0.20):
                key = f"{g} {tl} {int(round(k * 100))}%"
                dg = key in downgraded
                cells[key] = {"group": g, "horizon": tl, "horizon_h": T, "level": k,
                              "class": "CALIBRATED" if dg else "CALIBRATED-WARN", "defaultClass": "CALIBRATED-WARN",
                              "downgraded": dg, "downgradedAt": "2027-02-03" if dg else None,
                              "monitors": [f"{tl} pool -2..-10% {g}"], "lastObserved": "2027-02-03"}
    return {"schema": "q26-touch-live/d12/1/classes", "lastLedgerDate": "2027-02-03", "cells": cells}


class TestLiveD12Classes(unittest.TestCase):
    def table(self, downgraded=()):
        rules, unparsed, live_ids = G.build(MINI_MAP + REAL_RELEASE, "", d12_classes(downgraded))
        return RT.Router({"schema": G.SCHEMA, "version": "test", "map_sha256": "x", "rules": rules,
                          "unparsed": unparsed, "live_monitors_deployed": live_ids, "section_rank": G.SECTION_RANK})

    def test_live_coverage_replaces_board_sentence(self):
        r = self.table()
        o = r.route("btc_eth", 6, -0.02)              # not in the board sentence, but in the live classes
        self.assertEqual((o["class"], o["monitor"]["status"]), ("CALIBRATED-WARN", "deployed"))
        self.assertFalse(o["monitor_missing"])
        o = r.route("btc_eth", 6, -0.10)
        self.assertEqual((o["source"], o["class"], o["display_class"]), ("raw_fH", "CALIBRATED-WARN",
                                                                         "CALIBRATED-WARN"))

    def test_downgraded_cell_routes_as_calibrated(self):
        r = self.table(downgraded=("ETHBTC 6h -10%",))
        o = r.route("btc_eth", 6, -0.10)
        self.assertEqual((o["source"], o["class"], o["section"], o["display_class"]),
                         ("raw_fH", "CALIBRATED", "live", "CALIBRATED"))
        self.assertTrue(o["rule_id"].startswith("live-d12-btc_eth-6h-10"))
        self.assertIn("2027-02-03", o["evidence"])
        o = r.route("large", 6, -0.10)                  # the other group is not downgraded
        self.assertEqual(o["class"], "CALIBRATED-WARN")
        o = r.route("btc_eth", 6, -0.02)                # another level of the same group is not downgraded
        self.assertEqual(o["class"], "CALIBRATED-WARN")

    def test_downgrade_never_raises_a_lower_map_class(self):
        r = self.table(downgraded=("ETHBTC 3d -20%",))   # map: DO NOT SHOW; the live rule may not show a number
        o = r.route("btc_eth", 72, -0.20)
        self.assertEqual((o["class"], o["section"], o["shows_number"]), ("DO NOT SHOW", "release", False))

    def test_datasets_argument_roundtrip(self):
        with tempfile.TemporaryDirectory() as d:
            mp = os.path.join(d, "map.md")
            with open(mp, "w") as f:
                f.write(MINI_MAP + REAL_RELEASE)
            cp = os.path.join(d, "ds", G.D12_CLASSES_REL)
            os.makedirs(os.path.dirname(cp))
            with open(cp, "w") as f:
                json.dump(d12_classes(("LARGE 3d -10%",)), f)
            out = os.path.join(d, "t.json")
            sys.argv = ["gen_table.py", "--map", mp, "--datasets", os.path.join(d, "ds"), "--out", out]
            G.main()
            t = json.load(open(out))
            self.assertEqual(t["d12_classes"]["downgraded"], ["LARGE 3d -10%"])
            self.assertEqual(RT.Router(out).route("large", 72, -0.10)["class"], "CALIBRATED")


if __name__ == "__main__":
    unittest.main()
