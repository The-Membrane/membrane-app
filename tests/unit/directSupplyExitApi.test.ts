import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DIRECT_SUPPLY_MARKETS } from '@/lib/carry/directSupplyMarketConstants'
import { readDirectSupplyExitQuote } from '@/lib/carry/directSupplyExitQuote'
import { checkRateLimit } from '@/lib/game/rateLimit'
import handler from '@/pages/api/carry/direct-supply-exit'

vi.mock('@/lib/carry/directSupplyExitQuote', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/carry/directSupplyExitQuote')>()),
  readDirectSupplyExitQuote: vi.fn(),
}))
vi.mock('@/lib/game/rateLimit', () => ({ checkRateLimit: vi.fn(), getClientIp: () => '127.0.0.1' }))

const MARKET = DIRECT_SUPPLY_MARKETS.aaveV3Usdc
const USDE_MARKET = DIRECT_SUPPLY_MARKETS.aaveV3Usde
const HOLDER = '0x0000000000000000000000000000000000000001'
const BODY = {
  routeKey: MARKET.routeKey,
  destinationAddress: MARKET.destination,
  owner: HOLDER,
  assetsRaw: '1000000',
  chainId: 1,
}

async function request(
  method: string,
  body: unknown,
  contentLength?: string,
  options: { remoteAddress?: string; forwardedFor?: string } = {},
) {
  const headers: Record<string, string> = {}
  let status = 0
  let response: Record<string, unknown> | null = null
  const res = {
    setHeader: vi.fn((key: string, value: string) => {
      headers[key] = value
    }),
    status: vi.fn((code: number) => {
      status = code
      return res
    }),
    json: vi.fn((value: Record<string, unknown>) => {
      response = value
      return res
    }),
  }
  await handler(
    {
      method,
      body,
      headers: {
        ...(contentLength ? { 'content-length': contentLength } : {}),
        ...(options.forwardedFor ? { 'x-forwarded-for': options.forwardedFor } : {}),
      },
      socket: { remoteAddress: options.remoteAddress },
    } as never,
    res as never,
  )
  return { headers, status, response }
}

describe('POST /api/carry/direct-supply-exit', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.mocked(checkRateLimit).mockReset().mockResolvedValue({ allowed: true })
    vi.mocked(readDirectSupplyExitQuote)
      .mockReset()
      .mockResolvedValue({
        status: 'checked_at_finalized_block',
        simulation: { status: 'success' },
      } as never)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  it('accepts a bounded exact target and disables cache', async () => {
    const result = await request('POST', BODY)
    expect(result.status).toBe(200)
    expect(result.headers['Cache-Control']).toBe('no-store')
    expect(vi.mocked(readDirectSupplyExitQuote).mock.calls[0][1]).toMatchObject({
      routeKey: BODY.routeKey,
      destinationAddress: BODY.destinationAddress.toLowerCase(),
      owner: HOLDER,
      assetsRaw: BODY.assetsRaw,
    })
    expect(vi.mocked(checkRateLimit).mock.calls[0][0]).not.toContain(HOLDER)
  })

  it('accepts the separately pinned Aave USDe 18-decimal route', async () => {
    const result = await request('POST', {
      routeKey: USDE_MARKET.routeKey,
      destinationAddress: USDE_MARKET.destination,
      owner: HOLDER,
      assetsRaw: '1000000000000000000',
      chainId: 1,
    })
    expect(result.status).toBe(200)
    expect(vi.mocked(readDirectSupplyExitQuote).mock.calls[0][1]).toMatchObject({
      routeKey: USDE_MARKET.routeKey,
      destinationAddress: USDE_MARKET.destination.toLowerCase(),
      assetsRaw: '1000000000000000000',
    })
  })

  it('rejects invalid and oversized requests before RPC', async () => {
    expect((await request('GET', BODY)).status).toBe(405)
    expect((await request('POST', { ...BODY, chainId: 10 })).status).toBe(400)
    expect((await request('POST', { ...BODY, assetsRaw: '0' })).status).toBe(400)
    expect((await request('POST', { ...BODY, extra: true })).status).toBe(400)
    expect((await request('POST', { ...BODY, destinationAddress: HOLDER })).status).toBe(404)
    expect((await request('POST', BODY, '9999')).status).toBe(413)
    expect(readDirectSupplyExitQuote).not.toHaveBeenCalled()
  })

  it('rate limits and hides provider and credential errors', async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 30 })
    expect((await request('POST', BODY)).status).toBe(429)
    vi.mocked(checkRateLimit).mockRejectedValueOnce(new Error('secret DB URL'))
    expect((await request('POST', BODY)).response).toEqual({ error: 'exit_check_unavailable' })
    vi.mocked(readDirectSupplyExitQuote).mockRejectedValue(new Error('secret RPC URL'))
    expect((await request('POST', BODY)).response).toEqual({ error: 'exit_check_unavailable' })
  })

  it('uses the DB result in local development when the DB limit succeeds', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 17 })
    const result = await request('POST', BODY, undefined, { remoteAddress: '127.0.0.1' })
    expect(result.status).toBe(429)
    expect(result.headers['Retry-After']).toBe('17')
    expect(readDirectSupplyExitQuote).not.toHaveBeenCalled()
  })

  it('allows a local development quote when the DB rate-limit check fails', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.mocked(checkRateLimit).mockRejectedValue(new Error('secret DB URL'))
    const result = await request('POST', BODY, undefined, { remoteAddress: '::1' })
    expect(result.status).toBe(200)
    expect(readDirectSupplyExitQuote).toHaveBeenCalledTimes(1)
  })

  it('enforces the local quota using the socket, ignoring spoofed forwarded IPs', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2031-01-01T00:00:00Z'))
    vi.mocked(checkRateLimit).mockRejectedValue(new Error('secret DB URL'))
    for (let index = 0; index < 12; index += 1) {
      const result = await request('POST', BODY, undefined, {
        remoteAddress: '127.0.0.1',
        forwardedFor: `203.0.113.${index + 1}`,
      })
      expect(result.status).toBe(200)
    }
    const denied = await request('POST', BODY, undefined, {
      remoteAddress: '127.0.0.1',
      forwardedFor: '198.51.100.1',
    })
    expect(denied.status).toBe(429)
    expect(denied.headers['Retry-After']).toBe('60')
    expect(readDirectSupplyExitQuote).toHaveBeenCalledTimes(12)

    vi.setSystemTime(new Date('2031-01-01T00:01:01Z'))
    expect((await request('POST', BODY, undefined, { remoteAddress: '127.0.0.1' })).status).toBe(
      200,
    )
  })

  it('fails closed outside local development even with a spoofed loopback header', async () => {
    vi.mocked(checkRateLimit).mockRejectedValue(new Error('secret DB URL'))
    vi.stubEnv('NODE_ENV', 'production')
    const production = await request('POST', BODY, undefined, { remoteAddress: '127.0.0.1' })
    expect(production.status).toBe(503)
    vi.stubEnv('NODE_ENV', 'development')
    const remote = await request('POST', BODY, undefined, {
      remoteAddress: '203.0.113.10',
      forwardedFor: '127.0.0.1',
    })
    expect(remote.status).toBe(503)
    expect(readDirectSupplyExitQuote).not.toHaveBeenCalled()
  })
})
