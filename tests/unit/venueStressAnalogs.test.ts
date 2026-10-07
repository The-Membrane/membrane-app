/**
 * venueStressAnalogs — measured venue exit-capacity analogs (lib/position-sim/venueStressAnalogs.ts).
 * Synthetic series pin every definition in the module header; the last block pins the
 * headline facts on the real history (skipped when public/data/venue-stress is absent).
 */
import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { indexAt, primaryGrid, type PriceHistoryFile } from '@/lib/position-sim/drawdowns'
import {
  EXIT_CAPACITY_ANALOG_DATA_THROUGH,
  EXIT_CAPACITY_ANALOG_ROWS,
  EXIT_CAPACITY_ANALOG_VENUES,
} from '@/lib/position-sim/exitCapacityAnalogs'
import { MEASURED_DESCRIPTIVE_LABEL } from '@/lib/position-sim/measuredCapacity'
import {
  VENUE_ANALOG_BOUNDS,
  VENUE_ANALOG_DEFAULT_BASIS,
  VENUE_ANALOG_PRESET_ORDER,
  analogExitCapacityUsd,
  exitCapacityAnalogRows,
  nearestRankIndex,
  stressWindowsFromEpisodes,
  utilWindowsFromSeries,
  venueSeriesFromHistory,
  venueStressAnalogs,
  venueStressEvents,
  venueWindows,
  windowMetrics,
  withdrawableFraction,
  type StressWindow,
  type VenueSeries,
  type VenueStressEpisode,
  type VenueStressHistoryFile,
  type WindowMetrics,
} from '@/lib/position-sim/venueStressAnalogs'

// ------------------------------------------------------------------ fixtures

const H = 3600
const T0 = Date.UTC(2026, 0, 1) / 1000 // 2026-01-01T00:00Z
const iso = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 16) + 'Z'

/** A series of f values, one reading every `stepH` from `start`. supply is constant. */
function series(
  fs: readonly (number | null)[],
  o: {
    venue?: string
    symbol?: string
    stepH?: number
    start?: number
    supply?: number
    minSize?: number
    flags?: (number | null)[]
  } = {},
): VenueSeries {
  const supply = o.supply ?? 1_000_000
  const stepH = o.stepH ?? 1
  const start = o.start ?? T0
  return {
    venue: o.venue ?? 'aave-core-usdc',
    symbol: o.symbol ?? 'USDC',
    name: 'Test USDC',
    t: fs.map((_, i) => start + i * stepH * H),
    cash: fs.map((f) => (f === null ? null : f * supply)),
    supply: fs.map((f) => (f === null ? null : supply)),
    ...(o.flags ? { flags: o.flags } : {}),
    ...(o.minSize !== undefined ? { minSize: o.minSize } : {}),
  }
}

const fill = (n: number, f: number) => new Array<number>(n).fill(f)

function metrics(s: VenueSeries, onset = T0, opts = {}): WindowMetrics {
  const m = windowMetrics(s, onset, opts)
  if ('skip' in m) throw new Error(`skipped: ${m.skip}`)
  return m
}

function win(
  id: string,
  onsetSec: number,
  o: { trigger?: StressWindow['trigger']; venue?: string | null; shortLabel?: string } = {},
): StressWindow {
  const trigger = o.trigger ?? 'eth-drop'
  return {
    id,
    trigger,
    label: `${id} label`,
    shortLabel: o.shortLabel ?? id,
    venue: o.venue ?? (trigger === 'util' ? 'aave-core-usdc' : null),
    onsetSec,
    onsetBasis:
      trigger === 'util'
        ? 'util-first-reading'
        : trigger === 'named'
          ? 'named-first-trigger'
          : 'eth-first-trigger',
    fromSec: onsetSec - 24 * H,
    toSec: onsetSec + 72 * H,
  }
}

// ------------------------------------------------------------------ f(t)

describe('withdrawableFraction', () => {
  it('is cash / supply, clamped to 1', () => {
    expect(withdrawableFraction(25, 100)).toBe(0.25)
    expect(withdrawableFraction(120, 100)).toBe(1)
    expect(withdrawableFraction(0, 100)).toBe(0)
  })
  it('a PAUSED reserve (bit2) is 0 whatever the balance; FROZEN (bit1) changes nothing', () => {
    expect(withdrawableFraction(50, 100, 1 | 4)).toBe(0)
    expect(withdrawableFraction(null, null, 4)).toBe(0)
    expect(withdrawableFraction(50, 100, 1 | 2)).toBe(0.5)
    expect(withdrawableFraction(50, 100, 0)).toBe(0.5) // MetaMorpho rows carry flags = 0
  })
  it('unknown is null, never 0', () => {
    expect(withdrawableFraction(null, 100)).toBeNull()
    expect(withdrawableFraction(10, null)).toBeNull()
    expect(withdrawableFraction(10, 0)).toBeNull()
    expect(withdrawableFraction(-1, 100)).toBeNull()
    expect(withdrawableFraction(NaN, 100)).toBeNull()
  })
})

