/**
 * A LENDER'S POSITION (owner, 2026-10-17: "Lending has no liquidation line but that's where
 * we want to show venue rewards, risks and capacity forecasting to predict stuckness").
 *
 * Three questions, each from the source that can answer it:
 *   What does it pay?      base supply APR from the on-chain read (borrowRate × utilization ×
 *                          (1 − fee), LendMarketState); rewards from the Morpho API, reported,
 *                          marked ‡ (the same mark the home page's APR composition uses).
 *   What can go wrong?     bad debt is written off against lenders; the oracle prices every
 *                          borrower; there is no curator between a direct supplier and the
 *                          market. Bad-debt amounts and warnings: Morpho API, reported.
 *   Can I get out?         withdrawal capacity NOW: the market's unborrowed supply against
 *                          your supply, on-chain. Its recent history: Morpho API daily
 *                          liquidity, reported. A FORECAST of it: no model exists in the repo
 *                          (MODELS_PLAN M4 "exit trap" is unbuilt), so the forecast region
 *                          is drawn as "model pending" with no numbers.
 *
 * Pure: no React, no I/O. The fetch lives in useLenderReport; the parse is here so the
 * unit test covers a real payload's shape.
 */

import type { LendMarketState, ProtocolPosition } from '@/lib/position-sim/types'

/** The ‡ mark: an APR that includes reported rewards (Q27 #107's convention). */
export const REWARDS_MARK = '‡'

export const MORPHO_REPORT_URL = 'https://blue-api.morpho.org/graphql'
/** Days of liquidity history the chart shows. */
export const HISTORY_DAYS = 30
/** The forecast region's width, days: the page's longest chance horizon. */
export const FORECAST_DAYS = 7

/** One request for everything reported about one market. */
export function reportQuery(marketId: string, nowS: number): { query: string; variables: Record<string, unknown> } {
  return {
    query: `query MembraneLenderMarket($id: String!, $chainId: Int!, $from: Int!, $to: Int!) {
  marketById(marketId: $id, chainId: $chainId) {
    state { rewards { asset { symbol } supplyApr } }
    warnings { type level }
    badDebt { usd }
    realizedBadDebt { usd }
    historicalState {
      liquidityAssetsUsd(options: { startTimestamp: $from, endTimestamp: $to, interval: DAY }) { x y }
    }
  }
}`,
    variables: { id: marketId, chainId: 1, from: Math.floor(nowS - HISTORY_DAYS * 86_400), to: Math.floor(nowS) },
  }
}

export interface RewardLine {
  symbol: string
  /** Fraction (0.046 = 4.6%). */
  apr: number
}

export interface MarketWarning {
  type: string
  level: string
}

