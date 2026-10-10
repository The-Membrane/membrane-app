import { describe, expect, it } from 'vitest'

import type { LocalHistoricalCashScenario } from '@/lib/carry/localHistoricalCashScenario'
import type { HistoricalCashPair } from '@/lib/carry/historicalCashProjection'
import {
  backtestAbsoluteQEndpointCash,
  buildExitImpactForecast,
  type ExitImpactForecastInput,
  type HistoricalCashTimelineObservation,
} from '@/lib/forecast/exitImpactForecast'

const DAY = 86_400_000
const START = Date.parse('2026-01-01T00:00:00.000Z')
const identity = {
  routeKey: 'USDC → supply on Aave V3',
  destination: '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c',
  asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  assetDecimals: 6,
}
const key = `${identity.routeKey}\0${identity.destination}\0${identity.asset}`

function pairs(): HistoricalCashPair[] {
  return Array.from({ length: 60 }, (_, index) => {
    const sourceAt = START + index * 2 * DAY
    return {
      subjectKey: key,
      sourceAt: new Date(sourceAt).toISOString(),
      targetAt: new Date(sourceAt + DAY).toISOString(),
      sourceCashRaw: '1000',
      targetCashRaw: index % 20 < 12 ? '800' : '1100',
    }
  })
}

function dailyTimeline(pairs: HistoricalCashPair[]): HistoricalCashTimelineObservation[] {
  return pairs.flatMap((pair) => [
    { subjectKey: pair.subjectKey, at: pair.sourceAt, cashRaw: pair.sourceCashRaw },
    { subjectKey: pair.subjectKey, at: pair.targetAt, cashRaw: pair.targetCashRaw },
  ])
}

function scenario(
  overrides: Partial<
    Extract<LocalHistoricalCashScenario, { status: 'historical_conditional_cash_scenario' }>
  > = {},
): Extract<LocalHistoricalCashScenario, { status: 'historical_conditional_cash_scenario' }> {
  return {
    status: 'historical_conditional_cash_scenario',
    claim: 'aggregate_underlying_cash_proxy_only',
    method: 'learned_delta',
    prospectiveValidated: false,
    holderExecutableExit: false,
    sourceKind: 'local_sha_replayed_finalized_rpc',
    currentBlockAt: '2020-01-01T00:00:00.000Z',
    currentBlock: '100',
    currentBlockHash: `0x${'a'.repeat(64)}`,
    targetAt: '2020-01-02T00:00:00.000Z',
    currentCashRaw: '5000',
    pointRaw: '2600',
    bandLowRaw: '2000',
    bandHighRaw: '3000',
    assetDecimals: 6,
    pairs: 60,
    fit: 20,
    calibration: 20,
    selection: 10,
    selectionCovered: 9,
    holdout: 10,
    holdoutCovered: 9,
    holdoutPointBeatsPersistence: true,
    holdoutModelMae: { numeratorRaw: '100', denominator: 10 },
    holdoutPersistenceMae: { numeratorRaw: '200', denominator: 10 },
    ...overrides,
  }
}

