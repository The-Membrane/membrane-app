/**
 * exitReadout — the per-user exit readout: "of your $X deposited, $Y exits within 8 h", and
 * the CROSSOVER deposit above which exit capacity binds. PURE.
 *
 * The stress levels are the ENGINE'S (owner, 2026-10-12): each venue's stress events
 * (venueStressAnalogs.ts: the same windows, the 72 h merge, the 'held' basis with its 1 h
 * retry), read over the 8 h from onset. The cash levels are generated between the markers
 * below by scripts/position-sim/exit-readout-levels.ts --emit (stressEventCash.ts);
 * tests/unit/exitReadout.test.ts recomputes them from public/data/venue-stress and fails on
 * any drift. The floor is the engine's own floor preset (EXIT_CAPACITY_FLOOR_ROWS).
 *
 * LEVELS (nearest rank, as the engine presets)
 *   'typical'  the median stress event
 *   'bad'      the 10th-percentile event
 *   'worst'    the worst event
 *   'now'      one reading the caller passes in (cash and supply in token units, with its
 *              time). Refused as 'stale' when older than MEASURED_STALE_CADENCES × the 1 h
 *              cadence (measuredCapacity.ts rule 3): a stale reading is never shown as now.
 *
 * TWO MODELS (exitCapacityAnalogs.ts header, owner ruling 2026-10-07)
 *   HEADLINE  cash vs book with YOUR DEPOSIT as the book: D × m(D) = min(D, C). C is the
 *             venue's held idle cash over the 8 h at the level's event, events ranked on cash.
 *             Assumptions (i)–(iv) of that header hold: the deposit recalls at once at the
 *             onset; the cash is first come and already net of every other withdrawal in the
 *             hour; the recall does not start a run; the stock does not refill.
 *   FLOOR     pro-rata: every depositor exits at once, and the deposit gets f of itself,
 *             D × f, whatever its size. f is the engine's floor preset at the venue and level,
 *             events ranked on f, so the two models can name different events.
 *   CROSSOVER the headline binds above D* = C. At or below it the whole deposit exits on the
 *             headline. The floor binds at every size while f < 1.
 *   WITHIN 8 H the Membrane delay window. The engine draws one venue stock across it and never
 *             refills it (stressGrid.ts "MODELLED, NOT MASTER"). A level's cash is that stock.
 *
 * READING THE LEVELS
 *  - Cash and f are ranked separately. Each figure is its own model's level (the headline
 *    rises with C alone, the floor with f alone), but C / f is not the supply at a level.
 *  - SCALE (scripts/position-sim/stress-cash-scale-test.ts, pre-registered 2026-10-12): within
 *    a venue, event cash scales with supply, elasticity 1.01 (95% CI 0.84–1.17). So a level's
 *    cash describes the venue at its size then, not now. Out of sample, neither absolute cash
 *    nor f × the later supply predicts the later half well (mean |ln error| 1.70 and 1.60;
 *    9 and 6 cell wins): the share itself drifts between eras. The levels stay absolute, as
 *    the engine's cash vs book does. Rescaling is an owner decision.
 *  - Steakhouse USDC: its cash is the vault's pro-rata share of each Morpho market's idle cash
 *    (history.json `semantics.cash`), not first in line — conservative on (ii).
 *  - Stablecoins are held at $1 (VENUE_STABLE_SYMBOLS). WETH stays in ETH and needs
 *    `priceUsd` (the view passes the live Chainlink round, ethUsdSpot.ts), else there is no
 *    readout: unknown is unknown, never 0.
 *  - Descriptive history, not a forecast. No cash ÷ flow clock (board, 2026-09-27 EXIT
 *    CAPACITY PERSISTENCE).
 */

import {
  EXIT_CAPACITY_ANALOG_DATA_THROUGH,
  EXIT_CAPACITY_ANALOG_VENUES,
  EXIT_CAPACITY_FLOOR_ROWS,
} from './exitCapacityAnalogs'
import { MEASURED_DEFAULT_CADENCE_MS, MEASURED_STALE_CADENCES } from './measuredCapacity'
import type { ExitReadoutCashRow, StressEventLevel } from './stressEventCash'
import { VENUE_STABLE_SYMBOLS } from './venueStressAnalogs'
import { withdrawableFraction } from './venueStressRules'

// ------------------------------------------------------------------- data

export const EXIT_READOUT_SOURCE = {
  file: 'public/data/venue-stress/history.json',
  /** The history's first hour. */
  from: '2023-10-01T00:00Z',
  /** The history's last hour, the engine presets' too. */
  to: EXIT_CAPACITY_ANALOG_DATA_THROUGH,
} as const

// <generated:exit-readout-levels>
/** Held idle cash over the 8 h from onset at each venue's typical, bad (p10) and worst
 *  stress event, token units (WETH in ETH). 10 venues. */
