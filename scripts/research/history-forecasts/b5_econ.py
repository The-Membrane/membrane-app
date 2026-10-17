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


# ---------------------------------------------------------------------------------------------
# Debt flows per unit in micro-USD (B5-4, B5-5)
# ---------------------------------------------------------------------------------------------
def load_prices(debt_dir, T, snapshot_of_day):
    """-> ({asset: int array (D,) price 1e8 (filled)}, {asset: decimals}, fill counts, shas)."""
    import pandas as pd
    man = json.load(open(os.path.join(debt_dir, "prices-manifest.json")))
    shas = {"debt/prices-manifest.json": sha256_file(os.path.join(debt_dir, "prices-manifest.json"))}
    for n, v in man["files"].items():
        got = sha256_file(os.path.join(debt_dir, n))
        if got != v["sha256"]:
            raise SystemExit(f"STOP: {n} sha256 {got} != prices-manifest")
        shas["debt/" + n] = got
    df = pd.read_csv(os.path.join(debt_dir, "prices-daily.csv.gz"), dtype=str, keep_default_na=False)
    dec = {r["asset"]: int(r["decimals"]) for r in csv.DictReader(open(os.path.join(debt_dir, "asset-decimals.csv")))}
    D = len(T)
    dpos = {s: i for i, s in enumerate(snapshot_of_day)}
    prices, fills = {}, {}
    for a, g in df.groupby("asset"):
        arr = np.full(D, -1, dtype=object)
        for s, v in zip(g["snapshot"], g["price_usd_1e8"]):
            if s in dpos and v != "":
                arr[dpos[s]] = int(v)
        prices[a], fills[a] = fill_prices(arr)
    return prices, dec, fills, shas


def fill_prices(arr):
    """B5-5: a missing day (-1) takes the nearest earlier priced day, else the nearest later one."""
    out = np.array(arr, dtype=object)
    n_fill = 0
    last = None
    for i in range(len(out)):
        if out[i] is not None and out[i] > 0:
            last = out[i]
        elif last is not None:
            out[i] = last
            n_fill += 1
    nxt = None
    for i in range(len(out) - 1, -1, -1):
        if out[i] is not None and out[i] > 0:
            nxt = out[i]
        elif nxt is not None:
            out[i] = nxt
            n_fill += 1
    return out, n_fill


def usd_micro(amount_raw, price_1e8, decimals):
    """B5-5 exact: amount * price / (10^dec * 1e8) USD in micro-USD, floored toward zero."""
    return int(amount_raw) * int(price_1e8) * 10 ** 6 // (10 ** int(decimals) * 10 ** PRICE_DEC)


def debt_flows(bor, rep, addrs, T, prices, dec, log=print):
    """Signed per-(unit, ts) debt flow in micro-USD for the units (addrs sorted). Events with ts <= T[0] are
    dropped (only differences after the first origin enter Q). -> dict(unit, ts, usd) sorted by key, and info."""
    import pandas as pd
    aarr = np.array(addrs)
    info = {"borrow_rows_units": 0, "repay_rows_units": 0, "borrow_non_variable_units": 0, "no_price": 0}
    parts = []
    for df, sign, name in ((bor, 1, "borrow"), (rep, -1, "repay")):
        ui = np.minimum(np.searchsorted(aarr, df["who"].to_numpy()), len(aarr) - 1)
        m = aarr[ui] == df["who"].to_numpy()
        if name == "borrow":
            info["borrow_non_variable_units"] = int((m & (df["mode"].to_numpy() != VARIABLE_MODE)).sum())
            m &= df["mode"].to_numpy() == VARIABLE_MODE
        m &= df["ts"].to_numpy() > int(T[0])
        sub = df[m]
        info[f"{name}_rows_units"] = int(m.sum())
        pday = np.minimum(np.searchsorted(T, sub["ts"].to_numpy(), side="right") - 1, len(T) - 1)
        usd = np.zeros(len(sub), dtype=np.int64)
        for k, (a, amt, d) in enumerate(zip(sub["reserve"].to_numpy(), sub["amount_raw"].to_numpy(), pday)):
            pa = prices.get(a)
            if pa is None or pa[d] is None or pa[d] <= 0:
                info["no_price"] += 1
                raise SystemExit(f"STOP: no oracle price for {a} on day {d}")
            usd[k] = sign * usd_micro(amt, pa[d], dec[a])
        parts.append(pd.DataFrame({"unit": ui[m], "ts": sub["ts"].to_numpy(np.int64), "usd": usd}))
    ev = pd.concat(parts, ignore_index=True)
    g = ev.groupby(["unit", "ts"], sort=True)["usd"].sum().reset_index()
    out = {"unit": g["unit"].to_numpy(np.int64), "ts": g["ts"].to_numpy(np.int64), "usd": g["usd"].to_numpy(np.int64)}
    info["unit_ts_points"] = int(len(g))
    info["units_with_debt_events"] = int(len(np.unique(out["unit"])))
    return out, info


