#!/usr/bin/env python3
"""Q26 per-deposit live log -- daily ISSUER (DEPOSITOR_LIVE.md DL.2-DL.4, DL.7).

  python3 q26_dep_issue.py --datasets <membrane-datasets> --out <root> [--expect-commit <sha>]

Implements triccs/membrane-board `design/DEPOSITOR_LIVE.md` (registered 3dc8c65, sha256 52d7666a...).

- issuedAt = the real wall clock at run start (UTC seconds); there is no option to set it. asof = the last block
  with ts < issuedAt floored to the hour (H). date = the UTC date of issuedAt.
- Refuses (DL.7) when an issue file dated today or later exists, when the clock went backwards (previous issuedAt
  >= now, or a store fetch after now), when the hash chain is broken, or when a frozen input's sha256 differs from
  the registered value (q26_dep_common.FROZEN_INPUTS).
- Appends the event store (every aUSDC/aUSDT Mint, Burn, BalanceTransfer log after the covered block up to the
  latest block >= 64 old) and the cross-venue store (its logs, daily snapshots and prices).
- Reads at the asof block: reserve state (and at the largest block with ts <= asof ts - 24 h), balanceOf of every
  candidate (event-path balance >= $900k) on its aToken and on both variableDebtTokens (informational), the
  normalized income, cross-venue prices; eth_getCode once per new address.
- Applies the FROZEN B3 model (no refit): unit theta_i recomputed from the frozen inputs, asof parameters,
  theta_seg, seg_pop, shipped rungs and D1 labels; writes one row per unit with balanceOf >= $1M.
- Writes <out>/forecasts/q26-deposit-live/issues/YYYY-MM-DD.csv.gz and YYYY-MM-DD.json (header: issuedAt, asof,
  inputs, code, RPCs, csvSha256, prevSha256 = sha256 of the previous header; genesis 64 zeros) and appends
  issues/chain.jsonl. Files are never rewritten. Git is left to the workflow.
"""
import argparse
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import q26_dep_common as D  # noqa: E402

G, S, C = D.G, D.S, D.C

SCHEMA = "q26-deposit-live/issue/1"

DECISIONS_ISSUE = [
    "Issue order: guards -> frozen sha256 -> event store append -> asof block -> reserve state (asof, asof - 24 h) "
    "-> rounds / RV7 -> gap logs (store end, asof] -> cross-venue store append, gap and asof prices (failure -> "
    "inputs_unavailable) -> event tables -> candidates -> balanceOf (+ debt) -> holder codes -> frozen model -> rows "
    "-> CSV, header, chain line -> first-seen and holder-code stores.",
    "Hash chain: the JSON header carries csvSha256 (the CSV's bytes) and prevSha256 (the previous header's bytes); "
    "chain.jsonl holds one line per day with both sha256 values. Every link is verified before a write.",
]


def other(r):
    return "USDT" if r == "USDC" else "USDC"


