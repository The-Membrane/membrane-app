"""Q26 R11.10 P3: (fH) at 1 h, 3 h and 12 h -- transfer test on blind8 (56 Binance USDT spot pairs first listed in 2024).

membrane-board design/Q26_ROUND11_PREREG.md, Deviations D-R11.10e (registration and readings, before any blind8 read),
D-R11.10f (result). Inventory: design/q26-blind-set-inventory-2026-10-17.md set P3.

  python3 r1110_p3.py power   --datasets DS --out OUT
        development power only (ETH dev span, already seen): days to 80% power at HAC lag 168 h and 24 h.
  python3 r1110_p3.py acquire --datasets DS --acq ACQ --work WORK
        outcome-blind builder: the 56 pairs from blind7-prices/binance-selection.json (first kline in 2024, not
        excluded); Binance public bulk monthly 1 h klines (data.binance.vision) 2024-01..2026-09, each zip checked
        against its published .CHECKSUM; hourly grids + manifest. Prints counts only.
  python3 r1110_p3.py counts  --acq ACQ --out OUT
        counts-only check (null hours, folds, labelled / HAR-defined / validated origin counts). No label value,
        no price statistic, no forecast.
  python3 r1110_p3.py freeze  --acq ACQ --out OUT
  python3 r1110_p3.py run     --acq ACQ --out OUT

Recipe: r1110_blind.fold_rungs / build_rungs unchanged ((fH) with the (f) fallback, (f), (a); running minimum).
No address is read or written.
"""
from __future__ import annotations

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import csv  # noqa: E402
import gzip  # noqa: E402
import hashlib  # noqa: E402
import io  # noqa: E402
import json  # noqa: E402
import math  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402
import urllib.error  # noqa: E402
import urllib.request  # noqa: E402
import zipfile  # noqa: E402
from datetime import datetime, timezone  # noqa: E402

import numpy as np  # noqa: E402
from scipy.stats import norm  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import a_touch as A  # noqa: E402
import a3_touch as M3  # noqa: E402
import a6_touch as A6  # noqa: E402
import r112_combine as R112  # noqa: E402
import r1110_blind as RB  # noqa: E402

PREREG = {"repo": "triccs/membrane-board", "path": "design/Q26_ROUND11_PREREG.md", "item": "R11.10 P3",
          "deviations": "D-R11.10e (registration, readings), D-R11.10f (result)"}
STEP, DAY, WEEK = 3600, 86400, 7 * 86400
HORIZONS = RB.HORIZONS
TL = RB.TL
LEVELS = RB.LEVELS
K = len(LEVELS)
CELLS = RB.CELLS
RUNGS = RB.RUNGS
ALPHA = RB.ALPHA
POWER = RB.POWER
R_BAND = RB.R_BAND
HAC_LAG = 168                      # >= 24 h (D-R11.10d rule); one week
N_BOOT = 10000
SEED = 20261110
VOLCHG = (24, 336)                 # regime split: ln(24 h / 336 h Parkinson mean)
TOP_Q = 0.90

CUT_LO = A.utc("2024-01-01T00:00:00Z")
CUT_HI = A.utc("2025-01-01T00:00:00Z")
END = A.utc("2026-10-01T00:00:00Z")            # grid ends with the kline opening 2026-09-30T23:00Z
Q2_START, Q2_END = A.utc("2026-04-01T00:00:00Z"), A.utc("2026-07-01T00:00:00Z")
LAST_FOLD = (2026, 3)
WARMUP_DAYS = 365
SEL_PATH = "blind7-prices/binance-selection.json"
BULK = "https://data.binance.vision/data/spot/monthly/klines/{s}/1h/{s}-1h-{y:04d}-{m:02d}.zip"
UA = {"User-Agent": "membrane-research/1.0"}

