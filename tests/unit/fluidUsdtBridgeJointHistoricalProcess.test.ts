import { isDeepStrictEqual } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  buildFluidUsdtBridgeJointHistoricalProcess as build,
  selectedFluidUsdtBridgeJointHistoricalProcess as select,
  FLUID_JOINT_PRONGS,
  FLUID_JOINT_USDC,
  FLUID_JOINT_USDT,
  type FluidJointAnchor,
  type FluidJointHistoricalInput,
} from '@/lib/carry/fluidUsdtBridgeJointHistoricalProcess'

const owner = '0x3f825bb69af74a4921dd051c80fe8bf8fb7d3a2e'
function anchor(n: number, cash: string): FluidJointAnchor {
  return {
    source: {
      chainId: 1,
      blockNumber: String(26101887 + n),
      blockHash: '0x' + String(n + 1).repeat(64),
      blockTime: new Date(Date.UTC(2026, 9, 7, 12, 0, n * 10)).toISOString(),
    },
    originalIssue: {
      issueId: 'original_issue_' + n,
      issueAtUtc: '2026-10-07T12:00:20.000Z',
      targetAtUtc: '2026-10-08T12:00:20.000Z',
      horizonHours: 24,
    },
    availableAtUtc: '2026-10-07T12:00:20.000Z',
    provenanceRef: `external_test_receipt_${n}`,
    runtimeCodeHashes: { [FLUID_JOINT_USDC]: '0x' + 'a'.repeat(64) },
    owner,
    holderSharesRaw: '967573479322309282',
    regime: 'unpaused_same_runtime',
    paused: false,
    withdrawalFeeBps: 5,
    fullHolderNetUsdcRaw: '1014574',
    nativeProngs: {
      bridgeFunding: '50000',
      bankCash: cash,
      bankSupply: '80000',
      bankWithdrawableUntilLimit: '60000',
      bankResolverWithdrawable: '70000',
    },
    conversion: {
      inputAsset: FLUID_JOINT_USDC,
      outputAsset: FLUID_JOINT_USDT,
      inputDecimals: 6,
      outputDecimals: 6,
      fixedFinalUsdtOutputRaw: '10145',
      requiredNetUsdcRaw: '10144',
      method: 'quoteExactOutputSingle',
    },
  }
}
function fixture() {
  const i: FluidJointHistoricalInput = {
    mode: 'dated_captured_projection',
    routeKey: 'USDT → FluidBridgeAggregatorProxy [USDC]',
    destination: '0x273da948aca9261043fbdb2a857bc255ecc29012',
    owner,
    issueAtUtc: '2026-10-07T12:00:20.000Z',
    horizonHours: 10 / 3600,
    requestedFinalUsdtRaw: '10145',
    originalQuestion: {
      firstLegUsdcRequestedRaw: '10145',
      finalUsdtRequestedRaw: null,
      questionBinding: 'unassessed',
      targetSelection: 'research_selected_numeric_reuse_not_conversion',
    },
    history: [anchor(0, '11000'), anchor(1, '10000')],
    baseline: anchor(1, '10000'),
    maxHistoricalGapSeconds: 3072,
  }
  return i
}
const approve = (i: FluidJointHistoricalInput) => {
  const approved = structuredClone(i)
  return (_kind: string, candidate: FluidJointHistoricalInput) =>
    isDeepStrictEqual(candidate, approved)
}
describe('joint fixed final USDT native conditional process', () => {
  it('retains measured joint net changes, original question units, and actual availability without manufacturing a future path', () => {
    const i = fixture(),
      r = build(i, approve(i))!
    expect(r.intervals[0].donor.durationSeconds).toBe(10)
    expect(r.intervals[0].donor.jointNetDeltaRaw.bankCash).toBe('-1000')
    expect(r.historicalAnchors[1]).toMatchObject({
      availableNetUsdcRaw: '9995',
      headroomNetUsdcRaw: '-149',
      bindingProngs: ['bankCash'],
      availableAtUtc: i.issueAtUtc,
    })
    expect(r.originalQuestion.finalUsdtRequestedRaw).toBeNull()
    expect(r.fixedFinalUsdtOutputRaw).toBe('10145')
    expect(r.prospectiveProcess).toBeNull()
    expect(r.originalProspectiveForecast).toBe(false)
    expect(r.descriptiveHistoricalOnly).toBe(true)
    expect(r.thinHistoricalEvidence).toBe(true)
    expect(r.calibratedProbability).toBe(false)
  })
  it.each(FLUID_JOINT_PRONGS)('independently clips %s, including limits the wrapper omits', (k) => {
    const i = fixture()
    i.history[1].nativeProngs[k] = '100'
    const r = build(i, approve(i))!
    expect(r.historicalAnchors[1].bindingProngs).toContain(k)
    expect(BigInt(r.historicalAnchors[1].headroomNetUsdcRaw)).toBeLessThan(0n)
  })
  it('clips net holder E independently without charging it twice', () => {
    const i = fixture()
    i.history[1].fullHolderNetUsdcRaw = '10144'
    i.history[1].nativeProngs.bankCash = '20000'
    expect(build(i, approve(i))!.historicalAnchors[1]).toMatchObject({
      holderClippedNetUsdcRaw: '10144',
      headroomNetUsdcRaw: '0',
      holderBinding: true,
    })
  })
  it('each anchor retains its own holder entitlement and required exact-output input', () => {
    const i = fixture()
    i.history[0].fullHolderNetUsdcRaw = '50'
    i.history[0].conversion.requiredNetUsdcRaw = '60'
    expect(build(i, approve(i))!.historicalAnchors[0].headroomNetUsdcRaw).toBe('-10')
  })
  it('pinned LiteVault ceil fee boundary and zero capacity are accounted once', () => {
    const i = fixture()
    i.history[0].nativeProngs.bankCash = '1999'
    i.history[1].nativeProngs.bankCash = '2000'
    const r = build(i, approve(i))!
    expect(r.historicalAnchors[0].availableNetUsdcRaw).toBe('1998')
    expect(r.historicalAnchors[1].availableNetUsdcRaw).toBe('1999')
    i.history[0].nativeProngs.bankCash = '0'
    expect(build(i, approve(i))!.historicalAnchors[0].availableNetUsdcRaw).toBe('0')
  })
  it('reports sampled historical recovery brackets without claiming continuous timing', () => {
    const i = fixture()
    i.history[0].nativeProngs.bankCash = '9000'
    i.history[1].nativeProngs.bankCash = '11000'
    expect(build(i, approve(i))!.sampledHistoricalShortfalls[0]).toMatchObject({
      leftCensored: true,
      rightCensored: false,
      recovery: { after: i.history[0].source.blockTime, by: i.history[1].source.blockTime },
    })
  })
  it('uses shared kernel for separately approved fresh current evidence and includes source age', () => {
    const i = fixture()
    i.mode = 'current_conditional'
    i.baseline = anchor(2, '10000')
    i.issueAtUtc = '2026-10-07T12:00:25.000Z'
    expect(build(i, (kind) => kind === 'history')).toBeNull()
    const r = build(i, approve(i))!
    expect(r.prospectiveProcess!.scenarios[0].points.at(-1)).toMatchObject({
      valuesByChannel: { bankCash: '8500' },
      headroomRaw: '-1649',
    })
    expect(r.sourceProofValidUntil).toBe('2026-10-07T12:30:20.000Z')
    i.issueAtUtc = '2026-10-07T12:30:21.000Z'
    expect(build(i, approve(i))).toBeNull()
  })
  it('cannot turn donor ending at baseline into current authority', () => {
    const i = fixture()
    i.mode = 'current_conditional'
    expect(build(i, approve(i))).toBeNull()
  })
  it('counts only kernel-eligible current donors while descriptive history retains its endpoint', () => {
    const i = fixture()
    i.history.push(anchor(2, '9000'))
    i.baseline = structuredClone(i.history[2])
    i.mode = 'current_conditional'
    const current = build(i, approve(i))!
    expect(current.intervals).toHaveLength(1)
    expect(current.prospectiveProcess!.scenarios).toHaveLength(1)
    expect(current.thinHistoricalEvidence).toBe(true)
    expect(current.excludedIntervals).toEqual([{ fromIndex: 1, reason: 'not_before_baseline' }])
    i.mode = 'dated_captured_projection'
    const historical = build(i, approve(i))!
    expect(historical.intervals).toHaveLength(2)
    expect(historical.thinHistoricalEvidence).toBe(false)
  })
  it('rejects constant gross fee overflow independently of competing-flow delta overflow', () => {
    const max = (1n << 256n) - 1n,
      invalidGross = max / 9995n + 1n
    // Pinned maxWithdraw unchecked multiplication wraps to less than 10,000,
    // producing zero native net assets rather than the mathematical positive value.
    expect(((invalidGross * 9995n) & max) / 10000n).toBe(0n)
    for (const mode of ['dated_captured_projection', 'current_conditional'] as const) {
      const i = fixture()
      i.mode = mode
      if (mode === 'current_conditional') i.baseline = anchor(2, '10000')
      for (const a of [...i.history, i.baseline]) {
        FLUID_JOINT_PRONGS.forEach((k) => (a.nativeProngs[k] = String(invalidGross)))
        a.fullHolderNetUsdcRaw = String(invalidGross)
      }
      expect(build(i, approve(i))).toBeNull()
    }
  })
  it('accepts fee multiplication boundary but censors a future measurement crossing it', () => {
    const max = (1n << 256n) - 1n,
      boundary = max / 9995n
    const i = fixture()
    i.mode = 'current_conditional'
    i.baseline = anchor(2, '10000')
    i.history.forEach((a, n) => {
      FLUID_JOINT_PRONGS.forEach((k) => (a.nativeProngs[k] = String(boundary - 1n + BigInt(n))))
      a.fullHolderNetUsdcRaw = String(boundary)
    })
    FLUID_JOINT_PRONGS.forEach((k) => (i.baseline.nativeProngs[k] = String(boundary)))
    i.baseline.fullHolderNetUsdcRaw = String(boundary)
    const scenario = build(i, approve(i))!.prospectiveProcess!.scenarios[0]
    expect(scenario.points).toHaveLength(1)
    expect(scenario.points[0].atUtc).toBe(i.issueAtUtc)
    expect(scenario.status).toBe('censored_path')
    expect(scenario.reason).toBe('native_intermediate_overflow')
    expect(scenario.targetHeadroomRaw).toBeNull()
    expect(scenario.censoredAtUtc).toBe('2026-10-07T12:00:30.000Z')
    const j = fixture()
    FLUID_JOINT_PRONGS.forEach((k) => (j.history[0].nativeProngs[k] = String(boundary + 1n)))
    expect(build(j, approve(j))).toBeNull()
  })
  it('current selection independently rebuilds and expires at target, source TTL, and before issue', () => {
    const i = fixture()
    i.mode = 'current_conditional'
    i.baseline = anchor(2, '10000')
    i.horizonHours = 1
    const accept = approve(i),
      r = build(i, accept)!,
      issue = Date.parse(i.issueAtUtc)
    expect(select(r, { input: i, asOfMs: issue }, accept)).not.toBeNull()
    expect(select(r, { input: i, asOfMs: issue - 1 }, accept)).toBeNull()
    expect(select(r, { input: i, asOfMs: issue + 1800001 }, accept)).toBeNull()
    const changed = structuredClone(r)
    changed.requiredNetUsdcRaw = '1'
    expect(select(changed, { input: i, asOfMs: issue }, accept)).toBeNull()
    i.horizonHours = 10 / 3600
    const a = approve(i),
      short = build(i, a)!
    expect(select(short, { input: i, asOfMs: issue + 10000 }, a)).toBeNull()
    i.mode = 'dated_captured_projection'
    expect(select(build(i, approve(i)), { input: i, asOfMs: issue }, approve(i))).toBeNull()
  })
  it('rejects external disagreement, changed Q, missing limits, future availability and regime mismatch', () => {
    const i = fixture(),
      accept = approve(i)
    i.baseline.nativeProngs.bankCash = '20000'
    expect(build(i, accept)).toBeNull()
    const variants = [fixture(), fixture(), fixture(), fixture()]
    variants[0].requestedFinalUsdtRaw = '10146'
    delete (variants[1].baseline.nativeProngs as Partial<FluidJointAnchor['nativeProngs']>)
      .bankWithdrawableUntilLimit
    variants[2].history[0].availableAtUtc = '2026-10-07T12:00:21.000Z'
    variants[3].history[0].regime = 'other'
    variants.forEach((v) => expect(build(v, approve(v))).toBeNull())
  })
  it('rejects zero Q, malformed uint256 and excessive historical gaps', () => {
    const i = fixture()
    i.requestedFinalUsdtRaw = '0'
    expect(build(i, approve(i))).toBeNull()
    const j = fixture()
    j.baseline.fullHolderNetUsdcRaw = String(1n << 256n)
    expect(build(j, approve(j))).toBeNull()
    const k = fixture()
    k.maxHistoricalGapSeconds = 9
    expect(build(k, approve(k))).toBeNull()
  })
  it('shared kernel censors native overflow and depletion rather than advertising coverage', () => {
    const i = fixture(),
      max = (1n << 256n) - 1n
    i.mode = 'current_conditional'
    i.baseline = anchor(2, '10000')
    i.history[0].nativeProngs.bankCash = '0'
    i.history[1].nativeProngs.bankCash = String(max)
    i.baseline.nativeProngs.bankCash = String(max)
    const s = build(i, approve(i))!.prospectiveProcess!.scenarios[0]
    expect(s.status).toBe('censored_path')
    expect(s.targetHeadroomRaw).toBeNull()
    expect(s.reason).toBe('native_intermediate_overflow')
    const j = fixture()
    j.mode = 'current_conditional'
    j.baseline = anchor(2, '10000')
    j.horizonHours = 1
    const p = build(j, approve(j))!.prospectiveProcess!.scenarios[0]
    expect(p.points.length).toBeLessThanOrEqual(128)
    expect(p.points.at(-1)!.valuesByChannel.bankCash).toBe('0')
    expect(p.sampledShortfalls[0].rightCensored).toBe(true)
  })
})
