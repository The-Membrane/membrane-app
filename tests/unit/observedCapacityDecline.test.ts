import { describe, expect, it } from 'vitest'

import type { Entry } from '@/components/Carry/venueLogLogic'
import { observedCapacityDecline } from '@/components/Venue/observedCapacityDecline'

const now = Date.parse('2026-09-28T12:00:00.000Z')
const snapshot = {
  block: 200,
  observedAt: '2026-09-28T11:00:00.000Z',
  instantUsd: 80,
  params: { depthUsd: null },
}
const falling: Entry = {
  venue: 'aave-v3-usde',
  kind: 'instant_liquidity_shift',
  at: '2026-09-28T11:00:05.000Z',
  since: '2026-09-28T10:00:00.000Z',
  prev: { instant_usd: 100 },
  next: { instant_usd: 80 },
  provenance: 'observed',
}

describe('observed capacity decline readout', () => {
  it('shows a witnessed decline only while a fresh snapshot still matches its after value', () => {
    expect(observedCapacityDecline([falling], 'aave-v3-usde', snapshot, now)).toMatchObject({
      status: 'available',
      metric: 'instant_usd',
      beforeUsd: 100,
      afterUsd: 80,
      since: falling.since,
      at: falling.at,
      snapshotBlock: 200,
    })
  })

  it('uses the latest same-metric move and does not resurrect an earlier decline after a rise', () => {
    const rise: Entry = {
      ...falling,
      at: '2026-09-28T11:30:00.000Z',
      since: falling.at,
      prev: { instant_usd: 80 },
      next: { instant_usd: 90 },
    }
    expect(
      observedCapacityDecline(
        [falling, rise],
        'aave-v3-usde',
        { ...snapshot, instantUsd: 90 },
        now,
      ),
    ).toMatchObject({ status: 'unavailable', reason: 'latest_move_not_decline' })
  })

  it('rejects a stale or conflicting current snapshot', () => {
    expect(
      observedCapacityDecline(
        [falling],
        'aave-v3-usde',
        { ...snapshot, observedAt: '2026-09-28T05:59:00.000Z' },
        now,
      ),
    ).toMatchObject({ status: 'unavailable', reason: 'snapshot_stale' })
    expect(
      observedCapacityDecline([falling], 'aave-v3-usde', { ...snapshot, instantUsd: 75 }, now),
    ).toMatchObject({ status: 'unavailable', reason: 'snapshot_mismatch' })
  })

  it('does not present an old decline as current shrinkage even when the latest snapshot matches', () => {
    const oldMove: Entry = {
      ...falling,
      at: '2026-09-27T11:00:05.000Z',
      since: '2026-09-27T10:00:00.000Z',
    }
    expect(observedCapacityDecline([oldMove], 'aave-v3-usde', snapshot, now)).toMatchObject({
      status: 'unavailable',
      reason: 'latest_move_stale',
    })
  })

  it('rejects missing windows, invalid values, and mismatched event/source ordering', () => {
    for (const entry of [
      { ...falling, since: null },
      { ...falling, since: falling.at },
      { ...falling, prev: { instant_usd: null } },
      { ...falling, prev: { instant_usd: -1 } },
      { ...falling, next: { instant_usd: Infinity } },
    ]) {
      expect(observedCapacityDecline([entry], 'aave-v3-usde', snapshot, now)).toMatchObject({
        status: 'unavailable',
        reason: 'latest_move_invalid',
      })
    }
    expect(
      observedCapacityDecline(
        [falling],
        'aave-v3-usde',
        { ...snapshot, observedAt: '2026-09-28T10:50:00.000Z' },
        now,
      ),
    ).toMatchObject({ status: 'unavailable', reason: 'snapshot_mismatch' })
  })

  it('keeps a missing or venue-filtered feed unavailable, not an all-clear', () => {
    expect(observedCapacityDecline(undefined, 'aave-v3-usde', snapshot, now)).toMatchObject({
      status: 'unavailable',
      reason: 'source_unavailable',
    })
    expect(
      observedCapacityDecline([{ ...falling, venue: 'elsewhere' }], 'aave-v3-usde', snapshot, now),
    ).toMatchObject({ status: 'unavailable', reason: 'feed_limited_or_no_move' })
  })

  it('matches the depth metric only when the summary has no protocol cash read', () => {
    const depth: Entry = {
      ...falling,
      kind: 'param_changed',
      prev: { depth_usd: 100 },
      next: { depth_usd: 80 },
    }
    expect(
      observedCapacityDecline(
        [depth, falling],
        'aave-v3-usde',
        { ...snapshot, instantUsd: null, params: { depthUsd: 80 } },
        now,
      ),
    ).toMatchObject({ status: 'available', metric: 'depth_usd' })
  })
})
