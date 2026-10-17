// THE OPPORTUNITIES BODY — view model. Pure: the API responses (or their loading/error
// state), the reader's size and clock in; every string the body prints out. No React, so
// the unit tests run it in node.
//
// Three modules, each finding → evidence → action (membrane-board design/DESIGN_RULES.md
// §5b):
//   1. RATES   /api/net-apy (supply side, at the reader's size): venues rank on the total
//              supply APR, rewards included (owner, 2026-10-16). The highest is the
//              headline, with what it would earn in $; the next venues are the table; the
//              size presets re-solve both. An APR that includes rewards carries the ‡ mark
//              and opens its composition: the venue rate, each reward, and their dates.
//   2. EXITS   /api/venues/<v>/summary for the recorder's venues: the exit capacity each
//              held at its last reading, against the reader's size.
//   3. DEMAND  /api/strats: tracked carry capital and the wallet count.
// Honesty (§4): a rate is ink; green is only the $ the reader would earn; a projection
// at size carries the dagger; stale inputs are hatched, the headline is withheld and the
// age is shown; nothing is printed that no live source gave.

import type { NetApyListIncentive, NetApyListResponse, NetApyListRow, Serialized } from '@/lib/netApy/service'
import { venueByKey } from '@/lib/netApy/venues'
import { HOUR_MS } from '@/lib/regime/m0'
import type { VenueSummary } from '@/pages/api/venues/[venue]/summary'
import { formatAge, utcClock } from '@/components/Weather/weatherView'

export type NetApyList = Serialized<NetApyListResponse>
type Row = Serialized<NetApyListRow>
type Incentive = Serialized<NetApyListIncentive>

/** A query's state, as react-query reports it. */
export interface Load<T> {
  status: 'pending' | 'error' | 'success'
  data: T | undefined
}

/** The fields of GET /api/strats this body reads. */
export interface StratsDemand {
  count: number
  total_usd: number
  freshest_scan: string | null
}

/**
 * The venues the recorder reads (the enabled entries of tools/venue-recorder.config.json;
 * tests/unit/opportunitiesView.test.ts keeps the two in step). Each has a venue page.
 */
export const RECORDER_VENUES = ['sUSDe', 'aave-v3-usde', 'sUSDS', 'scrvUSD'] as const

/** The size presets, as on the venue page's "Net at your size" card. */
export const SIZES = [10_000, 100_000, 1_000_000, 10_000_000] as const
export const DEFAULT_SIZE = 100_000
/** Venues in the table under the headline venue (the headline is not repeated there). */
export const RATES_SHOWN = 3

/**
 * The recorder runs hourly (scripts/recorder-tick.sh), and the strats refresh and the
 * alarm checker run inside that same tick. A reading older than two ticks means the
 * recorder stopped: it is stale.
 */
export const RECORDER_MAX_AGE_MS = 2 * HOUR_MS
/**
 * /api/net-apy reads at the finalized block (13 to 15 minutes behind the chain head)
 * and reuses a read for 120 s. An anchor older than 30 minutes means the reads stopped.
 */
export const NET_APY_MAX_AGE_MS = 30 * 60_000
/**
 * The route reuses one Merkl pull for 15 minutes and never serves an older one, so a
 * pull past an hour (a cached response) is not used to rank: the rates rank on the venue
 * rate alone, and say so.
 */
export const MERKL_MAX_AGE_MS = 60 * 60_000

/** The mark on an APR that includes rewards (a dotted underline goes with it). */
export const REWARDS_MARK = '‡'

