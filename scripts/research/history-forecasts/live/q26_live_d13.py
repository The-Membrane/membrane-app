#!/usr/bin/env python3
"""Q26 live forecast log -- D13: oracle-crossing odds (1 h TWAP target) with an anytime-valid calibration monitor.

membrane-board design/HISTORY_TOUCH_LIVE.md Deviation D13 (owner approval 2026-10-24, "Deploy D13"); evidence
design/Q26_ROUND19_PREREG.md R19.5, D-R19.5e and D-R19.5-review. D13 is a separate block beside the unchanged D12. It
writes only forecasts/q26-touch-live/d13/. It reads the D12 kline store (d12/klines/, read only) for the report-only
ratio arm. Nothing here is shown to users: the UI map routes D13 cells as "not surfaced" until the owner rules.

Issue (q26_live_d13.py issue; inside the existing 00:17Z run):
  origin    the daily 00:00Z origin t of the UTC day of the run, at most once, only by a run that starts before t + 23 h.
            First origin FIRST_ORIGIN (after the pin). Nothing is backfilled.
  series    the 20 D12 series (ETHUSDT, BTCUSDT = ETHBTC; 18 large caps = LARGE).
  input III the hourly bar path of G, the 1 h geometric-mean TWAP of Binance 1 m closes (live/d13_twap.py, a math.fsum
            windowed sum; the same function built the development grid). Hours before GRID_END come from the frozen
            D13 development grid (sha256-checked); later hours from the D13 1 m store d13/m1/<SYMBOL>.csv.gz
            (data-api.binance.vision 1 m klines, keyless). Only minutes that close at or before t are read.
  (fH)      raw (fH) exactly as D12 (q26_live_d12.series_origin = r192_borrower.task at one origin) on the III bars.
  ratio arm report only: kline (fH) (q26_live_d12.compute_series on the D12 kline grid + D12 kline store, read only)
            times a walk-forward ratio Sum y_b / Sum p per cell and group, refit at each quarter start from every row
            resolved before it (development rows, then D13 live rows), capped at 1, running minimum over the ladder.
Score (q26_live_d13.py score; inside the existing 00:47Z run):
  truth (b) y = 1 iff min over hours h in (t, t + T] of the III hour low <= G(t) (1 + k), G(t) = the III close of the
            hour ending at t (oracle distance from G(t0), not spot). Any null III hour in the window censors the row.
  flag      liquidation path unavailable (report only, never lowers the odds): simulated Oracle anchor (hourly commit
            of the hour-end G; a move of more than 5% is clamped to 5% of the anchor; Oracle.sol commitMedianPrice), and
            a crossing is flagged when (A - level) / level > 5% at the first crossing hour (Oracle.sol _deviationPct).
  monitor   the D12-A2 rule unchanged (q26_live_d12.monitor_step): per-cell two-sided e-processes for every D13 cell,
            plus the pooled -2..-10% monitor per horizon and group. Downgrade CALIBRATED-WARN -> CALIBRATED (terminal).
No address, key or secret is read or written. Public endpoints only.
"""
from __future__ import annotations

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import gzip  # noqa: E402
import json  # noqa: E402
import math  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402

import numpy as np  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import d13_twap as TW  # noqa: E402
import q26_live_common as C  # noqa: E402
import q26_live_d12 as L12  # noqa: E402  (imported, never modified)

HOUR, DAY = C.HOUR, C.DAY
D13_SUB = "d13"
SCHEMA = "q26-touch-live/d13/1"
PREREG = {"repo": "triccs/membrane-board", "path": "design/HISTORY_TOUCH_LIVE.md", "deviation": "D13",
          "approval": "owner 2026-10-24, 'Deploy D13' (design/Q26_ROUND19_PREREG.md D-R19.5-review)"}
TS, TL, L8 = L12.TS, L12.TL, L12.L8
LV = (-0.02, -0.03, -0.05, -0.07, -0.10, -0.15, -0.20)          # D13 cell levels (R19.5c)
CELLS = tuple((T, k) for T in TS for k in LV)
GROUPS = L12.GROUPS
POOL_LV = L12.POOL_LV
POOL_J = L12.POOL_J
GRID_END = C.A.utc("2026-10-24T00:00:00Z")            # the D13 development III grid covers hours opening before this
STORE_START = GRID_END - 3 * HOUR                     # the live 1 m store starts 3 h before the grid ends (splice)
TAIL_START = GRID_END - 26 * HOUR                     # development 1 m closes kept in the universe (TWAP replay)
GRID_DIR = "history-forecasts/r19/d13-inputs-GRIDCODE"
FIRST_ORIGIN = C.A.utc("2026-10-25T00:00:00Z")        # first daily origin after the D13 pin (no earlier one)
Q4_2026 = C.A.utc("2026-10-01T00:00:00Z")
MAX_LATE = L12.MAX_LATE
M1_HEADER = ["openTime", "close"]
RESOLVE_MARGIN, GIVE_UP, DELIST_DAYS = L12.RESOLVE_MARGIN, L12.GIVE_UP, L12.DELIST_DAYS
R_BAND, ALPHA = L12.R_BAND, L12.ALPHA
CLASS_WARN, CLASS_DOWN, CLASS_RECAL, CLASS_HC = L12.CLASS_WARN, L12.CLASS_DOWN, L12.CLASS_RECAL, L12.CLASS_HC
CLASS_DNS, CLASS_CAL = "DO NOT SHOW", "CALIBRATED"
REPLAY_ORIGINS = L12.REPLAY_ORIGINS
LOOKAHEAD_N = 5
ANCHOR_DEV = 0.05                                     # Oracle maxDeviationPct (DeployFullSystem.s.sol: 5%)
ANCHOR_WARM = 48                                      # hours of anchor simulation before the origin
LABEL_LARGE = "Binance-proxy oracle event (no pool basis check)"
LABEL_ETHBTC = "oracle-proxy event: 1 h TWAP of Binance 1 m closes (R19.5: within -17/+15 bp of the ETH pool TWAP)"
TARGET = "(b) the 1 h TWAP crosses G(t0) (1 + k) within T; distance measured from G(t0), the oracle proxy at origin"
UI_NOTE = "not surfaced: owner decision pending. When shown, the UI must show the oracle distance from G(t0)."

