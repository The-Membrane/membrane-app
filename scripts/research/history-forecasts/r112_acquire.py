"""Q26 R11.2 input acquisition and the registered counts-only checks (membrane-board design/Q26_ROUND11_PREREG.md
R11.2 "Inputs to the combiner"). Computes no forecast, no outcome and no score.

  python3 r112_acquire.py funding     --out DIR   Binance ETHUSDT USD-M monthly fundingRate 2020-01..2026-10
                                                  (data.binance.vision, CHECKSUM-verified; reuses r104_acquire_funding)
  python3 r112_acquire.py hyperliquid --out DIR   Hyperliquid info endpoint fundingHistory, coin ETH, keyless
  python3 r112_acquire.py polymarket  --out DIR   Polymarket "what price will ethereum hit" ladders (gamma, keyless),
                                                  hourly CLOB prices-history of every dip market (keyless)
  python3 r112_acquire.py counts      --out DIR   counts-only checks: days of hourly Hyperliquid funding rows and days
                                                  of hourly Polymarket dip-ladder prices before the cutoff

Outputs hold no address, no condition id and no token id. Every text output is checked for 0x + 40 hex.
"""
from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

ADDR_RE = re.compile(r"0x[0-9a-fA-F]{40}")
UA = {"user-agent": "curl/8.5.0", "content-type": "application/json"}
HL_URL = "https://api.hyperliquid.xyz/info"
HL_FIRST_MS = 1682899200000            # 2023-05-01T00:00Z, before the first ETH funding row
GAMMA_SEARCH = "https://gamma-api.polymarket.com/public-search?q=what%20price%20will%20ethereum%20hit" \
               "&events_status={status}&limit_per_type=50&page={page}"
GAMMA_EVENT = "https://gamma-api.polymarket.com/events?slug={slug}"
CLOB_HIST = "https://clob.polymarket.com/prices-history?market={tok}&startTs={a}&endTs={b}&fidelity=60"
SLUG_PREFIX = "what-price-will-ethereum-hit"
CHUNK_S = 7 * 86400
HOURLY_DAY_MIN = 20                    # a day counts as "hourly" with >= 20 distinct hours holding a row
HL_MIN_DAYS = 730                      # R11.2: Hyperliquid enters with >= 730 days of hourly rows
PM_MIN_DAYS = 365                      # R11.2: Polymarket enters with >= 365 days of hourly ladder prices


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def iso(ts):
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(s):
    s = s.replace("Z", "+00:00")
    if "." in s:
        head, tail = s.split(".", 1)
        frac = re.match(r"\d+", tail).group(0)
        s = head + "." + frac[:6].ljust(6, "0") + tail[len(frac):]
    return datetime.fromisoformat(s).timestamp()


def http(url, data=None, tries=5):
    for k in range(tries):
        try:
            req = urllib.request.Request(url, data=data, headers=UA, method="POST" if data else "GET")
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read())
        except Exception:
            if k == tries - 1:
                raise
            time.sleep(2 * (k + 1))


def guard_file(path):
    raw = open(path, "rb").read()
    if path.endswith(".gz"):
        raw = gzip.decompress(raw)
    if ADDR_RE.search(raw.decode("utf-8", "replace")):
        raise SystemExit(f"STOP: address-like string in {path}")


