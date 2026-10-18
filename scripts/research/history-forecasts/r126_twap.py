"""Q26 R12.6: is an oracle-modelled price (1 h TWAP, deviation-threshold oracle) easier to predict than the raw price?

membrane-board design/Q26_ROUND12_PREREG.md, Deviations D-R12.6a (sets reserved before development), D-R12.6b
(development readings), later D-R12.6c.. (registration, counts, freeze, result). Owner question 2026-10-18; owner
ruling 10 (live logs are never the only blind evidence; two unseen sets reserved before development).

Targets (touch: the target path's minimum over (t, t + T] at or below S_X * (1 + k)):
  L  hourly low (the R12 target; 1 m lows)            S = raw close of the hour before t
  C  hourly close                                      S = raw close of the hour before t
  W  1 h TWAP: mean of the 60 one-minute closes ending at each minute (>= 57 present); path = every minute
                                                       S = TWAP at t
  O  deviation-threshold oracle (Chainlink-like): the answer updates at a minute close when |p / answer - 1| >= 0.5%
     or 60 minutes after the last update; path = the answer at every minute         S = answer at t

  python3 r126_twap.py select-kucoin --datasets DS --out OUT
        mechanical B13a / B13b selection (KuCoin USDT pairs whose asset is on no used venue list); listings only.
  python3 r126_twap.py build-binance --datasets DS --out HOURS [--workers 4]
        development series (seen Binance USDT pairs): monthly 1 m zips streamed, sha256 == published CHECKSUM, else
        STOP; reduced to hourly target columns; raw zips never stored.
  python3 r126_twap.py dev --hours HOURS --out OUT [--workers 4]
        development scores of (fH), (f), (a), (e) per target (development only; seen data).

No address, key or secret is read or written.
"""
from __future__ import annotations

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import concurrent.futures as cf  # noqa: E402
import csv  # noqa: E402
import hashlib  # noqa: E402
import io  # noqa: E402
import json  # noqa: E402
import math  # noqa: E402
import re  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402
import urllib.error  # noqa: E402
import urllib.request  # noqa: E402
import zipfile  # noqa: E402
from datetime import datetime, timezone  # noqa: E402

import numpy as np  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import a_touch as A  # noqa: E402
import a2_touch as M2  # noqa: E402
import r12_tail as R12  # noqa: E402
import r125_fh_deep as R125  # noqa: E402

PREREG = {"repo": "triccs/membrane-board", "path": "design/Q26_ROUND12_PREREG.md", "item": "R12.6",
          "deviations": "D-R12.6a (sets reserved), D-R12.6b (development readings)"}
STEP, DAY, MIN = 3600, 86400, 60
END = R12.END                                   # 2026-10-01T00:00Z exclusive
TARGETS = ("L", "C", "W", "O")
TWAP_N, TWAP_MIN_PRESENT = 60, 57               # 1 h TWAP of 1 m closes, A3.1-style 5% null rule
HOUR_MIN_PRESENT = 57                           # an hour with < 57 one-minute bars is a null hour
OR_DEV, OR_HEART = 0.005, 60                    # oracle: 0.5% deviation, 60-minute heartbeat
UA = {"User-Agent": "membrane-research/1.0"}
BN_LIST = "https://s3-ap-northeast-1.amazonaws.com/data.binance.vision?delimiter=/&prefix={p}&marker={m}"
BN_FILE = "https://data.binance.vision/{k}"
KC_ROOT = "https://historical-data.kucoin.com/"
KC_FIRST_MAX = "2025-06-30"                     # a series whose first 1 m file is later has no A6.6 fold to score
SPLIT_SALT = "Q26-R12.6-B13:"


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha256b(b):
    return hashlib.sha256(b).hexdigest()


def http_get(url, tries=8, allow404=False):
    last = None
    for k in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404 and allow404:
                return None
            last = repr(e)
        except Exception as e:          # retried
            last = repr(e)
        time.sleep(1.5 * (k + 1))
    raise SystemExit(f"STOP: request failed after {tries} tries: {last} ({url})")


def s3_keys(root, prefix, delimiter=True):
    """S3-style listing (data.binance.vision bucket or historical-data.kucoin.com)."""
    out, m = [], ""
    while True:
        if root == "binance":
            u = BN_LIST.format(p=prefix, m=m) if delimiter else \
                f"https://s3-ap-northeast-1.amazonaws.com/data.binance.vision?prefix={prefix}&marker={m}"
        else:
            u = f"{KC_ROOT}?prefix={prefix}" + ("&delimiter=/" if delimiter else "") + "&max-keys=1000" + \
                (f"&marker={m}" if m else "")
        x = http_get(u).decode()
        tag = "Prefix" if delimiter else "Key"
        items = re.findall(rf"<{tag}>([^<]+)</{tag}>", x)
        if delimiter:
            items = [p for p in items if p != prefix]
        out += items
        if "<IsTruncated>true</IsTruncated>" not in x or not items:
            break
        nm = re.findall(r"<NextMarker>([^<]+)</NextMarker>", x)
        m = nm[0] if nm else items[-1]
    return out


