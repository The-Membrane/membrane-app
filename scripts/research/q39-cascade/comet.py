"""Compound V3 (Comet) markets with a USD-stable base: daily position records (prereg C.2.1, deviation D1).

Collateral balances are exact from SupplyCollateral / WithdrawCollateral / TransferCollateral /
AbsorbCollateral events. The borrow balance is read by archive eth_call `borrowBalanceOf(user)` at each
snapshot block, for every account then holding ETH- or BTC-linked collateral. Asset configs, prices,
reserves, targetReserves and storeFrontPriceFactor are read at the same block.
Absorb is whole-account; absorbed collateral enters reserves and is sold only via buyCollateral (C.3.1).
"""
from __future__ import annotations

import gzip
import json
import os

from classes import asset_class
from rpc import Client, Reverted, RpcError, enc_addr, selector, signed, to_addr, topic, words
import aave as _a

COMETS = {
    "ethereum": ["0xc3d688B66703497DAA19211EEdff47f25384cdc3", "0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840",
                 "0x5D409e56D886231aDAf00c8775665AD0f9897b56"],
    "arbitrum": ["0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf", "0xA5EDBDD9646f8dFF606d7448e414884C7d905dCA",
                 "0xd98Be00b5D27fc98112BdE293e487f8D4cA57d07"],
    "base": ["0xb125E6687d4313864e53df431d5425969c15Eb2F", "0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf"],
    "optimism": ["0x2e44e174f7D53F0212823acC11C01A11d58c5bCB", "0x995E394b8B2437aC8Ce61Ee0bC610D617962B214"],
}

T_SUPC = topic("SupplyCollateral(address,address,address,uint256)")
T_WITHC = topic("WithdrawCollateral(address,address,address,uint256)")
T_XFERC = topic("TransferCollateral(address,address,address,uint256)")
T_ABSC = topic("AbsorbCollateral(address,address,address,uint256,uint256)")
T_ABSD = topic("AbsorbDebt(address,address,uint256,uint256)")
T_BUYC = topic("BuyCollateral(address,address,uint256,uint256)")


def discover(chain: str, work: str) -> dict:
    p = os.path.join(work, "meta.json")
    if os.path.exists(p):
        return json.load(open(p))
    c = Client(chain)
    out = {"chain": chain, "comets": {}}
    for cm in COMETS[chain]:
        base = to_addr(words(c.eth_call(cm, selector("baseToken()")))[0])
        bsym = _a._decode_string(c.eth_call(base, selector("symbol()")))
        if asset_class(chain, bsym) != "O":
            continue
        n = words(c.eth_call(cm, selector("numAssets()")))[0]
        assets = []
        for i in range(n):
            w = words(c.eth_call(cm, selector("getAssetInfo(uint8)") + hex(i)[2:].rjust(64, "0")))
            a = to_addr(w[1])
            sym = _a._decode_string(c.eth_call(a, selector("symbol()")))
            assets.append({"asset": a, "symbol": sym, "cls": asset_class(chain, sym), "scale": w[3]})
        out["comets"][cm.lower()] = {"base": base, "bsym": bsym,
                                     "bdec": words(c.eth_call(base, selector("decimals()")))[0],
                                     "deploy": _a.deploy_block(c, cm), "assets": assets}
    json.dump(out, open(p, "w"), indent=1)
    return out


def fetch(meta: dict, work: str, to_block: int, step=500_000):
    c = Client(meta["chain"])
    os.makedirs(os.path.join(work, "logs"), exist_ok=True)
    for cm, v in meta["comets"].items():
        a = v["deploy"]
        while a <= to_block:
            b = min(to_block, a + step - 1)
            out = os.path.join(work, "logs", f"{cm}-{a:010d}-{b:010d}.jsonl.gz")
            if os.path.exists(out):
                a = b + 1
                continue
            rows = []
            for lg in c.get_logs(cm, [[T_SUPC, T_WITHC, T_XFERC, T_ABSC, T_ABSD, T_BUYC]], a, b, step=step):
                t0, tp = lg["topics"][0], lg["topics"]
                w = words(lg["data"])
                bl, li = int(lg["blockNumber"], 16), int(lg["logIndex"], 16)
                A1, A2 = to_addr(int(tp[1], 16)), to_addr(int(tp[2], 16))
                if t0 == T_SUPC:
                    rows.append([bl, li, "SC", to_addr(int(tp[3], 16)), A2, w[0]])
                elif t0 == T_WITHC:
                    rows.append([bl, li, "WC", to_addr(int(tp[3], 16)), A1, w[0]])
                elif t0 == T_XFERC:
                    rows.append([bl, li, "XC", to_addr(int(tp[3], 16)), A1, A2, w[0]])
                elif t0 == T_ABSC:
                    rows.append([bl, li, "AC", to_addr(int(tp[3], 16)), A2, w[0], w[1], lg["transactionHash"]])
                elif t0 == T_ABSD:
                    rows.append([bl, li, "AD", A2, w[0], w[1], lg["transactionHash"]])
                else:
                    rows.append([bl, li, "BC", A2, A1, w[0], w[1], lg["transactionHash"]])
            rows.sort(key=lambda r: (r[0], r[1]))
            tmp = out + ".tmp"
            with gzip.open(tmp, "wt") as f:
                for r in rows:
                    f.write(json.dumps([str(x) if isinstance(x, int) and abs(x) > 2**53 else x for x in r]) + "\n")
            os.replace(tmp, out)
            print(f"[comet-{meta['chain']}] {cm[:8]} logs {a}-{b}: {len(rows)} rows (rpc {c.n_requests})", flush=True)
            a = b + 1


