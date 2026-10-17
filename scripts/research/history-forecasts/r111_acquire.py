"""Q26 R11.1 extra diagnostic reads (membrane-board design/Q26_ROUND11_PREREG.md R11.1a). Inputs only: no
classification, count or score is computed here.

  python3 r111_acquire.py diag    --work R10WORK --out DIR   block-1 account reads for every real USDC-debt
                                                              LiquidationCall in the development period D
  python3 r111_acquire.py feehist --work R10WORK --out DIR   per-hour mean base fee from eth_feeHistory (only if the
                                                              C-gas fix is selected)

Free keyless sources only (the R10.1 endpoints). Addresses stay inside --out (never published).
"""
from __future__ import annotations

import argparse
import datetime as dt
import gzip
import json
import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import r10_acquire as A  # noqa: E402
import b_acquire as B  # noqa: E402

D_FIRST = dt.date(2023, 2, 1)
D_LAST = dt.date(2024, 12, 31)
C1_LOGS = "history-forecasts/c1/run-e79f9341/logs.json.gz"


def real_events_in(work, first, last):
    """Real USDC-debt LiquidationCall logs whose block lies in the anchors of (first, last + 1 day]."""
    anchors = A.jload(os.path.join(work, "anchors.json.gz"))
    lo = anchors[first.isoformat()]
    hi = anchors[(last + dt.timedelta(days=1)).isoformat()]
    logs = A.jload(os.path.join(A.DATASETS, C1_LOGS))["liquidations"]
    return [lg for lg in logs if lg["debt"].lower() == A.USDC and lo < lg["block"] <= hi]


def phase_diag(work, out):
    pool = A.Pool()
    metas = A.load_meta(work)
    days = sorted(metas)
    anchors = [metas[d]["block"] for d in days]
    import bisect
    evs = real_events_in(work, D_FIRST, D_LAST)
    os.makedirs(os.path.join(out, "diag-blocks"), exist_ok=True)
    by_block = {}
    for lg in evs:
        by_block.setdefault(lg["block"], set()).add(lg["user"].lower())

    def meta_for(b):
        i = bisect.bisect_left(anchors, b)        # block in (anchor[i-1], anchor[i]] belongs to day i-1's replay
        return metas[days[i - 1]]

    def one(b):
        path = os.path.join(out, "diag-blocks", f"{b}.json.gz")
        if os.path.exists(path):
            return
        m = meta_for(b)
        users = sorted(by_block[b])
        acc = A.read_accounts(pool, b - 1, m, users)
        calls = []
        for a in m["assets"]:
            calls += [(A.ORACLE, A.cd("getAssetPrice", a)), (A.POOL, A.cd("getReserveNormalizedIncome", a)),
                      (A.POOL, A.cd("getReserveNormalizedVariableDebt", a))]
        res = pool.multicall(calls, b - 1, "diagpx")
        px = [A.u(res[3 * j]) for j in range(len(m["assets"]))]
        inc = [str(A.u(res[3 * j + 1])) for j in range(len(m["assets"]))]
        vix = [str(A.u(res[3 * j + 2])) for j in range(len(m["assets"]))]
        blk = pool.pick().block_obj(b, "diagblk")
        A.jdump(path, {"block": b, "ts": int(blk["timestamp"], 16),
                       "base_fee": int(blk.get("baseFeePerGas") or "0x0", 16),
                       "assets": m["assets"], "prices": px, "income": inc, "vindex": vix, "accounts": acc})

    with ThreadPoolExecutor(6) as ex:
        list(ex.map(one, sorted(by_block)))
    # receipts (gasUsed, effectiveGasPrice) per transaction
    rpath = os.path.join(out, "diag-receipts.json.gz")
    rec = A.jload(rpath) if os.path.exists(rpath) else {}
    lock = threading.Lock()
    txs = sorted({lg["tx"] for lg in evs} - set(rec))

    def rc(tx):
        def v(res):
            if not isinstance(res, dict) or "gasUsed" not in res:
                raise B.DecodeError("bad receipt")
        r = pool.pick().call("eth_getTransactionReceipt", [tx], "receipt", tag=tx[:10], validate=v)
        with lock:
            rec[tx] = {"gasUsed": int(r["gasUsed"], 16), "effectiveGasPrice": int(r.get("effectiveGasPrice") or "0x0", 16),
                       "block": int(r["blockNumber"], 16)}

    with ThreadPoolExecutor(6) as ex:
        list(ex.map(rc, txs))
    A.jdump(rpath, rec)
    print(f"diag: {len(evs)} events, {len(by_block)} blocks, {len(rec)} receipts; rpc {pool.counts()}", flush=True)


def phase_feehist(work, out):
    """Mean base fee per UTC hour over the replay span, from eth_feeHistory (1024 blocks per call) and the held
    block -> ts map of the RDU file (hour of a block = hour of the nearest RDU block at or before it)."""
    pool = A.Pool()
    path = os.path.join(out, "feehist-parts")
    os.makedirs(path, exist_ok=True)
    anchors = A.jload(os.path.join(work, "anchors.json.gz"))
    lo, hi = min(anchors.values()), max(anchors.values())
    step = 1024
    starts = list(range(lo, hi + 1, step))

    def one(s):
        p = os.path.join(path, f"{s}.json.gz")
        if os.path.exists(p):
            return
        n = min(step, hi - s + 1)
        newest = s + n - 1

        def v(res):
            if not isinstance(res, dict) or len(res.get("baseFeePerGas", [])) < n:
                raise B.DecodeError("bad feeHistory")
        r = pool.pick().call("eth_feeHistory", [hex(n), hex(newest), []], "feehist", tag=str(s), validate=v)
        if int(r["oldestBlock"], 16) != s:
            raise RuntimeError(f"feeHistory oldest {r['oldestBlock']} != {s}")
        A.jdump(p, {"start": s, "base": [int(x, 16) for x in r["baseFeePerGas"][:n]]})

    with ThreadPoolExecutor(6) as ex:
        list(ex.map(one, starts))
    print(f"feehist: {len(starts)} calls; rpc {pool.counts()}", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("phase", choices=["diag", "feehist"])
    ap.add_argument("--work", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    {"diag": phase_diag, "feehist": phase_feehist}[a.phase](a.work, a.out)


if __name__ == "__main__":
    main()
