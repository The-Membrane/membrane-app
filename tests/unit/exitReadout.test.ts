/**
 * exitReadout — the per-user exit readout (lib/position-sim/exitReadout.ts) and its view
 * (components/RiskFrontier/viewModel.ts `exitReadoutView`). Pinned on the real
 * public/data/venue-stress/{summary,history}.json: the generated levels must equal a fresh
 * run of the engine's events (stressEventCash.ts), and the 'now' cases use the last real
 * reading of history.json. Expected figures are computed by hand from the levels and the
 * engine floor rows, not copied from the code's output.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_INPUTS,
  EXIT_READOUT_FOOTNOTE,
  computeFrontier,
  exitReadoutVenueOf,
  exitReadoutView,
  sandboxExitReadout,
  usdDown,
  type SandboxInputs,
} from '@/components/RiskFrontier/viewModel'
import {
  EXIT_CAPACITY_ANALOG_VENUES,
  EXIT_CAPACITY_FLOOR_ROWS,
} from '@/lib/position-sim/exitCapacityAnalogs'
import {
  EXIT_READOUT_LEVELS,
  EXIT_READOUT_MAX_AGE_MS,
  EXIT_READOUT_SOURCE,
  EXIT_READOUT_VENUE_LEVELS,
  exitReadout,
  exitReadoutLevels,
  type ExitReadout,
  type ExitReadoutResult,
  type ExitReadoutVenue,
} from '@/lib/position-sim/exitReadout'
import {
  ETH_USD_FEED,
  ETH_USD_MAX_AGE_MS,
  decodeEthUsdRound,
  ethUsdFresh,
  type EthUsdSpot,
} from '@/lib/position-sim/ethUsdSpot'
import { STRESS_EVENT_LEVELS, exitReadoutCashRows } from '@/lib/position-sim/stressEventCash'
import {
  VENUE_DEFAULT_STRESS_UTIL,
  VENUE_LOCK_F,
  stressWindowsFromEpisodes,
  utilWindowsFromSeries,
  venueSeriesFromHistory,
  type VenueStressEpisode,
  type VenueStressHistoryFile,
} from '@/lib/position-sim/venueStressAnalogs'

const DATA = path.resolve(__dirname, '../../public/data/venue-stress')
const read = (f: string) => JSON.parse(readFileSync(path.join(DATA, f), 'utf8'))

const history = read('history.json') as VenueStressHistoryFile & {
  startTs: number
  venues: Record<string, { cash: number[]; supply: number[]; flags: number[] }>
}
const summary = read('summary.json') as {
  method: { minSize: Record<string, number>; stressUtil: Record<string, number> }
  episodes: VenueStressEpisode[]
}

const VENUES = Object.keys(EXIT_READOUT_VENUE_LEVELS) as ExitReadoutVenue[]
const ETH_USD = 2_500

function ok(r: ExitReadoutResult): ExitReadout {
  if (r.kind !== 'readout') throw new Error(`expected a readout, got ${r.reason}: ${r.detail}`)
  return r
}

const priceFor = (v: ExitReadoutVenue) =>
  EXIT_READOUT_VENUE_LEVELS[v].symbol === 'WETH' ? { priceUsd: ETH_USD } : {}

const floorF = (venue: string, level: string) =>
  EXIT_CAPACITY_FLOOR_ROWS.find((r) => r.venue === venue && r.level === level)!.mult

/**
 * A real Chainlink ETH/USD round: `latestRoundData()` on the mainnet proxy, read 2026-10-12
 * 01:39 UTC through ethereum-rpc.publicnode.com and the Tenderly gateway (both agreed):
 * answer 254758984536 at 8 decimals = $2,547.58984536, updatedAt 2026-10-12T01:06:11Z.
 */
const REAL_ROUND = [
  129127208515966895839n,
  254758984536n,
  1791767149n,
  1791767171n,
  129127208515966895839n,
] as const
const SPOT = decodeEthUsdRound(REAL_ROUND, 8) as EthUsdSpot
const SPOT_AT = SPOT.updatedAtMs
const viewOpts = { ethUsd: SPOT, nowMs: SPOT_AT + 600_000 }

// ---------------------------------------------------------------- the data

