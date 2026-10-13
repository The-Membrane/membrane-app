#!/usr/bin/env python3
"""T5.1 -- live M1 touch-forecast issuer (prospective; the real test).

Implements triccs/membrane-board `design/VALIDATION_PREREG.md` (commit 506e7c5), T5.1, with the T1.2
estimator and the T1.5 calibration maps.

  python3 m1_issue.py --datasets <membrane-datasets> --out <dir> [--commit] [--max-calls N]

Writes <out>/forecasts/m1-live/YYYY-MM-DD.json (UTC date of issuedAt) and appends one line to
<out>/forecasts/m1-live/chain.jsonl. Reads (never writes) <datasets>.

- issuedAt = the real wall-clock time at run start (UTC seconds). There is NO option to set it.
  asof = issuedAt floored to the hour.
- DVOL = close of the Deribit hourly DVOL candle opening at asof-1h (= the last CLOSED candle at asof).
- S = Chainlink proxy latestRoundData() at issue (roundId, answer, updatedAt recorded).
- RV30 / RV90 = T1.2 estimator on daily closes P_k = Chainlink answer in force at asof - k*86400
  (k = 0..30 / 0..90): from the frozen price-history `oracle` column when the hour opening at
  asof - k*86400 - 3600 is inside it, else from Chainlink rounds on a public RPC (answer_at).
- Grid: ETH, BTC x T1 levels x T1 horizons; window (asof, asof+T]; p_raw and p_cal per source.
- Hash chain: prevFile / prevSha256 (sha256 of the previous day file's bytes; genesis 64 zeros),
  selfSha256Excluded = true. Refuses to overwrite, refuses a second file for the same UTC date.
- --commit: git add + commit (only the day file and chain.jsonl) + push origin main in the repo
  holding --out. Requires the issuing code to be committed (gitDirty = false).
"""
import argparse
import json
import math
import os
import sys
import time
import urllib.parse

import chainlink as cl
import t1_touch as t1
from t5_common import (DAY, HOUR, PREREG, ZERO_SHA, code_provenance, commit_and_push, dumps, floor_hour,
                       get_with_retry, iso, list_day_files, repo_relpaths, require_clean_code, sha256_bytes,
                       sha256_file, utc_date, verify_chain, write_exclusive, _git)

SCHEMA = "m1-live/1"
DAY_DIR_REL = os.path.join("forecasts", "m1-live")
MAPS_REL = "validation/t1/calibration-maps.json"
MAPS_SHA256 = "355f7e7f0a31e78f7682ced876db1c6dea92417c6852827457dd9cf23dd5893d"  # T1.5 maps (T1 has run)
T1_RESULTS_REL = "validation/t1/results.json"
DVOL_API = "https://www.deribit.com/api/v2/public/get_volatility_index_data"
SETTLE_SECONDS = 60          # the DVOL candle closing at asof must have closed at least this long ago
K_MAX = max(t1.RV_DAYS.values())  # 90
ASSETS = t1.ASSETS
SOURCES = t1.SOURCES

NOTES = [
    "issuedAt = int(time.time()) at run start (no option can set it); asof = issuedAt floored to the hour.",
    "DVOL = close of the Deribit DVOL candle opening at asof-1h (it closes at asof), / 100. The request uses "
    "end_timestamp = asof-1h (Deribit end is inclusive), so the candle opening at asof (still open) is not "
    "requested; any row opening after asof-1h that comes back anyway is discarded. Refused if the candle is "
    "absent, non-positive, or issuedAt - asof < 60 s.",
    "S = the Chainlink answer in force AT asof (= RV close k=0, inputs.<asset>.rv.closes[0]), per prereg "
    "deviation D2: T5.1 named latestRoundData() at issue but also forbids any price after asof. "
    "latestRoundData() at issue is kept in inputs.<asset>.S.latestRoundDataAtIssue_referenceOnly.",
    "RV daily close P_k (k=0..90) = Chainlink answer in force at asof - k*86400. Source: price-history "
    "`oracle` of the hour opening at asof - k*86400 - 3600 when that hour is inside the frozen file "
    "(values rounded to cents there), else Chainlink answer_at on a public RPC (round with the largest "
    "updatedAt <= t; full 8-decimal answer). rv.switchCheck compares both sources at the first history "
    "close (not used in the forecast).",
    "RV30 / RV90 = t1_touch.realized_vol over P_0..P_30 / P_0..P_90 (T1.2: log returns, mean removed, "
    "n-1, x365, sqrt). A null close -> that sigma is null -> its probabilities are null.",
    "p_raw = t1_touch.touch_prob (T1.2 zero-drift first passage); p_cal = T1.5 isotonic map for that "
    "source and horizon (validation/t1/calibration-maps.json, sha256 checked), via t1_touch.touch_forecast.",
    "Row window (asof, asof + T*86400]; resolvesAt = asof + T*86400; L = S * (1 + k).",
    "No RPC URL is written to this file; rpc holds counts only.",
]


