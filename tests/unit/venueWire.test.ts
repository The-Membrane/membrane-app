import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

import { datasetsRoot } from '@/lib/curatorFeed/paths'
import { baselineAt, bandsOf, quantileSorted, sinceOf } from '@/lib/venueWire/baseline'
import {
  detect,
  detectLevel,
  detectState,
  METRIC_RULES,
  scanRun,
  WIRE_THRESHOLDS,
  type WireThresholds,
} from '@/lib/venueWire/detect'
import { WIRE_FILES } from '@/lib/venueWire/load'
import { AXIS_WEIGHT, levelImpact, rankStories, stateImpact } from '@/lib/venueWire/rank'
import {
  buildFrames,
  type DepegHistoryFile,
  type HourlyPriceFile,
  type VenueFrame,
  type VenueStressHistoryFile,
  type VenueStressSummaryFile,
  type WireFrames,
  type WireInputs,
} from '@/lib/venueWire/series'
import {
  buildWire,
  parseWireQuery,
  QueryError,
  storiesOf,
  type WireResponse,
} from '@/lib/venueWire/service'
import {
  anomalyHeadline,
  anomalyLabels,
  BANNED,
  sinceWords,
  stateHeadline,
  stateLabels,
} from '@/lib/venueWire/templates'
import type { Anomaly, Bands, Series, StateChange, Subject, WireStory } from '@/lib/venueWire/types'
import handler from '@/pages/api/venues/news'

const H = 3600
const D = 86_400
const T0 = Date.UTC(2025, 0, 1) / 1000 // 2025-01-01T00:00Z
const iso = (ts: number) => new Date(ts * 1000).toISOString()
const ts = (s: string) => Date.parse(s) / 1000

/** Deterministic hourly series: idle cash between 10% and 20%, then `tail` readings. */
function hourly(
  days: number,
  base: (i: number) => number,
  tail: number[] = [],
): { t: number[]; v: number[] } {
  const n = days * 24
  const t: number[] = []
  const v: number[] = []
  for (let i = 0; i < n; i++) {
    t.push(T0 + i * H)
    v.push(base(i))
  }
  for (const x of tail) {
    t.push(t[t.length - 1] + H)
    v.push(x)
  }
  return { t, v }
}

const wave = (i: number) => 15 + 5 * Math.sin(i / 37)
const venue: Subject = { kind: 'venue', id: 'aave-core-usdc', label: 'Aave USDC' }

function series(
  t: number[],
  v: (number | null)[],
  metric: Series['metric'] = 'idleCashPct',
  unit = 'pct',
): Series {
  return { subject: venue, metric, t, v, fromTs: t[0], unit, source: 'synthetic' }
}

const allText = (s: WireStory) =>
  [s.headline, s.labels.measured, s.labels.driver, s.labels.signal].join(' | ')

// ------------------------------------------------------------------ baselines

describe('venueWire baselines', () => {
  it('quantiles interpolate between closest ranks', () => {
    const a = [1, 2, 3, 4, 5]
    expect(quantileSorted(a, 0)).toBe(1)
    expect(quantileSorted(a, 0.5)).toBe(3)
    expect(quantileSorted(a, 0.25)).toBe(2)
    expect(quantileSorted(a, 0.1)).toBeCloseTo(1.4)
    const b = bandsOf([5, 1, 4, 2, 3], 10, 20)
    expect([b.min, b.p50, b.max, b.n, b.fromTs, b.toTs]).toEqual([1, 3, 5, 5, 10, 20])
  })

  it('"lowest since" is the last earlier reading at or below the value; none = on record', () => {
    const s = { t: [0, D, 2 * D, 3 * D, 4 * D], v: [5, 2, 8, 9, 3] }
    expect(sinceOf(s, 4, 3, 'low', 0, 4 * D, 0)).toEqual({ ts: D, days: 3 })
    expect(sinceOf(s, 4, 1, 'low', 0, 4 * D, 0)).toEqual({ ts: null, days: 4 })
    expect(sinceOf(s, 4, 8, 'high', 0, 4 * D, 0)).toEqual({ ts: 3 * D, days: 1 })
    // fromTs bounds the scan: before it the venue was below its material size.
    expect(sinceOf(s, 4, 3, 'low', 2 * D, 4 * D, 2 * D)).toEqual({ ts: null, days: 2 })
  })

  it('is causal: readings after the evaluation time change nothing', () => {
    const a = hourly(200, wave, [3, 3])
    const b = hourly(200, wave, [3, 3, 0, 0, 0, 40, 40])
    const at = a.t[a.t.length - 1]
    const ra = baselineAt(series(a.t, a.v), at, WIRE_THRESHOLDS)
    const rb = baselineAt(series(b.t, b.v), at, WIRE_THRESHOLDS)
    expect(ra).toEqual(rb)
  })

  it('reports stale, short and empty series instead of judging them', () => {
    const a = hourly(200, wave)
    const lastT = a.t[a.t.length - 1]
    const stale = baselineAt(series(a.t, a.v), lastT + 7 * H, WIRE_THRESHOLDS)
    expect(stale.ok ? null : stale.uncovered.reason).toBe('stale')
    const short = hourly(30, wave)
    const r = baselineAt(series(short.t, short.v), short.t[short.t.length - 1], WIRE_THRESHOLDS)
    expect(r.ok ? null : r.uncovered.reason).toBe('short-history')
    const none = baselineAt(series(a.t, a.v), T0 - D, WIRE_THRESHOLDS)
    expect(none.ok ? null : none.uncovered.reason).toBe('no-data')
  })
})

