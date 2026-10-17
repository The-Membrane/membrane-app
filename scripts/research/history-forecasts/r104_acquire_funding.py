#!/usr/bin/env python3
"""Q26 R10.4 step-2 driver input: Binance ETHUSDT USD-M perpetual funding (free bulk files, no key).

membrane-board design/Q26_ROUND10_PREREG.md R10.4 step 2 ("Binance ETHUSDT perpetual funding, annualised over the
trailing 7 d (free bulk files)").

  python3 r104_acquire_funding.py --out <dir> [--first 2022-12] [--last 2026-10]

Downloads data.binance.vision monthly `fundingRate` zips for ETHUSDT, checks each zip against its published
.CHECKSUM (sha256), and writes `funding-ethusdt.csv` (calc_time_ms, funding_interval_hours, last_funding_rate,
source month) plus `funding-manifest.json` (URL, zip sha256, row counts, months not published). Computes no outcome.
"""
import argparse
import csv
import hashlib
import io
import json
import os
import time
import urllib.error
import urllib.request
import zipfile
from datetime import datetime, timezone

BASE = "https://data.binance.vision/data/futures/um/monthly/fundingRate/ETHUSDT/ETHUSDT-fundingRate-{m}.zip"


def months(first, last):
    y, m = map(int, first.split("-"))
    ly, lm = map(int, last.split("-"))
    while (y, m) <= (ly, lm):
        yield f"{y:04d}-{m:02d}"
        m += 1
        if m == 13:
            y, m = y + 1, 1


def get(url, tries=4):
    for k in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if k == tries - 1:
                raise
        except Exception:
            if k == tries - 1:
                raise
        time.sleep(2 * (k + 1))
    return None


def parse_zip(blob):
    z = zipfile.ZipFile(io.BytesIO(blob))
    names = [n for n in z.namelist() if n.endswith(".csv")]
    if len(names) != 1:
        raise SystemExit(f"STOP: zip holds {names}")
    rows = []
    for r in csv.reader(io.StringIO(z.read(names[0]).decode())):
        if not r or r[0] == "calc_time":
            continue
        rows.append((int(r[0]), int(r[1]), r[2]))
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--first", default="2022-12")
    ap.add_argument("--last", default="2026-10")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    started = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    man = {"source": "data.binance.vision monthly fundingRate, symbol ETHUSDT (USD-M perpetual), free, no key",
           "url_pattern": BASE, "started": started, "months": [], "not_published": []}
    allrows = []
    for m in months(a.first, a.last):
        url = BASE.format(m=m)
        blob = get(url)
        if blob is None:
            man["not_published"].append(m)
            continue
        ck = get(url + ".CHECKSUM")
        want = ck.decode().split()[0] if ck else None
        got = hashlib.sha256(blob).hexdigest()
        if want != got:
            raise SystemExit(f"STOP: {m} checksum {got} != {want}")
        rows = parse_zip(blob)
        allrows += [(t, h, r, m) for t, h, r in rows]
        man["months"].append({"month": m, "zip_sha256": got, "rows": len(rows),
                              "first_ms": rows[0][0] if rows else None, "last_ms": rows[-1][0] if rows else None})
        time.sleep(0.3)
    allrows.sort()
    ts = [r[0] for r in allrows]
    if len(set(ts)) != len(ts):
        raise SystemExit("STOP: duplicate calc_time")
    p = os.path.join(a.out, "funding-ethusdt.csv")
    with open(p, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["calc_time_ms", "funding_interval_hours", "last_funding_rate", "month"])
        w.writerows(allrows)
    man["rows"] = len(allrows)
    man["intervals_hours"] = sorted({r[1] for r in allrows})
    man["first_iso"] = datetime.fromtimestamp(ts[0] / 1000, tz=timezone.utc).isoformat()
    man["last_iso"] = datetime.fromtimestamp(ts[-1] / 1000, tz=timezone.utc).isoformat()
    h = hashlib.sha256(open(p, "rb").read()).hexdigest()
    man["funding_csv_sha256"] = h
    man["finished"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    json.dump(man, open(os.path.join(a.out, "funding-manifest.json"), "w"), indent=1)
    print(json.dumps({k: man[k] for k in ("rows", "intervals_hours", "first_iso", "last_iso", "not_published",
                                          "funding_csv_sha256")}))


if __name__ == "__main__":
    main()
