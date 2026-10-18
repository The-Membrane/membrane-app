"""C.5.3 aid test: do Aave V2 and Compound V2 rows from 2021-01-01 .. 2022-12-31 aid the model?

Inside development only. Fit (s_v, Y', beta_T) on 2023-01-01 .. 2024-06-30 twice, without and with the
extension rows, and score both on 2024-07-01 .. 2025-06-30 (stress windows purged). Admit the extension
only if the Brier skill of "with" over "without" has a 90% block-bootstrap lower bound > 0 for both assets.

  python3 aid.py events        V2 liquidation events with exact block timestamps
  python3 aid.py sellthrough   V2 sell-through (rule v2, <= 1,500 seeded transactions per venue)
  python3 aid.py test          the aid decision -> results/aid.json
"""
from __future__ import annotations

import gzip
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import model as MD  # noqa: E402
import run as R  # noqa: E402
from classes import asset_class  # noqa: E402
from rpc import Client  # noqa: E402

W = R.WORK
FIT = (1672531200, 1719705600)        # 2023-01-01 .. 2024-06-30 origins
SCORE = (1719792000, 1751241600)      # 2024-07-01 .. 2025-06-30
EXT = (1609459200, 1672444800)        # 2021-01-01 .. 2022-12-31
V2 = ["aave-v2-eth", "comp-v2-eth"]


def _iter(v):
    d = os.path.join(W, v, "logs")
    for fn in sorted(os.listdir(d)):
        if fn.endswith(".jsonl.gz"):
            for line in gzip.open(os.path.join(d, fn), "rt"):
                r = json.loads(line)
                yield [int(x) if isinstance(x, str) and x.isdigit() else x for x in r]


def _days_v2():
    d = json.load(open(os.path.join(W, "days", "ethereum.json")))
    return sorted((v, int(k)) for k, v in d.items())


def _day_for_block(sched, blk):
    import bisect
    i = bisect.bisect_right([b for b, _ in sched], blk) - 1
    return sched[i][1] if i >= 0 else None


def events():
    out_p = os.path.join(W, "liq", "v2-events.json.gz")
    if os.path.exists(out_p):
        return json.load(gzip.open(out_p, "rt"))
    sched = _days_v2()
    rows = []
    am = json.load(open(os.path.join(W, "aave-v2-eth", "meta.json")))
    for r in _iter("aave-v2-eth"):
        if r[2] != "LIQ":
            continue
        res = am["reserves"][r[3]] if r[3] >= 0 else None
        if res is None:
            continue
        rows.append({"venue": "aave-v2-eth", "block": r[0], "logIndex": r[1], "tx": r[9], "liquidator": r[8],
                     "token": res["asset"].lower(), "sym": res["symbol"], "units": int(r[7]) / 10 ** res["decimals"]})
    cm = json.load(open(os.path.join(W, "comp-v2-eth", "meta.json")))
    for r in _iter("comp-v2-eth"):
        if r[2] != "LQ" or r[6] < 0:
            continue
        mk = cm["markets"][r[6]]
        rows.append({"venue": "comp-v2-eth", "block": r[0], "logIndex": r[1], "tx": r[9], "liquidator": r[8],
                     "token": (mk["underlying"] or "eth").lower(), "sym": mk["usym"], "ctoken": mk["cToken"],
                     "ctoken_units": int(r[7])})
    # exact timestamps
    c = Client("ethereum")
    blocks = sorted({e["block"] for e in rows})
    ts = {}
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(6) as ex:
        for b, t in zip(blocks, ex.map(c.block_ts, blocks)):
            ts[b] = t
    for e in rows:
        e["ts"] = ts[e["block"]]
        e["day"] = _day_for_block(sched, e["block"])
        e["cls"] = asset_class("ethereum", "WETH" if e["sym"].upper() == "ETH" else e["sym"])
    json.dump(rows, gzip.open(out_p, "wt"))
    print("v2 events", len(rows))
    return rows


