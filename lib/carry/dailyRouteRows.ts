import { describeRouteReading } from './liveRouteFreshness'

// These are exact labels from the frozen August unified_routes fixture. A
// destination name or asset substring is not enough to identify a rate leg.
export const DAILY_GHO_ROUTE_KEY = 'GHO → sGho [GHO]'
export const DAILY_USDE_ROUTE_KEY = 'USDe → Staked USDe [USDe]'

export type DailySpreadReading = {
  borrowApy: number
  yieldApy: number
  spread: number
  observedAt: string
}

export type DailyRoutePilots = {
  exactAaveSpread?: DailySpreadReading | null
  latestUsdeExactSpread?: DailySpreadReading | null
}

export type DailyRouteSpread = {
  kind: 'gho' | 'usde'
  reading: DailySpreadReading | null
  stale: boolean | null
}

export function dailySpreadForRoute(
  routeKey: string | undefined,
  pilots: DailyRoutePilots | null,
  nowMs: number,
): DailyRouteSpread | null {
  const kind =
    routeKey === DAILY_GHO_ROUTE_KEY ? 'gho' : routeKey === DAILY_USDE_ROUTE_KEY ? 'usde' : null
  if (!kind) return null

  const candidate = kind === 'gho' ? pilots?.exactAaveSpread : pilots?.latestUsdeExactSpread
  const reading =
    candidate &&
    Number.isFinite(candidate.borrowApy) &&
    Number.isFinite(candidate.yieldApy) &&
    Number.isFinite(candidate.spread) &&
    Number.isFinite(Date.parse(candidate.observedAt)) &&
    Date.parse(candidate.observedAt) <= nowMs + 60_000
      ? candidate
      : null

  return {
    kind,
    reading,
    stale: reading ? describeRouteReading(reading.observedAt, nowMs).stale : null,
  }
}
