/**
 * Membrane's two collateral classes, as on membrane-solidity master 10626e40.
 *
 *   delayed   listing cap <= 90%   4% band, 8h window, 3pp borrow gap
 *   no-delay  90% < cap <= 96%     band 0 ⇒ instant mode: crossing the line IS the sale
 *   a position never holds both (MixedDelayClassCollateral, Collateral.sol:510-514)
 *
 * Every expected value below is a master constant; lib/position-sim/membrane.ts carries
 * the file:line citation for each.
 */
import { describe, expect, it } from 'vitest'

import { runComparison } from '@/lib/position-sim/compare'
import { DelayTimer, cureWalk, type DelayAction } from '@/lib/position-sim/curePath'
import {
  BORROW_LTV_GAP,
  CURE_WINDOW_SECONDS,
  MAX_LTV_HARD_CAP,
  MAX_THRESHOLD_TO_DELAY,
  MEMBRANE_ASSET_LTV,
  MEMBRANE_CLASS_PARAMS,
  NO_DELAY_LTV_HARD_CAP,
  NO_DELAY_THRESHOLD_TO_DELAY,
  applyDebtMinimum,
  membraneAssetClass,
  membraneAssetLtvCap,
  membraneBorrowLtv,
  membraneClassOfCap,
  membraneCollateralRepayValue,
  membraneMaxLtv,
  membraneRepayValue,
  weightedMembraneLine,
} from '@/lib/position-sim/membrane'
import { stamp, type PricePath, type ProtocolPosition } from '@/lib/position-sim/types'

// ------------------------------------------------------------------ fixtures

const PROV = stamp('mock', 'simClasses test', 'synthetic')

function position(
  collSymbol: string,
  collUsd: number,
  debtUsd: number,
  extra: { symbol: string; usd: number }[] = [],
): ProtocolPosition {
  const legs = [{ symbol: collSymbol, usd: collUsd }, ...extra]
  const total = legs.reduce((a, l) => a + l.usd, 0)
  return {
    protocol: 'aave-v3',
    label: 'Synthetic',
    collateral: legs.map((l) => ({
      symbol: l.symbol,
      address: '0x0',
      decimals: 18,
      amount: l.usd, // priced at $1 at t0
      priceUsd: 1,
      valueUsd: l.usd,
      // The SOURCE engine never fires in these fixtures: only Membrane is under test.
      liquidationThreshold: 0.99,
      maxLtv: 0.98,
      liquidationBonus: 0.05,
    })),
    debt: [
      {
        symbol: 'USDC',
        address: '0x0',
        decimals: 6,
        amount: debtUsd,
        priceUsd: 1,
        valueUsd: debtUsd,
        borrowApr: null,
      },
    ],
    totalCollateralUsd: total,
    totalDebtUsd: debtUsd,
    ltv: debtUsd / total,
    liquidationLtv: 0.99,
    healthFactor: (0.99 * total) / debtUsd,
    provenance: PROV,
  }
}

/** A 600-minute path: flat at 1, a dip to `dip` for minutes [60, 180), then back to 1. */
function dipPath(symbols: string[], dip: number): PricePath {
  const count = 600
  const s = Array.from({ length: count }, (_, i) => (i >= 60 && i < 180 ? dip : 1))
  return {
    startTs: 1_760_000_000,
    stepSeconds: 60,
    count,
    series: {
      ...Object.fromEntries(symbols.map((sym) => [sym, s])),
      USDC: new Array(count).fill(1),
    },
    provenance: PROV,
  }
}

const OPTS = {
  membraneLiqFee: 0,
  venue: null,
  sourceRepayFraction: 0.5,
  sourceRepayFractionLabel: '50%',
  scenarioLabel: 'synthetic dip',
}

/** Every action a timer produces across an LTV sequence. */
function actions(timer: DelayTimer, ltvs: number[]): DelayAction['kind'][] {
  return ltvs.map((l, i) => timer.step(i, l).kind)
}

// ---------------------------------------------------------- class detection

