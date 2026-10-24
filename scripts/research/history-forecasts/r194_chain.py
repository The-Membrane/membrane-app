"""Q26 R19.4 depth-chained barrier estimate (Claude, Q26 lane, 2026-10-24). DEVELOPMENT ONLY (seen data).

membrane-board design/Q26_ROUND19_PREREG.md section R19.4 (registered at board 02b697c before any score of this file).

P(touch -D within H) as a chain of n sub-barrier steps of equal log size b = ln(1 - D) / n. Each step uses the
empirical first-passage time of that step, pooled across series in hourly-sigma units, and the next step is
conditioned on the post-touch state: new price (the barrier), post-touch sigma and vol bin v, and remaining time.

  python3 r194_chain.py cache   --datasets DS --rows R192 --out OUT        (series -> ln close/low, sigma, v)
  python3 r194_chain.py run     --rows R192 --out OUT --pool all|maj        (libraries, chain tables, row forecasts)
  python3 r194_chain.py score   --rows R192 --out OUT                       (R, slope, BSS vs a/e/fH/lib1, AUC)
  python3 r194_chain.py synth   --out OUT                                   (GJR-GARCH-t known-answer test)
No address, key or secret is read or written. Nothing here is blind evidence and nothing ships from it.
"""
from __future__ import annotations

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import datetime as dt  # noqa: E402
import hashlib  # noqa: E402
import json  # noqa: E402
import subprocess  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402

import numpy as np  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
STEP, DAY = 3600, 86400
HMAX = 168
NG = 96
XGRID = -0.5 * 1.06 ** np.arange(NG)              # normalised thresholds (hourly-sigma units), descending
LXG = np.log(-XGRID)
XP = np.array([-3.0, -4.5, -6.75, -10.125, -15.1875, -22.78125, -34.171875, -51.2578125])
LXP = np.log(-XP)
VBINS = np.array([-0.35, 0.0, 0.35])                # v bin edges -> 4 bins
NV = 4
MIN_POOL = 500
L1_CAP = 300_000
SEED_L1, SEED_MC, SEED_BOOT, SEED_SYN = 20261941, 20261943, 20261940, 20261942
NPATH = 20_000
NX1 = 41
X1GRID = -np.exp(np.linspace(np.log(0.5), np.log(400.0), NX1))
TS_V = (12, 24, 72, 168)
KS = (-0.20, -0.30)
L8 = (-0.02, -0.03, -0.05, -0.07, -0.10, -0.15, -0.20, -0.30)
CONFIGS = {"c10": 0.10, "c05": 0.05, "lib1": None}
B_BOOT = 1000
BLOCK = 28 * DAY
R_BAND = (0.8, 1.25)
MIN_POS = 30


def now():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def git_sha():
    try:
        return subprocess.check_output(["git", "-C", HERE, "rev-parse", "--short=8", "HEAD"], text=True).strip()
    except Exception:
        return "unknown"


def nsteps(k, step):
    if step is None:
        return 1
    return max(1, int(round(np.log1p(k) / np.log1p(-step))))


def group_of(key):
    if key in ("dev:BTC", "dev:ETH", "P1:KRAKEN-ETH"):
        return "btc_eth"
    return "large" if key.split(":")[0] in ("A2", "A3") else "alt"


def vbin(v):
    b = np.searchsorted(VBINS, v, side="left")
    return np.where(np.isfinite(v), b, -1).astype(np.int8)


