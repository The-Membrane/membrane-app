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
    s = sp.add_parser("dev")
    s.add_argument("--hours", required=True)
    s.add_argument("--out", required=True)
    s.add_argument("--workers", type=int, default=4)
    a = ap.parse_args()
    {"select-kucoin": cmd_select_kucoin, "build-binance": cmd_build_binance,
     "dev": lambda x: cmd_dev(x)}[a.cmd](a)


if __name__ == "__main__":
    main()
