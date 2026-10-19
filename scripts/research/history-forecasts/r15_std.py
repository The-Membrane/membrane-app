"""Q26 Round 15: standardization programme -- pool events in abstract (vol-scaled) space, model there, decode with the
target's ex-ante state and a per-class tail scale.

membrane-board design/Q26_ROUND15_PREREG.md (items R15.1-R15.4, Deviations D-R15.*), design/q26-blind-set-inventory-
2026-10-17.md (section 18: R15 reservations). Parents: design/Q26_ROUND13_PREREG.md (R13.1, R13.4, D-R13.4b-c),
design/Q26_ROUND14_PREREG.md (D-R14.1d, D-R14.2c rules), design/Q26_ROUND12_PREREG.md (R12.7, R12.9).

Owner goal (2026-10-19, relayed by the Q26 parent): "We should be testing standardization for everything possible
because event count will make our models better."

Subcommands (each is a fixed recipe; menus are chosen on development data only)
  select-b19   LBank venue-unique USDT pairs (listing data and the first monthly candle's open time only; prices are
               discarded in code). Split by sha256('Q26-R15-B19:' + base): first byte even -> B19a, odd -> B19b.
  dev1         R15.1 development on the R13.4 dev rows (deep cells, mature thin-tail rows; daily encoder).
  dev3         R15.3 development on the R12.9 dev split and the seen B17a (route-median oracle alert).
  dev2         R15.2 development on the R13.1 development pool (shallow cells; pooled-shape (fH) + the R13.1 map).
  counts1/3    counts-only checks of a reserved set (positives, blocks, series; no forecast, no score).
  power        power at the counts (D-R14.2c rules: every gate, joint power for PASS).
  freeze/run   only after the run Deviation.

Free data only. No address, key or secret is read or written.
"""
from __future__ import annotations

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import hashlib  # noqa: E402
import json  # noqa: E402
import math  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402
from datetime import datetime, timezone  # noqa: E402

import numpy as np  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

PREREG = {"repo": "triccs/membrane-board", "path": "design/Q26_ROUND15_PREREG.md", "items": "R15.1-R15.4",
          "deviations": "D-R15.*"}
DAY = 86400


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha256b(b):
    return hashlib.sha256(b).hexdigest()


def sha_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def git_sha():
    try:
        import subprocess
        return subprocess.check_output(["git", "-C", HERE, "rev-parse", "--short=8", "HEAD"]).decode().strip()
    except Exception:  # noqa: BLE001
        return "unknown"


def write_json(path, obj):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w") as f:
        json.dump(obj, f, indent=1, sort_keys=True)


# =============================================================================================
# B19: LBank venue-unique USDT pairs (reservation; listing data only)
# =============================================================================================
LB_PAIRS = "https://api.lbkex.com/v2/currencyPairs.do"
LB_K = "https://api.lbkex.com/v2/kline.do?symbol={s}&size={n}&type={t}&time={a}"
B19_FIRST_MAX = int(datetime(2025, 7, 1, tzinfo=timezone.utc).timestamp())
SALT_B19 = "Q26-R15-B19:"


def lbank_first_month(sym):
    """open time (UTC seconds) of the first monthly candle from 2017-01-01; prices are discarded in code."""
    import r125_fh_deep as R125
    raw = R125.http_get(LB_K.format(s=sym, n=2, t="month1", a=1483228800))
    d = json.loads(raw)
    if d.get("result") != "true" or not d.get("data"):
        return None
    return int(d["data"][0][0])


