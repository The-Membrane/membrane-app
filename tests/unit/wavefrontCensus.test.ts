/**
 * The full-coverage census (scripts/oct10-coverage/census.ts) on a committed fixture subset of
 * the on-chain pull (tests/unit/fixtures/wavefront-census-fixture.json, 22 positions chosen to
 * hit every branch). The whole-pull run of the same invariants is
 * scripts/tests/wavefront-census.test.ts (it needs the datasets repo).
 *
 *   - the subset reproduces the full census's figures for each of its positions, in the two
 *     runs where positions are independent: the protocol's own line with no liquidity model,
 *     and Membrane's own line with unlimited capacity (the capped headline shares one book
 *     across positions; tests/unit/wavefrontLiquidity.test.ts and the full-pull test cover it);
 *   - both sides are on the same positions; every walked position is located by the
 *     protocol's own check at its t0 event; a mixed split's halves sum to the whole;
 *   - the stream folds without error and its totals are the rows' sums;
 *   - an unsplit single-leg position's kernel walk equals cureWalk on its composite series;
 *   - a held leg with no price at a walked minute is an error, never carried forward.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { cureWalk } from '@/lib/position-sim/curePath'
import {
  BORROW_LTV_GAP,
  CURE_WINDOW_SECONDS,
  LIQ_DEBT_MINIMUM_USD,
  MAX_THRESHOLD_TO_DELAY,
} from '@/lib/position-sim/membrane'
import {
  aaveLocatedAt,
  aavePoolOf,
  aavePositionSpec,
  type AaveEventRecord,
} from '@/lib/wavefront/aave'
import { morphoLocatedAt } from '@/lib/wavefront/morpho'
import { aavePid, morphoPid } from '@/lib/wavefront/pid'
import { replay } from '@/lib/wavefront/stream'
import { buildCensus, type CensusInputs } from '@/scripts/oct10-coverage/census'
import { unrle } from '@/scripts/oct10-coverage/make-census-fixture'

const fx = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'wavefront-census-fixture.json'), 'utf8'),
)
const expandPrices = (p: Record<string, [string | null, number][]>) =>
  Object.fromEntries(Object.entries(p).map(([k, v]) => [k, unrle(v)]))
const inputs: CensusInputs = {
  window: fx.window,
  aaveCsv: fx.aaveCsv,
  aaveEvents: fx.aaveEvents,
  aaveFees: fx.aaveFees,
  aaveOracle: Object.fromEntries(
    Object.entries(fx.aaveOracle).map(([c, f]: [string, any]) => [
      c,
      { ...f, prices: expandPrices(f.prices) },
    ]),
  ),
  morphoCsv: fx.morphoCsv,
  morphoEvents: fx.morphoEvents,
  morphoOracle: Object.fromEntries(
    Object.entries(fx.morphoOracle).map(([c, f]: [string, any]) => [
      c,
      { ...f, prices: expandPrices(f.prices) },
    ]),
  ),
}
/** The pre-2026-10-18 census: the protocol's line, no liquidity model. */
const legacy = buildCensus(inputs, { lineMode: 'protocol', noCapacityModel: true })
/** Membrane's own line, capacity unlimited, on the full census's capacity table. */
const census = buildCensus(inputs, { capacity: fx.capacity, capacityMultiplier: Infinity })
const rows = census.rows
const byPid = new Map(rows.map((r) => [r.pid, r]))
const legacyByPid = new Map(legacy.rows.map((r) => [r.pid, r]))

