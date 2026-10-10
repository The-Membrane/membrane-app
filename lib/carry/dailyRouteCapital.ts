import { describeRouteReading } from './liveRouteFreshness'
import { DAILY_GHO_ROUTE_KEY, DAILY_USDE_ROUTE_KEY } from './dailyRouteRows'

type ReadingTime = { observedAt: string }
type GhoOverlap = ReadingTime & { matchedGho: number; completeWalletCount: number }
type UsdeOverlap = ReadingTime & { matchedUsde: string; completeWalletCount: number }

export type DailyCapitalPilots = {
  matchedCapital?: GhoOverlap | null
  latestUsdeMatchedCapital?: UsdeOverlap | null
}

export type DailyRouteCapital = {
  kind: 'gho' | 'usde'
  amount: string | null
  reading: ReadingTime | null
  walletCount: 20 | 25
  stale: boolean | null
}

const validTime = (value: string, nowMs: number) =>
  Number.isFinite(Date.parse(value)) && Date.parse(value) <= nowMs + 60_000

function formatGho(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  if (!Number.isSafeInteger(Math.trunc(value))) return null
  if (value > 0 && value < 0.000001) return '<0.000001 GHO'
  return `${value.toLocaleString('en-US', { maximumFractionDigits: 6 })} GHO`
}

function formatUsde(value: unknown): string | null {
  // Keep token-unit decimal strings as strings. Number() loses meaningful
  // low-order digits for large balances and would accept exponent notation.
  // A uint256 with 18 token decimals can have a 60-digit whole-token part.
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,59})(?:\.\d{1,18})?$/.test(value)) return null
  const [whole, fraction = ''] = value.split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const shown = fraction.slice(0, 6).replace(/0+$/, '')
  if (whole === '0' && fraction.slice(0, 6).replace(/0/g, '') === '' && /[1-9]/.test(fraction))
    return '<0.000001 USDe'
  return `${grouped}${shown ? `.${shown}` : ''} USDe`
}

export function dailyCapitalForRoute(
  routeKey: string | undefined,
  pilots: DailyCapitalPilots | null,
  nowMs: number,
): DailyRouteCapital | null {
  const kind =
    routeKey === DAILY_GHO_ROUTE_KEY ? 'gho' : routeKey === DAILY_USDE_ROUTE_KEY ? 'usde' : null
  if (!kind) return null

  const walletCount = kind === 'gho' ? 20 : 25
  const ghoCandidate = pilots?.matchedCapital
  const usdeCandidate = pilots?.latestUsdeMatchedCapital
  const candidate = kind === 'gho' ? ghoCandidate : usdeCandidate
  const amount =
    kind === 'gho' ? formatGho(ghoCandidate?.matchedGho) : formatUsde(usdeCandidate?.matchedUsde)
  const reading =
    candidate &&
    candidate.completeWalletCount === walletCount &&
    validTime(candidate.observedAt, nowMs) &&
    amount !== null
      ? candidate
      : null
  return {
    kind,
    amount: reading ? amount : null,
    reading,
    walletCount,
    stale: reading ? describeRouteReading(reading.observedAt, nowMs).stale : null,
  }
}
