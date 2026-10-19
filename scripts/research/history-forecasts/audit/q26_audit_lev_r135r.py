"""Q26 leveraged/pegged instrument audit 2026-10-19: R13.5r re-score (spent B14a young windows + seen dev rows only).

Cells (primary 3 d -15%, reported 1 d -15%), each with the registered gates and the same bootstrap seed as the run:
  frozen fit   x  test all 197 / test without the contaminated B14a series
  refit (check) reg2 refitted on every dev row: must reproduce the frozen theta
  refit clean  reg2 refitted on dev rows without contaminated dev series (B13a, B9, pool lists of the census)
               x  test all / test clean
L_all (secondary) is rebuilt with and without the contaminated dev series as well.

usage: q26_audit_lev_r135r.py <rows-r16.npz> <exclusions.json> <out.json>
"""
import json
import math
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import r134_library as L4  # noqa: E402
import r135r_young as RR  # noqa: E402
import r16_diag as D  # noqa: E402
import r16_diag_an as AN  # noqa: E402

DS = os.environ.get("MEMBRANE_DATASETS", "/home/user/membrane-datasets")
DEV = f"{DS}/history-forecasts/r13/r135r-dev-f4fe826d"
META = f"{DS}/history-forecasts/r13/r134-dev-cad651e9/meta-r134-dev.json"
R134ROWS = os.environ.get("R134_ROWS", "/home/user/r13work/r134/dev-cad651e9/rows-r134-dev.npz")
B14A = f"{DS}/b14-gate-prices/b14a"


def dev_bad_keys(ex):
    bad = set()
    for b in ex.get("B13a", {}):
        bad.add(f"b13a:{b}USDT")
    for b in ex.get("B9", {}):
        bad.add(f"b9:{b}USDT")
    meta = json.load(open(META))["series"]
    poolbad = set(ex.get("pool", {}))
    for m in meta:
        if m["sub"] == "pool" and m["key"].split(":")[-1].replace("USDT", "") in poolbad:
            bad.add(m["key"])
    for b in ex.get("B12-okx", {}):
        bad.add(f"b12:okx:{b}")
    for b in ex.get("B12-bybit", {}):
        bad.add(f"b12:bybit:{b}")
    return bad


def lall(rows_path, hh, bad_sid):
    """L_all and (e) exactly as r135r_young.frozen_lall_e, optionally without the contaminated dev series."""
    z = np.load(rows_path)
    R = {"cls": z[f"h{hh}_cls"], "m": z[f"h{hh}_m"], "s": z[f"h{hh}_s"], "q2": z[f"h{hh}_q2"]}
    keep = ~R["q2"]
    if bad_sid is not None:
        keep &= ~np.isin(z[f"h{hh}_sid"], bad_sid)
    La = L4.pooled_lib(R, keep, classes=list(L4.CLASSES))
    isc = (R["cls"] == 0) & keep
    e = float(np.mean(R["m"][isc] <= math.log1p(RR.K) / R["s"][isc]))
    return La, e


def score(dec, La, e_const, series, beta, hh, keep_assets):
    ser = [s for s in series if s["asset"] in keep_assets]
    R = RR.encode_gate(ser, beta, hh)
    zk = (math.log1p(RR.K) / np.exp(R["lns0"]))[:, None]
    Y = (R["depth"][:, None] <= math.log1p(RR.K)).astype(float)
    Rl = RR.RowsLite(cls=R["cls"], spike=R["spike"].astype(np.float32), vov=R["vov"].astype(np.float32),
                     vstate=R["vstate"].astype(np.float64), age=R["age"], lnLR=R["lnLR"].astype(np.float32))
    p_reg2 = dec.prob(Rl, np.arange(R["n"]), zk)[:, 0]
    p_lall = L4.wecdf_at(La, zk[:, 0])
    own, pa = RR.own_a_gate(R, zk, Y)
    sc = np.isfinite(own[:, 0]) & np.isfinite(pa[:, 0])
    y = Y[sc, 0]
    P = {"reg2": np.clip(p_reg2[sc], 0, 1), "L_all": np.clip(p_lall[sc], 0, 1), "own": own[sc, 0], "a": pa[sc, 0],
         "e": np.full(int(sc.sum()), e_const)}
    e = RR.cell_eval(P, y, R["sid"][sc], R["day"][sc], hh, RR.NB, RR.key_seed("run", hh), comps_var=False)
    e["pos"] = int(y.sum())
    lg = e["legs"]
    out = {"rows": e["rows"], "series": e["series"], "pos": e["pos"], "pos_blocks": e["pos_blocks"],
           "R_reg2": e["R"]["reg2"], "R_L_all": e["R"]["L_all"],
           "legs": {k: {kk: v[kk] for kk in ("bss", "mean_d", "z_two", "p_cell_leg") if kk in v} | (
               {"leave_top_mean_d": v["leave_top_frac"]["mean_d"]} if "leave_top_frac" in v else {})
               for k, v in lg.items()}}
    if hh == RR.H_PRIMARY:
        p_cell = max(lg[f"reg2_vs_{c}"]["p_cell_leg"] for c in RR.COMPS)
        g = {"mean_d_lt0_all3": all(lg[f"reg2_vs_{c}"]["mean_d"] < 0 for c in RR.COMPS),
             "p_cell_le_0.05": bool(p_cell <= 0.05), "R_band": bool(RR.R_LO <= e["R"]["reg2"] <= RR.R_HI),
             "blocks30": e["pos_blocks"] >= RR.MIN_POS_BLOCKS,
             "concentration": all(lg[f"reg2_vs_{c}"]["leave_top_frac"]["mean_d"] < 0 for c in RR.COMPS)}
        out.update(p_cell=p_cell, gates=g, PASS=bool(all(g.values())))
    return out


