import { decodeStusdsProtocolEvidence } from '@/lib/carry/stusdsProtocolEvidenceCodec'
import { afterEach, describe, expect, it, vi } from 'vitest'
import capture from '@/data/research/venue-signals/stusds-historical-capacity-2026-10-07T14-29.json'
import { stusdsProtocolReadPlan } from '@/lib/carry/stusdsCurrentProtocolCapacityEvidence'
import { readTrackedDirectVaultExit } from '@/lib/carry/trackedDirectVaultExit'
import { readHolderExitAssessment } from '@/lib/carry/holderExitAssessment'
import handler, {
  holderExitAssessmentResponse,
  sameHolderExitAssessment,
} from '@/pages/api/carry/holder-exit-assessment'
vi.mock('@/lib/carry/trackedDirectVaultExit', async (original) => ({
  ...(await original<typeof import('@/lib/carry/trackedDirectVaultExit')>()),
  readTrackedDirectVaultExit: vi.fn(),
}))
vi.mock('viem', async (original) => ({
  ...(await original<typeof import('viem')>()),
  createPublicClient: vi.fn(() => ({})),
}))
vi.mock('@/lib/game/rateLimit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  getClientIp: () => '127.0.0.27',
}))
vi.mock('@/scripts/research/carry-depth-quote-archive.mjs', () => ({
  readProviderPolicy: () => ({ status: 'active' }),
  configuredProviders: () =>
    capture.origins.map((host) => ({ host, url: 'https://' + host + '/test' })),
}))
const routeKey = 'USDS → StUsds [USDS]',
  destinationAddress = '0x99cd4ec3f88a45940936f469e4bb72a2a701eeb9',
  asset = '0xdc035d45d973e3ec169d2276ddab16f1e407384f',
  owner = '0x' + 'b'.repeat(40),
  Q = '1000000000000000000',
  now = Date.parse(capture.capturedAt)
