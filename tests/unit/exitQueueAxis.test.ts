import { afterEach, describe, expect, it, vi } from 'vitest'

import { exitTime, type ExitTimeInput } from '@/lib/exitQueue/riskFrontier'
import { label, type VenueKey } from '@/lib/exitQueue/types'
import {
  exitQueueAxis,
  exitQueueScenario,
  runExitQueueGrid,
  runExitQueueStress,
  type ExitQueueAxis,
  type ExitQueueMeasured,
} from '@/lib/position-sim/exitQueueAxis'
import {
  DEFAULT_PRICE_SHAPES,
  runStress,
  STRESS_LABEL,
  stressRank,
  type PriceShape,
  type StressModelled,
  type StressPosition,
  type StressResult,
} from '@/lib/position-sim/stressGrid'

// ------------------------------------------------------------------ fixtures

const H = 3_600
const D = 86_400
const ANCHOR = { block: 26_129_440, ts: 1_791_242_711 } // 2026-10-05T23:25:11Z
const NOW = (ANCHOR.ts + 2 * H) * 1000

/** A ledger input shaped like the 2026-10-05 keyed-RPC readings. */
function input(venue: VenueKey, o: Partial<ExitTimeInput> = {}): ExitTimeInput {
  return {
    venue,
    anchor: ANCHOR,
    label: label('measured_history'),
    windowDays: 30,
    coverage: 'complete',
    requestToExit: { p50S: null, p90S: null, atLeastS: null, n: 0 },
    advertisedCooldownS: null,
    advertisedSetsWait: false,
    scheduleFloorS: null,
    queueDepth: { amount: null, count: null, symbol: 'X', decimals: 18 },
    oldestOpenAgeS: null,
    lastParamChangeTs: null,
    ...o,
  }
}

const FEED: ExitTimeInput[] = [
  input('lido-steth', {
    requestToExit: { p50S: 23.4 * H, p90S: 111 * H, atLeastS: null, n: 2843 },
  }),
  input('kelp-rseth', {
    requestToExit: { p50S: 402.5 * H, p90S: null, atLeastS: 505.9 * H, n: 218 },
    advertisedCooldownS: 0,
  }),
  input('sUSDe', {
    requestToExit: { p50S: D, p90S: D, atLeastS: null, n: 964 },
    advertisedCooldownS: D,
    advertisedSetsWait: true,
  }),
  input('maple-syrupusdc', { requestToExit: { p50S: 204, p90S: 384, atLeastS: null, n: 609 } }),
]

const step = (drop: number): PriceShape => ({ kind: 'step', drop })

/** stressGrid.test.ts's carry case: −25% puts 61.3k / 75k = 0.817 over the 0.80 line; 10k deployed cures it. */
const carry = (o: Partial<StressPosition> = {}): StressPosition => ({
  collateralUsd: 100_000,
  debtUsd: 61_300,
  line: 0.8,
  membraneClass: 'delayed',
  tradeShape: 'carry',
  deployedUsd: 10_000,
  debtMinimumUsd: 2000,
  exitCapacityPreset: 'optimistic',
  ...o,
})

function measured(a: ExitQueueAxis): ExitQueueMeasured {
  if (a.status !== 'measured') throw new Error(`not measured: ${a.reason} ${a.detail}`)
  return a
}

function sm(r: StressResult | null): StressModelled {
  if (!r || r.outcome === 'not_modelled') throw new Error(`not modelled: ${JSON.stringify(r)}`)
  return r
}

afterEach(() => vi.restoreAllMocks())

// ------------------------------------------------------------------ rule 1: one key

describe('rule 1: a position token resolves to the ledger venue', () => {
  it('wstETH exits through the Lido queue; its time is the measured p90', () => {
    const a = measured(exitQueueAxis('wstETH', FEED, { nowMs: NOW }))
    expect(a.venue).toBe('lido-steth')
    expect(a.exitTime.seconds).toBe(111 * H)
    expect(a.freezeHours).toBe(111)
    expect(a.exitTime.source).toBe('measured_quantile')
    expect(a.exitTime.atLeast).toBe(false)
  })

  it('sUSDe uses the recorder key and resolves to its 1-day cooldown', () => {
    const a = measured(exitQueueAxis('sUSDe', FEED, { nowMs: NOW }))
    expect(a.venue).toBe('sUSDe')
    expect(a.freezeHours).toBe(24)
  })

  it('negative control: a token no ledger covers is unknown, never 0', () => {
    for (const asset of ['sUSDS', 'aEthUSDC', 'rETH', '']) {
      const a = exitQueueAxis(asset, FEED, { nowMs: NOW })
      expect(a).toMatchObject({ status: 'unknown', reason: 'unmapped_venue', venue: null })
      expect(a).not.toHaveProperty('freezeHours')
      expect(exitQueueScenario(step(0.25), a)).toBeNull()
      expect(runExitQueueStress(carry(), step(0.25), a).result).toBeNull()
    }
  })
})

