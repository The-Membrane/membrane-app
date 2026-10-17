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
  /** Share of your supply the market could pay out now, 0–1; null with nothing supplied. */
  withdrawableShare: number | null
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
  /**
   * The rate is a paper rate: 99%+ borrowed, unrealized bad debt, or no on-chain update for
   * over a day. The APR is then never the headline; `paper` says why, from the data.
   */
  paper: string | null
  /** Unrealized bad debt as a share of supply, and your part of it in USD; null without it. */
  pending: { share: number; yoursUsd: number } | null
  /** Seconds since the market's last on-chain update, or null without a block time. */
  sinceUpdateS: number | null
  risks: LenderRisk[]
}

export interface LenderRisk {
  id: 'bad-debt' | 'oracle' | 'curator' | 'exit'
  head: string
  body: string
  /** Reported facts behind it, from the API, in words; empty while it has not answered. */
  facts: string[]
  /** True when the API flags this risk at its highest level, or the read shows it. */
  flagged: boolean
}

const pct = (x: number, d = 2) => `${(x * 100).toFixed(d)}%`
/** "$3.5k" / "$277" / "<$1" */
export const usdShort = (x: number): string =>
  x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `$${(x / 1e3).toFixed(1)}k` : x >= 1 ? `$${x.toFixed(0)}` : x > 0 ? '<$1' : '$0'

/** Utilization at or above this reads as fully borrowed: the rate is a paper rate. */
export const PAPER_UTILIZATION = 0.99
/** No on-chain update for longer than this: the rate is the average over a stale span. */
export const PAPER_STALE_S = 86_400
/** Morpho's adaptive IRM tops out at 4 × the 200% maximum rate at target: 800% APR. */
export const IRM_CEILING_APR = 8

/** Morpho API warning types, by the risk they bear on. Bad-debt types are shown as amounts. */
const WARNING_RISK: Record<string, LenderRisk['id']> = {
  oracle_price_derivation: 'oracle',
  unrecognized_oracle: 'oracle',
  incorrect_oracle: 'oracle',
  not_whitelisted: 'curator',
  sustained_low_liquidity: 'exit',
  low_liquidity: 'exit',
}
/** Shown as amounts already: never repeated as a warning line. */
const AMOUNT_WARNINGS = new Set(['bad_debt_realized', 'bad_debt_unrealized'])
/** The API's warning types in the page's words. Severity drives `flagged`, never the text. */
const WARNING_WORDS: Record<string, string> = {
  not_whitelisted: 'Not listed by Morpho',
  oracle_price_derivation: 'Morpho flags how this oracle derives its price',
  unrecognized_oracle: 'Oracle not recognized by Morpho',
  incorrect_oracle: 'Morpho flags this oracle as incorrect',
  sustained_low_liquidity: 'Liquidity has stayed low',
  low_liquidity: 'Low liquidity',
}
const warningWords = (w: MarketWarning) => WARNING_WORDS[w.type] ?? `Morpho flags: ${w.type.replace(/_/g, ' ')}`

/** "16 days ago" / "5 hours ago" / "just now" */
export function ago(s: number): string {
  if (s >= 2 * 86_400) return `${Math.floor(s / 86_400)} days ago`
  if (s >= 7_200) return `${Math.floor(s / 3_600)} hours ago`
  return 'within the last 2 hours'
}

