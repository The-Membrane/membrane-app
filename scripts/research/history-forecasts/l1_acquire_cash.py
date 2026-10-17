#!/usr/bin/env python3
"""Q26 round 8 R8.4 (workstream L1) acquisition: intraday cash and supply APR inputs for Aave V3 Core USDC.

  python3 l1_acquire_cash.py --work <dir> --out <dir> [--end-block 26186746]

membrane-board design/Q26_ROUND8_PREREG.md @91a3eba R8.4 needs pool cash and the supply APR at every event time.
membrane-datasets holds aUSDC token events (supply side) and Borrow/Repay logs, but no liquidation, flash-loan or
withdraw-to-other cash legs. Pool cash is exactly USDC.balanceOf(aUSDC), so its every change is a USDC Transfer
log with aUSDC as `from` or `to`. The supply APR is the `liquidityRate` of the Pool's ReserveDataUpdated log for
USDC, emitted at every rate update. Three topic-filtered eth_getLogs streams, free endpoint, no key:

- `usdc-in`:  USDC (0xA0b8...eB48) Transfer, topic2 = aUSDC
- `usdc-out`: USDC Transfer, topic1 = aUSDC
- `rdu`:      Pool (0x8787...A4E2) ReserveDataUpdated, topic1 = USDC

Blocks [aUSDC deploy 16496802, end block] (default 26186746 = the depositor-events asof). Ranges <= 50,000
blocks, split in half on any error or a result of >= 10,000 logs, <= 2 requests/s, rate limit: wait 30 s, <= 5
retries, then stop. Every log carries the endpoint's blockTimestamp. Raw logs are written as returned
(raw-logs-<stream>.csv.gz, sorted by block then log index) with a PROVENANCE.md holding sha256 of each file.
Decoding happens in l1_pool_risk.py. The builder computes no outcome.
"""
import argparse
import csv
import gzip
import hashlib
import io
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

URL = "https://rpc.mevblocker.io"
USER_AGENT = "curl/8.5.0"  # urllib's default UA gets HTTP 403 from this endpoint
USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
AUSDC = "0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c"
POOL = "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2"
T_TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
T_RDU = "0x804c9b842b2748a22bb64b345453a3de7ca54a6ca45ce00d415894979e22897a"
START_BLOCK = 16496802
END_BLOCK = 26186746
RANGE_MAX = 50_000
MIN_RANGE = 250
CAP = 10_000
INTERVAL_S = 0.5
RETRY_WAIT_S = 30
MAX_RETRIES = 5


def pad(a):
    return "0x" + "0" * 24 + a[2:].lower()


STREAMS = {
    "usdc-in": {"address": USDC, "topics": [T_TRANSFER, None, pad(AUSDC)]},
    "usdc-out": {"address": USDC, "topics": [T_TRANSFER, pad(AUSDC)]},
    "rdu": {"address": POOL, "topics": [T_RDU, pad(USDC)]},
}
FIELDS = ["address", "block", "ts", "tx_hash", "tx_index", "log_index", "topic0", "topic1", "topic2", "topic3",
          "data"]


class RangeError(Exception):
    pass


