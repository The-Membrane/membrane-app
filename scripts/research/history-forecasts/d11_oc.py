"""Q26 D11 e-process operating characteristics (membrane-board design/HISTORY_TOUCH_LIVE.md D11). DEVELOPMENT ONLY
(seen data; an optimistic proxy). usage: python3 d11_oc.py OUT_DIR (reads OUT_DIR/devdays.npz from d11_devdays.py).
The live rule is q26_live_d11.grapa_step; this file repeats it vectorized for simulation."""
import numpy as np, json, sys, math, os
OUT = sys.argv[1]
from scipy.stats import norm
Z = np.load(os.path.join(OUT, "devdays.npz"))
ALPHA, CAPF, N0, CAPDAYS = 0.05, 0.5, 30, 1095
def grapa(dd, BB, m0, v0):
    P, H = dd.shape
    S1 = np.concatenate([np.zeros((P, 1)), np.cumsum(dd, 1)[:, :-1]], 1)
    S2 = np.concatenate([np.zeros((P, 1)), np.cumsum(dd * dd, 1)[:, :-1]], 1)
    k = np.arange(H)[None, :]
    mh = (N0 * m0 + S1) / (N0 + k); vh = (N0 * v0 + S2) / (N0 + k)
    lt = np.clip(mh / vh, 0, CAPF / BB)
    return np.cumsum(np.log1p(lt * dd), 1)
def nw(x, lag):
    x = x - x.mean(); n = len(x); v = x @ x / n
    for j in range(1, lag + 1): v += 2 * (1 - j / (lag + 1)) * (x[j:] @ x[:-j]) / n
    return v
out = {}
for T in (3, 1, 12):
    ns = Z[f"T{T}_nser"]; m = ns >= 150
    d, lo, hi = Z[f"T{T}_d"][m], Z[f"T{T}_lo"][m], Z[f"T{T}_hi"][m]
    B = np.maximum(np.abs(lo), np.abs(hi)); mu = float(d.mean()); v0 = float(np.mean(d * d)); n = len(d)
    out[f"T{T}"] = {"pool_days": int(n), "mu_dev": mu, "v0_dev": v0, "sd_dev": float(d.std())}
    print(f"T{T}: pool days {n} mu {mu:.6e} v0 {v0:.6e}", flush=True)
    rng = np.random.default_rng(20261023 + T)
    P, H = 2000, 3000
    I = np.empty((P, H), np.int64)
    for p in range(P):
        i = rng.integers(n); o = []
        while len(o) < H:
            L = rng.geometric(1 / 28); o.extend(((i + np.arange(L)) % n).tolist()); i = rng.integers(n)
        I[p] = o[:H]
    eps = rng.choice([-1.0, 1.0], size=I.shape)
    scen = {}
    for name, c, model in (("1.0x", 1.0, "shift"), ("0.6x", 0.6, "shift"), ("0.4x", 0.4, "shift"),
                           ("0.6x prop", 0.6, "prop"), ("0.4x prop", 0.4, "prop"), ("NULL sign-flip", None, None)):
        if c is None:
            dd, BB = d[I] * eps, B[I]
        else:
            sh = (1 - c) * mu * (np.ones_like(B) if model == "shift" else B / B.mean())
            dd, BB = d[I] - sh[I], B[I] + sh[I]
        lw = grapa(dd, BB, 0.5 * mu, v0)
        lh = grapa(-dd, BB, 0.0, v0)
        cm = np.cumsum(dd, 1) / np.arange(1, H + 1)
        thr = math.log(1 / ALPHA)
        first = np.where((lw >= thr).any(1), (lw >= thr).argmax(1) + 1, 10 ** 9)
        harm = np.where((lh >= thr).any(1), (lh >= thr).argmax(1) + 1, 10 ** 9)
        f365 = np.where(cm[:, 364] <= 0, 365, 10 ** 9)
        f730 = np.where(cm[:, 729] <= 0, 730, 10 ** 9)
        stop = np.minimum.reduce([harm, f365, f730])
        grad = (first < stop) & (first <= CAPDAYS)  # graduation before any futility stop, within the cap
        gd = np.where(grad, first, np.inf)
        # fixed-date secondary at 450 days: NW lag 7 one-sided z, alpha 0.05 (computed on all paths, ignores stops)
        zf = np.array([dd[p, :450].mean() / math.sqrt(nw(dd[p, :450], 7) / 450) for p in range(P)])
        r = {"P_graduate_by": {str(h): float(np.mean(gd <= h)) for h in (180, 270, 365, 450, 730, 1095)},
             "median_days_to_graduate": (float(np.median(gd)) if np.mean(grad) >= 0.5 else None),
             "median_days_given_graduation": float(np.median(first[grad])) if grad.any() else None,
             "P_futility_365": float(np.mean((f365 == stop) & ~grad & (stop == 365))),
             "P_futility_730": float(np.mean((stop == 730) & ~grad)),
             "P_harm_stop": float(np.mean((harm == stop) & (harm < 10 ** 9) & ~grad)),
             "P_not_confirmed_at_cap": float(np.mean(~grad & (stop >= 10 ** 9))),
             "pool": "dev days with >= 150 series, stationary blocks mean 28 d",
             "P_e_crosses_by_1095_ignoring_futility": float(np.mean(first <= 1095)),
             "median_days_e_crosses_no_futility_no_cap_3000": float(np.median(np.where(first <= H, first, np.inf))),
             "P_e_crosses_by_3000_no_futility_no_cap": float(np.mean(first <= H)),
             "fixed_date_450_power_alpha05": float(np.mean(zf > norm.ppf(0.95)))}
        scen[name] = r
        print(" ", name, json.dumps(r), flush=True)
    out[f"T{T}"]["scenarios"] = scen
json.dump(out, open(os.path.join(OUT, "oc-d11.json"), "w"), indent=1)
