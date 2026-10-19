"""Q26 R16 diagnosis: where does the R13.4 standardization (encoder) break exchangeability?

membrane-board design/q26-standardization-diagnosis-2026-10-19.md. Parents: design/Q26_ROUND13_PREREG.md D-R13.4a-c,
D-R13.5c; design/Q26_ROUND15_PREREG.md D-R15.0c; design/q26-r134-event-library-2026-10-18.md.

Owner question (2026-10-19): "Why doesn't the standardization work? Is our transformation faulty?"

DEVELOPMENT ON SEEN DATA ONLY. Inputs are exactly the R13.4 development slices (seen crypto pool = R12 dev pool, B9,
B12, B13a; B3 dev; HistData dev, CFDs truncated at 2017-12-31). No reserved or locked path is opened: the loader
refuses any path containing '/locked'. No blind test is registered or run here.

Subcommands
  encode   re-encode the dev slices with the frozen R13.4 encoder (beta from meta-r134-dev.json) and store, per row and
           horizon, the raw log depth, the baseline scale, the realised forward bar variance and ex-ante extras (long-run
           level, EWMA, close-to-close RV, spike share, vol-of-vol, vol ratio, age). Identity check vs rows-r134-dev.npz.
  pit      PIT / tail-exceedance diagnostics by class, vol-state decile, era, horizon, age; two-way (series x 4-week
           block) CIs; counterfactual decomposition of the cross-group dispersion.
  cv       candidate encoder fixes, cross-validated by series fold x time block (never random rows): cross-group
           dispersion and out-of-sample Brier / log score.
  fh       pooling's shortfall vs (fH) on seen B12/B9: residual decomposition (week effect / series effect / rest),
           Murphy reliability-resolution split, two-way vs series-only information, effective independent events.
  power    two-way-z power projection of the best fix on young crypto for hypothetical future sets (draft only).

Free data only. No address, key or secret is read or written.
"""
from __future__ import annotations

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import hashlib  # noqa: E402
import json  # noqa: E402
import math  # noqa: E402
import sys  # noqa: E402
from datetime import datetime, timezone  # noqa: E402

import numpy as np  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import r134_library as L4  # noqa: E402

DAY = 86400
H_BARS = L4.H_BARS
CLASSES = L4.CLASSES
LR_W, LR_NEED = 252, 20          # long-run level: trailing mean bar variance over up to 252 bars (>= 20 valid)
EW_LAM = 0.94                    # EWMA of bar variance (RiskMetrics)
SPIKE_W, SPIKE_K = 66, 5.0       # spike share: bars in the last 66 with v_b > 5 x M_{b-1}
BLOCK_WEEKS = 4                  # time block for the two-way bootstrap (calendar, shared by all classes)


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def write_json(path, obj):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w") as f:
        json.dump(obj, f, indent=1, sort_keys=True, default=float)


def git_sha():
    return L4.git_sha()


def guard_path(p):
    if "/locked" in os.path.abspath(p).replace("\\", "/"):
        raise SystemExit(f"STOP: refusing to read a locked (reserved) path: {p}")
    return p


# =============================================================================================
# encode
# =============================================================================================
def extra_inputs(B):
    """ex-ante extras per bar t (bars <= t only)."""
    o, h, l, c, valid = B["o"], B["h"], B["l"], B["c"], B["valid"]
    with np.errstate(all="ignore"):
        lc = np.log(c)
        gap = np.where(B["gapok"], np.log(o) - np.r_[np.nan, lc[:-1]], 0.0)
        v = (np.log(h) - np.log(l)) ** 2 / L4.LN2X4 + np.where(np.isfinite(gap), gap, 0.0) ** 2
    v[~valid] = np.nan
    n = len(v)
    M = L4.roll_mean(v, 22, 20)
    LR = L4.roll_mean(v, LR_W, LR_NEED)
    # before 252 bars: expanding mean with >= 20 valid (roll_mean blanks the first w-1 bars)
    f = np.isfinite(v)
    cs = np.cumsum(np.where(f, v, 0.0))
    cn = np.cumsum(f)
    with np.errstate(all="ignore"):
        expd = np.where(cn >= LR_NEED, cs / np.maximum(cn, 1), np.nan)
    LR = np.where(np.isfinite(LR), LR, expd)
    LR[:21] = np.nan
    # EWMA (missing bars skipped), needs 20 valid bars
    ew = np.full(n, np.nan)
    acc, k = np.nan, 0
    for i in range(n):
        if f[i]:
            acc = v[i] if not np.isfinite(acc) else EW_LAM * acc + (1 - EW_LAM) * v[i]
            k += 1
        if k >= 20:
            ew[i] = acc
    # close-to-close RV over 22 bars
    lcv = np.where(valid, lc, np.nan)
    r2 = np.r_[np.nan, np.diff(lcv)] ** 2
    rvcc = L4.roll_mean(r2, 22, 20)
    # spike share
    Mprev = np.r_[np.nan, M[:-1]]
    with np.errstate(all="ignore"):
        sp = np.where(np.isfinite(v) & np.isfinite(Mprev), (v > SPIKE_K * Mprev).astype(float), np.nan)
    spike = L4.roll_mean(sp, SPIKE_W, 40)
    with np.errstate(all="ignore"):
        return {"lnLR": np.log(LR), "lnEW": np.log(np.maximum(ew, L4.VFLOOR * M)), "lnRVcc": np.log(np.maximum(rvcc,
                L4.VFLOOR * M)), "spike": spike}


