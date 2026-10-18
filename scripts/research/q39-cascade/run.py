"""Q39 pipeline after acquisition (prereg C.2–C.7, run order C.10).

  python3 run.py reader        C.2.1 reader check (200 seeded (position, day) pairs vs archive eth_call)
  python3 run.py audit-draw    C.7.2 seeded 30-transaction audit draw (before any fit)
  python3 run.py sellthrough   C.2.2 development-span sell-through per venue
  python3 run.py morpho-fm     C.3.1 Morpho development median repaid fraction
  python3 run.py impact        C.3.4 fit Y' (and naive lambda) on development episodes
  python3 run.py schedules     C.3 per-day seizure schedules for every origin
  python3 run.py dev           C.5/C.6 development fits and kill rule
Everything writes JSON under $Q39_WORK/results/. No test-span label is read before `freeze`.
"""
from __future__ import annotations

import gzip
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import cascade as CS  # noqa: E402
import model as MD  # noqa: E402
from classes import asset_class  # noqa: E402
from rpc import Client, enc_addr, selector, to_addr, words  # noqa: E402

WORK = os.environ.get("Q39_WORK", "/home/user/q39work")
DATASETS = os.environ.get("MEMBRANE_DATASETS_DIR", "/home/user/membrane-datasets")
RES = os.path.join(WORK, "results")
SEED = 20261018

AAVE = ["aave-core-eth", "aave-prime-eth", "spark-eth", "aave-arb", "aave-op", "aave-base"]
MORPHO = ["morpho-ethereum", "morpho-base"]
COMET = ["comet-ethereum", "comet-arbitrum", "comet-base", "comet-optimism"]
CHAIN = {"aave-core-eth": "ethereum", "aave-prime-eth": "ethereum", "spark-eth": "ethereum", "aave-arb": "arbitrum",
         "aave-op": "optimism", "aave-base": "base", "morpho-ethereum": "ethereum", "morpho-base": "base",
         "comet-ethereum": "ethereum", "comet-arbitrum": "arbitrum", "comet-base": "base",
         "comet-optimism": "optimism"}


def days_of(chain):
    d = json.load(open(os.path.join(WORK, "days", f"{chain}.json")))
    return {int(k): v for k, v in d.items() if int(k) >= 1672531200}


def rec_path(venue, ts):
    return os.path.join(WORK, venue, "positions", f"{ts}.npy")


def dev_day(ts):
    return MD.DEV[0] <= ts <= MD.DEV[1]


def save(name, obj):
    os.makedirs(RES, exist_ok=True)
    json.dump(obj, open(os.path.join(RES, name), "w"), indent=1, default=float)


def load(name):
    return json.load(open(os.path.join(RES, name)))


# ------------------------------------------------------------------------------------- reader check
def reader():
    """C.2.1: 200 (position, day) pairs, seed 20261018, uniform over all development-span record rows of every
    venue. Aave-style: getUserAccountData. Morpho: position()+market()+oracle price(). Comet: userCollateral +
    borrowBalanceOf. Pass = |rel diff| <= 0.01% on HF, total collateral and total debt."""
    pool = []
    for v in AAVE + MORPHO + COMET:
        d = os.path.join(WORK, v, "positions")
        if not os.path.isdir(d):
            continue
        for fn in sorted(os.listdir(d)):
            ts = int(fn[:-4])
            if not dev_day(ts):
                continue
            a = np.load(os.path.join(d, fn))
            keep = np.where(a["DE"] + a["DB"] + a["DO"] >= CS.DUST_USD)[0]
            pool.append((v, ts, keep))
    tot = sum(len(k) for _, _, k in pool)
    rng = np.random.default_rng(SEED)
    picks = sorted(rng.choice(tot, 200, replace=False))
    sel, acc, j = [], 0, 0
    for v, ts, keep in pool:
        n = len(keep)
        while j < len(picks) and picks[j] < acc + n:
            sel.append((v, ts, int(keep[picks[j] - acc])))
            j += 1
        acc += n
    out = []
    for v, ts, row in sel:
        out.append(_check_one(v, ts, row))
    ok = [o for o in out if o.get("pass")]
    save("reader-check.json", {"n": len(out), "pass": len(ok), "pairs": out,
                               "rule": "|rel| <= 1e-4 on hf, collateral, debt"})
    print("reader check", len(ok), "/", len(out))


def _rel(a, b):
    return abs(a - b) / max(abs(b), 1e-12)


