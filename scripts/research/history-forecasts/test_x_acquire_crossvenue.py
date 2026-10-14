"""Unit tests for x_acquire_crossvenue.py: ABI decode per token family, the universe filter, range
splitting and resume, share-path math on synthetic events (ERC-4626, Aave V2/V3, cToken, Comet), price
parsing, the TVL rule, gate math, and the soft multicall splitting.

Run: python3 -m unittest scripts/research/history-forecasts/test_x_acquire_crossvenue.py
"""

import json
import random
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import x_acquire_crossvenue as X  # noqa: E402

G, B = X.G, X.B
RAY = X.RAY
ZERO = "0x" + "00" * 20
TOKEN = "0xa3931d71877c0e7a3148cb7eb4463524fec27fbd"


def addr(i: int) -> str:
    return "0x" + f"{i:040x}"


def pad(a: str) -> str:
    return "0x" + "00" * 12 + a[2:]


def words(*ns) -> str:
    return "0x" + "".join(f"{n % (1 << 256):064x}" for n in ns)


# ---------------------------------------------------------------------------------------------
# Inputs and ABI
# ---------------------------------------------------------------------------------------------


class TestInputs(unittest.TestCase):
    def test_kind(self):
        self.assertEqual(X.token_kind("Spark", "convertToAssets(balanceOf)"), "erc4626")
        self.assertEqual(X.token_kind("AaveV2", "balanceOf (rebasing, =underlying)"), "atoken_v2")
        self.assertEqual(X.token_kind("AaveV2-AMM", "balanceOf (rebasing, =underlying)"), "atoken_v2")
        self.assertEqual(X.token_kind("Spark", "balanceOf (rebasing, =underlying)"), "atoken_v3")
        self.assertEqual(X.token_kind("Compound", "balanceOf (=supply base)"), "comet")
        self.assertEqual(X.token_kind("Venus", "balanceOf*exchangeRateStored/1e18"), "ctoken")
        with self.assertRaises(ValueError):
            X.token_kind("x", "something else")

    def test_bracket(self):
        self.assertEqual(X.parse_bracket("bracket(20353601..20603601)"), (20353601, 20603601))
        self.assertIsNone(X.parse_bracket("exact"))

    def test_signatures(self):
        c = X.check_signatures()
        self.assertTrue(c["ok"], c)
        # Aave V2 Mint and the Compound cToken Mint share a topic0; the kind disambiguates
        self.assertEqual(X.T["MintV2"], X.t0("Mint(address,uint256,uint256)"))
        self.assertEqual(X.DECODERS["atoken_v2"][X.T["MintV2"]], "MintV2")
        self.assertEqual(X.DECODERS["ctoken"][X.T["MintV2"]], "CMint")

    def test_calldata(self):
        self.assertEqual(X.cdata("balanceOf", addr(5)).hex(), "70a08231" + "00" * 31 + "05")
        self.assertEqual(X.cdata("convertToAssets", 10**18)[:4].hex(), "07a2d13a")
        self.assertEqual(int.from_bytes(X.cdata("convertToAssets", 10**18)[4:], "big"), 10**18)
        self.assertEqual(X.FSEL["totalAssets"].hex(), "01e1d114")
        self.assertEqual(X.FSEL["exchangeRateStored"].hex(), "182df0f5")
        self.assertEqual(X.FSEL["scaledBalanceOf"].hex(), "1da24f3e")
        self.assertEqual(X.FSEL["getReserveNormalizedIncome"].hex(), "d15e0053")

    def test_u256(self):
        self.assertEqual(X.u256(True, (7).to_bytes(32, "big")), (7, "ok"))
        self.assertEqual(X.u256(True, b""), (None, "empty"))
        self.assertEqual(X.u256(False, b""), (None, "fail"))
        self.assertEqual(X.s256((1 << 256) - 5), -5)


# ---------------------------------------------------------------------------------------------
# Decode per family
# ---------------------------------------------------------------------------------------------


