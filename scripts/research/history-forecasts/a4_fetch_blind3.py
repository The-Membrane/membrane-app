#!/usr/bin/env python3
"""Q26 A4.1: fetch blind set 3 (Binance USDT spot pairs ranked 41-120). Data checks only.

Implements membrane-board `design/HISTORY_TOUCH_PREREG_A4.md` section A4.1 (registered at
membrane-board d800253). The set is LOCKED until A4.7: this builder computes no outcome (no touch
or drawdown frequency, no volatility statistic, no score). It checks the data only.

Selection (fixed once, at fetch time, from a saved snapshot): Binance USDT spot pairs (quoteAsset
USDT, status TRADING, isSpotTradingAllowed) ranked by 24 h quoteVolume; ranks 41-120; exclude
stablecoins/fiat/pegged, wrapped/staked, leveraged and tokenized-stock tokens and every pair
already used (ETH, BTC, the A2 eight, the A3 ten); keep a pair whose first 1 h kline
(startTime=0, limit=1) opens before 2022-01-01T00:00Z.

Phases (resumable; raw bodies cached in --work-dir, never refetched): select, fetch, build,
check, write. The selection requests live in --work-dir; each pair has its own request log and
raw cache in --work-dir/pairs/<PAIR>/. Usage:
  python3 -I a4_fetch_blind3.py --work-dir DIR [--out-dir DIR] [--phases all|select,fetch,...]

HTTP: header `user-agent: curl/8.5.0`, TLS verified, the environment's proxy. Pairs are fetched
by parallel workers that share one pacer: request starts at least 0.3 s apart (< 4 req/s in
total). HTTP 429/418 pauses every worker for 60 s; that request is retried at most 5 times, then
the run stops. HTTP 5xx, an unparseable body or a transport error: wait 60 s, same retry limit.
Any other HTTP status stops at once.

Grid convention: as `a2_fetch_final_blind.py` (index i opens at startTs + 3600*i; Binance decimal
text, trailing zeros removed; a missing hour is null in every column, never forward-filled;
a kline that closes inside its hour, an exchange halt, is kept and listed in checks.json).
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import a2_fetch_final_blind as F  # noqa: E402

PREREG = {
    "repo": "membrane-board",
    "path": "design/HISTORY_TOUCH_PREREG_A4.md",
    "section": "A4.1",
    "commit": "d800253",
    "sha256": "152613fc7787b86095fa98e8fa27552d716574771c6def468e1ccd1f95db7010",
}
STATUS = "CANONICAL, LOCKED BLIND SET 3 — do not score until A4.7"
RANK_FROM, RANK_TO = 41, 120
PACE_S = 0.30
WORKERS = 4

A3_TEN = {"NEAR", "ZEC", "UNI", "QNT", "TRX", "INJ", "BAT", "FIL", "AAVE", "DOT"}
USED = {"ETH/BTC": F.CORE, "A2 eight": F.A22_HOLDOUTS, "A3 ten": A3_TEN}
# Tokenized stocks carry no tag in exchangeInfo. Named from the 2026-10-13 snapshot; every
# Binance tokenized-stock pair was listed in 2025 or later, so the first-kline rule excludes any
# not named here as well.
TOKENIZED_STOCKS = {"SPCXB", "SNDKB", "SOXLB"}


# ---------------------------------------------------------------------------------------------
# Pure helpers (unit-tested)
# ---------------------------------------------------------------------------------------------


def exclusion_reason(base: str, all_bases: set[str]) -> str | None:
    for name, bases in USED.items():
        if base in bases:
            return f"already used ({name})"
    if base in F.STABLE_FIAT_PEGGED:
        return "stablecoin/fiat/pegged"
    if base in F.WRAPPED_STAKED:
        return "wrapped/staked"
    if F.leveraged(base, all_bases):
        return "leveraged token"
    if base in TOKENIZED_STOCKS:
        return "tokenized stock"
    return None


def select(ranked: list[dict], all_bases: set[str], first_open) -> tuple[list[dict], list[dict]]:
    """Rank window -> (table, kept). first_open(symbol) -> (open s, raw text) is called only for
    pairs that pass the exclusions."""
    table, kept = [], []
    for p in ranked[RANK_FROM - 1:RANK_TO]:
        row = dict(p)
        row["excluded"] = exclusion_reason(p["baseAsset"], all_bases)
        row["keep"] = False
        if row["excluded"] is None:
            ts, raw = first_open(p["symbol"])
            row.update({"firstKlineOpen": F.iso_utc(ts), "firstKlineOpenTs": ts, "firstKlineRaw": raw,
                        "keep": ts < F.FIRST_KLINE_BEFORE})
            if row["keep"]:
                kept.append({"symbol": p["symbol"], "baseAsset": p["baseAsset"], "rank": p["rank"],
                             "firstKlineOpen": row["firstKlineOpen"]})
        table.append(row)
    return table, kept


class SharedHttp(F.Http):
    """F.Http for several threads: one pacer (slots reserved under a lock), a global pause after
    HTTP 429/418, and exact counters."""

    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self._lock = threading.Lock()
        self._pause_until = 0.0
        self._n = {"requests": 0, "retries": 0, "max_used_weight_1m": 0}
        self._status: dict[str, int] = {}
        inner = self.opener

        def opener(url):
            try:
                st, body, hdr = inner(url)
            except Exception:
                with self._lock:
                    self._n["requests"] += 1
                    self._status["transport"] = self._status.get("transport", 0) + 1
                raise
            with self._lock:
                self._n["requests"] += 1
                self._status[str(st)] = self._status.get(str(st), 0) + 1
                w = hdr.get("x-mbx-used-weight-1m")
                if w and str(w).isdigit():
                    self._n["max_used_weight_1m"] = max(self._n["max_used_weight_1m"], int(w))
                if st in F.RETRY_STATUSES:
                    self._pause_until = max(self._pause_until, self.clock() + F.RETRY_WAIT_S)
            return st, body, hdr
        self.opener = opener

    def _pace(self) -> None:
        """Take the next start slot: at least `interval` after the previous start and not inside a
        429 pause (checked again right before the request starts)."""
        while True:
            with self._lock:
                now = self.clock()
                ready = max(self._pause_until, now if self._last is None else self._last + self.interval)
                if ready <= now:
                    self._last = now
                    return
            self.sleep(ready - now)

    def _event(self, ev: dict) -> None:
        with self._lock:
            if ev.get("kind") == "retry":
                self._n["retries"] += 1
            super()._event(ev)

    def stats(self) -> dict:
        with self._lock:
            return {**self._n, "status_counts": dict(self._status)}


# ---------------------------------------------------------------------------------------------
# Phases
# ---------------------------------------------------------------------------------------------


def pair_work(work: Path, s: dict) -> Path:
    """Each pair has its own request log and raw cache, so no file is shared between threads."""
    return work / "pairs" / s["product"]


def series_of(sel: dict) -> list[dict]:
    return [{"id": f"binance-{k['symbol']}", "asset": f"{k['baseAsset']}/USDT", "host": "binance",
             "kind": "binance", "product": k["symbol"]} for k in sel["kept"]]


def phase_select(work: Path, http_: F.Http) -> dict:
    sel_path = work / "selection.json"
    if sel_path.exists():
        sel = json.loads(sel_path.read_text())
        print(f"[select] reusing the fixed list: {[k['symbol'] for k in sel['kept']]}", file=sys.stderr)
        return sel
    log = F.load_log(work)
    ei_body, ei_rec = F.cached_get(work, http_, log, "select", "exchangeInfo", f"{F.BINANCE_BASE}/exchangeInfo")
    tk_body, tk_rec = F.cached_get(work, http_, log, "select", "ticker24hr", f"{F.BINANCE_BASE}/ticker/24hr")
    ei, tk = json.loads(ei_body), json.loads(tk_body)
    ranked, all_bases = F.rank_usdt_pairs(ei, tk)

    def first_open(sym):
        body, _ = F.cached_get(work, http_, log, "select", f"first-{sym}", F.binance_klines_url(sym, 0, 1),
                               F.parse_binance)
        rows = F.parse_binance(body)
        if len(rows) != 1:
            raise F.FetchStop(f"first-kline probe for {sym} returned {len(rows)} rows")
        return rows[0][0], body.decode()

    table, kept = select(ranked, all_bases, first_open)
    sel = {
        "rule": ("Binance USDT spot pairs (quoteAsset USDT, status TRADING, isSpotTradingAllowed) ranked by 24 h "
                 f"quoteVolume at fetch time; ranks {RANK_FROM}-{RANK_TO}; exclude stablecoins/fiat/pegged, "
                 "wrapped/staked, leveraged and tokenized-stock tokens and every pair already used (ETH, BTC, "
                 "the A2 eight, the A3 ten); keep a pair whose first 1 h kline (startTime=0, limit=1) opens "
                 f"before {F.iso_utc(F.FIRST_KLINE_BEFORE)}."),
        "prereg": PREREG,
        "exchangeInfo": {"url": ei_rec["url"], "fetchedAt": ei_rec["fetchedAt"], "bytes": ei_rec["bytes"],
                         "sha256": ei_rec["sha256"], "serverTime": ei.get("serverTime"),
                         "serverTimeUtc": F.iso_utc(ei["serverTime"] // 1000) if ei.get("serverTime") else None},
        "ticker24hr": {"url": tk_rec["url"], "fetchedAt": tk_rec["fetchedAt"], "bytes": tk_rec["bytes"],
                       "sha256": tk_rec["sha256"],
                       "maxCloseTimeUtc": F.iso_utc(max(t["closeTime"] for t in tk) // 1000)},
        "usdtTradingSpotPairs": len(ranked),
        "exclusionLists": {"used": {k: sorted(v) for k, v in USED.items()},
                           "stableFiatPegged": sorted(F.STABLE_FIAT_PEGGED), "wrappedStaked": sorted(F.WRAPPED_STAKED),
                           "tokenizedStocks": sorted(TOKENIZED_STOCKS),
                           "leveraged": "base X+UP with X+DOWN (or X+BULL with X+BEAR) also a base asset"},
        "window": table,
        "kept": kept,
        "fixedAt": F.now_utc(),
    }
    sel_path.write_text(json.dumps(sel, indent=1) + "\n")
    print(f"[select] kept {len(kept)}: {[(k['rank'], k['symbol'], k['firstKlineOpen']) for k in kept]}",
          file=sys.stderr)
    return sel


def load_selection(work: Path) -> dict:
    p = work / "selection.json"
    if not p.exists():
        raise SystemExit("STOP: no selection.json; run the select phase first")
    return json.loads(p.read_text())


def phase_fetch(work: Path, http_: SharedHttp, sel: dict) -> None:
    stop = threading.Event()

    def one(s):
        if stop.is_set():
            return None
        t0 = time.monotonic()
        try:
            pw = pair_work(work, s)
            pw.mkdir(parents=True, exist_ok=True)
            pages = F.fetch_binance_series(pw, http_, s)
        except BaseException:
            stop.set()
            raise
        print(f"[fetch] {s['id']}: {len(pages)} pages, {sum(p.get('rows') or 0 for p in pages)} rows, "
              f"{time.monotonic() - t0:.1f}s; {http_.stats()}", file=sys.stderr, flush=True)
        return s["id"]

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = [ex.submit(one, s) for s in series_of(sel)]
        errors = []
        for f in futs:
            try:
                f.result()
            except F.FetchStop as e:
                errors.append(e)
    if errors:
        raise errors[0]


def out_name(s: dict) -> str:
    return f"{s['id']}-1h.json"


def phase_build(work: Path, out: Path, sel: dict) -> None:
    out.mkdir(parents=True, exist_ok=True)
    for s in series_of(sel):
        pw = pair_work(work, s)
        pages = F.series_pages(pw, s)
        grid = F.build_grid(F.series_rows(pw, s, pages))
        data = F.serialize_grid(s["asset"], F.source_text(s), grid, max(p["fetchedAt"] for p in pages))
        back = json.loads(data)
        assert back["count"] == grid["count"] and all(len(back["columns"][c]) == grid["count"] for c in F.COLUMNS)
        if len(data) > F.GZIP_ABOVE_BYTES:
            raise SystemExit(f"STOP: {s['id']} grid is {len(data)} bytes; gzip path not expected for one pair")
        (out / out_name(s)).write_bytes(data)
        print(f"[build] {s['id']}: {len(data)} bytes, count {grid['count']}", file=sys.stderr)


def phase_check(work: Path, out: Path, sel: dict) -> dict:
    res = {"series": {}}
    for s in series_of(sel):
        pw = pair_work(work, s)
        pages = F.series_pages(pw, s)
        rows = F.series_rows(pw, s, pages)
        d = F.load_grid_file(out / out_name(s))
        rebuilt = F.build_grid(rows)
        grid = {"startTs": d["startTs"], "count": d["count"], "columns": d["columns"],
                "rows": rebuilt["rows"], "lastOpenTs": rebuilt["lastOpenTs"]}
        partial = [(t, ms) for rec in pages for t, ms in F.binance_partial_klines(F.read_raw(pw, rec))
                   if t <= F.END_OPEN]
        res["series"][s["id"]] = {
            "file": out_name(s), "asset": s["asset"], "pages": len(pages), "rows_fetched": len(rows),
            "rows_after_end_dropped": sum(1 for r in rows if r[0] > F.END_OPEN),
            "duplicate_identical": rebuilt["duplicate_identical"], "duplicate_conflicting": 0,
            "file_matches_raw": rebuilt["columns"] == grid["columns"] and rebuilt["startTs"] == grid["startTs"],
            "partial_klines": len(partial),
            "partial_klines_list": [{"open": F.iso_utc(t), "closeTimeMs": ms} for t, ms in partial],
            **F.coverage(grid), **F.value_checks(grid),
        }
        c = res["series"][s["id"]]
        print(f"[check] {s['id']}: {c['first_open']} count {c['count']} nulls {c['null_hours']} "
              f"gap {c['longest_gap_hours']}h@{c['longest_gap_start']}", file=sys.stderr)
    (out / "checks.json").write_text(json.dumps(res, indent=1) + "\n")
    return res


def git_info() -> dict:
    root = Path(__file__).resolve().parents[3]
    info = {}
    try:
        def g(*a):
            return subprocess.check_output(["git", "-C", str(root), *a], text=True).strip()
        info["sha"] = g("rev-parse", "HEAD")
        info["branch"] = g("rev-parse", "--abbrev-ref", "HEAD")
        for f in (Path(__file__).resolve(), Path(F.__file__).resolve()):
            rel = str(f.relative_to(root))
            info[f.name] = {"path": rel, "dirty": bool(g("status", "--porcelain", "--", rel)),
                            "last_commit": g("log", "-1", "--format=%H", "--", rel), "sha256": F.sha256_file(f)}
    except Exception as e:  # pragma: no cover
        info["error"] = str(e)
    return info


def phase_write(work: Path, out: Path, sel: dict, run_log: dict) -> None:
    log = F.load_log(work)
    checks = json.loads((out / "checks.json").read_text())
    names = []
    for key, name in (("exchangeInfo", "binance-selection-exchangeInfo.json"),
                      ("ticker24hr", "binance-selection-ticker-24hr.json")):
        body = F.read_raw(work, log[("select", key)])
        if len(body) > F.GZIP_ABOVE_BYTES:
            raise SystemExit(f"STOP: {name} is {len(body)} bytes; gzip path not implemented")
        (out / name).write_bytes(body)
        names.append(name)
    (out / "binance-selection.json").write_text(json.dumps(sel, indent=1) + "\n")
    names.append("binance-selection.json")
    series_meta, recs, unused = {}, [], 0
    for s in series_of(sel):
        pw = pair_work(work, s)
        pages = F.series_pages(pw, s)
        recs += pages
        unused += len(set(F.load_log(pw)) - {(p["series"], p["key"]) for p in pages})
        series_meta[s["id"]] = {"asset": s["asset"], "source": F.source_text(s), "file": out_name(s),
                                "pages": [{k: p.get(k) for k in ("key", "url", "status", "bytes", "sha256", "rows",
                                                                 "firstOpen", "lastOpen", "fetchedAt", "attempts")}
                                          for p in pages]}
    sel_recs = [r for (ser, _), r in log.items() if ser == "select"]
    recs += sel_recs
    sessions = [x for x in run_log["sessions"] if x.get("http", {}).get("requests")]
    http_tot = {"requests": sum(x["http"]["requests"] for x in sessions),
                "retries": sum(x["http"]["retries"] for x in sessions),
                "max_used_weight_1m": max([x["http"]["max_used_weight_1m"] for x in sessions] or [0]),
                "logged_responses": len(recs), "logged_requests_unused": unused + len(log) - len(sel_recs)}
    manifest = {
        "dataset": "blind3-prices", "status": STATUS, "prereg": PREREG, "endOpenUtc": F.iso_utc(F.END_OPEN),
        "grid": {"stepSeconds": F.STEP, "columns": list(F.COLUMNS),
                 "convention": "index i is the kline opening at startTs + 3600*i; values are Binance's decimal text "
                               "(trailing zeros removed); null = no kline for that hour in every column, never "
                               "forward-filled; a kline closing inside its hour (halt) is kept"},
        "fetchWindowUtc": [min(r["fetchedAt"] for r in recs), max(r["fetchedAt"] for r in recs)],
        "http": http_tot, "sessions": run_log["sessions"],
        "selection": {"files": names, "requests": sel_recs}, "series": series_meta,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1) + "\n")
    write_provenance(out, manifest, checks, sel)


def write_provenance(out: Path, manifest: dict, checks: dict, sel: dict) -> None:
    pr, h = PREREG, manifest["http"]
    sess = []
    for x in manifest["sessions"]:
        c = x.get("code", {})
        files = "; ".join(f"`{n}` last commit `{v['last_commit']}` sha256 `{v['sha256']}`{' DIRTY' if v['dirty'] else ''}"
                          for n, v in c.items() if isinstance(v, dict))
        sess.append(f"  {', '.join(x['phases'])}: HEAD `{c.get('sha')}`; {files}.")
    g = (manifest["sessions"] or [{}])[-1].get("code", {})
    kept = ", ".join(f"{k['symbol']} (rank {k['rank']}, first kline {k['firstKlineOpen'][:10]})" for k in sel["kept"])
    notkept = ", ".join(f"{r['rank']} {r['symbol']} ({r['excluded'] or 'first kline ' + r['firstKlineOpen'][:10]})"
                        for r in sel["window"] if not r["keep"])
    lines = [
        "# blind3-prices — provenance", "",
        f"**Status: {STATUS}.**", "",
        f"Q26 A4 blind set 3, fetched as preregistered in `{pr['repo']}` `{pr['path']}` §{pr['section']}",
        f"(commit `{pr['commit']}`, sha256 `{pr['sha256']}`). Locked until A4.7, which scores it once.",
        "The builder computed no outcome (no touch or drawdown frequency, no volatility statistic, no score).", "",
        "## Selection", "",
        f"- **Rule:** {sel['rule']}",
        f"- **Snapshot:** `exchangeInfo` fetched {sel['exchangeInfo']['fetchedAt']} (serverTime "
        f"{sel['exchangeInfo']['serverTimeUtc']}), `ticker/24hr` fetched {sel['ticker24hr']['fetchedAt']} (24 h window to "
        f"{sel['ticker24hr']['maxCloseTimeUtc']}). {sel['usdtTradingSpotPairs']} USDT TRADING spot pairs ranked.",
        f"- **Kept ({len(sel['kept'])}):** {kept}.",
        f"- **Ranks {RANK_FROM}–{RANK_TO} not kept:** {notkept}.",
        "- Tokenized stocks carry no exchangeInfo tag; they are a named list, and every Binance tokenized-stock",
        "  pair was listed in 2025 or later, so the first-kline rule excludes them too.",
        "- Raw bodies byte-for-byte: `binance-selection-exchangeInfo.json`, `binance-selection-ticker-24hr.json`;",
        "  rank table with exclusion reasons and first-kline raw text: `binance-selection.json`.", "",
        "## Fetch", "",
        f"- **Source:** `{F.BINANCE_BASE}/klines?symbol=<PAIR>&interval=1h&startTime=<ms>&limit=1000` (free, no key),",
        "  header `user-agent: curl/8.5.0`, TLS verified; from `startTime=0` (the first kline), next page = last open + 1 h.",
        f"  {WORKERS} workers share one pacer (request starts ≥ {PACE_S} s apart); HTTP 429 pauses all workers 60 s.",
        f"- **Builder:** `The-Membrane/membrane-app` branch `{g.get('branch')}`, "
        "`scripts/research/history-forecasts/a4_fetch_blind3.py` (helpers from `a2_fetch_final_blind.py`). By session:",
        *sess,
        f"- **Fetch window (UTC):** {manifest['fetchWindowUtc'][0]} → {manifest['fetchWindowUtc'][1]}. {h['requests']} HTTP "
        f"requests, {h['retries']} retries, {h['logged_responses']} logged responses (raw sha256 each in `manifest.json`); "
        f"max Binance used weight per minute {h['max_used_weight_1m']}.",
        f"- **End:** the kline opening {manifest['endOpenUtc']}, inclusive.",
        "- **Grid:** `{asset, source, startTs, stepSeconds: 3600, count, columns: {open, high, low, close, volume}, fetchedAt}`;",
        "  index i opens at `startTs + 3600·i`; a missing hour is null in every column, never forward-filled; a kline",
        "  that closes inside its hour (exchange halt) is kept and listed in `checks.json`.", "",
        "## Coverage and data checks", "",
        "| pair | first open | count | null hours | longest gap (h, UTC start) | halt klines | zero-volume hours |",
        "|---|---|---:|---:|---|---:|---:|",
    ]
    ser = checks["series"]
    for sid, c in ser.items():
        gap = f"{c['longest_gap_hours']} ({c['longest_gap_start']})" if c["longest_gap_hours"] else "0"
        lines.append(f"| {sid[8:]} | {c['first_open']} | {c['count']} | {c['null_hours']} | {gap} | "
                     f"{c['partial_klines']} | {c['zero_volume_hours']} |")
    tot = lambda k: sum(c[k] for c in ser.values())  # noqa: E731
    lines += [
        "",
        f"All pairs end at {manifest['endOpenUtc']}. Duplicate klines {tot('duplicate_identical')} identical / 0 conflicting, "
        f"low > min(open, close) {tot('low_gt_min_open_close')}, high < max(open, close) {tot('high_lt_max_open_close')}, "
        f"low > high {tot('low_gt_high')}, non-positive prices {tot('nonpositive_price_values')}, negative volume "
        f"{tot('negative_volume')}, file matches raw: {all(c['file_matches_raw'] for c in ser.values())}. Null hours per "
        "year, halt klines and zero-volume hours per year are in `checks.json`.",
        "", "## Files", "", "| file | bytes | sha256 |", "|---|---:|---|",
    ]
    for p in sorted(out.iterdir()):
        if p.is_file() and p.name != "PROVENANCE.md":
            lines.append(f"| `{p.name}` | {p.stat().st_size} | `{F.sha256_file(p)}` |")
    (out / "PROVENANCE.md").write_text("\n".join(lines) + "\n")


ALL_PHASES = ("select", "fetch", "build", "check", "write")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--work-dir", required=True, type=Path)
    ap.add_argument("--out-dir", type=Path, default=None)
    ap.add_argument("--phases", default="all")
    a = ap.parse_args(argv)
    phases = ALL_PHASES if a.phases == "all" else tuple(x.strip() for x in a.phases.split(","))
    if set(phases) - set(ALL_PHASES):
        ap.error(f"unknown phases {sorted(set(phases) - set(ALL_PHASES))}")
    work = a.work_dir
    out = a.out_dir or F.datasets_dir() / "blind3-prices"
    work.mkdir(parents=True, exist_ok=True)
    rl_path = work / "run-log.json"
    run_log = json.loads(rl_path.read_text()) if rl_path.exists() else {"sessions": []}
    http_ = SharedHttp("binance", PACE_S, events_path=work / "events.jsonl")
    session = {"phases": list(phases), "started": F.now_utc(), "code": git_info()}
    rc = 0
    try:
        sel = phase_select(work, http_) if "select" in phases else load_selection(work)
        if "fetch" in phases:
            phase_fetch(work, http_, sel)
        if "build" in phases:
            phase_build(work, out, sel)
        if "check" in phases:
            phase_check(work, out, sel)
    except F.FetchStop as e:
        print(f"STOP: {e}", file=sys.stderr)
        rc = 2
    finally:
        session["ended"] = F.now_utc()
        session["http"] = http_.stats()
        if rc:
            session["stopped"] = True
        run_log["sessions"].append(session)
        rl_path.write_text(json.dumps(run_log, indent=1) + "\n")
    if rc == 0 and "write" in phases:
        phase_write(work, out, sel, run_log)
    return rc


if __name__ == "__main__":
    sys.exit(main())
