import { describe, it, expect } from 'vitest'
import pin from '@/data/research/venue-signals/morpho-v2-adapter-capacity-pilot-2026-10-07T15-32.export.json'
import { morphoV2PinnedProtocolHistory } from '@/lib/carry/morphoV2ProtocolCapacityHistoryPins'
import {
  buildHolderExitCapacityQuote,
  agreeHolderExitCapacityQuotes,
} from '@/lib/carry/holderExitCapacity'
import type { HolderExitAssessment } from '@/lib/carry/holderExitAssessment'
import {
  buildMorphoV2HolderTimeProcess,
  selectedMorphoV2HolderTimeProcess,
  type MorphoV2HolderTimeProcessInput,
} from '@/lib/carry/morphoV2HolderTimeProcess'
const NOW = Date.parse(pin.knowledgeCutoff),
  OWNER = `0x${'b'.repeat(40)}` as `0x${string}`
function fixture(H = 24) {
  const source = {
    chainId: 1 as const,
    blockNumber: Number(pin.current.source.blockNumber),
    blockHash: pin.current.source.blockHash,
    blockTime: pin.current.source.blockTime,
    finalized: true as const,
  }
  const assessment = {
    status: 'assessed',
    routeKey: pin.subject.routeKey,
    destinationAddress: pin.subject.destination,
    owner: OWNER,
    request: { assetsRaw: '1000000', assetAddress: pin.subject.asset, horizonHours: H },
    source: { ...source, originValidation: 'single_provider' },
    stages: [
      {
        name: 'withdrawal',
        status: 'reverted',
        relatedToRequest: true,
        amountRaw: '1000000',
        assetAddress: pin.subject.asset,
      },
    ],
    finalPayout: { status: 'unassessed', amountRaw: null, assetAddress: pin.subject.asset },
    forecast: {
      status: 'unvalidated',
      futureExit: null,
      exitDurationHours: null,
      prospectiveValidated: false,
    },
  } as HolderExitAssessment
  const quote = buildHolderExitCapacityQuote(
    assessment,
    {
      entitlementRaw: '2000000',
      quotedMaxWithdrawRaw: '0',
      quotedMaxWithdrawStatus: 'quoted',
      effectiveLimitRaw: null,
      withdrawalsPaused: null,
    },
    NOW,
  )!
  const agreement = agreeHolderExitCapacityQuotes(
    { host: 'one.example', quote },
    { host: 'two.example', quote },
    NOW,
  )!
  const evidence = {
    subject: pin.subject,
    configured: pin.configured,
    runtimeIdentities: morphoV2PinnedProtocolHistory().runtimeIdentities,
    sourceImplementationEquivalence: false as const,
    captureReceiptSha256: pin.captureReceiptSha256,
    knowledgeCutoff: pin.knowledgeCutoff,
  }
  const input = {
    history: {
      ...evidence,
      history: { ...pin.history, elapsedSeconds: [0, pin.history.elapsedSeconds] },
    },
    current: { ...evidence, point: pin.current, readAtUtc: pin.knowledgeCutoff },
    binding: {
      routeKey: pin.subject.routeKey,
      destination: pin.subject.destination,
      owner: OWNER,
      requestedRaw: '1000000',
      asset: pin.subject.asset,
      assetDecimals: 6,
      currentSource: source,
      asOfMs: NOW,
    },
    capacityAgreement: agreement,
    horizonHours: H,
    asOfMs: NOW,
  } as unknown as MorphoV2HolderTimeProcessInput
  const approved = structuredClone(input)
  const accept = (kind: 'history' | 'current', v: unknown) =>
    JSON.stringify(v) === JSON.stringify(approved[kind])
  return { input: structuredClone(input), accept }
}
describe('pilot Morpho exact-horizon holder time process', () => {
  it.each([1, 24, 48, 8760])(
    'uses exact H%s from genuine issue, all source-age accrual and bounded grid',
    (H) => {
      const { input, accept } = fixture(H),
        r = buildMorphoV2HolderTimeProcess(input, accept)!
      expect(r).not.toBeNull()
      expect(r.targetAtUtc).toBe(new Date(NOW + H * 3600000).toISOString())
      expect(r.issueAtUtc).toBe(pin.knowledgeCutoff)
      expect(r.process.scenarios).toHaveLength(1)
      expect(r.process.scenarios[0].points.length).toBeLessThanOrEqual(128)
      expect(r.process.input.observations[0].availableAtUtc).toBe(pin.knowledgeCutoff)
      expect(r.holderExecutableExit).toBe(false)
      expect(r.assumptions.sourceImplementationEquivalence).toBe(false)
    },
  )
  it('clips by full E before Q once and ignores intentional V2 M zero', () => {
    const { input, accept } = fixture(),
      r = buildMorphoV2HolderTimeProcess(input, accept)!
    expect(BigInt(r.process.scenarios[0].points[0].headroomRaw)).toBe(24558n)
    const first = r.process.scenarios[0].points[0] as unknown as Record<string, string>
    expect(first.availableRaw).toBe('1024558')
    expect(r.process.input.requestedRaw).toBe('1000000')
    const q = input.capacityAgreement as any
    q.quote.entitlementRaw = '500000'
    q.origins.forEach((o: any) => (o.quote.entitlementRaw = '500000'))
    const clipped = buildMorphoV2HolderTimeProcess(input, accept)!
    expect(clipped.process.scenarios[0].points[0].headroomRaw).toBe('-500000')
    expect(clipped.process.scenarios[0].sampledShortfalls[0].leftCensored).toBe(true)
  })
  it('requires external complete evidence, and callback mutation cannot reissue or alter native inputs', () => {
    const { input, accept } = fixture()
    expect(buildMorphoV2HolderTimeProcess(input, () => false)).toBeNull()
    const original = structuredClone(input),
      r = buildMorphoV2HolderTimeProcess(input, (k, v) => {
        input.binding.requestedRaw = '2'
        ;(v as any).subject.assetDecimals = 18
        return accept(k, original[k])
      })!
    expect(r).not.toBeNull()
    expect(r.input.binding.requestedRaw).toBe('1000000')
    expect(r.input.history.subject.assetDecimals).toBe(6)
  })
  it('rejects wrong owner/source/Q/native units and stale/future clocks', () => {
    for (const mutate of [
      (i: any) => (i.binding.owner = `0x${'c'.repeat(40)}`),
      (i: any) => (i.binding.requestedRaw = '1'),
      (i: any) => (i.binding.assetDecimals = 18),
      (i: any) => (i.binding.currentSource.blockHash = `0x${'d'.repeat(64)}`),
      (i: any) => (i.asOfMs = NOW + 1800000),
      (i: any) => (i.current.readAtUtc = new Date(NOW + 1).toISOString()),
    ]) {
      const { input, accept } = fixture()
      mutate(input)
      expect(buildMorphoV2HolderTimeProcess(input, accept)).toBeNull()
    }
  })
  it('retains immutable issued model and revalidates source freshness/target at render', () => {
    const { input, accept } = fixture(1),
      r = buildMorphoV2HolderTimeProcess(input, accept)!
    expect(selectedMorphoV2HolderTimeProcess(r, input, NOW + 1000, accept)?.issueAtUtc).toBe(
      pin.knowledgeCutoff,
    )
    expect(selectedMorphoV2HolderTimeProcess(r, input, NOW - 1, accept)).toBeNull()
    expect(selectedMorphoV2HolderTimeProcess(r, input, NOW + 1800000, accept)).toBeNull()
    const wrong = structuredClone(r)
    wrong.process.targetSummary!.maximumHeadroomRaw = '999'
    expect(selectedMorphoV2HolderTimeProcess(wrong, input, NOW, accept)).toBeNull()
  })
  it('closes at the exact target without retiming and rejects unavailable/tampered entitlement', () => {
    const { input, accept } = fixture(0.01),
      r = buildMorphoV2HolderTimeProcess(input, accept)!
    expect(selectedMorphoV2HolderTimeProcess(r, input, NOW + 35999, accept)).not.toBeNull()
    expect(selectedMorphoV2HolderTimeProcess(r, input, NOW + 36000, accept)).toBeNull()
    const f = fixture()
    ;(f.input.capacityAgreement as any).quote.entitlementRaw = '999'
    expect(buildMorphoV2HolderTimeProcess(f.input, f.accept)).toBeNull()
    const g = fixture()
    g.input.history.knowledgeCutoff = new Date(NOW + 1).toISOString()
    expect(buildMorphoV2HolderTimeProcess(g.input, () => true)).toBeNull()
  })
  it('rejects unsupported fee/recipient, regime/data, changing historical market/share/cap and gaps', () => {
    for (const mutate of [
      (i: any) => (i.current.point.prongs.market[5] = '1'),
      (i: any) => (i.current.point.prongs.feeRecipient = `0x${'a'.repeat(40)}`),
      (i: any) => (i.current.configured.irm = `0x${'a'.repeat(40)}`),
      (i: any) => (i.history.history.points[1].prongs.market[0] = '1'),
      (i: any) => (i.history.history.points[1].prongs.allocationsRaw[0] = '1'),
      (i: any) => (i.history.history.points[1].source.blockTime = '2026-10-03T23:59:59.000Z'),
    ]) {
      const { input } = fixture()
      mutate(input)
      expect(buildMorphoV2HolderTimeProcess(input, () => true)).toBeNull()
    }
  })
  it('censors future native overflow instead of clipping it into a monetary fact', () => {
    const { input } = fixture(8760)
    input.current.point.prongs.borrowRateRaw = '1000000000000000000000000000000000000'
    // Current state also overflows: rejection precedes projection, not a fabricated zero.
    expect(buildMorphoV2HolderTimeProcess(input, () => true)).toBeNull()
    const f = fixture(8760)
    f.input.current.point.prongs.market[4] = String(
      Date.parse(f.input.current.point.source.blockTime) / 1000,
    )
    f.input.current.point.prongs.borrowRateRaw = '1000000000000000000000000000000000000'
    const r = buildMorphoV2HolderTimeProcess(f.input, () => true)!
    expect(r).not.toBeNull()
    expect(r.process.targetSummary).toBeNull()
    expect(r.process.scenarios[0].status).toBe('censored_path')
  })
})
