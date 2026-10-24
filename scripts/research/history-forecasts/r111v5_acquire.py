"""Q26 R11.1-v5 extra inputs (membrane-board design/Q26_ROUND11_PREREG.md D-R11.1q).

F2 fix input: reserve and e-mode configuration by block, not only at the 00:00Z anchor.

  python3 r111v5_acquire.py conf --mk MK --work WORK
      All PoolConfigurator logs (keyless log endpoints) from the Pool deployment to the input end block. Written to
      WORK/conf-events.json.gz as (block, log index, timestamp, topic0). No account data.

  python3 r111v5_acquire.py confmeta --mk MK --work WORK
      For every block that holds a PoolConfigurator log, the same reserve / e-mode read as a daily anchor meta
      (r111v3_acquire.phase_meta) at the END of that block. Written to WORK/meta-conf/<block>.json.gz. The engine
      switches to this configuration from the first stream key after the block (r111v3_engine EV_CONF).

Every timestamp comes from the log (blockTimestamp) or from the block header; a missing or non-positive one is
refused (D-R11.1k rule).
"""
from __future__ import annotations

import argparse
import os
import sys
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import r111v3_acquire as A  # noqa: E402
import r111v3_rpc as X  # noqa: E402

CONFIGURATOR = {"polygon": "0x8145edddf43f50276641b55bd3ad95944510021e",
                "avalanche": "0x8145edddf43f50276641b55bd3ad95944510021e",
                "arbitrum": "0x8145edddf43f50276641b55bd3ad95944510021e",
                "optimism": "0x8145edddf43f50276641b55bd3ad95944510021e"}


def phase_conf(mk, work):
    m = A.MARKETS[mk]
    rs = A.jload(os.path.join(work, "reserves.json.gz"))
    end = rs["end_block"]
    cl = X.Client(m["chain"], interval=0.1)
    conf = m.get("configurator") or CONFIGURATOR[m["chain"]]
    span = m["span"]
    starts = list(range(m["start"], end + 1, span))
    parts = os.path.join(work, "conf-parts")
    os.makedirs(parts, exist_ok=True)

    def one(s):
        p = os.path.join(parts, f"{s}.json.gz")
        if os.path.exists(p):
            return
        lg = cl.logs(conf, [], s, min(s + span - 1, end))
        rows = []
        for x in lg:
            ts = int(x["blockTimestamp"], 16)
            if ts <= 0:
                raise SystemExit("configurator log without a timestamp")
            rows.append({"block": int(x["blockNumber"], 16), "lidx": int(x["logIndex"], 16), "ts": ts,
                         "topic0": x["topics"][0] if x["topics"] else None,
                         "topic1": x["topics"][1] if len(x["topics"]) > 1 else None})
        A.jdump(p, rows)

    with ThreadPoolExecutor(4) as ex:
        list(ex.map(one, starts))
    rows = []
    for s in starts:
        rows += A.jload(os.path.join(parts, f"{s}.json.gz"))
    rows.sort(key=lambda r: (r["block"], r["lidx"]))
    A.jdump(os.path.join(work, "conf-events.json.gz"), {"configurator": conf, "end_block": end, "rows": rows})
    print(f"conf: {len(rows)} configurator logs in {len({r['block'] for r in rows})} blocks; rpc {cl.stats}", flush=True)


def meta_at(m, cl, tokens, blk, date=None):
    """The r111v3_acquire.phase_meta read at the end of block blk."""
    lst = X.aggregate3(cl, [(m["pool"], X.sel("getReservesList()"))], blk)[0][1]
    n = X.word(lst, 1)
    assets = [X.as_addr(X.word(lst, 2 + i)) for i in range(n)]
    calls = []
    for a in assets:
        calls += [(m["pool"], X.sel("getReserveData(address)") + X.enc_addr(a)),
                  (m["oracle"], X.sel("getAssetPrice(address)") + X.enc_addr(a)),
                  (m["pool"], X.sel("getReserveNormalizedIncome(address)") + X.enc_addr(a)),
                  (m["pool"], X.sel("getReserveNormalizedVariableDebt(address)") + X.enc_addr(a))]
    calls.append((m["pool"], X.sel("getReserveDeficit(address)") + X.enc_addr(m["usdc"][0])))
    res = X.aggregate3(cl, calls, blk)
    R = {}
    for j, a in enumerate(assets):
        rd = res[4 * j][1]
        R[a] = {"id": X.word(rd, 7), "config": str(X.word(rd, 0)), "price": X.word(res[4 * j + 1][1]),
                "income": str(X.word(res[4 * j + 2][1])), "vindex": str(X.word(res[4 * j + 3][1])),
                "aToken": X.as_addr(X.word(rd, 8)), "vDebt": X.as_addr(X.word(rd, 10)),
                "sDebt": X.as_addr(X.word(rd, 9)), "sDebtTotal": "0"}
    q = 4 * n
    v33 = bool(res[q][0] and len(res[q][1]) == 32)
    ts = cl.header_ts(blk)
    return {"date": date, "block": blk, "ts": ts, "assets": assets, "reserves": R, "v33": v33,
            "emode": A.emode_read(cl, m["pool"], blk)}


def phase_confmeta(mk, work):
    m = A.MARKETS[mk]
    ev = A.jload(os.path.join(work, "conf-events.json.gz"))
    rs = A.jload(os.path.join(work, "reserves.json.gz"))
    tokens = {r["asset"]: r for r in rs["reserves"]}
    cl = X.Client(m["chain"], interval=0.1, calls=True)
    md = os.path.join(work, "meta-conf")
    os.makedirs(md, exist_ok=True)
    blocks = sorted({r["block"] for r in ev["rows"]})
    # a configurator log before the Pool's first reserve has no reserve list yet; the read still succeeds (n = 0)

    def one(b):
        p = os.path.join(md, f"{b}.json.gz")
        if os.path.exists(p):
            return
        A.jdump(p, meta_at(m, cl, tokens, b))

    with ThreadPoolExecutor(4) as ex:
        list(ex.map(one, blocks))
    print(f"confmeta: {len(blocks)} blocks; rpc {cl.stats}", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd")
    ap.add_argument("--mk", required=True)
    ap.add_argument("--work", required=True)
    a = ap.parse_args()
    {"conf": phase_conf, "confmeta": phase_confmeta}[a.cmd](a.mk, a.work)


if __name__ == "__main__":
    main()
