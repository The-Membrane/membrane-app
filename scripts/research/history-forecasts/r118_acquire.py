"""Q26 R11.8 input acquisition (membrane-board design/Q26_ROUND11_PREREG.md D-R11.8a, R11.8-2). Inputs only:
no forecast, loss, outcome comparison or score is computed here.

  python3 r118_acquire.py blocks --chain C --work DIR    b_d = last block with ts < d 00:00Z, proven by ts(b_d + 1)
  python3 r118_acquire.py daily  --market M --work DIR   one read per day at b_d (rate, debt, cash, curve)
  python3 r118_acquire.py hours  --market M --work DIR   curve-change hour by bisection over hourly reads (M3 only)
  python3 r118_acquire.py export --work DIR --out DIR    address-free daily inputs + curve changes + counts

Free keyless JSON-RPC only (batch eth_call / eth_getBlockByNumber). Contract addresses below are public protocol
identifiers; they stay in code and --work. Exported files name markets only.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import gzip
import hashlib
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import b_acquire as B  # noqa: E402  (keccak selector, ABI word helpers)

LAST_DAY = dt.date(2026, 10, 17)       # last read: block before 2026-10-17 00:00Z
UA = "curl/8.5.0"
ADDR_RE = re.compile(r"0x[0-9a-fA-F]{40}")

CHAINS = {
    "ethereum": {"urls": ["https://eth.drpc.org", "https://rpc.mevblocker.io", "https://mainnet.gateway.tenderly.co"],
                 "first": dt.date(2020, 12, 1)},
    "arbitrum": {"urls": ["https://arbitrum.gateway.tenderly.co", "https://gateway.tenderly.co/public/arbitrum"],
                 "first": dt.date(2022, 9, 1), "min_block": 22_207_818},          # Nitro genesis
    # pre-Bedrock (legacy) state only on the OP Labs endpoint; post-Bedrock on Tenderly too
    "optimism": {"urls": ["https://mainnet.optimism.io", "https://optimism.gateway.tenderly.co"],
                 "first": dt.date(2022, 3, 12), "legacy_urls": ["https://mainnet.optimism.io"],
                 "bedrock": 105_235_063},
    "polygon": {"urls": ["https://polygon.drpc.org", "https://polygon.gateway.tenderly.co"],
                "first": dt.date(2022, 3, 12)},
    "avalanche": {"urls": ["https://api.avax.network/ext/bc/C/rpc", "https://avalanche.gateway.tenderly.co"],
                  "first": dt.date(2022, 3, 12)},
    "base": {"urls": ["https://mainnet.base.org", "https://base.gateway.tenderly.co", "https://base.drpc.org"],
             "first": dt.date(2023, 8, 8)},
}
V3_POOL = "0x794a61358D6845594F94dc1DB02A252b5b4814aD"
MARKETS = {
    "v2-eth-usdc": {"chain": "ethereum", "pool": "0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9", "v": 2,
                    "asset": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"},
    "v3-arb-usdce": {"chain": "arbitrum", "pool": V3_POOL, "v": 3, "asset": "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8"},
    "v3-arb-usdc": {"chain": "arbitrum", "pool": V3_POOL, "v": 3, "asset": "0xaf88d065e77c8cc2239327c5edb3a432268e5831"},
    "v3-op-usdce": {"chain": "optimism", "pool": V3_POOL, "v": 3, "asset": "0x7f5c764cbc14f9669b88837ca1490cca17c31607"},
    "v3-op-usdc": {"chain": "optimism", "pool": V3_POOL, "v": 3, "asset": "0x0b2c639c533813f4aa9d7837caf62653d097ff85"},
    "v3-poly-usdce": {"chain": "polygon", "pool": V3_POOL, "v": 3, "asset": "0x2791bca1f2de4661ed88a30c99a7a9449aa84174"},
    "v3-poly-usdc": {"chain": "polygon", "pool": V3_POOL, "v": 3, "asset": "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359"},
    "v3-avax-usdc": {"chain": "avalanche", "pool": V3_POOL, "v": 3, "asset": "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e"},
    "v3-base-usdc": {"chain": "base", "pool": "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5", "v": 3,
                     "asset": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"},
}

SIGS = {
    "getReserveData": "getReserveData(address)", "totalSupply": "totalSupply()", "balanceOf": "balanceOf(address)",
    "getVirtualUnderlyingBalance": "getVirtualUnderlyingBalance(address)",
    "v2_opt": "OPTIMAL_UTILIZATION_RATE()", "v2_base": "baseVariableBorrowRate()",
    "v2_s1": "variableRateSlope1()", "v2_s2": "variableRateSlope2()",
    "v3_opt": "OPTIMAL_USAGE_RATIO()", "v3_base": "getBaseVariableBorrowRate()",
    "v3_s1": "getVariableRateSlope1()", "v3_s2": "getVariableRateSlope2()",
    "getInterestRateData": "getInterestRateData(address)",
}
SEL = {k: B.keccak256(v.encode())[:4] for k, v in SIGS.items()}
# getReserveData layouts: V2 (12 words) and V3 / V3 legacy (15 words)
V2_RD = ("configuration", "liquidityIndex", "variableBorrowIndex", "currentLiquidityRate", "currentVariableBorrowRate",
         "currentStableBorrowRate", "lastUpdateTimestamp", "aToken", "sDebt", "vDebt", "strategy", "id")
V3_RD = ("configuration", "liquidityIndex", "currentLiquidityRate", "variableBorrowIndex", "currentVariableBorrowRate",
         "currentStableBorrowRate", "lastUpdateTimestamp", "id", "aToken", "sDebt", "vDebt", "strategy",
         "accruedToTreasury", "unbacked", "isolationModeTotalDebt")
ZERO = "0x" + "00" * 20


def cdata(name, *addrs):
    return "0x" + (SEL[name] + b"".join(B.enc_address(a) for a in addrs)).hex()


def utc(d: dt.date) -> int:
    return int(dt.datetime(d.year, d.month, d.day, tzinfo=dt.timezone.utc).timestamp())


def utcnow():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------------------------
# RPC client: batch JSON-RPC, endpoint rotation, backoff
# ---------------------------------------------------------------------------------------------
class Rpc:
    def __init__(self, urls, interval=0.15):
        self.urls = list(urls)
        self.interval = interval
        self.lock = threading.Lock()
        self.last = 0.0
        self.i = 0
        self.counts = {u: {"requests": 0, "calls": 0, "errors": 0} for u in self.urls}

    def _pace(self):
        with self.lock:
            now = time.monotonic()
            wait = self.last + self.interval - now
            self.last = max(now, self.last + self.interval)
        if wait > 0:
            time.sleep(wait)

    def batch(self, reqs, urls=None, tries=12):
        """reqs = [(method, params)] -> list of results (raises after tries). Errors inside a batch retry the batch."""
        urls = urls or self.urls
        payload = json.dumps([{"jsonrpc": "2.0", "id": i, "method": m, "params": p}
                              for i, (m, p) in enumerate(reqs)]).encode()
        err = None
        for k in range(tries):
            with self.lock:
                self.i += 1
                url = urls[self.i % len(urls)]
            self._pace()
            try:
                req = urllib.request.Request(url, data=payload, headers={"content-type": "application/json",
                                                                         "user-agent": UA})
                with urllib.request.urlopen(req, timeout=120) as r:
                    body = json.loads(r.read())
                with self.lock:
                    self.counts.setdefault(url, {"requests": 0, "calls": 0, "errors": 0})
                    self.counts[url]["requests"] += 1
                    self.counts[url]["calls"] += len(reqs)
                if not isinstance(body, list):
                    raise RuntimeError(f"non-list body {str(body)[:200]}")
                by = {x.get("id"): x for x in body}
                out = []
                for i in range(len(reqs)):
                    x = by.get(i)
                    if x is None:
                        raise RuntimeError("missing id")
                    if x.get("error"):
                        e = x["error"]
                        msg = str(e.get("message", e))
                        if "revert" in msg.lower() or "execution reverted" in msg.lower():
                            out.append(None)          # a call that reverts (e.g. getter absent) is data
                            continue
                        raise RuntimeError(msg[:200])
                    out.append(x["result"])
                return out
            except Exception as e:  # noqa: BLE001
                err = e
                with self.lock:
                    self.counts.setdefault(url, {"requests": 0, "calls": 0, "errors": 0})
                    self.counts[url]["errors"] += 1
                time.sleep(min(30, 1.5 * (k + 1)))
        raise RuntimeError(f"rpc failed after {tries}: {err}")


def block_ts(rpc, numbers, urls=None):
    res = rpc.batch([("eth_getBlockByNumber", [hex(n), False]) for n in numbers], urls)
    out = []
    for n, r in zip(numbers, res):
        if r is None:
            raise RuntimeError(f"no block {n}")
        out.append(int(r["timestamp"], 16))
    return out


def head(rpc):
    r = rpc.batch([("eth_getBlockByNumber", ["latest", False])])[0]
    return int(r["number"], 16), int(r["timestamp"], 16)


def find_before(T, get, lo, hi):
    """Largest b with ts(b) < T, given ts(lo) < T <= ts(hi). Interpolation with bisection safeguard."""
    tl, th = get(lo), get(hi)
    assert tl < T <= th, (lo, hi, tl, th, T)
    step = 0
    while hi - lo > 1:
        step += 1
        if th > tl and step % 3:
            p = lo + int((T - 1 - tl) * (hi - lo) / (th - tl))
            p = min(max(p, lo + 1), hi - 1)
        else:
            p = (lo + hi) // 2
        tp = get(p)
        if tp < T:
            lo, tl = p, tp
        else:
            hi, th = p, tp
    return lo, tl, th


# ---------------------------------------------------------------------------------------------
# blocks
# ---------------------------------------------------------------------------------------------
def jdump(path, obj):
    tmp = path + ".tmp"
    with gzip.open(tmp, "wt") as f:
        json.dump(obj, f, sort_keys=True)
    os.replace(tmp, path)


def jload(path, default=None):
    if not os.path.exists(path):
        return default
    with gzip.open(path, "rt") as f:
        return json.load(f)


def chain_urls(chain, block):
    c = CHAINS[chain]
    if chain == "optimism" and block < c["bedrock"]:
        return c["legacy_urls"]
    return c["urls"]


def phase_blocks(chain, work):
    c = CHAINS[chain]
    rpc = Rpc(c["urls"], interval=0.12)
    path = os.path.join(work, f"blocks-{chain}.json.gz")
    out = jload(path, {})
    hb, hts = head(rpc)
    cache = {}

    def get(n):
        if n not in cache:
            cache[n] = block_ts(rpc, [n], chain_urls(chain, n))[0]
        return cache[n]

    days = []
    d = c["first"]
    while d <= LAST_DAY:
        days.append(d)
        d += dt.timedelta(days=1)
    prev = None
    t0 = time.time()
    for k, d in enumerate(days):
        key = d.isoformat()
        T = utc(d)
        if key in out:
            prev = out[key]
            continue
        if prev is None:
            lo = c.get("min_block", 1)
            if get(lo) >= T:
                raise SystemExit(f"STOP: first readable block of {chain} is after {key}")
            hi = hb
        else:
            lo = prev[0]
            rate = None
            if k >= 2 and days[k - 2].isoformat() in out:
                rate = prev[0] - out[days[k - 2].isoformat()][0]
            span = int((rate or 1) * 1.05) + 10 if rate else hb - lo
            hi = min(hb, lo + span)
            while get(hi) < T:
                lo, hi = hi, min(hb, hi + span * 2)
        b, tb, tn = find_before(T, get, lo, hi)
        out[key] = [b, tb, tn]
        prev = out[key]
        if len(cache) > 5000:
            cache.clear()
        if k % 100 == 0:
            jdump(path, out)
            print(f"blocks {chain}: {key} b {b} ({time.time() - t0:.0f}s)", flush=True)
    jdump(path, out)
    print(f"blocks {chain}: done {len(out)} days; rpc {json.dumps(rpc.counts)}", flush=True)


# ---------------------------------------------------------------------------------------------
# daily
# ---------------------------------------------------------------------------------------------
def words(h):
    if h is None or h == "0x":
        return None
    raw = bytes.fromhex(h[2:])
    if len(raw) % 32:
        return None
    return [int.from_bytes(raw[i:i + 32], "big") for i in range(0, len(raw), 32)]


def one(h):
    w = words(h)
    return w[0] if w and len(w) == 1 else None


def decode_rd(h, v):
    w = words(h)
    names = V2_RD if v == 2 else V3_RD
    if not w or len(w) != len(names):
        return None
    rd = dict(zip(names, w))
    for k in ("aToken", "sDebt", "vDebt", "strategy"):
        rd[k] = B.word_to_address(rd[k])
    return rd


def read_curve(rpc, m, strategy, block, urls):
    eth = lambda name, *a: ("eth_call", [{"to": strategy, "data": cdata(name, *a)}, hex(block)])  # noqa: E731
    if m["v"] == 2:
        reqs = [eth("v2_opt"), eth("v2_base"), eth("v2_s1"), eth("v2_s2")]
    else:
        reqs = [eth("v3_opt"), eth("v3_base"), eth("v3_s1"), eth("v3_s2"), eth("getInterestRateData", m["asset"])]
    res = rpc.batch(reqs, urls)
    v1 = [one(x) for x in res[:4]]
    if all(x is not None for x in v1):
        return v1, ("v2pool" if m["v"] == 2 else "v1")
    if m["v"] == 3:
        w = words(res[4])
        if w and len(w) == 4:
            return w, "v2"
    return None, "none"


def read_day(rpc, m, block, urls):
    pool, asset = m["pool"], m["asset"]
    r = rpc.batch([("eth_call", [{"to": pool, "data": cdata("getReserveData", asset)}, hex(block)])], urls)[0]
    rd = decode_rd(r, m["v"])
    if rd is None or rd["aToken"] == ZERO:
        return {"listed": 0}
    calls = [("eth_call", [{"to": rd["vDebt"], "data": cdata("totalSupply")}, hex(block)]),
             ("eth_call", [{"to": asset, "data": cdata("balanceOf", rd["aToken"])}, hex(block)])]
    calls.append(("eth_call", [{"to": rd["sDebt"], "data": cdata("totalSupply")}, hex(block)])
                 if rd["sDebt"] != ZERO else ("eth_blockNumber", []))
    calls.append(("eth_call", [{"to": pool, "data": cdata("getVirtualUnderlyingBalance", asset)}, hex(block)])
                 if m["v"] == 3 else ("eth_blockNumber", []))
    res = rpc.batch(calls, urls)
    curve, abi = read_curve(rpc, m, rd["strategy"], block, urls)
    cfg = rd["configuration"]
    return {"listed": 1, "rate_ray": str(rd["currentVariableBorrowRate"]), "strategy": rd["strategy"],
            "vdebt": str(one(res[0])), "cash": str(one(res[1])),
            "sdebt": str(one(res[2]) if rd["sDebt"] != ZERO else 0),
            "virtual": (str(one(res[3])) if (m["v"] == 3 and one(res[3]) is not None) else None),
            "curve": None if curve is None else [str(x) for x in curve], "curve_abi": abi,
            "active": (cfg >> 56) & 1, "frozen": (cfg >> 57) & 1, "rf_bps": (cfg >> 64) & 0xFFFF,
            "last_update": rd["lastUpdateTimestamp"]}


def phase_daily(market, work):
    m = MARKETS[market]
    chain = m["chain"]
    blocks = jload(os.path.join(work, f"blocks-{chain}.json.gz"))
    if not blocks:
        raise SystemExit("STOP: run blocks first")
    rpc = Rpc(CHAINS[chain]["urls"], interval=0.12)
    path = os.path.join(work, f"daily-{market}.json.gz")
    out = jload(path, {})
    todo = [k for k in sorted(blocks) if k not in out]
    lock = threading.Lock()
    done = [0]
    t0 = time.time()

    failed = []

    def job(k):
        b = blocks[k][0]
        try:
            r = read_day(rpc, m, b, chain_urls(chain, b))
        except RuntimeError as e:          # flaky endpoint: leave the day for the next (resuming) run
            with lock:
                failed.append(k)
            print(f"daily {market}: {k} failed ({str(e)[:80]}); retry on the next run", flush=True)
            return
        r["block"], r["block_ts"] = b, blocks[k][1]
        with lock:
            out[k] = r
            done[0] += 1
            if done[0] % 100 == 0:
                jdump(path, out)
                print(f"daily {market}: {done[0]}/{len(todo)} ({time.time() - t0:.0f}s)", flush=True)

    with ThreadPoolExecutor(4) as ex:
        list(ex.map(job, todo))
    jdump(path, out)
    with open(os.path.join(work, f"rpc-daily-{market}.json"), "w") as f:
        json.dump(rpc.counts, f)
    if failed:
        print(f"daily {market}: INCOMPLETE {len(failed)} days failed; rerun to resume", flush=True)
    print(f"daily {market}: done {len(out)}; rpc {json.dumps(rpc.counts)}", flush=True)


# ---------------------------------------------------------------------------------------------
# hours: curve-change hour (M3)
# ---------------------------------------------------------------------------------------------
def curve_at(rpc, m, block, urls):
    r = rpc.batch([("eth_call", [{"to": m["pool"], "data": cdata("getReserveData", m["asset"])}, hex(block)])], urls)[0]
    rd = decode_rd(r, m["v"])
    if rd is None or rd["aToken"] == ZERO:
        return None
    c, _ = read_curve(rpc, m, rd["strategy"], block, urls)
    return None if c is None else [str(x) for x in c]


def phase_hours(market, work):
    m = MARKETS[market]
    chain = m["chain"]
    blocks = jload(os.path.join(work, f"blocks-{chain}.json.gz"))
    daily = jload(os.path.join(work, f"daily-{market}.json.gz"))
    rpc = Rpc(CHAINS[chain]["urls"], interval=0.12)
    path = os.path.join(work, f"hours-{market}.json.gz")
    out = jload(path, {})
    keys = sorted(k for k in daily if daily[k].get("listed") and daily[k].get("curve"))
    changes = [(a, b) for a, b in zip(keys, keys[1:])
               if daily[a]["curve"] != daily[b]["curve"]
               and dt.date.fromisoformat(b) - dt.date.fromisoformat(a) == dt.timedelta(days=1)]
    cache = {}

    def get(n):
        if n not in cache:
            cache[n] = block_ts(rpc, [n], chain_urls(chain, n))[0]
        return cache[n]

    for a, b in changes:
        if b in out:
            continue
        old = daily[a]["curve"]
        D = dt.date.fromisoformat(b)
        lo_b, hi_b = blocks[a][0], blocks[b][0]
        hour_blocks = {}

        def hb(k):   # last block before (D - 1 day) + k hours, k = 1..24 (k = 24 is b_d itself)
            if k == 24:
                return hi_b, blocks[b][1]
            if k not in hour_blocks:
                T = utc(D) - 86400 + 3600 * k
                bb, tb, _ = find_before(T, get, lo_b, hi_b + 1)
                hour_blocks[k] = (bb, tb)
            return hour_blocks[k]

        lo, hi = 0, 24        # curve at hour 0 (= b_{d-1}) is old, at 24 is new
        while hi - lo > 1:
            mid = (lo + hi) // 2
            cm = curve_at(rpc, m, hb(mid)[0], chain_urls(chain, hb(mid)[0]))
            if cm == old:
                lo = mid
            else:
                hi = mid
        bb, tb = hb(hi)
        out[b] = {"first_new_hour_k": hi, "block": bb, "block_ts": tb}
        jdump(path, out)
    jdump(path, out)
    print(f"hours {market}: {len(changes)} day-level curve changes; rpc {json.dumps(rpc.counts)}", flush=True)


# ---------------------------------------------------------------------------------------------
# export (address-free)
# ---------------------------------------------------------------------------------------------
def sha256_file(p):
    with open(p, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def phase_export(work, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    counts = {}
    for market, m in MARKETS.items():
        daily = jload(os.path.join(work, f"daily-{market}.json.gz"))
        hours = jload(os.path.join(work, f"hours-{market}.json.gz"), {})
        if not daily:
            counts[market] = {"status": "missing"}
            continue
        strat_ids = {}
        rows = []
        for k in sorted(daily):
            r = daily[k]
            if not r.get("listed"):
                continue
            sid = strat_ids.setdefault(r["strategy"], len(strat_ids))
            c = r["curve"] or [None] * 4
            rows.append({"date": k, "block": r["block"], "block_ts": r["block_ts"], "rate_ray": r["rate_ray"],
                         "variable_debt_raw": r["vdebt"], "stable_debt_raw": r["sdebt"], "cash_balance_raw": r["cash"],
                         "virtual_balance_raw": r["virtual"] if r["virtual"] is not None else "",
                         "optimal_usage_ray": c[0], "base_rate_ray": c[1], "slope1_ray": c[2], "slope2_ray": c[3],
                         "curve_abi": r["curve_abi"], "strategy_idx": sid, "active": r["active"],
                         "frozen": r["frozen"], "reserve_factor_bps": r["rf_bps"]})
        p = os.path.join(out_dir, f"daily-{market}.csv.gz")
        with gzip.open(p, "wt", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)
        hp = os.path.join(out_dir, f"curve-changes-{market}.csv")
        with open(hp, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["day", "first_new_hour_k", "block", "block_ts"])
            for k in sorted(hours):
                w.writerow([k, hours[k]["first_new_hour_k"], hours[k]["block"], hours[k]["block_ts"]])
        bad = []      # usage outside (0, 1): R10.3's logit is undefined there (counts only, no outcome)
        n_debt = 0
        for r in rows:
            debt = int(r["variable_debt_raw"]) + int(r["stable_debt_raw"] if r["stable_debt_raw"] != "None" else 0)
            avail = int(r["virtual_balance_raw"]) if r["virtual_balance_raw"] != "" else int(r["cash_balance_raw"])
            n_debt += debt >= 1_000_000 * 10 ** 6
            if not (debt > 0 and avail > 0):
                bad.append(r["date"])
        dates = [dt.date.fromisoformat(r["date"]) for r in rows]
        gaps = sum(1 for a, b in zip(dates, dates[1:]) if (b - a).days != 1)
        counts[market] = {"days": len(rows), "first": rows[0]["date"], "last": rows[-1]["date"], "gaps": gaps,
                          "curve_missing": sum(1 for r in rows if r["optimal_usage_ray"] is None),
                          "curve_changes": len(hours), "strategies": len(strat_ids),
                          "stable_debt_days": sum(1 for r in rows if r["stable_debt_raw"] not in ("0", "None")),
                          "virtual_days": sum(1 for r in rows if r["virtual_balance_raw"] != ""),
                          "usage_outside_open_unit_days": len(bad), "usage_outside_last_day": bad[-1] if bad else None,
                          "days_debt_ge_1m_usdc": n_debt,
                          "sha256_daily": sha256_file(p), "sha256_curve_changes": sha256_file(hp)}
    for name in os.listdir(out_dir):
        fp = os.path.join(out_dir, name)
        data = gzip.open(fp, "rt").read() if name.endswith(".gz") else open(fp).read()
        if ADDR_RE.search(data):
            raise SystemExit(f"STOP: address-like string in {name}")
    with open(os.path.join(out_dir, "acquire-counts.json"), "w") as f:
        json.dump({"created_utc": utcnow(), "markets": counts}, f, indent=1)
    print(json.dumps(counts, indent=1))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["blocks", "daily", "hours", "export"])
    ap.add_argument("--chain")
    ap.add_argument("--market")
    ap.add_argument("--work", required=True)
    ap.add_argument("--out")
    a = ap.parse_args()
    os.makedirs(a.work, exist_ok=True)
    print(f"start {utcnow()} {a.cmd} {a.chain or a.market or ''}", flush=True)
    if a.cmd == "blocks":
        phase_blocks(a.chain, a.work)
    elif a.cmd == "daily":
        phase_daily(a.market, a.work)
    elif a.cmd == "hours":
        phase_hours(a.market, a.work)
    else:
        phase_export(a.work, a.out)
    print(f"end {utcnow()}", flush=True)


if __name__ == "__main__":
    main()
