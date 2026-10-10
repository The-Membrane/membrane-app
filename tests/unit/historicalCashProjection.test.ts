import { describe, expect, it } from 'vitest'

import {
  projectHistoricalCash,
  type HistoricalCashPair,
} from '@/lib/carry/historicalCashProjection'

const SUBJECT = 'LINK:0xvault:0xasset'
const HOUR_MS = 3_600_000
const START = Date.parse('2026-01-01T00:00:00.000Z')
const MAX_RAW = (1n << 256n) - 1n

function fixture(
  count = 60,
  delta = (_index: number) => 10n,
  source = (_index: number) => 1_000n,
  horizonHours: 1 | 24 = 1,
) {
  const pairs: HistoricalCashPair[] = Array.from({ length: count }, (_, index) => {
    const sourceAt = START + index * (horizonHours + 1) * HOUR_MS
    const sourceCash = source(index)
    return {
      subjectKey: SUBJECT,
      sourceAt: new Date(sourceAt).toISOString(),
      targetAt: new Date(sourceAt + horizonHours * HOUR_MS).toISOString(),
      sourceCashRaw: sourceCash.toString(),
      targetCashRaw: (sourceCash + delta(index)).toString(),
    }
  })
  return {
    subjectKey: SUBJECT,
    horizonHours,
    currentAt: new Date(START + count * (horizonHours + 1) * HOUR_MS).toISOString(),
    currentCashRaw: '1000',
    pairs,
  }
}

