"""Tests for live/q26_live_d14.py (D14 borrower-alert shadow log). Synthetic data, one frozen anonymised fixture of
real Aave V3 accounts (no address), no network. Run: python3 -m pytest -q live/test_q26_live_d14.py"""
from __future__ import annotations

import gzip
import json
import math
import os
import random
import re
import sys

import numpy as np
import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))
import d13_twap as TW  # noqa: E402
import q26_live_d14 as D  # noqa: E402

HOUR = 3600
FIX = os.path.join(HERE, "d14_fixture.json")


# ---------------------------------------------------------------------------------------------------------------------
# constants and selectors
# ---------------------------------------------------------------------------------------------------------------------
def test_selectors_and_topics_match_keccak():
    import r111v3_rpc as X
    for name, sig in D.SIGS.items():
        assert D.SEL[name] == X.sel(sig).hex(), name
    for name, sig in D.EVENT_SIGS.items():
        assert D.TOPIC[name] == X.topic(sig), name


def test_constants_match_r27_and_r111v5():
    import r27_atrisk as R
    import r111v5_labels as LB
    assert D.BANDS == R.DBK and D.BAND_NAMES == tuple(R.DBN)
    assert D.X_BAND == R.X_BAND
    assert D.MIN_DEBT_USD == LB.MIN_DEBT
    assert D.STABLE_SYMS == LB.STABLE_SYMS
    assert D.D_AT_RISK == 0.03          # RULING Q26-R27


def test_endpoints_are_keyless_public():
    for ch, cfg in D.CHAINS.items():
        for u, _ in cfg["log"]:
            D.assert_public(u)
        for u in cfg["call"]:
            D.assert_public(u)
    for bad in ("http://x.org", "https://x.org/?key=1", "https://u:p@x.org",
                "https://eth-mainnet.g.alchemy.com/v2/abcdEFGH1234abcdEFGH1234"):
        with pytest.raises(SystemExit):
            D.assert_public(bad)


# ---------------------------------------------------------------------------------------------------------------------
# reserve configuration and e-mode (r10_mechanics)
# ---------------------------------------------------------------------------------------------------------------------
def _conf(lt, lb, dec, cat=0):
    return (lt << 16) | (lb << 32) | (dec << 48) | (cat << 168)


def test_decode_conf_and_eff_lt_match_r10_mechanics():
    import r10_mechanics as M
    rnd = random.Random(1)
    for _ in range(200):
        c = rnd.getrandbits(250)
        assert D.decode_conf(c) == M.decode_conf(c)
    reserves = {"0xa": {"config": str(_conf(8000, 10500, 18, 1)), "id": 0, "price": 2000e8, "income": str(10 ** 27),
                        "vindex": str(10 ** 27)},
                "0xb": {"config": str(_conf(7500, 10500, 6, 0)), "id": 1, "price": 1e8, "income": str(10 ** 27),
                        "vindex": str(10 ** 27)},
                "0xc": {"config": str(_conf(0, 10500, 18, 1)), "id": 2, "price": 1900e8, "income": str(10 ** 27),
                        "vindex": str(10 ** 27)}}
    for emode in ({"1": {"layout": "v32", "ltv": 9000, "lt": 9300, "lb": 10100, "bitmap": 0b101}},
                  {"1": {"layout": "legacy", "ltv": 9000, "lt": 9300, "lb": 10100, "bitmap": None}}):
        gidx = {a: i for i, a in enumerate(reserves)}
        day = M.Day({"reserves": reserves, "emode": emode, "v33": True}, gidx)
        market = {"reserves": {a: dict(r, config=int(r["config"])) for a, r in reserves.items()}, "emode": emode}
        for em in (0, 1, 7):
            lt_m = day.eff(em)[0]
            lt_d = D.eff_lt(market, em)
            for a, k in gidx.items():
                assert lt_d[a] == pytest.approx(lt_m[k], abs=0), (emode, em, a)


