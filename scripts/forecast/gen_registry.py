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
  # 2. the live D12 monitor flags (membrane-datasets is PRIVATE: no server route can read them without a
  #    credential, so this build-time sync is the only path; gh uses the operator's own login)
  gh api -H "Accept: application/vnd.github.raw" \
      "repos/triccs/membrane-datasets/contents/forecasts/q26-touch-live/d12/classes.json?ref=main" > /tmp/d12-classes.json
  gh api "repos/triccs/membrane-datasets/commits?path=forecasts/q26-touch-live/d12/classes.json&per_page=1" \
      --jq '.[0].commit.committer.date'          # -> --monitor-as-of
  # 3. this registry
  python3 scripts/forecast/gen_registry.py --liqwarn <research>/liqwarn --table /tmp/routing-table.json \
      --map <board>/knowledge/q26-ui-confidence-map.md --d12-classes /tmp/d12-classes.json \
      --monitor-as-of <that date> --out lib/forecast/registry.json
  # reproducibility check (CI style): regenerate with the committed generatedAt and compare bytes
  python3 scripts/forecast/gen_registry.py ...same args... --check

The runtime engine fails closed when monitorAsOf is older than 3 days (lib/forecast/registry.ts
MONITOR_MAX_AGE_S): every CALIBRATED_WARN cell then displays as CALIBRATED context with no trigger.
Re-sync at least every 3 days to keep warning cells live.

Hand edit (when the research checkout is not at hand): change a row's "class" (and "gradedClass") in
registry.json, keep "source" pointing at the ruling, bump "version", and run
`npx vitest run tests/unit/forecast` — the tests check every row for shape and gating consistency.

POLICY (engine-side, the safe direction only — shows less, never more):
  P1 The router's rule touch-0-13 (7 d-30 d "label classes", HIGH labels only) grades a label-class product,
     not raw (fH) touch odds. Cells routed only through it become DO_NOT_SHOW.
  P2 Cells whose model is the frozen C3 recalibration (router source recal_fH) need a map the engine does not
     port: they show no probability (class kept, reason given).
  P3 A warning class without a deployed monitor displays as CALIBRATED (labelled context), as the router does.
  P4 ETH/BTC cells graded only on Chainlink-spliced rows (the map's price-source correction: Chainlink calibration
     does not transfer to the Binance-input live definition): 1 h and 3 h -2/-3% -> PENDING (nothing shown);
     6 h -2...-7% -> CALIBRATED (context, no trigger) until re-checked on Binance input. 6 h -10% (re-checked,
     thin) keeps its class.
  P5 Live D12 flags (d12/classes.json): a cell the monitor downgraded displays as its live class (CALIBRATED,
     no trigger), and the file's commit time is recorded as monitorAsOf.
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
    (lambda g, h, k: g == "eth_btc" and h == 6 and k == -10, "Thin: 32 positives on Binance (map: price-source correction)."),
    (lambda g, h, k: g == "eth_btc" and h == 24 and k == -10, "Mild over-warn: Binance R 1.18 (map: price-source correction)."),
    (lambda g, h, k: h == 168, "Discrimination at 7 d is modest (AUC 0.65-0.71) (map: borrower liquidation warnings)."),
]
CLASS_ORDER = ["SKILL", "CALIBRATED_WARN", "CALIBRATED", "RECALIBRATE", "PENDING", "SCENARIO", "HISTORY_COUNT",
               "DO_NOT_SHOW"]
