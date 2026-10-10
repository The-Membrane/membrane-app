import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { db } from '@/db'
import handler from '@/pages/api/venues/[venue]/summary'

vi.mock('@/db', () => ({ db: { execute: vi.fn() } }))
vi.mock('@/pages/api/_lib/radarReads', () => ({ LABELS: { 'aave-v3-usde': 'Aave USDe' } }))
vi.mock('@/scripts/lib/alarmRules.mjs', () => ({
  coverageFor: () => [],
  instantExitUsd: () => 9,
}))
const localMocks = vi.hoisted(() => ({ readLocalVenueSummary: vi.fn() }))
vi.mock('@/scripts/lib/venueSummaryLocal.mjs', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readLocalVenueSummary: localMocks.readLocalVenueSummary,
}))

const supplyParams = {
  aToken: '0x4F5923Fc5FD4a93352581b38B7cD26943012DECF',
  underlying: '0x4c9EDD5852cd905f086C759E8383e09bff1E68B3',
  underlyingIdentity: 'match',
  decimalsIdentity: 'match',
  decimals: 18,
  priceAssumptionUsd: 1,
  totalSupply: '25000000000000000000',
  reads: { totalSupply: true },
}

async function summaryWith(
  supplyRow: Record<string, unknown> | null,
  alarmRows: Record<string, unknown>[] = [],
  latestOverride: Record<string, unknown> = {},
  loopback = false,
) {
  const latest = {
    block: 200,
    observed_at: '2026-09-27T12:00:00Z',
    instant_usd: '9',
    params: { ...supplyParams, totalSupply: null, reads: { totalSupply: false } },
    ...latestOverride,
  }
  const responses = [
    { rows: [latest] },
    { rows: supplyRow ? [supplyRow] : [] },
    { rows: [{ rows: '2', observed: '2', span_start: null, span_end: null }] },
    { rows: [{ rows: '0', span_start: null, span_end: null }] },
    { rows: [{ rows: '0' }] },
    { rows: alarmRows },
  ]
  const execute = vi.mocked(db.execute)
  responses.forEach((response) => execute.mockResolvedValueOnce(response as never))
  let body: Record<string, any> | null = null
  const res = {
    status: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
    json: vi.fn((value: Record<string, any>) => {
      body = value
      return value
    }),
  }
  await handler(
    {
      method: 'GET',
      query: { venue: 'aave-v3-usde' },
      socket: loopback ? { remoteAddress: '127.0.0.1' } : undefined,
    } as never,
    res as never,
  )
  expect(res.status).toHaveBeenCalledWith(200)
  expect(execute).toHaveBeenCalledTimes(6)
  return body!
}