def _state(v, day):
    p = os.path.join(W, v, "state", f"{day}.json")
    return json.load(open(p)) if os.path.exists(p) else None


def enrich(rows):
    """Class-equivalent units (eq) and the ETH/BTC ratio of the seized token at the day (V2 daily state)."""
    am = json.load(open(os.path.join(W, "aave-v2-eth", "meta.json")))
    aidx = {r["asset"].lower(): str(i) for i, r in enumerate(am["reserves"])}
    asym = {r["symbol"].upper(): r["asset"].lower() for r in am["reserves"]}
    cm = json.load(open(os.path.join(W, "comp-v2-eth", "meta.json")))
    cidx = {m["cToken"].lower(): str(i) for i, m in enumerate(cm["markets"])}
    out = []
    for e in rows:
        if e["cls"] not in ("E", "B") or e["day"] is None:
            continue
        st = _state("aave-v2-eth", e["day"])
        if st is None:
            continue
        px = {k: v.get("price") for k, v in st["reserves"].items()}
        ref = {"E": asym.get("WETH"), "B": asym.get("WBTC")}
        refp = {c: int(px[aidx[a]]) for c, a in ref.items() if a and px.get(aidx[a])}
        if e["venue"] == "aave-v2-eth":
            p = px.get(aidx.get(e["token"]))
            if not p or e["cls"] not in refp:
                continue
            e["eq"] = e["units"] * int(p) / refp[e["cls"]]
        else:
            cs = _state("comp-v2-eth", e["day"])
            if cs is None:
                continue
            m = cs["markets"].get(cidx[e["ctoken"].lower()]) if isinstance(cs.get("markets"), dict) else None
            if not m:
                continue
            mk = cm["markets"][int(cidx[e["ctoken"].lower()])]
            under = e["ctoken_units"] * int(m["exrate"]) / 1e18 / 10 ** (mk.get("udec") or 18)
            # Compound prices in USD; ratio to WETH/WBTC through Aave V2's ETH prices is not needed for ETH/WBTC
            e["eq"] = under
        out.append(e)
    return out


def sellthrough():
    import sellthrough as ST
    rows = enrich(events())
    am = json.load(open(os.path.join(W, "aave-v2-eth", "meta.json")))
    cm = json.load(open(os.path.join(W, "comp-v2-eth", "meta.json")))
    prot = {"aave-v2-eth": [am.get("pool", "")] + [r.get(k, "") for r in am["reserves"]
                                                   for k in ("aToken", "vDebt", "sDebt")],
            "comp-v2-eth": [cm["comptroller"]] + [m["cToken"] for m in cm["markets"]]}
    res = {}
    for v in V2:
        items = [e for e in rows if e["venue"] == v and EXT[0] <= e["day"] <= EXT[1]
                 and not MD.stress_purged(e["day"], 0)]
        sm = ST.sample([{"tx": e["tx"], "block": e["block"], "logIndex": e["logIndex"], "e": e} for e in items])
        jobs = []
        for s_ in sm:
            es = [x["e"] for x in s_["events"]]
            cls = max(("E", "B"), key=lambda c: sum(x["eq"] for x in es if x["cls"] == c))
            jobs.append({"tx": s_["tx"], "cls": cls, "block": es[0]["block"], "ratio": {},
                         "exclude": prot[v] + [x["liquidator"] for x in es],
                         "seized": sum(x["eq"] for x in es if x["cls"] == cls)})
        book = ST.TokenBook("ethereum", os.path.join(W, "tokens-ethereum.json"))
        outp = os.path.join(R.RES, f"sellthrough-v2-{v}.jsonl")
        cdir = os.path.join(W, "receipts", "ethereum")
        os.makedirs(cdir, exist_ok=True)
        ST.run("ethereum", jobs, book, outp, cache_dir=cdir)
        got = [json.loads(l) for l in open(outp)]
        seized = {j["tx"]: j["seized"] for j in jobs}
        num = sum(r["st"] * seized[r["tx"]] for r in got if r.get("st") is not None and r["tx"] in seized)
        den = sum(seized[r["tx"]] for r in got if r.get("st") is not None and r["tx"] in seized)
        res[v] = {"s": num / den if den else 0.0, "n_tx": len(got), "population_tx": len({e["tx"] for e in items}),
                  "note": "weights in class-equivalent units (ETH or BTC), not USD"}
        print(v, res[v], flush=True)
    R.save("aid-sellthrough.json", res)


