#!/usr/bin/env python3
"""Q26 R11.11 blind set C1 acquisition: intraday pool cash of the Aave V3 Arbitrum native USDC reserve.

membrane-board design/Q26_ROUND11_PREREG.md D-R11.11b (readings, fixed before any C1 read); inventory
design/q26-blind-set-inventory-2026-10-17.md set C1. Outcome-blind: the builder computes no cash path, minimum,
ratio, forecast or score.

  python3 r1111_acquire_c1.py --work <dir> --out <membrane-datasets>/aave-pool-cash-c1

Streams (free keyless RPC):
  in / out   native USDC Transfer logs with the aToken as `to` / `from`, blocks [aToken deployment, END], END = the
             last block with ts < 2026-10-17T00:00Z (Tenderly public gateway; arb1.arbitrum.io fallback).
  daily      anchor b_d = last block with ts < d 00:00Z for d in 2023-06-29..2026-10-17; at b_d (d <= 2026-10-16)
             archive eth_call aToken totalSupply(), USDC balanceOf(aToken), variable-debt totalSupply().
Address-free output: logs as block, ts, tx_index, log_index, amount_raw; daily rows as day, block, block_ts,
next_block_ts, atoken_total_supply, cash_balance, vdebt_total_supply. Every output is checked for 0x + 40 hex.
"""
import argparse
import csv
import datetime as dt
import gzip
import io
import json
import os
import re
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import l1_acquire_cash as L1  # noqa: E402
import r118_acquire as A  # noqa: E402

USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831"          # Arbitrum native USDC (6 decimals)
ATOKEN = "0x724dc807b04555b71ed48a6896b6f41593b8c637"        # Aave V3 Arbitrum aUSDCn (getReserveData)
VDEBT = "0xf611aeb5013fd2c0511c9cd55c7dc5c1140741a6"
DEPLOY_BLOCK = 105740626                                     # eth_getCode bisection (D-R11.11b)
FIRST_DAY = dt.date(2023, 6, 29)
END_DAY = dt.date(2026, 10, 17)                              # END = last block with ts < END_DAY 00:00Z
LOG_URLS = ["https://arbitrum.gateway.tenderly.co", "https://arb1.arbitrum.io/rpc"]
STATE_URLS = ["https://arbitrum.gateway.tenderly.co", "https://gateway.tenderly.co/public/arbitrum"]
RANGE = 1_000_000
LOG_FIELDS = ["block", "ts", "tx_index", "log_index", "amount_raw"]
DAY_FIELDS = ["day", "block", "block_ts", "next_block_ts", "atoken_total_supply", "cash_balance",
              "vdebt_total_supply"]
ADDR_RE = re.compile(r"0x[0-9a-fA-F]{40}")


def streams():
    return {"in": {"address": USDC, "topics": [L1.T_TRANSFER, None, L1.pad(ATOKEN)]},
            "out": {"address": USDC, "topics": [L1.T_TRANSFER, L1.pad(ATOKEN)]}}


def slim(rows):
    out = []
    for r in rows:
        if r["topic0"] != L1.T_TRANSFER:
            raise SystemExit("STOP: non-Transfer log")
        out.append({"block": r["block"], "ts": r["ts"], "tx_index": r["tx_index"], "log_index": r["log_index"],
                    "amount_raw": str(int(r["data"][2:66], 16))})
    return out


def fetch_range(clients, spec, lo, hi):
    err = None
    for c in clients:
        try:
            return L1.fetch(c, spec, lo, hi)
        except SystemExit as e:          # fails at minimum size on this endpoint: try the next one
            err = e
    raise SystemExit(f"STOP: every log endpoint failed at [{lo},{hi}]: {err}")


def run_stream(clients, name, spec, work, start, end):
    d = os.path.join(work, name)
    os.makedirs(d, exist_ok=True)
    lo = start
    while lo <= end:
        hi = min(lo + RANGE - 1, end)
        p = os.path.join(d, f"{lo}-{hi}.json.gz")
        if not os.path.exists(p):
            rows = slim(fetch_range(clients, spec, lo, hi))
            with gzip.open(p + ".tmp", "wt") as f:
                json.dump(rows, f)
            os.replace(p + ".tmp", p)
        lo = hi + 1
    rows = []
    for fn in os.listdir(d):
        if fn.endswith(".json.gz"):
            a, b = map(int, fn[:-8].split("-"))
            if a >= start and b <= end:
                with gzip.open(os.path.join(d, fn), "rt") as f:
                    rows.extend(json.load(f))
    rows.sort(key=lambda r: (r["block"], r["log_index"]))
    keys = [(r["block"], r["log_index"]) for r in rows]
    if len(set(keys)) != len(keys):
        raise SystemExit(f"STOP: duplicate logs in {name}")
    return rows


