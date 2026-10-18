"""Q26 R11.1-v3 liquidation engine (membrane-board design/Q26_ROUND11_PREREG.md D-R11.1e).

Positions are rebuilt event by event from token logs (aToken, variable and stable debt Mint / Burn /
BalanceTransfer, each carrying its index), Pool collateral flags and UserEModeSet. Reserve indexes between events
come from the last ReserveDataUpdated per reserve-hour, accrued at its rates. Every hour the engine computes HF for
all USDC-debt accounts at the hourly oracle prices; accounts with HF < 1.05 are evaluated at every Chainlink
AnswerUpdated of a held reserve's feed (and at the hour boundary). The liquidation rule is the R10.1 rule
(largest debt, largest eligible collateral, close factor, v3.3 leftover rule, 6 calls) with the v3 cost model and
dust minimum. A simulated call leaves an overlay on the account that is cleared by the account's next real token
event.

Imported by r111v3_gate.py. No address leaves this module.
"""
from __future__ import annotations

import bisect
import datetime as dt
import gzip
import json
import math
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import r10_mechanics as M  # noqa: E402  (Day: reserve LT / LB / fee / decimals / e-mode tables)

YEAR = 365 * 86400
MAX_CALLS = 6
CAND_HF = 1.05
EV_TOK, EV_FLAG, EV_EMODE, EV_ORACLE, EV_HOUR = 0, 1, 2, 3, 4


def jload(path):
    with gzip.open(path, "rt") as f:
        return json.load(f)


def check_ts(arrs):
    """R11.1-v4: every input timestamp must be positive (D-R11.1j: 0 defaults on Arbitrum)."""
    bad = {k: int((np.asarray(v) <= 0).sum()) for k, v in arrs.items() if len(v) and (np.asarray(v) <= 0).any()}
    if bad:
        raise RuntimeError(f"non-positive timestamps in inputs: {bad}")


def _parts(d):
    return sorted(os.listdir(d), key=lambda x: int(x.split(".")[0]))


