"""Q26 R11.1 liquidation replay v2 (membrane-board design/Q26_ROUND11_PREREG.md R11.1).

Stages (each one run once, after its frozen config is written and hashed):

  python3 r111_replay.py g0       --work R10WORK --out OUT             G0: published R10.1 hashes (D-day rows)
  python3 r111_replay.py freeze   --stage diag|confirm --work R10WORK --diag DIAG --out OUT [--rule RULE.json]
  python3 r111_replay.py diag     --work R10WORK --diag DIAG --out OUT   R11.1a cause tree on D only
  python3 r111_replay.py confirm  --work R10WORK --diag DIAG --out OUT   R11.1b dev (reported) + R11.1c gate on K

Inputs: the R10.1 raw acquisition (r10_acquire.py, membrane-app d96f48c8), the R11.1 diagnostic reads
(r111_acquire.py) and membrane-datasets. No address is written to OUT (checked for 0x + 40-hex).
"""
from __future__ import annotations

import argparse
import bisect
import csv
import datetime as dt
import gzip
import hashlib
import io
import json
import os
import re
import subprocess
import sys

import numpy as np
from scipy.stats import spearmanr

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import r10_acquire as A  # noqa: E402
import r10_mechanics as M  # noqa: E402

RAY = 10**27
D_FIRST, D_LAST = dt.date(2023, 2, 1), dt.date(2024, 12, 31)
K_FIRST, K_LAST = dt.date(2025, 1, 1), dt.date(2026, 9, 30)
Q2 = (dt.date(2026, 4, 1), dt.date(2026, 6, 30))
SMALL_MAX = 250_000.0
BANDS = [(0, 1e3, "<1k"), (1e3, 1e4, "1k-10k"), (1e4, 1e5, "10k-100k"), (1e5, float("inf"), ">=100k")]
STALE_TOL = 0.01
HF_TOL = 0.001
FIX_SHARE = 0.10
GATE = {"S_min": 0.80, "H_min": 0.60}
CAUSES = ["C-open", "C-stale", "C-asset", "C-gas", "C-grain", "C-mech", "C-accrual", "C-other"]
PUB_R101 = "history-forecasts/r10/r101-run-d96f48c8"
ADDR_RE = re.compile(r"0x[0-9a-fA-F]{40}")
WETH_SYMS = {"WETH"}

READINGS = {
    "R11-1": "Missed real event: a real USDC-debt LiquidationCall on UTC day d (block timestamp) whose account has no "
             "simulated USDC-debt call on day d. Missed real day: real volume > 0 and simulated volume = 0.",
    "R11-2": "C-open: the account is not in the replay universe of day d (no USDC debt known at d's anchor; every USDC "
             "borrower of the previous 24 h is read at the anchor and the universe is rescanned weekly), or it was never "
             "read, or its first USDC borrow block is after d's anchor.",
    "R11-3": "C-stale: the last full read is 1-7 days before d's anchor and, at block-1 prices, the carried position "
             "(scaled balances x block-1 indexes) differs from the block-1 read by > 1% in total debt value or total "
             "collateral value.",
    "R11-4": "C-asset: on day d the model called the account only with non-USDC debt ('that hour' read as any hour of d).",
    "R11-5": "C-gas: model HF < 1 at some hour of d, no call was made, and the first call was stopped by "
             "bonus - fee - 0.01 ETH gas < 0.",
    "R11-6": "C-grain: chain HF at block-1 < 1; model HF from the block-1 balances at the prices of the hourly read "
             "nearest to block-1 (by block number, day d) >= 1; at block-1 oracle prices < 1.",
    "R11-7": "C-mech: model HF from the block-1 balances at block-1 prices (day d reserve LT, block-1 e-mode) differs from "
             "chain HF by > 0.1%. Sub-tallies (not exclusive): non-WETH collateral, e-mode != 0, e-mode with a price "
             "source, isolation (a collateral reserve with debt ceiling > 0), flagged collateral with LT = 0.",
    "R11-8": "C-accrual: at the account's last read the modelled HF matched chain HF within 0.1% (V-B0 rule), and the "
             "carried position scaled by the model's hourly indexes (hour nearest block-1) at block-1 prices misses chain "
             "HF at block-1 by > 0.1%. Reported split: carried vs block-1 balances within / beyond 1%.",
    "R11-9": "Day attribution: each missed real day takes the cause carrying the most real USD among its events (ties: "
             "tree order). USD share: real USD of missed events with that cause over all missed-event USD in D.",
    "R11-10": "Gas: per real tx gasUsed x block base fee (ETH; USD at the hour's WETH oracle price); priority per gas = "
              "effectiveGasPrice - base fee.",
    "R11-11": "Volume causes (hit days): per simulated call, flags close-factor-bound (repay < the debt reserve), "
              "seize-capped, 6-call cap reached with HF < 1, account with > 1 call that day.",
}


def sha256_file(path):
    return M.sha256_file(path)


def jdump(path, obj):
    with open(path, "w") as f:
        json.dump(obj, f, indent=1, sort_keys=True, default=float)


def git_sha():
    return M.git_sha()


def dates_between(a, b):
    out, d = [], a
    while d <= b:
        out.append(d.isoformat())
        d += dt.timedelta(days=1)
    return out


def in_q2(d):
    d = dt.date.fromisoformat(d) if isinstance(d, str) else d
    return Q2[0] <= d <= Q2[1]


def k_days():
    return [d for d in dates_between(K_FIRST, K_LAST) if not in_q2(d)]


def d_days():
    return dates_between(D_FIRST, D_LAST)


# ---------------------------------------------------------------------------------------------
# G0
# ---------------------------------------------------------------------------------------------