// ------------------------------------------------------------------ detector thresholds

function judge(tail: number[], days = 200, base = wave, th: WireThresholds = WIRE_THRESHOLDS) {
  const a = hourly(days, base, tail)
  const r = baselineAt(series(a.t, a.v), a.t[a.t.length - 1], th)
  if (!r.ok) throw new Error(r.uncovered.detail)
  return detectLevel(r.baseline, th)
}

describe('venueWire detector thresholds', () => {
  it('a sustained new low beyond every prior reading is a record', () => {
    const [a] = judge([3, 3])
    expect(a.severity).toBe('record')
    expect(a.since.ts).toBeNull()
    expect(a.tail).toBe('low')
  })

  it('a one-hour transient never makes a story (persistence guard)', () => {
    expect(judge([0])).toEqual([])
    expect(judge([15, 0])).toEqual([])
  })

  it('a low already seen inside minSinceDays is not news', () => {
    // A dip to 4% ten days before the end, then 4.5% now: lowest only since that dip.
    const dip = (i: number) => (i >= 190 * 24 && i < 190 * 24 + 6 ? 4 : wave(i))
    expect(judge([4.5, 4.5], 200, dip)).toEqual([])
    // The same dip 60 days back: now it is news, dated to the dip.
    const old = (i: number) => (i >= 140 * 24 && i < 140 * 24 + 6 ? 4 : wave(i))
    const [a] = judge([4.5, 4.5], 200, old)
    expect(a.since.ts).toBe(T0 + (140 * 24 + 5) * H)
    expect(Math.round(a.since.days)).toBe(60)
  })

  it('a tail that is not material is not news', () => {
    // Range 10.0–10.5%: 9.6% is beyond the band but under 2 points from the median.
    const flat = (i: number) => 10 + 0.25 * (1 + Math.sin(i / 37))
    expect(judge([9.6, 9.6], 200, flat)).toEqual([])
    expect(judge([7.5, 7.5], 200, flat)[0]?.severity).toBe('record')
  })

  it('grades tail and extreme by the own-history bands', () => {
    // The wave never goes under 10%; a 4-day trough at 2% holds 2% of the readings, so p1
    // sits in the trough and p5 just above 10%. 9% is in the tail, 2% at p1.
    const trough = (i: number) => (i >= 50 * 24 && i < 54 * 24 ? 2 : wave(i))
    const [tail] = judge([9, 9], 200, trough)
    expect(tail.severity).toBe('tail')
    expect(tail.since.ts).toBe(T0 + (54 * 24 - 1) * H)
    expect(judge([2, 2], 200, trough)[0]?.severity).toBe('extreme')
  })

  it('every metric rule names its tails and floors', () => {
    for (const [k, r] of Object.entries(METRIC_RULES)) {
      expect(r.tails.length, k).toBeGreaterThan(0)
      expect(r.minGap + r.minRelGap, k).toBeGreaterThan(0)
    }
    // idle = 100 − utilisation: each side reports one tail only, so no fact is said twice.
    expect(METRIC_RULES.idleCashPct.tails).toEqual(['low'])
    expect(METRIC_RULES.utilisationPct.tails).toEqual(['low'])
  })
})

