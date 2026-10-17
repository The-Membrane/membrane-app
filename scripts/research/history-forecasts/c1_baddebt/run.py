"""C1 (Q26 R8.5) thin curator bad-debt simulator, screening version: simulate, validate, spot-check, publish.

  python3 -m c1_baddebt.run simulate --raw RAW --out OUT --name live    --target issue:<path to touch issue>
  python3 -m c1_baddebt.run simulate --raw RAW --out OUT --name oct2025 --target a6dev:2025-10-10T00:00:00Z --window-h 48
  python3 -m c1_baddebt.run spotcheck --raw RAW --fixture c1_baddebt/fixtures/liquidations.json
  python3 -m c1_baddebt.run publish --out OUT

Prereg: membrane-board design/Q26_ROUND8_PREREG.md R8.5 (commit 91a3eba).
"""
from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import json
import os
import subprocess
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
from c1_baddebt import chain as C  # noqa: E402
from c1_baddebt import depth as DP  # noqa: E402
from c1_baddebt import liq as LQ  # noqa: E402
from c1_baddebt import paths as PA  # noqa: E402
from c1_baddebt import sim as S  # noqa: E402
from c1_baddebt.acquire import DATASETS, jdump, jload  # noqa: E402

PREREG = {"repo": "triccs/membrane-board", "path": "design/Q26_ROUND8_PREREG.md", "section": "R8.5",
          "commit": "91a3eba"}
N_PATHS = 10_000
SEED = 20261085
A6_DEV = "history-forecasts/a6/run-015512cb/predictions-dev-ETH.csv.gz"
TOUCH_LEVELS_COND = (-0.10, -0.20, -0.30)
DUST_USD = 1.0   # per-path totals below $1 are float residue and count as 0 (C1-D7)
DECIMALS = {C.USDC: 6, **{a: 18 for a in C.ETH_ASSETS.values()}}

DECISIONS = [
    "C1-D1 positions: the user universe is every onBehalfOf of a Core USDC Borrow event up to the anchor block "
    "(committed aave-pool-borrows / aave-pool-debt files plus a getLogs tail); each account's state is read by "
    "archive eth_call at the anchor block (getUserAccountData, getUserEMode, getUserConfiguration, aToken and "
    "variable-debt balanceOf) instead of replaying Supply/Withdraw/transfer events, which is exact where an "
    "event replay is not (interest, aToken transfers, liquidations).",
    "C1-D2 paths: with 7-day blocks and horizons <= 7 days each path is one contiguous historical 168-hour block of "
    "the ETH hourly series (close and low multipliers relative to the block's first close), drawn uniformly from "
    "blocks ending at or before the anchor hour; seed 20261085; 10,000 paths. LST collateral moves 1:1 with ETH "
    "(Aave prices them as exchange rate x ETH/USD; no depeg overlay).",
    "C1-D3 reweighting: nested-bin weights so the weighted P(7-day path low <= S(1+k)) equals the target at every A6 "
    "level k in -2..-40 %; live target = the latest q26-touch-live issue's ETH 7d p_displayed (rung fbL); replay "
    "targets = the A6 development (out-of-fold) prediction of the displayed 7d rung fbL at the replay anchor "
    "(no live issue exists then; the y column is not read). An empty bin passes its mass to the next shallower bin. "
    "24 h outputs use the same weights.",
    "C1-D4 depth: Uniswap v3 pool state at the anchor block (slot0, liquidity, initialized ticks within +-9200 ticks), "
    "aggregated across the WETH/USDC 0.01/0.05/0.3 % pools and per LST across its LST/WETH 0.01/0.05 % pools, at a "
    "common relative price drop; shortfall held in sold-token units and re-centred on the price each hour; cumulative "
    "sold volume per pool resets each hour. Curve and Balancer depth and CEX hedging are not counted (conservative "
    "for liquidator profit).",
    "C1-D5 non-subject legs: other collateral and other debt are held at their anchor USD value; liquidators act on "
    "the USDC-debt / ETH-collateral pair only; ETH-family debt moves with ETH; interest is not accrued.",
    "C1-D6 liquidator: acts at the hour low then the hour close, in anchor-HF order, up to 6 calls per account per "
    "sub-step, repay chosen among {0.1,0.25,0.5,0.75,1} x max-liquidatable to maximise bonus - slippage - gas, gas = "
    "0.01 ETH per call; collateral reserve = the first held ETH asset by anchor value.",
    "C1-D7 bad debt = deficits burned when an account is left with no collateral + max(0, debt - collateral) of every "
    "other subject account at the horizon close (booked once per path); bad debt already open at the anchor is "
    "reported beside it. Liquidation volume = USDC debt repaid (USD) on the subject pair.",
    "C1-D8 validation: realized volume = LiquidationCall with USDC debt and ETH-family collateral of anchor-subject "
    "accounts in (anchor block, window-end block]; realized bad debt = DeficitCreated of those accounts in the window "
    "(USD at the end-block oracle / daily oracle price) + max(0, totalDebtBase - totalCollateralBase) of those "
    "accounts at the window end. Windows: 2025-10-10T00Z + 48 h and 2026-04-18T00Z + 72 h. The band is the weighted "
    "5th-95th percentile of simulated volume over the window length.",
]


