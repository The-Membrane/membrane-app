import { afterEach, describe, expect, it, vi } from 'vitest'

import { exitTime, type ExitTimeInput } from '@/lib/exitQueue/riskFrontier'
import { label, type VenueKey } from '@/lib/exitQueue/types'
import {
  QUEUE_BUFFER_TARGET_SHARE,
  exitQueueAxis,
  queueVenuePosition,
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
    expect(a.exitTime.source).toBe('measured_quantile')
    expect(a.exitTime.atLeast).toBe(false)
  })

  it('sUSDe uses the recorder key and resolves to its 1-day cooldown', () => {
    const a = measured(exitQueueAxis('sUSDe', FEED, { nowMs: NOW }))
    expect(a.venue).toBe('sUSDe')
    expect(a.exitTime.seconds).toBe(D)
  })

  it('negative control: a token no ledger covers is unknown, never 0', () => {
    for (const asset of ['sUSDS', 'aEthUSDC', 'rETH', '']) {
      const a = exitQueueAxis(asset, FEED, { nowMs: NOW })
      expect(a).toMatchObject({ status: 'unknown', reason: 'unmapped_venue', venue: null })
      expect(a).not.toHaveProperty('exitTime')
      expect(runExitQueueStress(carry(), step(0.25), a).atBufferTarget).toBeNull()
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

  it('negative control: a floor-only cooldown of 0 with nothing measured runs nothing', () => {
    const feed = [input('kelp-rseth', { advertisedCooldownS: 0 })]
    const a = exitQueueAxis('rsETH', feed, { nowMs: NOW })
    expect(a).toMatchObject({ status: 'unknown', reason: 'no_exit_time', venue: 'kelp-rseth' })
    const s = runExitQueueStress(carry(), step(0.25), a)
    expect(s.atBufferTarget).toBeNull()
    expect(s.bufferDrained).toBeNull()
    // Falling back to the chosen (liquid) exit would have cured this position.
    expect(runStress(carry(), { price: step(0.25) }).outcome).toBe('recall_cured')
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

// ------------------------------------------------------------------ rule 4: only the buffer is liquid

describe('rule 4: a queue venue recalls only its buffer, whatever the queue length', () => {
  it('runs the buffer at target and drained, as a fixed stock, and leaves the position alone', () => {
    const a = measured(exitQueueAxis('stETH', FEED, { nowMs: NOW }))
    const pos = carry()
    const before = JSON.stringify(pos)
    const s = runExitQueueStress(pos, step(0.25), a)
    const at = { ...pos, exitCapacityUsd: 500, exitCapacityPreset: undefined }
    const drained = { ...pos, exitCapacityUsd: 0, exitCapacityPreset: undefined }
    expect(s.atBufferTarget).toEqual(runStress(at, { price: step(0.25) }))
    expect(s.bufferDrained).toEqual(runStress(drained, { price: step(0.25) }))
    expect(JSON.stringify(pos)).toBe(before)
    expect(QUEUE_BUFFER_TARGET_SHARE).toBe(0.05) // DeploymentVaultBase.sol:254 bufferBps = 500
  })

  it('no freeze: the queue time is in no run', () => {
    const s = runExitQueueStress(carry(), step(0.25), exitQueueAxis('stETH', FEED, { nowMs: NOW }))
    expect(s.atBufferTarget!.scenarioId).not.toMatch(/freeze/)
    expect(s.atBufferTarget!.cellKey).not.toMatch(/freeze/)
  })

  it('negative control: a 6.4 min queue and a ≥ 21 d queue give the same runs (owner, 2026-10-12)', () => {
    const outcomes = ['syrupUSDC', 'sUSDe', 'stETH', 'rsETH'].map((asset) => {
      const s = runExitQueueStress(carry(), step(0.25), exitQueueAxis(asset, FEED, { nowMs: NOW }))
      return [s.atBufferTarget!.cellKey, s.bufferDrained!.cellKey]
    })
    for (const o of outcomes) expect(o).toEqual(outcomes[0])
  })

  it('the buffer replaces the chosen exit capacity, even the optimistic bound', () => {
    // carry() chose 'optimistic' (×1): with it, recall cures the −25% step.
    const liquid = sm(runStress(carry(), { price: step(0.25) }))
    expect(liquid.outcome).toBe('recall_cured')
    const s = runExitQueueStress(
      carry(),
      step(0.25),
      exitQueueAxis('syrupUSDC', FEED, { nowMs: NOW }),
    )
    expect(sm(s.bufferDrained).recallDrawnUsd).toBe(0)
    expect(sm(s.atBufferTarget).recallDrawnUsd).toBeLessThanOrEqual(500)
    expect(stressRank(sm(s.bufferDrained))).toBeGreaterThan(stressRank(liquid))
  })

  it('queueVenuePosition clamps the share and leaves a levered long unchanged', () => {
    expect(queueVenuePosition(carry(), 2).exitCapacityUsd).toBe(10_000)
    expect(queueVenuePosition(carry(), -1).exitCapacityUsd).toBe(0)
    expect(queueVenuePosition(carry(), NaN).exitCapacityUsd).toBe(0)
    const lev = carry({ tradeShape: 'levered_long', deployedUsd: undefined })
    expect(queueVenuePosition(lev, 0.05)).toBe(lev)
  })

  it('a levered long has no recall: the engine says so, and the label still travels', () => {
    const s = runExitQueueStress(
      carry({ tradeShape: 'levered_long', deployedUsd: undefined, exitCapacityPreset: undefined }),
      step(0.25),
      exitQueueAxis('stETH', FEED, { nowMs: NOW }),
    )
    expect(s.atBufferTarget).toMatchObject({
      outcome: 'not_modelled',
      reason: 'no_recall_levered_long',
    })
    expect(s.range).toBeNull()
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
    expect(s.atBufferTarget!.label).toBe(STRESS_LABEL)
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

// ------------------------------------------------------------------ the buffer range

describe('the buffer range: target and drained, neither is "best"', () => {
  it('orders the two runs by stressRank', () => {
    // LTV 61.3% at −25% crosses the 0.80 line; the $500 buffer cannot restore it.
    const s = runExitQueueStress(carry(), step(0.25), exitQueueAxis('stETH', FEED, { nowMs: NOW }))
    expect(s.range).not.toBeNull()
    expect(stressRank(s.range!.severest)).toBeGreaterThanOrEqual(stressRank(s.range!.mildest))
    expect([s.atBufferTarget, s.bufferDrained]).toContain(s.range!.mildest)
    expect([s.atBufferTarget, s.bufferDrained]).toContain(s.range!.severest)
  })

  it('the floor close can make the buffer the severer end', () => {
    // Refuter repro (2026-10-05): loan < 2·dMin, so the ask escalates to the whole loan; a
    // recall that falls short triggers the floor close, while with no recall the wick recovers.
    const small = carry({
      collateralUsd: 3_500,
      debtUsd: 3_000,
      line: 0.9,
      deployedUsd: 2_500,
      exitCapacityPreset: undefined,
    })
    const feed = [
      input('maple-syrupusdc', { requestToExit: { p50S: 60, p90S: 120, atLeastS: null, n: 20 } }),
    ]
    const s = runExitQueueStress(
      small,
      { kind: 'wick', drop: 0.068, hours: 4 },
      exitQueueAxis('syrupUSDC', feed, { nowMs: NOW }),
    )
    const target = sm(s.atBufferTarget)
    const drained = sm(s.bufferDrained)
    expect(drained.recallDrawnUsd).toBe(0)
    if (stressRank(target) > stressRank(drained))
      expect(s.range).toEqual({ mildest: s.bufferDrained, severest: s.atBufferTarget })
    else expect(s.range).toEqual({ mildest: s.atBufferTarget, severest: s.bufferDrained })
  })

  it('the drained run draws nothing, on every week-1 shape and both classes', () => {
    const a = exitQueueAxis('stETH', FEED, { nowMs: NOW })
    const shapes: PriceShape[] = [
      ...DEFAULT_PRICE_SHAPES,
      { kind: 'linear', drop: 0.4, hours: 72 },
      { kind: 'wick', drop: 0.3, hours: 30, recover: 0 },
    ]
    for (const membraneClass of ['delayed', 'no-delay'] as const) {
      const line = membraneClass === 'no-delay' ? 0.9 : 0.8
      for (const price of shapes) {
        const s = runExitQueueStress(carry({ membraneClass, line }), price, a)
        const d = s.bufferDrained!
        if (d.outcome === 'not_modelled') continue
        expect(d.recallDrawnUsd).toBe(0)
        if (s.atBufferTarget!.outcome !== 'not_modelled')
          expect(s.atBufferTarget!.recallDrawnUsd).toBeLessThanOrEqual(500 + 1e-6)
      }
    }
  })

  it('negative control: a lower bound under 1 s is unknown, and runs nothing', () => {
    const feed = [
      input('maple-syrupusdc', { requestToExit: { p50S: null, p90S: null, atLeastS: 0, n: 1 } }),
    ]
    const a = exitQueueAxis('syrupUSDC', feed, { nowMs: NOW })
    expect(a).toMatchObject({ status: 'unknown', reason: 'no_exit_time' })
    expect(runExitQueueStress(carry(), step(0.25), a).atBufferTarget).toBeNull()
  })

  it('a floor-only cooldown that wins is a lower bound ("≥")', () => {
    const feed = [
      input('kelp-rseth', {
        requestToExit: { p50S: H, p90S: 2 * H, atLeastS: null, n: 40 },
        advertisedCooldownS: 9 * H,
      }),
    ]
    expect(measured(exitQueueAxis('rsETH', feed, { nowMs: NOW })).exitTime).toMatchObject({
      source: 'advertised_cooldown',
      atLeast: true,
    })
  })

  it('an unknown axis has neither run', () => {
    const s = runExitQueueStress(carry(), step(0.25), exitQueueAxis('sUSDS', FEED, { nowMs: NOW }))
    expect(s).toMatchObject({ atBufferTarget: null, bufferDrained: null, range: null })
  })

  it('a stale axis runs nothing', () => {
    const s = runExitQueueStress(
      carry(),
      step(0.25),
      exitQueueAxis('stETH', FEED, { nowMs: (ANCHOR.ts + 31 * H) * 1000 }),
    )
    expect(s.axis).toMatchObject({ status: 'unknown', reason: 'stale' })
    expect(s.atBufferTarget).toBeNull()
  })
})

describe('rule 7: a stall below 10% of the cohort stays visible', () => {
  it('names the oldest open wait, and it enters no run', () => {
    const feed = [
      input('maple-syrupusdc', {
        requestToExit: { p50S: 300, p90S: 300, atLeastS: null, n: 100 },
        oldestOpenAgeS: 5 * H,
      }),
    ]
    const a = measured(exitQueueAxis('syrupUSDC', feed, { nowMs: NOW }))
    expect(a.exitTime.seconds).toBe(300)
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
      expect(cell.atBufferTarget).toEqual(
        runStress(queueVenuePosition(carry(), 0.05), { price: DEFAULT_PRICE_SHAPES[i] }),
      )
      expect(cell.atBufferTarget!.label).toBe(STRESS_LABEL)
    })
  })

  it('negative control: an unknown axis runs nothing on any shape', () => {
    const row = runExitQueueGrid(carry(), exitQueueAxis('sUSDS', FEED, { nowMs: NOW }))
    expect(row).toHaveLength(DEFAULT_PRICE_SHAPES.length)
    expect(row.every((c) => c.atBufferTarget === null && c.bufferDrained === null)).toBe(true)
  })
})