class TestDecode(unittest.TestCase):
    def test_erc4626(self):
        ev = X.decode_event("erc4626", [X.T["Transfer"], pad(addr(1)), pad(addr(2))], words(500))
        self.assertEqual(ev["deltas"], [(addr(1), -500, -500), (addr(2), 500, 500)])
        ev = X.decode_event("erc4626", [X.T["Deposit"], pad(addr(1)), pad(addr(2))], words(1000, 990))
        self.assertEqual((ev["type"], ev["parties"], ev["values"], ev["deltas"]),
                         ("Deposit", [addr(1), addr(2)], [1000, 990], []))
        ev = X.decode_event("erc4626", [X.T["Withdraw"], pad(addr(1)), pad(addr(2)), pad(addr(3))], words(10, 9))
        self.assertEqual(ev["parties"], [addr(1), addr(2), addr(3)])
        with self.assertRaises(X.DecodeError):
            X.decode_event("erc4626", [X.T["Transfer"], pad(addr(1))], words(1, 2))

    def test_atoken_v3(self):
        idx = 11 * RAY // 10
        ev = X.decode_event("atoken_v3", [X.T["MintV3"], pad(addr(9)), pad(addr(1))], words(1_000_500, 500, idx))
        self.assertEqual(ev["deltas"], [(addr(1), 1_000_000, G.ray_div(1_000_000, idx))])
        ev = X.decode_event("atoken_v3", [X.T["BurnV3"], pad(addr(1)), pad(addr(2))], words(999_000, 1_000, idx))
        self.assertEqual(ev["deltas"][0][:2], (addr(1), -1_000_000))
        ev = X.decode_event("atoken_v3", [X.T["BalanceTransfer"], pad(addr(1)), pad(addr(2))], words(10**6, idx))
        self.assertEqual(ev["deltas"], [(addr(1), -1_100_000, -10**6), (addr(2), 1_100_000, 10**6)])
        ev = X.decode_event("atoken_v3", [X.T["Transfer"], pad(addr(1)), pad(addr(2))], words(5))
        self.assertEqual((ev["type"], ev["deltas"]), ("TransferInfo", []))

    def test_atoken_v2(self):
        idx = 12 * RAY // 10
        ev = X.decode_event("atoken_v2", [X.T["MintV2"], pad(addr(1))], words(1_200_000, idx))
        self.assertEqual(ev["deltas"], [(addr(1), 1_200_000, 1_000_000)])
        ev = X.decode_event("atoken_v2", [X.T["BurnV2"], pad(addr(1)), pad(addr(3))], words(600_000, idx))
        self.assertEqual(ev["deltas"], [(addr(1), -600_000, -500_000)])
        ev = X.decode_event("atoken_v2", [X.T["BalanceTransfer"], pad(addr(1)), pad(addr(2))], words(120, idx))
        self.assertEqual(ev["deltas"], [(addr(1), -120, -100), (addr(2), 120, 100)])  # V2: unscaled value
        with self.assertRaises(X.DecodeError):  # the V3 layout under the V2 decoder
            X.decode_event("atoken_v2", [X.T["MintV2"], pad(addr(1)), pad(addr(2))], words(1, 2))

    def test_comet(self):
        ev = X.decode_event("comet", [X.T["Transfer"], pad(ZERO), pad(addr(4))], words(777))
        self.assertEqual(ev["deltas"], [(ZERO, -777, None), (addr(4), 777, None)])
        ev = X.decode_event("comet", [X.T["Supply"], pad(addr(1)), pad(addr(4))], words(777))
        self.assertEqual((ev["type"], ev["parties"], ev["deltas"]), ("Supply", [addr(1), addr(4)], []))
        ev = X.decode_event("comet", [X.T["CometWithdraw"], pad(addr(4)), pad(addr(5))], words(3))
        self.assertEqual(ev["type"], "CometWithdraw")

    def test_ctoken(self):
        ev = X.decode_event("ctoken", [X.T["MintV2"]], words(int(addr(6), 16), 10**6, 4_900_000_000))
        self.assertEqual((ev["type"], ev["parties"], ev["values"], ev["deltas"]),
                         ("CMint", [addr(6)], [10**6, 4_900_000_000], []))
        ev = X.decode_event("ctoken", [X.T["Redeem4"]], words(int(addr(6), 16), 5, 6, 7))
        self.assertEqual((ev["type"], ev["values"]), ("CRedeem", [5, 6, 7]))
        ev = X.decode_event("ctoken", [X.T["Transfer"], pad(TOKEN), pad(addr(6))], words(4_900_000_000))
        self.assertEqual(ev["deltas"][1], (addr(6), 4_900_000_000, 4_900_000_000))

    def test_other_and_unknown(self):
        ev = X.decode_event("erc4626", [X.T["Approval"], pad(addr(1)), pad(addr(2))], words(1))
        self.assertEqual((ev["type"], ev["known"], ev["deltas"]), ("Approval", True, []))
        ev = X.decode_event("comet", [X.t0("SupplyCollateral(address,address,address,uint256)"), pad(addr(1)),
                                      pad(addr(2)), pad(addr(3))], words(9))
        self.assertEqual((ev["type"], ev["parties"]), ("SupplyCollateral", [addr(1), addr(2), addr(3)]))
        ev = X.decode_event("erc4626", ["0x" + "ab" * 32, pad(addr(1))], "0x1234")
        self.assertEqual((ev["type"], ev["known"], ev["parties"], ev["values"]), ("unknown", False, [addr(1)], []))

    def test_names_universe(self):
        U = {addr(7)}
        self.assertTrue(X.names_universe([X.T["Transfer"], pad(addr(1)), pad(addr(7))], words(5), U))
        self.assertTrue(X.names_universe([X.T["MintV2"]], words(int(addr(7), 16), 1, 2), U))  # data address
        self.assertFalse(X.names_universe([X.T["Transfer"], pad(addr(1)), pad(addr(2))], words(int(addr(8), 16)), U))
        self.assertFalse(X.names_universe([X.T["Transfer"]], "0x", U))
        self.assertFalse(X.names_universe([X.T["Transfer"], "0x" + "ff" * 12 + addr(7)[2:]], "0x", U))