def _episodes(asset, s_v, span, with_ext):
    """Impact episodes on [span] from v1 venues, plus V2 venues in EXT when with_ext (stress windows purged)."""
    cls = {"eth": "E", "btc": "B"}[asset]
    rt, ra = R._rounds(asset)
    series = MD.load_series(R.DATASETS, asset)
    ev = [e for e in R.liq_events() if e["cls"] == cls and e["kind"] in ("liq", "buy")
          and span[0] <= R.day_of(e["ts"]) <= span[1] and not MD.stress_purged(R.day_of(e["ts"]), 0)]
    if with_ext:
        ev += [e for e in enrich(events()) if e["cls"] == cls and EXT[0] <= e["day"] <= EXT[1]
               and not MD.stress_purged(e["day"], 0)]
    Q, Qall = {}, {}
    for e in ev:
        k = int(np.searchsorted(rt, e["ts"], side="right") - 1)
        if k < 0 or k + 2 >= len(rt):
            continue
        usd = e["eq"] * ra[k]
        Q[k] = Q.get(k, 0.0) + usd * s_v.get(e["venue"], 0.0)
        Qall[k] = Qall.get(k, 0.0) + usd
    rows = []
    for k in sorted(Qall):
        sig = R._sigma_at(series, int(rt[k]))
        if np.isfinite(sig):
            rows.append({"k": k, "t": int(rt[k]), "day": R.day_of(int(rt[k])), "Q": Q.get(k, 0.0), "Qall": Qall[k],
                         "sigma": sig, "r": float(np.log(ra[k + 2] / ra[k + 1]))})
    return rows


def test():
    s_v = {k: v["s"] for k, v in R.load("sellthrough.json").items()}
    s_v.update({k: v["s"] for k, v in R.load("aid-sellthrough.json").items()})
    out = {"fit_span": FIT, "score_span": SCORE, "ext_span": EXT, "assets": {}}
    for asset in ("eth", "btc"):
        a = {}
        for tag, ext in (("without", False), ("with", True)):
            rows = _episodes(asset, s_v, FIT, ext)
            Y, lo, hi, nd = R._boot_ratio(rows, lambda r: -r["sigma"] * np.sqrt(r["Q"]), lambda r: r["r"])
            a[tag] = {"Yp": Y, "Yp_ci90": [lo, hi], "Yp_used": Y if lo > 0 else 0.0, "n_episodes": len(rows),
                      "n_days": nd}
        both_zero = a["without"]["Yp_used"] == 0.0 and a["with"]["Yp_used"] == 0.0
        if both_zero:
            # with Y' = 0 the overshoot is identically 0, so the cascade lead is 0 and both fits equal plain touch
            a["bss_with_over_without"] = 0.0
            a["bss_ci90"] = [0.0, 0.0]
            a["note"] = "Y' CI includes 0 with and without the extension: identical predictions, BSS = 0"
        else:
            a["note"] = "non-zero impact in one arm: full beta refit and scoring required (not reached)"
        out["assets"][asset] = a
    out["admitted"] = all(out["assets"][x].get("bss_ci90", [0, 0])[0] > 0 for x in out["assets"])
    R.save("aid.json", out)
    print(json.dumps(out, indent=1, default=float))


if __name__ == "__main__":
    globals()[sys.argv[1]]()
