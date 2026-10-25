"""Q26 R30: second-chain replication of the borrower "at risk" alert (R0 at exactly 3 %, hourly, one alert per episode,
R27 re-arm) on Aave V3 Arbitrum, against the TWAP-touch target of REVIEW Q26-R27 and the Membrane event M of R29.

Design, set status, pass rule and outputs: membrane-board design/q26-r30-second-chain-2026-10-25.md (registered before
any R30 score). The threshold is NOT tuned on the new chain.

  python3 r30_replicate.py labels  --work ARB --scr SCR --datasets DS     # label-B rows (scratch, holds account ids)
  python3 r30_replicate.py hfcheck --work ARB --scr SCR                   # rebuilt HF vs getUserAccountData (keyless)
  python3 r27_atrisk.py build --datasets DS --scr SCR --work R27WORK      # R27 episodes and checks (unchanged code)
  python3 r30_replicate.py score   --work R27WORK --out OUT --chain NAME [--ref POLY.json] [--nb 2000]

ARB is the R11.1-v3 acquisition directory (r111v3_acquire.py reserves, logs, meta, stable, bt, liq for market arb).
SCR receives rows-labels.npz (scratch, never published). OUT receives address-free aggregates only.

Label rows follow r111v5_labels.cmd_labels exactly for the fields R27 reads (day, u, hf0, singleX, kX, yB, act_first,
liq_first), with three registered differences: (1) the minute-envelope screen of label A is not computed (R27 does not
read it); (2) the 00:00Z price read is the daily meta anchor read (the same block rule as the hourly read: the last
held pool-event block with timestamp < 00:00Z); (3) the stable set adds the Arbitrum symbols "USD₮0" and "MAI".
Label horizons: 6 h only (R27 reads kX[:, 0] and yB[:, 0]).
"""
from __future__ import annotations

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import datetime as dt  # noqa: E402
import json  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402

import numpy as np  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "live"))

HOUR, DAY = 3600, 86400
HS = (6,)
STABLE_EXTRA = {"USD₮0", "MAI"}
FIRST_ORIGIN_ARB = dt.date(2022, 9, 1)        # keyless archive state starts after Nitro (R11.1-v3 "first_day")
LAST_ORIGIN = dt.date(2026, 9, 23)
MIN_DEBT = 100.0

# ---- registered pass rule (design section 4) ----
THR = 0.03
PASS_RECALL = 0.60
PASS_FA = 0.05
PASS_LEAD_H = 4.0
MIN_TOUCH_EVENTS = 150
CURVE_D = (0.02, 0.03, 0.04, 0.05)
FINE_D = tuple(round(0.005 + 0.0005 * i, 4) for i in range(191))     # 0.5 % .. 10 % step 0.05 % (equal volume)
HF_SEED = 30
HF_DAYS = 12
HF_UNI, HF_NEAR = 25, 15
HF_TOL, HF_SHARE = 0.001, 0.99


def utc(d):
    return int(dt.datetime.combine(d, dt.time(), dt.timezone.utc).timestamp())


def rr(v, d=4):
    return None if v is None or (isinstance(v, float) and not np.isfinite(v)) else round(float(v), d)


def q3(v):
    v = np.asarray(v, float)
    v = v[np.isfinite(v)]
    return [rr(np.quantile(v, q), 2) for q in (0.25, 0.5, 0.75)] if len(v) else None


# =====================================================================================================================
# labels (lean r111v5 label-B rows)
# =====================================================================================================================
def day_hours_from_metas(inp, metas):
    """One 00:00Z read per day from the daily meta anchor (block, header ts, getAssetPrice of every listed reserve)."""
    out = []
    for d in sorted(metas):
        m = metas[d]
        px = np.zeros(inp.R)
        for a_, r in m["reserves"].items():
            k = inp.gidx.get(a_)
            if k is not None and r.get("price"):
                px[k] = r["price"] / 1e8
        out.append({"hour": utc(dt.date.fromisoformat(d)), "block": int(m["block"]), "ts": int(m["ts"]), "prices": px})
    return out


