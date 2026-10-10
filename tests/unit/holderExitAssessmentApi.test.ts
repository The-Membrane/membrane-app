import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DIRECT_SUPPLY_MARKETS } from '@/lib/carry/directSupplyMarketConstants'
import { readHolderExitAssessment } from '@/lib/carry/holderExitAssessment'
import { readSusdeCurrentProtocolOrigin } from '@/lib/carry/susdeCurrentProtocolCapacity'
import { issueSusdeHolderForecastV2FromNativeOrigins } from '@/lib/carry/server/susdeHolderForecastIssuer'
import type { HolderExitAssessmentApiView } from '@/pages/api/carry/holder-exit-assessment'
import {
  syntheticSusdeClient,
  syntheticSusdeExpected,
} from '../fixtures/susdeCurrentProtocolCapacity'
import { HASTRA_STAKING_VAULT, PYUSD_STAKING_ROUTE } from '@/lib/carry/pyusdStakingRouteIdentity'
import { STAKED_USDAT_ROUTE, STAKED_USDAT_VAULT } from '@/lib/carry/stakedUsdatExit'
import { TWYNE_PT_ROUTE, TWYNE_PT_WRAPPER } from '@/lib/carry/twynePtExit'
import morphoIdentities from '@/lib/carry/morpho-v2-asset-identities.json'
import { checkRateLimit } from '@/lib/game/rateLimit'
import handler, {
  holderExitAssessmentResponse,
  parseHolderExitAssessmentRequest,
  sameHolderExitAssessment,
} from '@/pages/api/carry/holder-exit-assessment'
import seed from '@/scripts/route-cohort/aug-2026-ab-vault-seed.json'

vi.mock('@/lib/carry/holderExitAssessment', async (original) => ({
  ...(await original<typeof import('@/lib/carry/holderExitAssessment')>()),
  readHolderExitAssessment: vi.fn(),
}))
vi.mock('@/lib/carry/susdeCurrentProtocolCapacity', async (original) => ({
  ...(await original<typeof import('@/lib/carry/susdeCurrentProtocolCapacity')>()),
  readSusdeCurrentProtocolOrigin: vi.fn(),
}))
vi.mock('@/lib/carry/server/susdeHolderForecastIssuer', async (original) => {
  const actual = await original<typeof import('@/lib/carry/server/susdeHolderForecastIssuer')>()
  return {
    ...actual,
    issueSusdeHolderForecastV2FromNativeOrigins: vi.fn(
      actual.issueSusdeHolderForecastV2FromNativeOrigins,
    ),
  }
})
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

const market = DIRECT_SUPPLY_MARKETS.aaveV3Usdc
const owner = '0x0000000000000000000000000000000000000001'
const body = {
  routeKey: market.routeKey,
  destinationAddress: market.destination,
  owner,
  assetsRaw: '1000000',
  horizonHours: 24,
  chainId: 1,
}
const sourceBlockTime = new Date().toISOString()
const source = () => ({
  chainId: 1 as const,
  blockNumber: 26_110_141,
  blockHash: `0x${'a'.repeat(64)}`,
  blockTime: sourceBlockTime,
  originValidation: 'single_provider' as const,
})

async function request(
  method: string,
  value: unknown,
  remote = '127.0.0.1',
  contentLength?: string,
) {
  let status = 0
  let response: unknown
  const headers: Record<string, string> = {}
  const res = {
    setHeader: vi.fn((key: string, content: string) => {
      headers[key] = content
    }),
    status: vi.fn((code: number) => {
      status = code
      return res
    }),
    json: vi.fn((content: unknown) => {
      response = content
      return res
    }),
  }
  await handler(
    {
      method,
      body: value,
      headers: contentLength ? { 'content-length': contentLength } : {},
      socket: { remoteAddress: remote },
    } as never,
    res as never,
  )
  return { status, response, headers }
}

