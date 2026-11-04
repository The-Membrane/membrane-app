"""Q26-FM: fast-move leverage-covariate test (membrane-board design/Q26_FAST_MOVE_PREREG.md, board 1756d88). Fixed by that file.
  episodes  build synthetic frozen-line episodes on hourly Binance spot, per pair, with covariates at every check
  score     R0, L1, L2, L3 against the matched-volume comparator B0; two-way bootstrap; shared-path null; breakdowns
Inputs: membrane-datasets binance-klines/<PAIR>-1h.json, binance-futures-metrics/<PAIR>-metrics-1h.jsonl.gz. No outcome is a
real position; no address exists. Development only."""
import argparse, gzip, json, math, os, sys, datetime as dt
import numpy as np

PAIRS = ["ETHUSDT", "BTCUSDT", "SOLUSDT", "AVAXUSDT", "LINKUSDT", "DOGEUSDT", "ADAUSDT", "XRPUSDT", "LTCUSDT", "BNBUSDT"]
D0 = [0.05, 0.075, 0.10, 0.15]
BAND, LIFE_H = 0.10, 30 * 24
START_TS = int(dt.datetime(2022, 3, 1, tzinfo=dt.UTC).timestamp()); END_TS = int(dt.datetime(2026, 10, 6, tzinfo=dt.UTC).timestamp())
R0_THR, TIER_THR = 0.03, 0.05
Q_OI, D_OI, TF = 2.0 / 3.0, -0.05, 1.2
BLOCK_S = 28 * 86400
B_DRAWS, SEED, NULL_DRAWS, NULL_SEED = 1000, 20261105, 200, 7
SPEED_EDGES = (0.0322, 0.0611)
GRID = np.round(np.arange(0.03, 0.1001, 0.0005), 4)


# -------------------------------------------------------------------------------------------------- inputs
def load_klines(path):
    d = json.load(open(path)); c = d["columns"]
    t = d["startTs"] + d["stepSeconds"] * np.arange(d["count"])
    f = lambda k: np.array([np.nan if x is None else float(x) for x in c[k]])
    o, h, l, cl = f("open"), f("high"), f("low"), f("close")
    return {"t": t.astype(np.int64), "o": o, "h": h, "l": l, "c": cl, "G": (o + h + l + cl) / 4}


def load_metrics(path):
    rows = [json.loads(x) for x in gzip.open(path, "rt")]
    rows.sort(key=lambda r: r["h"])
    h = np.array([r["h"] for r in rows], dtype=np.int64)
    f = lambda k: np.array([np.nan if r.get(k) is None else float(r[k]) for r in rows], dtype=np.float64)
    oi = f("oi"); tk = f("taker")
    return {"h": h, "oi": oi, "taker": tk}


def covariates(M, grid_t):
    """At each hour of grid_t: q_oi (trailing-90 d percentile of OI), d_oi (24 h log change), tf (6 h mean taker ratio). nan if missing."""
    n = len(grid_t)
    idx = np.searchsorted(M["h"], grid_t, side="right") - 1
    ok = (idx >= 0) & (M["h"][np.clip(idx, 0, len(M["h"]) - 1)] == grid_t)
    oi = np.where(ok, M["oi"][np.clip(idx, 0, None)], np.nan); tk = np.where(ok, M["taker"][np.clip(idx, 0, None)], np.nan)
    q = np.full(n, np.nan); d24 = np.full(n, np.nan); tf6 = np.full(n, np.nan)
    W = 90 * 24
    # rolling percentile with a sorted window (O(n·W) is fine at this size: 40k × 2160)
    from bisect import bisect_left, insort
    win = []; buf = []
    for i in range(n):
        x = oi[i]
        if i >= W:
            old = buf[i - W]
            if not np.isnan(old):
                del win[bisect_left(win, old)]
        buf.append(x)
        if not np.isnan(x):
            if len(win) >= 24 * 30:
                q[i] = bisect_left(win, x) / len(win)
            insort(win, x)
        if i >= 24 and not np.isnan(x) and x > 0 and not np.isnan(oi[i - 24]) and oi[i - 24] > 0:
            d24[i] = math.log(x / oi[i - 24])
        if i >= 5:
            s = tk[i - 5:i + 1]
            if not np.isnan(s).any(): tf6[i] = s.mean()
    return {"q_oi": q, "d_oi": d24, "tf": tf6}