// ------------------------------------------------------------------ per window

describe('windowMetrics', () => {
  // hour:      0    1    2     3      4      5     6      7     8 ...
  const path = [0.2, 0.1, 0.05, 0.005, 0.004, 0.02, 0.006, 0.08, ...fill(100, 0.3)]

  it('f at onset, min f over [onset, onset + H] (both ends included)', () => {
    const m = metrics(series(path))
    expect(m.fOnset).toBe(0.2)
    expect(m.onsetReadingSec).toBe(T0)
    expect(m.minF).toEqual({ h8: 0.004, h24: 0.004, h72: 0.004 })
    expect(m.readings8h).toBe(9)
    expect(m.maxGapH8h).toBe(1)
    expect(m.horizonCensored).toBe(false)
  })

  it('locked = f ≤ 1%: total hours in 72 h, and the longest stretch from max(start, onset)', () => {
    const m = metrics(series(path))
    expect(m.lockedHours72h).toBe(3) // hours 3, 4, 6
    expect(m.lockH).toBe(2) // hours 3–4, ended by the 2% reading at hour 5
    expect(m.lockCensored).toBe(false)
  })

  it('exactly 1% is locked; exactly 5% is recovered', () => {
    const m = metrics(series([0.3, 0.01, 0.04, 0.05, ...fill(80, 0.3)]))
    expect(m.lockedHours72h).toBe(1)
    expect(m.lockH).toBe(1)
    expect(m.recover5H).toBe(3)
  })

  it('recover5H: hours from onset to f ≥ 5% after the first sub-5% reading (5% itself is not a dip)', () => {
    expect(metrics(series(path)).recover5H).toBe(7)
    expect(metrics(series(fill(100, 0.05))).recover5H).toBe(0)
    expect(metrics(series(fill(100, 0.3))).recover5H).toBe(0)
  })

  it("the 8 h window's end is included; a dip one hour later is not in h8 but is in h24", () => {
    const at8 = metrics(series([...fill(8, 0.3), 0.001, ...fill(80, 0.3)]))
    expect(at8.minF.h8).toBe(0.001)
    const at9 = metrics(series([...fill(9, 0.3), 0.001, ...fill(80, 0.3)]))
    expect(at9.minF.h8).toBe(0.3)
    expect(at9.minF.h24).toBe(0.001)
  })

  it("'held' ignores a ONE-reading dip (a midnight drain) but not a two-reading one", () => {
    const blip = metrics(series([0.1, 0.1, 0, 0.1, ...fill(80, 0.1)]))
    expect(blip.minF.h8).toBe(0)
    expect(blip.minFHeld.h8).toBe(0.1)
    expect(blip.lockH).toBe(1)
    expect(blip.lockedHours72h).toBe(1)
    expect(blip.recover5H).toBe(3)

    const two = metrics(series([0.1, 0, 0, 0.1, ...fill(80, 0.1)]))
    expect(two.minFHeld.h8).toBe(0)
    expect(two.lockH).toBe(2)
  })

  it('as-of: an onset between readings uses the latest known reading ≤ 6 h before it', () => {
    const s = series(fill(100, 0.3).map((f, i) => (i === 2 ? null : f)))
    const m = metrics(s, T0 + 2 * H + 1800) // 02:30, the 02:00 reading unknown
    expect(m.onsetReadingSec).toBe(T0 + H)
    expect(windowMetrics(series(fill(10, 0.3)), T0 + 9 * H + 6 * H + 1)).toEqual({
      skip: 'no_data',
    })
    expect(windowMetrics(series(fill(10, 0.3)), T0 - 1)).toEqual({ skip: 'no_data' })
  })

  it("'not_material' when the supply at onset is under minSize", () => {
    expect(windowMetrics(series(fill(10, 0.3), { minSize: 2_000_000 }), T0)).toEqual({
      skip: 'not_material',
    })
    expect('skip' in windowMetrics(series(fill(10, 0.3), { minSize: 1_000_000 }), T0)).toBe(false)
  })

  it('an unknown reading never enters a minimum, is never locked, and breaks a lock run', () => {
    const m = metrics(series([0.3, 0, null, 0, 0.3, ...fill(80, 0.3)]))
    expect(m.minF.h8).toBe(0)
    expect(m.lockedHours72h).toBe(2) // hours 1 and 3; the unknown hour 2 is not counted
    expect(m.lockH).toBe(1)
    const unknownDip = metrics(series([0.3, null, 0.3, ...fill(80, 0.3)]))
    expect(unknownDip.minF.h8).toBe(0.3)
  })

  it('a reading stands for at most 6 h', () => {
    const s = series([0.3, 0, 0.3, 0.3], { stepH: 12 })
    const m = metrics(s)
    expect(m.lockedHours72h).toBe(6)
    expect(m.lockH).toBe(0) // the 12:00 lock starts after the 8 h window (UPDATED 2026-10-07: was 6)
    expect(m.maxGapH8h).toBe(8) // no reading between 00:00 and 08:00
    expect(metrics(series([0.3, 0, 0.3, 0.3], { stepH: 8 })).lockH).toBe(6) // 08:00 → 14:00
  })

  it('a lock is measured to its END past 72 h, and censored at the data end', () => {
    const long = metrics(series([0.3, ...fill(100, 0), ...fill(10, 0.3)]))
    expect(long.lockH).toBe(100)
    expect(long.lockedHours72h).toBe(71) // [01:00, 72:00)
    expect(long.lockCensored).toBe(false)
    expect(long.recover5H).toBe(101)

    const open = metrics(series([0.3, ...fill(30, 0)]))
    expect(open.lockCensored).toBe(true)
    expect(open.lockH).toBe(29) // first locked reading to the last reading: a lower bound
    expect(open.recover5H).toBeNull()
    expect(open.recoverLowerBoundH).toBe(30)
    expect(open.horizonCensored).toBe(true)
  })

  it('a lock already running at onset is measured from the onset', () => {
    const m = metrics(series([...fill(5, 0), ...fill(80, 0.3)]), T0 + 2 * H)
    expect(m.fOnset).toBe(0)
    expect(m.lockH).toBe(3) // 02:00 → 05:00
  })

  // Review 2026-10-07 (CONFIRMED-BUG): lockH was the longest ≤ 1% stretch ANYWHERE in 72 h, so
  // Spark DAI's worst event carried a 78 h lock that starts 20 h after onset while its own 8 h
  // window sat in a 9 h one — and the engine places lockH at the first breach.
  it('lockH is the stretch the 8 h WINDOW runs into, not a longer one later in the 72 h', () => {
    // 00–08 at 0.8% (the in-window lock, 9 h), 09 at 2.9%, 10–19 at 3%, 20–97 at 0.5% (78 h)
    const dai = [...fill(9, 0.008), 0.029, ...fill(10, 0.03), ...fill(78, 0.005), ...fill(20, 0.3)]
    const m = metrics(series(dai))
    expect(m.minFHeld.h8).toBe(0.008) // locked: f8 ≤ 1%
    expect(m.lockH).toBe(9) // was 78
    expect(m.lockedHours72h).toBe(9 + 52) // the later stretch still counts here, [20 h, 72 h)
    // a lock that starts after the window is not one the recall faces at all
    const late = metrics(series([...fill(12, 0.3), ...fill(30, 0), ...fill(60, 0.3)]))
    expect(late.minF.h8).toBe(0.3)
    expect(late.lockH).toBe(0)
    expect(late.lockedHours72h).toBe(30)
    // one starting INSIDE the window, at 08:00 (the end included), is, measured to its end
    const edge = metrics(series([...fill(8, 0.3), ...fill(30, 0), ...fill(60, 0.3)]))
    expect(edge.lockH).toBe(30)
  })

  it('absolute cash: stables at $1, others need priceUsd (else unknown), paused is $0', () => {
    expect(metrics(series(fill(80, 0.25))).cashUsdOnset).toBe(250_000)
    expect(metrics(series(fill(80, 0.25))).minCashUsd.h8).toBe(250_000)
    const weth = series(fill(80, 0.25), { venue: 'aave-core-weth', symbol: 'WETH', supply: 1000 })
    expect(metrics(weth).cashUsdOnset).toBeNull()
    expect(metrics(weth).minCashUsd.h8).toBeNull()
    const priced = metrics(weth, T0, { priceUsd: (sym: string) => (sym === 'WETH' ? 2000 : null) })
    expect(priced.cashUsdOnset).toBe(500_000)
    const paused = series(fill(80, 0.25), { flags: [5, ...fill(79, 1)] })
    expect(metrics(paused).fOnset).toBe(0)
    expect(metrics(paused).cashUsdOnset).toBe(0)
  })
})

