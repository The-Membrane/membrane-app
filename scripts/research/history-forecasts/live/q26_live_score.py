#!/usr/bin/env python3
"""Q26 live forecast log -- daily SCORER (HISTORY_TOUCH_LIVE.md L.4, L.5).

  python3 q26_live_score.py --out <root> [--expect-commit <sha>]

Implements triccs/membrane-board `design/HISTORY_TOUCH_LIVE.md` (registered 9ce3c61, sha256 8961eb5c...).

- Verifies the issue-file hash chain (a broken chain stops the run), then appends the round and Binance stores
  (each run appends; a failed fetch is recorded and the stored data are used).
- A row resolves at the first scorer run >= 15 minutes after asof + T, once the round store covers asof + T
  (it stays pending until then).
- Primary truth: y = 1 iff min(answer in force at asof, every round printed in (asof, asof + T]) <= S * (1 + k).
  Secondary truth (ETH, BTC): the Binance hourly lows of the hours opening asof .. asof + T - 1h, same level.
- A row whose level was touched by a round printed in (asof, issuedAt] is excluded_touched_before_issue and
  never scored. A row whose truth source has a gap > 2 h is unresolved (primary: a missing-data span between
  stored rounds; secondary: a run of missing hourly klines, which leaves only the secondary unresolved).
- Writes each terminal row once to scores/outcomes-YYYY-MM.jsonl (append-only, month of the scorer run) and
  rewrites the derived scores/summary.json: per (asset, T, level, regime, rung) n, n_ep, Brier, BSS vs (a), R;
  the L.5 live check and live STALE values, applied only after 90 resolved issue days per horizon.
"""
import argparse
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import q26_live_common as C  # noqa: E402

SCHEMA = "q26-touch-live/scores/1"

DECISIONS = [
    "Resolution waits for round-store coverage of asof + T (rounds/fetch-log.jsonl coveredThrough, or the last "
    "stored round); before that the row is pending, never guessed.",
    "Primary gap = a span between consecutive stored rounds of the window whose ids are not consecutive (the "
    "getRoundData walk makes this a data-loss check). The time between rounds that the feed printed "
    "consecutively is not a gap (stETH/ETH has a 24 h heartbeat); it is reported as maxRoundSpacingSeconds.",
    "Order: a touch in (asof, issuedAt] -> excluded_touched_before_issue; else a primary gap > 2 h -> unresolved; "
    "else resolved. The secondary truth is computed only for resolved rows, from the Binance store at that run "
    "(missing hours count toward its gap; > 2 h -> secondary unresolved). It uses the row's level S * (1 + k); "
    "y_own_spot (Binance's own close at asof times 1 + k) is reported beside.",
    "Scored p = the issue row's monotone-fixed p per rung. n_ep = maximal runs of y = 1 over consecutive issue "
    "days (A2 D-C1 with daily issues). BSS vs (a) = 1 - Brier(rung) / Brier(a) on the same rows. "
    "R = sum p / sum y ('inf' when sum y = 0 < sum p).",
    "Resolved issue days per horizon = distinct issue dates with a resolved row at that T (all assets). Live "
    "check (shipped rung, per asset, T, level, regime): 0.67 <= R <= 1.5 and n_ep >= 10. Live STALE: rows of "
    "the last 90 resolved issue days of that T, R outside [0.5, 2.0] with n_ep >= 5. Both are reported with "
    "applied = false until 90 resolved issue days for that T.",
    "Model versions (A5.5): from the A5 change date the rows carry model = A5, the A5 shipped rung and an fbL p; "
    "earlier rows (no model field, the A3 model) are never rewritten. Cells report every rung over the rows that "
    "carry it (fbL: A5 rows only; a, f, fb: all rows, the same estimators in both versions). The live check and "
    "live STALE use the shipped rung of the cell's latest resolved row (the current model, named as 'model' when "
    "the row has one), over every resolved row that carries that rung.",
    "Model A6 (A6.5): from the A6 change date rows carry model = A6, fh/fH/fHb p, the A6 shipped rung (top level) "
    "and the A5 shipped rung, p, range and label under 'a5'. The live check and live STALE use the A6 shipped rung "
    "(the latest row's 'shipped'); the A5 shipped rung is still scored (cells report every rung) and its live-check "
    "values are reported beside as previousModelA5 (never deciding).",
]


def load_issue_rows(idir):
    rows, files = [], []
    for date, name in C.list_issue_files(idir):
        with open(os.path.join(idir, name), "rb") as f:
            raw = f.read()
        doc = json.loads(raw)
        if doc.get("nRows") != len(doc["rows"]):
            raise SystemExit(f"STOP: {name}: nRows != number of rows")
        files.append({"date": date, "file": name, "sha256": C.sha256_bytes(raw), "issuedAt": doc["issuedAt"],
                      "asof": doc["asof"], "nRows": len(doc["rows"])})
        for r in doc["rows"]:
            r = dict(r)
            r["date"] = date
            rows.append(r)
    return rows, files


