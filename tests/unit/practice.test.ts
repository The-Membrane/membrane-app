import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

import { cureWalk } from '@/lib/position-sim/curePath'
import {
  BAND_APPROACH_PP,
  PRACTICE_ASSETS,
  allPresets,
  apply,
  cureWalkInputFor,
  currentLtv,
  initialState,
  liquidatorBaseline,
  loadPracticeData,
  makeScenario,
  membraneNoAction,
  runToEnd,
  runToPause,
  score,
  step,
  type Oct10Data,
  type PauseKind,
  type Preset,
} from '@/lib/practice/engine'

const DIR = path.join(__dirname, '../../public/data/oct10-2025')
const readJson = (f: string) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'))

let data: Oct10Data
let presets: Preset[]

beforeAll(async () => {
  data = await loadPracticeData(async () => ({
    series: readJson('prices-1m.json'),
    manifest: readJson('manifest.json'),
  }))
  presets = allPresets(data)
})

const scenarioFor = (p: Preset) => makeScenario(data, { asset: p.asset, openLtv: p.openLtv, line: p.line })

describe('presets are derived from the tape', () => {
  it('covers every asset twice, and the worst minute lands where the preset says', () => {
    expect(presets).toHaveLength(PRACTICE_ASSETS.length * 2)
    for (const p of presets) {
      const sc = scenarioFor(p)
      const r = sc.ratios[p.worstIndex] as number
      expect(p.openLtv / r).toBeCloseTo(p.worstLtv, 12)
      const target = p.kind === 'inside' ? sc.line + 0.02 : sc.breakLine + 0.02
      expect(p.worstLtv).toBeCloseTo(target, 12)
      expect(p.openLtv).toBeLessThan(sc.line)
    }
  })

  it('every preset crosses, and its first crossing is inside the band (cureWalk-comparable)', () => {
    for (const p of presets) {
      const f = cureWalkInputFor(scenarioFor(p))
      expect(f).not.toBeNull()
      expect(f!.firstCrossingPastBand).toBe(false)
    }
  })
})

describe('INVARIANT: always-hold reproduces cureWalk exactly', () => {
  it.each([0, 1, 2, 3, 4, 5])('preset #%i', (idx) => {
    const p = presets[idx]
    const sc = scenarioFor(p)
    const frame = cureWalkInputFor(sc)!
    const cw = cureWalk(frame.input)
    const st = runToEnd(initialState(sc))
    const s = score(st)
    // Bitwise, not toBeCloseTo.
    expect(st.closedUsd).toBe(cw.closedUsd)
    expect(s.sales).toBe(cw.sales)
    expect(st.timer.breaches).toBe(cw.breaches)
    expect(st.sales[0]?.index ?? null).toBe(cw.closedAtIndex === null ? null : cw.closedAtIndex + frame.crossingIndex)
    expect(st.rebasedAt).toBe(frame.crossingIndex)
    // soldUsd == closedUsd because the census charges no fee.
    expect(s.soldUsd).toBe(st.sales.reduce((a, x) => a + x.repaidUsd, 0))
    // Also the published baseline helper.
    const b = membraneNoAction(sc)
    expect(b.cure!.closedUsd).toBe(st.closedUsd)
    expect(b.score.sales).toBe(cw.sales)
  })

  it('at least one preset sells and one does not (the invariant is not vacuous)', () => {
    const sales = presets.map((p) => cureWalk(cureWalkInputFor(scenarioFor(p))!.input).sales)
    expect(sales.some((n) => n > 0)).toBe(true)
    expect(sales.some((n) => n === 0)).toBe(true)
  })
})

describe('choices', () => {
  const armed = () => {
    const p = presets.find((x) => x.asset === 'BTC' && x.kind === 'through')!
    const st = initialState(scenarioFor(p))
    const r = runToPause(st)
    expect(r.pause).toBe('arm')
    return st
  }

  it('add collateral lowers LTV by exactly 1/(1+x)', () => {
    for (const [c, x] of [['add-10', 0.1], ['add-25', 0.25]] as const) {
      const st = armed()
      const before = currentLtv(st)
      apply(st, c, 'arm')
      expect(currentLtv(st)).toBeLessThan(before)
      expect(currentLtv(st)).toBeCloseTo(before / (1 + x), 12)
      expect(st.addedUsd).toBeGreaterThan(0)
    }
  })

  it('repay-to-borrow-line lands exactly on line − gap', () => {
    const st = armed()
    apply(st, 'repay-to-borrow-line', 'arm')
    expect(currentLtv(st)).toBeCloseTo(st.sc.line - st.sc.gap, 12)
  })

  it('repay-half-way repays half of what reaching the borrow line needs', () => {
    const a = armed()
    const b = armed()
    apply(a, 'repay-to-borrow-line')
    apply(b, 'repay-half-way')
    expect(b.repaidUsd).toBeCloseTo(a.repaidUsd / 2, 9)
    expect(currentLtv(b)).toBeGreaterThan(currentLtv(a))
  })

  it('hold changes nothing', () => {
    const st = armed()
    const before = currentLtv(st)
    apply(st, 'hold', 'arm')
    expect(currentLtv(st)).toBe(before)
    expect(st.choices[0].usd).toBe(0)
  })

  it('repaying to the borrow line on arm saves the window on the next minute', () => {
    const st = armed()
    apply(st, 'repay-to-borrow-line', 'arm')
    step(st)
    expect(st.timer.armed).toBe(false)
  })
})

