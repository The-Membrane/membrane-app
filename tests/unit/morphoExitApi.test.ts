import { beforeEach, describe, expect, it, vi } from 'vitest'

import morphoIdentities from '@/lib/carry/morpho-v2-asset-identities.json'
import { readMorphoExitQuote } from '@/lib/carry/morphoExitQuote'
import { checkRateLimit } from '@/lib/game/rateLimit'
import handler from '@/pages/api/carry/morpho-exit'
import seed from '@/scripts/route-cohort/aug-2026-ab-vault-seed.json'

vi.mock('@/lib/carry/morphoExitQuote', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/carry/morphoExitQuote')>()),
  readMorphoExitQuote: vi.fn(),
}))
vi.mock('@/lib/game/rateLimit', () => ({ checkRateLimit: vi.fn(), getClientIp: () => '127.0.0.1' }))

const VAULT = morphoIdentities.entries[0].vault
const ROUTE = seed.positions.find((entry) => entry.vault.toLowerCase() === VAULT)!.routeIds[0]
const OWNER = '0x0000000000000000000000000000000000000001'
const BODY = {
  routeKey: ROUTE,
  destinationAddress: VAULT,
  owner: OWNER,
  assetsRaw: '1000000',
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

describe('POST /api/carry/morpho-exit', () => {
  beforeEach(() => {
    vi.mocked(checkRateLimit).mockReset().mockResolvedValue({ allowed: true })
    vi.mocked(readMorphoExitQuote)
      .mockReset()
      .mockResolvedValue({
        status: 'checked_at_finalized_block',
        simulation: { status: 'success' },
      } as never)
  })

  it('checks the exact target, limits the request, and keeps the holder out of logs and cache', async () => {
    const result = await request('POST', BODY)
    expect(result.status).toBe(200)
    expect(result.headers['Cache-Control']).toBe('no-store')
    expect(result.response).toEqual({
      status: 'checked_at_finalized_block',
      simulation: { status: 'success' },
    })
    expect(vi.mocked(readMorphoExitQuote).mock.calls[0][1]).toMatchObject({
      routeKey: ROUTE,
      destinationAddress: VAULT,
      owner: OWNER,
      assetsRaw: '1000000',
    })
    expect(vi.mocked(checkRateLimit).mock.calls[0][0]).not.toContain(OWNER)
  })

  it('strips private native holder observations while preserving every public quote fact', async () => {
    const publicQuote = {
      status: 'checked_at_finalized_block',
      source: { blockNumber: 1, blockHash: 'source', blockTime: 'clock' },
      position: { sharesRaw: '3', previewRedeemAssetsRaw: '5' },
      simulation: { status: 'success' },
    }
    vi.mocked(readMorphoExitQuote).mockResolvedValue({
      ...publicQuote,
      morphoHolderPositionObservation: { traces: ['private_raw_trace'] },
    } as never)
    const result = await request('POST', BODY)
    expect(result.status).toBe(200)
    expect(result.response).toEqual(publicQuote)
    expect(JSON.stringify(result.response)).not.toContain('private_raw_trace')
  })

  it('rejects malformed, unknown, wrong-chain, and oversized requests before RPC', async () => {
    expect((await request('GET', BODY)).status).toBe(405)
    expect((await request('POST', { ...BODY, chainId: 10 })).status).toBe(400)
    expect((await request('POST', { ...BODY, assetsRaw: '0' })).status).toBe(400)
    expect((await request('POST', { ...BODY, assetsRaw: '1e18' })).status).toBe(400)
    expect((await request('POST', { ...BODY, destinationAddress: OWNER })).status).toBe(404)
    expect((await request('POST', BODY, '9999')).status).toBe(413)
    expect(readMorphoExitQuote).not.toHaveBeenCalled()
  })

  it('returns bounded failures for rate limiting and provider errors', async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 30 })
    const limited = await request('POST', BODY)
    expect(limited.status).toBe(429)
    expect(limited.headers['Retry-After']).toBe('30')
    vi.mocked(checkRateLimit).mockRejectedValueOnce(new Error('secret DB URL'))
    expect((await request('POST', BODY)).response).toEqual({ error: 'exit_check_unavailable' })
    vi.mocked(readMorphoExitQuote).mockRejectedValue(new Error('secret RPC URL'))
    expect((await request('POST', BODY)).response).toEqual({ error: 'exit_check_unavailable' })
  })
})
