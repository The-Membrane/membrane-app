/**
 * measuredCapacity — the adapter from a measured capacity sample stream to the stress
 * engine's explicit `exitCapacityUsd`. One describe per rule in the module header
 * (lib/position-sim/measuredCapacity.ts), plus the engine integration.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  MEASURED_DEFAULT_CADENCE_MS,
  MEASURED_DESCRIPTIVE_LABEL,
  measuredExitCapacity,
  withMeasuredCapacity,
  type CapacitySample,
  type MeasuredCapacityOptions,
  type MeasuredCapacityResult,
  type MeasuredExitCapacity,
} from '@/lib/position-sim/measuredCapacity'
import {
  STRESS_LABEL,
  runStress,
  stressGridScenarios,
  type StressModelled,
  type StressPosition,
  type StressResult,
} from '@/lib/position-sim/stressGrid'

// ------------------------------------------------------------------ fixtures

const H = 3_600_000
const AS_OF = Date.UTC(2026, 9, 1, 12) // 2026-10-01T12:00:00Z
const BLOCK_AT_AS_OF = 20_000_000
const DEPLOYED = 50_000

const blockAt = (t: number) => BLOCK_AT_AS_OF + Math.floor((t - AS_OF) / 12_000)

function sample(t: number, capacityUsd: number | null, o: Partial<CapacitySample> = {}) {
  return {
    observedAtMs: t,
    block: blockAt(t),
    metric: 'depth_curve',
    routeId: 'univ3:aUSDC>USDC',
    costCapPct: 0.5,
    capacityUsd,
    ...o,
  } satisfies CapacitySample
}

/** Samples every `stepMs` from `end − hours·H` to `end` inclusive; cap(i) sets each value. */
function series(
  hours: number,
  cap: (i: number) => number | null,
  o: Partial<CapacitySample> & { end?: number; stepMs?: number } = {},
): CapacitySample[] {
  const { end = AS_OF, stepMs = H, ...rest } = o
  const n = Math.round((hours * H) / stepMs)
  const out: CapacitySample[] = []
  for (let i = 0; i <= n; i++) out.push(sample(end - (n - i) * stepMs, cap(i), rest))
  return out
}

const opts = (o: Partial<MeasuredCapacityOptions> = {}): MeasuredCapacityOptions => ({
  measure: 'latest',
  nowMs: AS_OF,
  deployedUsd: DEPLOYED,
  ...o,
})

function measured(r: MeasuredCapacityResult): MeasuredExitCapacity {
  if (r.status !== 'measured') throw new Error(`not measured: ${JSON.stringify(r)}`)
  return r
}

const carryPos = (o: Partial<StressPosition> = {}): StressPosition => ({
  collateralUsd: 100_000,
  debtUsd: 61_300,
  line: 0.8,
  membraneClass: 'delayed',
  tradeShape: 'carry',
  deployedUsd: DEPLOYED,
  debtMinimumUsd: 2000,
  exitCapacityPreset: 'optimistic',
  ...o,
})

function sm(r: StressResult): StressModelled {
  if (r.outcome === 'not_modelled') throw new Error(`not modelled: ${r.reason}`)
  return r
}

/** Deterministic PRNG (mulberry32). */
function prng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

afterEach(() => vi.restoreAllMocks())

// ------------------------------------------------------- rule 1: executable metric

describe('rule 1 — only depth_curve produces an exit capacity', () => {
  it.each(['aggregate_cash', 'depth_usd_raw'] as const)(
    '%s alone is not_modelled not_executable_metric (both measures)',
    (metric) => {
      const s = series(720, () => 1e9, { metric, costCapPct: null })
      for (const measure of ['latest', 'worst-trailing'] as const) {
        const r = measuredExitCapacity(s, opts({ measure }))
        expect(r.status).toBe('not_modelled')
        expect(r.status === 'not_modelled' && r.reason).toBe('not_executable_metric')
        expect('exitCapacityUsd' in r).toBe(false)
      }
    },
  )

  it('a depth_curve sample without a cost cap is unbounded, so not executable', () => {
    const r = measuredExitCapacity(
      series(10, () => 5_000, { costCapPct: null }),
      opts(),
    )
    expect(r.status === 'not_modelled' && r.reason).toBe('not_executable_metric')
  })

  it('non-executable samples in a mixed stream never move the value, the asOf or the coverage', () => {
    const depth = series(720, (i) => 10_000 + i)
    // Newer, larger AND smaller aggregate figures, interleaved on the same route.
    const cash = [
      ...series(720, () => 1e9, { metric: 'aggregate_cash', costCapPct: null }),
      ...series(720, () => 1, { metric: 'depth_usd_raw', end: AS_OF + 1 }),
    ]
    const mixedNow = AS_OF + 1
    for (const measure of ['latest', 'worst-trailing'] as const) {
      const pure = measured(measuredExitCapacity(depth, opts({ measure, nowMs: mixedNow })))
      const mixed = measured(
        measuredExitCapacity([...cash, ...depth], opts({ measure, nowMs: mixedNow })),
      )
      expect(mixed.exitCapacityUsd).toBe(pure.exitCapacityUsd)
      expect(mixed.asOfMs).toBe(AS_OF)
      expect(mixed.coverageHours).toBe(pure.coverageHours)
      expect(mixed.sampleCount).toBe(pure.sampleCount)
      expect(mixed.metric).toBe('depth_curve')
      expect(mixed.notes.some((n) => n.includes('non-executable'))).toBe(true)
    }
  })
})