def load_dev_series(a, log):
    import multiprocessing as mp
    series = []
    specs = L4.crypto_dev_specs(a.datasets, a.acq)
    for _, s in specs:
        for k in ("path",):
            if k in s:
                guard_path(str(s[k]))
    with mp.get_context("fork").Pool(a.workers) as pool:
        for r in pool.imap_unordered(L4._crypto_task, specs, chunksize=4):
            if "err" in r:
                log(f"  crypto load error {r['key']}: {r['err']}")
                continue
            series.append(r)
    b3dir = guard_path(os.path.join(a.data, "b3", "dev"))
    files = sorted(os.listdir(b3dir))
    cal = np.unique(np.concatenate([np.load(os.path.join(b3dir, f))["d"] for f in files]))
    for f in files:
        B = L4.bars_b3(os.path.join(b3dir, f), cal)
        cls, tick = f[:-4].split("-", 1)
        B.update(key=f"b3:{tick}", cls=cls, sub="b3", asset=tick)
        series.append(B)
    hddir = guard_path(os.path.join(a.data, "hd", "dev"))
    for f in sorted(os.listdir(hddir)):
        cls, p = f[:-4].split("-", 1)
        B = L4.bars_hd(os.path.join(hddir, f))
        B.update(key=f"hd:{p}", cls=cls, sub="hd", asset=p)
        series.append(B)
    # deterministic order: the R13.4 meta order
    meta = json.load(open(a.meta))
    order = {m["key"]: i for i, m in enumerate(meta["series"])}
    series = [s for s in series if s["key"] in order]
    series.sort(key=lambda s: order[s["key"]])
    if len(series) != len(meta["series"]):
        raise SystemExit(f"STOP: {len(series)} series loaded, meta has {len(meta['series'])}")
    beta = {int(k): np.array(v) for k, v in meta["beta"].items()}
    return series, beta, meta


FIELDS = ("cls", "sid", "day", "end", "age", "q2", "depth", "lns0", "lnrv", "lnD", "lnW", "lnM", "lnLR", "lnEW",
          "lnRVcc", "spike", "vov", "vr", "lns1")


