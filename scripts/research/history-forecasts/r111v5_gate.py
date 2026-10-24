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
    for k in ("mk", "work", "out", "rule", "start", "end", "frozen", "scratch"):
        ap.add_argument(f"--{k}")
    ap.add_argument("--win", nargs="*")
    ap.add_argument("--v4", action="store_true")
    ap.add_argument("--resume", action="store_true")
    a = ap.parse_args()
    {"window": cmd_window, "kar": cmd_kar, "devrun": cmd_devrun}[a.cmd](a)


if __name__ == "__main__":
    main()
