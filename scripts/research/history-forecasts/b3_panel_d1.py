#!/usr/bin/env python3
"""Q26 B3 deviation D1, display only: the panel composite fix over model cells only, and tie-route HIGH shown as
MEDIUM ("tie with v2").

Implements membrane-board `design/DEPOSITOR_BEHAVIOR_PREREG_B3.md` deviation D1 (commit 5df2722) as a post-process
of the published B3 run (membrane-datasets `history-forecasts/b3/run-6b2ff4d7/`, c369ad4). Nothing is refit and no
model is evaluated: every number comes from the run's published files.

  python3 b3_panel_d1.py --run RUN_DIR [--out OUT_DIR]      (OUT_DIR defaults to RUN_DIR; never overwrites)

Inputs (sha256 checked against the run's manifest.json): results.json (panel_preholdout: per unit and cell the
shipped rung, the capped flag, the shown number p, and rung_values = the per-rung masked-fixed model values;
asof_params["<cell>:v2"].seg_pop = the population rate per segment; cells = the B3.4 flags), labels.csv
(label_final per cell and segment) and panel.csv (the registered panel).

Rule 1, composite fix over model cells only. As run (b3_segments.panel_compute, B-gradient D3), each unit's x grid
comp = rung_values[shipped] where a rung ships for (cell, segment), else seg_pop[segment], got one 2-D fix
(b3_segments.composite_fix = G.monotone_fix_masked, capped cells left out). Under D1 the same fix runs twice: once
over the model cells (population and capped cells left out), once over the population cells (model and capped
cells left out). One source never caps or lifts the other. G.monotone_fix_masked takes a per-x cap; D1 needs a
per-cell mask, so monotone_fix_cells applies the same rule with the mask per cell: q[h][x] = min(P[h][x'], kept
x' <= x in row h); P'[h][x] = max(q[h'][x], kept h' <= h in column x). With a mask that is the same in every row
it equals G.monotone_fix_masked (tested). The old rule is rebuilt first from the same inputs; it must equal
results.json p to 1e-9 and panel.csv number as printed (G.fmt) in every row, else STOP.

Rule 2, tie-route HIGH shows MEDIUM. A final HIGH at one of the 5 registered tie-route (cell, segment) shows
MEDIUM, reason "tie with v2". Cross-checks (else STOP): the 5 equal the final HIGH cells whose shipped rung is v3
or v3s with a BSS-vs-v2 CI not above 0 (results.json cells flags), and displayed HIGH is exactly the 3 registered
cells. The registered label stays in its own column.

Outputs (into OUT_DIR; panel.csv, labels.csv and manifest.json are never written):
  panel-d1.csv    panel.csv columns; number and label are the displayed D1 values, and history follows the
                  displayed label as in panel.csv (blank for a displayed HIGH x cell); plus label_registered,
                  label_display, number_registered (the panel.csv number)
  labels-d1.csv   labels.csv plus label_display, display_reason
  d1-diff.json    the old-rule reproduction, D1 changes vs panel.csv (model / population) with the list, label
                  changes, the review examples
  manifest-d1.json  sha256 of the three outputs and of the inputs

Addresses are public on-chain data. This code attaches no identity, label or name to any address.
"""
import argparse
import csv
import json
import os
import subprocess
import sys
from datetime import datetime, timezone

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import b3_segments as S  # noqa: E402
import bg_gradient as G  # noqa: E402

DEVIATION = {"repo": "membrane-board", "path": "design/DEPOSITOR_BEHAVIOR_PREREG_B3.md", "deviation": "D1",
             "commit": "5df2722"}
RUN = {"repo": "membrane-datasets", "path": "history-forecasts/b3/run-6b2ff4d7/", "commit": "c369ad4",
       "code": "6b2ff4d7"}
