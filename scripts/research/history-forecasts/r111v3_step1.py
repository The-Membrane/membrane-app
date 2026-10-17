"""Q26 R11.1-v3 step 1 (membrane-board design/Q26_ROUND11_PREREG.md D-R11.1e): is C-other a same-block oracle update?

Development period D only (2023-02-01..2024-12-31, Aave V3 Ethereum Core). The frozen R11.1a cause tree
(r111_replay.py, membrane-app b9cf923c / 4a0686c6, unchanged) is re-executed in memory to list the C-other events.
For each C-other block one eth_getLogs call returns every Chainlink AnswerUpdated in that block. An event is
"explained" when an aggregator behind one of the account's held reserves (AaveOracle source at block - 1, followed
through aggregator() and the adapter getters) updated in the same block before the liquidation log.

  python3 r111v3_step1.py --work R10WORK --diag DIAG --scratch DIR --out OUT

Writes only counts and shares to OUT (no address). The per-event list stays in --scratch.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import r10_acquire as A  # noqa: E402
import r111_replay as R  # noqa: E402
import r111v3_rpc as X  # noqa: E402

ANSWER_UPDATED = X.topic("AnswerUpdated(int256,uint256,uint256)")
ADDR_RE = re.compile(r"0x[0-9a-fA-F]{40}")
ADAPTER_GETTERS = ["BASE_TO_USD_AGGREGATOR()", "ASSET_TO_USD_AGGREGATOR()", "ASSET_TO_PEG()", "PEG_TO_BASE()",
                   "BASE_TO_PEG()", "ASSET_TO_BASE_AGGREGATOR()", "RATIO_PROVIDER()", "STETH_TO_USD_AGGREGATOR()"]


def c_other_events(work, diag):
    world = R.World(work)
    eng = R.Engine(world, rule=None, record=True)
    evs = R.real_events(world, {})
    ids = A.jload(os.path.join(work, "positions-state.json.gz"))["ids"]
    dg = R.Diagnoser(world, diag, eng, evs, ids, R.load_borrowers(world))
    eng.run(until=R.D_LAST.isoformat(), hook=dg.hook)
    # log_index per (tx, user) from the C1 logs
    logs = A.jload(os.path.join(A.DATASETS, R.M.C1_LOGS))["liquidations"]
    li = {(lg["tx"], lg["user"].lower(), lg["block"]): lg["log_index"] for lg in logs}
    out = []
    for r in dg.rows:
        if r.get("missed") and r["cause"] == "C-other":
            rec = dg.recs[r["block"]]
            acc = rec["accounts"][r["user"]]
            out.append({"block": r["block"], "tx": r["tx"], "user": r["user"], "usd": r["usd"],
                        "log_index": li[(r["tx"], r["user"], r["block"])], "hf_b1": int(acc["hf"]) / 1e18,
                        "reserves": sorted(acc["bal"])})
    return out, len(dg.rows)


def aggregators_for(cl, block, assets):
    """asset -> set of aggregator addresses behind its AaveOracle source at `block` (lowercase)."""
    calls = [(A.ORACLE, X.sel("getSourceOfAsset(address)") + X.enc_addr(a)) for a in assets]
    srcs = [X.as_addr(X.word(r)) if ok else None for ok, r in X.aggregate3(cl, calls, block)]
    res = {a: set() for a in assets}
    frontier = [(a, s) for a, s in zip(assets, srcs) if s]
    seen = set()
    for _ in range(3):
        if not frontier:
            break
        calls, meta = [], []
        for a, s in frontier:
            if (a, s) in seen:
                continue
            seen.add((a, s))
            calls.append((s, X.sel("aggregator()")))
            meta.append((a, s, "agg"))
            for g in ADAPTER_GETTERS:
                calls.append((s, X.sel(g)))
                meta.append((a, s, g))
        if not calls:
            break
        out = X.aggregate3(cl, calls, block)
        nxt = []
        for (a, s, kind), (ok, r) in zip(meta, out):
            if not ok or len(r) != 32:
                continue
            v = X.as_addr(X.word(r))
            if v is None or int(v, 16) == 0:
                continue
            if kind == "agg":
                res[a].add(v.lower())
            else:
                nxt.append((a, v))
        frontier = nxt
    # a source with no aggregator() may itself be the aggregator
    for a, s in zip(assets, srcs):
        if s and not res[a]:
            res[a].add(s.lower())
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", required=True)
    ap.add_argument("--diag", required=True)
    ap.add_argument("--scratch", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    t0 = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    os.makedirs(a.scratch, exist_ok=True)
    os.makedirs(a.out, exist_ok=True)
    evs, n_rows = c_other_events(a.work, a.diag)
    cl = X.Client("ethereum", interval=0.15, calls=True)
    lg_cl = X.Client("ethereum", interval=0.15)
    blocks = sorted({e["block"] for e in evs})
    upd = {}
    for b in blocks:
        res = lg_cl.logs(None, [ANSWER_UPDATED], b, b)
        upd[b] = [(x["address"].lower(), int(x["logIndex"], 16), x["transactionHash"]) for x in res]
    aggs = {}
    for b in blocks:
        assets = sorted({r for e in evs if e["block"] == b for r in e["reserves"]})
        aggs[b] = aggregators_for(cl, b - 1, assets)
    n_expl = n_any_before = n_any_block = 0
    usd_expl = usd_all = 0.0
    n_same_tx = 0
    per = []
    for e in evs:
        held = set().union(*(aggs[e["block"]].get(r, set()) for r in e["reserves"]))
        before = [u for u in upd[e["block"]] if u[1] < e["log_index"]]
        expl = any(u[0] in held for u in before)
        same_tx = any(u[2] == e["tx"] for u in before if u[0] in held)
        n_expl += expl
        n_same_tx += same_tx
        n_any_before += bool(before)
        n_any_block += bool(upd[e["block"]])
        usd_all += e["usd"]
        usd_expl += e["usd"] if expl else 0.0
        per.append({**e, "explained": expl, "same_tx": same_tx, "n_updates_before": len(before),
                    "held_aggregators": sorted(held)})
    with open(os.path.join(a.scratch, "step1-events.json"), "w") as f:
        json.dump(per, f, indent=1, default=float)
    res = {"period": "D 2023-02-01..2024-12-31 (Aave V3 Ethereum Core, USDC debt)",
           "c_other_events": len(evs), "c_other_blocks": len(blocks), "c_other_usd": usd_all,
           "c_other_chain_hf_ge_1_at_block_minus_1": sum(e["hf_b1"] >= 1 for e in evs),
           "explained_events": n_expl, "explained_share_events": n_expl / max(len(evs), 1),
           "explained_usd": usd_expl, "explained_share_usd": usd_expl / max(usd_all, 1e-9),
           "explained_update_in_same_tx": n_same_tx,
           "any_answerupdated_before_in_block": n_any_before, "any_answerupdated_in_block": n_any_block,
           "rule": "explained = an AnswerUpdated log in the liquidation block, before the liquidation log, from an "
                   "aggregator behind a reserve the account held at block-1 (AaveOracle.getSourceOfAsset at block-1, "
                   "then aggregator() and adapter getters, up to 3 hops)",
           "diag_rows": n_rows, "rpc": {"logs": lg_cl.stats, "calls": cl.stats}, "utc_start": t0,
           "utc_end": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    txt = json.dumps(res, indent=1, default=float)
    assert not ADDR_RE.search(txt)
    with open(os.path.join(a.out, "step1-same-block.json"), "w") as f:
        f.write(txt)
    print(txt)


if __name__ == "__main__":
    main()
