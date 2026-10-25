"""Q26 R30 Arbitrum log acquisition: r111v3_acquire.phase_logs with 100,000-block ranges on the Tenderly gateways.

The 1,000,000-block ranges of r111v3_acquire.py (market arb) split many times, and one endpoint in its rotation
(arb1.arbitrum.io) omits blockTimestamp, so the client reads one header per log block. This wrapper changes ONLY the
range size,
the endpoint list and the thread count. The filters, the compaction (compact_token, compact_pool) and the file format
are those of r111v3_acquire.py, unchanged. Ranges already held as 1,000,000-block parts (listed in DONE, one file name
per line) are skipped, so no block is fetched twice and parts never overlap.

  python3 r30_acquire.py logs --work ARB --done DONE [--threads 4]
  python3 r30_acquire.py phase meta|stable|bt|liq --work ARB      # unchanged phases, Tenderly log endpoints
"""
from __future__ import annotations

import argparse
import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import r111v3_acquire as A  # noqa: E402
import r111v3_rpc as X  # noqa: E402

SPAN = 100_000
OLD_SPAN = 1_000_000
# Tenderly public gateways only: they return blockTimestamp with each log. arb1.arbitrum.io omits it, and the client
# then reads one block header per log block (r111v3_rpc.fill_ts), which is far too slow at Arbitrum log volumes.
URLS = ["https://gateway.tenderly.co/public/arbitrum", "https://arbitrum.gateway.tenderly.co"]


def cmd_logs(a):
    m = A.MARKETS["arb"]
    rs = A.jload(os.path.join(a.work, "reserves.json.gz"))
    end = rs["end_block"]
    tok_map, res_idx = {}, {}
    for i, r in enumerate(rs["reserves"]):
        res_idx[r["asset"]] = i
        tok_map[r["aToken"]] = (i, 0)
        tok_map[r["vDebt"]] = (i, 1)
        if int(r["sDebt"], 16):
            tok_map[r["sDebt"]] = (i, 2)
    toks = sorted(tok_map)
    done_old = {int(x.strip().split(".")[0]) for x in open(a.done) if x.strip()}
    for s in done_old:
        assert (s - m["start"]) % OLD_SPAN == 0
    cl = X.Client("arbitrum", interval=0.2)
    cl.urls = list(URLS)
    T = A.T
    starts = []
    for s in range(m["start"], end + 1, SPAN):
        s_old = m["start"] + ((s - m["start"]) // OLD_SPAN) * OLD_SPAN
        if s_old in done_old:
            continue
        starts.append(s)
    for sub in ("tok", "pool"):
        os.makedirs(os.path.join(a.work, sub), exist_ok=True)
    lock = threading.Lock()
    done = [0]

    def one(s):
        e = min(s + SPAN - 1, end)
        pt = os.path.join(a.work, "tok", f"{s}.npz")
        if not os.path.exists(pt):
            lg = cl.logs(toks, [[T["Mint"], T["Burn"], T["BalanceTransfer"], T["SMint"], T["SBurn"]]], s, e)
            A.npsave(pt, **A.compact_token(lg, tok_map))
        pp = os.path.join(a.work, "pool", f"{s}.npz")
        if not os.path.exists(pp):
            lg = cl.logs(m["pool"], [[T["RDU"], T["CollOn"], T["CollOff"], T["EMode"]]], s, e)
            A.npsave(pp, **A.compact_pool(lg, res_idx))
        with lock:
            done[0] += 1
            if done[0] % 100 == 0:
                print(f"{A.utcnow()} logs {done[0]}/{len(starts)} rpc {cl.stats}", flush=True)

    print(f"{A.utcnow()} ranges to fetch {len(starts)} (skipped {len(done_old)} old 1M parts) to block {end}", flush=True)
    with ThreadPoolExecutor(a.threads) as ex:
        list(ex.map(one, starts))
    print(f"{A.utcnow()} logs done {len(starts)} ranges; rpc {cl.stats}", flush=True)


def cmd_phase(a):
    """Run one unchanged r111v3_acquire phase for market arb with the log endpoints set to the Tenderly gateways."""
    X.ENDPOINTS["arbitrum"] = list(URLS)
    {"meta": A.phase_meta, "stable": A.phase_stable, "bt": A.phase_bt, "liq": A.phase_liq}[a.name]("arb", a.work)


def main():
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest="cmd", required=True)
    ph = sp.add_parser("phase")
    ph.add_argument("name", choices=["meta", "stable", "bt", "liq"])
    ph.add_argument("--work", required=True)
    b = sp.add_parser("logs")
    b.add_argument("--work", required=True)
    b.add_argument("--done", required=True)
    b.add_argument("--threads", type=int, default=4)
    a = ap.parse_args()
    {"logs": cmd_logs, "phase": cmd_phase}[a.cmd](a)


if __name__ == "__main__":
    main()
