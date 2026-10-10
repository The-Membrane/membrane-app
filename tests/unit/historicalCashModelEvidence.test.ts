import { createHash } from 'node:crypto'

import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it, vi } from 'vitest'

import { readHistoricalModelEvidence } from '@/pages/api/carry/forecast'

const question = {
  routeKey: 'USDC → supply on Aave V3',
  destination: '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c',
  asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  horizonHours: 1,
  assetDecimals: 6,
}

const payloadBytes = JSON.stringify({
  kind: 'historical_cash_delta_model_v1',
  routeKey: question.routeKey,
  destination: question.destination,
  asset: question.asset,
  assetDecimals: question.assetDecimals,
  horizonHours: 1,
  historicalBacktestOnly: true,
  prospectiveValidated: false,
  holderExecutableExit: false,
  holdout: {
    covered: 44,
    coveragePassed: true,
    pointBeatsPersistence: true,
    modelMae: { numeratorRaw: '400', denominator: 48 },
    persistenceMae: { numeratorRaw: '800', denominator: 48 },
  },
})

const row = {
  issued_at: '2026-09-29T06:55:00.000Z',
  target_at: '2026-09-29T07:40:00.000Z',
  forecast_point_raw: '190000000000000',
  forecast_low_raw: '180000000000000',
  forecast_high_raw: '200000000000000',
  artifact_sha256: createHash('sha256').update(payloadBytes).digest('hex'),
  model_version: 'hdelta3-1758081600-1759114800',
  artifact_registered_at: '2026-09-29T06:50:00.000Z',
  v4_activated_at: '2026-10-05T00:00:00.000Z',
  payload_bytes: payloadBytes,
  fit_pairs: 48,
  calibration_pairs: 48,
  selection_pairs: null,
  holdout_pairs: 48,
  issued: '1',
  observed: '0',
  censored_missing: '0',
  pending: '1',
}