def iter_logs(work, cm):
    d = os.path.join(work, "logs")
    for fn in sorted(os.listdir(d)):
        if fn.startswith(cm) and fn.endswith(".jsonl.gz"):
            with gzip.open(os.path.join(d, fn), "rt") as f:
                for line in f:
                    r = json.loads(line)
                    yield [int(x) if isinstance(x, str) and x.isdigit() else x for x in r]


def holders_by_day(meta: dict, work: str, days: dict[int, int]) -> "Holders":
    """E/B collateral holders per (comet, day), one gzip JSON per (comet, day) under work/holders/ (resumable;
    a single all-days dict exhausted memory on Optimism)."""
    d = os.path.join(work, "holders")
    os.makedirs(d, exist_ok=True)
    for cm, v in meta["comets"].items():
        done = os.path.join(d, f"{cm}.done")
        if os.path.exists(done):
            continue
        keep = {a["asset"].lower() for a in v["assets"] if a["cls"] in ("E", "B")}
        bal: dict[str, dict[str, int]] = {}
        sched = sorted((b, ts) for ts, b in days.items() if b >= v["deploy"])
        si = 0

        def flush(block):
            nonlocal si
            while si < len(sched) and sched[si][0] < block:
                ts = sched[si][1]
                snap = {u: {a: x for a, x in dd.items() if x > 0} for u, dd in bal.items()
                        if any(x > 0 for x in dd.values())}
                with gzip.open(os.path.join(d, f"{cm}-{ts}.json.gz"), "wt") as f:
                    json.dump(snap, f)
                si += 1

        for r in iter_logs(work, cm):
            flush(r[0])
            k = r[2]
            if k in ("SC", "WC", "AC"):
                a = r[3].lower()
                if a not in keep:
                    continue
                u = r[4]
                sgn = 1 if k == "SC" else -1
                bal.setdefault(u, {})[a] = bal.setdefault(u, {}).get(a, 0) + sgn * r[5]
            elif k == "XC":
                a = r[3].lower()
                if a not in keep:
                    continue
                bal.setdefault(r[4], {})[a] = bal.setdefault(r[4], {}).get(a, 0) - r[6]
                bal.setdefault(r[5], {})[a] = bal.setdefault(r[5], {}).get(a, 0) + r[6]
        flush(10**12)
        open(done, "w").write("ok")
    return Holders(d)


class Holders:
    """holders[cm].get(str(ts), {}) interface over the per-day files."""
    def __init__(self, d):
        self.d = d

    def __getitem__(self, cm):
        d = self.d

        class _One:
            def get(self, ts, default=None):
                p = os.path.join(d, f"{cm}-{ts}.json.gz")
                return json.load(gzip.open(p, "rt")) if os.path.exists(p) else default
        return _One()


S_BB = selector("borrowBalanceOf(address)")
S_AINFO = selector("getAssetInfoByAddress(address)")
S_PRICE = selector("getPrice(address)")
S_BFEED = selector("baseTokenPriceFeed()")
S_RES = selector("getReserves()")
S_TRES = selector("targetReserves()")
S_SFPF = selector("storeFrontPriceFactor()")


