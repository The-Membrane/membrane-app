#!/usr/bin/env python3
"""Q26 workstream B4.1: acquisition of blind set B-5 (unseen Aave V3 Ethereum stablecoin reserves).

Implements membrane-board `design/DEPOSITOR_BEHAVIOR_PREREG_B4.md` section B4.1 (registered at board commit
019adca, sha256 255c20e6...6106): every stablecoin reserve of Aave V3 Ethereum Core and Aave V3 Ethereum Prime,
except Core USDC, USDT, DAI, USDe and GHO, that has >= 20 units with balance >= $1M on >= 30 days. The list is
fixed here from balances only. This builder computes NO outcome: no exit label, no drop, no rate, no score.

Method = `g_acquire_events.py` holdout mode (B-gradient G.1-G.2, deviation D2 gate), imported unchanged where it is
pool-agnostic (logs, timestamps, decode, universe, anchors, gate, writers). The pieces that call the Pool take the
reserve's own Pool here (Core or Prime): selection, reference reads and the daily reserve state. Holder type is read
as in B3.1 (code at block 26,186,746).

Phases (resumable from --work-dir; run in this order):
  select     both Pools' getReservesList at the asof block; symbol, decimals, aToken, oracle price; the written
             stablecoin rule (B5-1); exclusions; aToken deployment blocks; reference reads
  logs       eth_getLogs per candidate aToken, deployment -> asof (rpc.mevblocker.io, G.1 policy)
  timestamps block timestamps (from the logs, seeded sample checked on eth.drpc.org)
  decode     Mint / Burn / BalanceTransfer decode
  universe   addresses whose event-reconstructed balance reaches >= $1M at any time
  screen     a candidate whose universe has < 20 addresses cannot reach 20 units: no anchors (B5-4)
  anchors    daily 00:00Z balanceOf for every universe address of the screened candidates (B.1 method)
  rstate     daily reserve state at the same snapshot blocks (reserve's own Pool)
  gate_new   the D2 gate on the anchors (per reserve and pooled) + coverage
  count      units with a daily anchor >= $1M on >= 30 days, from the anchors only -> the B-5 list (B5-5)
  codes      holder type at block 26,186,746 for the universe of the B-5 reserves (B5-6)
  write      membrane-datasets depositor-blind5/: per reserve events, raw logs, block timestamps, universe,
             anchors, reserve state, holder codes; candidates.csv, unit-counts.csv, gate-report.json, run-log.json,
             PROVENANCE.md (rule, list, counts, blocks, sha256)

  python3 b4_acquire_blind5.py --work-dir SCRATCH/b5work [--out-dir DATASETS/depositor-blind5] [--phases all|p1,p2]

Addresses are public on-chain data. This code attaches no identity, label or name to any address.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import b_acquire as B  # noqa: E402
import g_acquire_events as GA  # noqa: E402

PREREG = {
    "repo": "membrane-board", "path": "design/DEPOSITOR_BEHAVIOR_PREREG_B4.md", "section": "B4.1",
    "commit": "019adca", "sha256": "255c20e6ab75d4ef1947c7cae5b4ed084fe78d7b6c0eb1beba104049b9556106",
    "method_parent": "design/DEPOSITOR_BEHAVIOR_PREREG_B2.md G.1-G.2 (5e45406), D2 gate tolerance (567955a)",
}
POOLS = {"Core": "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
         "Prime": "0x4e033931ad43597d96D6bcc25c280717730B58B1"}
# Core reserves that are not in B-5 (B4.1): the B-gradient / B3 development reserves
EXCLUDED_CORE = {
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": "USDC",
    "0xdac17f958d2ee523a2206206994597c13d831ec7": "USDT",
    "0x6b175474e89094c44da98b954eedeac495271d0f": "DAI",
    "0x4c9edd5852cd905f086c759e8383e09bff1e68b3": "USDe",
    "0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f": "GHO",
}
# the same asof as depositor-events/ and its holdouts (B5-2)
ASOF_BLOCK = 26_186_746
ASOF_TS = 1_791_932_759
ASOF_HASH = "0xb76fd3879f73b50d00f08f1d4679a3a64f79eec6c04414e9762e041a2fe1287b"
CODE_BLOCK = 26_186_746                       # B3.1 holder type block (cross-venue/address-flags.csv)
PEG_BAND = (0.98, 1.02)
UNIT_MIN_DAYS = 30                            # B4.1: balance >= $1M on >= 30 days
UNIT_MIN_N = 20                               # B4.1: >= 20 units
THRESHOLD_UNITS = GA.THRESHOLD_RAW            # $1,000,000 in 6-decimal units (1 token = $1)

# ---------------------------------------------------------------------------------------------
# B5-1: the stablecoin rule (written before any B-5 balance was read)
# ---------------------------------------------------------------------------------------------
USD_STABLECOINS = {   # issued tokens designed to be redeemable for / held at 1 USD; a balance counts dollars 1:1
    "USDC": "fiat-backed", "USDT": "fiat-backed", "PYUSD": "fiat-backed", "USDtb": "fiat-backed",
    "RLUSD": "fiat-backed", "USDG": "fiat-backed", "mUSD": "fiat-backed", "FDUSD": "fiat-backed",
    "TUSD": "fiat-backed", "USDP": "fiat-backed", "GUSD": "fiat-backed", "BUSD": "fiat-backed",
    "DAI": "crypto-backed", "USDS": "crypto-backed", "GHO": "crypto-backed", "LUSD": "crypto-backed",
    "BOLD": "crypto-backed", "crvUSD": "crypto-backed", "FRAX": "crypto-backed", "frxUSD": "crypto-backed",
    "USDe": "synthetic", "USD0": "fiat-backed", "AUSD": "fiat-backed",
}
NON_USD_STABLECOINS = {"EURC": "EUR", "EURS": "EUR", "EURe": "EUR", "GHO-EUR": "EUR"}
YIELD_SHARES = {"sUSDe", "sDAI", "sUSDS", "syrupUSDT", "syrupUSDC", "stUSD", "sFRAX", "sfrxUSD", "scrvUSD", "USD0++",
                "stkGHO", "sGHO", "wUSDM", "USDM"}
RECEIPTS = {"eUSDe"}
STABLECOIN_RULE = (
    "B5-1 stablecoin = the reserve's underlying is an ISSUED USD stablecoin: a token minted and redeemed (or held by "
    "its protocol) at 1 USD whose balance counts dollars 1:1 - fiat-backed (USDC, USDT, PYUSD, USDtb, RLUSD, USDG, "
    "mUSD, ...), crypto-backed (DAI, USDS, GHO, LUSD, crvUSD, FRAX, ...) or synthetic (USDe). Not stablecoins here: "
    "yield-bearing savings / vault shares (sUSDe, sDAI, syrupUSDT, ...: price drifts above 1), Pendle principal tokens "
    "(symbol 'PT-...': fixed-maturity discount claims on another token), pre-deposit receipts that wrap another "
    "stablecoin (eUSDe), non-USD stablecoins (EURC: the B code counts 1 token as $1, so a EUR token would misstate "
    "the $1M threshold), and every non-dollar asset (ETH, BTC, governance tokens, gold). Classification by the "
    "underlying's on-chain symbol() and decimals() at the asof block (lists in USD_STABLECOINS, NON_USD_STABLECOINS, "
    "YIELD_SHARES, RECEIPTS); check: an included token's Aave oracle price at the asof block must lie in "
    "[0.98, 1.02] USD (its own Pool's oracle), else it is excluded and reported. The rule was written after the two "
    "Pools' symbol lists were read (Core's was already in depositor-events/holdouts/holdout-candidates.csv), before "
    "any B-5 log, balance or count was read.")
DECISIONS = [
    STABLECOIN_RULE,
    "B5-2 asof = block 26,186,746 (2026-10-13T23:05:59Z), the asof of depositor-events/ and its holdouts, so the "
    "B-gradient / B3 loaders, snapshot labels ('asof' = 26,180,400, 'asof_events' = 26,186,746) and folds apply "
    "unchanged; the last test quarter ends 2026-10-01 and its 7 d windows end by 2026-10-08. Reserve list = "
    "getReservesList() of each Pool at this block (a reserve dropped before it is not in the list). Daily snapshots "
    "= depositor-balances/blocks.csv (2023-02-01..2026-10-07, 00:00Z).",
    "B5-3 units = (address, reserve), a reserve = (Pool, underlying); Prime USDC, GHO and USDS are not the excluded "
    "Core reserves and are candidates. Reserve names: '<Pool>_<symbol>' (e.g. Prime_USDC).",
    "B5-4 screen: the extended universe (event-reconstructed balance >= $1M at any moment, G.2) contains every "
    "address that ever holds a daily anchor >= $1M, so a candidate whose universe has < 20 addresses cannot have "
    ">= 20 units and gets no anchors (excluded: 'universe < 20'). Every other candidate is anchored and counted.",
    "B5-5 count (B4.1, balances only): a unit counts iff its address has a valid daily 00:00Z anchor (status ok) "
    ">= $1,000,000 (token units at $1; exact integers floored to 1e-6-token units, as bg_gradient.to_micro defines the model rows) on >= 30 of the daily snapshots "
    "2023-02-01..2026-10-07 (the asof anchors are not daily snapshots). A candidate is in B-5 iff >= 20 units count. "
    "The count reads anchors only: no event window, drop, exit or outcome is evaluated.",
    "B5-6 holder type as B3.1 / B3-2 at block 26,186,746: contract = code that is not an EIP-7702 designator; "
    "wallet = no code or 0xef0100 + 20-byte designator. Source per address: cross-venue/address-flags.csv where the "
    "address is in it (same block, same rule), else history-forecasts/b3/run-6b2ff4d7/holdout-codes.json (same "
    "block), else one eth_getCode on eth.drpc.org at the block (recorded).",
    "B5-7 the D2 gate (G.2 with D2 tolerance) runs on the anchors of every anchored candidate; it must pass pooled "
    "AND for each B-5 reserve alone, else the run stops. Per reserve and pooled shares are recorded.",
    "B5-8 only the B-5 reserves are written in full; candidates.csv lists every reserve of both Pools with its "
    "class, and unit-counts.csv every stablecoin candidate with universe size, units and the rule outcome.",
]

# ---------------------------------------------------------------------------------------------
# Pure helpers (unit-tested)
# ---------------------------------------------------------------------------------------------


def classify(symbol: str, price_usd) -> tuple[bool, str]:
    """B5-1 -> (is_stablecoin, class or reason)."""
    s = symbol or ""
    if s.startswith("PT-"):
        return False, "Pendle principal token (fixed-maturity discount claim)"
    if s in YIELD_SHARES:
        return False, "yield-bearing savings / vault share"
    if s in RECEIPTS:
        return False, "pre-deposit receipt wrapping another stablecoin"
    if s in NON_USD_STABLECOINS:
        return False, f"non-USD stablecoin ({NON_USD_STABLECOINS[s]})"
    if s in USD_STABLECOINS:
        if price_usd is None or not PEG_BAND[0] <= price_usd <= PEG_BAND[1]:
            return False, f"USD stablecoin by symbol but oracle price {price_usd} outside [0.98, 1.02]"
        return True, f"USD stablecoin ({USD_STABLECOINS[s]})"
    return False, "not a stablecoin"


def reserve_name(pool: str, symbol: str) -> str:
    return f"{pool}_{GA.safe_name(symbol)}"


def floor_micro(raw: int, decimals: int) -> int:
    """Raw token amount -> 1e-6-token units, floored (as bg_gradient.to_micro, which defines the model rows)."""
    return raw // 10 ** (decimals - 6) if decimals >= 6 else raw * 10 ** (6 - decimals)


def count_units(anchor_rows: list[list], decimals: int, daily_labels: set[str], threshold=THRESHOLD_UNITS,
                min_days=UNIT_MIN_DAYS) -> dict:
    """B5-5. anchor_rows = long rows (snapshot, address, balance_raw, status) (status '' = ok). Returns
    {address: number of daily snapshots with a valid anchor >= threshold (1e-6-token units)}, every address listed."""
    days: dict[str, int] = {}
    for s, a, v, st in anchor_rows:
        days.setdefault(a, 0)
        if s not in daily_labels or st or not isinstance(v, int):
            continue
        if floor_micro(v, decimals) >= threshold:
            days[a] += 1
    return days


def units_qualifying(days: dict[str, int], min_days=UNIT_MIN_DAYS) -> int:
    return sum(1 for v in days.values() if v >= min_days)


def b5_selected(n_units: int) -> bool:
    return n_units >= UNIT_MIN_N


# ---------------------------------------------------------------------------------------------
# Pool-aware reads (the parts of g_acquire_events that call the Core Pool)
# ---------------------------------------------------------------------------------------------


def ref_reads_b5(ctx, block: int) -> dict:
    """GA.ref_reads with each reserve's own Pool."""
    calls, labels = [], []
    for r in ctx.order:
        a, at, pool = ctx.reserves[r]["asset"], ctx.reserves[r]["atoken"], ctx.reserves[r]["pool"]
        calls += [(pool, GA.sel("getReserveNormalizedIncome(address)") + B.enc_address(a)),
                  (at, GA.sel("scaledTotalSupply()")), (at, GA.sel("totalSupply()"))]
        labels += [(r, "normalizedIncome"), (r, "scaledTotalSupply"), (r, "totalSupply")]
    out = {}
    for ch_calls, ch_labels in zip(B.chunk(calls, 300), B.chunk(labels, 300)):
        res = ctx.rpc.multicall(ch_calls, block, "select", tag=f"refs {block}")
        for (r, lab), (ok, ret) in zip(ch_labels, res):
            if not ok or len(ret) != 32:
                raise B.TerminalError(f"reference read failed {r} {lab} at {block}")
            out.setdefault(r, {})[lab] = str(int.from_bytes(ret, "big"))
    return out


