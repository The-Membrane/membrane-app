/**
 * A LENDER'S POSITION (owner, 2026-10-17: "Lending has no liquidation line but that's where
 * we want to show venue rewards, risks and capacity forecasting to predict stuckness"; and,
 * the same day: "I don't love the risk section — it's more like vault info. Show the data
 * and forecasting aspects useful for this venue, like capacity and oracle health").
 *
 * The block is DATA, each with its measured history and a forecast region:
 *   What it pays          base supply APR read on-chain; rewards reported (‡).
 *   Capacity / exit       free liquidity against your supply: now on-chain, 30 days reported;
 *                         forecast "model pending (M4 exit-trap)".
 *   Utilization & rate    30 days reported (Morpho API; DefiLlama for pooled venues, which
 *                         gives the supply rate but not utilization for free); forecast
 *                         "model pending (Q33)".
 *   Oracle health         a Morpho market's oracle against the market price (useOracleGap);
 *                         forecast "model pending (M7)".
 *   Bad debt              what is pending write-off, and your share of it.
 * The structure (curator, LLTV, oracle address) is one line of facts, not a list of risks.
 *
 * SOURCES BY VENUE. A Morpho market or vault: the Morpho API (rewards, warnings, bad debt,
 * history). An Aave V3 / Spark reserve or a Compound V3 Comet: DefiLlama's yields chart for
 * the pool (lib/position/llamaPools.generated.json): liquidity (its tvlUsd is supply −
 * borrow) and the supply APY; bad debt from the chain (Aave's reserve deficit, a Comet's
 * negative reserves). Everything reported is marked so; a failure is named, never read as
 * "none".
 *
 * Pure: no React, no I/O. The fetches live in useLenderReport; the parses are here so the
 * unit test covers a real payload's shape.
 */

import { baselineFan, type Baseline } from './baselineFan'
import llamaPools from './llamaPools.generated.json'
import type { LendMarketState, ProtocolId, ProtocolPosition } from '@/lib/position-sim/types'

/** The ‡ mark: an APR that includes reported rewards (Q27 #107's convention). */
export const REWARDS_MARK = '‡'

export const MORPHO_REPORT_URL = 'https://blue-api.morpho.org/graphql'
export const LLAMA_CHART_URL = 'https://yields.llama.fi/chart/'
/** Days of history the charts show. */
export const HISTORY_DAYS = 30
/** Days of free-liquidity history read for the exit region's untested baseline (lib/position/baselineFan.ts). */
export const BASELINE_DAYS = 365
/** The forecast region's width, days: the page's longest chance horizon. */
export const FORECAST_DAYS = 7

/** The models each forecast region waits on (MODELS_PLAN ids), named on the region. */
export const PENDING_MODEL = {
  exit: 'M4 exit-trap',
  rate: 'Q33',
  oracle: 'M7',
} as const

// ------------------------------------------------------------------ history sources

/** A reported series point: unix seconds, value. */
export interface SeriesPoint {
  t: number
  v: number
}

export type ReportSource = 'Morpho API' | 'DefiLlama yields'

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
  source: ReportSource
  /** Reward programs reported; null when the source gives none for this venue kind. */
  rewards: RewardLine[] | null
  warnings: MarketWarning[]
  /** Unrealized and realized bad debt, USD; null when the source gives none. */
  badDebtUsd: number | null
  realizedBadDebtUsd: number | null
  /** Daily series, ascending by time. Empty = this source does not report it. */
  liquidityUsd: SeriesPoint[]
  /** Free liquidity over the last BASELINE_DAYS (the exit baseline's input); empty when not reported. */
  liquidityYearUsd: SeriesPoint[]
  utilization: SeriesPoint[]
  supplyApr: SeriesPoint[]
  borrowApr: SeriesPoint[]
  /** A vault's net APR now (after its fee, rewards excluded), reported; null elsewhere. */
  netApr: number | null
  fetchedAt: number
}

/**
 * A reported APY → the simple APR this page quotes: ln(1 + APY), the continuous rate that
 * compounds to it (Morpho and Aave accrue per second, so this is their own rate).
 */
export const aprFromApy = (apy: number): number => Math.log1p(apy)

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