def git_info() -> dict:
    def g(*a):
        return subprocess.run(["git", *a], cwd=HERE, capture_output=True, text=True).stdout.strip()
    return {"commit": g("rev-parse", "HEAD"), "dirty": [x for x in g("status", "--porcelain", ".").splitlines()]}


def load_targets(spec: str) -> dict:
    kind, val = spec.split(":", 1)
    if kind == "issue":
        d = json.load(open(val))
        rows = [r for r in d["rows"] if r["asset"] == "ETH" and r["T"] == "7d"]
        lv = [r["k"] for r in rows]
        tg = [r["p_displayed"] for r in rows]
        return {"levels": lv, "targets": tg, "source": os.path.relpath(val, DATASETS), "asof": d["asofIso"],
                "rung": rows[0]["displayed"], "sha256": sha256(val)}
    if kind == "a6dev":
        lv, tg = [], []
        with gzip.open(os.path.join(DATASETS, A6_DEV), "rt") as f:
            for row in csv.DictReader(f):
                if row["t0"] == val and row["T"] == "7d":
                    lv.append(float(row["k"]))
                    tg.append(float(row["p_fbL"]))
        if len(lv) != 10:
            raise SystemExit(f"A6 dev rows for {val}: {len(lv)}")
        return {"levels": lv, "targets": tg, "source": A6_DEV, "asof": val, "rung": "fbL",
                "sha256": sha256(os.path.join(DATASETS, A6_DEV))}
    raise SystemExit(f"bad target {spec}")


def sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def build_curves(snap: dict) -> dict:
    u = snap["uni"]
    weth = C.ETH_ASSETS["WETH"]
    curves = {"ETH": DP.Curve([u[k] for k in u if k.startswith("WETH-USDC")], weth, DECIMALS)}
    for n in ("wstETH", "weETH", "rsETH"):
        curves[n] = DP.Curve([u[k] for k in u if k.startswith(n + "-WETH")], C.ETH_ASSETS[n], DECIMALS)
    return curves


def summarize(res: dict, w: np.ndarray, pmin: dict) -> dict:
    out = {}
    for lab, r in res.items():
        d = {}
        for key in ("bad_debt", "volume", "seized", "deficit"):
            x = np.where(r[key] < DUST_USD, 0.0, r[key])
            d[key] = {"p05": PA.wquantile(x, w, 0.05), "p50": PA.wquantile(x, w, 0.50),
                      "p95": PA.wquantile(x, w, 0.95), "p99": PA.wquantile(x, w, 0.99),
                      "mean": float(np.sum(w * x)), "unweighted_p95": float(np.quantile(x, 0.95)),
                      "unweighted_p99": float(np.quantile(x, 0.99)), "p_positive": float(np.sum(w * (x > 0)))}
        cond = {}
        for k in TOUCH_LEVELS_COND:
            sel = pmin[lab] <= 1 + k
            ws = w[sel].sum()
            cond[f"{int(round(k * 100))}%"] = {
                "p_touch": float(ws), "n_paths": int(sel.sum()),
                "E_bad_debt": float(np.sum(w[sel] * r["bad_debt"][sel]) / ws) if ws > 0 else None,
                "E_volume": float(np.sum(w[sel] * r["volume"][sel]) / ws) if ws > 0 else None}
        d["touch_conditional"] = cond
        out[lab] = d
    return out


