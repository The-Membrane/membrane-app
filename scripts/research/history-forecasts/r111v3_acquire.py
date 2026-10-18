"""Q26 R11.1-v3 input acquisition (membrane-board design/Q26_ROUND11_PREREG.md D-R11.1e). Inputs only: no
simulated volume, outcome comparison or score is computed here.

  python3 r111v3_acquire.py reserves --market M --work DIR    reserve list and token addresses at the end block
  python3 r111v3_acquire.py logs     --market M --work DIR    aToken / variable / stable debt token Mint, Burn and
                                                              BalanceTransfer; Pool ReserveDataUpdated (last per
                                                              reserve-hour), collateral enable/disable, UserEModeSet
  python3 r111v3_acquire.py oracle   --market M --work DIR    weekly AaveOracle source walk -> Chainlink aggregators;
                                                              every AnswerUpdated of those aggregators
  python3 r111v3_acquire.py meta     --market arb --work DIR  daily anchor reserve config, e-mode, USDC debt totals
  python3 r111v3_acquire.py hourly   --market arb --work DIR  hourly oracle prices and base fee
  python3 r111v3_acquire.py liq      --market M --work DIR    Pool LiquidationCall logs (Arbitrum: locked file,
                                                              counts printed only)

Markets: core (Aave V3 Ethereum Core, development period D only), arb (Aave V3 Arbitrum, blind set L1) and poly
(Aave V3 Polygon, L1-secondary confirmation set of R11.1-v4, D-R11.1k).
Free keyless JSON-RPC only. Addresses stay inside --work (never published).

R11.1-v4 (D-R11.1j/k): a missing blockTimestamp is never defaulted to 0. The RPC client fills it from the block
header and every compacted row is checked (log_ts raises on a missing or non-positive timestamp). The block lookup
(ts_to_block_fn) is built from the event (block, header timestamp) pairs and must be monotonic.
"""
from __future__ import annotations

import argparse
import bisect
import datetime as dt
import gzip
import json
import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import r111v3_rpc as X  # noqa: E402