// ------------------------------------------------------------ rule 2: one series

describe('rule 2 — one metric, one route, one cost cap per series', () => {
  it('samples at another cost cap are excluded; the default cap is the latest sample’s', () => {
    const atHalf = series(720, () => 8_000)
    const atTwo = series(720, () => 90_000, { costCapPct: 2, end: AS_OF - 1 })
    const r = measured(measuredExitCapacity([...atTwo, ...atHalf], opts()))
    expect(r.costCapPct).toBe(0.5)
    expect(r.exitCapacityUsd).toBe(8_000)
    expect(r.sampleCount).toBe(721)
    expect(r.notes.some((n) => n.includes('another cost cap'))).toBe(true)

    const two = measured(measuredExitCapacity([...atTwo, ...atHalf], opts({ costCapPct: 2 })))
    expect(two.costCapPct).toBe(2)
    expect(two.exitCapacityUsd).toBe(90_000)
    expect(two.asOfMs).toBe(AS_OF - 1)
  })

  it('a requested cost cap with no samples is no_samples, never a neighbouring cap', () => {
    const r = measuredExitCapacity(
      series(10, () => 8_000),
      opts({ costCapPct: 1 }),
    )
    expect(r.status === 'not_modelled' && r.reason).toBe('no_samples')
  })

  it('a route change starts a new series: the old route’s history is not used', () => {
    const old = series(700, () => 100, { routeId: 'curve:A', end: AS_OF - 5 * H })
    const live = series(4, () => 20_000, { routeId: 'univ3:B' })
    const s = [...old, ...live]

    const latest = measured(measuredExitCapacity(s, opts()))
    expect(latest.routeId).toBe('univ3:B')
    expect(latest.exitCapacityUsd).toBe(20_000)
    expect(latest.sampleCount).toBe(5)
    expect(latest.notes.some((n) => n.includes('Route changed to univ3:B'))).toBe(true)

    // The old route's low readings never become the worst: the new series is too short.
    const worst = measuredExitCapacity(s, opts({ measure: 'worst-trailing' }))
    expect(worst).toMatchObject({
      status: 'insufficient_history',
      sampleCount: 5,
      coverageHours: 4,
    })
  })

  it('A → B → A uses only the trailing A run (an earlier run on the same route is excluded)', () => {
    const a1 = series(100, () => 1, { routeId: 'A', end: AS_OF - 20 * H })
    const b = series(9, () => 50, { routeId: 'B', end: AS_OF - 10 * H })
    const a2 = series(9, (i) => 7_000 + i, { routeId: 'A' })
    const r = measured(measuredExitCapacity([...a1, ...b, ...a2], opts()))
    expect(r.routeId).toBe('A')
    expect(r.sampleCount).toBe(10)
    expect(r.coverageHours).toBe(9)
    const w = measuredExitCapacity(
      [...a1, ...b, ...a2],
      opts({ measure: 'worst-trailing', windowHours: 9 }),
    )
    expect(measured(w).exitCapacityUsd).toBe(7_000)
  })
})

// ------------------------------------- same-instant ties: conservative, order-free