DECISIONS = {
    "P3-1": "Pairs: every row of blind7-prices/binance-selection.json with first 1 h kline in [2024-01-01, "
            "2025-01-01) and no exclusion (56). Excluded by the inherited rules: BNSOLUSDT (wrapped/staked), "
            "EURIUSDT (stablecoin/fiat/pegged). A pair with no bulk file at all is dropped and listed (availability, "
            "not outcome).",
    "P3-2": "Data: Binance public bulk monthly 1 h spot klines (data.binance.vision), months from the first-kline "
            "month to 2026-09; every zip's sha256 must equal its published .CHECKSUM, else STOP. A month with no "
            "file (404) is recorded; its hours are null. Open times in microseconds (from 2025-01) are converted. "
            "Grid: index i = kline opening start + 3600 i, from the first kline to the kline opening "
            "2026-09-30T23:00Z; missing hours null in every column; no forward fill, no outlier filter (printed "
            "klines are truth, A6 D2).",
    "P3-3": "Recipe frozen: r1110_blind.fold_rungs/build_rungs unchanged ((fH) = A6 D-H4 horizon-matched HAR with "
            "the (f) fallback; (f) = FHS with sigma_hat EWMA; (a) = expanding frequency to Q_start - T); running "
            "minimum across levels; the ETH ladder; scored cells = the R11.2 cell lists; A3.1 null-hour rule.",
    "P3-4": "Warm-up and folds (A6.6): per pair, quarterly folds from the first calendar quarter starting >= 365 d "
            "after the first kline to 2026Q3; training expands from the grid start. Origins whose window (t, t+T] "
            "meets 2026-04-01..2026-06-30 are reported only (Round 11 rule 6). Validated: t + T <= 2026-10-01, "
            "outside 2026Q2 windows, label defined, all rungs finite.",
    "P3-5": "Pooled test per T vs (f) and vs (a): d = per-origin mean over the scored cells of (p_fH - y)^2 - "
            "(p_cmp - y)^2. (i) pair-clustered HAC: hourly cross-pair sums u_t = sum_p d_pt - m n_t on the full "
            "hourly grid, Newey-West Bartlett lag 168 h, z = m / sqrt(H LRV) * sum n, normal one-sided p. (ii) weekly "
            "block bootstrap: calendar weeks (Monday 00:00Z) with all pairs, 10,000 resamples, seed 20261110, "
            "ratio mean, p = (1 + #{m* - m <= m}) / (B + 1). Pass at T: mean d < 0 and BOTH p < 0.05/3 vs (f) AND vs "
            "(a), AND pooled R(fH) = sum p / sum y over scored rows in [0.8, 1.25].",
    "P3-6": "Regime split (pre-declared, reported): x(t) = ln(mean Parkinson var over the last 24 h / over the "
            "last 336 h) at the origin (A6 null rule per window). Top decile = x above the pair's own 90th "
            "percentile over its validated origins at T; rest = the other rows with x defined. Per group: pooled "
            "BSS vs (f) and (a), HAC and bootstrap p; difference mean d_top - mean d_rest by the same weekly "
            "bootstrap (one-sided, top more negative). The reading '(fH) adapts faster than (f) in vol shifts' is "
            "supported when top-decile d vs (f) < 0 with both p < 0.05 and the difference p < 0.05.",
    "P3-7": "Reported only: per-pair BSS, R and single-pair HAC p (lag 168); per-month and per-fold pooled R and "
            "BSS; per vol regime; all ten levels; 2026Q2 windows; (f) fallback rows; CORP; look-ahead check.",
}


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def write_json(path, obj):
    return R112.write_json(path, obj)


# ---------------------------------------------------------------------------------------------
# statistics
# ---------------------------------------------------------------------------------------------
def pooled_hac(ts, d, L=HAC_LAG):
    """pair-clustered (all pairs in one hour form one cluster) Newey-West test of the pooled mean of d."""
    ts = np.asarray(ts, np.int64)
    d = np.asarray(d, float)
    n = len(d)
    if n < 3:
        return {"n": n, "mean_diff": None, "z": None, "p_one_sided": None}
    t0 = int(ts.min())
    h = (ts - t0) // STEP
    H = int(h.max()) + 1
    S = np.bincount(h, weights=d, minlength=H)
    N = np.bincount(h, minlength=H).astype(float)
    m = float(S.sum() / N.sum())
    u = S - m * N
    lrv = A6.nw_lrv(u, L)
    var = H * lrv / (N.sum() ** 2)
    z = m / math.sqrt(var) if var > 0 else None
    return {"n": n, "hours": H, "lag": L, "mean_diff": m, "z": z,
            "p_one_sided": float(norm.cdf(z)) if z is not None else None}


def week_sums(ts, d):
    w = (np.asarray(ts, np.int64) - A.utc("2023-01-02T00:00:00Z")) // WEEK
    u, inv = np.unique(w, return_inverse=True)
    return np.bincount(inv, weights=d), np.bincount(inv).astype(float), u


def boot_draws(n_weeks, rng, B=N_BOOT):
    return rng.integers(0, n_weeks, size=(B, n_weeks))


def week_boot(ts, d, idx_draws):
    Wd, Wn, _ = week_sums(ts, d)
    m = float(Wd.sum() / Wn.sum())
    ms = Wd[idx_draws].sum(axis=1) / Wn[idx_draws].sum(axis=1)
    p = (1 + int(np.sum(ms - m <= m))) / (len(ms) + 1)
    return {"weeks": int(len(Wd)), "mean_diff": m, "p_one_sided": float(p), "B": int(len(ms))}


def boot_for(ts, d, seed_off):
    rng = np.random.default_rng(np.random.SeedSequence([SEED, seed_off]))
    Wd, _, _ = week_sums(ts, d)
    return week_boot(ts, d, boot_draws(len(Wd), rng))


def boot_diff(ts, d, grp, seed_off):
    """weekly bootstrap of mean(d | grp) - mean(d | ~grp); one-sided p that the difference is < 0."""
    w = (np.asarray(ts, np.int64) - A.utc("2023-01-02T00:00:00Z")) // WEEK
    u, inv = np.unique(w, return_inverse=True)
    W = len(u)
    a1 = np.bincount(inv, weights=np.where(grp, d, 0.0), minlength=W)
    n1 = np.bincount(inv, weights=grp.astype(float), minlength=W)
    a0 = np.bincount(inv, weights=np.where(grp, 0.0, d), minlength=W)
    n0 = np.bincount(inv, weights=(~grp).astype(float), minlength=W)
    diff = a1.sum() / n1.sum() - a0.sum() / n0.sum()
    rng = np.random.default_rng(np.random.SeedSequence([SEED, seed_off]))
    ix = boot_draws(W, rng)
    ds = a1[ix].sum(1) / n1[ix].sum(1) - a0[ix].sum(1) / n0[ix].sum(1)
    p = (1 + int(np.sum(ds - diff <= diff))) / (len(ds) + 1)
    return {"diff": float(diff), "p_one_sided": float(p), "weeks": int(W)}


