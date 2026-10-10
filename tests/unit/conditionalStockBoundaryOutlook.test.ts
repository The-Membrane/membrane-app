import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  buildConditionalStockBoundaryOutlook as build,
  conditionalStockBoundaryHours as hours,
  type ConditionalStockBoundaryInput,
} from '@/lib/venueForecast/conditionalStockBoundaryOutlook'

const DAY = 86400000,
  SOURCE = Date.parse('2026-10-09T12:00:00.000Z')
const iso = (n: number) => new Date(n).toISOString()
function fixture(): ConditionalStockBoundaryInput {
  return {
    sourceAtUtc: iso(SOURCE),
    issueAtUtc: iso(SOURCE),
    targetAtUtc: iso(SOURCE + 7 * DAY),
    currentValuesByChannel: { cash: '10', duplicateCash: '10' },
    cashChannelKeys: ['cash', 'duplicateCash'],
    scenarios: [
      {
        fromIndex: 0,
        status: 'censored_path',
        reason: 'negative_joint_prong',
        censoredAtUtc: iso(SOURCE + 3 * DAY),
        donor: {
          startAtUtc: iso(SOURCE - 2 * DAY),
          endAtUtc: iso(SOURCE - DAY),
          durationSeconds: 86400,
          jointDeltaRaw: { cash: '-5', duplicateCash: '-5' },
          ratesByChannel: {
            cash: { numeratorRaw: '-5', denominatorMs: String(DAY) },
            duplicateCash: { numeratorRaw: '-5', denominatorMs: String(DAY) },
          },
        },
        points: [
          { atUtc: iso(SOURCE), valuesByChannel: { cash: '10', duplicateCash: '10' } },
          { atUtc: iso(SOURCE + DAY), valuesByChannel: { cash: '5', duplicateCash: '5' } },
        ],
      },
    ],
  }
}
describe('unsigned conditional cash boundary diagnostic', () => {
  it('counts duplicate cash/resolver channels as one donor, not a probability', () => {
    const result = build(fixture())!
    expect(result.boundaryDonors).toBe(1)
    expect(result.attemptedDonors).toBe(1)
    expect(result.boundaries[0].affectedCashChannels).toEqual(['cash', 'duplicateCash'])
    expect(hours(result)).toBe('24\u201372h \u00b7 1/1 paths')
    expect(result.zeroClampApplied).toBe(false)
    expect(result.observedDepletionTimeKnown).toBe(false)
    expect(result.authenticated).toBe(false)
    expect(Object.isFrozen(result.boundaries)).toBe(true)
  })
  it('replays recorded H168 donor3 48\u201372 and donor5 96\u2013120 without modifying the censored band', () => {
    // Recorded-time inspection, not a new live issue or native original registration.
    const model = JSON.parse(
      readFileSync(
        new URL(
          '../../data/research/venue-signals/fluid-usdt-default-api-card-live-2026-10-09-0f8fab53-8f5a-4db9-a1a0-25717a31a85e/model-H168.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ).model
    const before = JSON.stringify(model)
    const result = build({
      sourceAtUtc: model.sourceAtUtc,
      issueAtUtc: model.issueAtUtc,
      targetAtUtc: model.targetAtUtc,
      currentValuesByChannel: model.process.input.current.nativeProngs,
      cashChannelKeys: ['bridgeFunding', 'bankCash', 'bankResolverWithdrawable'],
      scenarios: model.process.scenarios,
    })!
    expect(result.attemptedDonors).toBe(7)
    expect(
      result.boundaries.map((b) => [b.fromIndex, b.afterIssueMs / 3600000, b.byIssueMs / 3600000]),
    ).toEqual([
      [3, 48, 72],
      [5, 96, 120],
    ])
    expect(hours(result)).toBe('48\u2013120h \u00b7 2/7 paths')
    expect(model.process.targetSummary).toBeNull()
    expect(JSON.stringify(model)).toBe(before)
  })
  it('applies fractional source age once with mathematical floor for negative NET', () => {
    const i = fixture(),
      s = i.scenarios[0]
    i.issueAtUtc = iso(SOURCE + 500)
    i.targetAtUtc = iso(SOURCE + 20000)
    s.donor.startAtUtc = iso(SOURCE - 2000)
    s.donor.endAtUtc = iso(SOURCE - 1000)
    s.donor.durationSeconds = 1
    for (const k of i.cashChannelKeys) {
      s.donor.jointDeltaRaw[k] = '-1'
      s.donor.ratesByChannel[k] = { numeratorRaw: '-1', denominatorMs: '1000' }
    }
    s.censoredAtUtc = iso(SOURCE + 10001)
    s.points = [
      { atUtc: iso(SOURCE + 500), valuesByChannel: { cash: '9', duplicateCash: '9' } },
      { atUtc: iso(SOURCE + 9000), valuesByChannel: { cash: '1', duplicateCash: '1' } },
    ]
    const result = build(i)!
    expect(result.boundaries[0].afterIssueMs).toBe(8500)
    expect(result.boundaries[0].byIssueMs).toBe(9501)
    expect(hours(result)).toBe('0\u20131h \u00b7 1/1 paths')
  })
  it.each(['nonpositive_conversion_cost', 'native_intermediate_overflow', 'grid_limit'])(
    'ignores %s as a cash-boundary diagnosis while counting the valid attempted donor',
    (reason) => {
      const i = fixture()
      i.scenarios[0].reason = reason
      const result = build(i)!
      expect(result.attemptedDonors).toBe(1)
      expect(result.boundaryDonors).toBe(0)
      expect(hours(result)).toBeNull()
    },
  )
  it('does not diagnose negative noncash channels from negative_joint_prong alone', () => {
    const i = fixture()
    for (const k of i.cashChannelKeys) {
      i.scenarios[0].donor.jointDeltaRaw[k] = '0'
      i.scenarios[0].donor.ratesByChannel[k].numeratorRaw = '0'
      i.scenarios[0].points.forEach((p) => {
        p.valuesByChannel[k] = '10'
      })
    }
    expect(build(i)!.boundaryDonors).toBe(0)
  })
  it('requires an earlier positive sample at or after issue', () => {
    const i = fixture()
    i.issueAtUtc = iso(SOURCE + 1)
    i.scenarios[0].points = [i.scenarios[0].points[0]]
    expect(build(i)!.boundaryDonors).toBe(0)
  })
  it('counts usable and unrelated censored paths in the denominator', () => {
    const i = fixture(),
      usable = structuredClone(i.scenarios[0]),
      unrelated = structuredClone(usable)
    usable.fromIndex = 1
    usable.status = 'conditional_path'
    usable.reason = null
    usable.censoredAtUtc = null
    unrelated.fromIndex = 2
    unrelated.reason = 'measurement_unavailable'
    i.scenarios = [...i.scenarios, usable, unrelated]
    expect(build(i)!.attemptedDonors).toBe(3)
    expect(build(i)!.boundaryDonors).toBe(1)
  })
  it.each([
    'denominator',
    'delta',
    'stock',
    'target',
    'source',
    'ordering',
    'duplicate_donor',
    'overflow',
  ] as const)('rejects %s drift instead of manufacturing a boundary', (kind) => {
    const i = fixture(),
      s = i.scenarios[0]
    if (kind === 'denominator') s.donor.ratesByChannel.cash.denominatorMs = '1'
    if (kind === 'delta') s.donor.ratesByChannel.cash.numeratorRaw = '-4'
    if (kind === 'stock') s.points[1].valuesByChannel.cash = '6'
    if (kind === 'target') i.targetAtUtc = iso(SOURCE + 2 * DAY)
    if (kind === 'source') i.sourceAtUtc = iso(SOURCE + 1)
    if (kind === 'ordering') s.points = [...s.points].reverse()
    if (kind === 'duplicate_donor') i.scenarios = [...i.scenarios, structuredClone(s)]
    if (kind === 'overflow') {
      s.donor.jointDeltaRaw.cash = '-' + ((1n << 256n) - 1n)
      s.donor.ratesByChannel.cash.numeratorRaw = s.donor.jointDeltaRaw.cash
    }
    expect(build(i)).toBeNull()
  })
  it('rejects malformed/plain-data violations without invoking getters', () => {
    const i = fixture()
    let invoked = 0
    Object.defineProperty(i, 'currentValuesByChannel', {
      enumerable: true,
      get() {
        invoked++
        throw Error('no')
      },
    })
    expect(() => build(i)).not.toThrow()
    expect(build(i)).toBeNull()
    expect(invoked).toBe(0)
    expect(
      build(
        new Proxy(fixture(), {
          ownKeys() {
            throw Error('no')
          },
        }),
      ),
    ).toBeNull()
  })
  it('rejects duplicate/empty/unbounded keys and out-of-range stock', () => {
    for (const keys of [[], ['cash', 'cash'], ['x'.repeat(200)]]) {
      const i = fixture()
      i.cashChannelKeys = keys
      expect(build(i)).toBeNull()
    }
    const i = fixture()
    i.currentValuesByChannel.cash = String(1n << 256n)
    expect(build(i)).toBeNull()
  })
  it('rounds hour bounds outward rather than advertising a precise crossing', () => {
    const result = structuredClone(build(fixture())!)
    result.boundaries[0].afterIssueMs += 1
    result.boundaries[0].byIssueMs += 1
    expect(hours(result)).toBe('24\u201373h \u00b7 1/1 paths')
  })
})