const source = {
  chainId: 1 as const,
  blockNumber: Number(capture.sources[2].blockNumber),
  blockHash: capture.sources[2].blockHash,
  blockTime: capture.sources[2].blockTime,
  finalized: true as const,
}
function native(host: string, optional = true) {
  const rows = capture.traces.filter((t) => t.anchor === 2 && t.origin === host),
    find = (key: string) => rows.find((t) => t.key === key)!
  return {
    source: { ...source, observedAt: capture.capturedAt },
    routeKey,
    vault: {
      address: destinationAddress,
      assetAddress: asset,
      assetDecimals: 18,
      shareDecimals: 18,
    },
    position: {
      entitlementAssetsRaw: '1000000000000000000000',
      maxWithdrawAssetsRaw: '1000000000000000000000',
    },
    request: { assetsRaw: Q },
    simulation: { status: 'success' },
    protocolCapacityObservation: optional
      ? {
          source: structuredClone(source),
          readAtUtc: capture.capturedAt,
          nativeIdentity: { assetAddress: asset, assetDecimals: 18, shareDecimals: 18 },
          coreRuntimeCodes: {
            proxy: find('code_proxy').response!.result,
            asset: find('code_asset').response!.result,
          },
          traces: stusdsProtocolReadPlan(source).map((p) => {
            const t = find(p.key)
            return {
              key: p.key,
              method: t.request.method,
              params: structuredClone(t.request.params),
              result: t.response!.result,
            }
          }),
        }
      : null,
  }
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})
async function response() {
  let code = 0,
    body: any
  const setHeader = vi.fn()
  await handler(
    {
      method: 'POST',
      body: {
        routeKey,
        destinationAddress,
        owner,
        assetsRaw: Q,
        horizonHours: 48,
        forecastSourceReference: {
          blockNumber: source.blockNumber,
          blockHash: source.blockHash,
          blockTime: source.blockTime,
        },
      },
      headers: {},
      socket: { remoteAddress: '127.0.0.27' },
    } as any,
    {
      setHeader,
      status(n: number) {
        code = n
        return this
      },
      json(v: any) {
        body = v
        return this
      },
    } as any,
  )
  expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store')
  return { code, body }
}
describe('StUSDS optional native protocol evidence through actual holder API', () => {
  it('issues separate two-configured-origin evidence at entered holder exact C2/Q', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now)
    vi.mocked(readTrackedDirectVaultExit)
      .mockResolvedValueOnce(native(capture.origins[0]) as any)
      .mockResolvedValueOnce(native(capture.origins[1]) as any)
    const r = await response()
    expect(r.code).toBe(200)
    expect(r.body.stusdsCurrentProtocolCapacityEvidence.origins.map((o: any) => o.host)).toEqual(
      capture.origins,
    )
    expect(r.body.stusdsProtocolCapacityObservation).toBeUndefined()
    const payloadBytes = new TextEncoder().encode(JSON.stringify(r.body)).length
    expect(payloadBytes).toBeLessThan(128 * 1024)
    process.stdout.write(`actual190fixture_full_api_response_bytes=${payloadBytes}\n`)
    expect(decodeStusdsProtocolEvidence(r.body.stusdsCurrentProtocolCapacityEvidence)).toBeTruthy()
    expect(r.body.capacityAgreement.quote.entitlementRaw).toBe('1000000000000000000000')
    expect(r.body.executionAgreement.simulations).toHaveLength(2)
    expect(vi.mocked(readTrackedDirectVaultExit).mock.calls[0][3]).toMatchObject({
      blockNumber: BigInt(source.blockNumber),
      blockHash: source.blockHash,
    })
    expect(vi.mocked(readTrackedDirectVaultExit).mock.calls[0][4]).toEqual({
      includeCapacityFacts: true,
      includeStusdsProtocolCapacity: true,
    })
  })
  it.each([0, 1])(
    'origin%s optional failure preserves exact-Q/core capacity and no single-origin protocol evidence',
    async (missing) => {
      vi.spyOn(Date, 'now').mockReturnValue(now)
      capture.origins.forEach((h, i) =>
        vi
          .mocked(readTrackedDirectVaultExit)
          .mockResolvedValueOnce(native(h, i !== missing) as any),
      )
      const r = await response()
      expect(r.code).toBe(200)
      expect(r.body.stusdsCurrentProtocolCapacityEvidence).toBeUndefined()
      expect(r.body.stusdsProtocolCapacityObservation).toBeUndefined()
      expect(r.body.executionAgreement.simulations).toHaveLength(2)
      expect(r.body.capacityAgreement).toBeTruthy()
    },
  )
  it('malformed optional prongs preserve source/holder/Q agreement', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const a = native(capture.origins[0]),
      b = native(capture.origins[1])
    b.protocolCapacityObservation!.traces[0].result = ['bad'] as any
    vi.mocked(readTrackedDirectVaultExit)
      .mockResolvedValueOnce(a as any)
      .mockResolvedValueOnce(b as any)
    const r = await response()
    expect(r.code).toBe(200)
    expect(r.body.stusdsCurrentProtocolCapacityEvidence).toBeUndefined()
    expect(r.body.finalPayout.status).toBe('simulated')
  })
  it('a single assessment adapter never invents protocol agreement and core comparator ignores only optional channel', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now)
    vi.mocked(readTrackedDirectVaultExit).mockResolvedValue(native(capture.origins[0]) as any)
    const a = await readHolderExitAssessment(
      { tracked: {} } as any,
      { routeKey, destinationAddress, owner, assetsRaw: Q, horizonHours: 48 } as any,
      { includeCapacityFacts: true, includeStusdsProtocolCapacity: true },
    )
    expect(a.stusdsProtocolCapacityObservation).toBeTruthy()
    expect(
      (holderExitAssessmentResponse(a) as any).stusdsProtocolCapacityObservation,
    ).toBeUndefined()
    expect(
      (holderExitAssessmentResponse(a) as any).stusdsCurrentProtocolCapacityEvidence,
    ).toBeUndefined()
    const b = structuredClone(a)
    b.stusdsProtocolCapacityObservation = null
    expect(sameHolderExitAssessment(a, b)).toBe(true)
    b.owner = ('0x' + 'a'.repeat(40)) as any
    expect(sameHolderExitAssessment(a, b)).toBe(false)
    b.owner = a.owner
    b.source.blockHash = ('0x' + 'a'.repeat(64)) as any
    expect(sameHolderExitAssessment(a, b)).toBe(false)
  })
  it.each([false, true])(
    'Q execution disagreement retains independent native E and complete global evidence (malformed=%s)',
    async (malformed) => {
      vi.spyOn(Date, 'now').mockReturnValue(now)
      const a = native(capture.origins[0]),
        b = native(capture.origins[1])
      b.simulation.status = 'evm_revert'
      if (malformed) b.protocolCapacityObservation!.traces[0].result = '0x1234'
      vi.mocked(readTrackedDirectVaultExit)
        .mockResolvedValueOnce(a as any)
        .mockResolvedValueOnce(b as any)
      const r = await response()
      expect(r.code).toBe(503)
      expect(r.body.error).toBe('holder_exit_assessment_unavailable')
      expect(r.body.capacityAgreement.quote.entitlementRaw).toBe('1000000000000000000000')
      expect(r.body.capacityAgreement.quote.successfulRequestedRawLowerBound).toBeNull()
      expect(r.body.executionAgreement).toBeUndefined()
      expect(new TextEncoder().encode(JSON.stringify(r.body)).length).toBeLessThan(128 * 1024)
      if (!malformed)
        process.stdout.write(
          `actual190fixture_capacity_only_api_response_bytes=${new TextEncoder().encode(JSON.stringify(r.body)).length}\n`,
        )
      if (malformed) expect(r.body.stusdsCurrentProtocolCapacityEvidence).toBeUndefined()
      else
        expect(
          decodeStusdsProtocolEvidence(r.body.stusdsCurrentProtocolCapacityEvidence)?.origins,
        ).toHaveLength(2)
    },
  )
})
