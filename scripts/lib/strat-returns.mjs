// Account-attributed venue return, NOT a full strategy or borrow-cost return.
// Positive flow = capital entering this address's venue-token position.
// Modified Dietz: (end NAV - start NAV - net flows) /
//                 (start NAV + sum(flow * remaining-period fraction)).
// GIPS Handbook, 2nd ed., Calculation Methodology, p. 87 (PDF p. 90):
// https://www.gipsstandards.org/wp-content/uploads/2021/03/gips_handbook_2nd_edition.pdf

export function flowDirection(account, from, to) {
  const a = account.toLowerCase()
  const inbound = to.toLowerCase() === a
  const outbound = from.toLowerCase() === a
  if (inbound === outbound) return 0 // self transfer or neither party
  return inbound ? 1 : -1
}

// Aave V3's aToken ERC20 Transfer mint/burn values include crystallized
// interest. Its immediately following Mint/Burn event exposes balanceIncrease.
// Without this correction, yield would be misclassified as external capital.
export function aTokenExternalFlowRaw(transferValue, action) {
  if (!action || BigInt(action.value) !== BigInt(transferValue)) return null
  const value = BigInt(transferValue)
  const interest = BigInt(action.balanceIncrease)
  if (action.kind === 'mint') return value - interest // may be negative on a burn that emitted Mint
  if (action.kind === 'burn') return -(value + interest)
  return null
}

export function modifiedDietz({ startNavUsd, endNavUsd, startAt, endAt, flows }) {
  const start = new Date(startAt).getTime()
  const end = new Date(endAt).getTime()
  if (
    ![startNavUsd, endNavUsd, start, end].every(Number.isFinite) ||
    startNavUsd < 0 ||
    endNavUsd < 0 ||
    end <= start
  )
    return { pnlUsd: null, returnPct: null, capitalBaseUsd: null, status: 'invalid_window' }
  let netFlow = 0
  let weightedFlow = 0
  for (const flow of flows) {
    const t = new Date(flow.at).getTime()
    if (!Number.isFinite(t) || t < start || t > end || !Number.isFinite(flow.usd))
      return { pnlUsd: null, returnPct: null, capitalBaseUsd: null, status: 'unpriced_flow' }
    netFlow += flow.usd
    weightedFlow += flow.usd * ((end - t) / (end - start))
  }
  const pnlUsd = endNavUsd - startNavUsd - netFlow
  const capitalBase = startNavUsd + weightedFlow
  if (capitalBase === 0 && startNavUsd === 0 && endNavUsd === 0 && flows.length === 0)
    return { pnlUsd: 0, returnPct: null, capitalBaseUsd: 0, status: 'empty' }
  // A zero/negative capital base is not a meaningful percentage, but USD P&L
  // remains arithmetically identifiable. Never emit Infinity or a fake 0%.
  return {
    pnlUsd,
    returnPct: capitalBase > 0 ? (pnlUsd / capitalBase) * 100 : null,
    capitalBaseUsd: capitalBase > 0 ? capitalBase : null,
    status: capitalBase > 0 ? 'complete' : 'no_capital_base',
  }
}
