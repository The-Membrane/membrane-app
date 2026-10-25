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
 * engine reads them as data from exitCapacityAnalogs.ts (`exitCapacityBookRows`, the
 * cash-vs-book headline; `exitCapacityAnalogRows`, the pro-rata floor).
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
 *  PRO-RATA RACE — THE FLOOR (owner ruling 2026-10-07: the floor, not the headline): if
 *  every depositor tries to exit at once, one depositor's expected share of the cash is its
 *  share of the supply: a deposit of D gets f × D. That is NOT what depositors could actually
 *  withdraw — the cash was there for whoever came first — it is the case where the whole
 *  supply races for it at the same moment. The vault is held to the same race one level down (every supplier of each Morpho
 *  market exits at once), so its f is like-for-like with Aave's and Spark's (review
 *  2026-10-07: the first-in-line walk had read Steakhouse's typical f at 21.83%). That is
 *  (a) SIZE-INDEPENDENT — one number per venue per moment, which is what the
 *  engine's `exitCapacityMult` (a multiple of the deployed amount) takes — and (b)
 *  CONSERVATIVE against the first-in-line case: f × D = cash × D / supply ≤ cash for any
 *  D ≤ supply. So on the SAME event it is the worst case of the two models for any book the
 *  venue could hold (B ≤ supply ⇒ cash / B ≥ f; CASH VS BOOK, BOOK EXCEEDS THE VENUE). It is
 *  not the theoretical lower bound: a recall that loses the race entirely gets nothing, which
 *  is the 'frozen ×0' bound below.
 *  ABSOLUTE (size-aware): cash(t) in USD. A deposit of D that is first in line gets
 *  min(D, cashUsd) (`analogExitCapacityUsd` 'first-in-line'); the HEADLINE model below holds
 *  Membrane's whole book to it (CASH VS BOOK). Stablecoins are held at $1 (VENUE_STABLE_SYMBOLS: a depeg would
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
 *
 * ---------------------------------------------------------------------------
 * CASH VS BOOK — THE HEADLINE (owner ruling 2026-10-07; `cashVsBookAnalogs`)
 * ---------------------------------------------------------------------------
 *  Same events, same onsets, same 8 h window, same 'held' basis and hourly keeper retry as
 *  above. Instead of f, each window is read as m(B) = min(1, cash_held / B): the venue's idle
 *  cash in USD that the held basis credits (f_held × supply — the cash observed in that hour)
 *  against B, Membrane's WHOLE book at that venue (exitCapacityAnalogs EXIT_CAPACITY_BOOKS:
 *  $10M / $50M / $250M). Every Membrane position at the venue gets m of its own deployment.
 *  Per venue AND per book, each event is counted at its worst member under m, events rank as
 *  in RANKING with m for f (`compareWorstFirstBook`: every m8 ≤ 1% ties as locked, then the
 *  m-lock ↓, m-locked hours ↓, m72 ↑, onset ↑, id ↑), and the same nearest ranks pick
 *  typical / bad / worst. LOCKS: a reading with m ≤ 1% (cash ≤ 1% of the book) is locked; the
 *  lock a recall in the 8 h window runs into is measured by the same rule as `lockH`
 *  (`thresholdRuns`), and only a locked preset (m8 ≤ 1%) carries it to the engine.
 *  MONOTONE IN B: a larger book never gets a higher m for the same window, never a shorter
 *  m-lock, so never a higher preset (tests/unit/venueStressAnalogs.test.ts).
 *  ASSUMPTIONS (state them wherever the numbers are shown):
 *    (i)   the whole book recalls at once, at the onset — conservative: in practice only the
 *          positions that breach recall, and only down to their borrow LTV;
 *    (ii)  the observed cash is first come within the hour and already NET of every other
 *          depositor who withdrew in that hour (it is what was left after them). NOT for
 *          the MetaMorpho vault: its cash is its pro-rata share of each market's idle cash,
 *          not cash it is first in line for, so its levels are conservative on (ii)
 *          (VAULT_CASH_NOTE, said in each of its rows);
 *    (iii) Membrane's recall does not itself trigger a run on the venue;
 *    (iv)  the engine's stock never refills across the horizon.
 *  The pro-rata f stays as the FLOOR (every depositor exits at once).
 *  BOOK EXCEEDS THE VENUE (`bookExceedsVenue`, review 2026-10-07): on the same window, m8 < f8
 *  means cash / B < cash / supply at the reading that sets m8 (its held cash also bounds f8
 *  there), so B is larger than the venue's WHOLE supply in that window. The observed history is
 *  not an analog for a book that large (if Membrane's deposit added to the supply, the venue
 *  would have been a different venue; parent ruling 2026-10-07): the row is kept (one per
 *  venue × book × level, owner ruling 2026-10-07) but flagged in its label and provenance,
 *  and it is the one case where the headline pays less than the floor on the same event. On
 *  the data that is only $250M books at venues whose supply was under $250M (Steakhouse,
 *  Spark USDC, Spark USDS, Aave USDe); never Aave USDC, the venue the set-and-forget sim uses.
 *
 *  NOT MODELLED: the stock refilling across the horizon (the engine draws one stock and never
 *  refills it); the recall's own size moving f or the cash; interest accrued since a
 *  MetaMorpho market's last update; sub-hour paths (a reading is an hourly snapshot).
 */