export const OPP_COPY = {
  ratesKicker: 'Runners-up',
  exitsKicker: 'Exits',
  demandKicker: 'Demand',
  venue: 'Venue',
  borrowApr: 'Borrow APR',
  exitAvailable: 'Exit available',
  how: 'How',
  age: 'Age',
  held: 'venue cash',
  pool: 'swap pool',
  openVenue: 'Open venue →',
  stress: 'Stress your size on Radar →',
  wallets: 'See the wallets →',
  ratesUnavailable: 'Venue rates unavailable',
  exitsUnavailable: 'Exit data unavailable',
  demandUnavailable: 'Tracked capital unavailable',
  notRead: 'not read',
  unavailable: 'unavailable',
  ratesCredit: 'After venue fees',
  exitsCredit: 'Swap pools are reserves, not quotes',
  /** The rates credit when Merkl did not answer: the rates rank on the venue rate. */
  rewardsUnavailable: 'rewards unavailable',
  /** The $ line's unit when the rate includes rewards. */
  yearWithRewards: 'a year† incl. rewards',
  /** The composition. */
  mixBase: 'Venue rate',
  mixTotal: 'Total',
  mixTimeline: 'Timeline',
  mixUnknown: 'Not published: renewal, APR history',
  startUnknown: 'start not published',
} as const

// ---------------------------------------------------------------------------------
// FORMATS. Rounded toward risk: what you would earn rounds down, what you would pay
// rounds up, a capacity rounds down.
// ---------------------------------------------------------------------------------

const floorTo = (v: number, dp: number) => Math.floor(v * 10 ** dp + 1e-9) / 10 ** dp
const ceilTo = (v: number, dp: number) => Math.ceil(v * 10 ** dp - 1e-9) / 10 ** dp

/** "$100k", "$1M". */
export const sizeLabel = (n: number): string =>
  n >= 1e6 ? `$${floorTo(n / 1e6, 1)}M` : `$${floorTo(n / 1e3, 1)}k`

/** A supply rate: "4.36%", rounded down. */
export const supplyPct = (v: number): string => `${floorTo(v * 100, 2).toFixed(2)}%`
/** A borrow rate: "4.89%", rounded up. */
export const borrowPct = (v: number): string => `${ceilTo(v * 100, 2).toFixed(2)}%`

/** A capacity or a total, rounded down: "$4.39B", "$502.8M", "$950k", "$420". */
export function usdShort(n: number): string {
  if (n >= 1e9) return `$${floorTo(n / 1e9, 2).toFixed(2)}B`
  if (n >= 1e6) return `$${floorTo(n / 1e6, 1).toFixed(1)}M`
  if (n >= 1e3) return `$${Math.floor(n / 1e3)}k`
  return `$${Math.floor(Math.max(0, n))}`
}

/** Whole dollars with commas, rounded down: "$4,364". */
export const usdWhole = (n: number): string =>
  `$${Math.floor(Math.max(0, n)).toLocaleString('en-US')}`

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** "18 Oct" (UTC) from unix seconds. */
const utcDay = (s: number) => {
  const d = new Date(s * 1000)
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
}

/** The recorder venue's display name: the rate registry's label where it has one
 *  ("Aave v3 USDe"), else the recorder's own name. */
export const venueLabel = (venue: string, recorderLabel?: string): string =>
  venueByKey(venue)?.label ?? recorderLabel ?? venue

const hasVenuePage = (key: string): boolean =>
  (RECORDER_VENUES as readonly string[]).includes(key)
export const venueHref = (chain: string, key: string): string => `/${chain}/venue/${key}`

// ---------------------------------------------------------------------------------
// 1. RATES
// ---------------------------------------------------------------------------------

export type ModuleState = 'loading' | 'ready' | 'stale' | 'error' | 'empty'

/** One reward inside an APR. */
export interface MixPart {
  /** The reward token ("aEthUSDS"), or "Rewards" when Merkl names none. */
  token: string
  /** Where the figure comes from: "Merkl". */
  source: string
  /** At the size, rounded down: "3.31%". */
  apr: string
  /** How size moves it: "3.37% reported, diluted by your $100k". */
  note: string | null
}

