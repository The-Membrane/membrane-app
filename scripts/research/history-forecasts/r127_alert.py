"""Q26 R12.7: blind test of the simple TWAP-oracle alert rule found in the R12.6 review (D-R12.6e).

membrane-board design/Q26_ROUND12_PREREG.md, Deviations D-R12.7a (opened: sets reserved, variants and data rules
fixed), D-R12.7b (development readings on seen data), D-R12.7c (confirmatory registration on B13b), later freeze and
result. Owner approval 2026-10-18; owner ruling 10 (live logs never the only blind evidence; >= 2 unseen sets
reserved before development).

The rule.  At origin t (an hour boundary) let S_raw = last 1 m close before t and S_W = the 1 h TWAP at t (mean of the
60 one-minute closes ending at the minute before t, >= 57 present; the R12.6 'W' definition, unchanged).  For a level
k the TWAP-anchored strike is K = S_W * (1 + k).  The R12.6 target y = 1 if the TWAP path (every minute) over
(t, t + T] reaches K.

  R-bit   alert = 1 if S_raw <= K ("spot already through the level measured against the current TWAP"), else 0.
  R-cal   P = frequency of y on the development set (seen B13a) in the bin
          (T, k, distance bucket of d = ln(S_raw / S_W) - ln(1 + k), short-volatility tercile of rv24);
          sparse bins fall back to (T, k, distance bucket), then to the (T, k) base rate.

Subcommands
  select-gate  --datasets DS --out OUT          reserve B14 (Gate.io USDT pairs on no used venue list); listings only
  dev          --b13a DIR --binance DIR --out OUT [--workers 3]
               development readings on SEEN data (B13a hours; Binance ETH/BTC replay, reported only): R-bit
               statistics, the R-cal lookup, power (D-R11.3e)
  acquire-b13b --selection SEL --out OUT [--workers 6]
               outcome-blind B13b builder (daily 1 m zips, md5 == CHECKSUM else STOP; hourly columns as R12.6 plus the
               count of traded minutes per hour); prints file and hour counts only
  counts       --acq DIR --out OUT                counts-only check of B13b (origins, weeks, label positives, alerts)
  freeze       --acq DIR --dev DIR --counts F --out OUT
  run          --acq DIR --cfgdir DIR --out OUT   the one confirmatory run on B13b

No address, key or secret is read or written.
"""
from __future__ import annotations

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import concurrent.futures as cf  # noqa: E402
import csv  # noqa: E402
import hashlib  # noqa: E402
import io  # noqa: E402
import json  # noqa: E402
import math  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402
import zipfile  # noqa: E402
from datetime import datetime, timezone  # noqa: E402

import numpy as np  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import a_touch as A  # noqa: E402
import r12_tail as R12  # noqa: E402
import r125_fh_deep as R125  # noqa: E402
import r126_twap as W  # noqa: E402

PREREG = {"repo": "triccs/membrane-board", "path": "design/Q26_ROUND12_PREREG.md", "item": "R12.7",
          "deviations": "D-R12.7a (opened), D-R12.7b (development), D-R12.7c (registration)"}
STEP, DAY, MIN = 3600, 86400, 60
END = R12.END
HORIZONS = (1, 3, 6)                     # 1 h primary; 3 h, 6 h secondary
CONF_K = (-0.02, -0.03, -0.05, -0.07, -0.10)
DEEP_K = (-0.15, -0.20)                  # liquidation-relevant, reported only
ALL_K = CONF_K + DEEP_K
LNK = {k: math.log1p(k) for k in ALL_K}
KEEP_KEYS = ("yW", "yL", "fHAW", "fHW", "fW", "aW", "fHL")
# R-cal lookup (fixed in D-R12.7a)
D_EDGES = np.array([-0.03, -0.015, -0.0075, -0.0025, 0.0, 0.0025, 0.005, 0.01, 0.02, 0.04])   # d buckets (right-closed)
RV_HOURS, RV_MIN_PRESENT = 24, 20        # rv24: RMS of hourly log close-to-close returns over hours t-24..t-1
MIN_BIN = 200                            # rows per bin before falling back
# tests
SEED = 20261870
N_BOOT = 10000
R_BAND = (0.8, 1.25)
MIN_POS_WEEKS = 30
TOST_MARGIN = 0.05                       # |P_B13b(cross|alert) - P_B13a(cross|alert)| <= 0.05
LIKELY = 0.5                             # "likely crossing": P(cross | alert) > 0.5
LIQ_TRADED_MIN = 30                      # reported liquidity sensitivity: >= 30 traded minutes in the hour before t
TAIL_S = 30 * DAY
GATE_PAIRS = "https://api.gateio.ws/api/v4/spot/currency_pairs"
GATE_DEALS = "https://download.gatedata.org/spot/deals/{m}/{p}-{m}.csv.gz"
GATE_FIRST_MAX = "2025-06-30"
SPLIT_B14 = "Q26-B14:"


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha256b(b):
    return hashlib.sha256(b).hexdigest()


def sha_file(p):
    return sha256b(open(p, "rb").read())


# =============================================================================================
# B14 reservation (listings only)
# =============================================================================================
def head_size(url):
    import urllib.request
    for k in range(5):
        try:
            req = urllib.request.Request(url, method="HEAD", headers=W.UA)
            with urllib.request.urlopen(req, timeout=60) as r:
                return int(r.headers.get("Content-Length") or 0)
        except Exception as e:  # noqa: BLE001
            if getattr(e, "code", None) in (403, 404):
                return None
            time.sleep(1.5 * (k + 1))
    return None