def _check_one(v, ts, row):
    ch = CHAIN[v]
    blk = days_of(ch)[ts]
    rec = np.load(rec_path(v, ts))[row]
    c = Client(ch)
    if v in AAVE:
        users = json.load(open(os.path.join(WORK, v, "users.json")))
        u = users[int(rec["user"])]
        meta = json.load(open(os.path.join(WORK, v, "meta.json")))
        w = words(c.eth_call(meta["pool"], selector("getUserAccountData(address)") + enc_addr(u), blk))
        coll, debt, hf = w[0] / 1e8, w[1] / 1e8, w[5] / 1e18
        mc, md_, mh = rec["VE"] + rec["VB"] + rec["VO"], rec["DE"] + rec["DB"] + rec["DO"], rec["hf"]
    elif v in MORPHO:
        idx = json.load(open(os.path.join(WORK, v, "index.json")))
        mk = json.load(open(os.path.join(WORK, v, "markets.json")))["markets"]
        u = idx["users"][int(rec["user"])]
        mid = idx["markets"][int(rec["market"])]
        M = mk[mid]
        from morpho import MORPHO as MB
        pw = words(c.eth_call(MB, selector("position(bytes32,address)") + mid[2:] + enc_addr(u), blk))
        mw = words(c.eth_call(MB, selector("market(bytes32)") + mid[2:], blk))
        pr = words(c.eth_call(M["oracle"], selector("price()"), blk))[0]
        st = json.load(open(os.path.join(WORK, v, "state", f"{ts}.json")))
        lpx = st["loanpx"].get(M["loan"].lower(), 1.0) if M["loan_price"] == "aave" else 1.0
        debt = pw[1] * mw[2] / mw[3] / 10 ** M["ldec"] * lpx if mw[3] else 0.0
        coll = pw[2] * pr / 1e36 / 10 ** M["ldec"] * lpx
        hf = coll * M["lltv"] / 1e18 / debt if debt else float("inf")
        mc, md_, mh = rec["VE"] + rec["VB"], rec["DO"], rec["hf"]
    else:
        idx = json.load(open(os.path.join(WORK, v, "index.json")))
        meta = json.load(open(os.path.join(WORK, v, "meta.json")))
        u = idx["users"][int(rec["user"])]
        cm = idx["comets"][int(rec["comet"])]
        st = json.load(open(os.path.join(WORK, v, "state", f"{cm}-{ts}.json")))
        coll_lt, coll = 0.0, 0.0
        for a, info in st["assets"].items():
            bal = words(c.eth_call(cm, selector("userCollateral(address,address)") + enc_addr(u) + enc_addr(a), blk))[0]
            val = bal / info["scale"] * info.get("px", 0.0)
            coll += val
            coll_lt += val * info["lcf"] / 1e18
        bb = words(c.eth_call(cm, selector("borrowBalanceOf(address)") + enc_addr(u), blk))[0]
        debt = bb / 10 ** meta["comets"][cm]["bdec"] * (st.get("bpx") or 1.0)
        hf = coll_lt / debt if debt else float("inf")
        mc, md_, mh = rec["VE"] + rec["VB"], rec["DO"], rec["hf"]
    r = {"venue": v, "day": ts, "block": blk, "chain_coll": coll, "chain_debt": debt, "chain_hf": hf,
         "rec_coll": float(mc), "rec_debt": float(md_), "rec_hf": float(mh)}
    r["rel_hf"], r["rel_coll"], r["rel_debt"] = _rel(mh, hf), _rel(mc, coll), _rel(md_, debt)
    r["pass"] = bool(max(r["rel_hf"], r["rel_coll"], r["rel_debt"]) <= 1e-4)
    return r


# ------------------------------------------------------------------------------- liquidation events
LIQ_FILES = {v: v for v in AAVE + MORPHO}


def _liq_raw(name):
    p = os.path.join(WORK, "liq", f"{name}.json.gz")
    return json.load(gzip.open(p, "rt")) if os.path.exists(p) else []


_PX_CACHE: dict = {}


def _aave_state_px(market, ts):
    """{asset(lower): USD price} from an Aave-style market's daily state (cached)."""
    key = (market, ts)
    if key not in _PX_CACHE:
        p = os.path.join(WORK, market, "state", f"{ts}.json")
        meta = json.load(open(os.path.join(WORK, market, "meta.json")))
        out = {}
        if os.path.exists(p):
            st = json.load(open(p))
            for k, v in st["reserves"].items():
                if v["price"]:
                    out[meta["reserves"][int(k)]["asset"].lower()] = int(v["price"]) / 1e8
        _PX_CACHE[key] = out
    return _PX_CACHE[key]


REF_AAVE = {"ethereum": "aave-core-eth", "arbitrum": "aave-arb", "optimism": "aave-op", "base": "aave-base"}
REF_SYM = {"E": ("WETH",), "B": ("WBTC", "CBBTC")}


def _ratio_book(chain, ts):
    """Token -> class-equivalent ratio (price / reference WETH or BTC price) at the day, from the chain's Aave."""
    mk = REF_AAVE[chain]
    meta = json.load(open(os.path.join(WORK, mk, "meta.json")))
    px = _aave_state_px(mk, ts)
    sym = {r["asset"].lower(): r["symbol"].upper() for r in meta["reserves"]}
    ref = {}
    for c, names in REF_SYM.items():
        for a, s_ in sym.items():
            if s_ in names and a in px:
                ref[c] = px[a]
                break
    out = {}
    for a, p_ in px.items():
        c = asset_class(chain, sym[a])
        if c in ref:
            out[a] = p_ / ref[c]
    return out, ref


def day_of(t):
    return t - t % 86400