def main(rows16, exfile, outp):
    ex = json.load(open(exfile))
    fz = json.load(open(f"{DS}/history-forecasts/r13/r135r-run-1fa3cff3/results-r135r.json"))
    fit = json.load(open(f"{DEV}/fit-r135r.json"))
    beta = {int(k): np.array(v) for k, v in json.load(open(META))["beta"].items()}
    series, man = RR.load_set(B14A, "manifest-b14a.json", "B14a")
    allA = {s["asset"] for s in series}
    badA = set(ex.get("B14a", {}))
    cleanA = allA - badA
    meta = json.load(open(META))["series"]
    bad_keys = dev_bad_keys(ex)
    bad_sid = np.array([i for i, m in enumerate(meta) if m["key"] in bad_keys])
    res = {"b14a_excluded": sorted(badA & allA), "dev_excluded_keys": sorted(bad_keys),
           "dev_excluded_series": int(len(bad_sid)), "cells": {}}
    frozen_e = {"3": 0.12842, "1": 0.03504}
    for hh in (RR.H_PRIMARY, RR.H_REPORTED):
        Rd = D.Rows(rows16, META, hh)
        badrow = np.isin(Rd.sid, bad_sid)
        res[f"dev_rows_h{hh}"] = {"all": int(Rd.n), "contaminated": int(badrow.sum()),
                                  "contaminated_pos_15": int(((Rd.depth <= math.log1p(RR.K)) & badrow).sum()),
                                  "pos_15": int((Rd.depth <= math.log1p(RR.K)).sum())}
        decs = {"frozen": RR.decoder_from_json(fit["decoders"][str(hh)])}
        vc = np.quantile(Rd.vstate, [0.2, 0.4, 0.6, 0.8])
        d_all = AN.Decoder(Rd, Rd.m0, np.ones(Rd.n, bool), "reg2", vc)
        res[f"refit_check_h{hh}"] = {"max_abs_theta_diff_vs_frozen": float(np.max(np.abs(
            d_all.theta - np.array(fit["decoders"][str(hh)]["theta"]))))}
        tr = ~badrow
        vc2 = np.quantile(Rd.vstate[tr], [0.2, 0.4, 0.6, 0.8])
        decs["refit_clean"] = AN.Decoder(Rd, Rd.m0, tr, "reg2", vc2)
        res[f"theta_h{hh}"] = {"frozen": fit["decoders"][str(hh)]["theta"], "clean": decs["refit_clean"].theta.tolist()}
        del Rd, d_all
        La_all, e_all = lall(R134ROWS, hh, None)
        La_cl, e_cl = lall(R134ROWS, hh, bad_sid)
        assert abs(e_all - frozen_e[str(hh)]) < 5e-6, (e_all, frozen_e[str(hh)])
        res[f"e_h{hh}"] = {"all": e_all, "clean": e_cl}
        for dn, dec in decs.items():
            for tn, keepA in (("test_all", allA), ("test_clean", cleanA)):
                La, ee = (La_all, e_all) if dn == "frozen" else (La_cl, e_cl)
                key = f"h{hh} {dn} {tn}"
                res["cells"][key] = score(dec, La, ee, series, beta, hh, keepA)
                c = res["cells"][key]
                print(key, json.dumps({k: c[k] for k in ("rows", "series", "pos", "pos_blocks", "R_reg2") },
                                      default=float),
                      {k: (round(v["bss"], 4), round(v["z_two"], 2), round(v["p_cell_leg"], 4)) for k, v in
                       c["legs"].items()}, c.get("PASS"), flush=True)
    res["published_primary"] = fz["cells"][f"h3/{RR.K}"]["legs"]["reg2_vs_own"]["bss"]
    json.dump(res, open(outp, "w"), indent=1, default=float)
    print("wrote", outp)


if __name__ == "__main__":
    main(*sys.argv[1:4])
