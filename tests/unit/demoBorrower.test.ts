// THE BORROWER-MODE DEMO IS A REAL LIQUIDATION, AND IT HAS TO STAY ONE.
//
// /[chain]/simulator opens on a wallet Aave V3 actually liquidated on 10 Oct 2025,
// selected out of public/data/oct10-2025/evidence.json. Three ways that can rot, and
// one test each:
//
//  1. The fixture is hand-edited into something that no longer parses as a position.
//  2. The reconstructed position drifts off the MEASURED row — the collateral token
//     amount is derived (measured USD / oracle price at minute 0), so the LTV it
//     produces must still land on the row's own measured ltv0, and the Aave risk
//     parameters must be the ones on disk rather than a convenient guess.
//  3. The demo quietly becomes a NON-EVENT. A borrower-first landing page whose default
//     wallet sails through the crash on BOTH engines has nothing to show. Two tests
//     refuse that: the source engine MUST liquidate over the measured window, and
//     Membrane MUST survive it — that contrast is the page.
//  4. The ASSUMED deployment goes missing or stops being labelled. It is the one
//     non-measured thing on the page (owner ruling 2026-09-12: partial liquidation is
//     no longer a differentiator, the recall rails are, and with no deployment ZERO of
//     the 63 eligible wallets survive on Membrane). It has to be there, and it has to
//     be stamped 'modelled' and say the word "assumed" — never rendered as a read.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { MAX_LIQ_FEE, measuredRepayFraction, runComparison } from '@/lib/position-sim/compare'
import {
  DEMO_BORROWER_ADDRESS,
  DEMO_BORROWER_ASSUMED,
  DEMO_BORROWER_DATE,
  DEMO_BORROWER_DEPLOYMENT,
  DEMO_BORROWER_NOTE,
  DEMO_BORROWER_ROW,
  demoBorrowerDetection,
  demoBorrowerPosition,
  demoBorrowerSummary,
} from '@/lib/position-sim/demoBorrower'
import {
  MAX_THRESHOLD_TO_DELAY,
  weightedMembraneLine,
  type VenueRecall,
} from '@/lib/position-sim/membrane'
import { buildPricePath, type Oct10Manifest, type Oct10Series } from '@/lib/position-sim/scenario'
import { excludeOwnCollateral, toVenueRecall } from '@/lib/position-sim/venues'
import { engineOutcome } from '@/lib/position-sim/outcome'
import type { ProtocolPosition } from '@/lib/position-sim/types'

const DATA = join(process.cwd(), 'public', 'data')
const read = (p: string) => JSON.parse(readFileSync(join(DATA, p), 'utf8'))

const fixture = read('demo-borrower.json')
const protocols = read('oct10-2025/protocols.json')

/** Same default the page picks (Simulator.tsx defaultLiqFee). */
function defaultLiqFee(p: ProtocolPosition): number {
  const priced = p.collateral.filter((c) => c.liquidationBonus !== null)
  const value = priced.reduce((a, c) => a + c.valueUsd, 0)
  if (value === 0) return MAX_LIQ_FEE
  return Math.min(
    MAX_LIQ_FEE,
    Math.max(
      0,
      priced.reduce((a, c) => a + (c.liquidationBonus as number) * c.valueUsd, 0) / value,
    ),
  )
}

/** The Oct 10 run, exactly as the borrower page assembles it, but off disk. */
function oct10Run(venue: VenueRecall | null = toVenueRecall(demoBorrowerDetection())) {
  const series = read('oct10-2025/prices-1m.json') as Oct10Series
  const manifest = read('oct10-2025/manifest.json') as Oct10Manifest
  const position = demoBorrowerPosition()
  const symbols = [
    ...position.collateral.map((c) => c.symbol),
    ...position.debt.map((d) => d.symbol),
  ]
  const { path, unpriced } = buildPricePath(series, manifest, symbols)
  const repay = measuredRepayFraction(position.protocol, protocols.measuredLiquidations)
  return runComparison(position, path, unpriced, {
    membraneMaxLtv: weightedMembraneLine(position.collateral).maxLtv,
    membraneLiqFee: defaultLiqFee(position),
    // The ASSUMED deployment, through the same toVenueRecall a pasted address uses.
    venue,
    sourceRepayFraction: repay.fraction,
    sourceRepayFractionLabel: repay.label,
    scenarioLabel: 'oct10',
  })
}

