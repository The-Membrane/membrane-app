/**
 * The incumbent twin (lib/position-sim/incumbentTwin.ts): each venue's real close factor,
 * threshold and bonus, run on the stress grid's own price path, and PARITY with the Oct 10
 * replay of the per-address simulator (compare.ts runComparison).
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_INPUTS,
  LOADOUTS,
  computeFrontier,
  detailRows,
  priceFromNowText,
  stockSourceText,
  TWIN_MARK,
  type FrontierModel,
} from '@/components/RiskFrontier/viewModel'
import { measuredRepayFraction, runComparison } from '@/lib/position-sim/compare'
import {
  DEFAULT_INCUMBENT,
  INCUMBENT_ORDER,
  INCUMBENT_READ_BLOCK,
  INCUMBENT_TWINS,
  MORPHO_LIQUIDATION_CURSOR,
  MORPHO_MAX_LIF,
  SETTLE_STEPS,
  incumbentCloseFactor,
  morphoLiquidationBonus,
  runIncumbentOnPath,
  runIncumbentTwin,
  runStressGridWithTwin,
  type IncumbentRules,
} from '@/lib/position-sim/incumbentTwin'
import { MEMBRANE_CLASS_PARAMS } from '@/lib/position-sim/membrane'
import {
  SYMBOL_TO_SERIES,
  buildPricePath,
  type Oct10Manifest,
  type Oct10Series,
} from '@/lib/position-sim/scenario'
import { oct10ReplayShape, runStress, type StressPosition } from '@/lib/position-sim/stressGrid'
import {
  stamp,
  type PricePath,
  type ProtocolPosition,
  type SimEvent,
} from '@/lib/position-sim/types'

const read = (rel: string) =>
  JSON.parse(readFileSync(path.resolve(__dirname, '../../public/data', rel), 'utf8'))
const PRICES = read('oct10-2025/prices-1m.json') as Oct10Series
const MANIFEST = read('oct10-2025/manifest.json') as Oct10Manifest
const PROTOCOLS = read('oct10-2025/protocols.json')
const EVIDENCE = read('oct10-2025/evidence.json')
const DEMO = read('demo-borrower.json')

/** The sandbox's illustrative carry position: $44,000 against $31,400, LTV 71.4%. */
const POS: StressPosition = {
  collateralUsd: 44_000,
  debtUsd: 31_400,
  line: 0.86,
  membraneClass: 'delayed',
  tradeShape: 'levered_long',
}

const step = (drop: number) => ({ price: { kind: 'step' as const, drop } })

function twinAt(id: (typeof INCUMBENT_ORDER)[number], drop: number) {
  const t = runIncumbentTwin(POS, step(drop), id)
  expect(t, `${id} at −${drop * 100}%`).not.toBeNull()
  return t!
}