# -------------------------------------------------------------------------------------------------- episodes
def episodes(K, C, pair):
    """One record per episode: start check index, touch bar index or -1, exit index, the per-check distance path, covariates at checks."""
    t, G, lo, cl = K["t"], K["G"], K["l"], K["c"]
    n = len(t)
    out = []
    day0 = np.where((t % 86400 == 0) & (t >= START_TS) & (t <= END_TS))[0]
    for k0 in day0:                       # 00:00Z open of bar k0; the line is set from the bar ending at 00:00 (bar k0-1)
        if k0 < 1 or np.isnan(G[k0 - 1]): continue
        G0 = G[k0 - 1]
        for d0 in D0:
            L = G0 * (1 - d0)
            kend = min(n - 1, k0 + LIFE_H - 1)
            # touch bar: first bar j in [k0, kend] with low <= L
            lows = lo[k0:kend + 1]; hit = np.where(lows <= L)[0]
            j = k0 + hit[0] if len(hit) else -1
            # checks at bar ends: check after bar k uses G[k]; episode starts at first k in [k0, kend] with 0 < d <= BAND
            d = 1 - L / G[k0:kend + 1]
            inband = np.where((d > 0) & (d <= BAND) & ~np.isnan(d))[0]
            if not len(inband): continue
            ks = k0 + inband[0]
            if j != -1 and j < ks:        # touched before any check could see it in the band -> unwarnable, lead < 0
                out.append({"pair": pair, "d0": d0, "open": int(t[k0]), "start": int(t[ks]) + 3600, "k_start": int(ks), "k_touch": int(j), "k_exit": -1,
                            "end_kind": "touch", "unreachable": True, "checks": np.array([], dtype=int), "dist": np.array([]), "L": L})
                continue
            # walk checks from ks: exit at first d > BAND (before touch) ; touch bar j ends the episode (checks run up to and including bar j-1... the
            # check at the touch bar's open (= end of bar j-1) is inside the episode)
            kstop = j if j != -1 else kend + 1          # checks k in [ks, kstop-1]
            seg = d[ks - k0: kstop - k0]
            ex = np.where(seg > BAND)[0]
            if len(ex):
                kx = ks + ex[0]; checks = np.arange(ks, kx); kind = "exit"; jj = -1
            else:
                checks = np.arange(ks, kstop); kind = "touch" if j != -1 else "life"; jj = j
            out.append({"pair": pair, "d0": d0, "open": int(t[k0]), "start": int(t[ks]) + 3600, "k_start": int(ks), "k_touch": int(jj), "k_exit": int(ks + ex[0]) if len(ex) else -1,
                        "end_kind": kind, "unreachable": False, "checks": checks, "dist": d[checks - k0], "L": L})
    return out


def attach_cov(eps, C, shift_h=0, n=None):
    """covariate arrays at check times; shift_h rolls the covariate series in time (shared-path null)."""
    for e in eps:
        ck = e["checks"]
        if len(ck) == 0:
            e["cov"] = {k: np.array([]) for k in C}; continue
        idx = (ck + 1 - shift_h) % n if shift_h else ck + 1        # check after bar k happens at the hour of bar k+1's open
        idx = np.clip(idx, 0, n - 1)
        e["cov"] = {k: C[k][idx] for k in C}


# -------------------------------------------------------------------------------------------------- rules
def fire_index(e, rule, thr=None):
    """index into e['checks'] of the first firing check, or -1."""
    d = e["dist"]; cv = e["cov"]
    if rule == "R0": cond = d <= R0_THR
    elif rule == "B0": cond = d <= thr
    elif rule == "L1": cond = (d <= R0_THR) | ((d <= TIER_THR) & (cv["q_oi"] >= Q_OI))
    elif rule == "L2": cond = (d <= R0_THR) | ((d <= TIER_THR) & (cv["d_oi"] <= D_OI))
    elif rule == "L3": cond = (d <= R0_THR) | ((d <= TIER_THR) & (cv["tf"] >= TF))
    else: raise ValueError(rule)
    w = np.where(np.nan_to_num(cond, nan=False))[0]
    return int(w[0]) if len(w) else -1


def outcome(e, fi):
    """(alerted, early_hit, late_hit, false_alarm, lead_h)"""
    if fi < 0: return (0, 0, 0, 0, np.nan)
    kal = e["checks"][fi]
    if e["end_kind"] == "touch":
        lb = e["k_touch"] - (kal + 1)
        return (1, int(lb >= 1), int(lb == 0), 0, lb)
    return (1, 0, 0, 1, np.nan)


