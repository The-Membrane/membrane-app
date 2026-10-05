import { describe, expect, it } from 'vitest'

import { applyEvents, recordParamSample, recordSnapshot } from '@/lib/exitQueue/ledger'
import {
  durationStats,
  kmQuantiles,
  nearestRank,
  toUnits,
  venueMetrics,
  windowMetrics,
  type Sample,
} from '@/lib/exitQueue/metrics'
import type { LedgerEvent } from '@/lib/exitQueue/types'

import { addr, def, ledgerWithCoverage, tsOf } from './exitQueueFixtures'

const H = 3_600
const D = 86_400

describe('kmQuantiles', () => {
  it('matches a hand-computed Kaplan–Meier curve', () => {
    // times 1,2,3(c),4,5 → S: 4/5, 3/5, (censor), 3/5·1/2 = 0.3, 0
    const s: Sample[] = [
      { t: 1, observed: true },
      { t: 2, observed: true },
      { t: 3, observed: false },
      { t: 4, observed: true },
      { t: 5, observed: true },
    ]
    expect(kmQuantiles(s, [0.2, 0.5, 0.9])).toEqual([1, 4, 5])
  })

  it('counts events before censorings at a tied time', () => {
    const s: Sample[] = [
      { t: 2, observed: false },
      { t: 2, observed: true },
    ]
    // 1 event of 2 at risk → S = 0.5 at t = 2.
    expect(kmQuantiles(s, [0.5])).toEqual([2])
  })

  it('returns null when the curve never falls that far', () => {
    const s: Sample[] = [
      { t: 1, observed: true },
      { t: 10, observed: false },
      { t: 10, observed: false },
    ]
    expect(kmQuantiles(s, [0.5, 0.9])).toEqual([null, null])
    expect(durationStats(s)).toMatchObject({
      n: 3,
      completed: 1,
      censored: 2,
      p50S: null,
      atLeastS: 10,
    })
  })

  it('negative control: dropping open requests understates the wait while a queue builds', () => {
    // 4 fast completions, 6 requests still open after 5 days.
    const s: Sample[] = [
      ...[1, 2, 3, 4].map((h) => ({ t: h * H, observed: true })),
      ...Array.from({ length: 6 }, () => ({ t: 5 * D, observed: false })),
    ]
    const completedOnly = nearestRank(
      s.filter((x) => x.observed).map((x) => x.t),
      0.5,
    )!
    const km = durationStats(s)
    expect(completedOnly).toBe(2 * H)
    expect(km.p50S).toBeNull()
    expect(km.atLeastS).toBe(5 * D)
  })
})