# ---------------------------------------------------------------------------------------------------------------------
# distance k* (r111v5_labels)
# ---------------------------------------------------------------------------------------------------------------------
R111V5_KSTAR_LINES = (
    "Cst = (cLT * pxh * stable).sum(axis=1)",
    "Cv = (cLT * pxh * ~stable).sum(axis=1)",
    "Dst = (debt_u * pxh * stable).sum(axis=1)",
    "Dv = (debt_u * pxh * ~stable).sum(axis=1)",
    "kstar = np.where(Cv - Dv > 0, (Dst + Dv - Cst - Cv) / (Cv - Dv), np.nan)",
)


def r111v5_kstar(cLT, debt_u, pxh, stable):
    """The r111v5_labels.cmd_labels k* lines, executed verbatim (their text is checked against the source)."""
    ns = {"np": np, "cLT": cLT, "debt_u": debt_u, "pxh": pxh, "stable": stable}
    with np.errstate(divide="ignore", invalid="ignore"):
        for ln in R111V5_KSTAR_LINES:
            exec(ln, ns)  # noqa: S102
    return ns["kstar"]


def test_r111v5_kstar_lines_are_in_the_source():
    src = open(os.path.join(os.path.dirname(HERE), "r111v5_labels.py")).read()
    for ln in R111V5_KSTAR_LINES:
        assert ln in src, ln


def _metrics_inputs(rnd, R=6):
    syms = ["WETH", "WBTC", "USDC", "LINK", "DAI", "wstETH"][:R]
    stable = np.array([D.is_stable(s) for s in syms])
    pxh = np.array([2000.0, 60000.0, 1.0, 15.0, 1.0, 2300.0])[:R]
    cLT = np.array([rnd.random() * 5 if rnd.random() < 0.5 else 0.0 for _ in range(R)])
    debt = np.array([rnd.random() * 3000 if rnd.random() < 0.4 else 0.0 for _ in range(R)])
    debt_u = debt / pxh
    return syms, stable, pxh, cLT, debt_u


def test_kstar_matches_r111v5_and_root_of_hf():
    rnd = random.Random(7)
    n_line = 0
    for _ in range(3000):
        syms, stable, pxh, cLT, debt_u = _metrics_inputs(rnd)
        Cst = float((cLT * pxh * stable).sum())
        Cv = float((cLT * pxh * ~stable).sum())
        Dst = float((debt_u * pxh * stable).sum())
        Dv = float((debt_u * pxh * ~stable).sum())
        k = D.kstar_value(Cst, Cv, Dst, Dv)
        ref = r111v5_kstar(cLT[None, :], debt_u[None, :], pxh, stable)[0]
        if k is None:
            assert not np.isfinite(ref)
            continue
        assert k == pytest.approx(float(ref), rel=1e-12, abs=1e-12)
        # HF(k*) = 1 when every non-stable price moves by (1 + k*)
        scale = np.where(stable, 1.0, 1.0 + k)
        num = float((cLT * pxh * scale).sum())
        den = float((debt_u * pxh * scale).sum())
        if den > 0 and 1.0 + k > 0:
            assert num / den == pytest.approx(1.0, rel=1e-9)
            n_line += 1
        # k* >= 1 - 1/HF lower bound used by the screen (HF >= 1, non-negative parts)
        hf = (Cst + Cv) / (Dst + Dv) if Dst + Dv > 0 else math.inf
        if 1.0 <= hf < math.inf:
            assert -k >= 1.0 - 1.0 / hf - 1e-12
    assert n_line > 500


def test_label_b_line_equals_kstar_for_single_asset_stable_debt():
    """r111v5 label B: pstar = (D - Pst) / cLT_k, kk = pstar / px_k - 1, equals k* for one volatile collateral and
    stable debt (no interest growth term at H = 0)."""
    rnd = random.Random(3)
    for _ in range(500):
        px = rnd.uniform(10, 5000)
        c_lt = rnd.uniform(0.1, 10)
        pst = rnd.uniform(0, 2000)
        debt = rnd.uniform(1, (c_lt * px + pst) * 0.99)
        kk = ((debt - pst) / c_lt) / px - 1.0
        k = D.kstar_value(pst, c_lt * px, debt, 0.0)
        assert k == pytest.approx(kk, rel=1e-10, abs=1e-12)


