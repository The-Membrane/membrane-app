import { describe, expect, it } from 'vitest'

import { checkedLocalRouteCashSamples } from '@/lib/carry/localForecastReads'

const subject = {
  route_key: 'USDC → supply on Aave V3',
  destination: `0x${'a'.repeat(40)}`,
  asset: `0x${'b'.repeat(40)}`,
}
const blockHash = `0x${'c'.repeat(64)}`
const at = '2026-09-30T22:00:00.000Z'
const received = '2026-09-30T22:01:00.000Z'

function receipt(overrides: Record<string, unknown> = {}) {
  const row = {
    routeKey: subject.route_key,
    destination: subject.destination,
    asset: subject.asset,
    assetDecimals: 6,
    cashRaw: '123000000',
    state: 'observed',
    block: '100',
    blockHash,
    blockAt: at,
    collectionMode: 'current',
    evidenceKind: 'current_finalized_observation',
    firstLocalReceiptAt: received,
    ...(overrides.row as object),
  }
  return {
    collectionMode: 'current',
    evidenceKind: 'current_finalized_observation',
    firstLocalReceiptAt: received,
    source: { chainId: 1, block: '100', blockHash, blockAt: at },
    subjects: [row],
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'row')),
  }
}

describe('verified local current cash forecast adapter', () => {
  it('uses only exact current receipts, preserving token units and first receipt time', () => {
    const retrospective = receipt({
      collectionMode: 'retrospective',
      row: { collectionMode: 'retrospective', cashRaw: '999999999999' },
    })
    const result = checkedLocalRouteCashSamples([retrospective, receipt()], subject)
    expect(result).toEqual({
      status: 'available',
      assetDecimals: 6,
      samples: [
        {
          block: 100,
          observedAt: at,
          firstAvailableAt: received,
          sourceId: `100:${blockHash}:${subject.destination}`,
          coverage: 'complete',
          cashUnits: 123,
        },
      ],
    })
  })

  it('does not turn a current unassessed or undeployed subject into zero cash', () => {
    expect(
      checkedLocalRouteCashSamples(
        [receipt({ row: { state: 'unassessed', cashRaw: null } })],
        subject,
      ),
    ).toEqual({ status: 'unavailable', reason: 'subject_unassessed' })
    expect(
      checkedLocalRouteCashSamples(
        [receipt({ row: { state: 'no_code', cashRaw: null } })],
        subject,
      ),
    ).toEqual({ status: 'unavailable', reason: 'subject_no_code' })
  })

  it('fails closed on exact identity, block provenance, decimals, and receipt time', () => {
    for (const corrupt of [
      { row: { asset: subject.destination } },
      { row: { destination: `0x${'d'.repeat(40)}` } },
      { row: { blockHash: `0x${'d'.repeat(64)}` } },
      { row: { assetDecimals: 37 } },
      { row: { cashRaw: '-1' } },
      { firstLocalReceiptAt: '2026-09-30T21:59:00.000Z' },
      { row: { collectionMode: 'retrospective' } },
    ]) {
      expect(checkedLocalRouteCashSamples([receipt(corrupt)], subject)).toEqual({
        status: 'unavailable',
        reason: 'cash_identity_unverified',
      })
    }
  })

  it('does not accept an old cash point after the current receipt turns unassessed', () => {
    const later = receipt({
      firstLocalReceiptAt: '2026-09-30T23:01:00.000Z',
      source: {
        chainId: 1,
        block: '101',
        blockHash,
        blockAt: '2026-09-30T23:00:00.000Z',
      },
      row: {
        state: 'unassessed',
        cashRaw: null,
        block: '101',
        blockAt: '2026-09-30T23:00:00.000Z',
        firstLocalReceiptAt: '2026-09-30T23:01:00.000Z',
      },
    })
    expect(checkedLocalRouteCashSamples([receipt(), later], subject)).toEqual({
      status: 'unavailable',
      reason: 'subject_unassessed',
    })
  })
})