# ---------------------------------------------------------------------------------------------
# Share paths on synthetic events
# ---------------------------------------------------------------------------------------------


class Vault:
    """ERC-4626 with linear share price; emits Transfer on mint / burn / transfer."""

    def __init__(self):
        self.sh = {}
        self.logs = []

    def mint(self, b, u, s):
        self.sh[u] = self.sh.get(u, 0) + s
        self.logs.append((b, [X.T["Transfer"], pad(ZERO), pad(u)], words(s)))
        self.logs.append((b, [X.T["Deposit"], pad(u), pad(u)], words(s * 2, s)))

    def burn(self, b, u, s):
        self.sh[u] -= s
        self.logs.append((b, [X.T["Transfer"], pad(u), pad(ZERO)], words(s)))

    def transfer(self, b, u, v, s):
        self.sh[u] -= s
        self.sh[v] = self.sh.get(v, 0) + s
        self.logs.append((b, [X.T["Transfer"], pad(u), pad(v)], words(s)))


def run_paths(kind, logs, snaps, U, comet_px=None):
    out = []
    pb = X.PathBuilder(snaps, U, lambda lab, a, v: out.append((lab, a, v)))
    for b, topics, data in logs:
        ev = X.decode_event(kind, topics, data)
        if ev["type"] in X.BALANCE_TYPES[kind]:
            for a, d, sc in ev["deltas"]:
                if kind == "comet":
                    sc = int(round(d * X.COMET_INDEX_SCALE / X.interp_index(comet_px[0], comet_px[1], b)))
                pb.apply(b, a, sc)
    pb.finish()
    return out, pb