describe('pauses', () => {
  const collectPauses = (p: Preset) => {
    const st = initialState(scenarioFor(p))
    const log: { i: number; pause: PauseKind; armedAt: number | null }[] = []
    while (!st.finished) {
      const r = step(st)
      if (r.pause) log.push({ i: st.index, pause: r.pause, armedAt: st.armedAt })
    }
    return { st, log }
  }

  it('each kind fires at most once per breach episode, and arm opens every episode', () => {
    for (const p of presets) {
      const { log } = collectPauses(p)
      const byEpisode = new Map<number, PauseKind[]>()
      for (const e of log) {
        expect(e.armedAt).not.toBeNull()
        const k = byEpisode.get(e.armedAt!) ?? []
        k.push(e.pause)
        byEpisode.set(e.armedAt!, k)
      }
      for (const kinds of Array.from(byEpisode.values())) {
        expect(kinds[0]).toBe('arm')
        expect(new Set(kinds).size).toBe(kinds.length)
      }
    }
  })

  it('band-approach fires only within 1 pp of the break line; mid-window only at half the delay', () => {
    for (const p of presets) {
      const sc = scenarioFor(p)
      const { st, log } = collectPauses(p)
      for (const e of log) {
        if (e.pause === 'band-approach') expect(st.ltvTrace[e.i]).toBeGreaterThan(sc.breakLine - BAND_APPROACH_PP)
        if (e.pause === 'mid-window') expect(e.i - e.armedAt!).toBeGreaterThanOrEqual(Math.floor(sc.delaySteps / 2))
      }
    }
  })

  it('the through-the-band presets reach every pause kind somewhere', () => {
    const kinds = new Set<PauseKind>()
    for (const p of presets.filter((x) => x.kind === 'through')) for (const e of collectPauses(p).log) kinds.add(e.pause)
    expect(kinds.has('arm')).toBe(true)
    expect(kinds.has('band-approach')).toBe(true)
  })

  it('pausing does not change the walk: pausing with hold == running straight through', () => {
    for (const p of presets) {
      const a = runToEnd(initialState(scenarioFor(p)), () => 'hold')
      const b = runToEnd(initialState(scenarioFor(p)))
      expect(a.closedUsd).toBe(b.closedUsd)
      expect(a.sales.length).toBe(b.sales.length)
    }
  })
})

describe('score arithmetic', () => {
  it('kept + sold accounts for all collateral on a hold run with one price', () => {
    for (const p of presets) {
      const st = runToEnd(initialState(scenarioFor(p)))
      const s = score(st)
      expect(s.collateralKeptUsd).toBe(st.collBase * st.lastRatio)
      expect(s.collateralKeptPct).toBeCloseTo(st.collBase / st.postedBase, 15)
      expect(s.soldUsd).toBeCloseTo(st.sales.reduce((a, x) => a + x.seizedUsd, 0), 9)
      expect(s.addedUsd).toBe(0)
      expect(s.repaidUsd).toBe(0)
      if (s.sales === 0) expect(s.collateralKeptPct).toBe(1)
      else expect(s.collateralKeptPct).toBeLessThan(1)
    }
  })

  it('an early repay-to-borrow-line never keeps less collateral than holding', () => {
    for (const p of presets) {
      const hold = score(runToEnd(initialState(scenarioFor(p))))
      const act = score(runToEnd(initialState(scenarioFor(p)), () => 'repay-to-borrow-line'))
      expect(act.collateralKeptPct).toBeGreaterThanOrEqual(hold.collateralKeptPct)
    }
  })
})

describe('liquidator column', () => {
  it('uses the measured Aave median repay fraction and liquidates at the same line', () => {
    const measured = readJson('protocols.json').measuredLiquidations
    for (const p of presets) {
      const r = liquidatorBaseline(scenarioFor(p), measured)
      expect(r.repayFraction).toBe(measured.aaveV3.medianRepayFraction)
      expect(r.liquidations).toBeGreaterThan(0)
      expect(r.seizedUsd).toBeGreaterThan(0)
      expect(r.collateralKeptPct).toBeLessThan(1)
    }
  })
})

describe('insolvency: a sale books only the debt the collateral covered (LE:2361-2374)', () => {
  it('an underwater band-break sale closes the collateral value; the rest stays owed', () => {
    // 70k debt on 100k collateral at a 0.80 line. ×0.85 → 0.8235, inside the band: arms.
    // ×0.40 → 40k collateral, LTV 1.75: BrokeWindow. The target is the full 70k debt
    // (LE:2673-2688) but only 40k of collateral exists to repay it.
    const base = makeScenario(data, { asset: PRACTICE_ASSETS[0], openLtv: 0.7, line: 0.8, collateralUsd: 100_000 })
    const sc = { ...base, ratios: [1, 0.85, 0.4, 0.4], count: 4 }
    const st = runToEnd(initialState(sc))
    const s = score(st)
    expect(s.sales).toBe(1)
    expect(st.sales[0].reason).toBe('band')
    expect(s.soldUsd).toBeCloseTo(40_000, 6)
    expect(st.closedUsd).toBeCloseTo(40_000, 6) // was 70,000: bad debt booked as repaid
    expect(st.sales[0].repaidUsd).toBeCloseTo(st.sales[0].seizedUsd, 9)
    expect(s.debtUsd).toBeCloseTo(30_000, 6) // the uncovered remainder: bad debt
    expect(s.collateralKeptUsd).toBeCloseTo(0, 6)
    // Still bitwise-identical to the census walk.
    const frame = cureWalkInputFor(sc)!
    expect(st.closedUsd).toBe(cureWalk(frame.input).closedUsd)
  })
})
