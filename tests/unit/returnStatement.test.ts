/**
 * returnStatement — the return half of the set-and-forget sim (board Q20). The accrual is
 * checked against hand arithmetic; the stressGrid trace against the engine's own totals; the
 * per-window runners against the engines the survival table and compare.ts already run; and
 * every missing rate must come back null with a reason, never as 0.
 */
import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { runComparison } from '@/lib/position-sim/compare'
import {
  isSold,
  runCase,
  windowReplay,
  type HourlyPath,
  type SetAndForgetCase,
} from '@/lib/position-sim/setAndForget'
import {
  accrue,
  covers,
  distOf,
  historySeries,
  incumbentPosition,
  incumbentReturn,
  incumbentWindow,
  membraneReturn,
  membraneWindow,
  MEMBRANE_BORROW_COST_WHY,
  MEMBRANE_UNDEPLOYED_RATE_WHY,
  NET_APY_HISTORY_DIR,
  NET_APY_HISTORY_SCHEMA,
  netApyHistoryFileName,
  netCarry,
  rateSeries,
  windowTimes,
  YEAR_SECONDS,
  type IncumbentParams,
  type NetApyHistoryFile,
} from '@/lib/position-sim/returnStatement'
import {
  runStress,
  type PriceShape,
  type StressModelled,
  type StressPosition,
} from '@/lib/position-sim/stressGrid'
import type { SimRun } from '@/lib/position-sim/types'

const H = 3600
const flat = (apr: number, from: number, to: number, step = H) => {
  const pts: { t: number; apr: number }[] = []
  for (let t = from; t <= to; t += step) pts.push({ t, apr })
  return rateSeries('test:flat', 'test', pts, 1.5 * step)
}

// ------------------------------------------------------------------ accrual

describe('accrue', () => {
  it('a constant rate on a constant balance is balance × apr × time', () => {
    const s = flat(0.05, 0, 100 * H)
    expect(accrue(s, 0, 90 * H, [{ t: 0, usd: 40_000 }])).toBeCloseTo(
      (40_000 * 0.05 * 90 * H) / YEAR_SECONDS,
      9,
    )
  })

  it('follows balance steps and rate steps, each held to the next', () => {
    // Rate 4% for 10 h, then 8%. Balance $1,000 until h 5, then $600.
    const s = rateSeries(
      'test',
      'test',
      [
        { t: 0, apr: 0.04 },
        { t: 10 * H, apr: 0.08 },
        { t: 30 * H, apr: 0.08 },
      ],
      100 * H,
    )
    const got = accrue(s, 0, 20 * H, [
      { t: 0, usd: 1000 },
      { t: 5 * H, usd: 600 },
    ])!
    const want = (1000 * 0.04 * 5 * H + 600 * 0.04 * 5 * H + 600 * 0.08 * 10 * H) / YEAR_SECONDS
    expect(got).toBeCloseTo(want, 12)
  })

  it('takes the rate in force at the window start, not the next sample', () => {
    const s = rateSeries(
      'test',
      'test',
      [
        { t: 0, apr: 0.1 },
        { t: 10 * H, apr: 0 },
        { t: 20 * H, apr: 0 },
      ],
      15 * H,
    )
    expect(accrue(s, 5 * H, 10 * H, [{ t: 5 * H, usd: 100 }])).toBeCloseTo(
      (100 * 0.1 * 5 * H) / YEAR_SECONDS,
      12,
    )
  })

  it('a zero-length window accrues 0', () => {
    expect(accrue(flat(0.05, 0, 10 * H), 3 * H, 3 * H, [{ t: 0, usd: 1 }])).toBe(0)
  })
})

