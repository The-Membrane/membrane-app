"""Q26 R27: the "at risk" borrower alert tier with hourly checks, a frozen line and one alert per position episode.
DEVELOPMENT ONLY (seen): Aave V3 Polygon label-B rows of R11.1-v5 and the D13 III grids.

Design, rules (R0 2 %, R0v volatility-tiered, R1 already through, R2 refit walk-forward), episode definition, metrics,
intervals, null and judgement rules: membrane-board design/q26-r27-at-risk-hourly-2026-10-25.md (registered before any
score of this script).

  python3 r27_atrisk.py build --datasets DS --scr SCR --work WORK
  python3 r27_atrisk.py m1    --work WORK [--cache M1DIR]       # 1 m touch minutes (free public Binance archive)
  python3 r27_atrisk.py score --work WORK --out OUT [--nb 2000] [--nnull 200] [--nnull2 20]

SCR holds rows-labels.npz (read only). WORK is scratch: episodes and checks with an internal position index (never
published). OUT receives address-free aggregates only (r27-atrisk.json). No address, key or secret is written.
"""
from __future__ import annotations

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import datetime as dt  # noqa: E402
import io  # noqa: E402
import json  # noqa: E402
import math  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402
import urllib.request  # noqa: E402
import zipfile  # noqa: E402

import numpy as np  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "live"))

DAY = 86400
HOUR = 3600
X_BAND = 0.10                 # episode band: TWAP distance d <= 10 %
D_R0 = 0.02                   # R0 threshold
D_HI = 0.05                   # R0v threshold in the top volatility third
M_HI = D_HI / D_R0            # R0v as one score: -d / m, m = 2.5 in the top third, else 1
L_EPS = 0.0025
RIDGE = 1e-3
FIT_LEAD = (1, 24)            # R2 fit label: touch 1 to 24 bars after the check
SEED_BOOT, SEED_NULL = 20261025, 7
REASONS = ["touch", "exit", "act", "liq", "gap", "data", "data_end"]
SHARES = [0.01, 0.02, 0.03, 0.05, 0.07, 0.10, 0.13, 0.16, 0.20, 0.25, 0.30, 0.35, 0.40, 0.50, 0.60, 0.70, 0.80,
          0.90, 1.00]
R0_GRID = [0.005, 0.01, 0.015, 0.02, 0.025, 0.03, 0.035, 0.04, 0.05, 0.06, 0.07, 0.08, 0.10]
DBK = ((0.0, 0.01), (0.01, 0.02), (0.02, 0.035), (0.035, 0.05), (0.05, 0.10001))
DBN = ["0-1%", "1-2%", "2-3.5%", "3.5-5%", "5-10%"]
BUDGETS_FA = (0.05, 0.10)
M1_URL = "https://data.binance.vision/data/spot/monthly/klines/{s}/1m/{s}-1m-{y:04d}-{m:02d}.zip"


def utc(d):
    return int(dt.datetime(d.year, d.month, d.day, tzinfo=dt.timezone.utc).timestamp())


T_LO = utc(dt.date(2022, 3, 16))
T_SC = utc(dt.date(2023, 1, 1))
T_HI = utc(dt.date(2026, 9, 23))
SPLIT = utc(dt.date(2024, 11, 12))
QSTARTS = [utc(dt.date(y, m, 1)) for y in range(2023, 2027) for m in (1, 4, 7, 10)]
QSTARTS = [q for q in QSTARTS if q <= T_HI]


def qname(q):
    return dt.datetime.fromtimestamp(q, dt.timezone.utc).strftime("%Y-%m-%d")


def quarter_of(t):
    """Index into QSTARTS of the scored quarter holding t (-1 before 2023-01-01)."""
    return np.searchsorted(np.asarray(QSTARTS), np.asarray(t, np.int64), side="right") - 1


# =====================================================================================================================
# Episode state machine (pure; unit-tested on synthetic paths)
# =====================================================================================================================
def run_chain(rows, close, low, spot_at, feats_at, band=X_BAND):
    """One position chain on one series. rows: list of dicts in day order with keys day, k, stop (first action or
    liquidation time in (day, day + 1 d], or None), stop_kind ('act' or 'liq'), cont (True if this row continues the
    previous row: same position, same series, next day). close/low: III bar arrays indexed by bar b (bar b opens at
    st + 3600 b), given here as functions of the check time: close_prev(c) = close of the bar that ends at c, low_at(c)
    = low of the bar that opens at c. spot_at(c): spot close of the hour that ends at c. feats_at(c): (u6, dn).

    Returns (episodes, checks). Episode: dict start, end, reason, L, touch (bar open time or -1), row index at start and
    at end. Check: tuple (episode index, c, d, spot_through, u6, dn)."""
    eps, chk = [], []
    ep = None
    for ri, r in enumerate(rows):
        d = r["day"]
        if ep is not None and not r["cont"]:
            ep["end"], ep["reason"], ep["end_row"] = rows[ri - 1]["day"] + DAY, "gap", ri - 1
            eps.append(ep)
            ep = None
        g0 = close(d)
        L_own = g0 * (1.0 + r["k"]) if np.isfinite(g0) else np.nan
        stop = r["stop"] if r["stop"] is not None else math.inf
        touched_today = False
        for h in range(24):
            c = d + h * HOUR
            if c >= stop:
                if ep is not None:
                    ep["end"], ep["reason"], ep["end_row"] = int(stop), r["stop_kind"], ri
                    eps.append(ep)
                    ep = None
                break
            gc, lw = close(c), low(c)
            if not (np.isfinite(gc) and np.isfinite(lw)):
                if ep is not None:
                    ep["end"], ep["reason"], ep["end_row"] = c, "data", ri
                    eps.append(ep)
                    ep = None
                break
            if ep is None:
                if touched_today or not np.isfinite(L_own):
                    continue
                dc = 1.0 - L_own / gc
                if not (0.0 < dc <= band):
                    continue
                ep = {"start": c, "L": L_own, "touch": -1, "start_row": ri}
            else:
                dc = 1.0 - ep["L"] / gc
                if dc > band:
                    ep["end"], ep["reason"], ep["end_row"] = c, "exit", ri
                    eps.append(ep)
                    ep = None
                    continue
            u6, dn = feats_at(c)
            chk.append((len(eps), c, dc, bool(spot_at(c) <= ep["L"]), u6, dn))
            if lw <= ep["L"]:
                ep["touch"], ep["end"], ep["reason"], ep["end_row"] = c, c + HOUR, "touch", ri
                eps.append(ep)
                ep = None
                touched_today = True
    if ep is not None:
        last = rows[-1]["day"]
        ep["end"], ep["reason"], ep["end_row"] = last + DAY, ("data_end" if last >= T_HI else "gap"), len(rows) - 1
        eps.append(ep)
    return eps, chk