describe('venueWire runs and status flags', () => {
  it('a sustained tail run is news; a short one is not', () => {
    const run = (hours: number) => {
      const a = hourly(200, wave, Array(hours).fill(4))
      const s = series(a.t, a.v)
      const r = baselineAt(s, a.t[a.t.length - 1], WIRE_THRESHOLDS)
      if (!r.ok) throw new Error('baseline')
      const bands = bandsOf(a.v.slice(0, 200 * 24), a.t[0], a.t[200 * 24 - 1])
      return scanRun(s, r.baseline, bands)
    }
    expect(run(48)).toEqual([])
    const [a] = run(100)
    expect(a.kind).toBe('run')
    expect(a.run?.hours).toBe(99)
    expect(a.since.ts).toBeNull()
  })

  it('"longest run since" finds an earlier run that long, even one open where the record starts', () => {
    const at = (head: number, gapDays: number) => {
      // `head` hours at 4% open the record, then the wave, then a 100-hour run at 4%.
      const a = hourly(gapDays, (i) => (i < head ? 4 : wave(i)), Array(100).fill(4))
      const s = series(a.t, a.v)
      const r = baselineAt(s, a.t[a.t.length - 1], WIRE_THRESHOLDS)
      if (!r.ok) throw new Error('baseline')
      const bands = bandsOf(a.v.slice(0, gapDays * 24), a.t[0], a.t[gapDays * 24 - 1])
      return { a, found: scanRun(s, r.baseline, bands) }
    }
    // The opening run (120 h) is longer: the new run is the longest since it ended.
    const long = at(120, 200)
    expect(long.found[0].since.ts).toBe(long.a.t[119])
    // A shorter opening run (50 h) does not count: on record.
    expect(at(50, 200).found[0].since.ts).toBeNull()
  })

  it('a reserve freeze inside the window is a state story, first time on record', () => {
    const t = Array.from({ length: 400 }, (_, i) => T0 + i * H)
    const flags = t.map((_, i) => (i >= 380 ? 3 : 1))
    const f = {
      subject: { kind: 'venue', id: 'aave-core-weth', label: 'Aave WETH' },
      t,
      block: t.map((_, i) => 1000 + i),
      flags,
      fromTs: t[0],
      source: 'synthetic',
    } as unknown as VenueFrame
    const [c] = detectState(f, t[399])
    expect(c).toMatchObject({ flag: 'frozen', on: true, at: t[380], block: 1380, previous: null })
    expect(stateHeadline(c)).toBe('Aave WETH reserve frozen, first time on record (from Jan 2025)')
    // Cleared again: the switch back is a story too, with the run's length.
    const cleared = { ...f, flags: t.map((_, i) => (i >= 340 && i < 360 ? 3 : 1)) } as VenueFrame
    const [off] = detectState(cleared, t[399])
    expect(off).toMatchObject({ on: false, runFrom: t[340] })
    expect(stateHeadline(off)).toBe('Aave WETH reserve unfrozen after 20 h')
    const long = { ...f, flags: t.map((_, i) => (i >= 300 && i < 360 ? 3 : 1)) } as VenueFrame
    expect(stateHeadline(detectState(long, t[399])[0])).toBe(
      'Aave WETH reserve unfrozen after 2 days',
    )
    // Outside the window: nothing.
    expect(detectState(f, t[380] + 8 * D)).toEqual([])
  })
})

// ------------------------------------------------------------------ templates

const bands = (p50: number, p5: number, p95: number, fromTs = ts('2023-10-01T00:00Z')): Bands => ({
  n: 1000,
  fromTs,
  toTs: fromTs,
  min: p5 - 5,
  p1: p5 - 1,
  p5,
  p10: p5,
  p25: p50,
  p50,
  p75: p50,
  p90: p95,
  p95,
  p99: p95 + 1,
  max: p95 + 5,
})

function anomaly(
  metric: Series['metric'],
  tail: 'low' | 'high',
  x: number,
  at: string,
  since: string | null,
  b: Bands,
  subject: Subject = venue,
  unit = 'pct',
): Anomaly {
  const atTs = ts(at)
  const sinceTs = since === null ? null : ts(since)
  const s = { ts: sinceTs, days: (atTs - (sinceTs ?? b.fromTs)) / D }
  return {
    kind: 'level',
    tail,
    severity: since === null ? 'record' : 'tail',
    since: s,
    baseline: {
      subject,
      metric,
      unit,
      source: 'synthetic',
      at: atTs,
      latest: x,
      guard: { low: x, high: x },
      bands: b,
      lowestSince: s,
      highestSince: s,
    },
  }
}