describe('covers — a window the series does not cover is null, never 0', () => {
  const s = rateSeries(
    'test:s',
    'test',
    [
      { t: 10 * H, apr: 0.05 },
      { t: 11 * H, apr: 0.05 },
      { t: 14 * H, apr: 0.05 },
      { t: 15 * H, apr: 0.05 },
    ],
    1.5 * H,
  )

  it('before the first sample', () => {
    expect(covers(s, 9 * H, 11 * H)).toMatchObject({ ok: false })
    expect(accrue(s, 9 * H, 11 * H, [{ t: 9 * H, usd: 100 }])).toBeNull()
  })

  it('a gap longer than maxGap inside the window', () => {
    const c = covers(s, 10 * H, 15 * H)
    expect(c.ok).toBe(false)
    expect((c as { why: string }).why).toMatch(/no sample/)
    expect(accrue(s, 10 * H, 15 * H, [{ t: 10 * H, usd: 100 }])).toBeNull()
  })

  it('past the last sample by more than maxGap', () => {
    expect(covers(s, 14 * H, 17 * H).ok).toBe(false)
  })

  it('inside the samples, every gap ≤ maxGap', () => {
    expect(covers(s, 10 * H, 11.4 * H).ok).toBe(true)
    expect(covers(s, 14 * H, 16.4 * H).ok).toBe(true)
  })
})

// ------------------------------------------------------------------ trace

/** Replays that make the engine recall, sell by band, sell by expiry and floor-close. */
const SHAPES: readonly PriceShape[] = [
  {
    kind: 'replay',
    id: 'dip',
    stepSeconds: 1800,
    ratios: [1, 0.9, 0.7, 0.62, 0.6, 0.65, 0.7, 0.8, 0.9, 1],
  },
  {
    kind: 'replay',
    id: 'slide',
    stepSeconds: 1800,
    ratios: Array.from({ length: 200 }, (_, i) => 1 - 0.5 * (i / 199)),
  },
  { kind: 'replay', id: 'crash', stepSeconds: 1800, ratios: [1, 0.95, 0.3, 0.25, 0.2, 0.22] },
  { kind: 'step', drop: 0.45 },
  { kind: 'wick', drop: 0.4, hours: 4 },
]

const POSITIONS: readonly StressPosition[] = [
  {
    collateralUsd: 100_000,
    debtUsd: 40_000,
    line: 0.8,
    membraneClass: 'delayed',
    tradeShape: 'levered_long',
  },
  {
    collateralUsd: 100_000,
    debtUsd: 60_000,
    line: 0.8,
    membraneClass: 'delayed',
    tradeShape: 'carry',
    deployedUsd: 60_000,
    exitCapacityPreset: 'optimistic',
  },
  {
    collateralUsd: 100_000,
    debtUsd: 60_000,
    line: 0.8,
    membraneClass: 'delayed',
    tradeShape: 'carry',
    deployedUsd: 60_000,
    exitCapacityMult: 0.2,
  },
  {
    collateralUsd: 100_000,
    debtUsd: 70_000,
    line: 0.8,
    membraneClass: 'no-delay',
    tradeShape: 'carry',
    deployedUsd: 70_000,
    exitCapacityMult: 0.5,
  },
  // Near the debt floor: a short recall that would strand dust floor-closes.
  {
    collateralUsd: 9_999,
    debtUsd: 3_999.6,
    line: 0.8,
    membraneClass: 'delayed',
    tradeShape: 'carry',
    deployedUsd: 3_999.6,
    exitCapacityMult: 0.9,
  },
]

describe('stressGrid trace (opt-in)', () => {
  const runs: { plain: StressModelled; traced: StressModelled }[] = []
  for (const pos of POSITIONS) {
    for (const price of SHAPES) {
      runs.push({
        plain: runStress(pos, { price }) as StressModelled,
        traced: runStress(pos, { price }, { trace: true }) as StressModelled,
      })
    }
  }

  it('changes no other output, and the cell key ignores it', () => {
    for (const { plain, traced } of runs) {
      expect(plain.trace).toBeUndefined()
      const { trace: _t, ...rest } = traced
      expect(rest).toEqual(plain)
    }
  })

  it('sums to the run totals: recall to recallDrawnUsd, sold to exposedUsd', () => {
    for (const { traced } of runs) {
      const recall = traced.trace!.reduce((a, e) => a + e.recallUsd, 0)
      const sold = traced.trace!.reduce((a, e) => a + e.soldUsd, 0)
      expect(recall).toBeCloseTo(traced.recallDrawnUsd ?? 0, 6)
      expect(sold).toBeCloseTo(traced.exposedUsd, 6)
    }
  })

  it('covers recall-only cures, band sales and floor closes (the fixture is not vacuous)', () => {
    const outcomes = new Set(runs.map((r) => r.traced.outcome))
    const reasons = new Set(runs.map((r) => r.traced.saleReason))
    expect(outcomes.has('recall_cured')).toBe(true)
    expect(outcomes.has('sold')).toBe(true)
    expect(reasons.has('band')).toBe(true)
    expect(reasons.has('floor')).toBe(true)
    expect(runs.some((r) => r.traced.trace!.length > 1)).toBe(true)
  })

  it('stamps each move in seconds on the step grid, in order', () => {
    for (const { traced } of runs) {
      const t = traced.trace!.map((e) => e.seconds)
      expect([...t].sort((a, b) => a - b)).toEqual(t)
    }
  })
})