class Inputs:
    """Event streams of one market, with global user ids."""

    def __init__(self, work):
        self.work = work
        rs = jload(os.path.join(work, "reserves.json.gz"))
        self.reserves = rs["reserves"]
        self.assets = [r["asset"] for r in self.reserves]
        self.R = len(self.assets)
        self.gidx = {a: i for i, a in enumerate(self.assets)}
        self.dec = np.array([r["dec"] for r in self.reserves], dtype=np.float64)
        self.symbols = [r["symbol"] for r in self.reserves]
        uid = {}

        def remap(users, local):
            g = np.empty(len(users), dtype=np.int64)
            for i, u in enumerate(users):
                b = bytes(u).ljust(20, b"\0")   # numpy S20 drops trailing zero bytes
                if b not in uid:
                    uid[b] = len(uid)
                g[i] = uid[b]
            return g[local] if len(local) else local.astype(np.int64)

        tk = {k: [] for k in ("block", "lidx", "ts", "res", "kind", "user", "delta", "prin", "rate")}
        for n in _parts(os.path.join(work, "tok")):
            z = np.load(os.path.join(work, "tok", n))
            for k in tk:
                tk[k].append(remap(z["users"], z["user"]) if k == "user" else z[k])
        self.tok = {k: np.concatenate(v) for k, v in tk.items()}
        bd = os.path.join(work, "tok-bt")
        if os.path.isdir(bd):
            # BalanceTransfer rows of tok/ used the raw value; tok-bt/ holds them rescaled per aToken implementation
            z = np.load(os.path.join(bd, "0.npz"))
            bkey = np.unique(z["block"] * 1_000_000 + z["lidx"])
            tkey = self.tok["block"] * 1_000_000 + self.tok["lidx"]
            keep = ~((self.tok["kind"] == 0) & np.isin(tkey, bkey))
            nb = {k: self.tok[k][keep] for k in tk}
            for k in tk:
                nb[k] = np.concatenate([nb[k], remap(z["users"], z["user"]) if k == "user" else z[k]])
            o = np.lexsort((nb["lidx"], nb["block"]))
            self.tok = {k: v[o] for k, v in nb.items()}
        sd = os.path.join(work, "tok-stable")
        if os.path.isdir(sd):
            # kind-2 rows of tok/ came through the end-block placeholder address; tok-stable/ holds the real ones
            keep = self.tok["kind"] != 2
            for k in tk:
                self.tok[k] = self.tok[k][keep]
            st = {k: [self.tok[k]] for k in tk}
            for n in _parts(sd):
                z = np.load(os.path.join(sd, n))
                for k in tk:
                    st[k].append(remap(z["users"], z["user"]) if k == "user" else z[k])
            self.tok = {k: np.concatenate(v) for k, v in st.items()}
            o = np.lexsort((self.tok["lidx"], self.tok["block"]))
            self.tok = {k: v[o] for k, v in self.tok.items()}
        pk = {k: [] for k in ("rdu_block", "rdu_lidx", "rdu_ts", "rdu_res", "rdu_lrate", "rdu_vrate", "rdu_lidx_ray",
                              "rdu_vidx_ray", "f_block", "f_lidx", "f_ts", "f_res", "f_user", "f_on", "e_block", "e_lidx",
                              "e_ts", "e_user", "e_cat")}
        for n in _parts(os.path.join(work, "pool")):
            z = np.load(os.path.join(work, "pool", n))
            for k in pk:
                pk[k].append(remap(z["users"], z[k]) if k in ("f_user", "e_user") else z[k])
        self.pool = {k: np.concatenate(v) for k, v in pk.items()}
        self.uid = uid
        self.U = len(uid)
        # RDU sorted by key for the per-reserve "last at or before" lookup
        o = np.lexsort((self.pool["rdu_lidx"], self.pool["rdu_block"]))
        for k in [k for k in self.pool if k.startswith("rdu_")]:
            self.pool[k] = self.pool[k][o]
        self.rdu_key = self.pool["rdu_block"] * 1_000_000 + self.pool["rdu_lidx"]
        # R11.1-v4 (D-R11.1j): a zero timestamp accrues decades of interest and breaks the hour lookup; refuse it
        check_ts({"tok.ts": self.tok["ts"], "pool.rdu_ts": self.pool["rdu_ts"], "pool.f_ts": self.pool["f_ts"],
                  "pool.e_ts": self.pool["e_ts"]})

    def load_oracle(self):
        w = jload(os.path.join(self.work, "oracle-walk.json.gz"))
        self.aggs = w["aggregators"]
        self.walks = w["walks"]
        bl, li, ts, ag, an = [], [], [], [], []
        for n in _parts(os.path.join(self.work, "oracle")):
            z = np.load(os.path.join(self.work, "oracle", n))
            bl.append(z["block"]); li.append(z["lidx"]); ts.append(z["ts"]); ag.append(z["agg"]); an.append(z["answer"])
        self.ora = {"block": np.concatenate(bl), "lidx": np.concatenate(li), "ts": np.concatenate(ts),
                    "agg": np.concatenate(ag), "answer": np.concatenate(an)}
        check_ts({"oracle.ts": self.ora["ts"]})
        # driver aggregators per asset per weekly walk (asset index -> list of aggregator ids)
        aidx = {a: i for i, a in enumerate(self.aggs)}
        self.walk_blocks = [x["block"] for x in self.walks]
        self.seq_aggs = {aidx[g] for x in self.walks if x.get("sentinel") for g in x["sentinel"]["seq_aggs"]}
        self.walk_drivers = []
        for x in self.walks:
            dmap = {}
            for a, v in x["map"].items():
                if a in self.gidx and v["aggs"]:
                    dmap[self.gidx[a]] = [aidx[g] for g in v["aggs"]]
            self.walk_drivers.append(dmap)

    def sentinel_at(self, block):
        i = bisect.bisect_right(self.walk_blocks, block) - 1
        return self.walks[max(i, 0)].get("sentinel") or {"present": False, "grace": 0}

    def drivers_at(self, block):
        i = bisect.bisect_right(self.walk_blocks, block) - 1
        return self.walk_drivers[max(i, 0)]


