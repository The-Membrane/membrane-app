/**
 * THE COST-VS-REWARD TRACKER (board Q34; spec membrane-board design/COST_REWARD_TRACKER.md):
 * what rates cost and paid at today's size, as measured history. Pure: no I/O. The fixture
 * comes from real archive reads (scripts/position/capture-slip-fixtures.ts --rates).
 *
 *   N_i  = q_i(t0) × p_i(t0)              each leg frozen at the capture read [USD]
 *   C(t) = Σ debt N_i × borrowAPR_i(t)     [USD/year]
 *   R(t) = Σ reward N_i × supplyAPR_i(t)   [USD/year]
 *   S(t) = R(t) − C(t)                     [USD/year; a proposed new number, ruling 1]
 *
 * S(t) is the YIELD SPREAD (owner, Q27 round 5: "income − interest" is wrong; call it the
 * yield spread everywhere). Its percent reads against the position's net value at the
 * capture read (collateral − debt, both frozen): spreadPct.
 *
 * INCENTIVES ‡ (round 5; spec §3 "Incentives"). Reward APRs from a source that serves
 * them (Morpho's API rewards, Merkl campaigns) are CURRENT ONLY: Merkl serves no APR
 * history, so an incentive is never drawn back over the history, and never back-filled
 * from a campaign's start date. It enters as a separate figure at the last observation,
 * "yield spread with incentives ‡", beside the base spread, which keeps excluding them.
 * A supply incentive adds N × APR to income; a borrow incentive takes N × APR off the
 * interest. A source with no live campaign for a leg is said so, with its fetch time.
 * These are ANNUALIZED SNAPSHOTS, not what the reader paid or earned: never integrate them
 * into "earned"/"paid", and a crossing is not a break-even date (spec §3). The fixture also
 * keeps each venue index for a later ledger; nothing here sums it into an earnings figure.
 * Incentives are not in either line: Merkl serves campaign dates and no APR history.
 *
 * The forward segment is a forecast and waits on the Q33 rate model passing (owner
 * ruling, Q34). Until then only its extent is known: the longest horizon Q33's
 * preregistration targets. No values, no band.
 */

/** Days of history before the capture block. */
export const RATE_DAYS = 90

/** Days of rate history behind the spread's untested baseline (model-only; lib/position/baselineFan.ts). */
export const BASELINE_DAYS = 365

/** The baseline's input: the same legs' two rates, one archive read a day, ending at the rate fixture's block. */
export interface BaselineFixture {
  capturedAt: string
  block: number
  source: string
  series: Record<string, { block: number; ts: number; borrowApr: number; supplyApr: number }[]>
}

/** The horizons Q33's preregistration targets (board Q33, "Targets"), in days. */
export const Q33_HORIZONS_D = [1, 3, 7, 14, 30] as const

/** The forward segment's extent: Q33's longest horizon. */
export const FORECAST_EXTENT_D = Q33_HORIZONS_D[Q33_HORIZONS_D.length - 1]

export interface RatePoint {
  block: number
  /** Block time, unix seconds. */
  ts: number
  /** Variable borrow APR, 0–1. */
  borrowApr: number
  /** Supply APR, 0–1 (the venue's liquidity rate, reserve factor already deducted). */
  supplyApr: number
  /** The venue's variable borrow index (ray), decimal string. Kept for a later ledger. */
  borrowIndex: string
  /** The venue's liquidity index (ray), decimal string. Kept for a later ledger. */
  supplyIndex: string
}

export interface FixtureLeg {
  symbol: string
  address: string
  amount: number
  priceUsd: number
}

/** One live incentive campaign on a leg, as its source reported it at `fetchedAt`. */
export interface IncentiveCampaign {
  /** The source's id for it (Merkl opportunity id; Morpho reward asset). */
  id: string
  name: string
  /** The reported APR now, 0–1. Current only: there is no history behind it. */
  apr: number
  /** Unix seconds; null when the source gives none. */
  start: number | null
  end: number | null
  rewardToken: string | null
  /** Conditions the source states ("looping required"), or null. */
  conditions: string | null
}

