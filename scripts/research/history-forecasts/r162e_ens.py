"""Q26 R16.2e seed-averaged GRU freeze rule (Claude, O184 lane, 2026-10-23). DEVELOPMENT ONLY (seen data).

membrane-board design/Q26_ROUND16_PREREG.md D-R16.2e-c (selection rule committed before any score of this script).
Candidates (everything else as r16_nn_strict.py at 3c9d1d62):
  A  ENS5-FIX4  mean logit of 5 GRUs, each trained exactly 4 epochs (0..3), final state, no stopping, no guard
  B  ENS5-ES    mean logit of 5 GRUs, each by the registered loop (initial state eligible, patience 1, <= 4 epochs)
One training trajectory per (fold, seed) serves both rules: the registered loop's chosen state is one of the states the
fixed-epoch run passes through (validation is evaluated in eval mode and draws no random numbers), so A and B are paired.
Ensemble forecast: p = running minimum over levels of sigmoid(mean_k logit_k). logit = logit(fH) + residual.
Seeds s(k, f) = SEED + 5000 k + f (k = 1..10; E1 = k 1..5, E2 = k 6..10); the seed drives the training-row draw, the
validation subsample, torch init and the shuffle, as r16_nn_strict.cmd_fit.

  python3 r162e_ens.py check  --datasets DS --rows ROWS --strict-meta M --fold 15     (reproduces the registered fit)
  python3 r162e_ens.py wf     --datasets DS --rows ROWS --out OUT --ks 1,2,3,4,5 [--threads 2]
  python3 r162e_ens.py score  --rows ROWS --out OUT
  python3 r162e_ens.py freeze --datasets DS --rows ROWS --out OUT --rule A|B
  python3 r162e_ens.py synth  --out OUT --rule A|B
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
import math  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402

import numpy as np  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import r16_dev as D  # noqa: E402
import r16_nn as NN  # noqa: E402
import r16_nn_strict as S  # noqa: E402

SEED, STEP, DAY, TIER, MODEL, VAL_DAYS = S.SEED, S.STEP, S.DAY, S.TIER, S.MODEL, S.VAL_DAYS
E1, E2 = (1, 2, 3, 4, 5), (6, 7, 8, 9, 10)
FREEZE_F = 100
GUARD = -0.002
TIE = 0.0005
PRIMARY = (3, -0.02)


def seed_of(k, f):
    return SEED + 5000 * k + f


def sha_state(st):
    h = hashlib.sha256()
    for k_ in sorted(st):
        h.update(st[k_].numpy().tobytes())
    return h.hexdigest()


def sha_file(p_):
    h = hashlib.sha256()
    with open(p_, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def batches(R, SA, idx, nT, rng=None):
    import torch
    idx = rng.permutation(idx) if rng is not None else idx
    for b0 in range(0, len(idx), 1024):
        ii = np.sort(idx[b0:b0 + 1024])
        Hh, Dd, St = NN.build_batch(SA, R["sid"][ii], R["ts"][ii], {k: R[k][ii] for k in NN.STATIC}, R["Tidx"][ii], nT)
        yield (ii, torch.from_numpy(Hh), torch.from_numpy(Dd), torch.from_numpy(St),
               torch.from_numpy(R["LF"][ii]), torch.from_numpy(R["Y"][ii].astype(np.float32)))


def loss_of(o, y):
    import torch
    mk = (y >= 0).float()
    l_ = torch.nn.functional.binary_cross_entropy_with_logits(o, y.clamp(min=0), reduction="none")
    return (l_ * mk).sum() / mk.sum()


def fit_two(R, SA, tr_full, va, L, nT, seed):
    """the r16_nn_strict.train_predict loop run for all 4 epochs (no break). Returns the final state (rule A), the
    state the registered loop would keep (rule B: running best with min-delta 1e-6, stop when bad > 1), and info."""
    import torch
    torch.manual_seed(seed)
    rng = np.random.default_rng(seed)
    t0 = time.time()
    tr = tr_full[:NN.CAP[MODEL]]
    net = NN.make_model(MODEL, len(NN.STATIC) + 2 + nT, L)
    opt = torch.optim.Adam(net.parameters(), lr=1e-3, weight_decay=1e-4)
    best, best_state, bad, stopped, b_ep = np.inf, None, 0, False, None
    vls = []
    for ep in range(-1, 4):
        net.train()
        for _, h, d, s, lf, y in (batches(R, SA, tr, nT, rng) if ep >= 0 else ()):
            opt.zero_grad()
            loss = loss_of(net(h, d, s, lf), y)
            loss.backward()
            opt.step()
        net.eval()
        tot, cnt = 0.0, 0.0
        with torch.no_grad():
            for _, h, d, s, lf, y in batches(R, SA, va, nT):
                mk = (y >= 0).float().sum().item()
                tot += loss_of(net(h, d, s, lf), y).item() * mk
                cnt += mk
        vl = tot / max(cnt, 1)
        vls.append(vl)
        if not stopped:
            if vl < best - 1e-6:
                best, bad, b_ep = vl, 0, ep
                best_state = {k: v.clone() for k, v in net.state_dict().items()}
            else:
                bad += 1
                if bad > 1:
                    stopped = True
                    b_stop = ep + 1
    stA = {k: v.clone() for k, v in net.state_dict().items()}
    info = {"seed": int(seed), "train": int(len(tr)), "val": int(len(va)), "val_bce": vls,
            "B_best_epoch": int(b_ep), "B_initial_state": bool(b_ep == -1),
            "B_epochs_done": int(b_stop) if stopped else 4, "A_sha256": sha_state(stA),
            "B_sha256": sha_state(best_state), "sec": round(time.time() - t0, 1)}
    return stA, best_state, info


def predict_res(R, SA, te, states, L, nT):
    """residual logits (net logit - logit fH) of each state on rows te, one batch build per batch."""
    import torch
    nets = []
    for st in states:
        n_ = NN.make_model(MODEL, len(NN.STATIC) + 2 + nT, L)
        n_.load_state_dict(st)
        n_.eval()
        nets.append(n_)
    out = [np.full((len(te), L), np.nan, np.float32) for _ in states]
    assert (np.diff(te) > 0).all()
    with torch.no_grad():
        for ii, h, d, s, lf, y in batches(R, SA, te, nT):
            j = np.searchsorted(te, ii)
            for o, n_ in zip(out, nets):
                o[j] = (n_(h, d, s, lf) - lf).numpy()
    return out


def load_dev(a):
    keys = json.load(open(os.path.join(a.rows, "rows-meta.json")))["series"]
    import r12_tail as R12
    specs = {s_["key"]: s_ for s_ in R12.dev_specs(a.datasets)}
    SA = {j: NN.series_arrays(specs[k]) for j, k in enumerate(keys)}
    flags = S.exclusions(keys, SA)
    drop = np.array([k in flags for k in keys])
    R = NN.tier_rows(a.rows, TIER)
    keep = ~drop[R["sid"]]
    R = {k: v[keep] for k, v in R.items()}
    return keys, SA, flags, R


def fold_sets(R, fi, fa, fb, seed, Tmax):
    """r16_nn_strict.cmd_fit row sets with the given seed (identical rule)."""
    te = np.where((R["ts"] >= fa) & (R["ts"] < fb) & (R["ts"] % DAY == 0))[0]
    prior = R["ts"][R["ts"] + Tmax * STEP <= fa]
    vend = int(prior.max()) + Tmax * STEP if len(prior) else fa
    vstart = vend - VAL_DAYS * DAY
    tr_all = np.where(R["ts"] + Tmax * STEP <= vstart)[0]
    va = np.where((R["ts"] >= vstart) & (R["ts"] + Tmax * STEP <= vend))[0]
    if len(te) == 0 or len(tr_all) < 5000 or len(va) < 1000:
        return None
    rng = np.random.default_rng(seed)
    tr = rng.choice(tr_all, NN.MAX_TRAIN, replace=False) if len(tr_all) > NN.MAX_TRAIN else rng.permutation(tr_all)
    if len(va) > 60000:
        va = np.sort(rng.choice(va, 60000, replace=False))
    assert R["ts"][tr].max() + Tmax * STEP <= vstart and R["ts"][va].max() + Tmax * STEP <= vend <= fa
    assert R["ts"][te].min() >= fa
    return tr, va, te


def cmd_check(a):
    """reproduce the registered strict fit of one fold (seed SEED + f): rule-B state sha must equal strict-meta."""
    import torch
    torch.set_num_threads(a.threads)
    _, SA, _, R = load_dev(a)
    L, nT, Tmax = len(NN.TIER_LV[TIER]), len(D.TIERS[TIER]), max(D.TIERS[TIER])
    fa, fb = S.folds(int(R["ts"].max()))[a.fold]
    tr, va, te = fold_sets(R, a.fold, fa, fb, SEED + a.fold, Tmax)
    _, _, info = fit_two(R, SA, tr, va, L, nT, SEED + a.fold)
    ref = [f for f in json.load(open(a.strict_meta))["folds"] if f["fold"] == a.fold][0]
    ok = info["B_sha256"] == ref["weights_sha256"]
    print(json.dumps({"fold": a.fold, "B_sha256": info["B_sha256"], "registered": ref["weights_sha256"],
                      "match": ok, "val_bce": info["val_bce"], "registered_val": ref["val_bce"]}), flush=True)
    if not ok:
        sys.exit(1)


def cmd_wf(a):
    import torch
    torch.set_num_threads(a.threads)
    os.makedirs(a.out, exist_ok=True)
    logf = open(os.path.join(a.out, f"wf-log-{a.ks.replace(',', '_')}.txt"), "a")

    def log(s_):
        line = f"{S.now()} {s_}"
        print(line, flush=True)
        logf.write(line + "\n")
        logf.flush()
    log(f"START r162e_ens wf ks {a.ks}; code {D.git_sha()}")
    _, SA, flags, R = load_dev(a)
    log(f"  series arrays built ({len(SA)}); excluded {flags}")
    json.dump(flags, open(os.path.join(a.out, "excluded.json"), "w"))
    L, nT, Tmax = len(NN.TIER_LV[TIER]), len(D.TIERS[TIER]), max(D.TIERS[TIER])
    F = S.folds(int(R["ts"].max()))
    for k in [int(x) for x in a.ks.split(",")]:
        fn = os.path.join(a.out, f"res-k{k}.npz")
        if os.path.exists(fn):
            log(f"  k {k} exists, skipped")
            continue
        idx, rA, rB, meta = [], [], [], []
        for fi, (fa, fb) in enumerate(F):
            sets = fold_sets(R, fi, fa, fb, seed_of(k, fi), Tmax)
            if sets is None:
                continue
            tr, va, te = sets
            stA, stB, info = fit_two(R, SA, tr, va, L, nT, seed_of(k, fi))
            pa, pb = predict_res(R, SA, te, [stA, stB], L, nT)
            idx.append(te)
            rA.append(pa)
            rB.append(pb)
            info.update({"k": k, "fold": fi, "a": fa, "b": fb, "test": int(len(te))})
            meta.append(info)
            log(f"  k {k} fold {fi} {dt.datetime.utcfromtimestamp(fa):%Y-%m}: val {['%.5f' % v for v in info['val_bce']]} "
                f"B epoch {info['B_best_epoch']} ({info['sec']:.0f}s)")
        np.savez_compressed(fn, idx=np.concatenate(idx), rA=np.concatenate(rA).astype(np.float16),
                            rB=np.concatenate(rB).astype(np.float16))
        json.dump(meta, open(os.path.join(a.out, f"meta-k{k}.json"), "w"), indent=1, default=float)
        log(f"  k {k} written")
    log("END wf")


# ------------------------------------------------------------------------------------------------------------ score
def dev_targets(rows):
    """Y (-1 absent), raw fH (as cmd_score uses), T and the cell list, in tier_rows order (no exclusion applied)."""
    lv = NN.TIER_LV[TIER]
    parts = []
    for T in D.TIERS[TIER]:
        Z = np.load(os.path.join(rows, f"rows-T{T}.npz"))
        n = len(Z["ts"])
        Y = np.full((n, len(lv)), -1, np.int8)
        P = np.full((n, len(lv)), np.nan, np.float64)
        for j, k in enumerate(D.LV[T]):
            c = lv.index(k)
            Y[:, c] = Z["y"][:, j]
            P[:, c] = Z["fH"][:, j]
        parts.append({"sid": Z["sid"], "ts": Z["ts"], "Y": Y, "P": P, "T": np.full(n, T, np.int32)})
    return {k: np.concatenate([p[k] for p in parts]) for k in parts[0]}


class Scorer:
    def __init__(self, rows, folds):
        X = dev_targets(rows)
        self.X = X
        self.cells = [(T, k) for T in D.TIERS[TIER] for k in D.LV[T]]
        self.lv = NN.TIER_LV[TIER]
        self.folds = folds

    def setup(self, R, keep, idx):
        X = self.X
        g = np.flatnonzero(keep)[idx]          # dev_targets and tier_rows share the row order; R = rows[keep]
        assert (X["sid"][g] == R["sid"][idx]).all() and (X["ts"][g] == R["ts"][idx]).all()
        assert (X["T"][g] == R["T"][idx]).all() and (X["Y"][g] == R["Y"][idx]).all()
        self.Y = X["Y"][g].astype(float)
        self.PH = X["P"][g]
        self.T = X["T"][g]
        self.sid = X["sid"][g]
        self.ts = X["ts"][g]
        self.LF = R["LF"][idx].astype(np.float64)
        self.msk = self.Y >= 0
        assert set(np.unique(self.Y[self.msk])) <= {0.0, 1.0}
        assert np.isfinite(self.PH[self.msk]).all()
        self.nl = self.msk.sum(1)
        Yc = np.where(self.msk, self.Y, 0)
        self.Yc = Yc
        PHc = np.clip(np.where(self.msk, self.PH, 0), 0, 1)
        self.bH = (((PHc - Yc) ** 2) * self.msk).sum(1) / self.nl
        self.blk = (self.ts // (28 * DAY)).astype(np.int64)
        self.tw = D.TwoWay(self.sid, self.blk, B=1000)
        self.fold_of = np.searchsorted(np.array([f[0] for f in self.folds]), self.ts, side="right") - 1

    def prob(self, res_mean):
        p = 1 / (1 + np.exp(-(self.LF + res_mean)))
        return np.clip(np.minimum.accumulate(p, axis=1), 0, 1)

    def metrics(self, p, full=False):
        Yc, msk = self.Yc, self.msk
        e = (((p - Yc) ** 2) * msk)
        d = e.sum(1) / self.nl - self.bH
        out = {"cells": {}}
        bss = []
        for T, k in self.cells:
            c = self.lv.index(k)
            r = self.T == T
            y, pm, pH = Yc[r, c], p[r, c], np.clip(self.PH[r, c], 0, 1)
            b = float(1 - ((pm - y) ** 2).mean() / ((pH - y) ** 2).mean())
            bss.append(b)
            out["cells"][f"{D.TL[T]} {k}"] = {"bss": b, "R": float(pm.sum() / max(y.sum(), 1)),
                                              "R_fH": float(pH.sum() / max(y.sum(), 1))}
        out["M"] = float(np.mean(bss))
        out["min_cell"] = float(np.min(bss))
        fb = {}
        for fi in np.unique(self.fold_of):
            m = self.fold_of == fi
            fb[str(dt.datetime.utcfromtimestamp(self.folds[fi][0]).strftime("%Y-%m"))] = float(-d[m].sum() / self.bH[m].sum())
        out["fold_bss"] = fb
        out["worst_fold"] = float(min(fb.values()))
        out["n_fold_below_guard"] = int(sum(v < GUARD for v in fb.values()))
        out["n_fold_below_zero"] = int(sum(v < 0 for v in fb.values()))
        tw = self.tw.z(d)
        out["z"] = tw["z"]
        if full:
            out["two_way"] = tw
            out["cgm_z"] = S.cgm_z(d, self.sid, self.blk)
            out["leave_top_k"] = D.leave_top_k(self.sid, d)
            T, k = PRIMARY
            c = self.lv.index(k)
            r = self.T == T
            out["primary_z"] = D.TwoWay(self.sid[r], self.blk[r], B=1000).z(
                (p[r, c] - Yc[r, c]) ** 2 - (np.clip(self.PH[r, c], 0, 1) - Yc[r, c]) ** 2)["z"]
        return out


def cmd_score(a):
    t0 = time.time()
    meta_all, res = {}, {}
    ks = sorted(int(f[5:-4]) for f in os.listdir(a.out) if f.startswith("res-k") and f.endswith(".npz"))
    assert set(E1 + E2) <= set(ks), ks
    idx0 = None
    for k in E1 + E2:
        Z = np.load(os.path.join(a.out, f"res-k{k}.npz"))
        if idx0 is None:
            idx0 = Z["idx"]
            o = np.argsort(idx0)
        assert (Z["idx"] == idx0).all()
        res[k] = {"A": Z["rA"][o].astype(np.float64), "B": Z["rB"][o].astype(np.float64)}
        meta_all[k] = json.load(open(os.path.join(a.out, f"meta-k{k}.json")))
    idx = idx0[o]
    # R rows after exclusion: rebuild from rows (needs LF / sid / ts / T only)
    keys = json.load(open(os.path.join(a.rows, "rows-meta.json")))["series"]
    excl = json.load(open(os.path.join(a.out, "excluded.json")))
    R = NN.tier_rows(a.rows, TIER)
    drop = np.array([k in excl for k in keys])
    keep = ~drop[R["sid"]]
    R = {k: v[keep] for k, v in R.items()}
    F = S.folds(int(R["ts"].max()))
    sc = Scorer(a.rows, F)
    sc.setup(R, keep, idx)
    print(S.now(), f"rows {len(idx)} excluded {excl}", flush=True)
    out = {"schema": "q26-r162e-ens/1", "label": "DEVELOPMENT ONLY (seen data)", "code": D.git_sha(),
           "rule": "membrane-board D-R16.2e-c", "rows": int(len(idx)), "excluded": excl,
           "seeds": {str(k): [seed_of(k, f) for f in sorted({m["fold"] for m in meta_all[k]})] for k in E1 + E2},
           "rules": {}}
    for rule in ("A", "B"):
        rr = {"single": {}, "ens": {}, "loso": {}}
        for k in E1 + E2:
            m = sc.metrics(sc.prob(res[k][rule]))
            rr["single"][str(k)] = {"M": m["M"], "z": m["z"], "worst_fold": m["worst_fold"],
                                    "n_fold_below_guard": m["n_fold_below_guard"]}
        for en, ks_ in (("E1", E1), ("E2", E2)):
            mean = np.mean([res[k][rule] for k in ks_], axis=0)
            rr["ens"][en] = sc.metrics(sc.prob(mean), full=True)
            rr["loso"][en] = {str(k): sc.metrics(sc.prob(np.mean([res[j][rule] for j in ks_ if j != k], axis=0)))["M"]
                              for k in ks_}
            print(S.now(), rule, en, f"M {rr['ens'][en]['M']:+.5f} z {rr['ens'][en]['z']:.2f} worst fold "
                  f"{rr['ens'][en]['worst_fold']:+.5f} primary {rr['ens'][en]['cells']['3h -0.02']}", flush=True)
        mean10 = np.mean([res[k][rule] for k in E1 + E2], axis=0)
        rr["ens10_reported_only"] = sc.metrics(sc.prob(mean10), full=True)
        sing = [v["M"] for v in rr["single"].values()]
        rr["single_summary"] = {"M_mean": float(np.mean(sing)), "M_min": float(np.min(sing)), "M_max": float(np.max(sing)),
                                "z_min": float(min(v["z"] for v in rr["single"].values())),
                                "z_max": float(max(v["z"] for v in rr["single"].values()))}
        rr["score"] = (rr["ens"]["E1"]["M"] + rr["ens"]["E2"]["M"]) / 2
        rr["worst_fold_both"] = min(rr["ens"]["E1"]["worst_fold"], rr["ens"]["E2"]["worst_fold"])
        rr["n_fail"] = rr["ens"]["E1"]["n_fold_below_guard"] + rr["ens"]["E2"]["n_fold_below_guard"]
        rr["guard_pass"] = rr["n_fail"] == 0
        if rule == "B":
            fits = [m for k in E1 + E2 for m in meta_all[k]]
            rr["B_initial_state_share"] = float(np.mean([m["B_initial_state"] for m in fits]))
            rr["B_initial_state_fits"] = int(sum(m["B_initial_state"] for m in fits))
            rr["fits"] = len(fits)
        out["rules"][rule] = rr
    A, B = out["rules"]["A"], out["rules"]["B"]
    flag = None
    if A["guard_pass"] and B["guard_pass"]:
        if abs(A["score"] - B["score"]) < TIE:
            pick = "A" if A["worst_fold_both"] > B["worst_fold_both"] else "B"
            why = "tie within 0.0005: higher worst fold"
        else:
            pick = "A" if A["score"] > B["score"] else "B"
            why = "both pass guard: higher score"
    elif A["guard_pass"] or B["guard_pass"]:
        pick = "A" if A["guard_pass"] else "B"
        why = "only this rule passes the guard"
    else:
        pick = min(("A", "B"), key=lambda r_: (out["rules"][r_]["n_fail"], -out["rules"][r_]["score"]))
        why = "neither passes: fewer failing folds, then higher score"
        flag = "guard failed"
    out["selection"] = {"chosen": pick, "why": why, "flag": flag, "score_A": A["score"], "score_B": B["score"],
                        "guard_A": A["guard_pass"], "guard_B": B["guard_pass"]}
    out["sec"] = round(time.time() - t0, 1)
    json.dump(out, open(os.path.join(a.out, "ens-r162e.json"), "w"), indent=1, default=float)
    print(S.now(), "SELECTION", json.dumps(out["selection"]), flush=True)


# ----------------------------------------------------------------------------------------------------------- freeze
def cmd_freeze(a):
    import torch
    torch.set_num_threads(a.threads)
    os.makedirs(a.out, exist_ok=True)
    _, SA, flags, R = load_dev(a)
    L, nT, Tmax = len(NN.TIER_LV[TIER]), len(D.TIERS[TIER]), max(D.TIERS[TIER])
    vend = int(R["ts"].max()) + Tmax * STEP
    vstart = vend - VAL_DAYS * DAY
    tr_all = np.where(R["ts"] + Tmax * STEP <= vstart)[0]
    va_all = np.where((R["ts"] >= vstart) & (R["ts"] + Tmax * STEP <= vend))[0]
    states, infos = [], []
    for k in E1:
        seed = seed_of(k, FREEZE_F)
        rng = np.random.default_rng(seed)
        tr = rng.choice(tr_all, NN.MAX_TRAIN, replace=False) if len(tr_all) > NN.MAX_TRAIN else rng.permutation(tr_all)
        va = np.sort(rng.choice(va_all, 60000, replace=False)) if len(va_all) > 60000 else va_all
        assert R["ts"][tr].max() + Tmax * STEP <= vstart
        stA, stB, info = fit_two(R, SA, tr, va, L, nT, seed)
        st = stA if a.rule == "A" else stB
        info.update({"k": k, "state_sha256": sha_state(st), "train_ts_max": int(R["ts"][tr[:NN.CAP[MODEL]]].max()),
                     "val_ts_range": [int(R["ts"][va].min()), int(R["ts"][va].max())]})
        print(S.now(), f"freeze k {k} seed {seed}: val {['%.5f' % v for v in info['val_bce']]} B epoch "
              f"{info['B_best_epoch']} state {info['state_sha256'][:12]}", flush=True)
        states.append(st)
        infos.append(info)
    pt = os.path.join(a.out, f"frozen-r162e-ens5-{a.rule}.pt")
    torch.save({"rule": a.rule, "states": states}, pt)
    cfg = {"schema": "q26-r162e-frozen-ens-v1", "label": "DEVELOPMENT freeze, before any blind byte",
           "rule_doc": "membrane-board design/Q26_ROUND16_PREREG.md D-R16.2e-c", "rule": a.rule,
           "rule_text": {"A": "mean logit of 5 GRUs, 4 fixed epochs, final state", "B": "mean logit of 5 GRUs, registered "
                         "early stopping with initial state eligible"}[a.rule],
           "forecast": "p = running min over levels of sigmoid(logit(fH) + mean_k residual_k)",
           "code": D.git_sha(), "model": MODEL, "tier": TIER,
           "primary": {"T": 3, "level": -0.02, "comparator": "fH", "holm": 1},
           "constants": {"HW": NN.HW, "DW": NN.DW, "STATIC": NN.STATIC, "CAP": NN.CAP[MODEL], "MAX_TRAIN": NN.MAX_TRAIN,
                         "VAL_DAYS": VAL_DAYS, "levels": NN.TIER_LV[TIER], "Ts": D.TIERS[TIER],
                         "seeds": [seed_of(k, FREEZE_F) for k in E1]},
           "train_rule": "rows with ts + Tmax h <= last row window end - 90 d (60,000-row draw, first 20,000 used)",
           "val_range": [int(R["ts"][va_all].min()), int(R["ts"][va_all].max())], "excluded": flags, "nets": infos,
           "weights_file": os.path.basename(pt), "weights_file_sha256": sha_file(pt),
           "inputs_sha256": {f"rows-T{T}.npz": sha_file(os.path.join(a.rows, f"rows-T{T}.npz")) for T in D.TIERS[TIER]},
           "rows_meta_sha256": sha_file(os.path.join(a.rows, "rows-meta.json")), "created_utc": S.now()}
    cj = os.path.join(a.out, f"frozen-r162e-ens5-{a.rule}.json")
    json.dump(cfg, open(cj, "w"), indent=1, default=float)
    print("frozen", cfg["weights_file_sha256"], "config", sha_file(cj), cfg["created_utc"], flush=True)


# ------------------------------------------------------------------------------------------------------------ synth
def cmd_synth(a):
    """r16_nn_strict.cmd_synth unchanged except train_predict, replaced by the 5-net ensemble of the given rule. The
    world and the fold row draw (SEED + f) are cmd_synth's; each net re-permutes that 60,000-row draw with its own seed
    s(k, f) and takes the first 20,000 (so nets see different rows), as close as cmd_synth's structure allows."""
    import torch
    meta = []

    def ens_train_predict(m, R, SA, tr_full, va, te, L, nT, seed, log, tag, keep_state=None):
        f = seed - SEED
        if "LF" in R and R["LF"].dtype != np.float32:
            R["LF"] = R["LF"].astype(np.float32)
        rs = []
        for k in E1:
            sk = seed_of(k, f)
            trk = np.random.default_rng(sk).permutation(tr_full)
            stA, stB, info = fit_two(R, SA, trk, va, L, nT, sk)
            st = stA if a.rule == "A" else stB
            (r_,) = predict_res(R, SA, np.sort(te), [st], L, nT)
            rs.append(r_)
            info.update({"tag": tag, "k": k})
            meta.append(info)
            log(f"{tag} k {k}: val {['%.5f' % v for v in info['val_bce']]} B epoch {info['B_best_epoch']}")
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
    res["rule"] = a.rule
    res["ensemble_code"] = D.git_sha()
    res["nets"] = meta
    res["pass"] = {"NULL": bool(res["arms"]["NULL"]["tw_gru_vs_base"]["z"] > -1.96
                                and res["arms"]["NULL"]["bss_gru_vs_base"] <= 0),
                   "POSITIVE": bool(res["arms"]["POSITIVE"]["tw_gru_vs_base"]["z"] <= -1.96
                                    and res["arms"]["POSITIVE"]["bss_gru_vs_base"] > 0)}
    json.dump(res, open(os.path.join(a.out, f"synth-r162e-ens5-{a.rule}.json"), "w"), indent=1, default=float)
    os.remove(js)
    print("synth pass", res["pass"], flush=True)
    del torch


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("check", "wf", "freeze"):
        s = sub.add_parser(name)
        s.add_argument("--datasets", required=True)
        s.add_argument("--rows", required=True)
        s.add_argument("--threads", type=int, default=2)
        if name == "check":
            s.add_argument("--strict-meta", required=True)
            s.add_argument("--fold", type=int, default=15)
        else:
            s.add_argument("--out", required=True)
        if name == "wf":
            s.add_argument("--ks", required=True)
        if name == "freeze":
            s.add_argument("--rule", choices=("A", "B"), required=True)
    s = sub.add_parser("score")
    s.add_argument("--rows", required=True)
    s.add_argument("--out", required=True)
    s = sub.add_parser("synth")
    s.add_argument("--out", required=True)
    s.add_argument("--rule", choices=("A", "B"), required=True)
    s.add_argument("--threads", type=int, default=1)
    a = ap.parse_args()
    {"check": cmd_check, "wf": cmd_wf, "score": cmd_score, "freeze": cmd_freeze, "synth": cmd_synth}[a.cmd](a)


if __name__ == "__main__":
    main()