/** One reward's dates: what the source publishes, and a label for what it does not. */
export interface MixTimeline {
  token: string
  /** "8 Oct", or "start not published". */
  start: string
  /** "15 Oct". */
  end: string
  /** The share of the campaign gone by now, 0 to 1; null without a start date. */
  elapsed: number | null
  /** "33h left". */
  left: string
}

/** The composition of an APR that includes rewards: venue rate + each reward = total. */
export interface AprMix {
  /** "Aave v3 USDS · APR at $100k". */
  title: string
  base: string
  parts: MixPart[]
  total: string
  timeline: MixTimeline[]
  /** What the source does not publish. */
  unknown: string
  /** "Rounded down · venue rate at block 26,187,572 · Merkl, fetched 14:05 UTC, …". */
  credit: string
  /** The trigger's accessible name: the composition in one line. */
  spoken: string
}

export interface LeadView {
  state: ModuleState
  hatched: boolean
  /** Replaces the headline when it is withheld (stale), unavailable or empty. */
  withheld: string | null
  /** "Morpho cbBTC/USDC 86% pays" + "4.36%" + "APR†". */
  headline: { lead: string; figure: string; tail: string } | null
  /** Set when the headline figure includes rewards: its ‡ mark and composition. */
  mix: AprMix | null
  /** What the size would earn in a year at that same total rate: "$4,364" + "a year†"
   *  (or "a year† incl. rewards"). The size is the lever's selected preset, right under
   *  it, so it is not printed twice. */
  hero: { figure: string; unit: string } | null
  /** "‡ ends 15 Oct", the first reward to end, beside the $ from 768px up (phones keep
   *  the first screen under 60 words; the composition carries the date there). */
  ends: string | null
  /** "Highest of 13 · block 26,187,572 · 15m ago". */
  credit: string | null
  /** The headline venue's page, where one exists. */
  href: string | null
}

export interface RateRow {
  key: string
  label: string
  /** The total supply APR at size, the one the ranking uses: "3.51%". */
  apr: string
  /** Set when that APR includes rewards: the ‡ mark and its composition. */
  mix: AprMix | null
  /** "‡ ends 15 Oct" (the first reward to end), under the APR from 768px up. */
  ends: string | null
  borrow: string
  href: string | null
}

export interface RatesView {
  state: ModuleState
  hatched: boolean
  /** The column head over the rates: "APR at $100k†". */
  aprHead: string
  /** The runners-up: ranks 2 to 1 + RATES_SHOWN. */
  rows: RateRow[]
  /** "2 venues revert at $10M (over the supply cap)". */
  excluded: string | null
  /** "After venue fees · ‡ Merkl, fetched 14:05 UTC": what ‡ marks, and when it was read. */
  credit: string
}

/**
 * The venue supply APR at size, from the incentive-free net. With no Membrane share in
 * the query, lib/netApy/breakdown.ts membraneSplit returns the gain itself, so this IS
 * the venue's own supply APR at size (after its reserve or vault fee): what a direct
 * deposit earns. Its 'upper' bound refers to a Membrane vault's unpriced share, which
 * these venue links do not involve.
 */
const venueApr = (r: Row): number | null => r.netIncentiveFree.apr

/**
 * The total supply APR a ranking uses: the venue rate plus the rewards a plain deposit
 * qualifies for (Merkl-reported, at the size), when the rewards are usable.
 */
export const totalApr = (r: Row, rewards: boolean): number | null =>
  rewards && r.net.withIncentives ? r.net.apr : venueApr(r)

/** Whether this response's rewards can rank, and the credit that says which. Unusable
 *  rewards leave the venue rate alone to rank, with no ‡ anywhere. */
export function rewardsUsable(list: NetApyList, nowMs: number): { ok: boolean; line: string } {
  const s = list.incentivesStatus
  if (!s.ok || s.fetchedAt === null) return { ok: false, line: OPP_COPY.rewardsUnavailable }
  const at = s.fetchedAt * 1000
  if (nowMs - at > MERKL_MAX_AGE_MS) {
    return { ok: false, line: `rewards withheld, read ${formatAge(nowMs - at)} ago` }
  }
  return { ok: true, line: `${REWARDS_MARK} Merkl, fetched ${utcClock(at, nowMs)}` }
}

