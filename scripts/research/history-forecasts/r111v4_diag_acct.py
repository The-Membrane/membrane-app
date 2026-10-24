"""Q26 R11.1-v4 post-outcome diagnostic: per-account decomposition of a diagnostic window (r111v4_diag.py window).
Prints an address-free summary: simulated USDC repay split by how often the same account was called, the repeat factor
(sim repay / the account's largest debt at a call), and the share on accounts with a real liquidation in the window."""
import json
import pickle
import sys

import numpy as np


def main(path, day):
    W = pickle.load(open(path, "rb"))
    acc = {}
    for c, pl in zip(W["calls"], W["pxlog"]):
        d, u, rep, j, us, g, t = c
        if d != day or not us:
            continue
        e = acc.setdefault(u, {"rep": 0.0, "n": 0, "maxdebt": 0.0})
        e["rep"] += rep
        e["n"] += 1
    # heuristic cap (indicative only): a single call repays at most the debt and at least half of it when the close
    # factor binds, so 2 x the largest single repay is an upper bound on one full debt of the account that day
    for c in W["calls"]:
        d, u, rep, j, us, g, t = c
        if d == day and us and u in acc:
            acc[u]["maxdebt"] = max(acc[u]["maxdebt"], rep)
    real_u = {}
    for r in W["real"]:
        if r["usdc"] and r["repay_usd"]:
            real_u[r["u"]] = real_u.get(r["u"], 0.0) + r["repay_usd"]
    tot = sum(e["rep"] for e in acc.values())
    once = sum(min(e["rep"], 2 * e["maxdebt"]) for e in acc.values())   # at most one full debt per account per day
    reps = np.array([e["n"] for e in acc.values()])
    out = {"day": day, "sim_usdc": round(tot, 2), "accounts": len(acc),
           "calls_per_account_q50_q90_max": [float(np.quantile(reps, q)) for q in (0.5, 0.9, 1.0)] if len(reps) else None,
           "sim_on_accounts_called_gt3": round(sum(e["rep"] for e in acc.values() if e["n"] > 3), 2),
           "sim_capped_one_debt_per_account": round(once, 2),
           "sim_on_accounts_with_real_liq": round(sum(e["rep"] for u, e in acc.items() if u in real_u), 2),
           "sim_capped_on_accounts_with_real_liq": round(sum(min(e["rep"], 2 * e["maxdebt"]) for u, e in acc.items() if u in real_u), 2),
           "real_usdc": round(sum(r["repay_usd"] for r in W["real"] if r["usdc"] and r["repay_usd"] and _day(r["ts"]) == day), 2),
           "top5_accounts": [{"sim": round(e["rep"], 2), "calls": e["n"], "max_single_repay": round(e["maxdebt"], 2),
                              "real_liq_usd_window": round(real_u.get(u, 0.0), 2)}
                             for u, e in sorted(acc.items(), key=lambda x: -x[1]["rep"])[:5]]}
    print(json.dumps(out))


def _day(ts):
    import datetime as dt
    return dt.datetime.fromtimestamp(ts, dt.timezone.utc).date().isoformat()


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
