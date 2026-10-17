#!/usr/bin/env python3
"""Q26 A6 deviation D3, display only: display-a6.json = the displayed rung per (asset, T).

Implements membrane-board `design/HISTORY_TOUCH_PREREG_A6.md` deviation D3 (commit 06de6f0, owner ruling "always show
the best model") as a post-process of the frozen A6 run and its single blind-5 score (membrane-datasets
`history-forecasts/a6/run-015512cb/`, published in bf26afb and 3699e7a). Nothing is refit and no model is evaluated:
every number comes from the published files.

  python3 a6_display_d3.py --run RUN_DIR --out OUT_DIR        (never overwrites)

Inputs (sha256 checked): frozen-a6.json (97501da3...), results-blind5.json (beb7334f...).

Rule (D3), per (asset, T):
  - ETH and BTC: among the candidates (f), (fbL), (fh), (fH), (fHb), the one with the highest pooled blind-5 BSS vs (f)
    (results-blind5.json pooled[T].comparisons["<rung>_vs_f"].bss; (f) itself = 0, no CI) is displayed if its CI
    lower bound (ci95[0]) is above 0. Otherwise the frozen A6 shipped rung stays. Ties go to the earlier candidate in
    the A6 tie order (f, fbL, fh, fH, fHb). "Pooled" is the registered pooled number (with LUNAUSDT, A6 D1).
  - stETH: the frozen A6 shipped rung (the generic blind sets do not test a peg ratio).
Cross-check (else STOP): the result is exactly the D3 result -- (fH) at 6h, 1d, 3d for ETH and BTC, every other cell
the frozen A6 shipped rung; changed cells ETH 1d (f -> fH), ETH 3d (fHb -> fH), BTC 6h (fHb -> fH).

Output: OUT_DIR/display-a6.json (deterministic bytes: no timestamps, fixed key order, one trailing newline) and
OUT_DIR/display-a6.json.sha256. The live issuer reads it with --display-a6 / --display-a6-sha256.
"""
import argparse
import hashlib
import json
import os
import sys

INPUT_SHA256 = {
    "frozen-a6.json": "97501da3fbb4de25c0257b6945a061543bf7fbef1344246cd47b418664bf02c0",
    "results-blind5.json": "beb7334ff4fea674dcb20ed3b777630932204a295baa7debdf9adecadf3f3411",
}
RUN_REL = "history-forecasts/a6/run-015512cb"
DEVIATION = {"repo": "triccs/membrane-board", "path": "design/HISTORY_TOUCH_PREREG_A6.md", "deviation": "D3",
             "commit": "06de6f0"}
SCHEMA = "q26-touch-live/display-a6/1"
ASSETS = ("ETH", "BTC", "stETH")
HORIZONS = ("6h", "1d", "3d", "7d", "14d", "30d")
CANDIDATES = ("f", "fbL", "fh", "fH", "fHb")          # A6 tie order without (a)
RULE_ASSETS = ("ETH", "BTC")
EXPECTED = {
    "ETH": {"6h": "fH", "1d": "fH", "3d": "fH", "7d": "fbL", "14d": "fbL", "30d": "fbL"},
    "BTC": {"6h": "fH", "1d": "fH", "3d": "fH", "7d": "fH", "14d": "fH", "30d": "fH"},
    "stETH": {"6h": "fHb", "1d": "a", "3d": "a", "7d": "a", "14d": "a", "30d": "a"},
}
EXPECTED_CHANGES = [("ETH", "1d", "f", "fH"), ("ETH", "3d", "fHb", "fH"), ("BTC", "6h", "fHb", "fH")]
RULE_TEXT = ("ETH and BTC: per T, the candidate (f, fbL, fh, fH, fHb) with the highest pooled blind-5 BSS vs (f) is "
             "displayed if its CI lower bound is above 0; otherwise the frozen A6 shipped rung stays. stETH keeps its "
             "shipped rungs. The label shown is the displayed rung's frozen A6 label for the current regime.")


def sha256_bytes(b):
    return hashlib.sha256(b).hexdigest()


def read_checked(run, name):
    with open(os.path.join(run, name), "rb") as f:
        raw = f.read()
    if sha256_bytes(raw) != INPUT_SHA256[name]:
        raise SystemExit(f"STOP: {name} sha256 {sha256_bytes(raw)} != {INPUT_SHA256[name]}")
    return raw


