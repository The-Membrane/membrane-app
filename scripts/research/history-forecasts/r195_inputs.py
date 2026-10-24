"""Q26 R19.5 input price series for raw (fH) at the borrower event (Claude, Q26 lane, 2026-10-24). DEVELOPMENT ONLY.

membrane-board design/Q26_ROUND19_PREREG.md section R19.5 (inputs, targets, statistics, class rule and selection rule
registered at board e732637 before any score of this script).

Inputs (hourly OHLC grids, one per series; raw (fH) by the unchanged r192_borrower.task):
  I     Binance hourly klines (the development grid, what the live D12 job reads)
  I-cc  I with close-to-close HAR components         I-gk  Garman-Klass components     I-rs  Rogers-Satchell components
  III   Binance 1 m closes -> G(m) = exp(mean ln close of the 60 bars ending at m) (>= 50 of 60); hour bar close = G at
        the hour end, low/high = min/max of G over the hour's 60 minutes (null if any is null)
  IV    venue median (Binance, Coinbase, OKX, Bitfinex, Bitstamp): componentwise median of close/high/low over venues
        with a valid bar, >= 2 venues else the Binance bar
  II    Chainlink: the development dev:ETH / dev:BTC chain rows                                  (ETH, BTC only)
  V     Uniswap V3 pool TWAP (WETH/USDC 0.05%, WBTC/USDC 0.3%) at 10-minute points, III before the pool data (ETH, BTC)
Targets (daily 00:00Z origins): (a) Binance spot touch = label of I; (b) oracle proxy (PRIMARY) = label of III.

  python3 r195_inputs.py acq1m   --out OUT [--workers 4]           Binance 1 m -> hourly G bars (+ TWAP-check samples)
  python3 r195_inputs.py venues  --out OUT                         hourly candles from Coinbase, OKX, Bitfinex, Bitstamp
  python3 r195_inputs.py uni     --out OUT                         Uniswap V3 observe() at hourly blocks (ETH, BTC)
  python3 r195_inputs.py grids   --datasets DS --out OUT           III, IV, V grids (json.gz, sha256)
  python3 r195_inputs.py rows    --datasets DS --out OUT [--workers 4]
  python3 r195_inputs.py score   --out OUT
  python3 r195_inputs.py checks  --datasets DS --out OUT           look-ahead, TWAP rule, labels
  python3 r195_inputs.py synth   --out OUT                         known-answer wick check
Keyless public endpoints only. No address, key or secret is read or written. Nothing ships from this file.
"""
from __future__ import annotations

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import datetime as dt  # noqa: E402
import gzip  # noqa: E402
import hashlib  # noqa: E402
import io  # noqa: E402
import json  # noqa: E402
import math  # noqa: E402
import multiprocessing as mp  # noqa: E402
import subprocess  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402
import urllib.error  # noqa: E402
import urllib.request  # noqa: E402
import zipfile  # noqa: E402

import numpy as np  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "live"))

STEP, DAY = 3600, 86400
TS_B = (6, 12, 24, 72, 168)
TL = {6: "6h", 12: "12h", 24: "1d", 72: "3d", 168: "7d"}
L8 = (-0.02, -0.03, -0.05, -0.07, -0.10, -0.15, -0.20, -0.30)
LV = (-0.02, -0.03, -0.05, -0.07, -0.10, -0.15, -0.20)          # scored levels (R19.5c)
JL = [L8.index(k) for k in LV]
MAIN = ("I", "I-cc", "I-gk", "I-rs", "III", "IV")
EB = ("II", "V")
B_BOOT, SEED = 1000, 20261950
SYN_SEED = 20261951
TWAP_SAMPLE_SEED = 20261952
SPAN2021 = 1609459200                                             # 2021-01-01T00:00:00Z
UA = {"user-agent": "curl/8.5.0"}


def now():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def git_sha():
    try:
        return subprocess.check_output(["git", "-C", HERE, "rev-parse", "--short=8", "HEAD"], text=True).strip()
    except Exception:  # noqa: BLE001
        return "unknown"


def sha_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def universe():
    U = json.load(open(os.path.join(HERE, "live", "d12_universe.json")))
    return U["series"]


def get(url, tries=6, timeout=60, data=None, headers=None):
    for t in range(tries):
        try:
            req = urllib.request.Request(url, data=data, headers={**UA, **(headers or {})})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code in (400, 404):
                return None
            time.sleep(2 + 4 * t)
        except Exception:  # noqa: BLE001
            time.sleep(2 + 4 * t)
    raise RuntimeError(url)


# =====================================================================================================================
# acq1m: Binance 1 m closes -> hourly G bars
# =====================================================================================================================
def minute_G(lc):
    """lc: ln close per minute slot (NaN = missing). G[m] = exp(mean ln close over slots m-59..m), >= 50 present."""
    ok = np.isfinite(lc)
    cs = np.concatenate([[0.0], np.cumsum(np.where(ok, lc, 0.0))])
    cn = np.concatenate([[0], np.cumsum(ok)])
    W = 60
    G = np.full(len(lc), np.nan)
    s_, n_ = cs[W:] - cs[:-W], cn[W:] - cn[:-W]
    with np.errstate(invalid="ignore", divide="ignore"):
        G[W - 1:] = np.where(n_ >= 50, np.exp(s_ / np.maximum(n_, 1)), np.nan)
    return G


def hour_bars_from_G(G, t0):
    """minute slots from t0 (an hour boundary) -> hour open ts, low, high, close of the G path (null if any G null)."""
    nh = len(G) // 60
    Gh = G[:nh * 60].reshape(nh, 60)
    allok = np.isfinite(Gh).all(axis=1)
    lo = np.where(allok, np.nanmin(np.where(np.isfinite(Gh), Gh, np.inf), axis=1), np.nan)
    hi = np.where(allok, np.nanmax(np.where(np.isfinite(Gh), Gh, -np.inf), axis=1), np.nan)
    cl = np.where(np.isfinite(Gh[:, -1]), Gh[:, -1], np.nan)
    return (t0 + STEP * np.arange(nh)).astype(np.int64), lo, hi, cl