describe('windowMetrics', () => {
  const lido = def('lido-steth')
  // Ledger covers blocks 1_000..200_000 (~27.6 days at 12s).
  const ledger = () => {
    const l = ledgerWithCoverage('lido-steth', 1_000, 200_000)
    const events: LedgerEvent[] = [
      {
        kind: 'request',
        id: '1',
        owner: addr(1),
        amount: 1n,
        block: 150_000,
        ts: tsOf(150_000),
        logIndex: 0,
      },
      {
        kind: 'request',
        id: '2',
        owner: addr(1),
        amount: 1n,
        block: 150_001,
        ts: tsOf(150_001),
        logIndex: 0,
      },
      {
        kind: 'request',
        id: '3',
        owner: addr(1),
        amount: 1n,
        block: 190_000,
        ts: tsOf(190_000),
        logIndex: 0,
      },
      {
        kind: 'finalize_range',
        fromId: 1n,
        toId: 2n,
        block: 160_000,
        ts: tsOf(160_000),
        logIndex: 0,
      },
      { kind: 'claim', id: '1', logId: 'c1', block: 161_000, ts: tsOf(161_000), logIndex: 0 },
    ]
    return applyEvents(l, lido, events)
  }
  const anchor = { block: 200_000, ts: tsOf(200_000) }

  it('measures request → finalize with the open request censored at its age', () => {
    const w = windowMetrics(ledger(), anchor, 7)
    expect(w.coverage).toBe('complete')
    expect(w.requestToFinalize).toMatchObject({ n: 3, completed: 2, censored: 1 })
    // Durations 119,988 s and 120,000 s (events) plus 120,000 s open: S falls 1 → 2/3 → 1/3.
    expect(w.requestToFinalize.p50S).toBe(tsOf(160_000) - tsOf(150_000))
    expect(w.label).toBe('measured_history')
  })

  it('measures finalize → claim over the finalized cohort', () => {
    const w = windowMetrics(ledger(), anchor, 7)
    expect(w.finalizeToClaim).toMatchObject({ n: 2, completed: 1, censored: 1 })
  })

  it('marks a window longer than the ledger as partial, and none before coverage', () => {
    expect(windowMetrics(ledger(), anchor, 90).coverage).toBe('partial')
    expect(windowMetrics(ledger(), { block: 500, ts: tsOf(500) }, 7).coverage).toBe('none')
  })

  it('ignores requests made after the anchor', () => {
    const w = windowMetrics(ledger(), { block: 170_000, ts: tsOf(170_000) }, 7)
    expect(w.requestToFinalize.n).toBe(2)
  })

  it('sUSDe: a maturity after the anchor counts as still waiting', () => {
    const susde = def('ethena-susde')
    const l = ledgerWithCoverage('ethena-susde', 1_000, 2_000)
    recordParamSample(l, { block: 999, ts: tsOf(999), values: { cooldownDuration: 7 * D } })
    applyEvents(l, susde, [
      {
        kind: 'request',
        id: 'a',
        owner: addr(1),
        amount: 1n,
        block: 1_500,
        ts: tsOf(1_500),
        logIndex: 0,
      },
    ])
    const w = windowMetrics(l, { block: 2_000, ts: tsOf(2_000) }, 7)
    expect(w.requestToFinalize).toMatchObject({ completed: 0, censored: 1, p50S: null })
  })
})