# =============================================================================================
# minute -> hourly target columns
# =============================================================================================
def oracle_path(close):
    """deviation-threshold oracle answer at every minute (NaN before the first observed price)."""
    out = np.full(len(close), np.nan)
    last, lm = math.nan, -10 ** 9
    cl = close.tolist()
    for m, p in enumerate(cl):
        if p == p and (last != last or abs(p / last - 1.0) >= OR_DEV or m - lm >= OR_HEART):
            last, lm = p, m
        out[m] = last
    return out


def hourly_columns(close, low, high):
    """minute arrays on a contiguous grid starting at an hour boundary (length a multiple of 60) -> hourly dict."""
    n = len(close)
    H = n // 60
    pres = np.isfinite(close)
    cs = np.concatenate([[0.0], np.cumsum(np.where(pres, close, 0.0))])
    cn = np.concatenate([[0], np.cumsum(pres)])
    i = np.arange(n)
    j0 = np.maximum(i - TWAP_N + 1, 0)
    cnt = cn[i + 1] - cn[j0]
    with np.errstate(invalid="ignore", divide="ignore"):
        tw = (cs[i + 1] - cs[j0]) / cnt
    tw[(cnt < TWAP_MIN_PRESENT) | (i < TWAP_N - 1)] = np.nan
    orc = oracle_path(close)
    r = lambda a: a.reshape(H, 60)  # noqa: E731
    npres = r(pres).sum(1)
    ok = npres >= HOUR_MIN_PRESENT
    with np.errstate(invalid="ignore"):
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            lo = np.nanmin(r(low), 1)
            hi = np.nanmax(r(high), 1)
            twm = np.nanmin(r(tw), 1)
            orm = np.nanmin(r(orc), 1)
    cr = r(close)
    last_idx = 59 - np.argmax(np.isfinite(cr[:, ::-1]), axis=1)
    cl = cr[np.arange(H), last_idx]
    twn = r(np.isfinite(tw)).sum(1)
    out = {"close": cl, "low": lo, "high": hi, "tw_end": r(tw)[:, 59], "tw_min": np.where(twn >= TWAP_MIN_PRESENT, twm,
                                                                                         np.nan),
           "or_end": r(orc)[:, 59], "or_min": orm}
    for k in out:
        out[k] = np.where(ok, out[k], np.nan)
    return out


def parse_kline_csv(raw):
    """Binance/KuCoin 1 m kline CSV -> (open_ms, high, low, close) arrays; header lines skipped."""
    t, h, lo, c = [], [], [], []
    for row in csv.reader(io.StringIO(raw.decode())):
        if not row or not row[0][:1].isdigit():
            continue
        ts = int(row[0])
        if ts > 10 ** 14:                       # microseconds (Binance files from 2025)
            ts //= 1000
        elif ts < 10 ** 11:                     # seconds
            ts *= 1000
        t.append(ts)
        h.append(float(row[2]))
        lo.append(float(row[3]))
        c.append(float(row[4]))
    return np.array(t, np.int64), np.array(h), np.array(lo), np.array(c)


