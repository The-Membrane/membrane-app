#!/usr/bin/env python3
"""Q26 per-deposit live log -- daily ISSUER (DEPOSITOR_LIVE.md DL.2-DL.4, DL.7).

  python3 q26_dep_issue.py --datasets <membrane-datasets> --out <root> [--expect-commit <sha>]
      [--model-b4 <shipped-b4.json rel> --model-b4-sha256 <sha> --labels-b4 <labels-dev.csv rel> --labels-b4-sha256 <sha>]

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
- Model B4 (DEPOSITOR_BEHAVIOR_PREREG_B4.md B4.5; only with --model-b4 / --labels-b4 and their sha256): schema
  q26-deposit-live/issue/2 with a top-level `model` field; every B3 column unchanged, then per unit the v4a
  features and per cell v4a, v4b, the B4 shipped rung, its p, the B4 D1 display and the B4 label; the daily store
  daily/snapshots.csv.gz feeds the live v4a features. Without the flags nothing changes. Earlier files are never
  rewritten; the hash chain runs through the change unchanged.
"""
import argparse
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import q26_dep_common as D  # noqa: E402
import r7_live as R7  # noqa: E402  (Q26 round 7 R7.2 top-holder stress; MODEL_DIR is on sys.path via q26_dep_common)

G, S, C = D.G, D.S, D.C

SCHEMA = "q26-deposit-live/issue/1"
SCHEMA_B4 = "q26-deposit-live/issue/2"

DECISIONS_ISSUE = [
    "Model B4 issue order: as model B3, plus the frozen B4 files' sha256 against the flags before any write, the daily "
    "store append after the event and cross-venue appends, and the B4 part of the frozen model (theta_v4a, discounted "
    "O / E and m_seg recomputed and checked) before the rows.",
    "Issue order: guards -> frozen sha256 -> event store append -> asof block -> reserve state (asof, asof - 24 h) "
    "-> rounds / RV7 -> gap logs (store end, asof] -> cross-venue store append, gap and asof prices (failure -> "
    "inputs_unavailable) -> event tables -> candidates -> balanceOf (+ debt) -> holder codes -> frozen model -> rows "
    "-> CSV, header, chain line -> first-seen and holder-code stores.",
    "DL-16 checks in the issuer: the frozen-anchor offset at startup, the append at the store's new last block, and "
    "the frozen + store + in-memory logs up to the asof block (recorded as scaledSupplyCheckAtAsof); any failure "
    "stops the issue before any write.",
    "Hash chain: the JSON header carries csvSha256 (the CSV's bytes) and prevSha256 (the previous header's bytes); "
    "chain.jsonl holds one line per day with both sha256 values. Every link is verified before a write.",
]


def load_refill(datasets, rel, want_sha):
    """R7.2 frozen refill-speed file (r7_refill.py), sha256 checked before any write."""
    path = os.path.join(datasets, rel)
    with open(path, "rb") as f:
        raw = f.read()
    got = D.sha256_bytes(raw)
    if got != want_sha:
        raise SystemExit(f"STOP: sha256 mismatch for the R7.2 refill file {rel}: {got} != registered {want_sha}")
    doc = json.loads(raw)
    if doc.get("schema") != "q26-r7/refill/1" or doc.get("reserve") != "USDC":
        raise SystemExit(f"STOP: {rel} is not an R7.2 USDC refill file")
    for h in R7.REFILL_HOURS:
        float(doc["beta"][f"{h}h"])
    doc["_file"], doc["_sha256"] = rel, got
    return doc


def stress_from_rows(rows, state, refill, asof_ts):
    """R7.2 block from the issue rows at asof (USDC; ranks only, no address). The refill data must end before asof."""
    if int(refill["dataEndTs"]) > int(asof_ts):
        raise SystemExit("STOP: the R7.2 refill file uses data after asof")
    st = state["USDC"]
    units = [(int(r[7]), int(r[5])) for r in rows if r[0] == "USDC"]
    return R7.stress_block(units, st["cash"], st["totalSupply"], refill, reserve="USDC")


def other(r):
    return "USDT" if r == "USDC" else "USDC"