describe("exit readout levels are the engine's events", () => {
  it('a fresh run on the history gives the generated levels exactly', () => {
    const series = venueSeriesFromHistory(history, { minSize: summary.method.minSize })
    const derivedUtil = series
      .filter((s) => summary.method.stressUtil[s.venue] === undefined)
      .flatMap((s) => utilWindowsFromSeries(s, VENUE_DEFAULT_STRESS_UTIL))
    const windows = stressWindowsFromEpisodes(summary.episodes, derivedUtil)
    const rows = exitReadoutCashRows(series, windows, EXIT_CAPACITY_ANALOG_VENUES)
    expect(Object.fromEntries(rows.map((r) => [r.venue, r]))).toEqual(EXIT_READOUT_VENUE_LEVELS)
  })

  it('covers every engine venue, with the same event count as its floor rows', () => {
    expect(VENUES).toEqual(EXIT_CAPACITY_ANALOG_VENUES.map((v) => v.venue))
    for (const v of VENUES) {
      expect(EXIT_READOUT_VENUE_LEVELS[v].events).toBe(
        EXIT_CAPACITY_FLOOR_ROWS.find((r) => r.venue === v)!.n,
      )
    }
  })

  it('names the history it was measured on', () => {
    expect(EXIT_READOUT_SOURCE.from).toBe(
      new Date(history.startTs * 1000).toISOString().slice(0, 16) + 'Z',
    )
    const t = history.timeline.t
    expect(EXIT_READOUT_SOURCE.to).toBe(
      new Date(t[t.length - 1] * 1000).toISOString().slice(0, 16) + 'Z',
    )
  })

  it('cash never rises into deeper stress', () => {
    for (const v of VENUES) {
      const c = EXIT_READOUT_VENUE_LEVELS[v].cash8
      expect(c.bad.cash).toBeLessThanOrEqual(c.typical.cash)
      expect(c.worst.cash).toBeLessThanOrEqual(c.bad.cash)
    }
  })
})

// ------------------------------------------------------------ the function

