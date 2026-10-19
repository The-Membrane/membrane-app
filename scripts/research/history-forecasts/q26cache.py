"""q26cache: shared, hash-indexed local data cache for Q26 acquisitions (board RULING Q26 speed-ups, 2026-10-19).

README
======

Why: Q26 agents fetch the same free data again and again (Binance/OKX/Bybit/KuCoin/MEXC klines and trades,
Chainlink AnswerUpdated logs, Aave pool and aToken logs, Uniswap V3 Swap logs, block headers). This module keeps one
copy on local disk, keyed by what was fetched, so the next agent reads it instead of the network.

Layout (shared root, default ``<scratchpad>/q26cache``, override with ``Q26_CACHE_DIR``)::

    entries/<kk>/<key_id>.json   manifest: key fields, sha256, bytes, source URL (redacted), fetch time,
                                 published checksum (when the source publishes one), caller metadata
    blobs/<ss>/<sha256>.gz       gzip of the payload, content-addressed (identical payloads share one blob)
    blockts.sqlite               block-header timestamps per chain (never 0, never defaulted)
    .lock                        fcntl lock for writes and eviction

``key_id = sha256(canonical JSON of the Key)``. A Key is (source, dataset, symbol, period) plus optional chain.
Conventions: source = venue or ``rpc`` (``binance``, ``okx``, ``bybit``, ``kucoin``, ``mexc``, ``gate``,
``poloniex``, ``bitfinex``, ``histdata``, ``b3``, ``rpc``); chain = ``ethereum``, ``arbitrum``, ``polygon``, ``base``,
``optimism``, ``avalanche`` ... for RPC data; dataset = what it is (``klines-1h``, ``trades``,
``logs:<topic0>``, ``aave-v3-pool-logs``, ``uniswap-v3-swap-logs``); symbol = pair, base asset, or contract;
period = ``YYYY-MM``, ``YYYY-MM-DD``, ``A..B`` dates, or ``<from>-<to>`` blocks. Only finished periods (closed months,
blocks behind the chain head) may be cached: a cache entry is never refreshed.

API::

    from q26cache import Cache, Key
    c = Cache()                                    # Q26_CACHE_DIR or the default
    k = Key("binance", "klines-1h-monthly", "ABCUSDT", "2024-05")
    raw = c.get_or_fetch(k, lambda: http_get(url), source_url=url, published_sha256=checksum)
    obj = c.get_or_fetch_json(Key("rpc", "logs:<topic0>", "<contract>", "100-199", chain="ethereum"),
                              lambda: fetch_logs(...), source_url=rpc_url)
    logs = cached_get_logs(c, "ethereum", "<contract>", "<topic0>", lo, hi, fetch, chunk=2_000_000,
                           finalized_block=head - 64)
    ts = BlockTimestamps(c).get_or_fetch("ethereum", block, header_fetch)   # raises, never returns 0

Size cap: ``Q26_CACHE_MAX_BYTES`` (default 1.5 GiB; the cloud disk has about 6.9 GB free). After each put, the
least-recently-used entries (blob mtime is touched on every hit) are evicted until the root is under 90% of the cap.

RPC endpoints and routing: ``rpc_endpoints(chain, keyless, kind)`` / ``endpoints_for(chain, method, keyless)``.
ARCHIVE STATE READS (eth_call such as observe(), getUserAccountData, getReserveNormalized*, balanceOf; eth_getBalance;
block headers; eth_blockNumber) go to the provider URL from the environment first, keyless endpoints as fallback.
LOG SCANS (eth_getLogs) stay on the keyless endpoints only: the owner's provider key is a free tier whose
eth_getLogs is capped at a 10-block range (measured 2026-10-19). ``provider_log_endpoints`` exists only as an explicit
fallback with windows of at most ``PROVIDER_LOG_MAX_SPAN`` (10) blocks. In the cloud session the key is in a chmod-600
file in the scratchpad (``source`` it; it sets Q26_ETH_RPC_URL; other chains not enabled yet). Variables
(comma-separated lists allowed):
``Q26_ETH_RPC_URL``, ``Q26_ARB_RPC_URL``, ``Q26_POLYGON_RPC_URL``, ``Q26_BASE_RPC_URL``, ``Q26_OP_RPC_URL``,
``Q26_AVAX_RPC_URL``, ``Q26_BSC_RPC_URL``, ``Q26_GNOSIS_RPC_URL``. An environment URL is never printed, logged or
written: ``redact(url)`` returns ``env:<VAR>`` for it, and replaces any key-like path segment, query value or
userinfo in other URLs with ``<redacted>``. Manifests store only the redacted form.

Blind-set guard: every get/put/get_or_fetch first asks ``BlindGuard`` whether the key belongs to a reserved, held-back,
confirmatory or locked blind set of ``design/q26-blind-set-inventory-2026-10-17.md`` (membrane-board). The guard reads
that file at start (path: ``Q26_BLIND_INVENTORY``, else ``<board>/design/...`` beside this repo, ``~/membrane-board``
or ``/home/user/membrane-board``) and fails closed when it cannot find it. For each set id it parses the status and
the registered owner item ids (``R13.5``, ``R11.1-v4`` ... named in the set's row or in an "assigned/reassigned as
the confirmatory set for Rx" update; "revised Rx" and "not read in Rx" do not count). Membership comes from the
selection files in membrane-datasets (``Q26_DATASETS_DIR``), symbol lists printed in the inventory, and chain /
protocol rules. A matching key is refused (``BlindSetError``) unless the caller passes ``owner=<item id>`` that the
inventory registers for that set; owned data goes to a separate per-set root (``<root>-locked/<set>``), never into
the shared root. Sets the inventory or the board records as scored once (grade C) are released. A key with a raw
contract address can only match via a selection file; for other blind data the caller must pass ``blind_set=``.

Tests: ``python3 -m unittest scripts/research/history-forecasts/test_q26cache.py`` (synthetic, no network).
No address, key or secret is stored in this file.
"""
from __future__ import annotations

