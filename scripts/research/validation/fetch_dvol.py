#!/usr/bin/env python3
"""Fetch Deribit DVOL (30-day implied vol index) hourly candles for ETH and BTC.

Source: Deribit public REST `public/get_volatility_index_data` (no key).
Writes `$MEMBRANE_DATASETS_DIR/deribit-dvol/dvol-<asset>-1h.json` (stdlib only).

Each row is [open_ms, open, high, low, close] in annualized vol points (65.2 = 65.2%).
The candle opening at t closes at t + 1h. A forecast issued at t0 may only read candles
whose open is <= t0 - 1h.
"""
import argparse, json, os, sys, time, urllib.request
from datetime import datetime, timezone

API = "https://www.deribit.com/api/v2/public/get_volatility_index_data"
START_MS = int(datetime(2021, 1, 1, tzinfo=timezone.utc).timestamp() * 1000)


def datasets_dir():
    d = os.environ.get("MEMBRANE_DATASETS_DIR")
    if d:
        return d
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.normpath(os.path.join(here, "..", "..", "..", "..", "membrane-datasets"))


def get(url, tries=4):
    for i in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                return json.loads(r.read())
        except Exception as e:  # network blip: back off and retry
            if i == tries - 1:
                raise
            time.sleep(2 ** (i + 1))


def fetch(currency, end_ms):
    rows, end = {}, end_ms
    while True:
        url = f"{API}?currency={currency}&start_timestamp={START_MS}&end_timestamp={end}&resolution=3600"
        res = get(url)["result"]
        for r in res["data"]:
            rows[r[0]] = r
        cont = res.get("continuation")
        if not cont or not res["data"] or cont >= end:
            break
        end = cont
        time.sleep(0.2)
    return [rows[k] for k in sorted(rows)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--end", help="ISO hour (UTC) to stop at; default = last closed hour")
    a = ap.parse_args()
    if a.end:
        end_ms = int(datetime.fromisoformat(a.end.replace("Z", "+00:00")).timestamp() * 1000)
    else:
        end_ms = (int(time.time()) // 3600) * 3600 * 1000 - 3600 * 1000
    out_dir = os.path.join(datasets_dir(), "deribit-dvol")
    os.makedirs(out_dir, exist_ok=True)
    for cur in ("ETH", "BTC"):
        rows = [r for r in fetch(cur, end_ms) if r[0] <= end_ms]
        doc = {
            "asset": cur,
            "source": f"{API}?currency={cur}&resolution=3600",
            "fetchedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "columns": ["open_ms", "open", "high", "low", "close"],
            "units": "annualized implied vol, percent points",
            "count": len(rows),
            "rows": rows,
        }
        path = os.path.join(out_dir, f"dvol-{cur.lower()}-1h.json")
        with open(path, "w") as f:
            json.dump(doc, f, separators=(",", ":"))
        first = datetime.fromtimestamp(rows[0][0] / 1000, timezone.utc).isoformat()
        last = datetime.fromtimestamp(rows[-1][0] / 1000, timezone.utc).isoformat()
        print(f"{cur}: {len(rows)} hourly candles {first} -> {last} -> {path}", file=sys.stderr)


if __name__ == "__main__":
    main()
