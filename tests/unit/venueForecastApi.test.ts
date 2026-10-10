import { beforeEach, describe, expect, it, vi } from 'vitest'

import handler from '@/pages/api/venues/[venue]/forecast'
import {
  readVenueForecastEvidence,
  readVenueMeasuredPersistenceEvidence,
} from '@/pages/api/_lib/venueForecastReads'

vi.mock('@/pages/api/_lib/venueForecastReads', () => ({
  readVenueForecastEvidence: vi.fn(),
  readVenueMeasuredPersistenceEvidence: vi.fn(),
}))

const evidence = {
  venue: 'aave-v3-usde',
  chainId: 1,
  storage: 'database',
  route: {
    metric: 'instant_usd',
    kind: 'aave_reserve_cash',
    label: 'Aave USDe reserve cash',
    exitFrom: '0x4c9EDD5852cd905f086C759E8383e09bff1E68B3',
    limit: 'reserve_cash',
  },
  latest: null,
  samples: [],
  coverage: {
    observedRows: 0,
    observedSpan: { start: null, end: null },
    returnedRows: 0,
    truncated: false,
    latestAttempt: null,
    flowStatus: 'uncertified',
    flowReason: 'no_receipts',
    sealedRanges: 0,
    sealedBlocks: { start: null, end: null },
    sealedEvents: 0,
    maxFlowWindowHours: 24,
    maxGrossOutflowUsd: null,
    maxNetOutflowUsd: null,
    exitDurationDistribution: null,
  },
}

const measuredEvidence = {
  venue: evidence.venue,
  chainId: 1,
  storage: 'database',
  routeKey: `1:${evidence.venue}:instant_usd:${evidence.route.exitFrom.toLowerCase()}`,
  source: 'recorded_cash',
  costCapPct: null,
  costCapSelection: 'not_applicable',
  cadenceHours: 1,
  samples: [],
  coverage: { returnedSamples: 0, truncated: false, maxCurvePasses: null },
  unavailableReason: null,
}

async function request(
  query: Record<string, unknown>,
  method = 'GET',
  remoteAddress = '127.0.0.1',
) {
  let body: Record<string, any> | null = null
  const res = {
    status: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
    json: vi.fn((value: Record<string, any>) => {
      body = value
      return value
    }),
  }
  await handler({ method, query, socket: { remoteAddress } } as never, res as never)
  return { body: body!, res }
}