# ---------------------------------------------------------------------------------------------
# y_econ (B5-3), unit-tested on synthetic paths
# ---------------------------------------------------------------------------------------------
class EconIndex:
    """Merged per-unit series of -V(t) = bal(t) - N(t) at aToken path times and debt times (key unit << 32 | ts),
    range-minimum via bg_gradient.WindowIndex, and cumulative N for t0."""

    def __init__(self, paths, debt, A, Av, T):
        T = np.asarray(T, dtype=np.int64)
        D = len(T)
        pk = (paths["unit"].astype(np.int64) << 32) | paths["ts"].astype(np.int64)
        dk = (debt["unit"].astype(np.int64) << 32) | debt["ts"].astype(np.int64)
        if len(dk) > 1 and np.any(np.diff(dk) <= 0):
            raise ValueError("debt keys must be strictly increasing")
        self.dk = dk
        self.dcum = np.r_[0, np.cumsum(debt["usd"].astype(np.int64))]
        mk = np.union1d(pk, dk)
        mu = mk >> 32
        mts = mk & ((1 << 32) - 1)
        mday = np.minimum(np.searchsorted(T, mts, side="right") - 1, D - 1)
        if (mday < 0).any():
            raise ValueError("an event before the first snapshot")
        j = np.searchsorted(pk, mk, side="right") - 1
        jj = np.maximum(j, 0)
        same = (j >= 0) & (paths["unit"][jj] == mu) & (paths["pday"][jj] == mday) if len(pk) else np.zeros(len(mk), bool)
        bal = np.where(same, paths["v"][jj] if len(pk) else 0, A[mu, mday]).astype(np.int64)
        valid = np.where(same, paths["valid"][jj] if len(pk) else False, Av[mu, mday]).astype(bool)
        N = self.cum_at(mu, mts)
        self.series = {"unit": mu, "ts": mts, "v": bal - N, "valid": valid}
        self.widx = G.WindowIndex(self.series)

    def cum_at(self, u, t):
        """N(u, t) = sum of the unit's debt flows with ts <= t."""
        u = np.asarray(u, dtype=np.int64)
        t = np.asarray(t, dtype=np.int64)
        hi = np.searchsorted(self.dk, (u << 32) | t, side="right")
        lo = np.searchsorted(self.dk, u << 32, side="left")
        return self.dcum[hi] - self.dcum[lo]

    def label(self, u, T0, hsec, bal0, x):
        """-> (y_econ, ninv). y = an event in (t0, t0 + h] with 100 * (bal0 - N(t0) - min(bal - N)) >= x * bal0."""
        u = np.asarray(u, dtype=np.int64)
        T0 = np.asarray(T0, dtype=np.int64)
        bal0 = np.asarray(bal0, dtype=np.int64)
        mn, has, ninv = self.widx.query(u, T0, T0 + hsec)
        N0 = self.cum_at(u, T0)
        mn = np.where(has, mn, bal0 - N0)
        out = {}
        for xx in np.atleast_1d(x):
            out[int(xx)] = has & (ninv == 0) & (100 * (bal0 - N0 - mn) >= int(xx) * bal0)
        return out, has, ninv


def econ_labels(R, debt, T, rows_u, rows_d, rows_bal, res_old):
    """Y_econ (n, 25) int8 and RES_e (n, NH) for one reserve's rows (local unit ids)."""
    T = np.asarray(T, dtype=np.int64)
    D = len(T)
    ei = EconIndex(R.paths, debt, R.A[:, :D], R.Av[:, :D], T)
    n = len(rows_u)
    T0 = T[rows_d]
    Y = np.zeros((n, G.NC), dtype=np.int8)
    RESe = np.zeros((n, G.NH), dtype=bool)
    for hi, hs in enumerate(G.HSEC):
        ys, has, ninv = ei.label(rows_u, T0, hs, rows_bal, G.SIZES)
        RESe[:, hi] = res_old[:, hi] & (ninv == 0) & (T0 + hs <= S.LIVE_ASOF_TS)
        for xi, x in enumerate(G.SIZES):
            Y[:, G.XCELL[hi, xi]] = ys[x]
    return Y, RESe, ei


def econ_hist_features(unit, t, Ye, RESe, mdd, n_units, D):
    """v4ae history features per size key (B5-8): prior y_econ(x, 24 h) origins; maxdd90 unchanged."""
    F4 = {}
    for xi, x in enumerate(G.SIZES):
        flag = RESe[:, 2] & (Ye[:, G.XCELL[2, xi]] == 1)
        n, days = F.hist_counts(unit, t, flag, n_units, D)
        F4[f"x{x}"] = np.column_stack([np.log1p(n.astype(float)), mdd, np.log1p(days)])
    F4["all"] = np.zeros((len(unit), 3))
    return F4


