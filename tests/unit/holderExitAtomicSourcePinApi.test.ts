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
describe('canonical 60 native atomic source agreements', () => {
  it('issues exactly59 core plus verified supplemental18-decimal Aave USDe, never staged/self-created descriptors', () => {
    expect(subjects).toHaveLength(60)
    expect(subjects.filter((s) => s.routeKey === 'USDe → supply on Aave V3')).toHaveLength(1)
    const supplemental = resolveIssuedHolderExitSubject(
      'USDe → supply on Aave V3',
      '0x4f5923fc5fd4a93352581b38b7cd26943012decf',
    )!
    expect(supplemental.canonicalFinalAsset).toEqual({
      chainId: 1,
      address: '0x4c9edd5852cd905f086c759e8383e09bff1e68b3',
      decimals: 18,
    })
    expect(
      resolveIssuedHolderExitSubject(
        'GHO → UmbrellaStakeToken [GHO]',
        '0x4f827a63755855cdf3e8f3bcd20265c833f15033',
      ),
    ).toBeNull()
    expect(resolveIssuedHolderExitSubject(supplemental.routeKey, owner)).toBeNull()
  })
  it.each(subjects.map((s) => [s.routeKey, s.destinationAddress, s] as const))(
    'binds exact same source/Q native units for %s/%s',
    async (_r, _d, s) => {
      vi.mocked(readHolderExitAssessment).mockResolvedValue(assessment(s) as never)
      const result = await request(body(s))
      expect(result.code).toBe(200)
      const evidence = result.response.executionAgreement
      expect(evidence.question.finalAssetDecimals).toBe(s.canonicalFinalAsset!.decimals)
      expect(evidence.question.finalAssetAddress).toBe(s.canonicalFinalAsset!.address)
      expect(evidence.simulations).toHaveLength(2)
      expect(
        assessHolderExitConditionalProjection(
          resolveIssuedHolderExitSubject(s.routeKey, s.destinationAddress)!,
          evidence,
        ).tier,
      ).toBe('conditional_projection')
      expect(
        vi
          .mocked(readHolderExitAssessment)
          .mock.calls.every((c) => Object.values(c[2]!)[0]?.blockHash === ref.blockHash),
      ).toBe(true)
    },
  )
  it.each(['duplicate', 'destination', 'identity', 'readiness', 'group', 'core'] as const)(
    'rejects modified registered metadata: %s',
    (kind) => {
      const r = registry()
      const g = r.routeGroups.find((g) => g.routeKey === 'USDe → supply on Aave V3')!
      if (kind === 'duplicate') g.contractSubjects.push(structuredClone(g.contractSubjects[0]))
      if (kind === 'destination') g.contractSubjects[0].destinationAddress = owner
      if (kind === 'identity') g.contractSubjects[0].identitySource.reference = 'self-attested'
      if (kind === 'readiness')
        g.contractSubjects[0].currentSourceReadiness = 'historical_seed_only'
      if (kind === 'group') r.routeGroups.push(structuredClone(g))
      if (kind === 'core') r.routeGroups[0].contractSubjects[0].destinationAddress = owner
      expect(() => buildCanonicalAtomicHolderExitSubjects(r)).toThrow()
    },
  )
  it.each(['partial', 'revert', 'Q', 'asset', 'stage', 'source', 'post-expiry'] as const)(
    'withholds complete execution evidence for %s',
    async (kind) => {
      const s = subjects.find((s) => s.routeKey === 'USDe → supply on Aave V3')!
      const a: any = assessment(s)
      if (kind === 'partial') a.status = 'partial'
      if (kind === 'revert') a.finalPayout.status = 'unassessed'
      if (kind === 'Q') a.finalPayout.amountRaw = '999999'
      if (kind === 'asset') a.finalPayout.assetAddress = owner
      if (kind === 'stage') a.stages[0].name = 'receipt_initiation'
      if (kind === 'source') a.source.blockHash = `0x${'b'.repeat(64)}`
      vi.mocked(readHolderExitAssessment).mockImplementation(async () => {
        if (kind === 'post-expiry') vi.spyOn(Date, 'now').mockReturnValue(NOW + 1800000)
        return a
      })
      const r = await request(body(s))
      expect(r.response?.executionAgreement).toBeUndefined()
      if (['source', 'post-expiry'].includes(kind)) expect(r.code).toBe(503)
    },
  )
  it('rejects staged references before any executor without changing unreferenced staged behavior', async () => {
    const b = {
      ...body(),
      routeKey: 'GHO → UmbrellaStakeToken [GHO]',
      destinationAddress: '0x4f827a63755855cdf3e8f3bcd20265c833f15033',
    }
    expect((await request(b)).code).toBe(400)
    expect(readHolderExitAssessment).not.toHaveBeenCalled()
  })
})