const emptyFrames: WireFrames = {
  venues: new Map(),
  assets: new Map(),
  windows: [],
  series: [],
  missing: [],
}

describe('venueWire templates', () => {
  it('writes the owner example word for word', () => {
    const a = anomaly(
      'idleCashPct',
      'low',
      3.1,
      '2026-10-07T01:00Z',
      '2026-05-12T00:00Z',
      bands(12.8, 7.1, 34),
    )
    expect(anomalyHeadline(a)).toBe('Aave USDC idle cash 3.1%, lowest since May')
  })

  it('dates "since" by distance: day inside 60 days, year when it differs, record from the start', () => {
    const at = ts('2026-10-07T01:00Z')
    expect(sinceWords({ ts: ts('2026-09-03T00:00Z'), days: 34 }, at, 0)).toBe('since 3 Sep')
    expect(sinceWords({ ts: ts('2025-11-20T00:00Z'), days: 321 }, at, 0)).toBe('since Nov 2025')
    expect(sinceWords({ ts: ts('2025-12-31T00:00Z'), days: 40 }, ts('2026-02-09T00:00Z'), 0)).toBe(
      'since 31 Dec 2025',
    )
    expect(sinceWords({ ts: null, days: 1000 }, at, ts('2023-10-01T00:00Z'))).toBe(
      'on record (from Oct 2023)',
    )
  })

  it('has a template for every metric tail it detects, with no banned words', () => {
    const asset: Subject = { kind: 'asset', id: 'eth', label: 'ETH' }
    const cases: [Anomaly, string][] = [
      [
        anomaly(
          'exitCapacity',
          'low',
          38e6,
          '2026-10-07T01:00Z',
          '2026-05-01T00:00Z',
          bands(250e6, 40e6, 1e9),
          venue,
          'usd',
        ),
        'Aave USDC exit capacity $38M, lowest since May',
      ],
      [
        anomaly(
          'exitCapacity',
          'low',
          68_200,
          '2026-10-07T01:00Z',
          '2026-05-01T00:00Z',
          bands(2e5, 9e4, 8e5),
          { ...venue, id: 'aave-core-weth', label: 'Aave WETH' },
          'WETH',
        ),
        'Aave WETH exit capacity 68.2K WETH, lowest since May',
      ],
      [
        anomaly(
          'utilisationPct',
          'low',
          71,
          '2026-10-07T01:00Z',
          '2026-01-20T00:00Z',
          bands(87, 76, 93),
        ),
        'Aave USDC utilisation 71.0%, lowest since Jan',
      ],
      [
        anomaly(
          'borrowAprPct',
          'high',
          14.2,
          '2026-10-07T01:00Z',
          '2023-11-16T00:00Z',
          bands(5.4, 3.5, 13),
        ),
        'Aave USDC borrow rate 14.2%, highest since Nov 2023',
      ],
      [
        anomaly(
          'borrowAprPct',
          'low',
          2.9,
          '2026-10-07T01:00Z',
          '2025-04-02T00:00Z',
          bands(5.4, 3.5, 13),
        ),
        'Aave USDC borrow rate 2.9%, lowest since Apr 2025',
      ],
      [
        anomaly(
          'navDiscountBps',
          'high',
          42,
          '2026-10-07T01:00Z',
          '2022-06-20T00:00Z',
          bands(7, 0, 30),
          { kind: 'asset', id: 'steth', label: 'stETH' },
          'bps',
        ),
        'stETH discount to NAV 0.42%, widest since Jun 2022',
      ],
      [
        anomaly(
          'depegBps',
          'high',
          31,
          '2026-10-07T01:00Z',
          '2023-03-12T00:00Z',
          bands(1, -10, 9),
          { kind: 'asset', id: 'usdc', label: 'USDC' },
          'bps',
        ),
        'USDC at $0.9969, widest discount to $1 since Mar 2023',
      ],
      [
        anomaly(
          'oracleDeviationBps',
          'high',
          91,
          '2026-10-07T01:00Z',
          '2025-03-03T00:00Z',
          bands(11, 1, 45),
          asset,
          'bps',
        ),
        'ETH oracle 0.91% off Coinbase, widest gap since Mar 2025',
      ],
      [
        anomaly(
          'priceMove24hPct',
          'low',
          -12.34,
          '2026-10-07T01:00Z',
          '2024-08-05T06:00Z',
          bands(0.1, -6, 6.7),
          asset,
        ),
        'ETH −12.3% in 24h, largest drop since Aug 2024',
      ],
    ]
    for (const [a, headline] of cases) {
      expect(anomalyHeadline(a)).toBe(headline)
      const l = anomalyLabels(a, emptyFrames)
      for (const text of [headline, l.measured, l.driver, l.signal]) {
        expect(text.length).toBeGreaterThan(0)
        for (const re of BANNED) expect(text, `${re} in "${text}"`).not.toMatch(re)
      }
    }
    // Every detected (metric, tail) pair has a template.
    for (const [metric, rule] of Object.entries(METRIC_RULES))
      for (const tail of rule.tails)
        expect(() =>
          anomalyHeadline(
            anomaly(metric as Series['metric'], tail, 1, '2026-10-07T01:00Z', null, bands(5, 2, 8)),
          ),
        ).not.toThrow()
  })

  it('a run headline never reads "4.8% under 4.8%"', () => {
    const a = anomaly('borrowAprPct', 'low', 4.78, '2026-02-06T06:00Z', null, bands(5.9, 4.84, 9))
    const run: Anomaly = {
      ...a,
      kind: 'run',
      severity: 'run',
      run: { from: ts('2025-12-31T06:00Z'), hours: 37 * 24, edge: 4.84 },
    }
    expect(anomalyHeadline(run)).toBe(
      'Aave USDC borrow rate 4.78%, under 4.84% for 37 days, longest run on record (from Oct 2023)',
    )
  })

  it('labels a state switch with its block and what it blocks', () => {
    const c: StateChange = {
      kind: 'state',
      subject: { kind: 'venue', id: 'spark-dai', label: 'Spark DAI' },
      flag: 'paused',
      on: true,
      at: ts('2026-10-06T12:00Z'),
      block: 23_500_000,
      previous: ts('2024-03-01T00:00Z'),
      runFrom: null,
      recordFromTs: ts('2023-10-01T00:00Z'),
      source: 'synthetic',
    }
    expect(stateHeadline(c)).toBe('Spark DAI withdrawals paused, first time since 1 Mar 2024')
    expect(stateLabels(c)).toEqual({
      measured: 'Reserve flag paused set at block 23500000, read 2026-10-06 12:00Z',
      driver: 'Pool configuration change on-chain',
      signal: 'Withdrawals are blocked: every exit from this venue waits for an unpause.',
    })
  })
})

