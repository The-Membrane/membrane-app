#!/usr/bin/env python3
"""T5.3 -- scorer for the live M1 touch forecasts.

Implements triccs/membrane-board `design/VALIDATION_PREREG.md` (commit 506e7c5), T5.3.

  python3 m1_score.py --datasets <membrane-datasets> --out <dir> [--commit] [--max-calls N]

Reads every <out>/forecasts/m1-live/YYYY-MM-DD.json (hash chain verified first; a broken chain
stops the run). A row resolves only after asof + T has passed (plus a 15-minute finality margin).
Truth = the minimum Chainlink answer over (asof, asof + T]:
  (1) price-history `oracleLow` over the hours opening in [asof, asof + T*86400 - 3600] when the
      frozen file covers the whole window (its oracleLow includes the round in force at hour start);
  (2) otherwise Chainlink rounds on a public RPC: the round in force at asof plus every round with
      updatedAt in (asof, asof + T] (chainlink.rounds_between / window_min);
  neither -> `unresolved`, never guessed. The source is recorded per row. y = 1 iff min <= L.

Writes <out>/forecasts/m1-live/scores/scores.json (every row: status, truth, y, Brier per source raw
and calibrated) and summary.json (per horizon: resolved issue days, Brier, BSS cal DVOL vs cal RV30
and raw DVOL vs raw RV30, reliability bins). No pass line before n >= 90 resolved issue days per
horizon. Idempotent: everything is recomputed from the day files on each run.
"""
import argparse
import json
import os
import sys
import time

import numpy as np

import chainlink as cl
import t1_touch as t1
from m1_issue import DAY_DIR_REL, load_price_history
from t5_common import (DAY, HOUR, PREREG, code_provenance, commit_and_push, dumps, iso, list_day_files,
                       repo_relpaths, require_clean_code, sha256_bytes, utc_date, verify_chain, write_atomic, _git)

SCHEMA = "m1-live-scores/1"
RESOLVE_MARGIN = 900       # seconds after asof+T before a row is scored (chain head well past the window end)
MIN_DAYS_PASS = 90         # T5.3
PREDICTORS = ("cal_DVOL", "cal_RV30", "cal_RV90", "raw_DVOL", "raw_RV30", "raw_RV90")
COMPARISONS = (("calDVOL_vs_calRV30", "cal_DVOL", "cal_RV30"),
               ("rawDVOL_vs_rawRV30", "raw_DVOL", "raw_RV30"))
PASS_NOTE = ("No pass line is applied before n >= 90 resolved issue days per horizon (prereg T5.3). T5.3 "
             "registers no pass-line formula, so none is computed here even after n >= 90; applying one needs a "
             "dated entry in the prereg's Deviations section first.")


def _p(row, name):
    kind, src = name.split("_")
    return row["p_cal" if kind == "cal" else "p_raw"].get(src)


def load_rows(day_dir):
    rows, files = [], []
    for date, name in list_day_files(day_dir):
        with open(os.path.join(day_dir, name), "rb") as f:
            raw = f.read()
        doc = json.loads(raw)
        files.append({"date": date, "file": name, "sha256": sha256_bytes(raw), "issuedAt": doc["issuedAt"],
                      "asof": doc["asof"], "nRows": len(doc["grid"])})
        for g in doc["grid"]:
            rows.append({"date": date, "file": name, "asset": g["asset"], "T": int(g["T"]), "k": g["k"],
                         "asof": int(doc["asof"]), "asofIso": iso(doc["asof"]),
                         "resolvesAt": int(doc["asof"]) + int(g["T"]) * DAY, "S": g["S"], "L": g["L"],
                         "p_raw": g["p_raw"], "p_cal": g["p_cal"]})
    return rows, files


def truth_price_history(grids, row):
    a, end = row["asof"], row["resolvesAt"]
    lo = grids[row["asset"]].window_min("oracleLow", a, end - HOUR)
    if lo is None:
        return None
    return {"source": "price-history oracleLow", "min": lo,
            "hours": {"firstOpen": iso(a), "lastOpen": iso(end - HOUR)}}


def truth_chain(rounds, row):
    m, used = cl.window_min(rounds, row["asof"], row["resolvesAt"])
    if m is None:
        return None
    return {"source": "chainlink rounds", "min": m.price(), "minRoundId": str(m.round_id),
            "minUpdatedAt": m.updated_at, "nRounds": len(used),
            "inForceAtStart": {"roundId": str(used[0].round_id), "updatedAt": used[0].updated_at,
                               "price": used[0].price()},
            "lastRoundId": str(used[-1].round_id), "phases": sorted({r.phase for r in used})}


