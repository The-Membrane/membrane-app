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


class _NoNetOracleRpc:
    """Default oracle-gap RPC in tests: every call fails (no network; also exercises failure isolation)."""

    def call(self, method, params, urls=None):
        raise D.Stale(f"{method}: URLError")

    def aggregate3(self, calls, block):
        raise D.Stale("aggregate3: URLError")


@pytest.fixture(autouse=True)
def _no_network_oracle(monkeypatch):
    monkeypatch.setattr(D, "make_oracle_rpc", lambda deadline: _NoNetOracleRpc())


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


def test_backfill_step_records_unreachable_history(tmp_path):
    d = str(tmp_path)
    D.write_atomic(os.path.join(d, "backfill.json"), D.dumps({"start": 100, "next": 100, "end": 999, "chunk": 100}))
    seen = []

    class FakeRpc:
        deadline = None
        interval = 0.0

        def logs(self, address, topics, lo, hi):
            seen.append(lo)
            return []

    cfg = {**D.CHAINS["bnb"], "log_depth": 500}
    addrs, index, new = [], {}, []
    r = D.backfill_step(FakeRpc(), "bnb", cfg, d, index, addrs, new, None, budget=60, head=1100)
    assert seen[0] == 600                                    # 100..599 is older than head - log_depth
    assert r == {"complete": True, "found": 0, "doneShare": 1.0, "unreachableBlocks": 500}
    bf = D.read_json(os.path.join(d, "backfill.json"))
    assert bf["unreachable"] == [[100, 599]] and bf["next"] == 1000
    assert D.backfill_step(FakeRpc(), "bnb", cfg, d, index, addrs, new, None, head=2000) == \
        {"complete": True, "unreachableBlocks": 500}
    # without a head (or a log_depth) nothing is skipped
    D.write_atomic(os.path.join(d, "backfill.json"), D.dumps({"start": 100, "next": 100, "end": 199, "chunk": 100}))
    seen.clear()
    D.backfill_step(FakeRpc(), "bnb", cfg, d, index, addrs, new, None, budget=60)
    assert seen == [100]


def test_stale_reason_carries_http_code():
    import urllib.error

    def post(url, payload, timeout):
        raise urllib.error.HTTPError(url, 403, "Forbidden", {}, None)

    rpc = D.Rpc("arbitrum", D.CHAINS["arbitrum"], post=post, tries=2, sleep=lambda s: None)
    try:
        rpc.call("eth_call", [{}, "latest"])
        raise AssertionError("expected Stale")
    except D.Stale as e:
        assert str(e) == "eth_call: HTTPError 403"
    assert D.CHAINS["arbitrum"]["call"][0] == "https://arbitrum.gateway.tenderly.co"
    assert D.CHAINS["bnb"]["log"][0][0] == "https://bsc.rpc.blxrbdn.com" and D.CHAINS["bnb"]["log_depth"] == 6_000_000


def test_out_of_gas_splits_and_400_rotates():
    import urllib.error
    seen = []

    def post(url, payload, timeout):
        n = json.loads(payload)["params"][0]["data"]
        seen.append(len(n))
        if len(seen) == 1:
            return {"jsonrpc": "2.0", "id": 1, "error": {"code": -32000, "message": "out of gas"}}
        if len(seen) == 2:
            raise urllib.error.HTTPError(url, 400, "Bad Request", {}, None)
        return {"jsonrpc": "2.0", "id": 1, "result": "0x"}

    rpc = D.Rpc("arbitrum", D.CHAINS["arbitrum"], post=post, tries=2, sleep=lambda s: None)
    try:
        rpc.call("eth_call", [{"to": D.MULTICALL3, "data": "0x00"}, "latest"])
        raise AssertionError("expected TooBig")
    except D.TooBig:
        pass
    # a 400 rotates and retries; the third answer succeeds, so no TooBig and no Stale
    assert rpc.call("eth_call", [{"to": D.MULTICALL3, "data": "0x00"}, "latest"]) == "0x"


