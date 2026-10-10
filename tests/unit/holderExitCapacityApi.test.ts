import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { ROUTES } from '@/components/Carry/fixtures'
import seed from '@/scripts/route-cohort/aug-2026-ab-vault-seed.json'
import config from '@/tools/venue-recorder.config.json'
import { buildCarryForecastRegistry } from '@/lib/carry/forecastRegistry'
import { verifiedDirectSupplyDestinations } from '@/lib/carry/forecastRegistryMarkets'
import {
  buildCanonicalAtomicHolderExitSubjects,
  resolveIssuedHolderExitSubject,
  assessHolderExitConditionalProjection,
} from '@/lib/carry/holderExitMechanisms'
import { readHolderExitAssessment } from '@/lib/carry/holderExitAssessment'
import { checkRateLimit } from '@/lib/game/rateLimit'
import {
  buildHolderExitCapacityQuote,
  selectedHolderExitCapacity,
} from '@/lib/carry/holderExitCapacity'
import handler from '@/pages/api/carry/holder-exit-assessment'
vi.mock('@/lib/carry/holderExitAssessment', async (original) => ({
  ...(await original<typeof import('@/lib/carry/holderExitAssessment')>()),
  readHolderExitAssessment: vi.fn(),
}))
vi.mock('viem', async (original) => ({
  ...(await original<typeof import('viem')>()),
  createPublicClient: vi.fn(() => ({})),
}))
vi.mock('@/scripts/research/carry-depth-quote-archive.mjs', () => ({
  readProviderPolicy: () => ({ status: 'active' }),
  configuredProviders: () => {
    const urls = (process.env.RECORDER_RPC_URL || 'https://first.example,https://second.example')
      .split(',')
      .slice(0, 2)
    const providers = urls.map((url) => ({ url, host: new URL(url).hostname.replace(/\.+$/, '') }))
    if (providers.length !== 2 || new Set(providers.map((p) => p.host)).size !== 2)
      throw Error('test_policy_not_distinct')
    return providers
  },
}))
vi.mock('@/lib/game/rateLimit', () => ({ checkRateLimit: vi.fn(), getClientIp: () => '127.0.0.8' }))
const registry = () =>
  buildCarryForecastRegistry(
    ROUTES,
    seed,
    config.venues,
    '0xe1753f2e00940cc31213dd92013cf019dfe4ca1d',
    verifiedDirectSupplyDestinations(),
  )