# ---------------------------------------------------------------------------------------------
# power (development data only)
# ---------------------------------------------------------------------------------------------
def cmd_power(a):
    t0 = time.time()
    ser, oser = R112.build_series(a.datasets)
    folds = M3.dev_folds(ser)
    B = RB.build_rungs(ser, oser, folds)
    out = {"schema": "q26-r1110p3/power-dev/1", "created_utc": now_iso(), "code_sha": R112.git_sha(),
           "clean": R112.git_clean(), "note": "ETH development data only (already seen); single-series days. "
           "Pooled blind8 needs between days/56 (independent pairs) and days (perfectly correlated pairs).",
           "alpha_one_sided": ALPHA, "power": POWER, "horizons": {}}
    for T in HORIZONS:
        b = B[T]
        ts = b["ts"]
        win_q2 = (ts + T * STEP > RB.Q2_START) & (ts < RB.Q2_END)
        vo = ~win_q2 & (ts <= RB.DEV_LAST_ORIGIN)
        fin = np.isfinite(b["Y"]) & np.all(np.stack([np.isfinite(b["P"][r]) for r in RUNGS]), axis=0)
        vo = vo & np.all(fin, axis=1)
        cell = np.array([k in CELLS[T] for k in LEVELS])
        V = vo[:, None] & cell[None, :]
        o, po = RB.per_origin(b["P"], b["Y"], V)
        br = {r: float(np.mean((b["P"][r][V] - b["Y"][V]) ** 2)) for r in RUNGS}
        hz = {"origins": int(o.sum()), "bss_vs_f": 1 - br["fH"] / br["f"], "bss_vs_a": 1 - br["fH"] / br["a"]}
        for L in (HAC_LAG, 24, T - 1):
            hz[f"lag{L}"] = {c: RB.days_to_power(po["fH"] - po[c], L) for c in ("f", "a")}
        out["horizons"][TL[T]] = hz
        print(TL[T], json.dumps({"origins": hz["origins"], "bss_vs_f": round(hz["bss_vs_f"], 4),
                                 "bss_vs_a": round(hz["bss_vs_a"], 4),
                                 **{f"days_{c}_lag{L}": (None if hz[f"lag{L}"][c]["days"] is None
                                                         else round(hz[f"lag{L}"][c]["days"]))
                                    for L in (HAC_LAG, 24, T - 1) for c in ("f", "a")}}))
    out["runtime_s"] = time.time() - t0
    os.makedirs(a.out, exist_ok=True)
    print("power-dev sha256", write_json(os.path.join(a.out, "power-dev-r1110p3.json"), out))


# ---------------------------------------------------------------------------------------------
# acquire (outcome-blind; prints counts only)
# ---------------------------------------------------------------------------------------------
def select_pairs(datasets):
    sel = json.load(open(os.path.join(datasets, SEL_PATH)))
    rows = [r for r in sel["window"] if CUT_LO <= r["firstKlineOpenTs"] < CUT_HI]
    kept = sorted((r for r in rows if r["excluded"] is None), key=lambda r: r["symbol"])
    excl = [{"symbol": r["symbol"], "reason": r["excluded"], "firstKlineOpen": r["firstKlineOpen"]}
            for r in rows if r["excluded"] is not None]
    return kept, excl, R112.sha256_file(os.path.join(datasets, SEL_PATH))


def http_get(url, tries=6):
    last = None
    for k in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            last = repr(e)
        except Exception as e:      # retried
            last = repr(e)
        time.sleep(2.0 * (k + 1))
    raise SystemExit(f"STOP: request failed after {tries} tries: {last}")


def months(first_ts):
    d = datetime.fromtimestamp(first_ts, tz=timezone.utc)
    y, m = d.year, d.month
    while (y, m) <= (2026, 9):
        yield y, m
        y, m = (y, m + 1) if m < 12 else (y + 1, 1)


def to_sec(t):
    t = int(t)
    if t > 10 ** 14:
        return t // 1_000_000
    return t // 1000