describe('class detection — derived from the listing cap (Collateral.sol:363-365)', () => {
  it('uses master constants', () => {
    expect(MAX_LTV_HARD_CAP).toBe(0.9)
    expect(NO_DELAY_LTV_HARD_CAP).toBe(0.96)
    expect(MAX_THRESHOLD_TO_DELAY).toBe(0.04)
    expect(NO_DELAY_THRESHOLD_TO_DELAY).toBe(0)
    expect(CURE_WINDOW_SECONDS).toBe(28_800)
    expect(BORROW_LTV_GAP).toBe(0.03)
  })

  it('cap > 90% is no-delay; 90% exactly, and the default (0) listing, are delayed', () => {
    expect(membraneClassOfCap(0)).toBe('delayed') // Collateral.sol:345 rewrites 0 → 90%
    expect(membraneClassOfCap(0.8)).toBe('delayed')
    expect(membraneClassOfCap(0.9)).toBe('delayed') // strict `>` (Collateral.sol:364)
    expect(membraneClassOfCap(0.9000001)).toBe('no-delay')
    expect(membraneClassOfCap(0.96)).toBe('no-delay')
  })

  it('carries per-class mechanics', () => {
    expect(MEMBRANE_CLASS_PARAMS.delayed).toEqual({
      class: 'delayed',
      ltvCeiling: 0.9,
      band: 0.04,
      windowSeconds: 28_800,
      borrowLtvGap: 0.03,
    })
    expect(MEMBRANE_CLASS_PARAMS['no-delay']).toEqual({
      class: 'no-delay',
      ltvCeiling: 0.96,
      band: 0,
      windowSeconds: 0,
      borrowLtvGap: 0.03,
    })
    // Same 3pp gap in both classes: 96% max ⇒ 93% borrow (DeployFullSystem.s.sol:268).
    expect(membraneBorrowLtv(NO_DELAY_LTV_HARD_CAP)).toBeCloseTo(0.93, 12)
  })

  it("lists master's launch assets in their deploy-script class", () => {
    for (const sym of ['sUSDS', 'syrupUSDC', 'scrvUSD']) {
      expect(membraneAssetClass(sym)).toBe('no-delay')
      expect(membraneAssetLtvCap(sym)).toBe(0.96)
    }
    // Bootstrap temp_ltv (DeployFullSystem.s.sol:243, :247, :251), not the 96% cap.
    expect(membraneMaxLtv('sUSDS')).toBe(0.88)
    expect(membraneMaxLtv('syrupUSDC')).toBe(0.86)
    expect(membraneMaxLtv('scrvUSD')).toBe(0.86)
    expect(membraneAssetClass('WETH')).toBe('delayed')
    expect(membraneMaxLtv('WETH')).toBe(0.8) // WETH_MAX_LTV, DeployFullSystem.s.sol:212
  })

  it('gives every modelled (unlisted) asset the default delayed listing, and unknowns null', () => {
    for (const sym of ['USDC', 'sDAI', 'wstETH', 'WBTC']) {
      expect(membraneAssetClass(sym)).toBe('delayed')
      expect(membraneAssetLtvCap(sym)).toBe(MAX_LTV_HARD_CAP)
    }
    expect(membraneAssetClass('NOT_A_TOKEN')).toBeNull()
    expect(membraneAssetLtvCap('NOT_A_TOKEN')).toBeNull()
  })

  it('never lets an asset line exceed its own class ceiling', () => {
    for (const sym of Object.keys(MEMBRANE_ASSET_LTV)) {
      const cls = membraneAssetClass(sym)!
      expect(membraneMaxLtv(sym)!).toBeLessThanOrEqual(MEMBRANE_CLASS_PARAMS[cls].ltvCeiling)
    }
  })

  it('classifies baskets; a delayed basket keeps the EXACT 4% band (no re-weighting drift)', () => {
    const d = weightedMembraneLine([
      { symbol: 'WETH', valueUsd: 30_000 },
      { symbol: 'wstETH', valueUsd: 70_000 },
    ])
    expect(d.class).toBe('delayed')
    expect(d.mixed).toBe(false)
    expect(d.band).toBe(MAX_THRESHOLD_TO_DELAY)

    const n = weightedMembraneLine([
      { symbol: 'sUSDS', valueUsd: 50_000 },
      { symbol: 'scrvUSD', valueUsd: 50_000 },
    ])
    expect(n.class).toBe('no-delay')
    expect(n.band).toBe(0)
    expect(n.maxLtv).toBeCloseTo(0.87, 12)
    expect(n.borrowLtv).toBeCloseTo(0.84, 12)
  })

  it('flags a mixed basket, which master refuses in one position (Collateral.sol:510-514)', () => {
    const m = weightedMembraneLine([
      { symbol: 'WETH', valueUsd: 50_000 },
      { symbol: 'sUSDS', valueUsd: 50_000 },
    ])
    expect(m.class).toBe('mixed')
    expect(m.mixed).toBe(true)
    // The value-weighted band the engine would compute (Cdp.sol:5050): 0.5 × 4% + 0.5 × 0.
    expect(m.band).toBeCloseTo(0.02, 12)
  })

  it('leaves unknown legs out; an all-unknown basket reads as the default delayed class', () => {
    const u = weightedMembraneLine([
      { symbol: 'sUSDS', valueUsd: 50_000 },
      { symbol: 'NOT_A_TOKEN', valueUsd: 50_000 },
    ])
    expect(u.unknown).toEqual(['NOT_A_TOKEN'])
    expect(u.class).toBe('no-delay')
    expect(u.maxLtv).toBeCloseTo(0.88, 12)
    const none = weightedMembraneLine([{ symbol: 'NOT_A_TOKEN', valueUsd: 1 }])
    expect(none.class).toBe('delayed')
    expect(none.band).toBe(MAX_THRESHOLD_TO_DELAY)
    expect(none.maxLtv).toBe(0)
  })
})

