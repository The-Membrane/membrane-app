"""Q26 Round 13, item R13.4: standardized event library (encode -> pooled model -> decode) across asset classes.

membrane-board design/Q26_ROUND13_PREREG.md (R13.4, Deviations D-R13.4a ...), design/q26-r134-event-library-2026-10-18.md
(design note), design/q26-blind-set-inventory-2026-10-17.md (section 16: reserved sets of R13.4).

Owner goal (2026-10-18): "Our biggest bottleneck is training events. If we can standardize data between assets, and
potentially across asset classes, we can generate more events to train on." Owner direction (2026-10-18): "get the price
data as abstract as possible and then retransform it on output" -> explicit encode -> model -> decode architecture.

Commands
  build-b3     B3 (Brazil) COTAHIST yearly files 2000..2026, streamed (zip deleted after parse). Equities (CODBDI 02,
               ESPECI ON/PN/UNT, spot market) and ETF/fund certificates (CODBDI 14, ESPECI CI). Split by
               sha256('Q26-R13.4:' + key): byte % 3 == 0 -> dev (readable), 1 -> set A (locked), 2 -> set B (locked).
               key = company root (first 4 ticker chars) for equities, the ticker for ETFs. Prints counts only.
  build-hd     HistData.com free M1 ASCII bars (FX, index CFDs, commodity CFDs), streamed per year; daily and hourly
               OHLC bars. FX: split by sha256 of the pair as B3. Index and commodity CFDs (too few assets for an asset
               split): time split, dev = outcome windows ending <= 2017-12-31, A = 2018-01-01..2021-12-31,
               B = 2022-01-01..2026-09-30 (the full series is stored locked; the dev copy is truncated).
  select-p3b   crypto: Binance USDT pairs first listed in 2025 (P3b, 96) split by sha256('Q26-R13.4-P3b:' + symbol),
               first byte even -> P3b-a (confirm), odd -> P3b-b (held back); 2026 listings (P3c) held back whole.
               Listing data only (blind-7 snapshot); no kline read.
  dev          development on dev slices only (crypto seen pool + dev slices of the new classes): encoder fit,
               round-trip identity check, collapse metrics, event counts, pooled-library vs per-asset scores, power.

No address, key or secret is read or written. Raw vendor files are not republished; manifests carry sha256 values.
"""
from __future__ import annotations

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import http.client  # noqa: E402
import concurrent.futures as cf  # noqa: E402
import hashlib  # noqa: E402
import io  # noqa: E402
import json  # noqa: E402
import math  # noqa: E402
import re  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402
import urllib.error  # noqa: E402
import urllib.parse  # noqa: E402
import urllib.request  # noqa: E402
import zipfile  # noqa: E402
from datetime import datetime, timezone  # noqa: E402

import numpy as np  # noqa: E402

DAY = 86400
UA = {"User-Agent": "Mozilla/5.0 (research; Q26 R13.4)"}
SALT = "Q26-R13.4:"
SALT_P3B = "Q26-R13.4-P3b:"
TIME_SPLIT = {"dev_end": "2017-12-31", "A": ("2018-01-01", "2021-12-31"), "B": ("2022-01-01", "2026-09-30")}
END_DATE = "2026-09-30"


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def write_json(path, obj):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w") as f:
        json.dump(obj, f, indent=1, sort_keys=True)


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def split3(key):
    b = hashlib.sha256((SALT + key).encode()).digest()[0]
    return ("dev", "A", "B")[b % 3]


def http_get(url, data=None, headers=None, tries=6, timeout=180):
    h = dict(UA)
    h.update(headers or {})
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, data=data, headers=h)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except (urllib.error.URLError, TimeoutError, ConnectionError, http.client.HTTPException, OSError) as e:
            last = e
            if isinstance(e, urllib.error.HTTPError) and e.code == 404:
                raise
            time.sleep(2 + 3 * i)
    raise RuntimeError(f"GET failed {url}: {last}")


def date_days(ymd):
    """'YYYYMMDD' or 'YYYY-MM-DD' -> days since epoch."""
    s = ymd.replace("-", "")
    return int(datetime(int(s[:4]), int(s[4:6]), int(s[6:8]), tzinfo=timezone.utc).timestamp()) // DAY


# =============================================================================================
# B3 COTAHIST
# =============================================================================================
B3_URL = "https://bvmf.bmfbovespa.com.br/InstDados/SerHist/COTAHIST_A{y}.ZIP"
EQ_ESPECI = ("ON", "PN", "UNT")


def b3_class(codbdi, especi, nomres):
    if codbdi == "02" and especi.startswith(EQ_ESPECI):
        return "equity"
    if codbdi == "14" and especi.startswith("CI") and not nomres.startswith(("FII", "FIDC")):
        return "etf"
    return None


def cmd_build_b3(a):
    out = a.out
    years = list(range(a.y0, a.y1 + 1))
    store = {}          # ticker -> dict of lists
    manifest = []
    tmp = os.path.join(out, "_tmp")
    os.makedirs(tmp, exist_ok=True)
    for y in years:
        url = B3_URL.format(y=y)
        zp = os.path.join(tmp, f"c{y}.zip")
        raw = http_get(url, timeout=600)
        with open(zp, "wb") as f:
            f.write(raw)
        sha = hashlib.sha256(raw).hexdigest()
        del raw
        n_keep = 0
        with zipfile.ZipFile(zp) as z:
            name = z.namelist()[0]
            with z.open(name) as fh:
                for line in io.TextIOWrapper(fh, encoding="latin-1"):
                    if not line.startswith("01"):
                        continue
                    codbdi = line[10:12]
                    if codbdi not in ("02", "14"):
                        continue
                    if line[24:27] != "010":
                        continue
                    especi = line[39:49].strip()
                    nomres = line[27:39].strip()
                    cls = b3_class(codbdi, especi, nomres)
                    if cls is None:
                        continue
                    tick = line[12:24].strip()
                    fat = int(line[210:217]) or 1
                    rec = store.setdefault(tick, {"cls": cls, "d": [], "o": [], "h": [], "l": [], "c": [], "n": [],
                                                  "dis": [], "isin": []})
                    rec["d"].append(date_days(line[2:10]))
                    rec["o"].append(int(line[56:69]) / 100.0 / fat)
                    rec["h"].append(int(line[69:82]) / 100.0 / fat)
                    rec["l"].append(int(line[82:95]) / 100.0 / fat)
                    rec["c"].append(int(line[108:121]) / 100.0 / fat)
                    rec["n"].append(int(line[147:152]))
                    rec["dis"].append(int(line[242:245]) if line[242:245].strip().isdigit() else -1)
                    rec["isin"].append(line[230:242])
                    n_keep += 1
        os.remove(zp)
        manifest.append({"year": y, "url": url, "sha256": sha, "rows_kept": n_keep})
        print(f"{now_iso()} B3 {y}: rows kept {n_keep}, tickers so far {len(store)}", flush=True)
    counts = {}
    for tick, rec in store.items():
        cls = rec["cls"]
        key = tick[:4] if cls == "equity" else tick
        sp = split3(key)
        d = np.array(rec["d"], np.int32)
        o = np.argsort(d, kind="mergesort")
        d = d[o]
        keep = np.concatenate([[True], np.diff(d) > 0])     # one row per day (first after sort)
        isin = np.array(rec["isin"])[o][keep]
        arr = {k: np.array(rec[k], np.float64)[o][keep] for k in ("o", "h", "l", "c")}
        arr["n"] = np.array(rec["n"], np.int32)[o][keep]
        arr["dis"] = np.array(rec["dis"], np.int32)[o][keep]
        arr["isin_chg"] = np.concatenate([[False], isin[1:] != isin[:-1]])
        arr["d"] = d[keep]
        sub = "dev" if sp == "dev" else f"locked/{sp}"
        p = os.path.join(out, "b3", sub, f"{cls}-{tick}.npz")
        os.makedirs(os.path.dirname(p), exist_ok=True)
        np.savez_compressed(p, **arr)
        c = counts.setdefault(f"{cls}/{sp}", {"tickers": 0, "keys": set(), "rows": 0, "first_year": {}})
        c["tickers"] += 1
        c["keys"].add(key)
        c["rows"] += int(len(arr["d"]))
        fy = str(datetime.fromtimestamp(int(arr["d"][0]) * DAY, timezone.utc).year)
        c["first_year"][fy] = c["first_year"].get(fy, 0) + 1
    for c in counts.values():
        c["keys"] = len(c["keys"])
    write_json(os.path.join(out, "b3", "manifest-b3.json"), {"created_utc": now_iso(), "files": manifest,
                                                             "salt": SALT, "counts": counts})
    print(json.dumps(counts, indent=1, sort_keys=True))


