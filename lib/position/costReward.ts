/** Measured annualized rate snapshots. No forecast, cash-flow integration or wallet attribution. */
import type { ProtocolPosition } from '@/lib/position-sim/types'

import { findRateHistory, type RateHistorySeries, type RateHistoryTable } from './rateHistory'

export const RATE_SNAPSHOT_MAX_AGE_MS = 15 * 60_000
export const RATE_SNAPSHOT_MAX_SKEW_MS = 60_000
export const RATE_ANCHOR_DEADLINE_MS = 25_000

/** Addresses, never symbols. Tokens outside this explicit set have unmeasured native income. */
const NO_NATIVE_YIELD = new Set([
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
  '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH
  '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', // WBTC
  '0x6b175474e89094c44da98b954eedeac495271d0f', // DAI
  '0xdc035d45d973e3ec169d2276ddab16f1e407384f', // USDS
  '0x4c9edd5852cd905f086c759e8383e09bff1e68b3', // USDe (not sUSDe)
  '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f', // GHO
])

export interface RateContribution {
  id: string
  symbol: string
  tokenAddress: string
  side: 'cost' | 'income'
  component: 'borrow' | 'supply' | 'native'
  assignment: 'debt' | 'collateral' | 'supplied'
  notionalUsd: number | null
  currentApr: number | null
  source: string
  missingReason: string | null
  history: RateHistorySeries | null
}

export interface RateCoverage {
  legs: number
  pricedLegs: number
  pricedValueUsd: number
  totalValueUsd: number | null
}

export interface MeasuredRatePoint {
  date: string
  observedAtMs: number | null
  costObservedAtMs: number | null
  incomeObservedAtMs: number | null
  costUsdPerYear: number | null
  incomeUsdPerYear: number | null
  missing: string[]
}

export interface CostRewardView {
  contributions: RateContribution[]
  history: MeasuredRatePoint[]
  current: {
    state: 'loading' | 'unavailable' | 'stale' | 'fresh'
    costUsdPerYear: number | null
    incomeUsdPerYear: number | null
    spreadUsdPerYear: number | null
    observedAtMs: number | null
    fetchedAtMs: number
  }
  debtCoverage: RateCoverage
  incomeCoverage: RateCoverage
  noDebt: boolean
  latestHistoricalAtMs: number | null
  sourcePeriod: { first: string; last: string } | null
}

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
const notional = (amount: number, price: number): number | null =>
  finite(amount) && amount >= 0 && finite(price) && price > 0 && finite(amount * price)
    ? amount * price
    : null

function seriesFor(
  p: ProtocolPosition,
  tokenAddress: string,
  side: 'borrow' | 'supply',
  table: RateHistoryTable,
) {
  if ((p.protocol !== 'aave-v3' && p.protocol !== 'spark') || p.chainId !== 1 || !p.venueAddress)
    return null
  return findRateHistory(
    table,
    {
      chainId: 1,
      protocol: p.protocol,
      venueAddress: p.venueAddress,
      marketId: tokenAddress,
      tokenAddress,
    },
    side,
  )
}

