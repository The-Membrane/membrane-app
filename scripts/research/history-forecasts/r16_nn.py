"""Q26 R16.2 development: small sequence models on raw lag windows (owner request 2026-10-19, relayed by the Q26
parent). DEVELOPMENT ONLY (seen data). Recorded in membrane-board design/Q26_ROUND16_PREREG.md D-R16.2a.

Menu fixed here before any output:
  inputs   per row (origin i, horizon T): the last 72 hourly bars [return, ln(high/low), ln(volume / 30-day mean)] and
           the last 60 daily blocks [24 h return, 24 h range ln(max high / min low), 24 h volume ratio]; returns and
           ranges are divided by the row's hourly (fH) scale sigma_H / sqrt(8760) (sqrt(24) larger for daily blocks)
           and clipped to +-10; static: ln sigma_H, ln sigma_EWMA, ln D - ln M, ln W - ln M, 24 h / 7 d / 30 d returns,
           30-day drawdown, 24 h range, volume ratio, BTC 24 h return and ln D - ln M, the vol-state gaps
           gap22 = ln sqrt(8760 mean r^2 over the last 22 bars) - ln sigma_H and ln sigma_H - ln Park_M, and a
           one-hot of T inside the tier
  outputs  touch logits for the tier's level union (shallow -2/-3/-5/-7/-10%; mid -3/-5/-7/-10/-15/-20%;
           long -10/-15/-20/-25/-30/-40%), loss = masked binary cross-entropy on the row's own levels;
           running minimum across levels after prediction
  models   nmlp  MLP on the flattened windows + static      residual: logit p = logit p_fH + head (head starts at 0)
           ngru  GRU(32) on the hourly and daily windows      residual
           ntcn  3-layer dilated causal 1-D CNN (32 ch)       residual
           ntfm  2-layer transformer encoder (d 32, 4 heads)  residual
           nmlp0 the MLP without p_fH (direct touch odds; level index as input)
  training one model per tier (rows of every T in the tier pooled); Adam lr 1e-3, weight decay 1e-4, batch 1024,
           dropout 0.1, at most 6 epochs, early stopping (patience 1) on a validation series group inside the
           training cells (never random rows); at most 240,000 training rows per fit (uniform by row)
  cross-fit 2 series halves (sha256 salt as r16_dev, group % 2) x 2 time halves (split at the tier's median origin
           time); a test cell is predicted by a model trained on the other series half AND the other time half,
           training windows ending >= T_max before / starting after the test half (embargo)
Output: rows-nn-T{T}.npz (sid by r16_dev rows-meta order, ts, one array per model), merged by r16_dev score.

  python3 r16_nn.py fit --datasets DS --out OUT [--threads 3] [--tiers shallow,mid,long]
"""
from __future__ import annotations

import os

import argparse  # noqa: E402
import hashlib  # noqa: E402
import json  # noqa: E402
import math  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402

import numpy as np  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import a6_touch as A6  # noqa: E402
import r12_tail as R12  # noqa: E402
import r16_dev as D  # noqa: E402

STEP, DAY = 3600, 86400
TIER_LV = {"shallow": (-0.02, -0.03, -0.05, -0.07, -0.10), "mid": (-0.03, -0.05, -0.07, -0.10, -0.15, -0.20),
           "long": (-0.10, -0.15, -0.20, -0.25, -0.30, -0.40)}
HW, DW = 72, 60
STATIC = ("lsH", "lsf", "dm", "wm", "r24", "r168", "r720", "dd720", "rng24", "lvol", "btc_r24", "btc_dm")
MODELS = ("nmlp", "ngru", "ntcn", "ntfm", "nmlp0")
MAX_TRAIN = 240000
SEED = 20261903


