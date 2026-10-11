import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { enqueue, statusForRequest } from '@/scripts/research/carry-morpho-requested-native.mjs'
import handler, { parseWatchRequest } from '@/pages/api/carry/holder-exit-watch'

vi.mock('@/scripts/research/carry-morpho-requested-native.mjs', () => ({
  enqueue: vi.fn(),
  statusForRequest: vi.fn(),
}))

const owner = '0x0000000000000000000000000000000000000001'
const destinationAddress = '0x0000000000000000000000000000000000000002'
const body = {
  action: 'enqueue',
  routeKey: 'morpho-route',
  destinationAddress,
  owner,
  assetsRaw: '1000000',
  horizonHours: 24,
}

async function request(
  value: unknown,
  options: {
    method?: string
    remote?: string
    origin?: string
    host?: string
    fetchSite?: string
    forwardedFor?: string
    forwardedHost?: string
    contentLength?: string
  } = {},
) {
  let status = 0
  let response: unknown
  const headers: Record<string, string> = {}
  const res = {
    setHeader: vi.fn((key: string, content: string) => {
      headers[key] = content
    }),
    status: vi.fn((code: number) => {
      status = code
      return res
    }),
    json: vi.fn((content: unknown) => {
      response = content
      return res
    }),
  }
  await handler(
    {
      method: options.method ?? 'POST',
      body: value,
      headers: {
        host: options.host ?? 'localhost:3005',
        ...(options.origin ? { origin: options.origin } : {}),
        ...(options.fetchSite ? { 'sec-fetch-site': options.fetchSite } : {}),
        ...(options.forwardedFor ? { 'x-forwarded-for': options.forwardedFor } : {}),
        ...(options.forwardedHost ? { 'x-forwarded-host': options.forwardedHost } : {}),
        ...(options.contentLength ? { 'content-length': options.contentLength } : {}),
      },
      socket: { remoteAddress: options.remote ?? '127.0.0.1' },
    } as never,
    res as never,
  )
  return { status, response, headers }
}

describe('local Morpho holder exit watch API', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('MEMBRANE_LOCAL_HOLDER_WATCH_ENABLED', undefined)
    vi.stubEnv('VERCEL', undefined)
    vi.stubEnv('VERCEL_ENV', undefined)
    vi.mocked(enqueue).mockReset().mockResolvedValue({ status: 'queued', id: 'opaque-id' })
    vi.mocked(statusForRequest)
      .mockReset()
      .mockResolvedValue({
        id: 'opaque-id',
        state: 'issued',
        horizons: [
          { horizonHours: 1, state: 'pending' },
          { horizonHours: 24, state: 'queued' },
        ],
        forecastValidated: false,
      })
  })
  afterEach(() => vi.unstubAllEnvs())

  it('rejects production loopback proxies, permits explicit local next-start, and refuses cloud markers', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    expect((await request(body, { forwardedFor: '127.0.0.1' })).status).toBe(403)
    expect(enqueue).not.toHaveBeenCalled()
    vi.stubEnv('MEMBRANE_LOCAL_HOLDER_WATCH_ENABLED', '1')
    expect((await request(body, { forwardedFor: '203.0.113.4' })).status).toBe(200)
    vi.stubEnv('VERCEL', '1')
    expect((await request(body)).status).toBe(403)
    vi.stubEnv('VERCEL', undefined)
    vi.stubEnv('VERCEL_ENV', 'production')
    expect((await request(body)).status).toBe(403)
    expect(enqueue).toHaveBeenCalledTimes(1)
  })

  it('accepts only exact bounded owner/Q input and normalizes addresses', async () => {
    expect(
      parseWatchRequest({ ...body, owner: owner.toUpperCase().replace('0X', '0x') }),
    ).toMatchObject({ owner })
    expect((await request({ ...body, assetsRaw: '0' })).status).toBe(400)
    expect((await request({ ...body, assetsRaw: 1 })).status).toBe(400)
    expect((await request({ ...body, horizonHours: 2 })).status).toBe(400)
    expect((await request({ ...body, extra: 'secret' })).status).toBe(400)
    expect((await request(body, { contentLength: '9999' })).status).toBe(413)
    expect((await request(body, { method: 'GET' })).status).toBe(405)
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('rejects remote sockets and cross-origin browser calls, ignoring forwarded headers', async () => {
    expect((await request(body, { remote: '203.0.113.4', forwardedFor: '127.0.0.1' })).status).toBe(
      403,
    )
    expect((await request(body, { origin: 'https://attacker.example' })).status).toBe(403)
    expect((await request(body, { fetchSite: 'cross-site' })).status).toBe(403)
    expect(
      (
        await request(body, {
          host: 'public.example',
          forwardedFor: '127.0.0.1',
          forwardedHost: 'localhost:3005',
        })
      ).status,
    ).toBe(403)
    expect((await request(body, { host: 'localhost.evil.example' })).status).toBe(403)
    expect((await request(body, { host: '[::1]:3005', remote: '::1' })).status).toBe(200)
    expect(
      (await request(body, { origin: 'http://localhost:3005', forwardedFor: '203.0.113.4' }))
        .status,
    ).toBe(200)
    expect(enqueue).toHaveBeenCalledTimes(2)
  })

  it('returns opaque queue identity and selected horizon without raw owner, Q, or providers', async () => {
    const queued = await request(body)
    expect(queued.status).toBe(200)
    expect(queued.headers['Cache-Control']).toBe('no-store')
    expect(queued.response).toEqual({ id: 'opaque-id', state: 'queued', forecastValidated: false })
    expect(enqueue).toHaveBeenCalledWith({
      routeKey: body.routeKey,
      destinationAddress,
      owner,
      assetsRaw: body.assetsRaw,
    })
    const status = await request({ ...body, action: 'status' })
    expect(status.response).toEqual({
      id: 'opaque-id',
      state: 'issued',
      horizons: [{ horizonHours: 24, state: 'queued' }],
      forecastValidated: false,
    })
    expect(JSON.stringify(status.response)).not.toContain(owner)
    expect(JSON.stringify(status.response)).not.toContain(body.assetsRaw)
  })

  it('fails closed without exposing native record or RPC errors', async () => {
    vi.mocked(enqueue).mockRejectedValueOnce(Error('requested_native_active_limit'))
    expect((await request(body)).response).toEqual({ error: 'watch_limit_reached' })
    vi.mocked(enqueue).mockImplementationOnce(() => {
      throw Error('requested_holder_subject_unknown')
    })
    expect((await request(body)).response).toEqual({ error: 'invalid_watch_request' })
    vi.mocked(enqueue).mockImplementationOnce(() => {
      throw Error('secret RPC URL and owner')
    })
    expect((await request(body)).response).toEqual({ error: 'watch_unavailable' })
  })
})
