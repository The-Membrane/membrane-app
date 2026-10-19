"""Q26 leveraged / pegged / rebasing instrument audit 2026-10-19 (membrane-board
design/q26-leveraged-token-audit-2026-10-19.md).

census   every price set of the blind-set inventory: names of all sets (reserved sets by NAME ONLY: their price
         files are never opened), symbol classes from q26_instrument, and price checks (peg to 1, peg to BTC/ETH for
         wrapped names, persisting x4 jumps, leverage beta vs the underlying) on seen or spent sets only.

Seen or spent (prices may be read): R12 dev pool (binance-klines, final-blind, blind3-7, blind8 = P3), B9, B10, B12,
B13a, B13b, B14a (young windows, spent by R13.5r), B15a, B15b. Reserved / unscored (names only): B14b, B17b, B18,
B19a/b, B20a/b, B21a/b, B22, P3b-a/b, P3c.
"""
import gzip
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import q26_instrument as QI  # noqa: E402

DS = os.environ.get("MEMBRANE_DATASETS", "/home/user/membrane-datasets")
SEEN = {"pool", "B9", "B10", "B12-okx", "B12-bybit", "B13a", "B13b", "B14a", "B15a", "B15b", "P3-blind8"}


def jl(p):
    return json.load(gzip.open(p) if p.endswith(".gz") else open(p))


def grid_close(p):
    d = jl(p)
    c = np.array([np.nan if x is None else x for x in d["columns"]["close"]], float)
    return c, int(d["startTs"])


def kucoin_close(p):
    z = np.load(p)
    return z["close"].astype(float), int(z["startTs"])