def cmd_acquire(a):
    os.makedirs(a.acq, exist_ok=True)
    os.makedirs(a.work, exist_ok=True)
    t_start = now_iso()
    kept, excl, sel_sha = select_pairs(a.datasets)
    if len(kept) != 56:
        raise SystemExit(f"STOP: {len(kept)} pairs, registered 56")
    man = {"schema": "q26-r1110p3/acquire/1", "started_utc": t_start, "code_sha": R112.git_sha(),
           "selection": {"path": SEL_PATH, "sha256": sel_sha, "pairs": [r["symbol"] for r in kept],
                         "excluded": excl}, "source": "data.binance.vision spot monthly klines 1h (free, public, "
           "published .CHECKSUM sha256 per zip)", "pairs": {}, "dropped": []}
    for r in kept:
        s = r["symbol"]
        first = int(r["firstKlineOpenTs"])
        files, rows = [], {}
        for y, m in months(first):
            url = BULK.format(s=s, y=y, m=m)
            zp = os.path.join(a.work, f"{s}-1h-{y:04d}-{m:02d}.zip")
            ck = http_get(url + ".CHECKSUM")
            if ck is None:
                files.append({"month": f"{y:04d}-{m:02d}", "status": "missing"})
                continue
            want = ck.decode().split()[0].lower()
            body = open(zp, "rb").read() if os.path.exists(zp) else None
            if body is None or hashlib.sha256(body).hexdigest() != want:
                body = http_get(url)
                if body is None:
                    raise SystemExit(f"STOP: {s} {y}-{m}: CHECKSUM present but zip missing")
                with open(zp, "wb") as f:
                    f.write(body)
            got = hashlib.sha256(body).hexdigest()
            if got != want:
                raise SystemExit(f"STOP: {s} {y}-{m}: sha256 differs from the published CHECKSUM")
            with zipfile.ZipFile(io.BytesIO(body)) as z:
                names = z.namelist()
                txt = z.read(names[0]).decode()
            n = 0
            for ln in txt.splitlines():
                p = ln.split(",")
                if not p or not p[0].strip().isdigit():
                    continue
                t = to_sec(p[0])
                if t % STEP:
                    raise SystemExit(f"STOP: {s} off-grid open time")
                rows[t] = (p[1], p[2], p[3], p[4], p[5])
                n += 1
            files.append({"month": f"{y:04d}-{m:02d}", "status": "ok", "sha256": got, "checksum_published": want,
                          "bytes": len(body), "klines": n})
            time.sleep(0.05)
        if not rows:
            man["dropped"].append({"symbol": s, "reason": "no bulk file"})
            continue
        st = min(rows)
        if st < first:
            raise SystemExit(f"STOP: {s} kline before the recorded first kline")
        n = (END - st) // STEP
        cols = {c: [None] * n for c in ("open", "high", "low", "close", "volume")}
        late = 0
        for t, v in rows.items():
            i = (t - st) // STEP
            if i >= n:
                late += 1
                continue
            for c, x in zip(("open", "high", "low", "close", "volume"), v):
                cols[c][i] = float(x)
        grid = {"asset": s, "source": "binance bulk spot 1h klines (data.binance.vision)", "startTs": st,
                "stepSeconds": STEP, "count": n, "columns": cols}
        gp = os.path.join(a.acq, f"binance-{s}-1h.json.gz")
        with gzip.GzipFile(gp, "wb", mtime=0) as f:
            f.write(json.dumps(grid, separators=(",", ":")).encode())
        nn = sum(1 for x in cols["close"] if x is None)
        man["pairs"][s] = {"first_kline_selection": r["firstKlineOpen"], "grid_start_utc": A.iso(st),
                           "hours": n, "null_hours": nn, "months": len(files),
                           "months_missing": sum(1 for f in files if f["status"] == "missing"),
                           "file": os.path.basename(gp), "sha256": R112.sha256_file(gp), "bulk_files": files}
        print(f"{s}: hours {n}, null {nn}, months {len(files)}", flush=True)
    man["finished_utc"] = now_iso()
    man["status"] = "LOCKED for R11.10 P3 (D-R11.10e)"
    h = write_json(os.path.join(a.acq, "manifest-acquire.json"), man)
    print(json.dumps({"pairs": len(man["pairs"]), "dropped": man["dropped"], "manifest_sha256": h}))


# ---------------------------------------------------------------------------------------------
# series and folds
# ---------------------------------------------------------------------------------------------
def load_pair(acq, sym):
    g = json.loads(gzip.decompress(open(os.path.join(acq, f"binance-{sym}-1h.json.gz"), "rb").read()))
    st = int(g["startTs"])
    cols = {k: np.array([np.nan if v is None else float(v) for v in g["columns"][k]], float)
            for k in ("close", "low", "high")}
    ser = M3.S3(f"blind8:{sym}", sym, "binance", cols["close"], cols["low"], LEVELS, st, st)
    A6.attach_high(ser, cols["high"])
    return ser


def pair_folds(ser):
    return M3.quarters(M3.first_quarter_after(ser.base_ts, WARMUP_DAYS), LAST_FOLD, ser)


def volchg(ser):
    v = A6.parkinson_v(ser.high, ser.low)
    a24 = A6.window_mean_null_rule(v, VOLCHG[0], ser.start_i)
    a336 = A6.window_mean_null_rule(v, VOLCHG[1], ser.start_i)
    with np.errstate(invalid="ignore", divide="ignore"):
        x = 0.5 * np.log(a24 / a336)
    x[~np.isfinite(x)] = np.nan
    return x


def masks(ts, T):
    q2 = (ts + T * STEP > Q2_START) & (ts < Q2_END)
    inwin = ts + T * STEP <= END
    return inwin & ~q2, inwin & q2