export function rankRates(list: NetApyList, rewards: boolean): { ranked: Row[]; reverting: Row[] } {
  const reverting = list.venues.filter((r) => r.reverts !== null)
  const ranked = list.venues
    .filter((r) => r.reverts === null && totalApr(r, rewards) !== null)
    .sort((a, b) => (totalApr(b, rewards) as number) - (totalApr(a, rewards) as number))
  return { ranked, reverting }
}

export const anchorMs = (list: NetApyList): number => Number(list.anchor.blockTimestamp) * 1000

const blockLabel = (list: NetApyList) => `block ${Number(list.anchor.blockNumber).toLocaleString('en-US')}`

const SOURCE_NAME: Record<string, string> = { merkl: 'Merkl' }

/** How the reader's size moves a reward (lib/netApy/incentives.ts Dilution). */
function dilutionNote(c: Incentive, sizeUsd: number): string | null {
  switch (c.dilution) {
    case 'fixed-budget':
      return supplyPct(c.aprReported) === supplyPct(c.aprAtSize)
        ? null
        : `${supplyPct(c.aprReported)} reported, diluted by your ${sizeLabel(sizeUsd)}`
    case 'rate-fixed':
      return 'set rate; the budget can run out early'
    case 'rate-capped':
      return 'a ceiling; can fall as deposits grow'
    case 'rate-targeted':
      return 'tops the venue rate up to a target'
    default:
      return null
  }
}

/** "‡ ends 15 Oct": the first reward to end. */
function endsLabel(r: Row): string | null {
  const ends = (r.incentives ?? []).map((c) => c.endTs)
  const first = ends.length ? Math.min(...ends) : r.firstIncentiveEndTs
  return first ? `${REWARDS_MARK} ends ${utcDay(first)}` : null
}

/**
 * The composition of a venue's APR when it includes rewards; null when it does not
 * (a base-only APR stays plain). Every figure is from the response: the venue rate, each
 * campaign at the size, the dates Merkl publishes. Nothing Merkl does not publish is
 * drawn: there is no APR history and no renewal notice, so `unknown` says so.
 */
export function aprMix(r: Row, list: NetApyList, nowMs: number): AprMix | null {
  const total = r.net.apr
  const base = venueApr(r)
  if (!r.net.withIncentives || total === null || base === null) return null
  const campaigns = r.incentives ?? []
  const parts: MixPart[] = campaigns.length
    ? campaigns.map((c) => ({
        token: c.rewardSymbol ?? 'Rewards',
        source: SOURCE_NAME[c.source] ?? c.source,
        apr: supplyPct(c.aprAtSize),
        note: dilutionNote(c, list.sizeUsd),
      }))
    : // A response from before the route listed campaigns: one line, the difference.
      [{ token: 'Rewards', source: 'Merkl', apr: supplyPct(Math.max(0, total - base)), note: null }]
  const timeline: MixTimeline[] = campaigns.length
    ? campaigns.map((c) => {
        const startMs = Number.isFinite(c.startTs) && c.startTs > 0 ? c.startTs * 1000 : null
        const endMs = c.endTs * 1000
        return {
          token: c.rewardSymbol ?? 'Rewards',
          start: startMs === null ? OPP_COPY.startUnknown : utcDay(c.startTs),
          end: utcDay(c.endTs),
          elapsed:
            startMs !== null && endMs > startMs
              ? Math.min(1, Math.max(0, (nowMs - startMs) / (endMs - startMs)))
              : null,
          left: `${formatAge(Math.max(0, endMs - nowMs))} left`,
        }
      })
    : r.firstIncentiveEndTs
      ? [
          {
            token: 'Rewards',
            start: OPP_COPY.startUnknown,
            end: utcDay(r.firstIncentiveEndTs),
            elapsed: null,
            left: `${formatAge(Math.max(0, r.firstIncentiveEndTs * 1000 - nowMs))} left`,
          },
        ]
      : []
  const fetched = list.incentivesStatus.fetchedAt
  const merkl = fetched === null ? 'Merkl' : `Merkl, fetched ${utcClock(fetched * 1000, nowMs)}`
  const t = supplyPct(total)
  const b = supplyPct(base)
  return {
    title: `${r.label} · APR at ${sizeLabel(list.sizeUsd)}`,
    base: b,
    parts,
    total: t,
    timeline,
    unknown: OPP_COPY.mixUnknown,
    credit: `Rounded down · venue rate at ${blockLabel(list)} · ${merkl}, not verified on-chain`,
    spoken: `${t} APR including rewards: ${OPP_COPY.mixBase.toLowerCase()} ${b}, ${parts.map((p) => `${p.token} ${p.apr}`).join(', ')}`,
  }
}

