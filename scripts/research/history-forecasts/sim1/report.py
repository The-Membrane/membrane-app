"""Slice-1 scenario report (research build; nothing here is displayed in the app).

  python3 -m sim1.report run --work W --datasets DS --t0 2026-10-18T00:00:00Z --out report.json \
      [--paths 10000] [--seed 20261018] [--confidence P,X,N,S]

Writes one JSON report for the demo vault: preset questions CQ1-CQ8 (design section 1), each output with its
confidence class (weakest link, classes.json), labels and evidence; q95 is the primary tail and q99 is
scenario-only (owner decision (a)); the confidence filter (owner decision (b)) decides which outputs carry values,
the rest are listed in `withheld` by id and class. No address is written (checked before the write). It runs no
validation back-replay and reads no reserved set (design 5.1, inventory section 11).
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import gzip
import hashlib
import json
import os
import re
import subprocess
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
from sim1 import cash24 as C24  # noqa: E402
from sim1 import classes as CL  # noqa: E402
from sim1 import config as CFG  # noqa: E402
from sim1 import engine as EN  # noqa: E402
from sim1 import flows as FL  # noqa: E402
from sim1 import liq as LQ  # noqa: E402
from sim1 import paths as PA  # noqa: E402

SCHEMA = "q26-sim/slice1-report/1"
PATH_POOL_LIMITATION = (
    "Path-pool coverage gap: the coupled paths draw only 00:00Z windows from 2023-07 to 2026-10 (the span with "
    "flow history for both reserves), so 2020-2022 crashes are absent and the path set's touch frequencies run "
    "below the live (fH) odds (for example ETH 1 d -5%: 6.8% of paths vs 9.1% live). Scenario tails are therefore "
    "likely understated; the live A6 numbers (CQ7) use the full history.")
ADDR_RE = re.compile(r"0x[0-9a-fA-F]{40}")
HOUR, DAY = 3600, 86400
MOVES = (0.05, 0.10, 0.25, 0.50)
STRESS = {"aug-2024": ("2024-08-04", "Yen carry unwind (2024-08-05)"),
          "oct-2025": ("2025-10-10", "Oct 10-11 2025 (CEX-only depeg, L2 liquidations; Q28 days)"),
          "apr-2026": ("2026-04-18", "rsETH exploit and April 2026 run (price and flow replay; backing markdown "
                                     "not scripted in slice 1)")}
WORDING = {
    "CQ1": "How much bad debt could my vault take on a 1-in-20 day? (1-in-100 on the scenario filter only)",
    "CQ2": "What is the chance a market's cash runs low enough to block withdrawals?",
    "CQ3": "What APR range should I expect on my allocation?",
    "CQ4": "Which exposure drives the tail?",
    "CQ5": "What if I move X% from market A to market B?",
    "CQ6": "How fast could the big holders in my markets leave?",
    "CQ7": "How likely is a short, sharp collateral move that reaches my markets' liquidation ladder?",
    "CQ8": "What would the named crises do to my vault today?",
}


def jload(path):
    with gzip.open(path, "rt") as f:
        return json.load(f)


def sha256_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def git_meta():
    root = os.path.dirname(HERE)
    files = sorted(f for f in os.listdir(HERE) if f.endswith((".py", ".json")))
    try:
        sha = subprocess.check_output(["git", "-C", root, "rev-parse", "HEAD"], text=True).strip()
        dirty = subprocess.check_output(["git", "-C", root, "status", "--porcelain", "--", "sim1"], text=True).strip()
    except Exception:  # noqa: BLE001
        sha, dirty = None, "unknown"
    return {"sha": sha, "sim1_dirty": bool(dirty), "files": {f: sha256_file(os.path.join(HERE, f)) for f in files}}


def q(x, p):
    return float(np.quantile(np.asarray(x, float), p))


def mc_sd(x, p, rng, B=200):
    x = np.asarray(x, float)
    idx = rng.integers(0, len(x), size=(B, len(x)))
    return float(np.std(np.quantile(x[idx], p, axis=1)))


def tail_value(x, p, rng):
    return {"value": q(x, p), "simulation_error_sd": mc_sd(x, p, rng)}


# ---------------------------------------------------------------------------------------------
def load_world(a, t0):
    st = {mk: jload(os.path.join(a.work, mk, f"state-{t0}.json.gz")) for mk in CFG.MARKETS}
    pos = {mk: LQ.positions(st[mk], mk) for mk in CFG.MARKETS}
    M = {mk: FL.load_market(a.datasets, a.work, mk, t0) for mk in CFG.MARKETS}
    first = int(min(M[mk]["t"][0] for mk in M))
    btsf = FL.core_block_ts(a.datasets)
    hours_all = np.arange(first, t0 + 1, HOUR, dtype=np.int64)
    liq = FL.liq_repay_hourly(a.work, t0, hours_all[:-1], btsf)
    HB = {"core": FL.hourly_blocks(M["core"], first, t0, liq),
          "arb": FL.hourly_blocks(M["arb"], first, t0, None)}
    bars = {"eth": PA.load_bars(a.work, "ETHUSDT", t0), "btc": PA.load_bars(a.work, "BTCUSDT", t0)}
    cc = jload(os.path.join(a.work, "arb", "curvecheck.json.gz"))
    return st, pos, M, HB, bars, cc


def flows_for(M, HB, day_ts, H):
    out = {}
    for mk in M:
        t = M[mk]["t"]
        uniq, inv = np.unique(day_ts, return_inverse=True)
        ii = np.searchsorted(t, uniq)
        if not (t[ii] == uniq).all():
            raise SystemExit(f"STOP: {mk} lacks a flow day")
        fb = FL.flow_blocks(M[mk], HB[mk], ii, H)
        out[mk] = {k: v[inv] for k, v in fb.items()}
    return out


def allowed_days(M, H, t0):
    sets = []
    for mk in M:
        t = M[mk]["t"]
        sets.append({int(x) for x in t if x + H * HOUR <= t0 and x + (H // 24) * DAY <= t[-1]})
    first = FL.R4.day_ts(CFG.JOINT_FIRST_DAY)
    return {x for x in set.intersection(*sets) if x >= first}


def realised_paths(bars, day, T):
    out = {"T": T}
    for name in ("eth", "btc"):
        b = bars[name]
        i = int(np.searchsorted(b["ts"], FL.R4.day_ts(day)))
        c0 = b["close"][i - 1]
        close = np.concatenate([[1.0], b["close"][i:i + T] / c0])[None, :]
        low = np.concatenate([[1.0], b["low"][i:i + T] / c0])[None, :]
        low = np.minimum(low, close)
        out[name] = {"close": close, "low": low}
    out["day_ts"] = np.array([FL.R4.day_ts(day)], dtype=np.int64)
    return out


def ladder(P, levels=(-0.05, -0.10, -0.15, -0.20, -0.30)):
    hf0 = LQ.hf_at(P, 1.0, 1.0)
    rows = []
    for k in levels:
        both = LQ.hf_at(P, 1.0 + k, 1.0 + k)
        eth = LQ.hf_at(P, 1.0 + k, 1.0)
        rows.append({"move": k, "usdc_debt_entering_liq_eth_and_btc_usd": float(P["DU"][(both < 1) & (hf0 >= 1)].sum()),
                     "accounts_eth_and_btc": int(((both < 1) & (hf0 >= 1)).sum()),
                     "usdc_debt_entering_liq_eth_only_usd": float(P["DU"][(eth < 1) & (hf0 >= 1)].sum())})
    return {"already_below_1_usdc_debt_usd": float(P["DU"][hf0 < 1].sum()), "rows": rows}


def cq6_core(datasets, day):
    p = os.path.join(datasets, "forecasts/q26-deposit-live/issues", f"{day}.json")
    if not os.path.exists(p):
        return None
    iss = json.load(open(p))
    seg_names = {"w1": "wallet $1-10M", "w2": "wallet $10-50M", "w3": "wallet >= $50M",
                 "c1": "contract $1-10M", "c2": "contract $10-50M", "c3": "contract >= $50M"}
    agg = {}
    with gzip.open(os.path.join(os.path.dirname(p), iss["csvFile"]), "rt") as f:
        for r in csv.DictReader(f):
            r.pop("address", None)                     # never kept
            if r["reserve"] != "USDC" or r["status"] != "ok":
                continue
            s = agg.setdefault(r["segment"], {"holders": 0, "balance_usd": 0.0, "p": {}, "labels": {}})
            s["holders"] += 1
            s["balance_usd"] += int(r["balance_raw"]) / 1e6
            for x in (10, 25, 50):
                for h in ("24h", "48h"):
                    key = f"x{x}_{h}"
                    s["p"].setdefault(key, []).append(float(r[f"{key}_disp4"]))
                    lab = r[f"{key}_label4"]
                    s["labels"].setdefault(key, {}).setdefault(lab, 0)
                    s["labels"][key][lab] += 1
    seg = []
    for k in ("w1", "w2", "w3", "c1", "c2", "c3"):
        if k not in agg:
            continue
        s = agg[k]
        seg.append({"segment": seg_names[k], "holders": s["holders"], "balance_usd": s["balance_usd"],
                    "mean_exit_odds": {kk: float(np.mean(v)) for kk, v in s["p"].items()},
                    "labels": s["labels"], "region": "B4 validated" if k in ("w1", "w2") else "no blind confirmation"})
    sr = iss["stressR72"]
    return {"issue": f"forecasts/q26-deposit-live/issues/{day}.json", "issue_asof": iss["asofHourIso"],
            "segments": seg, "cash_usd": sr["cashUSD"], "supply_usd": sr["supplyUSD"],
            "top10": [{k: v for k, v in x.items() if k in ("rank", "balanceUSD", "isContract", "shareOfSupply")}
                      for x in sr["topHolders"]],
            "runoff": [{k: v for k, v in x.items() if k in ("scenario", "withdrawalUSD", "shortfallUSD",
                                                             "hoursUntilCashNonNegative", "reachedBy72h",
                                                             "nContracts")} for x in sr["scenarios"]]}


def cq7_touch(datasets, day, paths_by_h):
    p = os.path.join(datasets, "forecasts/q26-touch-live/issues", f"{day}.json")
    iss = json.load(open(p))
    disp = iss["displayed"]
    rows = []
    for r in iss["rows"]:
        if r["asset"] not in ("ETH", "BTC") or r["T"] not in ("1d", "3d"):
            continue
        k = r["k"]
        if k not in (-0.05, -0.1, -0.15, -0.2, -0.3):
            continue
        rung = disp[r["asset"]][r["T"]]
        reg = "displayed" if k >= -0.10 else ("deep15" if k == -0.15 else ("deep20" if k == -0.2 else "outside"))
        P_ = paths_by_h.get(r["T"])
        path_freq = None
        if P_ is not None:
            low = P_[r["asset"].lower()]["low"]
            path_freq = float((low.min(axis=1) <= 1.0 + k).mean())
        rows.append({"asset": r["asset"], "horizon": r["T"], "level": k, "rung": rung, "p": r["p"][rung],
                     "region": reg, "path_set_touch_frequency_check": path_freq})
    return {"issue": f"forecasts/q26-touch-live/issues/{day}.json", "asof": iss["asofIso"], "rows": rows}


def hf_stats(P):
    ok = np.isfinite(P["hf_chain"]) & (P["hf_chain"] > 0) & (P["hf_chain"] < 1e6) & np.isfinite(P["hf_model"])
    rel = np.abs(P["hf_model"][ok] / P["hf_chain"][ok] - 1.0)
    return {"median_rel_diff": float(np.median(rel)), "share_within_1pct": float((rel < 0.01).mean()),
            "n_compared": int(ok.sum())}


def _base_id(o):
    if o.get("class_id"):
        return o["class_id"], o.get("tail")
    oid, h = o["id"], o.get("horizon")
    base = oid[:-(len(h) + 1)] if h and oid.endswith("." + h) else oid
    tail = "q99" if ".q99" in base else ("q95" if (".q95" in base or base == "CQ5.move") else None)
    return base, tail


def reclass(full: dict, table: dict) -> dict:
    """Re-apply the current labels table to an all-class report (classes, labels, evidence, wording) and floor
    displayed cash quantiles at 0; path quantities are copied, never recomputed."""
    out = json.loads(json.dumps(full))
    checks = {"curvecheck_arb": bool(out["checks"]["curvecheck_arb"]["pass"])}
    for qq in out["questions"]:
        for o in qq["outputs"]:
            base, tail = _base_id(o)
            oc = CL.output_class(table, base, checks)
            o.update({"class": oc["class"], "kind": oc["kind"], "labels": oc["labels"], "evidence": oc["evidence"],
                      "wording": CL.wording(oc["class"], tail), "class_id": base, "tail": tail})
            v = o.get("value")
            if base.startswith("CQ2.min_cash_24h") and isinstance(v, dict) and v.get("ok"):
                raw = {k: v[k] for k in ("q05_usd", "q25_usd", "q50_usd")}
                for k in raw:
                    v[k] = max(0.0, raw[k])
                v.pop("display_floored_at_0_usd", None)
                v.pop("note", None)
                v["floored_at_0"] = True
                v["research_raw_model_values"] = {**raw, "note": "RESEARCH FIELD, NOT FOR DISPLAY: the frozen "
                                                  "model's unfloored quantiles; a negative value means the model's "
                                                  "minimum crosses zero (cash fully used)"}
    if PATH_POOL_LIMITATION not in out["limitations"]:
        out["limitations"].append(PATH_POOL_LIMITATION)
    out["class_rule"] = table.get("class_rule")
    out["reclassified"] = "classes and displayed cash floors re-applied from classes.json (values copied)"
    return out


def refilter(full: dict, flt) -> dict:
    """Re-apply a confidence filter to a full (all-class) report; values are copied, never recomputed."""
    out = json.loads(json.dumps(full))
    out["confidence_filter"] = list(flt)
    for qq in out["questions"]:
        allo = qq["outputs"] + qq["withheld"]
        if any("value" not in o for o in allo):
            raise SystemExit("STOP: refilter needs a report built with every class (P,X,N,S)")
        shown, held = CL.apply_filter(allo, flt)
        qq["outputs"], qq["withheld"] = shown, held
        qq["empty_note"] = None if shown else "no output at this confidence; widen the filter"
    out["refiltered_from"] = "the same run's all-class report (values identical)"
    return out


def per_market_summary(st, P, r1):
    us = st["usdc"]
    hf = hf_stats(P)
    return {"supply_usd": us["atoken_total_supply"] / 1e6, "cash_usd": us["cash_balance"] / 1e6,
            "debt_usd": us["vdebt_total_supply"] / 1e6, "utilisation": r1["u0"],
            "borrow_apr_curve": r1["bapr0"], "borrow_apr_stored": r1["stored_bapr0"],
            "supply_apr_curve": r1["sapr0"], "supply_apr_stored": r1["stored_sapr0"],
            "reserve_factor": us["rf_bps"] / 1e4, "deficit_usd": (us["deficit"] or 0) / 1e6,
            "accounts_with_usdc_debt": int(P["n"]), "usdc_debt_of_accounts_usd": float(P["DU"].sum()),
            "usdc_debt_with_eth_family_collateral_usd": float(P["DU"][P["VE"] > 0].sum()),
            "usdc_debt_with_btc_family_collateral_usd": float(P["DU"][P["VB"] > 0].sum()),
            "hf_model_vs_chain": hf,
            "already_underwater_usdc_usd": r1["baseline_underwater_usd"], "block": st["block"]}


# ---------------------------------------------------------------------------------------------
def build(a):
    t0 = int(dt.datetime.fromisoformat(a.t0.replace("Z", "+00:00")).timestamp())
    day = dt.datetime.fromtimestamp(t0, dt.timezone.utc).date().isoformat()
    rng = np.random.default_rng(a.seed)
    table = CL.load()
    flt = CL.parse_filter(a.confidence)
    st, pos, M, HB, bars, cc = load_world(a, t0)
    checks = {"curvecheck_arb": bool(cc["pass"])}
    alloc = dict(CFG.DEMO_VAULT["alloc_usd"])
    W = CFG.DEMO_VAULT["withdrawal_usd"]
    outputs = []

    def add(oid, horizon, metric, value, tail=None, extra=None, out_id=None):
        oc = CL.output_class(table, out_id or oid, checks)
        o = {"id": oid + (f".{horizon}" if horizon else ""), "horizon": horizon, "metric": metric,
             "class": oc["class"], "kind": oc["kind"], "labels": oc["labels"], "evidence": oc["evidence"],
             "wording": CL.wording(oc["class"], tail), "value": value, "decides": False,
             "class_id": out_id or oid, "tail": tail}
        if extra:
            o.update(extra)
        outputs.append(o)

    res_by_h, paths_by_h, vault_by_h = {}, {}, {}
    for hn, H in CFG.HORIZONS_H.items():
        ad = allowed_days(M, H, t0)
        pths = PA.make_paths(bars["eth"], bars["btc"], H, FL.R4.day_ts(CFG.JOINT_FIRST_DAY), t0, a.paths, rng,
                             allowed_days=ad)
        fl = flows_for(M, HB, pths["day_ts"], H)
        res = {mk: EN.run_market(st[mk], mk, pos[mk], pths, fl[mk]) for mk in CFG.MARKETS}
        res_by_h[hn], paths_by_h[hn] = res, {"eth": pths["eth"], "btc": pths["btc"], "n_windows": pths["n_windows"]}
        V = EN.vault_metrics(res, alloc, W)
        vault_by_h[hn] = V
        tot = sum(alloc.values())
        common = {"n_paths": a.paths, "n_historical_windows": pths["n_windows"]}
        # CQ1
        for tail, p in (("q95", 0.95), ("q99", 0.99)):
            tv = tail_value(V["bad_debt"], p, rng)
            add(f"CQ1.vault_bad_debt.{tail}", hn, "vault-share new USDC bad debt (USD)",
                {**tv, "pct_of_vault": tv["value"] / tot}, tail=tail, extra=common)
            tl = tail_value(V["liquidity_loss"], p, rng)
            add(f"CQ1.vault_liquidity_loss.{tail}", hn, "allocation unable to leave at the worst hour (USD)",
                {**tl, "pct_of_vault": tl["value"] / tot}, tail=tail, extra=common)
        add("CQ1.reserve_liq_volume.q95", hn, "USDC-debt liquidation volume per reserve (USD), path q95",
            {mk: tail_value(res[mk]["liq_volume"], 0.95, rng) for mk in res}, tail="q95", extra=common)
        # CQ2 scenario
        add("CQ2.lock_share", hn, "share of paths where reserve cash falls below the vault's withdrawal size",
            {mk: {"share": float(V["lock"][mk].mean()), "paths": int(V["lock"][mk].sum()),
                  "withdrawal_size_usd": min(alloc[mk], W)} for mk in res}, extra=common)
        add("CQ2.min_cash_scenario.q05", hn, "minimum reserve cash over the horizon (USD), path q05 and q50",
            {mk: {"q05": q(res[mk]["min_cash"], 0.05), "q50": q(res[mk]["min_cash"], 0.5),
                  "blocked_outflow_q95_usd": q(res[mk]["blocked"], 0.95)} for mk in res}, extra=common)
        # CQ3 scenario APR
        for mk in res:
            add(f"CQ3.scenario_apr.{mk}", hn, "borrow APR if this scenario: end-of-horizon q05/q50/q95; max-hour q95",
                {"borrow_end_q05": q(res[mk]["bapr_end"], 0.05), "borrow_end_q50": q(res[mk]["bapr_end"], 0.5),
                 "borrow_end_q95": q(res[mk]["bapr_end"], 0.95), "borrow_max_q95": q(res[mk]["bapr_max"], 0.95),
                 "supply_end_q50": q(res[mk]["sapr_end"], 0.5)}, extra=common, out_id=f"CQ3.scenario_apr.{mk}")
        # CQ4 tail drivers (expected-shortfall contribution on the top 5% paths by vault bad debt)
        top = np.argsort(-V["bad_debt"], kind="stable")[:max(1, int(0.05 * a.paths))]
        drv = {}
        for mk in res:
            share = alloc[mk] / res[mk]["S0"]
            fam = res[mk]["bd_fam_underwater"] + res[mk]["bd_fam_deficit"]
            drv[mk] = {"es_contribution_usd": float((share * res[mk]["bad_debt_new"][top]).mean()),
                       "by_dominant_collateral_usd": {f: float((share * fam[i][top]).mean())
                                                      for i, f in enumerate(("ETH-family", "BTC-family", "other"))}}
        add("CQ4.tail_drivers", hn, "mean contribution to vault bad debt on the worst 5% of paths (USD)", drv,
            extra={**common, "note": "family split by each account's dominant collateral at t0; the split is gross "
                                     "of the t0 underwater baseline"})
        # CQ5 moves Core -> Arbitrum, common random numbers
        mv = []
        for x in MOVES:
            al = {"core": alloc["core"] * (1 - x), "arb": alloc["arb"] + alloc["core"] * x}
            V2 = EN.vault_metrics(res, al, W)
            idx = rng.integers(0, a.paths, size=(200, a.paths))
            dbd = np.quantile(V2["bad_debt"][idx], 0.95, axis=1) - np.quantile(V["bad_debt"][idx], 0.95, axis=1)
            dll = np.quantile(V2["liquidity_loss"][idx], 0.95, axis=1) - np.quantile(V["liquidity_loss"][idx], 0.95, axis=1)
            mv.append({"move_core_to_arb": x,
                       "d_bad_debt_q95_usd": q(V2["bad_debt"], 0.95) - q(V["bad_debt"], 0.95),
                       "d_bad_debt_q95_interval": [float(np.percentile(dbd, 5)), float(np.percentile(dbd, 95))],
                       "d_liquidity_loss_q95_usd": q(V2["liquidity_loss"], 0.95) - q(V["liquidity_loss"], 0.95),
                       "d_liquidity_loss_q95_interval": [float(np.percentile(dll, 5)), float(np.percentile(dll, 95))]})
        add("CQ5.move", hn, "paired q95 differences after moving X% of the Core allocation to Arbitrum", mv,
            tail="q95", extra={**common, "interval": "path bootstrap 5-95% (simulation error, not model uncertainty)"})
    # CQ2 P outputs: 24 h minimum cash (frozen R11.11-M1)
    for mk in CFG.MARKETS:
        add(f"CQ2.min_cash_24h.{mk}", "24h", "24 h minimum pool cash quantiles q05/q25/q50 (USD)", C24.forecast(M[mk]))
    # CQ3 bands (external owners) and the current curve APR
    add("CQ3.apr_band_7d.core", "7d", "7 d borrow APR band (q05-q95)", None,
        extra={"withheld_reason": table["outputs"]["CQ3.apr_band_7d.core"]["withheld_reason"]})
    add("CQ3.apr_band_7d.arb", "7d", "7 d borrow APR band (q05-q95)", None,
        extra={"withheld_reason": table["outputs"]["CQ3.apr_band_7d.arb"]["withheld_reason"]})
    r1 = res_by_h["1d"]
    for mk in CFG.MARKETS:
        add(f"CQ3.apr_now.{mk}", None, "borrow and supply APR at t0 by the exact curve (stored rate beside)",
            {"borrow_apr": r1[mk]["bapr0"], "supply_apr": r1[mk]["sapr0"], "stored_borrow_apr": r1[mk]["stored_bapr0"],
             "stored_supply_apr": r1[mk]["stored_sapr0"], "utilisation": r1[mk]["u0"]})
    # CQ6 (Core only; Arbitrum has no holder census and no B4 pass)
    c6 = cq6_core(a.datasets, day)
    if c6:
        add("CQ6.b4_exit_odds.core_lt50m", None, "B4 per-deposit exit odds, segment means (x% drop of a deposit)",
            [s for s in c6["segments"] if s["region"] == "B4 validated"], extra={"source": c6["issue"],
                                                                                "asof": c6["issue_asof"]})
        add("CQ6.big_holders.core", None, "segments without blind confirmation (balances only, no odds)",
            [{k: s[k] for k in ("segment", "holders", "balance_usd")} for s in c6["segments"]
             if s["region"] != "B4 validated"], extra={"source": c6["issue"]})
        add("CQ6.runoff.core", None, "R7.2 run-off totals vs cash (S2, S5, S10, class run-off)", c6["runoff"],
            extra={"source": c6["issue"], "cash_usd": c6["cash_usd"]})
        add("CQ6.top10.core", None, "ranked top-10 balances (no addresses), expandable", c6["top10"],
            extra={"source": c6["issue"]})
    # CQ7 touch odds (live A6 issue) and the liquidation ladder
    t7 = cq7_touch(a.datasets, day, {k: v for k, v in paths_by_h.items()})
    for reg, oid in (("displayed", "CQ7.touch.displayed"), ("deep15", "CQ7.touch.deep15"),
                     ("deep20", "CQ7.touch.deep20"), ("outside", "CQ7.touch.outside")):
        rows = [r for r in t7["rows"] if r["region"] == reg]
        add(oid, None, "touch odds P(min price over the horizon <= level), live A6 displayed rung", rows,
            extra={"source": t7["issue"], "asof": t7["asof"],
                   "check_note": "path_set_touch_frequency_check is this report's (fH) path set (joint-day pool); "
                                 "reported only"})
    add("CQ7.ladder", None, "USDC debt entering liquidation under a common ETH/BTC move (measured from t0 positions)",
        {mk: ladder(pos[mk]) for mk in CFG.MARKETS})
    # CQ8 stress lines (realised windows replayed from today's positions)
    lines = []
    for key, (d0, name) in STRESS.items():
        rp = realised_paths(bars, d0, 72)
        fl = flows_for(M, HB, rp["day_ts"], 72)
        rs = {mk: EN.run_market(st[mk], mk, pos[mk], rp, fl[mk]) for mk in CFG.MARKETS}
        Vs = EN.vault_metrics(rs, alloc, W)
        lines.append({"line": key, "name": name, "window_start": d0, "horizon": "3d",
                      "eth_min_move": float(rp["eth"]["low"].min() - 1), "btc_min_move": float(rp["btc"]["low"].min() - 1),
                      "vault_bad_debt_usd": float(Vs["bad_debt"][0]), "vault_liquidity_loss_usd": float(Vs["liquidity_loss"][0]),
                      "markets": {mk: {"liq_volume_usd": float(rs[mk]["liq_volume"][0]),
                                       "new_bad_debt_usd": float(rs[mk]["bad_debt_new"][0]),
                                       "min_cash_usd": float(rs[mk]["min_cash"][0]),
                                       "util_max": float(rs[mk]["util_max"][0]),
                                       "borrow_apr_max": float(rs[mk]["bapr_max"][0])} for mk in rs}})
    add("CQ8.stress", "3d", "named crisis replayed from today's positions and allocations", lines)
    # filter and assemble
    shown, held = CL.apply_filter(outputs, flt)
    qs = []
    for cq, w in WORDING.items():
        so = [o for o in shown if o["id"].startswith(cq + ".")]
        ho = [o for o in held if o["id"].startswith(cq + ".")]
        qs.append({"id": cq, "wording": w, "outputs": so, "withheld": ho,
                   "empty_note": None if so else "no output at this confidence; widen the filter"})
    mk_sum = {mk: per_market_summary(st[mk], pos[mk], r1[mk]) for mk in CFG.MARKETS}
    for mk in CFG.MARKETS:
        mk_sum[mk]["label"] = CFG.MARKETS[mk]["label"]
        mk_sum[mk]["liquidation_candidates"] = {hn: res_by_h[hn][mk]["n_candidates"] for hn in res_by_h}
        mk_sum[mk]["g1_cash_anchor_mismatches"] = M[mk]["g1_mismatches"]
    report = {
        "schema": SCHEMA, "research_only": True, "decides": False,
        "what": "Q26 curator simulator slice 1: preset scenario report for a demo USDC vault over Aave V3 Core USDC "
                "and Arbitrum native USDC (research build; nothing is displayed in the app without owner approval)",
        "design": CFG.DESIGN, "t0": a.t0, "generated_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "code": git_meta(), "seed": a.seed, "paths": a.paths,
        "owner_decisions_2026_10_18": {
            "a": "q95 (1-in-20) is the primary tail; q99 (1-in-100) is scenario-only unless validated",
            "b": "confidence filter over P > X > N > S; default {P}; outputs outside the filter are withheld by id",
            "c": "blind-test-only markets may show numbers with a BLIND TEST label (inventory rule 5 superseded for "
                 "labelled simulator outputs)",
            "d": "slice 1 is a research build"},
        "confidence_filter": list(flt), "filter_steps": [list(s) for s in CL.WIDEN_STEPS],
        "vault": {**CFG.DEMO_VAULT, "fixture": True},
        "markets": mk_sum,
        "checks": {"curvecheck_arb": {k: cc[k] for k in ("samples", "worst_vrate_diff_bp", "worst_lrate_diff_bp",
                                                         "tolerance_bp", "pass", "rule")},
                   "paths": {hn: {"n_windows": paths_by_h[hn]["n_windows"],
                                  "eth_sigma_H_now": paths_by_h[hn]["eth"]["sigma_now"],
                                  "btc_sigma_H_now": paths_by_h[hn]["btc"]["sigma_now"]} for hn in paths_by_h}},
        "questions": qs,
        "limitations": [
            "Every coupled output is class S: the liquidation gate (L1) is unscored and no coupling has a "
            "preregistered test on real outcomes. No validation back-replay ran (it needs its own preregistration).",
            "Collateral families move with their base feed (rate oracles); LST/LRT depegs and exploits are stress "
            "lines only. Other collateral and other debt are held constant.",
            "Liquidators repay the largest debt bucket and seize the largest eligible collateral bucket (R10.1 "
            "rule); DEX shortfall uses Uniswap v3 depth only (no aggregators), so profitability is conservative.",
            "Arbitrum flow blocks keep their own historical liquidation repayments (the L1 target is not read); "
            "Core's are removed (double-count guard).",
            "Debt flows come from daily anchors spread evenly over 24 hours; borrows are not blocked when cash is 0.",
            "Path pool: 00:00Z historical windows from 2023-07 (both reserves' flow history), resampled; q99 rests on "
            "about 1% of windows.",
            "Bad debt is the reserve's new USDC bad debt (deficits plus underwater debt at the horizon close, net of "
            "the t0 underwater baseline), shared pro rata by the vault's allocation.",
            "CQ3 bands are owned by Q33 (C3 on Core) and are class N off Core (M2); not computed in slice 1.",
            "CQ6 covers Core USDC only (the live deposit log); Arbitrum has no holder census or B4 pass.",
            PATH_POOL_LIMITATION,
        ],
    }
    text = json.dumps(report, sort_keys=True, default=float)
    if ADDR_RE.search(text):
        raise SystemExit("STOP: an address-like string reached the report")
    return report, text


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["run", "refilter", "reclass"])
    ap.add_argument("--work")
    ap.add_argument("--datasets")
    ap.add_argument("--full", help="refilter: the all-class report")
    ap.add_argument("--t0", default="2026-10-18T00:00:00Z")
    ap.add_argument("--out", required=True)
    ap.add_argument("--paths", type=int, default=CFG.PATHS)
    ap.add_argument("--seed", type=int, default=CFG.SEED)
    ap.add_argument("--confidence", default="P")
    a = ap.parse_args(argv)
    if a.cmd == "reclass":
        rep = reclass(json.load(open(a.full)), CL.load())
        text = json.dumps(rep, sort_keys=True)
        if ADDR_RE.search(text):
            raise SystemExit("STOP: an address-like string reached the report")
        with open(a.out, "w") as f:
            f.write(json.dumps(rep, indent=1, sort_keys=True))
        print(f"wrote {a.out} (reclassified)")
        return
    if a.cmd == "refilter":
        full = json.load(open(a.full))
        if a.work:      # recompute the HF agreement statistic only (no path quantity changes)
            t0 = int(dt.datetime.fromisoformat(a.t0.replace("Z", "+00:00")).timestamp())
            for mk in CFG.MARKETS:
                P = LQ.positions(jload(os.path.join(a.work, mk, f"state-{t0}.json.gz")), mk)
                full["markets"][mk]["hf_model_vs_chain"] = hf_stats(P)
        rep = refilter(full, CL.parse_filter(a.confidence))
        text = json.dumps(rep, sort_keys=True)
        if ADDR_RE.search(text):
            raise SystemExit("STOP: an address-like string reached the report")
        with open(a.out, "w") as f:
            f.write(json.dumps(rep, indent=1, sort_keys=True))
        print(f"wrote {a.out} (filter {rep['confidence_filter']})")
        return
    report, text = build(a)
    with open(a.out, "w") as f:
        f.write(json.dumps(json.loads(text), indent=1, sort_keys=True))
    print(f"wrote {a.out}: {sum(len(q['outputs']) for q in report['questions'])} outputs shown, "
          f"{sum(len(q['withheld']) for q in report['questions'])} withheld (filter {report['confidence_filter']})")


if __name__ == "__main__":
    main()
