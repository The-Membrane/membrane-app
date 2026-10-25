#!/usr/bin/env python3
"""Q26 R11.1-mf item 2: episode repay excess on the Polygon v5 development run (post hoc, development data).

The v5 episode check (r111v3_engine.Replay._end_episode) sums simulated repay in USD between two borrower actions and
divides by the account's total debt in USD at the first simulated call of the episode. 30 of 6,804 Polygon episodes
exceed 1.01 (D-R11.1v). The stated cause (not verified) is USD revaluation of volatile debt inside an episode.

This script reruns the unchanged v5 engine on Polygon (development data, grade B) in calendar segments with the
window method (real state at 00:00Z of the segment's first day, empty overlay; r111v5_gate.cmd_window), with two
read-only hooks:
  - r111v3_engine.liquidate is wrapped: for every call-producing evaluation it logs the account's pre-call debt per
    reserve in token units and the oracle prices, and each call's repay in USD and in token units (repay / price);
  - Replay._end_episode is wrapped: it logs the episode close with the engine's own debt0 and repay sum.
Neither hook changes any value the engine computes. The segment's daily simulated USDC volume is compared to the
published development series to the cent, so a segment that departs from the scored path is visible.

Output: per-episode aggregates (no account, no address): engine ratio, ratio with every repay revalued at the
first-call prices, per-reserve token-unit ratio, duration, the debt reserves' price change, and calls. Nothing is
published from Avalanche.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import pickle
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import r111v3_engine as E  # noqa: E402
import r111v3_gate as G  # noqa: E402
import r111v4_gate as V  # noqa: E402
import r111v4_diag as DG  # noqa: E402
import r111v5_gate as F  # noqa: E402

LOG = []
_orig_liq = E.liquidate


def liq_hook(u, st, ov, t, px, Lt, Vt, inv_unit, lt, lb, day, cost_usd, dust_usd, usdc_set, blocked=False):
    sv_u = np.maximum(st.SV[u] - ov[1], 0.0) * Vt * inv_unit
    ss_u = np.maximum(E.stable_value(st.SP[u], st.SR[u], st.ST[u], t) - ov[2], 0.0) * inv_unit
    calls, reason = _orig_liq(u, st, ov, t, px, Lt, Vt, inv_unit, lt, lb, day, cost_usd, dust_usd, usdc_set, blocked)
    if calls:
        units = sv_u + ss_u
        nz = np.nonzero(units > 0)[0]
        LOG.append(("call", int(u), int(t), {int(j): (float(units[j]), float(px[j])) for j in nz},
                    [(float(c[0]), int(c[1]), float(c[0] / px[c[1]]) if px[c[1]] > 0 else float("nan"), bool(c[2]))
                     for c in calls]))
    return calls, reason


class EpReplay(DG.WinReplay):
    def _end_episode(self, u):
        e = self.ep.get(u)
        if e is not None:
            LOG.append(("end", int(u), float(e[0]), float(e[1])))
        super()._end_episode(u)


def summarize(log, symbols, usdc_k):
    open_, eps = {}, []
    for rec in log:
        if rec[0] == "call":
            _, u, t, pre, calls = rec
            if u not in open_:
                open_[u] = {"t0": t, "t1": t, "pre0": pre, "debt0_usd_hook": sum(a * p for a, p in pre.values()),
                            "rep_usd": 0.0, "rep_units": {}, "px_last": {}, "n_calls": 0, "usdc_calls": 0}
            e = open_[u]
            e["t1"] = t
            for usd, j, un, is_u in calls:
                e["rep_usd"] += usd
                e["rep_units"][j] = e["rep_units"].get(j, 0.0) + un
                e["n_calls"] += 1
                e["usdc_calls"] += int(is_u)
            for j, (a, p) in pre.items():
                e["px_last"][j] = p
        else:
            _, u, debt0, rep = rec
            e = open_.pop(u, None)
            if e is None:
                continue
            pre0 = e["pre0"]
            # every repay revalued at the first-call price of its reserve
            rep_px0 = sum(un * pre0.get(j, (0.0, np.nan))[1] for j, un in e["rep_units"].items())
            unit_ratio = {j: (un / pre0[j][0] if j in pre0 and pre0[j][0] > 0 else None) for j, un in e["rep_units"].items()}
            px_chg = {j: (e["px_last"].get(j, p0) / p0 - 1 if p0 > 0 else None) for j, (a0, p0) in pre0.items()}
            w = {j: a * p for j, (a, p) in pre0.items()}
            tot = sum(w.values()) or 1.0
            eps.append({"ratio_engine": rep / debt0 if debt0 > 0 else None, "debt0_usd": debt0, "repay_usd": rep,
                        "debt0_hook_rel_diff": abs(e["debt0_usd_hook"] - debt0) / debt0 if debt0 > 0 else None,
                        "repay_hook_rel_diff": abs(e["rep_usd"] - rep) / rep if rep > 0 else None,
                        "ratio_at_first_call_prices": rep_px0 / debt0 if debt0 > 0 else None,
                        "max_unit_ratio_per_reserve": max([v for v in unit_ratio.values() if v is not None], default=None),
                        "unit_ratio_by_symbol": {symbols[j]: v for j, v in unit_ratio.items()},
                        "debt_mix_usd_share": {symbols[j]: w[j] / tot for j in w},
                        "debt_price_change_first_to_last_call": {symbols[j]: v for j, v in px_chg.items()},
                        "repaid_reserve_not_in_debt0": [symbols[j] for j in e["rep_units"] if j not in pre0],
                        "usdc_only_debt": all(j in usdc_k for j in pre0),
                        "duration_h": (e["t1"] - e["t0"]) / 3600, "n_calls": e["n_calls"], "usdc_calls": e["usdc_calls"],
                        "first_call_day": dt.datetime.fromtimestamp(e["t0"], dt.timezone.utc).date().isoformat()})
    return eps


def cmd_seg(a):
    rule = json.load(open(a.rule))
    inp, metas, hours, liq, cm = F.load(a.mk, a.work)
    E.liquidate = liq_hook
    # same state construction as r111v5_gate.cmd_window
    t0 = int(dt.datetime.fromisoformat(a.start).replace(tzinfo=dt.timezone.utc).timestamp())
    i0 = next(i for i, h in enumerate(hours) if h["hour"] >= t0)
    K0 = hours[i0]["block"] * 1_000_000 + 999_999
    st, n_tok, n_f, n_e = DG.state_at(inp, K0)
    ora = inp.ora
    n_o = int(np.searchsorted(ora["key"], K0, side="right"))
    last = np.full(len(inp.aggs), -1, dtype=np.int64)
    np.maximum.at(last, ora["agg"][:n_o].astype(np.int64), np.arange(n_o, dtype=np.int64))
    A = np.full(len(inp.aggs), np.nan)
    ok = last >= 0
    A[ok] = ora["answer"][last[ok]]
    for g in inp.seq_aggs:
        A[g] = np.nan
    idx = E.Indexes(inp)
    idx.advance(K0)
    usdc = [inp.gidx[x] for x in V.MK[a.mk]["usdc"]]
    usdc_debt = (st.SV[:, usdc] > 0.5).any(axis=1) | (st.SP[:, usdc] > 0.5).any(axis=1)
    n_c = int(np.searchsorted(np.array([m["block"] * 1_000_000 + 999_998 for m in cm], dtype=np.int64), K0, side="right"))
    pos_h0 = n_tok + n_f + n_e + n_o + i0 + n_c
    prev_day = (dt.date.fromisoformat(a.start) - dt.timedelta(days=1)).isoformat()
    S_ = {"n": pos_h0 - 1, "hour_pos": i0, "st": {k: getattr(st, k) for k in ("SA", "SV", "SP", "SR", "ST", "FL", "EM")},
          "idx": {k: getattr(idx, k) for k in ("L0", "V0", "lr", "vr", "t0", "ptr")},
          "A": A, "A_h": A.copy(), "px": np.zeros(inp.R), "px_h": np.zeros(inp.R), "cand": np.zeros(0, dtype=np.int64),
          "overlay": {}, "usdc_debt": usdc_debt, "cost_usd": 0.0, "cur_day": prev_day, "sim": {},
          "rec": {"calls": [], "hours": 0, "evals": 0, "cand_sizes": []}, "started": True, "seq_down": False,
          "seq_up_ts": -1e18, "sentinel": {"present": False, "grace": 0}, "cpos": {}, "dirty": set(), "C": None,
          "ep": {}, "episodes": {"n": 0, "viol_1pct": 0, "max_ratio": 0.0, "sum_repay_usd": 0.0, "viol_repay_usd": 0.0},
          "conf_pos": None}
    os.makedirs(a.out, exist_ok=True)
    ck = os.path.join(a.out, "seg-state.pkl")
    with open(ck, "wb") as f:
        pickle.dump(S_, f, protocol=pickle.HIGHEST_PROTOCOL)
    del S_, st
    os.environ["R111_CK_EVERY"] = "1e12"
    rp = F.mk_replay(a.mk, inp, metas, hours, rule, liq, cm, record=False, v5=True, cls=EpReplay, end_day=a.end)
    rp.checkpoint = ck
    t_start = G.utcnow()
    try:
        rp.run()
        sim = rp.sim
    except DG.Stop:
        sim = rp.sim_out
    os.remove(ck)
    for u in list(rp.ep):
        rp._end_episode(u)
    usdc_k = set(usdc)
    eps = summarize(LOG, inp.symbols, usdc_k)
    res = {"segment": [a.start, a.end], "utc_start": t_start, "utc_end": G.utcnow(), "code_sha": G.git_sha()[0],
           "engine_episodes": rp.episodes, "sim_by_day": {k: round(v, 2) for k, v in sorted(sim.items())},
           "episodes": eps}
    G.jdump(os.path.join(a.out, "episodes-seg.json"), res)
    print(json.dumps({"segment": res["segment"], "engine_episodes": rp.episodes, "n_eps": len(eps)}), flush=True)


def cmd_report(a):
    import csv
    segs = [json.load(open(p)) for p in a.segs]
    pub = {r["date"]: float(r["sim_usdc_usd"]) for r in csv.DictReader(open(a.published))}
    days_ok, days_bad = 0, []
    for s in segs:
        d0, d1 = s["segment"]
        for d, v in pub.items():
            if d0 <= d <= d1:
                got = s["sim_by_day"].get(d, 0.0)
                if abs(got - v) <= 0.011:
                    days_ok += 1
                else:
                    days_bad.append({"date": d, "published": v, "segment": got})
    eps = [e for s in segs for e in s["episodes"]]
    viol = [e for e in eps if e["ratio_engine"] is not None and e["ratio_engine"] > 1.01]
    tot = {"n": sum(s["engine_episodes"]["n"] for s in segs), "viol_1pct": sum(s["engine_episodes"]["viol_1pct"] for s in segs),
           "sum_repay_usd": sum(s["engine_episodes"]["sum_repay_usd"] for s in segs),
           "viol_repay_usd": sum(s["engine_episodes"]["viol_repay_usd"] for s in segs),
           "max_ratio": max(s["engine_episodes"]["max_ratio"] for s in segs)}
    hook_ok = max([e["debt0_hook_rel_diff"] or 0 for e in eps] + [e["repay_hook_rel_diff"] or 0 for e in eps])

    def cls(e):
        r0 = e["ratio_at_first_call_prices"]
        mu = e["max_unit_ratio_per_reserve"]
        if e["repaid_reserve_not_in_debt0"]:
            return "repaid reserve absent at first call"
        if mu is not None and mu > 1.01:
            return "token units exceed first-call debt by > 1% (interest or engine)"
        if r0 is not None and r0 <= 1.01:
            return "price revaluation only (<= 1.01 at first-call prices)"
        return "other"
    # interest bound: a reserve's token-unit repay over the episode cannot exceed its first-call debt times the growth
    # of its variable-debt index from the first to the last call (daily anchor vindex; the last-call day is taken one
    # day late so the bound is not tightened by the daily grid)
    metas, sym2a = {}, {}
    if a.work:
        rs = F.jl(os.path.join(a.work, "reserves.json.gz"))["reserves"]
        sym2a = {r["symbol"]: r["asset"] for r in rs}

        def vidx(day, sym):
            if day not in metas:
                pth = os.path.join(a.work, "meta", f"{day}.json.gz")
                metas[day] = F.jl(pth)["reserves"] if os.path.exists(pth) else {}
            r = metas[day].get(sym2a.get(sym))
            return int(r["vindex"]) / 1e27 if r and r.get("vindex") else None
    for e in viol:
        e["cause_class"] = cls(e)
        if a.work:
            d0 = e["first_call_day"]
            d1 = (dt.date.fromisoformat(d0) + dt.timedelta(hours=e["duration_h"] + 24)).isoformat()
            ib = {}
            for sname, ur in e["unit_ratio_by_symbol"].items():
                v0, v1 = vidx(d0, sname), vidx(d1, sname)
                g = v1 / v0 if v0 and v1 else None
                ib[sname] = {"unit_ratio": ur, "vindex_growth_first_to_last_call": g,
                             "within_interest_bound": None if g is None or ur is None else bool(ur <= g * (1 + 1e-6))}
            e["interest_bound"] = ib
            e["all_within_interest_bound"] = all(v["within_interest_bound"] for v in ib.values()
                                                 if v["within_interest_bound"] is not None)
    by = {}
    for e in viol:
        by[e["cause_class"]] = by.get(e["cause_class"], 0) + 1
    res = {"item": "Q26 R11.1-mf item 2: episode repay excess, Polygon v5 development run (post hoc, development data)",
           "utc_created": G.utcnow(), "code_sha": G.git_sha()[0],
           "path_check": {"days_equal_to_published_to_the_cent": days_ok, "days_differing": days_bad},
           "published_dev_engine_episodes": json.load(open(a.published_json))["engine"]["episodes"],
           "segments_engine_episodes": tot, "hook_max_rel_diff_vs_engine": hook_ok,
           "violations": len(viol), "violations_by_cause": by,
           "violations_within_interest_bound": sum(1 for e in viol if e.get("all_within_interest_bound")),
           "violations_usdc_or_stable_only_debt": sum(1 for e in viol if e["usdc_only_debt"]),
           "violations_detail": sorted(viol, key=lambda e: -e["ratio_engine"]),
           "all_episodes_ratio_at_first_call_prices_max": max(e["ratio_at_first_call_prices"] or 0 for e in eps),
           "all_episodes_max_unit_ratio": max(e["max_unit_ratio_per_reserve"] or 0 for e in eps),
           "episodes_unit_ratio_gt_1p01": sum(1 for e in eps if (e["max_unit_ratio_per_reserve"] or 0) > 1.01)}
    G.jdump(a.out, res)
    print(json.dumps({k: res[k] for k in ("path_check", "published_dev_engine_episodes", "segments_engine_episodes",
                                          "hook_max_rel_diff_vs_engine", "violations", "violations_by_cause",
                                          "violations_within_interest_bound", "violations_usdc_or_stable_only_debt",
                                          "all_episodes_ratio_at_first_call_prices_max", "all_episodes_max_unit_ratio",
                                          "episodes_unit_ratio_gt_1p01")}, indent=1, default=str))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd")
    for k in ("mk", "work", "rule", "start", "end", "out", "published", "published_json"):  # noqa: B007
        ap.add_argument(f"--{k}")
    ap.add_argument("--segs", nargs="*")
    a = ap.parse_args()
    {"seg": cmd_seg, "report": cmd_report}[a.cmd](a)


if __name__ == "__main__":
    main()
