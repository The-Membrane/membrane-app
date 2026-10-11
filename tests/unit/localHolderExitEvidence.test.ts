import { describe, expect, it } from 'vitest'

import {
  aggregateUmbrellaRedeemEvidence,
  aggregateHolderExitEvidence,
  aggregateStakedUsdatQueueRequestEvidence,
  normalizeMorphoV2Evidence,
  normalizeCompoundHolderEvidence,
  projectPublicHolderExitEvidence,
  type HolderEvidenceIssue,
  type HolderEvidenceScore,
} from '@/lib/carry/localHolderExitEvidence'
import { parseHolderEvidenceQuery } from '@/pages/api/carry/holder-exit-evidence'
import { STAKED_USDAT_ROUTE, STAKED_USDAT_VAULT } from '@/lib/carry/stakedUsdatExit'
import { UMBRELLA_GHO_ROUTE, UMBRELLA_STKGHO } from '@/lib/carry/umbrellaGhoExit'

const routeKey = 'GHO → sGho [GHO]'
const destination = '0x' + 'a'.repeat(40)
const qLabel = 'vault_0p01pct'
const issuedAtUtc = '2026-09-30T00:00:00.000Z'
const targetAtUtc = '2026-09-30T01:00:00.000Z'
const captureDeadlineUtc = '2026-09-30T03:00:00.000Z'
const issue = (overrides: Partial<HolderEvidenceIssue> = {}): HolderEvidenceIssue => ({
  sequence: 1,
  sha256: 'b'.repeat(64),
  routeKey,
  destination,
  originalAsset: '0x' + 'c'.repeat(40),
  baseline: { assetDecimals: 18 },
  issuedAtUtc,
  horizonsHours: [1],
  targets: [{ horizonHours: 1, targetAtUtc, captureDeadlineUtc }],
  cases: [
    {
      label: qLabel,
      assetsRaw: '100',
      status: 'measured',
      measurement: { baselineStatus: 'success' },
    },
    { label: 'duplicate_q', assetsRaw: null, status: 'omitted' },
    { label: 'unavailable_q', assetsRaw: '200', status: 'unavailable' },
    {
      label: 'ineligible_q',
      assetsRaw: '300',
      status: 'measured',
      measurement: { baselineStatus: 'covered_revert' },
    },
  ],
  ...overrides,
})
const score = (overrides: Partial<HolderEvidenceScore> = {}): HolderEvidenceScore => ({
  issueSequence: 1,
  issueSha256: 'b'.repeat(64),
  routeKey,
  destination,
  horizonHours: 1,
  targetAtUtc,
  onTime: true,
  cases: [
    { label: qLabel, status: 'measured', outcome: 'simulated_withdraw_success' },
    { label: 'duplicate_q', status: 'ineligible' },
    { label: 'unavailable_q', status: 'ineligible' },
    { label: 'ineligible_q', status: 'ineligible' },
  ],
  ...overrides,
})

describe('Umbrella holder evidence disclosure', () => {
  const holder = '0x' + 'd'.repeat(40)
  const privateIssue = {
    sequence: 1,
    sha256: 'a'.repeat(64),
    routeKey: UMBRELLA_GHO_ROUTE,
    destination: UMBRELLA_STKGHO,
    holder,
    measurement: { gate: 'waiting', outcome: 'evm_revert' as const },
    targets: [{ horizonHours: 1, deadlineUtc: '2026-10-01T03:00:00.000Z' }],
  }

  it('keeps repeated episodes separate from the distinct holder count and private identity', () => {
    const cells = aggregateUmbrellaRedeemEvidence(
      UMBRELLA_GHO_ROUTE,
      UMBRELLA_STKGHO,
      [privateIssue, { ...privateIssue, sequence: 2, sha256: 'b'.repeat(64) }],
      [],
      Date.parse('2026-10-02T00:00:00.000Z'),
    )
    expect(cells).toMatchObject([
      { horizonHours: 1, issued: 2, distinctHolders: 1, missed: 0, pending: 2 },
    ])
    expect(JSON.stringify(cells)).not.toContain(holder)
  })
})

