#!/usr/bin/env python3
"""Q26 live forecast log -- daily ISSUER (HISTORY_TOUCH_LIVE.md L.2, L.3, L.6).

  python3 q26_live_issue.py --datasets <membrane-datasets> --out <root> [--expect-commit <sha>]
      [--frozen-a5 <rel> --frozen-a5-sha256 <sha> [--basis-final <rel> --basis-final-sha256 <sha>]
       [--frozen-a6 <rel> --frozen-a6-sha256 <sha> [--basis-final-a6 <rel> --basis-final-a6-sha256 <sha>]]]

Implements triccs/membrane-board `design/HISTORY_TOUCH_LIVE.md` (registered 9ce3c61, sha256 8961eb5c...).

- issuedAt = the real wall clock at run start (UTC seconds); there is no option to set it.
  asof = issuedAt floored to the hour. date = the UTC date of issuedAt.
- Refuses (L.6) when an issue file dated today or later exists, when the clock went backwards (previous
  issuedAt >= now, or a stored round / kline after now), or when the hash chain is broken.
- Appends the live round store (every Chainlink round printed since the last stored round, by getRoundData on
  a public RPC; bootstrap from the round in force at 2026-10-06T02:00Z) and the Binance kline store.
- Refits A3 rungs (a), (f), (fb) at asof on every labelled origin with t + T <= asof (frozen price-history +
  live hours built from rounds with updatedAt <= asof only), and writes one row per (asset, T, level).
- Writes <out>/forecasts/q26-touch-live/issues/YYYY-MM-DD.json (never rewritten; prevSha256 = sha256 of the
  previous issue file, genesis 64 zeros) and appends issues/chain.jsonl. Git is left to the workflow.
- Model A5 (HISTORY_TOUCH_PREREG_A5.md A5.5; only with --frozen-a5 and its sha256): schema
  q26-touch-live/issue/2 with a top-level `model` field; the same A3 rungs plus (fbL), the A5 shipped rung per
  (asset, T) with its estimate range, A5 label and basis string; the A3 shipped rung and label under `a3` in
  every row (q26_live_a5.py). Without the flag nothing changes. Earlier issue files are never rewritten; the
  hash chain runs through the change unchanged.
- Model A6 (HISTORY_TOUCH_PREREG_A6.md A6.5; only with --frozen-a6 and its sha256, on top of the A5 flags):
  schema q26-touch-live/issue/3, `model` = A6; every A3/A5 field byte-identical to an A5-mode run at the same
  asof, plus (fh), (fH), (fHb), the A6 shipped rung per (asset, T) with its A6 estimate range, A6 label and basis
  string; the A5 shipped rung, p, range and label under `a5` (q26_live_a6.py).
"""
import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):   # one BLAS thread, as the dev runs, so the
    os.environ.setdefault(_v, "1")                                          # iterative (fHb) fits reproduce bit for bit

import argparse  # noqa: E402
import json  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import q26_live_common as C  # noqa: E402

SCHEMA = "q26-touch-live/issue/1"

