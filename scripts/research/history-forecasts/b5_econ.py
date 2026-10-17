#!/usr/bin/env python3
"""Q26 workstream B5 (round 7, R7.3): the economic-exit target y_econ on Aave V3 Core USDC.

Implements membrane-board `design/Q26_ROUND7_PREREG.md` section R7.3 (registered at board commit 5568616) on top of
B4 (`DEPOSITOR_BEHAVIOR_PREREG_B4.md`, D1, D2), B3 and B-gradient, whose code is imported unchanged (rows, intraday
paths, folds, the v2 / v4a specifications and fits, G.7 labels, the monotone fix, segments, the B4.3 comparison and
shipping rule). Every B5 choice the prereg leaves open is listed in DECISIONS.

y_econ(x, h) = 1 iff, at some event time t in (t0, t0 + h], the unit's aToken balance fall bal(t0) - bal(t) plus
its net new variable debt on any Core reserve (Pool Borrow with the unit as onBehalfOf, interestRateMode 2, minus
Pool Repay with the unit as user, both in USD at the Aave oracle price) reaches x * bal(t0). Rows with
x * bal(t0) > cash(t0) are kept and flagged cash_blocked.

Phases (in this order; data phases write to --debt-dir, scoring phases to one fresh --out):
  --phase debt-events  Core Pool Repay logs (deployment window: first snapshot block + 1 .. 26,186,746) and the
                       Borrow logs before the published aave-pool-borrows range (first snapshot block + 1 ..
                       18,251,964); free eth_getLogs on rpc.mevblocker.io -> --debt-dir (+ debt-manifest.json)
  --phase prices       Aave oracle getAssetPrice (8 decimals, USD) of every reserve seen in a Borrow / Repay of a
                       USDC-universe address, at every daily snapshot block; decimals() at the asof block
                       -> --debt-dir/prices-daily.csv.gz (+ prices-manifest.json)
  --phase run          ONCE: y_econ labels; B4 reference fits (USDC + USDT, old target, B4 exactly) scored on
                       y_econ; v2e and v4ae fits (USDC only, y_econ) per B3 fold x cell; B4.3 comparisons, labels;
                       stress-window and segment reports; asof fits -> results-b5.json, labels-b5.csv,
                       predictions-b5-*.csv.gz (refuses overwrite)
  --phase freeze       frozen fits -> frozen-b5.json + freeze-record.json (sha256)
  --phase manifest     sha256 of every output

No blind phase: all USDC history has been read; the blind test is the live log (R7.3).
Addresses are public on-chain data. This code attaches no identity, label or name to any address.
"""
import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import csv  # noqa: E402
import gzip  # noqa: E402
import json  # noqa: E402
import math  # noqa: E402
import subprocess  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402
from datetime import datetime, timezone  # noqa: E402

import numpy as np  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import b_behavior as B  # noqa: E402
import bg_gradient as G  # noqa: E402
import b3_segments as S  # noqa: E402
import b4_depositor as F  # noqa: E402

PREREG = {
    "repo": "membrane-board", "path": "design/Q26_ROUND7_PREREG.md", "section": "R7.3", "commit": "5568616",
    "parents": {"B4": "design/DEPOSITOR_BEHAVIOR_PREREG_B4.md (019adca; D1, D2)",
                "B3": "design/DEPOSITOR_BEHAVIOR_PREREG_B3.md (cac7aeb; D1)",
                "B-gradient": "design/DEPOSITOR_BEHAVIOR_PREREG_B2.md (5e45406; D1-D3)"},
}
B4_RUN = "history-forecasts/b4/run-2035639d/"
BORROWS_DIR = "aave-pool-borrows/"
CORE_POOL = F.CORE_POOL
ORACLE = "0x54586bE62E3c3580375aE3723C145253060Ca0C2"          # Aave V3 Ethereum oracle (constant 2023-02..asof)
ADDRESSES_PROVIDER = "0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e"
REPAY_SIG = "Repay(address,address,address,uint256,bool)"
BORROW_SIG = F.BORROW_SIG
FIRST_SNAPSHOT = "2023-02-01"
BORROW_PUBLISHED_FROM = 18_251_965                              # aave-pool-borrows (67e78b4) from_block
TO_BLOCK = F.BORROW_TO_BLOCK                                    # 26,186,746 (the asof block of every dataset)
VARIABLE_MODE = 2
PRICE_DEC = 8
SEED_B5 = F.SEED_B4                                             # B4.3 bootstrap seed (draws h, x, segment)
RUNGS_E = ("v2e", "v4ae")
REF = "b4"
DEC_LIVE = 365.0