class TestPaths(unittest.TestCase):
    def test_change_points_and_lookup(self):
        v = Vault()
        U = {addr(1), addr(2)}
        snaps = [("d1", 100), ("d2", 200), ("d3", 300), ("asof", 400)]
        v.mint(50, addr(1), 1000)
        v.mint(100, addr(2), 10)      # at the snapshot block: included in d1
        v.transfer(150, addr(1), addr(3), 400)   # addr(3) is not tracked
        v.burn(160, addr(2), 10)
        v.mint(170, addr(2), 10)      # round trip inside the interval: no change point at d2
        v.burn(350, addr(1), 600)
        out, pb = run_paths("erc4626", [(b, t, d) for b, t, d in v.logs], snaps, U)
        self.assertEqual(out, [("d1", addr(1), 1000), ("d1", addr(2), 10), ("d2", addr(1), 600),
                               ("asof", addr(1), 0)])
        self.assertEqual(pb.ever, {addr(1), addr(2)})
        self.assertEqual(pb.neg, set())
        pos = {lab: i for i, (lab, _) in enumerate(snaps)}
        pts = [(pos[lab], val) for lab, a, val in out if a == addr(1)]
        self.assertEqual([X.path_lookup(pts, i) for i in range(4)], [1000, 600, 600, 0])
        self.assertEqual(X.path_lookup([], 2), 0)

    def test_out_of_order_rejected(self):
        pb = X.PathBuilder([("d", 10)], None, lambda *a: None)
        pb.apply(5, addr(1), 1)
        with self.assertRaises(ValueError):
            pb.apply(4, addr(1), 1)

    def test_random_vault_matches_truth(self):
        rng = random.Random(3)
        v = Vault()
        users = [addr(i) for i in range(1, 7)]
        truth = {}
        snaps = [(f"s{k}", 1000 * k) for k in range(1, 11)]
        b = 1
        for _ in range(600):
            b += rng.randint(0, 30)
            u = rng.choice(users)
            r = rng.random()
            if r < 0.5 or not v.sh.get(u):
                v.mint(b, u, rng.randint(1, 10**24))
            elif r < 0.8:
                v.burn(b, u, rng.randint(1, v.sh[u]))
            else:
                v.transfer(b, u, rng.choice(users), rng.randint(0, v.sh[u]))
            for lab, sb in snaps:
                if sb >= b:
                    truth[lab] = dict(v.sh)
        snaps = [(lab, sb) for lab, sb in snaps if sb <= b + 1000]
        out, _ = run_paths("erc4626", v.logs, snaps + [("end", 10**9)], set(users))
        pos = {lab: i for i, (lab, _) in enumerate(snaps)}
        for lab, _ in snaps:
            if lab not in truth:
                continue
            for u in users:
                pts = [(pos.get(l2, 10**6), val) for l2, a, val in out if a == u]
                self.assertEqual(X.path_lookup(pts, pos[lab]), truth[lab].get(u, 0))

    def test_aave_v3_scaled_exact(self):
        sim = SimV3()
        U = {addr(1), addr(2)}
        rng = random.Random(5)
        index = RAY
        b = 0
        for _ in range(300):
            b += 3
            index += index * 30 // 10**9
            u = rng.choice(sorted(U))
            r = rng.random()
            if r < 0.5 or not sim.scaled.get(u):
                sim.mint(b, u, rng.randint(1, 10**12), index)
            elif r < 0.8:
                sim.burn(b, u, rng.randint(1, max(1, G.ray_mul(sim.scaled[u], index))), index)
            else:
                sim.transfer(b, u, addr(1) if u == addr(2) else addr(2), rng.randint(0, G.ray_mul(sim.scaled[u], index)), index)
        out, pb = run_paths("atoken_v3", sim.logs, [("end", b)], U)
        for lab, a, v in out:
            self.assertEqual(v, sim.scaled[a])
            self.assertEqual(X.underlying_from_shares("atoken_v3", v, {"income": index}), G.ray_mul(sim.scaled[a], index))

    def test_aave_v2_scaled_exact(self):
        idx = [RAY, RAY * 105 // 100, RAY * 11 // 10]
        logs = [(1, [X.T["MintV2"], pad(addr(1))], words(1_000_000, idx[0])),
                (2, [X.T["BalanceTransfer"], pad(addr(1)), pad(addr(2))], words(210_000, idx[1])),
                (3, [X.T["BurnV2"], pad(addr(2)), pad(addr(2))], words(110_000, idx[2]))]
        out, _ = run_paths("atoken_v2", logs, [("end", 3)], {addr(1), addr(2)})
        d = {a: v for _, a, v in out}
        self.assertEqual(d[addr(1)], 1_000_000 - G.ray_div(210_000, idx[1]))
        self.assertEqual(d[addr(2)], G.ray_div(210_000, idx[1]) - G.ray_div(110_000, idx[2]))

    def test_ctoken(self):
        logs = [(1, [X.T["Transfer"], pad(TOKEN), pad(addr(1))], words(5 * 10**10)),
                (2, [X.T["MintV2"]], words(int(addr(1), 16), 10**9, 5 * 10**10)),
                (3, [X.T["Transfer"], pad(addr(1)), pad(TOKEN)], words(10**10))]
        out, _ = run_paths("ctoken", logs, [("end", 3)], {addr(1)})
        self.assertEqual(out, [("end", addr(1), 4 * 10**10)])
        self.assertEqual(X.underlying_from_shares("ctoken", 4 * 10**10, {"rate": 2 * 10**16}), 8 * 10**8)

    def test_comet_principal(self):
        # index grows linearly per block; Transfer amounts are present values at the event's index
        blocks = [0, 100, 200]
        vals = [1.0e15, 1.01e15, 1.02e15]
        p1 = 10**9
        pv1 = int(p1 * X.interp_index(blocks, vals, 50) / 1e15)
        pv2 = int(p1 // 2 * X.interp_index(blocks, vals, 150) / 1e15)
        logs = [(50, [X.T["Transfer"], pad(ZERO), pad(addr(1))], words(pv1)),
                (150, [X.T["Transfer"], pad(addr(1)), pad(ZERO)], words(pv2))]
        out, _ = run_paths("comet", logs, [("end", 200)], {addr(1)}, comet_px=(blocks, vals))
        self.assertLessEqual(abs(out[0][2] - p1 // 2), 2)
        und = X.underlying_from_shares("comet", out[0][2], {"index": 1.02e15})
        self.assertLessEqual(abs(und - int(p1 // 2 * 1.02)), 3)

    def test_interp(self):
        self.assertEqual(X.interp_index([10, 20], [1.0, 2.0], 15), 1.5)
        self.assertEqual(X.interp_index([10, 20], [1.0, 2.0], 5), 1.0)
        self.assertEqual(X.interp_index([10, 20], [1.0, 2.0], 25), 2.0)
        self.assertEqual(X.interp_index([10, 20], [1.0, 2.0], 20), 2.0)

    def test_underlying_4626(self):
        p = {"assets": 1_050_000_000_000, "probe": 10**24}   # 1.05 USDC per 1e18 shares
        self.assertEqual(X.underlying_from_shares("erc4626", 2 * 10**18, p), 2_100_000)
        self.assertIsNone(X.underlying_from_shares("erc4626", 1, None))


class SimV3:
    """Scaled-balance token emitting events the way the Aave V3 aToken source does."""

    def __init__(self):
        self.scaled, self.last, self.logs = {}, {}, []

    def _bi(self, u, index):
        sb = self.scaled.get(u, 0)
        return G.ray_mul(sb, index) - G.ray_mul(sb, self.last.get(u, 0))

    def mint(self, b, u, amount, index):
        bi = self._bi(u, index)
        self.last[u] = index
        self.scaled[u] = self.scaled.get(u, 0) + G.ray_div(amount, index)
        self.logs.append((b, [X.T["Transfer"], pad(ZERO), pad(u)], words(amount + bi)))
        self.logs.append((b, [X.T["MintV3"], pad(addr(99)), pad(u)], words(amount + bi, bi, index)))

    def burn(self, b, u, amount, index):
        bi = self._bi(u, index)
        self.last[u] = index
        self.scaled[u] -= G.ray_div(amount, index)
        if bi > amount:
            self.logs.append((b, [X.T["MintV3"], pad(u), pad(u)], words(bi - amount, bi, index)))
        else:
            self.logs.append((b, [X.T["BurnV3"], pad(u), pad(u)], words(amount - bi, bi, index)))

    def transfer(self, b, s, r, amount, index):
        sbi, rbi = self._bi(s, index), self._bi(r, index)
        self.last[s] = self.last[r] = index
        sc = G.ray_div(amount, index)
        self.scaled[s] -= sc
        self.scaled[r] = self.scaled.get(r, 0) + sc
        if sbi > 0:
            self.logs.append((b, [X.T["MintV3"], pad(addr(98)), pad(s)], words(sbi, sbi, index)))
        if rbi > 0:
            self.logs.append((b, [X.T["MintV3"], pad(addr(98)), pad(r)], words(rbi, rbi, index)))
        self.logs.append((b, [X.T["BalanceTransfer"], pad(s), pad(r)], words(sc, index)))


class TestSilentMints(unittest.TestCase):
    def _evs(self, raw):
        return [X.decode_event("erc4626", t, d) for t, d in raw]

    def test_standard_vault_matched(self):
        evs = self._evs([([X.T["Transfer"], pad(ZERO), pad(addr(1))], words(990)),
                         ([X.T["Deposit"], pad(addr(9)), pad(addr(1))], words(1000, 990)),
                         ([X.T["Withdraw"], pad(addr(1)), pad(addr(2)), pad(addr(1))], words(500, 495)),
                         ([X.T["Transfer"], pad(addr(1)), pad(ZERO)], words(495))])
        self.assertEqual(X.erc4626_silent_shares(evs), {})

    def test_sdai_style_silent(self):
        # sDAI mints / burns shares without a Transfer event
        evs = self._evs([([X.T["Deposit"], pad(addr(9)), pad(addr(1))], words(1000, 990)),
                         ([X.T["Transfer"], pad(addr(1)), pad(addr(3))], words(100)),
                         ([X.T["Withdraw"], pad(addr(1)), pad(addr(2)), pad(addr(1))], words(500, 495))])
        self.assertEqual(X.erc4626_silent_shares(evs), {0: (addr(1), 990), 2: (addr(1), -495)})

    def test_amount_must_match(self):
        evs = self._evs([([X.T["Transfer"], pad(ZERO), pad(addr(1))], words(7)),
                         ([X.T["Deposit"], pad(addr(9)), pad(addr(1))], words(1000, 990))])
        self.assertEqual(X.erc4626_silent_shares(evs), {1: (addr(1), 990)})

    def test_tx_groups_and_slots(self):
        logs = [{"block": 1, "tx": "a"}, {"block": 1, "tx": "a"}, {"block": 1, "tx": "b"}, {"block": 2, "tx": "a"}]
        self.assertEqual([len(g) for g in X.iter_tx_groups(logs)], [2, 1, 1])
        d, sc = X.delta_slots([addr(1), addr(2), addr(1)], [(addr(1), -5, -5), (addr(2), 5, 5)])
        self.assertEqual((d, sc), ([-5, 5, None], [-5, 5, None]))
        d, _ = X.delta_slots([addr(9), addr(2), addr(1)], [(addr(1), -5, -5)])
        self.assertEqual(d, [None, None, -5])


# ---------------------------------------------------------------------------------------------
# Prices, TVL rule, gate
# ---------------------------------------------------------------------------------------------


def w32(n):
    return (n % (1 << 256)).to_bytes(32, "big")


class TestPricesTvlGate(unittest.TestCase):
    def test_tvl_value(self):
        c = {"kind": "ctoken"}
        self.assertEqual(X.tvl_value(c, [(True, w32(10**16)), (True, w32(2 * 10**16))]), (2 * 10**14, "ok"))
        self.assertEqual(X.tvl_value({"kind": "erc4626"}, [(True, b"")]), (0, "not_deployed"))
        self.assertEqual(X.tvl_value({"kind": "erc4626"}, [(False, b"")]), (None, "fail"))

    def test_price_comet(self):
        t = {"kind": "comet", "deploy_exact": 10}
        tb = b"".join(w32(x) for x in (1_050_000_000_000_000, 1_100_000_000_000_000, 0, 0, 2 * 10**14, 10**14,
                                       1_700_000_000, 0))
        p = X.price_value(t, [(True, w32(21 * 10**13)), (True, tb)], 20)
        self.assertAlmostEqual(p["index"], 1.05e15)
        self.assertEqual(p["lastAccrualTime"], 1_700_000_000)
        self.assertIsNone(X.price_value(t, [(True, b""), (True, b"")], 5))

    def test_price_other(self):
        t = {"kind": "erc4626", "deploy_exact": 1, "dec": 18}
        self.assertEqual(X.price_value(t, [(True, w32(123))], 5), {"assets": 123, "probe": 10**24})
        self.assertEqual(X.price_value(t, [(False, b"")], 5), {"status": "fail"})
        self.assertEqual(X.price_value({"kind": "atoken_v3", "deploy_exact": 1}, [(True, w32(RAY))], 5), {"income": RAY})

    def test_gate_pass(self):
        self.assertTrue(X.gate_pass(10_000_000, 0, 6))            # $10 absolute
        self.assertFalse(X.gate_pass(10_000_001, 0, 6))
        a = 10_000 * 10**6
        self.assertTrue(X.gate_pass(a + a * 5 // 1000, a, 6))     # 0.5% relative
        self.assertFalse(X.gate_pass(a + a * 5 // 1000 + 1, a, 6))
        self.assertTrue(X.gate_pass(10 * 10**18, 0, 18))          # 18-decimal underlying
        s = X.gate_summary([{"pass": True}] * 99 + [{"pass": False}])
        self.assertEqual((s["share"], s["passes"]), (0.99, True))
        s = X.gate_summary([{"pass": True}] * 98 + [{"pass": False}] * 2)
        self.assertFalse(s["passes"])
        self.assertIsNone(X.gate_summary([])["passes"])

    def test_share_tolerance(self):
        self.assertTrue(X.share_tolerance_ok("erc4626", 5, 5))
        self.assertFalse(X.share_tolerance_ok("erc4626", 5, 6))
        self.assertTrue(X.share_tolerance_ok("atoken_v3", 10**12 + 2, 10**12))
        self.assertTrue(X.share_tolerance_ok("comet", 0, -500))  # borrower: supply principal 0
        self.assertIsNone(X.share_tolerance_ok("ctoken", 1, None))


# ---------------------------------------------------------------------------------------------
# Ranges and resume
# ---------------------------------------------------------------------------------------------


def make_log(block, li):
    return {"address": TOKEN, "blockNumber": hex(block), "logIndex": hex(li), "transactionIndex": "0x0",
            "transactionHash": "0x" + f"{block:032x}{li:032x}", "blockHash": "0x" + f"{block:064x}",
            "blockTimestamp": hex(1_600_000_000 + 12 * block),
            "topics": [X.T["Transfer"], pad(addr(1)), pad(addr(2))], "data": words(1), "removed": False}


class FakeChain:
    """Logs at every 7th block; responses over max_logs logs fail like the endpoint's size limit; ranges
    wider than max_span fail with 'service temporarily unavailable'."""

    def __init__(self, max_logs=300, max_span=10**9, fail_always=()):
        self.max_logs, self.max_span, self.fail_always = max_logs, max_span, set(fail_always)
        self.calls = []

    def post(self, payload):
        req = json.loads(payload)
        p = req["params"][0]
        lo, hi = int(p["fromBlock"], 16), int(p["toBlock"], 16)
        self.calls.append((lo, hi))
        err = None
        lg = [make_log(b, 0) for b in range(lo, hi + 1) if b % 7 == 0]
        if (lo, hi) in self.fail_always or hi - lo + 1 > self.max_span:
            err = {"code": -32603, "message": "service temporarily unavailable"}
        elif len(lg) > self.max_logs:
            err = {"code": -32602, "message": "Log response size exceeded."}
        if err:
            return 200, json.dumps({"jsonrpc": "2.0", "id": req["id"], "error": err}).encode()
        return 200, json.dumps({"jsonrpc": "2.0", "id": req["id"], "result": lg}).encode()


def client_for(chain):
    return G.LogsClient(post=chain.post, interval=0, retry_wait=0, sleep=lambda s: None)


class TestRanges(unittest.TestCase):
    def test_next_size(self):
        self.assertEqual(X.next_size(0, 50_000), X.RANGE_MAX)
        self.assertEqual(X.next_size(X.TARGET_LOGS_PER_RANGE, 20_000), 20_000)
        self.assertEqual(X.next_size(10**7, 1_000), X.RANGE_MIN)

    def test_fetch_covers_everything(self):
        chain = FakeChain(max_logs=900, max_span=30_000)
        with tempfile.TemporaryDirectory() as d:
            store = G.LogStore(Path(d))
            st = X.fetch_token(store, client_for(chain), TOKEN, 3, 160_000, lambda ev: None, sleep=lambda s: None)
            got = [(x["block"], x["log_index"]) for x in store.iter_reserve(TOKEN)]
            self.assertEqual(got, [(b, 0) for b in range(3, 160_001) if b % 7 == 0])
            self.assertGreater(st["splits"], 0)
            for lo, hi in chain.calls:
                self.assertLessEqual(hi - lo + 1, X.RANGE_MAX)
            # the failure-aware cap keeps later ranges below the failing span
            n_fail = sum(1 for lo, hi in chain.calls if hi - lo + 1 > 30_000 or
                         len([b for b in range(lo, hi + 1) if b % 7 == 0]) > 900)
            self.assertLess(n_fail, len(chain.calls) / 2)

    def test_min_size_retries_then_stop(self):
        chain = FakeChain(max_logs=10)   # 1,000 blocks hold ~143 logs
        slept = []
        with tempfile.TemporaryDirectory() as d:
            store = G.LogStore(Path(d))
            with self.assertRaises(B.TerminalError):
                X.fetch_token(store, client_for(chain), TOKEN, 0, 5_000, lambda ev: None, sleep=slept.append)
        self.assertEqual(len(slept), X.MIN_SIZE_RETRIES)
        self.assertEqual(slept[0], X.RETRY_WAIT_S)

    def test_resume_fetches_only_gaps(self):
        chain = FakeChain(max_logs=10**6)
        with tempfile.TemporaryDirectory() as d:
            store = G.LogStore(Path(d))
            store.save(TOKEN, 0, 9_999, [])
            store.save(TOKEN, 20_000, 29_999, [])
            X.fetch_token(store, client_for(chain), TOKEN, 0, 39_999, lambda ev: None)
            self.assertEqual(chain.calls, [(10_000, 19_999), (30_000, 39_999)])
            self.assertEqual(G.uncovered(0, 39_999, store.done(TOKEN)), [])
            chain.calls.clear()
            X.fetch_token(G.LogStore(Path(d)), client_for(chain), TOKEN, 0, 39_999, lambda ev: None)
            self.assertEqual(chain.calls, [])

    def test_stop_flag(self):
        import threading
        ev = threading.Event()
        ev.set()
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(B.TerminalError):
                X.fetch_token(G.LogStore(Path(d)), client_for(FakeChain()), TOKEN, 0, 100, lambda e: None, stop=ev)


TOK_A = "0x" + "aa" * 20
TOK_B = "0x" + "bb" * 20


class MultiChain:
    """Two tokens: A logs every 7th block from block 0, B every 5th block from block 20,000. Responses over
    max_logs logs fail like the size limit; ranges wider than max_span fail like 'service unavailable'."""

    def __init__(self, max_logs=400, max_span=10**9):
        self.max_logs, self.max_span = max_logs, max_span
        self.calls = []

    def logs_of(self, a, lo, hi):
        step, start = (7, 0) if a == TOK_A else (5, 20_000)
        return [dict(make_log(b, 0 if a == TOK_A else 1), address=a) for b in range(max(lo, start), hi + 1)
                if b % step == 0]

    def post(self, payload):
        req = json.loads(payload)
        p = req["params"][0]
        lo, hi = int(p["fromBlock"], 16), int(p["toBlock"], 16)
        addrs = p["address"] if isinstance(p["address"], list) else [p["address"]]
        self.calls.append((lo, hi, tuple(addrs)))
        lg = sorted((x for a in addrs for x in self.logs_of(a, lo, hi)),
                    key=lambda x: (int(x["blockNumber"], 16), int(x["logIndex"], 16)))
        err = None
        if hi - lo + 1 > self.max_span:
            err = {"code": -32603, "message": "service temporarily unavailable"}
        elif len(lg) > self.max_logs:
            err = {"code": -32602, "message": "Log response size exceeded."}
        if err:
            return 200, json.dumps({"jsonrpc": "2.0", "id": req["id"], "error": err}).encode()
        return 200, json.dumps({"jsonrpc": "2.0", "id": req["id"], "result": lg}).encode()


class TestGroupSweep(unittest.TestCase):
    def _check_complete(self, store, end):
        got_a = [x["block"] for x in store.iter_reserve(TOK_A)]
        got_b = [x["block"] for x in store.iter_reserve(TOK_B)]
        self.assertEqual(got_a, [b for b in range(0, end + 1) if b % 7 == 0])
        self.assertEqual(got_b, [b for b in range(20_000, end + 1) if b % 5 == 0])
        self.assertEqual(G.uncovered(0, end, store.done(TOK_A)), [])
        self.assertEqual(G.uncovered(20_000, end, store.done(TOK_B)), [])
        self.assertEqual(store.done(TOK_B)[0][0], 20_000)   # nothing recorded before deployment

    def test_group_then_gap_pass(self):
        chain = MultiChain(max_logs=900, max_span=30_000)
        toks = [{"address": TOK_A}, {"address": TOK_B}]
        deploy = {TOK_A: 0, TOK_B: 20_000}
        with tempfile.TemporaryDirectory() as d:
            store = X.TokenLogStore(Path(d))
            store.save(TOK_A, 0, 12_345, [])        # earlier per-token coverage (partial)
            c = X.GroupLogsClient(post=chain.post, interval=0, retry_wait=0, sleep=lambda s: None)
            st = X.fetch_group_chunk(store, c, toks, deploy, 0, 60_000, lambda ev: None, sleep=lambda s: None)
            self.assertGreater(st["requests_ok"], 0)
            self.assertTrue(any(len(a) == 2 for _, _, a in chain.calls))   # both tokens in one request
            for t in toks:
                X.fetch_token(store, c, t["address"], deploy[t["address"]], 60_000, lambda ev: None,
                              sleep=lambda s: None)
            # earlier coverage had no logs in the store, so refill the expected A logs check from 12,346 on
            got_a = [x["block"] for x in store.iter_reserve(TOK_A)]
            self.assertEqual(got_a, [b for b in range(12_346, 60_001) if b % 7 == 0])
            self.assertEqual(G.uncovered(0, 60_000, store.done(TOK_A)), [])
            got_b = [x["block"] for x in store.iter_reserve(TOK_B)]
            self.assertEqual(got_b, [b for b in range(20_000, 60_001) if b % 5 == 0])
            # a reopened store sees the same coverage (n = 0 entries have no file)
            s2 = X.TokenLogStore(Path(d))
            self.assertEqual(s2.done(TOK_A), store.done(TOK_A))
            self.assertEqual([x["block"] for x in s2.iter_reserve(TOK_B)], got_b)

    def test_address_split_at_minimum(self):
        # 1,000 blocks hold ~143 A logs + ~200 B logs; the pair exceeds 250 but each alone fits
        chain = MultiChain(max_logs=250)
        toks = [{"address": TOK_A}, {"address": TOK_B}]
        deploy = {TOK_A: 0, TOK_B: 20_000}
        with tempfile.TemporaryDirectory() as d:
            store = X.TokenLogStore(Path(d))
            c = X.GroupLogsClient(post=chain.post, interval=0, retry_wait=0, sleep=lambda s: None)
            st = X.fetch_group_chunk(store, c, toks, deploy, 0, 30_000, lambda ev: None, sleep=lambda s: None)
            self.assertGreater(st["address_splits"], 0)
            self._check_complete(store, 30_000)

    def test_overlaps(self):
        with tempfile.TemporaryDirectory() as d:
            store = X.TokenLogStore(Path(d))
            store.save_many([(TOK_A, 100, 199, []), (TOK_A, 300, 399, [])])
            self.assertTrue(store.overlaps(TOK_A, 150, 160))
            self.assertTrue(store.overlaps(TOK_A, 0, 100))
            self.assertTrue(store.overlaps(TOK_A, 250, 300))
            self.assertFalse(store.overlaps(TOK_A, 200, 299))
            self.assertFalse(store.overlaps(TOK_A, 400, 500))
            self.assertFalse(store.overlaps(TOK_B, 0, 10**9))

    def test_group_validation(self):
        ok = [dict(make_log(5, 0), address=TOK_A)]
        self.assertEqual(list(X.validate_group_logs(ok, {TOK_A}, 0, 10)), [TOK_A])
        with self.assertRaises(G.RangeError):
            X.validate_group_logs(ok, {TOK_B}, 0, 10)
        big = [dict(make_log(1, i), address=TOK_A) for i in range(G.CAP_SUSPECT)]
        self.assertEqual(len(X.validate_group_logs(big, {TOK_A}, 0, 10)[TOK_A]), G.CAP_SUSPECT)  # <= 10k blocks
        with self.assertRaises(G.RangeError):
            X.validate_group_logs(big, {TOK_A}, 0, 20_000)


# ---------------------------------------------------------------------------------------------
# Soft multicall splitting
# ---------------------------------------------------------------------------------------------


class TestSoftMulticall(unittest.TestCase):
    def _rpc(self, max_ok):
        rpc = X.StateRpc("http://x", None, interval=0, retry_wait=0, sleep=lambda s: None)
        seen = []

        def post(payload):
            req = json.loads(payload)
            data = bytes.fromhex(req["params"][0]["data"][2:])
            n = int.from_bytes(data[4 + 32:4 + 64], "big")
            seen.append(n)
            if n > max_ok:
                return {"jsonrpc": "2.0", "id": req["id"], "error": {"code": -32000, "message": "out of gas"}}
            # n results of (true, uint 7)
            head = B.enc_word(32) + B.enc_word(n)
            tails = [B.enc_word(1) + B.enc_word(64) + B.enc_word(32) + B.enc_word(7) for _ in range(n)]
            offs, off = [], 32 * n
            for t in tails:
                offs.append(off)
                off += len(t)
            raw = head + b"".join(B.enc_word(o) for o in offs) + b"".join(tails)
            return {"jsonrpc": "2.0", "id": req["id"], "result": "0x" + raw.hex()}
        rpc._post = post
        return rpc, seen

    def test_split_on_error(self):
        rpc, seen = self._rpc(max_ok=3)
        calls = [(addr(1), X.cdata("totalSupply"))] * 10
        res = rpc.multicall_soft(calls, 100, "t")
        self.assertEqual(len(res), 10)
        self.assertTrue(all(ok and int.from_bytes(r, "big") == 7 for ok, r in res))
        self.assertGreater(rpc.counts["multicall_splits"], 0)
        self.assertFalse(rpc.stop.is_set())

    def test_single_call_failure_recorded(self):
        rpc, _ = self._rpc(max_ok=0)
        res = rpc.multicall_soft([(addr(1), X.cdata("totalSupply"))] * 2, 100, "t")
        self.assertEqual(res, [(False, b""), (False, b"")])

    def test_chunking(self):
        rpc, seen = self._rpc(max_ok=10**6)
        rpc.multicall_soft([(addr(1), X.cdata("totalSupply"))] * 25, 100, "t", max_calls=10)
        self.assertEqual(seen, [10, 10, 5])


if __name__ == "__main__":
    unittest.main()