// ------------------------------------------------------------------ ranking

describe('venueWire ranking', () => {
  const at = '2026-10-07T01:00Z'
  const level = (
    metric: Series['metric'],
    tail: 'low' | 'high',
    x: number,
    since: string | null,
    b: Bands,
    id = 'aave-core-usdc',
  ) => anomaly(metric, tail, x, at, since, b, { kind: 'venue', id, label: id })

  it('scores are the product of their stated parts, risk before reward', () => {
    const exit = levelImpact(level('idleCashPct', 'low', 3, '2026-01-01T00:00Z', bands(12, 7, 30)))
    const yieldDown = levelImpact(
      level('utilisationPct', 'low', 60, '2026-01-01T00:00Z', bands(87, 70, 93)),
    )
    expect(exit.axis).toBe('risk')
    expect(yieldDown.axis).toBe('reward')
    for (const i of [exit, yieldDown]) {
      const p = i.parts
      expect(i.score).toBeCloseTo(p.weight * p.severity * p.magnitude * p.span, 1)
      expect(p.magnitude).toBeGreaterThanOrEqual(1)
      expect(p.magnitude).toBeLessThanOrEqual(3)
    }
    expect(AXIS_WEIGHT.risk).toBeGreaterThan(AXIS_WEIGHT.reward)
    expect(exit.score).toBeGreaterThan(yieldDown.score)
  })

  it('a pause outranks every level story, a record outranks a tail', () => {
    const pause = stateImpact({
      kind: 'state',
      flag: 'paused',
      on: true,
      at: 400 * D,
      previous: 399 * D,
    } as StateChange)
    const maxLevel = AXIS_WEIGHT.risk * 3 * 3 * 2 // record × top magnitude × top span
    expect(pause.score).toBeGreaterThan(maxLevel)
    const record = levelImpact(level('idleCashPct', 'low', 3, null, bands(12, 7, 30)))
    const tail = levelImpact({
      ...level('idleCashPct', 'low', 6.5, '2026-08-01T00:00Z', bands(12, 7, 30)),
      severity: 'tail',
    })
    expect(pause.score).toBeGreaterThan(record.score)
    expect(record.score).toBeGreaterThan(tail.score)
  })

  it('folds same-subject, same-effect stories into one and orders deterministically', () => {
    const det = {
      at: ts(at),
      findings: [
        level('idleCashPct', 'low', 3, null, bands(12, 7, 30)),
        level('exitCapacity', 'low', 1e6, '2026-05-01T00:00Z', bands(2e8, 4e7, 1e9)),
        level('idleCashPct', 'low', 3, null, bands(12, 7, 30), 'spark-dai'),
      ].map((a) => ({
        ...a,
        baseline: { ...a.baseline, unit: a.baseline.metric === 'exitCapacity' ? 'usd' : 'pct' },
      })),
      baselines: [],
      uncovered: [],
      newest: new Map<string, number>(),
    }
    const ranked = rankStories(storiesOf(det, emptyFrames, ts(at), WIRE_THRESHOLDS))
    expect(ranked).toHaveLength(2)
    expect(ranked.map((s) => s.subject.id)).toEqual(['aave-core-usdc', 'spark-dai'])
    expect(ranked[0].also).toEqual(['exitCapacity'])
    expect(ranked[0].stale).toBe(true) // no newest reading known → stale, never fresh by default
    for (let i = 1; i < ranked.length; i++)
      expect(ranked[i - 1].impact.score).toBeGreaterThanOrEqual(ranked[i].impact.score)
  })
})

