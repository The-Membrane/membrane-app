import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { readSghoExit } from '@/lib/carry/sghoExit'
import { checkRateLimit } from '@/lib/game/rateLimit'
import handler from '@/pages/api/carry/sgho-exit'

vi.mock('@/lib/carry/sghoExit', () => ({ readSghoExit: vi.fn() }))
vi.mock('@/lib/game/rateLimit', () => ({ checkRateLimit: vi.fn(), getClientIp: () => '127.0.0.1' }))

const ADDRESS = '0x0000000000000000000000000000000000000001'
const BODY = { address: ADDRESS, assetsRaw: '1000000000000000000', chainId: 1 }

async function request(
  method: string,
  body: unknown,
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
      headers: options.forwardedFor ? { 'x-forwarded-for': options.forwardedFor } : {},
      socket: { remoteAddress: options.remoteAddress },
    } as never,
    res as never,
  )
  return { headers, status, response }
}

describe('POST /api/carry/sgho-exit', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.mocked(checkRateLimit).mockReset().mockResolvedValue({ allowed: true })
    vi.mocked(readSghoExit)
      .mockReset()
      .mockResolvedValue({ status: 'ok', position: { sharesRaw: '1' } } as never)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  it('accepts only a bounded Ethereum wallet POST and never caches or echoes the address', async () => {
    const result = await request('POST', BODY)
    expect(result.status).toBe(200)
    expect(result.headers['Cache-Control']).toBe('no-store')
    expect(result.response).toEqual({ status: 'ok', position: { sharesRaw: '1' } })
    expect(JSON.stringify(result.response)).not.toContain(ADDRESS)
    expect(vi.mocked(checkRateLimit).mock.calls[0][0]).not.toContain(ADDRESS)
    expect(vi.mocked(readSghoExit).mock.calls[0][1]).toBe(ADDRESS)
    expect(vi.mocked(readSghoExit).mock.calls[0][2]).toBe(BODY.assetsRaw)
  })

  it('rejects GET, bad address, wrong chain, and oversized payload before any RPC read', async () => {
    expect((await request('GET', BODY)).status).toBe(405)
    expect((await request('POST', { ...BODY, address: 'not-an-address' })).status).toBe(400)
    expect((await request('POST', { ...BODY, chainId: 10 })).status).toBe(400)
    expect((await request('POST', { ...BODY, assetsRaw: '0' })).status).toBe(400)
    expect((await request('POST', { ...BODY, padding: 'x'.repeat(300) })).status).toBe(413)
    expect(readSghoExit).not.toHaveBeenCalled()
  })

  it('returns bounded failure on rate limit, limiter outage, or RPC failure', async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 30 })
    const limited = await request('POST', BODY)
    expect(limited.status).toBe(429)
    expect(limited.headers['Retry-After']).toBe('30')
    vi.mocked(checkRateLimit).mockRejectedValueOnce(new Error('secret DB URL'))
    expect((await request('POST', BODY)).response).toEqual({
      error: 'exit_check_unavailable',
    })
    vi.mocked(readSghoExit).mockRejectedValue(new Error('secret RPC URL'))
    expect((await request('POST', BODY)).response).toEqual({
      error: 'exit_check_unavailable',
    })
  })

  it('uses the DB limiter result in local development when available', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 17 })
    const result = await request('POST', BODY, { remoteAddress: '127.0.0.1' })
    expect(result.status).toBe(429)
    expect(result.headers['Retry-After']).toBe('17')
    expect(readSghoExit).not.toHaveBeenCalled()
  })

  it('allows a loopback development quote during a DB limiter outage', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.mocked(checkRateLimit).mockRejectedValue(new Error('secret DB URL'))
    const result = await request('POST', BODY, { remoteAddress: '::1' })
    expect(result.status).toBe(200)
    expect(readSghoExit).toHaveBeenCalledTimes(1)
  })

  it('enforces the local quota by socket address despite spoofed forwarded IPs', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2031-01-01T00:00:00Z'))
    vi.mocked(checkRateLimit).mockRejectedValue(new Error('secret DB URL'))
    for (let index = 0; index < 12; index += 1) {
      expect(
        (
          await request('POST', BODY, {
            remoteAddress: '127.0.0.1',
            forwardedFor: `203.0.113.${index + 1}`,
          })
        ).status,
      ).toBe(200)
    }
    const denied = await request('POST', BODY, {
      remoteAddress: '127.0.0.1',
      forwardedFor: '198.51.100.1',
    })
    expect(denied.status).toBe(429)
    expect(denied.headers['Retry-After']).toBe('60')
    expect(readSghoExit).toHaveBeenCalledTimes(12)

    vi.setSystemTime(new Date('2031-01-01T00:01:01Z'))
    expect((await request('POST', BODY, { remoteAddress: '127.0.0.1' })).status).toBe(200)
  })

  it('fails closed in production and for non-loopback sockets', async () => {
    vi.mocked(checkRateLimit).mockRejectedValue(new Error('secret DB URL'))
    vi.stubEnv('NODE_ENV', 'production')
    expect((await request('POST', BODY, { remoteAddress: '127.0.0.1' })).status).toBe(503)
    vi.stubEnv('NODE_ENV', 'development')
    expect(
      (
        await request('POST', BODY, {
          remoteAddress: '203.0.113.10',
          forwardedFor: '127.0.0.1',
        })
      ).status,
    ).toBe(503)
    expect(readSghoExit).not.toHaveBeenCalled()
  })
})
