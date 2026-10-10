import { describe, expect, it } from 'vitest'

import {
  currentReadStatus,
  historicalCarryCashContext,
  projectAggregateCashStress24h,
  withReadOnlyCurrentCash,
} from '@/lib/carry/historicalCashContext'

const subject = {
  route_key: 'USDC → supply on Aave V3',
  destination: '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c',
  asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
}

const anchors = Array.from({ length: 30 }, (_, index) => {
  const anchorAt = new Date(Date.UTC(2026, 8, 1 + index, 22)).toISOString()
  return {
    collectionMode: 'retrospective' as const,
    anchorAt,
    firstLocalReceiptAt: '2026-09-30T23:00:00.000Z',
    source: { blockAt: anchorAt, block: String(index), blockHash: `0x${'a'.repeat(64)}` },
    subjects: [
      {
        routeKey: subject.route_key,
        destination: subject.destination,
        asset: subject.asset,
        assetDecimals: 6,
        cashRaw: String(index % 2 === 0 ? 1_000_000 : 1_000_000 + (index + 1) * 100_000),
        state: 'observed',
      },
    ],
  }
})

describe('exact Carry historical cash context', () => {
  it('keeps sealed history and overlays a fresh two-origin current read without inventing a receipt', () => {
    const now = Date.parse('2026-10-01T04:00:00.000Z')
    const archived = historicalCarryCashContext(anchors, subject, now)
    const live = {
      status: 'available' as const,
      sourceKind: 'live_read_only_two_origin_finalized' as const,
      routeKey: subject.route_key,
      destination: subject.destination,
      asset: subject.asset,
      assetDecimals: 6,
      cashRaw: '9000000',
      block: '999',
      blockHash: `0x${'b'.repeat(64)}`,
      blockAt: '2026-10-01T03:45:00.000Z',
      readAtUtc: '2026-10-01T03:59:00.000Z',
    }
    const updated = withReadOnlyCurrentCash(archived, subject, live, now)
    expect(currentReadStatus(archived, updated, live)).toEqual({
      status: 'available',
      sourceKind: 'live_read_only_two_origin_finalized',
    })
    expect(updated).toMatchObject({
      status: 'historical_context',
      sourceKind: 'local_sha_replayed_finalized_rpc',
      sampleCount: 15,
      current: {
        cashRaw: '9000000',
        sourceKind: 'live_read_only_two_origin_finalized',
        firstLocalReceiptAt: null,
        freshness: 'fresh',
      },
    })
    expect(projectAggregateCashStress24h(updated, subject, '1000000', now)).toMatchObject({
      status: 'available',
      currentCashRaw: '9000000',
      currentAfterRequestedRaw: '8000000',
    })
    for (const invalid of [
      { ...live, assetDecimals: 18 },
      { ...live, routeKey: 'other route' },
      { ...live, blockAt: '2026-09-30T01:00:00.000Z' },
      { ...live, readAtUtc: '2026-10-01T04:01:00.000Z' },
    ])
      expect(withReadOnlyCurrentCash(archived, subject, invalid, now)).toBe(archived)
    expect(currentReadStatus(archived, archived, live)).toEqual({
      status: 'unavailable',
      reason: 'live_read_rejected',
    })
    expect(
      currentReadStatus(archived, archived, {
        status: 'unavailable',
        reason: 'cash_origin_disagreement',
      }),
    ).toEqual({ status: 'unavailable', reason: 'cash_origin_disagreement' })
    expect(
      currentReadStatus(archived, archived, {
        status: 'unavailable',
        reason: 'https://private-rpc.example',
      }),
    ).toEqual({ status: 'unavailable', reason: 'live_read_failed' })
  })

  it('rejects lower live heights and same-block retiming while accepting unchanged or strictly newer headers', () => {
    const now = Date.parse('2026-10-07T12:00:00.000Z')
    const context = historicalCarryCashContext(anchors, subject, now)
    if (context.status !== 'historical_context') throw new Error('fixture unavailable')
    const archived = {
      ...context,
      current: {
        cashRaw: '100000000',
        block: '1000',
        blockHash: `0x${'b'.repeat(64)}`,
        blockAt: '2026-10-07T09:00:00.000Z',
        firstLocalReceiptAt: '2026-10-07T09:01:00.000Z',
        freshness: 'stale' as const,
      },
    }
    const original = JSON.stringify(archived)
    const live = {
      status: 'available' as const,
      sourceKind: 'live_read_only_two_origin_finalized' as const,
      routeKey: subject.route_key,
      destination: subject.destination,
      asset: subject.asset,
      assetDecimals: 6,
      ...archived.current,
      blockAt: '2026-10-07T11:59:59.000Z',
      readAtUtc: new Date(now).toISOString(),
    }
    for (const changed of [
      { block: '999' },
      {},
      { block: ['1001'] },
      { block: { toString: () => '1001' } },
      { block: 1001 },
      { block: String(1n << 256n) },
    ])
      expect(
        withReadOnlyCurrentCash(archived, subject, { ...live, ...changed } as never, now),
      ).toBe(archived)
    const freshArchive = {
      ...archived,
      current: { ...archived.current, blockAt: live.blockAt, freshness: 'fresh' as const },
    }
    const sameHeader = withReadOnlyCurrentCash(freshArchive, subject, live, now)
    expect(sameHeader).not.toBe(freshArchive)
    expect(sameHeader).toMatchObject({
      current: { block: '1000', blockAt: live.blockAt },
    })
    for (const changed of [{ cashRaw: '1' }, { blockHash: `0x${'d'.repeat(64)}` }])
      expect(withReadOnlyCurrentCash(freshArchive, subject, { ...live, ...changed }, now)).toBe(
        freshArchive,
      )
    const newer = { ...live, block: '1001', cashRaw: '120000000', blockHash: `0x${'c'.repeat(64)}` }
    const updated = withReadOnlyCurrentCash(archived, subject, newer, now)
    expect(updated).toMatchObject({
      current: { block: '1001', cashRaw: '120000000', firstLocalReceiptAt: null },
    })
    for (const blockAt of [archived.current.blockAt, '2026-10-07T08:59:59.000Z'])
      expect(withReadOnlyCurrentCash(archived, subject, { ...newer, blockAt }, now)).toBe(archived)
    newer.cashRaw = '1'
    expect(updated).toMatchObject({ current: { cashRaw: '120000000' } })
    expect(JSON.stringify(archived)).toBe(original)
  })

  it('uses 15 physically disjoint 24h pairs and keeps current separate', () => {
    const current = {
      ...anchors[29],
      collectionMode: 'current' as const,
      source: { ...anchors[29].source, blockAt: '2026-09-30T22:30:00.000Z' },
      subjects: [{ ...anchors[29].subjects[0], cashRaw: '999999999' }],
    }
    const result = historicalCarryCashContext(
      [current, ...anchors],
      subject,
      Date.parse('2026-09-30T23:00:00.000Z'),
    )
    expect(result.status).toBe('historical_context')
    if (result.status !== 'historical_context') return
    expect(result.sampleCount).toBe(15)
    expect(result.sourceKind).toBe('local_sha_replayed_finalized_rpc')
    expect(result.anchorCount).toBe(30)
    expect(result.gridLabel).toBe('22:00 UTC daily / 30 days')
    expect(result.coverageFrom).toBe(anchors[0].anchorAt)
    expect(result.coverageTo).toBe(anchors[29].anchorAt)
    expect(result.worstSampledNetChangeRaw).toBe('200000')
    expect(result.p10NetChangeRaw).toBe('400000')
    expect(result.p90NetChangeRaw).toBe('2800000')
    expect(result.current?.cashRaw).toBe('999999999')
    expect(result.current?.freshness).toBe('fresh')
  })

  it('rejects missing days, wrong subject or asset, and no-code or unassessed history', () => {
    expect(historicalCarryCashContext(anchors.slice(1), subject).status).toBe('unavailable')
    expect(
      historicalCarryCashContext(
        anchors.map((entry, index) =>
          index === 3 ? { ...entry, anchorAt: '2026-09-04T21:00:00.000Z' } : entry,
        ),
        subject,
      ),
    ).toMatchObject({ status: 'unavailable', reason: 'insufficient_daily_anchors' })
    expect(
      historicalCarryCashContext(anchors, { ...subject, destination: '0x' + 'b'.repeat(40) }),
    ).toMatchObject({ status: 'unavailable', reason: 'identity_mismatch' })
    for (const [state, reason] of [
      ['unassessed', 'subject_unassessed'],
      ['no_code', 'subject_no_code'],
    ] as const) {
      const changed = anchors.map((entry, index) =>
        index === 3
          ? {
              ...entry,
              subjects: [
                { ...entry.subjects[0], state, asset: null, assetDecimals: null, cashRaw: null },
              ],
            }
          : entry,
      )
      expect(historicalCarryCashContext(changed, subject)).toMatchObject({
        status: 'unavailable',
        reason,
      })
    }
    expect(
      historicalCarryCashContext(
        anchors.map((entry, index) =>
          index === 3
            ? { ...entry, subjects: [{ ...entry.subjects[0], asset: '0x' + 'b'.repeat(40) }] }
            : entry,
        ),
        subject,
      ),
    ).toMatchObject({ status: 'unavailable', reason: 'identity_mismatch' })
  })

  it('treats observed zero cash as data and tags an older current block stale', () => {
    const zeroRows = anchors.map((entry) => ({
      ...entry,
      subjects: [{ ...entry.subjects[0], cashRaw: '0' }],
    }))
    const current = {
      ...zeroRows[29],
      collectionMode: 'current' as const,
      subjects: [{ ...zeroRows[29].subjects[0], cashRaw: '0' }],
    }
    const result = historicalCarryCashContext(
      [...zeroRows, current],
      subject,
      Date.parse('2026-10-01T04:00:00.000Z'),
    )
    expect(result).toMatchObject({
      status: 'historical_context',
      p10NetChangeRaw: '0',
      p90NetChangeRaw: '0',
      worstSampledNetChangeRaw: '0',
      current: { cashRaw: '0', freshness: 'stale' },
    })
  })

  it('switches only when the independent 120-day midnight grid is complete', () => {
    const midnight = Array.from({ length: 120 }, (_, index) => {
      const anchorAt = new Date(Date.UTC(2026, 5, 2 + index)).toISOString()
      return {
        ...anchors[0],
        anchorAt,
        source: { ...anchors[0].source, blockAt: anchorAt },
        subjects: [
          { ...anchors[0].subjects[0], cashRaw: String(index % 2 === 0 ? 0 : 50_000_000) },
        ],
      }
    })
    const partial = historicalCarryCashContext([...anchors, ...midnight.slice(0, 119)], subject)
    expect(partial).toMatchObject({
      status: 'historical_context',
      gridLabel: '22:00 UTC daily / 30 days',
      anchorCount: 30,
      sampleCount: 15,
      p10NetChangeRaw: '400000',
    })
    const complete = historicalCarryCashContext([...anchors, ...midnight], subject)
    expect(complete).toMatchObject({
      status: 'historical_context',
      gridLabel: '00:00 UTC daily / 120 days',
      anchorCount: 120,
      sampleCount: 60,
      p10NetChangeRaw: '50000000',
      p90NetChangeRaw: '50000000',
      coverageFrom: midnight[0].anchorAt,
      coverageTo: midnight[119].anchorAt,
    })
    const midnightBeforeDeployment = midnight.map((entry, index) =>
      index < 5
        ? {
            ...entry,
            subjects: [
              {
                ...entry.subjects[0],
                state: 'no_code',
                asset: null,
                assetDecimals: null,
                cashRaw: null,
              },
            ],
          }
        : entry,
    )
    expect(
      historicalCarryCashContext([...anchors, ...midnightBeforeDeployment], subject),
    ).toMatchObject({
      status: 'historical_context',
      gridLabel: '22:00 UTC daily / 30 days',
      anchorCount: 30,
      sampleCount: 15,
    })
    expect(historicalCarryCashContext(midnightBeforeDeployment, subject)).toMatchObject({
      status: 'unavailable',
      reason: 'subject_no_code',
    })
    const gap = historicalCarryCashContext(
      [...anchors, ...midnight.filter((_, index) => index !== 50)],
      subject,
    )
    expect(gap).toMatchObject({
      status: 'historical_context',
      gridLabel: '22:00 UTC daily / 30 days',
      sampleCount: 15,
    })
    expect(
      historicalCarryCashContext([...anchors.slice(0, 15), ...midnight.slice(0, 60)], subject),
    ).toMatchObject({ status: 'unavailable', reason: 'insufficient_daily_anchors' })
  })
})