# ---------------------------------------------------------------------------------------------
# Fix, shipping, scoring
# ---------------------------------------------------------------------------------------------
def fix_nomask(P):
    """B5-9: 2-D monotone fix over all 25 size cells, nothing masked."""
    out = P.copy()
    Gx = P[:, G.XCELL]
    out[:, G.XCELL] = G.monotone_fix_masked(Gx, np.zeros((len(P), G.NX), bool))
    return out


def ship_rung_b5(flags, labels, bss_pop):
    """B5-10 = B4.3 with rungs v2e, v4ae."""
    elig = []
    if flags["v2e"]["pop"] and flags["v2e"]["own"]:
        elig.append("v2e")
    if flags["v4ae"]["v2e"]:
        elig.append("v4ae")
    any_beats = any(flags[r]["pop"] and flags[r]["own"] for r in RUNGS_E)
    if not any_beats or not elig:
        return None, elig
    best = None
    for r in RUNGS_E:
        if r not in elig:
            continue
        key = (S.LABEL_RANK[labels[r]], -np.inf if bss_pop[r] is None else bss_pop[r])
        if best is None or key > best[0]:
            best = (key, r)
    return best[1], elig


COMP_E = (("v2e_vs_pop", "v2e", "pop"), ("v2e_vs_own", "v2e", "own"), ("v4ae_vs_pop", "v4ae", "pop"),
          ("v4ae_vs_own", "v4ae", "own"), ("v4ae_vs_v2e", "v4ae", "v2e"), ("v2e_vs_b4", "v2e", "b4"),
          ("v4ae_vs_b4", "v4ae", "b4"), ("b4_vs_pop", "b4", "pop"), ("b4_vs_own", "b4", "own"))
SCORE_RUNGS = ("v2e", "v4ae", "b4")


def set_order_x():
    """B5-10: x cells (h, x, segment), then pooled x cells (h, x)."""
    out = [(int(G.XCELL[hi, xi]), s) for hi in range(G.NH) for xi in range(G.NX) for s in range(S.NSEG)]
    out += [(int(G.XCELL[hi, xi]), None) for hi in range(G.NH) for xi in range(G.NX)]
    return out


def score_b5(ctx, E, PR, log=print):
    fold_names = [f[0] for f in ctx.folds]
    test = (E["fold"] >= 0) & E["feat_ok"]
    rng = np.random.default_rng(SEED_B5)
    cells, pooled = {}, {}
    for ci, s in set_order_x():
        c = G.CELLS[ci]
        hi = c["hi"]
        m = test & E["RES"][:, hi]
        if s is not None:
            m &= E["seg"] == s
        idx = np.nonzero(m)[0]
        dd = np.unique(E["t"][idx])
        nd = len(dd)
        cb = B.replicate_counts(B.block_bootstrap_indices(rng, nd, G.BLOCK_DAYS, G.N_BOOT), nd) \
            if nd >= G.BLOCK_DAYS else None
        Q = {"y": E["Y"][idx, ci].astype(float), "t": E["t"][idx], "unit": E["unit"][idx],
             "reserve": np.zeros(len(idx), np.int8), "fold": E["fold"][idx]}
        pr = {k: PR[k][idx, ci] for k in ("v2e", "v4ae", "b4", "own", "pop")}
        if any(np.isnan(v).any() for v in pr.values()):
            raise SystemExit(f"STOP: missing prediction in {c['id']} segment {s}")
        Sx, pos = F.score_set(Q, pr, dd, cb, fold_names, ["USDC"], rungs=SCORE_RUNGS, comps=COMP_E)
        stress = F.stress_overlap(E["T0"][idx], G.HSEC[hi])
        cbk = E["CAPOLD"][idx, ci]
        yold = E["YOLD"][idx, ci].astype(float)
        Sx["no_stress"] = F.restricted(pos, nd, pr, Q["y"], ~stress, cb, comps=COMP_E, rungs=SCORE_RUNGS)
        Sx["stress_only"] = {"rows": int(stress.sum()), "exits": int(Q["y"][stress].sum()),
                             "exits_old": int(yold[stress].sum()),
                             "R": {r: G.ratio_R(pr[r][stress].sum(), Q["y"][stress].sum()) for r in SCORE_RUNGS}}
        Sx["not_cash_blocked"] = F.restricted(pos, nd, pr, Q["y"], ~cbk, cb, comps=COMP_E, rungs=SCORE_RUNGS)
        Sx["cash_blocked"] = {"rows": int(cbk.sum()), "exits": int(Q["y"][cbk].sum()),
                              "exits_old": int(yold[cbk].sum()),
                              "R": {r: G.ratio_R(pr[r][cbk].sum(), Q["y"][cbk].sum()) for r in SCORE_RUNGS}}
        Sx["exits_old_target"] = int(yold.sum())
        Sx["added_exits"] = int(((Q["y"] == 1) & (yold == 0)).sum())
        Sx["lost_exits"] = int(((Q["y"] == 0) & (yold == 1)).sum())
        if s is None:
            pooled[c["id"]] = Sx
            continue
        b = Sx["bss"]
        fl = {"v2e": {"pop": bool(b["v2e_vs_pop"]["ci_above_0"]), "own": bool(b["v2e_vs_own"]["ci_above_0"])},
              "v4ae": {"pop": bool(b["v4ae_vs_pop"]["ci_above_0"]), "own": bool(b["v4ae_vs_own"]["ci_above_0"]),
                       "v2e": bool(b["v4ae_vs_v2e"]["ci_above_0"])}}
        labels = {r: Sx["g7"][r]["label"] for r in SCORE_RUNGS}
        rung, elig = ship_rung_b5(fl, {r: labels[r] for r in RUNGS_E}, {r: b[f"{r}_vs_pop"]["bss"] for r in RUNGS_E})
        Sx.update(flags=fl, eligible=elig, shipped=rung, label=labels[rung] if rung else "LOW",
                  display="model" if rung else "population-rate history",
                  shipped_vs_b4=b[f"{rung}_vs_b4"] if rung else None)
        cells.setdefault(c["id"], {})[S.SEG_IDS[s]] = Sx
        log(f"  {c['id']} {S.SEG_IDS[s]}: rows {Sx['n']['rows']} n_ep {Sx['n']['n_ep']} added {Sx['added_exits']} "
            f"-> {rung} {Sx['label']}")
    return cells, pooled