def phase_select(ctx) -> None:
    st = ctx.state
    if st.get("holdouts", {}).get("done"):
        ctx.set_reserves(st["holdouts"]["reserves"])
        return
    rpc = ctx.rpc
    blk = rpc.block_obj(ASOF_BLOCK, "select")
    if blk["hash"].lower() != ASOF_HASH or int(blk["timestamp"], 16) != ASOF_TS:
        raise B.TerminalError("asof block hash / ts differ from depositor-events")
    st["asof"] = {"block": ASOF_BLOCK, "ts": ASOF_TS, "hash": ASOF_HASH,
                  "rule": "the asof of depositor-events/ and holdouts (B5-2); hash re-read on eth.drpc.org"}
    st["asof_crosscheck"] = {"state_rpc_hash": blk["hash"], "match": True, "state_rpc_ts": int(blk["timestamp"], 16)}
    st["signatures"] = GA.check_signatures()
    if not st["signatures"]["ok"]:
        raise B.TerminalError("keccak self-check failed")
    st["b1_inputs"] = GA.check_b1_inputs(ctx)
    sel_st = st.setdefault("select", {})
    ec = lambda to, data, b, tag: rpc.eth_call(to, data, b, "select", tag=tag)  # noqa: E731
    for pool, pa in POOLS.items():
        if pool in sel_st:
            continue
        assets = GA.decode_address_array(ec(pa, GA.sel("getReservesList()"), ASOF_BLOCK, f"{pool} reservesList"))
        provider = B.word_to_address(B.decode_uint(ec(pa, GA.sel("ADDRESSES_PROVIDER()"), ASOF_BLOCK, f"{pool} prov")))
        oracle = B.word_to_address(B.decode_uint(ec(provider, GA.sel("getPriceOracle()"), ASOF_BLOCK, f"{pool} orc")))
        base = B.decode_uint(ec(oracle, GA.sel("BASE_CURRENCY_UNIT()"), ASOF_BLOCK, f"{pool} base"))
        calls = []
        for a in assets:
            calls += [(pa, B.call_data("getReserveData", a)), (a, GA.sel("symbol()")), (a, GA.sel("decimals()")),
                      (oracle, GA.sel("getAssetPrice(address)") + B.enc_address(a))]
        res = []
        for ch in B.chunk(calls):
            res += rpc.multicall(ch, ASOF_BLOCK, "select", tag=f"{pool} reserve info")
        info = {}
        for i, a in enumerate(assets):
            rd = B.decode_reserve_data(*res[4 * i])
            ok_d, ret_d = res[4 * i + 2]
            ok_p, ret_p = res[4 * i + 3]
            info[a] = {"symbol": GA.decode_symbol(*res[4 * i + 1]),
                       "decimals": B.decode_uint(ret_d) if ok_d and len(ret_d) == 32 else None,
                       "aToken": rd.get("aTokenAddress"), "rd_status": rd["status"],
                       "price_raw": B.decode_uint(ret_p) if ok_p and len(ret_p) == 32 else None}
        ts_res = rpc.multicall([(info[a]["aToken"], GA.sel("totalSupply()")) for a in assets], ASOF_BLOCK, "select",
                               tag=f"{pool} aToken supply")
        for a, (ok, ret) in zip(assets, ts_res):
            info[a]["totalSupply_raw"] = B.decode_uint(ret) if ok and len(ret) == 32 else None
        sel_st[pool] = {"pool": pa, "assets": assets, "provider": provider, "oracle": oracle, "base_unit": base,
                        "info": info}
        ctx.save_state()
    cands = []
    for pool in POOLS:
        ps = sel_st[pool]
        for a in ps["assets"]:
            x = ps["info"][a]
            price = x["price_raw"] / ps["base_unit"] if x["price_raw"] is not None else None
            stable, why = classify(x["symbol"], price)
            excl = pool == "Core" and a in EXCLUDED_CORE
            supply_usd = (x["totalSupply_raw"] / 10 ** x["decimals"] * price
                          if x["totalSupply_raw"] is not None and x["decimals"] and price is not None else None)
            cands.append({"pool": pool, "asset": a, "symbol": x["symbol"], "decimals": x["decimals"],
                          "aToken": x["aToken"], "price_asof_usd": price, "totalSupply_raw": x["totalSupply_raw"],
                          "supply_usd_asof": supply_usd, "stablecoin": stable, "class": why,
                          "excluded_dev_reserve": excl,
                          "candidate": bool(stable and not excl and x["aToken"] and x["aToken"] != B.ZERO_ADDRESS
                                            and (x["decimals"] or 0) >= 1),
                          "name": reserve_name(pool, x["symbol"])})
    reserves = {}
    for c in cands:
        if not c["candidate"]:
            continue
        if c["name"] in reserves:
            raise B.TerminalError(f"duplicate reserve name {c['name']}")
        reserves[c["name"]] = {"asset": c["asset"], "atoken": c["aToken"], "decimals": c["decimals"],
                               "symbol": c["symbol"], "pool": POOLS[c["pool"]], "pool_name": c["pool"]}
    listing = sel_st.setdefault("listing", {})
    for n, v in reserves.items():
        if n in listing:
            continue
        at = v["atoken"]
        cache: dict[int, bool] = {}

        def has_code(b, at=at, cache=cache):
            if b not in cache:
                cache[b] = GA.eth_get_code_len(ctx, at, b) > 0
            return cache[b]

        b0 = GA.find_deploy_block(has_code, GA.DEPLOY_SEARCH_LO, ASOF_BLOCK)
        bo = rpc.block_obj(b0, "select")
        listing[n] = {"block": b0, "ts": int(bo["timestamp"], 16), "probes": len(cache)}
        ctx.save_state()
    st["deploy"] = {n: {"block": listing[n]["block"], "ts": listing[n]["ts"], "utc": B.iso_utc(listing[n]["ts"]),
                        "rule": "smallest block whose post-state has code at the aToken address (eth_getCode bisection)"}
                    for n in reserves}
    ctx.set_reserves(reserves)
    st["refs"] = {lab: {"block": b, "reads": ref_reads_b5(ctx, b) if reserves else {}}
                  for lab, b in (("b1_asof", GA.B1_ASOF_BLOCK), ("asof", ASOF_BLOCK))}
    st["holdouts"] = {"select_rule": STABLECOIN_RULE, "pools": {p: {k: sel_st[p][k] for k in ("pool", "provider",
                                                                                          "oracle", "base_unit")}
                                                                 for p in POOLS},
                      "candidates": cands, "reserves": reserves, "done": True}
    ctx.save_state()
    print("SELECT " + json.dumps({"candidates": list(reserves), "n_listed": len(cands)}), flush=True)


