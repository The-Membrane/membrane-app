import { describe, expect, it } from 'vitest'

import {
  DEFAULT_REPLAY_PARAMS,
  EPISODE_GAP_SECONDS,
  clusterEpisodes,
  netKeptUsd,
  replayEpisode,
  replayLiquidation,
  totalHistory,
  type HistoricLiquidation,
  type HistoryEpisode,
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
    expect(r.membraneLiquidations).toBe(0)
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

// ------------------------------------------------------------------- episodes
// OWNER RULING 2026-09-12: "assert that the partial closes take into account the
// possibility of those positions RE-LIQUIDATING, not just assuming they only liquidate
// once." Everything below is that assertion.

describe('clusterEpisodes', () => {
  it('two real events 3h apart are ONE episode', () => {
    const eps = clusterEpisodes([{ ts: T0 }, { ts: T0 + 3 * HOUR }])
    expect(eps).toHaveLength(1)
    expect(eps[0]).toHaveLength(2)
  })

  it('events more than 24h apart are separate episodes', () => {
    const eps = clusterEpisodes([{ ts: T0 }, { ts: T0 + EPISODE_GAP_SECONDS + 1 }])
    expect(eps).toHaveLength(2)
  })

  it('a run of hits each within 24h of the PREVIOUS one stays one episode', () => {
    const eps = clusterEpisodes([
      { ts: T0 },
      { ts: T0 + 20 * HOUR },
      { ts: T0 + 40 * HOUR },
      { ts: T0 + 100 * HOUR },
    ])
    expect(eps.map((e) => e.length)).toEqual([3, 1])
  })
})

describe('replayEpisode — the re-liquidation chain', () => {
  it('a price that keeps falling causes TWO Membrane seizures inside 72h, and the second is counted', () => {
    // Window 1 expires at +8h with the LTV over the 77% cap: repay-to-cap. The fee comes
    // out of collateral, so the survivor sits close to its line; the price keeps sliding,
    // it re-crosses, a NEW 8h timer arms and expires into a second seizure.
    const prices = [
      anchor,
      ...rounds(
        [1, priceFor(0.81)],
        [10, priceFor(0.82)],
        [20, priceFor(0.83)],
        [40, priceFor(0.84)],
      ),
    ]
    const r = replayEpisode([ev], prices)
    expect(r.membraneLiquidations).toBeGreaterThanOrEqual(2)
    expect(r.seizures.length).toBe(r.membraneLiquidations)
    // The second bite is real money, not a rounding artefact, and it is LATER.
    expect(r.seizures[1].usd).toBeGreaterThan(0)
    expect(r.seizures[1].ts).toBeGreaterThan(r.seizures[0].ts)
    // The reported total is the SUM of the chain, not just the first sale.
    const sum = r.seizures.reduce((a, s) => a + s.usd, 0)
    expect(r.membraneSeizedUsd).toBeCloseTo(sum, 6)
    expect(r.membraneSeizedUsd).toBeGreaterThan(r.seizures[0].usd)
    expect(r.why).toMatch(/Membrane liquidations/)
  })

  it('a partial followed by a RECOVERY is exactly one seizure', () => {
    // Over the cap at the +8h expiry (one repay-to-cap), then the price recovers hard and
    // the position never sits over its line at another expiry for the rest of the 72h.
    const r = replayEpisode(
      [ev],
      [anchor, ...rounds([1, priceFor(0.81)], [9, priceFor(0.6)], [30, priceFor(0.55)])],
    )
    expect(r.verdict).toBe('partial')
    expect(r.membraneLiquidations).toBe(1)
    expect(r.membraneSeizedUsd).toBeGreaterThan(0)
    expect(r.membraneSeizedUsd).toBeLessThan(r.actualSeizedUsd)
  })

  it('WORSE: a chain that costs more than the real liquidator did is reported, not hidden', () => {
    // The real liquidator took a token $2k slice. Membrane's repay-to-cap against the
    // same $100k of debt is far larger, so the honest verdict is 'worse', share > 1.
    const tiny: HistoricLiquidation = { ...ev, collateralSeizedUsd: 2_000 }
    const r = replayEpisode([tiny], [anchor, ...rounds([1, priceFor(0.82)])])
    expect(r.verdict).toBe('worse')
    expect(r.membraneSeizedUsd).toBeGreaterThan(r.actualSeizedUsd)
    // The share is NOT clamped to 1 — the UI has to be able to print "worse".
    expect(r.membraneShare!).toBeGreaterThan(1)
  })

  it('two real events 3h apart replay as ONE episode carrying both their debts', () => {
    const a: HistoricLiquidation = { ...ev, collateralSeizedUsd: 60_000, debtRepaidUsd: 50_000 }
    const b: HistoricLiquidation = {
      ...ev,
      ts: T0 + 3 * HOUR,
      collateralSeizedUsd: 40_000,
      debtRepaidUsd: 30_000,
    }
    const prices = [anchor, ...rounds([1, priceFor(0.81)], [4, priceFor(0.82)])]
    const both = replayEpisode([a, b], prices)
    const justA = replayEpisode([a], prices)

    expect(both.actualSeizedUsd).toBe(100_000)
    // 80k of debt is repaid to the cap, not 50k, so the episode's seizure is strictly
    // bigger than the one the first event alone would have produced.
    expect(both.membraneSeizedUsd).toBeGreaterThan(justA.membraneSeizedUsd)
    expect(both.verdict).toBe('partial')
  })

  it('a wiped position ends the chain and says so', () => {
    // Straight to deeply underwater: one seizure takes the whole slice, the walk stops.
    const r = replayEpisode([ev], [anchor, ...rounds([1, priceFor(3)], [20, priceFor(4)])])
    expect(r.wiped).toBe(true)
    expect(r.membraneLiquidations).toBe(1)
  })
})

describe('totalHistory', () => {
  const mk = (
    verdict: HistoryEpisode['verdict'],
    actual: number,
    membrane: number,
    membraneLiquidations = membrane > 0 ? 1 : 0,
  ): HistoryEpisode => ({
    startTs: T0,
    endTs: T0,
    protocol: 'Aave V3',
    collateral: 'WETH',
    events: [],
    actualSeizedUsd: actual,
    membraneSeizedUsd: membrane,
    membraneLiquidations,
    verdict,
    membraneShare: actual > 0 ? membrane / actual : null,
    why: '',
  })

  it('sums saves in dollars and counts, and reports the non-saves separately', () => {
    const t = totalHistory([
      mk('saved', 41_200, 0),
      mk('saved', 8_800, 0),
      mk('partial', 10_000, 3_000, 2),
      mk('broke', 5_000, 1_500),
      mk('worse', 4_000, 4_500),
      mk('unknown', 0, 0),
    ])
    expect(t.savedUsd).toBe(50_000)
    expect(t.savedCount).toBe(2)
    // partialKeptUsd is what Membrane would still have KEPT on the ones it could not save.
    expect(t.partialKeptUsd).toBe(7_000)
    expect(t.partialCount).toBe(1)
    expect(t.brokeCount).toBe(1)
    expect(t.worseCount).toBe(1)
    expect(t.unknownCount).toBe(1)
    // Re-liquidations included: 2 on the partial, 1 on the broke, 1 on the worse.
    expect(t.membraneLiquidationsTotal).toBe(4)
  })

  it('uses one net for the history total, hero and share card, including worse episodes', () => {
    expect(
      netKeptUsd([
        mk('saved', 50_000, 0),
        mk('partial', 10_000, 3_000),
        mk('worse', 4_000, 4_500),
        mk('unknown', 999_999, 0),
      ]),
    ).toBe(56_500)
    expect(netKeptUsd([mk('unknown', 999_999, 0)])).toBeNull()
    expect(netKeptUsd([])).toBeNull()
  })

  it('an unpriced episode never becomes a save', () => {
    const t = totalHistory([mk('unknown', 999_999, 0)])
    expect(t.savedUsd).toBe(0)
    expect(t.savedCount).toBe(0)
    expect(t.unknownCount).toBe(1)
    expect(t.membraneLiquidationsTotal).toBe(0)
  })

  it('no episodes at all is all zeroes — the UI prints a sentence, not a number', () => {
    const t = totalHistory([])
    expect(t).toEqual({
      savedUsd: 0,
      savedCount: 0,
      partialKeptUsd: 0,
      partialCount: 0,
      brokeCount: 0,
      worseCount: 0,
      unknownCount: 0,
      membraneLiquidationsTotal: 0,
    })
  })
})