/** The response for the size on the lever, or undefined while that size loads: a
 *  previous size's rows are never shown under a new size. */
const forSize = (netApy: Load<NetApyList>, sizeUsd: number): NetApyList | undefined =>
  netApy.data && netApy.data.sizeUsd === sizeUsd ? netApy.data : undefined

export function leadView(input: {
  netApy: Load<NetApyList>
  /** The size on the lever. */
  sizeUsd: number
  chain: string
  nowMs: number
}): LeadView {
  const { netApy, chain, nowMs } = input
  const base: LeadView = {
    state: 'loading',
    hatched: false,
    withheld: null,
    headline: null,
    mix: null,
    hero: null,
    ends: null,
    credit: null,
    href: null,
  }
  const list = forSize(netApy, input.sizeUsd)
  if (!list) {
    if (netApy.status !== 'error') return base
    return { ...base, state: 'error', hatched: true, withheld: OPP_COPY.ratesUnavailable }
  }
  const age = formatAge(nowMs - anchorMs(list))
  const where = `${blockLabel(list)} · ${age} ago`
  if (nowMs - anchorMs(list) > NET_APY_MAX_AGE_MS) {
    return { ...base, state: 'stale', hatched: true, withheld: `Rates withheld · read ${age} ago`, credit: blockLabel(list) }
  }
  const rewards = rewardsUsable(list, nowMs)
  const { ranked } = rankRates(list, rewards.ok)
  const size = sizeLabel(list.sizeUsd)
  const top = ranked[0]
  if (!top) {
    return { ...base, state: 'empty', withheld: `No venue takes ${size} now.`, credit: where }
  }
  const apr = totalApr(top, rewards.ok) as number
  const mix = rewards.ok ? aprMix(top, list, nowMs) : null
  return {
    ...base,
    state: 'ready',
    headline: { lead: `${top.label} pays`, figure: supplyPct(apr), tail: 'APR†' },
    mix,
    // The same total the ranking used, so the $ and the headline never disagree.
    hero: { figure: usdWhole(apr * list.sizeUsd), unit: mix ? OPP_COPY.yearWithRewards : 'a year†' },
    ends: mix ? endsLabel(top) : null,
    credit: `${ranked.length === 1 ? 'Only venue read' : `Highest of ${ranked.length}`} · ${where}`,
    href: hasVenuePage(top.venueKey) ? venueHref(chain, top.venueKey) : null,
  }
}

