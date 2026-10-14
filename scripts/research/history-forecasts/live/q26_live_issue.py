#!/usr/bin/env python3
"""Q26 live forecast log -- daily ISSUER (HISTORY_TOUCH_LIVE.md L.2, L.3, L.6).

  python3 q26_live_issue.py --datasets <membrane-datasets> --out <root> [--expect-commit <sha>]

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
"""
import argparse
import json
import os
import sys
import time

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


def issue(out_root, datasets, rpc, http_get=None, clock=time.time, forecaster=None, code=None, log=print):
    """One live issue. `clock`, the transports and `forecaster` are injectable for the offline tests only;
    the CLI always uses the real wall clock, the public endpoints and the A3 refit."""
    issued_at = int(clock())
    asof = C.floor_hour(issued_at)
    date = C.utc_date(issued_at)
    ldir = C.live_dir(out_root)
    idir = C.issues_dir(ldir)
    prev_name, prev_sha = C.preflight(idir, date, issued_at)
    C.check_store_clock(ldir, issued_at)
    frozen_inputs = C.verify_frozen_inputs(datasets)
    frozen = C.load_frozen_a3(datasets)
    log(f"issue {date}: issuedAt {C.iso(issued_at)} asof {C.iso(asof)}; prev {prev_name or 'genesis'}")

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

    forecaster = forecaster or C.model_forecasts
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
        if "frozen_oracle_close_last" in f:
            assets[a]["lastFrozenHourCheck"] = last_frozen_hour_check(rounds[a], a, f)
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
    a = ap.parse_args(argv)
    code = C.code_meta(expect_commit=a.expect_commit)
    if a.expect_commit and code["dirty"]:
        raise SystemExit(f"STOP: code files differ from the pinned commit: {code['dirty']}")
    rpc = C.RpcClient(max_calls=a.max_calls, log=lambda m: print(m, file=sys.stderr))
    issue(a.out, a.datasets, rpc, code=code, log=lambda *x: print(*x, flush=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