// ------------------------------------------------------------------ rule 2: unknown is not zero

describe('rule 2: unknown is not zero', () => {
  it('a covered venue with no ledger input is unknown', () => {
    expect(exitQueueAxis('weETH', FEED, { nowMs: NOW })).toMatchObject({
      status: 'unknown',
      reason: 'no_ledger',
      venue: 'etherfi-weeth',
    })
  })

  it('negative control: a floor-only cooldown of 0 with nothing measured runs no 0 h freeze', () => {
    const feed = [input('kelp-rseth', { advertisedCooldownS: 0 })]
    const a = exitQueueAxis('rsETH', feed, { nowMs: NOW })
    expect(a).toMatchObject({ status: 'unknown', reason: 'no_exit_time', venue: 'kelp-rseth' })
    const s = runExitQueueStress(carry(), step(0.25), a)
    expect(s.scenario).toBeNull()
    expect(s.result).toBeNull()
    // A 0 h freeze would have read as an instant exit and cured this position.
    expect(runStress(carry(), { price: step(0.25), venue: { freezeHours: 0 } }).outcome).toBe(
      'recall_cured',
    )
  })

  it('two inputs for one venue are refused, not picked between', () => {
    const feed = [
      ...FEED,
      input('lido-steth', { requestToExit: { p50S: H, p90S: 2 * H, atLeastS: null, n: 5 } }),
    ]
    expect(exitQueueAxis('stETH', feed, { nowMs: NOW })).toMatchObject({
      status: 'unknown',
      reason: 'invalid_input',
    })
  })

  it('negative durations and a malformed oldest-open age are refused', () => {
    for (const o of [
      { requestToExit: { p50S: -1, p90S: -1, atLeastS: null, n: 3 }, advertisedCooldownS: 0 },
      { oldestOpenAgeS: Infinity },
      { oldestOpenAgeS: -5 },
    ] satisfies Partial<ExitTimeInput>[]) {
      const feed = [
        input('lido-steth', {
          requestToExit: { p50S: H, p90S: 2 * H, atLeastS: null, n: 5 },
          ...o,
        }),
      ]
      expect(exitQueueAxis('stETH', feed, { nowMs: NOW })).toMatchObject({
        reason: 'invalid_input',
      })
    }
  })

  it('a non-finite exit time is refused', () => {
    const feed = [
      input('lido-steth', { requestToExit: { p50S: NaN, p90S: Infinity, atLeastS: null, n: 1 } }),
    ]
    expect(exitQueueAxis('stETH', feed, { nowMs: NOW })).toMatchObject({ reason: 'invalid_input' })
  })
})

// ------------------------------------------------------------------ rule 3: freshness

describe('rule 3: freshness uses the ledger rule (0 ≤ age ≤ 30 h)', () => {
  it('exactly 30 h is fresh; one second more is stale', () => {
    expect(exitQueueAxis('stETH', FEED, { nowMs: (ANCHOR.ts + 30 * H) * 1000 }).status).toBe(
      'measured',
    )
    expect(exitQueueAxis('stETH', FEED, { nowMs: (ANCHOR.ts + 30 * H + 1) * 1000 })).toMatchObject({
      status: 'unknown',
      reason: 'stale',
    })
  })

  it('an anchor after nowMs is stale, not fresh', () => {
    expect(exitQueueAxis('stETH', FEED, { nowMs: (ANCHOR.ts - 60) * 1000 }).status).toBe('unknown')
  })

  it('the clock is never read', () => {
    vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('Date.now read')
    })
    expect(measured(exitQueueAxis('stETH', FEED, { nowMs: NOW })).anchorAgeHours).toBe(2)
  })
})

// ------------------------------------------------------------------ rule 4: a freeze, not a capacity