import { MEASURED_DESCRIPTIVE_LABEL } from './measuredCapacity'
import { utilClusters, withdrawableFraction } from './venueStressRules'
import {
  EXIT_CAPACITY_ANALOG_SOURCE,
  EXIT_CAPACITY_ANALOG_VENUES,
  EXIT_CAPACITY_BOOKS,
  type ExitCapacityAnalogLevel,
  type ExitCapacityBookId,
  type ExitCapacityBookRow,
  type ExitCapacityFloorRow,
} from './exitCapacityAnalogs'

// ---------------------------------------------------------------- constants

export const VENUE_ANALOG_CODE_VERSION = 'venue-stress-analogs/2'

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
      'Everything deployed comes back on demand, in every scenario. An upper bound only, never a default (owner ruling 2026-10-04). On the pro-rata floor no stress window measured it; cash vs book reaches ×1 only where the measured idle cash covered the whole book.',
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

/** The lock and recovery measures of one window, for any per-reading quantity (THRESHOLD RUNS). */
interface ThresholdRuns {
  lockedHours72h: number
  lockH: number
  lockCensored: boolean
  recover5H: number | null
  recoverLowerBoundH: number | null
}

/**
 * Locked hours, the lock a recall in the 8 h window runs into, and the recovery to 5% (module
 * header, PER WINDOW) for a per-reading quantity `v` — the withdrawable fraction f, or the
 * cash-vs-book multiple m(B) (CASH VS BOOK). `k` is the as-of reading, `idx` the readings with a
 * known f in [as-of, onset + 72 h]. A reading with `v` unknown (null) is never locked and
 * breaks a lock run.
 */
