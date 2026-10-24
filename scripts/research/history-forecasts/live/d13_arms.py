"""Q26 live forecast log -- D13-A1: ETH/BTC input-comparison arms on target (b). REPORT ONLY.

membrane-board design/HISTORY_TOUCH_LIVE.md D13-A1 (registered before its first origin; deployment note under it).
Both arms are secondary. They never change a D13 class, never route in the UI router and never lower the odds. The
primary (input III, target (b)) is q26_live_d13.py and is not changed by this file. Each arm writes only
forecasts/q26-touch-live/d13/arms/.

Arm C (Chainlink input). raw (fH) (q26_live_d12.series_origin = r192_borrower.task at one origin) on hourly bars of the
ETH/USD and BTC/USD Chainlink rounds, built exactly as the development price-history oracle columns (close = the round
in force at the hour end, bucketed by updatedAt; low/high include the round in force at the hour start while it is at
most 48 h old; forward fill to 48 h; prices rounded to 2 decimals as Math.round). Hours before C_GRID_END come from the
frozen development grid (the R19.5 input II series, exported unchanged by d13a1_build.py). Later hours come from the arm
round store d13/arms/C/rounds/ (getRoundData walking, keyless; the same reader as the touch-live job, q26_live_common
.Feed). Splice check: the store's bars equal the development bars on the overlap hours, bit for bit.
Arm V (Uniswap V3 pool TWAP input). The R19.5 input-V construction: WETH/USDC 0.05% and WBTC/USDC 0.3%; TWAP(t) =
1.0001^floor(mean tick over [t - 3600, t]) at 10-minute points; hour bar close = the TWAP at the hour end, low/high over
the hour's six points. Hours before V_GRID_END come from the frozen R19.5 V grid. Later hours come from the arm pool
store d13/arms/V/obs/: one archive eth_call of observe() per hour end H at a block with timestamp >= H (13 points,
600 s apart), keyless, batched, inside the daily run (a daily batch: a single latest-block read does not reach back a
day for WETH/USDC). A one-time runner probe (checks/probe.json) gates the arm.
Truth: the D13 primary's target-(b) label of the same series and origin (read from the D13 outcome line named by the
D13 ledger). Monitor: the D13.3 rule (q26_live_d12.monitor_step) on the 35 ETHBTC cells and the 5 ETHBTC pooled units,
with v0 and the climatology refit on the arm's development rows (d13a1_universe.json).
No address, key or secret is read or written. Public endpoints only.
"""
from __future__ import annotations

import gzip
import json
import math
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import q26_live_common as C  # noqa: E402
import q26_live_d12 as L12  # noqa: E402  (imported, never modified)
import q26_live_d13 as L  # noqa: E402  (the primary; read only)

HOUR, DAY = C.HOUR, C.DAY
ARMS = ("C", "V")
ARMS_SUB = os.path.join("d13", "arms")
SCHEMA = "q26-touch-live/d13a1/1"
PREREG = {"repo": "triccs/membrane-board", "path": "design/HISTORY_TOUCH_LIVE.md", "deviation": "D13-A1",
          "note": "report only; never changes a D13 class, never routes, never lowers the odds"}
FIRST_ORIGIN = C.A.utc("2026-10-25T00:00:00Z")        # the first daily origin after the D13-A1 pin
SYMS = ("ETHUSDT", "BTCUSDT")
GROUP = "ETHBTC"
TS, TL, L8, LV = L.TS, L.TL, L.L8, L.LV

# Arm C
C_GRID_END = C.DATA_END                               # 2026-10-06T03:00Z: development oracle columns end here
C_STORE_START = C.A.utc("2026-10-03T00:00:00Z")       # the store holds the round in force here and every later round
C_SPLICE_FROM = C_STORE_START + 3 * HOUR              # splice check hours [C_SPLICE_FROM, C_GRID_END)
C_MAX_STALE = 48 * HOUR                               # price-history maxStaleHours (ETH/USD, BTC/USD)
C_FEED = {"ETHUSDT": "ETH", "BTCUSDT": "BTC"}
C_RPC_URLS = ("https://rpc.mevblocker.io", "https://eth.drpc.org")

# Arm V
V_GRID_END = C.A.utc("2026-10-06T00:00:00Z")          # R19.5 pool reads end at the hour end 2026-10-06T00:00Z
V_STORE_START = C.A.utc("2026-10-04T00:00:00Z")       # first stored hour end H
V_SAFE = 600                                          # only hour ends at least 10 minutes before the head block
V_MAX_HOURS = 24 * 40                                 # hour ends read per run at most
V_POOLS = {"ETHUSDT": {"addr": "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640", "name": "WETH/USDC 0.05%",
                       "dec0": 6, "dec1": 18, "base_is": 1},
           "BTCUSDT": {"addr": "0x99ac8cA7087fA4A2A1FB6357269965A2014ABc35", "name": "WBTC/USDC 0.3%",
                       "dec0": 8, "dec1": 6, "base_is": 0}}
V_RPC_URLS = ("https://rpc.mevblocker.io", "https://eth.drpc.org")
V_HEADER = ["hourEnd", "block", "blockTs", "err"] + [f"tc{q}" for q in range(13)]
SEL_OBSERVE = "883bdbfd"
SEL_SLOT0 = "3850c7bd"
SEL_OBSERVATIONS = "252c09d7"


