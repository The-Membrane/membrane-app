import { describe, expect, it } from 'vitest'

import {
  inventoryShareLabel,
  isRecentObservedEvent,
  isRecentPublishedNews,
  newsFetchedAtLabel,
  observedInventoryShare,
  routeHeadroomAfterFlow,
  selectObservedCapacitySignal,
} from '@/components/Venue/flowImpactCardLogic'
import type { Entry } from '@/components/Carry/venueLogLogic'

const validated = {
  status: 'validated' as const,
  horizonHours: 24,
  capacityBeforeCompetingFlowUsd: { low: 100, high: 140 },
  expectedCompetingOutflowUsd: { low: 20, high: 50 },
}

describe('routeHeadroomAfterFlow', () => {
  it('abstains without a validated competing-flow band and matching question', () => {
    expect(routeHeadroomAfterFlow(null, 10, 24)).toBeNull()
    expect(routeHeadroomAfterFlow(validated, 10, 2)).toBeNull()
    expect(routeHeadroomAfterFlow(validated, null, 24)).toBeNull()
  })

  it('subtracts high competing flow from low capacity and includes the user amount', () => {
    expect(routeHeadroomAfterFlow(validated, 60, 24)).toEqual({
      lowUsd: -10,
      highUsd: 60,
      relation: 'uncertain',
    })
  })

  it('rejects inconsistent bands and classifies wholly negative headroom', () => {
    expect(
      routeHeadroomAfterFlow(
        { ...validated, expectedCompetingOutflowUsd: { low: 60, high: 20 } },
        10,
        24,
      ),
    ).toBeNull()
    expect(routeHeadroomAfterFlow(validated, 150, 24)?.relation).toBe('below')
  })
})

describe('observedInventoryShare', () => {
  it('shows how a fixed user size occupies more of declining aggregate inventory', () => {
    const share = observedInventoryShare(10_000, 500_000_000, 495_000_000)
    expect(share?.beforePercent).toBeCloseTo(0.002)
    expect(share?.afterPercent).toBeCloseTo(0.0020202)
    expect(inventoryShareLabel(share!.beforePercent)).toBe('0.002%')
    expect(inventoryShareLabel(share!.afterPercent)).toBe('0.00202%')
  })

  it('does not manufacture a share from missing or zero measured inventory', () => {
    expect(observedInventoryShare(10_000, null, 495_000_000)).toBeNull()
    expect(observedInventoryShare(10_000, 500_000_000, 0)).toBeNull()
    expect(observedInventoryShare(null, 500_000_000, 495_000_000)).toBeNull()
  })
})

describe('isRecentPublishedNews', () => {
  const now = Date.parse('2026-09-30T21:00:00.000Z')

  it('uses article publication time, not fetch time', () => {
    expect(isRecentPublishedNews('2026-09-30T20:00:00.000Z', now)).toBe(true)
    expect(isRecentPublishedNews('2026-09-28T20:00:00.000Z', now)).toBe(false)
    expect(isRecentPublishedNews(null, now)).toBe(false)
  })

  it('rejects a headline with an implausible future publication time', () => {
    expect(isRecentPublishedNews('2026-09-30T21:06:00.000Z', now)).toBe(false)
  })
})

describe('isRecentObservedEvent', () => {
  const now = Date.parse('2026-09-30T21:00:00.000Z')

  it('keeps current measured events and excludes old or invalid events', () => {
    expect(isRecentObservedEvent('2026-09-30T20:00:00.000Z', now)).toBe(true)
    expect(isRecentObservedEvent('2026-09-28T20:00:00.000Z', now)).toBe(false)
    expect(isRecentObservedEvent('invalid', now)).toBe(false)
    expect(isRecentObservedEvent('2026-09-30T21:06:00.000Z', now)).toBe(false)
  })
})

describe('observed capacity signal selection', () => {
  const now = Date.parse('2026-09-30T21:00:00.000Z')
  const snapshot = {
    block: 200,
    observedAt: '2026-09-30T20:00:00.000Z',
    instantUsd: 80,
    params: { depthUsd: null },
  }
  const decline: Entry = {
    venue: 'aave-v3-usde',
    kind: 'instant_liquidity_shift',
    since: '2026-09-30T19:00:00.000Z',
    at: '2026-09-30T20:00:05.000Z',
    prev: { instant_usd: 100 },
    next: { instant_usd: 80 },
    provenance: 'observed',
  }

  it('maps both witnessed endpoints when the development signal is absent', () => {
    expect(selectObservedCapacitySignal(null, [decline], 'aave-v3-usde', snapshot, now)).toEqual({
      metric: 'instantUsd',
      signal: {
        status: 'none',
        before: { usd: 100, blockTime: decline.since },
        after: { usd: 80, blockTime: decline.at },
        declineUsd: 20,
        declinePercent: 20,
      },
    })
  })

  it('highlights only a material witnessed decline', () => {
    const material = {
      ...decline,
      prev: { instant_usd: 1_000_000 },
      next: { instant_usd: 800_000 },
    }
    expect(
      selectObservedCapacitySignal(
        null,
        [material],
        'aave-v3-usde',
        { ...snapshot, instantUsd: 800_000 },
        now,
      ).signal?.status,
    ).toBe('observed_shrinking')
  })

  it('never fills a pair from an unavailable, stale, mismatched, or rising log', () => {
    expect(selectObservedCapacitySignal(null, undefined, 'aave-v3-usde', snapshot, now)).toEqual({
      metric: null,
      signal: null,
    })
    expect(
      selectObservedCapacitySignal(
        null,
        [decline],
        'aave-v3-usde',
        { ...snapshot, instantUsd: 70 },
        now,
      ),
    ).toEqual({ metric: null, signal: null })
    expect(
      selectObservedCapacitySignal(
        null,
        [decline],
        'aave-v3-usde',
        { ...snapshot, observedAt: '2026-09-30T12:00:00.000Z' },
        now,
      ),
    ).toEqual({ metric: null, signal: null })
    expect(
      selectObservedCapacitySignal(
        null,
        [{ ...decline, prev: { instant_usd: 70 } }],
        'aave-v3-usde',
        snapshot,
        now,
      ),
    ).toEqual({ metric: null, signal: null })
  })

  it('keeps an explicit development result, including unavailable, as the source', () => {
    const measured = { metric: 'instantUsd' as const, signal: { status: 'unavailable' as const } }
    expect(
      selectObservedCapacitySignal(measured, [decline], 'aave-v3-usde', snapshot, now),
    ).toEqual({
      metric: 'instantUsd',
      signal: measured.signal,
    })
  })
})

describe('news fetch provenance', () => {
  it('distinguishes the database first write from the replaceable local fetch time', () => {
    expect(newsFetchedAtLabel('database')).toBe('First stored')
    expect(newsFetchedAtLabel('local_mac_recorder')).toBe('Last fetched')
    expect(newsFetchedAtLabel(undefined)).toBe('Fetched')
  })
})