describe('holder exit assessment API', () => {
  beforeEach(() => {
    vi.mocked(issueSusdeHolderForecastV2FromNativeOrigins).mockClear()
    vi.mocked(readSusdeCurrentProtocolOrigin).mockReset().mockResolvedValue(null)
    vi.stubEnv('NODE_ENV', 'development')
    vi.mocked(checkRateLimit).mockReset().mockResolvedValue({ allowed: true })
    vi.mocked(readHolderExitAssessment)
      .mockReset()
      .mockResolvedValue({
        status: 'assessed',
        source: source(),
      } as never)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  const susdeBody = {
    ...body,
    routeKey: 'USDe → Staked USDe [USDe]',
    destinationAddress: '0x9D39A5DE30e57443BfF2A8307A4256c8797A3497',
  }
  const susdeAssessment = () => {
    const assetAddress = '0x4c9EDD5852cd905f086C759E8383e09bff1E68B3'
    const observedSource = source()
    return {
      status: 'partial',
      routeKey: susdeBody.routeKey,
      destinationAddress: susdeBody.destinationAddress,
      owner,
      request: { assetsRaw: body.assetsRaw, assetAddress, horizonHours: body.horizonHours },
      source: observedSource,
      stages: [
        {
          name: 'cooldown_initiation',
          assetAddress,
          status: 'simulated',
          amountRaw: body.assetsRaw,
          relatedToRequest: true,
        },
        {
          name: 'pending_claim',
          assetAddress,
          status: 'simulated',
          amountRaw: '2500000',
          relatedToRequest: false,
        },
      ],
      finalPayout: { assetAddress, status: 'unassessed', amountRaw: null },
      forecast: {
        status: 'unvalidated',
        prospectiveValidated: false,
        futureExit: null,
        exitDurationHours: null,
      },
      susdeHolderFacts: {
        owner,
        originAgreement: 'not_compared',
        status: 'observed',
        activeSharesRaw: '5000000',
        activeEntitlementRaw: '5500000' as string | null,
        pendingAssetsRaw: '2500000',
        maxInitiationAssetsRaw: '5000000',
        method: 'preview_redeem_full_active_position',
        semanticQualification: 'UNQUALIFIED',
        sourceQualification: 'UNQUALIFIED',
        ceilingQualification: 'getter_only_not_callability',
        source: {
          chainId: 1,
          vaultAddress: susdeBody.destinationAddress,
          assetAddress,
          blockNumber: observedSource.blockNumber,
          blockHash: observedSource.blockHash,
          blockTime: observedSource.blockTime,
        },
      },
    }
  }

  const susdeNativeAssessment = () => {
    const expected = syntheticSusdeExpected(Date.now()),
      assessment = susdeAssessment()
    return {
      ...assessment,
      source: {
        ...assessment.source,
        blockNumber: Number(expected.source.blockNumber),
        blockHash: expected.source.blockHash,
        blockTime: expected.source.blockTime,
      },
      susdeHolderFacts: {
        ...assessment.susdeHolderFacts,
        activeSharesRaw: expected.activeSharesRaw,
        activeEntitlementRaw: expected.activeEntitlementRaw,
        maxInitiationAssetsRaw: expected.maxWithdrawRaw,
        pendingAssetsRaw: expected.pendingAssetsRaw,
        storedCooldownEndUnix: expected.storedCooldownEndUnix,
        cooldownDurationSeconds: expected.cooldownDurationSeconds,
        source: {
          ...assessment.susdeHolderFacts.source,
          blockNumber: Number(expected.source.blockNumber),
          blockHash: expected.source.blockHash,
          blockTime: expected.source.blockTime,
        },
      },
      cooldownCondition: {
        exitMode: 'cooldown',
        durationSeconds: 86400,
        pendingAssetsRaw: expected.pendingAssetsRaw,
        aggregateSiloUsdeRaw: '3000000',
        pendingClaimEarliestAt: new Date(
          Number(expected.storedCooldownEndUnix) * 1000,
        ).toISOString(),
        initiationStatus: 'success',
        directWithdrawalStatus: null,
        pendingClaimStatus: 'success',
        newRequestWouldResetPending: true,
        ifInitiatedAtCheckedBlockEarliestAt: new Date(
          Date.parse(expected.source.blockTime) + 86400000,
        ).toISOString(),
      },
    }
  }

  it('collects both optional native witnesses only after the required sUSDe pair agrees', async () => {
    const issueAtMs = Date.parse('2026-10-08T04:16:00.000Z')
    vi.spyOn(Date, 'now').mockReturnValue(issueAtMs)
    const actual = await vi.importActual<typeof import('@/lib/carry/susdeCurrentProtocolCapacity')>(
      '@/lib/carry/susdeCurrentProtocolCapacity',
    )
    vi.mocked(readHolderExitAssessment).mockResolvedValue(susdeNativeAssessment() as never)
    const clients: ReturnType<typeof syntheticSusdeClient>[] = []
    vi.mocked(readSusdeCurrentProtocolOrigin).mockImplementation(
      async (_privateClient, expected) => {
        expect(readHolderExitAssessment).toHaveBeenCalledTimes(2)
        const client = syntheticSusdeClient(expected)
        clients.push(client)
        return actual.readSusdeCurrentProtocolOrigin(client, expected)
      },
    )
    const result = await request('POST', susdeBody)
    expect(result.status).toBe(200)
    expect(readSusdeCurrentProtocolOrigin).toHaveBeenCalledTimes(2)
    expect(clients.every((c) => c.request.mock.calls.length === 12)).toBe(true)
    expect(result.response).toHaveProperty(
      'susdeCurrentProtocolCapacityEvidence.schema',
      'susde_lossless_current_protocol_capacity_v1',
    )
    expect(result.response).not.toHaveProperty('susdeProtocolCapacityObservation')
    const response = result.response as HolderExitAssessmentApiView,
      envelope = response.susdeHolderForecastEnvelope!
    expect(envelope).toBeDefined()
    expect(envelope.schema).toBe('susde_holder_forecast_envelope_v2')
    expect(envelope).toHaveProperty('evidenceSetSha256')
    expect(envelope).not.toHaveProperty('historyCaptureSha256')
    expect(envelope.inputCommon.history.rows).toHaveLength(24)
    expect(envelope.modelsByHorizonHours[24].metadata.donorCount).toBe(22)
    expect(envelope.owner).toBe(response.owner.toLowerCase())
    expect(envelope.originalRequestedRaw).toBe(response.request.assetsRaw)
    expect(envelope.source).toEqual({
      chainId: response.source.chainId,
      blockNumber: String(response.source.blockNumber),
      blockHash: response.source.blockHash.toLowerCase(),
      blockTime: response.source.blockTime,
      finalized: true,
    })
    expect(envelope.issueAtUtc).toBe(new Date(issueAtMs).toISOString())
    expect(envelope.inputCommon.current.evidence).toEqual(
      response.susdeCurrentProtocolCapacityEvidence,
    )
    expect(response.susdeCurrentProtocolCapacityEvidence?.availableAtUtc).toBe(envelope.issueAtUtc)
    expect(envelope.sourceProofValidUntil).toBe(
      new Date(Date.parse(response.source.blockTime) + 1800000).toISOString(),
    )
    expect(issueSusdeHolderForecastV2FromNativeOrigins).toHaveBeenCalledTimes(1)
    expect(envelope.supportedHorizonHours).toEqual([1, 24, 48, 168])
    for (const hours of envelope.supportedHorizonHours) {
      const model = envelope.modelsByHorizonHours[hours]
      expect(model.owner).toBe(envelope.owner)
      expect(model.originalRequestedRaw).toBe(envelope.originalRequestedRaw)
      expect(model.issueAtUtc).toBe(envelope.issueAtUtc)
      expect(model.sourceProofValidUntil).toBe(envelope.sourceProofValidUntil)
      expect(model.targetAtUtc).toBe(new Date(issueAtMs + hours * 3600000).toISOString())
    }
    // Selecting any issued horizon consumes the existing response without a new native read.
    expect(readSusdeCurrentProtocolOrigin).toHaveBeenCalledTimes(2)
    expect(result.response).toMatchObject({
      susdeHolderFacts: {
        activeEntitlementRaw: '5500000',
        pendingAssetsRaw: '2500000',
        sourceQualification: 'UNQUALIFIED',
      },
      forecast: { futureExit: null, prospectiveValidated: false },
      finalPayout: { status: 'unassessed', amountRaw: null },
    })
  })

  it.each(['denied', 'thrown'] as const)(
    'retains native evidence and required HTTP 200 when optional forecast issuance is %s',
    async (failure) => {
      const issueAtMs = Date.parse('2026-10-08T04:16:00.000Z')
      vi.spyOn(Date, 'now').mockReturnValue(issueAtMs)
      const actual = await vi.importActual<
        typeof import('@/lib/carry/susdeCurrentProtocolCapacity')
      >('@/lib/carry/susdeCurrentProtocolCapacity')
      vi.mocked(readHolderExitAssessment).mockResolvedValue(susdeNativeAssessment() as never)
      vi.mocked(readSusdeCurrentProtocolOrigin).mockImplementation(async (_client, expected) =>
        actual.readSusdeCurrentProtocolOrigin(syntheticSusdeClient(expected), expected),
      )
      vi.mocked(issueSusdeHolderForecastV2FromNativeOrigins).mockImplementationOnce(() => {
        if (failure === 'thrown') throw Error('optional_forecast_failure')
        return null
      })
      const result = await request('POST', susdeBody)
      expect(result.status).toBe(200)
      expect(result.response).not.toHaveProperty('susdeHolderForecastEnvelope')
      expect(result.response).not.toHaveProperty('susdeProtocolCapacityObservation')
      expect(result.response).toMatchObject({
        status: 'partial',
        susdeCurrentProtocolCapacityEvidence: {
          availableAtUtc: new Date(issueAtMs).toISOString(),
        },
        finalPayout: { status: 'unassessed', amountRaw: null },
      })
      expect(issueSusdeHolderForecastV2FromNativeOrigins).toHaveBeenCalledTimes(1)
      expect(vi.mocked(issueSusdeHolderForecastV2FromNativeOrigins).mock.calls[0][2]).toBe(
        issueAtMs,
      )
      expect(readSusdeCurrentProtocolOrigin).toHaveBeenCalledTimes(2)
    },
  )

  it.each(['optional_failure', 'optional_disagreement'])(
    'keeps required sUSDe 200 on %s',
    async (variant) => {
      const actual = await vi.importActual<
        typeof import('@/lib/carry/susdeCurrentProtocolCapacity')
      >('@/lib/carry/susdeCurrentProtocolCapacity')
      vi.mocked(readHolderExitAssessment).mockResolvedValue(susdeNativeAssessment() as never)
      let count = 0
      vi.mocked(readSusdeCurrentProtocolOrigin).mockImplementation(
        async (_privateClient, expected) => {
          count++
          if (variant === 'optional_failure' && count === 1) return null
          const client = syntheticSusdeClient(expected, (key, value) =>
            variant === 'optional_disagreement' && count === 2 && key === 'siloCashRaw'
              ? '0x' + 4000000n.toString(16).padStart(64, '0')
              : value,
          )
          return actual.readSusdeCurrentProtocolOrigin(client, expected)
        },
      )
      const result = await request('POST', susdeBody)
      expect(result.status).toBe(200)
      expect(result.response).not.toHaveProperty('susdeCurrentProtocolCapacityEvidence')
      expect(result.response).not.toHaveProperty('susdeProtocolCapacityObservation')
      expect(result.response).toMatchObject({
        status: 'partial',
        susdeHolderFacts: { sourceQualification: 'UNQUALIFIED' },
        finalPayout: { status: 'unassessed', amountRaw: null },
      })
    },
  )

  it('compares full active sUSDe facts independently and preserves unqualified economics', async () => {
    vi.mocked(readHolderExitAssessment).mockResolvedValue(susdeAssessment() as never)
    const result = await request('POST', susdeBody)
    expect(result.status).toBe(200)
    expect(result.response).toMatchObject({
      susdeHolderFacts: {
        originAgreement: 'two_provider_agreed',
        activeEntitlementRaw: '5500000',
        pendingAssetsRaw: '2500000',
        semanticQualification: 'UNQUALIFIED',
        sourceQualification: 'UNQUALIFIED',
      },
      finalPayout: { status: 'unassessed', amountRaw: null },
      forecast: { prospectiveValidated: false, futureExit: null },
    })
  })

  it.each([
    'missing',
    'unknown',
    'different_Ea',
    'different_fact_owner',
    'different_fact_hash',
    'different_shares',
    'different_pending',
    'different_phase_bound',
    'different_qualification',
  ])('preserves the core sUSDe assay when optional facts are %s', async (variant) => {
    const first = susdeAssessment()
    const second = susdeAssessment()
    if (variant === 'missing') Reflect.deleteProperty(second, 'susdeHolderFacts')
    if (variant === 'unknown') {
      second.susdeHolderFacts.activeEntitlementRaw = null
      second.susdeHolderFacts.status = 'unknown_active_entitlement'
    }
    if (variant === 'different_Ea') second.susdeHolderFacts.activeEntitlementRaw = '5600000'
    if (variant === 'different_shares') second.susdeHolderFacts.activeSharesRaw = '6000000'
    if (variant === 'different_pending') second.susdeHolderFacts.pendingAssetsRaw = '3000000'
    if (variant === 'different_phase_bound') second.susdeHolderFacts.maxInitiationAssetsRaw = '0'
    if (variant === 'different_qualification') {
      second.susdeHolderFacts.sourceQualification = 'QUALIFIED'
    }
    if (variant === 'different_fact_owner') second.susdeHolderFacts.owner = market.destination
    if (variant === 'different_fact_hash')
      second.susdeHolderFacts.source.blockHash = `0x${'b'.repeat(64)}`
    vi.mocked(readHolderExitAssessment)
      .mockResolvedValueOnce(first as never)
      .mockResolvedValueOnce(second as never)
    const result = await request('POST', susdeBody)
    expect(result.status).toBe(200)
    expect(result.response).not.toHaveProperty('susdeHolderFacts')
    expect(result.response).toMatchObject({
      status: 'partial',
      stages: first.stages,
      finalPayout: first.finalPayout,
      forecast: first.forecast,
    })
  })

  it.each(['source', 'owner', 'Q'])(
    'still rejects differing required sUSDe %s',
    async (variant) => {
      const first = susdeAssessment()
      const second = susdeAssessment()
      if (variant === 'source') second.source.blockHash = `0x${'b'.repeat(64)}`
      if (variant === 'owner') second.owner = market.destination
      if (variant === 'Q') second.request.assetsRaw = '2000000'
      vi.mocked(readHolderExitAssessment)
        .mockResolvedValueOnce(first as never)
        .mockResolvedValueOnce(second as never)
      expect((await request('POST', susdeBody)).status).toBe(503)
    },
  )

  it('validates the exact frozen route and returns a no-store read-only assessment', async () => {
    const result = await request('POST', body)
    expect(result.status).toBe(200)
    expect(result.headers['Cache-Control']).toBe('no-store')
    expect(
      (result.response as { source: { originValidation: string } }).source.originValidation,
    ).toBe('two_provider')
    expect(readHolderExitAssessment).toHaveBeenCalledTimes(2)
    expect(vi.mocked(readHolderExitAssessment).mock.calls[0][1]).toMatchObject({
      owner,
      assetsRaw: '1000000',
      horizonHours: 24,
    })
  })

  it('attaches the bound server projection through the actual agreed handler response', async () => {
    const assessment = {
      status: 'assessed',
      routeKey: market.routeKey,
      destinationAddress: market.destination,
      owner,
      request: { assetsRaw: body.assetsRaw, assetAddress: market.underlying, horizonHours: 24 },
      source: source(),
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
        prospectiveValidated: false,
        futureExit: null,
        exitDurationHours: null,
      },
    }
    vi.mocked(readHolderExitAssessment).mockResolvedValue(assessment as never)
    const result = await request('POST', body)
    expect(result.status).toBe(200)
    expect(result.headers['Cache-Control']).toBe('no-store')
    expect(result.response).toMatchObject({
      mechanicalOutlook: {
        horizonSeconds: 86400,
        assessmentRequest: assessment.request,
        outlook: {
          status: 'conditional',
          source: { originValidation: 'two_provider' },
          subject: { owner, assetsRaw: body.assetsRaw },
        },
      },
    })
  })

  it('accepts the exact PYUSD route identity request without inventing a holder leg', async () => {
    const input = {
      ...body,
      routeKey: PYUSD_STAKING_ROUTE,
      destinationAddress: HASTRA_STAKING_VAULT,
    }
    expect((await request('POST', input)).status).toBe(200)
    expect(readHolderExitAssessment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ routeKey: PYUSD_STAKING_ROUTE, assetsRaw: body.assetsRaw }),
      expect.objectContaining({ includeCapacityFacts: true }),
    )
    expect((await request('POST', { ...input, destinationAddress: owner })).status).toBe(400)
  })

  it('keeps the PYUSD payout Q separate from a bounded PRIME-share probe', async () => {
    const input = {
      ...body,
      routeKey: PYUSD_STAKING_ROUTE,
      destinationAddress: HASTRA_STAKING_VAULT,
      assetsRaw: '7500000',
      primeSharesRaw: '1000000',
    }
    expect((await request('POST', input)).status).toBe(200)
    expect(vi.mocked(readHolderExitAssessment).mock.calls[0][1]).toMatchObject({
      assetsRaw: '7500000',
      primeSharesRaw: '1000000',
    })
    expect((await request('POST', { ...input, primeSharesRaw: '0' })).status).toBe(400)
    expect(
      (await request('POST', { ...input, primeSharesRaw: '1000000000000000001' })).status,
    ).toBe(400)
    expect((await request('POST', { ...body, primeSharesRaw: '1' })).status).toBe(400)
  })

  it('accepts an exact frozen Morpho VaultV2 route and rejects a mismatched destination', async () => {
    const vault = morphoIdentities.entries[0].vault
    const routeKey = seed.positions.find((entry) => entry.vault.toLowerCase() === vault)!
      .routeIds[0]
    const input = { ...body, routeKey, destinationAddress: vault }
    expect((await request('POST', input)).status).toBe(200)
    expect(vi.mocked(readHolderExitAssessment).mock.calls[0][1]).toMatchObject({
      routeKey,
      destinationAddress: vault,
      owner,
    })
    expect((await request('POST', { ...input, destinationAddress: owner })).status).toBe(400)
  })

  it('keeps original AUSD Q, sUSDat shares, and an existing ticket independent', async () => {
    const input = {
      ...body,
      routeKey: STAKED_USDAT_ROUTE,
      destinationAddress: STAKED_USDAT_VAULT,
      assetsRaw: '1000000000000000000',
      sharesRaw: '2000000000000000000',
      requestTokenId: '42',
    }
    expect((await request('POST', input)).status).toBe(200)
    expect(readHolderExitAssessment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        assetsRaw: '1000000000000000000',
        sharesRaw: '2000000000000000000',
        requestTokenId: '42',
      }),
      expect.objectContaining({ includeCapacityFacts: true }),
    )
    expect((await request('POST', { ...input, sharesRaw: undefined })).status).toBe(400)
    expect((await request('POST', { ...body, sharesRaw: '1' })).status).toBe(400)
  })

  it('keeps Twyne USDe Q separate from the collateral vault PT probe', async () => {
    const input = {
      ...body,
      routeKey: TWYNE_PT_ROUTE,
      destinationAddress: TWYNE_PT_WRAPPER,
      assetsRaw: '1000000000000000000',
      collateralVault: '0x3333333333333333333333333333333333333333',
      ptRaw: '2000000000000000000',
    }
    expect((await request('POST', input)).status).toBe(200)
    expect(readHolderExitAssessment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        assetsRaw: '1000000000000000000',
        collateralVault: '0x3333333333333333333333333333333333333333',
        ptRaw: '2000000000000000000',
      }),
      expect.objectContaining({ includeCapacityFacts: true }),
    )
    expect((await request('POST', { ...input, ptRaw: undefined })).status).toBe(400)
    expect((await request('POST', { ...body, ptRaw: '1' })).status).toBe(400)
  })

  it('rejects malformed identities and bounded input before any provider', async () => {
    expect(parseHolderExitAssessmentRequest({ ...body, destinationAddress: owner })).toBeNull()
    expect((await request('POST', { ...body, horizonHours: 0 })).status).toBe(400)
    expect((await request('POST', { ...body, extra: true })).status).toBe(400)
    expect((await request('POST', body, '127.0.0.1', '9999')).status).toBe(413)
    expect((await request('GET', body)).status).toBe(405)
    expect(readHolderExitAssessment).not.toHaveBeenCalled()
  })

  it('serves public read-only checks with rate limits and hides provider details', async () => {
    expect((await request('POST', body, '203.0.113.10')).status).toBe(200)
    vi.stubEnv('NODE_ENV', 'production')
    expect((await request('POST', body)).status).toBe(200)
    expect(vi.mocked(checkRateLimit).mock.calls[0][0]).not.toContain(owner)
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 31 })
    const limited = await request('POST', body)
    expect(limited.status).toBe(429)
    expect(limited.headers['Retry-After']).toBe('31')
    vi.mocked(checkRateLimit).mockRejectedValueOnce(new Error('secret DB URL'))
    expect((await request('POST', body)).status).toBe(200)
    vi.mocked(checkRateLimit).mockRejectedValueOnce(new Error('secret DB URL'))
    expect((await request('POST', body, '203.0.113.10')).status).toBe(503)
    vi.stubEnv('NODE_ENV', 'development')
    vi.mocked(checkRateLimit).mockRejectedValueOnce(new Error('secret DB URL'))
    expect((await request('POST', body)).status).toBe(200)
    vi.mocked(readHolderExitAssessment).mockRejectedValue(new Error('secret RPC endpoint'))
    expect((await request('POST', body)).response).toEqual({
      error: 'holder_exit_assessment_unavailable',
    })
  })

  it('cannot replace a stale approved origin with an unapproved third origin', async () => {
    vi.stubEnv('RECORDER_RPC_URL', 'https://first.example,https://second.example')
    vi.mocked(readHolderExitAssessment)
      .mockReset()
      .mockResolvedValueOnce({
        status: 'assessed',
        source: { ...source(), blockTime: new Date(Date.now() - 31 * 60_000).toISOString() },
      } as never)
      .mockResolvedValueOnce({
        status: 'assessed',
        source: source(),
      } as never)
      .mockResolvedValueOnce({
        status: 'assessed',
        source: source(),
      } as never)
    const result = await request('POST', body)
    expect(result.status).toBe(503)
    expect(readHolderExitAssessment).toHaveBeenCalledTimes(2)
  })

  it('rejects an expired open-window origin without a public fallback', async () => {
    vi.stubEnv('RECORDER_RPC_URL', 'https://first.example,https://second.example')
    vi.mocked(readHolderExitAssessment)
      .mockReset()
      .mockResolvedValueOnce({
        status: 'assessed',
        source: { ...source(), blockTime: new Date(Date.now() - 5 * 60_000).toISOString() },
        condition: {
          gate: 'window_open',
          windowEndInclusive: Math.floor((Date.now() - 60_000) / 1000),
        },
      } as never)
      .mockResolvedValueOnce({
        status: 'assessed',
        source: source(),
      } as never)
      .mockResolvedValueOnce({
        status: 'assessed',
        source: source(),
      } as never)
    expect((await request('POST', body)).status).toBe(503)
    expect(readHolderExitAssessment).toHaveBeenCalledTimes(2)
  })

  it('requires agreement on block and holder outcome before returning a live result', async () => {
    vi.stubEnv('RECORDER_RPC_URL', 'https://first.example,https://second.example')
    vi.mocked(readHolderExitAssessment)
      .mockReset()
      .mockResolvedValueOnce({ status: 'assessed', source: source() } as never)
      .mockResolvedValueOnce({
        status: 'partial',
        source: source(),
      } as never)
      .mockResolvedValueOnce({ status: 'assessed', source: source() } as never)
    const agreed = await request('POST', body)
    expect(agreed.status).toBe(503)
    expect(readHolderExitAssessment).toHaveBeenCalledTimes(2)

    vi.mocked(readHolderExitAssessment)
      .mockReset()
      .mockResolvedValueOnce({ status: 'assessed', source: source() } as never)
      .mockResolvedValueOnce({
        status: 'assessed',
        source: { ...source(), blockHash: `0x${'b'.repeat(64)}` },
      } as never)
      .mockResolvedValueOnce({ status: 'partial', source: source() } as never)
    expect((await request('POST', body)).status).toBe(503)
    expect(
      sameHolderExitAssessment(
        { status: 'assessed', source: source() } as never,
        { status: 'partial', source: source() } as never,
      ),
    ).toBe(false)
    expect(
      sameHolderExitAssessment(
        {
          status: 'partial',
          source: source(),
          cooldownCondition: { pendingAssetsRaw: '5', aggregateSiloUsdeRaw: '7' },
        } as never,
        {
          status: 'partial',
          source: source(),
          cooldownCondition: { pendingAssetsRaw: '5', aggregateSiloUsdeRaw: '8' },
        } as never,
      ),
    ).toBe(false)
  })

  it('keeps agreed holder evidence when only one host has the optional Saturn quote', async () => {
    vi.stubEnv('RECORDER_RPC_URL', 'https://first.example,https://second.example')
    const quote = { status: 'conditional_quote', usdatInputRaw: '10200000' }
    const core = {
      status: 'partial',
      source: source(),
      stakedUsdatCondition: {
        existingTicketId: '1669',
        existingTicketClaimStatus: 'success',
        existingTicketConversionQuote: null,
      },
    }
    vi.mocked(readHolderExitAssessment)
      .mockReset()
      .mockResolvedValueOnce({
        ...core,
        stakedUsdatCondition: {
          ...core.stakedUsdatCondition,
          existingTicketConversionQuote: quote,
        },
      } as never)
      .mockResolvedValueOnce(core as never)
      .mockRejectedValueOnce(new Error('third_host_unavailable'))
    const result = await request('POST', body)
    expect(result.status).toBe(200)
    expect(result.response).toMatchObject({
      status: 'partial',
      source: { originValidation: 'two_provider' },
      stakedUsdatCondition: { existingTicketConversionQuote: null },
    })
    expect(readHolderExitAssessment).toHaveBeenCalledTimes(2)

    const withQuote = {
      ...core,
      stakedUsdatCondition: { ...core.stakedUsdatCondition, existingTicketConversionQuote: quote },
    }
    vi.mocked(readHolderExitAssessment)
      .mockReset()
      .mockResolvedValue(withQuote as never)
    const agreed = await request('POST', body)
    expect(agreed.status).toBe(200)
    expect(agreed.response).toMatchObject({
      stakedUsdatCondition: { existingTicketConversionQuote: quote },
    })

    vi.mocked(readHolderExitAssessment)
      .mockReset()
      .mockResolvedValueOnce(withQuote as never)
      .mockResolvedValueOnce(core as never)
      .mockResolvedValueOnce(withQuote as never)
    const onlyApprovedPair = await request('POST', body)
    expect(onlyApprovedPair.status).toBe(200)
    expect(onlyApprovedPair.response).toMatchObject({
      stakedUsdatCondition: { existingTicketConversionQuote: null },
    })
    expect(readHolderExitAssessment).toHaveBeenCalledTimes(2)
  })

  it.each([false, true])(
    'keeps same-source holdercore despite optionalquote/recordedfailure order=%s',
    async (reverse) => {
      const recorded = {
        sharesRaw18: '10000000000000000000',
        usdatOwedRaw6: '42103198',
        requestedAtUnix: '1790809200',
        minSharePriceRaw: '1040000',
        rawStatus: 3,
      }
      const core = {
        status: 'partial',
        source: source(),
        stages: [{ name: 'existing_ticket_claim', status: 'reverted', amountRaw: null }],
        stakedUsdatCondition: {
          existingTicketId: '1670',
          existingTicketOwnership: 'holder',
          existingTicketClaimStatus: 'evm_revert',
          existingTicketRequestedAtUnix: '1790809200',
          existingTicketConversionQuote: null,
        },
      }
      const quoted = {
        ...core,
        stakedUsdatCondition: {
          ...core.stakedUsdatCondition,
          existingTicketRecordedRequest: recorded,
          existingTicketConversionQuote: { status: 'conditional_quote', usdatInputRaw: '42103198' },
          existingTicketConversionBasis: 'recorded_owed_if_delivered',
          existingTicketConversionFeeStatus: 'unknown',
        },
      }
      const other = {
        ...core,
        stakedUsdatCondition: {
          ...core.stakedUsdatCondition,
          existingTicketRecordedRequest: null,
          existingTicketConversionBasis: null,
          existingTicketConversionFeeStatus: null,
        },
      }
      expect(sameHolderExitAssessment(quoted as never, other as never)).toBe(true)
      const pair = reverse ? [other, quoted] : [quoted, other]
      vi.mocked(readHolderExitAssessment)
        .mockReset()
        .mockResolvedValueOnce(pair[0] as never)
        .mockResolvedValueOnce(pair[1] as never)
      const result = await request('POST', body)
      expect(result.status).toBe(200)
      expect(result.response.stakedUsdatCondition).toMatchObject({
        existingTicketConversionQuote: null,
        existingTicketConversionBasis: null,
        existingTicketConversionFeeStatus: null,
        existingTicketRecordedRequest: null,
        existingTicketClaimStatus: 'evm_revert',
        existingTicketRequestedAtUnix: '1790809200',
      })
    },
  )
  it('independently agrees whole recordedtuple and clears quote+basis+fee on any disagreement', async () => {
    const recorded = {
      sharesRaw18: '10000000000000000000',
      usdatOwedRaw6: '42103198',
      requestedAtUnix: '1790809200',
      minSharePriceRaw: '1040000',
      rawStatus: 3,
    }
    const first = {
      status: 'partial',
      source: source(),
      stakedUsdatCondition: {
        existingTicketId: '1670',
        existingTicketClaimStatus: 'evm_revert',
        existingTicketRequestedAtUnix: '1790809200',
        existingTicketRecordedRequest: recorded,
        existingTicketConversionQuote: { status: 'conditional_quote', usdatInputRaw: '42103198' },
        existingTicketConversionBasis: 'recorded_owed_if_delivered',
        existingTicketConversionFeeStatus: 'unknown',
      },
    }
    for (const change of ['basis', 'fee', 'record', 'quote']) {
      const second = structuredClone(first)
      if (change === 'basis')
        second.stakedUsdatCondition.existingTicketConversionBasis = 'claim_return'
      if (change === 'fee')
        second.stakedUsdatCondition.existingTicketConversionFeeStatus = 'included_in_claim_return'
      if (change === 'record')
        second.stakedUsdatCondition.existingTicketRecordedRequest.usdatOwedRaw6 = '42103199'
      if (change === 'quote')
        second.stakedUsdatCondition.existingTicketConversionQuote = null as never
      expect(sameHolderExitAssessment(first as never, second as never)).toBe(true)
      vi.mocked(readHolderExitAssessment)
        .mockReset()
        .mockResolvedValueOnce(first as never)
        .mockResolvedValueOnce(second as never)
      const result = await request('POST', body)
      expect(result.status).toBe(200)
      expect(result.response.stakedUsdatCondition).toMatchObject({
        existingTicketConversionQuote: null,
        existingTicketConversionBasis: null,
        existingTicketConversionFeeStatus: null,
        existingTicketRecordedRequest: change === 'record' ? null : recorded,
      })
    }
    vi.mocked(readHolderExitAssessment)
      .mockReset()
      .mockResolvedValue(first as never)
    const agreed = await request('POST', body)
    expect(agreed.response.stakedUsdatCondition).toMatchObject(first.stakedUsdatCondition)
    for (const changed of [
      { ...first, owner: 'other' },
      { ...first, request: { assetsRaw: '1' } },
      { ...first, source: { ...first.source, blockHash: `0x${'b'.repeat(64)}` } },
    ])
      expect(sameHolderExitAssessment(first as never, changed as never)).toBe(false)
  })

  it('requires two hosts to agree before attaching optional Hastra queue state', async () => {
    vi.stubEnv(
      'RECORDER_RPC_URL',
      'https://first.example,https://second.example,https://third.example',
    )
    const core = {
      status: 'partial',
      source: source(),
      pyusdStakingCondition: { reason: 'prime_to_wylds_callable' },
    }
    const queue = {
      holder: owner,
      existingWyldsSharesRaw: '2000000',
      pendingSharesRaw: '1000000',
      pendingUsdcRaw: '990000',
      pendingSinceUnix: '1790800000',
      yieldPaused: false,
      yieldFrozen: false,
      redeemVault: owner,
      requestAssessed: false,
      completion: 'admin_gated_unassessed',
      usdcPayout: 'not_attested',
    }
    const withQueue = { ...core, pyusdYieldQueueCondition: queue }
    vi.mocked(readHolderExitAssessment)
      .mockReset()
      .mockResolvedValueOnce(withQueue as never)
      .mockResolvedValueOnce(withQueue as never)
    const agreed = await request('POST', body)
    expect(agreed.status).toBe(200)
    expect(agreed.response).toMatchObject({ pyusdYieldQueueCondition: queue })
    expect(readHolderExitAssessment).toHaveBeenCalledTimes(2)

    vi.mocked(readHolderExitAssessment)
      .mockReset()
      .mockResolvedValueOnce(withQueue as never)
      .mockResolvedValueOnce(core as never)
      .mockRejectedValueOnce(new Error('third_host_unavailable'))
    const partial = await request('POST', body)
    expect(partial.status).toBe(200)
    expect(
      (partial.response as { pyusdYieldQueueCondition?: unknown }).pyusdYieldQueueCondition,
    ).toBeUndefined()
  })

  it('requires provider agreement on the AUSD ticket request timestamp', () => {
    const core = {
      status: 'partial',
      source: source(),
      stakedUsdatCondition: {
        existingTicketId: '42',
        existingTicketRequestedAtUnix: '1790809200',
        existingTicketConversionQuote: null,
      },
    }
    const changed = {
      ...core,
      stakedUsdatCondition: {
        ...core.stakedUsdatCondition,
        existingTicketRequestedAtUnix: '1790809201',
      },
    }
    expect(sameHolderExitAssessment(core as never, changed as never)).toBe(false)
  })
})

