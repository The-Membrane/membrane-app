import { beforeEach, describe, expect, it, vi } from 'vitest'

import { readSusdsExitQuote, SUSDS_ROUTE_KEY, SUSDS_VAULT } from '@/lib/carry/susdsExitQuote'
import { checkRateLimit } from '@/lib/game/rateLimit'
import handler from '@/pages/api/carry/susds-exit'

vi.mock('@/lib/carry/susdsExitQuote', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/carry/susdsExitQuote')>()),
  readSusdsExitQuote: vi.fn(),
}))
vi.mock('@/lib/game/rateLimit', () => ({ checkRateLimit: vi.fn(), getClientIp: () => '127.0.0.1' }))

const HOLDER = '0x0000000000000000000000000000000000000001'
const BODY = {
  routeKey: SUSDS_ROUTE_KEY,
  destinationAddress: SUSDS_VAULT,
  owner: HOLDER,
  assetsRaw: '1000000000000000000',
  chainId: 1,
}

async function request(method: string, body: unknown, contentLength?: string) {
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
      headers: contentLength ? { 'content-length': contentLength } : {},
      socket: {},
    } as never,
    res as never,
  )
  return { headers, status, response }
}

describe('POST /api/carry/susds-exit', () => {
  beforeEach(() => {
    vi.mocked(checkRateLimit).mockReset().mockResolvedValue({ allowed: true })
    vi.mocked(readSusdsExitQuote)
      .mockReset()
      .mockResolvedValue({
        status: 'checked_at_finalized_block',
        simulation: { status: 'success' },
      } as never)
  })

  it('accepts a bounded exact target and disables cache', async () => {
    const result = await request('POST', BODY)
    expect(result.status).toBe(200)
    expect(result.headers['Cache-Control']).toBe('no-store')
    expect(vi.mocked(readSusdsExitQuote).mock.calls[0][1]).toMatchObject({
      routeKey: BODY.routeKey,
      destinationAddress: BODY.destinationAddress.toLowerCase(),
      owner: HOLDER,
      assetsRaw: BODY.assetsRaw,
    })
    expect(vi.mocked(checkRateLimit).mock.calls[0][0]).not.toContain(HOLDER)
  })

  it('rejects invalid and oversized requests before RPC', async () => {
    expect((await request('GET', BODY)).status).toBe(405)
    expect((await request('POST', { ...BODY, chainId: 10 })).status).toBe(400)
    expect((await request('POST', { ...BODY, assetsRaw: '0' })).status).toBe(400)
    expect((await request('POST', { ...BODY, extra: true })).status).toBe(400)
    expect((await request('POST', { ...BODY, destinationAddress: HOLDER })).status).toBe(404)
    expect((await request('POST', BODY, '9999')).status).toBe(413)
    expect(readSusdsExitQuote).not.toHaveBeenCalled()
  })

  it('rate limits and hides provider and credential errors', async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 30 })
    expect((await request('POST', BODY)).status).toBe(429)
    vi.mocked(checkRateLimit).mockRejectedValueOnce(new Error('secret DB URL'))
    expect((await request('POST', BODY)).response).toEqual({ error: 'exit_check_unavailable' })
    vi.mocked(readSusdsExitQuote).mockRejectedValue(new Error('secret RPC URL'))
    expect((await request('POST', BODY)).response).toEqual({ error: 'exit_check_unavailable' })
  })
})
