"""Q26 R16.2e freeze rules C and D (Claude, O184 lane, 2026-10-23). DEVELOPMENT ONLY (seen data).

membrane-board design/Q26_ROUND16_PREREG.md D-R16.2e-e (rule and criterion committed before any score of this script).
Candidates (everything not named here is as r162e_ens.py / r16_nn_strict.py: rows, features, exclusions, fold rule,
90-day validation window, model, optimizer, batch, residual on logit fH, running minimum over levels):
  C  ENS5-BEST8       mean logit of 5 GRUs. Each GRU trains a fixed 8 epochs (no early break). It keeps the state
                      after epoch e* = argmin over e in 1..8 of validation BCE (strict <; the initial state, e = 0, is
                      NOT eligible). Training rows: the strict 60,000-row seeded draw, first 20,000 used (as before).
  D  ENS5-BEST8-100K  as C, but the training-row cap is 100,000: a seeded draw of min(100,000, available) rows, all used.
Ensemble forecast: p = running minimum over levels of sigmoid(logit(fH) + mean_k residual_k).
Seeds s(k, f) = SEED + 9000 k + f. k in KS = (1,2,3,4,6,7,8,9,11,12); E1 = (1,2,3,4,6), E2 = (7,8,9,11,12).
k = 5 and k = 10 are skipped: SEED + 9000 k + f equals a D-R16.2e-c seed SEED + 5000 j + f exactly when 9k = 5j.
Freeze seeds s(k, 100), k in E1.

  python3 r162e_cd.py wf      --datasets DS --rows ROWS --out OUT --rule C|D --ks 1,2 [--threads 1]
  python3 r162e_cd.py score   --rows ROWS --out OUT
  python3 r162e_cd.py freeze  --datasets DS --rows ROWS --out OUT --rule C|D [--threads 3] [--tag replay]
  python3 r162e_cd.py synth   --out OUT --rule C|D [--threads 1]
  python3 r162e_cd.py power-live --rows ROWS --out OUT --rule C|D
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
import sys  # noqa: E402
import time  # noqa: E402

import numpy as np  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import r16_dev as D  # noqa: E402
import r16_nn as NN  # noqa: E402
import r16_nn_strict as S  # noqa: E402
import r162e_ens as E  # noqa: E402

SEED, STEP, DAY, TIER, MODEL, VAL_DAYS = S.SEED, S.STEP, S.DAY, S.TIER, S.MODEL, S.VAL_DAYS
E1, E2 = (1, 2, 3, 4, 6), (7, 8, 9, 11, 12)
KS = E1 + E2
FREEZE_F = 100
EPOCHS = 8
CAP = {"C": 20000, "D": 100000}
DRAW = {"C": NN.MAX_TRAIN, "D": 100000}       # seeded draw size; the first CAP rows of the draw are used
GUARD = -0.002
GUARD_MIN_TRAIN = 20000                       # a fold counts for the guard only if >= 20,000 training rows exist
TIE = 0.001                                   # prefer C if |score C - score D| < 0.001
NONDEG_MIN = 0.01                             # mean |residual logit| on the freeze check rows must exceed this
SPLIT = 1719122400                            # 2024-06-23, the registered early/late split (D-R16.2e-a)
PRIMARY = (3, -0.02)
LAST = ("head.net.3.weight", "head.net.3.bias")


def seed_of(k, f):
    return SEED + 9000 * k + f


def draw_train(tr_all, rule, rng):
    n = DRAW[rule]
    tr = rng.choice(tr_all, n, replace=False) if len(tr_all) > n else rng.permutation(tr_all)
    return tr[:CAP[rule]]


def fit_best(R, SA, tr, va, L, nT, seed):
    """fixed EPOCHS epochs, no break; keeps the state after the epoch with the lowest validation BCE among epochs 1..8
    (strictly lower wins; the initial state is evaluated and logged but is not eligible)."""
    import torch
    torch.manual_seed(seed)
    rng = np.random.default_rng(seed)
    t0 = time.time()
    net = NN.make_model(MODEL, len(NN.STATIC) + 2 + nT, L)
    opt = torch.optim.Adam(net.parameters(), lr=1e-3, weight_decay=1e-4)
    best, best_state, b_ep, vls = np.inf, None, None, []
    for ep in range(0, EPOCHS + 1):
        net.train()
        for _, h, d, s, lf, y in (E.batches(R, SA, tr, nT, rng) if ep >= 1 else ()):
            opt.zero_grad()
            loss = E.loss_of(net(h, d, s, lf), y)
            loss.backward()
            opt.step()
        net.eval()
        tot, cnt = 0.0, 0.0
        with torch.no_grad():
            for _, h, d, s, lf, y in E.batches(R, SA, va, nT):
                mk = (y >= 0).float().sum().item()
                tot += E.loss_of(net(h, d, s, lf), y).item() * mk
                cnt += mk
        vl = tot / max(cnt, 1)
        vls.append(vl)
        if ep >= 1 and vl < best:
            best, b_ep = vl, ep
            best_state = {k: v.clone() for k, v in net.state_dict().items()}
    info = {"seed": int(seed), "train": int(len(tr)), "val": int(len(va)), "val_bce_ep0_to_8": vls,
            "best_epoch": int(b_ep), "best_val": float(best), "val_gain_vs_initial": float(vls[0] - best),
            "state_sha256": E.sha_state(best_state),
            "last_layer_abs_sum": float(sum(best_state[n].abs().sum().item() for n in LAST)),
            "sec": round(time.time() - t0, 1)}
    return best_state, info


def fold_sets(R, fa, fb, seed, Tmax, rule):
    """r162e_ens.fold_sets with the rule's draw. Returns (tr, va, te, n_train_available) or None."""
    te = np.where((R["ts"] >= fa) & (R["ts"] < fb) & (R["ts"] % DAY == 0))[0]
    prior = R["ts"][R["ts"] + Tmax * STEP <= fa]
    vend = int(prior.max()) + Tmax * STEP if len(prior) else fa
    vstart = vend - VAL_DAYS * DAY
    tr_all = np.where(R["ts"] + Tmax * STEP <= vstart)[0]
    va = np.where((R["ts"] >= vstart) & (R["ts"] + Tmax * STEP <= vend))[0]
    if len(te) == 0 or len(tr_all) < 5000 or len(va) < 1000:
        return None
    rng = np.random.default_rng(seed)
    tr = draw_train(tr_all, rule, rng)
    if len(va) > 60000:
        va = np.sort(rng.choice(va, 60000, replace=False))
    assert R["ts"][tr].max() + Tmax * STEP <= vstart and R["ts"][va].max() + Tmax * STEP <= vend <= fa
    assert R["ts"][te].min() >= fa
    return tr, va, te, int(len(tr_all))