describe('same-instant ties are settled conservatively, never by input order', () => {
  const interleave = (a: CapacitySample[], b: CapacitySample[]) => a.flatMap((s, i) => [s, b[i]])

  it('several caps at the latest instant: the default cap is the SMALLEST, in either order', () => {
    // A depth-curve recorder writes every cost cap of a block at one observedAtMs.
    const lo = series(720, () => 5_000)
    const hi = series(720, () => 60_000, { costCapPct: 2 })
    for (const s of [interleave(lo, hi), interleave(hi, lo)]) {
      for (const measure of ['latest', 'worst-trailing'] as const) {
        const r = measured(measuredExitCapacity(s, opts({ measure })))
        expect(r).toMatchObject({
          costCapPct: 0.5,
          exitCapacityUsd: 5_000,
          equivalentToOptimistic: false,
        })
        expect(r.notes.some((n) => n.includes('smallest'))).toBe(true)
      }
      // An explicit cap is still honoured.
      const two = measured(measuredExitCapacity(s, opts({ costCapPct: 2 })))
      expect(two).toMatchObject({ costCapPct: 2, exitCapacityUsd: 60_000 })
    }
  })

  it('two routes at the latest instant are ambiguous: refused in either order, never the larger', () => {
    const a = series(10, () => 5_000, { routeId: 'A' })
    const b = series(10, () => 70_000, { routeId: 'B' })
    for (const s of [interleave(a, b), interleave(b, a), [...a, ...b], [...b, ...a]]) {
      for (const measure of ['latest', 'worst-trailing'] as const) {
        expect(measuredExitCapacity(s, opts({ measure }))).toMatchObject({
          status: 'not_modelled',
          reason: 'ambiguous_route',
          asOfMs: null,
        })
      }
    }
    // A reverted quote on the other route at that instant is still a second live route.
    const bNull = sample(AS_OF, null, { routeId: 'B' })
    expect(measuredExitCapacity([...a, bNull], opts())).toMatchObject({ reason: 'ambiguous_route' })
  })

  it('a route tie at an earlier instant breaks the series there, in either order', () => {
    const a = series(10, () => 5_000, { routeId: 'A' })
    const bTie = sample(AS_OF - 4 * H, 70_000, { routeId: 'B' })
    for (const s of [
      [...a, bTie],
      [bTie, ...a],
    ]) {
      const r = measured(measuredExitCapacity(s, opts()))
      expect(r.routeId).toBe('A')
      expect(r.sampleCount).toBe(4) // AS_OF − 3 h … AS_OF
      expect(r.coverageHours).toBe(3)
    }
  })

  it('conflicting values at one instant on one series: the minimum, in either order', () => {
    const base = series(5, () => 4_000, { end: AS_OF - H })
    const lo = sample(AS_OF, 1_000, { block: BLOCK_AT_AS_OF })
    const hi = sample(AS_OF, 9_000, { block: BLOCK_AT_AS_OF + 1 })
    for (const s of [
      [...base, lo, hi],
      [...base, hi, lo],
      [hi, ...base, lo],
    ]) {
      const r = measured(measuredExitCapacity(s, opts()))
      expect(r.exitCapacityUsd).toBe(1_000)
      expect(r.asOfBlock).toBe(BLOCK_AT_AS_OF)
      expect(r.valueBlock).toBe(BLOCK_AT_AS_OF)
    }
  })

  it('fuzz: tied caps, routes, values and nulls give the same result in any input order', () => {
    const rnd = prng(7)
    const shuffle = <T>(xs: T[]) => {
      const out = [...xs]
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1))
        ;[out[i], out[j]] = [out[j], out[i]]
      }
      return out
    }
    for (let k = 0; k < 300; k++) {
      const s: CapacitySample[] = []
      const n = 1 + Math.floor(rnd() * 40)
      for (let i = 0; i < n; i++) {
        const t = AS_OF - Math.floor(rnd() * 12) * H
        s.push(
          sample(t, rnd() < 0.2 ? null : 1_000 * Math.floor(rnd() * 10), {
            routeId: rnd() < 0.8 ? 'A' : 'B',
            costCapPct: rnd() < 0.5 ? 0.5 : 2,
            block: rnd() < 0.5 ? blockAt(t) : blockAt(t) + 1,
          }),
        )
      }
      for (const o of [
        opts(),
        opts({ measure: 'worst-trailing', windowHours: 12 }),
        opts({ costCapPct: 2 }),
      ]) {
        const a = measuredExitCapacity(s, o)
        expect(measuredExitCapacity(shuffle(s), o)).toEqual(a)
        expect(measuredExitCapacity([...s].reverse(), o)).toEqual(a)
      }
    }
  })
})

// ------------------------------------------------------------- rule 3: freshness

