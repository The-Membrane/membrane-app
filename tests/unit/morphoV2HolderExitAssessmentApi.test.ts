import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPublicClient, http, encodeFunctionData, encodeFunctionResult, parseAbi } from 'viem'

import {
  readHolderExitAssessment,
  type HolderExitAssessment,
} from '@/lib/carry/holderExitAssessment'
import { decodeMorphoV2HolderPositionEvidence } from '@/lib/carry/morphoV2HolderPositionEvidence'
import {
  holderPositionTransportObservation,
  transportSharesRaw,
} from './fixtures/morphoV2HolderPositionTransportFixture'
import { buildHolderExitCapacityQuote } from '@/lib/carry/holderExitCapacity'
import { readMorphoV2CurrentProtocolOrigin } from '@/lib/carry/morphoV2CurrentProtocolCapacityEvidence'
import { readMorphoV2HistoricalHolderEaOrigin } from '@/lib/carry/morphoV2HistoricalHolderEaReader.server'
import { resolveMorphoV2TrustedProfile } from '@/lib/carry/morphoV2TrustedProfiles'
import { createMorphoV2UsdtProtocolCapacityFixture } from './fixtures/morphoV2UsdtProtocolCapacityFixture'
import {
  decodeMorphoV2HistoricalHolderEaEvidencePair,
  morphoV2HistoricalHolderEaCalldata,
  selectMorphoV2HistoricalHolderEaAnchors,
} from '@/lib/carry/morphoV2HistoricalHolderEaEvidence'
import { historicalEaUint } from './fixtures/morphoV2HistoricalHolderEaFixture'
import { checkRateLimit } from '@/lib/game/rateLimit'
import handler from '@/pages/api/carry/holder-exit-assessment'
import { createMorphoV2ProtocolCapacityFixture } from './fixtures/morphoV2ProtocolCapacityFixture'

const boundary = vi.hoisted(() => ({
  clients: [{ testClient: 1 }, { testClient: 2 }],
  urls: ['https://first.example', 'https://second.example'],
}))
vi.mock('viem', async (original) => ({
  ...(await original<typeof import('viem')>()),
  createPublicClient: vi.fn(),
  http: vi.fn((url, options) => ({ url, options })),
}))
vi.mock('@/lib/carry/holderExitAssessment', async (original) => ({
  ...(await original<typeof import('@/lib/carry/holderExitAssessment')>()),
  readHolderExitAssessment: vi.fn(),
}))
// Prevent importing the server reader from replaying the full archive during API tests.
vi.mock('@/lib/carry/morphoV2CurrentProtocolCapacityEvidence', () => ({
  prewarmMorphoV2ProtocolHistory: vi.fn().mockResolvedValue(true),
  readMorphoV2CurrentProtocolOrigin: vi.fn().mockResolvedValue(null),
}))
vi.mock('@/lib/carry/morphoV2HistoricalHolderEaReader.server', () => ({
  readMorphoV2HistoricalHolderEaOrigin: vi.fn().mockResolvedValue(null),
}))
vi.mock('@/scripts/research/carry-depth-quote-archive.mjs', () => ({
  readProviderPolicy: () => ({ status: 'active' }),
  configuredProviders: () => boundary.urls.map((url) => ({ url, host: new URL(url).hostname })),
}))
vi.mock('@/lib/game/rateLimit', () => ({
  checkRateLimit: vi.fn(),
  getClientIp: () => '127.0.0.1',
}))

