"""Q26-FM: Binance USDⓈ-M futures bulk metrics (5-minute open interest, long/short ratios, taker ratio) and monthly funding
rates, keyless, from data.binance.vision. Registered in membrane-board design/Q26_FAST_MOVE_PREREG.md (board 1756d88);
acquisition started after that commit. Stores hourly samples (last 5-minute row at or before each hour) per pair as JSONL.gz,
plus every daily file's sha256 in a manifest. Computes no outcome, episode, label or score."""
import csv, datetime as dt, gzip, hashlib, io, json, os, sys, threading, time, urllib.request, zipfile
PAIRS = ["ETHUSDT", "BTCUSDT", "SOLUSDT", "AVAXUSDT", "LINKUSDT", "DOGEUSDT", "ADAUSDT", "XRPUSDT", "LTCUSDT", "BNBUSDT"]
BASE = "https://data.binance.vision/data/futures/um"
START = dt.date(2021, 12, 1)
OUT = os.environ.get("FM_OUT", "/home/user/membrane-datasets/binance-futures-metrics")
UA = {"user-agent": "curl/8.5.0"}


def get(url, tries=4):
    for k in range(tries):
        try:
            return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60).read()
        except urllib.error.HTTPError as e:
            if e.code == 404: return None
            time.sleep(2 * (k + 1))
        except Exception:
            time.sleep(2 * (k + 1))
    raise RuntimeError("fetch failed " + url)


def day_rows(pair, d):
    url = f"{BASE}/daily/metrics/{pair}/{pair}-metrics-{d.isoformat()}.zip"
    raw = get(url)
    if raw is None: return None, None
    z = zipfile.ZipFile(io.BytesIO(raw)); txt = z.read(z.namelist()[0]).decode()
    rd = csv.DictReader(io.StringIO(txt))
    out = []
    for r in rd:
        ts = int(dt.datetime.strptime(r["create_time"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=dt.UTC).timestamp())
        out.append((ts, r))
    return out, hashlib.sha256(raw).hexdigest()


def hourly(rows):
    """last row at or before each hour boundary (ts % 3600 == 0 → that row; else the latest earlier one)."""
    by_hour = {}
    for ts, r in sorted(rows, key=lambda x: x[0]):
        h = (ts // 3600) * 3600 if ts % 3600 == 0 else ((ts // 3600) + 1) * 3600
        # row at exactly the hour belongs to that hour; a row after the hour is the latest for the NEXT hour boundary only if nothing later
        by_hour[h] = (ts, r) if (h not in by_hour or ts >= by_hour[h][0]) else by_hour[h]
    return by_hour


def run_pair(pair, end):
    path = os.path.join(OUT, f"{pair}-metrics-1h.jsonl.gz"); man = os.path.join(OUT, f"{pair}-manifest.json")
    manifest = json.load(open(man)) if os.path.exists(man) else {"pair": pair, "days": {}}
    done = {k for k, v in manifest["days"].items() if v.get("status") in ("ok", "missing")}   # error days are retried
    d = START; f = gzip.open(path, "at")
    while d <= end:
        ds = d.isoformat()
        if ds not in done:
            try:
                rows, h = day_rows(pair, d)
                if rows is None:
                    manifest["days"][ds] = {"status": "missing"}
                else:
                    hb = hourly(rows)
                    for hh in sorted(hb):
                        ts, r = hb[hh]
                        fl = lambda k: (float(r[k]) if r.get(k) not in (None, "") else None)   # some days leave ratio columns empty
                        f.write(json.dumps({"pair": pair, "h": hh, "ts": ts, "oi": fl("sum_open_interest"), "oiv": fl("sum_open_interest_value"),
                                            "tt_ls_cnt": fl("count_toptrader_long_short_ratio"), "tt_ls_sum": fl("sum_toptrader_long_short_ratio"),
                                            "ls_cnt": fl("count_long_short_ratio"), "taker": fl("sum_taker_long_short_vol_ratio")}, separators=(",", ":")) + "\n")
                    manifest["days"][ds] = {"status": "ok", "rows": len(rows), "sha256": h}
            except Exception as e:
                manifest["days"][ds] = {"status": "error", "error": str(e)[:120]}
            if len(manifest["days"]) % 50 == 0:
                f.flush(); json.dump(manifest, open(man, "w"))
        d += dt.timedelta(days=1)
    f.close(); json.dump(manifest, open(man, "w"), indent=0)
    # funding (monthly files)
    fr = os.path.join(OUT, f"{pair}-funding.jsonl"); seen = set()
    if os.path.exists(fr):
        for l in open(fr): seen.add(json.loads(l)["m"])
    with open(fr, "a") as g:
        m = dt.date(2021, 12, 1)
        while m <= end:
            ms = m.strftime("%Y-%m")
            if ms not in seen:
                raw = get(f"{BASE}/monthly/fundingRate/{pair}/{pair}-fundingRate-{ms}.zip")
                if raw:
                    z = zipfile.ZipFile(io.BytesIO(raw)); txt = z.read(z.namelist()[0]).decode()
                    for r in csv.DictReader(io.StringIO(txt)):
                        g.write(json.dumps({"pair": pair, "m": ms, "t": int(r["calc_time"]) // 1000, "rate": float(r["last_funding_rate"])}) + "\n")
                else:
                    g.write(json.dumps({"pair": pair, "m": ms, "missing": True}) + "\n")
            m = (m.replace(day=1) + dt.timedelta(days=32)).replace(day=1)
    print(pair, "done", flush=True)


if __name__ == "__main__":
    end = dt.date.today() - dt.timedelta(days=2)
    th = [threading.Thread(target=run_pair, args=(p, end)) for p in PAIRS]
    for i, t in enumerate(th):
        t.start(); time.sleep(0.5)
    [t.join() for t in th]
    print("all done", flush=True)
