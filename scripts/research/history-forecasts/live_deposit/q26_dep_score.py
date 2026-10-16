#!/usr/bin/env python3
"""Q26 per-deposit live log -- daily SCORER (DEPOSITOR_LIVE.md DL.5, DL.6).

  python3 q26_dep_score.py --out <root> [--expect-commit <sha>]

Implements triccs/membrane-board `design/DEPOSITOR_LIVE.md` (registered 3dc8c65, sha256 52d7666a...).

- Verifies the issue hash chain (a broken chain stops the run), then appends the event store (each run appends; a
  failed fetch is recorded and the stored events are used).
- A (unit, h) row resolves at the first scorer run after the event store covers H + h (its last covered block has
  ts >= H + h). Until then it stays pending.
- Truth (DL.5, G.3): y(x, h) = 1 iff the event-path balance (balanceOf at asof + the G.2 changes of the blocks after
  the asof block) at some event time in (H, H + h] is <= (1 - x) * balance. Capped cells and anchor_mismatch units
  are never scored (anchor_mismatch units get a terminal outcome without y).
- Writes each terminal (unit, h) once to scores/outcomes-YYYY-MM.csv.gz (append-only gzip members, month of the
  scorer run) and rewrites the derived scores/summary.json: per (cell, segment, rung) n, n_ep, Brier, BSS vs the
  population rate (frozen seg_pop) and vs the own rate, R; the DL.6 live check and live STALE, applied only after 90
  resolved issue days per horizon.
"""
import argparse
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import q26_dep_common as D  # noqa: E402

G, S, C = D.G, D.S, D.C

SCHEMA = "q26-deposit-live/scores/1"
OUT_COLS = (["date", "reserve", "address", "segment", "h", "status"] + [f"y_x{x}" for x in G.SIZES]
            + ["path_min_raw", "has_event", "n_event_times", "window_end", "store_covered_ts", "scoredAt"])
SCORED = ("v2", "v3", "v3s", "ps", "disp")              # rungs in the summary; ps = the shipped rung (or seg_pop)

DECISIONS_SCORE = [
    "Outcome rows are per (issue date, unit, horizon) with y for the five sizes (blank where capped). A row is "
    "written once, when terminal: resolved, or anchor_mismatch (never scored). Pending rows are only counted.",
    "Summary per (cell, segment, rung) over resolved, uncapped cells of status-ok units: rungs v2, v3, v3s (rows "
    "where the rung was issued), ps (the shipped rung, or seg_pop where none ships) and disp (the D1 display). "
    "n_ep = maximal runs of consecutive issue days with y = 1 for one unit (a day without a scored row breaks the "
    "run). BSS vs pop uses the frozen seg_pop, BSS vs own the issued own rate, on the same rows. R = sum p / sum y "
    "('inf' when sum y = 0 < sum p). The pooled-over-segments set is reported, not used.",
    "Resolved issue days per horizon = distinct issue dates with a resolved row at that h. Live check (DL.6): per "
    "(cell, segment), the shipped rung (ps), 0.67 <= R <= 1.5 and n_ep >= 50. Live STALE: the rows of the last 90 "
    "resolved issue days of that h, R outside [0.5, 2.0] with n_ep >= 20. Both carry applied = false until 90 "
    "resolved issue days for that h.",
]


def load_store_tables(ldir):
    """Live event store only (blocks after the frozen asof): per reserve, per address block deltas."""
    tables = {r: D.Reserve(r) for r in D.RESERVES}
    for p in D.event_files(ldir):
        it = D.iter_gz_csv(p)
        header = next(it)
        D.scan_rows(it, header, tables)
    for T in tables.values():
        T.finalize()
    return tables


def load_issues(idir):
    import json
    out = []
    for date, name in D.list_issues(idir):
        raw = open(os.path.join(idir, name), "rb").read()
        doc = json.loads(raw)
        df = D.read_issue_csv(os.path.join(idir, doc["csvFile"]))
        if len(df) != doc["nRows"]:
            raise SystemExit(f"STOP: {name}: nRows != rows of {doc['csvFile']}")
        out.append({"date": date, "doc": doc, "df": df, "sha256": D.sha256_bytes(raw)})
    return out


def load_outcomes(sdir):
    out, seen = [], set()
    if not os.path.isdir(sdir):
        return out
    for name in sorted(os.listdir(sdir)):
        if not (name.startswith("outcomes-") and name.endswith(".csv.gz")):
            continue
        for row in D.read_gz_rows(os.path.join(sdir, name), OUT_COLS):
            o = dict(zip(OUT_COLS, row))
            k = (o["date"], o["reserve"], o["address"], o["h"])
            if k in seen:
                raise SystemExit(f"STOP: duplicate outcome {k} in {name}")
            seen.add(k)
            out.append(o)
    return out


