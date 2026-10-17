#!/usr/bin/env python3
"""Q26 R8.3 (workstream A8): fetch blind set 7 (every not-yet-used Binance USDT spot pair with a first 1 h kline
before 2024-01-01, ranked by 24 h quote volume). Data checks only.

Implements membrane-board `design/Q26_ROUND8_PREREG.md` section R8.3 (registered at membrane-board 91a3eba). The set
is LOCKED until it is scored once by `a8_touch.py --phase blind7`: this builder computes no outcome (no touch or
drawdown frequency, no volatility statistic, no score). It checks the data only.

Selection (fixed once, at fetch time, from a saved snapshot): Binance USDT spot pairs (quoteAsset USDT, status
TRADING, isSpotTradingAllowed) ranked by 24 h quoteVolume. EVERY rank is probed for its first 1 h kline
(startTime=0, limit=1). A pair is kept when its first kline opens before 2024-01-01T00:00Z and it is not excluded.
Exclusions: every pair already used in A2-A7 (ETH, BTC, the A2 eight, the A3 ten, the blind-3 23, the blind-4 42,
the blind-5 42, the blind-6 61), and the inherited A2-A7 category exclusions (stablecoins/fiat/pegged,
wrapped/staked, leveraged and tokenized-stock tokens). R8.3 has NO fallback cutoff: if fewer than 20 pairs are kept,
the selection is written, nothing is fetched, the builder exits 3 and A8 stops at the dev phase. There is no rank
window and no cap. The end is the A6 grid end (the kline opening 2026-10-06T02:00Z, inclusive; R8.3 names no end),
so every A-series loader reads the files unchanged.

Fetch, grid, checks and pacing are those of `a4_fetch_blind3.py` (4 workers, one shared pacer, request starts
>= 0.3 s apart, HTTP 429 pauses every worker 60 s, at most 5 retries per request); host data-api.binance.vision.

Usage:
  python3 -I a8_fetch_blind7.py --work-dir DIR [--out-dir DIR] [--phases all|select,fetch,build,check,write]
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
import a6_fetch_blind5 as B5  # noqa: E402
import a7_fetch_blind6 as B6  # noqa: E402

PREREG = {
    "repo": "membrane-board",
    "path": "design/Q26_ROUND8_PREREG.md",
    "section": "R8.3",
    "commit": "91a3eba",
    "sha256": "70113555236390a8ccc570dc14a3f7cc54aa12064b50f8f69be39cefa4b3ff64",
}
DATASET = "blind7-prices"
STATUS = "CANONICAL, LOCKED BLIND SET 7 — do not score until the single R8.3 blind run (a8_touch.py --phase blind7)"
CUTOFF = 1704067200           # 2024-01-01T00:00Z
MIN_PAIRS = 20

BLIND6_61 = {"ACH", "ACM", "AGLD", "ALPINE", "APE", "API3", "APT", "ARPA", "ASR", "ASTR", "BAND", "BNT", "BTTC", "CELR",
             "CVC", "DGB", "GLMR", "GMT", "GMX", "GNO", "HIVE", "HOT", "IMX", "IOTA", "JOE", "KNC", "LDO", "LUNC",
             "MAGIC", "MTL", "NEXO", "OGN", "OP", "OSMO", "PEOPLE", "POLYX", "POWR", "PSG", "PUNDIX", "QTUM", "QUICK",
             "RARE", "REQ", "RIF", "SANTOS", "SC", "SFP", "SLP", "STEEM", "STRAX", "T", "TFUEL", "TRB", "WIN", "WOO",
             "XNO", "XVG", "XVS", "YFI", "ZIL", "ZRX"}
USED = {**B6.USED, "blind-6 61": BLIND6_61}
TOKENIZED_STOCKS = set(B6.TOKENIZED_STOCKS)


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


def _mark(table: list[dict], cutoff: int) -> None:
    for row in table:
        early = row["firstKlineOpenTs"] < cutoff
        row["keep"] = row["excluded"] is None and early
        row["exclusionBinding"] = row["excluded"] is not None and early


def select(ranked: list[dict], all_bases: set[str], first_open) -> tuple[list[dict], list[dict], dict]:
    """Every rank probed; keep = not excluded and first kline before 2024-01-01. No fallback (R8.3): fewer than 20
    kept -> rule["enough"] is False (the caller stops before any fetch). Returns (table, kept, rule)."""
    table = []
    for p in ranked:
        row = dict(p)
        row["excluded"] = exclusion_reason(p["baseAsset"], all_bases)
        ts, raw = first_open(p["symbol"])
        row.update({"firstKlineOpen": F.iso_utc(ts), "firstKlineOpenTs": ts, "firstKlineRaw": raw})
        table.append(row)
    _mark(table, CUTOFF)
    kept = [{"symbol": r["symbol"], "baseAsset": r["baseAsset"], "rank": r["rank"],
             "firstKlineOpen": r["firstKlineOpen"]} for r in table if r["keep"]]
    rule = {"registered_cutoff": F.iso_utc(CUTOFF), "fallback_cutoff": None, "min_pairs": MIN_PAIRS,
            "kept_under_registered_cutoff": len(kept), "cutoff_moved": False, "cutoff_used": F.iso_utc(CUTOFF),
            "cutoff_used_ts": CUTOFF, "kept": len(kept), "ranks_probed": len(table),
            "enough": len(kept) >= MIN_PAIRS}
    return table, kept, rule


def rule_text() -> str:
    return ("Binance USDT spot pairs (quoteAsset USDT, status TRADING, isSpotTradingAllowed) ranked by 24 h "
            "quoteVolume at fetch time; every rank probed; keep every pair whose first 1 h kline (startTime=0, "
            f"limit=1) opens before {F.iso_utc(CUTOFF)} and that is not excluded (every pair already used: ETH, BTC, "
            "the A2 eight, the A3 ten, the blind-3 23, the blind-4 42, the blind-5 42, the blind-6 61; and the "
            "inherited stablecoin/fiat/pegged, wrapped/staked, leveraged and tokenized-stock exclusions); if fewer "
            f"than {MIN_PAIRS} qualify, A8 stops at the dev phase (no fallback). No rank window, no cap.")


# ---------------------------------------------------------------------------------------------
# Phases (fetch, build and check are a4's; select and write carry this set's rule and status)
# ---------------------------------------------------------------------------------------------


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

    table, kept, rule = select(ranked, all_bases, first_open)
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
        "cutoffRule": rule,
        "window": table,
        "kept": kept,
        "fixedAt": F.now_utc(),
    }
    sel_path.write_text(json.dumps(sel, indent=1) + "\n")
    print(f"[select] cutoff {rule['cutoff_used']} (no fallback); kept {len(kept)} (enough: {rule['enough']}): "
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
        for f in (Path(__file__).resolve(), Path(B6.__file__).resolve(), Path(B5.__file__).resolve(),
                  Path(A.__file__).resolve(), Path(F.__file__).resolve()):
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
        "cutoffRule": sel["cutoffRule"],
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
    pr, h, w = PREREG, manifest["http"], sel["cutoffRule"]
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
    n_late = sum(1 for r in sel["window"] if not r["keep"] and not r["exclusionBinding"])
    lines = [
        f"# {DATASET} — provenance", "",
        f"**Status: {STATUS}.**", "",
        f"Q26 R8.3 (workstream A8) blind set 7, fetched as preregistered in `{pr['repo']}` `{pr['path']}` "
        f"§{pr['section']}",
        f"(commit `{pr['commit']}`, sha256 `{pr['sha256']}`). Locked until the single R8.3 blind run.",
        "The builder computed no outcome (no touch or drawdown frequency, no volatility statistic, no score).", "",
        "## Selection", "",
        f"- **Rule:** {sel['rule']}",
        f"- **Cutoff used (recorded before any score):** first kline before {w['cutoff_used']} "
        f"(registered; no fallback; minimum {w['min_pairs']}). {w['kept']} pairs kept; "
        f"{w['ranks_probed']} ranks probed.",
        f"- **Snapshot:** `exchangeInfo` fetched {sel['exchangeInfo']['fetchedAt']} (serverTime "
        f"{sel['exchangeInfo']['serverTimeUtc']}), `ticker/24hr` fetched {sel['ticker24hr']['fetchedAt']} (24 h window to "
        f"{sel['ticker24hr']['maxCloseTimeUtc']}). {sel['usdtTradingSpotPairs']} USDT TRADING spot pairs ranked.",
        f"- **Kept ({len(sel['kept'])}):** {kept}.",
        f"- **Binding exclusions** (first kline before the cutoff used, removed only by an exclusion): "
        f"{binding or 'none'}.",
        f"- **Not kept, first kline on or after the cutoff used:** {n_late} pairs (listed with their first kline and "
        "any exclusion in `binance-selection.json`; no such exclusion is binding).",
        "- Every rank was probed for its first kline (symbol percent-encoded in the URL). Tokenized stocks carry no",
        "  exchangeInfo tag, so they are the a5/a6 named list; any tokenized stock listed in 2025-2026 cannot be",
        "  binding (first kline after the cutoff).",
        "- Raw bodies byte-for-byte: `binance-selection-exchangeInfo.json`, `binance-selection-ticker-24hr.json`;",
        "  rank table with exclusion reasons, first-kline raw text and binding flags: `binance-selection.json`.", "",
        "## Fetch", "",
        f"- **Source:** `{F.BINANCE_BASE}/klines?symbol=<PAIR>&interval=1h&startTime=<ms>&limit=1000` (free, no key),",
        "  header `user-agent: curl/8.5.0`, TLS verified; from `startTime=0` (the first kline), next page = last open + 1 h.",
        f"  {A.WORKERS} workers share one pacer (request starts ≥ {A.PACE_S} s apart); HTTP 429 pauses all workers 60 s.",
        f"- **Builder:** `The-Membrane/membrane-app` branch `{g.get('branch')}`, "
        "`scripts/research/history-forecasts/a8_fetch_blind7.py` (fetch/build/check from `a4_fetch_blind3.py`,",
        "  helpers from `a2_fetch_final_blind.py`, exclusion lists from `a7_fetch_blind6.py`). By session:",
        *sess,
        f"- **Fetch window (UTC):** {manifest['fetchWindowUtc'][0]} → {manifest['fetchWindowUtc'][1]}. {h['requests']} HTTP "
        f"attempts ({h['transport_errors']} transport errors), {h['retries']} retries, {h['logged_responses']} logged "
        f"responses (raw sha256 each in `manifest.json`); max Binance used weight per minute {h['max_used_weight_1m']}.",
        f"- **End:** the kline opening {manifest['endOpenUtc']}, inclusive (the A6 grid end; R8.3 names no end).",
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
            if p.stat().st_size >= F.MAX_FILE_BYTES:
                raise SystemExit(f"STOP: {p.name} is >= 50 MB")
            lines.append(f"| `{p.name}` | {p.stat().st_size} | `{F.sha256_file(p)}` |")
    (out / "PROVENANCE.md").write_text("\n".join(lines) + "\n")
    sums = [f"{F.sha256_file(p)}  {p.name}" for p in sorted(out.iterdir()) if p.is_file() and p.name != "SHA256SUMS"]
    (out / "SHA256SUMS").write_text("\n".join(sums) + "\n")


class NotEnough(Exception):
    pass


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
        if not sel["cutoffRule"]["enough"]:
            raise NotEnough(f"{sel['cutoffRule']['kept']} pairs qualify (< {MIN_PAIRS}); R8.3: A8 stops at dev")
        if "fetch" in phases:
            A.phase_fetch(work, http_, sel)
        if "build" in phases:
            A.phase_build(work, out, sel)
        if "check" in phases:
            A.phase_check(work, out, sel)
    except NotEnough as e:
        print(f"STOP: {e}", file=sys.stderr)
        rc = 3
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
