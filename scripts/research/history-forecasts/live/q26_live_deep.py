#!/usr/bin/env python3
"""Q26 live forecast log -- deep levels -15% / -20% (-25% reported) at 12 h, 1 d and 3 d with (fH), scored against
four touch targets (log only, never shown).

membrane-board design/HISTORY_TOUCH_LIVE.md Deviation D9 (owner approval 2026-10-18); evidence
design/Q26_ROUND12_PREREG.md R12.5 (D-R12.5a..c: plain (fH) beat (f), (a) and (e) at these cells on blind set B12,
off-Binance altcoins; not ETH evidence). Used by q26_live_issue.py only with --deep-fh and by q26_live_score.py only
with --deep-fh. Without the flags nothing changes.

Issue side (inside the existing 00:17Z job; no new schedule):
- Origins: every hour t with max(previous deep origin + 1 h, asof - 23 h, FIRST_ORIGIN) <= t <= asof (the D8 rule).
- One fit per issue: HAR and FHS training origins t' + T <= the first origin of the batch; (a) = expanding frequency to
  that origin - T. Code r1110_blind.fold_rungs unchanged (the A6 recipe, as r12_tail.series_task used for R12.5).
  Running minimum across the full ladder per rung, then the deep levels kept. (e) = the frozen R12 development
  constant per (T, level) that R12.5 used (E_CONST, copied from frozen-r125-config.json).
- Assets ETH and BTC. stETH/ETH is not logged (its ladder stops at -5% and it has no exchange or TWAP truth).
- Rows go to the issue file's top-level `deepRows` (after `shortRows` / `rows`); the block `deep` (before nRows)
  holds the metadata. Every other field is byte-identical to a run without the flag.

Score side (inside the existing 00:47Z job, --deep-fh): the same forecasts are scored against four targets
(TARGETS). Two new append-only stores are filled by the scorer only: Binance 1-minute klines (TWAP target) and the
Chainlink AnswerUpdated logs of each feed's current aggregator (oracle target). Outcomes go to
scores/deep-outcomes-YYYY-MM.jsonl (append-only); summary.json adds `deep`.

  python3 q26_live_deep.py power --datasets <membrane-datasets> --out <dir>
      development power only (ETH dev span, already seen; no live row): days to 80% power for ETH at the R12.5
      effect per target and horizon. Prints numbers only; writes power-d9.json.
"""
import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import json  # noqa: E402
import re  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402

import numpy as np  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import q26_live_common as C  # noqa: E402

MODEL_DIR = C.MODEL_DIR
if MODEL_DIR not in sys.path:
    sys.path.insert(0, MODEL_DIR)
import a6_touch as M6  # noqa: E402  (imported, never modified)
import r1110_blind as R1110  # noqa: E402  (fold_rungs imported unchanged)

SCHEMA = "q26-touch-live/deep/1"
PREREG = {"repo": "triccs/membrane-board", "path": "design/HISTORY_TOUCH_LIVE.md", "deviation": "D9",
          "evidence": "design/Q26_ROUND12_PREREG.md R12.5 (D-R12.5a..c)"}
HORIZONS = (12, 24, 72)
TL = {12: "12h", 24: "1d", 72: "3d"}
ASSETS = ("ETH", "BTC")
RUNGS = ("fH", "f", "a", "e")
CMPS = ("f", "a", "e")
LEVELS = (-0.15, -0.20, -0.25)
CONFIRM_LEVELS = (-0.15, -0.20)          # -25% is logged and reported only
FIRST_ORIGIN = C.A.utc("2026-10-18T16:00:00Z")   # first hour after the D9 code pin (no earlier price is a test row)
MAX_BATCH_H = 24
STORE_START = FIRST_ORIGIN - 3 * C.HOUR  # the new stores begin here (TWAP needs 60 min before the first origin)

# (e): the frozen R12 development constant per (T, level) (membrane-datasets history-forecasts/r12/dev-49e1af3a/
# pooled-frozen-r12.json, sha256 d4dd8000...; as copied into r125-run-9eb63b67/frozen-r125-config.json `e_constants`,
# sha256 7f5a28bf...). A test checks these against the file when the datasets checkout is present.
E_CONST = {
    12: {-0.15: 0.008374693750184488, -0.20: 0.0036356403801363173, -0.25: 0.0019081313806437465},
    24: {-0.15: 0.021901167640286334, -0.20: 0.00960584931377748, -0.25: 0.004928817688603938},
    72: {-0.15: 0.09051318724197226, -0.20: 0.04290801635007737, -0.25: 0.02273007907617688},
}
E_SOURCE = {"file": "history-forecasts/r12/dev-49e1af3a/pooled-frozen-r12.json",
            "sha256": "d4dd8000bec748d778ee4ec92a34f4b5fa807b76fa0fbfff5bded85babdfd524",
            "frozenConfig": "history-forecasts/r12/r125-run-9eb63b67/frozen-r125-config.json",
            "frozenConfigSha256": "7f5a28bfad22cd2ea028add3d5d93dc53097d2f08825bf8bf8c91d8212d55034"}
# R12.5 effect (B12 pooled BSS of (fH) vs each comparator; results-r125.json sha256 e7f61233...), for the power
# statement only.
R125_BSS = {
    12: {-0.15: {"f": 0.0460774571021062, "a": 0.05869092783574181, "e": 0.06287542037032123},
         -0.20: {"f": 0.03400233852615431, "a": 0.03655073581083468, "e": 0.037768986100025326}},
    24: {-0.15: {"f": 0.04638927108787805, "a": 0.06568727412979203, "e": 0.07071241875161283},
         -0.20: {"f": 0.03887422211765823, "a": 0.04289927084559764, "e": 0.04457209726305267}},
    72: {-0.15: {"f": 0.022623117347882582, "a": 0.06201712027838879, "e": 0.07560402398666444},
         -0.20: {"f": 0.023921035911024346, "a": 0.03892481423213012, "e": 0.04263346983024874}},
}
R125_RESULTS_SHA256 = "e7f6123362330f44c13d4810fe229c62ff0444901b74713822d946caba0b6a27"