def cmd_encode(a):
    os.makedirs(a.out, exist_ok=True)
    logf = open(os.path.join(a.out, "encode.log"), "a")

    def log(s):
        line = f"{now_iso()} {s}"
        print(line, flush=True)
        logf.write(line + "\n")
        logf.flush()

    log(f"R16 encode start; code {git_sha()}")
    series, beta, meta = load_dev_series(a, log)
    log("series per class: " + ", ".join(f"{c} {sum(1 for s in series if s['cls'] == c)}" for c in CLASSES))
    rows = {hh: {k: [] for k in FIELDS} for hh in H_BARS}
    for sid, s in enumerate(series):
        E = L4.encode_inputs(s)
        X = E["extra"] = extra_inputs(s)
        with np.errstate(all="ignore"):
            lns1 = 0.5 * (E["X"] @ beta[1])
        for hh in H_BARS:
            F = E["fwd"][hh]
            ok = F["ok"]
            if not ok.any():
                continue
            R = rows[hh]
            n = int(ok.sum())
            with np.errstate(all="ignore"):
                lns0 = 0.5 * (E["X"][ok] @ beta[hh]) + 0.5 * math.log(hh)
                depth = np.log(F["wmin"][ok]) - E["lc"][ok]
                lnrv = np.log(F["rv"][ok])
            R["cls"].append(np.full(n, CLASSES.index(s["cls"]), np.int8))
            R["sid"].append(np.full(n, sid, np.int32))
            R["day"].append(s["d"][ok].astype(np.int32))
            R["end"].append(F["end_day"][ok].astype(np.int32))
            R["age"].append(np.asarray(E["age"])[ok].astype(np.int32))
            R["q2"].append(L4.q2_overlap(s["d"][ok], F["end_day"][ok]))
            R["depth"].append(depth)
            R["lns0"].append(lns0)
            R["lnrv"].append(lnrv)
            R["lnD"].append(E["X"][ok, 1])
            R["lnW"].append(E["X"][ok, 2])
            R["lnM"].append(E["X"][ok, 3])
            for k in ("lnLR", "lnEW", "lnRVcc", "spike"):
                R[k].append(X[k][ok])
            R["vov"].append(E["vov"][ok])
            R["vr"].append(E["vr"][ok])
            R["lns1"].append(lns1[ok])
        del E
    out = {}
    for hh in H_BARS:
        for k, v in rows[hh].items():
            v = np.concatenate(v)
            if v.dtype == np.float64 and k not in ("depth", "lns0"):
                v = v.astype(np.float32)
            out[f"h{hh}_{k}"] = v
    # identity check vs the published R13.4 encoding
    ref = np.load(a.ref_rows) if a.ref_rows else None
    chk = {}
    for hh in H_BARS:
        m = out[f"h{hh}_depth"] / np.exp(out[f"h{hh}_lns0"])
        if ref is not None:
            mr = ref[f"h{hh}_m"]
            chk[hh] = {"rows": int(len(m)), "rows_ref": int(len(mr)),
                       "max_abs_diff": float(np.max(np.abs(m - mr))) if len(m) == len(mr) else None}
        log(f"h={hh}: rows {len(m)}; identity vs R13.4 rows: {chk.get(hh)}")
    np.savez(os.path.join(a.out, "rows-r16.npz"), **out)
    write_json(os.path.join(a.out, "encode-r16.json"), {"created_utc": now_iso(), "code_sha": git_sha(),
               "identity_vs_r134": chk, "beta": {str(k): v.tolist() for k, v in beta.items()},
               "series": [{"key": s["key"], "cls": s["cls"], "sub": s["sub"]} for s in series]})
    log("encode done")


