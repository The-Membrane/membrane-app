/**
 * exitReadout — the per-user exit readout: "of your $X deposited, $Y exits within 8 h", and
 * the CROSSOVER deposit above which exit capacity binds. PURE. The venue stress levels below
 * are copied from public/data/venue-stress/summary.json (`analogs`, `venues.*.symbol`);
 * tests/unit/exitReadout.test.ts reads that file and fails on any drift.
 *
 * LEVELS
 *   'p50'  the median stress hour              ┐ summary.json `analogs.<venue>`: percentiles
 *   'p5'   the 5th-percentile stress hour      │ over every hourly reading inside a stress
 *   'min'  the lowest stress reading           ┘ window, 2023-10 → 2026-10 (`stressHours`)
 *   'now'  one reading the caller passes in (cash and supply in token units, with its time).
 *          Refused as 'stale' when older than MEASURED_STALE_CADENCES × the 1 h cadence
 *          (measuredCapacity.ts rule 3): a stale reading is never shown as now.
 *
 * TWO MODELS — the engine's (exitCapacityAnalogs.ts header, owner ruling 2026-10-07):
 *   HEADLINE  cash vs book with YOUR DEPOSIT as the book: D × m(D) = min(D, C), C the venue's
 *             idle cash at the level. Assumptions (i)–(iv) of that header hold: the deposit
 *             recalls at once; the cash is first come and already net of every other
 *             withdrawal in the hour; the recall does not start a run; the stock does not
 *             refill.
 *   FLOOR     pro-rata: every depositor exits at once, and the deposit gets f = cash / supply
 *             of itself, D × f, whatever its size.
 *   CROSSOVER the headline binds above D* = C. At or below it the whole deposit exits on the
 *             headline. The floor binds at every size while f < 1.
 *   WITHIN 8 H the engine's venue stock (stressGrid.ts "MODELLED, NOT MASTER"): one stock,
 *             drawn down and never refilled across the 8 h delay window. A level's cash is
 *             that stock.
 *
 * READING THE LEVELS
 *  - Cash and f are ranked SEPARATELY over the same stress hours. Each figure is still its
 *    model's percentile (the headline rises with C alone, the floor with f alone), but C / f
 *    is not the venue's supply at a level. On 'now' they come from one reading.
 *  - Cash is in absolute USD across three years of venue growth. Aave USDC's p5 cash hours
 *    (cash ≤ $39M, 324 of 6,467) are 173 in 2023, at a median supply of $422M; the venue held
 *    $2.40B at the data's end. f is size-free; cash is not.
 *  - A stress hour is ANY hour inside a stress window, on single readings. The engine presets
 *    take each event's first 8 h from onset on the 'held' basis. So 'min' is at or below the
 *    presets' 'worst': equal where both are the Kelp Apr-2026 lock (Aave USDC $6,402 vs
 *    $7,085), lower where a deep hour sits outside any onset's 8 h (Spark USDS f 14.8% vs
 *    25.2%).
 *  - Steakhouse USDC: its cash is the vault's pro-rata share of each Morpho market's idle cash
 *    (history.json `semantics.cash`), not first in line — conservative on (ii).
 *  - Stablecoins are held at $1 (VENUE_STABLE_SYMBOLS). WETH needs `priceUsd` (the view
 *    passes the live Chainlink round, ethUsdSpot.ts), else there is no readout: unknown is
 *    unknown, never 0.
 *  - Descriptive history, not a forecast. No cash ÷ flow clock (board, 2026-09-27 EXIT
 *    CAPACITY PERSISTENCE).
 */

import { EXIT_CAPACITY_ANALOG_VENUES } from './exitCapacityAnalogs'
import { MEASURED_DEFAULT_CADENCE_MS, MEASURED_STALE_CADENCES } from './measuredCapacity'
import { VENUE_STABLE_SYMBOLS } from './venueStressAnalogs'
import { withdrawableFraction } from './venueStressRules'

// ------------------------------------------------------------------- data

export const EXIT_READOUT_SOURCE = {
  file: 'public/data/venue-stress/summary.json',
  generatedAt: '2026-10-07T04:31:50.006Z',
  from: '2023-10-01T00:00Z',
  to: '2026-10-07T01:00Z',
} as const

/** One venue's stress levels, summary.json `analogs.<venue>`. Token units; f in percent. */
export interface VenueStressCashLevels {
  readonly symbol: string
  /** Hourly readings inside stress windows that the percentiles rank. */
  readonly stressHours: number
  /** `stressCash`: the venue's idle cash, token units. */
  readonly cash: { readonly p50: number; readonly p5: number; readonly min: number }
  /** `stressCashFracPct`: f = cash / supply, percent. */
  readonly fracPct: { readonly p50: number; readonly p5: number; readonly min: number }
}

