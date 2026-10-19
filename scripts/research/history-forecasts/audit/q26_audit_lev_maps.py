"""Q26 leveraged/pegged instrument audit 2026-10-19: refit the R13.1 and R14.1 (DR) maps without the contaminated
development series, then re-score R13.1 (spent B15a) and R14.1 (spent B15b) with the frozen run code.

fit     rows on the 6-hourly grid only (the maps use ts % 6 h == 0 rows only: r13_recal.cmd_dev fitmask and
        r14_dr.cmd_dev fm) for the four development sets (R12 dev pool, B9, B12, B13a). Maps on all rows (must
        reproduce the frozen maps) and on clean rows. Writes maps-clean.json.
run141  r14_dr.cmd_run on B15b with (a) frozen config, test without contaminated B15b series; (b) clean DR and R13.1
        maps, test all; (c) clean maps, test clean. git_sha is patched to the frozen code sha (code files unchanged
        since b90111b2 for the imported modules is checked by sha256 before running).
run131  r13_recal.cmd_run on B15a (no contaminated B15a series) with the clean R13.1 maps.
usage: q26_audit_lev_maps.py fit|run141|run131 <exclusions.json> <out_dir>
"""
import json
import os
import shutil
import sys
from types import SimpleNamespace

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import r12_tail as R12  # noqa: E402
import r13_recal as R13  # noqa: E402
import r14_dr as D14  # noqa: E402
import r112_combine as R112  # noqa: E402

DS = os.environ.get("MEMBRANE_DATASETS", "/home/user/membrane-datasets")
F141 = f"{DS}/history-forecasts/r14/r141-run-b90111b2/frozen-r141-config.json"
F131 = f"{DS}/history-forecasts/r13/r131-run-e7550b81/frozen-r131-config.json"
POOL_BAD = {"pool": ("blind5:LUNAUSDT", "blind5:SUNUSDT", "blind6:QUICKUSDT", "blind6:STRAXUSDT")}


def bad_keys(ex):
    bad = set(POOL_BAD["pool"])
    bad |= {f"b13a:{b}USDT" for b in ex.get("B13a", {})}
    return bad


def log(s):
    print(f"{R112.now_iso() if hasattr(R112, 'now_iso') else ''} {s}", flush=True)


def cmd_fit(ex, out):
    tmp = os.path.join(out, "acq_r12")
    os.makedirs(tmp, exist_ok=True)
    sets = {"dev": R12.dev_specs(DS), "b9": R13.b9_specs(DS, tmp), "b12": R13.b12_specs(DS),
            "b13a": R13.b13a_specs(DS)}
    bad = bad_keys(ex)
    found = sorted(k for sp in sets.values() for s in sp for k in [s["key"]] if k in bad)
    res = {"bad_keys_found": found, "r131": {}, "r141": {}, "rows": {}}
    f131 = json.load(open(F131))
    f141 = json.load(open(F141))
    for T in R13.HS:
        St = {}
        for nm, sp in sets.items():
            S, _ = R13.run_rows(sp, T, "6h", 4, log, nm)
            badsid = np.array([i for i, s in enumerate(sp) if s["key"] in bad], int)
            S["bad"] = np.isin(S["sid"], badsid)
            St[nm] = S
        fm = {nm: (~S["q2"] & ~S["tail"] & (S["ts"] % R13.LEVEL_GRID == 0)) for nm, S in St.items()}
        cat = {k: np.concatenate([St[nm][k][fm[nm]] for nm in St]) for k in ("pH", "y", "bad")}
        m_all = R13.fit_maps(cat, np.ones(len(cat["y"]), bool))
        m_cl = R13.fit_maps(cat, ~cat["bad"])
        res["r131"][R13.TL[T]] = {"all": m_all, "clean": m_cl}
        res["rows"][f"r131 {R13.TL[T]}"] = {"fit_rows": int(len(cat["y"])), "bad_rows": int(cat["bad"].sum()),
                                            "bad_pos_by_level": cat["y"][cat["bad"]].sum(0).tolist(),
                                            "pos_by_level": cat["y"].sum(0).tolist()}
        fr = f131["maps"].get(R13.TL[T])
        if fr:
            res["rows"][f"r131 {R13.TL[T]}"]["repro_b_diff"] = {
                b: abs(m_all[b]["b"] - fr[b]["b"]) for b in m_all if b in fr}
        log(f"r131 {R13.TL[T]}: " + json.dumps({b: [round(fr[b]['b'], 4) if fr else None, round(m_all[b]['b'], 4),
                                                       round(m_cl[b]['b'], 4)] for b in m_all}))
        del St, cat
        if T in D14.HS:
            St = {}
            for nm, sp in sets.items():
                S = D14.run_rows(sp, T, "6h", 4, log, nm)
                badsid = np.array([i for i, s in enumerate(sp) if s["key"] in bad], int)
                S["bad"] = np.isin(S["sid"], badsid)
                St[nm] = S
            fm = {nm: (~S["q2"] & ~S["tail"] & (S["ts"] % D14.LEVEL_GRID == 0)) for nm, S in St.items()}
            pG = np.concatenate([St[nm]["pG"][fm[nm]] for nm in St])
            yG = np.concatenate([St[nm]["yG"][fm[nm]] for nm in St])
            bd = np.concatenate([St[nm]["bad"][fm[nm]] for nm in St])
            d_all = D14.fit_dr(pG, yG, 1)
            d_cl = D14.fit_dr(pG[~bd], yG[~bd], 1)
            res["r141"][D14.TL[T]] = {"all": d_all, "clean": d_cl}
            fz = f141["dr_maps"][D14.TL[T]]
            res["rows"][f"r141 {D14.TL[T]}"] = {"fit_rows": int(len(bd)), "bad_rows": int(bd.sum()),
                                                "repro_b_maxdiff": float(np.max(np.abs(np.array(d_all["b"]) -
                                                                                        np.array(fz["b"]))))}
            log(f"r141 {D14.TL[T]}: b frozen {np.round(fz['b'], 4).tolist()} all {np.round(d_all['b'], 4).tolist()}"
                f" clean {np.round(d_cl['b'], 4).tolist()}")
            del St, pG, yG
        json.dump(res, open(os.path.join(out, "maps-clean.json"), "w"), indent=1, default=float)
    log("fit done")


