/**
 * venueStressAnalogs — MEASURED venue exit-capacity analogs for the stress engine. It turns
 * the venue stress history (public/data/venue-stress/history.json, built by
 * scripts/position-sim/build-venue-stress-history.mjs) and its stress windows
 * (summary.json `episodes`) into what a Membrane RECALL would have faced at real venues
 * during real stress, 2023-10 → 2026-10. ENGINE ONLY: numbers and ids, no I/O, no clock.
 *
 * Owner instruction 2026-10-06: "the venue-capacity assumptions should directly analogize
 * existing protocols (assuming typical Aave capacity during stress over the last 3 years)".
 * It replaced the arbitrary EXIT_CAPACITY_PRESETS multipliers (stressGrid.ts: ×1 / ×0.5 /
 * ×0.1 / ×0) with per-venue presets that each NAME the real window they come from: the
 * engine reads them as data from exitCapacityAnalogs.ts (`exitCapacityAnalogRows`).
 * Descriptive sampled history (MEASURED_DESCRIPTIVE_LABEL), not a forecast.
 *
 * ---------------------------------------------------------------------------
 * THE QUANTITY
 * ---------------------------------------------------------------------------
 *  f(t) = cash(t) / supply(t)  — the WITHDRAWABLE FRACTION (`withdrawableFraction`).
 *    cash   = what the venue can pay out now (Aave/Spark: underlying.balanceOf(aToken);
 *             MetaMorpho: the vault's PRO-RATA share of each withdraw-queue market's idle
 *             cash, Σ vault assets × idle / market supply — venueStressRules.metaMorphoCash;
 *             history.json `liquid` keeps the first-in-line walk, Σ min(vault assets, idle)).
 *    supply = every depositor's claim (aToken.totalSupply(); MetaMorpho totalAssets()).
 *  PRO-RATA RACE ASSUMPTION: in stress every depositor tries to exit at once, so one
 *  depositor's expected share of the cash is its share of the supply: a deposit of D gets
 *  f × D. The vault is held to the same race one level down (every supplier of each Morpho
 *  market exits at once), so its f is like-for-like with Aave's and Spark's (review
 *  2026-10-07: the first-in-line walk had read Steakhouse's typical f at 21.83%). That is
 *  (a) SIZE-INDEPENDENT — one number per venue per moment, which is what the
 *  engine's `exitCapacityMult` (a multiple of the deployed amount) takes — and (b)
 *  CONSERVATIVE against the first-in-line case: f × D = cash × D / supply ≤ cash for any
 *  D ≤ supply. It is NOT a worst case: a recall that loses the race entirely gets nothing,
 *  which is the 'frozen ×0' bound below.
 *  ABSOLUTE ALTERNATIVE (size-aware): cash(t) in USD. A deposit of D that is first in line
 *  gets min(D, cashUsd) — an UPPER bound per moment (`analogExitCapacityUsd`
 *  'first-in-line'). Stablecoins are held at $1 (VENUE_STABLE_SYMBOLS: a depeg would
 *  overstate it); any other token needs `priceUsd`, else the USD figure is null (unknown,
 *  never 0).
 *  A PAUSED reserve (flags bit2) blocks withdrawals: f = 0 and cash = 0 whatever the
 *  balance. FROZEN (bit1) still allows withdrawals and changes nothing. bit0 (active) is not
 *  read: MetaMorpho rows carry flags = 0.
 *  UNKNOWN IS UNKNOWN: a reading with no cash or supply never enters a minimum, never counts
 *  as locked, and breaks a lock run.
 *
 * ---------------------------------------------------------------------------
 * THE WINDOWS (`stressWindowsFromEpisodes`, `venueWindows`)
 * ---------------------------------------------------------------------------
 *  Each summary episode becomes one window with ONE onset — the moment a recall plausibly
 *  fires:
 *    eth-drop  `detail.firstTrigger`: the first hour ETH's low sat ≥ 10% under the prior
 *              24 h max close — when an ETH-collateral position breaches.
 *    util      `detail.firstAt`: the first reading at util ≥ the venue's stress level — when
 *              that venue itself enters stress.
 *    named     the earliest eth-drop / util onset (any venue) inside [from, to] — the event's
 *              market onset; a named window with none inside falls back to its `from`
 *              (onsetBasis 'named-window-start': the window bounds are an assumption).
 *  A venue the summary has no util episodes for (the reused Codex USDe grid) gets them from
 *  `utilWindowsFromSeries` — the builder's own rule, ONE implementation
 *  (venueStressRules.utilClusters: util ≥ the stress level on a material supply, a one-hour
 *  TRANSIENT the next hourly reading clears dropped, clustered while ≤ 72 h apart, onset =
 *  the first such reading), which reproduces every summary util episode exactly on
 *  history.json (tests/unit/venueStressAnalogs.test.ts). Transients are why the Aave USDC
 *  00:00 UTC drains (summary.json `blips`, `transients`) are not stress episodes.
 *  A venue's windows are every MARKET window (named, eth-drop) plus ITS OWN util windows.
 *  Another venue's util window is not stress for this one (Spark DAI at ≥ 99% is its normal
 *  operating point, not a market event).
 *
 * ---------------------------------------------------------------------------
 * PER WINDOW (`windowMetrics`), from onset t0 (readings as-of: a reading holds until the next)
 * ---------------------------------------------------------------------------
 *    fOnset          f at t0 (the latest known reading at or before t0, ≤ 6 h old).
 *    minF.h8/h24/h72 lowest f over [t0, t0 + H], both ends included. 8 h is the Membrane
 *                    delay window: a breach at t0 arms the timer and the keeper's calls,
 *                    every one of which recalls first, run until t0 + 8 h — so min-f over
 *                    the first 8 h is the share EVERY call in the window could have taken.
 *    minFHeld.h*     the same with a 1 h retry: each reading counts as the best f in
 *                    [t, t + 1 h], so a dip that lasts ONE hourly reading (the Aave USDC
 *                    00:00 UTC drains, summary.json `blips`) does not set the minimum, and a
 *                    dip held for two readings does. A keeper can retry an hour later; this
 *                    is still a lower bound for a window it retries in.
 *    lockedHours72h  hours at f ≤ 1% ('locked') inside [t0, t0 + 72 h).
 *    lockH           the longest locked stretch a recall INSIDE THE 8 h WINDOW [t0, t0 + 8 h]
 *                    runs into: a stretch that starts by t0 + 8 h, measured from
 *                    max(stretch start, t0) to the first reading above 1% — to its END, even
 *                    past 8 h or 72 h. Censored at the data's end. A lock that starts after the
 *                    window is not one the recall faces (it is in lockedHours72h only); the
 *                    engine places lockH at the first breach, so it is early by at most 8 h
 *                    (review 2026-10-07: the longest stretch anywhere in 72 h had put Spark
 *                    DAI's 78 h lock, starting 20 h after onset, where its 9 h in-window lock
 *                    belonged).
 *    recover5H       hours from t0 until f ≥ 5% again, once it has been under 5% inside the
 *                    first 72 h (0 = never under 5% in 72 h). null = still under 5% when the
 *                    data ends (recoverLowerBoundH).
 *  A reading stands for at most 6 h (a gap tolerance). Resolution is the reading cadence:
 *  hourly everywhere on history.json (the baseline is hourly since 2026-10-07: a 6-hourly
 *  pass stepped over 2 h spikes), ~3 h on the reused USDe grid.
 *  A window is skipped as 'no_data' (no known reading ≤ 6 h before t0) or 'not_material'
 *  (supply at t0 under the venue's `minSize`, summary.json method.minSize).
 *
 * ---------------------------------------------------------------------------
 * EVENTS AND PRESETS (`venueStressAnalogs`)
 * ---------------------------------------------------------------------------
 *  EVENTS. One real event fires several triggers (Apr-2025 is a named window plus three
 *  ETH drops). A venue's windows whose onsets chain within 72 h of each other are ONE event,
 *  counted ONCE, at its WORST trigger moment (the ranking below). Its name is the named
 *  window's when it has one ('Aave USDC, Kelp Apr-2026'). Each event is one sample.
 *  RANKING (worst first, a total order): f8 under the basis ↑ — every f8 ≤ 1% ties as
 *  'locked', so hundredths of a percent never outrank a longer lock — then lockH ↓,
 *  lockedHours72h ↓, f72 under the basis ↑, onset ↑, id ↑.
 *  PRESETS per venue, each ONE real event (nearest-rank, lower: index ⌈p·n⌉ − 1):
 *    'typical-stress'  the median event by f8
 *    'bad-stress'      the 10th-percentile event
 *    'worst-observed'  the worst event
 *  Each preset carries that event's f8, lock, recovery, absolute cash, n and the venue's
 *  date range, so a preset is an analog of one real window, never a blend of several.
 *  BASIS: 'held' (default) or 'reading'. Both are reported per window. 'held' is the default
 *  because of the mechanics (stressGrid.ts header): inside an armed window every keeper call
 *  recalls first and a recall that brings the LTV back to the line COMMITS and clears the
 *  timer — so a recall is retried through the 8 h, and a dip that lasts one hourly reading
 *  (one supplier pulling every idle dollar at 00:00 UTC and re-supplying within the hour,
 *  summary.json `blips` and `transients`, 181 days on Aave USDC) does not cap what the window
 *  can take — nor, by the same rule, open a util window (venueStressRules TRANSIENTS). A dip
 *  held for two readings does. Both bases stay LOWER bounds: the cure only needs the BEST
 *  moment of the window, the stock model takes the worst. 'reading' is the literal
 *  single-reading minimum; on Aave USDC a 00:00 UTC drain sets it for three of the five worst
 *  events (its 'bad-stress', Dec-2024, is one).
 *  BOUNDS: 'frozen' f = 0 stays as the explicit THEORETICAL bound (a recall that loses the
 *  race, or a paused reserve). 'optimistic' f = 1 is kept only as a labelled UPPER bound —
 *  it is never a default (owner ruling 2026-10-04) and is not in
 *  VENUE_ANALOG_PRESET_ORDER.
 *
 *  NOT MODELLED: the stock refilling inside the window (the engine draws one stock); the
 *  recall's own size moving f; interest accrued since a MetaMorpho market's last update;
 *  sub-hour paths (a reading is an hourly snapshot).
 */