def test_position_metrics_on_real_fixture():
    """Frozen anonymised fixture of real Aave V3 accounts (no address): the rebuilt HF matches Aave's
    getUserAccountData HF within D.HF_TOL, and k* equals the r111v5 lines on the same arrays."""
    fx = json.load(open(FIX))
    assert not re.search(r"0x[0-9a-fA-F]{40}", json.dumps(fx))
    n = 0
    for chain, blk in fx["chains"].items():
        market = {"reserves": {k: dict(r, config=int(r["config"])) for k, r in blk["reserves"].items()},
                  "emode": blk["emode"]}
        keys = sorted(market["reserves"])
        stable = np.array([D.is_stable(market["reserves"][k]["symbol"]) for k in keys])
        pxh = np.array([market["reserves"][k]["price"] / 1e8 for k in keys])
        for acc in blk["accounts"]:
            det = {"emode": acc["emode"], "bal": {k: (int(c), int(d)) for k, (c, d) in acc["bal"].items()}}
            pm = D.position_metrics(market, det)
            assert abs(pm["hf"] / acc["hfAave"] - 1.0) <= D.HF_TOL, (chain, acc["hfAave"], pm["hf"])
            lt = D.eff_lt(market, acc["emode"])
            cLT = np.array([int(det["bal"].get(k, (0, 0))[0]) / 10 ** market["reserves"][k]["dec"] * lt[k]
                            for k in keys])
            debt_u = np.array([int(det["bal"].get(k, (0, 0))[1]) / 10 ** market["reserves"][k]["dec"] for k in keys])
            ref = r111v5_kstar(cLT[None, :], debt_u[None, :], pxh, stable)[0]
            if pm["kstar"] is None:
                assert not np.isfinite(ref)
            else:
                assert pm["kstar"] == pytest.approx(float(ref), rel=1e-9, abs=1e-12)
            n += 1
    assert n >= 50


# ---------------------------------------------------------------------------------------------------------------------
# episode state machine (RULING Q26-R27)
# ---------------------------------------------------------------------------------------------------------------------
def walk(ds, touches=(), acts=(), liqs=(), closed_at=(), line=None, spot=()):
    st, out = None, []
    for i, d in enumerate(ds):
        st, ev = D.step_episode(st, i * HOUR, d, i in touches, i in acts, i in liqs, i in closed_at,
                                line=line, spot_through=i in spot)
        out += [(i, e[0], e[1] if e[0] == "end" else None) for e in ev]
    return st, out


def test_episode_opens_inside_band_and_alerts_once():
    st, ev = walk([0.20, 0.09, 0.05, 0.029, 0.02, 0.031, 0.025])
    assert [(i, k) for i, k, _ in ev] == [(1, "open"), (3, "atrisk")]
    assert st["status"] == "open" and st["alert"] == 3 * HOUR


def test_no_episode_when_already_through_or_unknown():
    st, ev = walk([0.0, -0.01, None, 0.15])
    assert ev == [] and st is None


def test_exit_rearms_and_second_episode_alerts_again():
    st, ev = walk([0.08, 0.02, 0.11, 0.09, 0.025])
    assert [(i, k, r) for i, k, r in ev] == [(0, "open", None), (1, "atrisk", None), (2, "end", "exit"),
                                             (3, "open", None), (4, "atrisk", None)]


def test_touch_disarms_until_rearm():
    st, ev = walk([0.05, 0.02, 0.01, 0.02, 0.05, 0.09, 0.12, 0.08], touches={2})
    kinds = [(i, k, r) for i, k, r in ev]
    assert (2, "end", "touch") in kinds and (2, "actnow", None) in kinds
    assert not any(k == "open" and 2 < i < 7 for i, k, _ in ev)       # disarmed through 0.09 (inside the band)
    assert (7, "open", None) in kinds                                  # re-armed after 0.12 > 10 %


def test_disarmed_rearms_on_act_or_liquidation():
    _, ev = walk([0.05, 0.02, 0.03, 0.04, 0.05], touches={1}, acts={3})
    assert [(i, k) for i, k, _ in ev if k == "open"] == [(0, "open"), (4, "open")]
    _, ev = walk([0.05, 0.02, 0.03, 0.04], touches={1}, liqs={2})
    assert [(i, k) for i, k, _ in ev if k == "open"] == [(0, "open"), (3, "open")]