export function rateContributions(
  p: ProtocolPosition,
  table: RateHistoryTable,
): RateContribution[] {
  const dollarValue = (amount: number, price: number) =>
    p.usdValuationBasis === 'source-oracle' ? notional(amount, price) : null
  const debt: RateContribution[] = p.debt
    .filter((d) => d.amount !== 0)
    .map((d, index) => ({
      id: `debt:${d.address.toLowerCase()}:${index}`,
      symbol: d.symbol,
      tokenAddress: d.address,
      side: 'cost',
      component: 'borrow',
      assignment: 'debt',
      notionalUsd: dollarValue(d.amount, d.priceUsd),
      currentApr: finite(d.borrowApr) ? d.borrowApr : null,
      source: `${p.label} borrow APR · ${d.borrowRateBasis ?? 'unknown'} rate basis`,
      missingReason: finite(d.borrowApr) ? null : 'Borrow rate unavailable',
      // A reserve's variable-rate history never describes a fixed or blended user tranche.
      history: d.borrowRateBasis === 'variable' ? seriesFor(p, d.address, 'borrow', table) : null,
    }))
  const income: RateContribution[] = []
  for (const [assignment, legs] of [
    ['collateral', p.collateral],
    ['supplied', p.supplied ?? []],
  ] as const) {
    legs
      .filter((leg) => leg.amount !== 0)
      .forEach((leg, index) => {
        const supply =
          'supplyApr' in leg &&
          finite(leg.supplyApr) &&
          'supplyAprFeeBasis' in leg &&
          leg.supplyAprFeeBasis === 'protocol-fee-net'
            ? leg.supplyApr
            : null
        income.push({
          id: `${assignment}:${leg.address.toLowerCase()}:${index}:supply`,
          symbol: leg.symbol,
          tokenAddress: leg.address,
          side: 'income',
          component: 'supply',
          assignment,
          notionalUsd: dollarValue(leg.amount, leg.priceUsd),
          currentApr: supply,
          source:
            'supplyAprSource' in leg && typeof leg.supplyAprSource === 'string'
              ? leg.supplyAprSource
              : `${p.label} supply rate unavailable`,
          missingReason: supply === null ? 'Supply rate unavailable' : null,
          history: seriesFor(p, leg.address, 'supply', table),
        })
        if (!NO_NATIVE_YIELD.has(leg.address.toLowerCase())) {
          income.push({
            id: `${assignment}:${leg.address.toLowerCase()}:${index}:native`,
            symbol: leg.symbol,
            tokenAddress: leg.address,
            side: 'income',
            component: 'native',
            assignment,
            notionalUsd: dollarValue(leg.amount, leg.priceUsd),
            currentApr: null,
            source: 'Native asset growth is not measured by this adapter',
            missingReason: 'Native asset income unavailable',
            history: null,
          })
        }
      })
  }
  return [...debt, ...income]
}

/** A second income component on the same holding is not a second principal balance. */
function coverage(contributions: RateContribution[]): RateCoverage {
  const holdings = new Map<string, RateContribution[]>()
  for (const leg of contributions) {
    const key = leg.id.replace(/:(supply|native)$/, '')
    holdings.set(key, [...(holdings.get(key) ?? []), leg])
  }
  const rows = [...holdings.values()]
  const valued = rows.filter((row) => row[0].notionalUsd !== null)
  const priced = valued.filter((row) => row.every((leg) => leg.currentApr !== null))
  return {
    legs: rows.length,
    pricedLegs: priced.length,
    pricedValueUsd: priced.reduce((s, row) => s + (row[0].notionalUsd as number), 0),
    totalValueUsd:
      valued.length === rows.length
        ? valued.reduce((s, row) => s + (row[0].notionalUsd as number), 0)
        : null,
  }
}

function sumComplete(
  legs: RateContribution[],
  rates: (leg: RateContribution) => number | null,
): number | null {
  if (legs.length === 0) return null
  let sum = 0
  for (const leg of legs) {
    const rate = rates(leg)
    if (leg.notionalUsd === null || rate === null || !finite(rate)) return null
    sum += leg.notionalUsd * rate
  }
  return finite(sum) ? sum : null
}

export interface MeasurementClock {
  nowMs: number | null
  observedAtMs: number | null
  anchorState: 'loading' | 'ready' | 'error'
}

