"""Q26 R16.2 neural development INSTRUMENT AUDIT (Claude, O184 lane, 2026-10-23). DEVELOPMENT ONLY (seen data).

membrane-board design/Q26_ROUND16_PREREG.md D-R16.2e-a. Purpose: test whether the seen-development GRU edge over (fH)
(O56: shallow tier two-way z -8.09, mean BSS +0.0139) survives a STRICT temporal protocol.

Split audit of the original r16_nn.py (recorded before any strict output): 2 series halves x 2 time halves split at the
tier's median origin time (shallow: 1719122400 = 2024-06-23). A test cell (series half h, time half t) is predicted by
a model trained on the OTHER series half and the OTHER time half. So every early-half prediction comes from a model
fitted on LATER data (ts >= split + Tmax): future-peer training. Late-half predictions use earlier, other-series data.

Strict protocol (fixed here before any strict output):
  folds    half-year test windows [a, b) from 2019-01-01 to the end of the rows (Jan-Jun, Jul-Dec, UTC)
  train    rows of ALL series (own past included) whose window ends before the validation start:
           ts + Tmax h <= a - 90 d. No row from on or after the fold start can enter a fit.
  valid    early stopping on rows with ts >= e - 90 d and ts + Tmax h <= e, e = the end of the last available row window
           before a (e = a except after the dropped 2026Q2; amended before any score) (temporal hold-out)
  test     daily origins (ts % 86400 == 0) with a <= ts < b, as the original
  model    unchanged from r16_nn.py: make_model / build_batch imported; GRU(32) residual on logit p_fH, Adam lr 1e-3,
           wd 1e-4, batch 1024, dropout 0.1, epochs -1..3 with patience 1 (initial state eligible), 60,000-row uniform
           draw then the first 20,000 for ngru (CAP), validation at most 60,000 rows, running minimum across levels
  seed     SEED + fold index for torch and numpy (per fold, reproducible)
  exclude  leveraged / inverse / rebasing / pegged / stable series: symbol pattern check plus a data check
           (median |24 h return| < 0.2% flags a pegged-like series); flagged series are dropped from train and test
Scoring (score): strict GRU and the original GRU (rows-nn-T*.npz of the original run) on IDENTICAL rows (the strict test
rows), each vs (fH): per-cell BSS, R, the tier two-way (series x 4-week block) pigeonhole bootstrap z (B 1,000 as the
original scorer, plus B 10,000), percentile p, E1-E4, leave-top-k, top-k share, leave-one-event-out (the UTC day
with the most positive labels across all series and shallow cells), CGM two-way z, and R by time half (strict test
median and the original split) and by year.
Known-answer check (synth): a synthetic panel with a known touch probability (see cmd_synth).

  python3 r16_nn_strict.py fit   --datasets DS --rows ROWS_DIR --out OUT [--threads 3]
  python3 r16_nn_strict.py score --rows ROWS_DIR --orig ORIG_DIR --out OUT
  python3 r16_nn_strict.py synth --out OUT [--threads 1]
  python3 r16_nn_strict.py freeze --datasets DS --rows ROWS_DIR --out OUT   (frozen blind model, hashed)
No address, key or secret is read or written. Nothing here is blind evidence and nothing ships from it.
"""
from __future__ import annotations

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import datetime as dt  # noqa: E402
import json  # noqa: E402
import math  # noqa: E402
import re  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402

import numpy as np  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import r16_dev as D  # noqa: E402
import r16_nn as NN  # noqa: E402

STEP, DAY = 3600, 86400
TIER = "shallow"
MODEL = "ngru"
VAL_DAYS = 90
SEED = 20261023
EXCL_PAT = re.compile(r"(UP|DOWN|BULL|BEAR|[235]L|[235]S|HEDGE)USDT$|^(USDC|BUSD|TUSD|FDUSD|DAI|USDP|PAX|PAXG|XAUT|"
                      r"EUR|GBP|AEUR|USDD|PYUSD|UST|USTC|AMPL|OHM|STETH|WBTC|WBETH|BETH)USDT$")


def now():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def ts_of(y, m):
    return int(dt.datetime(y, m, 1, tzinfo=dt.timezone.utc).timestamp())


def folds(ts_max):
    out, y, m = [], 2019, 1
    while ts_of(y, m) <= ts_max:
        a = ts_of(y, m)
        y2, m2 = (y, 7) if m == 1 else (y + 1, 1)
        out.append((a, ts_of(y2, m2)))
        y, m = y2, m2
    return out


def symbol_of(key):
    return key.split(":")[-1].replace("KRAKEN-", "")


