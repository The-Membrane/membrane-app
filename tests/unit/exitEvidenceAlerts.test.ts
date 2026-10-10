import { describe, expect, it } from 'vitest'

import {
  EXIT_EVIDENCE_QUERIES,
  readExitEvidenceAlerts,
  verifiedExitPair,
} from '@/lib/carry/exitEvidenceAlerts'

const H = `0x${'a'.repeat(40)}`
const D = `0x${'b'.repeat(40)}`
const hash = (digit: string) => `0x${digit.repeat(64)}`
const checksum = 'c'.repeat(64)

function row(overrides: Record<string, unknown> = {}) {
  return {
    ledger: 'usd3',
    issue_id: '1',
    outcome_issue_id: '1',
    issue_status: 'issued',
    issue_simulation: 'success',
    route_key: 'USDC → USD3 [USDC]',
    outcome_route_key: 'USDC → USD3 [USDC]',
    destination: D,
    outcome_destination: D,
    issue_holder: H,
    outcome_holder: H,
    issue_assets_raw: '100',
    outcome_assets_raw: '100',
    baseline_block: '100',
    baseline_hash: hash('1'),
    baseline_block_at: '2026-09-29T10:00:00.000Z',
    baseline_observed_at: '2026-09-29T10:01:00.000Z',
    issued_at: '2026-09-29T10:05:00.000Z',
    target_at: '2026-09-29T11:05:00.000Z',
    issue_checksum: checksum,
    outcome_status: 'evm_revert',
    outcome_block: '110',
    outcome_hash: hash('2'),
    outcome_block_at: '2026-09-29T11:06:00.000Z',
    outcome_observed_at: '2026-09-29T11:06:30.000Z',
    outcome_recorded_at: '2026-09-29T11:07:00.000Z',
    outcome_checksum: checksum,
    holder_shares_raw: '100',
    preview_shares_raw: '10',
    shares_burned_raw: null,
    ...overrides,
  }
}

function recovery(overrides: Record<string, unknown> = {}) {
  return row({
    issue_id: '2',
    outcome_issue_id: '2',
    baseline_block: '120',
    baseline_hash: hash('3'),
    baseline_block_at: '2026-09-29T12:00:00.000Z',
    baseline_observed_at: '2026-09-29T12:01:00.000Z',
    issued_at: '2026-09-29T12:05:00.000Z',
    target_at: '2026-09-29T13:05:00.000Z',
    outcome_status: 'success',
    outcome_block: '130',
    outcome_hash: hash('4'),
    outcome_block_at: '2026-09-29T13:06:00.000Z',
    outcome_observed_at: '2026-09-29T13:06:30.000Z',
    outcome_recorded_at: '2026-09-29T13:07:00.000Z',
    shares_burned_raw: '9',
    ...overrides,
  })
}

