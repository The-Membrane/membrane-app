import { readFileSync } from 'node:fs'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPublicClient } from 'viem'

import { readHolderExitAssessment } from '@/lib/carry/holderExitAssessment'
import { decodeMorphoV2HolderPositionEvidence } from '@/lib/carry/morphoV2HolderPositionEvidence'
import { holderPositionTransportObservation } from './fixtures/morphoV2HolderPositionTransportFixture'
import { readMorphoExitQuote } from '@/lib/carry/morphoExitQuote'
import { readMorphoV2CurrentProtocolOrigin } from '@/lib/carry/morphoV2CurrentProtocolCapacityEvidence'
import { checkRateLimit } from '@/lib/game/rateLimit'
import handler from '@/pages/api/carry/holder-exit-assessment'
import { createMorphoV2ProtocolCapacityFixture } from './fixtures/morphoV2ProtocolCapacityFixture'

const boundary = vi.hoisted(() => ({ clients: [{ request: vi.fn() }, { request: vi.fn() }] }))
vi.mock('viem', async (original) => ({
  ...(await original<typeof import('viem')>()),
  createPublicClient: vi.fn(),
}))
vi.mock('@/lib/carry/morphoExitQuote', async (original) => ({
  ...(await original<typeof import('@/lib/carry/morphoExitQuote')>()),
  readMorphoExitQuote: vi.fn(),
}))
vi.mock('@/lib/carry/morphoV2CurrentProtocolCapacityEvidence', () => ({
  prewarmMorphoV2ProtocolHistory: vi.fn().mockResolvedValue(true),
  readMorphoV2CurrentProtocolOrigin: vi.fn(),
}))
vi.mock('@/scripts/research/carry-depth-quote-archive.mjs', () => ({
  readProviderPolicy: () => ({ status: 'active' }),
  configuredProviders: () =>
    ['https://first.example', 'https://second.example'].map((url) => ({ url })),
}))
vi.mock('@/lib/game/rateLimit', () => ({
  checkRateLimit: vi.fn(),
  getClientIp: () => '127.0.0.1',
}))
const asset = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as const
const input = {
  routeKey: 'USDC → VaultV2 [USDC]',
  destinationAddress: '0x0026038a7fefef439d94bd99b4a10017e839d3a7' as const,
  owner: '0x0000000000000000000000000000000000000001' as const,
  assetsRaw: '1000000',
  horizonHours: 24,
  chainId: 1 as const,
}
// Holder E is synthetic and independent of the dated saved protocol observation.
const entitlementRaw = '9000000000'
function quote() {
  const { expected } = createMorphoV2ProtocolCapacityFixture()
  return {
    status: 'checked_at_finalized_block',
    routeKey: input.routeKey,
    source: { ...expected.source, observedAt: new Date(expected.asOfMs).toISOString() },
    vault: {
      address: input.destinationAddress,
      assetAddress: asset,
      assetDecimals: 6,
      shareDecimals: 18,
    },
    position: {
      sharesRaw: '9000000000000000000000',
      previewRedeemAssetsRaw: entitlementRaw,
      maxWithdrawQuote: { status: 'quoted', amountRaw: '2000000' },
    },
    request: { assetsRaw: input.assetsRaw },
    simulation: { status: 'success', sharesBurnedRaw: '1000000000000000000' },
  }
}
function serve(
  value: ReturnType<typeof quote> & {
    morphoHolderPositionObservation?: ReturnType<typeof holderPositionTransportObservation>
  } = quote(),
) {
  vi.mocked(readMorphoExitQuote).mockResolvedValue(value as never)
}
async function request(value: unknown = input) {
  let status = 0
  let response: Record<string, any> = {}
  const res = {
    setHeader: vi.fn(),
    status(code: number) {
      status = code
      return this
    },
    json(data: Record<string, any>) {
      response = data
      return this
    },
  }
  await handler(
    { method: 'POST', body: value, headers: {}, socket: { remoteAddress: '127.0.0.1' } } as never,
    res as never,
  )
  return { status, response }
}