describe('exitReadout on the engine levels', () => {
  it('Aave USDC typical, $14,200: the whole deposit exits; the floor is the engine floor', () => {
    const r = ok(exitReadout(14_200, 'aave-core-usdc', 'typical'))
    expect(r.cashUsd).toBe(203_125_083)
    expect(r.reachableUsd).toBe(14_200)
    expect(floorF('aave-core-usdc', 'typical')).toBe(0.1119)
    expect(r.floorUsd).toBeCloseTo(1_588.98, 6)
    expect(r.crossoverUsd).toBe(203_125_083)
    expect(r.binds).toBe(false)
    expect(r.exceedsVenue).toBe(false)
    expect(r.supplyUsd).toBe(1_527_126_779)
    expect(r.event).toBe('Aave USDC, ETH -11% 2024-08-27')
    expect(r.floorEvent).toBe('Aave USDC, ETH -13.3% 2026-06-05')
    expect(r.asOf).toBe('2026-10-07T01:00Z')
    expect(r.ageHours).toBeNull()
  })

  it('Aave USDC typical, $500M: binds at the venue cash', () => {
    const r = ok(exitReadout(500_000_000, 'aave-core-usdc', 'typical'))
    expect(r.reachableUsd).toBe(203_125_083)
    expect(r.floorUsd).toBeCloseTo(55_950_000, 4)
    expect(r.binds).toBe(true)
  })

  it('the crossover is the size above which the headline binds', () => {
    for (const v of VENUES) {
      for (const level of STRESS_EVENT_LEVELS) {
        const x = ok(exitReadout(0, v, level, priceFor(v))).crossoverUsd
        const at = ok(exitReadout(x, v, level, priceFor(v)))
        expect(at.binds).toBe(false)
        expect(at.reachableUsd).toBe(x)
        const above = ok(exitReadout(x + 1, v, level, priceFor(v)))
        expect(above.binds).toBe(true)
        expect(above.reachableUsd).toBe(x)
      }
    }
  })

  it('deeper stress never reaches more; the floor too, outside the locked ties', () => {
    for (const v of VENUES) {
      for (const d of [1e4, 1e6, 2e7, 1e8, 1e9]) {
        const [typ, bad, worst] = STRESS_EVENT_LEVELS.map((l) =>
          ok(exitReadout(d, v, l, priceFor(v))),
        )
        expect(bad.reachableUsd).toBeLessThanOrEqual(typ.reachableUsd)
        expect(worst.reachableUsd).toBeLessThanOrEqual(bad.reachableUsd)
        expect(bad.floorUsd).toBeLessThanOrEqual(typ.floorUsd)
        // the engine orders locked events (f ≤ 1%) by lock length, not f (venueStressAnalogs)
        if (bad.fraction > VENUE_LOCK_F) expect(worst.floorUsd).toBeLessThanOrEqual(bad.floorUsd)
      }
    }
  })

  it('the floor stays under the headline up to the crossover', () => {
    for (const v of VENUES) {
      for (const level of STRESS_EVENT_LEVELS) {
        const x = ok(exitReadout(0, v, level, priceFor(v))).crossoverUsd
        for (const d of [Math.min(1, x), x / 2, x]) {
          const r = ok(exitReadout(d, v, level, priceFor(v)))
          expect(r.floorUsd).toBeLessThanOrEqual(r.reachableUsd + 1e-9)
        }
      }
    }
  })

  it("flags a deposit above the event's supply (Spark USDC typical: $50,001,235)", () => {
    expect(ok(exitReadout(60_000_000, 'spark-usdc', 'typical')).exceedsVenue).toBe(true)
    expect(ok(exitReadout(50_001_235, 'spark-usdc', 'typical')).exceedsVenue).toBe(false)
  })

  it('Spark DAI worst event: no cash, so any deposit binds and nothing exits', () => {
    const r = ok(exitReadout(1_000, 'spark-dai', 'worst'))
    expect(r.cashUsd).toBe(0)
    expect(r.crossoverUsd).toBe(0)
    expect(r.reachableUsd).toBe(0)
    expect(r.floorUsd).toBeCloseTo(1_000 * 0.0005, 9)
    expect(r.binds).toBe(true)
    // the floor's event differs and pays a little: that is not a size the venue cannot hold
    expect(r.exceedsVenue).toBe(false)
    expect(ok(exitReadout(0, 'spark-dai', 'worst')).binds).toBe(false)
  })

  it('Aave USDe has levels from its reused grid', () => {
    const r = ok(exitReadout(1e6, 'aave-core-usde', 'typical'))
    expect(r.cashUsd).toBe(152_188_792)
    expect(r.fraction).toBe(0.2302)
  })

  it('WETH needs a price; with one, ETH cash is priced in USD', () => {
    const none = exitReadout(1e6, 'aave-core-weth', 'typical')
    expect(none).toMatchObject({ kind: 'unavailable', reason: 'no_price' })
    const r = ok(exitReadout(1e6, 'aave-core-weth', 'typical', { priceUsd: ETH_USD }))
    expect(r.cashUsd).toBeCloseTo(205_795.505 * ETH_USD, 6)
    expect(r.floorUsd).toBeCloseTo(130_100, 6)
    expect(exitReadout(1e6, 'aave-core-weth', 'typical', { priceUsd: 0 })).toMatchObject({
      reason: 'invalid_input',
    })
  })

  it('refuses bad input and venues with no stress levels', () => {
    for (const d of [-1, NaN, Infinity]) {
      expect(exitReadout(d, 'aave-core-usdc', 'typical')).toMatchObject({
        reason: 'invalid_input',
      })
    }
    expect(exitReadout(1, 'compound-usdc', 'typical')).toMatchObject({ reason: 'unknown_venue' })
  })
})

// ------------------------------------------------------------------- 'now'