# =====================================================================================================================
# build
# =====================================================================================================================
def cmd_build(a):
    import r111v5_labels as LB
    import r23_nearline as N
    import r24_uplift as U
    t0 = time.time()
    Z = np.load(os.path.join(a.scr, "rows-labels.npz"))
    series = [str(x) for x in Z["series"]]
    day, u, hf0, single = Z["day"], Z["u"], Z["hf0"], Z["singleX"]
    kX, yB = Z["kX"], Z["yB"]
    k6 = kX[:, 0].astype(float)
    y6 = yB[:, 0]
    del kX, yB
    actf, liqf = Z["act_first"], Z["liq_first"]
    uni = ~(hf0 < 1.0) & (single >= 0) & (y6 >= 0) & np.isfinite(k6) & (k6 < 0) & (k6 > -0.30)
    vi = np.nonzero(uni)[0]
    print(f"universe rows {len(vi):,} {time.time() - t0:.0f}s", flush=True)
    o = np.lexsort((day[vi], u[vi]))
    vi = vi[o]
    R_day, R_u, R_x, R_k = day[vi], u[vi], single[vi].astype(int), k6[vi]
    R_act, R_liq = actf[vi], liqf[vi]
    del Z, day, u, hf0, single, k6, y6, actf, liqf

    G = {}
    for xi, x in enumerate(series):
        st, g = LB.read_iii(a.datasets, LB.SERIES[x][1])
        cl, lo = np.asarray(g["close"], float), np.asarray(g["low"], float)
        d = json.load(open(os.path.join(a.datasets, N.KLINES[x])))
        st_k = int(d["startTs"])
        kc = np.array([np.nan if v is None else float(v) for v in d["columns"]["close"]])
        ts_all = st + HOUR * np.arange(len(cl), dtype=np.int64)
        f = U.grid_feats(st, cl, ts_all)
        G[xi] = {"st": st, "close": cl, "low": lo, "st_k": st_k, "kc": kc, "u6": f["u6"], "dn": f["dn"]}
    # per-row stop time (first action or liquidation inside the day)
    n = len(vi)
    stop = np.full(n, -1, np.int64)
    stop_kind = np.zeros(n, np.int8)            # 1 act, 2 liq
    for arr, kind in ((R_act, 1), (R_liq, 2)):
        inday = (arr > R_day) & (arr <= R_day + DAY)
        better = inday & ((stop < 0) | (arr < stop))
        stop[better], stop_kind[better] = arr[better], kind
    cont = np.zeros(n, bool)
    cont[1:] = (R_u[1:] == R_u[:-1]) & (R_x[1:] == R_x[:-1]) & (R_day[1:] == R_day[:-1] + DAY)
    # quick skip: rows with no open episode from the previous day and own-line distance > band at all 24 checks
    dmin = np.full(n, np.inf)
    for xi in G:
        m = np.nonzero(R_x == xi)[0]
        gg = G[xi]
        b0 = (R_day[m] - gg["st"]) // HOUR
        cl = gg["close"]
        mn = np.full(len(m), np.inf)
        for h in range(24):
            bi = b0 + h - 1
            ok = (bi >= 0) & (bi < len(cl))
            gc = np.where(ok, cl[np.clip(bi, 0, len(cl) - 1)], np.nan)
            g0 = np.where(b0 - 1 >= 0, cl[np.clip(b0 - 1, 0, len(cl) - 1)], np.nan)
            dd = 1.0 - g0 * (1.0 + R_k[m]) / gc
            mn = np.fmin(mn, np.where(np.isfinite(dd), dd, -1.0))   # non-finite: never skip
        dmin[m] = mn
    near = dmin <= X_BAND
    print(f"rows that can start an episode {int(near.sum()):,} {time.time() - t0:.0f}s", flush=True)

    E = {k: [] for k in ("x", "pos", "start", "end", "reason", "L", "touch", "liq_after", "d_start")}
    C = {k: [] for k in ("ep", "c", "d", "thru", "u6", "dn", "b")}
    # chains: maximal runs of cont rows; process a chain only if some row is near (an episode can only start there)
    starts = np.r_[np.nonzero(~cont)[0], n]
    nchain = 0
    for ci in range(len(starts) - 1):
        s, e = starts[ci], starts[ci + 1]
        if not near[s:e].any():
            continue
        nchain += 1
        xi = int(R_x[s])
        gg = G[xi]
        st, cl, lo, st_k, kc = gg["st"], gg["close"], gg["low"], gg["st_k"], gg["kc"]
        u6a, dna = gg["u6"], gg["dn"]

        def close_prev(c, st=st, cl=cl):
            b = (c - st) // HOUR - 1
            return cl[b] if 0 <= b < len(cl) else np.nan

        def low_at(c, st=st, lo=lo):
            b = (c - st) // HOUR
            return lo[b] if 0 <= b < len(lo) else np.nan

        def spot_at(c, st_k=st_k, kc=kc):
            b = (c - st_k) // HOUR - 1
            return kc[b] if 0 <= b < len(kc) else np.nan

        def feats_at(c, st=st, u6a=u6a, dna=dna):
            b = (c - st) // HOUR
            return (u6a[b], dna[b]) if 0 <= b < len(u6a) else (np.nan, np.nan)

        rows = []
        for i in range(s, e):
            rows.append({"day": int(R_day[i]), "k": float(R_k[i]), "stop": int(stop[i]) if stop[i] > 0 else None,
                         "stop_kind": "act" if stop_kind[i] == 1 else "liq", "cont": i > s})
        eps, chk = run_chain(rows, close_prev, low_at, spot_at, feats_at)
        base = len(E["x"])
        for ep in eps:
            E["x"].append(xi)
            E["pos"].append(int(R_u[s]))
            E["start"].append(ep["start"])
            E["end"].append(ep["end"])
            E["reason"].append(REASONS.index(ep["reason"]))
            E["L"].append(ep["L"])
            E["touch"].append(ep["touch"])
            # real liquidation: the end-day row's first liquidation, if after the start and within 24 h of the end
            lq = int(R_liq[s + ep["end_row"]])
            E["liq_after"].append(lq if (lq > ep["start"] and lq <= ep["end"] + DAY) else -1)
            E["d_start"].append(1.0 - ep["L"] / close_prev(ep["start"]))
        for (ei, c, dc, th, a6, adn) in chk:
            C["ep"].append(base + ei)
            C["c"].append(c)
            C["d"].append(dc)
            C["thru"].append(th)
            C["u6"].append(a6)
            C["dn"].append(adn)
            C["b"].append((c - st) // HOUR)
    print(f"chains {nchain:,} episodes {len(E['x']):,} checks {len(C['c']):,} {time.time() - t0:.0f}s", flush=True)
    # position-day denominators per series x day (universe rows) and near-line rows (own d0 <= 10 %)
    pdk = R_x.astype(np.int64) * 10**6 + R_day // DAY
    upd, cpd = np.unique(pdk, return_counts=True)
    upn, cpn = np.unique(pdk[-R_k <= X_BAND], return_counts=True)
    # position-months (for the share of borrower-months with an alert): distinct (pos, series, month)
    mon = np.array([int(dt.datetime.fromtimestamp(int(t), dt.timezone.utc).strftime("%Y%m")) for t in
                    np.unique(R_day)])
    mon_of_day = dict(zip(np.unique(R_day).tolist(), mon.tolist()))
    R_mon = np.array([mon_of_day[int(t)] for t in R_day])
    pm = np.unique(np.c_[R_u, R_x, R_mon][-R_k <= X_BAND], axis=0)
    os.makedirs(a.work, exist_ok=True)
    np.savez(os.path.join(a.work, "episodes.npz"), **{k: np.asarray(v) for k, v in E.items()})
    np.savez(os.path.join(a.work, "checks.npz"),
             ep=np.asarray(C["ep"], np.int32), c=np.asarray(C["c"], np.int64), d=np.asarray(C["d"], np.float64),
             thru=np.asarray(C["thru"], bool), u6=np.asarray(C["u6"], np.float32),
             dn=np.asarray(C["dn"], np.float32), b=np.asarray(C["b"], np.int32))
    np.savez(os.path.join(a.work, "denoms.npz"), pd_key=upd, pd_n=cpd, pn_key=upn, pn_n=cpn,
             near_posmonths=pm.astype(np.int64))
    np.savez(os.path.join(a.work, "grids.npz"), series=np.array(series),
             **{f"{k}{xi}": G[xi][k] for xi in G for k in ("close", "low", "u6", "dn")},
             **{f"st{xi}": np.int64(G[xi]["st"]) for xi in G})
    print(f"saved {time.time() - t0:.0f}s", flush=True)


# =====================================================================================================================
# m1: touch minute inside the touch bar from 1 m closes (D13 formula), validated against the III bar low
# =====================================================================================================================
def minute_G(lc):
    """lc: list of ln close or None per minute slot. Same as live/d13_twap.minute_G (n >= 50 of 60 slots)."""
    import d13_twap as TW
    return TW.minute_G(lc)


def round10(v):
    return float(f"{v:.10g}")


def cmd_m1(a):
    import r111v5_labels as LB
    E = dict(np.load(os.path.join(a.work, "episodes.npz")))
    Gz = np.load(os.path.join(a.work, "grids.npz"))
    series = [str(x) for x in Gz["series"]]
    tm = np.nonzero((E["touch"] >= 0) & (E["start"] >= T_SC))[0]
    need = {}
    for i in tm.tolist():
        x = int(E["x"][i])
        T = int(E["touch"][i])
        for t in (T - HOUR, T):
            dd = dt.datetime.fromtimestamp(t, dt.timezone.utc)
            need.setdefault((x, dd.year, dd.month), []).append(i)
    cache = a.cache or os.path.join(a.work, "m1tmp")
    os.makedirs(cache, exist_ok=True)
    closes = {}                      # (x, minute open ts) -> close, only for the needed windows
    want = {}
    for i in tm.tolist():
        x, T = int(E["x"][i]), int(E["touch"][i])
        for mts in range(T - 59 * 60, T + 60 * 60, 60):
            want.setdefault(x, set()).add(mts)
    log = {"files": 0, "bytes": 0, "missing_files": []}
    for (x, y, m) in sorted(need):
        sym = LB.SERIES[series[x]][1]
        url = M1_URL.format(s=sym, y=y, m=m)
        p = os.path.join(cache, f"{sym}-{y:04d}-{m:02d}.zip")
        try:
            with urllib.request.urlopen(url, timeout=120) as r:
                data = r.read()
        except Exception as ex:                                    # noqa: BLE001
            log["missing_files"].append(f"{sym}-{y}-{m}: {type(ex).__name__}")
            continue
        log["files"] += 1
        log["bytes"] += len(data)
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            txt = zf.read(zf.namelist()[0]).decode()
        del data
        wx = want[x]
        for line in txt.splitlines():
            f = line.split(",")
            if not f or not f[0][:1].isdigit():
                continue
            ot = int(f[0])
            ot = ot // 1000 if ot > 10**14 else ot          # microseconds from 2025
            ts = ot // 1000
            if ts in wx:
                closes[(x, ts)] = float(f[4])
        del txt
        if os.path.exists(p):
            os.remove(p)
    tmin = np.full(len(E["x"]), -1, np.int32)
    status = np.zeros(len(E["x"]), np.int8)       # 1 ok (bar low reproduced), 2 low mismatch, 3 missing minutes
    for i in tm.tolist():
        x, T, L = int(E["x"][i]), int(E["touch"][i]), float(E["L"][i])
        lc = []
        for mts in range(T - 59 * 60, T + 60 * 60, 60):
            v = closes.get((x, mts))
            lc.append(None if v is None or not v > 0 else math.log(v))
        Gm = minute_G(lc)[59:]                     # slots of the touch bar: minute T .. T + 59 (closing T+60 .. T+3600)
        if len(Gm) != 60 or any(g is None for g in Gm):
            status[i] = 3
            continue
        st = int(Gz[f"st{x}"])
        b = (T - st) // HOUR
        lo3 = float(Gz[f"low{x}"][b])
        if abs(round10(min(Gm)) - lo3) > 1e-9 * lo3:
            status[i] = 2
        else:
            status[i] = 1
        j = next((j for j, g in enumerate(Gm) if round10(g) <= L), None)
        tmin[i] = 59 if j is None else j
    np.savez(os.path.join(a.work, "m1.npz"), touch_minute=tmin, status=status)
    log.update({"touch_episodes": int(len(tm)), "ok": int((status == 1).sum()), "low_mismatch": int((status == 2).sum()),
                "missing_minutes": int((status == 3).sum())})
    json.dump(log, open(os.path.join(a.work, "m1-log.json"), "w"), indent=1)
    print(json.dumps(log))


# =====================================================================================================================
# score helpers
# =====================================================================================================================
def logit_fit(X, y, ridge=RIDGE):
    mu, sd = X.mean(0), X.std(0)
    sd = np.where(sd > 0, sd, 1.0)
    Xs = np.c_[np.ones(len(X)), (X - mu) / sd]
    w = np.zeros(Xs.shape[1])
    pen = np.r_[0.0, np.full(X.shape[1], ridge)] * len(y)
    for _ in range(60):
        q = 1 / (1 + np.exp(-np.clip(Xs @ w, -35, 35)))
        g = Xs.T @ (y - q) - pen * w
        Hm = (Xs * (q * (1 - q))[:, None]).T @ Xs + np.diag(pen) + 1e-9 * np.eye(len(w))
        step = np.linalg.solve(Hm, g)
        w += step
        if np.abs(step).max() < 1e-8:
            break
    return {"w": w, "mu": mu, "sd": sd}


def logit_score(m, X):
    return np.c_[np.ones(len(X)), (X - m["mu"]) / m["sd"]] @ m["w"]


class Firing:
    """First check per episode with score >= threshold, for per-episode thresholds. Checks sorted by (ep, c)."""

    def __init__(self, ep, s, nep):
        self.ep, self.nep = ep, nep
        self.N = len(s)
        rk = np.empty(self.N, np.int64)
        o = np.argsort(s, kind="stable")
        rk[o] = np.arange(self.N)
        # equal scores share the smallest rank, so a threshold at a score value fires on all ties
        ss = s[o]
        first = np.r_[0, np.nonzero(np.diff(ss) != 0)[0] + 1]
        grp = np.repeat(first, np.diff(np.r_[first, self.N]))
        rk[o] = grp
        self.rk = rk
        self.ss = ss
        key = ep.astype(np.int64) * (self.N + 1) + rk
        self.acc = np.maximum.accumulate(key)
        self.lo = np.searchsorted(ep, np.arange(nep), side="left")
        self.hi = np.searchsorted(ep, np.arange(nep), side="right")
        self.epmax = np.full(nep, -1, np.int64)
        has = self.hi > self.lo
        self.epmax[has] = self.acc[self.hi[has] - 1] - np.arange(nep)[has] * (self.N + 1)

    def _rank_from_sorted(self, j):
        j = np.asarray(j)
        out = np.full(j.shape, self.N, np.int64)
        ok = j < self.N
        # rank of sorted position j = first index of its tie group
        ss = self.ss
        jj = j[ok]
        out[ok] = np.searchsorted(ss, ss[jj], side="left")
        return out

    def first(self, rank_thr):
        """rank_thr per episode -> index of the first firing check (-1 if none)."""
        tgt = np.arange(self.nep, dtype=np.int64) * (self.N + 1) + rank_thr
        pos = np.searchsorted(self.acc, tgt, side="left")
        ok = (pos < self.hi) & (pos >= self.lo) & (rank_thr < self.N)
        return np.where(ok, pos, -1)


def match_ranks(F, sel_ep, target_count, qidx, nq):
    """Per quarter, the rank threshold that makes the count of firing episodes (among sel_ep in that quarter) closest
    to target_count[q] from above (ties fire together). Returns rank threshold per episode."""
    thr = np.full(F.nep, F.N, np.int64)
    for q in range(nq):
        m = np.nonzero(sel_ep & (qidx == q))[0]
        if len(m) == 0:
            continue
        mx = np.sort(F.epmax[m])[::-1]
        mx = mx[mx >= 0]
        n_t = int(target_count[q])
        if n_t <= 0 or len(mx) == 0:
            continue
        r = mx[min(n_t, len(mx)) - 1]
        thr[m] = r
    return thr


class Boot:
    """Two-way (series x week) and one-way week pigeonhole bootstrap over cells; numerators and denominators may come
    from different units (episodes, position-days), each summed into the same series x week cells."""

    def __init__(self, ns, weeks, B, seed=SEED_BOOT):
        self.ns, self.nw = ns, len(weeks)
        self.w0 = int(weeks[0])
        rng = np.random.default_rng(seed)
        self.cs = np.stack([np.bincount(rng.integers(0, ns, ns), minlength=ns) for _ in range(B)]).astype(float)
        self.cw = np.stack([np.bincount(rng.integers(0, self.nw, self.nw), minlength=self.nw)
                            for _ in range(B)]).astype(float)

    def cells(self, x, wk, v):
        return np.bincount(np.asarray(x) * self.nw + (np.asarray(wk) - self.w0), weights=np.asarray(v, float),
                           minlength=self.ns * self.nw).reshape(self.ns, self.nw)

    def draws(self, S, two=True):
        return np.einsum("bs,sw,bw->b", self.cs, S, self.cw) if two else self.cw @ S.sum(0)

    def ci(self, Sn, Sd, f=lambda a, b: a / b):
        out = {}
        for nm, two in (("ci90_twoway", True), ("ci90_week", False)):
            a, b = self.draws(Sn, two), self.draws(Sd, two)
            with np.errstate(invalid="ignore", divide="ignore"):
                v = f(a, b)
            ok = np.isfinite(v) & (b > 0)
            out[nm] = [round(float(np.quantile(v[ok], 0.05)), 4), round(float(np.quantile(v[ok], 0.95)), 4)] \
                if ok.any() else None
            out[nm.replace("ci90", "valid")] = {"kept": int(ok.sum()), "dropped": int((~ok).sum())}
        return out


def week_of(t):
    return (np.asarray(t, np.int64) // DAY - 4) // 7


def rr(v, d=4):
    return None if v is None or (isinstance(v, float) and not np.isfinite(v)) else round(float(v), d)


# =====================================================================================================================
# score
# =====================================================================================================================
def cmd_score(a):
    t0 = time.time()
    E = dict(np.load(os.path.join(a.work, "episodes.npz")))
    C = dict(np.load(os.path.join(a.work, "checks.npz")))
    D = dict(np.load(os.path.join(a.work, "denoms.npz")))
    Gz = np.load(os.path.join(a.work, "grids.npz"))
    series = [str(x) for x in Gz["series"]]
    ns = len(series)
    m1 = dict(np.load(os.path.join(a.work, "m1.npz"))) if os.path.exists(os.path.join(a.work, "m1.npz")) else None
    nep = len(E["x"])
    o = np.lexsort((C["c"], C["ep"]))
    C = {k: v[o] for k, v in C.items()}
    ep, c, d = C["ep"].astype(np.int64), C["c"], C["d"]
    ex, est, eend, ereason, etouch = E["x"].astype(int), E["start"], E["end"], E["reason"], E["touch"]
    touch_ep = etouch >= 0
    lead_bars = np.where(touch_ep[ep], (etouch[ep] - c) // HOUR, -1)
    u6 = C["u6"].astype(float)
    dn = C["dn"].astype(float)
    cx = ex[ep]
    print(f"episodes {nep:,} checks {len(c):,} {time.time() - t0:.0f}s", flush=True)

    # walk-forward vol edges per series and scored quarter: u6 over all grid hours in [T_LO, quarter start)
    edges = np.full((ns, len(QSTARTS), 2), np.nan)
    for xi in range(ns):
        st = int(Gz[f"st{xi}"])
        ua = np.asarray(Gz[f"u6{xi}"], float)
        ts = st + HOUR * np.arange(len(ua))
        for qi, qs in enumerate(QSTARTS):
            v = ua[(ts >= T_LO) & (ts < qs) & np.isfinite(ua)]
            edges[xi, qi] = np.quantile(v, [1 / 3, 2 / 3])
    eq = quarter_of(est)                                # scored quarter of the episode start (-1 = fit-only)
    cq = eq[ep]
    cq_c = np.clip(cq, 0, len(QSTARTS) - 1)
    hi_edge = edges[cx, cq_c, 1]
    lo_edge = edges[cx, cq_c, 0]
    u6_hi = np.isfinite(u6) & (u6 >= hi_edge)
    vterc = np.where(np.isfinite(u6), (u6 >= lo_edge).astype(int) + (u6 >= hi_edge).astype(int), -1)

    scored_ep = (est >= T_SC) & (est < T_HI + DAY)
    nq = len(QSTARTS)

    # scores
    S = {"R0": -d, "R0v": -d / np.where(u6_hi, M_HI, 1.0), "R1": C["thru"].astype(float)}
    u6z, dnz = np.where(np.isfinite(u6), u6, 0.0), np.where(np.isfinite(dn), dn, 0.0)
    ell = np.log(d + L_EPS)
    X2 = np.c_[ell, u6z, dnz, np.maximum(u6z, 0) * ell]
    yfit = (lead_bars >= FIT_LEAD[0]) & (lead_bars <= FIT_LEAD[1])
    s2 = np.full(len(c), np.nan)
    coef = {}
    r2_fitshare = np.zeros(nq)
    models = []
    r0_fit_share = np.zeros(nq)
    for qi, qs in enumerate(QSTARTS):
        fm = (c >= T_LO) & (c + 25 * HOUR <= qs)
        mdl = logit_fit(X2[fm], yfit[fm].astype(float))
        models.append(mdl)
        cm = cq == qi
        s2[cm] = logit_score(mdl, X2[cm])
        coef[qname(qs)] = {"w_std": [rr(v) for v in mdl["w"]], "fit_checks": int(fm.sum()),
                           "fit_pos": int(yfit[fm].sum())}
        # fit-window episodes fully observed before qs: R0 2 % alert share -> R2 walk-forward threshold
        fe = (est >= T_LO) & (eend <= qs)
        fe_c = fe[ep]
        r0_any = np.zeros(nep, bool)
        np.logical_or.at(r0_any, ep[fe_c & (d <= D_R0)], True)
        r0_fit_share[qi] = r0_any[fe].mean()
        sf = np.full(nep, -np.inf)
        sc_fit = logit_score(mdl, X2[fe_c])
        np.maximum.at(sf, ep[fe_c], sc_fit)
        sfe = np.sort(sf[fe])[::-1]
        kk = max(1, int(np.ceil(r0_fit_share[qi] * len(sfe))))
        r2_fitshare[qi] = sfe[kk - 1]
        coef[qname(qs)]["R0_fit_episode_share"] = rr(r0_fit_share[qi], 5)
        coef[qname(qs)]["R2_tau"] = rr(r2_fitshare[qi], 5)
    s2 = np.where(np.isfinite(s2), s2, -1e9)              # fit-only episodes (never scored)
    S["R2"] = s2
    print(f"R2 fitted {time.time() - t0:.0f}s", flush=True)

    Fi = {k: Firing(ep, v, nep) for k, v in S.items()}

    # per-episode alert from per-episode rank thresholds
    def alert_of(rule, thr_rank):
        j = Fi[rule].first(thr_rank)
        j = np.where(scored_ep, j, -1)
        return j

    def thr_value(rule, tau):
        return Fi[rule]._rank_from_sorted(np.searchsorted(Fi[rule].ss, tau, side="left")) * np.ones(nep, np.int64)

    deploy = {
        "R0": thr_value("R0", -D_R0),
        "R0v": thr_value("R0v", -D_R0),
        "R1": thr_value("R1", 0.5),
        "R2": np.array([Fi["R2"]._rank_from_sorted(np.searchsorted(Fi["R2"].ss, r2_fitshare[max(q, 0)],
                                                                   side="left"))
                        for q in eq.tolist()], np.int64),
    }
    J = {k: alert_of(k, v) for k, v in deploy.items()}

    # denominators per series x week (scored universe position-days)
    pdx, pdd = D["pd_key"] // 10**6, (D["pd_key"] % 10**6) * DAY
    sc_pd = (pdd >= T_SC) & (pdd <= T_HI)
    weeks = np.arange(min(week_of(pdd[sc_pd]).min(), week_of(est[scored_ep]).min()),
                      max(week_of(pdd[sc_pd]).max(), week_of(est[scored_ep]).max()) + 1)
    BT = Boot(ns, weeks, a.nb)
    Spd = BT.cells(pdx[sc_pd], week_of(pdd[sc_pd]), D["pd_n"][sc_pd])
    PD_all = float(D["pd_n"][sc_pd].sum())
    ewk = week_of(est)
    events = scored_ep & touch_ep

    tmin = m1["touch_minute"] if m1 is not None else None
    m1ok = (m1["status"] == 1) if m1 is not None else None

    def outcome(j):
        """Per episode: fired, early (lead >= 1 h), late (lead < 1 h), false; lead in bars; lead in minutes."""
        fired = j >= 0
        jj = np.where(fired, j, 0)
        lb = np.where(fired, lead_bars[jj], -1)
        early = fired & touch_ep & (lb >= 1)
        late = fired & touch_ep & (lb == 0)
        false = fired & ~touch_ep
        lmin = np.full(nep, np.nan)
        if tmin is not None:
            lm = np.where(touch_ep & fired, lb * 60 + tmin + 1, np.nan)
            lmin = np.where(m1ok | (lb >= 1), lm, np.nan)
        return {"fired": fired, "early": early, "late": late, "false": false, "lb": lb, "lmin": lmin, "j": jj}

    def summary(o, mask_ep=None, pd=None, with_ci=False):
        m = scored_ep if mask_ep is None else (scored_ep & mask_ep)
        ev = events & m
        nev = int(ev.sum())
        pdn = PD_all if pd is None else pd
        bw = pdn / 7.0
        f, e_, l_, fa = (int((o[k] & m).sum()) for k in ("fired", "early", "late", "false"))
        out = {"episodes": int(m.sum()), "events": nev, "alerts": f, "early_hits": e_, "late_hits": l_,
               "false": fa, "recall_1h": rr(e_ / nev) if nev else None,
               "recall_any_lead": rr((e_ + l_) / nev) if nev else None,
               "precision_1h": rr(e_ / f) if f else None, "precision_any": rr((e_ + l_) / f) if f else None,
               "fa_per_bw": rr(fa / bw, 5) if bw else None, "alerts_per_1000bw": rr(1000 * f / bw, 2) if bw else None}
        lbv = o["lb"][o["early"] & m]
        if len(lbv):
            out["lead_hours_early_q25_q50_q75"] = [float(v) for v in np.quantile(lbv, [0.25, 0.5, 0.75])]
        for H in (1, 6, 24):
            hit = o["fired"] & touch_ep & (o["lb"] >= 1) & (o["lb"] <= H) & m
            out[f"h{H}"] = {"recall": rr(hit.sum() / nev) if nev else None,
                            "precision": rr(hit.sum() / f) if f else None,
                            "fa_per_bw": rr((f - hit.sum()) / bw, 5) if bw else None}
        if tmin is not None:
            meas = ev & ~(o["fired"] & touch_ep & (o["lb"] == 0) & ~m1ok)
            c15 = (o["fired"] & touch_ep & (o["lmin"] >= 15) & meas).sum()
            out["recall_15min"] = rr(c15 / meas.sum()) if meas.sum() else None
            out["recall_15min_events_measured"] = int(meas.sum())
            lm = o["lmin"][o["fired"] & touch_ep & m & np.isfinite(o["lmin"])]
            out["lead_minutes_all_hits_q25_q50_q75"] = [float(v) for v in np.quantile(lm, [0.25, 0.5, 0.75])] \
                if len(lm) else None
        if with_ci:
            Sev = BT.cells(ex[ev], ewk[ev], np.ones(nev))
            Sea = BT.cells(ex[m], ewk[m], (o["early"] & m)[m])
            Sf = BT.cells(ex[m], ewk[m], (o["fired"] & m)[m])
            Sfa = BT.cells(ex[m], ewk[m], (o["false"] & m)[m])
            out["ci"] = {"recall_1h": BT.ci(Sea, Sev), "precision_1h": BT.ci(Sea, Sf),
                         "fa_per_bw": BT.ci(7 * Sfa, Spd)}
        return out

    def gain(o1, o0):
        ev = events
        nev = ev.sum()
        g = ((o1["early"] & scored_ep).sum() - (o0["early"] & scored_ep).sum()) / nev
        Sev = BT.cells(ex[ev], ewk[ev], np.ones(int(nev)))
        m = scored_ep
        Sd = BT.cells(ex[m], ewk[m], (o1["early"].astype(float) - o0["early"].astype(float))[m])
        far_num = BT.cells(ex[m], ewk[m], o1["false"][m])
        far_den = BT.cells(ex[m], ewk[m], o0["false"][m])
        f0 = (o0["false"] & m).sum()
        return {"recall_1h_gain": rr(g), "gain_ci": BT.ci(Sd, Sev),
                "fa_ratio": rr((o1["false"] & m).sum() / f0) if f0 else None, "fa_ratio_ci": BT.ci(far_num, far_den),
                "alerts": [int((o1["fired"] & m).sum()), int((o0["fired"] & m).sum())]}

    def beats(g):
        lo = (g["gain_ci"].get("ci90_twoway") or [None])[0]
        return bool(g["recall_1h_gain"] is not None and g["recall_1h_gain"] >= 0.05 and lo is not None and lo > 0
                    and g["fa_ratio"] is not None and g["fa_ratio"] <= 1.10)

    OUT = {"what": "Q26 R27 at-risk tier, hourly checks, frozen line, one alert per episode (development, Aave V3 "
                   "Polygon label B); design membrane-board design/q26-r27-at-risk-hourly-2026-10-25.md",
           "band": X_BAND, "scored": "episodes starting 2023-01-01 .. 2026-09-23 + 1 d", "split_halves_utc": "2024-11-12",
           "bootstrap": {"B": a.nb, "seed": SEED_BOOT, "kind": "pigeonhole two-way series x week of episode start"},
           "r2_coef": coef}
    rc = {REASONS[i]: int(((ereason == i) & scored_ep).sum()) for i in range(len(REASONS))}
    OUT["episodes"] = {"scored": int(scored_ep.sum()), "events": int(events.sum()), "end_reason": rc,
                       "position_days_scored": int(PD_all), "checks_scored": int(scored_ep[ep].sum()),
                       "checks_missing_u6": int((~np.isfinite(u6) & scored_ep[ep]).sum()),
                       "checks_missing_dn": int((~np.isfinite(dn) & scored_ep[ep]).sum()),
                       "events_touch_at_first_check_bar": int((events & (etouch == est)).sum())}
    if m1 is not None:
        OUT["m1"] = json.load(open(os.path.join(a.work, "m1-log.json")))

    # ---- deployable points ----
    Od = {k: outcome(v) for k, v in J.items()}
    halves = {"all": None, "first_half": est < SPLIT, "second_half": est >= SPLIT}
    dep = {}
    for k, o_ in Od.items():
        e = {hn: summary(o_, hm, with_ci=(hn == "all")) for hn, hm in halves.items()}
        # by distance and vol tercile at the alert check
        fired = o_["fired"]
        da = np.where(fired, d[o_["j"]], np.nan)
        va = np.where(fired, vterc[o_["j"]], -9)
        e["by_distance_at_alert"] = {}
        for bi, (lo, hi) in enumerate(DBK):
            mm = scored_ep & fired & (da >= lo) & (da < hi)
            e["by_distance_at_alert"][DBN[bi]] = {"alerts": int(mm.sum()), "early": int((mm & o_["early"]).sum()),
                                                  "late": int((mm & o_["late"]).sum()),
                                                  "false": int((mm & o_["false"]).sum()),
                                                  "precision_1h": rr((mm & o_["early"]).sum() / mm.sum())
                                                  if mm.sum() else None}
        e["by_vol_tercile_at_alert"] = {}
        for t in (-1, 0, 1, 2):
            mm = scored_ep & fired & (va == t)
            e["by_vol_tercile_at_alert"][f"t{t + 1}" if t >= 0 else "missing"] = {
                "alerts": int(mm.sum()), "early": int((mm & o_["early"]).sum()), "false": int((mm & o_["false"]).sum()),
                "precision_1h": rr((mm & o_["early"]).sum() / mm.sum()) if mm.sum() else None}
        dep[k] = e
    OUT["deployable"] = dep
    print(f"deployable done {time.time() - t0:.0f}s", flush=True)

    # ---- matched volume (per quarter of the episode start) ----
    def counts_of(o_):
        return np.array([int((o_["fired"] & scored_ep & (eq == q)).sum()) for q in range(nq)])

    MV = {}
    for ref in ("R0", "R0v", "R1"):
        tgt = counts_of(Od[ref])
        row = {"target_alerts": int(tgt.sum())}
        oo = {}
        for k in ("R0", "R0v", "R2"):
            if k == ref:
                oo[k] = Od[k]
            else:
                oo[k] = outcome(alert_of(k, match_ranks(Fi[k], scored_ep, tgt, eq, nq)))
            row[k] = summary(oo[k], with_ci=True)
        if ref == "R1":
            oo["R1"] = Od["R1"]
            row["R1"] = summary(Od["R1"], with_ci=True)
        for k in oo:
            if k != "R0":
                row[f"{k}_vs_R0"] = gain(oo[k], oo["R0"])
                row[f"{k}_vs_R0"]["beats"] = beats(row[f"{k}_vs_R0"])
                for hn in ("first_half", "second_half"):
                    hm = halves[hn]
                    ev_h = events & hm
                    row[f"{k}_vs_R0"][f"gain_{hn}"] = rr(((oo[k]["early"] & ev_h).sum() - (oo["R0"]["early"] & ev_h)
                                                          .sum()) / ev_h.sum()) if ev_h.sum() else None
        MV[f"matched_to_{ref}"] = row
    OUT["matched_volume"] = MV
    print(f"matched done {time.time() - t0:.0f}s", flush=True)

    # ---- curves ----
    CU = {}
    for k in ("R0", "R0v", "R2"):
        pts = []
        for sh in SHARES:
            tgt = np.array([int(round(sh * ((scored_ep & (eq == q)).sum()))) for q in range(nq)])
            o_ = outcome(alert_of(k, match_ranks(Fi[k], scored_ep, tgt, eq, nq)))
            sm = summary(o_)
            pts.append({"share": sh, "alerts": sm["alerts"], "recall_1h": sm["recall_1h"], "fa_per_bw": sm["fa_per_bw"],
                        "precision_1h": sm["precision_1h"], "recall_any_lead": sm["recall_any_lead"]})
        CU[f"{k}_per_quarter_share"] = pts
    for k in ("R0", "R0v"):
        pts = []
        for dstar in R0_GRID:
            o_ = outcome(alert_of(k, thr_value(k, -dstar)))
            sm = summary(o_)
            pts.append({"d_star": dstar, "alerts": sm["alerts"], "recall_1h": sm["recall_1h"],
                        "fa_per_bw": sm["fa_per_bw"], "precision_1h": sm["precision_1h"],
                        "recall_any_lead": sm["recall_any_lead"], "recall_15min": sm.get("recall_15min"),
                        "lead_hours_early_q25_q50_q75": sm.get("lead_hours_early_q25_q50_q75")})
        CU[f"{k}_global_threshold"] = pts
    OUT["curves"] = CU

    # ---- shared-path null: circular time shift of the volatility features per series ----
    rng = np.random.default_rng(SEED_NULL)
    nb_series = {xi: len(Gz[f"u6{xi}"]) for xi in range(ns)}
    tgt0 = counts_of(Od["R0"])
    tgtv = counts_of(Od["R0v"])
    obs_v = MV["matched_to_R0"]["R0v_vs_R0"]["recall_1h_gain"]
    obs_vv = MV["matched_to_R0v"]["R0v_vs_R0"]["recall_1h_gain"]
    oR0v_match = outcome(alert_of("R0", match_ranks(Fi["R0"], scored_ep, tgtv, eq, nq)))
    nul = {"R0v_at_R0_volume": [], "R0v_at_own_volume": [], "R2_at_R0_volume": []}
    bidx = C["b"].astype(np.int64)
    for di in range(a.nnull):
        offs = {xi: int(rng.integers(30, nb_series[xi] // 24 - 30)) * 24 for xi in range(ns)}
        sh6 = np.empty(len(c))
        shd = np.empty(len(c))
        for xi in range(ns):
            mm = cx == xi
            ua, da_ = np.asarray(Gz[f"u6{xi}"], float), np.asarray(Gz[f"dn{xi}"], float)
            bb = (bidx[mm] + offs[xi]) % nb_series[xi]
            sh6[mm], shd[mm] = ua[bb], da_[bb]
        hi_n = np.isfinite(sh6) & (sh6 >= hi_edge)
        Fv = Firing(ep, -d / np.where(hi_n, M_HI, 1.0), nep)
        ov = outcome(np.where(scored_ep, Fv.first(match_ranks(Fv, scored_ep, tgt0, eq, nq)), -1))
        nul["R0v_at_R0_volume"].append(((ov["early"] & scored_ep).sum() - (Od["R0"]["early"] & scored_ep).sum())
                                       / events.sum())
        Fv_thr = Fv._rank_from_sorted(np.searchsorted(Fv.ss, -D_R0, side="left")) * np.ones(nep, np.int64)
        ovd = outcome(np.where(scored_ep, Fv.first(Fv_thr), -1))
        tg_n = counts_of(ovd)
        o0n = outcome(alert_of("R0", match_ranks(Fi["R0"], scored_ep, tg_n, eq, nq)))
        nul["R0v_at_own_volume"].append(((ovd["early"] & scored_ep).sum() - (o0n["early"] & scored_ep).sum())
                                        / events.sum())
        if di < a.nnull2:
            u6n, dnn = np.where(np.isfinite(sh6), sh6, 0.0), np.where(np.isfinite(shd), shd, 0.0)
            Xn = np.c_[ell, u6n, dnn, np.maximum(u6n, 0) * ell]
            sn = np.full(len(c), -1e9)
            for qi, qs in enumerate(QSTARTS):
                fm = (c >= T_LO) & (c + 25 * HOUR <= qs)
                mdl = logit_fit(Xn[fm], yfit[fm].astype(float))
                cm = cq == qi
                sn[cm] = logit_score(mdl, Xn[cm])
            Fn = Firing(ep, sn, nep)
            on = outcome(np.where(scored_ep, Fn.first(match_ranks(Fn, scored_ep, tgt0, eq, nq)), -1))
            nul["R2_at_R0_volume"].append(((on["early"] & scored_ep).sum() - (Od["R0"]["early"] & scored_ep).sum())
                                          / events.sum())
        if di % 20 == 0:
            print(f"null {di} {time.time() - t0:.0f}s", flush=True)
    obs = {"R0v_at_R0_volume": obs_v, "R0v_at_own_volume": obs_vv,
           "R2_at_R0_volume": MV["matched_to_R0"]["R2_vs_R0"]["recall_1h_gain"]}
    OUT["null"] = {}
    for kk, v in nul.items():
        v = np.array(v, float)
        v = v[np.isfinite(v)]
        OUT["null"][kk] = {"q05_q50_q95": [rr(np.quantile(v, q)) for q in (0.05, 0.5, 0.95)] if len(v) else None,
                           "observed": obs[kk], "observed_above_q95": bool(len(v) and obs[kk] is not None
                                                                           and obs[kk] > np.quantile(v, 0.95)),
                           "valid": int(len(v))}
    del oR0v_match

    # ---- borrower experience: calm vs volatile series-months ----
    def mon_of(t):
        m_ = np.asarray(t, np.int64).astype("datetime64[s]").astype("datetime64[M]").astype(np.int64)
        return (1970 + m_ // 12) * 100 + m_ % 12 + 1
    rv = {}
    for xi in range(ns):
        st = int(Gz[f"st{xi}"])
        cl = np.asarray(Gz[f"close{xi}"], float)
        ts = st + HOUR * np.arange(len(cl))
        lr = np.r_[np.nan, np.diff(np.log(cl))]
        sel = (ts >= T_SC) & (ts < T_HI + DAY) & np.isfinite(lr)
        mo = mon_of(ts[sel])
        for mv in np.unique(mo):
            rv[(xi, int(mv))] = float(np.sqrt(np.mean(lr[sel][mo == mv] ** 2)))
    keys = sorted(rv)
    vals = np.array([rv[k_] for k_ in keys])
    e1, e2 = np.quantile(vals, [1 / 3, 2 / 3])
    mstate = {k_: (0 if rv[k_] <= e1 else (2 if rv[k_] > e2 else 1)) for k_ in keys}
    pd_mon = mon_of(pdd)
    pn_x, pn_d = D["pn_key"] // 10**6, (D["pn_key"] % 10**6) * DAY
    pn_mon = mon_of(pn_d)
    ep_mon = mon_of(est)
    BX = {"month_rv_terciles_edges": [rr(e1, 6), rr(e2, 6)], "by_rule": {}}
    pm = D["near_posmonths"]
    for k, o_ in Od.items():
        row = {}
        for stn, sv in (("calm", 0), ("mid", 1), ("volatile", 2)):
            msk_pd = np.array([mstate.get((int(x_), int(m_)), -1) == sv for x_, m_ in zip(pdx, pd_mon)]) & sc_pd
            msk_pn = np.array([mstate.get((int(x_), int(m_)), -1) == sv for x_, m_ in zip(pn_x, pn_mon)]) & \
                (pn_d >= T_SC) & (pn_d <= T_HI)
            msk_ep = np.array([mstate.get((int(x_), int(m_)), -1) == sv for x_, m_ in zip(ex, ep_mon)]) & scored_ep
            nal = int((o_["fired"] & msk_ep).sum())
            nfa = int((o_["false"] & msk_ep).sum())
            pdn, pnn = float(D["pd_n"][msk_pd].sum()), float(D["pn_n"][msk_pn].sum())
            # share of near-line borrower-months with an alert
            fired_pm = set(zip(E["pos"][o_["fired"] & msk_ep].tolist(), ex[o_["fired"] & msk_ep].tolist(),
                               ep_mon[o_["fired"] & msk_ep].tolist()))
            pm_sel = [tuple(r_) for r_ in pm.tolist() if mstate.get((int(r_[1]), int(r_[2])), -1) == sv
                      and T_SC <= utc(dt.date(int(r_[2]) // 100, int(r_[2]) % 100, 1)) <= T_HI]
            nhit = sum(1 for r_ in pm_sel if r_ in fired_pm)
            row[stn] = {"series_months": int(sum(1 for k_ in keys if mstate[k_] == sv)), "alerts": nal, "false": nfa,
                        "alerts_per_borrower_month": rr(30.4375 * nal / pdn, 4) if pdn else None,
                        "false_per_borrower_month": rr(30.4375 * nfa / pdn, 4) if pdn else None,
                        "alerts_per_nearline_borrower_month": rr(30.4375 * nal / pnn, 4) if pnn else None,
                        "nearline_borrower_months": len(pm_sel),
                        "share_nearline_borrower_months_with_alert": rr(nhit / len(pm_sel), 4) if pm_sel else None}
        lbv = o_["lb"][o_["early"] & scored_ep]
        row["median_lead_hours_early_hits"] = float(np.median(lbv)) if len(lbv) else None
        if tmin is not None:
            lm = o_["lmin"][o_["fired"] & touch_ep & scored_ep & np.isfinite(o_["lmin"])]
            row["median_lead_minutes_all_hits"] = float(np.median(lm)) if len(lm) else None
        BX["by_rule"][k] = row
    OUT["borrower_experience"] = BX

    # ---- real liquidations ----
    lq = (E["liq_after"] > 0) & scored_ep
    RL = {"episodes_with_real_liquidation": int(lq.sum()),
          "of_which_no_twap_touch": int((lq & ~touch_ep).sum())}
    for k, o_ in Od.items():
        at = np.where(o_["fired"], c[o_["j"]], np.iinfo(np.int64).max)
        warned = lq & o_["fired"] & (E["liq_after"] - at >= HOUR)
        RL[k] = {"warned_1h_before_liquidation": int(warned.sum()),
                 "share": rr(warned.sum() / lq.sum()) if lq.sum() else None}
    OUT["real_liquidations"] = RL

    # ---- judgement ----
    jd = {"R0v_beats_R0_at_R0v_volume": MV["matched_to_R0v"]["R0v_vs_R0"]["beats"],
          "R2_beats_R0_at_R0v_volume": MV["matched_to_R0v"]["R2_vs_R0"]["beats"],
          "R0v_beats_R0_at_R0_volume": MV["matched_to_R0"]["R0v_vs_R0"]["beats"],
          "R2_beats_R0_at_R0_volume": MV["matched_to_R0"]["R2_vs_R0"]["beats"]}
    jd["R0v_null_ok"] = OUT["null"]["R0v_at_own_volume"]["observed_above_q95"]
    jd["R2_null_ok"] = OUT["null"]["R2_at_R0_volume"]["observed_above_q95"]
    win = None
    if jd["R0v_beats_R0_at_R0v_volume"] and jd["R0v_null_ok"]:
        win = "R0v"
    if jd["R2_beats_R0_at_R0v_volume"] and jd["R2_null_ok"]:
        g2 = MV["matched_to_R0v"]["R2_vs_R0"]["recall_1h_gain"]
        gv = MV["matched_to_R0v"]["R0v_vs_R0"]["recall_1h_gain"] if win else -1
        win = "R2" if g2 > gv else win
    base = win or "R0"
    jd["at_risk_base_rule"] = base
    curve = CU["R0_global_threshold"] if base == "R0" else (CU["R0v_global_threshold"] if base == "R0v"
                                                            else CU["R2_per_quarter_share"])
    for bud in BUDGETS_FA:
        okp = [p for p in curve if p["fa_per_bw"] is not None and p["fa_per_bw"] <= bud]
        jd[f"operating_point_fa_le_{bud}"] = max(okp, key=lambda p: p["recall_1h"] or -1) if okp else None
    OUT["judgement"] = jd
    os.makedirs(a.out, exist_ok=True)
    with open(os.path.join(a.out, "r27-atrisk.json"), "w") as fo:
        json.dump(OUT, fo, indent=1, default=lambda v: v.item() if hasattr(v, "item") else str(v))
    print(json.dumps(jd, indent=1, default=str))
    print(f"done {time.time() - t0:.0f}s", flush=True)


def main():
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest="cmd", required=True)
    b = sp.add_parser("build")
    for k in ("datasets", "scr", "work"):
        b.add_argument(f"--{k}", required=True)
    m = sp.add_parser("m1")
    m.add_argument("--work", required=True)
    m.add_argument("--cache", default=None)
    s = sp.add_parser("score")
    s.add_argument("--work", required=True)
    s.add_argument("--out", required=True)
    s.add_argument("--nb", type=int, default=2000)
    s.add_argument("--nnull", type=int, default=200)
    s.add_argument("--nnull2", type=int, default=20)
    a = ap.parse_args()
    {"build": cmd_build, "m1": cmd_m1, "score": cmd_score}[a.cmd](a)


if __name__ == "__main__":
    main()
