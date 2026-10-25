#!/usr/bin/env python3
"""Generate lib/forecast/registry.json — the forecast engine's cell registry (lane Q41).

One row per cell (asset group x horizon x level). Classes come from the canonical Q26 router
(membrane-app research branch, scripts/research/history-forecasts/liqwarn/router.py), which reads the UI
confidence map (membrane-board knowledge/q26-ui-confidence-map.md, Release grading section first) through
its versioned routing table, with the live D12/D13 monitor flags applied. This script never invents a class.
It only removes displays the router would allow but the engine cannot honestly produce (see POLICY below).

Regenerate after every change to the confidence map or to d12/classes.json:

  # 1. the routing table from the current map (+ live monitor flags from membrane-datasets main)
  python3 <research>/liqwarn/gen_table.py --map <board>/knowledge/q26-ui-confidence-map.md \
      --live <board>/design/HISTORY_TOUCH_LIVE.md --datasets <datasets checkout> --out /tmp/routing-table.json
  # 2. this registry
  python3 scripts/forecast/gen_registry.py --liqwarn <research>/liqwarn --table /tmp/routing-table.json \
      --map <board>/knowledge/q26-ui-confidence-map.md --out lib/forecast/registry.json

Hand edit (when the research checkout is not at hand): change a row's "class" (and "gradedClass") in
registry.json, keep "source" pointing at the ruling, bump "version", and run
`npx vitest run tests/unit/forecast` — the tests check every row for shape and gating consistency.

POLICY (engine-side, the safe direction only — shows less, never more):
  P1 The router's rule touch-0-13 (7 d-30 d "label classes", HIGH labels only) grades a label-class product,
     not raw (fH) touch odds. Cells routed only through it become DO_NOT_SHOW.
  P2 Cells whose model is the frozen C3 recalibration (router source recal_fH) need a map the engine does not
     port: they show no probability (class kept, reason given).
  P3 A warning class without a deployed monitor displays as CALIBRATED (labelled context), as the router does.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import sys

HORIZONS = (1, 3, 6, 12, 24, 72, 168, 720)
LEVELS = (-2, -3, -5, -7, -10, -15, -20, -25, -30, -40)
GROUPS = {"btc_eth": "eth_btc", "large": "large_cap", "alt": "altcoin", "steth": "steth"}
CLASS = {"SKILL": "SKILL", "CALIBRATED-WARN": "CALIBRATED_WARN", "CALIBRATED": "CALIBRATED",
         "RECALIBRATE": "RECALIBRATE", "PENDING": "PENDING", "SCENARIO": "SCENARIO",
         "HISTORY COUNT": "HISTORY_COUNT", "DO NOT SHOW": "DO_NOT_SHOW"}
LABEL_CLASS_RULE = "touch-0-13"
LABELS = {
    "SKILL": "model forecast (tested on held-out data)",
    "CALIBRATED_WARN": "calibrated, not proven better than alternatives",
    "CALIBRATED": "historical context: calibrated, not a warning",
    "RECALIBRATE": "",
    "PENDING": "",
    "SCENARIO": "",
    "HISTORY_COUNT": "history count, not a probability",
    "DO_NOT_SHOW": "",
}
# Caveats the map attaches to specific ETH/BTC cells (quoted from the map, section named).
CAVEATS = [
    (lambda g, h, k: g == "eth_btc" and h in (1, 3, 6) and k > -10,
     "Graded on Chainlink-spliced rows; the Binance-input live definition is re-checked only at 6 h -10% "
     "(map: ETH/BTC price-source correction)."),
    (lambda g, h, k: g == "eth_btc" and h == 6 and k == -10, "Thin: 32 positives on Binance (map: price-source correction)."),
    (lambda g, h, k: g == "eth_btc" and h == 24 and k == -10, "Mild over-warn: Binance R 1.18 (map: price-source correction)."),
    (lambda g, h, k: h == 168, "Discrimination at 7 d is modest (AUC 0.65-0.71) (map: borrower liquidation warnings)."),
]
NEAR_LINE = {"minHorizonH": 6, "maxHorizonH": 24, "maxAbsLevelPct": 10,
             "reason": "Near-line limit: within 10% of the line at 6 h-1 d the odds are known to run low when "
                       "recent volatility is high, so they stay hidden.",
             "source": "q26-ui-confidence-map 'Near-line limit' (R23 ruling 2026-10-25, review b76dc78)"}
ASSETS = [
    {"symbol": "ETH", "group": "eth_btc", "series": "ETHUSDT", "basis": "spot",
     "note": "Binance ETHUSDT hourly klines (the D12 live definition)."},
    {"symbol": "WETH", "group": "eth_btc", "series": "ETHUSDT", "basis": "spot", "note": "Priced as ETH."},
    {"symbol": "BTC", "group": "eth_btc", "series": "BTCUSDT", "basis": "spot",
     "note": "Binance BTCUSDT hourly klines (the D12 live definition)."},
    {"symbol": "WBTC", "group": "eth_btc", "series": "BTCUSDT", "basis": "spot",
     "note": "Priced as BTC; the WBTC/BTC basis is not modelled."},
    {"symbol": "wstETH", "group": "eth_btc", "series": "ETHUSDT", "basis": "wrap-rate",
     "note": "Lending oracles price wstETH as ETH/USD x the wstETH wrap rate (measured on Aave across the "
             "Oct 10 2025 stETH/ETH depeg: wstETH/WETH constant 1.21598891; public/data/oct10-2025/README.md). "
             "A percentage fall of the wstETH oracle equals the ETH/USD fall, so the ETH cells apply. Not valid "
             "for an oracle that reads the stETH/ETH market feed (use stETH-market)."},
    {"symbol": "stETH-market", "group": "steth", "series": None, "basis": "none",
     "note": "stETH priced through the stETH/ETH market feed: the map's stETH row is DO NOT SHOW."},
]


def map_as_of(md):
    dates = re.findall(r"^- (\d{4}-\d{2}-\d{2}):", md, re.M)
    return max(dates) if dates else dt.date.today().isoformat()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--liqwarn", required=True, help="research checkout: scripts/research/history-forecasts/liqwarn")
    ap.add_argument("--table", required=True, help="routing-table.json generated from the current map")
    ap.add_argument("--map", required=True, help="membrane-board knowledge/q26-ui-confidence-map.md")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    sys.path.insert(0, os.path.abspath(a.liqwarn))
    import router as RT  # noqa: E402
    rt = RT.Router(a.table)
    md_bytes = open(a.map, "rb").read()
    map_sha = hashlib.sha256(md_bytes).hexdigest()
    if map_sha != rt.t["map_sha256"]:
        raise SystemExit("STOP: the routing table was generated from a different map; regenerate it first")
    as_of = map_as_of(md_bytes.decode())
    cells = []
    for rg, g in GROUPS.items():
        for h in HORIZONS:
            for k in LEVELS:
                o = rt.route(rg, h, k / 100.0)
                graded = CLASS[o["class"]]
                cls = graded
                notes = []
                if o.get("rule_id") == LABEL_CLASS_RULE:                         # P1
                    cls = "DO_NOT_SHOW"
                    notes.append("P1: only the 7 d-30 d label-class row (HIGH labels) covers this cell; "
                                 "it does not grade raw (fH) touch odds")
                elif o.get("monitor_missing"):                                   # P3
                    cls = "CALIBRATED"
                    notes.append("P3: warning class without a deployed live monitor -> labelled context")
                model = o.get("model_source") or o.get("source")
                if model == "recal_fH" and cls in ("SKILL", "CALIBRATED_WARN", "CALIBRATED"):
                    notes.append("P2: needs the frozen C3 recalibration, which the engine does not port")
                trigger = cls in ("SKILL", "CALIBRATED_WARN") and o["monitor"].get("status") == "deployed" \
                    and model == "raw_fH"
                caveat = " ".join(c for f, c in CAVEATS if f(g, h, k) and cls in ("SKILL", "CALIBRATED_WARN", "CALIBRATED")
                                  for c in [c]) or None
                src = f"{o.get('section') or 'none'}:{o.get('rule_id')} | {o.get('evidence')}"
                if notes:
                    src += " || " + "; ".join(notes)
                cells.append({
                    "id": f"{g}:{h}h:{k}", "group": g, "horizonH": h, "levelPct": k,
                    "class": cls, "gradedClass": graded, "label": LABELS[cls], "source": src,
                    "model": model if model in ("raw_fH", "recal_fH") else None,
                    "monitor": {"id": o["monitor"].get("id"), "status": o["monitor"].get("status", "none")},
                    "asOf": as_of, "trigger": bool(trigger), "caveat": caveat,
                })
    body = {"cells": cells, "nearLine": NEAR_LINE, "assets": ASSETS, "labels": LABELS}
    version = hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()[:16]
    out = {
        "schema": "membrane-forecast-registry/1", "version": version,
        "generatedAt": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "mapSha256": map_sha, "routingTableVersion": rt.version,
        "model": {"id": "raw_fH",
                  "definition": "raw (fH): HAR(Parkinson 1d/7d/30d) log-vol regression refit each quarter on all "
                                "origins i <= quarter start - T; filtered-historical-simulation of standardized "
                                "minimum depths; (f) EWMA fallback; running minimum over levels. Binance hourly klines.",
                  "source": "membrane-app research/history-forecasts live/q26_live_d12.py series_origin "
                            "(r192_borrower.task); golden live/d12_golden.json"},
        "horizonsH": list(HORIZONS), "levelsPct": list(LEVELS), **body,
    }
    with open(a.out, "w") as f:
        json.dump(out, f, indent=1, ensure_ascii=False)
        f.write("\n")
    shown = sum(c["class"] in ("SKILL", "CALIBRATED_WARN", "CALIBRATED") for c in cells)
    print(f"wrote {a.out}: version {version}, {len(cells)} cells, {shown} may show a probability")


if __name__ == "__main__":
    main()
