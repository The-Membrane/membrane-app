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
import { DIRECT_SUPPLY_MARKETS } from '@/lib/carry/directSupplyMarketConstants'
import type { HolderExitAssessment } from '@/lib/carry/holderExitAssessment'
import {
  agreeCometWithdrawFacts,
  selectedCometWithdrawFacts,
  buildCometHolderCapacityProjection,
  selectedCometHolderCapacityProjection,
  type CometHolderCapacityInput,
} from '@/lib/carry/cometHolderCapacityProjection'
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const NOW = Date.parse('2026-10-08T12:00:00.000Z')
const market = DIRECT_SUPPLY_MARKETS.compoundV3Usdc
function fixture(paused: boolean | null = false, E = '1000000000', q = '20000000') {
  const history = structuredClone(
    Object.values(audit.histories).find((h) => h.identity.routeKey === market.routeKey)!,
  ) as ConditionalSampledCashHistory
  const currentSource = {
    ...history.identity,
    chainId: 1 as const,
    block: '26190000',
    blockHash: `0x${'a'.repeat(64)}`,
    blockTime: new Date(NOW - 60000).toISOString(),
    readAt: new Date(NOW).toISOString(),
    cashRaw: '500000000',
    sourceKind: 'live_read_only_two_origin_finalized' as const,
  }
  const source = {
    chainId: 1 as const,
    blockNumber: Number(currentSource.block),
    blockHash: currentSource.blockHash,
    blockTime: currentSource.blockTime,
    finalized: true as const,
  }
  const owner = `0x${'b'.repeat(40)}` as `0x${string}`
  const assessment: HolderExitAssessment = {
    status: 'assessed',
    routeKey: history.identity.routeKey,
    destinationAddress: history.identity.destination as `0x${string}`,
    owner,
    request: {
      assetsRaw: q,
      assetAddress: history.identity.asset as `0x${string}`,
      horizonHours: 24,
    },
    source: { ...source, originValidation: 'single_provider' },
    stages: [
      {
        name: 'withdrawal',
        relatedToRequest: true,
        status: 'reverted',
        amountRaw: q,
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
      entitlementRaw: E,
      quotedMaxWithdrawRaw: null,
      quotedMaxWithdrawStatus: 'not_read',
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
  const facts = {
    ...history.identity,
    status: 'comet_withdraw_getter_observed' as const,
    source,
    withdrawalsPaused: paused,
  }
  const cometFactsAgreement = agreeCometWithdrawFacts(
    { host: 'one.example', facts },
    { host: 'two.example', facts },
    NOW,
  )
  const cashProjection = buildConditionalSampledCashPathProjection(
    { history, currentSource, request: { requestedRaw: q, asOf: new Date(NOW).toISOString() } },
    hash,
  )
  const input: CometHolderCapacityInput = {
    cashProjection,
    capacityAgreement,
    cometFactsAgreement,
    binding: { ...history.identity, owner, requestedRaw: q, currentSource: source, asOfMs: NOW },
    currentSource,
    horizonHours: 24,
    asOfMs: NOW,
  }
  return { input, facts, value: buildCometHolderCapacityProjection(input, hash)! }
}
describe('Comet supplied holder joint liquidity outlook', () => {
  it('translates full native paths, floors physical cash then clips E and subtracts Q exactly once', () => {
    const f = fixture()
    expect(f.value).not.toBeNull()
    expect(selectedCometHolderCapacityProjection(f.value, f.input, hash)).toEqual(f.value)
    expect(f.value.scenarios).toHaveLength(17)
    expect(f.value.horizons).toHaveLength(7)
    for (const p of f.value.scenarios) {
      p.physicalCashRaw.forEach((c, i) => {
        const candidate = BigInt(c) < 1000000000n ? BigInt(c) : 1000000000n
        expect(p.capacityRaw[i]).toBe(String(candidate))
        expect(p.userHeadroomRaw[i]).toBe(String(candidate - 20000000n))
        expect(
          Date.parse(p.targets[i].earliestAt) - Date.parse(f.input.currentSource.blockTime),
        ).toBe(p.elapsedSeconds[i] * 1000)
      })
      const minimum = p.capacityRaw.reduce(
        (a, c) => (BigInt(c) < a ? BigInt(c) : a),
        BigInt(p.capacityRaw[0]),
      )
      expect(p.troughObservation).toBe(p.capacityRaw.findIndex((c) => BigInt(c) === minimum))
      for (const run of p.sampledShortfalls) {
        expect(run.leftCensored).toBe(run.firstBelowObservation === 0)
        expect(run.rightCensored).toBe(run.lastBelowObservation === p.capacityRaw.length - 1)
        expect(run.sampledSpanSeconds).toBe(
          p.elapsedSeconds[run.lastBelowObservation] - p.elapsedSeconds[run.firstBelowObservation],
        )
        if (run.onset)
          expect(run.onset).toEqual({
            earliestAt: p.targets[run.firstBelowObservation - 1].earliestAt,
            latestAt: p.targets[run.firstBelowObservation].latestAt,
          })
        if (run.recovery)
          expect(run.recovery).toEqual({
            earliestAt: p.targets[run.lastBelowObservation].earliestAt,
            latestAt: p.targets[run.lastBelowObservation + 1].latestAt,
          })
      }
    }
    expect(
      f.value.scenarios.some((p) => p.sampledShortfalls.some((r) => r.recovery !== null)),
    ).toBe(true)
    expect(f.value.grossFlowAdded).toBe(false)
    expect(f.value.holderExecutableExit).toBe(false)
    expect(f.value.forwardProbability).toBe(false)
    expect(f.value.forecastValidated).toBe(false)
    expect(f.value.supplyInterestMode).toBe('unmodeled_held_constant')
  })
  it.each([1, 24, 48])('keeps actual daily durations at H%s without rescaling', (H) => {
    const f = fixture()
    const x = buildCometHolderCapacityProjection({ ...f.input, horizonHours: H }, hash)!
    expect(x.scenarios).toEqual(f.value.scenarios)
    expect(x.horizons).toEqual(f.value.horizons)
    expect(x.request.horizonHours).toBe(H)
  })
  it('observed true pause zeros each candidate; unknown does not fabricate a zero', () => {
    const paused = fixture(true),
      unknown = fixture(null)
    expect(paused.value.scenarios.every((p) => p.capacityRaw.every((c) => c === '0'))).toBe(true)
    expect(
      paused.value.scenarios.every((p) => p.userHeadroomRaw.every((c) => c === '-20000000')),
    ).toBe(true)
    expect(unknown.value.withdrawalsPaused).toBeNull()
    expect(unknown.value.pauseEvidence).toBe('unknown')
    expect(unknown.value.scenarios.some((p) => p.capacityRaw.some((c) => BigInt(c) > 0n))).toBe(
      true,
    )
  })
  it('getter disagreement remains source-bound unknown and leaves full E intact', () => {
    const f = fixture(true),
      other = { ...f.facts, withdrawalsPaused: false }
    const agreement = agreeCometWithdrawFacts(
      { host: 'one.example', facts: f.facts },
      { host: 'two.example', facts: other },
      NOW,
    )!
    expect(agreement.facts.withdrawalsPaused).toBeNull()
    const p = buildCometHolderCapacityProjection(
      { ...f.input, cometFactsAgreement: agreement },
      hash,
    )!
    expect(p.withdrawalsPaused).toBeNull()
    expect(p.fullPositionEntitlementRaw).toBe('1000000000')
  })
  it('absent optional facts do not poison E or cash paths', () => {
    const f = fixture()
    const p = buildCometHolderCapacityProjection({ ...f.input, cometFactsAgreement: null }, hash)!
    expect(p.scenarios).toEqual(f.value.scenarios)
    expect(p.withdrawalsPaused).toBeNull()
  })
  it.each([false, true])(
    'rejects physical uint256 overflow before entitlement clipping or pause %s',
    (paused) => {
      const f = fixture(paused),
        currentSource = { ...f.input.currentSource, cashRaw: ((1n << 256n) - 1n).toString() }
      if (f.input.cashProjection === null || (f.input.cashProjection as any).status !== 'estimated')
        throw Error('fixture')
      const cashProjection = buildConditionalSampledCashPathProjection(
        {
          history: (f.input.cashProjection as any).history,
          currentSource,
          request: (f.input.cashProjection as any).request,
        },
        hash,
      )
      expect(cashProjection.status).toBe('estimated')
      expect(
        buildCometHolderCapacityProjection({ ...f.input, currentSource, cashProjection }, hash),
      ).toBeNull()
    },
  )
  it('Q above supplied E is a signed shortfall and cannot become a borrow exit forecast', () => {
    const f = fixture(false, '1000000', '2000000')
    expect(f.value.scenarios.every((p) => p.userHeadroomRaw.every((c) => BigInt(c) < 0n))).toBe(
      true,
    )
  })
  it('rejects wrong owner/Q/native units/source, expired source and mutated model', () => {
    const f = fixture()
    for (const mutate of [
      (x: any) => (x.binding.owner = `0x${'c'.repeat(40)}`),
      (x: any) => (x.binding.requestedRaw = '1'),
      (x: any) => (x.binding.assetDecimals = 18),
      (x: any) => (x.binding.currentSource.blockHash = `0x${'d'.repeat(64)}`),
      (x: any) => {
        x.asOfMs = Date.parse(x.currentSource.blockTime) + 1800001
        x.binding.asOfMs = x.asOfMs
      },
    ]) {
      const x = structuredClone(f.input)
      mutate(x)
      expect(buildCometHolderCapacityProjection(x, hash)).toBeNull()
    }
    const changed = structuredClone(f.value)
    changed.scenarios[0].capacityRaw[0] = '123'
    expect(selectedCometHolderCapacityProjection(changed, f.input, hash)).toBeNull()
  })
  it('genuine issued clock persists at render and future targets cannot be retimed', () => {
    const f = fixture()
    const later = {
      ...f.input,
      asOfMs: NOW + 1000,
      binding: { ...f.input.binding, asOfMs: NOW + 1000 },
    }
    expect(selectedCometHolderCapacityProjection(f.value, later, hash)).toEqual(f.value)
    expect(
      selectedCometHolderCapacityProjection(
        { ...f.value, input: { ...f.value.input, asOfMs: NOW + 1000 } },
        later,
        hash,
      ),
    ).toBeNull()
  })
  it('snapshots approved full input before an exact-hash callback mutates caller Q and all entitlement quotes', () => {
    const f = fixture(),
      baseline = structuredClone(f.value)
    let callbacks = 0
    const result = buildCometHolderCapacityProjection(f.input, (serialized) => {
      callbacks++
      f.input.binding.requestedRaw = '1'
      const agreement = f.input.capacityAgreement as any
      agreement.quote.requestedRaw = '1'
      for (const origin of agreement.origins) origin.quote.requestedRaw = '1'
      return hash(serialized)
    })
    expect(callbacks).toBeGreaterThan(0)
    expect(f.input.binding.requestedRaw).toBe('1')
    expect((f.input.capacityAgreement as any).quote.requestedRaw).toBe('1')
    expect((f.input.cashProjection as any).request.requestedRaw).toBe('20000000')
    expect(result).not.toBeNull()
    expect(result).toEqual(baseline)
    expect(result!.request.requestedRaw).toBe('20000000')
    expect(result!.input.binding.requestedRaw).toBe('20000000')
    expect(result!.scenarios[0].userHeadroomRaw[0]).toBe('480000000')
  })
  it.each(['Q', 'source', 'payload'])(
    'selector snapshots both approved value and expected input before callback mutation of %s',
    (attack) => {
      const f = fixture(),
        payload = structuredClone(f.value),
        expected = structuredClone(f.input),
        baseline = structuredClone(f.value)
      let callbacks = 0
      const result = selectedCometHolderCapacityProjection(payload, expected, (serialized) => {
        callbacks++
        if (attack === 'Q') {
          expected.binding.requestedRaw = '1'
          const agreement = expected.capacityAgreement as any
          agreement.quote.requestedRaw = '1'
          for (const origin of agreement.origins) origin.quote.requestedRaw = '1'
        } else if (attack === 'source') {
          expected.currentSource.blockHash = `0x${'d'.repeat(64)}`
          expected.binding.currentSource.blockHash = `0x${'d'.repeat(64)}`
          const agreement = expected.capacityAgreement as any
          agreement.quote.source.blockHash = `0x${'d'.repeat(64)}`
          for (const origin of agreement.origins)
            origin.quote.source.blockHash = `0x${'d'.repeat(64)}`
        } else {
          payload.scenarios[0].userHeadroomRaw[0] = '499999999'
          payload.request.requestedRaw = '1'
          payload.input.binding.requestedRaw = '1'
        }
        return hash(serialized)
      })
      expect(callbacks).toBeGreaterThan(0)
      if (attack === 'Q') expect(expected.binding.requestedRaw).toBe('1')
      else if (attack === 'source')
        expect(expected.currentSource.blockHash).toBe(`0x${'d'.repeat(64)}`)
      else expect(payload.request.requestedRaw).toBe('1')
      expect(result).not.toBeNull()
      expect(result).toEqual(baseline)
      expect(result!.request.requestedRaw).toBe('20000000')
      expect(result!.scenarios[0].userHeadroomRaw[0]).toBe('480000000')
    },
  )
  it('pause agreement rejects wrong hash/native units, nonprimitive bool, same origin and expired source', () => {
    const f = fixture(),
      expected = { ...f.input.currentSource, source: f.input.binding.currentSource, asOfMs: NOW }
    expect(selectedCometWithdrawFacts(f.input.cometFactsAgreement, expected)).not.toBeNull()
    for (const facts of [
      { ...f.facts, withdrawalsPaused: 1 },
      { ...f.facts, assetDecimals: 18 },
      { ...f.facts, source: { ...f.facts.source, blockHash: `0x${'d'.repeat(64)}` } },
    ]) {
      expect(
        agreeCometWithdrawFacts(
          { host: 'one.example', facts: f.facts },
          { host: 'two.example', facts },
          NOW,
        ),
      ).toBeNull()
    }
    expect(
      agreeCometWithdrawFacts(
        { host: 'one.example', facts: f.facts },
        { host: 'one.example', facts: f.facts },
        NOW,
      ),
    ).toBeNull()
    expect(
      selectedCometWithdrawFacts(f.input.cometFactsAgreement, {
        ...expected,
        asOfMs: Date.parse(f.facts.source.blockTime) + 1800001,
      }),
    ).toBeNull()
  })
})