export const EXIT_READOUT_VENUE_LEVELS = {
  'aave-core-usdc': {
    symbol: 'USDC',
    stressHours: 6467,
    cash: { p50: 248929094, p5: 38994236, min: 6402 },
    fracPct: { p50: 11.741, p5: 5.858, min: 0 },
  },
  'aave-core-usdt': {
    symbol: 'USDT',
    stressHours: 6467,
    cash: { p50: 376821969, p5: 50870265, min: 1463 },
    fracPct: { p50: 15.97, p5: 4.948, min: 0 },
  },
  'aave-core-weth': {
    symbol: 'WETH',
    stressHours: 6467,
    cash: { p50: 195730.748, p5: 22292.001, min: 0.006 },
    fracPct: { p50: 13.45, p5: 1.088, min: 0 },
  },
  'spark-dai': {
    symbol: 'DAI',
    stressHours: 6467,
    cash: { p50: 87255256, p5: 5463782, min: 0 },
    fracPct: { p50: 10.99, p5: 0.909, min: 0 },
  },
  'spark-usdc': {
    symbol: 'USDC',
    stressHours: 1181,
    cash: { p50: 9037680, p5: 5151173, min: 1150011 },
    fracPct: { p50: 18.075, p5: 9.755, min: 2.235 },
  },
  'spark-usds': {
    symbol: 'USDS',
    stressHours: 2927,
    cash: { p50: 118797436, p5: 40071915, min: 30604856 },
    fracPct: { p50: 27.758, p5: 19.94, min: 14.845 },
  },
  'spark-usdt': {
    symbol: 'USDT',
    stressHours: 2360,
    cash: { p50: 93430754, p5: 6255207, min: 2861 },
    fracPct: { p50: 23.713, p5: 4.886, min: 0.001 },
  },
  'spark-weth': {
    symbol: 'WETH',
    stressHours: 6467,
    cash: { p50: 56944.831, p5: 29283.978, min: 5877.259 },
    fracPct: { p50: 16.637, p5: 10.017, min: 2.539 },
  },
  'morpho-steakhouse-usdc': {
    symbol: 'USDC',
    stressHours: 4953,
    cash: { p50: 15162686, p5: 5536955, min: 435797 },
    fracPct: { p50: 11.325, p5: 7.507, min: 0.734 },
  },
} as const satisfies Record<string, VenueStressCashLevels>

/** A summary.json venue id. */
export type ExitReadoutVenue = keyof typeof EXIT_READOUT_VENUE_LEVELS

export type ExitReadoutLevel = 'now' | 'p50' | 'p5' | 'min'

/** Display order: now first, then deeper into stress. */
export const EXIT_READOUT_LEVELS: readonly ExitReadoutLevel[] = ['now', 'p50', 'p5', 'min']

export function isExitReadoutVenue(v: string): v is ExitReadoutVenue {
  return Object.prototype.hasOwnProperty.call(EXIT_READOUT_VENUE_LEVELS, v)
}

/** The venue's reader-facing name ('Aave USDC'), from the engine's analog venue list. */
export function exitReadoutVenueName(v: ExitReadoutVenue): string {
  return EXIT_CAPACITY_ANALOG_VENUES.find((x) => x.venue === v)?.name ?? v
}

// ------------------------------------------------------------------ types

/** A 'now' reading, token units (history.json semantics: cash, supply, flags). */
export interface ExitNowReading {
  cash: number
  supply: number
  /** history.json `flags`; bit2 PAUSED makes f and cash 0. */
  flags?: number | null
  /** When it was read, ISO 8601. */
  asOf: string
}

export interface ExitReadoutOptions {
  /** USD per token. Needed for a non-stable venue (WETH); a stablecoin is $1. */
  priceUsd?: number
  /** The 'now' level's reading. */
  now?: ExitNowReading
  /** The time now, ms since epoch: ages the 'now' reading. */
  nowMs?: number
}

export interface ExitReadout {
  readonly kind: 'readout'
  readonly venue: ExitReadoutVenue
  readonly venueName: string
  readonly level: ExitReadoutLevel
  readonly depositUsd: number
  /** The venue's idle cash at the level, USD: the stock every recall in the 8 h draws from. */
  readonly cashUsd: number
  /** f = cash / supply at the level, in [0, 1]. */
  readonly fraction: number
  /** HEADLINE, cash vs book with the deposit as the book: min(deposit, cash). */
  readonly reachableUsd: number
  /** FLOOR, pro-rata (every depositor exits at once): deposit × f. */
  readonly floorUsd: number
  /** CROSSOVER: the deposit above which the headline binds. Equals `cashUsd`. */
  readonly crossoverUsd: number
  /** deposit > crossover: less than the whole deposit exits on the headline. */
  readonly binds: boolean
  /**
   * The floor pays more than the headline: deposit > cash / f. On 'now' that is a deposit
   * larger than the venue's whole supply, which the observed venue is no analog for. Flagged,
   * not dropped (owner ruling 2026-10-07, `bookExceedsVenue`).
   */
  readonly exceedsVenue: boolean
  /** 'now': the reading's time. A stress level: the end of the measured range. */
  readonly asOf: string
  /** Hours since the 'now' reading; null for a stress level. */
  readonly ageHours: number | null
}