def liq_events():
    """Decoded liquidation events, all venues: venue, chain, ts, tx, cls, units (token), token, usd(day px), extra."""
    out = []
    for v in AAVE:
        mp = os.path.join(WORK, v, "meta.json")
        if not os.path.exists(mp):
            continue
        meta = json.load(open(mp))
        sym = {r["asset"].lower(): (r["symbol"], r["decimals"]) for r in meta["reserves"]}
        for e in _liq_raw(v):
            ca = to_addr(int(e["topics"][1], 16)).lower()
            w = words(e["data"])
            s_, dec = sym.get(ca, ("?", 18))
            out.append({"venue": v, "chain": meta["chain"], "ts": e["ts"], "block": e["block"], "logIndex": e["logIndex"],
                        "tx": e["tx"], "token": ca, "cls": asset_class(meta["chain"], s_), "units": w[1] / 10 ** dec,
                        "receiveAToken": bool(w[3]), "kind": "liq"})
    for v in MORPHO:
        ch = CHAIN[v]
        mp = os.path.join(WORK, v, "markets.json")
        if not os.path.exists(mp):
            continue
        mk = json.load(open(mp))["markets"]
        for e in _liq_raw(v):
            mid = e["topics"][1]
            if mid not in mk:
                continue
            M = mk[mid]
            w = words(e["data"])
            out.append({"venue": v, "chain": ch, "ts": e["ts"], "block": e["block"], "logIndex": e["logIndex"],
                        "tx": e["tx"], "token": M["coll"].lower(), "cls": M["cls"], "units": w[2] / 10 ** M["cdec"],
                        "kind": "liq", "market": mid, "repaidShares": w[1], "borrower": "0x" + e["topics"][3][-40:]})
    for v in COMET:
        ch = CHAIN[v]
        mp = os.path.join(WORK, v, "meta.json")
        if not os.path.exists(mp):
            continue
        meta = json.load(open(mp))
        for cm, cv in meta["comets"].items():
            info = {a["asset"].lower(): a for a in cv["assets"]}
            for e in _liq_raw(f"{v}-{cm[:8]}"):
                from comet import T_ABSC
                a = to_addr(int(e["topics"][3 if e["topics"][0] == T_ABSC else 2], 16)).lower()
                if a not in info or info[a]["cls"] == "O":
                    continue
                w = words(e["data"])
                kind = "absorb" if e["topics"][0] == T_ABSC else "buy"
                units = (w[0] if kind == "absorb" else w[1]) / info[a]["scale"]
                out.append({"venue": v, "chain": ch, "ts": e["ts"], "block": e["block"], "logIndex": e["logIndex"],
                            "tx": e["tx"], "token": a, "cls": info[a]["cls"], "units": units, "kind": kind,
                            "comet": cm})
    for e in out:
        rb, ref = _ratio_book(e["chain"], day_of(e["ts"])) if e["ts"] >= 1672531200 else ({}, {})
        e["eq"] = e["units"] * rb.get(e["token"], 1.0)          # class-equivalent units (ETH or BTC)
        e["usd_day"] = e["eq"] * ref.get(e["cls"], float("nan"))
    out.sort(key=lambda e: (e["ts"], e["block"], e["logIndex"]))
    return out


def _dev_event(e):
    return MD.DEV[0] <= e["ts"] < MD.TEST_START and not MD.stress_purged(day_of(e["ts"]), 0) \
        and e["cls"] in ("E", "B")


def audit_draw():
    """C.7.2: 30 development-span liquidation transactions, seed 20261018, drawn before any fit."""
    ev = [e for e in liq_events() if _dev_event(e) and e["kind"] in ("liq", "buy")]
    txs = sorted({(e["venue"], e["chain"], e["tx"]) for e in ev})
    rng = np.random.default_rng(SEED)
    pick = [txs[i] for i in sorted(rng.choice(len(txs), 30, replace=False))]
    save("audit-draw.json", {"seed": SEED, "population": len(txs), "draw": pick})
    print("audit draw from", len(txs))


def sellthrough():
    import sellthrough as ST
    ev = [e for e in liq_events() if _dev_event(e) and e["kind"] in ("liq", "buy")]
    res = {}
    for v in AAVE + MORPHO + COMET:
        items = [e for e in ev if e["venue"] == v]
        if not items:
            continue
        ch = CHAIN[v]
        sm = ST.sample([{"tx": e["tx"], "block": e["block"], "logIndex": e["logIndex"], "e": e} for e in items])
        jobs = []
        for s_ in sm:
            es = [x["e"] for x in s_["events"]]
            cls = max(("E", "B"), key=lambda c: sum(x["usd_day"] for x in es if x["cls"] == c))
            rb, _ = _ratio_book(ch, day_of(es[0]["ts"]))
            jobs.append({"tx": s_["tx"], "cls": cls, "block": es[0]["block"], "ratio": rb,
                         "seized": sum(x["eq"] for x in es if x["cls"] == cls),
                         "usd": sum(x["usd_day"] for x in es if x["cls"] == cls)})
        book = ST.TokenBook(ch, os.path.join(WORK, f"tokens-{ch}.json"))
        outp = os.path.join(RES, f"sellthrough-{v}.jsonl")
        os.makedirs(RES, exist_ok=True)
        ST.run(ch, jobs, book, outp)
        got = {}
        for line in open(outp):
            r = json.loads(line)
            got[r["tx"]] = r
        usd = {j["tx"]: j["usd"] for j in jobs}
        num = den = 0.0
        n_err = 0
        for t, r in got.items():
            if "error" in r or r.get("st") is None or t not in usd or not np.isfinite(usd[t]):
                n_err += 1
                continue
            num += r["st"] * usd[t]
            den += usd[t]
        res[v] = {"s": num / den if den else 0.0, "n_tx": len(got) - n_err, "n_err": n_err,
                  "population_tx": len({e["tx"] for e in items}), "usd_sampled": den}
        print(v, res[v], flush=True)
    save("sellthrough.json", res)