def cmd_counts(a):
    man = json.load(open(os.path.join(a.acq, "manifest-acquire.json")))
    out = {"schema": "q26-r1110p3/counts/1", "created_utc": now_iso(), "note": "counts only: no label value, no "
           "price statistic, no forecast", "pairs": {}, "totals": {}}
    tot = {TL[T]: {"validated_eligible": 0, "q2_reported": 0, "har_defined": 0, "pair_days": 0.0} for T in HORIZONS}
    for s in man["pairs"]:
        ser = load_pair(a.acq, s)
        folds = pair_folds(ser)
        pr = {"grid_start": A.iso(ser.base_ts), "hours": int(ser.N), "null_hours": int((~np.isfinite(ser.close)).sum()),
              "folds": [f["name"] for f in folds], "by_T": {}}
        for T in HORIZONS:
            P6 = A6.Prep6(ser, T, with_fbL=False)
            lab = P6.P.lab_ok
            n = len(lab)
            idx = np.arange(n)
            ts = ser.base_ts + STEP * idx
            tst = (idx >= folds[0]["qs_i"]) if folds else np.zeros(n, bool)
            ok, q2 = masks(ts, T)
            e = tst & ok & lab & np.isfinite(ser.sigma[:n])
            pr["by_T"][TL[T]] = {"test_origins": int((tst & ok).sum()), "label_defined": int((tst & ok & lab).sum()),
                                 "eligible_label_and_sigma": int(e.sum()), "har_defined": int((e & P6.okX).sum()),
                                 "q2_reported_label_defined": int((tst & q2 & lab).sum()),
                                 "first_fold_har_regression_origins": int(P6.cum_nH[max(folds[0]["qs_i"] - T, 0)])
                                 if folds else None}
            tot[TL[T]]["validated_eligible"] += int(e.sum())
            tot[TL[T]]["q2_reported"] += int((tst & q2 & lab).sum())
            tot[TL[T]]["har_defined"] += int((e & P6.okX).sum())
        out["pairs"][s] = pr
    for T in HORIZONS:
        tot[TL[T]]["pair_days"] = tot[TL[T]]["validated_eligible"] / 24.0
    out["totals"] = tot
    out["n_pairs"] = len(out["pairs"])
    out["n_pairs_with_folds"] = sum(1 for p in out["pairs"].values() if p["folds"])
    os.makedirs(a.out, exist_ok=True)
    h = write_json(os.path.join(a.out, "counts-r1110p3.json"), out)
    print(json.dumps({"n_pairs": out["n_pairs"], "with_folds": out["n_pairs_with_folds"], "totals": tot}, indent=1))
    print("counts sha256", h)


# ---------------------------------------------------------------------------------------------
# freeze and run
# ---------------------------------------------------------------------------------------------
def cmd_freeze(a):
    os.makedirs(a.out, exist_ok=True)
    path = os.path.join(a.out, "frozen-r1110p3-config.json")
    if os.path.exists(path):
        raise SystemExit("STOP: frozen config exists")
    if not R112.git_clean():
        raise SystemExit("STOP: code tree not clean")
    man = json.load(open(os.path.join(a.acq, "manifest-acquire.json")))
    inputs = {"manifest": {"path": "acq/manifest-acquire.json",
                           "sha256": R112.sha256_file(os.path.join(a.acq, "manifest-acquire.json"))},
              "counts": {"path": "acq/counts-r1110p3.json",
                         "sha256": R112.sha256_file(os.path.join(a.acq, "counts-r1110p3.json"))}}
    for s, v in man["pairs"].items():
        inputs[s] = {"path": f"acq/{v['file']}", "sha256": R112.sha256_file(os.path.join(a.acq, v["file"]))}
    cfg = {"schema": "q26-r1110p3/frozen-config/1", "created_utc": now_iso(), "prereg": PREREG,
           "code": {"repo": "The-Membrane/membrane-app", "sha": R112.git_sha(),
                    "path": "scripts/research/history-forecasts/r1110_p3.py",
                    "sha256": R112.sha256_file(os.path.abspath(__file__)),
                    "recipe_sha256": R112.sha256_file(os.path.abspath(RB.__file__)), "clean": R112.git_clean()},
           "inputs": inputs, "pairs": sorted(man["pairs"]),
           "constants": {"horizons_h": list(HORIZONS), "levels": list(LEVELS),
                         "cells_scored": {TL[T]: list(v) for T, v in CELLS.items()}, "alpha_one_sided": ALPHA,
                         "R_band": list(R_BAND), "hac_lag_h": HAC_LAG, "n_boot": N_BOOT, "seed": SEED,
                         "volchg_windows_h": list(VOLCHG), "top_quantile": TOP_Q, "end": A.iso(END),
                         "q2_reported": [A.iso(Q2_START), A.iso(Q2_END)], "warmup_days": WARMUP_DAYS,
                         "last_fold": "2026Q3"},
           "decisions": DECISIONS}
    h = write_json(path, cfg)
    print(json.dumps({"frozen_config_sha256": h, "created_utc": cfg["created_utc"], "code": cfg["code"]["sha"]}))


def reduce_pair(ser, folds, T, B):
    """per-origin rows of one pair at T (validated and Q2-reported), plus all-level sums."""
    b = B[T]
    ts = b["ts"]
    ok, q2 = masks(ts, T)
    P, Y = b["P"], b["Y"]
    fin = np.isfinite(Y) & np.all(np.stack([np.isfinite(P[r]) for r in RUNGS]), axis=0)
    allfin = np.all(fin, axis=1)
    cell = np.array([k in CELLS[T] for k in LEVELS])
    x = volchg(ser)[b["te"]]
    out = {}
    for nm, vm in (("val", ok & allfin), ("q2", q2 & allfin)):
        V = vm[:, None] & cell[None, :]
        o, po = RB.per_origin(P, Y, V)
        idx = np.where(vm)[0]
        Yv = np.nan_to_num(Y[idx][:, cell])
        out[nm] = {"ts": ts[idx], "fold": np.array([b["fold_names"][f] for f in b["fold"][idx]]),
                   "regime": b["regime"][idx], "x": x[idx],
                   "se": {r: po[r] for r in RUNGS}, "sy": Yv.sum(1),
                   "sp": {r: P[r][idx][:, cell].sum(1) for r in RUNGS},
                   "rows_p": {r: P[r][idx][:, cell].ravel() for r in RUNGS}, "rows_y": Yv.ravel()}
    vm = ok & allfin
    lv = {}
    for k in range(K):
        yk = Y[vm, k]
        lv[repr(LEVELS[k])] = {"rows": int(vm.sum()), "sum_y": float(yk.sum()),
                               "sum_p": {r: float(P[r][vm, k].sum()) for r in RUNGS},
                               "sse": {r: float(((P[r][vm, k] - yk) ** 2).sum()) for r in RUNGS}}
    out["levels"] = lv
    out["fallback_rows"] = {f: v["fH_fallback_rows"] for f, v in b["fits"].items()}
    return out