def test_end_reasons_and_precedence():
    _, ev = walk([0.05, 0.04], acts={1}, liqs={1})
    assert ev[-1][1:] == ("end", "liq")
    _, ev = walk([0.05, 0.04], acts={1})
    assert ev[-1][1:] == ("end", "act")
    _, ev = walk([0.05, 0.04], closed_at={1})
    assert ev[-1][1:] == ("end", "closed")


def test_unknown_distance_pauses_open_episode():
    st, ev = walk([0.05, None, None, 0.02])
    assert [(i, k) for i, k, _ in ev] == [(0, "open"), (3, "atrisk")]


def test_act_now_once_per_episode_and_line_frozen():
    st, ev = walk([0.05, 0.04, 0.03, 0.02], spot={1, 2}, line=123.0)
    assert [(i, k) for i, k, _ in ev] == [(0, "open"), (1, "actnow"), (2, "atrisk")]
    assert st["L"] == 123.0


# ---------------------------------------------------------------------------------------------------------------------
# logs
# ---------------------------------------------------------------------------------------------------------------------
def _addr(i):
    return "0x" + format(i, "040x")


def _topic(a):
    return "0x" + "0" * 24 + a[2:]


def test_parse_logs_liquidation_tx_is_not_an_action():
    u1, u2, u3 = _addr(1), _addr(2), _addr(3)
    pool = [
        {"topics": [D.TOPIC["Borrow"], _topic(_addr(9)), _topic(u1)], "transactionHash": "0x01"},
        {"topics": [D.TOPIC["LiquidationCall"], _topic(_addr(8)), _topic(_addr(7)), _topic(u2)],
         "transactionHash": "0x02"},
        {"topics": [D.TOPIC["CollOff"], _topic(_addr(9)), _topic(u2)], "transactionHash": "0x02"},
        {"topics": [D.TOPIC["Repay"], _topic(_addr(9)), _topic(u3), _topic(u3)], "transactionHash": "0x03"},
        {"topics": [D.TOPIC["EMode"], _topic(u2)], "transactionHash": "0x04"},
    ]
    bt = [{"topics": [D.TOPIC["BalanceTransfer"], _topic(u2), _topic(_addr(5))], "transactionHash": "0x02"}]
    borrows, acted, liq, n = D.parse_logs(pool, bt)
    assert borrows == [u1] and liq == {u2} and n == 1
    assert acted == {u1, u3, u2, _addr(5)}       # u2 acted in its own later tx 0x04; the liquidator received aTokens


# ---------------------------------------------------------------------------------------------------------------------
# input III
# ---------------------------------------------------------------------------------------------------------------------
def test_iii_bars_equal_d13_twap():
    rnd = random.Random(5)
    t0 = 1_790_000_000 - 1_790_000_000 % HOUR
    m1 = {}
    p = 100.0
    for j in range(60 * 30):
        p *= math.exp(rnd.gauss(0, 0.001))
        if rnd.random() > 0.02:
            m1[(t0 + 60 * j) * 1000] = round(p, 4)
    bars = D.iii_bars(m1, t0 + HOUR, t0 + 29 * HOUR)
    closes = [m1.get((t0 + 60 * j) * 1000) for j in range(60 * 29)]
    lo, hi, cl = TW.bars_from_closes(closes)
    for j in range(1, 29):
        assert bars[t0 + HOUR * j] == (lo[j], hi[j], cl[j])


# ---------------------------------------------------------------------------------------------------------------------
# end to end with stubbed chains: privacy, ledger, stale chains
# ---------------------------------------------------------------------------------------------------------------------
class Args:
    def __init__(self, out):
        self.out = out


def _fake_klines(base, now_s):
    def get(url):
        q = dict(x.split("=") for x in url.split("?")[1].split("&"))
        start = int(q["startTime"])
        rows = []
        t = start
        while t + 60000 <= now_s * 1000 and len(rows) < 1000:
            rows.append([t, "0", "0", "0", f"{base:.2f}", "0", t + 59999])
            t += 60000
        return json.dumps(rows).encode()
    return get