TIE_ROUTE = (("x10_24h", "w2"), ("x75_24h", "w1"), ("x90_24h", "w1"), ("x75_48h", "w1"), ("x90_48h", "w1"))
HIGH_SHOWN = (("x10_24h", "w1"), ("x25_24h", "w1"), ("x10_48h", "w2"))
TIE_REASON = "tie with v2"
REVIEW_EXAMPLES = (("USDC", 4, "x10_7d"), ("USDC", 1, "x75_7d"), ("USDC", 1, "x90_7d"))
INPUTS = ("results.json", "labels.csv", "panel.csv")
OUTPUTS = ("panel-d1.csv", "labels-d1.csv", "d1-diff.json", "manifest-d1.json")
TOL = 1e-9

sha256_file = S.sha256_file
write_json = S.write_json


def code_meta():
    here = os.path.dirname(os.path.abspath(__file__))
    me = os.path.basename(__file__)

    def git(*a):
        try:
            return subprocess.run(["git", "-C", here, *a], capture_output=True, text=True,
                                  timeout=30).stdout.strip() or None
        except Exception:
            return None
    return {"git_head": git("rev-parse", "HEAD"), "last_commit_b3_panel_d1": git("log", "-1", "--format=%H", "--", me),
            "b3_panel_d1_sha256": sha256_file(os.path.abspath(__file__)),
            "b3_panel_d1_dirty": bool(git("status", "--porcelain", "--", me)),
            "b3_segments_sha256": sha256_file(os.path.join(here, "b3_segments.py")),
            "bg_gradient_sha256": sha256_file(os.path.join(here, "bg_gradient.py")),
            "python": sys.version.split()[0], "numpy": np.__version__}


# ---------------------------------------------------------------------------------------------
# Rules (unit-tested on synthetic data)
# ---------------------------------------------------------------------------------------------
def monotone_fix_cells(P, mask):
    """G.monotone_fix_masked with a per-cell mask. P (n, NH, NX) h short->long, x small->large; mask (n, NH, NX)
    True = left out. q[h][x] = min(P[h][x'], kept x' <= x); P'[h][x] = max(q[h'][x], kept h' <= h). Masked -> NaN."""
    P = np.asarray(P, float)
    mask = np.asarray(mask, bool)
    q = np.minimum.accumulate(np.where(mask, np.inf, P), axis=2)
    out = np.maximum.accumulate(np.where(mask, -np.inf, q), axis=1)
    return np.where(mask, np.nan, out)


def d1_fix(comp_x, model, capx):
    """D1 composite fix of one unit's x grid (NH, NX): the 2-D fix over model cells (population and capped cells
    left out) and, separately, over population cells (model and capped cells left out). Capped -> NaN."""
    comp_x = np.asarray(comp_x, float)
    model = np.asarray(model, bool)
    cap = np.broadcast_to(np.asarray(capx, bool)[None, :], comp_x.shape)
    fm = monotone_fix_cells(comp_x[None], (~model | cap)[None])[0]
    fp = monotone_fix_cells(comp_x[None], (model | cap)[None])[0]
    return np.where(cap, np.nan, np.where(model, fm, fp))


def unit_grids(u, asof_params):
    """One panel unit of results.json panel_preholdout -> (comp, model, capx, shown): the pre-fix composite x grid
    (NH, NX) as panel_compute built it (rung_values[shipped] or seg_pop of the unit's segment), where a rung ships,
    the capped flag per x, and the number shown as run (p; NaN where capped)."""
    seg = S.SEG_IDS.index(u["segment"])
    comp = np.full((G.NH, G.NX), np.nan)
    shown = np.full((G.NH, G.NX), np.nan)
    model = np.zeros((G.NH, G.NX), dtype=bool)
    cap = np.zeros((G.NH, G.NX), dtype=bool)
    for c in G.CELLS:
        if c["kind"] != "x":
            continue
        cv = u["cells"][c["id"]]
        hi, xi = c["hi"], c["xi"]
        cap[hi, xi] = bool(cv["capped"])
        if cv["rung"]:
            model[hi, xi] = True
            v = cv["rung_values"][cv["rung"]]
            if v is None and not cv["capped"]:
                raise SystemExit(f"STOP: {u['segment']} {c['id']}: shipped {cv['rung']} without a rung value")
            comp[hi, xi] = np.nan if v is None else v
        else:
            comp[hi, xi] = asof_params[f"{c['id']}:v2"]["seg_pop"][seg]
        if cv["p"] is not None:
            shown[hi, xi] = cv["p"]
    if (cap != cap[0]).any():
        raise SystemExit(f"STOP: unit {u['unit']}: the capped flag differs across horizons")
    return comp, model, cap[0], shown