// ---------------------------------------------------- no-delay never arms

describe('no-delay class: crossing the line is the sale (instant mode, LE:1572, :1708-1710)', () => {
  const p = MEMBRANE_CLASS_PARAMS['no-delay']

  it('the timer never arms or holds, on any LTV sequence', () => {
    const line = 0.88
    const timer = new DelayTimer({ line, band: p.band, delaySteps: p.windowSeconds / 60 })
    // Deterministic pseudo-random walk around the line, plus the exact edges.
    let x = 0.86
    let seed = 7
    const ltvs = [line, line + 1e-12, line * 1.04, 0.5]
    for (let i = 0; i < 2000; i++) {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      x = Math.min(1.2, Math.max(0.7, x + (seed / 2 ** 31 - 0.5) * 0.01))
      ltvs.push(x)
    }
    const kinds = actions(timer, ltvs)
    expect(kinds).not.toContain('arm')
    expect(kinds).not.toContain('hold')
    expect(kinds).not.toContain('save')
    expect(timer.armed).toBe(false)
    // At the line exactly: not liquidatable (strict `>`, LE:1576). One wei over: sold.
    expect(kinds[0]).toBe('none')
    expect(kinds[1]).toBe('sell')
    // Every minute over the line is a sale; every minute at/under it is nothing.
    ltvs.forEach((l, i) => expect(kinds[i]).toBe(l > line ? 'sell' : 'none'))
  })

  it('cureWalk sells at t0 a breach the delayed class would have cured', () => {
    // 0.5% over the line, then the price recovers for good after 30 minutes.
    const ratios = Array.from({ length: 600 }, (_, i) => (i < 30 ? 1 : 1.02))
    const common = {
      debtUsd: 88_440,
      collateralUsd: 100_000,
      line: 0.88,
      delaySeconds: CURE_WINDOW_SECONDS,
      stepSeconds: 60,
      gap: BORROW_LTV_GAP,
      ratios,
      debtMinimumUsd: 2_000,
    }
    const instant = cureWalk({ ...common, band: p.band })
    expect(instant.outcome).toBe('sold-at-t0')
    expect(instant.closedUsd).toBe(
      membraneRepayValue(88_440, 100_000, 0.88 - BORROW_LTV_GAP, 2_000),
    )
    expect(instant.minutesToFirstCure).toBeNull()

    const delayed = cureWalk({ ...common, band: MEMBRANE_CLASS_PARAMS.delayed.band })
    expect(delayed.outcome).toBe('cured-then-held')
    expect(delayed.closedUsd).toBe(0)
  })

  it('runComparison derives the class from the listing: a sUSDS dip is liquidated at once', () => {
    // 87% LTV at the 88% sUSDS line; a 1.5% dip takes it to 88.3% for two hours.
    const pos = position('sUSDS', 100_000, 87_000)
    const cmp = runComparison(pos, dipPath(['sUSDS'], 0.985), [], OPTS)
    const ev = cmp.membrane.events
    expect(ev.some((e) => e.kind === 'breach')).toBe(false) // nothing ever arms
    expect(ev[0].kind).toBe('liquidation')
    expect(ev[0].minute).toBe(60) // the first minute over the line
    expect(ev[0].line).toBeCloseTo(0.88, 12)
    expect(ev[0].why).toContain('no-delay')
    expect(cmp.membrane.caveats.join(' ')).toContain('no-delay class')
    expect(cmp.membrane.caveats.join(' ')).not.toContain('8 hours')
  })
})

