import { isDeepStrictEqual } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  buildFluidBridgeUsdcJointHistoricalProcess as build,
  FLUID_BRIDGE_USDC,
  FLUID_BRIDGE_USDC_PRONGS,
  type FluidBridgeUsdcFrame,
  type FluidBridgeUsdcJointInput,
} from '@/lib/carry/fluidBridgeUsdcJointHistoricalProcess'

const owner = '0x3f825bb69af74a4921dd051c80fe8bf8fb7d3a2e'
/** Synthetic clocks/hashes; S and Ea pair mirror captured B26101887→26102143 (3072s).
 * This fixture is not native evidence approval or an actual current holder capture. */
function frame(
  n: number,
  ea: string,
): Extract<FluidBridgeUsdcFrame, { provenanceKind: 'original_issue_bound' }> {
  const time = new Date(Date.UTC(2026, 9, 8) + n * 3072000).toISOString()
  return {
    source: {
      chainId: 1,
      blockNumber: String(26101887 + n * 256),
      blockHash: '0x' + String(n + 1).repeat(64),
      blockTime: time,
    },
    availableAtUtc: time,
    acquiredAtUtc: time,
    provenanceKind: 'original_issue_bound',
    historicalOwnership: true,
    provenanceRef: 'synthetic_fixture_' + n,
    originalIssue: {
      issueId: 'native_usdt_question_' + n,
      routeKey: 'USDT → FluidBridgeAggregatorProxy [USDC]',
      issueAtUtc: time,
      targetAtUtc: new Date(Date.parse(time) + 86400000).toISOString(),
      horizonHours: 24,
      requestedRaw: '100000',
      assetUnit: 'USDC_first_leg_assets',
      finalUsdtRequestedRaw: null,
    },
    owner,
    holderSharesRaw: '967573479322309282',
    shareDecimals: 18,
    asset: FLUID_BRIDGE_USDC,
    assetDecimals: 6,
    fundingUnit: 'gross_native_USDC',
    entitlementUnit: 'net_native_USDC',
    runtimeCodeHashes: { [FLUID_BRIDGE_USDC]: '0x' + 'a'.repeat(64) },
    regime: 'synthetic_lite_fee5_unpaused',
    paused: false,
    withdrawalFeeBps: 5,
    fullHolderNetUsdcRaw: ea,
    nativeProngs: Object.fromEntries(
      FLUID_BRIDGE_USDC_PRONGS.map((k) => [k, '2000000']),
    ) as FluidBridgeUsdcFrame['nativeProngs'],
  }
}
function fixture(): FluidBridgeUsdcJointInput {
  const baseline = frame(2, '1014581')
  return {
    mode: 'current_conditional',
    routeKey: 'USDC → FluidBridgeAggregatorProxy [USDC]',
    destination: '0x273da948aca9261043fbdb2a857bc255ecc29012',
    owner,
    issueAtUtc: baseline.source.blockTime,
    knowledgeCutoffUtc: baseline.source.blockTime,
    horizonHours: 3072 / 3600,
    requestedRaw: '1000000',
    history: [frame(0, '1014574'), frame(1, '1014581')],
    baseline,
    maxHistoricalGapSeconds: 3072,
  }
}
function retrospectiveFixture(): FluidBridgeUsdcJointInput {
  const capturedAt = '2026-10-09T12:00:00.000Z'
  const hypothetical = (f: FluidBridgeUsdcFrame): FluidBridgeUsdcFrame => {
    const { originalIssue: _originalIssue, ...facts } = f
    return {
      ...facts,
      provenanceKind: 'native_hypothetical_shares',
      owner: null,
      historicalOwnership: false,
      acquiredAtUtc: capturedAt,
      availableAtUtc: capturedAt,
    }
  }
  const i = fixture()
  return {
    ...i,
    mode: 'retrospective_replay',
    owner: null,
    issueAtUtc: capturedAt,
    retrospectiveAvailabilityAssumption: 'historical_chain_state_reconstructed_later',
    history: i.history.map(hypothetical),
    baseline: hypothetical(i.baseline),
  }
}
function run(i = fixture()) {
  const approved = structuredClone(i)
  return build(i, (_kind, candidate) => isDeepStrictEqual(candidate, approved))
}
describe('USDC bridge simultaneous native conditional math', () => {
  it('projects full same-S net Ea rather than freezing it or using requested shares', () => {
    const m = run()!
    expect(m.sharesRaw).toBe('967573479322309282')
    expect(m.fullEaRaw).toBe('1014581')
    expect(m.scenarios[0].jointNetDeltaRaw.fullEa).toBe('7')
    expect(m.scenarios[0].targetMeasurement?.fullEaRaw).toBe('1014588')
    expect(m.descriptiveExpectedFlow?.floorRaw).toBe('14588')
    expect(m.descriptiveStressedRange).toEqual({ minRaw: '14588', maxRaw: '14588' })
    expect(m.counts).toEqual({ attempted: 1, usable: 1, censored: 0, excluded: 0 })
    expect(m.MRaw).toBeNull()
    expect(m.thinHistoricalEvidence).toBe(true)
    expect(m.calibratedProbability).toBe(false)
    expect(m.empiricalRecoveryDurationDistribution).toBeNull()
    expect(m.input.history[0].originalIssue!.routeKey).toBe(
      'USDT → FluidBridgeAggregatorProxy [USDC]',
    )
    expect(m.targetAtUtc).toBe(new Date(Date.parse(m.sourceAtUtc) + 3072000).toISOString())
  })
  it('uses the weak gross prong, fee ceiling-equivalent floor once, then Q once', () => {
    const i = fixture()
    for (const f of [...i.history, i.baseline]) f.nativeProngs.bankCash = '10001'
    i.requestedRaw = '10000'
    const m = run(i)!,
      p = m.scenarios[0].targetMeasurement!
    expect(p.bindingProngs).toEqual(['bankCash'])
    expect(p.fundingNetRaw).toBe('9995')
    expect(p.availableRaw).toBe('9995')
    expect(p.headroomRaw).toBe('-5')
    expect(BigInt(p.fundingNetRaw)).toBe(10001n - (10001n * 5n + 9999n) / 10000n)
    expect(m.scenarios[0].sampledLossRuns[0]).toMatchObject({
      leftCensored: true,
      rightCensored: true,
    })
  })
  it('projects falling Ea into a sampled shortfall independently of abundant funding', () => {
    const i = fixture()
    i.history[0].fullHolderNetUsdcRaw = '2000000'
    i.history[1].fullHolderNetUsdcRaw = '1000000'
    i.baseline.fullHolderNetUsdcRaw = '1500000'
    const m = run(i)!
    expect(m.scenarios[0].targetMeasurement?.availableRaw).toBe('500000')
    expect(m.descriptiveExpectedFlow?.floorRaw).toBe('-500000')
    expect(m.scenarios[0].sampledLossRuns[0]).toMatchObject({
      leftCensored: false,
      rightCensored: true,
    })
    expect(m.scenarios[0].sampledLossRuns[0].after).toBe(i.baseline.source.blockTime)
  })
  it('excludes over-gap donors instead of treating missing time as complete coverage', () => {
    const i = fixture()
    i.maxHistoricalGapSeconds = 3071
    expect(run(i)?.excludedIntervals[0].reason).toBe('historical_gap')
    expect(run(i)?.descriptiveExpectedFlow).toBeNull()
  })
  it('includes source age in projection while retaining original issue clock', () => {
    const i = fixture()
    i.issueAtUtc = new Date(Date.parse(i.issueAtUtc) + 600000).toISOString()
    expect(run(i)?.descriptiveExpectedFlow?.floorRaw).toBe('14588')
    expect(run(i)?.issueAtUtc).toBe(i.issueAtUtc)
    i.issueAtUtc = new Date(Date.parse(i.baseline.source.blockTime) + 1800001).toISOString()
    expect(run(i)).toBeNull()
  })
  it.each(['holderSharesRaw', 'regime', 'withdrawalFeeBps', 'runtimeCodeHashes'] as const)(
    'excludes changed %s donors and suppresses headline',
    (key) => {
      const i = fixture()
      if (key === 'holderSharesRaw') i.history[0][key] = '1'
      if (key === 'regime') i.history[0][key] = 'changed'
      if (key === 'withdrawalFeeBps') i.history[0][key] = 6
      if (key === 'runtimeCodeHashes') i.history[0][key][FLUID_BRIDGE_USDC] = '0x' + 'b'.repeat(64)
      expect(run(i)?.counts).toEqual({ attempted: 1, usable: 0, censored: 0, excluded: 1 })
      expect(run(i)?.descriptiveExpectedFlow).toBeNull()
    },
  )
  it('censuses excluded tails without averaging them away', () => {
    const i = fixture()
    i.history.push(structuredClone(i.baseline))
    const m = run(i)!
    expect(m.counts).toEqual({ attempted: 2, usable: 1, censored: 0, excluded: 1 })
    expect(m.descriptiveExpectedFlow).toBeNull()
    expect(m.descriptiveStressedRange).toBeNull()
  })
  it('accepts a dated endpoint donor but never calls it a prospective forecast', () => {
    const i = fixture()
    i.mode = 'dated_captured_projection'
    i.baseline = structuredClone(i.history[1])
    i.issueAtUtc = i.baseline.source.blockTime
    i.knowledgeCutoffUtc = i.issueAtUtc
    expect(run(i)?.counts.usable).toBe(1)
    expect(run(i)?.sourceProofValidUntil).toBeNull()
    expect(run(i)?.originalProspectiveForecast).toBe(false)
    i.mode = 'current_conditional'
    expect(run(i)?.counts.excluded).toBe(1)
  })
  it('bounds long-horizon checkpoints and leaves between-sample duration unknown', () => {
    const i = fixture()
    i.horizonHours = 168
    const m = run(i)!
    expect(m.scenarios[0].points.length).toBe(65)
    expect(m.scenarios[0].points.at(-1)?.atUtc).toBe(m.targetAtUtc)
    expect(m.scenarios[0].maximumCheckpointGapMs).toBeGreaterThan(3072000)
    expect(m.betweenSamplesKnown).toBe(false)
  })
  it('censors arithmetic overflow rather than reporting complete headroom', () => {
    const i = fixture()
    for (const k of FLUID_BRIDGE_USDC_PRONGS)
      i.baseline.nativeProngs[k] = ((1n << 256n) - 1n).toString()
    expect(run(i)?.counts.censored).toBe(1)
    expect(run(i)?.descriptiveExpectedFlow).toBeNull()
  })
  it.each([
    'cutoff',
    'availability',
    'originalIssue',
    'unit',
    'owner',
    'sparse',
    'order',
    'uint',
    'target',
    'route',
  ])('rejects %s leakage or rebinding', (fault) => {
    const i = fixture()
    if (fault === 'cutoff')
      i.knowledgeCutoffUtc = new Date(Date.parse(i.issueAtUtc) + 1).toISOString()
    if (fault === 'availability')
      i.history[0].availableAtUtc = new Date(Date.parse(i.issueAtUtc) + 1).toISOString()
    if (fault === 'originalIssue') {
      i.history[0].originalIssue!.issueAtUtc = new Date(Date.parse(i.issueAtUtc) + 1).toISOString()
      i.history[0].originalIssue!.targetAtUtc = new Date(
        Date.parse(i.issueAtUtc) + 86400001,
      ).toISOString()
    }
    if (fault === 'unit') (i.history[0] as any).fundingUnit = 'net_native_USDC'
    if (fault === 'owner') i.owner = FLUID_BRIDGE_USDC
    if (fault === 'sparse') delete i.history[0]
    if (fault === 'order') i.history.reverse()
    if (fault === 'uint') i.baseline.fullHolderNetUsdcRaw = (1n << 256n).toString()
    if (fault === 'target') i.horizonHours = 0
    if (fault === 'route') (i as any).routeKey = 'USDC → Fluid USD Coin [USDC]'
    expect(run(i)).toBeNull()
  })
  it('replays hypothetical same-S state acquired after its historical target with honest clocks', () => {
    const i = retrospectiveFixture(),
      before = structuredClone(i),
      m = run(i)!
    expect(Date.parse(i.baseline.acquiredAtUtc)).toBeGreaterThan(Date.parse(m.targetAtUtc))
    expect(m.input.baseline.acquiredAtUtc).toBe('2026-10-09T12:00:00.000Z')
    expect(m.input.knowledgeCutoffUtc).toBe(m.sourceAtUtc)
    expect(m.descriptiveExpectedFlow?.floorRaw).toBe('14588')
    expect(m).toMatchObject({
      retrospectiveReconstruction: true,
      ownershipKnown: false,
      historicalOwnership: false,
      originalProspectiveForecast: false,
      holderExecutableExit: false,
      minedPayout: false,
      forecastValidated: false,
      calibratedProbability: false,
      MRaw: null,
      sourceProofValidUntil: null,
    })
    expect(m.assumptions).toMatchObject({
      historicalChainStateReconstructedLater: true,
      feeAppliedOnceToGrossFundingOnly: true,
      requestedQSubtractedOnce: true,
    })
    expect(m.input.baseline.owner).toBeNull()
    expect(m.input.baseline).not.toHaveProperty('originalIssue')
    expect(i).toEqual(before)
  })
  it('excludes donors ending at or after the retrospective source even when acquired together', () => {
    const i = retrospectiveFixture()
    const future = structuredClone(i.baseline)
    future.source = {
      ...future.source,
      blockNumber: String(BigInt(future.source.blockNumber) + 256n),
      blockTime: new Date(Date.parse(future.source.blockTime) + 3072000).toISOString(),
    }
    i.history.push(structuredClone(i.baseline), future)
    const m = run(i)!
    expect(m.counts).toEqual({ attempted: 3, usable: 1, censored: 0, excluded: 2 })
    expect(m.excludedIntervals.map((x) => x.reason)).toEqual([
      'not_strictly_before_source',
      'not_strictly_before_source',
    ])
    expect(m.scenarios.map((x) => x.fromIndex)).toEqual([0])
    expect(m.descriptiveExpectedFlow).toBeNull()
  })
  it('retains genuine USDT transport metadata issued and acquired after the replay cutoff', () => {
    const i = retrospectiveFixture(),
      original = frame(0, '1014574')
    original.owner = '0x' + 'b'.repeat(40)
    original.acquiredAtUtc = i.issueAtUtc
    original.availableAtUtc = i.issueAtUtc
    original.originalIssue.issueAtUtc = i.issueAtUtc
    original.originalIssue.targetAtUtc = new Date(Date.parse(i.issueAtUtc) + 86400000).toISOString()
    original.originalIssue.finalUsdtRequestedRaw = '99999'
    i.history[0] = original
    const before = structuredClone(original),
      m = run(i)!
    expect(m.counts.usable).toBe(1)
    expect(m.input.history[0]).toEqual(before)
    expect(m.input.history[0].originalIssue).toEqual(before.originalIssue)
    expect(m).toMatchObject({
      ownershipKnown: false,
      historicalOwnership: false,
      retrospectiveReconstruction: true,
    })
  })
  it.each([
    'assumption',
    'cutoff',
    'acquisition',
    'rawReference',
    'inventedIssue',
    'inventedOwner',
    'zeroOwner',
    'claimedOwnership',
    'backdatedAvailability',
  ] as const)('rejects invalid retrospective %s', (fault) => {
    const i = retrospectiveFixture()
    if (fault === 'assumption') delete (i as any).retrospectiveAvailabilityAssumption
    if (fault === 'cutoff') i.knowledgeCutoffUtc = i.issueAtUtc
    if (fault === 'acquisition')
      i.baseline.acquiredAtUtc = new Date(Date.parse(i.issueAtUtc) + 1).toISOString()
    if (fault === 'rawReference') i.history[0].provenanceRef = ''
    if (fault === 'inventedIssue')
      (i.history[0] as any).originalIssue = frame(0, '1014574').originalIssue
    if (fault === 'inventedOwner') (i.history[0] as any).owner = owner
    if (fault === 'zeroOwner') (i.history[0] as any).owner = '0x' + '0'.repeat(40)
    if (fault === 'claimedOwnership') (i.history[0] as any).historicalOwnership = true
    if (fault === 'backdatedAvailability')
      i.history[0].availableAtUtc = i.history[0].source.blockTime
    expect(run(i)).toBeNull()
  })
  it.each(['current_conditional', 'dated_captured_projection'] as const)(
    'rejects hypothetical provenance in %s',
    (mode) => {
      const i = retrospectiveFixture()
      ;(i as any).mode = mode
      ;(i as any).owner = owner
      delete (i as any).retrospectiveAvailabilityAssumption
      i.issueAtUtc = i.baseline.source.blockTime
      for (const f of [...i.history, i.baseline]) {
        f.acquiredAtUtc = f.source.blockTime
        f.availableAtUtc = f.source.blockTime
      }
      expect(run(i)).toBeNull()
    },
  )
  it('requires real ownership, original metadata and actual acquisition on issue-bound frames', () => {
    for (const fault of [
      'owner',
      'zeroOwner',
      'originalIssue',
      'acquiredAtUtc',
      'provenanceKind',
    ]) {
      const i = fixture()
      if (fault === 'owner') (i.baseline as any).owner = null
      else if (fault === 'zeroOwner') i.baseline.owner = '0x' + '0'.repeat(40)
      else delete (i.baseline as any)[fault]
      expect(run(i)).toBeNull()
    }
    expect(run()).toMatchObject({
      retrospectiveReconstruction: false,
      ownershipProvenance: 'declared_original_issue_bound',
      ownershipKnown: false,
      historicalOwnership: false,
    })
  })
  it('requires independent callback approval and does not mutate supplied frames', () => {
    const i = fixture(),
      before = structuredClone(i)
    expect(build(i, () => false)).toBeNull()
    expect(run(i)).not.toBeNull()
    expect(i).toEqual(before)
  })
})