describe('rule 4: the axis is a venue freeze on the given price shape', () => {
  it('equals a hand-set freeze exactly (same cell), and leaves the position alone', () => {
    const a = measured(exitQueueAxis('stETH', FEED, { nowMs: NOW }))
    const pos = carry()
    const before = JSON.stringify(pos)
    const s = runExitQueueStress(pos, step(0.25), a)
    expect(s.scenario).toEqual({ price: step(0.25), venue: { freezeHours: 111 } })
    expect(s.result).toEqual(runStress(pos, { price: step(0.25), venue: { freezeHours: 111 } }))
    expect(JSON.stringify(pos)).toBe(before)
  })

  it('a queue inside the 8 h window cures; a Lido-length queue misses it and sells', () => {
    const maple = sm(
      runExitQueueStress(
        carry(),
        step(0.25),
        measured(exitQueueAxis('syrupUSDC', FEED, { nowMs: NOW })),
      ).result,
    )
    expect(maple.outcome).toBe('armed_cured')
    expect(maple.recallOpensAtSeconds).toBe(60 + 7 * 60) // 384 s rounds up to 7 one-minute steps
    const lido = sm(
      runExitQueueStress(
        carry(),
        step(0.25),
        measured(exitQueueAxis('wstETH', FEED, { nowMs: NOW })),
      ).result,
    )
    expect(lido.outcome).toBe('sold')
    expect(lido.recallDrawnUsd).toBe(0)
    expect(stressRank(lido)).toBeGreaterThan(stressRank(maple))
  })

  it('a longer measured queue never ranks below a shorter one (same shock)', () => {
    const ranks = ['syrupUSDC', 'sUSDe', 'stETH', 'rsETH'].map((asset) =>
      stressRank(
        runExitQueueStress(carry(), step(0.25), exitQueueAxis(asset, FEED, { nowMs: NOW })).result!,
      ),
    )
    for (let i = 1; i < ranks.length; i++) expect(ranks[i]).toBeGreaterThanOrEqual(ranks[i - 1])
    // Not vacuous: the 6.4 min queue cures, the 24 h one does not.
    expect(ranks[0]).toBeLessThan(ranks[1])
  })

  it('the position keeps its own exit capacity: without one the engine still refuses', () => {
    const r = runExitQueueStress(
      carry({ exitCapacityPreset: undefined }),
      step(0.25),
      measured(exitQueueAxis('stETH', FEED, { nowMs: NOW })),
    ).result!
    expect(r).toMatchObject({ outcome: 'not_modelled', reason: 'no_exit_capacity' })
  })

  it('a levered long has no recall: the engine says so, and the label still travels', () => {
    const s = runExitQueueStress(
      carry({ tradeShape: 'levered_long', deployedUsd: undefined, exitCapacityPreset: undefined }),
      step(0.25),
      exitQueueAxis('stETH', FEED, { nowMs: NOW }),
    )
    expect(s.result).toMatchObject({ outcome: 'not_modelled', reason: 'no_recall_levered_long' })
    expect(measured(s.axis).exitTime.label.text).toBe('measured history, not a forecast')
  })
})

// ------------------------------------------------------------------ rule 5: label travels

describe('rule 5: every result carries the exit time with its label', () => {
  it('a measured result carries the measured label, the stress label and the anchor', () => {
    const s = runExitQueueStress(carry(), step(0.25), exitQueueAxis('stETH', FEED, { nowMs: NOW }))
    const a = measured(s.axis)
    expect(a.exitTime.label).toEqual({
      class: 'measured_change',
      basis: 'measured_history',
      text: 'measured history, not a forecast',
    })
    expect(a.stressLabel).toBe(STRESS_LABEL)
    expect(s.result!.label).toBe(STRESS_LABEL)
    expect(a.exitTime.anchor).toEqual(ANCHOR)
    expect(a.provenance).toContain('block 26129440')
    expect(a.provenance).toContain('not a forecast')
  })

  it('a lower bound stays a lower bound ("≥")', () => {
    const a = measured(exitQueueAxis('rsETH', FEED, { nowMs: NOW }))
    expect(a.exitTime).toMatchObject({
      source: 'measured_at_least',
      atLeast: true,
      seconds: 505.9 * H,
    })
    expect(a.provenance).toMatch(/^Kelp rsETH: ≥ 21\.1 d/)
  })

  it('beacon: the anchor schedule is chain_schedule; past readings are history', () => {
    const delay = 256 * 384
    const floorWins = exitTime(
      input('beacon-exit', {
        requestToExit: { p50S: 7 * D + delay, p90S: 8 * D + delay, atLeastS: null, n: 2 },
        scheduleFloorS: 8.46 * D + delay,
      }),
    )!
    expect(floorWins).toMatchObject({ source: 'chain_schedule', atLeast: true })
    expect(floorWins.label.basis).toBe('chain_schedule')
    const historyWins = exitTime(
      input('beacon-exit', {
        requestToExit: { p50S: 20 * D + delay, p90S: 38 * D + delay, atLeastS: null, n: 30 },
        scheduleFloorS: D + delay,
      }),
    )!
    expect(historyWins).toMatchObject({ source: 'measured_quantile', atLeast: true })
    expect(historyWins.label.basis).toBe('measured_history')
  })

  it('p50 is available, and is never above p90', () => {
    const p50 = measured(exitQueueAxis('stETH', FEED, { nowMs: NOW, q: 'p50' }))
    const p90 = measured(exitQueueAxis('stETH', FEED, { nowMs: NOW }))
    expect(p50.exitTime.seconds).toBe(23.4 * H)
    expect(p50.exitTime.seconds).toBeLessThanOrEqual(p90.exitTime.seconds)
  })
})

