"""Q26 closed-path audit 2026-10-19 (membrane-board design/q26-closed-path-audit-2026-10-19.md).

R14.1 on spent B15b: reproduce, then pigeonhole (centred/percentile) vs CGM two-way z, leave-top-5 series.
Development or spent (grade C) data only. No reserved set is read.
"""
import os
DS = os.environ.get("MEMBRANE_DATASETS", os.path.expanduser("~/membrane-datasets"))
OUT = os.environ.get("Q26_AUDIT_OUT", ".")
import sys, os, json, math, numpy as np
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import r14_dr as D, r12_tail as R12, r13_recal as R13
cfg = json.load(open(DS + "/history-forecasts/r14/r141-run-b90111b2/frozen-r141-config.json"))
pub = json.load(open(DS + "/history-forecasts/r14/r141-run-b90111b2/results-r141.json"))
specs = D.b15b_specs(DS + "/b15-mexc-prices")
log = lambda s: print(s, flush=True)
B = 2000
out = {}
for T in D.HS:
    S = D.run_rows(specs, T, "1h", 3, log, "B15b")
    P = D.forecasts_of(S, T, cfg)
    rows = np.flatnonzero(~S["q2"] & ~S["tail"])
    for ci, k in enumerate(D.DLEV):
        key = f"{D.TL[T]} {k}"
        y = S["y"][rows, D.KIX[k]].astype(float); sid = S["sid"][rows]; ts = S["ts"][rows]
        p1 = P["DR"][rows, ci].astype(float); p0 = P["fH"][rows, ci].astype(float)
        g, G, posb = R12.crash_blocks(ts, sid, y, T)
        top = R13.quint_masks(p1)[0]; top0 = R13.quint_masks(p0)[0]
        e1, e0 = (p1 - y)**2, (p0 - y)**2
        bss = 1 - e1.sum()/e0.sum()
        R1, R0 = p1.sum()/y.sum(), p0.sum()/y.sum()
        Rt1, Rt0 = (p1*top).sum()/(y*top).sum(), (p0*top0).sum()/(y*top0).sum()
        d = abs(math.log(R1)) - abs(math.log(R0)); dt = abs(math.log(Rt1)) - abs(math.log(Rt0))
        # CGM two-way on influence functions
        s1, s0 = np.sign(math.log(R1)), np.sign(math.log(R0)); st1, st0 = np.sign(math.log(Rt1)), np.sign(math.log(Rt0))
        psi_b = -(e1 - (e1.sum()/e0.sum())*e0)/e0.sum()
        psi_d = s1*(p1/p1.sum() - y/y.sum()) - s0*(p0/p0.sum() - y/y.sum())
        psi_t = st1*(p1*top/(p1*top).sum() - y*top/(y*top).sum()) - st0*(p0*top0/(p0*top0).sum() - y*top0/(y*top0).sum())
        nS = int(sid.max())+1; cell = sid.astype(np.int64)*G + g
        def cgm(psi):
            a = np.bincount(sid, psi, nS); b = np.bincount(g, psi, G); c = np.bincount(cell, psi, nS*G)
            vs, vb, vi = (a**2).sum(), (b**2).sum(), (c**2).sum()
            return math.sqrt(max(vs+vb-vi, 1e-300)), math.sqrt(vs), math.sqrt(vb)
        # pigeonhole on (series, block) cell sums
        uc, inv = np.unique(cell, return_inverse=True); cs, cb = uc//G, uc % G
        X = np.stack([np.bincount(inv, w, len(uc)) for w in (e1, e0, p1, p0, y, p1*top, y*top, p0*top0, y*top0)])
        rng = np.random.default_rng(20261019 + T*100 + int(-100*k))
        stats = []
        for _ in range(B):
            ws = np.bincount(rng.integers(0, nS, nS), minlength=nS).astype(float)
            wb = np.bincount(rng.integers(0, G, G), minlength=G).astype(float)
            w = ws[cs]*wb[cb]; Z = X @ w
            with np.errstate(all="ignore"):
                stats.append((1 - Z[0]/Z[1], abs(math.log(Z[2]/Z[4])) - abs(math.log(Z[3]/Z[4])),
                              abs(math.log(Z[5]/Z[6])) - abs(math.log(Z[7]/Z[8]))))
        st = np.array(stats); st = st[np.all(np.isfinite(st), 1)]
        def pp(col, obs, upper):  # one-sided: H1 obs>0 (upper) or obs<0
            x = st[:, col]
            if upper: return (1+np.sum(x - obs >= obs))/(len(x)+1), (1+np.sum(x <= 0))/(len(x)+1)
            return (1+np.sum(x - obs <= obs))/(len(x)+1), (1+np.sum(x >= 0))/(len(x)+1)
        # leave top-5 series by gain
        gain = np.bincount(sid, e0 - e1, nS); topS = np.argsort(-gain)[:5]; keep = ~np.isin(sid, topS)
        bss_l5 = 1 - e1[keep].sum()/e0[keep].sum()
        zb = cgm(psi_b); zd = cgm(psi_d); zt = cgm(psi_t)
        pf = pub["cells"][key]["f"]["DR"]
        out[key] = {"rep_bss": [bss, pf["bss_vs_ref"]], "rep_R": [R1, pub["cells"][key]["f"]["DR"]["R"]],
                    "d": d, "dt": dt, "bss": bss, "series_gain_share_top5": float(gain[topS].sum()/gain.sum()),
                    "cgm_z": {"bss": bss/zb[0], "d": d/zd[0], "dt": dt/zt[0]},
                    "series_only_z": {"bss": bss/zb[1], "d": d/zd[1], "dt": dt/zt[1]},
                    "pig_p_centred_pct": {"bss": pp(0, bss, True), "d": pp(1, d, False), "dt": pp(2, dt, False)},
                    "bss_leave_top5": bss_l5, "blocks": int(G), "pos_blocks": int(posb.sum())}
        log(key + " " + json.dumps(out[key]))
    del S, P
json.dump(out, open(OUT + "/r141_twoway.json", "w"), indent=1, default=float)
