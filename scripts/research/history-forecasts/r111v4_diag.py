"""Q26 R11.1-v4 POST-OUTCOME instrument diagnostics (membrane-board design/Q26_ROUND11_PREREG.md D-R11.1p).

Nothing here changes the registered R11.1-v4 verdict. These commands run after the gate result and only explain it.

  python3 r111v4_diag.py window --work WORK --frozen FROZEN --start YYYY-MM-DD --end YYYY-MM-DD --out OUTDIR
      Windowed replay. The unchanged R11.1-v3 engine (Replay.run) resumes from a state pickle built here: real
      positions (no simulated overlay), Chainlink answers and reserve indexes, all as of the first hourly read of
      --start. The engine runs with record=True until the first hour after --end. Simulated calls, their oracle
      prices and the matching real LiquidationCall rows are written to OUTDIR (scratch, never published: it holds
      user ids).

  python3 r111v4_diag.py chain --work WORK --win OUTDIR [--top N]
      For the N accounts with the largest simulated USDC repay in the window, reads getUserAccountData and the Aave
      oracle prices at the block of each first simulated call (keyless or environment endpoint, never printed).
      Prints an address-free summary.

  python3 r111v4_diag.py kar --work WORK --win OUTDIR [OUTDIR ...]
      Known-answer replay: matches real USDC-debt LiquidationCall rows in the windows to simulated calls on the same
      account (sim call within [real - 1 h, real + 1 h]) and compares sizes. Address-free summary.

Starting a window without overlays can only add simulated calls relative to the scored run (an overlay only removes
debt), so a window that reproduces the scored daily simulated volume confirms the window state.
"""
from __future__ import annotations

import argparse
import bisect
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

MK = V.MK["poly"]


class Stop(Exception):
    pass


class WinReplay(E.Replay):
    """Replay that logs the oracle price vector and HF context of each simulated call and stops after --end."""

    def __init__(self, *a, end_day=None, **k):
        super().__init__(*a, **k)
        self.end_day = end_day
        self.pxlog = []

    def _eval(self, cand, st, overlay, t, px, Lt, Vt, inv_unit, day, lt_cache, cost_usd, d, sim, rec, touched):
        if d > self.end_day:
            self.sim_out, self.rec_out = sim, rec
            raise Stop()
        n0 = len(rec["calls"])
        super()._eval(cand, st, overlay, t, px, Lt, Vt, inv_unit, day, lt_cache, cost_usd, d, sim, rec, touched)
        for c in rec["calls"][n0:]:
            u = c[1]
            self.pxlog.append({"call": len(self.pxlog), "u": u, "t": t, "px": px.copy(), "cost_usd": cost_usd,
                               "SA": st.SA[u].copy(), "SV": st.SV[u].copy(), "FL": st.FL[u].copy(), "EM": int(st.EM[u])})


def state_at(inp, K0):
    """Real positions after every token / flag / e-mode event with key <= K0 (vectorised State.apply_*)."""
    st = E.State(inp)
    t = inp.tok
    tk = t["block"] * 1_000_000 + t["lidx"]
    n = int(np.searchsorted(tk, K0, side="right"))
    k = t["kind"][:n]
    u, r, dl = t["user"][:n], t["res"][:n], t["delta"][:n]
    m = k == 0
    np.add.at(st.SA, (u[m], r[m]), dl[m])
    m = k == 1
    np.add.at(st.SV, (u[m], r[m]), dl[m])
    i2 = np.nonzero(k == 2)[0]
    if len(i2):
        flat = u[i2].astype(np.int64) * inp.R + r[i2]
        last = {}
        for ii, f in zip(i2.tolist(), flat.tolist()):
            last[f] = ii           # later rows overwrite: last wins
        for f, ii in last.items():
            uu, rr = divmod(f, inp.R)
            st.SP[uu, rr] = t["prin"][ii]
            st.ST[uu, rr] = t["ts"][ii]
        # the rate is only set by rows with rate >= 0 (State.apply_tok)
        lastr = {}
        for ii, f in zip(i2.tolist(), flat.tolist()):
            if t["rate"][ii] >= 0:
                lastr[f] = ii
        for f, ii in lastr.items():
            uu, rr = divmod(f, inp.R)
            st.SR[uu, rr] = t["rate"][ii] / 1e27
    p = inp.pool
    fk = p["f_block"] * 1_000_000 + p["f_lidx"]
    nf = int(np.searchsorted(fk, K0, side="right"))
    for i in range(nf):          # flags: order matters (last wins); a plain loop is exact
        st.FL[p["f_user"][i], p["f_res"][i]] = bool(p["f_on"][i])
    ek = p["e_block"] * 1_000_000 + p["e_lidx"]
    ne = int(np.searchsorted(ek, K0, side="right"))
    for i in range(ne):
        st.EM[p["e_user"][i]] = p["e_cat"][i]
    return st, n, nf, ne