// ------------------------------------------------------------------ query

describe('venueWire query', () => {
  it('parses views, asOf, venue and limit; rejects bad input', () => {
    expect(parseWireQuery({ view: 'wire' })).toEqual({
      view: 'stories',
      asOf: undefined,
      venue: undefined,
      limit: 20,
    })
    expect(
      parseWireQuery({
        view: 'baselines',
        asOf: '2026-04-20T12:00:00Z',
        venue: 'aave-core-usdc',
        limit: '500',
      }),
    ).toEqual({
      view: 'baselines',
      asOf: ts('2026-04-20T12:00:00Z'),
      venue: 'aave-core-usdc',
      limit: 100,
    })
    expect(parseWireQuery({ view: 'wire', asOf: '1700000000' }).asOf).toBe(1_700_000_000)
    for (const bad of [
      { view: 'nope' },
      { view: 'wire', asOf: 'soon' },
      { view: 'wire', limit: '-1' },
      { view: 'wire', venue: 'DROP TABLE' },
      { view: ['wire', 'wire'] },
    ])
      expect(() => parseWireQuery(bad), JSON.stringify(bad)).toThrow(QueryError)
  })

  it('with no inputs, every input is listed as uncovered (a quiet wire is not an all-clear)', () => {
    const r = buildWire({}, parseWireQuery({ view: 'wire' }), {
      now: ts('2026-10-12T00:00Z'),
    }) as WireResponse
    expect(r.stories).toEqual([])
    expect(r.stale).toBe(true)
    expect(r.uncovered.map((u) => u.subject).sort()).toEqual([
      'depeg',
      'ethUsd',
      'stethEth',
      'venueStress',
    ])
  })
})

// ------------------------------------------------------------------ the real measured history (rule N18)

const ROOT = datasetsRoot()
const hasData = Object.values(WIRE_FILES).every((p) => existsSync(join(ROOT, ...p)))
const NOW = ts('2026-10-12T00:00Z')

