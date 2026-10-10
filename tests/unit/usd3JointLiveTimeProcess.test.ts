import { isDeepStrictEqual } from 'node:util'
import { describe, expect, it } from 'vitest'
import { buildConditionalTimeProcess } from '@/lib/venueForecast/conditionalTimeProcess'
import {
  buildUsd3JointLiveTimeProcess as build,
  type Usd3JointLiveTimeInput,
} from '@/lib/carry/usd3JointLiveTimeProcess'
import {
  USD3_HISTORICAL_ROUTE,
  USD3_HISTORICAL_USDC,
  USD3_HISTORICAL_VAULT,
  type Usd3JointHistoricalPoint,
} from '@/lib/carry/usd3JointHistoricalProcess'

const owner = '0x' + 'c'.repeat(40),
  read = '2026-10-08T02:05:00.000Z'
const runtimes = [
  USD3_HISTORICAL_VAULT,
  '0x' + 'a'.repeat(40),
  '0x' + 'b'.repeat(40),
  USD3_HISTORICAL_USDC,
].map((address, n) => ({ address, runtimeKeccak256: '0x' + String(n + 5).repeat(64) }))
function point(n: number, ea = '1000000', limit = '2000000'): Usd3JointHistoricalPoint {
  return {
    source: {
      chainId: 1,
      blockNumber: 100 + n,
      blockHash: '0x' + String(n + 1).repeat(64),
      blockTime: new Date(Date.UTC(2026, 9, 8) + n * 3600000).toISOString(),
      finalized: true,
    },
    acquiredAtUtc: read,
    hypotheticalSharesRaw: '1000000',
    shareDecimals: 6,
    asset: USD3_HISTORICAL_USDC,
    assetDecimals: 6,
    nativeEaRaw: ea,
    availableWithdrawLimitRaw: limit,
    nativeQuoteStatus: 'conditional_reference_address_quote',
    withdrawalLimitSubject: owner,
    conditionalReferenceAddressQuote: true,
    ownerCommitmentQualification: false,
    shutdown: false,
    navRaw: '1000000',
    totalAssetsRaw: '1',
    idleUsdcDiagnosticRaw: '0',
    idleUsdcIsTotalFundingUpperBound: false,
    sourceClass: 'captured_identical_runtimes_only',
    runtimeIdentities: structuredClone(runtimes),
    sourceImplementationEquivalence: false,
  }
}
function fixture(): Usd3JointLiveTimeInput {
  return {
    routeKey: USD3_HISTORICAL_ROUTE,
    destination: USD3_HISTORICAL_VAULT,
    asset: USD3_HISTORICAL_USDC,
    assetDecimals: 6,
    owner,
    issueAtUtc: '2026-10-08T02:10:00.000Z',
    knowledgeCutoffUtc: read,
    requestedRaw: '1000000',
    horizonHours: 1,
    maxHistoricalGapSeconds: 91800,
    history: [point(0), point(1)],
    current: {
      source: point(2).source,
      readAtUtc: read,
      sharesRaw: '1000000',
      shareDecimals: 6,
      nativeEaRaw: '1000000',
      availableWithdrawLimitRaw: '2000000',
      shutdown: false,
      runtimeIdentities: structuredClone(runtimes),
      ownerMaxWithdrawRaw: '5',
    },
  }
}
function run(i = fixture()) {
  const approved = structuredClone(i)
  return build(i, (candidate) => isDeepStrictEqual(candidate, approved))
}
describe('USD3 native joint live conditional time math', () => {
  it('preserves real issue+H clock and projects all elapsed source age with joint NET once', () => {
    const i = fixture()
    i.history = [point(0, '1000000', '2000000'), point(1, '1000600', '1999700')]
    const m = run(i)!,
      target = m.process!.scenarios[0].points.at(-1)!
    expect(m.targetAtUtc).toBe('2026-10-08T03:10:00.000Z')
    expect(m.process!.issueAtUtc).toBe(i.issueAtUtc)
    expect(m.process!.input.current.readAtUtc).toBe(read)
    expect(m.process!.scenarios[0].donor.availableAtUtc).toEqual([read, read])
    expect(target.elapsedFromSourceSeconds).toBe(4200)
    expect(target.entitlementRaw).toBe('1000700')
    expect(target.availableRaw).toBe('1999650')
    expect(target.capacityRaw).toBe('1000700')
    expect(target.headroomRaw).toBe('700')
    expect(m.process!.sourceProofValidUntil).toBe('2026-10-08T02:30:00.000Z')
    expect(m.ownerMaxWithdrawRaw).toBe('5')
    expect(m.ownerMaxWithdrawIsFutureFunding).toBe(false)
    expect(m.MRaw).toBeNull()
  })
  it('keeps S/Ea/C separate from Q and clips only after joint projection', () => {
    const i = fixture()
    i.issueAtUtc = i.current.source.blockTime
    i.current.readAtUtc = i.current.source.blockTime
    i.history.forEach((p) => {
      p.acquiredAtUtc = i.current.source.blockTime
    })
    i.knowledgeCutoffUtc = i.current.source.blockTime
    i.history = i.history.map((p, n) => ({
      ...p,
      nativeEaRaw: n ? '1400' : '1000',
      availableWithdrawLimitRaw: n ? '1700' : '2000',
    }))
    i.current.nativeEaRaw = '1400'
    i.current.availableWithdrawLimitRaw = '1700'
    i.requestedRaw = '1000'
    const a = run(i)!
    expect(a.process!.scenarios[0].points.at(-1)).toMatchObject({
      entitlementRaw: '1800',
      availableRaw: '1400',
      capacityRaw: '1400',
      headroomRaw: '400',
    })
    i.requestedRaw = '500'
    const b = run(i)!
    expect(a.sharesRaw).toBe(b.sharesRaw)
    expect(a.process!.scenarios[0].donor.jointDeltaRaw).toEqual(
      b.process!.scenarios[0].donor.jointDeltaRaw,
    )
    expect(b.process!.scenarios[0].targetHeadroomRaw).toBe('900')
  })
  it('retains the full three-point input and exact independently replayable interval inputs for opposing flows', () => {
    const i = fixture()
    i.history = [point(0, '1000000'), point(1, '1000600'), point(2, '999400')]
    i.current.source = point(3).source
    i.current.readAtUtc = '2026-10-08T03:05:00.000Z'
    i.issueAtUtc = '2026-10-08T03:10:00.000Z'
    i.knowledgeCutoffUtc = i.current.readAtUtc
    const m = run(i)!,
      p = m.process!
    expect(p.input).toBe(m.input)
    expect(p.input).toEqual(i)
    expect(p.input.history).toHaveLength(3)
    expect(p).not.toHaveProperty('historicalInputContainsFirstEligibleIntervalOnly')
    expect(p.scenarios.map((s) => s.targetHeadroomRaw)).toEqual(['700', '-1400'])
    expect(p.intervalInputs.map((d) => d.fromIndex)).toEqual([0, 1])
    for (const donor of p.intervalInputs) {
      expect(donor.input.observations).toHaveLength(2)
      expect(donor.input.observations.map((o) => o.sourceAtUtc)).toEqual(
        i.history.slice(donor.fromIndex, donor.fromIndex + 2).map((h) => h.source.blockTime),
      )
      const replay = buildConditionalTimeProcess(
        donor.input,
        () => true,
        (state) => ({ availableRaw: state.native_limit, entitlementRaw: state.full_entitlement }),
      )!
      const {
        fromIndex: _from,
        donorSources: _sources,
        ...combinedScenario
      } = p.scenarios.find((s) => s.fromIndex === donor.fromIndex)!
      expect(replay.scenarios).toEqual([combinedScenario])
    }
    i.history[0].nativeEaRaw = '1'
    expect(p.input.history[0].nativeEaRaw).toBe('1000000')
    expect(p.intervalInputs[0].input.observations[0].valuesByChannel.full_entitlement).toBe(
      '1000000',
    )
  })
  it.each(['gap', 'unsupported'] as const)(
    'keeps full %s evidence without creating donors across excluded adjacent intervals',
    (reason) => {
      const i = fixture()
      i.history = [point(0), point(1), point(2), point(3)]
      i.current.source = point(4).source
      i.current.readAtUtc = '2026-10-08T04:05:00.000Z'
      i.issueAtUtc = '2026-10-08T04:10:00.000Z'
      i.knowledgeCutoffUtc = i.current.readAtUtc
      i.history.forEach((h) => {
        h.acquiredAtUtc = i.current.readAtUtc
      })
      if (reason === 'gap') i.history[0].source.blockTime = '2026-10-06T00:00:00.000Z'
      else {
        i.history[1].availableWithdrawLimitRaw = null
        i.history[1].nativeQuoteStatus = 'censored_native_withdrawal_limit_unavailable'
      }
      const m = run(i)!,
        p = m.process!
      expect(p.input).toEqual(i)
      expect(p.input.history).toHaveLength(4)
      expect(p.intervalInputs.map((d) => d.fromIndex)).toEqual(reason === 'gap' ? [1, 2] : [2])
      expect(p.targetSummary).toBeNull()
      for (const donor of p.intervalInputs) {
        const replay = buildConditionalTimeProcess(
          donor.input,
          () => true,
          (state) => ({ availableRaw: state.native_limit, entitlementRaw: state.full_entitlement }),
        )!
        expect(donor.input.observations.map((o) => o.sourceAtUtc)).toEqual(
          i.history.slice(donor.fromIndex, donor.fromIndex + 2).map((h) => h.source.blockTime),
        )
        const {
          fromIndex: _from,
          donorSources: _sources,
          ...combinedScenario
        } = p.scenarios.find((s) => s.fromIndex === donor.fromIndex)!
        expect(replay.scenarios).toEqual([combinedScenario])
      }
      expect(p.intervalInputs.some((d) => d.fromIndex === 0)).toBe(false)
    },
  )
  it.each([1, 24, 48, 168] as const)(
    'supports H%s with bounded samples and no continuous-path claim',
    (horizon) => {
      const i = fixture()
      i.horizonHours = horizon
      const m = run(i)!
      expect(Date.parse(m.targetAtUtc) - Date.parse(m.issueAtUtc)).toBe(horizon * 3600000)
      expect(m.process!.scenarios[0].points.length).toBeLessThanOrEqual(128)
      expect(m.continuousPathKnown).toBe(false)
      expect(m.executionProven).toBe(false)
      expect(m.prospectiveValidated).toBe(false)
      expect(m.calibrationProven).toBe(false)
      expect(m.historicalOwnership).toBe(false)
    },
  )
  it('preserves attempted unsupported/regime/owner/S tails and suppresses complete headline', () => {
    const mutate = [
      (p: Usd3JointHistoricalPoint) => {
        p.availableWithdrawLimitRaw = null
        p.nativeQuoteStatus = 'censored_native_withdrawal_limit_unavailable'
      },
      (p: Usd3JointHistoricalPoint) => {
        p.runtimeIdentities[2].runtimeKeccak256 = '0x' + 'f'.repeat(64)
      },
      (p: Usd3JointHistoricalPoint) => {
        p.shutdown = true
      },
      (p: Usd3JointHistoricalPoint) => {
        p.withdrawalLimitSubject = '0x' + 'd'.repeat(40)
      },
      (p: Usd3JointHistoricalPoint) => {
        p.hypotheticalSharesRaw = '2'
      },
    ]
    for (const change of mutate) {
      const i = fixture()
      i.current.source = point(3).source
      i.current.readAtUtc = '2026-10-08T03:05:00.000Z'
      i.issueAtUtc = '2026-10-08T03:10:00.000Z'
      i.knowledgeCutoffUtc = i.current.readAtUtc
      i.history = [point(0), point(1), point(2)]
      change(i.history[0])
      const m = run(i)!
      expect(m.counts).toEqual({ attempted: 2, usable: 1, censored: 0, excluded: 1 })
      expect(m.process!.scenarios[0].fromIndex).toBe(1)
      expect(m.process!.excludedIntervals[0].fromIndex).toBe(0)
      expect(m.process!.targetSummary).toBeNull()
      expect(m.completeAttemptedIntervalCoverage).toBe(false)
    }
  })
  it('retains excluded over-gap donor instead of manufacturing a long-period rate', () => {
    const i = fixture()
    i.history[0].source.blockTime = '2026-10-06T00:00:00.000Z'
    const m = run(i)!
    expect(m.counts.excluded).toBe(1)
    expect(m.excludedIntervals[0].reason).toBe('historical_gap')
    expect(m.process).toBeNull()
  })
  it('accepts native zero C and Ea; unknown/shutdown current is unavailable, never fabricated zero', () => {
    const i = fixture()
    i.current.availableWithdrawLimitRaw = '0'
    i.current.nativeEaRaw = '0'
    const m = run(i)!
    expect(m.currentMeasurement.capacityRaw).toBe('0')
    expect(m.process!.scenarios[0].targetHeadroomRaw).toBe('-1000000')
    i.current.availableWithdrawLimitRaw = null
    expect(run(i)).toBeNull()
    i.current.availableWithdrawLimitRaw = '2000000'
    i.current.shutdown = null
    expect(run(i)).toBeNull()
    i.current.shutdown = true
    expect(run(i)).toBeNull()
  })
  it.each(['nativeEaRaw', 'availableWithdrawLimitRaw'] as const)(
    'censors negative projected %s without clamping',
    (key) => {
      const i = fixture()
      i.history[0][key] = '2000000'
      i.history[1][key] = '500000'
      i.current[key] = '1000000'
      const m = run(i)!
      expect(m.counts.censored).toBe(1)
      expect(m.process!.scenarios[0].reason).toBe('negative_joint_prong')
      expect(m.process!.scenarios[0].targetHeadroomRaw).toBeNull()
      expect(m.process!.targetSummary).toBeNull()
      expect(m.process!.scenarios[0].points.flatMap((p) => p.clampedChannels)).toEqual([])
    },
  )
  it('keeps donor endpoint at/after current source out of predictions', () => {
    const i = fixture()
    i.history.push(point(2))
    const m = run(i)!
    expect(m.counts).toEqual({ attempted: 2, usable: 1, censored: 0, excluded: 1 })
    expect(m.excludedIntervals[0].reason).toBe('not_strictly_before_current_source')
    expect(m.process!.targetSummary).toBeNull()
  })
  it.each([
    'futureRead',
    'stale',
    'futureAcquisition',
    'cutoff',
    'decimal',
    'owner',
    'asset',
    'blockOrder',
    'UTC',
    'uint',
    'zeroQ',
  ])('rejects invalid %s rather than rewriting clocks or rebinding', (what) => {
    const i = fixture()
    if (what === 'futureRead') i.current.readAtUtc = '2026-10-08T02:11:00.000Z'
    if (what === 'stale') i.issueAtUtc = '2026-10-08T02:30:00.001Z'
    if (what === 'futureAcquisition') i.history[1].acquiredAtUtc = '2026-10-08T02:11:00.000Z'
    if (what === 'cutoff') i.knowledgeCutoffUtc = i.issueAtUtc
    if (what === 'decimal') (i.current as unknown as { shareDecimals: number }).shareDecimals = 18
    if (what === 'owner') i.owner = '0x' + '0'.repeat(40)
    if (what === 'asset') (i as unknown as { asset: string }).asset = USD3_HISTORICAL_VAULT
    if (what === 'blockOrder') i.history[1].source.blockNumber = i.history[0].source.blockNumber
    if (what === 'UTC') i.issueAtUtc = '2026-10-08T02:10:00Z'
    if (what === 'uint') i.current.nativeEaRaw = (1n << 256n).toString()
    if (what === 'zeroQ') i.requestedRaw = '0'
    expect(run(i)).toBeNull()
  })
  it('accepts uint256 endpoint and censors overflowing projection', () => {
    const i = fixture()
    i.current.nativeEaRaw = ((1n << 256n) - 1n).toString()
    expect(run(i)).not.toBeNull()
    i.history[1].nativeEaRaw = '1000001'
    expect(run(i)!.counts.censored).toBe(1)
  })
  it('snapshots without mutation; false/throwing approval cannot mint a model', () => {
    const i = fixture(),
      before = structuredClone(i)
    expect(build(i, () => false)).toBeNull()
    expect(
      build(i, () => {
        throw Error('rejected')
      }),
    ).toBeNull()
    const m = run(i)!
    expect(i).toEqual(before)
    i.current.nativeEaRaw = '1'
    expect(m.input.current.nativeEaRaw).toBe(before.current.nativeEaRaw)
    expect(m.status).toBe('conditional_usd3_native_joint_time_process')
  })
})