describe("exitReadout 'now' on the last real reading", () => {
  const last = history.timeline.t.length - 1
  const at = history.timeline.t[last] * 1000
  const reading = (venue: string, flags?: number) => ({
    cash: history.venues[venue].cash[last],
    supply: history.venues[venue].supply[last],
    flags: flags ?? history.venues[venue].flags[last],
    asOf: new Date(at).toISOString(),
  })

  it('reads cash and f from one reading', () => {
    const now = reading('aave-core-usdc')
    const r = ok(exitReadout(14_200, 'aave-core-usdc', 'now', { now, nowMs: at + 3_600_000 }))
    expect(r.asOf).toBe('2026-10-07T01:00:00.000Z')
    expect(r.cashUsd).toBe(143_917_296)
    expect(r.fraction).toBeCloseTo(143_917_296 / 2_395_061_114, 12)
    expect(r.reachableUsd).toBe(14_200)
    expect(r.crossoverUsd).toBe(143_917_296)
    expect(r.ageHours).toBe(1)
    expect(r.event).toBeNull()
    // one reading: the flag fires above its supply, $2,395,061,114
    expect(ok(exitReadout(2.4e9, 'aave-core-usdc', 'now', { now, nowMs: at })).exceedsVenue).toBe(
      true,
    )
    expect(ok(exitReadout(2.39e9, 'aave-core-usdc', 'now', { now, nowMs: at })).exceedsVenue).toBe(
      false,
    )
  })

  it('is fresh up to exactly the limit, stale past it', () => {
    const now = reading('aave-core-usdc')
    expect(EXIT_READOUT_MAX_AGE_MS).toBe(2 * 3_600_000)
    expect(
      exitReadout(1, 'aave-core-usdc', 'now', { now, nowMs: at + EXIT_READOUT_MAX_AGE_MS }).kind,
    ).toBe('readout')
    expect(
      exitReadout(1, 'aave-core-usdc', 'now', { now, nowMs: at + EXIT_READOUT_MAX_AGE_MS + 1 }),
    ).toMatchObject({ kind: 'unavailable', reason: 'stale' })
  })

  it('needs a reading and the time now', () => {
    expect(exitReadout(1, 'aave-core-usdc', 'now')).toMatchObject({ reason: 'no_reading' })
    const now = reading('aave-core-usdc')
    expect(exitReadout(1, 'aave-core-usdc', 'now', { now })).toMatchObject({
      reason: 'invalid_input',
    })
    expect(exitReadout(1, 'aave-core-usdc', 'now', { now, nowMs: at - 1 })).toMatchObject({
      reason: 'invalid_input',
    })
  })

  it('a paused reserve answers nothing', () => {
    const now = reading('aave-core-usdc', 4)
    const r = ok(exitReadout(14_200, 'aave-core-usdc', 'now', { now, nowMs: at }))
    expect(r.cashUsd).toBe(0)
    expect(r.reachableUsd).toBe(0)
    expect(r.floorUsd).toBe(0)
    expect(r.binds).toBe(true)
  })

  it('prices a WETH reading', () => {
    const now = reading('spark-weth')
    const r = ok(exitReadout(1e6, 'spark-weth', 'now', { now, nowMs: at, priceUsd: ETH_USD }))
    expect(r.cashUsd).toBeCloseTo(128_670.179 * ETH_USD, 6)
    expect(r.fraction).toBeCloseTo(128_670.179 / 629_576.977, 12)
  })

  it('exitReadoutLevels gives every level in display order', () => {
    const rs = exitReadoutLevels(14_200, 'aave-core-usdc')
    expect(rs.map((r) => r.level)).toEqual(EXIT_READOUT_LEVELS)
    expect(rs[0]).toMatchObject({ kind: 'unavailable', reason: 'no_reading' })
  })
})

// ------------------------------------------------------------------- view