describe('absolute-Q endpoint cash backtest', () => {
  it('scores the exact Q against historical endpoints without a current or live read', () => {
    const result = backtestAbsoluteQEndpointCash({
      subjectKey: key,
      requestedRaw: '900',
      horizonHours: 24,
      pairs: pairs(),
    })

    expect(result).toMatchObject({
      status: 'historical_backtest',
      claim: 'aggregate_endpoint_cash_proxy_only',
      historicalBacktestOnly: true,
      prospectiveValidated: false,
      holderExecutableExit: false,
      counts: { total: 60, fit: 20, calibration: 20, holdout: 20 },
      outcomes: {
        fitBelowQ: { numerator: 12, denominator: 20 },
        calibrationBelowQ: { numerator: 12, denominator: 20 },
        holdoutBelowQ: { numerator: 12, denominator: 20 },
      },
      scoring: {
        calibrationStable: true,
        calibrationBeatsPersistence: true,
        holdoutBeatsPersistence: true,
      },
      retrospectiveSignal: { status: 'supported', reason: null },
    })
  })

  it('keeps a valid zero-event backtest while abstaining from discrimination', () => {
    const noBreaches = pairs().map((pair) => ({ ...pair, targetCashRaw: '1100' }))
    expect(
      backtestAbsoluteQEndpointCash({
        subjectKey: key,
        requestedRaw: '900',
        horizonHours: 24,
        pairs: noBreaches,
      }),
    ).toMatchObject({
      status: 'historical_backtest',
      outcomes: { holdoutBelowQ: { numerator: 0, denominator: 20 } },
      retrospectiveSignal: {
        status: 'unavailable',
        reason: 'insufficient_outcome_support',
      },
    })
  })

  it('fails closed on the wrong subject, shared endpoints, short history, and zero Q', () => {
    const wrong = pairs()
    wrong[5] = { ...wrong[5], subjectKey: 'another subject' }
    expect(
      backtestAbsoluteQEndpointCash({
        subjectKey: key,
        requestedRaw: '900',
        horizonHours: 24,
        pairs: wrong,
      }),
    ).toMatchObject({ status: 'unavailable', reason: 'subject_mismatch' })

    const overlapping = pairs()
    overlapping[1] = {
      ...overlapping[1],
      sourceAt: overlapping[0].targetAt,
      targetAt: new Date(Date.parse(overlapping[0].targetAt) + DAY).toISOString(),
    }
    expect(
      backtestAbsoluteQEndpointCash({
        subjectKey: key,
        requestedRaw: '900',
        horizonHours: 24,
        pairs: overlapping,
      }),
    ).toMatchObject({ status: 'unavailable', reason: 'overlapping_history' })
    expect(
      backtestAbsoluteQEndpointCash({
        subjectKey: key,
        requestedRaw: '900',
        horizonHours: 24,
        pairs: pairs().slice(0, 59),
      }),
    ).toMatchObject({ status: 'unavailable', reason: 'insufficient_history' })
    expect(
      backtestAbsoluteQEndpointCash({
        subjectKey: key,
        requestedRaw: '0',
        horizonHours: 24,
        pairs: pairs(),
      }),
    ).toMatchObject({ status: 'unavailable', reason: 'invalid_question' })
  })
})