def row_key(r):
    return (r["date"], r["asset"], int(r["T_h"]), repr(float(r["k"])))


def load_outcomes(sdir):
    out, seen = [], set()
    if not os.path.isdir(sdir):
        return out
    for name in sorted(os.listdir(sdir)):
        if not C.OUTCOME_FILE_RE.match(name):
            continue
        with open(os.path.join(sdir, name)) as f:
            for line in f:
                if not line.strip():
                    continue
                o = json.loads(line)
                k = row_key(o)
                if k in seen:
                    raise SystemExit(f"STOP: duplicate outcome {k} in {name}")
                seen.add(k)
                out.append(o)
    return out


def rung_stats(rows):
    """cell_stats per rung: the A3 rungs always (None when absent, as before); fbL, fh, fH, fHb only when some row
    carries them."""
    out = {r: C.cell_stats(rows, r) for r in C.RUNGS}
    for r in C.ALL_SCORED_RUNGS:
        if r not in out:
            st = C.cell_stats(rows, r)
            if st is not None:
                out[r] = st
    return out


def summarize(outcomes, rows, pending, now):
    res = [o for o in outcomes if o["status"] == "resolved"]
    days_T = {C.T_LABEL[T]: sorted({o["date"] for o in res if o["T"] == C.T_LABEL[T]}) for T in C.HORIZONS_H}
    counts = {}
    for a in C.ASSETS:
        for T in C.HORIZONS_H:
            TL = C.T_LABEL[T]
            c = {"rows": sum(r["asset"] == a and r["T"] == TL for r in rows),
                 "pending": sum(p["asset"] == a and p["T"] == TL for p in pending)}
            for s in ("resolved", "excluded_touched_before_issue", "unresolved"):
                c[s] = sum(o["asset"] == a and o["T"] == TL and o["status"] == s for o in outcomes)
            counts.setdefault(a, {})[TL] = c
    cells, secondary, live_check, live_stale = {}, {}, {}, {}
    for a in C.ASSETS:
        for T in C.HORIZONS_H:
            TL = C.T_LABEL[T]
            applied = len(days_T[TL]) >= C.MIN_DAYS_PASS
            last = set(days_T[TL][-C.STALE_WINDOW_DAYS:])
            for k in C.LEVELS[a]:
                kk = repr(float(k))
                rs = [o for o in res if o["asset"] == a and o["T"] == TL and repr(float(o["k"])) == kk]
                if not rs:
                    continue
                groups = {"pooled": rs}
                for g in C.REGIMES:
                    groups[g] = [o for o in rs if o["regime"] == g]
                und = [o for o in rs if o["regime"] is None]
                if und:
                    groups["undefined"] = und
                cells.setdefault(a, {}).setdefault(TL, {})[kk] = {
                    g: rung_stats(v) for g, v in groups.items() if v}
                sec = [dict(o, y=o["secondary"]["y"]) for o in rs
                       if o.get("secondary", {}).get("status") == "resolved"]
                if sec:
                    sg = {"pooled": sec}
                    for g in C.REGIMES:
                        sg[g] = [o for o in sec if o["regime"] == g]
                    secondary.setdefault(a, {}).setdefault(TL, {})[kk] = {
                        g: rung_stats(v) for g, v in sg.items() if v}
                latest = max(rs, key=lambda o: (o["date"], int(o["issuedAt"])))
                ship, model = latest["shipped"], latest.get("model")
                for g in C.REGIMES:
                    gr = groups[g]
                    if not gr:
                        continue
                    st = C.cell_stats(gr, ship)
                    if st is None:
                        continue
                    live_check.setdefault(a, {}).setdefault(TL, {}).setdefault(kk, {})[g] = {
                        "rung": ship, "R_live": st["R"], "n_ep": st["n_ep"], "n": st["n"],
                        "pass": bool(C.r_inside(st["R"], *C.LIVE_CHECK_R) and st["n_ep"] >= C.LIVE_CHECK_NEP),
                        "applied": applied, **({"model": model} if model else {})}
                    if isinstance(latest.get("a5"), dict):     # model A6: the A5 shipped rung, still scored
                        r5 = latest["a5"]["shipped"]
                        s5 = C.cell_stats(gr, r5)
                        if s5 is not None:
                            live_check[a][TL][kk][g]["previousModelA5"] = {
                                "rung": r5, "R_live": s5["R"], "n_ep": s5["n_ep"], "n": s5["n"],
                                "pass": bool(C.r_inside(s5["R"], *C.LIVE_CHECK_R) and s5["n_ep"] >= C.LIVE_CHECK_NEP)}
                    gl = [o for o in gr if o["date"] in last]
                    s2 = C.cell_stats(gl, ship) if gl else None
                    if s2 is not None:
                        live_stale.setdefault(a, {}).setdefault(TL, {}).setdefault(kk, {})[g] = {
                            "rung": ship, "R_live": s2["R"], "n_ep": s2["n_ep"], "n": s2["n"],
                            "stale": bool(s2["n_ep"] >= C.STALE_NEP and not C.r_inside(s2["R"], *C.STALE_R)),
                            "applied": applied, **({"model": model} if model else {})}
    return {"resolvedIssueDaysPerHorizon": {TL: len(v) for TL, v in days_T.items()}, "counts": counts,
            "cells": cells, "secondary": secondary, "liveCheck": live_check, "liveStale": live_stale,
            "passLine": f"No pass line is applied before {C.MIN_DAYS_PASS} resolved issue days per horizon (L.5); "
                        "live results never retune a model."}


