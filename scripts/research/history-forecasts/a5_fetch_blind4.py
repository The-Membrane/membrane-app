#!/usr/bin/env python3
"""Q26 A5.1: fetch blind set 4 (Binance USDT spot pairs ranked 121-240). Data checks only.

Implements membrane-board `design/HISTORY_TOUCH_PREREG_A5.md` section A5.1 (registered at
membrane-board c0b400d). The set is LOCKED until A5.6: this builder computes no outcome (no touch
or drawdown frequency, no volatility statistic, no score). It checks the data only.

Selection (fixed once, at fetch time, from a saved snapshot): Binance USDT spot pairs (quoteAsset
USDT, status TRADING, isSpotTradingAllowed) ranked by 24 h quoteVolume; ranks 121-240; exclude
stablecoins/fiat/pegged, wrapped/staked, leveraged and tokenized-stock tokens and every pair
already used (ETH, BTC, the A2 eight, the A3 ten, the blind-3 23); keep a pair whose first 1 h
kline (startTime=0, limit=1) opens before 2022-01-01T00:00Z. Every rank in the window is probed
for its first kline; an exclusion is reported as binding only when that pair's first kline is
before the cutoff (the pair would otherwise be kept).

Fetch, grid, checks and pacing are those of `a4_fetch_blind3.py` (4 workers, one shared pacer,
request starts >= 0.3 s apart, HTTP 429 pauses every worker 60 s, at most 5 retries per request).

Usage:
  python3 -I a5_fetch_blind4.py --work-dir DIR [--out-dir DIR] [--phases all|select,fetch,...]
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

PREREG = {
    "repo": "membrane-board",
    "path": "design/HISTORY_TOUCH_PREREG_A5.md",
    "section": "A5.1",
    "commit": "c0b400d",
    "sha256": "f9af7a428e4b940e70fb8186c7d81da8337d5324f61d7bd532de590a8ae80301",
}
DATASET = "blind4-prices"
STATUS = "CANONICAL, LOCKED BLIND SET 4 — do not score until A5.6"
RANK_FROM, RANK_TO = 121, 240

BLIND3_23 = {"FET", "HBAR", "STX", "ICP", "GTC", "XLM", "AMP", "ATOM", "BCH", "RSR", "RLC", "DASH", "CRV", "DUSK",
             "CFX", "ONE", "AVA", "RAY", "SHIB", "CTK", "SKL", "DODO", "ALGO"}
USED = {**A.USED, "blind-3 23": BLIND3_23}
# Tokenized stocks (no exchangeInfo field, filter or permission group marks them). Fixed BEFORE the
# blind-4 snapshot was read: the a4 list plus every B-suffixed US equity/ETF token in the
# 2026-10-14 blind-3 exchangeInfo snapshot. Crypto bases ending in B (BNB, ARB, SHIB, CKB, TRB, BB,
# YB, DGB) and two unidentified ones (USDEB, QNTB) are not named. Whether any of this matters is
# shown by the binding flag: a tokenized-stock exclusion is binding only if the pair's first kline
# is before 2022-01-01.
TOKENIZED_STOCKS = A.TOKENIZED_STOCKS | {
    "TQQQB", "DRAMB", "BNCB", "AAOIB", "TSLAB", "METAB", "INTWB", "MRVLB", "LITEB", "NBISB", "CBRSB", "IRENB",
    "AGPUB", "EWYB", "AAPLB", "BABAB", "AXTIB", "COHRB", "WDCB", "AVGOB", "COINB", "CRWVB", "SECZB", "MSFTB",
    "MUUB", "MRNAB", "BMNRB", "TSMB", "HOODB", "RKLBB", "AMZNB", "ASTSB", "GSB", "ORCLB", "GLWB", "QCOMB",
    "STXB", "NFLXB", "AMATB", "ARMB", "BEB", "PLTRB", "SQQQB", "SPYB", "ASMLB", "SHAZB", "NOKB", "USARB",
    "MVLLB", "CYPHB", "ALABB", "DELLB", "PDDB", "JPMB", "AMCB", "IBMB", "GMEB", "FLNCB", "CRWDB", "CRDOB",
    "SMHB", "CRMB", "SMCIB", "RDDTB", "ADBEB", "PYPLB", "HIMSB", "HPEB", "FWDIB", "DJTB", "ZMB", "LLYB",
    "GPROB", "WENB",
}


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
    """Rank window -> (table, kept); first_open(symbol) -> (open s, raw text) for every pair in it."""
    table, kept = [], []
    for p in ranked[RANK_FROM - 1:RANK_TO]:
        row = dict(p)
        row["excluded"] = exclusion_reason(p["baseAsset"], all_bases)
        ts, raw = first_open(p["symbol"])
        early = ts < F.FIRST_KLINE_BEFORE
        row.update({"firstKlineOpen": F.iso_utc(ts), "firstKlineOpenTs": ts, "firstKlineRaw": raw,
                    "keep": row["excluded"] is None and early,
                    "exclusionBinding": row["excluded"] is not None and early})
        if row["keep"]:
            kept.append({"symbol": p["symbol"], "baseAsset": p["baseAsset"], "rank": p["rank"],
                         "firstKlineOpen": row["firstKlineOpen"]})
        table.append(row)
    return table, kept


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

    table, kept = select(ranked, all_bases, first_open)
    sel = {
        "rule": ("Binance USDT spot pairs (quoteAsset USDT, status TRADING, isSpotTradingAllowed) ranked by 24 h "
                 f"quoteVolume at fetch time; ranks {RANK_FROM}-{RANK_TO}; exclude stablecoins/fiat/pegged, "
                 "wrapped/staked, leveraged and tokenized-stock tokens and every pair already used (ETH, BTC, "
                 "the A2 eight, the A3 ten, the blind-3 23); keep a pair whose first 1 h kline (startTime=0, "
                 f"limit=1) opens before {F.iso_utc(F.FIRST_KLINE_BEFORE)}."),
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
    print(f"[select] kept {len(kept)}: {[(k['rank'], k['symbol'], k['firstKlineOpen'][:10]) for k in kept]}",
          file=sys.stderr)
    return sel


def git_info() -> dict:
    root = Path(__file__).resolve().parents[3]
    info = {}
    try:
        def g(*a):
            return subprocess.check_output(["git", "-C", str(root), *a], text=True).strip()
        info["sha"] = g("rev-parse", "HEAD")
        info["branch"] = g("rev-parse", "--abbrev-ref", "HEAD")
        for f in (Path(__file__).resolve(), Path(A.__file__).resolve(), Path(F.__file__).resolve()):
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
    binding = ", ".join(f"{r['rank']} {r['symbol']} ({r['excluded']}, first kline {r['firstKlineOpen'][:10]})"
                        for r in sel["window"] if r["exclusionBinding"])
    nonbinding = ", ".join(f"{r['rank']} {r['symbol']} ({r['excluded'] + ', ' if r['excluded'] else ''}"
                           f"first kline {r['firstKlineOpen'][:10]})"
                           for r in sel["window"] if not r["keep"] and not r["exclusionBinding"])
    lines = [
        f"# {DATASET} — provenance", "",
        f"**Status: {STATUS}.**", "",
        f"Q26 A5 blind set 4, fetched as preregistered in `{pr['repo']}` `{pr['path']}` §{pr['section']}",
        f"(commit `{pr['commit']}`, sha256 `{pr['sha256']}`). Locked until A5.6, which scores it once.",
        "The builder computed no outcome (no touch or drawdown frequency, no volatility statistic, no score).", "",
        "## Selection", "",
        f"- **Rule:** {sel['rule']}",
        f"- **Snapshot:** `exchangeInfo` fetched {sel['exchangeInfo']['fetchedAt']} (serverTime "
        f"{sel['exchangeInfo']['serverTimeUtc']}), `ticker/24hr` fetched {sel['ticker24hr']['fetchedAt']} (24 h window to "
        f"{sel['ticker24hr']['maxCloseTimeUtc']}). {sel['usdtTradingSpotPairs']} USDT TRADING spot pairs ranked.",
        f"- **Kept ({len(sel['kept'])}):** {kept}.",
        f"- **Binding exclusions** (first kline before 2022-01-01, removed only by an exclusion): {binding or 'none'}.",
        f"- **Not kept, first kline on or after 2022-01-01** (any exclusion here is not binding): {nonbinding}.",
        "- Every rank in the window was probed for its first kline (symbol percent-encoded in the URL).",
        "  Tokenized stocks carry no exchangeInfo tag, so they are a named list, fixed before this snapshot was",
        "  read (`exclusionLists.tokenizedStocks` in `binance-selection.json`); the binding flag shows whether any",
        "  such label decides the list.",
        "- Raw bodies byte-for-byte: `binance-selection-exchangeInfo.json`, `binance-selection-ticker-24hr.json`;",
        "  rank table with exclusion reasons, first-kline raw text and binding flags: `binance-selection.json`.", "",
        "## Fetch", "",
        f"- **Source:** `{F.BINANCE_BASE}/klines?symbol=<PAIR>&interval=1h&startTime=<ms>&limit=1000` (free, no key),",
        "  header `user-agent: curl/8.5.0`, TLS verified; from `startTime=0` (the first kline), next page = last open + 1 h.",
        f"  {A.WORKERS} workers share one pacer (request starts ≥ {A.PACE_S} s apart); HTTP 429 pauses all workers 60 s.",
        f"- **Builder:** `The-Membrane/membrane-app` branch `{g.get('branch')}`, "
        "`scripts/research/history-forecasts/a5_fetch_blind4.py` (fetch/build/check from `a4_fetch_blind3.py`,",
        "  helpers from `a2_fetch_final_blind.py`). By session:",
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