describe('sampled exit evidence', () => {
  it('uses only four fixed bounded ledger reads', () => {
    expect(EXIT_EVIDENCE_QUERIES).toHaveLength(4)
    expect(EXIT_EVIDENCE_QUERIES.every((query) => query.includes('LIMIT 200'))).toBe(true)
    expect(
      EXIT_EVIDENCE_QUERIES.every((query) => query.includes("i.issue_simulation = 'success'")),
    ).toBe(true)
  })

  it('binds route, holder, Q, checksums, both finalized block identities, and coverage', () => {
    expect(verifiedExitPair(row())?.outcomeStatus).toBe('evm_revert')
    expect(verifiedExitPair(row({ issue_simulation: 'evm_revert' }))).toBeNull()
    expect(verifiedExitPair(row({ outcome_holder: D }))).toBeNull()
    expect(verifiedExitPair(row({ outcome_assets_raw: '101' }))).toBeNull()
    expect(verifiedExitPair(row({ outcome_destination: H }))).toBeNull()
    expect(verifiedExitPair(row({ outcome_hash: null }))).toBeNull()
    expect(verifiedExitPair(row({ outcome_block: '100' }))).toBeNull()
    expect(verifiedExitPair(row({ outcome_block_at: '2026-09-29T12:00:00.000Z' }))).toBeNull()
    expect(verifiedExitPair(row({ issue_checksum: 'bad' }))).toBeNull()
    expect(verifiedExitPair(row({ holder_shares_raw: '9' }))).toBeNull()
    expect(verifiedExitPair(row({ outcome_status: 'missing' }))).toBeNull()
    expect(verifiedExitPair(row({ outcome_status: 'position_insufficient' }))).toBeNull()
  })

  it('requires direct and Morpho holder coverage and successful burned-share evidence', () => {
    expect(verifiedExitPair(row({ ledger: 'morpho', holder_coverage_raw: '99' }))).toBeNull()
    expect(
      verifiedExitPair(
        row({
          ledger: 'direct',
          holder_coverage_raw: '100',
          target_at: '2026-09-29T11:00:00.000Z',
        }),
      ),
    ).not.toBeNull()
    expect(verifiedExitPair(recovery({ shares_burned_raw: null }))).toBeNull()
    expect(verifiedExitPair(recovery({ shares_burned_raw: '101' }))).toBeNull()
    expect(
      verifiedExitPair(recovery({ preview_shares_raw: '101', shares_burned_raw: '9' })),
    ).not.toBeNull()
  })

  it('emits only sampled losses and later same-subject clean recovery', async () => {
    const batches = [[], [], [], [row(), recovery()]]
    let index = 0
    const feed = await readExitEvidenceAlerts(async () => batches[index++]!, { limit: 10 })
    expect(feed.alerts).toHaveLength(1)
    expect(feed.alerts[0]).toMatchObject({
      kind: 'sampled_exit_loss',
      scope: 'one_sampled_holder_and_amount',
      assetsRaw: '100',
      outcome: 'holder_covered_evm_revert',
      recovery: {
        status: 'later_same_holder_amount_success',
        issueId: '2',
        observation: 'baseline',
      },
      duration: 'interval_censored',
    })
    expect(feed.futureExitForecast).toBe(false)
    expect(feed.likelyDuration).toBe('unavailable')
  })

  it('leaves recovery unavailable for a different Q, but accepts later successful outcome from an earlier baseline', async () => {
    const batches = [
      [],
      [],
      [],
      [row(), recovery({ issue_assets_raw: '101', outcome_assets_raw: '101' })],
    ]
    let index = 0
    const feed = await readExitEvidenceAlerts(async () => batches[index++]!, { limit: 10 })
    expect(feed.alerts[0].recovery).toBeNull()
    expect(feed.alerts[0].duration).toBe('unavailable')

    const earlySuccess = recovery({
      baseline_block: '105',
      baseline_block_at: '2026-09-29T10:30:00.000Z',
      baseline_observed_at: '2026-09-29T10:31:00.000Z',
      issued_at: '2026-09-29T10:35:00.000Z',
      target_at: '2026-09-29T11:35:00.000Z',
      outcome_block: '115',
      outcome_block_at: '2026-09-29T11:36:00.000Z',
      outcome_observed_at: '2026-09-29T11:36:30.000Z',
      outcome_recorded_at: '2026-09-29T11:37:00.000Z',
    })
    index = 0
    const beforeLoss = [[], [], [], [row(), earlySuccess]]
    const earlier = await readExitEvidenceAlerts(async () => beforeLoss[index++]!, { limit: 10 })
    expect(earlier.alerts[0].recovery).toMatchObject({
      issueId: '2',
      observation: 'followup',
      observedRecoveryWindow: {
        afterLossAt: '2026-09-29T11:06:00.000Z',
        bySuccessAt: '2026-09-29T11:36:00.000Z',
      },
    })
  })

  it('counts a later successful baseline even when its H1 follow-up reverts or is pending', async () => {
    const laterRevert = recovery({
      outcome_status: 'evm_revert',
      shares_burned_raw: null,
    })
    let index = 0
    const withRevert = [[], [], [], [row(), laterRevert]]
    const first = await readExitEvidenceAlerts(async () => withRevert[index++]!, { limit: 10 })
    expect(first.alerts.find((alert) => alert.issueId === '1')?.recovery).toMatchObject({
      issueId: '2',
      observation: 'baseline',
    })

    index = 0
    const pending = [
      [],
      [],
      [],
      [
        row(),
        recovery({
          outcome_status: null,
          outcome_block: null,
          outcome_hash: null,
          outcome_block_at: null,
          outcome_observed_at: null,
          outcome_recorded_at: null,
          outcome_issue_id: null,
          outcome_checksum: null,
          shares_burned_raw: null,
        }),
      ],
    ]
    const second = await readExitEvidenceAlerts(async () => pending[index++]!, { limit: 10 })
    expect(second.alerts[0].recovery).toMatchObject({ issueId: '2', observation: 'baseline' })
  })

  it('filters exact request tuple and rejects unbounded provider results', async () => {
    let index = 0
    const batches = [[], [], [], [row()]]
    const feed = await readExitEvidenceAlerts(async () => batches[index++]!, {
      routeKey: 'USDC → USD3 [USDC]',
      destination: D,
      holder: H,
      assetsRaw: '101',
      limit: 1,
    })
    expect(feed.alerts).toEqual([])
    await expect(readExitEvidenceAlerts(async () => Array(201).fill(row()))).rejects.toThrow(
      'exit_evidence_query_shape_invalid',
    )
  })
})
