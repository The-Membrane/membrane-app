"""Q26-NL: near-line live calibration from PUBLIC D14 outcome counts and D13/D12 issued odds.
membrane-board design/Q26_NEARLINE_LIVE_PREREG.md (registered 2026-11-04). Fixed by that file.
  counts   positives and positive days per arm x horizon x bucket (always allowed)
  grade    R = sum expected / sum observed with a day-clustered bootstrap, only for buckets at >= 30 positives and >= 5 positive days
Public-safe: reads only aave-v3/outcomes, aave-v3/hourly and q26-touch-live d13/d12 issues. Writes aggregates. No address."""
import argparse, collections, datetime as dt, glob, gzip, json, math, os
import numpy as np

BANDS = {"0-1%": (0.0, 0.01), "1-2%": (0.01, 0.02), "2-3.5%": (0.02, 0.035), "3.5-5%": (0.035, 0.05), "5-10%": (0.05, 0.10)}
BUCKET = {"0-1%": "0-2%", "1-2%": "0-2%", "2-3.5%": "2-5%", "3.5-5%": "2-5%", "5-10%": "5-10%"}
HOR = {"6h": "6h", "12h": "12h", "24h": "1d", "168h": "7d"}
LEVELS = [0.02, 0.03, 0.05, 0.07, 0.10, 0.15, 0.20, 0.30]
SYM = {"WETH": "ETHUSDT", "WETH.e": "ETHUSDT", "WBTC": "BTCUSDT", "WBTC.e": "BTCUSDT", "BTCB": "BTCUSDT", "BTC.b": "BTCUSDT", "cbBTC": "BTCUSDT",
       "WBNB": "BNBUSDT", "WAVAX": "AVAXUSDT", "LINK": "LINKUSDT", "LINK.e": "LINKUSDT", "AAVE": "AAVEUSDT", "AAVE.e": "AAVEUSDT", "UNI": "UNIUSDT",
       "wstETH": "ETHUSDT", "weETH": "ETHUSDT", "rETH": "ETHUSDT", "cbETH": "ETHUSDT", "osETH": "ETHUSDT", "rsETH": "ETHUSDT", "ETHx": "ETHUSDT",
       "ezETH": "ETHUSDT", "WMATIC": "POLUSDT", "WPOL": "POLUSDT", "POL": "POLUSDT", "ARB": "ARBUSDT", "OP": "OPUSDT", "tBTC": "BTCUSDT", "LBTC": "BTCUSDT",
       "SOL": "SOLUSDT", "DOGE": "DOGEUSDT"}
B_DRAWS, SEED = 1000, 20261106


def geo_centre(band):
    lo, hi = BANDS[band]; return math.sqrt(max(lo, 1e-4) * hi) if lo > 0 else math.sqrt(0.0025 * hi) * 0 + 0.005


def logit(p): p = min(max(p, 1e-6), 1 - 1e-6); return math.log(p / (1 - p))
def expit(x): return 1 / (1 + math.exp(-x))


def interp_odds(ladder, dist):
    """ladder: list of p at LEVELS (distance = -level). Linear in log-odds between neighbours; flat below the first level."""
    if dist <= LEVELS[0]: return ladder[0]
    for i in range(1, len(LEVELS)):
        if dist <= LEVELS[i]:
            x0, x1 = LEVELS[i - 1], LEVELS[i]; w = (dist - x0) / (x1 - x0)
            return expit((1 - w) * logit(ladder[i - 1]) + w * logit(ladder[i]))
    return ladder[-1]


def load_issues(root, block):
    out = {}
    for f in sorted(glob.glob(os.path.join(root, "forecasts", "q26-touch-live", block, "issues", "*.json.gz"))):
        d = json.load(gzip.open(f)); rows = d.get("series") or d.get("rows") or []
        out[d["date"]] = {r["symbol"]: r["fH"] for r in rows if r.get("issued") and r.get("fH")}
    return out