def score(out_dir, grids, price_meta, rpc, clock=time.time, log=print, code=None):
    day_dir = os.path.join(out_dir, DAY_DIR_REL)
    problems = verify_chain(day_dir)
    if problems:
        raise SystemExit("STOP: hash chain broken:\n  " + "\n  ".join(problems))
    now = int(clock())
    rows, files = load_rows(day_dir)

    due = []
    for r in rows:
        if r["resolvesAt"] + RESOLVE_MARGIN > now:
            r["status"] = "pending"
            continue
        t = truth_price_history(grids, r)
        if t is not None:
            r["truth"] = t
        else:
            due.append(r)

    chain_errors = {}
    for asset in sorted({r["asset"] for r in due}):
        rs = [r for r in due if r["asset"] == asset]
        t_a, t_b = min(r["asof"] for r in rs), max(r["resolvesAt"] for r in rs)
        feed = cl.Feed(rpc, cl.FEEDS[asset], clock=clock)
        try:
            rounds = feed.rounds_between(t_a, t_b)
        except (cl.RpcError, LookupError, ValueError) as e:
            chain_errors[asset] = f"{type(e).__name__}: {e}"
            rounds = None
        log(f"{asset}: {0 if rounds is None else len(rounds)} Chainlink rounds over ({iso(t_a)}, {iso(t_b)}]")
        for r in rs:
            t = truth_chain(rounds, r) if rounds is not None else None
            if t is not None:
                r["truth"] = t
            else:
                r["status"] = "unresolved"
                r["reason"] = chain_errors.get(asset, "no round in force at window start")

    for r in rows:
        if "truth" not in r:
            continue
        r["status"] = "resolved"
        r["y"] = 1 if r["truth"]["min"] <= r["L"] else 0
        r["brier"] = {"raw": {}, "cal": {}}
        for name in PREDICTORS:
            p = _p(r, name)
            kind, src = name.split("_")
            r["brier"][kind][src] = None if p is None else (p - r["y"]) ** 2

    summary = summarize(rows, files, now)
    meta = {"schema": SCHEMA, "test": "T5", "prereg": {**PREREG, "section": "T5.3"},
            "computedAt": iso(now), "computedAtTs": now, "resolveMarginSeconds": RESOLVE_MARGIN,
            "code": code, "priceHistory": price_meta, "dayFiles": files, "chainVerified": True,
            "rpc": rpc.stats(), "chainErrors": chain_errors}
    scores_dir = os.path.join(day_dir, "scores")
    out_rows = [{k: r.get(k) for k in ("date", "asset", "T", "k", "asofIso", "S", "L", "status", "reason",
                                       "truth", "y", "p_raw", "p_cal", "brier")} | {"resolvesAt": iso(r["resolvesAt"])}
                for r in rows]
    write_atomic(os.path.join(scores_dir, "scores.json"), dumps({**meta, "rows": out_rows}))
    write_atomic(os.path.join(scores_dir, "summary.json"), dumps({**meta, **summary}))
    n_res = sum(r.get("status") == "resolved" for r in rows)
    log(f"scored {len(rows)} rows from {len(files)} day files: {n_res} resolved, "
        f"{sum(r.get('status') == 'pending' for r in rows)} pending, "
        f"{sum(r.get('status') == 'unresolved' for r in rows)} unresolved; rpc {rpc.stats()['ethCalls']} eth_calls")
    return scores_dir, summary


def summarize(rows, files, now):
    per_T = {}
    for T in t1.HORIZONS:
        rs = [r for r in rows if r["T"] == T]
        res = [r for r in rs if r.get("status") == "resolved"]
        paired = [r for r in res if all(_p(r, n) is not None for n in PREDICTORS)]
        n_days = len({r["date"] for r in paired})
        y = np.array([r["y"] for r in paired], dtype=float)
        brier = {n: (t1.brier([_p(r, n) for r in paired], y) if paired else None) for n in PREDICTORS}
        bss = {}
        for cname, m, b in COMPARISONS:
            bm, bb = brier[m], brier[b]
            bss[cname] = None if (bm is None or not bb) else 1.0 - bm / bb
        rel = {}
        for n in PREDICTORS:
            if paired:
                e, table = t1.ece_equal_width(np.array([_p(r, n) for r in paired]), y)
                rel[n] = {"ece_equal_width": e, "bins": table}
            else:
                rel[n] = {"ece_equal_width": None, "bins": []}
        sources = {}
        for r in res:
            s = r["truth"]["source"]
            sources[s] = sources.get(s, 0) + 1
        per_T[str(T)] = {
            "nIssueDaysResolved": n_days, "nRows": len(rs), "nRowsResolved": len(res),
            "nRowsPaired": len(paired), "nRowsPending": sum(r.get("status") == "pending" for r in rs),
            "nRowsUnresolved": sum(r.get("status") == "unresolved" for r in rs),
            "truthSources": sources, "baseRate": float(y.mean()) if paired else None,
            "brier": brier, "bss": bss, "reliability": rel,
            "passLine": {"applied": False, "nIssueDaysResolved": n_days, "requiredBeforeAnyPassLine": MIN_DAYS_PASS},
        }
    return {"passLine": PASS_NOTE,
            "method": "Brier = mean((p - y)^2) over paired resolved rows (all six predictors present), pooled over "
                      "both assets and all five levels; BSS = 1 - Brier(model) / Brier(baseline); reliability = 10 "
                      "equal-width bins on [0,1] (t1_touch.ece_equal_width). Point values only (no CI) until the "
                      "pass-line stage.",
            "nDayFiles": len(files), "firstDate": files[0]["date"] if files else None,
            "lastDate": files[-1]["date"] if files else None, "perHorizon": per_T}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--datasets", required=True, help="membrane-datasets checkout (price-history, read only)")
    ap.add_argument("--out", required=True, help="root holding forecasts/m1-live/")
    ap.add_argument("--commit", action="store_true", help="git add/commit/push scores/scores.json + summary.json")
    ap.add_argument("--max-calls", type=int, default=20000, help="eth_call budget for this run")
    a = ap.parse_args(argv)
    code = code_provenance(__file__, ["chainlink.py", "t1_touch.py", "t5_common.py", "m1_issue.py"])
    if a.commit:
        require_clean_code(code)
        _git(a.out, "rev-parse", "--show-toplevel")
    grids, price_meta = load_price_history(a.datasets)
    rpc = cl.RpcClient(max_calls=a.max_calls, log=lambda m: print(m, file=sys.stderr))
    scores_dir, summary = score(a.out, grids, price_meta, rpc, code=code)
    if a.commit:
        paths = [os.path.join(scores_dir, "scores.json"), os.path.join(scores_dir, "summary.json")]
        commit_and_push(a.out, repo_relpaths(a.out, paths),
                        f"forecasts/m1-live: scores {utc_date(time.time())} (Q25)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