// ------------------------------------------------- delayed arms, cures, sells

describe('delayed class: arms inside the band, cures under the line, sells past it', () => {
  const p = MEMBRANE_CLASS_PARAMS.delayed
  const line = 0.8
  const breakLine = line * (1 + p.band) // 0.832

  it('arms, holds, saves on recovery and re-arms a FULL fresh window (LE:1666-1720)', () => {
    const timer = new DelayTimer({ line, band: p.band, delaySteps: 10 })
    const kinds = actions(timer, [0.79, 0.81, 0.82, line, 0.81, 0.81])
    expect(kinds).toEqual(['none', 'arm', 'hold', 'save', 'arm', 'hold'])
    expect(timer.firstCureIndex).toBe(3)
  })

  it('sells at expiry when still over the line after the window (DelayExpired)', () => {
    const timer = new DelayTimer({ line, band: p.band, delaySteps: 3 })
    expect(actions(timer, [0.81, 0.81, 0.81, 0.81])).toEqual(['arm', 'hold', 'hold', 'sell'])
  })

  it('the break line is line × (1 + band), strict `>` (LE:1576, :2554-2557)', () => {
    const atBreak = new DelayTimer({ line, band: p.band, delaySteps: 10 })
    expect(atBreak.step(0, breakLine).kind).toBe('arm') // exactly at the break line: delayed
    expect(atBreak.step(1, breakLine + 1e-9)).toEqual({ kind: 'sell', reason: 'band' }) // BrokeWindow
    const fresh = new DelayTimer({ line, band: p.band, delaySteps: 10 })
    expect(fresh.step(0, breakLine + 1e-9)).toEqual({ kind: 'sell', reason: 'band' }) // Immediate
  })

  it('cureWalk: in-band breach that recovers is never sold; one that stays is sold at 8h', () => {
    const common = {
      debtUsd: 81_000,
      collateralUsd: 100_000,
      line,
      band: p.band,
      delaySeconds: p.windowSeconds,
      stepSeconds: 60,
      gap: p.borrowLtvGap,
      debtMinimumUsd: 2_000,
    }
    const recovers = cureWalk({
      ...common,
      ratios: Array.from({ length: 900 }, (_, i) => (i < 120 ? 1 : 1.05)),
    })
    expect(recovers.outcome).toBe('cured-then-held')
    expect(recovers.minutesToFirstCure).toBe(120)
    const stays = cureWalk({ ...common, ratios: new Array(900).fill(1) })
    expect(stays.outcome).toBe('sold-at-expiry')
    expect(stays.closedAtIndex).toBe(CURE_WINDOW_SECONDS / 60)
  })

  it('runComparison on a WETH dip arms the window and cures with no sale', () => {
    // 79.5% LTV at the 80% WETH line; a 1.5% dip → 80.7%, inside the 83.2% break line.
    const pos = position('WETH', 100_000, 79_500)
    const cmp = runComparison(pos, dipPath(['WETH'], 0.985), [], OPTS)
    const kinds = cmp.membrane.events.map((e) => e.kind)
    expect(kinds).toEqual(['breach'])
    expect(cmp.membrane.events[0].minute).toBe(60)
    expect(cmp.membrane.events[0].why).toContain('8-hour window')
  })

  it('the SAME sUSDS dip, forced into the delayed class, arms and cures instead of selling', () => {
    const pos = position('sUSDS', 100_000, 87_000)
    const cmp = runComparison(pos, dipPath(['sUSDS'], 0.985), [], {
      ...OPTS,
      membraneClass: 'delayed',
    })
    expect(cmp.membrane.events.map((e) => e.kind)).toEqual(['breach'])
    const instant = runComparison(pos, dipPath(['sUSDS'], 0.985), [], OPTS)
    expect(cmp.membrane.endEquityUsd).toBeGreaterThan(instant.membrane.endEquityUsd)
  })

  it('a mixed basket runs on its weighted band and carries the master-refuses caveat', () => {
    const pos = position('WETH', 50_000, 60_000, [{ symbol: 'sUSDS', usd: 50_000 }])
    const cmp = runComparison(pos, dipPath(['WETH', 'sUSDS'], 1), [], OPTS)
    expect(cmp.membrane.caveats.join(' ')).toContain('MixedDelayClassCollateral')
  })
})

