import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { neon } from '@neondatabase/serverless'

import handler from '@/pages/api/venues/[venue]/quote-forecast'

vi.mock('@neondatabase/serverless', () => ({ neon: vi.fn() }))
const readQuery = vi.fn()
const priorReadUrl = process.env.FORECAST_READ_DATABASE_URL
const priorGenericUrl = process.env.DATABASE_URL

const SHA = 'a'.repeat(64)
const PHYSICAL = 'b'.repeat(64)
const HASH = `0x${'c'.repeat(64)}`
const NOW = '2026-09-27T21:00:00.000Z'
const BLOCK_AT = '2026-09-27T20:00:00.000Z'
const CAPTURE_START = '2026-09-27T20:04:00.000Z'
const CAPTURE_END = '2026-09-27T20:05:00.000Z'
const ISSUED = '2026-09-27T20:06:00.000Z'
const INSERTED = '2026-09-27T20:08:00.000Z'

function receipt(kind: 'point_issue' | 'duration_issue', horizon: number, status?: string) {
  const point = kind === 'point_issue'
  const issueStatus = status ?? (point ? 'research_forecast' : 'research_only')
  return {
    receipt_key: `${kind}-${horizon}`,
    study: point
      ? 'curve-crvusd-secondary-prospective-forecast-v1'
      : 'curve-crvusd-secondary-prospective-duration-v1',
    kind,
    status: issueStatus,
    horizon_hours: horizon,
    source_block: '26071191',
    source_block_hash: HASH,
    source_block_at: BLOCK_AT,
    capture_start_at: CAPTURE_START,
    capture_end_at: CAPTURE_END,
    issued_at: ISSUED,
    inserted_at: INSERTED,
    source_checkpoint_sha256: SHA,
    source_checkpoint_physical_sha256: PHYSICAL,
    artifact_sha256: 'd'.repeat(64),
    artifact_physical_sha256: 'e'.repeat(64),
    payload: point
      ? {
          currentQuote: 0.99991,
          projectedQuote: issueStatus === 'research_forecast' ? 0.9998 : null,
          empiricalAnalogInterval: issueStatus === 'research_forecast' ? [0.9997, 1.0001] : null,
          internalSecret: 'never publish',
        }
      : {
          currentQuote: 0.99991,
          threshold: 0.998,
          analog: { survival: 0.8, probability: 0.2 },
          unconditional: { survival: 0.6 },
        },
  }
}

function completeRows() {
  return [
    receipt('point_issue', 24),
    receipt('point_issue', 168),
    receipt('duration_issue', 24),
    receipt('duration_issue', 72),
    receipt('duration_issue', 168),
  ]
}

async function request(method = 'GET', venue: unknown = 'scrvUSD') {
  let body: Record<string, any> | undefined
  const res = {
    status: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
    json: vi.fn((value: Record<string, any>) => {
      body = value
      return value
    }),
  }
  await handler({ method, query: { venue } } as never, res as never)
  return { body: body!, res }
}

