import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { readTwynePtReserveModelEvidence } from '@/pages/api/carry/forecast'

const payloadBytes = JSON.stringify({
  kind: 'historical_aave_pt_reserve_persistence_band_v1',
  metric: 'aave_pt_reserve_cash_raw',
  routeKey: 'USDe → AaveV3ATokenWrapper [PT-srUSDe-22OCT2026]',
  wrapper: '0x0af56afbddcb140323445bd7211ba90e54e5fd1c',
  pt: '0x59bc9fae5d62b19d4f8d07d758047acb9ee19d34',
  aToken: '0x01e69a58ca3ddc695820ce6f66fbdf3fa55d0545',
  pool: '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2',
  horizonHours: 1,
  assetDecimals: 18,
  historicalBacktestOnly: true,
  prospectiveValidated: false,
  holderExecutableExit: false,
  baselineBand: { holdoutCovered: 55, coveragePassed: true },
})

const row = {
  issued_at: '2026-09-29T06:25:00.000Z',
  target_at: '2026-09-29T07:25:00.000Z',
  forecast_point_raw: '3705572683680060276100650',
  forecast_low_raw: '3429616743592556427674010',
  forecast_high_raw: '3705572683680060276100650',
  artifact_sha256: createHash('sha256').update(payloadBytes).digest('hex'),
  payload_bytes: payloadBytes,
  asset_decimals: 18,
  fit_pairs: 56,
  calibration_pairs: 56,
  holdout_pairs: 56,
  issued: '1',
  observed: '0',
  censored_missing: '0',
  pending: '1',
}

describe('Twyne Aave PT reserve model evidence', () => {
  it('returns the separately named market cash range with frozen counts', async () => {
    const evidence = await readTwynePtReserveModelEvidence(async () => ({ rows: [row] }))
    expect(evidence).toMatchObject({
      status: 'historical_projection',
      metric: 'aave_pt_reserve_cash_raw',
      claim: 'shared_aave_pt_reserve_cash_only',
      prospectiveValidated: false,
      holderExecutableExit: false,
      projection: {
        pointRaw: row.forecast_point_raw,
        bandLowRaw: row.forecast_low_raw,
        bandHighRaw: row.forecast_high_raw,
        assetDecimals: 18,
      },
      backtest: { fit: 56, calibration: 56, holdout: 56, covered: 55 },
      prospective: { issued: 1, observed: 0, censoredMissing: 0, pending: 1 },
    })
  })

  it('rejects tampered artifact, wrong decimals and broken prospective accounting', async () => {
    expect(
      await readTwynePtReserveModelEvidence(async () => ({
        rows: [{ ...row, artifact_sha256: 'f'.repeat(64) }],
      })),
    ).toEqual({ status: 'unavailable', reason: 'ledger_unavailable' })
    expect(
      await readTwynePtReserveModelEvidence(async () => ({
        rows: [{ ...row, asset_decimals: 6 }],
      })),
    ).toEqual({ status: 'unavailable', reason: 'ledger_unavailable' })
    expect(
      await readTwynePtReserveModelEvidence(async () => ({
        rows: [{ ...row, pending: '2' }],
      })),
    ).toEqual({ status: 'unavailable', reason: 'ledger_unavailable' })
    expect(await readTwynePtReserveModelEvidence(async () => ({ rows: [] }))).toEqual({
      status: 'unavailable',
      reason: 'no_current_issue',
    })
  })

  it('withholds a persistence projection that fails untouched holdout coverage', async () => {
    const failedPayload = JSON.stringify({
      ...JSON.parse(payloadBytes),
      baselineBand: { holdoutCovered: 40, coveragePassed: false },
    })
    expect(
      await readTwynePtReserveModelEvidence(async () => ({
        rows: [
          {
            ...row,
            payload_bytes: failedPayload,
            artifact_sha256: createHash('sha256').update(failedPayload).digest('hex'),
          },
        ],
      })),
    ).toEqual({
      status: 'unavailable',
      reason: 'untouched_interval_coverage_failed',
    })
  })
})
