import { isDeepStrictEqual } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  buildUsd3JointHistoricalProcess as build,
  USD3_HISTORICAL_ROUTE,
  USD3_HISTORICAL_VAULT,
  USD3_HISTORICAL_USDC,
  USD3_REFERENCE_SUBJECT,
  type Usd3JointHistoricalInput,
  type Usd3JointHistoricalPoint,
} from '@/lib/carry/usd3JointHistoricalProcess'

const acquired = '2026-10-09T12:00:00.000Z'
function point(n: number, ea = '1000', limit = '2000'): Usd3JointHistoricalPoint {
  return {
    source: {
      chainId: 1,
      blockNumber: String(100 + n),
      blockHash: '0x' + String(n + 1).repeat(64),
      blockTime: new Date(Date.UTC(2026, 9, 8) + n * 3600000).toISOString(),
      finalized: true,
    },
    acquiredAtUtc: acquired,
    hypotheticalSharesRaw: '1000000',
    shareDecimals: 6,
    asset: USD3_HISTORICAL_USDC,
    assetDecimals: 6,
    nativeEaRaw: ea,
    availableWithdrawLimitRaw: limit,
    nativeQuoteStatus: 'conditional_reference_address_quote',
    withdrawalLimitSubject: USD3_REFERENCE_SUBJECT,
    conditionalReferenceAddressQuote: true,
    ownerCommitmentQualification: false,
    shutdown: false,
    navRaw: '1000000',
    totalAssetsRaw: '999999',
    idleUsdcDiagnosticRaw: '1',
    idleUsdcIsTotalFundingUpperBound: false,
    sourceClass: 'captured_identical_runtimes_only',
    runtimeIdentities: [
      USD3_HISTORICAL_VAULT,
      '0x' + 'a'.repeat(40),
      '0x' + 'b'.repeat(40),
      USD3_HISTORICAL_USDC,
    ].map((address, index) => ({ address, runtimeKeccak256: '0x' + String(index + 5).repeat(64) })),
    sourceImplementationEquivalence: false,
  }
}
function fixture(): Usd3JointHistoricalInput {
  const baseline = point(2)
  return {
    mode: 'retrospective_replay',
    routeKey: USD3_HISTORICAL_ROUTE,
    destination: USD3_HISTORICAL_VAULT,
    owner: null,
    issueAtUtc: acquired,
    knowledgeCutoffUtc: baseline.source.blockTime,
    horizonHours: 1,
    requestedRaw: '1000',
    history: [point(0), point(1)],
    baseline,
    maxHistoricalGapSeconds: 3600,
  }
}
function run(i = fixture()) {
  const approved = structuredClone(i)
  return build(i, (candidate) => isDeepStrictEqual(candidate, approved))
}
describe('USD3 same-S retrospective joint native process', () => {
  it('accepts one explicitly declared nonzero getter reference without implying past ownership', () => {
    const i = fixture(),
      reference = '0x0000000000000000000000000000000000000001'
    i.withdrawalLimitSubject = reference
    for (const p of [...i.history, i.baseline]) p.withdrawalLimitSubject = reference
    const model = run(i)!
    expect(model.referenceSubject).toBe(reference)
    expect(model.referenceSubjectQualification).toBe('getter_reference_only')
    expect(model.owner).toBeNull()
    expect(model.historicalOwnership).toBe(false)
    expect(model.ownerCommitmentQualified).toBe(false)
    expect(model.executionProven).toBe(false)
    expect(model.input.withdrawalLimitSubject).toBe(reference)
  })
  it('keeps omitted zero-reference input/output unchanged and accepts an explicit zero declaration', () => {
    const legacy = run()!
    expect(Object.hasOwn(legacy, 'referenceSubject')).toBe(false)
    expect(Object.hasOwn(legacy.input, 'withdrawalLimitSubject')).toBe(false)
    const explicit = fixture()
    explicit.withdrawalLimitSubject = USD3_REFERENCE_SUBJECT
    const model = run(explicit)!
    expect(model.scenarios).toEqual(legacy.scenarios)
    expect(model.targetSummary).toEqual(legacy.targetSummary)
    expect(Object.hasOwn(model, 'referenceSubject')).toBe(false)
  })
  it('rejects mixed getter references, undeclared nonzero references and noncanonical declarations', () => {
    const reference = '0x0000000000000000000000000000000000000001',
      i = fixture()
    i.baseline.withdrawalLimitSubject = reference
    expect(run(i)).toBeNull()
    i.withdrawalLimitSubject = reference
    expect(run(i)).toBeNull()
    for (const p of i.history) p.withdrawalLimitSubject = reference
    expect(run(i)).not.toBeNull()
    i.withdrawalLimitSubject = '0x' + 'A'.repeat(40)
    expect(run(i)).toBeNull()
    i.withdrawalLimitSubject = '0x1'
    expect(run(i)).toBeNull()
  })
  it('lets funding bind a large fixed S while Q affects only final headroom', () => {
    const i = fixture(),
      reference = '0x0000000000000000000000000000000000000001'
    i.withdrawalLimitSubject = reference
    i.requestedRaw = '500000000000'
    for (const p of [...i.history, i.baseline]) {
      p.withdrawalLimitSubject = reference
      p.hypotheticalSharesRaw = '3000000000000'
      p.nativeEaRaw = '3100000000000'
      p.availableWithdrawLimitRaw = '1000000000000'
    }
    const low = run(i)!
    expect(low.baselineMeasurement.capacityRaw).toBe('1000000000000')
    expect(low.baselineMeasurement.holderEntitlementShortfall).toBe(false)
    expect(low.baselineMeasurement.fundingShortfall).toBe(false)
    i.requestedRaw = '2000000000000'
    const high = run(i)!
    expect(high.sharesRaw).toBe(low.sharesRaw)
    expect(high.baselineMeasurement.capacityRaw).toBe(low.baselineMeasurement.capacityRaw)
    expect(high.baselineMeasurement.holderEntitlementShortfall).toBe(false)
    expect(high.baselineMeasurement.fundingShortfall).toBe(true)
    expect(high.scenarios[0].targetHeadroomRaw).toBe('-1000000000000')
    expect(low.scenarios[0].donor.jointDeltaRaw).toEqual(high.scenarios[0].donor.jointDeltaRaw)
  })
  it('projects both channels jointly before min and subtracts Q once', () => {
    const i = fixture()
    i.history = [point(0, '1000', '2000'), point(1, '1400', '1700')]
    i.baseline = point(2, '1400', '1700')
    const m = run(i)!,
      p = m.scenarios[0].points.at(-1)!
    expect(m.scenarios[0].donor.jointDeltaRaw).toEqual({
      fullEa: '400',
      nativeWithdrawLimit: '-300',
    })
    expect(p.entitlementRaw).toBe('1800')
    expect(p.availableRaw).toBe('1400')
    expect(p.capacityRaw).toBe('1400')
    expect(p.headroomRaw).toBe('400')
    // Moving the already-clipped historical minimum gives 1800 and incorrectly reports 800.
    expect(p.headroomRaw).not.toBe('800')
    expect(m.baselineMeasurement.capacityRaw).toBe('1400') // idle USDC=1 is diagnostic only.
    expect(m.MRaw).toBeNull()
  })
  it('keeps full S independent of Q and rejects zero Q', () => {
    const i = fixture(),
      a = run(i)!
    i.requestedRaw = '500'
    const b = run(i)!
    expect(a.sharesRaw).toBe(b.sharesRaw)
    expect(a.scenarios[0].donor.jointDeltaRaw).toEqual(b.scenarios[0].donor.jointDeltaRaw)
    expect(b.scenarios[0].targetHeadroomRaw).toBe('500')
    i.requestedRaw = '0'
    expect(run(i)).toBeNull()
  })
  it('distinguishes holder entitlement shortfall from funding shortfall', () => {
    const i = fixture()
    i.baseline = point(2, '500', '2000')
    expect(run(i)!.baselineMeasurement).toMatchObject({
      holderEntitlementShortfall: true,
      fundingShortfall: false,
    })
    i.baseline = point(2, '2000', '500')
    expect(run(i)!.baselineMeasurement).toMatchObject({
      holderEntitlementShortfall: false,
      fundingShortfall: true,
    })
  })
  it('retains acquisition clock and historical cutoff without claiming past live evidence', () => {
    const m = run()!
    expect(m.issueAtUtc).toBe(acquired)
    expect(m.acquiredAtUtc).toBe(acquired)
    expect(m.historicalIssueAtUtc).toBe(m.sourceAtUtc)
    expect(m.targetAtUtc).toBe('2026-10-08T03:00:00.000Z')
    expect(m.input.history[0].acquiredAtUtc).toBe(acquired)
    expect(m.reconstructedHistoricalAvailabilityIsLiveEvidence).toBe(false)
    expect(m.owner).toBeNull()
    expect(m.historicalOwnership).toBe(false)
    expect(m.ownerCommitmentQualified).toBe(false)
    expect(m.executionProven).toBe(false)
    expect(m.calibrationProven).toBe(false)
    expect(m.sourceProofValidUntil).toBeNull()
  })
  it('supports arbitrary positive horizon and bounded checkpoints', () => {
    const i = fixture()
    i.horizonHours = 168
    const m = run(i)!
    expect(m.scenarios[0].points.length).toBeLessThanOrEqual(128)
    expect(m.scenarios[0].points.at(-1)!.atUtc).toBe(m.targetAtUtc)
    expect(m.continuousPathKnown).toBe(false)
  })
  it('uses only original adjacent intervals strictly before baseline and suppresses excluded-tail headline', () => {
    const i = fixture()
    i.history.push(point(2), point(3))
    const m = run(i)!
    expect(m.counts).toEqual({ attempted: 3, usable: 1, censored: 0, excluded: 2 })
    expect(m.scenarios.map((s) => s.fromIndex)).toEqual([0])
    expect(m.excludedIntervals.map((s) => s.reason)).toEqual([
      'not_strictly_before_baseline',
      'not_strictly_before_baseline',
    ])
    expect(m.targetSummary).toBeNull()
    expect(m.descriptiveExpectedFlow).toBeNull()
  })
  it('retains missing getter causes and does not substitute zero', () => {
    const i = fixture()
    i.history[0].availableWithdrawLimitRaw = null
    i.history[0].nativeQuoteStatus = 'censored_native_withdrawal_limit_unavailable'
    expect(run(i)!.excludedIntervals[0].reason).toBe('native_withdrawal_limit_unavailable')
    expect(run(i)!.counts.usable).toBe(0)
    i.baseline.availableWithdrawLimitRaw = null
    i.baseline.nativeQuoteStatus = 'censored_native_withdrawal_limit_unavailable'
    expect(run(i)!.baselineMeasurement.capacityRaw).toBeNull()
    expect(run(i)!.baselineMeasurement.fundingShortfall).toBeNull()
  })
  it('fingerprints raw implementation/delegate evidence and excludes changed classes', () => {
    const i = fixture(),
      initial = run(i)!.regimeFingerprint
    i.history[0].runtimeIdentities[2].runtimeKeccak256 = '0x' + 'f'.repeat(64)
    expect(run(i)!.excludedIntervals[0].reason).toBe('native_runtime_class_mismatch')
    expect(run(i)!.targetSummary).toBeNull()
    i.baseline.runtimeIdentities[1].address = '0x' + 'c'.repeat(40)
    expect(run(i)!.regimeFingerprint).not.toBe(initial)
  })
  it.each(['nativeEaRaw', 'availableWithdrawLimitRaw'] as const)(
    'censors negative projected %s without clamping',
    (channel) => {
      const i = fixture()
      i.history[0][channel] = '2000'
      i.history[1][channel] = '500'
      i.baseline[channel] = '1000'
      const m = run(i)!
      expect(m.counts.censored).toBe(1)
      expect(m.scenarios[0].reason).toBe('negative_joint_prong')
      expect(m.scenarios[0].targetHeadroomRaw).toBeNull()
      expect(m.targetSummary).toBeNull()
      expect(m.scenarios[0].points.flatMap((p) => p.clampedChannels)).toEqual([])
    },
  )
  it('excludes changed S and gap while preserving distinct original intervals', () => {
    const i = fixture()
    i.history[0].hypotheticalSharesRaw = '2'
    expect(run(i)!.excludedIntervals[0].reason).toBe('same_share_position_mismatch')
    i.history[0].hypotheticalSharesRaw = i.baseline.hypotheticalSharesRaw
    i.maxHistoricalGapSeconds = 3599
    expect(run(i)!.excludedIntervals[0].reason).toBe('historical_gap')
  })
  it.each([
    'asset',
    'decimals',
    'subject',
    'cutoff',
    'block',
    'time',
    'acquisition',
    'destination',
    'owner',
  ])('rejects invalid %s identity or clock', (field) => {
    const i = fixture()
    if (field === 'asset') i.history[0].asset = USD3_HISTORICAL_VAULT
    if (field === 'decimals')
      (i.history[0] as unknown as { assetDecimals: number }).assetDecimals = 18
    if (field === 'subject') i.baseline.withdrawalLimitSubject = USD3_HISTORICAL_VAULT
    if (field === 'cutoff') i.knowledgeCutoffUtc = acquired
    if (field === 'block') i.history[1].source.blockNumber = i.history[0].source.blockNumber
    if (field === 'time') i.history[1].source.blockTime = i.history[0].source.blockTime
    if (field === 'acquisition') i.baseline.acquiredAtUtc = '2026-10-07T00:00:00.000Z'
    if (field === 'destination')
      (i as unknown as { destination: string }).destination = USD3_HISTORICAL_USDC
    if (field === 'owner') (i as unknown as { owner: string }).owner = USD3_HISTORICAL_VAULT
    expect(run(i)).toBeNull()
  })
  it('does not authenticate evidence from model structure or mutate approved input', () => {
    const i = fixture(),
      before = structuredClone(i)
    expect(build(i, () => false)).toBeNull()
    expect(run(i)).not.toBeNull()
    expect(i).toEqual(before)
  })
})