describe('census on the fixture subset', () => {
  it('has every fixture position, once', () => {
    expect(rows.map((r) => r.pid).sort()).toEqual([...fx.pids].sort())
  })

  it('reproduces the full census figures for every position, in both independent runs', () => {
    for (const pid of fx.pids as string[]) {
      const e = fx.expected[pid]
      for (const [run, got] of [
        ['protocol', legacyByPid.get(pid)!],
        ['membrane', byPid.get(pid)!],
      ] as const) {
        const x = e[run]
        const r = got
        const at = `${run} ${pid}`
        expect(r.walked, at).toBe(e.walked)
        expect(r.t0?.priceBasis ?? null, at).toBe(e.priceBasis)
        expect(r.line, at).toBe(e.line)
        expect(r.ltv0, at).toBe(e.ltv0)
        // provenance only: real seized is never a comparison, but it must not move
        expect(r.real.repaidUsd, at).toBe(e.realRepaidUsd)
        expect(r.real.seizedUsd, at).toBe(e.realSeizedUsd)
        expect(r.real.protocolFeeUsd, at).toBe(e.realProtocolFeeUsd)
        expect(r.real.badDebtUsd, at).toBe(e.realBadDebtUsd)
        expect(r.excluded ?? null, at).toBe(x.excluded)
        expect(r.delayClass, at).toBe(x.delayClass)
        expect(r.memLine?.line ?? null, at).toBe(x.memLine)
        expect(r.mem?.repaidUsd ?? null, at).toBe(x.memRepaidUsd)
        expect(r.mem?.closedT0 ?? null, at).toBe(x.memClosedT0)
        expect(r.mem?.outcome ?? null, at).toBe(x.memOutcome)
        expect(r.mem?.sales ?? null, at).toBe(x.memSales)
      }
    }
  })

  it('walks at Membrane’s line in the headline modes, the protocol’s in the legacy run', () => {
    for (const r of rows) {
      if (r.excluded === 'no-membrane-line') {
        expect(r.memLine, r.pid).toBeUndefined()
        expect(r.mem, r.pid).toBeNull()
        continue
      }
      expect(r.memLine, r.pid).toBeDefined()
      const open = census.records.find((x) => x.kind === 'open' && x.pid === r.pid) as any
      expect(open.line).toBe(Math.round(r.memLine!.line * 1e6) / 1e6)
    }
    for (const r of legacy.rows) expect(r.memLine, r.pid).toBeUndefined()
    // the whale holds AAVE only: Membrane has no line for it
    expect(rows.some((r) => r.excluded === 'no-membrane-line')).toBe(true)
  })

  it('covers the branches it was picked for', () => {
    const outcomes = new Set(legacy.rows.map((r) => r.mem?.outcome))
    for (const o of [
      'sold-at-t0',
      'sold-at-band',
      'sold-no-delay',
      'cured-then-held',
      'sold-at-grid-end',
    ]) {
      expect(outcomes.has(o as any), o).toBe(true)
    }
    // the two positions not located at block N (Aave and Morpho) are walked at N-1 prices
    expect(rows.every((r) => r.walked)).toBe(true)
    expect(rows.some((r) => r.t0?.priceBasis === 'N-1')).toBe(true)
    expect(rows.some((r) => r.marketLabel === 'lido')).toBe(true)
    expect(rows.some((r) => r.protocol === 'morpho-blue' && r.chain === 'arbitrum')).toBe(true)
    expect(rows.some((r) => r.real.protocolFeeUsd > 0)).toBe(true)
    expect(legacy.rows.some((r) => r.mem?.subs?.some((s) => s.startUnbreached))).toBe(true)
    expect(rows.some((r) => r.real.badDebtUsd > 0)).toBe(true)
    expect(rows.some((r) => r.real.unpricedEvents > 0)).toBe(true)
  })
})

