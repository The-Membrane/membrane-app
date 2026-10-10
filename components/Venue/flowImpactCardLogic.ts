import type { Entry } from '@/components/Carry/venueLogLogic'
import { observedCapacityDecline } from '@/components/Venue/observedCapacityDecline'

export type ObservedCapacitySignal = {
  status: 'observed_shrinking' | 'none' | 'unavailable'
  before?: { usd: number; blockTime: string }
  after?: { usd: number; blockTime: string }
  declineUsd?: number
  declinePercent?: number
}

export type NewsStorage = 'database' | 'local_mac_recorder'

export function newsFetchedAtLabel(storage: NewsStorage | null | undefined): string {
  return storage === 'database'
    ? 'First stored'
    : storage === 'local_mac_recorder'
      ? 'Last fetched'
      : 'Fetched'
}

type CapacityChangeItem = {
  metric: 'instantUsd' | 'depthUsd'
  signal: ObservedCapacitySignal
}

/** Use the guarded log/snapshot pair when the development-only signal has no result. */
export function selectObservedCapacitySignal(
  measuredChange: CapacityChangeItem | null | undefined,
  entries: Entry[] | null | undefined,
  venue: string,
  snapshot: Parameters<typeof observedCapacityDecline>[2],
  nowMs = Date.now(),
): { metric: CapacityChangeItem['metric'] | null; signal: ObservedCapacitySignal | null } {
  if (measuredChange) return { metric: measuredChange.metric, signal: measuredChange.signal }

  const decline = observedCapacityDecline(entries, venue, snapshot, nowMs)
  if (decline.status !== 'available') return { metric: null, signal: null }

  const declineUsd = decline.beforeUsd - decline.afterUsd
  const declinePercent = decline.beforeUsd > 0 ? (declineUsd / decline.beforeUsd) * 100 : 0
  return {
    metric: decline.metric === 'instant_usd' ? 'instantUsd' : 'depthUsd',
    signal: {
      // Match the recorder's materiality threshold for the visible warning state.
      status: declineUsd >= 100_000 && declinePercent >= 1 ? 'observed_shrinking' : 'none',
      before: { usd: decline.beforeUsd, blockTime: decline.since },
      after: { usd: decline.afterUsd, blockTime: decline.at },
      declineUsd,
      declinePercent,
    },
  }
}

// A route-inventory scenario, never a holder-specific withdrawal quote.
// The band must be supplied by a separately validated capacity and competing-flow model.
export type ValidatedRouteFlowOutlook = {
  status: 'validated'
  horizonHours: number
  capacityBeforeCompetingFlowUsd: { low: number; high: number }
  expectedCompetingOutflowUsd: { low: number; high: number }
}

export type RouteHeadroom = {
  lowUsd: number
  highUsd: number
  relation: 'below' | 'above' | 'uncertain'
}

export type ObservedInventoryShare = { beforePercent: number; afterPercent: number }

export function observedInventoryShare(
  userAmountUsd: number | null,
  beforeInventoryUsd: number | null,
  afterInventoryUsd: number | null,
): ObservedInventoryShare | null {
  if (
    userAmountUsd == null ||
    beforeInventoryUsd == null ||
    afterInventoryUsd == null ||
    ![userAmountUsd, beforeInventoryUsd, afterInventoryUsd].every(
      (value) => Number.isFinite(value) && value > 0,
    )
  )
    return null
  return {
    beforePercent: (userAmountUsd / beforeInventoryUsd) * 100,
    afterPercent: (userAmountUsd / afterInventoryUsd) * 100,
  }
}

export function inventoryShareLabel(percent: number): string {
  if (!Number.isFinite(percent) || percent < 0) return 'unavailable'
  return `${Number(percent.toPrecision(3))}%`
}

export function isRecentPublishedNews(publishedAt: string | null, nowMs = Date.now()): boolean {
  const publishedMs = Date.parse(publishedAt ?? '')
  return (
    Number.isFinite(publishedMs) &&
    publishedMs >= nowMs - 24 * 60 * 60 * 1_000 &&
    publishedMs <= nowMs + 5 * 60 * 1_000
  )
}

// Recorded parameter and gate events use the same current-signal window as headlines.
export function isRecentObservedEvent(at: string | null, nowMs = Date.now()): boolean {
  return isRecentPublishedNews(at, nowMs)
}

export function routeHeadroomAfterFlow(
  outlook: ValidatedRouteFlowOutlook | null | undefined,
  userAmountUsd: number | null,
  horizonHours: number | null,
): RouteHeadroom | null {
  if (
    outlook?.status !== 'validated' ||
    userAmountUsd == null ||
    horizonHours == null ||
    !Number.isFinite(userAmountUsd) ||
    userAmountUsd <= 0 ||
    horizonHours !== outlook.horizonHours
  )
    return null

  const capacity = outlook.capacityBeforeCompetingFlowUsd
  const flow = outlook.expectedCompetingOutflowUsd
  if (
    ![capacity.low, capacity.high, flow.low, flow.high].every(Number.isFinite) ||
    capacity.low < 0 ||
    capacity.high < capacity.low ||
    flow.low < 0 ||
    flow.high < flow.low
  )
    return null

  // Conservative interval arithmetic: worst capacity with highest competing flow.
  const lowUsd = capacity.low - flow.high - userAmountUsd
  const highUsd = capacity.high - flow.low - userAmountUsd
  return {
    lowUsd,
    highUsd,
    relation: highUsd < 0 ? 'below' : lowUsd >= 0 ? 'above' : 'uncertain',
  }
}