describe('rule 3 — freshness: 2 × cadence, named by asOf', () => {
  const s = series(720, () => 12_345)

  it('exactly 2 × cadence old is fresh; one ms more is stale', () => {
    const edge = measured(measuredExitCapacity(s, opts({ nowMs: AS_OF + 2 * H })))
    expect(edge.ageHours).toBe(2)
    expect(edge.asOfMs).toBe(AS_OF)

    const stale = measuredExitCapacity(s, opts({ nowMs: AS_OF + 2 * H + 1 }))
    expect(stale).toMatchObject({ status: 'not_modelled', reason: 'stale', asOfMs: AS_OF })
    expect('exitCapacityUsd' in stale).toBe(false)
  })

  it('the same boundary under a custom cadence (15 min), for both measures', () => {
    const q = 15 * 60_000
    for (const measure of ['latest', 'worst-trailing'] as const) {
      const ok = measuredExitCapacity(s, opts({ measure, cadenceMs: q, nowMs: AS_OF + 2 * q }))
      expect(ok.status).toBe('measured')
      const st = measuredExitCapacity(s, opts({ measure, cadenceMs: q, nowMs: AS_OF + 2 * q + 1 }))
      expect(st.status === 'not_modelled' && st.reason).toBe('stale')
    }
  })

  it('the default cadence is one hour', () => {
    expect(MEASURED_DEFAULT_CADENCE_MS).toBe(H)
  })

  it('provenance names the value by its asOf time and block, never "now"', () => {
    const r = measured(measuredExitCapacity(s, opts({ nowMs: AS_OF + H })))
    expect(r.provenance).toContain(new Date(AS_OF).toISOString())
    expect(r.provenance).toContain(`block ${BLOCK_AT_AS_OF}`)
    expect(r.asOfBlock).toBe(BLOCK_AT_AS_OF)
    expect(r.provenance).not.toMatch(/\bnow\b|current/i)
    expect(r.ageHours).toBe(1)
  })
})

// ----------------------------------------------------------- rule 4: two measures

describe('rule 4 — latest and worst-trailing', () => {
  it('latest is the latest sample; worst-trailing is the window minimum', () => {
    const s = series(720, (i) => (i === 300 ? 2_500 : 10_000 + i))
    const latest = measured(measuredExitCapacity(s, opts()))
    expect(latest.id).toBe('latest')
    expect(latest.exitCapacityUsd).toBe(10_720)
    expect(latest.valueObservedAtMs).toBe(AS_OF)

    const worst = measured(measuredExitCapacity(s, opts({ measure: 'worst-trailing' })))
    expect(worst.id).toBe('worst-trailing')
    expect(worst.exitCapacityUsd).toBe(2_500)
    expect(worst.valueObservedAtMs).toBe(AS_OF - 420 * H)
    expect(worst.valueBlock).toBe(blockAt(AS_OF - 420 * H))
    expect(worst.asOfMs).toBe(AS_OF) // the window ends at asOf
    expect(worst.windowHours).toBe(720)
    expect(worst.coverageHours).toBe(720)
    expect(worst.sampleCount).toBe(721)
  })

  it('a sample before the window never enters the minimum, but covers the leading edge', () => {
    const s = [sample(AS_OF - 721 * H, 1), ...series(719, () => 9_000)] // gap 721h → 719h ago: 2h
    const r = measured(measuredExitCapacity(s, opts({ measure: 'worst-trailing' })))
    expect(r.exitCapacityUsd).toBe(9_000)
    expect(r.sampleCount).toBe(720)
    expect(r.coverageHours).toBe(720) // [AS_OF−720h, AS_OF−719h] covered by the boundary pair
  })

  it('worst <= latest on random series (and both only from known samples)', () => {
    const rnd = prng(7)
    for (let k = 0; k < 200; k++) {
      const s = series(720, () => (rnd() < 0.1 ? null : Math.round(rnd() * 1e6)))
      s[s.length - 1] = sample(AS_OF, Math.round(rnd() * 1e6))
      const l = measured(measuredExitCapacity(s, opts()))
      const w = measured(measuredExitCapacity(s, opts({ measure: 'worst-trailing' })))
      expect(w.exitCapacityUsd).toBeLessThanOrEqual(l.exitCapacityUsd)
      const known = s.map((x) => x.capacityUsd).filter((x): x is number => x !== null)
      expect(w.exitCapacityUsd).toBe(Math.min(...known))
    }
  })

  it('coverage boundary: exactly 80% of the window is enough; 1 ms less is not', () => {
    // 576 h = 0.8 × 720 h of hourly samples, nothing earlier.
    const exact = series(576, () => 4_000)
    const ok = measured(measuredExitCapacity(exact, opts({ measure: 'worst-trailing' })))
    expect(ok.coverageHours).toBe(576)

    const short = [sample(AS_OF - 576 * H + 1, 4_000), ...series(575, () => 4_000)]
    const r = measuredExitCapacity(short, opts({ measure: 'worst-trailing' }))
    expect(r).toEqual({
      status: 'insufficient_history',
      id: 'worst-trailing',
      coverageHours: 576 - 1 / H,
      sampleCount: 577,
      windowHours: 720,
      requiredCoverageHours: 576,
      routeId: 'univ3:aUSDC>USDC',
      costCapPct: 0.5,
      asOfMs: AS_OF,
      ageHours: 0,
    })
    // 'latest' does not need history; it reports the same coverage descriptively.
    expect(measured(measuredExitCapacity(short, opts())).coverageHours).toBe(576 - 1 / H)
  })

  it('the 80% gate never rounds in the position’s favour (non-integer window)', () => {
    const w = { measure: 'worst-trailing' as const }
    // windowMs ≈ 3,600,003 ms: 80% ≈ 2,880,002.4 ms, so 2,880,002 ms covered is short.
    const short = [sample(AS_OF - 2_880_002, 1_000), sample(AS_OF, 1_000)]
    expect(measuredExitCapacity(short, opts({ ...w, windowHours: 3_600_003 / H }))).toMatchObject({
      status: 'insufficient_history',
    })
    // windowMs = 3,600,002.5 ms: 80% is exactly 2,880,002 ms, which is enough.
    expect(measuredExitCapacity(short, opts({ ...w, windowHours: 3_600_002.5 / H }))).toMatchObject(
      { status: 'measured' },
    )
  })

  it('duplicate samples at one instant count once', () => {
    const one = sample(AS_OF, 4_000)
    const dup = Array.from({ length: 577 }, () => ({ ...one }))
    expect(measured(measuredExitCapacity(dup, opts()))).toMatchObject({
      sampleCount: 1,
      coverageHours: 0,
    })
    expect(measuredExitCapacity(dup, opts({ measure: 'worst-trailing' }))).toMatchObject({
      status: 'insufficient_history',
      sampleCount: 1,
    })
    const s = series(10, () => 4_000)
    const half = AS_OF - 30 * 60_000
    const doubled = [...s, ...s.map((x) => ({ ...x })), sample(half, null), sample(half, null)]
    const r = measured(measuredExitCapacity(doubled, opts()))
    expect(r.sampleCount).toBe(11)
    expect(r.unknownSampleCount).toBe(1)
  })

  it('a gap of exactly maxGap is covered; maxGap + 1 ms is uncovered', () => {
    const w = { measure: 'worst-trailing' as const, windowHours: 10 }
    const covered = [sample(AS_OF - 10 * H, 1), sample(AS_OF - 4 * H, 1), sample(AS_OF, 1)]
    expect(measured(measuredExitCapacity(covered, opts(w))).coverageHours).toBe(10)

    const holed = [sample(AS_OF - 10 * H, 1), sample(AS_OF - 4 * H + 1, 1), sample(AS_OF, 1)]
    const r = measuredExitCapacity(holed, opts(w))
    expect(r.status).toBe('insufficient_history')
    expect(r.status === 'insufficient_history' && r.coverageHours).toBe(4 - 1 / H)
  })

  it('a custom window and gap are honoured', () => {
    const s = series(48, () => 3_000, { stepMs: 12 * H })
    const def = measuredExitCapacity(s, opts({ measure: 'worst-trailing', windowHours: 48 }))
    expect(def.status === 'insufficient_history' && def.coverageHours).toBe(0)
    const wide = measured(
      measuredExitCapacity(
        s,
        opts({ measure: 'worst-trailing', windowHours: 48, maxGapMs: 12 * H }),
      ),
    )
    expect(wide.coverageHours).toBe(48)
    expect(wide.sampleCount).toBe(5)
  })
})