# ---------------------------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------------------------
def load_price_history(datasets_dir):
    """Frozen T1.1 price files, sha256 verified -> grids, provenance."""
    grids, meta = {}, {}
    for asset, key in (("ETH", "eth_price"), ("BTC", "btc_price")):
        rel, want = t1.INPUTS[key]
        path = os.path.join(datasets_dir, rel)
        got = sha256_file(path)
        if got != want:
            raise SystemExit(f"STOP: sha256 mismatch for {rel}: {got} != registered {want}")
        g = t1.load_price_grid(path)
        grids[asset] = g
        meta[asset] = {"path": rel, "sha256": got, "lastHourOpen": iso(g.end_ts - g.step), "lastClose": iso(g.end_ts)}
    return grids, meta


def load_calibration(datasets_dir):
    path = os.path.join(datasets_dir, MAPS_REL)
    if not os.path.exists(path):
        raise SystemExit(f"STOP: {MAPS_REL} not found under --datasets (T1 has produced maps)")
    try:
        maps = t1.load_maps(path, expected_sha256=MAPS_SHA256)
    except ValueError as e:
        raise SystemExit(f"STOP: calibration maps: {e}")
    meta = {"status": "T1.5 maps", "maps": MAPS_REL, "sha256": MAPS_SHA256,
            "method": "isotonic (T1.5), numpy.interp over the fitted x, constant beyond the ends, clipped to [0,1]",
            "t1Verdict": None, "t1Results": T1_RESULTS_REL, "t1ResultsSha256": None}
    rpath = os.path.join(datasets_dir, T1_RESULTS_REL)
    if os.path.exists(rpath):
        with open(rpath) as f:
            res = json.load(f)
        if res.get("calibration", {}).get("calibration_maps", {}).get("sha256") != MAPS_SHA256:
            raise SystemExit("STOP: T1 results.json refers to different calibration maps")
        meta["t1Verdict"] = res.get("verdict", {}).get("verdict")
        meta["t1ResultsSha256"] = sha256_file(rpath)
    meta["note"] = (f"T1 verdict {meta['t1Verdict']}: M1 is not shipped on retrospective evidence. Per T5.1 each "
                    "live row still carries raw AND calibrated probabilities from these unchanged maps.")
    return maps, meta


def dvol_candle(asset, asof, issued_at, get=None):
    """Close of the Deribit DVOL hourly candle opening at asof - 1h (the last candle CLOSED at asof)."""
    open_ts = asof - HOUR
    if open_ts + HOUR > issued_at:
        raise SystemExit(f"STOP: DVOL candle {iso(open_ts)} not closed at issue")
    params = {"currency": asset, "start_timestamp": (asof - 3 * HOUR) * 1000,
              "end_timestamp": open_ts * 1000, "resolution": 3600}
    raw = get_with_retry(DVOL_API + "?" + urllib.parse.urlencode(params), get=get)
    doc = json.loads(raw)
    if not isinstance(doc.get("result"), dict) or "data" not in doc["result"]:
        raise SystemExit(f"STOP: DVOL {asset}: unexpected response (error: {doc.get('error')})")
    rows = doc["result"]["data"]
    newer = [r for r in rows if int(r[0]) > open_ts * 1000]  # still-open / future candles: never used
    match = [r for r in rows if int(r[0]) == open_ts * 1000]
    if len(match) != 1:
        raise SystemExit(f"STOP: DVOL {asset} candle opening {iso(open_ts)} not available ({len(match)} rows)")
    row = match[0]
    close = row[4]
    if close is None or not math.isfinite(float(close)) or float(close) <= 0:
        raise SystemExit(f"STOP: DVOL {asset} candle {iso(open_ts)} has no valid close: {close!r}")
    return {"endpoint": "deribit public/get_volatility_index_data", "params": params,
            "candleOpen": iso(open_ts), "candleClose": iso(asof), "row": row, "columns": ["open_ms", "open",
            "high", "low", "close"], "close": float(close), "sigma": float(close) / 100.0,
            "discardedNewerRows": len(newer)}


def _round_close(k, t_k, r):
    return {"k": k, "t": iso(t_k), "price": r.price(), "source": "chainlink", "roundId": str(r.round_id),
            "phaseId": r.phase, "aggregatorRoundId": r.agg, "answer": r.answer, "updatedAt": r.updated_at}


