import type { NextApiRequest, NextApiResponse } from 'next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DIRECT_SUPPLY_MARKETS } from '@/lib/carry/directSupplyMarketConstants'
import handler, { parseHistoricalFlowStressQuery } from '@/pages/api/carry/historical-flow-stress'

const mocks = vi.hoisted(() => ({
  readCurrent: vi.fn(),
  manifest: vi.fn(),
}))

vi.mock('@/pages/api/carry/forecast-observations', () => ({
  localDevelopmentRequest: () => true,
  readCurrentDirectCashOrigins: mocks.readCurrent,
}))
vi.mock('@/scripts/record-carry-cash-issues.mjs', () => ({ buildSubjectManifest: mocks.manifest }))

const aave = DIRECT_SUPPLY_MARKETS.aaveV3Usdc
const destination = aave.destination.toLowerCase()
const currentObservation = (sourceOverrides: Record<string, unknown> = {}) => ({
  status: 'observed',
  originValidation: 'multi_rpc_host_match',
  reading: {
    source: {
      chainId: 1,
      finality: 'finalized',
      ageSeconds: 0,
      blockNumber: 26101000,
      blockHash: '0x' + 'a'.repeat(64),
      blockTimestamp: '2026-10-03T12:00:00.000Z',
      ...sourceOverrides,
    },
    asset: { address: aave.underlying, decimals: 6 },
    route: { routeKey: aave.routeKey, destination: aave.destination, cashRaw: '900000000' },
  },
})
const request = (query: Record<string, unknown>) =>
  ({ method: 'GET', query, socket: { remoteAddress: '127.0.0.1' } }) as NextApiRequest
const response = () => {
  const result = {
    statusCode: 200,
    body: null as unknown,
    setHeader: vi.fn(),
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(body: unknown) {
      this.body = body
      return this
    },
  }
  return result as typeof result & NextApiResponse
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-03T12:02:00.000Z'))
  mocks.manifest.mockResolvedValue({
    subjects: [
      { route_key: aave.routeKey, destination },
      { route_key: 'USDe → Staked USDe [USDe]', destination: '0x' + '1'.repeat(40) },
    ],
  })
})

afterEach(() => vi.restoreAllMocks())