def daily_state(meta: dict, work: str, days: dict[int, int], holders: dict):
    c = Client(meta["chain"])
    d = os.path.join(work, "state")
    os.makedirs(d, exist_ok=True)
    for cm, v in meta["comets"].items():
        keep = [a for a in v["assets"] if a["cls"] in ("E", "B")]
        for ts, blk in sorted(days.items()):
            out = os.path.join(d, f"{cm}-{ts}.json")
            if os.path.exists(out) or blk < v["deploy"]:
                continue
            users = sorted(holders[cm].get(str(ts), {}))
            calls = [(cm, S_BFEED), (cm, S_RES), (cm, S_TRES), (cm, S_SFPF)]
            calls += [(cm, S_AINFO + enc_addr(a["asset"])) for a in keep]
            calls += [(cm, S_BB + enc_addr(u)) for u in users]
            res = c.multicall(calls, blk, chunk=200)
            st = {"block": blk, "assets": {}, "bb": {}}
            bfeed = to_addr(words(res[0])[0]) if res[0] else None
            st["reserves"] = signed(words(res[1])[0]) if res[1] else None
            st["target"] = words(res[2])[0] if res[2] else None
            st["sfpf"] = words(res[3])[0] if res[3] else None
            feeds = []
            for j, a in enumerate(keep):
                r = res[4 + j]
                if r is None:
                    continue
                w = words(r)
                st["assets"][a["asset"].lower()] = {"feed": to_addr(w[2]), "scale": w[3], "bcf": w[4], "lcf": w[5],
                                                    "lf": w[6]}
                feeds.append(to_addr(w[2]))
            for j, u in enumerate(users):
                r = res[4 + len(keep) + j]
                if r:
                    st["bb"][u] = str(words(r)[0])
            pc = [(cm, S_PRICE + enc_addr(f)) for f in ([bfeed] if bfeed else []) + feeds]
            pr = c.multicall(pc, blk)
            if bfeed:
                st["bpx"] = words(pr[0])[0] / 1e8 if pr[0] else None
                pr = pr[1:]
            for f, r in zip(feeds, pr):
                for a, info in st["assets"].items():
                    if info["feed"] == f and r:
                        info["px"] = words(r)[0] / 1e8
            json.dump(st, open(out + ".tmp", "w"))
            os.replace(out + ".tmp", out)
    print(f"[comet-{meta['chain']}] daily state done (rpc {c.n_requests})", flush=True)


from aave import REC_FIELDS  # noqa: E402  (shared family schema)


def replay(meta: dict, work: str, days: dict[int, int], holders: dict):
    """Position records. lbE/lbB carry 1 + the buyCollateral discount storeFront*(1-liquidationFactor) (C.3.1);
    ltE/ltB carry liquidateCollateralFactor."""
    import numpy as np
    out_dir = os.path.join(work, "positions")
    os.makedirs(out_dir, exist_ok=True)
    uid: dict[str, int] = {}
    dtype = np.dtype([(f, "f8") for f in REC_FIELDS] + [("comet", "i8")])
    cms = sorted(meta["comets"])
    for ts in sorted(days):
        rows = []
        for ci, cm in enumerate(cms):
            v = meta["comets"][cm]
            p = os.path.join(work, "state", f"{cm}-{ts}.json")
            if not os.path.exists(p):
                continue
            st = json.load(open(p))
            cls = {a["asset"].lower(): a["cls"] for a in v["assets"]}
            bpx = st.get("bpx") or 1.0
            for u, hold in holders[cm].get(str(ts), {}).items():
                bb = int(st["bb"].get(u, "0"))
                if bb <= 0:
                    continue
                debt = bb / 10 ** v["bdec"] * bpx
                C = {"E": 0.0, "B": 0.0}
                Cv = {"E": 0.0, "B": 0.0}
                disc = {"E": 0.0, "B": 0.0}
                for a, amt in hold.items():
                    info = st["assets"].get(a)
                    if not info or "px" not in info:
                        continue
                    val = amt / info["scale"] * info["px"]
                    k = cls[a]
                    C[k] += val * info["lcf"] / 1e18
                    Cv[k] += val
                    disc[k] += val * (st["sfpf"] or 0) / 1e18 * (1 - info["lf"] / 1e18)
                if u not in uid:
                    uid[u] = len(uid)
                q = lambda num, k: num[k] / Cv[k] if Cv[k] > 0 else 0.0
                rows.append((uid[u], Cv["E"], Cv["B"], 0.0, q(C, "E"), q(C, "B"), 0.0, 1.0 + q(disc, "E"),
                             1.0 + q(disc, "B"), 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, debt, debt,
                             (C["E"] + C["B"]) / debt, ci))
        arr = np.array(rows, dtype=dtype)
        # model population only (decision D6n): shock-linked collateral and >= $1 of debt
        arr = arr[(arr["VE"] + arr["VB"] > 0) & (arr["DE"] + arr["DB"] + arr["DO"] >= 1.0)] if len(arr) else arr
        np.save(os.path.join(out_dir, f"{ts}.npy"), arr)
    json.dump({"users": sorted(uid, key=uid.get), "comets": cms}, open(os.path.join(work, "index.json"), "w"))