const series = (xs: { x?: number; y?: number | null }[] | null | undefined, f: (y: number) => number = (y) => y): SeriesPoint[] =>
  (xs ?? [])
    .map((p) => ({ t: num(p.x), v: num(p.y) }))
    .filter((p): p is { t: number; v: number } => p.t !== null && p.v !== null)
    .map((p) => ({ t: p.t, v: f(p.v) }))
    .sort((a, b) => a.t - b.t)

const RANGE = `options: { startTimestamp: $from, endTimestamp: $to, interval: DAY }`
const YEAR_RANGE = `options: { startTimestamp: $fromYear, endTimestamp: $to, interval: DAY }`
const lastDays = (xs: SeriesPoint[], fetchedAtS: number): SeriesPoint[] => xs.filter((p) => p.t >= fetchedAtS - HISTORY_DAYS * 86_400)

/** One request for everything reported about one Morpho market. */
export function reportQuery(marketId: string, nowS: number): { query: string; variables: Record<string, unknown> } {
  return {
    query: `query MembraneLenderMarket($id: String!, $chainId: Int!, $from: Int!, $fromYear: Int!, $to: Int!) {
  marketById(marketId: $id, chainId: $chainId) {
    state { rewards { asset { symbol } supplyApr } }
    warnings { type level }
    badDebt { usd }
    realizedBadDebt { usd }
    historicalState {
      liquidityAssetsUsd(${YEAR_RANGE}) { x y }
      utilization(${RANGE}) { x y }
      supplyApy(${RANGE}) { x y }
      borrowApy(${RANGE}) { x y }
    }
  }
}`,
    variables: {
      id: marketId,
      chainId: 1,
      from: Math.floor(nowS - HISTORY_DAYS * 86_400),
      fromYear: Math.floor(nowS - BASELINE_DAYS * 86_400),
      to: Math.floor(nowS),
    },
  }
}

/** One request for a MetaMorpho vault. */
export function vaultReportQuery(address: string, nowS: number): { query: string; variables: Record<string, unknown> } {
  return {
    query: `query MembraneLenderVault($address: String!, $chainId: Int!, $from: Int!, $to: Int!) {
  vaultByAddress(address: $address, chainId: $chainId) {
    warnings { type level }
    state { netApyExcludingRewards allRewards { asset { symbol } supplyApr } }
    historicalState { netApyWithoutRewards(${RANGE}) { x y } }
  }
}`,
    variables: { address, chainId: 1, from: Math.floor(nowS - HISTORY_DAYS * 86_400), to: Math.floor(nowS) },
  }
}

type Xy = { x?: number; y?: number | null }[] | null

/** The Morpho API's market body → a report. Throws naming what is missing; never fills a gap with zero. */
export function parseReport(body: unknown, fetchedAt: number): LenderReport {
  const b = body as {
    errors?: { message?: string }[]
    data?: {
      marketById?: {
        state?: { rewards?: { asset?: { symbol?: string }; supplyApr?: number | null }[] } | null
        warnings?: { type?: string; level?: string }[] | null
        badDebt?: { usd?: number | null } | null
        realizedBadDebt?: { usd?: number | null } | null
        historicalState?: { liquidityAssetsUsd?: Xy; utilization?: Xy; supplyApy?: Xy; borrowApy?: Xy } | null
      } | null
    }
  }
  if (b?.errors?.length) throw new Error(`Morpho API: ${b.errors.map((e) => e.message ?? '?').join('; ')}`)
  const m = b?.data?.marketById
  if (!m) throw new Error('Morpho API: no market in the response')
  const h = m.historicalState
  const year = series(h?.liquidityAssetsUsd)
  return {
    source: 'Morpho API',
    rewards: (m.state?.rewards ?? []).map((r) => ({ symbol: r.asset?.symbol ?? '?', apr: num(r.supplyApr) ?? 0 })).filter((r) => r.apr > 0),
    warnings: (m.warnings ?? []).map((w) => ({ type: w.type ?? '?', level: w.level ?? '?' })),
    badDebtUsd: num(m.badDebt?.usd),
    realizedBadDebtUsd: num(m.realizedBadDebt?.usd),
    liquidityUsd: lastDays(year, fetchedAt / 1000),
    liquidityYearUsd: year,
    utilization: series(h?.utilization),
    supplyApr: series(h?.supplyApy, aprFromApy),
    borrowApr: series(h?.borrowApy, aprFromApy),
    netApr: null,
    fetchedAt,
  }
}