// ------------------------------------------------------ unknown samples (null)

describe('null samples are unknown — not zero, not below anything', () => {
  it('worst-trailing ignores unknown samples (it never reads them as 0)', () => {
    const s = series(720, (i) => (i % 7 === 3 ? null : 6_000 + (i % 5)))
    const r = measured(measuredExitCapacity(s, opts({ measure: 'worst-trailing' })))
    expect(r.exitCapacityUsd).toBe(6_000)
    expect(r.unknownSampleCount).toBe(103)
    expect(r.sampleCount).toBe(721 - 103)
    expect(r.notes.some((n) => n.includes('not zero'))).toBe(true)
  })

  it('an unknown latest sample: latest is the latest KNOWN value, named by its own asOf', () => {
    const s = [...series(10, () => 7_500, { end: AS_OF - H }), sample(AS_OF, null)]
    const r = measured(measuredExitCapacity(s, opts()))
    expect(r.exitCapacityUsd).toBe(7_500)
    expect(r.asOfMs).toBe(AS_OF - H)
    expect(r.ageHours).toBe(1)
    expect(r.notes.some((n) => n.includes('latest 1 sample(s) are unknown'))).toBe(true)
  })

  it('unknown samples do not refresh the asOf: three reverted hours make the value stale', () => {
    const s = [
      ...series(10, () => 7_500, { end: AS_OF - 3 * H }),
      sample(AS_OF - 2 * H, null),
      sample(AS_OF - H, null),
      sample(AS_OF, null),
    ]
    const r = measuredExitCapacity(s, opts())
    expect(r).toMatchObject({ status: 'not_modelled', reason: 'stale', asOfMs: AS_OF - 3 * H })
  })

  it('unknown samples do not count as coverage', () => {
    const s = series(720, (i) => (i % 10 === 0 ? 5_000 : null)) // known every 10 h, maxGap 6 h
    const r = measuredExitCapacity(s, opts({ measure: 'worst-trailing' }))
    expect(r).toMatchObject({ status: 'insufficient_history', coverageHours: 0, sampleCount: 73 })
  })

  it('a live route with no known sample is no_known_sample, not a zero capacity', () => {
    const s = [...series(100, () => 9_000, { routeId: 'A', end: AS_OF - H }), sample(AS_OF, null)]
    const r = measuredExitCapacity(s, opts())
    expect(r.status === 'not_modelled' && r.reason).toBe('no_known_sample')
  })
})