# =============================================================================================
# HistData.com M1 ASCII
# =============================================================================================
HD_BASE = "https://www.histdata.com"
HD_PAGE = HD_BASE + "/download-free-forex-historical-data/?/ascii/1-minute-bar-quotes/{p}/{y}"
HD_YEARS = HD_BASE + "/download-free-forex-historical-data/?/ascii/1-minute-bar-quotes/{p}"
HD_INDEX = {"AUXAUD", "ETXEUR", "FRXEUR", "GRXEUR", "HKXHKD", "JPXJPY", "NSXUSD", "SPXUSD", "UDXUSD", "UKXGBP"}
HD_COMMOD = {"BCOUSD", "WTIUSD", "XAGUSD", "XAUAUD", "XAUCHF", "XAUEUR", "XAUGBP", "XAUUSD"}
EST = 5 * 3600                 # HistData ASCII timestamps: EST without daylight saving (UTC-5)
FX_DAY_SHIFT = 2 * 3600        # bar day starts 17:00 EST = 22:00 UTC: (t + 2 h) % 1 d == 0


def hd_class(p):
    return "index" if p in HD_INDEX else ("commodity" if p in HD_COMMOD else "fx")


def hd_instruments():
    t = http_get(HD_BASE + "/download-free-forex-data/?/ascii/1-minute-bar-quotes").decode("utf-8", "replace")
    return sorted(set(re.findall(r'1-minute-bar-quotes/([a-z0-9]+)"', t, flags=re.I)), key=str.upper)


def hd_periods(p):
    t = http_get(HD_YEARS.format(p=p.lower())).decode("utf-8", "replace")
    per = sorted(set(re.findall(rf'1-minute-bar-quotes/{p.lower()}/(\d{{4}}(?:/\d{{1,2}})?)"', t, flags=re.I)))
    return per


def hd_fetch(p, per):
    page_url = HD_PAGE.format(p=p.lower(), y=per)
    req = urllib.request.Request(page_url, headers=UA)
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor())
    for i in range(6):
        try:
            t = opener.open(req, timeout=120).read().decode("utf-8", "replace")
            tk = re.search(r'name="tk" id="tk" value="([^"]+)"', t).group(1)
            date = re.search(r'name="date" id="date" value="([^"]*)"', t).group(1)
            dm = re.search(r'name="datemonth" id="datemonth" value="([^"]*)"', t).group(1)
            body = urllib.parse.urlencode({"tk": tk, "date": date, "datemonth": dm, "platform": "ASCII",
                                           "timeframe": "M1", "fxpair": p.upper()}).encode()
            r2 = urllib.request.Request(HD_BASE + "/get.php", data=body,
                                        headers=dict(UA, Referer=page_url))
            raw = opener.open(r2, timeout=300).read()
            if raw[:2] != b"PK":
                raise RuntimeError("not a zip")
            return raw
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(3 + 5 * i)
    raise RuntimeError(f"histdata failed {p} {per}: {last}")


def days_from_civil(y, m, d):
    y = y - (m <= 2)
    era = np.floor_divide(y, 400)
    yoe = y - era * 400
    doy = (153 * (m + np.where(m > 2, -3, 9)) + 2) // 5 + d - 1
    doe = yoe * 365 + yoe // 4 - yoe // 100 + doy
    return era * 146097 + doe - 719468