def test_latest_state_chain_reads_latest():
    seen = []

    def post(url, payload, timeout):
        seen.append(json.loads(payload)["params"][1])
        return {"jsonrpc": "2.0", "id": 1, "result": "0x" + "00" * 64}

    assert D.CHAINS["bnb"].get("latest_state") is True and not D.CHAINS["ethereum"].get("latest_state")
    for ch, want in (("bnb", "latest"), ("ethereum", hex(123))):
        seen.clear()
        rpc = D.Rpc(ch, D.CHAINS[ch], post=post, tries=1, sleep=lambda s: None)
        try:
            rpc.aggregate3([(D.MULTICALL3, b"\x00")], 123)
        except Exception:
            pass
        assert seen and seen[0] == want


def test_incomplete_read_rotates_instead_of_failing_the_chain():
    # 2026-10-27 01:00Z Polygon: http.client.IncompleteRead is an HTTPException, not an OSError, so it used to
    # escape the endpoint rotation and mark the whole chain "error" for the hour.
    import http.client
    seen = []

    def post(url, payload, timeout):
        seen.append(url)
        if len(seen) == 1:
            raise http.client.IncompleteRead(b"partial")
        return {"jsonrpc": "2.0", "id": 1, "result": "0x"}

    rpc = D.Rpc("polygon", D.CHAINS["polygon"], post=post, tries=2, sleep=lambda s: None)
    assert rpc.call("eth_call", [{"to": D.MULTICALL3, "data": "0x00"}, "latest"]) == "0x"
    assert len(seen) == 2


# ---------------------------------------------------------------------------------------------------------------------
# oracle-gap arm (record only)
# ---------------------------------------------------------------------------------------------------------------------
# Reference copies of R38 build_long.py (membrane-datasets history-forecasts/r38/code, sha256 67d35516...): pool_twap
# for one pool series and gated(), verbatim apart from the globals they read.
def _r38_pool_twap(c, h, asset_is_token0, dec_a, dec_q, W):
    N = len(c)
    out = np.full(N, np.nan)
    k = W // 60
    ok = np.zeros(N, dtype=bool)
    ok[k:] = h[k:] & h[:-k]
    delta = np.zeros(N, dtype=np.int64)
    delta[k:] = c[k:] - c[:-k]
    mt = np.floor_divide(delta, W)
    sign = 1 if asset_is_token0 else -1
    out[ok] = np.exp(sign * mt[ok] * math.log(1.0001)) * 10 ** (dec_a - dec_q)
    return out


def _r38_gated(med, legacy, interval=3600, MAXDEV=0.05):
    n = len(med)
    served = np.full(n, np.nan)
    anchor, at = None, None
    step = interval // 60
    for i in range(n):
        m = med[i]
        if m != m:
            if legacy[i] == legacy[i]:
                served[i] = legacy[i]
            continue
        if anchor is None or abs(m - anchor) / min(m, anchor) <= MAXDEV:
            served[i] = m
        elif legacy[i] == legacy[i]:
            served[i] = legacy[i]
        if anchor is None:
            anchor, at = m, i
        elif i - at >= step:
            if abs(m - anchor) / min(m, anchor) <= MAXDEV:
                anchor = m
            else:
                anchor = anchor * (1 + MAXDEV) if m > anchor else anchor * (1 - MAXDEV)
            at = i
    return served


def test_og_constants_match_r38_routes():
    hops = {h for rs in D.OG_ROUTES.values() for r in rs for h in r}
    assert hops == set(D.OG_POOLS)
    assert D.OG_LEGACY == {"ETH": ("WETH", "USDC", 500), "BTC": ("WBTC", "USDC", 3000)}
    assert len(D.OG_ROUTES["ETH"]) == 5 and len(D.OG_ROUTES["BTC"]) == 5
    assert D.OG_MAXDEV == 0.05 and D.OG_W == 3600
    assert all(re.fullmatch(r"0x[0-9a-f]{40}", p) for p, _ in D.OG_POOLS.values())


# fixture tick cumulatives (minute grid) -- includes negative ticks and deltas not divisible by 3600 (floor rounding)
_TC_FIX = {("WETH", "USDC", 500): (196_000, 7), ("WETH", "USDT", 3000): (-196_100, -13),
           ("WBTC", "USDC", 3000): (66_300, 11), ("WBTC", "WETH", 500): (66_400 - 196_000 + 120, -5),
           ("WETH", "DAI", 3000): (-80_500, 3), ("WBTC", "USDT", 3000): (-66_350, 1)}