def score(out_root, rpc, http_get=None, clock=time.time, code=None, log=print):
    now = int(clock())
    ldir = C.live_dir(out_root)
    idir = C.issues_dir(ldir)
    sdir = os.path.join(ldir, C.SCORES_SUB)
    problems = C.verify_chain(idir)
    if problems:
        raise SystemExit("STOP: hash chain broken:\n  " + "\n  ".join(problems))
    updates, errors = C.update_all_stores(ldir, rpc, http_get=http_get, clock=clock, log=log)
    rounds = {a: C.read_round_store(C.round_store_path(ldir, a)) for a in C.ASSETS}
    coverage = {a: C.round_coverage(ldir, a, rounds[a]) for a in C.ASSETS}
    kidx = {a: C.kline_index(C.read_binance_store(C.binance_store_path(ldir, p)))
            for a, p in C.BINANCE_PAIRS.items()}
    rows, files = load_issue_rows(idir)
    done = load_outcomes(sdir)
    keys = {row_key(o) for o in done}
    new, pending = [], []
    for r in rows:
        if row_key(r) in keys:
            continue
        out, why = C.resolve_row(r, rounds[r["asset"]], kidx.get(r["asset"]), coverage[r["asset"]], now)
        if out is None:
            pending.append({"date": r["date"], "asset": r["asset"], "T": r["T"], "k": r["k"], "reason": why})
            continue
        out["file"] = r["date"] + ".json"
        out["fileSha256"] = next(f["sha256"] for f in files if f["date"] == r["date"])
        new.append(out)
    if new:
        path = os.path.join(sdir, f"outcomes-{C.utc_date(now)[:7]}.jsonl")
        C.append_bytes(path, "".join(json.dumps(C.clean(o), separators=(",", ":"), allow_nan=False) + "\n"
                                     for o in new).encode())
    allo = done + new
    summ = summarize(allo, rows, pending, now)
    doc = {"schema": SCHEMA, "prereg": C.PREREG, "computedAt": now, "computedAtIso": C.iso(now), "code": code,
           "chainVerified": True, "issueFiles": files, "storeUpdates": {k: v for k, v in updates.items() if k != "rpc"},
           "storeUpdateErrors": errors, "rpc": updates.get("rpc"),
           "roundCoverage": {a: (C.iso(c) if c else None) for a, c in coverage.items()},
           "newOutcomes": len(new), "nOutcomes": len(allo), "nPending": len(pending),
           "pendingReasons": {why: sum(p["reason"] == why for p in pending) for why in {p["reason"] for p in pending}},
           "decisions": DECISIONS, **summ}
    C.write_atomic(os.path.join(sdir, "summary.json"), C.dumps(doc))
    log(f"scored: {len(new)} new outcomes ({sum(o['status'] == 'resolved' for o in new)} resolved), "
        f"{len(pending)} pending, {len(allo)} outcomes in total from {len(files)} issue files")
    return doc, new


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True, help="root that holds forecasts/q26-touch-live/")
    ap.add_argument("--expect-commit", default=None, help="refuse unless the code checkout is at this commit")
    ap.add_argument("--max-calls", type=int, default=20000, help="RPC call budget for this run")
    a = ap.parse_args(argv)
    code = C.code_meta(expect_commit=a.expect_commit)
    if a.expect_commit and code["dirty"]:
        raise SystemExit(f"STOP: code files differ from the pinned commit: {code['dirty']}")
    rpc = C.RpcClient(max_calls=a.max_calls, log=lambda m: print(m, file=sys.stderr))
    score(a.out, rpc, code=code, log=lambda *x: print(*x, flush=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