/** The Morpho API's vault body → a report (no liquidity or utilization history: not reported for vaults). */
export function parseVaultReport(body: unknown, fetchedAt: number): LenderReport {
  const b = body as {
    errors?: { message?: string }[]
    data?: {
      vaultByAddress?: {
        warnings?: { type?: string; level?: string }[] | null
        state?: { netApyExcludingRewards?: number | null; allRewards?: { asset?: { symbol?: string }; supplyApr?: number | null }[] | null } | null
        historicalState?: { netApyWithoutRewards?: Xy } | null
      } | null
    }
  }
  if (b?.errors?.length) throw new Error(`Morpho API: ${b.errors.map((e) => e.message ?? '?').join('; ')}`)
  const v = b?.data?.vaultByAddress
  if (!v) throw new Error('Morpho API: no vault in the response')
  // The base excludes rewards: rewards are their own ‡ lines (Morpho's netApy includes them).
  const net = num(v.state?.netApyExcludingRewards)
  return {
    source: 'Morpho API',
    rewards: (v.state?.allRewards ?? []).map((r) => ({ symbol: r.asset?.symbol ?? '?', apr: num(r.supplyApr) ?? 0 })).filter((r) => r.apr > 0),
    warnings: (v.warnings ?? []).map((w) => ({ type: w.type ?? '?', level: w.level ?? '?' })),
    badDebtUsd: null,
    realizedBadDebtUsd: null,
    liquidityUsd: [],
    liquidityYearUsd: [],
    utilization: [],
    supplyApr: series(v.historicalState?.netApyWithoutRewards, aprFromApy),
    borrowApr: [],
    netApr: net === null ? null : aprFromApy(net),
    fetchedAt,
  }
}

/**
 * DefiLlama's /chart/{pool} body → a report: daily liquidity (tvlUsd, which for a lending
 * pool is supply − borrow) and the base supply rate, the last HISTORY_DAYS days (and BASELINE_DAYS of liquidity for the baseline), one point
 * per UTC day (the newest of the day). Rewards: the newest apyReward, as one line, since
 * the chart names no reward token. Utilization and borrow history are not in the free API.
 */
export function parseLlamaChart(body: unknown, fetchedAt: number): LenderReport {
  const b = body as { status?: string; data?: { timestamp?: string; tvlUsd?: number | null; apyBase?: number | null; apyReward?: number | null }[] }
  if (!b || !Array.isArray(b.data)) throw new Error('DefiLlama: no data in the response')
  const from = fetchedAt / 1000 - HISTORY_DAYS * 86_400
  const fromYear = fetchedAt / 1000 - BASELINE_DAYS * 86_400
  const byDay = new Map<number, { t: number; tvl: number | null; base: number | null; reward: number | null }>()
  for (const p of b.data) {
    const t = p.timestamp ? Date.parse(p.timestamp) / 1000 : NaN
    if (!Number.isFinite(t) || t < fromYear) continue
    const day = Math.floor(t / 86_400)
    const prev = byDay.get(day)
    if (!prev || t > prev.t) byDay.set(day, { t, tvl: num(p.tvlUsd), base: num(p.apyBase), reward: num(p.apyReward) })
  }
  const year = [...byDay.values()].sort((a, c) => a.t - c.t)
  const pts = year.filter((p) => p.t >= from)
  const last = pts[pts.length - 1]
  const reward = last?.reward ?? null
  return {
    source: 'DefiLlama yields',
    rewards: reward !== null && reward > 0 ? [{ symbol: 'reward tokens', apr: reward / 100 }] : last ? [] : null,
    warnings: [],
    badDebtUsd: null,
    realizedBadDebtUsd: null,
    liquidityUsd: pts.filter((p) => p.tvl !== null).map((p) => ({ t: p.t, v: p.tvl as number })),
    liquidityYearUsd: year.filter((p) => p.tvl !== null).map((p) => ({ t: p.t, v: p.tvl as number })),
    utilization: [],
    supplyApr: pts.filter((p) => p.base !== null).map((p) => ({ t: p.t, v: aprFromApy((p.base as number) / 100) })),
    borrowApr: [],
    netApr: null,
    fetchedAt,
  }
}

interface LlamaPools {
  ambiguous: { key: string; symbols: string[] }[]
  pools: { protocol: string; underlying: string; symbol: string; pool: string }[]
}
const POOLS = llamaPools as LlamaPools