def day_blocks(rpc, work):
    """anchor b_d = last block with ts < d 00:00Z for d in FIRST_DAY..END_DAY (r118 find_before)."""
    path = os.path.join(work, "blocks.json.gz")
    out = A.jload(path, {})
    hb, _ = A.head(rpc)
    cache = {}

    def get(n):
        if n not in cache:
            cache[n] = A.block_ts(rpc, [n])[0]
        return cache[n]
    d, prev, k = FIRST_DAY, None, 0
    while d <= END_DAY:
        key = d.isoformat()
        if key not in out:
            T = A.utc(d)
            lo = prev[0] if prev else DEPLOY_BLOCK
            if get(lo) >= T:
                raise SystemExit(f"STOP: block {lo} is not before {key}")
            span = 400_000
            hi = min(hb, lo + span)
            while get(hi) < T:
                lo, hi = hi, min(hb, hi + span * 2)
            b, tb, tn = A.find_before(T, get, lo, hi)
            out[key] = [b, tb, tn]
            k += 1
            if k % 50 == 0:
                A.jdump(path, out)
                print("blocks", key, b, flush=True)
            if len(cache) > 5000:
                cache.clear()
        prev = out[key]
        d += dt.timedelta(days=1)
    A.jdump(path, out)
    return out


def word_call(to, data, block):
    return ("eth_call", [{"to": to, "data": data}, hex(block)])


def daily_reads(rpc, blocks, work):
    path = os.path.join(work, "daily.json.gz")
    out = A.jload(path, {})
    days = sorted(k for k in blocks if dt.date.fromisoformat(k) < END_DAY)
    sel_ts = "0x" + A.SEL["totalSupply"].hex()
    sel_bal = "0x" + A.SEL["balanceOf"].hex() + "0" * 24 + ATOKEN[2:]
    for i, day in enumerate(days):
        if day in out:
            continue
        b = blocks[day][0]
        res = rpc.batch([word_call(ATOKEN, sel_ts, b), word_call(USDC, sel_bal, b), word_call(VDEBT, sel_ts, b)])
        vals = [A.one(x) for x in res]
        if any(v is None for v in vals):
            raise SystemExit(f"STOP: state read failed at {day}")
        out[day] = [str(v) for v in vals]
        if i % 100 == 0:
            A.jdump(path, out)
            print("daily", day, flush=True)
    A.jdump(path, out)
    return out


def write_csv_gz(path, rows, fields):
    with gzip.GzipFile(path, "wb", mtime=0) as g:
        t = io.TextIOWrapper(g, encoding="utf-8", newline="")
        w = csv.DictWriter(t, fieldnames=fields, lineterminator="\n")
        w.writeheader()
        for r in rows:
            w.writerow(r)
        t.flush()
        t.detach()


