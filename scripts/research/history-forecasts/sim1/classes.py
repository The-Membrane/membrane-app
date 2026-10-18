"""Confidence classes (design 3.1, 3.1a, 3.3): weakest link per output and the confidence filter.

Order P > X > N > S. The default filter is {P}. Widening adds outputs and never changes a shown number. Classes
are never blended into one score.
"""
from __future__ import annotations

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ORDER = ("P", "X", "N", "S")
RANK = {c: i for i, c in enumerate(ORDER)}
DEFAULT_FILTER = ("P",)
WIDEN_STEPS = (("P",), ("P", "X"), ("P", "X", "N"), ("P", "X", "N", "S"))
KIND = {"P": "probability", "X": "calibrated_scenario", "N": "not_confirmed", "S": "scenario"}


def load(path=None) -> dict:
    with open(path or os.path.join(HERE, "classes.json")) as f:
        return json.load(f)


def weakest(classes) -> str:
    classes = list(classes)
    if not classes:
        raise ValueError("empty chain")
    return max(classes, key=lambda c: RANK[c])


def module_class(table: dict, name: str, checks: dict | None = None) -> str:
    mods = {**table["modules"], **table.get("external", {})}
    m = mods[name]
    c = m["class"]
    req = m.get("requires_check")
    if req is not None and not (checks or {}).get(req, False):
        c = "S"
    return c


def output_class(table: dict, out_id: str, checks: dict | None = None) -> dict:
    o = table["outputs"][out_id]
    cls = weakest(module_class(table, n, checks) for n in o["chain"])
    if o.get("tail") == "q99":
        cls = weakest([cls, "S"])        # owner decision (a): q99 scenario-only unless validated
    mods = {**table["modules"], **table.get("external", {})}
    labels, evidence = [], []
    for n in o["chain"]:
        labels += [x for x in mods[n].get("labels", []) if x not in labels]
        evidence.append({"module": n, "class": module_class(table, n, checks), "evidence": mods[n]["evidence"]})
    return {"class": cls, "kind": KIND[cls], "labels": labels, "evidence": evidence}


def parse_filter(text: str | None) -> tuple:
    if not text:
        return DEFAULT_FILTER
    got = tuple(c.strip().upper() for c in text.split(",") if c.strip())
    bad = [c for c in got if c not in RANK]
    if bad:
        raise ValueError(f"unknown class {bad}")
    return tuple(c for c in ORDER if c in got)


def wording(cls: str, tail: str | None) -> str:
    if tail is None:
        return {"P": "probability", "X": "scenario tail, calibrated on unseen history", "N": "range (not confirmed)",
                "S": "scenario"}[cls]
    if cls == "P":
        return {"q95": "1-in-20", "q99": "1-in-100"}[tail]
    pct = {"q95": "95th", "q99": "99th"}[tail]
    return f"scenario tail ({pct} of N paths)" if cls != "X" else f"scenario tail ({pct}), calibrated on unseen history"


def apply_filter(outputs: list, flt) -> tuple[list, list]:
    """Split outputs into (shown, withheld). Withheld rows keep id and class, never a value."""
    shown, held = [], []
    for o in outputs:
        if o["class"] in flt:
            shown.append(o)
        else:
            held.append({"id": o["id"], "class": o["class"], "kind": o["kind"]})
    return shown, held