# =====================================================================================================================
# paths, universe
# =====================================================================================================================
def adir(ldir, arm):
    return os.path.join(ldir, ARMS_SUB, arm)


def universe_path():
    return os.path.join(HERE, "d13a1_universe.json")


def golden_path():
    return os.path.join(HERE, "d13a1_golden.json")


def load_universe():
    with open(universe_path()) as f:
        return json.load(f)


def check_inputs(UA, datasets, arm):
    for e in UA["arms"][arm]["series"]:
        p = os.path.join(datasets, e["gridPath"])
        if not os.path.exists(p) or C.sha256_file(p) != e["gridSha256"]:
            raise SystemExit(f"STOP: d13 arm {arm} development grid missing or sha256 mismatch for {e['symbol']}")


def entry_of(UA, arm, sym):
    return [e for e in UA["arms"][arm]["series"] if e["symbol"] == sym][0]


# =====================================================================================================================
# arm C: Chainlink rounds -> price-history oracle columns
# =====================================================================================================================
def js_round2(x):
    """price-history round(x, 2) = Math.round(x * 100) / 100 (ties toward +infinity); None if not finite."""
    if x is None or not math.isfinite(x):
        return None
    y = x * 100
    f = math.floor(y)
    return (f + 1 if (y - f) >= 0.5 else f) / 100


def c_columns(rounds, asset, h0, n):
    """price-history oracleColumns on hours h0 .. h0 + (n - 1) h from rounds in proxy order (round id order)."""
    dec = C.FEEDS[asset][1]
    hours = {}
    for r in rounds:
        if r.answer <= 0:
            continue
        p = r.answer / 10 ** dec
        h = r.updated_at // HOUR * HOUR
        cur = hours.get(h)
        if cur is None:
            hours[h] = [p, p, p]
        else:
            cur[0] = p
            cur[1] = min(cur[1], p)
            cur[2] = max(cur[2], p)
    close, low, high = (np.full(n, np.nan) for _ in range(3))
    pre = sorted(k for k in hours if k < h0)
    in_force, in_hour = (hours[pre[-1]][0], pre[-1]) if pre else (None, None)
    for i in range(n):
        ts = h0 + i * HOUR
        x = hours.get(ts)
        fresh = in_force is not None and ts - in_hour <= C_MAX_STALE
        if x is not None:
            last, lo, hi = x
            low[i] = js_round2(min(in_force, lo) if fresh else lo)
            high[i] = js_round2(max(in_force, hi) if fresh else hi)
            close[i] = js_round2(last)
            in_force, in_hour = last, ts
        elif fresh:
            close[i] = low[i] = high[i] = js_round2(in_force)
    return close, low, high


def c_store_path(ldir, sym):
    return os.path.join(adir(ldir, "C"), "rounds", C.STORE_NAME[C_FEED[sym]] + ".csv.gz")


def c_coverage(ldir, sym):
    cov = 0
    for e in C.read_fetch_log(os.path.join(adir(ldir, "C"), "rounds", "fetch-log.jsonl")):
        if e.get("symbol") == sym and e.get("coveredThrough"):
            cov = max(cov, int(e["coveredThrough"]))
    return cov


def update_c_store(rpc, ldir, sym, head, clock=time.time):
    """Append every round printed since the last stored round (bootstrap: the round in force at C_STORE_START and every
    later round). Every read is pinned to block `head`: the store is complete through head's timestamp."""
    asset = C_FEED[sym]
    path = c_store_path(ldir, sym)
    existing = C.read_round_store(path)
    feed = C.Feed(rpc, C.FEEDS[asset][0], block=hex(head[0]))
    latest = feed.latest()
    if latest.updated_at > head[1]:
        raise C.RpcError(f"{asset}: latest round after its block")
    if existing:
        new, mode = feed.rounds_after(existing[-1], latest), "append"
    else:
        new, mode = feed.rounds_from(C_STORE_START, latest), "bootstrap"
    n = C.append_rounds(path, new, existing)
    C.append_fetch_log(os.path.join(adir(ldir, "C"), "rounds", "fetch-log.jsonl"),
                       {"kind": "d13a1-chainlink", "symbol": sym, "mode": mode, "fetchedAt": int(clock()),
                        "block": head[0], "coveredThrough": head[1], "appended": n,
                        "storeRounds": len(existing) + n})
    return n