describe('incumbent twin — real parameters', () => {
  it('pins Aave V3 WETH to the Oct 10 on-chain read', () => {
    const r = PROTOCOLS.aaveV3.reserves.WETH
    const a = INCUMBENT_TWINS['aave-v3']
    expect(PROTOCOLS.readBlock).toBe(INCUMBENT_READ_BLOCK)
    expect(a.liquidationThreshold).toBe(r.liquidationThresholdPct / 100)
    expect(a.liquidationBonus).toBeCloseTo(r.liquidationBonusPct / 100 - 1, 12)
    const doc = PROTOCOLS.aaveV3.closeFactor.documented
    expect(a.closeFactor).toEqual({
      kind: 'aave-v3.3',
      defaultFactor: doc.DEFAULT_LIQUIDATION_CLOSE_FACTOR_pct / 100,
      hfThreshold: doc.CLOSE_FACTOR_HF_THRESHOLD,
      minBaseUsd: doc.MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD_usd,
      minLeftoverUsd: doc.MIN_LEFTOVER_BASE_usd,
    })
  })

  it('pins Morpho Blue to its immutable LIF constants and the WETH/USDC 86% market', () => {
    const li = PROTOCOLS.morphoBlue.liquidationIncentive
    expect(MORPHO_MAX_LIF).toBe(li.MAX_LIQUIDATION_INCENTIVE_FACTOR)
    expect(MORPHO_LIQUIDATION_CURSOR).toBe(li.LIQUIDATION_CURSOR)
    expect(PROTOCOLS.morphoBlue.hasCloseFactor).toBe(false)
    const market =
      PROTOCOLS.morphoBlue.markets[
        '0x7dde86a1e94561d9690ec678db673c1a6396365f7d1d65e129c5fff0990ff758'
      ]
    expect([market.collateralSymbol, market.loanSymbol]).toEqual(['WETH', 'USDC'])
    const m = INCUMBENT_TWINS['morpho-blue']
    expect(m.liquidationThreshold).toBe(market.lltvPct / 100)
    // LIF = min(1.15, 1 / (1 − 0.3 × 0.14)) = 1 / 0.958
    expect(m.liquidationBonus).toBeCloseTo(1 / 0.958 - 1, 12)
    expect(morphoLiquidationBonus(0.385)).toBeCloseTo(0.15, 12) // the 1.15 cap binds
    expect(m.closeFactor).toEqual({ kind: 'whole-loan' })
  })

  it('carries Spark as read on-chain at the same block, with its v3.0 close factor', () => {
    const s = INCUMBENT_TWINS.spark
    expect([s.liquidationThreshold, s.liquidationBonus]).toEqual([0.86, 0.05])
    expect(s.closeFactor).toEqual({ kind: 'aave-v3.0', defaultFactor: 0.5, hfThreshold: 0.95 })
    expect(s.provenance).toContain('23,543,615')
  })

  it('names every number it uses', () => {
    for (const id of INCUMBENT_ORDER) {
      const r = INCUMBENT_TWINS[id]
      expect(r.id).toBe(id)
      expect(r.provenance).toContain('block 23,543,615')
    }
    expect(DEFAULT_INCUMBENT).toBe('aave-v3')
  })
})

describe('incumbent twin — close factor rules', () => {
  const s = (healthFactor: number, collateralUsd: number, debtUsd: number, bonus = 0.05) => ({
    healthFactor,
    collateralUsd,
    debtUsd,
    bonus,
  })
  const aave = INCUMBENT_TWINS['aave-v3'].closeFactor
  const spark = INCUMBENT_TWINS.spark.closeFactor

  it('Aave v3.3: half above HF 0.95 with both sides at $2,000 or more, else the whole debt', () => {
    expect(incumbentCloseFactor(aave, s(0.99, 50_000, 40_000))).toBe(0.5)
    expect(incumbentCloseFactor(aave, s(0.95, 50_000, 40_000))).toBe(1) // strict >
    expect(incumbentCloseFactor(aave, s(0.94, 50_000, 40_000))).toBe(1)
    expect(incumbentCloseFactor(aave, s(0.99, 50_000, 1_999))).toBe(1)
    expect(incumbentCloseFactor(aave, s(0.99, 1_999, 1_900))).toBe(1)
  })

  it('Aave v3.3: a partial that would leave under $1,000 on either side takes the whole debt', () => {
    // debt 2,000 → leaves 1,000: stands
    expect(incumbentCloseFactor(aave, s(0.99, 2_050, 2_000))).toBe(0.5)
    // collateral 2,040 − 1,050 seized → 990 left: dust → whole debt
    expect(incumbentCloseFactor(aave, s(0.99, 2_040, 2_000))).toBe(1)
    // a seize that takes ALL the collateral is not a partial on that side
    expect(incumbentCloseFactor(aave, s(0.99, 1_000_000, 1_999_999))).toBe(0.5)
  })

  it('Spark v3.0: half above HF 0.95 at any size, no dust rule', () => {
    expect(incumbentCloseFactor(spark, s(0.96, 1_000, 900))).toBe(0.5)
    expect(incumbentCloseFactor(spark, s(0.95, 1_000, 900))).toBe(1)
    expect(incumbentCloseFactor(spark, s(0.99, 2_040, 2_000))).toBe(0.5)
  })

  it('Morpho: the whole debt; fixed: the given share', () => {
    expect(incumbentCloseFactor({ kind: 'whole-loan' }, s(0.999, 1e6, 9e5))).toBe(1)
    expect(incumbentCloseFactor({ kind: 'fixed', fraction: 0.578 }, s(0.5, 1, 1))).toBe(0.578)
  })
})

