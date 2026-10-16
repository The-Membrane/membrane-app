#!/usr/bin/env python3
"""Q26 B4 deviation D2, display only: labels-b4-d2.csv = labels-dev.csv + label_display + display_reason.

Implements membrane-board `design/DEPOSITOR_BEHAVIOR_PREREG_B4.md` deviation D2 (commit 4092369) as a post-process of
the frozen B4 run and its single B-5 score (membrane-datasets `history-forecasts/b4/run-2035639d/`, c9d480a).
Nothing is refit and no model is evaluated: every number comes from the published files.

  python3 b4_labels_d2.py --run RUN_DIR --out OUT_DIR        (never overwrites)

Inputs (sha256 checked): labels-dev.csv (e001e7e7...), shipped-b4.json (cc8680c4...), results-blind5.json (39dbbbd3...).

Rules, in this order, per (cell, segment), starting from the registered final label (labels-dev.csv label_final, which
must equal results-blind5.json label_b5 and shipped-b4.json label_final):
  1. failed B-5 transfer: label MEDIUM or HIGH, B-5 pool n_ep >= 10 and the shipped rung's B-5 pool R outside
     [0.67, 1.5] -> LOW, reason "failed B-5 transfer";
  2. contracts >= $50M (c3) with label MEDIUM -> MEDIUM, reason "no blind test possible";
  3. label HIGH -> HIGH, reason "calibration confirmed on unseen reserves; skill over population not shown";
  4. otherwise the label is unchanged, no reason.
Cross-checks (else STOP): rule 1 hits exactly the 5 registered cells (x50_6h w2, x50_7d w3, x75_7d w3, x90_7d w3,
all_7d w3); rule 3 exactly the 2 registered HIGH cells (x10_24h w1, x25_24h w1).

Output: OUT_DIR/labels-b4-d2.csv (labels-dev.csv columns and row order, then label_display, display_reason).
"""
import argparse
import csv
import hashlib
import io
import json
import math
import os
import sys

INPUT_SHA256 = {
    "labels-dev.csv": "e001e7e7d523008b4db691934475f301cfa4ed6ece273a144bee54955e7206db",
    "shipped-b4.json": "cc8680c42d3f00ef7f08d84850406153fa082772daf22a3b1d90113aae1bbadf",
    "results-blind5.json": "39dbbbd3a878966781fdf572fd61b787c71403bc25d41affbba927577a95f8c3",
}
DEVIATION = {"repo": "triccs/membrane-board", "path": "design/DEPOSITOR_BEHAVIOR_PREREG_B4.md", "deviation": "D2",
             "commit": "4092369"}
R_BAND = (0.67, 1.5)
MIN_NEP = 10
FAILED = (("x50_6h", "w2"), ("x50_7d", "w3"), ("x75_7d", "w3"), ("x90_7d", "w3"), ("all_7d", "w3"))
HIGH = (("x10_24h", "w1"), ("x25_24h", "w1"))
REASON_FAILED = "failed B-5 transfer"
REASON_C3 = "no blind test possible"
REASON_HIGH = "calibration confirmed on unseen reserves; skill over population not shown"


def sha256_file(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def within(R, band):
    return R is not None and isinstance(R, (int, float)) and math.isfinite(R) and band[0] <= R <= band[1]


def display(label, seg, pool_nep, pool_R):
    """The D2 rule for one (cell, segment) -> (label_display, display_reason)."""
    if label in ("MEDIUM", "HIGH") and pool_nep >= MIN_NEP and not within(pool_R, R_BAND):
        return "LOW", REASON_FAILED
    if seg == "c3" and label == "MEDIUM":
        return "MEDIUM", REASON_C3
    if label == "HIGH":
        return "HIGH", REASON_HIGH
    return label, ""


def build(run_dir):
    shas = {}
    for fn, want in INPUT_SHA256.items():
        got = sha256_file(os.path.join(run_dir, fn))
        if got != want:
            raise SystemExit(f"STOP: {fn} sha256 {got} != {want}")
        shas[fn] = got
    with open(os.path.join(run_dir, "labels-dev.csv"), newline="") as f:
        rd = csv.reader(f)
        header = next(rd)
        rows = [dict(zip(header, r)) for r in rd]
    shipped = json.load(open(os.path.join(run_dir, "shipped-b4.json")))["cells"]
    b5 = json.load(open(os.path.join(run_dir, "results-blind5.json")))["cells"]
    out, failed, high, c3 = [], [], [], []
    for r in rows:
        cid, seg = r["cell"], r["segment"]
        c5, cs = b5[cid][seg], shipped[cid][seg]
        if (r["shipped"] or None) != cs["shipped"] or (c5["shipped"] or None) != cs["shipped"]:
            raise SystemExit(f"STOP: shipped rung differs between the inputs at {cid} {seg}")
        if not (r["label_final"] == cs["label_final"] == c5["label_frozen"] == c5["label_b5"]):
            raise SystemExit(f"STOP: final labels differ between the inputs at {cid} {seg}")
        lab, why = display(r["label_final"], seg, int(c5["n_ep"]), c5["R"]["shipped"])
        if why == REASON_FAILED:
            failed.append((cid, seg))
        elif why == REASON_HIGH:
            high.append((cid, seg))
        elif why == REASON_C3:
            c3.append((cid, seg))
        out.append([r[k] for k in header] + [lab, why])
    if sorted(failed) != sorted(FAILED):
        raise SystemExit(f"STOP: failed-transfer cells {sorted(failed)} != registered {sorted(FAILED)}")
    if sorted(high) != sorted(HIGH):
        raise SystemExit(f"STOP: HIGH cells {sorted(high)} != registered {sorted(HIGH)}")
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(header + ["label_display", "display_reason"])
    w.writerows(out)
    return buf.getvalue().encode(), {"inputs_sha256": shas, "failed": failed, "high": high, "c3_no_blind": c3}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--run", required=True, help="history-forecasts/b4/run-2035639d directory")
    ap.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    data, info = build(a.run)
    os.makedirs(a.out, exist_ok=True)
    p = os.path.join(a.out, "labels-b4-d2.csv")
    with open(p, "xb") as f:
        f.write(data)
    print(f"labels-b4-d2.csv sha256 {hashlib.sha256(data).hexdigest()} ({len(data)} bytes); failed B-5 transfer -> LOW "
          f"{info['failed']}; c3 no blind test {info['c3_no_blind']}; HIGH {info['high']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
