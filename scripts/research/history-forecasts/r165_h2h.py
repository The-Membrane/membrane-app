"""Q26 Round 16 item R16.5: deep altcoin head-to-head of (fH) vs the R13.1 map vs the frozen R14.1 DR on B18.

membrane-board design/Q26_ROUND16_PREREG.md section R16.5 (registration, D-R16.5a ...),
design/q26-closed-path-audit-2026-10-19.md (parent refuting review), design/Q26_ROUND14_PREREG.md (R14.1, D-R14.1d),
design/Q26_ROUND13_PREREG.md (R13.1, D-R13.5c), design/q26-retro-twoway-2026-10-19.md,
design/q26-blind-set-inventory-2026-10-17.md (B18 confirm, B22 reserve).

Models are FROZEN and are not refitted here:
  (fH)   A6/R12 code path (r14_dr.row_task).
  R13.1  frozen map from frozen-r141-config.json block "r131" (= frozen-r131-config.json ea0f7a39..., W 90, kappa 50,
         c_mp), applied with r13_recal.recal exactly as r14_dr.forecasts_of.
  DR     DR_d1_k50_W180_f10 from frozen-r141-config.json (ccca13d2...), applied with r14_dr.dr_apply.
Development check sets B12 and B13a use the leave-one-set-out maps of the R13.1 and R14.1 development runs (the frozen
maps were fitted on them); spent sets B15a and B15b use the frozen maps.

Commands
  select-b22  WhiteBIT USDT spot pairs on no used venue list (listing only, no candle): the R16.5 reserve set.
  kat         known-answer scorer tests on synthetic data (no market data).
  rows        development rows (B12, B13a, B15a, B15b) at 12 h and 1 d: frozen forecasts, sigma-hat state, first-touch
              day per deep level. Scratch only (npz).
  repro       reproduce the R14.1 B15b registered numbers (R, top-quintile R, BSS, MCB, DSC) from the rows.
  dev         development statistics and projected power per candidate (cell, comparison); cell choice rule.
  acquire-b18 outcome-blind B18 builder (Poloniex HOUR_1 candles via q26cache, owner R16.5). Prints hour counts only.
  complete    bar-completeness check (B18 structure only; seen-pair HOUR_1 vs DAY_1 reconciliation).
  counts      counts-only check on B18: the registered fields only.
  power       projected joint power at the B18 counts; run decision.
  freeze      frozen config (code sha, input sha256 values, choices, seed, created_utc).
  run         one run on B18 from the frozen config.

Statistic conventions (fixed in the registration):
  d = (p1 - y)^2 - (p0 - y)^2 per row; BSS(1 vs 0) = 1 - sum e1 / sum e0. R = sum p / sum y.
  Smooth calibration legs (intersection-union; no abs value): a = ln R0 - ln R1 > 0, b = ln R0 + ln R1 > 0, both for
  the whole cell and for the top quintile (each forecast's own top 20%).
  Two-way bootstrap: series and crash-episode blocks resampled independently, row weight = product (pigeonhole),
  computed on (series, block) cell sums. Centred p = (1 + #{s* - s >= s}) / (B + 1); percentile p = (1 + #{s* <= 0})
  / (B + 1) (direction H1: s > 0). CGM two-way z beside.
No address, key or secret is read or written.
"""
from __future__ import annotations

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import gzip  # noqa: E402
import hashlib  # noqa: E402
import inspect  # noqa: E402
import json  # noqa: E402
import math  # noqa: E402
import re  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402
from datetime import datetime, timezone  # noqa: E402

import numpy as np  # noqa: E402
from scipy.stats import norm  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import r112_combine as R112  # noqa: E402
import r125_fh_deep as R125  # noqa: E402
import r12_tail as R12  # noqa: E402
import r13_recal as R13  # noqa: E402
import r14_dr as D  # noqa: E402

STEP = R12.STEP
DAY = 86400
TL = R12.TL
HS = (12, 24)
LEV = (-0.20, -0.25, -0.30, -0.40)
CI = [D.DLEV.index(k) for k in LEV]                       # columns inside the r14_dr DLEV forecasts
CAND_CELLS = [(T, k) for T in HS for k in LEV]            # 8 candidate cells
COMPS = (("DR", "fH"), ("R13.1", "fH"), ("DR", "R13.1"))  # candidate comparisons (model 1 vs model 0)
MODELS = ("fH", "R13.1", "DR")
SEED = 20261650
NB_DEV = 2000
NB_RUN = 10000
ALPHA = 0.05
RBAND = (0.8, 1.25)
STATE_WIN_H = 8760                                         # sigma-hat state: ln sH - trailing 365-day mean of ln sH
EVT_MIN_SERIES = 5
EVT_MIN_SHARE = 0.10
FROZEN_R141 = "history-forecasts/r14/r141-run-b90111b2/frozen-r141-config.json"
RESULTS_R141 = "history-forecasts/r14/r141-run-b90111b2/results-r141.json"
DEV_R141 = "history-forecasts/r14/r141-dev-b90111b2/dev-r141.json"
DEV_R131 = "history-forecasts/r13/r131-dev-c3f36695/dev-r131.json"
WB_MARKETS = "https://whitebit.com/api/v4/public/markets"
CDC_INSTR = "https://api.crypto.com/exchange/v1/public/get-instruments"
BG_SYMBOLS = "https://api.bitget.com/api/v2/spot/public/symbols"
B22_DERIV = {"BGSOL"}                                     # Bitget staked SOL (not in the R12.5 DERIV list)
B22_FIRST_MAX_MS = 1751328000000                           # Bitget openTime before 2025-07-01 (when given)
CB_PRODUCTS = "https://api.exchange.coinbase.com/products"
KR_PAIRS = "https://api.kraken.com/0/public/AssetPairs"
POLO_K = "https://api.poloniex.com/markets/{s}/candles?interval={i}&startTime={a}&endTime={b}&limit=500"
ACQ_END = R13.ACQ_END


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha_file(p):
    return R112.sha256_file(p)


def logger(path):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    f = open(path, "a")

    def log(s):
        line = f"{now_iso()} {s}"
        print(line, flush=True)
        f.write(line + "\n")
        f.flush()
    return log