export interface LegIncentives {
  /** The leg's token address, lower case. */
  address: string
  side: 'supply' | 'borrow'
  campaigns: IncentiveCampaign[]
}

export interface IncentiveRead {
  /** "Merkl v4 /opportunities · chainId 1 · AAVE_SUPPLY, AAVE_BORROW, … · status LIVE" */
  source: string
  /** ISO time of the fetch. */
  fetchedAt: string
  /** How many live opportunities the source listed for the venue (all assets). */
  searched: number
  legs: LegIncentives[]
}

export interface RateFixture {
  capturedAt: string
  owner: string
  block: number
  source: string
  position: { label: string; collateral: FixtureLeg[]; debt: FixtureLeg[] }
  /** Per leg address (lower case), oldest first, one point per day. */
  series: Record<string, RatePoint[]>
  /** The incentive sources' current campaigns per leg; absent when not read. */
  incentives?: IncentiveRead
}

export interface TrackPoint {
  ts: number
  /** C(t), $ per year at today's size and prices. */
  costRate: number
  /** R(t). */
  rewardRate: number
  /** S(t) = R(t) − C(t). */
  spread: number
}

export interface TrackLeg {
  side: 'cost' | 'reward'
  symbol: string
  amount: number
  priceUsd: number
  /** N_i: the frozen notional. */
  sizeUsd: number
  /** The leg's APR at each point, 0–1. */
  aprs: number[]
  /** That leg's $ per year at each point. */
  rates: number[]
}

export interface Track {
  points: TrackPoint[]
  legs: TrackLeg[]
  /** Unix seconds: the first and last observation, and the end of the forward extent. */
  from: number
  to: number
  forecastTo: number
}

const aprOf = (side: 'cost' | 'reward', p: RatePoint) => (side === 'cost' ? p.borrowApr : p.supplyApr)

export function costRewardTrack(fx: RateFixture): Track {
  const legs = [
    ...fx.position.debt.map((l) => ({ side: 'cost' as const, l })),
    ...fx.position.collateral.map((l) => ({ side: 'reward' as const, l })),
  ].map(({ side, l }) => {
    const s = fx.series[l.address.toLowerCase()]
    if (!s || s.length < 2) throw new Error(`costRewardTrack: no rate history for ${l.symbol}`)
    return { side, l, sizeUsd: l.amount * l.priceUsd, s }
  })
  const n = legs[0].s.length
  for (const g of legs) {
    // An aggregate point exists only when every leg was read at that block (spec §3).
    if (g.s.length !== n || g.s.some((p, i) => p.block !== legs[0].s[i].block)) {
      throw new Error('costRewardTrack: legs were not read at the same blocks')
    }
  }
  const points: TrackPoint[] = legs[0].s.map((p0, i) => {
    let costRate = 0
    let rewardRate = 0
    for (const g of legs) {
      const v = g.sizeUsd * aprOf(g.side, g.s[i])
      if (g.side === 'cost') costRate += v
      else rewardRate += v
    }
    return { ts: p0.ts, costRate, rewardRate, spread: rewardRate - costRate }
  })
  const to = points[n - 1].ts
  return {
    points,
    legs: legs.map((g) => ({
      side: g.side,
      symbol: g.l.symbol,
      amount: g.l.amount,
      priceUsd: g.l.priceUsd,
      sizeUsd: g.sizeUsd,
      aprs: g.s.map((p) => aprOf(g.side, p)),
      rates: g.s.map((p) => g.sizeUsd * aprOf(g.side, p)),
    })),
    from: points[0].ts,
    to,
    forecastTo: to + FORECAST_EXTENT_D * 86_400,
  }
}

/**
 * The yield spread S(t) over the baseline capture: the same legs at the same frozen sizes as
 * the track, one point a day (the untested baseline's input; never drawn as history).
 */
export function baselineSpreadSeries(fx: RateFixture, b: BaselineFixture): { t: number; v: number }[] {
  if (b.block !== fx.block) throw new Error('baselineSpreadSeries: the baseline does not end at the fixture block')
  const series: Record<string, RatePoint[]> = Object.fromEntries(
    Object.entries(b.series).map(([k, ps]) => [k, ps.map((p) => ({ ...p, borrowIndex: '', supplyIndex: '' }))]),
  )
  return costRewardTrack({ ...fx, series }).points.map((p) => ({ t: p.ts, v: p.spread }))
}

