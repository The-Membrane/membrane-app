import { describe, expect, it } from 'vitest'
import {
  buildConditionalTimeProcess,
  selectedConditionalTimeProcess,
  type ConditionalTimeProcessInput,
  type ConditionalTimeMeasurement,
} from '@/lib/venueForecast/conditionalTimeProcess'
const asset = '0x' + 'a'.repeat(40),
  now = Date.parse('2026-10-07T15:00:00.000Z')
const utc = (ms: number) => new Date(ms).toISOString(),
  MAX = (1n << 256n) - 1n
function fixture(delta = 60n): ConditionalTimeProcessInput {
  const channels = [
    {
      key: 'cash',
      assetAddress: asset,
      decimals: 6,
      unit: 'native_asset6',
      negativeHandling: 'clamp_zero' as const,
    },
  ]
  return {
    channels,
    outputAsset: { assetAddress: asset, decimals: 6 },
    measurementRule: 'cash_clipped_by_qualified_full_entitlement_held_constant',
    observations: [
      {
        sourceAtUtc: utc(now - 7200000),
        availableAtUtc: utc(now - 7199000),
        regime: 'v1',
        channels: structuredClone(channels),
        valuesByChannel: { cash: '100' },
        provenanceRef: 'old-a',
      },
      {
        sourceAtUtc: utc(now - 3600000),
        availableAtUtc: utc(now - 3599000),
        regime: 'v1',
        channels: structuredClone(channels),
        valuesByChannel: { cash: String(100n + delta) },
        provenanceRef: 'old-b',
      },
    ],
    current: {
      sourceAtUtc: utc(now - 600000),
      readAtUtc: utc(now - 1000),
      regime: 'v1',
      valuesByChannel: { cash: '200' },
      fullEntitlementRaw: '1000',
      provenanceRef: 'current-qualified',
    },
    issueAtUtc: utc(now),
    requestedRaw: '20',
    horizonHours: 2,
    maxHistoricalGapSeconds: 7200,
  }
}
const yes = () => true
function build(f = fixture(), measure?: ConditionalTimeMeasurement) {
  return buildConditionalTimeProcess(f, yes, measure)!
}
describe('conditional future constant net-flow-rate process', () => {
  it('issues genuinely new exact-H targets and includes source age in rational translation', () => {
    const f = fixture(),
      p = build(f),
      s = p.scenarios[0]
    expect(p.targetAtUtc).toBe(utc(now + 7200000))
    expect(s.points.map((x) => x.atUtc)).toEqual([
      utc(now - 600000),
      utc(now),
      utc(now + 3600000),
      utc(now + 7200000),
    ])
    expect(s.points.map((x) => x.headroomRaw)).toEqual(['180', '190', '250', '310'])
    expect(s.donor.startAtUtc).toBe(f.observations[0].sourceAtUtc)
    expect(s.donor.ratesByChannel.cash).toEqual({ numeratorRaw: '60', denominatorMs: '3600000' })
    expect(p.confidenceInterval).toBe(false)
    expect(p.calibratedProbability).toBe(false)
  })
  it('keeps fractional-hour selected H and declares intraday interpolation', () => {
    const f = fixture()
    f.horizonHours = 0.25
    const p = build(f)
    expect(p.targetAtUtc).toBe(utc(now + 900000))
    expect(p.horizonFinerThanHistory).toBe(true)
    expect(p.scenarios[0].points.at(-1)!.headroomRaw).toBe('205')
    expect(p.assumptions.interpolatedAndExtrapolatedFromActualDonorDuration).toBe(true)
  })
  it('clips full entitlement before subtracting Q exactly once', () => {
    const f = fixture()
    f.current.fullEntitlementRaw = '220'
    expect(build(f).scenarios[0].points.at(-1)!.headroomRaw).toBe('200')
    f.current.fullEntitlementRaw = undefined
    expect(buildConditionalTimeProcess(f, yes)).toBeNull()
  })
  it('floors signed rate arithmetic rather than truncating negative depletion toward zero', () => {
    const f = fixture(-1n)
    f.current.sourceAtUtc = f.issueAtUtc
    f.current.readAtUtc = f.issueAtUtc
    f.horizonHours = 0.5
    expect(build(f).scenarios[0].points.at(-1)!.valuesByChannel.cash).toBe('199')
  })
  it('clamps declared physical cash at zero and retains sampled right censoring', () => {
    const f = fixture(-90n)
    f.horizonHours = 4
    const s = build(f).scenarios[0]
    expect(s.points.at(-1)!.valuesByChannel.cash).toBe('0')
    expect(s.points.at(-1)!.headroomRaw).toBe('-20')
    expect(s.points.at(-1)!.clampedChannels).toEqual(['cash'])
    expect(s.sampledShortfalls.at(-1)!.rightCensored).toBe(true)
  })
  it('measures pause as availability zero without deleting physical cash', () => {
    const p = build(fixture(), () => ({ availableRaw: '0', entitlementRaw: '1000' })),
      s = p.scenarios[0]
    expect(s.points[0].valuesByChannel.cash).toBe('200')
    expect(s.points.every((x) => x.headroomRaw === '-20')).toBe(true)
    expect(s.sampledShortfalls).toEqual([
      {
        onset: { after: null, by: utc(now - 600000) },
        recovery: null,
        leftCensored: true,
        rightCensored: true,
      },
    ])
  })
  it('preserves correlated joint native deltas and exact millisecond measurement elapsed', () => {
    const f = fixture()
    f.channels = [
      { key: 'S', assetAddress: asset, decimals: 18, unit: 'wad18' },
      { key: 'Due', assetAddress: asset, decimals: 45, unit: 'rad45' },
    ]
    f.measurementRule = 'declared_joint_protocol_rule'
    f.observations.forEach((o, i) => {
      o.channels = structuredClone(f.channels)
      o.valuesByChannel = { S: String(100 + 10 * i), Due: String(50 + 20 * i) }
    })
    f.current.valuesByChannel = { S: '200', Due: '100' }
    const elapsed: number[] = []
    const p = build(f, (state, ms) => {
      elapsed.push(ms)
      return { availableRaw: String(BigInt(state.S) - BigInt(state.Due)), entitlementRaw: null }
    })
    expect(p.scenarios[0].donor.jointDeltaRaw).toEqual({ S: '10', Due: '20' })
    expect(elapsed).toEqual([0, 600000, 4200000, 7800000])
    expect(p.scenarios[0].targetHeadroomRaw).toBe('58')
  })
  it('censors negative joint prongs instead of treating them as physical zero', () => {
    const f = fixture(-90n)
    f.channels[0].negativeHandling = 'reject_scenario'
    f.observations.forEach((o) => (o.channels = structuredClone(f.channels)))
    f.horizonHours = 4
    const p = build(f, (s) => ({ availableRaw: s.cash, entitlementRaw: null }))
    expect(p.scenarios[0].status).toBe('censored_path')
    expect(p.scenarios[0].reason).toBe('negative_joint_prong')
    expect(p.targetSummary).toBeNull()
  })
  it('rejects overflowing native intermediate arithmetic before clamping', () => {
    const f = fixture()
    f.observations[0].valuesByChannel.cash = '0'
    f.observations[1].valuesByChannel.cash = String(MAX)
    const p = build(f)
    expect(p.scenarios[0].status).toBe('censored_path')
    expect(p.scenarios[0].reason).toBe('native_intermediate_overflow')
    expect(p.targetSummary).toBeNull()
  })
  it.each(['lookahead', 'delayed', 'regime', 'asset', 'gap'])(
    'excludes %s donor evidence without retrospective issue claims',
    (mode) => {
      const f = fixture()
      if (mode === 'lookahead') f.observations[1].sourceAtUtc = f.current.sourceAtUtc
      if (mode === 'delayed') f.observations[1].availableAtUtc = utc(now + 1)
      if (mode === 'regime') f.observations[1].regime = 'v2'
      if (mode === 'asset') f.observations[1].channels[0].assetAddress = '0x' + 'b'.repeat(40)
      if (mode === 'gap') f.maxHistoricalGapSeconds = 3599
      expect(buildConditionalTimeProcess(f, yes)).toBeNull()
    },
  )
  it('retains a failed candidate and nulls aggregate range instead of survivor-only reporting', () => {
    const f = fixture()
    f.observations.push({
      ...structuredClone(f.observations[1]),
      sourceAtUtc: utc(now - 1800000),
      availableAtUtc: utc(now - 1799000),
      valuesByChannel: { cash: '1' },
      provenanceRef: 'old-c',
    })
    const p = build(f, (s) => {
      if (BigInt(s.cash) < 100n) throw Error('external_rule_gap')
      return { availableRaw: s.cash, entitlementRaw: null }
    })
    expect(p.scenarios).toHaveLength(2)
    expect(p.scenarios[0].status).toBe('conditional_path')
    expect(p.scenarios[1].status).toBe('censored_path')
    expect(p.targetSummary).toBeNull()
  })
  it('snapshots input before qualifier and measurement mutation, retaining original Q/source/joint state', () => {
    const f = fixture(),
      ordinary = build(f)
    const p = buildConditionalTimeProcess(
      f,
      (x) => {
        f.requestedRaw = '1'
        f.current.valuesByChannel.cash = '999'
        x.requestedRaw = '2'
        return true
      },
      (s) => {
        const available = s.cash
        s.cash = '0'
        return { availableRaw: available, entitlementRaw: '1000' }
      },
    )!
    expect(p.requestedRaw).toBe('20')
    expect(p.scenarios).toEqual(ordinary.scenarios)
  })
  it('selector snapshots both payload and external expected before callbacks and rejects tampering', () => {
    const f = fixture(),
      p = build(f),
      expected = structuredClone(f)
    expect(
      selectedConditionalTimeProcess(p, { input: expected, asOfMs: now }, () => {
        p.requestedRaw = '1'
        expected.requestedRaw = '1'
        return true
      })!.requestedRaw,
    ).toBe('20')
    expect(selectedConditionalTimeProcess(p, { input: f, asOfMs: now }, yes)).toBeNull()
    const good = build(f)
    good.assumptions.totalElapsedIncludesSourceAge = false as any
    expect(selectedConditionalTimeProcess(good, { input: f, asOfMs: now }, yes)).toBeNull()
  })
  it('turns qualifier/measurement exceptions into bounded null/censor outcomes', () => {
    expect(
      buildConditionalTimeProcess(fixture(), () => {
        throw Error('authority')
      }),
    ).toBeNull()
    const p = build(fixture(), () => {
      throw Error('rule unavailable')
    })
    expect(p.scenarios[0].reason).toBe('measurement_unavailable')
    expect(p.targetSummary).toBeNull()
  })
  it('enforces source expiry and finite observation budgets', () => {
    const f = fixture()
    f.current.sourceAtUtc = utc(now - 1800001)
    expect(buildConditionalTimeProcess(f, yes)).toBeNull()
    const h = fixture()
    h.observations = Array(257).fill(h.observations[0])
    expect(buildConditionalTimeProcess(h, yes)).toBeNull()
  })
  it('bounds long-horizon grids without changing donor rates, the requested target or censor brackets', () => {
    const f = fixture(-1n)
    f.horizonHours = 8760
    const p = build(f),
      s = p.scenarios[0]
    expect(s.status).toBe('conditional_path')
    expect(s.points.length).toBeLessThanOrEqual(128)
    expect(s.points[0].atUtc).toBe(f.current.sourceAtUtc)
    expect(s.points[1].atUtc).toBe(f.issueAtUtc)
    expect(s.points.at(-1)!.atUtc).toBe(utc(now + 8760 * 3600000))
    expect(s.donor.durationSeconds).toBe(3600)
    expect(s.donor.ratesByChannel.cash).toEqual({ numeratorRaw: '-1', denominatorMs: '3600000' })
    expect(s.sampling!.coarsenedForBoundedGrid).toBe(true)
    expect(s.sampling!.historicalCadenceSeconds).toBe(3600)
    expect(s.sampling!.gridStepSeconds).toBe(s.sampling!.donorCadenceStride * 3600)
    expect(s.sampledShortfalls[0].rightCensored).toBe(true)
    expect(s.continuousPathKnown).toBe(false)
    expect(p.targetSummary).not.toBeNull()
    f.horizonHours = 8760 + 1
    expect(buildConditionalTimeProcess(f, yes)).toBeNull()
  })
  it('uses an external render clock without reissuing the original future process', () => {
    const f = fixture(),
      p = build(f)
    const later = now + 1000
    const selected = selectedConditionalTimeProcess(p, { input: f, asOfMs: later }, yes)
    expect(selected!.issueAtUtc).toBe(f.issueAtUtc)
    expect(selected!.targetAtUtc).toBe(utc(now + 7200000))
    expect(
      selectedConditionalTimeProcess(
        p,
        { input: f, asOfMs: Date.parse(f.current.sourceAtUtc) + 1800001 },
        yes,
      ),
    ).toBeNull()
    expect(selectedConditionalTimeProcess(p, { input: f, asOfMs: now - 1 }, yes)).toBeNull()
    f.horizonHours = 0.001
    const short = build(f)
    expect(selectedConditionalTimeProcess(short, { input: f, asOfMs: now + 3600 }, yes)).toBeNull()
  })
})