describe('incumbent twin — on the stress grid', () => {
  // Start LTV 31,400 / 44,000 = 71.4%. Hand-computed:
  //   −15%: LTV 84.0%. Aave (83%) HF 0.989 → 50%: repay 15,700, seize 16,485 (785 bonus).
  //   −20%: LTV 89.2%. Aave HF 0.930 → whole: seize 32,970. Spark (86%) HF 0.964 → 50%.
  //   −25%: LTV 95.2%. Aave and Spark whole: 31,400 × 1.05 = 32,970. Morpho × 1/0.958.
  it('sells what each venue would at a held step', () => {
    const cases: [(typeof INCUMBENT_ORDER)[number], number, number, number | null][] = [
      ['aave-v3', 0.1, 0, null],
      ['aave-v3', 0.15, 16_485, 0.85],
      ['aave-v3', 0.2, 32_970, 0.8],
      ['aave-v3', 0.25, 32_970, 0.75],
      ['spark', 0.15, 0, null],
      ['spark', 0.2, 16_485, 0.8],
      ['spark', 0.25, 32_970, 0.75],
      ['morpho-blue', 0.15, 0, null],
      ['morpho-blue', 0.25, 31_400 / 0.958, 0.75],
    ]
    for (const [id, drop, sold, price] of cases) {
      const t = twinAt(id, drop)
      expect(t.incumbentSoldUsd, `${id} −${drop}`).toBeCloseTo(sold, 6)
      expect(t.incumbentLiquidationPrice, `${id} −${drop}`).toBe(price)
    }
    const a = twinAt('aave-v3', 0.15)
    expect(a.incumbentBonusUsd).toBeCloseTo(785, 6)
    expect(a.incumbentRepaidUsd).toBeCloseTo(15_700, 6)
    expect([a.incumbentLiquidations, a.incumbentTimeToLiquidationSeconds]).toEqual([1, 60])
  })

  it('puts Membrane next to it on the same node', () => {
    const t = twinAt('aave-v3', 0.5)
    const r = runStress(POS, step(0.5))
    if (r.outcome === 'not_modelled') throw new Error('modelled')
    expect(t.membraneSoldUsd).toBe(r.exposedUsd)
    expect(t.membraneLiquidationPrice).toBe(0.5)
    // −50%: $22,000 of collateral against $31,400: Aave takes all of it, the rest is bad debt.
    expect(t.incumbentSoldUsd).toBeCloseTo(22_000, 6)
    expect(t.incumbentBadDebtUsd).toBeCloseTo(31_400 - 22_000 / 1.05, 6)
    // A node with no sale has no Membrane price.
    expect(twinAt('aave-v3', 0.1).membraneLiquidationPrice).toBeNull()
  })

  it('repeats a partial while the position stays over the line, two steps apart', () => {
    // Spark at a slow decline: 50% at the first step past 86%, then again past it.
    const t = runIncumbentTwin(POS, { price: { kind: 'linear', drop: 0.5, hours: 24 } }, 'spark')!
    expect(t.incumbentLiquidations).toBeGreaterThan(1)
    for (let k = 1; k < t.events.length; k++)
      expect(t.events[k].minute - t.events[k - 1].minute).toBeGreaterThanOrEqual(2)
  })

  it('holds the price after a no-delay path so a second liquidation can fire', () => {
    // A no-delay node's path ends one step after its shape. Spark at −21.1%: LTV 90.45%,
    // HF 0.951 → 50%; LTV after 86.12% is still over 86% → a second 50% two steps later.
    const nd: StressPosition = { ...POS, membraneClass: 'no-delay', line: 0.95 }
    const r = runStress(nd, step(0.211))
    if (r.outcome === 'not_modelled') throw new Error('modelled')
    expect(r.horizonSeconds).toBe(2 * 60)
    const t = runIncumbentTwin(nd, step(0.211), 'spark')!
    expect(t.events.map((e) => e.minute)).toEqual([1, 3])
    expect(t.incumbentRepaidUsd).toBeCloseTo(15_700 + 7_850, 6)
    expect(t.horizonSeconds).toBe(r.horizonSeconds + SETTLE_STEPS * 60)
  })

  it('is the same for every venue condition on a price shape (the incumbent has no recall)', () => {
    const carry: StressPosition = {
      ...POS,
      tradeShape: 'carry',
      deployedUsd: 14_200,
      exitCapacityPreset: 'aave-usdc-50m-typical',
    }
    const cells = runStressGridWithTwin(carry, 'aave-v3')
    expect(cells.length).toBeGreaterThan(5)
    const byShape = new Map<string, number>()
    for (const c of cells) {
      if (!c.twin) continue
      const k = JSON.stringify(c.scenario.price)
      const seen = byShape.get(k)
      if (seen === undefined) byShape.set(k, c.twin.incumbentSoldUsd)
      else expect(c.twin.incumbentSoldUsd).toBe(seen)
      if (c.result.outcome !== 'not_modelled')
        expect(c.twin.membraneSoldUsd).toBe(c.result.exposedUsd)
    }
    expect(byShape.size).toBe(5)
  })

  it('is null where the Membrane node is not modelled', () => {
    const noCap: StressPosition = { ...POS, tradeShape: 'carry', deployedUsd: 10_000 }
    expect(runStress(noCap, step(0.25)).outcome).toBe('not_modelled')
    expect(runIncumbentTwin(noCap, step(0.25))).toBeNull()
  })
})