import contextlib
import dataclasses
import fcntl
import gzip
import hashlib
import json
import os
import re
import sqlite3
import tempfile
import threading
import time
from datetime import datetime, timezone
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode

DEFAULT_ROOT = "/tmp/claude-0/-home-user/5db7bc9d-0d68-5d3f-a50f-faa01897ef28/scratchpad/q26cache"
DEFAULT_MAX_BYTES = int(1.5 * (1 << 30))
SCHEMA = "q26cache-v1"

RPC_ENV = {
    "ethereum": "Q26_ETH_RPC_URL", "arbitrum": "Q26_ARB_RPC_URL", "polygon": "Q26_POLYGON_RPC_URL",
    "base": "Q26_BASE_RPC_URL", "optimism": "Q26_OP_RPC_URL", "avalanche": "Q26_AVAX_RPC_URL",
    "bsc": "Q26_BSC_RPC_URL", "gnosis": "Q26_GNOSIS_RPC_URL",
}
CHAIN_ALIASES = {"eth": "ethereum", "mainnet": "ethereum", "arb": "arbitrum", "arbitrum-one": "arbitrum",
                 "matic": "polygon", "op": "optimism", "avax": "avalanche", "bnb": "bsc", "xdai": "gnosis"}


class BlindSetError(PermissionError):
    pass


class CacheIntegrityError(RuntimeError):
    pass


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def norm_chain(chain):
    if chain is None:
        return None
    c = str(chain).strip().lower()
    return CHAIN_ALIASES.get(c, c)


# =====================================================================================================================
# URL redaction and RPC endpoints
# =====================================================================================================================

_KEYLIKE = re.compile(r"^(?=.*[0-9])(?=.*[A-Za-z])[A-Za-z0-9_\-]{16,}$|^[0-9a-fA-F]{24,}$")
_KEY_PARAMS = {"key", "apikey", "api_key", "api-key", "token", "access_token", "auth", "secret", "x-api-key"}


def _env_urls():
    out = {}
    for var in RPC_ENV.values():
        for u in (os.environ.get(var) or "").split(","):
            if u.strip():
                out[u.strip()] = var
    return out


def redact(url):
    """Safe display form of a URL. An environment-provided URL becomes ``env:<VAR>``. In any other URL, userinfo,
    key-like path segments and key-like query values become ``<redacted>``."""
    if url is None:
        return None
    u = str(url).strip()
    env = _env_urls()
    if u in env:
        return f"env:{env[u]}"
    try:
        p = urlsplit(u)
    except ValueError:
        return "<redacted>"
    if not p.scheme or not p.netloc:
        return "<redacted>" if _KEYLIKE.search(u) else u
    host = p.hostname or ""
    if p.port:
        host = f"{host}:{p.port}"
    if p.username or p.password:
        host = "<redacted>@" + host
    segs = ["<redacted>" if _KEYLIKE.match(s) else s for s in p.path.split("/")]
    q = [(k, "<redacted>" if (k.lower() in _KEY_PARAMS or _KEYLIKE.match(v)) else v)
         for k, v in parse_qsl(p.query, keep_blank_values=True)]
    return urlunsplit((p.scheme, host, "/".join(segs), urlencode(q, safe="<>"), ""))


LOG_METHODS = frozenset({"eth_getLogs", "eth_newFilter", "eth_getFilterLogs"})


def rpc_endpoints(chain, keyless, kind="state"):
    """Endpoint list for ``chain`` and request ``kind``.

    kind="state" (eth_call, eth_getBalance, eth_getStorageAt, eth_getBlockByNumber headers, eth_blockNumber):
        the URL(s) in the chain's Q26_*_RPC_URL variable first (if set), then the caller's keyless list.
    kind="logs" (eth_getLogs): the keyless list only. The owner's provider key is a free tier whose eth_getLogs is
        capped at a 10-block range (measured 2026-10-19), so log scans stay on the keyless endpoints; use
        ``provider_log_endpoints`` only as an explicit fallback with windows of at most 10 blocks.
    Never print the result directly; use ``redact``."""
    if kind not in ("state", "logs"):
        raise ValueError(f"kind must be 'state' or 'logs', not {kind!r}")
    env = provider_endpoints(chain) if kind == "state" else []
    out = []
    for u in env + list(keyless):
        if u not in out:
            out.append(u)
    return out


def provider_endpoints(chain):
    """The URL(s) in the chain's Q26_*_RPC_URL variable (empty list when unset). Keyed: never print them."""
    var = RPC_ENV.get(norm_chain(chain))
    return [u.strip() for u in (os.environ.get(var) or "").split(",") if u.strip()] if var else []