# =============================================================================================
# B22 reserve (listing only)
# =============================================================================================
def cmd_select_b22(a):
    raw = R125.http_get(WB_MARKETS)
    mk = json.loads(raw)
    b12, kc, b14 = R13.used_lists(a.datasets)
    b15, b17, b9 = D.other_used(a.datasets)
    sel = lambda p: json.load(open(os.path.join(a.datasets, p)))  # noqa: E731
    b18 = set(sel("b18-poloniex-prices/selection-b18.json")["B18"])
    s19 = sel("b19-lbank-prices/selection-b19.json")
    b19 = set(s19["B19a"]) | set(s19["B19b"])
    s20 = sel("b20-xt-bingx-prices/selection-b20.json")
    b20 = set(s20["B20a"]) | set(s20["B20b"])
    s21 = sel("b21-hitbtc-prices/selection-b21.json")
    b21 = set(s21["B21a"]) | set(s21["B21b"])
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
    rec = {"whitebit_usdt_spot_pairs": 0, "not_trading": [], "on_binance": [], "on_kucoin": [], "in_b12": [],
           "in_b14": [], "in_b15": [], "in_b17": [], "in_b18": [], "in_b19": [], "in_b20": [], "in_b21": [],
           "in_b9": [], "on_p5_venue": [], "excluded": {}, "kept": []}
    sym = {}
    rcdc = R125.http_get(CDC_INSTR)
    cdc = json.loads(rcdc)["result"]["data"]
    venue = {}
    rec["cryptocom_usdt_spot_pairs"] = 0
    rbg = R125.http_get(BG_SYMBOLS)
    bg = json.loads(rbg)["data"]
    rec["bitget_usdt_spot_pairs"] = 0
    rec["late"] = []
    items = [("bitget", str(m["baseCoin"]).upper(), m["symbol"], m.get("status") == "online",
              int(m.get("openTime") or 0)) for m in sorted(bg, key=lambda x: x["symbol"])
             if m.get("quoteCoin") == "USDT"]
    items += [("whitebit", str(m["stock"]).upper(), m["name"],
              bool(m.get("tradesEnabled")) and m.get("delistedAt") is None, 0)
             for m in sorted(mk, key=lambda x: x["name"]) if m.get("type") == "spot" and m.get("money") == "USDT"]
    items += [("cryptocom", str(m["base_ccy"]).upper(), m["symbol"], bool(m.get("tradable", True)), 0)
              for m in sorted(cdc, key=lambda x: x["symbol"])
              if m.get("inst_type") == "CCY_PAIR" and m.get("quote_ccy") == "USDT"]
    for ven, base, name, trading, open_ms in items:
        rec[f"{ven}_usdt_spot_pairs"] += 1
        m = {"name": name}
        if base in sym:
            rec["excluded"][base + "@" + ven] = f"also on {venue[base]} (kept there)"
            continue
        if open_ms >= B22_FIRST_MAX_MS:
            rec["late"].append(base + "@" + ven)
            continue
        checks = (("not_trading", not trading),
                  ("on_binance", R125.on_binance(base, bn)), ("on_kucoin", base in kc), ("in_b12", base in b12),
                  ("in_b14", base in b14), ("in_b15", base in b15), ("in_b17", base in b17), ("in_b18", base in b18),
                  ("in_b19", base in b19), ("in_b20", base in b20), ("in_b21", base in b21), ("in_b9", base in b9),
                  ("on_p5_venue", base in p5))
        hit = next((nm for nm, c in checks if c), None)
        if hit:
            rec[hit].append(base)
        elif not re.fullmatch(r"[A-Z0-9]+", base):
            rec["excluded"][base] = "non-alphanumeric ticker"
        elif R125.excluded(base):
            rec["excluded"][base] = R125.excluded(base)
        elif base in B22_DERIV:
            rec["excluded"][base] = "wrapped/staked derivative"
        elif base in sym:
            rec["excluded"][base] = "duplicate base"
        else:
            sym[base] = m["name"]
            venue[base] = ven
            rec["kept"].append(base)
    elig = sorted(rec["kept"])
    out = {"schema": "q26-r165-b22-selection-v1", "created_utc": now_iso(), "code_sha": R112.git_sha(),
           "prereg": "membrane-board design/Q26_ROUND16_PREREG.md R16.5",
           "source": "Bitget public REST api/v2/spot/public/symbols (openTime), WhiteBIT api/v4/public/markets and "
                     "Crypto.com Exchange public/get-instruments (keyless); venue precedence Bitget, WhiteBIT, "
                     "Crypto.com; no candle read",
           "bitget_symbols_sha256": hashlib.sha256(rbg).hexdigest(),
           "whitebit_markets_sha256": hashlib.sha256(raw).hexdigest(),
           "cryptocom_instruments_sha256": hashlib.sha256(rcdc).hexdigest(), "binance_spot_symbols": len(bn),
           "coinbase_products_sha256": hashlib.sha256(rcb).hexdigest(), "coinbase_bases": len(cb),
           "kraken_pairs_sha256": hashlib.sha256(rkr).hexdigest(), "kraken_bases": len(kr),
           "kucoin_usdt_dirs": len(kc), "b12_assets": len(b12), "b14_assets": len(b14), "b15_assets": len(b15),
           "b17_symbols": len(b17), "b18_assets": len(b18), "b19_assets": len(b19), "b20_assets": len(b20),
           "b21_assets": len(b21), "b9_assets": len(b9), "eligible": elig, "B22": elig,
           "symbol": {b: sym[b] for b in elig}, "venue": {b: venue[b] for b in elig}, **rec}
    os.makedirs(a.out, exist_ok=True)
    p = os.path.join(a.out, "selection-b22.json")
    json.dump(out, open(p, "w"), indent=1)
    print(json.dumps({k: (len(v) if isinstance(v, (list, dict)) else v) for k, v in out.items()
                      if k not in ("symbol", "venue")}, indent=1))
    print("by venue", {v: sum(1 for b in elig if venue[b] == v) for v in ("bitget", "whitebit", "cryptocom")})
    print("sha256", sha_file(p))


# =============================================================================================
# scorer: two-way pigeonhole bootstrap on (series, block) cell sums, CGM, legs, leave-top-k, LOEO
# =============================================================================================
QN = ("e1", "e0", "p1", "p0", "y", "p1t", "y1t", "p0t", "y0t")