describe('Carry historical model issue evidence', () => {
  it('shows a future immutable issue with exact raw values and separate prospective counts', async () => {
    let captured: SQL | undefined
    const evidence = await readHistoricalModelEvidence(question, async (query) => {
      captured = query
      return { rows: [row] }
    })
    expect(evidence).toMatchObject({
      status: 'historical_projection',
      modelKind: 'learned_delta',
      prospectiveValidated: false,
      holderExecutableExit: false,
      projection: {
        issuedAt: row.issued_at,
        targetAt: row.target_at,
        pointRaw: row.forecast_point_raw,
        bandLowRaw: row.forecast_low_raw,
        bandHighRaw: row.forecast_high_raw,
        assetDecimals: 6,
      },
      backtest: {
        fit: 48,
        calibration: 48,
        selection: null,
        selectionCovered: null,
        selectionCoveragePassed: null,
        holdout: 48,
        holdoutCovered: 44,
        holdoutCoveragePassed: true,
        holdoutPointBeatsPersistence: true,
        holdoutModelMae: { numeratorRaw: '400', denominator: 48 },
        holdoutPersistenceMae: { numeratorRaw: '800', denominator: 48 },
      },
      prospective: { issued: 1, observed: 0, censoredMissing: 0, pending: 1 },
    })
    const query = new PgDialect().sqlToQuery(captured!)
    expect(query.sql).toContain("m.status = 'issued' AND b.target_at > clock_timestamp()")
    expect(query.sql).toContain(
      'b.target_at = b.source_observed_at + make_interval(hours => b.horizon_hours)',
    )
    expect(query.sql).toContain("b.issued_at - b.source_observed_at <= interval '30 minutes'")
    expect(query.sql).toContain('a.registered_at < e.activated_at')
    expect(query.sql).toContain('m.issued_at < e.activated_at')
    expect(query.params).toEqual([question.routeKey, question.destination, 1, question.asset])
  })

  it('identifies a persistence band without a learned point forecast claim', async () => {
    const baselinePayload = JSON.stringify({
      ...JSON.parse(payloadBytes),
      kind: 'historical_cash_persistence_band_v1',
      baselineBand: { holdoutCovered: 40, coveragePassed: true },
    })
    const evidence = await readHistoricalModelEvidence(question, async () => ({
      rows: [
        {
          ...row,
          model_version: 'hband3-1758081600-1759114800',
          payload_bytes: baselinePayload,
          artifact_sha256: createHash('sha256').update(baselinePayload).digest('hex'),
        },
      ],
    }))
    expect(evidence).toMatchObject({
      status: 'historical_projection',
      modelKind: 'persistence_band',
      backtest: {
        selection: null,
        selectionCovered: null,
        selectionCoveragePassed: null,
        holdoutCovered: 40,
        holdoutCoveragePassed: true,
        holdoutPointBeatsPersistence: null,
        holdoutModelMae: null,
        holdoutPersistenceMae: null,
      },
    })
    expect(evidence).toHaveProperty('prospectiveValidated', false)
  })

  it('withholds a v4 learned projection that fails untouched holdout qualification', async () => {
    const v4Payload = JSON.stringify({
      ...JSON.parse(payloadBytes),
      counts: { total: 60, fit: 20, calibration: 20, selection: 10, holdout: 10 },
      selection: {
        covered: 9,
        total: 10,
        coveragePassed: true,
        pointBeatsPersistence: true,
        modelMae: { numeratorRaw: '20', denominator: 10 },
        persistenceMae: { numeratorRaw: '30', denominator: 10 },
      },
      holdout: {
        covered: 4,
        total: 10,
        coveragePassed: false,
        pointBeatsPersistence: false,
        modelMae: { numeratorRaw: '100', denominator: 10 },
        persistenceMae: { numeratorRaw: '50', denominator: 10 },
      },
      baselineBand: {
        selectionCovered: 8,
        selectionTotal: 10,
        selectionCoveragePassed: true,
        holdoutCovered: 3,
        holdoutTotal: 10,
        coveragePassed: false,
      },
    })
    const evidence = await readHistoricalModelEvidence(question, async () => ({
      rows: [
        {
          ...row,
          model_version: 'hdelta4-1758081600-1759114800',
          issued_at: '2026-10-05T00:05:00.000Z',
          target_at: '2026-10-05T01:05:00.000Z',
          artifact_registered_at: '2026-10-05T00:01:00.000Z',
          payload_bytes: v4Payload,
          artifact_sha256: createHash('sha256').update(v4Payload).digest('hex'),
          fit_pairs: 20,
          calibration_pairs: 20,
          selection_pairs: 10,
          holdout_pairs: 10,
        },
      ],
    }))
    expect(evidence).toEqual({
      status: 'unavailable',
      reason: 'untouched_interval_coverage_failed',
    })
  })

  it('withholds a covered v4 learned projection whose point loses to persistence', async () => {
    const v4Payload = JSON.stringify({
      ...JSON.parse(payloadBytes),
      counts: { total: 60, fit: 20, calibration: 20, selection: 10, holdout: 10 },
      selection: {
        covered: 9,
        total: 10,
        coveragePassed: true,
        pointBeatsPersistence: true,
        modelMae: { numeratorRaw: '20', denominator: 10 },
        persistenceMae: { numeratorRaw: '30', denominator: 10 },
      },
      holdout: {
        covered: 9,
        total: 10,
        coveragePassed: true,
        pointBeatsPersistence: false,
        modelMae: { numeratorRaw: '100', denominator: 10 },
        persistenceMae: { numeratorRaw: '50', denominator: 10 },
      },
      baselineBand: {
        selectionCovered: 8,
        selectionTotal: 10,
        selectionCoveragePassed: true,
        holdoutCovered: 9,
        holdoutTotal: 10,
        coveragePassed: true,
      },
    })
    const evidence = await readHistoricalModelEvidence(question, async () => ({
      rows: [
        {
          ...row,
          model_version: 'hdelta4-1758081600-1759114800',
          issued_at: '2026-10-05T00:05:00.000Z',
          target_at: '2026-10-05T01:05:00.000Z',
          artifact_registered_at: '2026-10-05T00:01:00.000Z',
          payload_bytes: v4Payload,
          artifact_sha256: createHash('sha256').update(v4Payload).digest('hex'),
          fit_pairs: 20,
          calibration_pairs: 20,
          selection_pairs: 10,
          holdout_pairs: 10,
        },
      ],
    }))
    expect(evidence).toEqual({
      status: 'unavailable',
      reason: 'untouched_point_skill_failed',
    })
  })

  it('withholds a v4 persistence projection that fails untouched holdout coverage', async () => {
    const v4Payload = JSON.stringify({
      ...JSON.parse(payloadBytes),
      kind: 'historical_cash_persistence_band_v1',
      counts: { total: 60, fit: 20, calibration: 20, selection: 10, holdout: 10 },
      selection: {
        covered: 10,
        total: 10,
        coveragePassed: true,
        pointBeatsPersistence: false,
        modelMae: { numeratorRaw: '40', denominator: 10 },
        persistenceMae: { numeratorRaw: '30', denominator: 10 },
      },
      holdout: {
        covered: 10,
        total: 10,
        coveragePassed: true,
        pointBeatsPersistence: true,
        modelMae: { numeratorRaw: '20', denominator: 10 },
        persistenceMae: { numeratorRaw: '30', denominator: 10 },
      },
      baselineBand: {
        selectionCovered: 9,
        selectionTotal: 10,
        selectionCoveragePassed: true,
        holdoutCovered: 3,
        holdoutTotal: 10,
        coveragePassed: false,
      },
    })
    const evidence = await readHistoricalModelEvidence(question, async () => ({
      rows: [
        {
          ...row,
          model_version: 'hband4-1758081600-1759114800',
          issued_at: '2026-10-05T00:05:00.000Z',
          target_at: '2026-10-05T01:05:00.000Z',
          artifact_registered_at: '2026-10-05T00:01:00.000Z',
          payload_bytes: v4Payload,
          artifact_sha256: createHash('sha256').update(v4Payload).digest('hex'),
          fit_pairs: 20,
          calibration_pairs: 20,
          selection_pairs: 10,
          holdout_pairs: 10,
        },
      ],
    }))
    expect(evidence).toEqual({
      status: 'unavailable',
      reason: 'untouched_interval_coverage_failed',
    })
  })

  it('rejects v3 registration or issue after the v4 migration boundary', async () => {
    expect(
      await readHistoricalModelEvidence(question, async () => ({
        rows: [{ ...row, issued_at: row.v4_activated_at }],
      })),
    ).toEqual({ status: 'unavailable', reason: 'ledger_unavailable' })
    expect(
      await readHistoricalModelEvidence(question, async () => ({
        rows: [
          {
            ...row,
            artifact_registered_at: row.v4_activated_at,
          },
        ],
      })),
    ).toEqual({ status: 'unavailable', reason: 'ledger_unavailable' })
    expect(
      await readHistoricalModelEvidence(question, async () => ({
        rows: [
          {
            ...row,
            model_version: 'hdelta4-1758081600-1759114800',
            issued_at: '2026-10-05T00:05:00.000Z',
            artifact_registered_at: '2026-10-04T23:59:59.999Z',
          },
        ],
      })),
    ).toEqual({ status: 'unavailable', reason: 'ledger_unavailable' })
  })

  it('refuses a tampered artifact, broken accounting, absent issue, and unenrolled horizon', async () => {
    expect(
      await readHistoricalModelEvidence(question, async () => ({
        rows: [{ ...row, forecast_point_raw: '190000000000001', artifact_sha256: 'f'.repeat(64) }],
      })),
    ).toEqual({ status: 'unavailable', reason: 'ledger_unavailable' })
    expect(
      await readHistoricalModelEvidence(question, async () => ({
        rows: [{ ...row, pending: '2' }],
      })),
    ).toEqual({ status: 'unavailable', reason: 'ledger_unavailable' })
    const falseSkillPayload = JSON.stringify({
      ...JSON.parse(payloadBytes),
      holdout: { ...JSON.parse(payloadBytes).holdout, pointBeatsPersistence: false },
    })
    expect(
      await readHistoricalModelEvidence(question, async () => ({
        rows: [
          {
            ...row,
            payload_bytes: falseSkillPayload,
            artifact_sha256: createHash('sha256').update(falseSkillPayload).digest('hex'),
          },
        ],
      })),
    ).toEqual({ status: 'unavailable', reason: 'ledger_unavailable' })
    expect(
      await readHistoricalModelEvidence({ ...question, assetDecimals: 18 }, async () => ({
        rows: [row],
      })),
    ).toEqual({ status: 'unavailable', reason: 'ledger_unavailable' })
    expect(await readHistoricalModelEvidence(question, async () => ({ rows: [] }))).toEqual({
      status: 'unavailable',
      reason: 'no_current_issue',
    })
    const execute = vi.fn(async () => ({ rows: [row] }))
    expect(await readHistoricalModelEvidence({ ...question, horizonHours: 2 }, execute)).toEqual({
      status: 'unavailable',
      reason: 'not_enrolled',
    })
    expect(execute).not.toHaveBeenCalled()
  })
})
