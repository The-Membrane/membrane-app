/** Exhaustion is sticky even when a downstream collector converts throws into unavailable. */
export function carryExitV2RpcBudgetReason(budget, nowMs, codes) {
  if (budget.exhaustedReason) return budget.exhaustedReason
  if (nowMs >= budget.deadlineMs || Date.now() >= budget.wallDeadlineMs) {
    budget.exhaustedReason = codes.deadline
    return budget.exhaustedReason
  }
  return null
}

/** Reaching the cap is allowed; attempting another physical start exhausts it. */
export function startCarryExitV2BudgetedRpc(budget, nowMs, codes) {
  const reason = carryExitV2RpcBudgetReason(budget, nowMs, codes)
  if (reason) throw Error(reason)
  if (budget.starts >= budget.limit) {
    budget.exhaustedReason = codes.cap
    throw Error(budget.exhaustedReason)
  }
  budget.starts++
}