// ------------------------------------------------------------------ windows

describe('stressWindowsFromEpisodes', () => {
  const episodes: VenueStressEpisode[] = [
    {
      id: 'named-kelp',
      trigger: 'named',
      label: 'Kelp',
      from: '2026-04-16T00:00Z',
      to: '2026-04-30T00:00Z',
    },
    {
      id: 'named-quiet',
      trigger: 'named',
      label: 'Quiet',
      from: '2026-08-22T00:00Z',
      to: '2026-08-31T00:00Z',
    },
    {
      id: 'util-aave-core-weth-2026-04-18T20',
      trigger: 'util>=95',
      label: 'weth util',
      venue: 'aave-core-weth',
      from: '2026-04-17T20:00Z',
      to: '2026-05-09T22:00Z',
      detail: { firstAt: '2026-04-18T20:00Z' },
    },
    {
      id: 'eth-drop-2026-04-20',
      trigger: 'eth-drop',
      label: 'drop',
      from: '2026-04-19T12:00Z',
      to: '2026-04-24T00:00Z',
      detail: { firstTrigger: '2026-04-20T12:00Z', worstDropPct: -12.5 },
    },
  ]

  it('one onset per trigger type; named = earliest trigger inside, else its window start', () => {
    const w = stressWindowsFromEpisodes(episodes)
    const by = Object.fromEntries(w.map((x) => [x.id, x]))
    expect(iso(by['eth-drop-2026-04-20'].onsetSec)).toBe('2026-04-20T12:00Z')
    expect(by['eth-drop-2026-04-20'].onsetBasis).toBe('eth-first-trigger')
    expect(by['eth-drop-2026-04-20'].venue).toBeNull()
    expect(by['eth-drop-2026-04-20'].shortLabel).toBe('ETH -12.5% 2026-04-20')
    expect(iso(by['util-aave-core-weth-2026-04-18T20'].onsetSec)).toBe('2026-04-18T20:00Z')
    expect(by['util-aave-core-weth-2026-04-18T20'].venue).toBe('aave-core-weth')
    expect(iso(by['named-kelp'].onsetSec)).toBe('2026-04-18T20:00Z')
    expect(by['named-kelp'].onsetBasis).toBe('named-first-trigger')
    expect(iso(by['named-quiet'].onsetSec)).toBe('2026-08-22T00:00Z')
    expect(by['named-quiet'].onsetBasis).toBe('named-window-start')
    expect(w.map((x) => x.onsetSec)).toEqual([...w.map((x) => x.onsetSec)].sort((a, b) => a - b))
  })

  it('extra util windows join before the named onsets are derived', () => {
    const extra = win('util-aave-core-usde-2026-04-17T05', Date.UTC(2026, 3, 17, 5) / 1000, {
      trigger: 'util',
      venue: 'aave-core-usde',
    })
    const w = stressWindowsFromEpisodes(episodes, [extra])
    expect(iso(w.find((x) => x.id === 'named-kelp')!.onsetSec)).toBe('2026-04-17T05:00Z')
    expect(() => stressWindowsFromEpisodes(episodes, [win('x', T0)])).toThrow(/not a util window/)
  })

  it('refuses malformed input', () => {
    expect(() => stressWindowsFromEpisodes([{ ...episodes[3], detail: {} }])).toThrow(
      /firstTrigger/,
    )
    expect(() => stressWindowsFromEpisodes([{ ...episodes[2], detail: {} }])).toThrow(/firstAt/)
    expect(() => stressWindowsFromEpisodes([{ ...episodes[0], trigger: 'oops' }])).toThrow(
      /unknown trigger/,
    )
  })

  it("a venue's windows are the market windows plus its OWN util windows", () => {
    const w = stressWindowsFromEpisodes(episodes)
    expect(
      venueWindows('aave-core-usdc', w)
        .map((x) => x.id)
        .sort(),
    ).toEqual(['eth-drop-2026-04-20', 'named-kelp', 'named-quiet'].sort())
    expect(venueWindows('aave-core-weth', w).map((x) => x.id)).toContain(
      'util-aave-core-weth-2026-04-18T20',
    )
  })
})