def phase_screen(ctx) -> None:
    uni = ctx.state["universe"]
    allres = ctx.state["holdouts"]["reserves"]
    scr = {n: {"universe": uni[n]["n_rule"], "anchored": uni[n]["n_rule"] >= UNIT_MIN_N} for n in allres}
    ctx.state["screen"] = scr
    ctx.state["anchor_set"] = [n for n in allres if scr[n]["anchored"]]
    ctx.save_state()
    print("SCREEN " + json.dumps(scr), flush=True)


def use_anchor_set(ctx) -> None:
    allres = ctx.state["holdouts"]["reserves"]
    ctx.set_reserves({n: allres[n] for n in ctx.state["anchor_set"]})


def phase_rstate(ctx) -> None:
    """GA.phase_rstate with each reserve's own Pool (same checkpoint layout, so GA.rstate_rows decodes it)."""
    store = B.JsonlStore(ctx.work / "rstate.jsonl")
    todo = [x for x in GA.rstate_snapshots(ctx) if not store.has(x[0])]
    print(f"rstate: {len(todo)} snapshots to do", flush=True)

    def do(task):
        s, blk, ts = task
        if ctx.rpc.stop.is_set():
            raise B.TerminalError("stopped")
        lead = []
        for r in ctx.order:
            a, at, pool = ctx.reserves[r]["asset"], ctx.reserves[r]["atoken"], ctx.reserves[r]["pool"]
            lead += [(pool, B.call_data("getReserveData", a)), (at, B.call_data("totalSupply")),
                     (a, B.call_data("balanceOf", at))]
        res = ctx.rpc.multicall(lead, blk, "rstate", tag=f"rstate {s} lead")
        dep_labels, dep_calls = [], []
        for k, r in enumerate(ctx.order):
            rd = B.decode_reserve_data(*res[3 * k])
            if rd.get("status") != "ok" or not rd.get("listed"):
                continue
            vdt, strat = rd["variableDebtTokenAddress"], rd["interestRateStrategyAddress"]
            if vdt != B.ZERO_ADDRESS:
                dep_labels.append(["vd", r, vdt])
                dep_calls.append((vdt, B.call_data("totalSupply")))
            if strat != B.ZERO_ADDRESS:
                for nm in B.V1_CURVE:
                    dep_labels.append(["v1", r, strat, nm])
                    dep_calls.append((strat, B.call_data(nm)))
                dep_labels.append(["v2", r, strat])
                dep_calls.append((strat, B.call_data("getInterestRateData", ctx.reserves[r]["asset"])))
        res2 = ctx.rpc.multicall(dep_calls, blk, "rstate", tag=f"rstate {s} dep") if dep_calls else []
        store.put(s, {"block": blk, "ts": ts, "order": list(ctx.order),
                      "lead": [[1 if ok else 0, ret.hex()] for ok, ret in res],
                      "dep_labels": dep_labels, "dep": [[1 if ok else 0, ret.hex()] for ok, ret in res2]})

    B.run_pool(ctx, "rstate", todo, do)
    ctx._rstate_rows = None


