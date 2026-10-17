"""Q26 R10.1 input acquisition (membrane-board design/Q26_ROUND10_PREREG.md, Data section). Inputs only:
no outcome, count or score is computed here.

Phases (run in order; each resumes from its checkpoint files in --work):

  python3 r10_acquire.py index     --work DIR   hour -> b_h from the held USDC RDU logs (+ block -> ts map)
  python3 r10_acquire.py meta      --work DIR   daily anchor block, reserve list/config/tokens/prices/indexes, e-mode
  python3 r10_acquire.py hourly    --work DIR   one Multicall3 read per b_h (USDC curve inputs, prices, indexes)
  python3 r10_acquire.py logs      --work DIR   Core Pool action logs (selects which accounts are re-read daily)
  python3 r10_acquire.py positions --work DIR   daily USDC-debt account states

Free keyless sources only: archive eth_call (Multicall3) on eth.drpc.org and rpc.mevblocker.io, eth_getLogs on
rpc.mevblocker.io. Addresses stay inside --work (never published). Published files map accounts to integer ids and
reserves to symbols.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import gzip
import io
import json
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import b_acquire as B  # noqa: E402
from c1_baddebt import chain as C  # noqa: E402

DATASETS = os.environ.get("MEMBRANE_DATASETS_DIR", os.path.join(HERE, "..", "..", "..", "..", "membrane-datasets"))
POOL = B.POOL.lower()
ORACLE = C.ORACLE.lower()
USDC = C.USDC
URLS = ("https://eth.drpc.org", "https://rpc.mevblocker.io")
FIRST_DAY = dt.date(2023, 2, 1)
LAST_DAY = dt.date(2026, 10, 12)            # last replay day (inclusive)
HOUR_START = int(dt.datetime(2023, 2, 1, tzinfo=dt.timezone.utc).timestamp())
HOUR_END = int(dt.datetime(2026, 10, 13, tzinfo=dt.timezone.utc).timestamp())   # exclusive
LAST_BLOCK = 26_186_746
POOL_DEPLOY_BLOCK = 16_291_127
SCAN_EVERY = 7
ACCTS_PER_CALL = 100

SIG = {
    "getReservesList": "getReservesList()",
    "getReserveData": "getReserveData(address)",
    "getConfiguration": "getConfiguration(address)",
    "getAssetPrice": "getAssetPrice(address)",
    "getReserveNormalizedIncome": "getReserveNormalizedIncome(address)",
    "getReserveNormalizedVariableDebt": "getReserveNormalizedVariableDebt(address)",
    "getVirtualUnderlyingBalance": "getVirtualUnderlyingBalance(address)",
    "getReserveDeficit": "getReserveDeficit(address)",
    "getAverageStableRate": "getAverageStableRate()",
    "totalSupply": "totalSupply()",
    "balanceOf": "balanceOf(address)",
    "symbol": "symbol()",
    "OPTIMAL_USAGE_RATIO": "OPTIMAL_USAGE_RATIO()",
    "getBaseVariableBorrowRate": "getBaseVariableBorrowRate()",
    "getVariableRateSlope1": "getVariableRateSlope1()",
    "getVariableRateSlope2": "getVariableRateSlope2()",
    "getInterestRateData": "getInterestRateData(address)",
    "getEModeCategoryData": "getEModeCategoryData(uint8)",
    "getEModeCategoryCollateralConfig": "getEModeCategoryCollateralConfig(uint8)",
    "getEModeCategoryCollateralBitmap": "getEModeCategoryCollateralBitmap(uint8)",
    "getUserAccountData": "getUserAccountData(address)",
    "getUserEMode": "getUserEMode(address)",
    "getUserConfiguration": "getUserConfiguration(address)",
}
SEL = {k: B.selector(v) for k, v in SIG.items()}
V1 = ("OPTIMAL_USAGE_RATIO", "getBaseVariableBorrowRate", "getVariableRateSlope1", "getVariableRateSlope2")
EMODE_IDS = range(1, 101)

EVENTS = {
    "Supply": "Supply(address,address,address,uint256,uint16)",            # topics: reserve, onBehalfOf, referral
    "Withdraw": "Withdraw(address,address,address,uint256)",               # topics: reserve, user, to
    "LiquidationCall": "LiquidationCall(address,address,address,uint256,uint256,address,bool)",  # coll, debt, user
    "ReserveUsedAsCollateralEnabled": "ReserveUsedAsCollateralEnabled(address,address)",       # reserve, user
    "ReserveUsedAsCollateralDisabled": "ReserveUsedAsCollateralDisabled(address,address)",     # reserve, user
    "UserEModeSet": "UserEModeSet(address,uint8)",                          # user
}
USER_TOPIC = {"Supply": 2, "Withdraw": 2, "LiquidationCall": 3, "ReserveUsedAsCollateralEnabled": 2,
              "ReserveUsedAsCollateralDisabled": 2, "UserEModeSet": 1}


def topic0(sig: str) -> str:
    return "0x" + B.keccak256(sig.encode()).hex()


def cd(name: str, *args) -> bytes:
    out = SEL[name]
    for a in args:
        out += B.enc_address(a) if isinstance(a, str) else int(a).to_bytes(32, "big")
    return out


def u(ok_ret) -> int | None:
    ok, r = ok_ret
    if not ok or len(r) < 32:
        return None
    return int.from_bytes(r[:32], "big")


def addr_word(ok_ret) -> str | None:
    v = u(ok_ret)
    return None if v is None else "0x" + format(v, "040x")


# ---------------------------------------------------------------------------------------------
# RPC pool: one paced client per endpoint, round-robin across threads
# ---------------------------------------------------------------------------------------------

class Pool:
    def __init__(self, interval: float = 0.08):
        self.clients = [B.Rpc(url, None, interval=interval, retry_wait=8, max_retries=10) for url in URLS]
        self.i = 0
        self.lock = threading.Lock()

    def pick(self) -> B.Rpc:
        with self.lock:
            self.i += 1
            return self.clients[self.i % len(self.clients)]

    def multicall(self, calls, block, phase):
        out = []
        for s in range(0, len(calls), 1000):
            out.extend(self.pick().multicall(calls[s:s + 1000], block, phase))
        return out

    def counts(self):
        return [c.counts for c in self.clients]


def jdump(path, obj):
    tmp = path + ".tmp"
    with gzip.open(tmp, "wt") as f:
        json.dump(obj, f, sort_keys=True)
    os.replace(tmp, path)


def jload(path):
    with gzip.open(path, "rt") as f:
        return json.load(f)


def day_list():
    d, out = FIRST_DAY, []
    while d <= LAST_DAY + dt.timedelta(days=1):   # anchor of LAST_DAY + 1 closes the last replay day
        out.append(d)
        d += dt.timedelta(days=1)
    return out


def utc(d: dt.date) -> int:
    return int(dt.datetime(d.year, d.month, d.day, tzinfo=dt.timezone.utc).timestamp())


# ---------------------------------------------------------------------------------------------
# index: hour -> b_h from the held RDU logs
# ---------------------------------------------------------------------------------------------

def rdu_rows():
    parts = sorted(p for p in os.listdir(os.path.join(DATASETS, "aave-pool-cash")) if p.startswith("raw-logs-rdu.csv.gz.part"))
    data = b"".join(open(os.path.join(DATASETS, "aave-pool-cash", p), "rb").read() for p in parts)
    with gzip.open(io.BytesIO(data), "rt") as f:
        for row in csv.DictReader(f):
            yield row


def phase_index(work):
    last_in_block = {}
    block_ts = {}
    for r in rdu_rows():
        b, ts = int(r["block"]), int(r["ts"])
        key = (int(r["tx_index"]), int(r["log_index"]))
        block_ts[b] = ts
        if b not in last_in_block or key > last_in_block[b][0]:
            last_in_block[b] = (key, r["data"])
    hours = {}
    for b, ts in block_ts.items():
        h = ts // 3600 * 3600
        if HOUR_START <= h < HOUR_END and (h not in hours or b > hours[h]):
            hours[h] = b
    out = []
    for h in sorted(hours):
        b = hours[h]
        w = [int(last_in_block[b][1][2 + 64 * i: 2 + 64 * (i + 1)], 16) for i in range(5)]
        out.append({"hour": h, "block": b, "ts": block_ts[b], "liquidityRate": str(w[0]),
                    "stableBorrowRate": str(w[1]), "variableBorrowRate": str(w[2]),
                    "liquidityIndex": str(w[3]), "variableBorrowIndex": str(w[4])})
    jdump(os.path.join(work, "hours.json.gz"), out)
    bts = sorted(block_ts.items())
    jdump(os.path.join(work, "rdu-block-ts.json.gz"), {"block": [b for b, _ in bts], "ts": [t for _, t in bts]})
    n_all = (HOUR_END - HOUR_START) // 3600
    print(f"index: {len(out)} of {n_all} hours have a USDC RDU block; {len(bts)} RDU blocks", flush=True)


# ---------------------------------------------------------------------------------------------
# meta: daily anchors
# ---------------------------------------------------------------------------------------------

def anchor_blocks(pool: Pool, work: str) -> dict:
    path = os.path.join(work, "anchors.json.gz")
    if os.path.exists(path):
        return jload(path)
    known = {}
    with open(os.path.join(DATASETS, "depositor-balances", "blocks.csv")) as f:
        for r in csv.DictReader(f):
            if r["kind"] == "daily" and r["proof"] == "ok":
                known[r["snapshot"]] = int(r["block"])
    rpc = pool.clients[0]
    out = {}
    prev = None
    for d in day_list():
        k = d.isoformat()
        if k in known:
            out[k] = known[k]
        else:
            b, _, _ = B.find_block_before(utc(d), rpc.block_ts, (prev or 26_000_000) + 7200, lo=prev)
            out[k] = b
        prev = out[k]
    jdump(path, out)
    return out


def emode_read(pool, block):
    calls = []
    for c in EMODE_IDS:
        calls += [(POOL, cd("getEModeCategoryCollateralConfig", c)), (POOL, cd("getEModeCategoryCollateralBitmap", c)),
                  (POOL, cd("getEModeCategoryData", c))]
    res = pool.multicall(calls, block, "emode")
    out = {}
    for j, c in enumerate(EMODE_IDS):
        r1, r2, r3 = res[3 * j], res[3 * j + 1], res[3 * j + 2]
        if r1[0] and len(r1[1]) == 96 and r2[0]:
            w = B.decode_words(r1[1])
            if w[1] > 0:
                out[str(c)] = {"layout": "v32", "ltv": w[0], "lt": w[1], "lb": w[2], "bitmap": u(r2), "price_source": None}
        elif r3[0] and len(r3[1]) >= 160:
            w = B.decode_words(r3[1][:32 * 5]) if len(r3[1]) >= 160 else []
            # the legacy struct (ltv, lt, lb, priceSource, label) holds a string: the return starts with a tuple offset
            if w and w[0] == 32:
                w = w[1:]
            if len(w) >= 4 and w[1] > 0:
                out[str(c)] = {"layout": "legacy", "ltv": w[0], "lt": w[1], "lb": w[2], "bitmap": None,
                               "price_source": int(w[3] != 0)}
    return out


def phase_meta(work):
    pool = Pool()
    anchors = anchor_blocks(pool, work)
    mdir = os.path.join(work, "meta")
    os.makedirs(mdir, exist_ok=True)
    symbols_path = os.path.join(work, "symbols.json.gz")
    symbols = jload(symbols_path) if os.path.exists(symbols_path) else {}

    def one(k):
        path = os.path.join(mdir, f"{k}.json.gz")
        if os.path.exists(path):
            return
        block = anchors[k]
        lst = pool.multicall([(POOL, cd("getReservesList"))], block, "meta")[0]
        words = B.decode_words(lst[1])
        assets = ["0x" + format(x, "040x") for x in words[2:2 + words[1]]]
        calls = []
        for a in assets:
            calls += [(POOL, cd("getReserveData", a)), (POOL, cd("getConfiguration", a)), (ORACLE, cd("getAssetPrice", a)),
                      (POOL, cd("getReserveNormalizedIncome", a)), (POOL, cd("getReserveNormalizedVariableDebt", a))]
        calls += [(POOL, cd("getVirtualUnderlyingBalance", USDC)), (POOL, cd("getReserveDeficit", USDC))]
        res = pool.multicall(calls, block, "meta")
        R = {}
        for j, a in enumerate(assets):
            rd = B.decode_reserve_data(*res[5 * j])
            if rd["status"] != "ok":
                raise RuntimeError(f"getReserveData {a} at {block}: {rd['status']}")
            conf = u(res[5 * j + 1])
            R[a] = {"id": rd["id"], "aToken": rd["aTokenAddress"].lower(), "vDebt": rd["variableDebtTokenAddress"].lower(),
                    "sDebt": rd["stableDebtTokenAddress"].lower(), "strategy": rd["interestRateStrategyAddress"].lower(),
                    "config": str(conf), "price": u(res[5 * j + 2]), "income": str(u(res[5 * j + 3])),
                    "vindex": str(u(res[5 * j + 4]))}
        n = 5 * len(assets)
        meta = {"date": k, "block": block, "ts": None, "assets": assets, "reserves": R,
                "virtual_balance_ok": bool(res[n][0] and len(res[n][1]) == 32),
                "v33": bool(res[n + 1][0] and len(res[n + 1][1]) == 32)}
        # stable debt totals (to know whether stable balances must be read) and symbols for new assets
        calls = []
        for a in assets:
            s = R[a]["sDebt"]
            calls.append((s, cd("totalSupply")) if s != B.ZERO_ADDRESS else (POOL, cd("getReservesList")))
        res = pool.multicall(calls, block, "meta")
        for a, r in zip(assets, res):
            R[a]["sDebtTotal"] = str(u(r) or 0) if R[a]["sDebt"] != B.ZERO_ADDRESS else "0"
        meta["emode"] = emode_read(pool, block)
        meta["ts"] = pool.pick().block_ts(block)
        jdump(path, meta)

    keys = list(anchors)
    with ThreadPoolExecutor(6) as ex:
        list(ex.map(one, keys))
    # symbols (published names)
    allassets = set()
    for k in keys:
        allassets.update(jload(os.path.join(mdir, f"{k}.json.gz"))["assets"])
    need = sorted(a for a in allassets if a not in symbols)
    if need:
        res = pool.multicall([(a, cd("symbol")) for a in need], LAST_BLOCK, "symbols")
        for a, (ok, r) in zip(need, res):
            name = None
            if ok and len(r) >= 96:
                ln = int.from_bytes(r[32:64], "big")
                name = r[64:64 + ln].decode("utf-8", "replace")
            elif ok and len(r) == 32:
                name = r.rstrip(b"\x00").decode("utf-8", "replace")
            symbols[a] = name or f"asset-{len(symbols):02d}"
        jdump(symbols_path, symbols)
    print(f"meta: {len(keys)} anchors; {len(symbols)} reserves; rpc {pool.counts()}", flush=True)


def load_meta(work):
    anchors = jload(os.path.join(work, "anchors.json.gz"))
    return {k: jload(os.path.join(work, "meta", f"{k}.json.gz")) for k in anchors}


# ---------------------------------------------------------------------------------------------
# hourly
# ---------------------------------------------------------------------------------------------

def hourly_calls(m, strategy):
    R = m["reserves"]
    usd = R[USDC]
    calls = [(POOL, cd("getReserveData", USDC)), (usd["vDebt"], cd("totalSupply")), (usd["aToken"], cd("totalSupply")),
             (USDC, cd("balanceOf", usd["aToken"])), (POOL, cd("getVirtualUnderlyingBalance", USDC))]
    if usd["sDebt"] != B.ZERO_ADDRESS:
        calls += [(usd["sDebt"], cd("totalSupply")), (usd["sDebt"], cd("getAverageStableRate"))]
    else:
        calls += [(POOL, cd("getReservesList")), (POOL, cd("getReservesList"))]
    calls += [(strategy, cd(n)) for n in V1] + [(strategy, cd("getInterestRateData", USDC))]
    for a in m["assets"]:
        calls += [(ORACLE, cd("getAssetPrice", a)), (POOL, cd("getReserveNormalizedIncome", a)),
                  (POOL, cd("getReserveNormalizedVariableDebt", a))]
    return calls


def decode_hourly(m, res, has_stable):
    rd = B.decode_reserve_data(*res[0])
    if rd["status"] != "ok":
        raise RuntimeError("hourly getReserveData")
    out = {"strategy": rd["interestRateStrategyAddress"].lower(), "config": str(rd["configuration"]),
           "unbacked": str(rd["unbacked"]), "rd_variableBorrowRate": str(rd["currentVariableBorrowRate"]),
           "rd_liquidityRate": str(rd["currentLiquidityRate"]),
           "vDebtTotal": str(u(res[1])), "aTotal": str(u(res[2])), "cashBalance": str(u(res[3])),
           "virtualBalance": (str(u(res[4])) if res[4][0] and len(res[4][1]) == 32 else None)}
    if has_stable:
        out["sDebtTotal"] = str(u(res[5]) or 0) if res[5][0] else "0"
        out["avgStableRate"] = str(u(res[6]) or 0) if res[6][0] else "0"
    else:
        out["sDebtTotal"], out["avgStableRate"] = "0", "0"
    v1 = res[7:11]
    v2 = res[11]
    out["curve_v1"] = [str(u(x)) for x in v1] if all(x[0] and len(x[1]) == 32 for x in v1) else None
    out["curve_v2"] = [str(w) for w in B.decode_words(v2[1])] if v2[0] and len(v2[1]) == 128 else None
    px, inc, vix = [], [], []
    for j in range(len(m["assets"])):
        b = 12 + 3 * j
        px.append(u(res[b]))
        inc.append(str(u(res[b + 1])))
        vix.append(str(u(res[b + 2])))
    out["prices"], out["income"], out["vindex"] = px, inc, vix
    return out


def phase_hourly(work):
    pool = Pool()
    hours = jload(os.path.join(work, "hours.json.gz"))
    metas = load_meta(work)
    days = sorted(metas)
    hdir = os.path.join(work, "hourly")
    os.makedirs(hdir, exist_ok=True)
    by_day = {}
    for h in hours:
        d = dt.datetime.fromtimestamp(h["hour"], dt.timezone.utc).date().isoformat()
        by_day.setdefault(d, []).append(h)

    def one_day(d):
        path = os.path.join(hdir, f"{d}.json.gz")
        if os.path.exists(path) or d not in by_day:
            return
        m = metas[d]
        has_stable = m["reserves"][USDC]["sDebt"] != B.ZERO_ADDRESS
        rows = []
        for h in by_day[d]:
            strat = m["reserves"][USDC]["strategy"]
            res = pool.pick().multicall(hourly_calls(m, strat), h["block"], "hourly")
            out = decode_hourly(m, res, has_stable)
            if out["strategy"] != strat:   # strategy replaced during the day: read the curve at the new address
                res = pool.pick().multicall(hourly_calls(m, out["strategy"]), h["block"], "hourly")
                out = decode_hourly(m, res, has_stable)
            out["hour"], out["block"] = h["hour"], h["block"]
            rows.append(out)
        jdump(path, {"date": d, "assets": m["assets"], "rows": rows})

    t0 = time.time()
    todo = [d for d in days if d in by_day]
    done = [0]

    def wrap(d):
        one_day(d)
        done[0] += 1
        if done[0] % 50 == 0:
            print(f"hourly: {done[0]}/{len(todo)} days, {time.time() - t0:.0f}s", flush=True)

    with ThreadPoolExecutor(8) as ex:
        list(ex.map(wrap, todo))
    print(f"hourly: done; rpc {pool.counts()}", flush=True)


# ---------------------------------------------------------------------------------------------
# logs
# ---------------------------------------------------------------------------------------------

def phase_logs(work):
    path = os.path.join(work, "action-users.json.gz")
    if os.path.exists(path):
        return
    t0s = {topic0(s): n for n, s in EVENTS.items()}
    tmp = os.path.join(work, "logs-parts")
    os.makedirs(tmp, exist_ok=True)
    step = 250_000
    ranges = [(a, min(a + step - 1, LAST_BLOCK)) for a in range(POOL_DEPLOY_BLOCK, LAST_BLOCK + 1, step)]

    def one(rg):
        p = os.path.join(tmp, f"{rg[0]}.json.gz")
        if os.path.exists(p):
            return
        lgs = C.get_logs(POOL, [list(t0s)], rg[0], rg[1], step=50_000, pause=0.2)
        rows = [[lg["block"], t0s[lg["topics"][0]], C.topic_addr(lg["topics"][USER_TOPIC[t0s[lg["topics"][0]]]])]
                for lg in lgs]
        jdump(p, rows)
        print(f"logs: {rg} {len(rows)}", flush=True)

    with ThreadPoolExecutor(3) as ex:
        list(ex.map(one, ranges))
    rows = []
    for rg in ranges:
        rows.extend(jload(os.path.join(tmp, f"{rg[0]}.json.gz")))
    counts = {}
    for r in rows:
        counts[r[1]] = counts.get(r[1], 0) + 1
    jdump(path, {"rows": rows, "counts": counts, "to_block": LAST_BLOCK})
    print(f"logs: {len(rows)} action logs {counts}", flush=True)


# ---------------------------------------------------------------------------------------------
# positions
# ---------------------------------------------------------------------------------------------

def borrow_files():
    return ["aave-pool-debt/borrow-events-core-pre-2023.csv.gz"] + [
        f"aave-pool-borrows/borrow-events-core-{y}.csv.gz" for y in (2023, 2024, 2025, 2026)]


def repay_files():
    return [f"aave-pool-debt/repay-events-core-{y}.csv.gz" for y in (2023, 2024, 2025, 2026)]


def read_accounts(pool, block, m, users):
    """Pass 1: account data, e-mode, configuration. Pass 2: balances of flagged reserves."""
    R = m["reserves"]
    by_id = {R[a]["id"]: a for a in m["assets"]}
    out = {}
    jobs = [users[i:i + ACCTS_PER_CALL] for i in range(0, len(users), ACCTS_PER_CALL)]

    def p1(chunk):
        calls = []
        for x in chunk:
            calls += [(POOL, cd("getUserAccountData", x)), (POOL, cd("getUserEMode", x)), (POOL, cd("getUserConfiguration", x))]
        res = pool.pick().multicall(calls, block, "acct1")
        got = {}
        for j, x in enumerate(chunk):
            a, e, c = res[3 * j], res[3 * j + 1], res[3 * j + 2]
            if not (a[0] and e[0] and c[0]):
                raise RuntimeError(f"account read failed at {block}")
            w = B.decode_words(a[1])
            got[x] = {"tc": w[0], "td": w[1], "lt": w[3], "hf": str(w[5]), "emode": u(e), "config": u(c)}
        return got

    with ThreadPoolExecutor(8) as ex:
        for g in ex.map(p1, jobs):
            out.update(g)
    calls, keys = [], []
    for x in users:
        cfg = out[x]["config"]
        for rid, a in by_id.items():
            borrowing, coll = bool((cfg >> (2 * rid)) & 1), bool((cfg >> (2 * rid + 1)) & 1)
            if coll:
                calls.append((R[a]["aToken"], cd("balanceOf", x)))
                keys.append((x, a, "a"))
            if borrowing:
                calls.append((R[a]["vDebt"], cd("balanceOf", x)))
                keys.append((x, a, "v"))
                if int(R[a]["sDebtTotal"]) > 0:
                    calls.append((R[a]["sDebt"], cd("balanceOf", x)))
                    keys.append((x, a, "s"))
    chunks = [list(range(i, min(i + 1000, len(calls)))) for i in range(0, len(calls), 1000)]

    def p2(idx):
        return idx, pool.pick().multicall([calls[i] for i in idx], block, "acct2")

    with ThreadPoolExecutor(8) as ex:
        for idx, res in ex.map(p2, chunks):
            for i, r in zip(idx, res):
                x, a, kind = keys[i]
                v = u(r) or 0
                if v:
                    out[x].setdefault("bal", {}).setdefault(a, {})[kind] = str(v)
    for x in users:
        out[x]["config"] = str(out[x]["config"])
        out[x].setdefault("bal", {})
    return out


def usdc_debt(acc):
    b = acc["bal"].get(USDC, {})
    return int(b.get("v", 0)) + int(b.get("s", 0))


def phase_positions(work):
    pool = Pool()
    metas = load_meta(work)
    days = sorted(metas)
    pdir = os.path.join(work, "positions")
    os.makedirs(pdir, exist_ok=True)
    # first USDC borrow block per account; daily action users (Borrow/Repay held, other Pool actions acquired)
    first_borrow = {}
    usdc_borrow_day = {}   # day index -> accounts with a USDC Borrow in (anchor[i-1], anchor[i]]
    act = {}
    anchors = [metas[d]["block"] for d in days]

    import bisect

    def day_of_block(b):
        i = bisect.bisect_left(anchors, b)   # action in (anchor[i-1], anchor[i]] triggers a re-read at day i
        return i

    for rel in borrow_files():
        with gzip.open(os.path.join(DATASETS, rel), "rt") as f:
            for r in csv.DictReader(f):
                b, who = int(r["block"]), r["onBehalfOf"].lower()
                if r["reserve"].lower() == USDC:
                    if who not in first_borrow or b < first_borrow[who]:
                        first_borrow[who] = b
                    usdc_borrow_day.setdefault(day_of_block(b), set()).add(who)
                act.setdefault(day_of_block(b), set()).add(who)
    for rel in repay_files():
        with gzip.open(os.path.join(DATASETS, rel), "rt") as f:
            for r in csv.DictReader(f):
                act.setdefault(day_of_block(int(r["block"])), set()).add(r["user"].lower())
    for b, _, who in jload(os.path.join(work, "action-users.json.gz"))["rows"]:
        act.setdefault(day_of_block(b), set()).add(who)
    borrowers_sorted = sorted(first_borrow.items(), key=lambda kv: kv[1])

    state_path = os.path.join(work, "positions-state.json.gz")
    st = jload(state_path) if os.path.exists(state_path) else {"done": [], "universe": [], "ids": {}}
    universe = set(st["universe"])
    ids = st["ids"]

    def ident(x):
        if x not in ids:
            ids[x] = len(ids)
        return ids[x]
    t0 = time.time()
    for i, d in enumerate(days):
        if d in st["done"]:
            continue
        m = metas[d]
        block = m["block"]
        scan = (i % SCAN_EVERY == 0)
        # any USDC borrower of the last 24 h is read (first-time borrowers and borrowers outside the universe)
        new_b = usdc_borrow_day.get(i, set())
        if scan:
            cands = [x for x, b in borrowers_sorted if b <= block]
            usd = m["reserves"][USDC]
            calls = [(usd["vDebt"], cd("balanceOf", x)) for x in cands]
            stable = int(usd["sDebtTotal"]) > 0
            if stable:
                calls += [(usd["sDebt"], cd("balanceOf", x)) for x in cands]
            chunks = [list(range(s, min(s + 1000, len(calls)))) for s in range(0, len(calls), 1000)]
            bal = [0] * len(cands)

            def sc(idx):
                return idx, pool.pick().multicall([calls[j] for j in idx], block, "scan")

            with ThreadPoolExecutor(8) as ex:
                for idx, res in ex.map(sc, chunks):
                    for j, r in zip(idx, res):
                        bal[j % len(cands)] += u(r) or 0
            universe = {x for x, v in zip(cands, bal) if v > 0}
            to_read = sorted(universe)
        else:
            to_read = sorted((universe & act.get(i, set())) | new_b)
        accts = read_accounts(pool, block, m, to_read) if to_read else {}
        if not scan:
            for x, a in accts.items():
                if usdc_debt(a) > 0:
                    universe.add(x)
                else:
                    universe.discard(x)
        jdump(os.path.join(pdir, f"{d}.json.gz"), {"date": d, "block": block, "scan": scan,
                                                     "universe": sorted(ident(x) for x in universe),
                                                     "accounts": {str(ident(x)): a for x, a in accts.items()}})
        st["done"].append(d)
        st["universe"] = sorted(universe)
        if i % 10 == 0 or i == len(days) - 1:
            jdump(state_path, st)
            print(f"positions: {d} block {block} scan={scan} read={len(to_read)} universe={len(universe)} "
                  f"{time.time() - t0:.0f}s", flush=True)
    jdump(state_path, st)
    print(f"positions: done; rpc {pool.counts()}", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("phase", choices=["index", "meta", "hourly", "logs", "positions"])
    ap.add_argument("--work", required=True)
    a = ap.parse_args()
    os.makedirs(a.work, exist_ok=True)
    {"index": phase_index, "meta": phase_meta, "hourly": phase_hourly, "logs": phase_logs,
     "positions": phase_positions}[a.phase](a.work)


if __name__ == "__main__":
    main()