/** The history windows the spec offers (§3): 7d, 30d (the default) and all available. */
export const WINDOWS = ['7d', '30d', 'all'] as const
export type HistoryWindow = (typeof WINDOWS)[number]

/** The last `w` of the track: every observation within it, the last one included. */
export function windowed(t: Track, w: HistoryWindow): Track {
  if (w === 'all') return t
  const cut = t.to - (w === '7d' ? 7 : 30) * 86_400
  const i = Math.max(0, t.points.findIndex((p) => p.ts >= cut))
  return {
    ...t,
    points: t.points.slice(i),
    legs: t.legs.map((l) => ({ ...l, aprs: l.aprs.slice(i), rates: l.rates.slice(i) })),
    from: t.points[i].ts,
  }
}

/**
 * A headline dollar figure at two significant figures (chart-design; the prereg's headline
 * rule), with a true minus: "$3,200", "−$460".
 */
export function usd2(x: number): string {
  const sign = x < 0 ? '−' : ''
  const a = Math.abs(x)
  if (a === 0) return '$0'
  const e = Math.floor(Math.log10(a)) - 1
  const r = e >= 0 ? Math.round(a / 10 ** e) * 10 ** e : Number(a.toPrecision(2))
  return `${sign}$${new Intl.NumberFormat('en-US', { maximumFractionDigits: e >= 0 ? 0 : -e }).format(r)}`
}

/** "4.19%" from 0.0419. */
export const pct2 = (apr: number): string => `${(apr * 100).toFixed(2)}%`

/** "16 Oct" in UTC. */
export function dayLabel(ts: number): string {
  const d = new Date(ts * 1000)
  return `${d.getUTCDate()} ${d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })}`
}

// ------------------------------------------------------------------ the yield spread

/** The position's net value at the capture read: Σ collateral N − Σ debt N. */
export const netValue = (t: Track): number =>
  t.legs.reduce((a, l) => a + (l.side === 'reward' ? l.sizeUsd : -l.sizeUsd), 0)

/** The spread as a fraction of net value (null when the net value is not positive). */
export function spreadPct(spread: number, t: Track): number | null {
  const nv = netValue(t)
  return nv > 0 ? spread / nv : null
}

/** "+1.24%" / "−3.81%" with a true minus. */
export const signedPct = (x: number): string =>
  `${x < 0 ? '−' : x > 0 ? '+' : ''}${Math.abs(x * 100).toFixed(2)}%`

/** "+$1,200" / "−$1,500": usd2 with an explicit sign for a spread. */
export const signedUsd = (x: number): string => (x > 0 ? `+${usd2(x)}` : usd2(x))

export interface IncentiveLeg {
  symbol: string
  side: 'supply' | 'borrow'
  sizeUsd: number
  campaigns: IncentiveCampaign[]
  /** Σ live campaign APRs on the leg, 0–1. */
  apr: number
  /** sizeUsd × apr: $/yr the incentives add (supply) or take off the interest (borrow). */
  usdPerYear: number
}

export interface SpreadNow {
  /** The base spread at the last observation, incentives excluded. */
  base: number
  /** The base spread plus every live incentive ‡; null when no source was read. */
  withIncentives: number | null
  /** Per-leg incentives, every leg the source was asked about. */
  legs: IncentiveLeg[]
  /** "Merkl · fetched 01:49 UTC" */
  stamp: string | null
}

/**
 * The yield spread now, without and with incentives ‡. Incentives are current-only: they
 * are added at the last observation alone, never over the history (Merkl has no APR
 * history). A leg the source has no live campaign for adds 0 and says so in `legs`.
 */
