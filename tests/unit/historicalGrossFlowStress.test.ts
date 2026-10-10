import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'

import {
  isFreshHistoricalCashBlock,
  projectHistoricalGrossFlowStress,
  type HistoricalGrossFlowSummary,
} from '@/lib/carry/historicalGrossFlowStress'

const distribution = {
  lower: '-900',
  median: '0',
  upper: '200',
  minimum: '-900',
  maximum: '200',
}

const pairedWindows = [
  {
    originBlock: 100,
    targetBlock: 102,
    sourceCashRaw: '1000',
    targetCashRaw: '900',
    grossReserveInRaw: '100',
    grossReserveOutRaw: '200',
    endpointCashDeltaRaw: '-100',
    troughCashRaw: '100',
    troughCashDeltaRaw: '-900',
    troughBlock: 102,
  },
  {
    originBlock: 102,
    targetBlock: 104,
    sourceCashRaw: '900',
    targetCashRaw: '1000',
    grossReserveInRaw: '200',
    grossReserveOutRaw: '100',
    endpointCashDeltaRaw: '100',
    troughCashRaw: '800',
    troughCashDeltaRaw: '-100',
    troughBlock: 103,
  },
]

const summary: HistoricalGrossFlowSummary = {
  schema: 'carry_historical_paired_flow_summary_v1',
  pairedWindows,
  pairedWindowsSha256: createHash('sha256').update(JSON.stringify(pairedWindows)).digest('hex'),
  study: 'test-historical-summary',
  identity: {
    chainId: 1,
    marketKey: 'aaveV3Usdc',
    routeKey: 'USDC → supply on Aave V3',
    destination: '0x' + '1'.repeat(40),
    asset: '0x' + '2'.repeat(40),
    decimals: 6,
  },
  source: { fromBlock: 100, toBlock: 104, joinContentSha256: 'a'.repeat(64) },
  horizonBlocks: 2,
  exactHorizonWindows: 3,
  nonoverlappingWindowCount: 2,
  nonoverlappingDistributions: {
    grossReserveInRaw: { lower: '0', median: '100', upper: '900', minimum: '0', maximum: '900' },
    grossReserveOutRaw: { lower: '0', median: '100', upper: '900', minimum: '0', maximum: '900' },
    endpointCashDeltaRaw: {
      lower: '-100',
      median: '0',
      upper: '100',
      minimum: '-100',
      maximum: '100',
    },
    troughCashDeltaRaw: distribution,
  },
  exactWindowExtrema: {
    maxGrossReserveInRaw: '1000',
    maxGrossReserveOutRaw: '1800',
    minEndpointCashDeltaRaw: '-1000',
    minTroughCashDeltaRaw: '-1800',
  },
}

describe('historical gross-flow stress projection', () => {
  it('expires a current-cash replay after thirty minutes in an open tab', () => {
    const now = Date.parse('2026-10-03T17:00:00.000Z')
    expect(isFreshHistoricalCashBlock('2026-10-03T16:30:00.000Z', now)).toBe(true)
    expect(isFreshHistoricalCashBlock('2026-10-03T16:29:59.999Z', now)).toBe(false)
    expect(isFreshHistoricalCashBlock('invalid', now)).toBe(false)
  })

  it('applies paired cash deltas to current cash and Q without exceeding physical cash bounds', () => {
    const result = projectHistoricalGrossFlowStress(summary, '100', '500')
    expect(result.currentCashMarginToRequestedRaw).toBe('-400')
    expect(result.grossReserveInRaw.upper).toBe('900')
    expect(result.exactWindowExtrema.maxGrossReserveInRaw).toBe('1000')
    expect(result.grossReserveOutRaw.upper).toBe('900')
    expect(result.exactWindowExtrema.maxGrossReserveOutRaw).toBe('1800')
    expect(result.troughMarginToRequestedRaw).toMatchObject({
      lower: '-500',
      median: '-400',
      upper: '-200',
    })
    expect(result.exactWindowExtrema).toMatchObject({
      minTroughMarginToRequestedRaw: '-500',
      maxTroughReplayDeficitRaw: '1700',
    })
    expect(result.validation).toBe('not_validated')
    expect(result.holderExecutableExit).toBe(false)
    expect(result.withinHorizonDuration).toBeNull()
  })

  it('selects ranked paired windows and translates their net trough only once', () => {
    const result = projectHistoricalGrossFlowStress(summary, '100', '50')
    expect(result.historicalScenarios).toMatchObject({
      selection: 'retrospective_observed_rank_not_forecast_probability',
      sampleCount: 2,
      p10Trough: {
        rank: 1,
        originBlock: 100,
        grossReserveInRaw: '100',
        grossReserveOutRaw: '200',
        endpointCashDeltaRaw: '-100',
        troughCashDeltaRaw: '-900',
        endpointCashRaw: '0',
        endpointMarginAfterQRaw: '-50',
        troughCashRawReplayed: '0',
        troughMarginAfterQRaw: '-50',
        troughDeficitAfterQRaw: '50',
      },
      highestGrossOutflow: { originBlock: 100, rank: 1, grossReserveOutRaw: '200' },
    })
  })

  it('ranks raw observed trough drawdowns before low-cash replay floors collapse margins', () => {
    const lowCashSummary = {
      ...summary,
      pairedWindows: [
        { ...pairedWindows[0], troughCashRaw: '500', troughCashDeltaRaw: '-500' },
        { ...pairedWindows[1], troughCashRaw: '0', troughCashDeltaRaw: '-900' },
      ],
    }
    const result = projectHistoricalGrossFlowStress(lowCashSummary, '100', '1000')
    expect(result.historicalScenarios.worstTrough.originBlock).toBe(102)
    expect(result.historicalScenarios.worstTrough.troughCashDeltaRaw).toBe('-900')
    expect(result.historicalScenarios.worstTrough.troughMarginAfterQRaw).toBe('-1000')
  })

  it('rejects paired rows whose gross flows do not reconcile to endpoint cash', () => {
    const invalid = {
      ...summary,
      pairedWindows: [{ ...pairedWindows[0], grossReserveOutRaw: '201' }, pairedWindows[1]],
    }
    expect(() => projectHistoricalGrossFlowStress(invalid, '100', '50')).toThrow(
      'historical_flow_invalid_paired_window',
    )
  })

  it('rejects zero Q and summaries without an exact historical window', () => {
    expect(() => projectHistoricalGrossFlowStress(summary, '100', '0')).toThrow()
    expect(() =>
      projectHistoricalGrossFlowStress({ ...summary, exactHorizonWindows: 0 }, '100', '1'),
    ).toThrow()
  })
})