describe('server holder mechanical envelope', () => {
  const clock = Date.parse('2026-10-07T12:00:00.000Z')
  const assessment = () => ({
    status: 'assessed',
    routeKey: market.routeKey,
    destinationAddress: market.destination,
    owner,
    request: {
      assetsRaw: '1000000',
      assetAddress: market.underlying,
      horizonHours: 24,
      sharesRaw: '7',
    },
    source: { ...source(), blockTime: new Date(clock).toISOString() },
    stages: [
      {
        name: 'withdrawal',
        relatedToRequest: true,
        status: 'simulated',
        assetAddress: market.underlying,
        amountRaw: '1000000',
      },
    ],
    finalPayout: { status: 'simulated', assetAddress: market.underlying, amountRaw: '1000000' },
    forecast: {
      status: 'unvalidated',
      futureExit: null,
      exitDurationHours: null,
      prospectiveValidated: false,
    },
  })
  it('computes from agreed native Q and preserves the complete auxiliary request', () => {
    const value = assessment()
    const response = holderExitAssessmentResponse(value as never, clock)
    expect(response.source.originValidation).toBe('two_provider')
    expect(response.mechanicalOutlook).toMatchObject({
      issuedAt: new Date(clock).toISOString(),
      horizonSeconds: 86400,
      assessmentRequest: value.request,
      outlook: {
        status: 'conditional',
        subject: { owner, assetsRaw: '1000000', assetAddress: market.underlying },
        prospectiveValidated: false,
      },
    })
    expect(response.forecast).toEqual(value.forecast)
  })
  it('rechecks source age at response time and retains the current assessment', () => {
    const value = assessment()
    const response = holderExitAssessmentResponse(value as never, clock + 1800001)
    expect(response.mechanicalOutlook?.outlook).toMatchObject({
      status: 'abstain',
      reason: 'source_stale',
    })
    expect(response.request).toEqual(value.request)
    expect(response.stages).toEqual(value.stages)
  })
  it('keeps an assessment if optional projection cannot be constructed', () => {
    const response = holderExitAssessmentResponse(
      { status: 'assessed', source: source() } as never,
      clock,
    )
    expect(response.status).toBe('assessed')
    expect(response.mechanicalOutlook).toBeUndefined()
  })
})