def cmd_select_b19(a):
    import concurrent.futures as cf

    import r125_fh_deep as R125
    import r13_recal as R13
    import r14_dr as R14
    raw = R125.http_get(LB_PAIRS)
    pairs = json.loads(raw)["data"]
    b12, kc, b14 = R13.used_lists(a.datasets)
    b15, b17, b9 = R14.other_used(a.datasets)
    s18 = json.load(open(os.path.join(a.datasets, "b18-poloniex-prices/selection-b18.json")))
    b18 = set(s18["B18"])
    bn = set(R125.binance_symbols())
    rec = {"lbank_usdt_pairs": 0, "on_binance": [], "on_kucoin": [], "in_b12": [], "in_b14": [], "in_b15": [],
           "in_b17": [], "in_b18": [], "in_b9": [], "excluded": {}, "no_history": [], "late": [], "kept": []}
    cand = {}
    for p in sorted(pairs):
        if not p.endswith("_usdt"):
            continue
        rec["lbank_usdt_pairs"] += 1
        base = p[:-5].upper()
        if R125.on_binance(base, bn):
            rec["on_binance"].append(base)
        elif base in kc:
            rec["on_kucoin"].append(base)
        elif base in b12:
            rec["in_b12"].append(base)
        elif base in b14:
            rec["in_b14"].append(base)
        elif base in b15:
            rec["in_b15"].append(base)
        elif base in b17:
            rec["in_b17"].append(base)
        elif base in b18:
            rec["in_b18"].append(base)
        elif base in b9:
            rec["in_b9"].append(base)
        elif R125.excluded(base):
            rec["excluded"][base] = R125.excluded(base)
        else:
            cand[base] = p
    first = {}
    with cf.ThreadPoolExecutor(8) as ex:
        for base, t0 in zip(cand, ex.map(lbank_first_month, cand.values())):
            first[base] = t0
    for base in sorted(cand):
        t0 = first[base]
        if t0 is None:
            rec["no_history"].append(base)
        elif t0 >= B19_FIRST_MAX:
            rec["late"].append(base)
        else:
            rec["kept"].append(base)
    elig = sorted(rec["kept"])
    split = {b: ("B19a" if hashlib.sha256((SALT_B19 + b).encode()).digest()[0] % 2 == 0 else "B19b") for b in elig}
    out = {"schema": "q26-r15-b19-selection-v1", "created_utc": now_iso(), "code_sha": git_sha(), "prereg": PREREG,
           "source": "LBank public REST v2 currencyPairs.do (keyless); kline.do month1 first open time only "
                     "(prices discarded); hourly candles not read",
           "lbank_pairs_sha256": sha256b(raw), "binance_spot_symbols": len(bn),
           "binance_list_sha256": sha256b("\n".join(sorted(bn)).encode()), "kucoin_usdt_dirs": len(kc),
           "b12_assets": len(b12), "b14_assets": len(b14), "b15_assets": len(b15), "b17_symbols": len(b17),
           "b18_assets": len(b18), "b9_assets": len(b9), "eligible_first_month_before_utc": "2025-07-01T00:00:00Z",
           "salt": SALT_B19, "eligible": elig,
           "B19a": sorted(b for b in elig if split[b] == "B19a"), "B19b": sorted(b for b in elig if split[b] == "B19b"),
           "first_month_utc": {b: datetime.fromtimestamp(first[b], timezone.utc).strftime("%Y-%m") for b in elig},
           "symbol": {b: cand[b] for b in elig}, **rec}
    os.makedirs(a.out, exist_ok=True)
    p = os.path.join(a.out, "selection-b19.json")
    json.dump(out, open(p, "w"), indent=1)
    print(json.dumps({k: (len(v) if isinstance(v, (list, dict)) else v) for k, v in out.items()
                      if k not in ("first_month_utc", "symbol")}, indent=1))
    yrs = {}
    for b in elig:
        yrs[out["first_month_utc"][b][:4]] = yrs.get(out["first_month_utc"][b][:4], 0) + 1
    print("first-month years", dict(sorted(yrs.items())))
    print("sha256", sha_file(p))



