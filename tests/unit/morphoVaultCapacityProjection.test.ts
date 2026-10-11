import { createHash } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import audit from '@/data/research/venue-signals/conditional-sampled-cash-history-v1.audit.json'
import {
  buildConditionalSampledCashPathProjection,
  type ConditionalSampledCashHistory,
} from '@/lib/carry/conditionalSampledCashPathProjection'
import {
  buildHolderExitCapacityQuote,
  agreeHolderExitCapacityQuotes,
} from '@/lib/carry/holderExitCapacity'
import type { HolderExitAssessment } from '@/lib/carry/holderExitAssessment'
import {
  buildMorphoVaultCapacityProjection,
  selectedMorphoVaultCapacityProjection,
  type MorphoVaultCapacityInput,
} from '@/lib/carry/morphoVaultCapacityProjection'
import { resolveHolderExitSubject } from '@/lib/carry/holderExitSubjectRegistry'
const morphoHistories = Object.values(audit.histories).filter(
  (h) =>
    resolveHolderExitSubject(h.identity.routeKey, h.identity.destination as `0x${string}`).kind ===
    'morpho',
)
const hash = (s: string) => createHash('sha256').update(s).digest('hex'),
  NOW = Date.parse('2026-10-08T12:00:00.000Z'),
  unit = 10n ** 6n