class State:
    """Positions as of a stream position: scaled aToken / variable debt (raw units), stable principal / rate / ts,
    collateral flags and e-mode."""

    def __init__(self, inp: Inputs):
        U, R = inp.U, inp.R
        self.SA = np.zeros((U, R))
        self.SV = np.zeros((U, R))
        self.SP = np.zeros((U, R))        # stable principal (raw units)
        self.SR = np.zeros((U, R))        # stable rate (ray / 1e27)
        self.ST = np.zeros((U, R))        # stable last update ts
        self.FL = np.zeros((U, R), dtype=bool)
        self.EM = np.zeros(U, dtype=np.int16)

    def apply_tok(self, t, i):
        u, r, k = t["user"][i], t["res"][i], t["kind"][i]
        if k == 0:
            self.SA[u, r] += t["delta"][i]
        elif k == 1:
            self.SV[u, r] += t["delta"][i]
        else:
            self.SP[u, r] = t["prin"][i]
            if t["rate"][i] >= 0:
                self.SR[u, r] = t["rate"][i] / 1e27
            self.ST[u, r] = t["ts"][i]
        return u, r

    def apply_flag(self, p, i):
        self.FL[p["f_user"][i], p["f_res"][i]] = bool(p["f_on"][i])

    def apply_emode(self, p, i):
        self.EM[p["e_user"][i]] = p["e_cat"][i]


def merged_order(keys_list):
    """keys_list: [(type, keys array)] -> (types, positions) in global key order (ties keep list order)."""
    ks = np.concatenate([k for _, k in keys_list])
    ty = np.concatenate([np.full(len(k), t, dtype=np.int8) for t, k in keys_list])
    pos = np.concatenate([np.arange(len(k), dtype=np.int64) for _, k in keys_list])
    o = np.lexsort((ty, ks))
    return ks[o], ty[o], pos[o]


class Indexes:
    """Reserve liquidity / variable-debt index at time t from the last RDU at or before a stream key."""

    def __init__(self, inp: Inputs):
        self.inp = inp
        R = inp.R
        self.L0, self.V0 = np.ones(R), np.ones(R)
        self.lr, self.vr = np.zeros(R), np.zeros(R)
        self.t0 = np.zeros(R)
        self.ptr = 0

    def advance(self, key):
        p = self.inp.pool
        n = len(self.inp.rdu_key)
        while self.ptr < n and self.inp.rdu_key[self.ptr] <= key:
            i, r = self.ptr, p["rdu_res"][self.ptr]
            self.L0[r], self.V0[r] = p["rdu_lidx_ray"][i], p["rdu_vidx_ray"][i]
            self.lr[r], self.vr[r] = p["rdu_lrate"][i], p["rdu_vrate"][i]
            self.t0[r] = p["rdu_ts"][i]
            self.ptr += 1

    def at(self, t):
        dtt = np.maximum(t - self.t0, 0.0)
        return self.L0 * (1 + self.lr * dtt / YEAR), self.V0 * np.exp(self.vr * dtt / YEAR)


def stable_value(SP, SR, ST, t):
    dtt = np.maximum(t - ST, 0.0)
    return SP * np.exp(SR * dtt / YEAR)


def liquidate(u, st, ov, t, px, Lt, Vt, inv_unit, lt, lb, day, cost_usd, dust_usd, usdc_set, blocked=False):
    """R10.1 call loop with the v3 cost and dust rules on account u (overlay ov mutated). Returns list of
    (repay_usd, debt reserve, usdc flag) and the stop reason."""
    oa, ovd, osd = ov
    calls, reason = [], None
    sa = np.maximum(st.SA[u] - oa, 0.0)
    sv = np.maximum(st.SV[u] - ovd, 0.0)
    ss = np.maximum(stable_value(st.SP[u], st.SR[u], st.ST[u], t) - osd, 0.0)
    fl = st.FL[u]
    for _ in range(MAX_CALLS):
        coll = sa * Lt * inv_unit * px
        debtv = sv * Vt * inv_unit * px
        debts = ss * inv_unit * px
        debt = debtv + debts
        td = debt.sum()
        if td <= 0:
            reason = reason or "nodebt"
            break
        elig = fl & (lt > 0) & (coll > 0)
        if not elig.any():
            reason = reason or "nocoll"
            break
        hf = (coll[elig] * lt[elig]).sum() / td
        if hf >= 1.0:
            reason = reason or "healthy"
            break
        if blocked and hf >= 0.95:
            reason = reason or "sentinel"
            break
        j = int(np.argmax(debt))
        k = int(np.argmax(np.where(elig, coll, -1.0)))
        repay, seized, flags, profit, j, k = M_call(j, k, td, hf, coll, debt, lb, day, cost_usd)
        gross = profit + cost_usd
        if repay <= 0:
            reason = reason or "zero"
            break
        if gross < dust_usd:
            reason = reason or "dust"
            break
        if profit < 0:
            reason = reason or "cost"
            break
        rv = min(repay, debtv[j])
        dv = rv / (Vt[j] * inv_unit[j] * px[j])
        sv[j] = max(sv[j] - dv, 0.0)
        ovd[j] += dv
        if repay > rv:
            ds = (repay - rv) / (inv_unit[j] * px[j])
            ss[j] = max(ss[j] - ds, 0.0)
            osd[j] += ds
        da = seized / (Lt[k] * inv_unit[k] * px[k])
        sa[k] = max(sa[k] - da, 0.0)
        oa[k] += da
        calls.append((repay, j, j in usdc_set, flags, gross))
        reason = reason or "called"
    return calls, reason