def morpho_fm():
    """Development median of repaidShares / borrow shares just before the liquidation (relevant markets)."""
    import morpho as MO
    fr = []
    for v in MORPHO:
        w = os.path.join(WORK, v)
        if not os.path.exists(os.path.join(w, "markets.json")):
            continue
        M = json.load(open(os.path.join(w, "markets.json")))["markets"]
        shares = {}
        for r in MO.iter_logs(w):
            k, m = r[2], r[3]
            if m not in M:
                continue
            u = r[4]
            if k == "B":
                shares[(m, u)] = shares.get((m, u), 0) + r[6]
            elif k == "R":
                shares[(m, u)] = shares.get((m, u), 0) - r[6]
            elif k == "L":
                before = shares.get((m, u), 0)
                if before > 0:
                    fr.append((r[0], v, min(1.0, (r[6] + r[9]) / before)))
                shares[(m, u)] = before - r[6] - r[9]
    days = {v: days_of(CHAIN[v]) for v in MORPHO}
    dev = []
    for blk, v, f in fr:
        # block -> day via the snapshot table
        ts = max((t for t, b in days[v].items() if b <= blk), default=None)
        if ts is not None and MD.DEV[0] <= ts < MD.TEST_START and not MD.stress_purged(ts, 0):
            dev.append(f)
    save("morpho-fm.json", {"fM": float(np.median(dev)) if dev else 1.0, "n": len(dev),
                            "q25": float(np.quantile(dev, 0.25)) if dev else None,
                            "q75": float(np.quantile(dev, 0.75)) if dev else None})
    print("fM", np.median(dev) if dev else None, len(dev))


# ------------------------------------------------------------------------------------------ impact
def _rounds(asset):
    import chainlink
    return chainlink.load(os.path.join(WORK, "chainlink", f"{asset}-usd.csv.gz"))


def _sigma_at(series, t):
    start, close, _ = series
    i = (t - start) // 3600
    lr = np.diff(np.log(close[max(0, i - 721): i]))
    lr = lr[np.isfinite(lr)]
    return float(np.sqrt(24.0 * np.mean(lr ** 2))) if len(lr) > 600 else float("nan")


def impact_episodes(asset, s_v, span=("dev",)):
    """Episodes: oracle-print intervals [t_k, t_{k+1}) with on-chain sold flow of class A > 0.
    x = -sigma_daily * sqrt(Q) (Q in USD at the round price), r = next-interval log return ln(P_{k+2}/P_{k+1})."""
    cls = {"eth": "E", "btc": "B"}[asset]
    rt, ra = _rounds(asset)
    series = MD.load_series(DATASETS, asset)
    ev = [e for e in liq_events() if e["cls"] == cls and e["kind"] in ("liq", "buy")]
    Q, Qall = {}, {}
    for e in ev:
        if "dev" in span and not _dev_event(e):
            continue
        k = int(np.searchsorted(rt, e["ts"], side="right") - 1)
        if k < 0 or k + 2 >= len(rt):
            continue
        usd = e["eq"] * ra[k]
        Q[k] = Q.get(k, 0.0) + usd * s_v.get(e["venue"], 0.0)
        Qall[k] = Qall.get(k, 0.0) + usd
    rows = []
    for k in sorted(Qall):
        sig = _sigma_at(series, int(rt[k]))
        if not np.isfinite(sig):
            continue
        rows.append({"k": k, "t": int(rt[k]), "day": day_of(int(rt[k])), "Q": Q.get(k, 0.0), "Qall": Qall[k],
                     "sigma": sig, "r": float(np.log(ra[k + 2] / ra[k + 1]))})
    return rows