def group_stats(ts, se, sy, sp, ncell, seed_off, with_boot=True):
    """pooled stats of a set of per-origin rows."""
    res = {"origins": int(len(ts))}
    if len(ts) < 3:
        return res
    br = {r: float(se[r].mean()) for r in RUNGS}
    res["brier"] = br
    res["bss_vs_f"] = 1 - br["fH"] / br["f"]
    res["bss_vs_a"] = 1 - br["fH"] / br["a"]
    s = float(sy.sum())
    res["R"] = {r: (float(sp[r].sum()) / s if s > 0 else None) for r in RUNGS}
    res["sum_y"] = s
    res["hac"] = {c: pooled_hac(ts, se["fH"] - se[c]) for c in ("f", "a")}
    if with_boot:
        res["boot"] = {c: boot_for(ts, se["fH"] - se[c], seed_off + j) for j, c in enumerate(("f", "a"))}
    return res


def cat(parts, key, sub=None):
    if sub is None:
        return np.concatenate([p[key] for p in parts]) if parts else np.array([])
    return {r: np.concatenate([p[key][r] for p in parts]) for r in RUNGS}


def lookahead_check(acq, sym, log):
    """perturb every price from a cut hour on; forecasts at origins <= cut must not change (reported)."""
    out = []
    ser = load_pair(acq, sym)
    folds = pair_folds(ser)
    B0 = RB.build_rungs(ser, ser, folds)
    for frac in (0.5, 0.8):
        cut = int(ser.N * frac)
        g = json.loads(gzip.decompress(open(os.path.join(acq, f"binance-{sym}-1h.json.gz"), "rb").read()))
        cols = {k: np.array([np.nan if v is None else float(v) for v in g["columns"][k]], float)
                for k in ("close", "low", "high")}
        rng = np.random.default_rng(SEED + cut)
        f = np.exp(rng.normal(0, 0.05, ser.N - cut))
        for k in cols:
            cols[k][cut:] = cols[k][cut:] * f
        s2 = M3.S3(f"blind8:{sym}", sym, "binance", cols["close"], cols["low"], LEVELS, ser.base_ts, ser.base_ts)
        A6.attach_high(s2, cols["high"])
        B1 = RB.build_rungs(s2, s2, folds)
        md = 0.0
        for T in HORIZONS:
            m = B0[T]["te"] <= cut
            for r in RUNGS:
                a0, a1 = B0[T]["P"][r][m], B1[T]["P"][r][m]
                both = np.isfinite(a0) & np.isfinite(a1)
                if (np.isfinite(a0) != np.isfinite(a1)).any():
                    md = float("inf")
                elif both.any():
                    md = max(md, float(np.abs(a0[both] - a1[both]).max()))
        out.append({"pair": sym, "cut_utc": A.iso(ser.base_ts + STEP * cut), "max_abs_diff": md})
        log(f"lookahead {sym} cut {A.iso(ser.base_ts + STEP * cut)} max diff {md}")
    return out