def test_og_pool_twap_matches_r38_on_fixture():
    rnd = random.Random(7)
    for key, (tick, drift) in _TC_FIX.items():
        N = 200
        ticks = [tick + drift * j + rnd.randint(-40, 40) for j in range(N)]
        c = np.zeros(N, dtype=np.int64)
        for j in range(1, N):
            c[j] = c[j - 1] + 60 * ticks[j] + rnd.randint(-59, 59)
        h = np.ones(N, dtype=bool)
        _, a0 = D.OG_POOLS[key]
        ref = _r38_pool_twap(c, h, a0, D.OG_DEC[key[0]], D.OG_DEC[key[1]], 3600)
        for j in range(60, N):
            got = D.og_pool_twap(key, int(c[j - 60]), int(c[j]))
            # same floor mean tick (exact) and price (math.exp vs numpy exp differ by at most an ulp or two)
            assert (int(c[j]) - int(c[j - 60])) // 3600 == int(np.floor_divide(c[j] - c[j - 60], 3600))
            assert got == pytest.approx(ref[j], rel=1e-14), (key, j)
    # a USDC/WETH tick near 196k is ETH near 3,078 USD
    assert D.og_pool_twap(("WETH", "USDC", 500), 0, 196_000 * 3600) == pytest.approx(3077.89, abs=0.01)


def test_og_observe_encoding_and_decoding():
    data = D.og_observe_data([3660, 60])
    assert data[:4].hex() == "883bdbfd" and len(data) == 4 + 32 * 4
    vals = [-123_456_789_012, 987_654_321]
    enc = D.enc_u(64) + D.enc_u(160) + D.enc_u(2) + b"".join(D.enc_u(v % (1 << 256)) for v in vals) \
        + D.enc_u(2) + D.enc_u(1) + D.enc_u(2)
    assert D.og_decode_tc(enc) == vals


def test_og_median_and_gate_match_r38_gated():
    assert D.og_median([3.0, None, 1.0, 2.0, float("nan")]) == (2.0, 3)
    assert D.og_median([4.0, 1.0, 2.0, 3.0]) == (2.5, 4)
    assert D.og_median([None, None]) == (None, 0)
    rnd = random.Random(3)
    H = 300
    med_h, leg_h = [], []
    p = 2000.0
    for i in range(H):
        p *= math.exp(rnd.gauss(0, 0.01))
        jump = 1.12 if 100 <= i < 104 else (0.9 if 200 <= i < 201 else 1.0)
        med_h.append(None if rnd.random() < 0.05 else p * jump)
        leg_h.append(None if rnd.random() < 0.05 else p * (1 + rnd.gauss(0, 0.001)))
    # R38 runs on a minute grid; with the median present only at hour points its anchor moves at those points
    med = np.full(H * 60, np.nan)
    leg = np.full(H * 60, np.nan)
    for i in range(H):
        med[i * 60] = np.nan if med_h[i] is None else med_h[i]
        leg[i * 60] = np.nan if leg_h[i] is None else leg_h[i]
    ref = _r38_gated(med, leg)
    st = None
    fired_n = 0
    for i in range(H):
        served, fired, src, st = D.og_gate(med_h[i], leg_h[i], st, i * HOUR)
        r = ref[i * 60]
        assert (served is None and r != r) or served == r, i
        fired_n += fired
        if fired:
            assert src in ("legacy", "none") and med_h[i] is not None
    assert fired_n >= 2      # the 12 % jump hours fire the gate