# =============================================================================================
# shared statistics (D-R14.2c rules): two-way bootstrap, block sums, concentration, power legs
# =============================================================================================
def twoway_stats(ts, sid, y, P, cand, comps, T_hours, nb, seed, blocks="crash", top_frac=0.025, top_min=3):
    """development statistics of candidate `cand` vs each comparator on rows (ts, sid, y). blocks: 'crash' (R12
    crash-episode blocks, 4-week cap) or 'week' (calendar weeks, Monday 00:00Z)."""
    import r12_tail as R12
    import r135_young as Y5
    if blocks == "crash":
        bid, G, posb = R12.crash_blocks(ts, sid, y.astype(np.int8), T_hours)
    else:
        wk = (np.asarray(ts, np.int64) + 3 * DAY) // (7 * DAY)
        u, bid = np.unique(wk, return_inverse=True)
        G = len(u)
        posb = np.bincount(bid, weights=y, minlength=G) > 0
    su, si = np.unique(sid, return_inverse=True)
    S = len(su)
    e = {"rows": int(len(y)), "pos": int(y.sum()), "series": int(S), "blocks": int(G), "pos_blocks": int(posb.sum()),
         "R": {}, "brier": {}, "vs": {}}
    for n_, p in P.items():
        e["R"][n_] = float(p.sum() / max(y.sum(), 1))
        e["brier"][n_] = float(np.mean((p - y) ** 2))
    pL = P[cand]
    if y.sum() > 0:
        lr = np.log(np.maximum(Y5.boot_twoway(si, bid, pL, y, S, G, nb, seed), 1e-12))
        e["se_lnR_two"] = float(np.std(lr))
    one = np.ones(len(y))
    k = max(top_min, int(math.ceil(top_frac * S)))
    for j, c in enumerate(comps):
        d = (pL - y) ** 2 - (P[c] - y) ** 2
        sums = np.bincount(bid, weights=d, minlength=G)
        sp = sums[posb]
        m_b = float(sp.mean()) if len(sp) else float("nan")
        s_b = float(sp.std(ddof=1)) if len(sp) > 1 else float("nan")
        draws = Y5.boot_twoway(si, bid, d, one, S, G, nb, seed + 10 * j + 1, "two")
        v2 = float(np.var(draws))
        vb = float(np.var(Y5.boot_twoway(si, bid, d, one, S, G, nb, seed + 10 * j + 2, "block")))
        gs = np.bincount(si, weights=d, minlength=S)
        top = np.argsort(gs)[:k]
        keep = ~np.isin(si, top)
        sums_lo = np.bincount(bid[keep], weights=d[keep], minlength=G)[posb]
        md = float(d.mean())
        e["vs"][c] = {"bss": float(1 - e["brier"][cand] / e["brier"][c]) if e["brier"][c] > 0 else None,
                      "mean_d": md, "p_two_one_sided": float((1 + np.sum(draws - md <= md)) / (nb + 1)),
                      "m_b": m_b, "s_b": s_b, "var_two": v2, "var_block": vb,
                      "deff": float(v2 / vb) if vb > 0 else None, "top_k": k,
                      "top_share_of_gain": float(gs[top].sum() / gs.sum()) if gs.sum() < 0 else None,
                      "mean_d_leave_top": float(d[keep].mean()) if keep.any() else None,
                      "m_b_leave_top": float(sums_lo.mean()) if len(sums_lo) else None,
                      "series_with_gain": int(np.sum(gs < 0))}
    return e


def power_cell(e, cand, comps, G_new, S_new, z, need_blocks=30, R_band=(0.8, 1.25)):
    """D-R13.5a power rule generalised: per comparator leg, R band, concentration, blocks; joint = product."""
    from scipy.stats import norm
    Gd, Sd = e["pos_blocks"], e["series"]
    legs = {}
    for c in comps:
        v = e["vs"][c]
        if not (v["m_b"] < 0) or G_new <= 0 or not np.isfinite(v["s_b"]) or v["s_b"] <= 0:
            legs[c] = {"power_test": 0.0, "power_concentration": 0.0, "deff_new": None, "Gstar_80": None}
            continue
        deff = max(1.0, 1.0 + ((v["deff"] or 1.0) - 1.0) * max(1.0, (Sd / max(S_new, 1)) / (Gd / G_new)))
        pw = float(norm.cdf(math.sqrt(G_new / deff) * abs(v["m_b"]) / v["s_b"] - z))
        lo = v.get("m_b_leave_top")
        pc = float(norm.cdf(math.sqrt(G_new / deff) * abs(lo) / v["s_b"])) if (lo is not None and lo < 0) else 0.0
        legs[c] = {"power_test": pw, "power_concentration": pc, "deff_new": deff,
                   "Gstar_80": float(((z + 0.8416) * v["s_b"] / v["m_b"]) ** 2 * deff)}
    R = e["R"][cand]
    if G_new and e.get("se_lnR_two") and R > 0:
        se = e["se_lnR_two"] * math.sqrt(Gd / G_new)
        pR = float(norm.cdf((math.log(R_band[1]) - math.log(R)) / se) - norm.cdf((math.log(R_band[0]) - math.log(R)) / se))
    else:
        pR = 0.0
    pblk = 1.0 if G_new >= need_blocks else 0.0
    ptest = float(np.prod([l_["power_test"] for l_ in legs.values()]))
    pconc = min(l_["power_concentration"] for l_ in legs.values()) if legs else 0.0
    return {"G_new": G_new, "S_new": S_new, "legs": legs, "power_R_band": pR, "R_dev": R, "power_blocks": pblk,
            "power_all_tests_product": ptest, "power_concentration_min": pconc,
            "power_joint_PASS": ptest * pR * pconc * pblk}


