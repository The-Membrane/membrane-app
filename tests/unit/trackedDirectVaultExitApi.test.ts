import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { readTrackedDirectVaultExit } from '@/lib/carry/trackedDirectVaultExit'
import { checkRateLimit } from '@/lib/game/rateLimit'
import handler, {
  parseTrackedDirectVaultExitRequest,
} from '@/pages/api/carry/tracked-direct-vault-exit'

vi.mock('@/lib/carry/trackedDirectVaultExit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/carry/trackedDirectVaultExit')>()),
  readTrackedDirectVaultExit: vi.fn(),
}))
vi.mock('@/lib/game/rateLimit', () => ({ checkRateLimit: vi.fn(), getClientIp: () => '127.0.0.1' }))

const HOLDER = '0x0000000000000000000000000000000000000001'
const BODY = {
  routeKey: 'USDS → StUsds [USDS]',
  destinationAddress: '0x99cd4ec3f88a45940936f469e4bb72a2a701eeb9',
  owner: HOLDER,
  assetsRaw: '1000000000000000000',
  chainId: 1,
}

async function request(
  method: string,
  body: unknown,
  contentLength?: string,
  remoteAddress = '127.0.0.1',
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
      headers: contentLength ? { 'content-length': contentLength } : {},
      socket: { remoteAddress },
    } as never,
    res as never,
  )
  return { headers, status, response }
}

describe('POST /api/carry/tracked-direct-vault-exit', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('CARRY_FORECAST_STORAGE', 'neon')
    vi.mocked(checkRateLimit).mockReset().mockResolvedValue({ allowed: true })
    vi.mocked(readTrackedDirectVaultExit)
      .mockReset()
      .mockResolvedValue({
        status: 'checked_at_finalized_block',
        simulation: { status: 'success' },
      } as never)
  })

  afterEach(() => vi.unstubAllEnvs())

  it('accepts a bounded exact target and disables caching', async () => {
    const result = await request('POST', BODY)
    expect(result.status).toBe(200)
    expect(result.headers['Cache-Control']).toBe('no-store')
    expect(vi.mocked(readTrackedDirectVaultExit).mock.calls[0][1]).toMatchObject({
      routeKey: BODY.routeKey,
      destinationAddress: BODY.destinationAddress,
      owner: HOLDER,
      assetsRaw: BODY.assetsRaw,
    })
    expect(vi.mocked(checkRateLimit).mock.calls[0][0]).not.toContain(HOLDER)
  })

  it('accepts the USDT bridge only as an explicitly USDC-denominated first-leg check', async () => {
    const bridge = {
      ...BODY,
      routeKey: 'USDC → FluidBridgeAggregatorProxy [USDC]',
      destinationAddress: '0x273da948aca9261043fbdb2a857bc255ecc29012',
      assetsRaw: '1000000',
    }
    expect((await request('POST', bridge)).status).toBe(200)
    expect(vi.mocked(readTrackedDirectVaultExit).mock.calls[0][1]).toMatchObject({
      routeKey: bridge.routeKey,
      destinationAddress: bridge.destinationAddress,
      assetsRaw: bridge.assetsRaw,
      owner: HOLDER,
    })
    vi.mocked(readTrackedDirectVaultExit).mockClear()
    const firstLeg = { ...bridge, routeKey: 'USDT → FluidBridgeAggregatorProxy [USDC]' }
    expect((await request('POST', firstLeg)).status).toBe(400)
    expect(readTrackedDirectVaultExit).not.toHaveBeenCalled()
    expect((await request('POST', { ...firstLeg, assetUnit: 'USDT' })).status).toBe(400)
    expect((await request('POST', { ...firstLeg, assetUnit: 'USDC' })).status).toBe(200)
    expect(vi.mocked(readTrackedDirectVaultExit).mock.calls[0][1]).toMatchObject({
      routeKey: firstLeg.routeKey,
      assetsRaw: '1000000',
      assetUnit: 'USDC',
    })
  })

  it('rejects mismatched route and malformed requests before RPC', async () => {
    expect(parseTrackedDirectVaultExitRequest({ ...BODY, owner: HOLDER.toUpperCase() })).toBeNull()
    expect((await request('GET', BODY)).status).toBe(405)
    expect((await request('POST', { ...BODY, chainId: 10 })).status).toBe(400)
    expect((await request('POST', { ...BODY, assetsRaw: '0' })).status).toBe(400)
    expect((await request('POST', { ...BODY, extra: true })).status).toBe(400)
    expect((await request('POST', { ...BODY, destinationAddress: HOLDER })).status).toBe(404)
    expect((await request('POST', BODY, '9999')).status).toBe(413)
    expect(readTrackedDirectVaultExit).not.toHaveBeenCalled()
  })

  it('hides rate-limit and provider details', async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 30 })
    expect((await request('POST', BODY)).status).toBe(429)
    vi.mocked(checkRateLimit).mockRejectedValueOnce(new Error('secret DB URL'))
    expect((await request('POST', BODY)).response).toEqual({ error: 'exit_check_unavailable' })
    vi.mocked(readTrackedDirectVaultExit).mockRejectedValue(new Error('secret RPC URL'))
    expect((await request('POST', BODY)).response).toEqual({ error: 'exit_check_unavailable' })
  })

  it('uses a bounded local limiter without DB when storage is local', async () => {
    vi.stubEnv('CARRY_FORECAST_STORAGE', 'local')
    vi.mocked(checkRateLimit).mockRejectedValue(new Error('Neon unreachable'))
    for (let index = 0; index < 12; index += 1) {
      expect((await request('POST', BODY, undefined, '127.0.0.212')).status).toBe(200)
    }
    const thirteenth = await request('POST', BODY, undefined, '127.0.0.212')
    expect(thirteenth.status).toBe(429)
    expect(Number(thirteenth.headers['Retry-After'])).toBeGreaterThan(0)
    expect(checkRateLimit).not.toHaveBeenCalled()
    expect((await request('POST', BODY, undefined, '127.0.0.213')).status).toBe(200)
  })
})