// ------------------------------------------------------------- Oct 10 parity

/**
 * The twin's domain is the stress grid's: one collateral asset against a STABLE debt held at
 * $1. So the parity cohort is every census account the tape can price that holds a position
 * (collateral and debt above $0) against a USD stable debt. An ETH or BTC debt (WETH/WETH
 * e-mode, rETH, cbBTC …) is a different position, not a twin of a stress node.
 */
const USD_STABLE_DEBT = new Set(['USDC', 'USDT', 'USD₮0', 'GHO', 'USDbC', 'DAI', 'LUSD'])
const ROWS = (EVIDENCE.cohort as any[]).filter(
  (r) =>
    !r.excluded &&
    r.collateralUsd > 0 &&
    r.debtUsd > 0 &&
    USD_STABLE_DEBT.has(r.debtSymbol) &&
    SYMBOL_TO_SERIES[r.collSymbol] &&
    PRICES.columns[SYMBOL_TO_SERIES[r.collSymbol]],
)

/** One census account on the measured path from its anchor (scripts/tests/position-sim.test.ts). */
function censusReplay(row: any) {
  const col = PRICES.columns[SYMBOL_TO_SERIES[row.collSymbol]]
  const i0: number = row.t0Index
  const p0: number = row.pLiqColl ?? col[i0]
  const prices = [p0, ...col.slice(i0 + 1)]
  const count = prices.length
  const pricePath: PricePath = {
    startTs: PRICES.startTs + i0 * PRICES.stepSeconds,
    stepSeconds: PRICES.stepSeconds,
    count,
    series: { [row.collSymbol]: prices, [row.debtSymbol]: new Array(count).fill(1) },
    provenance: stamp('dataset', 'oct10 census replay', 'test', 0),
  }
  const position: ProtocolPosition = {
    protocol: 'aave-v3',
    label: 'Aave V3',
    collateral: [
      {
        symbol: row.collSymbol,
        address: '0x0',
        decimals: 18,
        amount: row.collateralUsd / p0,
        priceUsd: p0,
        valueUsd: row.collateralUsd,
        liquidationThreshold: row.liqLine,
        maxLtv: row.liqLine,
        liquidationBonus: 0.05,
      },
    ],
    debt: [
      {
        symbol: row.debtSymbol,
        address: '0x1',
        decimals: 6,
        amount: row.debtUsd,
        priceUsd: 1,
        valueUsd: row.debtUsd,
        borrowApr: null,
      },
    ],
    totalCollateralUsd: row.collateralUsd,
    totalDebtUsd: row.debtUsd,
    ltv: row.debtUsd / row.collateralUsd,
    liquidationLtv: row.liqLine,
    healthFactor: (row.liqLine * row.collateralUsd) / row.debtUsd,
    provenance: stamp('dataset', 'oct10 census row', row.user, 0),
  }
  return { prices, pricePath, position, count }
}