export function buildCostReward(
  p: ProtocolPosition,
  table: RateHistoryTable,
  clock: MeasurementClock,
): CostRewardView {
  const contributions = rateContributions(p, table)
  const debt = contributions.filter((leg) => leg.side === 'cost')
  const income = contributions.filter((leg) => leg.side === 'income')
  const noDebt = p.debt.every((d) => d.amount === 0)
  const allSeries = contributions.flatMap((leg) => (leg.history ? [leg.history] : []))
  const dates = [
    ...new Set(allSeries.flatMap((series) => series.points.map((point) => point.date))),
  ].sort()
  const history = dates.map((date): MeasuredRatePoint => {
    const matched = contributions.map((leg) => ({
      leg,
      point: leg.history?.points.find((point) => point.date === date),
    }))
    const observationTimes = (side: 'cost' | 'income') =>
      matched.flatMap(({ leg, point }) =>
        leg.side === side && point?.observedAt ? [point.observedAt * 1000] : [],
      )
    const costTimes = observationTimes('cost'),
      incomeTimes = observationTimes('income')
    const observations = [...costTimes, ...incomeTimes]
    const alignedSide = (side: 'cost' | 'income') => {
      const times = side === 'cost' ? costTimes : incomeTimes
      return (
        times.length > 0 && Math.max(...times) - Math.min(...times) <= RATE_SNAPSHOT_MAX_SKEW_MS
      )
    }
    const rateAt = (leg: RateContribution) => {
      const point = matched.find((m) => m.leg.id === leg.id)?.point
      return alignedSide(leg.side) && point?.quality === 'observed' && finite(point.apr)
        ? point.apr
        : null
    }
    return {
      date,
      observedAtMs: observations.length ? Math.max(...observations) : null,
      costObservedAtMs: costTimes.length ? Math.max(...costTimes) : null,
      incomeObservedAtMs: incomeTimes.length ? Math.max(...incomeTimes) : null,
      costUsdPerYear: sumComplete(debt, rateAt),
      incomeUsdPerYear: sumComplete(income, rateAt),
      missing: matched
        .filter(({ leg }) => rateAt(leg) === null)
        .map(
          ({ leg, point }) =>
            `${leg.symbol} ${leg.component}: ${point?.missingReason ?? (leg.history ? 'Observation unavailable' : 'History unavailable for this rate basis')}`,
        ),
    }
  })
  const observed = clock.observedAtMs
  const now = clock.nowMs
  const age = observed === null || now === null ? null : now - observed
  const state =
    clock.anchorState === 'loading' || now === null
      ? 'loading'
      : clock.anchorState === 'error' || age === null
        ? 'unavailable'
        : age < -RATE_SNAPSHOT_MAX_SKEW_MS ||
            age > RATE_SNAPSHOT_MAX_AGE_MS ||
            p.provenance.kind !== 'onchain'
          ? 'stale'
          : 'fresh'
  const currentCost = sumComplete(debt, (leg) => leg.currentApr)
  const currentIncome = sumComplete(income, (leg) => leg.currentApr)
  const current = {
    state,
    costUsdPerYear: state === 'fresh' ? currentCost : null,
    incomeUsdPerYear: state === 'fresh' ? currentIncome : null,
    spreadUsdPerYear:
      state === 'fresh' && !noDebt && currentCost !== null && currentIncome !== null
        ? currentIncome - currentCost
        : null,
    observedAtMs: observed,
    fetchedAtMs: p.provenance.at,
  } as CostRewardView['current']
  const latest = history.flatMap((point) =>
    point.observedAtMs === null ? [] : [point.observedAtMs],
  )
  return {
    contributions,
    history,
    current,
    debtCoverage: coverage(debt),
    incomeCoverage: coverage(income),
    noDebt,
    latestHistoricalAtMs: latest.length ? Math.max(...latest) : null,
    sourcePeriod: dates.length ? { first: dates[0], last: dates[dates.length - 1] } : null,
  }
}

export function costRewardReadKey(scope: string, p: ProtocolPosition): string {
  return `${scope}:${p.chainId ?? 'unknown-chain'}:${p.protocol}:${p.venueAddress ?? 'unknown-venue'}:${p.marketId ?? p.label}:${p.provenance.block ?? 'no-block'}:${p.provenance.at}`
}

export interface RateAnchorReceipt {
  readKey: string
  observedAtMs: number | null
  state: 'ready' | 'error'
}

/** Fail closed on an RPC that returns the wrong block or on an obsolete read's receipt. */
export async function readRateAnchor(
  readKey: string,
  block: number | undefined,
  getBlock: (number: bigint) => Promise<{ number: bigint | null; timestamp: bigint }>,
): Promise<RateAnchorReceipt> {
  if (!Number.isSafeInteger(block) || (block as number) < 0)
    return { readKey, observedAtMs: null, state: 'error' }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      getBlock(BigInt(block as number)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('rate observation deadline')),
          RATE_ANCHOR_DEADLINE_MS,
        )
      }),
    ])
    const at = Number(result.timestamp) * 1000
    return result.number === BigInt(block as number) && Number.isSafeInteger(at) && at > 0
      ? { readKey, observedAtMs: at, state: 'ready' }
      : { readKey, observedAtMs: null, state: 'error' }
  } catch {
    return { readKey, observedAtMs: null, state: 'error' }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export const anchorForRead = (
  key: string,
  receipt: RateAnchorReceipt | null,
): RateAnchorReceipt | null => (receipt?.readKey === key ? receipt : null)