/** The DefiLlama pool for a pooled venue's market, or null when none is matched. Pure. */
export function llamaPoolFor(protocol: ProtocolId, token: string): string | null {
  const t = token.toLowerCase()
  return POOLS.pools.find((p) => p.protocol === protocol && p.underlying === t)?.pool ?? null
}

/** Where a position's report comes from: one request, or none (with why). Pure. */
export type ReportRequest =
  | { kind: 'morpho-market'; id: string }
  | { kind: 'morpho-vault'; address: string }
  | { kind: 'llama'; pool: string }
  | { kind: 'none'; reason: string }

export function reportRequest(p: ProtocolPosition): ReportRequest {
  const m = p.lendMarket
  if (!m) return { kind: 'none', reason: 'no market state' }
  if (m.venue === 'morpho-market') return p.marketId ? { kind: 'morpho-market', id: p.marketId } : { kind: 'none', reason: 'no market id' }
  if (m.venue === 'morpho-vault') return m.vault ? { kind: 'morpho-vault', address: m.vault.address } : { kind: 'none', reason: 'no vault' }
  const pool = llamaPoolFor(p.protocol, m.token)
  return pool ? { kind: 'llama', pool } : { kind: 'none', reason: `no DefiLlama pool matched for ${m.symbol} on this venue` }
}

// ------------------------------------------------------------------ the view

export interface LenderView {
  venue: LendMarketState['venue']
  symbol: string
  supplied: number
  suppliedUsd: number
  market: LendMarketState
  liquidityUsd: number
  /** Share of your supply that could leave now, 0–1; null with nothing supplied. */
  withdrawableShare: number | null
  /** Loan-token units: min(supplied, liquidity), or a vault's own maxWithdraw. */
  withdrawableNow: number
  apr: {
    base: number | null
    /** Null while the report has not landed (or failed): rewards are then unknown, not zero. */
    rewards: RewardLine[] | null
    rewardsTotal: number | null
    /** base + rewards when both are known. Carries ‡ when rewards are in it. */
    total: number | null
    marked: boolean
    /** A vault's net APR, reported (no on-chain base). */
    reported: number | null
  }
  /**
   * The rate is a paper rate: 99%+ borrowed, unrealized bad debt, or no on-chain update for
   * over a day. The APR is then never the headline; `paper` says why, from the data.
   */
  paper: string | null
  /** Bad debt pending write-off as a share of supply, and your part of it in USD. */
  pending: { share: number; yoursUsd: number } | null
  badDebt: {
    /** "pending write-off: 44.6% of supply ≈ $124 of yours" / "no unrealized bad debt" / null (not read). */
    line: string | null
    realized: string | null
    /** Where it was read. */
    source: string
    /** Lenders carry part of it: printed in the danger ink. */
    danger: boolean
  }
  /** Seconds since the market's last on-chain update, or null without a block time. */
  sinceUpdateS: number | null
  /** The structure in one line: "Direct market · no curator · LLTV 86% · oracle 0x1234…abcd". */
  facts: string
  /** The source's warnings, in words (severity drives `flagged`, never the text). */
  warnings: { text: string; flagged: boolean }[]
}

const pct = (x: number, d = 2) => `${(x * 100).toFixed(d)}%`
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
/** "$3.5k" / "$277" / "<$1" */
export const usdShort = (x: number): string =>
  x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `$${(x / 1e3).toFixed(1)}k` : x >= 1 ? `$${x.toFixed(0)}` : x > 0 ? '<$1' : '$0'

/** Utilization at or above this reads as fully borrowed: the rate is a paper rate. */
export const PAPER_UTILIZATION = 0.99
/** No on-chain update for longer than this: the rate is the average over a stale span. */
export const PAPER_STALE_S = 86_400
/** Morpho's adaptive IRM tops out at 4 × the 200% maximum rate at target: 800% APR. */
export const IRM_CEILING_APR = 8

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

/** "16 days ago" / "5 hours ago" / "within the last 2 hours" */
export function ago(s: number): string {
  if (s >= 2 * 86_400) return `${Math.floor(s / 86_400)} days ago`
  if (s >= 7_200) return `${Math.floor(s / 3_600)} hours ago`
  return 'within the last 2 hours'
}