def phase_count(ctx) -> None:
    daily, _ = GA.b1_blocks(ctx)
    labels = {s for s, _, _ in daily}
    plan = GA.new_anchor_plan(ctx)
    out = {}
    for r in ctx.order:
        rows = GA.new_anchor_rows(ctx, r, plan)
        days = count_units(rows, ctx.dec(r), labels)
        n = units_qualifying(days)
        out[r] = {"units_ge_30_days": n, "addresses_anchored": len(days),
                  "addresses_with_any_day_ge_1M": sum(1 for v in days.values() if v > 0),
                  "unit_days_ge_1M": int(sum(days.values())), "selected": b5_selected(n),
                  "days_by_address": days}
    for r in ctx.state["holdouts"]["reserves"]:
        if r not in out:
            out[r] = {"units_ge_30_days": None, "addresses_anchored": 0, "selected": False,
                      "note": "universe < 20 addresses: cannot reach 20 units (B5-4)"}
    ctx.state["count"] = {r: {k: v for k, v in x.items() if k != "days_by_address"} for r, x in out.items()}
    ctx.state["b5"] = [r for r in ctx.order if out[r]["selected"]]
    (ctx.work / "unit-days.json").write_text(json.dumps({r: x.get("days_by_address", {}) for r, x in out.items()}))
    ctx.save_state()
    print("COUNT " + json.dumps(ctx.state["count"]) + " B5 " + json.dumps(ctx.state["b5"]), flush=True)