def assemble(parts, end_ts=END):
    """list of (t_ms, high, low, close) -> minute grid from the first full hour to end_ts."""
    t = np.concatenate([p[0] for p in parts]) // 1000
    if len(t) == 0:
        return None
    st = int(t.min()) // STEP * STEP
    n = (end_ts - st) // MIN
    close, low, high = (np.full(n, np.nan) for _ in range(3))
    for tm, h, lo, c in parts:
        ix = (tm // 1000 - st) // MIN
        ok = (ix >= 0) & (ix < n)
        close[ix[ok]], low[ix[ok]], high[ix[ok]] = c[ok], lo[ok], h[ok]
    return st, close, low, high


def save_hours(path, key, st, cols, meta):
    np.savez_compressed(path, startTs=np.int64(st), **{k: v.astype(np.float64) for k, v in cols.items()})
    meta["hours"] = int(len(cols["close"]))
    meta["null_hours"] = int(np.isnan(cols["close"]).sum())
    return meta


# =============================================================================================
# development series (seen Binance USDT pairs)
# =============================================================================================
def dev_pairs(datasets):
    """mechanical: ETH, BTC, the A2 eight, the A3 ten, every 3rd blind 3-7 pair (sorted), every 2nd blind8 pair."""
    majors = ["ETHUSDT", "BTCUSDT"] + list(M2.HOLDOUTS)
    fb = os.path.join(datasets, "final-blind-prices")
    majors += sorted(n[8:-8] for n in os.listdir(fb) if n.startswith("binance-") and n.endswith("-1h.json"))
    b37 = set()
    for j in (3, 4, 5, 6, 7):
        d = os.path.join(datasets, f"blind{j}-prices")
        b37 |= {n.split("-")[1] for n in os.listdir(d) if n.endswith("-1h.json")}
    b37 = sorted(b37 - set(majors))[::3]
    d = os.path.join(datasets, "history-forecasts/r11/r1110-p3-run-9ab156bb/acq")
    b8 = sorted({n.split("-")[1] for n in os.listdir(d) if n.startswith("binance-") and n.endswith("-1h.json.gz")})[::2]
    return [("major", p) for p in majors] + [("blind37", p) for p in b37] + [("blind8", p) for p in b8]


def build_binance_pair(a):
    grp, pair, out = a
    path = os.path.join(out, f"{pair}.npz")
    if os.path.exists(path + ".meta.json"):
        return json.load(open(path + ".meta.json"))
    keys = [k for k in s3_keys("binance", f"data/spot/monthly/klines/{pair}/1m/", delimiter=False)
            if k.endswith(".zip")]
    keys = [k for k in keys if k.rsplit("-", 2)[-2] + "-" + k.rsplit("-", 1)[-1][:2] < "2026-10"]
    files, parts = [], []

    def one(k):
        raw = http_get(BN_FILE.format(k=k))
        ck = http_get(BN_FILE.format(k=k) + ".CHECKSUM").decode().split()[0]
        h = sha256b(raw)
        if h != ck:
            raise SystemExit(f"STOP: {k} sha256 {h} != CHECKSUM {ck}")
        z = zipfile.ZipFile(io.BytesIO(raw))
        return k, h, parse_kline_csv(z.read(z.namelist()[0]))
    with cf.ThreadPoolExecutor(6) as ex:
        for k, h, p in ex.map(one, sorted(keys)):
            files.append({"key": k, "sha256": h})
            parts.append(p)
    g = assemble(parts)
    meta = {"group": grp, "pair": pair, "files": files, "n_files": len(files)}
    if g is None:
        meta["empty"] = True
    else:
        st, c, lo, hi = g
        meta["startTs"] = st
        meta = save_hours(path, pair, st, hourly_columns(c, lo, hi), meta)
        meta["npz_sha256"] = sha256b(open(path, "rb").read())
    json.dump(meta, open(path + ".meta.json", "w"))
    return meta


def cmd_build_binance(a):
    os.makedirs(a.out, exist_ok=True)
    pairs = dev_pairs(a.datasets)
    print(f"{now_iso()} build-binance: {len(pairs)} development pairs", flush=True)
    t0 = time.time()
    with cf.ProcessPoolExecutor(a.workers) as ex:
        for j, m in enumerate(ex.map(build_binance_pair, [(g, p, a.out) for g, p in pairs])):
            print(f"  {j + 1}/{len(pairs)} {m['pair']} files {m['n_files']} hours {m.get('hours')} "
                  f"({time.time() - t0:.0f}s)", flush=True)
    man = {"schema": "q26-r126-dev-hours-v1", "created_utc": now_iso(), "pairs": [],
           "rules": {"twap": "mean of 60 one-minute closes ending at the minute, >= 57 present",
                     "oracle": "answer updates at a 1 m close when |p/answer-1| >= 0.5% or >= 60 min since the last "
                               "update", "null_hour": "< 57 one-minute bars"}}
    for g, p in pairs:
        m = json.load(open(os.path.join(a.out, f"{p}.npz.meta.json")))
        man["pairs"].append({k: m.get(k) for k in ("group", "pair", "n_files", "hours", "null_hours", "startTs",
                                                     "npz_sha256")})
        man["pairs"][-1]["files_sha256"] = sha256b(json.dumps(m["files"], sort_keys=True).encode())
    json.dump(man, open(os.path.join(a.out, "manifest-dev-hours.json"), "w"), indent=1)
    print(f"{now_iso()} done", flush=True)


# =============================================================================================
# B13a / B13b selection (KuCoin)
# =============================================================================================
def cmd_select_kucoin(a):
    sel12 = json.load(open(os.path.join(a.datasets, "b12-venue-unique-prices/selection-b12.json")))
    b12 = set(sel12["okx"]["kept"]) | set(sel12["bybit"]["kept"])
    b12 = {x.split("-")[0].replace("USDT", "") if isinstance(x, str) else x for x in b12}
    bn = set(R125.binance_symbols())
    dirs = [p.rstrip("/").split("/")[-1] for p in s3_keys("kucoin", "data/spot/daily/klines/")]
    usdt = sorted(d for d in dirs if d.endswith("USDT") and len(d) > 4)
    rec = {"kucoin_usdt_dirs": len(usdt), "on_binance": [], "in_b12": [], "excluded": {}, "kept": []}
    for d in usdt:
        base = d[:-4]
        if R125.on_binance(base, bn):
            rec["on_binance"].append(base)
        elif base in b12:
            rec["in_b12"].append(base)
        elif R125.excluded(base):
            rec["excluded"][base] = R125.excluded(base)
        else:
            rec["kept"].append(base)
    first = {}

    def fst(base):
        x = http_get(f"{KC_ROOT}?prefix=data/spot/daily/klines/{base}USDT/1m/&max-keys=2").decode()
        k = re.findall(r"<Key>([^<]+)</Key>", x)
        return base, (k[0].rsplit("-1m-", 1)[-1][:10] if k else None)
    with cf.ThreadPoolExecutor(16) as ex:
        for b, f in ex.map(fst, rec["kept"]):
            first[b] = f
    rec["first_1m_file"] = first
    elig = sorted(b for b in rec["kept"] if first.get(b) and first[b] <= KC_FIRST_MAX)
    rec["eligible_first_1m_le"] = KC_FIRST_MAX
    rec["eligible"] = elig
    rec["B13a"] = [b for b in elig if int(sha256b((SPLIT_SALT + b).encode())[:2], 16) % 2 == 0]
    rec["B13b"] = [b for b in elig if int(sha256b((SPLIT_SALT + b).encode())[:2], 16) % 2 == 1]
    out = {"schema": "q26-r126-b13-selection-v1", "created_utc": now_iso(), "binance_spot_symbols": len(bn),
           "binance_list_sha256": sha256b("\n".join(sorted(bn)).encode()), "b12_assets": len(b12),
           "split_rule": f"sha256('{SPLIT_SALT}' + base)[0:2] as hex byte: even -> B13a, odd -> B13b", **rec}
    os.makedirs(a.out, exist_ok=True)
    p = os.path.join(a.out, "selection-b13.json")
    json.dump(out, open(p, "w"), indent=1)
    print(json.dumps({k: (len(v) if isinstance(v, (list, dict)) else v) for k, v in out.items()}, indent=1))
    print("sha256", sha256b(open(p, "rb").read()))


# =============================================================================================
# B13 acquisition (outcome-blind builder; prints counts only)
# =============================================================================================
def parse_kucoin_csv(raw):
    """KuCoin 1 m CSV: time (s), open, close, high, low, volume, turnover; rows unsorted -> (open_ms, h, l, c)."""
    rows = [r for r in csv.reader(io.StringIO(raw.decode())) if r and r[0][:1].isdigit()]
    if not rows:
        return np.zeros(0, np.int64), np.zeros(0), np.zeros(0), np.zeros(0)
    a = np.array([[float(x) for x in r[:5]] for r in rows])
    t = a[:, 0].astype(np.int64)
    t = np.where(t > 10 ** 11, t, t * 1000)
    return t, a[:, 3], a[:, 4], a[:, 2]


def kucoin_pair(a):
    base, out = a
    pair = base + "USDT"
    path = os.path.join(out, f"{pair}.npz")
    if os.path.exists(path + ".meta.json"):
        return json.load(open(path + ".meta.json"))
    keys = [k for k in s3_keys("kucoin", f"data/spot/daily/klines/{pair}/1m/", delimiter=False)
            if k.endswith(".zip") and k.rsplit("-1m-", 1)[-1][:10] < "2026-10-01"]
    files, parts = [], []

    def one(k):
        raw = http_get(KC_ROOT + k)
        ck = http_get(KC_ROOT + k + ".CHECKSUM").decode().split()[0].lower()
        h = hashlib.md5(raw).hexdigest() if len(ck) == 32 else sha256b(raw)
        if h != ck:
            raise SystemExit(f"STOP: {k} checksum {h} != CHECKSUM {ck}")
        z = zipfile.ZipFile(io.BytesIO(raw))
        return k, ck, sha256b(raw), parse_kucoin_csv(z.read(z.namelist()[0]))
    with cf.ThreadPoolExecutor(KC_THREADS) as ex:
        for k, ck, h, p in ex.map(one, sorted(keys)):
            files.append({"key": k, "checksum": ck, "sha256": h})
            parts.append(p)
    meta = {"pair": pair, "files": files, "n_files": len(files)}
    g = assemble(parts) if parts else None
    if g is None:
        meta["empty"] = True
    else:
        st, c, lo, hi = g
        meta["startTs"] = st
        fin = np.where(np.isfinite(c))[0]
        meta["last_minute_ts"] = int(st + MIN * fin[-1]) if len(fin) else None
        meta = save_hours(path, pair, st, hourly_columns(c, lo, hi), meta)
        meta["npz_sha256"] = sha256b(open(path, "rb").read())
    json.dump(meta, open(path + ".meta.json", "w"))
    return meta


KC_THREADS = 12


def cmd_acquire_kucoin(a):
    sel = json.load(open(a.selection))
    bases = sel[a.set]
    os.makedirs(a.out, exist_ok=True)
    print(f"{now_iso()} acquire {a.set}: {len(bases)} tickers", flush=True)
    t0 = time.time()
    with cf.ProcessPoolExecutor(a.workers) as ex:
        for j, m in enumerate(ex.map(kucoin_pair, [(b, a.out) for b in bases])):
            print(f"  {j + 1}/{len(bases)} files {m['n_files']} hours {m.get('hours')} ({time.time() - t0:.0f}s)",
                  flush=True)
    man = {"schema": "q26-r126-b13-acq-v1", "set": a.set, "created_utc": now_iso(),
           "selection_sha256": sha256b(open(a.selection, "rb").read()), "pairs": []}
    for b in bases:
        m = json.load(open(os.path.join(a.out, f"{b}USDT.npz.meta.json")))
        e = {k: m.get(k) for k in ("pair", "n_files", "hours", "null_hours", "startTs", "last_minute_ts",
                                   "npz_sha256", "empty")}
        e["files_sha256"] = sha256b(json.dumps(m["files"], sort_keys=True).encode())
        man["pairs"].append(e)
    p = os.path.join(a.out, f"manifest-acquire-{a.set}.json")
    json.dump(man, open(p, "w"), indent=1)
    print(f"{now_iso()} done; manifest sha256 {sha256b(open(p, 'rb').read())}", flush=True)


# =============================================================================================
# development scoring (seen data only)
# =============================================================================================
import a3_touch as M3  # noqa: E402
import a6_touch as A6  # noqa: E402

LEVELS = R12.LEVELS
LNK = np.log1p(np.asarray(LEVELS, float))
SHALLOW = (-0.02, -0.03, -0.05, -0.07, -0.10)
DEEP6 = (-0.15, -0.20)
CELLS = {1: SHALLOW, 3: SHALLOW, 6: SHALLOW, 12: SHALLOW + DEEP6, 24: DEEP6, 72: DEEP6}
TGT_COLS = {"L": ("low", "close"), "C": ("close", "close"), "W": ("tw_min", "tw_end"), "O": ("or_min", "or_end")}
ISSUE_6H = 6 * STEP
N_BOOT_DEV, SEED_DEV = 1000, 20261826


def dev_task(a):
    path, T, key = a["path"], a["T"], a["key"]
    grid, cap = a.get("grid", "6h"), int(a.get("cap", END))
    d = np.load(path)
    st = int(d["startTs"])
    cols = {k: d[k] for k in ("close", "low", "high", "tw_min", "tw_end", "or_min", "or_end")}
    ser = M3.S3(key, key, "binance", cols["close"], cols["low"], LEVELS, st, st)
    A6.attach_high(ser, cols["high"])
    folds = R12.generic_folds(ser, st)
    if not folds:
        return {"key": key, "rows": None}
    A6.har_of(ser)
    A6.sfut_of(ser, T)
    s_raw = A.spot_series(cols["close"])
    PS, WM, SX = {}, {}, {}
    for X in TARGETS:
        mn, en = TGT_COLS[X]
        WM[X] = M3.window_min_null_rule(cols[mn], T)
        SX[X] = A.spot_series(cols[en])
        ser._wmin = {T: WM[X]}
        ser._lab = {}
        ser.spot = SX[X]
        PS[X] = A6.Prep6(ser, T, with_fbL=False)
    ser.spot = s_raw
    PL = PS["L"]
    n = PL.n
    scale = PL.P.scale
    i_all = np.arange(n)
    ts_all = ser.base_ts + STEP * i_all
    lab_all = np.all([PS[X].P.lab_ok for X in TARGETS], axis=0)
    # anchored depth (target window minimum relative to the raw spot) for W and O
    with np.errstate(invalid="ignore", divide="ignore"):
        dA = {X: np.log(WM[X][:n] / s_raw[:n]) for X in ("W", "O")}
        gap = {X: np.log(SX[X][:n] / s_raw[:n]) for X in ("W", "O")}
    R = {"ts": [], "fold": [], "q2": []}
    for X in TARGETS:
        R["y" + X] = []
        for m in ("fH", "f", "a") + (("fHA",) if X in ("W", "O") else ()):
            R[m + X] = []
    for gid, f in enumerate(folds):
        qs, qe = f["qs_i"], min(f["qe_i"], n)
        lim = qs - T
        tr = i_all <= lim
        coef, _ = PL.har_coef(qs)
        sH = PL.sigma_H(coef)
        te = np.arange(qs, qe)
        te = te[lab_all[te] & (ts_all[te] + T * STEP <= min(END, cap)) &
                ((ts_all[te] % ISSUE_6H == 0) if grid == "6h" else True)]
        if len(te) == 0:
            continue
        thr = PL.P.thresholds(sH[te])
        out = {}
        ok = np.ones(len(te), bool)
        for X in TARGETS:
            P6 = PS[X]
            P = P6.P
            z, valid = P6.z_of(sH)
            pH = M2.fhs_predict(z[valid & tr], thr)
            pf = M2.fhs_predict(P.z[1.0][P.valid[1.0] & tr], P.thresholds(ser.sigma[te]))
            fb = ~np.all(np.isfinite(pH), axis=1)
            pH[fb] = pf[fb]
            pa = np.tile(P.freq_upto(lim), (len(te), 1))
            out["fH" + X], out["f" + X], out["a" + X] = pH, pf, pa
            if X in ("W", "O"):
                with np.errstate(invalid="ignore", divide="ignore"):
                    zA = dA[X] / (sH * scale)
                    thrA = (LNK[None, :] + gap[X][te][:, None]) / (sH[te][:, None] * scale)
                vA = P.lab_ok & np.isfinite(zA) & tr
                pA = M2.fhs_predict(zA[vA], thrA)
                fbA = ~np.all(np.isfinite(pA), axis=1)
                pA[fbA] = pH[fbA]
                out["fHA" + X] = pA
            out["y" + X] = P.Y[te]
            for m in ("fH", "f", "a"):
                ok &= np.all(np.isfinite(out[m + X]), axis=1)
        if not ok.any():
            continue
        R["ts"].append(ts_all[te][ok])
        R["fold"].append(np.full(int(ok.sum()), gid, np.int16))
        R["q2"].append((ts_all[te][ok] + T * STEP > R12.Q2_START) & (ts_all[te][ok] < R12.Q2_END))
        for k, v in out.items():
            if k.startswith("y"):
                R[k].append(v[ok].astype(np.int8))
            else:
                R[k].append(np.minimum.accumulate(v[ok], axis=1).astype(np.float32))
    if not R["ts"]:
        return {"key": key, "rows": None}
    return {"key": key, "rows": {k: np.concatenate(v) for k, v in R.items()}}


def calib(p, y):
    """logistic recalibration y ~ a + b logit(p): returns (a, b)."""
    x = R12.logit(p)
    a, b = 0.0, 1.0
    for _ in range(25):
        eta = np.clip(a + b * x, -30, 30)
        mu = 1 / (1 + np.exp(-eta))
        w = np.maximum(mu * (1 - mu), 1e-9)
        g = np.array([np.sum(y - mu), np.sum((y - mu) * x)])
        Hm = np.array([[np.sum(w), np.sum(w * x)], [np.sum(w * x), np.sum(w * x * x)]])
        try:
            st = np.linalg.solve(Hm, g)
        except np.linalg.LinAlgError:
            break
        a, b = a + st[0], b + st[1]
        if np.max(np.abs(st)) < 1e-8:
            break
    return float(a), float(b)


def score_dev_cell(S, T, k, rng):
    col = LEVELS.index(k)
    deep = k <= -0.15
    yL = S["yL"][:, col].astype(float)
    if deep:
        g, G, _ = R12.crash_blocks(S["ts"], S["sid"], yL, T)
    else:
        w = R12.wk(S["ts"])
        _, g = np.unique(w, return_inverse=True)
        G = int(g.max()) + 1
    idx = rng.integers(0, G, size=(N_BOOT_DEV, G))
    cell = {"T": R12.TL[T], "level": k, "rows": int(len(yL)), "series": int(len(np.unique(S["sid"]))),
            "blocks": G, "block_rule": "crash-episode blocks (R12, on L labels)" if deep else "calendar weeks",
            "targets": {}}
    bss_boot = {}
    for X in TARGETS:
        y = S["y" + X][:, col].astype(float)
        pos = y > 0
        Bc = {}
        models = {"fH": S["fH" + X][:, col], "f": S["f" + X][:, col], "a": S["a" + X][:, col],
                  "e": np.full(len(y), y.mean()), "fH_raw": S["fHL"][:, col], "f_raw": S["fL"][:, col],
                  "a_raw": S["aL"][:, col], "e_raw": np.full(len(y), yL.mean())}
        if X in ("W", "O"):
            models["fHA"] = S["fHA" + X][:, col]
        se = {m: (p.astype(float) - y) ** 2 for m, p in models.items()}
        sums = {m: np.bincount(g, weights=v, minlength=G) for m, v in se.items()}
        cnt = np.bincount(g, minlength=G).astype(float)
        posb = np.bincount(g, weights=y, minlength=G) > 0
        t = {"positives": int(pos.sum()), "base_rate": float(y.mean()), "positive_blocks": int(posb.sum()),
             "brier": {m: float(v.mean()) for m, v in se.items()},
             "R": {m: (float(models[m].astype(float).sum() / y.sum()) if y.sum() > 0 else None) for m in models},
             "calib_slope_intercept": {m: calib(models[m].astype(float), y) for m in ("fH", "f", "fH_raw") +
                                       (("fHA",) if X in ("W", "O") else ()) if y.sum() > 0}}
        bss = {}
        for m in [x for x in models if x not in ("e", "e_raw")]:
            for c in ("f", "a", "e"):
                if m.endswith("_raw") and c != "e":
                    continue
                bss[f"{m}_vs_{c}"] = 1 - t["brier"][m] / t["brier"][c] if t["brier"][c] > 0 else None
        t["bss"] = bss
        # block bootstrap of BSS(fH vs e) and BSS(fH vs f); per-positive-block G* for fH vs f, a, e
        for c in ("e", "f", "a"):
            num = sums["fH"][idx].sum(1)
            den = sums[c][idx].sum(1)
            bb = 1 - num / den
            Bc[c] = bb
            t[f"bss_fH_vs_{c}_ci90"] = [float(np.quantile(bb, 0.05)), float(np.quantile(bb, 0.95))]
            dsum = sums["fH"] - sums[c]
            Sp = dsum[posb]
            mb, sb = (float(Sp.mean()), float(Sp.std(ddof=1))) if len(Sp) > 1 else (np.nan, np.nan)
            ma, sa = float(dsum.mean()), float(dsum.std(ddof=1))
            t[f"block_d_fH_vs_{c}"] = {"pos_mean": mb, "pos_sd": sb, "all_mean": ma, "all_sd": sa,
                                      "cr1": R12.cr1_test(g, se["fH"] - se[c])["p_one_sided"]}
        bss_boot[X] = Bc
        cell["targets"][X] = t
        del cnt
    # difference of skill between targets (paired blocks): BSS_X(fH vs c) - BSS_L(fH vs c)
    cell["skill_diff_vs_L"] = {}
    for X in ("C", "W", "O"):
        for c in ("e", "f"):
            dd = bss_boot[X][c] - bss_boot["L"][c]
            pt = cell["targets"][X]["bss"][f"fH_vs_{c}"] - cell["targets"]["L"]["bss"][f"fH_vs_{c}"]
            cell["skill_diff_vs_L"][f"{X}_{c}"] = {"diff": pt, "ci90": [float(np.quantile(dd, 0.05)),
                                                                        float(np.quantile(dd, 0.95))],
                                                   "share_boot_gt0": float(np.mean(dd > 0))}
    return cell


def cmd_dev(a):
    os.makedirs(a.out, exist_ok=True)
    man = json.load(open(os.path.join(a.hours, "manifest-dev-hours.json")))
    keys = [p["pair"] for p in man["pairs"] if p.get("hours")]
    log = open(os.path.join(a.out, "dev-log.txt"), "a")

    def say(s):
        print(s, flush=True)
        log.write(s + "\n")
        log.flush()
    say(f"{now_iso()} R12.6 dev start: {len(keys)} series")
    res_all = {"schema": "q26-r126-dev-v1", "prereg": PREREG, "created_utc": now_iso(),
               "hours_manifest_sha256": sha256b(open(os.path.join(a.hours, "manifest-dev-hours.json"), "rb").read()),
               "grid": "6-hourly development origins (00/06/12/18Z), A6.6 folds, 2026Q2 windows dropped",
               "cells": []}
    rng = np.random.default_rng(SEED_DEV)
    import multiprocessing as mp
    for T in (1, 3, 6, 12, 24, 72):
        t0 = time.time()
        tasks = [{"path": os.path.join(a.hours, f"{k}.npz"), "T": T, "key": k} for k in keys]
        with mp.get_context("fork").Pool(a.workers, maxtasksperchild=4) as pool:
            res = pool.map(dev_task, tasks, chunksize=1)
        S = R12.stack_rows(res, lambda rw: ~rw["q2"])
        del res
        say(f"{now_iso()} T={T}: {len(S['ts'])} rows, {len(np.unique(S['sid']))} series ({time.time() - t0:.0f}s)")
        for k in CELLS[T]:
            c = score_dev_cell(S, T, k, rng)
            res_all["cells"].append(c)
            tt = c["targets"]
            say(f"  {R12.TL[T]} {k:+.2f} " + " | ".join(
                f"{X}: pos {tt[X]['positives']} pb {tt[X]['positive_blocks']} BSS fH v e/f/a "
                f"{tt[X]['bss']['fH_vs_e']:+.3f}/{tt[X]['bss']['fH_vs_f']:+.3f}/{tt[X]['bss']['fH_vs_a']:+.3f} "
                f"R {tt[X]['R']['fH']:.2f}" for X in TARGETS if tt[X]['positives'] > 0))
        del S
        json.dump(res_all, open(os.path.join(a.out, "dev-r126.json"), "w"), indent=1)
    res_all["finished_utc"] = now_iso()
    json.dump(res_all, open(os.path.join(a.out, "dev-r126.json"), "w"), indent=1)
    say(f"{now_iso()} done")


CONF_T = (1, 3, 6)
CONF_K = SHALLOW
N_CONF6 = len(CONF_T) * len(CONF_K)
SEED_POW = 20261827


def cand_cmp(S, col, ew):
    """candidate fHA_W and its comparators on target W at one level; (e) constant ew."""
    y = S["yW"][:, col].astype(float)
    P = {"fHA": S["fHAW"][:, col].astype(float), "fH": S["fHW"][:, col].astype(float),
         "f": S["fW"][:, col].astype(float), "a": S["aW"][:, col].astype(float), "e": np.full(len(y), ew)}
    return y, P


def cmd_power(a):
    """development power for the R12.6 confirmatory family (hourly grid, calendar-week blocks)."""
    from scipy.stats import norm
    os.makedirs(a.out, exist_ok=True)
    man = json.load(open(os.path.join(a.hours, "manifest-dev-hours.json")))
    keys = [p["pair"] for p in man["pairs"] if p.get("hours")]
    z = float(norm.ppf(1 - 0.05 / N_CONF6) + norm.ppf(0.8))
    z3 = float(norm.ppf(1 - 0.05 / len(CONF_T)) + norm.ppf(0.8))
    out = {"schema": "q26-r126-power-v1", "prereg": PREREG, "created_utc": now_iso(), "grid": "hourly",
           "z_alpha_15_plus_z_08": z, "z_alpha_3_plus_z_08": z3, "e_constants": {}, "cells": [], "pooled_T": []}
    import multiprocessing as mp
    for T in CONF_T:
        tasks = [{"path": os.path.join(a.hours, f"{k}.npz"), "T": T, "key": k, "grid": "1h"} for k in keys]
        with mp.get_context("fork").Pool(a.workers, maxtasksperchild=4) as pool:
            res = pool.map(dev_task, tasks, chunksize=1)
        for r in res:
            if r["rows"] is not None:
                r["rows"] = {k: v for k, v in r["rows"].items() if k in ("ts", "q2", "yW", "yL", "fHAW", "fHW", "fW",
                                                                           "aW", "fHL")}
        S = R12.stack_rows(res, lambda rw: ~rw["q2"])
        del res
        w = R12.wk(S["ts"])
        _, g = np.unique(w, return_inverse=True)
        G = int(g.max()) + 1
        rng = np.random.default_rng(np.random.SeedSequence([SEED_POW, T]))
        idx = rng.integers(0, G, size=(2000, G))
        out["e_constants"][R12.TL[T]] = {}
        num_W = np.zeros(G)
        den_W = np.zeros(G)
        num_L = np.zeros(G)
        den_L = np.zeros(G)
        for k in CONF_K:
            col = LEVELS.index(k)
            ew = float(S["yW"][:, col].mean())
            el = float(S["yL"][:, col].mean())
            out["e_constants"][R12.TL[T]][repr(k)] = {"W": ew, "L": el}
            y, P = cand_cmp(S, col, ew)
            se = {m: (p - y) ** 2 for m, p in P.items()}
            cell = {"T": R12.TL[T], "level": k, "rows": int(len(y)), "positives": int(y.sum()), "weeks": G,
                    "positive_weeks": int((np.bincount(g, weights=y, minlength=G) > 0).sum()),
                    "R_fHA": float(P["fHA"].sum() / y.sum()), "vs": {}}
            gs = []
            for c in ("fH", "f", "a", "e"):
                d = se["fHA"] - se[c]
                Sb = np.bincount(g, weights=d, minlength=G)
                m_, s_ = float(Sb.mean()), float(Sb.std(ddof=1))
                gst = (z * s_ / m_) ** 2 if m_ < 0 else None
                gs.append(gst)
                cell["vs"][c] = {"bss": 1 - float(se["fHA"].mean() / se[c].mean()), "week_mean_d": m_,
                                 "week_sd_d": s_, "G_star_weeks": gst, "cr1_p": R12.cr1_test(g, d)["p_one_sided"]}
            cell["G_star_max_weeks"] = None if any(x is None for x in gs) else float(max(gs))
            out["cells"].append(cell)
            print(f"{R12.TL[T]} {k:+.2f} rows {len(y)} pos {int(y.sum())} R {cell['R_fHA']:.2f} " +
                  " ".join(f"{c} {cell['vs'][c]['bss']:+.3f}/G*{cell['vs'][c]['G_star_weeks'] or -1:.0f}"
                           for c in ("fH", "f", "a", "e")), flush=True)
            yl = S["yL"][:, col].astype(float)
            num_W += np.bincount(g, weights=se["fHA"], minlength=G)
            den_W += np.bincount(g, weights=se["e"], minlength=G)
            num_L += np.bincount(g, weights=(S["fHL"][:, col] - yl) ** 2, minlength=G)
            den_L += np.bincount(g, weights=(el - yl) ** 2, minlength=G)
        dS = (1 - num_W.sum() / den_W.sum()) - (1 - num_L.sum() / den_L.sum())
        bb = (1 - num_W[idx].sum(1) / den_W[idx].sum(1)) - (1 - num_L[idx].sum(1) / den_L[idx].sum(1))
        sd = float(bb.std(ddof=1))
        # weeks needed for 80% power at alpha 0.05/3, scaling the bootstrap SD by sqrt(G / G_new)
        gneed = float(G * (z3 * sd / dS) ** 2) if dS > 0 else None
        out["pooled_T"].append({"T": R12.TL[T], "skill_W_fHA_vs_e": float(1 - num_W.sum() / den_W.sum()),
                                "skill_L_fH_vs_e": float(1 - num_L.sum() / den_L.sum()), "diff": float(dS),
                                "boot_sd": sd, "boot_p_le0": float(np.mean(bb <= 0)), "weeks": G,
                                "weeks_needed_80pct": gneed})
        print(out["pooled_T"][-1], flush=True)
        del S
    p = os.path.join(a.out, "power-r126.json")
    json.dump(out, open(p, "w"), indent=1)
    print("sha256", sha256b(open(p, "rb").read()))


def main():
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest="cmd", required=True)
    s = sp.add_parser("select-kucoin")
    s.add_argument("--datasets", required=True)
    s.add_argument("--out", required=True)
    s = sp.add_parser("build-binance")
    s.add_argument("--datasets", required=True)
    s.add_argument("--out", required=True)
    s.add_argument("--workers", type=int, default=4)
    s = sp.add_parser("acquire-kucoin")
    s.add_argument("--selection", required=True)
    s.add_argument("--set", required=True, choices=("B13a",))
    s.add_argument("--out", required=True)
    s.add_argument("--workers", type=int, default=6)
    s = sp.add_parser("power")
    s.add_argument("--hours", required=True)
    s.add_argument("--out", required=True)
    s.add_argument("--workers", type=int, default=3)
    s = sp.add_parser("dev")
    s.add_argument("--hours", required=True)
    s.add_argument("--out", required=True)
    s.add_argument("--workers", type=int, default=4)
    a = ap.parse_args()
    {"select-kucoin": cmd_select_kucoin, "build-binance": cmd_build_binance,
     "acquire-kucoin": cmd_acquire_kucoin, "dev": cmd_dev, "power": cmd_power}[a.cmd](a)


if __name__ == "__main__":
    main()
