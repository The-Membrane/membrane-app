import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPublicClient } from 'viem'
import { ROUTES } from '@/components/Carry/fixtures'
import { buildCarryForecastRegistry } from '@/lib/carry/forecastRegistry'
import { verifiedDirectSupplyDestinations } from '@/lib/carry/forecastRegistryMarkets'
import {
  assessHolderExitConditionalProjection,
  buildFrozenHolderExitMechanisms,
} from '@/lib/carry/holderExitMechanisms'
import { GHO_SGHO } from '@/scripts/route-rates/exact-leg-spread.mjs'
import seed from '@/scripts/route-cohort/aug-2026-ab-vault-seed.json'
import recorderConfig from '@/tools/venue-recorder.config.json'
import { DIRECT_SUPPLY_MARKETS } from '@/lib/carry/directSupplyMarketConstants'
import { readHolderExitAssessment } from '@/lib/carry/holderExitAssessment'
import { checkRateLimit } from '@/lib/game/rateLimit'
import handler, { holderExitAssessmentResponse } from '@/pages/api/carry/holder-exit-assessment'
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
vi.mock('@/lib/game/rateLimit', () => ({ checkRateLimit: vi.fn(), getClientIp: () => '127.0.0.1' }))
const NOW = Date.parse('2026-10-07T10:00:00.000Z')
const market = DIRECT_SUPPLY_MARKETS.aaveV3Usdc
const reference = {
  blockNumber: 26139351,
  blockHash: `0x${'a'.repeat(64)}`,
  blockTime: new Date(NOW - 60000).toISOString(),
}
const body = {
  routeKey: market.routeKey,
  destinationAddress: market.destination,
  owner: '0x0000000000000000000000000000000000000001',
  assetsRaw: '1000000',
  horizonHours: 24,
  forecastSourceReference: reference,
}
function assessment() {
  return {
    status: 'assessed',
    routeKey: body.routeKey,
    destinationAddress: body.destinationAddress,
    owner: body.owner,
    request: { assetsRaw: body.assetsRaw, assetAddress: market.underlying, horizonHours: 24 },
    source: { chainId: 1, ...reference, originValidation: 'single_provider' },
    stages: [
      {
        name: 'withdrawal',
        status: 'simulated',
        relatedToRequest: true,
        assetAddress: market.underlying,
        amountRaw: body.assetsRaw,
      },
    ],
    finalPayout: {
      status: 'simulated',
      assetAddress: market.underlying,
      amountRaw: body.assetsRaw,
    },
    forecast: {
      status: 'unvalidated',
      futureExit: null,
      exitDurationHours: null,
      prospectiveValidated: false,
    },
  }
}
async function request(value: unknown = body) {
  let code = 0
  let response: any
  const res = {
    setHeader: vi.fn(),
    status(n: number) {
      code = n
      return this
    },
    json(v: unknown) {
      response = v
      return this
    },
  }
  await handler(
    { method: 'POST', body: value, headers: {}, socket: { remoteAddress: '127.0.0.1' } } as never,
    res as never,
  )
  return { code, response, headers: res.setHeader }
}
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  vi.stubEnv('RECORDER_RPC_URL', 'https://pin-one.example/key,https://pin-two.example/key')
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true })
  vi.mocked(readHolderExitAssessment).mockResolvedValue(assessment() as never)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})