// ------------------------------------------------------------------ membrane statement

const carryRun = (
  trace: { seconds: number; recallUsd: number; soldUsd: number }[],
  exposedUsd = 0,
): StressModelled =>
  ({
    outcome: 'recall_cured',
    exposedUsd,
    recallDrawnUsd: trace.reduce((a, e) => a + e.recallUsd, 0),
    trace,
  }) as unknown as StressModelled

describe('membraneReturn', () => {
  const s = flat(0.06, 0, 200 * H)

  it('yield earned + yield given up = the whole deployment for the whole window', () => {
    const run = carryRun([
      { seconds: 10 * H, recallUsd: 15_000, soldUsd: 0 },
      { seconds: 50 * H, recallUsd: 5_000, soldUsd: 0 },
    ])
    const r = membraneReturn({
      startTs: 0,
      horizonSeconds: 100 * H,
      deployedUsd: 40_000,
      run,
      supply: s,
    })
    const whole = (40_000 * 0.06 * 100 * H) / YEAR_SECONDS
    expect(r.yieldEarned.usd! + r.yieldGivenUp.usd!).toBeCloseTo(whole, 9)
    // Given up: $15,000 for 90 h and $5,000 more for 50 h.
    expect(r.yieldGivenUp.usd).toBeCloseTo(
      ((15_000 * 90 * H + 5_000 * 50 * H) * 0.06) / YEAR_SECONDS,
      9,
    )
    expect(r.recallDrawnUsd).toBe(20_000)
  })

  it('a recall in the held tail after the horizon gives up nothing inside the window', () => {
    const run = carryRun([{ seconds: 120 * H, recallUsd: 10_000, soldUsd: 0 }])
    const r = membraneReturn({
      startTs: 0,
      horizonSeconds: 100 * H,
      deployedUsd: 40_000,
      run,
      supply: s,
    })
    expect(r.yieldGivenUp.usd).toBe(0)
    expect(r.yieldEarned.usd).toBeCloseTo((40_000 * 0.06 * 100 * H) / YEAR_SECONDS, 9)
  })

  it('never prices the borrow cost: it is the curator-set share', () => {
    const r = membraneReturn({
      startTs: 0,
      horizonSeconds: 10 * H,
      deployedUsd: 1,
      run: carryRun([]),
      supply: s,
    })
    expect(r.borrowCost).toEqual({ usd: null, why: MEMBRANE_BORROW_COST_WHY })
  })

  it('a levered long deploys nothing: yield 0 by construction, its rate unpriced', () => {
    const r = membraneReturn({
      startTs: 0,
      horizonSeconds: 10 * H,
      deployedUsd: 0,
      run: carryRun([]),
      supply: null,
    })
    expect(r.yieldEarned.usd).toBe(0)
    expect(r.yieldGivenUp.usd).toBe(0)
    expect(r.borrowCost).toEqual({ usd: null, why: MEMBRANE_UNDEPLOYED_RATE_WHY })
  })

  it('no series, or a window before it: null with the reason, never 0', () => {
    const none = membraneReturn({
      startTs: 0,
      horizonSeconds: 10 * H,
      deployedUsd: 100,
      run: carryRun([]),
      supply: null,
    })
    expect(none.yieldEarned).toMatchObject({
      usd: null,
      why: expect.stringMatching(/no net-APY history/),
    })
    const late = flat(0.06, 50 * H, 200 * H)
    const before = membraneReturn({
      startTs: 0,
      horizonSeconds: 10 * H,
      deployedUsd: 100,
      run: carryRun([]),
      supply: late,
    })
    expect(before.yieldEarned).toMatchObject({
      usd: null,
      why: expect.stringMatching(/no sample before/),
    })
    expect(before.yieldGivenUp.usd).toBeNull()
  })

  it('refuses an untraced run', () => {
    const run = {
      outcome: 'no_breach',
      exposedUsd: 0,
      recallDrawnUsd: 0,
    } as unknown as StressModelled
    expect(() =>
      membraneReturn({ startTs: 0, horizonSeconds: H, deployedUsd: 1, run, supply: s }),
    ).toThrow(/trace/)
  })
})

