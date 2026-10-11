import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import {
  buildHolderExitCapacityQuote,
  agreeHolderExitCapacityQuotes,
} from '@/lib/carry/holderExitCapacity'
import type { HolderExitAssessment } from '@/lib/carry/holderExitAssessment'
import {
  buildSusdsHistoricalHolderCapacityProjection,
  selectedSusdsHistoricalHolderCapacityProjection,
  susdsPinnedIndexHistory,
  type SusdsHistoricalHolderCapacityInput,
} from '@/lib/carry/susdsHistoricalHolderCapacityProjection'
const hash = (s: string) => createHash('sha256').update(s).digest('hex'),
  NOW = Date.parse('2026-10-08T12:00:00.000Z'),
  UNIT = 10n ** 18n
function fixture(age = 60_000, E = 1000n * UNIT) {
  const history = susdsPinnedIndexHistory(),
    identity = {
      routeKey: 'USDS → SUsds [USDS]',
      destination: '0xa3931d71877c0e7a3148cb7eb4463524fec27fbd',
      asset: '0xdc035d45d973e3ec169d2276ddab16f1e407384f',
      assetDecimals: 18,
    },
    owner = `0x${'b'.repeat(40)}` as `0x${string}`,
    requestedRaw = String(10n * UNIT)
  const currentSource = {
    chainId: 1 as const,
    blockNumber: 26190000,
    blockHash: `0x${'a'.repeat(64)}`,
    blockTime: new Date(NOW - age).toISOString(),
    finalized: true as const,
  }
  const assessment: HolderExitAssessment = {
    status: 'assessed',
    routeKey: identity.routeKey,
    destinationAddress: identity.destination as `0x${string}`,
    owner,
    request: {
      assetsRaw: requestedRaw,
      assetAddress: identity.asset as `0x${string}`,
      horizonHours: 24,
    },
    source: { ...currentSource, originValidation: 'single_provider' },
    stages: [
      {
        name: 'withdrawal',
        relatedToRequest: true,
        status: 'reverted',
        amountRaw: requestedRaw,
        assetAddress: identity.asset as `0x${string}`,
      },
    ],
    finalPayout: {
      status: 'unassessed',
      assetAddress: identity.asset as `0x${string}`,
      amountRaw: null,
    },
    forecast: {
      status: 'unvalidated',
      futureExit: null,
      exitDurationHours: null,
      prospectiveValidated: false,
    },
  }
  const quote = buildHolderExitCapacityQuote(
    assessment,
    {
      entitlementRaw: String(E),
      quotedMaxWithdrawRaw: String(E),
      quotedMaxWithdrawStatus: 'quoted',
      effectiveLimitRaw: null,
      withdrawalsPaused: null,
    },
    NOW,
  )!
  const capacityAgreement = agreeHolderExitCapacityQuotes(
    { host: 'one.example', quote },
    { host: 'two.example', quote },
    NOW,
  )!
  const input: SusdsHistoricalHolderCapacityInput = {
    history,
    capacityAgreement,
    binding: { ...identity, owner, requestedRaw, currentSource, asOfMs: NOW },
    currentSource,
    currentReadAtUtc: new Date(NOW).toISOString(),
    horizonHours: 24,
    asOfMs: NOW,
  }
  return {
    input,
    value: buildSusdsHistoricalHolderCapacityProjection(input, hash)!,
    history,
    capacityAgreement,
  }
}
describe('sUSDS sealed own-index holder scenarios', () => {
  it('pins actual canonical physical and body bytes of all29checkpoint records', () => {
    const f = fixture()
    expect(f.history.checkpoints).toHaveLength(29)
    for (const p of f.history.checkpoints) {
      const raw = readFileSync(
        `data/research/venue-signals/susds-finalized-checkpoints/${p.filename}`,
        'utf8',
      )
      expect(hash(raw)).toBe(p.fileSha256)
      expect(JSON.parse(raw)).toEqual(p.checkpoint)
      const { sha256, ...body } = p.checkpoint
      expect(hash(JSON.stringify(body))).toBe(sha256)
    }
    expect(f.value.evidence).toMatchObject({
      checkpointCount: 29,
      pairedEpisodeCount: 28,
      observedRegimeCount: 1,
      evidenceTier: 'sealed_one_origin_finalized_checkpoint_not_raw_rpc_transcript',
    })
  })
  it('reconstructs all28actual elapsed targets and groups only exactly equal durations', () => {
    const f = fixture()
    expect(f.value.episodes).toHaveLength(28)
    for (const [i, p] of f.value.episodes.entries()) {
      expect(p.elapsedSeconds).toBe(
        f.history.checkpoints[i + 1].checkpoint.block.timestamp -
          f.history.checkpoints[i].checkpoint.block.timestamp,
      )
      expect(Date.parse(p.targetAt) - Date.parse(f.input.currentSource.blockTime)).toBe(
        p.elapsedSeconds * 1000,
      )
    }
    for (const g of f.value.groups)
      expect(g.episodeCount).toBe(
        f.value.episodes.filter((p) => p.elapsedSeconds === g.elapsedSeconds).length,
      )
    for (const horizonHours of [1, 48, 168])
      expect(
        buildSusdsHistoricalHolderCapacityProjection(
          { ...f.input, horizonHours },
          hash,
        )!.episodes.map((p) => p.targetAt),
      ).toEqual(f.value.episodes.map((p) => p.targetAt))
  })
  it('bounds actual floor-index mechanical relations, and subtracts Q once', () => {
    const f = fixture(),
      E = BigInt(f.value.currentEntitlementRaw),
      Q = BigInt(f.input.binding.requestedRaw)
    for (const p of f.value.episodes) {
      const Pb = BigInt(p.baselinePpsRaw),
        Pt = BigInt(p.endpointPpsRaw),
        lo = (E * Pt) / (Pb + 1n),
        num = (E + 1n) * (Pt + 1n),
        hi = (num + Pb - 1n) / Pb - 1n
      expect(p.entitlementLowerRaw[1]).toBe(String(lo))
      expect(p.entitlementUpperRaw[1]).toBe(String(hi))
      expect(p.headroomLowerRaw[1]).toBe(String(lo - Q))
      expect(p.headroomUpperRaw[1]).toBe(String(hi - Q))
      for (const epsilon of [0n, 9n])
        for (const bOffset of [0n, 999999999n])
          for (const tOffset of [0n, 999999999n]) {
            const actual =
              ((E * 10n + epsilon) * (Pt * 10n ** 9n + tOffset)) /
              (10n * (Pb * 10n ** 9n + bOffset))
            expect(actual >= lo && actual <= hi).toBe(true)
          }
    }
    expect(f.value.otherHolderFlowDrawCap).toBe(false)
    expect(f.value.holderExecutableExit).toBe(false)
    expect(f.value.forwardProbability).toBe(false)
    expect(f.value.sourceImplementationEquivalence).toBe(false)
  })
  it('preserves issued projection clocks while re-aging only the selected future view', () => {
    const f = fixture(),
      asOfMs = NOW + 700000,
      expected = { ...f.input, asOfMs, binding: { ...f.input.binding, asOfMs } }
    const selected = selectedSusdsHistoricalHolderCapacityProjection(f.value, expected, hash)!
    expect(selected.projection).toEqual(f.value)
    expect(selected.projection.request.asOf).toBe(new Date(NOW).toISOString())
    expect(selected.view.selectedAtUtc).toBe(new Date(asOfMs).toISOString())
    expect(selected.view.elapsedEpisodeIndices.length).toBeGreaterThan(0)
    expect(selected.view.groups.every((g) => Date.parse(g.targetAt) > asOfMs)).toBe(true)
    expect(selected.projection.episodes).toHaveLength(28)
  })
  it('expired targets remain measured episodes rather than missing historicaldata', () => {
    const f = fixture(1200000)
    expect(f.value.episodes).toHaveLength(28)
    expect(f.value.counts.elapsedTargetCensored).toBeGreaterThan(0)
    expect(f.value.counts.regimeGapCensored).toBe(0)
    const selected = selectedSusdsHistoricalHolderCapacityProjection(f.value, f.input, hash)!
    expect(
      selected.view.activeEpisodeIndices.length + selected.view.elapsedEpisodeIndices.length,
    ).toBe(28)
  })
  it('recomputes possible and definite paired breaches with honest censoring', () => {
    const f = fixture(60000, 1n)
    for (const p of f.value.episodes) {
      expect(p.possibleSampledShortfalls).toEqual([
        {
          firstBelowObservation: 0,
          lastBelowObservation: 1,
          onset: null,
          recovery: null,
          leftCensored: true,
          rightCensored: true,
          sampledSpanSeconds: p.elapsedSeconds,
        },
      ])
      expect(p.definiteSampledShortfalls).toEqual(p.possibleSampledShortfalls)
      expect(p.lowerTroughObservation).toBe(0)
    }
  })
  it.each(['owner', 'requestedRaw', 'asset', 'assetDecimals', 'destination', 'routeKey'] as const)(
    'rejects native holder binding drift: %s',
    (key) => {
      const f = fixture(),
        binding = { ...f.input.binding }
      Object.assign(binding, {
        [key]:
          key === 'assetDecimals'
            ? 6
            : key === 'requestedRaw'
              ? '11'
              : key === 'routeKey'
                ? 'foreign'
                : `0x${'c'.repeat(40)}`,
      })
      expect(buildSusdsHistoricalHolderCapacityProjection({ ...f.input, binding }, hash)).toBeNull()
    },
  )
  it('rejects source/hash/age/read-clock drift', () => {
    const f = fixture()
    expect(
      buildSusdsHistoricalHolderCapacityProjection(
        {
          ...f.input,
          currentSource: { ...f.input.currentSource, blockHash: `0x${'f'.repeat(64)}` },
        },
        hash,
      ),
    ).toBeNull()
    expect(
      buildSusdsHistoricalHolderCapacityProjection(
        { ...f.input, currentReadAtUtc: new Date(NOW + 1).toISOString() },
        hash,
      ),
    ).toBeNull()
    const asOfMs = NOW + 1800000
    expect(
      selectedSusdsHistoricalHolderCapacityProjection(
        f.value,
        { ...f.input, asOfMs, binding: { ...f.input.binding, asOfMs } },
        hash,
      ),
    ).toBeNull()
  })
  it('rejects self-resealed missing/foreign checkpoint histories', () => {
    const f = fixture()
    for (const mutation of [
      (h: typeof f.history) => h.checkpoints.splice(3, 1),
      (h: typeof f.history) => (h.checkpoints[0].checkpoint.state.assetsPerShareRaw = '1'),
      (h: typeof f.history) =>
        (h.checkpoints[0].checkpoint.contract.implementationCodeHash = `0x${'d'.repeat(64)}`),
    ]) {
      const h = structuredClone(f.history)
      mutation(h)
      expect(
        buildSusdsHistoricalHolderCapacityProjection({ ...f.input, history: h }, hash),
      ).toBeNull()
    }
  })
  it('rejects missing or disagreeing native full-previewE without requiring withdrawal success', () => {
    const f = fixture()
    expect(f.capacityAgreement.quote.successfulRequestedRawLowerBound).toBeNull()
    const a = structuredClone(f.capacityAgreement)
    a.origins[1].quote.entitlementRaw = '1'
    expect(
      buildSusdsHistoricalHolderCapacityProjection({ ...f.input, capacityAgreement: a }, hash),
    ).toBeNull()
    const q = {
      ...f.capacityAgreement.quote,
      entitlementRaw: null,
      entitlementMethod: 'unavailable' as const,
    }
    const noE = agreeHolderExitCapacityQuotes(
      { host: 'one.example', quote: q },
      { host: 'two.example', quote: q },
      NOW,
    )!
    expect(
      buildSusdsHistoricalHolderCapacityProjection({ ...f.input, capacityAgreement: noE }, hash),
    ).toBeNull()
  })
  it('rejects impossible native future entitlement before Q subtraction', () => {
    expect(fixture(60000, (1n << 256n) - 1n).value).toBeNull()
  })
  it('rejects forged group/scenario/clock facts against external inputs', () => {
    const f = fixture()
    for (const mutation of [
      (v: typeof f.value) => (v.groups[0].headroomLower.maximumRaw = '1'),
      (v: typeof f.value) => (v.episodes[0].targetAt = new Date(NOW + 100000).toISOString()),
      (v: typeof f.value) => (v.input.asOfMs = NOW + 1),
    ]) {
      const v = structuredClone(f.value)
      mutation(v)
      expect(selectedSusdsHistoricalHolderCapacityProjection(v, f.input, hash)).toBeNull()
    }
  })
})
