"""Q26 R10.1 mechanics replay gate and outcome counts (membrane-board design/Q26_ROUND10_PREREG.md R10.1).

A measurement, not a forecast fit: nothing is fitted. Inputs come from r10_acquire.py (--work) and membrane-datasets.

  python3 r10_mechanics.py freeze --work DIR --out OUT   write and hash the frozen config (before any result)
  python3 r10_mechanics.py run    --work DIR --out OUT   R10.1A curve replay, R10.1B liquidation replay, R10.1C counts

No address is written to OUT: reserves are named by symbol, accounts never appear.
"""
from __future__ import annotations

import argparse
import bisect
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
from scipy.stats import spearmanr, pearsonr

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import r10_acquire as A  # noqa: E402

RAY = 10**27
WAD = 10**18
HALF_RAY = RAY // 2
TOL_APR = 0.0002                 # 2 bp
PASS_SHARE = 0.99
PASS_SPEARMAN = 0.80
VB0_TOL = 0.001
VB0_HF_MAX = 10.0
VB0_SHARE = 0.99
MAX_CALLS = 6
GAS_ETH = 0.01                   # C1-D6
THRESHOLDS = [250_000, 500_000, 1_000_000, 2_500_000, 5_000_000, 10_000_000, 25_000_000, 50_000_000]
WINDOWS = {"24h": 1, "72h": 3}
MIN_POS = 40
SCORE_FIRST = dt.date(2023, 8, 1)
SCORE_LAST = dt.date(2026, 10, 10)
Q2 = (dt.date(2026, 4, 1), dt.date(2026, 6, 30))
EPISODE_GAP_DAYS = 4             # a new episode starts >= 4 days after the previous positive origin
C1_LOGS = "history-forecasts/c1/run-e79f9341/logs.json.gz"
ADDR_RE = re.compile(r"0x[0-9a-fA-F]{40}")

DECISIONS = {
    "R10-1": "Gate A sample: every UTC hour 2023-02-01..2026-10-12 with a USDC RDU block; b_h = last such block in the hour; "
             "target = last USDC RDU log in b_h. Hours without one are counted, not scored.",
    "R10-2": "Curve: v2 getInterestRateData(USDC) when it decodes, else the 4 v1 getters, read at b_h on the strategy in force "
             "(getReserveData at b_h). Ray math as Aave (rayMul/rayDiv half-up, percentMul half-up). v1 overall rate = "
             "debt-weighted variable/stable; v2 total debt = variable debt only (stable removed in v3.2).",
    "R10-3": "Available liquidity = getVirtualUnderlyingBalance where the call succeeds, else USDC.balanceOf(aToken).",
    "R10-4": "Positions: latest read of each universe account at or before day d; scaled by income / variable-debt index ratio "
             "(hour vs read anchor). Stable debt is not scaled.",
    "R10-5": "Collateral counts if its aToken balance was read (collateral flag set) and its effective LT > 0. Effective LT/LB = "
             "e-mode values when the reserve is in the user's category (v3.2 bitmap; legacy: reserve config bits 168-175). "
             "Reserve LT, LB, decimals and protocol fee from day d's anchor configuration.",
    "R10-6": "Liquidation: hourly at b_h, accounts with HF < 1; debt = largest debt by USD, collateral = largest eligible "
             "collateral by USD; close factor pre-v3.3 50% (HF > 0.95) else 100% of that debt; v3.3+ C1 max_debt_float plus "
             "the $1,000 leftover rule (take the full reserve debt); profit = seized to liquidator - repaid - 0.01 ETH >= 0; "
             "up to 6 calls per account-hour; variable debt burned before stable.",
    "R10-7": "Hours without b_h carry the previous hour's prices and indexes.",
    "R10-8": "Real volume: C1 logs LiquidationCall debt = USDC, debtToCover / 1e6 x hourly USDC oracle price; UTC day of block ts "
             "from the RDU block map, otherwise eth_getBlockByNumber.",
    "R10-9": "V-B0: account-days freshly read that day with chain HF < 10 and positive debt; modelled HF at the anchor uses "
             "anchor prices and the read balances unscaled.",
    "R10-10": "Episodes: positive origins; a new episode starts when the gap to the previous positive origin is >= 4 days.",
    "R10-11": "Spearman over all 1,350 replay days (ties averaged, scipy). 72 h sums: non-overlapping origins every day, "
              "rolling.",
}


