"""Aave V3-style markets (Aave V3 Core/Prime, Spark, Aave V3 L2s): event replay to daily position records.

Prereg C.2.1 (with deviation D1: positions are rebuilt from token events instead of one eth_call per
borrower per day; the C.2.1 reader check compares the rebuild against archive eth_call).

Scaled balances, per ScaledBalanceTokenBase (Aave V3):
  Mint(caller, onBehalfOf, value, balanceIncrease, index)   scaled delta = +rayDiv(value - balanceIncrease, index)
  Burn(from, target, value, balanceIncrease, index)         scaled delta = -rayDiv(value + balanceIncrease, index)
  BalanceTransfer(from, to, value, index)                   value is already scaled (aToken only)
A burn smaller than accrued interest is emitted as a Mint with value < balanceIncrease, so the Mint rule
covers it. Stable debt is not replayed (deprecated; its effect is measured by the reader check).
Real balance at a snapshot = rayMul(scaled, normalized index read by eth_call at the snapshot block).
"""
from __future__ import annotations

import gzip
import json
import os
import sys
import time

from rpc import Client, Reverted, RpcError, enc_addr, enc_uint, selector, to_addr, topic, words

RAY = 10**27

MARKETS = {
    "aave-core-eth": {"chain": "ethereum", "provider": "0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e"},
    "aave-prime-eth": {"chain": "ethereum", "provider": "0xcfbf336fe147d643b9cb705648500e101504b16d"},
    "spark-eth": {"chain": "ethereum", "provider": "0x02C3eA4e34C0cBd694D2adFa2c690EECbC1793eE"},
    "aave-arb": {"chain": "arbitrum", "provider": "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb"},
    "aave-op": {"chain": "optimism", "provider": "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb"},
    "aave-base": {"chain": "base", "provider": "0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D"},
}

T_RESERVE_INIT = topic("ReserveInitialized(address,address,address,address,address)")
T_MINT = topic("Mint(address,address,uint256,uint256,uint256)")
T_BURN = topic("Burn(address,address,uint256,uint256,uint256)")
T_BXFER = topic("BalanceTransfer(address,address,uint256,uint256)")
T_COLL_ON = topic("ReserveUsedAsCollateralEnabled(address,address)")
T_COLL_OFF = topic("ReserveUsedAsCollateralDisabled(address,address)")
T_EMODE = topic("UserEModeSet(address,uint8)")
T_LIQ = topic("LiquidationCall(address,address,address,uint256,uint256,address,bool)")


