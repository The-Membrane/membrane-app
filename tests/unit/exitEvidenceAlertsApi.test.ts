import { beforeEach, describe, expect, it, vi } from 'vitest'

import { db } from '@/db'
import { checkRateLimit } from '@/lib/game/rateLimit'
import handler, { parseExitEvidenceQuery } from '@/pages/api/carry/exit-evidence-alerts'

vi.mock('@/db', () => ({ db: { execute: vi.fn() } }))
vi.mock('@/lib/game/rateLimit', () => ({ checkRateLimit: vi.fn(), getClientIp: () => '127.0.0.1' }))

async function request(
  method: string,
  query: Record<string, unknown> = {},
  url = '/api/carry/exit-evidence-alerts',
) {
  const headers: Record<string, string> = {}
  let status = 0
  let response: unknown
  const res = {
    setHeader: vi.fn((key: string, value: string) => {
      headers[key] = value
    }),
    status: vi.fn((code: number) => {
      status = code
      return res
    }),
    json: vi.fn((value: unknown) => {
      response = value
      return res
    }),
  }
  await handler({ method, query, url, headers: {}, socket: {} } as never, res as never)
  return { headers, status, response }
}

describe('GET /api/carry/exit-evidence-alerts', () => {
  beforeEach(() => {
    vi.mocked(checkRateLimit).mockReset().mockResolvedValue({ allowed: true })
    vi.mocked(db.execute)
      .mockReset()
      .mockResolvedValue({ rows: [] } as never)
  })

  it('accepts only bounded paired filters', () => {
    expect(parseExitEvidenceQuery(null as never)).toBeNull()
    expect(parseExitEvidenceQuery({})).toEqual({
      routeKey: undefined,
      destination: undefined,
      holder: undefined,
      assetsRaw: undefined,
      limit: 10,
    })
    expect(parseExitEvidenceQuery({ owner: `0x${'a'.repeat(40)}` })).toBeNull()
    expect(parseExitEvidenceQuery({ routeKey: 'x' })).toBeNull()
    expect(parseExitEvidenceQuery({ limit: '21' })).toBeNull()
    expect(parseExitEvidenceQuery({ limit: ['1', '2'] })).toBeNull()
    expect(parseExitEvidenceQuery({ chainId: '10' })).toBeNull()
    expect(parseExitEvidenceQuery({ unknown: 'x' })).toBeNull()
  })

  it('returns a no-forecast bounded feed with four fixed DB reads', async () => {
    const response = await request('GET')
    expect(response.status).toBe(200)
    expect(response.headers['Cache-Control']).toBe('no-store')
    expect(response.response).toMatchObject({
      status: 'bounded_sampled_exit_evidence',
      alerts: [],
      futureExitForecast: false,
      likelyDuration: 'unavailable',
    })
    expect(db.execute).toHaveBeenCalledTimes(4)
  })

  it('rejects method, malformed input, size, and rate limit before database reads', async () => {
    expect((await request('POST')).status).toBe(405)
    expect((await request('GET', { limit: '999' })).status).toBe(400)
    expect((await request('GET', {}, 'x'.repeat(769))).status).toBe(413)
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 20 })
    expect((await request('GET')).status).toBe(429)
    expect(db.execute).not.toHaveBeenCalled()
  })

  it('sanitizes database errors', async () => {
    vi.mocked(db.execute).mockRejectedValue(new Error('secret database URL'))
    expect((await request('GET')).response).toEqual({ error: 'exit_evidence_unavailable' })
  })
})
