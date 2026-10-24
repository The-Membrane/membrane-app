"""Q26 R19.1 (design/Q26_ROUND19_PREREG.md T3). Run with the R11.1-v4 frozen code dir (membrane-app caf536f4) on the Polygon work dir.
R19.1 distance-to-line aggregates on Aave V3 Polygon (R11.1-v4 INPUT state only; no liquidation outcome read).
For sampled hourly read blocks, every account with USDC debt >= $100: Aave HF (engine formulas, as integrity check 5),
and the price drop that takes HF to 1 under two co-movement rules:
  U  = every non-stable asset (collateral AND debt) falls by the same fraction (perfect co-movement)
  D1 = only the account's largest LT-weighted collateral asset falls, all else fixed
Aggregates only (no addresses). Usage: dist.py <code_dir> <work> <out.json>"""
import sys, json, bisect, datetime as dt, numpy as np
sys.path.insert(0, sys.argv[1])
import r111v3_engine as E, r111v3_gate as G, r111v4_gate as V
work, out = sys.argv[2], sys.argv[3]
SEED, NBLK, MIN_DEBT = 20261024, 120, 100.0
STABLE = {"USDC", "USDC.e", "USDT", "USDT0", "DAI", "miMATIC", "LUSD", "GHO", "EURS", "agEUR", "jEUR", "EURA", "FRAX", "crvUSD"}
inp = E.Inputs(work); metas = G.arb_metas(work); hours = G.arb_hours(inp, work)
m = V.MK["poly"]
first = int(dt.datetime.combine(m["first"], dt.time(), dt.timezone.utc).timestamp())
last = int(dt.datetime.combine(m["last"], dt.time(), dt.timezone.utc).timestamp())
excl = {int(dt.datetime.combine(dt.date.fromisoformat(d), dt.time(), dt.timezone.utc).timestamp()) // 86400 for d in V.EXCLUDE}
cand = [h for h in hours if first <= h["hour"] <= last and h["hour"] // 86400 not in excl]
rng = np.random.default_rng(SEED)
picks = [cand[i] for i in sorted(rng.choice(len(cand), size=NBLK, replace=False).tolist())]
st = E.State(inp); idx = E.Indexes(inp); ks, ty, pos = V.stream(inp); ptr = 0
inv = 1.0 / 10.0 ** inp.dec; usdc = [inp.gidx[u] for u in m["usdc"]]; ds = sorted(metas)
sym = list(inp.symbols); stab = np.array([s in STABLE for s in sym])
rows = []
for h in picks:
    lim = h["block"] * 1_000_000 + 999_999
    ptr = V.advance(st, inp, ks, ty, pos, ptr, lim); idx.advance(lim); Lt, Vt = idx.at(float(h["ts"]))
    dstr = dt.datetime.fromtimestamp(h["hour"], dt.timezone.utc).date().isoformat()
    meta = metas[ds[max(bisect.bisect_right(ds, dstr) - 1, 0)]]
    day = E.M.Day({**meta, "reserves": {k: v for k, v in meta["reserves"].items() if k in inp.gidx}}, inp.gidx)
    px = h["prices"]
    users = np.nonzero((st.SV[:, usdc] > 0.5).any(axis=1) | (st.SP[:, usdc] > 0.5).any(axis=1))[0]
    if len(users) == 0: continue
    sa, sv = st.SA[users], st.SV[users]; ss = E.stable_value(st.SP[users], st.SR[users], st.ST[users], float(h["ts"]))
    LT = np.zeros((len(users), inp.R)); ems = st.EM[users]
    for em in np.unique(ems): LT[ems == em] = day.eff(em)[0]
    coll = sa * (Lt * inv * px); debt = sv * (Vt * inv * px) + ss * (inv * px)
    el = st.FL[users] & (LT > 0); wc = coll * LT * el
    usdc_debt = debt[:, usdc].sum(axis=1)
    keep = usdc_debt >= MIN_DEBT
    wc, debt, coll, ems_k = wc[keep], debt[keep], coll[keep], ems[keep]
    num = wc.sum(axis=1); td = debt.sum(axis=1)
    hf = np.where(td > 0, num / td, np.inf)
    nv, ns = wc[:, ~stab].sum(axis=1), wc[:, stab].sum(axis=1)
    dv, dsb = debt[:, ~stab].sum(axis=1), debt[:, stab].sum(axis=1)
    # U: ns + nv(1-x) = dsb + dv(1-x)  ->  x = 1 - (dsb - ns)/(nv - dv), defined when nv > dv
    with np.errstate(divide="ignore", invalid="ignore"):
        xU = np.where(nv > dv, 1 - (dsb - ns) / (nv - dv), np.nan)
    top = wc.argmax(axis=1); wtop = wc[np.arange(len(top)), top]
    with np.errstate(divide="ignore", invalid="ignore"):
        x1 = np.where((wtop > 0) & ~stab[top], (num - td) / wtop, np.nan)
    topsym = np.array([sym[k] for k in top])
    for i in range(len(td)):
        rows.append((h["hour"], float(td[i]), float(hf[i]), float(xU[i]), float(x1[i]), topsym[i], bool(stab[top[i]]),
                     int(ems_k[i] != 0)))
    print(dstr, len(td), flush=True)
hour, debt, hf, xU, x1, tops, topstab, em = map(np.array, zip(*rows))
BINS = [-np.inf, 0, .02, .05, .10, .15, .20, .30, .50, np.inf]
LAB = ["<0 (past line)", "0-2%", "2-5%", "5-10%", "10-15%", "15-20%", "20-30%", "30-50%", ">50%"]
def hist(x, w):
    ok = np.isfinite(x); res = {}
    tot_n, tot_w = len(x), w.sum()
    for a, b, l in zip(BINS[:-1], BINS[1:], LAB):
        s = ok & (x >= a) & (x < b); res[l] = {"share_pos": round(s.sum() / tot_n, 4), "share_debt": round(w[s].sum() / tot_w, 4)}
    res["no uniform-drop line"] = {"share_pos": round((~ok).sum() / tot_n, 4), "share_debt": round(w[~ok].sum() / tot_w, 4)}
    return res
def q(x, w):
    ok = np.isfinite(x) & (x >= 0); xs, ws = x[ok], w[ok]; o = np.argsort(xs); xs, ws = xs[o], ws[o]
    cw = np.cumsum(ws) / ws.sum()
    return {"pos_q10_q25_q50_q75_q90": [round(float(v), 4) for v in np.quantile(xs, [.1, .25, .5, .75, .9])],
            "debtw_q10_q25_q50_q75_q90": [round(float(xs[np.searchsorted(cw, p)]), 4) for p in [.1, .25, .5, .75, .9]]}
res = {"item": "Q26 R19.1 distance-to-line, Aave V3 Polygon USDC-debt accounts (inputs only)",
       "seed": SEED, "blocks": int(len(np.unique(hour))), "rows": int(len(debt)), "min_usdc_debt_usd": MIN_DEBT,
       "span": [str(m["first"]), str(m["last"])], "excluded_days": sorted(V.EXCLUDE),
       "stable_set": sorted(STABLE), "uniform_drop_U": {"hist": hist(xU, debt), **q(xU, debt)},
       "top_asset_only_D1": {"hist": hist(x1, debt), **q(x1, debt)}, "by_top_collateral": {}, "emode_share_pos": round(em.mean(), 4)}
for s in ["WETH", "WBTC", "WMATIC", "WPOL", "wstETH", "stMATIC", "MaticX", "LINK", "AAVE"]:
    k = tops == s
    if k.sum() >= 50:
        res["by_top_collateral"][s] = {"rows": int(k.sum()), "debt_share": round(debt[k].sum() / debt.sum(), 4),
                                       "U": q(xU[k], debt[k]), "D1": q(x1[k], debt[k])}
k = topstab; res["by_top_collateral"]["stable (top asset stablecoin)"] = {"rows": int(k.sum()), "debt_share": round(debt[k].sum() / debt.sum(), 4)}
json.dump(res, open(out, "w"), indent=1); print("done", len(debt))