def hd_parse(raw):
    """-> int64 utc seconds, o, h, l, c arrays (minute bars)."""
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        name = [n for n in z.namelist() if n.lower().endswith(".csv")][0]
        txt = z.read(name).replace(b" ", b";")
    a = np.loadtxt(io.BytesIO(txt), delimiter=";", dtype=np.float64, ndmin=2)
    d = a[:, 0].astype(np.int64)
    hm = a[:, 1].astype(np.int64)
    days = days_from_civil(d // 10000, (d // 100) % 100, d % 100)
    t = days * DAY + (hm // 10000) * 3600 + ((hm // 100) % 100) * 60 + EST
    return t.astype(np.int64), a[:, 2], a[:, 3], a[:, 4], a[:, 5]


def aggregate(t, o, h, l, c, width, shift):
    """bars of `width` seconds with boundary at shift (utc seconds); -> dict with bucket start, o h l c, minutes."""
    k = (t + shift) // width
    order = np.argsort(t, kind="mergesort")
    t, o, h, l, c, k = t[order], o[order], h[order], l[order], c[order], k[order]
    brk = np.concatenate([[0], np.where(np.diff(k) != 0)[0] + 1])
    return {"b": (k[brk] * width - shift).astype(np.int64),
            "o": o[brk], "h": np.maximum.reduceat(h, brk), "l": np.minimum.reduceat(l, brk),
            "c": c[np.concatenate([brk[1:] - 1, [len(c) - 1]])], "m": np.diff(np.concatenate([brk, [len(c)]]))}


def hd_one(p, out):
    cls = hd_class(p)
    sp = split3(p) if cls == "fx" else "time"
    pers = hd_periods(p)
    T = {k: [] for k in ("t", "o", "h", "l", "c")}
    man = []
    for per in pers:
        raw = hd_fetch(p, per)
        man.append({"period": per, "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)})
        t, o, h, l, c = hd_parse(raw)
        del raw
        for k, v in zip(("t", "o", "h", "l", "c"), (t, o, h, l, c)):
            T[k].append(v)
    t = np.concatenate(T["t"])
    o, h, l, c = (np.concatenate(T[k]) for k in ("o", "h", "l", "c"))
    _, u = np.unique(t, return_index=True)
    t, o, h, l, c = t[u], o[u], h[u], l[u], c[u]
    dly = aggregate(t, o, h, l, c, DAY, FX_DAY_SHIFT)
    hrs = aggregate(t, o, h, l, c, 3600, 0)
    dly["d"] = ((dly["b"] + FX_DAY_SHIFT) // DAY).astype(np.int32)     # bar day label (day containing the close)
    base = {f"d_{k}": v for k, v in dly.items()}
    base.update({f"h_{k}": v for k, v in hrs.items()})
    if cls == "fx":
        sub = "dev" if sp == "dev" else f"locked/{sp}"
        np.savez_compressed(os.path.join(out, "hd", sub, f"{cls}-{p}.npz"), **base)
    else:
        np.savez_compressed(os.path.join(out, "hd", "locked/time", f"{cls}-{p}.npz"), **base)
        cut = date_days(TIME_SPLIT["dev_end"])
        dv = {k: v[dly["d"] <= cut] for k, v in dly.items()}
        hv_ok = hrs["b"] < (cut + 1) * DAY - FX_DAY_SHIFT
        dev = {f"d_{k}": v for k, v in dv.items()}
        dev.update({f"h_{k}": v[hv_ok] for k, v in hrs.items()})
        np.savez_compressed(os.path.join(out, "hd", "dev", f"{cls}-{p}.npz"), **dev)
    first = datetime.fromtimestamp(int(t[0]), timezone.utc).strftime("%Y-%m")
    return {"pair": p, "class": cls, "split": sp, "periods": man, "minutes": int(len(t)), "daily_bars": int(len(dly["b"])),
            "first_month": first}


def cmd_build_hd(a):
    out = a.out
    for s in ("dev", "locked/A", "locked/B", "locked/time"):
        os.makedirs(os.path.join(out, "hd", s), exist_ok=True)
    inst = [x.upper() for x in hd_instruments()]
    if a.only:
        inst = [x for x in inst if x in set(a.only.split(","))]
    print(f"{now_iso()} {len(inst)} instruments", flush=True)
    res = []
    with cf.ThreadPoolExecutor(a.workers) as ex:
        futs = {ex.submit(hd_one, p, out): p for p in inst}
        for f in cf.as_completed(futs):
            r = f.result()
            res.append(r)
            print(f"{now_iso()} {r['pair']} {r['class']} {r['split']} first {r['first_month']} "
                  f"periods {len(r['periods'])} daily bars {r['daily_bars']}", flush=True)
    res.sort(key=lambda r: r["pair"])
    counts = {}
    for r in res:
        k = f"{r['class']}/{r['split']}"
        c = counts.setdefault(k, {"instruments": 0, "first_months": []})
        c["instruments"] += 1
        c["first_months"].append(r["first_month"])
    write_json(os.path.join(out, "hd", "manifest-hd.json"), {"created_utc": now_iso(), "instruments": res,
                                                             "salt": SALT, "time_split": TIME_SPLIT,
                                                             "counts": counts})
    print(json.dumps(counts, indent=1, sort_keys=True))


# =============================================================================================
# crypto P3b / P3c listing split
# =============================================================================================
def cmd_select_p3b(a):
    sel = json.load(open(os.path.join(a.datasets, "blind7-prices", "binance-selection.json")))
    p3b, p3c = [], []
    for x in sel["window"]:
        if x.get("excluded"):
            continue
        y = (x.get("firstKlineOpen") or "")[:4]
        if y == "2025":
            p3b.append(x["symbol"])
        elif y == "2026":
            p3c.append(x["symbol"])
    a_, b_ = [], []
    for s in sorted(p3b):
        (a_ if hashlib.sha256((SALT_P3B + s).encode()).digest()[0] % 2 == 0 else b_).append(s)
    obj = {"created_utc": now_iso(), "source": "membrane-datasets blind7-prices/binance-selection.json (listing "
           "snapshot; firstKlineOpen only)", "rule": "not excluded in the blind-7 snapshot; first 1 h kline in 2025 "
           "-> P3b, in 2026 -> P3c. P3b split by sha256('Q26-R13.4-P3b:' + symbol) first byte even -> P3b-a",
           "P3b_a": a_, "P3b_b": b_, "P3c": sorted(p3c)}
    write_json(a.out, obj)
    print(f"P3b-a {len(a_)}, P3b-b {len(b_)}, P3c {len(p3c)}; sha256 {sha256_file(a.out)}")



# =============================================================================================
# development: encode -> pooled model -> decode
# =============================================================================================
CLASSES = ("crypto", "equity", "etf", "fx", "index", "commodity")
H_BARS = (1, 3, 5, 10, 20)
CRYPTO_LEVELS = (-0.15, -0.20, -0.25, -0.30, -0.40)
CRYPTO_H = (1, 3, 5)
Z_GRID = (-1.0, -1.5, -2.0, -2.5, -3.0, -3.5, -4.0, -5.0, -6.0)
LN2X4 = 4.0 * math.log(2.0)
VFLOOR = 0.1                      # D and W floored at 0.1 x M (flat bars)
OWN_MIN = 60                      # own-history comparators need >= 60 resolved rows
YOUNG_BARS = 365
MON0D = 4                         # 1970-01-05 (Monday) = day 4
CA_GAP = 0.10                     # B3: a distribution-number change with an open gap above 10% is a corporate action


def week_of(day):
    return (np.asarray(day, np.int64) - MON0D) // 7


def roll_mean(x, w, need):
    """trailing mean over x[t-w+1..t] with >= need finite values, else nan."""
    f = np.isfinite(x)
    cs = np.concatenate([[0.0], np.cumsum(np.where(f, x, 0.0))])
    cn = np.concatenate([[0], np.cumsum(f)])
    i = np.arange(len(x))
    lo = np.maximum(i - w + 1, 0)
    s, n = cs[i + 1] - cs[lo], cn[i + 1] - cn[lo]
    out = np.where(n >= need, s / np.maximum(n, 1), np.nan)
    out[:w - 1] = np.nan
    return out


def fwd_window(x, h, fn):
    """x[t+1..t+h] reduced by fn ('mean'|'min'), nan if any value is not finite."""
    n = len(x)
    out = np.full(n, np.nan)
    if n <= h:
        return out
    from numpy.lib.stride_tricks import sliding_window_view
    W = sliding_window_view(x[1:], h)          # W[t] = x[t+1..t+h]
    r = W.mean(axis=1) if fn == "mean" else W.min(axis=1)
    out[:len(r)] = r
    return out


def bars_crypto(close, low, high, base_ts):
    n = len(close)
    off = int(base_ts % DAY) // 3600
    pad = (-(off) % 24) if off else 0
    # align to 00:00Z: drop the partial first day
    skip = (24 - off) % 24
    c, l, h = close[skip:], low[skip:], high[skip:]
    nd = len(c) // 24
    c, l, h = (x[:nd * 24].reshape(nd, 24) for x in (c, l, h))
    ok = np.isfinite(c) & np.isfinite(l) & np.isfinite(h)
    day0 = (int(base_ts) + skip * 3600) // DAY
    valid = (ok.sum(axis=1) >= 23) & ok[:, 23]
    with np.errstate(all="ignore"):
        L = np.nanmin(np.where(ok, l, np.nan), axis=1)
        H = np.nanmax(np.where(ok, h, np.nan), axis=1)
    C = c[:, 23]
    O = np.r_[np.nan, C[:-1]]
    d = day0 + np.arange(nd)
    del pad
    return {"d": d.astype(np.int32), "o": O, "h": H, "l": L, "c": C, "valid": valid,
            "gapok": np.zeros(nd, bool), "ca": np.zeros(nd, bool)}


def load_crypto_spec(spec):
    import r12_tail as R12  # noqa: E402
    kind = spec["kind"]
    if kind == "chain":
        ser, _, caps = R12.load_series(spec)
        close, low, high, st = ser.close, ser.low, ser.high, ser.base_ts
        cap = caps["primary"]
    elif kind == "npz":
        dd = np.load(spec["path"])
        st = int(dd["startTs"])
        close, low, high = (np.asarray(dd[k], float) for k in ("close", "low", "high"))
        cap = int(spec["cap_primary"])
    else:
        st, cols = R12.load_json_grid(spec["path"])
        close, low, high = cols["close"], cols["low"], cols["high"]
        if "slice" in spec:
            i0, i1 = spec["slice"]
            st = st + 3600 * i0
            close, low, high = close[i0:i1], low[i0:i1], high[i0:i1]
        cap = int(spec.get("cap_primary", R12.END))
    B = bars_crypto(np.asarray(close, float), np.asarray(low, float), np.asarray(high, float), st)
    B["cap_day"] = min(int(cap), int(R12.END)) // DAY        # a window must end on or before this day boundary
    return B


def crypto_dev_specs(datasets, tmp):
    import r12_tail as R12  # noqa: E402
    import r13_recal as R13  # noqa: E402
    out = []
    for s in R12.dev_specs(datasets):
        out.append(("pool", s))
    for nm, fn in (("b9", lambda: R13.b9_specs(datasets, tmp)), ("b12", lambda: R13.b12_specs(datasets)),
                   ("b13a", lambda: R13.b13a_specs(datasets))):
        for s in fn():
            out.append((nm, s))
    return out


def _crypto_task(a):
    sub, spec = a
    try:
        B = load_crypto_spec(spec)
    except Exception as e:  # noqa: BLE001
        return {"key": spec["key"], "err": repr(e)}
    B.update(key=spec["key"], cls="crypto", sub=sub, asset=spec.get("asset", spec["key"]))
    return B


def bars_b3(path, cal):
    z = np.load(path)
    d = z["d"]
    idx = np.searchsorted(cal, d)
    n = len(cal)
    out = {k: np.full(n, np.nan) for k in ("o", "h", "l", "c")}
    for k in ("o", "h", "l", "c"):
        out[k][idx] = z[k]
    ntr = np.zeros(n, np.int64)
    ntr[idx] = z["n"]
    have = np.zeros(n, bool)
    have[idx] = True
    valid = have & (ntr >= 10) & (out["l"] > 0) & (out["h"] >= out["l"]) & (out["c"] > 0) & (out["o"] > 0)
    # corporate action: distribution number or ISIN changes at a row with a large open gap
    dis = z["dis"]
    c_prev = np.r_[np.nan, z["c"][:-1]]
    with np.errstate(all="ignore"):
        gap = np.abs(np.log(z["o"] / c_prev))
    ca_row = ((np.r_[False, dis[1:] != dis[:-1]] & (gap > CA_GAP)) | z["isin_chg"])
    ca = np.zeros(n, bool)
    ca[idx[ca_row]] = True
    first, last = idx[0], idx[-1]
    sl = slice(first, last + 1)
    gapok = np.r_[False, valid[:-1]]
    B = {"d": cal[sl].astype(np.int32), "valid": valid[sl], "gapok": gapok[sl], "ca": ca[sl]}
    for k in ("o", "h", "l", "c"):
        B[k] = out[k][sl]
    B["cap_day"] = date_days(END_DATE) + 1
    return B


def bars_hd(path):
    z = np.load(path)
    m = z["d_m"].astype(float)
    med = np.median(m) if len(m) else 0
    d = z["d_d"].astype(np.int32)
    valid = (m >= 0.25 * med) & (z["d_l"] > 0) & (z["d_h"] >= z["d_l"])
    gapok = np.r_[False, (np.diff(d) <= 4) & valid[:-1]]
    B = {"d": d, "o": z["d_o"].astype(float), "h": z["d_h"].astype(float), "l": z["d_l"].astype(float),
         "c": z["d_c"].astype(float), "valid": valid, "gapok": gapok, "ca": np.zeros(len(d), bool)}
    B["cap_day"] = min(int(d[-1]) + 1, date_days(END_DATE) + 1) if len(d) else 0
    return B


def encode_inputs(B):
    """ex-ante encoder inputs per bar t (all from bars <= t) and forward targets (bars t+1..t+h)."""
    o, h, l, c, valid = B["o"], B["h"], B["l"], B["c"], B["valid"]
    with np.errstate(all="ignore"):
        lc = np.log(c)
        gap = np.where(B["gapok"], np.log(o) - np.r_[np.nan, lc[:-1]], 0.0)
        v = (np.log(h) - np.log(l)) ** 2 / LN2X4 + np.where(np.isfinite(gap), gap, 0.0) ** 2
    v[~valid] = np.nan
    M = roll_mean(v, 22, 20)
    W = roll_mean(v, 5, 4)
    with np.errstate(all="ignore"):
        D = np.maximum(v, VFLOOR * M)
        Wf = np.maximum(W, VFLOOR * M)
        X = np.stack([np.ones(len(v)), np.log(D), np.log(Wf), np.log(M)], axis=1)
        lv = np.log(np.maximum(v, VFLOOR * M))
    okX = np.all(np.isfinite(X), axis=1) & valid
    # regime features
    f = np.isfinite(lv)
    cs = np.concatenate([[0.0], np.cumsum(np.where(f, lv, 0))])
    cs2 = np.concatenate([[0.0], np.cumsum(np.where(f, lv * lv, 0))])
    cn = np.concatenate([[0], np.cumsum(f)])
    i = np.arange(len(v))
    lo = np.maximum(i - 21, 0)
    n_ = cn[i + 1] - cn[lo]
    mu = (cs[i + 1] - cs[lo]) / np.maximum(n_, 1)
    vov = np.sqrt(np.maximum((cs2[i + 1] - cs2[lo]) / np.maximum(n_, 1) - mu * mu, 0))
    vov[n_ < 20] = np.nan
    with np.errstate(all="ignore"):
        vr = 0.5 * np.log(Wf / M)
    lcv = np.where(valid, lc, np.nan)
    tr_raw = lcv - np.r_[np.full(21, np.nan), lcv[:-21]] if len(lcv) > 21 else np.full(len(lcv), np.nan)
    from numpy.lib.stride_tricks import sliding_window_view
    mx = np.full(len(lcv), np.nan)
    if len(lcv) >= 66:
        mx[65:] = np.nanmax(np.where(np.isfinite(sliding_window_view(lcv, 66)), sliding_window_view(lcv, 66), -np.inf),
                            axis=1)
    dd_raw = lcv - mx
    # CA exclusion: any corporate-action bar in [t-21, t+h] removes origin t (lookback part here)
    ca = B["ca"].astype(float)
    cca = np.concatenate([[0.0], np.cumsum(ca)])
    ca_back = (cca[i + 1] - cca[np.maximum(i - 21, 0)]) > 0
    fwd = {}
    vv = np.where(valid, v, np.nan)
    ll = np.where(valid, l, np.nan)
    for hh in H_BARS:
        rv = fwd_window(vv, hh, "mean")
        wm = fwd_window(ll, hh, "min")
        ca_f = (cca[np.minimum(i + hh + 1, len(ca))] - cca[i + 1]) > 0
        end_day = np.r_[B["d"][hh:], np.full(hh, 10 ** 9)][:len(v)] if len(v) > hh else np.full(len(v), 10 ** 9)
        ok = np.isfinite(wm) & okX & np.isfinite(lcv) & ~ca_back & ~ca_f & (end_day + 1 <= B["cap_day"])
        fwd[hh] = {"rv": rv, "wmin": wm, "ok": ok, "end_day": end_day}
    return {"X": X, "okX": okX, "lc": lcv, "vov": vov, "vr": vr, "tr_raw": tr_raw, "dd_raw": dd_raw, "fwd": fwd,
            "age": i - int(np.argmax(valid)) if valid.any() else i}


def q2_overlap(day, end_day):
    q0, q1 = date_days("2026-04-01"), date_days("2026-06-30")
    return (end_day >= q0) & (day <= q1)


def wecdf(m, w):
    o = np.argsort(m, kind="mergesort")
    ms, cw = m[o], np.cumsum(w[o])
    return ms, cw / cw[-1]


def wecdf_at(lib, z):
    ms, cw = lib
    k = np.searchsorted(ms, z, side="right")
    return np.where(k > 0, cw[np.maximum(k - 1, 0)], 0.0)


def brier(p, y):
    return float(np.mean((p - y) ** 2))


def own_ecdf_asof(day, end_day, m, zq):
    """per series: at each origin, share of own resolved rows (end_day' < day) with m' <= zq (rows x levels);
    nan if fewer than OWN_MIN resolved rows (chunked dense comparison)."""
    n = len(m)
    out = np.full(zq.shape, np.nan)
    for a0 in range(0, n, 512):
        a1 = min(n, a0 + 512)
        res = end_day[None, :] < day[a0:a1, None]                 # (chunk, n)
        cnt = res.sum(axis=1)
        for kk in range(zq.shape[1]):
            le = m[None, :] <= zq[a0:a1, kk][:, None]
            s_ = (res & le).sum(axis=1)
            with np.errstate(all="ignore"):
                out[a0:a1, kk] = np.where(cnt >= OWN_MIN, s_ / np.maximum(cnt, 1), np.nan)
    return out


def own_freq_asof(day, end_day, Y):
    order = np.argsort(end_day, kind="mergesort")
    ed = end_day[order]
    cy = np.vstack([np.zeros((1, Y.shape[1])), np.cumsum(Y[order], axis=0)])
    k = np.searchsorted(ed, day, side="left")
    with np.errstate(all="ignore"):
        out = cy[k] / k[:, None]
    out[k < OWN_MIN] = np.nan
    return out


def boot_se_weeks(g, d, nb=500, seed=0):
    rng = np.random.default_rng(seed)
    u, inv = np.unique(g, return_inverse=True)
    sums = np.bincount(inv, weights=d, minlength=len(u))
    cnts = np.bincount(inv, minlength=len(u))
    G = len(u)
    idx = rng.integers(0, G, (nb, G))
    bs = sums[idx].sum(axis=1) / np.maximum(cnts[idx].sum(axis=1), 1)
    return float(np.std(bs)), sums, cnts


def cmd_dev(a):
    import multiprocessing as mp
    os.makedirs(a.out, exist_ok=True)
    logf = open(os.path.join(a.out, "dev.log"), "a")

    def log(s):
        line = f"{now_iso()} {s}"
        print(line, flush=True)
        logf.write(line + "\n")
        logf.flush()

    log(f"R13.4 dev start; code {git_sha()}")
    # ---------------- load dev series ----------------
    series = []
    specs = crypto_dev_specs(a.datasets, os.path.join(a.out, "acq_r12"))
    if a.crypto_limit:
        specs = specs[:a.crypto_limit]
    with mp.get_context("fork").Pool(a.workers) as pool:
        for r in pool.imap_unordered(_crypto_task, specs, chunksize=4):
            if "err" in r:
                log(f"  crypto load error {r['key']}: {r['err']}")
                continue
            series.append(r)
    log(f"crypto series {len(series)}")
    b3dir = os.path.join(a.data, "b3", "dev")
    files = sorted(os.listdir(b3dir)) if os.path.isdir(b3dir) and not a.skip_new else []
    cal = np.unique(np.concatenate([np.load(os.path.join(b3dir, f))["d"] for f in files])) if files else None
    for f in files:
        B = bars_b3(os.path.join(b3dir, f), cal)
        cls, tick = f[:-4].split("-", 1)
        B.update(key=f"b3:{tick}", cls=cls, sub="b3", asset=tick)
        series.append(B)
    hddir = os.path.join(a.data, "hd", "dev")
    for f in (sorted(os.listdir(hddir)) if os.path.isdir(hddir) and not a.skip_new else []):
        cls, p = f[:-4].split("-", 1)
        B = bars_hd(os.path.join(hddir, f))
        B.update(key=f"hd:{p}", cls=cls, sub="hd", asset=p)
        series.append(B)
    log("series per class: " + ", ".join(f"{c} {sum(1 for s in series if s['cls'] == c)}" for c in CLASSES))
    # ---------------- encoder inputs ----------------
    for s in series:
        s["E"] = encode_inputs(s)
    # ---------------- fit the frozen vol forecast (pooled, class-equal weights) ----------------
    beta = {}
    for hh in H_BARS:
        Xs, ys, ws = [], [], []
        for c in CLASSES:
            Xc, yc = [], []
            for s in series:
                if s["cls"] != c:
                    continue
                F = s["E"]["fwd"][hh]
                ok = F["ok"] & np.isfinite(F["rv"]) & (F["rv"] > 0) & ~q2_overlap(s["d"], F["end_day"])
                Xc.append(s["E"]["X"][ok])
                yc.append(np.log(F["rv"][ok]))
            if not Xc or sum(len(x) for x in Xc) == 0:
                continue
            Xc, yc = np.vstack(Xc), np.concatenate(yc)
            Xs.append(Xc)
            ys.append(yc)
            ws.append(np.full(len(yc), 1.0 / len(yc)))
        X, y, w = np.vstack(Xs), np.concatenate(ys), np.concatenate(ws)
        sw = np.sqrt(w)
        b, *_ = np.linalg.lstsq(X * sw[:, None], y * sw, rcond=None)
        smear = float(np.sum(w * np.exp(y - X @ b)) / np.sum(w))      # Duan smearing: forecast the mean variance
        b = b.copy()
        b[0] += math.log(smear)
        beta[hh] = b
        log(f"encoder h={hh}: beta {np.round(b, 4).tolist()} (rows {len(y)})")
    # ---------------- encode: rows per h ----------------
    rows = {hh: {k: [] for k in ("cls", "sid", "day", "end", "m", "s", "vr", "vov", "tr", "dd", "age", "q2")}
            for hh in H_BARS}
    rt_err = 0.0
    meta = []
    for sid, s in enumerate(series):
        E = s["E"]
        meta.append({"key": s["key"], "cls": s["cls"], "sub": s["sub"], "asset": s["asset"]})
        with np.errstate(all="ignore"):
            s1 = np.sqrt(np.exp(E["X"] @ beta[1]))
        for hh in H_BARS:
            F = E["fwd"][hh]
            ok = F["ok"]
            if not ok.any():
                continue
            sig = np.sqrt(np.exp(E["X"][ok] @ beta[hh]))
            scale = sig * math.sqrt(hh)
            lc = E["lc"][ok]
            m = (np.log(F["wmin"][ok]) - lc) / scale
            dec = np.exp(lc + m * scale)                        # decode: back to the asset's price units
            rt_err = max(rt_err, float(np.nanmax(np.abs(dec / F["wmin"][ok] - 1.0))))
            R = rows[hh]
            R["cls"].append(np.full(ok.sum(), CLASSES.index(s["cls"]), np.int8))
            R["sid"].append(np.full(ok.sum(), sid, np.int32))
            R["day"].append(s["d"][ok])
            R["end"].append(F["end_day"][ok])
            R["m"].append(m)
            R["s"].append(scale)
            R["vr"].append(E["vr"][ok])
            R["vov"].append(E["vov"][ok])
            R["tr"].append(E["tr_raw"][ok] / (s1[ok] * math.sqrt(21)))
            R["dd"].append(E["dd_raw"][ok] / (s1[ok] * math.sqrt(66)))
            R["age"].append(np.asarray(E["age"])[ok])
            R["q2"].append(q2_overlap(s["d"][ok], F["end_day"][ok]))
        del s["E"]
    for hh in H_BARS:
        rows[hh] = {k: np.concatenate(v) for k, v in rows[hh].items()}
    log(f"round-trip identity (decode(encode(min low)) vs min low): max relative error {rt_err:.3e}")
    np.savez_compressed(os.path.join(a.out, "rows-r134-dev.npz"),
                        **{f"h{hh}_{k}": v for hh in H_BARS for k, v in rows[hh].items()})
    write_json(os.path.join(a.out, "meta-r134-dev.json"), {"series": meta, "beta": {str(k): v.tolist()
                                                           for k, v in beta.items()}, "round_trip_max_rel": rt_err})
    res = {"created_utc": now_iso(), "code_sha": git_sha(), "beta": {str(k): v.tolist() for k, v in beta.items()},
           "round_trip_max_rel_err": rt_err, "series_per_class": {c: sum(1 for s in meta if s["cls"] == c)
                                                                  for c in CLASSES}}
    res["collapse"] = collapse_metrics(rows, meta, log)
    res["events"] = event_counts(rows, meta, log)
    res["library_vs_asset"] = library_scores(rows, meta, log, a)
    write_json(os.path.join(a.out, "dev-r134.json"), res)
    log("dev done")


def git_sha():
    try:
        import subprocess
        return subprocess.check_output(["git", "-C", os.path.dirname(os.path.abspath(__file__)), "rev-parse",
                                        "--short=8", "HEAD"]).decode().strip()
    except Exception:  # noqa: BLE001
        return "unknown"


def class_ecdf_table(R, mask_extra=None):
    """F_c(z) per class with week-block bootstrap SE of ln F_c."""
    out = {}
    keep = ~R["q2"] if mask_extra is None else (~R["q2"] & mask_extra)
    for ci, c in enumerate(CLASSES):
        mk = keep & (R["cls"] == ci)
        if mk.sum() < 1000:
            continue
        m = R["m"][mk]
        g = week_of(R["day"][mk])
        ent = {"rows": int(mk.sum()), "assets": int(len(np.unique(R["sid"][mk]))), "weeks": int(len(np.unique(g))),
               "F": {}, "se_lnF": {}, "pos": {}}
        for z in Z_GRID:
            y = (m <= z).astype(float)
            F = y.mean()
            if y.sum() < 5:
                ent["F"][str(z)] = float(F)
                ent["se_lnF"][str(z)] = None
                ent["pos"][str(z)] = int(y.sum())
                continue
            se, _, _ = boot_se_weeks(g, y, nb=300, seed=int(-z * 10) + ci)
            ent["F"][str(z)] = float(F)
            ent["se_lnF"][str(z)] = float(se / F)
            ent["pos"][str(z)] = int(y.sum())
        out[c] = ent
    return out


def pooled_lib(R, mask, classes=None):
    """class-equal weighted ECDF of m over mask rows (optionally only some classes)."""
    ms, ws = [], []
    for ci, c in enumerate(CLASSES):
        if classes is not None and c not in classes:
            continue
        mk = mask & (R["cls"] == ci)
        n = int(mk.sum())
        if n < 1000:
            continue
        ms.append(R["m"][mk])
        ws.append(np.full(n, 1.0 / n))
    if not ms:
        return None
    return wecdf(np.concatenate(ms), np.concatenate(ws))


def collapse_metrics(rows, meta, log):
    from scipy.stats import chi2
    out = {}
    for hh in H_BARS:
        R = rows[hh]
        tab = class_ecdf_table(R)
        present = list(tab)
        ent = {"classes": tab, "loo_ratio": {}, "het": {}, "lambda": {}, "regime": {}}
        keep = ~R["q2"]
        # leave-one-class-out library vs realized class curve
        for c in present:
            lib = pooled_lib(R, keep, classes=[x for x in present if x != c])
            if lib is None:
                continue
            ent["loo_ratio"][c] = {str(z): (float(wecdf_at(lib, z) / tab[c]["F"][str(z)])
                                            if tab[c]["F"][str(z)] > 0 else None) for z in Z_GRID}
        # heterogeneity Q per z (inverse-variance on ln F)
        for z in Z_GRID:
            lf, vv = [], []
            for c in present:
                F, se = tab[c]["F"][str(z)], tab[c]["se_lnF"][str(z)]
                if F > 0 and se:
                    lf.append(math.log(F))
                    vv.append(se * se)
            if len(lf) >= 2:
                lf, vv = np.array(lf), np.array(vv)
                mu = np.sum(lf / vv) / np.sum(1 / vv)
                Q = float(np.sum((lf - mu) ** 2 / vv))
                ent["het"][str(z)] = {"Q": Q, "df": len(lf) - 1, "p": float(chi2.sf(Q, len(lf) - 1)),
                                      "max_abs_lnratio_to_pooled": float(np.max(np.abs(lf - mu)))}
        # per-class tail scale lambda: F_c(z) ~ F_pool(z / lambda)
        lib_all = pooled_lib(R, keep, classes=present)
        zz = np.array([z for z in Z_GRID if -4.0 <= z <= -1.5])
        for c in present:
            Fc = np.array([tab[c]["F"][str(z)] for z in zz])
            if np.any(Fc <= 0):
                continue
            best = None
            for lam in np.arange(0.5, 2.01, 0.01):
                e = np.sum((np.log(Fc) - np.log(np.maximum(wecdf_at(lib_all, zz / lam), 1e-12))) ** 2)
                if best is None or e < best[1]:
                    best = (float(lam), float(e))
            ent["lambda"][c] = {"lambda": round(best[0], 3), "sse_ln": best[1]}
        # regime: vol-ratio terciles (pooled cutpoints)
        q = np.nanquantile(R["vr"][keep], [1 / 3, 2 / 3])
        for ti, (lo, hi) in enumerate(((-np.inf, q[0]), (q[0], q[1]), (q[1], np.inf))):
            mk = keep & (R["vr"] > lo) & (R["vr"] <= hi)
            t2 = class_ecdf_table(R, mk & keep)
            ent["regime"][f"vr_t{ti + 1}"] = {c: {str(z): t2[c]["F"][str(z)] for z in (-2.0, -3.0, -4.0)}
                                             for c in t2}
        ent["regime"]["vr_cut"] = q.tolist()
        out[str(hh)] = ent
        line = "; ".join(f"{c} F(-3)={tab[c]['F']['-3.0']:.2e} loo R(-3)={(ent['loo_ratio'].get(c, {}).get('-3.0') or float('nan')):.2f}"
                         f" lam={ent['lambda'].get(c, {}).get('lambda')}" for c in present)
        log(f"collapse h={hh}: {line}")
    return out


def episodes_count(day, sid, pos, gap):
    n = 0
    for s in np.unique(sid[pos]):
        d = np.sort(day[pos & (sid == s)])
        n += 1 + int(np.sum(np.diff(d) > gap))
    return n


def event_counts(rows, meta, log):
    out = {}
    for hh in H_BARS:
        R = rows[hh]
        keep = ~R["q2"]
        ent = {}
        for ci, c in enumerate(CLASSES):
            mk = keep & (R["cls"] == ci)
            if not mk.any():
                continue
            e = {"rows": int(mk.sum())}
            for z in (-3.0, -4.0, -5.0):
                pos = mk & (R["m"] <= z)
                e[f"z{z}"] = {"origins": int(pos.sum()), "episodes": episodes_count(R["day"], R["sid"], pos, hh + 5),
                              "pos_weeks": int(len(np.unique(week_of(R["day"][pos])))),
                              "assets": int(len(np.unique(R["sid"][pos])))}
            ent[c] = e
        if hh in CRYPTO_H:
            mk = keep & (R["cls"] == 0)
            for k in CRYPTO_LEVELS:
                pos = mk & (R["m"] <= math.log(1 + k) / R["s"])
                ent.setdefault("crypto_raw", {})[str(k)] = {
                    "origins": int(pos.sum()), "episodes": episodes_count(R["day"], R["sid"], pos, hh + 5),
                    "pos_weeks": int(len(np.unique(week_of(R["day"][pos]))))}
        out[str(hh)] = ent
        log(f"events h={hh}: " + "; ".join(f"{c} z<=-3 ep {v['z-3.0']['episodes']} wk {v['z-3.0']['pos_weeks']}"
                                           for c, v in ent.items() if c != "crypto_raw"))
    return out


def library_scores(rows, meta, log, a):
    """crypto deep cells, scored on seen B12 and B9 (stand-ins for the reserved crypto sets), library built without
    the scored set. Comparators: own as-of ECDF (own), own frequency (a), crypto-dev frequency (e)."""
    import r12_tail as R12  # noqa: E402
    subs = np.array([m["sub"] for m in meta])
    FH = np.load(a.fh, allow_pickle=False) if getattr(a, "fh", "") else None
    out = {}
    for hh in CRYPTO_H:
        R = rows[hh]
        keep = ~R["q2"]
        isc = R["cls"] == 0
        zk = np.stack([np.log(1 + k) / R["s"] for k in CRYPTO_LEVELS], axis=1)
        Y = (R["m"][:, None] <= zk).astype(np.int8)
        keys_ = np.array([m["key"] for m in meta])
        for scored in ("b12", "b9", "eth"):
            ids = np.where(keys_ == "dev:ETH")[0] if scored == "eth" else np.where(subs == scored)[0]
            insc = isc & np.isin(R["sid"], ids)
            if not insc.any():
                continue
            libmask = keep & ~insc
            libs = {"L_all": pooled_lib(R, libmask, classes=list(CLASSES)),
                    "L_cry": pooled_lib(R, libmask, classes=["crypto"]),
                    "L_new": pooled_lib(R, libmask, classes=[c for c in CLASSES if c != "crypto"])}
            e_const = Y[libmask & isc].mean(axis=0)
            sc = np.where(insc & keep)[0]
            P = {nm: np.stack([wecdf_at(lib, zk[sc, j]) for j in range(len(CRYPTO_LEVELS))], axis=1)
                 for nm, lib in libs.items() if lib is not None}
            P["e"] = np.tile(e_const, (len(sc), 1))
            own = np.full((len(sc), len(CRYPTO_LEVELS)), np.nan)
            pa = np.full_like(own, np.nan)
            sids = R["sid"][sc]
            for s in np.unique(sids):
                ii = np.where(sids == s)[0]
                o = np.argsort(R["day"][sc[ii]], kind="mergesort")
                ii = ii[o]
                rr = sc[ii]
                # own history: the series' resolved non-2026Q2 rows only (2026Q2 windows are neither scored nor used)
                own[ii] = own_ecdf_asof(R["day"][rr], R["end"][rr], R["m"][rr], zk[rr])
                pa[ii] = own_freq_asof(R["day"][rr], R["end"][rr], Y[rr].astype(float))
            P["own"], P["a"] = own, pa
            pfh = np.full((len(sc), len(CRYPTO_LEVELS)), np.nan)
            if FH is not None and hh in (1, 3):
                T = 24 * hh
                kid = {k: i for i, k in enumerate(np.unique(FH[f"T{T}_key"]))}
                code = np.array([kid[k] for k in FH[f"T{T}_key"]], np.int64) * 10 ** 6 + FH[f"T{T}_ts"] // DAY
                lut = dict(zip(code.tolist(), range(len(code))))
                mk_ = np.array([kid.get(meta[s_]["key"], -1) for s_ in sids], np.int64)
                cc = mk_ * 10 ** 6 + (R["day"][sc].astype(np.int64) + 1)
                hit = np.array([lut.get(c_, -1) if m_ >= 0 else -1 for c_, m_ in zip(cc.tolist(), mk_.tolist())])
                okh = hit >= 0
                pfh[okh] = FH[f"T{T}_pH"][hit[okh]]
                # identity check of the target: the hourly label must equal the encoded touch label
                yh = FH[f"T{T}_y"][hit[okh]]
                e_lab = float(np.mean(yh != Y[sc][okh])) if okh.any() else None
                log(f"  fH h={hh} {scored}: matched {int(okh.sum())} rows; label mismatch share {e_lab}")
            y = Y[sc]
            ts = (R["day"][sc].astype(np.int64) + 1) * DAY
            young = R["age"][sc] < YOUNG_BARS
            cell = {}
            for j, k in enumerate(CRYPTO_LEVELS):
                segs = [("all", np.ones(len(sc), bool), P), ("young", young, P), ("mature", ~young, P)]
                if np.isfinite(pfh[:, j]).any():
                    segs.append(("fH_rows", np.isfinite(pfh[:, j]), dict(P, fH=pfh)))
                for seg, sm, PP in segs:
                    base = sm & np.all(np.isfinite(np.stack([PP[n][:, j] for n in PP], 1)), axis=1)
                    if base.sum() < 1000 or y[base, j].sum() < 5:
                        continue
                    yy = y[base, j].astype(float)
                    bid, G, posb = R12.crash_blocks(ts[base], sids[base], yy.astype(np.int8), hh * 24)
                    e = {"rows": int(base.sum()), "pos": int(yy.sum()), "pos_blocks": int(posb.sum()),
                         "R": {}, "brier": {}, "bss_L_all_vs": {}, "Gstar_L_all_vs": {}}
                    for n_ in PP:
                        p = np.clip(PP[n_][base, j], 0, 1)
                        e["R"][n_] = float(p.sum() / max(yy.sum(), 1))
                        e["brier"][n_] = brier(p, yy)
                    pL = np.clip(PP["L_all"][base, j], 0, 1)
                    for n_ in PP:
                        if n_ == "L_all":
                            continue
                        pc = np.clip(PP[n_][base, j], 0, 1)
                        d = (pL - yy) ** 2 - (pc - yy) ** 2
                        sums = np.bincount(bid, weights=d, minlength=G)
                        sp = sums[posb] if posb.any() else sums
                        mb, sb = float(sp.mean()), float(sp.std(ddof=1)) if len(sp) > 1 else float("nan")
                        e["bss_L_all_vs"][n_] = float(1 - e["brier"]["L_all"] / e["brier"][n_]) if e["brier"][n_] > 0 else None
                        e["Gstar_L_all_vs"][n_] = (float(((2.326 + 0.8416) * sb / mb) ** 2) if mb < 0 else None)
                    cell[f"{k}/{seg}"] = e
            out[f"h{hh}/{scored}"] = cell
            for kk, e in cell.items():
                if kk.endswith(("/all", "/young", "/fH_rows")):
                    log(f"lib h={hh} {scored} {kk}: pos {e['pos']} blk {e['pos_blocks']} R " +
                        " ".join(f"{n}={v:.2f}" for n, v in e["R"].items()) + " | BSS L_all vs " +
                        " ".join(f"{n}={v:+.4f}" for n, v in e["bss_L_all_vs"].items() if v is not None))
    return out



def cmd_fh(a):
    """(fH) hourly touch forecasts (A6/R12 recipe, unchanged) at 00:00Z origins for T = 24 h and 72 h on the seen
    crypto stand-in sets (B12, B9) and ETH dev; cached for the comparison with the library at h = 1 and 3 bars."""
    import r12_tail as R12  # noqa: E402
    import r13_recal as R13  # noqa: E402
    os.makedirs(a.out, exist_ok=True)
    specs = [s for sub, s in crypto_dev_specs(a.datasets, os.path.join(a.out, "acq_r12"))
             if sub in ("b12", "b9") or s["key"] == "dev:ETH"]
    di = [R12.LEVELS.index(k) for k in CRYPTO_LEVELS]
    import multiprocessing as mp
    out = {}
    for T in (24, 72):
        ts_l, key_l, p_l, y_l = [], [], [], []
        with mp.get_context("fork").Pool(a.workers, maxtasksperchild=8) as pool:
            for j, r in enumerate(pool.imap(R13.row_task, [{"spec": s, "T": T, "grid": "6h"} for s in specs],
                                            chunksize=1)):
                rw = r["rows"]
                if rw is None or not len(rw["ts"]):
                    continue
                sel = (rw["ts"] % DAY) == 0
                ts_l.append(rw["ts"][sel])
                key_l.append(np.full(int(sel.sum()), r["key"], dtype=object))
                p_l.append(rw["pH"][sel][:, di])
                y_l.append(rw["y"][sel][:, di])
                if (j + 1) % 100 == 0:
                    print(f"{now_iso()} fH T={T}: {j + 1}/{len(specs)}", flush=True)
        out[f"T{T}_ts"] = np.concatenate(ts_l)
        out[f"T{T}_key"] = np.concatenate(key_l).astype(str)
        out[f"T{T}_pH"] = np.concatenate(p_l)
        out[f"T{T}_y"] = np.concatenate(y_l)
        print(f"{now_iso()} fH T={T}: rows {len(out[f'T{T}_ts'])}", flush=True)
    np.savez_compressed(os.path.join(a.out, "fh-r134.npz"), **out)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("build-b3")
    p.add_argument("--out", required=True)
    p.add_argument("--y0", type=int, default=2000)
    p.add_argument("--y1", type=int, default=2026)
    p = sub.add_parser("build-hd")
    p.add_argument("--out", required=True)
    p.add_argument("--workers", type=int, default=3)
    p.add_argument("--only", default="")
    p = sub.add_parser("select-p3b")
    p.add_argument("--datasets", required=True)
    p.add_argument("--out", required=True)
    p = sub.add_parser("dev")
    p.add_argument("--datasets", required=True)
    p.add_argument("--data", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--workers", type=int, default=4)
    p.add_argument("--crypto-limit", type=int, default=0)
    p.add_argument("--skip-new", action="store_true")
    p.add_argument("--fh", default="")
    p = sub.add_parser("fh")
    p.add_argument("--datasets", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--workers", type=int, default=3)
    a = ap.parse_args()
    if a.cmd in ("dev", "fh"):
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    {"build-b3": cmd_build_b3, "build-hd": cmd_build_hd, "select-p3b": cmd_select_p3b, "dev": cmd_dev,
     "fh": cmd_fh}[a.cmd](a)


if __name__ == "__main__":
    main()
