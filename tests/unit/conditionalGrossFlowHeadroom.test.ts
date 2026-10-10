import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import summary from '@/data/research/venue-signals/aave-usdc-flow-stress-duration-v1.json'
import { buildHistoricalCompetingFlowEstimate } from '@/lib/carry/historicalCompetingFlowEstimate'
import {
  buildConditionalGrossFlowHeadroom,
  selectedConditionalGrossFlowHeadroom,
  type ConditionalGrossFlowProjection,
  type ConditionalGrossFlowProjectionInput,
} from '@/lib/carry/conditionalGrossFlowHeadroom'
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
function fixture(): ConditionalGrossFlowProjectionInput {
  return {
    currentSource: {
      chainId: 1,
      routeKey: 'USDC → supply on Aave V3',
      destination: '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c',
      asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      assetDecimals: 6,
      cashRaw: '10000000000000',
      blockNumber: 26139032,
      blockHash: `0x${'a'.repeat(64)}`,
      blockTime: '2026-10-07T07:30:00.000Z',
      readAt: '2026-10-07T07:31:00.000Z',
      finalized: true,
    },
    request: { requestedRaw: '1000000000000', asOf: '2026-10-07T07:32:00.000Z' },
    historicalFlow: buildHistoricalCompetingFlowEstimate(summary, hash),
  }
}
function project(input = fixture()): ConditionalGrossFlowProjection {
  const result = buildConditionalGrossFlowHeadroom(input, hash)
  expect(result.status).toBe('estimated')
  if (result.status !== 'estimated') throw Error(result.reason)
  return result
}
const floor = (n: bigint, d: bigint) => n / d - (n < 0n && n % d ? 1n : 0n)