describe('historical exact-subject cash projection', () => {
  it('requires disjoint fit, calibration, selection, and untouched test stages', () => {
    const unavailable = projectHistoricalCash(fixture(59))
    expect(unavailable.status).toBe('unavailable')
    expect(unavailable.reason).toBe('insufficient_history')
    expect(unavailable.projection).toBeNull()
    const ready = projectHistoricalCash(fixture(60))
    expect(ready.status).toBe('historical_projection')
    expect(ready.counts).toEqual({
      total: 60,
      fit: 20,
      calibration: 20,
      selection: 10,
      holdout: 10,
    })
    expect(ready.selection).toMatchObject({
      covered: 10,
      total: 10,
      coveragePassed: true,
      pointBeatsPersistence: true,
    })
    expect(ready.holdout).toMatchObject({
      covered: 10,
      total: 10,
      coveragePassed: true,
      pointBeatsPersistence: true,
      modelMae: { numeratorRaw: '0', denominator: 10 },
      persistenceMae: { numeratorRaw: '100', denominator: 10 },
    })
    expect(ready.projection).toMatchObject({
      pointRaw: '1010',
      bandLowRaw: '1010',
      bandHighRaw: '1010',
      fitMedianDeltaRaw: '10',
    })
    expect(ready).toMatchObject({
      claim: 'aggregate_cash_proxy_only',
      historicalBacktestOnly: true,
      prospectiveValidated: false,
      holderExecutableExit: false,
    })
  })

  it('rejects shared endpoints, shuffled pairs, and future holdout outcomes', () => {
    const shared = fixture()
    shared.pairs[1] = {
      ...shared.pairs[1],
      sourceAt: shared.pairs[0].targetAt,
      targetAt: new Date(Date.parse(shared.pairs[0].targetAt) + HOUR_MS).toISOString(),
    }
    expect(projectHistoricalCash(shared).reason).toBe('overlapping_history')
    const shuffled = fixture()
    ;[shuffled.pairs[0], shuffled.pairs[1]] = [shuffled.pairs[1], shuffled.pairs[0]]
    expect(projectHistoricalCash(shuffled).reason).toBe('overlapping_history')
    const future = fixture()
    future.currentAt = future.pairs.at(-1)!.sourceAt
    expect(projectHistoricalCash(future).reason).toBe('future_outcome')
  })

  it('preserves 78-digit uint256 cash and clamps projected upper bounds', () => {
    const large = fixture(
      60,
      () => 10n,
      () => MAX_RAW - 1_000n,
    )
    large.currentCashRaw = (MAX_RAW - 5n).toString()
    const result = projectHistoricalCash(large)
    expect(result.status).toBe('historical_projection')
    expect(result.projection?.pointRaw).toBe(MAX_RAW.toString())
    expect(result.projection?.bandHighRaw).toBe(MAX_RAW.toString())
    expect(result.holdout?.modelMae.numeratorRaw).toBe('0')
  })

  it('clamps declining cash at zero without floating-point conversion', () => {
    const declining = fixture(60, () => -10n)
    declining.currentCashRaw = '5'
    const result = projectHistoricalCash(declining)
    expect(result.status).toBe('historical_projection')
    expect(result.projection?.pointRaw).toBe('0')
    expect(result.projection?.bandLowRaw).toBe('0')
  })

  it('keeps an empirically offset band even when it excludes the point', () => {
    const sample = fixture(60, (index) => (index < 20 ? 10n : 20n))
    const result = projectHistoricalCash(sample)
    expect(result.status).toBe('historical_projection')
    expect(result.projection).toMatchObject({
      pointRaw: '1010',
      bandLowRaw: '1020',
      bandHighRaw: '1020',
    })
    expect(result.holdout?.pointBeatsPersistence).toBe(true)
  })

  it('uses an empirical calibration percentile rather than the highest outlier', () => {
    const sample = fixture(60, (index) => (index === 39 ? 1_010n : 10n))
    const result = projectHistoricalCash(sample)
    expect(result.status).toBe('historical_projection')
    expect(result.projection?.calibrationResidualP95Raw).toBe('0')
    expect(result.holdout?.covered).toBe(10)
  })

  it('withholds a band when point error fails to beat persistence', () => {
    const sample = fixture(60, (index) => {
      if (index < 20) return 10n
      if (index < 40) return index % 2 === 0 ? 0n : 20n
      return 0n
    })
    const result = projectHistoricalCash(sample)
    expect(result.reason).toBe('no_skill_over_persistence')
    expect(result.projection).toBeNull()
    expect(result.holdout).toMatchObject({
      covered: 10,
      coveragePassed: true,
      pointBeatsPersistence: false,
      modelMae: { numeratorRaw: '100', denominator: 10 },
      persistenceMae: { numeratorRaw: '0', denominator: 10 },
    })
  })

  it('withholds a learned band when selection coverage is below 80%', () => {
    const sample = fixture(60, (index) => (index >= 45 && index < 50 ? 20n : 10n))
    const result = projectHistoricalCash(sample)
    expect(result.reason).toBe('no_skill_over_persistence')
    expect(result.projection).toBeNull()
    expect(result.selection).toMatchObject({
      covered: 5,
      total: 10,
      coveragePassed: false,
      pointBeatsPersistence: true,
    })
    expect(result.holdout).toMatchObject({ covered: 10, total: 10, coveragePassed: true })
  })

  it('reports an untouched test failure without changing the selected model', () => {
    const sample = fixture(60, (index) => (index >= 50 ? 0n : 10n))
    const result = projectHistoricalCash(sample)
    expect(result.status).toBe('historical_projection')
    expect(result.selection).toMatchObject({
      covered: 10,
      total: 10,
      pointBeatsPersistence: true,
    })
    expect(result.holdout).toMatchObject({
      covered: 0,
      total: 10,
      coveragePassed: false,
      pointBeatsPersistence: false,
    })
  })

  it('selects persistence on selection failure even when untouched test favors learned', () => {
    const sample = fixture(60, (index) => (index >= 40 && index < 50 ? 0n : 10n))
    const result = projectHistoricalCash(sample)
    expect(result.status).toBe('unavailable')
    expect(result.selection?.pointBeatsPersistence).toBe(false)
    expect(result.holdout?.pointBeatsPersistence).toBe(true)
    expect(result.baselineBand?.selectionCoveragePassed).toBe(false)
  })

  it('has no skill claim on zero flows or a tied persistence baseline', () => {
    const zero = fixture(
      60,
      () => 0n,
      () => 0n,
    )
    zero.currentCashRaw = '0'
    const result = projectHistoricalCash(zero)
    expect(result.reason).toBe('no_skill_over_persistence')
    expect(result.projection).toBeNull()
    expect(result.holdout?.modelMae.numeratorRaw).toBe('0')
    expect(result.holdout?.persistenceMae.numeratorRaw).toBe('0')
    expect(result.baselineBand).toMatchObject({
      pointRaw: '0',
      bandLowRaw: '0',
      bandHighRaw: '0',
      selectionCovered: 10,
      selectionTotal: 10,
      holdoutCovered: 10,
      holdoutTotal: 10,
      coveragePassed: true,
    })
  })

  it('rejects malformed raw values, wrong subjects, and wrong physical horizons', () => {
    const wrongSubject = fixture()
    wrongSubject.pairs[5] = { ...wrongSubject.pairs[5], subjectKey: 'OTHER' }
    expect(projectHistoricalCash(wrongSubject).reason).toBe('subject_mismatch')
    const malformed = fixture()
    malformed.pairs[5] = { ...malformed.pairs[5], targetCashRaw: '1e9' }
    expect(projectHistoricalCash(malformed).reason).toBe('malformed_history')
    const overflow = fixture()
    overflow.pairs[5] = { ...overflow.pairs[5], targetCashRaw: (MAX_RAW + 1n).toString() }
    expect(projectHistoricalCash(overflow).reason).toBe('malformed_history')
    const wrongHorizon = fixture()
    wrongHorizon.pairs[5] = {
      ...wrongHorizon.pairs[5],
      targetAt: new Date(Date.parse(wrongHorizon.pairs[5].sourceAt) + 2 * HOUR_MS).toISOString(),
    }
    expect(projectHistoricalCash(wrongHorizon).reason).toBe('malformed_history')
    expect(projectHistoricalCash({ ...fixture(), currentCashRaw: '-1' }).reason).toBe(
      'invalid_question',
    )
  })

  it('accepts disjoint 24-hour outcomes only when their physical horizon matches', () => {
    const result = projectHistoricalCash(
      fixture(
        60,
        () => 10n,
        () => 1_000n,
        24,
      ),
    )
    expect(result.status).toBe('historical_projection')
    expect(result.projection?.targetAt).toBe(
      new Date(
        Date.parse(
          fixture(
            60,
            () => 10n,
            () => 1_000n,
            24,
          ).currentAt,
        ) +
          24 * HOUR_MS,
      ).toISOString(),
    )
  })
})