def rv_closes(grid, feed, asof, k_max=K_MAX):
    """P_k for k = 0..k_max with per-close source. Returns (closes, switchCheck)."""
    closes, upper = [], None
    for k in range(k_max + 1):
        t_k = asof - k * DAY
        hour_open = t_k - HOUR
        if grid.index_of_open(hour_open) is not None:
            closes.append({"k": k, "t": iso(t_k), "price": grid.value_at_open("oracle", hour_open),
                           "source": "price-history", "hourOpen": iso(hour_open)})
        else:
            r = feed.answer_at(t_k, upper=upper)
            upper = r
            closes.append(_round_close(k, t_k, r))
    check = None
    first_hist = next((c for c in closes if c["source"] == "price-history"), None)
    if first_hist is not None and first_hist["k"] > 0 and first_hist["price"] is not None:
        t_k = asof - first_hist["k"] * DAY
        r = feed.answer_at(t_k, upper=upper)
        check = {"k": first_hist["k"], "t": iso(t_k), "historyPrice": first_hist["price"],
                 "chainPrice": r.price(), "roundId": str(r.round_id), "updatedAt": r.updated_at,
                 "absDiff": abs(r.price() - first_hist["price"]), "usedInForecast": False}
    return closes, check


def _sigma(s):
    return s if (s is not None and math.isfinite(s) and s > 0) else None


def build_grid(asset, S, sigmas, maps, asof):
    avail = {src: s for src, s in sigmas.items() if s is not None}
    fc = t1.touch_forecast(asset, S, avail, t1.LEVELS, t1.HORIZONS, maps) if avail else []
    idx = {(r["source"], r["T"], r["k"]): r for r in fc}
    rows = []
    for T in t1.HORIZONS:
        end = asof + T * DAY
        for k in t1.LEVELS:
            p_raw, p_cal = {}, {}
            for src in SOURCES:
                r = idx.get((src, T, k))
                p_raw[src] = None if r is None else r["p_raw"]
                p_cal[src] = None if r is None else r["p_cal"]
            rows.append({"asset": asset, "T": T, "k": k, "S": S, "L": S * (1.0 + k),
                         "window": "(asof, asof+T]", "windowStart": iso(asof), "windowEnd": iso(end),
                         "resolvesAt": iso(end), "resolvesAtTs": end, "p_raw": p_raw, "p_cal": p_cal})
    return rows


# ---------------------------------------------------------------------------------------------
# Guards
# ---------------------------------------------------------------------------------------------
def preflight(day_dir, date, issued_at):
    """No-overwrite and chain guards. Returns (prevFile, prevSha256)."""
    path = os.path.join(day_dir, date + ".json")
    if os.path.exists(path):
        raise SystemExit(f"STOP: {date}.json exists. A day file is never rewritten; a missed day stays missing.")
    files = list_day_files(day_dir)
    same_or_later = [n for d, n in files if d >= date]
    if same_or_later:
        raise SystemExit(f"STOP: day file(s) dated {date} or later exist: {same_or_later}. Never backdated.")
    problems = verify_chain(day_dir)
    if problems:
        raise SystemExit("STOP: hash chain broken:\n  " + "\n  ".join(problems))
    if not files:
        return None, ZERO_SHA
    prev_name = files[-1][1]
    with open(os.path.join(day_dir, prev_name), "rb") as f:
        raw = f.read()
    prev_issued = json.loads(raw).get("issuedAt")
    if prev_issued is not None and int(prev_issued) >= issued_at:
        raise SystemExit(f"STOP: clock went backwards: {prev_name} issuedAt {iso(prev_issued)} >= now {iso(issued_at)}")
    return prev_name, sha256_bytes(raw)