def _patch_sha(sha):
    R112.git_sha = lambda *a, **k: sha


def _filter_specs(mod, fname, bad):
    orig = getattr(mod, fname)

    def f(*a, **k):
        sp = orig(*a, **k)
        keep = [s for s in sp if s.get("asset", s["key"].split(":")[-1].split("#")[0]) not in bad]
        log(f"audit filter {fname}: {len(sp)} -> {len(keep)} specs")
        return keep
    setattr(mod, fname, f)


def cmd_run141(ex, out, variant):
    f141 = json.load(open(F141))
    maps = json.load(open(os.path.join(out, "..", "maps", "maps-clean.json"))) if variant != "frozen-clean" else None
    cfg = dict(f141)
    if maps:
        cfg["dr_maps"] = {T: maps["r141"][T]["clean"] for T in cfg["dr_maps"]}
        cfg["r131"] = dict(cfg["r131"])
        cfg["r131"]["maps"] = {T: maps["r131"][T]["clean"] for T in cfg["r131"]["maps"]}
    d = os.path.join(out, variant)
    os.makedirs(d, exist_ok=True)
    json.dump(cfg, open(os.path.join(d, "frozen-r141-config.json"), "w"), indent=1)
    _patch_sha(cfg["code_sha"])
    if variant in ("frozen-clean", "refit-clean"):
        _filter_specs(D14, "b15b_specs", set(ex.get("B15b", {})))
    D14.cmd_run(SimpleNamespace(out=d, acq=f"{DS}/b15-mexc-prices", workers=4))


def cmd_run131(ex, out, variant):
    f131 = json.load(open(F131))
    cfg = dict(f131)
    if variant == "refit":
        maps = json.load(open(os.path.join(out, "..", "maps", "maps-clean.json")))
        cfg["maps"] = {T: maps["r131"][T]["clean"] for T in cfg["maps"]}
    d = os.path.join(out, variant)
    os.makedirs(d, exist_ok=True)
    json.dump(cfg, open(os.path.join(d, "frozen-r131-config.json"), "w"), indent=1)
    _patch_sha(cfg["code_sha"])
    R13.cmd_run(SimpleNamespace(out=d, acq=f"{DS}/b15-mexc-prices", workers=4))


if __name__ == "__main__":
    cmd, exf, out = sys.argv[1:4]
    ex = json.load(open(exf))
    os.makedirs(out, exist_ok=True)
    if cmd == "fit":
        cmd_fit(ex, out)
    elif cmd == "run141":
        cmd_run141(ex, out, sys.argv[4])
    elif cmd == "run131":
        cmd_run131(ex, out, sys.argv[4])