def compute_rows(F, tables, state, state24, rv7, units, codes, first_seen, xv_ok, xvf, asof_block, asof_ts, date):
    """Pure part of the issue: units = [(reserve, address, path_raw, balance_raw, {reserve: debt})].
    Returns (csv rows, per-unit detail dicts, new first-seen rows)."""
    rows, detail, new_fs = [], [], []
    for r, a, pb, bal, debt in sorted(units, key=lambda u: (u[0], u[1])):
        ok, diff, tol = D.anchor_ok(pb, bal)
        gu = F.unit.get((r, a))
        if a in F.flags:
            contract, csrc = int(F.flags[a]["contract"]), "address-flags"
        else:
            c = codes[a]
            contract, csrc = int(c["is_contract"]), "eth_getCode"
        if gu is not None and gu in F.first_big_ts:
            age, asrc = (asof_ts - F.first_big_ts[gu]) / D.DAY, "frozen first daily anchor >= $1M"
        elif (r, a) in first_seen:
            age, asrc = (asof_ts - first_seen[(r, a)]["asof_ts"]) / D.DAY, "first live issue " + first_seen[(r, a)]["date"]
        else:
            age, asrc = 0.0, "first live issue (this issue)"
            new_fs.append([r, a, date, asof_block, asof_ts])
        logs = tables[r].logs_of(a)
        if xv_ok:
            known = a in F.flags
            xv = tuple(xvf.get(a, (0.0, 0.0, False, 0)))
            xv_status = "ok" if known else "untracked_address"
        else:
            known, xv, xv_status = False, None, "inputs_unavailable"
        st, st24 = state[r], state24[r]
        x3, seg, band = D.unit_feature_row(r, a, bal, st, st24, rv7, logs, age, contract, xv, known, asof_ts,
                                           asof_block)
        cash = int(st["cash"])
        g = D.forecast_grid(F, x3, gu, seg, bal, cash, xv_ok)
        status = "ok" if ok else "anchor_mismatch"
        row = [r, a, status, int(gu is None), S.SEG_IDS[seg], contract, csrc, bal, pb, diff, tol, D.fmt_f(cash / bal),
               D.fmt_f(age), asrc, xv_status, debt[r], debt[other(r)]] + [int(v) for v in g["capx"]]
        row += [D.fmt_f(v) for v in x3]
        for c in D.X_CELLS:
            hi, xi = c["hi"], c["xi"]
            capped = bool(g["capx"][xi])
            tb = F.table[(c["id"], S.SEG_IDS[seg])]
            row += [D.fmt_p(g["fixed"]["v2"][hi, xi]), D.fmt_p(g["fixed"]["v3"][hi, xi]),
                    D.fmt_p(g["fixed"]["v3s"][hi, xi]), tb["rung"] or "pop", D.fmt_p(g["ps"][hi, xi]),
                    D.fmt_p(g["disp"][hi, xi]), tb["label"], "" if capped else D.fmt_p(g["own"][hi, xi])]
        rows.append(row)
        detail.append({"reserve": r, "address": a, "status": status, "segment": S.SEG_IDS[seg], "gu": gu,
                       "balance_raw": bal, "x3": x3, "grid": g})
    return rows, detail, new_fs


def header_table(F):
    out = {}
    for c in D.X_CELLS:
        out[c["id"]] = {s: dict(F.table[(c["id"], s)], pop=F.pop[c["id"]]) for s in S.SEG_IDS}
    return out