def cell_sums(sid, g, G, y, p1, p0):
    t1 = R13.quint_masks(p1)[0]
    t0 = R13.quint_masks(p0)[0]
    nS = int(sid.max()) + 1
    cell = sid.astype(np.int64) * G + g
    uc, inv = np.unique(cell, return_inverse=True)
    vals = ((p1 - y) ** 2, (p0 - y) ** 2, p1, p0, y, p1 * t1, y * t1, p0 * t0, y * t0)
    X = np.stack([np.bincount(inv, v, len(uc)) for v in vals])
    return {"X": X, "cs": (uc // G).astype(np.int64), "cb": (uc % G).astype(np.int64), "nS": nS, "G": int(G)}


def stats_of(Z):
    """Z: (9, ...) sums -> dict of statistics (vectorised over trailing axes)."""
    with np.errstate(all="ignore"):
        R1, R0 = Z[2] / Z[4], Z[3] / Z[4]
        Rt1, Rt0 = Z[5] / Z[6], Z[7] / Z[8]
        return {"bss": 1 - Z[0] / Z[1], "a": np.log(R0) - np.log(R1), "b": np.log(R0) + np.log(R1),
                "at": np.log(Rt0) - np.log(Rt1), "bt": np.log(Rt0) + np.log(Rt1), "lnR1": np.log(R1),
                "lnR0": np.log(R0)}


def boot_weights(cs_n, G, nb, seed):
    rng = np.random.default_rng(np.random.SeedSequence([SEED, seed]))
    ws = np.stack([np.bincount(rng.integers(0, cs_n, cs_n), minlength=cs_n) for _ in range(nb)]).astype(float)
    wb = np.stack([np.bincount(rng.integers(0, G, G), minlength=G) for _ in range(nb)]).astype(float)
    return ws, wb


def twoway(cs, nb, seed, W=None):
    X, s_, b_ = cs["X"], cs["cs"], cs["cb"]
    ws, wb = W if W is not None else boot_weights(cs["nS"], cs["G"], nb, seed)
    Zs = np.empty((X.shape[0], ws.shape[0]))
    for j0 in range(0, ws.shape[0], 500):
        w = ws[j0:j0 + 500][:, s_] * wb[j0:j0 + 500][:, b_]
        Zs[:, j0:j0 + 500] = X @ w.T
    return stats_of(X.sum(1)), stats_of(Zs)


def pvals(obs, bs):
    """one-sided H1: stat > 0. Returns centred p, percentile p, bootstrap z."""
    x = bs[np.isfinite(bs)]
    if not np.isfinite(obs) or len(x) < 10:
        return {"obs": float(obs), "p_centred": 1.0, "p_pct": 1.0, "z": float("nan"), "sd": float("nan")}
    sd = float(np.std(x))
    return {"obs": float(obs), "p_centred": float((1 + np.sum(x - obs >= obs)) / (len(x) + 1)),
            "p_pct": float((1 + np.sum(x <= 0)) / (len(x) + 1)), "z": float(obs / sd) if sd > 0 else float("nan"),
            "sd": sd, "q05": float(np.quantile(x, 0.05)), "q95": float(np.quantile(x, 0.95))}


def cgm_components(sid, g, G, y, p1, p0):
    """influence-function cluster sums for BSS (series, block, cell): V_s, V_b, V_int (CGM = V_s + V_b - V_int)."""
    e1, e0 = (p1 - y) ** 2, (p0 - y) ** 2
    psi = -(e1 - (e1.sum() / e0.sum()) * e0) / e0.sum()
    nS = int(sid.max()) + 1
    cell = sid.astype(np.int64) * G + g
    vs = float((np.bincount(sid, psi, nS) ** 2).sum())
    vb = float((np.bincount(g, psi, G) ** 2).sum())
    _, inv = np.unique(cell, return_inverse=True)
    vi = float((np.bincount(inv, psi) ** 2).sum())
    return {"V_s": vs, "V_b": vb, "V_int": vi, "cgm_se": math.sqrt(max(vs + vb - vi, 1e-300))}


def pos_counts(sid, g, y):
    """registered count fields of one cell: positive series, positive blocks, positive (series, block) cells."""
    m = y > 0
    return {"positive_series": int(len(np.unique(sid[m]))), "positive_blocks": int(len(np.unique(g[m]))),
            "positive_cells": int(len(np.unique(sid[m].astype(np.int64) * (int(g.max()) + 1) + g[m])))}


def leave_top_k(sid, y, p1, p0):
    S = int(len(np.unique(sid)))
    k = max(3, math.ceil(0.025 * S))
    d = (p1 - y) ** 2 - (p0 - y) ** 2
    nS = int(sid.max()) + 1
    gain = -np.bincount(sid, d, nS)
    top = np.argsort(-gain)[:k]
    keep = ~np.isin(sid, top)
    tot = gain.sum()
    return {"k": k, "series": S, "mean_d_keep": float(d[keep].mean()), "bss_keep": float(
        1 - ((p1[keep] - y[keep]) ** 2).sum() / ((p0[keep] - y[keep]) ** 2).sum()),
        "top_k_share": float(gain[top].sum() / tot) if tot > 0 else None, "keep_mask": keep}


def event_days(ts, sid, y, tday, T):
    """market-wide single-day events of one cell: UTC days D on which >= max(5, 10% of the series with an origin on
    D) distinct series first touch the level. Returns list sorted by positive rows touching on D (desc)."""
    m = (y > 0) & (tday >= 0)
    if not m.any():
        return []
    oday = ts // DAY
    act = {}
    for dd, s in set(zip(oday.tolist(), sid.tolist())):
        act[dd] = act.get(dd, 0) + 1
    tp, sp = tday[m], sid[m]
    ev = []
    for dd in np.unique(tp):
        mm = tp == dd
        ns = len(np.unique(sp[mm]))
        if ns >= max(EVT_MIN_SERIES, EVT_MIN_SHARE * act.get(int(dd), 0)):
            ev.append({"day": int(dd), "utc": datetime.fromtimestamp(int(dd) * DAY, timezone.utc).strftime("%Y-%m-%d"),
                       "series": int(ns), "active_series": int(act.get(int(dd), 0)), "pos_rows": int(mm.sum())})
    return sorted(ev, key=lambda e: -e["pos_rows"])


def drop_day_mask(ts, T, day):
    """rows whose window (t, t + T] meets UTC day [day, day + 1)."""
    lo, hi = day * DAY, (day + 1) * DAY
    return ~((ts < hi) & (ts + T * STEP > lo))


def comparison(ts, sid, y, tday, st_t, T, p1, p0, nb, seed, full=True):
    """all registered statistics of one (cell, comparison)."""
    g, G, posb = R12.crash_blocks(ts, sid, y, T)
    cs = cell_sums(sid, g, G, y, p1, p0)
    W = boot_weights(cs["nS"], cs["G"], nb, seed)
    obs, bs = twoway(cs, nb, seed, W)
    out = {"rows": int(len(y)), "pos": int(y.sum()), "blocks": int(G), **pos_counts(sid, g, y),
           "series_with_origins": int(len(np.unique(sid))),
           "R1": float(p1.sum() / y.sum()), "R0": float(p0.sum() / y.sum())}
    t1 = R13.quint_masks(p1)[0]
    t0 = R13.quint_masks(p0)[0]
    out["R1_top20"] = float((p1 * t1).sum() / (y * t1).sum()) if (y * t1).sum() else None
    out["R0_top20"] = float((p0 * t0).sum() / (y * t0).sum()) if (y * t0).sum() else None
    for k_ in ("bss", "a", "b", "at", "bt"):
        out[k_] = pvals(obs[k_], bs[k_])
    lo_, hi_ = math.log(RBAND[0]), math.log(RBAND[1])
    x = bs["lnR1"][np.isfinite(bs["lnR1"])]
    out["R1_ci90"] = [float(np.exp(np.quantile(x, 0.05))), float(np.exp(np.quantile(x, 0.95)))]
    out["R1_band_tost_p"] = float(max((1 + np.sum(x - obs["lnR1"] <= lo_ - obs["lnR1"])) / (len(x) + 1),
                                      (1 + np.sum(x - obs["lnR1"] >= hi_ - obs["lnR1"])) / (len(x) + 1)))
    out["lnR1_sd"] = float(np.std(x))
    out["cgm"] = cgm_components(sid, g, G, y, p1, p0)
    out["cgm"]["z"] = float(obs["bss"] / out["cgm"]["cgm_se"])
    lt = leave_top_k(sid, y, p1, p0)
    keep = lt.pop("keep_mask")
    if keep.sum() and y[keep].sum():
        g2, G2, _ = R12.crash_blocks(ts[keep], sid[keep], y[keep], T)
        o2, b2 = twoway(cell_sums(sid[keep], g2, G2, y[keep], p1[keep], p0[keep]), nb, seed + 1)
        lt["bss_keep_twoway"] = pvals(o2["bss"], b2["bss"])
    out["leave_top_k"] = lt
    if not full:
        return out
    evs = event_days(ts, sid, y, tday, T)
    out["events"] = evs[:20]
    out["n_events"] = len(evs)
    loeo = []
    for j, e in enumerate(evs):
        keep = drop_day_mask(ts, T, e["day"])
        if not y[keep].sum():
            continue
        r = {"day": e["utc"], "pos_rows_on_day": e["pos_rows"], "series_on_day": e["series"],
             "bss": float(1 - ((p1[keep] - y[keep]) ** 2).sum() / ((p0[keep] - y[keep]) ** 2).sum())}
        if j == 0:
            g2, G2, _ = R12.crash_blocks(ts[keep], sid[keep], y[keep], T)
            o2, b2 = twoway(cell_sums(sid[keep], g2, G2, y[keep], p1[keep], p0[keep]), nb, seed + 2)
            r["twoway"] = pvals(o2["bss"], b2["bss"])
            r["R1"] = float(p1[keep].sum() / y[keep].sum())
        loeo.append(r)
    out["loeo"] = loeo
    if evs:
        keep = np.ones(len(y), bool)
        for e in evs:
            keep &= drop_day_mask(ts, T, e["day"])
        if y[keep].sum():
            out["drop_all_events_bss"] = float(1 - ((p1[keep] - y[keep]) ** 2).sum()
                                               / ((p0[keep] - y[keep]) ** 2).sum())
            out["drop_all_events_rows_share"] = float(1 - keep.mean())
    return out


def terciles(st_t, y, P, cuts):
    """report only: R of every model by sigma-hat state tercile (cut points fixed on development)."""
    tr = np.digitize(st_t, cuts)
    res = {}
    for j, nm in enumerate(("calm", "mid", "turbulent")):
        m = (tr == j) & np.isfinite(st_t)
        sy = y[m].sum()
        res[nm] = {"rows": int(m.sum()), "pos": int(sy),
                   **{f"R_{k}": (float(v[m].sum() / sy) if sy else None) for k, v in P.items()}}
    m = ~np.isfinite(st_t)
    res["no_state"] = {"rows": int(m.sum()), "pos": int(y[m].sum())}
    return res


# =============================================================================================
# known-answer scorer tests (synthetic)
# =============================================================================================
def cmd_kat(a):
    res = {}
    rng = np.random.default_rng(1)
    # 1. exact identities on a tiny hand-made cell
    y = np.array([1, 0, 0, 1, 0, 0, 0, 0, 1, 0], float)
    p0 = np.array([.6, .2, .1, .5, .3, .2, .1, .1, .4, .2])
    p1 = np.array([.5, .1, .1, .4, .2, .1, .1, .1, .3, .1])
    sid = np.array([0, 0, 0, 1, 1, 1, 2, 2, 2, 2])
    g = np.array([0, 1, 2, 0, 1, 2, 0, 1, 2, 2])
    cs = cell_sums(sid, g, 3, y, p1, p0)
    s = stats_of(cs["X"].sum(1))
    bss = 1 - ((p1 - y) ** 2).sum() / ((p0 - y) ** 2).sum()
    R0, R1 = p0.sum() / 3, p1.sum() / 3
    ok1 = abs(s["bss"] - bss) < 1e-12 and abs(s["a"] - (math.log(R0) - math.log(R1))) < 1e-12 and \
        abs(s["b"] - (math.log(R0) + math.log(R1))) < 1e-12
    res["identities"] = {"bss": float(bss), "R0": R0, "R1": R1, "pass": bool(ok1)}
    # 2. two-way bootstrap size and power on a synthetic series x block panel with shared block shocks
    def panel(effect, seed):
        r = np.random.default_rng(seed)
        nS, G, per = 60, 50, 40
        sid = np.repeat(np.arange(nS), G * per)
        g = np.tile(np.repeat(np.arange(G), per), nS)
        bs = r.normal(0, 0.8, G)[g] + r.normal(0, 0.3, nS)[sid]
        q = 1 / (1 + np.exp(-(-3.2 + bs)))
        yy = (r.random(len(q)) < q).astype(float)
        p0 = np.clip(q * 1.3, 1e-4, .9999)                 # over-forecast reference (R0 about 1.3)
        p1 = np.clip(q * (1.3 - effect), 1e-4, .9999)
        return sid, g, G, yy, p1, p0
    rej_null, rej_alt = [], []
    for rep in range(40):
        sid, g, G, yy, p1, p0 = panel(0.0, 100 + rep)
        p1n = np.clip(p0 * np.exp(rng.normal(0, 0.05, len(p0))), 1e-4, .9999)   # noise-only model: no true gain
        cs = cell_sums(sid, g, G, yy, p1n, p0)
        o, b = twoway(cs, 400, rep)
        # true BSS of a noise-only model is < 0; test the null BSS = 0 with a model whose population gain is 0:
        # swap halves so E[d] = 0 exactly (p1 and p0 exchangeable)
        sw = np.random.default_rng(rep).random(len(p0)) < 0.5
        pa, pb = np.where(sw, p1n, p0), np.where(sw, p0, p1n)
        o, b = twoway(cell_sums(sid, g, G, yy, pa, pb), 400, rep)
        rej_null.append(pvals(o["bss"], b["bss"])["p_centred"] <= 0.05)
        sid, g, G, yy, p1, p0 = panel(0.25, 300 + rep)
        o, b = twoway(cell_sums(sid, g, G, yy, p1, p0), 400, rep)
        pv = pvals(o["bss"], b["bss"])
        pa_ = pvals(o["a"], b["a"])
        pb_ = pvals(o["b"], b["b"])
        rej_alt.append(pv["p_centred"] <= 0.05 and pv["p_pct"] <= 0.05 and pa_["p_pct"] <= 0.05
                       and pb_["p_pct"] <= 0.05)
    res["size_exchangeable_null"] = {"reps": 40, "reject_rate_at_0.05": float(np.mean(rej_null)),
                                     "pass": bool(np.mean(rej_null) <= 0.15)}
    res["power_true_gain"] = {"reps": 40, "reject_rate": float(np.mean(rej_alt)), "pass": bool(np.mean(rej_alt) >= 0.8)}
    # 3. legs: overshoot below 1/R0 must fail leg b, undershoot of the correction must keep leg a and b positive
    sid, g, G, yy, p1, p0 = panel(0.0, 7)
    R0 = p0.sum() / yy.sum()
    over = np.clip(p0 / R0 ** 2.4, 1e-4, .9999)            # R1 about 1 / R0^1.4 < 1 / R0 -> b < 0
    s = stats_of(cell_sums(sid, g, G, yy, over, p0)["X"].sum(1))
    half = np.clip(p0 / R0 ** 0.5, 1e-4, .9999)            # R1 about sqrt(R0) -> a > 0, b > 0
    s2 = stats_of(cell_sums(sid, g, G, yy, half, p0)["X"].sum(1))
    res["legs"] = {"overshoot_b": float(s["b"]), "half_a": float(s2["a"]), "half_b": float(s2["b"]),
                   "pass": bool(s["b"] < 0 and s2["a"] > 0 and s2["b"] > 0)}
    # 4. leave-top-k and LOEO drop the right rows
    ts = np.arange(len(yy)) * 0 + (np.repeat(np.arange(G), 40)[np.arange(len(yy)) % (G * 40)] * 7 * DAY
                                    + 1_600_000_000 // DAY * DAY)
    m = drop_day_mask(ts, 24, int(ts[0] // DAY))
    lt = leave_top_k(sid, yy, half, p0)
    res["drop"] = {"loeo_dropped_rows": int((~m).sum()), "expected": int((ts < ts[0] + DAY).sum()),
                   "ltk_k": lt["k"], "pass": bool(int((~m).sum()) == int((ts < ts[0] + DAY).sum()) and lt["k"] == 3)}
    res["all_pass"] = bool(all(v["pass"] for v in res.values() if isinstance(v, dict)))
    os.makedirs(a.out, exist_ok=True)
    h = R112.write_json(os.path.join(a.out, "kat-r165.json"), res)
    print(json.dumps(res, indent=1))
    print("sha256", h)


# =============================================================================================
# rows: patched r14_dr.row_task with sigma-hat state and first-touch day per deep level
# =============================================================================================
_src = inspect.getsource(D.row_task)
_src = _src.replace('keys = ["ts", "y", "pH", "pf", "pa", "pG", "yG", "q2", "tail", "fold"]',
                    'keys = ["ts", "y", "pH", "pf", "pa", "pG", "yG", "q2", "tail", "fold", "st", "td"]\n'
                    '    _lsH = None')
_src = _src.replace('        out["fold"].append(np.full(len(ts), int(f["qs_ts"]), np.int64))',
                    '        out["fold"].append(np.full(len(ts), int(f["qs_ts"]), np.int64))\n'
                    '        out["st"].append(_R165_state(sH, te).astype(np.float32))\n'
                    '        out["td"].append(_R165_touch(ser, te, T, P.Y[te]))')
_src = _src.replace("def row_task(", "def row_task_r165(")
assert "_R165_state" in _src and "_R165_touch" in _src


def _R165_state(sH, te):
    """ln sH(t) - mean of finite ln sH over the trailing STATE_WIN_H hours before t (ex ante); NaN with < 30 days."""
    l = np.log(np.where(sH > 0, sH, np.nan))
    f = np.isfinite(l)
    cs = np.concatenate([[0.0], np.cumsum(np.where(f, l, 0.0))])
    cn = np.concatenate([[0], np.cumsum(f.astype(np.int64))])
    lo = np.maximum(te - STATE_WIN_H, 0)
    n = cn[te] - cn[lo]
    with np.errstate(invalid="ignore", divide="ignore"):
        m = (cs[te] - cs[lo]) / n
    out = l[te] - m
    out[n < 720] = np.nan
    return out


def _R165_touch(ser, te, T, Y):
    """first-touch UTC day per LEV level (-1 if no touch): first j in 0..T-1 with low[i + j] <= spot[i] (1 + k)."""
    out = np.full((len(te), len(LEV)), -1, np.int32)
    low = ser.low
    for c, k in enumerate(LEV):
        j_ = D.KIX[k]
        pos = np.flatnonzero(Y[:, j_] > 0)
        if not len(pos):
            continue
        i = te[pos]
        L = ser.spot[i] * (1 + k)
        found = np.full(len(pos), -1, np.int64)
        for j in range(T):
            ii = np.minimum(i + j, len(low) - 1)
            hit = (found < 0) & (low[ii] <= L)
            found[hit] = j
        ok = found >= 0
        out[pos[ok], c] = ((ser.base_ts + STEP * (i[ok] + found[ok])) // DAY).astype(np.int32)
    return out


exec(compile(_src, "row_task_r165", "exec"), globals())


def run_rows(specs, T, grid, workers, log, label):
    import multiprocessing as mp
    t0 = time.time()
    res = []
    with mp.get_context("fork").Pool(workers, maxtasksperchild=8) as pool:
        for j, r in enumerate(pool.imap(row_task_r165, [{"spec": s, "T": T, "grid": grid} for s in specs],
                                        chunksize=1)):
            res.append(r)
            if (j + 1) % 50 == 0 or j + 1 == len(specs):
                log(f"  {label} {TL[T]}: {j + 1}/{len(specs)} ({time.time() - t0:.0f}s)")
    return R12.stack_rows(res)


def forecasts(S, T, dr_map, r13, cfg):
    """frozen forecasts at the deep levels LEV (columns of r14_dr DLEV): same code as r14_dr.forecasts_of."""
    cols = [D.KIX[k] for k in D.DLEV]
    p2, _ = D.dr_apply(S["pG"], S["yG"], S["ts"], S["sid"], T, dr_map, cfg["W_days"], cfg["kappa"], cfg["floor"])
    r = R13.recal(S["pH"].astype(float), S["ts"], S["sid"], S["y"], T, r13["maps"], r13["W_days"], r13["kappa"],
                  r13["cvar"])[0][:, cols]
    return {"fH": S["pH"][:, cols].astype(float)[:, CI], "DR": p2[:, CI], "R13.1": r[:, CI]}


def set_specs(name, datasets):
    if name == "b12":
        return D.R13.b12_specs(datasets)
    if name == "b13a":
        return D.R13.b13a_specs(datasets)
    if name == "b15a":
        return R13.b15a_specs(os.path.join(datasets, "b15-mexc-prices"))
    if name == "b15b":
        return D.b15b_specs(os.path.join(datasets, "b15-mexc-prices"))
    if name == "b18":
        return b18_specs(os.path.join(datasets, "b18-poloniex-prices"))
    raise SystemExit(name)


def maps_for(name, T, cfg, d141, d131):
    if name in ("b12", "b13a"):
        return (d141["maps_loo"][TL[T]][name]["1"],
                {"maps": d131["maps_loo"][TL[T]][name], "W_days": 90, "kappa": 50.0, "cvar": "c_mp"})
    return cfg["dr_maps"][TL[T]], {"maps": cfg["r131"]["maps"][TL[T]], "W_days": cfg["r131"]["W_days"],
                                   "kappa": cfg["r131"]["kappa"], "cvar": cfg["r131"]["cvar"]}


def build_rows(name, T, a, log):
    cfg = json.load(open(os.path.join(a.datasets, FROZEN_R141)))
    d141 = json.load(open(os.path.join(a.datasets, DEV_R141))) if name in ("b12", "b13a") else None
    d131 = json.load(open(os.path.join(a.datasets, DEV_R131))) if name in ("b12", "b13a") else None
    S = run_rows(set_specs(name, a.datasets), T, "1h", a.workers, log, name)
    dr_map, r13 = maps_for(name, T, cfg, d141, d131)
    P = forecasts(S, T, dr_map, r13, cfg)
    keep = ~S["q2"] & ~S["tail"]
    cols = [D.KIX[k] for k in LEV]
    out = {"ts": S["ts"][keep], "sid": S["sid"][keep].astype(np.int32), "st": S["st"][keep],
           "y": S["y"][keep][:, cols].astype(np.int8), "td": S["td"][keep],
           **{f"p_{m}": P[m][keep].astype(np.float64) for m in MODELS}}
    # consistency: every positive row has a touch day, no negative row has one
    out["_touch_check"] = np.array([int(np.sum((out["y"] > 0) != (out["td"] >= 0)))])
    return out


def cmd_rows(a):
    log = logger(os.path.join(a.out, "rows-log.txt"))
    log(f"START r16.5 rows {a.sets} code {R112.git_sha()}")
    for name in a.sets.split(","):
        for T in HS:
            p = os.path.join(a.out, f"rows-{name}-{TL[T]}.npz")
            if os.path.exists(p):
                continue
            r = build_rows(name, T, a, log)
            np.savez_compressed(p, **r)
            log(f"  {name} {TL[T]}: rows {len(r['ts'])} touch-check mismatches {int(r['_touch_check'][0])} "
                f"state NaN share {float(np.mean(~np.isfinite(r['st']))):.3f}")
    log("END rows")


def load_rows(out, names, T):
    parts, off = [], 0
    for nm in names:
        z = np.load(os.path.join(out, f"rows-{nm}-{TL[T]}.npz"))
        d = {k: z[k] for k in z.files if not k.startswith("_")}
        d["sid"] = d["sid"].astype(np.int64) + off
        d["set"] = np.full(len(d["ts"]), names.index(nm), np.int8)
        off = int(d["sid"].max()) + 1
        parts.append(d)
    return {k: np.concatenate([p[k] for p in parts]) for k in parts[0]}


# =============================================================================================
# instrument check 1: reproduce R14.1 on B15b
# =============================================================================================
def cmd_repro(a):
    pub = json.load(open(os.path.join(a.datasets, RESULTS_R141)))
    res = {}
    worst = 0.0
    for T in HS:
        S = load_rows(a.out, ["b15b"], T)
        for c, k in enumerate(LEV):
            key = f"{TL[T]} {k}"
            y = S["y"][:, c].astype(float)
            f = pub["cells"][key]["f"]
            mine = {}
            for m in MODELS:
                p = S[f"p_{m}"][:, c]
                top = R13.quint_masks(p)[0]
                cp = R13.corp(p, y)
                mine[m] = {"R": p.sum() / y.sum(), "R_top20": (p * top).sum() / (y * top).sum(), "MCB": cp["MCB"],
                           "DSC": cp["DSC"]}
            e = lambda m: ((S[f"p_{m}"][:, c] - y) ** 2).sum()  # noqa: E731
            mine["bss_DR_fH"] = 1 - e("DR") / e("fH")
            mine["bss_DR_R13"] = 1 - e("DR") / e("R13.1")
            diffs = {"rows": len(y) - pub["cells"][key]["rows"], "pos": int(y.sum()) - pub["cells"][key]["pos"]}
            for m in MODELS:
                for q in ("R", "R_top20", "MCB", "DSC"):
                    diffs[f"{m}.{q}"] = float(mine[m][q] - f[m][q])
            diffs["bss_DR_fH"] = float(mine["bss_DR_fH"] - f["DR"]["bss_vs_ref"])
            diffs["bss_DR_R13"] = float(mine["bss_DR_R13"] - pub["cells"][key]["secondary_DR_vs_R13.1"]["bss_vs_ref"])
            worst = max(worst, max(abs(v) for kk, v in diffs.items() if kk not in ("rows", "pos")))
            res[key] = {"diffs": diffs, "rows_pub": pub["cells"][key]["rows"],
                        "R_fH": mine["fH"]["R"], "R_DR": mine["DR"]["R"], "R_R13": mine["R13.1"]["R"],
                        "bss_DR_fH": mine["bss_DR_fH"]}
            print(key, json.dumps(diffs))
    out = {"cells": res, "max_abs_diff": worst, "pass": bool(worst < 1e-8 and all(
        v["diffs"]["rows"] == 0 and v["diffs"]["pos"] == 0 for v in res.values())),
        "published": RESULTS_R141, "published_sha256": sha_file(os.path.join(a.datasets, RESULTS_R141))}
    h = R112.write_json(os.path.join(a.out, "repro-r141-b15b.json"), out)
    print("max abs diff", worst, "pass", out["pass"], "sha256", h)


# =============================================================================================
# development statistics, power projection, cell choice
# =============================================================================================
def project(c, cnt_new, za):
    """D-R13.5c rule 1 with the R16.1 component scaling: z_proj = z_dev / sqrt(factor)."""
    v = c["cgm"]
    se2 = (c["bss"]["sd"]) ** 2
    # influence variances are on the BSS scale already (psi / sum e0); scale to the bootstrap variance
    vs, vb, vi = v["V_s"], v["V_b"], v["V_int"]
    cmul = (se2 - vs - vb) / vi if vi > 0 else 0.0
    f = (vs * c["positive_series"] / max(cnt_new["positive_series"], 1)
         + vb * c["positive_blocks"] / max(cnt_new["positive_blocks"], 1)
         + cmul * vi * c["positive_cells"] / max(cnt_new["positive_cells"], 1)) / se2
    f = max(f, 1e-9)
    z = c["bss"]["z"]
    zp = z / math.sqrt(f)
    sc = zp / z if z > 0 else 0.0
    p_test = float(norm.cdf(zp - za))
    lt = c["leave_top_k"]
    zl = lt.get("bss_keep_twoway", {}).get("z", float("nan"))
    p_conc = float(norm.cdf(zl * sc)) if np.isfinite(zl) else 0.0
    lo = c.get("loeo") or []
    zlo = lo[0]["twoway"]["z"] if lo and "twoway" in lo[0] else z
    p_loeo = float(norm.cdf(zlo * sc - za)) if np.isfinite(zlo) else 0.0
    lr, sd = math.log(c["R1"]), c["lnR1_sd"] * math.sqrt(f)
    p_band = float(norm.cdf((math.log(RBAND[1]) - lr) / sd) - norm.cdf((math.log(RBAND[0]) - lr) / sd))
    return {"factor": f, "c_int": cmul, "z_dev": z, "z_proj": zp, "p_test": p_test, "p_conc": p_conc,
            "p_loeo": p_loeo, "p_band": p_band, "joint": min(p_test, p_loeo) * p_conc * p_band}


def cmd_dev(a):
    log = logger(os.path.join(a.out, "dev-log.txt"))
    names = a.sets.split(",")
    log(f"START r16.5 dev on {names}; code {R112.git_sha()}")
    out = {"schema": "q26-r16.5-dev/1", "label": "DEVELOPMENT ONLY (seen and spent sets)", "sets": names,
           "code_sha": R112.git_sha(), "nb": NB_DEV, "cells": {}, "state_cuts": {}}
    for T in HS:
        S = load_rows(a.out, names, T)
        st = S["st"].astype(float)
        cuts = np.nanquantile(st, [1 / 3, 2 / 3]).tolist()
        out["state_cuts"][TL[T]] = cuts
        for c, k in enumerate(LEV):
            key = f"{TL[T]} {k}"
            y = S["y"][:, c].astype(float)
            P = {m: S[f"p_{m}"][:, c] for m in MODELS}
            cell = {"terciles": terciles(st, y, P, cuts), "comps": {}, "by_set": {}}
            for j, (m1, m0) in enumerate(COMPS):
                r = comparison(S["ts"], S["sid"], y, S["td"][:, c], st, T, P[m1], P[m0], NB_DEV,
                               seed=1000 * T + int(-100 * k) * 10 + j)
                cell["comps"][f"{m1} vs {m0}"] = r
                log(f"  {key} {m1} vs {m0}: BSS {r['bss']['obs']:+.4f} z {r['bss']['z']:.2f} (CGM "
                    f"{r['cgm']['z']:.2f}) p c/pct {r['bss']['p_centred']:.4f}/{r['bss']['p_pct']:.4f}; R1 "
                    f"{r['R1']:.3f} R0 {r['R0']:.3f}; legs a/b/at/bt z {r['a']['z']:.2f}/{r['b']['z']:.2f}/"
                    f"{r['at']['z']:.2f}/{r['bt']['z']:.2f}; LTK k{r['leave_top_k']['k']} bss "
                    f"{r['leave_top_k']['bss_keep']:+.4f} z {r['leave_top_k'].get('bss_keep_twoway', {}).get('z')}; "
                    f"events {r['n_events']} LOEO1 {r['loeo'][0] if r['loeo'] else None}")
            for si, nm in enumerate(names):
                m = S["set"] == si
                cell["by_set"][nm] = {"rows": int(m.sum()), "pos": int(y[m].sum()),
                                      **{f"R_{mm}": float(P[mm][m].sum() / y[m].sum()) if y[m].sum() else None
                                         for mm in MODELS},
                                      **{f"bss_{m1}_vs_{m0}": float(1 - ((P[m1][m] - y[m]) ** 2).sum()
                                                                     / ((P[m0][m] - y[m]) ** 2).sum())
                                         for m1, m0 in COMPS}}
            out["cells"][key] = cell
        del S
    out["finished_utc"] = now_iso()
    h = R112.write_json(os.path.join(a.out, "dev-r165.json"), out)
    log(f"END dev sha256 {h}")


def cmd_choose(a):
    """cell choice on development by projected joint power at the reference B18 counts (fixed rule)."""
    dev = json.load(open(os.path.join(a.out, "dev-r165.json")))
    ref = json.load(open(a.ref))
    rows = []
    for key, cell in dev["cells"].items():
        for cn, c in cell["comps"].items():
            for nprim, za in ((1, norm.ppf(1 - ALPHA)), (2, norm.ppf(1 - ALPHA / 2))):
                pj = project(c, ref["cells"][key], za)
                rows.append({"cell": key, "comp": cn, "n_primary": nprim, **pj})
    rows.sort(key=lambda r: -r["joint"])
    res = {"reference": a.ref, "reference_sha256": sha_file(a.ref), "ranked": rows}
    h = R112.write_json(os.path.join(a.out, "choose-r165.json"), res)
    for r in rows[:16]:
        print(json.dumps({k: (round(v, 3) if isinstance(v, float) else v) for k, v in r.items()}))
    print("sha256", h)


# =============================================================================================
# B18 acquisition (outcome-blind), completeness, counts
# =============================================================================================
def polo_fetch(cache, sym, start_ms, log=None):
    """HOUR_1 candles from start to ACQ_END (exclusive) in closed-month cache entries; quantity 0 -> null."""
    from q26cache import Key
    rows, pages = {}, []
    t = datetime.fromtimestamp(start_ms / 1000, timezone.utc).replace(day=1, hour=0, minute=0, second=0)
    while int(t.timestamp()) < ACQ_END:
        nxt = (t.replace(year=t.year + 1, month=1) if t.month == 12 else t.replace(month=t.month + 1))
        a0, a1 = int(t.timestamp()), min(int(nxt.timestamp()), ACQ_END)

        def fetch(a0=a0, a1=a1):
            got = []
            s = a0
            while s < a1:
                e = min(s + 500 * STEP, a1)
                url = POLO_K.format(s=sym, i="HOUR_1", a=s * 1000, b=e * 1000 - 1)
                for k in range(8):
                    raw = R125.http_get(url)
                    try:
                        dd = json.loads(raw)
                    except ValueError:
                        dd = None
                    if isinstance(dd, list):
                        break
                    time.sleep(2.0 * (k + 1))
                else:
                    raise SystemExit(f"STOP: Poloniex {sym}: no list after retries")
                got.extend(dd)
                s = e
                time.sleep(0.12)
            return json.dumps(got, separators=(",", ":")).encode()
        key = Key("poloniex", "klines-1h-monthly", sym, t.strftime("%Y-%m"))
        raw = cache.get_or_fetch(key, fetch, source_url=POLO_K.format(s=sym, i="HOUR_1", a=a0 * 1000,
                                                                       b=a1 * 1000 - 1), owner="R16.5")
        d = json.loads(raw)
        pages.append({"month": t.strftime("%Y-%m"), "sha256": hashlib.sha256(raw).hexdigest(), "candles": len(d)})
        for c in d:   # [low, high, open, close, amount, quantity, bta, btq, tradeCount, ts, wavg, iv, start, close]
            ot = int(c[12]) // 1000
            if a0 <= ot < a1 and ot % STEP == 0:
                q = float(c[5])
                rows[ot] = (c[2], c[1], c[0], c[3], c[5]) if q > 0 else None
        t = nxt
    return rows, pages


def cmd_acquire_b18(a):
    from q26cache import Cache
    cache = Cache()
    sel = json.load(open(os.path.join(a.datasets, "b18-poloniex-prices/selection-b18.json")))
    vd = os.path.join(a.acq, "b18")
    os.makedirs(vd, exist_ok=True)
    mp_ = os.path.join(vd, "manifest-acquire-b18.json")
    man = json.load(open(mp_)) if os.path.exists(mp_) else {
        "schema": "q26-r16.5/acquire-b18/1", "started_utc": now_iso(), "code_sha": R112.git_sha(),
        "selection_sha256": sha_file(os.path.join(a.datasets, "b18-poloniex-prices/selection-b18.json")),
        "source": "Poloniex public REST /markets/{symbol}/candles HOUR_1 (free, keyless; no published checksum; "
                  "sha256 of every monthly raw payload recorded); a candle with quantity 0 and a missing hour are null;"
                  " no fill, no filter", "series": {}, "dropped": {}}
    for j, base in enumerate(sel["B18"]):
        if base in man["series"] or base in man["dropped"]:
            continue
        st_ms = max(int(datetime.strptime(sel["tradable_start_utc"][base], "%Y-%m-%d")
                        .replace(tzinfo=timezone.utc).timestamp() * 1000), 1577836800000)
        rows, pages = polo_fetch(cache, sel["symbol"][base], st_ms)
        live = {t: v for t, v in rows.items() if v is not None}
        if not live:
            man["dropped"][base] = {"reason": "no traded hour before the acquisition end"}
        else:
            st = min(live)
            if st >= R125.FIRST_MAX:
                man["dropped"][base] = {"reason": "first traded hour on or after 2025-07-01 (no A6.6 fold)"}
            else:
                gp = os.path.join(vd, f"poloniex-{base}USDT-1h.json.gz")
                nh, nn = R12.write_grid(gp, f"{base}USDT", "poloniex 1h", st, live)
                last = max(live)
                man["series"][base] = {"file": os.path.basename(gp), "sha256": R112.sha256_file(gp),
                                       "grid_start_utc": D.A.iso(st),
                                       "last_hour_utc": D.A.iso(last), "ended": bool(last + STEP < ACQ_END - R125.LIVE_GAP),
                                       "hours": nh, "null_hours": nn, "zero_quantity_candles":
                                       int(sum(1 for v in rows.values() if v is None)), "months": len(pages),
                                       "pages": pages}
        if (j + 1) % 10 == 0:
            R112.write_json(mp_, man)
            print(f"{now_iso()} acquired {j + 1}/{len(sel['B18'])}", flush=True)
    man["finished_utc"] = now_iso()
    man["status"] = "LOCKED for Q26 R16.5 (design/Q26_ROUND16_PREREG.md R16.5)"
    h = R112.write_json(mp_, man)
    print(json.dumps({"series": len(man["series"]), "dropped": len(man["dropped"]),
                      "hours": sum(v["hours"] for v in man["series"].values()),
                      "null_hours": sum(v["null_hours"] for v in man["series"].values()),
                      "ended": sum(v["ended"] for v in man["series"].values()), "manifest_sha256": h}), flush=True)


def b18_specs(acq):
    man = json.load(open(os.path.join(acq, "b18", "manifest-acquire-b18.json")))
    specs = []
    for b, v in sorted(man["series"].items()):
        path = os.path.join(acq, "b18", v["file"])
        st, cols = R12.load_json_grid(path)
        n = len(cols["close"])
        last = st + STEP * (n - 1)
        cap_full = min(ACQ_END, last + STEP)
        cap_pri = min(cap_full, last + STEP - R12.TAIL_DAYS * DAY) if v["ended"] else cap_full
        sp = R12.redenom_splits(cols["close"])
        bounds = [0] + sp + [n]
        for j in range(len(bounds) - 1):
            if bounds[j + 1] - bounds[j] <= 0:
                continue
            specs.append({"key": f"b18:{b}" + ("" if j == 0 else f"#{j + 1}"), "asset": b, "kind": "grid",
                          "path": path, "slice": (bounds[j], bounds[j + 1]), "cap_full": cap_full,
                          "cap_primary": cap_pri})
    return specs


def cmd_complete(a):
    """bar completeness. (i) seen pairs BTC_USDT, ETH_USDT: HOUR_1 lows/highs vs DAY_1 for 2024-2025 months.
    (ii) B18 structure only: hour alignment, duplicates, zero or negative prices, null share, longest null run,
    low > min(open, close) or high < max(open, close) violations. No price level, return or outcome is printed."""
    out = {"created_utc": now_iso(), "code_sha": R112.git_sha(), "seen_pair_reconciliation": {}, "b18": {}}
    for sym in ("BTC_USDT", "ETH_USDT"):
        bad, days = 0, 0
        for a0 in (1704067200, 1719792000, 1735689600):        # 2024-01, 2024-07, 2025-01: 30 days each
            a1 = a0 + 30 * DAY
            h = []
            s = a0
            while s < a1:
                e = min(s + 500 * STEP, a1)
                h += json.loads(R125.http_get(POLO_K.format(s=sym, i="HOUR_1", a=s * 1000, b=e * 1000 - 1)))
                s = e
            dd = json.loads(R125.http_get(POLO_K.format(s=sym, i="DAY_1", a=a0 * 1000, b=a1 * 1000 - 1)))
            for c in dd:
                d0 = int(c[12]) // 1000
                hh = [x for x in h if d0 <= int(x[12]) // 1000 < d0 + DAY]
                if len(hh) != 24:
                    bad += 1
                elif abs(min(float(x[0]) for x in hh) - float(c[0])) > 1e-9 * float(c[0]) or \
                        abs(max(float(x[1]) for x in hh) - float(c[1])) > 1e-9 * float(c[1]):
                    bad += 1
                days += 1
        out["seen_pair_reconciliation"][sym] = {"days": days, "mismatched_days": bad}
    man = json.load(open(os.path.join(a.acq, "b18", "manifest-acquire-b18.json")))
    agg = {"series": 0, "hours": 0, "null_hours": 0, "zero_quantity_candles": 0, "misaligned": 0, "nonpositive": 0,
           "ohlc_violations": 0, "series_null_share_gt_50pct": 0, "longest_null_run_h_max": 0}
    for b, v in man["series"].items():
        raw = json.loads(gzip.decompress(open(os.path.join(a.acq, "b18", v["file"]), "rb").read()))
        cols = raw["columns"]
        n = raw["count"]
        agg["series"] += 1
        agg["hours"] += n
        nul = np.array([x is None for x in cols["close"]])
        agg["null_hours"] += int(nul.sum())
        agg["zero_quantity_candles"] += v["zero_quantity_candles"]
        agg["misaligned"] += int(raw["startTs"] % STEP != 0)
        o, hi, lo, cl = (np.array([np.nan if x is None else x for x in cols[c]], float)
                         for c in ("open", "high", "low", "close"))
        f = ~nul
        agg["nonpositive"] += int(np.sum((lo[f] <= 0) | (cl[f] <= 0)))
        agg["ohlc_violations"] += int(np.sum((lo[f] > np.minimum(o[f], cl[f]) * (1 + 1e-12))
                                             | (hi[f] < np.maximum(o[f], cl[f]) * (1 - 1e-12))))
        agg["series_null_share_gt_50pct"] += int(nul.mean() > 0.5)
        run = mx = 0
        for x in nul:
            run = run + 1 if x else 0
            mx = max(mx, run)
        agg["longest_null_run_h_max"] = max(agg["longest_null_run_h_max"], mx)
    agg["null_share"] = agg["null_hours"] / max(agg["hours"], 1)
    out["b18"] = agg
    out["pass"] = bool(all(v["mismatched_days"] == 0 for v in out["seen_pair_reconciliation"].values())
                       and agg["misaligned"] == 0 and agg["nonpositive"] == 0 and agg["ohlc_violations"] == 0)
    h = R112.write_json(os.path.join(a.out, "complete-b18.json"), out)
    print(json.dumps(out, indent=1))
    print("sha256", h)


def count_cells(specs, workers, log, label):
    """registered count fields per candidate cell (no positive-row count, no rate)."""
    out = {"cells": {}, "T": {}}
    for T in HS:
        S = run_rows(specs, T, "1h", workers, log, label)
        keep = ~S["q2"] & ~S["tail"]
        ts, sid = S["ts"][keep], S["sid"][keep]
        out["T"][TL[T]] = {"series_with_origins": int(len(np.unique(sid))), "validated_origins": int(len(ts))}
        for k in LEV:
            y = S["y"][keep][:, D.KIX[k]].astype(float)
            g, G, posb = R12.crash_blocks(ts, sid, y, T)
            out["cells"][f"{TL[T]} {k}"] = {"blocks": int(G), **pos_counts(sid, g, y)}
        del S
    return out


def cmd_counts(a):
    log = logger(os.path.join(a.out, "counts-log.txt"))
    c = count_cells(b18_specs(os.path.join(a.acq)), a.workers, log, "B18")
    out = {"schema": "q26-r16.5/counts-b18/1", "created_utc": now_iso(), "code_sha": R112.git_sha(),
           "note": "counts only; registered fields: series_with_origins, validated_origins (per T); blocks, "
                   "positive_series, positive_blocks, positive_cells (per cell)", **c}
    h = R112.write_json(os.path.join(a.out, "counts-b18.json"), out)
    for kk, v in out["cells"].items():
        print(kk, v)
    print(out["T"], "sha256", h)


def cmd_power(a):
    dev = json.load(open(os.path.join(a.dev, "dev-r165.json")))
    ch = json.load(open(a.choice))
    cnt = json.load(open(os.path.join(a.out, "counts-b18.json")))
    prim = ch["primary"]
    za = norm.ppf(1 - ALPHA / len(prim))
    res = {"primary": prim, "cells": {}}
    for pr in prim:
        c = dev["cells"][pr["cell"]]["comps"][pr["comp"]]
        res["cells"][f"{pr['cell']} | {pr['comp']}"] = {"counts": cnt["cells"][pr["cell"]],
                                                        **project(c, cnt["cells"][pr["cell"]], za)}
    res["joint_max"] = max(v["joint"] for v in res["cells"].values())
    res["run"] = bool(res["joint_max"] >= 0.80)
    h = R112.write_json(os.path.join(a.out, "power-b18.json"), res)
    print(json.dumps(res, indent=1))
    print("sha256", h)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["select-b22", "kat", "rows", "repro", "dev", "choose", "acquire-b18", "complete",
                                    "counts", "power"])
    ap.add_argument("--datasets", default="/home/user/membrane-datasets")
    ap.add_argument("--out", required=True)
    ap.add_argument("--acq", default="")
    ap.add_argument("--dev", default="")
    ap.add_argument("--ref", default="")
    ap.add_argument("--choice", default="")
    ap.add_argument("--sets", default="b12,b13a,b15a,b15b")
    ap.add_argument("--workers", type=int, default=2)
    a = ap.parse_args()
    {"select-b22": cmd_select_b22, "kat": cmd_kat, "rows": cmd_rows, "repro": cmd_repro, "dev": cmd_dev,
     "choose": cmd_choose, "acquire-b18": cmd_acquire_b18, "complete": cmd_complete, "counts": cmd_counts,
     "power": cmd_power}[a.cmd](a)


if __name__ == "__main__":
    main()
