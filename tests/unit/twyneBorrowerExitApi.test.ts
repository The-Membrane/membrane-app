import { readFileSync } from 'node:fs'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { readTwyneBorrowerExit } from '@/lib/carry/twyneBorrowerExit'
import { TWYNE_PT_ROUTE } from '@/lib/carry/twynePtExit'
import { checkRateLimit } from '@/lib/game/rateLimit'
import handler, { parseTwyneBorrowerExitBody } from '@/pages/api/carry/twyne-borrower-exit'

vi.mock('@/lib/carry/twyneBorrowerExit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/carry/twyneBorrowerExit')>()),
  readTwyneBorrowerExit: vi.fn(),
}))
vi.mock('@/lib/game/rateLimit', () => ({ checkRateLimit: vi.fn(), getClientIp: () => '127.0.0.1' }))

const CV = '0x288b523115e674fa1ac1c2315ae2874065ee7699'
const BODY = { routeKey: TWYNE_PT_ROUTE, collateralVault: CV, requestedPtRaw: '100', chainId: 1 }

async function request(method: string, body: unknown) {
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
    { method, body, headers: {}, socket: { remoteAddress: '127.0.0.1' } } as never,
    res as never,
  )
  return { headers, status, response }
}

describe('POST /api/carry/twyne-borrower-exit', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.mocked(checkRateLimit).mockReset().mockResolvedValue({ allowed: true })
    vi.mocked(readTwyneBorrowerExit)
      .mockReset()
      .mockResolvedValue({
        status: 'observed',
        routeKey: TWYNE_PT_ROUTE,
        collateralVault: CV,
        borrower: '0x1111111111111111111111111111111111111111',
        requestedPtRaw: '100',
        evidence: { blockNumber: 26098984, borrowerKeyControl: 'unassessed' },
      } as never)
  })

  afterEach(() => vi.unstubAllEnvs())

  it('accepts exactly the 16 frozen collateral vaults, not arbitrary addresses', () => {
    const seed = JSON.parse(
      readFileSync('scripts/route-cohort/aug-2026-ab-vault-seed.json', 'utf8'),
    ) as { positions: Array<{ owner: string; routeIds: string[] }> }
    const frozen = [
      ...new Set(
        seed.positions.filter((p) => p.routeIds.includes(TWYNE_PT_ROUTE)).map((p) => p.owner),
      ),
    ]
    expect(frozen).toHaveLength(16)
    for (const collateralVault of frozen) {
      expect(parseTwyneBorrowerExitBody({ ...BODY, collateralVault })).toMatchObject({
        collateralVault,
      })
    }
    expect(
      parseTwyneBorrowerExitBody({
        ...BODY,
        collateralVault: '0x1111111111111111111111111111111111111111',
      }),
    ).toBeNull()
  })

  it('rejects unknown fields, route, chain, malformed amount and oversized bodies before RPC', async () => {
    expect((await request('GET', BODY)).status).toBe(405)
    expect((await request('POST', { ...BODY, routeKey: 'another route' })).status).toBe(400)
    expect((await request('POST', { ...BODY, chainId: 10 })).status).toBe(400)
    expect((await request('POST', { ...BODY, requestedPtRaw: '0' })).status).toBe(400)
    expect((await request('POST', { ...BODY, extra: true })).status).toBe(400)
    expect((await request('POST', { ...BODY, extra: 'x'.repeat(600) })).status).toBe(413)
    expect(readTwyneBorrowerExit).not.toHaveBeenCalled()
  })

  it('preserves reader evidence and labels only the simulated PT first leg', async () => {
    const result = await request('POST', BODY)
    expect(result.status).toBe(200)
    expect(result.headers['Cache-Control']).toBe('no-store')
    expect(result.response).toMatchObject({
      status: 'observed',
      evidence: { blockNumber: 26098984, borrowerKeyControl: 'unassessed' },
      scope: {
        simulatedPtFirstLegOnly: true,
        borrowerKeyControl: 'unassessed',
        finalUsdePayout: 'unassessed',
      },
    })
    expect(vi.mocked(readTwyneBorrowerExit).mock.calls[0][1]).toEqual({
      routeKey: TWYNE_PT_ROUTE,
      collateralVault: CV,
      requestedPtRaw: '100',
    })
    expect(vi.mocked(readTwyneBorrowerExit).mock.calls[0][2]).toMatchObject({
      collateralVaultImplementation: expect.any(String),
      factory: expect.any(String),
    })
  })

  it('returns bounded errors without leaking provider or limiter secrets', async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 30 })
    expect((await request('POST', BODY)).response).toEqual({
      error: 'rate_limited',
      retryAfterSeconds: 30,
    })
    vi.mocked(checkRateLimit).mockRejectedValueOnce(new Error('secret DB URL'))
    expect((await request('POST', BODY)).response).toEqual({ error: 'exit_check_unavailable' })
    vi.mocked(readTwyneBorrowerExit).mockRejectedValue(new Error('secret RPC URL'))
    expect((await request('POST', BODY)).response).toEqual({ error: 'exit_check_unavailable' })
  })
})