def resolve(issues, done_keys, tables, cov_ts, now):
    new, pending = [], {}
    for it in issues:
        doc, df = it["doc"], it["df"]
        H, ab = int(doc["asofHour"]), int(doc["asof"]["block"])
        for rec in df.to_dict("records"):
            for hname, hsec in G.HORIZONS:
                k = (it["date"], rec["reserve"], rec["address"], hname)
                if k in done_keys:
                    continue
                end = H + hsec
                if cov_ts < end:
                    pending[hname] = pending.get(hname, 0) + 1
                    continue
                base = {"date": it["date"], "reserve": rec["reserve"], "address": rec["address"],
                        "segment": rec["segment"], "h": hname, "window_end": end, "store_covered_ts": cov_ts,
                        "scoredAt": now}
                if rec["status"] != "ok":
                    new.append(dict(base, status=rec["status"]))
                    continue
                bal = int(rec["balance_raw"])
                mn, has, n = D.truth_unit(tables[rec["reserve"]].blocks_of(rec["address"]), bal, ab, H, hsec)
                o = dict(base, status="resolved", path_min_raw=mn, has_event=int(has), n_event_times=n)
                for x in G.SIZES:
                    if rec[f"cap_x{x}"] == "1":
                        o[f"y_x{x}"] = ""
                    else:
                        o[f"y_x{x}"] = int(G.label_x(np.array([bal]), np.array([mn]), np.array([has]), x)[0])
                new.append(o)
    return new, pending


def summarize(issues, outcomes):
    """Per (cell, segment, rung) stats, pooled sets, live check and live STALE (DL.5, DL.6)."""
    byk = {(o["date"], o["reserve"], o["address"], o["h"]): o for o in outcomes if o["status"] == "resolved"}
    days_h = {h: sorted({o["date"] for o in outcomes if o["status"] == "resolved" and o["h"] == h}) for h in G.HNAMES}
    tables = {it["date"]: it["doc"]["table"] for it in issues}
    acc = {}
    for it in issues:
        df = it["df"]
        tab = tables[it["date"]]
        for rec in df.to_dict("records"):
            if rec["status"] != "ok":
                continue
            for c in D.X_CELLS:
                o = byk.get((it["date"], rec["reserve"], rec["address"], c["h"]))
                if o is None:
                    continue
                y = o[f"y_x{c['x']}"]
                if y == "" or y is None:
                    continue
                seg = rec["segment"]
                a = acc.setdefault((c["id"], seg), {"unit": [], "date": [], "y": [], "pop": [], "own": [],
                                                    **{r: [] for r in SCORED}})
                a["unit"].append(rec["reserve"] + ":" + rec["address"])
                a["date"].append(it["date"])
                a["y"].append(int(y))
                a["pop"].append(float(tab[c["id"]][seg]["seg_pop"]))
                a["own"].append(float(rec[f"{c['id']}_own"]))
                for r in SCORED:
                    v = rec[f"{c['id']}_{r}"]
                    a[r].append(float(v) if v != "" else np.nan)
    cells, pooled, live_check, live_stale = {}, {}, {}, {}
    latest_tab = tables[issues[-1]["date"]] if issues else {}

    def block(a, mask, r):
        p = np.asarray(a[r])[mask]
        ok = np.isfinite(p)
        sel = np.nonzero(mask)[0][ok]
        return D.stats_block(p[ok], np.asarray(a["y"])[sel], np.asarray(a["pop"])[sel], np.asarray(a["own"])[sel],
                             np.asarray(a["unit"])[sel], np.asarray(a["date"])[sel])
    for (cid, seg), a in sorted(acc.items()):
        n = len(a["y"])
        allm = np.ones(n, bool)
        cells.setdefault(cid, {})[seg] = {r: block(a, allm, r) for r in SCORED}
        h = cid.split("_")[1]
        applied = len(days_h[h]) >= D.MIN_DAYS_PASS
        rung = (latest_tab.get(cid, {}).get(seg, {}) or {}).get("rung") or "pop"
        st = block(a, allm, "ps")
        if st is not None:
            live_check.setdefault(cid, {})[seg] = {
                "rung": rung, "R_live": st["R"], "n_ep": st["n_ep"], "n": st["n"],
                "pass": bool(D.r_inside(st["R"], *D.LIVE_CHECK_R) and st["n_ep"] >= D.LIVE_CHECK_NEP),
                "applied": applied}
        last = set(days_h[h][-D.STALE_WINDOW_DAYS:])
        lm = np.array([d in last for d in a["date"]])
        s2 = block(a, lm, "ps") if lm.any() else None
        if s2 is not None:
            live_stale.setdefault(cid, {})[seg] = {
                "rung": rung, "R_live": s2["R"], "n_ep": s2["n_ep"], "n": s2["n"],
                "stale": bool(s2["n_ep"] >= D.STALE_NEP and not D.r_inside(s2["R"], *D.STALE_R)),
                "applied": applied, "window_days": len(last)}
    for cid in sorted({k[0] for k in acc}):
        parts = [acc[k] for k in acc if k[0] == cid]
        mer = {k: sum((p[k] for p in parts), []) for k in parts[0]}
        allm = np.ones(len(mer["y"]), bool)
        pooled[cid] = {r: block(mer, allm, r) for r in SCORED}
    return {"resolvedIssueDaysPerHorizon": {h: len(v) for h, v in days_h.items()}, "cells": cells,
            "pooledOverSegments": pooled, "liveCheck": live_check, "liveStale": live_stale,
            "passLine": f"No pass line is applied before {D.MIN_DAYS_PASS} resolved issue days per horizon (DL.6); "
                        "live results never retune the model; a LOW segment rises only through a new preregistration."}