def quarter(ts): d = dt.datetime.fromtimestamp(ts, dt.UTC); return d.year * 10 + (d.month - 1) // 3


def match_b0(eps, cand_fire):
    """per quarter of episode start: B0 threshold on the grid whose alert count is nearest the candidate's (vectorised on each
    episode's minimum distance; B0 fires in an episode iff min d <= x)."""
    qs = np.array([quarter(e["start"]) for e in eps]); thr = {}
    dmin = np.array([e["dist"].min() if len(e["dist"]) else np.inf for e in eps])
    cf = np.array(cand_fire) >= 0
    for q in np.unique(qs):
        ix = qs == q
        target = int(cf[ix].sum())
        srt = np.sort(dmin[ix])
        counts = np.searchsorted(srt, GRID, side="right")
        k = int(np.argmin(np.abs(counts - target)))
        thr[q] = float(GRID[k])
    return thr, qs


def evaluate(eps, rule, b0thr=None, qs=None):
    fires = [fire_index(e, rule, thr=(b0thr[qs[i]] if rule == "B0" else None)) for i, e in enumerate(eps)]
    return fires, [outcome(e, f) for e, f in zip(eps, fires)]


def summarize(eps, outs, mask=None):
    m = np.ones(len(eps), bool) if mask is None else mask
    touch = np.array([e["end_kind"] == "touch" for e in eps]) & m
    early = np.array([o[1] for o in outs]); fa = np.array([o[3] for o in outs]); al = np.array([o[0] for o in outs])
    posdays = sum(max(1, len(e["checks"])) for e, mm in zip(eps, m) if mm) / 24
    return {"touches": int(touch.sum()), "recall": float(early[touch].sum() / touch.sum()) if touch.sum() else np.nan,
            "alerts": int(al[m].sum()), "false_alarms": int(fa[m].sum()), "fa_per_week": float(7 * fa[m].sum() / posdays) if posdays else np.nan}


def bootstrap(eps, outsA, outsB, pairs, blocks):
    """two-way pigeonhole: resample pairs and blocks; weight each episode by m_pair * m_block. Returns draws of (recallA, recallB, gain, faA/faB)."""
    rng = np.random.default_rng(SEED)
    up, ub = np.unique(pairs), np.unique(blocks)
    touch = np.array([e["end_kind"] == "touch" for e in eps]).astype(float)
    eA = np.array([o[1] for o in outsA], float); eB = np.array([o[1] for o in outsB], float)
    fA = np.array([o[3] for o in outsA], float); fB = np.array([o[3] for o in outsB], float)
    pi = np.searchsorted(up, pairs); bi = np.searchsorted(ub, blocks)
    draws = []
    for _ in range(B_DRAWS):
        mp = np.bincount(rng.integers(0, len(up), len(up)), minlength=len(up)); mb = np.bincount(rng.integers(0, len(ub), len(ub)), minlength=len(ub))
        w = mp[pi] * mb[bi]
        T = (w * touch).sum()
        if T == 0: continue
        rA, rB = (w * eA).sum() / T, (w * eB).sum() / T
        far = (w * fA).sum() / max(1, (w * fB).sum())
        draws.append((rA, rB, rA - rB, far))
    a = np.array(draws)
    pct = lambda col, q: float(np.percentile(a[:, col], q))
    return {"draws": len(a), "recallA_ci90": [pct(0, 5), pct(0, 95)], "recallB_ci90": [pct(1, 5), pct(1, 95)], "gain_ci90": [pct(2, 5), pct(2, 95)], "fa_ratio_ci90": [pct(3, 5), pct(3, 95)]}