DECISIONS = [
    "Round store: rows (roundId, answer, updatedAt) as decimal strings; every run appends one gzip member "
    "(mtime 0), so earlier bytes never change and the recorded (bytes, sha256) of a store can be re-checked on "
    "its prefix. Bootstrap = the round in force at 2026-10-06T02:00Z (the last frozen hour's open) and every "
    "later round. All reads of one update are pinned to one block; its timestamp is the store's coverage "
    "(rounds/fetch-log.jsonl).",
    "Live hours (2026-10-06T03:00Z .. asof-1h): close = the answer in force at the hour end (updatedAt <= end); "
    "low = min(answer in force at the hour start, rounds with updatedAt in (start, end]); full feed precision "
    "(answer / 10^decimals), as the A3 panel splice. The frozen builder buckets a round printed exactly on the "
    "hour into the next hour; this rule keeps spot and truth on the registered (asof, asof + T] convention.",
    "The issuer appends every round and closed kline up to the run time (L.2 'each run appends'), but the model "
    "and spot read only rounds with updatedAt <= asof; Binance is never read by the model.",
    "Refit = a3_touch dev fold loop with Q_start = asof: Prep3(long, T, q_max = asof index), beta by "
    "choose_beta(asof index) (D-B2), predict3 at the asof origin; (a) = expanding frequency of the oracle "
    "series (long = oracle for stETH). Each rung's 6 x K grid is monotone-fixed (as A3 scores rows); p = fixed, "
    "p_raw beside. Asserted offline: with asof = DATA_END this reproduces results-dev.json p_data_end exactly.",
    "Frozen label = frozen-a3.json labels[asset][T][shipped][k][current regime]['after'] (the frozen label after "
    "the development-blind check), as L.3 names frozen-a3.json; 'no regime' when rv_pct is undefined.",
    "Binance store: closed klines (closeTime < fetch time) of ETHUSDT/BTCUSDT, from the hour opening "
    "2026-10-06T02:00Z; a Binance failure does not stop the issue (it is secondary truth only).",
    "Threads: the issuer sets OMP/OPENBLAS/MKL_NUM_THREADS to 1 unless the environment sets them (from the A6 pin "
    "on), as the a3..a6 dev runs did; with several BLAS threads the summation order changes and the iterative (fHb) "
    "beta-map fit differs from the dev fit in the 12th significant digit.",
]


def spot_at_asof(rounds, asset, asof):
    r = C.answer_in_force(C.sort_rounds(rounds), asof)
    if r is None:
        raise SystemExit(f"STOP: {asset}: no round in force at asof {C.iso(asof)}")
    return r


def last_frozen_hour_check(rounds, asset, fc):
    """Reported only: the 2026-10-06T02:00Z hour rebuilt from the store vs the frozen price-history values."""
    close, low = C.hourly_close_low(rounds, asset, C.BOOTSTRAP_TS, C.DATA_END)
    dp = C.FROZEN_DP[asset]
    return {"hourOpen": C.iso(C.BOOTSTRAP_TS), "storeClose": float(close[0]), "storeLow": float(low[0]),
            "frozenClose": fc["frozen_oracle_close_last"], "frozenLow": fc["frozen_oracle_low_last"],
            "closeMatchesRounded": round(float(close[0]), dp) == fc["frozen_oracle_close_last"],
            "lowMatchesRounded": round(float(low[0]), dp) == fc["frozen_oracle_low_last"]}


