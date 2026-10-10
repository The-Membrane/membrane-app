import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it, vi } from 'vitest'

import { readCashIssueEvidence } from '@/pages/api/carry/forecast'

const question = {
  routeKey: 'USDC → supply on Aave V3',
  destination: '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c',
  asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  source: 'market' as const,
  horizonHours: 1,
}

const aggregate = {
  attempts_total: '6',
  issued_count: '3',
  source_unavailable_count: '1',
  source_invalid_count: '1',
  unassessed_count: '1',
  observed_count: '1',
  censored_missing_count: '1',
  pending_count: '1',
  first_issued_at: '2026-09-29T09:35:00.000Z',
  latest_issued_at: '2026-09-29T10:05:00.000Z',
}

describe('Carry prospective cash baseline evidence', () => {
  it('counts only the exact route, destination, asset, source, venue kind and H1 horizon', async () => {
    let captured: SQL | undefined
    const evidence = await readCashIssueEvidence(question, async (query) => {
      captured = query
      return { rows: [aggregate] }
    })
    expect(evidence).toEqual({
      status: 'available',
      kind: 'prospective_aggregate_cash_persistence_baseline',
      horizonHours: 1,
      attempts: {
        total: 6,
        issued: 3,
        sourceUnavailable: 1,
        sourceInvalid: 1,
        unassessed: 1,
      },
      outcomes: { observed: 1, censoredMissing: 1, pending: 1 },
      firstIssuedAt: '2026-09-29T09:35:00.000Z',
      latestIssuedAt: '2026-09-29T10:05:00.000Z',
    })
    const rendered = new PgDialect().sqlToQuery(captured!)
    expect(rendered.sql).toMatch(
      /FROM carry_cash_issue_attempts i\s+LEFT JOIN carry_cash_issue_scores s/,
    )
    expect(rendered.sql).toContain('i.source_venue_kind IS NOT DISTINCT FROM')
    expect(rendered.sql).toContain("i.slot_at >= '2026-09-29 09:30:00+00'::timestamptz")
    expect(rendered.params).toEqual([
      question.routeKey,
      question.destination,
      question.asset,
      question.source,
      'aave_v3_atoken',
      1,
    ])
    expect(JSON.stringify(evidence)).not.toMatch(/validated|holderExit|cashRaw/)
  })

  it('uses H24, but marks other horizons as unenrolled without touching the ledger', async () => {
    const execute = vi.fn(async () => ({ rows: [aggregate] }))
    expect(await readCashIssueEvidence({ ...question, horizonHours: 24 }, execute)).toMatchObject({
      status: 'available',
      horizonHours: 24,
    })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(await readCashIssueEvidence({ ...question, horizonHours: 2 }, execute)).toEqual({
      status: 'not_enrolled',
      enrolledHorizonsHours: [1, 24],
    })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('reports Twyne as unassessed without an issued or scored claim', async () => {
    const twyne = await readCashIssueEvidence(
      {
        routeKey: 'USDC → Twyne [USDC]',
        destination: '0x0af56afbddcb140323445bd7211ba90e54e5fd1c',
        asset: question.asset,
        source: 'vault',
        horizonHours: 1,
      },
      async () => ({
        rows: [
          {
            ...aggregate,
            attempts_total: '2',
            issued_count: '0',
            source_unavailable_count: '0',
            source_invalid_count: '0',
            unassessed_count: '2',
            observed_count: '0',
            censored_missing_count: '0',
            pending_count: '0',
            first_issued_at: null,
            latest_issued_at: null,
          },
        ],
      }),
    )
    expect(twyne).toMatchObject({
      status: 'available',
      attempts: { issued: 0, unassessed: 2 },
      outcomes: { observed: 0, censoredMissing: 0, pending: 0 },
      firstIssuedAt: null,
      latestIssuedAt: null,
    })
  })

  it('fails closed when the ledger is absent or counts are inconsistent', async () => {
    const unavailable = { status: 'unavailable', reason: 'ledger_unavailable' }
    expect(
      await readCashIssueEvidence(question, async () => {
        throw new Error('relation does not exist')
      }),
    ).toEqual(unavailable)
    expect(
      await readCashIssueEvidence(question, async () => ({
        rows: [{ ...aggregate, pending_count: '2' }],
      })),
    ).toEqual(unavailable)
    expect(
      await readCashIssueEvidence(question, async () => ({
        rows: [{ ...aggregate, issued_count: '9007199254740992' }],
      })),
    ).toEqual(unavailable)
  })
})