def _fake_oracle_rpc(bts, ticks, fail=(), revert=()):
    """Ethereum stub: block headers and Multicall3 observe() answers from constant ticks per pool."""
    by_pool = {D.OG_POOLS[k][0]: (k, t) for k, t in ticks.items()}

    class R:
        calls = []

        def call(self, method, params, urls=None):
            if method in fail:
                raise D.Stale(f"{method}: HTTPError 503")
            assert method == "eth_getBlockByNumber"
            if params[0] == "latest":
                return {"number": hex(1000), "timestamp": hex(bts + 36)}
            assert int(params[0], 16) == 1000 - D.CHAINS["ethereum"]["confirm"]
            return {"number": params[0], "timestamp": hex(bts)}

        def aggregate3(self, calls, block):
            if "aggregate3" in fail:
                raise D.Stale("aggregate3: too big")
            out = []
            for tgt, data in calls:
                k, t = by_pool[tgt]
                n = int.from_bytes(data[36:68], "big")
                ago = [int.from_bytes(data[68 + 32 * i:100 + 32 * i], "big") for i in range(n)]
                if k in revert:
                    out.append((False, b"OLD"))
                    continue
                tcs = [t * (bts - a) for a in ago]
                enc = D.enc_u(64) + D.enc_u(64 + 32 + 32 * n) + D.enc_u(n) \
                    + b"".join(D.enc_u(v % (1 << 256)) for v in tcs) + D.enc_u(n) + b"".join(D.enc_u(1) for _ in ago)
                out.append((True, enc))
            R.calls.append((block, ago))
            return out
    return R()


_TICKS = {("WETH", "USDC", 500): 196_000, ("WETH", "USDC", 3000): 196_010, ("WETH", "USDT", 500): -195_990,
          ("WETH", "USDT", 3000): -196_020, ("WETH", "DAI", 3000): 196_005,
          ("WBTC", "USDC", 500): 66_400, ("WBTC", "USDC", 3000): 66_390, ("WBTC", "USDT", 3000): 66_410,
          ("WBTC", "WETH", 500): 66_400 - 196_000 - 92_103, ("WBTC", "WETH", 3000): 66_395 - 196_000 - 92_103}