def issue(out_root, datasets, rpc, http_get=None, clock=time.time, forecaster=None, code=None, log=print,
          frozen_a5=None, basis_final=None, frozen_a6=None, basis_final_a6=None):
    """One live issue. `clock`, the transports and `forecaster` are injectable for the offline tests only;
    the CLI always uses the real wall clock, the public endpoints and the A3 refit (model A5: plus fbL).
    frozen_a5 / basis_final: None, or (path relative to datasets, sha256) -- model A5 when frozen_a5 is given."""
    if basis_final is not None and frozen_a5 is None:
        raise SystemExit("STOP: --basis-final needs --frozen-a5")
    if frozen_a6 is not None and frozen_a5 is None:
        raise SystemExit("STOP: --frozen-a6 needs --frozen-a5 (the A5 fields stay in every row)")
    if basis_final_a6 is not None and frozen_a6 is None:
        raise SystemExit("STOP: --basis-final-a6 needs --frozen-a6")
    issued_at = int(clock())
    asof = C.floor_hour(issued_at)
    date = C.utc_date(issued_at)
    ldir = C.live_dir(out_root)
    idir = C.issues_dir(ldir)
    prev_name, prev_sha = C.preflight(idir, date, issued_at)
    C.check_store_clock(ldir, issued_at)
    frozen_inputs = C.verify_frozen_inputs(datasets)
    frozen = C.load_frozen_a3(datasets)
    Q5 = fz5 = bf5 = None
    if frozen_a5 is not None:
        import q26_live_a5 as Q5
        fz5 = Q5.load_frozen_a5(datasets, *frozen_a5)
        bf5 = Q5.load_basis_final(datasets, *basis_final) if basis_final is not None else None
    Q6 = fz6 = bf6 = None
    if frozen_a6 is not None:
        import q26_live_a6 as Q6
        fz6 = Q6.load_frozen_a6(datasets, *frozen_a6)
        bf6 = Q6.load_basis_final_a6(datasets, *basis_final_a6) if basis_final_a6 is not None else None
    log(f"issue {date}: issuedAt {C.iso(issued_at)} asof {C.iso(asof)}; prev {prev_name or 'genesis'}"
        + (f"; model {(Q6 or Q5).MODEL_VERSION}" if Q5 else ""))

    updates, errors = C.update_all_stores(ldir, rpc, http_get=http_get, clock=clock, log=log)
    rounds, coverage = {}, {}
    for a in C.ASSETS:
        if f"chainlink:{a}" in errors:
            raise SystemExit(f"STOP: round store update failed for {a}: {errors[f'chainlink:{a}']}")
        rounds[a] = C.read_round_store(C.round_store_path(ldir, a))
        coverage[a] = C.round_coverage(ldir, a, rounds[a])
        if coverage[a] is None or coverage[a] < asof:
            raise SystemExit(f"STOP: {a} round store does not cover asof")
    store_meta = {}
    spot, in_force = {}, {}
    for a in C.ASSETS:
        r = spot_at_asof(rounds[a], a, asof)
        in_force[a] = r
        spot[a] = C.price(r, a)
        path = C.round_store_path(ldir, a)
        store_meta[a] = {**C.file_meta(path, os.path.relpath(path, ldir)), "nRounds": len(rounds[a]),
                         "nRoundsAtOrBeforeAsof": sum(x.updated_at <= asof for x in rounds[a]),
                         "nRoundsAfterAsofNotUsed": sum(x.updated_at > asof for x in rounds[a]),
                         "coveredThrough": coverage[a], "coveredThroughIso": C.iso(coverage[a])}
    binance_meta = {}
    for pair in C.BINANCE_PAIRS.values():
        path = C.binance_store_path(ldir, pair)
        if os.path.exists(path):
            binance_meta[pair] = {**C.file_meta(path, os.path.relpath(path, ldir)),
                                  "nKlines": len(C.read_binance_store(path))}

    if forecaster is None:
        if Q6:
            forecaster = (lambda d, r, t, log=print: Q6.a6_forecasts(d, r, t, fz5, fz6, log=log))
        elif Q5:
            forecaster = (lambda d, r, t, log=print: Q5.a5_forecasts(d, r, t, fz5, log=log))
        else:
            forecaster = C.model_forecasts
    t0 = time.time()
    upto_asof = {a: [x for x in rounds[a] if x.updated_at <= asof] for a in C.ASSETS}   # no price after asof
    fc = forecaster(datasets, upto_asof, asof, log=log)
    model_seconds = round(time.time() - t0, 1)
    assets = {}
    for a in C.ASSETS:
        f = fc[a]
        if f.get("spot_series") is not None and f["spot_series"] != spot[a]:
            raise SystemExit(f"STOP: {a}: series spot {f['spot_series']} != answer in force at asof {spot[a]}")
        r = in_force[a]
        assets[a] = {"spot": spot[a],
                     "inForceAtAsof": {"roundId": str(r.round_id), "phaseId": r.phase, "aggregatorRoundId": r.agg,
                                       "answer": str(r.answer), "updatedAt": r.updated_at,
                                       "updatedAtIso": C.iso(r.updated_at)},
                     "proxy": C.FEEDS[a][0], "decimals": C.FEEDS[a][1],
                     "regime": f["regime"], "rv_pct": f["rv_pct"], "sigma_hat": f["sigma_hat"],
                     "sigma_ref": f["sigma_ref"], "liveHoursSpliced": f.get("live_hours"),
                     "roundsUsed": f.get("rounds_used"), "betas": f["betas"], "nTrain": f["n_train"]}
        if Q5:
            assets[a]["betasFbL"] = f["betas_fbL"]
            assets[a]["estimateRangeDays"] = f.get("range_days")
        if Q6:
            assets[a]["fitsA6"] = f["fits6"]
            assets[a]["estimateRangeDaysA6"] = f.get("range6_days")
            assets[a]["harComponentsNow"] = f.get("har_now")
        if "frozen_oracle_close_last" in f:
            assets[a]["lastFrozenHourCheck"] = last_frozen_hour_check(rounds[a], a, f)
    if Q6:
        rows = Q6.issue_rows_a6(fc, frozen, fz5, fz6, spot, asof, issued_at, bf5, bf6)
    elif Q5:
        rows = Q5.issue_rows_a5(fc, frozen, fz5, spot, asof, issued_at, bf5)
    else:
        rows = C.issue_rows(fc, frozen, spot, asof, issued_at)
    for r in rows:
        r["date"] = date
    doc = {
        "schema": SCHEMA, "what": "Q26 live price-touch forecasts (A3 rungs a, f, fb), one issue per UTC day",
        "prereg": C.PREREG, "date": date, "issuedAt": issued_at, "issuedAtIso": C.iso(issued_at),
        "asof": asof, "asofIso": C.iso(asof), "prevFile": prev_name, "prevSha256": prev_sha,
        "selfSha256Excluded": True, "code": code,
        "inputs": {"frozen": frozen_inputs,
                   "frozenA3": {"path": C.FROZEN_A3_REL, "sha256": C.FROZEN_A3_SHA256},
                   "roundStores": store_meta, "binanceStores": binance_meta},
        "rpc": updates.get("rpc"), "storeUpdates": {k: v for k, v in updates.items() if k != "rpc"},
        "storeUpdateErrors": errors, "modelSeconds": model_seconds,
        "levels": {a: list(C.LEVELS[a]) for a in C.ASSETS}, "horizons": [C.T_LABEL[t] for t in C.HORIZONS_H],
        "rungs": list(C.RUNGS), "shipped": frozen["shipped"], "assets": assets,
        "rowWindow": "(asof, asof + T]; L = S * (1 + k); resolvesAt = asof + T",
        "decisions": DECISIONS, "nRows": len(rows), "rows": rows,
    }
    if Q5:
        doc = {"schema": Q5.SCHEMA_V2, "model": Q5.MODEL_VERSION,
               **{k: v for k, v in doc.items() if k != "schema"}}
        doc["what"] = ("Q26 live price-touch forecasts (model A5: A5 shipped rung with estimate range, A5 labels "
                       "and basis; A3 rungs a, f, fb and A5 rung fbL issued beside), one issue per UTC day")
        doc["prereg"] = {**C.PREREG, "modelA5": {k: Q5.M5.PREREG[k] for k in ("repo", "path", "commit", "sha256")}}
        doc["inputs"]["frozenA5"] = {"path": frozen_a5[0], "sha256": frozen_a5[1]}
        if basis_final is not None:
            doc["inputs"]["basisFinal"] = {"path": basis_final[0], "sha256": basis_final[1]}
        doc["rungs"] = list(Q5.SCORED_RUNGS)
        doc["shipped"] = fz5["shipped"]
        doc["shippedA3"] = frozen["shipped"]
        doc["estimateRangeWording"] = Q5.RANGE_WORDING
        doc["decisions"] = DECISIONS + Q5.DECISIONS_A5
        if Q6:
            doc["schema"], doc["model"] = Q6.SCHEMA_V3, Q6.MODEL_VERSION
            doc["what"] = ("Q26 live price-touch forecasts (model A6: A6 shipped rung with estimate range, A6 labels "
                           "and dev basis; A3 rungs a, f, fb, A5 rung fbL and A6 rungs fh, fH, fHb issued beside; the "
                           "A5 and A3 shipped rungs kept per row), one issue per UTC day")
            doc["prereg"]["modelA6"] = {k: Q6.M6.PREREG[k] for k in ("repo", "path", "commit", "sha256")}
            doc["inputs"]["frozenA6"] = {"path": frozen_a6[0], "sha256": frozen_a6[1]}
            if basis_final_a6 is not None:
                doc["inputs"]["basisFinalA6"] = {"path": basis_final_a6[0], "sha256": basis_final_a6[1]}
            doc["rungs"] = list(Q6.SCORED_RUNGS)
            doc["shipped"] = fz6["shipped"]
            doc["shippedA5"] = fz5["shipped"]
            doc["decisions"] = DECISIONS + Q5.DECISIONS_A5 + Q6.DECISIONS_A6
        doc = {k: doc[k] for k in [x for x in doc if x not in ("nRows", "rows")] + ["nRows", "rows"]}
    data = C.dumps_with_rows(doc)
    path = os.path.join(idir, date + ".json")
    try:
        C.write_exclusive(path, data)
    except FileExistsError:
        raise SystemExit(f"STOP: {path} appeared during the run; not overwritten")
    sha = C.sha256_bytes(data)
    line = {"date": date, "file": date + ".json", "sha256": sha, "prevSha256": prev_sha, "issuedAt": issued_at}
    C.append_bytes(os.path.join(idir, "chain.jsonl"),
                   (json.dumps(line, separators=(",", ":")) + "\n").encode())
    log(f"wrote {os.path.relpath(path, out_root)} ({len(data)} bytes, sha256 {sha}); {len(rows)} rows")
    return path, doc, sha


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--datasets", required=True, help="membrane-datasets checkout (frozen inputs, read only)")
    ap.add_argument("--out", required=True, help="root that holds forecasts/q26-touch-live/")
    ap.add_argument("--expect-commit", default=None, help="refuse unless the code checkout is at this commit")
    ap.add_argument("--max-calls", type=int, default=20000, help="RPC call budget for this run")
    ap.add_argument("--frozen-a5", default=None, help="model A5: frozen-a5.json path relative to --datasets")
    ap.add_argument("--frozen-a5-sha256", default=None, help="model A5: the registered sha256 of that file")
    ap.add_argument("--basis-final", default=None, help="model A5: basis-final.csv (blind-4 phase) path")
    ap.add_argument("--basis-final-sha256", default=None, help="model A5: the registered sha256 of that file")
    ap.add_argument("--frozen-a6", default=None, help="model A6: frozen-a6.json path relative to --datasets")
    ap.add_argument("--frozen-a6-sha256", default=None, help="model A6: the registered sha256 of that file")
    ap.add_argument("--basis-final-a6", default=None, help="model A6: basis-final.csv (blind-5 phase) path")
    ap.add_argument("--basis-final-a6-sha256", default=None, help="model A6: the registered sha256 of that file")
    a = ap.parse_args(argv)
    if (a.frozen_a5 is None) != (a.frozen_a5_sha256 is None):
        raise SystemExit("STOP: --frozen-a5 and --frozen-a5-sha256 go together")
    if (a.basis_final is None) != (a.basis_final_sha256 is None):
        raise SystemExit("STOP: --basis-final and --basis-final-sha256 go together")
    if (a.frozen_a6 is None) != (a.frozen_a6_sha256 is None):
        raise SystemExit("STOP: --frozen-a6 and --frozen-a6-sha256 go together")
    if (a.basis_final_a6 is None) != (a.basis_final_a6_sha256 is None):
        raise SystemExit("STOP: --basis-final-a6 and --basis-final-a6-sha256 go together")
    if a.frozen_a6 and not a.frozen_a5:
        raise SystemExit("STOP: --frozen-a6 needs --frozen-a5 (the A5 fields stay in every row)")
    if a.basis_final_a6 and not a.frozen_a6:
        raise SystemExit("STOP: --basis-final-a6 needs --frozen-a6")
    code = C.code_meta(expect_commit=a.expect_commit)
    if a.expect_commit and code["dirty"]:
        raise SystemExit(f"STOP: code files differ from the pinned commit: {code['dirty']}")
    rpc = C.RpcClient(max_calls=a.max_calls, log=lambda m: print(m, file=sys.stderr))
    issue(a.out, a.datasets, rpc, code=code, log=lambda *x: print(*x, flush=True),
          frozen_a5=(a.frozen_a5, a.frozen_a5_sha256) if a.frozen_a5 else None,
          basis_final=(a.basis_final, a.basis_final_sha256) if a.basis_final else None,
          frozen_a6=(a.frozen_a6, a.frozen_a6_sha256) if a.frozen_a6 else None,
          basis_final_a6=(a.basis_final_a6, a.basis_final_a6_sha256) if a.basis_final_a6 else None)
    return 0


if __name__ == "__main__":
    sys.exit(main())