# ---------------------------------------------------------------------------------------------
# Inputs and checks
# ---------------------------------------------------------------------------------------------
B4_FILES = ("results-dev.json", "shipped-b4.json", "freeze-record.json") + tuple(
    f"predictions-dev-{h}-USDC.csv.gz" for h in G.HNAMES)
B4_SHIPPED_SHA = "cc8680c42d3f00ef7f08d84850406153fa082772daf22a3b1d90113aae1bbadf"


def verify_b4_run(datasets_dir):
    run = os.path.join(datasets_dir, B4_RUN)
    man = json.load(open(os.path.join(run, "manifest.json")))
    out = {B4_RUN + "manifest.json": sha256_file(os.path.join(run, "manifest.json"))}
    for fn in B4_FILES:
        got = sha256_file(os.path.join(run, fn))
        if man["files"][fn]["sha256"] != got:
            raise SystemExit(f"STOP: {B4_RUN}{fn} sha256 {got} != its manifest")
        out[B4_RUN + fn] = got
    if out[B4_RUN + "shipped-b4.json"] != B4_SHIPPED_SHA:
        raise SystemExit("STOP: shipped-b4.json is not the B4 freeze")
    return out


def same_6g(mine, written):
    """True where `written` is `mine` printed with %.6g (|diff| <= half a unit in the 6th significant digit)."""
    mine = np.asarray(mine, float)
    w = np.asarray(written, float)
    with np.errstate(divide="ignore"):
        e = np.floor(np.log10(np.abs(np.where(w == 0, 1.0, w))))
    tol = 0.5000001 * 10.0 ** (e - 5)
    return np.where(w == 0, mine == 0, np.abs(mine - w) <= tol * (1 + 1e-9))


def b4_reproduction(datasets_dir, rows, PRm, log=print):
    """B5-9: pooled (USDC + USDT) Brier of v2, v4a, v4b per x cell equals B4 results-dev.json exactly; USDC
    predictions equal the published files to 6 significant digits."""
    import pandas as pd
    run = os.path.join(datasets_dir, B4_RUN)
    r4 = json.load(open(os.path.join(run, "results-dev.json")))["pooled"]
    test = (rows["fold"] >= 0) & rows["feat_ok"]
    out = {"brier": {}, "files": {}}
    for ci in range(G.NX * G.NH):
        c = G.CELLS[ci]
        m = test & rows["RES"][:, c["hi"]] & ~rows["CAP"][:, ci]
        y = rows["Y"][m, ci].astype(float)
        rec = {"rows": int(m.sum()), "rows_b4": r4[c["id"]]["n"]["rows"]}
        for r in F.RUNGS:
            rec[r] = float(np.mean((PRm[r][m, ci] - y) ** 2))
            rec[r + "_b4"] = r4[c["id"]]["brier"][r]
        rec["equal"] = rec["rows"] == rec["rows_b4"] and all(rec[r] == rec[r + "_b4"] for r in F.RUNGS)
        out["brier"][c["id"]] = rec
    for hi, h in enumerate(G.HNAMES):
        df = pd.read_csv(os.path.join(run, f"predictions-dev-{h}-USDC.csv.gz"))
        m = np.nonzero(test & rows["RES"][:, hi] & (rows["reserve"] == 0))[0]
        m = m[np.lexsort((rows["t"][m], rows["unit"][m]))]
        if len(m) != len(df) or not (rows["unit"][m] == df["unit"].to_numpy()).all():
            out["files"][h] = {"equal": False, "note": "row set differs"}
            continue
        neq, ncmp = 0, 0
        for ci in G.XCELL[hi]:
            cid = G.CELLS[ci]["id"]
            for r in F.RUNGS:
                mine = PRm[r][m, ci]
                fv = df[f"{r}_{cid}"].to_numpy(float)
                ok = np.isfinite(fv)
                if (np.isfinite(mine) != ok).any():
                    neq += int((np.isfinite(mine) != ok).sum())
                neq += int((~same_6g(mine[ok], fv[ok])).sum())
                ncmp += int(ok.sum())
        out["files"][h] = {"equal": neq == 0, "values_compared": ncmp, "mismatches": neq}
        log(f"  reproduction {h}: {out['files'][h]}")
    out["all_equal"] = all(v["equal"] for v in out["brier"].values()) and all(
        v["equal"] for v in out["files"].values())
    return out