def exclusions(keys, SA):
    flags = {}
    for j, k in enumerate(keys):
        sym = symbol_of(k)
        why = []
        if EXCL_PAT.search(sym if sym.endswith("USDT") else sym + "USDT"):
            why.append("pattern")
        r24 = SA[j]["R24"][::24]
        r24 = r24[np.isfinite(r24) & (r24 != 0)]
        if len(r24) > 30 and np.median(np.abs(r24)) < 0.002:
            why.append("pegged-like median |24h ret| %.5f" % float(np.median(np.abs(r24))))
        if why:
            flags[k] = why
    return flags


def train_predict(m, R, SA, tr_full, va, te, L, nT, seed, log, tag, keep_state=None):
    """the r16_nn.py training loop, unchanged except the row sets and the seed."""
    import torch
    torch.manual_seed(seed)
    rng = np.random.default_rng(seed)
    t0 = time.time()
    tr = tr_full[:NN.CAP[m]]
    net = NN.make_model(m, len(NN.STATIC) + 2 + nT, L)
    opt = torch.optim.Adam(net.parameters(), lr=1e-3, weight_decay=1e-4)
    best, best_state, bad, ep_done = np.inf, None, 0, 0

    def batches(idx, shuffle):
        idx = rng.permutation(idx) if shuffle else idx
        for b0 in range(0, len(idx), 1024):
            ii = np.sort(idx[b0:b0 + 1024])
            Hh, Dd, S = NN.build_batch(SA, R["sid"][ii], R["ts"][ii], {k: R[k][ii] for k in NN.STATIC},
                                       R["Tidx"][ii], nT)
            lf = R["LF"][ii] if m != "nmlp0" else np.zeros((len(ii), L), np.float32)
            yield (ii, torch.from_numpy(Hh), torch.from_numpy(Dd), torch.from_numpy(S),
                   torch.from_numpy(lf), torch.from_numpy(R["Y"][ii].astype(np.float32)))

    def loss_of(o, y):
        mk = (y >= 0).float()
        l_ = torch.nn.functional.binary_cross_entropy_with_logits(o, y.clamp(min=0), reduction="none")
        return (l_ * mk).sum() / mk.sum()
    vls = []
    for ep in range(-1, 4):
        net.train()
        for _, h, d, s, lf, y in (batches(tr, True) if ep >= 0 else ()):
            opt.zero_grad()
            loss = loss_of(net(h, d, s, lf), y)
            loss.backward()
            opt.step()
        net.eval()
        tot, cnt = 0.0, 0.0
        with torch.no_grad():
            for _, h, d, s, lf, y in batches(va, False):
                mk = (y >= 0).float().sum().item()
                tot += loss_of(net(h, d, s, lf), y).item() * mk
                cnt += mk
        vl = tot / max(cnt, 1)
        vls.append(vl)
        ep_done = ep + 1
        if vl < best - 1e-6:
            best, bad = vl, 0
            best_state = {k: v.clone() for k, v in net.state_dict().items()}
        else:
            bad += 1
            if bad > 1:
                break
    net.load_state_dict(best_state)
    net.eval()
    out = np.full((len(te), L), np.nan, np.float32)
    pos = {int(r): j for j, r in enumerate(te)}
    with torch.no_grad():
        for ii, h, d, s, lf, y in batches(te, False):
            p = torch.sigmoid(net(h, d, s, lf)).numpy()
            out[[pos[int(r)] for r in ii]] = np.minimum.accumulate(p, axis=1)
    import hashlib
    wh = hashlib.sha256()
    for k_ in sorted(best_state):
        wh.update(best_state[k_].numpy().tobytes())
    info = {"tag": tag, "model": m, "train": int(len(tr)), "val": int(len(va)), "test": int(len(te)),
            "epochs": ep_done, "val_bce": vls, "best": best, "weights_sha256": wh.hexdigest(),
            "sec": round(time.time() - t0, 1)}
    if keep_state is not None:
        keep_state.update(best_state)
    log(f"  {tag} {m}: train {len(tr)} val {len(va)} test {len(te)} epochs {ep_done} "
        f"val {['%.5f' % v for v in vls]} ({time.time() - t0:.0f}s)")
    return out, info


