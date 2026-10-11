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
  buildSghoHolderCapacityProjection,
  selectedSghoHolderCapacityProjection,
  type SghoHolderCapacityInput,
} from '@/lib/carry/sghoHolderCapacityProjection'
const hash = (s: string) => createHash('sha256').update(s).digest('hex'),
  NOW = Date.parse('2026-10-08T12:00:00.000Z'),
  unit = 10n ** 18n
function fixture(paused = false) {
  const history = structuredClone(
    Object.values(audit.histories).find((h) => h.identity.routeKey === 'GHO → sGho [GHO]')!,
  ) as ConditionalSampledCashHistory
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
      entitlementRaw: (10n * unit).toString(),
      quotedMaxWithdrawRaw: (10n * unit).toString(),
      quotedMaxWithdrawStatus: 'quoted',
      effectiveLimitRaw: (paused ? 0n : 10n * unit).toString(),
      withdrawalsPaused: paused,
      fullPositionEntitlementRaw: (1000n * unit).toString(),
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
  const input: SghoHolderCapacityInput = {
    cashProjection,
    capacityAgreement,
    binding: { ...history.identity, owner, requestedRaw, currentSource: source, asOfMs: NOW },
    currentSource,
    horizonHours: 24,
    asOfMs: NOW,
  }
  return {
    input,
    value: buildSghoHolderCapacityProjection(input, hash)!,
    cashProjection,
    capacityAgreement,
  }
}
describe('sGHO holder capacity conditional paths', () => {
  it.each([false, true])(
    'rejects overflowing translated physical cash before clipping or pause=%s',
    (paused) => {
      const f = fixture(paused)
      if (f.cashProjection.status !== 'estimated') throw Error('fixture')
      const currentSource = {
        ...f.input.currentSource,
        cashRaw: ((1n << 256n) - 1n).toString(),
      }
      const cashProjection = buildConditionalSampledCashPathProjection(
        {
          history: f.cashProjection.history,
          currentSource,
          request: f.cashProjection.request,
        },
        hash,
      )
      if (cashProjection.status !== 'estimated') throw Error('overflow fixture')
      expect(
        cashProjection.scenarios.some((path) =>
          path.capacityRaw.some((raw) => BigInt(raw) >= 1n << 256n),
        ),
      ).toBe(true)
      expect(
        buildSghoHolderCapacityProjection({ ...f.input, currentSource, cashProjection }, hash),
      ).toBeNull()
    },
  )
  it('uses fullE beyond current redeemableE/M for recovery without requiring currentQsuccess', () => {
    const f = fixture()
    expect(f.value).not.toBeNull()
    expect(selectedSghoHolderCapacityProjection(f.value, f.input, hash)).toEqual(f.value)
    expect(f.capacityAgreement.quote.successfulRequestedRawLowerBound).toBeNull()
    expect(f.value.fullPositionEntitlementRaw).toBe((1000n * unit).toString())
    expect(f.value.scenarios.some((s) => s.capacityRaw.some((c) => BigInt(c) > 10n * unit))).toBe(
      true,
    )
    expect(f.value.scenarios).toHaveLength(17)
    expect(f.value.horizons).toHaveLength(7)
    expect(f.value.holderExecutableExit).toBe(false)
    expect(f.value.forwardProbability).toBe(false)
    expect(f.value.executableMaximum).toBe(false)
  })
  it('clips each physical path at fullE before subtractingQ exactly once and recomputes horizons/troughs', () => {
    const f = fixture()
    if (f.cashProjection.status !== 'estimated') throw Error('fixture')
    for (const [i, s] of f.value.scenarios.entries()) {
      expect(s.physicalCashRaw).toEqual(f.cashProjection.scenarios[i].capacityRaw)
      s.physicalCashRaw.forEach((c, j) => {
        const cap = BigInt(c) < 1000n * unit ? BigInt(c) : 1000n * unit
        expect(s.capacityRaw[j]).toBe(cap.toString())
        expect(s.userHeadroomRaw[j]).toBe((cap - 20n * unit).toString())
      })
      const min = s.capacityRaw.reduce(
        (a, c) => (BigInt(c) < a ? BigInt(c) : a),
        BigInt(s.capacityRaw[0]),
      )
      expect(s.troughObservation).toBe(s.capacityRaw.findIndex((c) => BigInt(c) === min))
    }
    for (const h of f.value.horizons) {
      const vals = f.value.scenarios
        .map((s) => BigInt(s.userHeadroomRaw[h.observation]))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      expect(h.userHeadroom.minimumRaw).toBe(vals[0].toString())
      expect(h.userHeadroom.p10Raw).toBe(vals[1].toString())
      expect(h.userHeadroom.p90Raw).toBe(vals[14].toString())
      expect(h.target).toEqual(f.cashProjection.horizons[h.observation - 1].target)
    }
  })
  it('paused positivecash stays physical but capacity0 and all−Q runs are left/right censored', () => {
    const f = fixture(true)
    for (const s of f.value.scenarios) {
      expect(BigInt(s.physicalCashRaw[0])).toBeGreaterThan(0n)
      expect(s.capacityRaw).toEqual(Array(8).fill('0'))
      expect(s.userHeadroomRaw).toEqual(Array(8).fill((-20n * unit).toString()))
      expect(s.troughObservation).toBe(0)
      expect(s.sampledShortfalls).toEqual([
        {
          firstBelowObservation: 0,
          lastBelowObservation: 7,
          onset: null,
          recovery: null,
          leftCensored: true,
          rightCensored: true,
          sampledSpanSeconds: s.elapsedSeconds[7],
        },
      ])
    }
    expect(f.value.horizons.every((h) => h.historicalScenariosCoveringQ === 0)).toBe(true)
  })
  it('recomputes shortfall transitions from holder headroom instead of copying cash runs', () => {
    const f = fixture()
    for (const s of f.value.scenarios)
      for (const run of s.sampledShortfalls) {
        expect(BigInt(s.userHeadroomRaw[run.firstBelowObservation])).toBeLessThan(0n)
        expect(BigInt(s.userHeadroomRaw[run.lastBelowObservation])).toBeLessThan(0n)
        if (!run.leftCensored) {
          expect(BigInt(s.userHeadroomRaw[run.firstBelowObservation - 1])).toBeGreaterThanOrEqual(
            0n,
          )
          expect(run.onset).toEqual({
            earliestAt: s.targets[run.firstBelowObservation - 1].earliestAt,
            latestAt: s.targets[run.firstBelowObservation].latestAt,
          })
        }
        if (!run.rightCensored)
          expect(BigInt(s.userHeadroomRaw[run.lastBelowObservation + 1])).toBeGreaterThanOrEqual(0n)
      }
  })
  for (const key of [
    'owner',
    'requestedRaw',
    'asset',
    'assetDecimals',
    'routeKey',
    'destination',
    'currentSource',
  ])
    it(`rejects external ${key} drift`, () => {
      const f = fixture(),
        expected = structuredClone(f.input)
      ;(expected.binding as any)[key] =
        key === 'assetDecimals'
          ? 6
          : key === 'owner'
            ? `0x${'c'.repeat(40)}`
            : key === 'currentSource'
              ? { ...expected.binding.currentSource, blockHash: `0x${'c'.repeat(64)}` }
              : 'foreign'
      expect(buildSghoHolderCapacityProjection(expected, hash)).toBeNull()
      expect(selectedSghoHolderCapacityProjection(f.value, expected, hash)).toBeNull()
    })
  it('old redeemableE alone cannot stand in for fullE; optional disagreement preservesquote but dropsprojection', () => {
    const f = fixture()
    const agreement = structuredClone(f.capacityAgreement)
    for (const q of [agreement.quote, ...agreement.origins.map((o) => o.quote)]) {
      delete q.fullPositionEntitlementRaw
      delete q.fullPositionEntitlementMethod
    }
    expect(
      buildSghoHolderCapacityProjection({ ...f.input, capacityAgreement: agreement }, hash),
    ).toBeNull()
    const other = structuredClone(f.capacityAgreement.origins[1])
    other.quote.fullPositionEntitlementRaw = (1001n * unit).toString()
    const disagreed = agreeHolderExitCapacityQuotes(f.capacityAgreement.origins[0], other, NOW)!
    expect(disagreed).not.toBeNull()
    expect(disagreed.quote.fullPositionEntitlementRaw).toBeNull()
    expect(
      buildSghoHolderCapacityProjection({ ...f.input, capacityAgreement: disagreed }, hash),
    ).toBeNull()
  })
  it('inclusive source expiry, render futuretargets, queryhorizon binding and no horizon rescaling', () => {
    const f = fixture(),
      expiry = Date.parse(f.input.currentSource.blockTime) + 1800000
    const at = (asOfMs: number) => ({ ...f.input, asOfMs, binding: { ...f.input.binding, asOfMs } })
    expect(selectedSghoHolderCapacityProjection(f.value, at(expiry), hash)).not.toBeNull()
    expect(selectedSghoHolderCapacityProjection(f.value, at(expiry + 1), hash)).toBeNull()
    expect(selectedSghoHolderCapacityProjection(f.value, at(NOW - 1), hash)).toBeNull()
    for (const horizonHours of [1, 48, 168]) {
      const input = { ...f.input, horizonHours },
        value = buildSghoHolderCapacityProjection(input, hash)!
      expect(value.horizons).toEqual(f.value.horizons)
      expect(selectedSghoHolderCapacityProjection(value, input, hash)).toEqual(value)
      expect(selectedSghoHolderCapacityProjection(f.value, input, hash)).toBeNull()
    }
  })
  it('rejects payload method/summary/metadata/history/source mutations and does not mutate evidence', () => {
    const f = fixture(),
      before = structuredClone(f.input)
    for (const mutate of [
      (v: any) => (v.method = 'max_withdraw'),
      (v: any) => (v.withdrawalsPaused = true),
      (v: any) => (v.horizons[0].userHeadroom.p10Raw = '1'),
      (v: any) => (v.scenarios[0].sampledShortfalls = []),
      (v: any) => (v.input.cashProjection.history.points[0][4] = '1'),
      (v: any) => (v.input.currentSource.cashRaw = '1'),
      (v: any) => (v.input.binding.owner = `0x${'c'.repeat(40)}`),
    ]) {
      const bad = structuredClone(f.value)
      mutate(bad)
      expect(selectedSghoHolderCapacityProjection(bad, f.input, hash)).toBeNull()
    }
    expect(f.input).toEqual(before)
    expect(
      buildSghoHolderCapacityProjection(
        { ...f.input, currentSource: { ...f.input.currentSource, cashRaw: ['1'] as any } },
        hash,
      ),
    ).toBeNull()
  })
})
