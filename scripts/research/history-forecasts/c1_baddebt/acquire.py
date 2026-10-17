"""C1 acquisition phases (free sources): logs, anchor snapshots, Uniswap v3 depth state.

  python3 -m c1_baddebt.acquire logs     --out DIR
  python3 -m c1_baddebt.acquire anchor   --out DIR --name NAME --ts UNIX
  python3 -m c1_baddebt.acquire endstate --out DIR --name NAME --ts UNIX   (validation window end)

Outputs are gzip JSON/CSV under DIR with a sha256 manifest written by `publish`.
"""
from __future__ import annotations

import argparse
import csv
import gzip
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
from c1_baddebt import chain as C  # noqa: E402

POOL_DEPLOY_BLOCK = 16_291_127
DATASETS = os.environ.get("MEMBRANE_DATASETS_DIR", os.path.join(HERE, "..", "..", "..", "..", "..", "membrane-datasets"))
BORROW_FILES = ["aave-pool-debt/borrow-events-core-pre-2023.csv.gz"] + [
    f"aave-pool-borrows/borrow-events-core-{y}.csv.gz" for y in (2023, 2024, 2025, 2026)]
BORROW_FILES_END = 26_186_746   # last block covered by the committed Borrow files

UNI_POOLS = {   # (pool, base asset sold, quote received) -- verified via the v3 factory getPool
    "WETH-USDC-100": "0xe0554a476a092703abdb3ef35c80e0d76d32939f",
    "WETH-USDC-500": "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
    "WETH-USDC-3000": "0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8",
    "wstETH-WETH-100": "0x109830a1aaad605bbf02a9dfa7b0b92ec2fb7daa",
    "wstETH-WETH-500": "0xd340b57aacdd10f96fc1cf10e15921936f41e29c",
    "weETH-WETH-100": "0x202a6012894ae5c288ea824cbc8a9bfb26a49b93",
    "weETH-WETH-500": "0x7a415b19932c0105c82fdb6b720bb01b0cc2cae3",
    "rsETH-WETH-100": "0x48f95b6cc63c8a067588d6a925c556f6e84eb2e2",
    "rsETH-WETH-500": "0x059615ebf32c946aaab3d44491f78e4f8e97e1d3",
}


def jdump(path: str, obj) -> None:
    with gzip.open(path, "wt") as f:
        json.dump(obj, f, sort_keys=True)


def jload(path: str):
    with gzip.open(path, "rt") as f:
        return json.load(f)


def head_block(rpc) -> int:
    return int(rpc.call("eth_blockNumber", [], "head"), 16)