describe('Aave venue summary supplied TVL', () => {
  beforeEach(() => {
    vi.mocked(db.execute).mockReset()
    localMocks.readLocalVenueSummary.mockReset()
  })
  afterEach(() => vi.unstubAllEnvs())

  it('projects the exact finalized DB block time and uses it to judge freshness', async () => {
    const observedAt = new Date(Date.now() - 60_000).toISOString()
    const sourceSeconds = Math.floor(Date.parse(observedAt) / 1_000) - 30
    const result = await summaryWith(null, [], {
      observed_at: observedAt,
      params: {
        ...supplyParams,
        read_block_finalized: true,
        read_block_pinned: true,
        read_block_number: '200',
        read_block_hash: `0x${'a'.repeat(64)}`,
        read_block_time: sourceSeconds,
      },
    })
    const sourceAt = new Date(sourceSeconds * 1_000).toISOString()
    expect(result.observed.sourceAt).toBe(sourceAt)
    expect(result.provenance).toMatchObject({
      storage: 'database',
      observationStatus: 'fresh',
      sourceAt,
      fetchedAt: observedAt,
    })
  })

  it('keeps malformed or unsealed DB source times null and stale despite a recent fetch', async () => {
    const observedAt = new Date(Date.now() - 60_000).toISOString()
    const sourceSeconds = Math.floor(Date.parse(observedAt) / 1_000) - 30
    const sealed = {
      ...supplyParams,
      read_block_finalized: true,
      read_block_pinned: true,
      read_block_number: '200',
      read_block_hash: `0x${'a'.repeat(64)}`,
      read_block_time: sourceSeconds,
    }
    for (const params of [
      { ...sealed, read_block_finalized: false },
      { ...sealed, read_block_pinned: false },
      { ...sealed, read_block_number: '199' },
      { ...sealed, read_block_hash: '0xbad' },
      { ...sealed, read_block_time: String(sourceSeconds) },
      { ...sealed, read_block_time: sourceSeconds + 600 },
    ]) {
      vi.mocked(db.execute).mockReset()
      const result = await summaryWith(null, [], { observed_at: observedAt, params })
      expect(result.provenance.sourceAt).toBeNull()
      expect(result.provenance.observationStatus).toBe('stale')
      expect(result.observed.sourceAt).toBeUndefined()
    }
  })

  it('keeps a recent DB fetch stale when its sealed source block is old', async () => {
    const observedAt = new Date(Date.now() - 60_000).toISOString()
    const sourceSeconds = Math.floor((Date.now() - 4 * 60 * 60_000) / 1_000)
    const result = await summaryWith(null, [], {
      observed_at: observedAt,
      params: {
        ...supplyParams,
        read_block_finalized: true,
        read_block_pinned: true,
        read_block_number: '200',
        read_block_hash: `0x${'a'.repeat(64)}`,
        read_block_time: sourceSeconds,
      },
    })
    expect(result.provenance.sourceAt).toBe(new Date(sourceSeconds * 1_000).toISOString())
    expect(result.provenance.observationStatus).toBe('stale')
  })

  it('preserves newer-local selection while keeping the DB for an older local block', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    const observedAt = new Date(Date.now() - 60_000).toISOString()
    const sourceSeconds = Math.floor(Date.parse(observedAt) / 1_000) - 30
    const latestOverride = {
      observed_at: observedAt,
      params: {
        ...supplyParams,
        read_block_finalized: true,
        read_block_pinned: true,
        read_block_number: '200',
        read_block_hash: `0x${'a'.repeat(64)}`,
        read_block_time: sourceSeconds,
      },
    }
    const times = {
      sourceAt: new Date(sourceSeconds * 1_000).toISOString(),
      fetchedAt: observedAt,
      firstLocalReceiptAt: observedAt,
    }
    localMocks.readLocalVenueSummary.mockReturnValue({
      status: 'fresh',
      count: 1,
      observed: { block: 201, observedAt, sourceAt: times.sourceAt },
      suppliedTvl: null,
      hasInstant: true,
      times,
    })
    const newer = await summaryWith(null, [], latestOverride, true)
    expect(newer.provenance.storage).toBe('local_mac_recorder')
    expect(newer.provenance.databaseStatus).toBe('available_lagging')
    vi.mocked(db.execute).mockReset()
    localMocks.readLocalVenueSummary.mockReturnValue({
      status: 'fresh',
      count: 1,
      observed: { block: 199, observedAt, sourceAt: times.sourceAt },
      suppliedTvl: null,
      hasInstant: true,
      times,
    })
    const older = await summaryWith(null, [], latestOverride, true)
    expect(older.provenance.storage).toBe('database')
    expect(older.provenance.sourceAt).toBe(times.sourceAt)
  })

  it('retains an older verified supply reading with its own block and time after a failed latest read', async () => {
    const result = await summaryWith({
      block: 100,
      observed_at: '2026-09-25T08:00:00Z',
      params: supplyParams,
    })
    expect(result.observed).toMatchObject({
      block: 200,
      observedAt: '2026-09-27T12:00:00.000Z',
      instantUsd: 9,
    })
    expect(result.suppliedTvl).toEqual({
      usd: 25,
      block: 100,
      observedAt: '2026-09-25T08:00:00.000Z',
    })
    expect(result.worstOutflows).toEqual({
      d1: null,
      d7: null,
      status: 'unavailable',
      reason: 'legacy_flow_coverage_uncertified',
    })
  })

  it('keeps supply unknown with no verified row, despite known instant cash', async () => {
    const result = await summaryWith(null)
    expect(result.observed.instantUsd).toBe(9)
    expect(result.suppliedTvl).toBeNull()
  })

  it('does not expose old open flow alarms as current venue danger', async () => {
    const result = await summaryWith(null, [
      {
        kind: 'headroom_thin',
        severity: 'alarm',
        evidence: { ratio: 1.1 },
        firedAt: '2026-09-20T00:00:00Z',
      },
      {
        kind: 'net_outflow_streak',
        severity: 'watch',
        evidence: {},
        firedAt: '2026-09-20T00:00:00Z',
      },
      {
        kind: 'utilization',
        severity: 'alarm',
        evidence: { utilizationPct: 96.4 },
        firedAt: '2026-09-20T00:00:00Z',
      },
    ])
    expect(result.alarms.open.map((a: { kind: string }) => a.kind)).toEqual(['utilization'])
  })

  it('preserves a terms-page notice with its notice severity and structured source', async () => {
    const result = await summaryWith(null, [
      {
        kind: 'terms_page_notice',
        severity: 'notice',
        evidence: { count: 1, sourceUrl: 'https://official.example/terms' },
        firedAt: '2026-09-28T00:00:00Z',
      },
    ])
    expect(result.alarms.open).toEqual([
      {
        kind: 'terms_page_notice',
        severity: 'notice',
        evidence: { count: 1, sourceUrl: 'https://official.example/terms' },
        firedAt: '2026-09-28T00:00:00.000Z',
      },
    ])
  })
})