DECISIONS = [
    "B5-1 everything R7.3 does not change is B4 (b4_depositor.py at the shipped freeze, sha256 cc8680c4...) and its "
    "parents, imported unchanged: rows (daily 00:00Z origins with bal >= $1M), intraday paths, folds 2023Q4..2026Q3 "
    "with the t0 + h purge, the v2 (13 features) and v4a (11 + 3 history features) specifications and fits "
    "(logistic + unit EB m = 3), segments, G.7 statistics and thresholds, the B4.3 comparison / bootstrap "
    "(default_rng(20261100), block 30 d, 2,000 replicates) and shipping rule.",
    "B5-2 y_econ is defined for the 25 size cells x in {10..90}% x h in {1 h..7 d}; there is no y_econ form of y_all "
    "(R7.3 names y_econ(x, h) only). USDC rows only (R7.3: Aave V3 Core USDC only).",
    "B5-3 y_econ path: per unit the merged event times of its aUSDC path (G.2) and its debt events; at each time t, "
    "Q(t) = bal(t0) - bal(t) + N(t) - N(t0), N = cumulative net debt flow in micro-USD (Borrow + , Repay -). "
    "y_econ = 1 iff max over event times t in (t0, t0 + h] of Q(t) >= x * bal(t0) (the 'reaches' reading; events in "
    "one block summed, block order irrelevant). bal(t) at a debt-only time = the last path value of that day at or "
    "before t, else the day's anchor. Net debt can be negative inside a window (repaying old debt offsets a fall): "
    "the literal 'minus its repayments'. Rows where y = 1 and y_econ = 0 are counted and reported.",
    "B5-4 debt events: Borrow with onBehalfOf = the unit, interestRateMode = 2 (variable; every Borrow of a USDC "
    "universe address is mode 2), any Core reserve; Repay with user = the unit (whoever repays, either repay path, "
    "incl. repayWithATokens, whose aToken burn then cancels in Q). LiquidationCall is not a repayment (it emits no "
    "Repay): a liquidated unit's debt is not reduced in Q (limitation, reported).",
    "B5-5 USD value of a debt event = amount_raw * oracle price(asset) / (10^decimals * 10^8), price = Aave oracle "
    "getAssetPrice at the last daily 00:00Z snapshot block at or before the event (the oracle address is constant "
    "over the span, checked at the first, a middle and the asof block). A missing price (asset not configured that "
    "day) takes the nearest earlier priced day, else the nearest later one; counted.",
    "B5-6 debt data range: the published Borrow logs (aave-pool-borrows 67e78b4, blocks 18,251,965..26,186,746) plus "
    "Borrow logs over the first snapshot block + 1 .. 18,251,964 and Repay logs over the first snapshot block + 1 .. "
    "26,186,746, acquired here (same free endpoint, G.1 range / retry policy), so every training and test window "
    "is covered. Resolved for y_econ = resolved for y (G.3, no invalid path point) and t0 + h <= the asof block "
    "time.",
    "B5-7 cash_blocked (R7.3 queue reading) = the G.3 cap at t0: x * bal(t0) > cash(t0). Such cells are kept in "
    "training and test of the econ rungs and of the scoring of the B4 reference. Reported: all rows, and rows not "
    "cash_blocked.",
    "B5-8 rungs (v2e) and (v4ae): the v2 and v4a specifications refit on y_econ, USDC rows only, B3 folds, one fit "
    "per fold x cell; training rows t0 + h <= Q_start, resolved, features defined, cash_blocked included. v4ae's "
    "threshold-matched history counts prior origins t' with y_econ(x, 24 h; t') = 1 (t' + 24 h <= t0), i.e. the "
    "target the rung forecasts; maxdd90 unchanged. own and pop = the y_econ training rates (v2e fit).",
    "B5-9 B4 reference ('B4 shipped rung on y_econ'): v2, v4a and v4b refit exactly as B4 (USDC + USDT rows, old "
    "target, cash-blocked cells excluded from training) per fold x cell; their v2 Brier pooled over USDC + USDT "
    "uncapped test rows must equal B4 results-dev.json exactly (reproduction check), and their USDC predictions on "
    "uncapped rows after B4's masked fix must equal the published predictions-dev-*-USDC files (to their 6 "
    "significant digits). For scoring on y_econ every rung (B4 and e-rungs) gets the 2-D monotone fix over all 25 "
    "size cells with no mask (no cell is dropped any more). The B4 shipped rung per (cell, segment) is taken from "
    "shipped-b4.json; where B4 ships none, the displayed population-rate history = the fold's v2 segment training "
    "rate (seg_pop, old target).",
    "B5-10 comparisons (B4.3 form) per (cell, segment) on USDC test rows: BSS of v2e and v4ae vs pop and own (y_econ "
    "training rates), v4ae vs v2e, and v2e, v4ae vs the B4 shipped rung. One default_rng(20261100) stream; set order "
    "= x cells h, x, segment, then pooled x cells h, x; < 30 test days -> no CI. Eligible / ship as B4.3: v2e if it "
    "beats pop and own with CIs above 0; v4ae if it beats v2e with a CI above 0; a tie keeps v2e; ship by labels then "
    "BSS vs pop; no rung beating pop and own -> population-rate history, LOW. Labels G.7 per (cell, segment). No pass "
    "line (R7.3: none before 90 resolved live issue days per horizon); every result is a development reading.",
    "B5-11 stress window: a row is a stress row when (t0, t0 + h] overlaps [2026-04-18T00:00Z, 2026-04-25T00:00Z) "
    "with positive length (B4-2). R and BSS are reported with and without stress rows (the set's draw restricted).",
    "B5-12 freeze: frozen-b5.json holds per fold x cell the v2e and v4ae params, the asof fits (all resolved USDC "
    "rows) with per-unit theta and the v4ae history inputs needed for a live switch, the shipped rung and labels per "
    "(cell, segment); its sha256 in freeze-record.json.",
]


