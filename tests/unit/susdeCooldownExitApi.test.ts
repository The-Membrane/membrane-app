import { beforeEach, describe, expect, it, vi } from 'vitest'

import { readSusdeCooldownExitQuote } from '@/lib/carry/susdeCooldownExitQuote'
import { checkRateLimit } from '@/lib/game/rateLimit'
import handler from '@/pages/api/carry/susde-cooldown-exit'

vi.mock('@/lib/carry/susdeCooldownExitQuote', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/carry/susdeCooldownExitQuote')>()),
  readSusdeCooldownExitQuote: vi.fn(),
}))
vi.mock('@/lib/game/rateLimit', () => ({ checkRateLimit: vi.fn(), getClientIp: () => '127.0.0.1' }))

const HOLDER = '0x0000000000000000000000000000000000000001'
const BODY = {
  routeKey: 'USDe → Staked USDe [USDe]',
  destinationAddress: '0x9D39A5DE30e57443BfF2A8307A4256c8797A3497',
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

describe('POST /api/carry/susde-cooldown-exit', () => {
  beforeEach(() => {
    vi.mocked(checkRateLimit).mockReset().mockResolvedValue({ allowed: true })
    vi.mocked(readSusdeCooldownExitQuote)
      .mockReset()
      .mockResolvedValue({
        status: 'checked_at_finalized_block',
        canInitiateNow: true,
        canClaimNow: false,
      } as never)
  })

  it('accepts a bounded exact target with no cache', async () => {
    const result = await request('POST', BODY)
    expect(result.status).toBe(200)
    expect(result.headers['Cache-Control']).toBe('no-store')
    expect(vi.mocked(readSusdeCooldownExitQuote).mock.calls[0][1]).toMatchObject({
      routeKey: BODY.routeKey,
      destinationAddress: BODY.destinationAddress.toLowerCase(),
      owner: HOLDER,
      assetsRaw: BODY.assetsRaw,
    })
    expect(vi.mocked(checkRateLimit).mock.calls[0][0]).not.toContain(HOLDER)
  })

  it('rejects invalid or oversized requests before an RPC', async () => {
    expect((await request('GET', BODY)).status).toBe(405)
    expect((await request('POST', { ...BODY, chainId: 10 })).status).toBe(400)
    expect((await request('POST', { ...BODY, assetsRaw: '0' })).status).toBe(400)
    expect((await request('POST', { ...BODY, extra: true })).status).toBe(400)
    expect((await request('POST', { ...BODY, destinationAddress: HOLDER })).status).toBe(404)
    expect((await request('POST', BODY, '9999')).status).toBe(413)
    expect(readSusdeCooldownExitQuote).not.toHaveBeenCalled()
  })

  it('rate limits and hides provider errors', async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 30 })
    expect((await request('POST', BODY)).status).toBe(429)
    vi.mocked(checkRateLimit).mockRejectedValueOnce(new Error('secret DB URL'))
    expect((await request('POST', BODY)).response).toEqual({ error: 'exit_check_unavailable' })
    vi.mocked(readSusdeCooldownExitQuote).mockRejectedValue(new Error('secret RPC URL'))
    expect((await request('POST', BODY)).response).toEqual({ error: 'exit_check_unavailable' })
  })
})