export const EXIT_READOUT_VENUE_LEVELS = {
  'aave-core-usdc': {
    venue: 'aave-core-usdc',
    symbol: 'USDC',
    events: 33,
    cash8: {
      typical: {
        cash: 203125083,
        supply: 1527126779,
        event: 'Aave USDC, ETH -11% 2024-08-27',
        onset: '2024-08-27T22:00Z',
      },
      bad: {
        cash: 45158910,
        supply: 1018900472,
        event: 'Aave USDC, util ≥95% 2024-03-13',
        onset: '2024-03-13T03:00Z',
      },
      worst: {
        cash: 7085,
        supply: 2633752857,
        event: 'Aave USDC, Kelp Apr-2026',
        onset: '2026-04-19T04:00Z',
      },
    },
  },
  'aave-core-usdt': {
    venue: 'aave-core-usdt',
    symbol: 'USDT',
    events: 40,
    cash8: {
      typical: {
        cash: 293497196,
        supply: 2953126771,
        event: 'Aave USDT, ETH -16% 2024-12-19',
        onset: '2024-12-19T17:00Z',
      },
      bad: {
        cash: 39161517,
        supply: 446087153,
        event: 'Aave USDT, ETH -11.5% 2024-01-03',
        onset: '2024-01-03T12:00Z',
      },
      worst: {
        cash: 2648,
        supply: 3534374209,
        event: 'Aave USDT, Kelp Apr-2026',
        onset: '2026-04-19T01:00Z',
      },
    },
  },
  'aave-core-usde': {
    venue: 'aave-core-usde',
    symbol: 'USDe',
    events: 14,
    cash8: {
      typical: {
        cash: 152188792,
        supply: 819414970,
        event: 'Aave USDe, ETH -12.4% 2025-11-13',
        onset: '2025-11-13T18:00Z',
      },
      bad: {
        cash: 60399,
        supply: 1019549271,
        event: 'Aave USDe, Kelp Apr-2026',
        onset: '2026-04-19T08:42Z',
      },
      worst: {
        cash: 10149,
        supply: 193671195,
        event: 'Aave USDe, util ≥95% 2026-05-06',
        onset: '2026-05-06T18:53Z',
      },
    },
  },
  'morpho-steakhouse-usdc': {
    venue: 'morpho-steakhouse-usdc',
    symbol: 'USDC',
    events: 26,
    cash8: {
      typical: {
        cash: 15011500,
        supply: 163564600,
        event: 'Steakhouse USDC, ETH -11.5% 2025-06-13',
        onset: '2025-06-13T01:00Z',
      },
      bad: {
        cash: 2592825,
        supply: 53923963,
        event: 'Steakhouse USDC, util ≥95% 2024-11-09',
        onset: '2024-11-09T07:00Z',
      },
      worst: {
        cash: 1668478,
        supply: 58109859,
        event: 'Steakhouse USDC, util ≥95% 2024-11-19',
        onset: '2024-11-19T05:00Z',
      },
    },
  },
  'spark-usdc': {
    venue: 'spark-usdc',
    symbol: 'USDC',
    events: 9,
    cash8: {
      typical: {
        cash: 7943928,
        supply: 50001235,
        event: 'Spark USDC, ETH -10.4% 2025-12-01',
        onset: '2025-12-01T15:00Z',
      },
      bad: {
        cash: 1900325,
        supply: 51464085,
        event: 'Spark USDC, util ≥95% 2025-04-16',
        onset: '2025-04-16T09:00Z',
      },
      worst: {
        cash: 1900325,
        supply: 51464085,
        event: 'Spark USDC, util ≥95% 2025-04-16',
        onset: '2025-04-16T09:00Z',
      },
    },
  },
  'spark-usdt': {
    venue: 'spark-usdt',
    symbol: 'USDT',
    events: 12,
    cash8: {
      typical: {
        cash: 25871043,
        supply: 297929541,
        event: 'Spark USDT, ETH -10.4% 2025-12-01',
        onset: '2025-12-01T15:00Z',
      },
      bad: {
        cash: 4377,
        supply: 403348520,
        event: 'Spark USDT, util ≥99% 2026-05-20',
        onset: '2026-05-20T09:00Z',
      },
      worst: {
        cash: 4320,
        supply: 457784663,
        event: 'Spark USDT, util ≥99% 2026-05-08',
        onset: '2026-05-08T11:00Z',
      },
    },
  },
  'spark-dai': {
    venue: 'spark-dai',
    symbol: 'DAI',
    events: 42,
    cash8: {
      typical: {
        cash: 60701401,
        supply: 1108999501,
        event: 'Spark DAI, ETH -29.3% 2025-02-02',
        onset: '2025-02-02T22:00Z',
      },
      bad: {
        cash: 6163,
        supply: 872957474,
        event: 'Spark DAI, util ≥99% 2024-01-30',
        onset: '2024-01-30T10:00Z',
      },
      worst: {
        cash: 0,
        supply: 1135498330,
        event: 'Spark DAI, util ≥99% 2024-10-31',
        onset: '2024-10-31T23:00Z',
      },
    },
  },
  'spark-usds': {
    venue: 'spark-usds',
    symbol: 'USDS',
    events: 12,
    cash8: {
      typical: {
        cash: 99471850,
        supply: 434503163,
        event: 'Spark USDS, ETH -10.1% 2026-02-03',
        onset: '2026-02-05T15:00Z',
      },
      bad: {
        cash: 48641475,
        supply: 146023890,
        event: 'Spark USDS, ETH -10.4% 2025-12-01',
        onset: '2025-12-01T15:00Z',
      },
      worst: {
        cash: 30604856,
        supply: 95889233,
        event: 'Spark USDS, Kelp Apr-2026',
        onset: '2026-04-18T20:00Z',
      },
    },
  },
  'aave-core-weth': {
    venue: 'aave-core-weth',
    symbol: 'WETH',
    events: 31,
    cash8: {
      typical: {
        cash: 205795.505,
        supply: 1854186.052,
        event: 'Aave WETH, ETH -29.3% 2025-02-02',
        onset: '2025-02-02T22:00Z',
      },
      bad: {
        cash: 94999.666,
        supply: 1025742.058,
        event: 'Aave WETH, Aug-2024 yen-carry unwind',
        onset: '2024-08-05T00:00Z',
      },
      worst: {
        cash: 0.008,
        supply: 2711287.683,
        event: 'Aave WETH, Kelp Apr-2026',
        onset: '2026-04-18T20:00Z',
      },
    },
  },
  'spark-weth': {
    venue: 'spark-weth',
    symbol: 'WETH',
    events: 29,
    cash8: {
      typical: {
        cash: 55859.674,
        supply: 350368.714,
        event: 'Spark WETH, ETH -14.8% 2025-02-24',
        onset: '2025-02-24T22:00Z',
      },
      bad: {
        cash: 32333.994,
        supply: 306243.97,
        event: 'Spark WETH, ETH -29.3% 2025-02-02',
        onset: '2025-02-02T22:00Z',
      },
      worst: {
        cash: 8172.561,
        supply: 254803.479,
        event: 'Spark WETH, Kelp Apr-2026',
        onset: '2026-04-18T20:00Z',
      },
    },
  },
} as const satisfies Record<string, ExitReadoutCashRow>
// </generated:exit-readout-levels>