const subjects = buildCanonicalAtomicHolderExitSubjects(registry())
const NOW = Date.parse('2026-10-07T10:00:00.000Z')
const ref = {
  blockNumber: 26139351,
  blockHash: `0x${'a'.repeat(64)}`,
  blockTime: new Date(NOW - 60_000).toISOString(),
}
const owner = '0x0000000000000000000000000000000000000001'
function body(s = subjects[0]) {
  return {
    routeKey: s.routeKey,
    destinationAddress: s.destinationAddress,
    owner,
    assetsRaw: '1000000',
    horizonHours: 24,
    forecastSourceReference: ref,
  }
}
function assessment(s = subjects[0]) {
  return {
    status: 'assessed',
    routeKey: s.routeKey,
    destinationAddress: s.destinationAddress,
    owner,
    request: {
      assetsRaw: '1000000',
      assetAddress: s.canonicalFinalAsset!.address,
      horizonHours: 24,
    },
    source: { chainId: 1, ...ref, originValidation: 'single_provider' },
    stages: [
      {
        name: 'withdrawal',
        status: 'simulated',
        relatedToRequest: true,
        assetAddress: s.canonicalFinalAsset!.address,
        amountRaw: '1000000',
      },
    ],
    finalPayout: {
      status: 'simulated',
      assetAddress: s.canonicalFinalAsset!.address,
      amountRaw: '1000000',
    },
    forecast: {
      status: 'unvalidated',
      futureExit: null,
      exitDurationHours: null,
      prospectiveValidated: false,
    },
  }
}
async function request(value: any) {
  let code = 0
  let response: any
  const res = {
    setHeader: vi.fn(),
    status(n: number) {
      code = n
      return this
    },
    json(v: any) {
      response = v
      return this
    },
  }
  await handler(
    { method: 'POST', body: value, headers: {}, socket: { remoteAddress: '127.0.0.8' } } as never,
    res as never,
  )
  return { code, response }
}
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  vi.stubEnv('RECORDER_RPC_URL', 'https://one.example/key,https://two.example/key')
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})
function capacityAssessment(success = true, limit = '5000000') {
  const s = subjects.find((s) => s.routeKey === 'USDC → Fluid USD Coin [USDC]')!,
    a = assessment(s)
  if (!success) {
    a.stages[0].status = 'reverted'
    a.finalPayout.status = 'unassessed'
    a.finalPayout.amountRaw = null as any
  }
  return {
    ...a,
    capacityQuote: buildHolderExitCapacityQuote(
      a as any,
      {
        entitlementRaw: '10000000',
        quotedMaxWithdrawRaw: limit,
        quotedMaxWithdrawStatus: 'quoted',
        effectiveLimitRaw: null,
        withdrawalsPaused: null,
      },
      NOW,
    )!,
  }
}
const capBody = () => body(subjects.find((s) => s.routeKey === 'USDC → Fluid USD Coin [USDC]'))
describe('actual two-origin capacity quote agreement boundary', () => {
  it('agreeing reverted withdrawals retain capacity quotes without full-execution agreement', async () => {
    vi.mocked(readHolderExitAssessment).mockResolvedValue(capacityAssessment(false) as any)
    const r = await request(capBody())
    expect(r.code).toBe(200)
    expect(r.response.capacityAgreement.quote.quotedMaxWithdrawRaw).toBe('5000000')
    expect(r.response.capacityAgreement.quote.successfulRequestedRawLowerBound).toBeNull()
    expect(r.response.executionAgreement).toBeUndefined()
  })
  it('agreeing full withdrawals retain requested-Q lower bound separately', async () => {
    vi.mocked(readHolderExitAssessment).mockResolvedValue(capacityAssessment() as any)
    const r = await request(capBody())
    expect(r.code).toBe(200)
    expect(r.response.capacityAgreement.quote.successfulRequestedRawLowerBound).toBe('1000000')
    expect(r.response.capacityAgreement.quote.aggregateAccessibleLiquidityRaw).toBeNull()
    expect(r.response.executionAgreement.simulations).toHaveLength(2)
    const q = r.response.capacityAgreement.quote
    const binding = {
      routeKey: capBody().routeKey,
      destination: capBody().destinationAddress,
      owner: capBody().owner,
      requestedRaw: capBody().assetsRaw,
      asset: q.asset,
      assetDecimals: q.assetDecimals,
      currentSource: q.source,
      asOfMs: NOW,
      executionAgreement: r.response.executionAgreement,
    }
    expect(selectedHolderExitCapacity(r.response.capacityAgreement, binding)).toEqual(
      r.response.capacityAgreement,
    )
    expect(
      selectedHolderExitCapacity(r.response.capacityAgreement, {
        ...binding,
        executionAgreement: undefined,
      }),
    ).toBeNull()
  })
  it('capacity agrees independently while execution disagreement remains unavailable', async () => {
    vi.mocked(readHolderExitAssessment)
      .mockResolvedValueOnce(capacityAssessment() as any)
      .mockResolvedValueOnce(capacityAssessment(false) as any)
      .mockRejectedValueOnce(Error('offline failure'))
    const r = await request(capBody())
    expect(r.code).toBe(503)
    expect(r.response.capacityAgreement.quote.successfulRequestedRawLowerBound).toBeNull()
    expect(r.response.source).toBeUndefined()
    expect(r.response.executionAgreement).toBeUndefined()
  })
  it('different getter quotes cannot be pooled', async () => {
    vi.mocked(readHolderExitAssessment)
      .mockResolvedValueOnce(capacityAssessment(false) as any)
      .mockResolvedValueOnce(capacityAssessment(false, '4000000') as any)
      .mockRejectedValueOnce(Error('offline failure'))
    const r = await request(capBody())
    expect(r.code).toBe(503)
    expect(r.response.capacityAgreement).toBeUndefined()
  })
  it('one canonical origin never issues an agreement', async () => {
    vi.stubEnv('RECORDER_RPC_URL', 'https://one.example/a,https://one.example./b')
    vi.mocked(readHolderExitAssessment)
      .mockResolvedValueOnce(capacityAssessment(false) as any)
      .mockRejectedValue(Error('offline failure'))
    const r = await request(capBody())
    expect(r.code).toBe(503)
    expect(r.response.capacityAgreement).toBeUndefined()
  })
  it('malformed nullable getter primitive drops quote only', async () => {
    const a = capacityAssessment(false)
    ;(a.capacityQuote as any).quotedMaxWithdrawRaw = ['5000000']
    vi.mocked(readHolderExitAssessment).mockResolvedValue(a as any)
    const r = await request(capBody())
    expect(r.code).toBe(503)
    expect(r.response.capacityAgreement).toBeUndefined()
  })
  it('post-read expiry cannot issue quote agreement', async () => {
    vi.mocked(readHolderExitAssessment).mockImplementation(async () => {
      vi.mocked(Date.now).mockReturnValue(NOW + 1800001)
      return capacityAssessment(false) as any
    })
    const r = await request(capBody())
    expect(r.code).toBe(503)
    expect(r.response.capacityAgreement).toBeUndefined()
  })
  it.each([false, true])(
    'optional getter disagreement preserves agreed full exact-Q proof (reverse=%s)',
    async (reverse) => {
      const quoted = capacityAssessment(),
        unavailable = structuredClone(quoted)
      unavailable.capacityQuote.quotedMaxWithdrawRaw = null
      unavailable.capacityQuote.quotedMaxWithdrawStatus = 'unavailable'
      unavailable.capacityQuote.quotedLimitMethod = 'unavailable'
      const values = reverse ? [unavailable, quoted] : [quoted, unavailable]
      vi.mocked(readHolderExitAssessment)
        .mockResolvedValueOnce(values[0] as any)
        .mockResolvedValueOnce(values[1] as any)
      const r = await request(capBody())
      expect(r.code).toBe(200)
      expect(r.response.executionAgreement.simulations).toHaveLength(2)
      expect(r.response.finalPayout.amountRaw).toBe('1000000')
      expect(r.response.capacityAgreement).toBeUndefined()
    },
  )
  it('optional entitlement failure preserves exact-Q proof without mixing capacity prongs', async () => {
    const quoted = capacityAssessment(),
      unavailable = structuredClone(quoted)
    unavailable.capacityQuote.entitlementRaw = null
    unavailable.capacityQuote.entitlementMethod = 'unavailable'
    vi.mocked(readHolderExitAssessment)
      .mockResolvedValueOnce(quoted as any)
      .mockResolvedValueOnce(unavailable as any)
    const r = await request(capBody())
    expect(r.code).toBe(200)
    expect(r.response.executionAgreement.simulations).toHaveLength(2)
    expect(r.response.capacityAgreement).toBeUndefined()
  })
})