const PARITY_FRACTION = 0.578

/** The twin rules the census replay runs: the row's line, 5% bonus, the measured repay share. */
const parityRules = (liqLine: number): IncumbentRules => ({
  ...INCUMBENT_TWINS['aave-v3'],
  liquidationThreshold: liqLine,
  liquidationBonus: 0.05,
  closeFactor: { kind: 'fixed', fraction: PARITY_FRACTION },
})

const runComparisonSource = (position: ProtocolPosition, pricePath: PricePath, label = '57.8%') =>
  runComparison(position, pricePath, [], {
    membraneLiqFee: 0,
    venue: null,
    sourceRepayFraction: PARITY_FRACTION,
    sourceRepayFractionLabel: label,
    scenarioLabel: 'oct10',
  }).source

const liqs = (events: SimEvent[]) => events.filter((e) => e.kind === 'liquidation')

function expectSameEvents(a: SimEvent[], b: SimEvent[], tag: string, rel: number) {
  expect(
    a.map((e) => e.minute),
    `${tag}: liquidation minutes`,
  ).toEqual(b.map((e) => e.minute))
  for (let k = 0; k < a.length; k++) {
    for (const f of ['repaidUsd', 'seizedUsd', 'penaltyUsd'] as const) {
      const x = a[k][f]
      const y = b[k][f]
      expect(Math.abs(x - y), `${tag}: event ${k} ${f} ${x} vs ${y}`).toBeLessThanOrEqual(
        rel * Math.max(1, Math.abs(y)),
      )
    }
  }
}

