import { describe, expect, it } from 'vitest'

import {
  replaySampledHistoricalCashPaths,
  type HistoricalSampledCashPathsInput,
} from '@/lib/carry/historicalSampledCashPaths'

const DAY = 86_400_000
const origin = Date.parse('2026-01-01T00:00:00.000Z')
const identity = {
  routeKey: 'native supply',
  destination: 'vault',
  asset: 'USDC',
  assetDecimals: 6,
}
const subjectKey = `${identity.routeKey}\0${identity.destination}\0${identity.asset}`
function input(cash = [100, 80, 60, 30, 40, 70, 90, 100]): HistoricalSampledCashPathsInput {
  const asOfMs = origin + (cash.length + 1) * DAY
  return {
    identity: { ...identity },
    requestedRaw: '50',
    asOfMs,
    current: {
      cashRaw: '100',
      blockAt: new Date(asOfMs).toISOString(),
      block: '1000',
      blockHash: `0x${'a'.repeat(64)}`,
      subjectKey,
      asset: identity.asset,
      assetDecimals: 6,
    },
    timelineIdentity: { subjectKey, asset: identity.asset, assetDecimals: 6 },
    timeline: cash.map((amount, index) => ({
      subjectKey,
      at: new Date(origin + index * DAY).toISOString(),
      cashRaw: String(amount),
    })),
  }
}
function available(value: HistoricalSampledCashPathsInput) {
  const result = replaySampledHistoricalCashPaths(value)
  expect(result.status).toBe('conditional_historical_sampled_cash_paths')
  if (result.status !== 'conditional_historical_sampled_cash_paths') throw new Error(result.reason)
  return result
}
function reason(value: HistoricalSampledCashPathsInput, expected: string) {
  expect(replaySampledHistoricalCashPaths(value)).toMatchObject({
    status: 'unavailable',
    reason: expected,
  })
}