def ray_div(a: int, b: int) -> int:
    return (a * RAY + b // 2) // b


def ray_mul(a: int, b: int) -> int:
    return (a * b + RAY // 2) // RAY


def _addr_call(c, to, sig, block="latest"):
    return to_addr(words(c.eth_call(to, selector(sig), block))[0])


def deploy_block(c: Client, addr: str) -> int:
    lo, hi = 0, c.block_number()
    while hi - lo > 1:
        mid = (lo + hi) // 2
        code = c.call("eth_getCode", [addr, hex(mid)], need_state=True)
        if code and code != "0x":
            hi = mid
        else:
            lo = mid
    return hi


def discover(market: str, work: str) -> dict:
    path = os.path.join(work, "meta.json")
    if os.path.exists(path):
        return json.load(open(path))
    m = MARKETS[market]
    c = Client(m["chain"])
    prov = m["provider"]
    pool = _addr_call(c, prov, "getPool()")
    meta = {
        "market": market, "chain": m["chain"], "provider": prov.lower(), "pool": pool,
        "oracle": _addr_call(c, prov, "getPriceOracle()"),
        "configurator": _addr_call(c, prov, "getPoolConfigurator()"),
    }
    meta["pool_deploy_block"] = deploy_block(c, pool)
    head = c.block_number()
    reserves = []
    if m["chain"] in ("base",):
        # reserve list at head + getReserveData; init block = aToken deployment (no log scan on capped chains)
        lst = words(c.eth_call(pool, selector("getReservesList()")))
        for w0 in lst[2:2 + lst[1]]:
            asset = to_addr(w0)
            rd = words(c.eth_call(pool, selector("getReserveData(address)") + enc_addr(asset)))
            at, sd, vd = to_addr(rd[8]), to_addr(rd[9]), to_addr(rd[10])
            reserves.append({"asset": asset, "aToken": at, "sDebt": sd, "vDebt": vd,
                             "init_block": deploy_block(c, at)})
        meta["reserve_discovery"] = "getReservesList at head (dropped reserves not seen)"
    else:
        logs = c.get_logs(meta["configurator"], [T_RESERVE_INIT], meta["pool_deploy_block"], head, step=2_000_000)
        for lg in logs:
            w = words(lg["data"])
            reserves.append({"asset": to_addr(int(lg["topics"][1], 16)), "aToken": to_addr(int(lg["topics"][2], 16)),
                             "sDebt": to_addr(w[0]), "vDebt": to_addr(w[1]), "init_block": int(lg["blockNumber"], 16)})
    for r in reserves:
        try:
            dec = words(c.eth_call(r["asset"], selector("decimals()")))[0]
        except (Reverted, RpcError):
            dec = None
        try:
            raw = c.eth_call(r["asset"], selector("symbol()"))
            r["symbol"] = _decode_string(raw)
        except (Reverted, RpcError):
            r["symbol"] = "?"
        r["decimals"] = dec
    meta["reserves"] = reserves
    meta["head_at_discovery"] = head
    json.dump(meta, open(path, "w"), indent=1)
    return meta


def _decode_string(raw: str) -> str:
    b = bytes.fromhex(raw[2:])
    if len(b) == 32:
        return b.rstrip(b"\0").decode(errors="replace")
    off = int.from_bytes(b[0:32], "big")
    ln = int.from_bytes(b[off:off + 32], "big")
    return b[off + 32: off + 32 + ln].decode(errors="replace")


# --------------------------------------------------------------------------------------- logs
def fetch_logs(meta: dict, work: str, to_block: int, step=500_000):
    """Token logs (Mint/Burn/BalanceTransfer on every aToken and vDebt) and pool logs, decoded to
    compact rows, written in block chunks (resumable). Row: block, logIndex, kind, a, b, x, y, z (ints as str)."""
    c = Client(meta["chain"])
    tokens = {}
    for i, r in enumerate(meta["reserves"]):
        tokens[r["aToken"].lower()] = (i, "a")
        tokens[r["vDebt"].lower()] = (i, "v")
    addrs = sorted(tokens)
    groups = [addrs[i:i + 40] for i in range(0, len(addrs), 40)]
    rs = {r["asset"].lower(): i for i, r in enumerate(meta["reserves"])}
    os.makedirs(os.path.join(work, "logs"), exist_ok=True)
    start = meta["pool_deploy_block"]
    a = start
    while a <= to_block:
        b = min(to_block, a + step - 1)
        out = os.path.join(work, "logs", f"{a:010d}-{b:010d}.jsonl.gz")
        if os.path.exists(out):
            a = b + 1
            continue
        rows = []
        for g in groups:
            for lg in c.get_logs(g, [[T_MINT, T_BURN, T_BXFER]], a, b, step=step):
                ri, kind = tokens[lg["address"].lower()]
                t0 = lg["topics"][0]
                w = words(lg["data"])
                u1 = to_addr(int(lg["topics"][1], 16))
                u2 = to_addr(int(lg["topics"][2], 16))
                if t0 == T_MINT:
                    rows.append([kind + "M", ri, u2, w[0] - w[1], w[2]])
                elif t0 == T_BURN:
                    rows.append([kind + "B", ri, u1, w[0] + w[1], w[2]])
                else:
                    rows.append([kind + "X", ri, u1, u2, w[0]])
                rows[-1] = [int(lg["blockNumber"], 16), int(lg["logIndex"], 16)] + rows[-1]
        for lg in c.get_logs(meta["pool"], [[T_COLL_ON, T_COLL_OFF, T_EMODE, T_LIQ]], a, b, step=step):
            t0 = lg["topics"][0]
            bl, li = int(lg["blockNumber"], 16), int(lg["logIndex"], 16)
            if t0 in (T_COLL_ON, T_COLL_OFF):
                rows.append([bl, li, "CON" if t0 == T_COLL_ON else "COFF",
                             rs.get(to_addr(int(lg["topics"][1], 16)), -1), to_addr(int(lg["topics"][2], 16))])
            elif t0 == T_EMODE:
                rows.append([bl, li, "EM", to_addr(int(lg["topics"][1], 16)), words(lg["data"])[0]])
            else:
                w = words(lg["data"])
                rows.append([bl, li, "LIQ", rs.get(to_addr(int(lg["topics"][1], 16)), -1),
                             rs.get(to_addr(int(lg["topics"][2], 16)), -1), to_addr(int(lg["topics"][3], 16)),
                             w[0], w[1], to_addr(w[2]), lg["transactionHash"]])
        rows.sort(key=lambda r: (r[0], r[1]))
        tmp = out + ".tmp"
        with gzip.open(tmp, "wt") as f:
            for r in rows:
                f.write(json.dumps([str(x) if isinstance(x, int) and abs(x) > 2**53 else x for x in r]) + "\n")
        os.replace(tmp, out)
        print(f"[{meta['market']}] logs {a}-{b}: {len(rows)} rows  (rpc {c.n_requests})", flush=True)
        a = b + 1


def iter_logs(work: str):
    d = os.path.join(work, "logs")
    for fn in sorted(os.listdir(d)):
        if not fn.endswith(".jsonl.gz"):
            continue
        with gzip.open(os.path.join(d, fn), "rt") as f:
            for line in f:
                r = json.loads(line)
                yield [int(x) if isinstance(x, str) and x.lstrip("-").isdigit() else x for x in r]


# --------------------------------------------------------------------------------- daily state
SIG_INCOME = selector("getReserveNormalizedIncome(address)")
SIG_VDEBT = selector("getReserveNormalizedVariableDebt(address)")
SIG_CONF = selector("getConfiguration(address)")
SIG_PRICE = selector("getAssetPrice(address)")
SIG_EMODE_OLD = selector("getEModeCategoryData(uint8)")
SIG_EMODE_COLL = selector("getEModeCategoryCollateralConfig(uint8)")
SIG_EMODE_BITMAP = selector("getEModeCategoryCollateralBitmap(uint8)")


def daily_state(meta: dict, work: str, days: dict[int, int], emode_ids=range(0, 16)):
    """Per snapshot day: per reserve (normalized income, normalized variable debt, configuration, price);
    per e-mode category (lt, bonus, collateral bitmap or None for v3.0-3.1). Cached per day."""
    c = Client(meta["chain"])
    d = os.path.join(work, "state")
    os.makedirs(d, exist_ok=True)
    pool, orc = meta["pool"], meta["oracle"]
    for ts, blk in sorted(days.items()):
        out = os.path.join(d, f"{ts}.json")
        if os.path.exists(out) or blk < meta["pool_deploy_block"]:
            continue
        live = [(i, r) for i, r in enumerate(meta["reserves"]) if r["init_block"] <= blk]
        calls = []
        for i, r in live:
            ad = enc_addr(r["asset"])
            calls += [(pool, SIG_INCOME + ad), (pool, SIG_VDEBT + ad), (pool, SIG_CONF + ad), (orc, SIG_PRICE + ad)]
        for e in emode_ids:
            calls += [(pool, SIG_EMODE_OLD + enc_uint(e)), (pool, SIG_EMODE_COLL + enc_uint(e)),
                      (pool, SIG_EMODE_BITMAP + enc_uint(e))]
        res = c.multicall(calls, blk, chunk=120)
        st = {"block": blk, "reserves": {}, "emode": {}}
        k = 0
        for i, r in live:
            inc, vd, conf, px = res[k:k + 4]
            k += 4
            st["reserves"][str(i)] = {
                "income": str(words(inc)[0]) if inc else None,
                "vdebt": str(words(vd)[0]) if vd else None,
                "conf": str(words(conf)[0]) if conf else None,
                "price": str(words(px)[0]) if px else None,
            }
        for e in emode_ids:
            old, coll, bm = res[k:k + 3]
            k += 3
            ent = None
            if coll:
                w = words(coll)
                ent = {"ltv": w[0], "lt": w[1], "bonus": w[2], "bitmap": str(words(bm)[0]) if bm else None}
            elif old:
                w = words(old)
                # (ltv, lt, bonus, priceSource, label) — tuple head is an offset for the dynamic struct
                if len(w) >= 6 and w[0] == 32:
                    w = w[1:]
                ent = {"ltv": w[0], "lt": w[1], "bonus": w[2], "bitmap": None}
            if ent and ent["lt"]:
                st["emode"][str(e)] = ent
        json.dump(st, open(out, "w"))
    print(f"[{meta['market']}] daily state done (rpc {c.n_requests})", flush=True)


def conf_fields(conf: int) -> dict:
    return {
        "ltv": conf & 0xFFFF,
        "lt": (conf >> 16) & 0xFFFF,
        "bonus": (conf >> 32) & 0xFFFF,
        "decimals": (conf >> 48) & 0xFF,
        "active": (conf >> 56) & 1,
        "fee": (conf >> 152) & 0xFFFF,
        "emode_cat": (conf >> 168) & 0xFF,
    }


# ------------------------------------------------------------------------------------- replay
from classes import asset_class  # noqa: E402

# Same family schema as membrane-app research/history-forecasts sim1/liq.py positions() (commit 0dcd888), so the
# vendored call rule (callrule.py) applies unchanged. DU is folded into DO here (any non-shock debt).
REC_FIELDS = ("user", "VE", "VB", "VO", "ltE", "ltB", "ltO", "lbE", "lbB", "lbO", "feeE", "feeB", "feeO",
              "DE", "DB", "DO", "DmaxO", "hf")


def _emode_lt(st, cat, ri, conf):
    """(lt, bonus) for reserve ri for a user in e-mode `cat`, or None if e-mode does not apply."""
    if not cat:
        return None
    e = st["emode"].get(str(cat))
    if not e:
        return None
    if e["bitmap"] is not None:
        if (int(e["bitmap"]) >> ri) & 1:
            return e["lt"], e["bonus"]
        return None
    if conf_fields(conf)["emode_cat"] == cat:
        return e["lt"], e["bonus"]
    return None


def replay(meta: dict, work: str, days: dict[int, int], only_days: set | None = None):
    """Replay events; at each snapshot day write position records (one row per borrower with debt).
    Output: work/positions/<day_ts>.npy (structured float64 array; user as an index into users.json)."""
    import numpy as np
    out_dir = os.path.join(work, "positions")
    os.makedirs(out_dir, exist_ok=True)
    R = meta["reserves"]
    cls = [asset_class(meta["chain"], r["symbol"]) for r in R]
    A: dict[str, dict[int, int]] = {}
    V: dict[str, dict[int, int]] = {}
    coll: dict[str, set] = {}
    em: dict[str, int] = {}
    uid: dict[str, int] = {}
    sched = sorted((b, ts) for ts, b in days.items() if b >= meta["pool_deploy_block"])
    si = 0
    dtype = np.dtype([(f, "f8") for f in REC_FIELDS])

    def snapshot(ts):
        st = json.load(open(os.path.join(work, "state", f"{ts}.json")))
        rs = st["reserves"]
        px, inc, vdi, cf = {}, {}, {}, {}
        for k, v in rs.items():
            i = int(k)
            if v["price"] is None or v["income"] is None or v["conf"] is None:
                continue
            px[i] = int(v["price"]) / 1e8
            inc[i] = int(v["income"])
            vdi[i] = int(v["vdebt"])
            cf[i] = int(v["conf"])
        rows = []
        for u, dv in V.items():
            if not any(x > 0 for x in dv.values()):
                continue
            D = {"E": 0.0, "B": 0.0, "O": 0.0}
            dmaxo = 0.0
            for ri, s in dv.items():
                if s <= 0 or ri not in px:
                    continue
                val = ray_mul(s, vdi[ri]) / 10 ** R[ri]["decimals"] * px[ri]
                D[cls[ri]] += val
                if cls[ri] == "O":
                    dmaxo = max(dmaxo, val)
            V_ = {"E": 0.0, "B": 0.0, "O": 0.0}
            S_ = {"E": 0.0, "B": 0.0, "O": 0.0}
            LB_ = {"E": 0.0, "B": 0.0, "O": 0.0}
            FE_ = {"E": 0.0, "B": 0.0, "O": 0.0}
            cu = coll.get(u, set())
            for ri, s in A.get(u, {}).items():
                if s <= 0 or ri not in cu or ri not in px:
                    continue
                f = conf_fields(cf[ri])
                e = _emode_lt(st, em.get(u, 0), ri, cf[ri])
                lt, bonus = e if e else (f["lt"], f["bonus"])
                if lt == 0:
                    continue
                val = ray_mul(s, inc[ri]) / 10 ** R[ri]["decimals"] * px[ri]
                c = cls[ri]
                V_[c] += val
                S_[c] += val * lt / 1e4
                LB_[c] += val * bonus / 1e4
                FE_[c] += val * f["fee"] / 1e4
            dt = D["E"] + D["B"] + D["O"]
            if dt <= 0:
                continue
            hf = (S_["E"] + S_["B"] + S_["O"]) / dt
            if u not in uid:
                uid[u] = len(uid)
            q = lambda num, c, dflt: num[c] / V_[c] if V_[c] > 0 else dflt
            rows.append((uid[u], V_["E"], V_["B"], V_["O"], q(S_, "E", 0.0), q(S_, "B", 0.0), q(S_, "O", 0.0),
                         q(LB_, "E", 1.0), q(LB_, "B", 1.0), q(LB_, "O", 1.05), q(FE_, "E", 0.0), q(FE_, "B", 0.0),
                         q(FE_, "O", 0.1), D["E"], D["B"], D["O"], dmaxo, hf))
        arr = np.array(rows, dtype=dtype)
        # model population only (decision D6n): shock-linked collateral and >= $1 of debt
        arr = arr[(arr["VE"] + arr["VB"] > 0) & (arr["DE"] + arr["DB"] + arr["DO"] >= 1.0)] if len(arr) else arr
        np.save(os.path.join(out_dir, f"{ts}.npy"), arr)

    def flush_until(block):
        nonlocal si
        while si < len(sched) and sched[si][0] < block:
            ts = sched[si][1]
            if only_days is None or ts in only_days:
                if not os.path.exists(os.path.join(out_dir, f"{ts}.npy")):
                    snapshot(ts)
            si += 1

    for r in iter_logs(work):
        blk, kind = r[0], r[2]
        flush_until(blk)
        if kind in ("aM", "aB", "vM", "vB"):
            ri, u, amt, idx = r[3], r[4], r[5], r[6]
            d = ray_div(abs(amt), idx) * (1 if amt >= 0 else -1)
            if kind[1] == "B":
                d = -d
            book = A if kind[0] == "a" else V
            bu = book.setdefault(u, {})
            bu[ri] = bu.get(ri, 0) + d
        elif kind == "aX":
            ri, u1, u2, s = r[3], r[4], r[5], r[6]
            A.setdefault(u1, {})[ri] = A.setdefault(u1, {}).get(ri, 0) - s
            A.setdefault(u2, {})[ri] = A.setdefault(u2, {}).get(ri, 0) + s
        elif kind == "CON":
            coll.setdefault(r[4], set()).add(r[3])
        elif kind == "COFF":
            coll.setdefault(r[4], set()).discard(r[3])
        elif kind == "EM":
            em[r[3]] = r[4]
    flush_until(10**12)
    json.dump(sorted(uid, key=uid.get), open(os.path.join(work, "users.json"), "w"))


def gho_fix(meta: dict, work: str, days: dict[int, int]):
    """GHO on Aave Core: GhoVariableDebtToken applies the stkAAVE discount by burning scaled balance with no
    event, so the replay overstates GHO debt. For every day, read balanceOf(user) on the GHO debt token for
    every account the replay shows with GHO debt, and replace that account's GHO debt in the records.
    Records are rewritten in place; a marker file makes the step idempotent."""
    import numpy as np
    gi = [i for i, r in enumerate(meta["reserves"]) if r["symbol"].upper() == "GHO"]
    if not gi:
        return
    gi = gi[0]
    vtok = meta["reserves"][gi]["vDebt"]
    mark = os.path.join(work, "gho-fix.json")
    done = json.load(open(mark)) if os.path.exists(mark) else {}
    c = Client(meta["chain"])
    uid = {u: i for i, u in enumerate(json.load(open(os.path.join(work, "users.json"))))}
    V: dict[str, int] = {}
    sched = sorted((b, ts) for ts, b in days.items() if b >= meta["pool_deploy_block"])
    si = 0
    sel_bal = selector("balanceOf(address)")
    stats = {"days": 0, "accounts": 0, "abs_usd_fixed": 0.0}

    def fix(ts, blk):
        p = os.path.join(work, "positions", f"{ts}.npy")
        if str(ts) in done or not os.path.exists(p):
            return
        users = [u for u, s in V.items() if s > 0 and u in uid]
        st = json.load(open(os.path.join(work, "state", f"{ts}.json")))
        rs = st["reserves"].get(str(gi))
        if not users or not rs or rs["price"] is None:
            done[str(ts)] = 0
            return
        px = int(rs["price"]) / 1e8
        vdi = int(rs["vdebt"])
        res = c.multicall([(vtok, sel_bal + enc_addr(u)) for u in users], blk, chunk=300)
        arr = np.load(p)
        pos = {int(x): k for k, x in enumerate(arr["user"])}
        dec = meta["reserves"][gi]["decimals"]
        n = 0
        for u, r in zip(users, res):
            if r is None or uid[u] not in pos:
                continue
            k = pos[uid[u]]
            real = int.from_bytes(r[:32], "big") / 10 ** dec * px
            rep = ray_mul(V[u], vdi) / 10 ** dec * px
            delta = real - rep
            if abs(delta) < 1e-9:
                continue
            arr["DO"][k] = max(0.0, arr["DO"][k] + delta)
            if abs(arr["DmaxO"][k] - rep) < 1e-6 * max(1.0, rep) or arr["DmaxO"][k] < real:
                arr["DmaxO"][k] = max(real, arr["DmaxO"][k] + min(0.0, delta))
            dt = arr["DE"][k] + arr["DB"][k] + arr["DO"][k]
            num = arr["ltE"][k] * arr["VE"][k] + arr["ltB"][k] * arr["VB"][k] + arr["ltO"][k] * arr["VO"][k]
            arr["hf"][k] = num / dt if dt > 0 else np.inf
            n += 1
            stats["abs_usd_fixed"] += abs(delta)
        np.save(p, arr)
        done[str(ts)] = n
        stats["days"] += 1
        stats["accounts"] += n
        if stats["days"] % 50 == 0:
            json.dump(done, open(mark, "w"))

    for r in iter_logs(work):
        blk = r[0]
        while si < len(sched) and sched[si][0] < blk:
            fix(sched[si][1], sched[si][0])
            si += 1
        if r[2] in ("vM", "vB") and r[3] == gi:
            d = ray_div(abs(r[5]), r[6]) * (1 if r[5] >= 0 else -1)
            if r[2] == "vB":
                d = -d
            V[r[4]] = V.get(r[4], 0) + d
    while si < len(sched):
        fix(sched[si][1], sched[si][0])
        si += 1
    json.dump(done, open(mark, "w"))
    print(f"[{meta['market']}] gho fix", stats, flush=True)