// ------------------------------------------------------------------ incumbent statement

describe('incumbentReturn', () => {
  const ev = (ts: number, repaidUsd: number, seizedUsd: number) => ({
    minute: 0,
    ts,
    kind: 'liquidation' as const,
    ltv: 0,
    line: 0,
    repaidUsd,
    seizedUsd,
    recalledUsd: 0,
    penaltyUsd: seizedUsd - repaidUsd,
    why: '',
  })
  const run = {
    events: [ev(20 * H, 10_000, 10_500), ev(60 * H, 5_000, 5_250)],
  } as unknown as SimRun
  const borrow = flat(0.08, 0, 200 * H)
  const supply = flat(0.05, 0, 200 * H)

  it('charges the borrow rate on the debt still owed after each liquidation', () => {
    const r = incumbentReturn({
      startTs: 0,
      horizonSeconds: 100 * H,
      startDebtUsd: 40_000,
      deployedUsd: 40_000,
      run,
      supply,
      borrow,
    })
    const want = (0.08 * (40_000 * 20 * H + 30_000 * 40 * H + 25_000 * 40 * H)) / YEAR_SECONDS
    expect(r.borrowCost.usd).toBeCloseTo(want, 9)
    expect(r.yieldEarned.usd).toBeCloseTo((40_000 * 0.05 * 100 * H) / YEAR_SECONDS, 9)
    expect(r.collateralSold.usd).toBe(15_750)
    expect(r.liquidationPenalty.usd).toBe(750)
    expect(r.yieldGivenUp.usd).toBe(0)
    expect(netCarry(r).usd).toBeCloseTo(r.yieldEarned.usd! - r.borrowCost.usd!, 9)
  })

  it('an uncovered borrow window is null, and so is the net', () => {
    const r = incumbentReturn({
      startTs: 0,
      horizonSeconds: 300 * H,
      startDebtUsd: 1,
      deployedUsd: 1,
      run,
      supply,
      borrow,
    })
    expect(r.borrowCost.usd).toBeNull()
    expect(netCarry(r).usd).toBeNull()
  })
})

// ------------------------------------------------------------------ the window runners

function pathFrom(closes: number[], lows?: number[]): HourlyPath {
  return {
    id: 'test',
    startTs: 1_700_000_000,
    close: Float64Array.from(closes),
    low: Float64Array.from(lows ?? closes),
  }
}

const PARAMS: IncumbentParams = {
  label: 'Aave v3 WETH (test)',
  liquidationThreshold: 0.83,
  liquidationBonus: 0.05,
  repayFraction: 0.5776,
  repayFractionLabel: 'test',
}