// ------------------------------------------- recall order in runComparison

describe('runComparison runs master per-call order: recall first, then classify on the post-recall LTV', () => {
  // Master: Step 1.5 recalls first (LE:1106-1107), up to the full debt (LE:1320, :1453) —
  // the sim instead asks only the restore-to-borrow-LTV amount (owner ruling 2026-10-04);
  // Step 2 re-reads the LTV after it (Cdp.sol:5055-5056); at or under the line the
  // recall-only lane cures (LE:1623-1657); otherwise the call is classified on the
  // POST-recall LTV, TimerStarted commits its recall, and a sale's target is the
  // PRE-recall debt at the POST-recall LTV (LE:1759, :2663-2729). compare.ts used to
  // classify and size on the PRE-recall LTV, selling collateral master never sells.
  const venue = (deployedUsd: number) => ({ recallRate: 1, deployedUsd, provenance: PROV })

  it('delayed: a recall that lands inside the band ARMS the window — nothing is sold (review probe a)', () => {
    // WETH 75 on 100 at the 0.80 line. The dip takes the pre-recall LTV to 0.85, past the
    // 0.832 break line; recalling 3 lands at 72 / 88.24 = 0.816, inside the band.
    const pos = position('WETH', 100, 75)
    const cmp = runComparison(pos, dipPath(['WETH'], 0.75 / 0.85), [], {
      ...OPTS,
      debtMinimumUsd: 0,
      venue: venue(3),
    })
    const ev = cmp.membrane.events
    expect(ev.map((e) => e.kind)).toEqual(['breach'])
    expect(ev[0].recalledUsd).toBeCloseTo(3, 9)
    expect(ev[0].seizedUsd).toBe(0)
    expect(cmp.membrane.endCollateralUsd).toBeCloseTo(100, 9)
    expect(cmp.membrane.endDebtUsd).toBeCloseTo(72, 9)
  })

  it('no-delay: a recall that reaches the line is the recall-only lane — a cure (review probe b)', () => {
    // sUSDS 85 on 100 at the 0.88 line, a 4.5% dip: pre-recall 0.890, after recalling 2
    // it is 83 / 95.5 = 0.869 — under the line, so master cures with no sale.
    const pos = position('sUSDS', 100, 85)
    const cmp = runComparison(pos, dipPath(['sUSDS'], 0.955), [], {
      ...OPTS,
      debtMinimumUsd: 0,
      venue: venue(2),
    })
    const ev = cmp.membrane.events
    expect(ev.map((e) => e.kind)).toEqual(['cure'])
    expect(ev[0].minute).toBe(60)
    expect(ev[0].recalledUsd).toBeCloseTo(2, 9)
    expect(ev[0].seizedUsd).toBe(0)
    // Master charges the keeper fee on this lane (LE:1134-1137); the copy must not say
    // "no fee was paid".
    expect(ev[0].why).not.toContain('no fee was paid')
    expect(ev[0].why).toContain('not modelled')
    expect(cmp.membrane.endCollateralUsd).toBeCloseTo(100, 9)
  })

  it('the recall asks only the restore-to-borrow-LTV amount, not the full debt (owner ruling 2026-10-04)', () => {
    // WETH 80k on 100k; the dip to ×0.9 takes the LTV to 0.889. 50k is deployed at a 100%
    // rate. Master would ask the full 80k debt and pull 50k; the ruled ask is
    // 80,000 − 0.77 × 90,000 = 10,700, which lands the position exactly at the borrow LTV.
    const pos = position('WETH', 100_000, 80_000)
    const cmp = runComparison(pos, dipPath(['WETH'], 0.9), [], { ...OPTS, venue: venue(50_000) })
    const ev = cmp.membrane.events
    expect(ev.map((e) => e.kind)).toEqual(['cure'])
    expect(ev[0].recalledUsd).toBeCloseTo(80_000 - 0.77 * 90_000, 6)
    expect(ev[0].seizedUsd).toBe(0)
    expect(cmp.membrane.endDebtUsd).toBeCloseTo(69_300, 6)
    expect(cmp.membrane.endDeployedUsd).toBeCloseTo(50_000 - 10_700, 6)
    // A recall moves capital from the venue to the debt: equity-neutral.
    expect(cmp.membrane.endEquityUsd).toBeCloseTo(cmp.membrane.startEquityUsd, 6)
  })

  it('a sale is sized on the PRE-recall debt at the POST-recall LTV, recall netted off', () => {
    // WETH 80k on 100k; the dip takes the pre-recall LTV to 0.90. Recalling 2k leaves
    // 78k / 88.9k = 0.8775 — still past the break line, so the sale is immediate.
    const pos = position('WETH', 100_000, 80_000)
    const dip = 0.8 / 0.9
    const cmp = runComparison(pos, dipPath(['WETH'], dip), [], { ...OPTS, venue: venue(2_000) })
    const sale = cmp.membrane.events[0]
    expect(sale.kind).toBe('liquidation')
    expect(sale.recalledUsd).toBeCloseTo(2_000, 6)
    const ltvPost = 78_000 / (100_000 * dip)
    const target = membraneRepayValue(80_000, 80_000 / ltvPost, membraneBorrowLtv(0.8), 2_000)
    expect(sale.seizedUsd).toBeCloseTo(target - 2_000, 6) // fee 0
    // Sized on the pre-recall LTV it would have been larger.
    expect(target).toBeLessThan(
      membraneRepayValue(80_000, 100_000 * dip, membraneBorrowLtv(0.8), 2_000),
    )
  })
})