class Client:
    def __init__(self, url=URL, post=None, sleep=time.sleep):
        self.url = url
        self.post = post or self._post
        self.sleep = sleep
        self.last = 0.0
        self.counts = {"requests": 0, "ok": 0, "splits": 0, "rate_limit_retries": 0, "errors": 0, "logs": 0}
        self._id = 0

    def _post(self, payload):
        req = urllib.request.Request(self.url, data=payload, headers={
            "content-type": "application/json", "accept": "application/json", "user-agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read() if hasattr(e, "read") else b""

    def get_logs(self, spec, lo, hi):
        self._id += 1
        q = {"address": spec["address"], "fromBlock": hex(lo), "toBlock": hex(hi), "topics": spec["topics"]}
        payload = json.dumps({"jsonrpc": "2.0", "id": self._id, "method": "eth_getLogs", "params": [q]}).encode()
        retries = 0
        while True:
            wait = INTERVAL_S - (time.monotonic() - self.last)
            if wait > 0:
                self.sleep(wait)
            self.last = time.monotonic()
            self.counts["requests"] += 1
            try:
                status, body = self.post(payload)
            except OSError as e:
                self.counts["errors"] += 1
                raise RangeError(f"transport {e}")
            text = body.decode(errors="replace").lower()
            if status == 429 or "rate limit" in text or "too many requests" in text:
                retries += 1
                if retries > MAX_RETRIES:
                    raise SystemExit(f"STOP: rate limit after {MAX_RETRIES} retries at [{lo},{hi}]")
                self.counts["rate_limit_retries"] += 1
                self.sleep(RETRY_WAIT_S)
                continue
            if status != 200:
                self.counts["errors"] += 1
                raise RangeError(f"HTTP {status}")
            obj = json.loads(body)
            if obj.get("error") is not None or "result" not in obj:
                self.counts["errors"] += 1
                raise RangeError(f"rpc error {str(obj.get('error'))[:200]}")
            res = obj["result"]
            if len(res) >= CAP:
                raise RangeError(f"result cap {len(res)}")
            out = []
            for g in res:
                b = int(g["blockNumber"], 16)
                if not (lo <= b <= hi) or g.get("removed"):
                    raise RangeError("log outside range or removed")
                if g["address"].lower() != spec["address"]:
                    raise RangeError("address mismatch")
                tps = [t.lower() for t in g["topics"]]
                for i, t in enumerate(spec["topics"]):
                    if t is not None and (len(tps) <= i or tps[i] != t):
                        raise RangeError("topic mismatch")
                out.append({"address": g["address"].lower(), "block": b, "ts": int(g["blockTimestamp"], 16),
                            "tx_hash": g["transactionHash"].lower(), "tx_index": int(g["transactionIndex"], 16),
                            "log_index": int(g["logIndex"], 16),
                            "topic0": tps[0], "topic1": tps[1] if len(tps) > 1 else "",
                            "topic2": tps[2] if len(tps) > 2 else "", "topic3": tps[3] if len(tps) > 3 else "",
                            "data": g["data"].lower()})
            self.counts["ok"] += 1
            self.counts["logs"] += len(out)
            return out


def fetch(client, spec, lo, hi):
    try:
        return client.get_logs(spec, lo, hi)
    except RangeError as e:
        if hi - lo + 1 <= MIN_RANGE:
            raise SystemExit(f"STOP: range [{lo},{hi}] fails at minimum size: {e}")
        client.counts["splits"] += 1
        mid = (lo + hi) // 2
        return fetch(client, spec, lo, mid) + fetch(client, spec, mid + 1, hi)


def sha256_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def run_stream(client, name, work, start, end):
    spec = STREAMS[name]
    d = os.path.join(work, name)
    os.makedirs(d, exist_ok=True)
    lo = start
    while lo <= end:
        hi = min(lo + RANGE_MAX - 1, end)
        p = os.path.join(d, f"{lo}-{hi}.json")
        if not os.path.exists(p):
            logs = fetch(client, spec, lo, hi)
            with open(p + ".tmp", "w") as f:
                json.dump(logs, f)
            os.replace(p + ".tmp", p)
        lo = hi + 1
    rows = []
    for fn in os.listdir(d):
        if fn.endswith(".json"):
            a, b = map(int, fn[:-5].split("-"))
            if a >= start and b <= end:
                with open(os.path.join(d, fn)) as f:
                    rows.extend(json.load(f))
    rows.sort(key=lambda r: (r["block"], r["log_index"]))
    keys = [(r["block"], r["log_index"]) for r in rows]
    if len(set(keys)) != len(keys):
        raise SystemExit(f"STOP: duplicate logs in {name}")
    return rows


def write_csv_gz(path, rows):
    with gzip.GzipFile(path, "wb", mtime=0) as g:
        t = io.TextIOWrapper(g, encoding="utf-8", newline="")
        w = csv.DictWriter(t, fieldnames=FIELDS, lineterminator="\n")
        w.writeheader()
        for r in rows:
            w.writerow(r)
        t.flush()
        t.detach()


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--work", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--start-block", type=int, default=START_BLOCK)
    ap.add_argument("--end-block", type=int, default=END_BLOCK)
    a = ap.parse_args(argv)
    t0 = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    client = Client()
    os.makedirs(a.out, exist_ok=True)
    files, counts = {}, {}
    for name in STREAMS:
        rows = run_stream(client, name, a.work, a.start_block, a.end_block)
        p = os.path.join(a.out, f"raw-logs-{name}.csv.gz")
        write_csv_gz(p, rows)
        files[os.path.basename(p)] = (os.path.getsize(p), sha256_file(p))
        counts[name] = len(rows)
        print(name, len(rows), file=sys.stderr)
    t1 = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    try:
        head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=os.path.dirname(os.path.abspath(__file__)),
                              capture_output=True, text=True).stdout.strip()
    except OSError:
        head = None
    me = os.path.abspath(__file__)
    log = {"url": URL, "streams": STREAMS, "startBlock": a.start_block, "endBlock": a.end_block,
           "counts": counts, "client": client.counts, "fetchWindow": [t0, t1],
           "code": {"file": "scripts/research/history-forecasts/l1_acquire_cash.py", "head": head,
                    "sha256": sha256_file(me)}}
    with open(os.path.join(a.out, "run-log.json"), "w") as f:
        json.dump(log, f, indent=1, sort_keys=True)
    files["run-log.json"] = (os.path.getsize(os.path.join(a.out, "run-log.json")),
                             sha256_file(os.path.join(a.out, "run-log.json")))
    lines = [
        "# aave-pool-cash — provenance",
        "",
        "Intraday cash and supply-rate inputs for Aave V3 Ethereum Core USDC, acquired for Q26 R8.4 (workstream L1),",
        "membrane-board `design/Q26_ROUND8_PREREG.md` (commit `91a3eba`). The builder computes no outcome.",
        "",
        f"- **Source:** `eth_getLogs` on `{URL}` (free, no key); ranges <= {RANGE_MAX} blocks, split in half on any",
        f"  error or >= {CAP} logs, <= 2 requests/s; `ts` = the endpoint's `blockTimestamp`.",
        f"- **Streams:** `usdc-in` = USDC `{USDC}` Transfer with to = aUSDC `{AUSDC}`; `usdc-out` = USDC Transfer",
        f"  with from = aUSDC; `rdu` = Pool `{POOL}` ReserveDataUpdated with reserve = USDC (data: liquidityRate,",
        "  stableBorrowRate, variableBorrowRate, liquidityIndex, variableBorrowIndex; ray).",
        f"- **Blocks:** {a.start_block} (aUSDC deployment) .. {a.end_block} (the depositor-events asof) inclusive.",
        f"- **Builder:** `The-Membrane/membrane-app` branch `research/history-forecasts`, "
        f"`scripts/research/history-forecasts/l1_acquire_cash.py` (HEAD `{head}`, builder sha256 `{sha256_file(me)}`).",
        f"- **Fetch window (UTC):** {t0} -> {t1}.",
        "- **Use:** pool cash = USDC.balanceOf(aUSDC), so cash(t) = cash(anchor) + sum(in) - sum(out) is exact;",
        "  l1_pool_risk.py checks it against every daily `depositor-balances/reserve-state.csv` cash.",
        f"- **Counts:** {json.dumps(counts)}.",
        "",
        "| file | bytes | sha256 |",
        "|---|---:|---|",
    ] + [f"| `{k}` | {v[0]} | `{v[1]}` |" for k, v in sorted(files.items())]
    with open(os.path.join(a.out, "PROVENANCE.md"), "w") as f:
        f.write("\n".join(lines) + "\n")
    print(json.dumps({"counts": counts, "client": client.counts}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