def choose(comparisons, shipped):
    """The D3 choice for one (asset, T): (displayed, reason, candidate table, best candidate)."""
    table = {"f": {"bss_vs_f": 0.0, "ci95": None}}
    for r in CANDIDATES[1:]:
        c = comparisons[f"{r}_vs_f"]
        table[r] = {"bss_vs_f": float(c["bss"]), "ci95": [float(c["ci95"][0]), float(c["ci95"][1])]}
    best = CANDIDATES[0]
    for r in CANDIDATES[1:]:                         # strict '>' keeps the earlier candidate on a tie
        if table[r]["bss_vs_f"] > table[best]["bss_vs_f"]:
            best = r
    ci = table[best]["ci95"]
    if ci is not None and ci[0] > 0:
        return best, f"best pooled blind-5 BSS vs (f) ({best}), CI lower bound above 0", table, best
    return shipped, "no candidate beats (f) with CI lower bound above 0: shipped rung stays", table, best


def build(run):
    fz = json.loads(read_checked(run, "frozen-a6.json"))
    res = json.loads(read_checked(run, "results-blind5.json"))
    shipped = {a: {T: fz["shipped"][a][T] for T in HORIZONS} for a in ASSETS}
    displayed, selection, changes = {}, {}, []
    for a in ASSETS:
        displayed[a], selection[a] = {}, {}
        for T in HORIZONS:
            ship = shipped[a][T]
            if a in RULE_ASSETS:
                disp, why, table, best = choose(res["pooled"][T]["comparisons"], ship)
                selection[a][T] = {"shipped": ship, "displayed": disp, "best": best, "reason": why,
                                   "candidates": table}
            else:
                disp = ship
                selection[a][T] = {"shipped": ship, "displayed": disp, "best": None,
                                   "reason": "stETH keeps its shipped rung (generic blind sets do not test a peg ratio)",
                                   "candidates": None}
            displayed[a][T] = disp
            if disp != ship:
                changes.append({"asset": a, "T": T, "shipped": ship, "displayed": disp})
    if displayed != EXPECTED:
        raise SystemExit(f"STOP: displayed rungs {displayed} != the D3 result {EXPECTED}")
    if [(c["asset"], c["T"], c["shipped"], c["displayed"]) for c in changes] != EXPECTED_CHANGES:
        raise SystemExit(f"STOP: changed cells {changes} != the D3 changes {EXPECTED_CHANGES}")
    return {
        "schema": SCHEMA,
        "what": "Q26 A6 D3 displayed rung per (asset, T): the best model on blind set 5 (display only; the shipped "
                "rung, labels and registered statistics are unchanged)",
        "deviation": DEVIATION,
        "rule": RULE_TEXT,
        "inputs": {name: {"path": f"{RUN_REL}/{name}", "sha256": INPUT_SHA256[name]} for name in INPUT_SHA256},
        "assets": list(ASSETS), "horizons": list(HORIZONS), "candidates": list(CANDIDATES),
        "displayed": displayed,
        "shipped": shipped,
        "changes": changes,
        "selection": selection,
        "honesty": "Blind set 5 has been read, so this choice is in-sample for blind set 5; the live log is its test.",
        "generator": "membrane-app scripts/research/history-forecasts/a6_display_d3.py",
    }


def dumps(doc):
    return (json.dumps(doc, indent=1, allow_nan=False) + "\n").encode()


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--run", required=True, help="membrane-datasets history-forecasts/a6/run-015512cb")
    ap.add_argument("--out", required=True, help="output directory (display-a6.json is never overwritten)")
    a = ap.parse_args(argv)
    data = dumps(build(a.run))
    os.makedirs(a.out, exist_ok=True)
    path = os.path.join(a.out, "display-a6.json")
    if os.path.exists(path):
        raise SystemExit(f"STOP: {path} exists; not overwritten")
    with open(path, "xb") as f:
        f.write(data)
    sha = sha256_bytes(data)
    with open(path + ".sha256", "x") as f:
        f.write(f"{sha}  display-a6.json\n")
    print(f"wrote {path} ({len(data)} bytes, sha256 {sha})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