describe('utilWindowsFromSeries', () => {
  it('clusters stressed readings ≤ 72 h apart; onset = first; ±24 h window; builder ids', () => {
    const f = fill(300, 0.3)
    f[10] = 0.04 // util 96%
    f[11] = 0.02
    f[80] = 0.01 // 69 h after 11 → same window (two readings: a one-reading spike is a transient)
    f[81] = 0.01
    f[200] = 0.049 // 119 h later → a new window
    f[201] = 0.049
    const w = utilWindowsFromSeries(series(f, { venue: 'aave-core-usde', symbol: 'USDe' }), 0.95)
    expect(w).toHaveLength(2)
    expect(w[0].id).toBe(`util-aave-core-usde-${iso(T0 + 10 * H).slice(0, 13)}`)
    expect(w[0].onsetSec).toBe(T0 + 10 * H)
    expect(w[0].fromSec).toBe(T0 + 10 * H - 24 * H)
    expect(w[0].toSec).toBe(T0 + 81 * H + 24 * H)
    expect(w[0].venue).toBe('aave-core-usde')
    expect(w[1].onsetSec).toBe(T0 + 200 * H)
  })
  it('ignores readings on an immaterial supply and validates the level', () => {
    const f = fill(50, 0.3)
    f[5] = 0
    f[6] = 0
    expect(utilWindowsFromSeries(series(f, { minSize: 5_000_000 }), 0.95)).toHaveLength(0)
    expect(utilWindowsFromSeries(series(f), 0.95)).toHaveLength(1)
    expect(() => utilWindowsFromSeries(series(f), 0)).toThrow(/stressUtil/)
  })
  it('a one-hour TRANSIENT the next hourly reading clears is not a window (the 00:00 drain)', () => {
    const f = fill(24 * 60, 0.1)
    for (let d = 0; d < 60; d++) f[d * 24] = 0 // a daily drain: was ONE 60-day window
    expect(utilWindowsFromSeries(series(f), 0.95)).toEqual([])
    f[24 * 30 + 1] = 0 // a day whose drain holds for a second hourly reading
    const w = utilWindowsFromSeries(series(f), 0.95)
    expect(w.map((x) => x.onsetSec)).toEqual([T0 + 24 * 30 * H])
    expect(w[0].toSec).toBe(T0 + (24 * 30 + 1) * H + 24 * H)
  })
})