def cmd_run(a):
    t_start = time.time()
    os.makedirs(a.out, exist_ok=True)
    logf = open(os.path.join(a.out, "run-log.txt"), "a")

    def log(s):
        line = f"{now_iso()} {s}"
        print(line, flush=True)
        logf.write(line + "\n")
        logf.flush()

    cpath = os.path.join(a.out, "frozen-r1110p3-config.json")
    cfg = json.load(open(cpath))
    want = open(cpath + ".sha256").read().split()[0]
    if R112.sha256_file(cpath) != want:
        raise SystemExit("STOP: frozen config hash mismatch")
    if cfg["code"]["sha"] != R112.git_sha() or not R112.git_clean():
        raise SystemExit("STOP: code sha differs from the frozen config or tree not clean")
    for k, v in cfg["inputs"].items():
        if R112.sha256_file(os.path.join(a.acq, v["path"][4:])) != v["sha256"]:
            raise SystemExit(f"STOP: input {k} sha256 differs")
    rp = os.path.join(a.out, "results-r1110p3.json")
    marker = os.path.join(a.out, "run-started.json")
    if os.path.exists(rp) or os.path.exists(marker):
        raise SystemExit("STOP: one run only")
    write_json(marker, {"started_utc": now_iso(), "config_sha256": want})
    log(f"run start; config sha256 {want}; code {cfg['code']['sha']}")
    pairs = cfg["pairs"]
    red = {T: {} for T in HORIZONS}
    for j, s in enumerate(pairs):
        ser = load_pair(a.acq, s)
        folds = pair_folds(ser)
        if not folds:
            log(f"{s}: no fold")
            continue
        B = RB.build_rungs(ser, ser, folds)
        for T in HORIZONS:
            red[T][s] = reduce_pair(ser, folds, T, B)
        del B
        log(f"pair {j + 1}/{len(pairs)} {s} done")
    results = {"schema": "q26-r1110p3/results/1", "started_utc": json.load(open(marker))["started_utc"],
               "config_sha256": want, "code_sha": cfg["code"]["sha"], "pairs": pairs, "horizons": {}}
    for ti, T in enumerate(HORIZONS):
        R = red[T]
        ks = sorted(R)
        V = [R[k]["val"] for k in ks]
        ncell = len(CELLS[T])
        for k, v in zip(ks, V):
            v["pair"] = np.full(len(v["ts"]), k)
        ts, se, sy, sp = cat(V, "ts"), cat(V, "se", 1), cat(V, "sy"), cat(V, "sp", 1)
        pair = cat(V, "pair")
        res = {"T": TL[T], "cells_scored": list(CELLS[T]), "pairs_scored": int(sum(len(v["ts"]) > 0 for v in V)),
               "origins_validated": int(len(ts)), "rows_scored": int(len(ts) * ncell)}
        g = group_stats(ts, se, sy, sp, ncell, 1000 * ti)
        res.update(g)
        chk = {}
        for c in ("f", "a"):
            chk[f"hac_vs_{c}"] = bool(g["hac"][c]["p_one_sided"] is not None and g["hac"][c]["p_one_sided"] < ALPHA
                                      and g["hac"][c]["mean_diff"] < 0)
            chk[f"boot_vs_{c}"] = bool(g["boot"][c]["p_one_sided"] < ALPHA and g["boot"][c]["mean_diff"] < 0)
        chk["R_in_band"] = bool(g["R"]["fH"] is not None and R_BAND[0] <= g["R"]["fH"] <= R_BAND[1])
        res["checks"] = chk
        res["pass"] = bool(all(chk.values()))
        # CORP (reported)
        rp_ = {r: np.concatenate([v["rows_p"][r] for v in V]) for r in RUNGS}
        ry = np.concatenate([v["rows_y"] for v in V])
        res["corp"] = {r: A6.corp(rp_[r], ry) for r in RUNGS}
        del rp_, ry
        # per pair
        pp = {}
        for k, v in zip(ks, V):
            if len(v["ts"]) < 3:
                pp[k] = {"origins": int(len(v["ts"]))}
                continue
            b = {r: float(v["se"][r].mean()) for r in RUNGS}
            s_ = float(v["sy"].sum())
            pp[k] = {"origins": int(len(v["ts"])), "bss_vs_f": 1 - b["fH"] / b["f"], "bss_vs_a": 1 - b["fH"] / b["a"],
                     "R": {r: (float(v["sp"][r].sum()) / s_ if s_ > 0 else None) for r in RUNGS},
                     "hac_p_vs_f": pooled_hac(v["ts"], v["se"]["fH"] - v["se"]["f"])["p_one_sided"],
                     "hac_p_vs_a": pooled_hac(v["ts"], v["se"]["fH"] - v["se"]["a"])["p_one_sided"],
                     "folds": sorted(set(v["fold"].tolist())), "fallback_rows": R[k]["fallback_rows"]}
        res["per_pair"] = pp
        bf = np.array([x["bss_vs_f"] for x in pp.values() if "bss_vs_f" in x])
        ba = np.array([x["bss_vs_a"] for x in pp.values() if "bss_vs_a" in x])
        res["per_pair_spread"] = {
            "n": int(len(bf)),
            "bss_vs_f": {"median": float(np.median(bf)), "q25": float(np.quantile(bf, 0.25)),
                         "q75": float(np.quantile(bf, 0.75)), "min": float(bf.min()), "max": float(bf.max()),
                         "n_positive": int((bf > 0).sum()),
                         "n_sig_0.05": int(sum(1 for x in pp.values() if x.get("hac_p_vs_f") is not None
                                               and x["hac_p_vs_f"] < 0.05))},
            "bss_vs_a": {"median": float(np.median(ba)), "q25": float(np.quantile(ba, 0.25)),
                         "q75": float(np.quantile(ba, 0.75)), "n_positive": int((ba > 0).sum())},
            "R_fH": {"median": float(np.median([x["R"]["fH"] for x in pp.values() if x.get("R", {}).get("fH")])),
                     "q25": float(np.quantile([x["R"]["fH"] for x in pp.values() if x.get("R", {}).get("fH")], 0.25)),
                     "q75": float(np.quantile([x["R"]["fH"] for x in pp.values() if x.get("R", {}).get("fH")], 0.75))}}
        # per month and per fold
        mon = np.array([A.iso(int(t))[:7] for t in ts])
        fold = cat(V, "fold")
        for nm, lab in (("per_month", mon), ("per_fold", fold)):
            d = {}
            for u in sorted(set(lab.tolist())):
                m = lab == u
                b = {r: float(se[r][m].mean()) for r in RUNGS}
                s_ = float(sy[m].sum())
                d[u] = {"origins": int(m.sum()), "pairs": int(len(set(pair[m].tolist()))),
                        "bss_vs_f": 1 - b["fH"] / b["f"], "bss_vs_a": 1 - b["fH"] / b["a"],
                        "R": {r: (float(sp[r][m].sum()) / s_ if s_ > 0 else None) for r in RUNGS}}
            res[nm] = d
        # vol regime (M3)
        reg = cat(V, "regime")
        pr_ = {}
        for gi, gname in enumerate(M3.REGIMES):
            m = reg == gi
            if m.sum() > 2:
                b = {r: float(se[r][m].mean()) for r in RUNGS}
                s_ = float(sy[m].sum())
                pr_[gname] = {"origins": int(m.sum()), "bss_vs_f": 1 - b["fH"] / b["f"], "bss_vs_a": 1 - b["fH"] / b["a"],
                              "R": {r: (float(sp[r][m].sum()) / s_ if s_ > 0 else None) for r in RUNGS}}
        res["per_vol_regime"] = pr_
        # regime split: top decile of 24 h vs 14 d vol change (per pair threshold)
        x = cat(V, "x")
        top = np.zeros(len(ts), bool)
        bot = np.zeros(len(ts), bool)
        xdef = np.isfinite(x)
        for k in ks:
            m = (pair == k) & xdef
            if m.sum() >= 10:
                top[m] = x[m] > np.quantile(x[m], TOP_Q)
                bot[m] = x[m] < np.quantile(x[m], 1 - TOP_Q)
        rest = xdef & ~top
        split = {"x_defined": int(xdef.sum()), "x_undefined": int((~xdef).sum())}
        sub = lambda m: ({r: se[r][m] for r in RUNGS}, sy[m], {r: sp[r][m] for r in RUNGS})  # noqa: E731
        for nm, m, off in (("top_decile", top, 100), ("rest", rest, 200), ("bottom_decile_reported", bot, 300)):
            s1, y1, p1 = sub(m)
            split[nm] = group_stats(ts[m], s1, y1, p1, ncell, 1000 * ti + off)
        mm = xdef
        split["diff_top_minus_rest"] = {c: boot_diff(ts[mm], (se["fH"] - se[c])[mm], top[mm], 1000 * ti + 400 + j)
                                        for j, c in enumerate(("f", "a"))}
        tf = split["top_decile"]
        split["reading_supported"] = bool(
            tf["hac"]["f"]["mean_diff"] < 0 and tf["hac"]["f"]["p_one_sided"] < 0.05
            and tf["boot"]["f"]["p_one_sided"] < 0.05 and split["diff_top_minus_rest"]["f"]["p_one_sided"] < 0.05)
        res["regime_split"] = split
        # 2026Q2 windows (reported)
        Q = [R[k]["q2"] for k in ks]
        res["q2_reported"] = group_stats(cat(Q, "ts"), cat(Q, "se", 1), cat(Q, "sy"), cat(Q, "sp", 1), ncell,
                                         1000 * ti + 500, with_boot=False)
        # all levels (reported)
        lv = {}
        for kk in (repr(x_) for x_ in LEVELS):
            rows = sum(R[k]["levels"][kk]["rows"] for k in ks)
            s_ = sum(R[k]["levels"][kk]["sum_y"] for k in ks)
            sse = {r: sum(R[k]["levels"][kk]["sse"][r] for k in ks) for r in RUNGS}
            lv[kk] = {"rows": rows, "sum_y": s_, "scored": float(kk) in CELLS[T],
                      "R": {r: (sum(R[k]["levels"][kk]["sum_p"][r] for k in ks) / s_ if s_ > 0 else None)
                            for r in RUNGS},
                      "bss_vs_f": (1 - sse["fH"] / sse["f"]) if sse["f"] > 0 else None,
                      "bss_vs_a": (1 - sse["fH"] / sse["a"]) if sse["a"] > 0 else None}
        res["per_level"] = lv
        res["fallback_rows_total"] = int(sum(sum(R[k]["fallback_rows"].values()) for k in ks))
        results["horizons"][TL[T]] = res
        log(f"  {TL[T]}: pass={res['pass']} BSS vs f {g['bss_vs_f']:+.4f} (HAC p {g['hac']['f']['p_one_sided']:.3g}, "
            f"boot p {g['boot']['f']['p_one_sided']:.3g}); vs a {g['bss_vs_a']:+.4f} (HAC p "
            f"{g['hac']['a']['p_one_sided']:.3g}, boot p {g['boot']['a']['p_one_sided']:.3g}); R {g['R']['fH']:.3f}")
        # per-origin file (published)
        with gzip.open(os.path.join(a.out, f"origins-r1110p3-{TL[T]}.csv.gz"), "wt", newline="") as f:
            w = csv.writer(f)
            w.writerow(["pair", "t0", "fold", "regime", "volchg", "se_fH", "se_f", "se_a", "sum_y", "sum_p_fH",
                        "sum_p_f", "sum_p_a"])
            for i in range(len(ts)):
                w.writerow([pair[i], A.iso(int(ts[i])), fold[i], M3.REGIMES[int(reg[i])],
                            "" if not np.isfinite(x[i]) else f"{x[i]:.6g}",
                            *(f"{se[r][i]:.8g}" for r in RUNGS), f"{sy[i]:.0f}", *(f"{sp[r][i]:.8g}" for r in RUNGS)])
    results["verdicts"] = {TL[T]: results["horizons"][TL[T]]["pass"] for T in HORIZONS}
    results["lookahead_check"] = lookahead_check(a.acq, pairs[0], log)
    results["finished_utc"] = now_iso()
    results["runtime_s"] = time.time() - t_start
    h = write_json(rp, results)
    log(f"verdicts {results['verdicts']}; results sha256 {h}; done in {results['runtime_s']:.0f}s")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=("power", "acquire", "counts", "freeze", "run"))
    ap.add_argument("--datasets")
    ap.add_argument("--acq")
    ap.add_argument("--work")
    ap.add_argument("--out")
    a = ap.parse_args()
    {"power": cmd_power, "acquire": cmd_acquire, "counts": cmd_counts, "freeze": cmd_freeze, "run": cmd_run}[a.cmd](a)


if __name__ == "__main__":
    main()