# router monitor status -> registry: deployed | missing (a monitor is needed, none deployed) | none
MONITOR_STATUS = {"deployed": "deployed", "needed": "missing", "missing": "missing", "none": "none"}
D12_GROUP = {"ETHBTC": "eth_btc", "LARGE": "large_cap"}
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
    # Membrane prices wstETH through a Uniswap V3 wstETH/WETH TWAP (membrane-solidity contracts/Oracle.sol;
    # OracleTemplateFactory has only Erc4626Unwrap and ExpirySeries adapters, no wrap-rate adapter), so the
    # stETH/ETH market basis applies: the map's stETH row, DO NOT SHOW. If a wrap-rate adapter is added, switch
    # this row to {"group": "eth_btc", "series": "ETHUSDT", "basis": "wrap-rate"} (Aave priced wstETH that way on
    # Oct 10 2025: wstETH/WETH constant 1.21598891, public/data/oct10-2025/README.md).
    {"symbol": "wstETH", "group": "steth", "series": None, "basis": "none",
     "note": "Membrane prices wstETH through a Uniswap V3 wstETH/WETH TWAP, so the stETH/ETH market basis "
             "applies: the map's stETH row is DO NOT SHOW (no meaningful blind test)."},
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
    ap.add_argument("--d12-classes", required=True, help="membrane-datasets forecasts/q26-touch-live/d12/classes.json")
    ap.add_argument("--monitor-as-of", required=True, help="commit time (ISO) of that classes.json on datasets main")
    ap.add_argument("--out", required=True)
    ap.add_argument("--fixed-time", default=None, help="generatedAt to write (reproducible output)")
    ap.add_argument("--check", action="store_true", help="regenerate with the committed generatedAt; exit 1 on any byte difference")
    a = ap.parse_args()
    sys.path.insert(0, os.path.abspath(a.liqwarn))
    import router as RT  # noqa: E402
    rt = RT.Router(a.table)
    md_bytes = open(a.map, "rb").read()
    map_sha = hashlib.sha256(md_bytes).hexdigest()
    if map_sha != rt.t["map_sha256"]:
        raise SystemExit("STOP: the routing table was generated from a different map; regenerate it first")
    as_of = map_as_of(md_bytes.decode())
    d12_raw = open(a.d12_classes, "rb").read()
    d12_doc = json.loads(d12_raw)
    if d12_doc.get("schema") != "q26-touch-live/d12/1/classes":
        raise SystemExit("STOP: unknown d12 classes schema")
    d12 = {(D12_GROUP[c["group"]], int(c["horizon_h"]), int(round(c["level"] * 100))): c
           for c in d12_doc["cells"].values() if c["group"] in D12_GROUP}
    monitor_as_of = dt.datetime.fromisoformat(a.monitor_as_of.replace("Z", "+00:00")).astimezone(dt.timezone.utc) \
        .strftime("%Y-%m-%dT%H:%M:%SZ")
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
                if g == "eth_btc" and h in (1, 3) and k in (-2, -3) and cls in ("CALIBRATED_WARN", "CALIBRATED"):  # P4
                    cls = "PENDING"
                    notes.append("P4: graded only on Chainlink-spliced rows; calibration does not transfer to the "
                                 "Binance-input live definition (map: ETH/BTC price-source correction)")
                elif g == "eth_btc" and h == 6 and k in (-2, -3, -5, -7) and cls == "CALIBRATED_WARN":       # P4
                    cls = "CALIBRATED"
                    notes.append("P4: graded on Chainlink-spliced rows; context only until re-checked on Binance input")
                live = d12.get((g, h, k))
                if live and (live.get("downgraded") or live.get("class") != live.get("defaultClass")):       # P5
                    lc = CLASS.get(live.get("class"), "DO_NOT_SHOW")
                    if lc == "CALIBRATED_WARN" and cls != "CALIBRATED_WARN":
                        lc = cls
                    if CLASS_ORDER.index(lc) > CLASS_ORDER.index(cls):
                        cls = lc
                        notes.append(f"P5: live D12 monitor downgraded this cell ({live.get('downgradedAt')})")
                model = o.get("model_source") or o.get("source")
                if model == "recal_fH" and cls in ("SKILL", "CALIBRATED_WARN", "CALIBRATED"):
                    notes.append("P2: needs the frozen C3 recalibration, which the engine does not port")
                trigger = cls in ("SKILL", "CALIBRATED_WARN") and o["monitor"].get("status") == "deployed" \
                    and model == "raw_fH"
                cav = [c for f, c in CAVEATS if f(g, h, k)] if cls in ("SKILL", "CALIBRATED_WARN", "CALIBRATED") else []
                cav += [n.split(": ", 1)[1] for n in notes if n.startswith(("P4", "P5"))]
                caveat = " ".join(dict.fromkeys(cav)) or None
                src = f"{o.get('section') or 'none'}:{o.get('rule_id')} | {o.get('evidence')}"
                if notes:
                    src += " || " + "; ".join(notes)
                cells.append({
                    "id": f"{g}:{h}h:{k}", "group": g, "horizonH": h, "levelPct": k,
                    "class": cls, "gradedClass": graded, "label": LABELS[cls], "source": src,
                    "model": model if model in ("raw_fH", "recal_fH") else None,
                    "monitor": {"id": o["monitor"].get("id"), "status": MONITOR_STATUS.get(o["monitor"].get("status"), "none")},
                    "asOf": as_of, "trigger": bool(trigger), "caveat": caveat,
                })
    body = {"cells": cells, "nearLine": NEAR_LINE, "assets": ASSETS, "labels": LABELS, "monitorAsOf": monitor_as_of,
            "monitorSource": {"path": "membrane-datasets forecasts/q26-touch-live/d12/classes.json",
                              "sha256": hashlib.sha256(d12_raw).hexdigest(),
                              "lastLedgerDate": d12_doc.get("lastLedgerDate"),
                              "downgraded": sorted(k for k, c in d12_doc["cells"].items() if c.get("downgraded"))}}
    version = hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()[:16]
    fixed = a.fixed_time
    if a.check:
        fixed = json.load(open(a.out))["generatedAt"]
    out = {
        "schema": "membrane-forecast-registry/1", "version": version,
        "generatedAt": fixed or dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "mapSha256": map_sha, "routingTableVersion": rt.version,
        "model": {"id": "raw_fH",
                  "definition": "raw (fH): HAR(Parkinson 1d/7d/30d) log-vol regression refit each quarter on all "
                                "origins i <= quarter start - T; filtered-historical-simulation of standardized "
                                "minimum depths; (f) EWMA fallback; running minimum over levels. Binance hourly klines.",
                  "source": "membrane-app research/history-forecasts live/q26_live_d12.py series_origin "
                            "(r192_borrower.task); golden live/d12_golden.json"},
        "horizonsH": list(HORIZONS), "levelsPct": list(LEVELS), **body,
    }
    text = json.dumps(out, indent=1, ensure_ascii=False) + "\n"
    if a.check:
        same = open(a.out, encoding="utf-8").read() == text
        print(f"check {a.out}: {'identical' if same else 'DIFFERS'} (version {version})")
        raise SystemExit(0 if same else 1)
    with open(a.out, "w", encoding="utf-8") as f:
        f.write(text)
    shown = sum(c["class"] in ("SKILL", "CALIBRATED_WARN", "CALIBRATED") for c in cells)
    print(f"wrote {a.out}: version {version}, {len(cells)} cells, {shown} may show a probability")


if __name__ == "__main__":
    main()