def cmd_labels(a):
    import r111v3_engine as E
    import r111v3_gate as G
    import r10_mechanics as M
    import r111v5_labels as LB
    t_start = time.time()
    inp = E.Inputs(a.work)
    metas = G.arb_metas(a.work)
    hours = day_hours_from_metas(inp, metas)
    rows_liq = G.jl(os.path.join(a.work, "liq-LOCKED.json.gz"))["rows"]
    liq = E.liq_rows_with_uid(inp, rows_liq)
    for r, x in zip(liq, rows_liq):
        r["ts"] = x["ts"]
    act, lq = LB.action_and_liq_times(inp, liq)
    sym = list(inp.symbols)
    R = inp.R
    stable = np.array([s in LB.STABLE_SYMS or s in STABLE_EXTRA for s in sym])
    inv_unit = 1.0 / (10.0 ** inp.dec)
    iii = {x: LB.read_iii(a.datasets, s) for x, (_, s) in LB.SERIES.items()}
    xk = {x: sym.index(x) for x in LB.SERIES if x in sym}
    print(json.dumps({"symbols": sym, "stable": [s for s, f in zip(sym, stable) if f], "series": list(xk)},
                     ensure_ascii=False), flush=True)
    t, p = inp.tok, inp.pool
    tk = t["block"] * 1_000_000 + t["lidx"]
    fk = p["f_block"] * 1_000_000 + p["f_lidx"]
    ek = p["e_block"] * 1_000_000 + p["e_lidx"]
    assert np.all(np.diff(tk) >= 0) and np.all(np.diff(fk) >= 0) and np.all(np.diff(ek) >= 0)
    st = E.State(inp)
    idx = E.Indexes(inp)
    ptr_t = ptr_f = ptr_e = 0
    hour_of = {h["hour"]: i for i, h in enumerate(hours)}
    day_cache = {}
    # HF check sample days (seeded, scored period); positions are sampled inside the loop
    rng = np.random.default_rng(HF_SEED)
    sc_days = [d for d in sorted(metas) if "2023-01-01" <= d <= LAST_ORIGIN.isoformat()]
    hf_days = set(sorted(rng.choice(sc_days, size=HF_DAYS, replace=False).tolist()))
    hf_rows = []
    out = {k: [] for k in ("day", "u", "debt", "hf0", "act_first", "liq_first", "singleX", "kX", "yB", "nvol",
                           "stable_debt")}
    cnt = {"days": 0, "days_missing_meta": 0, "rows": 0, "single_rows": 0, "single_no_price": 0}
    d = FIRST_ORIGIN_ARB
    while d <= LAST_ORIGIN:
        t_or = utc(d)
        hi = hour_of.get(t_or)
        if hi is None:
            cnt["days_missing_meta"] += 1
            d += dt.timedelta(days=1)
            continue
        h = hours[hi]
        K = h["block"] * 1_000_000 + 999_999
        e_t = int(np.searchsorted(tk, K, "right"))
        sl = slice(ptr_t, e_t)
        k_, u_, r_, dl = t["kind"][sl], t["user"][sl], t["res"][sl], t["delta"][sl]
        m0 = k_ == 0
        np.add.at(st.SA, (u_[m0], r_[m0]), dl[m0])
        m1 = k_ == 1
        np.add.at(st.SV, (u_[m1], r_[m1]), dl[m1])
        for i in (np.nonzero(k_ == 2)[0] + ptr_t).tolist():
            st.apply_tok(t, i)
        ptr_t = e_t
        e_f = int(np.searchsorted(fk, K, "right"))
        for i in range(ptr_f, e_f):
            st.apply_flag(p, i)
        ptr_f = e_f
        e_e = int(np.searchsorted(ek, K, "right"))
        for i in range(ptr_e, e_e):
            st.apply_emode(p, i)
        ptr_e = e_e
        idx.advance(K)
        Lt, Vt = idx.at(float(h["ts"]))
        pxh = np.asarray(h["prices"], dtype=float)
        dk = d.isoformat()
        if dk not in day_cache:
            meta = metas[dk]
            day_cache.clear()
            day_cache[dk] = M.Day({**meta, "reserves": {x: r for x, r in meta["reserves"].items() if x in inp.gidx}},
                                  inp.gidx)
        day = day_cache[dk]
        has_debt = (st.SV > 0.5).any(axis=1) | (st.SP > 0.5).any(axis=1)
        users = np.nonzero(has_debt)[0]
        if len(users) == 0:
            d += dt.timedelta(days=1)
            continue
        cnt["days"] += 1
        ss = E.stable_value(st.SP[users], st.SR[users], st.ST[users], float(h["ts"]))
        debt_u = st.SV[users] * Vt * inv_unit + ss * inv_unit
        debt_usd = (debt_u * pxh).sum(axis=1)
        keep = debt_usd >= MIN_DEBT
        users, debt_u, debt_usd = users[keep], debt_u[keep], debt_usd[keep]
        ems = st.EM[users]
        LT = np.zeros((len(users), R))
        for em in np.unique(ems):
            LT[ems == em] = day.eff(int(em))[0]
        elig = st.FL[users] & (LT > 0)
        cLT = st.SA[users] * Lt * inv_unit * LT * elig
        coll_usd = (cLT * pxh).sum(axis=1)
        hf0 = np.where(debt_usd > 0, coll_usd / debt_usd, np.inf)
        vr = idx.vr.copy()
        volc = (cLT > 0) & ~stable[None, :]
        vold = (debt_u > 0) & ~stable[None, :]
        nvol = volc.sum(axis=1)
        single = np.full(len(users), -1, dtype=np.int8)
        kX = np.full((len(users), len(HS)), np.nan, dtype=np.float32)
        yB = np.full((len(users), len(HS)), -1, dtype=np.int8)
        for xi, (x, k) in enumerate(xk.items()):
            sel = np.nonzero((nvol == 1) & volc[:, k] & ~vold.any(axis=1))[0]
            if len(sel) == 0:
                continue
            single[sel] = xi
            if not pxh[k] > 0:
                cnt["single_no_price"] += len(sel)
                continue
            st_iii, g_iii = iii[x]
            close, low = np.asarray(g_iii["close"], float), np.asarray(g_iii["low"], float)
            b0 = (t_or - st_iii) // 3600
            if b0 - 1 < 0 or b0 + 168 > len(close):
                continue
            G0 = close[b0 - 1]
            for hj, Hh in enumerate(HS):
                gVh = np.exp(np.maximum(vr, 0) * Hh * 3600 / E.YEAR)
                Dh = (debt_u[sel] * pxh * gVh).sum(axis=1)
                Pst = (cLT[sel] * pxh * stable).sum(axis=1)
                with np.errstate(divide="ignore", invalid="ignore"):
                    pstar = (Dh - Pst) / cLT[sel, k]
                    kk = pstar / pxh[k] - 1.0
                kX[sel, hj] = kk
                lows = low[b0:b0 + Hh]
                if not np.isfinite(G0) or not np.all(np.isfinite(lows)):
                    continue
                yB[sel, hj] = (lows.min() <= G0 * (1.0 + kk)).astype(np.int8)
        hi_t = np.full(len(users), t_or + 168 * 3600, dtype=np.int64)
        lo_t = np.full(len(users), t_or, dtype=np.int64)
        _, act_first = LB.any_in(act, users, lo_t, hi_t)
        _, liq_first = LB.any_in(lq, users, lo_t, hi_t)
        if dk in hf_days:
            uni = np.nonzero((single >= 0) & np.isfinite(hf0))[0]
            near = np.nonzero((single >= 0) & (hf0 < 1.10))[0]
            for stratum, pool_, n_ in (("uniform", uni, HF_UNI), ("near", near, HF_NEAR)):
                if len(pool_):
                    for i in rng.choice(pool_, size=min(n_, len(pool_)), replace=False).tolist():
                        hf_rows.append({"day": dk, "block": int(h["block"]), "u": int(users[i]), "stratum": stratum,
                                        "hf_model": float(hf0[i]), "emode": int(ems[i])})
        out["day"].append(np.full(len(users), t_or, dtype=np.int64))
        out["u"].append(users.astype(np.int64))
        out["debt"].append(debt_usd.astype(np.float32))
        out["hf0"].append(hf0.astype(np.float32))
        out["act_first"].append(act_first)
        out["liq_first"].append(liq_first)
        out["singleX"].append(single)
        out["kX"].append(kX)
        out["yB"].append(yB)
        out["nvol"].append(nvol.astype(np.int8))
        out["stable_debt"].append(~vold.any(axis=1))
        cnt["rows"] += len(users)
        cnt["single_rows"] += int((single >= 0).sum())
        if d.day == 1:
            print(f"{d} positions {len(users):,} single {int((single >= 0).sum()):,} {time.time() - t_start:.0f}s",
                  flush=True)
        d += dt.timedelta(days=1)
    arr = {k: np.concatenate(v) for k, v in out.items()}
    os.makedirs(a.scr, exist_ok=True)
    np.savez(os.path.join(a.scr, "rows-labels.npz"), symbols=np.array(sym), series=np.array(list(xk)), **arr)
    with open(os.path.join(a.scr, "hf-sample.json"), "w") as f:
        json.dump(hf_rows, f)
    cnt["sec"] = round(time.time() - t_start)
    cnt["hf_sample_rows"] = len(hf_rows)
    with open(os.path.join(a.scr, "labels-counts.json"), "w") as f:
        json.dump(cnt, f, indent=1)
    print(json.dumps(cnt), flush=True)