// ---------------------------------------------------- rule 5: optimistic equivalence

describe('rule 5 — equivalentToOptimistic', () => {
  const at = (cap: number) =>
    measured(
      measuredExitCapacity(
        series(2, () => cap),
        opts(),
      ),
    )

  it('capacity >= deployed is flagged and noted; below is not', () => {
    const above = at(80_000)
    expect(above.equivalentToOptimistic).toBe(true)
    expect(above.notes.some((n) => n.includes("'optimistic' preset"))).toBe(true)
    expect(at(DEPLOYED).equivalentToOptimistic).toBe(true)

    const below = at(DEPLOYED - 0.01)
    expect(below.equivalentToOptimistic).toBe(false)
    expect(below.notes.some((n) => n.includes('optimistic'))).toBe(false)
  })

  it('compared in cents, as the engine normalizes', () => {
    expect(at(DEPLOYED - 0.004).equivalentToOptimistic).toBe(true)
    expect(at(DEPLOYED - 0.006).equivalentToOptimistic).toBe(false)
  })

  it('at the scenario ×1 capacity a flagged figure runs exactly like the optimistic preset', () => {
    const m = at(80_000)
    const unscaled = stressGridScenarios('carry').filter(
      (sc) => (sc.venue?.capacityMult ?? 1) === 1,
    )
    expect(unscaled.length).toBeGreaterThan(0)
    for (const sc of unscaled) {
      const viaMeasured = sm(runStress(withMeasuredCapacity(carryPos(), m), sc))
      const viaPreset = sm(runStress(carryPos({ exitCapacityPreset: 'optimistic' }), sc))
      expect({ ...viaMeasured, cellKey: '' }).toEqual({ ...viaPreset, cellKey: '' })
    }
  })

  it('under a capacity cut the measured figure is scaled, not the deployed amount', () => {
    const m = at(80_000)
    const sc = { price: { kind: 'step' as const, drop: 0.3 }, venue: { capacityMult: 0.5 } }
    const viaMeasured = sm(runStress(withMeasuredCapacity(carryPos(), m), sc))
    const viaPreset = sm(runStress(carryPos({ exitCapacityPreset: 'optimistic' }), sc))
    expect(viaMeasured.recallAvailableUsd).toBe(40_000) // min(50k deployed, 80k × 0.5)
    expect(viaPreset.recallAvailableUsd).toBe(25_000) // 50k × 1 × 0.5
    expect(m.notes.some((n) => n.includes('capacity cut scales this measured figure'))).toBe(true)
  })
})

// ------------------------------------------------------------- rule 6: output

describe('rule 6 — output fields, labels, no durations', () => {
  it('carries exactly the documented fields and both labels', () => {
    const r = measured(
      measuredExitCapacity(
        series(720, () => 9_000),
        opts({ measure: 'worst-trailing' }),
      ),
    )
    expect(Object.keys(r).sort()).toEqual(
      [
        'status',
        'id',
        'exitCapacityUsd',
        'costCapPct',
        'metric',
        'routeId',
        'asOfMs',
        'asOfBlock',
        'ageHours',
        'valueObservedAtMs',
        'valueBlock',
        'sampleCount',
        'unknownSampleCount',
        'coverageHours',
        'windowHours',
        'deployedUsd',
        'equivalentToOptimistic',
        'descriptiveLabel',
        'stressLabel',
        'provenance',
        'notes',
      ].sort(),
    )
    expect(r.descriptiveLabel).toBe('sampled history, descriptive — not a forecast')
    expect(r.descriptiveLabel).toBe(MEASURED_DESCRIPTIVE_LABEL)
    expect(r.stressLabel).toBe(STRESS_LABEL)
    expect(r.provenance).toContain('depth_curve')
    expect(r.provenance).toContain('univ3:aUSDC>USDC')
    expect(r.provenance).toContain('0.5%')
  })

  it('sets no freeze and no duration — on the result or on the stress position', () => {
    const r = measured(
      measuredExitCapacity(
        series(720, () => 0),
        opts(),
      ),
    )
    expect(Object.keys(r).filter((k) => /freeze|duration|^lock|unlock/i.test(k))).toEqual([])
    const p = withMeasuredCapacity(carryPos(), r)
    expect(Object.keys(p).filter((k) => /freeze|duration|venue/i.test(k))).toEqual([])
    // A zero reading is a capacity of 0 for this run — not a freeze of any length.
    const node = sm(runStress(p, { price: { kind: 'step', drop: 0.3 } }))
    expect(node.recallAvailableUsd).toBe(0)
    expect(node.recallOpensAtSeconds).toBe(node.timeToBreachSeconds)
  })
})

