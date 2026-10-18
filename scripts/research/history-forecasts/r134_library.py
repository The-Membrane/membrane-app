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
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
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
    a = ap.parse_args()
    {"build-b3": cmd_build_b3, "build-hd": cmd_build_hd, "select-p3b": cmd_select_p3b}[a.cmd](a)


if __name__ == "__main__":
    main()