def _fake_chain(n_pos, d_by_pos, acted=(), liq=(), single="WETH"):
    def chain_pass(root, chain, cfg, deadline, watch, rpc=None, log=print):
        if chain == "bnb":
            raise D.Stale("time budget")
        if chain == "base":
            return {"status": "pending", "why": "no bootstrap"}
        pos = {}
        for i in range(n_pos):
            a = _addr(1000 + i)
            k = D.pos_key(chain, a)
            d = d_by_pos(i)
            pos[k] = {"debt_base": 5000.0, "hf_aave": 1.05, "d": d, "kstar": (None if d is None else -d),
                      "asset": single, "single": single, "hf": 1.05, "debt_usd": 5000.0, "detail": True}
        key = lambda s: {D.pos_key(chain, _addr(1000 + i)) for i in s}  # noqa: E731
        return {"status": "ok", "block": 100, "head": 100, "blockTs": 0, "lo": 1, "lagBlocks": 0, "positions": pos,
                "acted": key(acted), "liq": key(liq), "nLiq": len(liq), "newAddrs": [_addr(5000)],
                "borrowers": n_pos + 1, "failedCalls": 0, "screened": n_pos, "unresolved": 0, "logs": 3, "sec": 0.1,
                "rpc": {}, "backfill": None}
    return chain_pass


def _public_text(root):
    out = []
    for dp, _, fs in os.walk(D.pub_dir(root)):
        for n in fs:
            raw = open(os.path.join(dp, n), "rb").read()
            out.append(gzip.decompress(raw).decode() if n.endswith(".gz") else raw.decode())
    return "\n".join(out)


def test_end_to_end_privacy_ledger_and_stale(tmp_path, monkeypatch):
    root = str(tmp_path)
    t0 = 1_793_000_000 - 1_793_000_000 % 86400 + 23 * HOUR       # 23:00Z, then 00:00Z next day
    logs = []
    monkeypatch.setattr(D, "chain_pass", _fake_chain(40, lambda i: [0.005, 0.015, 0.03, 0.04, 0.08, 0.2, None][i % 7]))
    for h in range(3):
        now = t0 + h * HOUR + 600
        rc = D.run_hour(Args(root), log=logs.append, now=now, http_get=_fake_klines(2000.0, now))
        assert rc == 0
    # stale and pending chains never crash the run and keep no state
    assert not os.path.exists(os.path.join(D.priv_dir(root, "bnb"), "state.jsonl"))
    lines = [json.loads(x) for f in sorted(os.listdir(os.path.join(D.pub_dir(root), "hourly")))
             for x in open(os.path.join(D.pub_dir(root), "hourly", f))]
    assert len(lines) == 3
    assert all(L["chains"]["bnb"]["status"] == "stale" and L["chains"]["base"]["status"] == "pending" for L in lines)
    eth = lines[0]["chains"]["ethereum"]
    assert eth["status"] == "ok" and eth["coldStart"] is True and lines[1]["chains"]["ethereum"]["coldStart"] is False
    assert sum(eth["bands"]["oracle"]["WETH"]["n"]) == sum(1 for i in range(40) if i % 7 < 5)
    assert sum(v.get("atrisk", 0) for v in eth["events"]["oracle"].values()) == sum(1 for i in range(40) if i % 7 < 3)
    # ledger: two UTC days, chained
    assert D.verify_ledger(root) == 2
    # privacy: no address pattern and no private key in any public file or log line
    pub = _public_text(root)
    assert D.scan_public_for_addresses(root) == 0
    assert not re.search(r"0x[0-9a-fA-F]{40}", pub)
    keys = {D.pos_key(ch, _addr(1000 + i)) for ch in D.CHAIN_ORDER for i in range(40)}
    assert not any(k in pub for k in keys)
    assert not any(re.search(r"0x[0-9a-fA-F]{40}|[0-9a-f]{20}", ln) for ln in logs)
    # the private store holds the state (keys) and the address files
    st = D.load_state(root, "ethereum")
    assert st and all(k in keys for (k, _) in st)
    assert D.load_addresses(root, "ethereum") == [_addr(5000)] * 3
    # the hour is checked once
    assert D.run_hour(Args(root), log=logs.append, now=t0 + 2 * HOUR + 1200, http_get=_fake_klines(2000.0, 0)) == 0
    assert logs[-1].startswith("d14 run: none")