/** The structure in one line, from the read. Pure. */
export function factsLine(p: ProtocolPosition, m: LendMarketState): string {
  const fee = m.fee === null ? null : `fee ${pct(m.fee, 0)}`
  switch (m.venue) {
    case 'morpho-market': {
      const mp = m.morpho
      const lltv = mp ? `LLTV ${pct(mp.lltv, 1).replace('.0%', '%')}` : null
      return ['Direct Morpho market', 'no curator', lltv, mp ? `oracle ${short(mp.oracle)}` : null, fee, 'oracle and LLTV fixed at creation']
        .filter(Boolean)
        .join(' · ')
    }
    case 'morpho-vault': {
      const v = m.vault
      return [
        'MetaMorpho vault',
        v?.curator ? `curator ${short(v.curator)}` : v?.owner ? `owner ${short(v.owner)}, no curator set` : null,
        v ? `${v.allocation.filter((a) => a.assets > 0).length} of ${v.allocation.length} queue markets funded` : null,
        fee,
        'the curator can move supply between markets',
      ]
        .filter(Boolean)
        .join(' · ')
    }
    case 'aave-reserve':
      return [`${p.protocol === 'spark' ? 'Spark' : 'Aave V3'} pool reserve`, 'governed by the DAO', 'every listed collateral backs it', fee ? fee.replace('fee', 'reserve factor') : null]
        .filter(Boolean)
        .join(' · ')
    case 'comet':
      return [`Compound V3 Comet${m.marketName ? ` ${m.marketName}` : ''}`, 'governed by Compound', `lends ${m.symbol} only`, 'its listed collateral backs it']
        .join(' · ')
  }
}

/**
 * BAD DEBT, IN WORDS: the one source for the lending block's line and the hero's sentence,
 * worded per venue from what was read. Pure.
 *   Morpho market   the API's unrealized bad debt is written off against supply: a share of yours.
 *   Aave V3         Pool.getReserveDeficit is debt with no backing. Umbrella may cover it only
 *                   when the reserve is slashable, up to its stake; the rest is uncovered, so
 *                   aToken claims exceed the reserve's backing by uncovered ÷ supply, and the
 *                   last lenders out cannot be paid that share. Nothing else is assumed to cover it.
 *   Spark           getReserveDeficit reverts there: the deficit is not readable.
 *   Compound V3     reserves below zero are bad debt the reserves no longer cover.
 *   Vault           not read (each market's bad debt reaches it by allocation).
 */
