import { describe, expect, it, vi } from 'vitest'

import {
  aggregateHolderExitEvidence,
  readLocalHolderExitEvidence,
  type HolderEvidenceIssue,
  type HolderEvidenceScore,
} from '@/lib/carry/localHolderExitEvidence'
const STUSDS_ROUTE_KEY = 'USDS → StUsds [USDS]'
const STUSDS_VAULT = '0x99cd4ec3f88a45940936f469e4bb72a2a701eeb9'
const USDS_ASSET = '0xdc035d45d973e3ec169d2276ddab16f1e407384f'

const fixtures = vi.hoisted(() => ({ issues: [] as unknown[], scores: [] as unknown[] }))

vi.mock('@/scripts/research/carry-public-stusds-exit-issue.mjs', () => ({
  verifyStusdsIssues: async () => fixtures.issues,
}))
vi.mock('@/scripts/research/carry-public-stusds-exit-score.mjs', () => ({
  verifyStusdsScores: async () => fixtures.scores,
}))
vi.mock('@/scripts/research/carry-public-sgho-exit-issue.mjs', () => {
  throw Error('unrelated_sgho_ledger_unavailable')
})

describe('STUSDS local holder evidence', () => {
  it('serves only its verified route ledger and exposes no empty-state holder detail', async () => {
    const result = await readLocalHolderExitEvidence(STUSDS_ROUTE_KEY, STUSDS_VAULT)
    expect(result).toMatchObject({
      status: 'unavailable',
      routeKey: STUSDS_ROUTE_KEY,
      destination: STUSDS_VAULT,
      calibratedForecast: false,
      cells: [],
    })
    expect(JSON.stringify(result)).not.toMatch(/holder|assetsRaw|targetAtUtc|private/i)
  })

  it('shows an unsealed overdue gap as missing, then pending within the capture window, without private detail', async () => {
    const holder = '0x' + 'd'.repeat(40)
    fixtures.issues = [
      {
        sequence: 1,
        sha256: 'a'.repeat(64),
        routeKey: STUSDS_ROUTE_KEY,
        destination: STUSDS_VAULT,
        originalAsset: USDS_ASSET,
        candidate: { holder },
        issuedAtUtc: '2026-09-30T00:00:00.000Z',
        baseline: { assetDecimals: 18 },
        horizonsHours: [1],
        targets: [
          {
            horizonHours: 1,
            targetAtUtc: '2026-09-30T01:00:00.000Z',
            captureDeadlineUtc: '2026-09-30T03:00:00.000Z',
          },
        ],
        cases: [
          {
            label: 'holder_sentinel',
            assetsRaw: '1000000',
            status: 'measured',
            measurement: { baselineStatus: 'success' },
          },
        ],
      },
    ]
    try {
      const result = await readLocalHolderExitEvidence(STUSDS_ROUTE_KEY, STUSDS_VAULT)
      expect(result).toMatchObject({
        status: 'available',
        cells: [{ horizonHours: 1, issued: 1, outcomePending: 0, outcomeMissing: 1 }],
      })
      const target = (
        fixtures.issues[0] as {
          targets: { targetAtUtc: string; captureDeadlineUtc: string }[]
        }
      ).targets[0]
      target.targetAtUtc = new Date(Date.now() - 30 * 60_000).toISOString()
      target.captureDeadlineUtc = new Date(Date.now() + 90 * 60_000).toISOString()
      const withinWindow = await readLocalHolderExitEvidence(STUSDS_ROUTE_KEY, STUSDS_VAULT)
      expect(withinWindow).toMatchObject({
        cells: [{ horizonHours: 1, issued: 1, outcomePending: 1, outcomeMissing: 0 }],
      })
      expect(JSON.stringify(result)).not.toMatch(/0xdddd|1000000|holder_sentinel|targetAtUtc/)
    } finally {
      fixtures.issues = []
    }
  })

  it('counts sampled recovery from a covered baseline revert outside the eligible denominator', async () => {
    const targetAtUtc = '2026-09-30T01:00:00.000Z'
    const captureDeadlineUtc = '2026-09-30T03:00:00.000Z'
    fixtures.issues = [
      {
        sequence: 1,
        sha256: 'a'.repeat(64),
        routeKey: STUSDS_ROUTE_KEY,
        destination: STUSDS_VAULT,
        originalAsset: USDS_ASSET,
        issuedAtUtc: '2026-09-30T00:00:00.000Z',
        baseline: { assetDecimals: 18 },
        horizonsHours: [1],
        targets: [{ horizonHours: 1, targetAtUtc, captureDeadlineUtc }],
        cases: [
          {
            label: 'impaired_q',
            assetsRaw: '1000000',
            status: 'measured',
            measurement: { baselineStatus: 'covered_revert' },
          },
        ],
      },
    ]
    fixtures.scores = [
      {
        issueSequence: 1,
        issueSha256: 'a'.repeat(64),
        routeKey: STUSDS_ROUTE_KEY,
        destination: STUSDS_VAULT,
        horizonHours: 1,
        targetAtUtc,
        onTime: true,
        cases: [
          {
            label: 'impaired_q',
            status: 'measured',
            onTime: true,
            outcome: 'simulated_withdraw_success',
            transition: 'simulated_recovery',
          },
        ],
      },
    ]
    try {
      const result = await readLocalHolderExitEvidence(STUSDS_ROUTE_KEY, STUSDS_VAULT)
      expect(result.cells).toMatchObject([
        {
          baselineEligible: 0,
          baselineImpaired: 1,
          impairedOnTimeMeasured: 1,
          impairedSimulatedRecovery: 1,
          onTimeMeasured: 0,
        },
      ])
    } finally {
      fixtures.issues = []
      fixtures.scores = []
    }
  })

  it('separates sampled recovery and censoring for covered baseline reverts', () => {
    const targetAtUtc = '2026-09-30T01:00:00.000Z'
    const issue: HolderEvidenceIssue = {
      sequence: 1,
      sha256: 'a'.repeat(64),
      routeKey: STUSDS_ROUTE_KEY,
      destination: STUSDS_VAULT,
      originalAsset: USDS_ASSET,
      issuedAtUtc: '2026-09-30T00:00:00.000Z',
      baseline: { assetDecimals: 18 },
      horizonsHours: [1],
      targets: [{ horizonHours: 1, targetAtUtc, captureDeadlineUtc: '2026-09-30T03:00:00.000Z' }],
      cases: ['recovery_q', 'censored_q'].map((label, index) => ({
        label,
        assetsRaw: index === 0 ? '1000000' : '2000000',
        status: 'measured',
        measurement: { baselineStatus: 'covered_revert' },
      })),
    }
    const score: HolderEvidenceScore = {
      issueSequence: 1,
      issueSha256: issue.sha256,
      routeKey: STUSDS_ROUTE_KEY,
      destination: STUSDS_VAULT,
      horizonHours: 1,
      targetAtUtc,
      onTime: true,
      cases: [
        {
          label: 'recovery_q',
          status: 'measured',
          onTime: true,
          outcome: 'simulated_withdraw_success',
          transition: 'simulated_recovery',
        },
        { label: 'censored_q', status: 'unavailable', transition: 'censored' },
      ],
    }
    const cells = aggregateHolderExitEvidence(STUSDS_ROUTE_KEY, STUSDS_VAULT, [
      { issues: [issue], scores: [score] },
    ])
    expect(cells.find((cell) => cell.qLabel === 'recovery_q')).toMatchObject({
      baselineEligible: 0,
      baselineImpaired: 1,
      impairedOnTimeMeasured: 1,
      impairedSimulatedRecovery: 1,
      onTimeMeasuredSuccess: 0,
    })
    expect(cells.find((cell) => cell.qLabel === 'censored_q')).toMatchObject({
      baselineEligible: 0,
      baselineImpaired: 1,
      impairedOutcomeUnavailable: 1,
      impairedSimulatedRecovery: 0,
      onTimeMeasuredSuccess: 0,
    })
  })
})