def issue(out_root, datasets, rpc, logs_client, clock=time.time, code=None, log=print, frozen=None):
    """One live issue. `clock`, the transports and `frozen` are injectable for the offline tests only; the CLI
    always uses the real wall clock and the public endpoints."""
    t_start = time.time()
    issued_at = int(clock())
    H = D.floor_hour(issued_at)
    date = D.utc_date(issued_at)
    ldir = D.live_dir(out_root)
    idir = D.issues_dir(ldir)
    prev_name, prev_sha = D.preflight(idir, date, issued_at)
    D.check_store_clocks(ldir, issued_at)
    frozen_inputs = D.verify_frozen_inputs(datasets)
    D.check_store_rows_within_coverage(ldir)
    log(f"issue {date}: issuedAt {D.iso(issued_at)} H {D.iso(H)}; prev {prev_name or 'genesis'}")

    head = D.head_block(rpc)
    target = head[0] - D.CONFIRMATIONS
    ev_entry = D.update_event_store(ldir, logs_client, rpc, target, clock=clock, log=log)
    asof_block, asof_ts, _ = D.find_block_before(rpc, H, head)
    asof_hash = D.get_block(rpc, asof_block)["hash"]
    b24, ts24, _ = D.find_block_before(rpc, asof_ts - D.DAY + 1, head)      # largest block with ts <= asof - 24 h
    state = D.read_reserve_state(rpc, asof_block)
    state24 = D.read_reserve_state(rpc, b24)
    rounds, rmeta = D.eth_rounds_upto(datasets, rpc, asof_block, asof_ts, log=log)
    rv7, H0 = D.rv7_at_asof(rounds, asof_ts)
    evst = D.event_store_status(ldir)
    gap = []
    if evst["coveredBlock"] < asof_block:
        gap = D.fetch_event_rows(logs_client, rpc, evst["coveredBlock"] + 1, asof_block)
    log(f"asof block {asof_block} ({D.iso(asof_ts)}); minus24h {b24}; RV7 {rv7:.4f}; gap logs {len(gap)}")

    # cross-venue (DL-6, DL-7)
    xv_ok, xv_err, xvf, xv_rule, xv_entry, xv_meta = True, None, {}, None, None, {}
    X = D.load_xv_frozen(datasets, log=log)
    try:
        xv_entry = D.update_xv_store(ldir, X, logs_client, rpc, target, head, clock=clock, log=log)
        xst = D.xv_store_status(ldir)
        gap_xv = []
        if xst["coveredBlock"] < asof_block:
            lg = logs_client.get_logs([t["address"] for t in X.tokens], D.XV_TOPICS, xst["coveredBlock"] + 1,
                                      asof_block)
            D.fill_ts(lg, rpc)
            gap_xv = D.xv_decode_logs(X, lg, rpc)
        live = D.xv_read_store(ldir, upto_block=asof_block)
        pools = D.xv_pools(X, rpc, asof_block)
        prow = D.xv_price_rows(X, rpc, asof_block, "asof", pools)
        asof_prices = {p[2]: D.parse_price(p[6], p[7], p[8]) for p in prow}
        xvf, xv_rule = D.xv_features(X, live, asof_block, asof_ts, asof_prices, gap_xv)
        xv_meta = {"store": xst, "gapShareRows": len(gap_xv), "liveSnapshots": [s[0] for s in live["snaps"]],
                   "asofPricesNotOk": sum(1 for p in prow if p[8] != "ok"), "pools": pools,
                   "asofPrices": [{"token": p[2], "symbol": p[3], "price_basis": p[5], "price_num": str(p[6]),
                                   "price_den": str(p[7]), "status": p[8]} for p in prow]}
    except (C.RpcError, D.ProviderDown, SystemExit, ValueError, KeyError, ArithmeticError) as e:
        xv_ok, xv_err = False, f"{type(e).__name__}: {str(e)[:300]}"
        log(f"cross-venue: inputs_unavailable ({xv_err})")
    del X

    tables = D.build_event_tables(datasets, ldir, asof_block, extra_rows=gap, log=log)
    cands = []
    for r in D.RESERVES:
        inc = int(state[r]["normalizedIncome"])
        T = tables[r]
        for c_, s_ in T.scaled.items():
            if s_ > 0:
                pb = D.GE.ray_mul(s_, inc)
                if pb >= D.CANDIDATE_MIN_RAW:
                    cands.append((r, T.addrs[c_], pb))
    debt_tokens = {r: state[r]["variableDebtToken"] for r in D.RESERVES}
    bals = D.read_balances(rpc, asof_block, [(r, a) for r, a, _ in cands], debt_tokens)
    units = [(r, a, pb, bals[(r, a)][0], bals[(r, a)][1]) for r, a, pb in cands if bals[(r, a)][0] >= G.MIN_BAL]
    below = sum(1 for r, a, pb in cands if bals[(r, a)][0] < G.MIN_BAL)
    below_path1m = sum(1 for r, a, pb in cands if bals[(r, a)][0] < G.MIN_BAL and pb >= G.MIN_BAL)
    log(f"candidates {len(cands)}; units {len(units)} (balanceOf >= $1M); candidates below $1M {below}")

    F = frozen if frozen is not None else D.load_frozen(datasets, log=log)
    codes = D.read_code_store(ldir)
    need = sorted({a for _, a, _, _, _ in units if a not in F.flags and a not in codes})
    new_codes = D.read_codes(rpc, need, asof_block) if need else {}
    codes_all = dict(codes, **new_codes)
    first_seen = D.read_first_seen(ldir)
    t_model = time.time()
    rows, detail, new_fs = compute_rows(F, tables, state, state24, rv7, units, codes_all, first_seen, xv_ok, xvf,
                                        asof_block, asof_ts, date)
    model_seconds = round(time.time() - t_model, 1)

    counts = {}
    for d in detail:
        k = counts.setdefault(d["reserve"], {}).setdefault(d["segment"], {"ok": 0, "anchor_mismatch": 0})
        k[d["status"]] += 1
    data = D.csv_bytes(rows)
    csv_name = date + ".csv.gz"
    doc = {
        "schema": SCHEMA, "what": "Q26 per-deposit live forecasts (frozen B3 v2 / v3 / v3s, shipped rung, D1 display), "
                                  "one issue per UTC day, one CSV row per unit",
        "prereg": D.PREREG, "date": date, "issuedAt": issued_at, "issuedAtIso": D.iso(issued_at),
        "asofHour": H, "asofHourIso": D.iso(H),
        "asof": {"block": asof_block, "ts": asof_ts, "tsIso": D.iso(asof_ts), "hash": asof_hash,
                 "rule": "last block with ts < issuedAt floored to the hour"},
        "minus24h": {"block": b24, "ts": ts24, "rule": "largest block with ts <= asof ts - 86400"},
        "prevFile": prev_name, "prevSha256": prev_sha, "csvFile": csv_name, "csvSha256": D.sha256_bytes(data),
        "csvBytes": len(data), "selfSha256Excluded": True, "code": code,
        "inputs": {"frozen": frozen_inputs, "rounds": rmeta,
                   "eventStore": {"update": ev_entry, "status": evst, "gapLogs": len(gap),
                                  "gapRange": [evst["coveredBlock"] + 1, asof_block] if gap or
                                  evst["coveredBlock"] < asof_block else None,
                                  "files": {os.path.basename(p): {"sha256": D.sha256_file(p),
                                                                  "bytes": os.path.getsize(p)}
                                            for p in D.event_files(ldir)}},
                   "crossVenue": {"status": "ok" if xv_ok else "inputs_unavailable", "error": xv_err,
                                  "update": xv_entry, "rule": xv_rule, **xv_meta},
                   "holderCodesRead": {a: v for a, v in new_codes.items()}},
        "reserveState": {"asof": state, "minus24h": state24}, "rv7": rv7, "rv7H0": H0, "rv7H0Iso": D.iso(H0),
        "rpc": rpc.stats(), "logsRpc": logs_client.stats(),
        "frozenModel": {"universeUnits": F.n_units, "thetaSegCheckMaxAbsDiff": F.theta_seg_check},
        "counts": {"candidates": len(cands), "candidatesBelow1M": below, "candidatesPathAbove1MBalanceBelow": below_path1m,
                   "units": len(units), "newUnits": sum(d["gu"] is None for d in detail),
                   "newHolderCodes": len(new_codes), "newFirstSeen": len(new_fs), "byReserveSegmentStatus": counts},
        "cells": [c["id"] for c in D.X_CELLS], "cellFields": list(D.CELL_FIELDS),
        "table": header_table(F),
        "columns": {"unit": D.UNIT_COLS, "features": D.FEAT_COLS, "cells": "<cell>_<field> for each cell and field"},
        "cappedWording": "capped now: cash covers at most N% of this balance (N = 100 * cash_over_bal)",
        "rowWindow": "event times in (H, H + h]; path = balance_raw + G.2 changes of blocks after the asof block; "
                     "y(x, h) = 1 iff 100 * min path <= (100 - x) * balance_raw",
        "modelSeconds": model_seconds, "runSeconds": round(time.time() - t_start, 1),
        "decisions": D.DECISIONS + DECISIONS_ISSUE, "nRows": len(rows),
    }
    cpath = os.path.join(idir, csv_name)
    jpath = os.path.join(idir, date + ".json")
    try:
        D.write_exclusive(cpath, data)
        jdata = D.dumps(doc)
        D.write_exclusive(jpath, jdata)
    except FileExistsError:
        raise SystemExit(f"STOP: an issue file for {date} appeared during the run; not overwritten")
    sha = D.sha256_bytes(jdata)
    line = {"date": date, "file": date + ".json", "sha256": sha, "csvFile": csv_name, "csvSha256": doc["csvSha256"],
            "prevSha256": prev_sha, "issuedAt": issued_at}
    D.append_bytes(os.path.join(idir, "chain.jsonl"), (json.dumps(line, separators=(",", ":")) + "\n").encode())
    if new_fs:
        D.append_gz_rows(os.path.join(ldir, D.UNITS_SUB, "first-seen.csv.gz"), D.FIRST_SEEN_COLS, new_fs)
    if new_codes:
        D.append_code_store(ldir, new_codes, asof_block, issued_at)
    log(f"wrote {os.path.relpath(jpath, out_root)} + {csv_name} ({len(data)} bytes, sha256 {doc['csvSha256'][:16]}..); "
        f"{len(rows)} units; {round(time.time() - t_start)} s")
    return jpath, doc, rows


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--datasets", required=True, help="membrane-datasets checkout (frozen inputs, read only)")
    ap.add_argument("--out", required=True, help="root that holds forecasts/q26-deposit-live/")
    ap.add_argument("--expect-commit", default=None, help="refuse unless the code checkout is at this commit")
    ap.add_argument("--max-calls", type=int, default=40000, help="RPC call budget for this run")
    a = ap.parse_args(argv)
    code = D.code_meta(expect_commit=a.expect_commit)
    if a.expect_commit and code["dirty"]:
        raise SystemExit(f"STOP: code files differ from the pinned commit: {code['dirty']}")
    err = lambda m: print(m, file=sys.stderr, flush=True)  # noqa: E731
    rpc = D.make_rpc(max_calls=a.max_calls, log=err)
    logs_client = D.LogsClient(log=err)
    issue(a.out, a.datasets, rpc, logs_client, code=code, log=lambda *x: print(*x, flush=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