# ---------------------------------------------------------------------------------------------
# Targets
# ---------------------------------------------------------------------------------------------
TARGETS = ("xlow", "xclose", "oracle", "twap")
TARGET_DEF = {
    "xlow": "exchange hourly LOW: Binance <PAIR> 1 h klines opening t .. t + T - 1 h; y = 1 iff min low <= S_x (1 + k); "
            "S_x = close of the kline opening t - 1 h (the exchange price at t). As R12.5 (wick touch).",
    "xclose": "exchange hourly CLOSE: the same klines; y = 1 iff min close <= S_x (1 + k) (closes at t + 1 h .. t + T).",
    "oracle": "Chainlink <ASSET>/USD on Ethereum mainnet: every AnswerUpdated log of the feed's aggregator (address read "
              "from the proxy's aggregator() each run) by block timestamp; y = 1 iff the minimum of the answer in force "
              "at t (last log with block timestamp <= t) and every answer with block timestamp in (t, t + T] is "
              "<= S (1 + k), S = the row's spot (the round in force at t from the getRoundData store).",
    "twap": "1-hour TWAP of the exchange price: TWAP(tau) = mean of the closes of the Binance 1 m klines opening in "
            "[tau - 60 min, tau - 1 min] (each minute's close held for that minute); evaluated at every minute tau in "
            "(t, t + T]; y = 1 iff min TWAP <= S_x (1 + k), S_x as xlow.",
}
TARGET_GAP = {"xlow": 2 * C.HOUR, "xclose": 2 * C.HOUR, "oracle": 2 * C.HOUR, "twap": 2 * C.HOUR}
GIVE_UP_AFTER = 3 * C.DAY       # a target still not covered 3 days after t + T is unresolved

# ---------------------------------------------------------------------------------------------
# Scoring rule (registered in D9)
# ---------------------------------------------------------------------------------------------
HAC_LAG = {12: 24, 24: 48, 72: 144}      # Newey-West Bartlett lag max(24 h, 2T) on hourly origins
BOOT_B = 10000
BOOT_SEED = 20261019
ALPHA = 0.05 / 12                        # one-sided, Bonferroni over 4 targets x 3 horizons
POWER = 0.80
R_BAND = (0.8, 1.25)
MIN_EPISODES = 10
# Days to 80% power for ETH at the R12.5 effect, alpha 0.05/12, HAC lag above, binding (largest) comparator; from
# `q26_live_deep.py power` (power-d9.json; ETH dev span 2021Q1-2026Q3, already seen). xlow and oracle use the low-based
# labels, xclose and twap hourly-close labels (twap: a floor). No verdict is read before these origin-days.
_LOW_DAYS = {12: 1429, 24: 1640, 72: 3879}
_CLOSE_DAYS = {12: 2596, 24: 2151, 72: 5136}
EVIDENCE_DAYS = {"xlow": dict(_LOW_DAYS), "xclose": dict(_CLOSE_DAYS), "oracle": dict(_LOW_DAYS),
                 "twap": dict(_CLOSE_DAYS)}

DEEP_OUTCOME_RE = re.compile(r"^deep-outcomes-(\d{4}-\d{2})\.jsonl$")

DECISIONS = [
    "D-D1 origins: hourly, t in [max(previous deep origin + 1 h, asof - 23 h, FIRST_ORIGIN), asof], inside the daily "
    "issue job. Rows for t < asof are computed after t from rounds with updatedAt <= t only (forward-blind because "
    "the model and its pin were fixed before those prices existed); no exclusion for a touch before issuedAt.",
    "D-D2 fit: one fit per issue per T (training t' + T <= first origin of the batch); r1110_blind.fold_rungs "
    "unchanged; running minimum across the full ladder per rung; (e) the frozen R12 development constant.",
    "D-D3 one forecast per row, scored against four targets; each target uses its own spot (exchange targets: the "
    "Binance close at t; oracle: the Chainlink round in force at t). A row's outcome is written once, when every "
    "target is terminal or 3 days after t + T (targets still uncovered are unresolved).",
    "D-D4 nothing is displayed; no label. The block exists for scoring only (owner approval 2026-10-18: log only).",
]


# ---------------------------------------------------------------------------------------------
# Issue side
# ---------------------------------------------------------------------------------------------
def prev_deep_origin(idir):
    for _, name in reversed(C.list_issue_files(idir)):
        with open(os.path.join(idir, name), "rb") as f:
            doc = json.loads(f.read())
        dp = doc.get("deep")
        if isinstance(dp, dict) and dp.get("lastOrigin") is not None:
            return int(dp["lastOrigin"])
    return None


