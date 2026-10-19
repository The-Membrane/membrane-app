"""Q26 closed-path audit 2026-10-19 (membrane-board design/q26-closed-path-audit-2026-10-19.md).

R10.3: state-matched block bootstrap (nearest third by HAR state) vs the published R10.3 on the 725 Core origins (dev, post hoc).
Development or spent (grade C) data only. No reserved set is read.
"""
import os
DS = os.environ.get("MEMBRANE_DATASETS", os.path.expanduser("~/membrane-datasets"))
OUT = os.environ.get("Q26_AUDIT_OUT", ".")
import sys, os, numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import r103_curve_apr as M
h = pd.read_csv(os.path.join(DS + "", M.H_INPUT))
st = M.daily_state(h); dates = st.index; U = st["U"].to_numpy()
D = np.full(len(U), np.nan); D[1:] = np.diff(M.logit(U)); pos = {t: i for i, t in enumerate(dates)}
P = pd.read_csv(DS + "/history-forecasts/r10/r103-run-67e1f71f/predictions-r103.csv.gz")
out = []
for r in P.itertuples():
    t0 = pd.Timestamp(r.origin, tz="UTC"); i0 = pos[t0]
    row = st.iloc[i0]; curve = (row["base_rate"], row["slope1"], row["slope2"], row["optimal_usage"])
    lo = max(31, i0 - M.TRAIN_D + 1); rr = np.arange(lo, i0 + 1)
    rv = D**2; rv[0] = 0
    X = M.har_X(rv, rr); y = rv[rr]; beta, *_ = np.linalg.lstsq(X, y, rcond=None)
    floor = M.FLOOR_SHARE*float(np.mean(y)); sig2 = np.maximum(X@beta, floor); z = D[rr]/np.sqrt(sig2)
    ext = list(rv[:i0+1]); fc = []
    for _ in range(7):
        a = np.array(ext); n=len(a); x = np.array([1, a[n-1], a[n-7:n].mean(), a[n-30:n].mean()]); s = max(float(x@beta), floor); fc.append(s); ext.append(s)
    sc = np.sqrt(fc); nb = len(z)-6; W = np.lib.stride_tricks.sliding_window_view(z, 7)[:nb]
    stt = np.log(sig2/np.mean(y)); s0 = np.log(np.mean(fc)/np.mean(y))
    res = {}
    S = W@sc; q = np.quantile(M.curve_apr(M.expit(M.logit(row["U"])+S), *curve), M.QS); res["base"] = M.pinball(q, r.y)
    # state-matched blocks: nearest third by state at block start
    d = np.abs(stt[:nb]-s0); k = max(60, nb//3); sel = np.argsort(d)[:k]
    S2 = W[sel]@sc; q2 = np.quantile(M.curve_apr(M.expit(M.logit(row["U"])+S2), *curve), M.QS); res["match"] = M.pinball(q2, r.y)
    # ex-ante level fix: rescale by trailing realised/forecast ratio of 7d sums over training blocks (state-binned)
    out.append((r.origin, r.inQ2, r.L_model, r.L_c3, r.L_nochange, res["base"], res["match"]))
R = pd.DataFrame(out, columns="origin inQ2 Lpub Lc3 Lnc Lbase Lmatch".split()); R = R[~R.inQ2]
print("reproduce max|Lbase-Lpub|", np.abs(R.Lbase-R.Lpub).max())
for c in ["Lbase","Lmatch"]:
    print(c, "vs C3 %.3f vs nochange %.3f" % (R[c].sum()/R.Lc3.sum(), R[c].sum()/R.Lnc.sum()))
R["fold"]=P.set_index("origin").loc[R.origin,"fold"].values
print(R.groupby("fold").apply(lambda d: pd.Series({"base/C3": d.Lbase.sum()/d.Lc3.sum(), "match/C3": d.Lmatch.sum()/d.Lc3.sum()})).round(3))