def exit_counts(E, mask_base):
    """Rows, y, y_econ, added (y_econ & ~y), lost (y & ~y_econ) per x cell on mask_base & RES_e: all rows and
    stress rows, plus cash_blocked."""
    out = {}
    for ci in range(G.NX * G.NH):
        c = G.CELLS[ci]
        m = mask_base & E["RES"][:, c["hi"]]
        st = m & F.stress_overlap(E["T0"], G.HSEC[c["hi"]])
        rec = {}
        for name, mm in (("all", m), ("stress", st), ("cash_blocked", m & E["CAPOLD"][:, ci]),
                         ("not_cash_blocked", m & ~E["CAPOLD"][:, ci])):
            ye, yo = E["Y"][mm, ci] == 1, E["YOLD"][mm, ci] == 1
            rec[name] = {"rows": int(mm.sum()), "y_old": int(yo.sum()), "y_econ": int(ye.sum()),
                         "added": int((ye & ~yo).sum()), "lost": int((yo & ~ye).sum()),
                         "n_ep_old": G.n_episodes(E["unit"][mm], E["t"][mm], yo),
                         "n_ep_econ": G.n_episodes(E["unit"][mm], E["t"][mm], ye)}
        out[c["id"]] = rec
    return out


def sum_counts(ec, keys=("all", "stress", "cash_blocked", "not_cash_blocked")):
    tot = {}
    for k in keys:
        tot[k] = {f: int(sum(ec[c][k][f] for c in ec)) for f in ("rows", "y_old", "y_econ", "added", "lost")}
    return tot


# ---------------------------------------------------------------------------------------------
# Run (once)
# ---------------------------------------------------------------------------------------------
def build_econ(datasets_dir, debt_dir, ctx, res, rows, log=print):
    """USDC-only econ row dict E (local view of rows with Y = y_econ, CAP none, RES = RES_e, F4 = econ history)."""
    import pandas as pd  # noqa: F401
    R = res[rows["reserve_names"].index("USDC")]
    bor, rep, dshas = load_debt_frames(datasets_dir, debt_dir)
    prices, dec, fills, pshas = load_prices(debt_dir, ctx.T, ctx.days)
    debt, dinfo = debt_flows(bor, rep, R.addrs, np.asarray(ctx.T, dtype=np.int64), prices, dec, log)
    dinfo["price_fills"] = {a: int(v) for a, v in fills.items() if v}
    sel = np.nonzero(rows["reserve"] == 0)[0]
    if rows["reserve_names"][0] != "USDC" or rows["unit_base"]["USDC"] != 0:
        raise SystemExit("STOP: USDC must be reserve 0 with unit base 0")
    Ye, RESe, ei = econ_labels(R, debt, ctx.T, rows["unit"][sel], rows["t"][sel], rows["bal"][sel],
                               rows["RES"][sel])
    E = {k: rows[k][sel] for k in ("unit", "t", "T0", "bal", "cash", "reserve", "X", "feat_ok", "fold", "seg",
                                   "band", "constrained")}
    E["Y"] = Ye
    E["RES"] = RESe
    E["YOLD"] = rows["Y"][sel]
    E["CAPOLD"] = rows["CAP"][sel]
    E["RESOLD"] = rows["RES"][sel]
    E["CAP"] = np.zeros_like(rows["CAP"][sel])
    E["n_units"] = rows["n_units"]
    E["unit_addr"] = rows["unit_addr"]
    E["reserve_names"] = ["USDC"]
    mdd = rows["F4"]["x10"][sel, 1]
    E["F4"] = econ_hist_features(E["unit"], E["t"], Ye, RESe, mdd, rows["n_units"], ctx.D)
    E["F4_old"] = {k: v[sel] for k, v in rows["F4"].items()}
    E["sel"] = sel
    dinfo["res_econ_lost_rows"] = {h: int((E["RESOLD"][:, hi] & ~RESe[:, hi]).sum()) for hi, h in enumerate(G.HNAMES)}
    return E, debt, dinfo, {**dshas, **pshas}