// ------------------------------------------------------------------ events

describe('venueStressEvents', () => {
  // one long hourly series; a lock at hours 100..140, a blip at hour 300
  const f = fill(600, 0.2)
  for (let i = 100; i <= 140; i++) f[i] = 0
  f[300] = 0
  const s = series(f)

  it('windows chained within 72 h are ONE event, counted at its WORST member, named label wins', () => {
    const windows = [
      win('named-x', T0 + 90 * H, { trigger: 'named', shortLabel: 'Event X' }),
      win('util-x', T0 + 100 * H, { trigger: 'util' }),
      win('eth-y', T0 + 290 * H),
    ]
    const { events, skipped } = venueStressEvents(s, windows)
    expect(skipped).toEqual([])
    expect(events).toHaveLength(2)
    const x = events[0]
    expect(x.memberIds).toEqual(['named-x', 'util-x'])
    expect(x.worst.windowId).toBe('util-x') // its 8 h starts inside the lock
    expect(x.name).toBe('Test USDC, Event X')
    expect(x.firstOnsetIso).toBe(iso(T0 + 90 * H))
    expect(x.worst.lockH).toBe(41)
  })

  it("other venues' util windows do not count; skipped windows are reported", () => {
    const windows = [
      win('util-other', T0 + 100 * H, { trigger: 'util', venue: 'spark-dai' }),
      win('too-early', T0 - 100 * H),
      win('eth-z', T0 + 400 * H),
    ]
    const { events, skipped } = venueStressEvents(s, windows)
    expect(events.map((e) => e.worst.windowId)).toEqual(['eth-z'])
    expect(skipped).toEqual([{ windowId: 'too-early', reason: 'no_data' }])
  })

  it('locked windows tie on f: the LONGER lock ranks worse, even at a higher f', () => {
    const g = fill(600, 0.2)
    for (let i = 100; i <= 130; i++) g[i] = 0.008 // a 31 h lock at 0.8%
    g[300] = 0 // a one-reading drain to 0
    const windows = [win('blip', T0 + 296 * H), win('lock', T0 + 100 * H)]
    const { events } = venueStressEvents(series(g), windows, { basis: 'reading' })
    expect(events.map((e) => e.worst.windowId)).toEqual(['lock', 'blip'])
    expect(events[0].worst.minF.h8).toBe(0.008)
    expect(events[1].worst.minF.h8).toBe(0)
  })

  it('the result does not depend on window order', () => {
    const windows = [
      win('a', T0 + 10 * H),
      win('b', T0 + 100 * H, { trigger: 'util' }),
      win('c', T0 + 296 * H),
      win('d', T0 + 450 * H),
    ]
    const fwd = venueStressEvents(s, windows)
    const rev = venueStressEvents(s, windows.slice().reverse())
    expect(rev).toEqual(fwd)
  })
})

// ------------------------------------------------------------------ presets

describe('nearestRankIndex', () => {
  it('is the lower nearest rank, always an observed index', () => {
    expect(nearestRankIndex(0.5, 33)).toBe(16)
    expect(nearestRankIndex(0.5, 4)).toBe(1)
    expect(nearestRankIndex(0.1, 33)).toBe(3)
    expect(nearestRankIndex(0.1, 5)).toBe(0)
    expect(nearestRankIndex(1, 7)).toBe(6)
    expect(nearestRankIndex(0.5, 1)).toBe(0)
    expect(() => nearestRankIndex(0.5, 0)).toThrow()
    expect(() => nearestRankIndex(0, 5)).toThrow()
  })
})

