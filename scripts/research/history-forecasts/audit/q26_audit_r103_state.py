"""Q26 closed-path audit 2026-10-19 (membrane-board design/q26-closed-path-audit-2026-10-19.md).

R10.3 (APR rate path): PIT/coverage of the published R10.3 paths by HAR vol-state tercile on Core USDC (grade C).
Development or spent (grade C) data only. No reserved set is read.
"""
import os
DS = os.environ.get("MEMBRANE_DATASETS", os.path.expanduser("~/membrane-datasets"))
OUT = os.environ.get("Q26_AUDIT_OUT", ".")
import sys, os, numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["MEMBRANE_DATASETS"] = DS + ""
import r103_curve_apr as M
h = pd.read_csv(os.path.join(DS + "", M.H_INPUT))
st = M.daily_state(h); dates = st.index; U = st["U"].to_numpy()
D = np.full(len(U), np.nan); D[1:] = np.diff(M.logit(U)); pos = {t: i for i, t in enumerate(dates)}
P = pd.read_csv(DS + "/history-forecasts/r10/r103-run-67e1f71f/predictions-r103.csv.gz")
rows = []
for r in P.itertuples():
    t0 = pd.Timestamp(r.origin, tz="UTC"); i0 = pos[t0]; iT = pos[t0 + pd.Timedelta(days=7)]
    Dc = D.copy(); lo = max(31, i0 - M.TRAIN_D + 1); rr = np.arange(lo, i0 + 1)
    rv = Dc**2; rv[0] = 0
    X = M.har_X(rv, rr); y = rv[rr]; beta, *_ = np.linalg.lstsq(X, y, rcond=None)
    floor = M.FLOOR_SHARE*float(np.mean(y)); sig2 = np.maximum(X@beta, floor); z = Dc[rr]/np.sqrt(sig2)
    ext = list(rv[:i0+1]); fc = []
    for _ in range(7):
        a = np.array(ext); n=len(a); x = np.array([1, a[n-1], a[n-7:n].mean(), a[n-30:n].mean()]); s = max(float(x@beta), floor); fc.append(s); ext.append(s)
    sc = np.sqrt(fc); W = np.lib.stride_tricks.sliding_window_view(z, 7); S = W@sc
    real = M.logit(U[iT]) - M.logit(U[i0])
    pit = (np.sum(S < real) + 0.5*np.sum(S == real))/len(S)
    vs = np.log(np.mean(fc)/np.mean(y))     # vol state: forecast vs training mean RV
    # realised 7-day RV relative to forecast
    rv_real = np.sum(rv[i0+1:iT+1]); e = 0.5*np.log(rv_real/np.sum(fc)) if rv_real>0 else np.nan
    rows.append((r.origin, r.inQ2, vs, pit, e, r.L_model, r.L_c3, r.L_nochange, r.curve_changed_q33))
R = pd.DataFrame(rows, columns="origin inQ2 vs pit e Lm Lc Ln cc".split())
R = R[~R.inQ2]
R["terc"] = pd.qcut(R.vs, 3, labels=["calm","mid","turb"])
g = R.groupby("terc", observed=True)
out = g.apply(lambda d: pd.Series({"n": len(d), "cov90": ((d.pit>0.05)&(d.pit<0.95)).mean(), "cov50": ((d.pit>0.25)&(d.pit<0.75)).mean(),
   "pit_mean": d.pit.mean(), "pit_lt05": (d.pit<0.05).mean(), "pit_gt95": (d.pit>0.95).mean(), "mean_e": d.e.mean(), "Lm/Lc": d.Lm.sum()/d.Lc.sum(), "Lm/Ln": d.Lm.sum()/d.Ln.sum()}))
print(out.round(3).to_string())
print("all", len(R), "cov90", ((R.pit>0.05)&(R.pit<0.95)).mean().round(3), "mean e", R.e.mean().round(3), "Lm/Lc", (R.Lm.sum()/R.Lc.sum()).round(3))
print("corr(vs, e)", R[["vs","e"]].corr().iloc[0,1].round(3))
R.to_csv(OUT + "/r103_state.csv", index=False)
