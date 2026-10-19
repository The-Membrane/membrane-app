"""Q26 Round 13, item R13.5: the R13.4 pooled standardized event library on young crypto listings, Gate.io set B14b.

membrane-board design/Q26_ROUND13_PREREG.md (R13.5, Deviations D-R13.5a ...), design/q26-r134-event-library-2026-10-18.md
(R13.4 design), design/q26-blind-set-inventory-2026-10-17.md (sections 12 and 16).

Owner decision (2026-10-19, relayed by the Q26 parent): option B -- reassign the held-back Gate.io set B14b to test the
R13.4 pooled standardized event library on young crypto listings. B14a stays reserved (held back for any revision).

Commands
  verify-bars  Gate.io trade-built bar rules (section "Bar rules") checked on a SEEN sample (Gate pairs of assets that
               are in the seen KuCoin set B13a or the seen Binance pool; no B14 pair): trade-built hourly and daily OHLC
               vs Gate's own REST candlesticks, null intervals vs Gate's zero-volume (flat) candles, and the window-low
               label identity (null-skipping trade bars vs flat-filled REST bars).
  dev-ext      development readings on the SEEN R13.4 development rows only (rows-r134-dev.npz of r134 dev cad651e9):
               the frozen library L_all and the comparators (own), (a), (e), L_cry on the young segment of seen B12
               and B9 for h 1, 3, 5, 10, 20 bars x k -15 .. -40%: per-positive-block effects, the two-way (series x
               block) design effect, R and its SE, concentration (top-5 series share). Input to the power rule.
  plan-b14b    listing data only: per B14b pair, the months to fetch (buy_start month .. first day + 365 + 20 days).
  acquire-b14b outcome-blind acquisition of B14b young windows (trade files streamed, aggregated to hourly and daily
               bars, raw files not stored). Prints counts only (pairs, months, trades, traded days, null hours).
  counts       counts only on B14b with the frozen encoder: rows, positive origins, positive weeks and crash blocks per
               registered cell, the calendar span of young windows. No forecast and no score.
  power        projected power per gate, per cell (joint) and for the family at the B14b counts (D-R13.5a rule).
  run          the one registered run (refuses unless the frozen config sha256 and the code sha match).

Bar rules (fixed in D-R13.5a before any B14b byte)
  B1 trades: rows (time s, id, price, amount, side); rows with price <= 0 or amount <= 0 or a repeated id are dropped
     (counted); sorted by (time, id).
  B2 hourly bar [H, H + 1 h): open = first trade price, high = max, low = min, close = last, n = trades, vol = base
     amount. An hour with no trade is NULL (absent): never zero, never carried forward.
  B3 daily bar (UTC day): the same from the day's trades, plus active hours (hours with >= 1 trade). A day with no
     trade is NULL.
  B4 encoder (v, HAR): a NULL day has no v; the HAR means use present days only (>= 4 of 5, >= 20 of 22, as R13.4).
     An origin needs a traded day t (C_t = last trade of day t).
  B5 window low over t+1..t+h = the minimum traded price over the traded days in the window (a NULL day adds no
     price; it is not a zero and not a gap that voids the window). The window is valid only if day t+h is on or
     before the pair's last acquired day and at least one day in the window traded. This equals the kline
     convention (flat no-trade bars at the last price never set a new minimum), checked in verify-bars.

No address, key or secret is read or written. Raw vendor files are not republished; manifests carry sha256 values.
"""
from __future__ import annotations

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import gzip  # noqa: E402
import hashlib  # noqa: E402
import json  # noqa: E402
import math  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402
import urllib.error  # noqa: E402
import urllib.request  # noqa: E402

import numpy as np  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import r134_library as L4  # noqa: E402

DAY, HOUR = 86400, 3600
GATE_DEALS = "https://download.gatedata.org/spot/deals/{m}/{p}-{m}.csv.gz"
GATE_CANDLES = "https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair={p}&interval={i}&from={a}&to={b}"
UA = {"User-Agent": "curl/8.5.0"}
END_TS = L4.date_days("2026-10-01") * DAY          # acquisition end (exclusive), as P3b-a
YOUNG_DAYS = 365
H_ALL = (1, 3, 5, 10, 20)
LEVELS = (-0.15, -0.20, -0.25, -0.30, -0.40)
COMPS = ("own", "a", "e", "L_cry")                 # required comparators of R13.5
SEED = 2026135


def now_iso():
    return L4.now_iso()


def http_get(url, tries=6, timeout=300):
    """bytes, or None on HTTP 404 (no file for that month)."""
    for k in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if k == tries - 1:
                raise
        except Exception:  # noqa: BLE001
            if k == tries - 1:
                raise
        time.sleep(2 * (k + 1))
    return None


# =============================================================================================
# bar rules B1-B3
# =============================================================================================
def parse_trades(raw):
    """B1: arrays (t, id, price, amount) sorted by (t, id); invalid and duplicate rows dropped. Returns (arr, dropped)."""
    txt = gzip.decompress(raw)
    if not txt.strip():
        return np.zeros((0, 4)), 0
    a = np.loadtxt(txt.splitlines(), delimiter=",", usecols=(0, 1, 2, 3), dtype=np.float64, ndmin=2)
    n0 = len(a)
    a = a[(a[:, 2] > 0) & (a[:, 3] > 0) & np.all(np.isfinite(a), axis=1)]
    o = np.lexsort((a[:, 1], a[:, 0]))
    a = a[o]
    if len(a) > 1:
        keep = np.r_[True, a[1:, 1] != a[:-1, 1]]
        # ids are unique per trade; a repeated id adjacent after sorting by time is a duplicate row
        a = a[keep]
    return a, n0 - len(a)


def agg_bars(a, width):
    """B2/B3: OHLC per interval of `width` seconds from sorted trades. Returns dict of arrays keyed by interval start
    (only intervals with >= 1 trade; absent intervals are NULL by omission)."""
    if len(a) == 0:
        return {k: np.zeros(0) for k in ("t", "o", "h", "l", "c", "n", "v")}
    b = (np.floor(a[:, 0] / width) * width).astype(np.int64)
    u, first, cnt = np.unique(b, return_index=True, return_counts=True)
    last = first + cnt - 1
    p = a[:, 2]
    return {"t": u, "o": p[first], "h": np.maximum.reduceat(p, first), "l": np.minimum.reduceat(p, first),
            "c": p[last], "n": cnt.astype(np.int64), "v": np.add.reduceat(a[:, 3], first)}


def merge_bars(parts):
    """concatenate per-month bar dicts (month files do not overlap in time; an interval split across a file boundary
    cannot occur for hours and UTC days because files are UTC calendar months)."""
    parts = [p for p in parts if len(p["t"])]
    if not parts:
        return {k: np.zeros(0) for k in ("t", "o", "h", "l", "c", "n", "v")}
    out = {k: np.concatenate([p[k] for p in parts]) for k in parts[0]}
    o = np.argsort(out["t"], kind="mergesort")
    return {k: v[o] for k, v in out.items()}