describe('independently verified Aave forecast source reference', () => {
  it('constructs pin server-side, matches two actual sources and emits compact actual execution agreement', async () => {
    const result = await request()
    expect(result.code).toBe(200)
    expect(result.headers).toHaveBeenCalledWith('Cache-Control', 'no-store')
    expect(readHolderExitAssessment).toHaveBeenCalledTimes(2)
    const calls = vi.mocked(readHolderExitAssessment).mock.calls
    expect(calls[0][1]).not.toHaveProperty('forecastSourceReference')
    expect(calls[0][2]).toEqual({
      includeCapacityFacts: true,
      includeStusdsProtocolCapacity: true,
      directFinalizedBlock: {
        mode: 'internal_historical_finalized_block',
        blockNumber: BigInt(reference.blockNumber),
        blockHash: reference.blockHash,
      },
    })
    expect(result.response.source.originValidation).toBe('two_provider')
    const agreement = result.response.executionAgreement
    expect(agreement.question).toMatchObject({
      owner: body.owner,
      assetsRaw: body.assetsRaw,
      finalAssetDecimals: 6,
      finalAssetAddress: market.underlying.toLowerCase(),
    })
    expect(agreement.simulations.map((s: any) => s.originHost)).toEqual([
      'pin-one.example',
      'pin-two.example',
    ])
    for (const proof of agreement.simulations) {
      expect(proof).toMatchObject({
        status: 'simulated',
        execution: 'single_call',
        kind: 'full_route_execution',
        fullRouteExecutionVerified: true,
        source: { ...reference, chainId: 1, finalized: true },
        requiredStages: [{ name: 'atomic_exit', status: 'executed' }],
        finalAssetAmountRaw: body.assetsRaw,
      })
      expect(JSON.stringify(proof)).not.toContain('/key')
    }
    const subject = buildFrozenHolderExitMechanisms(
      buildCarryForecastRegistry(
        ROUTES,
        seed,
        recorderConfig.venues,
        GHO_SGHO.destination,
        verifiedDirectSupplyDestinations(),
      ),
    ).subjectSpecs.find(
      (s) =>
        s.routeKey === market.routeKey && s.destinationAddress === market.destination.toLowerCase(),
    )!
    expect(assessHolderExitConditionalProjection(subject, agreement).tier).toBe(
      'conditional_projection',
    )
    expect(holderExitAssessmentResponse(assessment() as never)).not.toHaveProperty(
      'executionAgreement',
    )
  })
  it.each([
    { ...reference, blockNumber: [reference.blockNumber] },
    { ...reference, blockNumber: '26139351' },
    { ...reference, blockNumber: Number.MAX_SAFE_INTEGER + 1 },
    { ...reference, blockHash: [reference.blockHash] },
    { ...reference, blockTime: [reference.blockTime] },
    { ...reference, blockTime: { toString: () => reference.blockTime } },
    { ...reference, finalized: true },
    { ...reference, cashRaw: '1000000' },
    { ...reference, blockTime: '2026-10-07T09:59:00Z' },
    { ...reference, blockTime: new Date(NOW - 1800001).toISOString() },
    { ...reference, blockTime: new Date(NOW + 120001).toISOString() },
  ])('rejects malformed/stale/future reference before RPC: %j', async (invalid) => {
    expect((await request({ ...body, forecastSourceReference: invalid })).code).toBe(400)
    expect(readHolderExitAssessment).not.toHaveBeenCalled()
    expect(createPublicClient).not.toHaveBeenCalled()
  })
  it('rejects a mismatched route/destination reference before RPC', async () => {
    const other = DIRECT_SUPPLY_MARKETS.compoundV3Usdc
    expect((await request({ ...body, routeKey: other.routeKey })).code).toBe(400)
    expect(createPublicClient).not.toHaveBeenCalled()
  })
  it.each(['blockNumber', 'blockHash', 'blockTime'] as const)(
    'does not accept independently read source %s drift',
    async (field) => {
      const a = assessment()
      Object.assign(a.source, {
        [field]:
          field === 'blockNumber'
            ? reference.blockNumber + 1
            : field === 'blockHash'
              ? `0x${'b'.repeat(64)}`
              : new Date(NOW - 59000).toISOString(),
      })
      vi.mocked(readHolderExitAssessment).mockResolvedValue(a as never)
      expect((await request()).code).toBe(503)
    },
  )
  it('requires distinct-host full assessment agreement even at matching source', async () => {
    const differing = assessment()
    differing.finalPayout.amountRaw = '999999'
    vi.mocked(readHolderExitAssessment)
      .mockRejectedValue(new Error('third_origin_unavailable'))
      .mockResolvedValueOnce(assessment() as never)
      .mockResolvedValueOnce(differing as never)
    expect((await request()).code).toBe(503)
  })
  it('does not count a trailing-dot hostname alias as a second origin', async () => {
    vi.stubEnv('RECORDER_RPC_URL', 'https://pin-one.example/key-a,https://pin-one.example./key-b')
    vi.mocked(readHolderExitAssessment)
      .mockRejectedValue(new Error('fallback_unavailable'))
      .mockResolvedValueOnce(assessment() as never)
    const result = await request()
    expect(result.code).toBe(503)
    expect(createPublicClient).not.toHaveBeenCalled()
    expect(result.response).not.toHaveProperty('executionAgreement')
  })
  it('rejects expiry after provider awaits', async () => {
    vi.mocked(readHolderExitAssessment).mockImplementation(async () => {
      vi.mocked(Date.now).mockReturnValue(NOW + 1800000)
      return assessment() as never
    })
    expect((await request()).code).toBe(503)
  })
  it('rechecks freshness before RPC after waiting for the rate-limit boundary', async () => {
    vi.mocked(checkRateLimit).mockImplementation(async () => {
      vi.mocked(Date.now).mockReturnValue(NOW + 1800000)
      return { allowed: true }
    })
    expect((await request()).code).toBe(503)
    expect(createPublicClient).not.toHaveBeenCalled()
    expect(readHolderExitAssessment).not.toHaveBeenCalled()
  })
  it.each(['owner', 'stage', 'asset', 'Q'])(
    'omits execution attestations for unbound %s',
    async (changed) => {
      const a = assessment()
      if (changed === 'owner') a.owner = '0x0000000000000000000000000000000000000002'
      if (changed === 'stage') a.stages[0].relatedToRequest = false
      if (changed === 'asset')
        a.finalPayout.assetAddress = DIRECT_SUPPLY_MARKETS.compoundV3Usdc.destination
      if (changed === 'Q') a.finalPayout.amountRaw = '999999'
      vi.mocked(readHolderExitAssessment).mockResolvedValue(a as never)
      const result = await request()
      expect(result.code).toBe(200)
      expect(result.response).not.toHaveProperty('executionAgreement')
    },
  )
  it('leaves requests without reference unpinned and omits agreement for first-leg/unassessed delivery', async () => {
    const { forecastSourceReference: _, ...unpinned } = body
    const a = assessment()
    a.finalPayout.status = 'unassessed'
    a.finalPayout.amountRaw = null as never
    vi.mocked(readHolderExitAssessment).mockResolvedValue(a as never)
    const result = await request(unpinned)
    expect(result.code).toBe(200)
    expect(vi.mocked(readHolderExitAssessment).mock.calls[0][2]).toEqual({
      includeCapacityFacts: true,
      includeStusdsProtocolCapacity: true,
    })
    expect(result.response).not.toHaveProperty('executionAgreement')
  })
})