describe.skipIf(!hasData)('venueWire on the measured venue history', () => {
  const read = <T>(k: keyof typeof WIRE_FILES): T =>
    JSON.parse(readFileSync(join(ROOT, ...WIRE_FILES[k]), 'utf8'))
  const inputs: WireInputs = hasData
    ? {
        venueStress: { history: read('venueHistory'), summary: read('venueSummary') },
        ethUsd: read('ethUsd'),
        stethEth: read('stethEth'),
        depeg: read('depeg'),
      }
    : {}
  const frames = hasData ? buildFrames(inputs) : emptyFrames
  const wire = (asOf?: string, venueId?: string, src: WireInputs | WireFrames = frames) =>
    buildWire(
      src,
      parseWireQuery({
        view: 'wire',
        limit: '100',
        ...(asOf ? { asOf } : {}),
        ...(venueId ? { venue: venueId } : {}),
      }),
      { now: NOW },
    ) as WireResponse

  it('builds every series: 9 venues × idle, exit, utilisation (+ rate off MetaMorpho), and the asset series', () => {
    expect(frames.venues.size).toBe(9)
    const count = (m: string) => frames.series.filter((s) => s.metric === m).length
    expect([
      count('idleCashPct'),
      count('exitCapacity'),
      count('utilisationPct'),
      count('borrowAprPct'),
    ]).toEqual([9, 9, 9, 8])
    expect([
      count('navDiscountBps'),
      count('depegBps'),
      count('oracleDeviationBps'),
      count('priceMove24hPct'),
    ]).toEqual([1, 2, 1, 1])
    expect(frames.missing).toEqual([])
  })

  it('every story is deterministic, labelled three ways, free of banned words, and ranked', () => {
    for (const asOf of [
      undefined,
      '2026-04-20T12:00:00Z',
      '2024-08-06T00:00:00Z',
      '2026-02-06T06:00:00Z',
    ]) {
      const a = wire(asOf)
      expect(wire(asOf)).toEqual(a)
      for (const s of a.stories) {
        expect(s.labels.measured && s.labels.driver && s.labels.signal, s.id).toBeTruthy()
        for (const re of BANNED) expect(allText(s), `${re} in ${s.id}`).not.toMatch(re)
        expect(s.headline).not.toMatch(/NaN|undefined|Infinity|null/)
      }
      for (let i = 1; i < a.stories.length; i++)
        expect(a.stories[i - 1].impact.score).toBeGreaterThanOrEqual(a.stories[i].impact.score)
      expect(new Set(a.stories.map((s) => s.id)).size).toBe(a.stories.length)
    }
  })

  it('newest hour (7 Oct 2026): Aave USDT and Aave USDC idle cash runs, flagged stale against today', () => {
    const a = wire()
    expect(iso(a.asOf)).toBe('2026-10-07T01:00:00.000Z')
    expect(a.stale).toBe(true)
    const heads = a.stories.map((s) => s.headline)
    expect(heads.find((h) => h.startsWith('Aave USDT idle cash 4.8%, under'))).toMatch(
      /longest run since Apr$/,
    )
    expect(heads.find((h) => h.startsWith('Aave USDC idle cash 6.0%, under'))).toMatch(
      /longest run since Apr$/,
    )
    expect(a.stories.every((s) => s.stale)).toBe(true)
    // The ETH and stETH price files end a day earlier: no current verdict, listed as stale.
    expect(
      a.uncovered.filter((u) => u.reason === 'stale').map((u) => `${u.subject}:${u.metric}`),
    ).toEqual(expect.arrayContaining(['eth:priceMove24hPct', 'steth:navDiscountBps']))
  })

  it('replays the Apr-2026 Kelp rsETH freeze: Aave WETH frozen, Aave idle cash records', () => {
    const a = wire('2026-04-20T12:00:00Z')
    const heads = a.stories.map((s) => s.headline)
    expect(heads).toContain('Aave WETH reserve frozen, first time on record (from Oct 2023)')
    expect(heads).toContain('Aave USDC idle cash 0.00%, lowest on record (from Oct 2023)')
    expect(a.stories[0].impact.effect).toBe('exit risk up')
    expect(a.stories[0].severity).toBe('record')
    const usdc = a.stories.find((s) => s.headline.startsWith('Aave USDC idle cash'))!
    expect(usdc.also).toContain('exitCapacity')
    expect(usdc.labels.driver).toBe('7d: borrows −$38M, deposits −$822M')
  })

  it('replays the 2024-08-05 yen-carry unwind and the Jun-2022 stETH discount', () => {
    const aug = wire('2024-08-06T00:00:00Z').stories.find((s) => s.metric === 'priceMove24hPct')!
    expect(aug.headline).toBe('ETH −20.6% in 24h, largest drop since Nov 2022')
    expect(aug.labels.driver).toBe('Market-wide: Coinbase ETH/USD −22.2% in the same 24h')
    const steth = wire('2022-06-14T00:00:00Z').stories.find((s) => s.metric === 'navDiscountBps')!
    expect(steth.headline).toBe('stETH discount to NAV 5.90%, widest on record (from Aug 2021)')
    // Aave v3 and Spark had no material WETH venue in this record yet: no venue named.
    expect(steth.affects).toEqual([])
    expect(steth.labels.signal).toBe('May precede stETH loop unwinds.')
  })

  it('cites the named market event the last comparable reading fell in', () => {
    const usde = wire('2026-02-06T06:00:00Z').stories.find((s) => s.subject.id === 'usde')!
    expect(usde.headline).toMatch(/^USDe at \$0\.98\d\d, widest discount to \$1 since Oct 2025$/)
    expect(usde.labels.signal).toMatch(
      /Last at this level on 10 Oct 2025, in the 2025-10-10\/11 liquidation cascade\.$/,
    )
  })

  it('is causal: a replay on the full record equals a replay on the record cut at that hour', () => {
    const at = ts('2026-04-20T12:00:00Z')
    const cut = (k: number) => k <= at
    const h = inputs.venueStress!.history as VenueStressHistoryFile
    const keep = h.timeline.t.filter(cut).length
    const sliceCols = <T extends Record<string, unknown>>(o: T): T =>
      Object.fromEntries(
        Object.entries(o).map(([k, v]) => [k, Array.isArray(v) ? v.slice(0, keep) : v]),
      ) as T
    const cutHourly = (f: HourlyPriceFile): HourlyPriceFile => {
      const n = Math.max(0, Math.min(f.count, Math.floor((at - f.startTs) / f.stepSeconds) + 1))
      return {
        ...f,
        count: n,
        columns: Object.fromEntries(Object.entries(f.columns).map(([k, v]) => [k, v.slice(0, n)])),
      }
    }
    const d = inputs.depeg as DepegHistoryFile
    const truncated: WireInputs = {
      venueStress: {
        history: {
          ...h,
          timeline: sliceCols(h.timeline),
          venues: Object.fromEntries(Object.entries(h.venues).map(([k, v]) => [k, sliceCols(v)])),
        },
        summary: inputs.venueStress!.summary as VenueStressSummaryFile,
      },
      ethUsd: cutHourly(inputs.ethUsd!),
      stethEth: cutHourly(inputs.stethEth!),
      depeg: {
        ...d,
        series: Object.fromEntries(
          Object.entries(d.series).map(([k, rows]) => [k, rows.filter((r) => cut(r[0]))]),
        ),
      },
    }
    expect(wire('2026-04-20T12:00:00Z', undefined, truncated).stories).toEqual(
      wire('2026-04-20T12:00:00Z').stories,
    )
  })

  it('filters by venue: its own stories plus the asset stories that move it', () => {
    const all = wire('2026-04-20T12:00:00Z')
    const one = wire('2026-04-20T12:00:00Z', 'aave-core-weth')
    expect(one.stories.length).toBeGreaterThan(0)
    expect(one.stories.length).toBeLessThan(all.stories.length)
    for (const s of one.stories)
      expect(s.subject.id === 'aave-core-weth' || s.affects.includes('aave-core-weth')).toBe(true)
  })

  it('baselines view: bands and "since" for every fresh series', () => {
    const r = buildWire(
      frames,
      parseWireQuery({ view: 'baselines', asOf: '2026-10-07T01:00:00Z' }),
      { now: NOW },
    )
    if (!('baselines' in r)) throw new Error('expected baselines')
    expect(r.baselines.length).toBe(37)
    for (const b of r.baselines) {
      expect(b.bands.p5).toBeLessThanOrEqual(b.bands.p50)
      expect(b.bands.p50).toBeLessThanOrEqual(b.bands.p95)
      expect(b.bands.n).toBeGreaterThan(0)
    }
  })
})