def series_arrays(spec):
    """origin-aligned per-series arrays used to build windows."""
    ser, folds, caps = R12.load_series(spec)
    N1 = len(ser.close) + 1
    c = ser.close
    lc = np.log(np.concatenate([[np.nan], c]))
    hi = np.concatenate([[np.nan], ser.high])
    lo = np.concatenate([[np.nan], ser.low])
    r = np.full(N1, np.nan)
    r[1:] = lc[1:] - np.concatenate([[np.nan], lc[1:-1]])          # r[i] = return of bar i-1 (known at origin i)
    with np.errstate(invalid="ignore", divide="ignore"):
        rg = np.log(hi / lo)
    vol = D.load_volume(spec)
    lv = np.zeros(N1)
    if vol is not None and len(vol) == len(c):
        v720 = A6.window_mean_null_rule(vol, 720, ser.start_i)
        with np.errstate(invalid="ignore", divide="ignore"):
            x = np.log(np.concatenate([[np.nan], vol]) / v720)
        lv = np.where(np.isfinite(x), x, 0.0)
    from numpy.lib.stride_tricks import sliding_window_view as swv

    def roll(x, W, f):
        o = np.full(N1, np.nan)
        if N1 > W:
            v = f(swv(np.where(np.isfinite(x), x, np.nan), W), axis=1)
            o[W - 1:] = v
        return o
    with np.errstate(invalid="ignore"):
        hm = roll(hi, 24, np.nanmax)
        lm = roll(lo, 24, np.nanmin)
        R24 = np.full(N1, np.nan)
        R24[24:] = lc[24:] - lc[:-24]
        RG24 = np.log(hm / lm)
        V24 = roll(lv, 24, np.nanmean)
        r2 = np.where(np.isfinite(r), r * r, np.nan)
        rv22 = roll(r2, 22, np.nanmean)
    HAR = np.log(A6.har_of(ser))
    out = {"r": np.nan_to_num(r).astype(np.float32), "rg": np.nan_to_num(rg).astype(np.float32),
           "lv": np.clip(lv, -5, 5).astype(np.float32), "R24": np.nan_to_num(R24).astype(np.float32),
           "RG24": np.nan_to_num(RG24).astype(np.float32), "V24": np.clip(np.nan_to_num(V24), -5, 5).astype(np.float32),
           "lrv22": (0.5 * np.log(8760 * rv22)).astype(np.float32), "lpm": (0.5 * HAR[:, 2]).astype(np.float32),
           "base_ts": ser.base_ts}
    return out