def sha256_file(p):
    return B.sha256_file(p)


def code_meta():
    here = os.path.dirname(os.path.abspath(__file__))

    def git(*a):
        try:
            return subprocess.run(["git", "-C", here, *a], capture_output=True, text=True,
                                  timeout=30).stdout.strip() or None
        except Exception:
            return None
    me = os.path.basename(__file__)
    return {"git_head": git("rev-parse", "HEAD"), "last_commit_b5_econ": git("log", "-1", "--format=%H", "--", me),
            "b5_econ_sha256": sha256_file(os.path.abspath(__file__)),
            "b5_econ_dirty": bool(git("status", "--porcelain", "--", me)),
            "b4_depositor_sha256": sha256_file(os.path.join(here, "b4_depositor.py")),
            "b3_segments_sha256": sha256_file(os.path.join(here, "b3_segments.py")),
            "bg_gradient_sha256": sha256_file(os.path.join(here, "bg_gradient.py")),
            "python": sys.version.split()[0], "numpy": np.__version__,
            "sklearn": __import__("sklearn").__version__, "scipy": __import__("scipy").__version__}


# ---------------------------------------------------------------------------------------------
# Debt events: acquisition (B5-6)
# ---------------------------------------------------------------------------------------------
REPAY_COLS = ["block", "ts", "tx_hash", "log_index", "reserve", "user", "repayer", "amount_raw", "useATokens"]