M_UNION = 21                     # R15 rule 5: confirmatory cells of the full registered union (6 + 6 + 9)


def z_holm_union():
    from scipy.stats import norm
    return float(norm.ppf(1 - 0.05 / M_UNION))


# =============================================================================================
# R15.1 development: deep cells on mature thin-tail rows, pooled all-class library with class tail scale
# =============================================================================================
R151_H = (1, 3)
R151_LEVELS = (-0.10, -0.15, -0.20)
R151_AGE = 730
R151_THIN = 10
R151_MENU = [("lam1", None), ("lamc", None), ("lamc", 1000.0), ("lamc", 250.0), ("lam1", 1000.0), ("lam1", 250.0)]
SALT_R151 = "Q26-R15.1-dev:"
SEED_R151 = 2026151


def menu_name(dec, tau):
    return f"{dec}_tau{'inf' if tau is None else int(tau)}"


def r151_predict(R, sc, zk, lib_all, lam_c, e_const, E, N):
    """forecasts on rows sc (one class): every menu entry, (own), (a) is filled by the caller, (e)."""
    J = zk.shape[1]
    P = {}
    F1 = np.stack([L4().wecdf_at(lib_all, zk[sc, j]) for j in range(J)], 1)
    Fc = np.stack([L4().wecdf_at(lib_all, zk[sc, j] / lam_c) for j in range(J)], 1)
    for dec, tau in R151_MENU:
        F = F1 if dec == "lam1" else Fc
        P[menu_name(dec, tau)] = F if tau is None else (E + tau * F) / (N[:, None] + tau)
    P["e"] = np.tile(e_const, (len(sc), 1))
    with np.errstate(all="ignore"):
        P["own"] = np.where(N[:, None] >= 60, E / np.maximum(N[:, None], 1), np.nan)
    return P


def L4():
    import r134_library as _L4
    return _L4