import { MEASURED_DESCRIPTIVE_LABEL } from './measuredCapacity'
import { utilClusters, withdrawableFraction } from './venueStressRules'
import {
  EXIT_CAPACITY_ANALOG_SOURCE,
  EXIT_CAPACITY_ANALOG_VENUES,
  type ExitCapacityAnalogLevel,
  type ExitCapacityAnalogRow,
} from './exitCapacityAnalogs'

// ---------------------------------------------------------------- constants

export const VENUE_ANALOG_CODE_VERSION = 'venue-stress-analogs/1'

/** f at or under this is 'locked'. */
export const VENUE_LOCK_F = 0.01
/** f back at or over this is 'recovered'. */
export const VENUE_RECOVER_F = 0.05
/** The horizons measured after each onset, hours. */
export const VENUE_ANALOG_HORIZONS_H = [8, 24, 72] as const
/** The presets rank on the min-f over this horizon: the Membrane 8 h delay window. */
export const VENUE_ANALOG_BASIS_HORIZON_H = 8
/** Windows whose onsets chain within this many hours are one event. */
export const VENUE_EVENT_MERGE_H = 72
/** A reading stands for at most this long (a gap tolerance; history.json is hourly). */
export const VENUE_READING_MAX_H = 6
/** The 'held' basis: the best reading within this long after each reading. */
export const VENUE_HELD_RETRY_H = 1
/** The default basis (module header, BASIS). */
export const VENUE_ANALOG_DEFAULT_BASIS = 'held' as const
/** The builder's default stress level (summary.json method.stressUtil). */
export const VENUE_DEFAULT_STRESS_UTIL = 0.95
/** Nearest-rank percentiles behind the presets. */
export const VENUE_ANALOG_PERCENTILES = { 'typical-stress': 0.5, 'bad-stress': 0.1 } as const

/** Tokens held at $1 for the absolute (USD) figure. */
export const VENUE_STABLE_SYMBOLS: readonly string[] = ['USDC', 'USDT', 'DAI', 'USDS', 'USDe']