def score(out_root, rpc, logs_client, clock=time.time, code=None, log=print):
    now = int(clock())
    ldir = D.live_dir(out_root)
    idir = D.issues_dir(ldir)
    sdir = os.path.join(ldir, D.SCORES_SUB)
    problems = D.verify_chain(idir)
    if problems:
        raise SystemExit("STOP: hash chain broken:\n  " + "\n  ".join(problems))
    D.check_store_clocks(ldir, now)
    D.check_store_rows_within_coverage(ldir)
    ev_entry, ev_err = None, None
    try:
        head = D.head_block(rpc)
        ev_entry = D.update_event_store(ldir, logs_client, rpc, head[0] - D.CONFIRMATIONS, clock=clock, log=log)
    except (C.RpcError, D.ProviderDown, OSError) as e:
        ev_err = f"{type(e).__name__}: {str(e)[:300]}"
        log(f"event store update failed ({ev_err}); scoring with the stored events")
    evst = D.event_store_status(ldir)
    tables = load_store_tables(ldir)
    issues = load_issues(idir)
    done = load_outcomes(sdir)
    keys = {(o["date"], o["reserve"], o["address"], o["h"]) for o in done}
    new, pending = resolve(issues, keys, tables, evst["coveredTs"], now)
    if new:
        path = os.path.join(sdir, f"outcomes-{D.utc_date(now)[:7]}.csv.gz")
        D.append_gz_rows(path, OUT_COLS, [[o.get(k, "") for k in OUT_COLS] for o in new])
    allo = done + [{k: ("" if o.get(k) is None else str(o.get(k, ""))) for k in OUT_COLS} for o in new]
    summ = summarize(issues, allo)
    doc = {"schema": SCHEMA, "prereg": D.PREREG, "computedAt": now, "computedAtIso": D.iso(now), "code": code,
           "chainVerified": True,
           "issueFiles": [{"date": it["date"], "sha256": it["sha256"], "csvSha256": it["doc"]["csvSha256"],
                           "nRows": it["doc"]["nRows"], "asofBlock": it["doc"]["asof"]["block"]} for it in issues],
           "eventStore": {"update": ev_entry, "error": ev_err, "status": evst, "coveredTsIso": D.iso(evst["coveredTs"])},
           "rpc": rpc.stats(), "logsRpc": logs_client.stats(),
           "newOutcomes": len(new), "nOutcomes": len(allo), "pendingByHorizon": pending,
           "statusCounts": {s: sum(o["status"] == s for o in allo) for s in sorted({o["status"] for o in allo})},
           "decisions": D.DECISIONS + DECISIONS_SCORE, **summ}
    D.write_atomic(os.path.join(sdir, "summary.json"), D.dumps(doc))
    log(f"scored: {len(new)} new outcomes ({sum(o['status'] == 'resolved' for o in new)} resolved), pending "
        f"{sum(pending.values())}, {len(allo)} outcomes from {len(issues)} issues")
    return doc, new


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True, help="root that holds forecasts/q26-deposit-live/")
    ap.add_argument("--expect-commit", default=None, help="refuse unless the code checkout is at this commit")
    ap.add_argument("--max-calls", type=int, default=20000, help="RPC call budget for this run")
    a = ap.parse_args(argv)
    code = D.code_meta(expect_commit=a.expect_commit)
    if a.expect_commit and code["dirty"]:
        raise SystemExit(f"STOP: code files differ from the pinned commit: {code['dirty']}")
    err = lambda m: print(m, file=sys.stderr, flush=True)  # noqa: E731
    score(a.out, D.make_rpc(max_calls=a.max_calls, log=err), D.LogsClient(log=err), code=code,
          log=lambda *x: print(*x, flush=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