describe('shared exit-impact envelope', () => {
  it('returns a first-class retrospective envelope with Q-relative margins', () => {
    const result = buildExitImpactForecast({
      kind: 'retrospective_backtest',
      identity,
      requestedRaw: '900',
      horizonHours: 24,
      pairs: pairs(),
      dailyTimeline: dailyTimeline(pairs()),
    })

    expect(result).toMatchObject({
      status: 'historical_backtest',
      analysisKind: 'retrospective_backtest',
      claimClass: 'route_proxy',
      holderExecutableExit: false,
      prospectiveValidated: false,
      forecastValidated: false,
      reference: {
        basis: 'historical_tail_endpoint',
        cashRaw: '1100',
        marginAfterQRaw: '200',
        state: 'cash_covers_q',
      },
      duration: {
        status: 'historical_interval_outlook',
        claim: 'aggregate_endpoint_cash_proxy_only',
        intervalCensored: true,
        prospectiveValidated: false,
        holderExecutableExit: false,
        requestedRaw: '900',
        observations: 120,
        observedBelowQSamples: 36,
        timelineSegments: 1,
        verifiedTimelineCoverageSeconds: 10_281_600,
        samplingCadenceSeconds: 86400,
        samplingToleranceSeconds: 5400,
        interpretation: 'completed_sampled_below_q_runs_with_censored_observed_spans',
        sampledRuns: 36,
        completedSampledRuns: 36,
        leftCensoredRuns: 0,
        rightCensoredRuns: 0,
        bothBoundaryCensoredRuns: 0,
        completedSampledRunDurationSeconds: {
          median: { low: 0, high: 172800 },
          p90: { low: 0, high: 172800 },
          longest: { low: 0, high: 172800 },
        },
        censoredRunObservedSpanLowerBoundSeconds: {
          leftLongest: null,
          rightLongest: null,
        },
      },
      cashBand: {
        status: 'available',
        evidence: 'retrospective_backtest',
        modelKind: 'endpoint_net_cash_band',
        flowTreatment: 'all_aggregate_flow_already_included',
        method: 'learned_delta',
        capacityRaw: { low: '900', point: '900', high: '1200' },
        expectedNetFlowRaw: { low: '-200', point: '-200', high: '100' },
        marginAfterQRaw: { low: '0', point: '0', high: '300' },
        projectedState: 'band_covers_q',
        direction: 'shrinking',
        holdout: {
          fit: 20,
          calibration: 20,
          selection: 10,
          selectionCovered: 10,
          holdout: 10,
          covered: 10,
          coveragePassed: true,
          pointBeatsPersistence: false,
        },
      },
      alert: { status: 'unavailable', reason: 'retrospective_only' },
    })
  })

  it('surfaces a boundary-censored sampled span without inventing a completed duration', () => {
    const result = buildExitImpactForecast({
      kind: 'retrospective_backtest',
      identity,
      requestedRaw: '900',
      horizonHours: 24,
      pairs: pairs().map((pair) => ({
        ...pair,
        sourceCashRaw: '800',
        targetCashRaw: '800',
      })),
      dailyTimeline: dailyTimeline(
        pairs().map((pair) => ({ ...pair, sourceCashRaw: '800', targetCashRaw: '800' })),
      ),
    })

    expect(result).toMatchObject({
      status: 'historical_backtest',
      duration: {
        status: 'historical_interval_outlook',
        observedBelowQSamples: 120,
        sampledRuns: 1,
        completedSampledRuns: 0,
        leftCensoredRuns: 1,
        rightCensoredRuns: 1,
        bothBoundaryCensoredRuns: 1,
        completedSampledRunDurationSeconds: null,
        censoredRunObservedSpanLowerBoundSeconds: {
          leftLongest: 10_281_600,
          rightLongest: 10_281_600,
        },
      },
    })
  })

  it('uses the separately verified daily timeline and refuses a mismatched or missing timeline', () => {
    const history = pairs()
    const input = {
      kind: 'retrospective_backtest' as const,
      identity,
      requestedRaw: '900',
      horizonHours: 24 as const,
      pairs: history,
    }
    expect(buildExitImpactForecast(input)).toMatchObject({
      status: 'historical_backtest',
      duration: { status: 'unavailable', reason: 'verified_daily_duration_timeline_unavailable' },
    })
    const forged = dailyTimeline(history)
    forged[2] = { ...forged[2], cashRaw: '800' }
    expect(buildExitImpactForecast({ ...input, dailyTimeline: forged })).toMatchObject({
      duration: { status: 'unavailable', reason: 'verified_daily_duration_timeline_unavailable' },
    })
  })

  it('splits sampled runs across a missing daily observation instead of joining impairment', () => {
    const history = pairs().map((pair) => ({
      ...pair,
      sourceCashRaw: '1000',
      targetCashRaw: '1000',
    }))
    history[0] = { ...history[0], targetCashRaw: '800' }
    history[1] = { ...history[1], sourceCashRaw: '800' }
    const input = {
      kind: 'retrospective_backtest' as const,
      identity,
      requestedRaw: '900',
      horizonHours: 24 as const,
    }
    expect(
      buildExitImpactForecast({ ...input, pairs: history, dailyTimeline: dailyTimeline(history) }),
    ).toMatchObject({
      duration: {
        status: 'historical_interval_outlook',
        completedSampledRuns: 1,
        completedSampledRunDurationSeconds: { longest: { low: 86400, high: 259200 } },
      },
    })

    const shifted = history.map((pair, index) =>
      index === 0
        ? pair
        : {
            ...pair,
            sourceAt: new Date(Date.parse(pair.sourceAt) + DAY).toISOString(),
            targetAt: new Date(Date.parse(pair.targetAt) + DAY).toISOString(),
          },
    )
    expect(
      buildExitImpactForecast({ ...input, pairs: shifted, dailyTimeline: dailyTimeline(shifted) }),
    ).toMatchObject({
      status: 'historical_backtest',
      duration: {
        status: 'historical_interval_outlook',
        timelineSegments: 2,
        sampledRuns: 2,
        completedSampledRuns: 0,
        leftCensoredRuns: 1,
        rightCensoredRuns: 1,
        bothBoundaryCensoredRuns: 0,
        completedSampledRunDurationSeconds: null,
        censoredRunObservedSpanLowerBoundSeconds: { leftLongest: 0, rightLongest: 0 },
      },
    })
  })

  it('does not infer uninterrupted impairment or holder restriction between daily samples', () => {
    const history = pairs().map((pair) => ({
      ...pair,
      sourceCashRaw: '1000',
      targetCashRaw: '1000',
    }))
    history[0] = { ...history[0], targetCashRaw: '800' }
    history[1] = { ...history[1], sourceCashRaw: '800' }
    const result = buildExitImpactForecast({
      kind: 'retrospective_backtest',
      identity,
      requestedRaw: '900',
      horizonHours: 24,
      pairs: history,
      dailyTimeline: dailyTimeline(history),
    })
    expect(result.duration).toMatchObject({
      status: 'historical_interval_outlook',
      claim: 'aggregate_endpoint_cash_proxy_only',
      interpretation: 'completed_sampled_below_q_runs_with_censored_observed_spans',
      holderExecutableExit: false,
    })
  })

  it('keeps holder probability, isolated competing flow, and causal news impact unavailable', () => {
    const result = buildExitImpactForecast({
      kind: 'retrospective_backtest',
      identity,
      requestedRaw: '900',
      horizonHours: 24,
      pairs: pairs(),
      dailyTimeline: dailyTimeline(pairs()),
    })

    expect(result).toMatchObject({
      probabilityQExecutable: {
        status: 'unavailable',
        reason: 'prospective_holder_outcomes_missing',
      },
      duration: { status: 'historical_interval_outlook' },
      expectedCompetingFlow: {
        status: 'unavailable',
        reason: 'already_embedded_in_net_cash_endpoints',
      },
      newsImpact: { status: 'unavailable', reason: 'no_causal_news_event_model' },
    })
  })

  it('wraps a conditional scenario without checking wall-clock freshness or double-subtracting flow', () => {
    const input: ExitImpactForecastInput & { grossOutflowRaw: string } = {
      kind: 'conditional_projection',
      identity,
      requestedRaw: '2500',
      horizonHours: 24,
      scenario: scenario(),
      grossOutflowRaw: '999999999999999999999',
    }
    const result = buildExitImpactForecast(input)

    expect(result).toMatchObject({
      status: 'research_projection',
      analysisKind: 'conditional_live_projection',
      reference: {
        at: '2020-01-01T00:00:00.000Z',
        cashRaw: '5000',
        marginAfterQRaw: '2500',
      },
      cashBand: {
        capacityRaw: { low: '2000', point: '2600', high: '3000' },
        expectedNetFlowRaw: { low: '-3000', point: '-2400', high: '-2000' },
        marginAfterQRaw: { low: '-500', point: '100', high: '500' },
        flowTreatment: 'all_aggregate_flow_already_included',
        projectedState: 'band_crosses_q',
        direction: 'shrinking',
      },
      expectedCompetingFlow: {
        status: 'unavailable',
        reason: 'already_embedded_in_net_cash_endpoints',
      },
      alert: { status: 'estimated', kind: 'projected_shrink' },
    })
  })

  it('withholds the selected learned band when untouched coverage or point skill fails', () => {
    for (const failedTest of [
      scenario({
        holdoutCovered: 0,
        holdoutPointBeatsPersistence: true,
      }),
      scenario({
        holdoutCovered: 9,
        holdoutPointBeatsPersistence: false,
        holdoutModelMae: { numeratorRaw: '300', denominator: 10 },
      }),
    ]) {
      const result = buildExitImpactForecast({
        kind: 'conditional_projection',
        identity,
        requestedRaw: '2500',
        horizonHours: 24,
        scenario: failedTest,
      })

      expect(result).toMatchObject({
        status: 'unavailable',
        reason: 'source_unavailable',
        sourceReason: 'untouched_test_not_qualified',
      })
      expect(result).not.toHaveProperty('cashBand')
      expect(result).not.toHaveProperty('reference')
    }
  })

  it('withholds the selected persistence band when untouched coverage fails', () => {
    const result = buildExitImpactForecast({
      kind: 'conditional_projection',
      identity,
      requestedRaw: '2500',
      horizonHours: 24,
      scenario: scenario({
        method: 'persistence_band',
        pointRaw: '5000',
        holdoutCovered: 0,
        holdoutPointBeatsPersistence: null,
        holdoutModelMae: null,
        holdoutPersistenceMae: null,
      }),
    })

    expect(result).toMatchObject({
      status: 'unavailable',
      reason: 'source_unavailable',
      sourceReason: 'untouched_test_not_qualified',
    })
    expect(result).not.toHaveProperty('cashBand')
    expect(result).not.toHaveProperty('reference')
  })

  it('preserves source abstention and rejects malformed questions and scenarios', () => {
    expect(
      buildExitImpactForecast({
        kind: 'conditional_projection',
        identity,
        requestedRaw: '2500',
        horizonHours: 24,
        scenario: { status: 'unavailable', reason: 'no_fresh_current_cash' },
      }),
    ).toMatchObject({
      status: 'unavailable',
      reason: 'source_unavailable',
      sourceReason: 'no_fresh_current_cash',
    })
    expect(
      buildExitImpactForecast({
        kind: 'conditional_projection',
        identity,
        requestedRaw: '0',
        horizonHours: 24,
        scenario: scenario(),
      }),
    ).toMatchObject({ status: 'unavailable', reason: 'invalid_question' })
    expect(
      buildExitImpactForecast({
        kind: 'conditional_projection',
        identity,
        requestedRaw: '2500',
        horizonHours: 24,
        scenario: scenario({ targetAt: '2020-01-01T23:00:00.000Z' }),
      }),
    ).toMatchObject({
      status: 'unavailable',
      reason: 'source_unavailable',
      sourceReason: 'invalid_scenario',
    })
  })
})