def test_privacy_scanner_catches_an_address(tmp_path):
    root = str(tmp_path)
    D.append_line(os.path.join(D.pub_dir(root), "hourly", "x.jsonl"), {"a": 1})
    assert D.scan_public_for_addresses(root) == 0
    D.append_line(os.path.join(D.pub_dir(root), "hourly", "x.jsonl"), {"oops": _addr(77)})
    assert D.scan_public_for_addresses(root) == 1


def test_ledger_tamper_is_detected(tmp_path, monkeypatch):
    root = str(tmp_path)
    t0 = 1_793_000_000 - 1_793_000_000 % 86400 + 23 * HOUR
    monkeypatch.setattr(D, "chain_pass", _fake_chain(5, lambda i: 0.05))
    for h in range(2):
        D.run_hour(Args(root), log=lambda s: None, now=t0 + h * HOUR + 60, http_get=_fake_klines(2000.0, t0 + h * HOUR + 60))
    assert D.verify_ledger(root) == 2
    p = os.path.join(D.pub_dir(root), "daily", sorted(os.listdir(os.path.join(D.pub_dir(root), "daily")))[0])
    raw = bytearray(open(p, "rb").read())
    doc = json.loads(gzip.decompress(bytes(raw)))
    doc["date"] = "1999-01-01"
    open(p, "wb").write(D.gz(doc))
    with pytest.raises(SystemExit):
        D.verify_ledger(root)


def test_iii_episode_touch_from_twap_low(tmp_path, monkeypatch):
    """III arm: the line freezes at G(c) (1 + k*); a later TWAP hour low at or under it ends the episode as a touch."""
    root = str(tmp_path)
    t0 = 1_793_000_000 - 1_793_000_000 % 86400 + 2 * HOUR
    monkeypatch.setattr(D, "chain_pass", _fake_chain(1, lambda i: 0.05))
    D.run_hour(Args(root), log=lambda s: None, now=t0 + 60, http_get=_fake_klines(2000.0, t0 + 60))
    st = D.load_state(root, "ethereum")
    iii = [v for (k, arm), v in st.items() if arm == "iii"]
    assert len(iii) == 1 and iii[0]["L"] == pytest.approx(2000.0 * 0.95)
    D.run_hour(Args(root), log=lambda s: None, now=t0 + HOUR + 60, http_get=_fake_klines(1890.0, t0 + HOUR + 60))
    st = D.load_state(root, "ethereum")
    iii = [v for (k, arm), v in st.items() if arm == "iii"]
    assert iii[0]["status"] == "disarmed"


def test_backfill_step_discovers_and_survives_stale(tmp_path):
    d = str(tmp_path)
    D.write_atomic(os.path.join(d, "backfill.json"), D.dumps({"start": 100, "next": 100, "end": 349, "chunk": 100}))

    class FakeRpc:
        deadline = None
        interval = 0.0
        calls = 0

        def logs(self, address, topics, lo, hi):
            FakeRpc.calls += 1
            if FakeRpc.calls == 3:
                raise D.Stale("time budget")
            return [{"topics": [D.TOPIC["Borrow"], _topic(_addr(9)), _topic(_addr(lo))]}]

    addrs, index, new = [_addr(100)], {_addr(100): 0}, []
    r = D.backfill_step(FakeRpc(), "bnb", D.CHAINS["bnb"], d, index, addrs, new, None, budget=60)
    assert r == {"complete": False, "found": 1, "doneShare": 0.8}       # 100..199 known, 200..299 new, then stale
    assert new == [_addr(200)] and addrs == [_addr(100), _addr(200)]
    r = D.backfill_step(FakeRpc(), "bnb", D.CHAINS["bnb"], d, index, addrs, new, None, budget=60)
    assert r["complete"] is True and new == [_addr(200), _addr(300)]
    assert D.backfill_step(FakeRpc(), "bnb", D.CHAINS["bnb"], d, index, addrs, new, None) == {"complete": True}
