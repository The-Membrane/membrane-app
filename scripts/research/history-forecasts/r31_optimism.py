"""Q26 R31: third-chain replication of the borrower "at risk" alert (R0 at exactly 3 %) on Aave V3 Optimism, under the
SAME registered rule and score code as R30 (r30_replicate.py, unchanged). No retuning.

Design, set status, pass rule and outputs: membrane-board design/q26-r31-third-chain-2026-10-25.md (registered before
any R31 score).

This wrapper adds ONLY the Optimism market parameters (Pool, oracle, deployment block, USDC reserves, keyless
endpoints, range size) and the Optimism stable symbols. The filters, compaction, label construction, episode build
and score are the unchanged R11.1-v3 / R30 / R27 / R29 code.

  python3 r31_optimism.py acquire reserves|logs|meta|stable|bt|liq --work OPW [--threads 4]
  python3 r31_optimism.py labels  --work OPW --scr SCR --datasets DS     # r30_replicate.cmd_labels, Optimism params
  python3 r31_optimism.py hfcheck --work OPW --scr SCR --out OUT         # rebuilt HF vs getUserAccountData (keyless)
  python3 r27_atrisk.py build --datasets DS --scr SCR --work R27WORK     # unchanged
  python3 r30_replicate.py score --work R27WORK --out OUT --chain optimism --ref r30-polygon.json   # unchanged
  python3 -I r31_breakdowns.py R27WORK POLYGON_R27WORK > OUT/r31-breakdowns.json   # R30-review breakdowns

Keyless endpoints only. A keyed URL in the environment (Q26_OP_RPC_URL) is refused: the command exits.
"""
from __future__ import annotations

import os
import sys

if os.environ.get("Q26_OP_RPC_URL"):
    sys.exit("R31 runs keyless only: unset Q26_OP_RPC_URL")

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

CHAIN = "optimism"
BEDROCK = 105_235_063          # first Bedrock block (2023-06-06); legacy blocks before it
SPAN = 100_000
# Keyless endpoints (probed 2026-10-25):
#  - mainnet.optimism.io: logs with blockTimestamp over the whole range (legacy and Bedrock), archive eth_call from the
#    Pool deployment.
#  - Tenderly public gateways: logs with blockTimestamp after Bedrock only (legacy logs come without it); eth_call on
#    legacy blocks answers "block not found". Used for Bedrock-era log ranges only.
#  - optimism.drpc.org: archive eth_call (legacy and Bedrock); eth_getLogs capped at 10,000 blocks (not used for logs).
#  - Refused: optimism-rpc.publicnode.com (archive needs a token), op-pokt.nodies.app (logs capped at 50 blocks, no
#    legacy state), 1rpc.io/op (usage limit), optimism-mainnet.public.blastapi.io (service closed).
OFFICIAL = "https://mainnet.optimism.io"
TENDERLY = ["https://optimism.gateway.tenderly.co", "https://gateway.tenderly.co/public/optimism"]
DRPC = "https://optimism.drpc.org"
X.ENDPOINTS[CHAIN] = [OFFICIAL]
X.CALL_ENDPOINTS[CHAIN] = [OFFICIAL, DRPC]
X.HEADER_ENDPOINTS[CHAIN] = [OFFICIAL]



class OpClient(X.Client):
    """r111v3_rpc.Client with one Optimism rule (acquisition only; added 2026-10-25 after registration, before any
    label or score). mainnet.optimism.io answers an eth_getLogs query with too large a result with HTTP 400 and
    JSON-RPC error -32020 "backend response too large", with HTTP 413, or (when its backend cannot finish in time)
    with HTTP 400 and -32011 "no backend is currently healthy to serve traffic". The unchanged client treats these
    as transient errors and retries the same range forever. Here, on a log range wider than
    MIN_SPLIT blocks, it raises TooMany, so the client splits the range in two (the same split it applies to result
    caps). On a narrower range it stays a retried error, so a real outage still fails loudly."""
    MIN_SPLIT = 2_000

    def _post(self, url, payload, timeout=120):
        import urllib.error
        try:
            return super()._post(url, payload, timeout)
        except urllib.error.HTTPError as e:
            body = e.read()[:400] if e.code == 400 else b""
            if e.code == 413 or b"backend response too large" in body or b"no backend is currently healthy" in body:
                q = json.loads(payload)
                if q.get("method") == "eth_getLogs":
                    f = q["params"][0]
                    if int(f["toBlock"], 16) - int(f["fromBlock"], 16) >= self.MIN_SPLIT:
                        with self.lock:
                            self.stats["backend_splits"] = self.stats.get("backend_splits", 0) + 1
                        raise X.TooMany(None)
            raise


X.Client = OpClient     # every phase of r111v3_acquire builds its client through X.Client