def cmd_hfcheck(a):
    """Rebuilt 00:00Z HF of sampled label-B universe positions vs getUserAccountData at the same anchor block."""
    import r111v3_acquire as A
    import r111v3_engine as E
    import r111v3_rpc as X
    rows = json.load(open(os.path.join(a.scr, "hf-sample.json")))
    rs = E.jload(os.path.join(a.work, "reserves.json.gz"))
    del rs
    # global user id -> address, rebuilt exactly as Inputs does (token parts in order, then pool parts)
    inp = E.Inputs(a.work)
    uinv = {v: k for k, v in inp.uid.items()}
    del inp
    pool = A.MARKETS["arb"]["pool"]
    cl = X.Client("arbitrum", interval=0.1, calls=True)
    by_blk = {}
    for r in rows:
        by_blk.setdefault(r["block"], []).append(r)
    res_rows = []
    for blk, rr_ in sorted(by_blk.items()):
        calls = [(pool, X.sel("getUserAccountData(address)") + X.enc_addr("0x" + uinv[r["u"]].hex())) for r in rr_]
        outc = X.aggregate3(cl, calls, blk)
        for r, (ok, raw) in zip(rr_, outc):
            hc = X.word(raw, 5) / 1e18 if ok and len(raw) >= 192 else None
            e = abs(r["hf_model"] / hc - 1) if hc and hc > 0 and np.isfinite(r["hf_model"]) else float("inf")
            res_rows.append({"stratum": r["stratum"], "err": e, "emode": r["emode"]})
    out = {"bar": f"uniform stratum: rebuilt HF within {HF_TOL:.1%} of chain HF on >= {HF_SHARE:.0%}; near reported",
           "rpc": cl.stats}
    for s in ("uniform", "near"):
        e = np.array([r["err"] for r in res_rows if r["stratum"] == s])
        fin = e[np.isfinite(e)]
        out[s] = {"n": int(len(e)), "within": int((e <= HF_TOL).sum()),
                  "share_within_0p1pct": rr(np.mean(e <= HF_TOL)) if len(e) else None,
                  "n_infinite": int((~np.isfinite(e)).sum()),
                  "err_q50_q90_q99_max": [float(np.quantile(fin, q)) for q in (0.5, 0.9, 0.99, 1.0)] if len(fin) else None}
    out["pass"] = bool(out["uniform"]["n"] > 0 and out["uniform"]["share_within_0p1pct"] >= HF_SHARE)
    os.makedirs(a.out, exist_ok=True)
    json.dump(out, open(os.path.join(a.out, "r30-hfcheck.json"), "w"), indent=1)
    print(json.dumps(out, indent=1))