def cmd_wf(a):
    import torch
    torch.set_num_threads(a.threads)
    os.makedirs(a.out, exist_ok=True)
    logf = open(os.path.join(a.out, f"wf-log-{a.rule}-{a.ks.replace(',', '_')}.txt"), "a")

    def log(s_):
        line = f"{S.now()} {s_}"
        print(line, flush=True)
        logf.write(line + "\n")
        logf.flush()
    log(f"START r162e_cd wf rule {a.rule} ks {a.ks} threads {a.threads}; code {D.git_sha()}")
    _, SA, flags, R = E.load_dev(a)
    log(f"  series arrays built ({len(SA)}); excluded {flags}")
    json.dump(flags, open(os.path.join(a.out, "excluded.json"), "w"))
    L, nT, Tmax = len(NN.TIER_LV[TIER]), len(D.TIERS[TIER]), max(D.TIERS[TIER])
    F = S.folds(int(R["ts"].max()))
    for k in [int(x) for x in a.ks.split(",")]:
        assert k in KS, k
        fn = os.path.join(a.out, f"res-{a.rule}-k{k}.npz")
        if os.path.exists(fn):
            log(f"  {a.rule} k {k} exists, skipped")
            continue
        idx, rr, meta = [], [], []
        for fi, (fa, fb) in enumerate(F):
            sets = fold_sets(R, fa, fb, seed_of(k, fi), Tmax, a.rule)
            if sets is None:
                continue
            tr, va, te, n_av = sets
            st, info = fit_best(R, SA, tr, va, L, nT, seed_of(k, fi))
            (pr,) = E.predict_res(R, SA, te, [st], L, nT)
            idx.append(te)
            rr.append(pr)
            info.update({"rule": a.rule, "k": k, "fold": fi, "a": fa, "b": fb, "test": int(len(te)),
                         "train_available": n_av})
            meta.append(info)
            log(f"  {a.rule} k {k} fold {fi} {dt.datetime.utcfromtimestamp(fa):%Y-%m}: train {len(tr)} val "
                f"{['%.5f' % v for v in info['val_bce_ep0_to_8']]} best epoch {info['best_epoch']} ({info['sec']:.0f}s)")
        np.savez_compressed(fn, idx=np.concatenate(idx), r=np.concatenate(rr).astype(np.float16))
        json.dump(meta, open(os.path.join(a.out, f"meta-{a.rule}-k{k}.json"), "w"), indent=1, default=float)
        log(f"  {a.rule} k {k} written")
    log("END wf")