A.MARKETS["op"] = {
    "chain": CHAIN, "pool": "0x794a61358d6845594f94dc1db02a252b5b4814ad",
    "oracle": "0xd81eb3728a631871a7ebbad631b5f424909f0c77", "start": 4_365_693,
    "end_ts": int(dt.datetime(2026, 10, 1, tzinfo=dt.timezone.utc).timestamp()),
    "usdc": ["0x7f5c764cbc14f9669b88837ca1490cca17c31607", "0x0b2c639c533813f4aa9d7837caf62653d097ff85"],
    "span": SPAN, "first_day": "2022-03-15", "pap": "0xa97684ead0e402dc232d5a977953df7ecbab3cdb"}

# Label rows: same start as Polygon (r111v5_labels.FIRST_ORIGIN; keyless archive state exists from the Pool deployment)
FIRST_ORIGIN_OP = dt.date(2022, 3, 16)
# Optimism USD stables not already in r111v5_labels.STABLE_SYMS (registered in the design before any label row)
STABLE_EXTRA_OP = {"sUSD", "MAI"}


def cmd_logs(a):
    """r111v3_acquire.phase_logs for market op, 100,000-block ranges. Legacy ranges on mainnet.optimism.io only (the
    only keyless endpoint that returns their blockTimestamp); Bedrock ranges rotate over it and the Tenderly gateways."""
    m = A.MARKETS["op"]
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
    cl_old = X.Client(CHAIN, interval=0.25)
    cl_old.urls = [OFFICIAL]
    cl_new = X.Client(CHAIN, interval=0.15)
    cl_new.urls = TENDERLY + [OFFICIAL]
    T = A.T
    starts = list(range(m["start"], end + 1, SPAN))
    for sub in ("tok", "pool"):
        os.makedirs(os.path.join(a.work, sub), exist_ok=True)
    lock = threading.Lock()
    done = [0]

    def one(s):
        e = min(s + SPAN - 1, end)
        cl = cl_new if s >= BEDROCK else cl_old
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
            if done[0] % 50 == 0:
                print(f"{A.utcnow()} logs {done[0]}/{len(starts)} old {cl_old.stats} new {cl_new.stats}", flush=True)

    print(f"{A.utcnow()} ranges {len(starts)} to block {end}", flush=True)
    with ThreadPoolExecutor(a.threads) as ex:
        list(ex.map(one, starts))
    print(f"{A.utcnow()} logs done {len(starts)} ranges; old {cl_old.stats} new {cl_new.stats}", flush=True)


def cmd_acquire(a):
    os.makedirs(a.work, exist_ok=True)
    print(f"{A.utcnow()} start {a.phase} op", flush=True)
    if a.phase == "logs":
        cmd_logs(a)
    else:
        {"reserves": A.phase_reserves, "meta": A.phase_meta, "stable": A.phase_stable, "bt": A.phase_bt,
         "liq": A.phase_liq}[a.phase]("op", a.work)
    print(f"{A.utcnow()} end {a.phase} op", flush=True)


def cmd_labels(a):
    R30.FIRST_ORIGIN_ARB = FIRST_ORIGIN_OP
    R30.STABLE_EXTRA = STABLE_EXTRA_OP
    R30.cmd_labels(a)


def cmd_hfcheck(a):
    """r30_replicate.cmd_hfcheck with the Optimism Pool and keyless call endpoints (same sample, bar and output)."""
    import r111v3_engine as E
    HF_TOL, HF_SHARE, rr = R30.HF_TOL, R30.HF_SHARE, R30.rr
    rows = json.load(open(os.path.join(a.scr, "hf-sample.json")))
    inp = E.Inputs(a.work)
    uinv = {v: k for k, v in inp.uid.items()}
    del inp
    pool = A.MARKETS["op"]["pool"]
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
    out = {"bar": f"uniform stratum: rebuilt HF within {HF_TOL:.1%} of chain HF on >= {HF_SHARE:.0%}; near also "
                  f"reported and held to the same bar (R31 design)", "rpc": cl.stats}
    for s in ("uniform", "near"):
        e = np.array([r["err"] for r in res_rows if r["stratum"] == s])
        fin = e[np.isfinite(e)]
        out[s] = {"n": int(len(e)), "within": int((e <= HF_TOL).sum()),
                  "share_within_0p1pct": rr(np.mean(e <= HF_TOL)) if len(e) else None,
                  "n_infinite": int((~np.isfinite(e)).sum()),
                  "err_q50_q90_q99_max": [float(np.quantile(fin, q)) for q in (0.5, 0.9, 0.99, 1.0)] if len(fin) else None}
    out["pass"] = bool(all(out[s]["n"] > 0 and out[s]["share_within_0p1pct"] >= HF_SHARE for s in ("uniform", "near")))
    os.makedirs(a.out, exist_ok=True)
    json.dump(out, open(os.path.join(a.out, "r31-hfcheck.json"), "w"), indent=1)
    print(json.dumps(out, indent=1))


def main():
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest="cmd", required=True)
    q = sp.add_parser("acquire")
    q.add_argument("phase", choices=["reserves", "logs", "meta", "stable", "bt", "liq"])
    q.add_argument("--work", required=True)
    q.add_argument("--threads", type=int, default=4)
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