RAY = 10**27
MARKETS = {
    "core": {"chain": "ethereum", "pool": "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2",
             "oracle": "0x54586be62e3c3580375ae3723c145253060ca0c2", "start": 16_291_127,
             "end_ts": int(dt.datetime(2025, 1, 1, tzinfo=dt.timezone.utc).timestamp()),
             "usdc": ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"], "span": 40_000, "first_day": "2023-02-01"},
    "arb": {"chain": "arbitrum", "pool": "0x794a61358d6845594f94dc1db02a252b5b4814ad",
            "oracle": "0xb56c2f0b653b2e0b10c9b928c8580ac5df02c7c7", "start": 7_700_000,
            "end_ts": int(dt.datetime(2026, 10, 1, tzinfo=dt.timezone.utc).timestamp()),
            "usdc": ["0xff970a61a04b1ca14834a43f5de4533ebddb5cc8", "0xaf88d065e77c8cc2239327c5edb3a432268e5831"],
            "span": 1_000_000, "first_day": "2022-09-01", "min_state_block": 22_207_818,
            "pap": "0xa97684ead0e402dc232d5a977953df7ecbab3cdb"},
    # R11.1-v4 confirmation set (D-R11.1k): Pool code from block 25,826,028 (2022-03-11); no PriceOracleSentinel
    "poly": {"chain": "polygon", "pool": "0x794a61358d6845594f94dc1db02a252b5b4814ad",
             "oracle": "0xb023e699f5a33916ea823a16485e259257ca8bd1", "start": 25_826_028,
             "end_ts": int(dt.datetime(2026, 10, 1, tzinfo=dt.timezone.utc).timestamp()),
             "usdc": ["0x2791bca1f2de4661ed88a30c99a7a9449aa84174", "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359"],
             "span": 100_000, "first_day": "2022-03-15", "pap": "0xa97684ead0e402dc232d5a977953df7ecbab3cdb"},
}
T = {
    "Mint": X.topic("Mint(address,address,uint256,uint256,uint256)"),
    "Burn": X.topic("Burn(address,address,uint256,uint256,uint256)"),
    "BalanceTransfer": X.topic("BalanceTransfer(address,address,uint256,uint256)"),
    "SMint": X.topic("Mint(address,address,uint256,uint256,uint256,uint256,uint256,uint256)"),
    "SBurn": X.topic("Burn(address,uint256,uint256,uint256,uint256,uint256)"),
    "RDU": X.topic("ReserveDataUpdated(address,uint256,uint256,uint256,uint256,uint256)"),
    "CollOn": X.topic("ReserveUsedAsCollateralEnabled(address,address)"),
    "CollOff": X.topic("ReserveUsedAsCollateralDisabled(address,address)"),
    "EMode": X.topic("UserEModeSet(address,uint8)"),
    "Liq": X.topic("LiquidationCall(address,address,address,uint256,uint256,address,bool)"),
    "Answer": X.topic("AnswerUpdated(int256,uint256,uint256)"),
}
ADAPTER_GETTERS = ["BASE_TO_USD_AGGREGATOR()", "ASSET_TO_USD_AGGREGATOR()", "ASSET_TO_PEG()", "PEG_TO_BASE()",
                   "BASE_TO_PEG()", "ASSET_TO_BASE_AGGREGATOR()", "STETH_TO_USD_AGGREGATOR()"]
EMODE_IDS = range(1, 41)


def utcnow():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def jdump(path, obj):
    tmp = path + ".tmp"
    with gzip.open(tmp, "wt") as f:
        json.dump(obj, f, sort_keys=True)
    os.replace(tmp, path)


def jload(path):
    with gzip.open(path, "rt") as f:
        return json.load(f)


def npsave(path, **arrs):
    tmp = path + ".tmp.npz"
    np.savez_compressed(tmp, **arrs)
    os.replace(tmp, path)


def words(data):
    raw = bytes.fromhex(data[2:])
    return [int.from_bytes(raw[i:i + 32], "big") for i in range(0, len(raw), 32)]


def log_ts(lg):
    """Header timestamp of a log. R11.1-v4: never 0 (the client fills a missing one from the header)."""
    v = lg.get("blockTimestamp")
    ts = int(v, 16) if v else 0
    if ts <= 0:
        raise RuntimeError(f"log without a block timestamp at block {int(lg['blockNumber'], 16)}")
    return ts


def t_addr(t):
    return "0x" + t[-40:].lower()


def block_at_ts(cl, ts, lo, hi):
    """First block with timestamp >= ts in [lo, hi]."""
    while lo < hi:
        m = (lo + hi) // 2
        t = int(cl.request("eth_getBlockByNumber", [hex(m), False])["timestamp"], 16)
        if t < ts:
            lo = m + 1
        else:
            hi = m
    return lo


# ---------------------------------------------------------------------------------------------
def phase_reserves(mk, work):
    m = MARKETS[mk]
    cl = X.Client(m["chain"], calls=True)
    head = int(cl.request("eth_blockNumber", []), 16)
    end = block_at_ts(cl, m["end_ts"], m.get("min_state_block", m["start"]), head)
    r = X.aggregate3(cl, [(m["pool"], X.sel("getReservesList()"))], end)[0][1]
    n = X.word(r, 1)
    assets = [X.as_addr(X.word(r, 2 + i)) for i in range(n)]
    out = X.aggregate3(cl, [(m["pool"], X.sel("getReserveData(address)") + X.enc_addr(a)) for a in assets]
                       + [(a, X.sel("decimals()")) for a in assets] + [(a, X.sel("symbol()")) for a in assets], end)
    res = []
    for i, a in enumerate(assets):
        rd = out[i][1]
        sym = out[2 * n + i][1]
        try:
            sym = sym[64:64 + X.word(sym, 1)].decode("utf-8", "replace") if len(sym) >= 96 else sym.rstrip(b"\0").decode()
        except Exception:
            sym = f"asset{i}"
        res.append({"asset": a, "id": X.word(rd, 7), "aToken": X.as_addr(X.word(rd, 8)), "sDebt": X.as_addr(X.word(rd, 9)),
                    "vDebt": X.as_addr(X.word(rd, 10)), "dec": X.word(out[n + i][1]), "symbol": sym})
    jdump(os.path.join(work, "reserves.json.gz"), {"end_block": end, "reserves": res, "head": head})
    print(f"reserves: {len(res)} at end block; rpc {cl.stats}", flush=True)


# ---------------------------------------------------------------------------------------------
def compact_token(logs, tok_map):
    """Raw token logs -> arrays. kind 0 aToken, 1 variable debt, 2 stable debt. For a/v: delta = signed scaled amount
    (raw token units / index). For stable: principal after the event and the user's rate (ray)."""
    B, L, TS, RS, K, U, D, P, RT = [], [], [], [], [], [], [], [], []
    users = {}

    def uid(a):
        if a not in users:
            users[a] = len(users)
        return users[a]

    def put(lg, res, kind, user, delta, prin=0.0, rate=0.0):
        B.append(int(lg["blockNumber"], 16))
        L.append(int(lg["logIndex"], 16))
        TS.append(log_ts(lg))
        RS.append(res)
        K.append(kind)
        U.append(uid(user))
        D.append(delta)
        P.append(prin)
        RT.append(rate)

    for lg in logs:
        res, kind = tok_map[lg["address"].lower()]
        t0 = lg["topics"][0]
        w = words(lg["data"])
        if kind < 2 and t0 == T["Mint"]:
            value, bi, idx = w[0], w[1], w[2]
            amt = value - bi
            sc = (abs(amt) * RAY + idx // 2) // idx
            put(lg, res, kind, t_addr(lg["topics"][2]), float(sc if amt >= 0 else -sc))
        elif kind < 2 and t0 == T["Burn"]:
            value, bi, idx = w[0], w[1], w[2]
            sc = ((value + bi) * RAY + idx // 2) // idx
            put(lg, res, kind, t_addr(lg["topics"][1]), -float(sc))
        elif kind == 0 and t0 == T["BalanceTransfer"]:
            value = w[0]
            put(lg, res, kind, t_addr(lg["topics"][1]), -float(value))
            put(lg, res, kind, t_addr(lg["topics"][2]), float(value))
        elif kind == 2 and t0 == T["SMint"]:
            emitted, cur, bi, rate = w[0], w[1], w[2], w[3]
            prin = cur + (emitted - bi)
            put(lg, res, kind, t_addr(lg["topics"][2]), 0.0, float(prin), float(rate))
        elif kind == 2 and t0 == T["SBurn"]:
            emitted, cur, bi = w[0], w[1], w[2]
            prin = cur - (emitted + bi)
            put(lg, res, kind, t_addr(lg["topics"][1]), 0.0, float(max(prin, 0)), -1.0)
    ul = [None] * len(users)
    for a, i in users.items():
        ul[i] = a
    return dict(block=np.array(B, np.int64), lidx=np.array(L, np.int32), ts=np.array(TS, np.int64),
                res=np.array(RS, np.int16), kind=np.array(K, np.int8), user=np.array(U, np.int32),
                delta=np.array(D, np.float64), prin=np.array(P, np.float64), rate=np.array(RT, np.float64),
                users=np.array([bytes.fromhex(a[2:]) for a in ul], dtype="S20"))


def compact_pool(logs, res_idx):
    """RDU thinned to the last log per (reserve, UTC hour); collateral flags; e-mode."""
    rdu = {}
    F_B, F_L, F_TS, F_R, F_U, F_ON = [], [], [], [], [], []
    E_B, E_L, E_TS, E_U, E_C = [], [], [], [], []
    users = {}

    def uid(a):
        if a not in users:
            users[a] = len(users)
        return users[a]

    for lg in logs:
        t0 = lg["topics"][0]
        b, li = int(lg["blockNumber"], 16), int(lg["logIndex"], 16)
        ts = log_ts(lg)
        if t0 == T["RDU"]:
            r = res_idx.get(t_addr(lg["topics"][1]))
            if r is None:
                continue
            w = words(lg["data"])
            rdu[(r, ts // 3600)] = (b, li, ts, r, w[0] / RAY, w[2] / RAY, w[3] / RAY, w[4] / RAY)
        elif t0 in (T["CollOn"], T["CollOff"]):
            r = res_idx.get(t_addr(lg["topics"][1]))
            if r is None:
                continue
            F_B.append(b); F_L.append(li); F_TS.append(ts); F_R.append(r)
            F_U.append(uid(t_addr(lg["topics"][2]))); F_ON.append(1 if t0 == T["CollOn"] else 0)
        elif t0 == T["EMode"]:
            E_B.append(b); E_L.append(li); E_TS.append(ts); E_U.append(uid(t_addr(lg["topics"][1])))
            E_C.append(words(lg["data"])[0])
    rv = sorted(rdu.values())
    ul = [None] * len(users)
    for a, i in users.items():
        ul[i] = a
    return dict(rdu_block=np.array([x[0] for x in rv], np.int64), rdu_lidx=np.array([x[1] for x in rv], np.int32),
                rdu_ts=np.array([x[2] for x in rv], np.int64), rdu_res=np.array([x[3] for x in rv], np.int16),
                rdu_lrate=np.array([x[4] for x in rv]), rdu_vrate=np.array([x[5] for x in rv]),
                rdu_lidx_ray=np.array([x[6] for x in rv]), rdu_vidx_ray=np.array([x[7] for x in rv]),
                f_block=np.array(F_B, np.int64), f_lidx=np.array(F_L, np.int32), f_ts=np.array(F_TS, np.int64),
                f_res=np.array(F_R, np.int16), f_user=np.array(F_U, np.int32), f_on=np.array(F_ON, np.int8),
                e_block=np.array(E_B, np.int64), e_lidx=np.array(E_L, np.int32), e_ts=np.array(E_TS, np.int64),
                e_user=np.array(E_U, np.int32), e_cat=np.array(E_C, np.int16),
                users=np.array([bytes.fromhex(a[2:]) for a in ul], dtype="S20"))


def phase_logs(mk, work, threads=4):
    m = MARKETS[mk]
    rs = jload(os.path.join(work, "reserves.json.gz"))
    end = rs["end_block"]
    tok_map, res_idx = {}, {}
    for i, r in enumerate(rs["reserves"]):
        res_idx[r["asset"]] = i
        tok_map[r["aToken"]] = (i, 0)
        tok_map[r["vDebt"]] = (i, 1)
        if int(r["sDebt"], 16):
            tok_map[r["sDebt"]] = (i, 2)
    toks = sorted(tok_map)
    cl = X.Client(m["chain"], interval=0.1)
    out = {"tok": os.path.join(work, "tok"), "pool": os.path.join(work, "pool")}
    for p in out.values():
        os.makedirs(p, exist_ok=True)
    span = m["span"]
    starts = list(range(m["start"], end + 1, span))
    lock = threading.Lock()
    done = [0]

    def one(s):
        e = min(s + span - 1, end)
        pt = os.path.join(out["tok"], f"{s}.npz")
        if not os.path.exists(pt):
            lg = cl.logs(toks, [[T["Mint"], T["Burn"], T["BalanceTransfer"], T["SMint"], T["SBurn"]]], s, e)
            npsave(pt, **compact_token(lg, tok_map))
        pp = os.path.join(out["pool"], f"{s}.npz")
        if not os.path.exists(pp):
            lg = cl.logs(m["pool"], [[T["RDU"], T["CollOn"], T["CollOff"], T["EMode"]]], s, e)
            npsave(pp, **compact_pool(lg, res_idx))
        with lock:
            done[0] += 1
            if done[0] % 20 == 0:
                print(f"{utcnow()} logs {done[0]}/{len(starts)} rpc {cl.stats}", flush=True)

    with ThreadPoolExecutor(threads) as ex:
        list(ex.map(one, starts))
    print(f"logs: {len(starts)} ranges to block {end}; rpc {cl.stats}", flush=True)


# ---------------------------------------------------------------------------------------------
def ts_to_block_fn(work):
    """Block lookup from the held event (block, header timestamp) pairs: pool events and token logs.
    R11.1-v4 (D-R11.1j): every timestamp must be positive, one block has one timestamp, and timestamps must not
    decrease with the block number. f(ts) = the last held block with timestamp <= ts."""
    bl, tl = [], []
    for sub, pairs in (("pool", [("rdu_block", "rdu_ts"), ("f_block", "f_ts"), ("e_block", "e_ts")]),
                       ("tok", [("block", "ts")])):
        d = os.path.join(work, sub)
        if not os.path.isdir(d):
            continue
        for name in os.listdir(d):
            z = np.load(os.path.join(d, name))
            for kb, kt in pairs:
                if kb in z.files and len(z[kb]):
                    bl.append(z[kb])
                    tl.append(z[kt])
    b = np.concatenate(bl)
    t = np.concatenate(tl)
    if (t <= 0).any():
        raise RuntimeError(f"{int((t <= 0).sum())} event rows with a non-positive timestamp")
    o = np.lexsort((t, b))
    b, t = b[o], t[o]
    keep = np.ones(len(b), dtype=bool)
    keep[1:] = b[1:] != b[:-1]
    if (t[1:][~keep[1:]] != t[:-1][~keep[1:]]).any():
        raise RuntimeError("one block with two timestamps")
    b, t = b[keep], t[keep]
    if (np.diff(t) < 0).any():
        raise RuntimeError(f"timestamps decrease with the block number at {int((np.diff(t) < 0).sum())} places")

    def f(ts):
        i = int(np.searchsorted(t, ts, side="right")) - 1
        return int(b[max(i, 0)])
    return f, b, t


def walk_sources(cl, oracle, assets, block):
    calls = [(oracle, X.sel("getSourceOfAsset(address)") + X.enc_addr(a)) for a in assets]
    srcs = [X.as_addr(X.word(r)) if ok and len(r) == 32 else None for ok, r in X.aggregate3(cl, calls, block)]
    res = {a: {"source": s, "aggs": []} for a, s in zip(assets, srcs)}
    frontier = [(a, s) for a, s in zip(assets, srcs) if s and int(s, 16)]
    for _ in range(3):
        if not frontier:
            break
        calls, meta = [], []
        for a, s in frontier:
            calls.append((s, X.sel("aggregator()")))
            meta.append((a, "agg"))
            for g in ADAPTER_GETTERS:
                calls.append((s, X.sel(g)))
                meta.append((a, g))
        out = X.aggregate3(cl, calls, block)
        nxt = []
        for (a, kind), (ok, r) in zip(meta, out):
            if not ok or len(r) != 32:
                continue
            v = X.as_addr(X.word(r))
            if not int(v, 16):
                continue
            if kind == "agg":
                if v not in res[a]["aggs"]:
                    res[a]["aggs"].append(v)
            else:
                nxt.append((a, v))
        frontier = nxt
    return res


def sentinel_read(cl, pap, blk):
    """PriceOracleSentinel (L2): address, grace period and the sequencer uptime feed's aggregator(s)."""
    s = X.as_addr(X.word(X.aggregate3(cl, [(pap, X.sel("getPriceOracleSentinel()"))], blk)[0][1]))
    if not s or not int(s, 16):
        return {"present": False, "grace": 0, "seq_aggs": []}
    o = X.aggregate3(cl, [(s, X.sel("getSequencerOracle()")), (s, X.sel("getGracePeriod()"))], blk)
    so = X.as_addr(X.word(o[0][1]))
    ag = X.aggregate3(cl, [(so, X.sel("aggregator()"))], blk)[0]
    return {"present": True, "grace": X.word(o[1][1]),
            "seq_aggs": [X.as_addr(X.word(ag[1]))] if ag[0] and len(ag[1]) == 32 else []}


def phase_oracle(mk, work):
    m = MARKETS[mk]
    rs = jload(os.path.join(work, "reserves.json.gz"))
    cl = X.Client(m["chain"], calls=True)
    f, b, t = ts_to_block_fn(work)
    first_ts = max(int(t[0]), int(dt.datetime.fromisoformat(m["first_day"] + "T00:00:00+00:00").timestamp()) - 14 * 86400)
    walks = []
    ts = first_ts
    while ts < m["end_ts"] + 7 * 86400:
        blk = f(ts)
        if blk >= m.get("min_state_block", 0):
            lst = X.aggregate3(cl, [(m["pool"], X.sel("getReservesList()"))], blk)[0][1]
            n = X.word(lst, 1)
            assets = [X.as_addr(X.word(lst, 2 + i)) for i in range(n)]
            w = {"ts": ts, "block": blk, "map": walk_sources(cl, m["oracle"], assets, blk), "sentinel": None}
            if m.get("pap"):
                w["sentinel"] = sentinel_read(cl, m["pap"], blk)
            walks.append(w)
        ts += 7 * 86400
    aggs = sorted({g for w in walks for v in w["map"].values() for g in v["aggs"]}
                  | {g for w in walks if w["sentinel"] for g in w["sentinel"]["seq_aggs"]})
    lc = X.Client(m["chain"], interval=0.1)
    lo, hi = walks[0]["block"], rs["end_block"]
    od = os.path.join(work, "oracle")
    os.makedirs(od, exist_ok=True)
    span = m["span"] * 4
    starts = list(range(lo, hi + 1, span))
    aidx = {a: i for i, a in enumerate(aggs)}

    def one(s):
        p = os.path.join(od, f"{s}.npz")
        if os.path.exists(p):
            return
        lg = lc.logs(aggs, [T["Answer"]], s, min(s + span - 1, hi))
        npsave(p, block=np.array([int(x["blockNumber"], 16) for x in lg], np.int64),
               lidx=np.array([int(x["logIndex"], 16) for x in lg], np.int32),
               ts=np.array([log_ts(x) for x in lg], np.int64),
               agg=np.array([aidx[x["address"].lower()] for x in lg], np.int16),
               answer=np.array([float(int(x["topics"][1], 16) - (1 << 256) if int(x["topics"][1], 16) >> 255
                                      else int(x["topics"][1], 16)) for x in lg]))

    with ThreadPoolExecutor(4) as ex:
        list(ex.map(one, starts))
    jdump(os.path.join(work, "oracle-walk.json.gz"), {"walks": walks, "aggregators": aggs})
    n = sum(len(np.load(os.path.join(od, x))["block"]) for x in os.listdir(od))
    print(f"oracle: {len(walks)} weekly walks, {len(aggs)} aggregators, {n} AnswerUpdated; rpc {cl.stats} {lc.stats}",
          flush=True)


# ---------------------------------------------------------------------------------------------
def emode_read(cl, pool, block):
    calls = []
    for c in EMODE_IDS:
        calls += [(pool, X.sel("getEModeCategoryCollateralConfig(uint8)") + X.enc_u(c)),
                  (pool, X.sel("getEModeCategoryCollateralBitmap(uint8)") + X.enc_u(c)),
                  (pool, X.sel("getEModeCategoryData(uint8)") + X.enc_u(c))]
    res = X.aggregate3(cl, calls, block)
    out = {}
    for j, c in enumerate(EMODE_IDS):
        r1, r2, r3 = res[3 * j], res[3 * j + 1], res[3 * j + 2]
        if r1[0] and len(r1[1]) == 96 and r2[0]:
            w = [X.word(r1[1], i) for i in range(3)]
            if w[1] > 0:
                out[str(c)] = {"layout": "v32", "ltv": w[0], "lt": w[1], "lb": w[2], "bitmap": X.word(r2[1]),
                               "price_source": None}
        elif r3[0] and len(r3[1]) >= 160:
            w = [X.word(r3[1], i) for i in range(5)]
            if w and w[0] == 32:
                w = w[1:]
            if len(w) >= 4 and w[1] > 0:
                out[str(c)] = {"layout": "legacy", "ltv": w[0], "lt": w[1], "lb": w[2], "bitmap": None,
                               "price_source": int(w[3] != 0)}
    return out


def day_anchor_blocks(work, mk):
    """Anchor of day d = the last held pool-event block with timestamp < d 00:00Z (state at the end of that block)."""
    m = MARKETS[mk]
    _, b, t = ts_to_block_fn(work)
    d = dt.date.fromisoformat(m["first_day"])
    end = dt.datetime.fromtimestamp(m["end_ts"], dt.timezone.utc).date()
    out = {}
    while d <= end:
        ts = int(dt.datetime(d.year, d.month, d.day, tzinfo=dt.timezone.utc).timestamp())
        i = int(np.searchsorted(t, ts, side="left")) - 1
        out[d.isoformat()] = int(b[i])
        d += dt.timedelta(days=1)
    return out


def phase_meta(mk, work):
    m = MARKETS[mk]
    rs = jload(os.path.join(work, "reserves.json.gz"))
    cl = X.Client(m["chain"], interval=0.1, calls=True)
    anchors = day_anchor_blocks(work, mk)
    jdump(os.path.join(work, "anchors.json.gz"), anchors)
    md = os.path.join(work, "meta")
    os.makedirs(md, exist_ok=True)
    tokens = {r["asset"]: r for r in rs["reserves"]}

    def one(k):
        p = os.path.join(md, f"{k}.json.gz")
        if os.path.exists(p):
            return
        blk = anchors[k]
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
        for u in m["usdc"]:
            calls += [(tokens[u]["vDebt"], X.sel("totalSupply()")), (tokens[u]["sDebt"], X.sel("totalSupply()"))]
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
        usdc_debt = {}
        for i, u in enumerate(m["usdc"]):
            v, s = res[q + 1 + 2 * i], res[q + 2 + 2 * i]
            usdc_debt[u] = (X.word(v[1]) or 0 if v[0] else 0) + (X.word(s[1]) or 0 if s[0] else 0)
        blkobj = cl.request("eth_getBlockByNumber", [hex(blk), False])
        jdump(p, {"date": k, "block": blk, "ts": int(blkobj["timestamp"], 16), "assets": assets, "reserves": R,
                  "v33": v33, "emode": emode_read(cl, m["pool"], blk), "usdc_debt_raw": {u: str(v) for u, v in usdc_debt.items()},
                  "virtual_balance_ok": False})

    with ThreadPoolExecutor(4) as ex:
        list(ex.map(one, sorted(anchors)))
    print(f"meta: {len(anchors)} anchors; rpc {cl.stats}", flush=True)


def phase_hourly(mk, work):
    """Prices of every listed reserve at b_h = the last held pool-event block with timestamp < h (state at hour h),
    and that block's timestamp and base fee. One Multicall3 eth_call per hour over the keyless archive endpoints;
    block headers in batches from the full nodes."""
    m = MARKETS[mk]
    cl = X.Client(m["chain"], interval=0.04, calls=True)
    cl.urls = list(X.HOURLY_CALL_ENDPOINTS[m["chain"]])
    hc = X.Client(m["chain"], interval=0.1)
    hc.urls = list(X.HEADER_ENDPOINTS[m["chain"]])
    _, b, t = ts_to_block_fn(work)
    h0 = int(dt.datetime.fromisoformat(m["first_day"] + "T00:00:00+00:00").timestamp())
    hours = list(range(h0, m["end_ts"] + 1, 3600))
    hd = os.path.join(work, "hourly")
    os.makedirs(hd, exist_ok=True)
    rs = jload(os.path.join(work, "reserves.json.gz"))
    allassets = [r["asset"] for r in rs["reserves"]]
    data = X.aggregate3_data([(m["oracle"], X.sel("getAssetPrice(address)") + X.enc_addr(a)) for a in allassets])
    by_day = {}
    for h in hours:
        by_day.setdefault(dt.datetime.fromtimestamp(h, dt.timezone.utc).date().isoformat(), []).append(h)

    def one(day):
        p = os.path.join(hd, f"{day}.json.gz")
        if os.path.exists(p):
            return
        blks = [int(b[int(np.searchsorted(t, h, side="left")) - 1]) for h in by_day[day]]
        heads = hc.batch([("eth_getBlockByNumber", [hex(x), False]) for x in blks])
        rows = []
        for h, blk, bo in zip(by_day[day], blks, heads):
            dec = None
            for _ in range(8):
                raw = cl.request("eth_call", [{"to": X.MULTICALL3, "data": data}, hex(blk)])
                try:
                    dec = X.aggregate3_decode(raw)
                    if len(dec) == len(allassets):
                        break
                except Exception:
                    pass
                dec = None
            if dec is None:
                raise RuntimeError(f"hourly multicall undecodable at {blk}")
            hts = int(bo["timestamp"], 16)
            if not (0 < hts < h):
                raise RuntimeError(f"hourly read block {blk} has header ts {hts} not before hour {h}")
            rows.append({"hour": h, "block": blk, "ts": hts,
                         "base_fee": int(bo.get("baseFeePerGas") or "0x0", 16),
                         "prices": [X.word(r) if ok and len(r) == 32 else None for ok, r in dec]})
        jdump(p, {"date": day, "assets": allassets, "rows": rows})

    with ThreadPoolExecutor(8) as ex:
        list(ex.map(one, sorted(by_day)))
    print(f"hourly: {len(hours)} hours; rpc calls {cl.stats} headers {hc.stats}", flush=True)


def stable_tokens(work):
    """Historical stable-debt token address per reserve from the daily metas. An address shared by several reserves
    on the same day (the v3.2+ getReserveData placeholder) or the zero address is not a stable token of that day."""
    rs = jload(os.path.join(work, "reserves.json.gz"))
    gidx = {r["asset"]: i for i, r in enumerate(rs["reserves"])}
    own = {}
    md = os.path.join(work, "meta")
    for n in sorted(os.listdir(md)):
        if not n.endswith(".json.gz"):
            continue
        m = jload(os.path.join(md, n))
        cnt = {}
        for r in m["reserves"].values():
            cnt[r["sDebt"]] = cnt.get(r["sDebt"], 0) + 1
        for a, r in m["reserves"].items():
            s = r["sDebt"]
            if s and int(s, 16) and cnt[s] == 1:
                own.setdefault(s, set()).add(gidx[a])
    out = {}
    for s, rset in own.items():
        if len(rset) != 1:
            raise RuntimeError("stable token mapped to two reserves")
        out[s] = (rset.pop(), 2)
    return out


def phase_stable(mk, work):
    """Stable-debt token Mint / Burn of every historical stable token (tok-stable/ parts). The tok/ parts mapped stable
    logs through the end-block address only, which v3.2+ reports as one shared placeholder; their kind-2 rows are
    ignored when tok-stable/ exists."""
    m = MARKETS[mk]
    rs = jload(os.path.join(work, "reserves.json.gz"))
    tmap = stable_tokens(work)
    cl = X.Client(m["chain"], interval=0.1)
    od = os.path.join(work, "tok-stable")
    os.makedirs(od, exist_ok=True)
    span = m["span"] * 8
    starts = list(range(m["start"], rs["end_block"] + 1, span))

    def one(s):
        p = os.path.join(od, f"{s}.npz")
        if os.path.exists(p):
            return
        lg = cl.logs(sorted(tmap), [[T["SMint"], T["SBurn"]]], s, min(s + span - 1, rs["end_block"]))
        npsave(p, **compact_token(lg, tmap))

    with ThreadPoolExecutor(4) as ex:
        list(ex.map(one, starts))
    n = sum(len(np.load(os.path.join(od, x))["block"]) for x in os.listdir(od))
    jdump(os.path.join(work, "stable-tokens.json.gz"), {k: v[0] for k, v in tmap.items()})
    print(f"stable: {len(tmap)} stable tokens, {n} logs; rpc {cl.stats}", flush=True)


def phase_debt(mk, work):
    """Per day anchor: variable-debt totalSupply and the day's own stable-debt totalSupply of each USDC reserve."""
    m = MARKETS[mk]
    rs = jload(os.path.join(work, "reserves.json.gz"))
    tokens = {r["asset"]: r for r in rs["reserves"]}
    tmap = stable_tokens(work)
    anchors = jload(os.path.join(work, "anchors.json.gz"))
    cl = X.Client(m["chain"], interval=0.05, calls=True)
    cl.urls = list(X.HOURLY_CALL_ENDPOINTS.get(m["chain"], cl.urls))
    out = {}
    keys = sorted(anchors)
    for i in range(0, len(keys), 1):
        chunk = keys[i:i + 1]
        reqs, meta = [], []
        for k in chunk:
            md = jload(os.path.join(work, "meta", f"{k}.json.gz"))
            calls = []
            for u in m["usdc"]:
                calls.append((tokens[u]["vDebt"], X.sel("totalSupply()")))
                s = md["reserves"].get(u, {}).get("sDebt")
                own = s if (s and s in tmap and tmap[s][0] == rs["reserves"].index(tokens[u])) else None
                calls.append((own or tokens[u]["vDebt"], X.sel("totalSupply()") if own else X.sel("decimals()")))
                meta.append((k, u, bool(own)))
            reqs.append(("eth_call", [{"to": X.MULTICALL3, "data": X.aggregate3_data(calls)}, hex(anchors[k])]))
        res = [cl.request(mth, prm) for mth, prm in reqs]
        j = 0
        for k, raw in zip(chunk, res):
            dec = X.aggregate3_decode(raw)
            for q, u in enumerate(m["usdc"]):
                _, _, own = meta[j]
                j += 1
                v = dec[2 * q]
                sd = dec[2 * q + 1]
                vv = X.word(v[1]) if v[0] and len(v[1]) == 32 else 0
                ss = X.word(sd[1]) if own and sd[0] and len(sd[1]) == 32 else 0
                out.setdefault(k, {})[u] = {"v": str(vv or 0), "s": str(ss or 0)}
    jdump(os.path.join(work, "usdc-debt.json.gz"), out)
    print(f"debt: {len(out)} days; rpc {cl.stats}", flush=True)


def phase_bt(mk, work):
    """aToken BalanceTransfer with its index (tok-bt/). The value field changed meaning across aToken
    implementations: older ones emit the unscaled amount, newer ones the scaled amount. Per aToken implementation
    period (proxy Upgraded logs), the first BalanceTransfer is compared with its ERC20 Transfer in the same
    transaction (Transfer > BalanceTransfer value means the value is already scaled). Scaled = value or
    rayDiv(value, index) accordingly. The probe log is the first one with index > 1.0002 (at index 1 both readings
    coincide), the largest of the first 50 such logs (rounding); the reading whose implied Transfer is closer wins."""
    m = MARKETS[mk]
    rs = jload(os.path.join(work, "reserves.json.gz"))
    end = rs["end_block"]
    atok = {r["aToken"]: i for i, r in enumerate(rs["reserves"])}
    cl = X.Client(m["chain"], interval=0.1)
    UPG = X.topic("Upgraded(address)")
    TR = X.topic("Transfer(address,address,uint256)")
    upg = cl.logs(sorted(atok), [UPG], m["start"], end)
    periods = {a: [m["start"]] for a in atok}
    for x in upg:
        periods[x["address"].lower()].append(int(x["blockNumber"], 16))
    od = os.path.join(work, "tok-bt")
    os.makedirs(od, exist_ok=True)
    span = m["span"] * 2
    starts = list(range(m["start"], end + 1, span))
    raw = {}

    def one(s0):
        lg = cl.logs(sorted(atok), [[T["BalanceTransfer"]]], s0, min(s0 + span - 1, end))
        raw[s0] = [(int(x["blockNumber"], 16), int(x["logIndex"], 16), log_ts(x),
                    x["address"].lower(), t_addr(x["topics"][1]), t_addr(x["topics"][2]), words(x["data"])[0],
                    words(x["data"])[1], x["transactionHash"]) for x in lg]

    with ThreadPoolExecutor(4) as ex:
        list(ex.map(one, starts))
    allbt = sorted(x for v in raw.values() for x in v)
    # semantics per (aToken, period)
    sem = {}
    for a, ps in periods.items():
        ps = sorted(set(ps))
        for k, p0 in enumerate(ps):
            p1 = ps[k + 1] if k + 1 < len(ps) else end + 1
            cands = [x for x in allbt if x[3] == a and p0 <= x[0] < p1 and x[7] > RAY * 1.0002][:50]
            first = max(cands, key=lambda x: x[6]) if cands else None
            if first is None:
                continue
            tl = [y for y in cl.logs(a, [TR], first[0], first[0]) if y["transactionHash"] == first[8]
                  and t_addr(y["topics"][1]) == first[4] and t_addr(y["topics"][2]) == first[5]]
            tv = int(tl[0]["data"], 16) if tl else None
            scaled = True if tv is None else abs(tv - first[6] * first[7] / RAY) <= abs(tv - first[6])
            sem[(a, p0)] = {"start": p0, "end": p1, "scaled": bool(scaled),
                            "checked": tv is not None}
    def scaled_flag(a, b):
        for (aa, p0), v in sem.items():
            if aa == a and v["start"] <= b < v["end"]:
                return v["scaled"]
        return True

    B, L, TS, RS, K, U, D = [], [], [], [], [], [], []
    users = {}
    for (b, li, ts, a, fr, to, val, idx, _tx) in allbt:
        sc = val if scaled_flag(a, b) else (val * RAY + idx // 2) // idx
        for who, sg in ((fr, -1.0), (to, 1.0)):
            if who not in users:
                users[who] = len(users)
            B.append(b); L.append(li); TS.append(ts); RS.append(atok[a]); K.append(0); U.append(users[who])
            D.append(sg * float(sc))
    ul = [None] * len(users)
    for a_, i in users.items():
        ul[i] = a_
    n = len(B)
    npsave(os.path.join(od, "0.npz"), block=np.array(B, np.int64), lidx=np.array(L, np.int32), ts=np.array(TS, np.int64),
           res=np.array(RS, np.int16), kind=np.array(K, np.int8), user=np.array(U, np.int32),
           delta=np.array(D, np.float64), prin=np.zeros(n), rate=np.zeros(n),
           users=np.array([bytes.fromhex(x[2:]) for x in ul], dtype="S20"))
    jdump(os.path.join(work, "bt-semantics.json.gz"),
          [{"reserve": atok[a], "start": v["start"], "end": v["end"], "scaled": v["scaled"], "checked": v["checked"]}
           for (a, _), v in sorted(sem.items(), key=lambda kv: (atok[kv[0][0]], kv[0][1]))])
    print(f"bt: {len(allbt)} BalanceTransfer logs, {len(upg)} upgrades, periods {len(sem)} "
          f"(unscaled {sum(1 for v in sem.values() if not v['scaled'])}); rpc {cl.stats}", flush=True)


def phase_liq(mk, work):
    m = MARKETS[mk]
    rs = jload(os.path.join(work, "reserves.json.gz"))
    cl = X.Client(m["chain"], interval=0.1)
    lg = cl.logs(m["pool"], [T["Liq"]], m["start"], rs["end_block"])
    rows = []
    for x in lg:
        w = words(x["data"])
        rows.append({"block": int(x["blockNumber"], 16), "log_index": int(x["logIndex"], 16),
                     "ts": log_ts(x), "tx": x["transactionHash"],
                     "collateral": t_addr(x["topics"][1]), "debt": t_addr(x["topics"][2]), "user": t_addr(x["topics"][3]),
                     "debtToCover": w[0], "collateralAmount": w[1], "receiveAToken": w[3]})
    name = "liq.json.gz" if mk == "core" else "liq-LOCKED.json.gz"
    jdump(os.path.join(work, name), {"rows": rows})
    usdc = set(m["usdc"])
    n_u = sum(r["debt"] in usdc for r in rows)
    first = dt.datetime.fromisoformat(m["first_day"] + "T00:00:00+00:00").timestamp()
    in_set = [r for r in rows if r["debt"] in usdc and first <= r["ts"] < m["end_ts"]]
    print(f"liq: {len(rows)} LiquidationCall logs, {n_u} with USDC debt, {len(in_set)} USDC-debt in the scored span; "
          f"rpc {cl.stats}", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("phase", choices=["reserves", "logs", "oracle", "meta", "hourly", "liq", "stable", "debt", "bt"])
    ap.add_argument("--market", choices=list(MARKETS), required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--threads", type=int, default=4)
    a = ap.parse_args()
    os.makedirs(a.work, exist_ok=True)
    print(f"{utcnow()} start {a.phase} {a.market}", flush=True)
    {"reserves": lambda: phase_reserves(a.market, a.work), "logs": lambda: phase_logs(a.market, a.work, a.threads),
     "oracle": lambda: phase_oracle(a.market, a.work), "meta": lambda: phase_meta(a.market, a.work),
     "hourly": lambda: phase_hourly(a.market, a.work), "liq": lambda: phase_liq(a.market, a.work),
     "stable": lambda: phase_stable(a.market, a.work), "debt": lambda: phase_debt(a.market, a.work),
     "bt": lambda: phase_bt(a.market, a.work)}[a.phase]()
    print(f"{utcnow()} end {a.phase} {a.market}", flush=True)


if __name__ == "__main__":
    main()
