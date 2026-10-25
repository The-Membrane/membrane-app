"""Q26 R33 acquisition fix (registration addendum 1): GHO variable-debt balances at the daily anchors from chain state.

Aave V3 Ethereum lists GHO, whose variable debt token (GhoVariableDebtToken) applies a borrower discount. The discount
lowers the scaled balance through an internal burn that no Mint/Burn event carries (the Mint/Burn `value` is net of
the discount, and `updateDiscountDistribution` burns the discount with only a Mint of the net interest). The
event-only reconstruction of r111v3 therefore overstates GHO debt. The R33 HF gate failed on exactly these rows.

This step reads the chain value and writes correction rows, so the label, build and score code stay unchanged:
  for each daily meta anchor block b (in order), for every account whose event-reconstructed GHO scaled debt
  (events up to the end of block b plus earlier corrections) is > 0.5 raw unit, read
  GhoVariableDebtToken.scaledBalanceOf(account) at block b (keyless archive eth_call through Multicall3), and write a
  kind-1 GHO row at (block b, log index 999,990) with delta = chain - model. The row sits after every real log of
  block b and before the label read key (block b, 999,999).
Output: ETHW/tok/99999999999.npz (the r111v3 token-part format) and ETHW/gho-fix-counts.json (counts only).

  python3 r33_ghofix.py --work ETHW
"""
from __future__ import annotations

import os
import sys

if os.environ.get("Q26_ETH_RPC_URL"):
    sys.exit("R33 runs keyless only: unset Q26_ETH_RPC_URL")

import argparse  # noqa: E402
import json  # noqa: E402
from concurrent.futures import ThreadPoolExecutor  # noqa: E402

import numpy as np  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import r33_ethereum as W  # noqa: E402,F401  (sets the keyless Ethereum endpoints and market eth)
import r111v3_acquire as A  # noqa: E402
import r111v3_engine as E  # noqa: E402
import r111v3_rpc as X  # noqa: E402

PART = "99999999999.npz"
LIDX = 999_990
BATCH = 400


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", required=True)
    a = ap.parse_args()
    pth = os.path.join(a.work, "tok", PART)
    if os.path.exists(pth):
        sys.exit("correction part exists; delete it to rebuild")
    inp = E.Inputs(a.work)
    g = inp.symbols.index("GHO")
    vdebt = inp.reserves[g]["vDebt"]
    uinv = {v: k for k, v in inp.uid.items()}
    t = inp.tok
    m = (t["kind"] == 1) & (t["res"] == g)
    kb, ku, kd = t["block"][m] * 1_000_000 + t["lidx"][m], t["user"][m], t["delta"][m]
    del inp, t
    anchors = A.jload(os.path.join(a.work, "anchors.json.gz"))
    metas_ts = {}
    for d in sorted(anchors):
        metas_ts[d] = A.jload(os.path.join(a.work, "meta", f"{d}.json.gz"))["ts"]
    cl = X.Client("ethereum", interval=0.08, calls=True)
    bal = {}
    ptr = 0
    rows = []
    cnt = {"anchors": 0, "queries": 0, "corrections": 0, "accounts_corrected": set(), "abs_scaled_sum": 0.0,
           "model_gt_chain": 0, "model_lt_chain": 0, "chain_zero_model_positive": 0}
    sel = X.sel("scaledBalanceOf(address)")
    for d in sorted(anchors):
        b = int(anchors[d])
        e = int(np.searchsorted(kb, b * 1_000_000 + 999_999, "right"))
        for i in range(ptr, e):
            bal[int(ku[i])] = bal.get(int(ku[i]), 0.0) + float(kd[i])
        ptr = e
        us = sorted(u for u, v in bal.items() if v > 0.5)
        cnt["anchors"] += 1
        if not us:
            continue
        chunks = [us[i:i + BATCH] for i in range(0, len(us), BATCH)]

        def q(ch):
            res = X.aggregate3(cl, [(vdebt, sel + X.enc_addr("0x" + uinv[u].hex())) for u in ch], b)
            out = []
            for u, (ok, raw) in zip(ch, res):
                if not ok or len(raw) < 32:
                    raise RuntimeError(f"scaledBalanceOf failed at anchor {d}")
                out.append((u, X.word(raw)))
            return out

        with ThreadPoolExecutor(3) as ex:
            got = [x for part in ex.map(q, chunks) for x in part]
        cnt["queries"] += len(got)
        for u, ch in got:
            dl = float(ch) - bal[u]
            if dl != 0.0 and abs(dl) > 1e-9 * max(abs(bal[u]), 1.0):
                rows.append((b, LIDX, int(metas_ts[d]), u, dl))
                bal[u] = float(ch)
                cnt["corrections"] += 1
                cnt["accounts_corrected"].add(u)
                cnt["abs_scaled_sum"] += abs(dl)
                cnt["model_gt_chain" if dl < 0 else "model_lt_chain"] += 1
                cnt["chain_zero_model_positive"] += int(ch == 0)
        if cnt["anchors"] % 100 == 0:
            print(f"{A.utcnow()} {d} anchors {cnt['anchors']} queries {cnt['queries']} corrections "
                  f"{cnt['corrections']} rpc {cl.stats}", flush=True)
    users = sorted({r[3] for r in rows})
    loc = {u: i for i, u in enumerate(users)}
    n = len(rows)
    A.npsave(pth, block=np.array([r[0] for r in rows], np.int64), lidx=np.array([r[1] for r in rows], np.int32),
             ts=np.array([r[2] for r in rows], np.int64), res=np.full(n, g, np.int16), kind=np.ones(n, np.int8),
             user=np.array([loc[r[3]] for r in rows], np.int32), delta=np.array([r[4] for r in rows], np.float64),
             prin=np.zeros(n), rate=np.zeros(n), users=np.array([bytes(uinv[u]) for u in users], dtype="S20"))
    cnt["accounts_corrected"] = len(cnt["accounts_corrected"])
    cnt["abs_scaled_sum_gho"] = round(cnt.pop("abs_scaled_sum") / 1e18, 2)
    cnt["rpc"] = cl.stats
    json.dump(cnt, open(os.path.join(a.work, "gho-fix-counts.json"), "w"), indent=1)
    print(json.dumps(cnt), flush=True)


if __name__ == "__main__":
    main()