export function ratesView(input: {
  netApy: Load<NetApyList>
  chain: string
  nowMs: number
  /** The size on the lever. */
  sizeUsd: number
}): RatesView {
  const { netApy, chain, nowMs } = input
  const list = forSize(netApy, input.sizeUsd)
  const aprHead = `APR at ${sizeLabel(input.sizeUsd)}†`
  if (!list) {
    return {
      state: netApy.status === 'error' ? 'error' : 'loading',
      hatched: netApy.status === 'error',
      aprHead,
      rows: [],
      excluded: null,
      credit: OPP_COPY.ratesCredit,
    }
  }
  const stale = nowMs - anchorMs(list) > NET_APY_MAX_AGE_MS
  const rewards = rewardsUsable(list, nowMs)
  const { ranked, reverting } = rankRates(list, rewards.ok)
  const row = (r: Row): RateRow => {
    const mix = rewards.ok ? aprMix(r, list, nowMs) : null
    return {
      key: r.venueKey,
      label: r.label,
      apr: supplyPct(totalApr(r, rewards.ok) as number),
      mix,
      ends: mix ? endsLabel(r) : null,
      borrow: borrowPct(r.borrowAprNow),
      href: hasVenuePage(r.venueKey) ? venueHref(chain, r.venueKey) : null,
    }
  }
  const rows = ranked.slice(1, 1 + RATES_SHOWN).map(row)
  const why = Array.from(new Set(reverting.map((r) => r.reverts)))
  const excluded = reverting.length
    ? `${reverting.length} ${reverting.length === 1 ? 'venue reverts' : 'venues revert'} at ${sizeLabel(list.sizeUsd)} (${why.join('; ')})`
    : null
  return {
    state: stale ? 'stale' : ranked.length <= 1 ? 'empty' : 'ready',
    hatched: stale,
    aprHead,
    rows,
    excluded,
    credit: `${OPP_COPY.ratesCredit} · ${rewards.line}`,
  }
}

// ---------------------------------------------------------------------------------
// 2. EXITS
// ---------------------------------------------------------------------------------

export interface ExitRow {
  venue: string
  label: string
  state: 'loading' | 'error' | 'ready'
  /** "$502.8M"; null when the reading has no capacity figure. */
  figure: string | null
  /** "venue cash" (held by the venue) or "swap pool" (its exit pool's reserve). */
  how: string | null
  /** "7d"; null until loaded. */
  age: string | null
  stale: boolean
  href: string
}

export interface ExitsView {
  state: 'loading' | 'ready' | 'stale' | 'error'
  hatched: boolean
  /** "All 4 exits hold over $100k." */
  headline: string | null
  /** "Thinnest: scrvUSD, $21.6M." */
  deck: string | null
  withheld: string | null
  rows: ExitRow[]
}

/** Exit capacity at the last reading: cash the venue holds where it reads one (the venue
 *  page's "instant liquidity"), else its exit pool's swap-into reserve ("instant-exit
 *  depth"). The same choice as components/Venue/VenuePage.tsx. */
export function exitCapacity(s: VenueSummary): { usd: number; how: 'held' | 'pool' } | null {
  const o = s.observed
  if (!o) return null
  if (o.instantUsd !== null && o.instantUsd !== undefined) return { usd: o.instantUsd, how: 'held' }
  if (o.params.depthUsd !== null && o.params.depthUsd !== undefined) return { usd: o.params.depthUsd, how: 'pool' }
  return null
}

