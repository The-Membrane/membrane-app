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
  DEMO_BORROWER_NO_DEPLOYMENT,
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

/**
 * Same default the page picks (Simulator.tsx defaultLiqFee). Owner ruling 2026-09-14:
 * the deployed protocol liquidation fee is 0, so the page starts there and so does the
 * census, which charges no liquidation fee at all. This helper used to reimplement the
 * OLD default (the source protocol's collateral-weighted liquidation bonus) and had gone
 * stale against the page it claims to mirror.
 */
function defaultLiqFee(_p: ProtocolPosition): number {
  return 0
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
    expect(fixture.provenance).toBe('measured wallet · no deployment')
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
    // There is NO deployment, so nothing on this page is modelled at all: the detection
    // is a dataset-stamped absence and the recall input is null.
    expect(demoBorrowerDetection().provenance.kind).toBe('dataset')
    expect(DEMO_BORROWER_DEPLOYMENT).toBeNull()
    expect(DEMO_BORROWER_NOTE).toContain(DEMO_BORROWER_DATE)
  })

  /**
   * REWRITTEN 2026-09-14, because the old assertion pinned the bug.
   *
   * It used to require the fixture's LTV at MINUTE 0 to equal the census `ltv0` — the
   * ratio measured in the LIQUIDATING block, 21 hours later. The only way to satisfy
   * that is to back-solve a token amount from the midnight price, which is exactly what
   * the selector did, and it opened the hero on a position already over its line at
   * 00:00. The wallet was healthy at midnight; the fixture now says so.
   *
   * The measured row is still reconstructed exactly — just at the price it was measured
   * at. The token count is the invariant, and repricing it to `pLiqColl` lands on the
   * measured dollars and on `ltv0`.
   */
  it('reconstructs the MEASURED row at the price it was measured at', () => {
    const p = demoBorrowerPosition()
    const c = p.collateral[0]
    const row = DEMO_BORROWER_ROW
    // The token amount is the measured USD over the round in force in the liquidating
    // block. Reprice it there and the measured dollars and the measured LTV come back.
    expect(c.amount).toBeCloseTo(row.collateralUsd / row.pLiqColl, 9)
    expect(c.amount * row.pLiqColl).toBeCloseTo(row.collateralUsd, 2)
    expect(p.debt[0].amount * row.pLiqDebt).toBeCloseTo(row.debtUsd, 2)
    const ltvAtLiq = (p.debt[0].amount * row.pLiqDebt) / (c.amount * row.pLiqColl)
    expect(Math.abs(ltvAtLiq - row.ltv0)).toBeLessThanOrEqual(0.005)
    expect(c.symbol).toBe(row.collSymbol)
    expect(p.debt[0].symbol).toBe(row.debtSymbol)
  })

  it('opens HEALTHY at minute 0 — the breach belongs to the crash, not the fixture', () => {
    const p = demoBorrowerPosition()
    const c = p.collateral[0]
    // Minute 0 of the path is 00:00 UTC on 10 Oct, and the wallet was fine then.
    expect(p.totalCollateralUsd).toBeCloseTo(c.amount * c.priceUsd, 6)
    expect(p.ltv).toBeCloseTo((p.debt[0].amount * p.debt[0].priceUsd) / p.totalCollateralUsd, 12)
    expect(p.ltv).toBeLessThan(p.liquidationLtv)
    expect(p.healthFactor).toBeGreaterThan(1)
    // …and the census's own t0 is hours into the window, not minute 0.
    expect(fixture.censusT0Index).toBeGreaterThan(60)
  })

  it('republishes its census row, so the hero can be checked against it', () => {
    expect(fixture.censusT0Index).toBe(DEMO_BORROWER_ROW.t0Index)
    expect(fixture.censusOutcome).toBe(DEMO_BORROWER_ROW.outcome)
    expect(fixture.censusAaveClosedUsd).toBe(DEMO_BORROWER_ROW.aaveClosedUsd)
    expect(fixture.censusMembraneClosedUsd).toBe(DEMO_BORROWER_ROW.membraneClosedUsd)
    expect(fixture.censusClosedAtIndex).toBe(DEMO_BORROWER_ROW.closedAtIndex)
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

  it('carries NO deployment, and says so in every label', () => {
    // Owner ruling 2026-09-14: the assumed deployment is gone. The census has no venue in
    // it, and under the old assumption every census-consistent candidate ended with
    // NEGATIVE equity while its bare run was positive. If an assumed venue ever comes
    // back, the hero stops being the same claim as its census row.
    expect(DEMO_BORROWER_ASSUMED).toBeNull()
    expect(fixture.deployment).toBeNull()
    expect(fixture.assumedDeployment).toBeUndefined()

    const d = demoBorrowerDetection()
    expect(d.status).toBe('none')
    expect(d.totalUsd).toBe(0)
    expect(d.detected).toHaveLength(0)
    expect(toVenueRecall(d)).toBeNull()
    expect(DEMO_BORROWER_DEPLOYMENT).toBeNull()

    // The absence has to be on the page, not just in this file's comments.
    expect(DEMO_BORROWER_NOTE.toLowerCase()).toContain('no deployment')
    expect(d.message?.toLowerCase()).toContain('no venue')
    expect(DEMO_BORROWER_NO_DEPLOYMENT.equityDeltaUsd).toBeGreaterThan(0)
  })

  it('does not collide with the position it is meant to save', () => {
    // excludeOwnCollateral must survive an EMPTY detection without inventing one.
    const p = demoBorrowerPosition()
    const kept = excludeOwnCollateral(demoBorrowerDetection(), p)
    expect(kept.status).toBe('none')
    expect(kept.totalUsd).toBe(0)
  })

  it('summarises in 25 words or fewer', () => {
    expect(demoBorrowerSummary().split(/\s+/).length).toBeLessThanOrEqual(25)
    expect(demoBorrowerSummary()).toContain(DEMO_BORROWER_DATE)
  })

  it('is never a non-event: the source engine liquidates it over the measured window', () => {
    const cmp = oct10Run()
    expect(engineOutcome(cmp.source).liquidated).toBe(true)
  })

  it('ends AHEAD of Aave on equity, with no deployment anywhere in the run', () => {
    // This is the whole hero, and the ruling changed what it claims. It is no longer
    // "Membrane does not liquidate you" — with no venue to recall from, Membrane's line
    // sits under Aave's and this wallet IS sold on both sides. What it claims now is the
    // thing the census measures: Membrane closes LESS, so the borrower ends with more
    // equity. If this flips, the hero is printing a loss as a saving.
    const cmp = oct10Run(null)
    expect(cmp.equityDeltaUsd).toBeGreaterThan(0)
    expect(cmp.equityDeltaUsd).toBeCloseTo(DEMO_BORROWER_NO_DEPLOYMENT.equityDeltaUsd, -1)
    expect(cmp.membrane.events.length).toBeGreaterThan(0)
    // And the census row it is drawn from must agree that Membrane closes less.
    expect(DEMO_BORROWER_ROW.membraneClosedUsd).toBeLessThan(DEMO_BORROWER_ROW.aaveClosedUsd)
  })

  it('is the census row, not a re-run of it: the default venue is null', () => {
    // oct10Run's own default is the detection pipe. With no deployment that pipe yields
    // null, so the default run and the explicit no-venue run must be the same numbers.
    expect(oct10Run().equityDeltaUsd).toBeCloseTo(oct10Run(null).equityDeltaUsd, 6)
  })
})
