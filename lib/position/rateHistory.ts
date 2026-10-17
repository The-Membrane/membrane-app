/**
 * Bounded measured APR observations, regenerated from the private datasets checkout.
 * Dates label common daily snapshots; observedAt always keeps the actual block time.
 * This table contains no forecasts, account flows, or reconstructed earnings.
 */
import raw from './rateHistory.generated.json'

export type RateHistorySide = 'borrow' | 'supply'
export interface RateHistoryIdentity {
  chainId: number
  protocol: string
  venueAddress: string
  marketId: string
  tokenAddress: string
}

export interface RateHistoryPoint {
  /** Nominal UTC snapshot date, for the common calendar grid; not observation time. */
  date: string
  /** Actual archive block timestamp (Unix seconds), or null if no observation exists. */
  observedAt: number | null
  /** Fraction/year: 0.04 is 4% APR. Missing data and regime boundaries are null. */
  apr: number | null
  block: number | null
  regime: string | null
  quality: 'observed' | 'missing' | 'regime-change'
  missingReason: string | null
}

export interface RateHistoryRegime {
  strategy: string
  reserveFactorBps: number
  optimalUtilizationRay: string
  baseBorrowRay: string
  slope1Ray: string
  slope2Ray: string
  aTokenAddress: string
  variableDebtTokenAddress: string
}

export interface RateHistorySeries {
  id: string
  symbol: string
  identity: RateHistoryIdentity
  side: RateHistorySide
  rateConvention: 'apr'
  feeBasis: 'borrower-before-incentives' | 'protocol-fees-already-deducted'
  componentScope: 'variable-debt-only' | 'all-supply'
  sourcePaths: string[]
  sampling: string
  limitations: string[]
  latestRegime: string | null
  regimes: Record<string, RateHistoryRegime>
  points: RateHistoryPoint[]
}

export interface RateHistoryTable {
  schema: 1
  units: 'fraction/year'
  maxDays: 90
  method: string
  source: { repo: string; commit: string; sha256: Record<string, string> }
  excluded: string[]
  series: RateHistorySeries[]
}

const ADDRESS = /^0x[0-9a-f]{40}$/i
const DATE = /^\d{4}-\d{2}-\d{2}$/
const DAY = 86400
const isPositiveInteger = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) > 0