describe('census invariants (fixture)', () => {
  it('both sides are on the same positions', () => {
    for (const r of rows) {
      expect(r.real.events, r.pid).toBeGreaterThan(0)
      expect(r.mem !== null, r.pid).toBe(r.walked && !r.excluded)
      if (!r.walked) expect(r.reason, r.pid).toBeTruthy()
      if (r.excluded) expect(r.excludedDetail, r.pid).toBeTruthy()
    }
    const memPids = new Set(
      census.records.filter((x) => x.kind === 'mem').map((x) => (x as any).pid),
    )
    const realPids = new Set(
      census.records.filter((x) => x.kind === 'real').map((x) => (x as any).pid),
    )
    for (const p of memPids) expect(byPid.get(p)!.mem).not.toBeNull()
    expect(realPids.size).toBe(rows.length)
  })

  it('every walked position is located by the protocol at its t0 event', () => {
    for (const r of rows) {
      if (r.protocol === 'aave-v3') {
        const evs = (inputs.aaveEvents as AaveEventRecord[])
          .filter((e) => aavePid(e.chain, aavePoolOf(e), e.user) === r.pid)
          .sort((a, b) => a.block_number - b.block_number || a.log_index - b.log_index)
        // t0 = the first event located at block-N prices, else at N-1 prices, in that order
        const loc = evs.filter((e) => aaveLocatedAt(e, 'N') || aaveLocatedAt(e, 'N-1'))
        if (r.walked) {
          expect(r.t0!.block, r.pid).toBe(loc[0].block_number)
          expect(r.t0!.priceBasis, r.pid).toBe(aaveLocatedAt(loc[0], 'N') ? 'N' : 'N-1')
          expect(r.ltv0! > r.line!, r.pid).toBe(true)
        } else expect(loc.length, r.pid).toBe(0)
      } else {
        const evs = inputs.morphoEvents
          .filter((e) => morphoPid(e.chain, e.market_id, e.borrower) === r.pid)
          .sort((a, b) => a.block_number - b.block_number || a.log_index - b.log_index)
        const loc = evs.filter((e) => morphoLocatedAt(e, 'N') || morphoLocatedAt(e, 'N-1'))
        if (r.walked) {
          expect(r.t0!.block, r.pid).toBe(loc[0].block_number)
          expect(r.t0!.priceBasis, r.pid).toBe(morphoLocatedAt(loc[0], 'N') ? 'N' : 'N-1')
        } else expect(loc.length, r.pid).toBe(0)
      }
    }
  })

  it('a mixed split sums its debt and collateral to the whole', () => {
    const splits = rows.filter((r) => r.mem?.subs)
    expect(splits.length).toBeGreaterThanOrEqual(2)
    for (const r of splits) {
      const subs = r.mem!.subs!
      expect(Math.abs(subs.reduce((a, s) => a + s.share, 0) - 1)).toBeLessThan(1e-12)
      const open = census.records.find((x) => x.kind === 'open' && x.pid === r.pid) as any
      const d = open.subs.reduce((a: number, s: any) => a + s.debtUsd, 0)
      expect(Math.abs(d - open.debtUsd)).toBeLessThanOrEqual(0.02)
      // the halves' own symbols partition the collateral
      expect(subs.flatMap((s) => s.symbols).sort()).toEqual(
        r.collateral.map((c) => c.symbol).sort(),
      )
      expect(subs[0].delayClass).toBe('no-delay')
      expect(r.mem!.closedT0).toBeCloseTo(
        subs.reduce((a, s) => a + s.closedT0, 0),
        9,
      )
    }
  })

  it('the stream folds, and its totals are the WALKED rows sums (same positions both sides)', () => {
    const s = replay(census.records)
    // the stream's `walked` is the compared set: located and not excluded
    const walked = rows.filter((r) => r.mem)
    expect(s.coverage.total).toBe(rows.length)
    expect(s.coverage.walked).toBe(walked.length)
    const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(0.02)
    near(
      s.totals.real.repaidUsd,
      walked.reduce((a, r) => a + r.real.repaidUsd, 0),
    )
    near(
      s.totals.real.soldUsd,
      walked.reduce((a, r) => a + r.real.seizedUsd, 0),
    )
    near(
      s.totals.real.badDebtUsd,
      walked.reduce((a, r) => a + r.real.badDebtUsd, 0),
    )
    near(
      s.totals.mem.repaidUsd,
      rows.reduce((a, r) => a + (r.mem?.repaidUsd ?? 0), 0),
    )
    expect(s.totals.mem.positionsSold).toBe(rows.filter((r) => (r.mem?.sales ?? 0) > 0).length)
    expect(s.totals.mem.positionsArmed).toBe(0)
  })

  it('an unsplit single-leg Aave walk equals cureWalk on its composite series', () => {
    // cureWalk is handed the protocol's line: the legacy run walks at that line.
    let n = 0
    for (const r of legacy.rows) {
      if (r.protocol !== 'aave-v3' || !r.walked || !r.mem || r.mem.subs) continue
      if (r.collateral.length !== 1 || r.debt.length !== 1) continue
      const evs = (inputs.aaveEvents as AaveEventRecord[]).filter(
        (e) => aavePid(e.chain, aavePoolOf(e), e.user) === r.pid,
      )
      const spec = aavePositionSpec(evs, {
        startTs: fx.window.startTs,
        stepSeconds: 60,
        debtMinimumUsd: LIQ_DEBT_MINIMUM_USD,
      })
      const c = spec.collateral[0]
      const d = spec.debt[0]
      const col = (k: string) =>
        inputs.aaveOracle[`${spec.chain}:${spec.market}`].prices[k].map((v) =>
          v == null ? NaN : Number(v),
        )
      const cc = col(c.key)
      const dc = col(d.key)
      const i0 = spec.t0!.minute
      const ratios = [1]
      for (let m = i0 + 1; m < fx.window.minutes; m++) ratios.push(cc[m] / c.p0 / (dc[m] / d.p0))
      const w = cureWalk({
        debtUsd: d.value0,
        collateralUsd: c.value0,
        line: spec.line!,
        band: MAX_THRESHOLD_TO_DELAY,
        delaySeconds: CURE_WINDOW_SECONDS,
        stepSeconds: 60,
        gap: BORROW_LTV_GAP,
        ratios,
        debtMinimumUsd: LIQ_DEBT_MINIMUM_USD,
        maxSales: 20,
        noDelay: spec.halves[0].delayClass === 'no-delay',
      })
      expect(Math.abs(w.closedUsd - r.mem!.closedT0), r.pid).toBeLessThanOrEqual(1e-6)
      expect(w.outcome, r.pid).toBe(r.mem!.outcome)
      n++
    }
    expect(n).toBeGreaterThanOrEqual(3)
  })

  it('a held leg with no price at a minute it is walked through is an error, never carried forward', () => {
    const r = legacy.rows.find(
      (x) =>
        x.protocol === 'aave-v3' &&
        x.walked &&
        !x.mem!.subs &&
        x.mem!.sales === 0 &&
        x.t0!.minute < fx.window.minutes - 2,
    )!
    expect(r, 'a never-sold Aave position in the fixture').toBeDefined()
    const evs = (inputs.aaveEvents as AaveEventRecord[]).filter(
      (e) => aavePid(e.chain, aavePoolOf(e), e.user) === r.pid,
    )
    const spec = aavePositionSpec(evs, {
      startTs: fx.window.startTs,
      stepSeconds: 60,
      debtMinimumUsd: LIQ_DEBT_MINIMUM_USD,
    })
    const scope = `${spec.chain}:${spec.market}`
    const key = spec.collateral[0].key
    const holed = [...inputs.aaveOracle[scope].prices[key]]
    holed[r.t0!.minute + 1] = null
    const gap: CensusInputs = {
      ...inputs,
      aaveOracle: {
        ...inputs.aaveOracle,
        [scope]: {
          ...inputs.aaveOracle[scope],
          prices: { ...inputs.aaveOracle[scope].prices, [key]: holed },
        },
      },
    }
    expect(() => buildCensus(gap)).toThrow(/no price/)
  })
})