def check_gate(ctx) -> None:
    g = ctx.state["gate_new"]
    bad = [r for r in ctx.state.get("b5", []) if not g["per_reserve"][r]["passes"]]
    if not g["passes"] or bad:
        raise B.TerminalError(f"D2 gate failed (pooled passes={g['passes']}; B-5 reserves failing alone: {bad})")


def load_known_codes(ddir: Path) -> tuple[dict, dict]:
    known, src = {}, {}
    p = ddir / "cross-venue" / "address-flags.csv"
    with open(p) as f:
        for r in csv.DictReader(f):
            known[r["address"].lower()] = {"is_contract": r["is_contract"] == "1", "eip7702": r["eip7702_delegated"] == "1"}
            src[r["address"].lower()] = "cross-venue/address-flags.csv"
    p2 = ddir / "history-forecasts" / "b3" / "run-6b2ff4d7" / "holdout-codes.json"
    if p2.exists():
        d = json.loads(p2.read_text())
        if int(d["block"]) != CODE_BLOCK:
            raise B.TerminalError("holdout-codes.json block differs")
        for a, v in d["codes"].items():
            if a not in known:
                known[a] = {"is_contract": bool(v["is_contract"]), "eip7702": bool(v["eip7702"])}
                src[a] = "history-forecasts/b3/run-6b2ff4d7/holdout-codes.json"
    return known, src