def batch_origins(asof, prev_last):
    lo = max(asof - (MAX_BATCH_H - 1) * C.HOUR, FIRST_ORIGIN)
    if prev_last is not None:
        lo = max(lo, int(prev_last) + C.HOUR)
    lo = -(-lo // C.HOUR) * C.HOUR
    return list(range(lo, asof + 1, C.HOUR))


def asset_deep(sl, so, origins):
    te = np.array([sl.gi(t) for t in origins], dtype=np.int64)
    if te.max() > sl.N:
        raise ValueError("origin after the series end")
    qs_i = int(te[0])
    out = {}
    for T in HORIZONS:
        P6 = M6.Prep6(sl, T, with_fbL=False)
        Pa = P6.P if so is sl else C.A3.Prep3(so, T, beta_select=False)
        p, fit = R1110.fold_rungs(sl, P6, Pa, T, qs_i, te)
        coef, _ = P6.har_coef(qs_i)
        sH = P6.sigma_H(coef, P6.X[te], P6.okX[te])
        P = {r: np.minimum.accumulate(p[r], axis=1) for r in ("fH", "f", "a")}
        out[T] = {"P": P, "fallback": ~np.isfinite(sH), "fit": fit}
        del P6
    return out


def deep_forecasts(datasets, rounds_by_asset, asof, origins, log=print):
    if not origins:
        return {}
    import q26_live_short as QS
    S = QS.series_for(datasets, rounds_by_asset, asof)
    out = {}
    for a in ASSETS:
        sl, so = S[a]["long"], S[a]["oracle"]
        te = [sl.gi(t) for t in origins]
        out[a] = {"spot_series": [float(sl.spot[i]) for i in te],
                  "regime": [(C.REGIMES[int(sl.regime[i])] if int(sl.regime[i]) >= 0 else None) for i in te],
                  "T": asset_deep(sl, so, origins)}
        for ser in {id(sl): sl, id(so): so}.values():
            M6._clear(ser)
        log(f"deep {a}: {len(origins)} origins")
    return out


def deep_rows(fc, rounds_by_asset, origins, issued_at):
    rows = []
    for a in ASSETS:
        if a not in fc:
            continue
        rs = C.sort_rounds(rounds_by_asset[a])
        f = fc[a]
        for oi, t in enumerate(origins):
            r_in = C.answer_in_force(rs, t)
            if r_in is None:
                raise SystemExit(f"STOP: {a}: no round in force at deep origin {C.iso(t)}")
            S = C.price(r_in, a)
            if f["spot_series"][oi] != S:
                raise SystemExit(f"STOP: {a}: series spot at {C.iso(t)} != answer in force")
            for T in HORIZONS:
                ft = f["T"][T]
                for k in LEVELS:
                    j = C.LEVELS[a].index(k)
                    p = {r: float(ft["P"][r][oi, j]) for r in ("fH", "f", "a")}
                    p["e"] = float(E_CONST[T][k])
                    rows.append({"origin": t, "originIso": C.iso(t), "asset": a, "T": TL[T], "T_h": T,
                                 "k": float(k), "confirm": k in CONFIRM_LEVELS, "S": S, "L": S * (1.0 + float(k)),
                                 "resolvesAt": t + T * C.HOUR, "issuedAt": issued_at, "regime": f["regime"][oi],
                                 "p": p, "fH_fallback": bool(ft["fallback"][oi])})
    return rows


def deep_block(fc, origins, rows, prev_last):
    fits = {a: {TL[T]: fc[a]["T"][T]["fit"] for T in HORIZONS} for a in fc}
    return {"schema": SCHEMA, "prereg": PREREG, "display": "none (log only)",
            "what": "(fH) touch odds at 12 h, 1 d, 3 d for -15% and -20% (-25% reported only), with (f), plain history "
                    "(a) and the empirical frequency (e) beside; one forecast scored against four touch targets",
            "assets": list(ASSETS), "horizons": [TL[T] for T in HORIZONS], "rungs": list(RUNGS),
            "levels": list(LEVELS), "confirmLevels": list(CONFIRM_LEVELS),
            "targets": {t: TARGET_DEF[t] for t in TARGETS},
            "eConstants": {TL[T]: {repr(k): E_CONST[T][k] for k in LEVELS} for T in HORIZONS}, "eSource": E_SOURCE,
            "firstOrigin": FIRST_ORIGIN, "firstOriginIso": C.iso(FIRST_ORIGIN), "prevLastOrigin": prev_last,
            "nOrigins": len(origins), "origins": origins, "lastOrigin": origins[-1] if origins else prev_last,
            "fits": fits, "decisions": DECISIONS, "nDeepRows": len(rows)}


def append_deep_rows(data, drows):
    """Add the compact row list `deepRows` as the last top-level key of an issue file's bytes."""
    s = data.decode()
    assert s.endswith("\n}\n")
    body = ",\n".join("  " + json.dumps(C.clean(r), separators=(",", ":"), ensure_ascii=True, allow_nan=False)
                      for r in drows)
    tail = ("[\n" + body + "\n ]") if drows else "[]"
    return (s[:-3] + ',\n "deepRows": ' + tail + "\n}\n").encode()


# ---------------------------------------------------------------------------------------------
# New stores (scorer only): Binance 1 m klines, Chainlink AnswerUpdated logs
# ---------------------------------------------------------------------------------------------
MIN_MS = 60 * 1000
M1_SUB = "binance-1m"
LOGS_SUB = "oracle-logs"
LOG_HEADER = ["blockNumber", "blockTimestamp", "logIndex", "aggregator", "roundId", "answer", "updatedAt"]
LOG_RPC_URLS = ("https://rpc.mevblocker.io", "https://ethereum-rpc.publicnode.com")   # drpc's free plan refuses these
LOG_RPC_BATCH = {"https://rpc.mevblocker.io": 20, "https://ethereum-rpc.publicnode.com": 20}
TOPIC_ANSWER_UPDATED = "0x0559884fd3a460db3073b7fc896cc77986f16e378210ded43186175bf646fc5f"
SEL_AGGREGATOR = "245a7bfc"      # aggregator()
LOG_CHUNK = 2000
DEEP_STORE_ASSETS = {"ETH": "eth-usd", "BTC": "btc-usd"}


def m1_store_path(ldir, pair):
    return os.path.join(ldir, M1_SUB, pair + "-1m.csv.gz")


def logs_store_path(ldir, asset):
    return os.path.join(ldir, LOGS_SUB, DEEP_STORE_ASSETS[asset] + ".csv.gz")


def read_m1_store(path):
    rows = C.read_gz_csv(path, C.KLINE_HEADER)
    prev = None
    for r in rows:
        o = int(r[0])
        if o % MIN_MS or (prev is not None and o <= prev):
            raise SystemExit(f"STOP: {path}: 1 m kline open times not increasing on the minute grid at {o}")
        prev = o
    return rows


def update_m1_store(ldir, pair, http_get=None, clock=time.time):
    """Append every CLOSED 1 m kline after the last stored one (bootstrap: from STORE_START)."""
    path = m1_store_path(ldir, pair)
    existing = read_m1_store(path)
    last_open = int(existing[-1][0]) if existing else (STORE_START - 60) * 1000
    fetched_ms = int(clock() * 1000)
    new = []
    while True:
        url = f"{C.BINANCE_API}?symbol={pair}&interval=1m&startTime={last_open + MIN_MS}&limit=1000"
        data = json.loads(C.get_with_retry(url, get=http_get))
        if not isinstance(data, list):
            raise ValueError(f"binance {pair} 1m: unexpected response")
        batch = []
        for k in data:
            o, c = int(k[0]), int(k[6])
            if o <= last_open or c >= fetched_ms:
                continue
            if o % MIN_MS:
                raise ValueError(f"binance {pair} 1m: kline off the minute grid {o}")
            batch.append([str(o), str(k[1]), str(k[2]), str(k[3]), str(k[4]), str(k[5]), str(c)])
        if not batch:
            break
        new += batch
        last_open = int(batch[-1][0])
        if len(data) < 1000:
            break
    if new:
        C.append_bytes(path, C.gz_member(None if existing else C.KLINE_HEADER, new))
    entry = {"kind": "binance-1m", "pair": pair, "fetchedAt": fetched_ms // 1000, "appended": len(new),
             "lastOpen": C.iso(last_open // 1000) if (new or existing) else None,
             "storeKlines": len(existing) + len(new)}
    C.append_fetch_log(os.path.join(ldir, M1_SUB, "fetch-log.jsonl"), entry)
    return entry


def read_logs_store(path):
    rows = C.read_gz_csv(path, LOG_HEADER)
    out, prev = [], None
    for r in rows:
        x = (int(r[0]), int(r[1]), int(r[2]), r[3].lower(), int(r[4]), int(r[5]), int(r[6]))
        if prev is not None and (x[0], x[2]) <= (prev[0], prev[2]):
            raise SystemExit(f"STOP: {path}: logs not increasing at block {x[0]}")
        prev = x
        out.append(x)
    return out


def logs_coverage(ldir, asset):
    """(last covered block, its timestamp) from oracle-logs/fetch-log.jsonl, or (None, None)."""
    blk = ts = None
    for e in C.read_fetch_log(os.path.join(ldir, LOGS_SUB, "fetch-log.jsonl")):
        if e.get("asset") == asset and (blk is None or int(e["toBlock"]) > blk):
            blk, ts = int(e["toBlock"]), int(e["toBlockTimestamp"])
    return blk, ts


def _block(rpc, tag):
    b = rpc.request_many("eth_getBlockByNumber", [[tag, False]])[0]
    if not isinstance(b, dict) or "number" not in b or "timestamp" not in b:
        raise C.RpcError(f"eth_getBlockByNumber({tag}) returned no block")
    return int(b["number"], 16), int(b["timestamp"], 16)


def block_at_or_before(rpc, ts, head):
    """Largest block number with timestamp <= ts (binary search between an estimate and the head)."""
    hb, hts = head
    lo = max(1, hb - int((hts - ts) / 12) - 2000)
    while _block(rpc, hex(lo))[1] > ts:
        lo = max(1, lo - 5000)
    hi = hb
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if _block(rpc, hex(mid))[1] <= ts:
            lo = mid
        else:
            hi = mid
    return lo


def _aggregator(rpc, proxy, block_no):
    r = rpc.eth_call_many([(proxy, SEL_AGGREGATOR)], block=hex(block_no))[0]
    if r is C.REVERTED or len(r) < 32:
        raise C.RpcError("aggregator() reverted")
    return "0x" + r[12:32].hex()


def _get_logs(rpc, addrs, frm, to):
    out, step, b = [], LOG_CHUNK, frm
    while b <= to:
        e = min(to, b + step - 1)
        try:
            res = rpc.request_many("eth_getLogs", [[{"address": addrs, "fromBlock": hex(b), "toBlock": hex(e),
                                                      "topics": [TOPIC_ANSWER_UPDATED]}]])[0]
        except C.RpcError:
            if step <= 100:
                raise
            step //= 4
            rpc.cur = 0
            continue
        if not isinstance(res, list):
            raise C.RpcError("eth_getLogs returned no list")
        out += res
        b = e + 1
    return out


def _decode_int256(h):
    v = int(h, 16)
    return v - (1 << 256) if v >= (1 << 255) else v


def update_logs_store(rpc, ldir, asset, clock=time.time):
    """Append every AnswerUpdated log of the feed's aggregator(s) up to the finalized block."""
    path = logs_store_path(ldir, asset)
    existing = read_logs_store(path)
    proxy = C.FEEDS[asset][0]
    fin = _block(rpc, "finalized")
    last_blk, _ = logs_coverage(ldir, asset)
    if last_blk is None:
        if fin[1] < STORE_START:
            return {"asset": asset, "mode": "bootstrap", "appended": 0, "note": "finalized block before the store start"}
        frm = block_at_or_before(rpc, STORE_START, fin)
        mode = "bootstrap"
    else:
        frm = last_blk + 1
        mode = "append"
    if frm > fin[0]:
        return {"asset": asset, "mode": mode, "appended": 0, "note": "no new finalized block"}
    agg_now = _aggregator(rpc, proxy, fin[0])
    aggs = sorted({x[3] for x in existing} | {agg_now.lower()})
    raw = _get_logs(rpc, aggs, frm, fin[0])
    need_ts = sorted({int(lg["blockNumber"], 16) for lg in raw if not lg.get("blockTimestamp")})
    bts = {}
    if need_ts:
        res = rpc.request_many("eth_getBlockByNumber", [[hex(b), False] for b in need_ts])
        for b, blk in zip(need_ts, res):
            bts[b] = int(blk["timestamp"], 16)
    new = []
    for lg in raw:
        if lg.get("removed"):
            continue
        bn = int(lg["blockNumber"], 16)
        ts = int(lg["blockTimestamp"], 16) if lg.get("blockTimestamp") else bts[bn]
        new.append((bn, ts, int(lg["logIndex"], 16), lg["address"].lower(), int(lg["topics"][2], 16),
                    _decode_int256(lg["topics"][1]), int(lg["data"][2:66] or "0", 16)))
    new.sort(key=lambda x: (x[0], x[2]))
    if existing and new and (new[0][0], new[0][2]) <= (existing[-1][0], existing[-1][2]):
        raise SystemExit(f"STOP: {asset}: new logs overlap the store")
    if new:
        C.append_bytes(path, C.gz_member(None if existing else LOG_HEADER, [[str(v) for v in x] for x in new]))
    entry = {"kind": "answerUpdated", "asset": asset, "mode": mode, "fetchedAt": int(clock()), "fromBlock": frm,
             "toBlock": fin[0], "toBlockTimestamp": fin[1], "aggregator": agg_now.lower(), "aggregatorsQueried": aggs,
             "appended": len(new), "storeLogs": len(existing) + len(new)}
    C.append_fetch_log(os.path.join(ldir, LOGS_SUB, "fetch-log.jsonl"), entry)
    return entry


def update_deep_stores(ldir, http_get=None, logs_rpc=None, clock=time.time, log=print):
    rep, err = {"binance1m": {}, "oracleLogs": {}}, {}
    for a, pair in C.BINANCE_PAIRS.items():
        try:
            rep["binance1m"][pair] = update_m1_store(ldir, pair, http_get=http_get, clock=clock)
            log(f"binance1m {pair}: +{rep['binance1m'][pair]['appended']} (store {rep['binance1m'][pair]['storeKlines']})")
        except Exception as e:  # noqa: BLE001  (a failed deep store never stops the daily score)
            err[f"binance1m:{pair}"] = f"{type(e).__name__}: {str(e)[:160]}"
            log(f"binance1m {pair}: FAILED")
    rpc = logs_rpc or C.RpcClient(urls=LOG_RPC_URLS, max_batch=LOG_RPC_BATCH, max_calls=5000)
    for a in ASSETS:
        try:
            rep["oracleLogs"][a] = update_logs_store(rpc, ldir, a, clock=clock)
            log(f"oraclelogs {a}: {rep['oracleLogs'][a]['mode']} +{rep['oracleLogs'][a]['appended']} "
                f"(store {rep['oracleLogs'][a].get('storeLogs', 0)})")
        except Exception as e:  # noqa: BLE001
            err[f"oracleLogs:{a}"] = f"{type(e).__name__}: {str(e)[:160]}"
            log(f"oraclelogs {a}: FAILED")
    rep["rpc"] = rpc.stats()
    return rep, err


# ---------------------------------------------------------------------------------------------
# Truth per target
# ---------------------------------------------------------------------------------------------
def _hour_window(kidx, t, T_h, field):
    hours = [t + j * C.HOUR for j in range(T_h)]
    vals = [kidx[h][field] for h in hours if h in kidx]
    run = best = 0
    for h in hours:
        run = run + 1 if h not in kidx else 0
        best = max(best, run)
    return (min(vals) if vals else None), T_h - len(vals), best * C.HOUR


def truth_exchange(kidx, last_open, t, T_h, k, field):
    """xlow (field 0) or xclose (field 1). Returns (status, info)."""
    end_open = t + (T_h - 1) * C.HOUR
    if last_open is None or last_open < end_open:
        return "pending", {"reason": "hourly kline store does not yet cover t + T"}
    prev = kidx.get(t - C.HOUR)
    if prev is None:
        return "unresolved", {"reason": "no exchange spot (kline opening t - 1 h missing)"}
    Sx = prev[1]
    Lx = Sx * (1.0 + k)
    mn, nmiss, gap = _hour_window(kidx, t, T_h, field)
    info = {"S_x": Sx, "L_x": Lx, "min": mn, "nMissing": nmiss, "maxGapSeconds": gap}
    if gap > TARGET_GAP["xlow"] or mn is None:
        return "unresolved", dict(info, reason="kline gap > 2 h")
    return "resolved", dict(info, y=int(mn <= Lx))


def twap_min(m1, t, end):
    """min over minutes tau in (t, end] of the 60-minute TWAP of 1 m closes (klines opening in [tau-60m, tau-1m]).
    m1: dict open_ts -> close. Returns (min, max missing run in seconds over [t - 60 min, end), n undefined tau)."""
    opens = np.arange(t - 3600, end, 60, dtype=np.int64)
    c = np.array([m1.get(int(o), np.nan) for o in opens], float)
    ok = np.isfinite(c)
    run = best = 0
    for v in ok:
        run = 0 if v else run + 1
        best = max(best, run)
    cs = np.concatenate([[0.0], np.cumsum(np.where(ok, c, 0.0))])
    cn = np.concatenate([[0], np.cumsum(ok.astype(int))])
    # tau = t + 60 j (j = 1 .. n): minutes opening tau - 3600 .. tau - 60 -> indices j .. j + 59
    n = (end - t) // 60
    j = np.arange(1, n + 1)
    s = cs[j + 60] - cs[j]
    m = cn[j + 60] - cn[j]
    with np.errstate(invalid="ignore", divide="ignore"):
        tw = np.where(m > 0, s / np.maximum(m, 1), np.nan)
    und = int((m == 0).sum())
    return (float(np.nanmin(tw)) if np.isfinite(tw).any() else None), best * 60, und


def truth_twap(m1, m1_last_close, kidx, t, T_h, k):
    end = t + T_h * C.HOUR
    if m1_last_close is None or m1_last_close < end:
        return "pending", {"reason": "1 m kline store does not yet cover t + T"}
    prev = kidx.get(t - C.HOUR)
    if prev is None:
        return "unresolved", {"reason": "no exchange spot (kline opening t - 1 h missing)"}
    Sx = prev[1]
    Lx = Sx * (1.0 + k)
    mn, gap, und = twap_min(m1, t, end)
    info = {"S_x": Sx, "L_x": Lx, "minTwap": mn, "maxGapSeconds": gap, "nTauUndefined": und}
    if gap > TARGET_GAP["twap"] or mn is None:
        return "unresolved", dict(info, reason="1 m kline gap > 2 h")
    return "resolved", dict(info, y=int(mn <= Lx))


def truth_oracle(logs, cov_ts, t, T_h, L, S_row, asset):
    """logs sorted by (blockNumber, logIndex): tuples (bn, ts, li, agg, roundId, answer, updatedAt)."""
    end = t + T_h * C.HOUR
    if cov_ts is None or cov_ts < end:
        return "pending", {"reason": "AnswerUpdated store does not yet cover t + T"}
    dec = 10 ** C.FEEDS[asset][1]
    inf = None
    win = []
    for x in logs:
        if x[1] <= t:
            inf = x
        elif x[1] <= end:
            win.append(x)
        else:
            break
    if inf is None:
        return "unresolved", {"reason": "no AnswerUpdated log in force at t"}
    seq = [inf] + win
    gap = 0
    for p, q in zip(seq, seq[1:]):
        if q[3] == p[3] and q[4] != p[4] + 1:
            gap = max(gap, q[1] - p[1])
    mn = min(x[5] for x in seq) / dec
    info = {"min": mn, "nLogs": len(seq), "inForceAnswer": inf[5] / dec, "spotMatchesRow": inf[5] / dec == S_row,
            "maxMissingGapSeconds": gap}
    if gap > TARGET_GAP["oracle"]:
        return "unresolved", dict(info, reason="round-id gap > 2 h")
    return "resolved", dict(info, y=int(mn <= L))


# ---------------------------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------------------------
def deep_key(r):
    return (int(r["origin"]), r["asset"], int(r["T_h"]), repr(float(r["k"])))


def load_deep_rows(idir):
    rows = []
    for date, name in C.list_issue_files(idir):
        with open(os.path.join(idir, name), "rb") as f:
            doc = json.loads(f.read())
        dr = doc.get("deepRows")
        if dr is None:
            continue
        if doc.get("deep", {}).get("nDeepRows") != len(dr):
            raise SystemExit(f"STOP: {name}: nDeepRows != number of deep rows")
        for r in dr:
            rows.append(dict(r, date=date))
    return rows


def load_deep_outcomes(sdir):
    out, seen = [], set()
    if not os.path.isdir(sdir):
        return out
    for name in sorted(os.listdir(sdir)):
        if not DEEP_OUTCOME_RE.match(name):
            continue
        with open(os.path.join(sdir, name)) as f:
            for line in f:
                if line.strip():
                    o = json.loads(line)
                    k = deep_key(o)
                    if k in seen:
                        raise SystemExit(f"STOP: duplicate deep outcome {k} in {name}")
                    seen.add(k)
                    out.append(o)
    return out


def resolve_deep(row, ctx, now):
    end = int(row["resolvesAt"])
    if now < end + C.RESOLVE_MARGIN:
        return None, "before origin + T + 15 min"
    a, t, T_h, k = row["asset"], int(row["origin"]), int(row["T_h"]), float(row["k"])
    c = ctx[a]
    res = {"xlow": truth_exchange(c["kidx"], c["lastOpen"], t, T_h, k, 0),
           "xclose": truth_exchange(c["kidx"], c["lastOpen"], t, T_h, k, 1),
           "oracle": truth_oracle(c["logs"], c["logsCov"], t, T_h, float(row["L"]), float(row["S"]), a),
           "twap": truth_twap(c["m1"], c["m1LastClose"], c["kidx"], t, T_h, k)}
    if any(s == "pending" for s, _ in res.values()) and now < end + GIVE_UP_AFTER:
        return None, "a target store does not yet cover origin + T"
    out = {x: row[x] for x in ("date", "origin", "asset", "T", "T_h", "k", "confirm", "S", "L", "resolvesAt",
                               "issuedAt", "regime", "p", "fH_fallback")}
    out["scoredAt"] = now
    tg = {}
    for name, (st, info) in res.items():
        if st == "pending":
            st, info = "unresolved", dict(info, reason="store did not cover within 3 days")
        tg[name] = dict(info, status=st, y=info.get("y") if st == "resolved" else None)
    out["targets"] = tg
    return out, None


def _pos_episodes(origins, y):
    o = np.argsort(origins)
    t, yy = np.asarray(origins)[o], np.asarray(y)[o]
    n = 0
    for i in range(len(t)):
        if yy[i] == 1 and not (i > 0 and yy[i - 1] == 1 and t[i] - t[i - 1] == C.HOUR):
            n += 1
    return n


def _rstats(rs, tgt):
    y = np.array([o["targets"][tgt]["y"] for o in rs], float)
    st = {"n": len(rs), "sum_y": float(y.sum()), "n_ep": _pos_episodes([o["origin"] for o in rs], y)}
    for r in RUNGS:
        p = np.array([o["p"][r] for o in rs], float)
        st[r] = {"brier": float(np.mean((p - y) ** 2)), "sum_p": float(p.sum()),
                 "R": C.ratio(float(p.sum()), float(y.sum()))}
    for c in CMPS:
        bc = st[c]["brier"]
        st[f"bss_fH_vs_{c}"] = (1.0 - st["fH"]["brier"] / bc) if bc > 0 else None
    return st


def per_origin_d(rs, tgt, cmp):
    by = {}
    for o in rs:
        y = o["targets"][tgt]["y"]
        by.setdefault(int(o["origin"]), []).append((o["p"]["fH"] - y) ** 2 - (o["p"][cmp] - y) ** 2)
    ts = np.array(sorted(by), dtype=np.int64)
    return ts, np.array([np.mean(by[t]) for t in ts], float)


def hac_p(d, lag):
    from scipy.stats import norm
    n = len(d)
    if n < 2:
        return None
    mu = float(d.mean())
    lrv = M6.nw_lrv(d - mu, lag)
    if not lrv > 0:
        return None
    return float(norm.cdf(mu / np.sqrt(lrv / n)))


def week_boot_p(ts, d, seed, B=BOOT_B):
    import q26_live_short as QS
    return QS.week_boot_p(ts, d, B=B, seed=seed)


def summarize_deep(outcomes, rows, pending):
    out = {"schema": SCHEMA + "/summary", "prereg": PREREG, "display": "none (log only)",
           "nRows": len(rows), "nOutcomes": len(outcomes), "nPending": len(pending),
           "targets": {t: TARGET_DEF[t] for t in TARGETS},
           "evidenceRule": {"test": "per (asset, T, target), pooled over the -15% and -20% rows: one-sided HAC "
                                    "(Newey-West Bartlett lag max(24 h, 2T), normal) and weekly block bootstrap (10,000 "
                                    "draws) on per-origin Brier differences of (fH) vs (f), (a) and (e); pass = mean d < 0 "
                                    "and both p < 0.05/12 vs all three, pooled R(fH) in [0.8, 1.25], >= 10 positive "
                                    "episodes",
                            "hacLag": {TL[T]: HAC_LAG[T] for T in HORIZONS},
                            "readAtOriginDays": {t: {TL[T]: EVIDENCE_DAYS[t][T] for T in HORIZONS} for t in TARGETS},
                            "primaryAsset": "ETH",
                            "note": "read once per (T, target) on ETH when it reaches readAtOriginDays (4 to 14 years); "
                                    "before that every value is reported only and no verdict is drawn. Live results "
                                    "never retune the model."},
           "cells": {}}
    for a in ASSETS:
        for T in HORIZONS:
            for ti, tgt in enumerate(TARGETS):
                rs_all = [o for o in outcomes if o["asset"] == a and o["T_h"] == T
                          and o["targets"][tgt]["status"] == "resolved"]
                if not rs_all:
                    continue
                rs = [o for o in rs_all if o["confirm"]]
                cell = {"perLevel": {repr(float(k)): _rstats([o for o in rs_all if float(o["k"]) == k], tgt)
                                     for k in LEVELS if any(float(o["k"]) == k for o in rs_all)}}
                if rs:
                    ts_all = sorted({int(o["origin"]) for o in rs})
                    od = len(ts_all) / 24.0
                    cell.update(originDays=od, nOrigins=len(ts_all), pooled=_rstats(rs, tgt), perMonth={}, tests={})
                    for mth in sorted({C.iso(int(o["origin"]))[:7] for o in rs}):
                        cell["perMonth"][mth] = _rstats([o for o in rs if C.iso(int(o["origin"]))[:7] == mth], tgt)
                    for ci, c in enumerate(CMPS):
                        ts, d = per_origin_d(rs, tgt, c)
                        cell["tests"][f"vs_{c}"] = {"mean_d": float(d.mean()), "hac_lag": HAC_LAG[T],
                                                    "hac_p": hac_p(d, HAC_LAG[T]),
                                                    "boot_p": week_boot_p(ts, d, BOOT_SEED + 100 * ti + 10 * ci + T)}
                    R = cell["pooled"]["fH"]["R"]
                    need = EVIDENCE_DAYS[tgt][T]
                    due = need is not None and od >= need
                    passed = (all(cell["tests"][f"vs_{c}"]["mean_d"] < 0
                                  and (cell["tests"][f"vs_{c}"]["hac_p"] or 1) < ALPHA
                                  and (cell["tests"][f"vs_{c}"]["boot_p"] or 1) < ALPHA for c in CMPS)
                              and C.r_inside(R, *R_BAND) and cell["pooled"]["n_ep"] >= MIN_EPISODES)
                    cell["verdict"] = {"applied": bool(due and a == "ETH"), "pass": bool(passed),
                                       "originDaysNeeded": need}
                out["cells"].setdefault(a, {}).setdefault(TL[T], {})[tgt] = cell
    return out


def build_ctx(ldir, kidx_by_asset):
    ctx = {}
    for a in ASSETS:
        pair = C.BINANCE_PAIRS[a]
        kidx = kidx_by_asset.get(a) or {}
        m1rows = read_m1_store(m1_store_path(ldir, pair))
        logs = read_logs_store(logs_store_path(ldir, a))
        _, cov = logs_coverage(ldir, a)
        ctx[a] = {"kidx": kidx, "lastOpen": max(kidx) if kidx else None,
                  "m1": {int(r[0]) // 1000: float(r[4]) for r in m1rows},
                  "m1LastClose": (int(m1rows[-1][0]) // 1000 + 60) if m1rows else None,
                  "logs": sorted(logs, key=lambda x: (x[0], x[2])), "logsCov": cov}
    return ctx


def score_deep(ldir, idir, sdir, kidx, now, http_get=None, logs_rpc=None, clock=time.time, log=print):
    """Update the deep stores, resolve due deep rows (append-only deep-outcomes-YYYY-MM.jsonl), and return
    (summary, new, pending, store report, store errors)."""
    rep, err = update_deep_stores(ldir, http_get=http_get, logs_rpc=logs_rpc, clock=clock, log=log)
    rows = load_deep_rows(idir)
    done = load_deep_outcomes(sdir)
    keys = {deep_key(o) for o in done}
    ctx = build_ctx(ldir, kidx)
    new, pending = [], []
    for r in rows:
        if deep_key(r) in keys:
            continue
        o, why = resolve_deep(r, ctx, now)
        if o is None:
            pending.append(why)
            continue
        new.append(o)
    if new:
        path = os.path.join(sdir, f"deep-outcomes-{C.utc_date(now)[:7]}.jsonl")
        C.append_bytes(path, "".join(json.dumps(C.clean(o), separators=(",", ":"), allow_nan=False) + "\n"
                                     for o in new).encode())
    summ = summarize_deep(done + new, rows, pending)
    summ["storeUpdates"] = {k: v for k, v in rep.items() if k != "rpc"}
    summ["storeUpdateErrors"] = err
    summ["logsRpc"] = rep.get("rpc")
    return summ, new, pending, rep, err


# ---------------------------------------------------------------------------------------------
# Power (development only; ETH dev span, already seen)
# ---------------------------------------------------------------------------------------------
def cmd_power(datasets, out_dir):
    from scipy.stats import norm
    import a_touch as A
    import a3_touch as M3
    import r112_combine as R112
    t0 = time.time()
    ser, oser = R112.build_series(datasets)
    folds = M3.dev_folds(ser)
    levels = tuple(A.LEVELS["ETH"])
    ci = [levels.index(k) for k in CONFIRM_LEVELS]
    z = float(norm.ppf(1 - ALPHA) + norm.ppf(POWER))
    res = {"schema": "q26-touch-live/deep/power/1", "created_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
           "code_sha": R112.git_sha(), "clean": R112.git_clean(),
           "note": "ETH development span only (already seen; grade C); one series. Effect = R12.5 B12 pooled BSS of "
                   "(fH) vs each comparator per (T, level), applied to ETH's own comparator Brier. xlow and oracle use "
                   "the low-based labels of the long ETH series; xclose and twap use hourly-close labels (a proxy: no "
                   "1 m history is read; a 60-min TWAP touches no more often than closes, so twap days are a floor).",
           "alpha_one_sided": ALPHA, "power": POWER, "z_sum": z, "hac_lag": {TL[T]: HAC_LAG[T] for T in HORIZONS},
           "r125_results_sha256": R125_RESULTS_SHA256, "horizons": {}}
    win_min = A.window_min if hasattr(A, "window_min") else None
    for T in HORIZONS:
        P6 = M6.Prep6(ser, T, with_fbL=False)
        Pa = P6.P if oser is ser else M3.Prep3(oser, T, beta_select=False)
        te_all, raw = [], {r: [] for r in ("fH", "f", "a")}
        for f in folds:
            te = np.arange(f["qs_i"], min(f["qe_i"], ser.n_orig))
            p, _ = R1110.fold_rungs(ser, P6, Pa, T, f["qs_i"], te)
            for r in raw:
                raw[r].append(p[r])
            te_all.append(te)
        te = np.concatenate(te_all)
        P = {r: np.minimum.accumulate(np.concatenate(raw[r]), axis=1)[:, ci] for r in raw}
        P["e"] = np.tile(np.array([E_CONST[T][k] for k in CONFIRM_LEVELS]), (len(te), 1))
        ts = ser.base_ts + 3600 * te
        Ylow = ser.labels(T)[te][:, ci]
        Yclose = A.make_labels(ser.spot, win_min(ser.close, T), ser.levels)[te][:, ci]
        base = ~((ts + T * 3600 > R112.Q2_START) & (ts < R112.Q2_END)) & (ts <= R112.DEV_LAST_ORIGIN)
        hz = {}
        for lab, Y in (("low", Ylow), ("close", Yclose)):
            fin = base & np.all(np.isfinite(Y), axis=1)
            for r in RUNGS:
                fin &= np.all(np.isfinite(P[r]), axis=1)
            Yv = Y[fin]
            Pv = {r: P[r][fin] for r in RUNGS}
            br = {r: ((Pv[r] - Yv) ** 2).mean(axis=0) for r in RUNGS}
            h = {"origins": int(fin.sum()), "positives": {repr(k): int(Yv[:, j].sum()) for j, k in enumerate(CONFIRM_LEVELS)},
                 "R_fH": {repr(k): (float(Pv["fH"][:, j].sum() / Yv[:, j].sum()) if Yv[:, j].sum() else None)
                          for j, k in enumerate(CONFIRM_LEVELS)},
                 "bss_dev": {c: {repr(k): float(1 - br["fH"][j] / br[c][j]) for j, k in enumerate(CONFIRM_LEVELS)}
                             for c in CMPS}, "days": {}}
            for c in CMPS:
                d = (((Pv["fH"] - Yv) ** 2) - ((Pv[c] - Yv) ** 2)).mean(axis=1)
                mu_dev = float(d.mean())
                lrv = M6.nw_lrv(d - mu_dev, HAC_LAG[T])
                mu_eff = float(np.mean([-R125_BSS[T][k][c] * br[c][j] for j, k in enumerate(CONFIRM_LEVELS)]))
                n_eff = z * z * lrv / (mu_eff * mu_eff)
                n_dev = (z * z * lrv / (mu_dev * mu_dev)) if mu_dev < 0 else None
                h["days"][c] = {"mu_r125": mu_eff, "mu_dev": mu_dev, "lrv": lrv, "days_r125": n_eff / 24.0,
                                "days_dev": (n_dev / 24.0) if n_dev else None}
            h["days_binding_r125"] = max(h["days"][c]["days_r125"] for c in CMPS)
            hz[lab] = h
            print(TL[T], lab, json.dumps({"origins": h["origins"], "positives": h["positives"],
                                          "days_r125": {c: round(h["days"][c]["days_r125"]) for c in CMPS},
                                          "days_dev": {c: (None if h["days"][c]["days_dev"] is None
                                                           else round(h["days"][c]["days_dev"])) for c in CMPS}}))
        res["horizons"][TL[T]] = hz
        del P6
    res["runtime_s"] = time.time() - t0
    os.makedirs(out_dir, exist_ok=True)
    print("power-d9 sha256", R112.write_json(os.path.join(out_dir, "power-d9.json"), res))


def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("power")
    p.add_argument("--datasets", required=True)
    p.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    if a.cmd == "power":
        cmd_power(a.datasets, a.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
