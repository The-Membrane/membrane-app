"""Q26 D11 registration support (membrane-board design/HISTORY_TOUCH_LIVE.md D11). DEVELOPMENT ONLY (seen data).

D11 registration support (development only): daily paired Brier differences of walk-forward Platt-recalibrated
rule D (E1 walk-forward ensemble) vs recalibrated (fH) on the 273 non-BTC/ETH development series, daily 00:00Z origins.
Recalibration emulates the live rule: per cell, logistic fit of y on [1, logit p] over rows with origin in
[m - 730 d, m), refit at the start of every month m (live refits daily). Output: devdays.npz."""
import os, sys, json
import numpy as np
from scipy.optimize import minimize
HF = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HF)
import r16_dev as D
import r16_nn as NN
# usage: python3 d11_devdays.py ROWS_DIR DATASETS OUT_DIR   (ROWS_DIR = the R16.2 development rows-T*.npz)
ROWS, OUTD, OUT = sys.argv[1], os.path.join(sys.argv[2], "history-forecasts/r16/r162e-cd-c41dff8f"), sys.argv[3]
DAY = 86400
lv = NN.TIER_LV["shallow"]
keys = json.load(open(os.path.join(ROWS, "rows-meta.json")))["series"]
excl = json.load(open(os.path.join(OUTD, "excluded.json")))
parts = []
for T in D.TIERS["shallow"]:
    Z = np.load(os.path.join(ROWS, f"rows-T{T}.npz"))
    n = len(Z["ts"]); Y = np.full((n, 5), -1, np.int8); P = np.full((n, 5), np.nan)
    y, fH = Z["y"], Z["fH"]
    for j, k in enumerate(D.LV[T]):
        c = lv.index(k); Y[:, c] = y[:, j]; P[:, c] = fH[:, j]
    parts.append({"sid": Z["sid"], "ts": Z["ts"], "Y": Y, "P": P, "T": np.full(n, T, np.int32)})
X = {k: np.concatenate([p[k] for p in parts]) for k in parts[0]}
keep = ~np.array([k in excl for k in keys])[X["sid"]]
M = np.load(os.path.join(OUTD, "cd-mean-residuals.npz"))
g = np.flatnonzero(keep)[M["idx"]]
sid, ts, T, Y, PH = X["sid"][g], X["ts"][g], X["T"][g], X["Y"][g], X["P"][g]
del X
msk = Y >= 0
LF = np.zeros_like(PH); LF[msk] = D.lg(PH[msk])
PD = np.clip(np.minimum.accumulate(1 / (1 + np.exp(-(LF + M["D_E1"].astype(np.float64)))), axis=1), 0, 1)
PH = np.where(msk, PH, np.nan)
desc = np.array([k in ("dev:ETH", "dev:BTC", "P1:KRAKEN-ETH") for k in keys])[sid]
print("rows", len(ts), "desc rows", desc.sum(), "series", len(np.unique(sid[~desc])))
def lgc(p):
    p = np.clip(p, 1e-6, 1 - 1e-6); return np.log(p / (1 - p))
def platt(x, y):
    f = lambda w: np.sum(np.logaddexp(0, w[0] + w[1] * x) - y * (w[0] + w[1] * x))
    def gr(w):
        s = 1 / (1 + np.exp(-(w[0] + w[1] * x))); return np.array([np.sum(s - y), np.sum((s - y) * x)])
    return minimize(f, np.array([0.0, 1.0]), jac=gr, method="L-BFGS-B").x
import datetime as dt
months = []
y0, m0 = 2019, 7
while True:
    t0 = int(dt.datetime(y0, m0, 1, tzinfo=dt.timezone.utc).timestamp())
    if t0 > ts.max(): break
    months.append(t0); y0, m0 = (y0 + (m0 == 12), m0 % 12 + 1)
months = np.array(months)
mo = np.searchsorted(months, ts, side="right") - 1
QD = np.full_like(PH, np.nan); QH = np.full_like(PH, np.nan)
cells = [(t, k) for t in D.TIERS["shallow"] for k in D.LV[t]]
for (t, k) in cells:
    c = lv.index(k); r = (T == t) & msk[:, c] & ~desc
    xh, xd, yy, tt, mm = lgc(PH[r, c]), lgc(PD[r, c]), Y[r, c].astype(float), ts[r], mo[r]
    qh, qd = np.full(r.sum(), np.nan), np.full(r.sum(), np.nan)
    for mi, m in enumerate(months):
        te = mm == mi
        if not te.any(): continue
        tr = (tt >= m - 730 * DAY) & (tt < m)
        if tr.sum() < 1000 or yy[tr].sum() < 20: continue
        for x, q in ((xh, qh), (xd, qd)):
            w = platt(x[tr], yy[tr]); q[te] = 1 / (1 + np.exp(-(w[0] + w[1] * x[te])))
    QH[np.flatnonzero(r), c] = qh; QD[np.flatnonzero(r), c] = qd
# monotone fix across levels (running min over the present levels)
for Q in (QH, QD):
    Q[:] = np.where(msk, Q, np.nan)
    tmp = np.where(np.isnan(Q), 1.0, Q); tmp = np.minimum.accumulate(tmp, axis=1); Q[:] = np.where(msk, tmp, np.nan)
ok = ~desc & np.all(np.isfinite(QH) | ~msk, axis=1) & np.all(np.isfinite(QD) | ~msk, axis=1)
out = {}
for t in D.TIERS["shallow"]:
    cols = [lv.index(k) for k in D.LV[t]]
    r = ok & (T == t)
    yy = Y[r][:, cols].astype(float); qh = QH[r][:, cols]; qd = QD[r][:, cols]
    rawh, rawd = PH[r][:, cols], PD[r][:, cols]
    dd = (qh - yy) ** 2 - (qd - yy) ** 2                     # >0: recalibrated D better
    lo = np.minimum(qh ** 2 - qd ** 2, (1 - qh) ** 2 - (1 - qd) ** 2)
    hi = np.maximum(qh ** 2 - qd ** 2, (1 - qh) ** 2 - (1 - qd) ** 2)
    draw = (rawh - yy) ** 2 - (rawd - yy) ** 2
    day = ts[r] // DAY
    ud, inv = np.unique(day, return_inverse=True)
    nrow = np.bincount(inv, minlength=len(ud)) * len(cols)
    f = lambda a: np.bincount(inv, weights=a.sum(1), minlength=len(ud)) / nrow
    out[f"T{t}_day"] = ud; out[f"T{t}_d"] = f(dd); out[f"T{t}_lo"] = f(lo); out[f"T{t}_hi"] = f(hi)
    out[f"T{t}_draw"] = f(draw); out[f"T{t}_nser"] = np.bincount(inv, minlength=len(ud))
    out[f"T{t}_bH"] = f((qh - yy) ** 2); out[f"T{t}_pos"] = np.bincount(inv, weights=yy.sum(1), minlength=len(ud))
    out[f"T{t}_sq"] = f((qh - qd) ** 2)
    bss = 1 - ((qd - yy) ** 2).sum() / ((qh - yy) ** 2).sum()
    print(f"T{t}: days {len(ud)} rows {r.sum()} recal BSS D vs fH {bss:+.4f} mean daily d {out[f'T{t}_d'].mean():.3e}"
          f" raw daily {out[f'T{t}_draw'].mean():.3e} R_D {qd.sum()/yy.sum():.3f} R_H {qh.sum()/yy.sum():.3f}")
np.savez_compressed(os.path.join(OUT, "devdays.npz"), **out)
