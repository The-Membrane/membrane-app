"""Q26-P1 forward shadow logger (REGISTRATION.md §6). RECORD-ONLY: it stores inputs; it computes no rule decision and no
outcome. Not deployed; no live job is changed by this file. Run once per UTC day (after 00:30Z) for the previous day,
or with a date range to backfill (the sigma seed needs the 31 days before T_REG).

Usage: python3 -I shadow_log.py <store_dir> <YYYY-MM-DD> [<YYYY-MM-DD end>]
Store layout (same schemas as the development inputs, so prep_cf.py reads it unchanged):
  <store>/{ETH,BTC}USDT-1h.json  membrane-datasets binance-klines schema (startTs, stepSeconds, count, columns)
  <store>/rates.json             fetch_cf_rates.py rows (Aave V3 Ethereum Core USDC/USDT, last ReserveDataUpdated <= day end)
  <store>/log.jsonl              one record per day, hash-chained (prev = sha256 of the previous line)
Sources (keyless): https://data-api.binance.vision/api/v3/klines (Binance public market data); Aave V3 Ethereum Pool
ReserveDataUpdated logs via fetch_cf_rates.py ethereum_v3 on public RPCs.
"""
import hashlib, json, os, subprocess, sys, tempfile, time, urllib.request, datetime as dt

HERE = os.path.dirname(os.path.abspath(__file__))
KL = "https://data-api.binance.vision/api/v3/klines?symbol={s}USDT&interval=1h&startTime={a}&endTime={b}&limit=1000"


def sha(b):
    return hashlib.sha256(b).hexdigest()


def get(url):
    for k in range(6):
        try:
            return urllib.request.urlopen(urllib.request.Request(url, headers={"user-agent": "curl/8.5.0"}), timeout=60).read()
        except Exception as e:  # back off and retry
            err = e; time.sleep(2 + 3 * k)
    raise err


def code_sha():
    try:
        return subprocess.run(["git", "-C", HERE, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    except Exception:
        return None


def log_day(store, day):
    t0 = int(dt.datetime.fromisoformat(day).replace(tzinfo=dt.timezone.utc).timestamp())
    rec = {"date": day, "fetched_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "code_sha": code_sha()}
    for s in ["ETH", "BTC"]:
        raw = get(KL.format(s=s, a=t0 * 1000, b=(t0 + 86400) * 1000 - 1))
        rows = {int(r[0]) // 1000: r for r in json.loads(raw)}
        path = os.path.join(store, f"{s}USDT-1h.json")
        if os.path.exists(path):
            d = json.load(open(path))
        else:
            d = {"asset": f"{s}/USDT", "source": "Binance spot klines, data-api.binance.vision/api/v3/klines (public, no key)",
                 "startTs": t0, "stepSeconds": 3600, "count": 0, "columns": {k: [] for k in ["open", "high", "low", "close", "volume"]}}
        i0 = (t0 - d["startTs"]) // 3600
        assert i0 >= 0, "days must be logged in order from the store start"
        for k in d["columns"]:  # pad to the day start (missing earlier hours stay null), then write 24 hours
            d["columns"][k] += [None] * max(0, i0 + 24 - len(d["columns"][k]))
        nulls = 0
        for h in range(24):
            r = rows.get(t0 + 3600 * h)
            if r is None:
                nulls += 1
            for j, k in enumerate(["open", "high", "low", "close", "volume"]):
                d["columns"][k][i0 + h] = None if r is None else float(r[1 + j])
        d["count"] = len(d["columns"]["close"])
        json.dump(d, open(path, "w"))
        rec[f"{s}_hours"] = 24 - nulls; rec[f"{s}_raw_sha256"] = sha(raw)
    with tempfile.TemporaryDirectory() as td:
        tmp = os.path.join(td, "r.json")
        subprocess.run([sys.executable, "-I", os.path.join(HERE, "fetch_cf_rates.py"), "ethereum_v3", day, day, tmp], check=True,
                       stdout=subprocess.DEVNULL)
        new = json.load(open(tmp))
    rp = os.path.join(store, "rates.json")
    R = json.load(open(rp)) if os.path.exists(rp) else {"source": new["source"], "rows": []}
    R["rows"] = [r for r in R["rows"] if r["date"] != day] + new["rows"]
    json.dump(R, open(rp, "w"))
    rec["rate_rows"] = len(new["rows"]); rec["rate_misses"] = new["misses"]
    rec["rates"] = {r["reserve"]: {"ts": r["ts"], "variableBorrowRate_ray": r["variableBorrowRate_ray"]} for r in new["rows"]}
    for f in ["ETHUSDT-1h.json", "BTCUSDT-1h.json", "rates.json"]:
        rec[f"store_sha256_{f}"] = sha(open(os.path.join(store, f), "rb").read())
    lp = os.path.join(store, "log.jsonl")
    prev = open(lp, "rb").read().splitlines()[-1] if os.path.exists(lp) and os.path.getsize(lp) else b""
    rec["prev"] = sha(prev)
    with open(lp, "a") as f:
        f.write(json.dumps(rec, sort_keys=True) + "\n")
    print(day, {k: rec[k] for k in ["ETH_hours", "BTC_hours", "rate_rows"]}, flush=True)


if __name__ == "__main__":
    store, a = sys.argv[1:3]; b = sys.argv[3] if len(sys.argv) > 3 else a
    os.makedirs(store, exist_ok=True)
    d = dt.date.fromisoformat(a)
    while d <= dt.date.fromisoformat(b):
        log_day(store, d.isoformat()); d += dt.timedelta(days=1)
