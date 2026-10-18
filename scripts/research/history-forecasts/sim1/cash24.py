"""CQ2 24 h minimum-cash quantiles from the frozen R11.11-M1 model (r1111_cash.forecast_m1, unchanged).

Its number is shown unchanged; the coupled engine never overrides it (design 2.3). Inputs: the market's daily
anchors and exact cash path from sim1.flows.load_market, ending at the t0 anchor.
"""
from __future__ import annotations

import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import r1111_cash as R11  # noqa: E402

MICRO = 10 ** 6
FROZEN_MODEL_SHA256 = "5a6d2cb7c9090a765ad262aefbf32e0da856d2349af64752e9a83627b91b2785"   # frozen-r1111.json


def forecast(M: dict) -> dict:
    n = len(M["t"]) - 1                       # the t0 origin; days 0..n-1 complete
    P = {"t": M["t"], "S_snap": M["S_snap"], "C_end": M["C_end"], "dmin": M["dmin"], "cash_t0": M["cash_t0"]}
    fo = R11.forecast_m1(P, [n]).get(n)
    if fo is None:
        return {"ok": False, "reason": "R10.4 forecast_origin returned None (too little history)"}
    q = [float(x) / MICRO for x in fo["q1"]]
    return {"ok": True, "origin": M["days"][n], "q05_usd": q[0], "q25_usd": q[1], "q50_usd": q[2],
            "cash_t0_usd": float(M["cash_t0"][n]) / MICRO, "supply_t0_usd": float(M["S_snap"][n]) / MICRO,
            "n_paths": int(fo["n_paths"]), "model": "R11.11-M1 (frozen, r1111_cash.forecast_m1)",
            "model_source_sha256": R11.model_source_hash(),
            "model_source_matches_frozen": R11.model_source_hash() == FROZEN_MODEL_SHA256,
            "display_floored_at_0_usd": [max(0.0, x) for x in q],
            "note": "frozen quantiles are shown unchanged; a negative value means the model's minimum crosses zero "
                    "(cash fully used); pool cash itself cannot go below 0"}