def hourly_mix(root):
    """snapshot date -> chain -> arm -> band -> {asset: n} at the 00:00Z check of that date (first ok line of the day)."""
    mix = {}
    for f in sorted(glob.glob(os.path.join(root, "forecasts", "q26-borrower-alert", "aave-v3", "hourly", "*.jsonl"))):
        for l in open(f):
            r = json.loads(l); day = dt.datetime.fromtimestamp(r["c"], dt.UTC).strftime("%Y-%m-%d")
            if r["c"] % 86400 != 0: continue
            for ch, v in r.get("chains", {}).items():
                if v.get("status") != "ok": continue
                for arm, assets in v.get("bands", {}).items():
                    for asset, b in assets.items():
                        for band, n in zip(BANDS, b["n"]):
                            if n: mix.setdefault(day, {}).setdefault(ch, {}).setdefault(arm, {}).setdefault(band, {})[asset] = n
    return mix


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("mode", choices=["counts", "grade"]); ap.add_argument("--root", required=True); ap.add_argument("--out")
    a = ap.parse_args()
    outcomes = [json.loads(l) for f in sorted(glob.glob(os.path.join(a.root, "forecasts", "q26-borrower-alert", "aave-v3", "outcomes", "*.jsonl"))) for l in open(f)]
    d13, d12 = load_issues(a.root, "d13"), load_issues(a.root, "d12"); mix = hourly_mix(a.root)
    units = []  # per row x horizon: expected, observed, day, arm, bucket
    unmapped = collections.Counter()
    for r in outcomes:
        iss = (d13 if r["arm"] == "iii" else d12).get(r["snapshot"])
        m = mix.get(r["snapshot"], {}).get(r["chain"], {}).get(r["arm"], {}).get(r["band"], {})
        dist = geo_centre(r["band"])
        for hk, hn in HOR.items():
            exp = None
            if iss and m:
                tot = sum(m.values()); e = 0.0; got = 0.0; fallback = []
                for asset, n in m.items():
                    s = SYM.get(asset); lad = iss.get(s, {}).get(hn) if s else None
                    if lad: e += n * interp_odds(lad, dist); got += n
                    else: fallback.append(n); unmapped[asset] += n
                if got > 0:
                    mean_p = e / got; e += mean_p * sum(fallback); exp = e * r["n"] / tot   # scale the hourly mix to the row's n
            units.append({"day": r["snapshot"], "arm": r["arm"], "bucket": BUCKET[r["band"]], "band": r["band"], "h": hn, "n": r["n"], "obs": r["touch" + hk],
                          "obsNoAct": r["touch" + hk + "NoAct"], "exp": exp})
    res = {"schema": "q26-nl/1", "prereg": "membrane-board design/Q26_NEARLINE_LIVE_PREREG.md", "mode": a.mode, "snapshots": sorted({u["day"] for u in units}),
           "unmappedAssetsPositions": dict(unmapped.most_common(10)), "cells": {}}
    keyf = lambda u, pooled: (u["arm"], u["h"], "0-10%" if pooled else u["bucket"])
    for pooled in (False, True):
        groups = collections.defaultdict(list)
        for u in units: groups[keyf(u, pooled)].append(u)
        for k, us in groups.items():
            pos = sum(u["obs"] for u in us); days = {u["day"] for u in us if u["obs"] > 0}
            cell = {"n": sum(u["n"] for u in us), "positives": pos, "positiveDays": len(days), "rowsWithOdds": sum(1 for u in us if u["exp"] is not None)}
            if a.mode == "grade" and pos >= 30 and len(days) >= 5:
                us2 = [u for u in us if u["exp"] is not None]; E = sum(u["exp"] for u in us2); O = sum(u["obs"] for u in us2)
                cell["R"] = E / O if O else None
                byday = collections.defaultdict(lambda: [0.0, 0.0])
                for u in us2: byday[u["day"]][0] += u["exp"]; byday[u["day"]][1] += u["obs"]
                D = list(byday.values()); rng = np.random.default_rng(SEED); draws = []
                for _ in range(B_DRAWS):
                    pick = rng.integers(0, len(D), len(D)); e = sum(D[i][0] for i in pick); o = sum(D[i][1] for i in pick)
                    if o > 0: draws.append(e / o)
                ci = [float(np.percentile(draws, 2.5)), float(np.percentile(draws, 97.5))] if len(draws) > 50 else None
                cell["R_ci95"] = ci
                if ci: cell["verdict"] = "CALIBRATED" if 0.8 <= cell["R"] <= 1.25 and ci[0] <= 1.25 and ci[1] >= 0.8 else "UNDER-WARN" if ci[1] < 0.8 else "OVER-WARN" if ci[0] > 1.25 else "INCONCLUSIVE"
            else:
                cell["class"] = "HISTORY COUNT"
            res["cells"]["|".join(k)] = cell
    print(json.dumps(res, indent=1))
    if a.out: json.dump(res, open(a.out, "w"), indent=1)


if __name__ == "__main__":
    main()
