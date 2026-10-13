#!/usr/bin/env python3
"""T2 step 1 (acquisition): DefiLlama free coins.llama.fi hourly price charts.

Preregistration: triccs/membrane-board design/VALIDATION_PREREG.md (commit 506e7c5), T2.4:
"DefiLlama free coins.llama.fi price charts for sdeUSD, deUSD, msY, msUSD and AZND only.
Saved under the incident directory with a PROVENANCE row and sha256 BEFORE any indicator runs."

For each token this pulls the on-chain address key (`ethereum:<address>`) and, where a
CoinGecko id for the token already appears in the datasets, the `coingecko:<id>` key, both
through the same coins.llama.fi chart endpoint. The endpoint serves at most 500 points per
request, so the range is read in 500-hour chunks. Every chunk response is stored verbatim
(parsed JSON body) with its URL, fetch time, HTTP status, byte count and the sha256 of the
raw body bytes. A key that returns no prices in any chunk is recorded as "not listed".

Output: <datasets>/curator-incidents/<incident>/<token>-price-defillama-<start>_<end>-1h.json
Stdlib only. Run once; the files are then frozen and indicator code only reads them.
"""
import argparse, hashlib, json, os, sys, time, urllib.error, urllib.request
from datetime import datetime, timezone

API = "https://coins.llama.fi/chart/{key}?start={start}&span={span}&period=1h&searchWidth=1800"
MAX_SPAN = 500  # "Requested 1000 data points exceeds the maximum of 500."

# Addresses from curator-incidents/*/findings.json and the market files' params.
# CoinGecko ids only where the datasets already name them:
#   elixir-staked-deusd, elixir-deusd: position-alerts/e2-stream-nov-2025.json marketPrices
#   mu-digital-aznd: curator-incidents/msy-aznd-2026/findings.json markets["AZND/USDC"].price.source
TOKENS = [
    # token, incident dir, address, coingecko id or None, range start, range end (UTC dates)
    ("sdeUSD", "sdeusd-2025", "0x5c5b196abe0d54485975d1ec29617d42d9198326", "elixir-staked-deusd", "2025-02-01", "2025-12-01"),
    ("deUSD", "sdeusd-2025", "0x15700b564ca08d9439c58ca5053166e8317aa138", "elixir-deusd", "2025-02-01", "2025-12-01"),
    ("msY", "msy-aznd-2026", "0x890a5122aa1da30fec4286de7904ff808f0bd74a", None, "2026-04-01", "2026-08-15"),
    ("msUSD", "msy-aznd-2026", "0x4ba01f22827018b4772cd326c7627fb4956a7c00", None, "2026-04-01", "2026-08-15"),
    ("AZND", "msy-aznd-2026", "0x52c66b5e7f8fde20843de900c5c8b4b0f23708a0", "mu-digital-aznd", "2026-03-01", "2026-08-15"),
]


def iso_now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def day_ts(s):
    return int(datetime.strptime(s, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp())


def get_raw(url, tries=5):
    last = None
    for i in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=120) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:  # 4xx is an answer, keep it
            if e.code < 500:
                return e.code, e.read()
            last = e
        except Exception as e:  # network blip: back off and retry
            last = e
        time.sleep(2 ** (i + 1))
    raise last


def pull_key(key, start, end):
    reqs = []
    t = start
    while t < end:
        span = min(MAX_SPAN, (end - t) // 3600)
        url = API.format(key=key, start=t, span=span)
        fetched = iso_now()
        status, raw = get_raw(url)
        try:
            body = json.loads(raw)
        except Exception:
            body = {"_unparsed": raw.decode("utf-8", "replace")}
        reqs.append({"url": url, "fetchedAt": fetched, "httpStatus": status, "bytes": len(raw),
                     "sha256": hashlib.sha256(raw).hexdigest(), "body": body})
        t += span * 3600
        time.sleep(0.4)
    n = sum(len(v.get("prices", [])) for r in reqs for v in (r["body"].get("coins") or {}).values())
    return reqs, n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--datasets", required=True)
    a = ap.parse_args()
    summary = []
    for token, inc, addr, cg, s, e in TOKENS:
        start, end = day_ts(s), day_ts(e)
        keys = [f"ethereum:{addr}"] + ([f"coingecko:{cg}"] if cg else [])
        out = {"token": token, "address": addr, "range": {"startUtc": s, "endUtc": e, "start": start, "end": end},
               "period": "1h", "searchWidth": 1800, "maxSpanPerRequest": MAX_SPAN,
               "prereg": "triccs/membrane-board design/VALIDATION_PREREG.md @506e7c5 T2.4",
               "fetchStartedAt": iso_now(), "keys": {}}
        for key in keys:
            reqs, n = pull_key(key, start, end)
            out["keys"][key] = {"listed": n > 0, "prices": n, "requests": reqs}
            print(f"{token} {key}: {n} prices in {len(reqs)} requests", file=sys.stderr)
        out["fetchFinishedAt"] = iso_now()
        path = os.path.join(a.datasets, "curator-incidents", inc, f"{token.lower()}-price-defillama-{s}_{e}-1h.json")
        data = json.dumps(out, separators=(",", ":"), sort_keys=False).encode()
        with open(path, "wb") as f:
            f.write(data)
        summary.append({"token": token, "file": path, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(),
                        "fetchStartedAt": out["fetchStartedAt"], "fetchFinishedAt": out["fetchFinishedAt"],
                        "keys": {k: {"listed": v["listed"], "prices": v["prices"], "requests": len(v["requests"]),
                                     "firstUrl": v["requests"][0]["url"]} for k, v in out["keys"].items()}})
    print(json.dumps(summary, indent=1))


if __name__ == "__main__":
    main()