def test_oracle_gap_end_to_end_fake_rpc():
    bts = 1_793_000_000 - 1_793_000_000 % HOUR + 600 + 17
    m = (bts // 60) * 60 - 60
    rpc = _fake_oracle_rpc(bts, _TICKS)
    og, st = D.oracle_gap({}, bts + 40, rpc=rpc, http_get=_fake_klines(3000.0, bts + 40))
    assert og["status"] == "ok" and og["t"] == D.iso(m) and og["lagS"] == bts - m and og["poolsOk"] == 10
    block, ago = rpc.calls[0]
    assert block == 1000 - D.CHAINS["ethereum"]["confirm"] and ago == [bts - m + 3600, bts - m]
    eth = og["assets"]["ETH"]
    routes = [D.og_pool_twap(r[0], 0, _TICKS[r[0]] * 3600) for r in D.OG_ROUTES["ETH"]]
    assert eth["n_routes"] == 5 and eth["route_median"] == TW.round10(sorted(routes)[2])
    assert eth["oracle_gated"] == eth["route_median"] and eth["gate_fired"] is False and eth["served"] == "median"
    assert eth["iii"] == 3000.0 and eth["spot"] == 3000.0
    assert eth["gap_pct"] == round(TW.round10(sorted(routes)[2]) / 3000.0 - 1, 8)
    btc = og["assets"]["BTC"]
    assert btc["n_routes"] == 5 and 1e4 < btc["route_median"] < 1e6
    assert st["ETH"]["at"] == m and st["ETH"]["anchor"] == sorted(routes)[2]
    # next hour: an 11 % jump on every ETH route fires the gate and serves the legacy pool (which jumped too)
    t2 = {k: (v + (1044 if k[0] == "WETH" and k[1] != "WETH" else 0) * (1 if D.OG_POOLS[k][1] else -1)
              if k[0] == "WETH" else v) for k, v in _TICKS.items()}
    og2, st2 = D.oracle_gap(st, bts + HOUR + 40, rpc=_fake_oracle_rpc(bts + HOUR, t2),
                            http_get=_fake_klines(3000.0, bts + HOUR + 40))
    e2 = og2["assets"]["ETH"]
    assert e2["gate_fired"] is True and e2["served"] == "legacy" and e2["oracle_gated"] != e2["route_median"]
    assert st2["ETH"]["anchor"] == pytest.approx(st["ETH"]["anchor"] * 1.05)
    assert og2["assets"]["BTC"]["gate_fired"] is False


def test_oracle_gap_partial_and_total_failure():
    bts = 1_793_000_000 - 1_793_000_000 % HOUR + 900
    og, st = D.oracle_gap({}, bts + 40, rpc=_fake_oracle_rpc(bts, _TICKS, revert={("WETH", "USDT", 3000)}),
                          http_get=_fake_klines(3000.0, bts + 40))
    assert og["status"] == "ok" and og["poolsOk"] == 9 and og["assets"]["ETH"]["n_routes"] == 4
    # the legacy ETH/USDC 0.05 % pool missing removes one ETH route and the two BTC routes that hop through it
    og, _ = D.oracle_gap({}, bts + 40, rpc=_fake_oracle_rpc(bts, _TICKS, revert={("WETH", "USDC", 500)}),
                         http_get=_fake_klines(3000.0, bts + 40))
    assert og["assets"]["ETH"]["n_routes"] == 4 and og["assets"]["BTC"]["n_routes"] == 3
    for f in ("eth_getBlockByNumber", "aggregate3"):
        og, st2 = D.oracle_gap({"ETH": {"anchor": 1.0, "at": 0}}, bts, rpc=_fake_oracle_rpc(bts, _TICKS, fail=(f,)))
        assert og["status"] == "error" and "assets" not in og and st2 == {"ETH": {"anchor": 1.0, "at": 0}}
        assert not re.search(r"0x[0-9a-fA-F]{40}", json.dumps(og))
    # Binance down: oracle numbers stay, III and gap are null
    def bad_get(url):
        raise OSError("down")
    og, _ = D.oracle_gap({}, bts + 40, rpc=_fake_oracle_rpc(bts, _TICKS), http_get=bad_get)
    assert og["status"] == "ok" and og["assets"]["ETH"]["iii"] is None and og["assets"]["ETH"]["gap_pct"] is None
    assert og["assets"]["ETH"]["route_median"] is not None and len(og["iiiFailed"]) == 2


def test_run_hour_writes_oracle_gap_and_isolates_failure(tmp_path, monkeypatch):
    root = str(tmp_path)
    t0 = 1_793_000_000 - 1_793_000_000 % 86400 + 5 * HOUR
    monkeypatch.setattr(D, "chain_pass", _fake_chain(10, lambda i: [0.02, 0.05, 0.2][i % 3]))
    logs = []
    # hour 1: the oracle RPC fails (autouse stub) -> the run and every chain are unaffected
    assert D.run_hour(Args(root), log=logs.append, now=t0 + 600, http_get=_fake_klines(3000.0, t0 + 600)) == 0
    # hour 2: the oracle RPC answers
    now = t0 + HOUR + 600
    assert D.run_hour(Args(root), log=logs.append, now=now, http_get=_fake_klines(3000.0, now),
                      oracle_rpc=_fake_oracle_rpc(now - 30, _TICKS)) == 0
    lines = [json.loads(x) for x in open(os.path.join(D.pub_dir(root), "hourly", D.day_of(t0) + ".jsonl"))]
    assert lines[0]["oracleGap"]["status"] == "error" and lines[1]["oracleGap"]["status"] == "ok"
    for L in lines:
        assert L["chains"]["ethereum"]["status"] == "ok" and L["chains"]["bnb"]["status"] == "stale"
    # the arm changes no alert count: the chain lines are identical to a run without it
    assert lines[0]["chains"]["ethereum"]["bands"] == lines[1]["chains"]["ethereum"]["bands"]
    a = lines[1]["oracleGap"]["assets"]
    assert set(a) == {"ETH", "BTC"} and set(a["ETH"]) == {"oracle_gated", "route_median", "n_routes", "iii", "spot",
                                                          "gap_pct", "gate_fired", "served"}
    assert D.read_json(os.path.join(root, D.ROOT_REL, D.PRIV_SUB, "oracle-gap.json"))["ETH"]["anchor"] > 0
    assert D.scan_public_for_addresses(root) == 0
    pub = _public_text(root)
    assert not any(p in pub for p, _ in D.OG_POOLS.values())
    assert any(x.startswith("d14 oracle-gap: ok, ETH gap") for x in logs)
    assert any(x.startswith("d14 oracle-gap: error") for x in logs)
    assert not any(re.search(r"0x[0-9a-fA-F]{40}|[0-9a-f]{20}", ln) for ln in logs)
