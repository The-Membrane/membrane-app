"""Q26 R16.1 counts-only check of B9 + B10 for 7 d / 30 d touch: series, calendar blocks and (series, block) cells
from timestamps only (first quarter >= 365 d after the first kline, R12 delisting tail and redenomination splits, windows
meeting 2026Q2 dropped). No price level, label, outcome, forecast or score is computed.
Usage: r161_counts.py <acq dir holding b9/ and b10/ links> <block days>"""
# counts-only (timestamps and null hours only): series, quarterly blocks with >=1 scorable 30 d origin, (series, block) cells
import sys, json, numpy as np
sys.path.insert(0, "/home/user/membrane-app/scripts/research/history-forecasts")
import r12_tail as R, a_touch as A
acq = sys.argv[1]
DAY=86400; ORIG=17532
out = {}
BD = int(sys.argv[2])
allspecs = {w: R.blind_specs(acq, w)[0] for w in ("b9", "b10")}
allspecs["b9+b10"] = allspecs["b9"] + allspecs["b10"]
for which in ("b9", "b10", "b9+b10"):
    specs = allspecs[which]
    S=0; cells={}; blocks=set()
    for sp in specs:
        st, cols = R.load_json_grid(sp["path"])
        i0, i1 = sp["slice"]; st2 = st + 3600*i0
        n = i1 - i0
        fq = R.M3.first_quarter_after(st2, 365)
        q0 = A.quarter_start(*fq)
        for T, name in ((168, "7d"), (720, "30d")):
            cap = sp["cap_primary"] - T*3600
            lo, hi = q0, min(cap, R.END - T*3600, st2 + 3600*n - T*3600)
            if hi <= lo: continue
            days = np.arange(lo//DAY, hi//DAY)
            q2 = ~((days + T//24 >= 20544) & (days <= 20635))
            days = days[q2]
            b = np.unique((days - ORIG)//BD)
            cells.setdefault(name, set()).update((sp["path"]+sp["key"], int(x)) for x in b)
            blocks.update((name, int(x)) for x in b)
    for name in ("7d","30d"):
        c = cells.get(name, set())
        out[f"{which}|{name}"] = {"S": len({k for k,_ in c}), "B": len({x for (nm,x) in blocks if nm==name}), "C": len(c),
                                  "first_block": min((x for (nm,x) in blocks if nm==name), default=None)}
print(json.dumps(out, indent=1))