const asset = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const body = {
  routeKey: 'USDC → VaultV2 [USDC]',
  destinationAddress: '0x0026038a7fefef439d94bd99b4a10017e839d3a7',
  owner: '0x0000000000000000000000000000000000000001',
  assetsRaw: '1000000',
  horizonHours: 24,
  chainId: 1,
}
// Synthetic holder entitlement E is independent of saved protocol bytes, requested Q and maxWithdraw.
const entitlementRaw = '9000000000'
function assessments(assetName: 'USDC' | 'USDT' = 'USDC') {
  const { pair, expected } =
    assetName === 'USDT'
      ? createMorphoV2UsdtProtocolCapacityFixture()
      : createMorphoV2ProtocolCapacityFixture()
  const input =
    assetName === 'USDT'
      ? {
          ...body,
          routeKey: 'USDT → VaultV2 [USDT]',
          destinationAddress: '0x23f5e9c35820f4bab695ac1f19c203cc3f8e1e11',
        }
      : body
  const assetAddress = assetName === 'USDT' ? '0xdac17f958d2ee523a2206206994597c13d831ec7' : asset
  const results = pair.origins.map(({ observation }) => {
    const a = {
      status: 'assessed',
      routeKey: input.routeKey,
      destinationAddress: input.destinationAddress,
      owner: body.owner,
      request: { assetsRaw: body.assetsRaw, assetAddress, horizonHours: body.horizonHours },
      source: { ...expected.source, originValidation: 'single_provider' },
      stages: [
        {
          name: 'withdrawal',
          status: 'simulated',
          relatedToRequest: true,
          assetAddress,
          amountRaw: body.assetsRaw,
        },
      ],
      finalPayout: { status: 'simulated', assetAddress, amountRaw: body.assetsRaw },
      morphoV2ProtocolCapacityObservation: structuredClone(observation),
    } as unknown as HolderExitAssessment & {
      morphoV2ProtocolCapacityObservation?: typeof observation
    }
    a.capacityQuote = buildHolderExitCapacityQuote(
      a,
      {
        entitlementRaw,
        quotedMaxWithdrawRaw: '2000000',
        quotedMaxWithdrawStatus: 'quoted',
        effectiveLimitRaw: null,
        withdrawalsPaused: null,
      },
      expected.asOfMs,
    )!
    expect(a.capacityQuote).not.toBeNull()
    return a
  })
  return { results, expected, input, assetAddress }
}
async function request(value: unknown = body) {
  let status = 0
  let response: Record<string, any> = {}
  const res = {
    setHeader: vi.fn(),
    status: vi.fn((code: number) => {
      status = code
      return res
    }),
    json: vi.fn((data: Record<string, any>) => {
      response = data
      return res
    }),
  }
  await handler(
    { method: 'POST', body: value, headers: {}, socket: { remoteAddress: '127.0.0.1' } } as never,
    res as never,
  )
  return { status, response }
}
function serve(results: ReturnType<typeof assessments>['results']) {
  for (const result of results) {
    const { morphoV2ProtocolCapacityObservation, ...required } = result
    vi.mocked(readHolderExitAssessment).mockResolvedValueOnce(required)
    vi.mocked(readMorphoV2CurrentProtocolOrigin).mockResolvedValueOnce(
      morphoV2ProtocolCapacityObservation ?? null,
    )
  }
}

