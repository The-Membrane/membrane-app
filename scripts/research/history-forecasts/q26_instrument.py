"""q26_instrument: instrument exclusion helper for Q26 price sets (leveraged, inverse, rebasing, pegged, stablecoin).

membrane-board design/q26-leveraged-token-audit-2026-10-19.md. Parent: D-R16.5-review (10 KuCoin UP/DOWN tokens in
B13a held 31% of the R14.1 DR development gain although the B13a rule excludes leveraged tokens). Root cause: the
R12.5 rule `r125_fh_deep.excluded` matched leveraged tokens only by `^.+\\d[LS]$` (3L/3S/5L/5S) and stablecoins only by
a fixed list, so KuCoin/Binance UP/DOWN, Poloniex/FTX BULL/BEAR and stablecoins outside the list passed.

Two layers, use both for every new selection:

1. ``classify_symbol(base, venue=None, known_bases=None)`` -> (cls, reason) or (None, None). Symbol rules per venue:
   - leveraged, digit + L/S: ``^X[1-9][LS]$`` (Gate 3L/3S/5L/5S, MEXC 3L/3S, KuCoin 3L/3S/2L/2S, Bybit 2L/3L/2S/3S,
     LBank, XT, BingX, Bitget, HTX ...). Matched on every venue.
   - leveraged, word suffix: ``^X(UP|DOWN|BULL|BEAR|HEDGE|HALF)$`` (KuCoin UP/DOWN, Binance UP/DOWN/BULL/BEAR,
     Poloniex/FTX BULL/BEAR/HEDGE/HALF). Flagged ``leveraged`` when X is a known base (``known_bases`` or the built-in
     majors list), else ``leveraged?`` (a name suspect: confirm with ``leverage_beta``).
   - stablecoin / fiat / gold peg: built-in list plus names containing USD/EUR/... (``pegged?`` unless listed).
   - wrapped / staked / bridged major: built-in list plus ``<prefix>(BTC|ETH|SOL|BNB)<suffix>`` (``pegged?``).
   - tokenized equity: xStocks ``X`` suffix and Ondo ``ON`` suffix on a stock ticker list.
   A ``?`` class is a suspect, not a verdict: confirm on seen data with layer 2 before excluding by name alone.

2. Price detectors on hourly closes (NaN = no trade; use seen or spent data only):
   - ``peg_check(close, ref=None)``: share of days whose close is within 2% of the reference (1.0 USD, or a reference
     series such as BTC for a wrapped asset) and the daily log-return s.d.  Pegged if share >= 0.8 and s.d. < 0.01.
   - ``rebase_jumps(close)``: single-step moves of at least x4 whose new level persists (median of the next 48 valid
     closes vs the previous 48 also beyond x3), with the ratio and whether it is near 10^k (redenomination /
     rebase / leveraged-token split-merge signature).
   - ``leverage_beta(r_tok, r_und)``: OLS beta and correlation of aligned hourly log returns against the underlying,
     and the yearly drift net of beta (rebalancing decay). Leveraged if |beta| >= 1.8 and corr >= 0.6; inverse if
     beta <= -0.8 and corr <= -0.6.

``exclusion_reason(base, venue, known_bases=None, close=None, underlying_close=None)`` combines both: a confirmed name
class or a positive detector returns a reason string; None means keep.

Wire-in: ``q26cache.Cache`` calls ``instrument_check(key)`` on every CEX price key and raises
``InstrumentExclusionError`` for a confirmed leveraged class unless the call passes ``allow_instrument=True`` (for
example a deliberate reference fetch of a stablecoin). Selection builders call ``exclusion_reason`` per base.

Free data only. No address, key or secret is read or written.
"""
from __future__ import annotations

import math
import re

import numpy as np