/** Display names for the venues of history.json (and the reused Codex USDe grid). */
export const VENUE_STRESS_META: Readonly<Record<string, { symbol: string; name: string }>> = {
  'aave-core-usdc': { symbol: 'USDC', name: 'Aave USDC' },
  'aave-core-usdt': { symbol: 'USDT', name: 'Aave USDT' },
  'aave-core-weth': { symbol: 'WETH', name: 'Aave WETH' },
  'aave-core-usde': { symbol: 'USDe', name: 'Aave USDe' },
  'spark-dai': { symbol: 'DAI', name: 'Spark DAI' },
  'spark-usdc': { symbol: 'USDC', name: 'Spark USDC' },
  'spark-usds': { symbol: 'USDS', name: 'Spark USDS' },
  'spark-usdt': { symbol: 'USDT', name: 'Spark USDT' },
  'spark-weth': { symbol: 'WETH', name: 'Spark WETH' },
  'morpho-steakhouse-usdc': { symbol: 'USDC', name: 'Steakhouse USDC' },
}

/** Short names for the named windows of summary.json (method.triggers.named). */
export const NAMED_STRESS_SHORT: Readonly<Record<string, string>> = {
  'named-2024-08-05': 'Aug-2024 yen-carry unwind',
  'named-2024-12': 'Dec-2024 leverage peak',
  'named-2025-04': 'Apr-2025 tariff crash',
  'named-2025-10-10': 'Oct-2025 liquidation cascade',
  'named-2026-02': 'Feb-2026 ETH drawdown',
  'named-2026-04-kelp': 'Kelp Apr-2026',
  'named-2026-08-ptreusd': 'PT-reUSD Aug-2026',
}

const HOUR = 3600
const PAUSED_BIT = 4

// -------------------------------------------------------------------- input types

/** The columns history.json carries per venue (a subset). */
export interface VenueStressColumns {
  cash: readonly (number | null)[]
  supply: readonly (number | null)[]
  flags?: readonly (number | null)[]
}

/** history.json (the fields this module reads). */
export interface VenueStressHistoryFile {
  schema: string
  timeline: { t: readonly number[] }
  venues: Readonly<Record<string, VenueStressColumns>>
  /** Reused grids with their own timeline (the Codex Aave USDe 3 h grid). */
  reused?: Readonly<Record<string, VenueStressColumns & { t: readonly number[] }>>
}

/** One summary.json episode (the fields this module reads). */
export interface VenueStressEpisode {
  id: string
  /** 'named' | 'eth-drop' | 'util>=95' | 'util>=99' */
  trigger: string
  label: string
  venue?: string
  /** ISO, e.g. '2026-04-16T00:00Z'. */
  from: string
  to: string
  detail?: { firstTrigger?: string; firstAt?: string; worstDropPct?: number }
}

/** One venue's readings on its own timeline. */
export interface VenueSeries {
  venue: string
  symbol: string
  /** Display name, e.g. 'Aave USDC'. */
  name: string
  /** Reading times, unix seconds, strictly ascending. */
  t: readonly number[]
  cash: readonly (number | null)[]
  supply: readonly (number | null)[]
  flags?: readonly (number | null)[]
  /** Supply (token units) under which the venue is not material at an onset. */
  minSize?: number
}

export type StressTrigger = 'named' | 'eth-drop' | 'util'
export type OnsetBasis =
  | 'eth-first-trigger'
  | 'util-first-reading'
  | 'named-first-trigger'
  | 'named-window-start'

export interface StressWindow {
  id: string
  trigger: StressTrigger
  label: string
  shortLabel: string
  /** util: the venue that was stressed. Market windows (named, eth-drop): null. */
  venue: string | null
  onsetSec: number
  onsetBasis: OnsetBasis
  fromSec: number
  toSec: number
}

export type VenueAnalogBasis = 'reading' | 'held'

export interface VenueAnalogOptions {
  /** Which min-f ranks the events. Default 'held' (module header, BASIS). */
  basis?: VenueAnalogBasis
  /** USD per token for a non-stable symbol at a time (unix s). null = unknown. */
  priceUsd?: (symbol: string, tSec: number) => number | null
}

// -------------------------------------------------------------------- output types

export interface HorizonValues {
  h8: number
  h24: number
  h72: number
}

export interface HorizonUsd {
  h8: number | null
  h24: number | null
  h72: number | null
}

export interface WindowMetrics {
  onsetSec: number
  /** The reading f at the onset was taken from (≤ onset). */
  onsetReadingSec: number
  fOnset: number
  minF: HorizonValues
  minFHeld: HorizonValues
  cashUsdOnset: number | null
  minCashUsd: HorizonUsd
  minCashUsdHeld: HorizonUsd
  lockedHours72h: number
  lockH: number
  lockCensored: boolean
  recover5H: number | null
  /** recover5H null: f was still under 5% this many hours after the onset, at the data's end. */
  recoverLowerBoundH: number | null
  /** Known readings in [onset, onset + 8 h] (the as-of reading included). */
  readings8h: number
  /** Longest stretch, hours, with no known reading inside [as-of reading, onset + 8 h]. */
  maxGapH8h: number
  /** The 72 h horizon runs past the last reading. */
  horizonCensored: boolean
}

export type WindowSkipReason = 'no_data' | 'not_material'

export interface VenueWindowRow extends WindowMetrics {
  venue: string
  windowId: string
  trigger: StressTrigger
  label: string
  shortLabel: string
  onsetBasis: OnsetBasis
  onsetIso: string
}

export interface VenueStressEvent {
  venue: string
  /** 'Aave USDC, Kelp Apr-2026'. */
  name: string
  label: string
  shortLabel: string
  /** Every window of the event, onset order. */
  memberIds: string[]
  /** The event's first onset. */
  firstOnsetIso: string
  /** The member the event is counted at: its worst under the basis. */
  worst: VenueWindowRow
  /** Every evaluated member (skipped members are in the venue's `skipped`). */
  members: VenueWindowRow[]
}

export type VenueAnalogPresetId = 'typical-stress' | 'bad-stress' | 'worst-observed'

export const VENUE_ANALOG_MEASURED_IDS: readonly VenueAnalogPresetId[] = [
  'typical-stress',
  'bad-stress',
  'worst-observed',
]

