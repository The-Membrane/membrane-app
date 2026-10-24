"""Q26 liquidation-warning forecast router (R19.4, development tool; nothing ships from it without an owner decision).

Maps (asset class, horizon, distance, context) to the forecast source the UI map allows, with its class, evidence
pointer and live-monitor id. The routing table is data: a versioned JSON written by gen_table.py from the UI map
(membrane-board knowledge/q26-ui-confidence-map.md). Regenerate it whenever the map changes.

Asset classes: btc_eth, large, alt, young (an altcoin listing aged 85-364 days), steth.
Context keys (all optional): oracle_through (bool: spot is through the line and the 1 h TWAP oracle is not yet),
listing_age_days (int), asset (str, informational).

Sources: raw_fH, recal_fH (slot for the R19.3 frozen recalibration), gru, reg2_young, imminent_oracle, chain,
history_count (fallback), plus research-only ids parsed from the map (linear_pool, recal_r131, ...).

Routing rule (fixed in code, the table supplies the cells):
  1. oracle_through -> the matching imminent-oracle rule, if any.
  2. young listing (asset class alt with 85 <= age <= 364, or class young) -> a matching reg2 rule, if any.
  3. Candidate rules match asset class, horizon (hours, inclusive) and distance (negative fraction; a set level
     matches within 0.5 percentage points). Rules whose class is DO NOT SHOW and whose source is a specific model
     (not raw_fH) are model vetoes: they never route, they only block that model.
  4. Pick by section rank (release grading > borrower warnings > oracle > price-touch), then by specificity
     (narrowest horizon span, then narrowest level span), then by class order.
  5. Classes that may show a number: SKILL, CALIBRATED-WARN, CALIBRATED, PENDING (labelled), RECALIBRATE only with
     a validated recalibration source. HISTORY COUNT, DO NOT SHOW, SCENARIO and "no match" route to history_count.
"""
from __future__ import annotations

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_TABLE = os.path.join(HERE, "routing-table.json")
CLASS_ORDER = ["SKILL", "CALIBRATED-WARN", "RECALIBRATE", "CALIBRATED", "PENDING", "SCENARIO", "HISTORY COUNT",
               "DO NOT SHOW"]
SHOWS_NUMBER = {"SKILL", "CALIBRATED-WARN", "CALIBRATED", "PENDING"}
ASSET_CLASSES = ("btc_eth", "large", "alt", "young", "steth")
SET_TOL = 0.005
OVERLAYS = ("recal_r131", "recal_fH")
YOUNG_AGE = (85, 364)