def ray_mul(a, b):
    return (a * b + HALF_RAY) // RAY


def ray_div(a, b):
    return (a * RAY + b // 2) // b


def percent_mul(v, p):
    return (v * p + 5000) // 10000


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for blk in iter(lambda: f.read(1 << 20), b""):
            h.update(blk)
    return h.hexdigest()


def dir_digest(path):
    h = hashlib.sha256()
    for name in sorted(os.listdir(path)):
        h.update(name.encode() + b"\0" + sha256_file(os.path.join(path, name)).encode() + b"\n")
    return h.hexdigest()


def git_sha():
    try:
        sha = subprocess.check_output(["git", "-C", HERE, "rev-parse", "HEAD"], text=True).strip()
        dirty = subprocess.check_output(["git", "-C", HERE, "status", "--porcelain", "--", "."], text=True).strip()
        return sha, bool(dirty)
    except Exception:
        return None, None


# ---------------------------------------------------------------------------------------------
# R10.1A curve
# ---------------------------------------------------------------------------------------------

def model_rates(row):
    """(borrow_rate_ray, supply_rate_ray, era) from one hourly row."""
    vdebt = int(row["vDebtTotal"])
    sdebt = int(row["sDebtTotal"])
    avg_stable = int(row["avgStableRate"])
    unbacked = int(row["unbacked"])
    rf = (int(row["config"]) >> 64) & 0xFFFF
    if row["virtualBalance"] is not None:
        avail, liq_src = int(row["virtualBalance"]), "virtual"
    else:
        avail, liq_src = int(row["cashBalance"]), "balance"
    if row["curve_v2"] is not None:
        opt, base, s1, s2 = (int(x) for x in row["curve_v2"])
        abi = "v2"
        total = vdebt
    elif row["curve_v1"] is not None:
        opt, base, s1, s2 = (int(x) for x in row["curve_v1"])
        abi = "v1"
        total = vdebt + sdebt
    else:
        return None, None, "nocurve"
    if total == 0:
        return base, 0, f"{abi}-{liq_src}"
    plus = avail + total
    bu = ray_div(total, plus)
    su = ray_div(total, plus + unbacked)
    var = base
    if bu > opt:
        var += s1 + ray_mul(s2, ray_div(bu - opt, RAY - opt))
    else:
        var += ray_div(ray_mul(s1, bu), opt)
    if abi == "v1":
        overall = ray_div(ray_mul(vdebt * 10**9, var) + ray_mul(sdebt * 10**9, avg_stable), total * 10**9)
    else:
        overall = var
    supply = percent_mul(ray_mul(overall, su), 10000 - rf)
    return var, supply, f"{abi}-{liq_src}"


def gate_a(work, out):
    hours = A.jload(os.path.join(work, "hours.json.gz"))
    target = {h["hour"]: h for h in hours}
    rows = []
    tuples = {}
    for name in sorted(os.listdir(os.path.join(work, "hourly"))):
        for r in A.jload(os.path.join(work, "hourly", name))["rows"]:
            t = target[r["hour"]]
            assert t["block"] == r["block"]
            b, s, era = model_rates(r)
            tb, ts_ = int(t["variableBorrowRate"]), int(t["liquidityRate"])
            curve = tuple(r["curve_v2"] or r["curve_v1"] or ())
            tuples.setdefault(curve, [r["hour"], r["hour"], 0])
            tuples[curve][1] = r["hour"]
            tuples[curve][2] += 1
            rows.append({"hour": r["hour"], "block": r["block"], "era": era,
                         "borrow_target": tb / RAY, "borrow_model": (b / RAY) if b is not None else None,
                         "supply_target": ts_ / RAY, "supply_model": (s / RAY) if s is not None else None})
    n_all = (A.HOUR_END - A.HOUR_START) // 3600
    eb = np.array([abs(x["borrow_model"] - x["borrow_target"]) if x["borrow_model"] is not None else np.inf for x in rows])
    es = np.array([abs(x["supply_model"] - x["supply_target"]) if x["supply_model"] is not None else np.inf for x in rows])
    share_b = float(np.mean(eb <= TOL_APR))
    share_s = float(np.mean(es <= TOL_APR))
    eras = {}
    for x, a, b in zip(rows, eb, es):
        e = eras.setdefault(x["era"], {"n": 0, "fail_b": 0, "fail_s": 0, "eb": [], "es": []})
        e["n"] += 1
        e["fail_b"] += int(a > TOL_APR)
        e["fail_s"] += int(b > TOL_APR)
        e["eb"].append(a)
        e["es"].append(b)
    era_rep = {k: {"n": v["n"], "fail_borrow": v["fail_b"], "fail_supply": v["fail_s"],
                   "borrow_err_bp_q50_q99_max": [float(np.quantile(v["eb"], q) * 1e4) for q in (0.5, 0.99, 1.0)],
                   "supply_err_bp_q50_q99_max": [float(np.quantile(v["es"], q) * 1e4) for q in (0.5, 0.99, 1.0)]}
               for k, v in eras.items()}
    curves = [{"opt_base_slope1_slope2_ray": list(k), "first_hour": dt.datetime.fromtimestamp(v[0], dt.timezone.utc).isoformat(),
               "last_hour": dt.datetime.fromtimestamp(v[1], dt.timezone.utc).isoformat(), "hours": v[2]}
              for k, v in sorted(tuples.items(), key=lambda kv: kv[1][0])]
    fails = [{"hour": dt.datetime.fromtimestamp(x["hour"], dt.timezone.utc).isoformat(), "era": x["era"],
              "borrow_err_bp": float(a * 1e4), "supply_err_bp": float(b * 1e4)}
             for x, a, b in zip(rows, eb, es) if a > TOL_APR or b > TOL_APR]
    with gzip.open(os.path.join(out, "gate-a-hourly.csv.gz"), "wt", newline="") as f:
        w = csv.writer(f)
        w.writerow(["hour_utc", "block", "era", "borrow_target", "borrow_model", "supply_target", "supply_model"])
        for x in rows:
            w.writerow([dt.datetime.fromtimestamp(x["hour"], dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"), x["block"], x["era"],
                        f"{x['borrow_target']:.12f}", "" if x["borrow_model"] is None else f"{x['borrow_model']:.12f}",
                        f"{x['supply_target']:.12f}", "" if x["supply_model"] is None else f"{x['supply_model']:.12f}"])
    return {"hours_in_span": n_all, "hours_sampled": len(rows), "hours_without_rdu_block": n_all - len(rows),
            "share_borrow_within_2bp": share_b, "share_supply_within_2bp": share_s,
            "pass_borrow": bool(share_b >= PASS_SHARE), "pass_supply": bool(share_s >= PASS_SHARE),
            "pass": bool(share_b >= PASS_SHARE and share_s >= PASS_SHARE),
            "borrow_err_bp_q50_q99_q999_max": [float(np.quantile(eb, q) * 1e4) for q in (0.5, 0.99, 0.999, 1.0)],
            "supply_err_bp_q50_q99_q999_max": [float(np.quantile(es, q) * 1e4) for q in (0.5, 0.99, 0.999, 1.0)],
            "by_era": era_rep, "curve_tuples_on_chain": curves,
            "governance_log_rate_events": 0,
            "governance_log_note": "governance-changes/aave-v3-ethereum-core.json holds no rate-strategy events; "
                                   "parameter changes are identified from the on-chain reads only",
            "failing_hours_first_200": fails[:200], "n_failing_hours": len(fails)}


# ---------------------------------------------------------------------------------------------
# R10.1B liquidation replay
# ---------------------------------------------------------------------------------------------

def decode_conf(c):
    return {"lt": (c >> 16) & 0xFFFF, "lb": (c >> 32) & 0xFFFF, "dec": (c >> 48) & 0xFF, "fee": (c >> 152) & 0xFFFF,
            "emode_cat": (c >> 168) & 0xFF}


class Day:
    """Reserve tables for one day (aligned to a global reserve index)."""

    def __init__(self, meta, gidx):
        self.meta = meta
        self.R = len(gidx)
        self.lt = np.zeros(self.R)
        self.lb = np.ones(self.R)
        self.fee = np.zeros(self.R)
        self.dec = np.zeros(self.R)
        self.rid = -np.ones(self.R, dtype=int)
        self.cat = np.zeros(self.R, dtype=int)
        self.price0 = np.zeros(self.R)
        self.inc0 = np.ones(self.R)
        self.vix0 = np.ones(self.R)
        for a, r in meta["reserves"].items():
            k = gidx[a]
            c = decode_conf(int(r["config"]))
            self.lt[k], self.lb[k], self.fee[k], self.dec[k] = c["lt"] / 1e4, c["lb"] / 1e4, c["fee"] / 1e4, c["dec"]
            self.rid[k], self.cat[k] = r["id"], c["emode_cat"]
            self.price0[k] = (r["price"] or 0) / 1e8
            self.inc0[k] = int(r["income"]) / RAY
            self.vix0[k] = int(r["vindex"]) / RAY
        self.emode = meta["emode"]
        self.v33 = meta["v33"]

    def eff(self, emode):
        """Effective (LT, LB) vectors for a user e-mode id (cached per day)."""
        emode = int(emode or 0)
        if not hasattr(self, "_eff"):
            self._eff = {}
        if emode not in self._eff:
            self._eff[emode] = self._eff_compute(emode)
        return self._eff[emode]

    def _eff_compute(self, emode):
        lt, lb = self.lt.copy(), self.lb.copy()
        e = self.emode.get(str(emode)) if emode else None
        if e:
            for k in range(self.R):
                if self.rid[k] < 0:
                    continue
                inside = ((e["bitmap"] >> int(self.rid[k])) & 1) if e["layout"] == "v32" else (self.cat[k] == int(emode))
                if inside:
                    lt[k], lb[k] = e["lt"] / 1e4, e["lb"] / 1e4
        return lt, lb


def acct_arrays(acc, gidx, R, read_day):
    """Scaled balances: collateral and variable debt divided by the read-anchor index (so value = scaled x index x price)."""
    sa, sv, ss = np.zeros(R), np.zeros(R), np.zeros(R)
    for a, b in acc["bal"].items():
        k = gidx[a]
        unit = 10 ** read_day.dec[k]
        if "a" in b:
            sa[k] = int(b["a"]) / unit / read_day.inc0[k]
        if "v" in b:
            sv[k] = int(b["v"]) / unit / read_day.vix0[k]
        if "s" in b:
            ss[k] = int(b["s"]) / unit
    return sa, sv, ss


def liquidate_account(i, SA, SV, SS, LT, LB, day, px, inc, vix, eth_px, usdc_k):
    """Hourly liquidation loop for account i (mutates its rows). Returns (usdc_repaid_usd, all_repaid_usd, calls)."""
    usdc, allr, calls = 0.0, 0.0, 0
    for _ in range(MAX_CALLS):
        coll = SA[i] * inc * px
        debtv = SV[i] * vix * px
        debts = SS[i] * px
        debt = debtv + debts
        td = debt.sum()
        if td <= 0:
            break
        elig = (LT[i] > 0) & (coll > 0)
        hf = (coll[elig] * LT[i][elig]).sum() / td
        if hf >= 1.0 or not elig.any():
            break
        j = int(np.argmax(debt))
        k = int(np.argmax(np.where(elig, coll, -1.0)))
        if day.v33:
            partial = coll[k] >= 2000.0 and debt[j] >= 2000.0 and hf > 0.95
            repay = 0.5 * td if (partial and debt[j] > 0.5 * td) else debt[j]
        else:
            repay = (0.5 if hf > 0.95 else 1.0) * debt[j]
        lbk = LB[i][k]
        seized = repay * lbk
        if seized > coll[k]:
            seized = coll[k]
            repay = seized / lbk
        elif day.v33 and repay < debt[j] and (debt[j] - repay < 1000.0 or coll[k] - seized < 1000.0):
            repay = debt[j]
            seized = repay * lbk
            if seized > coll[k]:
                seized = coll[k]
                repay = seized / lbk
        fee = (seized - seized / lbk) * day.fee[k]
        profit = (seized - fee) - repay - GAS_ETH * eth_px
        if profit < 0 or repay <= 0:
            break
        # burn variable first, then stable
        rv = min(repay, debtv[j])
        SV[i, j] -= rv / (vix[j] * px[j])
        if repay > rv:
            SS[i, j] -= (repay - rv) / px[j]
        SA[i, k] -= seized / (inc[k] * px[k])
        SV[i, j] = max(SV[i, j], 0.0)
        SS[i, j] = max(SS[i, j], 0.0)
        SA[i, k] = max(SA[i, k], 0.0)
        allr += repay
        if j == usdc_k:
            usdc += repay
        calls += 1
    return usdc, allr, calls


def block_ts_lookup(work):
    m = A.jload(os.path.join(work, "rdu-block-ts.json.gz"))
    return dict(zip(m["block"], m["ts"]))


def real_liquidations(work, hourly_usdc_px):
    """Daily real USDC-debt liquidation volume (USD) and counts."""
    logs = A.jload(os.path.join(A.DATASETS, C1_LOGS))
    bts = block_ts_lookup(work)
    missing = []
    out = []
    for lg in logs["liquidations"]:
        if lg["debt"] != A.USDC:
            continue
        b = lg["block"]
        if b not in bts:
            missing.append(b)
        out.append(lg)
    fetched = {}
    if missing:
        pool = A.Pool()
        for b in sorted(set(missing)):
            fetched[b] = pool.pick().block_ts(b)
    hours_sorted = sorted(hourly_usdc_px)
    rows = []
    for lg in out:
        ts = bts.get(lg["block"], fetched.get(lg["block"]))
        h = ts // 3600 * 3600
        i = bisect.bisect_right(hours_sorted, h) - 1
        px = hourly_usdc_px[hours_sorted[max(i, 0)]]
        rows.append((ts, lg["debtToCover"] / 1e6 * px))
    return rows, len(set(missing))


def replay(work, out):
    metas = A.load_meta(work)
    days_all = sorted(metas)
    replay_days = [d for d in days_all if dt.date.fromisoformat(d) <= A.LAST_DAY]
    symbols = A.jload(os.path.join(work, "symbols.json.gz"))
    gl = sorted({a for m in metas.values() for a in m["assets"]})
    gidx = {a: k for k, a in enumerate(gl)}
    R = len(gl)
    usdc_k = gidx[A.USDC]
    weth = [a for a in gl if symbols.get(a) == "WETH"][0]
    weth_k = gidx[weth]
    dayobj = {}

    def D(d):
        if d not in dayobj:
            dayobj[d] = Day(metas[d], gidx)
        return dayobj[d]

    latest = {}          # id -> ((scaled collateral, variable debt, stable debt), e-mode)
    sim = {}
    vb0_errs = []
    per_day = []
    hourly_usdc_px = {}
    for d in replay_days:
        pos = A.jload(os.path.join(work, "positions", f"{d}.json.gz"))
        day = D(d)
        for sid, acc in pos["accounts"].items():
            latest[int(sid)] = (acct_arrays(acc, gidx, R, day), acc["emode"] or 0)
            # V-B0 on fresh reads
            hf_chain = int(acc["hf"]) / 1e18
            if acc["td"] > 0 and hf_chain < VB0_HF_MAX:
                lt, _ = day.eff(acc["emode"])
                sa, sv, ss = latest[int(sid)][0]
                coll = sa * day.inc0 * day.price0
                debt = (sv * day.vix0 + ss) * day.price0
                if debt.sum() > 0:
                    hf_m = (coll * lt).sum() / debt.sum()
                    err = abs(hf_m / hf_chain - 1)
                    vb0_errs.append(err)
        uni = pos["universe"]
        ids = [x for x in uni if x in latest]
        n = len(ids)
        SA, SV, SS = np.zeros((n, R)), np.zeros((n, R)), np.zeros((n, R))
        LT, LB = np.zeros((n, R)), np.ones((n, R))
        cache = {}
        for r_i, x in enumerate(ids):
            (sa, sv, ss), em = latest[x]
            SA[r_i], SV[r_i], SS[r_i] = sa, sv, ss
            if em not in cache:
                cache[em] = day.eff(em)
            LT[r_i], LB[r_i] = cache[em]
        hpath = os.path.join(work, "hourly", f"{d}.json.gz")
        hrows = A.jload(hpath)["rows"] if os.path.exists(hpath) else []
        hk = {r["hour"]: r for r in hrows}
        t0 = A.utc(dt.date.fromisoformat(d))
        prev = None
        vol_usdc, vol_all, ncalls = 0.0, 0.0, 0
        for hh in range(24):
            h = t0 + 3600 * hh
            r = hk.get(h)
            if r is not None:
                px = np.zeros(R)
                inc = np.ones(R)
                vix = np.ones(R)
                for j, a in enumerate(metas[d]["assets"]):
                    k = gidx[a]
                    px[k] = (r["prices"][j] or 0) / 1e8
                    inc[k] = int(r["income"][j]) / RAY if r["income"][j] not in (None, "None") else day.inc0[k]
                    vix[k] = int(r["vindex"][j]) / RAY if r["vindex"][j] not in (None, "None") else day.vix0[k]
                prev = (px, inc, vix)
            elif prev is None:
                prev = (day.price0.copy(), day.inc0.copy(), day.vix0.copy())
            px, inc, vix = prev
            hourly_usdc_px[h] = px[usdc_k]
            if n == 0:
                continue
            coll = SA * (inc * px)
            debt = SV * (vix * px) + SS * px
            td = debt.sum(axis=1)
            num = (coll * LT).sum(axis=1)
            with np.errstate(divide="ignore", invalid="ignore"):
                hf = np.where(td > 0, num / np.where(td > 0, td, 1), np.inf)
            for i in np.nonzero(hf < 1.0)[0]:
                uu, aa, cc = liquidate_account(int(i), SA, SV, SS, LT, LB, day, px, inc, vix, px[weth_k], usdc_k)
                vol_usdc += uu
                vol_all += aa
                ncalls += cc
        sim[d] = vol_usdc
        per_day.append({"date": d, "sim_usdc_usd": vol_usdc, "sim_all_usd": vol_all, "sim_calls": ncalls,
                        "universe": n, "fresh_reads": len(pos["accounts"]), "scan_day": pos["scan"]})
    errs = np.array(vb0_errs)
    vb0 = {"n_account_days": int(len(errs)), "share_within_0p1pct": float(np.mean(errs <= VB0_TOL)) if len(errs) else None,
           "rel_err_q50_q99_max": [float(np.quantile(errs, q)) for q in (0.5, 0.99, 1.0)] if len(errs) else None}
    vb0["pass"] = bool(len(errs) and vb0["share_within_0p1pct"] >= VB0_SHARE)
    # real volume
    rows, n_fetched = real_liquidations(work, hourly_usdc_px)
    real = {d: 0.0 for d in replay_days}
    nreal = {d: 0 for d in replay_days}
    for ts, usd in rows:
        d = dt.datetime.fromtimestamp(ts, dt.timezone.utc).date().isoformat()
        if d in real:
            real[d] += usd
            nreal[d] += 1
    for p in per_day:
        p["real_usdc_usd"] = real[p["date"]]
        p["real_events"] = nreal[p["date"]]
    x = np.array([sim[d] for d in replay_days])
    y = np.array([real[d] for d in replay_days])
    rho = float(spearmanr(x, y).correlation)
    pos_days = y > 0
    rho_pos = float(spearmanr(x[pos_days], y[pos_days]).correlation) if pos_days.sum() > 2 else None
    x3 = np.convolve(x, np.ones(3), "valid")
    y3 = np.convolve(y, np.ones(3), "valid")
    rho72 = float(spearmanr(x3, y3).correlation)
    top = np.argsort(-y)[:10]
    ratio_top10 = float(x[top].sum() / y[top].sum()) if y[top].sum() > 0 else None
    rx = spearman_ranks(x)
    ry = spearman_ranks(y)
    gaps = np.argsort(-np.abs(rx - ry))[:20]
    res = {"days": len(replay_days), "first_day": replay_days[0], "last_day": replay_days[-1],
           "real_events": int(sum(nreal.values())), "real_total_usd": float(y.sum()), "sim_total_usd": float(x.sum()),
           "days_real_positive": int(pos_days.sum()), "days_sim_positive": int((x > 0).sum()),
           "spearman_daily": rho, "pass_spearman": bool(rho >= PASS_SPEARMAN), "V_B0": vb0,
           "pass": bool(vb0["pass"] and rho >= PASS_SPEARMAN),
           "reported": {"spearman_real_positive_days": rho_pos, "spearman_72h_sums": rho72,
                        "pearson_log1p_daily": float(pearsonr(np.log1p(x), np.log1p(y))[0]),
                        "sim_over_real_top10_real_days": ratio_top10,
                        "top10_real_days": [{"date": replay_days[i], "real": float(y[i]), "sim": float(x[i])} for i in top],
                        "largest_rank_gaps": [{"date": replay_days[i], "real": float(y[i]), "sim": float(x[i])} for i in gaps],
                        "emode_categories_with_price_source": sorted({c for m in metas.values() for c, e in m["emode"].items()
                                                                      if e.get("price_source")}),
                        "liquidation_blocks_ts_fetched": n_fetched}}
    with open(os.path.join(out, "liq-daily.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(per_day[0]))
        w.writeheader()
        w.writerows(per_day)
    return res, replay_days, y


def spearman_ranks(v):
    from scipy.stats import rankdata
    return rankdata(v)


# ---------------------------------------------------------------------------------------------
# R10.1C counts
# ---------------------------------------------------------------------------------------------

def counts(replay_days, y):
    dates = [dt.date.fromisoformat(d) for d in replay_days]
    out = {"thresholds_usd": THRESHOLDS, "windows": {}}
    rec = {}
    for wname, k in WINDOWS.items():
        origins = dates[: len(dates) - k + 1]
        vol = np.convolve(y, np.ones(k), "valid")
        sets = {
            "all": [True] * len(origins),
            "r102_scoring": [SCORE_FIRST <= d <= SCORE_LAST and not (d <= Q2[1] and d + dt.timedelta(days=k - 1) >= Q2[0])
                             for d in origins],
            "q2_2026": [Q2[0] <= d <= Q2[1] for d in origins],
        }
        tab = {}
        for X in THRESHOLDS:
            pos = vol > X
            row = {}
            for sname, mask in sets.items():
                pdates = [d for d, p, m in zip(origins, pos, mask) if p and m]
                ep = 0
                last = None
                for d in pdates:
                    if last is None or (d - last).days >= EPISODE_GAP_DAYS:
                        ep += 1
                    last = d
                row[sname] = {"origins": int(sum(mask)), "positive": len(pdates), "episodes": ep}
            tab[str(X)] = row
        qual = [X for X in THRESHOLDS if tab[str(X)]["r102_scoring"]["positive"] >= MIN_POS]
        rec[wname] = sorted(qual)[-3:]
        out["windows"][wname] = tab
    out["r102_thresholds"] = rec
    out["rule"] = "per window, the 3 largest X with >= 40 positive origins in the R10.2 scoring origins"
    return out


# ---------------------------------------------------------------------------------------------

def frozen_config(work):
    sha, dirty = git_sha()
    inputs = {
        "hours.json.gz": sha256_file(os.path.join(work, "hours.json.gz")),
        "rdu-block-ts.json.gz": sha256_file(os.path.join(work, "rdu-block-ts.json.gz")),
        "anchors.json.gz": sha256_file(os.path.join(work, "anchors.json.gz")),
        "symbols.json.gz": sha256_file(os.path.join(work, "symbols.json.gz")),
        "action-users.json.gz": sha256_file(os.path.join(work, "action-users.json.gz")),
        "meta/": dir_digest(os.path.join(work, "meta")),
        "hourly/": dir_digest(os.path.join(work, "hourly")),
        "positions/": dir_digest(os.path.join(work, "positions")),
        "datasets:" + C1_LOGS: sha256_file(os.path.join(A.DATASETS, C1_LOGS)),
    }
    code = {n: sha256_file(os.path.join(HERE, n)) for n in ("r10_mechanics.py", "r10_acquire.py")}
    return {"prereg": "membrane-board design/Q26_ROUND10_PREREG.md (registered 9415d1a)", "item": "R10.1",
            "code_commit": sha, "code_dirty": dirty, "code_sha256": code, "inputs_sha256": inputs,
            "constants": {"tol_apr": TOL_APR, "pass_share": PASS_SHARE, "pass_spearman": PASS_SPEARMAN, "vb0_tol": VB0_TOL,
                          "vb0_hf_max": VB0_HF_MAX, "vb0_share": VB0_SHARE, "max_calls": MAX_CALLS, "gas_eth": GAS_ETH,
                          "thresholds": THRESHOLDS, "windows": WINDOWS, "min_pos": MIN_POS,
                          "score_first": SCORE_FIRST.isoformat(), "score_last": SCORE_LAST.isoformat(),
                          "q2": [Q2[0].isoformat(), Q2[1].isoformat()], "episode_gap_days": EPISODE_GAP_DAYS,
                          "first_day": A.FIRST_DAY.isoformat(), "last_day": A.LAST_DAY.isoformat()},
            "decisions": DECISIONS, "seeds": "none (no randomness)"}


def guard(out):
    for name in os.listdir(out):
        p = os.path.join(out, name)
        data = gzip.open(p, "rb").read() if name.endswith(".gz") else open(p, "rb").read()
        if ADDR_RE.search(data.decode("utf-8", "replace")):
            raise SystemExit(f"address guard: {name} holds a 0x+40-hex string")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["freeze", "run"])
    ap.add_argument("--work", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    fpath = os.path.join(a.out, "frozen-r101.json")
    if a.cmd == "freeze":
        if os.path.exists(fpath):
            raise SystemExit("frozen config exists; not rewritten")
        cfg = frozen_config(a.work)
        with open(fpath, "w") as f:
            json.dump(cfg, f, indent=1, sort_keys=True)
        print(f"frozen {fpath} sha256 {sha256_file(fpath)}")
        return
    cfg = json.load(open(fpath))
    now = frozen_config(a.work)
    for key in ("code_commit", "code_sha256", "inputs_sha256", "constants"):
        if cfg[key] != now[key]:
            raise SystemExit(f"frozen config mismatch on {key}")
    ga = gate_a(a.work, a.out)
    print(f"gate A: borrow {ga['share_borrow_within_2bp']:.5f} supply {ga['share_supply_within_2bp']:.5f} pass {ga['pass']}", flush=True)
    gb, days, y = replay(a.work, a.out)
    print(f"gate B: spearman {gb['spearman_daily']:.4f} V-B0 {gb['V_B0']} pass {gb['pass']}", flush=True)
    gc = counts(days, y)
    res = {"frozen_sha256": sha256_file(fpath), "gate_A": ga, "gate_B": gb, "counts": gc,
           "gate_pass": bool(ga["pass"] and gb["pass"]),
           "downstream": {"R10.2_runs": bool(gb["pass"]), "R10.3_runs": bool(ga["pass"]), "R10.4_runs": bool(ga["pass"])}}
    with open(os.path.join(a.out, "r101-results.json"), "w") as f:
        json.dump(res, f, indent=1, sort_keys=True, default=float)
    guard(a.out)
    print(json.dumps({"gate_pass": res["gate_pass"], "r102_thresholds": gc["r102_thresholds"]}))


if __name__ == "__main__":
    main()