describe('future conditional joint gross-flow capacity', () => {
  it('uses all78 verified windows, source-relative future brackets and clearly conditional claims without mutation', () => {
    const input = fixture(),
      before = structuredClone(input)
    const value = project(input)
    expect(value).toMatchObject({
      status: 'estimated',
      claim: 'conditional_capacity_projection',
      assumption: 'repeat_historical_joint_flows_and_unchanged_mechanical_conditions',
      forecastValidated: false,
      prospectiveValidated: false,
      holderExecutableExit: false,
      target: {
        kind: 'next_observed_historical_window',
        horizonBlocks: 256,
        durationSeconds: { lowerSeconds: 2532, upperSeconds: 3588 },
        earliestAt: '2026-10-07T08:12:12.000Z',
        latestAt: '2026-10-07T08:29:48.000Z',
      },
      historicalScenarioFraction: {
        claim: 'historical_scenario_fraction_not_calibrated_probability',
        sampleCount: 78,
      },
    })
    expect(value.scenarios).toHaveLength(78)
    expect(value.evidence.compactWindowsSha256).toBe(
      hash(JSON.stringify(value.historicalFlow.windows)),
    )
    expect(Date.parse(value.target.earliestAt)).toBeGreaterThan(Date.parse(value.request.asOf))
    expect(input).toEqual(before)
    expect(selectedConditionalGrossFlowHeadroom(value, input, hash)).toEqual(value)
  })
  it('rejects the genuine earlier pinned source header when verified training lies in its future', () => {
    const input = fixture(),
      before = structuredClone(input.historicalFlow)
    const header = summary.pairedWindows[0].durationPath.timeHeaders[0]
    expect(header.blockNumber).toBe(26079849)
    input.currentSource!.blockNumber = header.blockNumber
    input.currentSource!.blockHash = header.blockHash
    input.currentSource!.blockTime = new Date(header.timestampSec * 1000).toISOString()
    input.currentSource!.readAt = new Date(header.timestampSec * 1000 + 13 * 60000).toISOString()
    input.request.asOf = new Date(header.timestampSec * 1000 + 14 * 60000).toISOString()
    expect(buildConditionalGrossFlowHeadroom(input, hash)).toEqual({
      status: 'unavailable',
      reason: 'historical_training_after_source',
    })
    const forged = project()
    forged.currentSource = { ...input.currentSource! }
    forged.request = { ...input.request }
    forged.target.earliestAt = new Date(header.timestampSec * 1000 + 2532000).toISOString()
    forged.target.latestAt = new Date(header.timestampSec * 1000 + 3588000).toISOString()
    expect(selectedConditionalGrossFlowHeadroom(forged, input, hash)).toBeNull()
    expect(input.historicalFlow).toEqual(before)
  })
  it('admits training target equality and rejects even one block of future training', () => {
    const input = fixture()
    const estimate = input.historicalFlow as ConditionalGrossFlowProjection['historicalFlow']
    const lastTarget = Math.max(...estimate.windows.map((window) => window.targetBlock))
    expect(lastTarget).toBe(26100281)
    input.currentSource!.blockNumber = lastTarget
    const value = project(input)
    expect(selectedConditionalGrossFlowHeadroom(value, input, hash)).toEqual(value)
    input.currentSource!.blockNumber = lastTarget - 1
    expect(buildConditionalGrossFlowHeadroom(input, hash)).toEqual({
      status: 'unavailable',
      reason: 'historical_training_after_source',
    })
    expect(selectedConditionalGrossFlowHeadroom(value, input, hash)).toBeNull()
  })
  it('averages per-window physically floored capacity instead of flooring average net flow', () => {
    const input = fixture()
    input.currentSource!.cashRaw = '0'
    const value = project(input)
    const deltas = value.historicalFlow.windows.map(
      (w) => BigInt(w.grossReserveInRaw) - BigInt(w.grossReserveOutRaw),
    )
    const sumFloored = deltas.reduce((sum, delta) => sum + (delta > 0n ? delta : 0n), 0n)
    const averageDelta = floor(
      deltas.reduce((sum, delta) => sum + delta, 0n),
      78n,
    )
    const floorOfMean = averageDelta > 0n ? averageDelta : 0n
    expect(value.capacity.mean).toEqual({
      numeratorRaw: sumFloored.toString(),
      denominator: 78,
      floorRaw: (sumFloored / 78n).toString(),
    })
    expect(BigInt(value.capacity.mean.floorRaw)).toBeGreaterThan(floorOfMean)
    expect(value.scenarios.some((s) => s.capacityRaw === '0')).toBe(true)
    expect(value.capacity.minimumRaw).toBe('0')
    const q = BigInt(input.request.requestedRaw)
    expect(value.userHeadroom.mean.numeratorRaw).toBe((sumFloored - 78n * q).toString())
    expect(value.userHeadroom.mean.floorRaw).toBe(floor(sumFloored - 78n * q, 78n).toString())
  })
  it('preserves inflow/outflow covariance and derives paired empirical quantiles rather than combining marginals', () => {
    const value = project()
    const capacities = value.historicalFlow.windows
      .map((w) => {
        const raw =
          BigInt(value.currentSource.cashRaw) +
          BigInt(w.grossReserveInRaw) -
          BigInt(w.grossReserveOutRaw)
        return raw < 0n ? 0n : raw
      })
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    expect(value.capacity.p10Raw).toBe(capacities[7].toString())
    expect(value.capacity.p90Raw).toBe(capacities[69].toString())
    const marginal =
      BigInt(value.currentSource.cashRaw) +
      BigInt(value.historicalFlow.grossReplenishment.p10Raw) -
      BigInt(value.historicalFlow.grossDepletion.p90Raw)
    expect(value.capacity.p10Raw).not.toBe((marginal < 0n ? 0n : marginal).toString())
    expect(value.capacity.minimumRaw).toBe(capacities[0].toString())
    expect(value.capacity.maximumRaw).toBe(capacities[77].toString())
  })
  it('subtracts Q exactly once, retains deficits and recomputes coverage for a new Q', () => {
    const input = fixture(),
      value = project(input)
    const q = BigInt(input.request.requestedRaw)
    for (const s of value.scenarios)
      expect(BigInt(s.userHeadroomRaw)).toBe(BigInt(s.capacityRaw) - q)
    expect(BigInt(value.userHeadroom.minimumRaw)).toBeLessThan(0n)
    expect(value.historicalScenarioFraction.coveringQ).toBe(
      value.scenarios.filter((s) => BigInt(s.capacityRaw) >= q).length,
    )
    const changed = structuredClone(input)
    changed.request.requestedRaw = (q * 2n).toString()
    const next = project(changed)
    expect(next.capacity).toEqual(value.capacity)
    expect(next.userHeadroom.mean.numeratorRaw).toBe(
      (BigInt(value.userHeadroom.mean.numeratorRaw) - 78n * q).toString(),
    )
    expect(next.historicalScenarioFraction.coveringQ).toBeLessThanOrEqual(
      value.historicalScenarioFraction.coveringQ,
    )
    expect(selectedConditionalGrossFlowHeadroom(value, changed, hash)).toBeNull()
  })
  it('keeps exact rational means and mathematical floor for negative fractional headroom', () => {
    const input = fixture()
    input.currentSource!.cashRaw = '0'
    input.request.requestedRaw = ((1n << 255n) - 1n).toString()
    const value = project(input),
      numerator = BigInt(value.userHeadroom.mean.numeratorRaw)
    expect(numerator).toBeLessThan(0n)
    expect(numerator % 78n).not.toBe(0n)
    expect(value.userHeadroom.mean.floorRaw).toBe((numerator / 78n - 1n).toString())
    expect(BigInt(value.capacity.mean.floorRaw)).toBeGreaterThanOrEqual(
      BigInt(value.capacity.p10Raw),
    )
    expect(BigInt(value.capacity.mean.floorRaw)).toBeLessThanOrEqual(
      BigInt(value.capacity.maximumRaw),
    )
  })
  it.each([
    ['missing', 'missing_fresh_source'],
    ['stale', 'source_stale'],
    ['future_block', 'time_invalid'],
    ['read_before_block', 'time_invalid'],
    ['read_after_asof', 'time_invalid'],
    ['past_target', 'future_window_unavailable'],
    ['noncanonical_utc', 'time_invalid'],
  ])('rejects %s current timing with safe reason %s', (change, reason) => {
    const input = fixture()
    if (change === 'missing') input.currentSource = null
    if (change === 'stale') input.request.asOf = '2026-10-07T08:00:00.001Z'
    if (change === 'future_block') input.currentSource!.blockTime = '2026-10-07T07:33:00.000Z'
    if (change === 'read_before_block') input.currentSource!.readAt = '2026-10-07T07:29:00.000Z'
    if (change === 'read_after_asof') input.currentSource!.readAt = '2026-10-07T07:33:00.000Z'
    if (change === 'past_target') input.request.asOf = '2026-10-07T08:12:12.000Z'
    if (change === 'noncanonical_utc') input.request.asOf = '2026-10-07T07:32:00Z'
    expect(buildConditionalGrossFlowHeadroom(input, hash)).toEqual({
      status: 'unavailable',
      reason,
    })
  })
  it('rejects a future interval that cannot retain the canonical UTC clock format', () => {
    const input = fixture()
    input.currentSource!.blockTime = '9999-12-31T23:50:00.000Z'
    input.currentSource!.readAt = '9999-12-31T23:51:00.000Z'
    input.request.asOf = '9999-12-31T23:52:00.000Z'
    expect(buildConditionalGrossFlowHeadroom(input, hash)).toEqual({
      status: 'unavailable',
      reason: 'time_invalid',
    })
  })
  it('accepts freshness exactly30min and case-normalized identity while retaining source-clock targets', () => {
    const input = fixture()
    input.request.asOf = '2026-10-07T08:00:00.000Z'
    input.currentSource!.destination = `0x${input.currentSource!.destination.slice(2).toUpperCase()}`
    input.currentSource!.asset = `0x${input.currentSource!.asset.slice(2).toUpperCase()}`
    const value = project(input)
    expect(value.target.earliestAt).toBe('2026-10-07T08:12:12.000Z')
    expect(value.target.latestAt).toBe('2026-10-07T08:29:48.000Z')
    expect(Date.parse(value.target.earliestAt) - Date.parse(value.request.asOf)).toBe(732000)
    expect(selectedConditionalGrossFlowHeadroom(value, input, hash)).toEqual(value)
    input.request.asOf = '2026-10-07T08:00:00.001Z'
    expect(selectedConditionalGrossFlowHeadroom(value, input, hash)).toBeNull()
  })
  it('accepts a finalized source older than15min without retiming or rescaling its future window', () => {
    const input = fixture()
    const initial = project(input)
    input.request.asOf = '2026-10-07T07:50:00.000Z'
    input.currentSource!.readAt = '2026-10-07T07:49:00.000Z'
    const value = project(input)
    expect(value.target).toEqual(initial.target)
    expect(value.capacity).toEqual(initial.capacity)
    expect(value.userHeadroom).toEqual(initial.userHeadroom)
    expect(value.currentSource.finalized).toBe(true)
    expect(selectedConditionalGrossFlowHeadroom(value, input, hash)).toEqual(value)
  })
  it.each(['route', 'destination', 'asset', 'decimals', 'chain'])(
    'rejects foreign %s identity',
    (change) => {
      const input = fixture()
      if (change === 'route') input.currentSource!.routeKey = 'USDT → supply on Spark'
      if (change === 'destination') input.currentSource!.destination = `0x${'b'.repeat(40)}`
      if (change === 'asset')
        input.currentSource!.asset = '0xdac17f958d2ee523a2206206994597c13d831ec7'
      if (change === 'decimals') input.currentSource!.assetDecimals = 18
      if (change === 'chain') Object.assign(input.currentSource!, { chainId: '1' })
      expect(buildConditionalGrossFlowHeadroom(input, hash)).toEqual({
        status: 'unavailable',
        reason: 'identity_mismatch',
      })
    },
  )
  it.each([
    'zero_q',
    'array_q',
    'leading_zero_q',
    'max_q',
    'array_cash',
    'negative_cash',
    'array_hash',
    'string_block',
    'array_asof',
    'unfinalized',
  ])('rejects malformed primitive %s', (change) => {
    const input = fixture()
    if (change === 'zero_q') input.request.requestedRaw = '0'
    if (change === 'array_q') Object.assign(input.request, { requestedRaw: ['1000'] })
    if (change === 'leading_zero_q') input.request.requestedRaw = '01000'
    if (change === 'max_q') input.request.requestedRaw = (1n << 256n).toString()
    if (change === 'array_cash') Object.assign(input.currentSource!, { cashRaw: ['1'] })
    if (change === 'negative_cash') input.currentSource!.cashRaw = '-1'
    if (change === 'array_hash')
      Object.assign(input.currentSource!, { blockHash: [input.currentSource!.blockHash] })
    if (change === 'string_block') Object.assign(input.currentSource!, { blockNumber: '26139032' })
    if (change === 'array_asof') Object.assign(input.request, { asOf: [input.request.asOf] })
    if (change === 'unfinalized') Object.assign(input.currentSource!, { finalized: 'true' })
    expect(buildConditionalGrossFlowHeadroom(input, hash).status).toBe('unavailable')
  })
  it('rejects unverified flow hashes and mutations of paired evidence or duration', () => {
    const input = fixture()
    expect(buildConditionalGrossFlowHeadroom(input, () => 'f'.repeat(64))).toEqual({
      status: 'unavailable',
      reason: 'verified_flow_unavailable',
    })
    for (const change of ['cash', 'duration', 'count']) {
      const altered = structuredClone(input)
      const flow = altered.historicalFlow as ConditionalGrossFlowProjection['historicalFlow']
      if (change === 'cash') flow.windows[0].grossReserveOutRaw = '0'
      if (change === 'duration') flow.timeCoverage.durationSeconds!.lowerSeconds = 0
      if (change === 'count') flow.windows.pop()
      expect(buildConditionalGrossFlowHeadroom(altered, hash)).toEqual({
        status: 'unavailable',
        reason: 'verified_flow_unavailable',
      })
    }
  })
  it.each([
    'mean',
    'quantile',
    'scenario',
    'fraction',
    'target',
    'source',
    'request',
    'flow',
    'claim',
    'extra',
    'forged_array',
    'forged_number',
  ])('browser selector rederives all facts and rejects forged %s', (change) => {
    const input = fixture(),
      value = project(input)
    if (change === 'mean') value.capacity.mean.numeratorRaw = '1'
    if (change === 'quantile') value.userHeadroom.p10Raw = '1'
    if (change === 'scenario') value.scenarios[0].capacityRaw = '1'
    if (change === 'fraction') value.historicalScenarioFraction.coveringQ = 78
    if (change === 'target') value.target.earliestAt = input.request.asOf
    if (change === 'source') value.currentSource.blockHash = `0x${'b'.repeat(64)}`
    if (change === 'request') value.request.requestedRaw = '1'
    if (change === 'flow') value.historicalFlow.grossReplenishment.mean.numeratorRaw = '1'
    if (change === 'claim') Object.assign(value, { forecastValidated: true })
    if (change === 'extra') Object.assign(value, { horizonHours: 24 })
    if (change === 'forged_array')
      Object.assign(value, { evidence: Object.entries(value.evidence) })
    if (change === 'forged_number')
      Object.assign(value.capacity.mean, { numeratorRaw: Number(value.capacity.mean.numeratorRaw) })
    expect(selectedConditionalGrossFlowHeadroom(value, input, hash)).toBeNull()
  })
})