describe('venueStressAnalogs', () => {
  // ten market windows, each 80 h apart (> 72 h) → ten events; window k sees
  // f = 0.02 × (k + 1), window 3 also a one-reading blip to 0, window 7 a 30 h lock
  const N = 10
  const f = fill(2000, 0.5)
  const windows: StressWindow[] = []
  for (let k = 0; k < N; k++) {
    const at = 20 + k * 80
    for (let i = at; i < at + 10; i++) f[i] = 0.02 * (k + 1)
    windows.push(win(`w${k}`, T0 + at * H))
  }
  f[20 + 3 * 80 + 4] = 0 // blip in w3
  for (let i = 20 + 7 * 80; i < 20 + 7 * 80 + 30; i++) f[i] = 0 // lock in w7
  const s = series(f)

  it('typical = median event, bad = 10th percentile, worst = the worst — each ONE real window', () => {
    const t = venueStressAnalogs([s], windows)
    expect(t.basis).toBe(VENUE_ANALOG_DEFAULT_BASIS)
    expect(t.basis).toBe('held')
    expect(t.descriptiveLabel).toBe(MEASURED_DESCRIPTIVE_LABEL)
    const r = t.rows[0]
    expect(r.n).toBe(N)
    expect(r.range).toEqual({ fromIso: iso(T0 + 20 * H), toIso: iso(T0 + (20 + 9 * 80) * H) })
    const p = r.presets!
    // held: w7 locked (worst); the blip in w3 is ignored → sorted f: w7(0), w0 .02, w1 .04, w2 .06, w3 .08, w4 .10 ...
    expect(p['worst-observed'].source.windowId).toBe('w7')
    expect(p['worst-observed'].f).toBe(0)
    expect(p['worst-observed'].locked).toBe(true)
    expect(p['worst-observed'].lockH).toBe(30)
    expect(p['worst-observed'].rank).toBe(1)
    expect(p['bad-stress'].source.windowId).toBe('w7') // ⌈0.1·10⌉ − 1 = 0
    expect(p['typical-stress'].rank).toBe(5) // ⌈0.5·10⌉ − 1 = 4
    expect(p['typical-stress'].source.windowId).toBe('w3')
    expect(p['typical-stress'].f).toBeCloseTo(0.08, 12)
    expect(p['typical-stress'].locked).toBe(false)
    expect(p['typical-stress'].cashUsd8h).toBeCloseTo(80_000, 6)
    expect(p['typical-stress'].n).toBe(N)
    expect(p['typical-stress'].provenance).toContain('rank 5 of 10')
  })

  it('engine rows: mult = f; the lock reaches freezeHours ONLY for a locked event', () => {
    const t = venueStressAnalogs([s], windows)
    const rows = exitCapacityAnalogRows(t, [EXIT_CAPACITY_ANALOG_VENUES[0]])
    expect(rows.map((r) => r.id)).toEqual(['aave-usdc-typical', 'aave-usdc-bad', 'aave-usdc-worst'])
    const [typ, bad, worst] = rows
    // w7: f 0, locked 30 h → ×0 behind a 30 h lock from the first breach.
    expect(worst).toMatchObject({
      windowId: 'w7',
      mult: 0,
      locked: true,
      lockH: 30,
      freezeHours: 30,
    })
    expect(bad.windowId).toBe('w7')
    // w3: held f 0.08 with a one-reading blip to 0 — its ≤ 1% hour is NOT a lock at the breach.
    expect(typ).toMatchObject({ windowId: 'w3', mult: 0.08, locked: false, freezeHours: 0 })
    expect(typ.lockH).toBeGreaterThan(0)
    expect(typ.fSingleReading).toBe(0)
    expect(typ).toMatchObject({
      rank: 5,
      n: N,
      percentile: 0.5,
      level: 'typical',
      slug: 'aave-usdc',
    })
    expect(typ.windows).toEqual(['w3'])
    for (const r of rows) {
      expect(r.provenance).not.toMatch(/\b0%|free/i)
      expect(r.provenance).toContain(`of ${N} stress events`)
    }
    expect(worst.provenance).toContain('Under 0.01% of deposits withdrawable')
    expect(worst.provenance).toContain('locked (≤ 1%) for 30 h')
    // Never invented: a venue without events throws, and so does the literal-reading basis.
    expect(() => exitCapacityAnalogRows(t, [EXIT_CAPACITY_ANALOG_VENUES[1]])).toThrow(/no measured/)
    expect(() =>
      exitCapacityAnalogRows(venueStressAnalogs([s], windows, { basis: 'reading' }), [
        EXIT_CAPACITY_ANALOG_VENUES[0],
      ]),
    ).toThrow(/held/)
  })

  it("'reading' counts the one-reading blip: w3 becomes a locked event", () => {
    const p = venueStressAnalogs([s], windows, { basis: 'reading' }).rows[0].presets!
    expect(p['worst-observed'].source.windowId).toBe('w7') // locked tie → the longer lock
    // sorted: w7, w3 (both locked; w7's lock is longer), w0, w1, w2 → the 5th is w2
    expect(p['typical-stress'].source.windowId).toBe('w2')
  })

  it('a venue with no event has no presets', () => {
    const t = venueStressAnalogs(
      [series(fill(10, 0.3), { venue: 'spark-usds', symbol: 'USDS' })],
      windows,
    )
    expect(t.rows[0].n).toBe(0)
    expect(t.rows[0].presets).toBeNull()
    expect(t.rows[0].range).toBeNull()
  })

  it("bounds: 'frozen' ×0 stays as the theoretical bound; 'optimistic' ×1 is an upper bound, never a default", () => {
    expect(VENUE_ANALOG_BOUNDS.frozen).toMatchObject({
      f: 0,
      kind: 'theoretical-bound',
      isDefault: true,
    })
    expect(VENUE_ANALOG_BOUNDS.optimistic).toMatchObject({
      f: 1,
      kind: 'upper-bound',
      isDefault: false,
    })
    expect(VENUE_ANALOG_PRESET_ORDER).toEqual([
      'typical-stress',
      'bad-stress',
      'worst-observed',
      'frozen',
    ])
    expect(VENUE_ANALOG_PRESET_ORDER).not.toContain('optimistic')
  })

  it('analogExitCapacityUsd: pro-rata f × D, first-in-line min(D, cash)', () => {
    const p = venueStressAnalogs([s], windows).rows[0].presets!['typical-stress']
    expect(analogExitCapacityUsd(p, 1_000)).toBeCloseTo(80, 9)
    expect(analogExitCapacityUsd(p, 1_000, 'first-in-line')).toBe(1_000)
    expect(analogExitCapacityUsd(p, 1e9, 'first-in-line')).toBeCloseTo(80_000, 6)
    expect(analogExitCapacityUsd({ ...p, cashUsd8h: null }, 1_000, 'first-in-line')).toBeNull()
    expect(analogExitCapacityUsd(VENUE_ANALOG_BOUNDS.frozen, 1_000, 'first-in-line')).toBe(0)
    expect(analogExitCapacityUsd(VENUE_ANALOG_BOUNDS.optimistic, 1_000)).toBe(1_000)
    expect(analogExitCapacityUsd(p, -5)).toBe(0)
  })
})