def sha256(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def git_sha():
    try:
        return subprocess.check_output(["git", "-C", HERE, "rev-parse", "HEAD"], text=True).strip()
    except Exception:
        return None


# ---------------------------------------------------------------------------------------------
def cmd_funding(out):
    r = subprocess.run([sys.executable, os.path.join(HERE, "r104_acquire_funding.py"), "--out", out,
                        "--first", "2020-01", "--last", "2026-10"], capture_output=True, text=True)
    if r.returncode:
        raise SystemExit(r.stderr)
    print(r.stdout.strip())
    guard_file(os.path.join(out, "funding-ethusdt.csv"))


def cmd_hyperliquid(out):
    os.makedirs(out, exist_ok=True)
    started = now_iso()
    cutoff_ms = int(time.time() * 1000)
    rows, start, calls = [], HL_FIRST_MS, 0
    while True:
        page = http(HL_URL, json.dumps({"type": "fundingHistory", "coin": "ETH", "startTime": start,
                                        "endTime": cutoff_ms}).encode())
        calls += 1
        if not page:
            break
        for r in page:
            rows.append((int(r["time"]), r["fundingRate"], r["premium"]))
        last = int(page[-1]["time"])
        if last + 1 >= cutoff_ms or len(page) < 2:
            break
        start = last + 1
        time.sleep(0.25)
    rows = sorted(set(rows))
    p = os.path.join(out, "hl-funding-eth.csv")
    with open(p, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["time_ms", "funding_rate", "premium"])
        w.writerows(rows)
    guard_file(p)
    man = {"source": "Hyperliquid POST /info {type: fundingHistory, coin: ETH}, keyless", "started": started,
           "cutoff_ms": cutoff_ms, "cutoff_iso": iso(cutoff_ms / 1000), "calls": calls, "rows": len(rows),
           "first_iso": iso(rows[0][0] / 1000) if rows else None, "last_iso": iso(rows[-1][0] / 1000) if rows else None,
           "sha256": sha256(p), "code_sha": git_sha(), "finished": now_iso()}
    json.dump(man, open(os.path.join(out, "hl-manifest.json"), "w"), indent=1)
    print(json.dumps(man))


STRIKE_RE = re.compile(r"([0-9][0-9,]*(?:\.[0-9]+)?)")


def strike_of(m):
    for s in (m.get("groupItemTitle") or "", m.get("question") or ""):
        g = STRIKE_RE.search(s.replace("$", ""))
        if g:
            try:
                return float(g.group(1).replace(",", ""))
            except ValueError:
                pass
    return None


def side_of(m):
    t = (m.get("groupItemTitle") or "")
    q = (m.get("question") or "").lower()
    if "↓" in t or " dip " in f" {q} " or "dip to" in q:
        return "dip"
    if "↑" in t:
        return "reach_up"
    return "reach"                      # legacy wording: a dip market when the strike is below spot at start


def binance_close_at(kl, ts):
    i = int((ts - kl["start"]) // 3600)
    if 0 <= i < len(kl["close"]):
        return kl["close"][i]
    return None


def cmd_polymarket(out, datasets):
    os.makedirs(out, exist_ok=True)
    started = now_iso()
    cutoff = int(time.time()) // 3600 * 3600
    g = json.load(open(os.path.join(datasets, "binance-klines", "ETHUSDT-1h.json")))
    kl = {"start": int(g["startTs"]), "close": [None if c is None else float(c) for c in g["columns"]["close"]]}
    slugs = set()
    for status in ("closed", "active"):
        page = 1
        while True:
            d = http(GAMMA_SEARCH.format(status=status, page=page))
            for e in d.get("events", []):
                if (e.get("slug") or "").startswith(SLUG_PREFIX):
                    slugs.add(e["slug"])
            if not (d.get("pagination") or {}).get("hasMore") or page > 40:
                break
            page += 1
            time.sleep(0.2)
    markets = []
    for slug in sorted(slugs):
        evs = http(GAMMA_EVENT.format(slug=slug))
        for e in evs:
            for m in e.get("markets", []):
                try:
                    toks = json.loads(m.get("clobTokenIds") or "[]")
                    outs = json.loads(m.get("outcomes") or "[]")
                except Exception:
                    continue
                if not toks or not outs or outs[0] != "Yes" or not m.get("startDate") or not m.get("endDate"):
                    continue
                k = strike_of(m)
                if k is None:
                    continue
                st, en = parse_iso(m["startDate"]), parse_iso(m["endDate"])
                side = side_of(m)
                spot0 = binance_close_at(kl, int(st) // 3600 * 3600 - 3600)
                if side == "reach":
                    side = "dip_legacy" if (spot0 is not None and k < spot0) else "reach_legacy"
                markets.append({"event_slug": slug, "event_start": e.get("startDate"), "event_end": e.get("endDate"),
                                "market_id": str(m.get("id")), "strike": k, "side": side, "start": int(st),
                                "end": int(en), "_tok": toks[0]})
        time.sleep(0.15)
    dips = [m for m in markets if m["side"] in ("dip", "dip_legacy")]
    rows, calls = [], 0
    for m in dips:
        a = max(m["start"], 0)
        b = min(m["end"], cutoff)
        while a < b:
            e = min(a + CHUNK_S, b)
            h = http(CLOB_HIST.format(tok=m["_tok"], a=a, b=e)).get("history", [])
            calls += 1
            for x in h:
                t = int(x["t"])
                if t < cutoff:
                    rows.append((m["event_slug"], m["market_id"], m["strike"], t, float(x["p"])))
            a = e
            time.sleep(0.1)
    rows = sorted(set(rows), key=lambda r: (r[3], r[0], r[2]))
    p = os.path.join(out, "pm-eth-dip-prices.csv.gz")
    with gzip.open(p, "wt", newline="") as f:
        w = csv.writer(f)
        w.writerow(["event_slug", "market_id", "strike", "t", "p_yes"])
        w.writerows(rows)
    pm = os.path.join(out, "pm-eth-markets.csv")
    with open(pm, "w", newline="") as f:
        w = csv.writer(f)
        cols = ["event_slug", "event_start", "event_end", "market_id", "strike", "side", "start", "end"]
        w.writerow(cols)
        for m in sorted(markets, key=lambda m: (m["start"], m["event_slug"], m["strike"])):
            w.writerow([m[c] for c in cols])
    for q in (p, pm):
        guard_file(q)
    man = {"source": "gamma-api public-search + events (keyless); clob prices-history fidelity=60 in 7-day chunks "
                     "(keyless). Dip market: title arrow down or 'dip' wording, or legacy 'reach' wording with the "
                     "strike below the Binance ETHUSDT close of the hour before market start.",
           "started": started, "cutoff_iso": iso(cutoff), "events": len(slugs), "markets": len(markets),
           "dip_markets": len(dips), "history_calls": calls, "price_rows": len(rows),
           "prices_sha256": sha256(p), "markets_sha256": sha256(pm), "code_sha": git_sha(), "finished": now_iso()}
    json.dump(man, open(os.path.join(out, "pm-manifest.json"), "w"), indent=1)
    print(json.dumps(man))


def hourly_days(times_s):
    hours = {}
    for t in times_s:
        h = int(t) // 3600
        hours.setdefault(h // 24, set()).add(h)
    days = sorted(d for d, hs in hours.items() if len(hs) >= HOURLY_DAY_MIN)
    return days


def cmd_counts(out):
    res = {"rule": f"a UTC day counts when >= {HOURLY_DAY_MIN} distinct hours hold at least one row; "
                   "counts only, no value is read beyond its timestamp", "computed": now_iso(), "code_sha": git_sha()}
    hl = os.path.join(out, "hl-funding-eth.csv")
    if os.path.exists(hl):
        ts = [int(r["time_ms"]) / 1000 for r in csv.DictReader(open(hl))]
        days = hourly_days(ts)
        res["hyperliquid"] = {"rows": len(ts), "hourly_days": len(days),
                              "first_hourly_day": iso(days[0] * 86400) if days else None,
                              "first_row": iso(min(ts)) if ts else None,
                              "threshold_days": HL_MIN_DAYS, "enters": len(days) >= HL_MIN_DAYS}
    pp = os.path.join(out, "pm-eth-dip-prices.csv.gz")
    if os.path.exists(pp):
        ts = [int(r["t"]) for r in csv.DictReader(gzip.open(pp, "rt"))]
        days = hourly_days(ts)
        res["polymarket"] = {"rows": len(ts), "hourly_days": len(days),
                             "first_hourly_day": iso(days[0] * 86400) if days else None,
                             "first_row": iso(min(ts)) if ts else None,
                             "threshold_days": PM_MIN_DAYS, "enters": len(days) >= PM_MIN_DAYS}
    p = os.path.join(out, "counts-r112.json")
    json.dump(res, open(p, "w"), indent=1)
    guard_file(p)
    print(json.dumps(res, indent=1))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=("funding", "hyperliquid", "polymarket", "counts"))
    ap.add_argument("--out", required=True)
    ap.add_argument("--datasets", default=os.environ.get("MEMBRANE_DATASETS",
                                                          os.path.join(os.path.expanduser("~"), "membrane-datasets")))
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    if a.cmd == "funding":
        cmd_funding(a.out)
    elif a.cmd == "hyperliquid":
        cmd_hyperliquid(a.out)
    elif a.cmd == "polymarket":
        cmd_polymarket(a.out, a.datasets)
    else:
        cmd_counts(a.out)


if __name__ == "__main__":
    main()
