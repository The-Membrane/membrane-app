#!/usr/bin/env python3
"""Q26 R14.2: outcome-blind builder for blind set D1 (Aave V2 Ethereum USDC and USDT per-deposit panels).

Registered set: membrane-board `design/q26-blind-set-inventory-2026-10-17.md` section 2, row D1 (Aave V2 Ethereum USDC and
USDT, 2020-12 -> 2026-06-30). Item: `design/Q26_ROUND14_PREREG.md` R14.2 (Deviation D-R14.2a names the readings).

This builder computes inputs only: daily 00:00Z blocks, decoded aToken Mint / Burn / BalanceTransfer logs, exact daily
balance anchors (scaled balance from every event since the reserve's first log x getReserveNormalizedIncome at the
snapshot block), daily reserve state and holder codes. It computes no exit, label, rate or score. The `counts` phase
of r142_ladder.py runs the counts-only check on its output.

Output layout = the depositor-blind5 layout read by bg_gradient.load_reserve (one folder per reserve):
  blocks.csv                         daily snapshots (kind daily) + asof (the cutoff block)
  <R>/events-<r>-<year>.csv.gz       decoded logs (G.2 columns; V2 deltas: Mint +value, Burn -value, BalanceTransfer
                                     -value / +value, all in underlying units)
  <R>/daily-balances-<r>.csv.gz      anchors (address, snapshot, balance_raw, status); zero balances omitted
                                     (load_anchors reads a missing row as 0); every universe address has an asof row
  <R>/extended-universe.csv          addresses with a daily anchor >= $1M on some snapshot
  <R>/reserve-state.csv              listed, totalSupply, cash, variableDebt, rates per snapshot
  <R>/holder-codes.csv               is_contract / eip7702_delegated at the cutoff block
  gate-report.json                   anchor check: reconstructed vs on-chain balanceOf at sampled (address, day)
Raw data with addresses stays in the scratch work directory. It is never published.

Sources (free, keyless): eth_getLogs on rpc.mevblocker.io (logs carry blockTimestamp); archive eth_call and
eth_getBlockByNumber on eth.drpc.org (JSON-RPC batches), rpc.mevblocker.io as fallback.

Phases: blocks, logs, state, build, codes, gate (in this order; each is resumable from its checkpoint files).
"""
import argparse
import csv
import gzip
import json
import os
import random
import sys
import time
from datetime import datetime, timezone, timedelta

import requests

RAY = 10 ** 27
HALF_RAY = RAY // 2
POOL = "0x7d2768de32b0b80b7a3454c06bdac94a69ddc7a9"           # Aave V2 Ethereum LendingPool (proxy)
RESERVES = {"V2_USDC": {"asset": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
                        "atoken": "0xbcca60bb61934080951369a648fb03df4f96263c", "decimals": 6},
            "V2_USDT": {"asset": "0xdac17f958d2ee523a2206206994597c13d831ec7",
                        "atoken": "0x3ed3b47dd13ec9a98b44e6204a523e766b225811", "decimals": 6}}
TOPIC = {"0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f": "Mint",
         "0x5d624aa9c148153ab3446c1b154f660ee7701e549fe9b62dab7171b1c80e6fa2": "Burn",
         "0x4beccb90f994c31aced7a23b5611020728a23d8ec5cddd1a3e9d97b96fda8666": "BalanceTransfer"}
FIRST_DAY = "2020-12-01"           # first daily snapshot (the V2 pool was deployed 2020-11-30; first USDC log after)
LAST_DAY = "2026-06-30"            # last daily snapshot; cutoff = last block with ts < 2026-07-01T00:00Z (inventory D1)
START_BLOCK = 11362579             # V2 LendingPool proxy deployment block
MIN_BAL = 1_000_000 * 10 ** 6      # universe: a daily anchor >= $1M (6-decimal reserves)
LOG_URL = "https://rpc.mevblocker.io"
STATE_URLS = ("https://eth.drpc.org", "https://rpc.mevblocker.io")
SEL = {"getReserveData": "35ea6a75", "getReserveNormalizedIncome": "d15e0053", "totalSupply": "18160ddd",
       "balanceOf": "70a08231"}