describe('membraneWindow / incumbentWindow', () => {
  // 48 h: flat, then a slide to −55% and a partial recovery.
  const closes = Array.from({ length: 49 }, (_, i) =>
    i < 8 ? 2000 : i < 30 ? 2000 * (1 - 0.55 * ((i - 7) / 22)) : 900 + (i - 30) * 10,
  )
  const p = pathFrom(closes)
  const c: SetAndForgetCase = {
    line: 0.8,
    membraneClass: 'delayed',
    tradeShape: 'carry',
    exitCapacityMult: 0.3,
  }

  it('runs the same engine and replay as the survival table', () => {
    for (const ltv of [0.3, 0.4, 0.5]) {
      const mw = membraneWindow(c, ltv, p, 0, 40, 'low-close', null)!
      const plain = runCase(c, windowReplay(p, 0, 40)!, ltv)
      expect(isSold(mw.run)).toBe(isSold(plain))
      expect(mw.run.exposedUsd).toBe(plain.exposedUsd)
      expect(mw.ret.collateralSold.usd).toBe(plain.exposedUsd)
    }
  })

  it('opens at the close of the start hour', () => {
    expect(windowTimes(p, 0, 40)).toEqual({ openTs: p.startTs + H, closeTs: p.startTs + 41 * H })
  })

  it('the incumbent run is compare.ts’s SOURCE engine on the same position and path', () => {
    const run = incumbentWindow(100_000, 40_000, p, 0, 40, 'low-close', PARAMS)!
    const shape = windowReplay(p, 0, 40)!
    if (shape.kind !== 'replay') throw new Error('replay expected')
    const cmp = runComparison(
      incumbentPosition(100_000, 40_000, PARAMS),
      {
        startTs: p.startTs + H,
        stepSeconds: shape.stepSeconds,
        count: shape.ratios.length,
        series: { COLLATERAL: [...shape.ratios] },
        provenance: run.provenance,
      },
      [],
      {
        membraneLiqFee: 0,
        venue: null,
        sourceRepayFraction: PARAMS.repayFraction,
        sourceRepayFractionLabel: 'test',
        scenarioLabel: 'test',
      },
    )
    expect(run.events).toEqual(cmp.source.events)
    expect(run.events.length).toBeGreaterThan(0) // the slide does cross 83% at 40% start LTV
  })

  it('an incumbent liquidation seizes the bonus on top of what it repays', () => {
    const run = incumbentWindow(100_000, 40_000, p, 0, 40, 'low-close', PARAMS)!
    for (const e of run.events) expect(e.seizedUsd).toBeCloseTo(e.repaidUsd * 1.05, 6)
  })

  it('null past the path end', () => {
    expect(membraneWindow(c, 0.4, p, 20, 40, 'low-close', null)).toBeNull()
    expect(incumbentWindow(100_000, 40_000, p, 20, 40, 'low-close', PARAMS)).toBeNull()
  })
})

// ------------------------------------------------------------------ summary + history file

describe('distOf', () => {
  it('lower nearest-rank quantiles with n', () => {
    // n = 12: every quantile falls between two ranks, so the lower rank is the one tested.
    expect(distOf([5, 1, 4, 2, 3, 10, 9, 8, 7, 6, 11, 12])).toEqual({
      n: 12,
      min: 1,
      p10: 2,
      median: 6,
      p90: 10,
      max: 12,
    })
    expect(distOf([])).toBeNull()
    expect(distOf([NaN, 2])).toEqual({ n: 1, min: 2, p10: 2, median: 2, p90: 2, max: 2 })
  })
})

describe('historySeries', () => {
  const file: NetApyHistoryFile = {
    schema: NET_APY_HISTORY_SCHEMA,
    generatedAt: '',
    source: '',
    hosts: [],
    strideSeconds: 6 * H,
    sizesUsd: [0],
    semantics: {},
    venues: {
      v: {
        venueKey: 'v',
        label: 'v',
        columns: ['t', 'blockTs', 'b', 'supplyApr@0'],
        firstReadable: { t: 0, b: 1 },
        lastUnreadable: null,
        rows: [
          [0, 12, 1, 0.04],
          [6 * H, 6 * H + 12, 2, null],
          [12 * H, 12 * H + 12, 3, 0.05],
        ],
        failures: [],
      },
    },
  }

  it('stamps each sample at its block time and allows 1.5 strides', () => {
    const s = historySeries(file, 'v', 'supplyApr@0')!
    expect([...s.t]).toEqual([12, 12 * H + 12])
    expect(s.maxGapSeconds).toBe(9 * H)
    // The null sample is a hole: 12 h between samples is more than 9 h.
    expect(covers(s, 12, 12 * H).ok).toBe(false)
  })

  it('null for an unknown venue; throws for an unknown column', () => {
    expect(historySeries(file, 'nope', 'supplyApr@0')).toBeNull()
    expect(() => historySeries(file, 'v', 'supplyApr@5')).toThrow(/no column/)
  })
})

// ------------------------------------------------------------------ the published history

/** The history is fetched data, so it lives in the private datasets repo (board rule N18). These
 *  checks run where that clone exists. */
const DATASETS = path.resolve(
  process.env.MEMBRANE_DATASETS_DIR ?? path.join(process.cwd(), '..', 'membrane-datasets'),
)
const HISTORY_FILE = path.join(
  DATASETS,
  NET_APY_HISTORY_DIR,
  netApyHistoryFileName(['aave-v3-usdc'], 1),
)