# ---------------------------------------------------------------------------------------------------------------
# symbol rules
# ---------------------------------------------------------------------------------------------------------------
LEV_DIGIT_RE = re.compile(r"^(?P<u>[A-Z0-9]+?)(?P<k>[1-9])(?P<d>[LS])$")
LEV_WORD_RE = re.compile(r"^(?P<u>[A-Z0-9]{2,}?)(?P<w>UP|DOWN|BULL|BEAR|HEDGE|HALF)$")

# majors and assets that venues issue leveraged tokens on (used when the caller passes no known_bases)
MAJORS = frozenset("""
BTC ETH BNB SOL XRP ADA DOGE TRX DOT LINK LTC BCH AVAX MATIC POL ATOM ETC XLM FIL UNI AAVE EOS XTZ SUSHI YFI SXP
NEAR ALGO ICP APT ARB OP SUI SEI TIA INJ WLD PEPE SHIB FLOKI BONK ORDI SATS LUNA LUNC FTM GALA SAND MANA AXS APE
DYDX GMT CRV COMP MKR SNX GRT 1INCH CHZ ENJ ZIL VET THETA EGLD KAVA KSM NEO QTUM ONT IOST ZEC DASH XMR BSV
TRB PYTH RNDR RENDER STX STORJ MASK PERP LOOM BAKE ARPA ALGO CTSI GLMR KAS UNFI FRONT AGIX FET OCEAN WOO VRA
LINA ETC JASMY CFX BLUR WIF JUP ENA ONDO TON NOT PEOPLE LDO RUNE IMX HBAR XEC
""".split())

STABLE = frozenset("""
USDT USDC BUSD TUSD USDP PAX DAI FDUSD PYUSD USDD USDJ USDK USDN USDX USDS USDE USD1 USDG USDQ USDR USDY USDTB
USDB USDM USDH USDL USDF USDA USDO USDZ USDV GUSD HUSD SUSD LUSD FRAX FEI MIM UST USTC AUSD OUSD CRVUSD GHO FUSD
EURS EURT EURC EURI EURQ EURR AEUR EUROC AGEUR CEUR GBPT XSGD BIDR IDRT BRZ BRL1 TRYB ZUSD CUSD MUSD DOLA RLUSD
USDSB USDSOLD AUDF AUDM AEDZ USAT TRYX MXNT NZDS CADC XCHF BKRW BVND QCAD JPYC GYEN ZCHF
WSTUSDT STUSDT SUSDE SDAI SFRAX SUSDS USDTE USDCE
""".split())
GOLD = frozenset("XAUT PAXG KAU XAUM DGX PMGT CGO AWG VNXAU UGOLD CLEGOLD XAUAUD XAUEUR".split())
DERIV = frozenset("""
WBTC WETH CBBTC LBTC PUMPBTC SOLVBTC BTCB HBTC RENBTC TBTC RBTC OBTC IBTC FBTC UNIBTC ENZOBTC
STETH WSTETH RETH CBETH METH CMETH EZETH WEETH EETH PUFETH RSETH OETH SFRXETH FRXETH ANKRETH BETH WBETH SETH2
JITOSOL MSOL BNSOL BBSOL OKSOL BGSOL STSOL JSOL INF HSOL SSOL
WBNB SLISBNB STKBNB ANKRBNB WAVAX SAVAX WMATIC STMATIC MATICX WFTM WTRX STTRX WROSE WEGLD WCRO STATOM
""".split())
STOCK = frozenset("""
AAPL AMZN COIN CRCL GOOGL GOOG HOOD MCD META NVDA TSLA MSFT NFLX SPY QQQ MSTR AMD INTC PLTR BABA ABNB ADBE AVGO
ORCL CSCO PYPL UBER SHOP SQ DIS KO PEP WMT JPM BAC GS V MA XOM CVX PFE MRNA SPCX GME AMC
""".split())
PEG_ROOT_RE = re.compile(r"^(?P<p>W|CB|RE|ST|WST|O|M|B|H|REN|T|S|SO|BN|JITO|EZ|WE|PUF|RS|R|SFRX|FRX|ANKR|SLIS|STK|L|U|I|F)"
                         r"(?P<a>BTC|ETH|SOL|BNB|AVAX|MATIC|TRX|ATOM)(?P<s>B|E|1|2)?$")
