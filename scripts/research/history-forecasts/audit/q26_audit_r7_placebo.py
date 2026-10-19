"""Q26 closed-path audit 2026-10-19 (membrane-board design/q26-closed-path-audit-2026-10-19.md).

R7.2 refill: reproduce the frozen betas and a placebo with repayments in the window BEFORE the withdrawal hour.
Development or spent (grade C) data only. No reserved set is read.
"""
import os
DS = os.environ.get("MEMBRANE_DATASETS", os.path.expanduser("~/membrane-datasets"))
OUT = os.environ.get("Q26_AUDIT_OUT", ".")
import sys, numpy as np
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import r7_refill as M
lo = M.START - 80*3600; hi = M.END + 80*3600
W, wtx = M.hourly_withdrawals(DS, lo, hi); R, meta = M.hourly_repays(DS, lo, hi, wtx)
off = 80; n = (M.END - M.START)//3600
cs = np.concatenate([[0.0], np.cumsum(R)]); t = np.arange(off, off+n); x = W[off:off+n]
for h in M.HOURS:
    post = cs[t+1+h]-cs[t+1]; pre = cs[t]-cs[t-h]
    bpo, sepo, r2po = M.ols_nw(x, post, h); bpr, sepr, r2pr = M.ols_nw(x, pre, h)
    print(f"{h}h post beta {bpo[1]:.3f} (se {sepo[1]:.3f}, R2 {r2po:.3f})  placebo pre beta {bpr[1]:.3f} (se {sepr[1]:.3f}, R2 {r2pr:.3f})")