// --------------------------------------------------------- rule 7: engine bridge

describe('rule 7 — withMeasuredCapacity', () => {
  const m = measured(
    measuredExitCapacity(
      series(720, () => 12_000),
      opts(),
    ),
  )

  it('sets exitCapacityUsd and removes the preset and the multiplier, without mutating', () => {
    // UPDATED 2026-10-06: 'stressed' (×0.5, named) is gone; any preset id serves here.
    const input = carryPos({ exitCapacityPreset: 'aave-usdc-typical', exitCapacityMult: 0.3 })
    const out = withMeasuredCapacity(input, m)
    expect(out.exitCapacityUsd).toBe(12_000)
    expect('exitCapacityPreset' in out).toBe(false)
    expect('exitCapacityMult' in out).toBe(false)
    expect(input.exitCapacityPreset).toBe('aave-usdc-typical')
    expect(input.exitCapacityMult).toBe(0.3)
  })

  it.each([
    [
      'stale',
      measuredExitCapacity(
        series(720, () => 12_000),
        opts({ nowMs: AS_OF + 3 * H }),
      ),
    ],
    [
      'insufficient_history',
      measuredExitCapacity(
        series(10, () => 12_000),
        opts({ measure: 'worst-trailing' }),
      ),
    ],
    [
      'not_executable_metric',
      measuredExitCapacity(
        series(10, () => 1e9, { metric: 'aggregate_cash' }),
        opts(),
      ),
    ],
  ] as const)('a %s result strips every capacity input — never a preset fallback', (_, r) => {
    expect(r.status).not.toBe('measured')
    const out = withMeasuredCapacity(
      carryPos({ exitCapacityPreset: 'optimistic', exitCapacityUsd: 1e9, exitCapacityMult: 1 }),
      r,
    )
    expect('exitCapacityUsd' in out).toBe(false)
    expect('exitCapacityPreset' in out).toBe(false)
    expect('exitCapacityMult' in out).toBe(false)
  })

  it('throws on a malformed measured object', () => {
    expect(() => withMeasuredCapacity(carryPos(), { ...m, exitCapacityUsd: NaN })).toThrow()
    expect(() => withMeasuredCapacity(carryPos(), { ...m, exitCapacityUsd: -1 })).toThrow()
    expect(() =>
      withMeasuredCapacity(carryPos(), {
        ...m,
        metric: 'aggregate_cash' as unknown as 'depth_curve',
      }),
    ).toThrow()
  })

  it('throws when applied to a position with a different deployedUsd than it was measured for', () => {
    expect(() => withMeasuredCapacity(carryPos({ deployedUsd: 10_000 }), m)).toThrow(/deployedUsd/)
    expect(
      withMeasuredCapacity(carryPos({ deployedUsd: DEPLOYED + 0.001 }), m).exitCapacityUsd,
    ).toBe(12_000)
  })
})

// ------------------------------------------------------- rule 8: pure, deterministic

