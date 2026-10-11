import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DIRECT_SUPPLY_MARKETS } from '@/lib/carry/directSupplyMarketConstants'
import { readHolderExitAssessment } from '@/lib/carry/holderExitAssessment'
import { buildHolderExitCapacityQuote } from '@/lib/carry/holderExitCapacity'
import { selectedCometWithdrawFacts } from '@/lib/carry/cometHolderCapacityProjection'
import { checkRateLimit } from '@/lib/game/rateLimit'
import handler, { sameHolderExitAssessment } from '@/pages/api/carry/holder-exit-assessment'
vi.mock('@/lib/carry/holderExitAssessment', async (original) => ({
  ...(await original<typeof import('@/lib/carry/holderExitAssessment')>()),
  readHolderExitAssessment: vi.fn(),
}))
vi.mock('@/scripts/research/carry-depth-quote-archive.mjs', () => ({
  readProviderPolicy: () => ({ status: 'active' }),
  configuredProviders: () => [{ url: 'https://first.example' }, { url: 'https://second.example' }],
}))
vi.mock('@/lib/game/rateLimit', () => ({ checkRateLimit: vi.fn(), getClientIp: () => '127.0.0.1' }))
const m = DIRECT_SUPPLY_MARKETS.compoundV3Usdc,
  owner = `0x${'b'.repeat(40)}`,
  NOW = Date.parse('2026-10-08T12:00:00.000Z')
const source = {
  chainId: 1 as const,
  blockNumber: 26190000,
  blockHash: `0x${'a'.repeat(64)}`,
  blockTime: new Date(NOW - 60000).toISOString(),
  finalized: true as const,
}
const body = {
  routeKey: m.routeKey,
  destinationAddress: m.destination,
  owner,
  assetsRaw: '1000000',
  horizonHours: 48,
  chainId: 1,
  forecastSourceReference: {
    blockNumber: source.blockNumber,
    blockHash: source.blockHash,
    blockTime: source.blockTime,
  },
}
function assessment(pause: unknown) {
  const a: any = {
    status: 'assessed',
    routeKey: m.routeKey,
    destinationAddress: m.destination,
    owner,
    request: { assetsRaw: body.assetsRaw, assetAddress: m.underlying, horizonHours: 48 },
    source: { ...source, originValidation: 'single_provider' },
    stages: [
      {
        name: 'withdrawal',
        status: 'simulated',
        relatedToRequest: true,
        assetAddress: m.underlying,
        amountRaw: body.assetsRaw,
      },
    ],
    finalPayout: { status: 'simulated', assetAddress: m.underlying, amountRaw: body.assetsRaw },
    forecast: {
      status: 'unvalidated',
      futureExit: null,
      exitDurationHours: null,
      prospectiveValidated: false,
    },
    cometFacts: {
      status: 'comet_withdraw_getter_observed',
      routeKey: m.routeKey,
      destination: m.destination.toLowerCase(),
      asset: m.underlying.toLowerCase(),
      assetDecimals: 6,
      source,
      withdrawalsPaused: pause,
    },
  }
  a.capacityQuote = buildHolderExitCapacityQuote(
    a,
    {
      entitlementRaw: '5000000',
      quotedMaxWithdrawRaw: null,
      quotedMaxWithdrawStatus: 'not_read',
      effectiveLimitRaw: null,
      withdrawalsPaused: null,
    },
    NOW,
  )
  return a
}
async function request() {
  let code = 0,
    value: any
  await handler(
    { method: 'POST', body, headers: {}, socket: { remoteAddress: '127.0.0.1' } } as any,
    {
      setHeader() {},
      status(n: number) {
        code = n
        return this
      },
      json(v: any) {
        value = v
        return this
      },
    } as any,
  )
  return { code, value }
}
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  vi.stubEnv('NODE_ENV', 'development')
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true })
  vi.mocked(readHolderExitAssessment).mockReset()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})
describe('Comet optional source facts in actual holder API', () => {
  it.each([
    [false, false],
    [true, true],
    [false, true],
    [null, false],
  ])('preserves core execution and E when pause origins are %s / %s', async (first, second) => {
    const a = assessment(first),
      b = assessment(second)
    expect(sameHolderExitAssessment(a, b)).toBe(true)
    vi.mocked(readHolderExitAssessment).mockResolvedValueOnce(a).mockResolvedValueOnce(b)
    const r = await request()
    expect(r.code).toBe(200)
    expect(r.value.capacityAgreement.quote.entitlementRaw).toBe('5000000')
    expect(r.value.executionAgreement.simulations).toHaveLength(2)
    const expected = {
      routeKey: m.routeKey,
      destination: m.destination.toLowerCase(),
      asset: m.underlying.toLowerCase(),
      assetDecimals: 6,
      source,
      asOfMs: NOW,
    }
    const agreed = selectedCometWithdrawFacts(r.value.cometFactsAgreement, expected)!
    expect(agreed.facts.withdrawalsPaused).toBe(first === second ? first : null)
    expect(
      vi
        .mocked(readHolderExitAssessment)
        .mock.calls.every(
          (c) =>
            c[2]?.includeCapacityFacts === true &&
            c[2]?.atomicFinalizedBlock?.blockHash === source.blockHash,
        ),
    ).toBe(true)
  })
  it('malformed or absent optional facts cannot break matching execution or entitlement', async () => {
    const a = assessment(1),
      b = assessment(false)
    delete b.cometFacts
    vi.mocked(readHolderExitAssessment).mockResolvedValueOnce(a).mockResolvedValueOnce(b)
    const r = await request()
    expect(r.code).toBe(200)
    expect(r.value.cometFactsAgreement).toBeUndefined()
    expect(r.value.capacityAgreement).toBeDefined()
    expect(r.value.executionAgreement).toBeDefined()
  })
  it('mismatched source pause facts cannot assert a pause at the checked source', async () => {
    const a = assessment(true),
      b = assessment(true)
    b.cometFacts.source = { ...source, blockHash: `0x${'f'.repeat(64)}` }
    vi.mocked(readHolderExitAssessment).mockResolvedValueOnce(a).mockResolvedValueOnce(b)
    const r = await request()
    expect(r.code).toBe(200)
    expect(r.value.cometFactsAgreement).toBeUndefined()
    expect(r.value.executionAgreement).toBeDefined()
  })
})