describe('venue sampled-capacity forecast API', () => {
  beforeEach(() => {
    vi.mocked(readVenueForecastEvidence)
      .mockReset()
      .mockResolvedValue(evidence as never)
    vi.mocked(readVenueMeasuredPersistenceEvidence)
      .mockReset()
      .mockResolvedValue(measuredEvidence as never)
  })

  it('serves the exact venue and question with explicit validation limits', async () => {
    const { body, res } = await request({
      venue: 'aave-v3-usde',
      amountUsd: '1000000',
      horizonHours: '24',
    })
    expect(res.status).toHaveBeenCalledWith(200)
    expect(readVenueForecastEvidence).toHaveBeenCalledWith('aave-v3-usde', {
      allowLocalFallback: process.env.NODE_ENV === 'development',
    })
    expect(body.forecast).toMatchObject({
      routeKey: `1:aave-v3-usde:instant_usd:${evidence.route.exitFrom.toLowerCase()}`,
      amountUsd: 1_000_000,
      horizonHours: 24,
      status: 'abstain',
      holderExecutable: false,
      predictiveAlertEligible: false,
    })
    expect(body.storage).toBe('database')
    expect(body.measuredPersistence).toMatchObject({
      status: 'unavailable',
      reason: 'no_samples',
      amountUsd: 1_000_000,
      source: 'recorded_cash',
      forwardForecast: false,
      currentRun: null,
    })
    expect(body.validation).toMatchObject({
      holderExit: 'unavailable',
      conditionDuration: 'unavailable',
    })
  })

  it('exposes measured above-Q persistence while preserving forward-forecast abstention', async () => {
    const latestMs = Date.now() - 60_000
    vi.mocked(readVenueMeasuredPersistenceEvidence).mockResolvedValueOnce({
      ...measuredEvidence,
      routeKey: '1:aave-v3-usde:recorded_cost_curve:exact-config',
      source: 'recorded_cost_curve',
      costCapPct: 1,
      costCapSelection: 'default_recorded_level',
      samples: [90, 100, 120].map((capacityUsd, index) => ({
        observedAt: new Date(latestMs - (2 - index) * 3_600_000).toISOString(),
        firstAvailableAt: new Date(latestMs - (2 - index) * 3_600_000 + 1000).toISOString(),
        capacityUsd,
        sourceId: `curve-${index}`,
        coverage: 'complete',
      })),
    } as never)
    const { body, res } = await request({
      venue: 'aave-v3-usde',
      amountUsd: '100',
      horizonHours: '24',
    })
    expect(res.status).toHaveBeenCalledWith(200)
    expect(body.forecast.status).toBe('abstain')
    expect(body.measuredPersistence).toMatchObject({
      claim: 'sampled_capacity_persistence_only',
      currentStatus: 'at_or_above',
      currentRun: { sampledSpanHours: 1, rightCensored: true },
      sampleShare: { atOrAboveQ: 2, complete: 3, fraction: 2 / 3 },
      costCapPct: 1,
      costCapSelection: 'default_recorded_level',
      forwardForecast: false,
      holderExecutable: false,
    })
    expect(body.validation.conditionDuration).toBe('unavailable')
    expect(readVenueMeasuredPersistenceEvidence).toHaveBeenCalledWith('aave-v3-usde', {
      allowLocalFallback: process.env.NODE_ENV === 'development',
      forecastEvidence: evidence,
    })
  })

  it('keeps historical rows but suppresses cash projections after a newer failed local capture', async () => {
    const sample = {
      sourceId: 'old-local-row',
      source: 'observed',
      block: 123,
      observedAt: '2026-10-01T11:00:00.000Z',
      firstAvailableAt: '2026-10-01T11:01:00.000Z',
      coverage: 'complete',
      capacityUsd: 1_000_000,
      cooldownSeconds: null,
      tvlUsd: null,
    }
    const local = {
      ...evidence,
      storage: 'local_mac_recorder',
      samples: [sample],
      coverage: {
        ...evidence.coverage,
        latestAttempt: {
          status: 'capture_failed',
          attemptedAtUtc: '2026-10-01T12:00:00.000Z',
        },
      },
    }
    vi.mocked(readVenueForecastEvidence).mockResolvedValueOnce(local as never)
    vi.mocked(readVenueMeasuredPersistenceEvidence).mockResolvedValueOnce({
      ...measuredEvidence,
      storage: 'local_mac_recorder',
      samples: [
        {
          observedAt: sample.observedAt,
          firstAvailableAt: sample.firstAvailableAt,
          capacityUsd: sample.capacityUsd,
          sourceId: sample.sourceId,
          coverage: 'complete',
        },
      ],
    } as never)
    const { body } = await request({
      venue: 'aave-v3-usde',
      amountUsd: '100',
      horizonHours: '24',
    })
    expect(body.latest).toBeNull()
    expect(body.coverage.latestAttempt.status).toBe('capture_failed')
    expect(body.forecast.status).toBe('abstain')
    expect(body.measuredPersistence).toMatchObject({
      currentStatus: 'censored',
      currentCensorReason: 'latest_capture_failed',
      currentRun: null,
      sampleShare: { atOrAboveQ: 1, complete: 1, fraction: 1 },
    })
    expect(body.measuredPersistence.series).toHaveLength(1)
  })

  it('preserves an unrecorded requested cost cap as unavailable without fallback', async () => {
    vi.mocked(readVenueMeasuredPersistenceEvidence).mockResolvedValueOnce({
      ...measuredEvidence,
      source: 'recorded_cost_curve',
      costCapPct: 0.75,
      costCapSelection: 'requested_recorded_level',
      unavailableReason: 'cost_cap_not_recorded',
    } as never)
    const { body } = await request({
      venue: 'aave-v3-usde',
      amountUsd: '100',
      horizonHours: '24',
      costCapPct: '0.75',
    })
    expect(body.measuredPersistence).toMatchObject({
      costCapPct: 0.75,
      costCapSelection: 'requested_recorded_level',
      unavailableReason: 'cost_cap_not_recorded',
      status: 'unavailable',
      series: [],
    })
    expect(readVenueMeasuredPersistenceEvidence).toHaveBeenCalledWith(
      'aave-v3-usde',
      expect.objectContaining({ costCapPct: 0.75 }),
    )
  })

  it('labels an active local capture as pending rather than failed', async () => {
    vi.mocked(readVenueForecastEvidence).mockResolvedValueOnce({
      ...evidence,
      storage: 'local_mac_recorder',
      coverage: {
        ...evidence.coverage,
        latestAttempt: {
          status: 'capture_in_progress',
          attemptedAtUtc: '2026-10-01T12:00:00.000Z',
          token: 'attempt-token',
        },
      },
    } as never)
    vi.mocked(readVenueMeasuredPersistenceEvidence).mockResolvedValueOnce({
      ...measuredEvidence,
      storage: 'local_mac_recorder',
      samples: [],
    } as never)
    const { body } = await request({ venue: 'aave-v3-usde', amountUsd: '100', horizonHours: '24' })
    expect(body.measuredPersistence.currentCensorReason).toBe('latest_capture_in_progress')
  })

  it('does not allow local evidence for non-loopback requests', async () => {
    await request(
      { venue: 'aave-v3-usde', amountUsd: '1000000', horizonHours: '24' },
      'GET',
      '203.0.113.8',
    )
    expect(readVenueForecastEvidence).toHaveBeenCalledWith('aave-v3-usde', {
      allowLocalFallback: false,
    })
  })

  it('returns unavailable when neither evidence source is readable', async () => {
    vi.mocked(readVenueForecastEvidence).mockRejectedValueOnce(new Error('source unavailable'))
    const { body, res } = await request({
      venue: 'aave-v3-usde',
      amountUsd: '1000000',
      horizonHours: '24',
    })
    expect(res.status).toHaveBeenCalledWith(503)
    expect(body).toEqual({ error: 'venue forecast evidence unavailable' })
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store')
  })

  it('rejects invalid input and unknown venues before reading the database', async () => {
    expect(
      (await request({ venue: 'aave-v3-usde', amountUsd: '0', horizonHours: '24' })).res.status,
    ).toHaveBeenCalledWith(400)
    expect(
      (await request({ venue: 'aave-v3-usde', amountUsd: '10', horizonHours: '721' })).res.status,
    ).toHaveBeenCalledWith(400)
    expect(
      (await request({ venue: 'other', amountUsd: '10', horizonHours: '24' })).res.status,
    ).toHaveBeenCalledWith(404)
    expect(readVenueForecastEvidence).not.toHaveBeenCalled()
  })
})
