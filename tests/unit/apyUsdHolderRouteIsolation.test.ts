import { describe, expect, it, vi } from 'vitest'

import {
  aggregateApyUsdInitiationEvidence,
  readLocalHolderExitEvidence,
} from '@/lib/carry/localHolderExitEvidence'

const route = 'apxUSD → ApyUSD [apxUSD]'
const vault = '0x38eeb52f0771140d10c4e9a9a72349a329fe8a6a'
const fixtures = vi.hoisted(() => ({ issues: [] as unknown[], scores: [] as unknown[] }))

vi.mock('@/scripts/research/carry-public-apyusd-exit-issue.mjs', () => ({
  verifyApyUsdIssues: async () => fixtures.issues,
}))
vi.mock('@/scripts/research/carry-public-apyusd-exit-score.mjs', () => ({
  verifyApyUsdScores: async () => fixtures.scores,
}))
vi.mock('@/scripts/research/carry-public-sgho-exit-issue.mjs', () => {
  throw Error('unrelated_sgho_ledger_unavailable')
})

describe('ApyUSD receipt initiation evidence', () => {
  it('reads only its route ledger and gives final payout an explicit unmeasured state', async () => {
    const result = await readLocalHolderExitEvidence(route, vault)
    expect(result).toMatchObject({
      status: 'unavailable',
      calibratedForecast: false,
      cells: [],
      receiptInitiationEvidence: {
        scope: 'same_holder_withdraw_for_receipt_eth_call_only',
        finalPayoutAssessment: 'unmeasured_no_mined_receipt_in_study',
        cells: [],
      },
    })
  })

  it('never promotes an initiation simulation to a holder exit cell or leaks Q', async () => {
    const target = { horizonHours: 1, captureDeadlineUtc: '2026-10-02T03:00:00.000Z' }
    fixtures.issues = [
      {
        sequence: 1,
        sha256: 'a'.repeat(64),
        routeKey: route,
        destination: vault,
        holder: `0x${'e'.repeat(40)}`,
        targets: [target],
        cases: [{ assetsRaw: '123456789', baseline: { status: 'initiation_success' } }],
      },
    ]
    try {
      const result = await readLocalHolderExitEvidence(route, vault)
      expect(result).toMatchObject({
        cells: [],
        receiptInitiationEvidence: {
          cells: [{ horizonHours: 1, issued: 1, baselineCallable: 1, outcomePending: 1 }],
        },
      })
      expect(JSON.stringify(result)).not.toMatch(/123456789|0xeeee|targetAtUtc/)
      const counts = aggregateApyUsdInitiationEvidence(
        route,
        vault,
        fixtures.issues as never,
        [],
        Date.parse('2026-10-03T00:00:00Z'),
      )
      expect(counts[0].outcomeMissing).toBe(1)
    } finally {
      fixtures.issues = []
    }
  })
})