PROVIDER_LOG_MAX_SPAN = 10      # free-tier eth_getLogs cap of the owner's provider key (measured 2026-10-19)


def provider_log_endpoints(chain):
    """Fallback only: provider URL(s) for eth_getLogs, to be used with block windows of at most
    PROVIDER_LOG_MAX_SPAN blocks."""
    return provider_endpoints(chain)


def endpoints_for(chain, method, keyless):
    """Route one JSON-RPC method: log scans -> keyless only; archive state reads and headers -> provider first."""
    return rpc_endpoints(chain, keyless, kind="logs" if method in LOG_METHODS else "state")


# =====================================================================================================================
# Keys
# =====================================================================================================================

@dataclasses.dataclass(frozen=True)
class Key:
    source: str
    dataset: str
    symbol: str
    period: str
    chain: str | None = None

    def norm(self):
        sym = str(self.symbol).strip()
        if re.fullmatch(r"0x[0-9a-fA-F]{40}", sym):
            sym = sym.lower()
        return {"source": str(self.source).strip().lower(), "dataset": str(self.dataset).strip(),
                "symbol": sym, "period": str(self.period).strip(), "chain": norm_chain(self.chain)}

    def key_id(self):
        return hashlib.sha256(json.dumps(self.norm(), sort_keys=True, separators=(",", ":")).encode()).hexdigest()


# =====================================================================================================================
# Blind-set guard
# =====================================================================================================================

_ID_RE = re.compile(r"^(?:[A-Z]{1,3}\d+[a-z]?(?:-[A-Za-z]+)?|[A-Z]{2,3}-[AB]|P3b-[ab]|P3[bc]|SVC?\d)$")
_ITEM_RE = re.compile(r"(?<![A-Za-z\-])(R\d+(?:\.\d+)+(?:-v\d+)?|R\d+\.\d+)(?![\w.])")
_NEG_RES = (re.compile(r"revised\s+(R\d+(?:\.\d+)+(?:-v\d+)?)", re.I),
            re.compile(r"not\s+(?:acquired\s+or\s+read|read|acquired|to\s+be\s+read)\s+(?:in|for|by)\s+"
                       r"(R\d+(?:\.\d+)+(?:-v\d+)?)", re.I))
_OWNER_RE = re.compile(r"confirm(?:ation|atory\s+set)?\s*(?:for|:)\s*(R\d+(?:\.\d+)+(?:-v\d+)?)", re.I)
_PROTECT_RE = re.compile(r"reserve|held back|confirm|locked|blind-test-only|unread|not read", re.I)
_NOT_BLIND_RE = re.compile(r"not blind|never a blind test", re.I)

# Sets scored once (grade C for their target, inventory rule 3) per board CHECKPOINT entries that the inventory text
# does not yet mark "is now grade C". Board tags: B9/B10 R12.1, B11 R12.4, B12 R12.5, B13a R12.6, B13b R12.7,
# B17a R12.9, C1 R11.11, C2 R10.4-B, P3 (blind8) R11.10 P3. Add a set here only with its board CHECKPOINT.
RELEASED_BY_BOARD = frozenset({"B9", "B10", "B11", "B12", "B13a", "B13b", "B17a", "C1", "C2", "P3"})

_CEX_QUOTES = ("USDT", "USDC", "USD", "BUSD", "FDUSD")


def cex_base(symbol):
    """'ABC_USDT', 'ABC-USDT', 'ABC/USDT', 'ABCUSDT', 'tABCUSD' -> 'ABC'."""
    s = str(symbol).strip().upper()
    s = re.split(r"[_\-/:]", s)[0] if re.search(r"[_\-/:]", s) else s
    for q in _CEX_QUOTES:
        if s.endswith(q) and len(s) > len(q):
            return s[:-len(q)]
    return s


def instrument_check(key):
    """q26_instrument rule on a cache Key (CEX price keys only); raises InstrumentExclusionError for a leveraged
    token. Returns the symbol class (None, 'pegged', 'pegged?', ...) otherwise."""
    import sys as _sys
    _here = os.path.dirname(os.path.abspath(__file__))
    if _here not in _sys.path:
        _sys.path.insert(0, _here)
    import q26_instrument as _QI
    return _QI.instrument_check(key.source, key.symbol, cex_base)


def _hash_byte(salt, s):
    return hashlib.sha256((salt + s).encode()).digest()[0]


_DATE_RE = re.compile(r"(\d{4})(?:-?(\d{2}))?(?:-?(\d{2}))?")


def _period_days(period):
    """(first_day, last_day) as 'YYYY-MM-DD' strings, or None when the period is not a date span (blocks etc.)."""
    p = str(period).strip()
    parts = re.split(r"\.\.|/|_to_|→", p)
    if len(parts) == 1 and re.fullmatch(r"\d{4}(?:-\d{2}){0,2}|\d{6}|\d{8}", p):
        parts = [p, p]
    if len(parts) != 2:
        return None
    out = []
    for i, s in enumerate(parts):
        m = _DATE_RE.fullmatch(s.strip())
        if not m or not (1990 <= int(m.group(1)) <= 2100):
            return None
        y, mo, d = m.group(1), m.group(2), m.group(3)
        if i == 0:
            out.append(f"{y}-{mo or '01'}-{d or '01'}")
        else:
            out.append(f"{y}-{mo or '12'}-{d or '31'}")
    return tuple(out)