export function badDebtWords(
  p: ProtocolPosition,
  report: LenderReport | null,
): { line: string | null; short: string; danger: boolean; pending: LenderView['pending']; realized: string | null; source: string } {
  const m = p.lendMarket
  const leg = p.supplied?.[0]
  const generic = 'Bad debt in this market is shared by lenders.'
  if (!m || !leg) return { line: null, short: generic, danger: false, pending: null, realized: null, source: 'not read' }
  const supplyUsd = m.totalSupply * m.priceUsd
  const lost = (share: number) => ({ share, yoursUsd: share * leg.valueUsd })
  const lastOut = (share: number) =>
    `if lenders withdraw in full, the last ${pct(share, 2)} out cannot be paid — ≈ ${usdShort(share * leg.valueUsd)} of yours`
  switch (m.venue) {
    case 'morpho-market': {
      let line: string | null = null
      let pending: LenderView['pending'] = null
      if (report && report.badDebtUsd !== null) {
        if (report.badDebtUsd > 0 && supplyUsd > 0) {
          pending = lost(Math.min(1, report.badDebtUsd / supplyUsd))
          line = `pending write-off: ${pct(pending.share, 1)} of supply ≈ ${usdShort(pending.yoursUsd)} of yours`
        } else line = 'no unrealized bad debt'
      }
      const realized =
        report && report.realizedBadDebtUsd !== null && report.realizedBadDebtUsd > 0
          ? `${usdShort(report.realizedBadDebtUsd)} already written off since market creation`
          : null
      return { line, short: generic, danger: pending !== null, pending, realized, source: 'Morpho API, reported' }
    }
    case 'morpho-vault':
      return {
        line: null,
        short: 'Bad debt in the vault’s markets reaches its holders.',
        danger: false,
        pending: null,
        realized: null,
        source: 'not read for vaults (each market’s bad debt reaches the vault by its allocation)',
      }
    case 'comet': {
      if (m.deficit === null || m.deficit === undefined)
        return { line: null, short: 'Compound covers bad debt from its reserves.', danger: false, pending: null, realized: null, source: 'not read (getReserves failed)' }
      if (m.deficit > 0 && m.totalSupply > 0) {
        const share = Math.min(1, m.deficit / m.totalSupply)
        return {
          line: `Compound’s reserves are below zero by ${pct(share, 2)} of supply; ${lastOut(share)}`,
          short: `${pct(share, 2)} of this market’s supply has no backing.`,
          danger: true,
          pending: lost(share),
          realized: null,
          source: 'on-chain, Comet.getReserves (negative = uncovered)',
        }
      }
      return { line: 'no uncovered bad debt', short: 'Compound covers bad debt from its reserves first.', danger: false, pending: null, realized: null, source: 'on-chain, Comet.getReserves (negative = uncovered)' }
    }
    case 'aave-reserve': {
      if (m.deficit === null || m.deficit === undefined) {
        const spark = p.protocol === 'spark'
        return {
          line: spark ? 'deficit not readable on Spark' : 'deficit not read',
          short: spark ? 'A reserve deficit is not readable on Spark.' : generic,
          danger: false,
          pending: null,
          realized: null,
          source: spark ? 'Pool.getReserveDeficit reverts on Spark' : 'not read (Pool.getReserveDeficit failed)',
        }
      }
      const src = `on-chain, Pool.getReserveDeficit${m.backstop ? ' and Aave Umbrella' : ' (Umbrella not read)'}`
      if (!(m.deficit > 0) || !(m.totalSupply > 0))
        return { line: 'no reserve deficit', short: 'This reserve has no deficit.', danger: false, pending: null, realized: null, source: src }
      const b = m.backstop
      const covered = b && b.slashable ? Math.min(m.deficit, b.stake ?? 0) : 0
      const uncovered = m.deficit - covered
      if (uncovered <= 0) {
        const share = m.deficit / m.totalSupply
        return {
          line: `reserve deficit: ${pct(share, 2)} of supply; slashable, and Umbrella’s stake covers it`,
          short: 'This reserve’s deficit is covered by Umbrella’s stake.',
          danger: false,
          pending: null,
          realized: null,
          source: src,
        }
      }
      const share = Math.min(1, uncovered / m.totalSupply)
      const why = !b ? 'Umbrella not read' : !b.slashable ? 'Umbrella cannot slash for it' : 'Umbrella’s stake is smaller'
      return {
        line: `${pct(share, 2)} of this reserve’s supply has no backing (an on-chain deficit; ${why}); ${lastOut(share)}`,
        short: `${pct(share, 2)} of this reserve’s supply has no backing.`,
        danger: true,
        pending: lost(share),
        realized: null,
        source: src,
      }
    }
  }
}

