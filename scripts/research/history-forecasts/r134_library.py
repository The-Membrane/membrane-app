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
            tk = re.search(r'name="tk" id="tk" value="([^"]*)"', t).group(1)
            if not tk:
                return None                    # the site offers no file for this period (recorded as unavailable)
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
    lines = [ln for ln in txt.splitlines() if ln.count(b";") == 6]       # drop malformed rows (counted)
    hd_parse.bad = len(txt.splitlines()) - len(lines)
    a = np.loadtxt(io.BytesIO(b"\n".join(lines)), delimiter=";", dtype=np.float64, ndmin=2)
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
        if raw is None:
            man.append({"period": per, "unavailable": True})
            continue
        man.append({"period": per, "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)})
        t, o, h, l, c = hd_parse(raw)
        man[-1]["malformed_rows_dropped"] = int(hd_parse.bad)
        del raw
        for k, v in zip(("t", "o", "h", "l", "c"), (t, o, h, l, c)):
            T[k].append(v)
    gaps0 = [x["period"] for x in man if x.get("unavailable") and x["period"] < "2026/10"]
    if gaps0:                                  # R13.4 rule: an instrument with an unavailable period is excluded
        return {"pair": p, "class": cls, "split": sp, "periods": man, "unavailable_periods": gaps0,
                "excluded_r134": True, "minutes": 0, "daily_bars": 0, "first_month": None}
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
    gaps = [x["period"] for x in man if x.get("unavailable") and x["period"] < "2026/10"]
    return {"pair": p, "unavailable_periods": gaps, "excluded_r134": bool(gaps), "class": cls, "split": sp, "periods": man, "minutes": int(len(t)), "daily_bars": int(len(dly["b"])),
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
            try:
                r = f.result()
            except Exception as e:  # noqa: BLE001
                r = {"pair": futs[f], "class": hd_class(futs[f]), "split": "error", "error": repr(e), "periods": [],
                     "daily_bars": 0, "first_month": None, "excluded_r134": True}
            res.append(r)
            print(f"{now_iso()} {r['pair']} {r['class']} {r['split']} first {r['first_month']} "
                  f"periods {len(r['periods'])} daily bars {r['daily_bars']} excluded {r.get('excluded_r134')}",
                  flush=True)
    res.sort(key=lambda r: r["pair"])
    counts = {}
    for r in res:
        k = f"{r['class']}/{r['split']}"
        if r.get("excluded_r134"):
            k = k + "/excluded"
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
            lam_c = best[0]
            resid = {str(z): float(math.log(max(tab[c]["F"][str(z)], 1e-12)) -
                                   math.log(max(float(wecdf_at(lib_all, z / lam_c)), 1e-12))) for z in Z_GRID}
            ent["lambda"][c] = {"lambda": round(lam_c, 3), "sse_ln": best[1], "resid_ln_after_lambda": resid}
            # within-class asset heterogeneity at z = -2 (assets with >= 500 rows)
            mk = keep & (R["cls"] == CLASSES.index(c))
            sids, inv = np.unique(R["sid"][mk], return_inverse=True)
            n_a = np.bincount(inv)
            y2 = (R["m"][mk] <= -2.0).astype(float)
            k_a = np.bincount(inv, weights=y2)
            big = n_a >= 500
            if big.sum() >= 5:
                Fa = (k_a[big] + 0.5) / (n_a[big] + 1)
                Fc2 = y2.mean()
                lr = np.log(Fa / Fc2)
                binom_sd = np.sqrt(np.mean((1 - Fc2) / (n_a[big] * Fc2)))
                ent["lambda"][c]["assets_z-2"] = {"n_assets": int(big.sum()), "sd_ln_ratio": float(lr.std()),
                                                  "binomial_sd_ln": float(binom_sd),
                                                  "q10_q50_q90_ratio": np.round(np.exp(np.quantile(lr, [.1, .5, .9])),
                                                                                3).tolist()}
        # regime: vol-ratio terciles (pooled cutpoints)
        q = np.nanquantile(R["vr"][keep], [1 / 3, 2 / 3])
        for ti, (lo, hi) in enumerate(((-np.inf, q[0]), (q[0], q[1]), (q[1], np.inf))):
            mk = keep & (R["vr"] > lo) & (R["vr"] <= hi)
            t2 = class_ecdf_table(R, mk & keep)
            ent["regime"][f"vr_t{ti + 1}"] = {c: {str(z): t2[c]["F"][str(z)] for z in (-2.0, -3.0, -4.0)}
                                             for c in t2}
        ent["regime"]["vr_cut"] = q.tolist()
        # crypto sub-sets (venue/era) as pseudo-classes: is crypto itself collapsed?
        subs = np.array([m_["sub"] for m_ in meta])
        ent["crypto_subsets"] = {}
        for sb in ("pool", "b9", "b12", "b13a"):
            mk = keep & (R["cls"] == 0) & np.isin(R["sid"], np.where(subs == sb)[0])
            if mk.sum() < 1000:
                continue
            ent["crypto_subsets"][sb] = {"rows": int(mk.sum()),
                                         "F": {str(z): float(np.mean(R["m"][mk] <= z)) for z in Z_GRID}}
        # era split for every class: before 2020 vs 2020 and later
        ent["era"] = {}
        e20 = date_days("2020-01-01")
        for ci, c in enumerate(CLASSES):
            for nm, em in (("pre2020", R["day"] < e20), ("2020on", R["day"] >= e20)):
                mk = keep & (R["cls"] == ci) & em
                if mk.sum() >= 1000:
                    ent["era"][f"{c}/{nm}"] = {"rows": int(mk.sum()),
                                               "F": {str(z): float(np.mean(R["m"][mk] <= z)) for z in (-2.0, -3.0, -4.0)}}
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
            # decoder residual: crypto tail scale lambda vs a source library (fitted on library rows only)
            zz = np.array([z for z in Z_GRID if -4.0 <= z <= -1.5])
            Fc = wecdf_at(libs["L_cry"], zz)
            lam = {}
            for src in ("L_all", "L_new"):
                if libs[src] is None:
                    continue
                best = min(((float(np.sum((np.log(Fc) - np.log(np.maximum(wecdf_at(libs[src], zz / l_), 1e-12))) ** 2)),
                             float(l_)) for l_ in np.arange(0.5, 2.01, 0.01)))
                lam[src] = best[1]
            # regime-conditioned crypto library (vol-ratio terciles, cutpoints from library rows)
            qv = np.nanquantile(R["vr"][libmask & isc], [1 / 3, 2 / 3])
            tb = np.digitize(R["vr"], qv)
            libs_reg = [pooled_lib(R, libmask & (tb == b_), classes=["crypto"]) for b_ in range(3)]
            e_const = Y[libmask & isc].mean(axis=0)
            sc = np.where(insc & keep)[0]
            P = {nm: np.stack([wecdf_at(lib, zk[sc, j]) for j in range(len(CRYPTO_LEVELS))], axis=1)
                 for nm, lib in libs.items() if lib is not None}
            for src, l_ in lam.items():
                P[f"{src}_lam"] = np.stack([wecdf_at(libs[src], zk[sc, j] / l_) for j in range(len(CRYPTO_LEVELS))], 1)
            preg = np.full((len(sc), len(CRYPTO_LEVELS)), np.nan)
            for b_ in range(3):
                mb_ = tb[sc] == b_
                if libs_reg[b_] is not None and mb_.any():
                    preg[mb_] = np.stack([wecdf_at(libs_reg[b_], zk[sc[mb_], j]) for j in range(len(CRYPTO_LEVELS))], 1)
            P["L_cry_reg"] = preg
            P["e"] = np.tile(e_const, (len(sc), 1))
            log(f"  decoder residual h={hh} {scored}: lambda {lam}; vr cut {np.round(qv, 3).tolist()}")
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
                PE = {n_: v_ for n_, v_ in P.items() if n_ not in ("own", "a")}
                segs.append(("no_own", ~np.isfinite(P["own"][:, j]), PE))
                if np.isfinite(pfh[:, j]).any():
                    segs.append(("fH_rows", np.isfinite(pfh[:, j]), dict(P, fH=pfh)))
                for seg, sm, PP in segs:
                    base = sm & np.all(np.isfinite(np.stack([PP[n][:, j] for n in PP], 1)), axis=1)
                    if base.sum() < 1000 or y[base, j].sum() < 5:
                        continue
                    yy = y[base, j].astype(float)
                    bid, G, posb = R12.crash_blocks(ts[base], sids[base], yy.astype(np.int8), hh * 24)
                    e = {"rows": int(base.sum()), "pos": int(yy.sum()), "pos_blocks": int(posb.sum()),
                         "R": {}, "brier": {}}
                    for n_ in PP:
                        p = np.clip(PP[n_][base, j], 0, 1)
                        e["R"][n_] = float(p.sum() / max(yy.sum(), 1))
                        e["brier"][n_] = brier(p, yy)
                    cands = [n_ for n_ in PP if n_.startswith("L_")]
                    comps = [n_ for n_ in PP if not n_.startswith("L_")]
                    e["vs"] = {}
                    for cn in cands:
                        pL = np.clip(PP[cn][base, j], 0, 1)
                        for n_ in comps + [x for x in cands if x != cn]:
                            pc = np.clip(PP[n_][base, j], 0, 1)
                            d = (pL - yy) ** 2 - (pc - yy) ** 2
                            sums = np.bincount(bid, weights=d, minlength=G)
                            sp = sums[posb] if posb.any() else sums
                            mb = float(sp.mean())
                            sb = float(sp.std(ddof=1)) if len(sp) > 1 else float("nan")
                            e["vs"][f"{cn}|{n_}"] = {
                                "bss": float(1 - e["brier"][cn] / e["brier"][n_]) if e["brier"][n_] > 0 else None,
                                "m_b": mb, "s_b": sb, "G_pos": int(len(sp)),
                                "Gstar_a05": (float(((1.645 + 0.8416) * sb / mb) ** 2) if mb < 0 else None)}
                    e["bss_L_all_vs"] = {n_: e["vs"][f"L_all|{n_}"]["bss"] for n_ in PP if n_ != "L_all"}
                    cell[f"{k}/{seg}"] = e
            cell["_lambda"] = lam
            out[f"h{hh}/{scored}"] = cell
            for kk, e in cell.items():
                if isinstance(e, dict) and "R" in e and kk.endswith(("/all", "/young", "/fH_rows", "/no_own")):
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



# =============================================================================================
# P3b-a acquisition (outcome-blind) and counts-only checks on reserved sets
# =============================================================================================
BIN_KL = "https://data-api.binance.vision/api/v3/klines?symbol={s}&interval=1h&startTime={t}&limit=1000"
ACQ_END_TS = date_days("2026-10-01") * DAY


def fetch_binance_1h(sym):
    t, rows, shas = 0, [], []
    while True:
        raw = http_get(BIN_KL.format(s=sym, t=t * 1000), headers={"User-Agent": "curl/8.5.0"})
        shas.append(hashlib.sha256(raw).hexdigest())
        page = json.loads(raw)
        if not page:
            break
        rows.extend(page)
        last = int(page[-1][0]) // 1000
        if len(page) < 1000 or last + 3600 >= ACQ_END_TS:
            break
        t = last + 3600
        time.sleep(0.3)
    rows = [r for r in rows if int(r[0]) // 1000 < ACQ_END_TS]
    st = int(rows[0][0]) // 1000
    n = (int(rows[-1][0]) // 1000 - st) // 3600 + 1
    cols = {k: [None] * n for k in ("open", "high", "low", "close", "volume")}
    for r in rows:
        i = (int(r[0]) // 1000 - st) // 3600
        for k, j in (("open", 1), ("high", 2), ("low", 3), ("close", 4), ("volume", 5)):
            cols[k][i] = float(r[j])
    return {"asset": sym, "source": "Binance spot klines, data-api.binance.vision/api/v3/klines 1h (public, no key)",
            "startTs": st, "stepSeconds": 3600, "count": n, "columns": cols, "fetchedAt": now_iso()}, shas


def cmd_acquire_p3b(a):
    sel = json.load(open(a.selection))
    os.makedirs(a.out, exist_ok=True)
    man = {"created_utc": now_iso(), "code_sha": git_sha(), "set": "P3b-a", "series": {}}
    for sym in sel["P3b_a"]:
        g, shas = fetch_binance_1h(sym)
        p = os.path.join(a.out, f"binance-{sym}-1h.json")
        write_json(p, g)
        nnull = sum(1 for v in g["columns"]["close"] if v is None)
        man["series"][sym] = {"file": os.path.basename(p), "hours": g["count"], "null_hours": nnull,
                              "page_sha256": shas, "sha256": sha256_file(p)}
        print(f"{now_iso()} {sym}: hours {g['count']}, null {nnull}", flush=True)
    write_json(os.path.join(a.out, "manifest-p3b-a.json"), man)
    print(f"sha256 manifest {sha256_file(os.path.join(a.out, 'manifest-p3b-a.json'))}")


def load_set_series(a, which):
    """reserved-set bars: 'EQ-A', 'ETF-A', 'FX-A', 'IDX-A', 'COM-A', 'P3b-a' (counts / run only)."""
    out = []
    if which in ("EQ-A", "ETF-A", "EQ-B", "ETF-B"):
        cls = "equity" if which.startswith("EQ") else "etf"
        d = os.path.join(a.data, "b3", "locked", which[-1])
        files = sorted(f for f in os.listdir(d) if f.startswith(cls + "-"))
        cal = np.unique(np.concatenate([np.load(os.path.join(a.data, "b3", sub, f))["d"]
                                        for sub in ("dev", "locked/A", "locked/B")
                                        for f in os.listdir(os.path.join(a.data, "b3", sub))]))
        for f in files:
            B = bars_b3(os.path.join(d, f), cal)
            B.update(key=f"b3:{f[:-4].split('-', 1)[1]}", cls=cls, sub=which, asset=f)
            out.append(B)
    elif which in ("FX-A", "FX-B"):
        d = os.path.join(a.data, "hd", "locked", which[-1])
        for f in sorted(os.listdir(d)):
            B = bars_hd(os.path.join(d, f))
            B.update(key=f"hd:{f[:-4]}", cls="fx", sub=which, asset=f)
            out.append(B)
    elif which in ("IDX-A", "COM-A", "IDX-B", "COM-B"):
        cls = "index" if which.startswith("IDX") else "commodity"
        lo, hi = TIME_SPLIT[which[-1]]
        d = os.path.join(a.data, "hd", "locked", "time")
        for f in sorted(x for x in os.listdir(d) if x.startswith(cls + "-")):
            B = bars_hd(os.path.join(d, f))
            B["win"] = (date_days(lo), date_days(hi))
            B.update(key=f"hd:{f[:-4]}", cls=cls, sub=which, asset=f)
            out.append(B)
    elif which == "P3b-a":
        man = json.load(open(os.path.join(a.p3b, "manifest-p3b-a.json")))
        for sym, v in sorted(man["series"].items()):
            g = json.load(open(os.path.join(a.p3b, v["file"])))
            arr = {k: np.array([np.nan if x is None else x for x in g["columns"][k]], float) for k in ("close", "low", "high")}
            B = bars_crypto(arr["close"], arr["low"], arr["high"], int(g["startTs"]))
            B["cap_day"] = ACQ_END_TS // DAY
            B.update(key=f"p3b:{sym}", cls="crypto", sub=which, asset=sym)
            out.append(B)
    return out


def encode_set(series, beta):
    """encoded rows per h for a list of series with the frozen beta (no fit)."""
    rows = {hh: {k: [] for k in ("cls", "sid", "day", "end", "m", "s", "vr", "age", "q2")} for hh in H_BARS}
    for sid, s in enumerate(series):
        E = encode_inputs(s)
        for hh in H_BARS:
            F = E["fwd"][hh]
            ok = F["ok"].copy()
            if "win" in s:                     # time-split sets: outcome window inside the reserved window
                ok &= (s["d"] >= s["win"][0]) & (F["end_day"] <= s["win"][1])
            if not ok.any():
                continue
            scale = np.sqrt(np.exp(E["X"][ok] @ beta[hh])) * math.sqrt(hh)
            m = (np.log(F["wmin"][ok]) - E["lc"][ok]) / scale
            R = rows[hh]
            R["cls"].append(np.full(ok.sum(), CLASSES.index(s["cls"]), np.int8))
            R["sid"].append(np.full(ok.sum(), sid, np.int32))
            R["day"].append(s["d"][ok])
            R["end"].append(F["end_day"][ok])
            R["m"].append(m)
            R["s"].append(scale)
            R["vr"].append(E["vr"][ok])
            R["age"].append(np.asarray(E["age"])[ok])
            R["q2"].append(q2_overlap(s["d"][ok], F["end_day"][ok]))
    return {hh: ({k: np.concatenate(v) for k, v in R.items()} if R["m"] else None) for hh, R in rows.items()}


def cmd_counts(a):
    """counts only on reserved sets with the frozen encoder: rows, positive origins, positive weeks and episodes per
    registered cell. No forecast and no score."""
    import r12_tail as R12  # noqa: E402
    fz = json.load(open(a.frozen_beta))
    beta = {int(k): np.array(v) for k, v in fz["beta"].items()}
    out = {"created_utc": now_iso(), "code_sha": git_sha(), "note": "counts only (no forecast, no score)", "sets": {}}
    for which in a.sets.split(","):
        ser = load_set_series(a, which)
        rows = encode_set(ser, beta)
        ent = {"series": len(ser), "cells": {}}
        for hh in H_BARS:
            R = rows[hh]
            if R is None:
                continue
            keep = ~R["q2"]
            wk_all = week_of(R["day"][keep])
            ent["cells"][f"h{hh}"] = {"rows": int(keep.sum()), "weeks": int(len(np.unique(wk_all)))}
            for z in Z_GRID:
                pos = keep & (R["m"] <= z)
                ent["cells"][f"h{hh}"][f"z{z}"] = {"pos": int(pos.sum()),
                                                   "pos_weeks": int(len(np.unique(week_of(R["day"][pos]))))}
            if which.startswith("P3b") and hh in CRYPTO_H:
                ts = (R["day"][keep].astype(np.int64) + 1) * DAY
                for k in CRYPTO_LEVELS:
                    y = (R["m"][keep] <= math.log(1 + k) / R["s"][keep]).astype(np.int8)
                    if y.sum() == 0:
                        ent["cells"][f"h{hh}"][f"k{k}"] = {"pos": 0, "pos_blocks": 0}
                        continue
                    bid, G, posb = R12.crash_blocks(ts, R["sid"][keep], y, hh * 24)
                    young = R["age"][keep] < YOUNG_BARS
                    ent["cells"][f"h{hh}"][f"k{k}"] = {"pos": int(y.sum()), "pos_blocks": int(posb.sum()),
                                                       "blocks": int(G), "young_rows": int(young.sum())}
        out["sets"][which] = ent
        print(f"{now_iso()} counts {which}: series {len(ser)}; " + "; ".join(
            f"h{hh} rows {c['rows']} wk {c['weeks']} z-3 posw {c['z-3.0']['pos_weeks']}" for hh, c in
            ((int(k[1:]), v) for k, v in ent["cells"].items())), flush=True)
    write_json(a.out, out)
    print(f"sha256 {sha256_file(a.out)}")



MENU = ("L_cry", "L_all", "L_new", "L_cry_reg", "L_all_lam", "L_new_lam")     # simplicity order (registered)
COLL_CELLS = [(h_, z_) for h_ in (1, 5, 20) for z_ in (-2.0, -3.0)]
NEW_CLASSES = ("equity", "etf", "fx", "index", "commodity")


def cmd_select(a):
    """registered development selection of the library candidate (D-R13.4b): mean BSS vs (e) over the 15 crypto
    cells x 2 check sets (B12, B9; 'all' rows); the simplest candidate within one SE of the best is chosen."""
    dev = json.load(open(a.dev))
    L = dev["library_vs_asset"]
    tab = {}
    for c in MENU:
        vals = []
        for hh in CRYPTO_H:
            for st in ("b12", "b9"):
                cell = L.get(f"h{hh}/{st}", {})
                for k in CRYPTO_LEVELS:
                    e = cell.get(f"{k}/all")
                    if e and f"{c}|e" in e.get("vs", {}):
                        vals.append(e["vs"][f"{c}|e"]["bss"])
        v = np.array(vals, float)
        tab[c] = {"n": int(len(v)), "mean_bss_vs_e": float(v.mean()), "se": float(v.std(ddof=1) / math.sqrt(len(v)))}
    best = max(tab, key=lambda c: tab[c]["mean_bss_vs_e"])
    thr = tab[best]["mean_bss_vs_e"] - tab[best]["se"]
    choice = next(c for c in MENU if tab[c]["mean_bss_vs_e"] >= thr)
    out = {"created_utc": now_iso(), "code_sha": git_sha(), "dev_sha256": sha256_file(a.dev), "table": tab,
           "best": best, "one_se_threshold": thr, "choice": choice}
    write_json(a.out, out)
    print(json.dumps(out, indent=1))



def cmd_power(a):
    """projected power at the reserved-set counts (D-R13.4b rule).
    Family 1 (collapse, per class): equivalence of R = F_lib(z / lambda_c) / F_A(z) inside [0.8, 1.25] at the
      6 cells (h 1, 5, 20 x z -2, -3); SE scaled from development by positive weeks; planning deviation = the
      development residual after lambda_c. Power = Phi((ln 1.25 - |delta|) / SE - 1.645).
    Family 2 (P3b-a): chosen candidate vs (own), (a), (e) on the young segment of B12 and B9 (pooled per cell);
      power per comparator = Phi(sqrt(G_new) |m_b| / s_b - z_holm); cell power = the weakest comparator."""
    from scipy.stats import norm
    dev = json.load(open(a.dev))
    cnt = json.load(open(a.counts))
    sel = json.load(open(a.select))
    out = {"created_utc": now_iso(), "code_sha": git_sha(), "family1": {}, "family2": {}}
    C = dev["collapse"]
    for c in NEW_CLASSES:
        which = {"equity": "EQ-A", "etf": "ETF-A", "fx": "FX-A", "index": "IDX-A", "commodity": "COM-A"}[c]
        if which not in cnt["sets"]:
            continue
        cells = {}
        for hh, z in COLL_CELLS:
            ent = C[str(hh)]
            tc = ent["classes"].get(c)
            if tc is None or tc["se_lnF"].get(str(z)) is None:
                continue
            se_dev, pw_dev = tc["se_lnF"][str(z)], tc["pos"][str(z)]
            pos_weeks_dev = None
            ca = cnt["sets"][which]["cells"].get(f"h{hh}", {}).get(f"z{z}")
            if not ca or ca["pos"] == 0:
                cells[f"h{hh}/z{z}"] = {"power": 0.0, "pos_A": 0}
                continue
            se_A = se_dev * math.sqrt(max(pw_dev, 1) / ca["pos"])        # SE of ln F scales ~ 1/sqrt(positives)
            delta = abs(ent["lambda"][c]["resid_ln_after_lambda"][str(z)])
            pw = float(norm.cdf((math.log(1.25) - delta) / se_A - 1.645))
            cells[f"h{hh}/z{z}"] = {"se_dev": se_dev, "pos_dev": pw_dev, "pos_A": ca["pos"], "pos_weeks_A": ca["pos_weeks"],
                                    "se_A": se_A, "delta": delta, "power": pw}
            del pos_weeks_dev
        out["family1"][c] = {"set": which, "cells": cells,
                             "class_power_all_cells": float(np.prod([v["power"] for v in cells.values()])) if cells else 0}
    choice = sel["choice"]
    zh = norm.ppf(1 - 0.05 / 15)
    L = dev["library_vs_asset"]
    pc = cnt["sets"].get("P3b-a", {}).get("cells", {})
    for hh in CRYPTO_H:
        for k in CRYPTO_LEVELS:
            legs = {}
            for comp in ("own", "a", "e"):
                ms, ss, gs = [], [], []
                for st in ("b12", "b9"):
                    e = L.get(f"h{hh}/{st}", {}).get(f"{k}/young")
                    if e and f"{choice}|{comp}" in e["vs"]:
                        v = e["vs"][f"{choice}|{comp}"]
                        ms.append(v["m_b"] * v["G_pos"])
                        ss.append((v["s_b"] ** 2) * (v["G_pos"] - 1))
                        gs.append(v["G_pos"])
                if not gs:
                    continue
                G = sum(gs)
                m_b = sum(ms) / G
                s_b = math.sqrt(sum(ss) / max(G - len(gs), 1))
                Gn = pc.get(f"h{hh}", {}).get(f"k{k}", {}).get("pos_blocks", 0)
                pw = float(norm.cdf(math.sqrt(Gn) * abs(m_b) / s_b - zh)) if (m_b < 0 and Gn > 0) else 0.0
                legs[comp] = {"m_b": m_b, "s_b": s_b, "G_dev": G, "G_new": Gn, "power": pw,
                              "Gstar": float(((zh + 0.8416) * s_b / m_b) ** 2) if m_b < 0 else None}
            out["family2"][f"h{hh}/{k}"] = {"legs": legs, "cell_power": min((v["power"] for v in legs.values()),
                                                                            default=0.0)}
    write_json(a.out, out)
    for c, v in out["family1"].items():
        print(c, v["set"], {k: round(x["power"], 2) for k, x in v["cells"].items()})
    for k, v in out["family2"].items():
        print(k, round(v["cell_power"], 2), {c: (round(x["power"], 2), x["G_new"], round(x["Gstar"] or -1)) for c, x in v["legs"].items()})
    print(f"sha256 {sha256_file(a.out)}")


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
    p = sub.add_parser("acquire-p3b")
    p.add_argument("--selection", required=True)
    p.add_argument("--out", required=True)
    p = sub.add_parser("counts")
    p.add_argument("--data", required=True)
    p.add_argument("--p3b", default="")
    p.add_argument("--frozen-beta", required=True)
    p.add_argument("--sets", required=True)
    p.add_argument("--out", required=True)
    p = sub.add_parser("power")
    p.add_argument("--dev", required=True)
    p.add_argument("--counts", required=True)
    p.add_argument("--select", required=True)
    p.add_argument("--out", required=True)
    p = sub.add_parser("select")
    p.add_argument("--dev", required=True)
    p.add_argument("--out", required=True)
    a = ap.parse_args()
    if a.cmd in ("dev", "fh", "counts"):
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    {"build-b3": cmd_build_b3, "build-hd": cmd_build_hd, "select-p3b": cmd_select_p3b, "dev": cmd_dev,
     "fh": cmd_fh, "acquire-p3b": cmd_acquire_p3b, "counts": cmd_counts,
     "select": cmd_select, "power": cmd_power}[a.cmd](a)


if __name__ == "__main__":
    main()
