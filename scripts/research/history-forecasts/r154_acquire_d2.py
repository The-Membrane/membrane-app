#!/usr/bin/env python3
"""Q26 R15.4b: outcome-blind D2 builder and counts-only check (Aave V3 L2 USDC per-deposit panels).

Registered set: membrane-board `design/q26-blind-set-inventory-2026-10-17.md` section 2 row D2 and section 19.
Item: `design/Q26_ROUND15_PREREG.md` D-R15.4b (fields of the counts-only check fixed there).

What it computes: decoded aToken Mint / Burn / BalanceTransfer logs of the 8 D2 USDC reserves, the block at every
00:00Z day boundary (headers through q26cache.BlockTimestamps: never 0), daily balances = scaled balance x the last
liquidity index logged before the boundary, holder codes at the cutoff, and from those ONLY the registered counts:
per reserve first / last counted day, >= $1M units, big-wallet units and unit-days; pooled big-wallet units U,
30-day blocks B and occupied (unit, block) cells C. It computes no exit, label, balance change, rate or positive count.

Sources: eth_getLogs on keyless endpoints only (Tenderly public gateways, mainnet.optimism.io, arb1.arbitrum.io);
state reads (headers, eth_getCode, eth_call) on the Q26_*_RPC_URL provider from the environment first (never printed),
keyless fallback. Raw data with addresses stay in --work (scratch). Only counts-d2.json is published.

Phases: resolve, bounds, logs, counts (in order; logs is resumable per reserve).
"""
import argparse
import bisect
import concurrent.futures as cf
import gzip
import json
import os
import re
import sys
import threading
import time
from datetime import datetime, timezone, timedelta

import numpy as np
import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import q26cache as QC  # noqa: E402
import g_acquire_events as GE  # noqa: E402

D2_START = "2022-03-01"            # block anchor of the 30-day grid (first V3 L2 listing month)
COUNT_END_1 = "2026-03-24"         # last counted origin before 2026Q2 (7 d windows end by 2026-03-31)
COUNT_START_2, COUNT_END_2 = "2026-07-01", "2026-09-23"
LAST_BOUNDARY = "2026-09-24"       # balances needed through the 2026-09-23 00:00Z origin; logs scanned to here
ARB_FIRST = "2022-09-01"           # keyless state on Arbitrum starts at Nitro (inventory section 5)
MIN_BAL = 1_000_000 * 10 ** 6
C_MIN, W_MIN = 10_000_000 * 10 ** 6, 50_000_000 * 10 ** 6
POOL_L2 = "0x794a61358d6845594f94dc1db02a252b5b4814ad"
POOL_BASE = "0xa238dd80c259a72e81d7e4664a9801593f98d1c5"
RESERVES = {
    "ARB_USDCe": ("arbitrum", POOL_L2, "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8"),
    "ARB_USDCn": ("arbitrum", POOL_L2, "0xaf88d065e77c8cc2239327c5edb3a432268e5831"),
    "OP_USDCe": ("optimism", POOL_L2, "0x7f5c764cbc14f9669b88837ca1490cca17c31607"),
    "OP_USDCn": ("optimism", POOL_L2, "0x0b2c639c533813f4aa9d7837caf62653d097ff85"),
    "POL_USDCe": ("polygon", POOL_L2, "0x2791bca1f2de4661ed88a30c99a7a9449aa84174"),
    "POL_USDCn": ("polygon", POOL_L2, "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359"),
    "AVA_USDC": ("avalanche", POOL_L2, "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e"),
    "BASE_USDC": ("base", POOL_BASE, "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"),
}
LOG_URLS = {
    "arbitrum": ["https://arbitrum.gateway.tenderly.co", "https://arb1.arbitrum.io/rpc"],
    "optimism": ["https://mainnet.optimism.io", "https://optimism.gateway.tenderly.co"],
    "polygon": ["https://polygon.gateway.tenderly.co"],
    "avalanche": ["https://avalanche.gateway.tenderly.co"],
    "base": ["https://base.gateway.tenderly.co"],
}
KEYLESS_STATE = {
    "arbitrum": ["https://arbitrum.gateway.tenderly.co"], "optimism": ["https://mainnet.optimism.io"],
    "polygon": ["https://polygon.gateway.tenderly.co"], "avalanche": ["https://avalanche.gateway.tenderly.co"],
    "base": ["https://base.gateway.tenderly.co"]}