function thresholdRuns(
  s: VenueSeries,
  k: number,
  onsetSec: number,
  idx: readonly number[],
  v: (i: number) => number | null,
): ThresholdRuns {
  const t = s.t
  const maxH = VENUE_ANALOG_HORIZONS_H[VENUE_ANALOG_HORIZONS_H.length - 1]
  const end72 = onsetSec + maxH * HOUR
  const end8 = onsetSec + VENUE_ANALOG_BASIS_HORIZON_H * HOUR
  const lastT = t[t.length - 1]

  // locked hours inside [onset, onset + 72 h): a reading holds until the next reading, ≤ 6 h
  const readingEnd = (i: number) =>
    i + 1 < t.length ? Math.min(t[i + 1], t[i] + VENUE_READING_MAX_H * HOUR) : t[i]
  let lockedSec = 0
  for (let i = k; i < t.length && t[i] < end72; i++) {
    const x = v(i)
    if (x === null || x > VENUE_LOCK_F) continue
    const a = Math.max(t[i], onsetSec)
    const b = Math.min(readingEnd(i), end72)
    if (b > a) lockedSec += b - a
  }

  // the longest locked stretch a recall in the 8 h window [onset, onset + 8 h] runs into: one
  // that starts by the window's end (a stretch from the as-of reading k on overlaps the onset)
  let lockSec = 0
  let lockCensored = false
  for (let i = k; i < t.length && t[i] <= end8; ) {
    const x = v(i)
    if (x === null || x > VENUE_LOCK_F) {
      i++
      continue
    }
    const start = Math.max(t[i], onsetSec)
    let j = i
    while (
      j + 1 < t.length &&
      t[j + 1] - t[j] <= VENUE_READING_MAX_H * HOUR &&
      (v(j + 1) ?? Infinity) <= VENUE_LOCK_F
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

  // recovery to ≥ 5%, once under 5% inside the first 72 h
  let recover5H: number | null = 0
  let recoverLowerBoundH: number | null = null
  const dip = idx.find((i) => {
    const x = v(i)
    return x !== null && x < VENUE_RECOVER_F
  })
  if (dip !== undefined) {
    recover5H = null
    for (let j = dip + 1; j < t.length; j++) {
      const x = v(j)
      if (x !== null && x >= VENUE_RECOVER_F) {
        recover5H = Math.max(0, t[j] - onsetSec) / HOUR
        break
      }
    }
    if (recover5H === null) recoverLowerBoundH = Math.max(0, lastT - onsetSec) / HOUR
  }
  return {
    lockedHours72h: lockedSec / HOUR,
    lockH: lockSec / HOUR,
    lockCensored,
    recover5H,
    recoverLowerBoundH,
  }
}

/** Readings with a known f in [as-of reading `k`, onset + 72 h]. */
function knownReadings(s: VenueSeries, k: number, onsetSec: number): number[] {
  const t = s.t
  const end72 = onsetSec + VENUE_ANALOG_HORIZONS_H[VENUE_ANALOG_HORIZONS_H.length - 1] * HOUR
  const idx: number[] = []
  for (let i = k; i < t.length && t[i] <= end72; i++) if (fAt(s, i) !== null) idx.push(i)
  return idx
}

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

  const idx = knownReadings(s, k, onsetSec)

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

  const runs = thresholdRuns(s, k, onsetSec, idx, fOf)

  return {
    onsetSec,
    onsetReadingSec: t[k],
    fOnset: fAt(s, k) as number,
    minF: { h8: fMin(8), h24: fMin(24), h72: fMin(72) },
    minFHeld: { h8: fHeldMin(8), h24: fHeldMin(24), h72: fHeldMin(72) },
    cashUsdOnset: cashOf(k),
    minCashUsd: { h8: cashMin(8), h24: cashMin(24), h72: cashMin(72) },
    minCashUsdHeld: { h8: cashHeldMin(8), h24: cashHeldMin(24), h72: cashHeldMin(72) },
    ...runs,
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

// ---------------------------------------------------------- cash vs book

/**
 * m(B) = min(1, cash / B) — the share of Membrane's whole book B at a venue that the venue's
 * idle cash covers (module header, CASH VS BOOK). Unknown cash is unknown (null), never 0.
 */
export function cashVsBookMultiplier(cashUsd: number | null, bookUsd: number): number | null {
  if (!(Number.isFinite(bookUsd) && bookUsd > 0))
    throw new Error(`venueStressAnalogs: book ${bookUsd} must be a positive USD amount`)
  if (cashUsd === null || !Number.isFinite(cashUsd)) return null
  return Math.min(1, Math.max(0, cashUsd) / bookUsd)
}

export interface HorizonNullable {
  h8: number | null
  h24: number | null
  h72: number | null
}

/** One window against one book (module header, CASH VS BOOK). */
export interface BookWindowMetrics {
  bookUsd: number
  /** m at the onset reading. */
  mOnset: number | null
  /** min(1, held cash / B), lowest over each horizon: the basis the presets rank on. */
  mHeld: HorizonNullable
  /** min(1, cash / B) on the literal single readings. */
  mReading: HorizonNullable
  /** Readings with m ≤ 1% (cash ≤ 1% of the book) inside [t0, t0 + 72 h). */
  lockedHours72h: number
  /** The m ≤ 1% stretch a recall inside the 8 h window runs into (same rule as `lockH`). */
  lockH: number
  lockCensored: boolean
  /** Hours from t0 until m ≥ 5% again, once under 5% in the first 72 h. */
  recover5H: number | null
  recoverLowerBoundH: number | null
}

/**
 * The cash-vs-book measures of a window already measured by `windowMetrics` (same onset, same
 * as-of reading): m from the held and single-reading USD cash, and the lock and recovery runs
 * on m (cash ≤ 1% / ≥ 5% of the book) instead of f.
 */
export function bookWindowMetrics(
  s: VenueSeries,
  w: WindowMetrics,
  bookUsd: number,
  opts: VenueAnalogOptions = {},
): BookWindowMetrics {
  const m = (cash: number | null) => cashVsBookMultiplier(cash, bookUsd)
  const k = asOfIndex(s.t, w.onsetReadingSec)
  if (k < 0 || s.t[k] !== w.onsetReadingSec)
    throw new Error(`venueStressAnalogs: ${s.venue} has no reading at ${w.onsetReadingSec}`)
  const runs = thresholdRuns(s, k, w.onsetSec, knownReadings(s, k, w.onsetSec), (i) =>
    m(cashUsdAt(s, i, opts)),
  )
  return {
    bookUsd,
    mOnset: m(w.cashUsdOnset),
    mHeld: {
      h8: m(w.minCashUsdHeld.h8),
      h24: m(w.minCashUsdHeld.h24),
      h72: m(w.minCashUsdHeld.h72),
    },
    mReading: { h8: m(w.minCashUsd.h8), h24: m(w.minCashUsd.h24), h72: m(w.minCashUsd.h72) },
    ...runs,
  }
}

/** A window row with its book measures; m is known (a member with unknown USD cash is skipped). */
export interface BookWindowRow extends VenueWindowRow {
  book: BookWindowMetrics & { mHeld: HorizonValues }
}

/** m8 as ranked: every locked value (≤ VENUE_LOCK_F) is one tie, as for f. */
function rankM8(r: BookWindowRow): number {
  const m = r.book.mHeld.h8
  return m <= VENUE_LOCK_F ? 0 : m
}

/**
 * Worst first under one book: the f ranking (module header, RANKING) on m instead of f —
 * m8 ↑ (every m8 ≤ 1% ties as locked), then the m-lock ↓, m-locked hours ↓, m72 ↑, onset ↑, id ↑.
 */
export function compareWorstFirstBook(a: BookWindowRow, b: BookWindowRow): number {
  return (
    rankM8(a) - rankM8(b) ||
    b.book.lockH - a.book.lockH ||
    b.book.lockedHours72h - a.book.lockedHours72h ||
    a.book.mHeld.h72 - b.book.mHeld.h72 ||
    a.onsetSec - b.onsetSec ||
    (a.windowId < b.windowId ? -1 : a.windowId > b.windowId ? 1 : 0)
  )
}

export interface BookStressEvent {
  venue: string
  name: string
  label: string
  shortLabel: string
  memberIds: string[]
  firstOnsetIso: string
  /** The member the event is counted at under this book: its worst m. */
  worst: BookWindowRow
}

export interface CashVsBookPreset {
  id: VenueAnalogPresetId
  venue: string
  bookUsd: number
  percentile: number | null
  /** 1-based, worst first, of n. */
  rank: number
  n: number
  /** m(B) over the 8 h delay window, held basis: the engine multiple. */
  m: number
  /** m ≤ 1%. */
  locked: boolean
  mOnset: number
  mSingleReading: number
  m24h: number
  m72h: number
  /** The same window's pro-rata f over the 8 h (held): the floor's reading of the same hours. */
  f8: number
  /** m < f8: B is larger than the venue's whole supply in the window, a book that could not
   *  exist there (module header, BOOK EXCEEDS THE VENUE). */
  bookExceedsVenue: boolean
  lockH: number
  lockCensored: boolean
  lockedHours72h: number
  recover5H: number | null
  recoverLowerBoundH: number | null
  horizonCensored: boolean
  /** The source event's lowest idle cash over the 8 h window, USD (held basis). */
  cashUsd8h: number
  source: {
    name: string
    label: string
    windowId: string
    trigger: StressTrigger
    onsetIso: string
    memberIds: string[]
  }
  range: { fromIso: string; toIso: string }
  provenance: string
}

export interface CashVsBookRow {
  venue: string
  name: string
  bookUsd: number
  n: number
  range: { fromIso: string; toIso: string } | null
  presets: Record<VenueAnalogPresetId, CashVsBookPreset> | null
  /** Worst first under this book. */
  events: BookStressEvent[]
  /** Windows not measured: the venue's skipped windows, plus members with unknown USD cash. */
  skipped: { windowId: string; reason: WindowSkipReason | 'no_usd' }[]
}

export interface CashVsBookTable {
  version: string
  descriptiveLabel: string
  model: 'cash-vs-book'
  /** Always 'held': the idle cash the hourly keeper retry credits. */
  basis: 'held'
  books: readonly number[]
  /** Venue order, then book order. */
  rows: CashVsBookRow[]
}

/** Copy rule (viewModel.ts): no bare "$0" — idle cash under a dollar reads "under $1". */
const usdText = (x: number) =>
  x >= 1e6
    ? `$${(x / 1e6).toFixed(1)}M`
    : x >= 1e3
      ? `$${(x / 1e3).toFixed(1)}k`
      : x >= 1
        ? `$${Math.round(x)}`
        : 'under $1'

/**
 * The cash-vs-book table (module header, CASH VS BOOK): per venue and per book B, the same
 * events as the floor (`venueStressEvents`: same windows, same onsets, same 72 h merge), each
 * counted at its worst member under m(B), ranked by `compareWorstFirstBook`, and the median /
 * 10th-percentile / worst event picked by the same nearest rank. Basis 'held' only.
 */
export function cashVsBookAnalogs(
  series: readonly VenueSeries[],
  windows: readonly StressWindow[],
  books: readonly number[],
  opts: Omit<VenueAnalogOptions, 'basis'> = {},
): CashVsBookTable {
  for (const b of books) cashVsBookMultiplier(0, b) // validates every book
  const rows: CashVsBookRow[] = []
  for (const s of series
    .slice()
    .sort((a, b) => (a.venue < b.venue ? -1 : a.venue > b.venue ? 1 : 0))) {
    validateSeries(s)
    const { events: base, skipped } = venueStressEvents(s, windows, { ...opts, basis: 'held' })
    for (const bookUsd of books) {
      const noUsd: { windowId: string; reason: 'no_usd' }[] = []
      const events: BookStressEvent[] = []
      for (const e of base) {
        const members: BookWindowRow[] = []
        for (const w of e.members) {
          const book = bookWindowMetrics(s, w, bookUsd, opts)
          const { h8, h24, h72 } = book.mHeld
          if (h8 === null || h24 === null || h72 === null) {
            noUsd.push({ windowId: w.windowId, reason: 'no_usd' })
            continue
          }
          members.push({ ...w, book: { ...book, mHeld: { h8, h24, h72 } } })
        }
        if (members.length === 0) continue
        const worst = members.slice().sort(compareWorstFirstBook)[0]
        events.push({
          venue: e.venue,
          name: e.name,
          label: e.label,
          shortLabel: e.shortLabel,
          memberIds: e.memberIds,
          firstOnsetIso: e.firstOnsetIso,
          worst,
        })
      }
      events.sort((a, b) => compareWorstFirstBook(a.worst, b.worst))
      const n = events.length
      const allSkipped = [...skipped, ...noUsd]
      if (n === 0) {
        rows.push({
          venue: s.venue,
          name: s.name,
          bookUsd,
          n,
          range: null,
          presets: null,
          events,
          skipped: allSkipped,
        })
        continue
      }
      let first = Infinity
      let last = -Infinity
      for (const e of events) {
        first = Math.min(first, e.worst.onsetSec)
        last = Math.max(last, e.worst.onsetSec)
      }
      const range = { fromIso: isoHour(first), toIso: isoHour(last) }
      const pick = (id: VenueAnalogPresetId, idx: number, percentile: number | null) =>
        bookPresetFrom(id, events[idx], idx + 1, n, percentile, bookUsd, range)
      const typ = nearestRankIndex(VENUE_ANALOG_PERCENTILES['typical-stress'], n)
      const bad = nearestRankIndex(VENUE_ANALOG_PERCENTILES['bad-stress'], n)
      rows.push({
        venue: s.venue,
        name: s.name,
        bookUsd,
        n,
        range,
        presets: {
          'typical-stress': pick('typical-stress', typ, VENUE_ANALOG_PERCENTILES['typical-stress']),
          'bad-stress': pick('bad-stress', bad, VENUE_ANALOG_PERCENTILES['bad-stress']),
          'worst-observed': pick('worst-observed', 0, null),
        },
        events,
        skipped: allSkipped,
      })
    }
  }
  return {
    version: VENUE_ANALOG_CODE_VERSION,
    descriptiveLabel: MEASURED_DESCRIPTIVE_LABEL,
    model: 'cash-vs-book',
    basis: 'held',
    books: [...books],
    rows,
  }
}

function bookPresetFrom(
  id: VenueAnalogPresetId,
  e: BookStressEvent,
  rank: number,
  n: number,
  percentile: number | null,
  bookUsd: number,
  range: { fromIso: string; toIso: string },
): CashVsBookPreset {
  const w = e.worst
  const b = w.book
  const m = b.mHeld.h8
  const cashUsd8h = w.minCashUsdHeld.h8 as number // known: m is
  const what =
    id === 'worst-observed'
      ? 'Worst observed'
      : `${id === 'typical-stress' ? 'Median' : '10th-percentile'} stress event (rank ${rank} of ${n})`
  const cover =
    m >= 1
      ? `idle cash ${usdText(cashUsd8h)} covered the whole ${usdText(bookUsd)} book`
      : `idle cash ${usdText(cashUsd8h)} covered ${fracText(m)} of the ${usdText(bookUsd)} book`
  const f8 = w.minFHeld.h8
  const bookExceedsVenue = m < f8
  const exceeds = bookExceedsVenue
    ? ` The ${usdText(bookUsd)} book exceeds the venue's whole supply in that window (the floor's f is ${fracText(f8)}): the observed history is not an analog for a book that large.`
    : ''
  return {
    id,
    venue: e.venue,
    bookUsd,
    percentile,
    rank,
    n,
    m,
    locked: m <= VENUE_LOCK_F,
    mOnset: b.mOnset as number,
    mSingleReading: b.mReading.h8 as number,
    m24h: b.mHeld.h24,
    m72h: b.mHeld.h72,
    f8,
    bookExceedsVenue,
    lockH: b.lockH,
    lockCensored: b.lockCensored,
    lockedHours72h: b.lockedHours72h,
    recover5H: b.recover5H,
    recoverLowerBoundH: b.recoverLowerBoundH,
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
    provenance: `${what}: ${e.name} (${w.onsetIso}) — ${cover} across the 8 h window; ${n} events ${range.fromIso.slice(0, 7)} → ${range.toIso.slice(0, 7)}.${exceeds}`,
  }
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

/** Copy rule: a fraction under 0.01% is never printed as a bare zero. Lower case: it sits
 *  mid-sentence; `sentence` capitalises it where it opens one. */
const fracText = (x: number) => (x < 1e-4 ? 'under 0.01%' : `${(x * 100).toFixed(2)}%`)

/** The first letter upper-cased: a generated clause that opens a sentence. */
const sentence = (s: string) => `${s[0].toUpperCase()}${s.slice(1)}`

type AnalogVenue = (typeof EXIT_CAPACITY_ANALOG_VENUES)[number]

function rankText(level: ExitCapacityAnalogLevel, n: number, rank: number): string {
  return level === 'worst'
    ? `worst of ${n} stress events`
    : `${level === 'typical' ? 'median' : '10th-percentile'} of ${n} stress events (rank ${rank})`
}

function recoverText(recover5H: number | null, recoverLowerBoundH: number | null): string {
  return recover5H !== null
    ? `, back to 5% after ${Math.round(recover5H)} h`
    : recoverLowerBoundH !== null
      ? `, still under 5% ${Math.round(recoverLowerBoundH)} h later at the data's end`
      : ''
}

/**
 * The floor table as the stress engine's PRO-RATA preset rows, ids '<venue>-floor-<level>'
 * (exitCapacityAnalogs.ts header: the mapping onto `mult` and `freezeHours`). Every venue of
 * `venues` (default EXIT_CAPACITY_ANALOG_VENUES) × level, in that order; a venue missing from
 * the table, or with no event, throws — a preset is never invented. Fractions to 0.01%, hours
 * whole, cash to the dollar.
 */
export function exitCapacityAnalogRows(
  table: VenueAnalogTable,
  venues: readonly AnalogVenue[] = EXIT_CAPACITY_ANALOG_VENUES,
): ExitCapacityFloorRow[] {
  if (table.basis !== EXIT_CAPACITY_ANALOG_SOURCE.basis) {
    throw new Error(
      `venueStressAnalogs: engine presets are on the '${EXIT_CAPACITY_ANALOG_SOURCE.basis}' basis`,
    )
  }
  const out: ExitCapacityFloorRow[] = []
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
      const later = Math.round(p.lockedHours72h)
      const lock = p.locked
        ? `; locked (≤ 1%) for ${lockH}${p.lockCensored ? '+' : ''} h${recoverText(p.recover5H, p.recoverLowerBoundH)}`
        : lockH > 0
          ? `; one ≤ 1% reading inside the window, which the hourly retry clears`
          : later > 0
            ? `; ≤ 1% for ${later} h later in the 72 h, after the window`
            : ''
      const provenance =
        `${v.name}, ${rankText(level, p.n, p.rank)} ${p.range.fromIso.slice(0, 7)} → ${p.range.toIso.slice(0, 7)}: ` +
        `${e.shortLabel} (onset ${p.source.onsetIso}). ` +
        `${sentence(fracText(p.f))} of deposits withdrawable across the 8 h window${lock}. ` +
        `Floor: every depositor exits at once and a recall gets its pro-rata share of the venue's cash${v.asset === 'eth' ? '; an ETH supply market' : ''}.` +
        (p.horizonCensored ? " The 72 h horizon runs past the data's end." : '')
      out.push({
        id: `${v.slug}-floor-${level}`,
        slug: v.slug,
        venue: v.venue,
        venueName: v.name,
        asset: v.asset,
        model: 'pro-rata',
        bookUsd: null,
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

/** Assumption (ii) does not hold for a MetaMorpho vault (module header): said in its rows. */
const VAULT_CASH_NOTE =
  "; for this vault that cash is its pro-rata share of each Morpho market's idle cash, not cash it is first in line for, so the level is conservative"

/**
 * The cash-vs-book table as the stress engine's HEADLINE preset rows, ids
 * '<venue>-<book>-<level>' (exitCapacityAnalogs.ts header). Every venue of `venues` × every
 * book of `books` (default EXIT_CAPACITY_BOOKS, which the table must have measured) × level,
 * in that order; a missing venue or book, or one with no event, throws. m to 0.01%, hours
 * whole, cash to the dollar. A locked row (m ≤ 1%) carries its m-lock as `freezeHours`.
 */
export function exitCapacityBookRows(
  table: CashVsBookTable,
  venues: readonly AnalogVenue[] = EXIT_CAPACITY_ANALOG_VENUES,
  books: readonly { id: ExitCapacityBookId; usd: number; label: string }[] = EXIT_CAPACITY_BOOKS,
): ExitCapacityBookRow[] {
  if (table.basis !== EXIT_CAPACITY_ANALOG_SOURCE.basis) {
    throw new Error(
      `venueStressAnalogs: engine presets are on the '${EXIT_CAPACITY_ANALOG_SOURCE.basis}' basis`,
    )
  }
  const out: ExitCapacityBookRow[] = []
  for (const v of venues) {
    for (const bk of books) {
      const row = table.rows.find((r) => r.venue === v.venue && r.bookUsd === bk.usd)
      if (!row || !row.presets || !row.range)
        throw new Error(`venueStressAnalogs: no measured events for ${v.venue} at ${bk.label}`)
      for (const id of VENUE_ANALOG_MEASURED_IDS) {
        const p = row.presets[id]
        const level = LEVEL_OF[id]
        const e = row.events.find((x) => x.worst.windowId === p.source.windowId)
        if (!e) throw new Error(`venueStressAnalogs: ${v.venue} ${bk.id} ${id} has no source event`)
        const mult = r4(p.m)
        const lockH = Math.round(p.lockH)
        const cash = usdText(p.cashUsd8h)
        const cover =
          mult >= 1
            ? `idle cash ${cash} across the 8 h window covers the whole ${bk.label} book (×1)`
            : `idle cash ${cash} across the 8 h window covers ${fracText(p.m)} of the ${bk.label} book`
        const lock = p.locked
          ? `; under 1% of the book for ${lockH}${p.lockCensored ? '+' : ''} h${recoverText(p.recover5H, p.recoverLowerBoundH)}`
          : ''
        // Module header, BOOK EXCEEDS THE VENUE: said in the row itself, never only in a doc.
        const exceeds = p.bookExceedsVenue
          ? ` Book exceeds the venue: ${bk.label} is more than the venue's whole supply in that window, so the observed history is not an analog for this book (if Membrane's deposit added to the supply, the venue would have been a different venue); everyone exits pays ${fracText(p.f8)} on the same event.`
          : ''
        const provenance =
          `${v.name}, ${bk.label} book, ${rankText(level, p.n, p.rank)} ${p.range.fromIso.slice(0, 7)} → ${p.range.toIso.slice(0, 7)}: ` +
          `${e.shortLabel} (onset ${p.source.onsetIso}). ${sentence(cover)}${lock}. ` +
          `Cash vs book: the whole book recalls at once against the idle cash observed that hour, already net of other withdrawers${v.asset === 'eth' ? '; an ETH supply market' : ''}${v.venue.startsWith('morpho-') ? VAULT_CASH_NOTE : ''}.` +
          exceeds +
          (p.horizonCensored ? " The 72 h horizon runs past the data's end." : '')
        out.push({
          id: `${v.slug}-${bk.id}-${level}`,
          slug: v.slug,
          venue: v.venue,
          venueName: v.name,
          asset: v.asset,
          model: 'cash-vs-book',
          book: bk.id,
          bookUsd: bk.usd,
          level,
          percentile: p.percentile,
          rank: p.rank,
          n: p.n,
          from: p.range.fromIso,
          to: p.range.toIso,
          mult,
          freezeHours: p.locked ? lockH : 0,
          locked: p.locked,
          mOnset: r4(p.mOnset),
          mSingleReading: r4(p.mSingleReading),
          m72h: r4(p.m72h),
          fWindow: r4(p.f8),
          bookExceedsVenue: p.bookExceedsVenue,
          lockH,
          lockCensored: p.lockCensored,
          recover5H: p.recover5H === null ? null : Math.round(p.recover5H),
          recoverLowerBoundH:
            p.recoverLowerBoundH === null ? null : Math.round(p.recoverLowerBoundH),
          horizonCensored: p.horizonCensored,
          cashUsd8h: Math.round(p.cashUsd8h),
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
  }
  return out
}