/** The lender view of a supply-only position. Null when the read carries no market state. */
export function lenderView(p: ProtocolPosition, report: LenderReport | null): LenderView | null {
  const m = p.lendMarket
  const leg = p.supplied?.[0]
  if (!m || !leg) return null
  const withdrawableNow = m.vault ? Math.min(leg.amount, m.vault.maxWithdraw) : Math.min(leg.amount, m.liquidity)
  const withdrawableShare = leg.amount > 0 ? withdrawableNow / leg.amount : null
  const rewards = report ? report.rewards : null
  const rewardsTotal = rewards ? rewards.reduce((a, r) => a + r.apr, 0) : null
  const total = m.supplyApr !== null && rewardsTotal !== null ? m.supplyApr + rewardsTotal : null
  const liquidityUsd = m.liquidity * m.priceUsd

  const debt = badDebtWords(p, report)
  const pending = debt.pending
  const line = debt.line
  const realized = debt.realized
  const source = debt.source

  // Only a Morpho market's rate is "as of its last update": Aave's liquidityRate and a
  // Comet's getSupplyRate are live at the read block.
  const sinceUpdateS = m.blockTs === null || m.venue !== 'morpho-market' ? null : Math.max(0, m.blockTs - m.lastUpdate)

  // The paper rate: each clause only when the data shows it.
  const full = m.utilization >= PAPER_UTILIZATION && m.venue !== 'morpho-vault'
  const stale = sinceUpdateS !== null && sinceUpdateS > PAPER_STALE_S
  // Unpaid interest from bad debt is a Morpho-market fact: Aave and Compound still pay it.
  const unpaid = m.venue === 'morpho-market' ? pending : null
  let paper: string | null = null
  if (full || unpaid || stale) {
    const parts: string[] = []
    if (full && m.borrowApr !== null) {
      const ceiling = m.venue === 'morpho-market' && m.borrowApr >= IRM_CEILING_APR - 0.01 ? ' at the rate model’s ceiling' : ''
      parts.push(`Rate${ceiling} (${pct(m.borrowApr, 0)} APR) because ${pct(m.utilization, 0)} is borrowed.`)
    }
    parts.push(
      unpaid
        ? `Interest accrues on paper; with unrealized bad debt at ${pct(unpaid.share, 0)} of supply it is not being paid.`
        : 'Interest accrues on paper; it is paid only as borrowers repay.',
    )
    if (sinceUpdateS !== null) parts.push(`Last on-chain update: ${ago(sinceUpdateS)}.`)
    paper = parts.join(' ')
  }

  const warnings = (report?.warnings ?? [])
    .filter((w) => !AMOUNT_WARNINGS.has(w.type))
    .map((w) => ({ text: warningWords(w), flagged: w.level.toUpperCase() === 'RED' }))

  return {
    venue: m.venue,
    symbol: leg.symbol,
    supplied: leg.amount,
    suppliedUsd: leg.valueUsd,
    market: m,
    liquidityUsd,
    withdrawableShare,
    withdrawableNow,
    apr: {
      base: m.supplyApr,
      rewards,
      rewardsTotal,
      total,
      marked: (rewardsTotal ?? 0) > 0,
      reported: report?.netApr ?? null,
    },
    paper,
    pending,
    badDebt: { line, realized, source, danger: debt.danger },
    sinceUpdateS,
    facts: factsLine(p, m),
    warnings,
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
  if (a.base === null) {
    if (a.reported !== null) {
      const net = `${pct(a.reported)} net, reported (after the vault’s fee)`
      if (!a.marked || a.rewardsTotal === null) return reportState === 'ok' ? `${net} · no rewards reported` : net
      return `${net} + ${pct(a.rewardsTotal)}${REWARDS_MARK} rewards = ${pct(a.reported + a.rewardsTotal)}${REWARDS_MARK}`
    }
    return reportState === 'reading' ? 'base APR not read on-chain · reported rate reading…' : 'base APR not read'
  }
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
export const APR_NOTE = 'APR, simple. Venue apps quote APY (compounded), which reads higher, far higher at extreme rates.'

/** Token-amount decimals on this block: whole units from 100 up, else 2 (the supply row's rule). */
export const amountDp = (x: number): number => (x >= 100 ? 0 : 2)

/**
 * The exit region's untested baseline, or why not (null: no report yet, or a vault, whose
 * liquidity history is not reported). DefiLlama's tvlUsd is supply − borrow, so on a reserve
 * carrying a deficit its history counts the deficit as liquidity (an Aave deficit booking
 * reads as a jump), while "now" is cash: the moves are of a different quantity. With no
 * history of the deficit to take out, that case stays pending.
 */
export function exitBaseline(report: LenderReport | null, v: LenderView, nowS: number): Baseline | null {
  if (!report || v.venue === 'morpho-vault') return null
  if (report.source === 'DefiLlama yields' && (v.market.deficit ?? 0) > 0) {
    return { ok: false, reason: 'its history includes the deficit, not cash' }
  }
  return baselineFan(report.liquidityYearUsd, v.liquidityUsd, nowS, 'ratio')
}

/**
 * When the history of free liquidity hugs the floor of an axis drawn to `top` (under 2% of
 * it all window long), the line is real but invisible: say what it was. Null otherwise.
 */
export function flatHistoryNote(points: SeriesPoint[], top: number): string | null {
  if (points.length === 0 || !(top > 0)) return null
  const max = Math.max(...points.map((p) => p.v))
  if (max >= top * 0.02) return null
  const at = max >= 1 ? usdShort(max) : max > 0 ? `$${max.toFixed(2)}` : '$0'
  return max < 1
    ? `under $1 free all ${HISTORY_DAYS} days (at most ${at})`
    : `at most ${at} free over ${HISTORY_DAYS} days`
}