def phase_codes(ctx) -> None:
    store = B.JsonlStore(ctx.work / "codes.jsonl")
    known, src = load_known_codes(ctx.ddir)
    need = set()
    for r in ctx.state["b5"]:
        for x in ctx.state["universe"][r]["rows"]:
            need.add(x["address"])
    todo = sorted(a for a in need if a not in known and not store.has(a))
    print(f"codes: {len(need)} universe addresses, {len(todo)} eth_getCode reads", flush=True)

    def do(a):
        def v(res):
            if not isinstance(res, str) or not res.startswith("0x"):
                raise B.DecodeError("bad code")
        code = ctx.rpc.call("eth_getCode", [a, hex(CODE_BLOCK)], "codes", tag=a, validate=v)
        body = code[2:].lower()
        e7 = body.startswith("ef0100") and len(body) == 46
        store.put(a, {"is_contract": bool(body) and not e7, "eip7702": e7, "code_bytes": len(body) // 2,
                      "prefix": code[:8]})

    B.run_pool(ctx, "codes", todo, do)
    codes = {}
    for a in sorted(need):
        if a in known:
            codes[a] = dict(known[a], source=src[a])
        else:
            rec = store.get(a)
            codes[a] = {"is_contract": rec["is_contract"], "eip7702": rec["eip7702"],
                        "source": f"eth_getCode {B.RPC_URL} block {CODE_BLOCK}"}
    ctx.state["codes"] = {"block": CODE_BLOCK, "n": len(codes), "n_read": len(todo),
                          "n_contract": sum(v["is_contract"] for v in codes.values()),
                          "n_eip7702": sum(v["eip7702"] for v in codes.values())}
    (ctx.work / "codes-final.json").write_text(json.dumps(codes))
    ctx.save_state()
    print("CODES " + json.dumps(ctx.state["codes"]), flush=True)


# ---------------------------------------------------------------------------------------------
# Write
# ---------------------------------------------------------------------------------------------
CAND_COLS = ["pool", "name", "asset", "symbol", "decimals", "aToken", "price_asof_usd", "supply_usd_asof",
             "stablecoin", "class", "excluded_dev_reserve", "candidate"]
COUNT_COLS = ["name", "pool", "symbol", "decimals", "aToken", "deploy_block", "deploy_utc", "universe_ge_1M_any_time",
              "anchored", "addresses_with_any_day_ge_1M", "units_ge_1M_on_ge_30_days", "selected_b5", "note"]


def phase_write(ctx) -> dict:
    out = ctx.out
    out.mkdir(parents=True, exist_ok=True)
    st = ctx.state
    b5 = st["b5"]
    allres = st["holdouts"]["reserves"]
    files = []
    B.write_csv(out / "candidates.csv", CAND_COLS,
                [[("" if c.get(k) is None else c.get(k)) for k in CAND_COLS]
                 for c in sorted(st["holdouts"]["candidates"], key=lambda c: (c["pool"], not c["candidate"],
                                                                               c["symbol"]))], gz=False)
    files.append("candidates.csv")
    crow = []
    for n in allres:
        cnt = st["count"][n]
        crow.append([n, allres[n]["pool_name"], allres[n]["symbol"], allres[n]["decimals"], allres[n]["atoken"],
                     st["deploy"][n]["block"], st["deploy"][n]["utc"], st["screen"][n]["universe"],
                     st["screen"][n]["anchored"], cnt.get("addresses_with_any_day_ge_1M", ""),
                     "" if cnt["units_ge_30_days"] is None else cnt["units_ge_30_days"], cnt["selected"],
                     cnt.get("note", "")])
    B.write_csv(out / "unit-counts.csv", COUNT_COLS, crow, gz=False)
    files.append("unit-counts.csv")
    tsl = GA.ts_lookup(ctx)
    plan = GA.new_anchor_plan(ctx)
    rs = GA.rstate_rows(ctx)
    codes = json.loads((ctx.work / "codes-final.json").read_text())
    for r in b5:
        sub = out / r
        sub.mkdir(parents=True, exist_ok=True)
        names = GA.write_reserve_logs(ctx, sub, r, tsl)
        blocks = {lg["block"] for lg in ctx.store.iter_reserve(r)}
        names += GA.write_blocks(ctx, sub, blocks, tsl)
        rows = [[r] + [x[c] for c in GA.UNIVERSE_COLS[1:]] for x in st["universe"][r]["rows"]]
        B.write_csv(sub / "extended-universe.csv", GA.UNIVERSE_COLS, rows, gz=False)
        names.append("extended-universe.csv")
        nm = f"daily-balances-{r.lower()}.csv.gz"
        GA.write_csv_gz(sub / nm, ["snapshot", "address", "balance_raw", "status"], GA.new_anchor_rows(ctx, r, plan))
        names.append(nm)
        B.write_csv(sub / "reserve-state.csv", B.RESERVE_STATE_COLS,
                    ([B.fmt(row.get(c)) for c in B.RESERVE_STATE_COLS] for row in rs if row["reserve"] == r), gz=False)
        names.append("reserve-state.csv")
        B.write_csv(sub / "holder-codes.csv", ["address", "is_contract", "eip7702_delegated", "source"],
                    [[x["address"], int(codes[x["address"]]["is_contract"]), int(codes[x["address"]]["eip7702"]),
                      codes[x["address"]]["source"]] for x in st["universe"][r]["rows"]], gz=False)
        names.append("holder-codes.csv")
        files += [f"{r}/{n}" for n in names]
    g = st["gate_new"]
    rep = {"prereg": PREREG, "decisions": DECISIONS, "gate": g, "coverage": st.get("coverage"),
           "decode": st.get("decode"), "screen": st.get("screen"), "count": st.get("count"), "b5": b5,
           "codes": st.get("codes"),
           "universe": {r: {k: v for k, v in u.items() if k != "rows"} for r, u in st.get("universe", {}).items()}}
    (out / "gate-report.json").write_text(json.dumps(rep, indent=1, default=str) + "\n")
    files.append("gate-report.json")
    meta = GA.build_run_meta(ctx)
    meta.update(dataset="depositor-blind5", prereg=PREREG, decisions=DECISIONS, code_b4=code_info())
    (out / "run-log.json").write_text(json.dumps(meta, indent=1, default=str) + "\n")
    files.append("run-log.json")
    big = [f for f in files if (out / f).stat().st_size >= 50_000_000]
    if big:
        raise B.TerminalError(f"files >= 50 MB: {big}")
    return GA._finish(out, files, lambda info: provenance_md(ctx, meta, info), subdirs=tuple(b5))