describe('Staked USDat queue request evidence', () => {
  const privateIssue = {
    sequence: 1,
    sha256: 'a'.repeat(64),
    routeKey: STAKED_USDAT_ROUTE,
    destination: STAKED_USDAT_VAULT,
    holder: '0x' + 'b'.repeat(40),
    sharesRaw: '10000000000000000000',
    measurement: { outcome: 'evm_revert' as const },
    targets: [
      { horizonHours: 1, deadlineUtc: '2026-10-01T03:00:00.000Z' },
      { horizonHours: 4, deadlineUtc: '2026-10-01T06:00:00.000Z' },
    ],
  }

  it('publishes coarse request-call counts without holder, shares, or target clocks', () => {
    const cells = aggregateStakedUsdatQueueRequestEvidence(
      STAKED_USDAT_ROUTE,
      STAKED_USDAT_VAULT,
      [privateIssue],
      [
        {
          issueSequence: 1,
          issueSha256: privateIssue.sha256,
          horizonHours: 1,
          status: 'measured',
          transition: 'simulated_call_recovery',
        },
      ],
      Date.parse('2026-10-01T04:00:00.000Z'),
    )
    expect(cells).toEqual([
      expect.objectContaining({
        horizonHours: 1,
        issued: 1,
        baselineReverted: 1,
        onTimeStateScored: 1,
        requestCallMeasured: 1,
        simulatedCallRecovery: 1,
      }),
      expect.objectContaining({ horizonHours: 4, issued: 1, pending: 1 }),
    ])
    const publicJson = JSON.stringify(cells)
    expect(publicJson).not.toMatch(/sharesRaw|deadlineUtc|targetAtUtc|0x/i)
    expect(publicJson).not.toContain(privateIssue.holder)
    expect(publicJson).not.toContain(privateIssue.sharesRaw)
  })

  it('keeps missed capture and regime censorship out of request-call recovery', () => {
    const issue2 = {
      ...privateIssue,
      sequence: 2,
      sha256: 'c'.repeat(64),
      measurement: { outcome: 'success' as const },
      targets: [privateIssue.targets[0]],
    }
    const cells = aggregateStakedUsdatQueueRequestEvidence(
      STAKED_USDAT_ROUTE,
      STAKED_USDAT_VAULT,
      [privateIssue, issue2],
      [
        {
          issueSequence: 1,
          issueSha256: privateIssue.sha256,
          horizonHours: 1,
          status: 'measured',
          transition: 'regime_change_censored',
        },
        {
          issueSequence: 2,
          issueSha256: issue2.sha256,
          horizonHours: 1,
          status: 'missed_deadline',
          transition: 'missing',
        },
      ],
      Date.parse('2026-10-01T04:00:00.000Z'),
    )
    expect(cells[0]).toMatchObject({
      issued: 2,
      baselineReverted: 1,
      baselineCallable: 1,
      onTimeStateScored: 1,
      requestCallMeasured: 0,
      regimeChangeCensored: 1,
      missed: 1,
      simulatedCallRecovery: 0,
    })
    expect(() =>
      aggregateStakedUsdatQueueRequestEvidence(
        STAKED_USDAT_ROUTE,
        STAKED_USDAT_VAULT,
        [privateIssue],
        [
          {
            issueSequence: 1,
            issueSha256: 'wrong',
            horizonHours: 1,
            status: 'measured',
            transition: 'still_reverting',
          },
        ],
      ),
    ).toThrow(/mismatch/)
  })

  it('counts holder attrition as a scored state without claiming a request call', () => {
    const cells = aggregateStakedUsdatQueueRequestEvidence(
      STAKED_USDAT_ROUTE,
      STAKED_USDAT_VAULT,
      [privateIssue],
      [
        {
          issueSequence: 1,
          issueSha256: privateIssue.sha256,
          horizonHours: 1,
          status: 'measured',
          transition: 'holder_attrition',
        },
      ],
    )
    expect(cells[0]).toMatchObject({
      onTimeStateScored: 1,
      requestCallMeasured: 0,
      holderAttrition: 1,
    })
  })
})