def decode_repay(topics, data):
    import g_acquire_events as GA
    if len(topics) != 4 or topics[0].lower() != GA.topic0(REPAY_SIG):
        raise ValueError("not a Repay log")
    d = data[2:]
    if len(d) != 64 * 2:
        raise ValueError(f"Repay data length {len(d)}")
    w = [int(d[64 * i:64 * i + 64], 16) for i in range(2)]
    if w[1] not in (0, 1):
        raise ValueError("bad bool")
    return {"reserve": GA.topic_address(topics[1]), "user": GA.topic_address(topics[2]),
            "repayer": GA.topic_address(topics[3]), "amount_raw": w[0], "useATokens": w[1]}


def snapshot_blocks(datasets_dir):
    with open(os.path.join(datasets_dir, G.DB, "blocks.csv")) as f:
        return {r["snapshot"]: int(r["block"]) for r in csv.DictReader(f) if r["kind"] == "daily"}


def _fetch(GA, work, name, sig, start, end, decode, cols, rowf, log):
    from pathlib import Path
    t0 = GA.topic0(sig)

    def post(payload):
        obj = json.loads(payload)
        obj["params"][0]["topics"] = [t0]
        return GA.http_post(GA.LOGS_RPC_URL, json.dumps(obj).encode())
    events = Path(work) / f"events-{name}.jsonl"

    def log_event(ev):
        with open(events, "a") as f:
            f.write(json.dumps(dict(ev, utc=GA.utcnow()), default=str) + "\n")
    client = GA.LogsClient(post=post, log_event=log_event)
    store = GA.LogStore(Path(work) / "logs")
    last = [0.0]
    t_start = GA.utcnow()

    def prog(_r, hi):
        if time.time() - last[0] > 30:
            last[0] = time.time()
            log(f"  {name} at block {hi} ({(hi - start) / max(end - start, 1):.1%}) req {client.counts['requests']} "
                f"logs {client.counts['logs']} splits {client.counts['splits']}")
    GA.fetch_logs(store, client, name, CORE_POOL, start, end, on_progress=prog)
    rows, bad = [], 0
    for lg in store.iter_reserve(name):
        try:
            d = decode(lg["topics"], lg["data"])
        except ValueError:
            bad += 1
            continue
        if lg["ts"] is None:
            raise SystemExit(f"STOP: a {name} log without blockTimestamp")
        rows.append(rowf(lg, d))
    rows.sort(key=lambda r: (r[0], r[3]))
    return rows, bad, {"topic0": t0, "from_block": start, "to_block": end, "counts": client.counts,
                       "fetch_window_utc": [t_start, GA.utcnow()]}


def phase_debt_events(datasets_dir, debt_dir, log=print):
    import g_acquire_events as GA
    from pathlib import Path
    os.makedirs(debt_dir, exist_ok=True)
    work = os.path.join(debt_dir, "work")
    os.makedirs(work, exist_ok=True)
    blocks = snapshot_blocks(datasets_dir)
    start = blocks[FIRST_SNAPSHOT] + 1
    out = Path(debt_dir)
    man = {"pool": CORE_POOL, "rpc": GA.LOGS_RPC_URL, "decision": DECISIONS[5], "files": {}, "code": code_meta()}
    rep, bad_r, info_r = _fetch(GA, work, "Repay", REPAY_SIG, start, TO_BLOCK, decode_repay, REPAY_COLS,
                                lambda lg, d: [lg["block"], lg["ts"], lg["tx"], lg["log_index"], d["reserve"],
                                               d["user"], d["repayer"], d["amount_raw"], d["useATokens"]], log)
    names = GA.write_partitioned(out, "repay-events-core", REPAY_COLS, lambda: iter(rep), lambda r: r[1])
    man["repay"] = dict(info_r, signature=REPAY_SIG, n_events=len(rep), n_undecodable=bad_r, files=names)
    bor, bad_b, info_b = _fetch(GA, work, "Borrow", BORROW_SIG, start, BORROW_PUBLISHED_FROM - 1, F.decode_borrow,
                                F.BORROW_COLS,
                                lambda lg, d: [lg["block"], lg["ts"], lg["tx"], lg["log_index"], d["reserve"],
                                               d["user"], d["onBehalfOf"], d["amount_raw"], d["interestRateMode"],
                                               d["referralCode"]], log)
    bnames = GA.write_partitioned(out, "borrow-events-core-pre", F.BORROW_COLS, lambda: iter(bor), lambda r: r[1])
    man["borrow_pre"] = dict(info_b, signature=BORROW_SIG, n_events=len(bor), n_undecodable=bad_b, files=bnames)
    for n in names + bnames:
        man["files"][n] = {"bytes": (out / n).stat().st_size, "sha256": sha256_file(out / n)}
    B.write_json(os.path.join(debt_dir, "debt-manifest.json"), man)
    log(f"debt-events: {len(rep)} Repay, {len(bor)} early Borrow -> {names + bnames}")
    return man


