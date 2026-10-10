import { describe, expect, it } from 'vitest'

import { deriveRouteProxyExitProjection } from '@/lib/carry/routeProxyExitProjection'

const base = {
  routeKey: 'USDC → supply on Aave V3',
  destination: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  requestedRaw: '1250000000000',
  currentCashRaw: '5000000000000',
  pointRaw: '4600000000000',
  bandLowRaw: '3000000000000',
  bandHighRaw: '6100000000000',
  horizonHours: 24,
  currentAt: '2026-10-05T02:00:00.000Z',
  targetAt: '2026-10-06T02:00:00.000Z',
  asOfAt: '2026-10-05T02:10:00.000Z',
  method: 'learned_delta' as const,
  samples: 60,
  validation: {
    fit: 20,
    calibration: 20,
    holdout: 20,
    covered: 18,
    coveragePassed: true,
    pointBeatsPersistence: true,
  },
}

describe('deriveRouteProxyExitProjection', () => {
  it('converts a qualified cash band into exact-Q margins and an opportunity window', () => {
    const result = deriveRouteProxyExitProjection(base)

    expect(result).toMatchObject({
      status: 'research_projection',
      claimClass: 'route_proxy',
      holderExecutableExit: false,
      forecastValidated: false,
      probabilityQExecutable: null,
      currentState: 'cash_covers_q',
      projectedState: 'band_covers_q',
      direction: 'shrinking',
      projectedChangeRaw: '-400000000000',
      expectedNetFlowRaw: {
        low: '-2000000000000',
        point: '-400000000000',
        high: '1100000000000',
      },
      marginAfterQRaw: {
        low: '1750000000000',
        point: '3350000000000',
        high: '4850000000000',
      },
      horizonAssessment: 'band_above_q_at_horizon',
      alert: null,
    })
  })

  it('flags a projected shrink only when the historical band reaches below Q', () => {
    const crosses = deriveRouteProxyExitProjection({
      ...base,
      requestedRaw: '2500000000000',
      pointRaw: '2600000000000',
      bandLowRaw: '2000000000000',
      bandHighRaw: '3000000000000',
    })
    expect(crosses).toMatchObject({
      projectedState: 'band_crosses_q',
      horizonAssessment: 'q_inside_band_at_horizon',
      alert: { kind: 'projected_shrink', impact: 'estimated' },
    })

    const below = deriveRouteProxyExitProjection({
      ...base,
      requestedRaw: '2500000000000',
      pointRaw: '1800000000000',
      bandLowRaw: '1000000000000',
      bandHighRaw: '2000000000000',
    })
    expect(below).toMatchObject({
      projectedState: 'band_below_q',
      horizonAssessment: 'band_below_q_at_horizon',
      alert: { kind: 'projected_shrink', impact: 'estimated' },
    })
  })

  it('withholds the whole learned projection when untouched coverage or point skill fails', () => {
    for (const validation of [
      {
        ...base.validation,
        covered: 0,
        coveragePassed: false,
        pointBeatsPersistence: true,
      },
      { ...base.validation, pointBeatsPersistence: false },
    ]) {
      const result = deriveRouteProxyExitProjection({
        ...base,
        requestedRaw: '2500000000000',
        pointRaw: '1800000000000',
        bandLowRaw: '1000000000000',
        bandHighRaw: '2000000000000',
        validation,
      })
      expect(result).toEqual({
        status: 'unavailable',
        reason: 'invalid_projection',
      })
    }
  })

  it('separates impaired-at-horizon from possible recovery at the horizon', () => {
    const impaired = deriveRouteProxyExitProjection({
      ...base,
      currentCashRaw: '1000000000000',
      pointRaw: '1200000000000',
      bandLowRaw: '900000000000',
      bandHighRaw: '1500000000000',
    })
    expect(impaired).toMatchObject({
      currentState: 'cash_below_q',
      projectedState: 'band_crosses_q',
      horizonAssessment: 'q_inside_band_at_horizon',
      alert: null,
    })

    const recoveredBand = deriveRouteProxyExitProjection({
      ...base,
      currentCashRaw: '1000000000000',
      pointRaw: '1800000000000',
      bandLowRaw: '1500000000000',
      bandHighRaw: '2100000000000',
    })
    expect(recoveredBand).toMatchObject({
      projectedState: 'band_covers_q',
      horizonAssessment: 'band_above_q_at_horizon',
    })

    const staysImpaired = deriveRouteProxyExitProjection({
      ...base,
      currentCashRaw: '1000000000000',
      pointRaw: '800000000000',
      bandLowRaw: '500000000000',
      bandHighRaw: '1100000000000',
    })
    expect(staysImpaired).toMatchObject({
      projectedState: 'band_below_q',
      horizonAssessment: 'band_below_q_at_horizon',
    })
  })

  it('does not call downside uncertainty projected shrink when the point is growing', () => {
    const result = deriveRouteProxyExitProjection({
      ...base,
      requestedRaw: '2500000000000',
      pointRaw: '6000000000000',
      bandLowRaw: '2000000000000',
      bandHighRaw: '7000000000000',
    })
    expect(result).toMatchObject({
      direction: 'growing',
      projectedState: 'band_crosses_q',
      horizonAssessment: 'q_inside_band_at_horizon',
      alert: null,
    })
  })

  it('derives persistence direction from a wholly shifted empirical band', () => {
    const result = deriveRouteProxyExitProjection({
      ...base,
      method: 'persistence_band',
      requestedRaw: '2500000000000',
      pointRaw: base.currentCashRaw,
      bandLowRaw: '2000000000000',
      bandHighRaw: '3000000000000',
      validation: { ...base.validation, pointBeatsPersistence: null },
    })
    expect(result).toMatchObject({
      direction: 'shrinking',
      projectedChangeRaw: '-2000000000000',
      projectedState: 'band_crosses_q',
      alert: { kind: 'projected_shrink', impact: 'estimated' },
    })
  })

  it('withholds the whole persistence projection when untouched coverage fails', () => {
    const validation = {
      ...base.validation,
      covered: 0,
      coveragePassed: false,
      pointBeatsPersistence: null,
    }
    const result = deriveRouteProxyExitProjection({
      ...base,
      method: 'persistence_band',
      requestedRaw: '2500000000000',
      pointRaw: base.currentCashRaw,
      bandLowRaw: '2000000000000',
      bandHighRaw: '3000000000000',
      validation,
    })
    expect(result).toEqual({
      status: 'unavailable',
      reason: 'invalid_projection',
    })
  })

  it('does not publish historical net-change quantiles as a forward projection', () => {
    const result = deriveRouteProxyExitProjection({
      ...base,
      method: 'historical_net_change',
      requestedRaw: '2500000000000',
      pointRaw: '2600000000000',
      bandLowRaw: '2000000000000',
      bandHighRaw: '3000000000000',
      validation: null,
    })
    expect(result).toEqual({
      status: 'unavailable',
      reason: 'invalid_projection',
    })
  })

  it('keeps uint256-scale arithmetic exact and treats equality as covering Q', () => {
    const huge = deriveRouteProxyExitProjection({
      ...base,
      requestedRaw: '900719925474099312345678',
      currentCashRaw: '900719925474099312345678',
      pointRaw: '900719925474099312345679',
      bandLowRaw: '900719925474099312345678',
      bandHighRaw: '900719925474099312345680',
    })
    expect(huge).toMatchObject({
      currentState: 'cash_covers_q',
      projectedState: 'band_covers_q',
      projectedChangeRaw: '1',
      marginAfterQRaw: { low: '0', point: '1', high: '2' },
    })
  })

  it('accepts a qualified empirical band that does not contain the point estimate', () => {
    const result = deriveRouteProxyExitProjection({
      ...base,
      requestedRaw: '1000',
      currentCashRaw: '1000',
      pointRaw: '1010',
      bandLowRaw: '1020',
      bandHighRaw: '1020',
    })
    expect(result).toMatchObject({
      status: 'research_projection',
      direction: 'growing',
      projectedState: 'band_covers_q',
      capacityRaw: { low: '1020', point: '1010', high: '1020' },
    })
  })

  it('fails closed for malformed bands, identities, counts, and zero Q', () => {
    for (const invalid of [
      { ...base, requestedRaw: '0' },
      { ...base, destination: '0x1234' },
      { ...base, bandLowRaw: '6200000000000' },
      { ...base, samples: 0 },
      { ...base, currentAt: '2026-10-05T01:59:59.000Z' },
      { ...base, asOfAt: '2026-10-05T02:31:00.000Z' },
      { ...base, targetAt: '2026-10-05T02:00:00.000Z' },
      { ...base, validation: { ...base.validation, covered: 21 } },
      { ...base, validation: { ...base.validation, coveragePassed: false } },
      { ...base, validation: { ...base.validation, fit: 0 } },
      { ...base, validation: { ...base.validation, calibration: 0 } },
      {
        ...base,
        validation: {
          ...base.validation,
          holdout: 0,
          covered: 0,
          coveragePassed: true,
        },
      },
      { ...base, validation: { ...base.validation, pointBeatsPersistence: null } },
      {
        ...base,
        method: 'persistence_band' as const,
        validation: { ...base.validation, pointBeatsPersistence: true },
      },
    ]) {
      expect(deriveRouteProxyExitProjection(invalid)).toEqual({
        status: 'unavailable',
        reason: 'invalid_projection',
      })
    }
  })
})