# =====================================================================================================================
# score: R0 against the TWAP-touch target (REVIEW Q26-R27) and the Membrane event M (R29), pass table, curve, equal volume
# =====================================================================================================================
def cmd_score(a):
    import r27_atrisk as R
    import r29_timer as T
    t0 = time.time()
    Gz = np.load(os.path.join(a.work, "grids.npz"))
    series = [str(x) for x in Gz["series"]]
    ns = len(series)
    GR = {xi: (int(Gz[f"st{xi}"]), np.asarray(Gz[f"close{xi}"], float), np.asarray(Gz[f"low{xi}"], float))
          for xi in range(ns)}
    E = dict(np.load(os.path.join(a.work, "episodes.npz")))
    C = dict(np.load(os.path.join(a.work, "checks.npz")))
    D = dict(np.load(os.path.join(a.work, "denoms.npz")))
    nep = len(E["x"])
    x = E["x"].astype(int)
    est, tch, rs_, Lx = E["start"], E["touch"], E["reason"], E["L"]
    scored = (est >= R.T_SC) & (est < R.T_HI + DAY)
    pdx, pdd = D["pd_key"] // 10**6, (D["pd_key"] % 10**6) * DAY
    sc_pd = (pdd >= R.T_SC) & (pdd <= R.T_HI)
    PD = float(D["pd_n"][sc_pd].sum())
    BW = PD / 7.0
    ep, c, d = C["ep"].astype(int), C["c"], C["d"]
    # ---- TWAP-touch target exactly as REVIEW Q26-R27 / R29 part C ----
    cf = tch.copy()
    Xc = []
    liq_reason = R.REASONS.index("liq")
    for i in np.nonzero(scored & (rs_ == liq_reason))[0]:
        st, cl, lw = GR[x[i]]
        te = int(E["end"][i])
        bs = (te - st) // HOUR
        if st + bs * HOUR < te and lw[bs] <= Lx[i]:
            cf[i] = st + bs * HOUR
            continue
        c0 = ((te - st + HOUR - 1) // HOUR) * HOUR + st
        for kk_ in range(24):
            cc = c0 + kk_ * HOUR
            b = (cc - st) // HOUR
            if b < 1 or b >= len(cl) or not (np.isfinite(cl[b - 1]) and np.isfinite(lw[b])):
                break
            dd = 1 - Lx[i] / cl[b - 1]
            if dd > 0.10:
                break
            Xc.append((i, cc, dd))
            if lw[b] <= Lx[i]:
                cf[i] = cc
                break
    Xa = np.array(Xc, dtype=float).reshape(-1, 3)
    ep2 = np.r_[ep, Xa[:, 0].astype(int)]
    c2 = np.r_[c, Xa[:, 1].astype(np.int64)]
    d2 = np.r_[d, Xa[:, 2]]
    o = np.lexsort((c2, ep2))
    ep2, c2, d2 = ep2[o], c2[o], d2[o]
    ev_touch = (cf >= 0) & scored
    TM = {v: np.full(nep, -1, np.int64) for v in ("M", "M_noclear")}
    KD = {v: np.zeros(nep, np.int8) for v in ("M", "M_noclear")}
    cens = {v: 0 for v in TM}
    for i in np.nonzero(ev_touch)[0]:
        st, cl, lw = GR[x[i]]
        bT = (int(cf[i]) - st) // HOUR
        for v, clear in (("M", "hourly"), ("M_noclear", "none")):
            mb, kd, ft, _ = T.msim(cl, lw, bT, min(bT + 24, len(cl)), Lx[i], clear=clear)
            assert ft == bT, (i, ft, bT)
            if mb >= 0:
                TM[v][i] = st + (mb + 1) * HOUR
            if kd == -1:
                cens[v] += 1
            KD[v][i] = kd
    targets = {"touch": np.where(ev_touch, cf, -1), "M": TM["M"], "M_noclear": TM["M_noclear"]}
    weeks = np.arange(min(R.week_of(pdd[sc_pd]).min(), R.week_of(est[scored]).min()),
                      max(R.week_of(pdd[sc_pd]).max(), R.week_of(est[scored]).max()) + 1)
    BT = R.Boot(ns, weeks, a.nb)
    Spd = BT.cells(pdx[sc_pd], R.week_of(pdd[sc_pd]), D["pd_n"][sc_pd])
    ewk = R.week_of(est)
    # first alert check per episode at each threshold, from one sort of the checks by d
    first_c = {}

    def first_fire(thr):
        if thr in first_c:
            return first_c[thr]
        aa = np.full(nep, -1, np.int64)
        idx = np.nonzero(d2 <= thr)[0]
        uu, f = np.unique(ep2[idx], return_index=True)
        aa[uu] = c2[idx[f]]
        aa[~scored] = -1
        first_c[thr] = aa
        return aa

    def summary(aa, tm, ci=False):
        evM = (tm >= 0) & scored
        fired = aa >= 0
        hit = fired & evM
        lt = np.where(hit, (cf - aa) // HOUR, -999)
        lm = np.where(hit, (tm - HOUR - aa) / HOUR, np.nan)           # lead to the event-bar OPEN (lower bound)
        early = hit & (lt >= 1)
        false = fired & ~evM
        nE, nA = int(evM.sum()), int(fired.sum())
        r = {"events": nE, "alerts": nA, "early_hits": int(early.sum()), "hits_any": int(hit.sum()),
             "false_alarms": int(false.sum()), "borrower_weeks": rr(BW, 1),
             "recall_lead_ge_1h": rr(early.sum() / nE) if nE else None,
             "recall_any": rr(hit.sum() / nE) if nE else None,
             "precision_lead_ge_1h": rr(early.sum() / nA) if nA else None,
             "fa_per_bw": rr(false.sum() / BW, 5), "alerts_per_1000bw": rr(1000 * nA / BW, 3),
             "lead_to_touch_h_q25_q50_q75_hits": q3(lt[hit].astype(float)),
             "lead_to_touch_h_q25_q50_q75_early_hits": q3(lt[early].astype(float)),
             "lead_to_event_bar_open_h_q25_q50_q75_hits": q3(lm[hit])}
        if ci:
            m = scored
            r["ci_recall_lead_ge_1h"] = BT.ci(BT.cells(x[m], ewk[m], early[m]),
                                              BT.cells(x[evM], ewk[evM], np.ones(nE)))
            r["ci_fa_per_bw"] = BT.ci(7 * BT.cells(x[m], ewk[m], false[m]), Spd)
            r["ci_precision_lead_ge_1h"] = BT.ci(BT.cells(x[m], ewk[m], early[m]), BT.cells(x[m], ewk[m], fired[m]))
        return r

    def passes(r):
        # median lead over early hits (lead to the touch-bar open >= 1 h): the quantity RULING Q26-R27 quotes (8 h)
        med = r["lead_to_touch_h_q25_q50_q75_early_hits"][1] if r["lead_to_touch_h_q25_q50_q75_early_hits"] else None
        crit = {"recall_ge_0.60": bool(r["recall_lead_ge_1h"] is not None and r["recall_lead_ge_1h"] >= PASS_RECALL),
                "fa_le_0.05": bool(r["fa_per_bw"] <= PASS_FA),
                "median_lead_ge_4h": bool(med is not None and med >= PASS_LEAD_H)}
        return {"criteria": crit, "pass": all(crit.values())}

    OUT = {"what": f"Q26 R30 second-chain replication of R0 3 % ({a.chain}); design membrane-board "
                   "design/q26-r30-second-chain-2026-10-25.md", "chain": a.chain,
           "pass_rule": {"threshold": THR, "recall_lead_ge_1h_min": PASS_RECALL, "fa_per_bw_max_point": PASS_FA,
                         "median_lead_to_touch_h_min_early_hits": PASS_LEAD_H, "primary_target": "touch"}}
    tab = {}
    for tg, tm in targets.items():
        r = summary(first_fire(THR), tm, ci=True)
        r.update(passes(r))
        tab[tg] = r
    OUT["pass_table_R0_3pct"] = tab
    OUT["verdict_primary_touch_pass"] = tab["touch"]["pass"]
    if tab["touch"]["events"] < MIN_TOUCH_EVENTS:
        OUT["verdict"] = "not decidable (fewer than %d scored touch events)" % MIN_TOUCH_EVENTS
    else:
        failed = [k for k, v in tab["touch"]["criteria"].items() if not v]
        OUT["verdict"] = "replicates" if not failed else "does not replicate: " + ", ".join(failed)
    OUT["verdict_secondary"] = {tg: tab[tg]["pass"] for tg in ("M", "M_noclear")}
    OUT["curve"] = {tg: {f"R0_{thr * 100:g}%": summary(first_fire(thr), tm) for thr in CURVE_D}
                    for tg, tm in targets.items()}
    fine = {}
    for tg, tm in targets.items():
        rows_ = []
        for thr in FINE_D:
            s_ = summary(first_fire(thr), tm)
            rows_.append([thr, s_["alerts_per_1000bw"], s_["recall_lead_ge_1h"], s_["fa_per_bw"],
                          s_["precision_lead_ge_1h"]])
        fine[tg] = rows_
    OUT["fine_curve_cols"] = ["threshold", "alerts_per_1000bw", "recall_lead_ge_1h", "fa_per_bw",
                              "precision_lead_ge_1h"]
    OUT["fine_curve"] = fine
    # ---- equal realised alert volume against a reference chain (alerts per 1,000 borrower-weeks) ----
    if a.ref:
        ref = json.load(open(a.ref))
        eq = {}
        for tg in targets:
            vol = ref["pass_table_R0_3pct"][tg]["alerts_per_1000bw"]
            F = np.array(fine[tg], float)
            o2 = np.argsort(F[:, 1])
            v_, = (F[o2, 1],)
            if not (v_[0] <= vol <= v_[-1]):
                eq[tg] = {"reference_alerts_per_1000bw": vol, "matched": None, "note": "outside the fine grid"}
                continue

            def at(col):
                return float(np.interp(vol, v_, F[o2, col]))
            thr_eq = at(0)
            s_ = summary(first_fire(round(float(FINE_D[int(np.argmin(np.abs(np.array(FINE_D) - thr_eq)))]), 4)),
                         targets[tg], ci=True)
            eq[tg] = {"reference_chain": ref["chain"], "reference_alerts_per_1000bw": vol,
                      "reference_R0_3pct": {k: ref["pass_table_R0_3pct"][tg][k] for k in
                                            ("recall_lead_ge_1h", "fa_per_bw", "precision_lead_ge_1h",
                                             "lead_to_touch_h_q25_q50_q75_hits", "events", "alerts")},
                      "this_chain_threshold_interp": rr(thr_eq, 5),
                      "this_chain_interp": {"recall_lead_ge_1h": rr(at(2)), "fa_per_bw": rr(at(3), 5),
                                            "precision_lead_ge_1h": rr(at(4))},
                      "this_chain_nearest_grid_point": s_}
        OUT["equal_volume_vs_reference"] = eq
    # ---- validity counts ----
    OUT["validity"] = {
        "episodes_all": int(nep), "episodes_scored": int(scored.sum()),
        "scored_end_reasons": {R.REASONS[k]: int((scored & (rs_ == k)).sum()) for k in range(len(R.REASONS))},
        "twap_touches": int(ev_touch.sum()), "touch_from_liq_continuation": int((ev_touch & (tch < 0)).sum()),
        "continued_checks": int(len(Xa)), "checks": int(len(c)), "position_days_scored": int(PD),
        "M_events": {v: int(((TM[v] >= 0) & scored).sum()) for v in TM},
        "M_censored_touches": cens,
        "M_kind_count": {v: {T.KIND[k]: int((((TM[v] >= 0) & scored) & (KD[v] == k)).sum()) for k in (1, 2, 3)}
                         for v in TM},
        "share_touch_to_M_24h": {v: rr(((TM[v] >= 0) & ev_touch).sum() / max(ev_touch.sum(), 1)) for v in TM},
        "by_series": {series[xi]: {"scored_episodes": int((scored & (x == xi)).sum()),
                                   "touches": int((ev_touch & (x == xi)).sum())} for xi in range(ns)},
        "bootstrap": {"draws": a.nb, "series": ns, "weeks": int(len(weeks)), "seed": R.SEED_BOOT}}
    # halves (descriptive): split at the scored-period midpoint by episode start
    mid = (R.T_SC + R.T_HI) // 2
    halves = {}
    for nm, mk in (("first", est < mid), ("second", est >= mid)):
        aa = first_fire(THR).copy()
        aa[~mk] = -1
        sub_pd = sc_pd & ((pdd < mid) if nm == "first" else (pdd >= mid))
        bw_h = float(D["pd_n"][sub_pd].sum()) / 7.0
        hv = {}
        for tg, tm in targets.items():
            evM = (tm >= 0) & scored & mk
            fired = aa >= 0
            early = fired & evM & ((cf - aa) // HOUR >= 1)
            hv[tg] = {"events": int(evM.sum()), "early_hits": int(early.sum()),
                      "recall_lead_ge_1h": rr(early.sum() / max(evM.sum(), 1)),
                      "false_alarms": int((fired & ~evM).sum()), "fa_per_bw": rr((fired & ~evM).sum() / bw_h, 5)}
        halves[nm] = hv
    OUT["halves_descriptive"] = halves
    OUT["sec"] = round(time.time() - t0)
    os.makedirs(a.out, exist_ok=True)
    fn = os.path.join(a.out, f"r30-{a.chain}.json")
    json.dump(OUT, open(fn, "w"), indent=1, ensure_ascii=False)
    print(json.dumps({k: OUT[k] for k in ("verdict", "verdict_secondary")}, indent=1))
    print(f"done {OUT['sec']}s -> {fn}", flush=True)


def main():
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest="cmd", required=True)
    b = sp.add_parser("labels")
    for k in ("work", "scr", "datasets"):
        b.add_argument(f"--{k}", required=True)
    h = sp.add_parser("hfcheck")
    for k in ("work", "scr", "out"):
        h.add_argument(f"--{k}", required=True)
    s = sp.add_parser("score")
    s.add_argument("--work", required=True)
    s.add_argument("--out", required=True)
    s.add_argument("--chain", required=True)
    s.add_argument("--ref", default=None)
    s.add_argument("--nb", type=int, default=2000)
    a = ap.parse_args()
    {"labels": cmd_labels, "hfcheck": cmd_hfcheck, "score": cmd_score}[a.cmd](a)


if __name__ == "__main__":
    main()
