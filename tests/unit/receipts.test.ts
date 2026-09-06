import { describe, expect, it } from 'vitest'

import {
  buildReceiptStatement,
  calibrationReadout,
  computeCalibration,
  fmtStatementUsd,
  formatMadeAt,
  metricForKind,
  scoreHit,
} from '@/components/Receipts/receiptLogic'
import { buildReceiptCardModel } from '@/components/Receipts/receiptShareCardModel'

// Contract tests for the CALLED-IT RECEIPTS pure logic — the SAME functions the
// browser signs with, the API verifies with, and the scorer's containment rule.
// What must hold: the canonical statement is deterministic (client and server
// must agree byte-for-byte or every signature breaks), band containment is
// inclusive, the calibration readout is numbers-only with a clean empty state,
// and a MISS is never softened in the card model.

describe('canonical statement (byte-for-byte determinism)', () => {
  const claim = {
    venue: 'sUSDe',
    metric: 'total_assets' as const,
    bandLow: 1.2e9,
    bandHigh: 1.6e9,
    probabilityPct: 70,
    horizonHours: 72,
    madeAt: '2026-09-06T12:00:00.000Z',
  }

  it('matches the specified format exactly', () => {
    expect(buildReceiptStatement(claim)).toBe(
      'I call: sUSDe total_assets between $1.2B and $1.6B in 72h of 2026-09-06T12:00Z. Confidence 70%. — Membrane Called-It',
    )
  })

  it('is stable across sub-minute made_at precision (client vs server rebuild)', () => {
    const a = buildReceiptStatement({ ...claim, madeAt: '2026-09-06T12:00:00.000Z' })
    const b = buildReceiptStatement({ ...claim, madeAt: '2026-09-06T12:00:59.482Z' })
    expect(a).toBe(b) // both normalize to minute precision
    expect(formatMadeAt('2026-09-06T12:00:59.482Z')).toBe('2026-09-06T12:00Z')
  })

  it('same inputs always produce the identical string', () => {
    expect(buildReceiptStatement(claim)).toBe(buildReceiptStatement({ ...claim }))
  })
})

describe('fmtStatementUsd (deterministic compact USD)', () => {
  it('scales and strips trailing zeros', () => {
    expect(fmtStatementUsd(1.2e9)).toBe('$1.2B')
    expect(fmtStatementUsd(1_600_000_000)).toBe('$1.6B')
    expect(fmtStatementUsd(360_500_000)).toBe('$360.5M')
    expect(fmtStatementUsd(40_000)).toBe('$40k')
    expect(fmtStatementUsd(999)).toBe('$999')
    expect(fmtStatementUsd(2_000_000)).toBe('$2M')
  })
})

describe('metricForKind', () => {
  it('maps venue kind to its one honest metric', () => {
    expect(metricForKind('atoken-liquidity')).toBe('instant_usd')
    expect(metricForKind('erc4626-cooldown')).toBe('total_assets')
    expect(metricForKind('something-else')).toBeNull()
  })
})

describe('band containment (the only scoring rule)', () => {
  it('is inclusive on both ends', () => {
    expect(scoreHit(1.4e9, 1.2e9, 1.6e9)).toBe(true)
    expect(scoreHit(1.2e9, 1.2e9, 1.6e9)).toBe(true) // low boundary
    expect(scoreHit(1.6e9, 1.2e9, 1.6e9)).toBe(true) // high boundary
  })
  it('is a MISS outside the band, with no partial credit', () => {
    expect(scoreHit(1.19e9, 1.2e9, 1.6e9)).toBe(false)
    expect(scoreHit(1.61e9, 1.2e9, 1.6e9)).toBe(false)
  })
})

describe('calibration aggregate (read-time, numbers-only)', () => {
  it('empty state is exactly "0 of 0 scored"', () => {
    const cal = computeCalibration([])
    expect(cal.nScored).toBe(0)
    expect(cal.hitRate).toBeNull()
    expect(cal.brier).toBeNull()
    expect(calibrationReadout(cal)).toBe('0 of 0 scored')
    expect(calibrationReadout(null)).toBe('0 of 0 scored')
  })

  it('tallies scored, in-band, and expected-in-band from stated confidence', () => {
    const cal = computeCalibration([
      { probabilityPct: 70, hit: true },
      { probabilityPct: 60, hit: false },
      { probabilityPct: 90, hit: true },
      { probabilityPct: 50, hit: false },
    ])
    expect(cal.nScored).toBe(4)
    expect(cal.nInBand).toBe(2)
    expect(cal.hitRate).toBeCloseTo(0.5, 10)
    // expected in-band = Σ p_i = 0.70 + 0.60 + 0.90 + 0.50 = 2.7
    expect(cal.expectedInBand).toBeCloseTo(2.7, 10)
    expect(calibrationReadout(cal)).toBe(
      'your calls: 4 scored, 2 in-band; at your stated confidences the expected in-band was 2.7',
    )
  })

  it('brier is mean (p - outcome)^2', () => {
    const cal = computeCalibration([
      { probabilityPct: 100 as number, hit: true }, // (1-1)^2 = 0
      { probabilityPct: 0 as number, hit: false }, // (0-0)^2 = 0
    ])
    expect(cal.brier).toBeCloseTo(0, 10)
    const cal2 = computeCalibration([
      { probabilityPct: 100, hit: false }, // (1-0)^2 = 1
      { probabilityPct: 0, hit: true }, // (0-1)^2 = 1
    ])
    expect(cal2.brier).toBeCloseTo(1, 10)
  })

  it('ignores rows without a boolean hit (unscored leak-through)', () => {
    const cal = computeCalibration([
      { probabilityPct: 70, hit: true },
      { probabilityPct: 80, hit: undefined as unknown as boolean },
    ])
    expect(cal.nScored).toBe(1)
  })
})

describe('receipt card model — a MISS is never softened', () => {
  const base = {
    statement: 'I call: sUSDe total_assets between $1.2B and $1.6B in 72h of 2026-09-06T12:00Z. Confidence 70%. — Membrane Called-It',
    realized: 1.7e9,
    bandLow: 1.2e9,
    bandHigh: 1.6e9,
    scoredAtText: '2026-09-09',
  }

  it('states MISS at full volume with the realized number, unhedged', () => {
    const m = buildReceiptCardModel({ ...base, hit: false })
    expect(m.verdict).toBe('MISS')
    expect(m.outcomeLine).toBe('realized $1.7B vs band $1.2B–$1.6B')
    // no softening language anywhere in the model copy
    const copy = `${m.verdict} ${m.outcomeLine} ${m.headline} ${m.eyebrow}`.toLowerCase()
    for (const soft of ['almost', 'close', 'nearly', 'just missed', 'so close', 'barely']) {
      expect(copy).not.toContain(soft)
    }
  })

  it('states HIT with its realized number and the recorder footer', () => {
    const m = buildReceiptCardModel({ ...base, hit: true, realized: 1.4e9 })
    expect(m.verdict).toBe('HIT')
    expect(m.outcomeLine).toBe('realized $1.4B vs band $1.2B–$1.6B')
    expect(m.headline).toBe(base.statement)
    expect(m.footerLeft).toBe('scored by the membrane recorder')
    expect(m.footerRight).toBe('2026-09-09')
  })
})