# =============================================================================================
# shared helpers
# =============================================================================================
class Rows:
    def __init__(self, path, meta_path, hh):
        z = np.load(path)
        self.h = hh
        for k in FIELDS:
            setattr(self, k, z[f"h{hh}_{k}"])
        keep = ~self.q2 & np.isfinite(self.lnrv) & np.isfinite(self.lnLR)
        for k in FIELDS:
            setattr(self, k, getattr(self, k)[keep])
        meta = json.load(open(meta_path))["series"]
        self.keys = np.array([m["key"] for m in meta])
        self.subs = np.array([m["sub"] for m in meta])
        self.n = len(self.depth)
        self.m0 = self.depth / np.exp(self.lns0)
        self.week = L4.week_of(self.day)
        self.block = (self.week // BLOCK_WEEKS).astype(np.int64)
        self.year = (1970 + (self.day.astype(np.int64) / 365.2425)).astype(int)
        # vol state: ex-ante 1-bar sigma-hat relative to the series' long-run level (ln units)
        self.vstate = (self.lns1 - 0.5 * self.lnLR).astype(np.float64)


def cls_weights(cls, mask=None):
    """class-equal weights (each class sums to 1 over mask rows)."""
    w = np.zeros(len(cls))
    mk = np.ones(len(cls), bool) if mask is None else mask
    for ci in range(len(CLASSES)):
        sel = mk & (cls == ci)
        n = int(sel.sum())
        if n >= 1000:
            w[sel] = 1.0 / n
    return w


def lib_from(m, w):
    ok = w > 0
    return L4.wecdf(m[ok], w[ok])


def F_at(lib, z):
    return L4.wecdf_at(lib, z)


def twoway_var(si, bi, num, den, nb, seed, mode="two"):
    import r135_young as Y5
    su, s_ = np.unique(si, return_inverse=True)
    bu, b_ = np.unique(bi, return_inverse=True)
    d = Y5.boot_twoway(s_, b_, num, den, len(su), len(bu), nb, seed, mode)
    return d


def group_ratio_ci(si, bi, y, p, nb, seed):
    """ln(sum y / sum p) with a two-way bootstrap 90% CI and SE."""
    Y = y.sum()
    P = p.sum()
    if Y <= 0 or P <= 0:
        return {"lnR": None, "pos": int(Y), "rows": int(len(y))}
    d = twoway_var(si, bi, y.astype(float), p.astype(float), nb, seed)
    lr = np.log(np.maximum(d, 1e-12))
    return {"lnR": float(math.log(Y / P)), "R": float(Y / P), "se": float(np.std(lr)),
            "lo90": float(math.exp(np.quantile(lr, 0.05))), "hi90": float(math.exp(np.quantile(lr, 0.95))),
            "pos": int(Y), "rows": int(len(y)), "series": int(len(np.unique(si))), "blocks": int(len(np.unique(bi)))}


def excess_dispersion(stats):
    """between-group SD of true ln R (DerSimonian-Laird tau) from per-group lnR and SE (groups with >= 10 pos)."""
    x = np.array([s["lnR"] for s in stats if s.get("lnR") is not None and s["pos"] >= 10 and s["se"] > 0])
    se = np.array([s["se"] for s in stats if s.get("lnR") is not None and s["pos"] >= 10 and s["se"] > 0])
    if len(x) < 2:
        return None
    w = 1 / se ** 2
    mu = np.sum(w * x) / np.sum(w)
    Q = float(np.sum(w * (x - mu) ** 2))
    k = len(x)
    c = np.sum(w) - np.sum(w ** 2) / np.sum(w)
    tau2 = max(0.0, (Q - (k - 1)) / c)
    from scipy.stats import chi2
    return {"tau": float(math.sqrt(tau2)), "Q": Q, "df": k - 1, "p": float(chi2.sf(Q, k - 1)),
            "sd_raw": float(np.std(x)), "groups": k}


def groupings(R):
    g = {}
    g["class"] = R.cls.astype(np.int64)
    qs = np.quantile(R.vstate, np.linspace(0.1, 0.9, 9))
    g["vstate_decile"] = np.digitize(R.vstate, qs)
    era_edges = [2008, 2012, 2016, 2018, 2020, 2021, 2022, 2023, 2024, 2025]
    g["era"] = np.digitize(R.year, era_edges)
    age_edges = [90, 180, 365, 730, 1460, 2920]
    g["age"] = np.digitize(R.age, age_edges)
    return g, {"vstate_cuts": qs.tolist(), "era_edges": era_edges, "age_edges": age_edges}


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("encode")
    p.add_argument("--datasets", default="/home/user/membrane-datasets")
    p.add_argument("--data", default="/home/user/r13work/r134/data")
    p.add_argument("--acq", default="/home/user/r13work/r134/dev-cad651e9/acq_r12")
    p.add_argument("--meta", default="/home/user/r13work/r134/dev-cad651e9/meta-r134-dev.json")
    p.add_argument("--ref-rows", default="/home/user/r13work/r134/dev-cad651e9/rows-r134-dev.npz")
    p.add_argument("--out", required=True)
    p.add_argument("--workers", type=int, default=4)
    for nm in ("pit", "pitnet", "cv", "fh", "power"):
        p = sub.add_parser(nm)
        p.add_argument("--rows", required=True)
        p.add_argument("--meta", required=True)
        p.add_argument("--out", required=True)
        p.add_argument("--nb", type=int, default=1000)
        p.add_argument("--fh", default="/home/user/membrane-datasets/history-forecasts/r13/r134-dev-cad651e9/"
                                        "fh-r134.npz")
        p.add_argument("--cv", default="")
    a = ap.parse_args()
    if a.cmd == "encode":
        return cmd_encode(a)
    import r16_diag_an as AN  # analysis stages live in a sibling module
    {"pit": AN.cmd_pit, "pitnet": AN.cmd_pitnet, "cv": AN.cmd_cv, "fh": AN.cmd_fh, "power": AN.cmd_power}[a.cmd](a)


if __name__ == "__main__":
    main()