FIAT_RE = re.compile(r"(USD|EUR|GBP|CHF|JPY|AUD|CAD|SGD|TRY|BRL|IDR|MXN|KRW|NGN|ZAR|XAU|XAG)")

LEVERAGED, LEVERAGED_SUSPECT = "leveraged", "leveraged?"
PEGGED, PEGGED_SUSPECT = "pegged", "pegged?"
TOKENIZED = "tokenized-equity?"


def classify_symbol(base, venue=None, known_bases=None):
    """(class, reason) for a base asset symbol, or (None, None). venue is informational (rules are venue-safe)."""
    b = str(base).upper().strip()
    known = set(known_bases) if known_bases else set()
    known |= MAJORS
    m = LEV_DIGIT_RE.match(b)
    if m and len(m.group("u")) >= 2:
        return LEVERAGED, f"leveraged token {m.group('k')}{m.group('d')} on {m.group('u')}"
    m = LEV_WORD_RE.match(b)
    if m:
        u = m.group("u")
        if u in known:
            return LEVERAGED, f"leveraged token {m.group('w')} on {u}"
        return LEVERAGED_SUSPECT, f"name ends {m.group('w')} ({u} not a known base): confirm with leverage_beta"
    if b in STABLE:
        return PEGGED, "stablecoin / fiat peg (list)"
    if b in GOLD:
        return PEGGED, "gold / commodity peg (list)"
    if b in DERIV:
        return PEGGED, "wrapped / staked / bridged major (list)"
    if b.endswith("X") and b[:-1] in STOCK or b.endswith("ON") and b[:-2] in STOCK:
        return TOKENIZED, "name of a tokenized equity (xStocks X / Ondo ON suffix): suspect, confirm on the venue"
    m = PEG_ROOT_RE.match(b)
    if m and b not in MAJORS:
        return PEGGED_SUSPECT, f"name pattern of a wrapped/staked {m.group('a')}: confirm with peg_check vs {m.group('a')}"
    if FIAT_RE.search(b) and len(b) <= 8:
        return PEGGED_SUSPECT, "fiat / gold code in the name: confirm with peg_check"
    return None, None