def gate_close(p):
    z = np.load(p)
    t, c = z["h_t"].astype(np.int64), z["h_c"].astype(float)
    if len(t) == 0:
        return np.array([]), 0
    t0 = int(t[0])
    g = np.full(int((t[-1] - t0) // 3600) + 1, np.nan)
    g[((t - t0) // 3600).astype(int)] = c
    return g, t0


def sets_and_files():
    """{set: [(base, venue, loader-or-None, path-or-None)]}"""
    S = {}
    sel = jl(f"{DS}/b13-kucoin-prices/selection-b13.json")
    for nm, sub in (("B13a", "b13a"), ("B13b", "b13b")):
        S[nm] = [(b, "kucoin", kucoin_close, f"{DS}/b13-kucoin-prices/{sub}/{b}USDT.npz") for b in sel[nm]]
    sel = jl(f"{DS}/b14-gate-prices/selection-b14.json")
    S["B14a"] = [(b, "gate", gate_close, f"{DS}/b14-gate-prices/b14a/gate-{b}_USDT-bars.npz") for b in sel["B14a"]]
    S["B14b"] = [(b, "gate", None, None) for b in sel["B14b"]]
    sel = jl(f"{DS}/b15-mexc-prices/selection-b15.json")
    for nm, sub in (("B15a", "b15a"), ("B15b", "b15b")):
        S[nm] = [(b, "mexc", grid_close, f"{DS}/b15-mexc-prices/{sub}/mexc-{sel['symbol'][b]}-1h.json.gz")
                 for b in sel[nm]]
    sel = jl(f"{DS}/b12-venue-unique-prices/selection-b12.json")
    S["B12-okx"] = [(b, "okx", grid_close, f"{DS}/b12-venue-unique-prices/okx/okx-{b}USDT-1h.json.gz")
                    for b in sel["okx"]["kept"]]
    S["B12-bybit"] = [(b, "bybit", grid_close, f"{DS}/b12-venue-unique-prices/bybit/bybit-{b}USDT-1h.json.gz")
                      for b in sel["bybit"]["kept"]]
    for nm, f, key in (("B18", "b18-poloniex-prices/selection-b18.json", "B18"),
                       ("B19a", "b19-lbank-prices/selection-b19.json", "B19a"),
                       ("B19b", "b19-lbank-prices/selection-b19.json", "B19b"),
                       ("B20a", "b20-xt-bingx-prices/selection-b20.json", "B20a"),
                       ("B20b", "b20-xt-bingx-prices/selection-b20.json", "B20b"),
                       ("B21a", "b21-hitbtc-prices/selection-b21.json", "B21a"),
                       ("B21b", "b21-hitbtc-prices/selection-b21.json", "B21b"),
                       ("B22", "b22-reserve-prices/selection-b22.json", "B22")):
        S[nm] = [(b, nm, None, None) for b in jl(f"{DS}/{f}")[key]]
    s17 = jl(f"{DS}/b17-uniswap-alts/selection-r129.json")
    for a in s17["assets"]:
        if not a.get("excluded"):
            S.setdefault({"b17a": "B17a", "b17b": "B17b", "dev": "B17-dev"}[a["split"]], []).append(
                (a["symbol"].upper(), "uniswap", None, None))
    S["B9"] = sorted((f[len("binance-"):-len("USDT-1h.json.gz")], "binance", grid_close, f"{DS}/b9-delisted-prices/{f}")
                     for f in os.listdir(f"{DS}/b9-delisted-prices") if f.endswith("-1h.json.gz"))
    S["B10"] = sorted((f[len("bitfinex-t"):-len("USD-1h.json.gz")], "bitfinex", grid_close,
                       f"{DS}/b10-bitfinex-prices/{f}") for f in os.listdir(f"{DS}/b10-bitfinex-prices")
                      if f.endswith("-1h.json.gz"))
    pool = []
    for d in ("binance-klines", "final-blind-prices", "blind3-prices", "blind4-prices", "blind5-prices",
              "blind6-prices", "blind7-prices"):
        for f in sorted(os.listdir(f"{DS}/{d}")):
            if f.endswith("USDT-1h.json") and not f.startswith("coinbase") and not f.startswith("bitstamp"):
                b = f.replace("binance-", "").replace("USDT-1h.json", "")
                pool.append((b, "binance", grid_close, f"{DS}/{d}/{f}"))
    S["pool"] = pool
    acq = f"{DS}/history-forecasts/r11/r1110-p3-run-9ab156bb/acq"
    S["P3-blind8"] = sorted((f[len("binance-"):-len("USDT-1h.json.gz")], "binance", grid_close, f"{acq}/{f}")
                            for f in os.listdir(acq) if f.endswith("-1h.json.gz"))
    p3b = jl(f"{DS}/history-forecasts/r13/r134-reserve/selection-p3b.json")
    for k, v in p3b.items():
        if isinstance(v, list) and v and isinstance(v[0], str) and k in ("P3b_a", "P3b_b", "P3c", "p3b_a", "p3b_b",
                                                                          "p3c"):
            S[k] = [(x.replace("USDT", ""), "binance", None, None) for x in v]
    return S


def known_bases():
    kb = set()
    for f in ("b13-kucoin-prices/selection-b13.json", "b14-gate-prices/selection-b14.json",
              "b15-mexc-prices/selection-b15.json", "b18-poloniex-prices/selection-b18.json",
              "b19-lbank-prices/selection-b19.json", "b20-xt-bingx-prices/selection-b20.json",
              "b21-hitbtc-prices/selection-b21.json", "b22-reserve-prices/selection-b22.json"):
        kb |= set(jl(f"{DS}/{f}").get("on_binance", []))
    return kb


def underlying_index(S):
    """seen Binance series by base, for leverage beta."""
    idx = {}
    for nm in ("pool", "P3-blind8", "B9"):
        for b, v, ld, p in S[nm]:
            idx.setdefault(b, (ld, p))
    idx.setdefault("RNDR", idx.get("RENDER") or idx.get("RNDR"))
    return {k: v for k, v in idx.items() if v}


def decide(r):
    """audit decision: confirmed class -> reason; None = keep. Suspect names need a positive detector."""
    why = []
    if r["name_class"] == QI.LEVERAGED:
        why.append("leveraged")
    if r["name_class"] == QI.PEGGED:
        why.append("pegged-name")
    if r.get("peg1", {}).get("pegged"):
        why.append("peg-1")
    if r.get("peg_ref", {}).get("pegged"):
        why.append("peg-ref")
    sd = r.get("peg1", {}).get("sd_daily")
    if sd is not None and sd < 0.01 and r.get("hours", 0) >= 180 * 24:
        why.append("fiat-like low vol (daily sd < 1%)")
    lb = r.get("lev_beta") or {}
    if lb.get("leveraged") or lb.get("inverse"):
        why.append("leverage-beta")
    if r.get("redenom"):
        why.append("redenomination")
    return ", ".join(why) or None


def cmd_census(out):
    S = sets_and_files()
    kb = known_bases()
    und = underlying_index(S)
    ref = {}
    for b in ("BTC", "ETH", "SOL", "BNB"):
        if b in und:
            ref[b] = und[b][0](und[b][1])
    res = {"sets": {}, "note": "reserved sets: names only (no price file opened)"}
    for nm, L in S.items():
        rows = []
        for b, venue, ld, p in L:
            cls, why = QI.classify_symbol(b, venue, kb)
            r = {"base": b, "venue": venue, "name_class": cls, "name_reason": why}
            if nm in SEEN and ld is not None and p and os.path.exists(p):
                c, t0 = ld(p)
                r["hours"] = int(len(c))
                pc = QI.peg_check(c, start_ts=t0)
                r["peg1"] = {k: pc[k] for k in ("share_in_band", "sd_daily", "pegged")}
                jumps = QI.rebase_jumps(c, start_ts=t0)
                r["jumps_x4_persist"] = len(jumps)
                r["jumps_pow10"] = sum(j["near_pow10"] for j in jumps)
                r["redenom"] = sum(j["redenomination"] for j in jumps)
                if jumps:
                    r["jumps"] = jumps[:6]
                m = QI.PEG_ROOT_RE.match(b)
                if m and m.group("a") in ref:
                    rc, rt = ref[m.group("a")]
                    pr = QI.peg_check(c, ref=rc, start_ts=t0, ref_start_ts=rt)
                    r["peg_ref"] = {"ref": m.group("a"), **{k: pr[k] for k in ("share_in_band", "sd_daily_vs_ref",
                                                                                  "median_level_vs_ref", "pegged")}}
                mw = QI.LEV_WORD_RE.match(b) or QI.LEV_DIGIT_RE.match(b)
                if mw and mw.group("u") in und:
                    uc, ut = und[mw.group("u")][0](und[mw.group("u")][1])
                    r["lev_beta"] = QI.leverage_beta(c, uc, t0, ut)
            r["exclude"] = decide(r)
            rows.append(r)
        res["sets"][nm] = rows
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    json.dump(res, open(out, "w"), indent=1, default=float)
    print("wrote", out)


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "census":
        cmd_census(sys.argv[2])
