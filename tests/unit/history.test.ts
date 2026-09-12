import { describe, expect, it } from 'vitest'

import {
  DEFAULT_REPLAY_PARAMS,
  replayLiquidation,
  totalHistory,
  type HistoricLiquidation,
  type HistoryEvent,
  type PriceRound,
} from '@/lib/position-sim/history'

// A wallet liquidated at 12:00 UTC with an 80% line. Debt repaid $100k, so the slice
// behind it is $125k of collateral (100k / 0.80). The borrow cap is 80% − 3pp = 77%;
// the break band puts the immediate-sale line at 80% × 1.04 = 83.2%.
const T0 = Date.UTC(2025, 2, 12, 12, 0) / 1000
const HOUR = 3600

const ev: HistoricLiquidation = {
  ts: T0,
  collateralSeizedUsd: 110_000,
  debtRepaidUsd: 100_000,
  ltvAtEvent: 0.8,
  liqLine: 0.8,
}

/** LTV(t) = 0.8 × p0/p(t), so a target LTV needs p = p0 × 0.8/target. */
const priceFor = (ltv: number, p0 = 2000) => (p0 * 0.8) / ltv

const rounds = (...pairs: Array<[number, number]>): PriceRound[] =>
  pairs.map(([hoursAfter, price]) => ({ ts: T0 + hoursAfter * HOUR, price }))

const anchor: PriceRound = { ts: T0 - 600, price: 2000 }

describe('replayLiquidation', () => {
  it('SAVED: price back under the borrow cap inside the 8h window — nothing sold', () => {
    // 76% is under the 77% borrow cap.
    const r = replayLiquidation(ev, [anchor, ...rounds([1, priceFor(0.79)], [3, priceFor(0.76)])])
    expect(r.verdict).toBe('saved')
    expect(r.membraneSeizedUsd).toBe(0)
    // The dollar figure the headline prints is the collateral the liquidator took.
    expect(r.actualSeizedUsd).toBe(110_000)
    expect(r.recoveredAt).toBe(T0 + 3 * HOUR)
    expect(r.membraneShare).toBe(0)
  })

  it('BROKE: LTV climbs past line × (1 + 4%) — immediate sale, at the repay-to-cap size', () => {
    // 84% is over the 83.2% break line.
    const r = replayLiquidation(ev, [anchor, ...rounds([0.5, priceFor(0.82)], [1, priceFor(0.84)])])
    expect(r.verdict).toBe('broke')
    expect(r.brokeAt).toBe(T0 + HOUR)
    // Membrane still sells — but only enough to restore the borrow cap, so it is
    // strictly less than the full slice the real liquidator took.
    expect(r.membraneSeizedUsd).toBeGreaterThan(0)
    expect(r.membraneSeizedUsd).toBeLessThan(r.actualSeizedUsd)
    expect(r.membraneShare!).toBeGreaterThan(0)
    expect(r.membraneShare!).toBeLessThan(1)
  })

  it('PARTIAL: still over the line at the window end — repay to the borrow cap only', () => {
    // Hovers between the 77% cap and the 83.2% break line for the whole window.
    const r = replayLiquidation(ev, [
      anchor,
      ...rounds([1, priceFor(0.81)], [4, priceFor(0.8)], [7.9, priceFor(0.82)]),
    ])
    expect(r.verdict).toBe('partial')
    expect(r.recoveredAt).toBeUndefined()
    expect(r.brokeAt).toBeUndefined()
    expect(r.membraneSeizedUsd).toBeGreaterThan(0)
    expect(r.membraneSeizedUsd).toBeLessThan(r.actualSeizedUsd)
  })

  it('a round AFTER the 8h window cannot save the position', () => {
    const r = replayLiquidation(ev, [anchor, ...rounds([1, priceFor(0.81)], [9, priceFor(0.5)])])
    expect(r.verdict).toBe('partial')
  })

  it('UNKNOWN with no rounds — never counted in either direction', () => {
    const r = replayLiquidation(ev, [])
    expect(r.verdict).toBe('unknown')
    expect(r.membraneSeizedUsd).toBe(0)
    expect(r.membraneShare).toBeNull()
    expect(r.why).toMatch(/no oracle rounds/)
  })

  it('UNKNOWN when rounds exist but none fall inside the window', () => {
    const r = replayLiquidation(ev, [anchor, { ts: T0 + 9 * HOUR, price: 1000 }])
    expect(r.verdict).toBe('unknown')
  })

  it('UNKNOWN when no liquidation line could be read', () => {
    const r = replayLiquidation({ ...ev, liqLine: 0, ltvAtEvent: 0 }, [
      anchor,
      ...rounds([1, 2000]),
    ])
    expect(r.verdict).toBe('unknown')
  })

  it('uses the real 8h / 4% / 3pp constants by default', () => {
    expect(DEFAULT_REPLAY_PARAMS.cureWindowSeconds).toBe(28_800)
    expect(DEFAULT_REPLAY_PARAMS.band).toBeCloseTo(0.04, 12)
    expect(DEFAULT_REPLAY_PARAMS.borrowLtvGap).toBeCloseTo(0.03, 12)
  })

  it('a wider band saves a position that broke under the real 4%', () => {
    const prices = [anchor, ...rounds([1, priceFor(0.84)], [3, priceFor(0.7)])]
    expect(replayLiquidation(ev, prices).verdict).toBe('broke')
    expect(replayLiquidation(ev, prices, { ...DEFAULT_REPLAY_PARAMS, band: 0.1 }).verdict).toBe(
      'saved',
    )
  })
})

describe('totalHistory', () => {
  const mk = (
    verdict: HistoryEvent['verdict'],
    actual: number,
    membrane: number,
  ): HistoryEvent => ({
    ts: T0,
    protocol: 'Aave V3',
    collateral: 'WETH',
    actualSeizedUsd: actual,
    verdict,
    membraneSeizedUsd: membrane,
    membraneShare: actual > 0 ? membrane / actual : null,
    why: '',
  })

  it('sums saves in dollars and counts, and reports the non-saves separately', () => {
    const t = totalHistory([
      mk('saved', 41_200, 0),
      mk('saved', 8_800, 0),
      mk('partial', 10_000, 3_000),
      mk('broke', 5_000, 1_500),
      mk('unknown', 0, 0),
    ])
    expect(t.savedUsd).toBe(50_000)
    expect(t.savedCount).toBe(2)
    // partialUsd is what Membrane would still have KEPT on the ones it could not save.
    expect(t.partialUsd).toBe(7_000)
    expect(t.partialCount).toBe(1)
    expect(t.brokeCount).toBe(1)
    expect(t.unpricedCount).toBe(1)
  })

  it('an unpriced event never becomes a save', () => {
    const t = totalHistory([mk('unknown', 999_999, 0)])
    expect(t.savedUsd).toBe(0)
    expect(t.savedCount).toBe(0)
    expect(t.unpricedCount).toBe(1)
  })

  it('no events at all is all zeroes — the UI prints a sentence, not a number', () => {
    const t = totalHistory([])
    expect(t).toEqual({
      savedUsd: 0,
      savedCount: 0,
      partialUsd: 0,
      partialCount: 0,
      brokeCount: 0,
      unpricedCount: 0,
    })
  })
})