def c_store_bars(ldir, sym, upto):
    """Store bars for hours C_STORE_START .. upto - 1 h; hours not covered by the store's fetch log are NaN."""
    rounds = C.read_round_store(c_store_path(ldir, sym))
    n = max(0, (upto - C_STORE_START) // HOUR)
    if not rounds or n == 0:
        return tuple(np.full(n, np.nan) for _ in range(3))
    cl, lo, hi = c_columns(rounds, C_FEED[sym], C_STORE_START, n)
    cov = c_coverage(ldir, sym)
    for i in range(n):
        if C_STORE_START + (i + 1) * HOUR > cov:
            cl[i] = lo[i] = hi[i] = np.nan
    return cl, lo, hi


# =====================================================================================================================
# arm V: Uniswap V3 observe() at hour ends -> R19.5 input-V bars
# =====================================================================================================================
def enc_observe(secs):
    return "0x" + SEL_OBSERVE + f"{32:064x}" + f"{len(secs):064x}" + "".join(f"{s:064x}" for s in secs)


def dec_observe(hexdata, n):
    b = bytes.fromhex(hexdata[2:])
    w = [b[i:i + 32] for i in range(0, len(b), 32)]
    off = int.from_bytes(w[0], "big") // 32
    cnt = int.from_bytes(w[off], "big")
    return [int.from_bytes(w[off + 1 + i], "big", signed=True) for i in range(cnt)][:n]


def v_store_path(ldir, sym):
    return os.path.join(adir(ldir, "V"), "obs", sym + ".csv.gz")


def read_v_store(path):
    rows = C.read_gz_csv(path, V_HEADER)
    prev = None
    for r in rows:
        h = int(r[0])
        if h % HOUR or (prev is not None and h != prev + HOUR):
            raise SystemExit(f"STOP: {path}: hour ends not consecutive at {h}")
        prev = h
    return rows


def _block_ts(rpc, blocks):
    res = rpc.request_many("eth_getBlockByNumber", [[hex(b), False] for b in blocks])
    out = {}
    for b, blk in zip(blocks, res):
        if not isinstance(blk, dict) or "timestamp" not in blk:
            raise C.RpcError("eth_getBlockByNumber returned no block")
        out[b] = int(blk["timestamp"], 16)
    return out


def find_blocks(rpc, hs, head):
    """{H: (block, timestamp)} with timestamp >= H for each hour end H (post-merge 12 s slots: one estimate, one
    forward correction, then +1 block until the timestamp reaches H)."""
    hb, hts = head
    cur = {H: hb - (hts - H) // 12 for H in hs}
    for _ in range(12):
        todo = sorted({b for b in cur.values()})
        tsm = _block_ts(rpc, todo)
        bad = [H for H in hs if tsm[cur[H]] < H]
        if not bad:
            return {H: (cur[H], tsm[cur[H]]) for H in hs}
        for H in bad:
            cur[H] = min(hb, cur[H] + max(1, -(-(H - tsm[cur[H]]) // 12)))
    raise C.RpcError("no block at or after an hour end")


def update_v_store(rpc, ldir, head, clock=time.time):
    """Append the 13 tick cumulatives (H - 600 q, q = 0..12) of each pool for every new hour end H <= head - V_SAFE."""
    last = {}
    for sym in SYMS:
        rows = read_v_store(v_store_path(ldir, sym))
        last[sym] = int(rows[-1][0]) if rows else V_STORE_START - HOUR
    h_end = (head[1] - V_SAFE) // HOUR * HOUR
    h0 = min(last.values()) + HOUR
    hs = list(range(h0, h_end + 1, HOUR))[:V_MAX_HOURS]
    out = {}
    if not hs:
        return {s: 0 for s in SYMS}
    blk = find_blocks(rpc, hs, head)
    for sym in SYMS:
        P = V_POOLS[sym]
        mine = [H for H in hs if H > last[sym]]
        params = [[{"to": P["addr"], "data": enc_observe([blk[H][1] - H + 600 * q for q in range(13)])}, hex(blk[H][0])]
                  for H in mine]
        res = rpc.request_many("eth_call", params) if params else []
        new = []
        for H, r in zip(mine, res):
            if isinstance(r, str) and r.startswith("0x") and len(r) > 10:
                tc = dec_observe(r, 13)
                new.append([str(H), str(blk[H][0]), str(blk[H][1]), "0"] + [str(v) for v in tc])
            else:
                new.append([str(H), str(blk[H][0]), str(blk[H][1]), "1"] + [""] * 13)
        path = v_store_path(ldir, sym)
        existing = os.path.exists(path)
        if new:
            C.append_bytes(path, C.gz_member(None if existing else V_HEADER, new))
        C.append_fetch_log(os.path.join(adir(ldir, "V"), "obs", "fetch-log.jsonl"),
                           {"kind": "d13a1-observe", "symbol": sym, "fetchedAt": int(clock()), "head": head[0],
                            "appended": len(new), "errors": sum(x[3] == "1" for x in new),
                            "lastHourEnd": int(new[-1][0]) if new else last[sym]})
        out[sym] = len(new)
    return out


def v_twap(tc, P):
    """R19.5 uni_twap on an (n, 13) float array of tick cumulatives at H - 600 q: -> (n, 7) TWAP ending at H - 600 j."""
    tw = np.full((tc.shape[0], 7), np.nan)
    for j in range(7):
        d = tc[:, j] - tc[:, j + 6]
        mt = np.floor(d / 3600.0)
        raw = np.power(1.0001, mt)
        if P["base_is"] == 1:
            tw[:, j] = 10.0 ** (P["dec1"] - P["dec0"]) / raw
        else:
            tw[:, j] = raw * 10.0 ** (P["dec0"] - P["dec1"])
    return tw


def round10(x):
    return np.array([np.nan if not np.isfinite(v) else float(f"{v:.10g}") for v in x], float)


def v_store_bars(ldir, sym, upto):
    """Store bars for the hours opening V_STORE_START - 1 h .. upto - 1 h (hour end H = open + 1 h); NaN if not read."""
    rows = read_v_store(v_store_path(ldir, sym))
    h_first = V_STORE_START - HOUR
    n = max(0, (upto - h_first) // HOUR)
    cl, lo, hi = (np.full(n, np.nan) for _ in range(3))
    if not rows or n == 0:
        return cl, lo, hi
    tc = np.full((len(rows), 13), np.nan)
    for i, r in enumerate(rows):
        if r[3] == "0":
            tc[i] = [int(v) for v in r[4:17]]
    tw = v_twap(tc, V_POOLS[sym])
    c5 = tw[:, 0]
    with np.errstate(invalid="ignore"):
        l5 = np.nanmin(np.where(np.isfinite(tw[:, :6]), tw[:, :6], np.inf), axis=1)
        h5 = np.nanmax(np.where(np.isfinite(tw[:, :6]), tw[:, :6], -np.inf), axis=1)
    okv = np.isfinite(tw[:, :6]).all(axis=1)
    c5, l5, h5 = (np.where(okv, x, np.nan) for x in (c5, l5, h5))
    c5, l5, h5 = round10(c5), round10(l5), round10(h5)
    for i, r in enumerate(rows):
        j = (int(r[0]) - HOUR - h_first) // HOUR
        if 0 <= j < n:
            cl[j], lo[j], hi[j] = c5[i], l5[i], h5[i]
    return cl, lo, hi


def v_last_hour_end(ldir, sym):
    rows = read_v_store(v_store_path(ldir, sym))
    return int(rows[-1][0]) if rows else 0


def v_probe(rpc_urls=V_RPC_URLS, post=None, clock=time.time):
    """Runner probe (recorded once). Latest-block reach of each pool's observation buffer, and one archive read per pool
    at a block about 26 h back. -> record (counts, spans, timing; no secret)."""
    t0 = clock()
    rpc = C.RpcClient(urls=rpc_urls, post=post, max_calls=400, max_batch={u: 50 for u in rpc_urls})
    head = rpc.head()
    rec = {"head": head[0], "headTs": head[1], "pools": {}}
    for sym, P in V_POOLS.items():
        p = {"pool": P["name"]}
        s0 = rpc.eth_call_many([(P["addr"], SEL_SLOT0)], block=hex(head[0]))[0]
        if s0 is not C.REVERTED and len(s0) >= 128:
            w = [int.from_bytes(s0[32 * i:32 * (i + 1)], "big") for i in range(4)]
            idx, card = w[2], w[3]
            p["cardinality"] = card
            ob = rpc.eth_call_many([(P["addr"], SEL_OBSERVATIONS + f"{(idx + 1) % max(card, 1):064x}")],
                                   block=hex(head[0]))[0]
            if ob is not C.REVERTED and len(ob) >= 128 and int.from_bytes(ob[96:128], "big"):
                p["oldestObservationAgeH"] = round((head[1] - int.from_bytes(ob[0:32], "big")) / HOUR, 1)
        spans = {}
        for hrs in (2, 6, 12, 25):
            r = rpc.eth_call_many([(P["addr"], enc_observe([600 * q for q in range(hrs * 6 + 7)])[2:])],
                                  block=hex(head[0]))[0]
            spans[f"{hrs}h"] = r is not C.REVERTED
        p["latestBlockLookback"] = spans
        H = (head[1] - 26 * HOUR) // HOUR * HOUR
        try:
            b = find_blocks(rpc, [H], head)[H]
            r = rpc.request_many("eth_call", [[{"to": P["addr"], "data": enc_observe(
                [b[1] - H + 600 * q for q in range(13)])}, hex(b[0])]])[0]
            p["archiveRead26h"] = isinstance(r, str) and r.startswith("0x") and len(r) > 10
        except C.RpcError as ex:
            p["archiveRead26h"] = False
            p["archiveError"] = type(ex).__name__
        rec["pools"][sym] = p
    rec["latestBlockMode"] = all(v["latestBlockLookback"]["25h"] for v in rec["pools"].values())
    rec["archiveMode"] = all(v["archiveRead26h"] for v in rec["pools"].values())
    rec["mode"] = ("latest-block observe once per run" if rec["latestBlockMode"] else
                   "per-hour archive observe reads, once per run (daily batch)" if rec["archiveMode"] else "deferred")
    rec["pass"] = bool(rec["archiveMode"])
    rec["seconds"] = round(clock() - t0, 1)
    rec["rpc"] = {"calls": rpc.calls}
    return rec


# =====================================================================================================================
# arm grids at an origin
# =====================================================================================================================
def arm_grid(arm, UA, datasets, ldir, sym, upto):
    """III-like dict (close, low, high) of hours st .. upto - 1 h: frozen development grid, then store bars."""
    e = entry_of(UA, arm, sym)
    st, cols = L12.read_dev_grid(os.path.join(datasets, e["gridPath"]))
    n = (upto - st) // HOUR
    out = {c: np.full(n, np.nan) for c in ("close", "low", "high")}
    gend = C_GRID_END if arm == "C" else V_GRID_END
    n_dev = min(n, (gend - st) // HOUR, len(cols["close"]))
    for c in out:
        out[c][:n_dev] = cols[c][:n_dev]
    if ldir is not None and upto > gend:
        if arm == "C":
            cl, lo, hi = c_store_bars(ldir, sym, upto)
            s0 = C_STORE_START
        else:
            cl, lo, hi = v_store_bars(ldir, sym, upto)
            s0 = V_STORE_START - HOUR
        for jj in range(len(cl)):
            j = (s0 - st) // HOUR + jj
            if n_dev <= j < n:
                out["close"][j], out["low"][j], out["high"][j] = cl[jj], lo[jj], hi[jj]
    return st, cols, out


def splice_check(arm, UA, datasets, ldir, sym):
    """Store bars equal the development grid bit for bit on every overlap hour (null pattern included)."""
    e = entry_of(UA, arm, sym)
    st, cols = L12.read_dev_grid(os.path.join(datasets, e["gridPath"]))
    if arm == "C":
        cl, lo, hi = c_store_bars(ldir, sym, C_GRID_END)
        s0, a_, b_ = C_STORE_START, C_SPLICE_FROM, C_GRID_END
    else:
        cl, lo, hi = v_store_bars(ldir, sym, V_GRID_END)
        s0, a_, b_ = V_STORE_START - HOUR, V_STORE_START - HOUR, V_GRID_END
    n_eq, n_cmp, n_val = 0, 0, 0
    for h in range(a_, b_, HOUR):
        jj, jg = (h - s0) // HOUR, (h - st) // HOUR
        for c, v in (("close", cl[jj]), ("low", lo[jj]), ("high", hi[jj])):
            g = cols[c][jg]
            n_cmp += 1
            same = (not np.isfinite(v) and not np.isfinite(g)) or (np.isfinite(v) and v == g)
            n_eq += int(same)
            n_val += int(np.isfinite(v))
    ok = n_cmp > 0 and n_eq == n_cmp and n_val >= 0.9 * n_cmp
    return ok, {"valuesCompared": n_cmp, "valuesEqual": n_eq, "valuesFinite": n_val}


def compute(arm, UA, datasets, ldir, sym, origin):
    try:
        st, _, g = arm_grid(arm, UA, datasets, ldir, sym, origin)
        return L12.series_origin(entry_of(UA, arm, sym)["key"], st, g, origin)
    except Exception as ex:  # noqa: BLE001  (one series failing never stops the arm)
        return None, f"error {type(ex).__name__}: {str(ex)[:160]}"


# =====================================================================================================================
# golden replay (CI record per arm, once; quick check every run)
# =====================================================================================================================
def golden_compare(arm, UA, datasets, origins=None, syms=SYMS):
    G = json.load(open(golden_path()))["rows"][arm]
    n_cmp, n_eq, bad = 0, 0, []
    for oi in (origins or L.REPLAY_ORIGINS):
        t = C.A.utc(oi)
        for sym in syms:
            gd = G.get(oi, {}).get(sym) or {}
            if not gd:
                continue
            res, why = compute(arm, UA, datasets, None, sym, t)
            for T in TS:
                g = gd.get(TL[T])
                if g is None:
                    continue
                n_cmp += 1
                ok = res is not None and all(np.array_equal(np.asarray(res["T"][T][nm], np.float32),
                                                            np.asarray(g[nm], np.float32)) for nm in ("fH", "a"))
                n_eq += int(ok)
                if not ok:
                    bad.append([oi, sym, TL[T]])
    return n_cmp, n_eq, bad


def ensure_ci(arm, a, UA, ldir, log=print):
    p = os.path.join(adir(ldir, arm), "checks", "ci-replay.json")
    if os.path.exists(p):
        return json.load(open(p))
    if C.sha256_file(golden_path()) != UA["goldenSha256"]:
        raise SystemExit(f"STOP: d13 arm {arm} golden file sha256 mismatch")
    n_cmp, n_eq, bad = golden_compare(arm, UA, a.datasets)
    rec = {"arm": arm, "compared": n_cmp, "rowsEqual": n_eq, "mismatches": bad[:20], "pass": n_cmp > 0 and n_eq == n_cmp,
           "goldenSha256": C.sha256_file(golden_path()), "python": sys.version.split()[0], "numpy": np.__version__,
           "code": a.code, "recordedAt": C.iso(int(time.time()))}
    C.write_exclusive(p, C.dumps(rec))
    log(f"d13 arm {arm} replay: {n_eq} of {n_cmp} rows equal")
    return rec


# =====================================================================================================================
# stores, splice, probe (every run)
# =====================================================================================================================
def update_stores(arm, ldir, clock=time.time, rpc=None):
    if arm == "C":
        rpc = rpc or C.RpcClient(urls=C_RPC_URLS, max_calls=6000, max_batch={u: 50 for u in C_RPC_URLS})
        head = rpc.head()
        return {s: update_c_store(rpc, ldir, s, head, clock=clock) for s in SYMS}
    rpc = rpc or C.RpcClient(urls=V_RPC_URLS, max_calls=8000, max_batch={u: 50 for u in V_RPC_URLS})
    return update_v_store(rpc, ldir, rpc.head(), clock=clock)


def splice_status(arm, UA, datasets, ldir):
    p = os.path.join(adir(ldir, arm), "checks", "splice.json")
    rec = json.load(open(p)) if os.path.exists(p) else {}
    changed = False
    for sym in SYMS:
        if sym in rec:
            continue
        gend = C_GRID_END if arm == "C" else V_GRID_END
        covered = (c_coverage(ldir, sym) >= gend) if arm == "C" else (v_last_hour_end(ldir, sym) >= gend)
        if not covered:
            continue
        ok, det = splice_check(arm, UA, datasets, ldir, sym)
        rec[sym] = {"pass": bool(ok), **det}
        changed = True
    if changed:
        C.write_atomic(p, C.dumps(rec))
    return rec


def probe_status(ldir, log=print, probe=None):
    p = os.path.join(adir(ldir, "V"), "checks", "probe.json")
    if os.path.exists(p):
        return json.load(open(p))
    rec = (probe or v_probe)()
    rec["recordedAt"] = C.iso(int(time.time()))
    C.write_exclusive(p, C.dumps(rec))
    n25 = sum(v["latestBlockLookback"]["25h"] for v in rec["pools"].values())
    nar = sum(v["archiveRead26h"] for v in rec["pools"].values())
    log(f"d13 arm V probe: latest-block 25 h reach {n25} of 2 pools, archive reads {nar} of 2 pools")
    return rec


# =====================================================================================================================
# issue
# =====================================================================================================================
def issue_dir(ldir, arm):
    return os.path.join(adir(ldir, arm), "issues")


def list_issues(ldir, arm):
    d = issue_dir(ldir, arm)
    if not os.path.isdir(d):
        return []
    return sorted(n for n in os.listdir(d) if n.endswith(".json.gz") and len(n) == len("YYYY-MM-DD.json.gz"))


def read_issue(ldir, arm, name):
    with open(os.path.join(issue_dir(ldir, arm), name), "rb") as f:
        raw = f.read()
    return json.loads(gzip.decompress(raw)), C.sha256_bytes(raw)


def verify_issue_chain(ldir, arm):
    prev = C.ZERO_SHA
    for n in list_issues(ldir, arm):
        doc, sha = read_issue(ldir, arm, n)
        if doc.get("prevSha256") != prev or doc.get("date") != n[:10]:
            raise SystemExit(f"STOP: d13 arm {arm} issue chain broken at {n}")
        prev = sha
    return prev


def store_covers(arm, ldir, sym, t):
    return (c_coverage(ldir, sym) >= t) if arm == "C" else (v_last_hour_end(ldir, sym) >= t)


def issue_arm(arm, a, UA, now, spl, log=print):
    ldir = C.live_dir(a.out)
    origin = now - now % DAY
    if origin < FIRST_ORIGIN:
        log(f"d13 arm {arm} issue: none (before the first origin)")
        return
    if now >= origin + L.MAX_LATE:
        log(f"d13 arm {arm} issue: none (late run)")
        return
    name = C.utc_date(origin) + ".json.gz"
    names = list_issues(ldir, arm)
    if name in names:
        log(f"d13 arm {arm} issue: none (origin already issued)")
        return
    if names and names[-1] > name:
        raise SystemExit(f"STOP: d13 arm {arm} a later issue file exists")
    prev = verify_issue_chain(ldir, arm)
    series = []
    for sym in SYMS:
        row = {"symbol": sym, "group": GROUP}
        why = None
        if not spl.get(sym, {}).get("pass"):
            why = "store splice check not passed"
        elif not store_covers(arm, ldir, sym, origin):
            why = "store not read through the origin"
        if why is None:
            res, why = compute(arm, UA, a.datasets, ldir, sym, origin)
        if why is not None:
            row.update({"issued": False, "why": why})
        else:
            row.update({"issued": True, "S": res["S"],
                        "fH": {TL[T]: L.f32(res["T"][T]["fH"]) for T in TS},
                        "f": {TL[T]: L.f32(res["T"][T]["f"]) for T in TS},
                        "a": {TL[T]: L.f32(res["T"][T]["a"]) for T in TS},
                        "fHfallback": {TL[T]: res["T"][T]["fallback"] for T in TS}})
        series.append(row)
    n_iss = sum(r["issued"] for r in series)
    doc = {"schema": SCHEMA, "prereg": PREREG, "arm": arm, "display": "report only; never shown, never routes",
           "target": L.TARGET, "date": C.utc_date(origin), "origin": origin, "originIso": C.iso(origin),
           "issuedAt": now, "issuedAtIso": C.iso(now), "code": a.code, "levels": list(L8),
           "universeSha256": C.sha256_file(universe_path()), "prevSha256": prev, "nIssued": n_iss, "series": series}
    C.write_exclusive(os.path.join(issue_dir(ldir, arm), name), L.gz_json(doc))
    log(f"d13 arm {arm} issue: {n_iss} series issued, {len(series) - n_iss} not issued")


# =====================================================================================================================
# score (truth = the D13 primary's target-(b) label, read from the D13 outcome line named by the D13 ledger)
# =====================================================================================================================
def arm_units():
    return [u for u in L.monitor_units() if u[3] == GROUP]


def initial_state():
    st = {L.gkey(T, k, GROUP): L12.new_group_state(T, L.default_class(GROUP, T, k)) for (T, k) in L.CELLS}
    for T in TS:
        st[L.pkey(T, GROUP)] = L12.new_group_state(T, "pooled monitor")
    return st


def ledger_path(ldir, arm):
    return os.path.join(adir(ldir, arm), "ledger.jsonl")


def read_ledger(ldir, arm):
    p = ledger_path(ldir, arm)
    out, prev = [], C.ZERO_SHA
    if not os.path.exists(p):
        return out, prev
    with open(p, "rb") as f:
        for raw in f.read().splitlines(keepends=True):
            if not raw.strip():
                continue
            d = json.loads(raw)
            if d.get("prevSha256") != prev:
                raise SystemExit(f"STOP: d13 arm {arm} ledger hash chain broken")
            prev = C.sha256_bytes(raw)
            out.append(d)
    return out, prev


def outcomes_path(ldir, arm, origin):
    return os.path.join(adir(ldir, arm), "outcomes", f"outcomes-{C.utc_date(origin)[:7]}.jsonl")


def read_outcomes(ldir, arm):
    d = os.path.join(adir(ldir, arm), "outcomes")
    out = {}
    if os.path.isdir(d):
        for n in sorted(os.listdir(d)):
            with open(os.path.join(d, n), "rb") as f:
                for raw in f.read().splitlines(keepends=True):
                    if raw.strip():
                        out[C.sha256_bytes(raw)] = json.loads(raw)
    return out


def primary_truth(ldir):
    """{(origin, T label): {symbol: y list or None}} from the D13 ledger and the outcome lines it names."""
    led, _ = L.read_ledger(ldir)
    outs = L.read_outcomes(ldir)
    tr = {}
    for d_ in led:
        o = outs.get(d_["outcomeSha256"])
        if o is None:
            continue
        tr[(d_["origin"], d_["T"])] = {r["symbol"]: r.get("y") for r in o["series"]}
    return tr


def effective_classes(state):
    out = {}
    for T in TS:
        for k in sorted(LV, reverse=True):
            cls = L.default_class(GROUP, T, k)
            units = [u for u in (L.gkey(T, k, GROUP), L.pkey(T, GROUP) if k in L.POOL_LV else None) if u]
            if any(state[u]["downgraded"] for u in units) and cls in (L.CLASS_WARN, "SKILL"):
                cls = L.CLASS_DOWN
            out[f"{GROUP} {TL[T]} {int(round(k * 100))}%"] = cls
    return out


def score_arm(arm, a, UA, now, log=print):
    ldir = C.live_dir(a.out)
    verify_issue_chain(ldir, arm)
    names = list_issues(ldir, arm)
    led, prev = read_ledger(ldir, arm)
    outs = read_outcomes(ldir, arm)
    for d_ in led:
        o = outs.get(d_["outcomeSha256"])
        if o is None or o["origin"] != d_["origin"] or o["T"] != d_["T"]:
            raise SystemExit(f"STOP: d13 arm {arm} outcome line named by the ledger is missing")
    done = {(d_["origin"], d_["T"]) for d_ in led}
    state = led[-1]["state"] if led else initial_state()
    hist = {u[0]: [] for u in arm_units()}
    for d_ in led:
        for gk, m in d_["groups"].items():
            if m.get("observed"):
                hist[gk].append((d_["dayIndex"], m["XA"], m["XB"]))
    v0, clim = UA["arms"][arm]["v0"], UA["arms"][arm]["climatology"]
    truth = primary_truth(ldir)
    docs, n_fin, n_pend = {}, 0, 0
    for T in TS:
        for name in names:
            doc = docs.get(name) or read_issue(ldir, arm, name)[0]
            docs[name] = doc
            t = doc["origin"]
            if (t, TL[T]) in done:
                continue
            ys = truth.get((t, TL[T]))
            if ys is None:                       # the primary has not finalized this cell-day yet
                n_pend += 1
                break
            series_out = [{"symbol": r["symbol"], "group": GROUP, "fH": r["fH"][TL[T]], "a": r["a"][TL[T]],
                           "y": ys.get(r["symbol"])} for r in doc["series"] if r["issued"]]
            oraw = (json.dumps(C.clean({"date": doc["date"], "origin": t, "T": TL[T], "arm": arm,
                                        "series": series_out}), separators=(",", ":")) + "\n").encode()
            di = (t - FIRST_ORIGIN) // DAY
            line = {"schema": SCHEMA + "/ledger", "arm": arm, "date": doc["date"], "origin": t, "T": TL[T],
                    "dayIndex": di, "groups": {}, "events": []}
            st_new = json.loads(json.dumps(state))
            for gk, T_u, js, g in arm_units():
                if T_u != T:
                    continue
                ecl = {jj: clim.get(L.gkey(T, L8[jj], g), 0.0) for jj in js}
                rows = [(r["fH"], r["y"], r["a"], ecl) for r in series_out]
                ds = L12.day_sums(rows, js)
                m = dict(ds)
                m["observed"] = ds["nLabelled"] > 0
                if m["observed"]:
                    hh = [x for x in hist[gk] if x[0] <= di - L.h_of(T)]
                    st_g, bets, ev = L12.monitor_step(st_new[gk], ds, di, {"A": [x[1] for x in hh],
                                                                          "B": [x[2] for x in hh]}, v0[gk], doc["date"])
                    st_new[gk] = st_g
                    m.update(bets)
                    m["logKA"], m["logKB"], m["logE"] = (st_g["logKA"][bets["sub"]], st_g["logKB"][bets["sub"]],
                                                        st_g["logE"])
                    line["events"] += [f"{gk}: {x}" for x in ev]
                    hist[gk].append((di, ds["XA"], ds["XB"]))
                line["groups"][gk] = m
            line["state"] = st_new
            line["classes"] = effective_classes(st_new)
            line["prevSha256"] = prev
            line["outcomeSha256"] = C.sha256_bytes(oraw)
            raw = (json.dumps(C.clean(line), separators=(",", ":"), ensure_ascii=True, allow_nan=False) + "\n").encode()
            C.append_bytes(outcomes_path(ldir, arm, t), oraw)
            C.append_bytes(ledger_path(ldir, arm), raw)
            prev = C.sha256_bytes(raw)
            led.append(line)
            done.add((t, TL[T]))
            state = st_new
            n_fin += 1
    log(f"d13 arm {arm} scored: {n_fin} cell-days finalized, {n_pend} horizons pending, ledger {len(led)} lines")
    write_classes(ldir, arm, UA, led, state)


def write_classes(ldir, arm, UA, led, state):
    outs = read_outcomes(ldir, arm)
    acc = {}
    for d_ in led:
        o = outs[d_["outcomeSha256"]]
        T = [T_ for T_ in TS if TL[T_] == d_["T"]][0]
        week = (d_["origin"] - FIRST_ORIGIN) // (7 * DAY)
        for r in o["series"]:
            if r["y"] is None:
                continue
            for k in LV:
                j = L8.index(k)
                gk = L.gkey(T, k, GROUP)
                acc.setdefault(gk, []).append((week, r["fH"][j], r["a"][j], UA["arms"][arm]["climatology"][gk],
                                               r["y"][j]))
    eff = effective_classes(state)
    doc = {"schema": SCHEMA + "/classes", "prereg": PREREG, "arm": arm, "target": L.TARGET, "surfaced": False,
           "use": "comparison of calibration across feeds only; never routes, never changes a D13 class",
           "lastLedgerDate": max((d_["date"] for d_ in led), default=None), "monitors": {}, "cells": eff,
           "secondaries": {}}
    for key, T, js, g in arm_units():
        s_ = state[key]
        doc["monitors"][key] = {"horizon": TL[T], "levels": [L8[j] for j in js], "kind": "pooled" if len(js) > 1 else
                                "cell", "class": s_["class"], "defaultClass": s_["defaultClass"],
                                "downgraded": s_["downgraded"], "downgradedAt": s_["downgradedAt"],
                                "observedDays": s_["days"], "R_cum": s_.get("R"), "eValue": math.exp(s_["logE"]),
                                "threshold": s_["threshold"]}
        if len(js) == 1:
            doc["secondaries"][key] = L12.secondaries(acc.get(key, []))
    p = os.path.join(ldir, ARMS_SUB, f"classes-{arm}.json")
    C.write_atomic(p, C.dumps(doc))


# =====================================================================================================================
# entry point from q26_live_d13 (after the primary; an arm failure never changes the primary's exit status)
# =====================================================================================================================
def run_arms(cmd, a, log=print, clock=time.time, stores=None, probe=None):
    ldir = C.live_dir(a.out)
    try:
        UA = load_universe()
    except (OSError, ValueError):
        log("d13 arms: closed (universe missing)")
        return
    for arm in ARMS:
        try:
            check_inputs(UA, a.datasets, arm)
            rec = ensure_ci(arm, a, UA, ldir, log=log)
            if not rec.get("pass"):
                log(f"d13 arm {arm}: closed (replay record failed)")
                continue
            if arm == "V":
                pr = probe_status(ldir, log=log, probe=probe)
                if not pr.get("pass"):
                    log("d13 arm V: closed (runner probe failed; arm deferred)")
                    continue
            try:
                n = (stores or update_stores)(arm, ldir, clock=clock)
                log(f"d13 arm {arm} store: +{sum(n.values())} rows")
            except (C.RpcError, OSError, ValueError, LookupError, TimeoutError) as ex:
                log(f"d13 arm {arm} store: failed ({type(ex).__name__})")
            spl = splice_status(arm, UA, a.datasets, ldir)
            log(f"d13 arm {arm} splice: {sum(bool(v['pass']) for v in spl.values())} of {len(SYMS)} series pass")
            now = int(clock())
            if cmd == "issue":
                issue_arm(arm, a, UA, now, spl, log=log)
            else:
                score_arm(arm, a, UA, now, log=log)
        except SystemExit as ex:
            log(f"d13 arm {arm}: closed (STOP)")
            print(str(ex), file=sys.stderr)
        except Exception as ex:  # noqa: BLE001  (the arms never stop the primary)
            log(f"d13 arm {arm}: error ({type(ex).__name__})")
            print(f"{type(ex).__name__}: {str(ex)[:200]}", file=sys.stderr)