describe('rule 8 — pure and deterministic', () => {
  it('never reads the clock', () => {
    vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('Date.now called')
    })
    const s = series(720, (i) => 1_000 + i)
    expect(() => measuredExitCapacity(s, opts({ measure: 'worst-trailing' }))).not.toThrow()
    expect(() => measuredExitCapacity(s, opts())).not.toThrow()
  })

  it('same inputs → same output; input order does not matter', () => {
    const rnd = prng(42)
    const s = series(720, (i) => (i % 11 === 0 ? null : 1_000 + Math.round(rnd() * 9_000)))
    const shuffled = [...s]
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1))
      ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
    }
    for (const measure of ['latest', 'worst-trailing'] as const) {
      const a = measuredExitCapacity(s, opts({ measure }))
      expect(measuredExitCapacity(s, opts({ measure }))).toEqual(a)
      expect(measuredExitCapacity(shuffled, opts({ measure }))).toEqual(a)
    }
  })

  it('malformed input is refused, not repaired', () => {
    const good = series(5, () => 1_000)
    const bad = (o: Partial<CapacitySample>) =>
      measuredExitCapacity([...good, sample(AS_OF - 30 * 60_000, 1_000, o)], opts())
    for (const o of [
      { capacityUsd: -1 },
      { capacityUsd: NaN },
      { capacityUsd: Infinity },
      { observedAtMs: NaN },
      { observedAtMs: AS_OF + 1 }, // after nowMs
      { metric: 'tvl' as CapacitySample['metric'] },
      { costCapPct: -0.5 },
    ]) {
      const r = bad(o)
      expect(r.status === 'not_modelled' && r.reason).toBe('invalid_input')
    }
    expect(measuredExitCapacity([], opts())).toMatchObject({ reason: 'no_samples' })
    expect(measuredExitCapacity(good, opts({ nowMs: NaN }))).toMatchObject({
      reason: 'invalid_input',
    })
    expect(measuredExitCapacity(good, opts({ deployedUsd: -1 }))).toMatchObject({
      reason: 'invalid_input',
    })
  })

  it('a timestamp beyond the Date range is refused, not a crash', () => {
    const MAX = 8.64e15 // the last valid Date
    const huge = 9e15 // e.g. a nanosecond-ish timestamp: finite, but no Date
    const call = () => measuredExitCapacity([sample(huge, 1_000)], opts({ nowMs: huge }))
    expect(call).not.toThrow()
    expect(call()).toMatchObject({ status: 'not_modelled', reason: 'invalid_input' })
    expect(
      measuredExitCapacity(
        series(5, () => 1_000),
        opts({ nowMs: huge }),
      ),
    ).toMatchObject({
      reason: 'invalid_input',
    })
    // The range edge itself is a valid time.
    expect(measuredExitCapacity([sample(MAX, 1_000)], opts({ nowMs: MAX }))).toMatchObject({
      status: 'measured',
    })
  })
})

// ------------------------------------------------------- integration: runStress

describe('integration with the stress engine', () => {
  it.each([
    ['latest', 'latest'],
    ['worst-trailing', 'worst-trailing'],
  ] as const)(
    'runStress(withMeasuredCapacity(…, %s)) equals the same exitCapacityUsd by hand',
    (_, measure) => {
      const s = series(720, (i) => 3_000 + ((i * 37) % 4_000))
      const m = measured(measuredExitCapacity(s, opts({ measure })))
      // UPDATED 2026-10-06: a LOCKED measured preset (Kelp, 45 h) — the measured USD figure
      // must drop its lock too, or the two runs below would differ.
      const p = carryPos({ exitCapacityPreset: 'aave-usdc-worst' })
      const manual: StressPosition = { ...p, exitCapacityUsd: m.exitCapacityUsd }
      delete manual.exitCapacityPreset
      for (const sc of stressGridScenarios('carry')) {
        const a = runStress(withMeasuredCapacity(p, m), sc)
        expect(a).toEqual(runStress(manual, sc))
        // exitCapacityUsd wins over a preset the caller left on: still the same node.
        expect(a).toEqual(runStress({ ...p, exitCapacityUsd: m.exitCapacityUsd }, sc))
        expect(a.outcome).not.toBe('not_modelled')
        expect(a.label).toBe(STRESS_LABEL)
      }
      expect(m.exitCapacityUsd).toBe(measure === 'latest' ? 3_000 + ((720 * 37) % 4_000) : 3_000)
    },
  )

  it('a measured capacity below deployed actually binds the recall stock', () => {
    const m = measured(
      measuredExitCapacity(
        series(2, () => 8_000),
        opts(),
      ),
    )
    const node = sm(
      runStress(withMeasuredCapacity(carryPos(), m), { price: { kind: 'step', drop: 0.3 } }),
    )
    expect(node.recallAvailableUsd).toBe(8_000)
    expect(m.equivalentToOptimistic).toBe(false)
  })

  it('a not-usable adapter result yields a not_modelled stress node (no silent optimistic)', () => {
    const stale = measuredExitCapacity(
      series(720, () => 1e9),
      opts({ nowMs: AS_OF + 2 * H + 1 }),
    )
    expect(stale.status).toBe('not_modelled')
    // The input position even carried the optimistic preset: it must not survive.
    const node = runStress(
      withMeasuredCapacity(carryPos({ exitCapacityPreset: 'optimistic' }), stale),
      {
        price: { kind: 'step', drop: 0.3 },
      },
    )
    expect(node.outcome).toBe('not_modelled')
    expect(node.outcome === 'not_modelled' && node.reason).toBe('no_exit_capacity')
    expect(node.label).toBe(STRESS_LABEL)
  })
})