describe('venueMetrics', () => {
  it('reports queue now from the on-chain snapshot, cooldown, last change, and the venue_state row', () => {
    const susde = def('ethena-susde')
    const l = ledgerWithCoverage('ethena-susde', 1_000, 2_000)
    recordParamSample(l, { block: 1_000, ts: tsOf(1_000), values: { cooldownDuration: 604_800 } })
    recordParamSample(l, { block: 2_000, ts: tsOf(2_000), values: { cooldownDuration: 86_400 } })
    recordSnapshot(l, {
      block: 2_000,
      ts: tsOf(2_000),
      depthAmount: (15n * 10n ** 24n).toString(),
      depthCount: 40,
      depthSource: 'onchain',
    })
    const m = venueMetrics(susde, l)
    expect(m.anchor).toEqual({ block: 2_000, ts: tsOf(2_000) })
    expect(m.queueNow).toMatchObject({
      amountUnits: 15_000_000,
      count: 40,
      source: 'onchain',
      amountIsLowerBound: false,
    })
    expect(m.advertisedCooldownS).toBe(86_400)
    expect(m.lastChange).toMatchObject({
      param: 'cooldownDuration',
      from: 604_800,
      to: 86_400,
      source: 'state_diff',
    })
    expect(m.venueState).toEqual({
      venue_id: 'ethena-susde',
      block: 2_000,
      ts: tsOf(2_000),
      queue_depth: 15_000_000,
      queue_depth_count: 40,
      cooldown_s: 86_400,
      proxy: 'none',
    })
    expect(m.windows.map((w) => w.windowDays)).toEqual([7, 30, 90])
  })

  it('Kelp: advertised delay is blocks × 12 s; a ledger-summed amount short of the on-chain count is a lower bound', () => {
    const l = ledgerWithCoverage('kelp-rseth', 1_000, 2_000)
    recordParamSample(l, {
      block: 2_000,
      ts: tsOf(2_000),
      values: { withdrawalDelayBlocks: 57_600 },
    })
    recordSnapshot(l, {
      block: 2_000,
      ts: tsOf(2_000),
      depthAmount: '5',
      depthCount: 138,
      depthSource: 'ledger',
      extra: { amountIsLowerBound: true },
    })
    const m = venueMetrics(def('kelp-rseth'), l)
    expect(m.advertisedCooldownS).toBe(57_600 * 12)
    expect(m.queueNow.amountIsLowerBound).toBe(true)
  })

  it('reconciles ledger open requests with the on-chain pending count', () => {
    const l = ledgerWithCoverage('lido-steth', 1_000, 2_000)
    const snap = (ledgerOpen: number) => ({
      block: 2_000 + ledgerOpen,
      ts: tsOf(2_000 + ledgerOpen),
      depthAmount: '1',
      depthCount: 513,
      depthSource: 'onchain' as const,
      extra: { countSource: 'onchain', ledgerOpen },
    })
    recordSnapshot(l, snap(513))
    expect(venueMetrics(def('lido-steth'), l).queueNow.reconciliation?.status).toBe('match')
    recordSnapshot(l, snap(600))
    expect(venueMetrics(def('lido-steth'), l).queueNow.reconciliation).toEqual({
      ledgerOpen: 600,
      onchain: 513,
      status: 'ledger_over',
    })
  })

  it('counts bracket and claim-implied finalizations as upper bounds', () => {
    const l = ledgerWithCoverage('etherfi-weeth', 1_000, 3_000)
    applyEvents(l, def('etherfi-weeth'), [
      {
        kind: 'request',
        id: '1',
        owner: addr(1),
        amount: 1n,
        block: 1_100,
        ts: tsOf(1_100),
        logIndex: 0,
      },
      {
        kind: 'request',
        id: '2',
        owner: addr(1),
        amount: 1n,
        block: 1_100,
        ts: tsOf(1_100),
        logIndex: 1,
      },
      {
        kind: 'request',
        id: '3',
        owner: addr(1),
        amount: 1n,
        block: 1_100,
        ts: tsOf(1_100),
        logIndex: 2,
      },
      {
        kind: 'finalize_through',
        throughId: 1n,
        via: 'bisect',
        block: 1_200,
        ts: tsOf(1_200),
        logIndex: 9,
      },
      {
        kind: 'finalize_through',
        throughId: 2n,
        via: 'bracket',
        block: 1_300,
        ts: tsOf(1_300),
        logIndex: 9,
      },
      { kind: 'claim', id: '3', logId: 'c3', block: 1_400, ts: tsOf(1_400), logIndex: 0 },
    ])
    expect(venueMetrics(def('etherfi-weeth'), l).ledgerHealth.bracketedFinalizations).toBe(2)
  })

  it('excludes changes after an explicit anchor', () => {
    const l = ledgerWithCoverage('lido-steth', 1_000, 3_000)
    l.changes.push(
      { param: 'paused', from: false, to: true, block: 1_500, ts: tsOf(1_500), source: 'event' },
      { param: 'paused', from: true, to: false, block: 2_500, ts: tsOf(2_500), source: 'event' },
    )
    expect(
      venueMetrics(def('lido-steth'), l, { block: 2_000, ts: tsOf(2_000) }).lastChange?.block,
    ).toBe(1_500)
  })

  it('returns an anchorless row when there is no ledger', () => {
    const m = venueMetrics(def('etherfi-weeth'), {
      ...ledgerWithCoverage('etherfi-weeth', 1, 1),
      coverage: null,
    })
    expect(m.anchor).toBeNull()
    expect(m.venueState).toBeNull()
  })
})

describe('toUnits', () => {
  it('keeps six decimals without float overflow on 18-decimal amounts', () => {
    expect(toUnits('150123712229178126668854', 18)).toBeCloseTo(150_123.712229, 6)
    expect(toUnits('1500000', 6)).toBe(1.5)
    expect(toUnits(null, 18)).toBeNull()
  })
})
