"""Slice-1 acquisition (free sources only). Work files stay local: they hold addresses as keys.

  python3 -m sim1.acquire universe   --work W --market core|arb --t0 ISO
  python3 -m sim1.acquire state      --work W --market core|arb --t0 ISO
  python3 -m sim1.acquire cashext    --work W --market core|arb --t0 ISO
  python3 -m sim1.acquire liqhist    --work W --t0 ISO                      (Core only: double-count guard)
  python3 -m sim1.acquire curvecheck --work W --market arb [--samples 48]   (exact-curve identity check)
  python3 -m sim1.acquire prices     --work W --t0 ISO                      (Binance ETHUSDT/BTCUSDT 1 h to t0)

Reads only development (grade C) data plus state at t0 and the address universe (Borrow logs). It reads no
reserved set (design section 5.1, inventory section 11): no Base, Avalanche or Compound V3 data. On Arbitrum it
reads Borrow logs (addresses only) and state at t0 (after the L1 window, which ends 2026-09); it reads no
LiquidationCall, no daily volume and no historical health factor of Arbitrum (L1 is unscored).
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import gzip
import json
import os
import random
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import b_acquire as B  # noqa: E402
import l1_acquire_cash as L1  # noqa: E402
import r10_mechanics as R10M  # noqa: E402

from sim1 import chain as CH  # noqa: E402
from sim1 import config as CFG  # noqa: E402

DATASETS = os.environ.get("MEMBRANE_DATASETS_DIR",
                          os.path.join(HERE, "..", "..", "..", "..", "..", "membrane-datasets"))
CORE_BORROW_FILES = ["aave-pool-debt/borrow-events-core-pre-2023.csv.gz"] + [
    f"aave-pool-borrows/borrow-events-core-{y}.csv.gz" for y in (2023, 2024, 2025, 2026)]
CORE_BORROW_END = 26_186_746
CASH_END = {"core": 26_186_746, "arb": 515_525_005}      # last block of the committed transfer streams
DAILY_END = {"arb": "2026-10-16"}


def utcnow():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def ts_of(iso: str) -> int:
    return int(dt.datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp())


def jdump(path, obj):
    tmp = path + ".tmp"
    with gzip.open(tmp, "wt") as f:
        json.dump(obj, f, sort_keys=True)
    os.replace(tmp, path)


def jload(path, default=None):
    if not os.path.exists(path):
        return default
    with gzip.open(path, "rt") as f:
        return json.load(f)


def mdir(work, market):
    d = os.path.join(work, market)
    os.makedirs(d, exist_ok=True)
    return d


def t0_block(work, market, t0):
    d = mdir(work, market)
    p = os.path.join(d, f"block-{t0}.json.gz")
    got = jload(p)
    if got:
        return got
    m = CFG.MARKETS[market]
    rpc = CH.make_rpc(m)
    b, tb, tn = CH.block_before(rpc, t0, m["block_s"])
    got = {"block": b, "block_ts": tb, "next_block_ts": tn, "t0": t0}
    jdump(p, got)
    return got


# ---------------------------------------------------------------------------------------------
def phase_universe(work, market, t0):
    m = CFG.MARKETS[market]
    blk = t0_block(work, market, t0)["block"]
    users = set()
    start = m["pool_deploy_block"]
    if market == "core":
        for rel in CORE_BORROW_FILES:
            with gzip.open(os.path.join(DATASETS, rel), "rt") as f:
                for row in csv.DictReader(f):
                    if row["reserve"].lower() == m["usdc"]:
                        users.add(row["onBehalfOf"].lower())
        start = CORE_BORROW_END + 1
    spec = {"address": m["pool"], "topics": [CH.T_BORROW, L1.pad(m["usdc"])]}
    cache = os.path.join(mdir(work, market), "borrow-logs")
    os.makedirs(cache, exist_ok=True)
    lo, n_logs = start, 0
    while lo <= blk:
        hi = min(lo + m["log_range"] - 1, blk)
        p = os.path.join(cache, f"{lo}-{hi}.json.gz")
        rows = jload(p)
        if rows is None:
            rows = ["0x" + g["topic2"][26:] for g in CH.get_logs(m, spec, lo, hi)]
            jdump(p, rows)
        users.update(rows)
        n_logs += len(rows)
        lo = hi + 1
    jdump(os.path.join(mdir(work, market), "users.json.gz"), sorted(users))
    print(f"universe {market}: {len(users)} USDC borrowers ever to block {blk}; {n_logs} tail logs", flush=True)


def phase_state(work, market, t0):
    m = CFG.MARKETS[market]
    b = t0_block(work, market, t0)
    blk = b["block"]
    rpc = CH.make_rpc(m)
    R = CH.reserves(rpc, m, blk)
    us = CH.usdc_state(rpc, m, blk, R)
    users = jload(os.path.join(mdir(work, market), "users.json.gz"))
    debt = CH.debt_scan(rpc, blk, R[m["usdc"]]["vDebt"], users)
    print(f"state {market}: block {blk}; {len(users)} borrowers ever, {len(debt)} with USDC debt", flush=True)
    accts = CH.read_accounts(rpc, m, blk, R, sorted(debt))
    em = CH.emode_meta(rpc, m, blk, {a["emode"] for a in accts.values()})
    depth = {}
    weth = next((a for a, r in R.items() if r["symbol"].upper() == "WETH"), None)
    wbtc = next((a for a, r in R.items() if r["symbol"].upper() == "WBTC"), None)
    for fam, base in (("E", weth), ("B", wbtc)):
        if base:
            depth[fam] = {"base": base, "base_decimals": R[base]["decimals"],
                          "states": CH.uni_states(rpc, blk, base, m["usdc"])}
    out = {"market": market, "block": blk, "block_ts": b["block_ts"], "t0": t0, "reserves": R, "usdc": us,
           "accounts": accts, "emode": em, "depth": depth, "fetched_utc": utcnow(),
           "source": {"call": m["call_url"], "logs": m["log_urls"]}}
    jdump(os.path.join(mdir(work, market), f"state-{t0}.json.gz"), out)
    print(f"state {market}: {len(accts)} accounts read; depth pools "
          f"{ {k: len(v['states']) for k, v in depth.items()} }", flush=True)


def phase_cashext(work, market, t0):
    """Transfer streams to/from the USDC aToken after the committed streams, to t0; daily anchors to t0."""
    m = CFG.MARKETS[market]
    blk = t0_block(work, market, t0)["block"]
    d = mdir(work, market)
    rows = {"in": [], "out": []}
    specs = {"in": {"address": m["usdc"], "topics": [L1.T_TRANSFER, None, L1.pad(m["atoken"])]},
             "out": {"address": m["usdc"], "topics": [L1.T_TRANSFER, L1.pad(m["atoken"])]}}
    for name, spec in specs.items():
        lo = CASH_END[market] + 1
        while lo <= blk:
            hi = min(lo + m["log_range"] - 1, blk)
            for g in CH.get_logs(m, spec, lo, hi):
                rows[name].append({"block": g["block"], "ts": g["ts"], "tx_index": g["tx_index"],
                                   "log_index": g["log_index"], "amount_raw": str(int(g["data"][2:66], 16))})
            lo = hi + 1
    # daily anchors: last block with ts < d 00:00Z, for every day after the committed daily rows up to t0
    rpc = CH.make_rpc(m)
    first = {"core": "2026-10-14", "arb": "2026-10-17"}[market]
    day = dt.date.fromisoformat(first)
    t0d = dt.datetime.fromtimestamp(t0, dt.timezone.utc).date()
    R = None
    daily = []
    while day <= t0d:
        T = int(dt.datetime(day.year, day.month, day.day, tzinfo=dt.timezone.utc).timestamp())
        bb, tb, tn = CH.block_before(rpc, T, m["block_s"])
        if R is None:
            R = CH.reserves(rpc, m, bb)
        u = R[m["usdc"]]
        res = rpc.multicall([(u["aToken"], CH.cd("totalSupply")), (m["usdc"], CH.cd("balanceOf", u["aToken"])),
                             (u["vDebt"], CH.cd("totalSupply"))], bb, "daily")
        v = [B.decode_uint(r) for _, r in res]
        daily.append({"day": day.isoformat(), "block": bb, "block_ts": tb, "next_block_ts": tn,
                      "atoken_total_supply": str(v[0]), "cash_balance": str(v[1]), "vdebt_total_supply": str(v[2])})
        day += dt.timedelta(days=1)
    jdump(os.path.join(d, f"cashext-{t0}.json.gz"), {"from_block": CASH_END[market] + 1, "to_block": blk,
                                                      "in": rows["in"], "out": rows["out"], "daily": daily,
                                                      "fetched_utc": utcnow()})
    print(f"cashext {market}: in {len(rows['in'])}, out {len(rows['out'])}, daily {len(daily)}", flush=True)


def phase_liqhist(work, t0):
    """Core USDC-debt LiquidationCall repayments (hour, USD) for the double-count guard: C1 logs (grade C) plus
    a tail fetch to t0."""
    m = CFG.MARKETS["core"]
    blk = t0_block(work, "core", t0)["block"]
    c1 = jload(os.path.join(DATASETS, "history-forecasts/c1/run-e79f9341/logs.json.gz"))
    rows = [{"block": x["block"], "debtToCover": int(x["debtToCover"])} for x in c1["liquidations"]]
    last = c1["meta"]["to_block"]
    spec = {"address": m["pool"], "topics": [CH.T_LIQ, None, L1.pad(m["usdc"])]}
    lo = last + 1
    while lo <= blk:
        hi = min(lo + m["log_range"] - 1, blk)
        for g in CH.get_logs(m, spec, lo, hi):
            rows.append({"block": g["block"], "ts": g["ts"], "debtToCover": int(g["data"][2:66], 16)})
        lo = hi + 1
    jdump(os.path.join(mdir(work, "core"), f"liqhist-{t0}.json.gz"),
          {"c1_to_block": last, "to_block": blk, "rows": rows, "fetched_utc": utcnow()})
    print(f"liqhist core: {len(rows)} USDC-debt LiquidationCall rows", flush=True)


def phase_curvecheck(work, market, samples=48, seed=7):
    """R10.1A-style identity check: at sampled blocks that end with a USDC ReserveDataUpdated, rebuild the
    stored variable borrow and liquidity rates from totals and the curve (r10_mechanics.model_rates)."""
    m = CFG.MARKETS[market]
    rpc = CH.make_rpc(m)
    hb = CH.head_block(rpc)
    rng = random.Random(seed)
    span_blocks = int(90 * 86400 / m["block_s"])
    win = int(1800 / m["block_s"])
    spec = {"address": m["pool"], "topics": [L1.T_RDU, L1.pad(m["usdc"])]}
    out = []
    tries = 0
    while len(out) < samples and tries < samples * 4:
        tries += 1
        lo = hb - rng.randrange(win, span_blocks)
        logs = CH.get_logs(m, spec, lo, lo + win)
        if not logs:
            continue
        g = logs[-1]
        b = g["block"]
        R = CH.reserves(rpc, m, b)
        u = R[m["usdc"]]
        res = rpc.multicall([(u["vDebt"], CH.cd("totalSupply")), (m["usdc"], CH.cd("balanceOf", u["aToken"])),
                             (m["pool"], CH.cd("getVirtualUnderlyingBalance", m["usdc"])),
                             (u["strategy"], CH.cd("getInterestRateData", m["usdc"]))], b, "curvecheck")
        vb = B.decode_uint(res[2][1]) if res[2][0] and len(res[2][1]) == 32 else None
        row = {"vDebtTotal": B.decode_uint(res[0][1]), "sDebtTotal": 0, "avgStableRate": 0,
               "unbacked": u["unbacked"], "config": u["config"], "virtualBalance": vb,
               "cashBalance": B.decode_uint(res[1][1]),
               "curve_v2": B.decode_words(res[3][1]) if res[3][0] and len(res[3][1]) == 128 else None,
               "curve_v1": None}
        var, sup, era = R10M.model_rates(row)
        out.append({"block": b, "era": era, "stored_vrate": u["vrate_ray"], "model_vrate": var,
                    "stored_lrate": u["lrate_ray"], "model_lrate": sup,
                    "dv_bp": abs(var - u["vrate_ray"]) / 1e27 * 1e4,
                    "dl_bp": abs(sup - u["lrate_ray"]) / 1e27 * 1e4})
    worst_v = max(r["dv_bp"] for r in out) if out else None
    worst_l = max(r["dl_bp"] for r in out) if out else None
    res = {"market": market, "samples": len(out), "worst_vrate_diff_bp": worst_v, "worst_lrate_diff_bp": worst_l,
           "tolerance_bp": 0.005, "pass": bool(out) and worst_v <= 0.005 and worst_l <= 0.005,
           "rule": "R10.1A: rebuilt rate within 0.005 bp at every sampled block (last USDC ReserveDataUpdated "
                   "of a random 30-minute window in the last 90 days)", "rows": out, "fetched_utc": utcnow()}
    jdump(os.path.join(mdir(work, market), "curvecheck.json.gz"), res)
    print(f"curvecheck {market}: n {len(out)}, worst dv {worst_v} bp, dl {worst_l} bp, pass {res['pass']}",
          flush=True)


BINANCE = "https://data-api.binance.vision/api/v3/klines"


def phase_prices(work, t0):
    """Binance 1 h klines for ETHUSDT and BTCUSDT: membrane-datasets binance-klines (to 2026-10-06), the
    q26-touch-live store, then the public API to t0 (bars with open time < t0)."""
    d = mdir(work, "prices")
    for pair in ("ETHUSDT", "BTCUSDT"):
        base = json.load(open(os.path.join(DATASETS, f"binance-klines/{pair}-1h.json")))
        step = base["stepSeconds"]
        ts0 = base["startTs"]
        cols = base["columns"]
        bars = {}
        for i in range(base["count"]):
            o = cols["open"][i]
            if o is None:
                continue
            bars[ts0 + i * step] = (cols["open"][i], cols["high"][i], cols["low"][i], cols["close"][i])
        live = os.path.join(DATASETS, f"forecasts/q26-touch-live/binance/{pair}-1h.csv.gz")
        with gzip.open(live, "rt") as f:
            for r in csv.DictReader(f):
                t = int(r["openTime"]) // 1000
                bars[t] = (float(r["open"]), float(r["high"]), float(r["low"]), float(r["close"]))
        start = max(bars) + step
        while start < t0:
            url = f"{BINANCE}?symbol={pair}&interval=1h&startTime={start * 1000}&limit=1000"
            req = urllib.request.Request(url, headers={"user-agent": "curl/8.5.0"})
            data = json.loads(urllib.request.urlopen(req, timeout=60).read())
            if not data:
                break
            for k in data:
                t = int(k[0]) // 1000
                if t < t0 and int(k[6]) // 1000 < t0:
                    bars[t] = (float(k[1]), float(k[2]), float(k[3]), float(k[4]))
            start = int(data[-1][0]) // 1000 + step
            time.sleep(0.3)
        keys = sorted(t for t in bars if t < t0)
        jdump(os.path.join(d, f"{pair}-{t0}.json.gz"), {"pair": pair, "step": step, "ts": keys,
                                                        "ohlc": [bars[t] for t in keys], "fetched_utc": utcnow()})
        print(f"prices {pair}: {len(keys)} bars, last {dt.datetime.fromtimestamp(keys[-1], dt.timezone.utc)}",
              flush=True)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("phase", choices=["universe", "state", "cashext", "liqhist", "curvecheck", "prices"])
    ap.add_argument("--work", required=True)
    ap.add_argument("--market", choices=list(CFG.MARKETS))
    ap.add_argument("--t0", default="2026-10-18T00:00:00Z")
    ap.add_argument("--samples", type=int, default=48)
    a = ap.parse_args(argv)
    t0 = ts_of(a.t0)
    os.makedirs(a.work, exist_ok=True)
    if a.phase == "universe":
        phase_universe(a.work, a.market, t0)
    elif a.phase == "state":
        phase_state(a.work, a.market, t0)
    elif a.phase == "cashext":
        phase_cashext(a.work, a.market, t0)
    elif a.phase == "liqhist":
        phase_liqhist(a.work, t0)
    elif a.phase == "curvecheck":
        phase_curvecheck(a.work, a.market, a.samples)
    else:
        phase_prices(a.work, t0)


if __name__ == "__main__":
    main()