# ---------------------------------------------------------------------------------------------
# Issue
# ---------------------------------------------------------------------------------------------
def issue(out_dir, grids, price_meta, maps, cal_meta, rpc, http_get=None, clock=time.time, log=print,
          code=None):
    """One live issue. `clock` and the transports are injectable for the offline tests only; the CLI
    always uses the real wall clock and the public endpoints."""
    issued_at = int(clock())
    asof = floor_hour(issued_at)
    date = utc_date(issued_at)
    day_dir = os.path.join(out_dir, DAY_DIR_REL)
    path = os.path.join(day_dir, date + ".json")
    prev_name, prev_sha = preflight(day_dir, date, issued_at)
    if issued_at - asof < SETTLE_SECONDS:
        raise SystemExit(f"STOP: issuedAt {iso(issued_at)} is < {SETTLE_SECONDS} s after asof {iso(asof)}; "
                         "the DVOL candle closing at asof may not be final. Run again a minute later.")

    feeds = {a: cl.Feed(rpc, cl.FEEDS[a], clock=clock) for a in ASSETS}
    spot = {a: feeds[a].latest_round_data() for a in ASSETS}  # reference only (prereg deviation D2)
    inputs, grid = {}, []
    for a in ASSETS:
        lr = spot[a]
        dv = dvol_candle(a, asof, issued_at, get=http_get)
        closes, check = rv_closes(grids[a], feeds[a], asof)
        # D2: S is the Chainlink answer in force AT asof (closes[0]), never a round written after asof,
        # so no forecast input post-dates the start of its window (asof, asof + T].
        s_close = closes[0]
        if s_close["k"] != 0 or s_close["price"] is None:
            raise SystemExit(f"STOP: {a}: no Chainlink answer in force at asof {iso(asof)}")
        S = s_close["price"]
        prices = [c["price"] for c in closes]
        sig = {"DVOL": _sigma(dv["sigma"])}
        for name, K in t1.RV_DAYS.items():
            sig[name] = _sigma(t1.realized_vol(prices[:K + 1]))
        src_counts = {}
        for c in closes:
            src_counts[c["source"]] = src_counts.get(c["source"], 0) + 1
        inputs[a] = {
            "S": {"source": "chainlink answer in force at asof (= rv.closes[0]); prereg deviation D2",
                  "feed": cl.FEEDS[a], "decimals": cl.DECIMALS, "price": S, "close": s_close,
                  "latestRoundDataAtIssue_referenceOnly": {
                      **lr.to_json(), "updatedAtIso": iso(lr.updated_at),
                      "ageSecondsAtIssue": issued_at - lr.updated_at, "updatedAfterAsof": lr.updated_at > asof}},
            "DVOL": dv,
            "rv": {"closes": closes, "sourceCounts": src_counts, "switchCheck": check,
                   "estimator": "t1_touch.realized_vol (T1.2)"},
            "sigma": sig,
        }
        grid += build_grid(a, S, sig, maps, asof)
        log(f"{a}: S={S:.2f} (in force at asof: round {s_close.get('phaseId')}/{s_close.get('aggregatorRoundId')}, "
            f"source {s_close['source']}; latest at issue {lr.price():.2f}) "
            f"DVOL={sig['DVOL']} RV30={sig['RV30']} RV90={sig['RV90']} closes {src_counts}")

    doc = {
        "schema": SCHEMA, "kind": "live", "test": "T5", "prereg": {**PREREG, "section": "T5.1 (T1.2, T1.5)"},
        "date": date, "issuedAt": issued_at, "issuedAtIso": iso(issued_at), "asof": asof, "asofIso": iso(asof),
        "prevFile": prev_name, "prevSha256": prev_sha, "selfSha256Excluded": True,
        "calibration": cal_meta, "code": code, "priceHistory": price_meta,
        "inputs": inputs, "levels": list(t1.LEVELS), "horizons": list(t1.HORIZONS), "sources": list(SOURCES),
        "nRows": len(grid), "grid": grid, "rpc": rpc.stats(), "notes": NOTES,
    }
    data = dumps(doc)
    try:
        write_exclusive(path, data)
    except FileExistsError:
        raise SystemExit(f"STOP: {path} appeared during the run; not overwritten")
    sha = sha256_bytes(data)
    line = {"date": date, "file": date + ".json", "sha256": sha, "prevSha256": prev_sha, "issuedAt": issued_at}
    with open(os.path.join(day_dir, "chain.jsonl"), "a") as f:
        f.write(json.dumps(line, separators=(",", ":")) + "\n")
    log(f"wrote {path} ({len(data)} bytes, sha256 {sha}); prev {prev_name or 'genesis'}; "
        f"{len(grid)} rows; rpc {rpc.stats()['ethCalls']} eth_calls / {rpc.stats()['httpRequests']} requests")
    return path, doc, sha


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--datasets", required=True, help="membrane-datasets checkout (read only)")
    ap.add_argument("--out", required=True, help="root that receives forecasts/m1-live/ (the datasets repo "
                                                 "for a real issue)")
    ap.add_argument("--commit", action="store_true", help="git add/commit/push the day file + chain.jsonl")
    ap.add_argument("--max-calls", type=int, default=1000, help="eth_call budget for this run")
    a = ap.parse_args(argv)
    code = code_provenance(__file__, ["chainlink.py", "t1_touch.py", "t5_common.py"])
    if a.commit:
        require_clean_code(code)
        _git(a.out, "rev-parse", "--show-toplevel")  # --out must be inside a git checkout
    grids, price_meta = load_price_history(a.datasets)
    maps, cal_meta = load_calibration(a.datasets)
    rpc = cl.RpcClient(max_calls=a.max_calls, log=lambda m: print(m, file=sys.stderr))
    path, doc, sha = issue(a.out, grids, price_meta, maps, cal_meta, rpc, code=code)
    if a.commit:
        day_dir = os.path.dirname(path)
        rel = repo_relpaths(a.out, [path, os.path.join(day_dir, "chain.jsonl")])
        commit_and_push(a.out, rel, f"forecasts/m1-live: issue {doc['date']} (Q25)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
