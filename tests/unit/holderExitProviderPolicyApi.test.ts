import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { createPublicClient, http } from 'viem'
import { readHolderExitAssessment } from '@/lib/carry/holderExitAssessment'
import { DIRECT_SUPPLY_MARKETS } from '@/lib/carry/directSupplyMarketConstants'
import handler from '@/pages/api/carry/holder-exit-assessment'
const state = vi.hoisted(() => ({ pool: '', policy: null as any, envMissing: false }))
vi.mock('@/scripts/lib/venue-reads.mjs', () => ({
  readEnv: () => {
    if (state.envMissing) throw Error('missing local env')
    return { get: (key: string) => (key === 'RECORDER_RPC_URLS' ? state.pool : undefined) }
  },
}))
vi.mock('@/scripts/research/carry-depth-quote-archive.mjs', async (original) => ({
  ...(await original<typeof import('@/scripts/research/carry-depth-quote-archive.mjs')>()),
  readProviderPolicy: () => state.policy,
}))
vi.mock('@/lib/carry/holderExitAssessment', async (original) => ({
  ...(await original<typeof import('@/lib/carry/holderExitAssessment')>()),
  readHolderExitAssessment: vi.fn(),
}))
vi.mock('viem', async (original) => ({
  ...(await original<typeof import('viem')>()),
  createPublicClient: vi.fn(() => ({})),
  http: vi.fn((url, options) => ({ url, options })),
}))
vi.mock('@/lib/game/rateLimit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  getClientIp: () => '127.0.0.1',
}))
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const first = 'https://one.example/key-one',
  second = 'https://two.example/key-two'
const provider = (url: string, alias: string) => ({
  alias,
  hostSha256: sha(new URL(url).hostname),
  uriSha256: sha(url),
})
beforeEach(() => {
  vi.clearAllMocks()
  state.envMissing = false
  vi.mocked(readHolderExitAssessment).mockRejectedValue(Error('offline unavailable'))
  state.pool = 'https://unapproved.example/ignored,' + first + ',' + second
  state.policy = {
    schema: 'historical_depth_quote_provider_policy_v1',
    policyId: 'configured-c1-c3-v1',
    status: 'active',
    providers: [provider(first, 'C1'), provider(second, 'C3')],
  }
  vi.stubEnv('RECORDER_RPC_URL', 'https://unapproved-process.example/ignored')
  vi.stubEnv('RECORDER_RPC_URLS', 'https://unapproved-process.example/ignored')
})
afterEach(() => vi.unstubAllEnvs())
async function request() {
  let code = 0,
    body: unknown
  const market = DIRECT_SUPPLY_MARKETS.aaveV3Usdc
  const res = {
    setHeader: vi.fn(),
    status: (value: number) => {
      code = value
      return res
    },
    json: (value: unknown) => {
      body = value
      return res
    },
  }
  await handler(
    {
      method: 'POST',
      headers: {},
      body: {
        routeKey: market.routeKey,
        destinationAddress: market.destination,
        owner: '0x' + '1'.repeat(40),
        assetsRaw: '1000000',
        horizonHours: 24,
      },
      socket: { remoteAddress: '127.0.0.1' },
    } as never,
    res as never,
  )
  return { code, body }
}
it('actual URI/host policy resolver selects exact approved pair with8s/retry0 and no environment mutation', async () => {
  const before = process.env.RECORDER_RPC_URL
  expect(await request()).toEqual({
    code: 503,
    body: { error: 'holder_exit_assessment_unavailable' },
  })
  expect(vi.mocked(http).mock.calls).toEqual([
    [first, { timeout: 8000, retryCount: 0 }],
    [second, { timeout: 8000, retryCount: 0 }],
  ])
  expect(createPublicClient).toHaveBeenCalledTimes(2)
  expect(readHolderExitAssessment).toHaveBeenCalledTimes(2)
  expect(process.env.RECORDER_RPC_URL).toBe(before)
})
it.each(['RECORDER_RPC_URLS', 'RECORDER_RPC_URL'] as const)(
  'missing local file uses approved process %s without weakening exact policy binding',
  async (key) => {
    state.envMissing = true
    vi.stubEnv('RECORDER_RPC_URLS', '')
    vi.stubEnv(key, first + ',' + second)
    const before = process.env[key]
    expect((await request()).code).toBe(503)
    expect(vi.mocked(http).mock.calls).toEqual([
      [first, { timeout: 8000, retryCount: 0 }],
      [second, { timeout: 8000, retryCount: 0 }],
    ])
    expect(createPublicClient).toHaveBeenCalledTimes(2)
    expect(process.env[key]).toBe(before)
  },
)
it('missing local file with unapproved process pool fails before creating clients', async () => {
  state.envMissing = true
  expect(await request()).toEqual({
    code: 503,
    body: { error: 'holder_exit_assessment_unavailable' },
  })
  expect(createPublicClient).not.toHaveBeenCalled()
  expect(http).not.toHaveBeenCalled()
  expect(readHolderExitAssessment).not.toHaveBeenCalled()
})
it.each(['pending', 'inactive', 'malformed', 'missing', 'duplicate', 'http'] as const)(
  'invalid %s binding fails closed before any client or RPC',
  async (kind) => {
    if (kind === 'pending' || kind === 'inactive') state.policy.status = kind
    if (kind === 'malformed') state.policy.providers[0].uriSha256 = ['fake']
    if (kind === 'missing') state.pool = first
    if (kind === 'duplicate') state.policy.providers[1] = provider(first, 'C3')
    if (kind === 'http') {
      state.pool = state.pool.replace(second, 'http://two.example/key-two')
      state.policy.providers[1] = provider('http://two.example/key-two', 'C3')
    }
    expect(await request()).toEqual({
      code: 503,
      body: { error: 'holder_exit_assessment_unavailable' },
    })
    expect(createPublicClient).not.toHaveBeenCalled()
    expect(http).not.toHaveBeenCalled()
    expect(readHolderExitAssessment).not.toHaveBeenCalled()
  },
)