describe('incumbent twin — parity with the Oct 10 replay (runComparison)', () => {
  it('covers the priced census', () => {
    expect(ROWS.length).toBeGreaterThan(500)
    // The tape liquidates a good share of them, so parity is tested on real events.
    const fired = ROWS.filter(
      (r) =>
        liqs(runComparisonSource(censusReplay(r).position, censusReplay(r).pricePath).events)
          .length > 0,
    )
    expect(fired.length).toBeGreaterThan(500)
  })

  it('the one-leg engine reproduces runComparison on every priced census account', () => {
    let events = 0
    for (const row of ROWS) {
      const { prices, pricePath, position } = censusReplay(row)
      const src = runComparisonSource(position, pricePath)
      // Forward-filled exactly as compare.ts `priceAt` reads the tape.
      let last = prices[0] as number
      const ratios = prices.map((p) => {
        if (p !== null) last = p
        return last / (prices[0] as number)
      })
      const twin = runIncumbentOnPath(
        row.collateralUsd,
        row.debtUsd,
        ratios,
        PRICES.stepSeconds,
        parityRules(row.liqLine),
      )
      expectSameEvents(liqs(twin.events), liqs(src.events), row.user, 1e-9)
      expect(twin.endDebtUsd).toBeCloseTo(src.endDebtUsd, 4)
      expect(twin.endCollateralUsd).toBeCloseTo(src.endCollateralUsd, 4)
      events += liqs(src.events).length
    }
    expect(events).toBeGreaterThan(1_000)
  })

  it('the full adapter (stress node → twin) lands on the same liquidations', () => {
    // Through runIncumbentTwin: the node normalizes the position to cents and the replay to
    // 8 decimals, and holds a tail. Same minutes, same dollars to 1e-6.
    const ceiling = MEMBRANE_CLASS_PARAMS.delayed.ltvCeiling
    for (const row of ROWS) {
      const { prices, pricePath, position, count } = censusReplay(row)
      const src = runComparisonSource(position, pricePath)
      const node: StressPosition = {
        collateralUsd: row.collateralUsd,
        debtUsd: row.debtUsd,
        line: Math.min(row.liqLine, ceiling),
        membraneClass: 'delayed',
        tradeShape: 'levered_long',
      }
      const twin = runIncumbentTwin(
        node,
        { price: { kind: 'replay', id: `census:${row.user}`, stepSeconds: 60, ratios: prices } },
        parityRules(row.liqLine),
      )
      expect(twin, row.user).not.toBeNull()
      const inWindow = twin!.events.filter((e) => e.minute < count)
      expectSameEvents(inWindow, liqs(src.events), row.user, 1e-6)
      // The hold after the tape adds an event only when the tape ENDS over the line.
      const endLtv = src.endCollateralUsd > 0 ? src.endDebtUsd / src.endCollateralUsd : Infinity
      if (endLtv <= row.liqLine) expect(twin!.events.length, row.user).toBe(inWindow.length)
      // The node's price at that step: the tape forward-filled, ÷ its anchor, to 8 decimals.
      const first = liqs(src.events)[0]
      let at: number | null = null
      if (first) {
        let k = first.minute
        while (prices[k] === null) k--
        at = Math.round(((prices[k] as number) / (prices[0] as number)) * 1e8) / 1e8
      }
      expect(twin!.incumbentLiquidationPrice, row.user).toBe(at)
    }
  })

  it('the demo wallet: the page’s Oct 10 replay and the twin agree', () => {
    // The page's own replay (oct10ReplayShape, the ETH oracle from minute 0) against the page's
    // own comparison engine with the measured Aave repay share.
    const position = DEMO.position as ProtocolPosition
    const { path: pricePath, unpriced } = buildPricePath(PRICES, MANIFEST, [
      ...position.collateral.map((c) => c.symbol),
      ...position.debt.map((d) => d.symbol),
    ])
    expect(unpriced).toEqual([])
    const repay = measuredRepayFraction(position.protocol, PROTOCOLS.measuredLiquidations)
    const src = runComparison(position, pricePath, unpriced, {
      membraneLiqFee: 0,
      venue: null,
      sourceRepayFraction: repay.fraction,
      sourceRepayFractionLabel: repay.label,
      scenarioLabel: 'oct10',
    }).source
    const shape = oct10ReplayShape(PRICES, 'WETH')!
    const c0 = position.collateral[0]
    const first = (PRICES.columns.ethOracle as (number | null)[]).find((v) => v != null) as number
    const node: StressPosition = {
      collateralUsd: c0.amount * first,
      debtUsd: position.debt.reduce((a, d) => a + d.amount, 0),
      line: position.liquidationLtv,
      membraneClass: 'delayed',
      tradeShape: 'levered_long',
    }
    const twin = runIncumbentTwin(
      node,
      { price: shape },
      {
        ...INCUMBENT_TWINS['aave-v3'],
        liquidationThreshold: position.liquidationLtv,
        liquidationBonus: c0.liquidationBonus ?? 0,
        closeFactor: { kind: 'fixed', fraction: repay.fraction },
      },
    )!
    expect(liqs(src.events).length).toBeGreaterThan(0)
    expectSameEvents(
      twin.events.filter((e) => e.minute < pricePath.count),
      liqs(src.events),
      'demo',
      1e-6,
    )
  })
})

// --------------------------------------------------------------- view model