describe('conditional sampled historical cash paths', () => {
  it('translates native cash change and subtracts Q exactly once with observed brackets', () => {
    const result = available(input())
    expect(result).toMatchObject({
      horizonHours: 168,
      prospectiveValidated: false,
      holderExecutableExit: false,
      forwardProbability: false,
      counts: { samples: 8, eligibleEpisodes: 1, gaps: 0 },
    })
    expect(result.examples.worstTrough).toMatchObject({
      troughCashDeltaRaw: '-70',
      troughCashRaw: '30',
      troughMarginAfterQRaw: '-20',
      troughDeficitAfterQRaw: '20',
      endpointCashRaw: '100',
      endpointMarginAfterQRaw: '50',
      sampledBelowQ: {
        firstBelowAt: new Date(origin + 3 * DAY).toISOString(),
        lastBelowAt: new Date(origin + 4 * DAY).toISOString(),
        onsetBracket: {
          afterAt: new Date(origin + 2 * DAY).toISOString(),
          byAt: new Date(origin + 3 * DAY).toISOString(),
        },
        recoveryBracket: {
          afterAt: new Date(origin + 4 * DAY).toISOString(),
          byAt: new Date(origin + 5 * DAY).toISOString(),
        },
        sampledBelowQSpanSeconds: DAY / 1000,
        leftCensored: false,
        rightCensored: false,
        gapCensored: false,
      },
    })
  })

  it('selects the late unrecovered run containing the trough and endpoint after an earlier recovery', () => {
    const value = input([100, 80, 110, 110, 110, 110, 10, 20])
    value.requestedRaw = '90'
    const result = available(value)
    for (const example of [
      result.examples.worstTrough,
      result.examples.p10Trough,
      result.examples.worstEndpoint,
    ]) {
      expect(example).toMatchObject({
        selectedRunIndex: 1,
        runCount: 2,
        sampledBelowQ: {
          firstBelowAt: new Date(origin + 6 * DAY).toISOString(),
          lastBelowAt: new Date(origin + 7 * DAY).toISOString(),
          onsetBracket: {
            afterAt: new Date(origin + 5 * DAY).toISOString(),
            byAt: new Date(origin + 6 * DAY).toISOString(),
          },
          recoveryBracket: null,
          nextAboveQObservationAt: null,
          sampledBelowQSpanSeconds: 86400,
          leftCensored: false,
          rightCensored: true,
        },
      })
    }
    expect(result.examples.worstTrough.selectedTarget).toBe('trough')
    expect(result.examples.worstEndpoint.selectedTarget).toBe('endpoint')
    expect(result.examples.worstTrough).not.toBe(result.examples.p10Trough)
    expect(result.examples.worstTrough.sampledBelowQ).not.toBe(
      result.examples.worstEndpoint.sampledBelowQ,
    )
  })

  it('leaves endpoint timing empty when endpoint covers Q but attaches the trough run recovery', () => {
    const value = input([100, 80, 110, 110, 110, 110, 10, 100])
    value.requestedRaw = '90'
    const result = available(value)
    expect(result.examples.worstTrough).toMatchObject({
      selectedRunIndex: 1,
      runCount: 2,
      sampledBelowQ: {
        firstBelowAt: new Date(origin + 6 * DAY).toISOString(),
        nextAboveQObservationAt: new Date(origin + 7 * DAY).toISOString(),
        rightCensored: false,
        sampledBelowQSpanSeconds: 0,
      },
    })
    expect(result.examples.worstEndpoint).toMatchObject({
      selectedTarget: 'endpoint',
      selectedRunIndex: null,
      runCount: 2,
      sampledBelowQ: {
        firstBelowAt: null,
        lastBelowAt: null,
        onsetBracket: null,
        recoveryBracket: null,
        sampledBelowQSpanSeconds: null,
        leftCensored: false,
        rightCensored: false,
      },
    })
  })

  it('finds the trough run after multiple recoveries when current cash is already below Q', () => {
    const value = input([100, 150, 110, 160, 80, 170, 40, 140])
    value.current.cashRaw = '20'
    const result = available(value)
    expect(result.examples.worstTrough).toMatchObject({
      selectedRunIndex: 3,
      runCount: 4,
      sampledBelowQ: {
        firstBelowAt: new Date(origin + 6 * DAY).toISOString(),
        leftCensored: false,
        rightCensored: false,
        nextAboveQObservationAt: new Date(origin + 7 * DAY).toISOString(),
      },
    })
    expect(result.examples.worstEndpoint.selectedRunIndex).toBeNull()
  })

  it('keeps worst and shallow p10 timing attached to their own runs independently of current/Q ranks', () => {
    const cash = [100]
    for (let episode = 0; episode < 11; episode++) {
      const path =
        episode === 0
          ? [80, 110, 110, 110, 110, 10, 100]
          : episode === 1
            ? [80, 110, 110, 20, 110, 110, 100]
            : [30 + episode, 110, 110, 110, 110, 110, 100]
      cash.push(...path)
    }
    const value = input(cash)
    value.requestedRaw = '90'
    const result = available(value)
    expect(result.examples.worstTrough).toMatchObject({
      episodeIndex: 0,
      selectedRunIndex: 1,
      sampledBelowQ: { firstBelowAt: new Date(origin + 6 * DAY).toISOString() },
    })
    expect(result.examples.p10Trough).toMatchObject({
      episodeIndex: 1,
      selectedRunIndex: 1,
      sampledBelowQ: { firstBelowAt: new Date(origin + 11 * DAY).toISOString() },
    })
    value.current.cashRaw = '1'
    value.requestedRaw = '1000000'
    const changed = available(value)
    expect(changed.examples.worstTrough.episodeIndex).toBe(result.examples.worstTrough.episodeIndex)
    expect(changed.examples.p10Trough.episodeIndex).toBe(result.examples.p10Trough.episodeIndex)
    expect(changed.examples.p10Trough.sampledBelowQ).toMatchObject({
      leftCensored: true,
      rightCensored: true,
    })
  })

  it('floors replay cash at zero before calculating deficit', () => {
    const value = input()
    value.current.cashRaw = '10'
    const example = available(value).examples.worstTrough
    expect(example.troughCashRaw).toBe('0')
    expect(example.troughMarginAfterQRaw).toBe('-50')
    expect(example.troughDeficitAfterQRaw).toBe('50')
    expect(example.sampledBelowQ).toMatchObject({
      leftCensored: true,
      rightCensored: true,
      sampledBelowQSpanSeconds: 604800,
    })
  })

  it('reports a single sampled below-Q state as zero observed span and treats equality as coverage', () => {
    const example = available(input([100, 100, 40, 50, 100, 100, 100, 100])).examples.worstTrough
    expect(example.sampledBelowQ).toMatchObject({
      sampledBelowQSpanSeconds: 0,
      nextAboveQObservationAt: new Date(origin + 3 * DAY).toISOString(),
    })
    expect(
      Object.keys(example.sampledBelowQ).some((key) =>
        /continuous|duration|probability/i.test(key),
      ),
    ).toBe(false)
    expect(available(input(Array(8).fill(100))).examples.worstTrough.sampledBelowQ).toMatchObject({
      firstBelowAt: null,
      sampledBelowQSpanSeconds: null,
      onsetBracket: null,
      recoveryBracket: null,
    })
  })

  it('retains distinct left and right censoring', () => {
    const left = input([100, 150, 150, 150, 150, 150, 150, 150])
    left.current.cashRaw = '20'
    expect(available(left).examples.worstTrough.sampledBelowQ).toMatchObject({
      leftCensored: true,
      rightCensored: false,
      onsetBracket: null,
    })
    const right = input([100, 100, 100, 100, 100, 40, 40, 40])
    expect(available(right).examples.worstTrough.sampledBelowQ).toMatchObject({
      leftCensored: false,
      rightCensored: true,
      recoveryBracket: null,
      sampledBelowQSpanSeconds: 172800,
    })
  })

  it('freezes nonoverlapping spans anchored to the oldest sample and ranks before flooring', () => {
    const cash = Array.from({ length: 22 }, (_, index) =>
      index % 7 === 0 ? 100 : index < 7 ? 70 : index < 14 ? 10 : 50,
    )
    const high = input(cash)
    const low = input(cash)
    low.current.cashRaw = '1'
    low.requestedRaw = '1000000'
    const a = available(high)
    const b = available(low)
    expect(a.counts).toMatchObject({
      candidateEpisodes: 3,
      eligibleEpisodes: 3,
      trailingSamples: 0,
    })
    expect(a.examples.worstTrough.episodeIndex).toBe(1)
    expect(b.examples.worstTrough.episodeIndex).toBe(1)
    expect(b.examples.p10Trough.episodeIndex).toBe(a.examples.p10Trough.episodeIndex)
    expect(a.examples.worstTrough.originAt).toBe(new Date(origin + 7 * DAY).toISOString())
    expect(a.examples.worstTrough.endpointAt).toBe(new Date(origin + 14 * DAY).toISOString())
  })

  it('uses empirical p10 rank from eligible episodes without a fit or prospective gate', () => {
    const cash = Array.from({ length: 78 }, (_, index) =>
      index % 7 === 0 ? 100 : 100 - Math.floor(index / 7),
    )
    const result = available(input(cash))
    expect(result.counts.eligibleEpisodes).toBe(11)
    expect(result.examples.worstTrough.rank).toBe(1)
    expect(result.examples.p10Trough.rank).toBe(2)
  })

  it('rejects internal missing intervals without stitching or shifting the frozen partition', () => {
    const value = input(Array(15).fill(100))
    value.timeline = value.timeline.map((point, index) => ({
      ...point,
      at: new Date(origin + (index + (index >= 3 ? 1 : 0)) * DAY).toISOString(),
    }))
    const result = available(value)
    expect(result.counts).toMatchObject({
      candidateEpisodes: 2,
      eligibleEpisodes: 1,
      gapRejectedEpisodes: 1,
      gaps: 1,
    })
    expect(result.examples.worstTrough.episodeIndex).toBe(1)
    const onlyGap = { ...value, timeline: value.timeline.slice(0, 8) }
    reason(onlyGap, 'insufficient_eligible_history')
  })

  it('marks a gap at an eligible episode boundary without spanning it', () => {
    const value = input(Array(15).fill(100))
    value.current.cashRaw = '10'
    value.timeline = value.timeline.map((point, index) => ({
      ...point,
      at: new Date(origin + (index + (index >= 7 ? 1 : 0)) * DAY).toISOString(),
    }))
    const result = available(value)
    expect(result.counts.gapRejectedEpisodes).toBe(1)
    expect(result.examples.worstTrough).toMatchObject({
      episodeIndex: 1,
      sampledBelowQ: {
        leftCensored: true,
        rightCensored: true,
        gapCensored: true,
        onsetBracket: null,
      },
    })
    expect(result.examples.worstTrough.elapsedSeconds).toBe(604800)
  })

  it('uses actual elapsed timestamps within the existing daily tolerance', () => {
    const value = input()
    value.timeline = value.timeline.map((point, index) => ({
      ...point,
      at: new Date(origin + index * DAY + index * 60_000).toISOString(),
    }))
    const example = available(value).examples.worstTrough
    expect(example.elapsedSeconds).toBe(604800 + 420)
    expect(example.sampledBelowQ.sampledBelowQSpanSeconds).toBe(86460)
    value.timeline = value.timeline.map((point, index) => ({
      ...point,
      at: new Date(origin + index * DAY + (index === 1 ? -91 * 60_000 : 0)).toISOString(),
    }))
    reason(value, 'malformed_timeline')
  })

  it('expires after two hours and permits only the bounded current source skew', () => {
    const value = input()
    value.asOfMs += 2 * 60 * 60_000
    available(value)
    value.asOfMs++
    reason(value, 'current_cash_stale_or_future')
    const future = input()
    future.current.blockAt = new Date(future.asOfMs + 120_000).toISOString()
    available(future)
    future.current.blockAt = new Date(future.asOfMs + 120_001).toISOString()
    reason(future, 'current_cash_stale_or_future')
  })

  it('rejects wrong identity or native units at both history and current boundaries', () => {
    for (const change of [
      (value: HistoricalSampledCashPathsInput) => {
        value.timelineIdentity.assetDecimals = 18
      },
      (value: HistoricalSampledCashPathsInput) => {
        value.current.asset = 'DAI'
      },
      (value: HistoricalSampledCashPathsInput) => {
        value.current.subjectKey = 'elsewhere'
      },
      (value: HistoricalSampledCashPathsInput) => {
        value.identity.assetDecimals = 18
      },
      (value: HistoricalSampledCashPathsInput) => {
        value.timeline = value.timeline.map((point) => ({ ...point, subjectKey: 'elsewhere' }))
      },
    ]) {
      const value = input()
      change(value)
      reason(value, 'subject_mismatch')
    }
    const value = input()
    value.identity.assetDecimals = -1
    reason(value, 'invalid_identity')
  })

  it('rejects invalid raw values, block identity, canonical time, ordering and future observations', () => {
    const zero = input()
    zero.requestedRaw = '0'
    reason(zero, 'invalid_requested_raw')
    const negative = input()
    negative.current.cashRaw = '-1'
    reason(negative, 'invalid_current_source')
    const block = input()
    block.current.block = '1.5'
    reason(block, 'invalid_current_source')
    const hash = input()
    hash.current.blockHash = '0x123'
    reason(hash, 'invalid_current_source')
    const stamp = input()
    stamp.current.blockAt = stamp.current.blockAt.replace('.000Z', 'Z')
    reason(stamp, 'invalid_current_source')
    const timelineRaw = input()
    timelineRaw.timeline = timelineRaw.timeline.map((point) => ({ ...point, cashRaw: '01' }))
    reason(timelineRaw, 'malformed_timeline')
    const order = input()
    order.timeline = [...order.timeline].reverse()
    reason(order, 'malformed_timeline')
    const duplicate = input()
    duplicate.timeline = [...duplicate.timeline.slice(0, 1), ...duplicate.timeline]
    reason(duplicate, 'malformed_timeline')
    const future = input()
    future.timeline = future.timeline.map((point, index) =>
      index === 7 ? { ...point, at: new Date(future.asOfMs + 1).toISOString() } : point,
    )
    reason(future, 'future_history')
    const short = input()
    short.timeline = short.timeline.slice(0, 7)
    reason(short, 'insufficient_eligible_history')
  })
})