def _overlaps(period, lo, hi):
    span = _period_days(period)
    if span is None:
        return True            # unknown span: fail closed
    return not (span[1] < lo or span[0] > hi)


def default_inventory_path():
    env = os.environ.get("Q26_BLIND_INVENTORY")
    if env:
        return env
    rel = "design/q26-blind-set-inventory-2026-10-17.md"
    here = os.path.dirname(os.path.abspath(__file__))
    for board in (os.path.join(here, "..", "..", "..", "..", "membrane-board"),
                  os.path.expanduser("~/membrane-board"), "/home/user/membrane-board", "/Users/EBmic/membrane-board"):
        p = os.path.normpath(os.path.join(board, rel))
        if os.path.exists(p):
            return p
    return None


def default_datasets_dir():
    env = os.environ.get("Q26_DATASETS_DIR")
    if env:
        return env
    here = os.path.dirname(os.path.abspath(__file__))
    for d in (os.path.join(here, "..", "..", "..", "..", "membrane-datasets"),
              os.path.expanduser("~/membrane-datasets"), "/home/user/membrane-datasets"):
        if os.path.isdir(d):
            return os.path.normpath(d)
    return None


def parse_inventory(text):
    """Set id -> {'status': 'protected'|'open', 'owners': set, 'released': bool, 'row': str}."""
    sets = {}
    heading_items = set()
    for line in text.splitlines():
        if line.startswith("#"):
            heading_items = {m.group(1) for m in _ITEM_RE.finditer(line)}
            continue
        if not line.startswith("|") or line.startswith("|---"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if not cells:
            continue
        first = cells[0].replace("**", "").strip()
        tok = first.split(" ")[0] if first else ""
        if not _ID_RE.match(tok) or tok in ("Id", "Set"):
            continue
        row = " | ".join(cells[1:]) if first == tok else first + " | " + " | ".join(cells[1:])
        neg = {m.group(1) for r in _NEG_RES for m in r.finditer(row)}
        # owner = the item a "Confirm..." clause names; a bare "Confirm" inherits the section heading's one item.
        # Items named only as exposure ("R11.8 daily totals seen") or as "revised Rx" are not owners.
        owners = {m.group(1) for m in _OWNER_RE.finditer(row.replace("**", ""))} - neg
        if not owners and re.search(r"\bconfirm\b", row.replace("**", ""), re.I) and len(heading_items) == 1:
            owners = set(heading_items)
        prot = bool(_PROTECT_RE.search(row)) and not _NOT_BLIND_RE.search(row)
        sets[tok] = {"status": "protected" if prot else "open", "owners": owners, "released": False, "row": row}
    # update bullets
    for line in text.splitlines():
        s = line.replace("**", "")
        for m in re.finditer(r"\b([A-Z]{1,3}\d+[a-z]?|P3b-[ab])\s+is\s+(?:re)?assigned\s+as\s+the\s+"
                             r"confirmatory\s+set\s+for\s+(R\d+(?:\.\d+)+(?:-v\d+)?)", s):
            if m.group(1) in sets:
                sets[m.group(1)]["owners"].add(m.group(2))
                sets[m.group(1)]["status"] = "protected"
        for m in re.finditer(r"\b([A-Z]{1,3}\d+[a-z]?|P3b-[ab])\s+is\s+now\s+grade\s+C\b", s):
            if m.group(1) in sets:
                sets[m.group(1)]["released"] = True
        m = re.search(r"Locked now:\s*([^.]+)\.", s)
        if m:
            for sid in re.findall(r"[A-Z][A-Za-z0-9\-]+", m.group(1)):
                if sid in sets:
                    sets[sid]["status"] = "protected"
    for sid in RELEASED_BY_BOARD:
        if sid in sets:
            sets[sid]["released"] = True
    return sets


class BlindGuard:
    """Refuses keys that belong to a protected, unreleased inventory set unless the caller owns it."""

    def __init__(self, inventory_path=None, datasets_dir=None, inventory_text=None):
        if inventory_text is None:
            path = inventory_path or default_inventory_path()
            if not path or not os.path.exists(path):
                raise BlindSetError("blind-set inventory not found; set Q26_BLIND_INVENTORY to "
                                    "membrane-board/design/q26-blind-set-inventory-2026-10-17.md (guard fails closed)")
            with open(path, encoding="utf-8") as f:
                inventory_text = f.read()
            self.inventory_path = path
        else:
            self.inventory_path = None
        self.inventory_sha256 = hashlib.sha256(inventory_text.encode()).hexdigest()
        self.sets = parse_inventory(inventory_text)
        self.datasets_dir = datasets_dir if datasets_dir is not None else default_datasets_dir()
        self._lists = {}
        self._build_matchers()

    # -- membership sources ------------------------------------------------------------------------------------------
    def _load(self, rel):
        if rel in self._lists:
            return self._lists[rel]
        obj = None
        if self.datasets_dir:
            p = os.path.join(self.datasets_dir, rel)
            if os.path.exists(p):
                with open(p) as f:
                    obj = json.load(f)
        self._lists[rel] = obj
        return obj

    def _row_tokens(self, sid, pattern):
        row = self.sets.get(sid, {}).get("row", "")
        return set(re.findall(pattern, row))

    def _paren_symbols(self, sid):
        """Upper-cased tokens of the first parenthesised all-symbol list in the set's row, e.g. '(1INCH ALPH ...)'."""
        row = self.sets.get(sid, {}).get("row", "")
        for grp in re.findall(r"\(([^()]+)\)", row):
            toks = grp.split()
            if len(toks) >= 3 and all(re.fullmatch(r"[0-9A-Za-z]{2,10}", t) for t in toks):
                return {t.upper() for t in toks}
        return set()

    def _build_matchers(self):
        m = {}

        def venue_list(sources, rel, getter):
            def f(k):
                if k["source"] not in sources:
                    return False
                sel = self._load(rel)
                if sel is None:
                    return None          # membership unknown: fail closed
                return cex_base(k["symbol"]) in getter(sel)
            return f

        def split_list(field, salt, parity):
            return lambda sel: {cex_base(b) for b in sel.get(field, []) if _hash_byte(salt, b) % 2 == parity}

        m["B13a"] = venue_list({"kucoin"}, "b13-kucoin-prices/selection-b13.json",
                               split_list("eligible", "Q26-R12.6-B13:", 0))
        m["B13b"] = venue_list({"kucoin"}, "b13-kucoin-prices/selection-b13.json",
                               split_list("eligible", "Q26-R12.6-B13:", 1))
        m["B14a"] = venue_list({"gate", "gateio"}, "b14-gate-prices/selection-b14.json",
                               lambda s: {cex_base(x) for x in s.get("B14a", [])})
        m["B14b"] = venue_list({"gate", "gateio"}, "b14-gate-prices/selection-b14.json",
                               lambda s: {cex_base(x) for x in s.get("B14b", [])})
        m["B15a"] = venue_list({"mexc"}, "b15-mexc-prices/selection-b15.json",
                               split_list("eligible", "Q26-R13-B15:", 0))
        m["B15b"] = venue_list({"mexc"}, "b15-mexc-prices/selection-b15.json",
                               split_list("eligible", "Q26-R13-B15:", 1))
        m["B18"] = venue_list({"poloniex"}, "b18-poloniex-prices/selection-b18.json",
                              lambda s: {cex_base(x) for x in s.get("B18", [])})
        m["B19a"] = venue_list({"lbank"}, "b19-lbank-prices/selection-b19.json",
                               lambda s: {cex_base(x) for x in s.get("B19a", [])})
        m["B19b"] = venue_list({"lbank"}, "b19-lbank-prices/selection-b19.json",
                               lambda s: {cex_base(x) for x in s.get("B19b", [])})
        for sid in ("B20a", "B20b"):
            m[sid] = venue_list({"xt", "bingx"}, "b20-xt-bingx-prices/selection-b20.json",
                                lambda s, fld=sid: {cex_base(x) for x in s.get(fld, [])})
        p3b = "history-forecasts/r13/r134-reserve/selection-p3b.json"
        for sid, field in (("P3b-a", "P3b_a"), ("P3b-b", "P3b_b"), ("P3c", "P3c")):
            m[sid] = venue_list({"binance"}, p3b, lambda s, fld=field: {cex_base(x) for x in s.get(fld, [])})

        def b17(split):
            def f(k):
                if k["source"] != "rpc" or k["chain"] not in (None, "ethereum"):
                    return False
                sel = self._load("b17-uniswap-alts/selection-r129.json")
                cand = self._load("b17-uniswap-alts/candidate-pools-r129.json")
                syms = self._paren_symbols("B17" + split)
                if sel is None or cand is None:
                    return None if re.fullmatch(r"0x[0-9a-f]{40}", k["symbol"]) else k["symbol"].upper() in syms
                assets = {a["asset"].lower() for a in sel.get("assets", []) if a.get("split") == "b17" + split}
                pools = {p["pool"].lower() for p in cand.get("pools", []) if p["asset"].lower() in assets}
                s = k["symbol"].lower()
                return s in assets or s in pools or (k["symbol"].upper() in syms and "uniswap" in k["dataset"].lower())
            return f

        m["B17a"], m["B17b"] = b17("a"), b17("b")

        def b3(split):
            def f(k):
                if k["source"] != "b3":
                    return False
                sym = k["symbol"].upper()
                if "COTAHIST" in sym or "COTAHIST" in k["dataset"].upper():
                    return True          # yearly file bundles every ticker, locked halves included
                return any(_hash_byte("Q26-R13.4:", key) % 3 == split for key in {sym[:4], sym})
            return f

        m["EQ-A"] = m["ETF-A"] = b3(1)
        m["EQ-B"] = m["ETF-B"] = b3(2)

        def fx(sid):
            pairs = self._row_tokens(sid, r"\b[A-Z]{6}\b")
            return lambda k: k["source"] == "histdata" and k["symbol"].upper()[:6] in pairs

        m["FX-A"], m["FX-B"] = fx("FX-A"), fx("FX-B")

        def cfd(sid, prefixes, lo, hi):
            return lambda k: (k["source"] == "histdata" and k["symbol"].upper()[:3] in prefixes
                              and _overlaps(k["period"], lo, hi))

        idx = self._row_tokens("IDX-A", r"\b[A-Z]{3}\b") - {"CFD", "USD"}
        com = {"WTI", "BCO", "XAG", "XAU"}
        m["IDX-A"] = cfd("IDX-A", idx, "2018-01-01", "2021-12-31")
        m["IDX-B"] = cfd("IDX-B", idx, "2022-01-01", "2026-09-30")
        m["COM-A"] = cfd("COM-A", com, "2018-01-01", "2021-12-31")
        m["COM-B"] = cfd("COM-B", com, "2022-01-01", "2026-09-30")

        def proto(chains, words, need=("usdc",)):
            def f(k):
                if k["source"] != "rpc" or k["chain"] not in chains:
                    return False
                text = (k["dataset"] + " " + k["symbol"]).lower()
                return any(w in text for w in words) and all(n in text for n in need)
            return f

        m["SV1"] = proto({"base"}, ("aave",))
        m["SV2"] = proto({"avalanche"}, ("aave",))
        m["SVC1"] = proto({"arbitrum"}, ("comet", "compound"))
        m["SVC2"] = proto({"base"}, ("comet", "compound"))
        m["L1-P"] = proto({"polygon"}, ("aave",), need=())
        m["L1-O"] = proto({"optimism"}, ("aave",), need=())
        m["B16a"] = proto({"ethereum"}, ("uniswap",), need=("weth",))
        m["B16b"] = proto({"arbitrum", "base"}, ("uniswap",), need=("weth",))
        self.matchers = m

    # -- public ------------------------------------------------------------------------------------------------------
    def protected_sets(self):
        return sorted(s for s, v in self.sets.items() if v["status"] == "protected" and not v["released"])

    def report(self):
        prot = self.protected_sets()
        return {"inventory_sha256": self.inventory_sha256, "protected": prot,
                "owners": {s: sorted(self.sets[s]["owners"]) for s in prot},
                "released": sorted(s for s, v in self.sets.items() if v["released"]),
                "tag_only": [s for s in prot if s not in self.matchers]}

    def matches(self, key, blind_set=None):
        """Protected unreleased set ids that ``key`` belongs to (unknown membership counts as a match)."""
        k = key.norm()
        hit = []
        for sid in self.protected_sets():
            if blind_set and sid == blind_set:
                hit.append(sid)
                continue
            f = self.matchers.get(sid)
            if f is None:
                continue
            r = f(k)
            if r is None or r:
                hit.append(sid)
        if blind_set and blind_set not in hit and blind_set in self.sets and not self.sets[blind_set]["released"]:
            hit.append(blind_set)
        return hit

    def check(self, key, owner=None, blind_set=None):
        """Return the one owned set id the key belongs to, or None for shared data. Raise BlindSetError otherwise."""
        hits = self.matches(key, blind_set)
        if not hits:
            return None
        owner = (owner or "").strip()
        bad = [s for s in hits if owner not in self.sets[s]["owners"]]
        if bad:
            reg = {s: sorted(self.sets[s]["owners"]) or ["(none registered)"] for s in bad}
            raise BlindSetError(f"key {key.norm()['source']}/{key.norm()['dataset']} is in reserved blind set(s) "
                                f"{bad}; registered owner item(s): {reg}. Not cached or served.")
        if len(hits) > 1:
            raise BlindSetError(f"key matches several blind sets {hits}; acquire each set separately")
        return hits[0]


# =====================================================================================================================
# Cache
# =====================================================================================================================

def _atomic_write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".tmp-")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(tmp)
        raise