def cmd_dev1(a):
    import r135_young as Y5
    t0 = now_iso()
    meta = json.load(open(a.meta))["series"]
    keys = np.array([m_["key"] for m_ in meta])
    clsn = np.array([m_["cls"] for m_ in meta])
    half = np.array([hashlib.sha256((SALT_R151 + k_).encode()).digest()[0] % 2 for k_ in keys])
    classes = L4().CLASSES
    FH = np.load(a.fh) if a.fh else None
    out = {"schema": "q26-r151-dev-v1", "prereg": PREREG, "created_utc": t0, "code_sha": git_sha(),
           "rows_sha256": sha_file(a.rows), "meta_sha256": sha_file(a.meta),
           "fh_sha256": sha_file(a.fh) if a.fh else None,
           "note": "development on SEEN R13.4 dev rows only (r134 dev cad651e9); half split within class; library "
                   "without the scored half; thin rows = age >= 730 bars and own E(z_k) < 10",
           "lambda": {}, "cells": {}, "selection": {}, "eth": {}}
    pooled = {}         # (h) -> dict of arrays over scored thin rows
    for hh in R151_H:
        R = Y5.load_rows(a.rows, hh)
        keep = ~R["q2"]
        zk = np.stack([np.log(1 + k) / R["s"] for k in R151_LEVELS], 1)
        Yall = (R["m"][:, None] <= zk).astype(float)
        cols = {k_: [] for k_ in ("sid", "ts", "cls", "y", "thin", "eth")}
        Pcols = {}
        for ci, c in enumerate(classes):
            for hv in (0, 1):
                ids = np.where((clsn == c) & (half == hv))[0]
                if len(ids) == 0:
                    continue
                insc = np.isin(R["sid"], ids)
                libmask = keep & ~insc
                lib_all = L4().pooled_lib(R, libmask, classes=list(classes))
                lib_c = L4().pooled_lib(R, libmask, classes=[c])
                lam = Y5.fit_lambda(lib_c, lib_all) if lib_c is not None else 1.0
                out["lambda"][f"h{hh}/{c}/half{hv}"] = lam
                mat_lib = libmask & (R["cls"] == ci) & (R["age"] >= R151_AGE)
                e_const = Yall[mat_lib].mean(axis=0) if mat_lib.any() else Yall[libmask & (R["cls"] == ci)].mean(0)
                sc = np.where(insc & keep)[0]
                if len(sc) == 0:
                    continue
                E = np.zeros((len(sc), len(R151_LEVELS)))
                N = np.zeros(len(sc))
                pa = np.full((len(sc), len(R151_LEVELS)), np.nan)
                sids = R["sid"][sc]
                # own counts use every own resolved row (including 2026Q2-free rows of the series only)
                for s_ in np.unique(sids):
                    ii = np.where(sids == s_)[0]
                    allr = np.where((R["sid"] == s_) & keep)[0]
                    Eo, No = own_counts_asof_split(R["day"][sc[ii]], R["day"][allr], R["end"][allr],
                                                   R["m"][allr], zk[sc[ii]])
                    E[ii], N[ii] = Eo, No
                    o = np.argsort(R["day"][allr], kind="mergesort")
                    rr = allr[o]
                    pa_all = L4().own_freq_asof(R["day"][rr], R["end"][rr], Yall[rr])
                    pos = {d_: i_ for i_, d_ in enumerate(R["day"][rr].tolist())}
                    pa[ii] = pa_all[[pos[d_] for d_ in R["day"][sc[ii]].tolist()]]
                P = r151_predict(R, sc, zk, lib_all, lam, e_const, E, N)
                P["a"] = pa
                mature = R["age"][sc] >= R151_AGE
                ok_own = np.isfinite(P["own"][:, 0]) & np.isfinite(pa[:, 0])
                base = mature & ok_own
                cols["sid"].append(R["sid"][sc][base])
                cols["ts"].append((R["day"][sc][base].astype(np.int64) + 1) * DAY)
                cols["cls"].append(np.full(int(base.sum()), ci, np.int8))
                cols["y"].append(Yall[sc][base])
                cols["thin"].append(E[base] < R151_THIN)
                cols["eth"].append(keys[R["sid"][sc][base]] == "dev:ETH")
                for n_, v in P.items():
                    Pcols.setdefault(n_, []).append(v[base])
                print(f"{now_iso()} R15.1 dev h{hh} {c} half{hv}: lambda {lam:.2f}, mature scored rows "
                      f"{int(base.sum())}, thin rows per k {[int((E[base][:, j] < R151_THIN).sum()) for j in range(3)]}",
                      flush=True)
        D = {k_: np.concatenate(v) for k_, v in cols.items()}
        PP = {k_: np.concatenate(v) for k_, v in Pcols.items()}
        # (fH) for crypto rows where the cached hourly (fH) exists (b12, b9, ETH; reported only)
        pfh = np.full(PP["e"].shape, np.nan)
        if FH is not None:
            T = 24 * hh
            fk = FH[f"T{T}_key"]
            lut = {(k_, int(t_) // DAY): i_ for i_, (k_, t_) in enumerate(zip(fk.tolist(), FH[f"T{T}_ts"].tolist()))}
            di = [-0.15, -0.20, -0.25, -0.30, -0.40]
            for i_ in np.where(D["cls"] == 0)[0]:
                h_ = lut.get((keys[D["sid"][i_]], int(D["ts"][i_]) // DAY))
                if h_ is not None:
                    for j, k in enumerate(R151_LEVELS):
                        if k in di:
                            pfh[i_, j] = FH[f"T{T}_pH"][h_, di.index(k)]
        PP["fH"] = pfh
        pooled[hh] = (D, PP)
        del R
    # ---------------- per cell statistics on thin rows ----------------
    menu = [menu_name(d_, t_) for d_, t_ in R151_MENU]
    comps = ["own", "a", "e"]
    zU = z_holm_union()
    sel_rows = {}
    for hh in R151_H:
        D, PP = pooled[hh]
        for j, k in enumerate(R151_LEVELS):
            thin = D["thin"][:, j]
            for grp, gm in (("all", np.ones(len(thin), bool)), ("noncrypto", D["cls"] != 0),
                            ("equity", D["cls"] == classes.index("equity")), ("crypto", D["cls"] == 0)):
                m_ = thin & gm
                if m_.sum() < 500 or D["y"][m_, j].sum() < 5:
                    continue
                Pc = {n_: np.clip(PP[n_][m_, j], 0, 1) for n_ in menu + comps}
                y = D["y"][m_, j]
                st = {}
                for cand in menu:
                    st[cand] = twoway_stats(D["ts"][m_], D["sid"][m_], y, Pc, cand, comps, 24 * hh,
                                            a.nb if (grp == "equity" or cand == menu[0]) else 500,
                                            SEED_R151 + 100 * hh + 10 * j)
                out["cells"][f"h{hh}/{k}/{grp}"] = st
                if grp in ("noncrypto", "crypto"):
                    for cand in menu:
                        sel_rows.setdefault(cand, []).append((grp, hh, k, st[cand]["vs"]["own"]["bss"]))
                print(f"  h{hh} k{k} {grp}: thin rows {int(m_.sum())} pos {int(y.sum())} posblk "
                      f"{st[menu[0]]['pos_blocks']} S {st[menu[0]]['series']} | " +
                      " ".join(f"{cand}: R {st[cand]['R'][cand]:.2f} bss own/a/e "
                               + "/".join(f"{st[cand]['vs'][c]['bss']:+.4f}" for c in comps) for cand in menu[:4]),
                      flush=True)
            # ETH (descriptive)
            me = thin & D["eth"]
            if me.any():
                y = D["y"][me, j]
                out["eth"][f"h{hh}/{k}"] = {"thin_rows": int(me.sum()), "pos": int(y.sum()),
                                            "R": {n_: float(np.nansum(PP[n_][me, j]) / max(y.sum(), 1))
                                                  for n_ in menu + comps + ["fH"]},
                                            "brier": {n_: float(np.nanmean((PP[n_][me, j] - y) ** 2))
                                                      for n_ in menu + comps + ["fH"]},
                                            "fH_rows": int(np.isfinite(PP["fH"][me, j]).sum())}
    # ---------------- registered selection: mean BSS vs (own) over 6 cells x {noncrypto, crypto} ----------------
    scores = {c_: float(np.mean([r_[3] for r_ in v])) for c_, v in sel_rows.items()}
    se = {c_: float(np.std([r_[3] for r_ in v], ddof=1) / math.sqrt(len(v))) for c_, v in sel_rows.items()}
    best = max(scores, key=scores.get)
    choice = next(c_ for c_ in menu if scores[c_] >= scores[best] - se[best])
    out["selection"] = {"criterion": "mean BSS vs (own) over 6 cells x {noncrypto, crypto} thin rows",
                        "scores": scores, "se": se, "best": best, "choice": choice,
                        "rule": "simplest within one SE of the best (menu order)"}
    print("selection", json.dumps(out["selection"]), flush=True)
    out["z_holm_union"] = zU
    out["utc_end"] = now_iso()
    write_json(os.path.join(a.out, "dev-r151.json"), out)
    print("sha256", sha_file(os.path.join(a.out, "dev-r151.json")))


def own_counts_asof_split(day_q, day_all, end_all, m_all, zq):
    """as own_counts_asof, with query origins (day_q, zq) separate from the series' resolved rows."""
    n = len(day_q)
    E = np.zeros(zq.shape)
    N = np.zeros(n)
    for a0 in range(0, n, 1024):
        a1 = min(n, a0 + 1024)
        res = end_all[None, :] < day_q[a0:a1, None]
        N[a0:a1] = res.sum(axis=1)
        for kk in range(zq.shape[1]):
            E[a0:a1, kk] = (res & (m_all[None, :] <= zq[a0:a1, kk][:, None])).sum(axis=1)
    return E, N

# =============================================================================================
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("select-b19")
    s.add_argument("--datasets", default="/home/user/membrane-datasets")
    s.add_argument("--out", required=True)
    s = sub.add_parser("dev1")
    s.add_argument("--rows", default="/home/user/r13work/r134/dev-cad651e9/rows-r134-dev.npz")
    s.add_argument("--meta", default="/home/user/r13work/r134/dev-cad651e9/meta-r134-dev.json")
    s.add_argument("--fh", default="/home/user/r13work/r134/fh/fh-r134.npz")
    s.add_argument("--nb", type=int, default=10000)
    s.add_argument("--out", required=True)
    a = ap.parse_args()
    {"select-b19": cmd_select_b19, "dev1": cmd_dev1}[a.cmd](a)


if __name__ == "__main__":
    main()