def cmd_fit(a):
    import torch
    torch.set_num_threads(a.threads)
    os.makedirs(a.out, exist_ok=True)
    logf = open(os.path.join(a.out, "strict-log.txt"), "a")

    def log(s):
        line = f"{now()} {s}"
        print(line, flush=True)
        logf.write(line + "\n")
        logf.flush()
    log(f"START r16 nn strict; code {D.git_sha()}")
    keys = json.load(open(os.path.join(a.rows, "rows-meta.json")))["series"]
    import r12_tail as R12
    specs = {s["key"]: s for s in R12.dev_specs(a.datasets)}
    SA = {j: NN.series_arrays(specs[k]) for j, k in enumerate(keys)}
    log(f"  series arrays built ({len(SA)})")
    flags = exclusions(keys, SA)
    log(f"  exclusions: {flags}")
    drop = np.array([k in flags for k in keys])
    R = NN.tier_rows(a.rows, TIER)
    keep = ~drop[R["sid"]]
    R = {k: v[keep] for k, v in R.items()}
    n = len(R["ts"])
    L = len(NN.TIER_LV[TIER])
    nT = len(D.TIERS[TIER])
    Tmax = max(D.TIERS[TIER])
    pred = np.full((n, L), np.nan, np.float32)
    F = folds(int(R["ts"].max()))
    meta = {"code": D.git_sha(), "tier": TIER, "model": MODEL, "rows": int(n), "excluded": flags,
            "folds": [], "started_utc": now()}
    for fi, (fa, fb) in enumerate(F):
        te = np.where((R["ts"] >= fa) & (R["ts"] < fb) & (R["ts"] % DAY == 0))[0]
        # amended 2026-10-23 before any strict score was computed: the validation window ends at the last available
        # row before the fold (2026Q2 is dropped from the rows, so the 2026-07 fold had no validation rows)
        prior = R["ts"][R["ts"] + Tmax * STEP <= fa]
        vend = int(prior.max()) + Tmax * STEP if len(prior) else fa
        vstart = vend - VAL_DAYS * DAY
        trm = R["ts"] + Tmax * STEP <= vstart
        vam = (R["ts"] >= vstart) & (R["ts"] + Tmax * STEP <= vend)
        tr_all, va = np.where(trm)[0], np.where(vam)[0]
        if len(te) == 0 or len(tr_all) < 5000 or len(va) < 1000:
            log(f"  fold {fi} skipped: test {len(te)} train {len(tr_all)} val {len(va)}")
            continue
        rng = np.random.default_rng(SEED + fi)
        tr = rng.choice(tr_all, NN.MAX_TRAIN, replace=False) if len(tr_all) > NN.MAX_TRAIN else rng.permutation(tr_all)
        if len(va) > 60000:
            va = np.sort(rng.choice(va, 60000, replace=False))
        assert R["ts"][tr].max() + Tmax * STEP <= vstart and R["ts"][va].max() + Tmax * STEP <= vend <= fa
        assert R["ts"][te].min() >= fa
        p, info = train_predict(MODEL, R, SA, tr, va, te, L, nT, SEED + fi, log,
                                f"fold {fi} {dt.datetime.utcfromtimestamp(fa):%Y-%m}")
        pred[te] = p
        info.update({"fold": fi, "a": fa, "b": fb, "train_series": int(len(np.unique(R["sid"][tr[:NN.CAP[MODEL]]]))),
                     "test_series": int(len(np.unique(R["sid"][te]))), "train_ts_max": int(R["ts"][tr].max()),
                     "val_ts_max": int(R["ts"][va].max())})
        meta["folds"].append(info)
        json.dump(meta, open(os.path.join(a.out, "strict-meta.json"), "w"), indent=1, default=float)
    for jT, T in enumerate(D.TIERS[TIER]):
        mk = R["T"] == T
        cols = [NN.TIER_LV[TIER].index(k) for k in D.LV[T]]
        np.savez_compressed(os.path.join(a.out, f"rows-strict-T{T}.npz"), sid=R["sid"][mk], ts=R["ts"][mk],
                            ngru=pred[mk][:, cols])
    meta["finished_utc"] = now()
    json.dump(meta, open(os.path.join(a.out, "strict-meta.json"), "w"), indent=1, default=float)
    log("END strict")