# ------------------------------------------------------------------------------------------------------------ score
def load_res(out, rule):
    res, meta, idx0, o = {}, {}, None, None
    for k in KS:
        Z = np.load(os.path.join(out, f"res-{rule}-k{k}.npz"))
        if idx0 is None:
            idx0 = Z["idx"]
            o = np.argsort(idx0)
        assert (Z["idx"] == idx0).all()
        res[k] = Z["r"][o].astype(np.float64)
        meta[k] = json.load(open(os.path.join(out, f"meta-{rule}-k{k}.json")))
    return idx0[o], res, meta


def build_scorer(rows, out, idx):
    keys = json.load(open(os.path.join(rows, "rows-meta.json")))["series"]
    excl = json.load(open(os.path.join(out, "excluded.json")))
    R = NN.tier_rows(rows, TIER)
    keep = ~np.array([k in excl for k in keys])[R["sid"]]
    R = {k: v[keep] for k, v in R.items()}
    sc = E.Scorer(rows, S.folds(int(R["ts"].max())))
    sc.setup(R, keep, idx)
    return sc, keys, excl


def calib(sc, p):
    """R = sum p / sum y per cell and per horizon (pooled over its shallow levels), early / late at SPLIT."""
    out = {}
    for hn, hm in (("early", sc.ts < SPLIT), ("late", sc.ts >= SPLIT), ("all", np.ones(len(sc.ts), bool))):
        h = {}
        for T in D.TIERS[TIER]:
            r = hm & (sc.T == T)
            sp = sy = sh = 0.0
            for k in D.LV[T]:
                c = sc.lv.index(k)
                y, pm, pH = sc.Yc[r, c], p[r, c], np.clip(sc.PH[r, c], 0, 1)
                h[f"{D.TL[T]} {k}"] = {"rows": int(r.sum()), "pos": int(y.sum()), "R": float(pm.sum() / max(y.sum(), 1)),
                                       "R_fH": float(pH.sum() / max(y.sum(), 1))}
                sp, sy, sh = sp + pm.sum(), sy + y.sum(), sh + pH.sum()
            h[f"{D.TL[T]} pooled"] = {"R": float(sp / max(sy, 1)), "R_fH": float(sh / max(sy, 1)), "pos": int(sy)}
        out[hn] = h
    return out


def guard_eval(m, counted):
    fb = {f: v for f, v in m["fold_bss"].items() if f in counted}
    return {"counted_folds": sorted(fb), "worst_counted": float(min(fb.values())),
            "n_counted_below_guard": int(sum(v < GUARD for v in fb.values())),
            "n_counted_below_zero": int(sum(v < 0 for v in fb.values()))}