SPAN = {"arbitrum": (2_000_000, 50_000_000), "optimism": (1_000_000, 20_000_000), "polygon": (100_000, 2_000_000),
        "avalanche": (50_000, 2_000_000), "base": (1_000, 1_000)}
THREADS = {"arbitrum": 2, "optimism": 2, "polygon": 3, "avalanche": 3, "base": 8}
TOPICS = sorted(t for t, k in GE.TYPE_OF_TOPIC.items() if k in ("Mint", "Burn", "BalanceTransfer"))
SEL = {"getReserveData": "35ea6a75", "UNDERLYING": "b16a19de", "totalSupply": "18160ddd"}
RANGE_ERR = re.compile(r"more than|exceed|too large|range|limit of|too many", re.I)


def utcnow():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def day_ts(s):
    return int(datetime.strptime(s, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp())


def days_between(a, b):
    d0 = datetime.strptime(a, "%Y-%m-%d")
    n = (datetime.strptime(b, "%Y-%m-%d") - d0).days
    return [(d0 + timedelta(days=i)).strftime("%Y-%m-%d") for i in range(n + 1)]


class Rpc:
    def __init__(self, urls, rps=6.0):
        self.urls = list(urls)
        self.s = requests.Session()
        self.s.headers.update({"content-type": "application/json", "user-agent": "curl/8.5.0"})
        self.min_dt = 1.0 / rps
        self.lock = threading.Lock()
        self.last = 0.0
        self.n = 0

    def post(self, url, payload, timeout=90):
        with self.lock:
            dt = time.time() - self.last
            if dt < self.min_dt:
                time.sleep(self.min_dt - dt)
            self.last = time.time()
            self.n += 1
        r = self.s.post(url, data=json.dumps(payload), timeout=timeout)
        if r.status_code == 429:
            raise RuntimeError("http 429")
        r.raise_for_status()
        return r.json()

    def call(self, method, params, tries=8):
        err = None
        for k in range(tries):
            url = self.urls[k % len(self.urls)]
            try:
                out = self.post(url, {"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
                if "error" in out:
                    raise RuntimeError(str(out["error"])[:300])
                return out["result"]
            except Exception as e:  # noqa: BLE001
                err = e
                time.sleep(min(30, 1.5 ** k))
        raise RuntimeError(f"{method} failed: {QC.redact(str(err))[:300]}")

    def batch(self, calls, tries=14):
        payload = [{"jsonrpc": "2.0", "id": i, "method": m, "params": p} for i, (m, p) in enumerate(calls)]
        err = None
        for k in range(tries):
            url = self.urls[k % len(self.urls)]
            try:
                out = self.post(url, payload)
                if isinstance(out, dict):
                    raise RuntimeError(str(out)[:200])
                by = {o["id"]: o for o in out}
                res = []
                for i in range(len(calls)):
                    o = by.get(i)
                    if o is None or "error" in o:
                        raise RuntimeError(f"call {i}: {str(o)[:200]}")
                    res.append(o["result"])
                return res
            except Exception as e:  # noqa: BLE001
                err = e
                time.sleep(min(60, 2 ** k))
        raise RuntimeError(f"batch failed: {QC.redact(str(err))[:300]}")


def state_rpc(chain):
    return Rpc(QC.rpc_endpoints(chain, KEYLESS_STATE[chain], kind="state"), rps=3.0)


def word(h, i):
    return int(h[2 + 64 * i: 2 + 64 * (i + 1)], 16)


# ---------------------------------------------------------------------------------------------
def phase_resolve(work, log):
    p = os.path.join(work, "reserves.json")
    if os.path.exists(p):
        return json.load(open(p))
    out = {}
    for name, (chain, pool, asset) in RESERVES.items():
        r = state_rpc(chain)
        head = int(r.call("eth_blockNumber", []), 16)
        rd = r.call("eth_call", [{"to": pool, "data": "0x" + SEL["getReserveData"] + asset[2:].rjust(64, "0")},
                                 hex(head - 100)])
        atoken = "0x" + hex(word(rd, 8))[2:].rjust(40, "0")
        und = r.call("eth_call", [{"to": atoken, "data": "0x" + SEL["UNDERLYING"]}, hex(head - 100)])
        und = "0x" + und[-40:]
        if und.lower() != asset:
            raise SystemExit(f"STOP: {name}: aToken underlying differs")
        # deployment block: binary search on eth_getCode (archive state on the provider)
        lo, hi = 1, head - 100
        while lo < hi:
            mid = (lo + hi) // 2
            code = r.call("eth_getCode", [atoken, hex(mid)])
            if code and code != "0x":
                hi = mid
            else:
                lo = mid + 1
        out[name] = {"chain": chain, "pool": pool, "asset": asset, "atoken": atoken, "deploy_block": lo}
        log(f"{name}: aToken resolved, deploy block {lo}")
    json.dump(out, open(p, "w"), indent=1)
    return out


def boundary_blocks(chain, days, work, log):
    """Block at each 00:00Z boundary = first block with timestamp >= day start (headers via BlockTimestamps)."""
    p = os.path.join(work, f"bounds-{chain}.json")
    if os.path.exists(p):
        return json.load(open(p))
    r = state_rpc(chain)
    bts = QC.BlockTimestamps()
    head = int(r.call("eth_blockNumber", []), 16) - 100

    def ts_of(blocks):
        need = [b for b in blocks if bts.get(chain, b) is None]
        for i in range(0, len(need), 20):
            chunk = need[i:i + 20]
            res = r.batch([("eth_getBlockByNumber", [hex(b), False]) for b in chunk])
            for b, h in zip(chunk, res):
                bts.put(chain, b, h["timestamp"])
        return {b: bts.get(chain, b) for b in blocks}
    t_head = ts_of([head])[head]
    t_1 = ts_of([1])[1]
    targets = {d: day_ts(d) for d in days}
    lo = {d: 1 for d in days}
    hi = {d: head for d in days}
    tlo = {d: t_1 for d in days}
    thi = {d: t_head for d in days}
    for it in range(80):
        open_ = [d for d in days if hi[d] - lo[d] > 1]
        if not open_:
            break
        probes = {}
        for d in open_:
            span = hi[d] - lo[d]
            if it < 12 and thi[d] > tlo[d]:
                g = lo[d] + int((targets[d] - tlo[d]) / (thi[d] - tlo[d]) * span)
            else:
                g = (lo[d] + hi[d]) // 2
            probes[d] = min(max(g, lo[d] + 1), hi[d] - 1)
        ts = ts_of(sorted(set(probes.values())))
        for d, b in probes.items():
            if ts[b] >= targets[d]:
                hi[d], thi[d] = b, ts[b]
            else:
                lo[d], tlo[d] = b, ts[b]
    out = {}
    for d in days:
        b = hi[d]
        tb, tp = ts_of([b, b - 1])[b], ts_of([b, b - 1])[b - 1]
        if not (tb >= targets[d] > tp and tb > 0 and tp > 0):
            raise SystemExit(f"STOP: {chain} {d}: boundary search failed")
        out[d] = b
    json.dump(out, open(p, "w"))
    log(f"{chain}: {len(out)} day boundaries")
    return out


def phase_bounds(work, log, chains=None):
    res = phase_resolve(work, log)
    days = days_between(D2_START, LAST_BOUNDARY)
    out = {}
    for chain in sorted({v["chain"] for v in res.values()}):
        if chains and chain not in chains:
            continue
        out[chain] = boundary_blocks(chain, days, work, log)
    return out


# ---------------------------------------------------------------------------------------------
def fetch_range(rpc, atoken, a, b, span0, span_max, sink, log, tag):
    """Adaptive getLogs over [a, b]; calls sink(list_of_logs, lo, hi) for each window in order."""
    span = span0
    x = a
    while x <= b:
        y = min(b, x + span - 1)
        params = [{"address": atoken, "topics": [TOPICS], "fromBlock": hex(x), "toBlock": hex(y)}]
        ok = False
        for k in range(10):
            url = rpc.urls[k % len(rpc.urls)]
            try:
                outj = rpc.post(url, {"jsonrpc": "2.0", "id": 1, "method": "eth_getLogs", "params": params})
                if "error" in outj:
                    msg = str(outj["error"])
                    if RANGE_ERR.search(msg) and y > x:
                        span = max(1, (y - x + 1) // 2)
                        y = min(b, x + span - 1)
                        params[0]["toBlock"] = hex(y)
                        continue
                    raise RuntimeError(msg[:200])
                sink(outj["result"], x, y)
                ok = True
                break
            except Exception as e:  # noqa: BLE001
                time.sleep(min(30, 1.6 ** k))
                last = e
        if not ok:
            raise RuntimeError(f"{tag}: getLogs failed at {x}-{y}: {QC.redact(str(last))[:200]}")
        x = y + 1
        span = min(span_max, span * 2)


def phase_logs(work, names, log):
    res = phase_resolve(work, log)
    bounds = phase_bounds(work, log)
    for name in names:
        R = res[name]
        chain = R["chain"]
        d = os.path.join(work, name)
        os.makedirs(d, exist_ok=True)
        done_p = os.path.join(d, "done.json")
        if os.path.exists(done_p):
            log(f"{name}: logs done")
            continue
        start = R["deploy_block"]
        end = bounds[chain][LAST_BOUNDARY] - 1
        nseg = THREADS[chain]
        edges = [start + (end - start + 1) * i // nseg for i in range(nseg + 1)]
        rpc = Rpc(QC.rpc_endpoints(chain, LOG_URLS[chain], kind="logs"), rps=8.0)
        lock = threading.Lock()
        t0 = time.time()

        def seg_job(si):
            a, b = edges[si], edges[si + 1] - 1
            prog_p = os.path.join(d, f"seg{si}.progress")
            pos = a
            if os.path.exists(prog_p):
                pos = int(open(prog_p).read().strip()) + 1
            fo = gzip.open(os.path.join(d, f"seg{si}.jsonl.gz"), "at")
            nlog = [0]

            def sink(logs, lo, hi):
                for x in logs:
                    if x.get("removed"):
                        continue
                    ev = GE.decode_log(x["topics"], x["data"])
                    if ev is None:
                        continue
                    for addr, _raw, sd in ev["deltas"]:
                        fo.write(json.dumps([int(x["blockNumber"], 16), int(x["logIndex"], 16), addr, sd,
                                             str(ev["index"])]) + "\n")
                    nlog[0] += 1
                fo.flush()
                with open(prog_p, "w") as f:
                    f.write(str(hi))
            if pos <= b:
                fetch_range(rpc, R["atoken"], pos, b, SPAN[chain][0], SPAN[chain][1], sink, log, f"{name}/{si}")
            fo.close()
            with lock:
                log(f"{name}: segment {si} done ({nlog[0]} logs this session, {time.time() - t0:.0f} s)")
        with cf.ThreadPoolExecutor(nseg) as ex:
            list(ex.map(seg_job, range(nseg)))
        json.dump({"start": start, "end": end, "segments": nseg, "finished_utc": utcnow(), "requests": rpc.n},
                  open(done_p, "w"))
        log(f"{name}: logs complete, {rpc.n} requests, {time.time() - t0:.0f} s")


# ---------------------------------------------------------------------------------------------
def load_deltas(work, name):
    d = os.path.join(work, name)
    seen = set()
    rows = []
    for f in sorted(os.listdir(d)):
        if not f.endswith(".jsonl.gz"):
            continue
        with gzip.open(os.path.join(d, f), "rt") as fh:
            for line in fh:
                try:
                    b, li, a, sd, idx = json.loads(line)
                except ValueError:
                    continue            # a torn last line after a kill (resume rewrote the window)
                k = (b, li, a, sd)
                if k in seen:
                    continue            # a window re-fetched after a resume
                seen.add(k)
                rows.append((b, li, a, sd, int(idx)))
    rows.sort(key=lambda r: (r[0], r[1]))
    return rows


def phase_counts(work, out_path, log):
    if os.path.exists(out_path):
        raise SystemExit(f"STOP: {out_path} exists")
    res = phase_resolve(work, log)
    bounds = phase_bounds(work, log)
    days_all = days_between(D2_START, LAST_BOUNDARY)
    counted = set(days_between(D2_START, COUNT_END_1)) | set(days_between(COUNT_START_2, COUNT_END_2))
    per = {}
    thin_rows = []                  # (unit_key, day_index)
    integrity = {}
    for name, R in res.items():
        chain = R["chain"]
        if not os.path.exists(os.path.join(work, name, "done.json")):
            raise SystemExit(f"STOP: {name} logs incomplete")
        ev = load_deltas(work, name)
        blk = np.array([e[0] for e in ev], dtype=np.int64)
        addrs = sorted({e[2] for e in ev})
        aid = {a: i for i, a in enumerate(addrs)}
        ai = np.array([aid[e[2]] for e in ev], dtype=np.int64)
        sd = np.array([e[3] for e in ev], dtype=np.int64)
        idx = np.array([e[4] for e in ev], dtype=object)
        idxf = np.array([float(v) / 1e27 for v in idx])
        idx_run = np.maximum.accumulate(idxf) if len(idxf) else idxf
        # integrity: sum of scaled x last index vs aToken totalSupply at the last boundary
        end_b = bounds[chain][LAST_BOUNDARY]
        r = state_rpc(chain)
        ts_raw = int(r.call("eth_call", [{"to": R["atoken"], "data": "0x" + SEL["totalSupply"]}, hex(end_b - 1)]), 16)
        tot_scaled = int(sd.sum())
        rec = float(tot_scaled) * (float(idx_run[-1]) if len(idx_run) else 0.0)
        integrity[name] = {"rel_err_total_supply": abs(rec - ts_raw) / ts_raw if ts_raw else None,
                           "events": int(len(ev)), "addresses": int(len(addrs))}
        # per address: cumulative scaled at each event (address-sorted, chain order inside)
        order = np.lexsort((np.arange(len(ai)), ai))
        a_s, b_s, c_s = ai[order], blk[order], np.zeros(len(order), dtype=np.int64)
        starts = np.searchsorted(a_s, np.arange(len(addrs)))
        ends = np.searchsorted(a_s, np.arange(len(addrs)), side="right")
        sdo = sd[order]
        for i in range(len(addrs)):
            c_s[starts[i]:ends[i]] = np.cumsum(sdo[starts[i]:ends[i]])
        first_day = ARB_FIRST if chain == "arbitrum" else D2_START
        days = [d for d in days_all if d in counted and d >= first_day and bounds[chain][d] > R["deploy_block"]]
        bb = np.array([bounds[chain][d] for d in days], dtype=np.int64)
        ib = np.searchsorted(blk, bb, side="left") - 1           # last event strictly before the boundary block
        index_d = np.where(ib >= 0, idx_run[np.maximum(ib, 0)], 0.0)
        maxbal = np.array([c_s[starts[i]:ends[i]].max() if ends[i] > starts[i] else 0 for i in range(len(addrs))],
                          dtype=float) * (idx_run.max() if len(idx_run) else 0.0)
        cand = np.nonzero(maxbal >= MIN_BAL)[0]
        units1m, bigrows = set(), []
        big_addr = set()
        bal_cache = {}
        for i in cand:
            bs, cs = b_s[starts[i]:ends[i]], c_s[starts[i]:ends[i]]
            j = np.searchsorted(bs, bb, side="left") - 1
            bal = np.where(j >= 0, cs[np.maximum(j, 0)], 0).astype(float) * index_d
            if (bal >= MIN_BAL).any():
                units1m.add(i)
            if (bal >= C_MIN).any():
                big_addr.add(i)
                bal_cache[i] = bal
        # holder codes at the cutoff for addresses that ever reach $10M
        code = {}
        al = sorted(big_addr)
        for k in range(0, len(al), 50):
            chunk = al[k:k + 50]
            out = r.batch([("eth_getCode", [addrs[i], hex(end_b - 1)]) for i in chunk])
            for i, c in zip(chunk, out):
                c = (c or "0x").lower()
                code[i] = (c != "0x") and not c.startswith("0xef0100")
        d_index = {d: (datetime.strptime(d, "%Y-%m-%d") - datetime.strptime(D2_START, "%Y-%m-%d")).days for d in days}
        dvec = np.array([d_index[d] for d in days])
        bigunits = set()
        for i, bal in bal_cache.items():
            m = (bal >= W_MIN) if not code[i] else (bal >= C_MIN)
            for t in dvec[m]:
                thin_rows.append((f"{name}:{i}", int(t)))
            if m.any():
                bigunits.add(i)
            bigrows.append(int(m.sum()))
        per[name] = {"first_counted_day": days[0] if days else None, "last_counted_day": days[-1] if days else None,
                     "units_ge_1m": len(units1m), "big_wallet_units": len(bigunits),
                     "big_wallet_unit_days": int(sum(bigrows))}
        log(f"{name}: {json.dumps(per[name])}")
    units = {u for u, _ in thin_rows}
    blocks = {t // 30 for _, t in thin_rows}
    cells = {(u, t // 30) for u, t in thin_rows}
    out = {"phase": "counts-only check of D2 (D-R15.4b fields; no exit, label, balance change, rate or positive count)",
           "code": code_meta(), "created_utc": utcnow(), "per_reserve": per,
           "pooled": {"thin_units": len(units), "blocks_30d": len(blocks), "cells_unit_block": len(cells)},
           "integrity_total_supply": integrity,
           "counted_days_rule": f"{D2_START}..{COUNT_END_1} and {COUNT_START_2}..{COUNT_END_2} (Arbitrum from "
                                f"{ARB_FIRST}); upper bound of scored rows (feature warm-up and resolution not applied)",
           "balance_rule": "scaled balance x the last liquidity index logged before the 00:00Z boundary block"}
    with open(out_path, "w") as f:
        json.dump(out, f, indent=1)
    txt = open(out_path).read()
    if re.search(r"0x[0-9a-fA-F]{40}", txt):
        raise SystemExit("STOP: an address reached the counts file")
    log(json.dumps(out["pooled"]))
    return out


def code_meta():
    import subprocess
    here = os.path.dirname(os.path.abspath(__file__))

    def git(*a):
        return subprocess.run(["git", "-C", here, *a], capture_output=True, text=True).stdout.strip()
    return {"git_head": git("rev-parse", "HEAD"), "tree_dirty": bool(git("status", "--porcelain", "--", "."))}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("phase", choices=["resolve", "bounds", "logs", "counts"])
    ap.add_argument("--work", required=True)
    ap.add_argument("--reserves", default=",".join(RESERVES))
    ap.add_argument("--out")
    ap.add_argument("--chains")
    a = ap.parse_args(argv)
    os.makedirs(a.work, exist_ok=True)

    def log(m):
        print(f"[{utcnow()}] {m}", flush=True)
    if a.phase == "resolve":
        phase_resolve(a.work, log)
    elif a.phase == "bounds":
        phase_bounds(a.work, log, a.chains.split(",") if a.chains else None)
    elif a.phase == "logs":
        phase_logs(a.work, a.reserves.split(","), log)
    else:
        phase_counts(a.work, a.out, log)


if __name__ == "__main__":
    main()
