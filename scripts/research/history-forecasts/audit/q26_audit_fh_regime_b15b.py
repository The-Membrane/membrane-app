"""Q26 closed-path audit 2026-10-19 (membrane-board design/q26-closed-path-audit-2026-10-19.md).

(fH) and frozen R14.1 DR deep R by ex-ante rv30-percentile regime on spent B15b.
Development or spent (grade C) data only. No reserved set is read.
"""
import os
DS = os.environ.get("MEMBRANE_DATASETS", os.path.expanduser("~/membrane-datasets"))
OUT = os.environ.get("Q26_AUDIT_OUT", ".")
import sys, json, numpy as np, inspect, textwrap
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import r14_dr as D, r13_recal as R13
src = inspect.getsource(D.row_task)
src = src.replace('keys = ["ts", "y", "pH", "pf", "pa", "pG", "yG", "q2", "tail", "fold"]',
                  'keys = ["ts", "y", "pH", "pf", "pa", "pG", "yG", "q2", "tail", "fold", "reg"]')
src = src.replace('out["fold"].append(np.full(len(ts), int(f["qs_ts"]), np.int64))',
                  'out["fold"].append(np.full(len(ts), int(f["qs_ts"]), np.int64))\n        out["reg"].append(ser.regime[te].astype(np.int8))')
src = src.replace("def row_task(", "def row_task2(")
exec(compile(src, "row_task2", "exec"), D.__dict__)
D.row_task = D.row_task2
cfg = json.load(open(DS + "/history-forecasts/r14/r141-run-b90111b2/frozen-r141-config.json"))
specs = D.b15b_specs(DS + "/b15-mexc-prices")
for T in D.HS:
    S = D.run_rows(specs, T, "1h", 3, lambda s: None, "B15b")
    P = D.forecasts_of(S, T, cfg)
    rows = np.flatnonzero(~S["q2"] & ~S["tail"])
    reg = S["reg"][rows]
    for ci, k in enumerate(D.DLEV):
        y = S["y"][rows, D.KIX[k]].astype(float)
        line = []
        for g, nm in ((0, "low"), (1, "mid"), (2, "high")):
            m = reg == g
            sy = y[m].sum()
            line.append(f"{nm} n_pos {int(sy)} R fH {P['fH'][rows[m], ci].sum()/sy:.2f} DR {P['DR'][rows[m], ci].sum()/sy:.2f}")
        print(D.TL[T], k, " | ".join(line), flush=True)
    del S, P