def realized(raw: str, name: str, snap: dict, positions: list[dict]) -> dict:
    end = jload(os.path.join(raw, f"end-{name}.json.gz"))
    logs = jload(os.path.join(raw, "logs.json.gz"))
    subj = {p["addr"] for p in positions}
    eth = set(C.ETH_ASSETS.values())
    b0, b1 = snap["block"], end["block"]
    usdc_p = end["reserves"]["USDC"]["price"] / 1e8
    vol_s = vol_all_eth = vol_all = 0.0
    n_s = 0
    by_asset = {}
    for e in logs["liquidations"]:
        if not (b0 < e["block"] <= b1):
            continue
        v = e["debtToCover"] / 1e6 * usdc_p
        vol_all += v
        if e["collateral"] in eth:
            vol_all_eth += v
            if e["user"] in subj:
                vol_s += v
                n_s += 1
                a = C.ASSET_BY_ADDR[e["collateral"]]
                by_asset[a] = by_asset.get(a, 0.0) + v
    prices = daily_prices(end["ts"])
    for n, r in end["reserves"].items():
        prices[r["asset"]] = (r["price"] / 1e8, 10**r["decimals"])
    dfc = 0.0
    dfc_all = 0.0
    missing = []
    for e in logs["deficits"]:
        if not (b0 < e["block"] <= b1):
            continue
        if e["debt"] not in prices:
            missing.append(e["debt"])
            continue
        p, unit = prices[e["debt"]]
        v = e["amount"] / unit * p
        dfc_all += v
        if e["user"] in subj:
            dfc += v
    under_end = sum(max(a["totalDebtBase"] - a["totalCollateralBase"], 0) for u, a in end["accounts"].items()
                    if u in subj) / 1e8
    return {"anchor_block": b0, "end_block": b1, "end_ts": end["ts"], "volume_subject": vol_s,
            "n_liquidations_subject": n_s, "volume_subject_by_collateral": by_asset,
            "volume_eth_collateral_all_users": vol_all_eth, "volume_usdc_debt_all": vol_all,
            "deficits_subject": dfc, "deficits_all_users": dfc_all, "deficit_assets_unpriced": missing,
            "underwater_end_subject": under_end, "bad_debt_subject": dfc + under_end}


def daily_prices(ts: int) -> dict:
    """Aave oracle daily prices (aave-pool-debt) on the last snapshot at or before ts: {asset: (usd, unit)}."""
    import datetime as dt
    day = dt.datetime.fromtimestamp(ts, dt.timezone.utc).date().isoformat()
    dec = {}
    with open(os.path.join(DATASETS, "aave-pool-debt/asset-decimals.csv")) as f:
        for row in csv.DictReader(f):
            dec[row[list(row)[0]].lower()] = int(row[list(row)[-1]])
    best = {}
    with gzip.open(os.path.join(DATASETS, "aave-pool-debt/prices-daily.csv.gz"), "rt") as f:
        for row in csv.DictReader(f):
            if row["snapshot"] <= day and row["price_usd_1e8"]:
                best[row["asset"].lower()] = int(row["price_usd_1e8"]) / 1e8
    return {a: (p, 10**dec.get(a, 18)) for a, p in best.items()}


