"""Q26 R33: registered replication of the borrower "at risk" alert (R0 at exactly 3 %) on Aave V3 Ethereum (Core
Pool), under the SAME registered rule and score code as R30 and R31 (r30_replicate.py, r27_atrisk.py, r29_timer.py
unchanged). No retuning.

Registration: r33/REGISTRATION.md (scratch; written and hashed before any Ethereum label row, episode or score).

This wrapper adds ONLY the Ethereum market parameters (Pool, oracle, deployment block, USDC reserve, keyless
endpoints, range size, e-mode id range) and the Ethereum stable symbols. The filters, compaction, label construction,
episode build and score are the unchanged R11.1-v3 / R30 / R27 / R29 code.

  python3 r33_ethereum.py acquire reserves|logs|meta|stable|bt|liq --work ETHW [--threads 3]
  python3 r33_ethereum.py labels  --work ETHW --scr SCR --datasets DS     # r30_replicate.cmd_labels, Ethereum params
  python3 r33_ethereum.py hfcheck --work ETHW --scr SCR --out OUT         # rebuilt HF vs getUserAccountData (keyless)
  python3 r27_atrisk.py build --datasets DS --scr SCR --work R27WORK     # unchanged
  python3 r30_replicate.py score --work R27WORK --out OUT --chain ethereum --ref r30-polygon.json   # unchanged
  python3 r33_secondary.py --work R27WORK --out OUT/r33-secondary.json                             # non-gating

Keyless endpoints only. A keyed URL in the environment (Q26_ETH_RPC_URL) is refused: the command exits.
"""
from __future__ import annotations

import os
import sys

if os.environ.get("Q26_ETH_RPC_URL"):
    sys.exit("R33 runs keyless only: unset Q26_ETH_RPC_URL")

import argparse  # noqa: E402
import datetime as dt  # noqa: E402
import json  # noqa: E402
import threading  # noqa: E402
from concurrent.futures import ThreadPoolExecutor  # noqa: E402

import numpy as np  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import r111v3_acquire as A  # noqa: E402
import r111v3_rpc as X  # noqa: E402
import r30_replicate as R30  # noqa: E402

CHAIN = "ethereum"
SPAN = 50_000
# Keyless endpoints (probed 2026-10-25):
#  - Tenderly public gateways (two URLs): eth_getLogs with blockTimestamp, result cap 20,000 logs (the error names a
#    narrower range, which the client uses to split); archive eth_call from the Pool deployment.
#  - rpc.mevblocker.io: eth_getLogs with blockTimestamp; wide ranges with many results answer -32603 "service
#    temporarily unavailable" (split below); archive eth_call.
#  - eth.drpc.org: archive eth_call; eth_getLogs capped at 10,000 blocks on the free plan (calls only).
#  - Refused: ethereum-rpc.publicnode.com (archive logs and calls need a personal token).
TENDERLY = ["https://mainnet.gateway.tenderly.co", "https://gateway.tenderly.co/public/mainnet"]
MEVBLOCKER = "https://rpc.mevblocker.io"
DRPC = "https://eth.drpc.org"
X.ENDPOINTS[CHAIN] = TENDERLY + [MEVBLOCKER]
X.CALL_ENDPOINTS[CHAIN] = TENDERLY + [DRPC, MEVBLOCKER]
X.HEADER_ENDPOINTS[CHAIN] = TENDERLY + [MEVBLOCKER]

SPLIT_MSGS = (b"service temporarily unavailable", b"response too large", b"is limited to")