export function spreadNow(t: Track, fx: RateFixture): SpreadNow {
  const last = t.points[t.points.length - 1]
  const inc = fx.incentives
  if (!inc) return { base: last.spread, withIncentives: null, legs: [], stamp: null }
  const legs: IncentiveLeg[] = inc.legs.map((li) => {
    const side = li.side === 'supply' ? 'reward' : 'cost'
    const src = [...fx.position.collateral, ...fx.position.debt].find(
      (l) => l.address.toLowerCase() === li.address,
    )
    const leg = t.legs.find((l) => l.side === side && l.symbol === src?.symbol)
    if (!leg) throw new Error(`spreadNow: no ${li.side} leg for incentive ${li.address}`)
    const apr = li.campaigns.reduce((a, c) => a + c.apr, 0)
    return { symbol: leg.symbol, side: li.side, sizeUsd: leg.sizeUsd, campaigns: li.campaigns, apr, usdPerYear: leg.sizeUsd * apr }
  })
  // A supply incentive is income; a borrow incentive is interest the reader does not pay.
  const add = legs.reduce((a, l) => a + l.usdPerYear, 0)
  const at = new Date(inc.fetchedAt)
  const hh = String(at.getUTCHours()).padStart(2, '0')
  const mm = String(at.getUTCMinutes()).padStart(2, '0')
  return {
    base: last.spread,
    withIncentives: last.spread + add,
    legs,
    stamp: `${inc.source.split(' ')[0]} · fetched ${dayLabel(at.getTime() / 1000)} ${hh}:${mm} UTC`,
  }
}

// ------------------------------------------------------------------ incentive sources

/** The Merkl v4 opportunity fields the tracker reads. */
export interface MerklOpportunity {
  id: string
  type: string
  name: string
  status: string
  chainId: number
  apr: number
  description?: string
  earliestCampaignStart?: string | null
  latestCampaignEnd?: string | null
  explorerAddress?: string | null
  tokens: Array<{ address: string; symbol: string }>
  rewardsRecord?: { breakdowns?: Array<{ token?: { symbol?: string } }> } | null
}

/** Merkl's Aave V3 types per side (Aave V4 hub/spoke types are another market). */
export const MERKL_AAVE_TYPES = {
  supply: ['AAVE_SUPPLY', 'AAVE_NET_LENDING'],
  borrow: ['AAVE_BORROW', 'AAVE_NET_BORROWING'],
} as const

/**
 * A leg's live Merkl campaigns: Aave V3 opportunities of the leg's side whose tokens
 * include the leg's token, on its chain. Merkl reports APR in percent: it is divided by 100.
 */
export function merklCampaigns(
  ops: readonly MerklOpportunity[],
  leg: { address: string; side: 'supply' | 'borrow' },
  chainId = 1,
): IncentiveCampaign[] {
  const types: readonly string[] = MERKL_AAVE_TYPES[leg.side]
  const addr = leg.address.toLowerCase()
  return ops
    .filter(
      (o) =>
        o.chainId === chainId &&
        o.status === 'LIVE' &&
        types.includes(o.type) &&
        o.tokens.some((t) => t.address.toLowerCase() === addr),
    )
    .map((o) => ({
      id: o.id,
      name: o.name,
      apr: o.apr / 100,
      start: o.earliestCampaignStart ? Number(o.earliestCampaignStart) : null,
      end: o.latestCampaignEnd ? Number(o.latestCampaignEnd) : null,
      rewardToken: o.rewardsRecord?.breakdowns?.[0]?.token?.symbol ?? null,
      conditions: /requir|must|eligib/i.test(o.name + ' ' + (o.description ?? ''))
        ? (o.description ?? o.name).slice(0, 200)
        : null,
    }))
}

/** Morpho's API market rewards (`state.rewards`): APRs are fractions already. */
export interface MorphoReward {
  asset: { symbol: string; address: string }
  supplyApr: number | null
  borrowApr: number | null
}

export function morphoCampaigns(rewards: readonly MorphoReward[], side: 'supply' | 'borrow'): IncentiveCampaign[] {
  return rewards
    .map((r) => ({ r, apr: side === 'supply' ? r.supplyApr : r.borrowApr }))
    .filter((x): x is { r: MorphoReward; apr: number } => x.apr !== null && x.apr > 0)
    .map(({ r, apr }) => ({
      id: `morpho:${r.asset.address.toLowerCase()}`,
      name: `${r.asset.symbol} rewards`,
      apr,
      start: null,
      end: null,
      rewardToken: r.asset.symbol,
      conditions: null,
    }))
}