export interface LenderReport {
  rewards: RewardLine[]
  warnings: MarketWarning[]
  /** Unrealized and realized bad debt, USD; null when the API gave none. */
  badDebtUsd: number | null
  realizedBadDebtUsd: number | null
  /** Daily liquidity, USD, ascending by time (seconds). */
  history: { t: number; usd: number }[]
  fetchedAt: number
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** The API's body → a report. Throws naming what is missing; never fills a gap with zero. */
export function parseReport(body: unknown, fetchedAt: number): LenderReport {
  const b = body as {
    errors?: { message?: string }[]
    data?: {
      marketById?: {
        state?: { rewards?: { asset?: { symbol?: string }; supplyApr?: number | null }[] } | null
        warnings?: { type?: string; level?: string }[] | null
        badDebt?: { usd?: number | null } | null
        realizedBadDebt?: { usd?: number | null } | null
        historicalState?: { liquidityAssetsUsd?: { x?: number; y?: number | null }[] | null } | null
      } | null
    }
  }
  if (b?.errors?.length) throw new Error(`Morpho API: ${b.errors.map((e) => e.message ?? '?').join('; ')}`)
  const m = b?.data?.marketById
  if (!m) throw new Error('Morpho API: no market in the response')
  const rewards = (m.state?.rewards ?? [])
    .map((r) => ({ symbol: r.asset?.symbol ?? '?', apr: num(r.supplyApr) ?? 0 }))
    .filter((r) => r.apr > 0)
  const warnings = (m.warnings ?? []).map((w) => ({ type: w.type ?? '?', level: w.level ?? '?' }))
  const history = (m.historicalState?.liquidityAssetsUsd ?? [])
    .map((p) => ({ t: num(p.x), usd: num(p.y) }))
    .filter((p): p is { t: number; usd: number } => p.t !== null && p.usd !== null)
    .sort((a, c) => a.t - c.t)
  return {
    rewards,
    warnings,
    badDebtUsd: num(m.badDebt?.usd),
    realizedBadDebtUsd: num(m.realizedBadDebt?.usd),
    history,
    fetchedAt,
  }
}

export interface LenderView {
  symbol: string
  supplied: number
  suppliedUsd: number
  market: LendMarketState
  liquidityUsd: number
  /** Share of your supply the market could pay out now, 0–1. */
  withdrawableShare: number
  /** min(supplied, liquidity), loan-token units. */
  withdrawableNow: number
  apr: {
    base: number | null
    /** Null while the report has not landed (or failed): rewards are then unknown, not zero. */
    rewards: RewardLine[] | null
    rewardsTotal: number | null
    /** base + rewards when both are known. Carries ‡ when rewards are in it. */
    total: number | null
    marked: boolean
  }
  risks: LenderRisk[]
}

export interface LenderRisk {
  id: 'bad-debt' | 'oracle' | 'curator' | 'exit'
  head: string
  body: string
  /** Reported facts behind it, from the API; empty while it has not answered. */
  facts: string[]
  /** True when the API flags this risk RED. */
  flagged: boolean
}

const pct = (x: number, d = 2) => `${(x * 100).toFixed(d)}%`
const usd = (x: number) => (x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `$${(x / 1e3).toFixed(1)}k` : `$${x.toFixed(0)}`)

/** Morpho API warning types that bear on each risk. */
const WARNING_RISK: Record<string, LenderRisk['id']> = {
  bad_debt_realized: 'bad-debt',
  bad_debt_unrealized: 'bad-debt',
  oracle_price_derivation: 'oracle',
  unrecognized_oracle: 'oracle',
  incorrect_oracle: 'oracle',
  sustained_low_liquidity: 'exit',
  low_liquidity: 'exit',
}

/** "bad_debt_unrealized" → "bad debt unrealized" */
const warningWords = (w: MarketWarning) => `${w.type.replace(/_/g, ' ')} (${w.level.toLowerCase()})`

/** The lender view of a supply-only position. Null when the read carries no market state. */
export function lenderView(p: ProtocolPosition, report: LenderReport | null): LenderView | null {
  const m = p.lendMarket
  const leg = p.supplied?.[0]
  if (!m || !leg) return null
  const withdrawableNow = Math.min(leg.amount, m.liquidity)
  const withdrawableShare = leg.amount > 0 ? withdrawableNow / leg.amount : 1
  const rewards = report ? report.rewards : null
  const rewardsTotal = rewards ? rewards.reduce((a, r) => a + r.apr, 0) : null
  const total = m.supplyApr !== null && rewardsTotal !== null ? m.supplyApr + rewardsTotal : null

  const byRisk = (id: LenderRisk['id']) => (report?.warnings ?? []).filter((w) => WARNING_RISK[w.type] === id)
  const red = (id: LenderRisk['id']) => byRisk(id).some((w) => w.level.toUpperCase() === 'RED')
  const badDebtFacts: string[] = []
  if (report && report.badDebtUsd !== null) badDebtFacts.push(`unrealized bad debt ${usd(report.badDebtUsd)}`)
  if (report && report.realizedBadDebtUsd !== null) badDebtFacts.push(`realized ${usd(report.realizedBadDebtUsd)}`)
  const lltv = p.liquidationLtv > 0 ? ` at ${pct(p.liquidationLtv, 1).replace('.0%', '%')} LLTV` : ''

  const risks: LenderRisk[] = [
    {
      id: 'bad-debt',
      head: 'Bad debt is shared',
      body: `A borrower liquidated too late leaves debt no collateral covers; Morpho writes it off against this market's supply, so every lender loses pro rata.`,
      facts: [...badDebtFacts, ...byRisk('bad-debt').map(warningWords)],
      flagged: red('bad-debt') || (report?.badDebtUsd ?? 0) > 0,
    },
    {
      id: 'oracle',
      head: 'One oracle prices every borrower',
      body: `Borrowers here are liquidated${lltv} on the oracle the market was created with. A wrong price lets loans go bad before they are liquidated, and the loss lands on lenders.`,
      facts: byRisk('oracle').map(warningWords),
      flagged: red('oracle'),
    },
    {
      id: 'curator',
      head: 'No curator between you and the market',
      body: 'You supply this market directly, not through a vault: nobody moves your funds out if it turns, and its oracle and LLTV are fixed at creation.',
      facts: [],
      flagged: false,
    },
    {
      id: 'exit',
      head: 'Exit is capped by utilization',
      body: `Withdrawable up to the unborrowed supply: at ${pct(m.utilization, 1)} utilization, ${m.liquidity > 0 ? `${usd(m.liquidity * m.priceUsd)} is free for all lenders together` : 'nothing is free'}. A borrow can take it before you do.`,
      facts: byRisk('exit').map(warningWords),
      flagged: red('exit') || withdrawableShare < 1,
    },
  ]

  return {
    symbol: leg.symbol,
    supplied: leg.amount,
    suppliedUsd: leg.valueUsd,
    market: m,
    liquidityUsd: m.liquidity * m.priceUsd,
    withdrawableShare,
    withdrawableNow,
    apr: { base: m.supplyApr, rewards, rewardsTotal, total, marked: (rewardsTotal ?? 0) > 0 },
    risks,
  }
}

/** "4.18%" / "4.18% + 0.92%‡ = 5.10%‡" / "4.18% · rewards reading…" */
export function aprLine(v: LenderView, reportState: 'reading' | 'ok' | 'error'): string {
  const a = v.apr
  if (a.base === null) return 'base APR not read'
  const base = pct(a.base)
  if (reportState === 'reading') return `${base} base · rewards reading…`
  if (reportState === 'error' || a.rewards === null) return `${base} base · rewards not read`
  if (!a.marked || a.total === null) return `${base} base · no rewards reported`
  return `${base} base + ${pct(a.rewardsTotal as number)}${REWARDS_MARK} rewards = ${pct(a.total)}${REWARDS_MARK}`
}