describe('server API required Morpho quote before optional native evidence', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    const { pair, expected } = createMorphoV2ProtocolCapacityFixture()
    vi.spyOn(Date, 'now').mockReturnValue(expected.asOfMs)
    for (const client of boundary.clients) client.request.mockResolvedValue('0x')
    vi.mocked(createPublicClient).mockImplementation(
      () => boundary.clients[(vi.mocked(createPublicClient).mock.calls.length - 1) % 2] as never,
    )
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true })
    serve()
    vi.mocked(readMorphoV2CurrentProtocolOrigin)
      .mockResolvedValueOnce(pair.origins[0].observation)
      .mockResolvedValueOnce(pair.origins[1].observation)
  })
  afterEach(() => vi.restoreAllMocks())

  it('reads once per origin on the required client and source after quote and raw EOA validation', async () => {
    const { expected } = createMorphoV2ProtocolCapacityFixture()
    const { status, response } = await request()
    expect(status).toBe(200)
    expect(response.capacityAgreement.quote).toMatchObject({
      entitlementRaw,
      quotedMaxWithdrawRaw: '2000000',
      requestedRaw: input.assetsRaw,
    })
    expect(readMorphoV2CurrentProtocolOrigin).toHaveBeenCalledTimes(2)
    for (const [i, call] of vi.mocked(readMorphoV2CurrentProtocolOrigin).mock.calls.entries())
      expect(call).toEqual([boundary.clients[i], expected.source, { deadlineMs: 8000 }])
    const quoteOrder = vi.mocked(readMorphoExitQuote).mock.invocationCallOrder
    const ownerOrder = boundary.clients.map((client) => client.request.mock.invocationCallOrder[0])
    const optionalOrder = vi.mocked(readMorphoV2CurrentProtocolOrigin).mock.invocationCallOrder
    for (let i = 0; i < 2; i++) {
      expect(quoteOrder[i]).toBeLessThan(ownerOrder[i])
      expect(ownerOrder[i]).toBeLessThan(optionalOrder[i])
      expect(boundary.clients[i].request.mock.calls[0]).toEqual([
        {
          method: 'eth_getCode',
          params: [input.owner, { blockHash: expected.source.blockHash, requireCanonical: true }],
        },
      ])
    }
    expect(quoteOrder[1]).toBeLessThan(optionalOrder[0])
    expect(response.morphoV2CurrentProtocolCapacityEvidence).toBeDefined()
    expect(response.morphoV2ProtocolCapacityObservation).toBeUndefined()
  })

  it('retains the actual reader observation privately and transports both origins through the API', async () => {
    const { expected } = createMorphoV2ProtocolCapacityFixture()
    const observation = holderPositionTransportObservation(expected.source, expected.asOfMs)
    const value = { ...quote(), morphoHolderPositionObservation: observation }
    serve(value)
    const client = boundary.clients[0] as never
    const assessment = await readHolderExitAssessment(
      {
        morpho: client,
        direct: client,
        tracked: client,
        receipt: client,
        cooldown: client,
        stakedUsdat: client,
        pyusdYieldQueue: client,
      } as never,
      input,
      { includeCapacityFacts: true },
    )
    expect(assessment.morphoHolderPositionObservation).toBe(observation)
    expect(assessment.capacityQuote!.sourceHolderPosition).toEqual({
      sharesRaw: value.position.sharesRaw,
      shareDecimals: 18,
      method: 'balance_of_owner_at_source',
    })
    const { status, response } = await request()
    expect(status).toBe(200)
    expect(response.morphoHolderPositionObservation).toBeUndefined()
    const pair = decodeMorphoV2HolderPositionEvidence(
      response.morphoV2CurrentHolderPositionEvidence,
    )
    expect(pair.origins.map((origin) => origin.observation)).toEqual([observation, observation])
    // Only the required EOA check is added by assessment; no transport RPC/retry exists.
    expect(boundary.clients[0].request).toHaveBeenCalledTimes(2)
    expect(boundary.clients[1].request).toHaveBeenCalledTimes(1)
  })

  it.each(['null', 'rejection'] as const)(
    'preserves the exact required response on optional %s',
    async (fault) => {
      vi.mocked(readMorphoV2CurrentProtocolOrigin).mockReset().mockResolvedValue(null)
      const base = await request()
      if (fault === 'rejection')
        vi.mocked(readMorphoV2CurrentProtocolOrigin).mockRejectedValue(Error('optional_timeout'))
      const result = await request()
      expect(result).toEqual(base)
      expect(result.status).toBe(200)
      expect(result.response.capacityAgreement.quote.entitlementRaw).toBe(entitlementRaw)
      // Each failed first optional origin stops the pair; no deferred second read.
      expect(readMorphoV2CurrentProtocolOrigin).toHaveBeenCalledTimes(2)
    },
  )

  it('rejects a non-EOA holder before optional protocol reads', async () => {
    for (const client of boundary.clients) client.request.mockResolvedValue('0x6000')
    expect((await request()).status).toBe(503)
    expect(readMorphoV2CurrentProtocolOrigin).not.toHaveBeenCalled()
  })

  it.each(['asset', 'decimals', 'Q'] as const)(
    'rejects wrong required quote %s before optional reads',
    async (fault) => {
      const value = quote()
      if (fault === 'asset')
        value.vault.assetAddress = '0x0000000000000000000000000000000000000002' as typeof asset
      if (fault === 'decimals') value.vault.assetDecimals = 18
      if (fault === 'Q') value.request.assetsRaw = '2'
      serve(value)
      expect((await request()).status).toBe(503)
      expect(readMorphoV2CurrentProtocolOrigin).not.toHaveBeenCalled()
    },
  )

  it('skips optional pilot evidence for another valid Morpho vault', async () => {
    const destinationAddress = '0x069662d2588fcac24b5c209456db965d151556f0' as const
    const value = quote()
    value.vault.address = destinationAddress as typeof input.destinationAddress
    serve(value)
    const result = await request({ ...input, destinationAddress })
    expect(result.status).toBe(200)
    expect(result.response.capacityAgreement.quote.entitlementRaw).toBe(entitlementRaw)
    expect(readMorphoV2CurrentProtocolOrigin).not.toHaveBeenCalled()
  })

  it('keeps the new server reader and archive out of shared assessment imports', () => {
    const source = readFileSync(
      new URL('../../lib/carry/holderExitAssessment.ts', import.meta.url),
      'utf8',
    )
    expect(source).not.toContain('morphoV2CurrentProtocolCapacityEvidence')
    expect(source).not.toContain('morphoV2PilotHistoricalEvidence')
    expect(source).toContain(
      "import type { MorphoV2ProtocolOriginObservation } from './morphoV2ProtocolCapacityReplay'",
    )
  })

  it.each([8000, 16000])(
    'preserves a fresh base with only %ims source headroom',
    async (headroomMs) => {
      const { expected } = createMorphoV2ProtocolCapacityFixture()
      vi.mocked(Date.now).mockReturnValue(
        Date.parse(expected.source.blockTime) + 30 * 60_000 - headroomMs,
      )
      const result = await request()
      expect(result.status).toBe(200)
      expect(result.response.capacityAgreement.quote.entitlementRaw).toBe(entitlementRaw)
      expect(result.response.executionAgreement).toBeDefined()
      expect(result.response.morphoV2CurrentProtocolCapacityEvidence).toBeUndefined()
      expect(readMorphoV2CurrentProtocolOrigin).not.toHaveBeenCalled()
    },
  )
})
