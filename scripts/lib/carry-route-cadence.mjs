import { exactLegKey, GHO_SGHO } from '../route-rates/exact-leg-spread.mjs'

export const CARRY_ROUTE_CADENCE_MS = 24 * 60 * 60 * 1000
export const HOLDER_ROUTE_KEY = 'GHO → sGho [GHO]'
export const SPREAD_ROUTE_KEY = exactLegKey(GHO_SGHO)

export function dueCarryRouteKinds(rows, nowMs = Date.now()) {
  if (!Number.isFinite(nowMs)) throw new Error('nowMs must be finite')
  const lastSuccess = new Map()
  for (const { kind, route_key, recorded_at } of rows) {
    if (
      (kind === 'holder_stock' && route_key === HOLDER_ROUTE_KEY) ||
      (kind === 'spread' && route_key === SPREAD_ROUTE_KEY)
    ) {
      lastSuccess.set(kind, new Date(recorded_at).getTime())
    }
  }
  return {
    holder_stock: isDue(lastSuccess.get('holder_stock'), nowMs),
    spread: isDue(lastSuccess.get('spread'), nowMs),
  }
}

function isDue(recordedAtMs, nowMs) {
  return !Number.isFinite(recordedAtMs) || nowMs - recordedAtMs >= CARRY_ROUTE_CADENCE_MS
}
