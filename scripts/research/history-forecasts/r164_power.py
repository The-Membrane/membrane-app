#!/usr/bin/env python3
"""Q26 R16.4 Part C: power for candidate blind cells (D-R13.5c rule: the registered test's own two-way bootstrap
statistic on development, scaled to the target counts).

Part A cell (Brier skill vs (fH)): z_new = z_dev * sqrt(B_new / B_dev) (time term only, the binding term at 1-30 d;
the series term is set to 0, so this is a ceiling for any set that shares the development calendar).
Leg power Phi(z_new - z_crit); concentration Phi(z_leave_top * z_new / z_dev); joint = product.

Part B cell (coverage equivalence): coverage c_dev with block-bootstrap SE s_dev (90% interval width / 3.29);
s_new = s_dev * sqrt(B_dev / B_new). TOST power for |c - nominal| <= tol at alpha 0.05 per leg; width leg
P(median width <= W) taken as 1 if the development median and 90th percentile of block medians are below W, else
its block-bootstrap share. Joint = TOST power x width power x (CGM cross-check assumed equal).
"""
from __future__ import annotations

import argparse
import json
import math


def phi(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def tost_power(c, s, nominal, tol, z=1.6449):
    if s <= 0:
        return 1.0 if abs(c - nominal) < tol else 0.0
    d = c - nominal
    return max(0.0, phi((tol - d) / s - z) + phi((tol + d) / s - z) - 1)


def part_a(score_json, cells, b_new_ratio=1.0, z_crit=1.6449):
    sc = json.load(open(score_json))
    out = []
    for T, comp, band in cells:
        c = sc["per_T"][T]["comparisons"][comp]
        z = -(c["z"] or 0)
        zb = -(c["bands"][band]["z"] or 0) if band else z
        zn = zb * math.sqrt(b_new_ratio)
        lt = -c["mean_d_leave_top"] / (abs(c["mean_d"]) / max(abs(z), 1e-9)) if c["mean_d"] else 0
        p_leg = phi(zn - z_crit)
        p_conc = phi(lt * math.sqrt(b_new_ratio) - 0.0) if band is None else 1.0
        out.append({"T": T, "comparison": comp, "band": band, "z_dev": zb, "z_proj": zn, "leg": p_leg,
                    "concentration": p_conc, "joint": p_leg * p_conc})
    return out


def part_b(ranges_json, cells, nominal, tol, width_pts, b_new_ratio=1.0):
    rg = json.load(open(ranges_json))
    idx = {(c["T"], c["tier"], c["level"]): c for c in rg["cells"]}
    out = []
    for T, tier, level, constr in cells:
        c = idx[(T, tier, level)]["constructions"][constr]
        cov = c["coverage_groups"]
        lo, hi = c["coverage_ci90"]
        s = (hi - lo) / 3.29 / math.sqrt(b_new_ratio)
        pw = tost_power(cov, s, nominal, tol)
        wl = 1.0 if c["width_median_pts"] <= width_pts else 0.0
        out.append({"T": T, "tier": tier, "level": level, "construction": constr, "coverage_dev": cov,
                    "se_proj": s, "tost_power": pw, "width_median_pts": c["width_median_pts"], "width_leg": wl,
                    "joint": pw * wl})
    return out


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--score")
    ap.add_argument("--ranges")
    ap.add_argument("--a-cells", default="")
    ap.add_argument("--b-cells", default="")
    ap.add_argument("--b-ratio", type=float, default=1.0)
    ap.add_argument("--nominal", type=float, default=0.90)
    ap.add_argument("--tol", type=float, default=0.05)
    ap.add_argument("--width", type=float, default=10.0)
    ap.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    res = {"b_new_over_b_dev": a.b_ratio, "nominal": a.nominal, "tol": a.tol, "width_pts": a.width}
    if a.score and a.a_cells:
        cells = [tuple(x.split("|")) for x in a.a_cells.split(",")]
        cells = [(t, c, (b if b != "-" else None)) for t, c, b in cells]
        res["part_a"] = part_a(a.score, cells, a.b_ratio)
    if a.ranges and a.b_cells:
        cells = [tuple(x.split("|")) for x in a.b_cells.split(",")]
        cells = [(t, tier, int(l), c) for t, tier, l, c in cells]
        res["part_b"] = part_b(a.ranges, cells, a.nominal, a.tol, a.width, a.b_ratio)
    json.dump(res, open(a.out, "w"), indent=1)
    print(json.dumps(res, indent=1))


if __name__ == "__main__":
    main()