describe('exitReadoutView', () => {
  it('rounds toward risk', () => {
    expect(usdDown(203_125_083)).toBe('$203M')
    expect(usdDown(2_399_999_999)).toBe('$2.3B')
    expect(usdDown(7_943_928)).toBe('$7.9M')
    expect(usdDown(1_588.98)).toBe('$1,588')
    expect(usdDown(7_085)).toBe('$7,085')
    expect(usdDown(0.4)).toBe('none')
    expect(usdDown(0)).toBe('none')
    expect(usdDown(null)).toBe('—')
  })

  it('states the §5b sentence: no limit at your size, binds above the crossover', () => {
    const v = exitReadoutView(14_200, 'aave-core-usdc')
    expect(v.lead).toBe('In stress, exits shrink to $203M.')
    expect(v.detail).toBe('No limit at your size; binds above $203M.†')
    expect(v.floorLine).toBe('If every depositor exits at once: $1,588 of your $14,200.†')
    expect(v.crossoverUsd).toBe(203_125_083)
    expect(v.footnote).toBe(EXIT_READOUT_FOOTNOTE)
    expect(v.credit).toBe(
      'Idle cash in the first 8h of stress events, Aave USDC, 2023-10 → 2026-10. Measured history, not a forecast.',
    )
    expect(v.missing).toBeNull()
  })

  it('says how much exits when it binds', () => {
    const v = exitReadoutView(500_000_000, 'aave-core-usdc')
    expect(v.detail).toBe('Binds at your size: $203M of your $500M exits within 8h.†')
    expect(v.floorLine).toBe('If every depositor exits at once: $55M of your $500M.†')
  })

  it('gives the crossover alone with no deposit', () => {
    const v = exitReadoutView(0, 'aave-core-usdc')
    expect(v.detail).toBe('Binds above $203M.†')
    expect(v.floorLine).toBeNull()
  })

  it('flags a size the venue history does not cover', () => {
    const v = exitReadoutView(200_000_000, 'spark-usdc')
    expect(v.detail).toBe(
      "Binds at your size: $7.9M of your $200M exits within 8h.† Your size exceeds this venue's history.",
    )
  })

  it('has one row per level; the now row says there is no reading', () => {
    const v = exitReadoutView(14_200, 'aave-core-usdc')
    expect(v.rows.map((r) => r.label)).toEqual([
      'now',
      'typical stress event',
      'bad stress event (p10)',
      'worst stress event',
    ])
    expect(v.rows[0].missing).toBe('no live reading for this venue')
    expect(v.rows.slice(1).map((r) => [r.cash, r.reachable, r.floor, r.binds])).toEqual([
      ['$203M', '$14,200 of $14,200', '$1,588', false],
      ['$45M', '$14,200 of $14,200', '$555', false],
      ['$7,085', '$7,085 of $14,200', 'none', true],
    ])
  })

  it('shows a fresh now row with its time and withholds a stale one', () => {
    const now = { cash: 143_917_296, supply: 2_395_061_114, asOf: '2026-10-07T01:00:00.000Z' }
    const at = Date.parse(now.asOf)
    const fresh = exitReadoutView(14_200, 'aave-core-usdc', { now, nowMs: at + 600_000 })
    expect(fresh.rows[0]).toMatchObject({ label: 'now · 01:00 UTC', cash: '$143M', missing: null })
    const stale = exitReadoutView(14_200, 'aave-core-usdc', { now, nowMs: at + 5 * 3_600_000 })
    expect(stale.rows[0].label).toBe('now')
    expect(stale.rows[0].missing).toBe('the reading is 5.0 h old; the limit is 2 h')
    expect(stale.lead).toBe('In stress, exits shrink to $203M.')
  })

  it('withholds the sentence where it cannot be measured', () => {
    expect(exitReadoutView(1e6, null).missing).toBe(
      'no venue chosen: the exit readout needs a measured venue',
    )
    expect(exitReadoutView(1e6, 'compound-usdc').missing).toBe(
      'no measured stress levels for compound-usdc',
    )
    const weth = exitReadoutView(1e6, 'aave-core-weth')
    expect(weth.lead).toBeNull()
    expect(weth.missing).toBe('no ETH price yet')
    expect(weth.rows.map((r) => r.missing)).toEqual(Array(4).fill('no ETH price yet'))
  })

  it('never uses a verdict word or a bare 0', () => {
    for (const v of VENUES) {
      for (const d of [0, 14_200, 5e6, 5e7, 5e8]) {
        const view = exitReadoutView(d, v, viewOpts)
        const text = [
          view.lead,
          view.detail,
          view.floorLine,
          ...view.rows.flatMap((r) => [r.cash, r.reachable, r.floor]),
        ].join(' ')
        expect(text).not.toMatch(/\$0\b|\b0%|\bsafe\b|\bok\b|\bgood\b|\bfree\b/i)
      }
    }
  })
})

describe('computeFrontier exposes the readout', () => {
  it('runs the default position at its venue: Aave USDC, $14,200 deployed', () => {
    expect(exitReadoutVenueOf(DEFAULT_INPUTS.capacity)).toBe('aave-core-usdc')
    const m = computeFrontier(DEFAULT_INPUTS, null, undefined, () => 0)
    expect(m.exit.venue).toBe('aave-core-usdc')
    expect(m.exit.depositUsd).toBe(14_200)
    expect(m.exit.lead).toBe('In stress, exits shrink to $203M.')
    expect(m.exit.detail).toBe('No limit at your size; binds above $203M.†')
  })

  it('a custom multiple or a levered long names no venue', () => {
    const custom: SandboxInputs = { ...DEFAULT_INPUTS, capacity: { kind: 'custom', mult: 0.5 } }
    expect(computeFrontier(custom, null, undefined, () => 0).exit.missing).toBe(
      'no venue chosen: the exit readout needs a measured venue',
    )
    const long: SandboxInputs = { ...DEFAULT_INPUTS, tradeShape: 'levered_long' }
    expect(computeFrontier(long, null, undefined, () => 0).exit.missing).toBe(
      'no venue (levered long)',
    )
  })
})

