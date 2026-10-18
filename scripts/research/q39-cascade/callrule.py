"""Aave V3 liquidation call rule, vendored verbatim from membrane-app branch research/history-forecasts,
scripts/research/history-forecasts/sim1/liq.py `m_call_vec` at commit 0dcd888 (the Q26 curator simulator,
session "Build history-repeats forecasts and depositor behavior model"). That rule is the R10.1 rule
(largest debt bucket, largest eligible collateral bucket, v3.3 close factor, seize cap, $1,000 leftover
rule, protocol fee), tested there against real LiquidationCall events (c1_baddebt spot checks).
test_q39.py asserts this copy is byte-identical to the pinned source when that branch is fetchable.
"""
from __future__ import annotations

import numpy as np


def m_call_vec(td, hf, coll_k, debt_j, lb_k, fee_k, cost):
    """Vectorised r111v3_engine.M_call with day.v33 = True. Returns repay, seized, fee, profit."""
    partial = (coll_k >= 2000.0) & (debt_j >= 2000.0) & (hf > 0.95)
    repay = np.where(partial & (debt_j > 0.5 * td), 0.5 * td, debt_j)
    seized = repay * lb_k
    cap = seized > coll_k
    seized = np.where(cap, coll_k, seized)
    repay = np.where(cap, coll_k / lb_k, repay)
    left = (~cap) & (repay < debt_j) & ((debt_j - repay < 1000.0) | (coll_k - seized < 1000.0))
    repay = np.where(left, debt_j, repay)
    seized = np.where(left, repay * lb_k, seized)
    cap2 = left & (seized > coll_k)
    seized = np.where(cap2, coll_k, seized)
    repay = np.where(cap2, coll_k / lb_k, repay)
    fee = (seized - seized / lb_k) * fee_k
    profit = (seized - fee) - repay - cost
    return repay, seized, fee, profit