export interface VenueAnalogPreset {
  id: VenueAnalogPresetId
  venue: string
  basis: VenueAnalogBasis
  /** Nearest-rank percentile (0.5, 0.1); null for 'worst-observed'. */
  percentile: number | null
  /** 1-based, worst first, of n. */
  rank: number
  n: number
  /** Withdrawable fraction: the source event's min f over the 8 h delay window, under the basis. */
  f: number
  /**
   * f ≤ 1%. Locked events tie on f and rank by lock length instead, so between two locked
   * presets f is not ordered (a 'worst-observed' 0.7% with a 78 h lock outranks a 0.0% with 12 h).
   */
  locked: boolean
  fOnset: number
  minF24h: number
  minF72h: number
  /** The longest locked (f ≤ 1%) stretch the recall runs into, hours. */
  lockH: number
  lockCensored: boolean
  lockedHours72h: number
  recover5H: number | null
  recoverLowerBoundH: number | null
  /** The source's 72 h horizon runs past the data's end: lock and recovery may be understated. */
  horizonCensored: boolean
  /** Absolute: the source event's min cash over the 8 h window, USD, under the basis. */
  cashUsd8h: number | null
  source: {
    name: string
    label: string
    windowId: string
    trigger: StressTrigger
    onsetIso: string
    memberIds: string[]
  }
  /** First and last event onset for the venue (the date range n covers). */
  range: { fromIso: string; toIso: string }
  /** One line of provenance, data for a picker. */
  provenance: string
}

export interface VenueAnalogRow {
  venue: string
  name: string
  n: number
  range: { fromIso: string; toIso: string } | null
  /** null when the venue has no event (n = 0). */
  presets: Record<VenueAnalogPresetId, VenueAnalogPreset> | null
  /** Worst first. */
  events: VenueStressEvent[]
  skipped: { windowId: string; reason: WindowSkipReason }[]
}

export type VenueAnalogBoundId = 'frozen' | 'optimistic'

export interface VenueAnalogBound {
  id: VenueAnalogBoundId
  f: number
  kind: 'theoretical-bound' | 'upper-bound'
  /** Never offered unless asked for. */
  isDefault: boolean
  provenance: string
}

export const VENUE_ANALOG_BOUNDS: Readonly<Record<VenueAnalogBoundId, VenueAnalogBound>> = {
  frozen: {
    id: 'frozen',
    f: 0,
    kind: 'theoretical-bound',
    isDefault: true,
    provenance:
      'Nothing comes back: a paused reserve, or a recall that loses the exit race. The theoretical lower bound.',
  },
  optimistic: {
    id: 'optimistic',
    f: 1,
    kind: 'upper-bound',
    isDefault: false,
    provenance:
      'Everything deployed comes back on demand. An upper bound only, never a default (owner ruling 2026-10-04); no stress window measured it.',
  },
}

export type VenueAnalogChoiceId = VenueAnalogPresetId | VenueAnalogBoundId

/** Default picker order, most to least available. 'optimistic' is offered only on request. */
export const VENUE_ANALOG_PRESET_ORDER: readonly VenueAnalogChoiceId[] = [
  'typical-stress',
  'bad-stress',
  'worst-observed',
  'frozen',
]

export interface VenueAnalogTable {
  version: string
  descriptiveLabel: string
  basis: VenueAnalogBasis
  rows: VenueAnalogRow[]
  bounds: Readonly<Record<VenueAnalogBoundId, VenueAnalogBound>>
}

// ------------------------------------------------------------------ helpers

function isoHour(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(0, 16) + 'Z'
}

function parseIso(s: string | undefined, what: string): number {
  const ms = s === undefined ? NaN : Date.parse(s)
  if (!Number.isFinite(ms)) throw new Error(`venueStressAnalogs: bad ${what} '${String(s)}'`)
  return Math.floor(ms / 1000)
}