GATE_SAMPLE = 400
GATE_SEED = 20261019


def utc(ts):
    return datetime.fromtimestamp(int(ts), timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def day_ts(s):
    return int(datetime.strptime(s, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp())


def ray_div(a, b):
    return (a * RAY + b // 2) // b


def ray_mul(a, b):
    return (a * b + HALF_RAY) // RAY


class Rpc:
    def __init__(self, urls, rps=4.0):
        self.urls = list(urls)
        self.s = requests.Session()
        self.s.headers.update({"content-type": "application/json", "user-agent": "curl/8.5.0"})
        self.min_dt = 1.0 / rps
        self.last = 0.0
        self.n = 0
        self.retries = 0

    def _post(self, url, payload, timeout=60):
        dt = time.time() - self.last
        if dt < self.min_dt:
            time.sleep(self.min_dt - dt)
        self.last = time.time()
        self.n += 1
        r = self.s.post(url, data=json.dumps(payload), timeout=timeout)
        r.raise_for_status()
        return r.json()

    def batch(self, calls, tries=8):
        """calls: [(method, params)] -> results in order. Retries the whole batch on any error."""
        payload = [{"jsonrpc": "2.0", "id": i, "method": m, "params": p} for i, (m, p) in enumerate(calls)]
        err = None
        for k in range(tries):
            url = self.urls[k % len(self.urls)]
            try:
                out = self._post(url, payload)
                if isinstance(out, dict):
                    raise RuntimeError(f"batch answered with {str(out)[:200]}")
                byid = {o["id"]: o for o in out}
                res = []
                for i in range(len(calls)):
                    o = byid.get(i)
                    if o is None or "error" in o:
                        raise RuntimeError(f"call {i} failed: {str(o)[:200]}")
                    res.append(o["result"])
                return res
            except Exception as e:      # noqa: BLE001  (network / rate limit / node error: retry)
                err = e
                self.retries += 1
                time.sleep(min(30, 2 ** k))
        raise SystemExit(f"STOP: RPC batch failed after {tries} tries: {err}")

    def one(self, method, params, url=None, tries=6):
        err = None
        for k in range(tries):
            try:
                out = self._post(url or self.urls[k % len(self.urls)],
                                 {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}, timeout=120)
                if "error" in out:
                    return None, out["error"]
                return out["result"], None
            except Exception as e:      # noqa: BLE001
                err = e
                self.retries += 1
                time.sleep(min(30, 2 ** k))
        return None, {"message": f"transport: {err}"}


def word(hexdata, i):
    return int(hexdata[2 + 64 * i: 2 + 64 * (i + 1)], 16)


def addr_word(hexdata, i):
    return "0x" + hexdata[2 + 64 * i + 24: 2 + 64 * (i + 1)]


def topic_addr(t):
    return "0x" + t[-40:]


# ---------------------------------------------------------------------------------------------
# blocks
# ---------------------------------------------------------------------------------------------
def phase_blocks(work, log=print, reuse=None):
    out = os.path.join(work, "blocks.csv")
    if os.path.exists(out):
        log("blocks: exists")
        return
    rpc = Rpc(STATE_URLS, rps=6)
    cache = {}

    def ts_of(blocks):
        need = [b for b in blocks if b not in cache]
        for i in range(0, len(need), 20):
            part = need[i:i + 20]
            res = rpc.batch([("eth_getBlockByNumber", [hex(b), False]) for b in part])
            for b, r in zip(part, res):
                cache[b] = int(r["timestamp"], 16)
        return [cache[b] for b in blocks]

    def find(T, guess):
        """Last block with ts < T: secant probes, then a bracket bisection."""
        lo, hi = None, None
        b = guess
        for _ in range(60):
            t = ts_of([b])[0]
            if t < T:
                lo = b if lo is None or b > lo else lo
            else:
                hi = b if hi is None or b < hi else hi
            if lo is not None and hi is not None and hi - lo == 1:
                return lo
            if lo is not None and hi is not None:
                tl, th = ts_of([lo, hi])
                nb = lo + max(1, min(hi - lo - 1, int((T - 1 - tl) * (hi - lo) / max(1, th - tl))))
                if nb <= lo or nb >= hi:
                    nb = (lo + hi) // 2
                b = nb
            elif lo is not None:
                b = lo + max(1, int((T - ts_of([lo])[0]) / 13))
            else:
                b = hi - max(1, int((ts_of([hi])[0] - T) / 13) + 1)
        raise SystemExit(f"STOP: block search did not converge for {T}")

    head = int(rpc.one("eth_blockNumber", [])[0], 16)
    d0 = datetime.strptime(FIRST_DAY, "%Y-%m-%d")
    d1 = datetime.strptime(LAST_DAY, "%Y-%m-%d") + timedelta(days=1)
    days = []
    d = d0
    while d <= d1:
        days.append(d.strftime("%Y-%m-%d"))
        d += timedelta(days=1)
    known = {}
    if reuse and os.path.exists(reuse):           # same definition (last block with ts < 00:00Z, proven by ts(b + 1))
        with open(reuse) as f:
            for r in csv.DictReader(f):
                if r["kind"] == "daily" and r["proof"] == "ok":
                    known[r["snapshot"]] = (int(r["block"]), int(r["block_ts"]), int(r["next_ts"]))
    rows = []
    guess = START_BLOCK
    t0 = time.time()
    for i, s in enumerate(days):
        T = day_ts(s)
        if s in known:
            b, tb, tn = known[s]
            rows.append((s, T, b, tb, tn))
            continue
        b = find(T, guess)
        tb, tn = ts_of([b, b + 1])
        if not (tb < T <= tn) or b + 1 > head:
            raise SystemExit(f"STOP: block proof failed at {s}")
        rows.append((s, T, b, tb, tn))
        guess = b + (b - rows[-2][2] if len(rows) > 1 else 6500)
        if i % 100 == 0:
            log(f"  blocks {i}/{len(days)} {s} -> {b} ({time.time() - t0:.0f} s, {rpc.n} requests)")
    with open(out + ".tmp", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["snapshot", "kind", "monthly", "T", "T_utc", "block", "block_ts", "block_utc", "next_ts", "proof"])
        for s, T, b, tb, tn in rows[:-1]:
            w.writerow([s, "daily", int(s.endswith("-01")), T, utc(T), b, tb, utc(tb), tn, "ok"])
        s, T, b, tb, tn = rows[-1]          # 2026-07-01: the cutoff block (last block before it) is the asof
        w.writerow(["asof", "asof", 0, "", "", b, tb, utc(tb), tn, ""])
    os.replace(out + ".tmp", out)
    log(f"blocks: {len(rows) - 1} daily snapshots + asof block {rows[-1][2]} ({rpc.n} requests)")


def read_blocks(work):
    days, blocks, asof = [], [], None
    with open(os.path.join(work, "blocks.csv")) as f:
        for r in csv.DictReader(f):
            if r["kind"] == "daily":
                days.append(r["snapshot"])
                blocks.append(int(r["block"]))
            else:
                asof = int(r["block"])
    return days, blocks, asof


# ---------------------------------------------------------------------------------------------
# logs
# ---------------------------------------------------------------------------------------------
def phase_logs(work, log=print):
    days, blocks, asof = read_blocks(work)
    ldir = os.path.join(work, "logs")
    os.makedirs(ldir, exist_ok=True)
    ck = os.path.join(ldir, "checkpoint.json")
    state = json.load(open(ck)) if os.path.exists(ck) else {"next": START_BLOCK, "parts": 0, "logs": 0}
    rpc = Rpc([LOG_URL], rps=3)
    span = 20000
    addrs = [r["atoken"] for r in RESERVES.values()]
    topics = [list(TOPIC.keys())]
    t0 = time.time()
    buf = []
    b = state["next"]
    while b <= asof:
        e = min(asof, b + span - 1)
        res, err = rpc.one("eth_getLogs", [{"address": addrs, "topics": topics, "fromBlock": hex(b), "toBlock": hex(e)}],
                           url=LOG_URL)
        if err is not None or (res is not None and len(res) >= 10000 and e > b):
            span = max(100, (e - b + 1) // 2)
            continue
        if err is not None:
            raise SystemExit(f"STOP: getLogs failed at {b}-{e}: {err}")
        for x in res:
            if x.get("removed"):
                continue
            buf.append([x["address"].lower(), int(x["blockNumber"], 16), int(x["blockTimestamp"], 16),
                        x["transactionHash"], int(x["transactionIndex"], 16), int(x["logIndex"], 16),
                        x["topics"][0], "|".join(x["topics"][1:]), x["data"]])
        b = e + 1
        if len(res) < 3000:
            span = min(200000, int(span * 1.25))
        if len(buf) >= 200000 or b > asof:
            p = os.path.join(ldir, f"part-{state['parts']:04d}.csv.gz")
            with gzip.open(p + ".tmp", "wt", newline="") as f:
                csv.writer(f).writerows(buf)
            os.replace(p + ".tmp", p)
            state = {"next": b, "parts": state["parts"] + 1, "logs": state["logs"] + len(buf)}
            json.dump(state, open(ck, "w"))
            log(f"  logs to block {b - 1}: {state['logs']} logs, {rpc.n} requests ({time.time() - t0:.0f} s)")
            buf = []
    state["done"] = True
    json.dump(state, open(ck, "w"))
    log(f"logs: done, {state['logs']} logs")


# ---------------------------------------------------------------------------------------------
# reserve state
# ---------------------------------------------------------------------------------------------
def call(to, sel, *args):
    data = "0x" + sel + "".join(a[2:].rjust(64, "0") for a in args)
    return {"to": to, "data": data}


def phase_state(work, log=print):
    days, blocks, asof = read_blocks(work)
    out = os.path.join(work, "state-raw.csv")
    done = set()
    if os.path.exists(out):
        with open(out) as f:
            for r in csv.DictReader(f):
                done.add((r["snapshot"], r["reserve"]))
    rpc = Rpc(STATE_URLS, rps=5)
    snaps = list(zip(days, blocks)) + [("asof", asof)]
    new = not os.path.exists(out)
    f = open(out, "a", newline="")
    w = csv.writer(f)
    if new:
        w.writerow(["snapshot", "reserve", "block", "listed", "configuration", "liquidityIndex", "variableBorrowIndex",
                    "liquidityRate_ray", "variableBorrowRate_ray", "aToken_rd", "variableDebtToken", "normIncome",
                    "totalSupply", "cash", "variableDebt", "status"])
    t0 = time.time()
    for i, (s, b) in enumerate(snaps):
        todo = [r for r in RESERVES if (s, r) not in done]
        if not todo:
            continue
        calls = []
        for r in todo:
            a = RESERVES[r]
            calls += [("eth_call", [call(POOL, SEL["getReserveData"], a["asset"]), hex(b)]),
                      ("eth_call", [call(POOL, SEL["getReserveNormalizedIncome"], a["asset"]), hex(b)]),
                      ("eth_call", [call(a["atoken"], SEL["totalSupply"]), hex(b)]),
                      ("eth_call", [call(a["asset"], SEL["balanceOf"], a["atoken"]), hex(b)])]
        res = rpc.batch(calls)
        vdebt = []
        for k, r in enumerate(todo):
            rd = res[4 * k]
            if rd in ("0x", None) or len(rd) < 2 + 64 * 12 or word(rd, 7) == 0:
                vdebt.append(None)
            else:
                vdebt.append(addr_word(rd, 9))
        calls2 = [("eth_call", [call(v, SEL["totalSupply"]), hex(b)]) for v in vdebt if v]
        res2 = rpc.batch(calls2) if calls2 else []
        j = 0
        for k, r in enumerate(todo):
            rd, ni, ts_, cash = res[4 * k: 4 * k + 4]
            if vdebt[k] is None:
                w.writerow([s, r, b, 0] + [""] * 11 + ["not_listed"])
                continue
            vd = int(res2[j], 16)
            j += 1
            w.writerow([s, r, b, 1, word(rd, 0), word(rd, 1), word(rd, 2), word(rd, 3), word(rd, 4), addr_word(rd, 7),
                        vdebt[k], int(ni, 16), int(ts_, 16), int(cash, 16), vd, "ok"])
        if i % 100 == 0:
            f.flush()
            log(f"  state {i}/{len(snaps)} {s} ({time.time() - t0:.0f} s, {rpc.n} requests, {rpc.retries} retries)")
    f.close()
    log(f"state: done ({rpc.n} requests)")


def read_state(work):
    st = {}
    with open(os.path.join(work, "state-raw.csv")) as f:
        for r in csv.DictReader(f):
            st[(r["snapshot"], r["reserve"])] = r
    return st


# ---------------------------------------------------------------------------------------------
# build: decode, scaled paths, anchors, universe, reserve state
# ---------------------------------------------------------------------------------------------
def iter_logs(work):
    ldir = os.path.join(work, "logs")
    for p in sorted(x for x in os.listdir(ldir) if x.startswith("part-") and x.endswith(".csv.gz")):
        with gzip.open(os.path.join(ldir, p), "rt") as f:
            for row in csv.reader(f):
                yield row


def phase_build(work, log=print):
    days, blocks, asof = read_blocks(work)
    if not json.load(open(os.path.join(work, "logs", "checkpoint.json"))).get("done"):
        raise SystemExit("STOP: logs phase not complete")
    st = read_state(work)
    a2r = {v["atoken"]: k for k, v in RESERVES.items()}
    ev = {r: [] for r in RESERVES}
    seen = set()
    for row in iter_logs(work):
        atok, blk, ts, txh, txi, li, t0p, tops, data = row
        key = (blk, li)
        if key in seen:
            raise SystemExit("STOP: duplicate log key")
        seen.add(key)
        r = a2r[atok]
        typ = TOPIC[t0p]
        tp = tops.split("|")
        if typ == "Mint":
            p1, p2 = topic_addr(tp[0]), ""
            val, idx = word(data, 0), word(data, 1)
            d1, d2 = val, None
        elif typ == "Burn":
            p1, p2 = topic_addr(tp[0]), topic_addr(tp[1])
            val, idx = word(data, 0), word(data, 1)
            d1, d2 = -val, None
        else:
            p1, p2 = topic_addr(tp[0]), topic_addr(tp[1])
            val, idx = word(data, 0), word(data, 1)
            d1, d2 = -val, val
        ev[r].append((int(blk), int(ts), txh, int(txi), int(li), typ, p1, p2, val, idx, d1, d2))
    del seen
    summary = {}
    for r in RESERVES:
        E = sorted(ev[r], key=lambda x: (x[0], x[4]))
        rdir = os.path.join(work, r)
        os.makedirs(rdir, exist_ok=True)
        lo = r.lower()
        # events per year (G.2 columns)
        byyear = {}
        for x in E:
            byyear.setdefault(datetime.fromtimestamp(x[1], timezone.utc).year, []).append(x)
        for y, xs in byyear.items():
            with gzip.open(os.path.join(rdir, f"events-{lo}-{y}.csv.gz"), "wt", newline="") as f:
                w = csv.writer(f)
                w.writerow(["reserve", "block", "ts", "tx_hash", "tx_index", "log_index", "type", "party1", "party2",
                            "value_raw", "balanceIncrease_raw", "index_ray", "delta1_raw", "delta2_raw"])
                for (blk, ts, txh, txi, li, typ, p1, p2, val, idx, d1, d2) in xs:
                    w.writerow([r, blk, ts, txh, txi, li, typ, p1, p2, val, "", idx, d1, "" if d2 is None else d2])
        # scaled balances (V2 AToken: Mint/Burn/transfer move amount.rayDiv(index) scaled units)
        snaps = list(zip(days, blocks)) + [("asof", asof)]
        scaled = {}
        anchors = []                       # (address, snapshot, balance)
        k = 0
        big = set()
        n_neg = 0
        for s, b in snaps:
            while k < len(E) and E[k][0] <= b:
                blk, ts, txh, txi, li, typ, p1, p2, val, idx, d1, d2 = E[k]
                sv = ray_div(val, idx)
                if typ == "Mint":
                    scaled[p1] = scaled.get(p1, 0) + sv
                elif typ == "Burn":
                    scaled[p1] = scaled.get(p1, 0) - sv
                else:
                    scaled[p1] = scaled.get(p1, 0) - sv
                    scaled[p2] = scaled.get(p2, 0) + sv
                k += 1
            srow = st[(s, r)]
            if srow["status"] != "ok":
                continue
            ni = int(srow["normIncome"])
            for a, v in scaled.items():
                if v == 0:
                    continue
                if v < 0:
                    n_neg += 1
                bal = ray_mul(v, ni) if v > 0 else -ray_mul(-v, ni)
                anchors.append((a, s, bal))
                if s != "asof" and bal >= MIN_BAL:
                    big.add(a)
        U = sorted(big)
        Us = set(U)
        with gzip.open(os.path.join(rdir, f"daily-balances-{lo}.csv.gz"), "wt", newline="") as f:
            w = csv.writer(f)
            w.writerow(["address", "snapshot", "balance_raw", "status"])
            have_asof = set()
            for a, s, bal in anchors:
                if a in Us:
                    w.writerow([a, s, bal, "ok"])
                    if s == "asof":
                        have_asof.add(a)
            for a in U:
                if a not in have_asof:
                    w.writerow([a, "asof", 0, "ok"])
        first_ev = {}
        n_ev = {}
        for x in E:
            for a in (x[6], x[7]):
                if a in Us:
                    first_ev.setdefault(a, x)
                    n_ev[a] = n_ev.get(a, 0) + 1
        with open(os.path.join(rdir, "extended-universe.csv"), "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["reserve", "address", "in_P_r", "P_r_rule", "reaches_1M_by_events", "new",
                        "first_event_block", "first_event_utc", "n_balance_events"])
            for a in U:
                fe = first_ev.get(a)
                w.writerow([r, a, 0, "", 1, 0, fe[0] if fe else "", utc(fe[1]) if fe else "", n_ev.get(a, 0)])
        with open(os.path.join(rdir, "reserve-state.csv"), "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["snapshot", "reserve", "block", "listed", "totalSupply", "cash", "variableDebt",
                        "liquidityRate_ray", "variableBorrowRate_ray", "liquidityIndex", "normIncome",
                        "totalSupply_status", "cash_status", "variableDebt_status"])
            for s, b in snaps:
                x = st[(s, r)]
                if x["status"] != "ok":
                    w.writerow([s, r, b, 0, "", 0, "", 0, 0, "", "", "ok", "ok", "not_listed"])
                else:
                    w.writerow([s, r, b, 1, x["totalSupply"], x["cash"], x["variableDebt"], x["liquidityRate_ray"],
                                x["variableBorrowRate_ray"], x["liquidityIndex"], x["normIncome"], "ok", "ok", "ok"])
        # supply identity: sum of all positive scaled x normIncome at asof vs totalSupply (reported)
        tot = sum(v for v in scaled.values())
        xa = st[("asof", r)]
        summary[r] = {"logs": len(E), "by_type": {t: sum(1 for x in E if x[5] == t) for t in TOPIC.values()},
                      "universe_units": len(U), "anchor_rows": sum(1 for a, s, _ in anchors if a in Us),
                      "negative_scaled_cells": n_neg,
                      "asof_sum_scaled_x_income": ray_mul(tot, int(xa["normIncome"])) if xa["status"] == "ok" else None,
                      "asof_totalSupply": int(xa["totalSupply"]) if xa["status"] == "ok" else None,
                      "first_log_utc": utc(E[0][1]) if E else None, "last_log_utc": utc(E[-1][1]) if E else None}
        log(f"  {r}: {summary[r]}")
    json.dump(summary, open(os.path.join(work, "build-summary.json"), "w"), indent=1)
    log("build: done")


# ---------------------------------------------------------------------------------------------
# holder codes and gate
# ---------------------------------------------------------------------------------------------
def universe_of(work, r):
    with open(os.path.join(work, r, "extended-universe.csv")) as f:
        return [x["address"] for x in csv.DictReader(f)]


def phase_codes(work, log=print):
    days, blocks, asof = read_blocks(work)
    rpc = Rpc(STATE_URLS, rps=5)
    for r in RESERVES:
        out = os.path.join(work, r, "holder-codes.csv")
        if os.path.exists(out):
            continue
        U = universe_of(work, r)
        rows = []
        for i in range(0, len(U), 25):
            part = U[i:i + 25]
            res = rpc.batch([("eth_getCode", [a, hex(asof)]) for a in part])
            for a, c in zip(part, res):
                c = c or "0x"
                d7702 = c.lower().startswith("0xef0100") and len(c) == 2 + 46
                rows.append((a, int(len(c) > 2 and not d7702), int(d7702)))
        with open(out, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["address", "is_contract", "eip7702_delegated", "code_block"])
            for a, c, d in rows:
                w.writerow([a, c, d, asof])
        log(f"  codes {r}: {len(rows)} units, {sum(x[1] for x in rows)} contracts")


def phase_gate(work, log=print):
    """Anchor check (V1-style): reconstructed anchors vs on-chain aToken balanceOf at the snapshot block."""
    days, blocks, asof = read_blocks(work)
    bmap = dict(zip(days, blocks))
    bmap["asof"] = asof
    rng = random.Random(GATE_SEED)
    rpc = Rpc(STATE_URLS, rps=5)
    rep = {}
    for r in RESERVES:
        lo = r.lower()
        cells = []
        with gzip.open(os.path.join(work, r, f"daily-balances-{lo}.csv.gz"), "rt") as f:
            for x in csv.DictReader(f):
                cells.append((x["address"], x["snapshot"], int(x["balance_raw"])))
        U = universe_of(work, r)
        # nonzero anchors (sampled) + zero cells (address with no row on a day: sampled days)
        samp = rng.sample(cells, min(GATE_SAMPLE, len(cells)))
        have = {(a, s) for a, s, _ in cells}
        zeros = []
        while len(zeros) < GATE_SAMPLE // 4:
            a, s = rng.choice(U), rng.choice(days)
            if (a, s) not in have:
                zeros.append((a, s, 0))
        test = samp + zeros
        bad, worst = 0, 0.0
        for i in range(0, len(test), 20):
            part = test[i:i + 20]
            res = rpc.batch([("eth_call", [call(RESERVES[r]["atoken"], SEL["balanceOf"], a), hex(bmap[s])])
                             for a, s, _ in part])
            for (a, s, v), got in zip(part, res):
                g = int(got, 16)
                err = abs(g - v)
                rel = err / max(g, 1)
                ok = err <= max(10 * 10 ** 6, g // 200)       # max($10, 0.5%) as the cross-venue gate
                worst = max(worst, rel if g >= 10 ** 12 else 0.0)
                bad += int(not ok)
        rep[r] = {"checked": len(test), "nonzero_sampled": len(samp), "zero_sampled": len(zeros), "failures": int(bad),
                  "share_pass": 1 - bad / len(test), "max_rel_err_at_ge_1M": worst}
        log(f"  gate {r}: {rep[r]}")
    rep["rule"] = "|reconstructed - balanceOf| <= max($10, 0.5%) on >= 99% of sampled (address, snapshot) cells"
    rep["pass"] = all(v["share_pass"] >= 0.99 for k, v in rep.items() if k in RESERVES)
    json.dump(rep, open(os.path.join(work, "gate-report.json"), "w"), indent=1)
    log(f"gate: pass = {rep['pass']}")


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("phase", choices=("blocks", "logs", "state", "build", "codes", "gate", "all"))
    ap.add_argument("--work", required=True)
    ap.add_argument("--reuse-blocks", default=None, help="depositor-balances/blocks.csv (same block rule) to skip searches")
    a = ap.parse_args(argv)
    os.makedirs(a.work, exist_ok=True)

    def log(m):
        print(f"[{utc(time.time())}] {m}", flush=True)
    ph = ("blocks", "logs", "state", "build", "codes", "gate") if a.phase == "all" else (a.phase,)
    for p in ph:
        log(f"phase {p} start")
        if p == "blocks":
            phase_blocks(a.work, log, reuse=a.reuse_blocks)
        else:
            globals()[f"phase_{p}"](a.work, log)
        log(f"phase {p} end")


if __name__ == "__main__":
    sys.exit(main())