def simulate(raw: str, out: str, name: str, target: str, window_h: int | None, n_paths: int = N_PATHS) -> dict:
    t_start = time.time()
    snap = jload(os.path.join(raw, f"anchor-{name}.json.gz"))
    positions, skipped = S.positions_from_snapshot(snap)
    curves = build_curves(snap)
    hist = PA.load_eth_hourly(DATASETS, until_ts=snap["anchor_ts"] - 3600)
    rng = np.random.default_rng(SEED)
    bs = PA.bootstrap(hist["close"], hist["low"], n_paths, rng)
    tg = load_targets(target)
    pm7 = PA.touch_min(bs["low"], 168)
    w, rw = PA.reweight(pm7, tg["levels"], tg["targets"])
    phi = DP.depth_factor(bs["close"])
    horizons = {"24h": 24, "7d": 168}
    if window_h:
        horizons = {f"{window_h}h": window_h, **horizons}
    eth_p = snap["reserves"]["WETH"]["price"] / 1e8
    usdc_p = snap["reserves"]["USDC"]["price"] / 1e8
    res = S.run_horizons(positions, bs["close"], bs["low"], phi, curves, eth_p, usdc_p, horizons)
    pmin = {lab: PA.touch_min(bs["low"], h) for lab, h in horizons.items()}
    summ = summarize(res, w, pmin)
    hf = np.array([p["hf_model"] for p in positions])
    hfc = np.array([p["hf_chain"] for p in positions])
    debt_u = np.array([p["du"] for p in positions])
    coll_eth = np.array([sum(c["units"] * c["price"] for c in p["coll"]) for p in positions])
    ladder = []
    for k in (-0.05, -0.10, -0.15, -0.20, -0.30, -0.40, -0.50):
        sel = np.array([p["m_liq"] for p in positions]) >= 1 + k
        ladder.append({"drop": k, "accounts_liquidatable": int(sel.sum()), "usdc_debt_liquidatable": float(debt_u[sel].sum())})
    doc = {
        "schema": "c1-baddebt/result/1", "prereg": PREREG, "name": name, "code": git_info(),
        "anchor": {"block": snap["block"], "ts": snap["ts"], "anchor_ts": snap["anchor_ts"], "eth_price": eth_p,
                   "usdc_price": usdc_p, "reserves": {k: {kk: v[kk] for kk in ("price", "lt", "lb", "protocol_fee", "frozen")}
                                                      for k, v in snap["reserves"].items()}},
        "subject": {"n_accounts": len(positions), "n_usdc_borrowers_ever": snap["n_borrowers_ever"],
                    "n_with_usdc_debt": len(snap["accounts"]), "skipped": skipped,
                    "usdc_debt_usd": float(debt_u.sum()), "eth_collateral_usd": float(coll_eth.sum()),
                    "hf_model_vs_chain_max_abs_rel": float(np.max(np.abs(hf[np.isfinite(hfc) & (hfc < 1e6)] /
                                                                         hfc[np.isfinite(hfc) & (hfc < 1e6)] - 1))),
                    "accounts_hf_below_1": int((hf < 1).sum()), "accounts_hf_below_1_1": int((hf < 1.1).sum()),
                    "anchor_underwater_usd": S.anchor_underwater(positions), "liquidation_ladder": ladder},
        "paths": {"n": n_paths, "seed": SEED, "block_h": 168, "history_hours": int(len(hist["close"])),
                  "history_end_ts": int(hist["ts"][-1]), "targets": tg, "reweight": rw,
                  "impaired_share_by_h": {lab: float(np.sum(w * (phi[:, 1:h + 1].min(axis=1) < 1)))
                                          for lab, h in horizons.items()}},
        "depth": {k: {"mid": v.mid, "q_max_at_60pct": v.q_max,
                      "table": v.table([10, 100, 500, 1000, 5000, 10000, 50000])} for k, v in curves.items()},
        "results": summ, "decisions": DECISIONS, "seconds": round(time.time() - t_start, 1)}
    if window_h:
        rz = realized(raw, name, snap, positions)
        lab = f"{window_h}h"
        band = (summ[lab]["volume"]["p05"], summ[lab]["volume"]["p95"])
        doc["validation"] = {
            "window_h": window_h, "realized": rz,
            "simulated_volume_band_p05_p95": band,
            "simulated_volume_unweighted_p05_p95": (float(np.quantile(res[lab]["volume"], 0.05)),
                                                    float(np.quantile(res[lab]["volume"], 0.95))),
            "realized_volume_in_band": bool(band[0] <= rz["volume_subject"] <= band[1]),
            "realized_volume_weighted_quantile": float(np.sum(w * (res[lab]["volume"] <= rz["volume_subject"]))),
            "simulated_bad_debt": summ[lab]["bad_debt"],
            "realized_bad_debt_weighted_quantile": float(np.sum(w * (res[lab]["bad_debt"] <= rz["bad_debt_subject"]))),
            "realized_eth_path": realized_path(hist_full_until(snap["anchor_ts"] + window_h * 3600), snap["anchor_ts"], window_h)}
        # diagnostic (reported, deciding nothing): simulated volume among paths at least as deep as realized
        rp = doc["validation"]["realized_eth_path"]["min_low_mult"]
        deep = pmin[lab] <= rp
        if deep.sum() >= 5:
            wd = w[deep] / w[deep].sum()
            v = res[lab]["volume"][deep]
            bd = res[lab]["bad_debt"][deep]
            doc["validation"]["conditional_on_realized_depth"] = {
                "n_paths": int(deep.sum()), "weight": float(w[deep].sum()),
                "volume_p05_p50_p95": [PA.wquantile(v, wd, q) for q in (0.05, 0.5, 0.95)],
                "realized_volume_quantile": float(np.sum(wd * (v <= rz["volume_subject"]))),
                "bad_debt_p05_p50_p95": [PA.wquantile(bd, wd, q) for q in (0.05, 0.5, 0.95)]}
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, f"result-{name}.json"), "w") as f:
        json.dump(doc, f, indent=1, sort_keys=True, default=float)
    # per-path series for reproduction (compact)
    np.savez_compressed(os.path.join(out, f"paths-{name}.npz"), weights=w, starts=bs["starts"],
                        **{f"{k}_{lab}": res[lab][k] for lab in res for k in ("volume", "bad_debt", "seized", "deficit")})
    return doc