describe('historical gross-flow stress API', () => {
  it('requires an exact tracked subject and raw positive Q', async () => {
    expect(
      parseHistoricalFlowStressQuery({
        routeKey: aave.routeKey,
        destination,
        requestedRaw: '0',
      }),
    ).toBeNull()
    const res = response()
    await handler(
      request({ routeKey: aave.routeKey, destination: '0x' + '2'.repeat(40), requestedRaw: '1' }),
      res,
    )
    expect(res.statusCode).toBe(404)
    expect(mocks.readCurrent).not.toHaveBeenCalled()
  })

  it('abstains for a tracked subject without a verified gross-flow archive', async () => {
    const res = response()
    await handler(
      request({
        routeKey: 'USDe → Staked USDe [USDe]',
        destination: '0x' + '1'.repeat(40),
        requestedRaw: '1000000',
      }),
      res,
    )
    expect(res.statusCode).toBe(200)
    expect(res.body).toMatchObject({ status: 'gross_flow_unverified' })
    expect(mocks.readCurrent).not.toHaveBeenCalled()
  })

  it('requires multi-host current cash agreement before replaying history', async () => {
    mocks.readCurrent.mockResolvedValue({ status: 'observed', originValidation: 'single_rpc_host' })
    const res = response()
    await handler(request({ routeKey: aave.routeKey, destination, requestedRaw: '1000000' }), res)
    expect(res.body).toMatchObject({ status: 'current_cash_unverified' })
  })

  it('derives response age from the source timestamp instead of a mismatched declared age', async () => {
    for (const ageSeconds of [0, 1801]) {
      mocks.readCurrent.mockResolvedValue(currentObservation({ ageSeconds }))
      const res = response()
      await handler(request({ routeKey: aave.routeKey, destination, requestedRaw: '1000000' }), res)
      expect(res.statusCode).toBe(200)
      expect(res.body).toMatchObject({ currentCash: { ageSeconds: 120 } })
    }
    mocks.readCurrent.mockResolvedValue(
      currentObservation({
        ageSeconds: 0,
        blockTimestamp: '2026-10-03T11:00:00.000Z',
      }),
    )
    const stale = response()
    await handler(request({ routeKey: aave.routeKey, destination, requestedRaw: '1000000' }), stale)
    expect(stale.statusCode).toBe(503)
  })

  it('computes provenance age at response time after calculation delay', async () => {
    const checkedAt = Date.parse('2026-10-03T12:02:00.000Z')
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(checkedAt)
      .mockReturnValue(checkedAt + 15_000)
    mocks.readCurrent.mockResolvedValue(currentObservation())
    const res = response()
    await handler(request({ routeKey: aave.routeKey, destination, requestedRaw: '1000000' }), res)
    expect(res.statusCode).toBe(200)
    expect(res.body).toMatchObject({ currentCash: { ageSeconds: 135 } })
  })

  it('clamps accepted clock-skew age to zero while preserving current and past ages', async () => {
    for (const [blockTimestamp, ageSeconds] of [
      ['2026-10-03T12:03:59.000Z', 0],
      ['2026-10-03T12:02:00.000Z', 0],
      ['2026-10-03T12:00:00.000Z', 120],
    ] as const) {
      mocks.readCurrent.mockResolvedValue(currentObservation({ blockTimestamp }))
      const res = response()
      await handler(request({ routeKey: aave.routeKey, destination, requestedRaw: '1000000' }), res)
      expect(res.statusCode).toBe(200)
      expect(res.body).toMatchObject({ currentCash: { blockTimestamp, ageSeconds } })
    }
  })

  it('rejects a source timestamp more than the permitted two minutes ahead', async () => {
    mocks.readCurrent.mockResolvedValue(
      currentObservation({ blockTimestamp: '2026-10-03T12:04:00.001Z' }),
    )
    const res = response()
    await handler(request({ routeKey: aave.routeKey, destination, requestedRaw: '1000000' }), res)
    expect(res.statusCode).toBe(503)
    expect(res.body).toMatchObject({ error: 'current_cash_identity_mismatch' })
  })

  it('rejects cash that crosses the timestamp freshness limit before the response', async () => {
    const checkedAt = Date.parse('2026-10-03T12:30:00.000Z')
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(checkedAt)
      .mockReturnValue(checkedAt + 1)
    mocks.readCurrent.mockResolvedValue(currentObservation())
    const res = response()
    await handler(request({ routeKey: aave.routeKey, destination, requestedRaw: '1000000' }), res)
    expect(res.statusCode).toBe(503)
    expect(res.body).toMatchObject({ error: 'current_cash_identity_mismatch' })
  })

  it('rejects a finalized cash observation older than thirty minutes', async () => {
    mocks.readCurrent.mockResolvedValue(
      currentObservation({
        ageSeconds: 1801,
        blockTimestamp: '2026-10-03T11:31:59.000Z',
      }),
    )
    const res = response()
    await handler(request({ routeKey: aave.routeKey, destination, requestedRaw: '1000000' }), res)
    expect(res.statusCode).toBe(503)
    expect(res.body).toMatchObject({ error: 'current_cash_identity_mismatch' })
  })

  it('binds the selected Q to independently checked current cash and the sealed replay', async () => {
    mocks.readCurrent.mockResolvedValue({
      status: 'observed',
      originValidation: 'multi_rpc_host_match',
      reading: {
        source: {
          chainId: 1,
          finality: 'finalized',
          ageSeconds: 120,
          blockNumber: 26101000,
          blockHash: '0x' + 'a'.repeat(64),
          blockTimestamp: '2026-10-03T12:00:00.000Z',
        },
        asset: { address: aave.underlying, decimals: 6 },
        route: { routeKey: aave.routeKey, destination: aave.destination, cashRaw: '900000000' },
      },
    })
    const res = response()
    await handler(request({ routeKey: aave.routeKey, destination, requestedRaw: '1000000' }), res)
    expect(res.statusCode).toBe(200)
    expect(res.body).toMatchObject({
      status: 'historical_flow_stress',
      chainId: 1,
      marketKey: 'aaveV3Usdc',
      requestedRaw: '1000000',
      currentCash: { cashRaw: '900000000', rpcHostAgreement: 'multi_rpc_host_match' },
      archiveVerification: 'full_sealed_replay',
      archiveArtifactSha256: '234e6875376ff9978d2d7f019b83e93250455959b5a95ef1fcfcbbe588a86f62',
      stress: {
        horizonBlocks: 256,
        exactHorizonWindows: 137,
        nonoverlappingWindowCount: 78,
        pairedWindowSha256: '719e95a3d8e8b90326eda082fb52d01a342f7497e67c3b75eb2e433bcda4032e',
        historicalScenarios: {
          selection: 'retrospective_observed_rank_not_forecast_probability',
          sampleCount: 78,
          p10Trough: { rank: 8, sampleCount: 78 },
          worstTrough: { rank: 1, sampleCount: 78 },
          highestGrossOutflow: { rank: 1, sampleCount: 78 },
        },
        validation: 'not_validated',
        holderExecutableExit: false,
      },
    })
    const body = res.body as {
      stress: { historicalScenarios: { p10Trough: { duration: unknown } } }
    }
    expect(body.stress.historicalScenarios.p10Trough.duration).toMatchObject({
      observation: 'end_of_block_cash_only',
      timeBasis: 'verified_header_timestamp_brackets',
      currentCashRaw: '900000000',
      requestedRaw: '1000000',
    })
    const current = await mocks.readCurrent.mock.results.at(-1)!.value
    current.reading.source.blockTimestamp = '2026-10-03T11:00:00.000Z'
    const stale = response()
    await handler(request({ routeKey: aave.routeKey, destination, requestedRaw: '1000000' }), stale)
    expect(stale.statusCode).toBe(503)
    expect(stale.body).toMatchObject({ error: 'current_cash_identity_mismatch' })
  })
})