def cmd_score(a):
    t0 = time.time()
    out = {"schema": "q26-r162e-cd/1", "label": "DEVELOPMENT ONLY (seen data)", "code": D.git_sha(),
           "rule_doc": "membrane-board design/Q26_ROUND16_PREREG.md D-R16.2e-e", "rules": {}}
    sc = None
    for rule in ("C", "D"):
        idx, res, meta = load_res(a.out, rule)
        if sc is None:
            sc, keys, excl = build_scorer(a.rows, a.out, idx)
            idx_ref = idx
            out.update({"rows": int(len(idx)), "excluded": excl})
            print(S.now(), f"rows {len(idx)} excluded {excl}", flush=True)
        assert (idx == idx_ref).all()
        fits = [m for k in KS for m in meta[k]]
        av = {}
        for m in fits:
            av.setdefault(dt.datetime.utcfromtimestamp(m["a"]).strftime("%Y-%m"), set()).add(m["train_available"])
        assert all(len(v) == 1 for v in av.values())
        counted = {f for f, v in av.items() if min(v) >= GUARD_MIN_TRAIN}
        rr = {"single": {}, "ens": {}, "loso": {}, "train_available": {f: min(v) for f, v in av.items()},
              "guard_counted_folds": sorted(counted)}
        for k in KS:
            m = sc.metrics(sc.prob(res[k]))
            g = guard_eval(m, counted)
            rr["single"][str(k)] = {"M": m["M"], "z": m["z"], "worst_counted": g["worst_counted"],
                                    "n_counted_below_guard": g["n_counted_below_guard"],
                                    "primary_bss": m["cells"]["3h -0.02"]["bss"]}
        for en, ks_ in (("E1", E1), ("E2", E2)):
            mean = np.mean([res[k] for k in ks_], axis=0)
            p = sc.prob(mean)
            m = sc.metrics(p, full=True)
            m["guard"] = guard_eval(m, counted)
            sub = np.isin(sc.fold_of, [i for i, f in enumerate(sc.folds)
                                       if dt.datetime.utcfromtimestamp(f[0]).strftime("%Y-%m") in counted])
            m["M_counted_folds_only_reported"] = float(np.mean([
                1 - ((p[sub & (sc.T == T), sc.lv.index(k_)] - sc.Yc[sub & (sc.T == T), sc.lv.index(k_)]) ** 2).mean()
                / ((np.clip(sc.PH[sub & (sc.T == T), sc.lv.index(k_)], 0, 1) - sc.Yc[sub & (sc.T == T), sc.lv.index(k_)]) ** 2).mean()
                for T, k_ in sc.cells]))
            m["calibration"] = calib(sc, p)
            m["mean_abs_residual"] = float(np.nanmean(np.abs(np.where(sc.msk, mean, np.nan))))
            rr["ens"][en] = m
            rr["loso"][en] = {str(k): sc.metrics(sc.prob(np.mean([res[j] for j in ks_ if j != k], axis=0)))["M"]
                              for k in ks_}
            print(S.now(), rule, en, f"M {m['M']:+.5f} z {m['z']:.2f} worst counted fold {m['guard']['worst_counted']:+.5f}"
                  f" below guard {m['guard']['n_counted_below_guard']} primary {m['cells']['3h -0.02']} z "
                  f"{m['primary_z']:.2f}", flush=True)
        rr["ens10_reported_only"] = sc.metrics(sc.prob(np.mean([res[k] for k in KS], axis=0)), full=True)
        sing = list(rr["single"].values())
        rr["single_summary"] = {"M_mean": float(np.mean([v["M"] for v in sing])), "M_min": float(min(v["M"] for v in sing)),
                                "M_max": float(max(v["M"] for v in sing)), "z_min": float(min(v["z"] for v in sing)),
                                "z_max": float(max(v["z"] for v in sing))}
        rr["score"] = (rr["ens"]["E1"]["M"] + rr["ens"]["E2"]["M"]) / 2
        rr["n_fail"] = rr["ens"]["E1"]["guard"]["n_counted_below_guard"] + rr["ens"]["E2"]["guard"]["n_counted_below_guard"]
        rr["guard_pass"] = rr["n_fail"] == 0
        rr["best_epoch_counts"] = {str(e): int(sum(m["best_epoch"] == e for m in fits)) for e in range(1, EPOCHS + 1)}
        rr["fits"] = len(fits)
        out["rules"][rule] = rr
    C, Dd = out["rules"]["C"], out["rules"]["D"]
    flag = None
    if C["guard_pass"] and Dd["guard_pass"]:
        if abs(C["score"] - Dd["score"]) < TIE:
            pick, why = "C", "both pass guard; scores within 0.001: prefer C"
        else:
            pick = "C" if C["score"] > Dd["score"] else "D"
            why = "both pass guard: higher score"
    elif C["guard_pass"] or Dd["guard_pass"]:
        pick = "C" if C["guard_pass"] else "D"
        why = "only this rule passes the guard"
    else:
        pick = min(("C", "D"), key=lambda r_: (out["rules"][r_]["n_fail"], -out["rules"][r_]["score"]))
        why = "neither passes: fewer failing counted folds, then higher score"
        flag = "guard failed"
    out["selection"] = {"chosen": pick, "why": why, "flag": flag, "score_C": C["score"], "score_D": Dd["score"],
                        "guard_C": C["guard_pass"], "guard_D": Dd["guard_pass"]}
    out["sec"] = round(time.time() - t0, 1)
    json.dump(out, open(os.path.join(a.out, "cd-r162e.json"), "w"), indent=1, default=float)
    np.savez_compressed(os.path.join(a.out, "cd-mean-residuals.npz"), idx=idx_ref,
                        **{f"{r_}_{en}": np.mean([load_res(a.out, r_)[1][k] for k in ks_], axis=0).astype(np.float16)
                           for r_ in ("C", "D") for en, ks_ in (("E1", E1), ("E2", E2))})
    print(S.now(), "SELECTION", json.dumps(out["selection"]), flush=True)