describe('scrvUSD nominal quote forecast API', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW))
    process.env.FORECAST_READ_DATABASE_URL = 'postgresql://forecast-reader@localhost/test'
    vi.mocked(neon)
      .mockReset()
      .mockReturnValue(readQuery as never)
    readQuery.mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
    if (priorReadUrl === undefined) delete process.env.FORECAST_READ_DATABASE_URL
    else process.env.FORECAST_READ_DATABASE_URL = priorReadUrl
    if (priorGenericUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = priorGenericUrl
  })

  it('serves a complete fresh group with explicit research scope and no raw payload or duration probability', async () => {
    readQuery.mockResolvedValueOnce(completeRows())
    const { body, res } = await request()
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      expect.stringContaining('s-maxage=30'),
    )
    expect(body.status).toBe('research_only')
    expect(body.input).toEqual({
      amount: '1000000',
      asset: 'crvUSD',
      output: 'USDT_or_USDC_nominal_usd',
    })
    expect(body.source).toMatchObject({ block: 26071191, blockHash: HASH, checkpointSha256: SHA })
    expect(body.point).toHaveLength(2)
    expect(body.duration).toHaveLength(3)
    expect(body.point[0]).toMatchObject({
      horizonHours: 24,
      targetAt: '2026-09-28T20:00:00.000Z',
      projectedQuote: 0.9998,
    })
    expect(JSON.stringify(body)).not.toContain('internalSecret')
    expect(JSON.stringify(body)).not.toContain('survival')
    expect(JSON.stringify(body.duration)).not.toContain('probability')
  })

  it('does not fall back from a newer incomplete group', async () => {
    readQuery.mockResolvedValueOnce([receipt('point_issue', 24)])
    const { body, res } = await request()
    expect(body).toMatchObject({ status: 'unavailable', reason: 'incomplete_latest_group' })
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store')
  })

  it('abstains when all five fresh research issues are unavailable', async () => {
    const rows = completeRows().map((row) => ({
      ...row,
      status: row.kind === 'point_issue' ? 'unavailable' : 'incomplete_24h_history',
      payload:
        row.kind === 'point_issue'
          ? { currentQuote: 0.99991, projectedQuote: null, empiricalAnalogInterval: null }
          : row.payload,
    }))
    readQuery.mockResolvedValueOnce(rows)
    const { body, res } = await request()
    expect(body).toMatchObject({ status: 'unavailable', reason: 'forecast_abstained' })
    expect(
      body.point.every((item: { projectedQuote?: number }) => item.projectedQuote === undefined),
    ).toBe(true)
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store')
  })

  it('rejects a stale source even if a later insertion time looks fresh', async () => {
    vi.setSystemTime(new Date('2026-09-27T22:30:00.000Z'))
    readQuery.mockResolvedValueOnce(completeRows())
    expect((await request()).body.reason).toBe('stale_source')
  })

  it('rejects mixed checkpoint seals, malformed chronology, and malformed payload', async () => {
    const mixed = completeRows()
    mixed[4].source_checkpoint_sha256 = 'f'.repeat(64)
    readQuery.mockResolvedValueOnce(mixed)
    expect((await request()).body.reason).toBe('mixed_latest_group')

    const invalidTime = completeRows()
    invalidTime[2].issued_at = 'yesterday'
    readQuery.mockResolvedValueOnce(invalidTime)
    expect((await request()).body.reason).toBe('invalid_receipt')

    const invalidDate = completeRows()
    invalidDate[2].issued_at = new Date(Number.NaN) as never
    readQuery.mockResolvedValueOnce(invalidDate)
    expect((await request()).body.reason).toBe('invalid_receipt')

    const malformed = completeRows()
    malformed[0].payload.projectedQuote = Number.NaN
    readQuery.mockResolvedValueOnce(malformed)
    expect((await request()).body.reason).toBe('invalid_receipt')
  })

  it('rejects unsupported venues and methods without touching the database', async () => {
    expect((await request('POST')).res.status).toHaveBeenCalledWith(405)
    expect((await request('GET', 'aave-v3-usde')).res.status).toHaveBeenCalledWith(404)
    expect((await request('GET', ['scrvUSD'])).res.status).toHaveBeenCalledWith(404)
    expect(neon).not.toHaveBeenCalled()
    expect(readQuery).not.toHaveBeenCalled()
  })

  it('returns unavailable with 503 on database failure', async () => {
    readQuery.mockRejectedValueOnce(new Error('Neon unavailable'))
    const { body, res } = await request()
    expect(res.status).toHaveBeenCalledWith(503)
    expect(body).toEqual({ status: 'unavailable', reason: 'forecast_store_unavailable' })
  })

  it('fails closed when the dedicated read credential is absent despite a generic database URL', async () => {
    delete process.env.FORECAST_READ_DATABASE_URL
    process.env.DATABASE_URL = 'postgresql://generic-writer@localhost/test'
    const { body, res } = await request()
    expect(res.status).toHaveBeenCalledWith(503)
    expect(body).toEqual({ status: 'unavailable', reason: 'forecast_store_unavailable' })
    expect(neon).not.toHaveBeenCalled()
    expect(readQuery).not.toHaveBeenCalled()
  })
})