def _boot_ratio(rows, fx, fy, reps=2000, block=30):
    days = sorted({r["day"] for r in rows})
    di = {d: i for i, d in enumerate(days)}
    sxy = np.zeros(len(days))
    sxx = np.zeros(len(days))
    for r in rows:
        x, y = fx(r), fy(r)
        sxy[di[r["day"]]] += x * y
        sxx[di[r["day"]]] += x * x
    est = sxy.sum() / sxx.sum() if sxx.sum() > 0 else 0.0
    rng = np.random.default_rng(SEED)
    N = len(days)
    b = min(block, N)
    nb = -(-N // b)
    bs = []
    for _ in range(reps):
        st = rng.integers(0, N - b + 1, nb)
        idx = np.concatenate([np.arange(a, a + b) for a in st])[:N]
        bs.append(sxy[idx].sum() / max(sxx[idx].sum(), 1e-30))
    return float(est), float(np.quantile(bs, 0.05)), float(np.quantile(bs, 0.95)), N


def impact():
    s_v = {k: v["s"] for k, v in load("sellthrough.json").items()}
    out = {}
    for asset in ("eth", "btc"):
        rows = impact_episodes(asset, s_v)
        Y, lo, hi, nd = _boot_ratio(rows, lambda r: -r["sigma"] * np.sqrt(r["Q"]), lambda r: r["r"])
        L, llo, lhi, _ = _boot_ratio(rows, lambda r: -r["Qall"], lambda r: np.expm1(r["r"]))
        out[asset] = {"Yp": Y, "Yp_ci90": [lo, hi], "Yp_used": Y if lo > 0 else 0.0,
                      "lambda": L, "lambda_ci90": [llo, lhi], "lambda_used": max(L, 0.0),
                      "n_episodes": len(rows), "n_days": nd,
                      "sum_Q_usd": float(sum(r["Q"] for r in rows)),
                      "sum_Qall_usd": float(sum(r["Qall"] for r in rows))}
        print(asset, out[asset], flush=True)
    save("impact.json", out)


# ----------------------------------------------------------------------------------------- schedules
DELTA = {"eth": 0.005, "btc": 0.005}   # oracle-registry catalog deviationThresholdBps 50 (deviation D4)
KIND = {**{v: "aave" for v in AAVE}, **{v: "morpho" for v in MORPHO}, **{v: "comet" for v in COMET}}


def _comet_caps(v, ts):
    out = {}
    meta = json.load(open(os.path.join(WORK, v, "meta.json")))
    idx_p = os.path.join(WORK, v, "index.json")
    for cm, cv in meta["comets"].items():
        p = os.path.join(WORK, v, "state", f"{cm}-{ts}.json")
        if not os.path.exists(p):
            continue
        st = json.load(open(p))
        if st.get("target") is None or st.get("reserves") is None:
            continue
        out[cm] = max(0.0, (st["target"] - st["reserves"]) / 10 ** cv["bdec"]) * (st.get("bpx") or 1.0)
    return out


def _comet_split(rec):
    """Comet records per comet index."""
    return {int(c): rec[rec["comet"] == c] for c in np.unique(rec["comet"])} if len(rec) else {}


def schedules(only=None):
    """Per snapshot day: seizure schedules per venue (and per comet), naive densities. Cached per day."""
    fM = load("morpho-fm.json")["fM"]
    d_out = os.path.join(WORK, "schedules")
    os.makedirs(d_out, exist_ok=True)
    all_days = sorted({int(fn[:-4]) for v in AAVE + MORPHO + COMET
                       for fn in (os.listdir(os.path.join(WORK, v, "positions"))
                                  if os.path.isdir(os.path.join(WORK, v, "positions")) else [])})
    for ts in all_days:
        if only and ts not in only:
            continue
        outp = os.path.join(d_out, f"{ts}.npz")
        if os.path.exists(outp):
            continue
        arrs, recs, caps = {}, [], {}
        for v in AAVE + MORPHO + COMET:
            rp = rec_path(v, ts)
            if not os.path.exists(rp):
                continue
            rec = np.load(rp)
            recs.append(rec)
            if KIND[v] == "comet":
                meta_idx = json.load(open(os.path.join(WORK, v, "index.json")))
                cp = _comet_caps(v, ts)
                for ci, sub in _comet_split(rec).items():
                    cm = meta_idx["comets"][ci]
                    sc = CS.schedule(sub, "comet")
                    for k, a in sc.items():
                        arrs[f"{v}|{cm}|{k}"] = a
                    caps[f"{v}|{cm}"] = cp.get(cm, 0.0)
            else:
                sc = CS.schedule(rec, KIND[v], fM)
                for k, a in sc.items():
                    arrs[f"{v}|{k}"] = a
        arrs["naive|E"] = CS.naive_density(recs, "E")
        arrs["naive|B"] = CS.naive_density(recs, "B")
        arrs["caps"] = np.array([json.dumps(caps)])
        np.savez_compressed(outp, **arrs)
    print("schedules done", len(all_days))


def load_sched(ts):
    p = os.path.join(WORK, "schedules", f"{ts}.npz")
    if not os.path.exists(p):
        return None
    z = np.load(p)
    caps = json.loads(str(z["caps"][0]))
    sched = {}
    for k in z.files:
        if k in ("caps",) or k.startswith("naive|"):
            continue
        parts = k.split("|")
        key = "|".join(parts[:-1])
        sched.setdefault(key, {})[parts[-1]] = z[k]
    return sched, caps, {"E": z["naive|E"], "B": z["naive|B"]}


def features(asset, origins, cfg, sigma):
    """Cascade lead c_t(d) and naive lead per origin, from the snapshot 24 h before the origin (C.8)."""
    cls = {"eth": "E", "btc": "B"}[asset]
    s_v = cfg["s_v"]
    out = {}
    for t in origins:
        z = load_sched(t - 86400)
        if z is None or not np.isfinite(sigma.get(t, np.nan)):
            continue
        sched, caps, naive = z
        s_full = {k: s_v.get(k.split("|")[0], 0.0) for k in sched}
        Q = CS.sell_flow(sched, cls, s_full, caps)
        o = CS.overshoot(Q, cfg["impact"][asset]["Yp_used"], sigma[t], DELTA[asset])
        on = CS.naive_overshoot(naive[cls], cfg["impact"][asset]["lambda_used"])
        out[t] = {"c": {d: CS.lead(o, d) for d in MD.LEVELS}, "cn": {d: CS.lead(on, d) for d in MD.LEVELS},
                  "Q60": float(Q[-1]), "o10": float(o[100])}
    return out


def _labels(asset, a, b):
    st, close, low = MD.load_series(DATASETS, asset)
    return MD.labels(st, close, low, MD.origins_in(a, b))


def dev():
    """Development fits (C.5) and the kill rule (C.6). Reads development labels only."""
    cfg = {"s_v": {k: v["s"] for k, v in load("sellthrough.json").items()},
           "fM": load("morpho-fm.json")["fM"], "impact": load("impact.json"), "delta": DELTA}
    res = {"kill": {}, "beta": {}, "beta_naive": {}, "p0": {}}
    for asset in ("eth", "btc"):
        lab, S, sig = _labels(asset, MD.DEV[0], MD.DEV[1])
        dev_o = sorted(S)
        p0 = MD.plain_touch(lab, dev_o)
        res["p0"][asset] = {f"{d}|{T}": v for (d, T), v in p0.items()}
        F = features(asset, dev_o, cfg, sig)
        # kill rule: c < delta on >= 90% of development origins at every primary level (c does not depend on T)
        share = {d: float(np.mean([F[t]["c"][d] < DELTA[asset] for t in F if not MD.stress_purged(t, 0)]))
                 for d in MD.LEVELS}
        res["kill"][asset] = {"share_below_delta": share, "killed": all(v >= 0.9 for v in share.values()),
                              "n_origins": len(F)}
        for T in MD.HORIZONS:
            rows, rows_n = [], []
            for t in F:
                for d in MD.LEVELS:
                    if (t, d, T) in lab and not MD.stress_purged(t, T):
                        off = MD.logit(p0[(d, T)]["p"])
                        rows.append((off, F[t]["c"][d], lab[(t, d, T)]))
                        rows_n.append((off, F[t]["cn"][d], lab[(t, d, T)]))
            res["beta"][f"{asset}|{T}"] = MD.fit_beta(rows)
            res["beta_naive"][f"{asset}|{T}"] = MD.fit_beta(rows_n)
            res.setdefault("n_rows", {})[f"{asset}|{T}"] = len(rows)
        res.setdefault("lead_summary", {})[asset] = {
            str(d): {"mean": float(np.mean([F[t]["c"][d] for t in F])),
                     "p90": float(np.quantile([F[t]["c"][d] for t in F], 0.9)),
                     "max": float(np.max([F[t]["c"][d] for t in F]))} for d in MD.LEVELS}
    res["cfg"] = cfg
    save("dev.json", res)
    print(json.dumps({k: res[k] for k in ("kill", "beta", "beta_naive")}, indent=1))


# ----------------------------------------------------------------------------------- freeze and test
CODE_FILES = ["rpc.py", "blocks.py", "aave.py", "morpho.py", "comet.py", "classes.py", "callrule.py", "cascade.py",
              "model.py", "run.py", "sellthrough.py", "liqevents.py", "chainlink.py", "acquire.py"]


def _sha(p):
    import hashlib
    return hashlib.sha256(open(p, "rb").read()).hexdigest()


def freeze():
    """Frozen config (C.10): everything the one test run uses, with sha256 of each input and code file."""
    d = load("dev.json")
    cfg = {"s_v": d["cfg"]["s_v"], "fM": d["cfg"]["fM"], "impact": d["cfg"]["impact"], "delta": DELTA,
           "beta": d["beta"], "beta_naive": d["beta_naive"], "p0": d["p0"], "kill": d["kill"],
           "aid": load("aid.json") if os.path.exists(os.path.join(RES, "aid.json")) else None,
           "levels": MD.LEVELS, "horizons": MD.HORIZONS, "test_start": MD.TEST_START, "data_end": MD.DATA_END,
           "bootstrap": {"block": max(30, 2 * max(MD.HORIZONS)), "reps": 2000, "seed": SEED},
           "code_sha256": {f: _sha(os.path.join(HERE, f)) for f in CODE_FILES},
           "price_sha256": MD.PRICE_SHA}
    p = os.path.join(RES, "frozen-config.json")
    json.dump(cfg, open(p, "w"), indent=1, sort_keys=True, default=float)
    print("frozen", _sha(p))


def _predict(asset, F, p0, beta, key, d, T, t):
    off = MD.logit(p0[f"{d}|{T}"]["p"])
    x = F[t][key][d]
    return 1 / (1 + np.exp(-(off + beta * x)))


def test():
    """The one test run (C.7.1). Refuses to run without a frozen config."""
    p = os.path.join(RES, "frozen-config.json")
    cfg = json.load(open(p))
    if os.path.exists(os.path.join(RES, "test.json")):
        raise SystemExit("test already run")
    out = {"frozen_sha256": _sha(p), "assets": {}}
    for asset in ("eth", "btc"):
        lab, S, sig = _labels(asset, MD.TEST_START, MD.DATA_END - 86400)
        origins = sorted(t for t in S if t >= MD.TEST_START)
        F = features(asset, origins, cfg, sig)
        rows = []
        for t in sorted(F):
            for T in MD.HORIZONS:
                if MD.stress_purged(t, T):
                    continue
                for d in MD.LEVELS:
                    if (t, d, T) not in lab:
                        continue
                    pb = 1 / (1 + np.exp(-MD.logit(cfg["p0"][asset][f"{d}|{T}"]["p"])))
                    pc = _predict(asset, F, cfg["p0"][asset], cfg["beta"][f"{asset}|{T}"], "c", d, T, t)
                    pn = _predict(asset, F, cfg["p0"][asset], cfg["beta_naive"][f"{asset}|{T}"], "cn", d, T, t)
                    rows.append((t, d, T, lab[(t, d, T)], pb, pc, pn))
        days = [r[0] for r in rows]
        y = [r[3] for r in rows]
        pb, pc, pn = [r[4] for r in rows], [r[5] for r in rows], [r[6] for r in rows]
        b = cfg["bootstrap"]["block"]
        est, boot = MD.block_bootstrap_bss(days, pc, pb, y, b)
        estn, bootn = MD.block_bootstrap_bss(days, pc, pn, y, b)
        a = {"n_rows": len(rows), "n_days": len(set(days)), "touches": int(sum(y)),
             "brier_plain": MD.brier(pb, y), "brier_cand": MD.brier(pc, y), "brier_naive": MD.brier(pn, y),
             "bss_vs_plain": est, "bss_vs_plain_ci90": [float(np.quantile(boot, 0.05)), float(np.quantile(boot, 0.95))],
             "p_one_sided": float(np.mean(boot <= 0)),
             "bss_vs_naive": estn, "bss_vs_naive_ci90": [float(np.quantile(bootn, 0.05)), float(np.quantile(bootn, 0.95))],
             "ece_plain": MD.ece(pb, y), "ece_cand": MD.ece(pc, y), "ece_naive": MD.ece(pn, y),
             "max_abs_shift": float(np.max(np.abs(np.array(pc) - np.array(pb)))) if rows else 0.0,
             "share_rows_shifted": float(np.mean(np.abs(np.array(pc) - np.array(pb)) > 1e-12)) if rows else 0.0,
             "killed": cfg["kill"][asset]["killed"]}
        by = {}
        for T in MD.HORIZONS:
            for d in MD.LEVELS:
                sel = [r for r in rows if r[1] == d and r[2] == T]
                if sel:
                    yy = [r[3] for r in sel]
                    by[f"{d}|{T}"] = {"n": len(sel), "touches": int(sum(yy)), "b_plain": MD.brier([r[4] for r in sel], yy),
                                      "b_cand": MD.brier([r[5] for r in sel], yy), "b_naive": MD.brier([r[6] for r in sel], yy)}
        a["by_cell"] = by
        out["assets"][asset] = a
    # Holm over the two assets on the one-sided bootstrap p (alpha 0.05 <=> 90% lower bound > 0)
    ps = sorted((out["assets"][x]["p_one_sided"], x) for x in out["assets"])
    holm = {}
    for i, (pv, x) in enumerate(ps):
        holm[x] = pv <= 0.05 / (len(ps) - i) and all(holm.get(y, True) for _, y in ps[:i])
    for x, a in out["assets"].items():
        c1 = holm[x]
        c2 = a["bss_vs_naive"] > 0
        c3 = a["ece_cand"] <= a["ece_plain"] + 0.005
        if a["killed"]:
            v = "KILLED"
        elif c1 and c2 and c3:
            v = "PASS"
        elif a["bss_vs_plain_ci90"][1] < 0:
            v = "FAIL"
        else:
            v = "INCONCLUSIVE"
        a["criteria"] = {"holm_lower_bound_gt0": bool(c1), "beats_naive": bool(c2), "ece_ok": bool(c3)}
        a["verdict"] = v
    save("test.json", out)
    print(json.dumps({x: (a["verdict"], a["bss_vs_plain"], a["bss_vs_plain_ci90"]) for x, a in out["assets"].items()}))


# --------------------------------------------------------------------------------- reported, not deciding
def _logscore(p, y):
    p = min(max(p, 1e-9), 1 - 1e-9)
    return float(np.log(p) if y else np.log(1 - p))


def stress():
    """C.7.3: both models at the 00:00 origins E - 1 d and E for every stress case with data. Failures first."""
    cfg = json.load(open(os.path.join(RES, "frozen-config.json")))
    out = []
    for name, date in MD.STRESS.items():
        E = MD.ts_of(date)
        for asset in ("eth", "btc"):
            lab, S, sig = _labels(asset, E - 86400, E)
            F = features(asset, [E - 86400, E], cfg, sig)
            for t in (E - 86400, E):
                if t not in F:
                    out.append({"case": name, "asset": asset, "origin": t, "status": "no density snapshot (outside venue data)"})
                    continue
                cells = []
                for T in MD.HORIZONS:
                    for d in MD.LEVELS:
                        if (t, d, T) not in lab:
                            continue
                        pb = cfg["p0"][asset][f"{d}|{T}"]["p"]
                        pc = _predict(asset, F, cfg["p0"][asset], cfg["beta"][f"{asset}|{T}"], "c", d, T, t)
                        y = lab[(t, d, T)]
                        cells.append({"d": d, "T": T, "y": y, "plain": pb, "cascade": float(pc),
                                      "lead": F[t]["c"][d], "dlog": _logscore(pc, y) - _logscore(pb, y)})
                tot = float(sum(c["dlog"] for c in cells))
                out.append({"case": name, "asset": asset, "origin": t, "cells": cells, "sum_dlog": tot,
                            "status": "pass" if tot > 0 else ("tie" if tot == 0 else "fail")})
    order = {"fail": 0, "tie": 1, "pass": 2}
    out.sort(key=lambda r: (order.get(r["status"], 3), r["case"], r["asset"], r["origin"]))
    save("stress.json", out)
    for r in out:
        print(r["case"], r["asset"], r["origin"], r["status"], r.get("sum_dlog"))


def mech():
    """C.7.2 density and impact checks; C.8 delay persistence."""
    cfg = json.load(open(os.path.join(RES, "frozen-config.json")))
    ev = liq_events()
    res = {}
    for asset, cls in (("eth", "E"), ("btc", "B")):
        st, close, low = MD.load_series(DATASETS, asset)
        real = {}
        for e in ev:
            if e["cls"] == cls and e["kind"] in ("liq", "absorb") and e["ts"] >= 1672531200:
                real[day_of(e["ts"])] = real.get(day_of(e["ts"]), 0.0) + (e["usd_day"] if np.isfinite(e["usd_day"]) else 0)
        rows = []
        for dts, usd in sorted(real.items()):
            z = load_sched(dts)
            if z is None or usd < 1e5:
                continue
            sched, caps, _ = z
            i = (dts - st) // 3600
            if i - 1 < 0 or i + 24 > len(low):
                continue
            S0 = close[i - 1]
            lo = np.nanmin(low[i:i + 24])
            g = lo / S0
            k = int(min(CS.NG - 1, max(0, round((1 - g) / 0.001))))
            pred = 0.0
            for key, sc in sched.items():
                pred += sc.get("abs" + cls, sc.get(cls))[k]
            rows.append({"day": dts, "realized": usd, "predicted": float(pred), "move": float(g - 1),
                         "span": "dev" if dts < MD.TEST_START else "test", "stress": MD.stress_purged(dts, 0)})
        err = [abs(r["predicted"] - r["realized"]) / r["realized"] for r in rows]
        res[asset] = {"density_days": len(rows), "median_abs_rel_err": float(np.median(err)) if err else None,
                      "share_within_25pct": float(np.mean([x <= 0.25 for x in err])) if err else None,
                      "rows": rows}
        # impact out of sample
        s_v = cfg["s_v"]
        ep = [r for r in impact_episodes(asset, s_v, span=()) if r["t"] >= MD.TEST_START
              and not MD.stress_purged(r["day"], 0)]
        if ep:
            Yt, lo_, hi_, nd = _boot_ratio(ep, lambda r: -r["sigma"] * np.sqrt(r["Q"]), lambda r: r["r"])
            res[asset]["impact_test"] = {"Yp_test": Yt, "ci90": [lo_, hi_], "n_episodes": len(ep), "n_days": nd,
                                         "Yp_dev": cfg["impact"][asset]["Yp"]}
        # C.8 persistence of 5% bucket mass across 24 h (test span)
        num = den = 0.0
        for t in range(MD.TEST_START, MD.DATA_END - 86400, 86400):
            a, b = load_sched(t - 86400), load_sched(t)
            if a is None or b is None:
                continue
            def buckets(z):
                tot = np.zeros(CS.NG)
                for key, sc in z[0].items():
                    tot += sc.get("abs" + cls, sc.get(cls))
                edges = [0, 50, 100, 150, 200, 250, 300, 350, 400, 450, 500, 550, 600]
                return np.diff(tot[edges])
            ma, mb = buckets(a), buckets(b)
            num += np.minimum(ma, mb).sum()
            den += ma.sum()
        res[asset]["persistence_24h"] = num / den if den else None
    save("mech.json", res)
    print(json.dumps({a: {k: v for k, v in r.items() if k != "rows"} for a, r in res.items()}, indent=1, default=float))


if __name__ == "__main__":
    globals()[sys.argv[1].replace("-", "_")]()
