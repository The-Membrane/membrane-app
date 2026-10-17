#!/usr/bin/env python3
"""Q26 R10.4-B blind set C2 acquisition: intraday pool cash streams for Aave V3 Ethereum Core PYUSD, USDS, RLUSD.

membrane-board design/q26-blind-set-inventory-2026-10-17.md set C2 and design/Q26_ROUND11_PREREG.md D-R11.9a
(addendum: C2 is the blind step of R10.4 step 1). Readings: design/Q26_ROUND10_PREREG.md D-R10.4-Ba.

  python3 r104b_acquire_c2.py --work <dir> --out <membrane-datasets>/aave-pool-cash-c2

Pool cash of a reserve is exactly underlying.balanceOf(aToken), so its every change is an underlying Transfer log
with the aToken as `from` or `to`. Two topic-filtered eth_getLogs streams per reserve on the free endpoint of
l1_acquire_cash.py (same client, pacing, split and stop rules): `<reserve>-in` (topic2 = aToken) and
`<reserve>-out` (topic1 = aToken), blocks [aToken deployment, 26186746] (the depositor-events / depositor-blind5
asof). Outcome-blind: the builder computes no cash path, minimum, forecast or score.

Address-free output: per log only block, ts (endpoint blockTimestamp), tx_index, log_index and the transferred
amount in raw token units (decimal string). Addresses and hashes stay in this code and in memory. Every output is
checked for any 0x + 40-hex string.
"""
import argparse
import csv
import gzip
import io
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import l1_acquire_cash as L1  # noqa: E402

END_BLOCK = 26186746
# reserve -> (underlying, aToken, decimals, aToken deployment block from depositor-blind5/unit-counts.csv)
RESERVES = {
    "core_pyusd": ("0x6c3ea9036406852006290770bedfcaba0e23a0e8", "0x0c0d01abf3e6adfca0989ebba9d6e85dd58eab1e",
                   6, 19211968),
    "core_usds": ("0xdc035d45d973e3ec169d2276ddab16f1e407384f", "0x32a6268f9ba3642dda7892add74f1d34469a4259",
                  18, 20879386),
    "core_rlusd": ("0x8292bb45bf1ee4d140127049757c2e0ff06317ed", "0xfa82580c16a31d0c1bc632a36f82e83efef3eec0",
                   18, 22319334),
}
FIELDS = ["block", "ts", "tx_index", "log_index", "amount_raw"]
ADDR_RE = re.compile(r"0x[0-9a-fA-F]{40}")


def streams():
    out = {}
    for r, (asset, atok, _, dep) in RESERVES.items():
        out[f"{r}-in"] = ({"address": asset, "topics": [L1.T_TRANSFER, None, L1.pad(atok)]}, dep)
        out[f"{r}-out"] = ({"address": asset, "topics": [L1.T_TRANSFER, L1.pad(atok)]}, dep)
    return out


def slim(rows):
    """address-free rows: block, ts, tx_index, log_index, amount_raw (uint256 data word as a decimal string)."""
    out = []
    for r in rows:
        if r["topic0"] != L1.T_TRANSFER:
            raise SystemExit("STOP: non-Transfer log")
        out.append({"block": r["block"], "ts": r["ts"], "tx_index": r["tx_index"], "log_index": r["log_index"],
                    "amount_raw": str(int(r["data"][2:66], 16))})
    return out


def run_stream(client, name, spec, work, start, end):
    d = os.path.join(work, name)
    os.makedirs(d, exist_ok=True)
    lo = start
    while lo <= end:
        hi = min(lo + L1.RANGE_MAX - 1, end)
        p = os.path.join(d, f"{lo}-{hi}.json")
        if not os.path.exists(p):
            logs = L1.fetch(client, spec, lo, hi)
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