export function exitsView(input: {
  summaries: { venue: string; load: Load<VenueSummary> }[]
  sizeUsd: number
  chain: string
  nowMs: number
}): ExitsView {
  const { summaries, sizeUsd, chain, nowMs } = input
  const rows: ExitRow[] = summaries.map(({ venue, load }) => {
    const s = load.data
    const href = venueHref(chain, venue)
    if (!s) {
      return {
        venue,
        label: venueLabel(venue),
        state: load.status === 'pending' ? 'loading' : 'error',
        figure: null,
        how: null,
        age: null,
        stale: false,
        href,
      }
    }
    const cap = exitCapacity(s)
    const at = s.observed ? Date.parse(s.observed.observedAt) : null
    return {
      venue,
      label: venueLabel(venue, s.label),
      state: 'ready',
      figure: cap ? usdShort(cap.usd) : null,
      how: cap ? OPP_COPY[cap.how] : null,
      age: at === null ? null : formatAge(nowMs - at),
      // No reading at all is as old as it gets.
      stale: at === null || nowMs - at > RECORDER_MAX_AGE_MS,
      href,
    }
  })

  const base = { headline: null, deck: null, withheld: null, rows }
  if (rows.some((r) => r.state === 'loading')) return { ...base, state: 'loading', hatched: false }
  const ready = rows.filter((r) => r.state === 'ready')
  if (ready.length === 0) {
    return { ...base, state: 'error', hatched: true, withheld: OPP_COPY.exitsUnavailable }
  }
  const stale = ready.filter((r) => r.stale)
  if (stale.length) {
    const oldest = Math.max(
      ...summaries.map(({ load }) =>
        load.data?.observed ? nowMs - Date.parse(load.data.observed.observedAt) : 0,
      ),
    )
    return {
      ...base,
      state: 'stale',
      hatched: true,
      withheld: oldest > 0 ? `Withheld · exit data ${formatAge(oldest)} old` : 'Withheld · no exit reading',
    }
  }
  const missing = rows.filter((r) => r.state === 'error')
  if (missing.length) {
    return {
      ...base,
      state: 'error',
      hatched: true,
      withheld: `Withheld · ${missing.map((r) => r.label).join(', ')} unavailable`,
    }
  }

  const caps = summaries
    .map(({ venue, load }) => ({ venue, cap: load.data ? exitCapacity(load.data) : null }))
    .filter((x): x is { venue: string; cap: { usd: number; how: 'held' | 'pool' } } => x.cap !== null)
  if (caps.length === 0) {
    return { ...base, state: 'ready', hatched: false, withheld: 'No exit capacity read' }
  }
  const size = sizeLabel(sizeUsd)
  const under = caps.filter((c) => c.cap.usd < sizeUsd).length
  const thinnest = caps.reduce((a, b) => (b.cap.usd < a.cap.usd ? b : a))
  const thinLabel = rows.find((r) => r.venue === thinnest.venue)?.label ?? thinnest.venue
  return {
    ...base,
    state: 'ready',
    hatched: false,
    headline:
      under === 0
        ? `All ${caps.length} exits hold over ${size}.`
        : `${under} of ${caps.length} exits hold under ${size}.`,
    deck: `Thinnest: ${thinLabel}, ${usdShort(thinnest.cap.usd)}.`,
  }
}

// ---------------------------------------------------------------------------------
// 3. DEMAND
// ---------------------------------------------------------------------------------

export interface DemandView {
  state: 'loading' | 'ready' | 'stale' | 'error'
  hatched: boolean
  /** "$1.71B tracked in 49 carry wallets." */
  line: string | null
  withheld: string | null
  /** "scanned 14m ago". */
  age: string | null
}

export function demandView(input: { strats: Load<StratsDemand>; nowMs: number }): DemandView {
  const { strats, nowMs } = input
  const base: DemandView = { state: 'loading', hatched: false, line: null, withheld: null, age: null }
  const d = strats.data
  if (!d) {
    if (strats.status === 'pending') return base
    return { ...base, state: 'error', hatched: true, withheld: OPP_COPY.demandUnavailable }
  }
  if (d.count === 0) return { ...base, state: 'ready', line: 'No carry wallet is tracked yet.' }
  const at = d.freshest_scan ? Date.parse(d.freshest_scan) : null
  if (at === null) {
    return { ...base, state: 'stale', hatched: true, withheld: 'Withheld · not scanned yet' }
  }
  const age = formatAge(nowMs - at)
  if (nowMs - at > RECORDER_MAX_AGE_MS) {
    // The withheld line carries the age; a credit would say it twice.
    return { ...base, state: 'stale', hatched: true, withheld: `Withheld · last scan ${age} old` }
  }
  return {
    ...base,
    state: 'ready',
    line: `${usdShort(d.total_usd)} tracked in ${d.count} carry wallet${d.count === 1 ? '' : 's'}.`,
    age: `scanned ${age} ago`,
  }
}
