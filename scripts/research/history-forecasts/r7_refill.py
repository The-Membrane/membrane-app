#!/usr/bin/env python3
"""Q26 round 7 R7.2 refill speed, estimated ONCE (membrane-board design/Q26_ROUND7_PREREG.md @5568616).

  python3 r7_refill.py --datasets <membrane-datasets> --out <dir>

Borrower repayment per $1 withdrawn at 3 h, 24 h and 72 h on Aave V3 Core USDC dev data (origin hours 2023-02-01
00:00Z .. 2026-06-30 23:00Z), by OLS of the repayments in the following window on the withdrawals of the origin hour
(LlamaRisk method). Writes <out>/r7-refill-usdc.json (frozen; its sha256 goes to the live issuer flag).

- Withdrawals W_t: aUSDC Mint/Burn rows of membrane-datasets depositor-events whose balance change delta1_raw < 0
  (a Burn, or the Mint a withdrawal emits when accrued interest exceeds it; liquidations that burn aTokens included),
  amount = -delta1_raw / 1e6 USD, summed per UTC hour [t, t + 1 h).
- Repayments Rp_t(h): USDC rows of borrow-repay-churn/repay_events.csv.gz (Aave V3 Ethereum Core; its borrow file
  matches aave-pool-borrows Core tx for tx), amount_usd, summed over [t + 1 h, t + 1 h + h). Repays in a
  transaction that also withdraws aUSDC (repayWithATokens or withdraw-and-repay; no cash added) are excluded.
- Rp_t(h) = alpha_h + beta_h * W_t + e, OLS over every origin hour; Newey-West SE with lag h. beta_h is the refill
  per $1 withdrawn.
"""
import argparse
import hashlib
import json
import os
import sys
from datetime import datetime, timezone

import numpy as np
import pandas as pd

HOURS = (3, 24, 72)
START = int(datetime(2023, 2, 1, tzinfo=timezone.utc).timestamp())
END = int(datetime(2026, 7, 1, tzinfo=timezone.utc).timestamp())         # origins t < END
EVENTS = [f"depositor-events/events-usdc-{y}.csv.gz" for y in (2023, 2024, 2025, 2026)]
REPAYS = "borrow-repay-churn/repay_events.csv.gz"
SCHEMA = "q26-r7/refill/1"