class EthClient(X.Client):
    """r111v3_rpc.Client with one acquisition rule (the R31 OpClient pattern): an eth_getLogs answer of HTTP 413, or of
    HTTP 400/503 / JSON-RPC "service temporarily unavailable" / "response too large" on a range of MIN_SPLIT blocks or
    more, raises TooMany, so the client splits the range in two (a stack partition: no gap, no duplicate). On a
    narrower range it stays a retried error, so a real outage still fails loudly."""
    MIN_SPLIT = 2_000

    def _wide_logs(self, payload):
        try:
            q = json.loads(payload)
        except Exception:
            return False
        if not isinstance(q, dict) or q.get("method") != "eth_getLogs":
            return False
        f = q["params"][0]
        return int(f["toBlock"], 16) - int(f["fromBlock"], 16) >= self.MIN_SPLIT

    def _post(self, url, payload, timeout=120):
        import urllib.error
        try:
            body = super()._post(url, payload, timeout)
        except urllib.error.HTTPError as e:
            raw = e.read()[:400] if e.code in (400, 413, 503) else b""
            if (e.code == 413 or any(m in raw.lower() for m in SPLIT_MSGS)) and self._wide_logs(payload):
                with self.lock:
                    self.stats["backend_splits"] = self.stats.get("backend_splits", 0) + 1
                raise X.TooMany(None)
            raise
        if isinstance(body, dict) and "error" in body and self._wide_logs(payload):
            msg = str(body["error"].get("message", "")).lower().encode()
            if any(m in msg for m in SPLIT_MSGS):
                with self.lock:
                    self.stats["backend_splits"] = self.stats.get("backend_splits", 0) + 1
                raise X.TooMany(None)
        return body


X.Client = EthClient     # every phase of r111v3_acquire builds its client through X.Client
A.EMODE_IDS = range(1, 81)   # Ethereum lists 48 e-mode categories at head (probed); the R11.1-v3 default reads 1..40

FIRST_DAY_ETH = "2023-01-28"   # first meta anchor day: the first held Pool event is block 16,496,817 (2023-01-27 08:00Z)
A.MARKETS["eth"] = {
    "chain": CHAIN, "pool": "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2",
    "oracle": "0x54586be62e3c3580375ae3723c145253060ca0c2", "start": 16_291_127,
    "end_ts": int(dt.datetime(2026, 10, 1, tzinfo=dt.timezone.utc).timestamp()),
    "usdc": ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"],
    "span": SPAN, "first_day": FIRST_DAY_ETH}

FIRST_ORIGIN_ETH = dt.date.fromisoformat(FIRST_DAY_ETH) + dt.timedelta(days=1)
# Ethereum USD / EUR stables not already in r111v5_labels.STABLE_SYMS (fixed in REGISTRATION.md before any label row)
STABLE_EXTRA_ETH = {"crvUSD", "PYUSD", "USDS", "RLUSD", "USDe", "eUSDe", "USDtb", "EURC", "mUSD", "USDG"}


def cmd_logs(a):
    """r111v3_acquire.phase_logs for market eth, 50,000-block ranges over the keyless log endpoints."""
    m = A.MARKETS["eth"]
    rs = A.jload(os.path.join(a.work, "reserves.json.gz"))
    end = rs["end_block"]
    tok_map, res_idx = {}, {}
    for i, r in enumerate(rs["reserves"]):
        res_idx[r["asset"]] = i
        tok_map[r["aToken"]] = (i, 0)
        tok_map[r["vDebt"]] = (i, 1)
        if int(r["sDebt"], 16):
            tok_map[r["sDebt"]] = (i, 2)
    toks = sorted(tok_map)
    cl = X.Client(CHAIN, interval=0.2)
    T = A.T
    starts = list(range(m["start"], end + 1, SPAN))
    for sub in ("tok", "pool"):
        os.makedirs(os.path.join(a.work, sub), exist_ok=True)
    lock = threading.Lock()
    done = [0]

    def one(s):
        e = min(s + SPAN - 1, end)
        pt = os.path.join(a.work, "tok", f"{s}.npz")
        if not os.path.exists(pt):
            lg = cl.logs(toks, [[T["Mint"], T["Burn"], T["BalanceTransfer"], T["SMint"], T["SBurn"]]], s, e)
            A.npsave(pt, **A.compact_token(lg, tok_map))
        pp = os.path.join(a.work, "pool", f"{s}.npz")
        if not os.path.exists(pp):
            lg = cl.logs(m["pool"], [[T["RDU"], T["CollOn"], T["CollOff"], T["EMode"]]], s, e)
            A.npsave(pp, **A.compact_pool(lg, res_idx))
        with lock:
            done[0] += 1
            if done[0] % 5 == 0:
                print(f"{A.utcnow()} logs {done[0]}/{len(starts)} rpc {cl.stats}", flush=True)

    print(f"{A.utcnow()} ranges {len(starts)} to block {end}", flush=True)
    with ThreadPoolExecutor(a.threads) as ex:
        list(ex.map(one, starts))
    print(f"{A.utcnow()} logs done {len(starts)} ranges; rpc {cl.stats}", flush=True)


