"""Q26 R13.5r: narrowed revision of R13.5 -- the frozen reg2 decoder on young Gate.io listings, confirm set B14a.

membrane-board design/Q26_ROUND13_PREREG.md (D-R13.5d and later), design/q26-standardization-diagnosis-2026-10-19.md
(sections 5 and 7, "Parent refuting review"), design/q26-retro-twoway-2026-10-19.md (reporting rules),
design/q26-blind-set-inventory-2026-10-17.md (sections 12, 18-21 and the B21 addendum).

Model (frozen, not re-selected): the reg2 decoder of membrane-app 8384eefe (`r16_diag_an.Decoder`, kind "reg2", V0 =
the frozen R13.4 encoder scale): the class-equal pooled library of m0 over the training rows, decoded with
ln lambda_i(z) = c_class + g.x_i + (d_class + q.x_i) t(z), t = (-z - 2) / 2 clipped to [-0.5, 3], x = (vol state,
vol-of-vol, spike share, ln(1 + age), half ln long-run level), standardized on the fit sample. Code is imported from
r16_diag_an unchanged; this file only adds data plumbing, the dev power stage and the one confirm run.

Commands
  dev          development readings on SEEN rows only (rows-r16.npz from `r16_diag.py encode`, identity with
               rows-r134-dev.npz checked at encode time): reg2 and L_all trained without B12 u B9 crypto, scored on
               their young rows (age < 365 days), h 1 and 3 days, k -15%: R, BSS, two-way (series x registered crash
               block) bootstrap z of mean d vs (own), (a), (e) and reg2 vs L_all; centred and percentile p; CR1;
               variance components; leave-top-k concentration. Writes the inputs of the power rule.
  power        projected power by the registered rule (D-R13.5d) at given counts (--series, --pos-blocks) or at the
               registered B14a counts file (--counts).
  select-b21   reserve listing: HitBTC USDT pairs on no used venue list (listing data and the first monthly candle
               time only; prices discarded in code).
  fit          the confirm decoder: reg2 fitted ONCE on every dev row (h 3 primary, h 1 reported); parameters
               written to a JSON (theta, standardization, fills, library log-CDF grid). Identity check: the frozen
               JSON decoder reproduces the fitted decoder's probabilities on dev rows.
  acquire-b14a outcome-blind acquisition of B14a young windows (r135_young.acquire_pair, rules B1-B5 unchanged).
  counts       registered count fields only (D-R13.5d): series, scored rows, weeks, span, positive blocks and blocks
               of the primary cell. No positives, base rate, forecast or score.
  freeze       frozen config (code sha, sha256 of inputs, decoder JSON sha256, constants, seed, UTC time).
  run          the one registered run (refuses unless the frozen config sha256 and code sha match).

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
import re  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402
from datetime import datetime, timezone  # noqa: E402

import numpy as np  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import r134_library as L4  # noqa: E402
import r135_young as Y5  # noqa: E402
import r16_diag as D  # noqa: E402
import r16_diag_an as AN  # noqa: E402

DAY = 86400
YOUNG = 365
H_PRIMARY, H_REPORTED = 3, 1
K = -0.15
COMPS = ("own", "a", "e")
SEED = 20261355
NB = 10000
Z_CRIT = 1.6448536269514722            # Holm 1, one-sided alpha 0.05
TOP_FRAC = 0.025
R_LO, R_HI = 0.8, 1.25
MIN_POS_BLOCKS = 30
SPAN_YEARS = 3.0


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def git_sha():
    return L4.git_sha()


def key_seed(*a):
    return int.from_bytes(hashlib.sha256(":".join(map(str, (SEED,) + a)).encode()).digest()[:4], "little")


# =============================================================================================
# shared statistics
# =============================================================================================
def boot(si, bi, num, den, nb, seed, mode="two"):
    su, s_ = np.unique(si, return_inverse=True)
    bu, b_ = np.unique(bi, return_inverse=True)
    return Y5.boot_twoway(s_, b_, num, den, len(su), len(bu), nb, seed, mode)


def leg_stats(d, si, bid, posb_n, nb, seed, comps_var=True):
    """mean d, two-way bootstrap (centred and percentile p, z), CR1, variance components, leave-top-k."""
    import r12_tail as R12
    one = np.ones(len(d))
    T = float(d.mean())
    bt = boot(si, bid, d, one, nb, seed, "two")
    sd = float(np.std(bt))
    out = {"mean_d": T, "z_two": T / sd if sd > 0 else None, "var_two": sd * sd,
           "p_centred": (1 + int(np.sum(bt - T <= T))) / (nb + 1),
           "p_percentile": (1 + int(np.sum(bt >= 0))) / (nb + 1)}
    cr = R12.cr1_test(bid, d)
    out["p_cr1"] = cr["p_one_sided"]
    out["t_cr1"] = cr["t"]
    if comps_var:
        out["var_block"] = float(np.var(boot(si, bid, d, one, 2000, seed + 1, "block")))
        out["var_series"] = float(np.var(boot(si, bid, d, one, 2000, seed + 2, "series")))
        out["var_iid"] = float(np.var(d) / len(d))
    su, s_ = np.unique(si, return_inverse=True)
    gs = np.bincount(s_, weights=d, minlength=len(su))
    for tag, k in (("frac", max(1, int(math.ceil(TOP_FRAC * len(su))))), ("k5", 5)):
        top = np.argsort(gs)[:k]
        keep = ~np.isin(s_, top)
        out[f"leave_top_{tag}"] = {"k": int(k), "mean_d": float(d[keep].mean()),
                                   "share_of_gain": float(gs[top].sum() / gs.sum()) if gs.sum() < 0 else None}
    out["series_with_gain"] = int(np.sum(gs < 0))
    out["series"] = int(len(su))
    out["pos_blocks"] = int(posb_n)
    out["p_cell_leg"] = float(max(out["p_centred"], out["p_percentile"],
                                  out["p_cr1"] if out["p_cr1"] is not None else 1.0))
    return out


def cell_eval(P, y, sid, day, hh, nb, seed, cands=("reg2", "L_all"), comps_var=True):
    import r12_tail as R12
    ts = (day.astype(np.int64) + 1) * DAY
    bid, G, posb = R12.crash_blocks(ts, sid, y.astype(np.int8), hh * 24)
    su, s_ = np.unique(sid, return_inverse=True)
    e = {"rows": int(len(y)), "series": int(len(su)), "blocks": int(G), "pos_blocks": int(posb.sum()),
         "R": {n_: float(p.sum() / max(y.sum(), 1)) for n_, p in P.items()},
         "brier": {n_: L4.brier(p, y) for n_, p in P.items()}, "legs": {}}
    for c in cands:
        lr = np.log(np.maximum(boot(sid, bid, P[c], y, nb, seed + 11 + len(c), "two"), 1e-12))
        e[f"R_{c}_se_ln_two"] = float(np.std(lr))
        e[f"R_{c}_ci90_two"] = [float(math.exp(np.quantile(lr, 0.05))), float(math.exp(np.quantile(lr, 0.95)))]
    for c in cands:
        for comp in [x for x in COMPS] + (["L_all"] if c == "reg2" else []):
            d = (P[c] - y) ** 2 - (P[comp] - y) ** 2
            st = leg_stats(d, sid, bid, posb.sum(), nb, seed + 100 * len(c) + 7 * len(comp) + ord(comp[0]), comps_var)
            st["bss"] = float(1 - e["brier"][c] / e["brier"][comp]) if e["brier"][comp] > 0 else None
            e["legs"][f"{c}_vs_{comp}"] = st
    return e


# =============================================================================================
# dev (seen rows only)
# =============================================================================================
def own_a_for(R, rows_all, idx, zk_all, Yall):
    """(own) and (a) as-of per series (R13.4 definitions, >= 60 resolved rows) for rows idx, using every row of the
    series in rows_all as history."""
    own = np.full((len(idx), zk_all.shape[1]), np.nan)
    pa = np.full_like(own, np.nan)
    pos = -np.ones(R.n, np.int64)
    pos[idx] = np.arange(len(idx))
    for s in np.unique(R.sid[idx]):
        rr = rows_all[R.sid[rows_all] == s]
        rr = rr[np.argsort(R.day[rr], kind="mergesort")]
        o = L4.own_ecdf_asof(R.day[rr], R.end[rr], R.m0[rr], zk_all[rr])
        f = L4.own_freq_asof(R.day[rr], R.end[rr], Yall[rr].astype(float))
        p = pos[rr]
        m = p >= 0
        own[p[m]] = o[m]
        pa[p[m]] = f[m]
    return own, pa


def cmd_dev(a):
    out = {"created_utc": now_iso(), "code_sha": git_sha(), "rows_sha256": L4.sha256_file(a.rows),
           "note": "development on SEEN rows only: young rows (age < 365) of seen B12 u B9 crypto; reg2 and L_all "
                   "trained without B12 u B9 crypto", "cells": {}}
    for hh in (H_REPORTED, H_PRIMARY):
        R = D.Rows(a.rows, a.meta, hh)
        ids = np.where(np.isin(R.subs, ["b12", "b9"]))[0]
        insc = (R.cls == 0) & np.isin(R.sid, ids)
        tr = ~insc
        young = insc & (R.age < YOUNG)
        idx = np.where(young)[0]
        lv = np.array([K])
        zk_all = np.log1p(lv)[None, :] / np.exp(R.lns0)[:, None]
        Yall = (R.depth[:, None] <= np.log1p(lv)[None, :])
        vcuts = np.quantile(R.vstate[tr], [0.2, 0.4, 0.6, 0.8])
        t0 = time.time()
        dec = AN.Decoder(R, R.m0, tr, "reg2", vcuts)
        p_reg2 = dec.prob(R, idx, zk_all[idx])[:, 0]
        lib = L4.pooled_lib({"cls": R.cls, "m": R.m0}, tr)
        p_lall = L4.wecdf_at(lib, zk_all[idx, 0])
        e_const = float(Yall[tr & (R.cls == 0), 0].mean())
        own, pa = own_a_for(R, np.where(insc)[0], idx, zk_all, Yall)
        ok = np.isfinite(own[:, 0]) & np.isfinite(pa[:, 0])
        y = Yall[idx][ok, 0].astype(float)
        P = {"reg2": np.clip(p_reg2[ok], 0, 1), "L_all": np.clip(p_lall[ok], 0, 1), "own": own[ok, 0],
             "a": pa[ok, 0], "e": np.full(int(ok.sum()), e_const)}
        e = cell_eval(P, y, R.sid[idx][ok], R.day[idx][ok], hh, a.nb, key_seed("dev", hh))
        e["fit_seconds"] = round(time.time() - t0, 1)
        e["reg_info"] = {k: v for k, v in dec.reg_info.items() if k != "theta"}
        e["e_const"] = e_const
        out["cells"][f"h{hh}/{K}"] = e
        lg = e["legs"]
        print(f"{now_iso()} h{hh} k{K}: rows {e['rows']} S {e['series']} posblk {e['pos_blocks']} R reg2 "
              f"{e['R']['reg2']:.3f} L_all {e['R']['L_all']:.3f} | z_two reg2 vs own/a/e " +
              " ".join(f"{lg[f'reg2_vs_{c}']['z_two']:+.2f}" for c in COMPS) + " | L_all " +
              " ".join(f"{lg[f'L_all_vs_{c}']['z_two']:+.2f}" for c in COMPS) +
              f" | reg2 vs L_all {lg['reg2_vs_L_all']['z_two']:+.2f}", flush=True)
        del R
    L4.write_json(a.out, out)
    print(f"sha256 {L4.sha256_file(a.out)}")


# =============================================================================================
# power rule (registered in D-R13.5d)
# =============================================================================================
def project_z(leg, S_dev, G_dev, S_new, G_new):
    """projected two-way z of mean d at (S_new series, G_new positive crash blocks). Two variants, the smaller |z|
    counts: (A) the D-R13.5a design-effect scaling of the block-only variance, (B) variance components (series,
    block, iid) each scaled to the new counts. Also the CR1 t scaled by sqrt(G_new / G_dev)."""
    T = leg["mean_d"]
    if not (T < 0) or G_new <= 0 or S_new <= 0:
        return 0.0, {}
    vb, vs, vi, v2 = leg["var_block"], leg["var_series"], leg["var_iid"], leg["var_two"]
    deff = max(1.0, v2 / vb) if vb > 0 else 1.0
    deff_new = 1.0 + (deff - 1.0) * max(1.0, (S_dev / S_new) / (G_dev / G_new))
    vA = vb * (G_dev / G_new) * deff_new
    vB = max(vs - vi, 0.0) * S_dev / S_new + max(vb - vi, 0.0) * G_dev / G_new + vi * S_dev / S_new
    zA, zB = abs(T) / math.sqrt(vA), abs(T) / math.sqrt(vB)
    zc = abs(leg["t_cr1"]) * math.sqrt(G_new / G_dev) if leg.get("t_cr1") is not None and leg["t_cr1"] < 0 else 0.0
    z = min(zA, zB, zc)
    return z, {"z_A": zA, "z_B": zB, "z_cr1": zc, "deff_new": deff_new}


def power_at(dev_cell, S_new, G_new, cand="reg2", shrink=1.0):
    from scipy.stats import norm
    S_dev, G_dev = dev_cell["series"], dev_cell["pos_blocks"]
    legs, ptest, pconc = {}, 1.0, 1.0
    for c in COMPS:
        lg = dev_cell["legs"][f"{cand}_vs_{c}"]
        z, info = project_z(lg, S_dev, G_dev, S_new, G_new)
        z *= shrink                     # sensitivity only: effect shrunk to `shrink` x the development effect
        pw = float(norm.cdf(z - Z_CRIT)) if z > 0 else 0.0
        lt = lg["leave_top_frac"]["mean_d"]
        pc = float(norm.cdf(z * lt / lg["mean_d"])) if (z > 0 and lt < 0) else 0.0
        legs[c] = {"z_proj": z, **info, "power_test": pw, "power_concentration": pc}
        ptest *= pw
        pconc = min(pconc, pc)
    lnR = math.log(max(dev_cell["R"][cand], 1e-9))
    se = dev_cell[f"R_{cand}_se_ln_two"] * math.sqrt(max(G_dev / max(G_new, 1), S_dev / max(S_new, 1)))
    pR = float(norm.cdf((math.log(R_HI) - lnR) / se) - norm.cdf((math.log(R_LO) - lnR) / se)) if G_new else 0.0
    pblk = 1.0 if G_new >= MIN_POS_BLOCKS else 0.0
    return {"S_new": S_new, "G_new": G_new, "legs": legs, "power_tests_product": ptest,
            "power_concentration_min": pconc, "power_R_band": pR, "power_blocks30": pblk,
            "power_joint_PASS": ptest * pconc * pR * pblk}


def cmd_power(a):
    dev = json.load(open(a.dev))
    out = {"created_utc": now_iso(), "code_sha": git_sha(), "dev_sha256": L4.sha256_file(a.dev), "z_crit": Z_CRIT,
           "targets": {}}
    targets = {}
    if a.counts:
        cnt = json.load(open(a.counts))
        out["counts_sha256"] = L4.sha256_file(a.counts)
        c = cnt["primary"]
        targets["B14a (registered counts)"] = (c["series_scored"], c["pos_blocks"], c["span_years"])
    for s in a.target or []:
        nm, S_, G_ = s.split(":")
        targets[nm] = (int(S_), int(G_), None)
    for nm, (S_, G_, span) in targets.items():
        ent = {}
        for cand in ("reg2", "L_all"):
            for hh in (H_PRIMARY, H_REPORTED):
                ent[f"{cand}/h{hh}"] = power_at(dev["cells"][f"h{hh}/{K}"], S_, G_, cand)
        for sh in (0.75, 0.5):
            ent[f"reg2/h{H_PRIMARY}/shrink{sh}"] = power_at(dev["cells"][f"h{H_PRIMARY}/{K}"], S_, G_, "reg2", sh)
        if span is not None:
            ent["span_years"] = span
            ent["span_ok"] = bool(span >= SPAN_YEARS)
        prim = ent[f"reg2/h{H_PRIMARY}"]["power_joint_PASS"] * (1.0 if ent.get("span_ok", True) else 0.0)
        ent["primary_joint"] = prim
        ent["run"] = bool(prim >= 0.80)
        out["targets"][nm] = ent
        for k_, v in ent.items():
            if isinstance(v, dict):
                print(nm, k_, "S", S_, "G", G_, "z", {c: round(l_["z_proj"], 2) for c, l_ in v["legs"].items()},
                      "tests", round(v["power_tests_product"], 3), "R", round(v["power_R_band"], 3), "conc",
                      round(v["power_concentration_min"], 3), "joint", round(v["power_joint_PASS"], 3))
        print(nm, "primary joint", round(prim, 3), "run", ent["run"])
    L4.write_json(a.out, out)
    print(f"sha256 {L4.sha256_file(a.out)}")


# =============================================================================================
# reserve listing: HitBTC (B21)
# =============================================================================================
HB_SYMBOLS = "https://api.hitbtc.com/api/3/public/symbol"
HB_CANDLE_M1 = "https://api.hitbtc.com/api/3/public/candles/{s}?period=M1&sort=ASC&limit=1"
CB_PRODUCTS = "https://api.exchange.coinbase.com/products"
KR_PAIRS = "https://api.kraken.com/0/public/AssetPairs"
SALT_B21 = "Q26-R13.5r-B21:"
B21_FIRST_MAX = int(datetime(2025, 7, 1, tzinfo=timezone.utc).timestamp())


def hb_first(sym):
    import r125_fh_deep as R125
    try:
        d = json.loads(R125.http_get(HB_CANDLE_M1.format(s=sym)))
    except (Exception, SystemExit):  # noqa: BLE001
        return None
    if not isinstance(d, list) or not d:
        return None
    ts = d[0]["timestamp"]                # prices discarded
    return int(datetime.strptime(ts[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc).timestamp())


def cmd_select_b21(a):
    import concurrent.futures as cf

    import r125_fh_deep as R125
    import r13_recal as R13
    import r14_dr as R14
    raw = R125.http_get(HB_SYMBOLS)
    syms = json.loads(raw)
    b12, kc, b14 = R13.used_lists(a.datasets)
    b15, b17, b9 = R14.other_used(a.datasets)
    b18 = set(json.load(open(os.path.join(a.datasets, "b18-poloniex-prices/selection-b18.json")))["B18"])
    s19 = json.load(open(os.path.join(a.datasets, "b19-lbank-prices/selection-b19.json")))
    b19 = set(s19["B19a"]) | set(s19["B19b"])
    s20 = json.load(open(os.path.join(a.datasets, "b20-xt-bingx-prices/selection-b20.json")))
    b20 = set(s20["B20a"]) | set(s20["B20b"])
    # P5a/P5b (Coinbase Exchange, Kraken; not yet listed): exclude every base listed on either venue
    rcb = R125.http_get(CB_PRODUCTS)
    cb = {str(p["base_currency"]).upper() for p in json.loads(rcb)}
    rkr = R125.http_get(KR_PAIRS)
    kr = set()
    for v in json.loads(rkr)["result"].values():
        ws = str(v.get("wsname") or "")
        if "/" in ws:
            kr.add(ws.split("/")[0].upper())
    p5 = cb | kr | {"XBT", "XDG"}
    bn = set(R125.binance_symbols())
    rec = {"hitbtc_usdt_pairs": 0, "not_working": [], "on_binance": [], "on_kucoin": [], "in_b12": [], "in_b14": [],
           "in_b15": [], "in_b17": [], "in_b18": [], "in_b19": [], "in_b20": [], "in_b9": [], "on_p5_venue": [],
           "excluded": {}, "no_history": [], "late": [], "kept": []}
    cand = {}
    for sym, s in sorted(syms.items()):
        if s.get("type") != "spot" or s.get("quote_currency") != "USDT":
            continue
        rec["hitbtc_usdt_pairs"] += 1
        base = str(s["base_currency"]).upper()
        checks = (("not_working", s.get("status") != "working"), ("on_binance", R125.on_binance(base, bn)),
                  ("on_kucoin", base in kc), ("in_b12", base in b12), ("in_b14", base in b14),
                  ("in_b15", base in b15), ("in_b17", base in b17), ("in_b18", base in b18),
                  ("in_b19", base in b19), ("in_b20", base in b20), ("in_b9", base in b9),
                  ("on_p5_venue", base in p5))
        hit = next((nm for nm, c in checks if c), None)
        if hit:
            rec[hit].append(base)
        elif not re.fullmatch(r"[A-Z0-9]+", base):
            rec["excluded"][base] = "non-alphanumeric ticker"
        elif R125.excluded(base):
            rec["excluded"][base] = R125.excluded(base)
        elif base in cand:
            rec["excluded"][base] = "duplicate base"
        else:
            cand[base] = sym
    first = {}
    with cf.ThreadPoolExecutor(4) as ex:
        for base, t0 in zip(cand, ex.map(hb_first, cand.values())):
            first[base] = t0
    for base in sorted(cand):
        t0 = first[base]
        if t0 is None:
            rec["no_history"].append(base)
        elif t0 >= B21_FIRST_MAX:
            rec["late"].append(base)
        else:
            rec["kept"].append(base)
    elig = sorted(rec["kept"])
    split = {b: ("B21a" if hashlib.sha256((SALT_B21 + b).encode()).digest()[0] % 2 == 0 else "B21b") for b in elig}
    out = {"schema": "q26-r135r-b21-selection-v1", "created_utc": now_iso(), "code_sha": git_sha(),
           "prereg": "membrane-board design/Q26_ROUND13_PREREG.md D-R13.5d",
           "source": "HitBTC public REST api/3 public/symbol (keyless); candles period M1, first candle open time only "
                     "(prices discarded); no hourly or daily candle read",
           "hitbtc_symbols_sha256": hashlib.sha256(raw).hexdigest(), "binance_spot_symbols": len(bn),
           "coinbase_products_sha256": hashlib.sha256(rcb).hexdigest(), "coinbase_bases": len(cb),
           "kraken_pairs_sha256": hashlib.sha256(rkr).hexdigest(), "kraken_bases": len(kr),
           "kucoin_usdt_dirs": len(kc), "b12_assets": len(b12), "b14_assets": len(b14), "b15_assets": len(b15),
           "b17_symbols": len(b17), "b18_assets": len(b18), "b19_assets": len(b19), "b20_assets": len(b20),
           "b9_assets": len(b9), "eligible_first_month_before_utc": "2025-07-01T00:00:00Z", "salt": SALT_B21,
           "eligible": elig, "B21a": sorted(b for b in elig if split[b] == "B21a"),
           "B21b": sorted(b for b in elig if split[b] == "B21b"),
           "first_month_utc": {b: datetime.fromtimestamp(first[b], timezone.utc).strftime("%Y-%m") for b in elig},
           "symbol": {b: cand[b] for b in elig}, **rec}
    os.makedirs(a.out, exist_ok=True)
    p = os.path.join(a.out, "selection-b21.json")
    json.dump(out, open(p, "w"), indent=1)
    print(json.dumps({k: (len(v) if isinstance(v, (list, dict)) else v) for k, v in out.items()
                      if k not in ("first_month_utc", "symbol")}, indent=1))
    for part in ("B21a", "B21b"):
        yrs = {}
        for b in out[part]:
            yrs[out["first_month_utc"][b][:4]] = yrs.get(out["first_month_utc"][b][:4], 0) + 1
        print(part, len(out[part]), dict(sorted(yrs.items())))
    print("sha256", hashlib.sha256(open(p, "rb").read()).hexdigest())


# =============================================================================================
# confirm decoder: fit once, freeze to JSON, reload
# =============================================================================================
class RowsLite:
    """attribute container with the fields Decoder._feats / prob read."""

    def __init__(self, **kw):
        for k, v in kw.items():
            setattr(self, k, v)


def decoder_to_json(dec):
    return {"kind": "reg2", "theta": dec.theta.tolist(), "xm": dec.xm.tolist(), "xs": dec.xs.tolist(),
            "sp_fill": dec.sp_fill.tolist(), "vov_fill": dec.vov_fill.tolist(), "zg": dec.zg.tolist(),
            "lnFg": dec.lnFg.tolist(), "dlnFg": dec.dlnFg.tolist(), "reg_info": {k: v for k, v in dec.reg_info.items()
                                                                                 if k != "theta"},
            "library_rows": int(len(dec.lib[0]))}


def decoder_from_json(j):
    dec = AN.Decoder.__new__(AN.Decoder)
    dec.kind = "reg2"
    dec.theta = np.array(j["theta"])
    dec.xm, dec.xs = np.array(j["xm"]), np.array(j["xs"])
    dec.sp_fill, dec.vov_fill = np.array(j["sp_fill"]), np.array(j["vov_fill"])
    dec.zg, dec.lnFg, dec.dlnFg = np.array(j["zg"]), np.array(j["lnFg"]), np.array(j["dlnFg"])
    nc, k = len(D.CLASSES), 5
    dec._unpack = lambda th: (th[:nc], th[nc:nc + k], th[nc + k:2 * nc + k], th[2 * nc + k:])
    dec._two = True
    return dec


def cmd_fit(a):
    out = {"created_utc": now_iso(), "code_sha": git_sha(), "rows_sha256": L4.sha256_file(a.rows),
           "meta_sha256": L4.sha256_file(a.meta), "r16_diag_an_sha256": L4.sha256_file(AN.__file__),
           "r16_diag_sha256": L4.sha256_file(D.__file__), "training": "every dev row (D.Rows filter), V0 scale",
           "decoders": {}, "identity": {}}
    for hh in (H_PRIMARY, H_REPORTED):
        R = D.Rows(a.rows, a.meta, hh)
        tr = np.ones(R.n, bool)
        vcuts = np.quantile(R.vstate[tr], [0.2, 0.4, 0.6, 0.8])
        dec = AN.Decoder(R, R.m0, tr, "reg2", vcuts)
        j = decoder_to_json(dec)
        out["decoders"][str(hh)] = j
        # identity: JSON decoder vs fitted decoder on a sample of dev crypto rows
        idx = np.where(R.cls == 0)[0][::97]
        zt = np.log1p(np.array([K]))[None, :] / np.exp(R.lns0[idx])[:, None]
        p1 = dec.prob(R, idx, zt)
        p2 = decoder_from_json(json.loads(json.dumps(j))).prob(R, idx, zt)
        out["identity"][str(hh)] = {"rows": int(len(idx)), "max_abs_diff": float(np.max(np.abs(p1 - p2)))}
        print(f"{now_iso()} h{hh}: fitted reg2 on {R.n} rows; nll {dec.reg_info['nll']:.5f} iters "
              f"{dec.reg_info['iters']}; JSON identity max |dp| {out['identity'][str(hh)]['max_abs_diff']:.2e}",
              flush=True)
        del R
    L4.write_json(a.out, out)
    print(f"sha256 {L4.sha256_file(a.out)}")


# =============================================================================================
# B14a: outcome-blind acquisition, encoding, counts
# =============================================================================================
def cmd_acquire_b14a(a):
    sel = json.load(open(a.selection))
    bs = dict(sel["buy_start"])
    os.makedirs(a.out, exist_ok=True)
    manp = os.path.join(a.out, "manifest-b14a.json")
    man = json.load(open(manp)) if os.path.exists(manp) else {"created_utc": now_iso(), "code_sha": git_sha(),
                                                                "set": "B14a", "rules": "r135_young.py B1-B5",
                                                                "series": {}}
    for base in sel["B14a"]:
        if base in man["series"]:
            continue
        got, files = Y5.acquire_pair(base, bs[base])
        ent = {"buy_start": bs[base], "files": files}
        if got is None:
            ent["status"] = "no trade file found"
            man["series"][base] = ent
            L4.write_json(manp, man)
            print(f"{now_iso()} {base}: no trade file", flush=True)
            continue
        H = got["H"]
        Dd = Y5.day_bars_from_hours(H)
        fn = os.path.join(a.out, f"gate-{base}_USDT-bars.npz")
        np.savez_compressed(fn, h_t=H["t"], h_o=H["o"], h_h=H["h"], h_l=H["l"], h_c=H["c"], h_n=H["n"], h_v=H["v"],
                            d_t=Dd["t"], d_o=Dd["o"], d_h=Dd["h"], d_l=Dd["l"], d_c=Dd["c"], d_n=Dd["n"],
                            d_v=Dd["v"], d_ah=Dd["ah"], first_day=got["first_day"], last_day=got["last_day"])
        span_h = (got["last_day"] - got["first_day"] + 1) * 24
        ent.update(status="ok", file=os.path.basename(fn), sha256=L4.sha256_file(fn), first_day=got["first_day"],
                   last_day=got["last_day"], traded_hours=int(len(H["t"])), null_hours=int(span_h - len(H["t"])),
                   traded_days=int(len(Dd["t"])), trades=int(H["n"].sum()))
        man["series"][base] = ent
        L4.write_json(manp, man)
        print(f"{now_iso()} {base}: months {len(files)}, traded days {ent['traded_days']}, null hours "
              f"{ent['null_hours']}", flush=True)
    man["finished_utc"] = now_iso()
    L4.write_json(manp, man)
    print(f"sha256 manifest {L4.sha256_file(manp)}")


def load_set(d, manifest, sub):
    man = json.load(open(os.path.join(d, manifest)))
    out = []
    for base, v in sorted(man["series"].items()):
        if v.get("status") != "ok":
            continue
        z = np.load(os.path.join(d, v["file"]))
        Dd = {k: z[f"d_{k}"] for k in ("t", "o", "h", "l", "c", "n", "v", "ah")}
        B = Y5.daily_grid(Dd, int(z["last_day"]))
        B.update(key=f"gate:{base}", cls="crypto", sub=sub, asset=base)
        out.append(B)
    return out, man


def encode_gate(series, beta, hh):
    """young rows (age < 365 from the first traded day) at horizon hh with the frozen R13.4 encoder (Gate rules B4/B5)
    and the reg2 covariates computed exactly as r16_diag.extra_inputs / r134 encode_inputs (bars <= t only)."""
    cols = {k: [] for k in ("sid", "day", "end", "age", "q2", "depth", "lns0", "vstate", "vov", "spike", "lnLR")}
    for sid, s in enumerate(series):
        E = Y5.encode_inputs_gate(s)
        X = D.extra_inputs(s)
        with np.errstate(all="ignore"):
            lns1 = 0.5 * (E["X"] @ beta[1])
        age = np.arange(len(s["d"]))
        F = E["fwd"][hh]
        ok = F["ok"] & (age < YOUNG) & np.isfinite(X["lnLR"]) & np.isfinite(lns1)
        if not ok.any():
            continue
        with np.errstate(all="ignore"):
            cols["lns0"].append(0.5 * (E["X"][ok] @ beta[hh]) + 0.5 * math.log(hh))
            cols["depth"].append(np.log(F["wmin"][ok]) - E["lc"][ok])
        cols["sid"].append(np.full(int(ok.sum()), sid, np.int32))
        cols["day"].append(s["d"][ok].astype(np.int32))
        cols["end"].append(F["end_day"][ok].astype(np.int32))
        cols["age"].append(age[ok].astype(np.int32))
        cols["q2"].append(L4.q2_overlap(s["d"][ok], F["end_day"][ok]))
        cols["vstate"].append((lns1 - 0.5 * X["lnLR"])[ok])
        cols["vov"].append(E["vov"][ok])
        cols["spike"].append(X["spike"][ok])
        cols["lnLR"].append(X["lnLR"][ok])
    R = {k: np.concatenate(v) for k, v in cols.items()}
    keep = ~R["q2"]
    R = {k: v[keep] for k, v in R.items()}
    R["cls"] = np.zeros(len(R["day"]), np.int8)
    R["m0"] = R["depth"] / np.exp(R["lns0"])
    R["n"] = len(R["day"])
    return R


def own_a_gate(R, zk, Y):
    """(own) and (a) as-of per series on the young rows (R13.4 definitions, >= 60 resolved rows)."""
    own = np.full(zk.shape, np.nan)
    pa = np.full(zk.shape, np.nan)
    for s_ in np.unique(R["sid"]):
        ii = np.where(R["sid"] == s_)[0]
        ii = ii[np.argsort(R["day"][ii], kind="mergesort")]
        own[ii] = L4.own_ecdf_asof(R["day"][ii], R["end"][ii], R["m0"][ii], zk[ii])
        pa[ii] = L4.own_freq_asof(R["day"][ii], R["end"][ii], Y[ii])
    return own, pa


def scored_mask(R):
    """rows with >= 60 resolved own rows (a count rule; no outcome used)."""
    nres = np.zeros(R["n"], np.int64)
    for s_ in np.unique(R["sid"]):
        ii = np.where(R["sid"] == s_)[0]
        ed = np.sort(R["end"][ii])
        nres[ii] = np.searchsorted(ed, R["day"][ii], side="left")
    return nres >= L4.OWN_MIN


def cmd_counts(a):
    """registered count fields only (D-R13.5d): no positives, base rates, forecast or score are written or printed."""
    import r12_tail as R12
    beta = {int(k): np.array(v) for k, v in json.load(open(a.meta))["beta"].items()}
    series, man = load_set(a.data, "manifest-b14a.json", "B14a")
    R = encode_gate(series, beta, H_PRIMARY)
    sc = scored_mask(R)
    wk_ = L4.week_of(R["day"][sc])
    y = (R["depth"][sc] <= math.log1p(K)).astype(np.int8)
    ts = (R["day"][sc].astype(np.int64) + 1) * DAY
    bid, G, posb = R12.crash_blocks(ts, R["sid"][sc], y, H_PRIMARY * 24)
    out = {"created_utc": now_iso(), "code_sha": git_sha(), "note": "registered count fields only (D-R13.5d)",
           "series_listed": len(man["series"]), "series_ok": len(series),
           "primary": {"cell": f"h{H_PRIMARY}/{K}", "rows_scored": int(sc.sum()),
                       "series_scored": int(len(np.unique(R["sid"][sc]))), "weeks": int(len(np.unique(wk_))),
                       "span_years": float((wk_.max() - wk_.min() + 1) / 52.18), "pos_blocks": int(posb.sum()),
                       "blocks": int(G)}}
    del y
    L4.write_json(a.out, out)
    print(json.dumps(out, indent=1))
    print(f"sha256 {L4.sha256_file(a.out)}")


# =============================================================================================
# freeze and the one run
# =============================================================================================
def frozen_lall_e(rows_path, hh):
    """L_all (R13.4 / R13.5 definition: every dev row of every class, ~2026Q2, class-equal) and (e) (crypto dev
    frequency at k) from rows-r134-dev.npz."""
    z = np.load(rows_path)
    R = {"cls": z[f"h{hh}_cls"], "m": z[f"h{hh}_m"], "s": z[f"h{hh}_s"], "q2": z[f"h{hh}_q2"]}
    keep = ~R["q2"]
    La = L4.pooled_lib(R, keep, classes=list(L4.CLASSES))
    isc = (R["cls"] == 0) & keep
    e = float(np.mean(R["m"][isc] <= math.log1p(K) / R["s"][isc]))
    return La, e


def cmd_freeze(a):
    fit = json.load(open(a.fit))
    e = {str(hh): frozen_lall_e(a.r134rows, hh)[1] for hh in (H_PRIMARY, H_REPORTED)}
    fz = {"created_utc": now_iso(), "code_sha": git_sha(), "item": "Q26 R13.5r (D-R13.5d)",
          "code_sha256": L4.sha256_file(os.path.abspath(__file__)),
          "r16_diag_an_sha256": L4.sha256_file(AN.__file__), "r16_diag_sha256": L4.sha256_file(D.__file__),
          "r135_young_sha256": L4.sha256_file(Y5.__file__), "r134_sha256": L4.sha256_file(L4.__file__),
          "fit_json_sha256": L4.sha256_file(a.fit), "fit_rows_sha256": fit["rows_sha256"],
          "r134_rows_sha256": L4.sha256_file(a.r134rows), "meta_sha256": L4.sha256_file(a.meta),
          "dev_sha256": L4.sha256_file(a.dev), "counts_sha256": L4.sha256_file(a.counts),
          "power_sha256": L4.sha256_file(a.power),
          "b14a_manifest_sha256": L4.sha256_file(os.path.join(a.data, "manifest-b14a.json")),
          "e_const": e, "seed": SEED, "bootstrap_draws": NB, "k": K, "h_primary": H_PRIMARY, "h_reported": H_REPORTED,
          "young_days": YOUNG, "own_min": L4.OWN_MIN, "z_crit": Z_CRIT, "top_frac": TOP_FRAC, "R_band": [R_LO, R_HI],
          "min_pos_blocks": MIN_POS_BLOCKS,
          "pass": "primary cell h3 -15%: mean d(reg2) < 0 vs own, a, e; cell p = max over own, a, e of (two-way "
                  "centred p, two-way percentile p, CR1 p) <= 0.05 (Holm 1); R(reg2) in 0.8-1.25; >= 30 positive "
                  "crash blocks; leave-top-ceil(2.5% S)-series mean d < 0 vs own, a, e",
          "secondary": "L_all (R13.4 frozen) vs own, a, e and reg2 vs L_all at h3 -15% (reported, not a gate)",
          "reported": "h1 -15% (reg2 and L_all), per-year R, top-k shares, CI of R"}
    L4.write_json(a.out, fz)
    print(f"sha256 {L4.sha256_file(a.out)}")


def cmd_run(a):
    fsha = L4.sha256_file(a.frozen)
    if fsha != a.frozen_sha256:
        raise SystemExit(f"frozen config sha256 {fsha} != registered {a.frozen_sha256}")
    fz = json.load(open(a.frozen))
    if git_sha() != fz["code_sha"] or L4.sha256_file(os.path.abspath(__file__)) != fz["code_sha256"]:
        raise SystemExit("code differs from the frozen config")
    for p_, k_ in ((a.fit, "fit_json_sha256"), (a.r134rows, "r134_rows_sha256"), (a.meta, "meta_sha256"),
                   (os.path.join(a.data, "manifest-b14a.json"), "b14a_manifest_sha256")):
        if L4.sha256_file(p_) != fz[k_]:
            raise SystemExit(f"{p_} differs from the frozen config")
    t0 = now_iso()
    print(f"{t0} R13.5r run start; code {fz['code_sha']}; frozen {fsha}", flush=True)
    fit = json.load(open(a.fit))
    beta = {int(k): np.array(v) for k, v in json.load(open(a.meta))["beta"].items()}
    series, man = load_set(a.data, "manifest-b14a.json", "B14a")
    res = {"created_utc": t0, "code_sha": fz["code_sha"], "frozen_sha256": fsha, "cells": {}}
    for hh in (H_PRIMARY, H_REPORTED):
        La, e_const = frozen_lall_e(a.r134rows, hh)
        assert abs(e_const - fz["e_const"][str(hh)]) < 1e-15
        dec = decoder_from_json(fit["decoders"][str(hh)])
        R = encode_gate(series, beta, hh)
        zk = (math.log1p(K) / np.exp(R["lns0"]))[:, None]
        Y = (R["depth"][:, None] <= math.log1p(K)).astype(float)
        Rl = RowsLite(cls=R["cls"], spike=R["spike"].astype(np.float32), vov=R["vov"].astype(np.float32),
                      vstate=R["vstate"].astype(np.float64), age=R["age"], lnLR=R["lnLR"].astype(np.float32))
        p_reg2 = dec.prob(Rl, np.arange(R["n"]), zk)[:, 0]
        p_lall = L4.wecdf_at(La, zk[:, 0])
        own, pa = own_a_gate(R, zk, Y)
        sc = np.isfinite(own[:, 0]) & np.isfinite(pa[:, 0])
        y = Y[sc, 0]
        P = {"reg2": np.clip(p_reg2[sc], 0, 1), "L_all": np.clip(p_lall[sc], 0, 1), "own": own[sc, 0],
             "a": pa[sc, 0], "e": np.full(int(sc.sum()), e_const)}
        e = cell_eval(P, y, R["sid"][sc], R["day"][sc], hh, NB, key_seed("run", hh), comps_var=False)
        yr = (R["day"][sc].astype(np.int64) // 365.2425 + 1970).astype(int)
        e["R_by_year"] = {}
        for yy in np.unique(yr):
            mk = yr == yy
            if y[mk].sum() > 0:
                e["R_by_year"][str(int(yy))] = {"R_reg2": float(P["reg2"][mk].sum() / y[mk].sum()),
                                                "R_L_all": float(P["L_all"][mk].sum() / y[mk].sum()),
                                                "pos": int(y[mk].sum()), "rows": int(mk.sum())}
        e["pos"] = int(y.sum())
        key = f"h{hh}/{K}"
        if hh == H_PRIMARY:
            lg = e["legs"]
            p_cell = max(lg[f"reg2_vs_{c}"]["p_cell_leg"] for c in COMPS)
            g = {"mean_d_lt0_all3": all(lg[f"reg2_vs_{c}"]["mean_d"] < 0 for c in COMPS),
                 "p_cell_le_0.05": bool(p_cell <= 0.05),
                 "R_band": bool(R_LO <= e["R"]["reg2"] <= R_HI), "blocks30": e["pos_blocks"] >= MIN_POS_BLOCKS,
                 "concentration": all(lg[f"reg2_vs_{c}"]["leave_top_frac"]["mean_d"] < 0 for c in COMPS)}
            e["p_cell"] = p_cell
            e["gates"] = g
            e["PASS"] = bool(all(g.values()))
        res["cells"][key] = e
        lg = e["legs"]
        print(f"{now_iso()} {key}: rows {e['rows']} S {e['series']} pos {e['pos']} posblk {e['pos_blocks']} R reg2 "
              f"{e['R']['reg2']:.3f} L_all {e['R']['L_all']:.3f} | " + " ".join(
                  f"{nm}: bss {v['bss']:+.4f} z {v['z_two']:+.2f} p {v['p_cell_leg']:.4f}" for nm, v in lg.items()),
              flush=True)
    res["verdict"] = {"primary_PASS": res["cells"][f"h{H_PRIMARY}/{K}"]["PASS"],
                      "gates": res["cells"][f"h{H_PRIMARY}/{K}"]["gates"]}
    res["finished_utc"] = now_iso()
    L4.write_json(a.out, res)
    print(f"{res['finished_utc']} R13.5r run end; primary PASS {res['verdict']['primary_PASS']}; "
          f"sha256 {L4.sha256_file(a.out)}")


# =============================================================================================
def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("dev")
    p.add_argument("--rows", required=True)
    p.add_argument("--meta", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--nb", type=int, default=NB)
    p = sub.add_parser("power")
    p.add_argument("--dev", required=True)
    p.add_argument("--counts", default="")
    p.add_argument("--target", action="append", help="name:S:G")
    p.add_argument("--out", required=True)
    p = sub.add_parser("select-b21")
    p.add_argument("--datasets", default="/home/user/membrane-datasets")
    p.add_argument("--out", required=True)
    p = sub.add_parser("fit")
    for x in ("rows", "meta", "out"):
        p.add_argument(f"--{x}", required=True)
    p = sub.add_parser("acquire-b14a")
    p.add_argument("--selection", required=True)
    p.add_argument("--out", required=True)
    p = sub.add_parser("counts")
    for x in ("data", "meta", "out"):
        p.add_argument(f"--{x}", required=True)
    p = sub.add_parser("freeze")
    for x in ("fit", "r134rows", "meta", "dev", "counts", "power", "data", "out"):
        p.add_argument(f"--{x}", required=True)
    p = sub.add_parser("run")
    for x in ("fit", "r134rows", "meta", "data", "frozen", "frozen-sha256", "out"):
        p.add_argument(f"--{x}", required=True)
    a = ap.parse_args()
    {"dev": cmd_dev, "power": cmd_power, "select-b21": cmd_select_b21, "fit": cmd_fit, "acquire-b14a": cmd_acquire_b14a,
     "counts": cmd_counts, "freeze": cmd_freeze, "run": cmd_run}[a.cmd](a)


if __name__ == "__main__":
    main()