def quarter_start(ts):
    d = [dt.datetime.fromtimestamp(int(t), dt.timezone.utc) for t in ts]
    return np.array([int(dt.datetime(x.year, 3 * ((x.month - 1) // 3) + 1, 1, tzinfo=dt.timezone.utc).timestamp())
                     for x in d], np.int64)


# =====================================================================================================================
# vol state (origin-indexed: index i = origin at the open of bar i, information through close of bar i-1)
# =====================================================================================================================
def vol_state(lc):
    """lc: ln close per bar (length N). Returns sigma, v of length N+1 (origin-indexed)."""
    N = len(lc)
    r = np.full(N, np.nan)
    r[1:] = lc[1:] - lc[:-1]
    fin = np.isfinite(r)
    r2 = np.where(fin, r * r, 0.0)
    c2 = np.concatenate([[0.0], np.cumsum(r2)])
    cf = np.concatenate([[0], np.cumsum(fin.astype(np.int64))])
    out = {}
    for w in (24, 168, 720):
        s = np.full(N + 1, np.nan)
        i = np.arange(w, N + 1)
        n_ok = cf[i] - cf[i - w]
        rv = (c2[i] - c2[i - w]) * w / np.maximum(n_ok, 1)       # rescale for missing returns
        s[i] = np.where(n_ok >= 0.9 * w, rv / w, np.nan)          # per-hour variance
        out[w] = s
    with np.errstate(invalid="ignore", divide="ignore"):
        sig = np.sqrt((out[24] + out[168] + out[720]) / 3.0)
        v = 0.5 * np.log(out[24] / out[720])
    sig[~(np.isfinite(sig) & (sig > 0))] = np.nan
    v[~np.isfinite(v)] = np.nan
    return sig, v


# =====================================================================================================================
# series store
# =====================================================================================================================
class Store:
    """concatenated per-series arrays. bar arrays (ln low) length N_s; origin arrays (sig, v, lnS) length N_s + 1."""

    def __init__(self, keys, base_ts, ll_list, lc_list):
        self.keys = list(keys)
        self.base_ts = np.asarray(base_ts, np.int64)
        self.n = np.array([len(x) for x in ll_list], np.int64)
        self.boff = np.concatenate([[0], np.cumsum(self.n)])[:-1]            # bar offsets
        self.ooff = np.concatenate([[0], np.cumsum(self.n + 1)])[:-1]        # origin offsets
        self.ll = np.concatenate(ll_list).astype(np.float64)
        sig, v, lnS = [], [], []
        for lc in lc_list:
            s_, v_ = vol_state(lc)
            sig.append(s_)
            v.append(v_)
            lnS.append(np.concatenate([[np.nan], lc]))
        self.sig = np.concatenate(sig)
        self.v = np.concatenate(v)
        self.lnS = np.concatenate(lnS)
        self.vb = vbin(self.v)

    def save(self, path):
        np.savez(path, keys=np.array(self.keys), base_ts=self.base_ts, n=self.n, ll=self.ll.astype(np.float32),
                 lc=self.lnS.astype(np.float64))

    @classmethod
    def load(cls, path):
        z = np.load(path)
        n, lcs, lls = z["n"], [], []
        lc_all, ll_all = z["lc"], z["ll"].astype(np.float64)
        oo, bo = 0, 0
        for m in n:
            lcs.append(lc_all[oo + 1: oo + 1 + m])
            lls.append(ll_all[bo: bo + m])
            oo += m + 1
            bo += m
        return cls(list(z["keys"]), z["base_ts"], lls, lcs)


def _runmin_paths(ll_s, starts, ref, sig, H=HMAX):
    """running min over j in 0..H-1 of (ll_s[start + j] - ref) / sig; NaN lows never touch; rows that run off the
    end or have < 95% finite lows are flagged invalid."""
    n = len(ll_s)
    ok = starts + H <= n
    st = np.where(ok, starts, 0)
    W = ll_s[st[:, None] + np.arange(H)[None, :]]
    fin = np.isfinite(W)
    ok &= fin.mean(axis=1) >= 0.95
    with np.errstate(invalid="ignore"):
        Z = (np.where(fin, W, np.inf) - ref[:, None]) / sig[:, None]
    M = np.minimum.accumulate(Z, axis=1)
    return M, ok


def _tau_grid(M):
    """first bar j with M[:, j] <= XGRID[g] for every g; 255 if none. M non-increasing along axis 1, so -M is
    non-decreasing and a row-offset key gives one global searchsorted."""
    r, H = M.shape
    K = np.clip(-M, -1e3, 1e3) + (np.arange(r)[:, None] * 1e4)
    q = (-XGRID)[None, :] + (np.arange(r)[:, None] * 1e4)
    idx = np.searchsorted(K.ravel(), q.ravel(), side="left").reshape(r, NG) - np.arange(r)[:, None] * H
    return np.where(idx >= H, 255, idx).astype(np.uint8)


def _tau_at(M, x):
    c = (M > x).sum(axis=1)
    return np.where(c >= M.shape[1], -1, c)


SW = 0.35                                            # sigma-level bin width in ln sigma (D-R19.4a)
NS = 40
S_OFF = 30


def sbin(sig):
    with np.errstate(invalid="ignore", divide="ignore"):
        b = np.floor(np.log(sig) / SW) + S_OFF
    return np.where(np.isfinite(b), np.clip(b, 0, NS - 1), -1).astype(np.int16)


class Library:
    """entries: tau grid (uint8, NG), end_ts, v bin, sigma-level bin, global origin index of the entry start (for
    touch lookups), sigma at the entry start, cell (prior-step index; 0 for L0)."""

    def __init__(self):
        self.parts = []

    def add(self, tau, end_ts, vb, gstart, sig0, cell):
        self.parts.append((tau, end_ts, vb, gstart, sig0, cell))

    def finish(self, ncell):
        if not self.parts:
            raise RuntimeError("empty library")
        cat = [np.concatenate([p[j] for p in self.parts]) for j in range(6)]
        self.tau, self.end_ts, self.vb, self.gstart, self.sig0, self.cell = cat
        self.sb = sbin(self.sig0)
        self.parts = None
        self.ncell = ncell
        order = np.argsort(self.end_ts, kind="stable")
        self.lists = {}
        key = (self.cell[order].astype(np.int64) * NV + self.vb[order]) * NS + self.sb[order]
        ks = np.argsort(key, kind="stable")
        sk = key[ks]
        bounds = np.flatnonzero(np.diff(sk)) + 1
        for grp in np.split(ks, bounds):
            if len(grp) == 0:
                continue
            kk = int(key[grp[0]])
            c, rem = divmod(kk, NV * NS)
            v, sb_ = divmod(rem, NS)
            self.lists[(c, v, sb_)] = order[grp].astype(np.int32)       # still sorted by end_ts
        self._rc = {}
        return self

    def resolve(self, cutoff, shallower=True):
        if cutoff not in self._rc:
            self._rc = {cutoff: self._resolve(cutoff, shallower)}
        return self._rc[cutoff]

    def _resolve(self, cutoff, shallower=True):
        """-> (flat, offs[c, v, s], cnts[c, v, s], fallback counts) for entries ending <= cutoff. Fallback order
        (D-R19.4a): (c, v, s) -> (c, all v, s) -> (c, all v, s-1..s+1) -> for each shallower c: (c', all v, s),
        (c', all v, s-1..s+1). A cell needs >= MIN_POOL entries."""
        pre = {kv: lst[:int(np.searchsorted(self.end_ts[lst], cutoff, side="right"))] for kv, lst in self.lists.items()}
        cnt = {kv: len(v) for kv, v in pre.items()}

        def ids(c, vs, ss):
            return [(c, v, s_) for v in vs for s_ in ss if (c, v, s_) in pre and cnt[(c, v, s_)] > 0]

        flat, pos = [], 0
        offs = np.zeros((self.ncell, NV, NS), np.int64)
        cnts = np.zeros((self.ncell, NV, NS), np.int64)
        fb = {"own": 0, "vmerge": 0, "smerge": 0, "shallower": 0, "none": 0}
        allv = range(NV)
        for c in range(self.ncell):
            for s_ in range(NS):
                nb3 = [x for x in (s_ - 1, s_, s_ + 1) if 0 <= x < NS]
                common = [("vmerge", ids(c, allv, [s_])), ("smerge", ids(c, allv, nb3))]
                if shallower:
                    for cc in range(c - 1, -1, -1):
                        common += [("shallower", ids(cc, allv, [s_])), ("shallower", ids(cc, allv, nb3))]
                for v in range(NV):
                    cands = [("own", ids(c, [v], [s_]))] + common
                    use = None
                    for nm, lst in cands:
                        if sum(cnt[x] for x in lst) >= MIN_POOL:
                            use = (nm, lst)
                            break
                    if use is None:
                        fb["none"] += 1
                        continue
                    fb[use[0]] += 1
                    idx = np.concatenate([pre[x] for x in use[1]])
                    flat.append(idx)
                    offs[c, v, s_], cnts[c, v, s_] = pos, len(idx)
                    pos += len(idx)
        flat = np.concatenate(flat) if flat else np.zeros(0, np.int32)
        return flat, offs, cnts, fb


def build_libraries(store, sids, origin_step=12, cap=L1_CAP, seed=SEED_L1, log=print):
    """L0 (cell 0 only, keyed by v) and L1 (cells = XP index, keyed by v at touch)."""
    L0 = Library()
    l0_meta = []                                     # for L1 generation: (s, o, tau_p[8], lnS, sig)
    for s in sids:
        n, b0 = int(store.n[s]), int(store.base_ts[s])
        oo, bo = int(store.ooff[s]), int(store.boff[s])
        ll_s = store.ll[bo:bo + n]
        o = np.arange(1, n + 1)
        o = o[((b0 + STEP * o) % (origin_step * STEP)) == 0]
        sg, lS = store.sig[oo + o], store.lnS[oo + o]
        ok = np.isfinite(sg) & np.isfinite(lS) & (o + HMAX <= n)
        o, sg, lS = o[ok], sg[ok], lS[ok]
        if len(o) == 0:
            continue
        for ch in range(0, len(o), 4000):
            oc, sc, lc = o[ch:ch + 4000], sg[ch:ch + 4000], lS[ch:ch + 4000]
            M, ok2 = _runmin_paths(ll_s, oc, lc, sc)
            oc, sc, lc, M = oc[ok2], sc[ok2], lc[ok2], M[ok2]
            if len(oc) == 0:
                continue
            tau = _tau_grid(M)
            taup = np.stack([_tau_at(M, x) for x in XP], axis=1).astype(np.int16)
            end = b0 + STEP * (oc + HMAX)
            L0.add(tau, end.astype(np.int64), store.vb[oo + oc], (oo + oc).astype(np.int64), sc, np.zeros(len(oc), np.int8))
            l0_meta.append((np.full(len(oc), s, np.int32), oc.astype(np.int64), taup, lc, sc))
    L0.finish(1)
    S_ = np.concatenate([m[0] for m in l0_meta])
    O_ = np.concatenate([m[1] for m in l0_meta])
    TP = np.concatenate([m[2] for m in l0_meta])
    LS = np.concatenate([m[3] for m in l0_meta])
    SG = np.concatenate([m[4] for m in l0_meta])
    log(now(), f"  L0 entries {len(S_)}")
    rng = np.random.default_rng(seed)
    L1 = Library()
    for p, xp in enumerate(XP):
        cand = np.flatnonzero(TP[:, p] >= 0)
        if len(cand) > cap:
            cand = np.sort(rng.choice(cand, cap, replace=False))
        nadd = 0
        for s in np.unique(S_[cand]):
            m = cand[S_[cand] == s]
            n, b0 = int(store.n[s]), int(store.base_ts[s])
            oo, bo = int(store.ooff[s]), int(store.boff[s])
            ll_s = store.ll[bo:bo + n]
            c = O_[m] + TP[m, p]                               # touch bar
            ref = LS[m] + xp * SG[m]                           # barrier (log price)
            sgc = store.sig[oo + c + 1]                        # post-touch sigma (close of the touch bar)
            ok = np.isfinite(sgc) & (c + 1 <= n)
            m, c, ref, sgc = m[ok], c[ok], ref[ok], sgc[ok]
            if len(m) == 0:
                continue
            M, ok2 = _runmin_paths(ll_s, c, ref, sgc)
            c, sgc, M = c[ok2], sgc[ok2], M[ok2]
            if len(c) == 0:
                continue
            tau = _tau_grid(M)
            end = b0 + STEP * (c + HMAX)
            # gstart: origin index at the touch bar open; the touch-bar sigma lookup is gstart + tau + 1
            L1.add(tau, end.astype(np.int64), store.vb[oo + c + 1], (oo + c).astype(np.int64), sgc,
                   np.full(len(c), p, np.int8))
            nadd += len(c)
        log(now(), f"  L1 x_p {xp:.2f}: touches {int((TP[:, p] >= 0).sum())}, kept {nadd}")
    L1.finish(len(XP))
    return L0, L1


def _gidx(x):
    """nearest XGRID index in ln|x| (x < 0); beyond the grid -> NG (never touches)."""
    lx = np.log(-x)
    g = np.rint((lx - LXG[0]) / np.log(1.06)).astype(np.int64)
    g = np.clip(g, 0, NG)
    g[lx > LXG[-1] + 0.5 * np.log(1.06)] = NG
    return g


def _pidx(x):
    lx = np.log(-x)
    return np.abs(lx[..., None] - LXP).argmin(axis=-1)


def chain_table(store, L0, L1, cutoff, v0, b, n, rng_u, Ts=TS_V):
    """P(all n steps complete within T bars) on the X1GRID (rows) for each T (cols). x1 = b / sigma0 is the grid
    variable, so each grid row fixes sigma0 = b / x1 and its sigma-level bin. Later steps use x_j = b / sigma_{j-1}.
    Returns probs (NX1, len(Ts)) and a fallback record."""
    f0, o0, c0, fb0 = L0.resolve(cutoff)
    f1, o1, c1, fb1 = L1.resolve(cutoff)
    N = rng_u.shape[1]
    x = np.repeat(X1GRID[:, None], N, axis=1)                                   # (NX1, N) current threshold
    s0 = sbin(b / x)
    cnt = np.where(s0 >= 0, c0[0, v0, np.maximum(s0, 0)], 0)
    alive = cnt > 0
    nnone0 = int((~alive).sum())
    off = o0[0, v0, np.maximum(s0, 0)]
    ent = f0[np.minimum(off + (rng_u[0][None, :] * np.maximum(cnt, 1)).astype(np.int64), max(len(f0) - 1, 0))]
    g = _gidx(x)
    tau = L0.tau[ent, np.minimum(g, NG - 1)].astype(np.int64)
    tau = np.where((g >= NG) | (tau == 255) | ~alive, 10 ** 6, tau)
    elapsed = tau
    alive = elapsed <= max(Ts) - 1
    gt = L0.gstart[ent] + np.minimum(tau, HMAX - 1) + 1
    srat = np.where(alive, store.sig[gt] / L0.sig0[ent], 1.0)
    vb = np.where(alive, store.vb[gt], 0)
    bad = alive & ~(np.isfinite(srat) & (vb >= 0))
    alive &= ~bad
    nnone1 = int(bad.sum())
    xprev = x.copy()
    x = np.where(alive, x / np.where(np.isfinite(srat), srat, 1.0), x)
    for j in range(1, n):
        p = _pidx(xprev)
        vv = np.clip(vb, 0, NV - 1)
        ss = sbin(b / x)
        cnt = np.where(ss >= 0, c1[p, vv, np.maximum(ss, 0)], 0)
        off = o1[p, vv, np.maximum(ss, 0)]
        nnone1 += int((alive & (cnt == 0)).sum())
        alive = alive & (cnt > 0)
        k_ = off + (rng_u[j][None, :] * np.maximum(cnt, 1)).astype(np.int64)
        ent = f1[np.minimum(k_, max(len(f1) - 1, 0))]
        g = _gidx(x)
        t1 = L1.tau[ent, np.minimum(g, NG - 1)].astype(np.int64)
        t1 = np.where((g >= NG) | (t1 == 255), 10 ** 6, t1)
        elapsed = np.where(alive, elapsed + t1, 10 ** 6)
        alive &= elapsed <= max(Ts) - 1
        gt = L1.gstart[ent] + np.minimum(t1, HMAX - 1) + 1
        srat = np.where(alive, store.sig[gt] / L1.sig0[ent], 1.0)
        vb = np.where(alive, store.vb[gt], 0)
        bad = alive & ~(np.isfinite(srat) & (vb >= 0))
        alive &= ~bad
        nnone1 += int(bad.sum())
        xprev = x.copy()
        x = np.where(alive, x / np.where(np.isfinite(srat), srat, 1.0), x)
    el = np.where(alive, elapsed, 10 ** 6)
    P = np.stack([((el <= T - 1).sum(axis=1) + 0.5) / (N + 1) for T in Ts], axis=1)
    P[s0[:, 0] < 0] = np.nan
    P[c0[0, v0, np.maximum(s0[:, 0], 0)] == 0] = np.nan       # no step-1 pool at this sigma level
    return P, {"L0_none_paths": nnone0, "later_none_paths": nnone1, "L0_cells": fb0, "L1_cells": fb1}


def interp_rows(P_tab, x1):
    """ln p linear in ln|x1| over X1GRID (clamped at the ends)."""
    lx = np.log(-X1GRID)
    out = np.full((len(x1), P_tab.shape[1]), np.nan)
    ok = np.isfinite(P_tab[:, 0])
    if ok.sum() < 2:
        return out
    lxx = np.log(-x1)
    inside = (lxx >= lx[ok].min()) & (lxx <= lx[ok].max())     # no extrapolation past the pooled sigma levels
    for t in range(P_tab.shape[1]):
        out[inside, t] = np.exp(np.interp(lxx[inside], lx[ok], np.log(P_tab[ok, t])))
    return out


# =====================================================================================================================
# commands
# =====================================================================================================================
def cmd_cache(a):
    sys.path.insert(0, HERE)
    import r12_tail as R12
    keys = json.load(open(os.path.join(a.rows, "rowsB-meta.json")))["series"]
    specs = {s_["key"]: s_ for s_ in R12.dev_specs(a.datasets)}
    base, lls, lcs = [], [], []
    t0 = time.time()
    for j, k in enumerate(keys):
        ser, _, _ = R12.load_series(specs[k])
        with np.errstate(invalid="ignore", divide="ignore"):
            lls.append(np.log(np.asarray(ser.low, float)))
            lcs.append(np.log(np.asarray(ser.close, float)))
        base.append(int(ser.base_ts))
        if (j + 1) % 25 == 0:
            print(now(), f"  {j + 1}/{len(keys)} {time.time() - t0:.0f}s", flush=True)
    st = Store(keys, base, lls, lcs)
    os.makedirs(a.out, exist_ok=True)
    st.save(os.path.join(a.out, "store.npz"))
    print(now(), "cache written", st.ll.shape, flush=True)


def load_rows(rows_dir, T):
    z = np.load(os.path.join(rows_dir, f"rowsB-T{T}.npz"))
    d = z["d_idx"]
    return {"i": z["i"][d], "ts": z["ts"][d], "sid": z["sid"][d], "y": z["y"][d], "fH": z["fH"][d],
            "a": z["a"][d], "f": z["f"][d]}


def cmd_run(a):
    st = Store.load(os.path.join(a.out, "store.npz"))
    excl = set(json.load(open(os.path.join(a.rows, "excluded.json"))))
    keys = st.keys
    if a.pool == "all":
        sids = [s for s, k in enumerate(keys) if k not in excl]
    else:
        sids = [s for s, k in enumerate(keys) if group_of(k) in ("btc_eth", "large") and k not in excl]
    print(now(), f"START r194 run pool {a.pool}; code {git_sha()}; library series {len(sids)}", flush=True)
    L0, L1 = build_libraries(st, sids)
    # test rows: every daily row of the scored groups, T in TS_V
    rows = {T: load_rows(a.rows, T) for T in TS_V}
    test_s = np.array([s for s, k in enumerate(keys) if k not in excl and k != "P1:KRAKEN-ETH"])
    need = {}
    for T in TS_V:
        R = rows[T]
        m = np.isin(R["sid"], test_s)
        gi = st.ooff[R["sid"]] + R["i"]
        sg, vb = st.sig[gi], st.vb[gi]
        q = quarter_start(R["ts"])
        R.update(m=m, sg=sg, vb=vb, q=q)
        for qq, vv in set(zip(q[m & np.isfinite(sg) & (vb >= 0)].tolist(), vb[m & np.isfinite(sg) & (vb >= 0)].tolist())):
            need[(qq, vv)] = True
    print(now(), f"  tables needed: {len(need)} (quarter, v0) cells x {len(KS)} k x {len(CONFIGS)} configs", flush=True)
    tabs, fbrec = {}, {}
    rng = np.random.default_rng(SEED_MC)
    t0 = time.time()
    for j, (qq, vv) in enumerate(sorted(need)):
        U = rng.random((7, NPATH))
        for k in KS:
            for cn, stp in CONFIGS.items():
                n = nsteps(k, stp)
                b = np.log1p(k) / n
                P, fb = chain_table(st, L0, L1, qq, vv, b, n, U)
                tabs[(qq, vv, k, cn)] = P
                fbrec[f"{qq}_{vv}_{k}_{cn}"] = fb
        if (j + 1) % 20 == 0:
            print(now(), f"  {j + 1}/{len(need)} cells {time.time() - t0:.0f}s", flush=True)
    out = {}
    for ti, T in enumerate(TS_V):
        R = rows[T]
        nr = len(R["ts"])
        res = {}
        for k in KS:
            nb = (np.log1p(k))
            for cn, stp in CONFIGS.items():
                n = nsteps(k, stp)
                p = np.full(nr, np.nan)
                for (qq, vv) in set(zip(R["q"].tolist(), R["vb"].tolist())):
                    key = (qq, vv, k, cn)
                    if key not in tabs or tabs[key] is None:
                        continue
                    sel = (R["q"] == qq) & (R["vb"] == vv) & R["m"] & np.isfinite(R["sg"])
                    if not sel.any():
                        continue
                    x1 = (nb / n) / R["sg"][sel]
                    p[sel] = interp_rows(tabs[key], x1)[:, ti]
                res[(k, cn)] = p
        for cn in CONFIGS:                                   # running minimum over k
            p30, p20 = res[(-0.30, cn)], res[(-0.20, cn)]
            res[(-0.30, cn)] = np.where(np.isfinite(p30) & np.isfinite(p20), np.minimum(p30, p20), p30)
        out[T] = {f"p_{cn}_k{int(-100 * k)}": res[(k, cn)].astype(np.float32) for (k, cn) in res}
        out[T]["sg"] = R["sg"].astype(np.float32)
        out[T]["vb"] = R["vb"]
        np.savez_compressed(os.path.join(a.out, f"chain-{a.pool}-T{T}.npz"), **out[T])
    json.dump({"code": git_sha(), "pool": a.pool, "library_series": len(sids), "L0": int(len(L0.end_ts)),
               "L1_per_xp": [int((L1.cell == p).sum()) for p in range(len(XP))], "fallback": fbrec,
               "finished_utc": now()}, open(os.path.join(a.out, f"chain-{a.pool}-meta.json"), "w"))
    print(now(), "done run", a.pool, flush=True)


# =====================================================================================================================
# scoring (R19.3c conventions)
# =====================================================================================================================
def logit(p):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return np.log(p / (1 - p))


def _logistic_fit(xb, nb, yb):
    """weighted binomial logistic y_b / n_b ~ a + b x_b; IRLS."""
    ok = nb > 0
    xb, nb, yb = xb[ok], nb[ok], yb[ok]
    if len(xb) < 3 or yb.sum() <= 0 or yb.sum() >= nb.sum():
        return np.nan
    beta = np.array([0.0, 1.0])
    X = np.stack([np.ones_like(xb), xb], axis=1)
    for _ in range(50):
        eta = X @ beta
        mu = 1 / (1 + np.exp(-eta))
        W = nb * mu * (1 - mu) + 1e-12
        z = eta + (yb - nb * mu) / W
        XtW = X.T * W
        try:
            nb_ = np.linalg.solve(XtW @ X, XtW @ z)
        except np.linalg.LinAlgError:
            return np.nan
        if np.max(np.abs(nb_ - beta)) < 1e-8:
            beta = nb_
            break
        beta = nb_
    return float(beta[1])


def _qbins(x, nb):
    qs = np.quantile(x, np.linspace(0, 1, nb + 1)[1:-1])
    return np.searchsorted(qs, x, side="right")


def _auc_binned(bins, w, y, nb):
    pos = np.bincount(bins, weights=w * y, minlength=nb)
    neg = np.bincount(bins, weights=w * (1 - y), minlength=nb)
    P, Nn = pos.sum(), neg.sum()
    if P <= 0 or Nn <= 0:
        return np.nan
    cneg = np.concatenate([[0], np.cumsum(neg)[:-1]])
    return float((pos * (cneg + 0.5 * neg)).sum() / (P * Nn))


def score_cell(p, y, comps, sid, ts, two_way=True, B=B_BOOT, seed=SEED_BOOT):
    """p: forecast; comps: dict name -> comparator forecast (e is built inside); returns point stats and 95% CIs."""
    y = y.astype(float)
    blk = (ts // BLOCK).astype(np.int64)
    us, si = np.unique(sid, return_inverse=True)
    ub, bi = np.unique(blk, return_inverse=True)
    lb = _qbins(logit(p), 100)
    ab = _qbins(p, 200)
    lgt = logit(p)

    def stats(w):
        sw = w.sum()
        sy = (w * y).sum()
        out = {"R": (w * p).sum() / sy if sy > 0 else np.nan}
        e = sy / sw
        b1 = (w * (p - y) ** 2).sum()
        out["bss_e"] = 1 - b1 / (w * (e - y) ** 2).sum()
        for nm, c in comps.items():
            out[f"bss_{nm}"] = 1 - b1 / (w * (c - y) ** 2).sum()
        nbw = np.bincount(lb, weights=w, minlength=100)
        ybw = np.bincount(lb, weights=w * y, minlength=100)
        xbw = np.bincount(lb, weights=w * lgt, minlength=100) / np.maximum(nbw, 1e-12)
        out["slope"] = _logistic_fit(xbw, nbw, ybw)
        out["auc"] = _auc_binned(ab, w, y, 200)
        return out
    pt = stats(np.ones(len(y)))
    rng = np.random.default_rng(seed)
    draws = []
    for _ in range(B):
        cb = rng.multinomial(len(ub), np.full(len(ub), 1 / len(ub))).astype(float)
        if two_way:
            cs = rng.multinomial(len(us), np.full(len(us), 1 / len(us))).astype(float)
            w = cs[si] * cb[bi]
        else:
            w = cb[bi]
        if w.sum() <= 0 or (w * y).sum() <= 0:
            continue
        draws.append(stats(w))
    ci = {}
    for kk in pt:
        v = np.array([d[kk] for d in draws], float)
        v = v[np.isfinite(v)]
        ci[kk] = [float(np.quantile(v, 0.025)), float(np.quantile(v, 0.975))] if len(v) > 20 else [np.nan, np.nan]
    pos = int(y.sum())
    posblk = int(len(np.unique(blk[y > 0])))
    cal = bool(R_BAND[0] <= pt["R"] <= R_BAND[1] and ci["slope"][0] <= 1 <= ci["slope"][1])
    inf = bool(ci["bss_a"][0] > 0 and ci["bss_e"][0] > 0) if "bss_a" in ci else None
    return {"n": int(len(y)), "pos": pos, "pos_blocks": posblk, "point": {k: float(v) for k, v in pt.items()},
            "ci": ci, "calibrated": cal, "informative": inf, "estimable": pos >= MIN_POS,
            "mean_p": float(p.mean()), "rate": float(y.mean())}


def cmd_score(a):
    st_keys = json.load(open(os.path.join(a.rows, "rowsB-meta.json")))["series"]
    groups = np.array([group_of(k) for k in st_keys])
    excl = set(json.load(open(os.path.join(a.rows, "excluded.json"))))
    okser = np.array([(k not in excl) and k != "P1:KRAKEN-ETH" for k in st_keys])
    res = {"code": git_sha(), "started_utc": now(), "cells": {}}
    pools = [p for p in ("all", "maj") if os.path.exists(os.path.join(a.out, f"chain-{p}-T24.npz"))]
    for T in TS_V:
        R = load_rows(a.rows, T)
        C = {p: dict(np.load(os.path.join(a.out, f"chain-{p}-T{T}.npz"))) for p in pools}
        for k in KS:
            j = L8.index(k)
            for grp in ("btc_eth", "large", "alt"):
                base = okser[R["sid"]] & (groups[R["sid"]] == grp)
                for p in pools:
                    c = C[p]
                    for cn in CONFIGS:
                        pc = c[f"p_{cn}_k{int(-100 * k)}"].astype(float)
                        lib1 = c[f"p_lib1_k{int(-100 * k)}"].astype(float)
                        m = base & np.isfinite(pc) & np.isfinite(lib1)
                        if m.sum() < 50:
                            continue
                        comps = {"a": R["a"][m, j].astype(float), "fH": R["fH"][m, j].astype(float)}
                        if cn != "lib1":
                            comps["lib1"] = lib1[m]
                        sc = score_cell(pc[m], R["y"][m, j], comps, R["sid"][m], R["ts"][m],
                                        two_way=(grp != "btc_eth"))
                        sc["coverage"] = float(m.sum() / max(base.sum(), 1))
                        # pooling checks: R by v bin (point only)
                        vb = c["vb"][m]
                        sc["R_by_v"] = {int(v): (float(pc[m][vb == v].sum() / max(R["y"][m, j][vb == v].sum(), 1e-9)),
                                                 int(R["y"][m, j][vb == v].sum())) for v in range(NV)}
                        res["cells"][f"{grp}|T{T}|k{int(-100 * k)}|{p}|{cn}"] = sc
                    # direct (fH) on the same rows, for reference
                m = base & np.isfinite(C[pools[0]][f"p_c10_k{int(-100 * k)}"])
                if m.sum() >= 50:
                    sc = score_cell(R["fH"][m, j].astype(float), R["y"][m, j], {"a": R["a"][m, j].astype(float)},
                                    R["sid"][m], R["ts"][m], two_way=(grp != "btc_eth"))
                    res["cells"][f"{grp}|T{T}|k{int(-100 * k)}|-|fH"] = sc
        print(now(), f"  scored T {T}", flush=True)
    res["finished_utc"] = now()
    json.dump(res, open(os.path.join(a.out, "score-r194.json"), "w"), indent=1)
    print(now(), "score written", flush=True)


# =====================================================================================================================
# synthetic known-answer (GJR-GARCH-t)
# =====================================================================================================================
SYN = dict(alpha=0.06, gamma=0.06, beta=0.90, nu=4.0, nser=60, years=6, vlo=0.004, vhi=0.020)


def _tz(rng, shape, nu):
    return rng.standard_t(nu, size=shape) / np.sqrt(nu / (nu - 2))


def syn_series(rng):
    al, ga, be, nu = SYN["alpha"], SYN["gamma"], SYN["beta"], SYN["nu"]
    Nh = SYN["years"] * 365 * 24
    pers = al + 0.5 * ga + be
    lcs, hs, sv = [], [], []
    for s in range(SYN["nser"]):
        su = np.exp(rng.uniform(np.log(SYN["vlo"]), np.log(SYN["vhi"])))
        om = su * su * (1 - pers)
        z = _tz(rng, Nh, nu)
        h = np.empty(Nh)
        r = np.empty(Nh)
        hh = su * su
        for t in range(Nh):
            h[t] = hh
            r[t] = np.sqrt(hh) * z[t]
            hh = om + (al + (ga if r[t] < 0 else 0.0)) * r[t] * r[t] + be * hh
        lc = np.cumsum(r)
        lcs.append(lc)
        hs.append(np.concatenate([h, [hh]]))            # h[i] = variance of the return of bar i (origin-indexed)
        sv.append(su)
    return lcs, hs, sv


def syn_truth(rng, lc_prev, h0, Ts, ks, npath):
    """true P(min over bars 0..T-1 of low <= S(1+k)) with low_j = min(c_{j-1}, c_j) == min of closes path."""
    al, ga, be, nu = SYN["alpha"], SYN["gamma"], SYN["beta"], SYN["nu"]
    om = h0["om"]
    hh = np.full(npath, h0["h"])
    x = np.zeros(npath)
    m = np.zeros(npath)
    out = {}
    lk = np.log1p(np.array(ks))
    hit = np.zeros((npath, len(ks)), bool)
    first = {}
    for t in range(max(Ts)):
        z = _tz(rng, npath, nu)
        r = np.sqrt(hh) * z
        x += r
        m = np.minimum(m, x)
        hh = om + (al + ga * (r < 0)) * r * r + be * hh
        hit |= m[:, None] <= lk[None, :]
        if t + 1 in Ts:
            out[t + 1] = hit.mean(axis=0)
    return out


def cmd_synth(a):
    os.makedirs(a.out, exist_ok=True)
    rng = np.random.default_rng(SEED_SYN)
    t0 = time.time()
    lcs, hs, sv = syn_series(rng)
    print(now(), f"  simulated {len(lcs)} series ({time.time() - t0:.0f}s)", flush=True)
    keys = [f"syn:{j}" for j in range(len(lcs))]
    base = [0] * len(lcs)
    st = Store(keys, base, lcs, lcs)        # low of bar j = min(c_{j-1}, c_j); fixed below
    lls = []
    for lc in lcs:
        lo = lc.copy()
        lo[1:] = np.minimum(lc[:-1], lc[1:])
        lls.append(lo)
    st.ll = np.concatenate(lls)
    Nh = len(lcs[0])
    cut_ts = 5 * 365 * 24 * STEP
    L0, L1 = build_libraries(st, list(range(len(lcs))))
    # test origins: daily in year 6, need full 168 h ahead
    orig = np.arange(5 * 365 * 24, Nh - HMAX, 24)
    S_ = np.repeat(np.arange(len(lcs)), len(orig))
    I_ = np.tile(orig, len(lcs))
    gi = st.ooff[S_] + I_
    sg, vb = st.sig[gi], st.vb[gi]
    ok = np.isfinite(sg) & (vb >= 0)
    S_, I_, sg, vb = S_[ok], I_[ok], sg[ok], vb[ok]
    sub = np.sort(rng.choice(len(S_), min(3000, len(S_)), replace=False))
    S_, I_, sg, vb = S_[sub], I_[sub], sg[sub], vb[sub]
    U = np.random.default_rng(SEED_MC).random((7, NPATH))
    preds = {}
    fbs = {}
    for k in KS:
        for cn, stp in CONFIGS.items():
            n = nsteps(k, stp)
            b = np.log1p(k) / n
            p = np.full((len(S_), len(TS_V)), np.nan)
            for vv in range(NV):
                sel = vb == vv
                if not sel.any():
                    continue
                P, fb = chain_table(st, L0, L1, cut_ts, vv, b, n, U)
                fbs[f"{k}_{cn}_{vv}"] = fb
                if P is None:
                    continue
                p[sel] = interp_rows(P, b / sg[sel])
            preds[(k, cn)] = p
    for cn in CONFIGS:
        p30, p20 = preds[(-0.30, cn)], preds[(-0.20, cn)]
        preds[(-0.30, cn)] = np.where(np.isfinite(p30) & np.isfinite(p20), np.minimum(p30, p20), p30)
    print(now(), f"  chain forecasts done ({time.time() - t0:.0f}s)", flush=True)
    # truth
    al, ga, be = SYN["alpha"], SYN["gamma"], SYN["beta"]
    pers = al + 0.5 * ga + be
    truth = np.zeros((len(S_), len(TS_V), len(KS)))
    rt = np.random.default_rng(SEED_SYN + 1)
    for j in range(len(S_)):
        s, i = S_[j], I_[j]
        h0 = {"h": hs[s][i], "om": sv[s] ** 2 * (1 - pers)}
        o = syn_truth(rt, None, h0, TS_V, KS, a.npath)
        for ti, T in enumerate(TS_V):
            truth[j, ti, :] = o[T]
        if (j + 1) % 500 == 0:
            print(now(), f"  truth {j + 1}/{len(S_)} ({time.time() - t0:.0f}s)", flush=True)
    res = {"code": git_sha(), "params": SYN, "n_origins": int(len(S_)), "npath_truth": a.npath, "cells": {},
           "fallback": fbs}
    for ki, k in enumerate(KS):
        for ti, T in enumerate(TS_V):
            pt = truth[:, ti, ki]
            cell = {"mean_p_true": float(pt.mean())}
            for cn in CONFIGS:
                pc = preds[(k, cn)][:, ti]
                m = np.isfinite(pc)
                ratio = float(pc[m].sum() / max(pt[m].sum(), 1e-12))
                mm = m & (pt >= 1e-4)
                if mm.sum() > 10:
                    X = logit(pc[mm])
                    Y = logit(pt[mm])
                    slope_logit = float(np.cov(X, Y)[0, 1] / np.var(X, ddof=1))
                else:
                    slope_logit = float("nan")
                # D-R19.4a: the pass slope is the probability-space OLS of p_true on p_chain over all origins
                slope = float(np.cov(pc[m], pt[m])[0, 1] / np.var(pc[m], ddof=1)) if m.sum() > 10 else float("nan")
                msd = float(np.mean((pc[m] - pt[m]) ** 2))
                scored = cell["mean_p_true"] >= 0.002
                passed = bool(scored and 0.85 <= ratio <= 1.18 and 0.8 <= slope <= 1.25)
                cell[cn] = {"ratio": ratio, "slope": slope, "slope_logit": slope_logit, "msd": msd, "mean_p": float(pc[m].mean()),
                            "scored": scored, "pass": passed, "n": int(m.sum())}
            res["cells"][f"T{T}|k{int(-100 * k)}"] = cell
    res["finished_utc"] = now()
    json.dump(res, open(os.path.join(a.out, "synth-r194.json"), "w"), indent=1)
    print(now(), "synth written", flush=True)


def main():
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest="cmd", required=True)
    c = sp.add_parser("cache")
    c.add_argument("--datasets", required=True)
    c.add_argument("--rows", required=True)
    c.add_argument("--out", required=True)
    c = sp.add_parser("run")
    c.add_argument("--rows", required=True)
    c.add_argument("--out", required=True)
    c.add_argument("--pool", choices=("all", "maj"), default="all")
    c = sp.add_parser("score")
    c.add_argument("--rows", required=True)
    c.add_argument("--out", required=True)
    c = sp.add_parser("synth")
    c.add_argument("--out", required=True)
    c.add_argument("--npath", type=int, default=4000)
    a = ap.parse_args()
    {"cache": cmd_cache, "run": cmd_run, "score": cmd_score, "synth": cmd_synth}[a.cmd](a)


if __name__ == "__main__":
    main()
