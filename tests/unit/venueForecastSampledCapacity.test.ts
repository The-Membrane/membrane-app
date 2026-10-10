import { describe, expect, it } from 'vitest'

import {
  forecastSampledCapacity,
  measureSampledCapacityPersistence,
  type CapacityForecastInput,
  type CapacitySnapshot,
  type MeasuredCapacityPersistenceInput,
} from '@/lib/venueForecast/sampledCapacity'

const start = Date.parse('2026-01-01T00:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()
const HOUR = 3_600_000

describe('measured capacity persistence', () => {
  const input = (
    values: Array<number | null>,
    overrides: Partial<MeasuredCapacityPersistenceInput> = {},
  ): MeasuredCapacityPersistenceInput => ({
    venue: 'test-venue',
    routeKey: 'ethereum:test-venue:recorded-route',
    costCapPct: 1,
    amountUsd: 100,
    cadenceHours: 1,
    asOf: iso(start + (values.length - 1) * HOUR + 60_000),
    snapshots: values.map((capacityUsd, index) => ({
      capacityUsd,
      observedAt: iso(start + index * HOUR),
      firstAvailableAt: iso(start + index * HOUR + 60_000),
      sourceId: `sample-${index}`,
      coverage: capacityUsd === null ? 'partial' : 'complete',
    })),
    ...overrides,
  })

  it('measures >= Q runs, complete sample share and bounded sampled crossings', () => {
    const result = measureSampledCapacityPersistence(input([90, 100, 110, 90, 120, 130]))
    expect(result).toMatchObject({
      status: 'measured_history',
      forwardForecast: false,
      holderExecutable: false,
      currentStatus: 'at_or_above',
      freshnessHours: 2,
      sampleShare: { atOrAboveQ: 4, complete: 6, fraction: 4 / 6 },
      coverage: { recordedSamples: 6, expectedSamples: 6, completeSamples: 6, completedRuns: 1 },
    })
    expect(result.currentRun).toMatchObject({
      firstObservedAt: iso(start + 4 * HOUR),
      lastObservedAt: iso(start + 5 * HOUR),
      sampledSpanHours: 1,
      leftCensored: false,
      rightCensored: true,
      startCrossing: { after: iso(start + 3 * HOUR), atOrBefore: iso(start + 4 * HOUR) },
    })
    expect(result.longestCompletedRun).toMatchObject({
      sampledSpanHours: 1,
      leftCensored: false,
      rightCensored: false,
      startCrossing: { after: iso(start), atOrBefore: iso(start + HOUR) },
      endCrossing: { after: iso(start + 2 * HOUR), atOrBefore: iso(start + 3 * HOUR) },
      sampledRunCrossingBoundsHours: { lower: 1, upper: 3 },
    })
    expect(result.series.map((sample) => sample.atOrAboveQ)).toEqual([
      false,
      true,
      true,
      false,
      true,
      true,
    ])
  })

  it('keeps an above-Q series start left censored and never extends it to as-of time', () => {
    const result = measureSampledCapacityPersistence(input([100, 110]))
    expect(result.currentRun).toMatchObject({
      sampledSpanHours: 1,
      leftCensored: true,
      leftCensorReason: 'series_start',
      startCrossing: null,
      sampledRunCrossingBoundsHours: { lower: 1, upper: null },
    })
  })

  it('keeps an ended left-censored span separate from fully completed sampled runs', () => {
    const result = measureSampledCapacityPersistence(input([100, 110, 90]))
    expect(result.currentStatus).toBe('below')
    expect(result.longestCompletedRun).toBeNull()
    expect(result.coverage).toMatchObject({ completedRuns: 0, leftCensoredEndedRuns: 1 })
  })

  it.each(['null', 'partial', 'unverified', 'missing_clock'])(
    'censors a %s middle sample and starts a separate observed run',
    (failure) => {
      const question = input([100, 120, 130, 140])
      if (failure === 'null') question.snapshots[1].capacityUsd = null
      if (failure === 'partial') question.snapshots[1].coverage = 'partial'
      if (failure === 'unverified') question.snapshots[1].coverage = 'unverified'
      if (failure === 'missing_clock') question.snapshots[1].firstAvailableAt = null
      const result = measureSampledCapacityPersistence(question)
      expect(result.currentRun).toMatchObject({
        firstObservedAt: iso(start + 2 * HOUR),
        sampledSpanHours: 1,
        leftCensored: true,
        leftCensorReason: 'incomplete_sample',
      })
      expect(result.coverage).toMatchObject({
        completeSamples: 3,
        incompleteSamples: 1,
        incompleteCensoredRuns: 1,
        completeFraction: 3 / 4,
      })
      expect(result.longestCompletedRun).toBeNull()
    },
  )

  it('counts missing cadence slots and censors excessive gaps rather than bridging', () => {
    const question = input([100, 120, 130, 140])
    question.snapshots[2].observedAt = iso(start + 5 * HOUR)
    question.snapshots[2].firstAvailableAt = iso(start + 5 * HOUR + 60_000)
    question.snapshots[3].observedAt = iso(start + 6 * HOUR)
    question.snapshots[3].firstAvailableAt = iso(start + 6 * HOUR + 60_000)
    question.asOf = iso(start + 6 * HOUR + 60_000)
    const result = measureSampledCapacityPersistence(question)
    expect(result.currentRun).toMatchObject({
      firstObservedAt: iso(start + 5 * HOUR),
      sampledSpanHours: 1,
      leftCensorReason: 'excessive_gap',
    })
    expect(result.coverage).toMatchObject({
      expectedSamples: 7,
      missingExpectedSamples: 3,
      completeExpectedSamples: 4,
      completeFraction: 4 / 7,
      excessiveGaps: 1,
      gapCensoredRuns: 1,
    })
  })

  it('censors exactly two cadence intervals and tolerates ordinary recorder timing drift', () => {
    const question = input([90, 100, 110, 90])
    for (const [index, hour] of [0, 1, 3, 4].entries()) {
      question.snapshots[index].observedAt = iso(start + hour * HOUR)
      question.snapshots[index].firstAvailableAt = iso(start + hour * HOUR + 60_000)
    }
    question.asOf = iso(start + 4 * HOUR + 60_000)
    const result = measureSampledCapacityPersistence(question)
    expect(result.coverage).toMatchObject({
      missingExpectedSamples: 1,
      excessiveGaps: 1,
      gapCensoredRuns: 1,
      completedRuns: 0,
      leftCensoredEndedRuns: 1,
    })
    expect(result.longestCompletedRun).toBeNull()

    const drift = input([90, 100, 110, 90])
    drift.snapshots[2].observedAt = iso(start + 2 * HOUR + 4 * 60_000)
    drift.snapshots[2].firstAvailableAt = iso(start + 2 * HOUR + 5 * 60_000)
    const measured = measureSampledCapacityPersistence(drift)
    expect(measured.coverage.missingExpectedSamples).toBe(0)
    expect(measured.coverage.completedRuns).toBe(1)
  })

  it('censors a stale or incomplete latest sample even when an older run existed', () => {
    const stale = measureSampledCapacityPersistence(
      input([100, 120], { asOf: iso(start + 4 * HOUR) }),
    )
    expect(stale).toMatchObject({
      currentStatus: 'censored',
      currentCensorReason: 'latest_sample_stale',
      currentRun: null,
    })
    expect(stale.coverage).toMatchObject({ expectedSamples: 5, missingExpectedSamples: 3 })
    const failed = measureSampledCapacityPersistence(input([100, null]))
    expect(failed).toMatchObject({
      currentStatus: 'censored',
      currentCensorReason: 'incomplete_sample',
      currentRun: null,
    })
    expect(measureSampledCapacityPersistence(input([100, 90])).currentStatus).toBe('below')
  })

  it('uses the declared cadence and does not count duplicates or future receipts as complete samples', () => {
    const cadence = measureSampledCapacityPersistence(
      input([100], { cadenceHours: 0.25, asOf: iso(start + 31 * 60_000) }),
    )
    expect(cadence.currentCensorReason).toBe('latest_sample_stale')
    const duplicate = input([100, 120, 130])
    duplicate.snapshots[1].sourceId = duplicate.snapshots[0].sourceId
    expect(measureSampledCapacityPersistence(duplicate).coverage.completeSamples).toBe(1)
    const future = input([100, 120])
    future.snapshots[1].firstAvailableAt = iso(start + 3 * HOUR)
    expect(measureSampledCapacityPersistence(future).sampleShare.complete).toBe(1)
    const bad = input([100])
    bad.snapshots[0].observedAt = 'bad'
    expect(measureSampledCapacityPersistence(bad).reason).toBe('invalid_snapshot')
    expect(measureSampledCapacityPersistence(input([], { asOf: iso(start) })).reason).toBe(
      'no_samples',
    )
  })
})

function series(count = 1000, stepHours = 3, slopePerHour = 100): CapacitySnapshot[] {
  return Array.from({ length: count }, (_, i) => {
    const t = start + i * stepHours * HOUR
    return {
      block: 20_000_000 + i,
      observedAt: iso(t),
      firstAvailableAt: iso(t + 60_000),
      capacityUsd: 1_000_000 + i * stepHours * slopePerHour,
      sourceId: `receipt-${i}`,
      coverage: 'complete',
    }
  })
}

function question(
  snapshots = series(),
  overrides: Partial<CapacityForecastInput> = {},
): CapacityForecastInput {
  const last = Date.parse(snapshots[snapshots.length - 1].observedAt)
  return {
    routeKey: 'ethereum:aave-v3-usde:reserve-cash:v1',
    metric: 'instant_usd',
    amountUsd: 1_100_000,
    horizonHours: 24,
    asOf: iso(last + 60_000),
    splitAt: iso(start + (last - start) * 0.6),
    snapshots,
    ...overrides,
  }
}

describe('sampled capacity proxy forecast', () => {
  it('backtests with a horizon embargo, nonoverlap, train calibration and persistence comparator', () => {
    const result = forecastSampledCapacity(question())
    expect(result.status, result.reason ?? '').toBe('research_projection')
    expect(result.reason).toBeNull()
    expect(result.claim).toBe('sampled_capacity_proxy_only')
    expect(result.holderExecutable).toBe(false)
    expect(result.predictiveAlertEligible).toBe(false)
    expect(result.projection?.method).toBe('historical_delta')
    expect(result.projection?.capacityUsd).toBeCloseTo(1_000_000 + 999 * 300 + 2400)
    expect(result.projection?.bandLevel).toBe(0.9)
    expect(result.backtest.holdout.bandCoverage).toBe(1)
    expect(result.backtest.holdout.modelMaeUsd).toBe(0)
    expect(result.backtest.holdout.persistenceMaeUsd).toBe(2400)
    expect(result.backtest.fit.eligible).toBeGreaterThanOrEqual(20)
    expect(result.backtest.calibration.eligible).toBeGreaterThanOrEqual(20)
    expect(result.backtest.holdout.eligible).toBeGreaterThanOrEqual(20)
    expect(Date.parse(result.backtest.fit.lastIssuedAt!)).toBeLessThan(
      Date.parse(result.backtest.holdout.firstIssuedAt!),
    )
  })

  it('supports a user-selected one-hour horizon only with matching cadence', () => {
    const dense = series(1000, 0.25, 100)
    const supported = forecastSampledCapacity(
      question(dense, { horizonHours: 1, maxGapHours: 0.3, maxTargetOffsetHours: 0.1 }),
    )
    expect(supported.status).toBe('research_projection')
    const sparse = forecastSampledCapacity(question(series(), { horizonHours: 1 }))
    expect(sparse.status).toBe('abstain')
    expect(sparse.backtest.holdout.eligible).toBe(0)
    const hourly = forecastSampledCapacity(question(series(1000, 1, 100), { horizonHours: 1 }))
    expect(hourly.status).toBe('research_projection')
  })

  it('trains the full interval from an aged current source to the requested future time', () => {
    const snapshots = series(4000, 1, 100)
    const lastAvailable = Date.parse(snapshots.at(-1)!.firstAvailableAt!)
    const asOf = iso(lastAvailable + HOUR)
    const result = forecastSampledCapacity(question(snapshots, { asOf, horizonHours: 24 }))
    expect(result.status, result.reason ?? '').toBe('research_projection')
    expect(result.projection?.targetAt).toBe(iso(Date.parse(asOf) + 24 * HOUR))
    expect(result.projection?.capacityUsd).toBeCloseTo(1_000_000 + 3999 * 100 + 2500)
    expect(result.backtest.embargoHours).toBeCloseTo(25 + 1 / 60)
  })

  it('matches physical source time when the latest receipt has an unusual delay', () => {
    const snapshots = series(4000, 1, 100)
    const last = snapshots.at(-1)!
    last.firstAvailableAt = iso(Date.parse(last.observedAt) + 45 * 60_000)
    const asOf = iso(Date.parse(last.observedAt) + HOUR)
    const result = forecastSampledCapacity(question(snapshots, { asOf, horizonHours: 24 }))
    expect(result.status, result.reason ?? '').toBe('research_projection')
    expect(result.projection?.capacityUsd).toBeCloseTo(1_000_000 + 3999 * 100 + 2500)
    expect(result.backtest.embargoHours).toBe(25)
  })

  it('abstains when issue clocks or physical source identities are missing', () => {
    const snapshots = series()
    expect(
      forecastSampledCapacity(
        question(snapshots.map((s, i) => (i === 9 ? { ...s, firstAvailableAt: null } : s))),
      ).reason,
    ).toBe('source_clock_missing')
    expect(
      forecastSampledCapacity(
        question(snapshots.map((s, i) => (i === 9 ? { ...s, sourceId: null } : s))),
      ).reason,
    ).toBe('source_identity_missing')
  })

  it('does not use a late source for an earlier issue or an incomplete path as a control', () => {
    const snapshots = series()
    const late = snapshots.map((s, i) =>
      i === 500 ? { ...s, firstAvailableAt: iso(Date.parse(s.observedAt) + 48 * HOUR) } : s,
    )
    const incomplete = snapshots.map((s, i) =>
      i === 400 ? { ...s, coverage: 'partial' as const } : s,
    )
    const a = forecastSampledCapacity(question(late))
    const b = forecastSampledCapacity(question(incomplete))
    expect(a.backtest.fit.censored + a.backtest.calibration.censored).toBeGreaterThan(0)
    expect(b.backtest.fit.censored + b.backtest.calibration.censored).toBeGreaterThan(0)
  })

  it('refuses stale current readings and unsupported requested horizons', () => {
    expect(
      forecastSampledCapacity(
        question(series(), { asOf: iso(start + 1000 * 3 * HOUR + 48 * HOUR) }),
      ).reason,
    ).toBe('current_observation_stale')
    expect(forecastSampledCapacity(question(series(), { horizonHours: 721 })).reason).toBe(
      'invalid_question',
    )
  })

  it('keeps a backtested persistence band without implying an executable withdrawal', () => {
    const flat = series(1000, 3, 0)
    const result = forecastSampledCapacity(question(flat))
    expect(result.status).toBe('research_projection')
    expect(result.projection?.method).toBe('persistence')
    expect(result.projection?.capacityUsd).toBe(1_000_000)
    expect(result.holderExecutable).toBe(false)
  })

  it('does not manufacture a supported holdout from a short history', () => {
    const result = forecastSampledCapacity(question(series(100)))
    expect(result.status).toBe('abstain')
    expect(result.projection).toBeNull()
    expect(['insufficient_fit', 'insufficient_calibration', 'insufficient_holdout']).toContain(
      result.reason,
    )
  })

  it('uses a deterministic time split and reports sampled durations without a likely-duration claim', () => {
    const snapshots = series().map((row, i) => ({
      ...row,
      capacityUsd: i >= 200 && i < 204 ? 900_000 : row.capacityUsd,
    }))
    const input = question(snapshots, { amountUsd: 1_010_000 })
    delete input.splitAt
    const result = forecastSampledCapacity(input)
    expect(result.backtest.splitAt).toBe(iso(start + 999 * 3 * HOUR * 0.7))
    expect(result.duration.observedEpisodes).toBeGreaterThanOrEqual(1)
    expect(result.duration.completed).toBeGreaterThanOrEqual(1)
    expect(result.duration.maxCompletedObservedSpanHours).toBeGreaterThanOrEqual(9)
    expect(result.duration.durationForecast).toEqual({
      status: 'unavailable',
      reason: 'recovery_validation_missing',
    })
  })

  it('censors a failed historical sample without hiding the rest of the backtest', () => {
    const snapshots = series()
    snapshots[400] = { ...snapshots[400], capacityUsd: null }
    const result = forecastSampledCapacity(question(snapshots))
    expect(result.status).toBe('research_projection')
    expect(result.reason).toBeNull()
    expect(result.sourceSpan.incompleteSnapshots).toBe(1)
    expect(result.backtest.fit.censored + result.backtest.calibration.censored).toBeGreaterThan(0)
    expect(result.backtest.fit.eligible + result.backtest.calibration.eligible).toBeGreaterThan(40)
  })

  it('abstains when the latest capacity is null despite a fresh previous pass', () => {
    const snapshots = series()
    snapshots[snapshots.length - 1] = { ...snapshots[snapshots.length - 1], capacityUsd: null }
    const result = forecastSampledCapacity(question(snapshots))
    expect(result.status).toBe('abstain')
    expect(result.reason).toBe('no_current_observation')
    expect(result.sourceSpan.incompleteSnapshots).toBe(1)
  })

  it('abstains when the newest pass is partial even if an older complete pass is fresh', () => {
    const snapshots = series()
    snapshots[snapshots.length - 1] = { ...snapshots[snapshots.length - 1], coverage: 'partial' }
    const result = forecastSampledCapacity(question(snapshots))
    expect(result.status).toBe('abstain')
    expect(result.reason).toBe('no_current_observation')
  })
})
