import { describe, expect, it } from 'vitest'

import { backtestAggregateCashQ } from '@/lib/carry/aggregateCashQHoldout'
import type { HistoricalCashPair } from '@/lib/carry/historicalCashProjection'

const SUBJECT = 'route\0vault\0asset'
const DAY_MS = 86_400_000
const START = Date.parse('2026-01-01T00:00:00.000Z')
const MAX_RAW = (1n << 256n) - 1n

function fixture(
  count = 60,
  breach = (index: number) => index % 20 < 12,
  sourceCash = 1_000n,
  targetCash = (breached: boolean) => (breached ? 800n : 1_000n),
) {
  const pairs: HistoricalCashPair[] = Array.from({ length: count }, (_, index) => {
    const sourceAt = START + index * 2 * DAY_MS
    return {
      subjectKey: SUBJECT,
      sourceAt: new Date(sourceAt).toISOString(),
      targetAt: new Date(sourceAt + DAY_MS).toISOString(),
      sourceCashRaw: sourceCash.toString(),
      targetCashRaw: targetCash(breach(index)).toString(),
    }
  })
  const currentAt = new Date(START + count * 2 * DAY_MS).toISOString()
  return {
    subjectKey: SUBJECT,
    currentAt,
    asOfAt: currentAt,
    currentCashRaw: sourceCash.toString(),
    requestedAssetsRaw: ((sourceCash * 9n) / 10n).toString(),
    pairs,
  }
}

describe('exact-Q aggregate cash historical holdout', () => {
  it('tests one current Q fraction on 60 chronological, disjoint 24h pairs', () => {
    const result = backtestAggregateCashQ(fixture())
    expect(result).toMatchObject({
      status: 'historical_backtest',
      reason: null,
      claim: 'aggregate_cash_proxy_only',
      historicalBacktestOnly: true,
      prospectiveValidated: false,
      holderExecutableExit: false,
      counts: { total: 60, fit: 20, calibration: 20, holdout: 20 },
      evidence: {
        method: 'fit_frequency_baseline',
        requestedFraction: { numeratorRaw: '900', denominatorRaw: '1000' },
        fitBreaches: { numerator: 12, denominator: 20 },
        calibrationBreaches: { numerator: 12, denominator: 20 },
        holdoutBreaches: { numerator: 12, denominator: 20 },
        calibrationStable: true,
        holdoutBeatsPersistence: true,
      },
    })
    expect(result.evidence?.holdoutBrier).toEqual({ numerator: '1920', denominator: 8000 })
    expect(result.evidence?.holdoutPersistenceBrier).toEqual({
      numerator: '4800',
      denominator: 8000,
    })
  })

  it('rejects stale current cash, future outcomes, wrong subject, and shared endpoints', () => {
    const stale = fixture()
    stale.asOfAt = new Date(Date.parse(stale.currentAt) + 2 * 3_600_000 + 1).toISOString()
    expect(backtestAggregateCashQ(stale).reason).toBe('stale_current')

    const future = fixture()
    future.currentAt = future.pairs.at(-1)!.sourceAt
    future.asOfAt = future.currentAt
    expect(backtestAggregateCashQ(future).reason).toBe('future_outcome')

    const wrong = fixture()
    wrong.pairs[2] = { ...wrong.pairs[2], subjectKey: 'other' }
    expect(backtestAggregateCashQ(wrong).reason).toBe('subject_mismatch')

    const overlapping = fixture()
    overlapping.pairs[1] = {
      ...overlapping.pairs[1],
      sourceAt: overlapping.pairs[0].targetAt,
      targetAt: new Date(Date.parse(overlapping.pairs[0].targetAt) + DAY_MS).toISOString(),
    }
    expect(backtestAggregateCashQ(overlapping).reason).toBe('overlapping_history')
  })

  it('requires adequate independent history and nonzero current/source cash', () => {
    expect(backtestAggregateCashQ(fixture(59)).reason).toBe('insufficient_history')
    const noCurrent = fixture()
    noCurrent.currentCashRaw = '0'
    expect(backtestAggregateCashQ(noCurrent).reason).toBe('invalid_question')
    const noSource = fixture()
    noSource.pairs[0] = { ...noSource.pairs[0], sourceCashRaw: '0' }
    expect(backtestAggregateCashQ(noSource).reason).toBe('zero_historical_source')
    const tooLargeQ = fixture()
    tooLargeQ.requestedAssetsRaw = '1001'
    expect(backtestAggregateCashQ(tooLargeQ).reason).toBe('invalid_question')
  })

  it('uses exact BigInt cross products at the uint256 boundary', () => {
    const source = MAX_RAW - 10n
    const input = fixture(
      60,
      (index) => index % 20 < 12,
      source,
      (breached) => source - (breached ? 1n : 0n),
    )
    input.currentCashRaw = MAX_RAW.toString()
    input.requestedAssetsRaw = (MAX_RAW - 1n).toString()
    const result = backtestAggregateCashQ(input)
    expect(result.status).toBe('historical_backtest')
    expect(result.evidence?.fitBreaches.numerator).toBe(12)
    input.requestedAssetsRaw = (MAX_RAW - 2n).toString()
    expect(backtestAggregateCashQ(input).reason).toBe('insufficient_breach_support')
  })

  it('withholds a signal when calibration drifts or holdout loses to persistence', () => {
    const drift = fixture(60, (index) =>
      index < 20 ? index < 12 : index < 40 ? index < 25 : index < 52,
    )
    expect(backtestAggregateCashQ(drift).reason).toBe('unstable_calibration')

    const weakHoldout = fixture(60, (index) => (index < 40 ? index % 20 < 12 : index < 45))
    const result = backtestAggregateCashQ(weakHoldout)
    expect(result.reason).toBe('no_skill_over_persistence')
    expect(result.evidence?.holdoutBeatsPersistence).toBe(false)
    expect(result.evidence?.holdoutBreaches).toEqual({ numerator: 5, denominator: 20 })
  })
})
