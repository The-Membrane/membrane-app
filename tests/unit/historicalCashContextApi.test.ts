import type { NextApiRequest, NextApiResponse } from 'next'
import { afterEach, describe, expect, it, vi } from 'vitest'

import handler from '@/pages/api/carry/historical-cash-context'
import { readConfiguredLiveCurrentCash } from '@/scripts/research/carry-live-current-cash.mjs'

vi.mock('@/scripts/research/carry-live-current-cash.mjs', () => ({
  readConfiguredLiveCurrentCash: vi.fn(),
}))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

const subject = {
  routeKey: 'USDC → supply on Aave V3',
  destination: '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c',
}

async function responseFor(query: Record<string, string>) {
  vi.stubEnv('NODE_ENV', 'development')
  const req = {
    method: 'GET',
    query,
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as NextApiRequest
  let code = 0
  let body: Record<string, any> = {}
  const res = {
    setHeader() {
      return this
    },
    status(value: number) {
      code = value
      return this
    },
    json(value: Record<string, any>) {
      body = value
      return this
    },
  } as unknown as NextApiResponse
  await handler(req, res)
  return { code, body }
}

describe('local historical cash context API', () => {
  it('returns sealed history without starting a live RPC read', async () => {
    vi.mocked(readConfiguredLiveCurrentCash).mockImplementation(() => new Promise(() => {}))

    const { code, body } = await responseFor(subject)

    expect(code).toBe(200)
    expect(body).toMatchObject({
      status: 'historical_context',
      routeKey: subject.routeKey,
      destination: subject.destination,
      claim: 'aggregate_underlying_cash_proxy_only',
    })
    expect(body.sampleCount).toBeGreaterThan(0)
    expect(readConfiguredLiveCurrentCash).not.toHaveBeenCalled()
  })

  it('bounds a requested live read that never settles while preserving the archive', async () => {
    vi.mocked(readConfiguredLiveCurrentCash).mockImplementation(() => new Promise(() => {}))

    const { code, body } = await responseFor({ ...subject, includeLiveCurrent: '1' })

    expect(code).toBe(200)
    expect(readConfiguredLiveCurrentCash).toHaveBeenCalledOnce()
    expect(body).toMatchObject({
      status: 'historical_context',
      currentRead: { status: 'unavailable', reason: 'live_read_timeout' },
    })
    expect(body.sampleCount).toBeGreaterThan(0)
  }, 10_000)

  it('adds a matching fresh current read without changing historical samples', async () => {
    const base = await responseFor(subject)
    expect(base.body.status).toBe('historical_context')
    const blockAt = new Date(Date.now() - 10_000).toISOString()
    const readAtUtc = new Date(Date.now() - 5_000).toISOString()
    vi.mocked(readConfiguredLiveCurrentCash).mockResolvedValue({
      status: 'available',
      sourceKind: 'live_read_only_two_origin_finalized',
      routeKey: subject.routeKey,
      destination: subject.destination,
      asset: base.body.asset,
      assetDecimals: base.body.assetDecimals,
      cashRaw: '1000000000000',
      block: (BigInt(base.body.current?.block ?? '1') + 1n).toString(),
      blockHash: `0x${'a'.repeat(64)}`,
      blockAt,
      readAtUtc,
    })

    const { code, body } = await responseFor({ ...subject, includeLiveCurrent: '1' })

    expect(code).toBe(200)
    expect(body.current).toMatchObject({
      cashRaw: '1000000000000',
      blockAt,
      freshness: 'fresh',
      sourceKind: 'live_read_only_two_origin_finalized',
    })
    expect(body.currentRead).toMatchObject({ status: 'available' })
    expect(body.sampleCount).toBe(base.body.sampleCount)
    expect(body.p10NetChangeRaw).toBe(base.body.p10NetChangeRaw)
  })
})