/** A history.json venue id with readout levels. */
export type ExitReadoutVenue = keyof typeof EXIT_READOUT_VENUE_LEVELS

export type ExitReadoutLevel = 'now' | StressEventLevel

/** Display order: now first, then deeper into stress. */
export const EXIT_READOUT_LEVELS: readonly ExitReadoutLevel[] = ['now', 'typical', 'bad', 'worst']

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
   * The deposit is larger than the venue's whole supply at the level's event (on 'now', at the
   * reading). The observed venue is no analog for it: if the deposit had been in it, it would
   * have been a different venue. Flagged, not dropped (owner ruling 2026-10-07,
   * `bookExceedsVenue`).
   */
  readonly exceedsVenue: boolean
  /** The venue's supply at the level's event or the reading, USD. */
  readonly supplyUsd: number
  /** 'now': the reading's time. A stress level: the end of the measured range. */
  readonly asOf: string
  /** Hours since the 'now' reading; null for a stress level. */
  readonly ageHours: number | null
  /** The headline's event ('Aave USDC, Kelp Apr-2026'); null for 'now'. */
  readonly event: string | null
  /** The floor's event, which can differ (module header); null for 'now'. */
  readonly floorEvent: string | null
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
  const v: ExitReadoutCashRow = EXIT_READOUT_VENUE_LEVELS[venue]

  let unitUsd = 1
  if (!VENUE_STABLE_SYMBOLS.includes(v.symbol)) {
    const p = opts.priceUsd
    if (p === undefined) return refuse('no_price', `${v.symbol} needs a USD price`)
    if (!(Number.isFinite(p) && p > 0)) return refuse('invalid_input', 'priceUsd must be > 0')
    unitUsd = p
  }

  let cash: number
  let supply: number
  let f: number
  let asOf: string = EXIT_READOUT_SOURCE.to
  let event: string | null = null
  let floorEvent: string | null = null
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
    supply = r.supply
    asOf = r.asOf
    ageHours = ageMs / HOUR_MS
  } else {
    const floor = EXIT_CAPACITY_FLOOR_ROWS.find((r) => r.venue === venue && r.level === level)
    if (!floor) return refuse('unknown_venue', `${venue} has no engine floor at ${level}`)
    cash = v.cash8[level].cash
    supply = v.cash8[level].supply
    event = v.cash8[level].event
    f = Math.min(1, Math.max(0, floor.mult))
    floorEvent = `${floor.venueName}, ${floor.event}`
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
    exceedsVenue: d > supply * unitUsd,
    supplyUsd: supply * unitUsd,
    asOf,
    ageHours,
    event,
    floorEvent,
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
