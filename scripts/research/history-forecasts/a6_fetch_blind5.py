#!/usr/bin/env python3
"""Q26 A6.1: fetch blind set 5 (Binance USDT spot pairs ranked 241-400, extended in steps of 40 until
30 pairs qualify). Data checks only.

Implements membrane-board `design/HISTORY_TOUCH_PREREG_A6.md` section A6.1 (registered at
membrane-board 3a38083). The set is LOCKED until A6.6: this builder computes no outcome (no touch
or drawdown frequency, no volatility statistic, no score). It checks the data only.

Selection (fixed once, at fetch time, from a saved snapshot): Binance USDT spot pairs (quoteAsset
USDT, status TRADING, isSpotTradingAllowed) ranked by 24 h quoteVolume; ranks 241-400; exclude
stablecoins/fiat/pegged, wrapped/staked, leveraged and tokenized-stock tokens (the A2-A5
exclusions) and every pair already used (ETH, BTC, the A2 eight, the A3 ten, the blind-3 23, the
blind-4 42); keep a pair whose first 1 h kline (startTime=0, limit=1) opens before
2022-01-01T00:00Z. If fewer than 30 pairs are kept, the window's upper end moves down the ranking in
whole steps of 40 ranks (241-440, 241-480, ...) until 30 are kept or the ranking ends; every pair
kept inside the final window is used. Every rank in the final window is probed for its first kline;
an exclusion is reported as binding only when that pair's first kline is before the cutoff.

Tokenized stocks: the a5 list unchanged. Before the blind-5 snapshot was read, the blind-4
exchangeInfo snapshot (2026-10-14, development data since A6.1) was checked for B-suffixed bases not
in the a5 list: only crypto bases (ARB, BB, BNB, CKB, DGB, SHIB, TRB, YB) and the two unidentified
ones a5 left unnamed (QNTB, USDEB). A tokenized stock listed in 2026 can never be binding (first
kline after the cutoff); the binding flag shows it.

Fetch, grid, checks and pacing are those of `a4_fetch_blind3.py` (4 workers, one shared pacer,
request starts >= 0.3 s apart, HTTP 429 pauses every worker 60 s, at most 5 retries per request).

Usage:
  python3 -I a6_fetch_blind5.py --work-dir DIR [--out-dir DIR] [--phases all|select,fetch,...]
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import a2_fetch_final_blind as F  # noqa: E402
import a4_fetch_blind3 as A  # noqa: E402
import a5_fetch_blind4 as B4  # noqa: E402

PREREG = {
    "repo": "membrane-board",
    "path": "design/HISTORY_TOUCH_PREREG_A6.md",
    "section": "A6.1",
    "commit": "3a38083",
    "sha256": "8fd0445ffad72db722244aaa1683e80d3431d19d400f396b3d9cfba32214a451",
}
DATASET = "blind5-prices"
STATUS = "CANONICAL, LOCKED BLIND SET 5 — do not score until A6.6"
RANK_FROM, RANK_TO = 241, 400
EXTEND_STEP = 40
MIN_PAIRS = 30

BLIND4_42 = {"AR", "AUDIO", "AXS", "BAR", "C98", "CAKE", "CHZ", "CKB", "COMP", "COTI", "CTSI", "DEXE", "DYDX", "ETC",
             "FLOW", "FTT", "GALA", "GRT", "JASMY", "JST", "KAVA", "LAZIO", "LPT", "LSK", "MBL", "MINA", "MOVR", "NMR",
             "ONG", "PHA", "QI", "RAD", "RUNE", "RVN", "SAND", "SNX", "SPELL", "SUPER", "TWT", "VET", "XTZ", "ZEN"}
USED = {**B4.USED, "blind-4 42": BLIND4_42}
TOKENIZED_STOCKS = set(B4.TOKENIZED_STOCKS)


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


def _rows(ranked: list[dict], lo: int, hi: int, all_bases: set[str], first_open) -> list[dict]:
    """Table rows for ranks lo..hi (1-based, inclusive)."""
    out = []
    for p in ranked[lo - 1:hi]:
        row = dict(p)
        row["excluded"] = exclusion_reason(p["baseAsset"], all_bases)
        ts, raw = first_open(p["symbol"])
        early = ts < F.FIRST_KLINE_BEFORE
        row.update({"firstKlineOpen": F.iso_utc(ts), "firstKlineOpenTs": ts, "firstKlineRaw": raw,
                    "keep": row["excluded"] is None and early,
                    "exclusionBinding": row["excluded"] is not None and early})
        out.append(row)
    return out


def select(ranked: list[dict], all_bases: set[str], first_open) -> tuple[list[dict], list[dict], dict]:
    """Rank window 241-400, extended in whole steps of 40 until >= 30 kept or the ranking ends.
    Returns (table, kept, window)."""
    hi = min(RANK_TO, len(ranked))
    table = _rows(ranked, RANK_FROM, hi, all_bases, first_open)
    steps = 0
    while sum(r["keep"] for r in table) < MIN_PAIRS and hi < len(ranked):
        new_hi = min(hi + EXTEND_STEP, len(ranked))
        table += _rows(ranked, hi + 1, new_hi, all_bases, first_open)
        hi = new_hi
        steps += 1
    kept = [{"symbol": r["symbol"], "baseAsset": r["baseAsset"], "rank": r["rank"],
             "firstKlineOpen": r["firstKlineOpen"]} for r in table if r["keep"]]
    window = {"registered": [RANK_FROM, RANK_TO], "final": [RANK_FROM, hi], "extension_steps": steps,
              "step": EXTEND_STEP, "min_pairs": MIN_PAIRS, "kept": len(kept),
              "ranking_ended": bool(hi >= len(ranked) and len(kept) < MIN_PAIRS)}
    return table, kept, window


# ---------------------------------------------------------------------------------------------
# Phases (fetch, build and check are a4's; select and write carry this set's rule and status)
# ---------------------------------------------------------------------------------------------


def rule_text() -> str:
    return ("Binance USDT spot pairs (quoteAsset USDT, status TRADING, isSpotTradingAllowed) ranked by 24 h "
            f"quoteVolume at fetch time; ranks {RANK_FROM}-{RANK_TO}, extended in whole steps of {EXTEND_STEP} ranks "
            f"until >= {MIN_PAIRS} pairs are kept or the ranking ends; exclude stablecoins/fiat/pegged, "
            "wrapped/staked, leveraged and tokenized-stock tokens and every pair already used (ETH, BTC, the A2 "
            "eight, the A3 ten, the blind-3 23, the blind-4 42); keep a pair whose first 1 h kline (startTime=0, "
            f"limit=1) opens before {F.iso_utc(F.FIRST_KLINE_BEFORE)}.")


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
        body, _ = F.cached_get(work, http_, log, "select", f"first-{sym}",
                               F.binance_klines_url(urllib.parse.quote(sym, safe=""), 0, 1), F.parse_binance)
        rows = F.parse_binance(body)
        if len(rows) != 1:
            raise F.FetchStop(f"first-kline probe for {sym} returned {len(rows)} rows")
        return rows[0][0], body.decode()

    table, kept, window = select(ranked, all_bases, first_open)
    sel = {
        "rule": rule_text(),
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
        "rankWindow": window,
        "window": table,
        "kept": kept,
        "fixedAt": F.now_utc(),
    }
    sel_path.write_text(json.dumps(sel, indent=1) + "\n")
    print(f"[select] window {window['final']} ({window['extension_steps']} extension steps); kept {len(kept)}: "
          f"{[(k['rank'], k['symbol'], k['firstKlineOpen'][:10]) for k in kept]}", file=sys.stderr)
    return sel


def git_info() -> dict:
    root = Path(__file__).resolve().parents[3]
    info = {}
    try:
        def g(*a):
            return subprocess.check_output(["git", "-C", str(root), *a], text=True).strip()
        info["sha"] = g("rev-parse", "HEAD")
        info["branch"] = g("rev-parse", "--abbrev-ref", "HEAD")
        for f in (Path(__file__).resolve(), Path(B4.__file__).resolve(), Path(A.__file__).resolve(),
                  Path(F.__file__).resolve()):
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
    for s in A.series_of(sel):
        pw = A.pair_work(work, s)
        pages = F.series_pages(pw, s)
        recs += pages
        unused += len(set(F.load_log(pw)) - {(p["series"], p["key"]) for p in pages})
        series_meta[s["id"]] = {"asset": s["asset"], "source": F.source_text(s), "file": A.out_name(s),
                                "pages": [{k: p.get(k) for k in ("key", "url", "status", "bytes", "sha256", "rows",
                                                                 "firstOpen", "lastOpen", "fetchedAt", "attempts")}
                                          for p in pages]}
    sel_recs = [r for (ser, _), r in log.items() if ser == "select"]
    recs += sel_recs
    sessions = [x for x in run_log["sessions"] if x.get("http", {}).get("requests")]
    http_tot = {"requests": sum(x["http"]["requests"] for x in sessions),
                "transport_errors": sum(x["http"]["status_counts"].get("transport", 0) for x in sessions),
                "retries": sum(x["http"]["retries"] for x in sessions),
                "max_used_weight_1m": max([x["http"]["max_used_weight_1m"] for x in sessions] or [0]),
                "logged_responses": len(recs), "logged_requests_unused": unused + len(log) - len(sel_recs)}
    manifest = {
        "dataset": DATASET, "status": STATUS, "prereg": PREREG, "endOpenUtc": F.iso_utc(F.END_OPEN),
        "rankWindow": sel["rankWindow"],
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
    pr, h, w = PREREG, manifest["http"], sel["rankWindow"]
    sess = []
    for x in manifest["sessions"]:
        c = x.get("code", {})
        files = "; ".join(f"`{n}` last commit `{v['last_commit']}` sha256 `{v['sha256']}`{' DIRTY' if v['dirty'] else ''}"
                          for n, v in c.items() if isinstance(v, dict))
        sess.append(f"  {', '.join(x['phases'])}: HEAD `{c.get('sha')}`; {files}.")
    g = (manifest["sessions"] or [{}])[-1].get("code", {})
    kept = ", ".join(f"{k['symbol']} (rank {k['rank']}, first kline {k['firstKlineOpen'][:10]})" for k in sel["kept"])
    binding = ", ".join(f"{r['rank']} {r['symbol']} ({r['excluded']}, first kline {r['firstKlineOpen'][:10]})"
                        for r in sel["window"] if r["exclusionBinding"])
    nonbinding = ", ".join(f"{r['rank']} {r['symbol']} ({r['excluded'] + ', ' if r['excluded'] else ''}"
                           f"first kline {r['firstKlineOpen'][:10]})"
                           for r in sel["window"] if not r["keep"] and not r["exclusionBinding"])
    lines = [
        f"# {DATASET} — provenance", "",
        f"**Status: {STATUS}.**", "",
        f"Q26 A6 blind set 5, fetched as preregistered in `{pr['repo']}` `{pr['path']}` §{pr['section']}",
        f"(commit `{pr['commit']}`, sha256 `{pr['sha256']}`). Locked until A6.6, which scores it once.",
        "The builder computed no outcome (no touch or drawdown frequency, no volatility statistic, no score).", "",
        "## Selection", "",
        f"- **Rule:** {sel['rule']}",
        f"- **Final rank window (recorded before any score):** {w['final'][0]}-{w['final'][1]} "
        f"(registered {w['registered'][0]}-{w['registered'][1]}, {w['extension_steps']} extension step(s) of "
        f"{w['step']}; {w['kept']} pairs kept; ranking ended before {w['min_pairs']}: {w['ranking_ended']}).",
        f"- **Snapshot:** `exchangeInfo` fetched {sel['exchangeInfo']['fetchedAt']} (serverTime "
        f"{sel['exchangeInfo']['serverTimeUtc']}), `ticker/24hr` fetched {sel['ticker24hr']['fetchedAt']} (24 h window to "
        f"{sel['ticker24hr']['maxCloseTimeUtc']}). {sel['usdtTradingSpotPairs']} USDT TRADING spot pairs ranked.",
        f"- **Kept ({len(sel['kept'])}):** {kept}.",
        f"- **Binding exclusions** (first kline before 2022-01-01, removed only by an exclusion): {binding or 'none'}.",
        f"- **Not kept, first kline on or after 2022-01-01** (any exclusion here is not binding): {nonbinding}.",
        "- Every rank in the final window was probed for its first kline (symbol percent-encoded in the URL).",
        "  Tokenized stocks carry no exchangeInfo tag, so they are a named list (the a5 list; the blind-4 snapshot",
        "  showed no further B-suffixed equity token), fixed before this snapshot was read",
        "  (`exclusionLists.tokenizedStocks` in `binance-selection.json`); the binding flag shows whether any",
        "  such label decides the list.",
        "- Raw bodies byte-for-byte: `binance-selection-exchangeInfo.json`, `binance-selection-ticker-24hr.json`;",
        "  rank table with exclusion reasons, first-kline raw text and binding flags: `binance-selection.json`.", "",
        "## Fetch", "",
        f"- **Source:** `{F.BINANCE_BASE}/klines?symbol=<PAIR>&interval=1h&startTime=<ms>&limit=1000` (free, no key),",
        "  header `user-agent: curl/8.5.0`, TLS verified; from `startTime=0` (the first kline), next page = last open + 1 h.",
        f"  {A.WORKERS} workers share one pacer (request starts ≥ {A.PACE_S} s apart); HTTP 429 pauses all workers 60 s.",
        f"- **Builder:** `The-Membrane/membrane-app` branch `{g.get('branch')}`, "
        "`scripts/research/history-forecasts/a6_fetch_blind5.py` (fetch/build/check from `a4_fetch_blind3.py`,",
        "  helpers from `a2_fetch_final_blind.py`, exclusion lists from `a5_fetch_blind4.py`). By session:",
        *sess,
        f"- **Fetch window (UTC):** {manifest['fetchWindowUtc'][0]} → {manifest['fetchWindowUtc'][1]}. {h['requests']} HTTP "
        f"attempts ({h['transport_errors']} transport errors), {h['retries']} retries, {h['logged_responses']} logged "
        f"responses (raw sha256 each in `manifest.json`); max Binance used weight per minute {h['max_used_weight_1m']}.",
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
        f"All pairs end at {manifest['endOpenUtc']}: {all(c['last_open'] == manifest['endOpenUtc'] for c in ser.values())}. "
        f"Duplicate klines {tot('duplicate_identical')} identical / 0 conflicting, "
        f"low > min(open, close) {tot('low_gt_min_open_close')}, high < max(open, close) {tot('high_lt_max_open_close')}, "
        f"low > high {tot('low_gt_high')}, non-positive prices {tot('nonpositive_price_values')}, negative volume "
        f"{tot('negative_volume')}, file matches raw: {all(c['file_matches_raw'] for c in ser.values())}. Null hours per "
        "year, halt klines and zero-volume hours per year are in `checks.json`.",
        "", "## Files", "", "| file | bytes | sha256 |", "|---|---:|---|",
    ]
    for p in sorted(out.iterdir()):
        if p.is_file() and p.name not in ("PROVENANCE.md", "SHA256SUMS"):
            lines.append(f"| `{p.name}` | {p.stat().st_size} | `{F.sha256_file(p)}` |")
    (out / "PROVENANCE.md").write_text("\n".join(lines) + "\n")
    sums = [f"{F.sha256_file(p)}  {p.name}" for p in sorted(out.iterdir()) if p.is_file() and p.name != "SHA256SUMS"]
    (out / "SHA256SUMS").write_text("\n".join(sums) + "\n")


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
    out = a.out_dir or F.datasets_dir() / DATASET
    work.mkdir(parents=True, exist_ok=True)
    rl_path = work / "run-log.json"
    run_log = json.loads(rl_path.read_text()) if rl_path.exists() else {"sessions": []}
    http_ = A.SharedHttp("binance", A.PACE_S, events_path=work / "events.jsonl")
    session = {"phases": list(phases), "started": F.now_utc(), "code": git_info()}
    rc = 0
    try:
        sel = phase_select(work, http_) if "select" in phases else A.load_selection(work)
        if "fetch" in phases:
            A.phase_fetch(work, http_, sel)
        if "build" in phases:
            A.phase_build(work, out, sel)
        if "check" in phases:
            A.phase_check(work, out, sel)
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