def cmd_select_gate(a):
    """B14: Gate.io USDT pairs whose base is on no Binance spot list, in no KuCoin USDT folder, not a B12 kept asset,
    not excluded (R12.5 rule), listed (buy_start) on or before 2025-06-30, with a free bulk trade file for 2025-06."""
    raw = W.http_get(GATE_PAIRS)
    pairs = json.loads(raw)
    sel12 = json.load(open(os.path.join(a.datasets, "b12-venue-unique-prices/selection-b12.json")))
    b12 = {x.split("-")[0].replace("USDT", "") for x in set(sel12["okx"]["kept"]) | set(sel12["bybit"]["kept"])}
    bn = set(R125.binance_symbols())
    kc = {p.rstrip("/").split("/")[-1] for p in W.s3_keys("kucoin", "data/spot/daily/klines/")}
    kc_bases = {d[:-4] for d in kc if d.endswith("USDT")}
    rec = {"gate_usdt_pairs": 0, "on_binance": [], "on_kucoin": [], "in_b12": [], "excluded": {}, "late": [],
           "kept": []}
    first = {}
    for p in sorted(pairs, key=lambda x: x["id"]):
        if p.get("quote") != "USDT" or p.get("type", "normal") != "normal":
            continue
        rec["gate_usdt_pairs"] += 1
        base = p["base"]
        bs = int(p.get("buy_start") or 0)
        first[base] = datetime.fromtimestamp(bs, timezone.utc).strftime("%Y-%m-%d") if bs else None
        if R125.on_binance(base, bn):
            rec["on_binance"].append(base)
        elif base in kc_bases:
            rec["on_kucoin"].append(base)
        elif base in b12:
            rec["in_b12"].append(base)
        elif R125.excluded(base):
            rec["excluded"][base] = R125.excluded(base)
        elif not first[base] or first[base] > GATE_FIRST_MAX:
            rec["late"].append(base)
        else:
            rec["kept"].append(base)
    with cf.ThreadPoolExecutor(12) as ex:
        sizes = dict(zip(rec["kept"], ex.map(lambda b: head_size(GATE_DEALS.format(m="202506", p=b + "_USDT")),
                                             rec["kept"])))
    rec["bulk_file_202506_present"] = sorted(b for b, s in sizes.items() if s)
    elig = rec["bulk_file_202506_present"]
    out = {"schema": "q26-r127-b14-selection-v1", "created_utc": now_iso(), "binance_spot_symbols": len(bn),
           "binance_list_sha256": sha256b("\n".join(sorted(bn)).encode()), "kucoin_usdt_dirs": len(kc_bases),
           "gate_pairs_sha256": sha256b(raw), "b12_assets": len(b12), "buy_start": first,
           "eligible_listed_le": GATE_FIRST_MAX, "eligible": elig,
           "split_rule": f"sha256('{SPLIT_B14}' + base)[0:2] as hex byte: even -> B14a, odd -> B14b",
           "B14a": [b for b in elig if int(sha256b((SPLIT_B14 + b).encode())[:2], 16) % 2 == 0],
           "B14b": [b for b in elig if int(sha256b((SPLIT_B14 + b).encode())[:2], 16) % 2 == 1],
           "source": "Gate.io public bulk trades (download.gatedata.org spot/deals, monthly per pair); 1 m bars "
                     "to be built from trades (minutes without a trade are absent rows, unlike KuCoin)", **rec}
    os.makedirs(a.out, exist_ok=True)
    p = os.path.join(a.out, "selection-b14.json")
    json.dump(out, open(p, "w"), indent=1)
    print(json.dumps({k: (len(v) if isinstance(v, (list, dict)) else v) for k, v in out.items()}, indent=1))
    print("sha256", sha_file(p))