_last_ns = [0]


def _touch(path):
    """Set mtime to an explicit, strictly increasing ns stamp (coarse filesystem clocks would tie)."""
    t = max(time.time_ns(), _last_ns[0] + 1)
    _last_ns[0] = t
    os.utime(path, ns=(t, t))


class Cache:
    def __init__(self, root=None, max_bytes=None, guard=None, log=None):
        self.root = os.path.abspath(root or os.environ.get("Q26_CACHE_DIR") or DEFAULT_ROOT)
        self.max_bytes = int(max_bytes or os.environ.get("Q26_CACHE_MAX_BYTES") or DEFAULT_MAX_BYTES)
        self.guard = guard if guard is not None else BlindGuard()
        self.log = log or (lambda msg: None)
        self._tl = threading.Lock()
        os.makedirs(self.root, exist_ok=True)
        self.stats = {"hits": 0, "misses": 0, "puts": 0, "evicted": 0}

    # -- paths -------------------------------------------------------------------------------------------------------
    def _root_for(self, set_id):
        if set_id is None:
            return self.root
        return os.path.join(self.root.rstrip("/") + "-locked", set_id)

    @staticmethod
    def _entry(root, kid):
        return os.path.join(root, "entries", kid[:2], kid + ".json")

    @staticmethod
    def _blob(root, sha):
        return os.path.join(root, "blobs", sha[:2], sha + ".gz")

    @contextlib.contextmanager
    def _lock(self, root):
        os.makedirs(root, exist_ok=True)
        with self._tl, open(os.path.join(root, ".lock"), "a+") as f:
            fcntl.flock(f, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(f, fcntl.LOCK_UN)

    # -- core --------------------------------------------------------------------------------------------------------
    def manifest(self, key, owner=None, blind_set=None):
        sid = self.guard.check(key, owner, blind_set)
        p = self._entry(self._root_for(sid), key.key_id())
        if not os.path.exists(p):
            return None
        with open(p) as f:
            return json.load(f)

    def get(self, key, owner=None, blind_set=None):
        sid = self.guard.check(key, owner, blind_set)
        root = self._root_for(sid)
        ep = self._entry(root, key.key_id())
        try:
            with open(ep) as f:
                man = json.load(f)
            bp = self._blob(root, man["sha256"])
            with gzip.open(bp, "rb") as f:
                data = f.read()
        except (FileNotFoundError, json.JSONDecodeError, OSError, EOFError, KeyError):
            self.stats["misses"] += 1
            return None
        if hashlib.sha256(data).hexdigest() != man["sha256"] or len(data) != man["bytes"]:
            self.log(f"q26cache: corrupt entry {key.key_id()[:12]} dropped")
            with contextlib.suppress(FileNotFoundError):
                os.unlink(ep)
            self.stats["misses"] += 1
            return None
        with contextlib.suppress(OSError):
            _touch(bp)                         # LRU: entry and blob mtime = last access
            _touch(ep)
        self.stats["hits"] += 1
        return data

    def put(self, key, data, source_url=None, published_sha256=None, meta=None, owner=None, blind_set=None):
        if not isinstance(data, (bytes, bytearray)):
            raise TypeError("payload must be bytes")
        sid = self.guard.check(key, owner, blind_set)
        data = bytes(data)
        sha = hashlib.sha256(data).hexdigest()
        if published_sha256 is not None and sha != str(published_sha256).strip().lower():
            raise CacheIntegrityError(f"sha256 {sha[:16]}… differs from the published checksum; not cached")
        root = self._root_for(sid)
        man = {"schema": SCHEMA, "key": key.norm(), "key_id": key.key_id(), "sha256": sha, "bytes": len(data),
               "source_url": redact(source_url), "fetched_utc": now_iso(),
               "published_sha256": (str(published_sha256).lower() if published_sha256 else None),
               "blind_set": sid, "owner": owner if sid else None, "meta": meta or {}}
        with self._lock(root):
            bp = self._blob(root, sha)
            if not os.path.exists(bp):
                _atomic_write(bp, gzip.compress(data, 6, mtime=0))
            _atomic_write(self._entry(root, key.key_id()), json.dumps(man, sort_keys=True, indent=1).encode())
            _touch(self._entry(root, key.key_id()))
            self.stats["puts"] += 1
            self._evict(root)
        return man

    def get_or_fetch(self, key, fetch, source_url=None, published_sha256=None, meta=None, owner=None,
                     blind_set=None, cache_result=True, allow_instrument=False):
        """Cached bytes for ``key``; on a miss call ``fetch()`` (bytes), verify, store and return them.
        The guard runs before ``fetch`` so a refused key is never fetched through the cache.
        Instrument guard (2026-10-19, design/q26-leveraged-token-audit-2026-10-19.md): a CEX price key whose base is a
        confirmed leveraged token (q26_instrument.classify_symbol) raises InstrumentExclusionError before the fetch,
        unless ``allow_instrument=True`` or Q26_ALLOW_INSTRUMENT=1 (a deliberate reference fetch)."""
        data = self.get(key, owner, blind_set)
        if data is not None:
            return data
        if not allow_instrument and os.environ.get("Q26_ALLOW_INSTRUMENT") != "1":
            instrument_check(key)
        data = fetch()
        if cache_result:
            self.put(key, data, source_url, published_sha256, meta, owner, blind_set)
        elif published_sha256 is not None and hashlib.sha256(data).hexdigest() != published_sha256.lower():
            raise CacheIntegrityError("sha256 differs from the published checksum")
        return data

    def get_or_fetch_json(self, key, fetch, **kw):
        cache_result = kw.get("cache_result", True)
        holder = {}

        def f():
            holder["obj"] = fetch()
            return json.dumps(holder["obj"], sort_keys=True, separators=(",", ":")).encode()

        raw = self.get_or_fetch(key, f, **kw)
        if "obj" in holder and not cache_result:
            return holder["obj"]
        return json.loads(raw)

    # -- size cap ----------------------------------------------------------------------------------------------------
    def usage(self, root=None):
        root = root or self.root
        tot = 0
        for sub in ("blobs", "entries"):
            for dp, _, fs in os.walk(os.path.join(root, sub)):
                for fn in fs:
                    with contextlib.suppress(FileNotFoundError):
                        tot += os.path.getsize(os.path.join(dp, fn))
        return tot

    def _evict(self, root):
        """Called with the root lock held. LRU by entry mtime; blobs without an entry are removed."""
        if self.usage(root) <= self.max_bytes:
            return
        target = int(self.max_bytes * 0.9)
        ents = []
        for dp, _, fs in os.walk(os.path.join(root, "entries")):
            for fn in fs:
                if fn.endswith(".json"):
                    p = os.path.join(dp, fn)
                    with contextlib.suppress(FileNotFoundError):
                        ents.append((os.stat(p).st_mtime_ns, p))
        ents.sort()
        refs = {}
        for _, p in ents:
            with contextlib.suppress(FileNotFoundError, json.JSONDecodeError, KeyError):
                with open(p) as f:
                    refs[p] = json.load(f)["sha256"]
        used = self.usage(root)
        live = {}
        for p, sha in refs.items():
            live[sha] = live.get(sha, 0) + 1
        for _, p in ents:
            if used <= target:
                break
            sha = refs.get(p)
            with contextlib.suppress(FileNotFoundError):
                used -= os.path.getsize(p)
                os.unlink(p)
            self.stats["evicted"] += 1
            if sha:
                live[sha] -= 1
                if live[sha] == 0:
                    bp = self._blob(root, sha)
                    with contextlib.suppress(FileNotFoundError):
                        used -= os.path.getsize(bp)
                        os.unlink(bp)


# =====================================================================================================================
# Block timestamps
# =====================================================================================================================

class BlockTimestamps:
    """Persistent (chain, block) -> header timestamp. A missing or non-positive timestamp is an error, never 0."""

    def __init__(self, cache_or_root=None):
        root = cache_or_root.root if isinstance(cache_or_root, Cache) else (
            cache_or_root or os.environ.get("Q26_CACHE_DIR") or DEFAULT_ROOT)
        os.makedirs(root, exist_ok=True)
        self.path = os.path.join(root, "blockts.sqlite")
        self._local = threading.local()
        with self._db() as db:
            db.execute("CREATE TABLE IF NOT EXISTS ts (chain TEXT NOT NULL, block INTEGER NOT NULL, "
                       "ts INTEGER NOT NULL CHECK (ts > 0), PRIMARY KEY (chain, block))")

    def _db(self):
        db = getattr(self._local, "db", None)
        if db is None:
            db = sqlite3.connect(self.path, timeout=60)
            db.execute("PRAGMA journal_mode=WAL")
            self._local.db = db
        return db

    @staticmethod
    def _check(chain, block, ts):
        assert isinstance(block, int) and block >= 0, f"bad block {block!r}"
        assert ts is not None, f"{chain} block {block}: missing timestamp (never defaulted to 0)"
        ts = int(ts, 16) if isinstance(ts, str) else int(ts)
        assert ts > 0, f"{chain} block {block}: timestamp {ts} is not positive (never defaulted to 0)"
        return ts

    def get(self, chain, block):
        r = self._db().execute("SELECT ts FROM ts WHERE chain=? AND block=?", (norm_chain(chain), int(block))).fetchone()
        return r[0] if r else None

    def put(self, chain, block, ts):
        ts = self._check(chain, int(block), ts)
        with self._db() as db:
            db.execute("INSERT OR IGNORE INTO ts VALUES (?,?,?)", (norm_chain(chain), int(block), ts))
        have = self.get(chain, block)
        assert have == ts, f"{chain} block {block}: cached timestamp {have} differs from {ts}"
        return ts

    def get_or_fetch(self, chain, block, header_fetch):
        """``header_fetch(block)`` returns the header dict (or the timestamp as int / hex str)."""
        have = self.get(chain, block)
        if have is not None:
            return have
        h = header_fetch(int(block))
        ts = (h or {}).get("timestamp") if isinstance(h, dict) else h
        return self.put(chain, int(block), ts)

    def fill_logs(self, chain, logs, header_fetch):
        """Set ``blockTimestamp`` on every log that lacks a positive one, from the cache or the header."""
        for x in logs:
            bn = int(x["blockNumber"], 16)
            t = x.get("blockTimestamp")
            if t and int(t, 16) > 0:
                self.put(chain, bn, t)
            else:
                x["blockTimestamp"] = hex(self.get_or_fetch(chain, bn, header_fetch))
        return logs


# =====================================================================================================================
# Cached eth_getLogs over aligned block windows
# =====================================================================================================================

def cached_get_logs(cache, chain, address, topic0, lo, hi, fetch, chunk=100_000, finalized_block=None,
                    owner=None, blind_set=None, source_url=None, dataset=None):
    """All logs of ``address`` with ``topic0`` in [lo, hi], in chain order.

    The range is cut into windows aligned to multiples of ``chunk``. Each window ``[a, b]`` is fetched with
    ``fetch(a, b)`` (the caller's splitting/retrying getLogs) and cached under
    Key("rpc", dataset or "logs:<topic0>", address, "a-b", chain). Windows reaching above ``finalized_block`` are
    fetched but not cached. ``address`` may be a list (stored under the sha256 of the sorted list)."""
    if hi < lo:
        return []
    if isinstance(address, (list, tuple)):
        addrs = sorted(a.lower() for a in address)
        sym = addrs[0] if len(addrs) == 1 else "set:" + hashlib.sha256(",".join(addrs).encode()).hexdigest()[:32]
    else:
        sym = str(address).lower()
    ds = dataset or f"logs:{str(topic0).lower()}"
    out = []
    w = (lo // chunk) * chunk
    while w <= hi:
        a, b = max(lo, w), min(hi, w + chunk - 1)
        key = Key("rpc", ds, sym, f"{a}-{b}", chain)
        final = finalized_block is not None and b <= finalized_block
        logs = cache.get_or_fetch_json(key, lambda a=a, b=b: fetch(a, b), source_url=source_url, owner=owner,
                                       blind_set=blind_set, cache_result=final,
                                       meta={"from_block": a, "to_block": b})
        out.extend(logs)
        w += chunk
    out.sort(key=lambda x: (int(x["blockNumber"], 16), int(x["logIndex"], 16)))
    return out


if __name__ == "__main__":
    import sys
    g = BlindGuard()
    print(json.dumps(g.report(), indent=1))
    c = Cache(guard=g)
    print(json.dumps({"root": c.root, "max_bytes": c.max_bytes, "usage": c.usage(),
                      "rpc_env": {ch: (redact(os.environ[v]) if os.environ.get(v) else None)
                                  for ch, v in RPC_ENV.items()}}, indent=1))
    sys.exit(0)