describe('the borrower demo wallet', () => {
  it('parses, and carries the fields the page reads', () => {
    expect(fixture.provenance).toBe('measured wallet · assumed deployment')
    expect(fixture.source).toBe('public/data/oct10-2025/evidence.json')
    expect(fixture.address).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(typeof fixture.readAt).toBe('string')
    expect(fixture.row).toBeTruthy()
    expect(fixture.position).toBeTruthy()
    expect(DEMO_BORROWER_ADDRESS).toBe(fixture.address)
    // Checksummed, so it is the same string the adapters and the URL would produce.
    expect(DEMO_BORROWER_ADDRESS).not.toBe(DEMO_BORROWER_ADDRESS.toLowerCase())
    expect(DEMO_BORROWER_ADDRESS.toLowerCase()).toBe(fixture.row.user.toLowerCase())
  })

  it('is measured data, never a fixture or a mock', () => {
    const p = demoBorrowerPosition()
    expect(p.provenance.kind).toBe('dataset')
    // The DEPLOYMENT is the one assumed thing, so it is stamped 'modelled', never
    // 'dataset' and never 'onchain'. A reader must not be able to mistake it for a read.
    expect(demoBorrowerDetection().provenance.kind).toBe('modelled')
    expect(DEMO_BORROWER_DEPLOYMENT?.provenance.kind).toBe('modelled')
    expect(DEMO_BORROWER_NOTE).toContain(DEMO_BORROWER_DATE)
  })

  it('reconstructs the MEASURED row: LTV lands on ltv0 within 0.5pp', () => {
    const p = demoBorrowerPosition()
    expect(Math.abs(p.ltv - DEMO_BORROWER_ROW.ltv0)).toBeLessThanOrEqual(0.005)
    expect(p.totalDebtUsd).toBeCloseTo(DEMO_BORROWER_ROW.debtUsd, 2)
    expect(p.totalCollateralUsd).toBeCloseTo(DEMO_BORROWER_ROW.collateralUsd, 2)
    // The token amount is derived, so it must reprice back to the measured dollars.
    const c = p.collateral[0]
    expect(c.amount * c.priceUsd).toBeCloseTo(DEMO_BORROWER_ROW.collateralUsd, 2)
    expect(c.symbol).toBe(DEMO_BORROWER_ROW.collSymbol)
    expect(p.debt[0].symbol).toBe(DEMO_BORROWER_ROW.debtSymbol)
  })

  it('uses the Aave V3 parameters read into protocols.json, not assumed ones', () => {
    const c = demoBorrowerPosition().collateral[0]
    const r = protocols.aaveV3.reserves[c.symbol]
    expect(r).toBeTruthy()
    expect(c.liquidationThreshold).toBeCloseTo(r.liquidationThresholdPct / 100, 10)
    expect(c.maxLtv).toBeCloseTo(r.ltvPct / 100, 10)
    expect(c.liquidationBonus).toBeCloseTo(r.liquidationBonusPct / 100 - 1, 10)
    expect(c.decimals).toBe(r.decimals)
  })

  it('carries the ASSUMED deployment, and says so in every label', () => {
    const a = DEMO_BORROWER_ASSUMED
    // Half the MEASURED debt, at the carry example's own modelled rates.
    expect(a.deployedUsd).toBeCloseTo(DEMO_BORROWER_ROW.debtUsd * 0.5, 2)
    expect(a.recallRate).toBe(0.6)
    expect(a.fastRate).toBe(0.55)

    const d = demoBorrowerDetection()
    expect(d.status).toBe('detected')
    expect(d.totalUsd).toBeCloseTo(a.deployedUsd, 6)
    // The word has to be on the page, not just in this file's comments.
    expect(a.note.toLowerCase()).toContain('assumed')
    expect(d.message?.toLowerCase()).toContain('assumed')
    expect(d.detected[0].venue.exit.toLowerCase()).toContain('assumed')
    expect(DEMO_BORROWER_NOTE.toLowerCase()).toContain('assumed')

    // The engine gets it through the same pipe a pasted address goes through.
    const recall = toVenueRecall(d)
    expect(recall?.deployedUsd).toBeCloseTo(a.deployedUsd, 6)
    expect(recall?.recallRate).toBeCloseTo(a.recallRate, 10)
    expect(recall?.fastRate).toBeCloseTo(a.fastRate, 10)
    expect(DEMO_BORROWER_DEPLOYMENT?.deployedUsd).toBeCloseTo(a.deployedUsd, 6)
  })

  it('does not collide with the position it is meant to save', () => {
    // excludeOwnCollateral drops any venue whose underlying is a collateral leg. If the
    // assumed venue ever picked a colliding ticker the deployment would silently vanish
    // and the hero would quietly go back to losing.
    const p = demoBorrowerPosition()
    const kept = excludeOwnCollateral(demoBorrowerDetection(), p)
    expect(kept.status).toBe('detected')
    expect(kept.totalUsd).toBeCloseTo(DEMO_BORROWER_ASSUMED.deployedUsd, 6)
  })

  it('summarises in 25 words or fewer', () => {
    expect(demoBorrowerSummary().split(/\s+/).length).toBeLessThanOrEqual(25)
    expect(demoBorrowerSummary()).toContain(DEMO_BORROWER_DATE)
  })

  it('is never a non-event: the source engine liquidates it over the measured window', () => {
    const cmp = oct10Run()
    expect(engineOutcome(cmp.source).liquidated).toBe(true)
  })

  it('SURVIVES on Membrane — cure/recall only, and the 4% window holds', () => {
    // This is the whole hero. If it ever flips, the borrower page is showing "Membrane
    // liquidated you too, just more gently", which is the differentiator Aave V4 also
    // ships. Fail loudly rather than ship that.
    const cmp = oct10Run()
    expect(engineOutcome(cmp.membrane).liquidated).toBe(false)
    expect(cmp.membrane.events.length).toBeGreaterThan(0)
    for (const e of cmp.membrane.events) expect(['cure', 'recall']).toContain(e.kind)

    const line = weightedMembraneLine(demoBorrowerPosition().collateral).maxLtv
    expect(cmp.membrane.peakLtv).toBeLessThanOrEqual(line * (1 + MAX_THRESHOLD_TO_DELAY))

    // And it ends AHEAD of Aave, because that number is printed as a dollar figure.
    expect(cmp.equityDeltaUsd).toBeGreaterThan(0)
  })

  it('is not knife-edge: it still survives well below the assumed recall rate', () => {
    // The break-even recorded by the generator, re-derived here rather than trusted.
    const be = DEMO_BORROWER_ASSUMED.recallBreakEven
    expect(be).not.toBeNull()
    expect(be as number).toBeLessThan(DEMO_BORROWER_ASSUMED.recallRate)
    const cmp = oct10Run({
      ...(DEMO_BORROWER_DEPLOYMENT as NonNullable<typeof DEMO_BORROWER_DEPLOYMENT>),
      recallRate: be as number,
      fastRate: Math.max(0, (be as number) - 0.05),
    })
    expect(engineOutcome(cmp.membrane).liquidated).toBe(false)
  })
})