def cmd_window(a):
    cfg = json.load(open(a.frozen))
    inp = E.Inputs(a.work)
    inp.load_oracle()
    metas = G.arb_metas(a.work)
    hours = G.arb_hours(inp, a.work)
    t0 = int(dt.datetime.fromisoformat(a.start).replace(tzinfo=dt.timezone.utc).timestamp())
    i0 = next(i for i, h in enumerate(hours) if h["hour"] >= t0)
    K0 = hours[i0]["block"] * 1_000_000 + 999_999
    st, n_tok, n_f, n_e = state_at(inp, K0)
    ora = inp.ora
    n_o = int(np.searchsorted(ora["key"], K0, side="right"))
    last = np.full(len(inp.aggs), -1, dtype=np.int64)
    ag = ora["agg"][:n_o].astype(np.int64)
    np.maximum.at(last, ag, np.arange(n_o, dtype=np.int64))
    A = np.full(len(inp.aggs), np.nan)
    ok = last >= 0
    A[ok] = ora["answer"][last[ok]]
    for g in inp.seq_aggs:
        A[g] = np.nan
    idx = E.Indexes(inp)
    idx.advance(K0)
    usdc = [inp.gidx[x] for x in MK["usdc"]]
    usdc_debt = (st.SV[:, usdc] > 0.5).any(axis=1) | (st.SP[:, usdc] > 0.5).any(axis=1)
    pos_h0 = n_tok + n_f + n_e + n_o + i0          # position of the hour-h0 event in the merged order
    prev_day = (dt.date.fromisoformat(a.start) - dt.timedelta(days=1)).isoformat()
    S_ = {"n": pos_h0 - 1, "hour_pos": i0, "st": {k: getattr(st, k) for k in ("SA", "SV", "SP", "SR", "ST", "FL", "EM")},
          "idx": {k: getattr(idx, k) for k in ("L0", "V0", "lr", "vr", "t0", "ptr")},
          "A": A, "A_h": A.copy(), "px": np.zeros(inp.R), "px_h": np.zeros(inp.R), "cand": np.zeros(0, dtype=np.int64),
          "overlay": {}, "usdc_debt": usdc_debt, "cost_usd": 0.0, "cur_day": prev_day, "sim": {},
          "rec": {"calls": [], "hours": 0, "evals": 0, "cand_sizes": []}, "started": True, "seq_down": False,
          "seq_up_ts": -1e18, "sentinel": {"present": False, "grace": 0}, "cpos": {}, "dirty": set(), "C": None}
    os.makedirs(a.out, exist_ok=True)
    ck = os.path.join(a.out, "win-state.pkl")
    with open(ck, "wb") as f:
        pickle.dump(S_, f, protocol=pickle.HIGHEST_PROTOCOL)
    del S_, st
    os.environ["R111_CK_EVERY"] = "1e12"
    first = int(dt.datetime.combine(MK["first"], dt.time(), dt.timezone.utc).timestamp())
    rp = WinReplay(inp, metas, hours, cfg["rule"], MK["usdc"], first, inp.gidx[MK["gas"]], record=True, end_day=a.end)
    rp.checkpoint = ck
    try:
        rp.run()
        sim, rec = rp.sim, rp.rec
    except Stop:
        sim, rec = rp.sim_out, rp.rec_out
    os.remove(ck)
    # real rows in the window (outcome file: post-outcome diagnostic)
    rows = V.jl(os.path.join(a.work, "liq-LOCKED.json.gz"))["rows"]
    t1 = int(dt.datetime.fromisoformat(a.end).replace(tzinfo=dt.timezone.utc).timestamp()) + 86400
    hp = {h["hour"]: h["prices"] for h in hours}
    real = []
    for r in rows:
        if t0 <= r["ts"] < t1:
            b = bytes.fromhex(r["user"][2:]).ljust(20, b"\0")
            uid = inp.uid.get(b)
            px = hp.get(r["ts"] // 3600 * 3600)
            kd, kc = inp.gidx.get(r["debt"]), inp.gidx.get(r["collateral"])
            pdx = px[kd] if px is not None and kd is not None and px[kd] > 0 else 1.0
            real.append({"u": uid, "ts": r["ts"], "block": r["block"], "debt_k": kd, "coll_k": kc,
                         "usdc": r["debt"] in MK["usdc"],
                         "repay_usd": r["debtToCover"] / 10 ** inp.dec[kd] * pdx if kd is not None else None})
    out = {"start": a.start, "end": a.end, "sim": sim, "calls": rec["calls"], "pxlog": rp.pxlog, "real": real,
           "symbols": inp.symbols, "dec": inp.dec, "hours_used": rec["hours"]}
    with open(os.path.join(a.out, "win.pkl"), "wb") as f:
        pickle.dump(out, f, protocol=pickle.HIGHEST_PROTOCOL)
    print(json.dumps({"window": [a.start, a.end], "sim_by_day": {k: round(v, 2) for k, v in sorted(sim.items())},
                      "n_calls": len(rec["calls"]), "n_real_rows": len(real)}))


def cmd_chain(a):
    import r111v3_rpc as X
    import r111v3_acquire as A
    W = pickle.load(open(os.path.join(a.win, "win.pkl"), "rb"))
    inp = E.Inputs(a.work)
    uinv = {v: k for k, v in inp.uid.items()}
    tk_ts, tk_bl = inp.tok["ts"], inp.tok["block"]
    by_u = {}
    for c, pl in zip(W["calls"], W["pxlog"]):
        d, u, repay, j, is_usdc, gross, t = c
        if is_usdc:
            e = by_u.setdefault(u, {"repay": 0.0, "first": pl, "n": 0, "days": set()})
            e["repay"] += repay
            e["n"] += 1
            e["days"].add(d)
    top = sorted(by_u.items(), key=lambda x: -x[1]["repay"])[: a.top]
    cl = X.Client("polygon", interval=0.1, calls=True)
    pool, oracle = A.MARKETS["poly"]["pool"], A.MARKETS["poly"]["oracle"]
    real_u = {}
    for r in W["real"]:
        real_u.setdefault(r["u"], []).append(r)
    syms = W["symbols"]
    res = []
    for rank, (u, e) in enumerate(top):
        pl = e["first"]
        i = int(np.searchsorted(tk_ts, pl["t"], side="right")) - 1
        blk = int(tk_bl[max(i, 0)])
        addr = "0x" + uinv[u].hex()
        held = [k for k in range(inp.R) if pl["SA"][k] > 0 and pl["FL"][k]]
        owed = [k for k in range(inp.R) if pl["SV"][k] > 0]
        calls = [(pool, X.sel("getUserAccountData(address)") + X.enc_addr(addr))]
        ks = sorted(set(held + owed))
        calls.append((oracle, X.sel("getAssetsPrices(address[])") + X.enc_u(32) + X.enc_u(len(ks))
                      + b"".join(X.enc_addr(inp.assets[k]) for k in ks)))
        out = X.aggregate3(cl, calls, blk)
        (ok1, r1), (ok2, r2) = out
        hf_c = X.word(r1, 5) / 1e18 if ok1 and len(r1) >= 192 else None
        debt_c = X.word(r1, 1) / 1e8 if ok1 and len(r1) >= 192 else None
        coll_c = X.word(r1, 0) / 1e8 if ok1 and len(r1) >= 192 else None
        px_c = {}
        if ok2 and len(r2) >= 64 + 32 * len(ks):
            for q, k in enumerate(ks):
                px_c[syms[k]] = X.word(r2, 2 + q) / 1e8
        px_m = {syms[k]: float(pl["px"][k]) for k in ks}
        rr = real_u.get(u, [])
        res.append({"rank": rank, "sim_usdc_repay_usd": round(e["repay"], 2), "sim_calls": e["n"], "days": sorted(e["days"]),
                    "emode": pl["EM"], "collateral": [syms[k] for k in held], "debt": [syms[k] for k in owed],
                    "chain_hf_at_first_call": hf_c, "chain_debt_usd": debt_c, "chain_coll_usd": coll_c,
                    "px_model": px_m, "px_chain": px_c,
                    "px_model_over_chain": {s: (px_m[s] / px_c[s] if px_c.get(s) else None) for s in px_m},
                    "real_liq_rows_in_window": len(rr),
                    "real_usdc_repay_usd_in_window": round(sum(x["repay_usd"] or 0 for x in rr if x["usdc"]), 2)})
    s = json.dumps(res, indent=1, default=float)
    if G.ADDR_RE.search(s):
        raise SystemExit("address pattern in output")
    open(os.path.join(a.win, "chain.json"), "w").write(s)
    print(s)


def cmd_kar(a):
    allm = []
    for wdir in a.win_list:
        W = pickle.load(open(os.path.join(wdir, "win.pkl"), "rb"))
        start = dt.datetime.fromisoformat(W["start"]).replace(tzinfo=dt.timezone.utc).timestamp()
        tgt0 = start + 86400   # the first day warms up; matching uses the later days only
        sims = {}
        for c in W["calls"]:
            d, u, repay, j, is_usdc, gross, t = c
            if is_usdc:
                sims.setdefault(u, []).append((t, repay))
        for r in W["real"]:
            if not r["usdc"] or r["ts"] < tgt0 or r["u"] is None:
                continue
            ss = [x for x in sims.get(r["u"], []) if r["ts"] - 3600 <= x[0] <= r["ts"] + 3600]
            allm.append({"win": W["start"], "real_usd": r["repay_usd"], "matched": bool(ss),
                         "sim_usd_pm1h": sum(x[1] for x in ss), "lead_s": (r["ts"] - min(x[0] for x in ss)) if ss else None})
    re_ = np.array([m["real_usd"] for m in allm])
    mt = np.array([m["matched"] for m in allm])
    big = re_ >= 1000
    res = {"n_real_usdc_rows": len(allm), "matched_share": float(mt.mean()) if len(mt) else None,
           "n_real_ge_1k": int(big.sum()), "matched_share_ge_1k": float(mt[big].mean()) if big.any() else None,
           "usd_weighted_matched_share": float(re_[mt].sum() / re_.sum()) if re_.sum() else None,
           "size_ratio_sim_over_real_matched_q10_q50_q90": [float(np.quantile([m["sim_usd_pm1h"] / m["real_usd"] for m in allm
                                                                               if m["matched"] and m["real_usd"] > 0], q))
                                                            for q in (0.1, 0.5, 0.9)] if mt.any() else None,
           "lead_s_q10_q50_q90": [float(np.quantile([m["lead_s"] for m in allm if m["matched"]], q)) for q in (0.1, 0.5, 0.9)]
           if mt.any() else None,
           "by_window": {}}
    for w in sorted({m["win"] for m in allm}):
        mm = [m for m in allm if m["win"] == w]
        res["by_window"][w] = {"n": len(mm), "matched": sum(m["matched"] for m in mm),
                               "real_usd": round(sum(m["real_usd"] for m in mm), 2),
                               "real_usd_matched": round(sum(m["real_usd"] for m in mm if m["matched"]), 2)}
    print(json.dumps(res, indent=1))


def cmd_ts(a):
    """Every input stream: no non-positive timestamp, one timestamp per block, timestamps non-decreasing in block. Then
    a seeded sample of 300 blocks (token, pool, oracle and liquidation rows) against header timestamps through
    q26cache.BlockTimestamps (keyless or environment endpoint, never printed)."""
    import q26cache as Q
    import r111v3_rpc as X
    inp = E.Inputs(a.work)
    inp.load_oracle()
    rows = V.jl(os.path.join(a.work, "liq-LOCKED.json.gz"))["rows"]
    res = {"streams": {}}
    conflicts, uniq = 0, []

    def reduce_(name, b, ts):
        nonlocal conflicts
        b, ts = np.asarray(b, np.int64), np.asarray(ts, np.int64)
        res["streams"][name] = {"rows": int(len(ts)), "non_positive": int((ts <= 0).sum())}
        o_ = np.lexsort((ts, b)) if len(b) and not bool(np.all(np.diff(b) >= 0)) else None
        if o_ is not None:
            b, ts = b[o_], ts[o_]
        same = b[1:] == b[:-1]
        conflicts += int((same & (ts[1:] != ts[:-1])).sum())
        keep = np.concatenate([[True], ~same]) if len(b) else np.zeros(0, bool)
        uniq.append((b[keep], ts[keep]))

    t, p = inp.tok, inp.pool
    reduce_("tok", t["block"], t["ts"])
    reduce_("rdu", p["rdu_block"], p["rdu_ts"])
    reduce_("flag", p["f_block"], p["f_ts"])
    reduce_("emode", p["e_block"], p["e_ts"])
    reduce_("liq", [r["block"] for r in rows], [r["ts"] for r in rows])
    del inp.tok
    o = inp.ora
    n = len(o["key"])
    ob, ot = [], []
    for i in range(0, n, 10_000_000):        # chunked: the oracle stream is about 1e8 rows
        b_ = o["key"][i:i + 10_000_000] // 1_000_000
        t_ = o["ts"][i:i + 10_000_000]
        keep = np.concatenate([[True], b_[1:] != b_[:-1]])
        conflicts += int(((b_[1:] == b_[:-1]) & (t_[1:] != t_[:-1])).sum())
        ob.append(b_[keep]); ot.append(t_[keep])
    res["streams"]["oracle"] = {"rows": int(n), "non_positive": int((o["ts"] <= 0).sum())}
    del inp.ora
    reduce_("oracle_blocks", np.concatenate(ob), np.concatenate(ot))
    del res["streams"]["oracle_blocks"]
    b = np.concatenate([u[0] for u in uniq])
    ts = np.concatenate([u[1] for u in uniq])
    o_ = np.lexsort((ts, b))
    b, ts = b[o_], ts[o_]
    same = b[1:] == b[:-1]
    conflicts += int((same & (ts[1:] != ts[:-1])).sum())
    res["blocks_with_two_timestamps"] = conflicts
    keep = np.concatenate([[True], ~same])
    ub, uts = b[keep], ts[keep]
    res["unique_blocks"] = int(len(ub))
    res["ts_decreasing_with_block"] = int((np.diff(uts) < 0).sum())
    rng = np.random.default_rng(20261024)
    pick = sorted(rng.choice(len(ub), size=300, replace=False).tolist())
    bt = Q.BlockTimestamps()
    cl = X.Client("polygon", interval=0.1, calls=True)
    mism = 0
    for i in pick:
        h = bt.get_or_fetch("polygon", int(ub[i]), lambda blk: cl.header_ts(blk))
        mism += int(h != int(uts[i]))
    res["header_sample"] = {"n": len(pick), "mismatch": mism, "seed": 20261024}
    res["pass"] = bool(all(v["non_positive"] == 0 for v in res["streams"].values()) and res["blocks_with_two_timestamps"] == 0
                       and res["ts_decreasing_with_block"] == 0 and mism == 0)
    print(json.dumps(res, indent=1))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd")
    for k in ("work", "frozen", "start", "end", "out", "win"):
        ap.add_argument(f"--{k}")
    ap.add_argument("--top", type=int, default=10)
    ap.add_argument("win_list", nargs="*")
    a = ap.parse_args()
    {"window": cmd_window, "chain": cmd_chain, "kar": cmd_kar, "ts": cmd_ts}[a.cmd](a)


if __name__ == "__main__":
    main()