# ---------------------------------------------------------------------------------------------
# Loading debt events
# ---------------------------------------------------------------------------------------------
def _read_manifest_files(d, man_name, files):
    import pandas as pd
    man = json.load(open(os.path.join(d, man_name)))
    shas = {man_name: sha256_file(os.path.join(d, man_name))}
    parts = []
    for n in files:
        p = os.path.join(d, n)
        got = sha256_file(p)
        if got != man["files"][n]["sha256"]:
            raise SystemExit(f"STOP: {n} sha256 {got} != {man_name}")
        shas[n] = got
        parts.append(pd.read_csv(p, dtype=str))
    return man, shas, parts


def load_debt_frames(datasets_dir, debt_dir):
    """-> (borrows DataFrame [block, ts, reserve, who, amount_raw, mode, sign=+1], repays [.., sign=-1], shas)."""
    import pandas as pd
    bd = os.path.join(datasets_dir, BORROWS_DIR)
    bman = json.load(open(os.path.join(bd, "borrow-manifest.json")))
    _, sh1, p1 = _read_manifest_files(bd, "borrow-manifest.json", sorted(bman["files"]))
    dman = json.load(open(os.path.join(debt_dir, "debt-manifest.json")))
    _, sh2, p2 = _read_manifest_files(debt_dir, "debt-manifest.json", dman["borrow_pre"]["files"])
    _, sh3, p3 = _read_manifest_files(debt_dir, "debt-manifest.json", dman["repay"]["files"])
    if bman["from_block"] != BORROW_PUBLISHED_FROM or dman["borrow_pre"]["to_block"] != BORROW_PUBLISHED_FROM - 1:
        raise SystemExit("STOP: Borrow ranges do not join")
    bor = pd.concat(p2 + p1, ignore_index=True)
    rep = pd.concat(p3, ignore_index=True)
    b = pd.DataFrame({"block": bor["block"].astype(np.int64), "ts": bor["ts"].astype(np.int64),
                      "log_index": bor["log_index"].astype(np.int64), "reserve": bor["reserve"].str.lower(),
                      "who": bor["onBehalfOf"].str.lower(), "amount_raw": bor["amount_raw"],
                      "mode": bor["interestRateMode"].astype(int)})
    r = pd.DataFrame({"block": rep["block"].astype(np.int64), "ts": rep["ts"].astype(np.int64),
                      "log_index": rep["log_index"].astype(np.int64), "reserve": rep["reserve"].str.lower(),
                      "who": rep["user"].str.lower(), "amount_raw": rep["amount_raw"],
                      "mode": np.full(len(rep), -1)})
    shas = {BORROWS_DIR + k: v for k, v in sh1.items()}
    shas.update({"debt/" + k: v for k, v in {**sh2, **sh3}.items()})
    return b, r, shas