def cmd_power_live(a):
    """E.cmd_power_live with this script's E1 ensemble of the given rule (reported only)."""
    idx, res, _ = load_res(a.out, a.rule)
    sc, keys, _ = build_scorer(a.rows, a.out, idx)
    fake = {k: {"X": res[k]} for k in KS}
    E.load_wf = lambda _a: (sc, fake, keys)
    E.E1 = E1
    a2 = argparse.Namespace(rows=a.rows, out=a.out, rule="X")
    E.cmd_power_live(a2)
    os.replace(os.path.join(a.out, "power-d11-X.json"), os.path.join(a.out, f"power-d11-{a.rule}.json"))
    j = json.load(open(os.path.join(a.out, f"power-d11-{a.rule}.json")))
    j["rule"], j["rule_doc"], j["code"] = a.rule, "D-R16.2e-e", D.git_sha()
    json.dump(j, open(os.path.join(a.out, f"power-d11-{a.rule}.json"), "w"), indent=1, default=float)


# ----------------------------------------------------------------------------------------------------------- freeze
def cmd_freeze(a):
    import torch
    torch.set_num_threads(a.threads)
    os.makedirs(a.out, exist_ok=True)
    _, SA, flags, R = E.load_dev(a)
    L, nT, Tmax = len(NN.TIER_LV[TIER]), len(D.TIERS[TIER]), max(D.TIERS[TIER])
    vend = int(R["ts"].max()) + Tmax * STEP
    vstart = vend - VAL_DAYS * DAY
    tr_all = np.where(R["ts"] + Tmax * STEP <= vstart)[0]
    va_all = np.where((R["ts"] >= vstart) & (R["ts"] + Tmax * STEP <= vend))[0]
    chk = va_all[R["ts"][va_all] % DAY == 0]          # non-degeneracy rows: daily origins of the validation window
    states, infos = [], []
    for k in E1:
        seed = seed_of(k, FREEZE_F)
        rng = np.random.default_rng(seed)
        tr = draw_train(tr_all, a.rule, rng)
        va = np.sort(rng.choice(va_all, 60000, replace=False)) if len(va_all) > 60000 else va_all
        assert R["ts"][tr].max() + Tmax * STEP <= vstart
        st, info = fit_best(R, SA, tr, va, L, nT, seed)
        info.update({"k": k, "train_available": int(len(tr_all)), "train_ts_max": int(R["ts"][tr].max()),
                     "val_ts_range": [int(R["ts"][va].min()), int(R["ts"][va].max())]})
        print(S.now(), f"freeze {a.rule} k {k} seed {seed}: val {['%.5f' % v for v in info['val_bce_ep0_to_8']]} best "
              f"epoch {info['best_epoch']} state {info['state_sha256'][:12]} last-layer |w| {info['last_layer_abs_sum']:.4f}",
              flush=True)
        states.append(st)
        infos.append(info)
    rs = E.predict_res(R, SA, chk, states, L, nT)
    mres = np.mean(rs, axis=0)
    mk = R["Y"][chk] >= 0
    mad = float(np.abs(mres[mk]).mean())
    nondeg = {"rows": int(len(chk)), "cells": int(mk.sum()), "mean_abs_logit_diff_vs_fH": mad,
              "threshold": NONDEG_MIN, "last_layer_abs_sum_per_net": [i["last_layer_abs_sum"] for i in infos],
              "pass": bool(mad > NONDEG_MIN and all(i["last_layer_abs_sum"] > 0 for i in infos))}
    tag = f"-{a.tag}" if a.tag else ""
    pt = os.path.join(a.out, f"frozen-r162e-ens5-{a.rule}{tag}.pt")
    torch.save({"rule": a.rule, "states": states}, pt)
    cfg = {"schema": "q26-r162e-frozen-ens-v2", "label": "DEVELOPMENT freeze, before any blind byte",
           "rule_doc": "membrane-board design/Q26_ROUND16_PREREG.md D-R16.2e-e", "rule": a.rule,
           "rule_text": f"mean logit of 5 GRUs; fixed {EPOCHS} epochs; keep the epoch 1..{EPOCHS} state with the lowest "
                        f"validation BCE (initial state not eligible); training cap {CAP[a.rule]} (seeded draw of "
                        f"{DRAW[a.rule]})",
           "forecast": "p = running min over levels of sigmoid(logit(fH) + mean_k residual_k)",
           "code": D.git_sha(), "model": MODEL, "tier": TIER, "threads": a.threads,
           "torch_version": torch.__version__, "numpy_version": np.__version__,
           "primary": {"T": 3, "level": -0.02, "comparator": "fH", "holm": 1},
           "constants": {"HW": NN.HW, "DW": NN.DW, "STATIC": NN.STATIC, "CAP": CAP[a.rule], "DRAW": DRAW[a.rule],
                         "EPOCHS": EPOCHS, "VAL_DAYS": VAL_DAYS, "levels": NN.TIER_LV[TIER], "Ts": D.TIERS[TIER],
                         "seeds": [seed_of(k, FREEZE_F) for k in E1]},
           "train_rule": "rows with ts + Tmax h <= last row window end - 90 d",
           "val_range": [int(R["ts"][va_all].min()), int(R["ts"][va_all].max())], "excluded": flags, "nets": infos,
           "net_state_sha256": [i["state_sha256"] for i in infos], "non_degeneracy": nondeg,
           "weights_file": os.path.basename(pt), "weights_file_sha256": E.sha_file(pt),
           "inputs_sha256": {f"rows-T{T}.npz": E.sha_file(os.path.join(a.rows, f"rows-T{T}.npz")) for T in D.TIERS[TIER]},
           "rows_meta_sha256": E.sha_file(os.path.join(a.rows, "rows-meta.json")), "created_utc": S.now()}
    cj = os.path.join(a.out, f"frozen-r162e-ens5-{a.rule}{tag}.json")
    json.dump(cfg, open(cj, "w"), indent=1, default=float)
    print("frozen", cfg["weights_file_sha256"], "config", E.sha_file(cj), cfg["created_utc"], "nondeg", json.dumps(nondeg),
          flush=True)