# Default classes: the R19.5 III-on-(b) grading (cells-r195.md, full span), except ETH/BTC -15/-20%, which keep their
# current UI-map classes (D-R19.5-review (d)). Every cell is monitored.
_CW, _RC, _HC, _DN = CLASS_WARN, CLASS_RECAL, CLASS_HC, CLASS_DNS
_GRADE = {
    "ETHBTC": {6: (_CW, _CW, _CW, _CW, _HC, _HC, _HC), 12: (_RC, _CW, _CW, _CW, _CW, _HC, _HC),
               24: (_CW, _CW, _CW, _CW, _RC, _CW, _HC), 72: (_RC, _CW, _CW, _CW, _RC, _RC, CLASS_CAL),
               168: (_CW, _CW, _CW, _CW, _CW, _CW, CLASS_CAL)},
    "LARGE": {6: (_CW, _CW, _CW, _CW, _CW, _DN, _HC), 12: (_CW, _CW, _CW, _CW, _CW, _CW, _DN),
              24: (_CW,) * 7, 72: (_CW,) * 7, 168: (_CW,) * 7},
}
DEFAULT_CLASS = {(g, T, k): _GRADE[g][T][LV.index(k)] for g in GROUPS for T in TS for k in LV}
KEPT_CURRENT = {("ETHBTC", T, k) for T in TS for k in (-0.15, -0.20)}


def default_class(g, T, k):
    return DEFAULT_CLASS[(g, T, round(k, 2))]


def cell_name(T, k):
    return L12.cell_name(T, k)


def gkey(T, k, g):
    return f"{cell_name(T, k)} {g}"


def pkey(T, g):
    return f"{TL[T]} pool -2..-10% {g}"


def monitor_units():
    """(key, T, level indices, group): 70 per-cell monitors, then 10 pooled shallow monitors."""
    out = [(gkey(T, k, g), T, [L8.index(k)], g) for (T, k) in CELLS for g in GROUPS]
    out += [(pkey(T, g), T, list(POOL_J), g) for T in TS for g in GROUPS]
    return out


def h_of(T):
    return L12.h_of(T)


# =====================================================================================================================
# universe
# =====================================================================================================================
def universe_path():
    return os.path.join(HERE, "d13_universe.json")


def load_universe():
    with open(universe_path()) as f:
        return json.load(f)


def check_universe(U, datasets, klines=True):
    for e in U["series"]:
        p = os.path.join(datasets, e["gridPath"])
        if not os.path.exists(p) or C.sha256_file(p) != e["gridSha256"]:
            raise SystemExit(f"STOP: d13 III development grid missing or sha256 mismatch for {e['symbol']}")
        if klines:
            p = os.path.join(datasets, e["path"])
            if not os.path.exists(p) or C.sha256_file(p) != e["sha256"]:
                raise SystemExit(f"STOP: d13 kline development grid missing or sha256 mismatch for {e['symbol']}")


# =====================================================================================================================
# III grid: frozen development grid + bars from the D13 1 m store
# =====================================================================================================================
def read_grid(path):
    return L12.read_dev_grid(path)


def m1_path(ldir, sym):
    return os.path.join(ldir, D13_SUB, "m1", sym + ".csv.gz")


def read_m1(path):
    rows = C.read_gz_csv(path, M1_HEADER)
    prev = None
    for r in rows:
        o = int(r[0])
        if o % 60000 or (prev is not None and o <= prev):
            raise SystemExit(f"STOP: {path}: 1 m open times not increasing on the minute grid at {o}")
        prev = o
    return rows