def build_batch(SA, sid, ts, F, Tidx, nT):
    """windows and static features for rows (sid, ts) with feature dict F (row-aligned arrays)."""
    n = len(sid)
    H = np.zeros((n, HW, 3), np.float32)
    Dd = np.zeros((n, DW, 3), np.float32)
    lsH = F["lsH"].astype(np.float32)
    sh = np.exp(lsH) / math.sqrt(8760.0)
    gap22 = np.zeros(n, np.float32)
    gapM = np.zeros(n, np.float32)
    for s in np.unique(sid):
        m = np.where(sid == s)[0]
        A = SA[int(s)]
        i = ((ts[m] - A["base_ts"]) // STEP).astype(np.int64)
        hidx = i[:, None] - np.arange(HW)[None, ::-1]          # bars i-72 .. i-1 as r[i-71..i]
        hidx = np.clip(hidx, 0, len(A["r"]) - 1)
        H[m, :, 0] = A["r"][hidx]
        H[m, :, 1] = A["rg"][hidx]
        H[m, :, 2] = A["lv"][hidx]
        didx = i[:, None] - 24 * np.arange(DW)[None, ::-1]
        didx = np.clip(didx, 0, len(A["R24"]) - 1)
        Dd[m, :, 0] = A["R24"][didx]
        Dd[m, :, 1] = A["RG24"][didx]
        Dd[m, :, 2] = A["V24"][didx]
        g = A["lrv22"][np.clip(i, 0, len(A["lrv22"]) - 1)] - lsH[m]
        gap22[m] = np.where(np.isfinite(g), g, 0.0)
        gm = lsH[m] - A["lpm"][np.clip(i, 0, len(A["lpm"]) - 1)]
        gapM[m] = np.where(np.isfinite(gm), gm, 0.0)
    shc = np.where(np.isfinite(sh) & (sh > 0), sh, 0.02)[:, None]
    H[:, :, 0] /= shc
    H[:, :, 1] /= shc
    Dd[:, :, 0] /= shc * math.sqrt(24)
    Dd[:, :, 1] /= shc * math.sqrt(24)
    np.clip(H, -10, 10, out=H)
    np.clip(Dd, -10, 10, out=Dd)
    S = [np.nan_to_num(F[k].astype(np.float32)) for k in STATIC] + [gap22, gapM]
    oh = np.zeros((n, nT), np.float32)
    oh[np.arange(n), Tidx] = 1
    S = np.column_stack(S + [oh])
    return H, Dd, np.clip(S, -20, 20)


def make_model(kind, n_static, L):
    import torch
    import torch.nn as nn

    class Head(nn.Module):
        def __init__(self, d_in, residual):
            super().__init__()
            self.residual = residual
            self.net = nn.Sequential(nn.Linear(d_in + (L if residual else 0) + n_static, 64), nn.ReLU(),
                                     nn.Dropout(0.1), nn.Linear(64, L))
            if residual:
                nn.init.zeros_(self.net[-1].weight)
                nn.init.zeros_(self.net[-1].bias)

        def forward(self, z, s, lf):
            x = torch.cat([z, s] + ([lf] if self.residual else []), dim=1)
            o = self.net(x)
            return o + lf if self.residual else o

    class MLP(nn.Module):
        def __init__(self, residual):
            super().__init__()
            self.enc = nn.Sequential(nn.Flatten(), nn.Linear(HW * 3 + DW * 3, 64), nn.ReLU(), nn.Dropout(0.1))
            self.head = Head(64, residual)

        def forward(self, h, d, s, lf):
            return self.head(self.enc(torch.cat([h.flatten(1), d.flatten(1)], dim=1)), s, lf)

    class GRU(nn.Module):
        def __init__(self):
            super().__init__()
            self.gh = nn.GRU(3, 32, batch_first=True)
            self.gd = nn.GRU(3, 32, batch_first=True)
            self.head = Head(64, True)

        def forward(self, h, d, s, lf):
            _, a = self.gh(h)
            _, b = self.gd(d)
            return self.head(torch.cat([a[-1], b[-1]], dim=1), s, lf)

    class TCN(nn.Module):
        def __init__(self):
            super().__init__()

            def stack():
                return nn.Sequential(nn.Conv1d(3, 32, 3, dilation=1, padding=2), nn.ReLU(),
                                     nn.Conv1d(32, 32, 3, dilation=2, padding=4), nn.ReLU(),
                                     nn.Conv1d(32, 32, 3, dilation=4, padding=8), nn.ReLU())
            self.ch, self.cd = stack(), stack()
            self.head = Head(64, True)

        def forward(self, h, d, s, lf):
            a = self.ch(h.transpose(1, 2))[:, :, :HW][:, :, -1]
            b = self.cd(d.transpose(1, 2))[:, :, :DW][:, :, -1]
            return self.head(torch.cat([a, b], dim=1), s, lf)

    class TFM(nn.Module):
        def __init__(self):
            super().__init__()
            self.ph = nn.Linear(3, 32)
            self.pd = nn.Linear(3, 32)
            self.pos = nn.Parameter(torch.zeros(1, HW + DW + 1, 32))
            self.cls = nn.Parameter(torch.zeros(1, 1, 32))
            layer = nn.TransformerEncoderLayer(32, 4, 64, dropout=0.1, batch_first=True)
            self.enc = nn.TransformerEncoder(layer, 2)
            self.head = Head(32, True)

        def forward(self, h, d, s, lf):
            x = torch.cat([self.cls.expand(len(h), -1, -1), self.ph(h), self.pd(d)], dim=1) + self.pos
            return self.head(self.enc(x)[:, 0], s, lf)

    return {"nmlp": lambda: MLP(True), "nmlp0": lambda: MLP(False), "ngru": GRU, "ntcn": TCN, "ntfm": TFM}[kind]()


def tier_rows(out_dir, tier):
    Ts = D.TIERS[tier]
    lv = TIER_LV[tier]
    parts = []
    for jT, T in enumerate(Ts):
        Z = np.load(os.path.join(out_dir, f"rows-T{T}.npz"))
        n = len(Z["ts"])
        Y = np.full((n, len(lv)), -1, np.int8)
        LF = np.zeros((n, len(lv)), np.float32)
        for j, k in enumerate(D.LV[T]):
            c = lv.index(k)
            Y[:, c] = Z["y"][:, j]
            LF[:, c] = D.lg(Z["fH"][:, j])
        parts.append({"sid": Z["sid"], "ts": Z["ts"], "Y": Y, "LF": LF, "T": np.full(n, T, np.int32),
                      "Tidx": np.full(n, jT, np.int32), **{k: Z[k] for k in STATIC}})
    return {k: np.concatenate([p[k] for p in parts]) for k in parts[0]}


def run_tier(a, tier, SA, keys, log):
    import torch
    torch.manual_seed(SEED)
    rng = np.random.default_rng(SEED)
    R = tier_rows(a.out, tier)
    n = len(R["ts"])
    L = len(TIER_LV[tier])
    nT = len(D.TIERS[tier])
    Tmax = max(D.TIERS[tier])
    grp = D.groups_of(keys)[R["sid"]]
    half = grp % 2
    tsplit = float(np.median(R["ts"]))
    th = (R["ts"] >= tsplit).astype(int)
    preds = {m: np.full((n, L), np.nan, np.float32) for m in MODELS}
    info = {"rows": int(n), "tsplit": int(tsplit), "fits": []}
    for sh in (0, 1):
        for tt in (0, 1):
            te = np.where((half == sh) & (th == tt))[0]
            if len(te) == 0:
                continue
            if tt == 0:
                trm = (half != sh) & (R["ts"] >= tsplit + Tmax * STEP)
            else:
                trm = (half != sh) & (R["ts"] + Tmax * STEP <= tsplit)
            tr_all = np.where(trm)[0]
            va = tr_all[grp[tr_all] == np.min(grp[tr_all])]          # one series group = validation
            tr = tr_all[grp[tr_all] != np.min(grp[tr_all])]
            if len(tr) > MAX_TRAIN:
                tr = rng.choice(tr, MAX_TRAIN, replace=False)
            if len(va) > 60000:
                va = rng.choice(va, 60000, replace=False)
            for m in MODELS:
                t0 = time.time()
                net = make_model(m, len(STATIC) + 2 + nT, L)
                opt = torch.optim.Adam(net.parameters(), lr=1e-3, weight_decay=1e-4)
                best, best_state, bad, ep_done = np.inf, None, 0, 0

                def batches(idx, shuffle):
                    idx = rng.permutation(idx) if shuffle else idx
                    for b0 in range(0, len(idx), 1024):
                        ii = np.sort(idx[b0:b0 + 1024])
                        Hh, Dd, S = build_batch(SA, R["sid"][ii], R["ts"][ii], {k: R[k][ii] for k in STATIC},
                                                R["Tidx"][ii], nT)
                        lf = R["LF"][ii] if m != "nmlp0" else np.zeros((len(ii), L), np.float32)
                        yield (ii, torch.from_numpy(Hh), torch.from_numpy(Dd), torch.from_numpy(S),
                               torch.from_numpy(lf), torch.from_numpy(R["Y"][ii].astype(np.float32)))

                def loss_of(o, y):
                    mk = (y >= 0).float()
                    l_ = torch.nn.functional.binary_cross_entropy_with_logits(o, y.clamp(min=0), reduction="none")
                    return (l_ * mk).sum() / mk.sum()
                for ep in range(6):
                    net.train()
                    for _, h, d, s, lf, y in batches(tr, True):
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
                with torch.no_grad():
                    for ii, h, d, s, lf, y in batches(te, False):
                        p = torch.sigmoid(net(h, d, s, lf)).numpy()
                        preds[m][ii] = np.minimum.accumulate(p, axis=1)
                info["fits"].append({"cell": [sh, tt], "model": m, "train": int(len(tr)), "val": int(len(va)),
                                     "test": int(len(te)), "epochs": ep_done, "val_bce": best,
                                     "sec": round(time.time() - t0, 1)})
                log(f"  {tier} cell ({sh},{tt}) {m}: epochs {ep_done} val {best:.5f} ({time.time() - t0:.0f}s)")
    for jT, T in enumerate(D.TIERS[tier]):
        mk = R["T"] == T
        cols = [TIER_LV[tier].index(k) for k in D.LV[T]]
        out = {"sid": R["sid"][mk], "ts": R["ts"][mk]}
        for m in MODELS:
            out[m] = preds[m][mk][:, cols]
        np.savez_compressed(os.path.join(a.out, f"rows-nn-T{T}.npz"), **out)
    return info


def cmd_fit(a):
    import torch
    torch.set_num_threads(a.threads)
    meta = json.load(open(os.path.join(a.out, "rows-meta.json")))
    keys = meta["series"]
    logf = open(os.path.join(a.out, "nn-log.txt"), "a")

    def log(s):
        line = f"{R12.now_iso()} {s}"
        print(line, flush=True)
        logf.write(line + "\n")
        logf.flush()
    log(f"START r16 nn; code {D.git_sha()}")
    specs = {s["key"]: s for s in R12.dev_specs(a.datasets)}
    SA = {}
    for j, k in enumerate(keys):
        SA[j] = series_arrays(specs[k])
    log(f"  series arrays built ({len(SA)})")
    info = {}
    for tier in a.tiers.split(","):
        info[tier] = run_tier(a, tier, SA, keys, log)
    json.dump({"code": D.git_sha(), "info": info, "finished_utc": R12.now_iso()},
              open(os.path.join(a.out, "nn-meta.json"), "w"), indent=1, default=float)
    log("END nn")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("fit")
    s.add_argument("--datasets", required=True)
    s.add_argument("--out", required=True)
    s.add_argument("--threads", type=int, default=3)
    s.add_argument("--tiers", default="shallow,mid,long")
    a = ap.parse_args()
    {"fit": cmd_fit}[a.cmd](a)


if __name__ == "__main__":
    main()