def old_fix(comp_x, capx):
    """The rule as run: one 2-D fix over the whole composite grid (b3_segments.composite_fix)."""
    return S.composite_fix(comp_x, capx)


def display_label(cell, segment, label_final):
    """D1 rule 2 -> (label_display, display_reason)."""
    if label_final == "HIGH" and (cell, segment) in TIE_ROUTE:
        return "MEDIUM", TIE_REASON
    return label_final, ""


def tie_route_from_results(cells, label_final):
    """Final HIGH (cell, segment) whose shipped rung is v3/v3s and whose BSS vs v2 CI is not above 0."""
    out = []
    for (cid, s), lab in label_final.items():
        sh = cells[cid][s]["shipped"]
        if lab == "HIGH" and sh in ("v3", "v3s") and not cells[cid][s]["flags"][sh]["v2"]:
            out.append((cid, s))
    return sorted(out)


def monotone_violations(vals, src_mask):
    """Pairs of cells of one source breaking the 2-D rule: in a row, larger x above smaller x; in a column,
    shorter h above longer h (NaN cells skipped)."""
    n = 0
    for hi in range(G.NH):
        xs = [xi for xi in range(G.NX) if src_mask[hi, xi] and np.isfinite(vals[hi, xi])]
        n += sum(1 for a in range(len(xs)) for b in range(a + 1, len(xs)) if vals[hi, xs[b]] > vals[hi, xs[a]])
    for xi in range(G.NX):
        hs = [hi for hi in range(G.NH) if src_mask[hi, xi] and np.isfinite(vals[hi, xi])]
        n += sum(1 for a in range(len(hs)) for b in range(a + 1, len(hs)) if vals[hs[a], xi] > vals[hs[b], xi])
    return n


# ---------------------------------------------------------------------------------------------
# Post-process
# ---------------------------------------------------------------------------------------------
def read_csv(path):
    with open(path, newline="") as f:
        r = csv.reader(f)
        header = next(r)
        return header, [dict(zip(header, row)) for row in r]


def verify_inputs(run_dir):
    man = json.load(open(os.path.join(run_dir, "manifest.json")))
    out = {}
    for fn in INPUTS:
        got = sha256_file(os.path.join(run_dir, fn))
        if man["files"][fn]["sha256"] != got:
            raise SystemExit(f"STOP: {fn} sha256 {got} != manifest.json {man['files'][fn]['sha256']}")
        out[fn] = got
    out["manifest.json"] = sha256_file(os.path.join(run_dir, "manifest.json"))
    return out


def count_src(entries):
    return {"total": len(entries), "model": sum(e["source"] == "model" for e in entries),
            "population": sum(e["source"] == "population" for e in entries)}