// ------------------------------------------------------------------ rules 6-7 (refuter findings 1-2)

describe('rule 6: a lower-bound exit time is a range, not a point', () => {
  // A Maple-like queue: 90 requests paid in 5 min, 15 stalled for 5 h, so p90 is not reached.
  const stalled = [
    input('maple-syrupusdc', {
      requestToExit: { p50S: 300, p90S: null, atLeastS: 5 * H, n: 105 },
      oldestOpenAgeS: 5 * H,
    }),
  ]

  it('runs the bound as the best case and adds the never-paid case', () => {
    const s = runExitQueueStress(
      carry(),
      step(0.25),
      exitQueueAxis('syrupUSDC', stalled, { nowMs: NOW }),
    )
    expect(s.exitTimeIs).toBe('lower_bound')
    expect(s.result!.outcome).toBe('armed_cured') // paid at exactly 5 h: inside the 8 h window
    expect(s.resultIfNeverPaid!.outcome).toBe('sold') // never paid in time
    expect(s.range).toEqual({ mildest: s.result, severest: s.resultIfNeverPaid })
    expect(sm(s.resultIfNeverPaid).recallDrawnUsd).toBe(0)
  })

  it('neither end is "best": the floor close can make paying at the bound the severer end', () => {
    // Refuter repro: loan < 2·dMin, so the ask escalates to the whole loan; a recall at 1 h
    // falls short and the floor close sells the rest, while with no recall the wick recovers.
    const small = carry({
      collateralUsd: 3_500,
      debtUsd: 3_000,
      line: 0.9,
      deployedUsd: 2_500,
      exitCapacityUsd: 2_500,
      exitCapacityPreset: undefined,
    })
    const feed = [
      input('maple-syrupusdc', { requestToExit: { p50S: 60, p90S: null, atLeastS: H, n: 20 } }),
    ]
    const s = runExitQueueStress(
      small,
      { kind: 'wick', drop: 0.068, hours: 4 },
      exitQueueAxis('syrupUSDC', feed, { nowMs: NOW }),
    )
    expect(sm(s.result)).toMatchObject({ outcome: 'sold', saleReason: 'floor' })
    expect(s.resultIfNeverPaid!.outcome).toBe('armed_cured')
    expect(s.range).toEqual({ mildest: s.resultIfNeverPaid, severest: s.result })
  })

  it('the never-paid freeze never opens, on every week-1 shape and both classes', () => {
    const feed = [
      input('maple-syrupusdc', { requestToExit: { p50S: 60, p90S: null, atLeastS: H, n: 20 } }),
    ]
    const a = exitQueueAxis('syrupUSDC', feed, { nowMs: NOW })
    const shapes: PriceShape[] = [
      ...DEFAULT_PRICE_SHAPES,
      { kind: 'linear', drop: 0.4, hours: 72 },
      { kind: 'wick', drop: 0.3, hours: 30, recover: 0 },
    ]
    for (const membraneClass of ['delayed', 'no-delay'] as const) {
      const line = membraneClass === 'no-delay' ? 0.9 : 0.8
      for (const price of shapes) {
        const s = runExitQueueStress(carry({ membraneClass, line }), price, a)
        const never = s.resultIfNeverPaid
        if (!never) continue
        const n = sm(never)
        expect(n.recallDrawnUsd).toBe(0)
        if (n.recallOpensAtSeconds !== null)
          expect(n.recallOpensAtSeconds).toBeGreaterThan(n.horizonSeconds)
      }
    }
  })

  it('a floor-only cooldown that wins is a lower bound too', () => {
    const feed = [
      input('kelp-rseth', {
        requestToExit: { p50S: H, p90S: 2 * H, atLeastS: null, n: 40 },
        advertisedCooldownS: 9 * H,
      }),
    ]
    const s = runExitQueueStress(carry(), step(0.25), exitQueueAxis('rsETH', feed, { nowMs: NOW }))
    expect(measured(s.axis).exitTime).toMatchObject({
      source: 'advertised_cooldown',
      atLeast: true,
    })
    expect(s.exitTimeIs).toBe('lower_bound')
    expect(s.range).not.toBeNull()
  })

  it('negative control: a lower bound under 1 s is unknown, not an instant exit at one end', () => {
    const feed = [
      input('maple-syrupusdc', { requestToExit: { p50S: null, p90S: null, atLeastS: 0, n: 1 } }),
    ]
    const a = exitQueueAxis('syrupUSDC', feed, { nowMs: NOW })
    expect(a).toMatchObject({ status: 'unknown', reason: 'no_exit_time' })
    expect(runExitQueueStress(carry(), step(0.25), a).result).toBeNull()
  })

  it('a not-modelled never-paid run is null, not an "other end"', () => {
    const a = exitQueueAxis(
      'syrupUSDC',
      [input('maple-syrupusdc', { requestToExit: { p50S: 60, p90S: null, atLeastS: H, n: 20 } })],
      { nowMs: NOW },
    )
    const s = runExitQueueStress(
      carry({ tradeShape: 'levered_long', deployedUsd: undefined, exitCapacityPreset: undefined }),
      step(0.25),
      a,
    )
    expect(s.result!.outcome).toBe('not_modelled')
    expect(s.resultIfNeverPaid).toBeNull()
    expect(s.range).toBeNull()
  })

  it('an estimate (quantile reached) has no range', () => {
    const s = runExitQueueStress(carry(), step(0.25), exitQueueAxis('stETH', FEED, { nowMs: NOW }))
    expect(s.exitTimeIs).toBe('estimate')
    expect(s.resultIfNeverPaid).toBeNull()
  })

  it('Kelp (≥ 21 d) is a lower bound too; both ends sell', () => {
    const s = runExitQueueStress(carry(), step(0.25), exitQueueAxis('rsETH', FEED, { nowMs: NOW }))
    expect(s.exitTimeIs).toBe('lower_bound')
    expect([s.result!.outcome, s.resultIfNeverPaid!.outcome]).toEqual(['sold', 'sold'])
  })

  it('an unknown axis has neither end', () => {
    const s = runExitQueueStress(carry(), step(0.25), exitQueueAxis('sUSDS', FEED, { nowMs: NOW }))
    expect(s).toMatchObject({ result: null, resultIfNeverPaid: null, exitTimeIs: null })
  })
})