def compute_rows(F, tables, state, state24, rv7, units, codes, first_seen, xv_ok, xvf, asof_block, asof_ts, date,
                 b4days=None):
    """Pure part of the issue: units = [(reserve, address, path_raw, balance_raw, {reserve: debt})].
    b4days = the live daily snapshots (00:00Z <= asof) for model B4, or None (B3 only).
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
        det = {"reserve": r, "address": a, "status": status, "segment": S.SEG_IDS[seg], "gu": gu,
               "balance_raw": bal, "x3": x3, "grid": g}
        if b4days is not None:                                              # model B4 columns after the B3 ones
            live = D.live_daily_unit(tables[r], r, a, b4days, asof_ts)
            f4 = D.b4_features_at(F.b4, gu, live, bal, asof_ts)
            g4 = D.forecast_grid_b4(F, x3[:13], f4, gu, seg, bal, cash, g["fixed"]["v2"])
            row += ([D.fmt_f(f4[D.B4_XK[0]][1])] + [D.fmt_f(f4[xk][0]) for xk in D.B4_XK]
                    + [D.fmt_f(f4[xk][2]) for xk in D.B4_XK] + [len(live), sum(1 for d in live if d["flags"])])
            for c in D.X_CELLS:
                hi, xi = c["hi"], c["xi"]
                tb4 = F.b4["table"][(c["id"], S.SEG_IDS[seg])]
                row += [D.fmt_p(g4["fixed"]["v4a"][hi, xi]), D.fmt_p(g4["fixed"]["v4b"][hi, xi]), tb4["rung"] or "pop",
                        D.fmt_p(g4["ps"][hi, xi]), D.fmt_p(g4["disp"][hi, xi]), tb4["label"]]
            det.update(grid4=g4, f4=f4, live_days=live)
        rows.append(row)
        detail.append(det)
    return rows, detail, new_fs


def header_table(F):
    out = {}
    for c in D.X_CELLS:
        out[c["id"]] = {s: dict(F.table[(c["id"], s)], pop=F.pop[c["id"]]) for s in S.SEG_IDS}
    return out


def header_table_b4(F):
    return {c["id"]: {s: dict(F.b4["table"][(c["id"], s)], m_seg=float(F.b4["mseg"][c["id"]][si]))
                      for si, s in enumerate(S.SEG_IDS)} for c in D.X_CELLS}


def issue(out_root, datasets, rpc, logs_client, clock=time.time, code=None, log=print, frozen=None, model_b4=None,
          gap_fill=True, stress_refill=None):
    """One live issue. `clock`, the transports and `frozen` are injectable for the offline tests only; the CLI
    always uses the real wall clock and the public endpoints. model_b4 = (shipped-b4.json rel, sha256,
    labels-dev.csv rel, sha256) switches to model B4 (schema 2); None keeps model B3. gap_fill = False drops the
    2026-10-08..10-13 daily balances (DL-25; offline comparisons only, the CLI always fills). stress_refill =
    (refill file rel, sha256) adds the R7.2 top-holder stress block (USDC) to the header; None leaves it out."""
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
    frozen_sums = D.frozen_scaled_sums(datasets)                           # DL-16
    anchor_offset = D.check_frozen_offset(frozen_sums)
    b4in = D.load_b4_inputs(datasets, *model_b4) if model_b4 is not None else None
    refill = load_refill(datasets, *stress_refill) if stress_refill is not None else None
    log(f"issue {date}: issuedAt {D.iso(issued_at)} H {D.iso(H)}; prev {prev_name or 'genesis'}")

    head = D.head_block(rpc)
    target = head[0] - D.CONFIRMATIONS
    asof_block, asof_ts, _ = D.find_block_before(rpc, H, head)
    if refill is not None and int(refill["dataEndTs"]) > int(asof_ts):    # R7.2: no look-ahead, before any write
        raise SystemExit("STOP: the R7.2 refill file uses data after asof")
    pending = D.prepare_event_append(ldir, logs_client, rpc, target, frozen_sums, clock=clock)   # checked, not written
    asof_hash = D.get_block(rpc, asof_block)["hash"]
    b24, ts24, _ = D.find_block_before(rpc, asof_ts - D.DAY + 1, head)      # largest block with ts <= asof - 24 h
    state = D.read_reserve_state(rpc, asof_block)
    state24 = D.read_reserve_state(rpc, b24)
    rounds, rmeta = D.eth_rounds_upto(datasets, rpc, asof_block, asof_ts, log=log)
    rv7, H0 = D.rv7_at_asof(rounds, asof_ts)
    gap = []
    if pending["coveredBlock"] < asof_block:
        gap = D.fetch_event_rows(logs_client, rpc, pending["coveredBlock"] + 1, asof_block)
    live_asof = D._add_sums(D.store_scaled_sums(ldir, upto_block=asof_block),
                            D.rows_scaled_sum(iter(pending["rows"] + gap), D.EV_COLS, asof_block))
    asof_check = D.supply_check(rpc, asof_block, frozen_sums, live_asof, "the logs up to asof")   # DL-16
    ev_entry = D.commit_event_append(ldir, pending, log=log)              # both checks passed: write the append
    evst = D.event_store_status(ldir)
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
    daily_entry, b4days = None, None
    if b4in is not None:                                                   # DL-21 live daily balances (model B4)
        daily_entry = D.update_daily_store(ldir, rpc, asof_ts, head, clock=clock, log=log)
        b4days = [d for d in D.read_daily_store(ldir) if d["T"] <= asof_ts and d["block"] < asof_block
                  and (gap_fill or d["date"] >= D.LIVE_DAILY_FIRST)]

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

    F = frozen if frozen is not None else D.load_frozen(datasets, log=log, b4=b4in)
    if b4in is not None and getattr(F, "b4", None) is None:
        raise SystemExit("STOP: model B4 requested but the frozen model has no B4 part")
    codes = D.read_code_store(ldir)
    need = sorted({a for _, a, _, _, _ in units if a not in F.flags and a not in codes})
    new_codes = D.read_codes(rpc, need, asof_block) if need else {}
    codes_all = dict(codes, **new_codes)
    first_seen = D.read_first_seen(ldir)
    t_model = time.time()
    rows, detail, new_fs = compute_rows(F, tables, state, state24, rv7, units, codes_all, first_seen, xv_ok, xvf,
                                        asof_block, asof_ts, date, b4days=b4days)
    model_seconds = round(time.time() - t_model, 1)

    counts = {}
    for d in detail:
        k = counts.setdefault(d["reserve"], {}).setdefault(d["segment"], {"ok": 0, "anchor_mismatch": 0})
        k[d["status"]] += 1
    data = D.csv_bytes(rows, D.CSV_HEADER_B4 if b4in is not None else D.CSV_HEADER)
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
                                  "scaledSupplyCheckAtAsof": asof_check, "frozenAnchorOffset": anchor_offset,
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
    if b4in is not None:
        doc = {"schema": SCHEMA_B4, "model": D.MODEL_B4, **{k: v for k, v in doc.items() if k != "schema"}}
        doc["what"] = ("Q26 per-deposit live forecasts (model B4: frozen v2 / v4a / v4b, B4 shipped rung, B4 D1 display "
                       "and label; the B3 columns v2 / v3 / v3s, B3 shipped rung, display and label kept beside), one "
                       "issue per UTC day, one CSV row per unit")
        doc["prereg"] = dict(D.PREREG, modelB4={"repo": "triccs/membrane-board",
                                                "path": "design/DEPOSITOR_BEHAVIOR_PREREG_B4.md",
                                                "commit": "019adca", "deviation": "D1 07c1f4d"})
        doc["inputs"]["frozenB4"] = F.b4["inputs"]
        dpath = os.path.join(ldir, D.DAILY_SUB, "snapshots.csv.gz")
        doc["inputs"]["dailyStore"] = {
            "update": daily_entry, "daysUsed": [d["date"] for d in b4days], "gapFill": bool(gap_fill),
            "gapDays": [d["date"] for d in b4days if d["date"] < D.LIVE_DAILY_FIRST],
            "rows": [{"date": d["date"], "block": d["block"], "ts": d["ts"], "incomeUSDC": str(d["income"]["USDC"]),
                      "incomeUSDT": str(d["income"]["USDT"])} for d in b4days],
            "sha256": D.sha256_file(dpath), "bytes": os.path.getsize(dpath)}
        doc["frozenModelB4"] = F.b4["check"]
        doc["tableB4"] = header_table_b4(F)
        doc["cellFieldsB4"] = list(D.B4_CELL_FIELDS)
        doc["columns"] = dict(doc["columns"], unitB4=D.B4_UNIT_COLS, cellsB4="<cell>_<field> for the B4 fields")
        doc = {k: doc[k] for k in [x for x in doc if x != "nRows"] + ["nRows"]}
    if refill is not None:                                                 # R7.2 (reported, deciding nothing)
        doc["stressR72"] = dict(stress_from_rows(rows, state, refill, asof_ts),
                                prereg=R7.PREREG_R7, asofBlock=asof_block, asofTs=asof_ts)
        doc["inputs"]["refillR72"] = {"file": refill["_file"], "sha256": refill["_sha256"],
                                      "dataEndIso": refill.get("dataEndIso")}
        doc = {k: doc[k] for k in [x for x in doc if x != "nRows"] + ["nRows"]}
    cpath = os.path.join(idir, csv_name)
    jpath = os.path.join(idir, date + ".json")
    if os.path.exists(cpath) or os.path.exists(jpath):
        raise SystemExit(f"STOP: an issue file for {date} appeared during the run; not overwritten")
    jdata = D.dumps(doc)
    sha = D.sha256_bytes(jdata)
    line = {"date": date, "file": date + ".json", "sha256": sha, "csvFile": csv_name, "csvSha256": doc["csvSha256"],
            "prevSha256": prev_sha, "issuedAt": issued_at}
    with D.AppendTxn([cpath, jpath, os.path.join(idir, "chain.jsonl"),
                      os.path.join(ldir, D.UNITS_SUB, "first-seen.csv.gz"),
                      os.path.join(ldir, D.CODES_SUB, "holder-codes.csv.gz")]):           # DL-18
        D.write_exclusive(cpath, data)
        D.write_exclusive(jpath, jdata)
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
    ap.add_argument("--model-b4", default=None, help="model B4: shipped-b4.json path relative to --datasets")
    ap.add_argument("--model-b4-sha256", default=None, help="model B4: the registered sha256 of that file")
    ap.add_argument("--labels-b4", default=None, help="model B4: labels-dev.csv path relative to --datasets")
    ap.add_argument("--labels-b4-sha256", default=None, help="model B4: the registered sha256 of that file")
    ap.add_argument("--stress-refill", default=None, help="R7.2: frozen refill file path relative to --datasets")
    ap.add_argument("--stress-refill-sha256", default=None, help="R7.2: the registered sha256 of that file")
    a = ap.parse_args(argv)
    if (a.stress_refill is None) != (a.stress_refill_sha256 is None):
        raise SystemExit("STOP: --stress-refill and --stress-refill-sha256 go together")
    b4 = (a.model_b4, a.model_b4_sha256, a.labels_b4, a.labels_b4_sha256)
    if any(v is not None for v in b4) and not all(v is not None for v in b4):
        raise SystemExit("STOP: --model-b4, --model-b4-sha256, --labels-b4 and --labels-b4-sha256 go together")
    code = D.code_meta(expect_commit=a.expect_commit)
    if a.expect_commit and code["dirty"]:
        raise SystemExit(f"STOP: code files differ from the pinned commit: {code['dirty']}")
    err = lambda m: print(m, file=sys.stderr, flush=True)  # noqa: E731
    rpc = D.make_rpc(max_calls=a.max_calls, log=err)
    logs_client = D.LogsClient(log=err)
    issue(a.out, a.datasets, rpc, logs_client, code=code, log=lambda *x: print(*x, flush=True),
          model_b4=b4 if b4[0] is not None else None,
          stress_refill=(a.stress_refill, a.stress_refill_sha256) if a.stress_refill else None)
    return 0


if __name__ == "__main__":
    sys.exit(main())