def run(run_dir, out_dir, log=print):
    for fn in OUTPUTS:
        if os.path.exists(os.path.join(out_dir, fn)):
            raise SystemExit(f"STOP: {os.path.join(out_dir, fn)} exists; refusing to overwrite.")
    shas = verify_inputs(run_dir)
    res = json.load(open(os.path.join(run_dir, "results.json")))
    lab_header, lab_rows = read_csv(os.path.join(run_dir, "labels.csv"))
    pan_header, pan_rows = read_csv(os.path.join(run_dir, "panel.csv"))
    label_final = {(r["cell"], r["segment"]): r["label_final"] for r in lab_rows}
    # ---- rule 2 cross-checks
    derived = tie_route_from_results(res["cells"], label_final)
    if derived != sorted(TIE_ROUTE):
        raise SystemExit(f"STOP: tie-route cells from results.json {derived} != registered {sorted(TIE_ROUTE)}")
    disp = {k: display_label(k[0], k[1], v) for k, v in label_final.items()}
    shown_high = sorted(k for k, v in disp.items() if v[0] == "HIGH")
    if shown_high != sorted(HIGH_SHOWN):
        raise SystemExit(f"STOP: displayed HIGH {shown_high} != registered {sorted(HIGH_SHOWN)}")
    # ---- rule 1 per unit: pre-fix, old rule, D1
    calc, units = {}, {}
    old_max_diff, n_x, n_uncapped, viol = 0.0, 0, 0, {"model": 0, "population": 0}
    prefix_old, prefix_d1 = [], []
    for reserve, lst in res["panel_preholdout"].items():
        for u in lst:
            comp, model, capx, shown = unit_grids(u, res["asof_params"])
            old = old_fix(comp, capx)
            new = d1_fix(comp, model, capx)
            if not np.array_equal(np.isnan(old), np.isnan(shown)):
                raise SystemExit(f"STOP: {reserve} #{u['rank']}: capped cells differ from results.json")
            d = np.abs(np.where(np.isnan(old), 0.0, old - shown))
            old_max_diff = max(old_max_diff, float(d.max()))
            if (d > TOL).any():
                raise SystemExit(f"STOP: {reserve} #{u['rank']}: old-rule rebuild differs from results.json p by "
                                 f"{float(d.max()):.3g} > {TOL}")
            viol["model"] += monotone_violations(new, model)
            viol["population"] += monotone_violations(new, ~model)
            units[(reserve, u["rank"])] = u
            for c in G.CELLS:
                if c["kind"] != "x":
                    continue
                hi, xi = c["hi"], c["xi"]
                n_x += 1
                e = {"reserve": reserve, "rank": u["rank"], "address_short": u["address_short"],
                     "segment": u["segment"], "cell": c["id"], "source": "model" if model[hi, xi] else "population",
                     "rung": u["cells"][c["id"]]["rung"], "capped": bool(capx[xi]),
                     "prefix": float(comp[hi, xi]), "old": float(old[hi, xi]), "d1": float(new[hi, xi])}
                calc[(reserve, u["rank"], c["id"])] = e
                if capx[xi]:
                    continue
                n_uncapped += 1
                if e["old"] != e["prefix"]:
                    prefix_old.append(e)
                if e["d1"] != e["prefix"]:
                    prefix_d1.append(e)
    # ---- panel rows: reproduction against panel.csv, then the D1 rows
    if sorted((r["reserve"], int(r["rank"]), r["cell"]) for r in pan_rows) != \
            sorted((r, k, c["id"]) for r, k in units for c in G.CELLS):
        raise SystemExit("STOP: panel.csv rows are not one per panel unit and cell")
    out_rows, changed, label_changed = [], [], []
    for row in pan_rows:
        rank = int(row["rank"])
        u = units[(row["reserve"], rank)]
        cv = u["cells"][row["cell"]]
        c = G.CELLS[[cc["id"] for cc in G.CELLS].index(row["cell"])]
        reg = label_final[(row["cell"], row["segment"])]
        if row["label"] != reg or row["segment"] != u["segment"] or row["address"] != u["address"]:
            raise SystemExit(f"STOP: panel.csv row {row['reserve']} #{rank} {row['cell']} does not match the inputs")
        hist_reg = cv["history"] if (reg != "HIGH" or c["kind"] == "all") else None
        if row["history"] != (hist_reg or ""):
            raise SystemExit(f"STOP: panel.csv history of {row['reserve']} #{rank} {row['cell']} not rebuilt")
        lab_d, _ = disp[(row["cell"], row["segment"])]
        if c["kind"] == "x":
            e = calc[(row["reserve"], rank, row["cell"])]
            num_old = "capped" if e["capped"] else G.fmt(e["old"])
            num_new = "capped" if e["capped"] else G.fmt(e["d1"])
            if not e["capped"]:
                e["number_registered"], e["number_d1"] = row["number"], num_new
        else:
            num_old = num_new = ""
        if num_old != row["number"]:
            raise SystemExit(f"STOP: {row['reserve']} #{rank} {row['cell']}: old-rule number {num_old} != panel.csv "
                             f"{row['number']}")
        if c["kind"] == "x" and not e["capped"] and e["d1"] != e["old"]:
            changed.append(e)
        if lab_d != reg:
            label_changed.append({"reserve": row["reserve"], "rank": rank, "segment": row["segment"],
                                  "cell": row["cell"], "label_registered": reg, "label_display": lab_d,
                                  "reason": TIE_REASON})
        hist = cv["history"] if (lab_d != "HIGH" or c["kind"] == "all") else None
        nr = dict(row, number=num_new, label=lab_d, history=hist or "")
        out_rows.append([nr[k] for k in pan_header] + [reg, lab_d, row["number"]])
    log(f"old rule rebuilt: {len(pan_rows)} rows, {n_x} x entries ({n_uncapped} uncapped), max |diff| vs results.json "
        f"p {old_max_diff:.3g}, printed numbers all equal panel.csv")
    log(f"pre-fix vs old-fixed: {count_src(prefix_old)}; pre-fix vs D1: {count_src(prefix_d1)}")
    log(f"D1 vs panel.csv: {count_src(changed)}; panel label changes {len(label_changed)}")
    # ---- labels-d1 rows
    lab_out = []
    for r in lab_rows:
        ld, why = disp[(r["cell"], r["segment"])]
        lab_out.append([r[k] for k in lab_header] + [ld, why])
    # ---- write
    os.makedirs(out_dir, exist_ok=True)
    G.write_csv(os.path.join(out_dir, "panel-d1.csv"), pan_header + ["label_registered", "label_display",
                                                                      "number_registered"], out_rows)
    G.write_csv(os.path.join(out_dir, "labels-d1.csv"), lab_header + ["label_display", "display_reason"], lab_out)

    def brief(e):
        return {k: e[k] for k in ("reserve", "rank", "address_short", "segment", "cell", "source", "rung", "prefix",
                                  "old", "d1", "number_registered", "number_d1")}
    diff = {
        "deviation": DEVIATION, "run": RUN, "inputs_sha256": shas,
        "rule": "panel composite fix over model cells only (population and capped cells left out); population "
                "cells fixed among themselves; tie-route HIGH shows MEDIUM ('tie with v2')",
        "reproduction_old_rule": {
            "panel_rows": len(pan_rows), "x_entries": n_x, "uncapped_x_entries": n_uncapped,
            "max_abs_diff_vs_results_p": old_max_diff, "tolerance": TOL, "printed_numbers_equal_panel_csv": True,
            "prefix_vs_old_fixed_changed": count_src(prefix_old)},
        "d1": {"prefix_vs_d1_changed": count_src(prefix_d1), "changed_vs_panel_csv": count_src(changed),
               "changed_vs_panel_csv_printed": sum(e["number_d1"] != e["number_registered"] for e in changed),
               "monotone_violations_within_source": viol,
               "entries": [brief(e) for e in changed]},
        "labels": {"tie_route": [list(k) for k in TIE_ROUTE], "displayed_high": [list(k) for k in HIGH_SHOWN],
                   "labels_rows_changed": sum(disp[k][0] != v for k, v in label_final.items()),
                   "panel_rows_label_changed": label_changed},
        "review_examples": [brief(calc[k]) for k in REVIEW_EXAMPLES],
    }
    write_json(os.path.join(out_dir, "d1-diff.json"), diff, refuse_overwrite=True)
    man = {"files": {fn: {"bytes": os.path.getsize(os.path.join(out_dir, fn)),
                          "sha256": sha256_file(os.path.join(out_dir, fn))} for fn in OUTPUTS[:3]},
           "inputs_sha256": shas, "deviation": DEVIATION, "run": RUN, "code": code_meta(),
           "note": "D1 display outputs beside the registered run; manifest.json, panel.csv and labels.csv unchanged",
           "written_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    write_json(os.path.join(out_dir, "manifest-d1.json"), man, refuse_overwrite=True)
    for fn, v in man["files"].items():
        log(f"  {fn} {v['sha256']}")
    return diff


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--run", required=True, help="the B3 run directory (results.json, labels.csv, panel.csv)")
    ap.add_argument("--out", help="output directory (default: --run)")
    a = ap.parse_args(argv)
    run(a.run, a.out or a.run)


if __name__ == "__main__":
    main()