def cmd_freeze(a):
    """the frozen blind model: one GRU by the strict rule on ALL development rows (validation = the last 90 days of
    rows, training rows end >= Tmax before it). Writes frozen-r162e-gru.pt (state dict) and frozen-r162e.json
    (code sha, input sha256, constants, seed, weights sha256, UTC time)."""
    import hashlib
    import torch
    torch.set_num_threads(a.threads)
    os.makedirs(a.out, exist_ok=True)
    keys = json.load(open(os.path.join(a.rows, "rows-meta.json")))["series"]
    import r12_tail as R12
    specs = {s_["key"]: s_ for s_ in R12.dev_specs(a.datasets)}
    SA = {j: NN.series_arrays(specs[k]) for j, k in enumerate(keys)}
    flags = exclusions(keys, SA)
    drop = np.array([k in flags for k in keys])
    R = NN.tier_rows(a.rows, TIER)
    keep = ~drop[R["sid"]]
    R = {k: v[keep] for k, v in R.items()}
    L, nT, Tmax = len(NN.TIER_LV[TIER]), len(D.TIERS[TIER]), max(D.TIERS[TIER])
    if a.as_fold is None:
        vend = int(R["ts"].max()) + Tmax * STEP
        vstart = vend - VAL_DAYS * DAY
        tr_all = np.where(R["ts"] + Tmax * STEP <= vstart)[0]
        va = np.where(R["ts"] >= vstart)[0]
        seed = SEED + 1000
    else:   # reproduce one walk-forward fold model exactly (same rule and seed as cmd_fit)
        fa, _ = folds(int(R["ts"].max()))[a.as_fold]
        prior = R["ts"][R["ts"] + Tmax * STEP <= fa]
        vend = int(prior.max()) + Tmax * STEP
        vstart = vend - VAL_DAYS * DAY
        tr_all = np.where(R["ts"] + Tmax * STEP <= vstart)[0]
        va = np.where((R["ts"] >= vstart) & (R["ts"] + Tmax * STEP <= vend))[0]
        seed = SEED + a.as_fold
    rng = np.random.default_rng(seed)
    tr = rng.choice(tr_all, NN.MAX_TRAIN, replace=False) if len(tr_all) > NN.MAX_TRAIN else rng.permutation(tr_all)
    if len(va) > 60000:
        va = np.sort(rng.choice(va, 60000, replace=False))
    st = {}
    _, info = train_predict(MODEL, R, SA, tr, va, np.array([], np.int64), L, nT, seed, print, "freeze", keep_state=st)
    tag = "" if a.as_fold is None else f"-fold{a.as_fold}"
    pt = os.path.join(a.out, f"frozen-r162e-gru{tag}.pt")
    torch.save(st, pt)

    def sha(p_):
        h = hashlib.sha256()
        with open(p_, "rb") as f:
            for b in iter(lambda: f.read(1 << 20), b""):
                h.update(b)
        return h.hexdigest()
    cfg = {"schema": "q26-r162e-frozen-v1", "label": "frozen before any blind byte", "code": D.git_sha(),
           "model": MODEL, "tier": TIER, "primary": {"T": 3, "level": -0.02, "comparator": "fH", "holm": 1},
           "constants": {"HW": NN.HW, "DW": NN.DW, "STATIC": NN.STATIC, "CAP": NN.CAP[MODEL], "MAX_TRAIN": NN.MAX_TRAIN,
                         "VAL_DAYS": VAL_DAYS, "seed": seed, "levels": NN.TIER_LV[TIER], "Ts": D.TIERS[TIER]},
           "train_rows": int(len(tr[:NN.CAP[MODEL]])), "train_ts_max": int(R["ts"][tr].max()),
           "val_rows": int(len(va)), "val_ts_range": [int(R["ts"][va].min()), int(R["ts"][va].max())],
           "excluded": flags, "fit": info, "weights_file_sha256": sha(pt),
           "inputs_sha256": {f"rows-T{T}.npz": sha(os.path.join(a.rows, f"rows-T{T}.npz")) for T in D.TIERS[TIER]},
           "rows_meta_sha256": sha(os.path.join(a.rows, "rows-meta.json")), "created_utc": now()}
    cfg["as_fold"] = a.as_fold
    json.dump(cfg, open(os.path.join(a.out, f"frozen-r162e{tag}.json"), "w"), indent=1, default=float)
    print("frozen", cfg["weights_file_sha256"], cfg["created_utc"], flush=True)


# ---------------------------------------------------------------------------------------------------- scoring
def cgm_z(d, sid, blk):
    """Cameron-Gelbach-Miller two-way cluster-robust z of the mean of d: V = V_s + V_b - V_sb."""
    n = len(d)
    e = d - d.mean()

    def v(g):
        _, inv = np.unique(g, return_inverse=True)
        s = np.bincount(inv, weights=e)
        return float((s ** 2).sum()) / n ** 2
    sb = sid.astype(np.int64) * 100000 + blk.astype(np.int64)
    V = v(sid) + v(blk) - v(sb)
    if V <= 0:
        V = max(v(sid), v(blk))
    return float(d.mean() / math.sqrt(V))