def guard(path):
    txt = gzip.open(path, "rt").read() if path.endswith(".gz") else open(path).read()
    if ADDR_RE.search(txt):
        raise SystemExit(f"STOP: address-like string in {path}")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--work", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    t0 = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    os.makedirs(a.work, exist_ok=True)
    os.makedirs(a.out, exist_ok=True)
    rpc = A.Rpc(STATE_URLS, interval=0.12)
    blocks = day_blocks(rpc, a.work)
    end_block = blocks[END_DAY.isoformat()][0]
    print("END block", end_block, flush=True)
    daily = daily_reads(rpc, blocks, a.work)
    clients = [L1.Client(url=u) for u in LOG_URLS]
    files, counts = {}, {}
    for name, spec in streams().items():
        rows = run_stream(clients, name, spec, a.work, DEPLOY_BLOCK, end_block)
        p = os.path.join(a.out, f"raw-transfers-arb_usdcn-{name}.csv.gz")
        write_csv_gz(p, rows, LOG_FIELDS)
        guard(p)
        files[os.path.basename(p)] = (os.path.getsize(p), L1.sha256_file(p))
        counts[name] = len(rows)
        print(name, len(rows), flush=True)
    drows = [{"day": d, "block": blocks[d][0], "block_ts": blocks[d][1], "next_block_ts": blocks[d][2],
              "atoken_total_supply": daily[d][0], "cash_balance": daily[d][1], "vdebt_total_supply": daily[d][2]}
             for d in sorted(daily)]
    dp = os.path.join(a.out, "daily-state-arb_usdcn.csv")
    with open(dp, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=DAY_FIELDS, lineterminator="\n")
        w.writeheader()
        w.writerows(drows)
    guard(dp)
    files[os.path.basename(dp)] = (os.path.getsize(dp), L1.sha256_file(dp))
    counts["daily_rows"] = len(drows)
    t1 = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    here = os.path.dirname(os.path.abspath(__file__))
    head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=here, capture_output=True, text=True).stdout.strip()
    dirty = bool(subprocess.run(["git", "status", "--porcelain", "--", os.path.basename(__file__),
                                 "l1_acquire_cash.py", "r118_acquire.py"], cwd=here, capture_output=True,
                                text=True).stdout.strip())
    me = os.path.abspath(__file__)
    log = {"log_endpoints": [c.url for c in clients], "state_endpoints": STATE_URLS, "deploy_block": DEPLOY_BLOCK,
           "end_block": end_block, "end_day": END_DAY.isoformat(), "first_day": FIRST_DAY.isoformat(),
           "counts": counts, "client": [c.counts for c in clients], "rpc": rpc.counts, "fetchWindow": [t0, t1],
           "code": {"file": "scripts/research/history-forecasts/r1111_acquire_c1.py", "head": head,
                    "tree_dirty": dirty, "sha256": L1.sha256_file(me)}}
    rl = os.path.join(a.out, "run-log.json")
    txt = json.dumps(log, indent=1, sort_keys=True)
    txt = ADDR_RE.sub("<addr>", txt)
    with open(rl, "w") as f:
        f.write(txt)
    guard(rl)
    files["run-log.json"] = (os.path.getsize(rl), L1.sha256_file(rl))
    lines = [
        "# aave-pool-cash-c1 — provenance",
        "",
        "**LOCKED blind set C1** (membrane-board `design/q26-blind-set-inventory-2026-10-17.md`). The only",
        "preregistration that may score it is Q26 R11.11 (`design/Q26_ROUND11_PREREG.md` D-R11.11b). Score once.",
        "After the score it is grade C for the daily-minimum cash target. A counts-only check does not spend it.",
        "",
        "Intraday pool cash of the Aave V3 Arbitrum **native USDC** reserve (6 decimals). Bridged USDC.e is not",
        "included. The builder computes no cash path, minimum, forecast or score.",
        "",
        "- **Source:** free keyless RPC. Logs: `eth_getLogs` on the Arbitrum Tenderly public gateway (fallback",
        f"  `arb1.arbitrum.io/rpc`), ranges <= {RANGE} blocks, split in half on any error or >= {L1.CAP} logs;",
        "  `ts` = the endpoint's `blockTimestamp`. State: archive `eth_call` on the Tenderly gateway.",
        "- **Streams:** `in` = native USDC Transfer with to = the reserve's aToken; `out` = from = the aToken.",
        "  Contract identities are in the builder code; no address is written here.",
        f"- **Blocks:** aToken deployment block {DEPLOY_BLOCK} .. {end_block} (the last block with ts <",
        f"  {END_DAY.isoformat()}T00:00:00Z) inclusive.",
        "- **Daily state:** for each day d from 2023-06-29 to 2026-10-16, the anchor block = the last block with",
        "  ts < d 00:00Z (`next_block_ts` >= d 00:00Z proves it), aToken totalSupply, USDC balance of the aToken",
        "  (pool cash) and variable-debt totalSupply, raw units.",
        f"- **Builder:** `The-Membrane/membrane-app` branch `research/history-forecasts`, "
        f"`scripts/research/history-forecasts/r1111_acquire_c1.py` (HEAD `{head}`, dirty {dirty}, sha256 "
        f"`{L1.sha256_file(me)}`).",
        f"- **Fetch window (UTC):** {t0} -> {t1}.",
        f"- **Counts:** {json.dumps(counts)}.",
        "",
        "| file | bytes | sha256 |",
        "|---|---:|---|",
    ] + [f"| `{k}` | {v[0]} | `{v[1]}` |" for k, v in sorted(files.items())]
    pp = os.path.join(a.out, "PROVENANCE.md")
    with open(pp, "w") as f:
        f.write("\n".join(lines) + "\n")
    guard(pp)
    print(json.dumps({"counts": counts}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