describe('local public holder exit evidence aggregation', () => {
  it('keeps exact Q/H cells, reports denominator states, and exposes no holder or proof', () => {
    const cells = aggregateHolderExitEvidence(routeKey, destination, [
      { issues: [issue()], scores: [score()] },
    ])
    expect(cells).toHaveLength(4)
    expect(cells.find((cell) => cell.qLabel === qLabel)).toMatchObject({
      horizonHours: 1,
      issued: 1,
      baselineEligible: 1,
      onTimeMeasured: 1,
      onTimeMeasuredSuccess: 1,
      onTimeMeasuredNonSuccess: 0,
      distinctIssueEpisodes: 1,
      firstIssuedAtUtc: issuedAtUtc,
      lastTargetAtUtc: targetAtUtc,
    })
    expect(cells.find((cell) => cell.qLabel === 'duplicate_q')).toMatchObject({
      issued: 0,
      omitted: 1,
    })
    expect(cells.find((cell) => cell.qLabel === 'unavailable_q')).toMatchObject({
      issued: 1,
      baselineUnavailable: 1,
    })
    expect(cells.find((cell) => cell.qLabel === 'ineligible_q')).toMatchObject({
      issued: 1,
      baselineIneligible: 1,
    })
    expect(JSON.stringify(cells)).not.toMatch(/proof|candidate|address/i)
    expect(cells.find((cell) => cell.qLabel === qLabel)).toMatchObject({
      assetsRaw: '100',
      assetDecimals: 18,
    })
    expect(JSON.stringify(cells)).not.toContain('0x' + 'c'.repeat(40))
  })

  it('censors legacy impaired Q regardless of its exact case label', () => {
    const label = 'max_q'
    const cells = aggregateHolderExitEvidence(routeKey, destination, [
      {
        issues: [
          issue({
            cases: [
              {
                label,
                assetsRaw: '300',
                status: 'measured',
                measurement: { baselineStatus: 'covered_revert' },
              },
            ],
          }),
        ],
        scores: [
          score({
            cases: [{ label, status: 'ineligible', reason: 'baseline_not_success' }],
          }),
        ],
      },
    ])
    expect(cells[0]).toMatchObject({
      qLabel: label,
      baselineIneligible: 1,
      baselineImpaired: 1,
      impairedOutcomeUnavailable: 1,
      impairedSimulatedRecovery: 0,
      impairedStillReverting: 0,
    })
  })

  it('publishes only coarse route/horizon case counts and unique issue episodes', () => {
    const privateIssue = issue({
      cases: [
        {
          label: 'holder_near_claim_90pct',
          assetsRaw: '123456789123456789',
          status: 'measured',
          measurement: { baselineStatus: 'success' },
        },
        {
          label: 'holder_small_sentinel',
          assetsRaw: '987654321987654321',
          status: 'measured',
          measurement: { baselineStatus: 'success' },
        },
      ],
    })
    const study = { issues: [privateIssue], scores: [] }
    const exact = aggregateHolderExitEvidence(
      routeKey,
      destination,
      [study],
      Date.parse('2026-09-30T02:00:00.000Z'),
    )
    expect(exact).toHaveLength(2)
    const publicCells = projectPublicHolderExitEvidence(routeKey, destination, exact, [study])
    expect(publicCells).toEqual([
      expect.objectContaining({
        horizonHours: 1,
        issued: 2,
        baselineEligible: 2,
        outcomePending: 2,
        distinctIssueEpisodes: 1,
      }),
    ])
    const json = JSON.stringify(publicCells)
    expect(json).not.toMatch(/assetsRaw|qLabel|AtUtc|0x|holder_near_claim|holder_small_sentinel/)
    expect(json).not.toContain('123456789123456789')
    expect(json).not.toContain('987654321987654321')
    expect(json).not.toContain(issuedAtUtc)
  })

  it('does not pool the same ladder label at different frozen issue amounts', () => {
    const later = issue({
      sequence: 2,
      sha256: 'd'.repeat(64),
      issuedAtUtc: '2026-10-01T00:00:00.000Z',
      targets: [
        {
          horizonHours: 1,
          targetAtUtc: '2026-10-01T01:00:00.000Z',
          captureDeadlineUtc: '2026-10-01T03:00:00.000Z',
        },
      ],
      cases: [
        {
          label: qLabel,
          assetsRaw: '101',
          status: 'measured',
          measurement: { baselineStatus: 'success' },
        },
      ],
    })
    const cells = aggregateHolderExitEvidence(routeKey, destination, [
      { issues: [issue(), later], scores: [] },
    ])
    expect(cells.filter((cell) => cell.qLabel === qLabel).map((cell) => cell.assetsRaw)).toEqual([
      '100',
      '101',
    ])
    expect(
      cells.filter((cell) => cell.qLabel === qLabel).map((cell) => cell.distinctIssueEpisodes),
    ).toEqual([1, 1])
  })

  it('keeps pending, missing, and unavailable outcomes distinct', () => {
    const pending = aggregateHolderExitEvidence(
      routeKey,
      destination,
      [{ issues: [issue()], scores: [] }],
      Date.parse('2026-09-30T02:00:00.000Z'),
    )
    expect(pending.find((cell) => cell.qLabel === qLabel)?.outcomePending).toBe(1)
    const missing = aggregateHolderExitEvidence(
      routeKey,
      destination,
      [{ issues: [issue()], scores: [] }],
      Date.parse('2026-09-30T04:00:00.000Z'),
    )
    expect(missing.find((cell) => cell.qLabel === qLabel)?.outcomeMissing).toBe(1)
    const unavailable = aggregateHolderExitEvidence(routeKey, destination, [
      {
        issues: [issue()],
        scores: [
          score({
            onTime: false,
            cases: [
              { label: qLabel, status: 'unavailable' },
              { label: 'duplicate_q', status: 'ineligible' },
              { label: 'unavailable_q', status: 'ineligible' },
              { label: 'ineligible_q', status: 'ineligible' },
            ],
          }),
        ],
      },
    ])
    expect(unavailable.find((cell) => cell.qLabel === qLabel)?.outcomeUnavailable).toBe(1)
  })

  it('requires Compound supplied balance to cover exact Q even if withdraw simulation succeeds', () => {
    const compoundIssue = issue({
      cases: [
        {
          label: 'covered_q',
          assetsRaw: '100',
          status: 'measured',
          measurement: { status: 'success', holderCoverageRaw: '100' },
        },
        {
          label: 'debt_opening_q',
          assetsRaw: '200',
          status: 'measured',
          measurement: { status: 'success', holderCoverageRaw: '100' },
        },
      ],
    })
    const cells = aggregateHolderExitEvidence(
      routeKey,
      destination,
      [normalizeCompoundHolderEvidence([compoundIssue], [])],
      Date.parse('2026-09-30T02:00:00.000Z'),
    )
    expect(cells.find((cell) => cell.qLabel === 'covered_q')).toMatchObject({
      issued: 1,
      baselineEligible: 1,
      outcomePending: 1,
    })
    expect(cells.find((cell) => cell.qLabel === 'debt_opening_q')).toMatchObject({
      issued: 1,
      baselineIneligible: 1,
      baselineEligible: 0,
      outcomePending: 0,
    })
    expect(() =>
      normalizeCompoundHolderEvidence(
        [
          issue({
            cases: [
              {
                label: 'bad',
                assetsRaw: '100',
                status: 'measured',
                measurement: { status: 'success' },
              },
            ],
          }),
        ],
        [],
      ),
    ).toThrow(/baseline_invalid/)
  })

  it('separates observed success, unknown reverts, and holder attrition', () => {
    const run = (outcome: string) =>
      aggregateHolderExitEvidence(routeKey, destination, [
        {
          issues: [issue()],
          scores: [
            score({
              cases: [
                { label: qLabel, status: 'measured', outcome },
                { label: 'duplicate_q', status: 'ineligible' },
                { label: 'unavailable_q', status: 'ineligible' },
                { label: 'ineligible_q', status: 'ineligible' },
              ],
            }),
          ],
        },
      ]).find((cell) => cell.qLabel === qLabel)!
    expect(run('withdraw_revert_cause_unknown')).toMatchObject({
      onTimeMeasured: 1,
      onTimeMeasuredSuccess: 0,
      onTimeMeasuredNonSuccess: 1,
      onTimeUnknownRevert: 1,
      onTimeHolderAttrition: 0,
    })
    expect(run('holder_shares_zero')).toMatchObject({
      onTimeMeasuredNonSuccess: 1,
      onTimeUnknownRevert: 0,
      onTimeHolderAttrition: 1,
    })
    expect(run('preview_share_gap')).toMatchObject({
      onTimeMeasuredNonSuccess: 1,
      onTimePreviewGap: 1,
      onTimeHolderAttrition: 0,
    })
    expect(() => run('invented_outcome')).toThrow(/class_invalid/)
  })

  it('fails closed on mismatched issue SHA, target, case, or duplicate score', () => {
    const bad = (entry: HolderEvidenceScore) => () =>
      aggregateHolderExitEvidence(routeKey, destination, [{ issues: [issue()], scores: [entry] }])
    expect(bad(score({ issueSha256: 'c'.repeat(64) }))).toThrow(/mismatch/)
    expect(bad(score({ targetAtUtc: '2026-09-30T02:00:00.000Z' }))).toThrow(/mismatch/)
    expect(bad(score({ cases: [{ label: 'wrong', status: 'measured' }] }))).toThrow(/mismatch/)
    expect(() =>
      aggregateHolderExitEvidence(routeKey, destination, [
        { issues: [issue()], scores: [score(), score()] },
      ]),
    ).toThrow(/duplicate/)
  })

  it('requires exact route and contract address, with no extra query keys', () => {
    expect(
      parseHolderEvidenceQuery({
        routeKey,
        destination: destination.toUpperCase().replace('0X', '0x'),
      }),
    ).toEqual({
      routeKey,
      destination,
    })
    expect(parseHolderEvidenceQuery({ routeKey, destination, holder: destination })).toBeNull()
    expect(parseHolderEvidenceQuery({ routeKey, destination: 'bad' })).toBeNull()
    expect(parseHolderEvidenceQuery({ routeKey: [routeKey], destination })).toBeNull()
  })

  it('normalizes sparse Morpho v2 per-Q scores without inventing outcomes for other Qs', () => {
    const v2Issue = {
      sequence: 1,
      sha256: 'd'.repeat(64),
      routeKey,
      destination,
      asset: '0x' + 'c'.repeat(40),
      issuedAtUtc,
      horizonsHours: [1, 24],
      targets: [
        { horizonHours: 1, targetAtUtc, captureDeadlineUtc },
        {
          horizonHours: 24,
          targetAtUtc: '2026-10-01T00:00:00.000Z',
          captureDeadlineUtc: '2026-10-01T02:00:00.000Z',
        },
      ],
      baseline: { assetDecimals: 18 },
      cases: [
        {
          label: 'holder_small_sentinel',
          assetsRaw: '100',
          baselineStatus: 'simulated_withdraw_success',
        },
        {
          label: 'holder_near_claim_90pct',
          assetsRaw: '900',
          baselineStatus: 'simulated_withdraw_success',
        },
        { label: 'largest_vault_tier_within_claim', assetsRaw: null, baselineStatus: 'omitted' },
      ],
    }
    const v2Score = {
      issueSequence: 1,
      issueSha256: v2Issue.sha256,
      routeKey,
      destination,
      caseLabel: 'holder_small_sentinel',
      assetsRaw: '100',
      horizonHours: 1,
      targetAtUtc,
      captureDeadlineUtc,
      scoredAtUtc: '2026-09-30T02:00:00.000Z',
      baselineStatus: 'simulated_withdraw_success',
      transition: 'new_revert',
      outcome: 'covered_revert_cause_unknown',
    }
    const normalized = normalizeMorphoV2Evidence([v2Issue], [v2Score])
    const cells = aggregateHolderExitEvidence(
      routeKey,
      destination,
      [normalized],
      Date.parse('2026-09-30T04:00:00.000Z'),
    )
    expect(
      cells.find((cell) => cell.qLabel === 'holder_small_sentinel' && cell.horizonHours === 1),
    ).toMatchObject({ issued: 1, baselineEligible: 1, onTimeMeasured: 1, onTimeUnknownRevert: 1 })
    expect(
      cells.find((cell) => cell.qLabel === 'holder_near_claim_90pct' && cell.horizonHours === 1),
    ).toMatchObject({ issued: 1, baselineEligible: 1, outcomeMissing: 1 })
    expect(
      cells.find((cell) => cell.qLabel === 'holder_near_claim_90pct' && cell.horizonHours === 24),
    ).toMatchObject({ issued: 1, baselineEligible: 1, outcomePending: 1 })
    expect(
      cells.find(
        (cell) => cell.qLabel === 'largest_vault_tier_within_claim' && cell.horizonHours === 1,
      ),
    ).toMatchObject({ issued: 0, omitted: 1 })
    expect(() => normalizeMorphoV2Evidence([v2Issue], [v2Score, v2Score])).toThrow(/duplicate/)
    expect(() => normalizeMorphoV2Evidence([v2Issue], [{ ...v2Score, assetsRaw: '101' }])).toThrow(
      /binding/,
    )
    const censored = {
      ...v2Score,
      caseLabel: 'holder_near_claim_90pct',
      assetsRaw: '900',
      scoredAtUtc: '2026-09-30T04:00:00.000Z',
      transition: 'censored',
      outcome: 'censored_capture_window_missed',
    }
    const withCensor = aggregateHolderExitEvidence(
      routeKey,
      destination,
      [normalizeMorphoV2Evidence([v2Issue], [v2Score, censored])],
      Date.parse('2026-09-30T04:00:00.000Z'),
    )
    expect(
      withCensor.find(
        (cell) => cell.qLabel === 'holder_near_claim_90pct' && cell.horizonHours === 1,
      ),
    ).toMatchObject({ outcomeUnavailable: 1, outcomeMissing: 0 })
    expect(() =>
      normalizeMorphoV2Evidence(
        [v2Issue],
        [{ ...v2Score, scoredAtUtc: '2026-09-30T04:00:00.000Z' }],
      ),
    ).toThrow(/binding/)
    const previewGap = aggregateHolderExitEvidence(
      routeKey,
      destination,
      [normalizeMorphoV2Evidence([v2Issue], [{ ...v2Score, outcome: 'preview_gap' }])],
      Date.parse('2026-09-30T04:00:00.000Z'),
    )
    expect(
      previewGap.find((cell) => cell.qLabel === 'holder_small_sentinel' && cell.horizonHours === 1),
    ).toMatchObject({
      onTimeMeasured: 1,
      onTimeMeasuredNonSuccess: 1,
      onTimePreviewGap: 1,
      onTimeHolderAttrition: 0,
    })
  })

  it('keeps baseline-impaired Morpho recovery separate from eligible continuity', () => {
    const impairedIssue = {
      sequence: 1,
      sha256: 'd'.repeat(64),
      routeKey,
      destination,
      asset: '0x' + 'c'.repeat(40),
      issuedAtUtc,
      horizonsHours: [1],
      targets: [{ horizonHours: 1, targetAtUtc, captureDeadlineUtc }],
      baseline: { assetDecimals: 18 },
      cases: [{ label: 'impaired_q', assetsRaw: '100', baselineStatus: 'baseline_revert' }],
    }
    const recoveryScore = {
      issueSequence: 1,
      issueSha256: impairedIssue.sha256,
      routeKey,
      destination,
      caseLabel: 'impaired_q',
      assetsRaw: '100',
      horizonHours: 1,
      targetAtUtc,
      captureDeadlineUtc,
      scoredAtUtc: '2026-09-30T02:00:00.000Z',
      baselineStatus: 'baseline_revert',
      transition: 'simulated_recovery',
      outcome: 'simulated_withdraw_success',
    }
    const read = (scores: (typeof recoveryScore)[], now = Date.parse('2026-09-30T02:00:00.000Z')) =>
      aggregateHolderExitEvidence(
        routeKey,
        destination,
        [normalizeMorphoV2Evidence([impairedIssue], scores)],
        now,
      )[0]
    expect(read([recoveryScore])).toMatchObject({
      horizonHours: 1,
      baselineEligible: 0,
      baselineIneligible: 1,
      baselineImpaired: 1,
      onTimeMeasured: 0,
      impairedOnTimeMeasured: 1,
      impairedSimulatedRecovery: 1,
      impairedStillReverting: 0,
      firstIssuedAtUtc: issuedAtUtc,
      firstTargetAtUtc: targetAtUtc,
      firstCaptureDeadlineUtc: captureDeadlineUtc,
      firstImpairedRecoveryTargetAtUtc: targetAtUtc,
      lastImpairedRecoveryTargetAtUtc: targetAtUtc,
    })
    expect(
      read([{ ...recoveryScore, outcome: 'preview_gap', transition: 'still_reverting' }]),
    ).toMatchObject({ impairedOnTimeMeasured: 1, impairedStillReverting: 1 })
    expect(
      read([{ ...recoveryScore, outcome: 'holder_attrition', transition: 'holder_attrition' }]),
    ).toMatchObject({
      impairedOnTimeMeasured: 1,
      impairedHolderAttrition: 1,
      impairedStillReverting: 0,
    })
    expect(
      read([
        { ...recoveryScore, outcome: 'inconclusive_revert', transition: 'inconclusive_revert' },
      ]),
    ).toMatchObject({
      impairedOnTimeMeasured: 1,
      impairedInconclusiveRevert: 1,
      impairedStillReverting: 0,
    })
    expect(read([])).toMatchObject({ impairedOutcomePending: 1, outcomePending: 0 })
    expect(read([], Date.parse('2026-09-30T04:00:00.000Z'))).toMatchObject({
      impairedOutcomeMissing: 1,
      outcomeMissing: 0,
    })
    expect(() =>
      normalizeMorphoV2Evidence(
        [impairedIssue],
        [{ ...recoveryScore, transition: 'simulated_continuity' }],
      ),
    ).toThrow(/binding/)
  })
})