describe('rule 7: a stall below 10% of the cohort stays visible', () => {
  it('names the oldest open wait but never folds it into the freeze', () => {
    const feed = [
      input('maple-syrupusdc', {
        requestToExit: { p50S: 300, p90S: 300, atLeastS: null, n: 100 },
        oldestOpenAgeS: 5 * H,
      }),
    ]
    const a = measured(exitQueueAxis('syrupUSDC', feed, { nowMs: NOW }))
    expect(a.freezeHours).toBe(300 / 3600)
    expect(a.oldestOpenAgeS).toBe(5 * H)
    expect(a.provenance).toContain('the oldest open request has waited 5.0 h')
    // No stall note when the head is younger than the exit time.
    const b = measured(exitQueueAxis('stETH', FEED, { nowMs: NOW }))
    expect(b.provenance).not.toContain('oldest open')
  })
})

// ------------------------------------------------------------------ the grid row

describe('the exit-queue grid row', () => {
  it('one node per week-1 shape, each with the axis attached', () => {
    const a = exitQueueAxis('stETH', FEED, { nowMs: NOW })
    const row = runExitQueueGrid(carry(), a)
    expect(row).toHaveLength(DEFAULT_PRICE_SHAPES.length)
    row.forEach((cell, i) => {
      expect(cell.axis).toBe(a)
      expect(cell.scenario).toEqual({ price: DEFAULT_PRICE_SHAPES[i], venue: { freezeHours: 111 } })
      expect(cell.result!.label).toBe(STRESS_LABEL)
    })
  })

  it('negative control: an unknown axis runs nothing on any shape', () => {
    const row = runExitQueueGrid(carry(), exitQueueAxis('sUSDS', FEED, { nowMs: NOW }))
    expect(row).toHaveLength(DEFAULT_PRICE_SHAPES.length)
    expect(row.every((c) => c.scenario === null && c.result === null)).toBe(true)
  })
})