def _month(sym, y, m):
    url = f"https://data.binance.vision/data/spot/monthly/klines/{sym}/1m/{sym}-1m-{y:04d}-{m:02d}.zip"
    raw = get(url, timeout=120)
    if raw is None:
        return None, None, None
    import pandas as pd
    z = zipfile.ZipFile(io.BytesIO(raw))
    with z.open(z.namelist()[0]) as f:
        df = pd.read_csv(f, header=None, usecols=[0, 4], dtype=str)
    df = df.apply(pd.to_numeric, errors="coerce").dropna()
    ot = df.iloc[:, 0].to_numpy(float)
    ot = np.where(ot > 1e14, ot / 1000.0, ot)               # microseconds from 2025
    return (ot // 1000).astype(np.int64), df.iloc[:, 1].to_numpy(float), hashlib.sha256(raw).hexdigest()


def acq_sym(args):
    sym, out, y0, y1, m1 = args
    fn = os.path.join(out, "g1m", f"g1m-{sym}.npz")
    if os.path.exists(fn):
        return sym, "exists"
    tl, cl, shas = [], [], {}
    for y in range(y0, y1 + 1):
        for m in range(1, 13):
            if (y, m) > (y1, m1):
                break
            t, c, sha = _month(sym, y, m)
            if t is None:
                continue
            shas[f"{y:04d}-{m:02d}"] = sha
            tl.append(t)
            cl.append(c)
    if not tl:
        return sym, "none"
    t = np.concatenate(tl)
    c = np.concatenate(cl)
    o = np.argsort(t, kind="mergesort")
    t, c = t[o], c[o]
    keep = np.r_[True, np.diff(t) > 0] & (c > 0) & np.isfinite(c)
    t, c = t[keep], c[keep]
    t0 = (t.min() // STEP) * STEP
    nmin = int((t.max() - t0) // 60 + 1)
    lc = np.full(nmin, np.nan)
    lc[(t - t0) // 60] = np.log(c)
    G = minute_G(lc)
    hts, lo, hi, cg = hour_bars_from_G(G, t0)
    # TWAP-check samples: 10 seeded hours per symbol with their raw minute closes (the 119 minutes needed)
    rng = np.random.default_rng(np.random.SeedSequence([TWAP_SAMPLE_SEED, int(hashlib.sha256(sym.encode()).hexdigest()[:8], 16)]))
    cand = np.flatnonzero(np.isfinite(cg) & np.isfinite(lo))
    cand = cand[cand >= 2]
    pick = rng.choice(cand, size=min(10, len(cand)), replace=False)
    samp = []
    for j in pick:
        a0 = (j - 1) * 60 + 1                              # first slot whose G window can matter (m = j*60 - 59 .. )
        sl = slice(j * 60 - 59, j * 60 + 60)
        mins = [None if not np.isfinite(v) else float(np.exp(v)) for v in lc[sl]]
        samp.append({"hour_open": int(hts[j]), "first_minute_open": int(t0 + 60 * (j * 60 - 59)), "closes": mins,
                     "low": float(lo[j]), "high": float(hi[j]), "close": float(cg[j]), "a0": int(a0)})
    os.makedirs(os.path.dirname(fn), exist_ok=True)
    np.savez_compressed(fn, hour_ts=hts, glow=lo, ghigh=hi, gclose=cg)
    json.dump({"sym": sym, "months": shas, "minutes": int(len(t)), "first_minute": int(t[0]), "last_minute": int(t[-1]),
               "samples": samp}, open(os.path.join(out, "g1m", f"g1m-{sym}-meta.json"), "w"))
    return sym, f"{len(shas)} months, {len(hts)} hours"


def cmd_acq1m(a):
    syms = [e["symbol"] for e in universe()] if not a.syms else a.syms.split(",")
    print(now(), "acq1m", syms, flush=True)
    with mp.get_context("fork").Pool(a.workers) as pool:
        for s_, msg in pool.imap_unordered(acq_sym, [(s, a.out, 2017, 2026, 9) for s in syms]):
            print(now(), s_, msg, flush=True)


# =====================================================================================================================
# venues: hourly candles (keyless public endpoints)
# =====================================================================================================================
T_FIRST, T_END = 1502928000, 1791331200          # 2017-08-17 .. 2026-10-07 (hour opens)
BASES = {"ETHUSDT": "ETH", "BTCUSDT": "BTC"}


def base_of(sym):
    return sym[:-4]


def fetch_coinbase(base):
    out = {}
    prod = f"{base}-USD"
    t = T_FIRST
    miss = 0
    while t < T_END:
        e = min(t + 300 * STEP, T_END)
        s_ = dt.datetime.fromtimestamp(t, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        e_ = dt.datetime.fromtimestamp(e - STEP, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        raw = get(f"https://api.exchange.coinbase.com/products/{prod}/candles?granularity=3600&start={s_}&end={e_}")
        if raw is None:
            return out if out else None
        for r in json.loads(raw):
            out[int(r[0])] = (float(r[2]), float(r[1]), float(r[4]))      # [time, low, high, open, close, vol]
        t = e
        time.sleep(0.12)
    return out


def fetch_okx(base):
    out = {}
    inst = f"{base}-USDT"
    after = (T_END + STEP) * 1000
    while True:
        raw = get(f"https://www.okx.com/api/v5/market/history-candles?instId={inst}&bar=1H&after={after}&limit=100")
        if raw is None:
            break
        d = json.loads(raw)
        if d.get("code") != "0":
            if d.get("code") in ("51001",):
                return None
            time.sleep(2)
            continue
        rows = d["data"]
        if not rows:
            break
        for r in rows:
            ts = int(r[0]) // 1000
            if ts < T_END:
                out[ts] = (float(r[2]), float(r[3]), float(r[4]))           # [ts, o, h, l, c, ...]
        after = int(rows[-1][0])
        if after // 1000 < T_FIRST:
            break
        time.sleep(0.11)
    return out if out else None


BFX = {"LINK": "LINK:USD", "AVAX": "AVAX:USD", "DOGE": "DOGE:USD", "NEAR": "NEAR:USD", "AAVE": "AAVE:USD",
       "INJ": "INJ:USD", "QNT": "QNT:USD", "DOT": "DOTUSD", "UNI": "UNIUSD", "FIL": "FILUSD", "ADA": "ADAUSD",
       "SOL": "SOLUSD", "TRX": "TRXUSD", "ZEC": "ZECUSD", "BAT": "BATUSD", "XRP": "XRPUSD", "LTC": "LTCUSD",
       "ETH": "ETHUSD", "BTC": "BTCUSD", "BNB": None}


def fetch_bitfinex(base):
    pair = BFX.get(base)
    if pair is None:
        return None
    out = {}
    start = T_FIRST * 1000
    while start < T_END * 1000:
        raw = get(f"https://api-pub.bitfinex.com/v2/candles/trade:1h:t{pair}/hist?limit=10000&start={start}&sort=1")
        if raw is None:
            break
        rows = json.loads(raw)
        if isinstance(rows, dict) or (rows and rows[0] == "error"):
            time.sleep(30)
            continue
        if not rows:
            break
        for r in rows:
            ts = int(r[0]) // 1000
            if ts < T_END:
                out[ts] = (float(r[3]), float(r[4]), float(r[2]))           # [mts, o, c, h, l, v]
        nxt = int(rows[-1][0]) + STEP * 1000
        if nxt <= start:
            break
        start = nxt
        time.sleep(3.0)
    return out if out else None


def fetch_bitstamp(base):
    pair = f"{base.lower()}usd"
    out = {}
    start = T_FIRST
    while start < T_END:
        raw = get(f"https://www.bitstamp.net/api/v2/ohlc/{pair}/?step=3600&limit=1000&start={start}")
        if raw is None:
            break
        d = json.loads(raw)
        rows = d.get("data", {}).get("ohlc", [])
        if not rows:
            if start == T_FIRST:
                # pair may have started later: jump ahead
                start += 1000 * STEP
                if start > T_END:
                    break
                continue
            start += 1000 * STEP
            continue
        for r in rows:
            ts = int(r["timestamp"])
            if ts < T_END:
                out[ts] = (float(r["high"]), float(r["low"]), float(r["close"]))
        nxt = int(rows[-1]["timestamp"]) + STEP
        start = max(nxt, start + STEP)
        time.sleep(0.25)
    return out if out else None


FETCH = {"coinbase": fetch_coinbase, "okx": fetch_okx, "bitfinex": fetch_bitfinex, "bitstamp": fetch_bitstamp}


def venue_job(args):
    venue, sym, out = args
    fn = os.path.join(out, "venues", f"{venue}-{sym}.npz")
    if os.path.exists(fn) or os.path.exists(fn + ".none"):
        return venue, sym, "exists"
    try:
        d = FETCH[venue](base_of(sym))
    except Exception as e:  # noqa: BLE001
        return venue, sym, f"ERROR {type(e).__name__}"
    os.makedirs(os.path.dirname(fn), exist_ok=True)
    if not d:
        open(fn + ".none", "w").write("no data\n")
        return venue, sym, "none"
    ts = np.array(sorted(d), np.int64)
    v = np.array([d[t] for t in ts], float)                 # high, low, close
    np.savez_compressed(fn, ts=ts, high=v[:, 0], low=v[:, 1], close=v[:, 2])
    return venue, sym, f"{len(ts)} bars from {dt.datetime.fromtimestamp(int(ts[0]), dt.timezone.utc):%Y-%m-%d}"


def cmd_venues(a):
    syms = [e["symbol"] for e in universe()] if not a.syms else a.syms.split(",")
    venues = a.venues.split(",")
    import concurrent.futures as cf
    with cf.ThreadPoolExecutor(len(venues)) as ex:
        futs = []
        for v in venues:
            futs.append(ex.submit(lambda v=v: [print(now(), *venue_job((v, s, a.out)), flush=True) for s in syms]))
        for f in futs:
            f.result()


# =====================================================================================================================
# uni: Uniswap V3 observe() at hourly blocks (archive eth_call, keyless)
# =====================================================================================================================
POOLS = {"ETHUSDT": {"addr": "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640", "name": "WETH/USDC 0.05%",
                     "dec0": 6, "dec1": 18, "base_is": 1},
         "BTCUSDT": {"addr": "0x99ac8cA7087fA4A2A1FB6357269965A2014ABc35", "name": "WBTC/USDC 0.3%",
                     "dec0": 8, "dec1": 6, "base_is": 0}}
RPCS = ("https://rpc.mevblocker.io", "https://rpc.mevblocker.io", "https://eth.drpc.org")
MERGE_BLOCK, MERGE_TS = 15537394, 1663224179


def rpc(batch, k=0):
    body = json.dumps(batch).encode()
    for t in range(8):
        url = RPCS[(k + t) % len(RPCS)]
        try:
            raw = get(url, tries=1, timeout=90, data=body, headers={"content-type": "application/json"})
            if raw is None:
                raise RuntimeError("http")
            out = json.loads(raw)
            if isinstance(out, dict):
                raise RuntimeError(str(out)[:100])
            return {o["id"]: o for o in out}
        except Exception:  # noqa: BLE001
            time.sleep(1 + 2 * t)
    raise RuntimeError("rpc failed")


def block_ts(blocks):
    res = {}
    for c in range(0, len(blocks), 100):
        chunk = blocks[c:c + 100]
        out = rpc([{"jsonrpc": "2.0", "id": i, "method": "eth_getBlockByNumber", "params": [hex(b), False]}
                   for i, b in enumerate(chunk)], c // 100)
        for i, b in enumerate(chunk):
            res[b] = int(out[i]["result"]["timestamp"], 16)
    return res


def first_block_at_or_after(T, anchors):
    """anchors: sorted list of (block, ts). Interpolate, then refine by header reads."""
    bs = np.array([x[0] for x in anchors])
    tss = np.array([x[1] for x in anchors])
    return bs, tss


def enc_observe(secs):
    return "0x883bdbfd" + f"{32:064x}" + f"{len(secs):064x}" + "".join(f"{s:064x}" for s in secs)


def dec_observe(hexdata, n):
    b = bytes.fromhex(hexdata[2:])
    w = [b[i:i + 32] for i in range(0, len(b), 32)]
    off = int.from_bytes(w[0], "big") // 32
    cnt = int.from_bytes(w[off], "big")
    vals = [int.from_bytes(w[off + 1 + i], "big", signed=True) for i in range(cnt)]
    return vals[:n]


def cmd_uni(a):
    os.makedirs(os.path.join(a.out, "uni"), exist_ok=True)
    start_H = int(dt.datetime(2021, 8, 11, tzinfo=dt.timezone.utc).timestamp())      # first probe that worked: 13.0M
    end_H = 1791244800                                                                 # 2026-10-06T00:00Z
    hours = np.arange(start_H, end_H + 1, STEP)
    # 1. block anchors every 2000 blocks over the span
    bfile = os.path.join(a.out, "uni", "blocks.npz")
    if os.path.exists(bfile):
        Z = np.load(bfile)
        H_ok, H_blk, H_bts = Z["H"], Z["blk"], Z["bts"]
    else:
        lo_b = 12_990_000
        hi_b = int(rpc([{"jsonrpc": "2.0", "id": 0, "method": "eth_blockNumber", "params": []}])[0]["result"], 16)
        grid = list(range(lo_b, hi_b, 2000))
        print(now(), "anchors", len(grid), flush=True)
        anc = block_ts(grid)
        bs = np.array(sorted(anc))
        ts_ = np.array([anc[b] for b in bs])
        # any block with timestamp >= H serves: observe() is read at secondsAgo = ts_b - H, and the tick cumulative
        # at a past time does not depend on which later block is queried. Margin of 30 blocks (about 6 minutes).
        cur = np.ceil(np.interp(hours, ts_, bs)).astype(np.int64) + 30
        todo = np.arange(len(hours))
        t_c = np.zeros(len(hours), np.int64)
        for it in range(10):
            tsm = block_ts(sorted(set(cur[todo].tolist())))
            t_c[todo] = [tsm[b] for b in cur[todo]]
            bad = todo[t_c[todo] < hours[todo]]
            print(now(), f"pass {it}: read {len(todo)}, still before H {len(bad)}", flush=True)
            if len(bad) == 0:
                break
            cur[bad] += 30
            todo = bad
        H_ok, H_blk, H_bts = hours, cur, t_c
        np.savez_compressed(bfile, H=H_ok, blk=H_blk, bts=H_bts)
    print(now(), "blocks ready", len(H_ok), "max lag s", int((H_bts - H_ok).max()), flush=True)
    for sym, P in POOLS.items():
        fn = os.path.join(a.out, "uni", f"uni-{sym}.npz")
        if os.path.exists(fn):
            continue
        tc = np.full((len(H_ok), 13), np.nan)
        err = np.zeros(len(H_ok), np.int8)
        for c in range(0, len(H_ok), 50):
            idx = range(c, min(c + 50, len(H_ok)))
            batch = []
            for j in idx:
                off = int(H_bts[j] - H_ok[j])
                secs = [off + 600 * q for q in range(13)]
                batch.append({"jsonrpc": "2.0", "id": j, "method": "eth_call",
                              "params": [{"to": P["addr"], "data": enc_observe(secs)}, hex(int(H_blk[j]))]})
            out = rpc(batch, c // 50)
            for j in idx:
                o = out.get(j, {})
                if "result" in o and o["result"] and len(o["result"]) > 10:
                    tc[j] = dec_observe(o["result"], 13)
                else:
                    err[j] = 1
            if (c // 50) % 100 == 0:
                print(now(), sym, c, "/", len(H_ok), "errors", int(err[:c + 50].sum()), flush=True)
        np.savez_compressed(fn, H=H_ok, tc=tc, err=err)
        print(now(), sym, "done; errors", int(err.sum()), flush=True)


def uni_twap(sym, out):
    """-> H (hour ends), tw (n, 7): TWAP ending at H - 600 j, j = 0..6, USD per base."""
    Z = np.load(os.path.join(out, "uni", f"uni-{sym}.npz"))
    P = POOLS[sym]
    tc = Z["tc"]                                  # cumulatives at H - 600 q, q = 0..12
    tw = np.full((len(Z["H"]), 7), np.nan)
    for j in range(7):
        d = tc[:, j] - tc[:, j + 6]               # cumulative over [H - 600 j - 3600, H - 600 j]
        mt = np.floor(d / 3600.0)                 # arithmetic-mean tick, floored toward -inf (V3PoolSelector)
        raw = np.power(1.0001, mt)                # token1 per token0 (raw units)
        if P["base_is"] == 1:                     # USDC token0, WETH token1: USD per ETH = 10^(dec1-dec0) / raw
            tw[:, j] = 10.0 ** (P["dec1"] - P["dec0"]) / raw
        else:                                     # WBTC token0, USDC token1: USD per BTC = raw * 10^(dec0-dec1)
            tw[:, j] = raw * 10.0 ** (P["dec0"] - P["dec1"])
    return Z["H"], tw


# =====================================================================================================================
# grids
# =====================================================================================================================
def load_grid(path):
    raw = open(path, "rb").read()
    if path.endswith(".gz"):
        raw = gzip.decompress(raw)
    d = json.loads(raw)
    st = int(d["startTs"])
    cols = {c: np.array([np.nan if v is None else float(v) for v in d["columns"][c]], float) for c in ("close", "low", "high")}
    return st, cols


def write_grid(path, st, close, low, high, meta):
    def col(x):
        return [None if not np.isfinite(v) else float(f"{v:.10g}") for v in x]
    d = {"startTs": int(st), "stepSeconds": STEP, "count": int(len(close)), "meta": meta,
         "columns": {"close": col(close), "low": col(low), "high": col(high)}}
    raw = json.dumps(d, separators=(",", ":")).encode()
    with open(path, "wb") as f:
        f.write(gzip.compress(raw, mtime=0))
    return sha_file(path)


def on_grid(st, n, ts, *arrs):
    idx = (ts - st) // STEP
    ok = (idx >= 0) & (idx < n) & ((ts - st) % STEP == 0)
    outs = []
    for x in arrs:
        o = np.full(n, np.nan)
        o[idx[ok]] = x[ok]
        outs.append(o)
    return outs


def cmd_grids(a):
    gd = os.path.join(a.out, "grids")
    os.makedirs(gd, exist_ok=True)
    man = {"code": git_sha(), "built_utc": now(), "grids": {}}
    for e in universe():
        sym = e["symbol"]
        st, cols = load_grid(os.path.join(a.datasets, e["path"]))
        n = len(cols["close"])
        # III
        Z = np.load(os.path.join(a.out, "g1m", f"g1m-{sym}.npz"))
        lo3, hi3, cl3 = on_grid(st, n, Z["hour_ts"], Z["glow"], Z["ghigh"], Z["gclose"])
        p3 = os.path.join(gd, f"III-{sym}-1h.json.gz")
        man["grids"][f"III:{sym}"] = {"path": os.path.basename(p3), "sha256": write_grid(
            p3, st, cl3, lo3, hi3, {"input": "III", "what": "1 h geometric-mean TWAP path of Binance 1 m closes"}),
            "finite_close": int(np.isfinite(cl3).sum())}
        # IV
        H, L, C = [cols["high"]], [cols["low"]], [cols["close"]]
        used = ["binance"]
        screened, nscr = [], 0
        for v in ("coinbase", "okx", "bitfinex", "bitstamp"):
            fn = os.path.join(a.out, "venues", f"{v}-{sym}.npz")
            if not os.path.exists(fn):
                continue
            V = np.load(fn)
            h, lo, c = on_grid(st, n, V["ts"], V["high"], V["low"], V["close"])
            bad = ~(np.isfinite(h) & np.isfinite(lo) & np.isfinite(c) & (lo > 0) & (h >= lo) & (h >= c) & (c >= lo))
            with np.errstate(invalid="ignore", divide="ignore"):
                dev = np.abs(np.log(c / cols["close"]))
            md = float(np.nanmedian(dev)) if np.isfinite(dev).any() else np.inf
            if md > 0.005:                                   # D-R19.5c screen 2: stale / illiquid venue for this series
                screened.append(f"{v} (median gap {md * 1e4:.0f} bp)")
                continue
            bad |= dev > 0.10                                # D-R19.5c screen 1: bar > 10% from the Binance close
            nscr += int((dev > 0.10).sum())
            h[bad], lo[bad], c[bad] = np.nan, np.nan, np.nan
            H.append(h)
            L.append(lo)
            C.append(c)
            used.append(v)
        H, L, C = np.vstack(H), np.vstack(L), np.vstack(C)
        okb = np.isfinite(C[0]) & np.isfinite(H[0]) & np.isfinite(L[0])
        valid = np.isfinite(C) & np.isfinite(H) & np.isfinite(L)
        valid[0] = okb
        nv = valid.sum(0)
        with np.errstate(all="ignore"):
            import warnings
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                mc = np.nanmedian(np.where(valid, C, np.nan), axis=0)
                mh = np.nanmedian(np.where(valid, H, np.nan), axis=0)
                ml = np.nanmedian(np.where(valid, L, np.nan), axis=0)
        fb = nv < 2
        mc[fb], mh[fb], ml[fb] = cols["close"][fb], cols["high"][fb], cols["low"][fb]
        p4 = os.path.join(gd, f"IV-{sym}-1h.json.gz")
        fin = np.isfinite(mc)
        man["grids"][f"IV:{sym}"] = {"path": os.path.basename(p4), "sha256": write_grid(
            p4, st, mc, ml, mh, {"input": "IV", "venues": used, "what": "componentwise venue median, >= 2 venues"}),
            "venues": used, "screened_venues": screened, "bars_screened_10pct": nscr, "hours_binance_only": int((fb & fin).sum()), "hours_2": int((nv == 2).sum()),
            "hours_ge3": int((nv >= 3).sum()), "finite_close": int(fin.sum()),
            "hours_ge3_2021plus": int(((nv >= 3) & (st + STEP * np.arange(n) >= SPAN2021)).sum()),
            "hours_2021plus": int(((st + STEP * np.arange(n) >= SPAN2021) & fin).sum())}
        # V
        if sym in POOLS and os.path.exists(os.path.join(a.out, "uni", f"uni-{sym}.npz")):
            Hend, tw = uni_twap(sym, a.out)
            ho = Hend - STEP                         # bar opening at H - 1 h
            cl5 = tw[:, 0]
            lo5 = np.nanmin(tw[:, :6], axis=1)
            hi5 = np.nanmax(tw[:, :6], axis=1)
            okv = np.isfinite(tw[:, :6]).all(axis=1)
            cl5[~okv], lo5[~okv], hi5[~okv] = np.nan, np.nan, np.nan
            c5, l5, h5 = on_grid(st, n, ho, cl5, lo5, hi5)
            first = int(np.flatnonzero(np.isfinite(c5))[0])
            c5[:first], l5[:first], h5[:first] = cl3[:first], lo3[:first], hi3[:first]
            p5 = os.path.join(gd, f"V-{sym}-1h.json.gz")
            man["grids"][f"V:{sym}"] = {"path": os.path.basename(p5), "sha256": write_grid(
                p5, st, c5, l5, h5, {"input": "V", "pool": POOLS[sym]["name"], "splice_open_ts": int(st + STEP * first),
                                     "what": "Uniswap V3 1 h TWAP at 10-minute points; III before the splice"}),
                "splice_open_ts": int(st + STEP * first), "null_after_splice": int((~np.isfinite(c5[first:])).sum())}
        print(now(), sym, {k: v for k, v in man["grids"].items() if k.endswith(sym)}, flush=True)
    json.dump(man, open(os.path.join(gd, "grids-manifest.json"), "w"), indent=1)


# =====================================================================================================================
# rows: raw (fH) per input on its grid (unchanged r192_borrower.task); volatility variants by HAR component swap
# =====================================================================================================================
def _har_variant(kind):
    import a6_touch as A6
    import a3_touch as M3  # noqa: F401

    def comps(ser):
        c = np.asarray(ser.close, float)
        h = np.asarray(ser.high, float)
        lo = np.asarray(ser.low, float)
        n = len(c)
        o = np.full(n, np.nan)
        o[1:] = c[:-1]
        with np.errstate(invalid="ignore", divide="ignore"):
            if kind == "cc":
                v = np.log(c / o) ** 2
            elif kind == "gk":
                v = 0.5 * np.log(h / lo) ** 2 - (2 * math.log(2) - 1) * np.log(c / o) ** 2
            elif kind == "rs":
                v = np.log(h / c) * np.log(h / o) + np.log(lo / c) * np.log(lo / o)
            else:
                raise ValueError(kind)
        bad = ~(np.isfinite(v) & np.isfinite(h) & np.isfinite(lo) & (h >= lo))
        v[bad] = np.nan
        v[:ser.start_i] = np.nan
        C = np.column_stack([A6.ANNUAL * A6.window_mean_null_rule(v, W, ser.start_i) for W in A6.HAR_WINDOWS])
        C[~(C > 0)] = np.nan
        return C

    def har_of(ser):
        if getattr(ser, "_har", None) is None:
            ser._har = comps(ser)
        return ser._har
    return har_of


def specs_for(datasets, out):
    S = []
    for e in universe():
        sym = e["symbol"]
        g = "ETHBTC" if sym in ("ETHUSDT", "BTCUSDT") else "LARGE"
        base = os.path.join(datasets, e["path"])
        for inp in MAIN:
            path = base if inp.startswith("I") and inp != "III" else os.path.join(out, "grids", f"{inp}-{sym}-1h.json.gz")
            S.append({"key": f"{inp}|{sym}", "inp": inp, "sym": sym, "group": g, "kind": "grid", "path": path})
        if g == "ETHBTC":
            S.append({"key": f"II|{sym}", "inp": "II", "sym": sym, "group": g, "kind": "chain",
                      "asset": sym[:3], "datasets": datasets})
            p5 = os.path.join(out, "grids", f"V-{sym}-1h.json.gz")
            if os.path.exists(p5):
                S.append({"key": f"V|{sym}", "inp": "V", "sym": sym, "group": g, "kind": "grid", "path": p5})
    return S


def row_task(spec, truncate_after=None):
    import a6_touch as A6
    import r192_borrower as B
    orig = A6.har_of
    try:
        if spec["inp"] in ("I-cc", "I-gk", "I-rs"):
            A6.har_of = _har_variant(spec["inp"][2:])
        sp = {k: v for k, v in spec.items() if k in ("key", "kind", "path", "asset", "datasets")}
        if truncate_after is not None:
            sp = dict(sp, path=_truncated_copy(spec["path"], truncate_after))
        r = B.task(sp)
    finally:
        A6.har_of = orig
    out = {}
    for T, R in r["rows"].items():
        m = R["ts"] % DAY == 0
        out[T] = {k: np.asarray(R[k])[m] for k in ("ts", "y", "a", "fH")}
    return spec["key"], out


def _truncated_copy(path, cut):
    st, cols = load_grid(path)
    n = len(cols["close"])
    ts = st + STEP * np.arange(n)
    for c in cols:
        cols[c][ts >= cut] = np.nan
    p = path.replace(".json", f".trunc{cut}.json")
    if not p.endswith(".gz"):
        p += ".gz"
    p = os.path.join(os.environ.get("R195_TMP", "/tmp"), os.path.basename(p))
    write_grid(p, st, cols["close"], cols["low"], cols["high"], {"truncated_at": int(cut)})
    return p


def _row_task_k(spec):
    return row_task(spec)


def cmd_rows(a):
    import r16_dev as D
    D.init_btc(a.datasets)
    S = specs_for(a.datasets, a.out)
    print(now(), f"START r195 rows; code {git_sha()}; specs {len(S)}", flush=True)
    for s_ in S:
        if s_["kind"] == "chain":
            import r12_tail as R12
            R12.load_series(s_)
            break
    res = {}
    with mp.get_context("fork").Pool(a.workers, maxtasksperchild=6) as pool:
        for j, (k, out) in enumerate(pool.imap_unordered(_row_task_k, S, chunksize=1)):
            res[k] = out
            if (j + 1) % 10 == 0 or j + 1 == len(S):
                print(now(), f"  {j + 1}/{len(S)}", flush=True)
    arr = {}
    for k, out in res.items():
        for T, R in out.items():
            for c, v in R.items():
                arr[f"{k}|{T}|{c}"] = v
    np.savez_compressed(os.path.join(a.out, "rows-r195.npz"), **arr)
    json.dump({"code": git_sha(), "finished_utc": now(), "specs": [s_["key"] for s_ in S]},
              open(os.path.join(a.out, "rows-r195-meta.json"), "w"), indent=1)


# =====================================================================================================================
# score
# =====================================================================================================================
def load_rows(out):
    Z = np.load(os.path.join(out, "rows-r195.npz"))
    R = {}
    for k in Z.files:
        inp, sym, T, c = k.split("|")
        R.setdefault((inp, sym, int(T)), {})[c] = Z[k]
    return R


def join(R, inps, sym, T, tmin=None):
    """common daily origins of the inputs and both targets: -> ts, p {inp: (n, 8)}, y_a, a_a, y_b, a_b."""
    keys = set(R[("I", sym, T)]["ts"].tolist()) & set(R[("III", sym, T)]["ts"].tolist())
    for i in inps:
        if (i, sym, T) not in R:
            return None
        keys &= set(R[(i, sym, T)]["ts"].tolist())
    ts = np.array(sorted(keys), np.int64)
    if tmin is not None:
        ts = ts[ts >= tmin]
    if len(ts) == 0:
        return None

    def pick(i, c):
        d = R[(i, sym, T)]
        ix = np.searchsorted(d["ts"], ts)
        assert (d["ts"][ix] == ts).all()
        return d[c][ix]
    p = {i: pick(i, "fH").astype(np.float64) for i in inps}
    fin = np.ones(len(ts), bool)
    for i in inps:
        fin &= np.isfinite(p[i]).all(axis=1)
    ya, aa = pick("I", "y"), pick("I", "a").astype(np.float64)
    yb, ab = pick("III", "y"), pick("III", "a").astype(np.float64)
    fin &= (ya >= 0).all(axis=1) & (yb >= 0).all(axis=1)
    return {"ts": ts[fin], "p": {i: v[fin] for i, v in p.items()}, "ya": ya[fin], "aa": aa[fin], "yb": yb[fin],
            "ab": ab[fin]}


def score_panel(R, syms_by_group, inps, span_min, tmin_by_sym=None, B=B_BOOT, seed_off=0):
    import r193_regrade as G
    res = {}
    for g, syms in syms_by_group.items():
        for T in TS_B:
            parts = []
            for si, sym in enumerate(syms):
                J = join(R, inps, sym, T, tmin=max(span_min, (tmin_by_sym or {}).get(sym, 0)))
                if J is None:
                    continue
                J["sid"] = np.full(len(J["ts"]), si)
                parts.append(J)
            if not parts:
                continue
            ts = np.concatenate([q["ts"] for q in parts])
            sid = np.concatenate([q["sid"] for q in parts])
            blk = G.block_of(ts, T)
            for tgt in ("a", "b"):
                y = np.concatenate([q["y" + tgt] for q in parts])
                pa = np.concatenate([q["a" + tgt] for q in parts])
                for jj, (j, k) in enumerate(zip(JL, LV)):
                    yy = y[:, j].astype(np.float64)
                    pe = G.asof_rate(ts, T, yy)
                    for ii, inp in enumerate(inps):
                        p = np.concatenate([q["p"][inp] for q in parts])[:, j]
                        st = G.cell_stats(np.clip(p, 0, 1), pa[:, j], yy, sid, blk, time_only=(g == "ETHBTC"),
                                          B=B, seed=seed_off + 1000 * T + 10 * jj + (0 if tgt == "a" else 5), pe=pe)
                        st["brier_pt"] = float(np.mean((p - yy) ** 2))
                        st["class"] = G.classify(st)
                        st["mean_p"] = float(p.mean())
                        st["rate"] = float(yy.mean())
                        res[f"{inp}|{g}|{TL[T]}|{int(round(k * 100))}|{tgt}"] = st
            print(now(), g, TL[T], "rows", len(ts), flush=True)
    return res


def cmd_score(a):
    R = load_rows(a.out)
    U = universe()
    eb = [e["symbol"] for e in U if e["symbol"] in ("ETHUSDT", "BTCUSDT")]
    lg = [e["symbol"] for e in U if e["symbol"] not in ("ETHUSDT", "BTCUSDT")]
    out = {"code": git_sha(), "started_utc": now()}
    for span, smin in (("full", 0), ("2021", SPAN2021)):
        out[f"main|{span}"] = score_panel(R, {"ETHBTC": eb, "LARGE": lg}, MAIN, smin)
    # ETH/BTC panel: II and V, each on its common rows with I, III and the main-panel inputs
    man = json.load(open(os.path.join(a.out, "grids", "grids-manifest.json")))
    tminV = {s: man["grids"][f"V:{s}"]["splice_open_ts"] + 30 * DAY for s in eb if f"V:{s}" in man["grids"]}
    for span, smin in (("full", 0), ("2021", SPAN2021)):
        out[f"ebII|{span}"] = score_panel(R, {"ETHBTC": eb}, MAIN + ("II",), smin, seed_off=100000)
        if tminV:
            out[f"ebV|{span}"] = score_panel(R, {"ETHBTC": eb}, MAIN + ("V",), smin, tmin_by_sym=tminV, seed_off=200000)
    out["finished_utc"] = now()
    json.dump(out, open(os.path.join(a.out, "score-r195.json"), "w"))
    summarize(out, a.out)


def summarize(S, outdir):
    lines = []

    def cnt(panel, inp, tgt, group=None):
        c = {}
        for k, st in S[panel].items():
            i, g, T, lv, t = k.split("|")
            if i == inp and t == tgt and (group is None or g == group):
                c[st["class"]] = c.get(st["class"], 0) + 1
        return c

    def mbrier(panel, inp, tgt):
        v = [st["brier_pt"] for k, st in S[panel].items() if k.split("|")[0] == inp and k.split("|")[4] == tgt]
        return float(np.mean(v)) if v else float("nan")
    sel = {}
    for span in ("full", "2021"):
        panel = f"main|{span}"
        lines.append(f"## main panel, span {span}")
        for tgt in ("b", "a"):
            lines.append(f"### target ({tgt})")
            lines.append("| input | CALIBRATED-WARN | RECALIBRATE | DO NOT SHOW | HISTORY COUNT | ETHBTC pass | LARGE pass | mean Brier |")
            lines.append("|---|---|---|---|---|---|---|---|")
            for inp in MAIN:
                c = cnt(panel, inp, tgt)
                lines.append(f"| {inp} | {c.get('CALIBRATED-WARN', 0)} | {c.get('RECALIBRATE', 0)} | {c.get('DO NOT SHOW', 0)} | "
                             f"{c.get('HISTORY COUNT', 0)} | {cnt(panel, inp, tgt, 'ETHBTC').get('CALIBRATED-WARN', 0)} | "
                             f"{cnt(panel, inp, tgt, 'LARGE').get('CALIBRATED-WARN', 0)} | {mbrier(panel, inp, tgt):.6f} |")
        sel[span] = sorted(MAIN, key=lambda i: (-cnt(panel, i, "b").get("CALIBRATED-WARN", 0), mbrier(panel, i, "b")))
    for pn in ("ebII", "ebV"):
        for span in ("full", "2021"):
            panel = f"{pn}|{span}"
            if panel not in S:
                continue
            lines.append(f"## ETH/BTC panel {pn}, span {span}")
            for tgt in ("b", "a"):
                lines.append(f"### target ({tgt})")
                lines.append("| input | CALIBRATED-WARN | RECALIBRATE | DO NOT SHOW | HISTORY COUNT | mean Brier |")
                lines.append("|---|---|---|---|---|---|")
                for inp in MAIN + (pn[2:],):
                    c = cnt(panel, inp, tgt)
                    lines.append(f"| {inp} | {c.get('CALIBRATED-WARN', 0)} | {c.get('RECALIBRATE', 0)} | "
                                 f"{c.get('DO NOT SHOW', 0)} | {c.get('HISTORY COUNT', 0)} | {mbrier(panel, inp, tgt):.6f} |")
    pick = sel["full"][0]
    nI_full = cnt("main|full", "I", "b").get("CALIBRATED-WARN", 0)
    nP_full = cnt("main|full", pick, "b").get("CALIBRATED-WARN", 0)
    nI_21 = cnt("main|2021", "I", "b").get("CALIBRATED-WARN", 0)
    nP_21 = cnt("main|2021", pick, "b").get("CALIBRATED-WARN", 0)
    change = pick != "I" and nP_full > nI_full and nP_21 >= nI_21
    verdict = {"pick_full": pick, "order_full": sel["full"], "pick_2021": sel["2021"][0], "order_2021": sel["2021"],
               "pass_b_full": {i: cnt("main|full", i, "b").get("CALIBRATED-WARN", 0) for i in MAIN},
               "pass_b_2021": {i: cnt("main|2021", i, "b").get("CALIBRATED-WARN", 0) for i in MAIN},
               "recommend_change": bool(change), "span_flag": sel["full"][0] != sel["2021"][0]}
    lines.insert(0, f"# R19.5 verdict: {json.dumps(verdict)}\n")
    open(os.path.join(outdir, "summary-r195.md"), "w").write("\n".join(lines) + "\n")
    json.dump(verdict, open(os.path.join(outdir, "verdict-r195.json"), "w"), indent=1)
    print("\n".join(lines[:40]))


def cell_table(S, panel, inps, tgt, group):
    rows = ["| cell | " + " | ".join(inps) + " |", "|---|" + "---|" * len(inps)]
    ab = {"CALIBRATED-WARN": "CW", "RECALIBRATE": "RC", "DO NOT SHOW": "DNS", "HISTORY COUNT": "HC"}
    for T in TS_B:
        for k in LV:
            cells = []
            for i in inps:
                st = S[panel].get(f"{i}|{group}|{TL[T]}|{int(round(k * 100))}|{tgt}")
                if st is None:
                    cells.append("—")
                    continue
                if not st.get("estimable") or "R" not in st:
                    cells.append(f"HC (pos {st['pos']})")
                    continue
                cells.append(f"{ab[st['class']]} R {st['R'][0]:.2f} s {st['slope'][0]:.2f} [{st['slope'][1]:.2f},{st['slope'][2]:.2f}] "
                             f"e {st['bss_e_asof'][1]:+.3f} pos {st['pos']}")
            rows.append(f"| {TL[T]} {int(round(k * 100))}% | " + " | ".join(cells) + " |")
    return "\n".join(rows)


def cmd_tables(a):
    S = json.load(open(os.path.join(a.out, "score-r195.json")))
    txt = []
    for span in ("full", "2021"):
        for tgt in ("b", "a"):
            for g in ("ETHBTC", "LARGE"):
                txt.append(f"## main {span} target ({tgt}) {g}\n")
                txt.append(cell_table(S, f"main|{span}", MAIN, tgt, g))
                txt.append("")
    for pn in ("ebII", "ebV"):
        for span in ("full", "2021"):
            if f"{pn}|{span}" in S:
                for tgt in ("b", "a"):
                    txt.append(f"## {pn} {span} target ({tgt}) ETHBTC\n")
                    txt.append(cell_table(S, f"{pn}|{span}", ("I", "III", "IV", pn[2:]), tgt, "ETHBTC"))
                    txt.append("")
    open(os.path.join(a.out, "cells-r195.md"), "w").write("\n".join(txt) + "\n")
    print(f"wrote {len(txt)} blocks")


def cmd_secondary(a):
    """R19.5c secondary for one input: the R19.2 or1m form (line S (1 + k), S the Binance close at t; minimum of the
    1 h TWAP path over (t, t + T]; rows whose G(t) is already at or below the line dropped as imminent)."""
    import r193_regrade as G
    R = load_rows(a.out)
    U = universe()
    res = {"input": a.inp, "code": git_sha(), "cells": {}}
    for g, syms in (("ETHBTC", [e for e in U if e["symbol"] in ("ETHUSDT", "BTCUSDT")]),
                    ("LARGE", [e for e in U if e["symbol"] not in ("ETHUSDT", "BTCUSDT")])):
        grids = {}
        for e in syms:
            st, cb = load_grid(os.path.join(a.datasets, e["path"]))
            st3, c3 = load_grid(os.path.join(a.out, "grids", f"III-{e['symbol']}-1h.json.gz"))
            assert st3 == st
            grids[e["symbol"]] = (st, cb["close"], c3["low"], c3["close"])
        for T in TS_B:
            P, Y, TSs, SID, IMM = [], [], [], [], []
            for si, e in enumerate(syms):
                sym = e["symbol"]
                J = join(R, MAIN if a.inp in MAIN else MAIN + (a.inp,), sym, T)
                if J is None:
                    continue
                st, sb, l3, c3 = grids[sym]
                i0 = (J["ts"] - st) // STEP                       # bar opening at t
                ok = (i0 >= 1) & (i0 + T <= len(l3))
                ts, p = J["ts"][ok], J["p"][a.inp][ok]
                i0 = i0[ok]
                S_ = sb[i0 - 1]
                g0 = c3[i0 - 1]
                W = np.lib.stride_tricks.sliding_window_view(l3, T)[i0]
                wmin = np.where(np.isfinite(W).all(axis=1), W.min(axis=1), np.nan)
                lnk = np.log1p(np.array(L8))
                with np.errstate(invalid="ignore", divide="ignore"):
                    y = (np.log(wmin / S_)[:, None] <= lnk[None, :]).astype(np.int8)
                    imm = np.log(g0 / S_)[:, None] <= lnk[None, :]
                fin = np.isfinite(wmin) & np.isfinite(S_) & np.isfinite(g0)
                P.append(p[fin])
                Y.append(y[fin])
                IMM.append(imm[fin])
                TSs.append(ts[fin])
                SID.append(np.full(fin.sum(), si))
            P, Y, IMM, TSs, SID = map(np.concatenate, (P, Y, IMM, TSs, SID))
            blk = G.block_of(TSs, T)
            for jj, (j, k) in enumerate(zip(JL, LV)):
                m = ~IMM[:, j]
                yy = Y[m, j].astype(float)
                pe = G.asof_rate(TSs[m], T, yy)
                st_ = G.cell_stats(np.clip(P[m, j], 0, 1), pe, yy, SID[m], blk[m], time_only=(g == "ETHBTC"),
                                   B=B_BOOT, seed=300000 + 1000 * T + jj, pe=pe)
                st_["imminent_dropped"] = int((~m).sum())
                st_["class_note"] = "bss_a here uses the as-of (e) as the comparator (no plain history for this label)"
                res["cells"][f"{g}|{TL[T]}|{int(round(k * 100))}"] = st_
            print(now(), g, TL[T], flush=True)
    json.dump(res, open(os.path.join(a.out, f"secondary-or1m-{a.inp}.json"), "w"))


# =====================================================================================================================
# instrument checks
# =====================================================================================================================
def cmd_checks(a):
    import r16_dev as D
    D.init_btc(a.datasets)
    res = {"code": git_sha(), "utc": now()}
    # 1a look-ahead (truncation) on ETHUSDT for I-cc, III, IV
    cut = 1704067200                                          # 2024-01-01
    os.environ["R195_TMP"] = os.path.join(a.out, "tmp")
    os.makedirs(os.environ["R195_TMP"], exist_ok=True)
    S = {s_["key"]: s_ for s_ in specs_for(a.datasets, a.out)}
    la = {}
    for inp in ("I-cc", "III", "IV"):
        sp = S[f"{inp}|ETHUSDT"]
        _, full = row_task(sp)
        _, tr = row_task(sp, truncate_after=cut)
        mism, n = 0, 0
        for T in TS_B:
            f_, t_ = full[T], tr[T]
            keep = f_["ts"] + T * STEP <= cut - STEP
            kt = t_["ts"] + T * STEP <= cut - STEP
            ft, tt = f_["ts"][keep], t_["ts"][kt]
            common = np.intersect1d(ft, tt)
            n += len(common)
            mism += abs(len(ft) - len(tt))
            for c in ("y", "a", "fH"):
                A_ = f_[c][keep][np.searchsorted(ft, common)]
                B_ = t_[c][kt][np.searchsorted(tt, common)]
                mism += int((~((A_ == B_) | (np.isnan(A_.astype(float)) & np.isnan(B_.astype(float))))).any(axis=-1).sum()
                            if A_.ndim > 1 else (A_ != B_).sum())
        la[inp] = {"rows_compared": int(n), "mismatches": int(mism)}
    res["lookahead"] = la
    # 1b + 2a TWAP rule: independent pure-Python recomputation of the sampled hours
    tw = {"hours": 0, "max_rel": 0.0, "first_minute_rule": "G at minute m uses bars m-59..m; hour bar = minutes closing inside the hour"}
    for e in universe():
        M = json.load(open(os.path.join(a.out, "g1m", f"g1m-{e['symbol']}-meta.json")))
        for s_ in M["samples"]:
            c = s_["closes"]                        # minute slots j*60-59 .. j*60+59 (119 values)
            Gs = []
            for m in range(59, 119):                # G at the hour's 60 minutes (slot j*60 .. j*60+59)
                w = [math.log(x) for x in c[m - 59:m + 1] if x is not None]
                Gs.append(math.exp(sum(w) / len(w)) if len(w) >= 50 else None)
            if any(g is None for g in Gs):
                continue
            for nm, v in (("low", min(Gs)), ("high", max(Gs)), ("close", Gs[-1])):
                tw["max_rel"] = max(tw["max_rel"], abs(v / s_[nm] - 1))
            tw["hours"] += 1
    tw["pass"] = bool(tw["max_rel"] < 1e-9 and tw["hours"] >= 150)
    res["twap_rule"] = tw
    # 2b basis III vs V at hour ends
    bas = {}
    for sym in POOLS:
        fn = os.path.join(a.out, "uni", f"uni-{sym}.npz")
        if not os.path.exists(fn):
            continue
        Hend, twv = uni_twap(sym, a.out)
        Z = np.load(os.path.join(a.out, "g1m", f"g1m-{sym}.npz"))
        ix = np.searchsorted(Z["hour_ts"], Hend - STEP)
        ok = (ix < len(Z["hour_ts"])) & np.isfinite(twv[:, 0])
        ok[ok] &= Z["hour_ts"][ix[ok]] == Hend[ok] - STEP
        g = Z["gclose"][ix[ok]]
        b = np.log(g / twv[ok, 0])
        b = b[np.isfinite(b)]
        bas[sym] = {"hours": int(len(b)), "median_bp": float(np.median(b) * 1e4), "p01_bp": float(np.quantile(b, 0.01) * 1e4),
                    "p99_bp": float(np.quantile(b, 0.99) * 1e4), "mean_abs_bp": float(np.mean(np.abs(b)) * 1e4)}
    res["basis_III_vs_V"] = bas
    # 3a target (a) vs D12 golden
    gold = json.load(open(os.path.join(HERE, "live", "d12_golden.json")))
    R = load_rows(a.out)
    gm, gn = 0, 0
    inv = {v: k for k, v in TL.items()}
    for org, bysym in gold["rows"].items():
        ts = int(dt.datetime.strptime(org, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc).timestamp())
        for sym, byT in bysym.items():
            for tl, r in byT.items():
                d = R[("I", sym, inv[tl])]
                ix = int(np.searchsorted(d["ts"], ts))
                if ix >= len(d["ts"]) or d["ts"][ix] != ts:
                    continue
                gn += 1
                if "y" in r and list(map(int, r["y"])) != list(map(int, d["y"][ix])):
                    gm += 1
                elif not np.array_equal(np.asarray(r["fH"], np.float32), d["fH"][ix].astype(np.float32)) or \
                        not np.array_equal(np.asarray(r["a"], np.float32), d["a"][ix].astype(np.float32)):
                    gm += 1
    res["labels_vs_d12_golden"] = {"rows": gn, "mismatches": gm}
    # 3b target (b) recomputed from minute-G hour bars directly for 500 random rows
    rng = np.random.default_rng(SEED + 7)
    bm, bn = 0, 0
    syms = [e["symbol"] for e in universe()]
    for _ in range(500):
        sym = syms[rng.integers(len(syms))]
        T = TS_B[rng.integers(5)]
        d = R[("III", sym, T)]
        i = rng.integers(len(d["ts"]))
        ts = int(d["ts"][i])
        Z = np.load(os.path.join(a.out, "g1m", f"g1m-{sym}.npz"))
        h0 = int(np.searchsorted(Z["hour_ts"], ts))
        if h0 < 1 or h0 + T > len(Z["hour_ts"]) or Z["hour_ts"][h0] != ts:
            continue
        g0 = Z["gclose"][h0 - 1]
        wmin = np.min(Z["glow"][h0:h0 + T])
        if not (np.isfinite(g0) and np.isfinite(wmin)):
            continue
        y = (np.log(wmin / g0) <= np.log1p(np.array(L8))).astype(int)
        bn += 1
        bm += int((y != d["y"][i]).any())
    res["labels_b_recomputed"] = {"rows": bn, "mismatches": bm}
    json.dump(res, open(os.path.join(a.out, "checks-r195.json"), "w"), indent=1)
    print(json.dumps(res, indent=1))


# =====================================================================================================================
# synthetic known-answer: planted wicks
# =====================================================================================================================
def _syn_series(rng, nh, st, size_lo=3.0, size_hi=8.0, size_unit="minute", rate=(0.03, 0.03)):
    """one synthetic series: hourly GARCH(1,1) variance, Student-t (nu 5) minute shocks. Returns minute ln closes (clean),
    the clean hourly bars, wicked bars (intra-minute wicks, closes unchanged) and the minute ln closes with one-minute
    close spikes (reported variant)."""
    om_h = rng.uniform(0.004, 0.012) ** 2
    al, be = 0.08, 0.90
    w = om_h * (1 - al - be)
    z = rng.standard_t(5, (nh, 60)) * math.sqrt(3 / 5)
    zs = z.sum(axis=1)
    sm = np.empty(nh)
    h = om_h
    for j in range(nh):
        sm[j] = math.sqrt(h / 60.0)
        r = sm[j] * zs[j]
        h = w + al * r * r + be * h
    steps = z * sm[:, None]
    lc = math.log(100.0) + np.cumsum(steps.ravel())                     # minute ln closes
    prev = np.r_[math.log(100.0), lc[:-1]]
    ex_lo = np.abs(rng.normal(0, 0.5, nh * 60)) * np.repeat(sm, 60)
    ex_hi = np.abs(rng.normal(0, 0.5, nh * 60)) * np.repeat(sm, 60)
    mlo = (np.minimum(prev, lc) - ex_lo).reshape(nh, 60)
    mhi = (np.maximum(prev, lc) + ex_hi).reshape(nh, 60)
    c = lc.reshape(nh, 60)[:, -1]
    lo, hi = mlo.min(axis=1), mhi.max(axis=1)
    # registered wicks: 3% of hours, one minute's low (or high) extends 3-8 minute-sigma, closes unchanged
    half = nh // 2
    rt = np.r_[np.full(half, rate[0]), np.full(nh - half, rate[1])]
    wk = rng.random(nh) < rt
    q = rng.integers(0, 60, nh)
    size = rng.uniform(size_lo, size_hi, nh) * (sm if size_unit == "minute" else sm * math.sqrt(60.0))
    down = rng.random(nh) < 0.5
    pq = prev.reshape(nh, 60)[np.arange(nh), q]
    cq = lc.reshape(nh, 60)[np.arange(nh), q]
    lo_w = np.where(wk & down, np.minimum(lo, np.minimum(pq, cq) - size), lo)
    hi_w = np.where(wk & ~down, np.maximum(hi, np.maximum(pq, cq) + size), hi)
    # reported variant: the same wick hours, the wick minute's CLOSE is displaced (reverts next minute)
    lc_sp = lc.copy().reshape(nh, 60)
    disp = np.where(down, -size, size)
    lc_sp[np.arange(nh)[wk], q[wk]] += disp[wk]
    lc_sp = lc_sp.ravel()
    c_sp = lc_sp.reshape(nh, 60)[:, -1]
    lo_sp = np.minimum(lo_w, lc_sp.reshape(nh, 60).min(axis=1))
    hi_sp = np.maximum(hi_w, lc_sp.reshape(nh, 60).max(axis=1))
    return {"lc": lc, "c": c, "lo": lo, "hi": hi, "lo_w": lo_w, "hi_w": hi_w, "lc_sp": lc_sp, "c_sp": c_sp,
            "lo_sp": lo_sp, "hi_sp": hi_sp, "wick_hours": int(wk.sum())}


def cmd_synth(a):
    import r16_dev as D
    import a6_touch as A6
    import r192_borrower as B
    D.init_btc(a.datasets)
    VAR = {"registered": {}, "large": {"size_lo": 1.0, "size_hi": 4.0, "size_unit": "hour"},
           "ns": {"size_lo": 1.0, "size_hi": 4.0, "size_unit": "hour", "rate": (0.10, 0.01)}}[a.variant]
    sd = os.path.join(a.out, "synth" if a.variant == "registered" else f"synth-{a.variant}")
    os.makedirs(sd, exist_ok=True)
    rng = np.random.default_rng(SYN_SEED)
    nS, years = 20, 4
    nh = int(years * 365 * 24)
    st = 1514764800                                           # synthetic clock from 2018-01-01
    res = {"variant": a.variant, "params": VAR, "seed": SYN_SEED, "series": nS, "hours": nh, "inputs": {}, "inputs_close_spike": {}, "wick_hours": 0}
    specs = []
    for s in range(nS):
        X = _syn_series(rng, nh, st, **VAR)
        res["wick_hours"] += X["wick_hours"]
        P = {}
        for nm, (c, lo, hi) in {"clean": (X["c"], X["lo"], X["hi"]), "wick": (X["c"], X["lo_w"], X["hi_w"]),
                                "spike": (X["c_sp"], X["lo_sp"], X["hi_sp"])}.items():
            P[nm] = os.path.join(sd, f"{nm}-{s}.json.gz")
            write_grid(P[nm], st, np.exp(c), np.exp(lo), np.exp(hi), {"synthetic": nm})
        for nm, lc in (("twap_clean", X["lc"]), ("twap_spike", X["lc_sp"])):
            _, glo, ghi, gcl = hour_bars_from_G(minute_G(lc), st)
            P[nm] = os.path.join(sd, f"{nm}-{s}.json.gz")
            write_grid(P[nm], st, gcl, glo, ghi, {"synthetic": nm})
        specs.append(P)
    print(now(), "synthetic grids written", flush=True)

    def run(path, inp):
        orig = A6.har_of
        try:
            if inp in ("I-cc", "I-gk", "I-rs"):
                A6.har_of = _har_variant(inp[2:])
            r = B.task({"key": "syn", "kind": "grid", "path": path})
        finally:
            A6.har_of = orig
        R = r["rows"][24]
        m = R["ts"] % DAY == 0
        j10 = L8.index(-0.10)
        return np.exp(R["lsH"][m].astype(float)), R["fH"][m][:, j10].astype(float), R["ts"][m], R["y"][m][:, j10]

    truth = {}
    for si, P in enumerate(specs):
        _, _, tt, yt = run(P["twap_clean"], "III")
        truth[si] = (tt, yt)

    def ratio(inp, ka, kb):
        sc, sw, pc_, pw_, yb = [], [], [], [], []
        for si, P in enumerate(specs):
            a_s, a_p, ta, _ = run(P[ka], inp)
            b_s, b_p, tb, _ = run(P[kb], inp)
            tt, yt = truth[si]
            com = np.intersect1d(np.intersect1d(ta, tb), tt[yt >= 0])
            ia, ib, it = np.searchsorted(ta, com), np.searchsorted(tb, com), np.searchsorted(tt, com)
            ok = np.isfinite(a_s[ia]) & np.isfinite(b_s[ib]) & np.isfinite(a_p[ia]) & np.isfinite(b_p[ib])
            sc.append(a_s[ia][ok])
            sw.append(b_s[ib][ok])
            pc_.append(a_p[ia][ok])
            pw_.append(b_p[ib][ok])
            yb.append(yt[it][ok].astype(float))
        sc, sw, pc_, pw_, yb = map(np.concatenate, (sc, sw, pc_, pw_, yb))
        return {"rows": int(len(sc)), "sigmaH_ratio": float(sw.mean() / sc.mean()),
                "fH10_1d_ratio": float(pw_.mean() / pc_.mean()), "mean_fH10_clean": float(pc_.mean()),
                "R_b_clean": float(pc_.sum() / yb.sum()), "R_b_wicked": float(pw_.sum() / yb.sum()), "pos_b": int(yb.sum())}
    for inp in ("I", "I-cc", "I-gk", "I-rs", "III"):
        if inp == "III":
            res["inputs"][inp] = ratio(inp, "twap_clean", "twap_clean")   # registered wicks leave minute closes unchanged
            res["inputs"][inp]["note"] = "registered wicks are intra-minute, so the minute closes and III are identical"
            res["inputs_close_spike"][inp] = ratio(inp, "twap_clean", "twap_spike")
        else:
            res["inputs"][inp] = ratio(inp, "clean", "wick")
            res["inputs_close_spike"][inp] = ratio(inp, "clean", "spike")
        print(now(), inp, res["inputs"][inp], res["inputs_close_spike"][inp], flush=True)
    rob = [res["inputs"][i] for i in ("I-cc", "III")]
    res["pass_robust"] = bool(all(0.97 <= r_["sigmaH_ratio"] <= 1.03 and 0.97 <= r_["fH10_1d_ratio"] <= 1.03 for r_ in rob))
    res["positive_control_I"] = bool(res["inputs"]["I"]["sigmaH_ratio"] > 1.05)
    json.dump(res, open(os.path.join(a.out, f"synth-r195-{a.variant}.json"), "w"), indent=1)
    print(json.dumps(res, indent=1))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd")
    ap.add_argument("--out", required=True)
    ap.add_argument("--datasets")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--syms")
    ap.add_argument("--venues", default="coinbase,okx,bitfinex,bitstamp")
    ap.add_argument("--variant", default="registered", choices=("registered", "large", "ns"))
    ap.add_argument("--inp", default="III")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    {"acq1m": cmd_acq1m, "venues": cmd_venues, "uni": cmd_uni, "grids": cmd_grids, "rows": cmd_rows,
     "score": cmd_score, "tables": cmd_tables, "secondary": cmd_secondary, "checks": cmd_checks, "synth": cmd_synth}[a.cmd](a)


if __name__ == "__main__":
    main()