def code_info() -> dict:
    import subprocess
    here = Path(__file__).resolve()
    root = here.parents[3]
    rel = str(here.relative_to(root))
    g = lambda *a: subprocess.run(["git", "-C", str(root), *a], capture_output=True, text=True).stdout.strip()  # noqa
    return {"head": g("rev-parse", "HEAD"), "file": rel, "file_last_commit": g("log", "-1", "--format=%H", "--", rel),
            "file_sha256": B.sha256_file(here), "dirty": bool(g("status", "--porcelain", "--", rel)),
            "g_acquire_events_sha256": B.sha256_file(here.parent / "g_acquire_events.py"),
            "b_acquire_sha256": B.sha256_file(here.parent / "b_acquire.py")}


def provenance_md(ctx, meta: dict, files: dict) -> str:
    st = ctx.state
    a = st["asof"]
    allres = st["holdouts"]["reserves"]
    b5 = st["b5"]
    g = st["gate_new"]
    dec = st.get("decode", {})
    pools = st["holdouts"]["pools"]
    lines = [
        "# depositor-blind5 — provenance",
        "",
        "Blind set B-5 of Q26 workstream B4 (locked until B4.6; no fit, audit or score has read it): every stablecoin",
        "reserve of Aave V3 Ethereum Core and Aave V3 Ethereum Prime, except Core USDC, USDT, DAI, USDe and GHO, that",
        "has ≥ 20 units (address, reserve) with a daily 00:00Z balance ≥ $1M on ≥ 30 days. The list was fixed by this",
        "acquisition from balances only. No exit label, drop, rate or other outcome was computed.",
        f"Prereg `{PREREG['repo']}` `{PREREG['path']}` §B4.1 (commit `{PREREG['commit']}`, sha256 "
        f"`{PREREG['sha256'][:8]}…{PREREG['sha256'][-4:]}`). Method: `g_acquire_events.py` holdout mode (B-gradient",
        "G.1–G.2, D2 gate tolerance), with each reserve's own Pool for selection, reference reads and reserve state.",
        "",
        "## Rule and decisions",
        "",
        *[f"- {d}" for d in DECISIONS],
        "",
        "## Pools",
        "",
        *[f"- {p}: Pool `{v['pool']}`, PoolAddressesProvider `{v['provider']}`, oracle at asof `{v['oracle']}`."
          for p, v in pools.items()],
        f"- **Asof:** block {a['block']} ({B.iso_utc(a['ts'])}, hash `{a['hash']}`). Holder codes at block {CODE_BLOCK}.",
        "  Snapshot blocks: membrane-datasets `depositor-balances/blocks.csv` (`2ca6d16`, sha256 checked).",
        *GA.SOURCE_LINES,
        f"- **Builder:** `The-Membrane/membrane-app` branch `research/history-forecasts`, "
        f"`{meta['code_b4']['file']}` (sha256 `{meta['code_b4']['file_sha256']}`, last commit "
        f"`{meta['code_b4']['file_last_commit']}`{', DIRTY' if meta['code_b4']['dirty'] else ''}); helpers",
        f"  `g_acquire_events.py` (sha256 `{meta['code_b4']['g_acquire_events_sha256']}`), `b_acquire.py`.",
        f"- **Fetch window (UTC):** {meta['fetch_window_utc'][0]} → {meta['fetch_window_utc'][1]}.",
        "- **Status:** FROZEN blind acquisition (inputs to Q26 B4.6 only; do not refetch or edit).",
        "",
        "## Candidates and the unit count (balances only)",
        "",
        "| reserve | aToken | deployed | universe (≥ $1M any time) | units ≥ $1M on ≥ 30 days | in B-5 |",
        "|---|---|---|---:|---:|---|",
    ]
    for n in allres:
        c = st["count"][n]
        lines.append(f"| {n} | `{allres[n]['atoken']}` | block {st['deploy'][n]['block']} ({st['deploy'][n]['utc'][:10]})"
                     f" | {st['screen'][n]['universe']} | {'—' if c['units_ge_30_days'] is None else c['units_ge_30_days']}"
                     f" | {'**yes**' if c['selected'] else 'no'} |")
    lines += ["", f"**B-5 list:** {', '.join(b5) if b5 else 'none'}.", ""]
    for r in b5:
        x = dec.get(r, {})
        lines.append(f"- {r}: {x.get('n_logs')} logs; by type {json.dumps(x.get('by_type'))}; other known "
                     f"{json.dumps(x.get('other_known'))}; unknown topic0 {json.dumps(x.get('unknown_topic0'))}.")
    lines += [""] + GA._gate_lines("Gate on the anchored candidates (pooled)", g)
    for r in st["anchor_set"]:
        pr = g["per_reserve"][r]
        lines.append(f"- {r}: D2 {'PASS' if pr['passes'] else 'FAIL'} — {GA._f5(pr['share_pass'])} of {pr['n_pairs']} "
                     f"pairs, {GA._f5(pr['share_pass_with_event'])} of {pr['n_pairs_with_event']} with an event.")
    cv = st.get("codes", {})
    lines += ["", f"Holder codes (B-5 universe): {cv.get('n')} addresses, {cv.get('n_contract')} contracts, "
                  f"{cv.get('n_eip7702')} EIP-7702 delegations; {cv.get('n_read')} read by eth_getCode.",
              "", "**Partial exposure (stated in B4.1):** some B-5 aTokens are among the 72 cross-venue receipt tokens;",
              "share paths of B-universe addresses on them entered the B3 v3 features. No B-5 outcome has been computed.",
              "", "## Formats", "", *GA.FORMAT_LINES,
              "  - `daily-balances-<reserve>.csv.gz`: B.1 long format for every universe address, every daily snapshot",
              "    from its first event day (UTC) on, then `asof` (block 26180400) and `asof_events` (block 26186746).",
              "  - `reserve-state.csv`: depositor-balances columns at every daily snapshot block plus both asof blocks.",
              "  - `holder-codes.csv`: holder type per universe address (B5-6) with its source.",
              "  - top level: `candidates.csv` (every reserve of both Pools, class), `unit-counts.csv`, `gate-report.json`,",
              "    `run-log.json`.", "", "| file | bytes | sha256 |", "|---|---:|---|"]
    for n, f in sorted(files.items()):
        lines.append(f"| `{n}` | {f['bytes']} | `{f['sha256']}` |")
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------------------------
PHASES = ("select", "logs", "timestamps", "decode", "universe", "screen", "anchors", "rstate", "gate_new", "count",
          "codes", "write")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--work-dir", required=True)
    ap.add_argument("--out-dir", default=None)
    ap.add_argument("--phases", default="all")
    a = ap.parse_args(argv)
    ddir = GA.datasets_dir()
    out = Path(a.out_dir) if a.out_dir else ddir / "depositor-blind5"
    ctx = GA.Ctx(Path(a.work_dir), out, ddir, mode="blind5", reserves={})
    if ctx.state.get("holdouts", {}).get("done"):
        ctx.set_reserves(ctx.state["holdouts"]["reserves"])
    phases = PHASES if a.phases == "all" else tuple(p.strip() for p in a.phases.split(","))
    session = {"start_utc": GA.utcnow(), "code": GA.git_info(), "code_b4": code_info(), "phases": list(phases),
               "phase_seconds": {}}
    ctx.state.setdefault("sessions", []).append(session)
    ctx.save_state()
    status = "ok"
    try:
        for p in phases:
            t0 = time.monotonic()
            print(f"PHASE {p} start {GA.utcnow()}", flush=True)
            if p in ("anchors", "rstate", "gate_new", "count", "codes", "write"):
                use_anchor_set(ctx)
            if p == "select":
                phase_select(ctx)
            elif p == "logs":
                GA.phase_logs(ctx)
            elif p == "timestamps":
                GA.phase_timestamps(ctx)
            elif p == "decode":
                GA.phase_decode(ctx)
            elif p == "universe":
                GA.phase_universe(ctx)
            elif p == "screen":
                phase_screen(ctx)
            elif p == "anchors":
                GA.phase_anchors(ctx)
            elif p == "rstate":
                phase_rstate(ctx)
            elif p == "gate_new":
                GA.phase_gate_new(ctx)
                ctx.state["coverage"] = GA.coverage(ctx)
                ctx.save_state()
                g = ctx.state["gate_new"]
                print("GATE " + json.dumps({"pooled": g["pooled"], "per_reserve": g["per_reserve"]}), flush=True)
                if not g["passes"]:
                    raise B.TerminalError("D2 gate failed (pooled)")
            elif p == "count":
                phase_count(ctx)
                check_gate(ctx)
            elif p == "codes":
                phase_codes(ctx)
            elif p == "write":
                check_gate(ctx)
                session["status"] = "ok"
                session["end_utc"] = GA.utcnow()
                session["logs_counts"] = ctx.logs_client.counts
                session["state_counts"] = ctx.rpc.counts
                ctx.save_state()
                info = phase_write(ctx)
                print("FILES " + json.dumps(info), flush=True)
            session["phase_seconds"][p] = round(time.monotonic() - t0, 1)
            ctx.save_state()
    except B.TerminalError as e:
        status = f"stopped: {e}"
        print(f"STOPPED {e}", flush=True)
    finally:
        session["end_utc"] = GA.utcnow()
        session["logs_counts"] = ctx.logs_client.counts
        session["state_counts"] = ctx.rpc.counts
        session["status"] = status
        ctx.save_state()
    return 0 if status == "ok" else 2


if __name__ == "__main__":
    sys.exit(main())