def month_list(y0, m0, y1, m1):
    out = []
    y, m = y0, m0
    while (y, m) <= (y1, m1):
        out.append(f"{y:04d}{m:02d}")
        m += 1
        if m == 13:
            y, m = y + 1, 1
    return out


def day_bars_from_hours(H):
    """daily bars and active-hour counts from hourly bars (identical to aggregating the day's trades directly)."""
    if len(H["t"]) == 0:
        return {k: np.zeros(0) for k in ("t", "o", "h", "l", "c", "n", "v", "ah")}
    d = H["t"] // DAY * DAY
    u, first, cnt = np.unique(d, return_index=True, return_counts=True)
    last = first + cnt - 1
    return {"t": u, "o": H["o"][first], "h": np.maximum.reduceat(H["h"], first),
            "l": np.minimum.reduceat(H["l"], first), "c": H["c"][last], "n": np.add.reduceat(H["n"], first),
            "v": np.add.reduceat(H["v"], first), "ah": cnt.astype(np.int64)}


def daily_grid(D, last_day):
    """B3/B4: a contiguous UTC-day grid from the first traded day to last_day; NULL days are nan (not zero, not
    carried). Returns the R13.4 bar dict (o, h, l, c, valid, gapok, ca) for encode_inputs plus n and active hours."""
    d0 = int(D["t"][0] // DAY)
    nd = int(last_day) - d0 + 1
    idx = (D["t"] // DAY - d0).astype(np.int64)
    keep = idx < nd
    out = {k: np.full(nd, np.nan) for k in ("o", "h", "l", "c")}
    for k in ("o", "h", "l", "c"):
        out[k][idx[keep]] = D[k][keep]
    n = np.zeros(nd, np.int64)
    n[idx[keep]] = D["n"][keep]
    ah = np.zeros(nd, np.int64)
    ah[idx[keep]] = D["ah"][keep]
    valid = n >= 1
    B = {"d": (d0 + np.arange(nd)).astype(np.int32), "valid": valid, "gapok": np.zeros(nd, bool),
         "ca": np.zeros(nd, bool), "n": n, "ah": ah, **out}
    B["cap_day"] = int(last_day) + 1
    return B


def window_low(l, valid, h):
    """B5: min traded low over t+1..t+h skipping NULL days; nan if no day in the window traded or the window runs past
    the grid."""
    n = len(l)
    out = np.full(n, np.nan)
    if n <= h:
        return out
    from numpy.lib.stride_tricks import sliding_window_view
    W = sliding_window_view(np.where(valid, l, np.inf)[1:], h)
    r = W.min(axis=1)
    r[~np.isfinite(r)] = np.nan
    out[:len(r)] = r
    return out


def encode_inputs_gate(B):
    """R13.4 encode_inputs with the B4/B5 rules: NULL days carry no v (HAR needs 20 of 22 / 4 of 5 present days) and
    the window low skips NULL days (B5). Everything else is the frozen R13.4 encoder (gapok False: crypto has no open
    gap; no corporate actions)."""
    E = L4.encode_inputs(B)
    valid = B["valid"]
    lc = E["lc"]
    for hh in H_ALL:
        F = E["fwd"][hh]
        wm = window_low(B["l"], valid, hh)
        end_day = F["end_day"]
        F["wmin"] = wm
        F["ok"] = np.isfinite(wm) & E["okX"] & np.isfinite(lc) & (end_day + 1 <= B["cap_day"])
    return E


# =============================================================================================
# verify-bars (seen sample only)
# =============================================================================================
SEEN_SAMPLE = {
    # Gate pairs of assets that are in seen sets (B13a on KuCoin; the Binance seen pool). None is in B14a/B14b
    # (B14 excludes every base on Binance or in a KuCoin USDT folder).
    "liquid": ["1INCH_USDT"],
    "thin": ["ROOBEE_USDT", "BDX_USDT", "MTRG_USDT", "POLK_USDT", "GAFI_USDT", "CHEQ_USDT", "NIM_USDT", "DMTR_USDT",
             "ALU_USDT"],
}
VERIFY_MONTHS_DAILY = ("202203", "202401", "202506")
VERIFY_MONTH_HOURLY = "202608"


def rest_candles(pair, interval, a, b):
    raw = http_get(GATE_CANDLES.format(p=pair, i=interval, a=a, b=b))
    rows = json.loads(raw) if raw else []
    if isinstance(rows, dict):
        return {"err": rows}
    # Gate: [t, quote vol, close, high, low, open, base vol, closed]
    return {int(r[0]): (float(r[5]), float(r[3]), float(r[4]), float(r[2]), float(r[6])) for r in rows}


def month_bounds(m):
    y, mm = int(m[:4]), int(m[4:])
    a = L4.date_days(f"{y:04d}-{mm:02d}-01") * DAY
    y2, m2 = (y + 1, 1) if mm == 12 else (y, mm + 1)
    return a, L4.date_days(f"{y2:04d}-{m2:02d}-01") * DAY


def cmp_bars(mine, rest, width, a, b):
    """compare trade-built bars with REST candles over [a, b). Returns counts of matches and mismatches."""
    got = {int(t): i for i, t in enumerate(mine["t"])}
    res = {"intervals": 0, "traded": 0, "ohlc_exact": 0, "ohlc_mismatch": 0, "vol_rel_max": 0.0,
           "rest_flat_zero_vol": 0, "null_and_rest_zero_vol": 0, "null_but_rest_volume": 0, "traded_but_rest_zero": 0,
           "rest_missing": 0, "examples": []}
    for t in range(a, b, width):
        res["intervals"] += 1
        r = rest.get(t)
        if r is None:
            res["rest_missing"] += 1
            continue
        zero = r[4] == 0.0
        res["rest_flat_zero_vol"] += int(zero)
        if t in got:
            i = got[t]
            res["traded"] += 1
            if zero:
                res["traded_but_rest_zero"] += 1
            mo = (mine["o"][i], mine["h"][i], mine["l"][i], mine["c"][i])
            ok = all(abs(x - y) <= 1e-12 * max(abs(y), 1e-30) + 1e-15 for x, y in zip(mo, r[:4]))
            res["ohlc_exact" if ok else "ohlc_mismatch"] += 1
            if not ok and len(res["examples"]) < 5:
                res["examples"].append({"t": t, "mine": list(map(float, mo)), "rest": list(r[:4])})
            if r[4] > 0:
                res["vol_rel_max"] = max(res["vol_rel_max"], abs(mine["v"][i] / r[4] - 1))
        else:
            res["null_and_rest_zero_vol" if zero else "null_but_rest_volume"] += 1
    return res


def cmd_verify_bars(a):
    out = {"created_utc": now_iso(), "code_sha": L4.git_sha(), "sample": SEEN_SAMPLE, "daily": {}, "hourly": {},
           "label_identity": {}, "file_sha256": {}}
    pairs = SEEN_SAMPLE["liquid"] + SEEN_SAMPLE["thin"]
    for p in pairs:
        months = list(VERIFY_MONTHS_DAILY) + [VERIFY_MONTH_HOURLY]
        for m in months:
            raw = http_get(GATE_DEALS.format(p=p, m=m))
            if raw is None:
                out["daily"][f"{p}/{m}"] = {"file": "absent (404)"}
                continue
            out["file_sha256"][f"{p}-{m}"] = hashlib.sha256(raw).hexdigest()
            tr, dropped = parse_trades(raw)
            H = agg_bars(tr, HOUR)
            D = agg_bars(tr, DAY)
            Dh = day_bars_from_hours(H)
            a0, b0 = month_bounds(m)
            same = bool(len(D["t"]) == len(Dh["t"]) and np.all(D["t"] == Dh["t"]) and
                        all(np.array_equal(D[k], Dh[k]) for k in ("o", "h", "l", "c", "n")))
            rd = rest_candles(p, "1d", a0, b0 - DAY)
            if "err" in rd:
                out["daily"][f"{p}/{m}"] = {"rest_err": rd["err"]}
            else:
                r = cmp_bars(D, rd, DAY, a0, b0)
                r.update(trades=int(len(tr)), dropped=int(dropped), day_from_hours_identical=same)
                out["daily"][f"{p}/{m}"] = r
            if m == VERIFY_MONTH_HOURLY:
                # REST hourly reaches 10,000 points back; one request per 20 days
                rh = {}
                for s in range(a0, b0, 20 * DAY):
                    part = rest_candles(p, "1h", s, min(s + 20 * DAY, b0) - HOUR)
                    if "err" in part:
                        rh = part
                        break
                    rh.update(part)
                    time.sleep(0.2)
                out["hourly"][f"{p}/{m}"] = rh if "err" in rh else cmp_bars(H, rh, HOUR, a0, b0)
                if "err" not in rh:
                    # hourly-grid label identity (many NULL hours on thin pairs): B5 null-skipping window low over
                    # trade-built hours vs the window low over Gate's flat-filled REST hours
                    grid = np.arange(a0, b0, HOUR)
                    pos = {int(t): i for i, t in enumerate(H["t"])}
                    lm = np.array([H["l"][pos[t]] if t in pos else np.nan for t in grid.tolist()])
                    lr = np.array([rh.get(int(t), (np.nan,) * 5)[2] for t in grid])
                    hl = {}
                    for T in (24, 72, 120, 240):
                        w1 = window_low(lm, np.isfinite(lm), T)
                        w2 = window_low(lr, np.isfinite(lr), T)
                        okb = np.isfinite(w1) & np.isfinite(w2)
                        hl[f"T{T}h"] = {"windows": int(okb.sum()), "identical": int(np.sum(w1[okb] == w2[okb])),
                                        "null_hours": int(np.isnan(lm).sum())}
                    out["label_identity_hourly"] = out.get("label_identity_hourly", {})
                    out["label_identity_hourly"][p] = hl
            print(f"{now_iso()} {p} {m}: trades {len(tr)} dropped {dropped}", flush=True)
            time.sleep(0.2)
        # label identity on the hourly month's daily bars: B5 (null-skipping) vs REST flat-filled daily bars
        m = VERIFY_MONTH_HOURLY
        raw = http_get(GATE_DEALS.format(p=p, m=m))
        if raw is None:
            continue
        tr, _ = parse_trades(raw)
        D = day_bars_from_hours(agg_bars(tr, HOUR))
        a0, b0 = month_bounds(m)
        if len(D["t"]) == 0:
            continue
        G = daily_grid(D, (b0 - DAY) // DAY)
        rd = rest_candles(p, "1d", a0, b0 - DAY)
        if "err" in rd:
            continue
        rl = np.array([rd.get(int(d) * DAY, (np.nan,) * 5)[2] for d in G["d"]])
        res = {}
        for hh in H_ALL:
            mine = window_low(G["l"], G["valid"], hh)
            ref = window_low(rl, np.isfinite(rl), hh)          # REST prints a flat bar for every day
            okb = np.isfinite(mine) & np.isfinite(ref)
            res[f"h{hh}"] = {"windows": int(okb.sum()), "identical": int(np.sum(mine[okb] == ref[okb])),
                             "null_days": int((~G["valid"]).sum())}
        out["label_identity"][p] = res
    L4.write_json(a.out, out)
    tot = {"daily_traded": 0, "daily_exact": 0, "hourly_traded": 0, "hourly_exact": 0, "null_vs_flat": 0,
           "null_but_volume": 0, "traded_but_zero": 0}
    for v in out["daily"].values():
        if "traded" in v:
            tot["daily_traded"] += v["traded"]
            tot["daily_exact"] += v["ohlc_exact"]
            tot["null_vs_flat"] += v["null_and_rest_zero_vol"]
            tot["null_but_volume"] += v["null_but_rest_volume"]
            tot["traded_but_zero"] += v["traded_but_rest_zero"]
    for v in out["hourly"].values():
        if "traded" in v:
            tot["hourly_traded"] += v["traded"]
            tot["hourly_exact"] += v["ohlc_exact"]
            tot["null_vs_flat"] += v["null_and_rest_zero_vol"]
            tot["null_but_volume"] += v["null_but_rest_volume"]
            tot["traded_but_zero"] += v["traded_but_rest_zero"]
    print(json.dumps(tot))
    li = [(k, h, v["windows"], v["identical"]) for k, x in out["label_identity"].items() for h, v in x.items()]
    lh = [(k, h, v["windows"], v["identical"], v["null_hours"]) for k, x in out.get("label_identity_hourly", {}).items()
          for h, v in x.items()]
    print("label identity daily: windows", sum(x[2] for x in li), "identical", sum(x[3] for x in li))
    print("label identity hourly: windows", sum(x[2] for x in lh), "identical", sum(x[3] for x in lh),
          "null hours", sum(x[4] for x in lh) // 4)
    print(f"sha256 {L4.sha256_file(a.out)}")


# =============================================================================================
# development extension on SEEN rows only (D-R13.5a inputs)
# =============================================================================================
def load_rows(path, hh, keys=("cls", "sid", "day", "end", "m", "s", "age", "q2")):
    z = np.load(path)
    return {k: z[f"h{hh}_{k}"] for k in keys}


def fit_lambda(lib_c, lib_src):
    zz = np.array([z for z in L4.Z_GRID if -4.0 <= z <= -1.5])
    Fc = L4.wecdf_at(lib_c, zz)
    return min(((float(np.sum((np.log(Fc) - np.log(np.maximum(L4.wecdf_at(lib_src, zz / l_), 1e-12))) ** 2)), float(l_))
                for l_ in np.arange(0.5, 2.01, 0.01)))[1]


def cell_matrix(si, bi, vals, S, G):
    from scipy.sparse import coo_matrix
    return coo_matrix((vals, (si, bi)), shape=(S, G)).tocsr()


def boot_twoway(si, bi, num, den, S, G, nb, seed, mode="two"):
    """bootstrap draws of sum(num)/sum(den) with series weights x block weights (mode 'two'), series only ('series')
    or blocks only ('block'). Pigeonhole two-way bootstrap: a row's weight = (times its series is drawn) x (times its
    block is drawn)."""
    An = cell_matrix(si, bi, num, S, G)
    Ad = cell_matrix(si, bi, den, S, G)
    rng = np.random.default_rng(seed)
    out = np.empty(nb)
    for a0 in range(0, nb, 500):
        k = min(500, nb - a0)
        if mode in ("two", "block"):
            Wb = np.stack([np.bincount(rng.integers(0, G, G), minlength=G) for _ in range(k)], 1).astype(float)
        else:
            Wb = np.ones((G, k))
        if mode in ("two", "series"):
            Ws = np.stack([np.bincount(rng.integers(0, S, S), minlength=S) for _ in range(k)], 1).astype(float)
        else:
            Ws = np.ones((S, k))
        nn = np.sum(Ws * (An @ Wb), axis=0)
        dd = np.sum(Ws * (Ad @ Wb), axis=0)
        out[a0:a0 + k] = nn / np.maximum(dd, 1e-300)
    return out


def predictions_for(R, sc, zk, libs, lam, e_const):
    """forecasts on rows sc: L_all, L_cry, L_all_lam (reported), (e), (own), (a)."""
    J = len(LEVELS)
    P = {nm: np.stack([L4.wecdf_at(lib, zk[sc, j]) for j in range(J)], 1) for nm, lib in libs.items()}
    P["L_all_lam"] = np.stack([L4.wecdf_at(libs["L_all"], zk[sc, j] / lam) for j in range(J)], 1)
    P["e"] = np.tile(e_const, (len(sc), 1))
    Y = (R["m"][sc][:, None] <= zk[sc]).astype(float)
    own = np.full((len(sc), J), np.nan)
    pa = np.full_like(own, np.nan)
    sids = R["sid"][sc]
    for s_ in np.unique(sids):
        ii = np.where(sids == s_)[0]
        ii = ii[np.argsort(R["day"][sc[ii]], kind="mergesort")]
        rr = sc[ii]
        own[ii] = L4.own_ecdf_asof(R["day"][rr], R["end"][rr], R["m"][rr], zk[rr])
        pa[ii] = L4.own_freq_asof(R["day"][rr], R["end"][rr], Y[ii])
    P["own"], P["a"] = own, pa
    return P, Y


def cell_stats(ts, sid, y, P, hh, nb, seed, top_frac=0.025):
    """per-cell development statistics of L_all vs each required comparator on rows (ts, sid, y)."""
    import r12_tail as R12  # noqa: E402
    bid, G, posb = R12.crash_blocks(ts, sid, y.astype(np.int8), hh * 24)
    su, si = np.unique(sid, return_inverse=True)
    S = len(su)
    e = {"rows": int(len(y)), "pos": int(y.sum()), "series": int(S), "blocks": int(G), "pos_blocks": int(posb.sum()),
         "R": {}, "brier": {}, "vs": {}}
    for n_, p in P.items():
        e["R"][n_] = float(p.sum() / max(y.sum(), 1))
        e["brier"][n_] = L4.brier(p, y)
    pL = P["L_all"]
    lr = np.log(np.maximum(boot_twoway(si, bid, pL, y, S, G, nb, seed), 1e-12))
    e["se_lnR_two"] = float(np.std(lr))
    for c in [x for x in P if x != "L_all"]:
        d = (pL - y) ** 2 - (P[c] - y) ** 2
        sums = np.bincount(bid, weights=d, minlength=G)
        sp = sums[posb]
        m_b = float(sp.mean()) if len(sp) else float("nan")
        s_b = float(sp.std(ddof=1)) if len(sp) > 1 else float("nan")
        one = np.ones(len(d))
        v2 = float(np.var(boot_twoway(si, bid, d, one, S, G, nb, seed + 1, "two")))
        vb = float(np.var(boot_twoway(si, bid, d, one, S, G, nb, seed + 2, "block")))
        vs = float(np.var(boot_twoway(si, bid, d, one, S, G, nb, seed + 3, "series")))
        # concentration: drop the top series by gain (most negative summed d), k = ceil(top_frac x S)
        gs = np.bincount(si, weights=d, minlength=S)
        k = max(1, int(math.ceil(top_frac * S)))
        top = np.argsort(gs)[:k]
        keep = ~np.isin(si, top)
        sums_lo = np.bincount(bid[keep], weights=d[keep], minlength=G)[posb]
        e["vs"][c] = {"bss": float(1 - e["brier"]["L_all"] / e["brier"][c]) if e["brier"][c] > 0 else None,
                      "mean_d": float(d.mean()), "m_b": m_b, "s_b": s_b, "var_two": v2, "var_block": vb,
                      "var_series": vs, "deff": float(v2 / vb) if vb > 0 else None,
                      "top_k": k, "top_share_of_gain": float(gs[top].sum() / gs.sum()) if gs.sum() != 0 else None,
                      "m_b_leave_top": float(sums_lo.mean()) if len(sums_lo) else None,
                      "series_with_gain": int(np.sum(gs < 0))}
    return e


def cmd_dev_ext(a):
    meta = json.load(open(a.meta))["series"]
    subs = np.array([m["sub"] for m in meta])
    out = {"created_utc": now_iso(), "code_sha": L4.git_sha(), "rows_sha256": L4.sha256_file(a.rows),
           "note": "development on SEEN rows only (r134 dev cad651e9); young segment of B12 and B9 pooled", "cells": {}}
    for hh in H_ALL:
        R = load_rows(a.rows, hh)
        keep = ~R["q2"]
        isc = R["cls"] == 0
        zk = np.stack([np.log(1 + k) / R["s"] for k in LEVELS], 1)
        parts = []
        for scored in ("b12", "b9"):
            ids = np.where(subs == scored)[0]
            insc = isc & np.isin(R["sid"], ids)
            libmask = keep & ~insc
            libs = {"L_all": L4.pooled_lib(R, libmask, classes=list(L4.CLASSES)),
                    "L_cry": L4.pooled_lib(R, libmask, classes=["crypto"])}
            lam = fit_lambda(libs["L_cry"], libs["L_all"])
            Yall = (R["m"][:, None] <= zk).astype(float)
            e_const = Yall[libmask & isc].mean(axis=0)
            sc = np.where(insc & keep)[0]
            P, Y = predictions_for(R, sc, zk, libs, lam, e_const)
            young = (R["age"][sc] < YOUNG_DAYS) & np.isfinite(P["own"][:, 0]) & np.isfinite(P["a"][:, 0])
            parts.append((sc[young], {k_: v[young] for k_, v in P.items()}, Y[young], lam))
            print(f"{now_iso()} h{hh} {scored}: young rows {int(young.sum())} lambda {lam:.2f}", flush=True)
        sc = np.concatenate([p_[0] for p_ in parts])
        P = {k_: np.concatenate([p_[1][k_] for p_ in parts]) for k_ in parts[0][1]}
        Y = np.concatenate([p_[2] for p_ in parts])
        ts = (R["day"][sc].astype(np.int64) + 1) * DAY
        sid = R["sid"][sc]
        for j, k in enumerate(LEVELS):
            PP = {n_: np.clip(v[:, j], 0, 1) for n_, v in P.items()}
            e = cell_stats(ts, sid, Y[:, j], PP, hh, a.nb, SEED + 100 * hh + j)
            e["lambda_by_set"] = [p_[3] for p_ in parts]
            out["cells"][f"h{hh}/{k}"] = e
            print(f"  h{hh} k{k}: pos {e['pos']} posblk {e['pos_blocks']} S {e['series']} R_Lall {e['R']['L_all']:.2f} "
                  + " ".join(f"{c}:bss{v['bss']:+.4f},deff{(v['deff'] or 0):.2f}" for c, v in e["vs"].items()), flush=True)
        del R
    L4.write_json(a.out, out)
    print(f"sha256 {L4.sha256_file(a.out)}")


# =============================================================================================
# B14b plan and outcome-blind acquisition
# =============================================================================================
LOOKBACK_MONTHS = 36
TAIL_DAYS = YOUNG_DAYS + max(H_ALL) + 1          # first traded day + 386 days covers every young window


def add_months(m, k):
    y, mm = int(m[:4]), int(m[4:])
    t = y * 12 + (mm - 1) + k
    return f"{t // 12:04d}{t % 12 + 1:02d}"


def ym_of_day(day):
    from datetime import datetime, timezone
    d = datetime.fromtimestamp(int(day) * DAY, tz=timezone.utc)
    return f"{d.year:04d}{d.month:02d}"


def acquire_pair(base, buy_start, last_month="202609"):
    """walk back from the buy_start month to the first month with trades (<= 36 months; a 404 or an empty file
    ends the walk), then fetch forward until first traded day + 386 days (capped at 2026-09). Returns bars and a
    per-file manifest. Nothing is printed except counts."""
    pair = f"{base}_USDT"
    m0 = buy_start[:4] + buy_start[5:7]
    files, hourly = {}, []
    # walk back
    first_m = None
    m = m0
    for _ in range(LOOKBACK_MONTHS + 1):
        raw = http_get(GATE_DEALS.format(p=pair, m=m))
        if raw is None:
            break
        tr, drop = parse_trades(raw)
        if len(tr) == 0:
            break
        files[m] = {"sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw), "trades": int(len(tr)),
                    "dropped": int(drop)}
        hourly.append((m, agg_bars(tr, HOUR)))
        first_m = m
        m = add_months(m, -1)
        time.sleep(0.15)
    if first_m is None:
        # no file in the buy_start month: step forward up to 6 months
        m = m0
        for _ in range(6):
            m = add_months(m, 1)
            raw = http_get(GATE_DEALS.format(p=pair, m=m))
            if raw is None:
                continue
            tr, drop = parse_trades(raw)
            if len(tr):
                files[m] = {"sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw), "trades": int(len(tr)),
                            "dropped": int(drop)}
                hourly.append((m, agg_bars(tr, HOUR)))
                first_m = m
                break
    if first_m is None:
        return None, files
    H = merge_bars([h for _, h in hourly])
    first_day = int(H["t"][0] // DAY)
    end_m = min(ym_of_day(first_day + TAIL_DAYS), last_month)
    m = max(files)
    while m < end_m:
        m = add_months(m, 1)
        raw = http_get(GATE_DEALS.format(p=pair, m=m))
        if raw is None:
            files[m] = {"absent": True}
            continue
        tr, drop = parse_trades(raw)
        files[m] = {"sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw), "trades": int(len(tr)),
                    "dropped": int(drop)}
        hourly.append((m, agg_bars(tr, HOUR)))
        time.sleep(0.15)
    H = merge_bars([h for _, h in hourly])
    # last acquired day: the end of the last month fetched (a NULL day inside it is a no-trade day, not missing data)
    last_m = max(files)
    a_, b_ = month_bounds(last_m)
    last_day = min(b_ // DAY - 1, END_TS // DAY - 1)
    return {"H": H, "first_day": first_day, "last_day": last_day}, files


def cmd_acquire_b14b(a):
    sel = json.load(open(a.selection))
    bs = dict(sel["buy_start"])
    os.makedirs(a.out, exist_ok=True)
    manp = os.path.join(a.out, "manifest-b14b.json")
    man = json.load(open(manp)) if os.path.exists(manp) else {"created_utc": now_iso(), "code_sha": L4.git_sha(),
                                                                "set": "B14b", "rules": "r135_young.py B1-B5",
                                                                "series": {}}
    for base in sel["B14b"]:
        if base in man["series"]:
            continue
        got, files = acquire_pair(base, bs[base])
        ent = {"buy_start": bs[base], "files": files}
        if got is None:
            ent["status"] = "no trade file found"
            man["series"][base] = ent
            L4.write_json(manp, man)
            print(f"{now_iso()} {base}: no trade file", flush=True)
            continue
        H = got["H"]
        D = day_bars_from_hours(H)
        fn = os.path.join(a.out, f"gate-{base}_USDT-bars.npz")
        np.savez_compressed(fn, h_t=H["t"], h_o=H["o"], h_h=H["h"], h_l=H["l"], h_c=H["c"], h_n=H["n"], h_v=H["v"],
                            d_t=D["t"], d_o=D["o"], d_h=D["h"], d_l=D["l"], d_c=D["c"], d_n=D["n"], d_v=D["v"],
                            d_ah=D["ah"], first_day=got["first_day"], last_day=got["last_day"])
        span_h = (got["last_day"] - got["first_day"] + 1) * 24
        ent.update(status="ok", file=os.path.basename(fn), sha256=L4.sha256_file(fn), first_day=got["first_day"],
                   last_day=got["last_day"], traded_hours=int(len(H["t"])), null_hours=int(span_h - len(H["t"])),
                   traded_days=int(len(D["t"])), trades=int(H["n"].sum()))
        man["series"][base] = ent
        L4.write_json(manp, man)
        print(f"{now_iso()} {base}: months {len(files)}, trades {ent['trades']}, traded days {ent['traded_days']}, "
              f"null hours {ent['null_hours']}", flush=True)
    man["finished_utc"] = now_iso()
    L4.write_json(manp, man)
    print(f"sha256 manifest {L4.sha256_file(manp)}")


def load_b14b(d):
    man = json.load(open(os.path.join(d, "manifest-b14b.json")))
    out = []
    for base, v in sorted(man["series"].items()):
        if v.get("status") != "ok":
            continue
        z = np.load(os.path.join(d, v["file"]))
        D = {k: z[f"d_{k}"] for k in ("t", "o", "h", "l", "c", "n", "v", "ah")}
        B = daily_grid(D, int(z["last_day"]))
        B.update(key=f"gate:{base}", cls="crypto", sub="B14b", asset=base)
        out.append(B)
    return out, man


def encode_b14b(series, beta):
    """young rows per h with the frozen beta: origins with age < 365 days from the first traded day."""
    rows = {hh: {k: [] for k in ("sid", "day", "end", "m", "s", "age", "q2")} for hh in H_ALL}
    for sid, s in enumerate(series):
        E = encode_inputs_gate(s)
        age = np.arange(len(s["d"]))                     # grid starts at the first traded day
        for hh in H_ALL:
            F = E["fwd"][hh]
            ok = F["ok"] & (age < YOUNG_DAYS)
            if not ok.any():
                continue
            scale = np.sqrt(np.exp(E["X"][ok] @ beta[hh])) * math.sqrt(hh)
            m = (np.log(F["wmin"][ok]) - E["lc"][ok]) / scale
            R = rows[hh]
            R["sid"].append(np.full(ok.sum(), sid, np.int32))
            R["day"].append(s["d"][ok])
            R["end"].append(F["end_day"][ok])
            R["m"].append(m)
            R["s"].append(scale)
            R["age"].append(age[ok])
            R["q2"].append(L4.q2_overlap(s["d"][ok], F["end_day"][ok]))
    return {hh: ({k: np.concatenate(v) for k, v in R.items()} if R["m"] else None) for hh, R in rows.items()}


def own_and_a(R, zk, Y):
    """(own) and (a) as-of per series on non-2026Q2 rows (R13.4 definitions, >= 60 resolved rows)."""
    J = len(LEVELS)
    own = np.full((len(R["m"]), J), np.nan)
    pa = np.full_like(own, np.nan)
    for s_ in np.unique(R["sid"]):
        ii = np.where(R["sid"] == s_)[0]
        ii = ii[np.argsort(R["day"][ii], kind="mergesort")]
        own[ii] = L4.own_ecdf_asof(R["day"][ii], R["end"][ii], R["m"][ii], zk[ii])
        pa[ii] = L4.own_freq_asof(R["day"][ii], R["end"][ii], Y[ii])
    return own, pa


def cmd_counts(a):
    """counts only on B14b: rows, positive origins, positive weeks, crash blocks, series and the calendar span of
    scored young rows per cell. No forecast, no score."""
    import r12_tail as R12  # noqa: E402
    beta = {int(k): np.array(v) for k, v in json.load(open(a.meta))["beta"].items()}
    series, man = load_b14b(a.data)
    rows = encode_b14b(series, beta)
    out = {"created_utc": now_iso(), "code_sha": L4.git_sha(), "note": "counts only (no forecast, no score)",
           "series_ok": len(series), "series_listed": len(man["series"]), "cells": {}}
    for hh in H_ALL:
        R = rows[hh]
        keep = ~R["q2"]
        Rk = {k: v[keep] for k, v in R.items()}
        zk = np.stack([np.log(1 + k) / Rk["s"] for k in LEVELS], 1)
        Y = (Rk["m"][:, None] <= zk).astype(float)
        # scored rows need (own) and (a) defined: >= 60 resolved own rows (a count rule, no outcome used)
        nres = np.zeros(len(Rk["m"]), np.int64)
        for s_ in np.unique(Rk["sid"]):
            ii = np.where(Rk["sid"] == s_)[0]
            ed = np.sort(Rk["end"][ii])
            nres[ii] = np.searchsorted(ed, Rk["day"][ii], side="left")
        sc = nres >= L4.OWN_MIN
        wk_ = L4.week_of(Rk["day"][sc])
        ent = {"rows_young": int(len(Rk["m"])), "rows_scored": int(sc.sum()), "series_scored": int(len(np.unique(Rk["sid"][sc]))),
               "weeks": int(len(np.unique(wk_))), "first_week_day": int(wk_.min() * 7 + L4.MON0D) if sc.any() else None,
               "last_week_day": int(wk_.max() * 7 + L4.MON0D) if sc.any() else None,
               "span_years": float((wk_.max() - wk_.min() + 1) / 52.18) if sc.any() else 0.0,
               "q2_rows_excluded": int((R["q2"]).sum())}
        ts = (Rk["day"][sc].astype(np.int64) + 1) * DAY
        for j, k in enumerate(LEVELS):
            y = Y[sc, j].astype(np.int8)
            if y.sum() == 0:
                ent[f"k{k}"] = {"pos": 0, "pos_blocks": 0}
                continue
            bid, G, posb = R12.crash_blocks(ts, Rk["sid"][sc], y, hh * 24)
            ent[f"k{k}"] = {"pos": int(y.sum()), "pos_weeks": int(len(np.unique(wk_[y > 0]))),
                            "pos_blocks": int(posb.sum()), "blocks": int(G),
                            "pos_series": int(len(np.unique(Rk["sid"][sc][y > 0])))}
        out["cells"][f"h{hh}"] = ent
        print(f"{now_iso()} h{hh}: scored rows {ent['rows_scored']} series {ent['series_scored']} weeks {ent['weeks']} "
              f"span {ent['span_years']:.2f} y; positive blocks " +
              " / ".join(str(ent[f'k{k}']['pos_blocks']) for k in LEVELS), flush=True)
    L4.write_json(a.out, out)
    print(f"sha256 {L4.sha256_file(a.out)}")


def cmd_power(a):
    """projected power at the B14b counts (D-R13.5a rule): every gate, each cell jointly, the family."""
    from scipy.stats import norm
    dev = json.load(open(a.dev))
    cnt = json.load(open(a.counts))
    zh = norm.ppf(1 - 0.05 / 25)
    out = {"created_utc": now_iso(), "code_sha": L4.git_sha(), "dev_sha256": L4.sha256_file(a.dev),
           "counts_sha256": L4.sha256_file(a.counts), "z_holm25": zh, "cells": {}, "secondary_L_cry": {}}
    span_ok = all(c.get("span_years", 0) >= 3.0 for c in cnt["cells"].values())

    def leg(v, Gn, Sn, Gd, Sd, z):
        if not (v["m_b"] < 0) or Gn <= 0:
            return 0.0, None
        deff = max(1.0, 1.0 + ((v["deff"] or 1.0) - 1.0) * max(1.0, (Sd / max(Sn, 1)) / (Gd / Gn)))
        pw = float(norm.cdf(math.sqrt(Gn / deff) * abs(v["m_b"]) / v["s_b"] - z))
        return pw, deff

    for hh in H_ALL:
        c = cnt["cells"][f"h{hh}"]
        for k in LEVELS:
            e = dev["cells"][f"h{hh}/{k}"]
            Gn = c.get(f"k{k}", {}).get("pos_blocks", 0)
            Sn = c.get("series_scored", 0)
            Gd, Sd = e["pos_blocks"], e["series"]
            legs = {}
            for comp in ("own", "a", "e"):
                v = e["vs"][comp]
                pw, deff = leg(v, Gn, Sn, Gd, Sd, zh)
                lo = v.get("m_b_leave_top")
                pc = float(norm.cdf(math.sqrt(Gn / deff) * abs(lo) / v["s_b"])) if (deff and lo is not None and lo < 0) else 0.0
                legs[comp] = {"power_test": pw, "deff_new": deff, "power_concentration": pc,
                              "Gstar_80": float(((zh + 0.8416) * v["s_b"] / v["m_b"]) ** 2 * (deff or 1)) if v["m_b"] < 0 else None}
            lnR, se = math.log(max(e["R"]["L_all"], 1e-9)), e["se_lnR_two"] * math.sqrt(Gd / max(Gn, 1))
            pR = float(norm.cdf((math.log(1.25) - lnR) / se) - norm.cdf((math.log(0.8) - lnR) / se)) if Gn else 0.0
            pblk = 1.0 if Gn >= 30 else 0.0
            ptest = float(np.prod([l_["power_test"] for l_ in legs.values()]))
            pconc = min(l_["power_concentration"] for l_ in legs.values())
            joint = ptest * pR * pconc * pblk * (1.0 if span_ok else 0.0)
            out["cells"][f"h{hh}/{k}"] = {"G_new": Gn, "S_new": Sn, "legs": legs, "power_R_band": pR,
                                          "R_dev": e["R"]["L_all"], "power_blocks30": pblk,
                                          "power_all_tests_product": ptest, "power_concentration_min": pconc,
                                          "power_joint_PASS": joint}
            v = e["vs"]["L_cry"]
            pw, deff = leg(v, Gn, Sn, Gd, Sd, zh)
            out["secondary_L_cry"][f"h{hh}/{k}"] = {"power": pw, "deff_new": deff}
    js = [v["power_joint_PASS"] for v in out["cells"].values()]
    out["span_ok_3y"] = span_ok
    out["family"] = {"rule": "family PASS = at least one cell PASS", "power_lower_bound_max_cell": max(js),
                     "power_upper_bound_independent": float(1 - np.prod([1 - x for x in js])),
                     "cells_at_80": [k for k, v in out["cells"].items() if v["power_joint_PASS"] >= 0.80],
                     "run": bool(max(js) >= 0.80)}
    L4.write_json(a.out, out)
    for k, v in out["cells"].items():
        print(k, "G", v["G_new"], "tests", {c: round(l_["power_test"], 2) for c, l_ in v["legs"].items()},
              "R", round(v["power_R_band"], 2), "conc", round(v["power_concentration_min"], 2),
              "joint", round(v["power_joint_PASS"], 3), "| L_cry", round(out["secondary_L_cry"][k]["power"], 2))
    print(json.dumps(out["family"]))
    print(f"sha256 {L4.sha256_file(a.out)}")


# =============================================================================================
# the one registered run
# =============================================================================================
def frozen_libraries(rows_path):
    """frozen L_all (every dev row of every class, equal class weights), L_cry (crypto dev rows), (e) per (h, k) on
    crypto dev rows, and lambda (crypto vs L_all, reported variant) -- all from SEEN development rows."""
    libs = {}
    for hh in H_ALL:
        R = load_rows(rows_path, hh, keys=("cls", "m", "s", "q2"))
        keep = ~R["q2"]
        La = L4.pooled_lib(R, keep, classes=list(L4.CLASSES))
        Lc = L4.pooled_lib(R, keep, classes=["crypto"])
        isc = (R["cls"] == 0) & keep
        e = np.array([float(np.mean(R["m"][isc] <= np.log(1 + k) / R["s"][isc])) for k in LEVELS])
        libs[hh] = {"L_all": La, "L_cry": Lc, "e": e, "lambda": fit_lambda(Lc, La)}
        del R
    return libs


def cmd_freeze(a):
    libs = frozen_libraries(a.rows)
    meta = json.load(open(a.meta))
    fz = {"created_utc": now_iso(), "code_sha": L4.git_sha(), "item": "Q26 R13.5 (D-R13.5a)",
          "code_sha256": L4.sha256_file(os.path.abspath(__file__)),
          "r134_code_sha256": L4.sha256_file(os.path.abspath(L4.__file__)),
          "dev_rows_sha256": L4.sha256_file(a.rows), "dev_meta_sha256": L4.sha256_file(a.meta),
          "beta": meta["beta"], "e_const": {str(h): v["e"].tolist() for h, v in libs.items()},
          "lambda_crypto": {str(h): v["lambda"] for h, v in libs.items()},
          "library_rows": {str(h): int(len(v["L_all"][0])) for h, v in libs.items()},
          "b14b_manifest_sha256": L4.sha256_file(os.path.join(a.data, "manifest-b14b.json")),
          "counts_sha256": L4.sha256_file(a.counts), "power_sha256": L4.sha256_file(a.power),
          "dev_ext_sha256": L4.sha256_file(a.dev), "seed": SEED, "bootstrap_draws": 10000, "cells": 25,
          "levels": list(LEVELS), "h_bars": list(H_ALL), "young_days": YOUNG_DAYS, "own_min": L4.OWN_MIN,
          "required_comparators": ["own", "a", "e"], "secondary_comparator": "L_cry",
          "reported": ["L_all_lam", "no_own rows vs (e)", "per-year R"],
          "pass": "mean d < 0 vs own, a, e; max p (two-way bootstrap, CR1 blocks) over comparators clears Holm 0.05/25; "
                  "R(L_all) in [0.8, 1.25]; >= 30 positive blocks; leave-top-ceil(2.5% S)-series-out mean d < 0 vs all three"}
    L4.write_json(a.out, fz)
    print(f"sha256 {L4.sha256_file(a.out)}")


def cmd_run(a):
    import r12_tail as R12  # noqa: E402
    fsha = L4.sha256_file(a.frozen)
    if fsha != a.frozen_sha256:
        raise SystemExit(f"frozen config sha256 {fsha} != registered {a.frozen_sha256}")
    fz = json.load(open(a.frozen))
    if L4.git_sha() != fz["code_sha"] or L4.sha256_file(os.path.abspath(__file__)) != fz["code_sha256"]:
        raise SystemExit("code differs from the frozen config")
    if L4.sha256_file(a.rows) != fz["dev_rows_sha256"]:
        raise SystemExit("dev rows differ")
    if L4.sha256_file(os.path.join(a.data, "manifest-b14b.json")) != fz["b14b_manifest_sha256"]:
        raise SystemExit("B14b manifest differs")
    t0 = now_iso()
    print(f"{t0} R13.5 run start; code {fz['code_sha']}; frozen {fsha}", flush=True)
    libs = frozen_libraries(a.rows)
    for hh in H_ALL:
        assert np.allclose(libs[hh]["e"], fz["e_const"][str(hh)], rtol=0, atol=1e-15)
    beta = {int(k): np.array(v) for k, v in fz["beta"].items()}
    series, man = load_b14b(a.data)
    rows = encode_b14b(series, beta)
    from scipy.stats import norm  # noqa: F401
    res = {"created_utc": t0, "code_sha": fz["code_sha"], "frozen_sha256": fsha, "cells": {}, "secondary_L_cry": {}}
    praw, psec = {}, {}
    for hh in H_ALL:
        R = rows[hh]
        keep = ~R["q2"]
        Rk = {k: v[keep] for k, v in R.items()}
        zk = np.stack([np.log(1 + k) / Rk["s"] for k in LEVELS], 1)
        Y = (Rk["m"][:, None] <= zk).astype(float)
        own, pa = own_and_a(Rk, zk, Y)
        L = libs[hh]
        P = {"L_all": np.stack([L4.wecdf_at(L["L_all"], zk[:, j]) for j in range(len(LEVELS))], 1),
             "L_cry": np.stack([L4.wecdf_at(L["L_cry"], zk[:, j]) for j in range(len(LEVELS))], 1),
             "L_all_lam": np.stack([L4.wecdf_at(L["L_all"], zk[:, j] / L["lambda"]) for j in range(len(LEVELS))], 1),
             "e": np.tile(L["e"], (len(Rk["m"]), 1)), "own": own, "a": pa}
        sc = np.isfinite(own[:, 0]) & np.isfinite(pa[:, 0])
        ts = (Rk["day"].astype(np.int64) + 1) * DAY
        yr = (Rk["day"].astype(np.int64) // 365.2425 + 1970).astype(int)
        for j, k in enumerate(LEVELS):
            key = f"h{hh}/{k}"
            y = Y[sc, j]
            sid = Rk["sid"][sc]
            bid, G, posb = R12.crash_blocks(ts[sc], sid, y.astype(np.int8), hh * 24)
            su, si = np.unique(sid, return_inverse=True)
            S = len(su)
            PP = {n_: np.clip(v[sc, j], 0, 1) for n_, v in P.items()}
            e = {"rows": int(sc.sum()), "pos": int(y.sum()), "series": int(S), "blocks": int(G),
                 "pos_blocks": int(posb.sum()), "R": {n_: float(p.sum() / max(y.sum(), 1)) for n_, p in PP.items()},
                 "brier": {n_: L4.brier(p, y) for n_, p in PP.items()}, "vs": {}}
            lr = boot_twoway(si, bid, PP["L_all"], y, S, G, 10000, SEED + 7 * hh + j)
            e["R_L_all_ci90_two_way"] = [float(np.quantile(lr, 0.05)), float(np.quantile(lr, 0.95))]
            for c in ("own", "a", "e", "L_cry", "L_all_lam"):
                d = (PP["L_all"] - y) ** 2 - (PP[c] - y) ** 2
                one = np.ones(len(d))
                T = float(d.mean())
                bt = boot_twoway(si, bid, d, one, S, G, 10000, SEED + 1000 * hh + 10 * j + len(c))
                p2 = (1 + int(np.sum(bt - T <= T))) / (len(bt) + 1)
                cr = R12.cr1_test(bid, d)
                gs = np.bincount(si, weights=d, minlength=S)
                kk = max(1, int(math.ceil(0.025 * S)))
                top = np.argsort(gs)[:kk]
                keepc = ~np.isin(si, top)
                e["vs"][c] = {"bss": float(1 - e["brier"]["L_all"] / e["brier"][c]) if e["brier"][c] > 0 else None,
                              "mean_d": T, "p_two_way": float(p2), "p_cr1": cr["p_one_sided"],
                              "p_cell": float(max(p2, cr["p_one_sided"] if cr["p_one_sided"] is not None else 1.0)),
                              "leave_top_k": kk, "mean_d_leave_top": float(d[keepc].mean()),
                              "series_with_gain": int(np.sum(gs < 0)),
                              "top1_share_of_gain": float(gs.min() / gs.sum()) if gs.sum() < 0 else None}
            e["p_cell_primary"] = max(e["vs"][c]["p_cell"] for c in ("own", "a", "e"))
            praw[key] = e["p_cell_primary"]
            psec[key] = e["vs"]["L_cry"]["p_cell"]
            # reported: per-year R, rows without own history vs (e)
            e["R_by_year"] = {}
            for yy in np.unique(yr[sc]):
                mk = yr[sc] == yy
                if y[mk].sum() > 0:
                    e["R_by_year"][str(int(yy))] = {"R": float(PP["L_all"][mk].sum() / y[mk].sum()), "pos": int(y[mk].sum())}
            no = ~sc
            if no.sum() > 0 and Y[no, j].sum() > 0:
                pe, pl = np.clip(P["e"][no, j], 0, 1), np.clip(P["L_all"][no, j], 0, 1)
                yn = Y[no, j]
                e["no_own_rows"] = {"rows": int(no.sum()), "pos": int(yn.sum()),
                                    "bss_L_all_vs_e": float(1 - L4.brier(pl, yn) / L4.brier(pe, yn)),
                                    "R_L_all": float(pl.sum() / yn.sum())}
            e["fH"] = "not available: young windows have under 365 days of history"
            res["cells"][key] = e
            print(f"{now_iso()} {key}: pos {e['pos']} blk {e['pos_blocks']} R {e['R']['L_all']:.2f} BSS " +
                  " ".join(f"{c}={v['bss']:+.4f}(p{v['p_cell']:.4f})" for c, v in e["vs"].items()), flush=True)

    def holm(pd_):
        ks = sorted(pd_, key=lambda x: pd_[x])
        m_ = len(ks)
        ok, stop = {}, False
        for i, k_ in enumerate(ks):
            thr = 0.05 / (m_ - i)
            if stop or pd_[k_] > thr:
                stop = True
                ok[k_] = False
            else:
                ok[k_] = True
        return ok

    hp, hs = holm(praw), holm(psec)
    npass = 0
    for key, e in res["cells"].items():
        g = {"mean_d_lt0_all3": all(e["vs"][c]["mean_d"] < 0 for c in ("own", "a", "e")),
             "holm": bool(hp[key]), "R_band": 0.8 <= e["R"]["L_all"] <= 1.25, "blocks30": e["pos_blocks"] >= 30,
             "concentration": all(e["vs"][c]["mean_d_leave_top"] < 0 for c in ("own", "a", "e"))}
        e["gates"] = g
        e["PASS"] = all(g.values())
        npass += int(e["PASS"])
        res["secondary_L_cry"][key] = {"mean_d": e["vs"]["L_cry"]["mean_d"], "holm": bool(hs[key]),
                                       "PASS": bool(hs[key] and e["vs"]["L_cry"]["mean_d"] < 0)}
    res["family"] = {"cells_pass": npass, "PASS": npass >= 1}
    res["finished_utc"] = now_iso()
    L4.write_json(a.out, res)
    print(f"{res['finished_utc']} R13.5 run end; cells PASS {npass} of 25; sha256 {L4.sha256_file(a.out)}")


# =============================================================================================
def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("verify-bars")
    p.add_argument("--out", required=True)
    p = sub.add_parser("dev-ext")
    p.add_argument("--rows", required=True)
    p.add_argument("--meta", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--nb", type=int, default=2000)
    p = sub.add_parser("acquire-b14b")
    p.add_argument("--selection", required=True)
    p.add_argument("--out", required=True)
    p = sub.add_parser("counts")
    p.add_argument("--data", required=True)
    p.add_argument("--meta", required=True)
    p.add_argument("--out", required=True)
    p = sub.add_parser("power")
    p.add_argument("--dev", required=True)
    p.add_argument("--counts", required=True)
    p.add_argument("--out", required=True)
    p = sub.add_parser("freeze")
    for x in ("rows", "meta", "data", "counts", "power", "dev", "out"):
        p.add_argument(f"--{x}", required=True)
    p = sub.add_parser("run")
    for x in ("rows", "data", "frozen", "frozen-sha256", "out"):
        p.add_argument(f"--{x}", required=True)
    a = ap.parse_args()
    {"verify-bars": cmd_verify_bars, "dev-ext": cmd_dev_ext, "acquire-b14b": cmd_acquire_b14b, "counts": cmd_counts,
     "power": cmd_power, "freeze": cmd_freeze, "run": cmd_run}[a.cmd](a)


if __name__ == "__main__":
    main()