def M_call(j, k, td, hf, coll, debt, LBi, day, cost_usd):
    """R11.1 _call (R10.1 close factor, seize cap, v3.3 leftover rule, protocol fee) with the v3 cost."""
    flags = {"cf": False, "seize": False}
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
    profit = (seized - fee) - repay - cost_usd
    return repay, seized, flags, profit, j, k


class Replay:
    """Full v3 replay. hours: list of dicts {hour, block, prices (vector R, USD), base_fee (wei)} in block order;
    metas: day -> meta (r10 layout); rule: {G, prio_wei, builder_usd, dust_usd}."""

    def __init__(self, inp: Inputs, metas, hours, rule, usdc_assets, first_hour, eth_k, record=False):
        self.inp, self.metas, self.hours, self.rule = inp, metas, hours, rule
        self.usdc_set = {inp.gidx[a] for a in usdc_assets}
        self.usdc_list = sorted(self.usdc_set)
        self.first_hour = first_hour
        self.eth_k = eth_k
        self.days_sorted = sorted(metas)
        self.record = record
        self._day = {}
        self.gidx_meta = inp.gidx

    def day_obj(self, d):
        if d not in self._day:
            meta = self.metas[d]
            g = {a: self.inp.gidx[a] for a in meta["reserves"] if a in self.inp.gidx}
            day = M.Day({**meta, "reserves": {a: r for a, r in meta["reserves"].items() if a in g}}, self.inp.gidx)
            # e-mode LT / LB table per category id used by the stream (cached lazily)
            self._day[d] = day
        return self._day[d]

    def run(self):
        inp, st = self.inp, State(self.inp)
        idx = Indexes(inp)
        inp_t, inp_p, ora = inp.tok, inp.pool, inp.ora
        tok_key = inp_t["block"] * 1_000_000 + inp_t["lidx"]
        flag_key = inp_p["f_block"] * 1_000_000 + inp_p["f_lidx"]
        em_key = inp_p["e_block"] * 1_000_000 + inp_p["e_lidx"]
        ora_key = ora["block"] * 1_000_000 + ora["lidx"]
        hour_key = np.array([h["block"] * 1_000_000 + 999_999 for h in self.hours], dtype=np.int64)
        ks, ty, pos = merged_order([(EV_TOK, tok_key), (EV_FLAG, flag_key), (EV_EMODE, em_key), (EV_ORACLE, ora_key),
                                    (EV_HOUR, hour_key)])
        inv_unit = 1.0 / (10.0 ** inp.dec)
        A = np.full(len(inp.aggs), np.nan)        # current answer per aggregator
        A_h = np.full(len(inp.aggs), np.nan)      # answer at the hour read
        px = np.zeros(inp.R)
        px_h = np.zeros(inp.R)
        drivers = {}
        asset_of_agg = {}
        cand = np.zeros(0, dtype=np.int64)
        cand_set = set()
        overlay = {}
        usdc_debt = np.zeros(inp.U, dtype=bool)
        day = None
        lt_cache = {}
        cost_usd, cur_day = 0.0, None
        sim = {}
        rec = {"calls": [], "hours": 0, "evals": 0, "cand_sizes": []}
        R = inp.R
        started = False
        self.seq_down, self.seq_up_ts, self.sentinel = False, -1e18, {"present": False, "grace": 0}
        import time as _time
        _t0 = _time.time()
        self.cpos, self.dirty, self.C = {}, set(), None
        self._overlay = overlay
        for n in range(len(ks)):
            if n % 1_000_000 == 0 and n:
                print(f"progress events {n:,}/{len(ks):,} day {cur_day} elapsed {_time.time() - _t0:.0f}s", flush=True)
            t_, p_ = ty[n], pos[n]
            if t_ == EV_TOK:
                u, r = st.apply_tok(inp_t, p_)
                if u in self.cpos:
                    self.dirty.add(u)
                if u in overlay:
                    del overlay[u]
                if r in self.usdc_set:
                    usdc_debt[u] = any(st.SV[u, j] > 0.5 or st.SP[u, j] > 0.5 for j in self.usdc_list)
                continue
            if t_ == EV_FLAG:
                st.apply_flag(inp_p, p_)
                if inp_p["f_user"][p_] in self.cpos:
                    self.dirty.add(int(inp_p["f_user"][p_]))
                continue
            if t_ == EV_EMODE:
                st.apply_emode(inp_p, p_)
                if inp_p["e_user"][p_] in self.cpos:
                    self.dirty.add(int(inp_p["e_user"][p_]))
                continue
            if t_ == EV_ORACLE:
                g = ora["agg"][p_]
                if g in inp.seq_aggs:
                    if ora["answer"][p_] >= 0.5:
                        self.seq_down = True
                    else:
                        if self.seq_down:
                            self.seq_up_ts = float(ora["ts"][p_])
                        self.seq_down = False
                    continue
                A[g] = ora["answer"][p_]
                if not started or g not in asset_of_agg:
                    continue
                t = float(ora["ts"][p_])
                touched = asset_of_agg[g]
                for a in touched:
                    ratio = 1.0
                    for f in drivers[a]:
                        if A_h[f] > 0 and A[f] > 0:
                            ratio *= A[f] / A_h[f]
                    px[a] = px_h[a] * ratio
                if len(cand) == 0:
                    continue
                idx.advance(ks[n])
                Lt, Vt = idx.at(t)
                d = dt.datetime.fromtimestamp(int(t), dt.timezone.utc).date().isoformat()
                self._eval(cand, st, overlay, t, px, Lt, Vt, inv_unit, day, lt_cache, cost_usd, d, sim, rec, touched)
                continue
            # hour boundary
            h = self.hours[p_]
            if h["hour"] < self.first_hour:
                continue
            started = True
            d = dt.datetime.fromtimestamp(h["hour"], dt.timezone.utc).date().isoformat()
            if d != cur_day:
                cur_day = d
                md = self.days_sorted[max(bisect.bisect_right(self.days_sorted, d) - 1, 0)]
                day = self.day_obj(md)
                lt_cache = {}
            px_h = np.array(h["prices"], dtype=np.float64)
            px = px_h.copy()
            A_h = A.copy()
            drivers = inp.drivers_at(h["block"])
            self.sentinel = inp.sentinel_at(h["block"])
            asset_of_agg = {}
            for a, fs in drivers.items():
                for f in fs:
                    asset_of_agg.setdefault(f, []).append(a)
            eth_px = px_h[self.eth_k]
            cost_usd = ((h["base_fee"] + self.rule["prio_wei"]) * self.rule["G"] / 1e18 * eth_px
                        + self.rule.get("builder_usd", 0.0))
            idx.advance(ks[n])
            t = float(h["ts"])
            Lt, Vt = idx.at(t)
            users = np.nonzero(usdc_debt)[0]
            rec["hours"] += 1
            if len(users) == 0:
                cand = np.zeros(0, dtype=np.int64)
                continue
            hf = self._hf_vec(users, st, overlay, t, px, Lt, Vt, inv_unit, day, lt_cache)
            cand = users[hf < CAND_HF]
            self._cache_build(cand, st, day, lt_cache)
            rec["cand_sizes"].append(len(cand))
            hd = dt.datetime.fromtimestamp(h["hour"], dt.timezone.utc).date().isoformat()
            self._eval(cand, st, overlay, t, px, Lt, Vt, inv_unit, day, lt_cache, cost_usd, hd, sim, rec, None)
        self.sim, self.rec = sim, rec
        return sim

    def _lt(self, day, lt_cache, em):
        em = int(em)
        if em not in lt_cache:
            lt_cache[em] = day.eff(em)
        return lt_cache[em]

    def _hf_vec(self, users, st, overlay, t, px, Lt, Vt, inv_unit, day, lt_cache):
        sa = st.SA[users]
        sv = st.SV[users]
        ss = stable_value(st.SP[users], st.SR[users], st.ST[users], t)
        if overlay:
            pos = {u: i for i, u in enumerate(users.tolist())}
            for u, (oa, ovd, osd) in overlay.items():
                i = pos.get(u)
                if i is not None:
                    sa[i] = np.maximum(sa[i] - oa, 0)
                    sv[i] = np.maximum(sv[i] - ovd, 0)
                    ss[i] = np.maximum(ss[i] - osd, 0)
        ems = st.EM[users]
        LT = np.zeros((len(users), len(px)))
        for em in np.unique(ems):
            LT[ems == em] = self._lt(day, lt_cache, em)[0]
        coll = sa * (Lt * inv_unit * px)
        debt = sv * (Vt * inv_unit * px) + ss * (inv_unit * px)
        elig = st.FL[users] & (LT > 0)
        num = (coll * LT * elig).sum(axis=1)
        td = debt.sum(axis=1)
        with np.errstate(divide="ignore", invalid="ignore"):
            return np.where(td > 0, num / np.where(td > 0, td, 1), np.inf)

    def _cache_build(self, cand, st, day, lt_cache):
        """Candidate rows of the hour (state copies), refreshed when a candidate's token, flag or e-mode log arrives."""
        self.cpos = {int(u): i for i, u in enumerate(cand.tolist())}
        self.dirty = set()
        n, R = len(cand), st.SA.shape[1]
        C = {"users": cand, "SA": st.SA[cand], "SV": st.SV[cand], "SP": st.SP[cand], "SR": st.SR[cand],
             "ST": st.ST[cand], "FL": st.FL[cand], "LT": np.zeros((n, R)), "LB": np.ones((n, R))}
        ems = st.EM[cand]
        for em in np.unique(ems):
            lt_, lb_ = self._lt(day, lt_cache, em)
            C["LT"][ems == em] = lt_
            C["LB"][ems == em] = lb_
        C["HELD"] = (C["SA"] > 0) | (C["SV"] > 0) | (C["SP"] > 0)
        C["OA"], C["OV"], C["OS"] = np.zeros((n, R)), np.zeros((n, R)), np.zeros((n, R))
        for u, i in self.cpos.items():
            ov = self._overlay.get(u)
            if ov is not None:
                C["OA"][i], C["OV"][i], C["OS"][i] = ov
        self.C = C

    def _cache_refresh(self, st, day, lt_cache):
        C = self.C
        for u in self.dirty:
            i = self.cpos[u]
            for k in ("SA", "SV", "SP", "SR", "ST", "FL"):
                C[k][i] = getattr(st, k)[u]
            lt_, lb_ = self._lt(day, lt_cache, st.EM[u])
            C["LT"][i], C["LB"][i] = lt_, lb_
            C["HELD"][i] = (C["SA"][i] > 0) | (C["SV"][i] > 0) | (C["SP"][i] > 0)
            ov = self._overlay.get(u)
            if ov is None:
                C["OA"][i] = 0.0
                C["OV"][i] = 0.0
                C["OS"][i] = 0.0
            else:
                C["OA"][i], C["OV"][i], C["OS"][i] = ov
        self.dirty = set()

    def _screen(self, rows, overlay, t, px, Lt, Vt, inv_unit, day, cost_usd, blocked):
        """Vectorised first call of the R10.1 loop on cached candidate rows (same formulas as liquidate / M_call,
        margins 1e-6). An account whose first call fails makes no call and changes no state, so skipping it is
        exact up to float ties."""
        C = self.C
        sa = np.maximum(C["SA"][rows] - C["OA"][rows], 0.0)
        sv = np.maximum(C["SV"][rows] - C["OV"][rows], 0.0)
        ss = np.maximum(stable_value(C["SP"][rows], C["SR"][rows], C["ST"][rows], t) - C["OS"][rows], 0.0)
        LT, LB = C["LT"][rows], C["LB"][rows]
        n = len(rows)
        coll = sa * (Lt * inv_unit * px)
        debt = sv * (Vt * inv_unit * px) + ss * (inv_unit * px)
        td = debt.sum(axis=1)
        elig = C["FL"][rows] & (LT > 0) & (coll > 0)
        with np.errstate(divide="ignore", invalid="ignore"):
            hf = np.where(td > 0, (coll * LT * elig).sum(axis=1) / np.where(td > 0, td, 1), np.inf)
        ok = (td > 0) & elig.any(axis=1) & (hf < 1.0 + 1e-6)
        if blocked:
            ok &= hf < 0.95 + 1e-6
        if not ok.any():
            return ok
        r = np.arange(n)
        j = np.argmax(debt, axis=1)
        k = np.argmax(np.where(elig, coll, -1.0), axis=1)
        dj, ck, lbk, fee = debt[r, j], coll[r, k], LB[r, k], day.fee[k]
        if day.v33:
            partial = (ck >= 2000.0) & (dj >= 2000.0) & (hf > 0.95)
            repay = np.where(partial & (dj > 0.5 * td), 0.5 * td, dj)
        else:
            repay = np.where(hf > 0.95, 0.5, 1.0) * dj
        seized = repay * lbk
        cap = seized > ck
        seized = np.where(cap, ck, seized)
        repay = np.where(cap, seized / lbk, repay)
        if day.v33:
            lo = ~cap & (repay < dj) & ((dj - repay < 1000.0) | (ck - seized < 1000.0))
            r2 = dj
            s2 = r2 * lbk
            c2 = s2 > ck
            s2 = np.where(c2, ck, s2)
            r2 = np.where(c2, s2 / lbk, r2)
            repay = np.where(lo, r2, repay)
            seized = np.where(lo, s2, seized)
        with np.errstate(divide="ignore", invalid="ignore"):
            gross = (seized - (seized - seized / lbk) * fee) - repay
        ok &= (repay > 0) & (gross >= self.rule["dust_usd"] - 1e-6) & (gross - cost_usd >= -1e-6)
        return ok

    def _eval(self, cand, st, overlay, t, px, Lt, Vt, inv_unit, day, lt_cache, cost_usd, d, sim, rec, touched):
        """Vectorised first-call screen (_screen) before the exact per-account call loop, which recomputes everything."""
        R = len(px)
        if len(cand) == 0:
            return
        if self.dirty:
            self._cache_refresh(st, day, lt_cache)
        if touched is not None:
            rows = np.nonzero(self.C["HELD"][:, list(touched)].any(axis=1))[0]
        else:
            rows = np.arange(len(cand))
        if len(rows) == 0:
            return
        cand = self.C["users"][rows]
        rec["evals"] += len(cand)
        blocked = bool(self.sentinel.get("present") and
                       (self.seq_down or t < self.seq_up_ts + float(self.sentinel.get("grace") or 0)))
        if blocked:
            rec["sentinel_blocked_evals"] = rec.get("sentinel_blocked_evals", 0) + len(cand)
        ok = self._screen(rows, overlay, t, px, Lt, Vt, inv_unit, day, cost_usd, blocked)
        for u in cand[ok].tolist():
            lt, lb = self._lt(day, lt_cache, st.EM[u])
            ov = overlay.get(u)
            fresh = ov is None
            if fresh:
                ov = (np.zeros(R), np.zeros(R), np.zeros(R))
            calls, reason = liquidate(u, st, ov, t, px, Lt, Vt, inv_unit, lt, lb, day, cost_usd,
                                      self.rule["dust_usd"], self.usdc_set, blocked)
            if calls:
                if fresh:
                    overlay[u] = ov
                i = self.cpos.get(u)
                if i is not None:
                    self.C["OA"][i], self.C["OV"][i], self.C["OS"][i] = ov
                for repay, j, is_usdc, flags, gross in calls:
                    if is_usdc:
                        sim[d] = sim.get(d, 0.0) + repay
                    if self.record:
                        rec["calls"].append((d, int(u), float(repay), int(j), bool(is_usdc), float(gross), int(t)))