def guard(path):
    txt = gzip.open(path, "rt").read() if path.endswith(".gz") else open(path).read()
    if ADDR_RE.search(txt):
        raise SystemExit(f"STOP: address-like string in {path}")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--work", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--end-block", type=int, default=END_BLOCK)
    a = ap.parse_args(argv)
    t0 = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    client = L1.Client()
    os.makedirs(a.out, exist_ok=True)
    files, counts = {}, {}
    for name, (spec, dep) in streams().items():
        rows = slim(run_stream(client, name, spec, a.work, dep, a.end_block))
        p = os.path.join(a.out, f"raw-transfers-{name}.csv.gz")
        write_csv_gz(p, rows)
        guard(p)
        files[os.path.basename(p)] = (os.path.getsize(p), L1.sha256_file(p))
        counts[name] = len(rows)
        print(name, len(rows), file=sys.stderr, flush=True)
    t1 = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    here = os.path.dirname(os.path.abspath(__file__))
    head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=here, capture_output=True, text=True).stdout.strip()
    dirty = bool(subprocess.run(["git", "status", "--porcelain", "--", os.path.basename(__file__), "l1_acquire_cash.py"],
                                cwd=here, capture_output=True, text=True).stdout.strip())
    me = os.path.abspath(__file__)
    log = {"endpoint": L1.URL, "reserves": {r: {"decimals": v[2], "deploy_block": v[3]} for r, v in RESERVES.items()},
           "endBlock": a.end_block, "counts": counts, "client": client.counts, "fetchWindow": [t0, t1],
           "code": {"file": "scripts/research/history-forecasts/r104b_acquire_c2.py", "head": head,
                    "tree_dirty": dirty, "sha256": L1.sha256_file(me),
                    "l1_acquire_cash_sha256": L1.sha256_file(os.path.join(here, "l1_acquire_cash.py"))}}
    rl = os.path.join(a.out, "run-log.json")
    with open(rl, "w") as f:
        json.dump(log, f, indent=1, sort_keys=True)
    guard(rl)
    files["run-log.json"] = (os.path.getsize(rl), L1.sha256_file(rl))
    lines = [
        "# aave-pool-cash-c2 — provenance",
        "",
        "**LOCKED blind set C2** (membrane-board `design/q26-blind-set-inventory-2026-10-17.md`). The only",
        "preregistration that may score it is Q26 R10.4-B (`design/Q26_ROUND10_PREREG.md` D-R10.4-Ba; mapping",
        "`design/Q26_ROUND11_PREREG.md` D-R11.9a addendum). Score once. After the score it is grade C for the",
        "R10.4 daily-minimum cash target. A counts-only check does not spend it.",
        "",
        "Intraday pool cash streams for Aave V3 Ethereum Core PYUSD, USDS and RLUSD. The builder computes no",
        "cash path, minimum, forecast or score.",
        "",
        f"- **Source:** `eth_getLogs` on `{L1.URL}` (free, no key), the `l1_acquire_cash.py` client: ranges <=",
        f"  {L1.RANGE_MAX} blocks, split in half on any error or >= {L1.CAP} logs, <= 2 requests/s; `ts` = the",
        "  endpoint's `blockTimestamp`.",
        "- **Streams per reserve:** `<reserve>-in` = underlying Transfer with to = the reserve's aToken;",
        "  `<reserve>-out` = underlying Transfer with from = the aToken. Contract identities are in the builder",
        "  code (`RESERVES`) and in `depositor-blind5/candidates.csv`; no address is written here.",
        "- **Blocks:** each aToken's deployment block (as `depositor-blind5/unit-counts.csv`) .. "
        f"{a.end_block} (the depositor-blind5 asof) inclusive.",
        "- **Columns:** block, ts, tx_index, log_index, amount_raw (raw token units; PYUSD 6 decimals, USDS and",
        "  RLUSD 18). Address and hash columns are dropped.",
        f"- **Builder:** `The-Membrane/membrane-app` branch `research/history-forecasts`, "
        f"`scripts/research/history-forecasts/r104b_acquire_c2.py` (HEAD `{head}`, dirty {dirty}, sha256 "
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
    print(json.dumps({"counts": counts, "client": client.counts}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