# ---------------------------------------------------------------------------------------------------------------
# price detectors (hourly closes; NaN = no trade)
# ---------------------------------------------------------------------------------------------------------------
def _daily_close(close, start_ts=0, step=3600):
    c = np.asarray(close, float)
    t = start_ts + step * np.arange(len(c))
    day = (t // 86400).astype(np.int64)
    ok = np.isfinite(c) & (c > 0)
    if not ok.any():
        return np.array([]), np.array([], np.int64)
    d, c = day[ok], c[ok]
    last = np.r_[d[1:] != d[:-1], True]
    return c[last], d[last]


def peg_check(close, ref=None, start_ts=0, step=3600, ref_start_ts=None, tol=0.02):
    """share of days with |ln(close / ref)| <= tol (ref = 1.0 or a reference hourly series) and daily return s.d."""
    dc, dd = _daily_close(close, start_ts, step)
    if len(dc) < 30:
        return {"days": int(len(dc)), "pegged": False, "share_in_band": None, "sd_daily": None}
    if ref is None:
        rv = np.ones_like(dc)
    else:
        rc, rd = _daily_close(ref, start_ts if ref_start_ts is None else ref_start_ts, step)
        mp = dict(zip(rd.tolist(), rc.tolist()))
        rv = np.array([mp.get(int(x), np.nan) for x in dd])
    with np.errstate(all="ignore"):
        lr = np.log(dc / rv)
        ok = np.isfinite(lr)
        share = float(np.mean(np.abs(lr[ok]) <= tol)) if ok.sum() >= 30 else None
        r = np.diff(np.log(dc))
        sd = float(np.nanstd(r)) if len(r) > 10 else None
        sdr = float(np.nanstd(np.diff(lr[ok]))) if ok.sum() > 10 else None
    pegged = bool(share is not None and share >= 0.8 and (sdr if ref is not None else sd) is not None
                  and (sdr if ref is not None else sd) < 0.01)
    return {"days": int(len(dc)), "days_with_ref": int(ok.sum()), "share_in_band": share, "sd_daily": sd,
            "sd_daily_vs_ref": sdr, "median_level_vs_ref": float(np.nanmedian(np.exp(lr))) if ok.any() else None,
            "pegged": pegged}


REDENOM_GAP_H = 72


def rebase_jumps(close, start_ts=0, step=3600, min_ratio=4.0, persist_ratio=3.0, win=48):
    """single-step moves >= min_ratio between consecutive valid closes whose new level persists. A jump is tagged
    ``redenomination`` when it crosses a no-trade gap of >= REDENOM_GAP_H hours (swap / migration suspension) or its
    ratio is within 5% (log10 0.02) of 10^k; one-hour jumps without that signature are usually real moves on thin
    pairs and are reported, not excluded."""
    c = np.asarray(close, float)
    idx = np.flatnonzero(np.isfinite(c) & (c > 0))
    if len(idx) < 2 * win + 2:
        return []
    v = c[idx]
    lr = np.diff(np.log(v))
    out = []
    for j in np.flatnonzero(np.abs(lr) >= math.log(min_ratio)):
        if j + 1 < win or j + 1 + win > len(v):
            continue
        pre = np.median(v[j + 1 - win:j + 1])
        post = np.median(v[j + 1:j + 1 + win])
        ratio = post / pre
        if abs(math.log(ratio)) < math.log(persist_ratio):
            continue
        k = round(math.log10(abs(ratio))) if ratio > 0 else 0
        out.append({"ts": int(start_ts + step * idx[j + 1]), "step_ratio": float(math.exp(lr[j])),
                    "persist_ratio": float(ratio), "gap_hours": int(idx[j + 1] - idx[j]),
                    "near_pow10": bool(k != 0 and abs(math.log10(abs(ratio)) - k) < 0.02),
                    "redenomination": bool(idx[j + 1] - idx[j] >= REDENOM_GAP_H
                                           or (k != 0 and abs(math.log10(abs(ratio)) - k) < 0.02))})
    return out


def leverage_beta(close_tok, close_und, tok_start_ts, und_start_ts, step=3600, min_obs=500):
    """beta, corr and yearly net drift of the token's hourly log returns on the underlying's."""
    a = np.asarray(close_tok, float)
    b = np.asarray(close_und, float)
    ta = tok_start_ts + step * np.arange(len(a))
    tb = und_start_ts + step * np.arange(len(b))
    lo, hi = max(ta[0], tb[0]), min(ta[-1], tb[-1])
    if hi <= lo:
        return {"obs": 0, "leveraged": False, "inverse": False}
    ia = ((np.arange(lo, hi + 1, step) - ta[0]) // step).astype(int)
    ib = ((np.arange(lo, hi + 1, step) - tb[0]) // step).astype(int)
    with np.errstate(all="ignore"):
        la, lb = np.log(a[ia]), np.log(b[ib])
        ra, rb = np.diff(la), np.diff(lb)
    ok = np.isfinite(ra) & np.isfinite(rb) & (np.abs(rb) > 0)
    n = int(ok.sum())
    if n < min_obs:
        return {"obs": n, "leveraged": False, "inverse": False}
    x, y = rb[ok], ra[ok]
    vx = float(np.var(x))
    beta = float(np.cov(x, y, bias=True)[0, 1] / vx) if vx > 0 else float("nan")
    corr = float(np.corrcoef(x, y)[0, 1])
    drift = float(np.mean(y - beta * x) * 8760)
    return {"obs": n, "beta": beta, "corr": corr, "net_drift_per_year": drift,
            "leveraged": bool(abs(beta) >= 1.8 and abs(corr) >= 0.6),
            "inverse": bool(beta <= -0.8 and corr <= -0.6)}


def exclusion_reason(base, venue=None, known_bases=None, close=None, start_ts=0, underlying_close=None,
                     underlying_start_ts=None, ref_close=None, ref_start_ts=None):
    """combined rule: a confirmed name class, or a positive price detector -> reason string; None = keep."""
    cls, why = classify_symbol(base, venue, known_bases)
    if cls in (LEVERAGED, PEGGED):
        return f"{cls}: {why}"
    if close is not None:
        if underlying_close is not None:
            lb = leverage_beta(close, underlying_close, start_ts, underlying_start_ts)
            if lb.get("leveraged") or lb.get("inverse"):
                return f"leveraged (beta {lb['beta']:.2f}, corr {lb['corr']:.2f} vs underlying)"
        if any(j["redenomination"] for j in rebase_jumps(close, start_ts=start_ts)):
            return "rebase / redenomination (persisting level change across a long no-trade gap or by 10^k)"
        pc = peg_check(close, start_ts=start_ts)
        if pc["pegged"]:
            return f"pegged to 1 (share in 2% band {pc['share_in_band']:.2f}, daily sd {pc['sd_daily']:.4f})"
        if ref_close is not None:
            pr = peg_check(close, ref=ref_close, start_ts=start_ts, ref_start_ts=ref_start_ts)
            if pr["pegged"]:
                return f"pegged to reference (share {pr['share_in_band']:.2f}, sd vs ref {pr['sd_daily_vs_ref']:.4f})"
    if cls in (LEVERAGED_SUSPECT, PEGGED_SUSPECT):
        return None  # suspect only: caller reports it; exclude by name only after a detector confirms
    return None


class InstrumentExclusionError(PermissionError):
    pass


_CEX_SOURCES = frozenset({"binance", "okx", "bybit", "kucoin", "mexc", "gate", "poloniex", "bitfinex", "lbank", "xt",
                          "bingx", "hitbtc", "bitget", "whitebit", "cryptocom", "coinbase", "kraken", "htx"})


def instrument_check(source, symbol, base_of):
    """for q26cache: raise on a confirmed leveraged-token class of a CEX price key. base_of maps symbol -> base."""
    if str(source).lower() not in _CEX_SOURCES:
        return None
    base = base_of(symbol)
    cls, why = classify_symbol(base)
    if cls == LEVERAGED:
        raise InstrumentExclusionError(f"{source}:{symbol} is a {why}; Q26 price sets exclude leveraged tokens "
                                       f"(pass allow_instrument=True for a deliberate reference fetch)")
    return cls


def selection_exclusion(base, venue=None, known_bases=None):
    """Selection rule for every new Q26 venue set (select-* builders): the R12.5 lists (r125_fh_deep.excluded: stable,
    wrapped/staked, tokenized equity, digit leveraged, B10 assets) plus this module's confirmed classes (word-suffix
    leveraged UP/DOWN/BULL/BEAR/HEDGE/HALF on a known base, stablecoins and pegs outside the R12.5 list). Returns a
    reason or None. Suspect classes ('?') are returned with a 'suspect:' prefix so the builder can list them for a
    price check on seen data before the set is reserved; they are not excluded by name alone."""
    try:
        import r125_fh_deep as _R125
        r = _R125.excluded(base)
    except Exception:  # noqa: BLE001
        r = None
    if r:
        return r
    cls, why = classify_symbol(base, venue, known_bases)
    if cls in (LEVERAGED, PEGGED):
        return f"{cls}: {why}"
    if cls in (LEVERAGED_SUSPECT, PEGGED_SUSPECT, TOKENIZED):
        return f"suspect: {cls}: {why}"
    return None
