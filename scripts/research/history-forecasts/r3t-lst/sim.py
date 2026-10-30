"""R3T on a ratio loop (stETH collateral, ETH debt), development data only (market Curve stETH->ETH, hourly,
2021-01..2026-10-27, all before the R3T forward T_REG 2026-11-02). Not a registered test.

Position: C stETH, D ETH. HF = C*r*LT/D. Distance to the line d = 1 - 1/HF (ratio drop that reaches HF 1).
Membrane liquidation (1 h price): below line/1.04 -> immediate; below the line -> 8 h timer; still below at 8 h, or
re-dips below the line during hours 8-16 -> liquidated; after 16 h the timer lapses. Loss on liquidation = penalty x debt.
Rules (de-lever only, sell collateral at r_t minus cost to repay debt):
  HOLD  never acts
  FIX3  if d < 3 %       -> restore d to the opening distance d0
  R3T   if d < k*sig24   -> restore d to max(d0, 1.5*k*sig24); sig24 = realized 24 h vol of hourly log ratio
         (24 h window, floor 0.1 %), the on-chain-observable analogue of the registered forecast-vol input.
Outcome per 90-day start (weekly starts): liquidated?, equity return from the ratio path (carry excluded, identical
in sign across rules and reported separately), actions.
"""
import json
import math
import sys

import numpy as np

rows = [json.loads(x) for x in open(sys.argv[1])]
r = np.array([x[2] for x in rows if x[2]], dtype=float)
blocks = np.array([x[0] for x in rows if x[2]])
lr = np.diff(np.log(r), prepend=math.log(r[0]))
sig24 = np.sqrt(np.convolve(lr ** 2, np.ones(24), "full")[: len(lr)])  # sum of last 24 squared hourly returns
sig24 = np.maximum(sig24, 0.001)

H = 90 * 24
COST = 0.001      # 10 bp per de-lever trade (swap + gas), on traded notional
PEN = 0.10        # Membrane primary penalty (R3T registration); Aave 5 % secondary


def run(start, lt, f, rule, k=3.0):
    max_ltv = lt - 0.02
    ltv0 = f * max_ltv
    C, D = 1.0 / (1 - ltv0), ltv0 / (1 - ltv0)          # equity 1 ETH at r=1 normalisation, scaled by r0 below
    r0 = r[start]
    C = C / r0
    d0 = 1 - D / (C * r0 * lt)
    E0 = C * r0 - D
    timer, actions = None, 0
    for t in range(start, min(start + H, len(r))):
        rt = r[t]
        hf = C * rt * lt / D if D > 0 else 9e9
        d = 1 - 1 / hf
        # liquidation engine
        if hf < 1 / 1.04:
            return dict(liq=1, ret=(C * rt - D - PEN * D) / E0 - 1, actions=actions)
        if hf < 1:
            if timer is None:
                timer = t
            elif t - timer >= 8:
                return dict(liq=1, ret=(C * rt - D - PEN * D) / E0 - 1, actions=actions)
        elif timer is not None and t - timer > 16:
            timer = None
        # management rule (acts on the same hourly read, before the next hour)
        trig = {"HOLD": None, "FIX3": 0.03, "R3T": k * sig24[t]}[rule]
        if trig is not None and d < trig and D > 0:
            target = d0 if rule == "FIX3" else max(d0, 1.5 * k * sig24[t])
            target = min(target, 0.95)
            # repay x ETH by selling x/(rt*(1-COST)) stETH: solve 1 - (D-x)/((C - x/(rt(1-c)))*rt*lt) = target
            a = (1 - target) * lt
            x = (D - a * C * rt) / (1 - a / (1 - COST))
            x = min(max(x, 0.0), D)
            C -= x / (rt * (1 - COST))
            D -= x
            actions += 1
            if hf >= 1:
                timer = None
    rt = r[min(start + H, len(r)) - 1]
    return dict(liq=0, ret=(C * rt - D) / E0 - 1, actions=actions)


starts = list(range(24, len(r) - H, 24 * 7))
yr = lambda i: 2021 + (blocks[i] - 11_600_000) / 2_600_000  # rough block->year for labels only
print(f"hours {len(r)}, starts {len(starts)}, min ratio {r.min():.4f}, max hourly |dlog| {np.abs(lr[1:]).max():.4f}")
res = {}
for lt in (0.90, 0.95):
    for f in (0.6, 0.8, 0.9, 0.95):
        for rule in ("HOLD", "FIX3", "R3T"):
            out = [run(s, lt, f, rule) for s in starts]
            liq = np.array([o["liq"] for o in out])
            ret = np.array([o["ret"] for o in out])
            act = np.array([o["actions"] for o in out])
            in22 = np.array([2022 <= yr(s) < 2023 for s in starts])
            res[(lt, f, rule)] = dict(liq=int(liq.sum()), liq22=int(liq[in22].sum()), mean=float(ret.mean()),
                                      p5=float(np.percentile(ret, 5)), worst=float(ret.min()),
                                      acts=float(act.mean() / 3), logu=float(np.mean(np.log(np.maximum(1 + ret, 1e-6)))))
            x = res[(lt, f, rule)]
            print(f"LT {lt} f {f:.2f} {rule:5s} liq {x['liq']:3d} (2022 {x['liq22']:2d})  mean {x['mean']:+.4f}  "
                  f"p5 {x['p5']:+.4f}  worst {x['worst']:+.4f}  logU {x['logu']:+.4f}  acts/mo {x['acts']:.2f}")
json.dump({f"{k[0]}|{k[1]}|{k[2]}": v for k, v in res.items()}, open(sys.argv[2], "w"), indent=1)