# =============================================================================================
# features and rows
# =============================================================================================
def features(d, ts):
    """S_raw, S_W, rv24 and traded minutes of the hour before each origin ts (arrays from an hourly npz)."""
    st = int(d["startTs"])
    i = ((np.asarray(ts, np.int64) - st) // STEP).astype(np.int64)
    close, twe = d["close"], d["tw_end"]
    s_raw = close[i - 1]
    s_w = twe[i - 1]
    lr = np.full(len(close), np.nan)
    with np.errstate(invalid="ignore", divide="ignore"):
        lr[1:] = np.log(close[1:] / close[:-1])
    fin = np.isfinite(lr)
    c2 = np.concatenate([[0.0], np.cumsum(np.where(fin, lr * lr, 0.0))])
    cn = np.concatenate([[0], np.cumsum(fin)])
    j0 = np.maximum(i - RV_HOURS, 0)
    n = cn[i] - cn[j0]
    with np.errstate(invalid="ignore", divide="ignore"):
        rv = np.sqrt((c2[i] - c2[j0]) / n)
    rv[n < RV_MIN_PRESENT] = np.nan
    tr = d["traded"][i - 1] if "traded" in d.files else np.full(len(i), np.nan)
    return s_raw, s_w, rv, tr


def series_rows(a):
    """dev_task rows (R12.6 recipe, unchanged) plus alert features at the same origins."""
    r = W.dev_task({"path": a["path"], "T": a["T"], "key": a["key"], "grid": "1h", "cap": a["cap"],
                    "keep_keys": KEEP_KEYS, "keep_levels": ALL_K})
    rows = r["rows"]
    if rows is None:
        return r
    d = np.load(a["path"])
    s_raw, s_w, rv, tr = features(d, rows["ts"])
    with np.errstate(invalid="ignore", divide="ignore"):
        rows["gap"] = np.log(s_raw / s_w)
    rows["rv"] = rv
    rows["traded"] = tr
    return r


def stack(specs, T, workers):
    import multiprocessing as mp
    tasks = [{"path": s["path"], "T": T, "key": s["key"], "cap": s["cap"]} for s in specs]
    with mp.get_context("fork").Pool(workers, maxtasksperchild=4) as pool:
        res = pool.map(series_rows, tasks, chunksize=1)
    S = R12.stack_rows(res, lambda rw: ~rw["q2"])
    allk = np.array([r["key"] for r in res])
    S["sid_key"] = allk[S["sid"]]                    # stack_rows' sid indexes the task list
    S["keys"] = sorted(set(S["sid_key"].tolist()))
    return S


def acq_specs(acq, manifest):
    man = json.load(open(os.path.join(acq, manifest)))
    out = []
    for p in man["pairs"]:
        if p.get("empty") or not p.get("hours"):
            continue
        last = p.get("last_minute_ts")
        ended = last is not None and last < END - TAIL_S
        cap = (last + MIN - TAIL_S) // STEP * STEP if ended else END
        out.append({"key": p["pair"], "path": os.path.join(acq, f"{p['pair']}.npz"), "cap": int(cap),
                    "ended": bool(ended)})
    return out


def binance_specs(hours):
    out = []
    for pair in ("ETHUSDT", "BTCUSDT"):
        p = os.path.join(hours, f"{pair}.npz")
        if os.path.exists(p):
            out.append({"key": pair, "path": p, "cap": END, "ended": False})
    return out


def dist(S, j, k):
    return S["gap"] - LNK[k]


def dbin(dd):
    return np.searchsorted(D_EDGES, dd, side="left")


def vbin(rv, edges):
    b = np.searchsorted(edges, rv, side="right")
    return np.where(np.isfinite(rv), b, len(edges) + 1)


# =============================================================================================
# R-cal lookup
# =============================================================================================
def fit_lookup(S, T, rv_edges, mask=None):
    """frequency table per (k, d bucket, v bucket) with fallbacks; returns a JSON-able dict."""
    m = np.ones(len(S["ts"]), bool) if mask is None else mask
    out = {"T": R12.TL[T], "levels": {}}
    vb = vbin(S["rv"][m], rv_edges)
    for j, k in enumerate(ALL_K):
        y = S["yW"][m, j].astype(float)
        db = dbin(dist(S, j, k)[m])
        base = float(y.mean())
        cells, pooled = {}, {}
        for b in np.unique(db):
            mb = db == b
            pooled[str(int(b))] = [float(y[mb].sum()), int(mb.sum())]
            for v in np.unique(vb[mb]):
                mv = mb & (vb == v)
                cells[f"{int(b)}|{int(v)}"] = [float(y[mv].sum()), int(mv.sum())]
        out["levels"][repr(k)] = {"base": base, "rows": int(len(y)), "cells": cells, "pooled_d": pooled}
    return out


def apply_lookup(L, S, j, k, rv_edges):
    t = L["levels"][repr(k)]
    db = dbin(dist(S, j, k))
    vb = vbin(S["rv"], rv_edges)
    p = np.full(len(db), t["base"])
    src = np.zeros(len(db), np.int8)
    for b in np.unique(db):
        mb = db == b
        pd_ = t["pooled_d"].get(str(int(b)))
        if pd_ and pd_[1] >= MIN_BIN:
            p[mb] = pd_[0] / pd_[1]
            src[mb] = 1
        for v in np.unique(vb[mb]):
            c = t["cells"].get(f"{int(b)}|{int(v)}")
            if c and c[1] >= MIN_BIN:
                mv = mb & (vb == v)
                p[mv] = c[0] / c[1]
                src[mv] = 2
    return p, src


# =============================================================================================
# statistics
# =============================================================================================
def weeks(ts):
    w = R12.wk(ts)
    _, g = np.unique(w, return_inverse=True)
    return g, int(g.max()) + 1


def alert_stats(alert, y, g, G, idx, ref=None):
    """precision P(cross | alert), recall P(alert | cross), alert rate; weekly block bootstrap."""
    al = alert.astype(float)
    na = np.bincount(g, weights=al, minlength=G)
    nc = np.bincount(g, weights=al * y, minlength=G)
    ny = np.bincount(g, weights=y, minlength=G)
    nn = np.bincount(g, minlength=G).astype(float)
    P = float(nc.sum() / na.sum()) if na.sum() > 0 else None
    out = {"rows": int(len(y)), "alerts": int(al.sum()), "alert_rate": float(al.mean()), "crosses": int(y.sum()),
           "crosses_flagged": int((al * y).sum()), "precision": P,
           "recall": float(nc.sum() / ny.sum()) if ny.sum() > 0 else None,
           "base_rate": float(y.mean()), "alert_weeks": int((na > 0).sum()),
           "false_alarm_rate": float((al * (1 - y)).sum() / max((1 - y).sum(), 1))}
    if P is None or idx is None:
        return out
    with np.errstate(invalid="ignore", divide="ignore"):
        Pb = nc[idx].sum(1) / na[idx].sum(1)
        Rb = nc[idx].sum(1) / ny[idx].sum(1)
    out["precision_ci90"] = [float(np.nanquantile(Pb, 0.05)), float(np.nanquantile(Pb, 0.95))]
    out["precision_ci95"] = [float(np.nanquantile(Pb, 0.025)), float(np.nanquantile(Pb, 0.975))]
    out["precision_boot_sd"] = float(np.nanstd(Pb, ddof=1))
    out["recall_ci90"] = [float(np.nanquantile(Rb, 0.05)), float(np.nanquantile(Rb, 0.95))]
    out["p_likely"] = float((1 + int(np.sum(Pb <= LIKELY))) / (len(Pb) + 1))
    if ref is not None:
        out["ref_B13a"] = ref
        out["diff_vs_ref"] = P - ref
        out["diff_ci90"] = [out["precision_ci90"][0] - ref, out["precision_ci90"][1] - ref]
        out["tost_equivalent"] = bool(out["diff_ci90"][0] >= -TOST_MARGIN and out["diff_ci90"][1] <= TOST_MARGIN)
    return out


def brier_block(P, y, g, G):
    return {m: np.bincount(g, weights=(p - y) ** 2, minlength=G) for m, p in P.items()}


# =============================================================================================
# development (seen data)
# =============================================================================================
def b13a_halves(keys):
    """mechanical split of the development series for the power estimate: A1 fits, A2 checks."""
    return {k: (int(sha256b(("Q26-R12.7-dev:" + k).encode())[:2], 16) % 2) for k in keys}


def cmd_dev(a):
    from scipy.stats import norm
    os.makedirs(a.out, exist_ok=True)
    log = open(os.path.join(a.out, "dev-log.txt"), "a")

    def say(s):
        print(s, flush=True)
        log.write(s + "\n")
        log.flush()
    specs = acq_specs(a.b13a, "manifest-acquire-B13a.json")
    say(f"{now_iso()} R12.7 dev start: B13a (seen) {len(specs)} series")
    res = {"schema": "q26-r127-dev-v1", "prereg": PREREG, "created_utc": now_iso(),
           "inputs": {"b13a_manifest_sha256": sha_file(os.path.join(a.b13a, "manifest-acquire-B13a.json"))},
           "cells": [], "lookup": {}, "rv_edges": None, "power": [], "binance_replay": [], "e_constants": {}}
    G_B = int(a.weeks_b13b)
    z5 = float(norm.ppf(1 - 0.05 / 5))
    z10 = float(norm.ppf(1 - 0.05 / 10))
    for T in HORIZONS:
        t0 = time.time()
        S = stack(specs, T, a.workers)
        g, G = weeks(S["ts"])
        half = b13a_halves(S["keys"])
        h = np.array([half[k] for k in S["sid_key"]])
        say(f"{now_iso()} T={T}: {len(S['ts'])} rows, {len(S['keys'])} series, {G} weeks ({time.time() - t0:.0f}s)")
        if T == 1:
            rvf = S["rv"][np.isfinite(S["rv"])]
            res["rv_edges"] = [float(np.quantile(rvf, 1 / 3)), float(np.quantile(rvf, 2 / 3))]
        rv_edges = np.array(res["rv_edges"])
        res["lookup"][R12.TL[T]] = fit_lookup(S, T, rv_edges)
        L1 = fit_lookup(S, T, rv_edges, mask=h == 0)
        rng = np.random.default_rng(np.random.SeedSequence([SEED, T, 0]))
        idx = rng.integers(0, G, size=(2000, G))
        m2 = h == 1
        g2, G2 = weeks(S["ts"][m2])
        idx2 = rng.integers(0, G2, size=(2000, G2))
        res["e_constants"][R12.TL[T]] = {}
        for j, k in enumerate(ALL_K):
            y = S["yW"][:, j].astype(float)
            dd = dist(S, j, k)
            alert = dd <= 0
            st = alert_stats(alert, y, g, G, idx)
            e_k = float(y.mean())
            res["e_constants"][R12.TL[T]][repr(k)] = e_k
            pc, src = apply_lookup(res["lookup"][R12.TL[T]], S, j, k, rv_edges)
            P = {"Rcal": pc, "Rbit": alert.astype(float), "fHA": S["fHAW"][:, j].astype(float),
                 "fH": S["fHW"][:, j].astype(float), "f": S["fW"][:, j].astype(float),
                 "a": S["aW"][:, j].astype(float), "e": np.full(len(y), e_k)}
            se = {m_: float(np.mean((p - y) ** 2)) for m_, p in P.items()}
            cell = {"T": R12.TL[T], "level": k, "rows": int(len(y)), "weeks": G, "rbit": st,
                    "brier": se, "bss_vs_e_in_sample": {m_: 1 - v / se["e"] for m_, v in se.items()},
                    "R": {m_: float(p.sum() / y.sum()) if y.sum() > 0 else None for m_, p in P.items()},
                    "rcal_in_sample_note": "R-cal here is fitted on these rows (in-sample); power uses the A1/A2 split",
                    "lookup_source_share": {"cell": float(np.mean(src == 2)), "pooled_d": float(np.mean(src == 1)),
                                            "base": float(np.mean(src == 0))}}
            # power: lookup fitted on A1 series, evaluated on A2 series
            y2 = y[m2]
            S2 = {kk: (v[m2] if isinstance(v, np.ndarray) and len(v) == len(m2) else v) for kk, v in S.items()}
            p2, _ = apply_lookup(L1, S2, j, k, rv_edges)
            P2 = {"Rcal": p2, "fHA": P["fHA"][m2], "fH": P["fH"][m2], "a": P["a"][m2], "e": np.full(len(y2), e_k)}
            pw = {"T": R12.TL[T], "level": k, "rows_A2": int(len(y2)), "weeks_A2": G2,
                  "R_Rcal_A2": float(p2.sum() / y2.sum()) if y2.sum() > 0 else None, "vs": {}}
            zf = z5 if T == 1 else z10
            for c in ("fHA", "fH", "a", "e"):
                dv = (P2["Rcal"] - y2) ** 2 - (P2[c] - y2) ** 2
                Sb = np.bincount(g2, weights=dv, minlength=G2)
                mu, sd = float(Sb.mean()), float(Sb.std(ddof=1))
                # weekly sums on B13b scale with the number of series; per-week mean/sd taken from A2 (half the
                # dev series) and doubled to approximate the ~full B13b cross-section
                mu_b, sd_b = 2 * mu, math.sqrt(2) * sd
                powv = float(norm.cdf(math.sqrt(G_B) * (-mu_b) / sd_b - zf)) if sd_b > 0 else None
                pw["vs"][c] = {"bss_A2": 1 - float(np.mean((P2["Rcal"] - y2) ** 2) / np.mean((P2[c] - y2) ** 2)),
                               "week_mean_d": mu, "week_sd_d": sd,
                               "G_star_weeks": float((zf * sd_b / mu_b) ** 2) if mu_b < 0 else None,
                               "power_at_G_B13b": powv}
            pw["power_min"] = min((v["power_at_G_B13b"] or 0.0) if v["week_mean_d"] < 0 else 0.0
                                  for v in pw["vs"].values())
            # R-bit power: H1 (P > 0.5) and TOST (+/-0.05) at the B13b week count, SE scaled by sqrt(G / G_B)
            if st.get("precision_boot_sd"):
                se_b = st["precision_boot_sd"] * math.sqrt(G / G_B)
                pw["rbit_power_likely"] = float(norm.cdf((st["precision"] - LIKELY) / se_b - zf))
                pw["rbit_power_tost"] = float(max(0.0, 2 * norm.cdf(TOST_MARGIN / se_b - norm.ppf(0.95)) - 1))
                pw["rbit_precision_se_at_B13b"] = se_b
            cell["power"] = pw
            res["cells"].append(cell)
            res["power"].append(pw)
            say(f"  {R12.TL[T]} {k:+.2f} alert {st['alert_rate']:.4f} P(cross|alert) {st['precision']} "
                f"ci90 {st.get('precision_ci90')} recall {st['recall']:.3f} | BSS vs e: Rcal(in) "
                f"{cell['bss_vs_e_in_sample']['Rcal']:+.3f} fHA {cell['bss_vs_e_in_sample']['fHA']:+.3f} "
                f"fH {cell['bss_vs_e_in_sample']['fH']:+.3f} Rbit {cell['bss_vs_e_in_sample']['Rbit']:+.3f} | A2 "
                f"R {pw['R_Rcal_A2']:.2f} " + " ".join(f"{c} {pw['vs'][c]['bss_A2']:+.3f}/pw "
                                                       f"{pw['vs'][c]['power_at_G_B13b'] or 0:.2f}" for c in pw["vs"]))
        del S
        json.dump(res, open(os.path.join(a.out, "dev-r127.json"), "w"), indent=1)
    # Binance ETH / BTC replay (seen, reported only; development context for the transfer note)
    bspecs = binance_specs(a.binance) if a.binance else []
    for s in bspecs:
        for T in HORIZONS:
            r = series_rows({"path": s["path"], "T": T, "key": s["key"], "cap": s["cap"]})["rows"]
            if r is None:
                continue
            m = ~r["q2"]
            g, G = weeks(r["ts"][m])
            rng = np.random.default_rng(np.random.SeedSequence([SEED, T, 7]))
            idx = rng.integers(0, G, size=(2000, G))
            for j, k in enumerate(ALL_K):
                y = r["yW"][m, j].astype(float)
                alert = (r["gap"][m] - LNK[k]) <= 0
                st = alert_stats(alert, y, g, G, idx)
                st.update({"pair": s["key"], "T": R12.TL[T], "level": k,
                           "span": [A.iso(int(r["ts"][m].min())), A.iso(int(r["ts"][m].max()))]})
                res["binance_replay"].append(st)
                say(f"  replay {s['key']} {R12.TL[T]} {k:+.2f} alert {st['alert_rate']:.5f} n {st['alerts']} "
                    f"P {st['precision']} recall {st['recall']}")
    res["inputs"]["binance_hours"] = {s["key"]: sha_file(s["path"]) for s in bspecs}
    res["finished_utc"] = now_iso()
    p = os.path.join(a.out, "dev-r127.json")
    json.dump(res, open(p, "w"), indent=1)
    lk = os.path.join(a.out, "lookup-r127.json")
    json.dump({"schema": "q26-r127-lookup-v1", "rv_edges": res["rv_edges"], "d_edges": D_EDGES.tolist(),
               "min_bin": MIN_BIN, "tables": res["lookup"], "e_constants": res["e_constants"],
               "ref_precision_B13a": {f"{c['T']}|{c['level']!r}": c["rbit"]["precision"] for c in res["cells"]},
               "source": "B13a (seen, grade C), all rows of the R12.6 recipe row set"}, open(lk, "w"), indent=1)
    say(f"{now_iso()} done; dev sha256 {sha_file(p)} lookup sha256 {sha_file(lk)}")


# =============================================================================================
# B13b acquisition (outcome-blind; counts only printed)
# =============================================================================================
def parse_kucoin_vol(raw):
    """KuCoin 1 m CSV: time (s), open, close, high, low, volume, turnover -> (open_ms, h, l, c, vol)."""
    rows = [r for r in csv.reader(io.StringIO(raw.decode())) if r and r[0][:1].isdigit()]
    if not rows:
        z = np.zeros(0)
        return np.zeros(0, np.int64), z, z, z, z
    a = np.array([[float(x) for x in r[:6]] for r in rows])
    t = a[:, 0].astype(np.int64)
    t = np.where(t > 10 ** 11, t, t * 1000)
    return t, a[:, 3], a[:, 4], a[:, 2], a[:, 5]


def kucoin_pair_b(a):
    base, out = a
    pair = base + "USDT"
    path = os.path.join(out, f"{pair}.npz")
    if os.path.exists(path + ".meta.json"):
        return json.load(open(path + ".meta.json"))
    keys = [k for k in W.s3_keys("kucoin", f"data/spot/daily/klines/{pair}/1m/", delimiter=False)
            if k.endswith(".zip") and k.rsplit("-1m-", 1)[-1][:10] < "2026-10-01"]
    files, parts, vols = [], [], []

    def one(k):
        raw = W.http_get(W.KC_ROOT + k)
        ck = W.http_get(W.KC_ROOT + k + ".CHECKSUM").decode().split()[0].lower()
        h = hashlib.md5(raw).hexdigest() if len(ck) == 32 else sha256b(raw)
        if h != ck:
            raise SystemExit(f"STOP: {k} checksum {h} != CHECKSUM {ck}")
        z = zipfile.ZipFile(io.BytesIO(raw))
        return k, ck, sha256b(raw), parse_kucoin_vol(z.read(z.namelist()[0]))
    with cf.ThreadPoolExecutor(W.KC_THREADS) as ex:
        for k, ck, h, p in ex.map(one, sorted(keys)):
            files.append({"key": k, "checksum": ck, "sha256": h})
            parts.append(p[:4])
            vols.append((p[0], p[4]))
    meta = {"pair": pair, "files": files, "n_files": len(files)}
    g = W.assemble(parts) if parts else None
    if g is None:
        meta["empty"] = True
    else:
        st, c, lo, hi = g
        n = len(c)
        vol = np.full(n, np.nan)
        for tm, v in vols:
            ix = (tm // 1000 - st) // MIN
            ok = (ix >= 0) & (ix < n)
            vol[ix[ok]] = v[ok]
        meta["startTs"] = st
        fin = np.where(np.isfinite(c))[0]
        meta["last_minute_ts"] = int(st + MIN * fin[-1]) if len(fin) else None
        cols = W.hourly_columns(c, lo, hi)
        H = n // 60
        traded = (np.nan_to_num(vol[:H * 60], nan=0.0) > 0).reshape(H, 60).sum(1).astype(float)
        cols["traded"] = np.where(np.isfinite(cols["close"]), traded, np.nan)
        # data-quality (no outcome): zero-volume rows whose close differs from the previous row's close
        prev = np.concatenate([[np.nan], c[:-1]])
        zv = np.isfinite(c) & (np.nan_to_num(vol, nan=1.0) == 0)
        meta["minute_rows"] = int(np.isfinite(c).sum())
        meta["zero_volume_rows"] = int(zv.sum())
        meta["zero_volume_rows_close_moved"] = int((zv & np.isfinite(prev) & (c != prev)).sum())
        meta = W.save_hours(path, pair, st, cols, meta)
        meta["npz_sha256"] = sha_file(path)
    json.dump(meta, open(path + ".meta.json", "w"))
    return meta


def cmd_acquire_b13b(a):
    sel = json.load(open(a.selection))
    bases = sel["B13b"]
    os.makedirs(a.out, exist_ok=True)
    print(f"{now_iso()} acquire B13b: {len(bases)} tickers", flush=True)
    t0 = time.time()
    with cf.ProcessPoolExecutor(a.workers) as ex:
        for j, m in enumerate(ex.map(kucoin_pair_b, [(b, a.out) for b in bases])):
            print(f"  {j + 1}/{len(bases)} files {m['n_files']} hours {m.get('hours')} ({time.time() - t0:.0f}s)",
                  flush=True)
    man = {"schema": "q26-r127-b13b-acq-v1", "set": "B13b", "created_utc": now_iso(),
           "selection_sha256": sha_file(a.selection), "pairs": []}
    for b in bases:
        m = json.load(open(os.path.join(a.out, f"{b}USDT.npz.meta.json")))
        e = {k: m.get(k) for k in ("pair", "n_files", "hours", "null_hours", "startTs", "last_minute_ts",
                                   "npz_sha256", "empty", "minute_rows", "zero_volume_rows",
                                   "zero_volume_rows_close_moved")}
        e["files_sha256"] = sha256b(json.dumps(m["files"], sort_keys=True).encode())
        man["pairs"].append(e)
    p = os.path.join(a.out, "manifest-acquire-B13b.json")
    json.dump(man, open(p, "w"), indent=1)
    tot = {k: sum(int(x.get(k) or 0) for x in man["pairs"]) for k in ("n_files", "hours", "null_hours", "minute_rows",
                                                                        "zero_volume_rows",
                                                                        "zero_volume_rows_close_moved")}
    print(f"{now_iso()} done; totals {tot}; manifest sha256 {sha_file(p)}", flush=True)


# =============================================================================================
# B13b counts-only check
# =============================================================================================
def count_task_b(a):
    """labels and alert flags counted separately (no joint count, no forecast)."""
    d = np.load(a["path"])
    st = int(d["startTs"])
    cols = {k: d[k] for k in ("close", "low", "tw_min", "tw_end", "or_min", "or_end")}
    T, cap = a["T"], a["cap"]
    ser = W.M3.S3(a["key"], a["key"], "kucoin", cols["close"], cols["low"], W.LEVELS, st, st)
    folds = R12.generic_folds(ser, st)
    if not folds:
        return None
    n = ser.N + 1
    Y = {}
    for X in W.TARGETS:
        mn, en = W.TGT_COLS[X]
        Y[X] = A.make_labels(A.spot_series(cols[en]), W.M3.window_min_null_rule(cols[mn], T), W.LEVELS)[:n]
    lab = np.all([np.isfinite(Y[X][:, 0]) for X in W.TARGETS], axis=0)
    ts = st + STEP * np.arange(n)
    inf = np.zeros(n, bool)
    for f in folds:
        inf[f["qs_i"]:min(f["qe_i"], n)] = True
    ok = inf & lab & (ts + T * STEP <= min(END, cap)) & ~((ts + T * STEP > R12.Q2_START) & (ts < R12.Q2_END))
    cl = [W.LEVELS.index(k) for k in ALL_K]
    s_raw, s_w, _, tr = features(d, ts[ok])
    with np.errstate(invalid="ignore", divide="ignore"):
        gap = np.log(s_raw / s_w)
    al = np.stack([(gap - LNK[k]) <= 0 for k in ALL_K], 1).astype(np.int8)
    return {"ts": ts[ok], "W": Y["W"][ok][:, cl].astype(np.int8), "alert": al,
            "liquid": (tr >= LIQ_TRADED_MIN)}


def cmd_counts(a):
    import multiprocessing as mp
    specs = acq_specs(a.acq, "manifest-acquire-B13b.json")
    out = {"schema": "q26-r127-counts-v1", "prereg": PREREG, "created_utc": now_iso(), "set": "B13b",
           "manifest_sha256": sha_file(os.path.join(a.acq, "manifest-acquire-B13b.json")),
           "series_acquired": len(specs), "ended_series": int(sum(s["ended"] for s in specs)), "cells": [],
           "note": "label positives and alert flags are counted separately; no joint count, no forecast, no score"}
    for T in HORIZONS:
        with mp.get_context("fork").Pool(a.workers) as pool:
            res = pool.map(count_task_b, [{**s, "T": T} for s in specs], chunksize=4)
        res = [r for r in res if r is not None and len(r["ts"])]
        ts = np.concatenate([r["ts"] for r in res])
        w = R12.wk(ts)
        liq = np.concatenate([r["liquid"] for r in res])
        for j, k in enumerate(ALL_K):
            y = np.concatenate([r["W"][:, j] for r in res])
            al = np.concatenate([r["alert"][:, j] for r in res])
            c = {"T": R12.TL[T], "level": k, "series": len(res), "validated_origins": int(len(ts)),
                 "weeks": int(len(np.unique(w))), "W_positives": int(y.sum()),
                 "W_positive_weeks": int(len(np.unique(w[y > 0]))), "alerts": int(al.sum()),
                 "alert_weeks": int(len(np.unique(w[al > 0]))), "liquid_origin_share": float(liq.mean())}
            out["cells"].append(c)
            print(f"{c['T']} {k:+.2f} series {c['series']} rows {c['validated_origins']} weeks {c['weeks']} "
                  f"W pos {c['W_positives']}/{c['W_positive_weeks']}w alerts {c['alerts']}/{c['alert_weeks']}w "
                  f"liquid {c['liquid_origin_share']:.3f}", flush=True)
    p = os.path.join(a.out, "counts-r127.json")
    os.makedirs(a.out, exist_ok=True)
    json.dump(out, open(p, "w"), indent=1)
    print("sha256", sha_file(p))


# =============================================================================================
# freeze and the one run
# =============================================================================================
CODE_FILES = ("r127_alert.py", "r126_twap.py", "r12_tail.py", "a6_touch.py", "a3_touch.py", "a2_touch.py",
              "a_touch.py", "r125_fh_deep.py")


def cmd_freeze(a):
    import subprocess
    sha = subprocess.run(["git", "-C", HERE, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    dirty = subprocess.run(["git", "-C", HERE, "status", "--porcelain", "."], capture_output=True,
                           text=True).stdout.strip()
    if dirty:
        raise SystemExit("STOP: worktree not clean")
    lk = json.load(open(os.path.join(a.dev, "lookup-r127.json")))
    cfg = {"schema": "q26-r127-frozen-v1", "prereg": PREREG, "created_utc": now_iso(), "code_sha": sha,
           "code_sha256": {f: sha_file(os.path.join(HERE, f)) for f in CODE_FILES},
           "inputs": {"manifest_B13b_sha256": sha_file(os.path.join(a.acq, "manifest-acquire-B13b.json")),
                      "counts_sha256": sha_file(a.counts),
                      "dev_sha256": sha_file(os.path.join(a.dev, "dev-r127.json")),
                      "lookup_sha256": sha_file(os.path.join(a.dev, "lookup-r127.json"))},
           "rules": {"rbit": "alert = S_raw <= S_W * (1 + k)", "rcal": "lookup-r127.json frequency per (T, k, d "
                     "bucket, rv24 tercile), MIN_BIN fallback to (T, k, d bucket) then (T, k) base",
                     "d_edges": D_EDGES.tolist(), "rv_edges": lk["rv_edges"], "min_bin": MIN_BIN,
                     "twap": "60 one-minute closes, >= 57 rows present; KuCoin zero-volume rows count at their printed "
                             "close", "null_hour": "< 57 one-minute rows", "window_null": "floor(0.05 T) null hours",
                     "tail": "ended series: windows ending in the last 30 days dropped",
                     "liquid_sensitivity": f">= {LIQ_TRADED_MIN} traded minutes in the hour before t (reported)"},
           "e_constants": lk["e_constants"], "ref_precision_B13a": lk["ref_precision_B13a"],
           "tests": {"H1_likely": f"P(cross|alert) > {LIKELY}: weekly bootstrap p, Holm 1 h family 5, 3 h/6 h family 10",
                     "H2_transfer": f"90% weekly-bootstrap CI of P_B13b - P_B13a inside +/-{TOST_MARGIN}",
                     "H3_rcal": "R-cal beats fHA, fH, a, e: mean d < 0, cell p = max(boot, CR1) over 4 comparators, "
                                "Holm 1 h family 5 (3 h/6 h family 10), R in [0.8, 1.25], >= 30 positive weeks"},
           "seed": SEED, "n_boot": N_BOOT}
    os.makedirs(a.out, exist_ok=True)
    p = os.path.join(a.out, "frozen-r127-config.json")
    json.dump(cfg, open(p, "w"), indent=1)
    print(p, sha_file(p), cfg["created_utc"])


def cmd_run(a):
    cfg_path = os.path.join(a.cfgdir, "frozen-r127-config.json")
    cfg = json.load(open(cfg_path))
    lk = json.load(open(os.path.join(a.cfgdir, "lookup-r127.json")))
    if sha_file(os.path.join(a.cfgdir, "lookup-r127.json")) != cfg["inputs"]["lookup_sha256"]:
        raise SystemExit("STOP: lookup sha256 differs from the frozen config")
    os.makedirs(a.out, exist_ok=True)
    log = open(os.path.join(a.out, "run-log.txt"), "a")

    def say(x):
        print(x, flush=True)
        log.write(x + "\n")
        log.flush()
    t_start = now_iso()
    say(f"{t_start} R12.7 run start; frozen config sha256 {sha_file(cfg_path)}")
    specs = acq_specs(a.acq, "manifest-acquire-B13b.json")
    rv_edges = np.array(lk["rv_edges"])
    res = {"schema": "q26-r127-run-v1", "prereg": PREREG, "utc_start": t_start,
           "frozen_config_sha256": sha_file(cfg_path), "cells": [], "reported_deep": []}
    for T in HORIZONS:
        t0 = time.time()
        S = stack(specs, T, a.workers)
        g, G = weeks(S["ts"])
        yrs = np.array([A.iso(int(t))[:4] for t in S["ts"]])
        liq = S["traded"] >= LIQ_TRADED_MIN
        say(f"{now_iso()} T={T}: {len(S['ts'])} rows, {len(S['keys'])} series, {G} weeks ({time.time() - t0:.0f}s)")
        for j, k in enumerate(ALL_K):
            y = S["yW"][:, j].astype(float)
            alert = dist(S, j, k) <= 0
            ref = lk["ref_precision_B13a"].get(f"{R12.TL[T]}|{k!r}")
            rng = np.random.default_rng(np.random.SeedSequence([SEED, T, j]))
            idx = rng.integers(0, G, size=(N_BOOT, G))
            st = alert_stats(alert, y, g, G, idx, ref=ref)
            e_k = float(lk["e_constants"][R12.TL[T]][repr(k)])
            pc, src = apply_lookup(lk["tables"][R12.TL[T]], S, j, k, rv_edges)
            P = {"Rcal": pc, "fHA": S["fHAW"][:, j].astype(float), "fH": S["fHW"][:, j].astype(float),
                 "a": S["aW"][:, j].astype(float), "e": np.full(len(y), e_k)}
            Prep = {"f": S["fW"][:, j].astype(float), "Rbit": alert.astype(float)}
            se = {m: (p - y) ** 2 for m, p in {**P, **Prep}.items()}
            posw = int((np.bincount(g, weights=y, minlength=G) > 0).sum())
            cell = {"T": R12.TL[T], "level": k, "confirmatory": k in CONF_K, "rows": int(len(y)),
                    "series": int(len(S["keys"])), "positives": int(y.sum()), "weeks": G, "positive_weeks": posw,
                    "rbit": st, "brier": {m: float(v.mean()) for m, v in se.items()},
                    "R": {m: float(p.sum() / y.sum()) if y.sum() > 0 else None for m, p in {**P, **Prep}.items()},
                    "lookup_source_share": {"cell": float(np.mean(src == 2)), "pooled_d": float(np.mean(src == 1)),
                                            "base": float(np.mean(src == 0))}, "vs": {}}
            cell["bss_Rcal"] = {c: 1 - cell["brier"]["Rcal"] / cell["brier"][c] for c in ("fHA", "fH", "a", "e", "f")}
            cell["bss_Rbit"] = {c: 1 - cell["brier"]["Rbit"] / cell["brier"][c] for c in ("fHA", "fH", "a", "e", "f")}
            pm = []
            for c in ("fHA", "fH", "a", "e"):
                d = se["Rcal"] - se[c]
                bt, ct = W.week_tests(g, d, idx)
                cell["vs"][c] = {"mean_d": float(d.mean()), "boot": bt, "cr1": ct,
                                 "dk_hac_reported": R12.dk_hac(S["ts"], d)}
                pm += [bt["p_one_sided"], ct["p_one_sided"] if ct["p_one_sided"] is not None else 1.0]
            cell["rcal_cell_p"] = float(max(pm))
            cell["rcal_all_mean_d_negative"] = bool(all(v["mean_d"] < 0 for v in cell["vs"].values()))
            R_ = cell["R"]["Rcal"]
            cell["rcal_R_in_band"] = bool(R_ is not None and R_BAND[0] <= R_ <= R_BAND[1])
            cell["enough_positive_weeks"] = posw >= MIN_POS_WEEKS
            cell["per_year"] = {}
            for u in np.unique(yrs):
                mm = yrs == u
                gy, Gy = weeks(S["ts"][mm])
                sy = alert_stats(alert[mm], y[mm], gy, Gy, None)
                cell["per_year"][str(u)] = {"rows": int(mm.sum()), "alerts": sy["alerts"],
                                            "precision": sy["precision"], "recall": sy["recall"],
                                            "R_Rcal": float(pc[mm].sum() / y[mm].sum()) if y[mm].sum() > 0 else None,
                                            "bss_Rcal_vs_fHA": 1 - float(se["Rcal"][mm].mean() / se["fHA"][mm].mean())}
            if liq.any():
                gl, Gl = weeks(S["ts"][liq])
                sl = alert_stats(alert[liq], y[liq], gl, Gl, None)
                cell["liquid_sensitivity"] = {"rows": int(liq.sum()), "alerts": sl["alerts"],
                                              "precision": sl["precision"], "recall": sl["recall"],
                                              "alert_rate": sl["alert_rate"]}
            res["cells"].append(cell)
            say(f"  {R12.TL[T]} {k:+.2f} alerts {st['alerts']} P(cross|alert) {st['precision']} ci90 "
                f"{st.get('precision_ci90')} ref {ref} TOST {st.get('tost_equivalent')} recall {st['recall']} | Rcal R "
                f"{R_} p {cell['rcal_cell_p']:.4g} " + " ".join(f"{c} {cell['bss_Rcal'][c]:+.3f}" for c in
                                                                cell["bss_Rcal"]))
        del S
        json.dump(res, open(os.path.join(a.out, "results-r127.json"), "w"), indent=1)
    # verdicts: families 1 h (5 cells) and 3 h + 6 h (10 cells), confirmatory levels only
    for fam, Ts in (("1h", ("1h",)), ("3h6h", ("3h", "6h"))):
        cs = [c for c in res["cells"] if c["confirmatory"] and c["T"] in Ts]
        h1 = R12.holm(np.array([c["rbit"].get("p_likely", 1.0) for c in cs]))
        h3 = R12.holm(np.array([c["rcal_cell_p"] for c in cs]))
        for c, x1, x3 in zip(cs, h1, h3):
            c["family"] = fam
            c["H1_likely_PASS"] = bool(x1 and (c["rbit"]["precision"] or 0) > LIKELY)
            c["H2_transfer_PASS"] = bool(c["rbit"].get("tost_equivalent"))
            c["H3_rcal_holm"] = bool(x3)
            c["H3_rcal_PASS"] = bool(x3 and c["rcal_all_mean_d_negative"] and c["rcal_R_in_band"] and
                                     c["enough_positive_weeks"])
    res["utc_end"] = now_iso()
    p = os.path.join(a.out, "results-r127.json")
    json.dump(res, open(p, "w"), indent=1)
    say(f"{res['utc_end']} done; results sha256 {sha_file(p)}")


def main():
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest="cmd", required=True)
    s = sp.add_parser("select-gate")
    s.add_argument("--datasets", required=True)
    s.add_argument("--out", required=True)
    s = sp.add_parser("dev")
    s.add_argument("--b13a", required=True)
    s.add_argument("--binance", default=None)
    s.add_argument("--out", required=True)
    s.add_argument("--workers", type=int, default=3)
    s.add_argument("--weeks-b13b", type=int, default=132, dest="weeks_b13b")
    s = sp.add_parser("acquire-b13b")
    s.add_argument("--selection", required=True)
    s.add_argument("--out", required=True)
    s.add_argument("--workers", type=int, default=6)
    s = sp.add_parser("counts")
    s.add_argument("--acq", required=True)
    s.add_argument("--out", required=True)
    s.add_argument("--workers", type=int, default=3)
    s = sp.add_parser("freeze")
    s.add_argument("--acq", required=True)
    s.add_argument("--dev", required=True)
    s.add_argument("--counts", required=True)
    s.add_argument("--out", required=True)
    s = sp.add_parser("run")
    s.add_argument("--acq", required=True)
    s.add_argument("--cfgdir", required=True)
    s.add_argument("--out", required=True)
    s.add_argument("--workers", type=int, default=3)
    a = ap.parse_args()
    {"select-gate": cmd_select_gate, "dev": cmd_dev, "acquire-b13b": cmd_acquire_b13b, "counts": cmd_counts,
     "freeze": cmd_freeze, "run": cmd_run}[a.cmd](a)


if __name__ == "__main__":
    main()