# ------------------------------------------------------------------------------------------------------------ synth
def cmd_synth(a):
    """r16_nn_strict.cmd_synth world and scorer, with train_predict replaced by the rule's 5-net ensemble. Each net
    draws its OWN training rows from the fold's full training pool with its seed s(k, f) (the fold draw is reseeded per
    net); the validation rows are cmd_synth's."""
    import torch
    torch.set_num_threads(a.threads)
    meta = []
    Tmax = max(D.TIERS[TIER])

    def ens_train_predict(m, R, SA, tr_full, va, te, L, nT, seed, log, tag, keep_state=None):
        f = seed - SEED
        if R["LF"].dtype != np.float32:
            R["LF"] = R["LF"].astype(np.float32)
        t_min = int(R["ts"][te].min())
        fa = [x for x in S.folds(int(R["ts"].max())) if x[0] <= t_min < x[1]][0][0]
        tr_all = np.where(R["ts"] + Tmax * STEP <= fa - VAL_DAYS * DAY)[0]
        rs = []
        for k in E1:
            sk = seed_of(k, f)
            trk = draw_train(tr_all, a.rule, np.random.default_rng(sk))
            st, info = fit_best(R, SA, trk, va, L, nT, sk)
            (r_,) = E.predict_res(R, SA, np.sort(te), [st], L, nT)
            rs.append(r_)
            info.update({"tag": tag, "k": k, "train_available": int(len(tr_all))})
            meta.append(info)
            log(f"{tag} k {k}: train {len(trk)} val {['%.5f' % v for v in info['val_bce_ep0_to_8']]} best epoch "
                f"{info['best_epoch']}")
        tes = np.sort(te)
        p = 1 / (1 + np.exp(-(R["LF"][tes].astype(np.float64) + np.mean(rs, axis=0))))
        p = np.minimum.accumulate(p, axis=1).astype(np.float32)
        out = np.full((len(te), L), np.nan, np.float32)
        out[np.searchsorted(tes, te)] = p
        return out, {}
    S.train_predict = ens_train_predict
    S.cmd_synth(a)
    js = os.path.join(a.out, "synth-r162e.json")
    res = json.load(open(js))
    res.update({"rule": a.rule, "rule_doc": "D-R16.2e-e", "ensemble_code": D.git_sha(), "nets": meta})
    res["pass"] = {"NULL": bool(res["arms"]["NULL"]["tw_gru_vs_base"]["z"] > -1.96
                                and res["arms"]["NULL"]["bss_gru_vs_base"] <= 0),
                   "POSITIVE": bool(res["arms"]["POSITIVE"]["tw_gru_vs_base"]["z"] <= -1.96
                                    and res["arms"]["POSITIVE"]["bss_gru_vs_base"] > 0)}
    json.dump(res, open(os.path.join(a.out, f"synth-r162e-ens5-{a.rule}.json"), "w"), indent=1, default=float)
    os.remove(js)
    print("synth pass", res["pass"], flush=True)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("wf", "freeze"):
        s = sub.add_parser(name)
        s.add_argument("--datasets", required=True)
        s.add_argument("--rows", required=True)
        s.add_argument("--out", required=True)
        s.add_argument("--rule", choices=("C", "D"), required=True)
        s.add_argument("--threads", type=int, default=1 if name == "wf" else 3)
        if name == "wf":
            s.add_argument("--ks", required=True)
        else:
            s.add_argument("--tag", default="")
    s = sub.add_parser("score")
    s.add_argument("--rows", required=True)
    s.add_argument("--out", required=True)
    s = sub.add_parser("power-live")
    s.add_argument("--rows", required=True)
    s.add_argument("--out", required=True)
    s.add_argument("--rule", choices=("C", "D"), required=True)
    s = sub.add_parser("synth")
    s.add_argument("--out", required=True)
    s.add_argument("--rule", choices=("C", "D"), required=True)
    s.add_argument("--threads", type=int, default=1)
    a = ap.parse_args()
    {"wf": cmd_wf, "score": cmd_score, "freeze": cmd_freeze, "synth": cmd_synth, "power-live": cmd_power_live}[a.cmd](a)


if __name__ == "__main__":
    main()