describe.runIf(fs.existsSync(HISTORY_FILE))('net-apy-history.json (published)', () => {
  const hist = fs.existsSync(HISTORY_FILE)
    ? (JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) as NetApyHistoryFile)
    : null
  const v = hist?.venues['aave-v3-usdc']
  const col = (name: string) => v!.columns.indexOf(name)

  it('is hourly: the borrow series it is set against is hourly', () => {
    expect(hist!.strideSeconds).toBe(3600)
    const s = historySeries(hist!, 'aave-v3-usdc', 'supplyApr@0')!
    expect(s.maxGapSeconds).toBe(1.5 * 3600)
  })

  it('a depositor never earns more than a borrower pays, and a bigger deposit never earns a higher rate', () => {
    const sizes = hist!.sizesUsd.map((u) => col(`supplyApr@${u}`))
    for (const r of v!.rows) {
      const borrow = r[col('borrowApr')] as number
      const supply = sizes.map((i) => r[i] as number)
      expect(supply[0]).toBeLessThanOrEqual(borrow)
      for (let k = 1; k < supply.length; k++)
        expect(supply[k]).toBeLessThanOrEqual(supply[k - 1] + 1e-12)
    }
  })

  it('starts at the first block lib/netApy can read, and names the read before it that failed', () => {
    expect(v!.lastUnreadable).not.toBeNull()
    expect(v!.lastUnreadable!.b).toBeLessThan(v!.firstReadable.b)
    expect(v!.rows[0][col('b')]).toBeGreaterThanOrEqual(v!.firstReadable.b)
  })
})

// ------------------------------------------------------------------ the published JSON

const RETURNS_JSON = path.join(
  process.cwd(),
  'public/data/price-history/set-and-forget-returns.json',
)
const HISTORY_JSON = HISTORY_FILE

describe.runIf(fs.existsSync(RETURNS_JSON) && fs.existsSync(HISTORY_JSON))(
  'set-and-forget-returns.json (published)',
  () => {
    type Dist = {
      n: number
      min: number
      p10: number
      median: number
      p90: number
      max: number
    } | null
    const file = fs.existsSync(RETURNS_JSON)
      ? JSON.parse(fs.readFileSync(RETURNS_JSON, 'utf8'))
      : { statements: [] }
    const hist = fs.existsSync(HISTORY_JSON)
      ? (JSON.parse(fs.readFileSync(HISTORY_JSON, 'utf8')) as NetApyHistoryFile)
      : null
    const statements = file.statements as {
      caseId: string
      horizon: string
      n: number
      nSurvival: number
      unavailable: Record<string, number>
      period: { firstOpen: string; lastOpen: string } | null
      membrane: { yieldEarned: Dist; borrowCost: { usd: null }; yieldGivenUp: Dist }
      incumbent: { yieldEarned: Dist; borrowCost: Dist }
    }[]

    it('states n, and n plus the unavailable windows is the survival population', () => {
      expect(statements.length).toBeGreaterThan(0)
      for (const st of statements) {
        const un = Object.values(st.unavailable).reduce((a, b) => a + b, 0)
        expect(st.n + un).toBe(st.nSurvival)
        if (st.n > 0) expect(st.membrane.yieldEarned?.n).toBe(st.n)
      }
    })

    it('no window opens before the net-APY history: nothing is priced without it', () => {
      const first = hist!.venues['aave-v3-usdc'].firstReadable.t
      for (const st of statements) {
        if (st.period) expect(Date.parse(st.period.firstOpen) / 1000).toBeGreaterThanOrEqual(first)
      }
    })

    it('Membrane’s borrow cost is never priced', () => {
      for (const st of statements) expect(st.membrane.borrowCost.usd).toBeNull()
    })

    it('carry on Membrane earns no more than Aave at the position’s own size (its book dilutes the rate; recalls unwind it)', () => {
      for (const st of statements.filter((x) => x.caseId.startsWith('carry:') && x.n > 0)) {
        const m = st.membrane.yieldEarned!
        const a = st.incumbent.yieldEarned!
        for (const k of ['min', 'p10', 'median', 'p90', 'max'] as const)
          expect(m[k]).toBeLessThanOrEqual(a[k] + 0.01)
      }
    })
  },
)