def sha256_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def hourly_withdrawals(datasets, lo, hi):
    W = np.zeros((hi - lo) // 3600)
    txs = set()
    for rel in EVENTS:
        for ch in pd.read_csv(os.path.join(datasets, rel), usecols=["ts", "tx_hash", "type", "delta1_raw"],
                              dtype={"delta1_raw": "object"}, chunksize=2_000_000):
            ch = ch[ch["type"].isin(["Mint", "Burn"]) & ch["delta1_raw"].notna()]
            d = ch["delta1_raw"].map(int)
            m = d < 0
            ch, d = ch[m], d[m]
            txs.update(ch["tx_hash"].str.lower())
            ts = ch["ts"].to_numpy(np.int64)
            k = (ts >= lo) & (ts < hi)
            np.add.at(W, (ts[k] - lo) // 3600, (-d[k]).astype(float).to_numpy() / 1e6)
    return W, txs


def hourly_repays(datasets, lo, hi, wtx):
    r = pd.read_csv(os.path.join(datasets, REPAYS), usecols=["id", "timestamp", "reserve", "amount_usd"])
    r = r[r["reserve"] == "USDC"]
    tx = r["id"].str.split(":").str[2].str.lower()
    same = tx.isin(wtx)
    R = np.zeros((hi - lo) // 3600)
    k = ~same & (r["timestamp"] >= lo) & (r["timestamp"] < hi)
    ts = r.loc[k, "timestamp"].to_numpy(np.int64)
    np.add.at(R, (ts - lo) // 3600, r.loc[k, "amount_usd"].to_numpy(float))
    rng = r[(r["timestamp"] >= lo) & (r["timestamp"] < hi)]
    return R, {"nRepays": int(len(rng)), "nExcludedSameTx": int((same & (r["timestamp"] >= lo)
                                                                       & (r["timestamp"] < hi)).sum()),
               "usdExcludedSameTx": float(r.loc[same & (r["timestamp"] >= lo) & (r["timestamp"] < hi),
                                                "amount_usd"].sum()),
               "firstTs": int(r["timestamp"].min()), "lastTs": int(r["timestamp"].max())}


def ols_nw(x, y, lag):
    X = np.column_stack([np.ones_like(x), x])
    XtX_inv = np.linalg.inv(X.T @ X)
    b = XtX_inv @ X.T @ y
    e = y - X @ b
    u = X * e[:, None]
    S = u.T @ u
    for l in range(1, lag + 1):
        g = u[l:].T @ u[:-l]
        S += (1 - l / (lag + 1)) * (g + g.T)
    V = XtX_inv @ S @ XtX_inv
    r2 = 1 - float(e @ e) / float(((y - y.mean()) ** 2).sum())
    return b, np.sqrt(np.diag(V)), r2


def estimate(W, R, n_origins):
    """W, R hourly arrays starting at START (R long enough for t + 1 + h)."""
    out = {}
    cs = np.concatenate([[0.0], np.cumsum(R)])
    t = np.arange(n_origins)
    x = W[:n_origins]
    for h in HOURS:
        y = cs[t + 1 + h] - cs[t + 1]
        b, se, r2 = ols_nw(x, y, h)
        out[f"{h}h"] = {"alpha": float(b[0]), "beta": float(b[1]), "se_alpha_nw": float(se[0]),
                        "se_beta_nw": float(se[1]), "r2": r2, "n": int(n_origins), "nwLag": h}
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--datasets", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    hi = END + (max(HOURS) + 1) * 3600
    W, wtx = hourly_withdrawals(a.datasets, START, hi)
    R, rmeta = hourly_repays(a.datasets, START, hi, wtx)
    if rmeta["lastTs"] < hi:
        raise SystemExit("STOP: repay data end before the last window end")
    n = (END - START) // 3600
    est = estimate(W, R, n)
    doc = {"schema": SCHEMA, "prereg": {"repo": "triccs/membrane-board", "path": "design/Q26_ROUND7_PREREG.md",
                                        "commit": "5568616", "item": "R7.2 refill speed"},
           "reserve": "USDC", "market": "Aave V3 Ethereum Core",
           "originHours": {"from": "2023-02-01T00:00:00Z", "toExclusive": "2026-07-01T00:00:00Z", "n": int(n)},
           "dataEndTs": int(hi), "dataEndIso": datetime.fromtimestamp(hi, tz=timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
           "method": "OLS Rp_t(h) = alpha + beta W_t; W_t = aUSDC withdrawals in [t, t+1h); Rp_t(h) = USDC repayments "
                     "in [t+1h, t+1h+h) excluding repays in a tx that also withdraws aUSDC; Newey-West SE lag h "
                     "(LlamaRisk method)",
           "beta": {k: v["beta"] for k, v in est.items()}, "fit": est,
           "withdrawals": {"totalUSD": float(W[:n].sum()), "hoursWithWithdrawal": int((W[:n] > 0).sum())},
           "repays": rmeta,
           "inputs": {rel: sha256_file(os.path.join(a.datasets, rel)) for rel in EVENTS + [REPAYS]},
           "code": {"file": "scripts/research/history-forecasts/r7_refill.py",
                    "sha256": sha256_file(os.path.abspath(__file__))}}
    os.makedirs(a.out, exist_ok=True)
    p = os.path.join(a.out, "r7-refill-usdc.json")
    data = (json.dumps(doc, indent=1, sort_keys=True) + "\n").encode()
    if os.path.exists(p):
        raise SystemExit(f"STOP: {p} exists (estimated once; never rewritten)")
    with open(p, "xb") as f:
        f.write(data)
    print(json.dumps(doc["beta"]), hashlib.sha256(data).hexdigest())
    return 0


if __name__ == "__main__":
    sys.exit(main())