describe('Morpho VaultV2 holder API native protocol evidence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(readHolderExitAssessment).mockReset()
    vi.mocked(readMorphoV2CurrentProtocolOrigin).mockReset()
    vi.mocked(readMorphoV2HistoricalHolderEaOrigin).mockReset().mockResolvedValue(null)
    vi.mocked(createPublicClient)
      .mockReset()
      .mockReturnValueOnce(boundary.clients[0] as never)
      .mockReturnValueOnce(boundary.clients[1] as never)
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true })
    // Saved dated capture is replayed at its original clock; this does not assert live freshness.
    const { expected } = createMorphoV2ProtocolCapacityFixture()
    vi.spyOn(Date, 'now').mockReturnValue(expected.asOfMs)
  })
  afterEach(() => vi.restoreAllMocks())

  it('returns compact native agreement and preserves independent full holder E', async () => {
    const { results } = assessments()
    serve(results)
    const { status, response } = await request()
    expect(status).toBe(200)
    expect(response.executionAgreement).toBeDefined()
    expect(response.morphoV2CurrentProtocolCapacityEvidence).toBeDefined()
    expect(response.morphoV2ProtocolCapacityObservation).toBeUndefined()
    expect(response.capacityAgreement.quote).toMatchObject({
      entitlementRaw,
      requestedRaw: body.assetsRaw,
      quotedMaxWithdrawRaw: '2000000',
      asset,
      assetDecimals: 6,
      holderExecutableExit: false,
    })
    expect(http).toHaveBeenNthCalledWith(1, boundary.urls[0], { timeout: 8000, retryCount: 0 })
    expect(http).toHaveBeenNthCalledWith(2, boundary.urls[1], { timeout: 8000, retryCount: 0 })
    expect(createPublicClient).toHaveBeenCalledTimes(2)
    for (const [i, [clients]] of vi.mocked(readHolderExitAssessment).mock.calls.entries()) {
      expect(clients.morpho).toBe(boundary.clients[i])
      expect(clients.direct).toBe(boundary.clients[i])
    }
    const { expected } = createMorphoV2ProtocolCapacityFixture()
    for (const [i, [client, source, options]] of vi
      .mocked(readMorphoV2CurrentProtocolOrigin)
      .mock.calls.entries()) {
      expect(client).toBe(boundary.clients[i])
      expect(source).toEqual(expected.source)
      expect(options).toEqual({
        deadlineMs: 8000,
        profile: resolveMorphoV2TrustedProfile(body.routeKey, body.destinationAddress, asset),
      })
    }
    const requiredOrder = vi.mocked(readHolderExitAssessment).mock.invocationCallOrder
    const optionalOrder = vi.mocked(readMorphoV2CurrentProtocolOrigin).mock.invocationCallOrder
    expect(requiredOrder[0]).toBeLessThan(optionalOrder[0])
    expect(requiredOrder[1]).toBeLessThan(optionalOrder[0])
    expect(requiredOrder[1]).toBeLessThan(optionalOrder[1])
    expect(JSON.stringify(response)).not.toContain('testClient')
  })

  it.each(['missing', 'disagree', 'late', 'current_unknown', 'header', 'asset', 'source'] as const)(
    'keeps base assessment when optional native observation is %s',
    async (fault) => {
      const { results } = assessments()
      const observation = results[1].morphoV2ProtocolCapacityObservation!
      if (fault === 'missing') delete results[1].morphoV2ProtocolCapacityObservation
      if (fault === 'disagree') observation.traces.find((t) => t.key === 'market')!.result = '0x'
      if (fault === 'late')
        observation.readAtUtc = new Date(Date.parse(observation.startedAtUtc) + 8001).toISOString()
      if (fault === 'current_unknown')
        observation.traces.find((t) => t.key === 'market')!.result = null
      if (fault === 'header')
        (
          observation.traces.find((t) => t.key === 'header_after')!.result as { hash: string }
        ).hash = `0x${'f'.repeat(64)}`
      if (fault === 'asset')
        observation.traces.find((t) => t.key === 'asset')!.result = `0x${'0'.repeat(64)}`
      if (fault === 'source') observation.source.blockHash = `0x${'f'.repeat(64)}`
      serve(results)
      const { status, response } = await request()
      expect(status).toBe(200)
      expect(response.capacityAgreement.quote.entitlementRaw).toBe(entitlementRaw)
      expect(response.morphoV2CurrentProtocolCapacityEvidence).toBeUndefined()
      expect(response.morphoV2ProtocolCapacityObservation).toBeUndefined()
    },
  )

  it.each(['owner', 'requestedRaw', 'asset', 'assetDecimals', 'source'] as const)(
    'omits optional protocol evidence for an incorrectly bound capacity %s',
    async (field) => {
      const { results } = assessments()
      for (const result of results) {
        const quote = result.capacityQuote!
        if (field === 'owner') quote.owner = '0x0000000000000000000000000000000000000002'
        if (field === 'requestedRaw') quote.requestedRaw = '2'
        if (field === 'asset') quote.asset = '0x0000000000000000000000000000000000000002'
        if (field === 'assetDecimals') quote.assetDecimals = 18
        if (field === 'source') quote.source.blockHash = `0x${'f'.repeat(64)}`
      }
      serve(results)
      const { status, response } = await request()
      expect(status).toBe(200)
      expect(response.request.assetsRaw).toBe(body.assetsRaw)
      expect(response.source.blockHash).toBe(results[0].source.blockHash)
      expect(response.morphoV2CurrentProtocolCapacityEvidence).toBeUndefined()
      expect(response.morphoV2ProtocolCapacityObservation).toBeUndefined()
    },
  )

  function withHolderObservations(assetName: 'USDC' | 'USDT' = 'USDC') {
    const fixture = assessments(assetName)
    for (const result of fixture.results) {
      result.capacityQuote!.sourceHolderPosition = {
        sharesRaw: transportSharesRaw,
        shareDecimals: 18,
        method: 'balance_of_owner_at_source',
      }
      result.morphoHolderPositionObservation = holderPositionTransportObservation(
        fixture.expected.source,
        fixture.expected.asOfMs,
      )
      result.morphoHolderPositionObservation.routeKey = fixture.input.routeKey
      result.morphoHolderPositionObservation.destination = fixture.input
        .destinationAddress as `0x${string}`
      result.morphoHolderPositionObservation.asset = fixture.assetAddress as `0x${string}`
      for (const trace of result.morphoHolderPositionObservation.traces)
        trace.params[0].to = fixture.input.destinationAddress as `0x${string}`
    }
    return fixture
  }

  function historicalObservations(fixture: ReturnType<typeof withHolderObservations>) {
    const profile = resolveMorphoV2TrustedProfile(
      fixture.input.routeKey,
      fixture.input.destinationAddress,
      fixture.assetAddress,
    )!
    const anchors = selectMorphoV2HistoricalHolderEaAnchors(profile, fixture.expected.source)
    const utc = (offset: number) => new Date(fixture.expected.asOfMs - 500 + offset).toISOString()
    const observation = {
      schemaVersion: 1 as const,
      kind: 'morpho_v2_historical_holder_ea_origin_v1' as const,
      profileId: profile.id,
      ...profile.subject,
      destination: profile.subject.destination as `0x${string}`,
      asset: profile.subject.asset as `0x${string}`,
      currentSource: structuredClone(fixture.expected.source),
      sharesRaw: transportSharesRaw,
      startedAtUtc: utc(0),
      readAtUtc: utc(250),
      deadlineMs: 12000,
      traces: anchors.map((point, index) => ({
        source: structuredClone(point.source),
        key: 'previewRedeem' as const,
        method: 'eth_call' as const,
        params: [
          {
            to: profile.subject.destination as `0x${string}`,
            data: morphoV2HistoricalHolderEaCalldata(transportSharesRaw),
          },
          { blockHash: point.source.blockHash as `0x${string}`, requireCanonical: true as const },
        ] as [
          { to: `0x${string}`; data: `0x${string}` },
          { blockHash: `0x${string}`; requireCanonical: true },
        ],
        result: historicalEaUint(9000000000n + BigInt(index)),
        startedAtUtc: utc(index * 20),
        completedAtUtc: utc((index + 1) * 20),
      })),
    }
    return { profile, observations: [structuredClone(observation), structuredClone(observation)] }
  }

  it.each([
    ['USDC', 200],
    ['USDT', 200],
    ['USDC', 503],
    ['USDT', 503],
  ] as const)(
    'collects and transports %s historical full S on HTTP%s after both current pairs agree',
    async (assetName, expectedStatus) => {
      const fixture = withHolderObservations(assetName)
      if (expectedStatus === 503) fixture.results[1].finalPayout.amountRaw = '999999'
      vi.mocked(Date.now).mockReturnValue(fixture.expected.asOfMs)
      const { profile, observations } = historicalObservations(fixture)
      vi.mocked(readMorphoV2HistoricalHolderEaOrigin)
        .mockResolvedValueOnce(observations[0])
        .mockResolvedValueOnce(observations[1])
      serve(fixture.results)
      const { status, response } = await request(fixture.input)
      expect(status).toBe(expectedStatus)
      if (expectedStatus === 503) {
        expect(response.error).toBe('holder_exit_assessment_unavailable')
        expect(response.executionAgreement).toBeUndefined()
        expect(response.source).toBeUndefined()
        expect(response.holderExecutableExit).toBeUndefined()
      }
      expect(response.capacityAgreement.quote).toMatchObject({
        entitlementRaw,
        requestedRaw: fixture.input.assetsRaw,
        asset: fixture.assetAddress,
        assetDecimals: 6,
        holderExecutableExit: false,
        sourceHolderPosition: { sharesRaw: transportSharesRaw, shareDecimals: 18 },
      })
      expect(response.morphoV2CurrentProtocolCapacityEvidence).toBeDefined()
      expect(response.morphoV2CurrentHolderPositionEvidence).toBeDefined()
      const currentHolder = decodeMorphoV2HolderPositionEvidence(
        response.morphoV2CurrentHolderPositionEvidence,
      )
      expect(currentHolder.origins.map((origin) => origin.observation)).toEqual(
        fixture.results.map((result) => result.morphoHolderPositionObservation),
      )
      const historic = decodeMorphoV2HistoricalHolderEaEvidencePair(
        response.morphoV2HistoricalHolderEaEvidence,
      )
      expect(historic?.origins.map((origin) => origin.observation)).toEqual(observations)
      expect(historic?.origins.map((origin) => origin.observation.sharesRaw)).toEqual([
        transportSharesRaw,
        transportSharesRaw,
      ])
      expect(historic?.origins.map((origin) => origin.host)).toEqual([
        'first.example',
        'second.example',
      ])
      expect(response.morphoV2HistoricalHolderEaObservation).toBeUndefined()
      for (const field of [
        'morphoV2ProtocolCapacityObservation',
        'morphoHolderPositionObservation',
        'morphoV2HistoricalHolderEaObservation',
      ])
        expect(JSON.stringify(response)).not.toContain(field)
      const calls = vi.mocked(readMorphoV2HistoricalHolderEaOrigin).mock.calls
      expect(calls).toHaveLength(2)
      for (const [index, [client, source, options]] of calls.entries()) {
        expect(client).toBe(boundary.clients[index])
        expect(source).toEqual(fixture.expected.source)
        expect(options.profile).toBe(profile)
        expect(options.sharesRaw).toBe(transportSharesRaw)
        expect(options.sharesRaw).not.toBe(body.assetsRaw)
      }
      expect(
        vi.mocked(readMorphoV2HistoricalHolderEaOrigin).mock.invocationCallOrder[0],
      ).toBeGreaterThan(vi.mocked(readMorphoV2CurrentProtocolOrigin).mock.invocationCallOrder[1])
      const requiredOrder = vi.mocked(readHolderExitAssessment).mock.invocationCallOrder
      expect(requiredOrder).toHaveLength(2)
      for (const order of vi.mocked(readMorphoV2CurrentProtocolOrigin).mock.invocationCallOrder)
        expect(order).toBeGreaterThan(requiredOrder[1])
      for (const order of vi.mocked(readMorphoV2HistoricalHolderEaOrigin).mock.invocationCallOrder)
        expect(order).toBeGreaterThan(requiredOrder[1])
    },
  )

  it.each(
    (['USDC', 'USDT'] as const).flatMap((assetName) =>
      (
        [
          'missing protocol',
          'disagreeing protocol',
          'missing holder',
          'disagreeing holder',
          'disagreeing required capacity',
        ] as const
      ).map((fault) => [assetName, fault] as const),
    ),
  )('does not read %s historical full S on capacity-only 503 with %s', async (assetName, fault) => {
    const fixture = withHolderObservations(assetName)
    vi.mocked(Date.now).mockReturnValue(fixture.expected.asOfMs)
    fixture.results[1].finalPayout.amountRaw = '999999'
    const { observations } = historicalObservations(fixture)
    vi.mocked(readMorphoV2HistoricalHolderEaOrigin)
      .mockResolvedValueOnce(observations[0])
      .mockResolvedValueOnce(observations[1])
    if (fault === 'missing protocol') delete fixture.results[1].morphoV2ProtocolCapacityObservation
    if (fault === 'disagreeing protocol') {
      const trace = fixture.results[1].morphoV2ProtocolCapacityObservation!.traces.find(
        (t) => t.key === 'idleCash',
      )!
      trace.result = historicalEaUint(BigInt(trace.result as `0x${string}`) + 1n)
    }
    if (fault === 'missing holder') delete fixture.results[1].morphoHolderPositionObservation
    if (fault === 'disagreeing holder')
      fixture.results[1].morphoHolderPositionObservation!.traces[0].result = historicalEaUint(
        BigInt(transportSharesRaw) + 1n,
      )
    if (fault === 'disagreeing required capacity')
      fixture.results[1].capacityQuote!.entitlementRaw = '8000000000'
    serve(fixture.results)
    const { status, response } = await request(fixture.input)
    expect(status).toBe(503)
    expect(response.executionAgreement).toBeUndefined()
    expect(response.morphoV2HistoricalHolderEaEvidence).toBeUndefined()
    expect(readMorphoV2HistoricalHolderEaOrigin).not.toHaveBeenCalled()
    if (fault === 'disagreeing required capacity')
      expect(readMorphoV2CurrentProtocolOrigin).not.toHaveBeenCalled()
    for (const field of [
      'morphoV2ProtocolCapacityObservation',
      'morphoHolderPositionObservation',
      'morphoV2HistoricalHolderEaObservation',
    ])
      expect(JSON.stringify(response)).not.toContain(field)
  })

  it.each([
    'missing protocol',
    'missing holder',
    'disagreeing history',
    'wrong historical S',
    'missing history',
  ] as const)(
    'preserves the base assessment and omits historical transport for %s',
    async (fault) => {
      const fixture = withHolderObservations()
      const { observations } = historicalObservations(fixture)
      if (fault === 'missing protocol')
        delete fixture.results[1].morphoV2ProtocolCapacityObservation
      if (fault === 'missing holder') delete fixture.results[1].morphoHolderPositionObservation
      if (fault === 'disagreeing history') observations[1].traces[0].result = historicalEaUint(1n)
      if (fault === 'wrong historical S') observations[1].sharesRaw = '1'
      vi.mocked(readMorphoV2HistoricalHolderEaOrigin)
        .mockResolvedValueOnce(fault === 'missing history' ? null : observations[0])
        .mockResolvedValueOnce(observations[1])
      serve(fixture.results)
      const { status, response } = await request()
      expect(status).toBe(200)
      expect(response.capacityAgreement.quote.entitlementRaw).toBe(entitlementRaw)
      expect(response.morphoV2HistoricalHolderEaEvidence).toBeUndefined()
      if (fault === 'missing protocol' || fault === 'missing holder')
        expect(readMorphoV2HistoricalHolderEaOrigin).not.toHaveBeenCalled()
      if (fault === 'missing history')
        expect(readMorphoV2HistoricalHolderEaOrigin).toHaveBeenCalledTimes(1)
    },
  )

  it.each([200, 503])(
    'encodes both configured holder origins on %s without exposing private traces',
    async (status) => {
      const { results } = withHolderObservations()
      if (status === 503) results[1].finalPayout.amountRaw = '999999'
      serve(results)
      const response = await request()
      expect(response.status).toBe(status)
      const pair = decodeMorphoV2HolderPositionEvidence(
        response.response.morphoV2CurrentHolderPositionEvidence,
      )
      expect(pair.origins.map((origin) => origin.host)).toEqual(['first.example', 'second.example'])
      expect(pair.origins.map((origin) => origin.observation)).toEqual(
        results.map((result) => result.morphoHolderPositionObservation),
      )
      expect(response.response.capacityAgreement.quote.entitlementRaw).toBe(entitlementRaw)
      expect(response.response.capacityAgreement.quote.requestedRaw).toBe(body.assetsRaw)
      expect(response.response.morphoV2CurrentProtocolCapacityEvidence).toBeDefined()
      expect(response.response.morphoHolderPositionObservation).toBeUndefined()
      expect(response.response.morphoV2ProtocolCapacityObservation).toBeUndefined()
    },
  )

  it.each([
    'first_missing',
    'second_missing',
    'source',
    'owner',
    'S',
    'Ea',
    'asset',
    'asset_units',
    'share_units',
    'quote_owner',
    'quote_S',
    'quote_Ea',
    'Q_as_Ea',
    'Q_as_S',
    'preview_Q',
    'subject',
  ] as const)('omits holder transport on %s while preserving public response', async (fault) => {
    const { results } = withHolderObservations()
    const observation = results[1].morphoHolderPositionObservation!
    const abi = parseAbi([
      'function balanceOf(address) view returns (uint256)',
      'function previewRedeem(uint256) view returns (uint256)',
    ])
    if (fault === 'first_missing') delete results[0].morphoHolderPositionObservation
    if (fault === 'second_missing') delete results[1].morphoHolderPositionObservation
    if (fault === 'source') observation.source.blockHash = `0x${'f'.repeat(64)}`
    if (fault === 'owner')
      observation.traces[0].params[0].data = encodeFunctionData({
        abi,
        functionName: 'balanceOf',
        args: ['0x0000000000000000000000000000000000000002'],
      })
    if (fault === 'S' || fault === 'Q_as_S')
      observation.traces[0].result = encodeFunctionResult({
        abi,
        functionName: 'balanceOf',
        result: BigInt(body.assetsRaw),
      })
    if (fault === 'Ea' || fault === 'Q_as_Ea')
      observation.traces[1].result = encodeFunctionResult({
        abi,
        functionName: 'previewRedeem',
        result: BigInt(body.assetsRaw),
      })
    if (fault === 'preview_Q')
      observation.traces[1].params[0].data = encodeFunctionData({
        abi,
        functionName: 'previewRedeem',
        args: [BigInt(body.assetsRaw)],
      })
    if (fault === 'asset') observation.asset = '0x0000000000000000000000000000000000000002'
    if (fault === 'asset_units') observation.assetDecimals = 18
    if (fault === 'share_units') observation.shareDecimals = 6
    if (fault === 'subject') observation.routeKey = 'USDT → VaultV2 [USDT]'
    for (const result of results) {
      if (fault === 'quote_owner')
        result.capacityQuote!.owner = '0x0000000000000000000000000000000000000002'
      if (fault === 'quote_S') result.capacityQuote!.sourceHolderPosition!.sharesRaw = '1'
      if (fault === 'quote_Ea') result.capacityQuote!.entitlementRaw = '1'
    }
    serve(results)
    const { status, response } = await request()
    expect(status).toBe(200)
    expect(response.morphoV2CurrentHolderPositionEvidence).toBeUndefined()
    expect(response.morphoHolderPositionObservation).toBeUndefined()
    expect(response.morphoV2ProtocolCapacityObservation).toBeUndefined()
    expect(response.request.assetsRaw).toBe(body.assetsRaw)
  })

  it('uses the configured distinct origins and ignores evidence-supplied authority', async () => {
    const { results } = withHolderObservations()
    boundary.urls = ['https://first.example/a', 'https://first.example/b']
    try {
      serve(results)
      const { response } = await request()
      expect(response.morphoV2CurrentHolderPositionEvidence).toBeUndefined()
      expect(response.morphoHolderPositionObservation).toBeUndefined()
    } finally {
      boundary.urls = ['https://first.example', 'https://second.example']
    }
  })

  it('preserves the legacy public shape when retained holder observations are absent', async () => {
    const { results } = assessments()
    serve(results)
    const { status, response } = await request()
    expect(status).toBe(200)
    expect(response.morphoV2CurrentHolderPositionEvidence).toBeUndefined()
    expect(response.morphoHolderPositionObservation).toBeUndefined()
    expect(response.capacityAgreement.quote.sourceHolderPosition).toBeUndefined()
  })

  it('preserves E and protocol evidence on 503 without claiming agreed execution', async () => {
    const { results } = assessments()
    results[1].finalPayout.amountRaw = '999999'
    serve(results)
    const { status, response } = await request()
    expect(status).toBe(503)
    expect(response.capacityAgreement.quote.entitlementRaw).toBe(entitlementRaw)
    expect(response.morphoV2CurrentProtocolCapacityEvidence).toBeDefined()
    expect(response.source).toBeUndefined()
    expect(response.executionAgreement).toBeUndefined()
    expect(response.holderExecutableExit).toBeUndefined()
    expect(response.morphoV2ProtocolCapacityObservation).toBeUndefined()
  })

  it('does not issue protocol evidence when full holder E is not independently agreed', async () => {
    const { results } = assessments()
    results[1].capacityQuote!.entitlementRaw = '8000000000'
    serve(results)
    const { status, response } = await request()
    expect(status).toBe(200)
    expect(response.executionAgreement).toBeDefined()
    expect(response.capacityAgreement).toBeUndefined()
    expect(response.morphoV2CurrentProtocolCapacityEvidence).toBeUndefined()
    expect(readMorphoV2CurrentProtocolOrigin).not.toHaveBeenCalled()
  })

  it.each([
    { includeMorphoV2ProtocolCapacityEvidence: true },
    { morphoV2CurrentProtocolCapacityEvidence: { approved: true } },
    { morphoV2ProtocolCapacityObservation: { approved: true } },
  ])('rejects caller supplied native flags or approvals %j', async (extra) => {
    expect((await request({ ...body, ...extra })).status).toBe(400)
    expect(readHolderExitAssessment).not.toHaveBeenCalled()
  })

  it('finishes both required checkpoints before an optional await advances the finalized head', async () => {
    const { results, expected } = assessments()
    let checkpointAdvanced = false,
      requiredReads = 0,
      optionalReads = 0
    vi.mocked(readHolderExitAssessment).mockImplementation(async () => {
      const selected = structuredClone(results[requiredReads++])
      delete selected.morphoV2ProtocolCapacityObservation
      if (checkpointAdvanced) {
        selected.source.blockNumber += 1
        selected.source.blockHash = `0x${'f'.repeat(64)}`
      }
      return selected
    })
    vi.mocked(readMorphoV2CurrentProtocolOrigin).mockImplementation(async () => {
      expect(requiredReads).toBe(2)
      if (optionalReads === 0) {
        await Promise.resolve()
        checkpointAdvanced = true
        vi.mocked(Date.now).mockReturnValue(expected.asOfMs + 8000)
      }
      return results[optionalReads++].morphoV2ProtocolCapacityObservation!
    })
    const { status, response } = await request()
    expect(status).toBe(200)
    expect(requiredReads).toBe(2)
    expect(optionalReads).toBe(2)
    expect(response.source.blockNumber).toBe(expected.source.blockNumber)
    expect(response.executionAgreement).toBeDefined()
    expect(response.capacityAgreement.quote.entitlementRaw).toBe(entitlementRaw)
    expect(response.morphoV2CurrentProtocolCapacityEvidence).toBeDefined()
  })
})