describe('incumbent twin — view model', () => {
  const replay = oct10ReplayShape(PRICES, 'WETH')

  /** Every twin string the screen shows. */
  function twinStrings(m: FrontierModel): string[] {
    const out: string[] = []
    for (const row of m.swatch.rows) for (const c of row.cells) out.push(c.twinText ?? '')
    for (const lane of m.tree)
      if (lane.result)
        for (const r of detailRows(
          lane.result,
          stockSourceText(m.sandbox.position, lane.scenario?.venue),
          lane.twin,
        ))
          out.push(r.label, r.value)
    for (const c of m.crash)
      for (const r of detailRows(c.node, 'x', c.twin)) out.push(r.label, r.value)
    return out
  }

  it('puts the twin on every modelled lane, crash level and swatch cell', () => {
    const m = computeFrontier(DEFAULT_INPUTS, replay)
    expect(m.incumbent.id).toBe('aave-v3')
    for (const lane of m.tree)
      expect(lane.twin === null, lane.id).toBe(
        !lane.result || lane.result.outcome === 'not_modelled',
      )
    for (const c of m.crash) expect(c.twin).not.toBeNull()
    for (const row of m.swatch.rows)
      for (const c of row.cells) {
        expect(c.twin === null).toBe(c.result.outcome === 'not_modelled')
        if (c.twin) expect(c.twinText).toContain(TWIN_MARK)
      }
    // −25% step lane: Aave would take the whole loan plus its bonus.
    const lane = m.tree.find((l) => l.id === 'step25')!
    expect(lane.twin!.incumbentSoldUsd).toBeCloseTo(31_400 * 1.05, 6)
  })

  it('runs the chosen incumbent', () => {
    for (const id of INCUMBENT_ORDER) {
      const m = computeFrontier({ ...DEFAULT_INPUTS, incumbent: id }, null)
      expect(m.incumbent.id).toBe(id)
      expect(m.tree.find((l) => l.id === 'step25')!.twin!.incumbent).toBe(id)
    }
  })

  it('marks every twin figure † and "would", and ends on the modelled note', () => {
    const m = computeFrontier(DEFAULT_INPUTS, replay)
    const lane = m.tree.find((l) => l.id === 'step25')!
    const rows = detailRows(lane.result!, 'x', lane.twin)
    const twin = rows.filter((r) => r.label.startsWith('Aave V3'))
    expect(twin.length).toBeGreaterThanOrEqual(2)
    for (const r of twin) expect(r.label.endsWith(TWIN_MARK)).toBe(true)
    expect(rows.find((r) => r.label === `Aave V3 would sell ${TWIN_MARK}`)!.value).toBe(
      '$32,970 · $1,570 of it bonus',
    )
    expect(rows.find((r) => r.label === `Aave V3 first liquidation ${TWIN_MARK}`)!.value).toBe(
      '25% below now · at 1m',
    )
    const note = rows.find((r) => r.label === `${TWIN_MARK} modelled`)!.value
    expect(note).toContain('Modelled')
    expect(note).toContain('includes its bonus')
    expect(note).toContain('leaves out its fees')
    // Without a twin the rows are Membrane's own, unchanged.
    expect(detailRows(lane.result!, 'x').some((r) => r.label.includes(TWIN_MARK))).toBe(false)
  })

  it('keeps the copy rules on every loadout and every incumbent', () => {
    for (const l of LOADOUTS)
      for (const id of INCUMBENT_ORDER) {
        const text = twinStrings(computeFrontier({ ...l.inputs, incumbent: id }, replay)).join(
          ' \n ',
        )
        expect(text, `${l.id}/${id}`).not.toMatch(/(^|[^\d.])0(\.0+)?%/) // no bare 0%
        expect(text, `${l.id}/${id}`).not.toMatch(/\$0(?![\d,.])/) // no bare $0
        expect(text, `${l.id}/${id}`).not.toMatch(
          /\bfree\b|interest-free|\bsafe\b|\bok\b|\bkept\b|\bsaved\b|win rate|confidence|% of users|probab|odds|likely/i,
        )
      }
  })

  it('states a liquidation price as a whole-% distance from now, rounded toward risk', () => {
    expect(priceFromNowText(0.75)).toBe('25% below now')
    expect(priceFromNowText(0.7449)).toBe('25% below now')
    expect(priceFromNowText(0.995)).toBe('under 1% below now')
    expect(priceFromNowText(1)).toBe('at or above the t0 price')
  })
})