describe('debt floor on the ARRIVAL: a short recall never strands sub-floor debt (owner ruling 2026-10-04)', () => {
  // The finding's input: $3,000 debt on $3,300 (LTV 90.9%) at a 0.90 line, delayed class,
  // flat price. The restore ask lifts to the whole loan (loan < 2 × dMin); the venue holds
  // $2,500 and pays it all (recallRate 1). The recall alone lands at 15.2% — under the
  // line — but would leave $500 owed. Master's recall-only lane (LE:1623-1658) leaves it.
  const venue = (deployedUsd: number) => ({ recallRate: 1, deployedUsd, provenance: PROV })
  const opts = (deployed: number) => ({
    ...OPTS,
    membraneLiqFee: 0.05,
    membraneMaxLtv: 0.9,
    membraneClass: 'delayed' as const,
    venue: venue(deployed),
  })

  it('recall-only lane: the call repays all — $500 of collateral (plus fee) closes the loan', () => {
    const cmp = runComparison(position('WETH', 3_300, 3_000), dipPath(['WETH'], 1), [], opts(2_500))
    const ev = cmp.membrane.events
    // Before: ['cure'] with $2,500 recalled and endDebtUsd 499.99.
    expect(ev.map((e) => e.kind)).toEqual(['liquidation'])
    expect(ev[0].minute).toBe(0)
    expect(ev[0].recalledUsd).toBeCloseTo(2_500, 9)
    expect(ev[0].seizedUsd).toBeCloseTo(500 * 1.05, 9)
    expect(ev[0].penaltyUsd).toBeCloseTo(25, 9)
    expect(ev[0].repaidUsd).toBeCloseTo(3_000, 9)
    expect(ev[0].why).toContain('debt floor')
    expect(cmp.membrane.endDebtUsd).toBeCloseTo(0, 9)
    expect(cmp.membrane.endCollateralUsd).toBeCloseTo(3_300 - 525, 9)
  })

  it('a remainder of exactly dMin stands: the recall-only cure is unchanged', () => {
    const cmp = runComparison(position('WETH', 3_300, 3_000), dipPath(['WETH'], 1), [], opts(1_000))
    expect(cmp.membrane.events.map((e) => e.kind)).toEqual(['cure'])
    expect(cmp.membrane.endDebtUsd).toBeCloseTo(2_000, 9)
    expect(cmp.membrane.endCollateralUsd).toBeCloseTo(3_300, 9)
  })

  it('TimerStarted lane: a recall that would commit dust closes the loan instead of arming', () => {
    // $3,000 on $1,100: the venue's $2,000 leaves $1,000 at LTV 90.9%, inside the band, so
    // TimerStarted would commit it and open the 8h window. Before: ['breach', then the
    // expiry 'liquidation'] with $1,000 owed through the window.
    const cmp = runComparison(position('WETH', 1_100, 3_000), dipPath(['WETH'], 1), [], opts(2_000))
    const ev = cmp.membrane.events
    expect(ev.map((e) => e.kind)).toEqual(['liquidation'])
    expect(ev[0].minute).toBe(0)
    expect(ev[0].recalledUsd).toBeCloseTo(2_000, 9)
    expect(ev[0].seizedUsd).toBeCloseTo(1_000 * 1.05, 9)
    expect(cmp.membrane.endDebtUsd).toBeCloseTo(0, 9)
  })
})