def tier_stats(dct, label, B):
    sid = np.concatenate([x["sid"] for x in dct])
    ts = np.concatenate([x["ts"] for x in dct])
    d = np.concatenate([x["d"] for x in dct])
    blk = (ts // (28 * DAY)).astype(np.int64)
    tw = D.TwoWay(sid, blk, B=B).z(d)
    lk = D.leave_top_k(sid, d)
    return {"label": label, "rows": int(len(d)), "mean_d": float(d.mean()), "two_way": tw, "cgm_z": cgm_z(d, sid, blk),
            "leave_top_k": lk}


def cmd_score(a):
    keys = json.load(open(os.path.join(a.rows, "rows-meta.json")))["series"]
    res = {"schema": "q26-r16.2e-strict-audit/1", "label": "DEVELOPMENT ONLY (seen data)", "code": D.git_sha(),
           "cells": {}, "tier": {}, "halves": {}, "years": {}}
    strict_meta = json.load(open(os.path.join(a.out, "strict-meta.json")))
    res["excluded"] = strict_meta["excluded"]
    per_T = {}
    for T in D.TIERS[TIER]:
        Z = np.load(os.path.join(a.rows, f"rows-T{T}.npz"))
        R = {k: Z[k] for k in ("sid", "ts", "y", "fH")}
        S = np.load(os.path.join(a.out, f"rows-strict-T{T}.npz"))
        O = np.load(os.path.join(a.orig, f"rows-nn-T{T}.npz"))
        kr = (R["sid"].astype(np.int64) << 32) | R["ts"].astype(np.int64)

        def align(Zx, name):
            kc = (Zx["sid"].astype(np.int64) << 32) | Zx["ts"].astype(np.int64)
            o = np.argsort(kc)
            pos = np.clip(np.searchsorted(kc[o], kr), 0, len(kc) - 1)
            hit = kc[o][pos] == kr
            v = np.full(R["fH"].shape, np.nan, np.float32)
            v[hit] = Zx[name][o][pos[hit]]
            return v
        ps, po = align(S, "ngru"), align(O, "ngru")
        mk = np.isfinite(ps).all(1) & np.isfinite(po).all(1)
        per_T[T] = {"sid": R["sid"][mk], "ts": R["ts"][mk], "y": R["y"][mk].astype(float),
                    "fH": R["fH"][mk].astype(float), "strict": ps[mk].astype(float), "orig": po[mk].astype(float)}
        print(now(), f"T{T}: rows {mk.sum()} (strict finite {np.isfinite(ps).all(1).sum()}, orig {np.isfinite(po).all(1).sum()})",
              flush=True)
    # the largest market-wide day: most positive labels over all series and shallow cells (model-independent)
    allday = np.concatenate([x["ts"] // DAY for x in per_T.values()])
    allpos = np.concatenate([x["y"].sum(1) for x in per_T.values()])
    ud, inv = np.unique(allday, return_inverse=True)
    top_day = int(ud[np.argmax(np.bincount(inv, weights=allpos))])
    res["top_event_day"] = dt.datetime.utcfromtimestamp(top_day * DAY).strftime("%Y-%m-%d")
    t_med = float(np.median(np.concatenate([x["ts"] for x in per_T.values()])))
    res["split_strict_median"] = int(t_med)
    res["split_original"] = 1719122400
    for arm in ("strict", "orig"):
        dct, dct_noev = [], []
        for T, x in per_T.items():
            L = x["y"].shape[1]
            for j, k in enumerate(D.LV[T]):
                c = f"{D.TL[T]} {k}"
                y, pH, pm = x["y"][:, j], np.clip(x["fH"][:, j], 0, 1), np.clip(x[arm][:, j], 0, 1)
                bH, bm = (pH - y) ** 2, (pm - y) ** 2
                cell = res["cells"].setdefault(c, {"rows": int(len(y)), "pos": int(y.sum()),
                                                   "R_fH": float(pH.sum() / max(y.sum(), 1))})
                cell[arm] = {"bss": float(1 - bm.mean() / bH.mean()), "R": float(pm.sum() / max(y.sum(), 1))}
                for hn, split in (("strict_median", t_med), ("original_split", 1719122400)):
                    for hv, hm in (("early", x["ts"] < split), ("late", x["ts"] >= split)):
                        if hm.sum() == 0:
                            continue
                        h = res["halves"].setdefault(f"{hn}:{hv}", {}).setdefault(c, {
                            "rows": int(hm.sum()), "pos": int(y[hm].sum()),
                            "R_fH": float(pH[hm].sum() / max(y[hm].sum(), 1))})
                        h[arm] = {"bss": float(1 - bm[hm].mean() / bH[hm].mean()),
                                  "R": float(pm[hm].sum() / max(y[hm].sum(), 1))}
            d = (((x[arm] - x["y"]) ** 2) - ((x["fH"] - x["y"]) ** 2)).sum(1) / L
            dct.append({"sid": x["sid"], "ts": x["ts"], "d": d})
            ev = (x["ts"] // DAY) != top_day
            dct_noev.append({"sid": x["sid"][ev], "ts": x["ts"][ev], "d": d[ev]})
            yr = (x["ts"] // (365.2425 * DAY) + 1970).astype(int)
            for yy in np.unique(yr):
                s = res["years"].setdefault(str(yy), {}).setdefault(arm, {"sumd": 0.0, "n": 0, "sumbH": 0.0})
                s["sumd"] += float(d[yr == yy].sum())
                s["n"] += int((yr == yy).sum())
                s["sumbH"] += float((((x["fH"] - x["y"]) ** 2).sum(1) / L)[yr == yy].sum())
        st = tier_stats(dct, arm, B=1000)
        st10 = D.TwoWay(np.concatenate([q["sid"] for q in dct]),
                        (np.concatenate([q["ts"] for q in dct]) // (28 * DAY)).astype(np.int64), B=10000,
                        seed=SEED).z(np.concatenate([q["d"] for q in dct]))
        st["two_way_B10000"] = st10
        st["leave_top_event_day"] = tier_stats(dct_noev, arm + " without top day", B=1000)
        cells = [c for c in res["cells"]]
        bss = [res["cells"][c][arm]["bss"] for c in cells]
        lr = [abs(math.log(res["cells"][c][arm]["R"])) for c in cells]
        lrC = [abs(math.log(res["cells"][c]["R_fH"])) for c in cells]
        st["bss_cells"] = dict(zip(cells, bss))
        st["bss_mean"] = float(np.mean(bss))
        st["bss_min"] = float(np.min(bss))
        st["median_abs_lnR"] = float(np.median(lr))
        st["median_abs_lnR_fH"] = float(np.median(lrC))
        e = (st["two_way"]["z"] is not None and st["two_way"]["z"] <= -2.0, min(bss) >= -0.002,
             st["leave_top_k"]["mean_after"] is not None and st["leave_top_k"]["mean_after"] < 0,
             np.median(lr) <= np.median(lrC) + 0.02)
        st["E"] = [bool(v) for v in e]
        st["eligible"] = bool(all(e))
        res["tier"][arm] = st
        print(f"{arm}: bss mean {st['bss_mean']:+.4f} min {st['bss_min']:+.4f} z {st['two_way']['z']:.2f} "
              f"(B10k {st10['z']:.2f}, pct p {st10['pct_p']:.4f}) CGM {st['cgm_z']:.2f} E {st['E']} "
              f"top-k share {st['leave_top_k']['topk_share_of_gain']} z w/o top day "
              f"{st['leave_top_event_day']['two_way']['z']:.2f}", flush=True)
    for yy, v in res["years"].items():
        for arm in ("strict", "orig"):
            if arm in v:
                v[arm]["bss_pooled"] = -v[arm]["sumd"] / v[arm]["sumbH"] if v[arm]["sumbH"] > 0 else None
    # paired strict - orig difference on identical rows
    dd = []
    for T, x in per_T.items():
        L = x["y"].shape[1]
        dd.append({"sid": x["sid"], "ts": x["ts"],
                   "d": (((x["strict"] - x["y"]) ** 2) - ((x["orig"] - x["y"]) ** 2)).sum(1) / L})
    res["tier"]["strict_minus_orig"] = tier_stats(dd, "strict - orig", B=1000)
    json.dump(res, open(os.path.join(a.out, "audit-r162e-strict.json"), "w"), indent=1, default=float)
    print("written", flush=True)


# ---------------------------------------------------------------------------------------------------- synthetic
def cmd_synth(a):
    """Known-answer check. A synthetic panel with a KNOWN touch probability, run through the same GRU training loop,
    the same strict fold rule and the same scorer (TwoWay, leave_top_k, BSS).

    World: S series of hourly bars. Log-vol h_t follows a daily AR(1) (phi 0.97, daily step, piecewise constant
    within a UTC day), shared market factor weight 0.5 plus an idiosyncratic part. Hourly return r ~ N(0, sigma_t^2),
    sigma_t = exp(h_t) / sqrt(8760); high/low wick |N(0, 0.3 sigma)| beyond the bar's open/close range.
    Touch label y(T, k) = 1 if min low over the next T bars <= close * (1+k) (the real path, as the real rows).
    p_true(T, k | h_t): the touch probability given today's h_t and the known law, by Monte Carlo on a grid of h
    (40,000 paths per grid point, interpolated), the known answer.
    Arms (each vs its own baseline as 'fH' in the residual): NULL baseline = p_true (a GRU gain here is a false
    positive: leakage or scorer fault); POSITIVE baseline = p from a stale 30-day realized sigma (the GRU should gain,
    true gain = Brier(stale) - Brier(p_true) is known).
    """
    import torch
    torch.set_num_threads(a.threads)
    os.makedirs(a.out, exist_ok=True)
    rng = np.random.default_rng(SEED)
    S, days = 40, 4 * 365
    N = days * 24
    base_ts = ts_of(2020, 1)
    lv = NN.TIER_LV[TIER]
    Ts = D.TIERS[TIER]
    phi, mu, sd_m, sd_i = 0.97, math.log(0.8), 0.06, 0.06
    mk_ = np.zeros(days)
    for t in range(1, days):
        mk_[t] = phi * mk_[t - 1] + sd_m * rng.standard_normal()
    # p_true grid by Monte Carlo of the known law (next days' h evolve by the AR(1); market and idio shocks together)
    hg = np.linspace(math.log(0.15), math.log(5.0), 41)
    mc = np.zeros((len(hg), 24, len(Ts), len(lv)))       # by grid h, hour-of-day of the origin, T, level
    npath = 40000
    sd_tot = math.sqrt(sd_m ** 2 + sd_i ** 2)
    for gi, h0 in enumerate(hg):
        for hod in (0, 6, 12, 18):
            Hmax = max(Ts)
            hh = np.full(npath, h0)
            lmin = np.zeros(npath)
            c = np.zeros(npath)
            res_ = {}
            for step in range(Hmax):
                if (hod + step) % 24 == 0 and step > 0:
                    hh = mu + phi * (hh - mu) + sd_tot * rng.standard_normal(npath)
                s = np.exp(hh) / math.sqrt(8760)
                r = s * rng.standard_normal(npath)
                lo = np.minimum(c, c + r) - np.abs(0.3 * s * rng.standard_normal(npath))
                c = c + r
                lmin = np.minimum(lmin, lo)
                if step + 1 in Ts:
                    res_[step + 1] = lmin.copy()
            for jT, T in enumerate(Ts):
                for jl, k in enumerate(lv):
                    mc[gi, hod, jT, jl] = np.mean(res_[T] <= math.log1p(k))
    from scipy.stats import norm
    SA, rows = {}, []
    for s in range(S):
        hi_ = np.zeros(days)
        x = 0.0
        for t in range(days):
            x = phi * x + sd_i * rng.standard_normal()
            hi_[t] = mu + mk_[t] + x
        hh = np.repeat(hi_, 24)
        sig = np.exp(hh) / math.sqrt(8760)
        r = sig * rng.standard_normal(N)
        lc = np.concatenate([[0.0], np.cumsum(r)])
        lo = np.minimum(lc[:-1], lc[1:]) - np.abs(0.3 * sig * rng.standard_normal(N))
        hi = np.maximum(lc[:-1], lc[1:]) + np.abs(0.3 * sig * rng.standard_normal(N))
        N1 = N + 1
        rr = np.zeros(N1, np.float32)
        rr[1:] = r
        rg = np.zeros(N1, np.float32)
        rg[1:] = hi - lo
        R24 = np.zeros(N1, np.float32)
        R24[24:] = lc[24:] - lc[:-24]
        from numpy.lib.stride_tricks import sliding_window_view as swv
        RG24 = np.zeros(N1, np.float32)
        RG24[24:] = swv(hi, 24).max(1) - swv(lo, 24).min(1)
        r2 = np.concatenate([[np.nan], r ** 2])
        lrv22 = np.full(N1, np.nan, np.float32)
        lrv22[22:] = 0.5 * np.log(8760 * swv(r2[1:], 22).mean(1))
        rv720 = np.full(N1, np.nan)
        rv720[720:] = np.sqrt(8760 * swv(r ** 2, 720).mean(1))
        SA[s] = {"r": rr, "rg": rg, "lv": np.zeros(N1, np.float32), "R24": R24, "RG24": RG24,
                 "V24": np.zeros(N1, np.float32), "lrv22": lrv22, "lpm": np.log(np.where(np.isfinite(rv720), rv720, 0.8)).astype(np.float32),
                 "base_ts": base_ts}
        # origins every 6 h after 31 days, leaving Tmax bars at the end
        ii = np.arange(31 * 24, N - max(Ts), 6)
        lmin_fut = {}
        for T in Ts:
            w = swv(lo, T)                                   # w[i] = lo[i..i+T-1] = bars i..i+T-1 (after origin i)
            lmin_fut[T] = w[ii].min(1) - lc[ii]
        hod = (ii % 24)
        h_now = hh[ii]                                       # today's h (known at the origin: the regime of the day)
        gpos = np.clip(np.interp(h_now, hg, np.arange(len(hg))), 0, len(hg) - 1.000001)
        g0 = gpos.astype(int)
        wgt = gpos - g0
        for jT, T in enumerate(Ts):
            Y = np.full((len(ii), len(lv)), -1, np.int8)
            PT = np.zeros((len(ii), len(lv)))
            PS = np.zeros((len(ii), len(lv)))
            for jl, k in enumerate(lv):
                if k not in D.LV[T]:
                    continue
                Y[:, jl] = (lmin_fut[T] <= math.log1p(k)).astype(np.int8)
                PT[:, jl] = (1 - wgt) * mc[g0, hod, jT, jl] + wgt * mc[g0 + 1, hod, jT, jl]
                sst = rv720[ii] * math.sqrt(T / 8760)          # stale 30-day realized sigma, reflection formula
                PS[:, jl] = np.clip(2 * norm.cdf(math.log1p(k) / sst), 1e-4, 1 - 1e-4)
            rows.append({"sid": np.full(len(ii), s, np.int32), "ts": (base_ts + ii * STEP).astype(np.int64),
                         "Y": Y, "PT": np.clip(PT, 1e-4, 1 - 1e-4).astype(np.float32), "PS": PS.astype(np.float32),
                         "T": np.full(len(ii), T, np.int32), "Tidx": np.full(len(ii), jT, np.int32),
                         "lsH": np.log(rv720[ii]).astype(np.float32)})
    R0 = {k: np.concatenate([r_[k] for r_ in rows]) for k in rows[0]}
    for k in NN.STATIC:
        if k not in R0:
            R0[k] = np.zeros(len(R0["ts"]), np.float32)
    out = {"world": {"S": S, "days": days, "phi": phi, "mu": mu, "sd_m": sd_m, "sd_i": sd_i, "npath": npath},
           "arms": {}, "code": D.git_sha()}
    L, nT, Tmax = len(lv), len(Ts), max(Ts)
    print(now(), "synthetic panel built", len(R0["ts"]), flush=True)
    # scorer known-answer: p_true vs stale baseline on all rows, before any learning
    for arm, base in (("NULL", "PT"), ("POSITIVE", "PS")):
        R = dict(R0)
        R["LF"] = np.where(R0["Y"] >= 0, D.lg(R0[base]), 0).astype(np.float32)
        pred = np.full((len(R["ts"]), L), np.nan, np.float32)
        F = [f for f in folds(int(R["ts"].max())) if f[0] >= ts_of(2022, 1)]
        for fi, (fa, fb) in enumerate(F):
            te = np.where((R["ts"] >= fa) & (R["ts"] < fb) & (R["ts"] % DAY == 0))[0]
            vstart = fa - VAL_DAYS * DAY
            tr_all = np.where(R["ts"] + Tmax * STEP <= vstart)[0]
            va = np.where((R["ts"] >= vstart) & (R["ts"] + Tmax * STEP <= fa))[0]
            rg_ = np.random.default_rng(SEED + fi)
            tr = rg_.choice(tr_all, NN.MAX_TRAIN, replace=False) if len(tr_all) > NN.MAX_TRAIN else rg_.permutation(tr_all)
            if len(va) > 60000:
                va = np.sort(rg_.choice(va, 60000, replace=False))
            p, _ = train_predict(MODEL, R, SA, tr, va, te, L, nT, SEED + fi, lambda s_: print(now(), arm, s_, flush=True),
                                 f"{arm} fold {fi}")
            pred[te] = p
        mk = np.isfinite(pred).all(1)
        Y = R0["Y"][mk].astype(float)
        msk = Y >= 0
        Yc = np.where(msk, Y, 0)

        def brier(P):
            return (((P - Yc) ** 2) * msk).sum(1) / msk.sum(1)
        bT, bB, bG = brier(R0["PT"][mk]), brier(R0[base][mk]), brier(pred[mk])
        sid, ts = R0["sid"][mk], R0["ts"][mk]
        blk = (ts // (28 * DAY)).astype(np.int64)
        res = {"rows": int(mk.sum()),
               "brier_true": float(bT.mean()), "brier_base": float(bB.mean()), "brier_gru": float(bG.mean()),
               "bss_gru_vs_base": float(1 - bG.mean() / bB.mean()), "bss_true_vs_base": float(1 - bT.mean() / bB.mean()),
               "share_of_known_gap_recovered": float((bB.mean() - bG.mean()) / (bB.mean() - bT.mean()))
               if bB.mean() > bT.mean() else None,
               "tw_gru_vs_base": D.TwoWay(sid, blk, B=1000).z(bG - bB),
               "tw_true_vs_base": D.TwoWay(sid, blk, B=1000).z(bT - bB) if base != "PT" else None,
               "R_true": float((R0["PT"][mk] * msk).sum() / max((Yc * msk).sum(), 1)),
               "R_base": float((R0[base][mk] * msk).sum() / max((Yc * msk).sum(), 1)),
               "R_gru": float((pred[mk] * msk).sum() / max((Yc * msk).sum(), 1))}
        out["arms"][arm] = res
        print(now(), arm, json.dumps({k: v for k, v in res.items() if not k.startswith("tw")}),
              "z gru", res["tw_gru_vs_base"]["z"], flush=True)
        json.dump(out, open(os.path.join(a.out, "synth-r162e.json"), "w"), indent=1, default=float)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("fit")
    s.add_argument("--datasets", required=True)
    s.add_argument("--rows", required=True)
    s.add_argument("--out", required=True)
    s.add_argument("--threads", type=int, default=3)
    s = sub.add_parser("score")
    s.add_argument("--rows", required=True)
    s.add_argument("--orig", required=True)
    s.add_argument("--out", required=True)
    s = sub.add_parser("freeze")
    s.add_argument("--datasets", required=True)
    s.add_argument("--rows", required=True)
    s.add_argument("--out", required=True)
    s.add_argument("--threads", type=int, default=3)
    s.add_argument("--as-fold", type=int, default=None)
    s = sub.add_parser("synth")
    s.add_argument("--out", required=True)
    s.add_argument("--threads", type=int, default=1)
    a = ap.parse_args()
    {"fit": cmd_fit, "score": cmd_score, "synth": cmd_synth, "freeze": cmd_freeze}[a.cmd](a)


if __name__ == "__main__":
    main()