describe.skipIf(!hasData)('GET /api/venues/news?view=wire', () => {
  const call = async (query: Record<string, string>, method = 'GET') => {
    const out: { status: number; body: any; headers: Record<string, string> } = {
      status: 0,
      body: null,
      headers: {},
    }
    const res = {
      status(n: number) {
        out.status = n
        return res
      },
      json(b: unknown) {
        out.body = b
      },
      setHeader(k: string, v: string) {
        out.headers[k] = v
      },
    }
    await handler({ method, query } as any, res as any)
    return out
  }

  it('serves ranked stories and baselines without touching the database; rejects bad input', async () => {
    const r = await call({ view: 'wire', asOf: '2026-04-20T12:00:00Z', limit: '5' })
    expect(r.status).toBe(200)
    expect(r.body.schema).toBe('venue-wire/v1')
    expect(r.body.stories).toHaveLength(5)
    expect(r.body.total).toBeGreaterThan(5)
    expect(r.headers['Cache-Control']).toMatch(/s-maxage=300/)
    const b = await call({ view: 'baselines' })
    expect(b.status).toBe(200)
    expect(b.body.baselines.length).toBeGreaterThan(0)
    expect((await call({ view: 'nope' })).status).toBe(400)
    expect((await call({ view: 'wire', asOf: 'soon' })).status).toBe(400)
    expect((await call({ view: 'wire' }, 'POST')).status).toBe(405)
  }, 60_000)
})