function fixture(historyIndex = 0) {
  const history = structuredClone(morphoHistories[historyIndex]) as ConditionalSampledCashHistory
  const owner = `0x${'b'.repeat(40)}` as `0x${string}`,
    requestedRaw = (20n * unit).toString()
  const currentSource = {
    ...history.identity,
    chainId: 1 as const,
    block: '26190000',
    blockHash: `0x${'a'.repeat(64)}`,
    blockTime: new Date(NOW - 60000).toISOString(),
    readAt: new Date(NOW).toISOString(),
    cashRaw: (500n * unit).toString(),
    sourceKind: 'live_read_only_two_origin_finalized' as const,
  }
  const source = {
    chainId: 1 as const,
    blockNumber: Number(currentSource.block),
    blockHash: currentSource.blockHash,
    blockTime: currentSource.blockTime,
    finalized: true as const,
  }
  const assessment: HolderExitAssessment = {
    status: 'assessed',
    routeKey: history.identity.routeKey,
    destinationAddress: history.identity.destination as `0x${string}`,
    owner,
    request: {
      assetsRaw: requestedRaw,
      assetAddress: history.identity.asset as `0x${string}`,
      horizonHours: 24,
    },
    source: { ...source, originValidation: 'single_provider' },
    stages: [
      {
        name: 'withdrawal',
        relatedToRequest: true,
        status: 'reverted',
        amountRaw: requestedRaw,
        assetAddress: history.identity.asset as `0x${string}`,
      },
    ],
    finalPayout: {
      status: 'unassessed',
      assetAddress: history.identity.asset as `0x${string}`,
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
      entitlementRaw: (1000n * unit).toString(),
      quotedMaxWithdrawRaw: '0',
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
  const cashProjection = buildConditionalSampledCashPathProjection(
    { history, currentSource, request: { requestedRaw, asOf: new Date(NOW).toISOString() } },
    hash,
  )
  const input: MorphoVaultCapacityInput = {
    cashProjection,
    capacityAgreement,
    binding: { ...history.identity, owner, requestedRaw, currentSource: source, asOfMs: NOW },
    currentSource,
    horizonHours: 24,
    asOfMs: NOW,
  }
  return {
    input,
    value: buildMorphoVaultCapacityProjection(input, hash)!,
    cashProjection,
    capacityAgreement,
  }
}
describe('Morpho conditional idle cash holder paths', () => {
  it('supports exactly 49 native vaults across seven groups and ignores zero quoted M', () => {
    expect(morphoHistories).toHaveLength(49)
    expect(new Set(morphoHistories.map((h) => h.identity.routeKey)).size).toBe(7)
    for (let i = 0; i < morphoHistories.length; i++) {
      const f = fixture(i)
      expect(f.value).not.toBeNull()
      expect(f.capacityAgreement.quote.quotedMaxWithdrawRaw).toBe('0')
      expect(f.value.horizons).toHaveLength(7)
      expect(f.value.scenarios.some((p) => p.capacityRaw.some((raw) => BigInt(raw) > 0n))).toBe(
        true,
      )
      expect(f.value.totalExitCapacity).toBe(false)
      expect(f.value.holderFailureForecast).toBe(false)
      expect(f.value.configuredAdapterLiquidity).toBeNull()
      expect(f.value.adapterLiquidityMode).toBe('unmodeled_not_zero')
    }
  })
  it('clips every idle cash observation at full E before subtracting Q once', () => {
    const f = fixture()
    expect(selectedMorphoVaultCapacityProjection(f.value, f.input, hash)).toEqual(f.value)
    const E = BigInt(f.value.fullPositionEntitlementRaw),
      Q = BigInt(f.input.binding.requestedRaw)
    for (const path of f.value.scenarios)
      for (let i = 0; i < path.idleCashRaw.length; i++) {
        const idle = BigInt(path.idleCashRaw[i]),
          cap = idle < E ? idle : E
        expect(path.capacityRaw[i]).toBe(String(cap))
        expect(path.userHeadroomRaw[i]).toBe(String(cap - Q))
      }
    for (const path of f.value.scenarios)
      for (const run of path.sampledShortfalls) {
        const sourceAt = Date.parse(f.input.currentSource.blockTime)
        const at = (i: number) => new Date(sourceAt + path.elapsedSeconds[i] * 1000).toISOString()
        expect(run.onset).toEqual(
          run.firstBelowObservation === 0
            ? null
            : {
                earliestAt: at(run.firstBelowObservation - 1),
                latestAt: at(run.firstBelowObservation),
              },
        )
        expect(run.recovery).toEqual(
          run.lastBelowObservation === 7
            ? null
            : {
                earliestAt: at(run.lastBelowObservation),
                latestAt: at(run.lastBelowObservation + 1),
              },
        )
        expect(run.leftCensored).toBe(run.firstBelowObservation === 0)
        expect(run.rightCensored).toBe(run.lastBelowObservation === 7)
      }
    expect(f.capacityAgreement.quote.successfulRequestedRawLowerBound).toBeNull()
    expect(f.value.holderExecutableExit).toBe(false)
    expect(f.value.forwardProbability).toBe(false)
  })
  it('retains actual daily horizons under H1 and H48 without stretching time', () => {
    const f = fixture()
    for (const horizonHours of [1, 48]) {
      const v = buildMorphoVaultCapacityProjection({ ...f.input, horizonHours }, hash)!
      expect(v.request.horizonHours).toBe(horizonHours)
      expect(v.horizons.map((h) => h.target)).toEqual(f.value.horizons.map((h) => h.target))
      expect(v.horizons[0].target.lowerSeconds).toBeGreaterThan(80000)
    }
  })
  it('preserves 109-point postdeployment coverage and missing-prefix censorship', () => {
    const i = morphoHistories.findIndex(
      (h) => h.identity.destination === '0xd95fe7adf5075fad9d6bf853e0f9fe53369e8d96',
    )
    const f = fixture(i)
    expect(f.cashProjection.status).toBe('estimated')
    if (f.cashProjection.status !== 'estimated') throw Error('fixture')
    expect(f.cashProjection.counts.samples).toBe(109)
    expect(f.value.scenarios).toHaveLength(15)
    expect(f.value.scenarios.every((p) => p.originAnchorIndex >= 11)).toBe(true)
  })
  it('recomputes all signed runs, earliest troughs and censorship after E clipping', () => {
    const f = fixture()
    const quote = { ...f.capacityAgreement.quote, entitlementRaw: '1' }
    const agreement = agreeHolderExitCapacityQuotes(
      { host: 'one.example', quote },
      { host: 'two.example', quote },
      NOW,
    )!
    const v = buildMorphoVaultCapacityProjection(
      { ...f.input, capacityAgreement: agreement },
      hash,
    )!
    expect(v).not.toBeNull()
    for (const p of v.scenarios) {
      expect(p.troughObservation).toBe(
        p.capacityRaw.findIndex((r) => BigInt(r) === BigInt(p.capacityRaw[p.troughObservation])),
      )
      expect(p.sampledShortfalls).toEqual([
        {
          firstBelowObservation: 0,
          lastBelowObservation: 7,
          onset: null,
          recovery: null,
          leftCensored: true,
          rightCensored: true,
          sampledSpanSeconds: p.elapsedSeconds[7],
        },
      ])
      expect(p.userHeadroomRaw.every((r) => BigInt(r) < 0n)).toBe(true)
    }
  })
  it.each(['owner', 'requestedRaw', 'asset', 'assetDecimals', 'destination', 'routeKey'] as const)(
    'rejects external binding drift: %s',
    (key) => {
      const f = fixture(),
        binding = { ...f.input.binding }
      Object.assign(binding, {
        [key]:
          key === 'assetDecimals'
            ? 18
            : key === 'requestedRaw'
              ? '21'
              : key === 'routeKey'
                ? 'foreign'
                : `0x${'c'.repeat(40)}`,
      })
      expect(buildMorphoVaultCapacityProjection({ ...f.input, binding }, hash)).toBeNull()
    },
  )
  it('rejects a non-Morpho registered subject', () => {
    const f = fixture(),
      history = Object.values(audit.histories).find(
        (h) => h.identity.routeKey === 'GHO → sGho [GHO]',
      )!
    const currentSource = { ...f.input.currentSource, ...history.identity }
    expect(buildMorphoVaultCapacityProjection({ ...f.input, currentSource }, hash)).toBeNull()
  })
  it('rejects source hash drift and stale render without retiming issued output', () => {
    const f = fixture()
    expect(
      buildMorphoVaultCapacityProjection(
        {
          ...f.input,
          binding: {
            ...f.input.binding,
            currentSource: { ...f.input.binding.currentSource, blockHash: `0x${'f'.repeat(64)}` },
          },
        },
        hash,
      ),
    ).toBeNull()
    const asOfMs = NOW + 1800000
    expect(
      selectedMorphoVaultCapacityProjection(
        f.value,
        { ...f.input, asOfMs, binding: { ...f.input.binding, asOfMs } },
        hash,
      ),
    ).toBeNull()
  })
  it('rejects missing full native preview and origin disagreement', () => {
    const f = fixture(),
      agreement = structuredClone(f.capacityAgreement)
    agreement.origins[1].quote.entitlementRaw = '1'
    expect(
      buildMorphoVaultCapacityProjection({ ...f.input, capacityAgreement: agreement }, hash),
    ).toBeNull()
    const quote = {
      ...f.capacityAgreement.quote,
      entitlementRaw: null,
      entitlementMethod: 'unavailable' as const,
    }
    const noE = agreeHolderExitCapacityQuotes(
      { host: 'one.example', quote },
      { host: 'two.example', quote },
      NOW,
    )!
    expect(
      buildMorphoVaultCapacityProjection({ ...f.input, capacityAgreement: noE }, hash),
    ).toBeNull()
  })
  it('rejects forged cash history/gap edits despite recomputed object metadata', () => {
    const f = fixture(),
      cashProjection = structuredClone(f.cashProjection)
    if (cashProjection.status !== 'estimated') throw Error('fixture')
    cashProjection.history.points.splice(4, 1)
    expect(buildMorphoVaultCapacityProjection({ ...f.input, cashProjection }, hash)).toBeNull()
  })
  it('rejects translated uint256 overflow before entitlement clipping', () => {
    const f = fixture()
    if (f.cashProjection.status !== 'estimated') throw Error('fixture')
    const currentSource = { ...f.input.currentSource, cashRaw: ((1n << 256n) - 1n).toString() }
    const cashProjection = buildConditionalSampledCashPathProjection(
      { history: f.cashProjection.history, currentSource, request: f.cashProjection.request },
      hash,
    )
    expect(cashProjection.status).toBe('estimated')
    if (cashProjection.status !== 'estimated') throw Error('fixture')
    expect(
      cashProjection.scenarios.some((p) => p.capacityRaw.some((r) => BigInt(r) >= 1n << 256n)),
    ).toBe(true)
    expect(
      buildMorphoVaultCapacityProjection({ ...f.input, currentSource, cashProjection }, hash),
    ).toBeNull()
  })
  it('rederives every value and rejects forged aggregate capacity', () => {
    const f = fixture(),
      v = structuredClone(f.value)
    v.horizons[0].capacity.maximumRaw = '999999999999'
    expect(selectedMorphoVaultCapacityProjection(v, f.input, hash)).toBeNull()
  })
})