/** The lender view of a supply-only position. Null when the read carries no market state. */
export function lenderView(p: ProtocolPosition, report: LenderReport | null): LenderView | null {
  const m = p.lendMarket
  const leg = p.supplied?.[0]
  if (!m || !leg) return null
  const withdrawableNow = Math.min(leg.amount, m.liquidity)
  const withdrawableShare = leg.amount > 0 ? withdrawableNow / leg.amount : null
  const rewards = report ? report.rewards : null
  const rewardsTotal = rewards ? rewards.reduce((a, r) => a + r.apr, 0) : null
  const total = m.supplyApr !== null && rewardsTotal !== null ? m.supplyApr + rewardsTotal : null
  const liquidityUsd = m.liquidity * m.priceUsd
  const supplyUsd = m.totalSupply * m.priceUsd

  const shown = (report?.warnings ?? []).filter((w) => !AMOUNT_WARNINGS.has(w.type))
  const byRisk = (id: LenderRisk['id']) => shown.filter((w) => WARNING_RISK[w.type] === id)
  const red = (id: LenderRisk['id']) => byRisk(id).some((w) => w.level.toUpperCase() === 'RED')
  const pending =
    report && report.badDebtUsd !== null && report.badDebtUsd > 0 && supplyUsd > 0
      ? { share: Math.min(1, report.badDebtUsd / supplyUsd), yoursUsd: Math.min(1, report.badDebtUsd / supplyUsd) * leg.valueUsd }
      : null
  const badDebtFacts: string[] = []
  if (pending) badDebtFacts.push(`pending write-off: ${pct(pending.share, 1)} of supply ≈ ${usdShort(pending.yoursUsd)} of yours`)
  else if (report && report.badDebtUsd !== null) badDebtFacts.push('no unrealized bad debt')
  if (report && report.realizedBadDebtUsd !== null && report.realizedBadDebtUsd > 0) {
    badDebtFacts.push(`${usdShort(report.realizedBadDebtUsd)} already written off since market creation`)
  }
  const lltv = p.liquidationLtv > 0 ? ` at ${pct(p.liquidationLtv, 1).replace('.0%', '%')} LLTV` : ''
  const sinceUpdateS = m.blockTs === null ? null : Math.max(0, m.blockTs - m.lastUpdate)

  // The paper rate: each clause only when the data shows it.
  const full = m.utilization >= PAPER_UTILIZATION
  const stale = sinceUpdateS !== null && sinceUpdateS > PAPER_STALE_S
  let paper: string | null = null
  if (full || pending || stale) {
    const parts: string[] = []
    if (full && m.borrowApr !== null) {
      const ceiling = m.borrowApr >= IRM_CEILING_APR - 0.01 ? ' at the rate model’s ceiling' : ''
      parts.push(`Rate${ceiling} (${pct(m.borrowApr, 0)} APR) because ${pct(m.utilization, 0)} is borrowed.`)
    }
    parts.push(
      pending
        ? `Interest accrues on paper; with unrealized bad debt at ${pct(pending.share, 0)} of supply it is not being paid.`
        : 'Interest accrues on paper; it is paid only as borrowers repay.',
    )
    if (sinceUpdateS !== null) parts.push(`Last on-chain update: ${ago(sinceUpdateS)}.`)
    paper = parts.join(' ')
  }

  const risks: LenderRisk[] = [
    {
      id: 'bad-debt',
      head: 'Bad debt is shared',
      body: `A borrower liquidated too late leaves debt no collateral covers; Morpho writes it off against this market's supply, so every lender loses pro rata.`,
      facts: badDebtFacts,
      flagged: pending !== null,
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
      facts: byRisk('curator').map(warningWords),
      flagged: false,
    },
    {
      id: 'exit',
      head: 'Exit is capped by utilization',
      body: `Withdrawable up to the unborrowed supply: at ${pct(m.utilization, 1)} utilization, ${
        liquidityUsd >= 1 ? `${usdShort(liquidityUsd)} is free for all lenders together` : liquidityUsd > 0 ? 'under $1 is free' : 'nothing is free'
      }. A borrow can take it before you do.`,
      facts: byRisk('exit').map(warningWords),
      flagged: red('exit') || (withdrawableShare !== null && withdrawableShare < 1),
    },
  ]

  return {
    symbol: leg.symbol,
    supplied: leg.amount,
    suppliedUsd: leg.valueUsd,
    market: m,
    liquidityUsd,
    withdrawableShare,
    withdrawableNow,
    apr: { base: m.supplyApr, rewards, rewardsTotal, total, marked: (rewardsTotal ?? 0) > 0 },
    paper,
    pending,
    sinceUpdateS,
    risks,
  }
}

/** "100%" / "62%" / "~0%" (something, under 1%) / "0%" / "—" (nothing supplied). */
export function shareText(share: number | null): string {
  if (share === null) return '—'
  if (share >= 1) return '100%'
  const f = Math.floor(share * 100 + 1e-9)
  return f === 0 && share > 0 ? '~0%' : `${f}%`
}

/** "4.18% base · …", every rate "as of last update" (the IRM rate is the average since). */
export function aprLine(v: LenderView, reportState: 'reading' | 'ok' | 'error'): string {
  const a = v.apr
  if (a.base === null) return 'base APR not read'
  const base = `${pct(a.base)} base`
  if (reportState === 'reading') return `${base} · rewards reading…`
  if (reportState === 'error' || a.rewards === null) return `${base} · rewards not read`
  if (!a.marked || a.total === null) return `${base} · no rewards reported`
  return `${base} + ${pct(a.rewardsTotal as number)}${REWARDS_MARK} rewards = ${pct(a.total)}${REWARDS_MARK}`
}

/** What a ‡ reward figure is, next to it: "pool average, at today's FXN price, …". */
export const rewardNote = (symbols: string[]): string =>
  `pool average, at today’s ${symbols.join(' / ') || 'reward-token'} price, claimed separately; the program can end`

/** Morpho's own app quotes APY (compounded); this page quotes simple APR. */
export const APR_NOTE = 'APR, simple. Morpho’s app quotes APY (compounded), which reads higher, far higher at extreme rates.'