describe('Q-relative aggregate cash stress', () => {
  const now = Date.parse('2026-09-30T23:00:00.000Z')
  const current = {
    ...anchors[29],
    collectionMode: 'current' as const,
    source: { ...anchors[29].source, blockAt: '2026-09-30T22:30:00.000Z' },
    subjects: [{ ...anchors[29].subjects[0], cashRaw: '1000000' }],
  }
  const freshContext = () =>
    historicalCarryCashContext(
      [...anchors, current],
      subject,
      Date.parse('2026-09-30T23:00:00.000Z'),
    )

  it('preserves exact identity and shows current cover or shortfall against Q', () => {
    const context = freshContext()
    const cover = projectAggregateCashStress24h(context, subject, '500000', now)
    expect(cover).toMatchObject({
      status: 'available',
      claim: 'aggregate_cash_proxy_only',
      routeKey: subject.route_key,
      destination: subject.destination,
      asset: subject.asset,
      requestedAssetsRaw: '500000',
      horizonHours: 24,
      sampleCount: 15,
      currentAfterRequestedRaw: '500000',
      p10ProjectedCashRaw: '1400000',
      p10AfterRequestedRaw: '900000',
      worstSampledProjectedCashRaw: '1200000',
      worstSampledAfterRequestedRaw: '700000',
      currentBlockHash: current.source.blockHash,
    })
    expect(projectAggregateCashStress24h(context, subject, '2000000', now)).toMatchObject({
      status: 'available',
      currentAfterRequestedRaw: '-1000000',
      p10AfterRequestedRaw: '-600000',
      worstSampledAfterRequestedRaw: '-800000',
    })
    expect(
      projectAggregateCashStress24h(
        context,
        { ...subject, asset: '0x' + 'b'.repeat(40) },
        '1',
        now,
      ),
    ).toMatchObject({ status: 'unavailable', reason: 'identity_mismatch' })
    expect(
      projectAggregateCashStress24h(
        context,
        { ...subject, destination: '0x' + 'b'.repeat(40) },
        '1',
        now,
      ),
    ).toMatchObject({ status: 'unavailable', reason: 'identity_mismatch' })
  })

  it('abstains for absent or stale current cash and invalid Q', () => {
    expect(
      projectAggregateCashStress24h(historicalCarryCashContext(anchors, subject), subject, '1'),
    ).toMatchObject({ status: 'unavailable', reason: 'current_cash_unavailable' })
    const stale = historicalCarryCashContext(
      [...anchors, current],
      subject,
      Date.parse('2026-10-01T03:00:00.000Z'),
    )
    expect(projectAggregateCashStress24h(stale, subject, '1')).toMatchObject({
      status: 'unavailable',
      reason: 'current_cash_stale',
    })
    expect(
      projectAggregateCashStress24h(freshContext(), subject, '1', now + 3 * 60 * 60 * 1000),
    ).toMatchObject({
      status: 'unavailable',
      reason: 'current_cash_stale',
    })
    for (const q of ['0', '-1', '1.5', '01', 'not-a-number', '']) {
      expect(projectAggregateCashStress24h(freshContext(), subject, q, now)).toMatchObject({
        status: 'unavailable',
        reason: 'invalid_requested_assets',
      })
    }
    expect(
      projectAggregateCashStress24h(historicalCarryCashContext([], subject), subject, '1'),
    ).toMatchObject({ status: 'unavailable', reason: 'historical_context_unavailable' })
  })

  it('floors shifted aggregate cash at zero after negative historical net changes', () => {
    const negative = anchors.map((entry, index) => ({
      ...entry,
      subjects: [{ ...entry.subjects[0], cashRaw: index % 2 === 0 ? '1000' : '0' }],
    }))
    const context = historicalCarryCashContext(
      [...negative, { ...current, subjects: [{ ...current.subjects[0], cashRaw: '400' }] }],
      subject,
      Date.parse('2026-09-30T23:00:00.000Z'),
    )
    expect(projectAggregateCashStress24h(context, subject, '500', now)).toMatchObject({
      status: 'available',
      currentAfterRequestedRaw: '-100',
      p10ProjectedCashRaw: '0',
      p10AfterRequestedRaw: '-500',
      worstSampledProjectedCashRaw: '0',
      worstSampledAfterRequestedRaw: '-500',
    })
  })

  it('keeps exact raw precision above JavaScript safe integer range', () => {
    const cashRaw = '100000000000000000000000000000000000000000000'
    const q = '99999999999999999999999999999999999999999999'
    const context = freshContext()
    expect(context.status).toBe('historical_context')
    if (context.status !== 'historical_context') return
    const stress = projectAggregateCashStress24h(
      { ...context, current: { ...context.current!, cashRaw } },
      subject,
      q,
      now,
    )
    expect(stress).toMatchObject({
      status: 'available',
      requestedAssetsRaw: q,
      currentAfterRequestedRaw: '1',
      p10AfterRequestedRaw: '400001',
      worstSampledAfterRequestedRaw: '200001',
    })
  })
})