def phase_run(datasets_dir, debt_dir, out_dir, workers=3, log=print):
    rp = os.path.join(out_dir, "results-b5.json")
    if os.path.exists(rp):
        raise SystemExit(f"STOP: {rp} exists; the B5 run happens once and never overwrites.")
    t_start = time.time()
    os.makedirs(out_dir, exist_ok=True)
    shas = F.verify_inputs(datasets_dir, holdouts=False)
    shas.update(verify_b4_run(datasets_dir))
    shipped4 = json.load(open(os.path.join(datasets_dir, B4_RUN, "shipped-b4.json")))["cells"]
    ctx, res, rows = F.build_main_b4(datasets_dir, labels=True, log=log)
    log("y_econ labels ...")
    E, debt, dinfo, dshas = build_econ(datasets_dir, debt_dir, ctx, res, rows, log)
    shas.update(dshas)
    xc = [int(c) for c in G.XCELL.ravel()]
    # --- B4 reference (USDC + USDT, old target, B4 exactly)
    tasks = [("fold", fi, ci) for fi in range(len(ctx.folds)) for ci in xc]
    log(f"B4 reference fits: {len(tasks)} tasks ...")
    fits4, test4 = F.run_fits(ctx, rows, tasks, np.zeros(0, np.int64), S.LIVE_ASOF_TS, workers=workers, log=log)
    PR4, fp4, _, _ = F.assemble(rows, fits4, test4)
    PR4m = G.apply_fix(PR4, rows, versions=F.RUNGS)                     # B4's masked fix (reproduction)
    log("B4 reproduction check ...")
    repro = b4_reproduction(datasets_dir, rows, PR4m, log)
    log(f"  all equal: {repro['all_equal']}")
    sel = E["sel"]
    n = len(sel)
    seg = E["seg"]
    PR = {k: np.full((n, G.NC), np.nan) for k in ("v2e", "v4ae", "b4", "own", "pop")}
    raw4 = {r: fix_nomask(PR4[r][sel]) for r in F.RUNGS}
    for ci in xc:
        cid = G.CELLS[ci]["id"]
        for s in range(S.NSEG):
            sh = shipped4[cid][S.SEG_IDS[s]]["shipped"]
            m = seg == s
            if sh:
                PR["b4"][m, ci] = raw4[sh][m, ci]
            else:
                for fi in range(len(ctx.folds)):
                    mm = m & (E["fold"] == fi)
                    v = fp4[fi][cid]["v2"]["seg_pop"][s]
                    PR["b4"][mm, ci] = v if np.isfinite(v) else fp4[fi][cid]["v2"]["pop"]
    del PR4, PR4m, raw4, fits4
    # --- econ rungs (USDC only, y_econ)
    tasks = [("fold", fi, ci) for fi in range(len(ctx.folds)) for ci in xc] + [("asof", -1, ci) for ci in xc]
    usdc_units = np.arange(len(res[0].addrs), dtype=np.int64)
    log(f"econ fits: {len(tasks)} tasks ...")
    fitsE, testE = F.run_fits(ctx, E, tasks, usdc_units, S.LIVE_ASOF_TS, workers=workers, log=log)
    ffE = [f for f in fitsE if f["kind"] == "fold"]
    afE = sorted([f for f in fitsE if f["kind"] == "asof"], key=lambda f: f["ci"])
    PRE, fpE, finfoE, _ = F.assemble(E, ffE, testE)
    PR["v2e"] = fix_nomask(PRE["v2"])
    PR["v4ae"] = fix_nomask(PRE["v4a"])
    PR["own"], PR["pop"] = PRE["own"], PRE["pop"]
    log("scoring ...")
    cells, pooled = score_b5(ctx, E, PR, log)
    test = (E["fold"] >= 0) & E["feat_ok"]
    counts_test = exit_counts(E, test)
    counts_all = exit_counts(E, E["feat_ok"])
    lab = []
    for ci in xc:
        cid = G.CELLS[ci]["id"]
        for s in S.SEG_IDS:
            Sx = cells[cid][s]
            sh = Sx["shipped"]
            lab.append([cid, s, sh or "", Sx["label"], Sx["n"]["rows"], Sx["n"]["n_ep"], Sx["added_exits"],
                        Sx["g7"]["v2e"]["R"], Sx["g7"]["v4ae"]["R"], Sx["g7"]["b4"]["R"],
                        Sx["no_stress"]["R"]["v2e"], Sx["no_stress"]["R"]["v4ae"], Sx["no_stress"]["R"]["b4"],
                        Sx["bss"]["v2e_vs_pop"]["bss"], Sx["bss"]["v4ae_vs_v2e"]["bss"], Sx["bss"]["v2e_vs_b4"]["bss"],
                        Sx["bss"]["v4ae_vs_b4"]["bss"], shipped4[cid][s]["shipped"] or "pop",
                        Sx["g7"]["v2e"]["label"], Sx["g7"]["v4ae"]["label"], Sx["g7"]["b4"]["label"]])
    G.write_csv(os.path.join(out_dir, "labels-b5.csv"),
                ["cell", "segment", "shipped", "label", "rows", "n_ep", "added_exits", "R_v2e", "R_v4ae", "R_b4",
                 "R_v2e_no_stress", "R_v4ae_no_stress", "R_b4_no_stress", "bss_v2e_vs_pop", "bss_v4ae_vs_v2e",
                 "bss_v2e_vs_b4", "bss_v4ae_vs_b4", "b4_shipped", "label_v2e", "label_v4ae", "label_b4"], lab)
    pred = write_predictions_b5(out_dir, ctx, E, PR)
    big = {sg: {G.CELLS[ci]["id"]: {"n_ep": cells[G.CELLS[ci]["id"]][sg]["n"]["n_ep"],
                                    **{r: cells[G.CELLS[ci]["id"]][sg]["g7"][r]["R"] for r in SCORE_RUNGS},
                                    "no_stress": cells[G.CELLS[ci]["id"]][sg]["no_stress"]["R"]}
                for ci in xc} for sg in ("c3", "w3")}
    labc = {r: {s: G._count([cells[G.CELLS[ci]["id"]][s]["g7"][r]["label"] for ci in xc]) for s in S.SEG_IDS}
            for r in SCORE_RUNGS}
    labc["shipped"] = {s: G._count([cells[G.CELLS[ci]["id"]][s]["label"] for ci in xc]) for s in S.SEG_IDS}
    shipc = {s: G._count([cells[G.CELLS[ci]["id"]][s]["shipped"] or "pop" for ci in xc]) for s in S.SEG_IDS}
    summary = {
        "phase": "run (development; no blind phase, R7.3)", "prereg": PREREG, "inputs_sha256": shas,
        "code": code_meta(), "decisions": DECISIONS, "debt_info": dinfo,
        "features": {"v2e": G.FEATURES_V2, "v4ae": F.FEATURES_V4A + ("(history counts y_econ, B5-8)",)},
        "segments": dict(zip(S.SEG_IDS, S.SEG_NAMES)), "b4_reproduction": repro,
        "exit_counts_test": counts_test, "exit_counts_test_total": sum_counts(counts_test),
        "exit_counts_all_rows": counts_all, "exit_counts_all_rows_total": sum_counts(counts_all),
        "cells": cells, "pooled": pooled, "label_counts": labc, "shipped_counts": shipc,
        "giant_segments_R": big, "fold_params": fpE, "fold_fits": finfoE,
        "asof_params": {G.CELLS[f["ci"]]["id"]: {k: f[k] for k in ("v2", "v4a")} for f in afE},
        "prediction_files": [os.path.basename(p) for p in pred],
        "single_class_fits": sum(int(f["v2"]["info"]["single_class"]) + int(f["v4a"]["info"]["single_class"])
                                 for f in fitsE),
        "convergence_warnings": sum(int(f["v2"]["info"].get("n_convergence_warnings", 0)) +
                                    int(f["v4a"]["info"].get("n_convergence_warnings", 0)) for f in fitsE),
        "runtime_s": time.time() - t_start, "finished_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    B.write_json(rp, summary, refuse_overwrite=True)
    asof = build_asof_record(ctx, E, afE, usdc_units, res[0].addrs)
    B.write_json(os.path.join(out_dir, "asof-fits-b5.json"), asof, refuse_overwrite=True)
    log(f"run: {rp} ({summary['runtime_s']:.0f} s)")
    return summary


def build_asof_record(ctx, E, afE, units, addrs):
    """Asof fits for a live switch: params, per-unit theta (v2e, v4ae) and the y_econ(x, 24 h) exit origin days of
    the last 365 days (v4ae history input)."""
    th = {}
    for f in afE:
        cid = G.CELLS[f["ci"]]["id"]
        th[cid] = {"theta_v2e": [round(v, 10) for v in f["panel"]["theta_v2"]],
                   "theta_v4ae": [round(v, 10) for v in f["panel"]["theta_v4a"]]}
    hist = {}
    last = int(E["t"].max())
    for xi, x in enumerate(G.SIZES):
        ci = int(G.XCELL[2, xi])
        m = E["RES"][:, 2] & (E["Y"][:, ci] == 1) & (E["t"] >= last - int(DEC_LIVE))
        d = {}
        for u, t in zip(E["unit"][m], E["t"][m]):
            d.setdefault(int(u), []).append(ctx.days[int(t)])
        hist[f"x{x}"] = {addrs[u]: v for u, v in sorted(d.items())}
    return {"asof_ts": S.LIVE_ASOF_TS, "asof_block": S.LIVE_ASOF_BLOCK, "units": [addrs[u] for u in units],
            "params": {G.CELLS[f["ci"]]["id"]: {k: f[k] for k in ("v2", "v4a")} for f in afE},
            "theta": th, "econ_exit_origin_days_24h": hist,
            "note": "addresses are public on-chain data; no identity is attached"}


def write_predictions_b5(out_dir, ctx, E, PR, max_bytes=45_000_000):
    import pandas as pd
    test = (E["fold"] >= 0) & E["feat_ok"]
    fold_names = np.array([f[0] for f in ctx.folds])
    days = np.array(ctx.days)
    written = []
    for hi, h in enumerate(G.HNAMES):
        cis = [int(c) for c in G.XCELL[hi]]
        m = np.nonzero(test & E["RES"][:, hi])[0]
        m = m[np.lexsort((E["t"][m], E["unit"][m]))]
        cols = {"unit": E["unit"][m], "date": days[E["t"][m]], "fold": fold_names[E["fold"][m]],
                "segment": np.array(S.SEG_IDS)[E["seg"][m]],
                "stress": F.stress_overlap(E["T0"][m], G.HSEC[hi]).astype(np.int8)}
        for c in cis:
            cid = G.CELLS[c]["id"]
            cols[f"cash_blocked_{cid}"] = E["CAPOLD"][m, c].astype(np.int8)
            cols[f"y_{cid}"] = E["YOLD"][m, c]
            cols[f"yecon_{cid}"] = E["Y"][m, c]
        for k in ("v2e", "v4ae", "b4", "own", "pop"):
            for c in cis:
                cols[f"{k}_{G.CELLS[c]['id']}"] = PR[k][m, c]
        p = os.path.join(out_dir, f"predictions-b5-{h}-USDC.csv.gz")
        pd.DataFrame(cols).to_csv(p, index=False, float_format="%.6g",
                                  compression={"method": "gzip", "compresslevel": 9})
        if os.path.getsize(p) > max_bytes:
            raise SystemExit(f"STOP: {p} > {max_bytes} bytes")
        written.append(p)
    return written


def phase_freeze(out_dir, log=print):
    rp = os.path.join(out_dir, "results-b5.json")
    ap = os.path.join(out_dir, "asof-fits-b5.json")
    fp = os.path.join(out_dir, "frozen-b5.json")
    fr = os.path.join(out_dir, "freeze-record.json")
    if not os.path.exists(rp):
        raise SystemExit("STOP: no results-b5.json.")
    if os.path.exists(fp) or os.path.exists(fr):
        raise SystemExit("STOP: the freeze exists; it is written once.")
    r = json.load(open(rp))
    a = json.load(open(ap))
    cells = {cid: {s: {"shipped": v["shipped"], "label": v["label"], "eligible": v["eligible"],
                       "labels_by_rung": {k: v["g7"][k]["label"] for k in SCORE_RUNGS},
                       "dev_R_by_rung": {k: v["g7"][k]["R"] for k in SCORE_RUNGS}, "dev_n_ep": v["n"]["n_ep"]}
                   for s, v in sv.items()} for cid, sv in r["cells"].items()}
    frozen = {"prereg": PREREG, "results_b5_sha256": sha256_file(rp), "asof_fits_b5_sha256": sha256_file(ap),
              "features": r["features"], "cells": cells, "fold_params": r["fold_params"], "asof": a,
              "folds": [f for f in B.fold_list()], "segments": r["segments"], "decisions": DECISIONS,
              "frozen_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "code": code_meta()}
    B.write_json(fp, frozen, refuse_overwrite=True)
    rec = {"frozen_b5_sha256": sha256_file(fp), "results_b5_sha256": frozen["results_b5_sha256"],
           "asof_fits_b5_sha256": frozen["asof_fits_b5_sha256"], "frozen_utc": frozen["frozen_utc"]}
    B.write_json(fr, rec, refuse_overwrite=True)
    log(f"freeze: frozen-b5.json sha256 {rec['frozen_b5_sha256']}")
    return rec


def phase_manifest(out_dir, log=print):
    files = {}
    for n in sorted(os.listdir(out_dir)):
        p = os.path.join(out_dir, n)
        if os.path.isfile(p) and n != "manifest.json":
            files[n] = {"bytes": os.path.getsize(p), "sha256": sha256_file(p)}
    B.write_json(os.path.join(out_dir, "manifest.json"), {"files": files, "code": code_meta()})
    log(f"manifest: {len(files)} files")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--phase", required=True, choices=["debt-events", "prices", "run", "freeze", "manifest"])
    ap.add_argument("--datasets", default=os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                       "..", "..", "..", "..", "membrane-datasets"))
    ap.add_argument("--debt-dir")
    ap.add_argument("--out")
    ap.add_argument("--workers", type=int, default=3)
    a = ap.parse_args(argv)
    ds = os.path.abspath(a.datasets)
    if a.phase == "debt-events":
        return phase_debt_events(ds, a.debt_dir)
    if a.phase == "prices":
        return phase_prices(ds, a.debt_dir)
    if a.phase == "run":
        return phase_run(ds, a.debt_dir, a.out, workers=a.workers)
    if a.phase == "freeze":
        return phase_freeze(a.out)
    return phase_manifest(a.out)


if __name__ == "__main__":
    main()