def speed_tercile(K, e):
    if e["end_kind"] != "touch" or e["k_touch"] < 6: return None
    j = e["k_touch"]; drop = 1 - K["l"][j] / K["c"][j - 6]
    return 0 if drop < SPEED_EDGES[0] else 1 if drop < SPEED_EDGES[1] else 2


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--klines", required=True); ap.add_argument("--metrics", required=True); ap.add_argument("--out", required=True)
    ap.add_argument("--pairs", default=",".join(PAIRS)); ap.add_argument("--null-draws", type=int, default=NULL_DRAWS)
    a = ap.parse_args()
    eps = []; Ks = {}; Cs = {}
    for p in a.pairs.split(","):
        K = load_klines(os.path.join(a.klines, f"{p}-1h.json")); M = load_metrics(os.path.join(a.metrics, f"{p}-metrics-1h.jsonl.gz"))
        C = covariates(M, K["t"]); E = episodes(K, C, p); attach_cov(E, C, 0, len(K["t"]))
        for e in E: e["speed"] = speed_tercile(K, e)
        eps += E; Ks[p] = K; Cs[p] = C
        print(p, "episodes", len(E), "touches", sum(e["end_kind"] == "touch" for e in E), "unreachable", sum(e["unreachable"] for e in E), file=sys.stderr, flush=True)
    scored = [e for e in eps if not e["unreachable"]]
    pairs = np.array([e["pair"] for e in scored]); blocks = np.array([(e["start"] - START_TS) // BLOCK_S for e in scored])
    res = {"schema": "q26-fm/1", "prereg": "membrane-board design/Q26_FAST_MOVE_PREREG.md @1756d88", "episodes": len(eps), "scored": len(scored),
           "unreachable_touches": int(sum(e["unreachable"] for e in eps)), "rules": {}}
    f0, o0 = evaluate(scored, "R0"); res["rules"]["R0"] = {"all": summarize(scored, o0)}
    for rule in ("L1", "L2", "L3"):
        fk, ok_ = evaluate(scored, rule)
        thr, qs = match_b0(scored, fk)
        fb, ob = evaluate(scored, "B0", thr, qs)
        r = {"all": summarize(scored, ok_), "B0_matched": summarize(scored, ob), "b0_thresholds": {int(q): float(x) for q, x in thr.items()},
             "bootstrap": bootstrap(scored, ok_, ob, pairs, blocks), "breakdowns": {}}
        r["gain"] = r["all"]["recall"] - r["B0_matched"]["recall"]; r["fa_ratio"] = r["all"]["false_alarms"] / max(1, r["B0_matched"]["false_alarms"])
        for name, mask in (("speed_slow", np.array([e["speed"] == 0 for e in scored])), ("speed_mid", np.array([e["speed"] == 1 for e in scored])), ("speed_fast", np.array([e["speed"] == 2 for e in scored])),
                           ("eth_btc", np.isin(pairs, ["ETHUSDT", "BTCUSDT"])), ("alts", ~np.isin(pairs, ["ETHUSDT", "BTCUSDT"])),
                           ("half1", np.array([e["start"] < int(dt.datetime(2024, 7, 1, tzinfo=dt.UTC).timestamp()) for e in scored])), ("half2", np.array([e["start"] >= int(dt.datetime(2024, 7, 1, tzinfo=dt.UTC).timestamp()) for e in scored]))):
            r["breakdowns"][name] = {"rule": summarize(scored, ok_, mask), "B0": summarize(scored, ob, mask)}
        # shared-path null: shift covariates per pair by whole days (>= 30 d from each end, circular)
        rng = np.random.default_rng(NULL_SEED); gains = []
        for _ in range(a.null_draws):
            for p in Ks:
                n = len(Ks[p]["t"]); sh = int(rng.integers(30, n // 24 - 30)) * 24
                attach_cov([e for e in scored if e["pair"] == p], Cs[p], sh, n)
            fn, on = evaluate(scored, rule); thn, qsn = match_b0(scored, fn); fbn, obn = evaluate(scored, "B0", thn, qsn)
            gains.append(summarize(scored, on)["recall"] - summarize(scored, obn)["recall"])
        for p in Ks: attach_cov([e for e in scored if e["pair"] == p], Cs[p], 0, len(Ks[p]["t"]))
        r["null"] = {"draws": len(gains), "q95": float(np.nanpercentile(gains, 95)) if gains else None, "median": float(np.nanmedian(gains)) if gains else None}
        ci = r["bootstrap"]["gain_ci90"]
        r["beats_B0"] = bool(r["gain"] >= 0.05 and ci[0] > 0 and r["fa_ratio"] <= 1.10 and (r["null"]["q95"] is None or r["gain"] > r["null"]["q95"]))
        res["rules"][rule] = r
        print(rule, "recall", round(r["all"]["recall"], 3), "B0", round(r["B0_matched"]["recall"], 3), "gain", round(r["gain"], 3), ci, "fa_ratio", round(r["fa_ratio"], 3), "null q95", r["null"]["q95"], "beats", r["beats_B0"], file=sys.stderr, flush=True)
    json.dump(res, open(a.out, "w"), indent=1, default=float)


if __name__ == "__main__":
    main()
