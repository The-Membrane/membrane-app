"""Q26 R11.1-v5 engine checks and gate runs (membrane-board design/Q26_ROUND11_PREREG.md D-R11.1q onward).

v5 = the R11.1-v3/v4 engine (r111v3_engine.py) with Replay(v5=True): F1 (the overlay survives the account's own real
liquidation rows and is debited by them; borrower actions clear it) and F2 (configuration by configurator block).
The liquidation rule (D-R11.1e), the cost and dust readings and the candidate screen are unchanged.

  python3 r111v5_gate.py window --mk MK --work WORK --rule RULE --start D --end D --out OUT [--v4]
      Windowed replay from real state at the first hourly read of --start (r111v4_diag.state_at), to the end of --end.
      Writes OUT/win.pkl (scratch only: account ids) and prints address-free per-day sums.
  python3 r111v5_gate.py kar --win OUT [OUT ...]
      Known-answer replay (r111v4_diag.cmd_kar) on v5 windows.
  python3 r111v5_gate.py devrun --mk poly --work WORK --rule RULE --frozen V4FROZEN --out OUT --scratch CK [--resume]
      Full Polygon replay with v5 (development data, D-R11.1p) and the v4 gate statistics as a development reading.
  python3 r111v5_gate.py counts / freeze / run   (blind chain, D-R11.1r)
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import gzip
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


def jl(p):
    with gzip.open(p, "rt") as f:
        return json.load(f)


# R11.1-v5 blind chain SV2-L (D-R11.1r)
V.MK["avax"] = {"chain": "avalanche", "usdc": ["0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e"],
                "gas": "0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7",                      # WAVAX
                "pd_assets": ["0x49d5c2bdffac6ce2bfdb6640f4f80f226bc10bab",              # WETH.e
                              "0x50b7545627a5162f82a992c33b87adc75187b218"],             # WBTC.e
                "pd_assets_reported": ["0x49d5c2bdffac6ce2bfdb6640f4f80f226bc10bab",
                                       "0x50b7545627a5162f82a992c33b87adc75187b218",
                                       "0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7"],
                "first": dt.date(2022, 3, 15), "last": dt.date(2026, 9, 30)}


def cmd_counts(a):
    """Counts only (D-R11.1r): USDC-debt LiquidationCall events and event days on gate days. Reads the debt reserve
    and the timestamp of each locked row; no amount is decoded or printed."""
    rows = jl(os.path.join(a.work, "liq-LOCKED.json.gz"))["rows"]
    usdc = set(V.MK[a.mk]["usdc"])
    gd = set(V.mk_days(a.mk))
    allq = set(V.mk_days(a.mk, True))
    evd = [dt.datetime.fromtimestamp(r["ts"], dt.timezone.utc).date().isoformat() for r in rows if r["debt"] in usdc]
    res = {"stage": f"counts-only ({a.mk})", "liquidation_logs_all": len(rows), "usdc_debt_events_all": len(evd),
           "non_positive_ts": sum(1 for r in rows if not r["ts"] or r["ts"] <= 0),
           "gate_days": len(gd), "q2_days_reported_only": len(allq) - len(gd),
           "usdc_debt_events_on_gate_days": sum(1 for d in evd if d in gd),
           "gate_days_with_a_usdc_debt_event": len(set(evd) & gd),
           "event_day_share": len(set(evd) & gd) / len(gd), "utc": G.utcnow()}
    os.makedirs(a.out, exist_ok=True)
    G.jdump(os.path.join(a.out, f"counts-{a.mk}.json"), res)
    print(json.dumps(res, indent=1))


def cmd_keys(a):
    """F1 key file for a blind chain: (block, log index, account) of every LiquidationCall row; nothing else is kept."""
    rows = jl(os.path.join(a.work, "liq-LOCKED.json.gz"))["rows"]
    keys = [{"block": r["block"], "log_index": r["log_index"], "user": r["user"]} for r in rows]
    # scratch only (locked work directory, never published): holds account addresses, so G.jdump's guard is bypassed
    with gzip.open(os.path.join(a.work, "liq-keys.json.gz"), "wt") as f:
        json.dump({"rows": keys}, f)
    print(json.dumps({"keys": len(keys)}))


READINGS_AVAX = {
    "P-1": "Subject: LiquidationCall with debt native USDC (the market's only USDC reserve) on Aave V3 Avalanche; USD = "
           "debtToCover / 1e6 x the reserve's oracle price at the hourly read of the hour holding the block timestamp; "
           "UTC day of the block timestamp.",
    "P-2": "Gate days 2022-03-15..2026-09-30 minus 2025-10-10/11; 2026Q2 reported only.",
    "P-3": "Thresholds X in {0.5M, 1M, 2.5M} x (USDC total debt at the day's anchor, USD) / 530,255,152.",
    "P-4": "Sim class = v5 daily simulated USDC-debt repay >= X; E = real on the previous calendar day >= X; PD = max over "
           "WETH.e and WBTC.e of the 24 h drawdown of the hourly oracle price ending in the day >= x_pd (6%); "
           "probabilities: online class frequency, prior = Polygon v5 development frequencies (10 pseudo-days).",
    "P-5": "Classifier pass: per threshold H >= 0.60 and J > J_E; mean J > mean J_PD; pooled Brier DM (NW lag 7, HLN, "
           "one-sided) p < 0.05 vs climatology, E and PD.",
    "P-6": "Magnitude gate: Spearman (days max >= $10k) >= 0.50 and > E-rank; USD-weighted abs log error < E; sim/real in "
           "[0.5, 2]; sim <= USDC total debt every gate day (before the outcome read).",
    "P-7": "Cost: (hour base fee + 1 gwei priority) x 686,675 gas x WAVAX price; no builder payment; dust $6.43 gross bonus. "
           "PriceOracleSentinel from the walks.",
    "P-8": "b_h = the last held event block with header timestamp < h; daily anchor = the same rule at 00:00Z. Engine v5 "
           "(F1 key file, F2 configurator metas).",
}


def cmd_integrity(a):
    """D-R11.1r integrity (inputs only): the v4 checks (r111v4_gate.cmd_integrity) plus configurator timestamps and
    AnswerUpdated updatedAt vs block headers on a seeded sample."""
    import r111v3_rpc as X
    V.cmd_integrity(a)
    res = json.load(open(os.path.join(a.out, "integrity.json")))
    cm = conf_metas(a.work)
    ev = jl(os.path.join(a.work, "conf-events.json.gz"))["rows"]
    inp = E.Inputs(a.work)
    inp.load_oracle()
    rng = np.random.default_rng(20261024)
    pick = rng.choice(len(inp.ora["ts"]), size=min(300, len(inp.ora["ts"])), replace=False)
    cl = X.Client(V.MK[a.mk]["chain"], interval=0.2)
    keys = inp.ora["key"][pick]
    bad = 0
    for k, t in zip(keys.tolist(), inp.ora["ts"][pick].tolist()):
        if cl.header_ts(int(k // 1_000_000)) != int(t):
            bad += 1
    res["v5_extra"] = {"conf_logs": len(ev), "conf_blocks": len(cm),
                       "conf_non_positive_ts": sum(1 for r in ev if r["ts"] <= 0) + sum(1 for m in cm if m["ts"] <= 0),
                       "answer_updated_ts_vs_header_sample": len(pick), "answer_updated_ts_mismatch": bad}
    res["pass"] = bool(res["pass"] and res["v5_extra"]["conf_non_positive_ts"] == 0 and bad == 0)
    G.jdump(os.path.join(a.out, "integrity.json"), res)
    print(json.dumps({"v5_extra": res["v5_extra"], "pass": res["pass"]}))


def cmd_freeze(a):
    sha, dirty = G.git_sha()
    if dirty:
        raise SystemExit("worktree dirty: freeze from a clean committed checkout")
    path = os.path.join(a.out, f"frozen-r111v5-{a.mk}.json")
    if os.path.exists(path):
        raise SystemExit("frozen config exists")
    integ = json.load(open(os.path.join(a.integrity, "integrity.json")))
    if not integ["pass"]:
        raise SystemExit("integrity checks did not pass: no freeze")
    pw = json.load(open(a.power))
    v4f = json.load(open(a.frozen))
    cfg = {"item": "Q26 R11.1-v5 blind gate on Aave V3 Avalanche USDC debt (SV2-L; design/Q26_ROUND11_PREREG.md D-R11.1r)",
           "code_sha": sha, "utc_created": G.utcnow(), "rule": json.load(open(a.rule)), "priors": pw["priors_for_blind"],
           "x_pd": v4f["x_pd"], "pd_assets": ["WETH.e", "WBTC.e"], "power": pw["power"],
           "power_sha256": G.sha256_file(a.power), "integrity_sha256": G.sha256_file(os.path.join(a.integrity, "integrity.json")),
           "thresholds_core": G.THRESH_CORE, "ref_core_usdc_debt": G.REF_CORE_DEBT, "prior_pseudo_days": G.PRIOR_A,
           "nw_lag": G.NW_LAG, "cand_hf": E.CAND_HF, "magnitude_bars": V.MAG, "gate_days": len(V.mk_days(a.mk)),
           "exclude": sorted(V.EXCLUDE), "readings": READINGS_AVAX, "engine": "r111v3_engine.Replay(v5=True)",
           "inputs_sha256": G.l1_input_digests(a.work),
           "v5_inputs_sha256": {n: G.sha256_file(os.path.join(a.work, n)) for n in ("conf-events.json.gz", "liq-keys.json.gz")},
           "meta_conf_digest": G.dir_digest(os.path.join(a.work, "meta-conf"))}
    os.makedirs(a.out, exist_ok=True)
    G.jdump(path, cfg)
    print(json.dumps({"frozen": path, "sha256": G.sha256_file(path), "utc_created": cfg["utc_created"], "code_sha": sha}))


def cmd_run(a):
    """One blind run (D-R11.1r). The simulation reads the F1 key file only; the locked outcome file is opened after
    the simulation and the volume <= debt bound."""
    t0 = G.utcnow()
    path = os.path.join(a.out, f"frozen-r111v5-{a.mk}.json")
    cfg = json.load(open(path))
    sha, dirty = G.git_sha()
    if dirty or sha != cfg["code_sha"]:
        raise SystemExit(f"code {sha} dirty={dirty} != frozen {cfg['code_sha']}")
    if cfg["power"] < 0.80:
        raise SystemExit("power < 0.80: no blind run (D-R11.1r)")
    started = os.path.join(a.out, "run-started")
    if os.path.exists(os.path.join(a.out, "r111v5-results.json")):
        raise SystemExit("one run only: results exist")
    if os.path.exists(started) and not a.resume:
        raise SystemExit("one run only: a started marker exists (continue it with --resume)")
    if a.resume and not os.path.exists(started):
        raise SystemExit("--resume without a started run")
    if G.l1_input_digests(a.work) != cfg["inputs_sha256"] or any(
            G.sha256_file(os.path.join(a.work, n)) != v for n, v in cfg["v5_inputs_sha256"].items()) or (
            G.dir_digest(os.path.join(a.work, "meta-conf")) != cfg["meta_conf_digest"]):
        raise SystemExit("input digests differ from the frozen config")
    open(started, "a").write(("resume " if a.resume else "") + t0 + "\n")
    print(f"run {'resume' if a.resume else 'start'} {t0} frozen sha256 {G.sha256_file(path)}", flush=True)
    t0 = open(started).read().split("\n")[0].strip()
    os.makedirs(a.scratch, exist_ok=True)
    inp, metas, hours, liq, cm = load(a.mk, a.work)
    rp = mk_replay(a.mk, inp, metas, hours, cfg["rule"], liq, cm, record=False, v5=True)
    rp.checkpoint = os.path.join(a.scratch, f"ckpt-r111v5-{a.mk}.pkl")
    sim = rp.run()
    days = V.mk_days(a.mk)
    debt = V.debt_usd(a.mk, a.work, metas)
    viol = [d for d in days if sim.get(d, 0.0) > debt.get(d, 0.0)]
    t_sim = G.utcnow()
    if viol:
        res = {"item": cfg["item"], "stopped": "simulated daily volume > USDC total debt before any outcome read",
               "days_sim_gt_debt": len(viol), "utc_start": t0, "utc_sim_end": t_sim}
        G.jdump(os.path.join(a.out, "r111v5-bound-stop.json"), res)
        raise SystemExit(json.dumps(res))
    print(f"volume <= debt bound holds on all {len(days)} gate days at {t_sim}; opening the locked outcome file", flush=True)
    res, real, debt, dd = gate_stats(a.mk, a.work, inp, metas, hours, sim, cfg)
    q2 = [x for x in V.mk_days(a.mk, True) if x not in set(days)]
    scale = {k: v / G.REF_CORE_DEBT for k, v in debt.items()}
    cls_q2, pooled_q2 = V.classify4(q2, sim, real, scale, dd, cfg["x_pd"], priors=cfg["priors"])
    by_year = {}
    for y in sorted({x[:4] for x in days}):
        dy = [x for x in days if x[:4] == y]
        c, _ = V.classify4(dy, sim, real, scale, dd, cfg["x_pd"], priors=cfg["priors"])
        by_year[y] = {X: {k: v[k] for k in ("positive_days", "H", "F", "J", "J_E", "J_PD")} for X, v in c.items()}
    res.update({"item": cfg["item"], "frozen_sha256": G.sha256_file(path), "code_sha": sha,
                "reported_only": {"q2_2026": {"classification": cls_q2, "pooled_dm": pooled_q2}, "by_year": by_year},
                "engine": {"hours": rp.rec["hours"], "evals": rp.rec["evals"], "episodes": rp.rec.get("episodes")},
                "utc_start": t0, "utc_sim_end": t_sim, "utc_end": G.utcnow()})
    G.jdump(os.path.join(a.out, "r111v5-results.json"), res)
    with open(os.path.join(a.out, "r111v5-daily.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["date", "sim_usdc_usd", "real_usdc_usd", "usdc_debt_usd", "pd_drawdown", "gate_day", "q2_reported_only"])
        for x in V.mk_days(a.mk, True):
            w.writerow([x, f"{sim.get(x, 0.0):.2f}", f"{real.get(x, 0.0):.2f}", f"{debt.get(x, 0.0):.2f}",
                        f"{dd.get(x, 0.0):.5f}", int(x in set(days)), int(x in set(q2))])
    for n in os.listdir(a.out):
        if n.endswith((".json", ".csv")) and G.ADDR_RE.search(open(os.path.join(a.out, n)).read()):
            raise SystemExit(f"address pattern in {n}")
    print(json.dumps({"verdict": res["verdict"], "magnitude": {k: res["magnitude"][k] for k in ("sim_over_real_total", "checks")},
                      "classification": {X: {k: v[k] for k in ("positive_days", "H", "F", "J", "J_E", "J_PD")}
                                         for X, v in res["classification"].items()}}, indent=1, default=float))


def conf_metas(work):
    d = os.path.join(work, "meta-conf")
    if not os.path.isdir(d):
        raise SystemExit("meta-conf/ missing: run r111v5_acquire.py conf and confmeta first")
    ev = jl(os.path.join(work, "conf-events.json.gz"))
    blocks = sorted({r["block"] for r in ev["rows"]})
    have = sorted(int(n.split(".")[0]) for n in os.listdir(d))
    if have != blocks:
        raise SystemExit(f"meta-conf incomplete: {len(have)} of {len(blocks)} configurator blocks")
    out = []
    for b in blocks:
        m = jl(os.path.join(d, f"{b}.json.gz"))
        if not m.get("ts") or m["ts"] <= 0:
            raise SystemExit("configurator meta without a timestamp")
        out.append(m)
    return out


def load(mk, work, with_liq=True, with_conf=True):
    inp = E.Inputs(work)
    inp.load_oracle()
    metas = G.arb_metas(work)
    hours = G.arb_hours(inp, work)
    kp = os.path.join(work, "liq-keys.json.gz")
    if with_liq and os.path.exists(kp):
        # blind chain: (block, log index, account) only, never an amount or a debt asset (D-R11.1q F1)
        liq = E.liq_rows_with_uid(inp, jl(kp)["rows"])
    else:
        liq = E.liq_rows_with_uid(inp, jl(os.path.join(work, "liq-LOCKED.json.gz"))["rows"]) if with_liq else []
    return inp, metas, hours, liq, (conf_metas(work) if with_conf else [])


def mk_replay(mk, inp, metas, hours, rule, liq, cm, record=False, v5=True, cls=E.Replay, **k):
    m = V.MK[mk]
    first = int(dt.datetime.combine(m["first"], dt.time(), dt.timezone.utc).timestamp())
    return cls(inp, metas, hours, rule, m["usdc"], first, inp.gidx[m["gas"]], record=record, v5=v5,
               liq_rows=liq, conf_metas=cm, **k)


def cmd_window(a):
    rule = json.load(open(a.rule))
    inp, metas, hours, liq, cm = load(a.mk, a.work, with_conf=not a.v4)
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
    v5 = not a.v4
    n_c = int(np.searchsorted(np.array([m["block"] * 1_000_000 + 999_998 for m in cm], dtype=np.int64), K0,
                              side="right")) if v5 else 0
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
    ck = os.path.join(a.out, "win-state.pkl")
    with open(ck, "wb") as f:
        pickle.dump(S_, f, protocol=pickle.HIGHEST_PROTOCOL)
    del S_, st
    os.environ["R111_CK_EVERY"] = "1e12"
    rp = mk_replay(a.mk, inp, metas, hours, rule, liq, cm, record=True, v5=v5, cls=DG.WinReplay, end_day=a.end)
    rp.checkpoint = ck
    try:
        rp.run()
        sim, rec = rp.sim, rp.rec
    except DG.Stop:
        sim, rec = rp.sim_out, rp.rec_out
    os.remove(ck)
    if v5:
        for u in list(rp.ep):
            rp._end_episode(u)
    rows = jl(os.path.join(a.work, "liq-LOCKED.json.gz"))["rows"]
    t1 = int(dt.datetime.fromisoformat(a.end).replace(tzinfo=dt.timezone.utc).timestamp()) + 86400
    hp = {h["hour"]: h["prices"] for h in hours}
    real = []
    for r in rows:
        if t0 <= r["ts"] < t1:
            b = bytes.fromhex(r["user"][2:]).ljust(20, b"\0")
            px = hp.get(r["ts"] // 3600 * 3600)
            kd, kc = inp.gidx.get(r["debt"]), inp.gidx.get(r["collateral"])
            pdx = px[kd] if px is not None and kd is not None and px[kd] > 0 else 1.0
            real.append({"u": inp.uid.get(b), "ts": r["ts"], "block": r["block"], "debt_k": kd, "coll_k": kc,
                         "usdc": r["debt"] in V.MK[a.mk]["usdc"],
                         "repay_usd": r["debtToCover"] / 10 ** inp.dec[kd] * pdx if kd is not None else None})
    out = {"start": a.start, "end": a.end, "sim": sim, "calls": rec["calls"], "pxlog": rp.pxlog, "real": real,
           "symbols": inp.symbols, "dec": inp.dec, "hours_used": rec["hours"], "episodes": rp.episodes, "v5": v5}
    with open(os.path.join(a.out, "win.pkl"), "wb") as f:
        pickle.dump(out, f, protocol=pickle.HIGHEST_PROTOCOL)
    # address-free summary: per day sim vs real USDC, calls per account-day
    real_d = {}
    for r in real:
        if r["usdc"] and r["repay_usd"] is not None:
            d = dt.datetime.fromtimestamp(r["ts"], dt.timezone.utc).date().isoformat()
            real_d[d] = real_d.get(d, 0.0) + r["repay_usd"]
    per = {}
    for c in rec["calls"]:
        if c[4]:
            per[(c[0], c[1])] = per.get((c[0], c[1]), 0) + 1
    many = sum(1 for v in per.values() if v > 3)
    print(json.dumps({"window": [a.start, a.end], "engine": "v5" if v5 else "v4",
                      "sim_by_day": {k: round(v, 2) for k, v in sorted(sim.items())},
                      "real_by_day": {k: round(v, 2) for k, v in sorted(real_d.items())},
                      "n_calls": len(rec["calls"]), "account_days_gt3_calls": many,
                      "max_calls_account_day": max(per.values()) if per else 0, "episodes": rp.episodes}))


def cmd_kar(a):
    DG.cmd_kar(argparse.Namespace(win_list=a.win))


def gate_stats(mk, work, inp, metas, hours, sim, frozen):
    """The registered v4 gate statistics (D-R11.1l) on a simulated daily series (development reading)."""
    m = V.MK[mk]
    days = V.mk_days(mk)
    debt = V.debt_usd(mk, work, metas)
    viol = [d for d in days if sim.get(d, 0.0) > debt.get(d, 0.0)]
    real_ev, n_ev = V.real_events(work, hours, inp, m["usdc"])
    real = {}
    d = m["first"] - dt.timedelta(days=1)
    while d <= m["last"]:
        real[d.isoformat()] = real_ev.get(d.isoformat(), 0.0)
        d += dt.timedelta(days=1)
    scale = {k: v / G.REF_CORE_DEBT for k, v in debt.items()}
    dd = V.mk_dd(mk, hours, inp)
    cls, pooled = V.classify4(days, sim, real, scale, dd, frozen["x_pd"], priors=frozen["priors"])
    mag = V.magnitude(days, sim, real, debt)
    return {"gate_days": len(days), "days_sim_gt_debt": len(viol), "real_usdc_debt_events": n_ev,
            "classification": cls, "pooled_dm": pooled, "magnitude": mag, "verdict": V.verdict4(cls, pooled, mag)}, real, debt, dd


def cmd_devrun(a):
    t0 = G.utcnow()
    rule = json.load(open(a.rule))
    frozen = json.load(open(a.frozen))
    os.makedirs(a.out, exist_ok=True)
    os.makedirs(a.scratch, exist_ok=True)
    inp, metas, hours, liq, cm = load(a.mk, a.work)
    rp = mk_replay(a.mk, inp, metas, hours, rule, liq, cm, record=True, v5=True)
    rp.checkpoint = os.path.join(a.scratch, f"ckpt-r111v5-{a.mk}.pkl")
    sim = rp.run()
    t_sim = G.utcnow()
    with open(os.path.join(a.scratch, f"calls-r111v5-{a.mk}.pkl"), "wb") as f:
        pickle.dump(rp.rec["calls"], f, protocol=pickle.HIGHEST_PROTOCOL)
    res, real, debt, dd = gate_stats(a.mk, a.work, inp, metas, hours, sim, frozen)
    per = {}
    for c in rp.rec["calls"]:
        if c[4]:
            per[(c[0], c[1])] = per.get((c[0], c[1]), 0) + 1
    res.update({"item": "Q26 R11.1-v5 Polygon development reading (D-R11.1q): v4 gate statistics on v5 engine output; "
                        "Polygon is development data (grade B), so this is not a test",
                "engine": {"hours": rp.rec["hours"], "evals": rp.rec["evals"], "episodes": rp.rec.get("episodes"),
                           "usdc_calls": int(sum(per.values())), "account_days_with_usdc_calls": len(per),
                           "account_days_gt3_usdc_calls": sum(1 for v in per.values() if v > 3),
                           "max_usdc_calls_account_day": max(per.values()) if per else 0},
                "code_sha": G.git_sha()[0], "utc_start": t0, "utc_sim_end": t_sim, "utc_end": G.utcnow()})
    G.jdump(os.path.join(a.out, "r111v5-poly-dev.json"), res)
    with open(os.path.join(a.out, "r111v5-poly-dev-daily.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["date", "sim_usdc_usd", "real_usdc_usd", "usdc_debt_usd", "pd_drawdown", "gate_day"])
        gd = set(V.mk_days(a.mk))
        for x in V.mk_days(a.mk, True):
            w.writerow([x, f"{sim.get(x, 0.0):.2f}", f"{real.get(x, 0.0):.2f}", f"{debt.get(x, 0.0):.2f}",
                        f"{dd.get(x, 0.0):.5f}", int(x in gd)])
    for n in os.listdir(a.out):
        if n.endswith((".json", ".csv")) and G.ADDR_RE.search(open(os.path.join(a.out, n)).read()):
            raise SystemExit(f"address pattern in {n}")
    print(json.dumps({"verdict": res["verdict"], "magnitude": {k: res["magnitude"][k] for k in ("sim_over_real_total", "checks")},
                      "engine": res["engine"]}, indent=1, default=float))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd")
    for k in ("mk", "work", "out", "rule", "start", "end", "frozen", "scratch", "integrity", "power"):
        ap.add_argument(f"--{k}")
    ap.add_argument("--win", nargs="*")
    ap.add_argument("--v4", action="store_true")
    ap.add_argument("--resume", action="store_true")
    a = ap.parse_args()
    {"window": cmd_window, "kar": cmd_kar, "devrun": cmd_devrun, "counts": cmd_counts, "keys": cmd_keys,
     "integrity": cmd_integrity, "freeze": cmd_freeze, "run": cmd_run}[a.cmd](a)


if __name__ == "__main__":
    main()