export type ExitReadoutRefusal =
  | 'invalid_input'
  | 'unknown_venue'
  /** A non-stable venue with no `priceUsd`. */
  | 'no_price'
  /** 'now' with no reading passed in. */
  | 'no_reading'
  /** 'now' with a reading older than the freshness limit. */
  | 'stale'
  /** The reading's cash or supply is unknown. */
  | 'unknown_cash'

export interface ExitReadoutUnavailable {
  readonly kind: 'unavailable'
  readonly venue: string
  readonly level: ExitReadoutLevel
  readonly reason: ExitReadoutRefusal
  readonly detail: string
}

export type ExitReadoutResult = ExitReadout | ExitReadoutUnavailable

/** Oldest a 'now' reading may be, ms (measuredCapacity.ts rule 3: exactly the limit is fresh). */
export const EXIT_READOUT_MAX_AGE_MS = MEASURED_STALE_CADENCES * MEASURED_DEFAULT_CADENCE_MS

// --------------------------------------------------------------- function

const HOUR_MS = 3_600_000

/**
 * The reachable USD within 8 h of a deposit at a venue and stress level (module header): the
 * cash-vs-book headline, the pro-rata floor and the crossover deposit.
 */
export function exitReadout(
  depositUsd: number,
  venue: string,
  level: ExitReadoutLevel,
  opts: ExitReadoutOptions = {},
): ExitReadoutResult {
  const refuse = (reason: ExitReadoutRefusal, detail: string): ExitReadoutUnavailable => ({
    kind: 'unavailable',
    venue,
    level,
    reason,
    detail,
  })
  if (!(Number.isFinite(depositUsd) && depositUsd >= 0)) {
    return refuse('invalid_input', 'the deposit must be a USD amount ≥ 0')
  }
  if (!EXIT_READOUT_LEVELS.includes(level)) return refuse('invalid_input', `unknown level ${level}`)
  if (!isExitReadoutVenue(venue)) {
    return refuse('unknown_venue', `${venue} has no measured stress levels`)
  }
  const v: VenueStressCashLevels = EXIT_READOUT_VENUE_LEVELS[venue]

  let unitUsd = 1
  if (!VENUE_STABLE_SYMBOLS.includes(v.symbol)) {
    const p = opts.priceUsd
    if (p === undefined) return refuse('no_price', `${v.symbol} needs a USD price`)
    if (!(Number.isFinite(p) && p > 0)) return refuse('invalid_input', 'priceUsd must be > 0')
    unitUsd = p
  }

  let cash: number
  let f: number
  let asOf: string = EXIT_READOUT_SOURCE.to
  let ageHours: number | null = null
  if (level === 'now') {
    const r = opts.now
    if (!r) return refuse('no_reading', 'no live reading for this venue')
    const atMs = Date.parse(r.asOf)
    if (!Number.isFinite(atMs)) return refuse('invalid_input', 'the reading has no valid time')
    if (!(opts.nowMs !== undefined && Number.isFinite(opts.nowMs))) {
      return refuse('invalid_input', 'nowMs is needed to age the reading')
    }
    const ageMs = opts.nowMs - atMs
    if (ageMs < 0) return refuse('invalid_input', 'the reading is later than nowMs')
    if (ageMs > EXIT_READOUT_MAX_AGE_MS) {
      return refuse(
        'stale',
        `the reading is ${(ageMs / HOUR_MS).toFixed(1)} h old; the limit is ${EXIT_READOUT_MAX_AGE_MS / HOUR_MS} h`,
      )
    }
    const fr = withdrawableFraction(r.cash, r.supply, r.flags)
    if (fr === null) return refuse('unknown_cash', 'the reading has no known cash and supply')
    f = fr
    // A paused reserve answers nothing, whatever its balance (venueStressRules).
    cash = fr === 0 ? 0 : r.cash
    asOf = r.asOf
    ageHours = ageMs / HOUR_MS
  } else {
    cash = v.cash[level]
    f = Math.min(1, Math.max(0, v.fracPct[level] / 100))
  }

  const cashUsd = Math.max(0, cash) * unitUsd
  const d = depositUsd
  // cash vs book with the deposit as the book: D × m(D) = D × min(1, C / D) = min(D, C)
  const reachableUsd = Math.min(d, cashUsd)
  const floorUsd = d * f
  return {
    kind: 'readout',
    venue,
    venueName: exitReadoutVenueName(venue),
    level,
    depositUsd: d,
    cashUsd,
    fraction: f,
    reachableUsd,
    floorUsd,
    crossoverUsd: cashUsd,
    binds: d > cashUsd,
    exceedsVenue: floorUsd > reachableUsd,
    asOf,
    ageHours,
  }
}

/** The readout at every level, display order. */
export function exitReadoutLevels(
  depositUsd: number,
  venue: string,
  opts: ExitReadoutOptions = {},
): ExitReadoutResult[] {
  return EXIT_READOUT_LEVELS.map((l) => exitReadout(depositUsd, venue, l, opts))
}