def phase_logs(out: str, to_block: int | None = None) -> None:
    rpc = C.make_rpc()
    hi = to_block or head_block(rpc)
    usdc_t = C.addr_topic(C.USDC)
    res = {}
    print(f"LiquidationCall (debt = USDC) {POOL_DEPLOY_BLOCK}..{hi}", flush=True)
    liq = C.get_logs(C.POOL, [C.topic0("LiquidationCall"), None, usdc_t], POOL_DEPLOY_BLOCK, hi, step=200_000)
    res["liquidations"] = [C.decode_liquidation(lg) for lg in liq]
    print(f"  {len(liq)}; DeficitCreated (any debt asset)", flush=True)
    dfc = C.get_logs(C.POOL, [C.topic0("DeficitCreated")], 21_000_000, hi, step=200_000)
    res["deficits"] = [C.decode_deficit(lg) for lg in dfc]
    print(f"  {len(dfc)}; Borrow (reserve = USDC) {BORROW_FILES_END + 1}..{hi}", flush=True)
    bor = C.get_logs(C.POOL, [C.topic0("Borrow"), usdc_t], BORROW_FILES_END + 1, hi, step=20_000)
    res["borrows_tail"] = [C.decode_borrow(lg) for lg in bor]
    res["meta"] = {"to_block": hi, "from_block": POOL_DEPLOY_BLOCK, "liq_topic0": C.topic0("LiquidationCall"),
                   "deficit_topic0": C.topic0("DeficitCreated"), "borrow_topic0": C.topic0("Borrow"),
                   "source": C.LOGS_URL, "fetched_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    jdump(os.path.join(out, "logs.json.gz"), res)
    print(f"  {len(bor)} borrows; done", flush=True)


def usdc_borrowers_before(block: int, out: str) -> list[str]:
    """Every onBehalfOf of a Core USDC Borrow at or before `block` (committed files + acquired tail)."""
    users = set()
    for rel in BORROW_FILES:
        with gzip.open(os.path.join(DATASETS, rel), "rt") as f:
            for row in csv.DictReader(f):
                if row["reserve"].lower() == C.USDC and int(row["block"]) <= block:
                    users.add(row["onBehalfOf"].lower())
    if block > BORROW_FILES_END:
        for b in jload(os.path.join(out, "logs.json.gz"))["borrows_tail"]:
            if b["block"] <= block:
                users.add(b["onBehalfOf"])
    return sorted(users)


def snapshot(rpc, block: int, users: list[str]) -> dict:
    meta = C.reserve_meta(rpc, block)
    debt = C.usdc_debt_scan(rpc, block, meta["USDC"]["vDebt"], users)
    with_debt = sorted(debt)
    print(f"  block {block}: {len(users)} USDC borrowers ever, {len(with_debt)} with USDC debt", flush=True)
    accts = C.read_accounts(rpc, block, meta, with_debt)
    cats = sorted({a["emode"] for a in accts.values() if a["emode"]})
    emode = C.emode_meta(rpc, block, cats)
    ts = rpc.block_ts(block)
    return {"block": block, "ts": ts, "reserves": meta, "emode": {str(k): v for k, v in emode.items()},
            "accounts": accts, "n_borrowers_ever": len(users)}


def phase_anchor(out: str, name: str, ts: int, with_depth: bool = True) -> None:
    rpc = C.make_rpc()
    hb = head_block(rpc)
    block = C.block_at(rpc, ts, hb)
    users = usdc_borrowers_before(block, out)
    snap = snapshot(rpc, block, users)
    snap["name"] = name
    snap["anchor_ts"] = ts
    path = os.path.join(out, f"anchor-{name}.json.gz")
    jdump(path, snap)
    if with_depth:
        phase_depth(out, name, rpc)
    print(f"anchor {name}: block {block}, {len(snap['accounts'])} accounts read", flush=True)


def phase_depth(out: str, name: str, rpc=None) -> None:
    rpc = rpc or C.make_rpc()
    path = os.path.join(out, f"anchor-{name}.json.gz")
    snap = jload(path)
    uni = {k: C.uni_pool_state(rpc, snap["block"], p) for k, p in UNI_POOLS.items()}
    snap["uni"] = {k: v for k, v in uni.items() if v is not None}
    snap["uni_missing"] = sorted(k for k, v in uni.items() if v is None)
    jdump(path, snap)


def phase_endstate(out: str, name: str, ts: int) -> None:
    """Window-end state of the anchor's subject users (open underwater debt at the end)."""
    rpc = C.make_rpc()
    anc = jload(os.path.join(out, f"anchor-{name}.json.gz"))
    hb = head_block(rpc)
    block = C.block_at(rpc, ts, hb)
    users = sorted(anc["accounts"])
    meta = C.reserve_meta(rpc, block)
    accts = C.read_accounts(rpc, block, meta, users)
    jdump(os.path.join(out, f"end-{name}.json.gz"), {"block": block, "ts": rpc.block_ts(block), "reserves": meta,
                                                       "accounts": accts})
    print(f"end {name}: block {block}", flush=True)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("phase", choices=["logs", "anchor", "endstate", "depth"])
    ap.add_argument("--out", required=True)
    ap.add_argument("--name")
    ap.add_argument("--ts", type=int)
    ap.add_argument("--to-block", type=int)
    a = ap.parse_args(argv)
    os.makedirs(a.out, exist_ok=True)
    if a.phase == "logs":
        phase_logs(a.out, a.to_block)
    elif a.phase == "anchor":
        phase_anchor(a.out, a.name, a.ts)
    elif a.phase == "depth":
        phase_depth(a.out, a.name)
    else:
        phase_endstate(a.out, a.name, a.ts)


if __name__ == "__main__":
    main()