// ------------------------------------------------------------------ the real history

const DATA = path.resolve(__dirname, '../../public/data/venue-stress')
/** 2 h util spikes between the old 6-hourly samples (review 2026-10-07), now util episodes. */
const SPIKE_EPISODES = [
  'util-aave-core-usdc-2024-03-13T03',
  'util-aave-core-usdc-2026-01-29T20',
  'util-aave-core-usdt-2024-03-12T07',
  'util-aave-core-usdt-2026-01-20T14',
  'util-spark-dai-2024-02-29T14',
]
const HAVE_DATA =
  fs.existsSync(path.join(DATA, 'history.json')) && fs.existsSync(path.join(DATA, 'summary.json'))

describe.skipIf(!HAVE_DATA)('the real venue stress history', () => {
  const load = () => {
    const history = JSON.parse(
      fs.readFileSync(path.join(DATA, 'history.json'), 'utf8'),
    ) as VenueStressHistoryFile
    const summary = JSON.parse(fs.readFileSync(path.join(DATA, 'summary.json'), 'utf8')) as {
      method: { minSize: Record<string, number>; stressUtil: Record<string, number> }
      episodes: VenueStressEpisode[]
      transients: Record<string, { count: number; byUtcHour: Record<string, number> }>
    }
    const seriesAll = venueSeriesFromHistory(history, { minSize: summary.method.minSize })
    const derived = seriesAll
      .filter((x) => summary.method.stressUtil[x.venue] === undefined)
      .flatMap((x) => utilWindowsFromSeries(x))
    const windows = stressWindowsFromEpisodes(summary.episodes, derived)
    return {
      history: history as VenueStressHistoryFile & {
        venues: Record<string, { cash: readonly (number | null)[]; liquid?: (number | null)[] }>
      },
      summary,
      seriesAll,
      windows,
      table: venueStressAnalogs(seriesAll, windows),
    }
  }
  const data = HAVE_DATA ? load() : null

  it('the builder rule, re-derived from the series, reproduces EVERY summary util episode', () => {
    const { summary, seriesAll } = data!
    for (const x of seriesAll) {
      const level = summary.method.stressUtil[x.venue]
      if (level === undefined) continue
      const mine = utilWindowsFromSeries(x, level).map((w) => [
        w.id,
        iso(w.onsetSec),
        iso(w.toSec - 24 * H),
      ])
      const theirs = summary.episodes
        .filter((e) => e.venue === x.venue)
        .map((e) => {
          const d = e.detail as { firstAt?: string; lastAt?: string }
          return [e.id, d.firstAt, d.lastAt]
        })
      expect(mine, x.venue).toEqual(theirs)
    }
  })

  // Review 2026-10-07 (CONFIRMED-BUG, minor): the 6-hourly baseline stepped over 2 h spikes.
  it('the grid is HOURLY end to end, and the 2 h spikes it used to miss are util episodes', () => {
    const { summary, seriesAll } = data!
    const t = seriesAll.find((x) => x.venue === 'aave-core-usdc')!.t
    let gaps = 0
    for (let i = 1; i < t.length; i++) if (t[i] - t[i - 1] !== H) gaps++
    expect(gaps).toBe(0)
    const ids = new Set(summary.episodes.map((e) => e.id))
    for (const id of SPIKE_EPISODES) expect(ids.has(id), id).toBe(true)
  })

  // Review 2026-10-07 (CONFIRMED-BUG): the Aave USDC 00:00 UTC drain kept util episodes open
  // for months (2024-10-23 → 12-14, 2026-05-08 → 10-07) and made one of its own (2024-10-15).
  it('the 00:00 UTC drain is a reported TRANSIENT, never a util episode', () => {
    const { summary } = data!
    const tr = summary.transients['aave-core-usdc']
    expect(tr.count).toBeGreaterThan(150)
    expect(tr.byUtcHour['0'] / tr.count).toBeGreaterThan(0.95)
    const ids = summary.episodes.map((e) => e.id)
    for (const gone of [
      'util-aave-core-usdc-2024-10-15T00',
      'util-aave-core-usdc-2024-10-24T00',
      'util-aave-core-usdc-2026-05-09T00',
    ])
      expect(ids).not.toContain(gone)
    // no Aave USDC util episode is longer than the Kelp one
    const usdc = summary.episodes.filter((e) => e.venue === 'aave-core-usdc')
    const hours = (e: VenueStressEpisode) => (Date.parse(e.to) - Date.parse(e.from)) / 3.6e6
    const kelp = usdc.find((e) => e.id === 'util-aave-core-usdc-2026-04-19T04')!
    for (const e of usdc) expect(hours(e), e.id).toBeLessThanOrEqual(hours(kelp))
  })

  // Review 2026-10-07 (CONFIRMED-BUG): Steakhouse's cash was the first-in-line walk.
  it("Steakhouse's cash is its PRO-RATA share, never above the first-in-line `liquid`", () => {
    const v = data!.history.venues['morpho-steakhouse-usdc']
    expect(v.liquid).toBeDefined()
    let rows = 0
    let below = 0
    for (let i = 0; i < v.cash.length; i++) {
      const c = v.cash[i]
      const l = v.liquid![i]
      expect(c == null, `row ${i}`).toBe(l == null)
      if (c == null || l == null) continue
      rows++
      expect(c, `row ${i}`).toBeLessThanOrEqual(l + 1)
      if (c < l - 1) below++
    }
    expect(rows).toBeGreaterThan(20_000)
    expect(below / rows).toBeGreaterThan(0.9) // first in line is a real overstatement
  })

  it('worst observed on Aave Core USDC / USDT / WETH is Kelp Apr-2026', () => {
    const rows = Object.fromEntries(data!.table.rows.map((r) => [r.venue, r]))
    const usdc = rows['aave-core-usdc'].presets!['worst-observed']
    expect(usdc.source.name).toBe('Aave USDC, Kelp Apr-2026')
    expect(usdc.f).toBeLessThan(1e-4) // ~$6k of a ~$3B supply, held for hours
    expect(usdc.locked).toBe(true)
    expect(usdc.lockH).toBe(45)
    expect(usdc.recover5H).toBe(148)
    const usdt = rows['aave-core-usdt'].presets!['worst-observed']
    expect(usdt.source.name).toBe('Aave USDT, Kelp Apr-2026')
    expect(usdt.lockH).toBe(135)
    const weth = rows['aave-core-weth'].presets!['worst-observed']
    expect(weth.source.name).toBe('Aave WETH, Kelp Apr-2026')
    expect(weth.lockH).toBe(259)
    expect(weth.cashUsd8h).toBeNull() // WETH needs priceUsd
  })

  const ETH_FILE = path.resolve(__dirname, '../../public/data/price-history/eth-usd-1h.json')
  it.skipIf(!fs.existsSync(ETH_FILE))(
    'the engine presets (exitCapacityAnalogs.ts) are exactly what this data gives — no drift',
    () => {
      // The driver prices WETH cash at the ETH hourly close; the same here.
      const eth = primaryGrid(JSON.parse(fs.readFileSync(ETH_FILE, 'utf8')) as PriceHistoryFile)
      const priceUsd = (symbol: string, tSec: number) => {
        if (symbol !== 'WETH') return null
        const i = indexAt(eth, tSec)
        return i >= 0 && i < eth.close.length ? eth.close[i] : null
      }
      const table = venueStressAnalogs(data!.seriesAll, data!.windows, { priceUsd })
      expect(exitCapacityAnalogRows(table)).toEqual(EXIT_CAPACITY_ANALOG_ROWS)
      const t = data!.seriesAll.find((x) => x.venue === 'aave-core-usdc')!.t
      expect(EXIT_CAPACITY_ANALOG_DATA_THROUGH).toBe(iso(t[t.length - 1]))
    },
  )

  it('typical Aave USDC stress is a median ETH-drop event, ~11% withdrawable across the 8 h', () => {
    const p = data!.table.rows.find((r) => r.venue === 'aave-core-usdc')!.presets!['typical-stress']
    expect(p.n).toBe(33)
    expect(p.rank).toBe(17)
    expect(p.source.windowId).toBe('eth-drop-2026-06-05')
    expect(p.f).toBeGreaterThan(0.1)
    expect(p.f).toBeLessThan(0.12)
  })
})