def hourly_inputs_rows(work):
    """Rebuild usdc-hourly-inputs.csv rows (same columns as the published file) from the raw hourly reads."""
    metas = A.load_meta(work)
    out = []
    for name in sorted(os.listdir(os.path.join(work, "hourly"))):
        h = A.jload(os.path.join(work, "hourly", name))
        d = h["date"]
        j = h["assets"].index(A.USDC)
        for r in h["rows"]:
            curve, abi = (r["curve_v2"], "v2") if r["curve_v2"] is not None else ((r["curve_v1"], "v1") if r["curve_v1"] is not None else (None, ""))
            rf = (int(r["config"]) >> 64) & 0xFFFF
            out.append([dt.datetime.fromtimestamp(r["hour"], dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"), r["block"],
                        r["vDebtTotal"], r["sDebtTotal"], r["aTotal"], r["cashBalance"],
                        "" if r["virtualBalance"] is None else r["virtualBalance"], r["unbacked"], rf, abi,
                        *(curve if curve else ["", "", "", ""]), r["rd_variableBorrowRate"], r["rd_liquidityRate"],
                        "" if r["prices"][j] is None else r["prices"][j]])
    return out


def g0(work, out):
    pub = os.path.join(A.DATASETS, PUB_R101)
    res = {}
    # hourly inputs: the D-day rows of the published file vs the rebuild
    with gzip.open(os.path.join(pub, "usdc-hourly-inputs.csv.gz"), "rt") as f:
        lines = f.read().splitlines()
    header, body = lines[0], lines[1:]
    rebuilt = []
    for r in hourly_inputs_rows(work):
        s = io.StringIO()
        csv.writer(s, lineterminator="").writerow(r)
        rebuilt.append(s.getvalue())
    dset = set(d_days())
    pub_d = [x for x in body if x[:10] in dset]
    reb_d = [x for x in rebuilt if x[:10] in dset]
    h = lambda xs: hashlib.sha256(("\n".join(xs)).encode()).hexdigest()
    res["usdc_hourly_inputs"] = {"published_file_sha256": sha256_file(os.path.join(pub, "usdc-hourly-inputs.csv.gz")),
                                 "D_rows_published": len(pub_d), "D_rows_rebuilt": len(reb_d),
                                 "D_rows_sha256_published": h(pub_d), "D_rows_sha256_rebuilt": h(reb_d),
                                 "all_rows_equal": body == rebuilt, "match_D": pub_d == reb_d}
    res["header_published"] = header
    # liq-daily: the D-day rows of the published file vs the rerun of r10_mechanics d96f48c8 on the raw acquisition
    rerun = os.path.join(out, "..", "g0out", "liq-daily.csv")
    pl = open(os.path.join(pub, "liq-daily.csv")).read().splitlines()
    rl = open(rerun).read().splitlines() if os.path.exists(rerun) else []
    pd_ = [x for x in pl[1:] if x[:10] in dset]
    rd_ = [x for x in rl[1:] if x[:10] in dset]
    res["liq_daily"] = {"published_file_sha256": sha256_file(os.path.join(pub, "liq-daily.csv")),
                        "rerun_file_sha256": sha256_file(rerun) if rl else None,
                        "D_rows_sha256_published": h(pd_), "D_rows_sha256_rerun": h(rd_), "match_D": bool(rl) and pd_ == rd_,
                        "D_rows": len(pd_)}
    res["pass"] = bool(res["usdc_hourly_inputs"]["match_D"] and res["liq_daily"]["match_D"])
    return res


# ---------------------------------------------------------------------------------------------
# replay engine (R10.1 rule; v2 options)
# ---------------------------------------------------------------------------------------------

class World:
    def __init__(self, work):
        self.work = work
        self.metas = A.load_meta(work)
        self.days_all = sorted(self.metas)
        self.replay_days = [d for d in self.days_all if dt.date.fromisoformat(d) <= A.LAST_DAY]
        self.symbols = A.jload(os.path.join(work, "symbols.json.gz"))
        self.gl = sorted({a for m in self.metas.values() for a in m["assets"]})
        self.gidx = {a: k for k, a in enumerate(self.gl)}
        self.R = len(self.gl)
        self.usdc_k = self.gidx[A.USDC]
        self.weth_k = self.gidx[[a for a in self.gl if self.symbols.get(a) == "WETH"][0]]
        self.anchor = {d: self.metas[d]["block"] for d in self.days_all}
        self._day = {}

    def D(self, d):
        if d not in self._day:
            self._day[d] = M.Day(self.metas[d], self.gidx)
        return self._day[d]

    def hour_rows(self, d):
        p = os.path.join(self.work, "hourly", f"{d}.json.gz")
        return A.jload(p)["rows"] if os.path.exists(p) else []

    def vec(self, d, r):
        R, day = self.R, self.D(d)
        px, inc, vix = np.zeros(R), np.ones(R), np.ones(R)
        for j, a in enumerate(self.metas[d]["assets"]):
            k = self.gidx[a]
            px[k] = (r["prices"][j] or 0) / 1e8
            inc[k] = int(r["income"][j]) / RAY if r["income"][j] not in (None, "None") else day.inc0[k]
            vix[k] = int(r["vindex"][j]) / RAY if r["vindex"][j] not in (None, "None") else day.vix0[k]
        return px, inc, vix


def liquidate_v(i, SA, SV, SS, LT, LB, day, px, inc, vix, gas_usd, usdc_k, pair_choice=False):
    """R10.1 liquidation loop (numerically identical to r10_mechanics.liquidate_account when pair_choice is False),
    instrumented. Returns (calls list, first-break reason)."""
    calls, reason = [], None
    for it in range(M.MAX_CALLS):
        coll = SA[i] * inc * px
        debtv = SV[i] * vix * px
        debts = SS[i] * px
        debt = debtv + debts
        td = debt.sum()
        if td <= 0:
            reason = reason or "nodebt"
            break
        elig = (LT[i] > 0) & (coll > 0)
        hf = (coll[elig] * LT[i][elig]).sum() / td
        if hf >= 1.0 or not elig.any():
            reason = reason or ("healthy" if hf >= 1.0 else "nocoll")
            break
        if pair_choice:
            best = None
            for j in np.nonzero(debt > 0)[0]:
                for k in np.nonzero(elig)[0]:
                    c = _call(int(j), int(k), td, hf, coll, debt, LB[i], day, gas_usd)
                    if c is not None and (best is None or c[3] > best[3]):
                        best = c
            if best is None:
                j = int(np.argmax(debt))
                k = int(np.argmax(np.where(elig, coll, -1.0)))
                c = _call(j, k, td, hf, coll, debt, LB[i], day, gas_usd, force=True)
                repay, seized, flags, profit, j, k = c
            else:
                repay, seized, flags, profit, j, k = best
        else:
            j = int(np.argmax(debt))
            k = int(np.argmax(np.where(elig, coll, -1.0)))
            repay, seized, flags, profit, j, k = _call(j, k, td, hf, coll, debt, LB[i], day, gas_usd, force=True)
        if profit < 0 or repay <= 0:
            reason = reason or ("gas" if repay > 0 else "zero")
            break
        rv = min(repay, debtv[j])
        SV[i, j] -= rv / (vix[j] * px[j])
        if repay > rv:
            SS[i, j] -= (repay - rv) / px[j]
        SA[i, k] -= seized / (inc[k] * px[k])
        SV[i, j] = max(SV[i, j], 0.0)
        SS[i, j] = max(SS[i, j], 0.0)
        SA[i, k] = max(SA[i, k], 0.0)
        flags["usdc"] = (j == usdc_k)
        calls.append((repay, j, flags))
        reason = reason or "called"
    else:
        # 6 calls made: is the account still below 1?
        coll = SA[i] * inc * px
        debt = SV[i] * vix * px + SS[i] * px
        td = debt.sum()
        elig = (LT[i] > 0) & (coll > 0)
        if td > 0 and elig.any() and (coll[elig] * LT[i][elig]).sum() / td < 1.0:
            for c in calls:
                c[2]["cap6"] = True
    return calls, reason


def _call(j, k, td, hf, coll, debt, LBi, day, gas_usd, force=False):
    flags = {"cf": False, "seize": False, "cap6": False}
    if day.v33:
        partial = coll[k] >= 2000.0 and debt[j] >= 2000.0 and hf > 0.95
        repay = 0.5 * td if (partial and debt[j] > 0.5 * td) else debt[j]
    else:
        repay = (0.5 if hf > 0.95 else 1.0) * debt[j]
    if repay < debt[j]:
        flags["cf"] = True
    lbk = LBi[k]
    seized = repay * lbk
    if seized > coll[k]:
        seized = coll[k]
        repay = seized / lbk
        flags["seize"] = True
    elif day.v33 and repay < debt[j] and (debt[j] - repay < 1000.0 or coll[k] - seized < 1000.0):
        repay = debt[j]
        flags["cf"] = False
        seized = repay * lbk
        if seized > coll[k]:
            seized = coll[k]
            repay = seized / lbk
            flags["seize"] = True
    fee = (seized - seized / lbk) * day.fee[k]
    profit = (seized - fee) - repay - gas_usd
    if not force and (profit < 0 or repay <= 0):
        return None
    return repay, seized, flags, profit, j, k


class Engine:
    """Day-by-day replay. rule keys: pair_choice (C-asset), gas ('flat' | 'basefee'), gas_G, gas_prio_wei,
    basefee_by_hour (dict hour -> wei)."""

    def __init__(self, world, rule=None, record=False):
        self.w = world
        self.rule = rule or {}
        self.record = record
        self.latest = {}       # id -> ((sa, sv, ss), emode, read_day, read_hf_ok)
        self.per_day = {}
        self.acct_day = {}     # (day, id) -> {"minhf", "calls": [(usd, usdc, flags)], "reason"}
        self.hourly_usdc_px = {}

    def gas_usd(self, h, eth_px):
        if self.rule.get("gas") == "basefee":
            bf = self.rule["basefee_by_hour"].get(h)
            if bf is not None:
                return (bf + self.rule["gas_prio_wei"]) * self.rule["gas_G"] / 1e18 * eth_px
        return M.GAS_ETH * eth_px

    def run_day(self, d):
        w, R = self.w, self.w.R
        pos = A.jload(os.path.join(w.work, "positions", f"{d}.json.gz"))
        day = w.D(d)
        for sid, acc in pos["accounts"].items():
            arr = M.acct_arrays(acc, w.gidx, R, day)
            ok = None
            hf_chain = int(acc["hf"]) / 1e18
            if acc["td"] > 0 and hf_chain < M.VB0_HF_MAX:
                lt, _ = day.eff(acc["emode"])
                sa, sv, ss = arr
                coll = sa * day.inc0 * day.price0
                debt = (sv * day.vix0 + ss) * day.price0
                if debt.sum() > 0 and hf_chain > 0:
                    ok = bool(abs(((coll * lt).sum() / debt.sum()) / hf_chain - 1) <= HF_TOL)
            self.latest[int(sid)] = (arr, acc["emode"] or 0, d, ok)
        ids = [x for x in pos["universe"] if x in self.latest]
        n = len(ids)
        SA, SV, SS = np.zeros((n, R)), np.zeros((n, R)), np.zeros((n, R))
        LT, LB = np.zeros((n, R)), np.ones((n, R))
        cache = {}
        for r_i, x in enumerate(ids):
            (sa, sv, ss), em, _, _ = self.latest[x]
            SA[r_i], SV[r_i], SS[r_i] = sa, sv, ss
            if em not in cache:
                cache[em] = day.eff(em)
            LT[r_i], LB[r_i] = cache[em]
        hk = {r["hour"]: r for r in w.hour_rows(d)}
        t0 = A.utc(dt.date.fromisoformat(d))
        prev = None
        vu, va, nc = 0.0, 0.0, 0
        flags_usd = {"cf": 0.0, "seize": 0.0, "cap6": 0.0, "multi": 0.0}
        acct_usdc = {}
        today = {}
        for hh in range(24):
            h = t0 + 3600 * hh
            r = hk.get(h)
            if r is not None:
                prev = w.vec(d, r)
            elif prev is None:
                prev = (day.price0.copy(), day.inc0.copy(), day.vix0.copy())
            px, inc, vix = prev
            self.hourly_usdc_px[h] = px[w.usdc_k]
            if n == 0:
                continue
            coll = SA * (inc * px)
            debt = SV * (vix * px) + SS * px
            td = debt.sum(axis=1)
            num = (coll * LT).sum(axis=1)
            with np.errstate(divide="ignore", invalid="ignore"):
                hf = np.where(td > 0, num / np.where(td > 0, td, 1), np.inf)
            g = self.gas_usd(h, px[w.weth_k])
            for i in np.nonzero(hf < 1.0)[0]:
                calls, reason = liquidate_v(int(i), SA, SV, SS, LT, LB, day, px, inc, vix, g, w.usdc_k,
                                            pair_choice=self.rule.get("pair_choice", False))
                x = ids[int(i)]
                if self.record:
                    a = today.setdefault(x, {"minhf": float(hf[i]), "calls": [], "reasons": set(), "hours_below": 0})
                    a["minhf"] = min(a["minhf"], float(hf[i]))
                    a["hours_below"] += 1
                    a["reasons"].add(reason)
                    a["calls"].extend((c[0], c[2]["usdc"], c[2]) for c in calls)
                for repay, j, fl in calls:
                    va += repay
                    nc += 1
                    if fl["usdc"]:
                        vu += repay
                        acct_usdc[x] = acct_usdc.get(x, 0) + 1
                        for f in ("cf", "seize", "cap6"):
                            if fl[f]:
                                flags_usd[f] += repay
        if self.record:
            for x, a in today.items():
                self.acct_day[(d, x)] = a
                if acct_usdc.get(x, 0) > 1:
                    flags_usd["multi"] += sum(c[0] for c in a["calls"] if c[1])
        self.per_day[d] = {"date": d, "sim_usdc_usd": vu, "sim_all_usd": va, "sim_calls": nc, "universe": n,
                           "fresh_reads": len(pos["accounts"]), "scan_day": pos["scan"], "flags_usd": flags_usd,
                           "uni": set(pos["universe"])}

    def run(self, until=None, hook=None, start=None):
        for d in self.w.replay_days:
            if until and d > until:
                break
            self.run_day(d)
            if hook:
                hook(d)


def real_events(world, hourly_usdc_px):
    """Every real USDC-debt LiquidationCall with its UTC day and USD (R10.1 R10-8 rule), user kept in memory only."""
    logs = A.jload(os.path.join(A.DATASETS, M.C1_LOGS))["liquidations"]
    bts = M.block_ts_lookup(world.work)
    hours_sorted = sorted(hourly_usdc_px)
    out = []
    pool = None
    for lg in logs:
        if lg["debt"] != A.USDC:
            continue
        ts = bts.get(lg["block"])
        if ts is None:
            pool = pool or A.Pool()
            ts = pool.pick().block_ts(lg["block"])
        px = None
        if hours_sorted:
            h = ts // 3600 * 3600
            i = bisect.bisect_right(hours_sorted, h) - 1
            px = hourly_usdc_px[hours_sorted[max(i, 0)]]
        out.append({"block": lg["block"], "ts": ts, "day": dt.datetime.fromtimestamp(ts, dt.timezone.utc).date().isoformat(),
                    "units": lg["debtToCover"] / 1e6, "usd": None if px is None else lg["debtToCover"] / 1e6 * px,
                    "user": lg["user"].lower(), "tx": lg["tx"],
                    "collateral": lg["collateral"].lower()})
    return out


# ---------------------------------------------------------------------------------------------
# R11.1a diagnosis
# ---------------------------------------------------------------------------------------------

def hf_of(bal_amounts, prices, lt):
    """bal_amounts: (coll units, debt units) arrays; prices USD. Returns HF (inf if no debt)."""
    coll, debt = bal_amounts
    td = (debt * prices).sum()
    if td <= 0:
        return float("inf")
    elig = lt > 0
    return float((coll[elig] * prices[elig] * lt[elig]).sum() / td)


def diag_vectors(world, rec, d):
    """Block-1 prices, income and variable-debt index aligned to the global reserve index."""
    R = world.R
    day = world.D(d)
    px, inc, vix = np.zeros(R), day.inc0.copy(), day.vix0.copy()
    for j, a in enumerate(rec["assets"]):
        k = world.gidx[a]
        px[k] = (rec["prices"][j] or 0) / 1e8
        if rec["income"][j] not in (None, "None"):
            inc[k] = int(rec["income"][j]) / RAY
        if rec["vindex"][j] not in (None, "None"):
            vix[k] = int(rec["vindex"][j]) / RAY
    return px, inc, vix


def acct_units(world, acc, d):
    R, day = world.R, world.D(d)
    ca, de = np.zeros(R), np.zeros(R)
    flagged_coll = []
    for a, b in acc["bal"].items():
        k = world.gidx[a]
        unit = 10 ** day.dec[k]
        if "a" in b:
            ca[k] = int(b["a"]) / unit
            flagged_coll.append(k)
        de[k] = (int(b.get("v", 0)) + int(b.get("s", 0))) / unit
    return ca, de, flagged_coll


class Diagnoser:
    """Classifies each day's missed real events right after that day's replay (state as known on day d)."""

    def __init__(self, world, diag_dir, eng, evs, ids_map, first_borrow):
        self.world, self.eng, self.ids_map, self.first_borrow = world, eng, ids_map, first_borrow
        dset = set(d_days())
        self.recs = {}
        for name in os.listdir(os.path.join(diag_dir, "diag-blocks")):
            r = A.jload(os.path.join(diag_dir, "diag-blocks", name))
            self.recs[r["block"]] = r
        self.receipts = A.jload(os.path.join(diag_dir, "diag-receipts.json.gz"))
        self.by_day = {}
        for e in evs:
            if e["day"] in dset:
                self.by_day.setdefault(e["day"], []).append(e)
        self.rows = []
        self.sub_mech = {"non_weth_collateral": 0, "emode": 0, "emode_price_source": 0, "isolation": 0, "lt0_collateral": 0}
        self.accrual_split = {"balances_within_1pct": 0, "balances_beyond_1pct": 0}
        self.other_hf_ge1 = [0]

    def hook(self, d):
        hours_sorted = sorted(self.eng.hourly_usdc_px)
        for e in self.by_day.get(d, []):
            h = e["ts"] // 3600 * 3600
            i = bisect.bisect_right(hours_sorted, h) - 1
            e["usd"] = e["units"] * self.eng.hourly_usdc_px[hours_sorted[max(i, 0)]]
            self.classify(e)

    def classify(self, e):
        world, eng, ids_map, first_borrow = self.world, self.eng, self.ids_map, self.first_borrow
        recs, rows, sub_mech, accrual_split = self.recs, self.rows, self.sub_mech, self.accrual_split
        if True:
            d = e["day"]
            x = ids_map.get(e["user"])
            a = eng.acct_day.get((d, x)) if x is not None else None
            usdc_called = bool(a and any(c[1] for c in a["calls"]))
            if usdc_called:
                rows.append({**e, "missed": False, "cause": None})
                return
            rec = recs[e["block"]]
            acc = rec["accounts"][e["user"]]
            day = world.D(d)
            em = acc["emode"] or 0
            lt, _ = day.eff(em)
            px1, inc1, vix1 = diag_vectors(world, rec, d)
            ca, de, flagged = acct_units(world, acc, d)
            hf_chain = int(acc["hf"]) / 1e18
            hf_b1 = hf_of((ca, de), px1, lt)
            cause = None
            info = {}
            # 1 C-open
            uni = eng.per_day[d]["uni"]
            fb = first_borrow.get(e["user"])
            if x is None or x not in uni or x not in eng.latest or (fb is not None and fb > world.anchor[d]):
                cause = "C-open"
            lat = eng.latest.get(x) if x is not None else None
            # carried position as known on day d (latest read at or before d's anchor)
            if cause is None:
                (sa, sv, ss), em_c, read_day, read_ok = lat
                age = (dt.date.fromisoformat(d) - dt.date.fromisoformat(read_day)).days
                car_coll_u = sa * inc1
                car_debt_u = sv * vix1 + ss
                elig_c = (lt > 0)
                cv_car = float((car_coll_u * px1).sum())
                dv_car = float((car_debt_u * px1).sum())
                cv_b1 = float((ca * px1).sum())
                dv_b1 = float((de * px1).sum())
                diff_c = abs(cv_car - cv_b1) / max(cv_b1, 1e-9)
                diff_d = abs(dv_car - dv_b1) / max(dv_b1, 1e-9)
                info.update(age=age, diff_coll=diff_c, diff_debt=diff_d)
                # 2 C-stale
                if 1 <= age <= 7 and (diff_c > STALE_TOL or diff_d > STALE_TOL):
                    cause = "C-stale"
            if cause is None and a and a["calls"] and not usdc_called:
                cause = "C-asset"
            if cause is None and a and not a["calls"] and a["minhf"] < 1.0 and "gas" in a["reasons"]:
                cause = "C-gas"
            if cause is None:
                # 5 C-grain: nearest hourly read by block number within day d
                hrows = world.hour_rows(d)
                if hrows:
                    near = min(hrows, key=lambda r: abs(r["block"] - (e["block"] - 1)))
                    pxh, _, _ = world.vec(d, near)
                else:
                    pxh = day.price0
                hf_h = hf_of((ca, de), pxh, lt)
                info.update(hf_chain=hf_chain, hf_b1=hf_b1, hf_hour=hf_h)
                if hf_chain < 1.0 and hf_h >= 1.0 and hf_b1 < 1.0:
                    cause = "C-grain"
            if cause is None and hf_chain > 0 and abs(hf_b1 / hf_chain - 1) > HF_TOL:
                cause = "C-mech"
                colls = [k for k in flagged if ca[k] > 0]
                if any(k != world.weth_k for k in colls):
                    sub_mech["non_weth_collateral"] += 1
                if em:
                    sub_mech["emode"] += 1
                    if (world.metas[d]["emode"].get(str(em)) or {}).get("price_source"):
                        sub_mech["emode_price_source"] += 1
                if any(((int(world.metas[d]["reserves"][world.gl[k]]["config"]) >> 212) & ((1 << 40) - 1)) > 0
                       for k in colls if world.gl[k] in world.metas[d]["reserves"]):
                    sub_mech["isolation"] += 1
                if any(day.lt[k] == 0 or lt[k] == 0 for k in colls):
                    sub_mech["lt0_collateral"] += 1
            if cause is None:
                # 7 C-accrual: carried scaled by the model's hourly indexes (nearest hour) at block-1 prices
                (sa, sv, ss), em_c, read_day, read_ok = lat
                hrows = world.hour_rows(d)
                if hrows:
                    near = min(hrows, key=lambda r: abs(r["block"] - (e["block"] - 1)))
                    _, inch, vixh = world.vec(d, near)
                else:
                    inch, vixh = day.inc0, day.vix0
                hf_car = hf_of((sa * inch, sv * vixh + ss), px1, lt)
                if read_ok and hf_chain > 0 and abs(hf_car / hf_chain - 1) > HF_TOL:
                    cause = "C-accrual"
                    if info["diff_coll"] <= STALE_TOL and info["diff_debt"] <= STALE_TOL:
                        accrual_split["balances_within_1pct"] += 1
                    else:
                        accrual_split["balances_beyond_1pct"] += 1
            if cause is None:
                cause = "C-other"
                if hf_chain >= 1.0:
                    self.other_hf_ge1[0] += 1
            rows.append({**e, "missed": True, "cause": cause})

def tally(dg, eng, world):
    rows, sub_mech, accrual_split, recs, receipts = dg.rows, dg.sub_mech, dg.accrual_split, dg.recs, dg.receipts
    other_hf_ge1 = dg.other_hf_ge1[0]
    D_evs = [e for d in sorted(dg.by_day) for e in dg.by_day[d] if e["usd"] is not None]
    # tallies
    def band(u):
        return next(b[2] for b in BANDS if b[0] <= u < b[1])
    missed = [r for r in rows if r["missed"]]
    tot_usd = sum(r["usd"] for r in missed)
    real_day = {}
    for d in d_days():
        real_day[d] = 0.0
    for e in D_evs:
        real_day[e["day"]] += e["usd"]
    missed_days = [d for d in d_days() if real_day[d] > 0 and eng.per_day[d]["sim_usdc_usd"] == 0]
    day_cause = {}
    for d in missed_days:
        agg = {}
        for r in missed:
            if r["day"] == d:
                agg[r["cause"]] = agg.get(r["cause"], 0.0) + r["usd"]
        best = max(CAUSES, key=lambda c: (agg.get(c, -1.0), -CAUSES.index(c)))
        day_cause[d] = best
    table = []
    for c in CAUSES:
        ev = [r for r in missed if r["cause"] == c]
        row = {"cause": c, "missed_events": len(ev), "missed_event_share": len(ev) / max(len(missed), 1),
               "missed_usd": sum(r["usd"] for r in ev), "missed_usd_share": sum(r["usd"] for r in ev) / max(tot_usd, 1e-9),
               "missed_days": sum(1 for d in missed_days if day_cause[d] == c),
               "missed_day_share": sum(1 for d in missed_days if day_cause[d] == c) / max(len(missed_days), 1),
               "by_band": {}}
        for lo, hi, nm in BANDS:
            evb = [r for r in ev if lo <= r["usd"] < hi]
            allb = [r for r in missed if lo <= r["usd"] < hi]
            row["by_band"][nm] = {"events": len(evb), "usd": sum(r["usd"] for r in evb),
                                  "event_share_in_band": len(evb) / max(len(allb), 1)}
        row["selected_for_fix"] = bool(row["missed_day_share"] >= FIX_SHARE or row["missed_usd_share"] >= FIX_SHARE)
        table.append(row)
    # gas distribution
    eth_hour = {}
    gas = []
    seen = set()
    for e in D_evs:
        if e["tx"] in seen:
            continue
        seen.add(e["tx"])
        r = receipts[e["tx"]]
        rec = recs[e["block"]]
        bf = rec["base_fee"]
        wpx = None
        j = rec["assets"].index(world.gl[world.weth_k]) if world.gl[world.weth_k] in rec["assets"] else None
        if j is not None:
            wpx = (rec["prices"][j] or 0) / 1e8
        gas.append({"eth_base": r["gasUsed"] * bf / 1e18, "eth_eff": r["gasUsed"] * r["effectiveGasPrice"] / 1e18,
                    "gasUsed": r["gasUsed"], "prio_wei": max(r["effectiveGasPrice"] - bf, 0), "base_fee": bf, "weth": wpx})
    ge = np.array([g["eth_base"] for g in gas])
    gf = np.array([g["eth_eff"] for g in gas])
    gu = np.array([g["gasUsed"] for g in gas])
    pr = np.array([g["prio_wei"] for g in gas])
    usd = np.array([g["eth_base"] * (g["weth"] or 0) for g in gas])
    q = (0.05, 0.25, 0.5, 0.75, 0.95)
    gas_rep = {"txs": len(gas),
               "eth_gasUsed_x_basefee_q05_q25_q50_q75_q95": [float(np.quantile(ge, x)) for x in q],
               "usd_gasUsed_x_basefee_q05_q25_q50_q75_q95": [float(np.quantile(usd, x)) for x in q],
               "eth_gasUsed_x_effectiveGasPrice_q05_q25_q50_q75_q95": [float(np.quantile(gf, x)) for x in q],
               "share_basefee_cost_below_0p01_eth": float(np.mean(ge < 0.01)),
               "share_effective_cost_below_0p01_eth": float(np.mean(gf < 0.01)),
               "median_gasUsed": float(np.median(gu)), "median_priority_wei_per_gas": float(np.median(pr))}
    # volume causes on hit days
    hit = [d for d in d_days() if real_day[d] > 0 and eng.per_day[d]["sim_usdc_usd"] > 0]
    vol = {"hit_days": len(hit)}
    if hit:
        ratio = np.array([eng.per_day[d]["sim_usdc_usd"] / real_day[d] for d in hit])
        vol["sim_over_real_q10_q25_q50_q75_q90"] = [float(np.quantile(ratio, x)) for x in (0.1, 0.25, 0.5, 0.75, 0.9)]
        vol["sim_over_real_total"] = float(sum(eng.per_day[d]["sim_usdc_usd"] for d in hit) / sum(real_day[d] for d in hit))
        simtot = sum(eng.per_day[d]["sim_usdc_usd"] for d in hit)
        for f in ("cf", "seize", "cap6", "multi"):
            s = sum(eng.per_day[d]["flags_usd"][f] for d in hit)
            on = [eng.per_day[d]["sim_usdc_usd"] / real_day[d] for d in hit if eng.per_day[d]["flags_usd"][f] > 0]
            off = [eng.per_day[d]["sim_usdc_usd"] / real_day[d] for d in hit if eng.per_day[d]["flags_usd"][f] == 0]
            vol[{"cf": "close_factor_bound", "seize": "seized_collateral_cap", "cap6": "six_call_cap",
                 "multi": "multiple_calls_per_account"}[f]] = {
                "share_of_sim_usd": s / max(simtot, 1e-9), "days_with": len(on),
                "median_sim_over_real_days_with": float(np.median(on)) if on else None,
                "median_sim_over_real_days_without": float(np.median(off)) if off else None}
    out = {"D_days": len(d_days()), "D_real_events": len(D_evs), "D_missed_events": len(missed),
           "D_missed_usd": tot_usd, "D_real_usd": sum(e["usd"] for e in D_evs),
           "D_real_positive_days": sum(1 for d in d_days() if real_day[d] > 0), "D_missed_days": len(missed_days),
           "table": table, "mech_subtally": sub_mech, "accrual_split_reported": accrual_split,
           "other_with_chain_hf_ge1_at_block_minus_1_reported": other_hf_ge1,
           "gas": gas_rep, "volume_causes_hit_days": vol,
           "selected_causes": [r["cause"] for r in table if r["selected_for_fix"]]}
    return out, rows


# ---------------------------------------------------------------------------------------------
# gate statistics
# ---------------------------------------------------------------------------------------------

def gate_stats(days, sim, real, real_all_days):
    """sim, real: dicts day -> USD. real_all_days: dict over every replay day (for the trailing baselines)."""
    x = np.array([sim[d] for d in days])
    y = np.array([real[d] for d in days])
    S = float(spearmanr(x, y).correlation)
    small = (y > 0) & (y <= SMALL_MAX)
    zero = y == 0
    H = float(np.mean(x[small] > 0))
    F = float(np.mean(x[zero] > 0))
    allr = sorted(real_all_days)
    idx = {d: i for i, d in enumerate(allr)}
    ra = np.array([real_all_days[d] for d in allr])
    e_rank = np.array([ra[max(idx[d] - 7, 0):idx[d]].mean() if idx[d] > 0 else 0.0 for d in days])
    e_hit = np.array([ra[idx[d] - 1] > 0 if idx[d] > 0 else False for d in days])
    S_E = float(spearmanr(e_rank, y).correlation)
    H_E = float(np.mean(e_hit[small]))
    F_E = float(np.mean(e_hit[zero]))
    return {"n_days": len(days), "small_days": int(small.sum()), "zero_days": int(zero.sum()),
            "S": S, "H": H, "F": F, "J": H - F, "S_E": S_E, "H_E": H_E, "F_E": F_E, "J_E": H_E - F_E}


def reported_stats(days, sim, real):
    x = np.array([sim[d] for d in days])
    y = np.array([real[d] for d in days])
    pos = y > 0
    # 72 h rolling sums over consecutive K days only (windows that cross the 2026Q2 gap are dropped)
    dd = [dt.date.fromisoformat(d) for d in days]
    x3, y3 = [], []
    for i in range(len(days) - 2):
        if (dd[i + 2] - dd[i]).days == 2:
            x3.append(x[i:i + 3].sum())
            y3.append(y[i:i + 3].sum())
    top = np.argsort(-y)[:10]
    return {"S_72h_rolling": float(spearmanr(x3, y3).correlation), "S_real_positive_days": float(spearmanr(x[pos], y[pos]).correlation),
            "sim_over_real_top10": float(x[top].sum() / y[top].sum()),
            "top10": [{"date": days[i], "real": float(y[i]), "sim": float(x[i])} for i in top]}


# ---------------------------------------------------------------------------------------------
# config, guard
# ---------------------------------------------------------------------------------------------

def inputs_digest(work, diag):
    ins = {k: sha256_file(os.path.join(work, k)) for k in ("hours.json.gz", "rdu-block-ts.json.gz", "anchors.json.gz",
                                                           "symbols.json.gz", "action-users.json.gz")}
    for k in ("meta", "hourly", "positions"):
        ins[k + "/"] = M.dir_digest(os.path.join(work, k))
    ins["datasets:" + M.C1_LOGS] = sha256_file(os.path.join(A.DATASETS, M.C1_LOGS))
    ins["datasets:" + PUB_R101 + "/liq-daily.csv"] = sha256_file(os.path.join(A.DATASETS, PUB_R101, "liq-daily.csv"))
    if diag and os.path.isdir(os.path.join(diag, "diag-blocks")):
        ins["diag-blocks/"] = M.dir_digest(os.path.join(diag, "diag-blocks"))
        ins["diag-receipts.json.gz"] = sha256_file(os.path.join(diag, "diag-receipts.json.gz"))
    if diag and os.path.isdir(os.path.join(diag, "feehist-parts")):
        ins["feehist-parts/"] = M.dir_digest(os.path.join(diag, "feehist-parts"))
    return ins


def frozen(stage, work, diag, rule):
    sha, dirty = git_sha()
    code = {n: sha256_file(os.path.join(HERE, n)) for n in ("r111_replay.py", "r111_acquire.py", "r10_mechanics.py",
                                                            "r10_acquire.py")}
    return {"prereg": "membrane-board design/Q26_ROUND11_PREREG.md (registered 348d813)", "item": "R11.1", "stage": stage,
            "created_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "code_commit": sha, "code_dirty": dirty, "code_sha256": code, "inputs_sha256": inputs_digest(work, diag),
            "constants": {"D": [D_FIRST.isoformat(), D_LAST.isoformat()], "K": [K_FIRST.isoformat(), K_LAST.isoformat()],
                          "K_excluded": [Q2[0].isoformat(), Q2[1].isoformat()], "small_max_usd": SMALL_MAX,
                          "stale_tol": STALE_TOL, "hf_tol": HF_TOL, "fix_share": FIX_SHARE, "gate": GATE,
                          "max_calls": M.MAX_CALLS, "gas_eth_r101": M.GAS_ETH},
            "readings": READINGS, "rule_v2": rule, "seeds": "none (no randomness)"}


def guard(out):
    for name in os.listdir(out):
        p = os.path.join(out, name)
        if os.path.isdir(p):
            continue
        data = gzip.open(p, "rb").read() if name.endswith(".gz") else open(p, "rb").read()
        if ADDR_RE.search(data.decode("utf-8", "replace")):
            raise SystemExit(f"address guard: {name} holds a 0x+40-hex string")


def check_frozen(out, name, work, diag):
    cfg = json.load(open(os.path.join(out, name)))
    now = frozen(cfg["stage"], work, diag, cfg["rule_v2"])
    for key in ("code_commit", "code_sha256", "inputs_sha256", "constants", "readings"):
        if cfg[key] != now[key]:
            raise SystemExit(f"frozen config mismatch on {key}")
    if now["code_dirty"]:
        raise SystemExit("code tree dirty")
    return cfg


def load_borrowers(world):
    fb = {}
    for rel in A.borrow_files():
        with gzip.open(os.path.join(A.DATASETS, rel), "rt") as f:
            for r in csv.DictReader(f):
                if r["reserve"].lower() == A.USDC:
                    who, b = r["onBehalfOf"].lower(), int(r["block"])
                    if who not in fb or b < fb[who]:
                        fb[who] = b
    return fb


def write_daily(path, eng, days, real):
    with open(path, "w", newline="") as f:
        wr = csv.writer(f)
        wr.writerow(["date", "sim_usdc_usd", "real_usdc_usd", "sim_calls", "universe"])
        for d in days:
            p = eng.per_day[d]
            wr.writerow([d, f"{p['sim_usdc_usd']:.6f}", f"{real[d]:.6f}", p["sim_calls"], p["universe"]])


# ---------------------------------------------------------------------------------------------

def cmd_diag(a):
    cfg = check_frozen(a.out, "frozen-diag.json", a.work, a.diag)
    world = World(a.work)
    eng = Engine(world, rule=None, record=True)
    evs = real_events(world, {})
    ids = A.jload(os.path.join(a.work, "positions-state.json.gz"))["ids"]
    dg = Diagnoser(world, a.diag, eng, evs, ids, load_borrowers(world))
    eng.run(until=D_LAST.isoformat(), hook=dg.hook)
    # reproduction check: the instrumented R10.1 engine equals the published simulated series on D
    pub = {r["date"]: float(r["sim_usdc_usd"]) for r in csv.DictReader(open(os.path.join(A.DATASETS, PUB_R101, "liq-daily.csv")))}
    maxdiff = max(abs(eng.per_day[d]["sim_usdc_usd"] - pub[d]) for d in d_days())
    if maxdiff > 1e-6:
        raise SystemExit(f"R10.1 engine reproduction failed on D: max diff {maxdiff}")
    res, rows = tally(dg, eng, world)
    res["frozen_sha256"] = sha256_file(os.path.join(a.out, "frozen-diag.json"))
    res["r101_engine_max_abs_diff_on_D"] = maxdiff
    jdump(os.path.join(a.out, "r111a-diagnosis.json"), res)
    with open(os.path.join(a.out, "r111a-missed-days.csv"), "w", newline="") as f:
        wr = csv.writer(f)
        wr.writerow(["date", "real_usdc_usd", "real_events", "missed_events", "primary_cause"])
        days = sorted({r["day"] for r in rows})
        for d in days:
            ev = [r for r in rows if r["day"] == d]
            if eng.per_day[d]["sim_usdc_usd"] > 0:
                continue
            agg = {}
            for r in ev:
                agg[r["cause"]] = agg.get(r["cause"], 0.0) + r["usd"]
            best = max(CAUSES, key=lambda c: (agg.get(c, -1.0), -CAUSES.index(c)))
            wr.writerow([d, f"{sum(r['usd'] for r in ev):.2f}", len(ev), sum(r['missed'] for r in ev), best])
    guard(a.out)
    print(json.dumps({"missed_days": res["D_missed_days"], "missed_events": res["D_missed_events"],
                      "table": [(r["cause"], r["missed_events"], round(r["missed_day_share"], 4), round(r["missed_usd_share"], 4),
                                 r["selected_for_fix"]) for r in res["table"]], "selected": res["selected_causes"]}, indent=1))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["g0", "freeze", "diag", "confirm"])
    ap.add_argument("--work", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--diag")
    ap.add_argument("--stage")
    ap.add_argument("--rule")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    if a.cmd == "g0":
        res = g0(a.work, a.out)
        jdump(os.path.join(a.out, "g0.json"), res)
        print(json.dumps(res, indent=1))
    elif a.cmd == "freeze":
        name = f"frozen-{a.stage}.json"
        p = os.path.join(a.out, name)
        if os.path.exists(p):
            raise SystemExit("frozen config exists; not rewritten")
        rule = json.load(open(a.rule)) if a.rule else None
        cfg = frozen(a.stage, a.work, a.diag, rule)
        if cfg["code_dirty"]:
            raise SystemExit("code tree dirty: commit first")
        with open(p, "w") as f:
            json.dump(cfg, f, indent=1, sort_keys=True)
        print(f"frozen {p} sha256 {sha256_file(p)} created {cfg['created_utc']}")
    elif a.cmd == "diag":
        cmd_diag(a)
    elif a.cmd == "confirm":
        cmd_confirm(a)


def cmd_confirm(a):
    raise SystemExit("confirm stage is written after the fix Deviation")


if __name__ == "__main__":
    main()