# ---------------------------------------------------------------------------------------------
# Oracle prices (B5-5)
# ---------------------------------------------------------------------------------------------
def phase_prices(datasets_dir, debt_dir, log=print):
    import b_acquire as A
    import pandas as pd
    b, r, shas = load_debt_frames(datasets_dir, debt_dir)
    uni = pd.read_csv(os.path.join(datasets_dir, G.DE, "extended-universe.csv"), dtype=str)
    us = set(uni.loc[uni["reserve"] == "USDC", "address"].str.lower())
    assets = sorted(set(b.loc[b["who"].isin(us), "reserve"]) | set(r.loc[r["who"].isin(us), "reserve"]))
    blocks = snapshot_blocks(datasets_dir)
    days = sorted(blocks)
    rpc = A.Rpc(A.RPC_URL, os.path.join(debt_dir, "prices-events.jsonl"))
    sel_p = A.selector("getAssetPrice(address)")
    sel_o = A.selector("getPriceOracle()")
    checks = {}
    for blk in (blocks[days[0]], blocks[days[len(days) // 2]], TO_BLOCK):
        o = "0x" + rpc.eth_call(ADDRESSES_PROVIDER, sel_o, blk, "prices")[-20:].hex()
        checks[str(blk)] = o
        if o != ORACLE.lower():
            raise SystemExit(f"STOP: oracle at block {blk} is {o}, not {ORACLE}")
    dec = {}
    res = rpc.multicall([(a, A.call_data("decimals")) for a in assets], TO_BLOCK, "prices")
    for a, (ok, ret) in zip(assets, res):
        if not ok:
            raise SystemExit(f"STOP: decimals() failed for {a}")
        dec[a] = A.decode_uint(ret)
    rows = []
    t0 = time.time()
    for k, d in enumerate(days):
        res = rpc.multicall([(ORACLE, sel_p + A.enc_address(a)) for a in assets], blocks[d], "prices")
        for a, (ok, ret) in zip(assets, res):
            v = A.decode_uint(ret) if ok and len(ret) == 32 else None
            rows.append([d, blocks[d], a, "" if not v else v])
        if (k + 1) % 100 == 0:
            log(f"  prices {k + 1}/{len(days)} ({time.time() - t0:.0f} s)")
    p = os.path.join(debt_dir, "prices-daily.csv.gz")
    with gzip.GzipFile(p, "wb", compresslevel=9, mtime=0) as gz:
        import io
        tw = io.TextIOWrapper(gz, encoding="utf-8", newline="")
        w = csv.writer(tw, lineterminator="\n")
        w.writerow(["snapshot", "block", "asset", "price_usd_1e8"])
        w.writerows(rows)
        tw.flush()
        tw.detach()
    with open(os.path.join(debt_dir, "asset-decimals.csv"), "w", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["asset", "decimals"])
        for a in assets:
            w.writerow([a, dec[a]])
    man = {"oracle": ORACLE, "addresses_provider": ADDRESSES_PROVIDER, "oracle_checks": checks, "rpc": A.RPC_URL,
           "n_assets": len(assets), "n_days": len(days), "decimals_block": TO_BLOCK,
           "missing_prices": int(sum(1 for x in rows if x[3] == "")), "counts": rpc.counts,
           "files": {n: {"bytes": os.path.getsize(os.path.join(debt_dir, n)),
                         "sha256": sha256_file(os.path.join(debt_dir, n))}
                     for n in ("prices-daily.csv.gz", "asset-decimals.csv")},
           "debt_inputs_sha256": shas, "decision": DECISIONS[4], "code": code_meta()}
    B.write_json(os.path.join(debt_dir, "prices-manifest.json"), man)
    log(f"prices: {len(assets)} assets x {len(days)} days, {man['missing_prices']} missing")
    return man


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--phase", required=True,
                    choices=["debt-events", "prices", "run", "freeze", "manifest"])
    ap.add_argument("--datasets", default=os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                       "..", "..", "..", "..", "membrane-datasets"))
    ap.add_argument("--debt-dir", required=False)
    ap.add_argument("--out", required=False)
    ap.add_argument("--workers", type=int, default=3)
    a = ap.parse_args(argv)
    ds = os.path.abspath(a.datasets)
    if a.phase == "debt-events":
        return phase_debt_events(ds, a.debt_dir)
    if a.phase == "prices":
        return phase_prices(ds, a.debt_dir)
    raise SystemExit(f"phase {a.phase} not available yet")


if __name__ == "__main__":
    main()