class Router:
    def __init__(self, table=None):
        if table is None or isinstance(table, str):
            with open(table or DEFAULT_TABLE) as f:
                table = json.load(f)
        if table.get("schema") != "liqwarn-routing/1":
            raise ValueError(f"unknown routing table schema {table.get('schema')!r}")
        self.t = table
        self.rules = table["rules"]
        self.version = table["version"]

    # ------------------------------------------------------------------------------------------------------------
    @staticmethod
    def _h_match(rule, h):
        if rule.get("cells"):
            return any(abs(h - c[0]) < 1e-9 for c in rule["cells"])
        return any(lo <= h <= hi for lo, hi in rule["horizon"])

    @staticmethod
    def _cell_match(rule, h, k):
        cells = rule.get("cells")
        return not cells or any(abs(h - c[0]) < 1e-9 and abs(k - c[1]) <= SET_TOL for c in cells)

    @staticmethod
    def _lv_match(rule, k):
        lv = rule["levels"]
        if lv is None:
            return True
        if lv["kind"] == "range":
            return lv["lo"] - 1e-9 <= k <= lv["hi"] + 1e-9
        return any(abs(k - v) <= SET_TOL for v in lv["values"])

    @staticmethod
    def _spec(rule):
        hspan = min(hi - lo for lo, hi in rule["horizon"])
        lv = rule["levels"]
        if lv is None:
            lspan = 1.0
        elif lv["kind"] == "range":
            lspan = lv["hi"] - lv["lo"]
        else:
            lspan = 0.0
        return (hspan, lspan)

    def _key(self, r):
        return (r["rank"], self._spec(r), CLASS_ORDER.index(r["class"]))

    @staticmethod
    def _is_veto(r):
        """a model-specific row that may not display (DO NOT SHOW, or UI use 'research build only' / 'None')."""
        return r["source"] not in ("raw_fH", "recal_fH") and (r["class"] == "DO NOT SHOW" or not r.get("display", True))

    def _out(self, rule, asset_class, horizon_h, distance, context, also, reason):
        if rule is None:
            return {"source": "history_count", "class": "HISTORY COUNT", "asset_class": asset_class,
                    "horizon_h": horizon_h, "distance": distance, "rule_id": None,
                    "evidence": "no UI-map rule covers this cell", "monitor": {"id": None, "status": "none"},
                    "table_version": self.version, "map_sha256": self.t["map_sha256"], "shows_number": False,
                    "monitor_missing": False, "also_matching": also, "reason": reason}
        cls, src = rule["class"], rule["source"]
        shows = cls in SHOWS_NUMBER or (cls == "RECALIBRATE" and src == "recal_fH" and rule.get("validated", False))
        if not shows:
            src_out = "history_count"
        else:
            src_out = src
        return {"source": src_out, "model_source": src, "class": cls, "asset_class": asset_class,
                "horizon_h": horizon_h, "distance": distance, "rule_id": rule["id"], "section": rule["section"],
                "evidence": rule["evidence"], "monitor": rule["monitor"], "table_version": self.version,
                "map_sha256": self.t["map_sha256"], "shows_number": shows,
                "monitor_missing": bool(shows and cls in ("CALIBRATED-WARN", "RECALIBRATE")
                                        and rule["monitor"].get("status") != "deployed"),
                "also_matching": also, "reason": reason, "context": context or {}}

    # ------------------------------------------------------------------------------------------------------------
    def route(self, asset_class, horizon_h, distance, context=None):
        """asset_class in ASSET_CLASSES; horizon_h > 0 (hours); distance < 0 (fraction, e.g. -0.20)."""
        if asset_class not in ASSET_CLASSES:
            raise ValueError(f"asset_class must be one of {ASSET_CLASSES}")
        if not horizon_h > 0:
            raise ValueError("horizon_h must be > 0")
        if not -1.0 < distance < 0.0:
            raise ValueError("distance must be a negative fraction in (-1, 0)")
        ctx = dict(context or {})
        age = ctx.get("listing_age_days")
        young = asset_class == "young" or (asset_class == "alt" and age is not None
                                           and YOUNG_AGE[0] <= age <= YOUNG_AGE[1])
        # 1. imminent oracle alert
        if ctx.get("oracle_through"):
            cand = [r for r in self.rules if r.get("context") == "oracle_through"
                    and asset_class in r["assets"] and self._h_match(r, horizon_h)]
            if cand:
                best = min(cand, key=self._key)
                return self._out(best, asset_class, horizon_h, distance, ctx, [r["id"] for r in cand if r is not best],
                                 "oracle_through context")
        # 2. young listing
        if young:
            cand = [r for r in self.rules if r.get("context") == "young_listing" and self._h_match(r, horizon_h)
                    and self._lv_match(r, distance) and not self._is_veto(r)
                    and (age is None or r.get("age_days", YOUNG_AGE)[0] <= age <= r.get("age_days", YOUNG_AGE)[1])]
            if cand:
                best = min(cand, key=self._key)
                return self._out(best, asset_class, horizon_h, distance, ctx, [], "young listing rule")
        # 3-4. general cells
        cls_for_match = "alt" if asset_class == "young" else asset_class
        cand = [r for r in self.rules if r.get("context") is None and cls_for_match in r["assets"]
                and self._h_match(r, horizon_h) and self._lv_match(r, distance)
                and self._cell_match(r, horizon_h, distance)]
        vetoed = sorted({r["source"] for r in cand if self._is_veto(r)})
        cand = [r for r in cand if not self._is_veto(r) and r["source"] not in vetoed]
        if not cand:
            return self._out(None, asset_class, horizon_h, distance, ctx, [], "no matching rule")
        best = min(cand, key=self._key)
        also = [r["id"] for r in sorted(cand, key=self._key) if r is not best]
        o = self._out(best, asset_class, horizon_h, distance, ctx, also, "best rule by section rank and specificity")
        # recalibration overlays: a displayable recal rule in the same or a higher-ranked section replaces the model
        # source of a displayed raw (fH) cell (R13.1 cells; the R19.3 frozen recalibration slot)
        if o["shows_number"] and best["source"] == "raw_fH":
            ov = [r for r in cand if r["source"] in OVERLAYS and r["rank"] <= best["rank"]
                  and (r["class"] in SHOWS_NUMBER or (r["class"] == "RECALIBRATE" and r.get("validated", False)))]
            if ov:
                r = min(ov, key=self._key)
                o.update(source=r["source"], model_source=r["source"], overlay_rule_id=r["id"],
                         evidence=f"{best['evidence']} || overlay: {r['evidence']}")
        o["vetoed_models"] = vetoed
        return o


def route(asset_class, horizon_h, distance, context=None, table=None):
    return Router(table).route(asset_class, horizon_h, distance, context)


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("asset_class", choices=ASSET_CLASSES)
    ap.add_argument("horizon_h", type=float)
    ap.add_argument("distance", type=float, help="negative fraction, e.g. -0.2")
    ap.add_argument("--oracle-through", action="store_true")
    ap.add_argument("--age", type=int, default=None)
    ap.add_argument("--table", default=None)
    a = ap.parse_args()
    ctx = {"oracle_through": a.oracle_through}
    if a.age is not None:
        ctx["listing_age_days"] = a.age
    print(json.dumps(route(a.asset_class, a.horizon_h, a.distance, ctx, a.table), indent=1, ensure_ascii=False))