/** Largest index with t[i] <= x, or -1. */
function asOfIndex(t: readonly number[], x: number): number {
  let lo = 0
  let hi = t.length - 1
  let at = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (t[mid] <= x) {
      at = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return at
}

function isPaused(flags: number | null | undefined): boolean {
  return flags != null && (flags & PAUSED_BIT) !== 0
}

/** f = cash / supply (venueStressRules.withdrawableFraction: paused 0, unknown null). */
export { withdrawableFraction }

function fAt(s: VenueSeries, i: number): number | null {
  return withdrawableFraction(s.cash[i], s.supply[i], s.flags?.[i])
}

function unitUsd(s: VenueSeries, tSec: number, opts: VenueAnalogOptions): number | null {
  if (VENUE_STABLE_SYMBOLS.includes(s.symbol)) return 1
  const p = opts.priceUsd?.(s.symbol, tSec)
  return p != null && Number.isFinite(p) && p > 0 ? p : null
}

function cashUsdAt(s: VenueSeries, i: number, opts: VenueAnalogOptions): number | null {
  if (fAt(s, i) === null) return null
  if (isPaused(s.flags?.[i])) return 0
  const unit = unitUsd(s, s.t[i], opts)
  const cash = s.cash[i]
  return unit === null || cash == null ? null : cash * unit
}

function validateSeries(s: VenueSeries): void {
  const n = s.t.length
  if (s.cash.length !== n || s.supply.length !== n || (s.flags && s.flags.length !== n)) {
    throw new Error(`venueStressAnalogs: ${s.venue} columns differ in length`)
  }
  for (let i = 1; i < n; i++) {
    if (!(s.t[i] > s.t[i - 1]))
      throw new Error(`venueStressAnalogs: ${s.venue} t not ascending at ${i}`)
  }
}

// ------------------------------------------------------------- input adapters

/**
 * Every venue of history.json as a series on the shared timeline, plus each reused grid on
 * its own. `minSize` is summary.json `method.minSize` (token units).
 */
export function venueSeriesFromHistory(
  file: VenueStressHistoryFile,
  opts: { minSize?: Readonly<Record<string, number>> } = {},
): VenueSeries[] {
  const meta = (venue: string) =>
    VENUE_STRESS_META[venue] ?? { symbol: venue.split('-').pop()!.toUpperCase(), name: venue }
  const out: VenueSeries[] = []
  const add = (venue: string, t: readonly number[], c: VenueStressColumns) => {
    const s: VenueSeries = {
      venue,
      ...meta(venue),
      t,
      cash: c.cash,
      supply: c.supply,
      ...(c.flags ? { flags: c.flags } : {}),
      ...(opts.minSize?.[venue] !== undefined ? { minSize: opts.minSize[venue] } : {}),
    }
    validateSeries(s)
    out.push(s)
  }
  for (const venue of Object.keys(file.venues).sort())
    add(venue, file.timeline.t, file.venues[venue])
  for (const venue of Object.keys(file.reused ?? {}).sort()) {
    const r = file.reused![venue]
    add(venue, r.t, r)
  }
  return out
}

/**
 * summary.json episodes → windows with one onset each, in (onset, id) order. `extraUtil`
 * (from `utilWindowsFromSeries`) joins the util windows before the named onsets are derived.
 */
export function stressWindowsFromEpisodes(
  episodes: readonly VenueStressEpisode[],
  extraUtil: readonly StressWindow[] = [],
): StressWindow[] {
  const triggered: StressWindow[] = []
  for (const w of extraUtil) {
    if (w.trigger !== 'util' || !w.venue)
      throw new Error(`venueStressAnalogs: extra window ${w.id} is not a util window`)
    triggered.push(w)
  }
  const named: VenueStressEpisode[] = []
  for (const e of episodes) {
    const fromSec = parseIso(e.from, `${e.id}.from`)
    const toSec = parseIso(e.to, `${e.id}.to`)
    if (e.trigger === 'named') {
      named.push(e)
    } else if (e.trigger === 'eth-drop') {
      const day = isoHour(parseIso(e.detail?.firstTrigger, `${e.id}.detail.firstTrigger`)).slice(
        0,
        10,
      )
      const drop = e.detail?.worstDropPct
      triggered.push({
        id: e.id,
        trigger: 'eth-drop',
        label: e.label,
        shortLabel: drop !== undefined ? `ETH ${drop}% ${day}` : `ETH drop ${day}`,
        venue: null,
        onsetSec: parseIso(e.detail?.firstTrigger, `${e.id}.detail.firstTrigger`),
        onsetBasis: 'eth-first-trigger',
        fromSec,
        toSec,
      })
    } else if (e.trigger.startsWith('util')) {
      if (!e.venue) throw new Error(`venueStressAnalogs: util episode ${e.id} has no venue`)
      const onsetSec = parseIso(e.detail?.firstAt, `${e.id}.detail.firstAt`)
      const level = e.trigger.slice('util'.length) // '>=95'
      triggered.push({
        id: e.id,
        trigger: 'util',
        label: e.label,
        shortLabel: `util ${level.replace('>=', '≥')}% ${isoHour(onsetSec).slice(0, 10)}`,
        venue: e.venue,
        onsetSec,
        onsetBasis: 'util-first-reading',
        fromSec,
        toSec,
      })
    } else {
      throw new Error(`venueStressAnalogs: unknown trigger '${e.trigger}' on ${e.id}`)
    }
  }
  const windows = [...triggered]
  for (const e of named) {
    const fromSec = parseIso(e.from, `${e.id}.from`)
    const toSec = parseIso(e.to, `${e.id}.to`)
    let first = Infinity
    for (const w of triggered)
      if (w.onsetSec >= fromSec && w.onsetSec <= toSec) first = Math.min(first, w.onsetSec)
    windows.push({
      id: e.id,
      trigger: 'named',
      label: e.label,
      shortLabel: NAMED_STRESS_SHORT[e.id] ?? e.label,
      venue: null,
      onsetSec: Number.isFinite(first) ? first : fromSec,
      onsetBasis: Number.isFinite(first) ? 'named-first-trigger' : 'named-window-start',
      fromSec,
      toSec,
    })
  }
  return windows.sort((a, b) => a.onsetSec - b.onsetSec || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * One venue's own util windows, by the builder's rule (venueStressRules.utilClusters, the
 * same code the builder runs): a reading is stressed when 1 − f ≥ `stressUtil` and its supply
 * is material (≥ minSize, when set); a TRANSIENT (one hourly reading the next one clears) is
 * dropped; stressed readings no more than 72 h apart are one window; onset = the first,
 * window = [first − 24 h, last + 24 h]. Ids match the builder's ('util-<venue>-<YYYY-MM-DDTHH>').
 */
export function utilWindowsFromSeries(
  s: VenueSeries,
  stressUtil: number = VENUE_DEFAULT_STRESS_UTIL,
): StressWindow[] {
  if (!(stressUtil > 0 && stressUtil <= 1))
    throw new Error(`venueStressAnalogs: stressUtil ${stressUtil} outside (0, 1]`)
  validateSeries(s)
  const { clusters } = utilClusters(s, stressUtil)
  const level = Math.round(stressUtil * 100)
  return clusters.map((c) => ({
    id: `util-${s.venue}-${isoHour(c.first).slice(0, 13)}`,
    trigger: 'util' as const,
    label: `${s.venue} utilization >= ${level}% (${c.n} readings, derived from the series)`,
    shortLabel: `util ≥${level}% ${isoHour(c.first).slice(0, 10)}`,
    venue: s.venue,
    onsetSec: c.first,
    onsetBasis: 'util-first-reading' as const,
    fromSec: c.first - 24 * HOUR,
    toSec: c.last + 24 * HOUR,
  }))
}

/** The windows that count for one venue: every market window plus its own util windows. */
export function venueWindows(venue: string, windows: readonly StressWindow[]): StressWindow[] {
  return windows.filter((w) => w.trigger !== 'util' || w.venue === venue)
}

// ------------------------------------------------------------- per window

/**
 * The capacity a recall made at `onsetSec` faced at one venue (module header, PER WINDOW).
 */
export function windowMetrics(
  s: VenueSeries,
  onsetSec: number,
  opts: VenueAnalogOptions = {},
): WindowMetrics | { skip: WindowSkipReason } {
  const t = s.t
  // the as-of reading: the latest KNOWN reading at or before the onset, ≤ 6 h old
  let k = asOfIndex(t, onsetSec)
  while (k >= 0 && fAt(s, k) === null) k--
  if (k < 0 || onsetSec - t[k] > VENUE_READING_MAX_H * HOUR) return { skip: 'no_data' }
  if (s.minSize !== undefined) {
    const supply = s.supply[k]
    if (supply == null || !(supply >= s.minSize)) return { skip: 'not_material' }
  }

  const maxH = VENUE_ANALOG_HORIZONS_H[VENUE_ANALOG_HORIZONS_H.length - 1]
  const end72 = onsetSec + maxH * HOUR
  const lastT = t[t.length - 1]

  // known readings in [as-of, onset + 72 h]
  const idx: number[] = []
  for (let i = k; i < t.length && t[i] <= end72; i++) if (fAt(s, i) !== null) idx.push(i)

  const held = (i: number, value: (j: number) => number | null): number | null => {
    let best: number | null = null
    for (let j = i; j < t.length && t[j] <= t[i] + VENUE_HELD_RETRY_H * HOUR; j++) {
      const v = value(j)
      if (v !== null && (best === null || v > best)) best = v
    }
    return best
  }
  const fOf = (i: number) => fAt(s, i)
  const cashOf = (i: number) => cashUsdAt(s, i, opts)

  const minOver = (h: number, v: (i: number) => number | null): number | null => {
    let m: number | null = null
    for (const i of idx) {
      if (t[i] > onsetSec + h * HOUR) break
      const x = v(i)
      if (x === null) return null // an unknown USD figure makes the minimum unknown
      if (m === null || x < m) m = x
    }
    return m
  }
  const fMin = (h: number) => minOver(h, fOf) as number
  const fHeldMin = (h: number) => minOver(h, (i) => held(i, fOf)) as number
  const cashMin = (h: number) => minOver(h, cashOf)
  const cashHeldMin = (h: number) => minOver(h, (i) => held(i, cashOf))

  // coverage of the 8 h window
  const end8 = onsetSec + VENUE_ANALOG_BASIS_HORIZON_H * HOUR
  const in8 = idx.filter((i) => t[i] <= end8)
  let maxGap = 0
  for (let j = 1; j < in8.length; j++) maxGap = Math.max(maxGap, t[in8[j]] - t[in8[j - 1]])
  maxGap = Math.max(maxGap, end8 - t[in8[in8.length - 1]])

  // locked hours inside [onset, onset + 72 h): a reading holds until the next reading, ≤ 6 h
  const readingEnd = (i: number) =>
    i + 1 < t.length ? Math.min(t[i + 1], t[i] + VENUE_READING_MAX_H * HOUR) : t[i]
  let lockedSec = 0
  for (let i = k; i < t.length && t[i] < end72; i++) {
    const f = fAt(s, i)
    if (f === null || f > VENUE_LOCK_F) continue
    const a = Math.max(t[i], onsetSec)
    const b = Math.min(readingEnd(i), end72)
    if (b > a) lockedSec += b - a
  }

  // the longest locked stretch a recall in the 8 h window [onset, onset + 8 h] runs into: one
  // that starts by the window's end (a stretch from the as-of reading k on overlaps the onset)
  let lockSec = 0
  let lockCensored = false
  for (let i = k; i < t.length && t[i] <= end8; ) {
    const f = fAt(s, i)
    if (f === null || f > VENUE_LOCK_F) {
      i++
      continue
    }
    const start = Math.max(t[i], onsetSec)
    let j = i
    while (
      j + 1 < t.length &&
      t[j + 1] - t[j] <= VENUE_READING_MAX_H * HOUR &&
      (fAt(s, j + 1) ?? Infinity) <= VENUE_LOCK_F
    ) {
      j++
    }
    const censored = j + 1 >= t.length
    const end = censored ? t[j] : readingEnd(j)
    if (end - start > lockSec || (end - start === lockSec && censored)) {
      lockSec = Math.max(lockSec, end - start)
      lockCensored = censored
    }
    i = j + 1
  }

  // recovery to f ≥ 5%, once under 5% inside the first 72 h
  let recover5H: number | null = 0
  let recoverLowerBoundH: number | null = null
  const dip = idx.find((i) => (fAt(s, i) as number) < VENUE_RECOVER_F)
  if (dip !== undefined) {
    recover5H = null
    for (let j = dip + 1; j < t.length; j++) {
      const f = fAt(s, j)
      if (f !== null && f >= VENUE_RECOVER_F) {
        recover5H = Math.max(0, t[j] - onsetSec) / HOUR
        break
      }
    }
    if (recover5H === null) recoverLowerBoundH = Math.max(0, lastT - onsetSec) / HOUR
  }

  return {
    onsetSec,
    onsetReadingSec: t[k],
    fOnset: fAt(s, k) as number,
    minF: { h8: fMin(8), h24: fMin(24), h72: fMin(72) },
    minFHeld: { h8: fHeldMin(8), h24: fHeldMin(24), h72: fHeldMin(72) },
    cashUsdOnset: cashOf(k),
    minCashUsd: { h8: cashMin(8), h24: cashMin(24), h72: cashMin(72) },
    minCashUsdHeld: { h8: cashHeldMin(8), h24: cashHeldMin(24), h72: cashHeldMin(72) },
    lockedHours72h: lockedSec / HOUR,
    lockH: lockSec / HOUR,
    lockCensored,
    recover5H,
    recoverLowerBoundH,
    readings8h: in8.length,
    maxGapH8h: maxGap / HOUR,
    horizonCensored: end72 > lastT,
  }
}

// ---------------------------------------------------------------- ranking

function basisF(r: WindowMetrics, basis: VenueAnalogBasis, h: keyof HorizonValues): number {
  return basis === 'held' ? r.minFHeld[h] : r.minF[h]
}

/** f8 as ranked: every locked value (≤ VENUE_LOCK_F) is one tie. */
function rankF8(r: WindowMetrics, basis: VenueAnalogBasis): number {
  const f = basisF(r, basis, 'h8')
  return f <= VENUE_LOCK_F ? 0 : f
}

/** Worst first; a total order (module header, RANKING). */
export function compareWorstFirst(
  a: VenueWindowRow,
  b: VenueWindowRow,
  basis: VenueAnalogBasis,
): number {
  return (
    rankF8(a, basis) - rankF8(b, basis) ||
    b.lockH - a.lockH ||
    b.lockedHours72h - a.lockedHours72h ||
    basisF(a, basis, 'h72') - basisF(b, basis, 'h72') ||
    a.onsetSec - b.onsetSec ||
    (a.windowId < b.windowId ? -1 : a.windowId > b.windowId ? 1 : 0)
  )
}

/** Nearest-rank, lower: the 0-based index of the p-th percentile among n sorted worst first. */
export function nearestRankIndex(p: number, n: number): number {
  if (!(n > 0)) throw new Error('venueStressAnalogs: nearestRankIndex of an empty set')
  if (!(p > 0 && p <= 1)) throw new Error(`venueStressAnalogs: percentile ${p} outside (0, 1]`)
  return Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1))
}

// ---------------------------------------------------------------- events

/** One venue's windows grouped into events, each counted at its worst member. Worst first. */
export function venueStressEvents(
  s: VenueSeries,
  windows: readonly StressWindow[],
  opts: VenueAnalogOptions = {},
): { events: VenueStressEvent[]; skipped: { windowId: string; reason: WindowSkipReason }[] } {
  const basis = opts.basis ?? VENUE_ANALOG_DEFAULT_BASIS
  const mine = venueWindows(s.venue, windows)
    .slice()
    .sort((a, b) => a.onsetSec - b.onsetSec || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  const groups: StressWindow[][] = []
  for (const w of mine) {
    const g = groups[groups.length - 1]
    if (g && w.onsetSec <= g[g.length - 1].onsetSec + VENUE_EVENT_MERGE_H * HOUR) g.push(w)
    else groups.push([w])
  }

  const skipped: { windowId: string; reason: WindowSkipReason }[] = []
  const events: VenueStressEvent[] = []
  for (const g of groups) {
    const members: VenueWindowRow[] = []
    for (const w of g) {
      const m = windowMetrics(s, w.onsetSec, opts)
      if ('skip' in m) {
        skipped.push({ windowId: w.id, reason: m.skip })
        continue
      }
      members.push({
        ...m,
        venue: s.venue,
        windowId: w.id,
        trigger: w.trigger,
        label: w.label,
        shortLabel: w.shortLabel,
        onsetBasis: w.onsetBasis,
        onsetIso: isoHour(w.onsetSec),
      })
    }
    if (members.length === 0) continue
    const worst = members.slice().sort((a, b) => compareWorstFirst(a, b, basis))[0]
    const namedWindow = g.find((w) => w.trigger === 'named')
    const label = namedWindow ? namedWindow.label : worst.label
    const shortLabel = namedWindow ? namedWindow.shortLabel : worst.shortLabel
    events.push({
      venue: s.venue,
      name: `${s.name}, ${shortLabel}`,
      label,
      shortLabel,
      memberIds: g.map((w) => w.id),
      firstOnsetIso: isoHour(g[0].onsetSec),
      worst,
      members,
    })
  }
  events.sort((a, b) => compareWorstFirst(a.worst, b.worst, basis))
  return { events, skipped }
}

// ---------------------------------------------------------------- presets

function presetFrom(
  id: VenueAnalogPresetId,
  e: VenueStressEvent,
  rank: number,
  n: number,
  percentile: number | null,
  basis: VenueAnalogBasis,
  range: { fromIso: string; toIso: string },
): VenueAnalogPreset {
  const w = e.worst
  const f = basisF(w, basis, 'h8')
  const cashUsd8h = basis === 'held' ? w.minCashUsdHeld.h8 : w.minCashUsd.h8
  const pct = (x: number) => `${(x * 100).toFixed(2)}%`
  const what =
    id === 'worst-observed'
      ? 'Worst observed'
      : `${id === 'typical-stress' ? 'Median' : '10th-percentile'} stress event (rank ${rank} of ${n})`
  return {
    id,
    venue: e.venue,
    basis,
    percentile,
    rank,
    n,
    f,
    locked: f <= VENUE_LOCK_F,
    fOnset: w.fOnset,
    minF24h: basisF(w, basis, 'h24'),
    minF72h: basisF(w, basis, 'h72'),
    lockH: w.lockH,
    lockCensored: w.lockCensored,
    lockedHours72h: w.lockedHours72h,
    recover5H: w.recover5H,
    recoverLowerBoundH: w.recoverLowerBoundH,
    horizonCensored: w.horizonCensored,
    cashUsd8h,
    source: {
      name: e.name,
      label: e.label,
      windowId: w.windowId,
      trigger: w.trigger,
      onsetIso: w.onsetIso,
      memberIds: e.memberIds,
    },
    range,
    provenance:
      `${what}: ${e.name} (${w.onsetIso}) — ${pct(f)} withdrawable across the 8 h window` +
      `${w.lockH > 0 ? `, locked ${Math.round(w.lockH)}${w.lockCensored ? '+' : ''} h` : ''}; ${n} events ${range.fromIso.slice(0, 7)} → ${range.toIso.slice(0, 7)}.`,
  }
}

/** The analog table: every venue × (typical, bad, worst-observed), plus the bounds. */
export function venueStressAnalogs(
  series: readonly VenueSeries[],
  windows: readonly StressWindow[],
  opts: VenueAnalogOptions = {},
): VenueAnalogTable {
  const basis = opts.basis ?? VENUE_ANALOG_DEFAULT_BASIS
  const rows: VenueAnalogRow[] = []
  for (const s of series
    .slice()
    .sort((a, b) => (a.venue < b.venue ? -1 : a.venue > b.venue ? 1 : 0))) {
    validateSeries(s)
    const { events, skipped } = venueStressEvents(s, windows, { ...opts, basis })
    const n = events.length
    if (n === 0) {
      rows.push({ venue: s.venue, name: s.name, n, range: null, presets: null, events, skipped })
      continue
    }
    let first = Infinity
    let last = -Infinity
    for (const e of events) {
      first = Math.min(first, e.worst.onsetSec)
      last = Math.max(last, e.worst.onsetSec)
    }
    const range = { fromIso: isoHour(first), toIso: isoHour(last) }
    const at = (p: number) => nearestRankIndex(p, n)
    const typ = at(VENUE_ANALOG_PERCENTILES['typical-stress'])
    const bad = at(VENUE_ANALOG_PERCENTILES['bad-stress'])
    rows.push({
      venue: s.venue,
      name: s.name,
      n,
      range,
      presets: {
        'typical-stress': presetFrom('typical-stress', events[typ], typ + 1, n, 0.5, basis, range),
        'bad-stress': presetFrom('bad-stress', events[bad], bad + 1, n, 0.1, basis, range),
        'worst-observed': presetFrom('worst-observed', events[0], 1, n, null, basis, range),
      },
      events,
      skipped,
    })
  }
  return {
    version: VENUE_ANALOG_CODE_VERSION,
    descriptiveLabel: MEASURED_DESCRIPTIVE_LABEL,
    basis,
    rows,
    bounds: VENUE_ANALOG_BOUNDS,
  }
}

// ---------------------------------------------------------------- use

export type AnalogCapacityMode = 'pro-rata' | 'first-in-line'

/**
 * Exit capacity, USD, for `deployedUsd` at a preset or bound.
 *   'pro-rata'       f × deployed (the race assumption; size-independent).
 *   'first-in-line'  min(deployed, cash) — the absolute upper bound for one moment; null
 *                    when the source's USD cash is unknown. A bound has no cash figure: frozen
 *                    is 0, optimistic is the whole deployed amount.
 */
export function analogExitCapacityUsd(
  choice: VenueAnalogPreset | VenueAnalogBound,
  deployedUsd: number,
  mode: AnalogCapacityMode = 'pro-rata',
): number | null {
  const d = Math.max(0, deployedUsd)
  if (mode === 'pro-rata' || !('cashUsd8h' in choice)) return d * choice.f
  return choice.cashUsd8h === null ? null : Math.min(d, choice.cashUsd8h)
}

// ------------------------------------------------------- engine presets

const LEVEL_OF: Readonly<Record<VenueAnalogPresetId, ExitCapacityAnalogLevel>> = {
  'typical-stress': 'typical',
  'bad-stress': 'bad',
  'worst-observed': 'worst',
}

const r4 = (x: number) => {
  const v = Math.round(x * 1e4) / 1e4
  return v === 0 ? 0 : v
}

/**
 * The analog table as the stress engine's preset rows (exitCapacityAnalogs.ts header: the
 * mapping onto `mult` and `freezeHours`). Every venue of `venues` (default
 * EXIT_CAPACITY_ANALOG_VENUES) × level, in that order; a venue missing from the table, or with
 * no event, throws — a preset is never invented. Fractions to 0.01%, hours whole, cash to the
 * dollar.
 */
export function exitCapacityAnalogRows(
  table: VenueAnalogTable,
  venues: readonly (typeof EXIT_CAPACITY_ANALOG_VENUES)[number][] = EXIT_CAPACITY_ANALOG_VENUES,
): ExitCapacityAnalogRow[] {
  if (table.basis !== EXIT_CAPACITY_ANALOG_SOURCE.basis) {
    throw new Error(
      `venueStressAnalogs: engine presets are on the '${EXIT_CAPACITY_ANALOG_SOURCE.basis}' basis`,
    )
  }
  const out: ExitCapacityAnalogRow[] = []
  for (const v of venues) {
    const row = table.rows.find((r) => r.venue === v.venue)
    if (!row || !row.presets || !row.range)
      throw new Error(`venueStressAnalogs: no measured events for ${v.venue}`)
    for (const id of VENUE_ANALOG_MEASURED_IDS) {
      const p = row.presets[id]
      const level = LEVEL_OF[id]
      const e = row.events.find((x) => x.worst.windowId === p.source.windowId)
      if (!e) throw new Error(`venueStressAnalogs: ${v.venue} ${id} has no source event`)
      const mult = r4(p.f)
      const lockH = Math.round(p.lockH)
      // Copy rule: a fraction under 0.01% is never printed as a bare zero.
      const fText = p.f < 1e-4 ? 'Under 0.01%' : `${(p.f * 100).toFixed(2)}%`
      const what =
        level === 'worst'
          ? `worst of ${p.n} stress events`
          : `${level === 'typical' ? 'median' : '10th-percentile'} of ${p.n} stress events (rank ${p.rank})`
      const recover =
        p.recover5H !== null
          ? `, back to 5% after ${Math.round(p.recover5H)} h`
          : p.recoverLowerBoundH !== null
            ? `, still under 5% ${Math.round(p.recoverLowerBoundH)} h later at the data's end`
            : ''
      const later = Math.round(p.lockedHours72h)
      const lock = p.locked
        ? `; locked (≤ 1%) for ${lockH}${p.lockCensored ? '+' : ''} h${recover}`
        : lockH > 0
          ? `; one ≤ 1% reading inside the window, which the hourly retry clears`
          : later > 0
            ? `; ≤ 1% for ${later} h later in the 72 h, after the window`
            : ''
      const provenance =
        `${v.name}, ${what} ${p.range.fromIso.slice(0, 7)} → ${p.range.toIso.slice(0, 7)}: ` +
        `${e.shortLabel} (onset ${p.source.onsetIso}). ` +
        `${fText} of deposits withdrawable across the 8 h window${lock}. ` +
        `Pro-rata share of the venue's cash${v.asset === 'eth' ? '; an ETH supply market' : ''}.` +
        (p.horizonCensored ? " The 72 h horizon runs past the data's end." : '')
      out.push({
        id: `${v.slug}-${level}`,
        slug: v.slug,
        venue: v.venue,
        venueName: v.name,
        asset: v.asset,
        level,
        percentile: p.percentile,
        rank: p.rank,
        n: p.n,
        from: p.range.fromIso,
        to: p.range.toIso,
        mult,
        freezeHours: p.locked ? lockH : 0,
        locked: p.locked,
        fOnset: r4(p.fOnset),
        fSingleReading: r4(e.worst.minF.h8),
        minF72h: r4(p.minF72h),
        lockH,
        lockCensored: p.lockCensored,
        recover5H: p.recover5H === null ? null : Math.round(p.recover5H),
        recoverLowerBoundH: p.recoverLowerBoundH === null ? null : Math.round(p.recoverLowerBoundH),
        horizonCensored: p.horizonCensored,
        cashUsd8h: p.cashUsd8h === null ? null : Math.round(p.cashUsd8h),
        event: e.shortLabel,
        eventLabel: e.label,
        windowId: p.source.windowId,
        trigger: p.source.trigger,
        onset: p.source.onsetIso,
        windows: [...p.source.memberIds],
        provenance,
      })
    }
  }
  return out
}