def cmd_acquire(a):
    os.makedirs(a.work, exist_ok=True)
    print(f"{A.utcnow()} start {a.phase} eth", flush=True)
    if a.phase == "logs":
        cmd_logs(a)
    else:
        {"reserves": A.phase_reserves, "meta": A.phase_meta, "stable": A.phase_stable, "bt": A.phase_bt,
         "liq": A.phase_liq}[a.phase]("eth", a.work)
    print(f"{A.utcnow()} end {a.phase} eth", flush=True)


def cmd_labels(a):
    R30.FIRST_ORIGIN_ARB = FIRST_ORIGIN_ETH
    R30.STABLE_EXTRA = STABLE_EXTRA_ETH
    R30.cmd_labels(a)


def cmd_hfcheck(a):
    """r31_optimism.cmd_hfcheck with the Ethereum Pool and keyless call endpoints (same sample, bar and output)."""
    import r111v3_engine as E
    HF_TOL, HF_SHARE, rr = R30.HF_TOL, R30.HF_SHARE, R30.rr
    rows = json.load(open(os.path.join(a.scr, "hf-sample.json")))
    inp = E.Inputs(a.work)
    uinv = {v: k for k, v in inp.uid.items()}
    del inp
    pool = A.MARKETS["eth"]["pool"]
    cl = X.Client(CHAIN, interval=0.1, calls=True)
    by_blk = {}
    for r in rows:
        by_blk.setdefault(r["block"], []).append(r)
    res_rows = []
    for blk, rr_ in sorted(by_blk.items()):
        calls = [(pool, X.sel("getUserAccountData(address)") + X.enc_addr("0x" + uinv[r["u"]].hex())) for r in rr_]
        outc = X.aggregate3(cl, calls, blk)
        for r, (ok, raw) in zip(rr_, outc):
            hc = X.word(raw, 5) / 1e18 if ok and len(raw) >= 192 else None
            e = abs(r["hf_model"] / hc - 1) if hc and hc > 0 and np.isfinite(r["hf_model"]) else float("inf")
            res_rows.append({"stratum": r["stratum"], "err": e, "emode": r["emode"]})
    out = {"bar": f"uniform AND near-line strata: rebuilt HF within {HF_TOL:.1%} of chain HF on >= {HF_SHARE:.0%} "
                  f"(R31 bar)", "rpc": cl.stats}
    for s in ("uniform", "near"):
        e = np.array([r["err"] for r in res_rows if r["stratum"] == s])
        fin = e[np.isfinite(e)]
        out[s] = {"n": int(len(e)), "within": int((e <= HF_TOL).sum()),
                  "share_within_0p1pct": rr(np.mean(e <= HF_TOL)) if len(e) else None,
                  "n_infinite": int((~np.isfinite(e)).sum()),
                  "err_q50_q90_q99_max": [float(np.quantile(fin, q)) for q in (0.5, 0.9, 0.99, 1.0)] if len(fin) else None}
    out["pass"] = bool(all(out[s]["n"] > 0 and out[s]["share_within_0p1pct"] >= HF_SHARE for s in ("uniform", "near")))
    os.makedirs(a.out, exist_ok=True)
    json.dump(out, open(os.path.join(a.out, "r33-hfcheck.json"), "w"), indent=1)
    print(json.dumps(out, indent=1))


def main():
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest="cmd", required=True)
    q = sp.add_parser("acquire")
    q.add_argument("phase", choices=["reserves", "logs", "meta", "stable", "bt", "liq"])
    q.add_argument("--work", required=True)
    q.add_argument("--threads", type=int, default=3)
    b = sp.add_parser("labels")
    for k in ("work", "scr", "datasets"):
        b.add_argument(f"--{k}", required=True)
    h = sp.add_parser("hfcheck")
    for k in ("work", "scr", "out"):
        h.add_argument(f"--{k}", required=True)
    a = ap.parse_args()
    {"acquire": cmd_acquire, "labels": cmd_labels, "hfcheck": cmd_hfcheck}[a.cmd](a)


if __name__ == "__main__":
    main()