def hist_full_until(ts: int) -> dict:
    return PA.load_eth_hourly(DATASETS, until_ts=ts)


def realized_path(h: dict, anchor_ts: int, window_h: int) -> dict:
    i0 = int(np.searchsorted(h["ts"], anchor_ts - 3600))
    c0 = h["close"][i0]
    seg_l = h["low"][i0 + 1:i0 + 1 + window_h]
    seg_c = h["close"][i0 + 1:i0 + 1 + window_h]
    return {"start_close": float(c0), "min_low_mult": float(seg_l.min() / c0) if len(seg_l) else None,
            "end_close_mult": float(seg_c[-1] / c0) if len(seg_c) else None, "hours": int(len(seg_c))}


# ---------------------------------------------------------------------------------------------
# Spot check of the liquidation math against real LiquidationCall events
# ---------------------------------------------------------------------------------------------

def spotcheck(raw: str, fixture: str, n_want: int = 5) -> list[dict]:
    """For ETH-family collateral / USDC debt LiquidationCalls after v3.3 (block >= 22,000,000), read the
    collateral reserve config, e-mode, oracle prices at the event block and the user's collateral balance at
    block - 1; recompute the collateral to the liquidator from the event's debt repaid. One event per asset
    first (newest first), then the next newest; every attempt is recorded."""
    logs = jload(os.path.join(raw, "logs.json.gz"))
    eth = {v: k for k, v in C.ETH_ASSETS.items()}
    evs = [e for e in logs["liquidations"] if e["collateral"] in eth and e["block"] >= 22_000_000]
    evs.sort(key=lambda e: -e["block"])
    eras = [(22_000_000, 24_247_927), (24_247_927, LQ.DIRECTIONAL_ROUNDING_FROM_BLOCK),
            (LQ.DIRECTIONAL_ROUNDING_FROM_BLOCK, 10**9)]
    picked, seen = [], set()
    for lo, hi in eras:          # newest event per (era, collateral asset)
        for e in evs:
            key = (lo, eth[e["collateral"]])
            if lo <= e["block"] < hi and key not in seen:
                picked.append(e)
                seen.add(key)
    picked = picked[:n_want + 7]
    rpc = C.make_rpc()
    rows = []
    for e in picked:
        b = e["block"]
        meta = C.reserve_meta(rpc, b)
        a = eth[e["collateral"]]
        acc = C.read_accounts(rpc, b - 1, meta, [e["user"]])[e["user"]]
        em = C.emode_meta(rpc, b - 1, [acc["emode"]]) if acc["emode"] else {}
        r = meta[a]
        lb = LQ.effective_bonus(r["lb"], r["id"], acc["emode"], {str(k): v for k, v in em.items()})
        # collateral balance at execution: scaled balance (block - 1) x normalized income at the event block
        res = rpc.multicall([(r["aToken"], C.cd("scaledBalanceOf", e["user"]))], b - 1, "spot")
        inc = rpc.multicall([(C.POOL, C.cd("getReserveNormalizedIncome", e["collateral"]))], b, "spot")
        scaled = C.B.decode_uint(res[0][1])
        bal_exec = (scaled * C.B.decode_uint(inc[0][1]) + 10**27 // 2) // 10**27
        coll, debt, fee = LQ.collateral_to_liquidate(e["debtToCover"], meta["USDC"]["price"], 10**6, r["price"],
                                                     10**18, lb, r["protocol_fee"], bal_exec,
                                                     rounding=LQ.rounding_for_block(b))
        mx = LQ.max_liquidatable_debt(acc["d_USDC"], meta["USDC"]["price"], 10**6, acc["a_" + a], r["price"], 10**18,
                                      acc["totalDebtBase"], acc["healthFactor"])
        row = {"block": b, "tx": e["tx"], "log_index": e["log_index"], "asset": a, "emode": acc["emode"],
               "lb": lb, "protocol_fee": r["protocol_fee"], "coll_price": r["price"], "usdc_price": meta["USDC"]["price"],
               "user_coll_balance_prev": acc["a_" + a], "user_coll_balance_exec": bal_exec, "user_usdc_debt_prev": acc["d_USDC"],
               "total_debt_base_prev": acc["totalDebtBase"], "hf_prev": acc["healthFactor"],
               "debt_to_cover": e["debtToCover"], "event_collateral": e["collateralAmount"],
               "computed_collateral": coll, "rounding": LQ.rounding_for_block(b), "computed_debt": debt, "computed_fee": fee, "max_liquidatable_prev": mx,
               "capped": coll + fee == bal_exec or debt != e["debtToCover"],
               "exact": coll == e["collateralAmount"] and debt == e["debtToCover"]}
        # uncapped calls must match exactly; capped calls (seize the whole balance) depend on the balance at
        # execution, which a block-boundary read pins only to +-1 wei
        row["match"] = row["exact"] or (row["capped"] and abs(coll - e["collateralAmount"]) <= 1
                                        and abs(debt - e["debtToCover"]) <= 1)
        rows.append(row)
        print(json.dumps({k: row[k] for k in ("block", "asset", "match", "event_collateral", "computed_collateral",
                                              "hf_prev")}), flush=True)
    os.makedirs(os.path.dirname(fixture), exist_ok=True)
    with open(fixture, "w") as f:
        json.dump({"what": "Aave V3 Core LiquidationCall spot checks (ETH-family collateral, USDC debt); prices and "
                           "config at the event block, user balances at block - 1. No identities.",
                   "rows": rows}, f, indent=1)
    return rows


def publish(out: str) -> None:
    man = {}
    for fn in sorted(os.listdir(out)):
        p = os.path.join(out, fn)
        if os.path.isfile(p) and not fn.endswith(".sha256") and fn != "MANIFEST.json":
            man[fn] = {"bytes": os.path.getsize(p), "sha256": sha256(p)}
    with open(os.path.join(out, "MANIFEST.json"), "w") as f:
        json.dump({"prereg": PREREG, "code": git_info(), "files": man}, f, indent=1, sort_keys=True)
    with open(os.path.join(out, "SHA256SUMS"), "w") as f:
        for fn, v in man.items():
            f.write(f"{v['sha256']}  {fn}\n")


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("phase", choices=["simulate", "spotcheck", "publish"])
    ap.add_argument("--raw")
    ap.add_argument("--out")
    ap.add_argument("--name")
    ap.add_argument("--target")
    ap.add_argument("--window-h", type=int)
    ap.add_argument("--n-paths", type=int, default=N_PATHS)
    ap.add_argument("--fixture")
    a = ap.parse_args(argv)
    if a.phase == "simulate":
        doc = simulate(a.raw, a.out, a.name, a.target, a.window_h, a.n_paths)
        print(json.dumps({"results": doc["results"], "validation": doc.get("validation"),
                          "subject": doc["subject"], "seconds": doc["seconds"]}, indent=1, default=float))
    elif a.phase == "spotcheck":
        spotcheck(a.raw, a.fixture)
    else:
        publish(a.out)


if __name__ == "__main__":
    main()