// --------------------------------------------- master-aligned repay sizing

describe('repay sizing: master (LE:2663-2729) plus the ruled remainder guard', () => {
  it('targets the FULL debt at L >= 1, not the collateral value', () => {
    expect(membraneRepayValue(110_000, 100_000, 0.77)).toBe(110_000)
    expect(membraneRepayValue(100_000, 100_000, 0.77, 2_000)).toBe(100_000)
    expect(membraneRepayValue(50_000, 0, 0.77)).toBe(50_000)
  })

  it('applies the debt floor WITH the remainder guard (owner ruling 2026-10-04)', () => {
    // UPDATED 2026-10-04 (ruling 1): was 9_000 ('>= dMin stands', master's no-guard floor).
    // A liquidation must never leave 0 < debt < dMin, so 9,000 of 10,000 (leaving 1,000)
    // repays all. Master LE:2718-2729 has no guard — a fix lane exists.
    expect(applyDebtMinimum(9_000, 10_000, 2_000)).toBe(10_000) // would strand 1,000: all
    expect(applyDebtMinimum(8_000, 10_000, 2_000)).toBe(8_000) // leaves exactly dMin: stands
    expect(applyDebtMinimum(500, 100_000, 2_000)).toBe(2_000) // lifted to dMin
    expect(applyDebtMinimum(500, 1_500, 2_000)).toBe(1_500) // loan < dMin: all
    expect(applyDebtMinimum(500, 3_000, 2_000)).toBe(3_000) // dMin <= loan < 2·dMin: all
    expect(applyDebtMinimum(500, 100_000, 0)).toBe(500) // disabled
  })
})

// ------------------------------- insolvency: collateral books only what it covers

describe('underwater sales book only the debt the collateral covered (LE:2361-2374)', () => {
  // The repay TARGET is the full debt at L >= 1 (LE:2673-2688), but collateral can only
  // repay what is held; once it is exhausted the uncovered rest is bad debt, not closed.
  it('membraneCollateralRepayValue bounds the target by the collateral held', () => {
    expect(membraneCollateralRepayValue(110_000, 100_000, 0.77)).toBe(100_000)
    expect(membraneCollateralRepayValue(100_000, 100_000, 0.77, 2_000)).toBe(100_000)
    expect(membraneCollateralRepayValue(50_000, 0, 0.77)).toBe(0)
    // Below L = 1 the bound never binds: identical to the raw target.
    for (const [loan, coll] of [
      [80_000, 100_000],
      [99_000, 100_000],
      [3_000, 3_500],
    ]) {
      expect(membraneCollateralRepayValue(loan, coll, 0.77, 2_000)).toBe(
        membraneRepayValue(loan, coll, 0.77, 2_000),
      )
    }
  })

  const walk = {
    debtUsd: 100_000,
    line: 0.8,
    band: MAX_THRESHOLD_TO_DELAY,
    delaySeconds: CURE_WINDOW_SECONDS,
    stepSeconds: 60,
    gap: BORROW_LTV_GAP,
    debtMinimumUsd: 2_000,
  }

  it('cureWalk: a band-break sale past insolvency closes the collateral value, not the debt', () => {
    // t0 LTV 100/123 = 0.813 (in the band, arms); minute 1 at ×0.5 = 61.5k collateral.
    const r = cureWalk({ ...walk, collateralUsd: 123_000, ratios: [1, 0.5, 0.5, 0.5] })
    expect(r.outcome).toBe('sold-at-band')
    expect(r.sales).toBe(1)
    expect(r.closedUsd).toBeCloseTo(61_500, 6) // was 100,000: $38.5k of bad debt booked as repaid
  })

  it('cureWalk: underwater at t0 closes the collateral value (sold-at-t0 and no-series)', () => {
    const t0 = cureWalk({ ...walk, collateralUsd: 80_000, ratios: [1, 1] })
    expect(t0.outcome).toBe('sold-at-t0')
    expect(t0.closedUsd).toBe(80_000)
    const noSeries = cureWalk({
      ...walk,
      line: 0.99,
      band: 0.05,
      collateralUsd: 99_000,
      ratios: null,
    })
    expect(noSeries.outcome).toBe('sold-immediately-no-series')
    expect(noSeries.closedUsd).toBe(99_000)
  })
})