def store_closes(rows, upto):
    """1 m closes (float or None) per minute slot from STORE_START to upto (exclusive), from the store rows."""
    n = (upto - STORE_START) // 60
    out = [None] * max(n, 0)
    for r in rows:
        j = (int(r[0]) // 1000 - STORE_START) // 60
        if j >= n:
            break
        if j >= 0:
            out[j] = float(r[1])
    return out


def store_bars(rows, upto):
    """III hour bars for the hours opening STORE_START .. upto - 1 h from the 1 m store (d13_twap)."""
    lo, hi, cl = TW.bars_from_closes(store_closes(rows, upto))
    return lo, hi, cl


def extend_grid(st, cols, rows, upto):
    """III grid of hours opening st .. upto - 1 h: development values before GRID_END, store bars from GRID_END."""
    n = (upto - st) // HOUR
    n_dev = (GRID_END - st) // HOUR
    out = {c: np.full(n, np.nan) for c in ("close", "low", "high")}
    m = min(n, n_dev, len(cols["close"]))
    for c in out:
        out[c][:m] = cols[c][:m]
    if upto > GRID_END and rows:
        lo, hi, cl = store_bars(rows, upto)
        j0 = (GRID_END - STORE_START) // HOUR                  # store hour index of GRID_END
        for jj in range(j0, len(cl)):
            j = n_dev + (jj - j0)
            if j >= n:
                break
            for c, v in (("close", cl[jj]), ("low", lo[jj]), ("high", hi[jj])):
                out[c][j] = np.nan if v is None else v
    return out


def splice_check(e, rows, cols, st):
    """The store's closes from STORE_START to GRID_END equal the development 1 m closes (universe tailCloses), and its
    hour bars for the two hours before GRID_END equal the development grid bit for bit. -> (ok, detail)."""
    tail = e["tailCloses"]
    k0 = (STORE_START - TAIL_START) // 60
    want = tail[k0:]
    got = store_closes(rows, GRID_END)
    shared = [(a, b) for a, b in zip(got, want) if a is not None and b is not None]
    if len(shared) < 0.9 * len([b for b in want if b is not None]):
        return False, f"store covers {len(shared)} of {len(want)} splice minutes"
    if any(a != b for a, b in shared):
        return False, "store 1 m closes differ from the development files"
    lo, hi, cl = store_bars(rows, GRID_END)
    for q in (1, 2):
        js, jg = len(cl) - q, (GRID_END - st) // HOUR - q
        for c, v in (("close", cl[js]), ("low", lo[js]), ("high", hi[js])):
            g = cols[c][jg]
            if (v is None) != (not np.isfinite(g)) or (v is not None and v != g):
                return False, f"store bar {c} differs from the grid {q} h before GRID_END"
    return True, f"{len(shared)} minutes and 2 hour bars equal"


def update_m1(ldir, entry, http_get=None, clock=time.time):
    """Append every closed 1 m kline after the last stored one (bootstrap: from STORE_START). -> counts."""
    sym = entry["symbol"]
    path = m1_path(ldir, sym)
    existing = read_m1(path)
    last_open = int(existing[-1][0]) if existing else (STORE_START - 60) * 1000
    fetched_ms = int(clock() * 1000)
    new, req = [], 0
    while True:
        url = f"{C.BINANCE_API}?symbol={sym}&interval=1m&startTime={last_open + 60000}&limit=1000"
        data = json.loads(C.get_with_retry(url, get=http_get))
        req += 1
        if not isinstance(data, list):
            raise ValueError(f"binance {sym}: unexpected response")
        batch = []
        for k in data:
            o, c = int(k[0]), int(k[6])
            if o <= last_open or c >= fetched_ms:
                continue                   # an open (unfinished) kline is never stored
            if o % 60000:
                raise ValueError(f"binance {sym}: kline off the minute grid {o}")
            batch.append([str(o), str(k[4])])
        if not batch:
            break
        new += batch
        last_open = int(batch[-1][0])
        if len(data) < 1000 or req >= 60:
            break
    if new:
        C.append_bytes(path, C.gz_member(None if existing else M1_HEADER, new))
    return {"symbol": sym, "appended": len(new), "requests": req, "fetchedAt": fetched_ms // 1000}


def update_all(ldir, U, http_get=None, clock=time.time, log=print, sleep=time.sleep):
    ok, failed, added, req = {}, [], 0, 0
    for e in U["series"]:
        try:
            r = update_m1(ldir, e, http_get=http_get, clock=clock)
            ok[e["symbol"]] = r["fetchedAt"]
            added += r["appended"]
            req += r["requests"]
        except (OSError, ValueError, TimeoutError) as ex:
            failed.append([e["symbol"], f"{type(ex).__name__}: {str(ex)[:120]}"])
        sleep(0.1)
    md = os.path.join(ldir, D13_SUB, "m1")
    C.append_bytes(os.path.join(md, "coverage.jsonl"),
                   (json.dumps({"fetchedAt": int(clock()), "covered": ok}, separators=(",", ":")) + "\n").encode())
    C.append_bytes(os.path.join(md, "fetch-log.jsonl"),
                   (json.dumps({"kind": "d13-m1", "fetchedAt": int(clock()), "ok": len(ok), "failed": failed,
                                "appended": added, "requests": req}, separators=(",", ":")) + "\n").encode())
    log(f"d13 m1: {len(ok)} ok, {len(failed)} failed, +{added} minutes, {req} requests")
    return ok, failed


def coverage(ldir):
    path = os.path.join(ldir, D13_SUB, "m1", "coverage.jsonl")
    cov = {}
    if os.path.exists(path):
        with open(path) as f:
            for line in f:
                if line.strip():
                    for s_, t_ in json.loads(line)["covered"].items():
                        cov[s_] = max(cov.get(s_, 0), int(t_))
    return cov


def series_grid(e, datasets, ldir, upto, garble_from=None):
    st, cols = read_grid(os.path.join(datasets, e["gridPath"]))
    if garble_from is not None:          # no-look-ahead test: every development bar at or after the origin is garbled
        j0 = (garble_from - st) // HOUR
        rng = np.random.default_rng(7)
        for c_ in cols:
            cols[c_][j0:] = rng.uniform(0.5, 2.0, max(0, len(cols[c_]) - j0)) * np.nanmax(cols[c_][:j0])
    rows = read_m1(m1_path(ldir, e["symbol"])) if ldir else []
    if garble_from is not None:
        rows = [r for r in rows if int(r[0]) // 1000 + 60 <= garble_from] + \
               [[r[0], str(3 * float(r[1]))] for r in rows if int(r[0]) // 1000 + 60 > garble_from]
    return st, cols, rows, extend_grid(st, cols, rows, upto)


# =====================================================================================================================
# target (b), anchor flag
# =====================================================================================================================
def label_b(low, S, T):
    """y list over L8, or None (censored): any null hour in the window, a short window, or S not positive."""
    low = np.asarray(low[:T], float)
    if len(low) < T or not np.all(np.isfinite(low)) or not (S > 0):
        return None
    depth = math.log(float(low.min()) / S)
    return [int(depth <= math.log1p(k)) for k in L8]


def anchor_commit(A, m):
    """Oracle.sol commitMedianPrice: re-anchor to m if within maxDeviationPct, else move 5% of the anchor toward m."""
    if abs(m - A) / min(m, A) <= ANCHOR_DEV:
        return m
    return A * (1 + ANCHOR_DEV) if m > A else A * (1 - ANCHOR_DEV)


def anchor_at(close, i):
    """Simulated anchor in force during hour i (after the commit at the end of hour i - 1). None if no start value."""
    A = None
    for b in range(max(0, i - ANCHOR_WARM), i):
        c = close[b]
        if not np.isfinite(c):
            continue
        A = float(c) if A is None else anchor_commit(A, float(c))
    return A


def anchor_flags(close, low, i, T, S):
    """Per L8 level: 1 if the first (b) crossing hour h has (A_h - level) / level > 5%, A_h the anchor in force in
    hour h (hourly commits of the hour-end G from hour i - 48). The crossing value is taken as the level itself.
    0 if no crossing or no anchor. Report only: never used to change a probability."""
    out = []
    A = anchor_at(close, i)
    cross = {}
    for jj in range(L8.__len__()):
        lvl = S * (1 + L8[jj])
        h = next((b for b in range(i, min(i + T, len(low))) if np.isfinite(low[b]) and low[b] <= lvl), None)
        cross[jj] = (h, lvl)
    Ah, b_done = A, i
    hs = sorted({h for h, _ in cross.values() if h is not None})
    anchors = {}
    for h in hs:
        for b in range(b_done, h):
            c = close[b]
            if np.isfinite(c) and Ah is not None:
                Ah = anchor_commit(Ah, float(c))
        b_done = h
        anchors[h] = Ah
    for jj in range(len(L8)):
        h, lvl = cross[jj]
        if h is None or anchors.get(h) is None:
            out.append(0)
        else:
            out.append(int((anchors[h] - lvl) / lvl > ANCHOR_DEV))
    return out


# =====================================================================================================================
# issue
# =====================================================================================================================
def compute_series(e, origin, datasets, ldir, garble=False):
    try:
        st, cols, rows, g = series_grid(e, datasets, ldir, origin, garble_from=origin if garble else None)
        last = np.flatnonzero(np.isfinite(g["close"]))
        if len(last) == 0 or (origin - (st + HOUR * int(last[-1]))) > DELIST_DAYS * DAY:
            return None, "no III close in the 30 days before the origin (delisted or halted)"
        res, why = L12.series_origin(e["key"], st, g, origin)
        if res is None:
            return None, why
        i = (origin - st) // HOUR
        A = anchor_at(g["close"], i)
        res["anchor"] = A
        return res, None
    except Exception as ex:  # noqa: BLE001  (one series failing never stops the block; recorded as not issued)
        return None, f"error {type(ex).__name__}: {str(ex)[:160]}"


def _job(args):
    e, origin, datasets, ldir, garble, kline = args
    t0 = time.time()
    res, why = compute_series(e, origin, datasets, ldir, garble)
    kr, kwhy = (None, None)
    if kline and res is not None:
        kr, kwhy = L12.compute_series(e, origin, datasets, ldir)      # D12 kline grid + D12 kline store (read only)
    return e["symbol"], res, why, kr, kwhy, time.time() - t0


def compute_origin(datasets, ldir, U, origin, workers=2, garble=False, only=None, kline=False):
    import multiprocessing as mp
    jobs = [(e, origin, datasets, ldir, garble, kline) for e in U["series"] if only is None or e["symbol"] in only]
    if workers <= 1:
        results = list(map(_job, jobs))
    else:
        with mp.get_context("fork").Pool(workers, maxtasksperchild=10) as pool:
            results = list(pool.imap(_job, jobs, chunksize=1))
    res, why, kres, kwhy = {}, {}, {}, {}
    for sym, r, w, kr, kw, _ in results:
        res[sym], kres[sym] = r, kr
        if w:
            why[sym] = w
        if kw:
            kwhy[sym] = kw
    return res, why, kres, kwhy


def issue_dir(ldir):
    return os.path.join(ldir, D13_SUB, "issues")


def list_issues(ldir):
    d = issue_dir(ldir)
    if not os.path.isdir(d):
        return []
    return sorted(n for n in os.listdir(d) if n.endswith(".json.gz") and len(n) == len("YYYY-MM-DD.json.gz"))


def read_issue(ldir, name):
    with open(os.path.join(issue_dir(ldir), name), "rb") as f:
        raw = f.read()
    return json.loads(gzip.decompress(raw)), C.sha256_bytes(raw)


def verify_issue_chain(ldir):
    prev = C.ZERO_SHA
    for n in list_issues(ldir):
        doc, sha = read_issue(ldir, n)
        if doc.get("prevSha256") != prev or doc.get("date") != n[:10]:
            raise SystemExit(f"STOP: d13 issue chain broken at {n}")
        prev = sha
    return prev


def gz_json(obj):
    return gzip.compress(C.dumps(obj), compresslevel=9, mtime=0)


def f32(x):
    return [float(np.float32(v)) for v in x]


def retired_symbols(ldir):
    out = set()
    for n in list_issues(ldir):
        doc, _ = read_issue(ldir, n)
        for r in doc["series"]:
            if not r["issued"] and str(r.get("why", "")).startswith(("no III close in the 30 days", "retired earlier")):
                out.add(r["symbol"])
    return out


def quarter_start(ts):
    return L12.quarter_start(ts)[0]


def ratio_for(U, outs, g, T, k, origin):
    """Walk-forward ratio Sum y_b / Sum p_kline for (g, T, k), from every row resolved before the start of the quarter
    that contains the origin: development rows (universe ratioSums), then D13 live outcome rows. 1.0 if no positive."""
    qs = quarter_start(origin)
    rs = U["ratioSums"][gkey(T, k, g)]
    P, Y = rs["before2026Q4"] if qs <= Q4_2026 else rs["all"]
    j = L8.index(k)
    for o in outs.values():
        if o["T"] != TL[T] or o["origin"] + T * HOUR > qs:
            continue
        for r in o["series"]:
            if r["group"] == g and r.get("y") is not None and r.get("fHkline") is not None:
                P += r["fHkline"][j]
                Y += r["y"][j]
    return (Y / P) if (P > 0 and Y > 0) else 1.0


def ratio_arm(U, outs, g, T, p_kline, origin, cache):
    out = []
    for jj, k in enumerate(L8):
        if k in LV:
            key = (g, T, k, quarter_start(origin))
            if key not in cache:
                cache[key] = ratio_for(U, outs, g, T, k, origin)
            r = cache[key]
        else:
            r = cache.get((g, T, -0.20, quarter_start(origin)), 1.0)     # -30% (not a cell) uses the -20% ratio
        out.append(min(1.0, p_kline[jj] * r))
    return f32(np.minimum.accumulate(np.asarray(out, float)))


def splice_status(ldir, U, datasets):
    """Splice check per series (store vs development 1 m closes and bars), recorded once per series when the store
    covers GRID_END. A failed series is not issued (fail closed per series)."""
    p = os.path.join(ldir, D13_SUB, "checks", "splice.json")
    rec = json.load(open(p)) if os.path.exists(p) else {}
    changed = False
    for e in U["series"]:
        s_ = e["symbol"]
        if s_ in rec:
            continue
        rows = read_m1(m1_path(ldir, s_))
        if not rows or int(rows[-1][0]) // 1000 + 60 < GRID_END:
            continue
        st, cols = read_grid(os.path.join(datasets, e["gridPath"]))
        ok, det = splice_check(e, rows, cols, st)
        rec[s_] = {"pass": ok, "detail": det}
        changed = True
    if changed:
        C.write_atomic(p, C.dumps(rec))
    return rec


def issue(a, U, log=print, clock=time.time, http_get=None):
    datasets, ldir = a.datasets, C.live_dir(a.out)
    now = int(clock())
    origin = now - now % DAY
    check_universe(U, datasets)
    ensure_ci_replay(a, U, log=log)
    update_all(ldir, U, http_get=http_get, clock=clock, log=log)
    spl = splice_status(ldir, U, datasets)
    log(f"d13 splice: {sum(v['pass'] for v in spl.values())} of {len(U['series'])} series pass")
    if origin < FIRST_ORIGIN:
        log(f"d13 issue: none (before the first origin {C.iso(FIRST_ORIGIN)})")
        return 0
    if now >= origin + MAX_LATE:
        log("d13 issue: none (run started 23 h or more after the origin)")
        return 0
    name = C.utc_date(origin) + ".json.gz"
    names = list_issues(ldir)
    if name in names:
        log("d13 issue: none (origin already issued)")
        return 0
    if names and names[-1] > name:
        raise SystemExit("STOP: d13 a later issue file exists (clock went backwards?)")
    prev = verify_issue_chain(ldir)
    cov = coverage(ldir)
    t0 = time.time()
    res, why, kres, kwhy = compute_origin(datasets, ldir, U, origin, workers=a.workers, kline=True)
    for s_ in retired_symbols(ldir):
        if res.get(s_) is not None:
            res[s_], why[s_] = None, "retired earlier (30 days without an III close)"
    for e in U["series"]:
        s_ = e["symbol"]
        if res.get(s_) is not None and not spl.get(s_, {}).get("pass"):
            res[s_], why[s_] = None, "store splice check not passed"
    share = U["pathUnavailableDev"]
    outs = read_outcomes(ldir)
    cache, series = {}, []
    for e in U["series"]:
        s_ = e["symbol"]
        row = {"symbol": s_, "key": e["key"], "group": e["group"]}
        if res.get(s_) is None:
            row.update({"issued": False, "why": why.get(s_, "?")})
        else:
            r = res[s_]
            ca = cov.get(s_, 0) < origin
            kr = kres.get(s_)
            row.update({"issued": True, "S": r["S"], "anchor": r["anchor"],
                        "anchorGapLog": (math.log(r["S"] / r["anchor"]) if r["anchor"] else None),
                        "fH": {TL[T]: f32(r["T"][T]["fH"]) for T in TS},
                        "f": {TL[T]: f32(r["T"][T]["f"]) for T in TS},
                        "a": {TL[T]: f32(r["T"][T]["a"]) for T in TS},
                        "fHfallback": {TL[T]: r["T"][T]["fallback"] for T in TS},
                        "pathUnavailableShareDev": {TL[T]: [share[gkey(T, k, e["group"])]["share"] if k in LV else None
                                                            for k in L8] for T in TS},
                        "censorAll": ca, "censorWhy": ("1 m store not fetched through the origin" if ca else None)})
            if kr is not None:
                row["fHkline"] = {TL[T]: f32(kr["T"][T]["fH"]) for T in TS}
                row["klineS"] = kr["S"]
                row["fHratio"] = {TL[T]: ratio_arm(U, outs, e["group"], T, kr["T"][T]["fH"], origin, cache)
                                  for T in TS}
            else:
                row["fHkline"], row["fHratio"], row["klineWhy"] = None, None, kwhy.get(s_, "?")
        series.append(row)
    n_iss = sum(r["issued"] for r in series)
    doc = {"schema": SCHEMA, "prereg": PREREG,
           "display": "monitor only: the UI reads d13/classes.json (not surfaced), never these rows",
           "target": TARGET, "date": C.utc_date(origin), "origin": origin, "originIso": C.iso(origin),
           "issuedAt": now, "issuedAtIso": C.iso(now), "code": a.code, "levels": list(L8),
           "cells": [cell_name(*c) for c in CELLS], "universeSha256": C.sha256_file(universe_path()),
           "ratioArm": {f"{g} {cell_name(T, k)}": v for (g, T, k, _q), v in cache.items()},
           "prevSha256": prev, "nIssued": n_iss, "modelSeconds": round(time.time() - t0, 1), "series": series}
    C.write_exclusive(os.path.join(issue_dir(ldir), name), gz_json(doc))
    log(f"d13 issue: {n_iss} series issued, {len(series) - n_iss} not issued")
    return 0


# =====================================================================================================================
# score
# =====================================================================================================================
def ledger_path(ldir):
    return os.path.join(ldir, D13_SUB, "ledger.jsonl")


def read_ledger(ldir):
    p = ledger_path(ldir)
    out, prev = [], C.ZERO_SHA
    if not os.path.exists(p):
        return out, prev
    with open(p, "rb") as f:
        for raw in f.read().splitlines(keepends=True):
            if not raw.strip():
                continue
            d = json.loads(raw)
            if d.get("prevSha256") != prev:
                raise SystemExit("STOP: d13 ledger hash chain broken")
            prev = C.sha256_bytes(raw)
            out.append(d)
    return out, prev


def outcomes_path(ldir, origin):
    return os.path.join(ldir, D13_SUB, "outcomes", f"outcomes-{C.utc_date(origin)[:7]}.jsonl")


def read_outcomes(ldir):
    d = os.path.join(ldir, D13_SUB, "outcomes")
    out = {}
    if os.path.isdir(d):
        for n in sorted(os.listdir(d)):
            with open(os.path.join(d, n), "rb") as f:
                for raw in f.read().splitlines(keepends=True):
                    if raw.strip():
                        out[C.sha256_bytes(raw)] = json.loads(raw)
    return out


def labels_for(entry, datasets, ldir, origin, S, T, cov):
    """(y list over L8 or None, flags list) or 'wait' when the store has not been fetched through origin + T."""
    sym = entry["symbol"]
    if cov.get(sym, 0) < origin + T * HOUR:
        return "wait"
    st, _, _, g = series_grid(entry, datasets, ldir, origin + T * HOUR)
    i = (origin - st) // HOUR
    y = label_b(g["low"][i:i + T], S, T)
    if y is None:
        return None, None
    return y, anchor_flags(g["close"], g["low"], i, T, S)


def initial_state():
    st = {gkey(T, k, g): L12.new_group_state(T, default_class(g, T, k)) for (T, k) in CELLS for g in GROUPS}
    for T in TS:
        for g in GROUPS:
            st[pkey(T, g)] = L12.new_group_state(T, "pooled monitor")
    return st


def day_index_of(origin):
    return (origin - FIRST_ORIGIN) // DAY


def score(a, U, log=print, clock=time.time, http_get=None):
    ldir = C.live_dir(a.out)
    check_universe(U, a.datasets, klines=False)
    ensure_ci_replay(a, U, log=log)
    update_all(ldir, U, http_get=http_get, clock=clock, log=log)
    splice_status(ldir, U, a.datasets)
    now = int(clock())
    verify_issue_chain(ldir)
    names = list_issues(ldir)
    led, prev = read_ledger(ldir)
    outs = read_outcomes(ldir)
    for d_ in led:
        o = outs.get(d_["outcomeSha256"])
        if o is None or o["origin"] != d_["origin"] or o["T"] != d_["T"]:
            raise SystemExit(f"STOP: d13 outcome line named by the ledger for {d_['date']} {d_['T']} is missing")
    done = {(d_["origin"], d_["T"]) for d_ in led}
    state = led[-1]["state"] if led else initial_state()
    hist = {u[0]: [] for u in monitor_units()}
    for d_ in led:
        for gk, m in d_["groups"].items():
            if m.get("observed"):
                hist[gk].append((d_["dayIndex"], m["XA"], m["XB"]))
    v0, clim = U["v0"], U["climatology"]
    cov = coverage(ldir)
    docs = {}
    n_fin, n_pend = 0, 0
    for T in TS:
        for name in names:
            doc = docs.get(name) or read_issue(ldir, name)[0]
            docs[name] = doc
            t = doc["origin"]
            if (t, TL[T]) in done:
                continue
            if now < t + T * HOUR + RESOLVE_MARGIN:
                n_pend += 1
                break
            ys, fls, waiting = {}, {}, False
            for r in doc["series"]:
                if not r["issued"]:
                    continue
                e = [x for x in U["series"] if x["symbol"] == r["symbol"]][0]
                lab = (None, None) if r.get("censorAll") else labels_for(e, a.datasets, ldir, t, r["S"], T, cov)
                if lab == "wait":
                    if now < t + T * HOUR + GIVE_UP:
                        waiting = True
                        break
                    lab = (None, None)
                ys[r["symbol"]], fls[r["symbol"]] = lab
            if waiting:
                n_pend += 1
                break
            series_out = []
            for r in doc["series"]:
                if not r["issued"]:
                    continue
                series_out.append({"symbol": r["symbol"], "group": r["group"], "fH": r["fH"][TL[T]],
                                   "a": r["a"][TL[T]], "y": ys[r["symbol"]], "pathUnavailable": fls[r["symbol"]],
                                   "fHkline": (r["fHkline"] or {}).get(TL[T]) if r.get("fHkline") else None,
                                   "fHratio": (r["fHratio"] or {}).get(TL[T]) if r.get("fHratio") else None})
            oraw = (json.dumps(C.clean({"date": doc["date"], "origin": t, "T": TL[T], "series": series_out}),
                               separators=(",", ":")) + "\n").encode()
            di = day_index_of(t)
            line = {"schema": SCHEMA + "/ledger", "date": doc["date"], "origin": t, "T": TL[T], "dayIndex": di,
                    "groups": {}, "events": []}
            st_new = json.loads(json.dumps(state))
            for gk, T_u, js, g in monitor_units():
                if T_u != T:
                    continue
                ecl = {jj: clim.get(gkey(T, L8[jj], g), 0.0) for jj in js}
                rows = [(r["fH"], r["y"], r["a"], ecl) for r in series_out if r["group"] == g]
                ds = L12.day_sums(rows, js)
                m = dict(ds)
                m["observed"] = ds["nLabelled"] > 0
                if m["observed"]:
                    hh = [x for x in hist[gk] if x[0] <= di - h_of(T)]           # resolved before origin t
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
            C.append_bytes(outcomes_path(ldir, t), oraw)
            C.append_bytes(ledger_path(ldir), raw)
            prev = C.sha256_bytes(raw)
            led.append(line)
            done.add((t, TL[T]))
            state = st_new
            n_fin += 1
    log(f"d13 scored: {n_fin} cell-days finalized, {n_pend} horizons pending, ledger {len(led)} lines")
    write_summary(ldir, U, led, state)
    return 0


# =====================================================================================================================
# derived files: classes.json (read by the router; not surfaced) and summary.json (report only)
# =====================================================================================================================
def effective_cells():
    return [(g, T, k) for g in GROUPS for T in TS for k in sorted(LV, reverse=True)]


def units_of(g, T, k, state):
    return [u for u in (gkey(T, k, g), pkey(T, g) if k in POOL_LV else None) if u and u in state]


def effective_classes(state):
    out = {}
    for g, T, k in effective_cells():
        cls = default_class(g, T, k)
        if any(state[u]["downgraded"] for u in units_of(g, T, k, state)) and cls in (CLASS_WARN, "SKILL"):
            cls = CLASS_DOWN
        out[f"{g} {TL[T]} {int(round(k * 100))}%"] = cls
    return out


def write_summary(ldir, U, led, state):
    dates_T = {}
    for d_ in led:
        dates_T[d_["T"]] = max(dates_T.get(d_["T"], ""), d_["date"])
    outs = read_outcomes(ldir)
    flagged = {}
    for d_ in led:
        o = outs[d_["outcomeSha256"]]
        T = [T_ for T_ in TS if TL[T_] == d_["T"]][0]
        for r in o["series"]:
            if r["y"] is None:
                continue
            for k in LV:
                j = L8.index(k)
                c = flagged.setdefault(gkey(T, k, r["group"]), [0, 0])
                c[0] += r["y"][j]
                c[1] += (r.get("pathUnavailable") or [0] * len(L8))[j]
    classes = {"schema": SCHEMA + "/classes", "prereg": PREREG, "target": TARGET, "surfaced": False,
               "uiNote": UI_NOTE,
               "rule": ("D13: each cell starts at its default class (R19.5 III-on-(b) grading; ETH/BTC -15/-20% keep "
                        "their current UI-map classes); when a monitor covering it fires (per-cell, or the pooled "
                        "-2..-10% monitor of its horizon and group), a warning class becomes CALIBRATED (terminal). "
                        "Other classes keep their class and carry downgraded = true. The path-unavailable flag is "
                        "reported beside and never changes a class or a probability."),
               "lastLedgerDate": max(dates_T.values()) if dates_T else None, "lastLedgerDateByHorizon": dates_T,
               "monitors": {}, "cells": {}}
    for key, T, js, g in monitor_units():
        s_ = state[key]
        classes["monitors"][key] = {"horizon": TL[T], "levels": [L8[j] for j in js], "group": g,
                                    "kind": "pooled" if len(js) > 1 else "cell", "class": s_["class"],
                                    "defaultClass": s_["defaultClass"], "downgraded": s_["downgraded"],
                                    "downgradedAt": s_["downgradedAt"], "lastObserved": s_["lastObserved"],
                                    "observedDays": s_["days"]}
    eff = effective_classes(state)
    for g, T, k in effective_cells():
        units = units_of(g, T, k, state)
        last = [state[u]["lastObserved"] for u in units if state[u]["lastObserved"]]
        name = f"{g} {TL[T]} {int(round(k * 100))}%"
        fl = flagged.get(gkey(T, k, g), [0, 0])
        classes["cells"][name] = {
            "group": g, "assets": [e["symbol"] for e in U["series"] if e["group"] == g], "horizon": TL[T],
            "horizon_h": T, "level": k, "target": "oracle", "class": eff[name], "defaultClass": default_class(g, T, k),
            "defaultSource": ("current UI-map class (kept; D-R19.5-review (d))" if (g, T, k) in KEPT_CURRENT
                              else "R19.5 III-on-(b) grading"),
            "eventLabel": LABEL_LARGE if g == "LARGE" else LABEL_ETHBTC, "monitors": units,
            "downgraded": any(state[u]["downgraded"] for u in units),
            "downgradedAt": min([state[u]["downgradedAt"] for u in units if state[u]["downgradedAt"]], default=None),
            "lastObserved": max(last) if last else None,
            "pathUnavailable": {"devShare": U["pathUnavailableDev"][gkey(T, k, g)]["share"],
                                "liveCrossings": fl[0], "liveFlagged": fl[1]}}
    C.write_atomic(os.path.join(ldir, D13_SUB, "classes.json"), C.dumps(classes))
    clim = U["climatology"]
    acc, accr = {}, {}
    for d_ in led:
        o = outs[d_["outcomeSha256"]]
        T = [T_ for T_ in TS if TL[T_] == d_["T"]][0]
        week = (d_["origin"] - FIRST_ORIGIN) // (7 * DAY)
        for r in o["series"]:
            if r["y"] is None:
                continue
            for k in LV:
                j = L8.index(k)
                gk = gkey(T, k, r["group"])
                acc.setdefault(gk, []).append((week, r["fH"][j], r["a"][j], clim[gk], r["y"][j]))
                if r.get("fHratio") is not None:
                    accr.setdefault(gk, []).append((week, r["fHratio"][j], r["a"][j], clim[gk], r["y"][j]))
    summ = {"schema": SCHEMA + "/summary", "display": "report only; the UI reads classes.json (not surfaced)",
            "ledgerLines": len(led), "lastDate": classes["lastLedgerDate"], "groups": {}, "ratioArm": {},
            "pathUnavailable": {k_: {"crossings": v[0], "flagged": v[1]} for k_, v in flagged.items()}}
    for key, T, js, g in monitor_units():
        s_ = state[key]
        summ["groups"][key] = {"class": s_["class"], "downgraded": s_["downgraded"],
                               "downgradedAt": s_["downgradedAt"], "days": s_["days"], "R_cum": s_.get("R"),
                               "eValue": math.exp(s_["logE"]), "threshold": s_["threshold"],
                               "secondaries": L12.secondaries(acc.get(key, [])) if len(js) == 1 else None}
        if len(js) == 1:
            summ["ratioArm"][key] = L12.secondaries(accr.get(key, []))
    C.write_atomic(os.path.join(ldir, D13_SUB, "summary.json"), C.dumps(summ))


# =====================================================================================================================
# instrument replay -- run locally before deployment and once on the CI runner (recorded; fail closed)
# =====================================================================================================================
def golden_path():
    return os.path.join(HERE, "d13_golden.json")


def twap_replay(datasets, U):
    """TWAP rule: d13_twap on the development 1 m closes (universe tailCloses, 26 h) reproduces the last 25 hours of
    every development III grid bit for bit (the minute series of the runner = the minute series of development)."""
    n_cmp, n_eq = 0, 0
    for e in U["series"]:
        st, cols = read_grid(os.path.join(datasets, e["gridPath"]))
        lo, hi, cl = TW.bars_from_closes(e["tailCloses"])
        nh = len(cl)
        jg0 = (TAIL_START - st) // HOUR
        for jj in range(1, nh):                     # hour 0 of the tail has no full look-back
            for c, v in (("close", cl[jj]), ("low", lo[jj]), ("high", hi[jj])):
                g = cols[c][jg0 + jj]
                n_cmp += 1
                n_eq += int((v is None and not np.isfinite(g)) or (v is not None and v == g))
    return n_cmp, n_eq


def replay(datasets, U, workers=2, log=print):
    G = json.load(open(golden_path()))
    n_cmp, n_eq, n_lab, n_lab_eq, n_cens, bad = 0, 0, 0, 0, 0, []
    for oi in REPLAY_ORIGINS:
        origin = C.A.utc(oi)
        res, why, _, _ = compute_origin(datasets, None, U, origin, workers=workers)
        for e in U["series"]:
            gd = G["rows"].get(oi, {}).get(e["symbol"])
            if gd is None:
                continue
            r = res.get(e["symbol"])
            st, cols = read_grid(os.path.join(datasets, e["gridPath"]))
            j0 = (origin - st) // HOUR
            for T in TS:
                g = gd.get(TL[T])
                if g is None:
                    continue
                n_cmp += 1
                ok = r is not None and all(
                    np.array_equal(np.asarray(r["T"][T][nm], np.float32), np.asarray(g[nm], np.float32))
                    for nm in ("fH", "f", "a"))
                n_eq += ok
                if not ok:
                    bad.append([oi, e["symbol"], TL[T], "rows" if r is not None else str(why.get(e["symbol"]))])
                if r is not None:
                    y = label_b(cols["low"][j0:j0 + T], r["S"], T)
                    want = None if g["yb"][0] < 0 else g["yb"]
                    n_lab += 1
                    n_cens += y is None
                    lab_ok = y == want
                    n_lab_eq += lab_ok
                    if not lab_ok:
                        bad.append([oi, e["symbol"], TL[T], "label"])
    origin = C.A.utc(REPLAY_ORIGINS[-1])
    look = [e["symbol"] for e in U["series"]][:LOOKAHEAD_N]
    r0, _, _, _ = compute_origin(datasets, None, U, origin, workers=workers, only=set(look))
    rg, _, _, _ = compute_origin(datasets, None, U, origin, workers=workers, garble=True, only=set(look))
    la_ok = all(r0[s_] is not None and rg[s_] is not None and r0[s_]["S"] == rg[s_]["S"] and all(
        np.array_equal(r0[s_]["T"][T][nm], rg[s_]["T"][T][nm]) for T in TS for nm in ("fH", "f", "a"))
        for s_ in look)
    tw_cmp, tw_eq = twap_replay(datasets, U)
    ok = (n_cmp > 0 and n_eq == n_cmp and n_lab == n_cmp and n_lab_eq == n_lab and la_ok and tw_cmp > 0
          and tw_eq == tw_cmp)
    out = {"replayOrigins": list(REPLAY_ORIGINS), "compared": n_cmp, "rowsEqual": n_eq, "labelsCompared": n_lab,
           "labelsEqual": n_lab_eq, "labelsCensored": n_cens, "noLookAhead_series": len(look),
           "noLookAhead_equal": bool(la_ok), "twapValuesCompared": tw_cmp, "twapValuesEqual": tw_eq,
           "mismatches": bad[:20], "goldenSha256": C.sha256_file(golden_path()), "python": sys.version.split()[0],
           "numpy": np.__version__, "pass": bool(ok)}
    log(f"d13 replay: {n_eq} of {n_cmp} rows equal, {n_lab_eq} of {n_lab} labels equal, "
        f"{int(la_ok) * len(look)} of {len(look)} look-ahead equal, {tw_eq} of {tw_cmp} TWAP values equal")
    return out


def ensure_ci_replay(a, U, log=print):
    p = os.path.join(C.live_dir(a.out), D13_SUB, "checks", "ci-replay.json")
    if os.path.exists(p):
        rec = json.load(open(p))
        if not rec.get("pass"):
            raise SystemExit("STOP: d13 CI replay record failed; the block stays closed")
        return rec
    if C.sha256_file(golden_path()) != U["goldenSha256"]:
        raise SystemExit("STOP: d13 golden replay file sha256 mismatch")
    check_universe(U, a.datasets, klines=False)
    rec = replay(a.datasets, U, workers=a.workers, log=log)
    rec.update({"code": a.code, "recordedAt": C.iso(int(time.time()))})
    C.write_exclusive(p, C.dumps(rec))
    if not rec["pass"]:
        raise SystemExit("STOP: d13 CI replay failed (record written; the block stays closed)")
    return rec


# =====================================================================================================================
# CLI
# =====================================================================================================================
D13_FILES = ("live/q26_live_d13.py", "live/d13_twap.py", "live/d13_universe.json", "live/d13_golden.json",
             "live/q26_live_d12.py", "live/d12_universe.json", "live/q26_live_common.py",
             "a2_touch.py", "a3_touch.py", "a6_touch.py", "a_touch.py", "r12_tail.py")


def code_meta(expect_commit=None):
    import subprocess

    def git(*args):
        r = subprocess.run(["git", "-C", C.MODEL_DIR, *args], capture_output=True, text=True)
        return r.stdout.strip() if r.returncode == 0 else None
    commit = git("rev-parse", "HEAD")
    dirty = git("status", "--porcelain", "--", *D13_FILES)
    if expect_commit is not None and commit != expect_commit:
        raise SystemExit(f"STOP: code checkout is at {commit}, expected the pinned commit {expect_commit}")
    if expect_commit is not None and dirty:
        raise SystemExit("STOP: d13 code files differ from the pinned commit")
    return {"repo": "The-Membrane/membrane-app", "commit": commit, "dirty": bool(dirty),
            "python": sys.version.split()[0], "numpy": np.__version__}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=("issue", "score", "replay"))
    ap.add_argument("--datasets", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--expect-commit", default=None)
    ap.add_argument("--workers", type=int, default=2)
    a = ap.parse_args(argv)
    U = load_universe()
    a.code = code_meta(a.expect_commit)
    log = (lambda *x: print(*x, flush=True))
    if a.cmd == "replay":
        check_universe(U, a.datasets, klines=False)
        rec = replay(a.datasets, U, workers=a.workers, log=log)
        print(json.dumps(C.clean(rec), indent=1), file=sys.stderr)
        return 0 if rec["pass"] else 1
    return {"issue": issue, "score": score}[a.cmd](a, U, log=log)


if __name__ == "__main__":
    sys.exit(main())