/** Reject malformed units, stale fabrication, unmatched identity or erased gaps at load. */
export function assertRateHistoryTable(value: unknown): asserts value is RateHistoryTable {
  const bad = (field: string): never => {
    throw new Error(`rate history: ${field}`)
  }
  if (!value || typeof value !== 'object') bad('table is not an object')
  const table = value as RateHistoryTable
  if (table.schema !== 1 || table.units !== 'fraction/year' || table.maxDays !== 90)
    bad('schema/units/bound')
  if (
    !table.source ||
    !/^[a-f0-9]{40}$/.test(table.source.commit) ||
    !table.source.sha256 ||
    !Object.keys(table.source.sha256).length ||
    Object.values(table.source.sha256).some((hash) => !/^[a-f0-9]{64}$/.test(hash))
  )
    bad('source hashes')
  if (!Array.isArray(table.series) || !table.series.length || table.series.length > 4)
    bad('bounded series')
  const identities = new Set<string>()
  let commonDates: string[] | null = null
  for (const series of table.series) {
    const identity = series.identity
    if (
      !identity ||
      !isPositiveInteger(identity.chainId) ||
      !identity.protocol ||
      !ADDRESS.test(identity.venueAddress) ||
      !ADDRESS.test(identity.marketId) ||
      !ADDRESS.test(identity.tokenAddress)
    )
      bad('exact identity')
    if (!['borrow', 'supply'].includes(series.side) || series.rateConvention !== 'apr')
      bad('side/convention')
    const borrow = series.side === 'borrow'
    if (
      series.componentScope !== (borrow ? 'variable-debt-only' : 'all-supply') ||
      series.feeBasis !== (borrow ? 'borrower-before-incentives' : 'protocol-fees-already-deducted')
    )
      bad('component/fee basis')
    const key =
      `${identity.chainId}:${identity.protocol}:${identity.venueAddress}:${identity.marketId}:${identity.tokenAddress}:${series.side}`.toLowerCase()
    if (identities.has(key)) bad('duplicate identity')
    identities.add(key)
    if (
      !Array.isArray(series.sourcePaths) ||
      !series.sourcePaths.length ||
      series.sourcePaths.some((path) => !table.source.sha256[path])
    )
      bad('series source paths')
    if (!series.regimes || typeof series.regimes !== 'object') bad('regime registry')
    for (const [id, regime] of Object.entries(series.regimes)) {
      if (
        !/^[a-f0-9]{16}$/.test(id) ||
        !ADDRESS.test(regime.strategy) ||
        !ADDRESS.test(regime.aTokenAddress) ||
        !ADDRESS.test(regime.variableDebtTokenAddress) ||
        !Number.isInteger(regime.reserveFactorBps) ||
        regime.reserveFactorBps < 0 ||
        regime.reserveFactorBps > 10000 ||
        [
          regime.optimalUtilizationRay,
          regime.baseBorrowRay,
          regime.slope1Ray,
          regime.slope2Ray,
        ].some((ray) => !/^\d+$/.test(ray))
      )
        bad('regime fields')
    }
    if (series.latestRegime !== null && !series.regimes[series.latestRegime]) bad('latest regime')
    if (!Array.isArray(series.points) || series.points.length !== table.maxDays)
      bad('bounded daily slots')
    let previousTarget = 0,
      previousRegime: string | null = null
    for (const point of series.points) {
      const target = Date.parse(`${point.date}T00:00:00Z`) / 1000
      if (
        !DATE.test(point.date) ||
        !Number.isFinite(target) ||
        (previousTarget !== 0 && target - previousTarget !== DAY)
      )
        bad('daily calendar grid')
      previousTarget = target
      if (
        point.observedAt !== null &&
        (!isPositiveInteger(point.observedAt) || point.observedAt >= target)
      )
        bad('actual observation time')
      if (
        (point.observedAt === null) !== (point.block === null) ||
        (point.block !== null && !isPositiveInteger(point.block))
      )
        bad('block/time pair')
      if (point.regime !== null && !series.regimes[point.regime]) bad('point regime')
      if (point.quality === 'observed') {
        if (
          !Number.isFinite(point.apr) ||
          point.apr === null ||
          point.observedAt === null ||
          point.regime === null ||
          point.missingReason !== null
        )
          bad('observed point')
        if (previousRegime !== null && previousRegime !== point.regime)
          bad('unbroken regime boundary')
      } else if (point.quality === 'missing' || point.quality === 'regime-change') {
        if (point.apr !== null || !point.missingReason) bad('gap must remain null with reason')
        if (
          point.quality === 'regime-change' &&
          (point.regime === null || point.observedAt === null)
        )
          bad('regime boundary provenance')
      } else bad('sample quality')
      if (point.regime !== null) previousRegime = point.regime
    }
    const dates = series.points.map((point) => point.date)
    if (commonDates && dates.some((date, i) => date !== commonDates?.[i])) bad('common date grid')
    commonDates = dates
  }
}

export function parseRateHistory(value: unknown): RateHistoryTable {
  assertRateHistoryTable(value)
  return value
}

/** Checked once at import. Old data stays old: the builder does not stamp build time as freshness. */
export const RATE_HISTORY: RateHistoryTable = parseRateHistory(raw)

/** Exact chain + protocol + venue + market + token match. Symbols never identify history. */
export function findRateHistory(
  table: RateHistoryTable,
  identity: RateHistoryIdentity,
  side: RateHistorySide,
): RateHistorySeries | null {
  const canonical = (value: string) => value.toLowerCase()
  return (
    table.series.find(
      (series) =>
        series.side === side &&
        series.identity.chainId === identity.chainId &&
        series.identity.protocol === identity.protocol &&
        canonical(series.identity.venueAddress) === canonical(identity.venueAddress) &&
        canonical(series.identity.marketId) === canonical(identity.marketId) &&
        canonical(series.identity.tokenAddress) === canonical(identity.tokenAddress),
    ) ?? null
  )
}