describe('ETH/USD spot (Chainlink) prices a WETH venue', () => {
  it('decodes the real round', () => {
    expect(ETH_USD_FEED).toBe('0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419')
    expect(SPOT.priceUsd).toBe(2547.58984536)
    expect(new Date(SPOT.updatedAtMs).toISOString()).toBe('2026-10-12T01:06:11.000Z')
    expect(SPOT.roundId).toBe(129127208515966895839n)
    expect(SPOT.source).toBe('Chainlink ETH/USD')
  })

  it('refuses a round with no price, never $0', () => {
    expect(decodeEthUsdRound([1n, 0n, 1n, 1n, 1n], 8)).toBeNull()
    expect(decodeEthUsdRound([1n, -5n, 1n, 1n, 1n], 8)).toBeNull()
    expect(decodeEthUsdRound([1n, 5n, 1n, 0n, 1n], 8)).toBeNull()
    expect(decodeEthUsdRound(REAL_ROUND, -1)).toBeNull()
  })

  it('is fresh up to exactly 2 × the 1 h heartbeat', () => {
    expect(ETH_USD_MAX_AGE_MS).toBe(2 * 3_600_000)
    expect(ethUsdFresh(SPOT, SPOT_AT + ETH_USD_MAX_AGE_MS)).toBe(true)
    expect(ethUsdFresh(SPOT, SPOT_AT + ETH_USD_MAX_AGE_MS + 1)).toBe(false)
    expect(ethUsdFresh(SPOT, SPOT_AT - 1)).toBe(false)
  })

  it('a fresh price gives the WETH readout and names its source', () => {
    const v = exitReadoutView(1e6, 'aave-core-weth', viewOpts)
    // typical stress cash 205,795.505 WETH × $2,547.58984536 = $524,282,538.76
    expect(v.crossoverUsd).toBeCloseTo(524_282_538.7587, 3)
    expect(v.lead).toBe('In stress, exits shrink to $524M.')
    expect(v.detail).toBe('No limit at your size; binds above $524M.†')
    expect(v.floorLine).toBe('If every depositor exits at once: $130,100 of your $1.0M.†')
    expect(v.credit).toBe(
      'Idle cash in the first 8h of stress events, Aave WETH, 2023-10 → 2026-10. Measured history, not a forecast. ETH $2,548 · Chainlink ETH/USD · 01:06 UTC.',
    )
    // bad 94,999.666 × P = $242.0M; worst 0.008 × P = $20.38
    expect(v.rows.slice(1).map((r) => r.cash)).toEqual(['$524M', '$242M', '$20'])
  })

  it('a stale or undated price is withheld, with its age', () => {
    const stale = exitReadoutView(1e6, 'aave-core-weth', {
      ethUsd: SPOT,
      nowMs: SPOT_AT + 3 * 3_600_000,
    })
    expect(stale.lead).toBeNull()
    expect(stale.missing).toBe('the ETH price is 3.0 h old; the limit is 2 h')
    expect(stale.credit).not.toContain('ETH $')
    expect(exitReadoutView(1e6, 'aave-core-weth', { ethUsd: SPOT }).missing).toBe(
      'the ETH price needs the time now',
    )
    expect(
      exitReadoutView(1e6, 'aave-core-weth', { ethUsd: SPOT, nowMs: SPOT_AT - 1 }).missing,
    ).toBe('the ETH price is later than the time now')
  })

  it('a stablecoin venue ignores the ETH price', () => {
    const v = exitReadoutView(14_200, 'aave-core-usdc', viewOpts)
    expect(v.lead).toBe('In stress, exits shrink to $203M.')
    expect(v.credit).not.toContain('ETH $')
  })

  it('sandboxExitReadout prices the sandbox at an ETH venue', () => {
    const inputs: SandboxInputs = {
      ...DEFAULT_INPUTS,
      capacity: { kind: 'preset', preset: 'aave-weth-50m-typical' },
    }
    expect(computeFrontier(inputs, null, undefined, () => 0).exit.missing).toBe('no ETH price yet')
    const v = sandboxExitReadout(inputs, viewOpts)
    expect(v.venue).toBe('aave-core-weth')
    expect(v.depositUsd).toBe(14_200)
    expect(v.detail).toBe('No limit at your size; binds above $524M.†')
  })
})
